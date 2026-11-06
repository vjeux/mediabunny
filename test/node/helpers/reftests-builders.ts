// Byte builders for the reference-implementation cases suite (test/node/reference-implementation-cases.test.ts).

export const hexBytes = (hex: string) => {
	const clean = hex.replace(/[^0-9a-fA-F]/g, '');
	const bytes = new Uint8Array(clean.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
	}
	return bytes;
};

export const toHex = (bytes: Uint8Array) => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');

export const concatBytes = (...parts: (Uint8Array | number[])[]) => {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
};

/** MSB-first bit writer with Exp-Golomb support, for hand-crafted parameter sets. */
export class BitWriter {
	private bits: number[] = [];

	bit(value: boolean | number) {
		this.bits.push(value ? 1 : 0);
		return this;
	}

	u(numBits: number, value: number) {
		for (let i = numBits - 1; i >= 0; i--) {
			this.bits.push(Math.floor(value / 2 ** i) % 2);
		}
		return this;
	}

	ue(value: number) {
		const codeNum = value + 1;
		const length = Math.floor(Math.log2(codeNum));
		this.u(length, 0);
		this.u(length + 1, codeNum);
		return this;
	}

	se(value: number) {
		return this.ue(value > 0 ? 2 * value - 1 : -2 * value);
	}

	/** Appends rbsp_trailing_bits() and returns the bytes. */
	rbsp() {
		this.bits.push(1);
		while (this.bits.length % 8 !== 0) {
			this.bits.push(0);
		}
		return this.bytes();
	}

	bytes() {
		const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
		this.bits.forEach((bit, i) => {
			bytes[i >> 3]! |= bit << (7 - (i & 7));
		});
		return bytes;
	}
}

/** Inserts emulation prevention bytes into an RBSP, giving NAL unit payload bytes. */
export const escapeRbsp = (rbsp: Uint8Array) => {
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

export const annexB = (...nalUnits: Uint8Array[]) => concatBytes(...nalUnits.flatMap(nalu => [[0, 0, 0, 1], nalu]));

// ISOBMFF

export const u8 = (value: number) => [value & 0xff];
export const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
export const u24 = (value: number) => [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
export const u32 = (value: number) => [
	Math.floor(value / 2 ** 24) & 0xff,
	(value >> 16) & 0xff,
	(value >> 8) & 0xff,
	value & 0xff,
];
export const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));

export const box = (type: string, ...contents: (Uint8Array | number[])[]) => {
	const payload = concatBytes(...contents);
	return concatBytes(u32(8 + payload.length), ascii(type), payload);
};

export const fullBox = (type: string, version: number, flags: number, ...contents: (Uint8Array | number[])[]) => {
	return box(type, u8(version), u24(flags), ...contents);
};

export const audioSampleEntry = (
	type: string,
	options: { channels: number; sampleRate: number; sampleSize?: number },
	...children: Uint8Array[]
) => box(
	type,
	new Array<number>(6).fill(0), // reserved
	u16(1), // data_reference_index
	new Array<number>(8).fill(0), // reserved
	u16(options.channels),
	u16(options.sampleSize ?? 16),
	u16(0), // pre_defined
	u16(0), // reserved
	u32(options.sampleRate * 0x10000 >>> 0),
	...children,
);

export const visualSampleEntry = (
	type: string,
	options: { width: number; height: number },
	...children: Uint8Array[]
) => box(
	type,
	new Array<number>(6).fill(0), // reserved
	u16(1), // data_reference_index
	new Array<number>(16).fill(0), // pre_defined, reserved
	u16(options.width),
	u16(options.height),
	u32(0x00480000), // horizresolution
	u32(0x00480000), // vertresolution
	u32(0), // reserved
	u16(1), // frame_count
	new Array<number>(32).fill(0), // compressorname
	u16(0x0018), // depth
	u16(0xffff), // pre_defined
	...children,
);

const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

/** A non-fragmented MP4 holding a single track whose samples are laid out in one chunk. */
export const buildSingleTrackMp4 = (options: {
	type: 'audio' | 'video';
	sampleEntry: Uint8Array;
	timescale: number;
	samples: { data: Uint8Array; duration: number; key?: boolean }[];
	width?: number;
	height?: number;
}) => {
	const { type, sampleEntry, timescale, samples } = options;
	const totalDuration = samples.reduce((sum, sample) => sum + sample.duration, 0);
	const sizes = samples.map(sample => sample.data.length);
	const sttsEntries: [number, number][] = [];
	for (const sample of samples) {
		const last = sttsEntries[sttsEntries.length - 1];
		if (last && last[1] === sample.duration) {
			last[0]++;
		} else {
			sttsEntries.push([1, sample.duration]);
		}
	}
	const syncSamples = samples.flatMap((sample, i) => sample.key === false ? [] : [i + 1]);
	const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isomiso2mp41'));

	const buildMoov = (chunkOffset: number) => box(
		'moov',
		fullBox('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(totalDuration), u32(0x10000), u16(0x100), u16(0),
			u32(0), u32(0), ...MATRIX.map(u32), new Array<number>(24).fill(0), u32(2)),
		box(
			'trak',
			fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(totalDuration), u32(0), u32(0), u16(0), u16(0),
				u16(type === 'audio' ? 0x100 : 0), u16(0), ...MATRIX.map(u32),
				u32((options.width ?? 0) * 0x10000), u32((options.height ?? 0) * 0x10000)),
			box(
				'mdia',
				fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(totalDuration), u16(0x55c4), u16(0)),
				fullBox('hdlr', 0, 0, u32(0), ascii(type === 'audio' ? 'soun' : 'vide'), u32(0), u32(0), u32(0), [0]),
				box(
					'minf',
					type === 'audio'
						? fullBox('smhd', 0, 0, u16(0), u16(0))
						: fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
					box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
					box(
						'stbl',
						fullBox('stsd', 0, 0, u32(1), sampleEntry),
						fullBox('stts', 0, 0, u32(sttsEntries.length), sttsEntries.flatMap(
							([count, delta]) => [...u32(count), ...u32(delta)],
						)),
						...(type === 'video' && syncSamples.length < samples.length
							? [fullBox('stss', 0, 0, u32(syncSamples.length), ...syncSamples.map(u32))]
							: []),
						fullBox('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1)),
						fullBox('stsz', 0, 0, u32(0), u32(samples.length), ...sizes.map(u32)),
						fullBox('stco', 0, 0, u32(1), u32(chunkOffset)),
					),
				),
			),
		),
	);

	const moovSize = buildMoov(0).length;
	const mdat = box('mdat', ...samples.map(sample => sample.data));
	return concatBytes(ftyp, buildMoov(ftyp.length + moovSize + 8), mdat);
};

/** An esds box around an ES_Descriptor; lengths are written with the given number of size bytes. */
export const esds = (options: {
	objectTypeIndication: number;
	decoderSpecificInfo?: Uint8Array;
	lengthBytes?: number;
}) => {
	const lengthBytes = options.lengthBytes ?? 1;
	const descriptor = (tag: number, contents: Uint8Array) => {
		const size: number[] = [];
		for (let i = lengthBytes - 1; i >= 0; i--) {
			size.push(((contents.length >> (7 * i)) & 0x7f) | (i > 0 ? 0x80 : 0));
		}
		return concatBytes([tag], size, contents);
	};
	const decoderConfig = descriptor(4, concatBytes(
		[options.objectTypeIndication, 0x15],
		u24(0), // bufferSizeDB
		u32(128000), // maxBitrate
		u32(128000), // avgBitrate
		options.decoderSpecificInfo ? descriptor(5, options.decoderSpecificInfo) : [],
	));
	const slConfig = descriptor(6, new Uint8Array([2]));
	return fullBox('esds', 0, 0, descriptor(3, concatBytes(u16(1), [0], decoderConfig, slConfig)));
};
