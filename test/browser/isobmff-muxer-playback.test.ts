import { describe, expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { CmafOutputFormat, MovOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { AudioSampleSource, CanvasSource } from '../../src/media-source.js';
import { AudioSample } from '../../src/sample.js';
import { Quality } from '../../src/encode.js';
import { AudioCodec, VideoCodec } from '../../src/codec.js';

// Encodes one second of video and/or audio with WebCodecs and muxes it with the given format.
const encode = async (options: {
	format: Mp4OutputFormat | MovOutputFormat | CmafOutputFormat;
	videoCodec?: VideoCodec;
	audioCodec?: AudioCodec;
	videoStart?: number;
}) => {
	const initTarget = options.format instanceof CmafOutputFormat ? new BufferTarget() : undefined;
	const output = new Output({ format: options.format, target: new BufferTarget(), initTarget });

	const canvas = new OffscreenCanvas(320, 240);
	const context = canvas.getContext('2d')!;
	let videoSource: CanvasSource | null = null;
	if (options.videoCodec) {
		videoSource = new CanvasSource(canvas, {
			codec: options.videoCodec,
			bitrate: new Quality('low'),
			keyFrameInterval: 0.5,
		});
		output.addVideoTrack(videoSource, { frameRate: 30 });
	}

	let audioSource: AudioSampleSource | null = null;
	if (options.audioCodec) {
		audioSource = new AudioSampleSource({ codec: options.audioCodec, bitrate: new Quality('low') });
		output.addAudioTrack(audioSource);
	}

	await output.start();

	const sampleRate = 48000;
	const chunkFrames = 4800;
	for (let i = 0; i < 30; i++) {
		if (videoSource) {
			context.fillStyle = `hsl(${i * 12}, 80%, 50%)`;
			context.fillRect(0, 0, canvas.width, canvas.height);
			await videoSource.add((options.videoStart ?? 0) + i / 30, 1 / 30);
		}
		if (audioSource && i % 3 === 0) {
			const data = new Float32Array(chunkFrames * 2);
			for (let j = 0; j < chunkFrames; j++) {
				const value = Math.sin(2 * Math.PI * 440 * (i / 3 * chunkFrames + j) / sampleRate) * 0.5;
				data[2 * j] = value;
				data[2 * j + 1] = value;
			}
			const sample = new AudioSample({
				data,
				format: 'f32',
				numberOfChannels: 2,
				sampleRate,
				timestamp: i / 30,
			});
			await audioSource.add(sample);
			sample.close();
		}
	}

	await output.finalize();
	return {
		mimeType: await output.getMimeType(),
		bytes: new Uint8Array(output.target.buffer!),
		init: initTarget ? new Uint8Array(initTarget.buffer!) : null,
	};
};

/** Appends the given chunks to a MediaSource, then plays it through and reports what Chrome made of it. */
const playWithMse = async (mimeType: string, chunks: Uint8Array<ArrayBuffer>[]) => {
	const mediaSource = new MediaSource();
	const video = document.createElement('video');
	video.muted = true;
	video.src = URL.createObjectURL(mediaSource);
	await new Promise(resolve => mediaSource.addEventListener('sourceopen', resolve, { once: true }));

	expect(MediaSource.isTypeSupported(mimeType)).toBe(true);
	const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
	for (const chunk of chunks) {
		await new Promise<void>((resolve, reject) => {
			sourceBuffer.addEventListener('updateend', () => resolve(), { once: true });
			sourceBuffer.addEventListener('error', () => reject(new Error('appendBuffer failed')), { once: true });
			sourceBuffer.appendBuffer(chunk);
		});
	}

	const buffered = Array.from({ length: sourceBuffer.buffered.length }, (_, i) => [
		sourceBuffer.buffered.start(i),
		sourceBuffer.buffered.end(i),
	]);
	mediaSource.endOfStream();

	// Start where the media starts if that's well past 0. A small gap at the start is played through, and WebKit
	// never completes a seek to just after 0 (with FFmpeg's fragmented files too)
	const start = buffered[0]?.[0] ?? 0;
	if (start > 0.5) {
		video.currentTime = start;
	}
	video.playbackRate = 8;
	await video.play();
	await new Promise<void>((resolve, reject) => {
		video.addEventListener('ended', () => resolve(), { once: true });
		video.addEventListener('error', () => reject(new Error(video.error?.message)), { once: true });
	});

	return { buffered, currentTime: video.currentTime };
};

const playFile = async (mimeType: string, bytes: Uint8Array) => {
	const video = document.createElement('video');
	video.muted = true;
	video.src = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }));
	await new Promise<void>((resolve, reject) => {
		video.addEventListener('loadedmetadata', () => resolve(), { once: true });
		video.addEventListener('error', () => reject(new Error(video.error?.message)), { once: true });
	});
	const duration = video.duration;
	const size = [video.videoWidth, video.videoHeight];

	video.playbackRate = 8;
	await video.play();
	await new Promise<void>((resolve, reject) => {
		video.addEventListener('ended', () => resolve(), { once: true });
		video.addEventListener('error', () => reject(new Error(video.error?.message)), { once: true });
	});

	return { duration, size, currentTime: video.currentTime };
};

/** Whether the browser itself can encode the AV1 the tests use; some, like Safari, have no WebCodecs AV1 encoder. */
const browserEncodesAv1 = async () => {
	try {
		const config = { codec: 'av01.0.00M.08', width: 320, height: 240, bitrate: 500_000 };
		return (await VideoEncoder.isConfigSupported(config)).supported === true;
	} catch {
		return false;
	}
};

describe('Chrome plays muxed ISOBMFF files', () => {
	for (const videoCodec of ['avc', 'vp9', 'av1'] as const) {
		test(`fragmented ${videoCodec} + Opus loads through MSE and plays to the end`, async ({ skip }) => {
			if (videoCodec === 'av1' && !await browserEncodesAv1()) {
				skip('No WebCodecs AV1 encoder in this browser');
			}

			const { mimeType, bytes } = await encode({
				format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0.5 }),
				videoCodec,
				audioCodec: 'opus',
			});
			const { buffered, currentTime } = await playWithMse(mimeType, [bytes]);
			expect(buffered).toHaveLength(1);
			expect(buffered[0]![0]).toBeCloseTo(0, 1);
			expect(buffered[0]![1]).toBeCloseTo(1, 1);
			expect(currentTime).toBeCloseTo(1, 1);
		});

		test(`regular ${videoCodec} + Opus MP4 plays as a file`, async ({ skip }) => {
			if (videoCodec === 'av1' && !await browserEncodesAv1()) {
				skip('No WebCodecs AV1 encoder in this browser');
			}

			const { mimeType, bytes } = await encode({
				format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
				videoCodec,
				audioCodec: 'opus',
			});
			const { duration, size, currentTime } = await playFile(mimeType, bytes);
			expect(duration).toBeCloseTo(1, 1);
			expect(size).toEqual([320, 240]);
			expect(currentTime).toBeCloseTo(1, 1);
		});
	}

	test('CMAF init and media segments load through MSE', async () => {
		const { mimeType, bytes, init } = await encode({
			format: new CmafOutputFormat(),
			videoCodec: 'avc',
		});
		const { buffered } = await playWithMse(mimeType, [init!, bytes]);
		expect(buffered).toHaveLength(1);
		expect(buffered[0]![1]).toBeCloseTo(1, 1);
	});

	test('a fragmented file starting at a later timestamp is buffered from that timestamp', async () => {
		const { mimeType, bytes } = await encode({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			videoCodec: 'vp9',
			videoStart: 10,
		});
		const { buffered } = await playWithMse(mimeType, [bytes]);
		expect(buffered[0]![0]).toBeCloseTo(10, 1);
		expect(buffered[0]![1]).toBeCloseTo(11, 1);
	});
});
