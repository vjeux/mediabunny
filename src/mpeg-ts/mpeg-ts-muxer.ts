/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { buildAdtsHeaderTemplate, parseAacAudioSpecificConfig, writeAdtsFrameLength } from '../../shared/aac-misc';
import { validateAudioChunkMetadata, validateVideoChunkMetadata } from '../codec';
import {
	AC3_REGISTRATION_DESCRIPTOR,
	AvcDecoderConfigurationRecord,
	AvcNalUnitType,
	concatNalUnitsInAnnexB,
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
	EAC3_REGISTRATION_DESCRIPTOR,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	HevcDecoderConfigurationRecord,
	HevcNalUnitType,
	iterateNalUnitsInAnnexB,
	iterateNalUnitsInLengthPrefixed,
} from '../codec-data';
import { Bitstream } from '../../shared/bitstream';
import {
	assert,
	promiseWithResolvers,
	setUint24,
	toDataView,
	toUint8Array,
	UNDETERMINED_LANGUAGE,
	roundToDivisor,
	Queue,
} from '../misc';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack, OutputTrack, OutputVideoTrack } from '../output';
import { MpegTsOutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { Writer } from '../writer';
import {
	buildMpegTsMimeType,
	computeMpegTsCrc32,
	MpegTsStreamType,
	secondsToMpegTsTimestamp,
	TS_PACKET_SIZE,
} from './mpeg-ts-misc';

// Resources:
// ISO/IEC 13818-1

const PAT_PID = 0x0000;
const PMT_PID = 0x1000;
const FIRST_TRACK_PID = 0x0100;

const VIDEO_STREAM_ID_BASE = 0xE0;
const AUDIO_STREAM_ID_BASE = 0xC0;

const AVC_AUD_NAL = new Uint8Array([0x09, 0xF0]);
const HEVC_AUD_NAL = new Uint8Array([0x46, 0x01]);

type MpegTsTrackData = {
	track: OutputVideoTrack | OutputAudioTrack;
	pid: number;
	streamType: MpegTsStreamType;
	streamId: number;
	codecString: string;
	timestampProcessingQueue: QueuedPacket[];
	packetQueue: Queue<QueuedPacket>;
	inputIsAnnexB: boolean | null;
	inputIsAdts: boolean | null;
	avcDecoderConfig: AvcDecoderConfigurationRecord | null;
	hevcDecoderConfig: HevcDecoderConfigurationRecord | null;
	adtsHeader: Uint8Array | null;
	adtsHeaderBitstream: Bitstream | null;
	firstPacketWritten: boolean;
	closed: boolean;
};

type QueuedPacket = {
	data: Uint8Array;
	presentationTimestamp: number;
	decodeTimestamp: number | null;
	isKeyframe: boolean;
};

export class MpegTsMuxer extends Muxer {
	private format: MpegTsOutputFormat;
	private timestampOffset: number;
	private writer!: Writer;

	private trackDatas: MpegTsTrackData[] = [];
	private tablesWritten = false;
	private continuityCounters = new Map<number, number>();
	private packetBuffer = new Uint8Array(TS_PACKET_SIZE);
	private packetView = toDataView(this.packetBuffer);
	private allTracksKnown = promiseWithResolvers();

	private videoTrackIndex = 0;
	private audioTrackIndex = 0;

	private adaptationFieldBuffer = new Uint8Array(184);
	private payloadBuffer = new Uint8Array(184);

	constructor(output: Output, format: MpegTsOutputFormat) {
		super(output);

		this.format = format;
		this.timestampOffset = format._options.timestampOffset ?? 0;
	}

	async start() {
		const release = await this.mutex.acquire();

		this.writer = await this.output._getRootWriter(true);

		release();
	}

	async getMimeType() {
		await this.allTracksKnown.promise;
		return buildMpegTsMimeType(this.trackDatas.map(x => x.codecString));
	}

	private getVideoTrackData(track: OutputVideoTrack, meta?: EncodedVideoChunkMetadata) {
		const existingTrackData = this.trackDatas.find(x => x.track === track);
		if (existingTrackData) {
			return existingTrackData;
		}

		validateVideoChunkMetadata(meta, track.source._codec);
		assert(meta?.decoderConfig);

		const codec = track.source._codec;
		assert(codec === 'avc' || codec === 'hevc');

		const streamType = codec === 'avc'
			? MpegTsStreamType.AVC
			: MpegTsStreamType.HEVC;
		const pid = FIRST_TRACK_PID + this.trackDatas.length;
		const streamId = VIDEO_STREAM_ID_BASE + this.videoTrackIndex++;

		const newTrackData: MpegTsTrackData = {
			track,
			pid,
			streamType,
			streamId,
			codecString: meta.decoderConfig.codec,
			timestampProcessingQueue: [],
			packetQueue: new Queue(),
			inputIsAnnexB: null,
			inputIsAdts: null,
			avcDecoderConfig: null,
			hevcDecoderConfig: null,
			adtsHeader: null,
			adtsHeaderBitstream: null,
			firstPacketWritten: false,
			closed: false,
		};

		this.trackDatas.push(newTrackData);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	private getAudioTrackData(track: OutputAudioTrack, meta?: EncodedAudioChunkMetadata) {
		const existingTrackData = this.trackDatas.find(x => x.track === track);
		if (existingTrackData) {
			return existingTrackData;
		}

		validateAudioChunkMetadata(meta, track.source._codec);
		assert(meta?.decoderConfig);

		const codec = track.source._codec;
		assert(codec === 'aac' || codec === 'mp3' || codec === 'ac3' || codec === 'eac3' || codec === 'dts');

		let streamType: MpegTsStreamType;
		let streamId: number;

		switch (codec) {
			case 'aac': {
				streamType = MpegTsStreamType.AAC;
				streamId = AUDIO_STREAM_ID_BASE + this.audioTrackIndex++;
			}; break;

			case 'mp3': {
				// H.222.0 Table 2-34: 0x03 is ISO/IEC 11172-3 (MPEG-1) audio, 0x04 is ISO/IEC 13818-3 audio, which
				// covers the MPEG-2 low sampling frequencies (below 32 kHz). FFmpeg makes the same distinction.
				streamType = meta.decoderConfig.sampleRate < 32000
					? MpegTsStreamType.MP3_MPEG2
					: MpegTsStreamType.MP3_MPEG1;
				streamId = AUDIO_STREAM_ID_BASE + this.audioTrackIndex++;
			}; break;

			case 'ac3': {
				streamType = MpegTsStreamType.AC3_SYSTEM_A;
				streamId = 0xbd;
			}; break;

			case 'eac3': {
				streamType = MpegTsStreamType.EAC3_SYSTEM_A;
				streamId = 0xbd;
			}; break;

			case 'dts': {
				streamType = MpegTsStreamType.DTS;
				streamId = 0xbd;
			}; break;
		}

		const pid = FIRST_TRACK_PID + this.trackDatas.length;

		const newTrackData: MpegTsTrackData = {
			track,
			pid,
			streamType,
			streamId,
			codecString: meta.decoderConfig.codec,
			timestampProcessingQueue: [],
			packetQueue: new Queue(),
			inputIsAnnexB: null,
			inputIsAdts: null,
			avcDecoderConfig: null,
			hevcDecoderConfig: null,
			adtsHeader: null,
			adtsHeaderBitstream: null,
			firstPacketWritten: false,
			closed: false,
		};

		this.trackDatas.push(newTrackData);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	async addEncodedVideoPacket(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getVideoTrackData(track, meta);

			this.validateTimestamp(
				trackData.track,
				packet.timestamp,
				packet.type === 'key',
			);

			const preparedData = this.prepareVideoPacket(trackData, packet, meta);

			if (packet.type === 'key') {
				await this.flushTimestampQueue(trackData);
			}

			trackData.timestampProcessingQueue.push({
				data: preparedData,
				// Constrain the timestamp to the frame rate
				presentationTimestamp: track.metadata.frameRate !== undefined
					? roundToDivisor(packet.timestamp, track.metadata.frameRate)
					: packet.timestamp,
				decodeTimestamp: null,
				isKeyframe: packet.type === 'key',
			});
		} finally {
			release();
		}
	}

	async addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getAudioTrackData(track, meta);

			this.validateTimestamp(
				trackData.track,
				packet.timestamp,
				packet.type === 'key',
			);

			const preparedData = this.prepareAudioPacket(trackData, packet, meta);

			if (packet.type === 'key') {
				await this.flushTimestampQueue(trackData);
			}

			trackData.timestampProcessingQueue.push({
				data: preparedData,
				presentationTimestamp: packet.timestamp,
				decodeTimestamp: null,
				isKeyframe: packet.type === 'key',
			});
		} finally {
			release();
		}
	}

	async addSubtitleCue(): Promise<void> {
		throw new Error('MPEG-TS does not support subtitles.');
	}

	private prepareVideoPacket(
		trackData: MpegTsTrackData,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	): Uint8Array {
		const codec = (trackData.track as OutputVideoTrack).source._codec;
		const description = meta?.decoderConfig?.description;

		if (trackData.inputIsAnnexB === null) {
			// This is the first packet
			trackData.inputIsAnnexB = !description;
		}

		if (!trackData.inputIsAnnexB && description) {
			// Always take the parameter sets of the latest decoder config, since they're written in front of every key
			// frame and a config can change mid-stream (e.g. when the browser replaces a failing hardware encoder)
			const bytes = toUint8Array(description);
			if (codec === 'avc') {
				trackData.avcDecoderConfig = deserializeAvcDecoderConfigurationRecord(bytes)
					?? trackData.avcDecoderConfig;
			} else {
				trackData.hevcDecoderConfig = deserializeHevcDecoderConfigurationRecord(bytes)
					?? trackData.hevcDecoderConfig;
			}
		}

		if (trackData.inputIsAnnexB) {
			return this.prepareAnnexBVideoPacket(packet.data, codec as 'avc' | 'hevc');
		} else {
			return this.prepareLengthPrefixedVideoPacket(trackData, packet, codec as 'avc' | 'hevc');
		}
	}

	private prepareAnnexBVideoPacket(data: Uint8Array, codec: 'avc' | 'hevc'): Uint8Array {
		const nalUnits: Uint8Array[] = [];

		for (const loc of iterateNalUnitsInAnnexB(data)) {
			const nalUnit = data.subarray(loc.offset, loc.offset + loc.length);
			const isAud = codec === 'avc'
				? extractNalUnitTypeForAvc(nalUnit[0]!) === AvcNalUnitType.AUD
				: extractNalUnitTypeForHevc(nalUnit[0]!) === HevcNalUnitType.AUD_NUT;

			if (!isAud) {
				nalUnits.push(nalUnit);
			}
		}

		// Pretend the AUD
		const aud = codec === 'avc'
			? AVC_AUD_NAL
			: HEVC_AUD_NAL;
		nalUnits.unshift(aud);

		return concatNalUnitsInAnnexB(nalUnits);
	}

	private prepareLengthPrefixedVideoPacket(
		trackData: MpegTsTrackData,
		packet: EncodedPacket,
		codec: 'avc' | 'hevc',
	): Uint8Array {
		const data = packet.data;
		const lengthSize = codec === 'avc'
			? (trackData.avcDecoderConfig!.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4
			: (trackData.hevcDecoderConfig!.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4;

		const nalUnits: Uint8Array[] = [];

		for (const loc of iterateNalUnitsInLengthPrefixed(data, lengthSize)) {
			const nalUnit = data.subarray(loc.offset, loc.offset + loc.length);
			const isAud = codec === 'avc'
				? extractNalUnitTypeForAvc(nalUnit[0]!) === AvcNalUnitType.AUD
				: extractNalUnitTypeForHevc(nalUnit[0]!) === HevcNalUnitType.AUD_NUT;

			if (!isAud) {
				nalUnits.push(nalUnit);
			}
		}

		if (packet.type === 'key') {
			// Add whichever parameter sets are missing, so that decoding can start at this packet
			const getNalUnitType = (nalUnit: Uint8Array) => codec === 'avc'
				? extractNalUnitTypeForAvc(nalUnit[0]!)
				: extractNalUnitTypeForHevc(nalUnit[0]!);

			// In the order in which they depend on each other
			let parameterSets: { type: number; nalUnits: Uint8Array[] }[];
			if (codec === 'avc') {
				const config = trackData.avcDecoderConfig!;
				parameterSets = [
					{ type: AvcNalUnitType.SPS, nalUnits: config.sequenceParameterSets },
					{ type: AvcNalUnitType.PPS, nalUnits: config.pictureParameterSets },
				];
			} else {
				const config = trackData.hevcDecoderConfig!;
				const types = [HevcNalUnitType.VPS_NUT, HevcNalUnitType.SPS_NUT, HevcNalUnitType.PPS_NUT];
				parameterSets = types.map(type => ({
					type,
					nalUnits: config.arrays.filter(x => x.nalUnitType === type).flatMap(x => x.nalUnits),
				}));
			}

			for (let i = 0; i < parameterSets.length; i++) {
				const { type, nalUnits: configNalUnits } = parameterSets[i]!;
				if (nalUnits.some(x => getNalUnitType(x) === type)) {
					continue;
				}

				// Insert them before the parameter sets that may depend on them, and before everything else
				const earlierTypes = parameterSets.slice(0, i + 1).map(x => x.type);
				let index = nalUnits.findIndex(x => !earlierTypes.includes(getNalUnitType(x)));
				if (index === -1) {
					index = nalUnits.length;
				}

				nalUnits.splice(index, 0, ...configNalUnits);
			}
		}

		// Prepend the AUD
		const aud = codec === 'avc'
			? AVC_AUD_NAL
			: HEVC_AUD_NAL;
		nalUnits.unshift(aud);

		return concatNalUnitsInAnnexB(nalUnits);
	}

	private prepareAudioPacket(
		trackData: MpegTsTrackData,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	): Uint8Array {
		const codec = (trackData.track as OutputAudioTrack).source._codec;

		if (codec === 'mp3' || codec === 'ac3' || codec === 'eac3' || codec === 'dts') {
			// We're good
			return packet.data;
		}

		if (trackData.inputIsAdts === null) {
			// It's the first packet
			const description = meta?.decoderConfig?.description;
			trackData.inputIsAdts = !description;

			if (!trackData.inputIsAdts) {
				const config = parseAacAudioSpecificConfig(toUint8Array(description!));
				const template = buildAdtsHeaderTemplate(config);
				trackData.adtsHeader = template.header;
				trackData.adtsHeaderBitstream = template.bitstream;
			}
		}

		if (trackData.inputIsAdts) {
			return packet.data;
		}

		assert(trackData.adtsHeader);
		assert(trackData.adtsHeaderBitstream);

		const header = trackData.adtsHeader;
		const frameLength = packet.data.byteLength + header.byteLength;
		writeAdtsFrameLength(trackData.adtsHeaderBitstream, frameLength);

		const result = new Uint8Array(frameLength);
		result.set(header, 0);
		result.set(packet.data, header.byteLength);

		return result;
	}

	private allTracksAreKnown() {
		for (const track of this.output.tracks) {
			if (!track.source._closed && !this.trackDatas.some(x => x.track === track)) {
				return false;
			}
		}

		return true;
	}

	private async flushTimestampQueue(trackData: MpegTsTrackData, alsoInterleave = true) {
		if (trackData.timestampProcessingQueue.length === 0) {
			return;
		}

		const sortedTimestamps = trackData.timestampProcessingQueue
			.map(packet => packet.presentationTimestamp)
			.sort((a, b) => a - b);

		for (let i = 0; i < trackData.timestampProcessingQueue.length; i++) {
			const queuedPacket = trackData.timestampProcessingQueue[i]!;
			queuedPacket.decodeTimestamp = sortedTimestamps[i]!;
			trackData.packetQueue.push(queuedPacket);
		}

		trackData.timestampProcessingQueue.length = 0;

		if (alsoInterleave) {
			await this.interleavePackets();
		}
	}

	private async interleavePackets(isFinalCall = false) {
		if (!this.tablesWritten) {
			if (!this.allTracksAreKnown() && !isFinalCall) {
				return;
			}

			this.writeTables();
		}

		outer:
		while (true) {
			let trackWithMinTimestamp: MpegTsTrackData | null = null;
			let minTimestamp = Infinity;

			for (const trackData of this.trackDatas) {
				if (
					!isFinalCall
					&& trackData.packetQueue.length === 0
					&& !trackData.closed
				) {
					break outer;
				}

				if (
					trackData.packetQueue.length > 0
					&& trackData.packetQueue.peek()!.presentationTimestamp < minTimestamp
				) {
					trackWithMinTimestamp = trackData;
					minTimestamp = trackData.packetQueue.peek()!.presentationTimestamp;
				}
			}

			if (!trackWithMinTimestamp) {
				break;
			}

			const queuedPacket = trackWithMinTimestamp.packetQueue.shift()!;
			this.writePesPacket(trackWithMinTimestamp, queuedPacket);
		}

		if (!isFinalCall) {
			await this.writer.flush();
		}
	}

	private writeTables() {
		assert(!this.tablesWritten);

		this.writePsiSection(PAT_PID, PAT_SECTION);
		this.writePsiSection(PMT_PID, buildPmt(this.trackDatas));

		this.tablesWritten = true;
	}

	private writePsiSection(pid: number, section: Uint8Array) {
		let offset = 0;
		let isFirst = true;

		// Long PSI sections might span more than one TS packet
		while (offset < section.length) {
			const pointerFieldSize = isFirst ? 1 : 0;
			const availablePayload = 184 - pointerFieldSize;
			const remainingData = section.length - offset;
			const chunkSize = Math.min(availablePayload, remainingData);

			let payload: Uint8Array;
			if (isFirst) {
				payload = this.payloadBuffer.subarray(0, 1 + chunkSize);
				payload[0] = 0x00; // pointer_field
				payload.set(section.subarray(offset, offset + chunkSize), 1);
			} else {
				payload = section.subarray(offset, offset + chunkSize);
			}

			this.writeTsPacket(pid, isFirst, null, payload);

			offset += chunkSize;
			isFirst = false;
		}
	}

	private writePesPacket(trackData: MpegTsTrackData, queuedPacket: QueuedPacket) {
		const includeDts = trackData.track.type === 'video';
		const headerDataLength = includeDts ? 10 : 5;
		const pesHeaderBuffer = new Uint8Array(9 + headerDataLength);
		const pesView = toDataView(pesHeaderBuffer);
		const ptsDtsBitstream = new Bitstream(pesHeaderBuffer.subarray(9));

		setUint24(pesView, 0, 0x000001, false); // packet_start_code_prefix
		pesHeaderBuffer[3] = trackData.streamId; // stream_id

		const pesPacketLength = trackData.track.type === 'video'
			? 0 // Unbounded
			: Math.min(8 + queuedPacket.data.length, 0xFFFF); // Required for audio for some reason
		pesView.setUint16(4, pesPacketLength, false);

		// '10' marker, PES_scrambling_control=0, PES_priority=0,
		// data_alignment_indicator=1, copyright=0, original_or_copy=0
		pesView.setUint8(6, 0x84);
		pesView.setUint8(7, includeDts ? 0xC0 : 0x80); // PTS_DTS_flags, other flags=0
		pesView.setUint8(8, headerDataLength); // PES_header_data_length

		const pts = secondsToMpegTsTimestamp(queuedPacket.presentationTimestamp + this.timestampOffset);
		ptsDtsBitstream.pos = 0;
		ptsDtsBitstream.writeBits(4, includeDts ? 0b0011 : 0b0010); // marker
		ptsDtsBitstream.writeBits(3, Math.floor(pts / 2 ** 30)); // PTS[32:30]
		ptsDtsBitstream.writeBits(1, 1); // marker_bit
		ptsDtsBitstream.writeBits(15, Math.floor(pts / 2 ** 15) % 2 ** 15); // PTS[29:15]
		ptsDtsBitstream.writeBits(1, 1); // marker_bit
		ptsDtsBitstream.writeBits(15, pts % 2 ** 15); // PTS[14:0]
		ptsDtsBitstream.writeBits(1, 1); // marker_bit

		if (includeDts) {
			assert(queuedPacket.decodeTimestamp !== null);

			const dts = secondsToMpegTsTimestamp(queuedPacket.decodeTimestamp + this.timestampOffset);
			ptsDtsBitstream.writeBits(4, 0b0001);
			ptsDtsBitstream.writeBits(3, Math.floor(dts / 2 ** 30)); // DTS[32:30]
			ptsDtsBitstream.writeBits(1, 1); // marker_bit
			ptsDtsBitstream.writeBits(15, Math.floor(dts / 2 ** 15) % 2 ** 15); // DTS[29:15]
			ptsDtsBitstream.writeBits(1, 1); // marker_bit
			ptsDtsBitstream.writeBits(15, dts % 2 ** 15); // DTS[14:0]
			ptsDtsBitstream.writeBits(1, 1); // marker_bit
		}

		const totalLength = pesHeaderBuffer.length + queuedPacket.data.length;
		let offset = 0;
		let isFirstTsPacket = true;

		while (offset < totalLength) {
			const pusi = isFirstTsPacket;
			const remainingData = totalLength - offset;

			const randomAccessIndicator = isFirstTsPacket && queuedPacket.isKeyframe;
			const discontinuityIndicator = isFirstTsPacket && !trackData.firstPacketWritten;
			const basePaddingNeeded = Math.max(0, 184 - remainingData);

			let adaptationFieldSize: number;
			if (randomAccessIndicator || discontinuityIndicator) {
				// We need at least two bytes
				adaptationFieldSize = Math.max(2, basePaddingNeeded);
			} else {
				adaptationFieldSize = basePaddingNeeded;
			}

			let adaptationField: Uint8Array | null = null;
			if (adaptationFieldSize > 0) {
				const buf = this.adaptationFieldBuffer;

				if (adaptationFieldSize === 1) {
					buf[0] = 0; // adaptation_field_length
				} else {
					buf[0] = adaptationFieldSize - 1; // adaptation_field_length
					buf[1]
						= (Number(discontinuityIndicator) << 7) // discontinuity_indicator
							| (Number(randomAccessIndicator) << 6); // random_access_indicator
					buf.fill(0xFF, 2, adaptationFieldSize); // stuffing_bytes
				}

				adaptationField = buf.subarray(0, adaptationFieldSize);
			}

			const payloadSize = Math.min(184 - adaptationFieldSize, remainingData);
			const payload = this.payloadBuffer.subarray(0, payloadSize);

			let payloadOffset = 0;
			if (offset < pesHeaderBuffer.length) {
				const headerBytes = Math.min(pesHeaderBuffer.length - offset, payloadSize);
				payload.set(pesHeaderBuffer.subarray(offset, offset + headerBytes), 0);
				payloadOffset = headerBytes;
			}

			const dataStart = Math.max(0, offset - pesHeaderBuffer.length);
			const dataEnd = dataStart + (payloadSize - payloadOffset);
			if (payloadOffset < payloadSize) {
				payload.set(queuedPacket.data.subarray(dataStart, dataEnd), payloadOffset);
			}

			this.writeTsPacket(trackData.pid, pusi, adaptationField, payload);

			offset += payloadSize;
			isFirstTsPacket = false;
		}

		trackData.firstPacketWritten = true;
	}

	private writeTsPacket(
		pid: number,
		pusi: boolean,
		adaptationField: Uint8Array | null,
		payload: Uint8Array,
	) {
		const cc = this.continuityCounters.get(pid) ?? 0;
		const hasPayload = payload.length > 0;
		const adaptCtrl = adaptationField
			? (hasPayload ? 0b11 : 0b10)
			: (hasPayload ? 0b01 : 0b00);

		this.packetBuffer[0] = 0x47; // sync_byte
		this.packetView.setUint16(1, (pusi ? 0x4000 : 0) | (pid & 0x1FFF), false); // TEI=0, PUSI, priority=0, PID
		// scrambling=0, adaptation_field_control, continuity_counter
		this.packetBuffer[3] = (adaptCtrl << 4) | (cc & 0x0F);

		if (hasPayload) {
			this.continuityCounters.set(pid, (cc + 1) & 0x0F);
		}

		let offset = 4;

		if (adaptationField) {
			this.packetBuffer.set(adaptationField, offset);
			offset += adaptationField.length;
		}

		this.packetBuffer.set(payload, offset);
		offset += payload.length;

		if (offset < TS_PACKET_SIZE) {
			this.packetBuffer.fill(0xFF, offset); // stuffing_bytes
		}

		const startPos = this.writer.getPos();
		this.writer.write(this.packetBuffer);

		if (this.format._options.onPacket) {
			this.format._options.onPacket(this.packetBuffer.slice(), startPos);
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	override async onTrackClose(track: OutputTrack) {
		const release = await this.mutex.acquire();

		const trackData = this.trackDatas.find(x => x.track === track);
		if (trackData) {
			trackData.closed = true;
			await this.flushTimestampQueue(trackData, false);
		}

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		await this.interleavePackets();

		release();
	}

	async finalize() {
		const release = await this.mutex.acquire();

		this.allTracksKnown.resolve();

		for (const trackData of this.trackDatas) {
			trackData.closed = true;
			await this.flushTimestampQueue(trackData, false);
		}

		await this.interleavePackets(true);

		release();
	}
}

const PAT_SECTION = new Uint8Array(16);
{
	const view = toDataView(PAT_SECTION);
	PAT_SECTION[0] = 0x00; // table_id
	view.setUint16(1, 0xB00D, false); // section_syntax_indicator=1, '0', reserved=11, section_length=13
	view.setUint16(3, 0x0001, false); // transport_stream_id
	PAT_SECTION[5] = 0xC1; // reserved=11, version_number=0, current_next_indicator=1
	PAT_SECTION[6] = 0x00; // section_number
	PAT_SECTION[7] = 0x00; // last_section_number
	view.setUint16(8, 0x0001, false); // program_number
	view.setUint16(10, 0xE000 | (PMT_PID & 0x1FFF), false); // reserved=111, program_map_PID
	view.setUint32(12, computeMpegTsCrc32(PAT_SECTION.subarray(0, 12)), false); // CRC_32
}

const getEsDescriptors = (trackData: MpegTsTrackData) => {
	const descriptors: Uint8Array[] = [];

	if (trackData.streamType === MpegTsStreamType.AC3_SYSTEM_A) {
		descriptors.push(AC3_REGISTRATION_DESCRIPTOR);
	} else if (trackData.streamType === MpegTsStreamType.EAC3_SYSTEM_A) {
		descriptors.push(EAC3_REGISTRATION_DESCRIPTOR);
	}

	const { languageCode, disposition } = trackData.track.metadata;
	// audio_type values per ISO/IEC 13818-1, mapped like FFmpeg does
	const audioType = disposition?.hearingImpaired
		? 0x02
		: disposition?.visuallyImpaired
			? 0x03
			: 0x00;

	if ((languageCode !== undefined && languageCode !== UNDETERMINED_LANGUAGE) || audioType !== 0x00) {
		const language = languageCode ?? UNDETERMINED_LANGUAGE;
		descriptors.push(new Uint8Array([
			0x0a, // ISO_639_language_descriptor
			4,
			language.charCodeAt(0),
			language.charCodeAt(1),
			language.charCodeAt(2),
			audioType,
		]));
	}

	return descriptors;
};

const buildPmt = (trackDatas: MpegTsTrackData[]) => {
	const esDescriptors = trackDatas.map(getEsDescriptors);

	let totalEsBytes = 0;
	for (const descriptors of esDescriptors) {
		totalEsBytes += 5;

		for (const descriptor of descriptors) {
			totalEsBytes += descriptor.length;
		}
	}

	const sectionLength = 9 + totalEsBytes + 4;
	const section = new Uint8Array(3 + sectionLength - 4);
	const view = toDataView(section);

	section[0] = 0x02; // table_id
	// section_syntax_indicator=1, '0', reserved=11, section_length
	view.setUint16(1, 0xB000 | (sectionLength & 0x0FFF), false);
	view.setUint16(3, 0x0001, false); // program_number
	section[5] = 0xC1; // reserved=11, version_number=0, current_next_indicator=1
	section[6] = 0x00; // section_number
	section[7] = 0x00; // last_section_number
	view.setUint16(8, 0xE000 | 0x1FFF, false); // reserved=111, PCR_PID=0x1FFF (none)
	view.setUint16(10, 0xF000, false); // reserved=1111, program_info_length=0

	let offset = 12;
	for (let i = 0; i < trackDatas.length; i++) {
		const trackData = trackDatas[i]!;
		const descriptors = esDescriptors[i]!;

		section[offset++] = trackData.streamType; // stream_type
		view.setUint16(offset, 0xE000 | (trackData.pid & 0x1FFF), false); // reserved=111, elementary_PID
		offset += 2;

		const esInfoLength = descriptors.reduce((sum, descriptor) => sum + descriptor.length, 0);
		view.setUint16(offset, 0xF000 | esInfoLength, false); // reserved=1111, ES_info_length
		offset += 2;

		for (const descriptor of descriptors) {
			section.set(descriptor, offset);
			offset += descriptor.length;
		}
	}

	const crc = computeMpegTsCrc32(section);
	const result = new Uint8Array(section.length + 4);
	result.set(section, 0);
	toDataView(result).setUint32(section.length, crc, false); // CRC_32

	return result;
};
