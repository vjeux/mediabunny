import { AudioSampleSink } from '../../../src/media-sink.js';
import { Output } from '../../../src/output.js';
import { Mp4OutputFormat, OutputFormat } from '../../../src/output-format.js';
import { BufferTarget } from '../../../src/target.js';
import { AudioSampleSource } from '../../../src/media-source.js';
import { AudioSample } from '../../../src/sample.js';
import { Quality } from '../../../src/encode.js';
import { AudioCodec } from '../../../src/codec.js';
import { InputAudioTrack } from '../../../src/input-track.js';
import { assert } from '../../../src/misc.js';

/** One tone per channel, far enough apart to tell channels apart. The fourth one is low enough for an LFE channel. */
export const CHANNEL_TONES = [220, 330, 440, 55, 550, 660, 770, 880];

/** Interleaved f32 sines, one frequency per channel. */
export const createTones = (
	sampleRate: number,
	numberOfChannels: number,
	frames: number,
	frequencies = CHANNEL_TONES,
	amplitude = 0.3,
) => {
	const data = new Float32Array(frames * numberOfChannels);
	for (let i = 0; i < frames; i++) {
		for (let channel = 0; channel < numberOfChannels; channel++) {
			data[i * numberOfChannels + channel]
				= amplitude * Math.sin(2 * Math.PI * frequencies[channel]! * i / sampleRate);
		}
	}

	return data;
};

/** Integer triangle wave, exactly reproducible (used to check lossless codecs bit for bit). */
export const triangle = (n: number, period: number, amplitude: number) => {
	return Math.trunc(4 * amplitude * Math.abs((n % period) - period / 2) / period) - amplitude;
};

/** Amplitude of the given frequency in one channel of interleaved samples (Goertzel). */
export const toneAmplitude = (
	data: Float32Array,
	numberOfChannels: number,
	channel: number,
	frequency: number,
	sampleRate: number,
	start: number,
	length: number,
) => {
	const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
	let s1 = 0;
	let s2 = 0;
	for (let i = start; i < start + length; i++) {
		const s0 = data[i * numberOfChannels + channel]! + coefficient * s1 - s2;
		s2 = s1;
		s1 = s0;
	}

	return 2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coefficient * s1 * s2)) / length;
};

/**
 * For each channel, the index of the candidate tone that dominates it (-1 if none is clearly there). A correct channel
 * order gives [0, 1, 2, ...].
 */
export const channelToneMap = (
	data: Float32Array,
	numberOfChannels: number,
	sampleRate: number,
	start: number,
	length: number,
	frequencies = CHANNEL_TONES,
) => {
	const result: number[] = [];
	for (let channel = 0; channel < numberOfChannels; channel++) {
		let best = -1;
		let bestAmplitude = 0.05;
		for (let i = 0; i < numberOfChannels; i++) {
			const frequency = frequencies[i]!;
			const amplitude = toneAmplitude(data, numberOfChannels, channel, frequency, sampleRate, start, length);
			if (amplitude > bestAmplitude) {
				bestAmplitude = amplitude;
				best = i;
			}
		}
		result.push(best);
	}

	return result;
};

export type DecodedAudio = {
	data: Float32Array;
	numberOfChannels: number;
	sampleRate: number;
	timestamps: number[];
	durations: number[];
};

/** Decodes a whole track into interleaved f32. */
export const decodeTrack = async (track: InputAudioTrack): Promise<DecodedAudio> => {
	const sink = new AudioSampleSink(track);
	const chunks: Float32Array[] = [];
	const timestamps: number[] = [];
	const durations: number[] = [];
	let numberOfChannels = 0;
	let sampleRate = 0;

	for await (using sample of sink.samples()) {
		numberOfChannels = sample.numberOfChannels;
		sampleRate = sample.sampleRate;
		timestamps.push(sample.timestamp);
		durations.push(sample.duration);

		const chunk = new Float32Array(sample.allocationSize({ format: 'f32', planeIndex: 0 }) / 4);
		sample.copyTo(chunk, { format: 'f32', planeIndex: 0 });
		chunks.push(chunk);
	}

	const data = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.length;
	}

	return { data, numberOfChannels, sampleRate, timestamps, durations };
};

export type EncodeOptions = {
	codec: AudioCodec;
	data: Float32Array | Int16Array | Int32Array;
	format?: AudioSampleFormat;
	numberOfChannels: number;
	sampleRate: number;
	bitrate?: number;
	outputFormat?: OutputFormat;
	/** Feeds the input in chunks of this many frames instead of one sample. */
	chunkFrames?: number;
	timestamp?: number;
};

/** Encodes interleaved samples with the registered encoder and returns the file (MP4 unless specified). */
export const encodeAudio = async (options: EncodeOptions) => {
	const output = new Output({
		format: options.outputFormat ?? new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new AudioSampleSource({
		codec: options.codec,
		...(options.bitrate !== undefined ? { quality: new Quality({ bitrate: options.bitrate }) } : {}),
	} as ConstructorParameters<typeof AudioSampleSource>[0]);
	output.addAudioTrack(source);
	await output.start();

	const totalFrames = options.data.length / options.numberOfChannels;
	const chunkFrames = options.chunkFrames ?? totalFrames;
	const startTimestamp = options.timestamp ?? 0;
	for (let offset = 0; offset < totalFrames; offset += chunkFrames) {
		const frames = Math.min(chunkFrames, totalFrames - offset);
		const channels = options.numberOfChannels;
		using sample = new AudioSample({
			data: options.data.subarray(offset * channels, (offset + frames) * channels),
			format: options.format ?? 'f32',
			numberOfChannels: options.numberOfChannels,
			sampleRate: options.sampleRate,
			timestamp: startTimestamp + offset / options.sampleRate,
		});
		await source.add(sample);
	}

	source.close();
	await output.finalize();

	assert(output.target.buffer);
	return new Uint8Array(output.target.buffer);
};
