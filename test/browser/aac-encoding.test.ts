import { beforeAll, describe, expect, test } from 'vitest';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { Output } from '../../src/output.js';
import {
	AdtsOutputFormat,
	CmafOutputFormat,
	HlsOutputFormat,
	MkvOutputFormat,
	MovOutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	OutputFormat,
	WavOutputFormat,
} from '../../src/output-format.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { AudioBufferSource, AudioSampleSource } from '../../src/media-source.js';
import { AudioSample } from '../../src/sample.js';
import { Input } from '../../src/input.js';
import { BufferSource, CustomPathedSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink } from '../../src/media-sink.js';
import { canEncodeAudio, getFirstEncodableAudioCodec, Quality } from '../../src/encode.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';

// The impulse-based tests encode silence with one single-sample click per channel and look for the click again after
// decoding. AAC smears a click over a few samples but keeps its peak in place, so the peak's position tells whether
// encoder delay (priming) and container timing were handled correctly.

// Must be checked before the extension is registered, so that it reflects the platform's own AudioEncoder (Media
// Foundation on Windows, AudioToolbox on macOS; Chrome on Linux has none)
const nativeAacEncoding = await canEncodeAudio('aac');

// WebKitGTK's GStreamer AudioEncoder stamps every chunk with the timestamp of the input it came from, so there, the
// encoded timing can't be right
const nativeAacTimestampsAdvance = nativeAacEncoding && await (async () => {
	const timestamps: number[] = [];
	const encoder = new AudioEncoder({ output: chunk => timestamps.push(chunk.timestamp), error: () => {} });
	encoder.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1, bitrate: 64000 });
	encoder.encode(new AudioData({
		format: 'f32-planar', sampleRate: 48000, numberOfChannels: 1, numberOfFrames: 4800, timestamp: 0,
		data: new Float32Array(4800),
	}));
	await encoder.flush();
	encoder.close();
	return timestamps.length > 1 && new Set(timestamps).size === timestamps.length;
})();

// WebKitGTK's GStreamer decoders scramble the timestamps that follow a negative one (they flip the playback direction
// of their segment), so there, decoded AAC whose priming is signaled through a negative timestamp can't be checked
const negativeTimestampsDecodeCorrectly = await (async () => {
	const timestamps: number[] = [];
	const decoder = new AudioDecoder({
		output: (data) => {
			timestamps.push(data.timestamp);
			data.close();
		},
		error: () => {},
	});
	decoder.configure({ codec: 'pcm-s16', sampleRate: 48000, numberOfChannels: 1 });
	for (const timestamp of [-20000, 0, 20000]) {
		decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: new Uint8Array(1920) }));
	}
	await decoder.flush();
	decoder.close();
	return timestamps.join() === '-20000,0,20000';
})();

type ImpulseSignal = {
	sampleRate: number;
	numberOfChannels: number;
	numberOfFrames: number;
	impulseFrames: number[]; // Per channel
};

const createImpulseSignal = (signal: ImpulseSignal) => {
	const data = new Float32Array(signal.numberOfFrames * signal.numberOfChannels); // Planar
	for (let channel = 0; channel < signal.numberOfChannels; channel++) {
		data[channel * signal.numberOfFrames + signal.impulseFrames[channel]!] = 0.9;
	}

	return data;
};

const STEREO_48K: ImpulseSignal = {
	sampleRate: 48000,
	numberOfChannels: 2,
	numberOfFrames: 48000,
	impulseFrames: [12000, 24000],
};

const addImpulseSignal = async (source: AudioSampleSource, signal: ImpulseSignal, chunkSize = 1024) => {
	const planar = createImpulseSignal(signal);

	for (let offset = 0; offset < signal.numberOfFrames; offset += chunkSize) {
		const frames = Math.min(chunkSize, signal.numberOfFrames - offset);
		const data = new Float32Array(frames * signal.numberOfChannels);
		for (let channel = 0; channel < signal.numberOfChannels; channel++) {
			const start = channel * signal.numberOfFrames + offset;
			data.set(planar.subarray(start, start + frames), channel * frames);
		}

		using sample = new AudioSample({
			data,
			format: 'f32-planar',
			numberOfChannels: signal.numberOfChannels,
			sampleRate: signal.sampleRate,
			timestamp: offset / signal.sampleRate,
		});
		await source.add(sample);
	}
};

const encodeImpulseSignal = async (format: OutputFormat, signal: ImpulseSignal) => {
	const target = new BufferTarget();
	const output = new Output({ format, target });

	let firstPacketTimestamp: number | null = null;
	const source = new AudioSampleSource({
		codec: 'aac',
		quality: new Quality('high'),
		onEncodedPacket: (packet) => {
			firstPacketTimestamp ??= packet.timestamp;
		},
	});
	output.addAudioTrack(source);

	await output.start();
	await addImpulseSignal(source, signal);
	await output.finalize();

	assert(target.buffer);
	assert(firstPacketTimestamp !== null);

	return { bytes: new Uint8Array(target.buffer), firstPacketTimestamp: firstPacketTimestamp as number };
};

/** Decodes the primary audio track and returns the time of the loudest sample of every channel. */
const readImpulses = async (input: Input, skip: (condition: boolean, note?: string) => void) => {
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	skip(
		!negativeTimestampsDecodeCorrectly && await track.getFirstTimestamp() < 0,
		'the decoder scrambles negative timestamps here',
	);

	const numberOfChannels = await track.getNumberOfChannels();
	const peaks = Array.from({ length: numberOfChannels }, () => ({ time: -1, value: -1 }));

	for await (const sample of new AudioSampleSink(track).samples()) {
		for (let channel = 0; channel < numberOfChannels; channel++) {
			const values = new Float32Array(sample.numberOfFrames);
			sample.copyTo(values, { planeIndex: channel, format: 'f32-planar' });

			for (let i = 0; i < values.length; i++) {
				if (Math.abs(values[i]!) > peaks[channel]!.value) {
					peaks[channel] = { time: sample.timestamp + i / sample.sampleRate, value: Math.abs(values[i]!) };
				}
			}
		}

		sample.close();
	}

	return {
		codec: await track.getCodec(),
		sampleRate: await track.getSampleRate(),
		numberOfChannels,
		duration: await track.computeDuration(),
		peakTimes: peaks.map(x => x.time),
	};
};

type ContainerCase = {
	name: string;
	format: () => OutputFormat;
	// How far a peak may land from where it belongs, in seconds
	tolerance: number;
	// ADTS has no timestamps, so encoder priming can't be signaled and plays as leading silence
	keepsPriming?: boolean;
};

const TWO_SAMPLES = 2 / 48000;

const CONTAINER_CASES: ContainerCase[] = [
	{ name: 'MP4', format: () => new Mp4OutputFormat(), tolerance: TWO_SAMPLES },
	{
		name: 'MP4 (fragmented)',
		format: () => new Mp4OutputFormat({ fastStart: 'fragmented' }),
		tolerance: TWO_SAMPLES,
	},
	{ name: 'MOV', format: () => new MovOutputFormat(), tolerance: TWO_SAMPLES },
	// Matroska timestamps (and thereby CodecDelay) are stored in milliseconds here
	{ name: 'MKV', format: () => new MkvOutputFormat(), tolerance: 0.0006 },
	{ name: 'MPEG-TS', format: () => new MpegTsOutputFormat(), tolerance: TWO_SAMPLES },
	{ name: 'ADTS', format: () => new AdtsOutputFormat(), tolerance: TWO_SAMPLES, keepsPriming: true },
];

const defineAacEncodingTests = () => {
	for (const container of CONTAINER_CASES) {
		test(`${container.name}: keeps the timing, rate and channel count of encoded AAC`, async ({ skip }) => {
			const { bytes, firstPacketTimestamp } = await encodeImpulseSignal(container.format(), STEREO_48K);

			using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
			const result = await readImpulses(input, skip);

			expect(result.codec).toBe('aac');
			expect(result.sampleRate).toBe(48000);
			expect(result.numberOfChannels).toBe(2);

			// Encoders signal their priming through a negative first timestamp
			expect(firstPacketTimestamp).toBeLessThanOrEqual(0);
			const priming = -firstPacketTimestamp;
			const shift = container.keepsPriming ? priming : 0;

			for (let channel = 0; channel < 2; channel++) {
				const expectedTime = STEREO_48K.impulseFrames[channel]! / 48000 + shift;
				expect(Math.abs(result.peakTimes[channel]! - expectedTime)).toBeLessThanOrEqual(container.tolerance);
			}

			// The input lasts 1 s; flushing pads the last frame with silence
			expect(result.duration).toBeGreaterThanOrEqual(1);
			expect(result.duration).toBeLessThan(1 + priming + 2048 / 48000);
		});
	}

	test('CMAF: segments keep the timing of encoded AAC', async ({ skip }) => {
		const initTarget = new BufferTarget();
		const target = new BufferTarget();
		const output = new Output({ format: new CmafOutputFormat(), target, initTarget: () => initTarget });
		const source = new AudioSampleSource({ codec: 'aac', quality: new Quality('high') });
		output.addAudioTrack(source);

		await output.start();
		await addImpulseSignal(source, STEREO_48K);
		await output.finalize();

		using initInput = new Input({ source: new BufferSource(initTarget.buffer!), formats: ALL_FORMATS });
		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS, initInput });
		const result = await readImpulses(input, skip);

		expect(result.codec).toBe('aac');
		expect(Math.abs(result.peakTimes[0]! - 0.25)).toBeLessThanOrEqual(TWO_SAMPLES);
		expect(Math.abs(result.peakTimes[1]! - 0.5)).toBeLessThanOrEqual(TWO_SAMPLES);
	});

	test('HLS: MPEG-TS segments keep the timing of encoded AAC across segment boundaries', async ({ skip }) => {
		const files = new Map<string, BufferTarget>();
		let playlistText = '';
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new MpegTsOutputFormat(),
				targetDuration: 1,
				onPlaylist: (text) => {
					playlistText = text;
				},
			}),
			target: new PathedTarget('master.m3u8', ({ path }) => {
				const target = new BufferTarget();
				files.set(path, target);
				return target;
			}),
		});
		let firstPacketTimestamp: number | null = null;
		const source = new AudioSampleSource({
			codec: 'aac',
			quality: new Quality('high'),
			onEncodedPacket: (packet) => {
				firstPacketTimestamp ??= packet.timestamp;
			},
		});
		output.addAudioTrack(source);

		// Clicks in the third and fourth second, so they sit in later segments
		const signal: ImpulseSignal = {
			sampleRate: 48000,
			numberOfChannels: 2,
			numberOfFrames: 4 * 48000,
			impulseFrames: [2.25 * 48000, 3.5 * 48000],
		};

		await output.start();
		await addImpulseSignal(source, signal);
		await output.finalize();

		expect(playlistText.match(/#EXTINF/g)!.length).toBeGreaterThanOrEqual(3);

		using input = new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => {
				const target = files.get(path);
				assert(target?.buffer);
				return new BufferSource(target.buffer);
			}),
			formats: ALL_FORMATS,
		});
		const result = await readImpulses(input, skip);

		expect(result.codec).toBe('aac');
		// The segments' media starts with the first packet (see HlsOutputFormatOptions.mediaTimestampBase), so encoder
		// priming plays as leading silence, just like in ADTS
		assert(firstPacketTimestamp !== null);
		const priming = -(firstPacketTimestamp as number);
		expect(Math.abs(result.peakTimes[0]! - (2.25 + priming))).toBeLessThanOrEqual(TWO_SAMPLES);
		expect(Math.abs(result.peakTimes[1]! - (3.5 + priming))).toBeLessThanOrEqual(TWO_SAMPLES);
	});

	test('5.1 AAC keeps every channel in place', async ({ skip }) => {
		const signal: ImpulseSignal = {
			sampleRate: 48000,
			numberOfChannels: 6,
			numberOfFrames: 48000,
			impulseFrames: [4800, 9600, 14400, 19200, 24000, 28800],
		};
		const { bytes } = await encodeImpulseSignal(new Mp4OutputFormat(), signal);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const result = await readImpulses(input, skip);

		expect(result.numberOfChannels).toBe(6);
		for (const channel of [0, 1, 2, 4, 5]) { // The LFE channel (3) is low-passed, so its click spreads out
			expect(Math.abs(result.peakTimes[channel]! - signal.impulseFrames[channel]! / 48000))
				.toBeLessThanOrEqual(TWO_SAMPLES);
		}
	});

	test('44.1 kHz mono AAC keeps its timing', async ({ skip }) => {
		const signal: ImpulseSignal = {
			sampleRate: 44100,
			numberOfChannels: 1,
			numberOfFrames: 44100,
			impulseFrames: [22050],
		};
		const { bytes } = await encodeImpulseSignal(new Mp4OutputFormat(), signal);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const result = await readImpulses(input, skip);

		expect(result.sampleRate).toBe(44100);
		expect(result.numberOfChannels).toBe(1);
		expect(Math.abs(result.peakTimes[0]! - 0.5)).toBeLessThanOrEqual(2 / 44100);
	});

	test('AudioBufferSource doesn\'t drift over 20 s of 10 ms buffers', { timeout: 30_000 }, async ({ skip }) => {
		const sampleRate = 44100;
		const bufferFrames = 441;
		const impulseFrame = 19.5 * sampleRate;
		const context = new OfflineAudioContext(2, 1, sampleRate);

		const target = new BufferTarget();
		const output = new Output({ format: new Mp4OutputFormat(), target });
		const source = new AudioBufferSource({ codec: 'aac', quality: new Quality('high') });
		output.addAudioTrack(source);
		await output.start();

		for (let i = 0; i < 2000; i++) {
			const buffer = context.createBuffer(2, bufferFrames, sampleRate);
			const offset = impulseFrame - i * bufferFrames;
			if (offset >= 0 && offset < bufferFrames) {
				buffer.getChannelData(0)[offset] = 0.9;
				buffer.getChannelData(1)[offset] = 0.9;
			}
			await source.add(buffer);
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const result = await readImpulses(input, skip);

		expect(Math.abs(result.peakTimes[0]! - 19.5)).toBeLessThanOrEqual(2 / sampleRate);
		expect(result.duration).toBeGreaterThanOrEqual(20);
	});

	test('Conversion to AAC keeps the timing of a 22.05 kHz WAV', async ({ skip }) => {
		const wavTarget = new BufferTarget();
		const wavOutput = new Output({ format: new WavOutputFormat(), target: wavTarget });
		const wavSource = new AudioSampleSource({ codec: 'pcm-s16' });
		wavOutput.addAudioTrack(wavSource);
		await wavOutput.start();
		await addImpulseSignal(wavSource, {
			sampleRate: 22050,
			numberOfChannels: 2,
			numberOfFrames: 22050,
			impulseFrames: [5512, 11025],
		});
		await wavOutput.finalize();

		using wavInput = new Input({ source: new BufferSource(wavTarget.buffer!), formats: ALL_FORMATS });
		const target = new BufferTarget();
		const conversion = await Conversion.init({
			input: wavInput,
			output: new Output({ format: new Mp4OutputFormat(), target }),
			audio: { codec: 'aac' },
		});
		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const result = await readImpulses(input, skip);

		// Encoders that can't take 22.05 kHz get resampled audio
		expect(result.codec).toBe('aac');
		expect(Math.abs(result.peakTimes[0]! - 5512 / 22050)).toBeLessThanOrEqual(2 / 22050);
		expect(Math.abs(result.peakTimes[1]! - 0.5)).toBeLessThanOrEqual(2 / 22050);
	});

	test('AAC is the first encodable audio codec of the containers that prefer it', async () => {
		const formats = [
			new Mp4OutputFormat(),
			new MovOutputFormat(),
			new MkvOutputFormat(),
			new MpegTsOutputFormat(),
			new AdtsOutputFormat(),
			new CmafOutputFormat(),
		];

		for (const format of formats) {
			expect(await getFirstEncodableAudioCodec(format.getSupportedAudioCodecs())).toBe('aac');
		}
	});
};

// Runs where the browser itself can encode AAC (Windows, macOS)
describe.runIf(nativeAacEncoding && nativeAacTimestampsAdvance)('Native AAC encoding', () => {
	defineAacEncodingTests();
});

// Runs everywhere. Must stay after the native tests, since the registered extension takes precedence
describe('AAC encoding with @mediabunny/aac-encoder', () => {
	beforeAll(() => {
		registerAacEncoder();
	});

	defineAacEncodingTests();
});
