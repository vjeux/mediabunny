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
} from '../../shared/mp3-misc';
import {
	ID3_V1_TAG_SIZE,
	ID3_V2_HEADER_SIZE,
	parseId3V1Tag,
	parseId3V2Tag,
	readId3V2Header,
} from '../id3';
import { readNextMp3FrameHeader } from './mp3-reader';
import { readAscii, readBytes, Reader, readU32Be, readU32Le } from '../reader';

const APE_TAG_FOOTER_SIZE = 32;

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
	audioEndPos: number | null = null;

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			this.audioEndPos = await this.computeAudioEndPos();

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

				this.lastLoadedPos = slice.filePos + id3V2Header.size;
			}
		}

		let result = await readNextMp3FrameHeader(
			this.reader,
			this.lastLoadedPos,
			this.audioEndPos,
			this.firstFrameHeader,
		);

		if (this.firstFrameHeader && (!result || result.startPos > this.lastLoadedPos + 1)) {
			// No frame follows the previous one directly. If ID3v2 tags do (like in concatenated files), skip them
			// instead of searching them for frames, since bytes inside them (like cover art) can look like frames.
			const tagsEnd = await this.skipId3V2Tags(this.lastLoadedPos);
			if (tagsEnd !== null) {
				this.lastLoadedPos = tagsEnd;
				result = await readNextMp3FrameHeader(
					this.reader,
					this.lastLoadedPos,
					this.audioEndPos,
					this.firstFrameHeader,
				);
			}
		}

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

	/** Skips the ID3v2 tags following the frame that ended at lastLoadedPos, returning where they end. */
	async skipId3V2Tags(lastLoadedPos: number) {
		let tagsEnd: number | null = null;
		// The previous frame ended right after lastLoadedPos, or at it if it was a byte short
		let positions = [lastLoadedPos + 1, lastLoadedPos];

		while (true) {
			let foundTag = false;

			for (const pos of positions) {
				let slice = this.reader.requestSlice(pos, ID3_V2_HEADER_SIZE);
				if (isThenable(slice)) slice = await slice;
				if (!slice) {
					continue;
				}

				const id3V2Header = readId3V2Header(slice);
				if (id3V2Header) {
					tagsEnd = slice.filePos + id3V2Header.size;
					positions = [tagsEnd];
					foundTag = true;
					break;
				}
			}

			if (!foundTag) {
				return tagsEnd;
			}
		}
	}

	/**
	 * Returns where the audio ends, before any APEv2 and ID3v1 tags at the end of the file, so that the bytes inside
	 * them (like cover art in an APEv2 tag) aren't mistaken for frames.
	 */
	async computeAudioEndPos() {
		if (this.reader.fileSize === null) {
			return null;
		}

		let endPos = this.reader.fileSize;

		if (endPos >= ID3_V1_TAG_SIZE) {
			let slice = this.reader.requestSlice(endPos - ID3_V1_TAG_SIZE, 3);
			if (isThenable(slice)) slice = await slice;

			if (slice && readAscii(slice, 3) === 'TAG') {
				endPos -= ID3_V1_TAG_SIZE;
			}
		}

		// APEv2 tags end with a 32-byte footer and sit in front of any ID3v1 tag
		if (endPos >= APE_TAG_FOOTER_SIZE) {
			let slice = this.reader.requestSlice(endPos - APE_TAG_FOOTER_SIZE, APE_TAG_FOOTER_SIZE);
			if (isThenable(slice)) slice = await slice;

			if (slice && readAscii(slice, 8) === 'APETAGEX') {
				slice.skip(4); // Version
				const tagSize = readU32Le(slice); // Includes the footer, but not the header
				slice.skip(4); // Item count
				const flags = readU32Le(slice);
				const hasHeader = (flags & (1 << 31)) !== 0;

				const tagStartPos = endPos - tagSize - (hasHeader ? APE_TAG_FOOTER_SIZE : 0);
				if (tagStartPos >= 0) {
					endPos = tagStartPos;
				}
			}
		}

		return endPos;
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
