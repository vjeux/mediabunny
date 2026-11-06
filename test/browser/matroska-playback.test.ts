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
	VideoSample,
	VideoSampleSink,
	VideoSampleSource,
	WEBM,
	WebMOutputFormat,
} from '../../src/index.js';
import { isFirefox, isWebKit } from '../../src/misc.js';

// Matroska/WebM interoperability with Chrome: files Mediabunny writes must play through Media Source Extensions (which
// uses Chromium's own WebM parser) and the <video> element, and files Chrome's MediaRecorder writes must demux and
// decode.

const encodeWebM = async (options: {
	codec: 'vp8' | 'vp9' | 'av1';
	audio?: boolean;
	appendOnly?: boolean;
	rotation?: 0 | 90 | 180 | 270;
	frames?: number;
}) => {
	const output = new Output({
		format: new WebMOutputFormat({ appendOnly: options.appendOnly }),
		target: new BufferTarget(),
	});
	const videoSource = new VideoSampleSource({ codec: options.codec, bitrate: new Quality('low') });
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

/** Appends the file to a SourceBuffer in small pieces, like a stream would, and reports what Chrome made of it. */
const playThroughMse = async (bytes: Uint8Array, mimeType: string) => {
	expect(MediaSource.isTypeSupported(mimeType)).toBe(true);

	const video = document.createElement('video');
	video.muted = true;
	const mediaSource = new MediaSource();
	const url = URL.createObjectURL(mediaSource);
	video.src = url;

	try {
		await new Promise(resolve => mediaSource.addEventListener('sourceopen', resolve, { once: true }));
		const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
		const errors: string[] = [];
		sourceBuffer.addEventListener('error', () => errors.push('SourceBuffer error'));
		video.addEventListener('error', () => errors.push(`video error: ${video.error?.message}`));

		const chunkSize = 4096;
		for (let i = 0; i < bytes.length && errors.length === 0; i += chunkSize) {
			sourceBuffer.appendBuffer(toArrayBuffer(bytes.subarray(i, i + chunkSize)));
			await new Promise(resolve => sourceBuffer.addEventListener('updateend', resolve, { once: true }));
		}

		const buffered: number[][] = [];
		for (let i = 0; i < sourceBuffer.buffered.length; i++) {
			buffered.push([sourceBuffer.buffered.start(i), sourceBuffer.buffered.end(i)]);
		}

		return { errors, buffered, width: video.videoWidth, height: video.videoHeight };
	} finally {
		URL.revokeObjectURL(url);
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
	test.each([
		{ codec: 'vp8' as const, mimeType: 'video/webm; codecs="vp8, opus"' },
		{ codec: 'vp9' as const, mimeType: 'video/webm; codecs="vp9, opus"' },
		{ codec: 'av1' as const, mimeType: 'video/webm; codecs="av01.0.04M.08, opus"' },
	])('$codec + Opus plays through Media Source Extensions', async ({ codec, mimeType }) => {
		const bytes = await encodeWebM({ codec, audio: true });
		const result = await playThroughMse(bytes, mimeType);
		expect(result.errors).toEqual([]);
		expect(result.buffered.length).toBe(1);
		expect(result.buffered[0]![0]).toBeLessThanOrEqual(0.01);
		expect(result.buffered[0]![1]).toBeCloseTo(1.5, 1);
		expect([result.width, result.height]).toEqual([160, 120]);
	});

	test('append-only output plays through Media Source Extensions while it is being written', async () => {
		const bytes = await encodeWebM({ codec: 'vp9', audio: true, appendOnly: true });
		const result = await playThroughMse(bytes, 'video/webm; codecs="vp9, opus"');
		expect(result.errors).toEqual([]);
		expect(result.buffered.length).toBe(1);
		expect(result.buffered[0]![1]).toBeCloseTo(1.5, 1);
	});

	test('the <video> element reads the duration, size and rotation', async () => {
		const bytes = await encodeWebM({ codec: 'vp9', rotation: 90 });
		const result = await loadInVideoElement(bytes, 'video/webm');
		expect(result.duration).toBeCloseTo(1.5, 2);

		// Firefox's WebM demuxer ignores the Matroska rotation, and so does WebKit's GStreamer-based one
		const rotatedSize = isFirefox() || isWebKit() ? [160, 120] : [120, 160];
		expect([result.width, result.height]).toEqual(rotatedSize);

		const mse = await playThroughMse(bytes, 'video/webm; codecs="vp9"');
		expect([mse.width, mse.height]).toEqual(rotatedSize);
	});

	test('a packet copy of a WebM file keeps playing in Chrome', async () => {
		const source = await encodeWebM({ codec: 'vp8', audio: true });
		using input = new Input({ source: new BufferSource(source), formats: ALL_FORMATS });
		const [videoTrack, audioTrack] = [(await input.getVideoTracks())[0]!, (await input.getAudioTracks())[0]!];

		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const videoSource = new EncodedVideoPacketSource('vp8');
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
		await output.finalize();

		const result = await playThroughMse(new Uint8Array(output.target.buffer!), 'video/webm; codecs="vp8, opus"');
		expect(result.errors).toEqual([]);
		expect(result.buffered[0]![1]).toBeCloseTo(1.5, 1);
	});
});

const record = async (mimeType: string, durationMs: number) => {
	const canvas = document.createElement('canvas');
	canvas.width = 160;
	canvas.height = 120;
	const context = canvas.getContext('2d')!;
	const stream = canvas.captureStream(30);

	const audioContext = new AudioContext({ sampleRate: 48000 });
	const oscillator = audioContext.createOscillator();
	const destination = audioContext.createMediaStreamDestination();
	oscillator.connect(destination);
	oscillator.start();
	for (const track of destination.stream.getAudioTracks()) {
		stream.addTrack(track);
	}

	const recorder = new MediaRecorder(stream, { mimeType });
	const chunks: Blob[] = [];
	recorder.ondataavailable = event => chunks.push(event.data);

	let frame = 0;
	const interval = setInterval(() => {
		context.fillStyle = `hsl(${frame++ * 10}, 80%, 50%)`;
		context.fillRect(0, 0, 160, 120);
	}, 33);

	recorder.start(250); // Several chunks, like a live upload
	await new Promise(resolve => setTimeout(resolve, durationMs));
	recorder.stop();
	await new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));
	clearInterval(interval);
	await audioContext.close();

	return new Uint8Array(await new Blob(chunks).arrayBuffer());
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

		const bytes = await record(mimeType, 1200);
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
