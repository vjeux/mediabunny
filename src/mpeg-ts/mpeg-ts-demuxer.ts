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
	AvcSpsInfo,
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
	parseDtsFrame,
	parseDtsCoreFrameHeader,
	parseDtsExssHeader,
	DTS_CORE_FRAME_HEADER_SIZE,
	DTS_EXSS_HEADER_PREFIX_SIZE,
	DTS_EXSS_MAX_HEADER_SIZE,
	iterateNalUnitsInAnnexB,
	removeEmulationPreventionBytes,
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
	binarySearchExact,
	binarySearchLessOrEqual,
	COLOR_PRIMARIES_MAP_INVERSE,
	findLastIndex,
	floorToMultiple,
	isThenable,
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
	createTimestampWrapInfo,
	MpegTsStreamType,
	normalizeWrappedTimestamp,
	MPEG_TS_TIMESCALE,
	TimestampWrapInfo,
	TS_PACKET_SIZE,
} from './mpeg-ts-misc';
import { AC3_SAMPLE_RATES } from '../../shared/ac3-misc';
import { Bitstream } from '../../shared/bitstream';

// Resources:
// ISO/IEC 13818-1

const REGISTRATION_DESCRIPTOR_TAG = 0x05;

// The 'HDMV' and 'HDPR' format identifiers, which mark a program as Blu-ray-derived
const HDMV_FORMAT_IDENTIFIER = 0x48444d56;
const HDPR_FORMAT_IDENTIFIER = 0x48445052;

// 'DTS1', 'DTS2' and 'DTS3' all share this prefix
const DTS_FORMAT_IDENTIFIER_PREFIX = 0x44545300;

// Stream types that only mean DTS within a Blu-ray-derived program
const BLU_RAY_DTS_STREAM_TYPES = new Set<number>([
	MpegTsStreamType.BLU_RAY_DTS_HD,
	MpegTsStreamType.BLU_RAY_DTS_HD_MASTER,
	MpegTsStreamType.BLU_RAY_DTS_EXPRESS_SECONDARY,
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

export class MpegTsDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	elementaryStreams: ElementaryStream[] = [];
	trackBackingEntries: InputTrackBacking[] = [];
	packetOffset = 0;
	packetStride = -1;
	sectionEndPositions: number[] = [];
	seekChunkSize = 5 * 1024 * 1024; // 5 MiB, picked because most HLS segments are below this size
	minReferencePointByteDistance = -1;
	timestampWrapInfo: TimestampWrapInfo | null = null;

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			const lengthToCheck = TS_PACKET_SIZE + 16 + 1;
			let startingSlice = this.reader.requestSlice(0, lengthToCheck);
			if (isThenable(startingSlice)) startingSlice = await startingSlice;
			assert(startingSlice);

			const startingBytes = readBytes(startingSlice, lengthToCheck);

			if (startingBytes[0] === 0x47 && startingBytes[TS_PACKET_SIZE] === 0x47) {
				// Regular MPEG-TS
				this.packetOffset = 0;
				this.packetStride = TS_PACKET_SIZE;
			} else if (startingBytes[0] === 0x47 && startingBytes[TS_PACKET_SIZE + 16] === 0x47) {
				// MPEG-TS with Forward Error Correction
				this.packetOffset = 0;
				this.packetStride = TS_PACKET_SIZE + 16;
			} else if (startingBytes[4] === 0x47 && startingBytes[4 + TS_PACKET_SIZE + 4] === 0x47) {
				// MPEG-2-TS (DVHS)
				this.packetOffset = 4;
				this.packetStride = TS_PACKET_SIZE + 4;
			} else {
				throw new Error('Unreachable.');
			}

			const MIN_REFERENCE_POINT_PACKET_DISTANCE = 256;
			this.minReferencePointByteDistance = MIN_REFERENCE_POINT_PACKET_DISTANCE * this.packetStride;

			let currentPos = this.packetOffset;
			let programMapPid: number | null = null;
			// Some files contain these multiple times, but we only care about their first appearance
			let hasProgramAssociationTable = false;
			let hasProgramMap = false;

			while (true) {
				const packetHeader = await this.readPacketHeader(currentPos);
				if (!packetHeader) {
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
					// Don't care about this PID (anymore)
					currentPos += this.packetStride;
					continue;
				}

				const section = await this.readSection(
					currentPos,
					true,
					!hasProgramMap, // Expect contiguous sections as long as we don't have the PMT
				);
				if (!section) {
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

				if (section.pid === 0 && !hasProgramAssociationTable) {
					const bitstream = new Bitstream(section.payload);
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
							if (programMapPid !== null) {
								throw new Error('Only files with a single program are supported.');
							} else {
								programMapPid = id;
							}
						}
					}

					if (programMapPid === null) {
						throw new Error('Program Association Table must link to a Program Map Table.');
					}

					hasProgramAssociationTable = true;
				} else if ((section.pid === programMapPid || isProbablyProgramMap) && !hasProgramMap) {
					const bitstream = new Bitstream(section.payload);
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
							}

							bitstream.pos = descriptorEndPos;
						}

						let info: ElementaryStream['info'] | null = null;

						// Blu-ray has its own stream types for the DTS extensions
						const effectiveStreamType = isBluRayProgram && BLU_RAY_DTS_STREAM_TYPES.has(streamType)
							? MpegTsStreamType.DTS
							: streamType;

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
						const pesPacket = readPesPacket(this, section);
						if (!pesPacket) {
							throw new Error(
								`Couldn't read first PES packet for Elementary Stream with PID ${elementaryStream.pid}`,
							);
						}

						elementaryStream.firstSection = section;
						elementaryStream.canBeTrustedWithKeyPackets = section.randomAccessIndicator === 1;

						if (this.input._initInput) {
							const initDemuxer = (await this.input._initInput._getDemuxer()) as MpegTsDemuxer;
							const matchingStream = initDemuxer.elementaryStreams.find(x => (
								x.pid === section.pid && x.info.codec === elementaryStream.info.codec && x.initialized
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
										throw new Error(
											'Invalid AVC video stream; could not extract AVCDecoderConfigurationRecord'
											+ ' from any packet.',
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

									break;
								} else if (elementaryStream.info.codec === 'hevc') {
									if (!context.suppliedPacket) {
										throw new Error(
											'Invalid HEVC video stream; could not extract HVCDecoderConfigurationRecord'
											+ ' from first packet.',
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
								throw new Error(
									`Couldn't parse first media packet for Elementary Stream with`
									+ ` PID ${elementaryStream.pid}`,
								);
							}

							if (elementaryStream.info.codec === 'aac') {
								const slice = FileSlice.tempFromBytes(context.suppliedPacket.data);
								const header = readAdtsFrameHeader(slice);
								if (!header) {
									throw new Error(
										'Invalid AAC audio stream; could not read ADTS frame header from first packet.',
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
									throw new Error(
										'Invalid MP3 audio stream; could not read frame header from first packet.',
									);
								}

								elementaryStream.info.numberOfChannels = getMp3ChannelCount(result.header.channel);
								elementaryStream.info.sampleRate = result.header.sampleRate;
							} else if (elementaryStream.info.codec === 'ac3') {
								const frameInfo = parseAc3SyncFrame(context.suppliedPacket.data);
								if (!frameInfo) {
									throw new Error(
										'Invalid AC-3 audio stream; could not read sync frame from first packet.',
									);
								}

								if (frameInfo.fscod === 3) {
									throw new Error(
										'Invalid AC-3 audio stream; reserved sample rate code found in first packet.',
									);
								}

								elementaryStream.info.numberOfChannels
									= AC3_ACMOD_CHANNEL_COUNTS[frameInfo.acmod]! + frameInfo.lfeon;
								elementaryStream.info.sampleRate = AC3_SAMPLE_RATES[frameInfo.fscod]!;
							} else if (elementaryStream.info.codec === 'eac3') {
								const frameInfo = parseEac3SyncFrame(context.suppliedPacket.data);
								if (!frameInfo) {
									throw new Error(
										'Invalid E-AC-3 audio stream; could not read sync frame from first packet.',
									);
								}

								const sampleRate = getEac3SampleRate(frameInfo);
								if (sampleRate === null) {
									throw new Error(
										'Invalid E-AC-3 audio stream; reserved sample rate code found in first packet.',
									);
								}

								elementaryStream.info.numberOfChannels = getEac3ChannelCount(frameInfo);
								elementaryStream.info.sampleRate = sampleRate;
							} else if (elementaryStream.info.codec === 'dts') {
								const frameInfo = parseDtsFrame(context.suppliedPacket.data);
								if (!frameInfo) {
									throw new Error(
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
			const isKnownSectionEnd = binarySearchExact(this.sectionEndPositions, endPos, x => x) !== -1;
			if (isKnownSectionEnd) {
				mustAddSectionEnd = false;
				break;
			}
		}

		if (mustAddSectionEnd) {
			const index = binarySearchLessOrEqual(this.sectionEndPositions, endPos, x => x);
			this.sectionEndPositions.splice(index + 1, 0, endPos);
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

	async readPacketHeader(pos: number): Promise<TsPacketHeader | null> {
		let slice = this.reader.requestSlice(pos, 4);
		if (isThenable(slice)) slice = await slice;

		if (!slice) {
			return null;
		}

		const syncByte = readU8(slice);
		if (syncByte !== 0x47) {
			throw new Error('Invalid TS packet sync byte; the file is likely corrupted.');
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
			throw new Error('Invalid TS packet sync byte; the file is likely corrupted.');
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
		return UNDETERMINED_LANGUAGE;
	}

	getDisposition(): TrackDisposition {
		return {
			...DEFAULT_TRACK_DISPOSITION,
			primary: false,
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

		// Packets without a PTS of their own get theirs from the PES packets with one before (and after) them, so
		// start reading from there
		const startPos = await this.findTimedPesPacketBefore(sectionStartPos, 2);
		const section = await demuxer.readSection(startPos, true);
		assert(section);

		const pesPacket = readPesPacket(demuxer, section);
		assert(pesPacket);

		const context = new PacketReadingContext(this.elementaryStream, pesPacket);
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
			// Only packets right at the start of the track can come this early: those before the first PES packet with
			// a PTS, and leading frames decoded after it but presented before it (open GOPs), so read from there
			return retrieveEncodedPacket(firstSection.startPos, isTargetPacket);
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

			const readSectionsInFull = !this.elementaryStream.canBeTrustedWithKeyPackets;

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
						if (this.elementaryStream.canBeTrustedWithKeyPackets) {
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
			// Where the packet's access unit (its AUD) starts, and whether parameter sets come before it
			let accessUnitPos: number | null = null;
			let parameterSetFound = false;
			// Whether the packet's first slice doesn't begin its picture: the rest of a picture whose start lies before
			// where reading began (like at the start of a file cut from a longer stream)
			let isPictureRest = false;

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
					// first_mb_in_slice / first_slice_segment_in_pic_flag. Make sure all of it is buffered.
					const bytesNeeded = payloadStart + (codec === 'avc' ? AVC_SLICE_HEADER_PEEK_SIZE : 1);
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
							const firstMacroblockInSlice = readExpGolomb(new Bitstream(headerBytes));
							if (!frameStartFound) {
								isPictureRest = firstMacroblockInSlice > 0;
							}

							startsNewPicture = !frameStartFound || firstMacroblockInSlice <= lastFirstMacroblockInSlice;
							lastFirstMacroblockInSlice = firstMacroblockInSlice;
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
						isFrameBoundary = true;
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
						const packetLength = startCodePos - packetStartPos;
						const continuesAccessUnit = isPictureRest || (accessUnitPos === null && isAccessUnitDelimiter);
						this.seekTo(packetStartPos);
						return this.supplyPacket(packetLength, 0, accessUnitPos, continuesAccessUnit);
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

				const packetLength = this.endPos - packetStartPos;
				this.seekTo(packetStartPos);
				return this.supplyPacket(packetLength, 0, accessUnitPos, isPictureRest);
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
	 * Supplies the context with a new encoded packet, beginning at the current position. For video, `accessUnitPos` is
	 * where the packet's AUD starts, if known, and `continuesAccessUnit` whether the packet doesn't begin its access
	 * unit (it lacks the start of its picture, or its AUD).
	 */
	supplyPacket(
		packetLength: number,
		intrinsicDuration: number,
		accessUnitPos: number | null = null,
		continuesAccessUnit = false,
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
		const data = this.readBytes(packetLength);

		let randomAccessIndicator = Math.max(
			currentPesPacket.randomAccessIndicator,
			ptsPesPacket?.randomAccessIndicator ?? 0,
		);

		if (randomAccessIndicator === 0 && !this.elementaryStream.canBeTrustedWithKeyPackets) {
			if (this.elementaryStream.info.type === 'audio') {
				randomAccessIndicator = 1;
			} else {
				if (this.elementaryStream.info.decoderConfig) {
					const isKey = determineVideoPacketType(
						this.elementaryStream.info.codec,
						this.elementaryStream.info.decoderConfig,
						data,
					) === 'key';

					randomAccessIndicator = Number(isKey);
				} else {
					// We're reading packets before the decoder config is determined
				}
			}
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
		const { packets, nextTimedPacket } = await this.readUntimedPackets(firstPacket);
		const sps = !this.lastTimedPacket && nextTimedPacket ? this.getAvcSpsInfo() : null;
		if (!sps || !nextTimedPacket) {
			this.placeUntimedPackets(packets, nextTimedPacket);
			return;
		}

		// Packets before the first one with a timestamp are placed by their picture order too: an IDR picture whose PES
		// packet has no PTS comes before the B-frames after it, an open-GOP I picture after its leading pictures. The
		// time per picture order count comes from the first two packets with a timestamp, so read on to the second.
		const packetAfter = await this.pullPacket();
		const later = packetAfter && packetAfter.pts === null
			? await this.readUntimedPackets(packetAfter)
			: { packets: [], nextTimedPacket: packetAfter as TimedSuppliedPacket | null };

		const secondTimedPacket = later.nextTimedPacket;
		const picOrderCnts = secondTimedPacket
			? getAvcPicOrderCnts([...packets, nextTimedPacket, ...later.packets, secondTimedPacket], sps)
			: null;
		const firstPicOrderCnt = picOrderCnts?.[packets.length] ?? null;
		const secondPicOrderCnt = picOrderCnts?.at(-1) ?? null;
		const ticksPerPicOrderCnt = secondTimedPacket && firstPicOrderCnt !== null && secondPicOrderCnt !== null
			? (secondTimedPacket.pts - nextTimedPacket.pts) / (secondPicOrderCnt - firstPicOrderCnt)
			: null;

		if (
			picOrderCnts
			&& firstPicOrderCnt !== null
			&& ticksPerPicOrderCnt !== null
			&& ticksPerPicOrderCnt > 0
			&& Number.isFinite(ticksPerPicOrderCnt)
			&& packets.every((_, i) => picOrderCnts[i] !== null)
		) {
			packets.forEach((packet, i) => packet.pts = Math.round(
				nextTimedPacket.pts + (picOrderCnts[i]! - firstPicOrderCnt) * ticksPerPicOrderCnt,
			));
			this.pendingPackets.push(...packets as TimedSuppliedPacket[]);
			this.setLastTimedPacket(nextTimedPacket);
			this.pendingPackets.push(nextTimedPacket);
		} else {
			this.placeUntimedPackets(packets, nextTimedPacket);
		}

		this.placeUntimedPackets(later.packets, secondTimedPacket);
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
