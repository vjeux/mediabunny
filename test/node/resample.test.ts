import { expect, test } from 'vitest';
import { AudioResampler } from '../../src/resample.js';
import { AudioSample } from '../../src/sample.js';

test('Output buffer boundary with fractional chunk endpoint', async () => {
	const output: number[] = [];
	const outputLengths: number[] = [];
	const resampler = new AudioResampler({
		targetSampleRate: 12,
		targetNumberOfChannels: 1,
		onSample: async (sample) => {
			const data = new Float32Array(sample.numberOfFrames);
			sample.copyTo(data, { planeIndex: 0, format: 'f32' });
			output.push(...data);
			outputLengths.push(sample.numberOfFrames);
			sample.close();
		},
	});

	// At 5 Hz in and 12 Hz out, the second chunk ends at output frame 62.4, past the end of the first buffer
	const samples = [
		{ frames: 1, timestamp: 0 },
		{ frames: 25, timestamp: 1 / 5 },
		{ frames: 4, timestamp: 26 / 5 },
	].map(({ frames, timestamp }) => new AudioSample({
		format: 'f32',
		sampleRate: 5,
		numberOfChannels: 1,
		timestamp,
		data: new Float32Array(frames).fill(0.75),
	}));

	for (const sample of samples) {
		await resampler.add(sample);
		sample.close();
	}
	await resampler.finalize();

	expect(outputLengths).toEqual([60, 12]);
	expect(output.slice(58, 63)).toEqual([0.75, 0.75, 0.75, 0.75, 0.75]);
});

test('Exact output frame count across chunks', async () => {
	let outputFrames = 0;
	const resampler = new AudioResampler({
		targetSampleRate: 48000,
		targetNumberOfChannels: 1,
		onSample: async (sample) => {
			outputFrames += sample.numberOfFrames;
			sample.close();
		},
	});

	// The last chunk's end lands exactly on an output frame, which plain float time math overshoots
	for (let i = 0; i < 343; i++) {
		const sample = new AudioSample({
			format: 'f32',
			sampleRate: 22050,
			numberOfChannels: 1,
			timestamp: 1152 * i / 22050,
			data: new Float32Array(1152).fill(0.5),
		});
		await resampler.add(sample);
		sample.close();
	}
	await resampler.finalize();

	expect(outputFrames).toBe(343 * 1152 * 48000 / 22050);
});

test('Downmixing 7.1 folds the center and surround channels in', async () => {
	// L, R, C, LFE, BL, BR, SL, SR (WAVE / FFmpeg / Chromium 7.1 order)
	const [L, R, C, LFE, BL, BR, SL, SR] = [0.1, 0.2, 0.3, 0.4, 0.05, 0.06, 0.07, 0.08];

	const downmix = async (targetNumberOfChannels: number) => {
		let frame: number[] = [];
		const resampler = new AudioResampler({
			targetSampleRate: 48000,
			targetNumberOfChannels,
			onSample: async (sample) => {
				const data = new Float32Array(sample.numberOfFrames * targetNumberOfChannels);
				sample.copyTo(data, { planeIndex: 0, format: 'f32' });
				frame = [...data.subarray(0, targetNumberOfChannels)];
				sample.close();
			},
		});

		const sample = new AudioSample({
			format: 'f32',
			sampleRate: 48000,
			numberOfChannels: 8,
			timestamp: 0,
			data: new Float32Array(8 * 10).map((_, i) => [L, R, C, LFE, BL, BR, SL, SR][i % 8]!),
		});
		await resampler.add(sample);
		sample.close();
		await resampler.finalize();

		return frame;
	};

	const h = Math.SQRT1_2;
	const expectClose = (actual: number[], expected: number[]) => {
		expect(actual).toHaveLength(expected.length);
		actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 6));
	};

	expectClose(await downmix(2), [L + h * (C + BL + SL), R + h * (C + BR + SR)]);
	expectClose(await downmix(1), [h * (L + R) + C + 0.5 * (BL + BR + SL + SR)]);
	expectClose(await downmix(4), [L + h * C, R + h * C, BL + h * SL, BR + h * SR]);
	expectClose(await downmix(6), [L, R, C, LFE, SL + h * BL, SR + h * BR]);
});
