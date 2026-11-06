/** Reads big-endian bit fields. */
export class BitReader {
	pos = 0;

	constructor(public bytes: Uint8Array) {}

	read(bits: number) {
		let value = 0;
		for (let i = 0; i < bits; i++) {
			const byte = this.bytes[this.pos >> 3]!;
			value = value * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
			this.pos++;
		}

		return value;
	}
}

// ETSI TS 102 366, Table 4.13 (bit rates of frmsizecod / 2)
const AC3_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];
const AC3_SAMPLE_RATES = [48000, 44100, 32000];
// Channels per acmod, without the LFE (Table 4.3)
export const AC3_ACMOD_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];

export type Ac3FrameInfo = {
	sampleRate: number;
	bitrate: number;
	frameBytes: number;
	bsid: number;
	acmod: number;
	lfeon: number;
	channels: number;
};

/** Parses an AC-3 syncframe's syncinfo and the start of its BSI. */
export const parseAc3Frame = (frame: Uint8Array): Ac3FrameInfo => {
	const reader = new BitReader(frame);
	if (reader.read(16) !== 0x0b77) {
		throw new Error('No AC-3 syncword.');
	}
	reader.read(16); // crc1
	const fscod = reader.read(2);
	const frmsizecod = reader.read(6);
	const bsid = reader.read(5);
	reader.read(3); // bsmod
	const acmod = reader.read(3);
	if ((acmod & 1) && acmod !== 1) {
		reader.read(2); // cmixlev
	}
	if (acmod & 4) {
		reader.read(2); // surmixlev
	}
	if (acmod === 2) {
		reader.read(2); // dsurmod
	}
	const lfeon = reader.read(1);

	const sampleRate = AC3_SAMPLE_RATES[fscod]!;
	const bitrate = AC3_BITRATES[frmsizecod >> 1]! * 1000;
	// A syncframe is 1536 samples, the 44.1 kHz sizes alternate to average out
	const words = sampleRate === 44100
		? Math.floor(bitrate * 1536 / 44100 / 16) + (frmsizecod & 1)
		: bitrate * 1536 / sampleRate / 16;

	return {
		sampleRate,
		bitrate,
		frameBytes: words * 2,
		bsid,
		acmod,
		lfeon,
		channels: AC3_ACMOD_CHANNELS[acmod]! + lfeon,
	};
};

export type Eac3FrameInfo = {
	strmtyp: number;
	substreamid: number;
	frameBytes: number;
	sampleRate: number;
	blocks: number;
	acmod: number;
	lfeon: number;
	bsid: number;
	channels: number;
};

/** Parses the start of an E-AC-3 syncframe's BSI (ETSI TS 102 366, E.1.2.2). */
export const parseEac3Frame = (frame: Uint8Array): Eac3FrameInfo => {
	const reader = new BitReader(frame);
	if (reader.read(16) !== 0x0b77) {
		throw new Error('No E-AC-3 syncword.');
	}
	const strmtyp = reader.read(2);
	const substreamid = reader.read(3);
	const frmsiz = reader.read(11);
	const fscod = reader.read(2);
	let sampleRate: number;
	let blocks: number;
	if (fscod === 3) {
		sampleRate = AC3_SAMPLE_RATES[reader.read(2)]! / 2;
		blocks = 6;
	} else {
		sampleRate = AC3_SAMPLE_RATES[fscod]!;
		blocks = [1, 2, 3, 6][reader.read(2)]!;
	}
	const acmod = reader.read(3);
	const lfeon = reader.read(1);
	const bsid = reader.read(5);

	return {
		strmtyp,
		substreamid,
		frameBytes: (frmsiz + 1) * 2,
		sampleRate,
		blocks,
		acmod,
		lfeon,
		bsid,
		channels: AC3_ACMOD_CHANNELS[acmod]! + lfeon,
	};
};

// ETSI TS 102 114, Tables 5-5 and 5-7
const DTS_SAMPLE_RATES = [0, 8000, 16000, 32000, 0, 0, 11025, 22050, 44100, 0, 0, 12000, 24000, 48000, 0, 0];
const DTS_AMODE_CHANNELS = [1, 2, 2, 2, 2, 3, 3, 4, 4, 5, 6, 6, 6, 7, 8, 8];

export type DtsFrameInfo = {
	samples: number;
	frameBytes: number;
	amode: number;
	sampleRate: number;
	lfe: boolean;
	channels: number;
};

/** Parses a DTS core frame header (16-bit big-endian stream). */
export const parseDtsFrame = (frame: Uint8Array): DtsFrameInfo => {
	const reader = new BitReader(frame);
	if (reader.read(32) !== 0x7ffe8001) {
		throw new Error('No DTS core syncword.');
	}
	reader.read(1); // FTYPE
	reader.read(5); // SHORT
	reader.read(1); // CPF
	const nblks = reader.read(7);
	const fsize = reader.read(14);
	const amode = reader.read(6);
	const sfreq = reader.read(4);
	reader.read(5); // RATE
	reader.read(1); // FIXEDBIT
	reader.read(1); // DYNF
	reader.read(1); // TIMEF
	reader.read(1); // AUXF
	reader.read(1); // HDCD
	reader.read(3); // EXT_AUDIO_ID
	reader.read(1); // EXT_AUDIO
	reader.read(1); // ASPF
	const lff = reader.read(2);

	const lfe = lff === 1 || lff === 2;
	return {
		samples: (nblks + 1) * 32,
		frameBytes: fsize + 1,
		amode,
		sampleRate: DTS_SAMPLE_RATES[sfreq]!,
		lfe,
		channels: DTS_AMODE_CHANNELS[amode]! + (lfe ? 1 : 0),
	};
};

// ISO/IEC 11172-3 and 13818-3 layer III bit rates, in kbps
const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_SAMPLE_RATES_V1 = [44100, 48000, 32000];

export type Mp3FrameInfo = {
	version: '1' | '2' | '2.5';
	layer: number;
	bitrate: number;
	sampleRate: number;
	mode: number;
	frameBytes: number;
	samples: number;
};

/** Parses an MPEG audio frame header. */
export const parseMp3Frame = (frame: Uint8Array): Mp3FrameInfo => {
	const reader = new BitReader(frame);
	if (reader.read(11) !== 0x7ff) {
		throw new Error('No MPEG audio sync.');
	}
	const versionBits = reader.read(2);
	const layerBits = reader.read(2);
	reader.read(1); // protection_bit
	const bitrateIndex = reader.read(4);
	const sampleRateIndex = reader.read(2);
	const padding = reader.read(1);
	reader.read(1); // private_bit
	const mode = reader.read(2);

	const version = versionBits === 3 ? '1' : versionBits === 2 ? '2' : '2.5';
	const sampleRate = MP3_SAMPLE_RATES_V1[sampleRateIndex]! / (version === '1' ? 1 : version === '2' ? 2 : 4);
	const bitrate = (version === '1' ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex]! * 1000;
	const samples = version === '1' ? 1152 : 576;

	return {
		version,
		layer: 4 - layerBits,
		bitrate,
		sampleRate,
		mode,
		frameBytes: Math.floor(samples / 8 * bitrate / sampleRate) + padding,
		samples,
	};
};

export const MP3_LAYER_3_BITRATES: Record<Mp3FrameInfo['version'], number[]> = {
	1: MP3_BITRATES_V1.slice(1).map(x => x * 1000),
	2: MP3_BITRATES_V2.slice(1).map(x => x * 1000),
	2.5: MP3_BITRATES_V2.slice(1).map(x => x * 1000),
};

const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Parses the start of an AudioSpecificConfig (ISO/IEC 14496-3, 1.6.2.1). */
export const parseAudioSpecificConfig = (bytes: Uint8Array) => {
	const reader = new BitReader(bytes);
	let objectType = reader.read(5);
	if (objectType === 31) {
		objectType = 32 + reader.read(6);
	}
	const frequencyIndex = reader.read(4);
	const sampleRate = frequencyIndex === 15 ? reader.read(24) : AAC_SAMPLE_RATES[frequencyIndex]!;
	const channelConfiguration = reader.read(4);

	return { objectType, sampleRate, channelConfiguration };
};

/** Parses an ADTS header (ISO/IEC 13818-7, 6.2). */
export const parseAdtsHeader = (bytes: Uint8Array) => {
	const reader = new BitReader(bytes);
	if (reader.read(12) !== 0xfff) {
		throw new Error('No ADTS syncword.');
	}
	reader.read(1); // ID
	reader.read(2); // layer
	const protectionAbsent = reader.read(1);
	const profile = reader.read(2);
	const frequencyIndex = reader.read(4);
	reader.read(1); // private_bit
	const channelConfiguration = reader.read(3);
	reader.read(4); // original/copy, home, copyright bits
	const frameLength = reader.read(13);

	return {
		objectType: profile + 1,
		sampleRate: AAC_SAMPLE_RATES[frequencyIndex]!,
		channelConfiguration,
		frameLength,
		headerLength: protectionAbsent ? 7 : 9,
	};
};

/** CRC-8 with polynomial 0x07, as used by FLAC frame headers. */
export const crc8 = (bytes: Uint8Array) => {
	let crc = 0;
	for (const byte of bytes) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) {
			crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
		}
	}

	return crc;
};

export type FlacFrameInfo = {
	blockingStrategy: number;
	blockSize: number;
	sampleRateBits: number;
	channelAssignment: number;
	sampleSizeBits: number;
	number: number;
	headerCrcOk: boolean;
};

/** Parses a FLAC frame header (RFC 9639, 9.1). */
export const parseFlacFrame = (frame: Uint8Array): FlacFrameInfo => {
	const reader = new BitReader(frame);
	if (reader.read(15) !== 0x7ffc) {
		throw new Error('No FLAC frame sync.');
	}
	const blockingStrategy = reader.read(1);
	const blockSizeBits = reader.read(4);
	const sampleRateBits = reader.read(4);
	const channelAssignment = reader.read(4);
	const sampleSizeBits = reader.read(3);
	reader.read(1); // reserved

	// The coded number is UTF-8-like
	const first = reader.read(8);
	let extraBytes = 0;
	while (first & (0x80 >> extraBytes)) {
		extraBytes++;
	}
	let number = extraBytes === 0 ? first : first & (0xff >> (extraBytes + 1));
	for (let i = 1; i < extraBytes; i++) {
		number = number * 64 + (reader.read(8) & 0x3f);
	}

	let blockSize: number;
	if (blockSizeBits === 1) {
		blockSize = 192;
	} else if (blockSizeBits >= 2 && blockSizeBits <= 5) {
		blockSize = 144 * 2 ** blockSizeBits;
	} else if (blockSizeBits === 6) {
		blockSize = reader.read(8) + 1;
	} else if (blockSizeBits === 7) {
		blockSize = reader.read(16) + 1;
	} else {
		blockSize = 2 ** blockSizeBits;
	}

	if (sampleRateBits === 12) {
		reader.read(8);
	} else if (sampleRateBits === 13 || sampleRateBits === 14) {
		reader.read(16);
	}

	const headerLength = reader.pos / 8;
	const headerCrcOk = crc8(frame.subarray(0, headerLength)) === frame[headerLength];

	return { blockingStrategy, blockSize, sampleRateBits, channelAssignment, sampleSizeBits, number, headerCrcOk };
};

export type FlacStreamInfo = {
	minBlockSize: number;
	maxBlockSize: number;
	minFrameSize: number;
	maxFrameSize: number;
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	totalSamples: number;
};

/** Parses the STREAMINFO block of a FLAC file or of a dfLa/CodecPrivate description that starts with 'fLaC'. */
export const parseFlacStreamInfo = (bytes: Uint8Array): FlacStreamInfo => {
	const start = bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43 ? 4 : 0;
	const reader = new BitReader(bytes.subarray(start + 4)); // Skip the metadata block header
	return {
		minBlockSize: reader.read(16),
		maxBlockSize: reader.read(16),
		minFrameSize: reader.read(24),
		maxFrameSize: reader.read(24),
		sampleRate: reader.read(20),
		channels: reader.read(3) + 1,
		bitsPerSample: reader.read(5) + 1,
		totalSamples: reader.read(36),
	};
};
