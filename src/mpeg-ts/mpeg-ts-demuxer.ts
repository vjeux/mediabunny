/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TrackType } from '../output';
import { SAMPLES_PER_AAC_FRAME } from '../adts/adts-demuxer';
import { MAX_ADTS_FRAME_HEADER_SIZE, readAdtsFrameHeader } from '../adts/adts-reader';
import { aacChannelMap, aacFrequencyTable } from '../../shared/aac-misc';
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
	determineVideoPacketType,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	EAC3_NUMBLKS_TABLE,
	getEac3ChannelCount,
	getEac3SampleRate,
	HevcDecoderConfigurationRecord,
	HevcNalUnitType,
	parseAc3SyncFrame,
	parseAvcSps,
	parseEac3SyncFrame,
	parseHevcSps,
	AC3_FRAME_SIZES,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	iterateNalUnitsInAnnexB,
	parseDtsFrame,
	parseDtsCoreFrameHeader,
	removeEmulationPreventionBytes,
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
	isThenable,
	isIso639Dash2LanguageCode,
	IDENTITY_MATRIX,
	last,
	MATRIX_COEFFICIENTS_MAP_INVERSE,
	readExpGolomb,
	roundIfAlmostInteger,
	toDataView,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
	TransformationMatrix,
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
 * How far into the media (in PTS) we keep looking for declared streams that haven't shown up yet. FFmpeg gives up on
 * finding a stream's parameters after 7 seconds of MPEG-TS media.
 */
const MAX_STREAM_START_DELAY = 10 * MPEG_TS_TIMESCALE;

const REGISTRATION_DESCRIPTOR_TAG = 0x05;
const ISO_639_LANGUAGE_DESCRIPTOR_TAG = 0x0a;

// The 'HDMV' and 'HDPR' format identifiers, which mark a program as Blu-ray-derived
const HDMV_FORMAT_IDENTIFIER = 0x48444d56;
const HDPR_FORMAT_IDENTIFIER = 0x48445052;

// 'DTS1', 'DTS2' and 'DTS3' all share this prefix
const DTS_FORMAT_IDENTIFIER_PREFIX = 0x44545300;

// Stream types that only mean E-AC-3 or DTS within a Blu-ray-derived program, and what they map to
const BLU_RAY_STREAM_TYPES = new Map<number, MpegTsStreamType>([
	[MpegTsStreamType.BLU_RAY_EAC3, MpegTsStreamType.EAC3_SYSTEM_A],
	[MpegTsStreamType.BLU_RAY_EAC3_SECONDARY, MpegTsStreamType.EAC3_SYSTEM_A],
	[MpegTsStreamType.BLU_RAY_DTS_HD, MpegTsStreamType.DTS],
	[MpegTsStreamType.BLU_RAY_DTS_HD_MASTER, MpegTsStreamType.DTS],
	[MpegTsStreamType.BLU_RAY_DTS_EXPRESS_SECONDARY, MpegTsStreamType.DTS],
]);

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
		reorderSize: number;
		/** How to find the field of a slice, for AVC streams that may contain field pictures. */
		avcFieldCoding: AvcFieldCoding | null;
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
};

type ElementaryVideoStream = ElementaryStream & { info: { type: 'video' } };
type ElementaryAudioStream = ElementaryStream & { info: { type: 'audio' } };

type TsPacketHeader = {
	payloadUnitStartIndicator: number;
	pid: number;
	adaptationFieldControl: number;
};

type TsPacket = TsPacketHeader & {
	body: Uint8Array<ArrayBufferLike>;
};

type Section = {
	startPos: number;
	endPos: number | null; // null if the section was not read fully
	pid: number;
	payload: Uint8Array<ArrayBufferLike>;
	randomAccessIndicator: number;
};

// Remember them so the warning doesn't get spammed
const ignoredStreamTypes = new Set<number>();

/**
 * What a position without a sync byte reads as: trailing junk (like zero padding) or a damaged packet. FFmpeg and
 * Chromium skip over such bytes, so instead of failing the whole read, we skip the position like a null packet.
 */
const NOT_A_PACKET_HEADER: TsPacketHeader = {
	payloadUnitStartIndicator: 0,
	pid: 0x1fff, // The null packet PID
	adaptationFieldControl: 0,
};

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

	const frameDuration = ticksPerFrame * timingInfo.numUnitsInTick * MPEG_TS_TIMESCALE / timingInfo.timeScale;
	return frameDuration > 0 && frameDuration <= MPEG_TS_TIMESCALE ? frameDuration : null;
};

export class MpegTsDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	elementaryStreams: ElementaryStream[] = [];
	trackBackingEntries: InputTrackBacking[] = [];
	packetOffset = 0;
	packetStride = -1;
	sectionEndPositions = new Set<number>();
	seekChunkSize = 5 * 1024 * 1024; // 5 MiB, picked because most HLS segments are below this size
	minReferencePointByteDistance = -1;
	timestampWrapInfo: TimestampWrapInfo | null = null;

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
					});
				}

				hasProgramMap = true;
				currentPos = this.packetOffset;
				// The first pass read sections as contiguous, which cuts PES packets short at the first packet of
				// another PID, so the section ends it recorded can't be trusted
				this.sectionEndPositions.clear();
				return true;
			};

			while (true) {
				const packetHeader = await this.readPacketHeader(currentPos);
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
					&& !this.elementaryStreams.some(x => x.pid === packetHeader.pid && !x.initialized)
				) {
					// Don't care about this PID (anymore), except for checking how far into the media we are
					if (firstPts !== null && this.elementaryStreams.some(x => x.pid === packetHeader.pid)) {
						const section = await this.readSection(currentPos, false);
						const pesPacketHeader = section ? readPesPacketHeader(this, section) : null;

						if (
							pesPacketHeader
							&& pesPacketHeader.pts !== null
							&& pesPacketHeader.pts - firstPts > MAX_STREAM_START_DELAY
						) {
							// The streams that still haven't shown up are declared, but don't seem to be in the file
							// (recorders may drop some), so let's stop looking for them instead of reading it all
							break;
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

				if (
					(section.pid === 0 && !hasProgramAssociationTable)
					|| (!hasProgramMap && (programMapPids.has(section.pid) || isProbablyProgramMap))
				) {
					await this.completePsiSection(section);
				}

				if (section.pid === 0 && !hasProgramAssociationTable) {
					const bitstream = new Bitstream((await this.findIntactPsiSection(section)).payload);
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
				} else if ((programMapPids.has(section.pid) || isProbablyProgramMap) && !hasProgramMap) {
					// Broadcast captures often carry several programs. We present just one, so let's use the first one
					// whose PMT shows up (some programs listed in the PAT may not even be in the capture).
					const bitstream = new Bitstream((await this.findIntactPsiSection(section)).payload);
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
								// which we work out from the bitstream anyway
								const formatIdentifier = bitstream.readBits(32);
								hasDtsDescriptor ||= (formatIdentifier & 0xffffff00) === DTS_FORMAT_IDENTIFIER_PREFIX;
							} else if (descriptorTag === ISO_639_LANGUAGE_DESCRIPTOR_TAG && descriptorLength >= 4) {
								// Dual-mono audio may list a second language, but the first one is what describes the
								// stream as a whole
								languageCode = String.fromCharCode(
									bitstream.readBits(8),
									bitstream.readBits(8),
									bitstream.readBits(8),
								);
								if (!isIso639Dash2LanguageCode(languageCode)) {
									languageCode = UNDETERMINED_LANGUAGE;
								}

								audioType = bitstream.readBits(8);
							}

							bitstream.pos = descriptorEndPos;
						}

						let info: ElementaryStream['info'] | null = null;

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
									reorderSize: -1,
									avcFieldCoding: null,
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
								}
							}; break;

							default: {
								// If we don't recognize the codec, we don't surface the track at all. This is because
								// we can't determine its metadata and also have no idea how to packetize its data.

								if (!ignoredStreamTypes.has(streamType)) {
									Logging._warn(
										`Note: MPEG-TS streams with stream_type 0x${streamType.toString(16)} are not`
										+ ` currently supported.`,
									);
									ignoredStreamTypes.add(streamType);
								}
							}
						}

						if (info) {
							this.elementaryStreams.push({
								demuxer: this,
								pid: elementaryPid,
								streamType,
								initialized: false,
								firstSection: null,
								canBeTrustedWithKeyPackets: false,
								languageCode,
								audioType,
								info,
								referencePesPackets: [],
							});
						}
					}

					hasProgramMap = true;
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

										if (num > 0 && den > 0) {
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

										if (num > 0 && den > 0) {
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

								if (
									elementaryStream.info.width !== elementaryStream.info.squarePixelWidth
									|| elementaryStream.info.height !== elementaryStream.info.squarePixelHeight
								) {
									elementaryStream.info.decoderConfig.displayAspectWidth
										= elementaryStream.info.squarePixelWidth;
									elementaryStream.info.decoderConfig.displayAspectHeight
										= elementaryStream.info.squarePixelHeight;
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
									elementaryStream.info.numberOfChannels
										= aacChannelMap[header.channelConfiguration]!;
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
									const frameInfo = parseEac3SyncFrame(context.suppliedPacket.data);
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

		while (true) {
			const packet = await this.readPacket(currentPos);
			currentPos += this.packetStride;

			if (!packet) {
				break;
			}

			if (!firstPacket) {
				if (packet.payloadUnitStartIndicator === 0) {
					break;
				}

				firstPacket = packet;
			} else {
				if (packet.pid !== firstPacket.pid) {
					if (contiguous) {
						break; // End of section
					} else {
						continue; // Ignore this packet
					}
				}

				if (packet.payloadUnitStartIndicator === 1) {
					break;
				}
			}

			const hasAdaptationField = !!(packet.adaptationFieldControl & 0b10);
			const hasPayload = !!(packet.adaptationFieldControl & 0b01);

			let adaptationFieldLength = 0;
			if (hasAdaptationField) {
				adaptationFieldLength = 1 + packet.body[0]!;

				// Extract random_access_indicator from first packet's adaptation field
				if (packet === firstPacket && adaptationFieldLength > 1) {
					randomAccessIndicator = (packet.body[1]! >> 6) & 1;
				}
			}

			if (hasPayload) {
				if (adaptationFieldLength === 0) {
					chunks.push(packet.body);
					chunksByteLength += packet.body.byteLength;
				} else {
					chunks.push(packet.body.subarray(adaptationFieldLength));
					chunksByteLength += packet.body.byteLength - adaptationFieldLength;
				}
			}

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
		};
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
	async findIntactPsiSection(section: Section): Promise<Section> {
		if (psiSectionIsIntact(section.payload)) {
			return section;
		}

		const tableId = getPsiTableId(section.payload);
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
					if (copy && getPsiTableId(copy.payload) === tableId) {
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

	async readPacketHeader(pos: number): Promise<TsPacketHeader | null> {
		let slice = this.reader.requestSlice(pos, 4);
		if (isThenable(slice)) slice = await slice;

		if (!slice) {
			return null;
		}

		const syncByte = readU8(slice);
		if (syncByte !== 0x47) {
			return NOT_A_PACKET_HEADER;
		}

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
	}

	async readPacket(pos: number): Promise<TsPacket | null> {
		// Code in here is duplicated from readPacketHeader for performance reasons
		let slice = this.reader.requestSlice(pos, TS_PACKET_SIZE);
		if (isThenable(slice)) slice = await slice;

		if (!slice) {
			return null;
		}

		const bytes = readBytes(slice, TS_PACKET_SIZE);

		const syncByte = bytes[0]!;
		if (syncByte !== 0x47) {
			return { ...NOT_A_PACKET_HEADER, body: bytes.subarray(4) };
		}

		const nextTwoBytes = (bytes[1]! << 8) + bytes[2]!;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const transportErrorIndicator = nextTwoBytes >> 15;
		const payloadUnitStartIndicator = (nextTwoBytes >> 14) & 0x1;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const transportPriority = (nextTwoBytes >> 13) & 0x1;
		const pid = nextTwoBytes & 0x1FFF;

		const nextByte = bytes[3]!;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const transportScramblingControl = nextByte >> 6;
		const adaptationFieldControl = (nextByte >> 4) & 0x3;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const continuityCounter = nextByte & 0xF;

		return {
			payloadUnitStartIndicator,
			pid,
			adaptationFieldControl,
			body: bytes.subarray(4),
		};
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

	const data = section.payload.subarray(
		bytePos,
		// "A value of 0 indicates that the PES packet length is neither specified nor bounded and is allowed only in
		// PES packets whose payload consists of bytes from a video elementary stream contained in
		// transport stream packets."
		pesPacketLength > 0
			? BYTES_UNTIL_END_OF_PES_PACKET_LENGTH + pesPacketLength
			: section.payload.byteLength,
	);

	return {
		...header,
		data,
	};
};

abstract class MpegTsTrackBacking implements InputTrackBacking {
	packetBuffers = new WeakMap<EncodedPacket, PacketBuffer>();
	/** Used for recreating PacketBuffers if necessary. */
	packetSectionStarts = new WeakMap<EncodedPacket, number>();
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
			// Fast path
			const result = await buffer.readNext();
			if (!result) {
				return null;
			}

			// Remove PacketBuffer access from the old packet, it belongs to the next packet now
			this.packetBuffers.delete(packet);

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
			if (isThenable(remaining)) remaining = await remaining;

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

			while (currentPos < endPos) {
				const packetHeader = await demuxer.readPacketHeader(currentPos);
				if (!packetHeader) {
					return null;
				}

				if (packetHeader.pid === pid && packetHeader.payloadUnitStartIndicator === 1) {
					const section = await demuxer.readSection(currentPos, readSectionInFull);
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
				}

				currentPos += demuxer.packetStride;
			}

			return null;
		};

		// Get the first PES packet of the track that has a PTS
		const firstSection = this.elementaryStream.firstSection;
		assert(firstSection);
		const firstTimedPesPacket = await this.getFirstTimedPesPacket();

		const keyPacketsOnly = keyframesOnly && !this.allPacketsAreKeyPackets();
		const isTargetPacket = (packet: TimedSuppliedPacket) => {
			return packet.pts <= searchPts && (!keyPacketsOnly || packet.randomAccessIndicator === 1);
		};

		const retrieveEncodedPacket = async (
			sectionStartPos: number,
			predicate: (packet: TimedSuppliedPacket) => boolean,
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
				if (topPts >= searchPts) {
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
			// Only the packets before the first PES packet with a PTS can come this early
			return !firstTimedPesPacket || firstSection.startPos < firstTimedPesPacket.header.sectionStartPos
				? retrieveEncodedPacket(firstSection.startPos, isTargetPacket)
				: null;
		}

		const firstPesPacketHeader = firstTimedPesPacket.header;

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
					const packetHeader = await demuxer.readPacketHeader(currentPos);
					if (!packetHeader) {
						break outer; // End of file
					}

					if (packetHeader.pid === pid && packetHeader.payloadUnitStartIndicator === 1) {
						const section = await demuxer.readSection(currentPos, false);
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
					}

					currentPos += demuxer.packetStride;
				}
			}

			// Rewind by reorderSize + 1 PES packets (even for audio! To ensure proper durations), but never past the
			// track's first PES packet, since anything before it isn't part of the track
			const startPos = await this.findTimedPesPacketBefore(currentPesHeader.sectionStartPos, reorderSize + 2);

			return retrieveEncodedPacket(startPos, isTargetPacket);
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

							isKeyPacket = context.suppliedPacket?.ptsSectionStartPos === pesHeader.sectionStartPos
								&& context.suppliedPacket.randomAccessIndicator === 1;
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
						const packetHeader = await demuxer.readPacketHeader(currentPos);
						if (!packetHeader) {
							break outer; // End of file
						}

						if (packetHeader.pid === pid && packetHeader.payloadUnitStartIndicator === 1) {
							const section = await demuxer.readSection(currentPos, readSectionsInFull);
							if (section) {
								const nextPesHeader = readPesPacketHeader(demuxer, section);

								if (nextPesHeader && nextPesHeader.pts !== null) {
									pesHeader = nextPesHeader as TimestampedPesPacketHeader;
									pesHeaderSection = section;
									maybeInsertReferencePacket(this.elementaryStream, pesHeader);

									break;
								}
							}
						}

						currentPos += demuxer.packetStride;
					}
				}

				if (bestKeyPesHeader) {
					// Start reading one PES packet with a PTS early: the key packet may begin before its own PES
					// packet (parameter sets in a PES packet of their own), and packets without a PTS may need the
					// time between the two to get theirs. At the end of the stream, rewind a little more to obtain
					// the correct packet duration.
					const startPos = await this.findTimedPesPacketBefore(
						bestKeyPesHeader.sectionStartPos,
						2 + (lookaheadCount === 0 ? reorderSize : 0),
					);

					const encodedPacket = await retrieveEncodedPacket(startPos, isTargetPacket);
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

const containsSeiNalUnit = (codec: VideoCodec, data: Uint8Array) => {
	for (const loc of iterateNalUnitsInAnnexB(data)) {
		const isSei = codec === 'avc'
			? extractNalUnitTypeForAvc(data[loc.offset]!) === AvcNalUnitType.SEI
			: extractNalUnitTypeForHevc(data[loc.offset]!) === HevcNalUnitType.PREFIX_SEI_NUT;

		if (isSei) {
			return true;
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
	nextPts: number | null = null;

	suppliedPacket: SuppliedPacket | null = null;

	constructor(elementaryStream: ElementaryStream, startingPesPacket: PesPacket) {
		this.elementaryStream = elementaryStream;
		this.pid = elementaryStream.pid;
		this.demuxer = elementaryStream.demuxer;
		this.startingPesPacket = startingPesPacket;
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
					const packetHeader = await this.demuxer.readPacketHeader(currentPos);
					if (!packetHeader) {
						return;
					}

					if (packetHeader.pid === this.pid) {
						const nextSection = await this.demuxer.readSection(currentPos, true);
						if (!nextSection) {
							return;
						}

						const nextPesPacket = readPesPacket(this.demuxer, nextSection);
						if (nextPesPacket) {
							pesPacket = nextPesPacket;
							break;
						}
					}

					currentPos += this.demuxer.packetStride;
				}
			}

			this.pesPackets.push(pesPacket);
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

	async markNextPacket() {
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
			// Where the packet's access unit (its AUD) and picture start, and whether parameter sets come before them
			let accessUnitPos: number | null = null;
			let picturePos: number | null = null;
			let parameterSetFound = false;

			// Field-coded AVC (PAFF) codes the two fields of a frame as separate pictures, each with its own access
			// unit. Like MP4 samples, packets should hold whole frames, so we keep a complementary field pair together.
			const avcFieldCoding = elementaryStream.info.avcFieldCoding;
			// The current picture's field, as long as its second field may still follow
			let firstField: AvcSliceField | null = null;
			// Where the packet ends unless the next picture turns out to be the second field
			let pendingBoundaryPos: number | null = null;

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
								) {
									// The second field of the frame, so the packet goes on
									startsNewPicture = false;
									firstField = null;
									pendingBoundaryPos = null;
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
								picturePos = startCodePos;
							}
						}
					} else if (isAccessUnitStart && frameStartFound) {
						if (firstField) {
							// This might begin the second field; the next slice will tell
							pendingBoundaryPos ??= startCodePos;
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
						// End the packet at this start code (the next frame begins here)
						const packetLength = (pendingBoundaryPos ?? startCodePos) - packetStartPos;
						this.seekTo(packetStartPos);
						return this.supplyPacket(packetLength, 0, accessUnitPos, picturePos);
					}

					i += startCodeLength;
				}

				if (remaining < CHUNK_SIZE) {
					// End of stream
					break;
				}
			}

			// End of stream - emit whatever's left as the final packet, unless it holds no picture
			if (frameStartFound) {
				assert(packetStartPos !== null);

				const packetLength = (pendingBoundaryPos ?? this.endPos) - packetStartPos;
				this.seekTo(packetStartPos);
				return this.supplyPacket(packetLength, 0, accessUnitPos, picturePos);
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
						const header = readAdtsFrameHeader(FileSlice.tempFromBytes(headerBytes));

						if (header) {
							this.seekTo(possibleHeaderStartPos);

							let remaining = this.ensureBuffered(header.frameLength);
							if (isThenable(remaining)) remaining = await remaining;

							return this.supplyPacket(
								remaining,
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

						if (result.header) {
							this.seekTo(possibleHeaderStartPos);

							let remaining = this.ensureBuffered(result.header.totalSize);
							if (isThenable(remaining)) remaining = await remaining;

							const duration = result.header.audioSamplesInFrame * MPEG_TS_TIMESCALE
								/ elementaryStream.info.sampleRate;
							return this.supplyPacket(remaining, Math.round(duration));
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

						this.seekTo(possibleSyncPos);

						remaining = this.ensureBuffered(frameSize);
						if (isThenable(remaining)) remaining = await remaining;

						const duration = Math.round(
							AC3_SAMPLES_PER_FRAME * MPEG_TS_TIMESCALE / elementaryStream.info.sampleRate,
						);
						return this.supplyPacket(remaining, duration);
					} else if (codec === 'eac3') {
						if (byte !== 0x0b) {
							continue;
						}

						this.skip(-1);
						const possibleSyncPos = this.currentPos;

						// Need at least 5 bytes for E-AC-3 header parsing (sync word + frmsiz + fscod/numblkscod)
						let remaining = this.ensureBuffered(5);
						if (isThenable(remaining)) remaining = await remaining;

						if (remaining < 5) {
							return;
						}

						const headerBytes = this.readBytes(5);

						if (headerBytes[0] !== 0x0b || headerBytes[1] !== 0x77) {
							this.seekTo(possibleSyncPos + 1);
							continue;
						}

						const frmsiz = ((headerBytes[2]! & 0x07) << 8) | headerBytes[3]!;
						const frameSize = (frmsiz + 1) * 2;
						const fscod = headerBytes[4]! >> 6;
						const numblkscod = fscod === 3 ? 3 : (headerBytes[4]! >> 4) & 0x03;
						const numblks = EAC3_NUMBLKS_TABLE[numblkscod]!;

						this.seekTo(possibleSyncPos);

						remaining = this.ensureBuffered(frameSize);
						if (isThenable(remaining)) remaining = await remaining;

						// Duration = numblks * 256 samples per block
						const samplesPerFrame = numblks * 256;
						const duration = Math.round(
							samplesPerFrame * MPEG_TS_TIMESCALE / elementaryStream.info.sampleRate,
						);
						return this.supplyPacket(remaining, duration);
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

						const duration = Math.round(
							sampleCount * MPEG_TS_TIMESCALE / elementaryStream.info.sampleRate,
						);
						return this.supplyPacket(remaining, duration);
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
	 * Supplies the context with a new encoded packet, beginning at the current position. For video, `accessUnitPos`
	 * and `picturePos` are where the packet's AUD and picture start, if known.
	 */
	supplyPacket(
		packetLength: number,
		intrinsicDuration: number,
		accessUnitPos: number | null = null,
		picturePos: number | null = null,
	) {
		const currentPesPacket = this.getCurrentPesPacket();
		const hasUnusedPts = (pesPacket: PesPacket) => {
			return pesPacket.pts !== null && pesPacket.sectionStartPos > this.lastPtsSectionStartPos;
		};

		// A PES packet's PTS belongs to the first access unit that begins in it. When parameter sets come in a PES
		// packet of their own though, the packet starts before that, so let's look for the PES packet its AUD is in, or
		// else one beginning before its picture. Failing that, take the PTS of the PES packet the packet starts in.
		let ptsPesPacket: PesPacket | null = null;
		const accessUnitStartPos = accessUnitPos ?? this.currentPos;
		let pesPacketPos = this.currentPesPacketPos;

		for (let i = this.currentPesPacketIndex; i < this.pesPackets.length; i++) {
			const pesPacket = this.pesPackets[i]!;
			const pesPacketEndPos = pesPacketPos + pesPacket.data.byteLength;
			if (pesPacketPos > (picturePos ?? accessUnitStartPos)) {
				break;
			}

			if (pesPacketEndPos > accessUnitStartPos && hasUnusedPts(pesPacket)) {
				ptsPesPacket = pesPacket;
				break;
			}

			pesPacketPos = pesPacketEndPos;
		}

		if (!ptsPesPacket && hasUnusedPts(currentPesPacket)) {
			ptsPesPacket = currentPesPacket;
		}

		let pts: number | null;
		if (ptsPesPacket) {
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
		const data = this.readBytes(packetLength);

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

			if (randomAccessIndicator === 1) {
				// Some muxers set random_access_indicator on packets that aren't key frames (on every PES packet, or on
				// the ones carrying a PCR). A picture that is neither IDR/IRAP nor comes with an SEI message (which a
				// recovery point would need) can't be a random access point, so the flag lied and can't be trusted
				// from here on.
				if (
					determineVideoPacketType(codec, decoderConfig, data) !== 'key'
					&& !containsSeiNalUnit(codec, data)
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
	/** How many packets after `lastTimedPacket` were given a timestamp */
	untimedPacketCount = 0;
	/** The time per packet between the last two packets with a timestamp of their own, if it went forward */
	timedPacketSpacing: number | null = null;
	defaultFrameDuration: number | null = null;

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
			// The packet has no known successor (or isn't even placed yet when timestamps are messed up)
			duration = this.lastDuration; // Reasonable heuristic
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

		const previousTimedPacket = this.lastTimedPacket;

		if (
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

		const timedPackets = packets as TimedSuppliedPacket[];
		this.pendingPackets.push(...timedPackets);
		this.untimedPacketCount += packets.length;

		if (nextTimedPacket) {
			this.setLastTimedPacket(nextTimedPacket);
			this.pendingPackets.push(nextTimedPacket);
		} else if (!previousTimedPacket) {
			// Let the packets after these continue from them
			this.lastTimedPacket = timedPackets.at(-1)!;
			this.untimedPacketCount = 0;
		}
	}

	setLastTimedPacket(packet: TimedSuppliedPacket) {
		const previous = this.lastTimedPacket;
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
