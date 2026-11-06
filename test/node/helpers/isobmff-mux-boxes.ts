// A small, independent ISOBMFF box parser used to check the muxer's output field by field. It deliberately shares
// no code with Mediabunny's own demuxer.

export type ParsedBox = {
	type: string;
	/** Offset of the box header in the file. */
	start: number;
	/** Offset of the box payload (after the size/type header, before any FullBox version/flags). */
	contentStart: number;
	end: number;
	size: number;
	largeSize: boolean;
	children: ParsedBox[];
};

const CONTAINER_BOXES = new Set([
	'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'mvex', 'moof', 'traf', 'mfra', 'ilst', 'wave',
	'vttc',
]);
const VISUAL_SAMPLE_ENTRIES = new Set([
	'avc1', 'avc3', 'hvc1', 'hev1', 'vp08', 'vp09', 'av01', 'apch', 'apcn', 'apcs', 'apco', 'ap4h', 'ap4x',
]);
const AUDIO_SAMPLE_ENTRIES = new Set([
	'mp4a', 'Opus', 'fLaC', 'ac-3', 'ec-3', 'ipcm', 'fpcm', 'sowt', 'twos', 'in24', 'in32', 'fl32', 'fl64', 'lpcm',
	'raw ', 'ulaw', 'alaw', 'mlpa', 'dtsc', 'dtsh', 'dtsl', 'dtse', 'dtsx',
]);

export const fourCc = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

/** Parses the boxes between `start` and `end`, descending into container boxes and sample descriptions. */
export const parseBoxes = (bytes: Uint8Array, start = 0, end = bytes.byteLength, parentType = ''): ParsedBox[] => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const boxes: ParsedBox[] = [];
	let pos = start;

	while (pos + 8 <= end) {
		let size = view.getUint32(pos);
		const type = fourCc(bytes, pos + 4);
		let headerSize = 8;
		if (size === 1) {
			size = Number(view.getBigUint64(pos + 8));
			headerSize = 16;
		} else if (size === 0) {
			size = end - pos;
		}
		if (size < headerSize || pos + size > end) {
			throw new Error(`Box '${type}' at ${pos} has invalid size ${size} (parent '${parentType}', end ${end}).`);
		}

		const box: ParsedBox = {
			type,
			start: pos,
			contentStart: pos + headerSize,
			end: pos + size,
			size,
			largeSize: headerSize === 16,
			children: [],
		};

		let childStart: number | null = null;
		if (CONTAINER_BOXES.has(type) && !(parentType === 'ilst')) {
			childStart = box.contentStart;
		} else if (parentType === 'ilst') {
			childStart = box.contentStart; // Item boxes hold 'data' boxes
		} else if (type === 'meta') {
			// ISO meta is a FullBox, QuickTime meta is a plain box; tell them apart by looking for the hdlr box
			childStart = fourCc(bytes, box.contentStart + 4) === 'hdlr' ? box.contentStart : box.contentStart + 4;
		} else if (type === 'stsd' || type === 'dref') {
			childStart = box.contentStart + 8;
		} else if (type === 'keys') {
			childStart = box.contentStart + 8;
		} else if (parentType === 'stsd') {
			if (VISUAL_SAMPLE_ENTRIES.has(type)) {
				childStart = box.contentStart + 78;
			} else if (AUDIO_SAMPLE_ENTRIES.has(type)) {
				const version = view.getUint16(box.contentStart + 8);
				childStart = box.contentStart + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
			} else if (type === 'wvtt') {
				childStart = box.contentStart + 8;
			}
		}

		if (childStart !== null) {
			box.children = parseBoxes(bytes, childStart, box.end, type);
		}

		boxes.push(box);
		pos += size;
	}

	if (pos !== end && !(end - pos < 8 && parentType === 'wave')) {
		throw new Error(`Trailing ${end - pos} bytes after the boxes in '${parentType}'.`);
	}

	return boxes;
};

/** Finds all boxes matching a slash-separated path of types, like 'moov/trak/mdia/mdhd'. */
export const findBoxes = (boxes: ParsedBox[], path: string): ParsedBox[] => {
	const [head, ...rest] = path.split('/');
	const matches = boxes.filter(box => box.type === head);
	if (rest.length === 0) {
		return matches;
	}

	return matches.flatMap(box => findBoxes(box.children, rest.join('/')));
};

export const findBox = (boxes: ParsedBox[], path: string) => {
	const matches = findBoxes(boxes, path);
	if (matches.length === 0) {
		throw new Error(`No box at path '${path}'.`);
	}

	return matches[0]!;
};

export const hasBox = (boxes: ParsedBox[], path: string) => findBoxes(boxes, path).length > 0;

/** A cursor for reading big-endian fields from a box payload. */
export class FieldReader {
	pos: number;
	view: DataView;

	constructor(public bytes: Uint8Array, start: number, public end = bytes.byteLength) {
		this.pos = start;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	u8() {
		return this.view.getUint8(this.pos++);
	}

	u16() {
		const value = this.view.getUint16(this.pos);
		this.pos += 2;
		return value;
	}

	i16() {
		const value = this.view.getInt16(this.pos);
		this.pos += 2;
		return value;
	}

	u24() {
		const value = (this.view.getUint8(this.pos) << 16) | this.view.getUint16(this.pos + 1);
		this.pos += 3;
		return value;
	}

	u32() {
		const value = this.view.getUint32(this.pos);
		this.pos += 4;
		return value;
	}

	i32() {
		const value = this.view.getInt32(this.pos);
		this.pos += 4;
		return value;
	}

	u64() {
		const value = Number(this.view.getBigUint64(this.pos));
		this.pos += 8;
		return value;
	}

	i64() {
		const value = Number(this.view.getBigInt64(this.pos));
		this.pos += 8;
		return value;
	}

	f64() {
		const value = this.view.getFloat64(this.pos);
		this.pos += 8;
		return value;
	}

	fourCc() {
		const value = fourCc(this.bytes, this.pos);
		this.pos += 4;
		return value;
	}

	bytesUntil(end = this.end) {
		const value = this.bytes.slice(this.pos, end);
		this.pos = end;
		return value;
	}

	skip(n: number) {
		this.pos += n;
	}

	remaining() {
		return this.end - this.pos;
	}
}

export const fieldReader = (bytes: Uint8Array, box: ParsedBox) => new FieldReader(bytes, box.contentStart, box.end);

/** Reads the version and flags of a FullBox and returns a reader positioned after them. */
export const fullBoxReader = (bytes: Uint8Array, box: ParsedBox) => {
	const reader = fieldReader(bytes, box);
	const version = reader.u8();
	const flags = reader.u24();
	return { reader, version, flags };
};

export const readMvhd = (bytes: Uint8Array, box: ParsedBox) => {
	const { reader, version } = fullBoxReader(bytes, box);
	const creationTime = version === 1 ? reader.u64() : reader.u32();
	const modificationTime = version === 1 ? reader.u64() : reader.u32();
	const timescale = reader.u32();
	const duration = version === 1 ? reader.u64() : reader.u32();
	const rate = reader.u32() / 0x10000;
	const volume = reader.u16() / 0x100;
	reader.skip(10);
	const matrix = Array.from({ length: 9 }, () => reader.i32());
	reader.skip(24);
	const nextTrackId = reader.u32();
	return { version, creationTime, modificationTime, timescale, duration, rate, volume, matrix, nextTrackId };
};

export const readTkhd = (bytes: Uint8Array, box: ParsedBox) => {
	const { reader, version, flags } = fullBoxReader(bytes, box);
	const creationTime = version === 1 ? reader.u64() : reader.u32();
	const modificationTime = version === 1 ? reader.u64() : reader.u32();
	const trackId = reader.u32();
	reader.skip(4);
	const duration = version === 1 ? reader.u64() : reader.u32();
	reader.skip(8);
	const layer = reader.i16();
	const alternateGroup = reader.i16();
	const volume = reader.i16() / 0x100;
	reader.skip(2);
	const matrix = Array.from({ length: 9 }, () => reader.i32());
	const width = reader.u32() / 0x10000;
	const height = reader.u32() / 0x10000;
	return {
		version, flags, creationTime, modificationTime, trackId, duration, layer, alternateGroup, volume, matrix,
		width, height,
	};
};

export const readMdhd = (bytes: Uint8Array, box: ParsedBox) => {
	const { reader, version } = fullBoxReader(bytes, box);
	const creationTime = version === 1 ? reader.u64() : reader.u32();
	const modificationTime = version === 1 ? reader.u64() : reader.u32();
	const timescale = reader.u32();
	const duration = version === 1 ? reader.u64() : reader.u32();
	const packedLanguage = reader.u16();
	const language = String.fromCharCode(
		((packedLanguage >> 10) & 0x1f) + 0x60,
		((packedLanguage >> 5) & 0x1f) + 0x60,
		(packedLanguage & 0x1f) + 0x60,
	);
	return { version, creationTime, modificationTime, timescale, duration, packedLanguage, language };
};

export const readHdlr = (bytes: Uint8Array, box: ParsedBox) => {
	const { reader } = fullBoxReader(bytes, box);
	const componentType = reader.fourCc();
	const handlerType = reader.fourCc();
	const manufacturer = reader.fourCc();
	reader.skip(8);
	const nameBytes = reader.bytesUntil();
	return { componentType, handlerType, manufacturer, nameBytes };
};

export const readElst = (bytes: Uint8Array, box: ParsedBox) => {
	const { reader, version } = fullBoxReader(bytes, box);
	const count = reader.u32();
	return {
		version,
		entries: Array.from({ length: count }, () => ({
			segmentDuration: version === 1 ? reader.u64() : reader.u32(),
			mediaTime: version === 1 ? reader.i64() : reader.i32(),
			mediaRate: reader.i32() / 0x10000,
		})),
	};
};

/** Reads a box of 32-bit entry counts followed by fixed-layout entries (stts, ctts, stsc, stss, stco, co64). */
export const readTable = <T>(
	bytes: Uint8Array,
	box: ParsedBox,
	readEntry: (reader: FieldReader, version: number) => T,
) => {
	const { reader, version, flags } = fullBoxReader(bytes, box);
	const count = reader.u32();
	const entries = Array.from({ length: count }, () => readEntry(reader, version));
	if (reader.remaining() !== 0) {
		throw new Error(`'${box.type}' has ${reader.remaining()} trailing bytes.`);
	}
	return { version, flags, entries };
};

export const readStts = (bytes: Uint8Array, box: ParsedBox) => readTable(bytes, box, r => ({
	count: r.u32(),
	delta: r.u32(),
}));

export const readCtts = (bytes: Uint8Array, box: ParsedBox) => readTable(bytes, box, (r, version) => ({
	count: r.u32(),
	offset: version === 1 ? r.i32() : r.u32(),
}));

export const readStsc = (bytes: Uint8Array, box: ParsedBox) => readTable(bytes, box, r => ({
	firstChunk: r.u32(),
	samplesPerChunk: r.u32(),
	sampleDescriptionIndex: r.u32(),
}));

export const readStss = (bytes: Uint8Array, box: ParsedBox) => readTable(bytes, box, r => r.u32());

export const readChunkOffsets = (bytes: Uint8Array, box: ParsedBox) => readTable(
	bytes,
	box,
	r => (box.type === 'co64' ? r.u64() : r.u32()),
);

export const readStsz = (bytes: Uint8Array, box: ParsedBox) => {
	const { reader } = fullBoxReader(bytes, box);
	const sampleSize = reader.u32();
	const sampleCount = reader.u32();
	const sizes = sampleSize === 0
		? Array.from({ length: sampleCount }, () => reader.u32())
		: Array.from({ length: sampleCount }, () => sampleSize);
	return { sampleSize, sampleCount, sizes };
};

export const readCslg = (bytes: Uint8Array, box: ParsedBox) => {
	const { reader, version } = fullBoxReader(bytes, box);
	const read = () => (version === 1 ? reader.i64() : reader.i32());
	return {
		version,
		compositionToDtsShift: read(),
		leastDecodeToDisplayDelta: read(),
		greatestDecodeToDisplayDelta: read(),
		compositionStartTime: read(),
		compositionEndTime: read(),
	};
};

export const readSgpdRoll = (bytes: Uint8Array, box: ParsedBox) => {
	const { reader, version } = fullBoxReader(bytes, box);
	const groupingType = reader.fourCc();
	const defaultLength = version === 1 ? reader.u32() : null;
	const count = reader.u32();
	const entries = Array.from({ length: count }, () => {
		if (version === 1 && defaultLength === 0) {
			reader.u32(); // description_length
		}
		return reader.i16();
	});
	return { version, groupingType, defaultLength, entries };
};

export const readSbgp = (bytes: Uint8Array, box: ParsedBox) => {
	const { reader, version } = fullBoxReader(bytes, box);
	const groupingType = reader.fourCc();
	if (version === 1) {
		reader.u32(); // grouping_type_parameter
	}
	const count = reader.u32();
	const entries = Array.from({ length: count }, () => ({
		sampleCount: reader.u32(),
		groupDescriptionIndex: reader.u32(),
	}));
	return { version, groupingType, entries };
};

/** Reads the fields shared by all sample entries of the given kind, with a reader positioned after them. */
export const readVisualSampleEntry = (bytes: Uint8Array, box: ParsedBox) => {
	const reader = fieldReader(bytes, box);
	reader.skip(6);
	const dataReferenceIndex = reader.u16();
	reader.skip(16);
	const width = reader.u16();
	const height = reader.u16();
	const horizResolution = reader.u32() / 0x10000;
	const vertResolution = reader.u32() / 0x10000;
	reader.skip(4);
	const frameCount = reader.u16();
	const compressorNameLength = reader.u8();
	const compressorName = String.fromCharCode(...bytes.subarray(reader.pos, reader.pos + compressorNameLength));
	reader.skip(31);
	const depth = reader.u16();
	const preDefined = reader.i16();
	return {
		dataReferenceIndex, width, height, horizResolution, vertResolution, frameCount, compressorName, depth,
		preDefined,
	};
};

export const readAudioSampleEntry = (bytes: Uint8Array, box: ParsedBox) => {
	const reader = fieldReader(bytes, box);
	reader.skip(6);
	const dataReferenceIndex = reader.u16();
	const version = reader.u16();
	const revision = reader.u16();
	const vendor = reader.u32();
	const channelCount = reader.u16();
	const sampleSize = reader.u16();
	const compressionId = reader.i16();
	const packetSize = reader.u16();
	const sampleRate = reader.u32() / 0x10000;
	let v1: { samplesPerPacket: number; bytesPerPacket: number; bytesPerFrame: number; bytesPerSample: number } | null
		= null;
	if (version === 1) {
		v1 = {
			samplesPerPacket: reader.u32(),
			bytesPerPacket: reader.u32(),
			bytesPerFrame: reader.u32(),
			bytesPerSample: reader.u32(),
		};
	}
	return {
		dataReferenceIndex, version, revision, vendor, channelCount, sampleSize, compressionId, packetSize, sampleRate,
		v1,
	};
};

export const readTfhd = (bytes: Uint8Array, box: ParsedBox) => {
	const { reader, flags } = fullBoxReader(bytes, box);
	const trackId = reader.u32();
	return {
		flags,
		trackId,
		baseDataOffset: flags & 0x01 ? reader.u64() : null,
		sampleDescriptionIndex: flags & 0x02 ? reader.u32() : null,
		defaultSampleDuration: flags & 0x08 ? reader.u32() : null,
		defaultSampleSize: flags & 0x10 ? reader.u32() : null,
		defaultSampleFlags: flags & 0x20 ? reader.u32() : null,
		durationIsEmpty: !!(flags & 0x10000),
		defaultBaseIsMoof: !!(flags & 0x20000),
	};
};

export const readTfdt = (bytes: Uint8Array, box: ParsedBox) => {
	const { reader, version } = fullBoxReader(bytes, box);
	return { version, baseMediaDecodeTime: version === 1 ? reader.u64() : reader.u32() };
};

export const readTrun = (bytes: Uint8Array, box: ParsedBox) => {
	const { reader, version, flags } = fullBoxReader(bytes, box);
	const sampleCount = reader.u32();
	const dataOffset = flags & 0x1 ? reader.i32() : null;
	const firstSampleFlags = flags & 0x4 ? reader.u32() : null;
	const samples = Array.from({ length: sampleCount }, () => ({
		duration: flags & 0x100 ? reader.u32() : null,
		size: flags & 0x200 ? reader.u32() : null,
		flags: flags & 0x400 ? reader.u32() : null,
		compositionTimeOffset: flags & 0x800 ? (version === 1 ? reader.i32() : reader.u32()) : null,
	}));
	if (reader.remaining() !== 0) {
		throw new Error(`'trun' has ${reader.remaining()} trailing bytes.`);
	}
	return { version, flags, sampleCount, dataOffset, firstSampleFlags, samples };
};

/** Expands stts/ctts/stsz/stsc/stco of a non-fragmented track into per-sample information. */
export const readSampleTable = (bytes: Uint8Array, trak: ParsedBox) => {
	const stbl = findBox(trak.children, 'mdia/minf/stbl');
	const stts = readStts(bytes, findBox(stbl.children, 'stts'));
	const cttsBoxes = findBoxes(stbl.children, 'ctts');
	const ctts = cttsBoxes.length > 0 ? readCtts(bytes, cttsBoxes[0]!) : null;
	const stsz = readStsz(bytes, findBox(stbl.children, 'stsz'));
	const stsc = readStsc(bytes, findBox(stbl.children, 'stsc'));
	const offsetsBox = findBoxes(stbl.children, 'stco')[0] ?? findBox(stbl.children, 'co64');
	const chunkOffsets = readChunkOffsets(bytes, offsetsBox).entries;
	const stssBoxes = findBoxes(stbl.children, 'stss');
	const syncSamples = stssBoxes.length > 0 ? new Set(readStss(bytes, stssBoxes[0]!).entries) : null;

	const samples: { dts: number; duration: number; cts: number; size: number; offset: number; sync: boolean }[] = [];
	let dts = 0;
	for (const entry of stts.entries) {
		for (let i = 0; i < entry.count; i++) {
			samples.push({ dts, duration: entry.delta, cts: dts, size: 0, offset: 0, sync: true });
			dts += entry.delta;
		}
	}
	if (ctts) {
		let index = 0;
		for (const entry of ctts.entries) {
			for (let i = 0; i < entry.count; i++) {
				samples[index]!.cts = samples[index]!.dts + entry.offset;
				index++;
			}
		}
		if (index !== samples.length) {
			throw new Error(`ctts covers ${index} samples, stts ${samples.length}.`);
		}
	}
	if (stsz.sampleCount !== samples.length) {
		throw new Error(`stsz has ${stsz.sampleCount} samples, stts ${samples.length}.`);
	}
	stsz.sizes.forEach((size, i) => samples[i]!.size = size);
	samples.forEach((sample, i) => sample.sync = syncSamples === null || syncSamples.has(i + 1));

	let sampleIndex = 0;
	for (let chunk = 0; chunk < chunkOffsets.length; chunk++) {
		const samplesPerChunk = stsc.entries.filter(entry => entry.firstChunk <= chunk + 1).at(-1)!.samplesPerChunk;
		let offset = chunkOffsets[chunk]!;
		for (let i = 0; i < samplesPerChunk; i++) {
			const sample = samples[sampleIndex++];
			if (!sample) {
				throw new Error('stsc describes more samples than stts.');
			}
			sample.offset = offset;
			offset += sample.size;
		}
	}
	if (sampleIndex !== samples.length) {
		throw new Error(`stsc/stco place ${sampleIndex} of ${samples.length} samples.`);
	}

	return { samples, stts, ctts, stsz, stsc, chunkOffsets, chunkOffsetBoxType: offsetsBox.type };
};
