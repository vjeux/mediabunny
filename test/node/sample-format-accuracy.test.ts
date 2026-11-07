import { beforeAll, describe, expect, test } from 'vitest';
import * as NodeAv from 'node-av';
import { registerMediabunnyServer, toAvFrame } from '../../packages/server/src/index.js';
import { AvFrameVideoSampleResource } from '../../packages/server/src/video-sample.js';
import { AudioResampler } from '../../src/resample.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { Output } from '../../src/output.js';
import { MovOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { AudioSampleSource, EncodedAudioPacketSource } from '../../src/media-source.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { PCM_AUDIO_CODECS } from '../../src/codec.js';
import {
	buildYuvFrame,
	createErrorAccumulator,
	MatrixName,
	to8Bit,
	yuvFormatInfo,
	yuvToRgb,
} from './helpers/pixels-reference.js';

beforeAll(() => {
	registerMediabunnyServer();
});

describe('Channel mixing', () => {
	const mix = async (channels: number[][], targetNumberOfChannels: number) => {
		const numberOfFrames = channels[0]!.length;
		const data = new Float32Array(numberOfFrames * channels.length);
		for (let frame = 0; frame < numberOfFrames; frame++) {
			for (let channel = 0; channel < channels.length; channel++) {
				data[frame * channels.length + channel] = channels[channel]![frame]!;
			}
		}

		const output: number[][] = Array.from({ length: targetNumberOfChannels }, () => []);
		// Same sample rate, so only the channels get mixed
		const resampler = new AudioResampler({
			targetSampleRate: 48000,
			targetNumberOfChannels,
			onSample: async (sample) => {
				for (let channel = 0; channel < targetNumberOfChannels; channel++) {
					const plane = new Float32Array(sample.numberOfFrames);
					sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
					output[channel]!.push(...plane);
				}
				sample.close();
			},
		});
		const sample = new AudioSample({
			format: 'f32',
			sampleRate: 48000,
			numberOfChannels: channels.length,
			timestamp: 0,
			data,
		});
		await resampler.add(sample);
		sample.close();
		await resampler.finalize();

		return output;
	};

	// Distinct values per channel and frame, so every coefficient shows up
	const makeChannels = (count: number) => Array.from({ length: count }, (_, channel) => {
		return Array.from({ length: 8 }, (_, frame) => ((channel + 1) * 0.07 + frame * 0.011) * (frame % 2 ? -1 : 1));
	});

	test('follows the Web Audio API\'s speaker rules between mono, stereo, quad and 5.1', async () => {
		// Output channels (rows) as weights of the input channels (columns), from the Web Audio API spec, "Channel
		// up-mixing and down-mixing". Channel orders: L R / L R SL SR / L R C LFE SL SR.
		const s = Math.SQRT1_2;
		const matrices: Record<string, number[][]> = {
			'1-2': [[1], [1]],
			'1-4': [[1], [1], [0], [0]],
			'1-6': [[0], [0], [1], [0], [0], [0]],
			'2-1': [[0.5, 0.5]],
			'2-4': [[1, 0], [0, 1], [0, 0], [0, 0]],
			'2-6': [[1, 0], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0]],
			'4-1': [[0.25, 0.25, 0.25, 0.25]],
			'4-2': [[0.5, 0, 0.5, 0], [0, 0.5, 0, 0.5]],
			'4-6': [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
			'6-1': [[s, s, 1, 0, 0.5, 0.5]],
			'6-2': [[1, 0, s, 0, s, 0], [0, 1, s, 0, 0, s]],
			'6-4': [[1, 0, s, 0, 0, 0], [0, 1, s, 0, 0, 0], [0, 0, 0, 0, 1, 0], [0, 0, 0, 0, 0, 1]],
		};

		for (const [key, matrix] of Object.entries(matrices)) {
			const [sourceCount, targetCount] = key.split('-').map(Number) as [number, number];
			const input = makeChannels(sourceCount);
			const output = await mix(input, targetCount);

			for (let target = 0; target < targetCount; target++) {
				for (let frame = 0; frame < 8; frame++) {
					let expected = 0;
					for (let source = 0; source < sourceCount; source++) {
						expected += matrix[target]![source]! * Math.fround(input[source]![frame]!);
					}
					const message = `${key}, channel ${target}, frame ${frame}`;
					expect(output[target]![frame], message).toBeCloseTo(expected, 6);
				}
			}
		}
	});

	test('maps other channel counts discretely, dropping or zero-filling channels', async () => {
		for (const [sourceCount, targetCount] of [[3, 2], [2, 3], [8, 6], [6, 8], [5, 1], [1, 3]] as const) {
			const input = makeChannels(sourceCount);
			const output = await mix(input, targetCount);

			for (let target = 0; target < targetCount; target++) {
				for (let frame = 0; frame < 8; frame++) {
					const expected = target < sourceCount ? Math.fround(input[target]![frame]!) : 0;
					expect(output[target]![frame], `${sourceCount}-${targetCount}, channel ${target}`).toBe(expected);
				}
			}
		}
	});
});

describe('PCM sample mapping', () => {
	type PcmCodec = typeof PCM_AUDIO_CODECS[number];
	const INTEGER_CODECS: [PcmCodec, number, boolean, boolean][] = [
		// Codec, bits, signed, little endian
		['pcm-u8', 8, false, true],
		['pcm-s8', 8, true, true],
		['pcm-s16', 16, true, true],
		['pcm-s16be', 16, true, false],
		['pcm-s24', 24, true, true],
		['pcm-s24be', 24, true, false],
		['pcm-s32', 32, true, true],
		['pcm-s32be', 32, true, false],
	];

	const readInteger = (bytes: Uint8Array, index: number, bits: number, signed: boolean, littleEndian: boolean) => {
		const size = bits / 8;
		let value = 0;
		for (let i = 0; i < size; i++) {
			const byte = bytes[index * size + (littleEndian ? i : size - 1 - i)]!;
			value += byte * 2 ** (8 * i);
		}
		if (signed && value >= 2 ** (bits - 1)) {
			value -= 2 ** bits;
		}
		return value;
	};

	const writeInteger = (bytes: Uint8Array, index: number, value: number, bits: number, littleEndian: boolean) => {
		const size = bits / 8;
		const unsigned = value < 0 ? value + 2 ** bits : value;
		for (let i = 0; i < size; i++) {
			bytes[index * size + (littleEndian ? i : size - 1 - i)] = Math.floor(unsigned / 2 ** (8 * i)) % 256;
		}
	};

	const encode = async (codec: PcmCodec, values: number[]) => {
		const output = new Output({ format: new MovOutputFormat(), target: new BufferTarget() });
		const source = new AudioSampleSource({ codec, bitrate: 1e6 });
		output.addAudioTrack(source);
		await output.start();
		const sample = new AudioSample({
			format: 'f32',
			sampleRate: 48000,
			numberOfChannels: 1,
			timestamp: 0,
			data: new Float32Array(values),
		});
		await source.add(sample);
		sample.close();
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		const chunks: Uint8Array[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			chunks.push(packet.data);
		}
		const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return bytes;
	};

	const decode = async (codec: PcmCodec, bytes: Uint8Array) => {
		const output = new Output({ format: new MovOutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource(codec);
		output.addAudioTrack(source);
		await output.start();
		await source.add(new EncodedPacket(bytes, 'key', 0, 0.01), {
			decoderConfig: { codec, sampleRate: 48000, numberOfChannels: 1 },
		});
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		const values: number[] = [];
		for await (const sample of new AudioSampleSink(track).samples()) {
			const data = new Float32Array(sample.numberOfFrames);
			sample.copyTo(data, { planeIndex: 0, format: 'f32' });
			values.push(...data);
			sample.close();
		}
		return values;
	};

	// Float input with out-of-range values, infinities and denormals; no value lands exactly halfway between two
	// integer codes, where rounding conventions differ
	const FLOAT_VALUES = [
		-2, -1, -0.75, -0.3, -1e-6, -1.4e-45, 0, 1.4e-45, 1e-6, 0.3, 0.75, 0.999, 1 - 2 ** -24, 1, 2,
		Infinity, -Infinity,
	];

	test('encodes float samples to integer PCM like FFmpeg: scaled by 2^(bits-1), rounded and clipped', async () => {
		for (const [codec, bits, signed, littleEndian] of INTEGER_CODECS) {
			const bytes = await encode(codec, FLOAT_VALUES);
			const actual = FLOAT_VALUES.map((_, i) => readInteger(bytes, i, bits, signed, littleEndian));
			const expected = FLOAT_VALUES.map((value) => {
				const scale = 2 ** (bits - 1);
				const clipped = Math.min(Math.max(Math.round(Math.fround(value) * scale), -scale), scale - 1);
				return signed ? clipped + 0 : clipped + scale; // + 0 turns -0 into 0
			});
			expect(actual, codec).toEqual(expected);
		}

		// A few values spelled out
		expect(Array.from(await encode('pcm-s16', [-1, -0.5, 0, 0.5, 1])))
			.toEqual([0, 128, 0, 192, 0, 0, 0, 64, 255, 127]);
		expect(Array.from(await encode('pcm-u8', [-1, -0.5, 0, 0.5, 1]))).toEqual([0, 64, 128, 192, 255]);
	});

	test('encodes float samples to float PCM unchanged, out-of-range values included', async () => {
		for (const [codec, size, littleEndian] of [
			['pcm-f32', 4, true], ['pcm-f32be', 4, false], ['pcm-f64', 8, true], ['pcm-f64be', 8, false],
		] as const) {
			const bytes = await encode(codec, FLOAT_VALUES);
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const actual = FLOAT_VALUES.map((_, i) => {
				return size === 4 ? view.getFloat32(4 * i, littleEndian) : view.getFloat64(8 * i, littleEndian);
			});
			expect(actual, codec).toEqual(FLOAT_VALUES.map(Math.fround));
		}
	});

	test('decodes integer PCM to float samples like FFmpeg: divided by 2^(bits-1)', async () => {
		for (const [codec, bits, signed, littleEndian] of INTEGER_CODECS) {
			const max = 2 ** (bits - 1);
			const codes = [-max, -max + 1, -max / 2, -1, 0, 1, max / 2, max - 1];
			const bytes = new Uint8Array(codes.length * bits / 8);
			codes.forEach((code, i) => writeInteger(bytes, i, signed ? code : code + max, bits, littleEndian));

			const values = await decode(codec, bytes);
			expect(values, codec).toEqual(codes.map(code => Math.fround(code / max)));
		}
	});

	test('decodes float PCM unchanged, out-of-range values included', async () => {
		const values = [-2, -1, -0.3, -1.4e-45, 0, 1.4e-45, 0.3, 1, 2];
		for (const [codec, size, littleEndian] of [
			['pcm-f32', 4, true], ['pcm-f32be', 4, false], ['pcm-f64', 8, true], ['pcm-f64be', 8, false],
		] as const) {
			const bytes = new Uint8Array(values.length * size);
			const view = new DataView(bytes.buffer);
			values.forEach((value, i) => {
				if (size === 4) {
					view.setFloat32(4 * i, value, littleEndian);
				} else {
					view.setFloat64(8 * i, value, littleEndian);
				}
			});

			expect(await decode(codec, bytes), codec).toEqual(values.map(Math.fround));
		}
	});
});

describe('@mediabunny/server pixel conversion', () => {
	// Not I420AP12, which FFmpeg has no pixel format for
	const FORMATS = [
		'I420', 'I420A', 'I422', 'I422A', 'I444', 'I444A', 'NV12',
		'I420P10', 'I420AP10', 'I422P10', 'I422AP10', 'I444P10', 'I444AP10',
		'I420P12', 'I422P12', 'I422AP12', 'I444P12', 'I444AP12',
	];
	const MATRICES: [MatrixName, VideoColorPrimaries, VideoTransferCharacteristics][] = [
		['bt709', 'bt709', 'bt709'],
		['smpte170m', 'smpte170m', 'smpte170m'],
		['bt470bg', 'bt470bg', 'smpte170m'],
		['bt2020-ncl', 'bt2020' as VideoColorPrimaries, 'bt709'],
	];
	const PATCH = 8;
	const COLUMNS = 13;

	// 8-bit code values across the whole range, including colors outside the RGB cube that must clip
	const TRIPLETS: [number, number, number][] = [];
	for (const y of [16, 60, 126, 180, 235]) {
		for (const u of [16, 72, 128, 184, 240]) {
			for (const v of [16, 72, 128, 184, 240]) {
				TRIPLETS.push([y, u, v]);
			}
		}
	}

	test('converts every YUV format to RGB within 3 LSB of the H.273 equations', async () => {
		// libswscale's bilinear path (what toRgbSample uses) rounds slightly differently from the exact math: up to 3
		// LSB, and about -1 LSB on average for NV12, 4:2:2 and high bit depth formats in limited range
		const width = COLUMNS * PATCH;
		const height = Math.ceil(TRIPLETS.length / COLUMNS) * PATCH;

		for (const format of FORMATS) {
			const { bitDepth } = yuvFormatInfo(format);
			const scale = 2 ** (bitDepth - 8);
			const valuesAt = (x: number, y: number) => {
				const [yy, u, v] = TRIPLETS[Math.floor(y / PATCH) * COLUMNS + Math.floor(x / PATCH)] ?? [128, 128, 128];
				return [yy * scale, u * scale, v * scale, 2 ** bitDepth - 1] as const;
			};
			const { data, layout } = buildYuvFrame(format, width, height, valuesAt);

			for (const [matrix, primaries, transfer] of MATRICES) {
				for (const fullRange of [false, true]) {
					using source = new VideoSample(data, {
						format: format as VideoPixelFormat,
						codedWidth: width,
						codedHeight: height,
						timestamp: 0,
						layout,
						colorSpace: { matrix: matrix as VideoMatrixCoefficients, primaries, transfer, fullRange },
					});
					const frame = new NodeAv.Frame();
					frame.alloc();
					await toAvFrame(source, frame);
					using sample = new VideoSample(new AvFrameVideoSampleResource(frame), { timestamp: 0 });

					const rgba = new Uint8Array(width * height * 4);
					await sample.copyTo(rgba, { format: 'RGBA' });

					const errors = createErrorAccumulator();
					for (let i = 0; i < TRIPLETS.length; i++) {
						const x = (i % COLUMNS) * PATCH + PATCH / 2;
						const y = Math.floor(i / COLUMNS) * PATCH + PATCH / 2;
						const [yy, u, v] = valuesAt(x, y);
						const expected = yuvToRgb(yy, u, v, matrix, fullRange, bitDepth).map(to8Bit);
						const offset = (y * width + x) * 4;
						errors.add([rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!], expected);
					}

					const { maxAbs, meanSigned } = errors.result();
					const message = `${format} ${matrix} ${fullRange ? 'full' : 'limited'}: max error ${maxAbs}, `
						+ `mean errors ${meanSigned.map(x => x.toFixed(2)).join('/')}`;
					expect(maxAbs, message).toBeLessThanOrEqual(3);
					for (const mean of meanSigned) {
						expect(Math.abs(mean), message).toBeLessThan(1.5);
					}
				}
			}
		}
	});
});
