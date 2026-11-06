import { describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS, MP3 } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { Mp3OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { InputAudioTrack } from '../../src/input-track.js';

// Tests for the MPEG audio frame layer and the Xing/Info/LAME headers of MP3 files, with frames built byte by byte
// from ISO/IEC 11172-3 and 13818-3 (see also http://www.mp3-tech.org/programmer/frame_header.html) and the LAME info
// tag specification (http://gabriel.mp3-tech.org/mp3infotag.html). Frame payloads are zeros: the demuxer only looks
// at headers.

type Bytes = number[] | Uint8Array;

const concat = (...parts: Bytes[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
};

const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
const u32Be = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];

type MpegVersion = '1' | '2' | '2.5';
type Layer = 1 | 2 | 3;
type ChannelMode = 'stereo' | 'joint' | 'dual' | 'mono';

const VERSION_BITS: Record<MpegVersion, number> = { 1: 0b11, 2: 0b10, 2.5: 0b00 };
const LAYER_BITS: Record<Layer, number> = { 1: 0b11, 2: 0b10, 3: 0b01 };
const MODE_BITS: Record<ChannelMode, number> = { stereo: 0, joint: 1, dual: 2, mono: 3 };

// Indexed by the 2-bit sample rate index
const SAMPLE_RATES: Record<MpegVersion, number[]> = {
	1: [44100, 48000, 32000],
	2: [22050, 24000, 16000],
	2.5: [11025, 12000, 8000],
};

// Indexed by bitrate index - 1 (index 0 is "free format", 15 is invalid)
const BITRATES: Record<'1' | '2', Record<Layer, number[]>> = {
	1: {
		1: [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
		2: [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
		3: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
	},
	2: {
		1: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
		2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
		3: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
	},
};

type FrameOptions = {
	version?: MpegVersion;
	layer?: Layer;
	bitrateIndex?: number;
	sampleRateIndex?: number;
	padding?: boolean;
	mode?: ChannelMode;
	crc?: boolean;
};

const resolve = (options: FrameOptions) => {
	const version = options.version ?? '1';
	const layer = options.layer ?? 3;
	const bitrateIndex = options.bitrateIndex ?? 9; // 128 kbps for MPEG-1 Layer III
	const sampleRateIndex = options.sampleRateIndex ?? 0;
	const kbps = BITRATES[version === '1' ? '1' : '2'][layer][bitrateIndex - 1]!;
	const sampleRate = SAMPLE_RATES[version][sampleRateIndex]!;
	const padding = options.padding ? 1 : 0;

	let size: number;
	let samplesPerFrame: number;
	if (layer === 1) {
		size = (Math.floor(12 * kbps * 1000 / sampleRate) + padding) * 4;
		samplesPerFrame = 384;
	} else if (layer === 2 || version === '1') {
		size = Math.floor(144 * kbps * 1000 / sampleRate) + padding;
		samplesPerFrame = 1152;
	} else {
		size = Math.floor(72 * kbps * 1000 / sampleRate) + padding;
		samplesPerFrame = 576;
	}

	return { version, layer, bitrateIndex, sampleRateIndex, kbps, sampleRate, padding, size, samplesPerFrame };
};

const frameHeader = (options: FrameOptions = {}) => {
	const { version, layer, bitrateIndex, sampleRateIndex, padding } = resolve(options);
	return [
		0xff,
		0xe0 | (VERSION_BITS[version] << 3) | (LAYER_BITS[layer] << 1) | (options.crc ? 0 : 1),
		(bitrateIndex << 4) | (sampleRateIndex << 2) | (padding << 1),
		MODE_BITS[options.mode ?? 'joint'] << 6,
	];
};

const frame = (options: FrameOptions = {}) => {
	const bytes = new Uint8Array(resolve(options).size);
	bytes.set(frameHeader(options));
	return bytes;
};

const frames = (count: number, options: FrameOptions = {}) =>
	concat(...Array.from({ length: count }, () => frame(options)));

// Where the Xing header starts: after the frame header and the side information
const xingOffset = (version: MpegVersion, mode: ChannelMode) => version === '1'
	? (mode === 'mono' ? 21 : 36)
	: (mode === 'mono' ? 13 : 21);

type XingOptions = FrameOptions & {
	tag?: 'Xing' | 'Info';
	frameCount?: number;
	byteCount?: number;
	toc?: boolean;
	quality?: number;
	lame?: { encoder?: string; delay: number; padding: number };
};

const xingFrame = (options: XingOptions) => {
	const { version } = resolve(options);
	const bytes = frame(options);
	const flags = (options.frameCount !== undefined ? 1 : 0)
		| (options.byteCount !== undefined ? 2 : 0)
		| (options.toc ? 4 : 0)
		| (options.quality !== undefined ? 8 : 0);

	const fields = [
		...ascii(options.tag ?? 'Xing'),
		...u32Be(flags),
		...(options.frameCount !== undefined ? u32Be(options.frameCount) : []),
		...(options.byteCount !== undefined ? u32Be(options.byteCount) : []),
		...(options.toc ? Array.from({ length: 100 }, (_, i) => Math.floor(256 * i / 100)) : []),
		...(options.quality !== undefined ? u32Be(options.quality) : []),
	];

	if (options.lame) {
		const lame = new Array<number>(36).fill(0);
		ascii((options.lame.encoder ?? 'LAME3.100').padEnd(9, '\0')).forEach((byte, i) => lame[i] = byte);
		lame[21] = options.lame.delay >> 4;
		lame[22] = ((options.lame.delay & 0xf) << 4) | (options.lame.padding >> 8);
		lame[23] = options.lame.padding & 0xff;
		fields.push(...lame);
	}

	bytes.set(fields, xingOffset(version, options.mode ?? 'joint'));
	return bytes;
};

const open = (bytes: Uint8Array) => new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

const readPackets = async (track: InputAudioTrack) => {
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	return packets;
};

const readFile = async (bytes: Uint8Array) => {
	using input = open(bytes);
	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track');
	}

	return {
		format: await input.getFormat(),
		sampleRate: await track.getSampleRate(),
		numberOfChannels: await track.getNumberOfChannels(),
		codec: await track.getCodec(),
		decoderConfig: await track.getDecoderConfig(),
		packets: await readPackets(track),
		durationFromMetadata: await track.getDurationFromMetadata(),
		computedDuration: await input.computeDuration(),
	};
};

describe('MPEG audio frame headers', () => {
	test('reads the sample rate and frame duration of every MPEG version, layer and sample rate', async () => {
		for (const version of ['1', '2', '2.5'] as const) {
			for (const layer of [1, 2, 3] as const) {
				for (const sampleRateIndex of [0, 1, 2]) {
					const options = { version, layer, sampleRateIndex, bitrateIndex: 5 };
					const { sampleRate, samplesPerFrame, size } = resolve(options);
					const file = await readFile(frames(4, options));

					expect(file.format).toBe(MP3);
					expect(file.codec).toBe('mp3');
					expect(file.sampleRate).toBe(sampleRate);
					expect(file.decoderConfig).toEqual({ codec: 'mp3', numberOfChannels: 2, sampleRate });
					expect(file.packets.map(packet => packet.data.byteLength)).toEqual([size, size, size, size]);
					expect(file.packets.map(packet => packet.timestamp))
						.toEqual([0, 1, 2, 3].map(i => i * samplesPerFrame / sampleRate));
					expect(file.packets.every(packet => packet.duration === samplesPerFrame / sampleRate)).toBe(true);
					expect(file.packets.every(packet => packet.type === 'key')).toBe(true);
				}
			}
		}
	});

	test('sizes frames by the bitrate table of their version and layer, plus the padding bit', async () => {
		for (const version of ['1', '2', '2.5'] as const) {
			for (const layer of [1, 2, 3] as const) {
				for (let bitrateIndex = 1; bitrateIndex <= 14; bitrateIndex++) {
					const options = { version, layer, bitrateIndex, sampleRateIndex: 2 };
					const stream = concat(
						frame({ ...options, padding: false }),
						frame({ ...options, padding: true }),
						frame({ ...options, padding: false }),
					);
					const file = await readFile(stream);

					const { size } = resolve(options);
					const paddingSize = layer === 1 ? 4 : 1; // Layer I pads by a 4-byte slot
					expect(file.packets.map(packet => packet.data.byteLength))
						.toEqual([size, size + paddingSize, size]);
				}
			}
		}
	});

	test('reads the channel count from the channel mode', async () => {
		for (const [mode, channels] of [['stereo', 2], ['joint', 2], ['dual', 2], ['mono', 1]] as const) {
			const file = await readFile(frames(3, { mode }));
			expect(file.numberOfChannels).toBe(channels);
			expect(file.decoderConfig!.numberOfChannels).toBe(channels);
		}
	});

	test('keeps reading when the channel mode switches between stereo and joint stereo', async () => {
		const stream = concat(
			frames(2, { mode: 'joint' }),
			frames(2, { mode: 'stereo' }),
			frames(2, { mode: 'joint' }),
		);
		expect((await readFile(stream)).packets).toHaveLength(6);
	});

	test('reads variable-bitrate streams frame by frame', async () => {
		const bitrateIndices = [9, 5, 14, 1, 11];
		const file = await readFile(concat(...bitrateIndices.map(bitrateIndex => frame({ bitrateIndex }))));

		expect(file.packets.map(packet => packet.data.byteLength))
			.toEqual(bitrateIndices.map(bitrateIndex => resolve({ bitrateIndex }).size));
		expect(file.packets.map(packet => packet.timestamp)).toEqual([0, 1, 2, 3, 4].map(i => i * 1152 / 44100));
	});

	test('reads CRC-protected frames whole', async () => {
		const file = await readFile(frames(3, { crc: true }));
		expect(file.packets.map(packet => packet.data.byteLength)).toEqual([417, 417, 417]);
		expect(file.packets[0]!.data[1]).toBe(0xfa);
	});

	test('passes the frame bytes through untouched', async () => {
		const original = frames(3, { padding: true });
		for (let i = 4; i < original.length; i++) {
			if (i % 418 >= 4) {
				original[i] = i & 0xff;
			}
		}

		const file = await readFile(original);
		expect(concat(...file.packets.map(packet => packet.data))).toEqual(original);
	});
});

describe('MPEG audio stream structure', () => {
	test('skips junk between frames', async () => {
		const junk = new Uint8Array(37).fill(0x11);
		const file = await readFile(concat(frames(2), junk, frame(), junk, junk, frame()));

		expect(file.packets).toHaveLength(4);
		expect(file.packets.map(packet => packet.timestamp)).toEqual([0, 1, 2, 3].map(i => i * 1152 / 44100));
	});

	test('skips sync words with a reserved layer, free-format bitrate or invalid bitrate index', async () => {
		const reservedLayer = [0xff, 0xf9, 0x90, 0x64]; // Layer bits 00
		const freeFormat = [0xff, 0xfb, 0x00, 0x64]; // Bitrate index 0
		const badBitrate = [0xff, 0xfb, 0xf0, 0x64]; // Bitrate index 15
		const file = await readFile(concat(frames(2), reservedLayer, freeFormat, badBitrate, frame(), frame()));

		expect(file.packets).toHaveLength(4);
	});

	test('skips frames of another layer after the first frame', async () => {
		const file = await readFile(concat(frames(2), frame({ layer: 2 }), frames(2)));
		expect(file.packets.map(packet => packet.data.byteLength)).toEqual([417, 417, 417, 417]);
	});

	test('drops a last frame cut off by the end of the file', async () => {
		const stream = frames(4);
		const file = await readFile(stream.subarray(0, stream.length - 100));
		expect(file.packets).toHaveLength(3);
	});

	test('does not read ID3v1, Lyrics3 or APEv2 tags at the end as frames', async () => {
		const id3v1 = concat(ascii('TAG'), new Uint8Array(125).fill(0xff));
		const lyrics = ascii('LYRICSBEGININD00003110LYR00005hello000033LYRICS200');
		const apeFooter = (flags: number) => concat(
			ascii('APETAGEX'),
			[0xd0, 0x07, 0, 0], // Version 2000
			[32 + 9, 0, 0, 0], // Tag size: items plus footer
			[1, 0, 0, 0], // Item count
			[0, 0, 0, flags],
			new Uint8Array(8),
		);
		const apeItem = concat([1, 0, 0, 0], [0, 0, 0, 0], ascii('Year'), [0], ascii('1'));
		const ape = concat(apeFooter(0xa0), apeItem, apeFooter(0x80));

		for (const trailer of [id3v1, concat(lyrics, id3v1), concat(ape, id3v1), ape]) {
			const file = await readFile(concat(frames(3), trailer));
			expect(file.packets).toHaveLength(3);
		}
	});

	test('finds the first frame after zero padding behind an ID3v2 tag', async () => {
		const id3 = concat(ascii('ID3'), [4, 0, 0], [0, 0, 0, 0]);
		const file = await readFile(concat(id3, new Uint8Array(1000), frames(3)));

		expect(file.packets).toHaveLength(3);
		expect(file.packets[0]!.timestamp).toBe(0);
	});

	test('estimates the duration of streams without a Xing header from the file size and first bitrate', async () => {
		const file = await readFile(frames(10, { padding: false }));

		// 10 frames of 417 bytes at 128 kbps, where an average frame is 417.959 bytes long
		expect(file.durationFromMetadata).toBe(10 * 1152 / 44100);
		expect(file.computedDuration).toBe(10 * 1152 / 44100);
	});
});

describe('Xing, Info and LAME headers', () => {
	test('does not emit the Xing frame as audio and takes the duration from its frame count', async () => {
		const file = await readFile(concat(xingFrame({ frameCount: 100, byteCount: 0, toc: true }), frames(5)));

		expect(file.packets).toHaveLength(5);
		expect(file.packets[0]!.timestamp).toBe(0);
		expect(file.durationFromMetadata).toBe(100 * 1152 / 44100);
		expect(file.computedDuration).toBe(5 * 1152 / 44100);
	});

	test('treats Info frames like Xing frames', async () => {
		const file = await readFile(concat(xingFrame({ tag: 'Info', frameCount: 5 }), frames(5)));

		expect(file.packets).toHaveLength(5);
		expect(file.durationFromMetadata).toBe(5 * 1152 / 44100);
	});

	test('shifts the timestamps back by the LAME encoder delay plus the 529-sample decoder delay', async () => {
		const file = await readFile(concat(
			xingFrame({
				tag: 'Info',
				frameCount: 6,
				byteCount: 0,
				toc: true,
				quality: 50,
				lame: { delay: 576, padding: 1000 },
			}),
			frames(6),
		));

		const priming = 576 + 529;
		expect(file.packets.map(packet => packet.timestamp))
			.toEqual([0, 1, 2, 3, 4, 5].map(i => (i * 1152 - priming) / 44100));
		expect(file.durationFromMetadata).toBe((6 * 1152 - priming) / 44100);
		expect(file.computedDuration).toBe((6 * 1152 - priming) / 44100);
	});

	test('finds the LAME tag behind any subset of the optional Xing fields', async () => {
		const subsets = [
			{},
			{ frameCount: 4 },
			{ byteCount: 1234 },
			{ toc: true },
			{ quality: 78 },
			{ frameCount: 4, toc: true },
			{ byteCount: 1234, quality: 78 },
			{ frameCount: 4, byteCount: 1234, toc: true, quality: 78 },
		];

		for (const subset of subsets) {
			const file = await readFile(concat(xingFrame({ ...subset, lame: { delay: 1000, padding: 0 } }), frames(4)));
			expect(file.packets[0]!.timestamp).toBe(-(1000 + 529) / 44100);
		}
	});

	test('reads FFmpeg\'s LAME tag but no tags from unknown encoders', async () => {
		for (const [encoder, delay] of [['Lavf61.1.100', 576], ['Lavc61.3.100', 576], ['GOGO3.13', 0]] as const) {
			const file = await readFile(concat(
				xingFrame({ frameCount: 4, lame: { encoder: encoder.slice(0, 9), delay: 576, padding: 0 } }),
				frames(4),
			));

			expect(file.packets[0]!.timestamp).toBe(delay ? -(delay + 529) / 44100 : 0);
		}
	});

	test('finds the Xing header after the side information of MPEG-1, MPEG-2 and mono streams', async () => {
		const cases = [
			{ version: '1', mode: 'joint', sampleRateIndex: 0, bitrateIndex: 9 },
			{ version: '1', mode: 'mono', sampleRateIndex: 1, bitrateIndex: 9 },
			{ version: '2', mode: 'joint', sampleRateIndex: 0, bitrateIndex: 14 },
			{ version: '2', mode: 'mono', sampleRateIndex: 1, bitrateIndex: 14 },
			{ version: '2.5', mode: 'joint', sampleRateIndex: 2, bitrateIndex: 14 },
			{ version: '2.5', mode: 'mono', sampleRateIndex: 0, bitrateIndex: 14 },
		] as const;

		for (const options of cases) {
			const { sampleRate, samplesPerFrame } = resolve(options);
			const file = await readFile(concat(
				xingFrame({ ...options, frameCount: 3, lame: { delay: 576, padding: 0 } }),
				frames(3, options),
			));

			expect(file.packets).toHaveLength(3);
			expect(file.sampleRate).toBe(sampleRate);
			expect(file.packets[0]!.timestamp).toBe(-(576 + 529) / sampleRate);
			expect(file.durationFromMetadata).toBe((3 * samplesPerFrame - 576 - 529) / sampleRate);
		}
	});

	test('estimates the duration of Info-tagged streams without a frame count from the file size', async () => {
		const file = await readFile(concat(xingFrame({ tag: 'Info', byteCount: 0 }), frames(8)));

		// Only the audio after the Info frame counts
		expect(file.durationFromMetadata).toBe(8 * 1152 / 44100);
		expect(file.packets).toHaveLength(8);
	});

	test('does not guess the duration of Xing-tagged (VBR) streams without a frame count', async () => {
		const file = await readFile(concat(xingFrame({ tag: 'Xing', byteCount: 0 }), frames(8)));
		expect(file.durationFromMetadata).toBeNull();
	});

	test('reads files that hold nothing but a Xing frame', async () => {
		using input = open(xingFrame({ frameCount: 0, mode: 'mono', sampleRateIndex: 1 }));

		expect(await input.getFormat()).toBe(MP3);
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getSampleRate()).toBe(48000);
		expect(await track.getNumberOfChannels()).toBe(1);
		expect(await readPackets(track)).toEqual([]);
		expect(await input.computeDuration()).toBe(0);
	});
});

describe('MP3 detection', () => {
	test('detects MP3 by two consecutive frames or a Xing frame', async () => {
		for (const bytes of [frames(2), concat(xingFrame({ frameCount: 1 }), new Uint8Array(10))]) {
			using input = open(bytes);
			expect(await input.getFormat()).toBe(MP3);
		}
	});

	test('rejects a lone frame header followed by something else', async () => {
		using input = open(concat(frame(), new Uint8Array(500).fill(0x22)));
		await expect(input.getFormat()).rejects.toThrow('unsupported or unrecognizable format');
	});
});

describe('MP3 packet retrieval', () => {
	const fileWithPriming = () => concat(
		xingFrame({ frameCount: 8, lame: { delay: 576, padding: 0 } }),
		frames(8),
	);
	const priming = (576 + 529) / 44100;
	const frameDuration = 1152 / 44100;

	test('looks up the packet containing a timestamp', async () => {
		using input = open(fileWithPriming());
		const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);

		expect(await sink.getPacket(-priming - 0.001)).toBeNull();
		expect((await sink.getPacket(-priming))!.sequenceNumber).toBe(0);
		expect((await sink.getPacket(0))!.sequenceNumber).toBe(0); // The first frame overlaps zero
		expect((await sink.getPacket(3 * frameDuration - priming))!.sequenceNumber).toBe(3);
		expect((await sink.getPacket(3.5 * frameDuration - priming))!.sequenceNumber).toBe(3);
		expect((await sink.getPacket(100))!.sequenceNumber).toBe(7);
		expect((await sink.getKeyPacket(5.5 * frameDuration - priming))!.sequenceNumber).toBe(5);
	});

	test('chains packets from any starting point until the end', async () => {
		using input = open(fileWithPriming());
		const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);

		let packet = await sink.getPacket(4 * frameDuration - priming);
		const sequenceNumbers: number[] = [];
		while (packet) {
			sequenceNumbers.push(packet.sequenceNumber);
			packet = await sink.getNextPacket(packet);
		}

		expect(sequenceNumbers).toEqual([4, 5, 6, 7]);
		expect((await sink.getNextKeyPacket((await sink.getFirstPacket())!))!.sequenceNumber).toBe(1);
	});

	test('gives metadata-only packets the same timing and sizes', async () => {
		using input = open(fileWithPriming());
		const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);

		const full = [];
		for await (const packet of sink.packets()) {
			full.push(packet);
		}
		const metadataOnly = [];
		for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
			metadataOnly.push(packet);
		}

		expect(metadataOnly.map(packet => [packet.timestamp, packet.duration, packet.byteLength]))
			.toEqual(full.map(packet => [packet.timestamp, packet.duration, packet.byteLength]));
		expect(metadataOnly.every(packet => packet.isMetadataOnly)).toBe(true);
	});
});

describe('MP3 writing', () => {
	const write = async (packets: EncodedPacket[], options: ConstructorParameters<typeof Mp3OutputFormat>[0] = {}) => {
		const output = new Output({ format: new Mp3OutputFormat(options), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('mp3');
		output.addAudioTrack(source);
		await output.start();
		for (const packet of packets) {
			await source.add(packet);
		}
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	const packetsOf = (stream: Uint8Array, frameSize: number, frameDuration: number, start = 0) =>
		Array.from({ length: stream.length / frameSize }, (_, i) => new EncodedPacket(
			stream.subarray(i * frameSize, (i + 1) * frameSize),
			'key',
			start + i * frameDuration,
			frameDuration,
		));

	test('writes a Xing frame followed by the frames as they are', async () => {
		const stream = frames(5);
		const bytes = await write(packetsOf(stream, 417, 1152 / 44100));

		const xingFrameSize = bytes.length - stream.length;
		expect(xingFrameSize).toBeGreaterThan(0);
		expect(bytes.subarray(xingFrameSize)).toEqual(stream);
		expect(String.fromCharCode(...bytes.subarray(36, 40))).toBe('Info'); // Constant bitrate

		const flags = (bytes[40]! << 24) | (bytes[41]! << 16) | (bytes[42]! << 8) | bytes[43]!;
		expect(flags & 0b111).toBe(0b111); // Frame count, byte count and TOC
		const byteCount = (bytes[48]! << 24) | (bytes[49]! << 16) | (bytes[50]! << 8) | bytes[51]!;
		expect(byteCount).toBe(bytes.length);

		const toc = [...bytes.subarray(52, 152)];
		expect(toc.every((value, i) => i === 0 || value >= toc[i - 1]!)).toBe(true);

		const file = await readFile(bytes);
		expect(file.packets.map(packet => packet.data)).toEqual(packetsOf(stream, 417, 0).map(packet => packet.data));
		expect(file.packets[0]!.timestamp).toBe(0);
	});

	test('writes a Xing (not Info) frame for variable-bitrate streams', async () => {
		const bitrateIndices = [5, 9, 14];
		const packets = bitrateIndices.map((bitrateIndex, i) => new EncodedPacket(
			frame({ bitrateIndex }),
			'key',
			i * 1152 / 44100,
			1152 / 44100,
		));
		const bytes = await write(packets);

		expect(String.fromCharCode(...bytes.subarray(36, 40))).toBe('Xing');
		expect((await readFile(bytes)).packets.map(packet => packet.data.byteLength))
			.toEqual(bitrateIndices.map(bitrateIndex => resolve({ bitrateIndex }).size));
	});

	test('copies the stream\'s version, layer, sample rate and mode into the Xing frame header', async () => {
		const options = { version: '2', sampleRateIndex: 1, mode: 'mono', bitrateIndex: 8 } as const;
		const { size, samplesPerFrame, sampleRate } = resolve(options);
		const bytes = await write(packetsOf(frames(3, options), size, samplesPerFrame / sampleRate));

		const header = [...bytes.subarray(0, 4)];
		const streamHeader = frameHeader(options);
		expect(header[0]).toBe(0xff);
		expect(header[1]! & 0xfe).toBe(streamHeader[1]! & 0xfe);
		expect(header[2]! & 0x0c).toBe(streamHeader[2]! & 0x0c);
		expect(header[3]! & 0xc0).toBe(streamHeader[3]! & 0xc0);
		expect(String.fromCharCode(...bytes.subarray(13, 17))).toBe('Info');

		const file = await readFile(bytes);
		expect(file.sampleRate).toBe(24000);
		expect(file.numberOfChannels).toBe(1);
		expect(file.packets).toHaveLength(3);
	});

	test('stores a negative start as the LAME encoder delay', async () => {
		const priming = (576 + 529) / 44100;
		const bytes = await write(packetsOf(frames(6), 417, 1152 / 44100, -priming));

		// The LAME tag sits behind the Xing fields
		const lameStart = 36 + 4 + 4 + 4 + 4 + 100;
		expect(String.fromCharCode(...bytes.subarray(lameStart, lameStart + 4))).toBe('LAME');
		const delay = (bytes[lameStart + 21]! << 4) | (bytes[lameStart + 22]! >> 4);
		expect(delay).toBe(576);

		const file = await readFile(bytes);
		expect(file.packets.map(packet => packet.timestamp))
			.toEqual([0, 1, 2, 3, 4, 5].map(i => (i * 1152 - 576 - 529) / 44100));
	});

	test('writes the frames alone when the Xing header is disabled', async () => {
		const stream = frames(4);
		let xingFrameCalls = 0;
		const bytes = await write(packetsOf(stream, 417, 1152 / 44100), {
			xingHeader: false,
			onXingFrame: () => xingFrameCalls++,
		});

		expect(bytes).toEqual(stream);
		expect(xingFrameCalls).toBe(0);
	});

	test('reports the final Xing frame through onXingFrame', async () => {
		let reported: { data: Uint8Array; position: number } | null = null;
		const bytes = await write(packetsOf(frames(4), 417, 1152 / 44100), {
			onXingFrame: (data, position) => {
				reported = { data: data.slice(), position };
			},
		});

		expect(reported).not.toBeNull();
		const { data, position } = reported!;
		expect(position).toBe(0);
		expect(bytes.subarray(position, position + data.length)).toEqual(data);
	});

	test('writes a lone Xing frame for an empty track described by its decoder config', async () => {
		const output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('mp3');
		output.addAudioTrack(source, { decoderConfig: { codec: 'mp3', numberOfChannels: 1, sampleRate: 22050 } });
		await output.start();
		await output.finalize();

		using input = open(new Uint8Array(output.target.buffer!));
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getSampleRate()).toBe(22050);
		expect(await track.getNumberOfChannels()).toBe(1);
		expect(await readPackets(track)).toEqual([]);
	});

	test('refuses to finalize an empty track it knows nothing about', async () => {
		for (const xingHeader of [true, false]) {
			const output = new Output({ format: new Mp3OutputFormat({ xingHeader }), target: new BufferTarget() });
			output.addAudioTrack(new EncodedAudioPacketSource('mp3'));
			await output.start();
			await expect(output.finalize()).rejects.toThrow('Cannot finalize an empty MP3 file');
		}
	});

	test('rejects packets that don\'t start with a frame header', async () => {
		const output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('mp3');
		output.addAudioTrack(source);
		await output.start();

		await expect(source.add(new EncodedPacket(new Uint8Array(417), 'key', 0, 1152 / 44100)))
			.rejects.toThrow('Invalid MP3 header in sample.');
	});
});
