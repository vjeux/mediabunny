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
	roundIfAlmostInteger,
	toDataView,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import {
	Mp3FrameHeader,
	MP3_FRAME_HEADER_SIZE,
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
import { readAscii, readBytes, Reader, readU32Be, readU32Le, readU8 } from '../reader';

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
	/** Whether metadataTags holds all tags, rather than the ones read before a parse error */
	metadataTagsComplete = false;
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
	audioEndPosPromise: Promise<number | null> | null = null;
	audioEndPos: number | null = null;

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
		let result = this.firstFrameHeader || this.xingFrameHeader
			? await readNextMp3FrameHeader(
				this.reader,
				this.lastLoadedPos,
				this.audioEndPos ?? this.reader.fileSize,
				this.firstFrameHeader,
			)
			: await readFirstMp3FrameHeader(this.reader, this.lastLoadedPos, this.reader.fileSize);

		if (this.firstFrameHeader && (!result || result.startPos > this.lastLoadedPos + 1)) {
			// No frame follows the previous one directly. If ID3v2 tags do (like in concatenated files), skip them
			// instead of searching them for frames, since bytes inside them (like cover art) can look like frames.
			const tagsEnd = await this.skipId3V2Tags(this.lastLoadedPos);
			if (tagsEnd !== null) {
				this.lastLoadedPos = tagsEnd;
				result = await readNextMp3FrameHeader(
					this.reader,
					this.lastLoadedPos,
					this.audioEndPos ?? this.reader.fileSize,
					this.firstFrameHeader,
				);
			}

			// Real audio goes on frame after frame, but a lone frame may be bytes inside the APEv2 and ID3v1 tags at
			// the end of the file. Only then are those looked up, since that reads the end of the file, which sources
			// that can only be read in order (like a UrlSource whose server ignores range requests) stream to first.
			if (result && !(await this.isFollowedByFrame(result))) {
				this.audioEndPos = await (this.audioEndPosPromise ??= this.computeAudioEndPos());
				if (this.audioEndPos !== null && result.startPos >= this.audioEndPos) {
					result = null;
				}
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
							// A frame count of 0 can't describe the stream (like in a header that was never filled
							// in), so it's ignored, like FFmpeg does
							frameCount: (flags & XingFlags.FrameCount) && view.getUint32(4, false) !== 0
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

	/** Whether another frame starts right where the given one ends (or a byte before, if it's a byte short). */
	async isFollowedByFrame(frame: { header: Mp3FrameHeader; startPos: number }) {
		const nextPos = frame.startPos + frame.header.totalSize;
		const nextFrame = await readNextMp3FrameHeader(
			this.reader,
			nextPos - 1,
			nextPos + MP3_FRAME_HEADER_SIZE,
			this.firstFrameHeader,
		);
		return nextFrame !== null;
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
				if (isThenable(slice)) {
					slice = await slice;
				}
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
			if (isThenable(slice)) {
				slice = await slice;
			}

			if (slice && readAscii(slice, 3) === 'TAG') {
				endPos -= ID3_V1_TAG_SIZE;
			}
		}

		// APEv2 tags end with a 32-byte footer and sit in front of any ID3v1 tag
		if (endPos >= APE_TAG_FOOTER_SIZE) {
			let slice = this.reader.requestSlice(endPos - APE_TAG_FOOTER_SIZE, APE_TAG_FOOTER_SIZE);
			if (isThenable(slice)) {
				slice = await slice;
			}

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

			// Tags that failed to parse are read again, so that every call fails, not just the first one
			if (this.metadataTags && this.metadataTagsComplete) {
				return this.metadataTags;
			}

			this.metadataTags = {};
			let currentPos = 0;

			while (true) {
				let headerSlice = this.reader.requestSlice(currentPos, ID3_V2_HEADER_SIZE);
				if (isThenable(headerSlice)) headerSlice = await headerSlice;
				if (!headerSlice) break;

				const id3V2Header = readId3V2Header(headerSlice);
				if (!id3V2Header) {
					break;
				}

				let contentSlice = this.reader.requestSlice(headerSlice.filePos, id3V2Header.size);
				if (isThenable(contentSlice)) contentSlice = await contentSlice;
				if (!contentSlice) break;

				parseId3V2Tag(contentSlice, id3V2Header, this.metadataTags);

				currentPos = headerSlice.filePos + id3V2Header.size;
			}

			// Fall back to an ID3v1 tag at the end of the file when the ID3v2 tags gave us no text fields, like ones
			// holding nothing but PRIV frames or cover art, like FFmpeg
			const hasTextFields = Object.keys(this.metadataTags).some(key => key !== 'raw' && key !== 'images');
			if (!hasTextFields && this.reader.fileSize !== null && this.reader.fileSize >= ID3_V1_TAG_SIZE) {
				let slice = this.reader.requestSlice(this.reader.fileSize - ID3_V1_TAG_SIZE, ID3_V1_TAG_SIZE);
				if (isThenable(slice)) slice = await slice;
				assert(slice);

				const tag = readAscii(slice, 3);
				if (tag === 'TAG') {
					parseId3V1Tag(slice, this.metadataTags);
				}
			}

			this.metadataTagsComplete = true;
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
		const duration = await this.getDurationFromHeaders();
		// Never below 0, even when the frames hold fewer samples than the encoder and decoder delays (like a single
		// MPEG-2 frame of 576 samples does)
		return duration === null ? null : Math.max(duration, 0);
	}

	private async getDurationFromHeaders() {
		const demuxer = this.demuxer;

		assert(demuxer.firstFrameHeader !== null);
		assert(demuxer.firstFrameHeaderPos !== null);

		let frameCount = demuxer.xingData?.frameCount ?? null;
		const streamSize = demuxer.xingData?.fileSize ?? null;

		if (frameCount !== null && streamSize && demuxer.reader.fileSize !== null) {
			// When the file goes well beyond the stream that the Xing/Info header describes (by more than 1/16, like
			// FFmpeg checks) and more MP3 audio follows that stream, the file holds more than it (like MP3s joined
			// with `cat`), and the header's frame count only covers its start. Like FFmpeg, which then goes by the
			// bitrate, don't use it. Tags or other data behind the stream don't count, and a file that ends well
			// before the stream's end was cut off and keeps the frame count.
			assert(demuxer.xingFrameHeaderPos !== null);
			const streamEndPos = demuxer.xingFrameHeaderPos + streamSize;
			if (
				demuxer.reader.fileSize - streamEndPos > streamSize / 16
				&& await mp3AudioFollows(demuxer.reader, streamEndPos)
			) {
				frameCount = null;
			}
		}

		if (frameCount !== null) {
			return (
				frameCount * demuxer.firstFrameHeader.audioSamplesInFrame - demuxer.primingDelay
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
			// Packet timestamps are whole numbers of samples, so snap timestamps that are a float error away from one
			// (like the sum of a packet's timestamp and duration) onto it, like the other demuxers do
			const sampleRate = this.getSampleRate();
			const searchTimestamp = roundIfAlmostInteger(timestamp * sampleRate) / sampleRate;

			while (true) {
				const index = binarySearchLessOrEqual(
					this.demuxer.loadedSamples,
					searchTimestamp,
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

/** How far behind the end of a stream the next one may start, like after some junk between joined files */
const MAX_GAP_BETWEEN_JOINED_STREAMS = 4096;

/**
 * Whether more MP3 audio starts at the given position (or a little behind it), possibly behind the ID3 tags of the next
 * file: a frame with another one right behind it.
 */
const mp3AudioFollows = async (reader: Reader, pos: number) => {
	assert(reader.fileSize !== null);

	// Skip the ID3v1 tag that ends a joined file, and the ID3v2 tags that start the next one
	while (pos + ID3_V2_HEADER_SIZE <= reader.fileSize) {
		let slice = reader.requestSlice(pos, ID3_V2_HEADER_SIZE);
		if (isThenable(slice)) {
			slice = await slice;
		}
		if (!slice) {
			return false;
		}

		if (readAscii(slice, 3) === 'TAG') {
			pos += ID3_V1_TAG_SIZE;
			continue;
		}

		slice.filePos = pos;
		const id3V2Header = readId3V2Header(slice);
		if (!id3V2Header) {
			break;
		}

		pos += ID3_V2_HEADER_SIZE + id3V2Header.size;
	}

	const frame = await readNextMp3FrameHeader(
		reader,
		pos,
		Math.min(pos + MAX_GAP_BETWEEN_JOINED_STREAMS, reader.fileSize),
	);
	if (!frame) {
		return false;
	}

	// A frame header found in tags or other data is very unlikely to be followed by a second one
	const nextFramePos = frame.startPos + frame.header.totalSize;
	const nextFrame = await readNextMp3FrameHeader(reader, nextFramePos, nextFramePos + 1);
	return nextFrame !== null;
};
