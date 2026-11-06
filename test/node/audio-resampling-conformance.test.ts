import { describe, expect, test } from 'vitest';
import { AudioResampler } from '../../src/resample.js';
import { AudioSample } from '../../src/sample.js';
import { fromAlaw, fromUlaw, toAlaw, toUlaw } from '../../src/pcm.js';

// ===== G.711 =====

// Independent reference: the classic Sun Microsystems g711.c (used by the ITU-T G.191 software tools), transcribed
const SEG_UEND = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];
const SEG_AEND = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
const search = (value: number, table: number[]) => {
	for (let i = 0; i < table.length; i++) {
		if (value <= table[i]!) {
			return i;
		}
	}
	return table.length;
};

const referenceLinearToAlaw = (pcm: number) => {
	let value = pcm >> 3;
	let mask: number;
	if (value >= 0) {
		mask = 0xd5;
	} else {
		mask = 0x55;
		value = -value - 1;
	}
	const segment = search(value, SEG_AEND);
	if (segment >= 8) {
		return 0x7f ^ mask;
	}
	let alaw = segment << 4;
	alaw |= segment < 2 ? (value >> 1) & 0xf : (value >> segment) & 0xf;
	return alaw ^ mask;
};

const referenceAlawToLinear = (alaw: number) => {
	const value = alaw ^ 0x55;
	let t = (value & 0xf) << 4;
	const segment = (value & 0x70) >> 4;
	if (segment === 0) {
		t += 8;
	} else if (segment === 1) {
		t += 0x108;
	} else {
		t += 0x108;
		t <<= segment - 1;
	}
	return value & 0x80 ? t : -t;
};

const referenceLinearToUlaw = (pcm: number) => {
	let value = pcm >> 2;
	let mask: number;
	if (value < 0) {
		value = -value;
		mask = 0x7f;
	} else {
		mask = 0xff;
	}
	if (value > 8159) {
		value = 8159;
	}
	value += 0x84 >> 2;
	const segment = search(value, SEG_UEND);
	if (segment >= 8) {
		return 0x7f ^ mask;
	}
	return ((segment << 4) | ((value >> (segment + 1)) & 0xf)) ^ mask;
};

const referenceUlawToLinear = (ulaw: number) => {
	const value = ~ulaw & 0xff;
	let t = ((value & 0xf) << 3) + 0x84;
	t <<= (value & 0x70) >> 4;
	return value & 0x80 ? 0x84 - t : t - 0x84;
};

describe('G.711 conversions (pcm.ts)', () => {
	test('decode every µ-law code like the ITU-T G.191 reference', () => {
		for (let code = 0; code < 256; code++) {
			expect([code, fromUlaw(code)]).toEqual([code, referenceUlawToLinear(code)]);
		}
	});

	test('decode every A-law code like the ITU-T G.191 reference', () => {
		for (let code = 0; code < 256; code++) {
			expect([code, fromAlaw(code)]).toEqual([code, referenceAlawToLinear(code)]);
		}
	});

	test('encode every 16-bit value to µ-law like the ITU-T G.191 reference', () => {
		const mismatches: number[] = [];
		for (let value = -32768; value < 32768; value++) {
			if (toUlaw(value) !== referenceLinearToUlaw(value)) {
				mismatches.push(value);
			}
		}
		expect(mismatches).toEqual([]);
	});

	test('encode every 16-bit value to A-law like the ITU-T G.191 reference', () => {
		const mismatches: number[] = [];
		for (let value = -32768; value < 32768; value++) {
			if (toAlaw(value) !== referenceLinearToAlaw(value)) {
				mismatches.push(value);
			}
		}
		expect(mismatches).toEqual([]);
	});

	test('map codes to the right signs and extremes (G.711 Tables 1a/2a)', () => {
		// µ-law: 0xFF and 0x7F are the two zeros, 0x80 is the most positive and 0x00 the most negative value
		expect([fromUlaw(0xff), fromUlaw(0x7f), fromUlaw(0x80), fromUlaw(0x00)]).toEqual([0, 0, 32124, -32124]);
		// A-law: even bits are inverted (0x55), and a set sign bit means positive
		expect([fromAlaw(0xd5), fromAlaw(0x55), fromAlaw(0xaa), fromAlaw(0x2a)]).toEqual([8, -8, 32256, -32256]);
		expect([toUlaw(0), toUlaw(32767), toUlaw(-32768)]).toEqual([0xff, 0x80, 0x00]);
		expect([toAlaw(0), toAlaw(32767), toAlaw(-32768)]).toEqual([0xd5, 0xaa, 0x2a]);
	});

	test('round-trip every code through decode and re-encode', () => {
		for (let code = 0; code < 256; code++) {
			// 0x7F decodes to 0, the same as 0xFF, which is the canonical µ-law zero
			expect(toUlaw(fromUlaw(code))).toBe(code === 0x7f ? 0xff : code);
			expect(toAlaw(fromAlaw(code))).toBe(code);
		}
	});
});

// ===== Resampling =====

type ResampleRun = {
	sourceRate: number;
	targetRate: number;
	sourceChannels?: number;
	targetChannels?: number;
	totalFrames: number;
	chunkFrames: number | number[];
	signal?: (frame: number, channel: number) => number;
	startTimestamp?: number;
	roundTimestampsToMicroseconds?: boolean;
};

const resample = async (run: ResampleRun) => {
	const sourceChannels = run.sourceChannels ?? 1;
	const targetChannels = run.targetChannels ?? 1;
	const signal = run.signal ?? (() => 0.5);
	const outputs: { timestamp: number; data: Float32Array; frames: number }[] = [];
	const resampler = new AudioResampler({
		targetSampleRate: run.targetRate,
		targetNumberOfChannels: targetChannels,
		onSample: async (sample) => {
			const data = new Float32Array(sample.numberOfFrames * targetChannels);
			sample.copyTo(data, { planeIndex: 0, format: 'f32' });
			outputs.push({ timestamp: sample.timestamp, data, frames: sample.numberOfFrames });
			expect(sample.sampleRate).toBe(run.targetRate);
			expect(sample.numberOfChannels).toBe(targetChannels);
			sample.close();
		},
	});

	let position = 0;
	let chunkIndex = 0;
	while (position < run.totalFrames) {
		const requested = Array.isArray(run.chunkFrames)
			? run.chunkFrames[chunkIndex++ % run.chunkFrames.length]!
			: run.chunkFrames;
		const frames = Math.min(requested, run.totalFrames - position);
		const data = new Float32Array(frames * sourceChannels);
		for (let i = 0; i < frames; i++) {
			for (let channel = 0; channel < sourceChannels; channel++) {
				data[i * sourceChannels + channel] = signal(position + i, channel);
			}
		}
		let timestamp = (run.startTimestamp ?? 0) + position / run.sourceRate;
		if (run.roundTimestampsToMicroseconds) {
			timestamp = Math.round(timestamp * 1e6) / 1e6;
		}
		const sample = new AudioSample({
			format: 'f32',
			sampleRate: run.sourceRate,
			numberOfChannels: sourceChannels,
			timestamp,
			data,
		});
		await resampler.add(sample);
		sample.close();
		position += frames;
	}
	await resampler.finalize();

	const totalFrames = outputs.reduce((sum, output) => sum + output.frames, 0);
	const samples = new Float32Array(totalFrames * targetChannels);
	let offset = 0;
	for (const output of outputs) {
		samples.set(output.data, offset);
		offset += output.data.length;
	}
	return { outputs, samples, totalFrames };
};

const RATE_PAIRS: [number, number][] = [
	[44100, 48000], [48000, 44100], [8000, 48000], [48000, 8000], [22050, 44100], [44100, 22050],
	[32000, 48000], [11025, 48000], [96000, 44100], [16000, 44100], [7350, 48000], [192000, 8000],
];

// The checks below hold for any correct resampler (they don't pin an interpolation method). Output near the start
// and the end of the stream may be shaped by how the edges are handled, so values are only checked away from them;
// 20 ms is far more than any practical filter kernel spans.
const EDGE_SECONDS = 0.02;

type ResampleOutput = Awaited<ReturnType<typeof resample>>;

/** Checks that the output samples follow each other without gaps or overlaps, starting at the given timestamp. */
const expectContiguousOutput = (result: ResampleOutput, targetRate: number, startTimestamp: number) => {
	expect(result.outputs.length).toBeGreaterThan(0);
	let expectedTimestamp = startTimestamp;
	for (const output of result.outputs) {
		expect(output.timestamp).toBeCloseTo(expectedTimestamp, 6);
		expectedTimestamp += output.frames / targetRate;
	}
};

/** The largest deviation from the expected values, ignoring the frames near the start and the end. */
const maxDeviationAwayFromEdges = (
	samples: Float32Array,
	channels: number,
	targetRate: number,
	expected: (frame: number) => number,
) => {
	const frames = samples.length / channels;
	const edgeFrames = Math.ceil(EDGE_SECONDS * targetRate);
	let worst = 0;
	for (let frame = edgeFrames; frame < frames - edgeFrames; frame++) {
		for (let channel = 0; channel < channels; channel++) {
			worst = Math.max(worst, Math.abs(samples[frame * channels + channel]! - expected(frame)));
		}
	}
	return worst;
};

describe('AudioResampler (resample.ts)', () => {
	test.each(RATE_PAIRS)('keeps length, timing and low frequencies for any chunking (%i -> %i)', async (
		sourceRate,
		targetRate,
	) => {
		// A low-frequency sine (0.01 radians per source frame, at most ~300 Hz here), well below either Nyquist
		// frequency, so resampling it must reproduce the same sine at the output times
		const amplitude = 0.8;
		const signal = (frame: number) => amplitude * Math.sin(frame * 0.01);
		const totalFrames = Math.floor(sourceRate * 0.7) + 7;

		const results: ResampleOutput[] = [];
		for (const chunkFrames of [totalFrames, 1152, 7, [1000, 333, 4096, 17]]) {
			results.push(await resample({
				sourceRate,
				targetRate,
				totalFrames,
				chunkFrames,
				signal,
				roundTimestampsToMicroseconds: true, // Like AudioData's microsecond timestamps
			}));
		}

		// The output lasts as long as the input, give or take a frame, and the timing doesn't drift
		const [reference] = results;
		expect(Math.abs(reference!.totalFrames - totalFrames * targetRate / sourceRate)).toBeLessThanOrEqual(1);
		expectContiguousOutput(reference!, targetRate, 0);

		// How the input is chunked doesn't matter
		for (const result of results.slice(1)) {
			expect(result.totalFrames).toBe(reference!.totalFrames);
			let worst = 0;
			for (let i = 0; i < reference!.samples.length; i++) {
				worst = Math.max(worst, Math.abs(result.samples[i]! - reference!.samples[i]!));
			}
			expect(worst).toBeLessThan(1e-5);
		}

		// The sine comes out with the same amplitude and phase. Being off by one source frame in timing would give
		// errors of up to 0.01 * amplitude.
		const deviation = maxDeviationAwayFromEdges(
			reference!.samples,
			1,
			targetRate,
			frame => signal(frame * sourceRate / targetRate),
		);
		expect(deviation).toBeLessThan(0.001 * amplitude);
	});

	test.each([
		[48000, 8000, 6000],
		[44100, 22050, 15000],
		[96000, 44100, 30000],
	])('doesn\'t amplify a tone above the target Nyquist frequency (%i -> %i, %i Hz)', async (
		sourceRate,
		targetRate,
		frequency,
	) => {
		const amplitude = 0.8;
		const { samples } = await resample({
			sourceRate,
			targetRate,
			totalFrames: sourceRate,
			chunkFrames: 4096,
			signal: frame => amplitude * Math.sin(2 * Math.PI * frequency * frame / sourceRate),
		});

		// Such a tone can't be represented at the target rate. A resampler may attenuate it (low-pass filtering) or
		// alias it, but must not make it louder.
		const edgeFrames = Math.ceil(EDGE_SECONDS * targetRate);
		let sumOfSquares = 0;
		for (let i = edgeFrames; i < samples.length - edgeFrames; i++) {
			sumOfSquares += samples[i]! ** 2;
		}
		const rms = Math.sqrt(sumOfSquares / (samples.length - 2 * edgeFrames));
		expect(rms).toBeLessThanOrEqual(1.05 * amplitude / Math.SQRT2);
	});

	test('keeps a constant signal constant over output buffer boundaries and long chunks', async () => {
		const result = await resample({
			sourceRate: 44100,
			targetRate: 48000,
			sourceChannels: 2,
			targetChannels: 2,
			totalFrames: 44100 * 12 + 5,
			chunkFrames: 44100 * 7, // Longer than the five seconds the resampler buffers
			signal: () => 0.25,
		});
		expectContiguousOutput(result, 48000, 0);
		expect(Math.abs(result.totalFrames - (44100 * 12 + 5) * 48000 / 44100)).toBeLessThanOrEqual(1);
		expect(maxDeviationAwayFromEdges(result.samples, 2, 48000, () => 0.25)).toBeLessThan(0.25 * 0.005);
	});

	test('stamps the output relative to the first input timestamp', async () => {
		const result = await resample({
			sourceRate: 22050,
			targetRate: 48000,
			totalFrames: 22050 * 6,
			chunkFrames: 1024,
			startTimestamp: 12.5,
		});
		expectContiguousOutput(result, 48000, 12.5);
		expect(Math.abs(result.totalFrames - 48000 * 6)).toBeLessThanOrEqual(1);
	});

	test('fills a gap between input samples with silence', async () => {
		const outputs: { timestamp: number; data: Float32Array }[] = [];
		const resampler = new AudioResampler({
			targetSampleRate: 48000,
			targetNumberOfChannels: 1,
			onSample: async (sample) => {
				const data = new Float32Array(sample.numberOfFrames);
				sample.copyTo(data, { planeIndex: 0, format: 'f32' });
				outputs.push({ timestamp: sample.timestamp, data });
				sample.close();
			},
		});
		// 0.1 s of a constant at 0, 0.1 and 0.3 s, leaving a 0.1 s gap
		for (const timestamp of [0, 0.1, 0.3]) {
			const sample = new AudioSample({
				format: 'f32',
				sampleRate: 44100,
				numberOfChannels: 1,
				timestamp,
				data: new Float32Array(4410).fill(0.5),
			});
			await resampler.add(sample);
			sample.close();
		}
		await resampler.finalize();

		expect(outputs.map(x => x.timestamp)).toEqual([0]);
		const data = outputs[0]!.data;
		expect(Math.abs(data.length - 4800 * 4)).toBeLessThanOrEqual(1);

		// Away from the transitions (by 20 ms), there's the signal, then silence, then the signal again
		const margin = EDGE_SECONDS * 48000;
		const maxDeviation = (from: number, to: number, value: number) => {
			let worst = 0;
			for (let i = from + margin; i < to - margin; i++) {
				worst = Math.max(worst, Math.abs(data[i]! - value));
			}
			return worst;
		};
		expect(maxDeviation(0, 9600, 0.5)).toBeLessThan(0.5 * 0.005);
		expect(maxDeviation(9600, 14400, 0)).toBeLessThan(0.5 * 0.005);
		expect(maxDeviation(14400, 19200, 0.5)).toBeLessThan(0.5 * 0.005);
	});

	const mixOnce = async (sourceChannels: number, targetChannels: number, values: number[]) => {
		const { samples } = await resample({
			sourceRate: 48000,
			targetRate: 48000,
			sourceChannels,
			targetChannels,
			totalFrames: 4800,
			chunkFrames: 1000,
			signal: (frame, channel) => values[channel]!,
		});
		return [...samples.subarray(2400 * targetChannels, 2401 * targetChannels)];
	};

	const h = Math.SQRT1_2;
	const L = 0.1;
	const R = 0.2;
	const C = 0.3;
	const LFE = 0.4;
	const SL = 0.05;
	const SR = 0.06;

	// The "speakers" up-mixing and down-mixing rules of the Web Audio API (section "Channel up-mixing and
	// down-mixing"), for mono, stereo, quad (L R SL SR) and 5.1 (L R C LFE SL SR)
	test.each([
		[1, 2, [C], [C, C]],
		[1, 4, [C], [C, C, 0, 0]],
		[1, 6, [C], [0, 0, C, 0, 0, 0]],
		[2, 1, [L, R], [0.5 * (L + R)]],
		[2, 4, [L, R], [L, R, 0, 0]],
		[2, 6, [L, R], [L, R, 0, 0, 0, 0]],
		[4, 1, [L, R, SL, SR], [0.25 * (L + R + SL + SR)]],
		[4, 2, [L, R, SL, SR], [0.5 * (L + SL), 0.5 * (R + SR)]],
		[4, 6, [L, R, SL, SR], [L, R, 0, 0, SL, SR]],
		[6, 1, [L, R, C, LFE, SL, SR], [h * (L + R) + C + 0.5 * (SL + SR)]],
		[6, 2, [L, R, C, LFE, SL, SR], [L + h * (C + SL), R + h * (C + SR)]],
		[6, 4, [L, R, C, LFE, SL, SR], [L + h * C, R + h * C, SL, SR]],
		// Other layouts fall back to discrete mapping
		[3, 2, [L, R, C], [L, R]],
		[2, 3, [L, R], [L, R, 0]],
		[5, 2, [L, R, C, SL, SR], [L, R]],
		[1, 3, [C], [C, 0, 0]],
	])('mixes %i channels into %i like the Web Audio API', async (from, to, values, expected) => {
		const actual = await mixOnce(from, to, values);
		expect(actual).toHaveLength(expected.length);
		actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 6));
	});

	test('passes samples through unchanged when only the channel count changes', async () => {
		const signal = (frame: number, channel: number) => Math.sin(frame * 0.1 + channel);
		const { samples } = await resample({
			sourceRate: 44100,
			targetRate: 44100,
			sourceChannels: 1,
			targetChannels: 2,
			totalFrames: 5000,
			chunkFrames: 999,
			signal,
		});
		for (let i = 0; i < 5000; i++) {
			expect(samples[2 * i]).toBe(Math.fround(signal(i, 0)));
			expect(samples[2 * i + 1]).toBe(Math.fround(signal(i, 0)));
		}
	});
});
