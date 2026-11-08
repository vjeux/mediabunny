import { expect, test } from 'vitest';
import { AudioResampler } from '../../src/resample.js';
import { AudioSample } from '../../src/sample.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { AudioEncodingConfig } from '../../src/encode.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';

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

test('Audio sources built from one reused config keep their own transform', async () => {
	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const config: AudioEncodingConfig = { codec: 'pcm-s16', transform: { sampleRate: 48000, numberOfChannels: 1 } };
	const sources: AudioSampleSource[] = [];
	for (const [sampleRate, numberOfChannels] of [[48000, 1], [16000, 2]] as const) {
		config.transform!.sampleRate = sampleRate;
		config.transform!.numberOfChannels = numberOfChannels;
		const source = new AudioSampleSource(config);
		output.addAudioTrack(source);
		sources.push(source);
	}
	config.codec = 'pcm-f32'; // Too late to matter, and must not desync the encoder from its track

	await output.start();
	for (const source of sources) {
		const sample = new AudioSample({
			data: new Float32Array(4800),
			format: 'f32',
			numberOfChannels: 1,
			sampleRate: 48000,
			timestamp: 0,
		});
		await source.add(sample);
		sample.close();
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const tracks = await input.getAudioTracks();
	expect(await Promise.all(tracks.map(track => track.getSampleRate()))).toEqual([48000, 16000]);
	expect(await Promise.all(tracks.map(track => track.getNumberOfChannels()))).toEqual([1, 2]);
	expect(await Promise.all(tracks.map(track => track.getCodec()))).toEqual(['pcm-s16', 'pcm-s16']);
});
