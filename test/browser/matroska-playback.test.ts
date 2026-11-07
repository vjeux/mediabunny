import { describe, expect, test } from 'vitest';
import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSink,
	AudioSampleSource,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	Input,
	MATROSKA,
	Output,
	Quality,
	StreamTarget,
	StreamTargetChunk,
	VideoSample,
	VideoSampleSink,
	VideoSampleSource,
	WEBM,
	WebMOutputFormat,
} from '../../src/index.js';

// Matroska/WebM interoperability with Chrome: files Mediabunny writes must play through Media Source Extensions (which
// uses Chromium's own WebM parser) and the <video> element, and files Chrome's MediaRecorder writes must demux and
// decode.

const encodeWebM = async (options: {
	codec: 'vp8' | 'vp9' | 'av1';
	audio?: boolean;
	rotation?: 0 | 90 | 180 | 270;
	frames?: number;
	keyFrameInterval?: number;
}) => {
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const videoSource = new VideoSampleSource({
		codec: options.codec,
		bitrate: new Quality('low'),
		keyFrameInterval: options.keyFrameInterval,
	});
	output.addVideoTrack(videoSource, { rotation: options.rotation ?? 0, frameRate: 30 });
	let audioSource: AudioSampleSource | null = null;
	if (options.audio) {
		audioSource = new AudioSampleSource({ codec: 'opus', bitrate: new Quality('low') });
		output.addAudioTrack(audioSource);
	}
	await output.start();

	const canvas = new OffscreenCanvas(160, 120);
	const context = canvas.getContext('2d')!;
	const frames = options.frames ?? 45;
	for (let i = 0; i < frames; i++) {
		context.fillStyle = `hsl(${i * 8}, 80%, 50%)`;
		context.fillRect(0, 0, 160, 120);
		const sample = new VideoSample(canvas, { timestamp: i / 30, duration: 1 / 30 });
		await videoSource.add(sample);
		sample.close();

		if (audioSource) {
			const data = new Float32Array(1600 * 2).map((_, j) => 0.1 * Math.sin((i * 1600 + (j >> 1)) / 20));
			const audioSample = new AudioSample({
				data,
				format: 'f32',
				numberOfChannels: 2,
				sampleRate: 48000,
				timestamp: i / 30,
			});
			await audioSource.add(audioSample);
			audioSample.close();
		}
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

const toArrayBuffer = (bytes: Uint8Array) => bytes.slice().buffer;

/** A <video> element fed through Media Source Extensions, which use the browser's own WebM parser. */
const openMse = async (mimeType: string) => {
	expect(MediaSource.isTypeSupported(mimeType)).toBe(true);

	const video = document.createElement('video');
	video.muted = true; // Muted media may play without a user gesture
	const mediaSource = new MediaSource();
	const url = URL.createObjectURL(mediaSource);
	video.src = url;
	await new Promise(resolve => mediaSource.addEventListener('sourceopen', resolve, { once: true }));

	const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
	const errors: string[] = [];
	sourceBuffer.addEventListener('error', () => errors.push('SourceBuffer error'));
	video.addEventListener('error', () => errors.push(`video error: ${video.error?.message}`));

	return {
		errors,
		buffered: () => {
			const ranges: number[][] = [];
			for (let i = 0; i < sourceBuffer.buffered.length; i++) {
				ranges.push([sourceBuffer.buffered.start(i), sourceBuffer.buffered.end(i)]);
			}
			return ranges;
		},
		append: async (bytes: Uint8Array) => {
			sourceBuffer.appendBuffer(toArrayBuffer(bytes));
			await new Promise(resolve => sourceBuffer.addEventListener('updateend', resolve, { once: true }));
		},
		/** Ends the stream and plays it from the start until the element reports its end. */
		playToEnd: async () => {
			try {
				mediaSource.endOfStream();
				await video.play();
				await new Promise<void>((resolve, reject) => {
					if (video.ended) {
						resolve();
						return;
					}

					const timeout = setTimeout(() => {
						reject(new Error(`Playback stalled at ${video.currentTime} s`));
					}, 15_000);
					video.addEventListener('ended', () => {
						clearTimeout(timeout);
						resolve();
					}, { once: true });
					video.addEventListener('error', () => {
						clearTimeout(timeout);
						reject(new Error(`video error: ${video.error?.message}`));
					}, { once: true });
				});

				const quality = video.getVideoPlaybackQuality();
				return {
					currentTime: video.currentTime,
					presentedFrames: quality.totalVideoFrames - quality.droppedVideoFrames,
					width: video.videoWidth,
					height: video.videoHeight,
				};
			} finally {
				// Release the media player
				video.removeAttribute('src');
				video.load();
				URL.revokeObjectURL(url);
			}
		},
	};
};

/** Appends the file to a SourceBuffer in small pieces, like a stream would, then plays it to its end. */
const playThroughMse = async (bytes: Uint8Array, mimeType: string) => {
	const mse = await openMse(mimeType);
	const chunkSize = 4096;
	for (let i = 0; i < bytes.length && mse.errors.length === 0; i += chunkSize) {
		await mse.append(bytes.subarray(i, i + chunkSize));
	}
	expect(mse.errors).toEqual([]);

	const buffered = mse.buffered();
	return { buffered, ...await mse.playToEnd() };
};

/** Copies the video and Opus audio packets of a WebM file into the output, interleaved, but doesn't finalize it. */
const copyPackets = async (bytes: Uint8Array, output: Output) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const videoTrack = (await input.getVideoTracks())[0]!;
	const audioTrack = (await input.getAudioTracks())[0]!;

	const videoSource = new EncodedVideoPacketSource((await videoTrack.getCodec())!);
	const audioSource = new EncodedAudioPacketSource('opus');
	output.addVideoTrack(videoSource);
	output.addAudioTrack(audioSource);
	await output.start();

	const videoPackets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		videoPackets.push(packet);
	}
	const audioPackets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		audioPackets.push(packet);
	}

	const videoConfig = (await videoTrack.getDecoderConfig())!;
	const audioConfig = (await audioTrack.getDecoderConfig())!;
	let v = 0;
	let a = 0;
	while (v < videoPackets.length || a < audioPackets.length) {
		const videoIsNext = a >= audioPackets.length
			|| (v < videoPackets.length && videoPackets[v]!.timestamp <= audioPackets[a]!.timestamp);
		if (videoIsNext) {
			await videoSource.add(videoPackets[v]!, v === 0 ? { decoderConfig: videoConfig } : undefined);
			v++;
		} else {
			await audioSource.add(audioPackets[a]!, a === 0 ? { decoderConfig: audioConfig } : undefined);
			a++;
		}
	}
};

const loadInVideoElement = async (bytes: Uint8Array, mimeType: string) => {
	const video = document.createElement('video');
	video.muted = true;
	const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mimeType }));
	video.src = url;

	try {
		await new Promise<void>((resolve, reject) => {
			video.addEventListener('loadedmetadata', () => resolve(), { once: true });
			video.addEventListener('error', () => reject(new Error(video.error?.message)), { once: true });
		});

		return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
	} finally {
		URL.revokeObjectURL(url);
	}
};

describe('Mediabunny WebM in Chrome', () => {
	test.for([
		{ codec: 'vp8' as const, mimeType: 'video/webm; codecs="vp8, opus"' },
		{ codec: 'vp9' as const, mimeType: 'video/webm; codecs="vp9, opus"' },
		{ codec: 'av1' as const, mimeType: 'video/webm; codecs="av01.0.04M.08, opus"' },
	])('$codec + Opus plays through Media Source Extensions', async ({ codec, mimeType }, { skip }) => {
		if (codec === 'av1') {
			// Capability guard: not every browser can encode AV1 (Safari can't) or play it through MSE. This is the
			// encoder configuration Mediabunny asks for at this size.
			const encoderSupport = await VideoEncoder.isConfigSupported({
				codec: 'av01.0.00M.08',
				width: 160,
				height: 120,
			});
			skip(!encoderSupport.supported || !MediaSource.isTypeSupported(mimeType), 'AV1 isn\'t supported here');
		}

		const bytes = await encodeWebM({ codec, audio: true });
		const result = await playThroughMse(bytes, mimeType);
		expect(result.buffered.length).toBe(1);
		expect(result.buffered[0]![0]).toBeLessThanOrEqual(0.01);
		expect(result.buffered[0]![1]).toBeCloseTo(1.5, 1);
		expect(result.currentTime).toBeCloseTo(1.5, 1);
		expect(result.presentedFrames).toBeGreaterThan(0);
		expect([result.width, result.height]).toEqual([160, 120]);
	});

	test('append-only output plays through Media Source Extensions while it is being written', async () => {
		// Every write goes to the SourceBuffer right away, so the media must become playable before finalize()
		const source = await encodeWebM({ codec: 'vp9', audio: true, frames: 90, keyFrameInterval: 0.5 });
		const mse = await openMse('video/webm; codecs="vp9, opus"');

		// The writes are taken as they come and appended in order; waiting for the appends before taking the next write
		// would hold the writes back in the stream's queue
		let writtenBytes = 0;
		let appends = Promise.resolve();
		const output = new Output({
			format: new WebMOutputFormat({ appendOnly: true }),
			target: new StreamTarget(new WritableStream<StreamTargetChunk>({
				write: (chunk) => {
					expect(chunk.position).toBe(writtenBytes); // Each write continues where the last one ended
					writtenBytes += chunk.data.length;
					const data = chunk.data.slice();
					appends = appends.then(() => mse.append(data));
				},
			})),
		});

		await copyPackets(source, output);
		await appends;
		const bufferedBeforeFinalize = mse.buffered();
		await output.finalize();
		await appends;

		expect(mse.errors).toEqual([]);
		expect(bufferedBeforeFinalize.length).toBe(1);
		expect(bufferedBeforeFinalize[0]![1]).toBeGreaterThan(1); // Over a second of the three was already playable
		expect(mse.buffered()[0]![1]).toBeCloseTo(3, 1);

		const result = await mse.playToEnd();
		expect(result.currentTime).toBeCloseTo(3, 1);
		expect(result.presentedFrames).toBeGreaterThan(0);
	});

	test('the <video> element reads the duration, size and rotation', async () => {
		const bytes = await encodeWebM({ codec: 'vp9', rotation: 90 });
		const result = await loadInVideoElement(bytes, 'video/webm');
		expect(result.duration).toBeCloseTo(1.5, 2);

		// Whether the browser applies a Matroska rotation (Firefox's WebM demuxer doesn't, nor does WebKit's
		// GStreamer-based one) shows with a 160x120 file that FFmpeg wrote with a 90 degree rotation (a Projection
		// with a ProjectionPoseRoll, as Mediabunny writes it)
		const reference = new Uint8Array(await (await fetch('/rotated-90.webm')).arrayBuffer());
		const referenceResult = await loadInVideoElement(reference, 'video/webm');
		expect([[160, 120], [120, 160]]).toContainEqual([referenceResult.width, referenceResult.height]);
		expect([result.width, result.height]).toEqual([referenceResult.width, referenceResult.height]);

		// Through MSE, the file shows the same way. (Chrome's MSE rejects FFmpeg's file, which leaves out the
		// ProjectionType, as its default allows; Mediabunny writes it.)
		const mse = await playThroughMse(bytes, 'video/webm; codecs="vp9"');
		expect([mse.width, mse.height]).toEqual([result.width, result.height]);
	});

	test('a packet copy of a WebM file keeps playing in Chrome', async () => {
		const source = await encodeWebM({ codec: 'vp8', audio: true });
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		await copyPackets(source, output);
		await output.finalize();

		const result = await playThroughMse(new Uint8Array(output.target.buffer!), 'video/webm; codecs="vp8, opus"');
		expect(result.buffered[0]![1]).toBeCloseTo(1.5, 1);
		expect(result.currentTime).toBeCloseTo(1.5, 1);
		expect(result.presentedFrames).toBeGreaterThan(0);
	});
});

type AudioTrackGenerator = MediaStreamTrack & { writable: WritableStream<AudioData> };

/**
 * A live audio track. Chrome can generate one from AudioData. Elsewhere, an oscillator plays into one, which needs the
 * page to be allowed to play audio: without a user gesture, an AudioContext stays suspended and records nothing.
 */
const createLiveAudioTrack = () => {
	const TrackGenerator = (globalThis as unknown as {
		MediaStreamTrackGenerator?: new (init: { kind: 'audio' }) => AudioTrackGenerator;
	}).MediaStreamTrackGenerator;

	if (TrackGenerator) {
		const generator = new TrackGenerator({ kind: 'audio' });
		const writer = generator.writable.getWriter();
		let timestamp = 0; // In microseconds
		const interval = setInterval(() => {
			const data = new Float32Array(960).map((_, i) => 0.1 * Math.sin((0.048 * timestamp + i) / 20));
			void writer.write(new AudioData({
				format: 'f32-planar',
				sampleRate: 48000,
				numberOfFrames: 960,
				numberOfChannels: 1,
				timestamp,
				data,
			}));
			timestamp += 20_000;
		}, 20);

		return {
			track: generator as MediaStreamTrack,
			stop: async () => {
				clearInterval(interval);
				await writer.close();
			},
		};
	}

	const audioContext = new AudioContext({ sampleRate: 48000 });
	const oscillator = audioContext.createOscillator();
	const destination = audioContext.createMediaStreamDestination();
	oscillator.connect(destination);
	oscillator.start();
	return { track: destination.stream.getAudioTracks()[0]!, stop: () => audioContext.close() };
};

/** Records a canvas animation with a tone. */
const record = async (mimeType: string, durationMs: number) => {
	const canvas = document.createElement('canvas');
	canvas.width = 160;
	canvas.height = 120;
	const context = canvas.getContext('2d')!;
	const stream = canvas.captureStream(30);
	const audio = createLiveAudioTrack();
	stream.addTrack(audio.track);

	const recorder = new MediaRecorder(stream, { mimeType });
	const chunks: Blob[] = [];
	recorder.ondataavailable = event => chunks.push(event.data);

	let frame = 0;
	const interval = setInterval(() => {
		context.fillStyle = `hsl(${frame++ * 10}, 80%, 50%)`;
		context.fillRect(0, 0, 160, 120);
	}, 33);

	try {
		// Asks for several chunks, like a live upload. (Chrome may still hold everything back until the end.)
		recorder.start(250);
		await new Promise(resolve => setTimeout(resolve, durationMs));
		recorder.stop();
		await new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));
	} finally {
		clearInterval(interval);
		await audio.stop();
		for (const track of stream.getTracks()) {
			track.stop();
		}
	}

	const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
	expect(bytes.length, 'MediaRecorder wrote no data').toBeGreaterThan(0);
	return bytes;
};

describe('MediaRecorder files', () => {
	test.for([
		{ mimeType: 'video/webm;codecs=vp8,opus', format: WEBM, video: 'vp8' },
		{ mimeType: 'video/webm;codecs=vp9,opus', format: WEBM, video: 'vp9' },
		{ mimeType: 'video/x-matroska;codecs=avc1,opus', format: MATROSKA, video: 'avc' },
	])('reads and decodes $mimeType', async ({ mimeType, format, video }, { skip }) => {
		// Capability guard: not every browser's MediaRecorder writes every combination (e.g. H.264 in Matroska)
		// (and WebKit's WPE port has no MediaRecorder at all)
		skip(
			typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(mimeType),
			`MediaRecorder can't record ${mimeType} here`,
		);

		const bytes = await record(mimeType, 1500);
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		expect(await input.getFormat()).toBe(format);
		expect(await input.getDurationFromMetadata()).toBe(null); // Unknown-size live file without Duration

		const videoTrack = (await input.getVideoTracks())[0]!;
		const audioTrack = (await input.getAudioTracks())[0]!;
		expect(await videoTrack.getCodec()).toBe(video);
		expect(await audioTrack.getCodec()).toBe('opus');
		expect([await videoTrack.getCodedWidth(), await videoTrack.getCodedHeight()]).toEqual([160, 120]);

		// Packets come in increasing timestamps, and the first one is a key frame
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
			packets.push(packet);
		}
		expect(packets.length).toBeGreaterThan(10);
		expect(packets[0]!.type).toBe('key');
		for (let i = 1; i < packets.length; i++) {
			expect(packets[i]!.timestamp).toBeGreaterThan(packets[i - 1]!.timestamp);
		}

		let decodedFrames = 0;
		for await (const sample of new VideoSampleSink(videoTrack).samples()) {
			expect(sample.codedWidth).toBe(160);
			decodedFrames++;
			sample.close();
		}
		expect(decodedFrames).toBe(packets.length);

		let decodedAudio = 0;
		for await (const sample of new AudioSampleSink(audioTrack).samples()) {
			decodedAudio += sample.duration;
			sample.close();
		}
		expect(decodedAudio).toBeGreaterThan(0.8);

		// Seeking needs no Cues
		const middle = packets[Math.floor(packets.length / 2)]!;
		const sink = new EncodedPacketSink(videoTrack);
		expect((await sink.getPacket(middle.timestamp))!.timestamp).toBe(middle.timestamp);
		expect((await sink.getKeyPacket(middle.timestamp))!.type).toBe('key');
	});
});
