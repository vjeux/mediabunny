/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TrackType } from '../output';
import { SAMPLES_PER_AAC_FRAME } from '../adts/adts-demuxer';
import { MAX_ADTS_FRAME_HEADER_SIZE, MIN_ADTS_FRAME_HEADER_SIZE, readAdtsFrameHeader } from '../adts/adts-reader';
import {
	aacChannelMap,
	aacFrequencyTable,
	getAacProgramConfigElementChannelCount,
	readAdtsProgramConfigElement,
} from '../../shared/aac-misc';
import {
	AacCodecInfo,
	AudioCodec,
	DtsFourCc,
	extractAudioCodecString,
	extractVideoCodecString,
	MediaCodec,
	VideoCodec,
} from '../codec';
import {
	AC3_ACMOD_CHANNEL_COUNTS,
	AC3_SAMPLES_PER_FRAME,
	AvcDecoderConfigurationRecord,
	AvcNalUnitType,
	AvcSpsInfo,
	determineVideoPacketType,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	EAC3_NUMBLKS_TABLE,
	getEac3ChannelCount,
	getEac3SampleRate,
	parseEac3SyncFrame,
	HevcDecoderConfigurationRecord,
	HevcNalUnitType,
	parseAc3SyncFrame,
	parseAvcSps,
	parseEac3OrAc3CoreSyncFrame,
	parseHevcSps,
	AC3_FRAME_SIZES,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	iterateNalUnitsInAnnexB,
	parseDtsFrame,
	removeEmulationPreventionBytes,
	parseDtsCoreFrameHeader,
	parseDtsExssHeader,
	DTS_CORE_FRAME_HEADER_SIZE,
	DTS_EXSS_HEADER_PREFIX_SIZE,
	DTS_EXSS_MAX_HEADER_SIZE,
	VuiTimingInfo,
} from '../codec-data';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { Logging } from '../logging';
import {
	InputAudioTrackBacking,
	InputTrackBacking,
	InputVideoTrackBacking,
} from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags, TrackDisposition } from '../metadata';
import {
	assert,
	binarySearchLessOrEqual,
	COLOR_PRIMARIES_MAP_INVERSE,
	findLastIndex,
	floorToMultiple,
	getDisplayAspect,
	isThenable,
	isIso639Dash2LanguageCode,
	IDENTITY_MATRIX,
	MaybePromise,
	last,
	MATRIX_COEFFICIENTS_MAP_INVERSE,
	Rational,
	readExpGolomb,
	roundIfAlmostInteger,
	simplifyRational,
	toDataView,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
	TransformationMatrix,
	uint8ArraysAreEqual,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import {
	MP3_FRAME_HEADER_SIZE,
	getMp3ChannelCount,
	readMp3FrameHeader,
} from '../../shared/mp3-misc';
import { EncodedPacket, PacketType, PLACEHOLDER_DATA } from '../packet';
import { FileSlice, readBytes, Reader, readU16Be, readU32Be, readU8 } from '../reader';
import {
	buildMpegTsMimeType,
	computeMpegTsCrc32,
	createTimestampWrapInfo,
	findTsPacketLayout,
	MpegTsStreamType,
	normalizeWrappedTimestamp,
	MPEG_TS_TIMESCALE,
	TimestampWrapInfo,
	TS_PACKET_LAYOUT_PROBE_SIZE,
	TS_PACKET_SIZE,
} from './mpeg-ts-misc';
import { AC3_SAMPLE_RATES } from '../../shared/ac3-misc';
import { Bitstream } from '../../shared/bitstream';

// Resources:
// ISO/IEC 13818-1

/**
 * Declared streams can start a good while after the others (45 seconds in a Blu-ray excerpt whose DTS track starts
 * after its AC-3 track), and some are declared but never sent (recorders may drop some). Looking for them packet by
 * packet is slow, so once we're this far into the media (in PTS) without having seen a declared stream, we scan ahead
 * for its packets in large chunks instead.
 */
const MISSING_STREAM_SCAN_DELAY = 10 * MPEG_TS_TIMESCALE;
const MISSING_STREAM_SCAN_CHUNK_SIZE = 2 ** 20;
/** How far ahead (in bytes) we scan for missing streams before giving up on them. */
const DEFAULT_MAX_MISSING_STREAM_SCAN_SIZE = 2 ** 28; // 256 MiB
/** For sources of unknown size, how far into the media we look for missing streams before giving up on them. */
const MAX_STREAM_START_DELAY = 120 * MPEG_TS_TIMESCALE;

const REGISTRATION_DESCRIPTOR_TAG = 0x05;
const ISO_639_LANGUAGE_DESCRIPTOR_TAG = 0x0a;

// The 'HDMV' and 'HDPR' format identifiers, which mark a program as Blu-ray-derived
const HDMV_FORMAT_IDENTIFIER = 0x48444d56;
const HDPR_FORMAT_IDENTIFIER = 0x48445052;

// 'DTS1', 'DTS2' and 'DTS3' all share this prefix
const DTS_FORMAT_IDENTIFIER_PREFIX = 0x44545300;

// The 'AC-3' and 'EAC3' format identifiers
const AC3_FORMAT_IDENTIFIER = 0x41432d33;
const EAC3_FORMAT_IDENTIFIER = 0x45414333;

// Stream types that only mean E-AC-3 or DTS within a Blu-ray-derived program, and what they map to
const BLU_RAY_STREAM_TYPES = new Map<number, MpegTsStreamType>([
	[MpegTsStreamType.BLU_RAY_EAC3, MpegTsStreamType.EAC3_SYSTEM_A],
	[MpegTsStreamType.BLU_RAY_EAC3_SECONDARY, MpegTsStreamType.EAC3_SYSTEM_A],
	[MpegTsStreamType.BLU_RAY_DTS_HD, MpegTsStreamType.DTS],
	[MpegTsStreamType.BLU_RAY_DTS_HD_MASTER, MpegTsStreamType.DTS],
	[MpegTsStreamType.BLU_RAY_DTS_EXPRESS_SECONDARY, MpegTsStreamType.DTS],
]);

/**
 * How much further than the streams that say what they hold we look for the first PES packet of a private data stream
 * that doesn't: its audio would have shown up by then, and it may well hold none at all.
 */
const MAX_PRIVATE_DATA_PROBE_DISTANCE = 2 ** 22; // 4 MiB

// Descriptors that make a private data stream something other than audio: VBI data, VBI teletext, teletext, DVB
// subtitling, data broadcast ID, application signalling and ARIB data component
const NON_AUDIO_PRIVATE_DATA_DESCRIPTOR_TAGS = new Set<number>([0x45, 0x46, 0x56, 0x59, 0x66, 0x6f, 0xfd]);

/**
 * The codec, size and sample rate (or its code) of the audio frame whose header starts the bytes, for telling the codec
 * of a stream that doesn't say what it is. Only headers that the code reading the stream's first frame accepts count.
 */
const probeAudioFrame = (bytes: Uint8Array): { codec: AudioCodec; frameSize: number; rate: number } | null => {
	if (bytes.byteLength < MAX_ADTS_FRAME_HEADER_SIZE) {
		return null;
	}

	if (bytes[0] === 0x0b && bytes[1] === 0x77) {
		// AC-3 and E-AC-3 tell themselves apart by their bsid
		const bsid = bytes[5]! >> 3;
		if (bsid <= 8) {
			const fscod = bytes[4]! >> 6;
			const frmsizecod = bytes[4]! & 0x3f;
			if (fscod === 3 || frmsizecod > 37 || !parseAc3SyncFrame(bytes)) {
				return null;
			}

			return { codec: 'ac3', frameSize: AC3_FRAME_SIZES[3 * frmsizecod + fscod]!, rate: fscod };
		} else if (bsid >= 11 && bsid <= 16) {
			const frameInfo = parseEac3SyncFrame(bytes);
			const sampleRate = frameInfo && getEac3SampleRate(frameInfo);
			if (!sampleRate) {
				return null;
			}

			const frmsiz = ((bytes[2]! & 0x07) << 8) | bytes[3]!;
			return { codec: 'eac3', frameSize: (frmsiz + 1) * 2, rate: sampleRate };
		}

		return null;
	}

	if (bytes[0] === 0x7f && bytes[1] === 0xfe && bytes[2] === 0x80 && bytes[3] === 0x01) {
		const frameInfo = parseDtsFrame(bytes);
		return frameInfo && { codec: 'dts', frameSize: frameInfo.frameSize, rate: frameInfo.sampleRate };
	}

	if (bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) {
		// ADTS: a sample rate, a channel configuration, a frame length that holds the header, and one raw data block
		const samplingFrequencyIndex = (bytes[2]! >> 2) & 0x0f;
		const channelConfiguration = ((bytes[2]! & 0x01) << 2) | (bytes[3]! >> 6);
		const frameLength = ((bytes[3]! & 0x03) << 11) | (bytes[4]! << 3) | (bytes[5]! >> 5);
		const headerSize = bytes[1]! & 0x01 ? MAX_ADTS_FRAME_HEADER_SIZE - 2 : MAX_ADTS_FRAME_HEADER_SIZE;
		const rawDataBlockCount = (bytes[6]! & 0x03) + 1;
		if (
			samplingFrequencyIndex >= aacFrequencyTable.length
			|| channelConfiguration === 0
			|| frameLength < headerSize
			|| rawDataBlockCount !== 1
		) {
			return null;
		}

		return { codec: 'aac', frameSize: frameLength, rate: samplingFrequencyIndex };
	}

	if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
		const header = readMp3FrameHeader(readU32Be(FileSlice.tempFromBytes(bytes)), bytes.byteLength).header;
		return header && { codec: 'mp3', frameSize: header.totalSize, rate: header.sampleRate };
	}

	return null;
};

/**
 * Works out the codec of an audio stream that doesn't say what it is (a private data stream without descriptors, as
 * FFmpeg's m2ts mode writes AAC) from its first PES packet. Like FFmpeg's probes, one header isn't enough: the next
 * frame's header must follow with the same codec and sample rate, unless the frame fills the PES packet exactly.
 */
const getAudioCodecFromPayload = (data: Uint8Array): AudioCodec | null => {
	const frame = probeAudioFrame(data);
	if (!frame || frame.frameSize <= 0 || frame.frameSize > data.byteLength) {
		return null;
	}

	if (frame.frameSize === data.byteLength) {
		return frame.codec;
	}

	const nextFrame = probeAudioFrame(data.subarray(frame.frameSize));
	return nextFrame && nextFrame.codec === frame.codec && nextFrame.rate === frame.rate ? frame.codec : null;
};

type ElementaryStream = {
	demuxer: MpegTsDemuxer;
	pid: number;
	streamType: number;
	initialized: boolean;
	firstSection: Section | null;
	/**
	 * Some muxers suck ass and don't correctly label key frames, meaning we'll need to use our skill to
	 * compensate for another programmer's skill issue.
	 */
	canBeTrustedWithKeyPackets: boolean;
	languageCode: string;
	/** audio_type from the ISO 639 language descriptor. */
	audioType: number;
	/** For private data streams that don't say what they hold: the first PES packet tells the audio codec. */
	codecFromPayload: boolean;
	info: {
		type: 'video';
		codec: VideoCodec;
		decoderConfig: VideoDecoderConfig | null;
		avcCodecInfo: AvcDecoderConfigurationRecord | null;
		hevcCodecInfo: HevcDecoderConfigurationRecord | null;
		colorSpace: VideoColorSpaceInit;
		width: number;
		height: number;
		squarePixelWidth: number;
		squarePixelHeight: number;
		/** Exact, unlike the square pixel size */
		pixelAspectRatio: Rational;
		reorderSize: number;
		/** How to find the field of a slice, for AVC streams that may contain field pictures. */
		avcFieldCoding: AvcFieldCoding | null;
		/**
		 * How many frames can come before a frame in decode order but after it in presentation order
		 * (num_reorder_frames, sps_max_num_reorder_pics)
		 */
		reorderFrameCount: number;
	} | {
		type: 'audio';
		codec: AudioCodec;
		decoderConfig: AudioDecoderConfig | null;
		aacCodecInfo: AacCodecInfo | null;
		dtsFormat: DtsFourCc | null;
		numberOfChannels: number;
		sampleRate: number;
	};
	/**
	 * Reference PES packets, spread throughout the file, to be used to speed up repeated random access. Sorted by both
	 * byte offset and PTS.
	 */
	referencePesPackets: TimestampedPesPacketHeader[];
	/**
	 * Stretches of video packets that are dropped (by sequence number, end exclusive): from a frame that lost data up
	 * to the next key frame, as far as they've been read
	 */
	droppedRanges: { start: number; end: number }[];
	/** Whether a frame that lost data takes the frames up to the next key frame with it (see supplyPacket) */
	dropsRestOfGop: boolean | null;
};

/** A stretch of the file without TS packets of some PID, from `start` to `end` (exclusive, Infinity: to the end) */
type Gap = {
	start: number;
	end: number;
};

// Stretches without packets of a PID are remembered from this length on. Shorter ones are quick to walk, and not
// remembering them keeps the number of gaps small.
const MIN_REMEMBERED_GAP_SIZE = 2 ** 20; // 1 MiB

/** Returns where the gap containing `pos` ends, or `pos` if it's in none. */
const getGapEnd = (gaps: Gap[], pos: number) => {
	const index = binarySearchLessOrEqual(gaps, pos, x => x.start);
	return index !== -1 && pos < gaps[index]!.end ? gaps[index]!.end : pos;
};

type ElementaryVideoStream = ElementaryStream & { info: { type: 'video' } };
type ElementaryAudioStream = ElementaryStream & { info: { type: 'audio' } };

type TsPacketHeader = {
	payloadUnitStartIndicator: number;
	pid: number;
	adaptationFieldControl: number;
};

type TsPacket = TsPacketHeader & {
	transportErrorIndicator: number;
	continuityCounter: number;
	body: Uint8Array<ArrayBufferLike>;
};

type Section = {
	startPos: number;
	endPos: number | null; // null if the section was not read fully
	pid: number;
	payload: Uint8Array<ArrayBufferLike>;
	randomAccessIndicator: number;
	/**
	 * Where in the payload data is missing: TS packets that went missing (the continuity counters say so) or arrived
	 * with errors (transport_error_indicator), which are left out. Ascending.
	 */
	holes: readonly number[];
	/** Whether the first TS packet arrived with errors, which makes the payload garbage from the start. */
	firstPacketHasErrors: boolean;
	/** Whether the end of the file cut the section off */
	cutAtEnd: boolean;
};

// Stream types for metadata rather than media (H.222.0 Table 2-34), like the ID3 timed metadata (0x15) that many HLS
// streams carry. They're skipped like unsupported codecs, but without a note, since they aren't tracks to begin with.
const METADATA_STREAM_TYPES = new Set<number>([0x15, 0x16, 0x17, 0x18, 0x19]);

// The most B-frames x264 and x265 put between two P/I frames. The frame before such a run in decode order comes after
// it in presentation order, however long the run is: the reorder depth doesn't bound that distance.
const MAX_CONSECUTIVE_B_FRAMES = 16;

/**
 * Whether no PES packet before the given ones (by their timestamps, latest in decode order first) can be the one
 * presented last at or before searchPts. A frame can come before at most reorderFrameCount frames in decode order
 * that it's presented after, so once a packet presented at or before the best candidate has that many before it
 * here, no earlier packet is presented after it, let alone between the candidate and searchPts.
 */
const lookupWindowIsComplete = (ptsInReverseDecodeOrder: number[], searchPts: number, reorderFrameCount: number) => {
	let best = -Infinity;
	for (const pts of ptsInReverseDecodeOrder) {
		if (pts <= searchPts && pts > best) {
			best = pts;
		}
	}

	if (best === -Infinity) {
		return false;
	}
	if (best === searchPts) {
		return true; // Nothing can come closer
	}

	for (let i = 0; i < ptsInReverseDecodeOrder.length; i++) {
		const pts = ptsInReverseDecodeOrder[i]!;
		if (pts > best) {
			continue;
		}

		let presentedLaterCount = 0;
		for (let j = i + 1; j < ptsInReverseDecodeOrder.length; j++) {
			if (ptsInReverseDecodeOrder[j]! > pts) {
				presentedLaterCount++;
			}
		}

		if (presentedLaterCount >= reorderFrameCount) {
			return true;
		}
	}

	return false;
};

/**
 * The fields of an ADTS frame header needed to find frames, without rejecting what readAdtsFrameHeader doesn't
 * support (which would make every header-like byte sequence inside a frame an error).
 */
const peekAdtsFrameHeader = (bytes: Uint8Array) => {
	if (bytes[0] !== 0xff || (bytes[1]! & 0xf6) !== 0xf0) {
		return null; // No syncword, or not layer 0
	}

	const samplingFrequencyIndex = (bytes[2]! >> 2) & 0x0f;
	const frameLength = ((bytes[3]! & 0x03) << 11) | (bytes[4]! << 3) | (bytes[5]! >> 5);
	const headerSize = (bytes[1]! & 0x01) ? MIN_ADTS_FRAME_HEADER_SIZE : MIN_ADTS_FRAME_HEADER_SIZE + 2; // CRC
	if (samplingFrequencyIndex >= aacFrequencyTable.length || frameLength < headerSize) {
		return null; // The frame must at least contain its own header
	}

	return { samplingFrequencyIndex, frameLength };
};

/** For the frame sync check: the size and sample rate (index) of the ADTS frame whose header starts the bytes. */
const readAdtsSyncHeader = (bytes: Uint8Array) => {
	const header = peekAdtsFrameHeader(bytes);
	return header && { frameSize: header.frameLength, rate: header.samplingFrequencyIndex };
};

/** For the frame sync check: the size and sample rate of the MP3 frame whose header starts the bytes. */
const readMp3SyncHeader = (bytes: Uint8Array) => {
	const header = readMp3FrameHeader(toDataView(bytes).getUint32(0), null).header;
	return header && { frameSize: header.totalSize, rate: header.sampleRate };
};

/** For the frame sync check: an AC-3 sync word, which E-AC-3 dependent substreams after a core start with too. */
const readAc3SyncHeader = (bytes: Uint8Array) => {
	return bytes[0] === 0x0b && bytes[1] === 0x77 ? { frameSize: 0, rate: 0 } : null;
};

/**
 * Whether a section has all its data, as far as can be told: a bounded PES packet has its length, an unbounded one
 * ends with stuffing.
 */
const sectionLooksComplete = (chunks: Uint8Array[], byteLength: number, lastPacketWithPayload: TsPacket | null) => {
	const start = chunks[0];
	if (start && start.length >= 6 && start[0] === 0 && start[1] === 0 && start[2] === 1) {
		const pesPacketLength = (start[4]! << 8) | start[5]!;
		if (pesPacketLength > 0) {
			return byteLength >= 6 + pesPacketLength;
		}
	}

	return !!lastPacketWithPayload && hasStuffing(lastPacketWithPayload);
};

/** How far ahead to look for the next packet of a PID, to tell a duplicate packet */
const MAX_DUPLICATE_CHECK_PACKET_COUNT = 1024;

/**
 * Whether the TS packet's adaptation field pads it, which is how muxers make a PES packet end on a TS packet boundary.
 * Only a PES packet whose data fills its last TS packet exactly ends without.
 */
const hasStuffing = (packet: TsPacket) => {
	if (!(packet.adaptationFieldControl & 0b10)) {
		return false;
	}

	const length = packet.body[0]!;
	if (length === 0) {
		return true; // The length byte itself is the stuffing
	}

	const flags = packet.body[1]!;
	if ((flags & 0x1f) === 0) {
		return true; // Without optional fields, the adaptation field is there to pad (2 bytes or more)
	}

	let usedLength = 1 + (flags & 0x10 ? 6 : 0) + (flags & 0x08 ? 6 : 0) + (flags & 0x04 ? 1 : 0);
	if (flags & 0x02) {
		usedLength += 1 + (packet.body[1 + usedLength] ?? 0); // transport_private_data
	}
	if (flags & 0x01) {
		usedLength += 1 + (packet.body[1 + usedLength] ?? 0); // adaptation_field_extension
	}

	return length > usedLength;
};

/** For sections and PES packets without holes, so that they don't need an array of their own */
const NO_HOLES: readonly number[] = Object.freeze([]);

// Remember them so the warning doesn't get spammed
const ignoredStreamTypes = new Set<number>();

/** Whether a syncframe beginning with 0x0B77 uses AC-3's syntax (bsid up to 10) rather than E-AC-3's. */
const isAc3FamilyFrame = (bytes: Uint8Array) => bytes.length >= 6 && bytes[5]! >> 3 <= 10;

/** Thrown for streams we can't make sense of, which then get skipped. */
class UnreadableStreamError extends Error {}

type AvcFieldCoding = {
	log2MaxFrameNum: number;
	separateColourPlane: boolean;
};

type AvcSliceField = {
	frameNum: number;
	bottomField: number;
};

// Covers an AVC slice header up to bottom_field_flag, with room for emulation prevention bytes
const AVC_SLICE_FIELD_PEEK_SIZE = 16;

/** Reads which field a slice belongs to from the start of its header, or null for a frame or unreadable header. */
const readAvcSliceField = (bytes: Uint8Array, fieldCoding: AvcFieldCoding): AvcSliceField | null => {
	const unescaped = removeEmulationPreventionBytes(bytes);
	const bitstream = new Bitstream(unescaped);

	try {
		readExpGolomb(bitstream); // first_mb_in_slice
		readExpGolomb(bitstream); // slice_type
		readExpGolomb(bitstream); // pic_parameter_set_id
	} catch {
		return null;
	}

	if (fieldCoding.separateColourPlane) {
		bitstream.skipBits(2); // colour_plane_id
	}

	const frameNum = bitstream.readBits(fieldCoding.log2MaxFrameNum);
	const fieldPicFlag = bitstream.readBits(1);
	const bottomField = bitstream.readBits(1);

	if (bitstream.pos > 8 * unescaped.length || !fieldPicFlag) {
		return null;
	}

	return { frameNum, bottomField };
};

// How far to look for the rest of a PSI section whose packets are interleaved with other PIDs' packets. A section is
// at most 1024 bytes, so its packets don't sit far apart in any sane stream.
const MAX_PSI_SECTION_SCAN_PACKETS = 1000;

// How far to look for an intact copy of a damaged PSI section. Broadcasts repeat their tables at least every 0.5
// seconds (ETSI TR 101 290), so we stop once the media has progressed by a few seconds, or after a few more damaged
// copies (the muxer writes bad CRCs). FFmpeg only takes damaged sections after 10 of them in a row on a PID.
const MAX_PSI_SECTION_REPETITION_DISTANCE = 4 * 1024 * 1024;
const MAX_PSI_SECTION_REPETITION_DELAY = 2 * MPEG_TS_TIMESCALE;
const MAX_DAMAGED_PSI_SECTION_COPY_COUNT = 2;

const getPsiTableId = (payload: Uint8Array) => payload[1 + (payload[0] ?? 0)] ?? null;

const PROGRAM_ASSOCIATION_TABLE_ID = 0x00;
const PROGRAM_MAP_TABLE_ID = 0x02;

/** Returns the PTS of the PES packet starting in the given TS packet, as it is in the stream. */
const getRawPesPacketPts = (packet: TsPacket) => {
	let offset = 0;
	if (packet.adaptationFieldControl === 2 || packet.adaptationFieldControl === 3) {
		offset = 1 + packet.body[0]!;
	}

	const bytes = packet.body;
	if (
		offset + 14 > bytes.length
		|| bytes[offset] !== 0
		|| bytes[offset + 1] !== 0
		|| bytes[offset + 2] !== 1
		|| (bytes[offset + 6]! & 0xc0) !== 0x80 // No optional PES header
		|| (bytes[offset + 7]! & 0x80) === 0 // No PTS
	) {
		return null;
	}

	const ptsOffset = offset + 9;
	return ((bytes[ptsOffset]! >> 1) & 0x07) * 2 ** 30
		+ (bytes[ptsOffset + 1]! << 22)
		+ ((bytes[ptsOffset + 2]! >> 1) << 15)
		+ (bytes[ptsOffset + 3]! << 7)
		+ (bytes[ptsOffset + 4]! >> 1);
};

/** Checks the CRC_32 of the PSI section starting after the pointer_field of the given packet payload. */
const psiSectionIsIntact = (payload: Uint8Array) => {
	const sectionStart = 1 + (payload[0] ?? 0);
	if (sectionStart + 3 > payload.length) {
		return false;
	}

	const sectionLength = ((payload[sectionStart + 1]! & 0x0f) << 8) | payload[sectionStart + 2]!;
	const sectionEnd = sectionStart + 3 + sectionLength;
	if (sectionLength < 4 || sectionEnd > payload.length) {
		return false;
	}

	// Running the CRC over the section including its CRC_32 field gives zero
	return computeMpegTsCrc32(payload.subarray(sectionStart, sectionEnd)) === 0;
};

// How many PTS values at least to measure a video track's frame duration from
const MIN_FRAME_DURATION_PTS_COUNT = 16;

// How many packets without a timestamp of their own are read ahead at most to time them
const MAX_UNTIMED_PACKET_RUN_LENGTH = 300;
// The frame duration to assume when nothing better is known (like Chromium and FFmpeg do, 25 fps)
const DEFAULT_FRAME_DURATION = MPEG_TS_TIMESCALE / 25;

/** Returns the frame duration given by the timing info in the SPS, in 90 kHz ticks. */
const getVideoFrameDuration = (info: Extract<ElementaryStream['info'], { type: 'video' }>) => {
	let timingInfo: VuiTimingInfo | null = null;
	let ticksPerFrame = 1;

	if (info.avcCodecInfo) {
		const sps = info.avcCodecInfo.sequenceParameterSets[0];
		timingInfo = (sps && parseAvcSps(sps)?.timingInfo) ?? null;
		ticksPerFrame = 2; // AVC's clock ticks are field periods
	} else if (info.hevcCodecInfo) {
		const sps = info.hevcCodecInfo.arrays.find(x => x.nalUnitType === HevcNalUnitType.SPS_NUT)?.nalUnits[0];
		timingInfo = (sps && parseHevcSps(sps)?.timingInfo) ?? null;
	}

	if (!timingInfo || timingInfo.timeScale === 0) {
		return null;
	}

	// Some encoders write a clock that isn't the frame rate (like 1411200000 Hz, or the 90 kHz MPEG-TS clock), so only
	// take frame rates up to 2000 fps (high-speed cameras record at 240 to 960 fps)
	const frameDuration = ticksPerFrame * timingInfo.numUnitsInTick * MPEG_TS_TIMESCALE / timingInfo.timeScale;
	return frameDuration >= MPEG_TS_TIMESCALE / 2000 && frameDuration <= MPEG_TS_TIMESCALE ? frameDuration : null;
};

// Covers an AVC slice header up to pic_order_cnt_lsb, with room for emulation prevention bytes
const AVC_SLICE_HEADER_POC_PEEK_SIZE = 32;

/** Reads pic_order_cnt_lsb from the first slice of an AVC access unit, for picture order count type 0. */
const readAvcPicOrderCntLsb = (data: Uint8Array, sps: AvcSpsInfo) => {
	for (const loc of iterateNalUnitsInAnnexB(data)) {
		const nalHeader = data[loc.offset]!;
		const nalUnitType = extractNalUnitTypeForAvc(nalHeader);
		if (nalUnitType !== AvcNalUnitType.NON_IDR_SLICE && nalUnitType !== AvcNalUnitType.IDR) {
			continue;
		}

		const end = loc.offset + Math.min(loc.length, 1 + AVC_SLICE_HEADER_POC_PEEK_SIZE);
		const bytes = removeEmulationPreventionBytes(data.subarray(loc.offset + 1, end));
		const bitstream = new Bitstream(bytes);
		const isIdr = nalUnitType === AvcNalUnitType.IDR;

		try {
			readExpGolomb(bitstream); // first_mb_in_slice
			readExpGolomb(bitstream); // slice_type
			readExpGolomb(bitstream); // pic_parameter_set_id
			if (sps.separateColourPlaneFlag) {
				bitstream.skipBits(2); // colour_plane_id
			}

			bitstream.skipBits(sps.log2MaxFrameNumMinus4 + 4); // frame_num
			if (!sps.frameMbsOnlyFlag && bitstream.readBits(1)) { // field_pic_flag
				bitstream.skipBits(1); // bottom_field_flag
			}

			if (isIdr) {
				readExpGolomb(bitstream); // idr_pic_id
			}

			const picOrderCntLsb = bitstream.readBits(sps.log2MaxPicOrderCntLsbMinus4 + 4);
			if (bitstream.pos > 8 * bytes.length) {
				return null;
			}

			return { picOrderCntLsb, isIdr, isReference: (nalHeader >> 5) !== 0 };
		} catch {
			return null;
		}
	}

	return null;
};

/**
 * Places the first `count` of the given packets (in decode order) by their picture order counts, between the packets
 * with a timestamp around each in picture order, or beyond the two closest ones for those before or after all of them.
 * Returns null if that can't be done.
 */
const getTimestampsAmongPictures = (packets: SuppliedPacket[], picOrderCnts: (number | null)[], count: number) => {
	const references: { pts: number; picOrderCnt: number }[] = [];
	packets.forEach((packet, i) => {
		const picOrderCnt = picOrderCnts[i] ?? null;
		if (i >= count && packet.pts !== null && picOrderCnt !== null) {
			references.push({ pts: packet.pts, picOrderCnt });
		}
	});
	references.sort((a, b) => a.picOrderCnt - b.picOrderCnt);

	if (references.length < 2) {
		return null;
	}

	const result: number[] = [];
	for (let i = 0; i < count; i++) {
		const picOrderCnt = picOrderCnts[i] ?? null;
		if (picOrderCnt === null) {
			return null;
		}

		// The references around it, or the two closest ones if it comes before or after all of them
		let index = references.findIndex(x => x.picOrderCnt > picOrderCnt);
		if (index === -1) {
			index = references.length - 1;
		} else if (index === 0) {
			index = 1;
		}

		const before = references[index - 1]!;
		const after = references[index]!;
		const ticksPerPicOrderCnt = (after.pts - before.pts) / (after.picOrderCnt - before.picOrderCnt);
		if (!(ticksPerPicOrderCnt > 0) || !Number.isFinite(ticksPerPicOrderCnt)) {
			return null;
		}

		result.push(before.pts + (picOrderCnt - before.picOrderCnt) * ticksPerPicOrderCnt);
	}

	return result;
};

/**
 * Derives the picture order counts of consecutive AVC access units (in decode order), relative to the first one. An
 * IDR picture after the first one starts the picture order over: it and the ones after it get null. Returns null if a
 * slice header can't be read.
 */
const getAvcPicOrderCnts = (packets: { data: Uint8Array }[], sps: AvcSpsInfo) => {
	const maxPicOrderCntLsb = 2 ** (sps.log2MaxPicOrderCntLsbMinus4 + 4);
	const picOrderCnts: (number | null)[] = [];
	let prevMsb = 0;
	let prevLsb: number | null = null;
	let wasReset = false;

	for (const packet of packets) {
		const result = readAvcPicOrderCntLsb(packet.data, sps);
		if (!result) {
			return null;
		}

		wasReset ||= result.isIdr && prevLsb !== null;
		if (wasReset) {
			picOrderCnts.push(null);
			continue;
		}

		const lsb = result.picOrderCntLsb;
		let msb = prevMsb;
		if (prevLsb !== null && lsb < prevLsb && prevLsb - lsb >= maxPicOrderCntLsb / 2) {
			msb += maxPicOrderCntLsb;
		} else if (prevLsb !== null && lsb > prevLsb && lsb - prevLsb > maxPicOrderCntLsb / 2) {
			msb -= maxPicOrderCntLsb;
		}

		picOrderCnts.push(msb + lsb);
		if (result.isReference || prevLsb === null) {
			prevMsb = msb;
			prevLsb = lsb;
		}
	}

	return picOrderCnts;
};

// How many packets in a row must line up for a position to count as a packet start when resyncing
const RESYNC_PACKET_COUNT = 3;
// How many packet positions share an offset when resyncing
const RESYNC_BLOCK_PACKET_COUNT = 64;

/** What a packet position holds when there's no packet there (damage or junk), read like a null packet. */
const NOT_A_PACKET_HEADER: TsPacketHeader = {
	payloadUnitStartIndicator: 0,
	pid: 0x1fff, // The null packet PID
	adaptationFieldControl: 0,
};

/** Checks that a TS packet starts at the beginning of the slice, and that another one starts one stride later. */
const startsWithPacket = (slice: FileSlice | null, stride: number): slice is FileSlice => {
	return slice !== null
		&& slice.view.getUint8(slice.bufferPos) === 0x47
		&& slice.view.getUint8(slice.bufferPos + stride) === 0x47;
};

/** Reads the TS packet header fields following the sync byte. */
const readPacketHeaderFields = (slice: FileSlice): TsPacketHeader => {
	const nextTwoBytes = readU16Be(slice);
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const transportErrorIndicator = nextTwoBytes >> 15;
	const payloadUnitStartIndicator = (nextTwoBytes >> 14) & 0x1;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const transportPriority = (nextTwoBytes >> 13) & 0x1;
	const pid = nextTwoBytes & 0x1FFF;

	const nextByte = readU8(slice);
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const transportScramblingControl = nextByte >> 6;
	const adaptationFieldControl = (nextByte >> 4) & 0x3;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const continuityCounter = nextByte & 0xF;

	return {
		payloadUnitStartIndicator,
		pid,
		adaptationFieldControl,
	};
};

/** Reads a whole TS packet. Code in here is duplicated from readPacketHeaderFields for performance reasons. */
const readPacketFields = (bytes: Uint8Array): TsPacket => {
	const nextTwoBytes = (bytes[1]! << 8) + bytes[2]!;
	const transportErrorIndicator = nextTwoBytes >> 15;
	const payloadUnitStartIndicator = (nextTwoBytes >> 14) & 0x1;
	const pid = nextTwoBytes & 0x1FFF;
	const adaptationFieldControl = (bytes[3]! >> 4) & 0x3;
	const continuityCounter = bytes[3]! & 0xF;

	return {
		payloadUnitStartIndicator,
		pid,
		adaptationFieldControl,
		transportErrorIndicator,
		continuityCounter,
		body: bytes.subarray(4),
	};
};

/**
 * How far past a PAT or PMT that isn't in effect yet we look for one that is, before taking it anyway. PSI tables
 * repeat at least every half second in broadcasts (DVB), which this covers even at high bitrates.
 */
const MAX_TABLE_NOT_IN_EFFECT_DISTANCE = 2 ** 22; // 4 MiB

/**
 * Checks the current_next_indicator of the PAT or PMT section starting after the pointer_field of the given packet
 * payload. A section with 0 is the next version of its table, sent ahead of the switch, which isn't in effect yet.
 */
const psiSectionIsInEffect = (payload: Uint8Array) => {
	const sectionStart = 1 + (payload[0] ?? 0);
	const tableId = payload[sectionStart];
	if (tableId !== 0x00 && tableId !== 0x02) {
		// Another table on the same PID (private sections can share the PMT's), which this doesn't apply to, like in
		// FFmpeg, which checks the table_id first
		return true;
	}

	// table_id, section_length, and the table_id_extension (transport_stream_id or program_number) come before it
	return ((payload[sectionStart + 5] ?? 1) & 0x01) === 1;
};

export class MpegTsDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	elementaryStreams: ElementaryStream[] = [];
	trackBackingEntries: InputTrackBacking[] = [];
	packetOffset = 0;
	packetStride = -1;
	sectionEndPositions = new Set<number>();
	/**
	 * End positions of sections after which TS packets of their PID went missing. Reading a section again stops at its
	 * known end without reaching the next packet that tells.
	 */
	sectionEndsBeforeMissingPackets = new Set<number>();
	/** Start positions of the sections that the end of the file cut off */
	cutSectionStarts = new Set<number>();
	/**
	 * Per PID, the stretches of the file known to have no TS packets of it (only long ones, or ones running to the end
	 * of the file), sorted and disjoint, so that searches skip them instead of walking them again
	 */
	gaps = new Map<number, Gap[]>();
	seekChunkSize = 5 * 1024 * 1024; // 5 MiB, picked because most HLS segments are below this size
	maxMissingStreamScanSize = DEFAULT_MAX_MISSING_STREAM_SCAN_SIZE;
	minReferencePointByteDistance = -1;
	timestampWrapInfo: TimestampWrapInfo | null = null;
	/** For damaged files, where the packets of blocks of packet positions are found relative to them */
	blockOffsets = new Map<number, number>();

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			let startingSlice = this.reader.requestSliceRange(0, TS_PACKET_SIZE + 16 + 1, TS_PACKET_LAYOUT_PROBE_SIZE);
			if (isThenable(startingSlice)) startingSlice = await startingSlice;
			assert(startingSlice);

			const layout = findTsPacketLayout(readBytes(startingSlice, startingSlice.length));
			if (!layout) {
				throw new Error('Unreachable.');
			}

			this.packetOffset = layout.offset;
			this.packetStride = layout.stride;

			const MIN_REFERENCE_POINT_PACKET_DISTANCE = 256;
			this.minReferencePointByteDistance = MIN_REFERENCE_POINT_PACKET_DISTANCE * this.packetStride;

			let currentPos = this.packetOffset;
			// The PIDs of the PMTs of all programs, as listed by the PAT
			const programMapPids = new Set<number>();
			// Some files contain these multiple times, but we only care about their first appearance
			let hasProgramAssociationTable = false;
			let hasProgramMap = false;
			let firstPts: number | null = null;
			// Where the scan for missing streams ends, once it has begun
			let missingStreamScanEndPos: number | null = null;
			const unreadableStreamErrors: UnreadableStreamError[] = [];

			// Data without a PAT and PMT of its own, such as an HLS I-frame segment whose Media Initialization Section
			// precedes it in the resource, uses the program map of its init input. The data is then scanned again for
			// the first packets of the streams.
			const adoptInitProgramMap = async () => {
				if (hasProgramMap || !this.input._initInput) {
					return false;
				}

				const initDemuxer = await this.input._initInput._getDemuxer();
				if (!(initDemuxer instanceof MpegTsDemuxer)) {
					return false;
				}

				try {
					await initDemuxer.readMetadata();
				} catch {
					return false;
				}

				if (initDemuxer.elementaryStreams.length === 0) {
					return false;
				}

				for (const stream of initDemuxer.elementaryStreams) {
					this.elementaryStreams.push({
						...stream,
						demuxer: this,
						initialized: false,
						firstSection: null,
						canBeTrustedWithKeyPackets: false,
						info: { ...stream.info },
						referencePesPackets: [],
						droppedRanges: [],
						dropsRestOfGop: null,
					});
				}

				hasProgramMap = true;
				currentPos = this.packetOffset;
				// The first pass read sections as contiguous, which cuts PES packets short at the first packet of
				// another PID, so the section ends it recorded can't be trusted
				this.sectionEndPositions.clear();
				return true;
			};
			// PAT and PMT sections that only apply later are skipped while we look for the ones in effect (like in
			// FFmpeg). If none turns up, we go back to the first one we skipped and take it after all.
			let firstTableNotInEffectPos: number | null = null;
			let takesTablesNotInEffect = false;
			let programMapSectionPid: number | null = null;
			// Where to stop looking for the private data streams that don't say what they hold
			let privateDataProbeEndPos: number | null = null;

			while (true) {
				if (privateDataProbeEndPos !== null && currentPos >= privateDataProbeEndPos) {
					// The private data streams that don't say what they hold didn't show up as audio we know
					break;
				}

				const packetHeader = await this.readPacketHeader(currentPos);

				if (
					!hasProgramMap
					&& firstTableNotInEffectPos !== null
					&& !takesTablesNotInEffect
					&& (!packetHeader || currentPos - firstTableNotInEffectPos > MAX_TABLE_NOT_IN_EFFECT_DISTANCE)
				) {
					// A muxer that leaves current_next_indicator clear, or a capture that ends before the switch
					currentPos = firstTableNotInEffectPos;
					takesTablesNotInEffect = true;
					continue;
				}

				if (!packetHeader) {
					if (await adoptInitProgramMap()) {
						continue;
					}

					break;
				}

				if (packetHeader.payloadUnitStartIndicator === 0) {
					// Not the start of a section
					currentPos += this.packetStride;
					continue;
				}

				if (
					hasProgramMap
					&& (
						packetHeader.pid === programMapSectionPid
						|| !this.elementaryStreams.some(x => x.pid === packetHeader.pid && !x.initialized)
					)
				) {
					// Don't care about this PID (anymore), except for checking how far into the media we are
					if (firstPts !== null && this.elementaryStreams.some(x => x.pid === packetHeader.pid)) {
						const section = await this.readSection(currentPos, false);
						const pesPacketHeader = section ? readPesPacketHeader(this, section) : null;

						const fileSize = this.reader.fileSizeNonStrict;
						const delay = pesPacketHeader && pesPacketHeader.pts !== null
							? pesPacketHeader.pts - firstPts
							: 0;

						if (fileSize === null) {
							if (delay > MAX_STREAM_START_DELAY) {
								// The streams that still haven't shown up are declared, but don't seem to be in the
								// file, so let's stop looking for them instead of reading it all
								this.warnAboutMissingStreams(
									`within the first ${MAX_STREAM_START_DELAY / MPEG_TS_TIMESCALE} seconds of media`,
								);
								break;
							}
						} else if (delay > MISSING_STREAM_SCAN_DELAY) {
							missingStreamScanEndPos ??= Math.min(fileSize, currentPos + this.maxMissingStreamScanSize);

							const missingPids = this.elementaryStreams.filter(x => !x.initialized).map(x => x.pid);
							const nextPos = await this.findNextPayloadUnitStart(
								missingPids,
								currentPos + this.packetStride,
								missingStreamScanEndPos,
							);
							if (nextPos === null) {
								// The streams that still haven't shown up are declared, but aren't in the file (or
								// only far later), so let's stop looking for them
								if (missingStreamScanEndPos < fileSize) {
									const scanSize = `${Math.round(this.maxMissingStreamScanSize / 2 ** 20)} MiB`;
									this.warnAboutMissingStreams(`within ${scanSize} of the file`);
								}
								break;
							}

							// Continue where the next missing stream starts
							currentPos = nextPos;
							continue;
						}
					}

					currentPos += this.packetStride;
					continue;
				}

				const section = await this.readSection(
					currentPos,
					true,
					!hasProgramMap, // Expect contiguous sections as long as we don't have the PMT
				);
				if (!section) {
					if (await adoptInitProgramMap()) {
						continue;
					}

					break;
				}

				const BYTES_BEFORE_SECTION_LENGTH = 3;
				const BITS_IN_CRC_32 = 32; // Duh

				// Some streams don't contain a PAT for some reason, so we must do some guesswork to figure out where
				// the PMT is.
				let isProbablyProgramMap = false;
				if (!hasProgramMap && section.pid !== 0) {
					const isPesPacket
						= section.payload[0] === 0x00 && section.payload[1] === 0x00 && section.payload[2] === 0x01;

					if (!isPesPacket) {
						// Assume it's a PSI

						const bitstream = new Bitstream(section.payload);
						const pointerField = bitstream.readAlignedByte();

						bitstream.skipBits(8 * pointerField);

						const tableId = bitstream.readBits(8);
						isProbablyProgramMap = tableId === 0x02; // 0x02 == TS_program_map_section
					}
				}

				const isTable = (section.pid === 0 && !hasProgramAssociationTable)
					|| (!hasProgramMap && (programMapPids.has(section.pid) || isProbablyProgramMap));
				if (isTable) {
					await this.completePsiSection(section);
				}

				const isInEffect = takesTablesNotInEffect || psiSectionIsInEffect(section.payload);
				if (isTable && !isInEffect) {
					firstTableNotInEffectPos ??= currentPos;
				}

				if (section.pid === 0 && !hasProgramAssociationTable && isInEffect) {
					const intactSection = await this.findIntactPsiSection(
						section,
						PROGRAM_ASSOCIATION_TABLE_ID,
						takesTablesNotInEffect,
					);
					const bitstream = new Bitstream(intactSection.payload);
					const pointerField = bitstream.readAlignedByte();

					bitstream.skipBits(8 * pointerField);

					bitstream.skipBits(14);
					const sectionLength = bitstream.readBits(10);

					bitstream.skipBits(40);

					while (8 * (sectionLength + BYTES_BEFORE_SECTION_LENGTH) - bitstream.pos > BITS_IN_CRC_32) {
						const programNumber = bitstream.readBits(16);
						bitstream.skipBits(3); // Reserved
						const id = bitstream.readBits(13);

						if (programNumber !== 0) {
							programMapPids.add(id);
						}
					}

					if (programMapPids.size === 0) {
						throw new Error('Program Association Table must link to a Program Map Table.');
					}

					hasProgramAssociationTable = true;
				} else if ((programMapPids.has(section.pid) || isProbablyProgramMap) && !hasProgramMap && isInEffect) {
					// Broadcast captures often carry several programs. We present just one, so let's use the first one
					// whose PMT shows up (some programs listed in the PAT may not even be in the capture).
					const intactSection = await this.findIntactPsiSection(
						section,
						PROGRAM_MAP_TABLE_ID,
						takesTablesNotInEffect,
					);
					const bitstream = new Bitstream(intactSection.payload);
					const pointerField = bitstream.readAlignedByte();

					bitstream.skipBits(8 * pointerField);

					bitstream.skipBits(12);
					const sectionLength = bitstream.readBits(12);

					bitstream.skipBits(43);
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
					const pcrPid = bitstream.readBits(13);

					bitstream.skipBits(6);

					// "The remaining 10 bits specify the number of bytes of the descriptors immediately following the
					// program_info_length field"
					const programInfoLength = bitstream.readBits(10);

					// A few stream types only mean what Blu-ray says they mean, and the program's registration
					// descriptor is what tells us we're looking at a Blu-ray-derived stream.
					const programInfoEndPos = bitstream.pos + 8 * programInfoLength;
					let isBluRayProgram = false;

					while (bitstream.pos < programInfoEndPos) {
						const descriptorTag = bitstream.readBits(8);
						const descriptorLength = bitstream.readBits(8);
						const descriptorEndPos = bitstream.pos + 8 * descriptorLength;

						if (descriptorTag === REGISTRATION_DESCRIPTOR_TAG && descriptorLength >= 4) {
							const formatIdentifier = bitstream.readBits(32);
							isBluRayProgram ||= formatIdentifier === HDMV_FORMAT_IDENTIFIER
								|| formatIdentifier === HDPR_FORMAT_IDENTIFIER;
						}

						bitstream.pos = descriptorEndPos;
					}

					bitstream.pos = programInfoEndPos;

					while (8 * (sectionLength + BYTES_BEFORE_SECTION_LENGTH) - bitstream.pos > BITS_IN_CRC_32) {
						const streamType = bitstream.readBits(8);
						bitstream.skipBits(3);
						const elementaryPid = bitstream.readBits(13);

						bitstream.skipBits(6);
						const esInfoLength = bitstream.readBits(10);

						// Check ES descriptors to detect AC-3/E-AC-3/DTS in System B
						const esInfoEndPos = bitstream.pos + 8 * esInfoLength;
						let hasAc3Descriptor = false;
						let hasEac3Descriptor = false;
						let hasDtsDescriptor = false;
						let languageCode = UNDETERMINED_LANGUAGE;
						let audioType = 0;
						let hasOtherDescriptor = false;
						while (bitstream.pos < esInfoEndPos) {
							const descriptorTag = bitstream.readBits(8);
							const descriptorLength = bitstream.readBits(8);
							const descriptorEndPos = bitstream.pos + 8 * descriptorLength;

							if (descriptorTag === 0x6a) {
								hasAc3Descriptor = true;
							} else if (descriptorTag === 0x7a || descriptorTag === 0xcc) {
								hasEac3Descriptor = true;
							} else if (descriptorTag === 0x7b) {
								hasDtsDescriptor = true;
							} else if (descriptorTag === REGISTRATION_DESCRIPTOR_TAG && descriptorLength >= 4) {
								// DTS uses 'DTS1', 'DTS2' and 'DTS3' to also signal the stream's frame size,
								// which we work out from the bitstream anyway. A private data stream may also be named
								// AC-3 or E-AC-3 this way instead of with a DVB descriptor (FFmpeg reads both).
								const formatIdentifier = bitstream.readBits(32);
								const isDts = (formatIdentifier & 0xffffff00) === DTS_FORMAT_IDENTIFIER_PREFIX;
								const isAc3 = formatIdentifier === AC3_FORMAT_IDENTIFIER;
								const isEac3 = formatIdentifier === EAC3_FORMAT_IDENTIFIER;
								hasDtsDescriptor ||= isDts;
								hasAc3Descriptor ||= isAc3;
								hasEac3Descriptor ||= isEac3;
								// Says what the stream is, which isn't something we know
								hasOtherDescriptor ||= !isDts && !isAc3 && !isEac3;
							} else if (descriptorTag === ISO_639_LANGUAGE_DESCRIPTOR_TAG && descriptorLength >= 4) {
								// Dual-mono audio may list a second language, but the first one is what describes the
								// stream as a whole. Some muxers write it in upper case.
								languageCode = String.fromCharCode(
									bitstream.readBits(8),
									bitstream.readBits(8),
									bitstream.readBits(8),
								).toLowerCase();
								if (!isIso639Dash2LanguageCode(languageCode)) {
									languageCode = UNDETERMINED_LANGUAGE;
								}

								audioType = bitstream.readBits(8);
							} else if (NON_AUDIO_PRIVATE_DATA_DESCRIPTOR_TAGS.has(descriptorTag)) {
								hasOtherDescriptor = true;
							}

							bitstream.pos = descriptorEndPos;
						}

						let info: ElementaryStream['info'] | null = null;
						let codecFromPayload = false;

						// Blu-ray has its own stream types for E-AC-3 and the DTS extensions
						const effectiveStreamType = (isBluRayProgram && BLU_RAY_STREAM_TYPES.get(streamType))
							|| streamType;

						switch (effectiveStreamType) {
							case MpegTsStreamType.AVC:
							case MpegTsStreamType.HEVC: {
								const codec = streamType === MpegTsStreamType.AVC ? 'avc' : 'hevc';

								info = {
									type: 'video',
									codec,
									decoderConfig: null,
									avcCodecInfo: null,
									hevcCodecInfo: null,
									colorSpace: {
										primaries: null,
										transfer: null,
										matrix: null,
										fullRange: null,
									},
									width: -1,
									height: -1,
									squarePixelWidth: -1,
									squarePixelHeight: -1,
									pixelAspectRatio: { num: 1, den: 1 },
									reorderSize: -1,
									avcFieldCoding: null,
									reorderFrameCount: -1,
								};
							}; break;

							case MpegTsStreamType.MP3_MPEG1:
							case MpegTsStreamType.MP3_MPEG2:
							case MpegTsStreamType.AAC:
							case MpegTsStreamType.AC3_SYSTEM_A:
							case MpegTsStreamType.EAC3_SYSTEM_A:
							case MpegTsStreamType.DTS:
							case MpegTsStreamType.DTS_ATSC: {
								let codec: AudioCodec;
								if (
									effectiveStreamType === MpegTsStreamType.MP3_MPEG1
									|| effectiveStreamType === MpegTsStreamType.MP3_MPEG2
								) {
									codec = 'mp3';
								} else if (effectiveStreamType === MpegTsStreamType.AAC) {
									codec = 'aac';
								} else if (effectiveStreamType === MpegTsStreamType.AC3_SYSTEM_A) {
									codec = 'ac3';
								} else if (effectiveStreamType === MpegTsStreamType.EAC3_SYSTEM_A) {
									codec = 'eac3';
								} else {
									codec = 'dts';
								}

								info = {
									type: 'audio',
									codec,
									decoderConfig: null,
									aacCodecInfo: null,
									dtsFormat: null,
									numberOfChannels: -1,
									sampleRate: -1,
								};
							}; break;

							case MpegTsStreamType.PRIVATE_DATA: {
								if (hasEac3Descriptor) {
									info = {
										type: 'audio',
										codec: 'eac3',
										decoderConfig: null,
										aacCodecInfo: null,
										dtsFormat: null,
										numberOfChannels: -1,
										sampleRate: -1,
									};
								} else if (hasAc3Descriptor) {
									info = {
										type: 'audio',
										codec: 'ac3',
										decoderConfig: null,
										aacCodecInfo: null,
										dtsFormat: null,
										numberOfChannels: -1,
										sampleRate: -1,
									};
								} else if (hasDtsDescriptor) {
									info = {
										type: 'audio',
										codec: 'dts',
										decoderConfig: null,
										aacCodecInfo: null,
										dtsFormat: null,
										numberOfChannels: -1,
										sampleRate: -1,
									};
								} else if (!hasOtherDescriptor) {
									// Nothing says what the stream holds, as FFmpeg's m2ts mode writes AAC (and older
									// FFmpeg versions wrote DTS), so let the first PES packet tell. The codec is a
									// placeholder until then.
									codecFromPayload = true;
									info = {
										type: 'audio',
										codec: 'aac',
										decoderConfig: null,
										aacCodecInfo: null,
										dtsFormat: null,
										numberOfChannels: -1,
										sampleRate: -1,
									};
								}
							}; break;

							default: {
								// If we don't recognize the codec, we don't surface the track at all. This is because
								// we can't determine its metadata and also have no idea how to packetize its data.

								if (!ignoredStreamTypes.has(streamType) && !METADATA_STREAM_TYPES.has(streamType)) {
									Logging._warn(
										`Note: MPEG-TS streams with stream_type 0x${streamType.toString(16)} are not`
										+ ` currently supported.`,
									);
									ignoredStreamTypes.add(streamType);
								}
							}
						}

						if (info) {
							const elementaryStream: ElementaryStream = {
								demuxer: this,
								pid: elementaryPid,
								streamType,
								initialized: false,
								firstSection: null,
								canBeTrustedWithKeyPackets: false,
								languageCode,
								audioType,
								codecFromPayload,
								info,
								referencePesPackets: [],
								droppedRanges: [],
								dropsRestOfGop: null,
							};

							// Some PMTs list a PID twice, with the later entry describing the stream better (like an
							// AC-3 descriptor after MPEG audio), so that one wins, as in FFmpeg
							const index = this.elementaryStreams.findIndex(x => x.pid === elementaryPid);
							if (index === -1) {
								this.elementaryStreams.push(elementaryStream);
							} else {
								this.elementaryStreams[index] = elementaryStream;
							}
						}
					}

					hasProgramMap = true;
					programMapSectionPid = section.pid;

					if (this.elementaryStreams.some(x => !x.initialized)) {
						// PES packets can come before the PMT, like in a capture of a broadcast that starts between two
						// of its PSI repetitions, so look for each stream's first PES packet from the start of the file
						currentPos = this.packetOffset;
						continue;
					}
				} else {
					const elementaryStream = this.elementaryStreams.find(x => x.pid === section.pid);
					outer:
					if (elementaryStream && !elementaryStream.initialized) {
						try {
							const pesPacket = readPesPacket(this, section);
							if (!pesPacket) {
								throw new UnreadableStreamError(
									`Couldn't read first PES packet for Elementary Stream with PID`
									+ ` ${elementaryStream.pid}`,
								);
							}

							if (elementaryStream.codecFromPayload) {
								const codec = getAudioCodecFromPayload(pesPacket.data);
								if (!codec || elementaryStream.info.type !== 'audio') {
									// Not audio we know, so don't surface the stream, like any we don't support
									this.elementaryStreams.splice(this.elementaryStreams.indexOf(elementaryStream), 1);
									break outer;
								}

								elementaryStream.info.codec = codec;
								elementaryStream.codecFromPayload = false;
							}

							elementaryStream.firstSection = section;
							elementaryStream.canBeTrustedWithKeyPackets = section.randomAccessIndicator === 1;
							firstPts ??= pesPacket.pts;

							if (this.input._initInput) {
								const initDemuxer = (await this.input._initInput._getDemuxer()) as MpegTsDemuxer;
								const matchingStream = initDemuxer.elementaryStreams.find(x => (
									x.pid === section.pid
									&& x.info.codec === elementaryStream.info.codec
									&& x.initialized
								));

								if (matchingStream) {
									elementaryStream.info = matchingStream.info;
									elementaryStream.initialized = true;

									break outer; // We have the stream info, we're done
								}
							}

							const context = new PacketReadingContext(elementaryStream, pesPacket);

							if (elementaryStream.info.type === 'video') {
							// We loop because in some files, the video parameters are not in the first packet
								while (true) {
									const contextAlias = context; // TyyyyypeScript 😩
									contextAlias.suppliedPacket = null;
									await context.markNextPacket();

									if (elementaryStream.info.codec === 'avc') {
										if (!context.suppliedPacket) {
											throw new UnreadableStreamError(
												'Invalid AVC video stream; could not extract'
												+ ' AVCDecoderConfigurationRecord from any packet.',
											);
										}

										elementaryStream.info.avcCodecInfo
										= extractAvcDecoderConfigurationRecord(context.suppliedPacket.data);

										if (!elementaryStream.info.avcCodecInfo) {
											continue; // Search the next packet for it
										}

										const spsUnit = elementaryStream.info.avcCodecInfo.sequenceParameterSets[0];
										assert(spsUnit);
										const spsInfo = parseAvcSps(spsUnit)!;

										elementaryStream.info.width = spsInfo.displayWidth;
										elementaryStream.info.height = spsInfo.displayHeight;

										const num = spsInfo.pixelAspectRatio.num;
										const den = spsInfo.pixelAspectRatio.den;

										elementaryStream.info.squarePixelWidth = elementaryStream.info.width;
										elementaryStream.info.squarePixelHeight = elementaryStream.info.height;
										elementaryStream.info.pixelAspectRatio = { num: 1, den: 1 };

										if (num > 0 && den > 0) {
											elementaryStream.info.pixelAspectRatio = simplifyRational({ num, den });
											if (num > den) {
												elementaryStream.info.squarePixelWidth = Math.round(
													elementaryStream.info.width * num / den,
												);
											} else {
												elementaryStream.info.squarePixelHeight = Math.round(
													elementaryStream.info.height * den / num,
												);
											}
										}

										elementaryStream.info.colorSpace = {
											primaries:
											COLOR_PRIMARIES_MAP_INVERSE[spsInfo.colourPrimaries] as
											VideoColorPrimaries | undefined,
											transfer:
											TRANSFER_CHARACTERISTICS_MAP_INVERSE[spsInfo.transferCharacteristics] as
											VideoTransferCharacteristics | undefined,
											matrix:
											MATRIX_COEFFICIENTS_MAP_INVERSE[spsInfo.matrixCoefficients] as
											VideoMatrixCoefficients | undefined,
											fullRange: !!spsInfo.fullRangeFlag,
										};
										elementaryStream.info.reorderSize = spsInfo.maxDecFrameBuffering;
										// Without bitstream_restriction_flag, inferred as MaxDpbFrames
										elementaryStream.info.reorderFrameCount = spsInfo.numReorderFrames;
										elementaryStream.info.avcFieldCoding = spsInfo.frameMbsOnlyFlag
											? null
											: {
													log2MaxFrameNum: spsInfo.log2MaxFrameNumMinus4 + 4,
													separateColourPlane: spsInfo.separateColourPlaneFlag === 1,
												};

										break;
									} else if (elementaryStream.info.codec === 'hevc') {
										if (!context.suppliedPacket) {
											throw new UnreadableStreamError(
												'Invalid HEVC video stream; could not extract'
												+ ' HVCDecoderConfigurationRecord from first packet.',
											);
										}

										elementaryStream.info.hevcCodecInfo
										= extractHevcDecoderConfigurationRecord(context.suppliedPacket.data);

										if (!elementaryStream.info.hevcCodecInfo) {
											continue; // Search the next packet for it
										}

										const spsArray = elementaryStream.info.hevcCodecInfo.arrays.find(
											a => a.nalUnitType === HevcNalUnitType.SPS_NUT,
										)!;
										const spsUnit = spsArray.nalUnits[0];
										assert(spsUnit);
										const spsInfo = parseHevcSps(spsUnit)!;

										elementaryStream.info.width = spsInfo.displayWidth;
										elementaryStream.info.height = spsInfo.displayHeight;

										const num = spsInfo.pixelAspectRatio.num;
										const den = spsInfo.pixelAspectRatio.den;

										elementaryStream.info.squarePixelWidth = elementaryStream.info.width;
										elementaryStream.info.squarePixelHeight = elementaryStream.info.height;
										elementaryStream.info.pixelAspectRatio = { num: 1, den: 1 };

										if (num > 0 && den > 0) {
											elementaryStream.info.pixelAspectRatio = simplifyRational({ num, den });
											if (num > den) {
												elementaryStream.info.squarePixelWidth = Math.round(
													elementaryStream.info.width * num / den,
												);
											} else {
												elementaryStream.info.squarePixelHeight = Math.round(
													elementaryStream.info.height * den / num,
												);
											}
										}

										elementaryStream.info.colorSpace = {
											primaries:
											COLOR_PRIMARIES_MAP_INVERSE[spsInfo.colourPrimaries] as
											VideoColorPrimaries | undefined,
											transfer:
											TRANSFER_CHARACTERISTICS_MAP_INVERSE[spsInfo.transferCharacteristics] as
											VideoTransferCharacteristics | undefined,
											matrix:
											MATRIX_COEFFICIENTS_MAP_INVERSE[spsInfo.matrixCoefficients] as
											VideoMatrixCoefficients | undefined,
											fullRange: !!spsInfo.fullRangeFlag,
										};
										elementaryStream.info.reorderSize = spsInfo.maxDecFrameBuffering;
										// maxDecFrameBuffering is sps_max_num_reorder_pics + 1 here
										elementaryStream.info.reorderFrameCount = spsInfo.maxDecFrameBuffering - 1;

										break;
									} else {
										throw new Error('Unhandled.');
									}
								}

								elementaryStream.info.decoderConfig = {
									codec: extractVideoCodecString({
										width: elementaryStream.info.width,
										height: elementaryStream.info.height,
										codec: elementaryStream.info.codec,
										codecDescription: null,
										colorSpace: elementaryStream.info.colorSpace,
										avcType: 1,
										avcCodecInfo: elementaryStream.info.avcCodecInfo,
										hevcCodecInfo: elementaryStream.info.hevcCodecInfo,
										vp9CodecInfo: null,
										av1CodecInfo: null,
										proresFormat: null,
									}),
									codedWidth: elementaryStream.info.width,
									codedHeight: elementaryStream.info.height,
									colorSpace: elementaryStream.info.colorSpace,
								};

								const displayAspect = getDisplayAspect(
									elementaryStream.info.width,
									elementaryStream.info.height,
									elementaryStream.info.pixelAspectRatio,
								);
								if (displayAspect) {
									elementaryStream.info.decoderConfig.displayAspectWidth
									= displayAspect.displayAspectWidth;
									elementaryStream.info.decoderConfig.displayAspectHeight
									= displayAspect.displayAspectHeight;
								}

								elementaryStream.initialized = true;
							} else {
								await context.markNextPacket();
								if (!context.suppliedPacket) {
									throw new UnreadableStreamError(
										`Couldn't parse first media packet for Elementary Stream with`
										+ ` PID ${elementaryStream.pid}`,
									);
								}

								if (elementaryStream.info.codec === 'aac') {
									const slice = FileSlice.tempFromBytes(context.suppliedPacket.data);
									const header = readAdtsFrameHeader(slice);
									if (!header) {
										throw new UnreadableStreamError(
											'Invalid AAC audio stream; could not read ADTS frame header from first'
											+ ' packet.',
										);
									}

									elementaryStream.info.aacCodecInfo = {
										isMpeg2: false,
										objectType: header.objectType,
									};

									if (header.channelConfiguration === 0) {
										// The channel layout comes from the PCE at the start of the frame's
										// raw data block
										const headerSize = header.crcCheck === null
											? MIN_ADTS_FRAME_HEADER_SIZE
											: MAX_ADTS_FRAME_HEADER_SIZE;
										const result = readAdtsProgramConfigElement(
											context.suppliedPacket.data.subarray(headerSize, header.frameLength),
										);
										if (!result) {
											throw new UnreadableStreamError(
												'Invalid AAC audio stream; ADTS frames with channel configuration 0'
												+ ' must begin with a program config element.',
											);
										}

										elementaryStream.info.numberOfChannels
											= getAacProgramConfigElementChannelCount(result.programConfigElement);
									} else {
										elementaryStream.info.numberOfChannels
											= aacChannelMap[header.channelConfiguration]!;
									}
									elementaryStream.info.sampleRate
									= aacFrequencyTable[header.samplingFrequencyIndex]!;
								} else if (elementaryStream.info.codec === 'mp3') {
									const word = readU32Be(FileSlice.tempFromBytes(context.suppliedPacket.data));
									const result = readMp3FrameHeader(word, context.suppliedPacket.data.byteLength);
									if (!result.header) {
										throw new UnreadableStreamError(
											'Invalid MP3 audio stream; could not read frame header from first packet.',
										);
									}

									elementaryStream.info.numberOfChannels = getMp3ChannelCount(result.header.channel);
									elementaryStream.info.sampleRate = result.header.sampleRate;
								} else if (elementaryStream.info.codec === 'ac3') {
									const frameInfo = parseAc3SyncFrame(context.suppliedPacket.data);
									if (!frameInfo) {
										throw new UnreadableStreamError(
											'Invalid AC-3 audio stream; could not read sync frame from first packet.',
										);
									}

									if (frameInfo.fscod === 3) {
										throw new UnreadableStreamError(
											'Invalid AC-3 audio stream; reserved sample rate code found in first'
											+ ' packet.',
										);
									}

									elementaryStream.info.numberOfChannels
									= AC3_ACMOD_CHANNEL_COUNTS[frameInfo.acmod]! + frameInfo.lfeon;
									elementaryStream.info.sampleRate = AC3_SAMPLE_RATES[frameInfo.fscod]!;
								} else if (elementaryStream.info.codec === 'eac3') {
								// For Blu-ray's Dolby Digital Plus, this is an AC-3 frame (the core of each frame)
									const frameInfo = parseEac3OrAc3CoreSyncFrame(context.suppliedPacket.data);
									if (!frameInfo) {
										throw new UnreadableStreamError(
											'Invalid E-AC-3 audio stream; could not read sync frame from first packet.',
										);
									}

									const sampleRate = getEac3SampleRate(frameInfo);
									if (sampleRate === null) {
										throw new UnreadableStreamError(
											'Invalid E-AC-3 audio stream; reserved sample rate code found in first'
											+ ' packet.',
										);
									}

									elementaryStream.info.numberOfChannels = getEac3ChannelCount(frameInfo);
									elementaryStream.info.sampleRate = sampleRate;
								} else if (elementaryStream.info.codec === 'dts') {
									const frameInfo = parseDtsFrame(context.suppliedPacket.data);
									if (!frameInfo) {
										throw new UnreadableStreamError(
											'Invalid DTS audio stream; could not read frame header from first packet.',
										);
									}

									elementaryStream.info.numberOfChannels = frameInfo.numberOfChannels;
									elementaryStream.info.sampleRate = frameInfo.sampleRate;

									if (frameInfo.core) {
									// Telling the two extension-only variants apart would need us to work out
									// whether the asset holds XLL or LBR data, so we leave those unlabeled
										elementaryStream.info.dtsFormat = frameInfo.hasExtensions ? 'dtsh' : 'dtsc';
									}
								} else {
									throw new Error('Unhandled.');
								}

								elementaryStream.info.decoderConfig = {
									codec: extractAudioCodecString({
										codec: elementaryStream.info.codec,
										codecDescription: null,
										aacCodecInfo: elementaryStream.info.aacCodecInfo,
										dtsFormat: elementaryStream.info.dtsFormat,
									}),
									numberOfChannels: elementaryStream.info.numberOfChannels,
									sampleRate: elementaryStream.info.sampleRate,
								};
								elementaryStream.initialized = true;
							}
						} catch (error) {
							if (!(error instanceof UnreadableStreamError)) {
								throw error;
							}

							// Like FFmpeg, let's not have one broken, mislabeled or scrambled stream make the whole
							// file unreadable
							const pid = elementaryStream.pid;
							Logging._warn(`Skipping MPEG-TS stream with PID ${pid}: ${error.message}`);
							this.elementaryStreams.splice(this.elementaryStreams.indexOf(elementaryStream), 1);
							unreadableStreamErrors.push(error);
						}
					}
				}

				if (hasProgramMap && this.elementaryStreams.every(x => x.initialized || x.codecFromPayload)) {
					privateDataProbeEndPos ??= currentPos + MAX_PRIVATE_DATA_PROBE_DISTANCE;
				}

				const isDone = hasProgramMap && this.elementaryStreams.every(x => x.initialized);
				if (isDone) {
					break;
				}

				currentPos += this.packetStride;
			}

			if (!hasProgramMap) {
				if (!hasProgramAssociationTable) {
					throw new Error('No Program Association Table found in the file.');
				}

				throw new Error('No Program Map Table found in the file.');
			}

			if (unreadableStreamErrors.length > 0 && !this.elementaryStreams.some(x => x.initialized)) {
				// Nothing readable is left, so the error is more helpful than an empty file
				throw unreadableStreamErrors[0]!;
			}

			for (const stream of this.elementaryStreams) {
				if (!stream.initialized) {
					// Stream was declared but no initialization data for it was found
					continue;
				}

				if (stream.info.type === 'video') {
					this.trackBackingEntries.push(
						new MpegTsVideoTrackBacking(stream as ElementaryVideoStream),
					);
				} else {
					this.trackBackingEntries.push(
						new MpegTsAudioTrackBacking(stream as ElementaryAudioStream),
					);
				}
			}
		})();
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.trackBackingEntries;
	}

	async getMetadataTags(): Promise<MetadataTags> {
		return {}; // Nothing for now
	}

	async getMimeType(): Promise<string> {
		await this.readMetadata();

		const codecStrings = await Promise.all(this.trackBackingEntries.map(
			x => x.getDecoderConfig().then(c => c?.codec ?? null),
		));

		return buildMpegTsMimeType(codecStrings);
	}

	async readSection(startPos: number, full: boolean, contiguous = false): Promise<Section | null> {
		let endPos = startPos;
		let currentPos = startPos;
		const chunks: Uint8Array[] = [];
		let chunksByteLength = 0;
		let firstPacket: TsPacket | null = null;
		let mustAddSectionEnd = true;
		let randomAccessIndicator = 0;
		// Stretches without packets of the section's PID, which can be skipped
		let gaps: Gap[] | undefined;
		let holes: number[] | null = null;
		// For checking the continuity counters (H.222.0 2.4.3.3): the counter and payload of the section's last TS
		// packet with payload, and how many packets without payload came after it
		let lastContinuityCounter = -1;
		let lastPayload: Uint8Array | null = null;
		let packetsWithoutPayloadCount = 0;
		let lastPacketWithPayload: TsPacket | null = null;
		// Whether a PAT came since the section's last packet, like at the start of a file joined to the previous one
		let sawPatSinceLastPacket = false;

		while (true) {
			if (gaps) {
				currentPos = getGapEnd(gaps, currentPos);
			}

			// Infinity: no more packets of the PID until the end of the file
			const packet = currentPos === Infinity ? null : await this.readPacket(currentPos);
			currentPos += this.packetStride;

			if (!packet) {
				if (firstPacket && full && !contiguous) {
					this.addGap(firstPacket.pid, endPos, Infinity);
				}

				if (full && firstPacket && !sectionLooksComplete(chunks, chunksByteLength, lastPacketWithPayload)) {
					// The file ends before the section does. Since reading the section again stops at its known end,
					// remember that.
					this.cutSectionStarts.add(startPos);
				}

				break;
			}

			if (!firstPacket) {
				if (packet.payloadUnitStartIndicator === 0) {
					break;
				}
			} else if (packet.pid !== firstPacket.pid) {
				if (contiguous) {
					// The section may well continue after the foreign packets, so this isn't necessarily its end
					mustAddSectionEnd = false;
					break;
				} else {
					sawPatSinceLastPacket ||= packet.pid === 0;
					continue; // Ignore this packet
				}
			}

			const hasAdaptationField = !!(packet.adaptationFieldControl & 0b10);
			const hasPayload = !!(packet.adaptationFieldControl & 0b01);
			const adaptationFieldLength = hasAdaptationField ? 1 + packet.body[0]! : 0;
			const payload = hasPayload ? packet.body.subarray(adaptationFieldLength) : null;
			let keepsPayload = true;

			if (!firstPacket) {
				firstPacket = packet;
				gaps = contiguous ? undefined : this.gaps.get(packet.pid);
			} else {
				let isDuplicate = false;
				const counter = packet.continuityCounter;

				if (packet.transportErrorIndicator === 1) {
					// The packet had errors that couldn't be corrected, so its bytes are garbage: leave them out
					keepsPayload = false;
					if (packet.payloadUnitStartIndicator === 0) {
						(holes ??= []).push(chunksByteLength);
					}
				} else if (payload && lastContinuityCounter !== -1 && counter !== ((lastContinuityCounter + 1) & 0xf)) {
					if (
						counter === lastContinuityCounter
						&& lastPayload
						&& uint8ArraysAreEqual(payload, lastPayload)
						&& await this.nextContinuityCounterFollows(packet.pid, currentPos, counter)
					) {
						// A copy of the previous packet (only a PCR may differ), allowed once, which must be discarded
						isDuplicate = true;
						keepsPayload = false;
					} else {
						const discontinuityIndicator = adaptationFieldLength > 1 && !!(packet.body[1]! & 0x80);
						const packetsWentMissing = !discontinuityIndicator
							// Some muxers count the packets without payload too
							&& counter !== ((lastContinuityCounter + 1 + packetsWithoutPayloadCount) & 0xf)
							// And some never increment the counter, which then says nothing
							&& counter !== lastContinuityCounter;

						if (packet.payloadUnitStartIndicator === 0) {
							if (packetsWentMissing) {
								(holes ??= []).push(chunksByteLength);
							}
						} else if (
							packetsWentMissing
							// At the start of the next section, a jump can as well be the join of two files whose
							// counters both start over (like concatenated HLS segments), where the section is complete
							// and the second file starts with a PAT
							&& !sawPatSinceLastPacket
							&& !sectionLooksComplete(chunks, chunksByteLength, lastPacketWithPayload)
						) {
							// The packets of the section's end went missing
							(holes ??= []).push(chunksByteLength);
							this.sectionEndsBeforeMissingPackets.add(endPos);
						}
					}
				}

				if (packet.payloadUnitStartIndicator === 1 && !isDuplicate) {
					if (full && !contiguous) {
						this.addGap(packet.pid, endPos, currentPos - this.packetStride);
					}

					break;
				}
			}

			if (keepsPayload && packet.transportErrorIndicator === 0) {
				if (payload) {
					lastContinuityCounter = packet.continuityCounter;
					lastPayload = payload;
					lastPacketWithPayload = packet;
					packetsWithoutPayloadCount = 0;
				} else {
					packetsWithoutPayloadCount++;
				}
			}

			// Extract random_access_indicator from first packet's adaptation field
			if (packet === firstPacket && adaptationFieldLength > 1) {
				randomAccessIndicator = (packet.body[1]! >> 6) & 1;
			}

			if (payload && keepsPayload) {
				chunks.push(payload);
				chunksByteLength += payload.byteLength;
			}
			sawPatSinceLastPacket = false;

			endPos = currentPos;

			// 64 is just "a bit of data", enough for the PES packet header
			if (!full && chunksByteLength >= 64) {
				mustAddSectionEnd = false; // Not the actual section end
				break;
			}

			// Check if we already know this is a section end
			const isKnownSectionEnd = this.sectionEndPositions.has(endPos);
			if (isKnownSectionEnd) {
				mustAddSectionEnd = false;
				if (this.sectionEndsBeforeMissingPackets.has(endPos)) {
					(holes ??= []).push(chunksByteLength);
				}
				break;
			}
		}

		if (mustAddSectionEnd) {
			this.sectionEndPositions.add(endPos);
		}

		if (!firstPacket) {
			return null;
		}

		let merged: Uint8Array;
		if (chunks.length === 1) {
			merged = chunks[0]!;
		} else {
			const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
			merged = new Uint8Array(totalLength);
			let offset = 0;
			for (const chunk of chunks) {
				merged.set(chunk, offset);
				offset += chunk.length;
			}
		}

		return {
			startPos,
			endPos: full ? endPos : null,
			pid: firstPacket.pid,
			payload: merged,
			randomAccessIndicator,
			holes: holes ?? NO_HOLES,
			firstPacketHasErrors: firstPacket.transportErrorIndicator === 1,
			cutAtEnd: this.cutSectionStarts.has(startPos),
		};
	}

	/**
	 * Whether the next TS packet of the PID with payload, from pos on, has the continuity counter that follows the
	 * given one. That tells a duplicate packet from a muxer that never increments the counter, for which two identical
	 * packets in a row are just data.
	 */
	async nextContinuityCounterFollows(pid: number, pos: number, counter: number) {
		for (let i = 0; i < MAX_DUPLICATE_CHECK_PACKET_COUNT; i++, pos += this.packetStride) {
			const packet = await this.readPacket(pos);
			if (!packet) {
				return false;
			}

			if (packet.pid === pid && packet.adaptationFieldControl & 0b01) {
				return packet.continuityCounter === ((counter + 1) & 0xf);
			}
		}

		return false;
	}

	/** Remembers that there are no TS packets of the PID from `start` to `end`, if that's worth remembering. */
	addGap(pid: number, start: number, end: number) {
		if (end - start < MIN_REMEMBERED_GAP_SIZE && end !== Infinity) {
			return;
		}

		let gaps = this.gaps.get(pid);
		if (!gaps) {
			gaps = [];
			this.gaps.set(pid, gaps);
		}

		// Merge with the gaps it overlaps or touches
		let first = binarySearchLessOrEqual(gaps, start, x => x.start);
		if (first === -1 || gaps[first]!.end < start) {
			first++;
		}

		let last = first;
		while (last < gaps.length && gaps[last]!.start <= end) {
			last++;
		}

		gaps.splice(first, last - first, {
			start: Math.min(start, gaps[first]?.start ?? start),
			end: Math.max(end, gaps[last - 1]?.end ?? end),
		});
	}

	/**
	 * Returns the position of the next TS packet of the PID at or after `startPos` (and before `endPos`), or null if
	 * there's none: of one starting a PES packet if `pesPacketStart` is set, else of any. Streams can go without
	 * packets for long (a broadcast capture's audio PID that stops for a while or for good, a track that ends before
	 * the others), so long stretches without any are remembered, and later searches skip them.
	 */
	async findNextPacket(pid: number, startPos: number, endPos = Infinity, pesPacketStart = true) {
		const gaps = this.gaps.get(pid);
		let gapStart = startPos;
		let pos = startPos;

		while (pos < endPos) {
			if (gaps) {
				const gapEnd = getGapEnd(gaps, pos);
				if (gapEnd > pos) {
					pos = gapEnd;
					continue;
				}
			}

			const packetHeader = await this.readPacketHeader(pos);
			if (!packetHeader) {
				this.addGap(pid, gapStart, Infinity);
				return null;
			}

			if (packetHeader.pid === pid) {
				this.addGap(pid, gapStart, pos);
				if (!pesPacketStart || packetHeader.payloadUnitStartIndicator === 1) {
					return pos;
				}

				gapStart = pos + this.packetStride;
			}

			pos += this.packetStride;
		}

		this.addGap(pid, gapStart, pos);
		return null;
	}

	/** Warns that declared streams which haven't shown up `where` are left out, since they may start later on. */
	warnAboutMissingStreams(where: string) {
		// Private data streams without descriptors may well hold no audio at all, so they aren't missed
		const streams = this.elementaryStreams
			.filter(x => !x.initialized && !x.codecFromPayload)
			.map(x => `PID ${x.pid} (stream_type 0x${x.streamType.toString(16).padStart(2, '0')})`);
		if (streams.length === 0) {
			return;
		}

		Logging._warn(
			`MPEG-TS: these streams are declared but didn't show up ${where}, so they're left out (if they start later`
			+ ` in the file, they won't be available): ${streams.join(', ')}.`,
		);
	}

	/** Returns the position of the next TS packet that starts a payload unit on one of the given PIDs, if any. */
	async findNextPayloadUnitStart(pids: number[], startPos: number, endPos: number) {
		let pos = startPos;

		while (pos + TS_PACKET_SIZE <= endPos) {
			const packetCount = Math.min(
				Math.floor(MISSING_STREAM_SCAN_CHUNK_SIZE / this.packetStride),
				Math.floor((endPos - pos - TS_PACKET_SIZE) / this.packetStride) + 1,
			);
			const length = (packetCount - 1) * this.packetStride + TS_PACKET_SIZE;

			let slice = this.reader.requestSlice(pos, length);
			if (isThenable(slice)) {
				slice = await slice;
			}
			if (!slice) {
				return null;
			}

			const bytes = readBytes(slice, length);
			for (let i = 0; i < packetCount; i++) {
				const offset = i * this.packetStride;
				if (bytes[offset] !== 0x47) {
					continue; // Not a packet
				}

				const pid = ((bytes[offset + 1]! & 0x1f) << 8) | bytes[offset + 2]!;
				const payloadUnitStart = (bytes[offset + 1]! & 0x40) !== 0;
				const hasPayload = (bytes[offset + 3]! & 0x10) !== 0;
				if (payloadUnitStart && hasPayload && pids.includes(pid)) {
					return pos + offset;
				}
			}

			pos += packetCount * this.packetStride;
		}

		return null;
	}

	/**
	 * Before we have the PMT, sections are only read as long as their TS packets are contiguous. But packets of other
	 * PIDs may well sit between the packets of a PSI section, so this appends whatever the section is still missing.
	 */
	async completePsiSection(section: Section) {
		const sectionStart = 1 + (section.payload[0] ?? 0); // Skip the pointer_field
		if (sectionStart + 3 > section.payload.length || section.endPos === null) {
			return;
		}

		const sectionLength = ((section.payload[sectionStart + 1]! & 0x0f) << 8) | section.payload[sectionStart + 2]!;
		const missingLength = sectionStart + 3 + sectionLength - section.payload.length;
		if (missingLength <= 0) {
			return;
		}

		const chunks = [section.payload];
		let collectedLength = 0;
		let currentPos = section.endPos;

		for (let i = 0; i < MAX_PSI_SECTION_SCAN_PACKETS && collectedLength < missingLength; i++) {
			const packet = await this.readPacket(currentPos);
			currentPos += this.packetStride;

			if (!packet || (packet.pid === section.pid && packet.payloadUnitStartIndicator === 1)) {
				break;
			}

			if (packet.pid !== section.pid || !(packet.adaptationFieldControl & 0b01)) {
				continue;
			}

			const payloadStart = packet.adaptationFieldControl & 0b10 ? 1 + packet.body[0]! : 0;
			const payload = packet.body.subarray(payloadStart);
			chunks.push(payload);
			collectedLength += payload.length;
		}

		const merged = new Uint8Array(section.payload.length + collectedLength);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}

		section.payload = merged;
	}

	/**
	 * PSI sections end in a CRC so that damaged copies can be told apart, which matters for captures with reception
	 * errors. Since the tables are repeated several times per second, we look a bit further for a copy that passes the
	 * check if the given one doesn't, like FFmpeg skips damaged sections. Some muxers write bad CRCs though, so if
	 * there's no intact copy, we go with the given one.
	 */
	async findIntactPsiSection(section: Section, tableId: number, takesTablesNotInEffect = false): Promise<Section> {
		// The table ID to look for comes from the PID, since the damage may well be in the first copy's pointer_field
		// or table_id
		if (psiSectionIsIntact(section.payload) && getPsiTableId(section.payload) === tableId) {
			return section;
		}

		const endPos = section.startPos + MAX_PSI_SECTION_REPETITION_DISTANCE;
		const firstPtsByPid = new Map<number, number>();
		let damagedCopyCount = 0;

		try {
			for (let pos = section.startPos + this.packetStride; pos < endPos; pos += this.packetStride) {
				const packetHeader = await this.readPacketHeader(pos);
				if (!packetHeader) {
					break;
				}

				if (packetHeader.payloadUnitStartIndicator === 0) {
					continue;
				}

				if (packetHeader.pid === section.pid) {
					const copy = await this.readSection(pos, true, true);
					// The next version of the table (current_next_indicator 0) is another table, not a copy
					if (
						copy
						&& getPsiTableId(copy.payload) === tableId
						&& (takesTablesNotInEffect || psiSectionIsInEffect(copy.payload))
					) {
						if (psiSectionIsIntact(copy.payload)) {
							return copy;
						}

						if (++damagedCopyCount === MAX_DAMAGED_PSI_SECTION_COPY_COUNT) {
							break;
						}
					}
				} else {
					const packet = await this.readPacket(pos);
					const pts = packet && getRawPesPacketPts(packet);
					if (pts !== null) {
						const firstPts = firstPtsByPid.get(packetHeader.pid) ?? pts;
						firstPtsByPid.set(packetHeader.pid, firstPts);

						// The difference, accounting for the timestamps wrapping around
						const delay = (pts - firstPts + 3 * 2 ** 32) % 2 ** 33 - 2 ** 32;
						if (delay > MAX_PSI_SECTION_REPETITION_DELAY) {
							break;
						}
					}
				}
			}
		} catch {
			// The search ran into more damage, so let's go with what we have
		}

		return section;
	}

	readPacketHeader(pos: number): Promise<TsPacketHeader | null> {
		// Read from the previous packet's sync byte on to check that the packets are where they should be. (Unlike
		// the next one, it's usually been read already, or is about to be when reading backwards.)
		const stride = this.packetStride;
		const slice = pos >= stride ? this.reader.requestSlice(pos - stride, stride + 4) : null;
		if (isThenable(slice) || !startsWithPacket(slice, stride)) {
			return this.readPacketHeaderSlow(pos, slice);
		}

		slice.skip(stride + 1); // The previous packet and the sync byte
		return Promise.resolve(readPacketHeaderFields(slice));
	}

	async readPacketHeaderSlow(pos: number, slicePromise: MaybePromise<FileSlice | null>) {
		const slice = await slicePromise;
		if (startsWithPacket(slice, this.packetStride)) {
			slice.skip(this.packetStride + 1);
			return readPacketHeaderFields(slice);
		}

		const packetSlice = await this.findPacket(pos, 4);
		if (!packetSlice) {
			return packetSlice === null ? NOT_A_PACKET_HEADER : null;
		}

		packetSlice.skip(1); // Sync byte
		return readPacketHeaderFields(packetSlice);
	}

	readPacket(pos: number): Promise<TsPacket | null> {
		// Read up to the next packet's sync byte to check that the packets are where they should be
		const slice = this.reader.requestSlice(pos, this.packetStride + 1);
		if (isThenable(slice) || !startsWithPacket(slice, this.packetStride)) {
			return this.readPacketSlow(pos, slice);
		}

		return Promise.resolve(readPacketFields(readBytes(slice, TS_PACKET_SIZE)));
	}

	async readPacketSlow(pos: number, slicePromise: MaybePromise<FileSlice | null>) {
		const slice = await slicePromise;
		const packetSlice = startsWithPacket(slice, this.packetStride)
			? slice
			: await this.findPacket(pos, TS_PACKET_SIZE);
		if (!packetSlice) {
			return packetSlice === null
				? { ...NOT_A_PACKET_HEADER, transportErrorIndicator: 0, continuityCounter: 0, body: new Uint8Array(0) }
				: null;
		}

		return readPacketFields(readBytes(packetSlice, TS_PACKET_SIZE));
	}

	/**
	 * Damaged files can have bytes missing or added (or junk at the end), which shifts all packets after them away from
	 * their positions. Like FFmpeg and Chromium, we then resync to where several packets in a row line up. To keep
	 * this fast and the packet positions stable, the packet positions are grouped into blocks, and each block assumes
	 * the offset at which its first packet was found until its packets turn out to be elsewhere.
	 */
	async findPacket(pos: number, length: number) {
		let packetPos = pos + await this.getBlockOffset(pos);

		const isAtExpectedPos = await this.isPacketStart(packetPos);
		if (isAtExpectedPos === null) {
			return undefined; // End of file
		}

		if (!isAtExpectedPos) {
			const offset = await this.searchPacketStart(packetPos);
			if (offset === null) {
				return null;
			}

			packetPos += offset;
		}

		let slice = this.reader.requestSlice(packetPos, length);
		if (isThenable(slice)) {
			slice = await slice;
		}

		return slice ?? undefined;
	}

	/**
	 * Returns the offset of the packets in the block of packet positions the given one belongs to: where a packet was
	 * found for its first position that has one.
	 */
	async getBlockOffset(pos: number) {
		const blockStride = RESYNC_BLOCK_PACKET_COUNT * this.packetStride;
		const blockIndex = Math.floor((pos - this.packetOffset) / blockStride);

		let blockOffset = this.blockOffsets.get(blockIndex);
		if (blockOffset === undefined) {
			blockOffset = 0;

			const blockStartPos = this.packetOffset + blockIndex * blockStride;
			for (let i = 0; i < RESYNC_BLOCK_PACKET_COUNT; i++) {
				const slotPos = blockStartPos + i * this.packetStride;
				if (await this.isPacketStart(slotPos)) {
					break;
				}

				const offset = await this.searchPacketStart(slotPos);
				if (offset !== null) {
					blockOffset = offset;
					break;
				}
			}

			this.blockOffsets.set(blockIndex, blockOffset);
		}

		return blockOffset;
	}

	/**
	 * Checks if a packet starts at the given position, with another one before or after it (or none at the end of the
	 * file). Returns null past the end of the file.
	 */
	async isPacketStart(pos: number) {
		const stride = this.packetStride;
		const startPos = Math.max(pos - stride, 0);
		let slice = this.reader.requestSliceRange(startPos, 0, pos + stride + 1 - startPos);
		if (isThenable(slice)) {
			slice = await slice;
		}

		const bytes = slice ? readBytes(slice, slice.length) : new Uint8Array(0);
		const index = pos - startPos;
		if (index >= bytes.length) {
			return null;
		}

		return bytes[index] === 0x47 && (
			bytes[index - stride] === 0x47
			|| bytes[index + stride] === 0x47
			|| index + stride >= bytes.length // The last packet
		);
	}

	/**
	 * Looks for a packet start near the given position, where several packets in a row start (at least two), and
	 * returns its offset to the position. The search covers one stride, so that no two packet positions find the same
	 * packet.
	 */
	async searchPacketStart(pos: number) {
		const stride = this.packetStride;
		const searchStartPos = Math.max(pos - Math.floor(stride / 2), this.packetOffset);
		const searchEndPos = pos - Math.floor(stride / 2) + stride;

		const searchLength = searchEndPos - searchStartPos + RESYNC_PACKET_COUNT * stride;
		let slice = this.reader.requestSliceRange(searchStartPos, 0, searchLength);
		if (isThenable(slice)) {
			slice = await slice;
		}
		if (!slice) {
			return null;
		}

		const bytes = readBytes(slice, slice.length);

		// Try the closest positions first
		for (let distance = 0; distance <= stride; distance++) {
			const offset = (distance & 1) ? (distance + 1) / 2 : -distance / 2;
			const index = pos + offset - searchStartPos;
			if (pos + offset < searchStartPos || pos + offset >= searchEndPos || bytes[index] !== 0x47) {
				continue;
			}

			let syncCount = 0;
			while (syncCount < RESYNC_PACKET_COUNT && index + syncCount * stride < bytes.length) {
				if (bytes[index + syncCount * stride] !== 0x47) {
					break;
				}

				syncCount++;
			}

			const availableCount = Math.min(RESYNC_PACKET_COUNT, Math.ceil((bytes.length - index) / stride));
			if (syncCount === availableCount && syncCount >= 2) {
				return offset;
			}
		}

		return null;
	}

	normalizeTimestamp(timestamp: number) {
		// If there's no info yet, initialize it anchored on this timestamp. Since we process packets sequentially when
		// extracting metadata, this means we'll anchor to the first PTS in the file.
		this.timestampWrapInfo ??= createTimestampWrapInfo(timestamp);
		return normalizeWrappedTimestamp(timestamp, this.timestampWrapInfo);
	}
}

type PesPacketHeader = {
	sectionStartPos: number;
	sectionEndPos: number | null; // null if the section wasn't read fully
	pts: number | null;
	randomAccessIndicator: number;
};

type TimestampedPesPacketHeader = PesPacketHeader & {
	pts: number;
};

type PesPacket = PesPacketHeader & {
	data: Uint8Array<ArrayBufferLike>;
	/** Where in the data some is missing, ascending */
	holes: readonly number[];
	/** Whether the end of the file cut the PES packet off */
	cutAtEnd: boolean;
};

const readPesPacketHeader = (demuxer: MpegTsDemuxer, section: Section): PesPacketHeader | null => {
	if (section.payload.byteLength < 3) {
		return null;
	}

	const bitstream = new Bitstream(section.payload);

	const startCodePrefix = bitstream.readBits(24);
	if (startCodePrefix !== 0x000001) {
		return null;
	}

	const streamId = bitstream.readBits(8);
	bitstream.skipBits(16);

	if (
		streamId === 0b10111100 // program_stream_map
		|| streamId === 0b10111110 // padding_stream
		|| streamId === 0b10111111 // private_stream_2
		|| streamId === 0b11110000 // ECM
		|| streamId === 0b11110001 // EMM
		|| streamId === 0b11111111 // program_stream_directory
		|| streamId === 0b11110010 // DSMCC_stream
		|| streamId === 0b11111000 // ITU-T Rec. H.222.1 type E stream
	) {
		return null;
	}

	bitstream.skipBits(8);

	const ptsDtsFlags = bitstream.readBits(2);

	bitstream.skipBits(14);

	let pts: number | null = null;
	if (ptsDtsFlags === 0b10 || ptsDtsFlags === 0b11) {
		pts = 0;

		bitstream.skipBits(4);
		pts += bitstream.readBits(3) * (1 << 30);
		bitstream.skipBits(1);
		pts += bitstream.readBits(15) * (1 << 15);
		bitstream.skipBits(1);
		pts += bitstream.readBits(15);

		pts = demuxer.normalizeTimestamp(pts);
	}

	return {
		sectionStartPos: section.startPos,
		sectionEndPos: section.endPos,
		pts,
		randomAccessIndicator: section.randomAccessIndicator,
	};
};

const readPesPacket = (demuxer: MpegTsDemuxer, section: Section): PesPacket | null => {
	assert(section.endPos !== null); // Can only read full PES packets from fully read sections

	const header = readPesPacketHeader(demuxer, section);
	if (!header) {
		return null;
	}

	const bitstream = new Bitstream(section.payload);
	bitstream.skipBits(32);
	const pesPacketLength = bitstream.readBits(16);
	const BYTES_UNTIL_END_OF_PES_PACKET_LENGTH = 6;

	bitstream.skipBits(16);
	const pesHeaderDataLength = bitstream.readBits(8);
	const pesHeaderEndPos = bitstream.pos + 8 * pesHeaderDataLength;

	bitstream.pos = pesHeaderEndPos;

	const bytePos = pesHeaderEndPos / 8;
	assert(Number.isInteger(bytePos));

	let data = section.payload.subarray(
		bytePos,
		// "A value of 0 indicates that the PES packet length is neither specified nor bounded and is allowed only in
		// PES packets whose payload consists of bytes from a video elementary stream contained in
		// transport stream packets."
		pesPacketLength > 0
			? BYTES_UNTIL_END_OF_PES_PACKET_LENGTH + pesPacketLength
			: section.payload.byteLength,
	);

	let holes = NO_HOLES;
	if (section.firstPacketHasErrors) {
		data = new Uint8Array(0);
		holes = [0];
	} else if (
		section.holes.length > 0
		// A PES packet that has all the data it says it has is only off in its continuity counters
		&& !(
			pesPacketLength > 0
			&& section.payload.byteLength >= BYTES_UNTIL_END_OF_PES_PACKET_LENGTH + pesPacketLength
		)
	) {
		const offsets: number[] = [];
		for (const hole of section.holes) {
			const offset = Math.min(Math.max(hole - bytePos, 0), data.byteLength);
			if (offsets.at(-1) !== offset) {
				offsets.push(offset);
			}
		}
		holes = offsets;
	}

	return {
		...header,
		data,
		holes,
		cutAtEnd: section.cutAtEnd,
	};
};

abstract class MpegTsTrackBacking implements InputTrackBacking {
	packetBuffers = new WeakMap<EncodedPacket, PacketBuffer>();
	/** Used for recreating PacketBuffers if necessary. */
	packetSectionStarts = new WeakMap<EncodedPacket, number>();
	frameDuration: Promise<number> | null = null;
	firstTimedPesPacket: Promise<{ header: TimestampedPesPacketHeader; section: Section } | null> | null = null;

	constructor(public elementaryStream: ElementaryStream) {}

	abstract getType(): TrackType;
	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;

	getId() {
		return this.elementaryStream.pid;
	}

	getNumber() {
		const demuxer = this.elementaryStream.demuxer;
		const trackType = this.elementaryStream.info.type;

		let number = 0;
		for (const backing of demuxer.trackBackingEntries) {
			if (backing.getType() === trackType) {
				number++;
			}

			assert(backing instanceof MpegTsTrackBacking);
			if (backing.elementaryStream === this.elementaryStream) {
				break;
			}
		}

		return number;
	}

	getCodec(): MediaCodec | null {
		throw new Error('Not implemented on base class.');
	}

	getInternalCodecId() {
		return this.elementaryStream.streamType;
	}

	getName() {
		return null;
	}

	getLanguageCode() {
		return this.elementaryStream.languageCode;
	}

	getDisposition(): TrackDisposition {
		return {
			...DEFAULT_TRACK_DISPOSITION,
			primary: false,
			// audio_type values per ISO/IEC 13818-1, mapped like FFmpeg does
			hearingImpaired: this.elementaryStream.audioType === 0x02,
			visuallyImpaired: this.elementaryStream.audioType === 0x03,
		};
	}

	getTimeResolution() {
		return MPEG_TS_TIMESCALE;
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
		return null;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	abstract allPacketsAreKeyPackets(): boolean;
	abstract getReorderSize(): number;
	abstract getReorderFrameCount(): number;

	/**
	 * Returns the time between frames, as the median gap between the timestamps of the track's first packets. Since it
	 * doesn't depend on where reading started, it gives packets without a successor the same duration however they
	 * were reached.
	 */
	getFrameDuration() {
		return this.frameDuration ??= (async () => {
			const firstSection = this.elementaryStream.firstSection;
			assert(firstSection);
			const pesPacket = readPesPacket(this.elementaryStream.demuxer, firstSection);
			assert(pesPacket);

			// The packets' timestamps (frames may share a PES packet or come without a PTS), enough to see every
			// frame of a reordering window in presentation order, and not to be thrown off by a few irregular frames
			// at the start
			const buffer = new PacketBuffer(this, new PacketReadingContext(this.elementaryStream, pesPacket));
			const packetCount = Math.max(2 * (this.getReorderSize() + 1) + 2, MIN_FRAME_DURATION_PTS_COUNT);
			while (buffer.decodeOrderPackets.length < packetCount) {
				if (!(await buffer.readNextPacket())) {
					break;
				}
			}

			const ptsValues = buffer.decodeOrderPackets.map(x => x.pts).sort((a, b) => a - b);

			const gaps: number[] = [];
			for (let i = 1; i < ptsValues.length; i++) {
				const gap = ptsValues[i]! - ptsValues[i - 1]!;
				if (gap > 0) {
					gaps.push(gap);
				}
			}

			// The median, since frames the window ends before (reordering) make a few gaps too long, and variable frame
			// rates make some too short
			gaps.sort((a, b) => a - b);
			return gaps[Math.floor((gaps.length - 1) / 2)] ?? 0;
		})();
	}

	createEncodedPacket(
		suppliedPacket: TimedSuppliedPacket,
		duration: number,
		options: PacketRetrievalOptions,
	) {
		let packetType: PacketType;

		if (this.allPacketsAreKeyPackets()) {
			packetType = 'key';
		} else {
			packetType = suppliedPacket.randomAccessIndicator === 1
				? 'key'
				: 'delta';
		}

		return new EncodedPacket(
			options.metadataOnly ? PLACEHOLDER_DATA : suppliedPacket.data,
			packetType,
			suppliedPacket.pts / MPEG_TS_TIMESCALE,
			Math.max(duration / MPEG_TS_TIMESCALE, 0),
			suppliedPacket.sequenceNumber,
			suppliedPacket.data.byteLength,
		);
	}

	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const section = this.elementaryStream.firstSection;
		assert(section);

		const pesPacket = readPesPacket(this.elementaryStream.demuxer, section);
		assert(pesPacket);

		const context = new PacketReadingContext(this.elementaryStream, pesPacket);
		const buffer = new PacketBuffer(this, context);

		const result = await buffer.readNext();
		if (!result) {
			return null;
		}

		const packet = this.createEncodedPacket(result.packet, result.duration, options);
		this.packetBuffers.set(packet, buffer);
		this.packetSectionStarts.set(packet, result.packet.sectionStartPos);

		return packet;
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		let buffer = this.packetBuffers.get(packet);

		if (buffer) {
			// Remove PacketBuffer access from the old packet, it belongs to the next packet now. Remove it before any
			// async to prevent races
			this.packetBuffers.delete(packet);

			const result = await buffer.readNext();
			if (!result) {
				return null;
			}

			const newPacket = this.createEncodedPacket(result.packet, result.duration, options);
			this.packetBuffers.set(newPacket, buffer);
			this.packetSectionStarts.set(newPacket, result.packet.sectionStartPos);

			return newPacket;
		}

		// No buffer, we gotta do some rereading
		const sectionStartPos = this.packetSectionStarts.get(packet);
		if (sectionStartPos === undefined) {
			throw new Error('Packet was not created from this track.');
		}

		const demuxer = this.elementaryStream.demuxer;
		const isAudio = this.elementaryStream.info.type === 'audio';

		// Packets without a PTS of their own get theirs from the PES packets with one before (and after) them, so
		// start reading from there. Audio continues from the current packet instead, see below.
		const startPos = isAudio ? sectionStartPos : await this.findTimedPesPacketBefore(sectionStartPos, 2);
		const section = await demuxer.readSection(startPos, true);
		assert(section);

		const pesPacket = readPesPacket(demuxer, section);
		assert(pesPacket);

		const context = new PacketReadingContext(this.elementaryStream, pesPacket);

		if (isAudio) {
			// The PES packet may begin with the end of a frame that started in the previous one, and a fresh search
			// for a sync word can mistake bytes in there for a frame header. But we know where the current packet
			// starts and what its timestamp is, so let's continue reading from right there.
			const offset = packet.sequenceNumber - sectionStartPos;
			let remaining = context.ensureBuffered(offset + 1);
			if (isThenable(remaining)) {
				remaining = await remaining;
			}

			if (remaining > offset) {
				context.seekTo(offset);
				context.lastPtsSectionStartPos = sectionStartPos;
				context.nextPts = Math.round(packet.timestamp * MPEG_TS_TIMESCALE);
			}
		}

		buffer = new PacketBuffer(this, context);

		// Advance until we pass the current packet's sequence number
		const targetSequenceNumber = packet.sequenceNumber;
		while (true) {
			const result = await buffer.readNext();
			if (!result) {
				return null;
			}

			if (result.packet.sequenceNumber > targetSequenceNumber) {
				// We found the next packet!
				const newPacket = this.createEncodedPacket(result.packet, result.duration, options);
				this.packetBuffers.set(newPacket, buffer);
				this.packetSectionStarts.set(newPacket, result.packet.sectionStartPos);
				return newPacket;
			}
		}
	}

	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		let currentPacket: EncodedPacket | null = packet;

		// Just loop until we hit one
		while (true) {
			currentPacket = await this.getNextPacket(currentPacket, options);

			if (!currentPacket) {
				return null;
			}

			if (currentPacket.type === 'key') {
				return currentPacket;
			}
		}
	}

	/** Finds the track's first PES packet that has a PTS, since the first ones may come without one. */
	getFirstTimedPesPacket() {
		return this.firstTimedPesPacket ??= (async () => {
			const demuxer = this.elementaryStream.demuxer;
			const firstSection = this.elementaryStream.firstSection;
			assert(firstSection);

			let currentPos = firstSection.startPos;
			while (true) {
				const packetHeader = await demuxer.readPacketHeader(currentPos);
				if (!packetHeader) {
					return null;
				}

				if (packetHeader.pid === this.elementaryStream.pid && packetHeader.payloadUnitStartIndicator === 1) {
					const section = currentPos === firstSection.startPos
						? firstSection
						: await demuxer.readSection(currentPos, true);
					const header = section && readPesPacketHeader(demuxer, section);
					if (section && header && header.pts !== null) {
						return { header: header as TimestampedPesPacketHeader, section };
					}
				}

				currentPos += demuxer.packetStride;
			}
		})();
	}

	/**
	 * Returns the position of the `count`-th PES packet with a PTS at or before the given one, but not before the start
	 * of the track.
	 */
	async findTimedPesPacketBefore(pos: number, count: number) {
		const demuxer = this.elementaryStream.demuxer;
		const firstSection = this.elementaryStream.firstSection;
		assert(firstSection);

		for (let currentPos = pos; currentPos > firstSection.startPos; currentPos -= demuxer.packetStride) {
			const packetHeader = await demuxer.readPacketHeader(currentPos);
			assert(packetHeader);

			if (packetHeader.pid === this.elementaryStream.pid && packetHeader.payloadUnitStartIndicator === 1) {
				const section = await demuxer.readSection(currentPos, false);
				const header = section && readPesPacketHeader(demuxer, section);
				if (header && header.pts !== null && --count === 0) {
					return currentPos;
				}
			}
		}

		return firstSection.startPos;
	}

	getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.doPacketLookup(timestamp, false, options);
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.doPacketLookup(timestamp, true, options);
	}

	/**
	 * Searches for the packet with the largest timestamp not larger than `timestamp` in the file, using a combination
	 * of chunk-based binary search and linear refinement. The reason the coarse search is done in large chunks is to
	 * make it more performant for small files and over high-latency readers such as the network.
	 */
	async doPacketLookup(
		timestamp: number,
		keyframesOnly: boolean,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		const searchPts = roundIfAlmostInteger(timestamp * MPEG_TS_TIMESCALE);

		const demuxer = this.elementaryStream.demuxer;
		const { reader, seekChunkSize } = demuxer;
		const pid = this.elementaryStream.pid;

		const findFirstPesPacketHeaderInChunk = async (
			startPos: number,
			endPos: number,
			readSectionInFull: boolean,
		) => {
			let currentPos = startPos;

			while (true) {
				const pos = await demuxer.findNextPacket(pid, currentPos, endPos);
				if (pos === null) {
					return null;
				}

				const section = await demuxer.readSection(pos, readSectionInFull);
				if (!section) {
					return null;
				}

				const pesPacketHeader = readPesPacketHeader(demuxer, section);
				if (pesPacketHeader && pesPacketHeader.pts !== null) {
					return {
						pesPacketHeader: pesPacketHeader as TimestampedPesPacketHeader,
						section,
					};
				}

				currentPos = pos + demuxer.packetStride;
			}
		};

		// Get the first PES packet of the track that has a PTS
		const firstSection = this.elementaryStream.firstSection;
		assert(firstSection);
		const firstTimedPesPacket = await this.getFirstTimedPesPacket();

		const keyPacketsOnly = keyframesOnly && !this.allPacketsAreKeyPackets();
		const isTargetPacket = (packet: TimedSuppliedPacket) => {
			return packet.pts <= searchPts && (!keyPacketsOnly || packet.randomAccessIndicator === 1);
		};

		// What the last retrieveEncodedPacket call found: the packet's pts, the next pts in presentation order (if
		// read), and the smallest interval between the packets read
		let lastRetrieval = null as { pts: number; nextPts: number | null; minInterval: number } | null;

		const retrieveEncodedPacket = async (
			sectionStartPos: number,
			predicate: (packet: TimedSuppliedPacket) => boolean,
			// Whether to also read the packets that share searchPts with the first one reaching it. Data of another
			// access unit that begins a PES packet takes that PES packet's PTS too, ahead of the key frame.
			readPacketsAtSearchPts = false,
		) => {
			if (!firstTimedPesPacket || sectionStartPos === firstTimedPesPacket.header.sectionStartPos) {
				// The packets before the track's first PES packet with a PTS take their timestamps from it, so read
				// those as well
				sectionStartPos = firstSection.startPos;
			}

			// Load the relevant section in full
			const section = await demuxer.readSection(sectionStartPos, true);
			assert(section);

			const pesPacket = readPesPacket(demuxer, section);
			assert(pesPacket);

			const context = new PacketReadingContext(this.elementaryStream, pesPacket);
			const buffer = new PacketBuffer(this, context);

			// Advance until the top-most presentation timestamp crosses or equals searchPts
			while (true) {
				const topPts = last(buffer.presentationOrderPackets)?.pts ?? -Infinity;
				if (readPacketsAtSearchPts ? topPts > searchPts : topPts >= searchPts) {
					break;
				}

				const didRead = await buffer.readNextPacket();
				if (!didRead) {
					break;
				}
			}

			const targetIndex = findLastIndex(buffer.presentationOrderPackets, predicate);
			if (targetIndex === -1) {
				return null;
			}

			const targetPacket = buffer.presentationOrderPackets[targetIndex]!;
			let minInterval = Infinity;
			for (let i = 1; i < buffer.presentationOrderPackets.length; i++) {
				const interval = buffer.presentationOrderPackets[i]!.pts - buffer.presentationOrderPackets[i - 1]!.pts;
				if (interval > 0) {
					minInterval = Math.min(minInterval, interval);
				}
			}
			lastRetrieval = {
				pts: targetPacket.pts,
				nextPts: buffer.presentationOrderPackets[targetIndex + 1]?.pts ?? null,
				minInterval,
			};

			const lastDuration = targetIndex === 0
				? 0
				: targetPacket.pts - buffer.presentationOrderPackets[targetIndex - 1]!.pts;

			// Pop packets in decode order until we hit the target packet
			buffer.decodeOrderPackets.splice(0, buffer.decodeOrderPackets.indexOf(targetPacket));
			buffer.lastDuration = lastDuration; // Kinda ugly but necessary fix

			const result = await buffer.readNext();
			assert(result);

			const packet = this.createEncodedPacket(result.packet, result.duration, options);
			this.packetBuffers.set(packet, buffer);
			this.packetSectionStarts.set(packet, result.packet.sectionStartPos);

			return packet;
		};

		if (!firstTimedPesPacket || searchPts < firstTimedPesPacket.header.pts) {
			// Only packets right at the start of the track can come this early: those before the first PES packet with
			// a PTS, and leading frames decoded after it but presented before it (open GOPs), so read from there
			return retrieveEncodedPacket(firstSection.startPos, isTargetPacket);
		}

		const firstPesPacketHeader = firstTimedPesPacket.header;

		// Finds the PES packet with a PTS that comes before the given one, never before the track's first PES packet
		// with a PTS
		const findPreviousTimestampedPesPacketHeader = async (pesPacketHeader: TimestampedPesPacketHeader) => {
			const readSectionsInFull = !this.elementaryStream.canBeTrustedWithKeyPackets;
			let pos = pesPacketHeader.sectionStartPos - demuxer.packetStride;

			while (pos >= firstPesPacketHeader.sectionStartPos) {
				const packetHeader = await demuxer.readPacketHeader(pos);
				if (!packetHeader) {
					return null;
				}

				if (packetHeader.pid === pid && packetHeader.payloadUnitStartIndicator === 1) {
					const section = await demuxer.readSection(pos, readSectionsInFull);
					if (section) {
						const header = readPesPacketHeader(demuxer, section);
						if (header && header.pts !== null) {
							return header as TimestampedPesPacketHeader;
						}
					}
				}

				pos -= demuxer.packetStride;
			}

			return null;
		};

		let scanStartPos: number;

		const referencePesPackets = this.elementaryStream.referencePesPackets;
		const referencePointIndex = binarySearchLessOrEqual(referencePesPackets, searchPts, x => x.pts);
		const referencePoint = referencePointIndex !== -1 ? referencePesPackets[referencePointIndex]! : null;
		if (referencePoint && searchPts - referencePoint.pts < MPEG_TS_TIMESCALE / 2) {
			// Reference point ain't too far away, prefer it over the chunk search
			scanStartPos = referencePoint.sectionStartPos;
		} else {
			let startChunkIndex = 0;

			if (reader.fileSize !== null) {
				const numChunks = Math.ceil(reader.fileSize / seekChunkSize);

				if (numChunks > 1) {
					// Binary search to find the chunk with highest index whose first PES has pts <= searchPts
					let low = 0;
					let high = numChunks - 1;
					startChunkIndex = low;

					while (low <= high) {
						const mid = Math.floor((low + high) / 2);
						const chunkStartPos = floorToMultiple(mid * seekChunkSize, demuxer.packetStride)
							+ firstPesPacketHeader.sectionStartPos;
						const chunkEndPos = chunkStartPos + seekChunkSize;

						const result = await findFirstPesPacketHeaderInChunk(chunkStartPos, chunkEndPos, false);

						if (!result) {
							// No PES packet found in this chunk, search left
							high = mid - 1;
							continue;
						}

						if (result.pesPacketHeader.pts <= searchPts) {
							// This chunk's first PES is <= searchPts, it's a candidate
							startChunkIndex = mid;
							low = mid + 1; // Search right
						} else {
							// Search left
							high = mid - 1;
						}
					}
				}
			}

			scanStartPos = floorToMultiple(
				startChunkIndex * seekChunkSize,
				demuxer.packetStride,
			) + firstPesPacketHeader.sectionStartPos;
		}

		// Find the first PES packet at or after scanStartPos
		const result = await findFirstPesPacketHeaderInChunk(
			scanStartPos,
			reader.fileSize ?? Infinity,
			false,
		);

		let currentPesHeader = result?.pesPacketHeader ?? null;
		if (!currentPesHeader) {
			// Fall back to first packet
			currentPesHeader = firstPesPacketHeader;
		}

		const reorderSize = this.getReorderSize();

		if (!keyframesOnly || this.allPacketsAreKeyPackets()) {
			// Normat packet lookup case. Slightly easier since we just need to search (mostly) forward to find the
			// packet.

			// Linear scan to find the PES packet with largest pts <= searchPts. This will be used as the "midpoint"
			// of the next refinement step (which is needed because of B-frames).
			outer:
			while (true) {
				let currentPos = currentPesHeader.sectionStartPos + demuxer.packetStride;

				while (true) {
					const pos = await demuxer.findNextPacket(pid, currentPos);
					if (pos === null) {
						break outer; // End of the stream
					}

					const section = await demuxer.readSection(pos, false);
					if (section) {
						const nextPesHeader = readPesPacketHeader(demuxer, section);
						if (nextPesHeader && nextPesHeader.pts !== null) {
							if (nextPesHeader.pts > searchPts) {
								break outer;
							}

							currentPesHeader = nextPesHeader as TimestampedPesPacketHeader;
							maybeInsertReferencePacket(this.elementaryStream, currentPesHeader);

							break;
						}
					}

					currentPos = pos + demuxer.packetStride;
				}
			}

			// Rewind by reorderSize + 1 PES packets (even for audio! To ensure proper durations), but never past the
			// track's first PES packet, since anything before it isn't part of the track
			let windowStart = currentPesHeader;
			const visitedPts = [windowStart.pts];
			const rewindByOnePesPacket = async () => {
				let pos = windowStart.sectionStartPos - demuxer.packetStride;

				while (pos >= firstSection.startPos) {
					const packetHeader = await demuxer.readPacketHeader(pos);
					if (!packetHeader) {
						return false;
					}

					if (packetHeader.pid === pid && packetHeader.payloadUnitStartIndicator === 1) {
						const section = await demuxer.readSection(pos, false);
						const header = section && readPesPacketHeader(demuxer, section);
						if (header && header.pts !== null) {
							windowStart = header as TimestampedPesPacketHeader;
							visitedPts.push(windowStart.pts);
							return true;
						}
					}

					pos -= demuxer.packetStride;
				}

				return false; // We've hit the track's first PES packet, there's nothing more to rewind
			};

			// Inside a stretch of dropped video packets, the packet we're looking for comes before it, and so does the
			// window to rewind by, since the packets in the stretch don't count
			const rewindOutOfDroppedRange = async () => {
				const startPos = windowStart.sectionStartPos;
				const droppedRange = this.elementaryStream.droppedRanges.find(
					x => x.start <= startPos && startPos < x.end,
				);
				if (!droppedRange) {
					return false;
				}

				while (windowStart.sectionStartPos > droppedRange.start) {
					if (!await rewindByOnePesPacket()) {
						break;
					}
				}

				return true;
			};
			const rewindByWindow = async () => {
				for (let i = 0; i < reorderSize + 1; i++) {
					if (!await rewindByOnePesPacket()) {
						break;
					}
				}
			};

			await rewindOutOfDroppedRange();
			await rewindByWindow();
			while (await rewindOutOfDroppedRange()) {
				const rewoundFrom = windowStart.sectionStartPos;
				await rewindByWindow();
				if (windowStart.sectionStartPos === rewoundFrom) {
					break; // The start of the track
				}
			}

			let packet = await retrieveEncodedPacket(windowStart.sectionStartPos, isTargetPacket);

			// A P/I frame followed in decode order by a run of B-frames longer than that is presented after them all,
			// so it can come before the packets read. When the packet found isn't right at searchPts and the next one
			// is unknown or further away than any two packets read (a frame may be missing in between), rewind further
			// while the stream's signaled reorder depth doesn't rule out such an earlier packet.
			const reorderFrameCount = this.getReorderFrameCount();
			const retrieval = lastRetrieval;
			if (
				packet
				&& retrieval
				&& reorderFrameCount >= 0
				&& retrieval.pts !== searchPts
				&& (retrieval.nextPts === null || retrieval.nextPts - retrieval.pts > retrieval.minInterval)
			) {
				let rewound = false;
				for (let i = 0; i < MAX_CONSECUTIVE_B_FRAMES; i++) {
					if (
						lookupWindowIsComplete(visitedPts, searchPts, reorderFrameCount)
						|| !await rewindByOnePesPacket()
					) {
						break;
					}

					rewound = true;
				}

				if (rewound) {
					packet = await retrieveEncodedPacket(windowStart.sectionStartPos, isTargetPacket);
				}
			}

			return packet;
		} else {
			// Key packet lookup case. Slightly harder since the starting chunk may not have a key packet at all, which
			// means we might need to search the previous chunks until we find something.

			let currentChunkStartPos = scanStartPos;
			let nextChunkStartPos: number | null = null; // "next" as in later in the file, even tho we scan backwards

			// Captured once, since reading packets can revoke the trust while we're searching
			const trustKeyPackets = this.elementaryStream.canBeTrustedWithKeyPackets;
			const readSectionsInFull = !trustKeyPackets;

			while (true) {
				let bestKeyPesHeader: TimestampedPesPacketHeader | null = null;

				const isFirstChunk = currentChunkStartPos <= firstPesPacketHeader.sectionStartPos;

				let pesHeader: TimestampedPesPacketHeader | null;
				let pesHeaderSection: Section | null = null;

				if (isFirstChunk) {
					pesHeader = firstPesPacketHeader;
					pesHeaderSection = firstTimedPesPacket.section;
				} else {
					const result = await findFirstPesPacketHeaderInChunk(
						currentChunkStartPos,
						nextChunkStartPos ?? reader.fileSize ?? Infinity,
						readSectionsInFull,
					);

					pesHeader = result?.pesPacketHeader ?? null;
					pesHeaderSection = result?.section ?? null;
				}

				let passedSearchPts = false;
				let lookaheadCount = 0;
				let context: PacketReadingContext | null = null; // Walks the chunk's packets in order

				outer:
				while (pesHeader) {
					if (nextChunkStartPos !== null && pesHeader.sectionStartPos >= nextChunkStartPos) {
						// Stop at the next chunk boundary
						break;
					}

					if (pesHeader.pts <= searchPts) {
						let isKeyPacket: boolean;
						if (trustKeyPackets) {
							isKeyPacket = pesHeader.randomAccessIndicator === 1;
						} else {
							if (!context) {
								assert(pesHeaderSection);
								const pesPacket = readPesPacket(demuxer, pesHeaderSection);
								assert(pesPacket);

								context = new PacketReadingContext(this.elementaryStream, pesPacket);
							}

							// Advance to the packet that takes its timestamp from this PES packet
							while (
								!context.suppliedPacket
								|| (context.suppliedPacket.ptsSectionStartPos ?? context.suppliedPacket.sectionStartPos)
								< pesHeader.sectionStartPos
							) {
								context.suppliedPacket = null;
								await context.markNextPacket();

								if (!context.suppliedPacket) {
									break;
								}
							}

							// Any packet starting in this PES packet, or taking its timestamp from it, may be the key
							// frame: the PES packet may begin with data of another access unit, and the key frame may
							// begin before it (parameter sets in a PES packet of their own)
							isKeyPacket = false;
							while (
								context.suppliedPacket
								&& (
									context.suppliedPacket.sectionStartPos === pesHeader.sectionStartPos
									|| context.suppliedPacket.ptsSectionStartPos === pesHeader.sectionStartPos
								)
							) {
								if (context.suppliedPacket.randomAccessIndicator === 1) {
									isKeyPacket = true;
									break;
								}

								context.suppliedPacket = null;
								await context.markNextPacket();
							}
						}

						if (isKeyPacket) {
							bestKeyPesHeader = pesHeader;
						}
					}

					if (pesHeader.pts > searchPts) {
						passedSearchPts = true;
					}

					// If we've passed searchPts, do lookahead for reorderSize more packets just to be sure
					if (passedSearchPts) {
						lookaheadCount++;

						if (lookaheadCount > reorderSize) {
							break;
						}
					}

					// Find next PES packet
					let currentPos = pesHeader.sectionStartPos + demuxer.packetStride;

					while (true) {
						const pos = await demuxer.findNextPacket(pid, currentPos);
						if (pos === null) {
							break outer; // End of the stream
						}

						const section = await demuxer.readSection(pos, readSectionsInFull);
						if (section) {
							const nextPesHeader = readPesPacketHeader(demuxer, section);

							if (nextPesHeader && nextPesHeader.pts !== null) {
								pesHeader = nextPesHeader as TimestampedPesPacketHeader;
								pesHeaderSection = section;
								maybeInsertReferencePacket(this.elementaryStream, pesHeader);

								break;
							}
						}

						currentPos = pos + demuxer.packetStride;
					}
				}

				if (bestKeyPesHeader) {
					// The key frame's access unit may be split over any number of PES packets, which all have its PTS
					// (when the parameter sets come in PES packets of their own, say), so let's start reading at the
					// first of them; only it may carry the random access flag. Then one more PES packet with a PTS:
					// packets without a PTS may need the time between the two to get theirs. Each step goes back in
					// the file and stops at the track's first PES packet with a PTS, so this ends. At the end of the
					// stream, rewind a little more to obtain the correct packet duration.
					let startPesHeader = bestKeyPesHeader;
					let extraRewindCount = 1 + (lookaheadCount === 0 ? reorderSize : 0);
					while (true) {
						const previous = await findPreviousTimestampedPesPacketHeader(startPesHeader);
						if (!previous) {
							break;
						}

						if (previous.pts === bestKeyPesHeader.pts) {
							startPesHeader = previous;
						} else if (extraRewindCount > 0) {
							startPesHeader = previous;
							extraRewindCount--;
						} else {
							break;
						}
					}

					const encodedPacket = await retrieveEncodedPacket(
						startPesHeader.sectionStartPos,
						isTargetPacket,
						true,
					);
					if (encodedPacket) {
						return encodedPacket;
					} else if (trustKeyPackets && !this.elementaryStream.canBeTrustedWithKeyPackets) {
						// The candidate wasn't a key frame after all, so random_access_indicator can't be trusted.
						// Start over using the bitstream.
						return this.doPacketLookup(timestamp, keyframesOnly, options);
					} else {
						// The key packet didn't materialize (can happen with odd packetization where packets take their
						// timestamp from a later PES packet), so let's keep looking further back
					}
				}

				if (isFirstChunk) {
					// Maybe there's a key packet among those before the first PES packet with a PTS
					return firstSection.startPos < firstPesPacketHeader.sectionStartPos
						? retrieveEncodedPacket(firstSection.startPos, isTargetPacket)
						: null;
				}

				// No key frame found in this chunk, move one chunk to the left
				nextChunkStartPos = currentChunkStartPos;
				currentChunkStartPos = Math.max(
					floorToMultiple(
						currentChunkStartPos - firstPesPacketHeader.sectionStartPos - seekChunkSize,
						demuxer.packetStride,
					) + firstPesPacketHeader.sectionStartPos,
					firstPesPacketHeader.sectionStartPos,
				);
			}
		}
	}
}

class MpegTsVideoTrackBacking extends MpegTsTrackBacking implements InputVideoTrackBacking {
	declare elementaryStream: ElementaryVideoStream;

	getType() {
		return 'video' as const;
	}

	override getCodec(): VideoCodec {
		return this.elementaryStream.info.codec;
	}

	getCodedWidth() {
		return this.elementaryStream.info.width;
	}

	getCodedHeight() {
		return this.elementaryStream.info.height;
	}

	getSquarePixelWidth() {
		return this.elementaryStream.info.squarePixelWidth;
	}

	getSquarePixelHeight() {
		return this.elementaryStream.info.squarePixelHeight;
	}

	getPixelAspectRatio() {
		return this.elementaryStream.info.pixelAspectRatio;
	}

	getTransformationMatrix(): TransformationMatrix {
		return [...IDENTITY_MATRIX];
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return this.elementaryStream.info.colorSpace;
	}

	async canBeTransparent() {
		return false;
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig> {
		assert(this.elementaryStream.info.decoderConfig);
		return this.elementaryStream.info.decoderConfig;
	}

	override allPacketsAreKeyPackets(): boolean {
		return false;
	}

	override getReorderSize(): number {
		return this.elementaryStream.info.reorderSize;
	}

	override getReorderFrameCount(): number {
		return this.elementaryStream.info.reorderFrameCount;
	}
}

class MpegTsAudioTrackBacking extends MpegTsTrackBacking implements InputAudioTrackBacking {
	declare elementaryStream: ElementaryAudioStream;

	getType() {
		return 'audio' as const;
	}

	override getCodec(): AudioCodec {
		return this.elementaryStream.info.codec;
	}

	getNumberOfChannels() {
		return this.elementaryStream.info.numberOfChannels;
	}

	getSampleRate() {
		return this.elementaryStream.info.sampleRate;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig> {
		assert(this.elementaryStream.info.decoderConfig);
		return this.elementaryStream.info.decoderConfig;
	}

	override allPacketsAreKeyPackets(): boolean {
		return true;
	}

	override getReorderSize(): number {
		return 0; // No reordering, since no B-frames because goated
	}

	override getReorderFrameCount(): number {
		return 0;
	}
}

const maybeInsertReferencePacket = (
	elementaryStream: ElementaryStream,
	pesPacketHeader: TimestampedPesPacketHeader,
) => {
	const referencePesPackets = elementaryStream.referencePesPackets;

	const index = binarySearchLessOrEqual(
		referencePesPackets,
		pesPacketHeader.sectionStartPos,
		x => x.sectionStartPos,
	);
	if (index >= 0) {
		// Since pts and file position don't necessarily have a monotonic relationship (since pts can go crazy),
		// let's see if inserting at the given index would violate the pts order. If so, return.
		const entry = referencePesPackets[index]!;
		if (pesPacketHeader.pts <= entry.pts) {
			return false;
		}

		const minByteDistance = elementaryStream.demuxer.minReferencePointByteDistance;

		if (pesPacketHeader.sectionStartPos - entry.sectionStartPos < minByteDistance) {
			// Too close
			return false;
		}

		if (index < referencePesPackets.length - 1) {
			const nextEntry = referencePesPackets[index + 1]!;
			if (nextEntry.pts < pesPacketHeader.pts) {
				// Out of order
				return false;
			}

			if (nextEntry.sectionStartPos - pesPacketHeader.sectionStartPos < minByteDistance) {
				// Too close
				return false;
			}
		}
	}

	// Copy only the header fields (callers may pass a whole PES packet)
	referencePesPackets.splice(index + 1, 0, {
		sectionStartPos: pesPacketHeader.sectionStartPos,
		sectionEndPos: pesPacketHeader.sectionEndPos,
		pts: pesPacketHeader.pts,
		randomAccessIndicator: pesPacketHeader.randomAccessIndicator,
	});
	return true;
};

type SuppliedPacket = {
	/** null if the packet has no PTS of its own and none follows from the previous packet */
	pts: number | null;
	/** The packet's duration as given by the codec, or 0 */
	intrinsicDuration: number;
	data: Uint8Array;
	sequenceNumber: number;
	sectionStartPos: number;
	/** The section start of the PES packet whose PTS the packet took, if any */
	ptsSectionStartPos: number | null;
	randomAccessIndicator: number;
};

const RECOVERY_POINT_SEI_PAYLOAD_TYPE = 6; // The same in AVC and HEVC

/** Whether the access unit carries a recovery point SEI message, which marks a random access point. */
const containsRecoveryPointSei = (codec: VideoCodec, data: Uint8Array) => {
	for (const loc of iterateNalUnitsInAnnexB(data)) {
		const isSei = codec === 'avc'
			? extractNalUnitTypeForAvc(data[loc.offset]!) === AvcNalUnitType.SEI
			: extractNalUnitTypeForHevc(data[loc.offset]!) === HevcNalUnitType.PREFIX_SEI_NUT;
		if (!isSei) {
			continue;
		}

		const nalHeaderSize = codec === 'avc' ? 1 : 2;
		const nalUnitPayload = data.subarray(loc.offset + nalHeaderSize, loc.offset + loc.length);
		const bytes = removeEmulationPreventionBytes(nalUnitPayload);

		// sei_rbsp(): sei_message()s until the rbsp_trailing_bits
		let pos = 0;
		while (pos < bytes.length && !(pos === bytes.length - 1 && bytes[pos] === 0x80)) {
			let payloadType = 0;
			while (bytes[pos] === 0xff) {
				payloadType += 0xff;
				pos++;
			}
			payloadType += bytes[pos++] ?? 0;

			let payloadSize = 0;
			while (bytes[pos] === 0xff) {
				payloadSize += 0xff;
				pos++;
			}
			payloadSize += bytes[pos++] ?? 0;

			if (payloadType === RECOVERY_POINT_SEI_PAYLOAD_TYPE) {
				return true;
			}

			pos += payloadSize;
		}
	}

	return false;
};

type TimedSuppliedPacket = SuppliedPacket & {
	pts: number;
};

/** Stateful context used to extract exact encoded packets from the underlying data stream. */
class PacketReadingContext {
	elementaryStream: ElementaryStream;
	pid: number;
	demuxer: MpegTsDemuxer;
	startingPesPacket: PesPacket;

	currentPos = 0; // Relative to the data in startingPesPacket
	pesPackets: PesPacket[] = [];
	currentPesPacketIndex = 0;
	currentPesPacketPos = 0;
	endPos = 0;
	/** The section start of the last PES packet whose PTS a packet took */
	lastPtsSectionStartPos = -1;
	/** The start of the last PES packet in which an access unit began */
	lastAccessUnitSectionStartPos = -1;
	nextPts: number | null = null;
	/** Positions where data is missing, ascending */
	holes: number[] = [];
	/** Whether the last packet found was skipped since data is missing in it */
	skippedPacket = false;
	/** The stretch of video packets being dropped, up to the next key frame */
	droppedRange: { start: number; end: number } | null = null;

	suppliedPacket: SuppliedPacket | null = null;

	constructor(elementaryStream: ElementaryStream, startingPesPacket: PesPacket) {
		this.elementaryStream = elementaryStream;
		this.pid = elementaryStream.pid;
		this.demuxer = elementaryStream.demuxer;
		this.startingPesPacket = startingPesPacket;

		// Starting inside a stretch of dropped packets, like a lookup after a loss, keeps dropping them
		const startPos = startingPesPacket.sectionStartPos;
		this.droppedRange = elementaryStream.droppedRanges.find(x => x.start <= startPos && startPos < x.end) ?? null;
	}

	ensureBuffered(length: number) {
		const remaining = this.endPos - this.currentPos;
		if (remaining >= length) {
			return length;
		}

		return this.bufferData(length - remaining)
			.then(() => Math.min(this.endPos - this.currentPos, length));
	}

	getCurrentPesPacket() {
		const packet = this.pesPackets[this.currentPesPacketIndex];
		assert(packet);

		return packet;
	}

	async bufferData(length: number): Promise<void> {
		const targetEndPos = this.endPos + length;

		while (this.endPos < targetEndPos) {
			let pesPacket: PesPacket;
			if (this.pesPackets.length === 0) {
				pesPacket = this.startingPesPacket;
			} else {
				// Find the next PES packet
				let currentPos = last(this.pesPackets)!.sectionEndPos;
				assert(currentPos !== null);

				while (true) {
					// The next packet of the PID, whatever it is
					const pos = await this.demuxer.findNextPacket(this.pid, currentPos, Infinity, false);
					if (pos === null) {
						return;
					}

					const nextSection = await this.demuxer.readSection(pos, true);
					if (!nextSection) {
						return;
					}

					const nextPesPacket = readPesPacket(this.demuxer, nextSection);
					if (nextPesPacket) {
						pesPacket = nextPesPacket;
						break;
					}

					currentPos = pos + this.demuxer.packetStride;
				}
			}

			this.pesPackets.push(pesPacket);
			for (let i = 0; i < pesPacket.holes.length; i++) {
				this.holes.push(this.endPos + pesPacket.holes[i]!);
			}
			this.endPos += pesPacket.data.byteLength;
		}
	}

	readBytes(length: number) {
		const currentPesPacket = this.getCurrentPesPacket();

		const relativeStartOffset = this.currentPos - this.currentPesPacketPos;
		const relativeEndOffset = relativeStartOffset + length;

		this.currentPos += length;

		if (relativeEndOffset <= currentPesPacket.data.byteLength) {
			// Request can be satisfied with one PES packet
			return currentPesPacket.data.subarray(relativeStartOffset, relativeEndOffset);
		}

		// Data spans multiple PES packets, we must do some merging
		const result = new Uint8Array(length);
		result.set(currentPesPacket.data.subarray(relativeStartOffset));
		let offset = currentPesPacket.data.byteLength - relativeStartOffset;

		while (true) {
			this.advanceCurrentPacket();
			const currentPesPacket = this.getCurrentPesPacket();
			const relativeEndOffset = length - offset;

			if (relativeEndOffset <= currentPesPacket.data.byteLength) {
				result.set(currentPesPacket.data.subarray(0, relativeEndOffset), offset);
				break;
			}

			result.set(currentPesPacket.data, offset);
			offset += currentPesPacket.data.byteLength;
		}

		return result;
	}

	readU8() {
		let currentPesPacket = this.getCurrentPesPacket();

		const relativeOffset = this.currentPos - this.currentPesPacketPos;
		this.currentPos++;

		if (relativeOffset < currentPesPacket.data.byteLength) {
			return currentPesPacket.data[relativeOffset]!;
		}

		// Skip over PES packets without any data
		do {
			this.advanceCurrentPacket();
			currentPesPacket = this.getCurrentPesPacket();
		} while (currentPesPacket.data.byteLength === 0);

		return currentPesPacket.data[0]!;
	}

	seekTo(pos: number) {
		if (pos === this.currentPos) {
			return;
		}

		if (pos < this.currentPos) {
			while (pos < this.currentPesPacketPos) {
				// Move to the previous PES packet
				this.currentPesPacketIndex--;
				const currentPacket = this.getCurrentPesPacket();
				this.currentPesPacketPos -= currentPacket.data.byteLength;
			}
		} else {
			while (true) {
				// Move to the next PES packet
				const currentPesPacket = this.getCurrentPesPacket();
				const currentEndPos = this.currentPesPacketPos + currentPesPacket.data.byteLength;

				if (pos < currentEndPos) {
					break;
				}

				this.currentPesPacketPos += currentPesPacket.data.byteLength;
				this.currentPesPacketIndex++;
			}
		}

		this.currentPos = pos;
	}

	skip(n: number) {
		this.seekTo(this.currentPos + n);
	}

	advanceCurrentPacket() {
		this.currentPesPacketPos += this.getCurrentPesPacket().data.byteLength;
		this.currentPesPacketIndex++;
	}

	/** Returns the index of the buffered PES packet containing the given position, which mustn't lie ahead. */
	getPesPacketIndexAt(pos: number) {
		let index = this.currentPesPacketIndex;
		let pesPacketPos = this.currentPesPacketPos;
		while (index > 0 && pos < pesPacketPos) {
			index--;
			pesPacketPos -= this.pesPackets[index]!.data.byteLength;
		}

		return index;
	}

	/** Whether a PES packet with a PTS begins after the one containing `startPos`, up to the one holding `endPos`. */
	hasTimestampedPesPacketIn(startPos: number, endPos: number) {
		const endIndex = this.getPesPacketIndexAt(endPos);
		for (let i = this.getPesPacketIndexAt(startPos) + 1; i <= endIndex; i++) {
			if (this.pesPackets[i]!.pts !== null) {
				return true;
			}
		}

		return false;
	}

	/** Marks the next packet as the supplied packet, if there is one, skipping packets that miss data. */
	async markNextPacket() {
		do {
			this.skippedPacket = false;
			await this.findNextPacket();
		} while (this.skippedPacket);
	}

	async findNextPacket() {
		assert(!this.suppliedPacket);

		const elementaryStream = this.elementaryStream;

		if (elementaryStream.info.type === 'video') {
			// Our job here is to separate the video stream into access units. Sometimes this is easy (like when AUDs
			// are present), sometimes it's a little harder.

			const codec = elementaryStream.info.codec;
			const CHUNK_SIZE = 1024;

			if (codec !== 'avc' && codec !== 'hevc') {
				throw new Error('Unhandled.');
			}

			const nalHeaderSize = codec === 'avc' ? 1 : 2;
			let packetStartPos: number | null = null;
			let frameStartFound = false;
			let lastFirstMacroblockInSlice = 0;
			// Where the packet's access unit (its AUD) starts, and whether parameter sets come before it
			let accessUnitPos: number | null = null;
			let parameterSetFound = false;
			// Whether the packet's first slice doesn't begin its picture: the rest of a picture whose start lies before
			// where reading began (like at the start of a file cut from a longer stream)
			let isPictureRest = false;

			// Field-coded AVC (PAFF) codes the two fields of a frame as separate pictures, each with its own access
			// unit. Like MP4 samples, packets should hold whole frames, so we keep a complementary field pair together.
			const avcFieldCoding = elementaryStream.info.avcFieldCoding;
			// The current picture's field, as long as its second field may still follow
			let firstField: AvcSliceField | null = null;
			// Where the packet ends unless the next picture turns out to be the second field
			let pendingBoundaryPos: number | null = null;
			// Where the AUD beginning the second field's access unit ends, if it begins with one
			let pendingAudEndPos: number | null = null;
			let pendingBoundaryIsAud = false;
			// AUDs of second fields, which we leave out of the packet (Chromium's decoder workaround in the sink cuts a
			// packet at an AUD that follows picture data). Mediabunny's MPEG-TS muxer writes field pairs without them.
			const droppedRanges: { start: number; end: number }[] = [];

			while (true) {
				let remaining = this.ensureBuffered(CHUNK_SIZE);
				if (isThenable(remaining)) remaining = await remaining;

				if (remaining === 0) {
					break;
				}

				const chunkStartPos = this.currentPos;
				const chunk = this.readBytes(remaining);
				const length = chunk.byteLength;

				let i = 0;
				while (i < length) {
					const zeroIndex = chunk.indexOf(0, i);
					if (zeroIndex === -1 || zeroIndex >= length) {
						break;
					}
					i = zeroIndex;

					const posBeforeZero = chunkStartPos + i;

					// Need 3 more bytes after the 0x00 to recognize a start code prefix
					if (i + 3 >= length) {
						// Not enough data in current chunk, seek back and let the next iteration handle it
						this.seekTo(posBeforeZero);
						break;
					}

					const b1 = chunk[i + 1]!;
					const b2 = chunk[i + 2]!;
					const b3 = chunk[i + 3]!;

					let startCodeLength = 0;

					// Check for 4-byte start code (0x00000001)
					if (b1 === 0x00 && b2 === 0x00 && b3 === 0x01) {
						startCodeLength = 4;
					} else if (b1 === 0x00 && b2 === 0x01) {
						// 3-byte start code (0x000001)
						startCodeLength = 3;
					}

					if (startCodeLength === 0) {
						// Not a start code, continue
						i++;
						continue;
					}

					const startCodePos = posBeforeZero;

					// The packet only really begins at the first NAL unit; anything before it isn't usable
					packetStartPos ??= startCodePos;

					if (pendingBoundaryIsAud && pendingAudEndPos === null && startCodePos > pendingBoundaryPos!) {
						pendingAudEndPos = startCodePos;
					}

					const nalHeaderStart = i + startCodeLength;
					const payloadStart = nalHeaderStart + nalHeaderSize;

					// Bytes peeked from the start of a slice header to decode first_mb_in_slice. Six bytes (48 bits)
					// comfortably covers the exp-Golomb code for any realistic macroblock count
					const AVC_SLICE_HEADER_PEEK_SIZE = 6;

					// We read the NAL header plus, for slices, the start of the slice header to decode the
					// first_mb_in_slice / first_slice_segment_in_pic_flag (and the field). Make sure all of it is
					// buffered.
					const slicePeekSize = codec === 'avc'
						? (avcFieldCoding ? AVC_SLICE_FIELD_PEEK_SIZE : AVC_SLICE_HEADER_PEEK_SIZE)
						: 1;
					const bytesNeeded = payloadStart + slicePeekSize;
					if (bytesNeeded > length) {
						this.seekTo(posBeforeZero);
						break;
					}

					const headerByte0 = chunk[nalHeaderStart]!;

					let nalUnitType: number;
					let isSlice: boolean;
					let isAccessUnitStart: boolean;
					let isAccessUnitDelimiter: boolean;
					let isParameterSet: boolean;

					if (codec === 'avc') {
						nalUnitType = extractNalUnitTypeForAvc(headerByte0);
						isSlice = nalUnitType === AvcNalUnitType.NON_IDR_SLICE
							|| nalUnitType === AvcNalUnitType.SLICE_DPA
							|| nalUnitType === AvcNalUnitType.IDR;
						isAccessUnitStart = nalUnitType === AvcNalUnitType.SEI
							|| nalUnitType === AvcNalUnitType.SPS
							|| nalUnitType === AvcNalUnitType.PPS
							|| nalUnitType === AvcNalUnitType.AUD;
						isAccessUnitDelimiter = nalUnitType === AvcNalUnitType.AUD;
						isParameterSet = nalUnitType === AvcNalUnitType.SPS || nalUnitType === AvcNalUnitType.PPS;
					} else {
						nalUnitType = extractNalUnitTypeForHevc(headerByte0);
						const layerId = ((headerByte0 & 1) << 5) | (chunk[nalHeaderStart + 1]! >> 3);
						if (layerId > 0) {
							// Higher layers don't delimit the base-layer frames we care about
							i += startCodeLength;
							continue;
						}

						// VCL slices: 0..RASL_R, plus the IRAP range BLA_W_LP..CRA_NUT
						isSlice = nalUnitType <= HevcNalUnitType.RASL_R
							|| (nalUnitType >= HevcNalUnitType.BLA_W_LP && nalUnitType <= 21);
						// VPS..FD, prefix SEI, and the reserved/unspecified non-VCL ranges
						isAccessUnitStart = (nalUnitType >= HevcNalUnitType.VPS_NUT && nalUnitType <= 37)
							|| nalUnitType === HevcNalUnitType.PREFIX_SEI_NUT
							|| (nalUnitType >= 41 && nalUnitType <= 44)
							|| (nalUnitType >= 48 && nalUnitType <= 55);
						isAccessUnitDelimiter = nalUnitType === HevcNalUnitType.AUD_NUT;
						isParameterSet = nalUnitType >= HevcNalUnitType.VPS_NUT
							&& nalUnitType <= HevcNalUnitType.PPS_NUT;
					}

					let isFrameBoundary = false;

					if (isSlice) {
						let startsNewPicture: boolean;

						if (codec === 'avc') {
							const headerBytes = chunk.subarray(payloadStart, payloadStart + AVC_SLICE_HEADER_PEEK_SIZE);

							let firstMacroblockInSlice: number | null;
							try {
								firstMacroblockInSlice = readExpGolomb(new Bitstream(headerBytes));
							} catch {
								// A damaged slice header: more zeros than any first_mb_in_slice can start with
								firstMacroblockInSlice = null;
							}

							if (firstMacroblockInSlice === null) {
								// We can't tell if it begins a new picture, so let's keep it with the current one
								// instead of giving up on the rest of the stream
								startsNewPicture = !frameStartFound;
							} else {
								if (!frameStartFound) {
									isPictureRest = firstMacroblockInSlice > 0;
								}

								startsNewPicture = !frameStartFound
									|| firstMacroblockInSlice <= lastFirstMacroblockInSlice;
								lastFirstMacroblockInSlice = firstMacroblockInSlice;
							}

							if (startsNewPicture && avcFieldCoding) {
								const field = readAvcSliceField(
									chunk.subarray(payloadStart, payloadStart + AVC_SLICE_FIELD_PEEK_SIZE),
									avcFieldCoding,
								);

								if (!frameStartFound) {
									firstField = field;
								} else if (
									firstField
									&& field
									&& field.bottomField !== firstField.bottomField
									&& field.frameNum === firstField.frameNum
									// When the second field comes in a PES packet with its own PTS, it's timed and
									// looked up on its own, so it stays a packet of its own then
									&& !this.hasTimestampedPesPacketIn(
										packetStartPos,
										pendingBoundaryPos ?? startCodePos,
									)
								) {
									// The second field of the frame, so the packet goes on
									startsNewPicture = false;
									if (pendingBoundaryIsAud) {
										droppedRanges.push({
											start: pendingBoundaryPos!,
											end: pendingAudEndPos ?? startCodePos,
										});
									}
									firstField = null;
									pendingBoundaryPos = null;
									pendingAudEndPos = null;
									pendingBoundaryIsAud = false;
								}
							}
						} else {
							startsNewPicture = (chunk[payloadStart]! >> 7) === 1;
						}

						if (startsNewPicture) {
							if (frameStartFound) {
								isFrameBoundary = true;
							} else {
								frameStartFound = true;
							}
						}
					} else if (isAccessUnitStart && frameStartFound) {
						if (firstField) {
							// This might begin the second field; the next slice will tell
							if (pendingBoundaryPos === null) {
								pendingBoundaryPos = startCodePos;
								pendingBoundaryIsAud = isAccessUnitDelimiter;
							}
						} else {
							isFrameBoundary = true;
						}
					} else if (isAccessUnitDelimiter) {
						// An AUD always begins a new access unit. We haven't seen a slice yet, so whatever came before
						// it holds no picture; let's drop it. Parameter sets are kept though (some muxers put them in
						// a PES packet of their own, with an AUD after them), since the picture needs them.
						accessUnitPos = startCodePos;
						if (!parameterSetFound) {
							packetStartPos = startCodePos;
						}
					}

					parameterSetFound ||= isParameterSet && !frameStartFound;

					if (isFrameBoundary) {
						// End the packet at this start code (the next frame begins here). A picture without an AUD
						// that's followed by an access unit with one is in a stream that has AUDs, so its own AUD came
						// before where reading began (like in a segment cut from a longer stream).
						const packetLength = (pendingBoundaryPos ?? startCodePos) - packetStartPos;
						const endsAtAccessUnitDelimiter = pendingBoundaryPos !== null
							? pendingBoundaryIsAud
							: isAccessUnitDelimiter;
						const continuesAccessUnit = isPictureRest
							|| (accessUnitPos === null && endsAtAccessUnitDelimiter);
						this.seekTo(packetStartPos);
						return this.supplyPacket(packetLength, 0, accessUnitPos, continuesAccessUnit, droppedRanges);
					}

					i += startCodeLength;
				}

				if (remaining < CHUNK_SIZE) {
					// End of stream
					break;
				}
			}

			// End of stream - emit whatever's left as the final packet, unless it holds no picture or the file ends
			// inside it (a cut frame fails decoding, with WebCodecs at the final flush, which ends the whole run). A
			// first field whose second one didn't follow ends before the cut. While the stream is being set up, its
			// parameter sets are what counts, which a cut frame still has.
			if (
				frameStartFound
				&& (
					pendingBoundaryPos !== null
					|| !last(this.pesPackets)?.cutAtEnd
					|| !elementaryStream.info.decoderConfig
				)
			) {
				assert(packetStartPos !== null);

				const packetLength = (pendingBoundaryPos ?? this.endPos) - packetStartPos;
				this.seekTo(packetStartPos);
				return this.supplyPacket(packetLength, 0, accessUnitPos, isPictureRest, droppedRanges);
			}
		} else {
			const codec = elementaryStream.info.codec;
			const CHUNK_SIZE = 128;

			while (true) {
				let remaining = this.ensureBuffered(CHUNK_SIZE);
				if (isThenable(remaining)) remaining = await remaining;

				const startPos = this.currentPos;

				while (this.currentPos - startPos < remaining) {
					const byte = this.readU8();

					if (codec === 'aac') {
						if (byte !== 0xff) {
							continue;
						}

						this.skip(-1);
						const possibleHeaderStartPos = this.currentPos;

						let remaining = this.ensureBuffered(MAX_ADTS_FRAME_HEADER_SIZE);
						if (isThenable(remaining)) remaining = await remaining;

						if (remaining < MAX_ADTS_FRAME_HEADER_SIZE) {
							return;
						}

						const headerBytes = this.readBytes(MAX_ADTS_FRAME_HEADER_SIZE);
						const candidate = peekAdtsFrameHeader(headerBytes);

						const isFrameStart = candidate && await this.isFrameStart(
							possibleHeaderStartPos,
							candidate.frameLength,
							candidate.samplingFrequencyIndex,
							MIN_ADTS_FRAME_HEADER_SIZE,
							readAdtsSyncHeader,
						);
						// Throws for frames we don't support
						const header = isFrameStart ? readAdtsFrameHeader(FileSlice.tempFromBytes(headerBytes)) : null;

						if (header) {
							return this.supplyPacket(
								header.frameLength,
								Math.round(
									SAMPLES_PER_AAC_FRAME * MPEG_TS_TIMESCALE / elementaryStream.info.sampleRate,
								),
							);
						} else {
							this.seekTo(possibleHeaderStartPos + 1);
						}
					} else if (codec === 'mp3') {
						if (byte !== 0xff) {
							continue;
						}

						this.skip(-1);
						const possibleHeaderStartPos = this.currentPos;

						let remaining = this.ensureBuffered(MP3_FRAME_HEADER_SIZE);
						if (isThenable(remaining)) remaining = await remaining;

						if (remaining < MP3_FRAME_HEADER_SIZE) {
							return;
						}

						const headerBytes = this.readBytes(MP3_FRAME_HEADER_SIZE);
						const word = toDataView(headerBytes).getUint32(0);
						const result = readMp3FrameHeader(word, null);

						const header = result.header;
						if (
							header
							&& await this.isFrameStart(
								possibleHeaderStartPos,
								header.totalSize,
								header.sampleRate,
								MP3_FRAME_HEADER_SIZE,
								readMp3SyncHeader,
							)
						) {
							const duration = header.audioSamplesInFrame * MPEG_TS_TIMESCALE
								/ elementaryStream.info.sampleRate;
							return this.supplyPacket(header.totalSize, Math.round(duration));
						} else {
							this.seekTo(possibleHeaderStartPos + 1);
						}
					} else if (codec === 'ac3') {
						if (byte !== 0x0b) {
							continue;
						}

						this.skip(-1);
						const possibleSyncPos = this.currentPos;

						// Need at least 5 bytes for sync word + CRC + fscod/frmsizecod
						let remaining = this.ensureBuffered(5);
						if (isThenable(remaining)) remaining = await remaining;

						if (remaining < 5) {
							return;
						}

						const headerBytes = this.readBytes(5);

						// Verify sync word (0x0B77)
						if (headerBytes[0] !== 0x0b || headerBytes[1] !== 0x77) {
							this.seekTo(possibleSyncPos + 1);
							continue;
						}

						const fscod = headerBytes[4]! >> 6;
						const frmsizecod = headerBytes[4]! & 0x3f;

						if (fscod === 3 || frmsizecod > 37) {
							// Invalid
							this.seekTo(possibleSyncPos + 1);
							continue;
						}

						const frameSize = AC3_FRAME_SIZES[3 * frmsizecod + fscod];
						assert(frameSize !== undefined);

						if (!await this.isFrameStart(possibleSyncPos, frameSize, 0, 2, readAc3SyncHeader)) {
							this.seekTo(possibleSyncPos + 1);
							continue;
						}

						const duration = Math.round(
							AC3_SAMPLES_PER_FRAME * MPEG_TS_TIMESCALE / elementaryStream.info.sampleRate,
						);
						return this.supplyPacket(frameSize, duration);
					} else if (codec === 'eac3') {
						if (byte !== 0x0b) {
							continue;
						}

						this.skip(-1);
						const possibleSyncPos = this.currentPos;

						// Need at least 6 bytes for header parsing (sync word + frmsiz + fscod/numblkscod + bsid)
						let remaining = this.ensureBuffered(6);
						if (isThenable(remaining)) {
							remaining = await remaining;
						}

						if (remaining < 6) {
							return;
						}

						const headerBytes = this.readBytes(6);

						if (headerBytes[0] !== 0x0b || headerBytes[1] !== 0x77) {
							this.seekTo(possibleSyncPos + 1);
							continue;
						}

						let frameSize: number;
						let samplesPerFrame: number;

						if (isAc3FamilyFrame(headerBytes)) {
							// An AC-3 frame, as Blu-ray's Dolby Digital Plus streams carry for their core
							const fscod = headerBytes[4]! >> 6;
							const frmsizecod = headerBytes[4]! & 0x3f;

							if (fscod === 3 || frmsizecod > 37) {
								// Invalid
								this.seekTo(possibleSyncPos + 1);
								continue;
							}

							frameSize = AC3_FRAME_SIZES[3 * frmsizecod + fscod]!;
							samplesPerFrame = AC3_SAMPLES_PER_FRAME;
						} else {
							const frmsiz = ((headerBytes[2]! & 0x07) << 8) | headerBytes[3]!;
							frameSize = (frmsiz + 1) * 2;
							const fscod = headerBytes[4]! >> 6;
							const numblkscod = fscod === 3 ? 3 : (headerBytes[4]! >> 4) & 0x03;
							samplesPerFrame = EAC3_NUMBLKS_TABLE[numblkscod]! * 256; // 256 samples per block
						}

						// Dependent substreams extend the frame before them to more channels, so they're part of its
						// access unit (taken from upstream's bug-fix-mania branch)
						while (true) {
							this.seekTo(possibleSyncPos);

							const neededBytes = frameSize + 6;
							let remaining = this.ensureBuffered(neededBytes);
							if (isThenable(remaining)) {
								remaining = await remaining;
							}

							if (remaining < neededBytes) {
								break;
							}

							this.seekTo(possibleSyncPos + frameSize);
							const nextHeaderBytes = this.readBytes(6);

							if (
								nextHeaderBytes[0] !== 0x0b
								|| nextHeaderBytes[1] !== 0x77
								// In an AC-3 frame, the bits of strmtyp belong to its CRC
								|| isAc3FamilyFrame(nextHeaderBytes)
								|| (nextHeaderBytes[2]! >> 6) !== 1 // strmtyp of a dependent substream
							) {
								break;
							}

							frameSize += 2 * ((((nextHeaderBytes[2]! & 0x07) << 8) | nextHeaderBytes[3]!) + 1);
						}

						if (!await this.isFrameStart(possibleSyncPos, frameSize, 0, 2, readAc3SyncHeader)) {
							this.seekTo(possibleSyncPos + 1);
							continue;
						}

						const duration = Math.round(
							samplesPerFrame * MPEG_TS_TIMESCALE / elementaryStream.info.sampleRate,
						);
						return this.supplyPacket(frameSize, duration);
					} else if (codec === 'dts') {
						if (byte !== 0x7f && byte !== 0x64) {
							continue;
						}

						this.skip(-1);
						const possibleSyncPos = this.currentPos;

						let remaining = this.ensureBuffered(DTS_CORE_FRAME_HEADER_SIZE);
						if (isThenable(remaining)) remaining = await remaining;

						if (remaining < DTS_CORE_FRAME_HEADER_SIZE) {
							return;
						}

						const headerBytes = this.readBytes(DTS_CORE_FRAME_HEADER_SIZE);
						const core = parseDtsCoreFrameHeader(headerBytes);
						let leadingExss = core ? null : parseDtsExssHeader(headerBytes);

						if (!core && !leadingExss) {
							this.seekTo(possibleSyncPos + 1);
							continue;
						}

						if (leadingExss && !leadingExss.asset) {
							// The static fields and the asset descriptor reach past the bytes we read for the
							// core header, so take another look with the substream's whole header available
							this.seekTo(possibleSyncPos);

							const headerBound = Math.min(leadingExss.frameSize, DTS_EXSS_MAX_HEADER_SIZE);
							let remaining = this.ensureBuffered(headerBound);
							if (isThenable(remaining)) remaining = await remaining;

							leadingExss = parseDtsExssHeader(this.readBytes(remaining)) ?? leadingExss;
						}

						let frameSize = core ? core.frameSize : leadingExss!.frameSize;

						// Extension-only streams put exactly one substream in each frame, so it's only a core
						// frame that needs us to go looking for the extensions riding along with it. The core is
						// padded out to a 4-byte boundary before the first of them starts.
						if (core) {
							let nextSubstreamPos = Math.ceil(core.frameSize / 4) * 4;

							while (true) {
								this.seekTo(possibleSyncPos);

								const neededBytes = nextSubstreamPos + DTS_EXSS_HEADER_PREFIX_SIZE;
								let remaining = this.ensureBuffered(neededBytes);
								if (isThenable(remaining)) remaining = await remaining;

								if (remaining < neededBytes) {
									break;
								}

								this.seekTo(possibleSyncPos + nextSubstreamPos);

								const exss = parseDtsExssHeader(this.readBytes(DTS_EXSS_HEADER_PREFIX_SIZE));
								if (!exss) {
									break;
								}

								nextSubstreamPos += exss.frameSize;
								frameSize = nextSubstreamPos;
							}
						}

						// Only the substream leading the frame declares how many samples the frame holds
						const sampleCount = core?.sampleCount ?? leadingExss!.asset?.sampleCount;
						if (sampleCount === undefined) {
							this.seekTo(possibleSyncPos + 1);
							continue;
						}

						this.seekTo(possibleSyncPos);

						remaining = this.ensureBuffered(frameSize);
						if (isThenable(remaining)) remaining = await remaining;

						if (remaining < frameSize) {
							return; // The data ends inside the frame, which wouldn't decode
						}

						const duration = Math.round(
							sampleCount * MPEG_TS_TIMESCALE / elementaryStream.info.sampleRate,
						);
						return this.supplyPacket(frameSize, duration);
					} else {
						throw new Error('Unhandled.');
					}
				}

				if (remaining < CHUNK_SIZE) {
					break;
				}
			}
		}
	}

	/**
	 * Whether the frame header found at pos starts a frame of the given size and sample rate. Sync words also show up
	 * inside frames, notably at the start of a PES packet that begins with the tail of a frame
	 * (data_alignment_indicator 0), so like Chromium's MPEG-2 TS parsers, it only does if another header of the
	 * stream follows the frame (readHeader parses the headerSize bytes there). That one must have the same sample
	 * rate, or else be followed by a header of its own rate: a sample rate change. If the data ends right after the
	 * frame, it's the last frame, but a frame cut short by the end of the data doesn't count, since it wouldn't
	 * decode (the ADTS and MP3 demuxers drop it too). Leaves the position at pos.
	 */
	async isFrameStart(
		pos: number,
		frameSize: number,
		rate: number,
		headerSize: number,
		readHeader: (bytes: Uint8Array) => { frameSize: number; rate: number } | null,
	) {
		// The header at the given distance from pos: 'end' if the data ends there (or less than a header after it),
		// null if the data ends before it or there's no header
		const readHeaderAt = async (distance: number) => {
			this.seekTo(pos);
			let remaining = this.ensureBuffered(distance + headerSize);
			if (isThenable(remaining)) {
				remaining = await remaining;
			}

			if (remaining < distance + headerSize) {
				return remaining >= distance ? 'end' as const : null;
			}

			this.seekTo(pos + distance);
			return readHeader(this.readBytes(headerSize));
		};

		let result = false;
		const next = await readHeaderAt(frameSize);
		if (next === 'end') {
			result = true;
		} else if (next) {
			if (next.rate === rate) {
				result = true;
			} else {
				const afterNext = await readHeaderAt(frameSize + next.frameSize);
				result = afterNext === 'end' || afterNext?.rate === next.rate;
			}
		}

		this.seekTo(pos);
		return result;
	}

	/**
	 * Supplies the context with a new encoded packet, beginning at the current position. For video, `accessUnitPos` is
	 * where the packet's AUD starts, if known, and `continuesAccessUnit` whether the packet doesn't begin its access
	 * unit (it lacks the start of its picture, or its AUD).
	 */
	supplyPacket(
		packetLength: number,
		intrinsicDuration: number,
		accessUnitPos: number | null = null,
		continuesAccessUnit = false,
		// Ranges (in context positions) to leave out of the packet's data
		droppedRanges: { start: number; end: number }[] = [],
	) {
		const currentPesPacket = this.getCurrentPesPacket();
		const hasUnusedPts = (pesPacket: PesPacket) => {
			return pesPacket.pts !== null && pesPacket.sectionStartPos > this.lastPtsSectionStartPos;
		};

		// A PES packet's PTS belongs to the first access unit that begins in it (H.222.0 2.4.3.7), like in FFmpeg and
		// Chromium. When parameter sets come in a PES packet of their own though, the packet starts before its access
		// unit (at its AUD), so let's look for the PES packet that one is in. Failing that, take the PTS of the PES
		// packet the packet starts in.
		let ptsPesPacket: PesPacket | null = null;
		if (accessUnitPos !== null) {
			let pesPacketPos = this.currentPesPacketPos;
			for (let i = this.currentPesPacketIndex; i < this.pesPackets.length; i++) {
				const pesPacket = this.pesPackets[i]!;
				pesPacketPos += pesPacket.data.byteLength;
				if (pesPacketPos > accessUnitPos) {
					ptsPesPacket = hasUnusedPts(pesPacket) ? pesPacket : null;
					break;
				}
			}
		}

		if (!ptsPesPacket && hasUnusedPts(currentPesPacket)) {
			ptsPesPacket = currentPesPacket;
		}

		let pts: number | null;
		if (ptsPesPacket && continuesAccessUnit && accessUnitPos === null) {
			// No access unit begins with this packet, so the PTS belongs to the one after it in the PES packet. Like
			// before, the packet shares it.
			pts = ptsPesPacket.pts;
		} else if (ptsPesPacket) {
			pts = ptsPesPacket.pts;
			this.lastPtsSectionStartPos = ptsPesPacket.sectionStartPos;

			maybeInsertReferencePacket(this.elementaryStream, ptsPesPacket as TimestampedPesPacketHeader);
		} else if (this.elementaryStream.info.type === 'audio') {
			// The frame directly follows the previous one, if there is one
			pts = this.nextPts;
		} else {
			// There's no PTS for this packet (several frames in one PES packet, or PES packets without a PTS), so the
			// PacketBuffer infers its timestamp from the packets around it
			pts = null;
		}

		this.nextPts = pts === null ? null : pts + intrinsicDuration;

		const sectionStartPos = currentPesPacket.sectionStartPos;
		// The sequence number is the starting position of the section the PES packet is in, PLUS the offset within the
		// PES packet where the packet starts.
		const sequenceNumber = sectionStartPos + (this.currentPos - this.currentPesPacketPos);
		const packetStartPos = this.currentPos;
		let data = this.readBytes(packetLength);

		if (droppedRanges.length > 0) {
			const parts: Uint8Array[] = [];
			let offset = 0;
			for (const range of droppedRanges) {
				parts.push(data.subarray(offset, range.start - packetStartPos));
				offset = range.end - packetStartPos;
			}
			parts.push(data.subarray(offset));

			const filtered = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
			let pos = 0;
			for (const part of parts) {
				filtered.set(part, pos);
				pos += part.length;
			}
			data = filtered;
		}

		// random_access_indicator says that a PES packet holds the start of a random access point: the first access
		// unit beginning in it (the one taking its PTS, if it has one). A packet continuing an access unit begins none.
		const beginsAccessUnit = !(continuesAccessUnit && accessUnitPos === null);
		const isFirstAccessUnitOfPesPacket = beginsAccessUnit
			&& currentPesPacket.sectionStartPos > this.lastAccessUnitSectionStartPos;
		const isDescribedAccessUnit = isFirstAccessUnitOfPesPacket || (beginsAccessUnit && ptsPesPacket !== null);
		if (beginsAccessUnit) {
			this.lastAccessUnitSectionStartPos = Math.max(
				currentPesPacket.sectionStartPos,
				ptsPesPacket?.sectionStartPos ?? -1,
			);
		}

		// Data that went missing inside the packet, or right at its end (which, for a frame boundary we found right
		// there, can only be the end of this packet), leaves it undecodable, and with WebCodecs, the decoder then fails
		// altogether. So skip it: for video to the next access unit, for audio to right after the hole, where the next
		// frame can be found again.
		const packetEndPos = packetStartPos + packetLength;
		const hole = this.holes.length > 0
			? this.holes.find(x => x > packetStartPos && x <= packetEndPos)
			: undefined;
		if (hole !== undefined && this.elementaryStream.info.type === 'audio') {
			this.seekTo(hole);
			this.skipPacket();
			return;
		}

		if (hole !== undefined && this.elementaryStream.info.decoderConfig) {
			// A video frame that lost data. (While the stream is being set up, it's kept: setup only reads its
			// parameter sets, which come first, and key frames can't be told yet to drop up to the next one.)
			if (this.dropsRestOfGop()) {
				this.extendDroppedRange(sequenceNumber);
			}

			this.skipPacket();
			return;
		}

		let randomAccessIndicator = Math.max(
			currentPesPacket.randomAccessIndicator,
			ptsPesPacket?.randomAccessIndicator ?? 0,
		);

		if (this.elementaryStream.info.type === 'audio') {
			if (randomAccessIndicator === 0 && !this.elementaryStream.canBeTrustedWithKeyPackets) {
				randomAccessIndicator = 1;
			}
		} else if (this.elementaryStream.info.decoderConfig) {
			const { codec, decoderConfig } = this.elementaryStream.info;

			if (isDescribedAccessUnit) {
				// The access unit gets the flag of the PES packet(s) describing it (see above)
				randomAccessIndicator = Math.max(
					isFirstAccessUnitOfPesPacket ? currentPesPacket.randomAccessIndicator : 0,
					beginsAccessUnit && ptsPesPacket ? ptsPesPacket.randomAccessIndicator : 0,
				);
			}

			if (!isDescribedAccessUnit && this.elementaryStream.canBeTrustedWithKeyPackets) {
				// random_access_indicator says that the PES packet holds the start of a random access point, the first
				// access unit beginning in it. It doesn't tell about the access units after that one, so in a flagged
				// PES packet, the bitstream decides for them (an all-intra stream may pack several key frames into one
				// PES packet).
				randomAccessIndicator = currentPesPacket.randomAccessIndicator === 1
					? Number(determineVideoPacketType(codec, decoderConfig, data) === 'key')
					: 0;
			} else if (randomAccessIndicator === 1) {
				// Some muxers set random_access_indicator on packets that aren't key frames (on every PES packet, or on
				// the ones carrying a PCR). A picture that is neither IDR/IRAP nor comes with a recovery point SEI
				// message (as open-GOP and intra-refresh streams use) can't be a random access point, so the flag
				// lied and can't be trusted from here on.
				if (
					determineVideoPacketType(codec, decoderConfig, data) !== 'key'
					&& !containsRecoveryPointSei(codec, data)
				) {
					randomAccessIndicator = 0;
					this.elementaryStream.canBeTrustedWithKeyPackets = false;
				}
			} else if (!this.elementaryStream.canBeTrustedWithKeyPackets) {
				randomAccessIndicator = Number(determineVideoPacketType(codec, decoderConfig, data) === 'key');
			}
		} else {
			// We're reading packets before the decoder config is determined
		}

		if (this.droppedRange && randomAccessIndicator !== 1) {
			// Still dropping, up to the next key frame
			this.extendDroppedRange(sequenceNumber);
			this.skipPacket();
			return;
		}

		this.droppedRange = null;
		this.suppliedPacket = {
			pts,
			intrinsicDuration,
			data,
			sequenceNumber,
			sectionStartPos,
			ptsSectionStartPos: ptsPesPacket?.sectionStartPos ?? null,
			randomAccessIndicator,
		};

		this.pesPackets.splice(0, this.currentPesPacketIndex);
		this.currentPesPacketIndex = 0;
		if (this.holes.length > 0) {
			this.holes = this.holes.filter(x => x > this.currentPos);
		}
	}

	/**
	 * Whether the frames after one that lost data, up to the next key frame, are dropped too. That's needed where
	 * frames can refer to frames that come later (B-frames): WebCodecs decoders in Chromium fail on such a frame when
	 * its reference is missing. AVC streams without reordering (P-frames only) only lose the damaged frames, which
	 * decoders handle like a gap in frame_num.
	 */
	dropsRestOfGop() {
		const stream = this.elementaryStream;
		if (stream.dropsRestOfGop === null) {
			if (stream.info.type !== 'video' || stream.info.codec !== 'avc' || !stream.info.avcCodecInfo) {
				return true; // Without knowing more, stay on the safe side
			}

			const spsUnit = stream.info.avcCodecInfo.sequenceParameterSets[0];
			const spsInfo = spsUnit ? parseAvcSps(spsUnit) : null;
			// Baseline has no B-slices
			stream.dropsRestOfGop = !spsInfo || (spsInfo.numReorderFrames > 0 && spsInfo.profileIdc !== 66);
		}

		return stream.dropsRestOfGop;
	}

	/**
	 * Drops the video packet that was just read (starting at the sequence number), as part of a stretch running up to
	 * the next key frame: the frames after one that lost data can refer to it, and with WebCodecs, a frame whose
	 * reference is missing can make the decoder fail just like a damaged one. The stretch is recorded so that contexts
	 * starting inside it (lookups) drop the same packets.
	 */
	extendDroppedRange(sequenceNumber: number) {
		const endSequenceNumber = this.getCurrentPesPacket().sectionStartPos
			+ (this.currentPos - this.currentPesPacketPos);
		if (!this.droppedRange) {
			const ranges = this.elementaryStream.droppedRanges;
			this.droppedRange = ranges.find(x => x.start <= sequenceNumber && sequenceNumber <= x.end) ?? null;
			if (!this.droppedRange) {
				this.droppedRange = { start: sequenceNumber, end: endSequenceNumber };
				ranges.splice(binarySearchLessOrEqual(ranges, sequenceNumber, x => x.start) + 1, 0, this.droppedRange);
			}
		}

		this.droppedRange.end = Math.max(this.droppedRange.end, endSequenceNumber);
	}

	/** Moves on from a packet that is left out. */
	skipPacket() {
		this.holes = this.holes.filter(x => x > this.currentPos);
		this.pesPackets.splice(0, this.currentPesPacketIndex);
		this.currentPesPacketIndex = 0;
		this.skippedPacket = true;
	}
}

/**
 * A buffer that simulates decoder frame reordering to compute packet durations. Packets arrive in decode order but
 * durations are based on presentation order.
 */
class PacketBuffer {
	backing: MpegTsTrackBacking;
	context: PacketReadingContext;

	decodeOrderPackets: TimedSuppliedPacket[] = [];
	reorderSize: number;
	reorderBuffer: TimedSuppliedPacket[] = [];
	presentationOrderPackets: TimedSuppliedPacket[] = [];
	reachedEnd = false;
	lastDuration = 0;

	/** Packets that were read ahead to time the packets before them, in decode order */
	pendingPackets: TimedSuppliedPacket[] = [];
	/** The last packet with a timestamp of its own */
	lastTimedPacket: TimedSuppliedPacket | null = null;
	/** The packet with a timestamp of its own right before that one, if no packets without one came between them */
	timedPacketBeforeLast: TimedSuppliedPacket | null = null;
	/** How many packets after `lastTimedPacket` were given a timestamp */
	untimedPacketCount = 0;
	/** The time per packet between the last two packets with a timestamp of their own, if it went forward */
	timedPacketSpacing: number | null = null;
	defaultFrameDuration: number | null = null;
	/** The SPS of an AVC stream with picture order counts in its slice headers, if this is one */
	avcSpsInfo: AvcSpsInfo | null | undefined = undefined;
	/** The time per picture order count of the last packets placed by their picture order */
	ticksPerPicOrderCnt: number | null = null;

	constructor(backing: MpegTsTrackBacking, context: PacketReadingContext) {
		this.backing = backing;
		this.context = context;
		this.reorderSize = backing.getReorderSize();
		assert(this.reorderSize >= 0);
	}

	async readNext(): Promise<{ packet: TimedSuppliedPacket; duration: number } | null> {
		if (this.decodeOrderPackets.length === 0) {
			// We need the next packet
			const didRead = await this.readNextPacket();
			if (!didRead) {
				return null;
			}
		}

		// Ensure we know the next packet in presentation order so we can compute the current packet's duration
		await this.ensureCurrentPacketHasNext();

		const packet = this.decodeOrderPackets[0]!;

		// Let's compute the duration
		const presentationIndex = this.presentationOrderPackets.indexOf(packet);

		let duration: number;
		if (presentationIndex === -1 || presentationIndex === this.presentationOrderPackets.length - 1) {
			// The packet has no known successor (or isn't even placed yet when timestamps are messed up). For video,
			// whose frames may be reordered, the packets around it depend on where reading started, so use the
			// track's frame duration.
			duration = this.backing.elementaryStream.info.type === 'video'
				? await this.backing.getFrameDuration()
				: this.lastDuration; // Reasonable heuristic
		} else {
			const nextPacket = this.presentationOrderPackets[presentationIndex + 1]!;
			duration = nextPacket.pts - packet.pts;
			this.lastDuration = duration;
		}

		this.decodeOrderPackets.shift();

		// Shrink the presentation array as much as possible
		while (this.presentationOrderPackets.length > 0) {
			const first = this.presentationOrderPackets[0]!;
			if (this.decodeOrderPackets.includes(first)) {
				break;
			}

			this.presentationOrderPackets.shift();
		}

		return { packet, duration };
	}

	async readNextPacket() {
		if (this.reachedEnd) {
			return false;
		}

		let packet = this.pendingPackets.shift() ?? null;
		if (!packet) {
			const suppliedPacket = await this.pullPacket();
			if (suppliedPacket && suppliedPacket.pts === null) {
				await this.timePackets(suppliedPacket);
				packet = this.pendingPackets.shift()!;
			} else {
				packet = suppliedPacket as TimedSuppliedPacket | null;
				if (packet) {
					this.setLastTimedPacket(packet);
				}
			}
		}

		if (!packet) {
			this.reachedEnd = true;
			this.flushReorderBuffer();

			return false;
		}

		this.decodeOrderPackets.push(packet);
		this.processPacketThroughReorderBuffer(packet);

		return true;
	}

	async pullPacket() {
		let suppliedPacket: SuppliedPacket | null;
		if (this.context.suppliedPacket) {
			// Small optimization: there was already a supplied packet in the context, so let's first use that one
			suppliedPacket = this.context.suppliedPacket;
		} else {
			await this.context.markNextPacket();
			suppliedPacket = this.context.suppliedPacket;
		}
		this.context.suppliedPacket = null;

		return suppliedPacket;
	}

	/**
	 * Gives timestamps to packets that come without one: frames after the first one in a PES packet, and frames in PES
	 * packets without a PTS (which MPEG-TS only requires every 0.7 seconds). The packets up to the next one with a
	 * timestamp of its own are read ahead and spread evenly up to it, which is exact for constant frame rates and
	 * doesn't rely on the frame rates in bitstreams (often wrong). Only packets after the last PTS, or too many in a
	 * row, continue at the rate seen before them.
	 */
	async timePackets(firstPacket: SuppliedPacket) {
		const { packets, nextTimedPacket } = await this.readUntimedPackets(firstPacket);
		const sps = !this.lastTimedPacket && nextTimedPacket ? this.getAvcSpsInfo() : null;
		if (!sps || !nextTimedPacket) {
			this.placeUntimedPackets(packets, nextTimedPacket);
			return;
		}

		// Packets before the first one with a timestamp are placed by their picture order too: an IDR picture whose PES
		// packet has no PTS comes before the B-frames after it, an open-GOP I picture after its leading pictures. Each
		// goes between the packets with a timestamp around it in picture order, so read on until one comes after all
		// of them in picture order (and there are two).
		const readPackets: SuppliedPacket[] = [...packets, nextTimedPacket];
		const runs: { packets: SuppliedPacket[]; nextTimedPacket: TimedSuppliedPacket | null }[] = [];
		let picOrderCnts = getAvcPicOrderCnts(readPackets, sps);

		while (picOrderCnts && readPackets.length < MAX_UNTIMED_PACKET_RUN_LENGTH) {
			const lastLeadingPicOrderCnt = Math.max(...picOrderCnts.slice(0, packets.length).map(x => x ?? Infinity));
			const timedPicOrderCnts = picOrderCnts.filter((x, i) => x !== null && readPackets[i]!.pts !== null);
			if (timedPicOrderCnts.length >= 2 && timedPicOrderCnts.some(x => x! > lastLeadingPicOrderCnt)) {
				break;
			}

			const packetAfter = await this.pullPacket();
			const run = packetAfter && packetAfter.pts === null
				? await this.readUntimedPackets(packetAfter)
				: { packets: [], nextTimedPacket: packetAfter as TimedSuppliedPacket | null };
			runs.push(run);
			readPackets.push(...run.packets, ...(run.nextTimedPacket ? [run.nextTimedPacket] : []));
			picOrderCnts = getAvcPicOrderCnts(readPackets, sps);

			if (!run.nextTimedPacket || picOrderCnts?.at(-1) === null) {
				// The end of the stream, or the picture order starts over
				break;
			}
		}

		const timestamps = picOrderCnts && getTimestampsAmongPictures(readPackets, picOrderCnts, packets.length);
		if (timestamps) {
			packets.forEach((packet, i) => packet.pts = Math.round(timestamps[i]!));
			this.pendingPackets.push(...packets as TimedSuppliedPacket[]);
			this.setLastTimedPacket(nextTimedPacket);
			this.pendingPackets.push(nextTimedPacket);
		} else {
			this.placeUntimedPackets(packets, nextTimedPacket);
		}

		for (const run of runs) {
			this.placeUntimedPackets(run.packets, run.nextTimedPacket);
		}
	}

	/** Reads the packets without a timestamp starting with the given one, up to the next packet with one. */
	async readUntimedPackets(firstPacket: SuppliedPacket) {
		const packets = [firstPacket];
		let nextTimedPacket: TimedSuppliedPacket | null = null;

		while (packets.length < MAX_UNTIMED_PACKET_RUN_LENGTH) {
			const packet = await this.pullPacket();
			if (!packet) {
				break;
			}

			if (packet.pts !== null) {
				nextTimedPacket = packet as TimedSuppliedPacket;
				break;
			}

			packets.push(packet);
		}

		return { packets, nextTimedPacket };
	}

	/** Gives timestamps to the given packets without one, which come before the given packet with one (if any). */
	placeUntimedPackets(packets: SuppliedPacket[], nextTimedPacket: TimedSuppliedPacket | null) {
		const previousTimedPacket = this.lastTimedPacket;

		if (packets.length > 0) {
			const pictureOrderTimestamps = previousTimedPacket && this.untimedPacketCount === 0
				? this.getTimestampsFromPictureOrder(previousTimedPacket, packets, nextTimedPacket)
				: null;

			if (pictureOrderTimestamps) {
				packets.forEach((packet, i) => packet.pts = Math.round(pictureOrderTimestamps[i]!));
			} else if (
				previousTimedPacket
				&& nextTimedPacket
				&& this.untimedPacketCount === 0
				&& nextTimedPacket.pts > previousTimedPacket.pts
			) {
				const step = (nextTimedPacket.pts - previousTimedPacket.pts) / (packets.length + 1);
				packets.forEach((packet, i) => packet.pts = Math.round(previousTimedPacket.pts + (i + 1) * step));
			} else if (previousTimedPacket) {
				const step = this.timedPacketSpacing ?? this.getDefaultFrameDuration();
				packets.forEach((packet, i) => packet.pts = Math.round(
					previousTimedPacket.pts + (this.untimedPacketCount + i + 1) * step,
				));
			} else {
				// These come before the first packet with a timestamp, so count back from it (or forward from zero if
				// there's none)
				let pts = nextTimedPacket?.pts
					?? packets.reduce((sum, x) => sum + (x.intrinsicDuration || this.getDefaultFrameDuration()), 0);

				for (let i = packets.length - 1; i >= 0; i--) {
					const packet = packets[i]!;
					pts -= packet.intrinsicDuration || this.getDefaultFrameDuration();
					packet.pts = Math.round(pts);
				}
			}

			this.pendingPackets.push(...packets as TimedSuppliedPacket[]);
			this.untimedPacketCount += packets.length;
		}

		if (nextTimedPacket) {
			this.setLastTimedPacket(nextTimedPacket);
			this.pendingPackets.push(nextTimedPacket);
		} else if (!previousTimedPacket && packets.length > 0) {
			// Let the packets after these continue from them
			this.lastTimedPacket = packets.at(-1) as TimedSuppliedPacket;
			this.timedPacketBeforeLast = null;
			this.untimedPacketCount = 0;
		}
	}

	/**
	 * For AVC with picture order counts in its slice headers, places the packets after a timed one (and before the next
	 * timed one, if any) by their picture order, which also works when frames are reordered (B-frames). Returns null if
	 * that can't be done.
	 */
	getTimestampsFromPictureOrder(
		previous: TimedSuppliedPacket,
		packets: SuppliedPacket[],
		next: TimedSuppliedPacket | null,
	) {
		const sps = this.getAvcSpsInfo();
		if (!sps) {
			return null;
		}

		const picOrderCnts = getAvcPicOrderCnts([previous, ...packets, ...(next ? [next] : [])], sps);
		if (!picOrderCnts) {
			return null;
		}

		const previousPicOrderCnt = picOrderCnts[0] ?? null;
		const nextPicOrderCnt = next ? picOrderCnts[picOrderCnts.length - 1] ?? null : null;
		if (previousPicOrderCnt === null) {
			return null;
		}

		let ticksPerPicOrderCnt: number | null;
		if (next && nextPicOrderCnt !== null) {
			ticksPerPicOrderCnt = (next.pts - previous.pts) / (nextPicOrderCnt - previousPicOrderCnt);
			if (ticksPerPicOrderCnt > 0 && Number.isFinite(ticksPerPicOrderCnt)) {
				this.ticksPerPicOrderCnt = ticksPerPicOrderCnt;
			}
		} else {
			// There's no next timed packet (the end of the stream), or it starts the picture order over (an IDR
			// picture), so the time per picture order count has to come from the packets before
			ticksPerPicOrderCnt = this.getPreviousTicksPerPicOrderCnt(sps);
		}

		if (ticksPerPicOrderCnt === null || !(ticksPerPicOrderCnt > 0) || !Number.isFinite(ticksPerPicOrderCnt)) {
			return null;
		}

		const result: number[] = [];
		for (const picOrderCnt of picOrderCnts.slice(1, next ? -1 : undefined)) {
			if (picOrderCnt === null) {
				return null;
			}

			result.push(previous.pts + (picOrderCnt - previousPicOrderCnt) * ticksPerPicOrderCnt);
		}

		return result;
	}

	/** The SPS of an AVC stream with picture order counts in its slice headers, or null if this isn't one. */
	getAvcSpsInfo() {
		if (this.avcSpsInfo === undefined) {
			const info = this.backing.elementaryStream.info;
			const sps = info.type === 'video' ? info.avcCodecInfo?.sequenceParameterSets[0] : undefined;
			const spsInfo = sps ? parseAvcSps(sps) : null;
			this.avcSpsInfo = spsInfo?.picOrderCntType === 0 ? spsInfo : null;
		}

		return this.avcSpsInfo;
	}

	/**
	 * Returns the time per picture order count measured on the two last timed packets, if they're consecutive, or
	 * else on the last packets that were placed by their picture order.
	 */
	getPreviousTicksPerPicOrderCnt(sps: AvcSpsInfo) {
		const before = this.timedPacketBeforeLast;
		const last = this.lastTimedPacket;
		const pair = before && last ? getAvcPicOrderCnts([before, last], sps) : null;
		const beforePicOrderCnt = pair?.[0] ?? null;
		const lastPicOrderCnt = pair?.[1] ?? null;

		if (before && last && beforePicOrderCnt !== null && lastPicOrderCnt !== null) {
			const ticksPerPicOrderCnt = (last.pts - before.pts) / (lastPicOrderCnt - beforePicOrderCnt);
			if (ticksPerPicOrderCnt > 0 && Number.isFinite(ticksPerPicOrderCnt)) {
				return ticksPerPicOrderCnt;
			}
		}

		return this.ticksPerPicOrderCnt;
	}

	setLastTimedPacket(packet: TimedSuppliedPacket) {
		const previous = this.lastTimedPacket;
		this.timedPacketBeforeLast = this.untimedPacketCount === 0 ? previous : null;
		this.timedPacketSpacing = previous && packet.pts > previous.pts
			? (packet.pts - previous.pts) / (this.untimedPacketCount + 1)
			: null;
		this.lastTimedPacket = packet;
		this.untimedPacketCount = 0;
	}

	/** The frame duration to assume when there's nothing to measure it from. */
	getDefaultFrameDuration() {
		if (this.defaultFrameDuration === null) {
			const info = this.backing.elementaryStream.info;
			this.defaultFrameDuration = (info.type === 'video' && getVideoFrameDuration(info))
				|| DEFAULT_FRAME_DURATION;
		}

		return this.defaultFrameDuration;
	}

	async ensureCurrentPacketHasNext() {
		const current = this.decodeOrderPackets[0];
		assert(current);

		while (true) {
			const presentationIndex = this.presentationOrderPackets.indexOf(current);

			// Check if current packet has a next packet
			if (presentationIndex !== -1 && presentationIndex <= this.presentationOrderPackets.length - 2) {
				break;
			}

			// Cap it so that nonsensical timestamps don't scan the entire file
			if (this.decodeOrderPackets.length > 4 * (this.reorderSize + 1)) {
				break;
			}

			const didRead = await this.readNextPacket();
			if (!didRead) {
				break;
			}
		}
	}

	processPacketThroughReorderBuffer(packet: TimedSuppliedPacket) {
		this.reorderBuffer.push(packet);

		// If buffer is now overfull, output the packet with smallest PTS
		if (this.reorderBuffer.length > this.reorderSize) {
			let minIndex = 0;
			for (let i = 1; i < this.reorderBuffer.length; i++) {
				if (this.reorderBuffer[i]!.pts < this.reorderBuffer[minIndex]!.pts) {
					minIndex = i;
				}
			}

			const packet = this.reorderBuffer[minIndex]!;
			this.presentationOrderPackets.push(packet);
			this.reorderBuffer.splice(minIndex, 1);
		}
	}

	flushReorderBuffer() {
		this.reorderBuffer.sort((a, b) => a.pts - b.pts);
		this.presentationOrderPackets.push(...this.reorderBuffer);
		this.reorderBuffer.length = 0;
	}
}
