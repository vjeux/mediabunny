// Byte and bit builders for the mutation-guided edge-case suites (codec bitstreams, container structures).

import { EBMLId } from '../../../src/matroska/ebml.js';

/** Writes big-endian bit fields, Exp-Golomb codes and whole bytes into a growing byte array. */
export class BitWriter {
	private bytes: number[] = [];
	private bitPos = 0;

	writeBits(count: number, value: number) {
		for (let i = count - 1; i >= 0; i--) {
			const bit = Math.floor(value / 2 ** i) % 2;
			const byteIndex = this.bitPos >> 3;
			if (byteIndex === this.bytes.length) {
				this.bytes.push(0);
			}
			if (bit) {
				this.bytes[byteIndex]! |= 0x80 >> (this.bitPos & 7);
			}
			this.bitPos++;
		}
		return this;
	}

	writeFlag(value: boolean | number) {
		return this.writeBits(1, value ? 1 : 0);
	}

	/** Unsigned Exp-Golomb, ue(v). */
	writeUe(value: number) {
		const codeNum = value + 1;
		const length = Math.floor(Math.log2(codeNum));
		this.writeBits(length, 0);
		return this.writeBits(length + 1, codeNum);
	}

	/** Signed Exp-Golomb, se(v). */
	writeSe(value: number) {
		return this.writeUe(value > 0 ? 2 * value - 1 : -2 * value);
	}

	/** RBSP trailing bits: a one bit, then zero bits up to the next byte boundary. */
	writeTrailingBits() {
		this.writeBits(1, 1);
		while (this.bitPos & 7) {
			this.writeBits(1, 0);
		}
		return this;
	}

	alignZero() {
		while (this.bitPos & 7) {
			this.writeBits(1, 0);
		}
		return this;
	}

	get bitLength() {
		return this.bitPos;
	}

	toBytes() {
		return new Uint8Array(this.bytes);
	}
}

/** Inserts emulation prevention bytes (0x03 after two zero bytes when the next byte is <= 3). */
export const addEmulationPrevention = (rbsp: Uint8Array) => {
	const out: number[] = [];
	let zeros = 0;
	for (const byte of rbsp) {
		if (zeros >= 2 && byte <= 3) {
			out.push(3);
			zeros = 0;
		}
		out.push(byte);
		zeros = byte === 0 ? zeros + 1 : 0;
	}
	return new Uint8Array(out);
};

export const concatBytes = (...parts: (Uint8Array | number[])[]) => {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

/** Joins NAL units into an Annex B byte stream with four-byte start codes. */
export const annexB = (...nalUnits: (Uint8Array | number[])[]) => {
	return concatBytes(...nalUnits.flatMap(nal => [[0, 0, 0, 1], nal]));
};

/** Joins NAL units with big-endian length prefixes of the given size. */
export const lengthPrefixed = (lengthSize: 1 | 2 | 3 | 4, ...nalUnits: (Uint8Array | number[])[]) => {
	return concatBytes(...nalUnits.flatMap((nal) => {
		const prefix: number[] = [];
		for (let i = lengthSize - 1; i >= 0; i--) {
			prefix.push(Math.floor(nal.length / 2 ** (8 * i)) & 0xff);
		}
		return [prefix, nal];
	}));
};

export const u16be = (value: number) => [(value >> 8) & 0xff, value & 0xff];
export const u24be = (value: number) => [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
export const u32be = (value: number) => [
	Math.floor(value / 2 ** 24) & 0xff,
	(value >> 16) & 0xff,
	(value >> 8) & 0xff,
	value & 0xff,
];
export const u16le = (value: number) => [value & 0xff, (value >> 8) & 0xff];
export const u32le = (value: number) => [
	value & 0xff,
	(value >> 8) & 0xff,
	(value >> 16) & 0xff,
	Math.floor(value / 2 ** 24) & 0xff,
];
export const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));

export type AvcSpsOptions = {
	profileIdc?: number;
	constraintFlags?: number;
	levelIdc?: number;
	chromaFormatIdc?: number;
	separateColourPlane?: boolean;
	bitDepthLuma?: number;
	bitDepthChroma?: number;
	/** Per scaling list: null = not present, otherwise the delta_scale values to write. */
	scalingLists?: (number[] | null)[];
	pocType?: 0 | 1 | 2;
	pocCycle?: number[];
	maxNumRefFrames?: number;
	widthInMbs: number;
	heightInMapUnits: number;
	frameMbsOnly?: boolean;
	/** frame_crop_left/right/top/bottom_offset */
	crop?: [number, number, number, number];
	vui?: {
		/** aspect_ratio_idc, or [sar_width, sar_height] for Extended_SAR */
		sar?: number | [number, number];
		overscan?: boolean;
		videoSignal?: { fullRange: boolean; colour?: [number, number, number] };
		chromaLoc?: boolean;
		timing?: [number, number, boolean];
		nalHrd?: number;
		vclHrd?: number;
		restriction?: { numReorderFrames: number; maxDecFrameBuffering: number };
	};
};

const writeAvcHrd = (writer: BitWriter, cpbCount: number) => {
	writer.writeUe(cpbCount - 1).writeBits(4, 1).writeBits(4, 2);
	for (let i = 0; i < cpbCount; i++) {
		writer.writeUe(1000 + i).writeUe(2000 + i).writeFlag(i % 2);
	}
	writer.writeBits(5, 23).writeBits(5, 23).writeBits(5, 23).writeBits(5, 24);
};

/** Builds an H.264 SPS NAL unit (with header byte 0x67 and emulation prevention) from the given fields. */
export const buildAvcSps = (options: AvcSpsOptions) => {
	const profileIdc = options.profileIdc ?? 100;
	const writer = new BitWriter()
		.writeBits(8, profileIdc)
		.writeBits(8, options.constraintFlags ?? 0)
		.writeBits(8, options.levelIdc ?? 40)
		.writeUe(0); // seq_parameter_set_id

	if ([100, 110, 122, 244, 44, 83, 86, 118, 128].includes(profileIdc)) {
		const chromaFormatIdc = options.chromaFormatIdc ?? 1;
		writer.writeUe(chromaFormatIdc);
		if (chromaFormatIdc === 3) {
			writer.writeFlag(options.separateColourPlane ?? false);
		}
		writer.writeUe((options.bitDepthLuma ?? 8) - 8).writeUe((options.bitDepthChroma ?? 8) - 8);
		writer.writeFlag(false); // qpprime_y_zero_transform_bypass_flag
		writer.writeFlag(options.scalingLists !== undefined);
		if (options.scalingLists) {
			const listCount = chromaFormatIdc !== 3 ? 8 : 12;
			for (let i = 0; i < listCount; i++) {
				const deltas = options.scalingLists[i] ?? null;
				writer.writeFlag(deltas !== null);
				for (const delta of deltas ?? []) {
					writer.writeSe(delta);
				}
			}
		}
	}

	writer.writeUe(0); // log2_max_frame_num_minus4
	const pocType = options.pocType ?? 0;
	writer.writeUe(pocType);
	if (pocType === 0) {
		writer.writeUe(2); // log2_max_pic_order_cnt_lsb_minus4
	} else if (pocType === 1) {
		writer.writeFlag(false).writeSe(-2).writeSe(1);
		const cycle = options.pocCycle ?? [];
		writer.writeUe(cycle.length);
		for (const offset of cycle) {
			writer.writeSe(offset);
		}
	}
	writer.writeUe(options.maxNumRefFrames ?? 1).writeFlag(false);
	writer.writeUe(options.widthInMbs - 1).writeUe(options.heightInMapUnits - 1);
	const frameMbsOnly = options.frameMbsOnly ?? true;
	writer.writeFlag(frameMbsOnly);
	if (!frameMbsOnly) {
		writer.writeFlag(true); // mb_adaptive_frame_field_flag
	}
	writer.writeFlag(true); // direct_8x8_inference_flag
	writer.writeFlag(options.crop !== undefined);
	if (options.crop) {
		for (const offset of options.crop) {
			writer.writeUe(offset);
		}
	}

	const vui = options.vui;
	writer.writeFlag(vui !== undefined);
	if (vui) {
		writer.writeFlag(vui.sar !== undefined);
		if (typeof vui.sar === 'number') {
			writer.writeBits(8, vui.sar);
		} else if (vui.sar) {
			writer.writeBits(8, 255).writeBits(16, vui.sar[0]).writeBits(16, vui.sar[1]);
		}
		writer.writeFlag(vui.overscan ?? false);
		if (vui.overscan) {
			writer.writeFlag(true);
		}
		writer.writeFlag(vui.videoSignal !== undefined);
		if (vui.videoSignal) {
			writer.writeBits(3, 5).writeFlag(vui.videoSignal.fullRange).writeFlag(vui.videoSignal.colour !== undefined);
			if (vui.videoSignal.colour) {
				writer.writeBits(8, vui.videoSignal.colour[0])
					.writeBits(8, vui.videoSignal.colour[1])
					.writeBits(8, vui.videoSignal.colour[2]);
			}
		}
		writer.writeFlag(vui.chromaLoc ?? false);
		if (vui.chromaLoc) {
			writer.writeUe(1).writeUe(2);
		}
		writer.writeFlag(vui.timing !== undefined);
		if (vui.timing) {
			writer.writeBits(32, vui.timing[0]).writeBits(32, vui.timing[1]).writeFlag(vui.timing[2]);
		}
		writer.writeFlag(vui.nalHrd !== undefined);
		if (vui.nalHrd !== undefined) {
			writeAvcHrd(writer, vui.nalHrd);
		}
		writer.writeFlag(vui.vclHrd !== undefined);
		if (vui.vclHrd !== undefined) {
			writeAvcHrd(writer, vui.vclHrd);
		}
		if (vui.nalHrd !== undefined || vui.vclHrd !== undefined) {
			writer.writeFlag(false); // low_delay_hrd_flag
		}
		writer.writeFlag(false); // pic_struct_present_flag
		writer.writeFlag(vui.restriction !== undefined);
		if (vui.restriction) {
			writer.writeFlag(true).writeUe(2).writeUe(1).writeUe(16).writeUe(16)
				.writeUe(vui.restriction.numReorderFrames)
				.writeUe(vui.restriction.maxDecFrameBuffering);
		}
	}
	writer.writeTrailingBits();

	return concatBytes([0x67], addEmulationPrevention(writer.toBytes()));
};

const ebmlIdBytes = (id: number) => {
	const bytes: number[] = [];
	let value = id;
	while (value > 0) {
		bytes.unshift(value & 0xff);
		value = Math.floor(value / 256);
	}
	return bytes;
};

/** An EBML variable-size integer of the given (or the smallest fitting) width. */
export const ebmlVint = (value: number, width?: number) => {
	let w = width ?? 1;
	while (width === undefined && value >= 2 ** (7 * w) - 1) {
		w++;
	}
	const bytes: number[] = [];
	let rest = value;
	for (let i = 0; i < w; i++) {
		bytes.unshift(rest % 256);
		rest = Math.floor(rest / 256);
	}
	bytes[0]! |= 0x80 >> (w - 1);
	return bytes;
};

/** An EBML element with the given ID and payload parts. */
export const ebml = (id: number, ...payload: (Uint8Array | number[])[]) => {
	const data = concatBytes(...payload);
	return concatBytes(ebmlIdBytes(id), ebmlVint(data.length), data);
};

export const ebmlUint = (id: number, value: number) => {
	const bytes: number[] = [];
	let rest = value;
	do {
		bytes.unshift(rest % 256);
		rest = Math.floor(rest / 256);
	} while (rest > 0);
	return ebml(id, bytes);
};

export const ebmlFloat = (id: number, value: number) => {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setFloat64(0, value);
	return ebml(id, bytes);
};

export const ebmlString = (id: number, value: string) => ebml(id, new TextEncoder().encode(value));

/** A Matroska SimpleBlock payload: track number, 16-bit relative timestamp, flags (0x80 = key frame), frame data. */
export const mkvSimpleBlock = (
	trackNumber: number,
	relativeTimestamp: number,
	flags: number,
	data: Uint8Array | number[],
) => {
	return concatBytes(ebmlVint(trackNumber), [(relativeTimestamp >> 8) & 0xff, relativeTimestamp & 0xff, flags], data);
};

/** A complete Matroska file: EBML header + Segment(Info(TimestampScale 1 ms), Tracks, ...rest). */
export const mkvFile = (options: {
	docType?: string;
	infoChildren?: Uint8Array[];
	trackEntries: Uint8Array[];
	rest: Uint8Array[];
}) => {
	const header = ebml(
		EBMLId.EBML,
		ebmlUint(EBMLId.EBMLVersion, 1),
		ebmlUint(EBMLId.EBMLReadVersion, 1),
		ebmlUint(EBMLId.EBMLMaxIDLength, 4),
		ebmlUint(EBMLId.EBMLMaxSizeLength, 8),
		ebmlString(EBMLId.DocType, options.docType ?? 'matroska'),
		ebmlUint(EBMLId.DocTypeVersion, 4),
		ebmlUint(EBMLId.DocTypeReadVersion, 2),
	);
	const info = ebml(EBMLId.Info, ebmlUint(EBMLId.TimestampScale, 1_000_000), ...(options.infoChildren ?? []));
	const tracks = ebml(EBMLId.Tracks, ...options.trackEntries);
	return concatBytes(header, ebml(EBMLId.Segment, info, tracks, ...options.rest));
};

/** An ISOBMFF box: 32-bit size, four-character type, payload. */
export const mp4Box = (type: string, ...payload: (Uint8Array | number[])[]) => {
	const data = concatBytes(...payload);
	return concatBytes(u32be(8 + data.length), ascii(type), data);
};

/** An ISOBMFF FullBox: like a box, with a version byte and 24 flag bits before the payload. */
export const mp4FullBox = (type: string, version: number, flags: number, ...payload: (Uint8Array | number[])[]) => {
	return mp4Box(type, [version], u24be(flags), ...payload);
};

/** A QuickTime/ISO sound sample entry (version 0) followed by optional child boxes. */
export const mp4SoundEntry = (
	format: string,
	channels: number,
	sampleSize: number,
	sampleRate: number,
	...children: Uint8Array[]
) => mp4Box(
	format,
	[0, 0, 0, 0, 0, 0], u16be(1), // reserved, data_reference_index
	u16be(0), u16be(0), u32be(0), // version, revision level, vendor
	u16be(channels), u16be(sampleSize), u16be(0), u16be(0),
	u32be(sampleRate * 0x10000),
	...children,
);

/** A visual sample entry followed by optional child boxes (avcC etc.). */
export const mp4VisualEntry = (format: string, width: number, height: number, ...children: Uint8Array[]) => mp4Box(
	format,
	[0, 0, 0, 0, 0, 0], u16be(1),
	new Uint8Array(16), // pre_defined, reserved
	u16be(width), u16be(height),
	u32be(0x00480000), u32be(0x00480000), u32be(0), u16be(1),
	new Uint8Array(32), // compressorname
	u16be(0x18), [0xff, 0xff],
	...children,
);

export type Mp4TrackOptions = {
	handler: 'soun' | 'vide';
	timescale: number;
	sampleEntry: Uint8Array;
	/** Sample payloads in decode order; their order in the file follows the chunk layout from `stsc`. */
	samples: Uint8Array[];
	/** stts entries: [sample_count, sample_delta] */
	stts: [number, number][];
	/** ctts entries: [sample_count, sample_offset]; version 1 allows negative offsets */
	ctts?: { version: 0 | 1; entries: [number, number][] };
	/** stsc entries: [first_chunk (1-based), samples_per_chunk] */
	stsc: [number, number][];
	/** 1-based sync sample numbers; all samples are sync samples when absent */
	stss?: number[];
	/** Writes one constant sample size instead of a size table */
	constantSampleSize?: number;
	/** elst entries: [segment_duration (movie timescale), media_time] */
	elst?: [number, number][];
	co64?: boolean;
	width?: number;
	height?: number;
	/** Extra boxes appended to the moov (metadata and such) */
	moovExtra?: Uint8Array[];
};

/** Builds a single-track, non-fragmented MP4 (ftyp, moov, mdat) whose chunks follow the stsc layout. */
export const buildMp4 = (track: Mp4TrackOptions) => {
	// Lay the samples out into chunks
	const chunks: Uint8Array[][] = [];
	let sampleIndex = 0;
	for (let i = 0; sampleIndex < track.samples.length; i++) {
		const entry = [...track.stsc].reverse().find(([firstChunk]) => firstChunk <= i + 1)!;
		const chunk = track.samples.slice(sampleIndex, sampleIndex + entry[1]);
		chunks.push(chunk);
		sampleIndex += entry[1];
	}

	const table = (type: string, version: number, rows: number[][]) => {
		const body = rows.map(row => row.flatMap(value => u32be(value >>> 0)));
		return mp4FullBox(type, version, 0, u32be(rows.length), ...body);
	};

	const build = (chunkOffsets: number[]) => {
		const duration = track.stts.reduce((sum, [count, delta]) => sum + count * delta, 0);
		const sampleCount = track.samples.length;
		const stbl = mp4Box(
			'stbl',
			mp4FullBox('stsd', 0, 0, u32be(1), track.sampleEntry),
			table('stts', 0, track.stts),
			...(track.ctts ? [table('ctts', track.ctts.version, track.ctts.entries)] : []),
			...(track.stss ? [table('stss', 0, track.stss.map(n => [n]))] : []),
			table('stsc', 0, track.stsc.map(([first, perChunk]) => [first, perChunk, 1])),
			track.constantSampleSize !== undefined
				? mp4FullBox('stsz', 0, 0, u32be(track.constantSampleSize), u32be(sampleCount))
				: mp4FullBox('stsz', 0, 0, u32be(0), u32be(sampleCount), ...track.samples.map(s => u32be(s.length))),
			track.co64
				? table('co64', 0, chunkOffsets.map(o => [0, o]))
				: table('stco', 0, chunkOffsets.map(o => [o])),
		);
		const mediaHeader = track.handler === 'soun'
			? mp4FullBox('smhd', 0, 0, u32be(0))
			: mp4FullBox('vmhd', 0, 1, new Uint8Array(8));
		const minf = mp4Box(
			'minf',
			mediaHeader,
			mp4Box('dinf', mp4FullBox('dref', 0, 0, u32be(1), mp4FullBox('url ', 0, 1))),
			stbl,
		);
		const mdhd = mp4FullBox(
			'mdhd', 0, 0,
			u32be(0), u32be(0), u32be(track.timescale), u32be(duration), u16be(0x55c4), u16be(0),
		);
		const mdia = mp4Box(
			'mdia',
			mdhd,
			mp4FullBox('hdlr', 0, 0, u32be(0), ascii(track.handler), new Uint8Array(12), [0]),
			minf,
		);
		const matrix = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].flatMap(v => u32be(v));
		const tkhd = mp4FullBox(
			'tkhd', 0, 3,
			u32be(0), u32be(0), u32be(1), u32be(0), u32be(duration),
			new Uint8Array(8), u16be(0), u16be(0), u16be(track.handler === 'soun' ? 0x0100 : 0), u16be(0),
			matrix,
			u32be((track.width ?? 0) * 0x10000), u32be((track.height ?? 0) * 0x10000),
		);
		const edts = track.elst
			? [mp4Box('edts', mp4FullBox(
					'elst', 0, 0,
					u32be(track.elst.length),
					...track.elst.map(([d, t]) => [...u32be(d), ...u32be(t >>> 0), ...u16be(1), ...u16be(0)]),
				))]
			: [];
		const mvhd = mp4FullBox(
			'mvhd', 0, 0,
			u32be(0), u32be(0), u32be(track.timescale), u32be(duration),
			u32be(0x10000), u16be(0x100), new Uint8Array(10), matrix, new Uint8Array(24), u32be(2),
		);
		const moov = mp4Box('moov', mvhd, mp4Box('trak', tkhd, ...edts, mdia), ...(track.moovExtra ?? []));
		const ftyp = mp4Box('ftyp', ascii('isom'), u32be(0x200), ascii('isomiso2mp41'));
		return { ftyp, moov };
	};

	// First pass to size the moov, second pass with the real chunk offsets
	const { ftyp, moov } = build(chunks.map(() => 0));
	const mdatStart = ftyp.length + moov.length + 8;
	const offsets: number[] = [];
	let offset = mdatStart;
	for (const chunk of chunks) {
		offsets.push(offset);
		offset += chunk.reduce((sum, s) => sum + s.length, 0);
	}
	const final = build(offsets);
	return concatBytes(final.ftyp, final.moov, mp4Box('mdat', ...chunks.flat()));
};

/** One ADTS frame (MPEG-4, no multiple raw data blocks) with a payload of the given size filled with `fill`. */
export const adtsFrame = (payloadSize: number, options: {
	objectType?: number;
	samplingFrequencyIndex?: number;
	channelConfiguration?: number;
	crc?: boolean;
	fill?: number;
} = {}) => {
	const headerSize = options.crc ? 9 : 7;
	const writer = new BitWriter()
		.writeBits(12, 0xfff)
		.writeBits(1, 0) // MPEG-4
		.writeBits(2, 0) // layer
		.writeBits(1, options.crc ? 0 : 1) // protection_absent
		.writeBits(2, (options.objectType ?? 2) - 1)
		.writeBits(4, options.samplingFrequencyIndex ?? 4)
		.writeBits(1, 0)
		.writeBits(3, options.channelConfiguration ?? 2)
		.writeBits(4, 0)
		.writeBits(13, headerSize + payloadSize)
		.writeBits(11, 0x7ff)
		.writeBits(2, 0);
	if (options.crc) {
		writer.writeBits(16, 0x1234);
	}
	return concatBytes(writer.toBytes(), new Uint8Array(payloadSize).fill(options.fill ?? 0x21));
};

const synchsafe = (value: number) => [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f];

/** An ID3v2.4 tag holding UTF-8 text frames. */
export const id3v24Tag = (frames: [string, string][]) => {
	const body = concatBytes(...frames.map(([id, text]) => {
		const data = concatBytes([3], new TextEncoder().encode(text));
		return concatBytes(ascii(id), synchsafe(data.length), [0, 0], data);
	}));
	return concatBytes(ascii('ID3'), [4, 0, 0], synchsafe(body.length), body);
};

export type HevcSpsOptions = {
	profileSpace?: number;
	tierFlag?: number;
	profileIdc?: number;
	compatibilityFlags?: number;
	constraintFlags?: number[];
	levelIdc?: number;
	maxSubLayersMinus1?: number;
	/** Per sub-layer [profile_present, level_present] */
	subLayerFlags?: [number, number][];
	chromaFormatIdc?: number;
	separateColourPlane?: boolean;
	width: number;
	height: number;
	/** conf_win_left/right/top/bottom_offset */
	conformanceWindow?: [number, number, number, number];
	bitDepthLuma?: number;
	bitDepthChroma?: number;
	subLayerOrderingInfo?: boolean;
	/** sps_max_num_reorder_pics per written sub-layer */
	reorderPics?: number[];
	scalingListData?: boolean;
	pcm?: boolean;
	/** Explicit short-term RPSs: [negative POC count, positive POC count] each */
	shortTermRps?: [number, number][];
	vui?: {
		sar?: number | [number, number];
		videoSignal?: { fullRange: boolean; colour?: [number, number, number] };
		defaultDisplayWindow?: boolean;
		timing?: { pocProportional: boolean };
		minSpatialSegmentationIdc?: number;
	};
};

/** Builds an H.265 SPS NAL unit (type 33, with emulation prevention) from the given fields. */
export const buildHevcSps = (options: HevcSpsOptions) => {
	const maxSubLayersMinus1 = options.maxSubLayersMinus1 ?? 0;
	const w = new BitWriter()
		.writeBits(4, 0) // sps_video_parameter_set_id
		.writeBits(3, maxSubLayersMinus1)
		.writeBits(1, 1) // sps_temporal_id_nesting_flag
		.writeBits(2, options.profileSpace ?? 0)
		.writeBits(1, options.tierFlag ?? 0)
		.writeBits(5, options.profileIdc ?? 1)
		.writeBits(32, options.compatibilityFlags ?? 0x60000000);
	for (const byte of options.constraintFlags ?? [0x90, 0, 0, 0, 0, 0]) {
		w.writeBits(8, byte);
	}
	w.writeBits(8, options.levelIdc ?? 93);
	const subLayerFlags = options.subLayerFlags ?? Array.from({ length: maxSubLayersMinus1 }, () => [0, 0]);
	for (const [profilePresent, levelPresent] of subLayerFlags) {
		w.writeBits(1, profilePresent).writeBits(1, levelPresent);
	}
	if (maxSubLayersMinus1 > 0) {
		for (let i = maxSubLayersMinus1; i < 8; i++) {
			w.writeBits(2, 0);
		}
	}
	for (const [profilePresent, levelPresent] of subLayerFlags) {
		if (profilePresent) {
			w.writeBits(8, 0x01).writeBits(32, 0x60000000).writeBits(32, 0x90000000).writeBits(16, 0);
		}
		if (levelPresent) {
			w.writeBits(8, 90);
		}
	}
	w.writeUe(0); // sps_seq_parameter_set_id
	const chromaFormatIdc = options.chromaFormatIdc ?? 1;
	w.writeUe(chromaFormatIdc);
	if (chromaFormatIdc === 3) {
		w.writeFlag(options.separateColourPlane ?? false);
	}
	w.writeUe(options.width).writeUe(options.height);
	w.writeFlag(options.conformanceWindow !== undefined);
	for (const offset of options.conformanceWindow ?? []) {
		w.writeUe(offset);
	}
	w.writeUe((options.bitDepthLuma ?? 8) - 8).writeUe((options.bitDepthChroma ?? 8) - 8);
	w.writeUe(4); // log2_max_pic_order_cnt_lsb_minus4
	const orderingInfo = options.subLayerOrderingInfo ?? false;
	w.writeFlag(orderingInfo);
	const orderingCount = orderingInfo ? maxSubLayersMinus1 + 1 : 1;
	for (let i = 0; i < orderingCount; i++) {
		const reorder = options.reorderPics?.[i] ?? 0;
		w.writeUe(reorder + 1).writeUe(reorder).writeUe(0);
	}
	w.writeUe(0).writeUe(3).writeUe(0).writeUe(3).writeUe(2).writeUe(2); // block sizes, transform depths
	w.writeFlag(options.scalingListData ?? false);
	if (options.scalingListData) {
		w.writeFlag(true); // sps_scaling_list_data_present_flag
		for (let sizeId = 0; sizeId < 4; sizeId++) {
			for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
				// Alternate between copying a reference list and coding one explicitly
				const explicit = (sizeId + matrixId) % 2 === 0;
				w.writeFlag(explicit);
				if (!explicit) {
					w.writeUe(0);
					continue;
				}
				if (sizeId > 1) {
					w.writeSe(8);
				}
				const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
				for (let i = 0; i < coefNum; i++) {
					w.writeSe(i % 3 - 1);
				}
			}
		}
	}
	w.writeFlag(false).writeFlag(true); // amp_enabled_flag, sample_adaptive_offset_enabled_flag
	w.writeFlag(options.pcm ?? false);
	if (options.pcm) {
		w.writeBits(4, 7).writeBits(4, 7).writeUe(0).writeUe(1).writeFlag(true);
	}
	const rpsList = options.shortTermRps ?? [[1, 0]];
	w.writeUe(rpsList.length);
	rpsList.forEach(([negative, positive], index) => {
		if (index !== 0) {
			w.writeFlag(false); // inter_ref_pic_set_prediction_flag
		}
		w.writeUe(negative).writeUe(positive);
		for (let i = 0; i < negative + positive; i++) {
			w.writeUe(i).writeFlag(true);
		}
	});
	w.writeFlag(false); // long_term_ref_pics_present_flag
	w.writeFlag(true).writeFlag(true); // sps_temporal_mvp_enabled_flag, strong_intra_smoothing_enabled_flag
	const vui = options.vui;
	w.writeFlag(vui !== undefined);
	if (vui) {
		w.writeFlag(vui.sar !== undefined);
		if (typeof vui.sar === 'number') {
			w.writeBits(8, vui.sar);
		} else if (vui.sar) {
			w.writeBits(8, 255).writeBits(16, vui.sar[0]).writeBits(16, vui.sar[1]);
		}
		w.writeFlag(false); // overscan_info_present_flag
		w.writeFlag(vui.videoSignal !== undefined);
		if (vui.videoSignal) {
			w.writeBits(3, 5).writeFlag(vui.videoSignal.fullRange).writeFlag(vui.videoSignal.colour !== undefined);
			for (const value of vui.videoSignal.colour ?? []) {
				w.writeBits(8, value);
			}
		}
		w.writeFlag(true).writeUe(0).writeUe(0); // chroma_loc_info
		w.writeFlag(false).writeFlag(false).writeFlag(false); // neutral chroma, field_seq, frame_field_info
		w.writeFlag(vui.defaultDisplayWindow ?? false);
		if (vui.defaultDisplayWindow) {
			w.writeUe(1).writeUe(2).writeUe(3).writeUe(4);
		}
		w.writeFlag(vui.timing !== undefined);
		if (vui.timing) {
			w.writeBits(32, 1001).writeBits(32, 60000).writeFlag(vui.timing.pocProportional);
			if (vui.timing.pocProportional) {
				w.writeUe(0);
			}
			w.writeFlag(false); // vui_hrd_parameters_present_flag
		}
		w.writeFlag(vui.minSpatialSegmentationIdc !== undefined);
		if (vui.minSpatialSegmentationIdc !== undefined) {
			w.writeFlag(false).writeFlag(true).writeFlag(false)
				.writeUe(vui.minSpatialSegmentationIdc).writeUe(2).writeUe(1).writeUe(15).writeUe(15);
		}
	}
	w.writeFlag(false); // sps_extension_present_flag
	w.writeTrailingBits();
	return concatBytes([0x42, 0x01], addEmulationPrevention(w.toBytes()));
};

/** Builds an H.265 PPS NAL unit (type 34) with the given tiles/WPP flags; tiles use a single uniform column/row. */
export const buildHevcPps = (tiles: boolean, entropyCodingSync: boolean, cuQpDelta = false) => {
	const w = new BitWriter()
		.writeUe(0).writeUe(0) // pps_pic_parameter_set_id, pps_seq_parameter_set_id
		.writeFlag(false).writeFlag(false).writeBits(3, 0).writeFlag(false).writeFlag(true)
		.writeUe(0).writeUe(0).writeSe(-3) // num_ref_idx defaults, init_qp_minus26
		.writeFlag(false).writeFlag(false).writeFlag(cuQpDelta);
	if (cuQpDelta) {
		w.writeUe(1);
	}
	w.writeSe(-2).writeSe(2).writeFlag(false).writeFlag(false).writeFlag(false).writeFlag(false);
	w.writeFlag(tiles).writeFlag(entropyCodingSync);
	if (tiles) {
		w.writeUe(1).writeUe(1).writeFlag(true).writeFlag(true); // 2x2 uniform tiles, loop filter across tiles
	}
	w.writeFlag(true).writeFlag(false).writeFlag(false).writeFlag(false).writeFlag(false).writeUe(0);
	w.writeFlag(false).writeFlag(false).writeFlag(false);
	w.writeTrailingBits();
	return concatBytes([0x44, 0x01], addEmulationPrevention(w.toBytes()));
};

/** A QuickTime version 2 sound description ('lpcm' etc.) with a float64 sample rate and format flags. */
export const mp4SoundEntryV2 = (
	format: string,
	channels: number,
	bitsPerChannel: number,
	flags: number,
	sampleRate: number,
	...children: Uint8Array[]
) => {
	const rate = new Uint8Array(8);
	new DataView(rate.buffer).setFloat64(0, sampleRate);
	return mp4Box(
		format,
		[0, 0, 0, 0, 0, 0], u16be(1),
		u16be(2), u16be(0), u32be(0), // version 2, revision level, vendor
		u16be(3), u16be(16), u16be(0xfffe), u16be(0), u32be(0x00010000),
		u32be(72), // sizeOfStructOnly
		rate,
		u32be(channels),
		u32be(0x7f000000),
		u32be(bitsPerChannel),
		u32be(flags),
		u32be(channels * Math.ceil(bitsPerChannel / 8)), // constBytesPerAudioPacket
		u32be(1), // constLPCMFramesPerAudioPacket
		...children,
	);
};

/** An ilst item holding one 'data' box with the given well-known type. */
export const mp4IlstItem = (name: string | number, type: number, payload: Uint8Array | number[] | string) => {
	const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
	const nameBytes = typeof name === 'number' ? u32be(name) : ascii(name);
	const data = mp4Box('data', u32be(type), u32be(0), bytes);
	return concatBytes(u32be(8 + data.length), nameBytes, data);
};

/** A QuickTime-style moov meta box: hdlr 'mdta', a keys box and an ilst addressing the keys by 1-based index. */
export const mp4MdtaMeta = (entries: [key: string, type: number, payload: Uint8Array | number[] | string][]) => {
	const keys = mp4FullBox(
		'keys', 0, 0,
		u32be(entries.length),
		...entries.map(([key]) => concatBytes(u32be(8 + key.length), ascii('mdta'), ascii(key))),
	);
	const ilst = mp4Box('ilst', ...entries.map(([, type, payload], i) => mp4IlstItem(i + 1, type, payload)));
	const hdlr = mp4FullBox('hdlr', 0, 0, u32be(0), ascii('mdta'), new Uint8Array(12), [0]);
	return mp4Box('meta', hdlr, keys, ilst);
};
