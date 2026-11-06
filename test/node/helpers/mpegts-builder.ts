// Byte builders for MPEG-2 Transport Stream test inputs: TS packets, PSI sections (PAT/PMT) with CRC-32, PES packets,
// and minimal elementary stream payloads (ADTS, AC-3/E-AC-3, MPEG audio, H.264/HEVC NAL units). Rules follow ISO/IEC
// 13818-1 as implemented by FFmpeg's mpegts.c/mpegtsenc.c and Chromium's media/formats/mp2t.

import { Bitstream } from '../../../shared/bitstream.js';
import { writeExpGolomb } from '../../../src/misc.js';

export const TS_PACKET_SIZE = 188;

export const concatBytes = (parts: Uint8Array[]) => {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
};

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let crc = n << 24;
		for (let k = 0; k < 8; k++) {
			crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) : (crc << 1);
		}
		table[n] = crc >>> 0;
	}
	return table;
})();

/** CRC-32/MPEG-2 (polynomial 0x04C11DB7, initial value 0xFFFFFFFF, no reflection, no final XOR). */
export const crc32Mpeg2 = (data: Uint8Array) => {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = ((crc << 8) ^ CRC_TABLE[(crc >>> 24) ^ byte]!) >>> 0;
	}
	return crc;
};

export type SectionOptions = {
	tableId: number;
	tableIdExtension: number;
	body: Uint8Array;
	version?: number;
	currentNext?: 0 | 1;
	sectionNumber?: number;
	lastSectionNumber?: number;
	/** Corrupts the CRC when set. */
	badCrc?: boolean;
};

/** Builds a long-form PSI section (section_syntax_indicator = 1), CRC included. */
export const buildSection = (options: SectionOptions) => {
	const sectionLength = 5 + options.body.byteLength + 4;
	const section = new Uint8Array(3 + sectionLength);
	section[0] = options.tableId;
	section[1] = 0xb0 | (sectionLength >> 8);
	section[2] = sectionLength & 0xff;
	section[3] = options.tableIdExtension >> 8;
	section[4] = options.tableIdExtension & 0xff;
	section[5] = 0xc0 | ((options.version ?? 0) << 1) | (options.currentNext ?? 1);
	section[6] = options.sectionNumber ?? 0;
	section[7] = options.lastSectionNumber ?? 0;
	section.set(options.body, 8);

	let crc = crc32Mpeg2(section.subarray(0, section.length - 4));
	if (options.badCrc) {
		crc ^= 0xdeadbeef;
	}
	new DataView(section.buffer).setUint32(section.length - 4, crc >>> 0);

	return section;
};

export const buildPatSection = (
	programs: { programNumber: number; pid: number }[],
	options: { transportStreamId?: number; version?: number } = {},
) => {
	const body = new Uint8Array(4 * programs.length);
	programs.forEach((program, i) => {
		body[4 * i] = program.programNumber >> 8;
		body[4 * i + 1] = program.programNumber & 0xff;
		body[4 * i + 2] = 0xe0 | (program.pid >> 8);
		body[4 * i + 3] = program.pid & 0xff;
	});

	return buildSection({
		tableId: 0x00,
		tableIdExtension: options.transportStreamId ?? 1,
		body,
		version: options.version,
	});
};

export type PmtStream = {
	streamType: number;
	pid: number;
	descriptors?: Uint8Array[];
};

export const buildPmtSection = (options: {
	programNumber?: number;
	pcrPid?: number;
	programDescriptors?: Uint8Array[];
	streams: PmtStream[];
	version?: number;
}) => {
	const programInfo = concatBytes(options.programDescriptors ?? []);
	const parts: Uint8Array[] = [];

	const header = new Uint8Array(4);
	const pcrPid = options.pcrPid ?? 0x1fff;
	header[0] = 0xe0 | (pcrPid >> 8);
	header[1] = pcrPid & 0xff;
	header[2] = 0xf0 | (programInfo.byteLength >> 8);
	header[3] = programInfo.byteLength & 0xff;
	parts.push(header, programInfo);

	for (const stream of options.streams) {
		const esInfo = concatBytes(stream.descriptors ?? []);
		const entry = new Uint8Array(5);
		entry[0] = stream.streamType;
		entry[1] = 0xe0 | (stream.pid >> 8);
		entry[2] = stream.pid & 0xff;
		entry[3] = 0xf0 | (esInfo.byteLength >> 8);
		entry[4] = esInfo.byteLength & 0xff;
		parts.push(entry, esInfo);
	}

	return buildSection({
		tableId: 0x02,
		tableIdExtension: options.programNumber ?? 1,
		body: concatBytes(parts),
		version: options.version,
	});
};

export const descriptor = (tag: number, payload: ArrayLike<number>) => {
	const result = new Uint8Array(2 + payload.length);
	result[0] = tag;
	result[1] = payload.length;
	result.set(payload, 2);
	return result;
};

export const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));

export const registrationDescriptor = (formatIdentifier: string) => descriptor(0x05, ascii(formatIdentifier));
export const languageDescriptor = (language: string, audioType = 0) => {
	return descriptor(0x0a, [...ascii(language), audioType]);
};
/** DVB AC-3 descriptor (ETSI EN 300 468 Annex D) with no optional fields. */
export const dvbAc3Descriptor = () => descriptor(0x6a, [0x00]);
/** DVB enhanced AC-3 descriptor (ETSI EN 300 468 Annex D) with no optional fields. */
export const dvbEac3Descriptor = () => descriptor(0x7a, [0x00]);

export type PesOptions = {
	streamId: number;
	pts?: number | null;
	dts?: number | null;
	data: Uint8Array;
	/** 'auto' (default) writes the real length, 0 writes "unbounded", a number writes that value verbatim. */
	pesPacketLength?: 'auto' | number;
	dataAlignment?: boolean;
	/** Extra 0xFF stuffing bytes at the end of the PES header. */
	headerStuffing?: number;
	/** Overrides the '0010'/'0011' marker nibble of the PTS field. */
	ptsMarkerNibble?: number;
};

const writeTimestamp = (bytes: Uint8Array, offset: number, marker: number, timestamp: number) => {
	const value = ((timestamp % 2 ** 33) + 2 ** 33) % 2 ** 33;
	bytes[offset] = (marker << 4) | (Math.floor(value / 2 ** 30) << 1) | 1;
	const middle = Math.floor(value / 2 ** 15) % 2 ** 15;
	bytes[offset + 1] = middle >> 7;
	bytes[offset + 2] = ((middle & 0x7f) << 1) | 1;
	const low = value % 2 ** 15;
	bytes[offset + 3] = low >> 7;
	bytes[offset + 4] = ((low & 0x7f) << 1) | 1;
};

/** Builds a PES packet with the optional header (all stream_ids an elementary stream would use). */
export const buildPesPacket = (options: PesOptions) => {
	const hasPts = options.pts !== undefined && options.pts !== null;
	const hasDts = hasPts && options.dts !== undefined && options.dts !== null;
	const timestampBytes = hasPts ? (hasDts ? 10 : 5) : 0;
	const headerDataLength = timestampBytes + (options.headerStuffing ?? 0);

	const header = new Uint8Array(9 + headerDataLength);
	header[0] = 0x00;
	header[1] = 0x00;
	header[2] = 0x01;
	header[3] = options.streamId;

	const realLength = 3 + headerDataLength + options.data.byteLength;
	const pesPacketLength = options.pesPacketLength === undefined || options.pesPacketLength === 'auto'
		? (realLength > 0xffff ? 0 : realLength)
		: options.pesPacketLength;
	header[4] = pesPacketLength >> 8;
	header[5] = pesPacketLength & 0xff;

	header[6] = 0x80 | (options.dataAlignment === false ? 0 : 0x04);
	header[7] = hasPts ? (hasDts ? 0xc0 : 0x80) : 0x00;
	header[8] = headerDataLength;

	if (hasPts) {
		writeTimestamp(header, 9, options.ptsMarkerNibble ?? (hasDts ? 0b0011 : 0b0010), options.pts!);
	}
	if (hasDts) {
		writeTimestamp(header, 14, 0b0001, options.dts!);
	}
	header.fill(0xff, 9 + timestampBytes);

	return concatBytes([header, options.data]);
};

export type AdaptationFieldOptions = {
	discontinuity?: boolean;
	randomAccess?: boolean;
	priority?: boolean;
	/** PCR base in 90 kHz units (33 bits); the extension is written as 0. */
	pcr?: number;
	opcr?: number;
	spliceCountdown?: number;
	privateData?: Uint8Array;
};

export type TsPacketOptions = {
	pid: number;
	pusi?: boolean;
	payload?: Uint8Array;
	adaptation?: AdaptationFieldOptions;
	/** Defaults to the stream's running counter for the PID. */
	cc?: number;
	transportErrorIndicator?: boolean;
	scramblingControl?: number;
	/**
	 * How to pad a payload shorter than the room left in the packet: 'adaptation' (spec-conformant for PES) grows the
	 * adaptation field, 'trailing' appends 0xFF bytes after the payload (spec-conformant for PSI).
	 */
	padding?: 'adaptation' | 'trailing';
};

const buildAdaptationField = (options: AdaptationFieldOptions | undefined, totalLength: number) => {
	// totalLength includes the adaptation_field_length byte itself
	const field = new Uint8Array(totalLength);
	if (totalLength === 0) {
		return field;
	}

	field[0] = totalLength - 1;
	if (totalLength === 1) {
		return field;
	}

	let flags = 0;
	if (options?.discontinuity) {
		flags |= 0x80;
	}
	if (options?.randomAccess) {
		flags |= 0x40;
	}
	if (options?.priority) {
		flags |= 0x20;
	}
	if (options?.pcr !== undefined) {
		flags |= 0x10;
	}
	if (options?.opcr !== undefined) {
		flags |= 0x08;
	}
	if (options?.spliceCountdown !== undefined) {
		flags |= 0x04;
	}
	if (options?.privateData) {
		flags |= 0x02;
	}
	field[1] = flags;

	let offset = 2;
	const writeClockReference = (value: number) => {
		const base = ((value % 2 ** 33) + 2 ** 33) % 2 ** 33;
		field[offset++] = Math.floor(base / 2 ** 25);
		field[offset++] = Math.floor(base / 2 ** 17) & 0xff;
		field[offset++] = Math.floor(base / 2 ** 9) & 0xff;
		field[offset++] = Math.floor(base / 2) & 0xff;
		field[offset++] = ((base % 2) << 7) | 0x7e; // reserved bits, extension high bit 0
		field[offset++] = 0x00;
	};

	if (options?.pcr !== undefined) {
		writeClockReference(options.pcr);
	}
	if (options?.opcr !== undefined) {
		writeClockReference(options.opcr);
	}
	if (options?.spliceCountdown !== undefined) {
		field[offset++] = options.spliceCountdown & 0xff;
	}
	if (options?.privateData) {
		field[offset++] = options.privateData.byteLength;
		field.set(options.privateData, offset);
		offset += options.privateData.byteLength;
	}

	field.fill(0xff, offset);
	return field;
};

export const minimumAdaptationFieldLength = (options: AdaptationFieldOptions | undefined) => {
	if (!options) {
		return 0;
	}

	let length = 2;
	if (options.pcr !== undefined) {
		length += 6;
	}
	if (options.opcr !== undefined) {
		length += 6;
	}
	if (options.spliceCountdown !== undefined) {
		length += 1;
	}
	if (options.privateData) {
		length += 1 + options.privateData.byteLength;
	}
	return length;
};

/** Accumulates 188-byte TS packets and keeps a continuity counter per PID. */
export class TsBuilder {
	packets: Uint8Array[] = [];
	continuityCounters = new Map<number, number>();

	packet(options: TsPacketOptions) {
		const payload = options.payload ?? new Uint8Array(0);
		const minAdaptation = minimumAdaptationFieldLength(options.adaptation);
		const room = 184 - minAdaptation;
		if (payload.byteLength > room) {
			throw new Error(`Payload of ${payload.byteLength} bytes doesn't fit (room: ${room}).`);
		}

		const padding = options.padding ?? 'adaptation';
		let adaptationLength = minAdaptation;
		if (padding === 'adaptation' && minAdaptation + payload.byteLength < 184) {
			adaptationLength = 184 - payload.byteLength;
		}

		const hasPayload = payload.byteLength > 0;
		const hasAdaptation = adaptationLength > 0;
		const afc = (hasAdaptation ? 0b10 : 0) | (hasPayload ? 0b01 : 0);

		const previous = this.continuityCounters.get(options.pid);
		let cc: number;
		if (options.cc !== undefined) {
			cc = options.cc;
		} else if (previous === undefined) {
			cc = 0;
		} else {
			cc = hasPayload ? (previous + 1) & 0xf : previous;
		}
		this.continuityCounters.set(options.pid, cc);

		const bytes = new Uint8Array(TS_PACKET_SIZE).fill(0xff);
		bytes[0] = 0x47;
		bytes[1] = (options.transportErrorIndicator ? 0x80 : 0)
			| (options.pusi ? 0x40 : 0)
			| (options.pid >> 8);
		bytes[2] = options.pid & 0xff;
		bytes[3] = ((options.scramblingControl ?? 0) << 6) | (afc << 4) | cc;
		bytes.set(buildAdaptationField(options.adaptation, adaptationLength), 4);
		bytes.set(payload, 4 + adaptationLength);

		this.packets.push(bytes);
		return bytes;
	}

	/** Writes a PSI section, possibly spanning several packets, prefixed by pointer_field. */
	section(pid: number, section: Uint8Array, options: { pointerFieldFiller?: Uint8Array } = {}) {
		const filler = options.pointerFieldFiller ?? new Uint8Array(0);
		const data = concatBytes([new Uint8Array([filler.byteLength]), filler, section]);
		let offset = 0;
		let first = true;
		while (offset < data.byteLength) {
			const chunk = data.subarray(offset, offset + 184);
			this.packet({ pid, pusi: first, payload: chunk, padding: 'trailing' });
			offset += chunk.byteLength;
			first = false;
		}
	}

	/** Writes a PES packet over as many TS packets as needed; the last one is padded via the adaptation field. */
	pes(pid: number, pes: Uint8Array, adaptation?: AdaptationFieldOptions) {
		let offset = 0;
		let first = true;
		while (offset < pes.byteLength || first) {
			const firstAdaptation = first ? adaptation : undefined;
			const room = 184 - minimumAdaptationFieldLength(firstAdaptation);
			const chunk = pes.subarray(offset, offset + room);
			this.packet({ pid, pusi: first, payload: chunk, adaptation: firstAdaptation });
			offset += chunk.byteLength;
			first = false;
		}
	}

	nullPacket() {
		this.packet({ pid: 0x1fff, payload: new Uint8Array(184).fill(0xff), cc: 0 });
	}

	/**
	 * Concatenates all packets. `prefix` makes 192-byte BDAV/M2TS packets (4-byte TP_extra_header before each packet),
	 * `suffix` adds trailing bytes after each packet (e.g. 16 bytes of Reed-Solomon parity for 204-byte packets).
	 */
	toBytes(options: { prefix?: number; suffix?: number } = {}) {
		const prefix = options.prefix ?? 0;
		const suffix = options.suffix ?? 0;
		const stride = prefix + TS_PACKET_SIZE + suffix;
		const result = new Uint8Array(stride * this.packets.length);
		this.packets.forEach((packet, i) => {
			const base = i * stride;
			if (prefix > 0) {
				// copy_permission_indicator 0, 30-bit arrival timestamp counting up
				new DataView(result.buffer).setUint32(base, (i * 1000) & 0x3fffffff);
			}
			result.set(packet, base + prefix);
			result.fill(0x00, base + prefix + TS_PACKET_SIZE, base + stride);
		});
		return result;
	}
}

// --- Elementary stream payloads ---

export const ADTS_SAMPLE_RATES = [
	96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** An ADTS frame (no CRC) with a zero-filled raw data block. */
export const adtsFrame = (options: {
	objectType?: number;
	sampleRateIndex?: number;
	channelConfiguration?: number;
	payloadSize?: number;
	rawDataBlocks?: number;
	mpeg2?: boolean;
} = {}) => {
	const payloadSize = options.payloadSize ?? 32;
	const frameLength = 7 + payloadSize;
	const bytes = new Uint8Array(frameLength);
	const bitstream = new Bitstream(bytes);
	bitstream.writeBits(12, 0xfff);
	bitstream.writeBits(1, options.mpeg2 ? 1 : 0);
	bitstream.writeBits(2, 0);
	bitstream.writeBits(1, 1); // protection_absent
	bitstream.writeBits(2, (options.objectType ?? 2) - 1);
	bitstream.writeBits(4, options.sampleRateIndex ?? 3);
	bitstream.writeBits(1, 0);
	bitstream.writeBits(3, options.channelConfiguration ?? 2);
	bitstream.writeBits(4, 0);
	bitstream.writeBits(13, frameLength);
	bitstream.writeBits(11, 0x7ff);
	bitstream.writeBits(2, options.rawDataBlocks ?? 0);
	return bytes;
};

/** AC-3 frame sizes in 16-bit words, indexed by frmsizecod >> 1 for fscod 0 (48 kHz), i.e. 2 words per kbit/s. */
const AC3_WORDS_48K = [64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 640, 768, 896, 1024, 1152, 1280];

/** An AC-3 sync frame at 48 kHz with the given frmsizecod; everything after the BSI is zero. */
export const ac3Frame = (options: { frmsizecod?: number; acmod?: number; lfeon?: number } = {}) => {
	const frmsizecod = options.frmsizecod ?? 8; // 64 kbit/s, 256 bytes
	const size = 2 * AC3_WORDS_48K[frmsizecod >> 1]!;
	const bytes = new Uint8Array(size);
	const bitstream = new Bitstream(bytes);
	bitstream.writeBits(16, 0x0b77);
	bitstream.writeBits(16, 0); // crc1
	bitstream.writeBits(2, 0); // fscod: 48 kHz
	bitstream.writeBits(6, frmsizecod);
	bitstream.writeBits(5, 8); // bsid
	bitstream.writeBits(3, 0); // bsmod
	const acmod = options.acmod ?? 2;
	bitstream.writeBits(3, acmod);
	if ((acmod & 0x1) && acmod !== 0x1) {
		bitstream.writeBits(2, 0); // cmixlev
	}
	if (acmod & 0x4) {
		bitstream.writeBits(2, 0); // surmixlev
	}
	if (acmod === 0x2) {
		bitstream.writeBits(2, 0); // dsurmod
	}
	bitstream.writeBits(1, options.lfeon ?? 0);
	return bytes;
};

/** An E-AC-3 sync frame (48 kHz, 6 blocks unless numblkscod says otherwise). */
export const eac3Frame = (options: {
	strmtyp?: number;
	substreamid?: number;
	sizeInBytes?: number;
	numblkscod?: number;
	acmod?: number;
	lfeon?: number;
} = {}) => {
	const size = options.sizeInBytes ?? 256;
	const bytes = new Uint8Array(size);
	const bitstream = new Bitstream(bytes);
	bitstream.writeBits(16, 0x0b77);
	bitstream.writeBits(2, options.strmtyp ?? 0);
	bitstream.writeBits(3, options.substreamid ?? 0);
	bitstream.writeBits(11, size / 2 - 1); // frmsiz
	bitstream.writeBits(2, 0); // fscod: 48 kHz
	bitstream.writeBits(2, options.numblkscod ?? 3);
	bitstream.writeBits(3, options.acmod ?? 2);
	bitstream.writeBits(1, options.lfeon ?? 0);
	bitstream.writeBits(5, 16); // bsid
	return bytes;
};

/** An MPEG-1 Layer III frame at 48 kHz, 128 kbit/s (or Layer II when `layer` is 2). */
export const mpegAudioFrame = (options: { layer?: 2 | 3; padding?: boolean } = {}) => {
	const layer = options.layer ?? 3;
	const size = 144 * 128000 / 48000 + (options.padding ? 1 : 0); // 1152 samples at 128 kbit/s for both layers
	const bytes = new Uint8Array(size);
	bytes[0] = 0xff;
	bytes[1] = 0xe0 | (0b11 << 3) | ((4 - layer) << 1) | 1; // MPEG-1, no CRC
	const bitrateIndex = layer === 3 ? 0b1001 : 0b1000; // 128 kbit/s in the respective table
	bytes[2] = (bitrateIndex << 4) | (0b01 << 2) | ((options.padding ? 1 : 0) << 1); // 48 kHz
	bytes[3] = 0b11 << 6; // mono
	return bytes;
};

// H.264 / HEVC NAL units

const finishRbsp = (bitstream: Bitstream, bytes: Uint8Array) => {
	bitstream.writeBits(1, 1); // rbsp_stop_one_bit
	return bytes.subarray(0, Math.ceil(bitstream.pos / 8));
};

const hex = (text: string) => new Uint8Array(text.match(/../g)!.map(byte => parseInt(byte, 16)));

/** x264's SPS/PPS for 64x64 Constrained Baseline (ffmpeg -c:v libx264 -preset ultrafast -bf 0, 64x64). */
export const X264_SPS_64 = hex('6742c00ada109b011000000300100000030320f1226a');
export const X264_PPS_64 = hex('68ce0fc8');

/** x265's VPS/SPS/PPS for 64x64 Main (ffmpeg -c:v libx265 -preset ultrafast, 64x64). */
export const X265_VPS_64 = hex('40010c01ffff01600000030090000003000003001eba0240');
export const X265_SPS_64 = hex('42010101600000030090000003000003001ea020810596e92930bc05a02000000300200000030321');
export const X265_PPS_64 = hex('4401c073c089');

/** An HEVC VCL NAL unit of the given type, starting a new picture unless `firstSliceInPicture` is false. */
export const hevcSlice = (options: {
	type?: number;
	firstSliceInPicture?: boolean;
	size?: number;
	layerId?: number;
} = {}) => {
	const bytes = new Uint8Array(Math.max(options.size ?? 24, 4)).fill(0xaa);
	const type = options.type ?? 1;
	const layerId = options.layerId ?? 0;
	bytes[0] = (type << 1) | (layerId >> 5);
	bytes[1] = ((layerId & 0x1f) << 3) | 1; // nuh_temporal_id_plus1 = 1
	bytes[2] = (options.firstSliceInPicture === false ? 0x00 : 0x80) | 0x2a;
	return bytes;
};

export const HEVC_AUD = new Uint8Array([0x46, 0x01, 0x50]);

/** A baseline-profile H.264 SPS for a `widthInMbs` x `heightInMbs` frame-coded picture (POC type 2, no VUI). */
export const avcSps = (options: { widthInMbs?: number; heightInMbs?: number; profileIdc?: number } = {}) => {
	const bytes = new Uint8Array(64);
	const bitstream = new Bitstream(bytes);
	bitstream.writeBits(8, 0x67); // nal_ref_idc 3, SPS
	bitstream.writeBits(8, options.profileIdc ?? 66);
	bitstream.writeBits(8, 0xc0); // constraint_set0/1
	bitstream.writeBits(8, 30); // level_idc
	writeExpGolomb(bitstream, 0); // seq_parameter_set_id
	writeExpGolomb(bitstream, 0); // log2_max_frame_num_minus4
	writeExpGolomb(bitstream, 2); // pic_order_cnt_type
	writeExpGolomb(bitstream, 1); // max_num_ref_frames
	bitstream.writeBits(1, 0); // gaps_in_frame_num_value_allowed_flag
	writeExpGolomb(bitstream, (options.widthInMbs ?? 2) - 1);
	writeExpGolomb(bitstream, (options.heightInMbs ?? 2) - 1);
	bitstream.writeBits(1, 1); // frame_mbs_only_flag
	bitstream.writeBits(1, 1); // direct_8x8_inference_flag
	bitstream.writeBits(1, 0); // frame_cropping_flag
	bitstream.writeBits(1, 0); // vui_parameters_present_flag
	return finishRbsp(bitstream, bytes);
};

export const avcPps = () => {
	const bytes = new Uint8Array(16);
	const bitstream = new Bitstream(bytes);
	bitstream.writeBits(8, 0x68); // nal_ref_idc 3, PPS
	writeExpGolomb(bitstream, 0); // pic_parameter_set_id
	writeExpGolomb(bitstream, 0); // seq_parameter_set_id
	bitstream.writeBits(1, 0); // entropy_coding_mode_flag
	bitstream.writeBits(1, 0); // bottom_field_pic_order_in_frame_present_flag
	writeExpGolomb(bitstream, 0); // num_slice_groups_minus1
	writeExpGolomb(bitstream, 0); // num_ref_idx_l0_default_active_minus1
	writeExpGolomb(bitstream, 0); // num_ref_idx_l1_default_active_minus1
	bitstream.writeBits(1, 0); // weighted_pred_flag
	bitstream.writeBits(2, 0); // weighted_bipred_idc
	writeExpGolomb(bitstream, 0); // pic_init_qp_minus26 = 0 (se(v))
	writeExpGolomb(bitstream, 0); // pic_init_qs_minus26 = 0 (se(v))
	writeExpGolomb(bitstream, 0); // chroma_qp_index_offset = 0 (se(v))
	bitstream.writeBits(1, 1); // deblocking_filter_control_present_flag
	bitstream.writeBits(1, 0); // constrained_intra_pred_flag
	bitstream.writeBits(1, 0); // redundant_pic_cnt_present_flag
	return finishRbsp(bitstream, bytes);
};

export const AVC_AUD = new Uint8Array([0x09, 0xf0]);

/** An H.264 slice NAL unit: IDR (type 5) or non-IDR (type 1), with the given first_mb_in_slice and filler bytes. */
export const avcSlice = (options: { idr?: boolean; firstMb?: number; size?: number; frameNum?: number } = {}) => {
	const size = options.size ?? 24;
	const bytes = new Uint8Array(Math.max(size, 8));
	const bitstream = new Bitstream(bytes);
	bitstream.writeBits(8, options.idr ? 0x65 : 0x41);
	writeExpGolomb(bitstream, options.firstMb ?? 0);
	writeExpGolomb(bitstream, options.idr ? 7 : 5); // slice_type (I / P, all slices of the picture)
	writeExpGolomb(bitstream, 0); // pic_parameter_set_id
	bitstream.writeBits(4, (options.frameNum ?? 0) & 0xf); // frame_num
	if (options.idr) {
		writeExpGolomb(bitstream, 0); // idr_pic_id
	}
	// The rest is filler that doesn't contain start code emulation
	for (let i = Math.ceil(bitstream.pos / 8); i < bytes.length; i++) {
		bytes[i] = 0xaa;
	}
	return bytes;
};

/** Joins NAL units with 4-byte start codes. */
export const annexB = (nalUnits: Uint8Array[]) => concatBytes(
	nalUnits.flatMap(nalUnit => [new Uint8Array([0, 0, 0, 1]), nalUnit]),
);
