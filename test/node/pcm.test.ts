import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { WavOutputFormat } from '../../src/output-format.js';
import { AudioSampleSource, EncodedAudioPacketSource, PCM_ENCODER_PACKET_SIZE } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { AudioSampleSink } from '../../src/media-sink.js';
import { AudioSample } from '../../src/sample.js';
import { AudioCodec, PcmAudioCodec } from '../../src/codec.js';
import { CustomAudioDecoder, registerDecoder } from '../../src/custom-coder.js';
import { toUint8Array, uint8ArraysAreEqual } from '../../src/misc.js';
import { fromAlaw, fromUlaw, toAlaw, toUlaw } from '../../src/pcm.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// All of these span the full value range of their format
const u8Data = Uint8Array.from({ length: 256 }, (_, i) => i);
const s16Data = Int16Array.from({ length: 65536 }, (_, i) => i - 32768);
const s24Data = Int32Array.from({ length: 65536 }, (_, i) => (i * 256 + (i & 255) - 8388608) << 8);
const s32Data = Int32Array.from({ length: 65536 }, (_, i) => (i - 32768) * 65536 + i);
const f32Data = Float32Array.from({ length: 65536 }, (_, i) => Math.sin(i));

type SampleData = Uint8Array | Int16Array | Int32Array | Float32Array;
type SampleFormat = 'u8' | 's16' | 's32' | 'f32';

test('u8 copyTo identity', () => {
	testCopyToIdentity('u8', u8Data);
});

test('s16 copyTo identity', () => {
	testCopyToIdentity('s16', s16Data);
});

test('s32 copyTo identity', () => {
	testCopyToIdentity('s32', s32Data);
});

test('f32 copyTo identity', () => {
	testCopyToIdentity('f32', f32Data);
});

test('pcm-u8 encode-decode roundtrip', async () => {
	await testEncodeDecodeRoundtrip('pcm-u8', 'u8', u8Data);
});

test('pcm-s16 encode-decode roundtrip', async () => {
	await testEncodeDecodeRoundtrip('pcm-s16', 's16', s16Data);
});

test('pcm-s24 encode-decode roundtrip', async () => {
	await testEncodeDecodeRoundtrip('pcm-s24', 's32', s24Data);
});

test('pcm-s32 encode-decode roundtrip', async () => {
	await testEncodeDecodeRoundtrip('pcm-s32', 's32', s32Data);
});

test('pcm-f32 encode-decode roundtrip', async () => {
	await testEncodeDecodeRoundtrip('pcm-f32', 'f32', f32Data);
});

test('Encoded PCM packets have a fixed size', async () => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	const packets: EncodedPacket[] = [];
	const audioSource = new AudioSampleSource({
		codec: 'pcm-s16',
		onEncodedPacket: packet => packets.push(packet),
	});
	output.addAudioTrack(audioSource);
	await output.start();

	const sampleCount = 7;
	const framesPerSample = 1000;
	const data = new Int16Array(2 * sampleCount * framesPerSample).map((_, i) => i - 2 ** 14);

	for (let i = 0; i < sampleCount; i++) {
		using sample = new AudioSample({
			data: data.subarray(2 * i * framesPerSample, 2 * (i + 1) * framesPerSample),
			format: 's16',
			numberOfChannels: 2,
			sampleRate: 48000,
			timestamp: i * framesPerSample / 48000,
		});
		await audioSource.add(sample);
	}
	audioSource.close();
	await output.finalize();

	const totalFrames = sampleCount * framesPerSample;
	expect(packets.map(x => x.duration * 48000)).toEqual([
		...Array<number>(Math.floor(totalFrames / PCM_ENCODER_PACKET_SIZE)).fill(PCM_ENCODER_PACKET_SIZE),
		totalFrames % PCM_ENCODER_PACKET_SIZE,
	]);
	expect(packets.map(x => x.timestamp * 48000)).toEqual(packets.map((_, i) => i * PCM_ENCODER_PACKET_SIZE));

	const encoded = new Int16Array(2 * totalFrames);
	let offset = 0;
	for (const packet of packets) {
		encoded.set(new Int16Array(packet.data.slice().buffer), offset);
		offset += packet.data.byteLength / 2;
	}
	expect(encoded).toEqual(data);
});

test('Long gaps between encoded audio samples are filled with silence in pieces of at most 16 MiB', async () => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	const frameCounts: number[] = [];
	const audioSource = new AudioSampleSource({
		codec: 'pcm-s16',
		onEncodedSample: sample => frameCounts.push(sample.numberOfFrames),
	});
	output.addAudioTrack(audioSource);
	await output.start();

	// One second of audio, a ten-minute gap (19.2 MB of f32 silence), then another second
	for (const timestamp of [0, 601]) {
		using sample = new AudioSample({
			data: new Float32Array(8000).fill(0.5),
			format: 'f32',
			numberOfChannels: 1,
			sampleRate: 8000,
			timestamp,
		});
		await audioSource.add(sample);
	}
	await output.finalize();

	// The whole gap used to be one sample, which at 48 kHz stereo exceeds what an AudioData can hold after 90 minutes
	expect(frameCounts).toEqual([8000, 2 ** 22, 4_800_000 - 2 ** 22, 8000]);

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.computeDuration()).toBe(602);
});

const testCopyToIdentity = (format: SampleFormat, data: SampleData) => {
	using sample = new AudioSample({
		data,
		format,
		numberOfChannels: 1,
		sampleRate: 48000,
		timestamp: 0,
	});

	const copied = data.slice().fill(0);
	sample.copyTo(copied, {
		format,
		planeIndex: 0,
	});

	expect(uint8ArraysAreEqual(toUint8Array(copied), toUint8Array(data))).toBe(true);
};

const testEncodeDecodeRoundtrip = async (codec: PcmAudioCodec, format: SampleFormat, data: SampleData) => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec });
	output.addAudioTrack(audioSource);

	await output.start();
	const sample = new AudioSample({
		data,
		format,
		numberOfChannels: 1,
		sampleRate: 48000,
		timestamp: 0,
	});
	await audioSource.add(sample);
	sample.close();
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getCodec()).toBe(codec);

	const sink = new AudioSampleSink(track);
	const decoded = data.slice().fill(0);
	let frameOffset = 0;

	for await (using sample of sink.samples()) {
		sample.copyTo(decoded.subarray(frameOffset), {
			format,
			planeIndex: 0,
		});
		frameOffset += sample.numberOfFrames;
	}

	expect(frameOffset).toBe(data.length);
	expect(uint8ArraysAreEqual(toUint8Array(decoded), toUint8Array(data))).toBe(true);
};

// Expected values from the ITU-T G.711 decoding tables, expressed as s16 PCM

test('µ-law decoding produces correctly-scaled s16 PCM', () => {
	expect(fromUlaw(0x00)).toBe(-32124);
	expect(fromUlaw(0x80)).toBe(32124);
	expect(fromUlaw(0xFF)).toBe(0);
	expect(fromUlaw(0xFE)).toBe(8);
	expect(fromUlaw(0x7E)).toBe(-8);
	expect(fromUlaw(0x55)).toBe(-716);
	expect(fromUlaw(0xD5)).toBe(716);
});

test('A-law decoding produces correctly-scaled s16 PCM', () => {
	expect(fromAlaw(0xD5)).toBe(8);
	expect(fromAlaw(0x55)).toBe(-8);
	expect(fromAlaw(0xAA)).toBe(32256);
	expect(fromAlaw(0x2A)).toBe(-32256);
	expect(fromAlaw(0xF0)).toBe(688);
	expect(fromAlaw(0x70)).toBe(-688);
});

test('µ-law encoding maps full-scale s16 PCM', () => {
	expect(toUlaw(0)).toBe(0xFF);
	expect(toUlaw(1000)).toBe(0xCE); // Decodes to +988, within one quantization step
	expect(toUlaw(-1000)).toBe(0x4E);
	expect(toUlaw(32124)).toBe(0x80);
	expect(toUlaw(32767)).toBe(0x80);
	expect(toUlaw(-32124)).toBe(0x00);
	expect(toUlaw(-32768)).toBe(0x00);
});

test('A-law encoding maps full-scale s16 PCM', () => {
	expect(toAlaw(0)).toBe(0xD5);
	expect(toAlaw(1000)).toBe(0xFA);
	expect(toAlaw(-1000)).toBe(0x7A);
	expect(toAlaw(32256)).toBe(0xAA);
	expect(toAlaw(32767)).toBe(0xAA);
	expect(toAlaw(-32256)).toBe(0x2A);
	expect(toAlaw(-32768)).toBe(0x2A);
});

test('G.711 encode/decode round-trips', () => {
	for (const v of [1, -1, 64, -64, 500, -500, 4000, -4000, 16000, -16000, 32000, -32000]) {
		const fromU = fromUlaw(toUlaw(v));
		const fromA = fromAlaw(toAlaw(v));

		if (Math.abs(v) >= 64) {
			expect(Math.sign(fromU)).toBe(Math.sign(v));
			expect(Math.sign(fromA)).toBe(Math.sign(v));
		}

		expect(Math.abs(fromU - v)).toBeLessThanOrEqual(Math.max(16, Math.abs(v) >> 3));
		expect(Math.abs(fromA - v)).toBeLessThanOrEqual(Math.max(16, Math.abs(v) >> 3));
	}
});

test('mu-law file roundtrip', async () => {
	await expectG711FileRoundtrip('ulaw', fromUlaw);
});

test('A-law file roundtrip', async () => {
	await expectG711FileRoundtrip('alaw', fromAlaw);
});

const expectG711FileRoundtrip = async (codec: 'ulaw' | 'alaw', decodeCodeword: (u8: number) => number) => {
	// Every value the codec can represent, so the roundtrip must be lossless
	const data = Int16Array.from({ length: 256 }, (_, i) => decodeCodeword(i));

	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec });
	output.addAudioTrack(audioSource);

	await output.start();
	const sample = new AudioSample({
		data,
		format: 's16',
		numberOfChannels: 1,
		sampleRate: 8000,
		timestamp: 0,
	});
	await audioSource.add(sample);
	sample.close();
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getCodec()).toBe(codec);

	const sink = new AudioSampleSink(track);
	const decoded = new Int16Array(data.length);
	let frameOffset = 0;

	for await (using sample of sink.samples()) {
		sample.copyTo(decoded.subarray(frameOffset), {
			format: 's16',
			planeIndex: 0,
		});
		frameOffset += sample.numberOfFrames;
	}

	expect(frameOffset).toBe(data.length);
	expect(decoded).toEqual(data);
};

test('RF64 sample count goes by the data, not the packet durations', async () => {
	const output = new Output({
		format: new WavOutputFormat({ large: true }),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);
	await output.start();

	// 1000 stereo frames per packet at 48 kHz, with durations rounded to milliseconds, as in a Matroska file
	for (let i = 0; i < 3; i++) {
		await source.add(
			new EncodedPacket(new Uint8Array(4000), 'key', i * 0.021, 0.021),
			{ decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } },
		);
	}
	await output.finalize();

	const view = new DataView(output.target.buffer!);
	expect(String.fromCharCode(...new Uint8Array(output.target.buffer!, 12, 4))).toBe('ds64');
	expect(view.getBigUint64(28, true)).toBe(12000n); // Data size
	expect(view.getBigUint64(36, true)).toBe(3000n); // Sample count
});

test('WAVE writes the format chunk of non-PCM formats as a WAVEFORMATEX with cbSize', async () => {
	// Microsoft's WAVEFORMATEX, which formats other than PCM use, ends with cbSize, the size of the extra format
	// information. It must be 0 if there is none, and is only ignored for PCM.
	const codecs: [PcmAudioCodec, number][] = [
		// Codec, expected fmt chunk size
		['pcm-s16', 16],
		['pcm-u8', 16],
		['pcm-f32', 18],
		['pcm-f64', 18],
		['alaw', 18],
		['ulaw', 18],
	];

	for (const [codec, fmtSize] of codecs) {
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource(codec);
		output.addAudioTrack(source);
		await output.start();

		const data = Uint8Array.from({ length: 2 * 8 * 100 }, (_, i) => i * 7);
		await source.add(
			new EncodedPacket(data, 'key', 0, 0.01),
			{ decoderConfig: { codec, numberOfChannels: 2, sampleRate: 48000 } },
		);
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		const view = new DataView(bytes.buffer);
		const chunks = new Map<string, Uint8Array>();
		for (let pos = 12; pos + 8 <= bytes.length;) {
			const size = view.getUint32(pos + 4, true);
			chunks.set(String.fromCharCode(...bytes.subarray(pos, pos + 4)), bytes.subarray(pos + 8, pos + 8 + size));
			pos += 8 + size + (size & 1);
		}

		const fmt = chunks.get('fmt ')!;
		expect(fmt.length, codec).toBe(fmtSize);
		if (fmtSize === 18) {
			expect(new DataView(fmt.buffer, fmt.byteOffset).getUint16(16, true), codec).toBe(0);
		}
		expect(chunks.get('data'), codec).toEqual(data);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getCodec(), codec).toBe(codec);
	}
});

test('A registered custom decoder takes precedence over the built-in PCM decoder', async () => {
	let active = false; // Keeps the decoder out of the other tests
	let decodeCalls = 0;

	class CustomPcmDecoder extends CustomAudioDecoder {
		static override supports(codec: AudioCodec) {
			return active && codec === 'pcm-s16';
		}

		override init() {}

		override decode(packet: EncodedPacket) {
			decodeCalls++;
			const numberOfFrames = Math.round(packet.duration * this.config.sampleRate);
			this.onSample(new AudioSample({
				data: new Float32Array(numberOfFrames * this.config.numberOfChannels).fill(0.5),
				format: 'f32',
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
				timestamp: packet.timestamp,
			}));
		}

		override flush() {}
		override close() {}
	}

	registerDecoder(CustomPcmDecoder);
	active = true;

	try {
		const filePath = path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav'); // 16-bit PCM
		using input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getCodec()).toBe('pcm-s16');

		using sample = (await new AudioSampleSink(track).getSample(1))!;
		const data = new Float32Array(sample.allocationSize({ format: 'f32', planeIndex: 0 }) / 4);
		sample.copyTo(data, { format: 'f32', planeIndex: 0 });

		expect(decodeCalls).toBeGreaterThan(0);
		expect(data[0]).toBe(0.5);
	} finally {
		active = false;
	}
});
