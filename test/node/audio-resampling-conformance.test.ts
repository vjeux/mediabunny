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

describe('AudioResampler (resample.ts)', () => {
	test.each(RATE_PAIRS)('outputs ceil(N * %i / %i) frames in any chunking', async (sourceRate, targetRate) => {
		const totalFrames = Math.floor(sourceRate * 1.3) + 7;
		for (const chunkFrames of [1024, 1152, 7, [1000, 333, 4096, 17]]) {
			const { totalFrames: output } = await resample({
				sourceRate,
				targetRate,
				totalFrames,
				chunkFrames,
				roundTimestampsToMicroseconds: true,
			});
			expect(output).toBe(Math.ceil(totalFrames * targetRate / sourceRate - 1e-9));
		}
	});

	test.each(RATE_PAIRS)('interpolates linearly across chunks (%i -> %i)', async (sourceRate, targetRate) => {
		const signal = (frame: number) => 0.8 * Math.sin(frame * 0.01);
		const totalFrames = Math.floor(sourceRate * 0.7);
		const { samples } = await resample({
			sourceRate,
			targetRate,
			totalFrames,
			chunkFrames: [1000, 333, 4096, 17],
			signal,
			roundTimestampsToMicroseconds: true,
		});

		let worst = 0;
		for (let k = 0; k < samples.length; k++) {
			const position = k * sourceRate / targetRate;
			const lower = Math.floor(position);
			const fraction = position - lower;
			const a = lower < totalFrames ? signal(lower) : 0;
			const b = lower + 1 < totalFrames ? signal(lower + 1) : 0;
			worst = Math.max(worst, Math.abs(samples[k]! - (a + fraction * (b - a))));
		}
		expect(worst).toBeLessThan(1e-6);
	});

	test('keeps a constant signal constant over five-second buffer boundaries and long chunks', async () => {
		const { outputs, samples } = await resample({
			sourceRate: 44100,
			targetRate: 48000,
			sourceChannels: 2,
			targetChannels: 2,
			totalFrames: 44100 * 12 + 5,
			chunkFrames: 44100 * 7, // Longer than the internal buffer
			signal: () => 0.25,
		});
		expect(outputs.map(x => x.timestamp)).toEqual([0, 5, 10]);
		expect(outputs.map(x => x.frames)).toEqual([240000, 240000, 96006]);
		// Only the very last frame interpolates toward the silence after the input
		expect(samples.subarray(0, samples.length - 2).every(x => Math.abs(x - 0.25) < 1e-7)).toBe(true);
	});

	test('stamps the output relative to the first input timestamp', async () => {
		const { outputs } = await resample({
			sourceRate: 22050,
			targetRate: 48000,
			totalFrames: 22050 * 6,
			chunkFrames: 1024,
			startTimestamp: 12.5,
		});
		expect(outputs.map(x => x.timestamp)).toEqual([12.5, 17.5]);
		expect(outputs.map(x => x.frames)).toEqual([240000, 48000]);
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
		for (const timestamp of [0, 0.1, 0.3]) {
			const sample = new AudioSample({
				format: 'f32',
				sampleRate: 48000,
				numberOfChannels: 1,
				timestamp,
				data: new Float32Array(4800).fill(0.5),
			});
			await resampler.add(sample);
			sample.close();
		}
		await resampler.finalize();

		const data = outputs[0]!.data;
		expect(data.length).toBe(4800 * 4);
		expect(data.subarray(0, 9600).every(x => x === 0.5)).toBe(true);
		expect(data.subarray(9600, 14400).every(x => x === 0)).toBe(true);
		expect(data.subarray(14400).every(x => x === 0.5)).toBe(true);
	});

	const mixOnce = async (sourceChannels: number, targetChannels: number, values: number[]) => {
		const { samples } = await resample({
			sourceRate: 48000,
			targetRate: 48000,
			sourceChannels,
			targetChannels,
			totalFrames: 50,
			chunkFrames: 50,
			signal: (frame, channel) => values[channel]!,
		});
		return [...samples.subarray(10 * targetChannels, 11 * targetChannels)];
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
