/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { OPUS_SAMPLE_RATE, validateAudioChunkMetadata } from '../codec';
import {
	createVorbisComments,
	OPUS_FRAME_DURATION_TABLE,
	parseModesFromVorbisSetupPacket,
	parseOpusIdentificationHeader,
} from '../codec-data';
import {
	assert,
	clamp,
	promiseWithResolvers,
	Queue,
	setInt64,
	toDataView,
	toUint8Array,
} from '../misc';
import { Muxer } from '../muxer';
import { Output,
	OutputAudioTrack,
	OutputTrack } from '../output';
import { OggOutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { Writer } from '../writer';
import {
	buildOggMimeType,
	computeOggPageCrc,
	extractSampleMetadata,
	OggCodecInfo,
	OGGS,
} from './ogg-misc';
import { MAX_PAGE_SIZE } from './ogg-reader';

const PAGE_SIZE_TARGET = 8192;
const OPUS_MIN_FRAME_DURATION = 120; // 2.5 ms in 48 kHz samples

/** Reads an Opus frame length (RFC 6716, section 3.2.1), returning it and the number of bytes it takes. */
const readOpusFrameLength = (data: Uint8Array, offset: number) => {
	const first = data[offset];
	if (first === undefined) {
		return null;
	}
	if (first < 252) {
		return { length: first, bytes: 1 };
	}

	const second = data[offset + 1];
	if (second === undefined) {
		return null;
	}
	return { length: first + 4 * second, bytes: 2 };
};

/** Returns the size of the self-delimited Opus packet (RFC 6716, appendix B) at the given offset, or null. */
const getSelfDelimitedOpusPacketSize = (data: Uint8Array, offset: number) => {
	const tocByte = data[offset];
	if (tocByte === undefined) {
		return null;
	}

	let pos = offset + 1;
	let frameCount = 1;
	let isVbr = false;
	let paddingSize = 0;

	const code = tocByte & 0b11;
	if (code === 1) {
		frameCount = 2;
	} else if (code === 2) {
		frameCount = 2;
		isVbr = true;
	} else if (code === 3) {
		const frameCountByte = data[pos++];
		if (frameCountByte === undefined) {
			return null;
		}

		frameCount = frameCountByte & 0b111111;
		isVbr = (frameCountByte & 0x80) !== 0;

		if (frameCountByte & 0x40) {
			// Padding: each byte of 255 adds 254 bytes and is followed by another padding length byte
			while (true) {
				const paddingByte = data[pos++];
				if (paddingByte === undefined) {
					return null;
				}

				paddingSize += paddingByte === 255 ? 254 : paddingByte;
				if (paddingByte !== 255) {
					break;
				}
			}
		}
	}

	// Self-delimiting framing codes every frame length of a VBR packet, and the one frame length of a CBR packet
	let framesSize = 0;
	for (let i = 0; i < (isVbr ? frameCount : 1); i++) {
		const frameLength = readOpusFrameLength(data, pos);
		if (!frameLength) {
			return null;
		}

		pos += frameLength.bytes;
		framesSize += isVbr ? frameLength.length : frameLength.length * frameCount;
	}

	return pos - offset + framesSize + paddingSize;
};

/**
 * Returns the TOC bytes of the streams in an Ogg Opus packet, which holds one Opus packet per stream, all but the last
 * one in self-delimiting framing (RFC 7845, section 3). Returns null if the packet can't be parsed.
 */
const getOpusStreamTocBytes = (packet: Uint8Array, streamCount: number) => {
	const tocBytes: number[] = [];
	let offset = 0;

	for (let i = 0; i < streamCount; i++) {
		const tocByte = packet[offset];
		if (tocByte === undefined) {
			return null;
		}
		tocBytes.push(tocByte);

		if (i < streamCount - 1) {
			const size = getSelfDelimitedOpusPacketSize(packet, offset);
			if (size === null) {
				return null;
			}
			offset += size;
		}
	}

	return tocBytes;
};

/**
 * Creates packets of empty (zero-byte) frames spanning the given duration, which must be a multiple of 2.5 ms, for a
 * stream whose last packet had the given TOC bytes (one per Opus stream). Following RFC 7845, section 4.1, they keep
 * each stream's configuration for as long as possible and switch to shorter CELT frames only at the end, if needed.
 */
const createOpusGapPackets = (durationInSamples: number, previousTocBytes: number[]) => {
	const packets: Uint8Array[] = [];
	const stereoFlags = previousTocBytes.map(tocByte => tocByte & 0b100);

	// Adds packets of `frameCount` empty frames per stream, using the given configuration for each stream (all of the
	// same frame duration)
	const addFrames = (configs: number[], frameCount: number) => {
		const frameDuration = OPUS_FRAME_DURATION_TABLE[configs[0]!]!;
		// A packet holds at most 48 frames and at most 120 ms
		const maxFramesPerPacket = Math.min(48, Math.floor(5760 / frameDuration));

		while (frameCount > 0) {
			const count = Math.min(frameCount, maxFramesPerPacket);
			const bytes: number[] = [];

			configs.forEach((config, i) => {
				const tocByte = (config << 3) | stereoFlags[i]!;
				const isSelfDelimited = i < configs.length - 1;

				if (count === 1) {
					bytes.push(tocByte); // Code 0: one frame, which is empty
				} else {
					bytes.push(tocByte | 0b11, count); // Code 3, constant bitrate: `count` empty frames
				}

				if (isSelfDelimited) {
					bytes.push(0); // The frame length, which is zero
				}
			});

			packets.push(new Uint8Array(bytes));
			frameCount -= count;
		}
	};

	let remaining = durationInSamples;
	const previousConfigs = previousTocBytes.map(tocByte => tocByte >> 3);
	const previousFrameDurations = previousConfigs.map(config => OPUS_FRAME_DURATION_TABLE[config]!);
	if (previousFrameDurations.every(duration => duration === previousFrameDurations[0])) {
		addFrames(previousConfigs, Math.floor(remaining / previousFrameDurations[0]!));
		remaining %= previousFrameDurations[0]!;
	}

	// The rest goes into CELT frames (configurations 16-31, 2.5 to 20 ms), keeping a CELT stream's bandwidth and using
	// wideband after SILK or Hybrid frames
	const celtBaseConfigs = previousConfigs.map(config => config >= 16 ? config & ~0b11 : 20);
	for (let i = 3; i >= 0; i--) {
		const frameDuration = OPUS_FRAME_DURATION_TABLE[16 + i]!;
		addFrames(celtBaseConfigs.map(config => config + i), Math.floor(remaining / frameDuration));
		remaining %= frameDuration;
	}

	assert(remaining === 0);
	return packets;
};

type OggTrackData = {
	track: OutputAudioTrack;
	serialNumber: number;
	internalSampleRate: number;
	codecInfo: OggCodecInfo;
	vorbisLastBlocksize: number | null;
	packetQueue: Queue<Packet>;
	startOffsetInSamples: number | null;
	currentTimestampInSamples: number;
	/** Maps packet timestamps (in samples) onto `currentTimestampInSamples`. */
	timestampOffsetInSamples: number;
	/** The number of Opus streams in each packet (more than one for multichannel audio). */
	opusStreamCount: number;
	/** The TOC bytes of the streams in the last Opus packet, or null if unknown. */
	lastOpusTocBytes: number[] | null;
	audioPacketCount: number;
	pagesWritten: number;

	currentGranulePosition: number;
	currentLacingValues: number[];
	currentPageData: Uint8Array[];
	currentPageSize: number;
	currentPageStartsWithFreshPacket: boolean;
	currentPageStartTimestampInSamples: number;
	closed: boolean;
};

type Packet = {
	data: Uint8Array;
	timestampInSamples: number;
	durationInSamples: number;
	trimmedDurationInSamples: number;
	forcePageFlush: boolean;
	/** Whether the packet must start a new page, as after a gap. */
	startsNewPage?: boolean;
};

export class OggMuxer extends Muxer {
	private format: OggOutputFormat;
	private writer!: Writer;

	private trackDatas: OggTrackData[] = [];
	private bosPagesWritten = false;
	private allTracksKnown = promiseWithResolvers();

	private pageBytes = new Uint8Array(MAX_PAGE_SIZE);
	private pageView = new DataView(this.pageBytes.buffer);

	constructor(output: Output, format: OggOutputFormat) {
		super(output);

		this.format = format;
	}

	async start() {
		const release = await this.mutex.acquire();

		this.writer = await this.output._getRootWriter(true); // Ogg is always monotonically written!

		for (const track of this.output.tracks) {
			assert(track.isAudioTrack());
			if (track.metadata.decoderConfig) {
				this.getTrackData(track, { decoderConfig: track.metadata.decoderConfig });
			}
		}

		release();
	}

	async getMimeType() {
		await this.allTracksKnown.promise;

		return buildOggMimeType({
			codecStrings: this.trackDatas.map(x => x.codecInfo.codec!),
		});
	}

	addEncodedVideoPacket(): never {
		throw new Error('Video tracks are not supported.');
	}

	private getTrackData(track: OutputAudioTrack, meta?: EncodedAudioChunkMetadata) {
		const existingTrackData = this.trackDatas.find(td => td.track === track);
		if (existingTrackData) {
			return existingTrackData;
		}

		// Give the track a unique random serial number
		let serialNumber: number;
		do {
			serialNumber = Math.floor(2 ** 32 * Math.random());
		} while (this.trackDatas.some(td => td.serialNumber === serialNumber));

		assert(track.source._codec === 'vorbis' || track.source._codec === 'opus');

		validateAudioChunkMetadata(meta, track.source._codec);

		assert(meta);
		assert(meta.decoderConfig);

		const newTrackData: OggTrackData = {
			track,
			serialNumber,
			internalSampleRate: track.source._codec === 'opus'
				? OPUS_SAMPLE_RATE
				: meta.decoderConfig.sampleRate,
			codecInfo: {
				codec: track.source._codec,
				vorbisInfo: null,
				opusInfo: null,
			},
			vorbisLastBlocksize: null,
			packetQueue: new Queue(),
			startOffsetInSamples: null,
			currentTimestampInSamples: 0,
			timestampOffsetInSamples: 0,
			opusStreamCount: 1,
			lastOpusTocBytes: null,
			audioPacketCount: 0,
			pagesWritten: 0,

			currentGranulePosition: 0,
			currentLacingValues: [],
			currentPageData: [],
			currentPageSize: 27,
			currentPageStartsWithFreshPacket: true,
			currentPageStartTimestampInSamples: 0,
			closed: false,
		};

		this.queueHeaderPackets(newTrackData, meta);

		this.trackDatas.push(newTrackData);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	private queueHeaderPackets(trackData: OggTrackData, meta: EncodedAudioChunkMetadata) {
		assert(meta.decoderConfig);

		if (trackData.track.source._codec === 'vorbis') {
			assert(meta.decoderConfig.description);

			const bytes = toUint8Array(meta.decoderConfig.description);
			if (bytes[0] !== 2) {
				throw new TypeError('First byte of Vorbis decoder description must be 2.');
			}

			let pos = 1;
			const readPacketLength = () => {
				let length = 0;

				while (true) {
					const value = bytes[pos++];
					if (value === undefined) {
						throw new TypeError('Vorbis decoder description is too short.');
					}

					length += value;

					if (value < 255) {
						return length;
					}
				}
			};

			const identificationHeaderLength = readPacketLength();
			const commentHeaderLength = readPacketLength();
			const setupHeaderLength = bytes.length - pos; // Setup header fills the remaining bytes

			if (setupHeaderLength <= 0) {
				throw new TypeError('Vorbis decoder description is too short.');
			}

			const identificationHeader = bytes.subarray(pos, pos += identificationHeaderLength);
			pos += commentHeaderLength; // Skip the comment header, we'll build our own
			const setupHeader = bytes.subarray(pos);

			const commentHeaderHeader = new Uint8Array(7);
			commentHeaderHeader[0] = 3; // Packet type
			commentHeaderHeader[1] = 0x76; // 'v'
			commentHeaderHeader[2] = 0x6f; // 'o'
			commentHeaderHeader[3] = 0x72; // 'r'
			commentHeaderHeader[4] = 0x62; // 'b'
			commentHeaderHeader[5] = 0x69; // 'i'
			commentHeaderHeader[6] = 0x73; // 's'

			const commentHeader = createVorbisComments(commentHeaderHeader, this.output._metadataTags, true);

			trackData.packetQueue.push({
				data: identificationHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				trimmedDurationInSamples: 0,
				forcePageFlush: true,
			}, {
				data: commentHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				trimmedDurationInSamples: 0,
				forcePageFlush: false,
			}, {
				data: setupHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				trimmedDurationInSamples: 0,
				forcePageFlush: true, // The last header packet must flush the page
			});

			const view = toDataView(identificationHeader);
			const blockSizeByte = view.getUint8(28);

			trackData.codecInfo.vorbisInfo = {
				blocksizes: [
					1 << (blockSizeByte & 0xf),
					1 << (blockSizeByte >> 4),
				],
				modeBlockflags: parseModesFromVorbisSetupPacket(setupHeader).modeBlockflags,
			};
		} else if (trackData.track.source._codec === 'opus') {
			if (!meta.decoderConfig.description) {
				throw new TypeError('For Ogg, Opus decoder description is required.');
			}

			const identificationHeader = toUint8Array(meta.decoderConfig.description);

			const commentHeaderHeader = new Uint8Array(8);
			const commentHeaderHeaderView = toDataView(commentHeaderHeader);
			commentHeaderHeaderView.setUint32(0, 0x4f707573, false); // 'Opus'
			commentHeaderHeaderView.setUint32(4, 0x54616773, false); // 'Tags'
			const commentHeader = createVorbisComments(commentHeaderHeader, this.output._metadataTags, true);

			trackData.packetQueue.push({
				data: identificationHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				trimmedDurationInSamples: 0,
				forcePageFlush: true,
			}, {
				data: commentHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				trimmedDurationInSamples: 0,
				forcePageFlush: true, // The last header packet must flush the page
			});

			const header = parseOpusIdentificationHeader(identificationHeader);
			trackData.codecInfo.opusInfo = {
				preSkip: header.preSkip,
			};
			// With a channel mapping family other than 0, the mapping table starts with the stream count
			trackData.opusStreamCount = header.channelMappingFamily !== 0 && header.channelMappingTable
				? header.channelMappingTable[0]!
				: 1;
		}
	}

	async addEncodedAudioPacket(track: OutputAudioTrack, packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getTrackData(track, meta);

			this.validateTimestamp(trackData.track, packet.timestamp, packet.type === 'key');

			const { durationInSamples, vorbisBlockSize } = extractSampleMetadata(
				packet.data,
				trackData.codecInfo,
				trackData.vorbisLastBlocksize,
			);

			if (trackData.startOffsetInSamples === null) {
				// The first packet determines where the stream begins. Its timestamp includes the Opus pre-skip, which
				// offsets the granule position. For Vorbis, it is the priming packet that decodes to nothing. Granule
				// positions can't be negative, so the earliest representable start is the one where the audible part
				// begins at zero.
				const timestampInSamples = Math.round(packet.timestamp * trackData.internalSampleRate);
				const preSkip = trackData.codecInfo.opusInfo?.preSkip ?? 0;
				const minTimestampInSamples = trackData.codecInfo.codec === 'vorbis'
					? -durationInSamples
					: -preSkip;
				const startTimestampInSamples = Math.max(timestampInSamples, minTimestampInSamples);

				trackData.startOffsetInSamples = startTimestampInSamples - minTimestampInSamples;
				trackData.currentTimestampInSamples = startTimestampInSamples + preSkip;
				trackData.timestampOffsetInSamples = trackData.currentTimestampInSamples - timestampInSamples;
			}

			let startsNewPage = false;

			if (trackData.codecInfo.codec === 'opus') {
				// Granule positions must advance by exactly the samples in the packets (RFC 7845, section 4.1), so a
				// gap in the packet timestamps would silently pull all later audio forward. Instead, fill a gap of at
				// least one frame (as left by lost or paused packets) with synthesized packets of empty frames, which
				// decoders play out as packet loss concealment. Only multiples of 2.5 ms, the shortest Opus frame, can
				// be filled.
				const timestampInSamples = Math.round(packet.timestamp * trackData.internalSampleRate)
					+ trackData.timestampOffsetInSamples;
				const gapInSamples = timestampInSamples - trackData.currentTimestampInSamples;

				if (
					trackData.lastOpusTocBytes !== null
					&& gapInSamples >= OPUS_FRAME_DURATION_TABLE[trackData.lastOpusTocBytes[0]! >> 3]!
				) {
					const fillInSamples = gapInSamples - gapInSamples % OPUS_MIN_FRAME_DURATION;
					for (const data of createOpusGapPackets(fillInSamples, trackData.lastOpusTocBytes)) {
						const { durationInSamples } = extractSampleMetadata(data, trackData.codecInfo, null);
						this.queueAudioPacket(trackData, data, durationInSamples, durationInSamples);
					}
				}

				// If the packet can't be parsed, the next gap (if any) isn't filled
				trackData.lastOpusTocBytes = getOpusStreamTocBytes(packet.data, trackData.opusStreamCount);
			} else if (trackData.codecInfo.codec === 'vorbis' && trackData.audioPacketCount > 0) {
				// Vorbis can express a gap through its granule positions, which may jump ahead from one page to the
				// next. So, a packet after a gap starts a new page and keeps its timestamp. Readers may take smaller
				// deviations for imprecise granule positions (some muxers write them a packet off), so only gaps longer
				// than the longest packet duration doubled (a long block) are kept.
				assert(trackData.codecInfo.vorbisInfo);
				const timestampInSamples = Math.round(packet.timestamp * trackData.internalSampleRate)
					+ trackData.timestampOffsetInSamples;
				const gapInSamples = timestampInSamples - trackData.currentTimestampInSamples;

				if (gapInSamples > trackData.codecInfo.vorbisInfo.blocksizes[1]!) {
					trackData.currentTimestampInSamples += gapInSamples;
					startsNewPage = true;
				}
			}

			trackData.vorbisLastBlocksize = vorbisBlockSize;

			// A shorter packet duration signals trailing samples to discard, which only the final packet can express
			const trimmedDurationInSamples = packet.duration > 0
				? clamp(Math.round(packet.duration * trackData.internalSampleRate), 0, durationInSamples)
				: durationInSamples;

			this.queueAudioPacket(trackData, packet.data, durationInSamples, trimmedDurationInSamples, startsNewPage);

			await this.interleavePages();
		} finally {
			release();
		}
	}

	private queueAudioPacket(
		trackData: OggTrackData,
		data: Uint8Array,
		durationInSamples: number,
		trimmedDurationInSamples: number,
		startsNewPage = false,
	) {
		assert(trackData.startOffsetInSamples !== null);

		// With a start offset, the second audio packet flushes the page. This keeps the offset from sharing a page
		// with end trimming, as both are signaled through the granule position and would be indistinguishable.
		// This mirrors a requirement of the Vorbis spec.
		const forcePageFlush = trackData.startOffsetInSamples > 0 && trackData.audioPacketCount === 1;
		trackData.audioPacketCount++;

		trackData.packetQueue.push({
			data,
			timestampInSamples: trackData.currentTimestampInSamples,
			durationInSamples,
			trimmedDurationInSamples,
			forcePageFlush,
			startsNewPage,
		});
		trackData.currentTimestampInSamples += durationInSamples;
	}

	addSubtitleCue(): never {
		throw new Error('Subtitle tracks are not supported.');
	}

	allTracksAreKnown() {
		for (const track of this.output.tracks) {
			if (!track.source._closed && !this.trackDatas.some(x => x.track === track)) {
				return false; // We haven't seen a sample from this open track yet
			}
		}

		return true;
	}

	async interleavePages(isFinalCall = false) {
		if (!this.bosPagesWritten) {
			if (!this.allTracksAreKnown() && !isFinalCall) {
				return; // We can't interleave yet as we don't yet know how many tracks we'll truly have
			}

			// Write the header page for all bitstreams
			for (const trackData of this.trackDatas) {
				while (trackData.packetQueue.length > 0) {
					const packet = trackData.packetQueue.shift()!;
					this.writePacket(trackData, packet, false);

					if (packet.forcePageFlush) {
						// We say the header page ends once the first packet is encountered that forces a page flush
						break;
					}
				}
			}

			this.bosPagesWritten = true;
		}

		outer:
		while (true) {
			let trackWithMinTimestamp: OggTrackData | null = null;
			let minTimestamp = Infinity;

			for (const trackData of this.trackDatas) {
				if (
					!isFinalCall
					&& trackData.packetQueue.length <= 1 // Limit is 1, not 0, for correct EOS flag logic
					&& !trackData.closed
				) {
					break outer;
				}

				if (
					trackData.packetQueue.length > 0
					&& trackData.packetQueue.peek()!.timestampInSamples < minTimestamp
				) {
					trackWithMinTimestamp = trackData;
					minTimestamp = trackData.packetQueue.peek()!.timestampInSamples;
				}
			}

			if (!trackWithMinTimestamp) {
				break;
			}

			const packet = trackWithMinTimestamp.packetQueue.shift()!;
			const isFinalPacket = trackWithMinTimestamp.packetQueue.length === 0;

			this.writePacket(trackWithMinTimestamp, packet, isFinalPacket);
		}

		if (!isFinalCall) {
			await this.writer.flush();
		}
	}

	writePacket(trackData: OggTrackData, packet: Packet, isFinalPacket: boolean) {
		// The final page's granule position may end the stream before the final packet's decoded output does
		const packetEndTimestampInSamples = packet.timestampInSamples + (
			isFinalPacket
				? packet.trimmedDurationInSamples
				: packet.durationInSamples
		);

		if (packet.startsNewPage && trackData.currentLacingValues.length > 0) {
			this.writePage(trackData, false);
		}

		if (trackData.currentLacingValues.length === 0) {
			trackData.currentPageStartTimestampInSamples = packet.timestampInSamples;
		}

		if (this.format._options.maximumPageDuration !== undefined) {
			const maxDurationInSamples = this.format._options.maximumPageDuration * trackData.internalSampleRate;

			if (
				trackData.currentLacingValues.length > 0
				&& packetEndTimestampInSamples - trackData.currentPageStartTimestampInSamples > maxDurationInSamples
			) {
				// Flush the current page early to avoid exceeding the maximum page duration
				this.writePage(trackData, false);
			}
		}

		let remainingLength = packet.data.length;
		let dataStartOffset = 0;
		let dataOffset = 0;

		while (true) {
			if (trackData.currentLacingValues.length === 0 && dataStartOffset > 0) {
				// This is a packet spanning multiple pages
				trackData.currentPageStartsWithFreshPacket = false;
			}

			const segmentSize = Math.min(255, remainingLength);
			trackData.currentLacingValues.push(segmentSize);
			trackData.currentPageSize++;
			dataOffset += segmentSize;

			const segmentIsLastOfPacket = remainingLength < 255;

			if (trackData.currentLacingValues.length === 255) {
				// The page is full, we need to add part of the packet data and then flush the page
				const slice = packet.data.subarray(dataStartOffset, dataOffset);
				dataStartOffset = dataOffset;
				trackData.currentPageData.push(slice);
				trackData.currentPageSize += slice.length;

				if (segmentIsLastOfPacket) {
					// The packet ends on this page, so the page's granule position must include it
					trackData.currentGranulePosition = packetEndTimestampInSamples;
				}

				this.writePage(trackData, isFinalPacket && segmentIsLastOfPacket);

				if (segmentIsLastOfPacket) {
					return;
				}
			}

			if (segmentIsLastOfPacket) {
				break;
			}
			remainingLength -= 255;
		}

		const slice = packet.data.subarray(dataStartOffset);
		trackData.currentPageData.push(slice);
		trackData.currentPageSize += slice.length;
		trackData.currentGranulePosition = packetEndTimestampInSamples;

		if (trackData.currentPageSize >= PAGE_SIZE_TARGET || packet.forcePageFlush) {
			this.writePage(trackData, isFinalPacket);
		}
	}

	writePage(trackData: OggTrackData, isEos: boolean) {
		this.pageView.setUint32(0, OGGS, true); // Capture pattern
		this.pageView.setUint8(4, 0); // Version

		let headerType = 0;
		if (!trackData.currentPageStartsWithFreshPacket) {
			headerType |= 1;
		}
		if (trackData.pagesWritten === 0) {
			headerType |= 2; // Beginning of stream
		}
		if (isEos) {
			headerType |= 4; // End of stream
		}
		this.pageView.setUint8(5, headerType); // Header type

		const granulePosition = trackData.currentLacingValues.every(x => x === 255)
			? -1 // No packets end on this page
			: trackData.currentGranulePosition;
		setInt64(this.pageView, 6, granulePosition, true); // Granule position

		this.pageView.setUint32(14, trackData.serialNumber, true); // Serial number
		this.pageView.setUint32(18, trackData.pagesWritten, true); // Page sequence number
		this.pageView.setUint32(22, 0, true); // Checksum placeholder

		this.pageView.setUint8(26, trackData.currentLacingValues.length); // Number of page segments
		this.pageBytes.set(trackData.currentLacingValues, 27);

		let pos = 27 + trackData.currentLacingValues.length;
		for (const data of trackData.currentPageData) {
			this.pageBytes.set(data, pos);
			pos += data.length;
		}

		const slice = this.pageBytes.subarray(0, pos);

		const crc = computeOggPageCrc(slice);
		this.pageView.setUint32(22, crc, true); // Checksum

		trackData.pagesWritten++;
		trackData.currentLacingValues.length = 0;
		trackData.currentPageData.length = 0;
		trackData.currentPageSize = 27;
		trackData.currentPageStartsWithFreshPacket = true;
		trackData.currentPageStartTimestampInSamples = trackData.currentGranulePosition;

		if (this.format._options.onPage) {
			this.writer.startTrackingWrites();
		}

		this.writer.write(slice);

		if (this.format._options.onPage) {
			const { data, start } = this.writer.stopTrackingWrites();
			this.format._options.onPage(data, start, trackData.track.source);
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	override async onTrackClose(track: OutputTrack) {
		const release = await this.mutex.acquire();

		const trackData = this.trackDatas.find(x => x.track === track);
		if (trackData) {
			trackData.closed = true;
		}

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		// Since a track is now closed, we may be able to write out chunks that were previously waiting
		await this.interleavePages();

		release();
	}

	async finalize() {
		const release = await this.mutex.acquire();

		this.allTracksKnown.resolve();

		for (const trackData of this.trackDatas) {
			trackData.closed = true;
		}

		await this.interleavePages(true);

		for (const trackData of this.trackDatas) {
			if (trackData.currentLacingValues.length > 0) {
				this.writePage(trackData, true);
			}
		}

		release();
	}
}
