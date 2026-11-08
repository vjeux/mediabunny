/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec } from '../codec';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputAudioTrackBacking } from '../input-track';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import { PacketRetrievalOptions } from '../media-sink';
import {
	assert,
	AsyncMutex,
	binarySearchExact,
	binarySearchLessOrEqual,
	isThenable,
	toDataView,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import {
	Mp3FrameHeader,
	getXingOffset,
	INFO,
	XING,
	XingFlags,
	computeAverageMp3FrameSize,
	getMp3ChannelCount,
	MP3_DECODER_DELAY,
	decodeSynchsafe,
} from '../../shared/mp3-misc';
import {
	ID3_V1_TAG_SIZE,
	ID3_V2_HEADER_SIZE,
	Id3V2Header,
	Id3V2HeaderFlags,
	Id3V2Reader,
	parseId3V1Tag,
	parseId3V2Tag,
	readId3V2Header,
} from '../id3';
import { readNextMp3FrameHeader, readFirstMp3FrameHeader } from './mp3-reader';
import { readAscii, readBytes, Reader, readU32Be, readU8 } from '../reader';

type Sample = {
	timestamp: number;
	duration: number;
	dataStart: number;
	dataSize: number;
};

export class Mp3Demuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	firstFrameHeader: Mp3FrameHeader | null = null;
	firstFrameHeaderPos: number | null = null;
	xingFrameHeader: Mp3FrameHeader | null = null;
	xingFrameHeaderPos: number | null = null;
	loadedSamples: Sample[] = []; // All samples from the start of the file to lastLoadedPos
	metadataTags: MetadataTags | null = null;
	xingData: {
		isVbr: boolean;
		frameCount: number | null;
		fileSize: number | null;
	} | null = null;

	trackBackings: Mp3AudioTrackBacking[] = [];

	readingMutex = new AsyncMutex();
	lastSampleLoaded = false;
	lastLoadedPos = 0;
	nextTimestampInSamples = 0;
	primingDelay = 0;
	itunesPriming: number | null = null;

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			// Keep loading until we find the first frame header
			while (!this.firstFrameHeader && !this.lastSampleLoaded) {
				await this.advanceReader();
			}

			if (!this.firstFrameHeader && this.xingFrameHeader) {
				// The file consists of nothing but a Xing frame, so it holds no audio data - but that frame still
				// tells us everything about the track
				this.firstFrameHeader = this.xingFrameHeader;
				this.firstFrameHeaderPos = this.xingFrameHeaderPos;
			}

			if (!this.firstFrameHeader) {
				throw new Error('No valid MP3 frame found.');
			}

			this.trackBackings = [new Mp3AudioTrackBacking(this)];
		})();
	}

	async advanceReader() {
		if (this.lastLoadedPos === 0) {
			// Let's skip all ID3v2 tags at the start of the file
			while (true) {
				let slice = this.reader.requestSlice(this.lastLoadedPos, ID3_V2_HEADER_SIZE);
				if (isThenable(slice)) slice = await slice;

				if (!slice) {
					this.lastSampleLoaded = true;
					return;
				}

				const id3V2Header = readId3V2Header(slice);
				if (!id3V2Header) {
					break;
				}

				await this.readItunesPriming(slice.filePos, id3V2Header);

				this.lastLoadedPos = slice.filePos + id3V2Header.size;
			}
		}

		// Until a frame has been found, make sure we don't start off with a false sync. A Xing/Info frame confirms the
		// stream already, so the frames after it are taken as they come.
		const result = this.firstFrameHeader || this.xingFrameHeader
			? await readNextMp3FrameHeader(
				this.reader,
				this.lastLoadedPos,
				this.reader.fileSize,
				this.firstFrameHeader,
			)
			: await readFirstMp3FrameHeader(this.reader, this.lastLoadedPos, this.reader.fileSize);
		if (!result) {
			this.lastSampleLoaded = true;
			return;
		}

		const header = result.header;

		this.lastLoadedPos = result.startPos + header.totalSize - 1; // -1 in case the frame is 1 byte too short

		const xingOffset = getXingOffset(header.mpegVersionId, header.channel);

		let slice = this.reader.requestSlice(result.startPos + xingOffset, 4);
		if (isThenable(slice)) slice = await slice;
		if (slice) {
			const word = readU32Be(slice);
			const isXing = word === XING || word === INFO;

			if (isXing) {
				// There's no actual audio data in this frame, so let's skip it

				if (!this.xingFrameHeader) {
					this.xingFrameHeader = header;
					this.xingFrameHeaderPos = result.startPos;
				}

				if (!this.xingData) {
					let xingDataSlice = this.reader.requestSlice(result.startPos + xingOffset + 4, 12);
					if (isThenable(xingDataSlice)) xingDataSlice = await xingDataSlice;
					if (xingDataSlice) {
						const xingData = readBytes(xingDataSlice, 12);
						const view = toDataView(xingData);
						const flags = view.getUint32(0, false);

						this.xingData = {
							// LAME and FFmpeg write the same header with 'Info' in place of 'Xing' for CBR streams
							isVbr: word === XING,
							frameCount: (flags & XingFlags.FrameCount)
								? view.getUint32(4, false)
								: null,
							fileSize: (flags & XingFlags.FileSize)
								? view.getUint32(8, false)
								: null,
						};

						const lameOffset = result.startPos + xingOffset + 8
							+ ((flags & XingFlags.FrameCount) ? 4 : 0)
							+ ((flags & XingFlags.FileSize) ? 4 : 0)
							+ ((flags & XingFlags.Toc) ? 100 : 0)
							+ ((flags & XingFlags.Quality) ? 4 : 0);
						if (!this.firstFrameHeader && lameOffset + 24 <= result.startPos + header.totalSize) {
							let lameSlice = this.reader.requestSlice(lameOffset, 24);
							if (isThenable(lameSlice)) lameSlice = await lameSlice;
							if (lameSlice) {
								const lame = readBytes(lameSlice, 24);
								const encoder = String.fromCharCode(...lame.subarray(0, 4));
								if (encoder === 'LAME' || encoder === 'Lavf' || encoder === 'Lavc') {
									this.primingDelay = (lame[21]! << 4 | lame[22]! >> 4) + MP3_DECODER_DELAY;
									this.nextTimestampInSamples = -this.primingDelay;
								}
							}
						}
					}
				}

				return;
			}
		}

		if (!this.firstFrameHeader) {
			this.firstFrameHeader = header;
			this.firstFrameHeaderPos = result.startPos;

			if (this.primingDelay === 0 && this.itunesPriming !== null) {
				// No LAME tag told us about the delay, but iTunes did. Its priming includes the decoder delay already.
				this.primingDelay = this.itunesPriming;
				this.nextTimestampInSamples = -this.primingDelay;
			}
		}

		const sampleDuration = header.audioSamplesInFrame / this.firstFrameHeader.sampleRate;
		const sample: Sample = {
			timestamp: this.nextTimestampInSamples / this.firstFrameHeader.sampleRate,
			duration: sampleDuration,
			dataStart: result.startPos,
			dataSize: header.totalSize,
		};

		this.loadedSamples.push(sample);
		this.nextTimestampInSamples += header.audioSamplesInFrame;

		return;
	}

	/**
	 * Apple's encoders don't write a LAME tag but store the encoder delay in an iTunSMPB comment of the ID3v2 tag,
	 * like " 00000000 00000210 0000086A 0000000000066486 ...": priming, end padding and sample count, in hex. To find
	 * it, this only reads the frame headers and small comment frames, so large frames like cover art aren't loaded.
	 */
	async readItunesPriming(contentStart: number, header: Id3V2Header) {
		if (
			![2, 3, 4].includes(header.majorVersion)
			|| (header.flags & (Id3V2HeaderFlags.Unsynchronisation | Id3V2HeaderFlags.ExtendedHeader))
		) {
			return; // iTunes writes neither
		}

		const frameHeaderSize = header.majorVersion === 2 ? 6 : 10;
		const contentEnd = contentStart + header.size - ((header.flags & Id3V2HeaderFlags.Footer) ? 10 : 0);
		let pos = contentStart;

		while (pos + frameHeaderSize <= contentEnd) {
			let slice = this.reader.requestSlice(pos, frameHeaderSize);
			if (isThenable(slice)) {
				slice = await slice;
			}
			if (!slice) {
				return;
			}

			const id = readAscii(slice, header.majorVersion === 2 ? 3 : 4);
			if (!/^[0-9A-Z]+$/.test(id)) {
				return; // Padding
			}

			let size: number;
			let flags = 0;
			if (header.majorVersion === 2) {
				size = (readU8(slice) << 16) | (readU8(slice) << 8) | readU8(slice);
			} else {
				const sizeRaw = readU32Be(slice);
				flags = readU8(slice) << 8 | readU8(slice);
				size = sizeRaw;

				// iTunes writes plain sizes into ID3v2.4 tags, so the synchsafe reading only counts if another frame
				// (or the end of the frames) follows it, or if the plain one doesn't fit either
				if (header.majorVersion === 4 && (sizeRaw & 0x80808080) === 0) {
					const synchsafeSize = decodeSynchsafe(sizeRaw);
					const bodyStart = pos + frameHeaderSize;
					if (
						await this.isId3V2FrameBoundary(bodyStart + synchsafeSize, contentEnd)
						|| !(await this.isId3V2FrameBoundary(bodyStart + sizeRaw, contentEnd))
					) {
						size = synchsafeSize;
					}
				}
			}

			const bodyPos = pos + frameHeaderSize;
			pos = bodyPos + size;

			// Frames with flags (compression, encryption, unsynchronisation...) aren't what iTunes writes
			if (!['COMM', 'COM', 'TXXX', 'TXX'].includes(id) || flags !== 0 || size < 1 || size > 4096) {
				continue;
			}

			let bodySlice = this.reader.requestSlice(bodyPos, Math.min(size, contentEnd - bodyPos));
			if (isThenable(bodySlice)) {
				bodySlice = await bodySlice;
			}
			if (!bodySlice) {
				return;
			}

			const body = readBytes(bodySlice, bodySlice.length);
			const reader = new Id3V2Reader(header, body);
			const encoding = reader.readU8();
			if (encoding > 3) {
				continue;
			}

			if (id === 'COMM' || id === 'COM') {
				reader.pos += 3; // Language
			}

			if (reader.pos > body.length || reader.readId3V2Text(encoding, body.length) !== 'iTunSMPB') {
				continue;
			}

			const match = /^\s*[0-9a-f]{1,16}\s+([0-9a-f]{1,16})\s+([0-9a-f]{1,16})\s+([0-9a-f]{1,16})(?![0-9a-f])/i
				.exec(reader.readId3V2Text(encoding, body.length));
			if (!match) {
				return;
			}

			const priming = Number.parseInt(match[1]!, 16);
			const sampleCount = Number.parseInt(match[3]!, 16);

			// Same sanity checks as FFmpeg
			if (priming <= 16384 && sampleCount > 0) {
				this.itunesPriming = priming;
			}

			return;
		}
	}

	/** Whether an ID3v2 frame (or padding) starts at pos, or the frames of a tag ending at contentEnd end there. */
	async isId3V2FrameBoundary(pos: number, contentEnd: number) {
		if (pos > contentEnd) {
			return false;
		}
		if (pos + 4 > contentEnd) {
			return true;
		}

		let slice = this.reader.requestSlice(pos, 4);
		if (isThenable(slice)) {
			slice = await slice;
		}
		if (!slice) {
			return false;
		}

		const id = readAscii(slice, 4);
		return id === '\x00\x00\x00\x00' || /^[0-9A-Z]{4}$/.test(id);
	}

	async getMimeType() {
		return 'audio/mpeg';
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.trackBackings;
	}

	async getMetadataTags() {
		const release = await this.readingMutex.acquire();

		try {
			await this.readMetadata();

			if (this.metadataTags) {
				return this.metadataTags;
			}

			this.metadataTags = {};
			let currentPos = 0;
			let id3V2HeaderFound = false;

			while (true) {
				let headerSlice = this.reader.requestSlice(currentPos, ID3_V2_HEADER_SIZE);
				if (isThenable(headerSlice)) headerSlice = await headerSlice;
				if (!headerSlice) break;

				const id3V2Header = readId3V2Header(headerSlice);
				if (!id3V2Header) {
					break;
				}

				id3V2HeaderFound = true;

				let contentSlice = this.reader.requestSlice(headerSlice.filePos, id3V2Header.size);
				if (isThenable(contentSlice)) contentSlice = await contentSlice;
				if (!contentSlice) break;

				parseId3V2Tag(contentSlice, id3V2Header, this.metadataTags);

				currentPos = headerSlice.filePos + id3V2Header.size;
			}

			if (!id3V2HeaderFound && this.reader.fileSize !== null && this.reader.fileSize >= ID3_V1_TAG_SIZE) {
				// Try reading an ID3v1 tag at the end of the file
				let slice = this.reader.requestSlice(this.reader.fileSize - ID3_V1_TAG_SIZE, ID3_V1_TAG_SIZE);
				if (isThenable(slice)) slice = await slice;
				assert(slice);

				const tag = readAscii(slice, 3);
				if (tag === 'TAG') {
					parseId3V1Tag(slice, this.metadataTags);
				}
			}

			return this.metadataTags;
		} finally {
			release();
		}
	}
}

class Mp3AudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: Mp3Demuxer) {}

	getType() {
		return 'audio' as const;
	}

	getId() {
		return 1;
	}

	getNumber() {
		return 1;
	}

	getTimeResolution() {
		assert(this.demuxer.firstFrameHeader);
		return this.demuxer.firstFrameHeader.sampleRate;
	}

	isRelativeToUnixEpoch() {
		return false;
	}

	getUnixTimeForTimestamp() {
		return null;
	}

	getPairingMask() {
		return 1n;
	}

	getBitrate() {
		return null;
	}

	getAverageBitrate() {
		return null;
	}

	async getDurationFromMetadata() {
		const demuxer = this.demuxer;

		assert(demuxer.firstFrameHeader !== null);
		assert(demuxer.firstFrameHeaderPos !== null);

		if (demuxer.xingData && demuxer.xingData.frameCount !== null) {
			return (
				demuxer.xingData.frameCount * demuxer.firstFrameHeader.audioSamplesInFrame - demuxer.primingDelay
			) / demuxer.firstFrameHeader.sampleRate;
		} else if (!demuxer.xingData?.isVbr) {
			// Not tagged as VBR, assuming CBR

			if (demuxer.reader.fileSize !== null) {
				const averageFrameSize = computeAverageMp3FrameSize(
					demuxer.firstFrameHeader.lowSamplingFrequency,
					demuxer.firstFrameHeader.layer,
					demuxer.firstFrameHeader.bitrate,
					demuxer.firstFrameHeader.sampleRate,
				);
				const frameCount = (demuxer.reader.fileSize - demuxer.firstFrameHeaderPos) / averageFrameSize;

				return (
					Math.round(frameCount) * demuxer.firstFrameHeader.audioSamplesInFrame - demuxer.primingDelay
				) / demuxer.firstFrameHeader.sampleRate;
			}
		}

		return null;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	getName() {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getCodec(): AudioCodec {
		return 'mp3';
	}

	getInternalCodecId() {
		return null;
	}

	getNumberOfChannels() {
		assert(this.demuxer.firstFrameHeader);
		return getMp3ChannelCount(this.demuxer.firstFrameHeader.channel);
	}

	getSampleRate() {
		assert(this.demuxer.firstFrameHeader);
		return this.demuxer.firstFrameHeader.sampleRate;
	}

	getDisposition() {
		return {
			...DEFAULT_TRACK_DISPOSITION,
		};
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig> {
		assert(this.demuxer.firstFrameHeader);

		return {
			codec: 'mp3',
			numberOfChannels: getMp3ChannelCount(this.demuxer.firstFrameHeader.channel),
			sampleRate: this.demuxer.firstFrameHeader.sampleRate,
		};
	}

	async getPacketAtIndex(sampleIndex: number, options: PacketRetrievalOptions) {
		if (sampleIndex === -1) {
			return null;
		}

		const rawSample = this.demuxer.loadedSamples[sampleIndex];
		if (!rawSample) {
			return null;
		}

		let data: Uint8Array;
		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			let slice = this.demuxer.reader.requestSlice(rawSample.dataStart, rawSample.dataSize);
			if (isThenable(slice)) slice = await slice;

			if (!slice) {
				return null; // Data didn't fit into the rest of the file
			}

			data = readBytes(slice, rawSample.dataSize);
		}

		return new EncodedPacket(
			data,
			'key',
			rawSample.timestamp,
			rawSample.duration,
			sampleIndex,
			rawSample.dataSize,
		);
	}

	getFirstPacket(options: PacketRetrievalOptions) {
		return this.getPacketAtIndex(0, options);
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const release = await this.demuxer.readingMutex.acquire();

		try {
			const sampleIndex = binarySearchExact(
				this.demuxer.loadedSamples,
				packet.timestamp,
				x => x.timestamp,
			);
			if (sampleIndex === -1) {
				throw new Error('Packet was not created from this track.');
			}

			const nextIndex = sampleIndex + 1;
			// Ensure the next sample exists
			while (
				nextIndex >= this.demuxer.loadedSamples.length
				&& !this.demuxer.lastSampleLoaded
			) {
				await this.demuxer.advanceReader();
			}

			return this.getPacketAtIndex(nextIndex, options);
		} finally {
			release();
		}
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		const release = await this.demuxer.readingMutex.acquire();

		try {
			while (true) {
				const index = binarySearchLessOrEqual(
					this.demuxer.loadedSamples,
					timestamp,
					x => x.timestamp,
				);

				if (index === -1 && this.demuxer.loadedSamples.length > 0) {
					// We're before the first sample
					return null;
				}

				if (this.demuxer.lastSampleLoaded) {
					// All data is loaded, return what we found
					return this.getPacketAtIndex(index, options);
				}

				if (index >= 0 && index + 1 < this.demuxer.loadedSamples.length) {
					// The next packet also exists, we're done
					return this.getPacketAtIndex(index, options);
				}

				// Otherwise, keep loading data
				await this.demuxer.advanceReader();
			}
		} finally {
			release();
		}
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		return this.getPacket(timestamp, options);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		return this.getNextPacket(packet, options);
	}
}
