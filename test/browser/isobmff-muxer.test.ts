import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { AudioSample } from '../../src/sample.js';
import { Quality } from '../../src/encode.js';

test('Opus encoded from 44.1 kHz input loads in a fragmented MP4 through MSE', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});
	const source = new AudioSampleSource({ codec: 'opus', bitrate: new Quality('low') });
	output.addAudioTrack(source);
	await output.start();

	// Chromium's encoder resamples to 48 kHz but keeps 44100 as the OpusHead's input sample rate
	for (let i = 0; i < 10; i++) {
		const sample = new AudioSample({
			data: new Float32Array(4410 * 2),
			format: 'f32',
			numberOfChannels: 2,
			sampleRate: 44100,
			timestamp: i / 10,
		});
		await source.add(sample);
		sample.close();
	}
	await output.finalize();

	const mediaSource = new MediaSource();
	const video = document.createElement('video');
	video.src = URL.createObjectURL(mediaSource);
	await new Promise(resolve => mediaSource.addEventListener('sourceopen', resolve, { once: true }));

	const sourceBuffer = mediaSource.addSourceBuffer(await output.getMimeType());
	const result = await new Promise<string>((resolve) => {
		sourceBuffer.addEventListener('updateend', () => resolve('appended'), { once: true });
		sourceBuffer.addEventListener('error', () => resolve('error'), { once: true });
		sourceBuffer.appendBuffer(new Uint8Array(output.target.buffer!));
	});

	expect(result).toBe('appended');
	expect(sourceBuffer.buffered.length).toBe(1);
	expect(sourceBuffer.buffered.end(0)).toBeCloseTo(1, 1);
});
