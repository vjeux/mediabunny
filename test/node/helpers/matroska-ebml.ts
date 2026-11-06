import { EBMLId } from '../../../src/matroska/ebml.js';

// Byte builders and a tiny EBML parser for the Matroska conformance suites. The builders produce exact bytes so that
// tests can describe a file element by element, and the parser lets tests inspect what the muxer wrote.

export type Bytes = Uint8Array | number[];

/** IDs that src/matroska/ebml.ts doesn't define but which the tests need. */
export const ExtraId = {
	CRC32: 0xbf,
	Title: 0x7ba9,
	SegmentUUID: 0x73a4,
	DocTypeExtension: 0x4281,
	DocTypeExtensionName: 0x4283,
	DocTypeExtensionVersion: 0x4284,
	Position: 0xa7,
	PrevSize: 0xab,
	DiscardPadding: 0x75a2,
	ReferencePriority: 0xfa,
	MaxBlockAdditionID: 0x55ee,
	BlockAdditionMapping: 0x41e4,
	CodecName: 0x258688,
	OutputSamplingFrequency: 0x78b5,
	PixelCropBottom: 0x54aa,
	PixelCropTop: 0x54bb,
	PixelCropLeft: 0x54cc,
	PixelCropRight: 0x54dd,
	FlagInterlaced: 0x9a,
	StereoMode: 0x53b8,
	BitsPerChannel: 0x55b2,
	MaxCLL: 0x55bc,
	MaxFALL: 0x55bd,
	MasteringMetadata: 0x55d0,
	CueRelativePosition: 0xf0,
	CueDuration: 0xb2,
	CueBlockNumber: 0x5378,
	TagDefault: 0x4484,
	TagLanguageBCP47: 0x447b,
	EditionEntry: 0x45b9,
	ChapterAtom: 0xb6,
	ChapterUID: 0x73c4,
	ChapterTimeStart: 0x91,
	ChapterTimeEnd: 0x92,
	ChapterDisplay: 0x80,
	ChapString: 0x85,
	EBMLMaxSizeLength: 0x42f3,
	TrackTimestampScale: 0x23314f,
	ContentEncodingType: 0x5033,
	SimpleTag: 0x67c8,
} as const;

export const concatBytes = (...parts: Bytes[]) => {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}

	return result;
};

export const bigEndian = (value: number, width: number) => Array.from(
	{ length: width },
	(_, i) => Math.floor(value / 2 ** (8 * (width - 1 - i))) & 0xff,
);

/** Encodes an EBML variable-size integer, using the smallest width (or at least `width`) that can hold the value. */
export const vint = (value: number, width?: number) => {
	width ??= 1;
	while (value >= 2 ** (7 * width) - 1) {
		width++;
	}

	const bytes = bigEndian(value, width);
	bytes[0]! |= 1 << (8 - width);
	return bytes;
};

/** The reserved "unknown size" value at the given width: a VINT whose data bits are all ones. */
export const unknownSize = (width = 1) => {
	const bytes = new Array<number>(width).fill(0xff);
	bytes[0] = 0xff >> (width - 1);
	return bytes;
};

export const elementId = (id: number) => bigEndian(id, id < 0x100 ? 1 : id < 0x10000 ? 2 : id < 0x1000000 ? 3 : 4);

export const elementHeader = (id: number, size: number, sizeWidth?: number) => concatBytes(
	elementId(id),
	vint(size, sizeWidth),
);

export const el = (id: number, ...parts: Bytes[]) => {
	const content = concatBytes(...parts);
	return concatBytes(elementHeader(id, content.length), content);
};

/** Like `el`, but the size field has a fixed width (useful for non-minimal size encodings). */
export const elWithSizeWidth = (id: number, sizeWidth: number, ...parts: Bytes[]) => {
	const content = concatBytes(...parts);
	return concatBytes(elementHeader(id, content.length, sizeWidth), content);
};

export const elUnknownSize = (id: number, sizeWidth: number, ...parts: Bytes[]) => concatBytes(
	elementId(id),
	unknownSize(sizeWidth),
	...parts,
);

export const uint = (id: number, value: number, width?: number) => {
	if (width === undefined) {
		width = 1;
		while (value >= 2 ** (8 * width)) {
			width++;
		}
	}

	return el(id, bigEndian(value, width));
};

export const sint = (id: number, value: number, width = 8) => {
	const unsigned = value < 0 ? 2 ** (8 * width) + value : value;
	return el(id, bigEndian(unsigned, width));
};

export const bigUint = (id: number, value: bigint, width = 8) => {
	const bytes: number[] = [];
	for (let i = width - 1; i >= 0; i--) {
		bytes.push(Number((value >> BigInt(8 * i)) & 0xffn));
	}

	return el(id, bytes);
};

export const float32 = (id: number, value: number) => {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setFloat32(0, value);
	return el(id, bytes);
};

export const float64 = (id: number, value: number) => {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setFloat64(0, value);
	return el(id, bytes);
};

export const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
export const str = (id: number, text: string) => el(id, ascii(text));
export const utf8 = (id: number, text: string) => el(id, new TextEncoder().encode(text));

export const ebmlHeader = (docType = 'matroska', extra: Bytes[] = [], docTypeVersion = 4) => el(
	EBMLId.EBML,
	uint(EBMLId.EBMLVersion, 1),
	uint(EBMLId.EBMLReadVersion, 1),
	uint(EBMLId.EBMLMaxIDLength, 4),
	uint(EBMLId.EBMLMaxSizeLength, 8),
	str(EBMLId.DocType, docType),
	uint(EBMLId.DocTypeVersion, docTypeVersion),
	uint(EBMLId.DocTypeReadVersion, 2),
	...extra,
);

/** A complete file: EBML header plus one Segment with a known size. */
export const mkv = (...segmentChildren: Bytes[]) => concatBytes(ebmlHeader(), el(EBMLId.Segment, ...segmentChildren));
export const webm = (...segmentChildren: Bytes[]) => concatBytes(
	ebmlHeader('webm'),
	el(EBMLId.Segment, ...segmentChildren),
);

export const info = (options: { timestampScale?: number | null; duration?: number; extra?: Bytes[] } = {}) => el(
	EBMLId.Info,
	options.timestampScale === null ? [] : uint(EBMLId.TimestampScale, options.timestampScale ?? 1e6),
	options.duration !== undefined ? float64(EBMLId.Duration, options.duration) : [],
	...(options.extra ?? []),
);

export const tracks = (...entries: Bytes[]) => el(EBMLId.Tracks, ...entries);

export const videoTrack = (
	number: number,
	codecId = 'V_VP8',
	options: { width?: number; height?: number; videoExtra?: Bytes[]; extra?: Bytes[] } = {},
) => el(
	EBMLId.TrackEntry,
	uint(EBMLId.TrackNumber, number),
	uint(EBMLId.TrackUID, number),
	uint(EBMLId.TrackType, 1),
	str(EBMLId.CodecID, codecId),
	...(options.extra ?? []),
	el(
		EBMLId.Video,
		uint(EBMLId.PixelWidth, options.width ?? 64),
		uint(EBMLId.PixelHeight, options.height ?? 48),
		...(options.videoExtra ?? []),
	),
);

export const audioTrack = (
	number: number,
	codecId = 'A_OPUS',
	options: {
		sampleRate?: number;
		channels?: number;
		bitDepth?: number;
		codecPrivate?: Bytes;
		audioExtra?: Bytes[];
		extra?: Bytes[];
	} = {},
) => el(
	EBMLId.TrackEntry,
	uint(EBMLId.TrackNumber, number),
	uint(EBMLId.TrackUID, number),
	uint(EBMLId.TrackType, 2),
	str(EBMLId.CodecID, codecId),
	options.codecPrivate ? el(EBMLId.CodecPrivate, options.codecPrivate) : [],
	...(options.extra ?? []),
	el(
		EBMLId.Audio,
		float32(EBMLId.SamplingFrequency, options.sampleRate ?? 48000),
		uint(EBMLId.Channels, options.channels ?? 2),
		options.bitDepth !== undefined ? uint(EBMLId.BitDepth, options.bitDepth) : [],
		...(options.audioExtra ?? []),
	),
);

export const cluster = (timestamp: number, ...children: Bytes[]) => el(
	EBMLId.Cluster,
	uint(EBMLId.Timestamp, timestamp),
	...children,
);

export const blockHeader = (trackNumber: number, relativeTimestamp: number, flags: number) => concatBytes(
	vint(trackNumber),
	bigEndian(relativeTimestamp < 0 ? 0x10000 + relativeTimestamp : relativeTimestamp, 2),
	[flags],
);

export const KEY = 0x80;

export const simpleBlock = (trackNumber: number, relativeTimestamp: number, flags: number, data: Bytes = [0x10]) => el(
	EBMLId.SimpleBlock,
	blockHeader(trackNumber, relativeTimestamp, flags),
	data,
);

export const blockGroup = (
	trackNumber: number,
	relativeTimestamp: number,
	data: Bytes,
	extra: Bytes[] = [],
	flags = 0,
) => el(
	EBMLId.BlockGroup,
	el(EBMLId.Block, blockHeader(trackNumber, relativeTimestamp, flags), data),
	...extra,
);

export const cuePoint = (time: number, ...positions: { track: number; clusterPosition: number }[]) => el(
	EBMLId.CuePoint,
	uint(EBMLId.CueTime, time),
	...positions.map(position => el(
		EBMLId.CueTrackPositions,
		uint(EBMLId.CueTrack, position.track),
		uint(EBMLId.CueClusterPosition, position.clusterPosition, 4), // Fixed width so sizes are predictable
	)),
);

export const seekEntry = (id: number, position: number) => el(
	EBMLId.Seek,
	el(EBMLId.SeekID, elementId(id)),
	uint(EBMLId.SeekPosition, position, 4), // Fixed width so sizes are predictable
);

export const simpleTag = (name: string, value: string | Bytes, ...nested: Bytes[]) => el(
	ExtraId.SimpleTag,
	utf8(EBMLId.TagName, name),
	typeof value === 'string' ? utf8(EBMLId.TagString, value) : el(EBMLId.TagBinary, value),
	...nested,
);

export const tag = (targets: Bytes[], ...simpleTags: Bytes[]) => el(
	EBMLId.Tag,
	el(EBMLId.Targets, ...targets),
	...simpleTags,
);

// Codec bitstream bits that are small enough to inline

/** OpusHead for the given channel count and pre-skip (RFC 7845, section 5.1). */
export const opusHead = (channels = 2, preSkip = 312, sampleRate = 48000) => [
	...ascii('OpusHead'),
	1,
	channels,
	preSkip & 0xff, preSkip >> 8,
	sampleRate & 0xff, (sampleRate >> 8) & 0xff, (sampleRate >> 16) & 0xff, (sampleRate >> 24) & 0xff,
	0, 0, // Output gain
	0, // Channel mapping family
];

/** A 20 ms CELT-only Opus packet (TOC config 31, mono/stereo flag per argument, code 0) with a dummy payload. */
export const opusPacket = (stereo = true, frameDurationConfig = 31) => [
	(frameDurationConfig << 3) | (stereo ? 0x04 : 0),
	0xff,
	0xfe,
];

/** AudioSpecificConfig for AAC-LC (object type 2) at the given sampling frequency index and channel configuration. */
export const aacLcConfig = (frequencyIndex = 3, channelConfiguration = 2) => [
	(2 << 3) | (frequencyIndex >> 1),
	((frequencyIndex & 1) << 7) | (channelConfiguration << 3),
];

// The parser

export type ParsedElement = {
	id: number;
	/** Byte offset of the element's first ID byte. */
	start: number;
	/** Byte offset of the element's data. */
	dataStart: number;
	/** Width of the size field, in bytes. */
	sizeWidth: number;
	/** null when the element has an unknown size. */
	size: number | null;
	end: number;
	data: Uint8Array;
	children: ParsedElement[];
};

/** IDs of master elements whose children the parser should descend into. */
const MASTER_IDS = new Set<number>([
	EBMLId.EBML, EBMLId.Segment, EBMLId.SeekHead, EBMLId.Seek, EBMLId.Info, EBMLId.Tracks, EBMLId.TrackEntry,
	EBMLId.Video, EBMLId.Audio, EBMLId.Colour, EBMLId.Projection, EBMLId.ContentEncodings, EBMLId.ContentEncoding,
	EBMLId.ContentCompression, EBMLId.ContentEncryption, EBMLId.Cluster, EBMLId.BlockGroup, EBMLId.BlockAdditions,
	EBMLId.BlockMore, EBMLId.Cues, EBMLId.CuePoint, EBMLId.CueTrackPositions, EBMLId.Attachments,
	EBMLId.AttachedFile, EBMLId.Chapters, EBMLId.Tags, EBMLId.Tag, EBMLId.Targets, ExtraId.SimpleTag,
	ExtraId.MasteringMetadata, ExtraId.EditionEntry, ExtraId.ChapterAtom, ExtraId.ChapterDisplay,
	ExtraId.BlockAdditionMapping,
]);

const LEVEL_0_AND_1_IDS = new Set<number>([
	EBMLId.EBML, EBMLId.Segment, EBMLId.SeekHead, EBMLId.Info, EBMLId.Tracks, EBMLId.Cluster, EBMLId.Cues,
	EBMLId.Attachments, EBMLId.Chapters, EBMLId.Tags,
]);

const readVintAt = (bytes: Uint8Array, pos: number) => {
	const first = bytes[pos]!;
	if (first === 0) {
		throw new Error(`Invalid VINT at ${pos}`);
	}

	let width = 1;
	let mask = 0x80;
	while (!(first & mask)) {
		width++;
		mask >>= 1;
	}

	let value = first & (mask - 1);
	let allOnes = value === mask - 1;
	for (let i = 1; i < width; i++) {
		const byte = bytes[pos + i]!;
		value = value * 256 + byte;
		allOnes &&= byte === 0xff;
	}

	return { value, width, allOnes };
};

export const readUnsigned = (data: Uint8Array) => data.reduce((value, byte) => value * 256 + byte, 0);
export const readSigned = (data: Uint8Array) => {
	const value = readUnsigned(data);
	return data.length > 0 && data[0]! & 0x80 ? value - 2 ** (8 * data.length) : value;
};

export const readFloat = (data: Uint8Array) => {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	return data.length === 4 ? view.getFloat32(0) : data.length === 8 ? view.getFloat64(0) : 0;
};

export const readString = (data: Uint8Array) => new TextDecoder().decode(data).replace(/\0+$/, '');

export const parseEbml = (bytes: Uint8Array, start = 0, end = bytes.length): ParsedElement[] => {
	const result: ParsedElement[] = [];
	let pos = start;

	while (pos < end) {
		const idVint = readVintAt(bytes, pos);
		const id = readUnsigned(bytes.subarray(pos, pos + idVint.width));
		const sizeVint = readVintAt(bytes, pos + idVint.width);
		const dataStart = pos + idVint.width + sizeVint.width;
		let elementEnd: number;
		let size: number | null;

		if (sizeVint.allOnes) {
			size = null;
			// An unknown-size element ends where an element that can't be its child begins
			elementEnd = end;
			if (id === EBMLId.Cluster) {
				let scan = dataStart;
				while (scan < end) {
					const childIdVint = readVintAt(bytes, scan);
					const childId = readUnsigned(bytes.subarray(scan, scan + childIdVint.width));
					if (LEVEL_0_AND_1_IDS.has(childId)) {
						break;
					}

					const childSize = readVintAt(bytes, scan + childIdVint.width);
					scan += childIdVint.width + childSize.width + childSize.value;
				}

				elementEnd = Math.min(scan, end);
			}
		} else {
			size = sizeVint.value;
			elementEnd = dataStart + size;
		}

		const element: ParsedElement = {
			id,
			start: pos,
			dataStart,
			sizeWidth: sizeVint.width,
			size,
			end: elementEnd,
			data: bytes.subarray(dataStart, elementEnd),
			children: MASTER_IDS.has(id) ? parseEbml(bytes, dataStart, elementEnd) : [],
		};
		result.push(element);
		pos = elementEnd;
	}

	return result;
};

/** Finds all elements along a path of IDs, starting from the given list of elements. */
export const findAll = (elements: ParsedElement[], ...path: number[]): ParsedElement[] => {
	let current = elements;
	for (let i = 0; i < path.length; i++) {
		const matches = current.filter(x => x.id === path[i]);
		if (i === path.length - 1) {
			return matches;
		}

		current = matches.flatMap(x => x.children);
	}

	return current;
};

export const findFirst = (elements: ParsedElement[], ...path: number[]) => {
	const element = findAll(elements, ...path)[0];
	if (!element) {
		throw new Error(`Element path ${path.map(x => '0x' + x.toString(16)).join(' > ')} not found`);
	}

	return element;
};

export const findOptional = (elements: ParsedElement[], ...path: number[]) => findAll(elements, ...path)[0] ?? null;

/** Parses the block header of a SimpleBlock or Block element's data. */
export const parseBlock = (data: Uint8Array) => {
	const trackNumber = readVintAt(data, 0);
	const offset = trackNumber.width;
	const relativeTimestamp = ((data[offset]! << 8) | data[offset + 1]!) << 16 >> 16;
	const flags = data[offset + 2]!;

	return {
		trackNumber: trackNumber.value,
		relativeTimestamp,
		flags,
		payload: data.subarray(offset + 3),
	};
};
