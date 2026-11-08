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

test('Resampling keeps the passband and filters out what the target rate cannot represent', async () => {
	const resample = async (frequency: number, sourceRate: number, targetRate: number) => {
		const output: number[] = [];
		const resampler = new AudioResampler({
			targetSampleRate: targetRate,
			targetNumberOfChannels: 1,
			onSample: async (sample) => {
				const data = new Float32Array(sample.numberOfFrames);
				sample.copyTo(data, { planeIndex: 0, format: 'f32' });
				output.push(...data);
				sample.close();
			},
		});

		for (let start = 0; start < sourceRate / 2; start += 1024) {
			const data = new Float32Array(1024);
			for (let i = 0; i < data.length; i++) {
				data[i] = 0.5 * Math.sin(2 * Math.PI * frequency * (start + i) / sourceRate);
			}

			const sample = new AudioSample({
				format: 'f32',
				sampleRate: sourceRate,
				numberOfChannels: 1,
				timestamp: start / sourceRate,
				data,
			});
			await resampler.add(sample);
			sample.close();
		}
		await resampler.finalize();

		return output;
	};

	// Amplitude of a frequency component, relative to the input's, using a Hann-windowed DFT
	const relativeAmplitude = (data: number[], rate: number, frequency: number) => {
		let re = 0;
		let im = 0;
		let windowSum = 0;
		for (let i = 0; i < data.length; i++) {
			const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (data.length - 1));
			re += data[i]! * window * Math.cos(2 * Math.PI * frequency * i / rate);
			im -= data[i]! * window * Math.sin(2 * Math.PI * frequency * i / rate);
			windowSum += window;
		}
		return 2 * Math.hypot(re, im) / windowSum / 0.5;
	};

	// A 10 kHz tone passes 48 kHz -> 44.1 kHz unchanged (linear interpolation dampens it by 1.3 dB)
	const passband = relativeAmplitude(await resample(10_000, 48_000, 44_100), 44_100, 10_000);
	expect(passband).toBeGreaterThan(0.99);
	expect(passband).toBeLessThan(1.01);

	// A 12 kHz tone can't be represented at 16 kHz and must be filtered out instead of folding back to 4 kHz (FFmpeg
	// and Chrome's decodeAudioData both suppress it by more than 75 dB)
	const alias = relativeAmplitude(await resample(12_000, 48_000, 16_000), 16_000, 4_000);
	expect(alias).toBeLessThan(0.001);
});
