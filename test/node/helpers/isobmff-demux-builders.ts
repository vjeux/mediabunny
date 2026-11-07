// Byte builders for the ISOBMFF demuxer conformance suite (isobmff-demuxer-conformance.test.ts). Everything is
// written as plain number arrays and laid out by the build functions, which compute chunk and data offsets.

export type Bytes = number[];

export const u8 = (value: number): Bytes => [value & 0xff];
export const u16 = (value: number): Bytes => [(value >> 8) & 0xff, value & 0xff];
export const u24 = (value: number): Bytes => [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
export const u32 = (value: number): Bytes => [
	(value >>> 24) & 0xff,
	(value >>> 16) & 0xff,
	(value >>> 8) & 0xff,
	value & 0xff,
];
export const i16 = (value: number): Bytes => u16(value & 0xffff);
export const i32 = (value: number): Bytes => u32(value >>> 0);
export const u64 = (value: number): Bytes => [...u32(Math.floor(value / 2 ** 32)), ...u32(value % 2 ** 32)];
export const i64 = (value: number): Bytes => {
	const high = Math.floor(value / 2 ** 32);
	return [...u32(high >>> 0), ...u32(value - high * 2 ** 32)];
};
export const fixed16_16 = (value: number): Bytes => i32(Math.round(value * 0x10000));
export const fixed2_30 = (value: number): Bytes => i32(Math.round(value * 0x40000000));
export const ascii = (text: string): Bytes => [...text].map(char => char.charCodeAt(0));
export const utf8 = (text: string): Bytes => [...new TextEncoder().encode(text)];
export const zeros = (count: number): Bytes => new Array<number>(count).fill(0);

export const box = (type: string, ...contents: Bytes[]): Bytes => {
	const bytes = contents.flat();
	return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
};

export const fullBox = (type: string, version: number, flags: number, ...contents: Bytes[]): Bytes => {
	return box(type, u8(version), u24(flags), ...contents);
};

/** A box with a 64-bit size field. */
export const largeBox = (type: string, ...contents: Bytes[]): Bytes => {
	const bytes = contents.flat();
	return [...u32(1), ...ascii(type), ...u64(16 + bytes.length), ...bytes];
};

/** [a, b, u, c, d, v, x, y, w] like in ISO/IEC 14496-12, u, v and w being 2.30 fixed point. */
export type Matrix = [number, number, number, number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const matrixBytes = (matrix: Matrix): Bytes => matrix.flatMap((value, i) => {
	return i % 3 === 2 ? fixed2_30(value) : fixed16_16(value);
});

export const ftyp = (majorBrand = 'isom', compatibleBrands = ['isom', 'iso2', 'mp41']) => {
	return box('ftyp', ascii(majorBrand), u32(512), ...compatibleBrands.map(ascii));
};

export const mvhd = (options: {
	version?: number;
	timescale?: number;
	duration?: number;
	creationTime?: number;
	matrix?: Matrix;
} = {}) => {
	const version = options.version ?? 0;
	const timescale = options.timescale ?? 1000;
	const times = version === 1
		? [...u64(options.creationTime ?? 0), ...u64(0), ...u32(timescale), ...u64(options.duration ?? 0)]
		: [...u32(options.creationTime ?? 0), ...u32(0), ...u32(timescale), ...u32(options.duration ?? 0)];

	return fullBox('mvhd', version, 0,
		times,
		fixed16_16(1), // Rate
		u16(0x100), // Volume
		zeros(10),
		matrixBytes(options.matrix ?? IDENTITY),
		zeros(24),
		u32(0xffffffff), // Next track ID
	);
};

export const tkhd = (options: {
	version?: number;
	flags?: number;
	trackId?: number;
	duration?: number;
	matrix?: Matrix;
	width?: number;
	height?: number;
} = {}) => {
	const version = options.version ?? 0;
	const trackId = options.trackId ?? 1;
	const times = version === 1
		? [...u64(0), ...u64(0), ...u32(trackId), ...u32(0), ...u64(options.duration ?? 0)]
		: [...u32(0), ...u32(0), ...u32(trackId), ...u32(0), ...u32(options.duration ?? 0)];

	return fullBox('tkhd', version, options.flags ?? 3,
		times,
		zeros(8),
		u16(0), // Layer
		u16(0), // Alternate group
		u16(0), // Volume
		u16(0),
		matrixBytes(options.matrix ?? IDENTITY),
		fixed16_16(options.width ?? 0),
		fixed16_16(options.height ?? 0),
	);
};

/** Packs an ISO 639-2/T code like mdhd does. */
export const packLanguage = (code: string) => {
	return ((code.charCodeAt(0) - 0x60) << 10) | ((code.charCodeAt(1) - 0x60) << 5) | (code.charCodeAt(2) - 0x60);
};

export const mdhd = (options: {
	version?: number;
	timescale: number;
	duration?: number;
	language?: string | number;
}) => {
	const version = options.version ?? 0;
	const times = version === 1
		? [...u64(0), ...u64(0), ...u32(options.timescale), ...u64(options.duration ?? 0)]
		: [...u32(0), ...u32(0), ...u32(options.timescale), ...u32(options.duration ?? 0)];
	const language = typeof options.language === 'number'
		? options.language
		: packLanguage(options.language ?? 'und');

	return fullBox('mdhd', version, 0, times, u16(language), u16(0));
};

export const hdlr = (handlerType: string, name = '') => {
	return fullBox('hdlr', 0, 0, u32(0), ascii(handlerType), zeros(12), utf8(name), [0]);
};

export const visualSampleEntry = (type: string, options: {
	width?: number;
	height?: number;
	children?: Bytes[];
} = {}) => {
	return box(type,
		zeros(6),
		u16(1), // Data reference index
		zeros(16),
		u16(options.width ?? 64),
		u16(options.height ?? 64),
		fixed16_16(72),
		fixed16_16(72),
		u32(0),
		u16(1), // Frame count
		zeros(32), // Compressor name
		u16(24), // Depth
		i16(-1),
		...(options.children ?? []),
	);
};

export const audioSampleEntry = (type: string, options: {
	channels?: number;
	sampleSize?: number;
	sampleRate?: number;
	/** The QuickTime sound sample description version (0, 1 or 2). */
	version?: number;
	/** The fields that follow in version 1 or 2, as raw bytes. */
	versionFields?: Bytes;
	children?: Bytes[];
} = {}) => {
	return box(type,
		zeros(6),
		u16(1), // Data reference index
		u16(options.version ?? 0),
		zeros(6), // Revision level, vendor
		u16(options.channels ?? 2),
		u16(options.sampleSize ?? 16),
		u16(0), // Compression ID
		u16(0), // Packet size
		u32(((options.sampleRate ?? 48000) * 0x10000) % 2 ** 32),
		options.versionFields ?? [],
		...(options.children ?? []),
	);
};

/** QuickTime sound sample description version 1 fields. */
export const soundV1Fields = (samplesPerPacket: number, bytesPerPacket: number, bytesPerFrame: number) => {
	return [...u32(samplesPerPacket), ...u32(bytesPerPacket), ...u32(bytesPerFrame), ...u32(2)];
};

/** QuickTime sound sample description version 2 fields. */
export const soundV2Fields = (options: {
	sampleRate: number;
	channels: number;
	bitsPerChannel: number;
	formatFlags: number;
	bytesPerPacket: number;
}) => {
	const sampleRate = new Uint8Array(new Float64Array([options.sampleRate]).buffer).reverse();
	return [
		...u32(72), // Size of struct only
		...sampleRate,
		...u32(options.channels),
		...u32(0x7f000000),
		...u32(options.bitsPerChannel),
		...u32(options.formatFlags),
		...u32(options.bytesPerPacket),
		...u32(1), // LPCM frames per packet
	];
};

/** An MPEG-4 descriptor, with its size written in `lengthBytes` bytes (1 to 4). */
export const descriptor = (tag: number, contents: Bytes, lengthBytes = 1) => {
	const length: Bytes = [];
	for (let i = lengthBytes - 1; i >= 0; i--) {
		length.push(((contents.length >> (7 * i)) & 0x7f) | (i > 0 ? 0x80 : 0));
	}

	return [tag, ...length, ...contents];
};

export const esds = (options: {
	objectTypeIndication?: number;
	decoderSpecificInfo?: Bytes | null;
	lengthBytes?: number;
	esFlags?: number;
} = {}) => {
	const lengthBytes = options.lengthBytes ?? 1;
	const decoderSpecificInfo = options.decoderSpecificInfo === undefined
		? [0x12, 0x10] // AAC-LC, 44100 Hz, stereo
		: options.decoderSpecificInfo;
	const esFlags = options.esFlags ?? 0;

	const decoderConfig = descriptor(0x04, [
		options.objectTypeIndication ?? 0x40,
		0x15, // Audio stream
		...u24(0),
		...u32(128000),
		...u32(128000),
		...(decoderSpecificInfo ? descriptor(0x05, decoderSpecificInfo, lengthBytes) : []),
	], lengthBytes);

	return fullBox('esds', 0, 0, descriptor(0x03, [
		...u16(1), // ES ID
		esFlags,
		...(esFlags & 0x80 ? u16(2) : []),
		...(esFlags & 0x40 ? [3, ...ascii('abc')] : []),
		...(esFlags & 0x20 ? u16(4) : []),
		...decoderConfig,
		...descriptor(0x06, [0x02], lengthBytes), // SLConfigDescriptor
	], lengthBytes));
};

export const stsd = (...entries: Bytes[]) => fullBox('stsd', 0, 0, u32(entries.length), ...entries);

export const stts = (entries: [count: number, delta: number][]) => {
	return fullBox('stts', 0, 0, u32(entries.length), ...entries.map(([count, delta]) => [
		...u32(count),
		...u32(delta),
	]));
};

export const ctts = (entries: [count: number, offset: number][], version = 0) => {
	return fullBox('ctts', version, 0, u32(entries.length), ...entries.map(([count, offset]) => [
		...u32(count),
		...i32(offset),
	]));
};

/** Sample numbers are 1-based, like in the box. */
export const stss = (sampleNumbers: number[]) => {
	return fullBox('stss', 0, 0, u32(sampleNumbers.length), ...sampleNumbers.map(u32));
};

export const stsz = (sizes: number[] | { constantSize: number; count: number }) => {
	if (Array.isArray(sizes)) {
		return fullBox('stsz', 0, 0, u32(0), u32(sizes.length), ...sizes.map(u32));
	}

	return fullBox('stsz', 0, 0, u32(sizes.constantSize), u32(sizes.count));
};

export const stz2 = (fieldSize: 4 | 8 | 16, sizes: number[]) => {
	const bytes: Bytes = [];
	if (fieldSize === 4) {
		for (let i = 0; i < sizes.length; i += 2) {
			bytes.push((sizes[i]! << 4) | (sizes[i + 1] ?? 0));
		}
	} else {
		for (const size of sizes) {
			bytes.push(...(fieldSize === 8 ? u8(size) : u16(size)));
		}
	}

	return fullBox('stz2', 0, 0, zeros(3), u8(fieldSize), u32(sizes.length), bytes);
};

/** Chunk numbers are 1-based, like in the box. */
export const stsc = (entries: [firstChunk: number, samplesPerChunk: number, sampleDescriptionIndex: number][]) => {
	return fullBox('stsc', 0, 0, u32(entries.length), ...entries.map(entry => entry.flatMap(u32)));
};

export const stco = (offsets: number[]) => fullBox('stco', 0, 0, u32(offsets.length), ...offsets.map(u32));
export const co64 = (offsets: number[]) => fullBox('co64', 0, 0, u32(offsets.length), ...offsets.map(u64));

export const elst = (entries: [segmentDuration: number, mediaTime: number, mediaRate: number][], version = 0) => {
	return box('edts', fullBox('elst', version, 0, u32(entries.length), ...entries.map(([duration, time, rate]) => [
		...(version === 1 ? [...u64(duration), ...i64(time)] : [...u32(duration), ...i32(time)]),
		...fixed16_16(rate),
	])));
};

/** A data box of an ilst item. */
export const dataBox = (typeIndicator: number, value: Bytes) => box('data', u32(typeIndicator), u32(0), value);

export const ilstMeta = (items: Bytes[], handlerType = 'mdir', keys?: string[]) => {
	if (keys) {
		// QuickTime metadata: no version and flags
		return box('meta',
			hdlr(handlerType),
			fullBox('keys', 0, 0, u32(keys.length), ...keys.map(key => box('mdta', utf8(key)))),
			box('ilst', ...items),
		);
	}

	return fullBox('meta', 0, 0, hdlr(handlerType), box('ilst', ...items));
};

/** A QuickTime user data text atom (international text with a length and a language code). */
export const udtaText = (type: string, text: string, language = 0x55c4) => {
	const bytes = utf8(text);
	return box(type, u16(bytes.length), u16(language), bytes);
};

export type TableSample = {
	data: Bytes;
	duration: number;
	compositionOffset?: number;
	isKeyFrame?: boolean;
};

export type DefaultSampleTableBoxes = {
	stts: Bytes;
	ctts: Bytes | null;
	stss: Bytes | null;
	stsz: Bytes;
	stsc: Bytes;
	stco: Bytes;
};

export type TableTrack = {
	handlerType?: string;
	trackId?: number;
	timescale: number;
	sampleEntry: Bytes;
	samples: TableSample[];
	/** Samples per chunk (default: 4). */
	chunkSize?: number;
	tkhd?: Parameters<typeof tkhd>[0];
	mdhd?: Partial<Parameters<typeof mdhd>[0]>;
	edits?: Bytes;
	cttsVersion?: number;
	/** Replace generated sample table boxes; receives the absolute chunk offsets. */
	stbl?: (chunkOffsets: number[], defaults: DefaultSampleTableBoxes) => Bytes[];
	trakChildren?: Bytes[];
	minfChildren?: Bytes[];
};

const groupRuns = <T>(values: T[]) => {
	const runs: [T, number][] = [];
	for (const value of values) {
		const lastRun = runs[runs.length - 1];
		if (lastRun && lastRun[0] === value) {
			lastRun[1]++;
		} else {
			runs.push([value, 1]);
		}
	}

	return runs;
};

const buildTrak = (track: TableTrack, chunkOffsets: number[], chunkSampleCounts: number[]) => {
	const trackId = track.trackId ?? 1;
	const durations = track.samples.map(x => x.duration);
	const offsets = track.samples.map(x => x.compositionOffset ?? 0);
	const keyFrames = track.samples.map((x, i) => (x.isKeyFrame ?? true) ? i + 1 : -1).filter(x => x !== -1);

	const stscEntries: [number, number, number][] = [];
	chunkSampleCounts.forEach((count, i) => {
		if (stscEntries.length === 0 || stscEntries[stscEntries.length - 1]![1] !== count) {
			stscEntries.push([i + 1, count, 1]);
		}
	});

	const defaults = {
		stts: stts(groupRuns(durations).map(([delta, count]) => [count, delta])),
		ctts: offsets.some(x => x !== 0)
			? ctts(groupRuns(offsets).map(([offset, count]) => [count, offset]), track.cttsVersion ?? 0)
			: null,
		stss: keyFrames.length < track.samples.length ? stss(keyFrames) : null,
		stsz: stsz(track.samples.map(x => x.data.length)),
		stsc: stsc(stscEntries),
		stco: stco(chunkOffsets),
	};
	const stblChildren = track.stbl
		? track.stbl(chunkOffsets, defaults)
		: [defaults.stts, defaults.ctts ?? [], defaults.stss ?? [], defaults.stsz, defaults.stsc, defaults.stco];

	const handlerType = track.handlerType ?? 'vide';
	const mediaDuration = durations.reduce((a, b) => a + b, 0);

	return box('trak',
		tkhd({ trackId, ...track.tkhd }),
		track.edits ?? [],
		...(track.trakChildren ?? []),
		box('mdia',
			mdhd({ timescale: track.timescale, duration: mediaDuration, ...track.mdhd }),
			hdlr(handlerType),
			box('minf',
				...(track.minfChildren ?? []),
				box('stbl', stsd(track.sampleEntry), ...stblChildren),
			),
		),
	);
};

/** Lays out ftyp, moov and mdat (or mdat before moov) for non-fragmented tracks, with correct chunk offsets. */
export const buildMp4 = (options: {
	tracks: TableTrack[];
	ftyp?: Bytes;
	movieTimescale?: number;
	mvhd?: Parameters<typeof mvhd>[0];
	moovChildren?: Bytes[];
	mdatFirst?: boolean;
	/** Boxes placed between ftyp and the rest. */
	leadingBoxes?: Bytes[];
	/** Boxes placed at the end of the file. */
	trailingBoxes?: Bytes[];
	largeMdat?: boolean;
}) => {
	// Interleave the chunks of all tracks in the mdat
	const payload: Bytes = [];
	const relativeChunkOffsets: number[][] = options.tracks.map(() => []);
	const chunkSampleCounts: number[][] = options.tracks.map(() => []);
	const positions = options.tracks.map(() => 0);

	while (options.tracks.some((track, i) => positions[i]! < track.samples.length)) {
		options.tracks.forEach((track, i) => {
			const start = positions[i]!;
			if (start >= track.samples.length) {
				return;
			}

			const end = Math.min(start + (track.chunkSize ?? 4), track.samples.length);
			relativeChunkOffsets[i]!.push(payload.length);
			chunkSampleCounts[i]!.push(end - start);
			for (let j = start; j < end; j++) {
				payload.push(...track.samples[j]!.data);
			}
			positions[i] = end;
		});
	}

	const ftypBytes = options.ftyp ?? ftyp();
	const leading = (options.leadingBoxes ?? []).flat();
	const mdatHeaderSize = options.largeMdat ? 16 : 8;
	const buildMoov = (base: number) => box('moov',
		mvhd({ timescale: options.movieTimescale ?? 1000, ...options.mvhd }),
		...options.tracks.map((track, i) => buildTrak(
			track,
			relativeChunkOffsets[i]!.map(x => x + base),
			chunkSampleCounts[i]!,
		)),
		...(options.moovChildren ?? []),
	);
	const mdat = options.largeMdat ? largeBox('mdat', payload) : box('mdat', payload);

	let moov: Bytes;
	if (options.mdatFirst) {
		moov = buildMoov(ftypBytes.length + leading.length + mdatHeaderSize);
	} else {
		const moovSize = buildMoov(0).length;
		moov = buildMoov(ftypBytes.length + leading.length + moovSize + mdatHeaderSize);
	}

	return new Uint8Array([
		...ftypBytes,
		...leading,
		...(options.mdatFirst ? [...mdat, ...moov] : [...moov, ...mdat]),
		...(options.trailingBoxes ?? []).flat(),
	]);
};

export type FragmentSample = {
	data: Bytes;
	duration?: number;
	flags?: number;
	compositionOffset?: number;
};

export type Trun = {
	version?: number;
	samples: FragmentSample[];
	/** Which per-sample fields to write (default: all of them). */
	fields?: { duration?: boolean; size?: boolean; flags?: boolean; compositionOffset?: boolean };
	firstSampleFlags?: number;
	/** Whether to write the data offset (default: true). */
	writeDataOffset?: boolean;
};

export type Traf = {
	trackId: number;
	/** How the base data offset is established (default: 'moof', i.e. default-base-is-moof). */
	base?: 'moof' | 'explicit-moof' | 'explicit-data' | 'implicit';
	sampleDescriptionIndex?: number;
	defaultSampleDuration?: number;
	defaultSampleSize?: number;
	defaultSampleFlags?: number;
	durationIsEmpty?: boolean;
	baseMediaDecodeTime?: number | null;
	tfdtVersion?: number;
	truns: Trun[];
	extraChildren?: Bytes[];
};

export const SAMPLE_FLAGS_SYNC = 0x02000000; // sample_depends_on = 2
export const SAMPLE_FLAGS_NON_SYNC = 0x01010000; // sample_depends_on = 1, sample_is_non_sync_sample

const buildMoof = (sequenceNumber: number, trafs: Traf[], moofOffset: number, dataStart: number) => {
	let dataPos = dataStart; // Absolute position of the next sample data
	let previousTrafDataEnd = moofOffset;

	return box('moof',
		fullBox('mfhd', 0, 0, u32(sequenceNumber)),
		...trafs.map((traf) => {
			const base = traf.base ?? 'moof';
			let flags = 0;
			const tfhdFields: Bytes[] = [];
			let baseDataOffset: number;

			if (base === 'explicit-moof' || base === 'explicit-data') {
				flags |= 0x000001;
				baseDataOffset = base === 'explicit-moof' ? moofOffset : dataPos;
				tfhdFields.push(u64(baseDataOffset));
			} else if (base === 'moof') {
				flags |= 0x020000;
				baseDataOffset = moofOffset;
			} else {
				baseDataOffset = previousTrafDataEnd;
			}

			if (traf.sampleDescriptionIndex !== undefined) {
				flags |= 0x000002;
				tfhdFields.push(u32(traf.sampleDescriptionIndex));
			}
			if (traf.defaultSampleDuration !== undefined) {
				flags |= 0x000008;
				tfhdFields.push(u32(traf.defaultSampleDuration));
			}
			if (traf.defaultSampleSize !== undefined) {
				flags |= 0x000010;
				tfhdFields.push(u32(traf.defaultSampleSize));
			}
			if (traf.defaultSampleFlags !== undefined) {
				flags |= 0x000020;
				tfhdFields.push(u32(traf.defaultSampleFlags));
			}
			if (traf.durationIsEmpty) {
				flags |= 0x010000;
			}

			const truns = traf.truns.map((trun) => {
				const fields = {
					duration: true,
					size: true,
					flags: true,
					compositionOffset: true,
					...trun.fields,
				};
				let trunFlags = 0;
				const header: Bytes[] = [];
				if (trun.writeDataOffset ?? true) {
					trunFlags |= 0x000001;
					header.push(i32(dataPos - baseDataOffset));
				}
				if (trun.firstSampleFlags !== undefined) {
					trunFlags |= 0x000004;
					header.push(u32(trun.firstSampleFlags));
				}
				trunFlags |= (fields.duration ? 0x100 : 0) | (fields.size ? 0x200 : 0) | (fields.flags ? 0x400 : 0)
					| (fields.compositionOffset ? 0x800 : 0);

				const entries = trun.samples.map(sample => [
					...(fields.duration ? u32(sample.duration ?? 1) : []),
					...(fields.size ? u32(sample.data.length) : []),
					...(fields.flags ? u32(sample.flags ?? SAMPLE_FLAGS_SYNC) : []),
					...(fields.compositionOffset ? i32(sample.compositionOffset ?? 0) : []),
				]);
				for (const sample of trun.samples) {
					dataPos += sample.data.length;
				}

				return fullBox('trun', trun.version ?? 0, trunFlags, u32(trun.samples.length), ...header, ...entries);
			});
			previousTrafDataEnd = dataPos;

			return box('traf',
				fullBox('tfhd', 0, flags, u32(traf.trackId), ...tfhdFields),
				traf.baseMediaDecodeTime === null
					? []
					: (traf.tfdtVersion ?? 1) === 1
							? fullBox('tfdt', 1, 0, u64(traf.baseMediaDecodeTime ?? 0))
							: fullBox('tfdt', 0, 0, u32(traf.baseMediaDecodeTime ?? 0)),
				...truns,
				...(traf.extraChildren ?? []),
			);
		}),
	);
};

/** Builds a moof plus its mdat, placed at `moofOffset` in the file. */
export const buildFragment = (sequenceNumber: number, trafs: Traf[], moofOffset: number) => {
	// The moof's size doesn't depend on the offsets, so measure it first
	const moofSize = buildMoof(sequenceNumber, trafs, moofOffset, 0).length;
	const moof = buildMoof(sequenceNumber, trafs, moofOffset, moofOffset + moofSize + 8);
	const data = trafs.flatMap(traf => traf.truns.flatMap(trun => trun.samples.flatMap(sample => sample.data)));

	return [...moof, ...box('mdat', data)];
};

export type FragmentedTrack = {
	handlerType?: string;
	trackId: number;
	timescale: number;
	sampleEntries: Bytes[];
	trex?: { sampleDescriptionIndex?: number; duration?: number; size?: number; flags?: number } | null;
	edits?: Bytes;
	tkhd?: Parameters<typeof tkhd>[0];
};

/** Builds an initialization segment (ftyp + moov with empty sample tables and mvex). */
export const buildInit = (options: {
	tracks: FragmentedTrack[];
	ftyp?: Bytes;
	movieTimescale?: number;
	mvexChildren?: Bytes[];
	moovChildren?: Bytes[];
}) => {
	return [
		...(options.ftyp ?? ftyp('iso6', ['iso6', 'mp41'])),
		...box('moov',
			mvhd({ timescale: options.movieTimescale ?? 1000 }),
			...options.tracks.map(track => box('trak',
				tkhd({ trackId: track.trackId, ...track.tkhd }),
				track.edits ?? [],
				box('mdia',
					mdhd({ timescale: track.timescale }),
					hdlr(track.handlerType ?? 'vide'),
					box('minf', box('stbl',
						stsd(...track.sampleEntries),
						stts([]),
						stsc([]),
						stsz([]),
						stco([]),
					)),
				),
			)),
			box('mvex',
				...(options.mvexChildren ?? []),
				...options.tracks.filter(track => track.trex !== null).map(track => fullBox('trex', 0, 0,
					u32(track.trackId),
					u32(track.trex?.sampleDescriptionIndex ?? 1),
					u32(track.trex?.duration ?? 0),
					u32(track.trex?.size ?? 0),
					u32(track.trex?.flags ?? 0),
				)),
			),
			...(options.moovChildren ?? []),
		),
	];
};

/** Builds a fragmented file: the init segment followed by one fragment (moof + mdat) per entry. */
export const buildFragmentedMp4 = (options: Parameters<typeof buildInit>[0] & {
	fragments: Traf[][];
	trailingBoxes?: (fragmentOffsets: number[]) => Bytes[];
}) => {
	const bytes = buildInit(options);
	const fragmentOffsets: number[] = [];

	options.fragments.forEach((trafs, i) => {
		fragmentOffsets.push(bytes.length);
		bytes.push(...buildFragment(i + 1, trafs, bytes.length));
	});

	if (options.trailingBoxes) {
		bytes.push(...options.trailingBoxes(fragmentOffsets).flat());
	}

	return new Uint8Array(bytes);
};

/** An mfra box with one tfra per track: entries are [time, moofOffset, trunNumber, sampleNumber]. */
export const mfra = (tracks: { trackId: number; entries: [number, number, number, number][] }[]) => {
	const tfras = tracks.map(track => fullBox('tfra', 1, 0,
		u32(track.trackId),
		u32(0), // 1-byte traf, trun and sample numbers
		u32(track.entries.length),
		...track.entries.map(([time, moofOffset, trunNumber, sampleNumber]) => [
			...u64(time),
			...u64(moofOffset),
			1,
			trunNumber,
			sampleNumber,
		]),
	));
	const size = 8 + tfras.reduce((a, b) => a + b.length, 0) + 16;

	return box('mfra', ...tfras, fullBox('mfro', 0, 0, u32(size)));
};
