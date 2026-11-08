import { describe, expect, test } from 'vitest';
import { AudioSample, AudioSampleResource } from '../../src/sample.js';

type Format = 'u8' | 's16' | 's32' | 'f32' | 'u8-planar' | 's16-planar' | 's32-planar' | 'f32-planar';
const FORMATS: Format[] = ['u8', 's16', 's32', 'f32', 'u8-planar', 's16-planar', 's32-planar', 'f32-planar'];
const ARRAYS = { u8: Uint8Array, s16: Int16Array, s32: Int32Array, f32: Float32Array };
type SampleType = keyof typeof ARRAYS;
const sampleType = (format: Format) => format.replace('-planar', '') as SampleType;
const isPlanar = (format: Format) => format.endsWith('-planar');

/** Builds raw sample data where sample (frame f, channel c) is value(f, c), arranged as the format requires. */
const buildData = (format: Format, frames: number, channels: number, value: (f: number, c: number) => number) => {
	const data = new ARRAYS[sampleType(format)](frames * channels);
	for (let f = 0; f < frames; f++) {
		for (let c = 0; c < channels; c++) {
			data[isPlanar(format) ? c * frames + f : f * channels + c] = value(f, c);
		}
	}

	return data;
};

const makeSample = (
	format: Format,
	frames: number,
	channels: number,
	value: (f: number, c: number) => number,
	timestamp = 0,
	sampleRate = 48000,
) => new AudioSample({
	data: buildData(format, frames, channels, value),
	format,
	numberOfChannels: channels,
	sampleRate,
	timestamp,
});

type CopyOptions = { planeIndex: number; format: Format; frameOffset?: number; frameCount?: number };
const copyOut = (sample: AudioSample, options: CopyOptions) => {
	const size = sample.allocationSize(options);
	const out = new ARRAYS[sampleType(options.format)](size / ARRAYS[sampleType(options.format)].BYTES_PER_ELEMENT);
	sample.copyTo(out, options);
	return [...out];
};

// An integer-valued signal that fits every sample type exactly
const signal = (f: number, c: number) => f * 10 + c;

describe('AudioSample: construction from raw data', () => {
	test('derives the frame count and duration from the data size', () => {
		for (const format of FORMATS) {
			for (const channels of [1, 2, 6, 12]) {
				using sample = makeSample(format, 441, channels, signal, 1.5, 44100);
				expect(sample.format).toBe(format);
				expect(sample.numberOfFrames).toBe(441);
				expect(sample.numberOfChannels).toBe(channels);
				expect(sample.sampleRate).toBe(44100);
				expect(sample.duration).toBe(0.01);
				expect(sample.timestamp).toBe(1.5);
				expect(sample.microsecondTimestamp).toBe(1500000);
				expect(sample.microsecondDuration).toBe(10000);
			}
		}
	});

	test('reads its data from ArrayBuffers and views into larger buffers', () => {
		const backing = new Int16Array([99, 1, 2, 3, 4, 99]);
		for (const data of [backing.subarray(1, 5), new DataView(backing.buffer, 2, 8), backing.slice(1, 5).buffer]) {
			using sample = new AudioSample({
				data, format: 's16', numberOfChannels: 2, sampleRate: 8000, timestamp: 0,
			});
			expect(sample.numberOfFrames).toBe(2);
			expect(copyOut(sample, { planeIndex: 0, format: 's16' })).toEqual([1, 2, 3, 4]);
		}
	});

	test('allows negative timestamps and fractional sample rates', () => {
		using sample = makeSample('f32', 4, 1, signal, -0.5, 22050.5);
		expect(sample.timestamp).toBe(-0.5);
		expect(sample.microsecondTimestamp).toBe(-500000);
		expect(sample.duration).toBe(4 / 22050.5);
	});

	test('rejects invalid init', () => {
		const valid = {
			data: new Float32Array(8), format: 'f32', numberOfChannels: 2, sampleRate: 48000, timestamp: 0,
		};
		for (const override of [
			{ format: 'f64' },
			{ format: undefined },
			{ sampleRate: 0 },
			{ sampleRate: -8000 },
			{ sampleRate: NaN },
			{ numberOfChannels: 0 },
			{ numberOfChannels: 1.5 },
			{ timestamp: NaN },
			{ timestamp: undefined },
			{ data: new Float32Array(7) }, // Not a whole number of frames
			{ data: new Uint8Array(6) },
		]) {
			expect(() => new AudioSample({ ...valid, ...override } as never), JSON.stringify(override))
				.toThrow(TypeError);
		}
		expect(() => new AudioSample(null as never)).toThrow(TypeError);
	});
});

// Ported from WPT webcodecs/audio-data-copyTo.any.js, audio-data-copyto-offset.any.js and
// audio-data-copyto-oversized.any.js, plus the rules of the spec's "Compute Copy Element Count" algorithm
describe('AudioSample: allocationSize and copyTo', () => {
	test('copies frameCount frames from frameOffset into a smaller destination view', () => {
		const pairs = [
			['f32', 'f32'],
			['f32', 'f32-planar'],
			['f32-planar', 'f32-planar'],
			['f32-planar', 'f32'],
		] as const;
		for (const [from, to] of pairs) {
			using sample = new AudioSample({
				data: new Float32Array([1, 2, 3, 4, 5]),
				format: from,
				numberOfChannels: 1,
				sampleRate: 48000,
				timestamp: 0,
			});
			const output = new Float32Array(5);
			sample.copyTo(output.subarray(1, 4), { planeIndex: 0, frameOffset: 1, frameCount: 3, format: to });
			expect([...output], `${from} -> ${to}`).toEqual([0, 2, 3, 4, 0]);
		}

		using planar = new AudioSample({
			data: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
			format: 'f32-planar',
			numberOfChannels: 2,
			sampleRate: 48000,
			timestamp: 0,
		});
		const output = new Float32Array(10);
		planar.copyTo(output.subarray(1, 4), { planeIndex: 0, frameOffset: 1, frameCount: 3 });
		planar.copyTo(output.subarray(6, 9), { planeIndex: 1, frameOffset: 1, frameCount: 3 });
		expect([...output]).toEqual([0, 2, 3, 4, 0, 0, 7, 8, 9, 0]);

		using interleaved = new AudioSample({
			data: new Float32Array([1, 6, 2, 7, 3, 8, 4, 9, 5, 10]),
			format: 'f32',
			numberOfChannels: 2,
			sampleRate: 48000,
			timestamp: 0,
		});
		const output2 = new Float32Array(10);
		interleaved.copyTo(output2.subarray(2, 8), { planeIndex: 0, frameOffset: 1, frameCount: 3, format: 'f32' });
		expect([...output2]).toEqual([0, 0, 2, 7, 3, 8, 4, 9, 0, 0]);
	});

	test('rearranges frames between planar and interleaved formats', () => {
		for (const from of FORMATS) {
			for (const channels of [1, 2, 3, 12]) {
				using sample = makeSample(from, 9, channels, signal);
				const type = sampleType(from);

				const interleaved = copyOut(sample, { planeIndex: 0, format: type, frameOffset: 2, frameCount: 5 });
				expect(interleaved).toEqual([...buildData(type, 5, channels, (f, c) => signal(f + 2, c))]);

				for (let c = 0; c < channels; c++) {
					const plane = copyOut(sample, { planeIndex: c, format: `${type}-planar`, frameOffset: 4 });
					expect(plane).toEqual([4, 5, 6, 7, 8].map(f => signal(f, c)));
				}
			}
		}
	});

	test('computes allocation sizes from the destination format', () => {
		using sample = makeSample('s16-planar', 10, 3, signal);
		const bytes = { u8: 1, s16: 2, s32: 4, f32: 4 };
		for (const format of FORMATS) {
			const perSample = bytes[sampleType(format)];
			const channels = isPlanar(format) ? 1 : 3;
			expect(sample.allocationSize({ planeIndex: 0, format })).toBe(10 * channels * perSample);
			expect(sample.allocationSize({ planeIndex: 0, format, frameOffset: 7 })).toBe(3 * channels * perSample);
			expect(sample.allocationSize({ planeIndex: 0, format, frameOffset: 2, frameCount: 4 }))
				.toBe(4 * channels * perSample);
			expect(sample.allocationSize({ planeIndex: 0, format, frameCount: 0 })).toBe(0);
		}

		// Without a format, the sample's own format is used
		expect(sample.allocationSize({ planeIndex: 2 })).toBe(10 * 2);
	});

	test('enforces the plane index, frame range and destination size rules', () => {
		using interleaved = makeSample('f32', 5, 2, signal);
		using planar = makeSample('f32-planar', 5, 2, signal);
		const dest = new Float32Array(64);

		for (const sample of [interleaved, planar]) {
			// Interleaved destinations only have plane 0, planar ones have a plane per channel
			expect(() => sample.copyTo(dest, { planeIndex: 1, format: 'f32' })).toThrow(RangeError);
			expect(() => sample.copyTo(dest, { planeIndex: 2, format: 'f32-planar' })).toThrow(RangeError);
			expect(() => sample.allocationSize({ planeIndex: 1, format: 's16' })).toThrow(RangeError);
			expect(() => sample.allocationSize({ planeIndex: 2, format: 'u8-planar' })).toThrow(RangeError);

			// frameOffset must be inside the sample, frameCount must fit after it
			for (const frameOffset of [5, 6]) {
				expect(() => sample.copyTo(dest, { planeIndex: 0, format: 'f32', frameOffset })).toThrow(RangeError);
				expect(() => sample.allocationSize({ planeIndex: 0, format: 'f32', frameOffset })).toThrow(RangeError);
			}
			expect(() => sample.copyTo(dest, { planeIndex: 0, format: 'f32', frameOffset: 2, frameCount: 4 }))
				.toThrow(RangeError);
			expect(() => sample.allocationSize({ planeIndex: 0, format: 'f32', frameCount: 6 })).toThrow(RangeError);

			// The destination must be large enough
			expect(() => sample.copyTo(new Float32Array(9), { planeIndex: 0, format: 'f32' })).toThrow(RangeError);
			expect(() => sample.copyTo(new Float32Array(4), { planeIndex: 0, format: 'f32-planar' }))
				.toThrow(RangeError);

			// Malformed options
			for (const options of [
				null,
				{},
				{ planeIndex: -1 },
				{ planeIndex: 0.5 },
				{ planeIndex: 0, format: 'f64' },
				{ planeIndex: 0, frameOffset: -1 },
				{ planeIndex: 0, frameCount: 1.5 },
			]) {
				expect(() => sample.copyTo(dest, options as never), JSON.stringify(options)).toThrow(TypeError);
				expect(() => sample.allocationSize(options as never), JSON.stringify(options)).toThrow(TypeError);
			}
			expect(() => sample.copyTo([] as never, { planeIndex: 0 })).toThrow(TypeError);
		}
	});

	test('leaves the rest of an oversized destination untouched', () => {
		using sample = makeSample('s16', 4, 2, signal);
		const dest = new Int16Array(12).fill(-7);
		sample.copyTo(dest, { planeIndex: 0, format: 's16', frameOffset: 1 });
		expect([...dest]).toEqual([10, 11, 20, 21, 30, 31, -7, -7, -7, -7, -7, -7]);

		const planarDest = new Float32Array(6).fill(-7);
		sample.copyTo(planarDest, { planeIndex: 1, format: 'f32-planar' });
		expect([...planarDest]).toEqual([1, 11, 21, 31].map(x => x / 32768).concat([-7, -7]));
	});

	test('writes into any kind of destination', () => {
		using sample = makeSample('s16', 2, 1, signal);
		const destinations: AllowSharedBufferSource[] = [
			new ArrayBuffer(4),
			new Uint8Array(4),
			new DataView(new ArrayBuffer(4)),
		];
		if (typeof SharedArrayBuffer !== 'undefined') {
			destinations.push(new SharedArrayBuffer(4));
		}
		for (const destination of destinations) {
			sample.copyTo(destination, { planeIndex: 0 });
			const view = ArrayBuffer.isView(destination)
				? new Int16Array(destination.buffer, destination.byteOffset, 2)
				: new Int16Array(destination);
			expect([...view]).toEqual([0, 10]);
		}
	});
});

describe('AudioSample: sample format conversion', () => {
	// Reference values produced with FFmpeg 7.0.2's libswresample, e.g.
	// ffmpeg -f s16le -ar 8000 -ac 1 -i in.raw -f f32le -c:a pcm_f32le out.raw
	const INPUTS: Record<SampleType, number[]> = {
		s16: [-32768, -16385, -16384, -1, 0, 1, 16383, 16384, 32767],
		f32: [-1.5, -1, -0.75, -0.5, -0.25, -1e-9, 0, 1e-9, 0.25, 0.5, 0.75, 0.99999, 1, 1.5],
		u8: [0, 1, 64, 127, 128, 129, 191, 192, 254, 255],
		s32: [
			-2147483648, -1073741825, -1073741824, -65536, -1, 0, 1, 65535, 65536, 1073741823, 1073741824, 2147483647,
		],
	};
	const FFMPEG: Record<string, number[]> = {
		's16->f32': [
			-1, -0.500030517578125, -0.5, -0.000030517578125, 0, 0.000030517578125, 0.499969482421875, 0.5,
			0.999969482421875,
		],
		's16->s32': [-2147483648, -1073807360, -1073741824, -65536, 0, 65536, 1073676288, 1073741824, 2147418112],
		'f32->s16': [-32768, -32768, -24576, -16384, -8192, 0, 0, 0, 8192, 16384, 24576, 32767, 32767, 32767],
		'f32->u8': [0, 0, 32, 64, 96, 128, 128, 128, 160, 192, 224, 255, 255, 255],
		'f32->s32': [
			-2147483648, -2147483648, -1610612736, -1073741824, -536870912, -2, 0, 2, 536870912, 1073741824, 1610612736,
			2147462144, 2147483647, 2147483647,
		],
		'u8->s16': [-32768, -32512, -16384, -256, 0, 256, 16128, 16384, 32256, 32512],
		'u8->f32': [-1, -0.9921875, -0.5, -0.0078125, 0, 0.0078125, 0.4921875, 0.5, 0.984375, 0.9921875],
		'u8->s32': [
			-2147483648, -2130706432, -1073741824, -16777216, 0, 16777216, 1056964608, 1073741824, 2113929216,
			2130706432,
		],
		's32->f32': [
			-1, -0.5, -0.5, -0.000030517578125, -4.656612873077393e-10, 0, 4.656612873077393e-10,
			0.000030517112463712692, 0.000030517578125, 0.5, 0.5, 1,
		],
		// FFmpeg narrows integers with an arithmetic shift (rounding down)
		's16->u8': [0, 63, 64, 127, 128, 128, 191, 192, 255],
		's32->s16': [-32768, -16385, -16384, -1, -1, 0, 0, 0, 1, 16383, 16384, 32767],
		's32->u8': [0, 63, 64, 127, 127, 128, 128, 128, 128, 191, 192, 255],
	};

	test('converts between integer and float samples exactly like FFmpeg', () => {
		for (const [pair, expected] of Object.entries(FFMPEG)) {
			const [from, to] = pair.split('->') as [SampleType, SampleType];
			if (from !== 'f32' && to !== 'f32' && ARRAYS[to].BYTES_PER_ELEMENT < ARRAYS[from].BYTES_PER_ELEMENT) {
				continue; // Narrowing, see below
			}

			for (const fromFormat of [from, `${from}-planar`] as Format[]) {
				for (const toFormat of [to, `${to}-planar`] as Format[]) {
					using sample = new AudioSample({
						data: ARRAYS[from].from(INPUTS[from]),
						format: fromFormat,
						numberOfChannels: 1,
						sampleRate: 8000,
						timestamp: 0,
					});
					const actual = copyOut(sample, { planeIndex: 0, format: toFormat });
					expect(actual, `${fromFormat} -> ${toFormat}`).toEqual(expected);
				}
			}
		}
	});

	test('narrows integer samples by rounding to nearest, where FFmpeg rounds down', () => {
		for (const pair of ['s16->u8', 's32->s16', 's32->u8']) {
			const [from, to] = pair.split('->') as [SampleType, SampleType];
			using sample = new AudioSample({
				data: ARRAYS[from].from(INPUTS[from]),
				format: from,
				numberOfChannels: 1,
				sampleRate: 8000,
				timestamp: 0,
			});
			const actual = copyOut(sample, { planeIndex: 0, format: to });
			const scale = { u8: 2 ** 7, s16: 2 ** 15, s32: 2 ** 31, f32: 1 };
			const bias = to === 'u8' ? 128 : 0;
			const max = { u8: 255, s16: 32767, s32: 2147483647, f32: 1 }[to];
			const expected = INPUTS[from].map(x => Math.min(max, Math.round(x / scale[from] * scale[to]) + bias));
			expect(actual, pair).toEqual(expected);
			actual.forEach((value, i) => expect(Math.abs(value - FFMPEG[pair]![i]!)).toBeLessThanOrEqual(1));
		}
	});

	test('keeps float samples outside [-1, 1] when staying in float', () => {
		using sample = new AudioSample({
			data: new Float32Array([-3.5, 1.25, 2, -1.0000001]),
			format: 'f32',
			numberOfChannels: 2,
			sampleRate: 48000,
			timestamp: 0,
		});
		expect(copyOut(sample, { planeIndex: 0, format: 'f32' })).toEqual([-3.5, 1.25, 2, Math.fround(-1.0000001)]);
		expect(copyOut(sample, { planeIndex: 1, format: 'f32-planar' })).toEqual([1.25, Math.fround(-1.0000001)]);
		expect(copyOut(sample, { planeIndex: 0, format: 's16' })).toEqual([-32768, 32767, 32767, -32768]);
	});
});

class PlanesAudioResource extends AudioSampleResource {
	closeCount = 0;

	constructor(
		public format: Format,
		public frames: number,
		public channels: number,
		public planes: Uint8Array[],
		public sampleRate = 48000,
		public timestamp = 0,
	) {
		super();
	}

	getFormat() {
		return this.format;
	}

	getSampleRate() {
		return this.sampleRate;
	}

	getNumberOfFrames() {
		return this.frames;
	}

	getNumberOfChannels() {
		return this.channels;
	}

	getTimestamp() {
		return this.timestamp;
	}

	getDataPlane(planeIndex: number) {
		return this.planes[planeIndex]!;
	}

	close() {
		this.closeCount++;
	}
}

describe('AudioSample: custom resources', () => {
	const planesOf = (format: Format, frames: number, channels: number) => {
		const data = new Uint8Array(buildData(format, frames, channels, signal).buffer);
		if (!isPlanar(format)) {
			return [data];
		}

		const planeSize = data.byteLength / channels;
		return Array.from({ length: channels }, (_, c) => data.subarray(c * planeSize, (c + 1) * planeSize));
	};

	test('copies from the resource\'s planes with frame ranges and conversion', () => {
		for (const format of FORMATS) {
			const resource = new PlanesAudioResource(format, 6, 3, planesOf(format, 6, 3), 32000, 2.5);
			using sample = new AudioSample(resource);
			expect([sample.format, sample.numberOfFrames, sample.numberOfChannels, sample.sampleRate])
				.toEqual([format, 6, 3, 32000]);
			expect([sample.timestamp, sample.duration]).toEqual([2.5, 6 / 32000]);

			const type = sampleType(format);
			expect(copyOut(sample, { planeIndex: 0, format: type, frameOffset: 1, frameCount: 4 }))
				.toEqual([...buildData(type, 4, 3, (f, c) => signal(f + 1, c))]);
			expect(copyOut(sample, { planeIndex: 2, format: `${type}-planar`, frameOffset: 3 }))
				.toEqual([3, 4, 5].map(f => signal(f, 2)));

			// Through f32, where the signal maps to signal / scale
			const scale = { u8: 128, s16: 32768, s32: 2 ** 31, f32: 1 }[type];
			const offset = type === 'u8' ? 128 : 0;
			expect(copyOut(sample, { planeIndex: 1, format: 'f32-planar' }))
				.toEqual([0, 1, 2, 3, 4, 5].map(f => Math.fround((signal(f, 1) - offset) / scale)));
		}
	});

	test('rejects planes of the wrong size and invalid metadata', () => {
		using sample = new AudioSample(new PlanesAudioResource('s16', 4, 2, [new Uint8Array(15)]));
		expect(() => sample.copyTo(new Int16Array(8), { planeIndex: 0 })).toThrow(TypeError);

		using notBytes = new AudioSample(new PlanesAudioResource('s16', 4, 2, [new Int16Array(8) as never]));
		expect(() => notBytes.copyTo(new Int16Array(8), { planeIndex: 0 })).toThrow(TypeError);

		for (const override of [
			{ format: 'f64' },
			{ sampleRate: 0 },
			{ sampleRate: 44100.5 },
			{ frames: -1 },
			{ frames: 1.5 },
			{ channels: 0 },
			{ timestamp: Infinity },
		]) {
			const resource = new PlanesAudioResource('s16', 4, 2, []);
			Object.assign(resource, override);
			expect(() => new AudioSample(resource), JSON.stringify(override)).toThrow(TypeError);
		}
	});

	test('closes the resource when the last sample using it is closed', () => {
		const resource = new PlanesAudioResource('f32-planar', 2, 1, planesOf('f32-planar', 2, 1), 48000, 1);
		const sample = new AudioSample(resource);
		sample.setTimestamp(5);
		const clone = sample.clone();
		expect(clone.timestamp).toBe(5);

		sample.close();
		expect(resource.closeCount).toBe(0);
		clone.close();
		clone.close();
		expect(resource.closeCount).toBe(1);
	});
});

describe('AudioSample: clone, trim and close', () => {
	test('clone() keeps data and metadata and outlives the original', () => {
		const sample = makeSample('s32-planar', 5, 2, signal, 3, 16000);
		const clone = sample.clone();
		sample.close();

		expect([clone.format, clone.numberOfFrames, clone.numberOfChannels, clone.sampleRate, clone.timestamp])
			.toEqual(['s32-planar', 5, 2, 16000, 3]);
		expect(copyOut(clone, { planeIndex: 1, format: 's32-planar' })).toEqual([1, 11, 21, 31, 41]);
		clone.close();
	});

	test('trim() keeps the frames in range and shifts the timestamp', () => {
		for (const format of FORMATS) {
			using sample = makeSample(format, 10, 3, signal, 1, 8000);
			using trimmed = sample.trim(2, 7);
			expect([trimmed.format, trimmed.numberOfFrames, trimmed.numberOfChannels, trimmed.sampleRate])
				.toEqual([format, 5, 3, 8000]);
			expect(trimmed.timestamp).toBe(1 + 2 / 8000);
			expect(copyOut(trimmed, { planeIndex: 0, format: sampleType(format) }))
				.toEqual([...buildData(sampleType(format), 5, 3, (f, c) => signal(f + 2, c))]);

			// The end defaults to the end of the sample
			using tail = sample.trim(8);
			const planarFormat = `${sampleType(format)}-planar` as Format;
			expect(copyOut(tail, { planeIndex: 1, format: planarFormat })).toEqual([81, 91]);
		}
	});

	test('close() is idempotent and makes data access throw', () => {
		const sample = makeSample('f32', 4, 2, signal);
		sample.close();
		sample.close();
		sample[Symbol.dispose]();

		expect(() => sample.allocationSize({ planeIndex: 0 })).toThrow('AudioSample is closed.');
		expect(() => sample.copyTo(new Float32Array(8), { planeIndex: 0 })).toThrow('AudioSample is closed.');
		expect(() => sample.clone()).toThrow('AudioSample is closed.');
		expect(() => sample.trim(0, 1)).toThrow('AudioSample is closed.');
		expect(() => sample.toAudioData()).toThrow('AudioSample is closed.');
		expect(() => sample.toAudioBuffer()).toThrow('AudioSample is closed.');
		expect(sample.numberOfFrames).toBe(4);
	});

	test('validates setTimestamp()', () => {
		using sample = makeSample('u8', 1, 1, () => 128);
		expect(() => sample.setTimestamp(NaN)).toThrow(TypeError);
		sample.setTimestamp(-3);
		expect(sample.timestamp).toBe(-3);
		expect(sample.microsecondTimestamp).toBe(-3000000);
	});
});
