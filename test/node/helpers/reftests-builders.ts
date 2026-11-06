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

// Matroska/WebM

/** An EBML variable-length integer of the smallest length that holds the value (element sizes, track numbers). */
export const ebmlVint = (value: number) => {
	let length = 1;
	while (value >= 2 ** (7 * length) - 1) {
		length++;
	}
	const bytes: number[] = [];
	let rest = value;
	for (let i = 0; i < length; i++) {
		bytes.unshift(rest % 256);
		rest = Math.floor(rest / 256);
	}
	bytes[0]! |= 1 << (8 - length);
	return bytes;
};

/** Element IDs include their own length marker, so they're written as plain big-endian bytes. */
const ebmlIdBytes = (id: number) => {
	const bytes: number[] = [];
	let rest = id;
	while (rest > 0) {
		bytes.unshift(rest % 256);
		rest = Math.floor(rest / 256);
	}
	return bytes;
};

export const ebml = (id: number, ...contents: (Uint8Array | number[])[]) => {
	const payload = concatBytes(...contents);
	return concatBytes(ebmlIdBytes(id), ebmlVint(payload.length), payload);
};

/** An element whose size field has all value bits set, meaning "unknown size". */
export const ebmlUnknownSize = (id: number, sizeLength: number, ...contents: (Uint8Array | number[])[]) => {
	const size = new Array<number>(sizeLength).fill(0xff);
	size[0] = 0xff >> (sizeLength - 1);
	return concatBytes(ebmlIdBytes(id), size, ...contents);
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

export const EBML = {
	Header: 0x1a45dfa3, DocType: 0x4282, Segment: 0x18538067, Info: 0x1549a966, TimestampScale: 0x2ad7b1,
	Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83, CodecID: 0x86,
	CodecPrivate: 0x63a2, DefaultDuration: 0x23e383, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Audio: 0xe1,
	SamplingFrequency: 0xb5, Channels: 0x9f, BitDepth: 0x6264, Cluster: 0x1f43b675, Timestamp: 0xe7,
	SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b, ReferenceBlock: 0xfb, Void: 0xec,
	Crc32: 0xbf,
} as const;

/** The payload of a SimpleBlock or Block: track number, timestamp relative to the cluster, flags, frame. */
export const blockPayload = (trackNumber: number, relativeTimestamp: number, flags: number, frame: number[]) => {
	return concatBytes(ebmlVint(trackNumber), [(relativeTimestamp >> 8) & 0xff, relativeTimestamp & 0xff, flags], frame);
};

/** A 16x16 VP8 key frame header, or a delta frame header, followed by a filler byte. */
export const vp8Frame = (key: boolean) => key
	? [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x10, 0x00, 0x10, 0x00, 0x00]
	: [0x11, 0x02, 0x00, 0x00];

export const webmVideoTrack = (trackNumber: number, ...extra: Uint8Array[]) => ebml(
	EBML.TrackEntry,
	ebmlUint(EBML.TrackNumber, trackNumber),
	ebmlUint(EBML.TrackUID, trackNumber),
	ebmlUint(EBML.TrackType, 1),
	ebml(EBML.CodecID, ascii('V_VP8')),
	ebml(EBML.Video, ebmlUint(EBML.PixelWidth, 16), ebmlUint(EBML.PixelHeight, 16)),
	...extra,
);

/** 16-bit mono PCM at 48 kHz. */
export const webmAudioTrack = (trackNumber: number, ...extra: Uint8Array[]) => ebml(
	EBML.TrackEntry,
	ebmlUint(EBML.TrackNumber, trackNumber),
	ebmlUint(EBML.TrackUID, trackNumber),
	ebmlUint(EBML.TrackType, 2),
	ebml(EBML.CodecID, ascii('A_PCM/INT/LIT')),
	ebml(EBML.Audio, ebmlFloat(EBML.SamplingFrequency, 48000), ebmlUint(EBML.Channels, 1),
		ebmlUint(EBML.BitDepth, 16)),
	...extra,
);

/** A WebM file with a millisecond timestamp scale: EBML header, then a Segment holding Info, Tracks and the rest. */
export const buildWebm = (options: { docType?: string; tracks: Uint8Array[]; body: Uint8Array[] }) => concatBytes(
	ebml(
		EBML.Header,
		ebmlUint(0x4286, 1), // EBMLVersion
		ebmlUint(0x42f7, 1), // EBMLReadVersion
		ebmlUint(0x42f2, 4), // EBMLMaxIDLength
		ebmlUint(0x42f3, 8), // EBMLMaxSizeLength
		ebml(EBML.DocType, ascii(options.docType ?? 'webm')),
		ebmlUint(0x4287, 4), // DocTypeVersion
		ebmlUint(0x4285, 2), // DocTypeReadVersion
	),
	ebml(
		EBML.Segment,
		ebml(EBML.Info, ebmlUint(EBML.TimestampScale, 1_000_000), ebml(0x4d80, ascii('ref')), ebml(0x5741, ascii('ref'))),
		ebml(EBML.Tracks, ...options.tracks),
		...options.body,
	),
);
