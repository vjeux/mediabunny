import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { AC3_REGISTRATION_DESCRIPTOR, EAC3_REGISTRATION_DESCRIPTOR } from '../../src/codec-data.js';
import { canEncode, Quality } from '../../src/encode.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { registerAc3Decoder, registerAc3Encoder } from '@mediabunny/ac3';
import { assert } from '../../src/misc.js';
import { canEncodeAudio } from '../../src/encode.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('reads AC-3 from MP4', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mp4')),
		formats: ALL_FORMATS,
	});

	const audioTrack = (await input.getPrimaryAudioTrack())!;
	const decoderConfig = (await audioTrack.getDecoderConfig())!;

	expect(await audioTrack.getCodec()).toBe('ac3');
	expect(decoderConfig.description).toBeUndefined();
});

test('reads E-AC-3 from MP4', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3.mp4')),
		formats: ALL_FORMATS,
	});

	const audioTrack = (await input.getPrimaryAudioTrack())!;
	const decoderConfig = (await audioTrack.getDecoderConfig())!;

	expect(await audioTrack.getCodec()).toBe('eac3');
	expect(decoderConfig.description).toBeUndefined();
});

test('reads and writes AC-3 in MPEG-TS', async () => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.ts')),
		formats: ALL_FORMATS,
	});

	const originalAudioTrack = (await originalInput.getPrimaryAudioTrack())!;

	expect(await originalAudioTrack.getCodec()).toBe('ac3');
	expect(await originalAudioTrack.getInternalCodecId()).toBe(0x81);

	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input: originalInput, output });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const newAudioTrack = (await newInput.getPrimaryAudioTrack())!;

	expect(await newAudioTrack.getCodec()).toBe('ac3');
	expect(await newAudioTrack.getInternalCodecId()).toBe(0x81);
	expect(await newAudioTrack.getNumberOfChannels()).toBe(await originalAudioTrack.getNumberOfChannels());
	expect(await newAudioTrack.getSampleRate()).toBe(await originalAudioTrack.getSampleRate());

	// Verify registration_descriptor is present
	const buffer = new Uint8Array(output.target.buffer!);
	let found = false;
	for (let i = 0; i < buffer.length - AC3_REGISTRATION_DESCRIPTOR.length; i++) {
		if (AC3_REGISTRATION_DESCRIPTOR.every((byte, j) => buffer[i + j] === byte)) {
			found = true;
			break;
		}
	}
	expect(found).toBe(true);
});

test('reads and writes E-AC-3 in MPEG-TS', async () => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3.ts')),
		formats: ALL_FORMATS,
	});

	const originalAudioTrack = (await originalInput.getPrimaryAudioTrack())!;

	expect(await originalAudioTrack.getCodec()).toBe('eac3');
	expect(await originalAudioTrack.getInternalCodecId()).toBe(0x87);

	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input: originalInput, output });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const newAudioTrack = (await newInput.getPrimaryAudioTrack())!;

	expect(await newAudioTrack.getCodec()).toBe('eac3');
	expect(await newAudioTrack.getInternalCodecId()).toBe(0x87);
	expect(await newAudioTrack.getNumberOfChannels()).toBe(await originalAudioTrack.getNumberOfChannels());
	expect(await newAudioTrack.getSampleRate()).toBe(await originalAudioTrack.getSampleRate());

	// Verify registration_descriptor is present
	const buffer = new Uint8Array(output.target.buffer!);
	let found = false;
	for (let i = 0; i < buffer.length - EAC3_REGISTRATION_DESCRIPTOR.length; i++) {
		if (EAC3_REGISTRATION_DESCRIPTOR.every((byte, j) => buffer[i + j] === byte)) {
			found = true;
			break;
		}
	}
	expect(found).toBe(true);
});

test('Custom coder registration', async () => {
	using ac3Input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mp4')),
		formats: ALL_FORMATS,
	});
	using eac3Input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3.mp4')),
		formats: ALL_FORMATS,
	});

	const ac3Track = (await ac3Input.getPrimaryAudioTrack())!;
	const eac3Track = (await eac3Input.getPrimaryAudioTrack())!;

	// Before registration, nothing can decode or encode AC3/EAC3
	expect(await ac3Track.canDecode()).toBe(false);
	expect(await eac3Track.canDecode()).toBe(false);
	expect(await canEncode('ac3')).toBe(false);
	expect(await canEncode('eac3')).toBe(false);

	registerAc3Decoder();
	registerAc3Encoder();

	// After registration, both should work
	expect(await ac3Track.canDecode()).toBe(true);
	expect(await eac3Track.canDecode()).toBe(true);
	expect(await canEncode('ac3')).toBe(true);
	expect(await canEncode('eac3')).toBe(true);
});

test('AC-3 decoding', async () => {
	registerAc3Decoder();

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mp4')),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	const { packetCount } = await track.computePacketStats();
	const trackNumberOfChannels = await track.getNumberOfChannels();
	const trackSampleRate = await track.getSampleRate();
	const sink = new AudioSampleSink(track);

	let sampleCount = 0;
	let nextTimestamp = 0;

	for await (using sample of sink.samples()) {
		expect(sample.timestamp).toBeCloseTo(nextTimestamp);
		expect(sample.duration).toBe(0.032);
		expect(sample.format).toBe('f32-planar');
		expect(sample.numberOfChannels).toBe(trackNumberOfChannels);
		expect(sample.sampleRate).toBe(trackSampleRate);

		nextTimestamp += sample.duration;
		sampleCount++;
	}

	expect(sampleCount).toBe(packetCount);
});

test('E-AC-3 decoding', async () => {
	registerAc3Decoder();

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3.mp4')),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	const { packetCount } = await track.computePacketStats();
	const trackNumberOfChannels = await track.getNumberOfChannels();
	const trackSampleRate = await track.getSampleRate();
	const sink = new AudioSampleSink(track);

	let sampleCount = 0;
	let nextTimestamp = 0;

	for await (using sample of sink.samples()) {
		expect(sample.timestamp).toBeCloseTo(nextTimestamp);
		expect(sample.duration).toBe(0.032);
		expect(sample.format).toBe('f32-planar');
		expect(sample.numberOfChannels).toBe(trackNumberOfChannels);
		expect(sample.sampleRate).toBe(trackSampleRate);

		nextTimestamp += sample.duration;
		sampleCount++;
	}

	expect(sampleCount).toBe(packetCount);
});

const createSineWave = (sampleRate: number, channels: number, durationSeconds: number) => {
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

test('AC-3 encoding', async () => {
	registerAc3Encoder();

	const sampleRate = 48000;
	const channels = 2;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'ac3', quality: new Quality({ bitrate: 192000 }) });
	output.addAudioTrack(audioSource);

	await output.start();
	const sample = new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: channels,
		sampleRate,
		timestamp: 0,
	});
	await audioSource.add(sample);
	sample.close();
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getCodec()).toBe('ac3');
	expect(await track.getSampleRate()).toBe(sampleRate);
	expect(await track.getNumberOfChannels()).toBe(channels);

	expect(await track.getFirstTimestamp()).toBeLessThan(0); // Due to priming delay!

	const sink = new EncodedPacketSink(track);
	let packetCount = 0;
	for await (const packet of sink.packets()) {
		expect(packet.type).toBe('key');
		packetCount++;
	}
	expect(packetCount).toBeGreaterThan(0);

	expect(await track.computeDuration()).toBeCloseTo(2, 1);
});

test('E-AC-3 encoding', async () => {
	registerAc3Encoder();

	const sampleRate = 48000;
	const channels = 2;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'eac3', quality: new Quality({ bitrate: 192000 }) });
	output.addAudioTrack(audioSource);

	await output.start();
	const sample = new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: channels,
		sampleRate,
		timestamp: 0,
	});
	await audioSource.add(sample);
	sample.close();
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getCodec()).toBe('eac3');
	expect(await track.getSampleRate()).toBe(sampleRate);
	expect(await track.getNumberOfChannels()).toBe(channels);

	expect(await track.getFirstTimestamp()).toBeLessThan(0); // Due to priming delay!

	const sink = new EncodedPacketSink(track);
	let packetCount = 0;
	for await (const packet of sink.packets()) {
		expect(packet.type).toBe('key');
		packetCount++;
	}
	expect(packetCount).toBeGreaterThan(0);

	expect(await track.computeDuration()).toBeCloseTo(2, 1);
});

test('AC-3 with huge timestamps', async () => {
	registerAc3Decoder();
	registerAc3Encoder();

	const sampleRate = 48000;
	const channels = 2;
	const timestamp = 1e9;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'ac3', quality: new Quality({ bitrate: 192000 }) });
	output.addAudioTrack(audioSource);

	await output.start();
	const sample = new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: channels,
		sampleRate,
		timestamp,
	});
	await audioSource.add(sample);
	sample.close();
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	const packetSink = new EncodedPacketSink(track);
	const firstPacket = await packetSink.getFirstPacket();
	assert(firstPacket);

	const primingDelay = 256 / 48000;
	expect(firstPacket.timestamp).toBe(timestamp - primingDelay);

	const sampleSink = new AudioSampleSink(track);
	const iterator = sampleSink.samples(timestamp);
	const firstSample = (await iterator.next()).value;
	assert(firstSample);

	expect(firstSample.timestamp).toBe(timestamp - primingDelay);
});

// Real content for the AC-3 encoder's bitrate limits: a sine tone per channel (440, 550, 660... Hz), and 1 s of music,
// with the extra channels getting the stereo channels again, offset in time
const createSineTones = (sampleRate: number, channels: number) => {
	const data = new Float32Array(sampleRate * channels);
	for (let i = 0; i < sampleRate; i++) {
		for (let ch = 0; ch < channels; ch++) {
			data[i * channels + ch] = 0.5 * Math.sin(2 * Math.PI * (440 + 110 * ch) * i / sampleRate);
		}
	}
	return data;
};

let stereoMusic: Float32Array | null = null;
const createMusic = async (sampleRate: number, channels: number) => {
	if (!stereoMusic) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav')),
			formats: ALL_FORMATS,
		});
		const chunks: Float32Array[] = [];
		for await (const sample of new AudioSampleSink((await input.getPrimaryAudioTrack())!).samples(3, 4)) {
			const chunk = new Float32Array(sample.allocationSize({ format: 'f32', planeIndex: 0 }) / 4);
			sample.copyTo(chunk, { format: 'f32', planeIndex: 0 });
			chunks.push(chunk);
			sample.close();
		}
		stereoMusic = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
		chunks.reduce((offset, chunk) => (stereoMusic!.set(chunk, offset), offset + chunk.length), 0);
	}

	// Resampled from 44.1 kHz with linear interpolation
	const sourceFrames = stereoMusic.length / 2;
	const frames = Math.floor(sourceFrames * sampleRate / 44100);
	const data = new Float32Array(frames * channels);
	for (let i = 0; i < frames; i++) {
		for (let ch = 0; ch < channels; ch++) {
			const position = ((i + 997 * Math.floor(ch / 2)) % frames) * 44100 / sampleRate;
			const index = Math.min(Math.floor(position), sourceFrames - 2);
			const fraction = position - index;
			const a = stereoMusic[2 * index + (ch % 2)]!;
			const b = stereoMusic[2 * (index + 1) + (ch % 2)]!;
			data[i * channels + ch] = a + (b - a) * fraction;
		}
	}
	return data;
};

const encodeAc3 = async (
	codec: 'ac3' | 'eac3',
	data: Float32Array,
	sampleRate: number,
	channels: number,
	bitrate: number,
) => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const audioSource = new AudioSampleSource({ codec, quality: new Quality({ bitrate }) });
	output.addAudioTrack(audioSource);

	const sample = new AudioSample({ data, format: 'f32', numberOfChannels: channels, sampleRate, timestamp: 0 });
	try {
		await output.start();
		await audioSource.add(sample);
		await output.finalize();
	} catch (error) {
		await output.cancel();
		throw error;
	} finally {
		sample.close();
	}

	return output.target.buffer!;
};

test('AC-3 and E-AC-3 encode real content at the lowest bitrate they claim', { timeout: 60_000 }, async () => {
	registerAc3Encoder();

	// Below some bitrate, FFmpeg's bit allocation fails the encode, so the encoder must not claim it
	const failures: string[] = [];
	for (const codec of ['ac3', 'eac3'] as const) {
		for (const sampleRate of [32000, 44100, 48000]) {
			for (let channels = 1; channels <= 6; channels++) {
				let lowestBitrate = 24000;
				while (!(await canEncodeAudio(codec, {
					numberOfChannels: channels,
					sampleRate,
					quality: new Quality({ bitrate: lowestBitrate }),
				}))) {
					lowestBitrate += 4000;
				}

				const label = `${codec}, ${sampleRate} Hz, ${channels} ch, ${lowestBitrate} bps`;
				for (const [name, data] of [
					['sine tones', createSineTones(sampleRate, channels)],
					['music', await createMusic(sampleRate, channels)],
				] as const) {
					try {
						await encodeAc3(codec, data, sampleRate, channels, lowestBitrate);
					} catch (error) {
						failures.push(`${label}, ${name}: ${String(error)}`);
					}
				}
			}
		}
	}

	expect(failures).toEqual([]);

	// FFmpeg's encoders top out at 5.1
	for (const codec of ['ac3', 'eac3'] as const) {
		for (const channels of [7, 8]) {
			const quality = new Quality({ bitrate: 448000 });
			expect(await canEncodeAudio(codec, { numberOfChannels: channels, sampleRate: 48000, quality })).toBe(false);
		}
	}
});

// The hardest signals for FFmpeg's bit allocation: full-scale square and sawtooth waves, slightly detuned per channel
const HARSH_SIGNALS: Record<string, (t: number) => number> = {
	square220: t => (220 * t) % 1 < 0.5 ? 1 : -1,
	square550: t => (550 * t) % 1 < 0.5 ? 1 : -1,
	saw330: t => 2 * ((330 * t) % 1) - 1,
	sine440: t => 0.5 * Math.sin(2 * Math.PI * 440 * t),
};

test.each([
	['ac3', 48000, 2, 48000], // A valid AC-3 bitrate, so it isn't rounded
	['ac3', 48000, 3, 48000],
	['eac3', 48000, 2, 48000],
	['eac3', 48000, 6, 88000],
	['ac3', 32000, 4, 64000],
	['eac3', 32000, 5, 80000],
] as const)('%s at %d Hz, %d channels and %d bps stays encodable', async (codec, sampleRate, channels, rate) => {
	registerAc3Encoder();

	// These encode even the hardest signals
	const options = { numberOfChannels: channels, sampleRate, quality: new Quality({ bitrate: rate }) };
	expect(await canEncodeAudio(codec, options)).toBe(true);

	for (const [name, signal] of Object.entries(HARSH_SIGNALS)) {
		const data = new Float32Array(sampleRate / 2 * channels);
		for (let i = 0; i < sampleRate / 2; i++) {
			for (let ch = 0; ch < channels; ch++) {
				data[i * channels + ch] = signal(i * (1 + 0.01 * ch) / sampleRate);
			}
		}

		const buffer = await encodeAc3(codec, data, sampleRate, channels, rate);
		expect(buffer.byteLength, name).toBeGreaterThan(1000);
	}
});

test('E-AC-3 with huge timestamps', async () => {
	registerAc3Decoder();
	registerAc3Encoder();

	const sampleRate = 48000;
	const channels = 2;
	const timestamp = 1e9;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'eac3', quality: new Quality({ bitrate: 192000 }) });
	output.addAudioTrack(audioSource);

	await output.start();
	const sample = new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: channels,
		sampleRate,
		timestamp,
	});
	await audioSource.add(sample);
	sample.close();
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	const packetSink = new EncodedPacketSink(track);
	const firstPacket = await packetSink.getFirstPacket();
	assert(firstPacket);

	const primingDelay = 256 / 48000;
	expect(firstPacket.timestamp).toBe(timestamp - primingDelay);

	const sampleSink = new AudioSampleSink(track);
	const iterator = sampleSink.samples(timestamp);
	const firstSample = (await iterator.next()).value;
	assert(firstSample);

	expect(firstSample.timestamp).toBe(timestamp - primingDelay);
});
