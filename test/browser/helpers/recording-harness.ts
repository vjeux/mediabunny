// Helpers for the live recording suite: sources of synchronized flashes and beeps, a tap that measures where they
// enter a MediaStreamTrack, and the analysis of where they end up in a recorded file.

import { Input } from '../../../src/input.js';
import { ALL_FORMATS } from '../../../src/input-format.js';
import { BufferSource } from '../../../src/source.js';
import { AudioSampleSink, VideoSampleSink } from '../../../src/media-sink.js';

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Whether Web Audio can render here (it can't without a user gesture under a strict autoplay policy). */
export const createRunningAudioContext = async (options: AudioContextOptions = {}) => {
	const audioContext = new AudioContext(options);
	await Promise.race([audioContext.resume(), sleep(1000)]);
	if (audioContext.state !== 'running') {
		await audioContext.close();
		return null;
	}

	// A running context may not have rendered yet, and until it has, getOutputTimestamp() maps context time 0 to
	// performance time 0: anything scheduled from it would land at the page's age, minutes late in a long test run
	const start = performance.now();
	while (audioContext.currentTime === 0 && performance.now() - start < 2000) {
		await sleep(10);
	}
	if (audioContext.currentTime === 0) {
		await audioContext.close();
		return null;
	}

	return audioContext;
};

export type MarkerSourceOptions = {
	/** Canvas capture frame rate. */
	fps?: number;
	/** AudioContext sample rate; the browser's default when omitted. */
	sampleRate?: number;
	/** Channel count of the audio track. */
	channelCount?: number;
	/** Time between two markers. */
	periodMs?: number;
	/** Duration of each flash and beep. */
	markerMs?: number;
};

/**
 * Creates a canvas capture track that flashes white and a Web Audio track that beeps (1 kHz) at the same moments,
 * every `periodMs`, once `start()` is called. Returns null if Web Audio can't run here.
 */
export const createMarkerSource = async (options: MarkerSourceOptions = {}) => {
	const fps = options.fps ?? 30;
	const periodMs = options.periodMs ?? 500;
	const markerMs = options.markerMs ?? 100;

	const audioContext = await createRunningAudioContext(
		options.sampleRate !== undefined ? { sampleRate: options.sampleRate } : {},
	);
	if (!audioContext) {
		return null;
	}

	const destination = audioContext.createMediaStreamDestination();
	if (options.channelCount !== undefined) {
		destination.channelCount = options.channelCount;
	}
	const oscillator = audioContext.createOscillator();
	oscillator.frequency.value = 1000;
	const gain = audioContext.createGain();
	gain.gain.value = 0;
	oscillator.connect(gain).connect(destination);
	oscillator.start();

	const canvas = document.createElement('canvas');
	canvas.width = 64;
	canvas.height = 48;
	document.body.appendChild(canvas);
	const context = canvas.getContext('2d')!;
	context.fillStyle = 'black';
	context.fillRect(0, 0, canvas.width, canvas.height);

	const videoTrack = canvas.captureStream(fps).getVideoTracks()[0]!;
	const audioTrack = destination.stream.getAudioTracks()[0]!;

	let drawInterval: ReturnType<typeof setInterval> | null = null;

	return {
		videoTrack,
		audioTrack,
		audioContext,
		/** Starts emitting markers after `delayMs`, for `durationMs`. */
		start: (durationMs: number, delayMs = 300) => {
			const start = performance.now() + delayMs;

			// Schedule the beeps at the moments the flashes start
			const { contextTime, performanceTime } = audioContext.getOutputTimestamp();
			for (let time = 0; time < durationMs; time += periodMs) {
				const beepTime = contextTime! + (start + time - performanceTime!) / 1000;
				gain.gain.setValueAtTime(0.5, beepTime);
				gain.gain.setValueAtTime(0, beepTime + markerMs / 1000);
			}

			// Redraw every frame so the capture keeps its frame rate; flashes are white, everything else dark
			let frame = 0;
			drawInterval = setInterval(() => {
				const elapsed = performance.now() - start;
				const flashing = elapsed >= 0 && elapsed < durationMs && elapsed % periodMs < markerMs;
				context.fillStyle = flashing ? 'white' : `rgb(${frame++ % 32}, 0, 0)`;
				context.fillRect(0, 0, canvas.width, canvas.height);
			}, 1000 / fps / 2);
		},
		stop: async () => {
			if (drawInterval !== null) {
				clearInterval(drawInterval);
			}
			videoTrack.stop();
			audioTrack.stop();
			canvas.remove();
			await audioContext.close();
		},
	};
};

const getLuma = (context: OffscreenCanvasRenderingContext2D, source: CanvasImageSource) => {
	context.drawImage(source, 0, 0, 1, 1);
	const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
	return 0.299 * r! + 0.587 * g! + 0.114 * b!;
};

const createLumaContext = () => new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!;

/** Finds the onsets of 1 kHz beeps: samples above 0.25 after at least 100 ms of quiet. */
const createBeepDetector = () => {
	let quietFrames = Infinity;
	const onsets: number[] = [];

	return {
		onsets,
		push: (data: Float32Array, timestamp: number, sampleRate: number) => {
			for (let i = 0; i < data.length; i++) {
				if (Math.abs(data[i]!) < 0.25) {
					quietFrames++;
					continue;
				}
				if (quietFrames > 0.1 * sampleRate) {
					onsets.push(timestamp + i / sampleRate);
				}
				quietFrames = 0;
			}
		},
	};
};

/**
 * Taps a track with its own MediaStreamTrackProcessor to measure where markers enter it: flash frames by their arrival
 * time, beeps by their audio capture timestamp. Both in seconds, in the performance.now() time base.
 */
export const tapMarkers = (track: MediaStreamTrack) => {
	const flashes: number[] = [];
	const beeps = createBeepDetector();
	const lumaContext = createLumaContext();
	let wasBright = false;

	const processor = new MediaStreamTrackProcessor({ track: track as MediaStreamVideoTrack });
	const abortController = new AbortController();
	void processor.readable.pipeTo(new WritableStream({
		write: (value: VideoFrame | AudioData) => {
			if (value instanceof VideoFrame) {
				const isBright = getLuma(lumaContext, value) > 128;
				if (isBright && !wasBright) {
					flashes.push(performance.now() / 1000);
				}
				wasBright = isBright;
			} else {
				const data = new Float32Array(value.numberOfFrames);
				value.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
				beeps.push(data, value.timestamp / 1e6, value.sampleRate);
			}
			value.close();
		},
	}), { signal: abortController.signal }).catch(() => {});

	return { flashes, beeps: beeps.onsets, stop: () => abortController.abort() };
};

export type RecordingAnalysis = {
	videoTimestamps: number[];
	videoEnd: number | null;
	flashes: number[];
	audioStart: number | null;
	audioEnd: number | null;
	audioFrames: number;
	audioSampleRate: number | null;
	beeps: number[];
};

/** Decodes a recorded file and finds its flashes and beeps. */
export const analyzeRecording = async (bytes: Uint8Array | ArrayBuffer): Promise<RecordingAnalysis> => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const result: RecordingAnalysis = {
		videoTimestamps: [],
		videoEnd: null,
		flashes: [],
		audioStart: null,
		audioEnd: null,
		audioFrames: 0,
		audioSampleRate: null,
		beeps: [],
	};

	const videoTrack = await input.getPrimaryVideoTrack();
	if (videoTrack) {
		const lumaContext = createLumaContext();
		let wasBright = false;
		for await (using sample of new VideoSampleSink(videoTrack).samples()) {
			const frame = sample.toVideoFrame();
			const isBright = getLuma(lumaContext, frame) > 128;
			frame.close();
			if (isBright && !wasBright) {
				result.flashes.push(sample.timestamp);
			}
			wasBright = isBright;
			result.videoTimestamps.push(sample.timestamp);
			result.videoEnd = sample.timestamp + sample.duration;
		}
	}

	const audioTrack = await input.getPrimaryAudioTrack();
	if (audioTrack) {
		const beeps = createBeepDetector();
		for await (using sample of new AudioSampleSink(audioTrack).samples()) {
			const data = new Float32Array(sample.numberOfFrames);
			sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
			beeps.push(data, sample.timestamp, sample.sampleRate);
			result.audioStart ??= sample.timestamp;
			result.audioEnd = sample.timestamp + sample.duration;
			result.audioFrames += sample.numberOfFrames;
			result.audioSampleRate = sample.sampleRate;
		}
		result.beeps = beeps.onsets;
	}

	return result;
};

/** For each flash, the offset (beep - flash) to the closest beep less than `maxDistance` away. */
export const getBeepOffsets = (flashes: number[], beeps: number[], maxDistance = 0.2) => {
	const offsets: number[] = [];
	for (const flash of flashes) {
		const closest = beeps.reduce<number | null>(
			(best, beep) => best === null || Math.abs(beep - flash) < Math.abs(best - flash) ? beep : best,
			null,
		);
		if (closest !== null && Math.abs(closest - flash) < maxDistance) {
			offsets.push(closest - flash);
		}
	}

	return offsets;
};

export const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

export type AudioChunkOptions = {
	/** In seconds. */
	timestamp: number;
	numberOfFrames?: number;
	sampleRate?: number;
	numberOfChannels?: number;
	/** The value of every sample. */
	value?: number;
};

export const writeAudioChunk = (writer: WritableStreamDefaultWriter<AudioData>, options: AudioChunkOptions) => {
	const numberOfFrames = options.numberOfFrames ?? 480;
	const numberOfChannels = options.numberOfChannels ?? 1;
	return writer.write(new AudioData({
		format: 'f32-planar',
		sampleRate: options.sampleRate ?? 48000,
		numberOfChannels,
		numberOfFrames,
		timestamp: Math.round(options.timestamp * 1e6),
		data: new Float32Array(numberOfFrames * numberOfChannels).fill(options.value ?? 0.1),
	}));
};

export const writeVideoFrame = (
	writer: WritableStreamDefaultWriter<VideoFrame>,
	canvas: OffscreenCanvas,
	timestamp: number,
	color = 'red',
) => {
	const context = canvas.getContext('2d')!;
	context.fillStyle = color;
	context.fillRect(0, 0, canvas.width, canvas.height);
	return writer.write(new VideoFrame(canvas, { timestamp: Math.round(timestamp * 1e6) }));
};

/** Generator-backed audio and video tracks (Chromium only), which deliver exactly what's written to them. */
export const createGeneratorTracks = () => {
	const videoGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
	const audioGenerator = new MediaStreamTrackGenerator({ kind: 'audio' });

	return {
		videoTrack: videoGenerator as unknown as MediaStreamVideoTrack,
		audioTrack: audioGenerator as unknown as MediaStreamAudioTrack,
		videoWriter: videoGenerator.writable.getWriter(),
		audioWriter: audioGenerator.writable.getWriter(),
	};
};

/**
 * Replaces MediaStreamTrackProcessor with one whose frames the test enqueues directly, so media can be fed faster
 * than real time without the real processor dropping frames. Call `restore()` once the sources have started.
 */
export const installFakeTrackProcessor = () => {
	const globals = globalThis as { MediaStreamTrackProcessor?: unknown };
	const realProcessor = globals.MediaStreamTrackProcessor;
	const controllers = new Map<MediaStreamTrack, ReadableStreamDefaultController<VideoFrame | AudioData>>();

	globals.MediaStreamTrackProcessor = class {
		readable: ReadableStream<VideoFrame | AudioData>;

		constructor({ track }: { track: MediaStreamTrack }) {
			this.readable = new ReadableStream<VideoFrame | AudioData>({
				start: (controller) => {
					controllers.set(track, controller);
				},
			}, { highWaterMark: Infinity });
		}
	};

	return {
		controller: (track: MediaStreamTrack) => controllers.get(track)!,
		restore: () => {
			globals.MediaStreamTrackProcessor = realProcessor;
		},
	};
};

/**
 * Hands chunks to a stream's consumer one at a time, telling when the consumer has taken them. Chunks pushed once the
 * consumer has canceled the stream are closed and dropped.
 */
export class ConsumptionGate<T extends { close(): void }> {
	private controller!: ReadableStreamDefaultController<T>;
	private demand: (() => void) | null = null;
	private demandListeners: (() => void)[] = [];
	private canceled = false;

	readonly readable = new ReadableStream<T>({
		start: (controller) => {
			this.controller = controller;
		},
		// Called when the consumer reads, which it only does once it's done with the previous chunk
		pull: () => new Promise<void>((resolve) => {
			this.demand = resolve;
			this.notify();
		}),
		cancel: () => {
			this.canceled = true;
			this.notify();
		},
	}, { highWaterMark: 0 });

	/** Hands over the chunk once the consumer asks for one, and resolves once it asks for the next one. */
	async push(chunk: T) {
		await this.waitForDemand();
		if (this.canceled) {
			chunk.close();
			return;
		}

		const fulfill = this.demand!;
		this.demand = null;
		this.controller.enqueue(chunk);
		fulfill();
		await this.waitForDemand();
	}

	private async waitForDemand() {
		while (!this.demand && !this.canceled) {
			await new Promise<void>(resolve => this.demandListeners.push(resolve));
		}
	}

	private notify() {
		for (const listener of this.demandListeners.splice(0)) {
			listener();
		}
	}
}

/**
 * Replaces MediaStreamTrackProcessor with one that hands over chunks through a ConsumptionGate, so tests know exactly
 * when a source has taken each chunk, independently of timing. Call `restore()` once the sources have started.
 */
export const installGatedTrackProcessor = () => {
	const globals = globalThis as { MediaStreamTrackProcessor?: unknown };
	const realProcessor = globals.MediaStreamTrackProcessor;
	const gates = new Map<MediaStreamTrack, ConsumptionGate<VideoFrame | AudioData>>();

	globals.MediaStreamTrackProcessor = class {
		readable: ReadableStream<VideoFrame | AudioData>;

		constructor({ track }: { track: MediaStreamTrack }) {
			const gate = new ConsumptionGate<VideoFrame | AudioData>();
			gates.set(track, gate);
			this.readable = gate.readable;
		}
	};

	return {
		gate: (track: MediaStreamTrack) => gates.get(track)!,
		restore: () => {
			globals.MediaStreamTrackProcessor = realProcessor;
		},
	};
};
