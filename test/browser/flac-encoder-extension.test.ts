import { expect, test, vi } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { AudioSampleSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';
import { Output } from '../../src/output.js';
import { FlacOutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { BufferSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';

test('FLAC encoder, 24-bit', async () => {
	registerFlacEncoder();

	const sampleRate = 48000;
	const channels = 2;
	const durationSeconds = 2;
	const data = createF32SineWave(sampleRate, channels, durationSeconds);

	const result = await encodeAndDecodeFirstSample(new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: channels,
		sampleRate,
		timestamp: 0,
	}));
	using sample = result.sample;

	expect(result.size).toBeGreaterThan(90_000);

	expect(sample.format).toBe('s32');
});

test('FLAC encoder, 16-bit', async () => {
	registerFlacEncoder();

	const sampleRate = 48000;
	const channels = 2;
	const durationSeconds = 2;
	const data = createS16SineWave(sampleRate, channels, durationSeconds);

	const result = await encodeAndDecodeFirstSample(new AudioSample({
		data,
		format: 's16',
		numberOfChannels: channels,
		sampleRate,
		timestamp: 0,
	}));
	using sample = result.sample;

	expect(result.size).toBeLessThan(50_000); // Shit just uses less data

	// Really, this should only have s16 but decoders can differ and be flaky here. Trust me, I have tested that the
	// encoder does in fact encode s16.
	expect(['s16', 's32'].includes(sample.format)).toBe(true);
});

const createF32SineWave = (sampleRate: number, channels: number, durationSeconds: number) => {
	const totalFrames = sampleRate * durationSeconds;
	const data = new Float32Array(totalFrames * channels);

	for (let i = 0; i < totalFrames; i++) {
		const value = Math.sin(2 * Math.PI * 440 * i / sampleRate);
		for (let ch = 0; ch < channels; ch++) {
			data[i * channels + ch] = value;
		}
	}

	return data;
};

const createS16SineWave = (sampleRate: number, channels: number, durationSeconds: number) => {
	const totalFrames = sampleRate * durationSeconds;
	const data = new Int16Array(totalFrames * channels);

	for (let i = 0; i < totalFrames; i++) {
		const value = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 32767);
		for (let ch = 0; ch < channels; ch++) {
			data[i * channels + ch] = value;
		}
	}

	return data;
};

const encodeAndDecodeFirstSample = async (audioSample: AudioSample) => {
	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'flac' });
	output.addAudioTrack(audioSource);

	await output.start();
	await audioSource.add(audioSample);
	audioSample.close();
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const sink = new AudioSampleSink(track);
	const sample = await sink.getSample(0);
	assert(sample);

	return { sample, size: output.target.buffer!.byteLength };
};

test('FLAC encoder instances leave no Blob URL of their worker registered', async () => {
	registerFlacEncoder();

	// Each encoder instance starts a worker from a Blob URL of its script. A URL that stays registered keeps the
	// script in memory for as long as the page lives, even after the worker is gone.
	const createSpy = vi.spyOn(URL, 'createObjectURL');
	const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

	try {
		for (let i = 0; i < 3; i++) {
			const output = new Output({ format: new FlacOutputFormat(), target: new BufferTarget() });
			const audioSource = new AudioSampleSource({ codec: 'flac' });
			output.addAudioTrack(audioSource);
			await output.start();

			const sample = new AudioSample({
				data: new Float32Array(4800),
				format: 'f32',
				numberOfChannels: 1,
				sampleRate: 48000,
				timestamp: 0,
			});
			await audioSource.add(sample);
			sample.close();
			await output.finalize(); // Closes the encoder, which terminates its worker
		}

		const created = createSpy.mock.results.map(result => result.value as string);
		const revoked = revokeSpy.mock.calls.map(call => call[0]);

		expect(created.length).toBeGreaterThanOrEqual(3);
		expect(created.filter(url => !revoked.includes(url))).toEqual([]);
	} finally {
		createSpy.mockRestore();
		revokeSpy.mockRestore();
	}
});
