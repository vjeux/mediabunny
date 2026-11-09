// Byte builders for FLAC and Ogg conformance tests: FLAC frames with constant/verbatim subframes, STREAMINFO and
// metadata blocks per RFC 9639, and Ogg pages per RFC 3533 with Opus helpers per RFC 7845 / RFC 6716.

export const concatBytes = (parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

class BitWriter {
	bytes: number[] = [];
	private current = 0;
	private bitCount = 0;

	write(bits: number, value: number) {
		for (let i = bits - 1; i >= 0; i--) {
			const bit = Math.floor(value / 2 ** i) & 1;
			this.current = (this.current << 1) | bit;
			this.bitCount++;
			if (this.bitCount === 8) {
				this.bytes.push(this.current);
				this.current = 0;
				this.bitCount = 0;
			}
		}
	}

	writeSigned(bits: number, value: number) {
		this.write(bits, value < 0 ? value + 2 ** bits : value);
	}

	alignToByte() {
		while (this.bitCount !== 0) {
			this.write(1, 0);
		}
	}
}

// ===== FLAC =====

// RFC 9639 section 9.1.8
export const flacCrc8 = (data: Uint8Array) => {
	let crc = 0;
	for (const byte of data) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) {
			crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
		}
	}
	return crc;
};

// RFC 9639 section 9.3
export const flacCrc16 = (data: Uint8Array) => {
	let crc = 0;
	for (const byte of data) {
		crc ^= byte << 8;
		for (let i = 0; i < 8; i++) {
			crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
		}
	}
	return crc;
};

// RFC 9639 section 9.1.5, Table 18
export const encodeFlacCodedNumber = (value: number) => {
	if (value < 0x80) {
		return [value];
	}

	let length = 2;
	while (value >= 2 ** (5 * length + 1)) {
		length++;
	}

	const bytes: number[] = [];
	let rest = value;
	for (let i = 1; i < length; i++) {
		bytes.unshift(0x80 | (rest % 64));
		rest = Math.floor(rest / 64);
	}
	bytes.unshift(((0xff << (8 - length)) & 0xff) | rest);
	return bytes;
};

const FLAC_SAMPLE_RATE_CODES: Record<number, number> = {
	88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11,
};

/** Picks the sample rate code like libFLAC does. */
export const chooseFlacSampleRateCode = (sampleRate: number) => {
	if (FLAC_SAMPLE_RATE_CODES[sampleRate] !== undefined) {
		return FLAC_SAMPLE_RATE_CODES[sampleRate];
	} else if (sampleRate % 1000 === 0 && sampleRate <= 255000) {
		return 0b1100;
	} else if (sampleRate % 10 === 0 && sampleRate <= 655350) {
		return 0b1110;
	} else if (sampleRate <= 65535) {
		return 0b1101;
	}
	return 0;
};

/** Picks the block size code like libFLAC does. */
export const chooseFlacBlockSizeCode = (blockSize: number) => {
	if (blockSize === 192) {
		return 1;
	}
	for (let code = 2; code <= 5; code++) {
		if (blockSize === 144 * 2 ** code) {
			return code;
		}
	}
	for (let code = 8; code <= 15; code++) {
		if (blockSize === 2 ** code) {
			return code;
		}
	}
	return blockSize <= 256 ? 0b0110 : 0b0111;
};

const FLAC_BIT_DEPTH_CODES: Record<number, number> = { 8: 1, 12: 2, 16: 4, 20: 5, 24: 6, 32: 7 };

export type FlacFrameOptions = {
	blockSize: number;
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	/** Frame number (fixed block size) or sample number (variable block size). */
	number: number;
	variableBlockSize?: boolean;
	/** 0-7: independent channels (must equal channels - 1), 8: left/side, 9: right/side, 10: mid/side. */
	channelAssignment?: number;
	blockSizeCode?: number;
	sampleRateCode?: number;
	bitDepthCode?: number;
	/** The values stored in each subframe (already decorrelated); constant subframes are used when omitted. */
	subframeSamples?: (channel: number, index: number) => number;
};

/** Builds a valid FLAC frame using constant or verbatim subframes (RFC 9639 section 9). */
export const buildFlacFrame = (options: FlacFrameOptions) => {
	const channelAssignment = options.channelAssignment ?? options.channels - 1;
	const blockSizeCode = options.blockSizeCode ?? chooseFlacBlockSizeCode(options.blockSize);
	const sampleRateCode = options.sampleRateCode ?? chooseFlacSampleRateCode(options.sampleRate);
	const bitDepthCode = options.bitDepthCode ?? FLAC_BIT_DEPTH_CODES[options.bitsPerSample] ?? 0;

	const header = new BitWriter();
	header.write(15, 0b111111111111100);
	header.write(1, options.variableBlockSize ? 1 : 0);
	header.write(4, blockSizeCode);
	header.write(4, sampleRateCode);
	header.write(4, channelAssignment);
	header.write(3, bitDepthCode);
	header.write(1, 0);
	for (const byte of encodeFlacCodedNumber(options.number)) {
		header.write(8, byte);
	}
	if (blockSizeCode === 0b0110) {
		header.write(8, options.blockSize - 1);
	} else if (blockSizeCode === 0b0111) {
		header.write(16, options.blockSize - 1);
	}
	if (sampleRateCode === 0b1100) {
		header.write(8, options.sampleRate / 1000);
	} else if (sampleRateCode === 0b1101) {
		header.write(16, options.sampleRate);
	} else if (sampleRateCode === 0b1110) {
		header.write(16, options.sampleRate / 10);
	}
	header.write(8, flacCrc8(new Uint8Array(header.bytes)));

	const body = new BitWriter();
	for (const byte of header.bytes) {
		body.write(8, byte);
	}
	for (let channel = 0; channel < options.channels; channel++) {
		// The side channel has one extra bit (RFC 9639 section 9.2)
		const isSide = (channelAssignment === 8 && channel === 1)
			|| (channelAssignment === 9 && channel === 0)
			|| (channelAssignment === 10 && channel === 1);
		const bits = options.bitsPerSample + (isSide ? 1 : 0);

		if (options.subframeSamples) {
			body.write(8, 0b00000010); // Verbatim subframe, no wasted bits
			for (let i = 0; i < options.blockSize; i++) {
				body.writeSigned(bits, options.subframeSamples(channel, i));
			}
		} else {
			body.write(8, 0b00000000); // Constant subframe
			body.writeSigned(bits, 0);
		}
	}
	body.alignToByte();
	const crc = flacCrc16(new Uint8Array(body.bytes));
	body.write(16, crc);

	return new Uint8Array(body.bytes);
};

export type StreamInfoOptions = {
	minimumBlockSize: number;
	maximumBlockSize: number;
	minimumFrameSize?: number;
	maximumFrameSize?: number;
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	totalSamples: number;
	md5?: Uint8Array;
};

/** Builds the 34-byte STREAMINFO block body (RFC 9639 section 8.2). */
export const buildStreamInfo = (options: StreamInfoOptions) => {
	const writer = new BitWriter();
	writer.write(16, options.minimumBlockSize);
	writer.write(16, options.maximumBlockSize);
	writer.write(24, options.minimumFrameSize ?? 0);
	writer.write(24, options.maximumFrameSize ?? 0);
	writer.write(20, options.sampleRate);
	writer.write(3, options.channels - 1);
	writer.write(5, options.bitsPerSample - 1);
	writer.write(36, options.totalSamples);
	for (let i = 0; i < 16; i++) {
		writer.write(8, options.md5?.[i] ?? 0);
	}
	return new Uint8Array(writer.bytes);
};

export const FLAC_BLOCK_TYPE = {
	STREAMINFO: 0,
	PADDING: 1,
	APPLICATION: 2,
	SEEKTABLE: 3,
	VORBIS_COMMENT: 4,
	CUESHEET: 5,
	PICTURE: 6,
} as const;

export const buildFlacMetadataBlock = (type: number, data: Uint8Array, isLast: boolean) => {
	const block = new Uint8Array(4 + data.length);
	block[0] = (isLast ? 0x80 : 0) | type;
	block[1] = (data.length >> 16) & 0xff;
	block[2] = (data.length >> 8) & 0xff;
	block[3] = data.length & 0xff;
	block.set(data, 4);
	return block;
};

/** Builds a Vorbis comment structure (vendor + comments), without any framing bit. */
export const buildVorbisCommentBody = (vendor: string, comments: string[]) => {
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	const u32 = (value: number) => {
		const bytes = new Uint8Array(4);
		new DataView(bytes.buffer).setUint32(0, value, true);
		return bytes;
	};
	const vendorBytes = encoder.encode(vendor);
	parts.push(u32(vendorBytes.length), vendorBytes, u32(comments.length));
	for (const comment of comments) {
		const commentBytes = encoder.encode(comment);
		parts.push(u32(commentBytes.length), commentBytes);
	}
	return concatBytes(parts);
};

export type FlacPictureOptions = {
	type: number;
	mimeType: string;
	description: string;
	width?: number;
	height?: number;
	data: Uint8Array;
};

/** Builds a PICTURE block body (RFC 9639 section 8.8). */
export const buildFlacPicture = (options: FlacPictureOptions) => {
	const encoder = new TextEncoder();
	const mime = encoder.encode(options.mimeType);
	const description = encoder.encode(options.description);
	const out = new Uint8Array(32 + mime.length + description.length + options.data.length);
	const view = new DataView(out.buffer);
	let pos = 0;
	view.setUint32(pos, options.type);
	pos += 4;
	view.setUint32(pos, mime.length);
	pos += 4;
	out.set(mime, pos);
	pos += mime.length;
	view.setUint32(pos, description.length);
	pos += 4;
	out.set(description, pos);
	pos += description.length;
	view.setUint32(pos, options.width ?? 0);
	view.setUint32(pos + 4, options.height ?? 0);
	view.setUint32(pos + 8, 24);
	view.setUint32(pos + 12, 0);
	pos += 16;
	view.setUint32(pos, options.data.length);
	pos += 4;
	out.set(options.data, pos);
	return out;
};

export type SimpleFlacOptions = {
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	blockSizes: number[];
	variableBlockSize?: boolean;
	channelAssignment?: number;
	subframeSamples?: (channel: number, index: number, frameIndex: number) => number;
	extraBlocks?: { type: number; data: Uint8Array }[];
	streamInfo?: Partial<StreamInfoOptions>;
	firstNumber?: number;
	frameOptions?: Partial<FlacFrameOptions>;
};

/** Builds a complete FLAC file: 'fLaC', STREAMINFO, optional blocks, then the frames. */
export const buildFlacFile = (options: SimpleFlacOptions) => {
	const frames: Uint8Array[] = [];
	let sampleNumber = 0;
	for (let i = 0; i < options.blockSizes.length; i++) {
		const blockSize = options.blockSizes[i]!;
		frames.push(buildFlacFrame({
			blockSize,
			sampleRate: options.sampleRate,
			channels: options.channels,
			bitsPerSample: options.bitsPerSample,
			variableBlockSize: options.variableBlockSize,
			number: (options.firstNumber ?? 0) + (options.variableBlockSize ? sampleNumber : i),
			channelAssignment: options.channelAssignment,
			subframeSamples: options.subframeSamples
				? (channel, index) => options.subframeSamples!(channel, index, i)
				: undefined,
			...options.frameOptions,
		}));
		sampleNumber += blockSize;
	}

	const blocks = options.blockSizes;
	const streamInfo = buildStreamInfo({
		minimumBlockSize: blocks.length > 1 ? Math.min(...blocks.slice(0, -1)) : blocks[0] ?? 4096,
		maximumBlockSize: blocks.length > 0 ? Math.max(...blocks) : 4096,
		minimumFrameSize: frames.length > 0 ? Math.min(...frames.map(x => x.length)) : 0,
		maximumFrameSize: frames.length > 0 ? Math.max(...frames.map(x => x.length)) : 0,
		sampleRate: options.sampleRate,
		channels: options.channels,
		bitsPerSample: options.bitsPerSample,
		totalSamples: sampleNumber,
		...options.streamInfo,
	});

	const extraBlocks = options.extraBlocks ?? [];
	const metadata = [
		buildFlacMetadataBlock(FLAC_BLOCK_TYPE.STREAMINFO, streamInfo, extraBlocks.length === 0),
		...extraBlocks.map((block, i) => buildFlacMetadataBlock(block.type, block.data, i === extraBlocks.length - 1)),
	];

	return {
		bytes: concatBytes([new Uint8Array([0x66, 0x4c, 0x61, 0x43]), ...metadata, ...frames]),
		frames,
		streamInfo,
	};
};

// ===== Ogg =====

const OGG_CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let crc = n << 24;
		for (let k = 0; k < 8; k++) {
			crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
		}
		table[n] = crc >>> 0;
	}
	return table;
})();

/** CRC-32 with polynomial 0x04c11db7, no reflection, initial value 0 (RFC 3533 section 6). */
export const oggCrc32 = (bytes: Uint8Array) => {
	let crc = 0;
	for (const byte of bytes) {
		crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
	}
	return crc;
};

export type OggPageOptions = {
	headerType: number;
	granulePosition: bigint;
	serialNumber: number;
	sequenceNumber: number;
	lacingValues: number[];
	data: Uint8Array;
};

export const buildOggPage = (options: OggPageOptions) => {
	const page = new Uint8Array(27 + options.lacingValues.length + options.data.length);
	const view = new DataView(page.buffer);
	view.setUint32(0, 0x4f676753, false); // 'OggS'
	page[4] = 0;
	page[5] = options.headerType;
	view.setBigInt64(6, options.granulePosition, true);
	view.setUint32(14, options.serialNumber, true);
	view.setUint32(18, options.sequenceNumber, true);
	page[26] = options.lacingValues.length;
	page.set(options.lacingValues, 27);
	page.set(options.data, 27 + options.lacingValues.length);
	view.setUint32(22, oggCrc32(page), true);
	return page;
};

export const oggLacingFor = (length: number) => {
	const values: number[] = [];
	while (length >= 255) {
		values.push(255);
		length -= 255;
	}
	values.push(length);
	return values;
};

export type OggPageSpec = {
	/** Packets (or packet pieces) on this page; a piece continues onto the next page if `continues` is set. */
	packets: Uint8Array[];
	granulePosition: bigint;
	headerType?: number;
	/** The last packet doesn't end on this page; its lacing values all stay 255, so its length must be a multiple of
	 * 255. */
	lastPacketContinues?: boolean;
};

/** Builds the pages of one logical bitstream from page specs. */
export const buildOggStream = (serialNumber: number, pages: OggPageSpec[], firstSequenceNumber = 0) => {
	return pages.map((page, i) => {
		const lacingValues: number[] = [];
		page.packets.forEach((packet, j) => {
			if (page.lastPacketContinues && j === page.packets.length - 1) {
				if (packet.length % 255 !== 0) {
					throw new Error('Continuing piece length must be a multiple of 255.');
				}
				lacingValues.push(...Array<number>(packet.length / 255).fill(255));
			} else {
				lacingValues.push(...oggLacingFor(packet.length));
			}
		});
		return buildOggPage({
			headerType: page.headerType ?? 0,
			granulePosition: page.granulePosition,
			serialNumber,
			sequenceNumber: firstSequenceNumber + i,
			lacingValues,
			data: concatBytes(page.packets),
		});
	});
};

export type ParsedOggPage = {
	offset: number;
	headerType: number;
	granulePosition: bigint;
	serialNumber: number;
	sequenceNumber: number;
	checksum: number;
	lacingValues: number[];
	data: Uint8Array;
};

export const parseOggPages = (bytes: Uint8Array) => {
	const pages: ParsedOggPage[] = [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = 0;
	while (pos + 27 <= bytes.length) {
		if (view.getUint32(pos, false) !== 0x4f676753) {
			throw new Error(`No capture pattern at ${pos}.`);
		}
		const segmentCount = bytes[pos + 26]!;
		const lacingValues = [...bytes.subarray(pos + 27, pos + 27 + segmentCount)];
		const dataSize = lacingValues.reduce((a, b) => a + b, 0);
		pages.push({
			offset: pos,
			headerType: bytes[pos + 5]!,
			granulePosition: view.getBigInt64(pos + 6, true),
			serialNumber: view.getUint32(pos + 14, true),
			sequenceNumber: view.getUint32(pos + 18, true),
			checksum: view.getUint32(pos + 22, true),
			lacingValues,
			data: bytes.subarray(pos + 27 + segmentCount, pos + 27 + segmentCount + dataSize),
		});
		pos += 27 + segmentCount + dataSize;
	}
	return pages;
};

export type ParsedOggPacket = { data: Uint8Array; pageIndex: number };

/** Reassembles the packets of one logical bitstream; `pageIndex` is the index of the page the packet ends on. */
export const parseOggPackets = (pages: ParsedOggPage[], serialNumber: number) => {
	const packets: ParsedOggPacket[] = [];
	let pieces: Uint8Array[] = [];
	pages.forEach((page, pageIndex) => {
		if (page.serialNumber !== serialNumber) {
			return;
		}
		let offset = 0;
		for (const lacingValue of page.lacingValues) {
			pieces.push(page.data.subarray(offset, offset + lacingValue));
			offset += lacingValue;
			if (lacingValue < 255) {
				packets.push({ data: concatBytes(pieces), pageIndex });
				pieces = [];
			}
		}
	});
	return packets;
};

export type OpusHeadOptions = {
	channels: number;
	preSkip: number;
	inputSampleRate?: number;
	outputGain?: number;
	mappingFamily?: number;
	streamCount?: number;
	coupledCount?: number;
	mapping?: number[];
};

/** Builds an OpusHead identification header (RFC 7845 section 5.1). */
export const buildOpusHead = (options: OpusHeadOptions) => {
	const family = options.mappingFamily ?? 0;
	const head = new Uint8Array(family === 0 ? 19 : 21 + options.channels);
	const view = new DataView(head.buffer);
	head.set(new TextEncoder().encode('OpusHead'), 0);
	head[8] = 1;
	head[9] = options.channels;
	view.setUint16(10, options.preSkip, true);
	view.setUint32(12, options.inputSampleRate ?? 48000, true);
	view.setInt16(16, options.outputGain ?? 0, true);
	head[18] = family;
	if (family !== 0) {
		head[19] = options.streamCount ?? options.channels;
		head[20] = options.coupledCount ?? 0;
		head.set(options.mapping ?? Array.from({ length: options.channels }, (_, i) => i), 21);
	}
	return head;
};

/** Builds an OpusTags comment header (RFC 7845 section 5.2). */
export const buildOpusTags = (vendor: string, comments: string[]) => {
	return concatBytes([new TextEncoder().encode('OpusTags'), buildVorbisCommentBody(vendor, comments)]);
};

/**
 * Builds an Opus packet (RFC 6716 section 3.1) with the given TOC configuration and frame count code. Frames are
 * empty (zero-byte frames signal packet loss concealment), which keeps the packets tiny but valid.
 */
export const buildOpusPacket = (config: number, code: 0 | 1 | 2 | 3, frameCount = 1, padding = 0) => {
	const toc = (config << 3) | code;
	if (code === 0) {
		return new Uint8Array([toc, ...Array<number>(padding).fill(0)]);
	} else if (code === 1) {
		return new Uint8Array([toc]);
	} else if (code === 2) {
		return new Uint8Array([toc, 0]); // First frame has length 0
	}
	return new Uint8Array([toc, frameCount & 0x3f]); // CBR, no padding
};

/** Opus frame durations per TOC configuration (RFC 6716 section 3.1, Table 2), in 48 kHz samples. */
export const OPUS_CONFIG_FRAME_SAMPLES = [
	480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 480, 960,
	120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960,
];
