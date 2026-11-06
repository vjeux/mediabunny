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
