/*!
 * Encoding harness for the encoder configuration suite: synthetic frames and audio, an encode helper that records
 * what the encoder was configured with and what it emitted, and read-back helpers.
 */

import {
	ALL_FORMATS,
	AudioCodec,
	AudioEncodingConfig,
	AudioSample,
	AudioSampleSink,
	AudioSampleSource,
	BufferSource,
	BufferTarget,
	EncodedPacket,
	EncodedPacketSink,
	Input,
	InputAudioTrack,
	InputVideoTrack,
	MkvOutputFormat,
	MovOutputFormat,
	Mp4OutputFormat,
	Output,
	OutputFormat,
	VideoCodec,
	VideoEncodingConfig,
	VideoSample,
	VideoSampleSink,
	VideoSampleSource,
	WebMOutputFormat,
} from '../../../src/index.js';
import { toUint8Array } from '../../../src/misc.js';

export type FrameKind = 'I420' | 'I420A' | 'RGBA' | 'textured';

/**
 * A frame with a gradient and a moving bar, so encoders have something to work with. I420A frames are opaque on the
 * left half and have an alpha of 64 on the right half. Textured frames are moving, slightly noisy waves that take
 * enough bits for rate control to be measurable.
 */
export const makeFrame = (options: {
	width: number;
	height: number;
	index: number;
	timestamp: number;
	duration: number;
	kind?: FrameKind;
	colorSpace?: VideoColorSpaceInit;
	displayWidth?: number;
	displayHeight?: number;
}) => {
	const { width, height, index, timestamp, duration } = options;
	const kind = options.kind ?? 'I420';
	const bar = (index * 8) % Math.max(width, 1);

	if (kind === 'RGBA') {
		const data = new Uint8Array(width * height * 4);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const o = 4 * (y * width + x);
				data[o] = Math.abs(x - bar) < 4 ? 255 : (x * 255 / Math.max(width - 1, 1)) | 0;
				data[o + 1] = (y * 255 / Math.max(height - 1, 1)) | 0;
				data[o + 2] = 96;
				data[o + 3] = 255;
			}
		}
		return new VideoSample(data, { format: 'RGBA', codedWidth: width, codedHeight: height, timestamp, duration });
	}

	const chromaWidth = Math.ceil(width / 2);
	const chromaHeight = Math.ceil(height / 2);
	const lumaSize = width * height;
	const chromaSize = chromaWidth * chromaHeight;
	const data = new Uint8Array(lumaSize + 2 * chromaSize + (kind === 'I420A' ? lumaSize : 0));

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			data[y * width + x] = kind === 'textured'
				? 128 + 60 * Math.sin(x * 0.05 + index * 0.3) * Math.cos(y * 0.07 - index * 0.2)
				+ ((x * 7 + y * 13 + index * 31) % 9) - 4
				: Math.abs(x - bar) < 4 ? 235 : 16 + ((x + 2 * y) % 200);
		}
	}
	data.fill(110, lumaSize, lumaSize + chromaSize);
	data.fill(150, lumaSize + chromaSize, lumaSize + 2 * chromaSize);

	if (kind === 'I420A') {
		const alphaOffset = lumaSize + 2 * chromaSize;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				data[alphaOffset + y * width + x] = x < width / 2 ? 255 : 64;
			}
		}
	}

	return new VideoSample(data, {
		format: kind === 'textured' ? 'I420' : kind,
		codedWidth: width,
		codedHeight: height,
		displayWidth: options.displayWidth,
		displayHeight: options.displayHeight,
		timestamp,
		duration,
		colorSpace: options.colorSpace,
	});
};

export type ContainerKind = 'mp4' | 'mov' | 'webm' | 'mkv';

const makeFormat = (container: ContainerKind): OutputFormat => {
	if (container === 'mp4') {
		return new Mp4OutputFormat();
	} else if (container === 'mov') {
		return new MovOutputFormat();
	} else if (container === 'webm') {
		return new WebMOutputFormat();
	} else {
		return new MkvOutputFormat();
	}
};

export type VideoEncodeResult = {
	buffer: ArrayBuffer | null;
	error: unknown;
	encoderConfigs: VideoEncoderConfig[];
	decoderConfigs: VideoDecoderConfig[];
	packets: EncodedPacket[];
	encodedSampleTimestamps: number[];
};

/** Encodes synthetic frames with a VideoSampleSource, recording the encoder configs, decoder configs and packets. */
export const encodeVideo = async (options: {
	config: VideoEncodingConfig;
	container: ContainerKind;
	width: number;
	height: number;
	frameCount: number;
	frameRate?: number;
	timestamps?: number[];
	/** Per-frame sizes, overriding width and height. */
	sizes?: [number, number][];
	kind?: FrameKind;
	colorSpace?: VideoColorSpaceInit;
	displaySize?: [number, number];
	trackMetadata?: Parameters<Output['addVideoTrack']>[1];
}): Promise<VideoEncodeResult> => {
	const frameRate = options.frameRate ?? 30;
	const result: VideoEncodeResult = {
		buffer: null,
		error: null,
		encoderConfigs: [],
		decoderConfigs: [],
		packets: [],
		encodedSampleTimestamps: [],
	};

	const output = new Output({ format: makeFormat(options.container), target: new BufferTarget() });
	const source = new VideoSampleSource({
		...options.config,
		onEncoderConfig: (config) => {
			result.encoderConfigs.push({ ...config });
			options.config.onEncoderConfig?.(config);
		},
		onEncodedPacket: (packet, meta) => {
			result.packets.push(packet);
			if (meta?.decoderConfig) {
				result.decoderConfigs.push({ ...meta.decoderConfig });
			}
			options.config.onEncodedPacket?.(packet, meta);
		},
		onEncodedSample: (sample) => {
			result.encodedSampleTimestamps.push(sample.timestamp);
		},
	});

	try {
		output.addVideoTrack(source, options.trackMetadata);
		await output.start();

		// Each frame is added by a helper function, keeping `using` out of the loop body (esbuild lowers `using` in
		// loops with function-scoped state, which misbehaves once an iteration throws)
		const addFrame = async (i: number) => {
			const timestamp = options.timestamps?.[i] ?? i / frameRate;
			const nextTimestamp = options.timestamps?.[i + 1] ?? timestamp + 1 / frameRate;
			using sample = makeFrame({
				width: options.sizes?.[i]?.[0] ?? options.width,
				height: options.sizes?.[i]?.[1] ?? options.height,
				index: i,
				timestamp,
				duration: nextTimestamp - timestamp,
				kind: options.kind,
				colorSpace: options.colorSpace,
				displayWidth: options.displaySize?.[0],
				displayHeight: options.displaySize?.[1],
			});
			await source.add(sample);
		};

		for (let i = 0; i < options.frameCount; i++) {
			await addFrame(i);
		}

		await output.finalize();
		result.buffer = output.target.buffer;
	} catch (error) {
		result.error = error;
		await output.cancel().catch(() => {});
	}

	return result;
};

export const openVideoTrack = async (buffer: ArrayBuffer) => {
	const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	if (!track) {
		throw new Error('No video track in the output.');
	}

	return { input, track };
};

export const readPackets = async (track: InputVideoTrack | InputAudioTrack) => {
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	return packets;
};

export type DecodedFrameInfo = {
	timestamp: number;
	format: VideoSample['format'];
	codedWidth: number;
	codedHeight: number;
	colorSpace: VideoColorSpaceInit;
	/** Mean alpha of the left and right halves of the middle row, for formats with alpha. */
	alpha: [number, number] | null;
};

export const decodeVideo = async (track: InputVideoTrack) => {
	const frames: DecodedFrameInfo[] = [];

	for await (using sample of new VideoSampleSink(track).samples()) {
		let alpha: [number, number] | null = null;
		const isPacked = sample.format === 'RGBA' || sample.format === 'BGRA';
		if (sample.format === 'I420A' || isPacked) {
			const size = sample.allocationSize();
			const bytes = new Uint8Array(size);
			await sample.copyTo(bytes);
			const { codedWidth: w, codedHeight: h } = sample;
			// The alpha plane follows the Y, U and V planes in I420A, and is every fourth byte in RGBA and BGRA
			const alphaOffset = isPacked ? 3 : w * h + 2 * Math.ceil(w / 2) * Math.ceil(h / 2);
			const step = isPacked ? 4 : 1;
			const row = alphaOffset + Math.floor(h / 2) * w * step;
			let left = 0;
			let right = 0;
			const half = Math.floor(w / 2);
			for (let x = 0; x < half; x++) {
				left += bytes[row + x * step]!;
				right += bytes[row + (half + x) * step]!;
			}
			alpha = [left / half, right / half];
		}

		frames.push({
			timestamp: sample.timestamp,
			format: sample.format,
			codedWidth: sample.codedWidth,
			codedHeight: sample.codedHeight,
			colorSpace: sample.colorSpace.toJSON(),
			alpha,
		});
	}

	return frames;
};

export const descriptionBytes = (config: VideoDecoderConfig | AudioDecoderConfig) => {
	return config.description ? toUint8Array(config.description) : null;
};

/** A quiet tone with a click at `clickTime`, interleaved f32. */
export const makeAudio = (options: {
	sampleRate: number;
	numberOfChannels: number;
	duration: number;
	timestamp?: number;
	clickTime?: number;
}) => {
	const { sampleRate, numberOfChannels } = options;
	const frameCount = Math.round(options.duration * sampleRate);
	const clickFrame = options.clickTime !== undefined ? Math.round(options.clickTime * sampleRate) : -1;
	const data = new Float32Array(frameCount * numberOfChannels);

	for (let i = 0; i < frameCount; i++) {
		for (let ch = 0; ch < numberOfChannels; ch++) {
			data[i * numberOfChannels + ch] = i === clickFrame
				? 0.9
				: 0.1 * Math.sin(2 * Math.PI * 440 * (ch + 1) * i / sampleRate);
		}
	}

	return new AudioSample({
		data,
		format: 'f32',
		sampleRate,
		numberOfChannels,
		timestamp: options.timestamp ?? 0,
	});
};

export type AudioEncodeResult = {
	buffer: ArrayBuffer | null;
	error: unknown;
	encoderConfigs: AudioEncoderConfig[];
	decoderConfigs: AudioDecoderConfig[];
	packets: EncodedPacket[];
};

export const encodeAudio = async (options: {
	codec: AudioCodec;
	config?: Omit<AudioEncodingConfig, 'codec'>;
	container: ContainerKind;
	sample: AudioSample;
}): Promise<AudioEncodeResult> => {
	const result: AudioEncodeResult = {
		buffer: null,
		error: null,
		encoderConfigs: [],
		decoderConfigs: [],
		packets: [],
	};
	const output = new Output({ format: makeFormat(options.container), target: new BufferTarget() });
	const source = new AudioSampleSource({
		codec: options.codec,
		...options.config,
		onEncoderConfig: (config) => {
			result.encoderConfigs.push({ ...config });
		},
		onEncodedPacket: (packet, meta) => {
			result.packets.push(packet);
			if (meta?.decoderConfig) {
				result.decoderConfigs.push({ ...meta.decoderConfig });
			}
		},
	} as AudioEncodingConfig);

	try {
		output.addAudioTrack(source);
		await output.start();
		await source.add(options.sample);
		await output.finalize();
		result.buffer = output.target.buffer;
	} catch (error) {
		result.error = error;
		await output.cancel().catch(() => {});
	} finally {
		options.sample.close();
	}

	return result;
};

export const openAudioTrack = async (buffer: ArrayBuffer) => {
	const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track in the output.');
	}

	return { input, track };
};

/** Decodes the first channel, returning the frame count, the time span and the time of the loudest sample. */
export const decodeAudio = async (track: InputAudioTrack) => {
	let frameCount = 0;
	let start = Infinity;
	let end = -Infinity;
	let peakTime = 0;
	let peakValue = 0;
	let sampleRate = 0;

	for await (using sample of new AudioSampleSink(track).samples()) {
		sampleRate = sample.sampleRate;
		start = Math.min(start, sample.timestamp);
		end = Math.max(end, sample.timestamp + sample.duration);
		const values = new Float32Array(sample.numberOfFrames);
		sample.copyTo(values, { planeIndex: 0, format: 'f32-planar' });
		for (let i = 0; i < values.length; i++) {
			if (Math.abs(values[i]!) > peakValue) {
				peakValue = Math.abs(values[i]!);
				peakTime = sample.timestamp + i / sample.sampleRate;
			}
		}
		frameCount += sample.numberOfFrames;
	}

	return { frameCount, start, end, peakTime, peakValue, sampleRate };
};

export const VIDEO_TEST_CODECS: VideoCodec[] = ['avc', 'hevc', 'vp8', 'vp9', 'av1'];

/** The container this suite writes a codec into: MP4 for the H.26x codecs, which WebM can't hold, WebM otherwise. */
export const containerFor = (codec: VideoCodec): ContainerKind => {
	return codec === 'avc' || codec === 'hevc' ? 'mp4' : 'webm';
};

/** An ISOBMFF and a Matroska-family container that can hold the codec. */
export const containersFor = (codec: VideoCodec): ContainerKind[] => {
	return codec === 'avc' || codec === 'hevc' ? ['mp4', 'mkv'] : ['mp4', 'webm'];
};
