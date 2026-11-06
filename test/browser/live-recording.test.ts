// Live recording: MediaStream sources (canvas capture, Web Audio, generator tracks) into the output formats recorders
// use, checked by decoding the result back. Real-time tests use flashes and beeps emitted at the same moments as sync
// markers. Long-running checks only run when VITE_LIVE_RECORDING_LONG is set.

import { describe, expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import {
	HlsOutputFormat,
	MkvOutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	OutputFormat,
	WebMOutputFormat,
} from '../../src/output-format.js';
import { BufferTarget, PathedTarget, StreamTarget, StreamTargetChunk, Target } from '../../src/target.js';
import { MediaStreamAudioTrackSource, MediaStreamVideoTrackSource } from '../../src/media-source.js';
import { AudioEncodingConfig, Quality, VideoEncodingConfig } from '../../src/encode.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import {
	analyzeRecording,
	createGeneratorTracks,
	createMarkerSource,
	getBeepOffsets,
	installFakeTrackProcessor,
	mean,
	MarkerSourceOptions,
	sleep,
	tapMarkers,
	writeAudioChunk,
	writeVideoFrame,
} from './helpers/recording-harness.js';

registerAacEncoder();

const hasTrackGenerator = typeof MediaStreamTrackGenerator !== 'undefined';
const runLongTests = !!(import.meta as unknown as { env: Record<string, string | undefined> })
	.env['VITE_LIVE_RECORDING_LONG'];

const lowVp8 = { codec: 'vp8', quality: new Quality('low') } satisfies VideoEncodingConfig;
const lowOpus = { codec: 'opus', quality: new Quality('low') } satisfies AudioEncodingConfig;

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
};

/** Records flashes and beeps through MediaStream sources, measuring where they entered the tracks along the way. */
const recordMarkers = async (options: {
	format: OutputFormat;
	video: VideoEncodingConfig;
	audio: AudioEncodingConfig;
	durationMs: number;
	source?: MarkerSourceOptions;
}) => {
	const source = await createMarkerSource(options.source);
	if (!source) {
		return null;
	}

	const videoTap = tapMarkers(source.videoTrack);
	const audioTap = tapMarkers(source.audioTrack);

	const output = new Output({ format: options.format, target: new BufferTarget() });
	const videoSource = new MediaStreamVideoTrackSource(source.videoTrack, options.video);
	const audioSource = new MediaStreamAudioTrackSource(source.audioTrack, options.audio);
	const errors: unknown[] = [];
	videoSource.errorPromise.catch(error => errors.push(error));
	audioSource.errorPromise.catch(error => errors.push(error));
	output.addVideoTrack(videoSource);
	output.addAudioTrack(audioSource);

	await output.start();
	source.start(options.durationMs);
	await sleep(options.durationMs + 500);
	await output.finalize();

	videoTap.stop();
	audioTap.stop();
	await source.stop();

	const analysis = await analyzeRecording(output.target.buffer!);
	return {
		errors,
		analysis,
		inputOffsets: getBeepOffsets(videoTap.flashes, audioTap.beeps),
		outputOffsets: getBeepOffsets(analysis.flashes, analysis.beeps),
	};
};

/** Feeds generator tracks in real time: audio in 10 ms chunks, video frames every `frameIntervalMs`. */
const feedInRealTime = async (
	tracks: ReturnType<typeof createGeneratorTracks>,
	options: {
		durationMs: number;
		videoStartMs?: number;
		audioStartMs?: number;
		frameIntervalMs?: number;
		sampleRate?: number;
		onTick?: (elapsedMs: number) => unknown;
	},
) => {
	const canvas = new OffscreenCanvas(64, 48);
	const sampleRate = options.sampleRate ?? 48000;
	const frameIntervalMs = options.frameIntervalMs ?? 40;
	const start = performance.now();
	let audioChunks = 0;
	let videoFrames = 0;

	while (performance.now() - start < options.durationMs) {
		const elapsed = performance.now() - start;
		await options.onTick?.(elapsed);

		while (elapsed >= (options.audioStartMs ?? 0) + 10 * audioChunks) {
			await writeAudioChunk(tracks.audioWriter, {
				timestamp: (start + (options.audioStartMs ?? 0) + 10 * audioChunks) / 1000,
				numberOfFrames: sampleRate / 100,
				sampleRate,
			});
			audioChunks++;
		}
		while (elapsed >= (options.videoStartMs ?? 0) + frameIntervalMs * videoFrames) {
			const time = start + (options.videoStartMs ?? 0) + frameIntervalMs * videoFrames;
			await writeVideoFrame(tracks.videoWriter, canvas, time / 1000, `rgb(${videoFrames % 256}, 0, 0)`);
			videoFrames++;
		}

		await sleep(4);
	}
};

const recordGenerated = async (options: {
	format: OutputFormat;
	durationMs: number;
	videoStartMs?: number;
	audioStartMs?: number;
	frameIntervalMs?: number;
	timestampBase?: 'synced-zero' | 'zero' | 'unix';
	frameRate?: number | null;
}) => {
	const tracks = createGeneratorTracks();
	const output = new Output({ format: options.format, target: new BufferTarget() });
	const videoSource = new MediaStreamVideoTrackSource(
		tracks.videoTrack,
		{ codec: 'vp8', quality: new Quality('low') },
		{ timestampBase: options.timestampBase, frameRate: options.frameRate },
	);
	const audioSource = new MediaStreamAudioTrackSource(
		tracks.audioTrack,
		{ codec: 'opus', quality: new Quality('low') },
		{ timestampBase: options.timestampBase },
	);
	const errors: unknown[] = [];
	videoSource.errorPromise.catch(error => errors.push(error));
	audioSource.errorPromise.catch(error => errors.push(error));
	output.addVideoTrack(videoSource);
	output.addAudioTrack(audioSource);

	await output.start();
	const startTime = Date.now() / 1000;
	await feedInRealTime(tracks, options);
	await sleep(100);
	await output.finalize();
	await tracks.videoWriter.close();
	await tracks.audioWriter.close();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	const videoTimestamps: number[] = [];
	const packets = new EncodedPacketSink(videoTrack!).packets(undefined, undefined, { metadataOnly: true });
	for await (const packet of packets) {
		videoTimestamps.push(packet.timestamp);
	}

	return {
		errors,
		startTime,
		videoTimestamps: videoTimestamps.sort((a, b) => a - b),
		videoStart: await videoTrack!.getFirstTimestamp(),
		videoEnd: await videoTrack!.computeDuration(),
		audioStart: await audioTrack!.getFirstTimestamp(),
		audioEnd: await audioTrack!.computeDuration(),
	};
};

describe('A/V sync of canvas capture and Web Audio', () => {
	const cases = [
		{
			name: 'WebM, VP8 + Opus',
			format: () => new WebMOutputFormat(),
			video: { codec: 'vp8', quality: new Quality('low') },
			audio: { codec: 'opus', quality: new Quality('low') },
		},
		{
			name: 'fragmented MP4, AVC + Opus',
			format: () => new Mp4OutputFormat({ fastStart: 'fragmented' }),
			video: { codec: 'avc', quality: new Quality('low') },
			audio: { codec: 'opus', quality: new Quality('low') },
		},
		{
			name: 'MKV, VP9 + PCM',
			format: () => new MkvOutputFormat(),
			video: { codec: 'vp9', quality: new Quality('low') },
			audio: { codec: 'pcm-s16' },
		},
	] satisfies { name: string; format: () => OutputFormat; video: VideoEncodingConfig; audio: AudioEncodingConfig }[];

	test.for(cases)('$name: beeps keep their offset to the flashes, as captured', async (testCase, { skip }) => {
		const { format, video, audio } = testCase;
		const result = await recordMarkers({
			format: format(),
			video,
			audio,
			durationMs: 3000,
			source: { sampleRate: 48000 },
		});
		if (!result) {
			skip('Web Audio cannot run here without a user gesture');
		}

		expect(result!.errors).toEqual([]);
		expect(result!.outputOffsets.length).toBeGreaterThanOrEqual(5);

		// Within a recording, the offset moves by at most a frame (the video is sampled at 30 FPS)
		const outputMedian = median(result!.outputOffsets);
		const steady = result!.outputOffsets.filter(offset => Math.abs(offset - outputMedian) <= 1 / 30 + 0.005);
		expect(steady.length).toBeGreaterThanOrEqual(result!.outputOffsets.length - 1);

		// And it matches the offset with which the markers entered the tracks, up to frame quantization
		expect(Math.abs(outputMedian - median(result!.inputOffsets))).toBeLessThan(0.05);
	});

	test('the constant frame rate grid follows the track settings', async ({ skip }) => {
		const result = await recordMarkers({
			format: new WebMOutputFormat(),
			video: { codec: 'vp8', quality: new Quality('low') },
			audio: { codec: 'opus', quality: new Quality('low') },
			durationMs: 1500,
			source: { fps: 25, sampleRate: 48000 },
		});
		if (!result) {
			skip('Web Audio cannot run here without a user gesture');
		}

		const { videoTimestamps } = result!.analysis;
		expect(videoTimestamps.length).toBeGreaterThan(30);
		for (let i = 1; i < videoTimestamps.length; i++) {
			expect(videoTimestamps[i]! - videoTimestamps[i - 1]!).toBeCloseTo(1 / 25, 5);
		}
	});
});

describe.skipIf(!hasTrackGenerator)('Timeline', () => {
	const formats = [
		{ name: 'WebM', format: () => new WebMOutputFormat() },
		{ name: 'MKV', format: () => new MkvOutputFormat() },
		{ name: 'MP4', format: () => new Mp4OutputFormat() },
		{ name: 'fragmented MP4', format: () => new Mp4OutputFormat({ fastStart: 'fragmented' }) },
	];

	test.each(formats)('$name: the first sample starts at 0, a later track keeps its delay', async ({ format }) => {
		const result = await recordGenerated({ format: format(), durationMs: 1000, videoStartMs: 400 });

		expect(result.errors).toEqual([]);
		// The audio's first packet starts before 0 by Opus's pre-skip (6.5 ms) at most
		expect(result.audioStart).toBeGreaterThan(-0.01);
		expect(result.audioStart).toBeLessThan(0.005);
		expect(result.videoStart).toBeGreaterThan(0.38);
		expect(result.videoStart).toBeLessThan(0.43);
		expect(result.audioEnd).toBeGreaterThan(0.95);
	});

	test('timestampBase \'zero\' starts every track at 0', async () => {
		const result = await recordGenerated({
			format: new WebMOutputFormat(),
			durationMs: 800,
			videoStartMs: 300,
			timestampBase: 'zero',
		});

		expect(result.errors).toEqual([]);
		expect(result.videoStart).toBeCloseTo(0, 3);
		expect(result.audioStart).toBeGreaterThan(-0.01);
		expect(result.audioStart).toBeLessThan(0.005);
	});

	test('timestampBase \'unix\' stamps samples with the wall-clock time of their capture', async () => {
		const result = await recordGenerated({
			format: new WebMOutputFormat(),
			durationMs: 800,
			videoStartMs: 300,
			timestampBase: 'unix',
		});

		expect(result.errors).toEqual([]);
		expect(Math.abs(result.audioStart - result.startTime)).toBeLessThan(0.1);
		expect(result.videoStart - result.audioStart).toBeGreaterThan(0.28);
		expect(result.videoStart - result.audioStart).toBeLessThan(0.33);
	});

	test('frameRate: null keeps the capture timestamps of the frames', async () => {
		const result = await recordGenerated({
			format: new WebMOutputFormat(),
			durationMs: 1000,
			frameIntervalMs: 70,
			frameRate: null,
		});

		expect(result.errors).toEqual([]);
		const deltas = result.videoTimestamps.slice(1).map((timestamp, i) => timestamp - result.videoTimestamps[i]!);
		expect(deltas.length).toBeGreaterThan(10);
		for (const delta of deltas) {
			expect(delta).toBeCloseTo(0.07, 2);
		}
	});

	test('an explicit frame rate puts frames on its grid', async () => {
		const result = await recordGenerated({
			format: new WebMOutputFormat(),
			durationMs: 1000,
			frameIntervalMs: 70,
			frameRate: 20,
		});

		expect(result.errors).toEqual([]);
		const deltas = result.videoTimestamps.slice(1).map((timestamp, i) => timestamp - result.videoTimestamps[i]!);
		expect(deltas.length).toBeGreaterThan(15);
		for (const delta of deltas) {
			expect(delta).toBeCloseTo(0.05, 3);
		}
	});

	test.each([8000, 16000, 22050, 44100, 48000, 96000])(
		'Opus records %i Hz audio without gaps',
		async (sampleRate) => {
			const tracks = createGeneratorTracks();
			const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
			const audioSource = new MediaStreamAudioTrackSource(tracks.audioTrack, lowOpus);
			const errors: unknown[] = [];
			audioSource.errorPromise.catch(error => errors.push(error));
			output.addAudioTrack(audioSource);
			await output.start();

			const start = performance.now() / 1000;
			const chunkFrames = Math.round(sampleRate / 100);
			for (let i = 0; i < 30; i++) {
				await writeAudioChunk(tracks.audioWriter, {
					timestamp: start + i * chunkFrames / sampleRate,
					numberOfFrames: chunkFrames,
					sampleRate,
					numberOfChannels: 2,
				});
				await sleep(10);
			}
			await sleep(100);
			await output.finalize();
			await tracks.audioWriter.close();

			expect(errors).toEqual([]);
			const analysis = await analyzeRecording(output.target.buffer!);
			expect(analysis.audioSampleRate).toBe(48000); // Opus always decodes to 48 kHz
			expect(analysis.audioEnd! - analysis.audioStart!).toBeCloseTo(0.3, 1);
		},
	);
});

describe.skipIf(!hasTrackGenerator)('Lifecycle', () => {
	const createRecording = (format: OutputFormat, target: Target = new BufferTarget()) => {
		const tracks = createGeneratorTracks();
		const output = new Output({ format, target });
		const videoSource = new MediaStreamVideoTrackSource(tracks.videoTrack, lowVp8);
		const audioSource = new MediaStreamAudioTrackSource(tracks.audioTrack, lowOpus);
		const errors: unknown[] = [];
		videoSource.errorPromise.catch(error => errors.push(error));
		audioSource.errorPromise.catch(error => errors.push(error));
		output.addVideoTrack(videoSource);
		output.addAudioTrack(audioSource);

		return { tracks, output, videoSource, audioSource, errors };
	};

	test('finalize() right after start() writes a valid file', async () => {
		for (const format of [new WebMOutputFormat(), new Mp4OutputFormat()]) {
			const { output, errors, tracks } = createRecording(format);
			await output.start();
			await output.finalize();
			await tracks.videoWriter.close();
			await tracks.audioWriter.close();

			expect(errors).toEqual([]);
			using input = new Input({
				source: new BufferSource((output.target as BufferTarget).buffer!),
				formats: ALL_FORMATS,
			});
			expect(await input.getTracks()).toHaveLength(0);
		}
	});

	test('cancel() mid-recording closes the stream and reports no error', async () => {
		let closed = false;
		const writable = new WritableStream<StreamTargetChunk>({
			close: () => {
				closed = true;
			},
		});
		const { output, errors, tracks } = createRecording(
			new Mp4OutputFormat({ fastStart: 'fragmented' }),
			new StreamTarget(writable),
		);
		await output.start();
		await feedInRealTime(tracks, { durationMs: 500 });
		await output.cancel();

		expect(output.state).toBe('canceled');
		expect(closed).toBe(true);
		expect(errors).toEqual([]);
	});

	test('stopping the tracks right before finalize() keeps everything captured', async () => {
		const { output, errors, tracks } = createRecording(new WebMOutputFormat());
		await output.start();
		await feedInRealTime(tracks, { durationMs: 800 });
		await sleep(50);
		await tracks.videoWriter.close();
		await tracks.audioWriter.close();
		await output.finalize();

		expect(errors).toEqual([]);
		const analysis = await analyzeRecording((output.target as BufferTarget).buffer!);
		expect(analysis.videoEnd).toBeGreaterThan(0.75);
		expect(analysis.audioEnd).toBeGreaterThan(0.75);
	});

	test('closing one source mid-recording keeps the other one recording', async () => {
		const { output, errors, tracks, videoSource } = createRecording(new WebMOutputFormat());
		await output.start();
		await feedInRealTime(tracks, {
			durationMs: 1000,
			onTick: (elapsed) => {
				if (elapsed >= 500 && !videoSource._closingPromise) {
					videoSource.close();
				}
			},
		});
		await sleep(50);
		await output.finalize();

		expect(errors).toEqual([]);
		const analysis = await analyzeRecording((output.target as BufferTarget).buffer!);
		expect(analysis.videoEnd).toBeGreaterThan(0.4);
		expect(analysis.videoEnd).toBeLessThan(0.6);
		expect(analysis.audioEnd).toBeGreaterThan(0.95);
	});

	test('pausing both sources removes the paused time from both tracks', async () => {
		const { output, errors, tracks, videoSource, audioSource } = createRecording(new WebMOutputFormat());
		await output.start();
		await feedInRealTime(tracks, {
			durationMs: 1600,
			onTick: (elapsed) => {
				if (elapsed >= 500 && elapsed < 1100 && !videoSource.paused) {
					videoSource.pause();
					audioSource.pause();
				} else if (elapsed >= 1100 && videoSource.paused) {
					videoSource.resume();
					audioSource.resume();
				}
			},
		});
		await sleep(50);
		await output.finalize();

		expect(errors).toEqual([]);
		const analysis = await analyzeRecording((output.target as BufferTarget).buffer!);
		expect(analysis.audioEnd!).toBeGreaterThan(0.9);
		expect(analysis.audioEnd!).toBeLessThan(1.1);
		expect(Math.abs(analysis.videoEnd! - analysis.audioEnd!)).toBeLessThan(0.1);
		// No gap left where the pause was
		const timestamps = analysis.videoTimestamps;
		const deltas = timestamps.slice(1).map((timestamp, i) => timestamp - timestamps[i]!);
		expect(Math.max(...deltas)).toBeLessThan(0.1);
	});

	test('an audio configuration the encoder rejects surfaces through errorPromise', async () => {
		const tracks = createGeneratorTracks();
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const videoSource = new MediaStreamVideoTrackSource(tracks.videoTrack, lowVp8);
		const audioSource = new MediaStreamAudioTrackSource(tracks.audioTrack, lowOpus);
		const errors: unknown[] = [];
		videoSource.errorPromise.catch(error => errors.push(error));
		audioSource.errorPromise.catch(error => errors.push(error));
		output.addVideoTrack(videoSource);
		output.addAudioTrack(audioSource);
		await output.start();

		// 12 channels, which no browser encodes as Opus
		const canvas = new OffscreenCanvas(64, 48);
		const start = performance.now();
		for (let i = 0; i < 10; i++) {
			await writeAudioChunk(tracks.audioWriter, { timestamp: (start + 10 * i) / 1000, numberOfChannels: 12 });
			await writeVideoFrame(tracks.videoWriter, canvas, (start + 10 * i) / 1000);
			await sleep(10);
		}

		await output.finalize();
		await tracks.videoWriter.close();
		await tracks.audioWriter.close();

		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toMatch(/not supported/);

		// The video got recorded regardless
		const analysis = await analyzeRecording(output.target.buffer!);
		expect(analysis.videoEnd).toBeGreaterThan(0.05);
		expect(analysis.audioEnd).toBe(null);
	});

	test('a mid-stream audio format change surfaces through errorPromise', async () => {
		const tracks = createGeneratorTracks();
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const audioSource = new MediaStreamAudioTrackSource(tracks.audioTrack, lowOpus);
		const errors: unknown[] = [];
		audioSource.errorPromise.catch(error => errors.push(error));
		output.addAudioTrack(audioSource);
		await output.start();

		const start = performance.now();
		for (let i = 0; i < 20; i++) {
			const sampleRate = i < 10 ? 48000 : 44100; // Like a Bluetooth headset switching profiles
			await writeAudioChunk(tracks.audioWriter, {
				timestamp: (start + 10 * i) / 1000,
				numberOfFrames: sampleRate / 100,
				sampleRate,
			});
			await sleep(10);
		}

		await output.finalize();
		await tracks.audioWriter.close();

		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toMatch(/Audio parameters must remain constant/);

		const analysis = await analyzeRecording(output.target.buffer!);
		expect(analysis.audioEnd).toBeCloseTo(0.1, 1); // The audio from before the change
	});

	test('a resized canvas rejects errorPromise by default, and keeps its first size with \'contain\'', async () => {
		for (const sizeChangeBehavior of ['deny', 'contain'] as const) {
			const canvas = document.createElement('canvas');
			canvas.width = 320;
			canvas.height = 240;
			document.body.appendChild(canvas);
			const context = canvas.getContext('2d')!;
			let frame = 0;
			const drawInterval = setInterval(() => {
				context.fillStyle = `rgb(${frame++ % 256}, 0, 0)`;
				context.fillRect(0, 0, canvas.width, canvas.height);
			}, 16);
			const track = canvas.captureStream(30).getVideoTracks()[0]!;

			const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
			const videoSource = new MediaStreamVideoTrackSource(track, {
				codec: 'vp8',
				quality: new Quality('low'),
				sizeChangeBehavior,
			});
			const errors: unknown[] = [];
			videoSource.errorPromise.catch(error => errors.push(error));
			output.addVideoTrack(videoSource);
			await output.start();
			await sleep(400);
			canvas.width = 480;
			canvas.height = 270;
			await sleep(400);
			await output.finalize();
			clearInterval(drawInterval);
			track.stop();
			canvas.remove();

			using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
			const videoTrack = (await input.getPrimaryVideoTrack())!;
			expect(await videoTrack.getCodedWidth()).toBe(320);
			expect(await videoTrack.getCodedHeight()).toBe(240);

			if (sizeChangeBehavior === 'deny') {
				expect(String(errors[0])).toMatch(/Video sample size must remain constant/);
			} else {
				expect(errors).toEqual([]);
				expect(await videoTrack.computeDuration()).toBeGreaterThan(0.7);
			}
		}
	});
});

describe.skipIf(!hasTrackGenerator)('Streaming output', () => {
	test('fragmented MP4 to a StreamTarget is append-only and arrives fragment by fragment', async () => {
		const tracks = createGeneratorTracks();
		const writes: { position: number; size: number; time: number }[] = [];
		const fragmentStarts: number[] = [];
		const output = new Output({
			format: new Mp4OutputFormat({
				fastStart: 'fragmented',
				minimumFragmentDuration: 0.5,
				onMoof: (data, position, timestamp) => {
					fragmentStarts.push(timestamp);
				},
			}),
			target: new StreamTarget(new WritableStream<StreamTargetChunk>({
				write: (chunk) => {
					writes.push({ position: chunk.position, size: chunk.data.byteLength, time: performance.now() });
				},
			})),
		});
		const videoSource = new MediaStreamVideoTrackSource(tracks.videoTrack, {
			codec: 'vp8',
			quality: new Quality('low'),
			keyFrameInterval: 0.5,
		});
		const audioSource = new MediaStreamAudioTrackSource(tracks.audioTrack, lowOpus);
		output.addVideoTrack(videoSource);
		output.addAudioTrack(audioSource);
		await output.start();

		const start = performance.now();
		await feedInRealTime(tracks, { durationMs: 2200 });
		const finalizeTime = performance.now();
		await output.finalize();
		await tracks.videoWriter.close();
		await tracks.audioWriter.close();

		// Each write continues where the previous one ended
		let end = 0;
		for (const write of writes) {
			expect(write.position).toBe(end);
			end += write.size;
		}

		// Fragments came out during the recording, each covering at least the minimum fragment duration
		expect(writes.filter(write => write.time > start + 500 && write.time < finalizeTime).length).toBeGreaterThan(1);
		expect(fragmentStarts.length).toBeGreaterThanOrEqual(3);
		for (let i = 1; i < fragmentStarts.length; i++) {
			expect(fragmentStarts[i]! - fragmentStarts[i - 1]!).toBeGreaterThanOrEqual(0.5 - 1e-6);
		}
	});

	test.each([
		{ name: 'fragmented MP4', format: () => new Mp4OutputFormat({ fastStart: 'fragmented' }) },
		{ name: 'WebM (append-only)', format: () => new WebMOutputFormat({ appendOnly: true }) },
	])('$name streams into Media Source Extensions while recording', async ({ format }) => {
		const video = document.createElement('video');
		video.muted = true;
		const mediaSource = new MediaSource();
		video.src = URL.createObjectURL(mediaSource);
		await new Promise(resolve => mediaSource.addEventListener('sourceopen', resolve, { once: true }));

		const queue: Uint8Array[] = [];
		let sourceBuffer: SourceBuffer | null = null;
		const pump = () => {
			if (sourceBuffer && !sourceBuffer.updating && queue.length > 0) {
				sourceBuffer.appendBuffer(queue.shift()! as Uint8Array<ArrayBuffer>);
			}
		};

		const tracks = createGeneratorTracks();
		const output = new Output({
			format: format(),
			target: new StreamTarget(new WritableStream<StreamTargetChunk>({
				write: (chunk) => {
					queue.push(chunk.data.slice());
					pump();
				},
			})),
		});
		// VP9, since Chrome's MSE doesn't take VP8 in MP4
		const videoSource = new MediaStreamVideoTrackSource(tracks.videoTrack, {
			codec: 'vp9',
			quality: new Quality('low'),
			keyFrameInterval: 0.5,
		});
		const audioSource = new MediaStreamAudioTrackSource(tracks.audioTrack, lowOpus);
		output.addVideoTrack(videoSource);
		output.addAudioTrack(audioSource);
		await output.start();

		// The MIME type (with the codec strings) is known once the first packets are out
		void output.getMimeType().then((mimeType) => {
			sourceBuffer = mediaSource.addSourceBuffer(mimeType);
			sourceBuffer.addEventListener('updateend', pump);
			pump();
		});

		const bufferedDuringRecording: number[] = [];
		await feedInRealTime(tracks, {
			durationMs: 2000,
			onTick: () => {
				if (sourceBuffer && sourceBuffer.buffered.length > 0) {
					bufferedDuringRecording.push(sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1));
				}
			},
		});
		await output.finalize();
		await tracks.videoWriter.close();
		await tracks.audioWriter.close();
		while (queue.length > 0 || sourceBuffer!.updating) {
			await sleep(10);
		}

		expect(video.error).toBe(null);
		expect(bufferedDuringRecording.length).toBeGreaterThan(0);
		expect(bufferedDuringRecording.at(-1)!).toBeGreaterThan(0.9); // Playable while still recording
		const buffered = sourceBuffer!.buffered;
		expect(buffered.length).toBe(1);
		expect(buffered.end(0)).toBeGreaterThan(1.8);
	});

	test('live HLS segments start with key frames and are listed while recording', async () => {
		const files = new Map<string, BufferTarget>();
		const playlistsDuringRecording: string[] = [];
		let recording = true;
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new MpegTsOutputFormat(),
				live: true,
				targetDuration: 1,
				onPlaylist: (content) => {
					if (recording) {
						playlistsDuringRecording.push(content);
					}
				},
			}),
			target: new PathedTarget('master.m3u8', ({ path }) => {
				const target = new BufferTarget();
				files.set(path, target);
				return target;
			}),
		});

		const tracks = createGeneratorTracks();
		const videoSource = new MediaStreamVideoTrackSource(tracks.videoTrack, {
			codec: 'avc',
			quality: new Quality('low'),
			keyFrameInterval: 1,
		});
		const audioSource = new MediaStreamAudioTrackSource(tracks.audioTrack, {
			codec: 'aac',
			quality: new Quality('low'),
		});
		const errors: unknown[] = [];
		videoSource.errorPromise.catch(error => errors.push(error));
		audioSource.errorPromise.catch(error => errors.push(error));
		output.addVideoTrack(videoSource);
		output.addAudioTrack(audioSource);
		await output.start();
		await feedInRealTime(tracks, { durationMs: 3500 });
		recording = false;
		await output.finalize();
		await tracks.videoWriter.close();
		await tracks.audioWriter.close();

		expect(errors).toEqual([]);
		expect(playlistsDuringRecording.length).toBeGreaterThanOrEqual(2);
		expect(playlistsDuringRecording[0]).toContain('#EXTINF');

		const segmentPaths = [...files.keys()].filter(path => path.endsWith('.ts'));
		expect(segmentPaths.length).toBeGreaterThanOrEqual(3);
		for (const path of segmentPaths) {
			using input = new Input({ source: new BufferSource(files.get(path)!.buffer!), formats: ALL_FORMATS });
			const videoTrack = (await input.getPrimaryVideoTrack())!;
			const firstVideoPacket = await new EncodedPacketSink(videoTrack).getFirstPacket();
			expect(firstVideoPacket!.type).toBe('key');
		}
	});
});

describe.skipIf(!runLongTests || !hasTrackGenerator)('Long recordings', () => {
	test('30 minutes of media, fed faster than real time, keep audio and video in sync', async () => {
		const tracks = createGeneratorTracks();
		const fakeProcessor = installFakeTrackProcessor();

		let encodedVideo = 0;
		let encodedAudio = 0;
		const output = new Output({ format: new WebMOutputFormat({ appendOnly: true }), target: new BufferTarget() });
		const videoSource = new MediaStreamVideoTrackSource(
			tracks.videoTrack,
			{ codec: 'vp8', quality: new Quality('very-low'), onEncodedSample: () => encodedVideo++ },
			{ frameRate: null },
		);
		const audioSource = new MediaStreamAudioTrackSource(tracks.audioTrack, {
			codec: 'opus',
			quality: new Quality('very-low'),
			onEncodedSample: () => encodedAudio++,
		});
		output.addVideoTrack(videoSource);
		output.addAudioTrack(audioSource);
		try {
			await output.start();
		} finally {
			fakeProcessor.restore();
		}

		// A flash and a 50 ms beep at the start of every 10 s
		const videoController = fakeProcessor.controller(tracks.videoTrack);
		const audioController = fakeProcessor.controller(tracks.audioTrack);
		const canvas = new OffscreenCanvas(32, 24);
		const context = canvas.getContext('2d')!;
		const base = performance.now() / 1000;
		const seconds = 30 * 60;
		let videoFrames = 0;
		let audioChunks = 0;

		while (videoFrames / 30 < seconds || audioChunks / 100 < seconds) {
			if (videoFrames / 30 <= audioChunks / 100) {
				const time = videoFrames / 30;
				context.fillStyle = time % 10 < 0.01 ? 'white' : 'black';
				context.fillRect(0, 0, canvas.width, canvas.height);
				videoController.enqueue(new VideoFrame(canvas, { timestamp: Math.round((base + time) * 1e6) }));
				videoFrames++;
			} else {
				const data = new Float32Array(480);
				for (let i = 0; i < 480; i++) {
					const time = audioChunks / 100 + i / 48000;
					data[i] = time % 10 < 0.05 ? 0.5 * Math.sin(2 * Math.PI * 1000 * time) : 0;
				}
				audioController.enqueue(new AudioData({
					format: 'f32-planar',
					sampleRate: 48000,
					numberOfChannels: 1,
					numberOfFrames: 480,
					timestamp: Math.round((base + audioChunks / 100) * 1e6),
					data,
				}));
				audioChunks++;
			}

			// Let the encoders keep up, since the sources drop media when they fall behind
			while (videoFrames - encodedVideo > 3 || audioChunks - encodedAudio > 3) {
				await sleep(0);
			}
		}
		while (videoFrames > encodedVideo || audioChunks > encodedAudio) {
			await sleep(1);
		}
		await output.finalize();

		const analysis = await analyzeRecording(output.target.buffer!);
		const offsets = getBeepOffsets(analysis.flashes, analysis.beeps);
		expect(offsets.length).toBe(seconds / 10);
		for (const offset of offsets) {
			expect(Math.abs(offset - offsets[0]!)).toBeLessThan(0.001);
		}
	}, 30 * 60_000);

	test('a minute of canvas capture and Web Audio keeps the offset of its first seconds', async ({ skip }) => {
		const result = await recordMarkers({
			format: new WebMOutputFormat(),
			video: { codec: 'vp8', quality: new Quality('low') },
			audio: { codec: 'opus', quality: new Quality('low') },
			durationMs: 60_000,
			source: { sampleRate: 48000, periodMs: 1000 },
		});
		if (!result) {
			skip('Web Audio cannot run here without a user gesture');
		}

		expect(result!.errors).toEqual([]);
		expect(result!.outputOffsets.length).toBeGreaterThanOrEqual(58);
		const start = median(result!.outputOffsets.slice(0, 5));
		const end = median(result!.outputOffsets.slice(-5));
		expect(Math.abs(end - start)).toBeLessThan(1 / 30 + 0.005);
		expect(Math.abs(mean(result!.outputOffsets) - mean(result!.inputOffsets))).toBeLessThan(0.05);
	}, 120_000);
});
