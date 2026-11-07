import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { canEncode, Quality } from '../../src/encode.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Mp4OutputFormat, WavOutputFormat } from '../../src/output-format.js';
import { Conversion, ConversionAudioOptions } from '../../src/conversion.js';
import { AudioSample } from '../../src/sample.js';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { assert } from '../../src/misc.js';

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

test('Custom coder registration', async () => {
	expect(await canEncode('aac')).toBe(false);

	registerAacEncoder();

	expect(await canEncode('aac')).toBe(true);
});

test('AAC encoding', async () => {
	registerAacEncoder();

	const sampleRate = 48000;
	const channels = 2;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: 128000 }) });
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
	expect(await track.getCodec()).toBe('aac');
	expect(await track.getSampleRate()).toBe(sampleRate);
	expect(await track.getNumberOfChannels()).toBe(channels);

	expect(await track.getFirstTimestamp()).toBeLessThan(0); // Due to priming delay!

	const sink = new EncodedPacketSink(track);
	let packetCount = 0;
	for await (const packet of sink.packets()) {
		expect(packet.type).toBe('key');
		packetCount++;
	}
	expect(packetCount).toBeGreaterThan(durationSeconds * sampleRate / 1024);

	expect(await track.computeDuration()).toBeCloseTo(2, 1);
});

test('AAC with huge timestamps', async () => {
	registerAacEncoder();

	const sampleRate = 48000;
	const channels = 2;
	const timestamp = 1e9;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: 128000 }) });
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
	const sink = new EncodedPacketSink(track);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	const primingDelay = 1024 / 48000;
	expect(firstPacket.timestamp).toBe(timestamp - primingDelay);
});

test('AAC encoding of a tone after silence at 192 kbps per channel', { timeout: 20_000 }, async () => {
	registerAacEncoder();

	// FFmpeg's encoder used to retry this tone's onset frame forever, as its coder ignores the lambda that the
	// retries lower, and the frame must not come out bigger than the decoder buffer either
	const sampleRate = 48000;
	const data = new Float32Array(sampleRate);
	for (let i = sampleRate / 4; i < sampleRate; i++) {
		data[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / sampleRate);
	}

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: 192000 }) });
	output.addAudioTrack(audioSource);

	const encode = async () => {
		await output.start();
		using sample = new AudioSample({
			data,
			format: 'f32',
			numberOfChannels: 1,
			sampleRate,
			timestamp: 0,
		});
		await audioSource.add(sample);
		audioSource.close();
		await output.finalize();
	};

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const hang = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error('The AAC encoder hung.')), 10_000);
	});

	try {
		await Promise.race([encode(), hang]);
	} finally {
		clearTimeout(timeoutId);
	}

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getCodec()).toBe('aac');
	expect(await track.computeDuration()).toBeCloseTo(1, 1);

	// A frame may take up at most 6144 bits per channel, the size of the decoder's input buffer
	let largestPacket = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		largestPacket = Math.max(largestPacket, packet.data.byteLength);
	}
	expect(largestPacket).toBeLessThanOrEqual(6144 / 8);
});

test('Conversion falls back to the closest encodable audio parameters', async () => {
	registerAacEncoder();

	// AAC has no 192 kHz, so only the sample rate needs a fallback
	const createWav = async (numberOfChannels: number) => {
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const source = new AudioSampleSource({ codec: 'pcm-s16' });
		output.addAudioTrack(source);
		await output.start();
		await source.add(new AudioSample({
			data: createSineWave(192000, numberOfChannels, 0.1),
			format: 'f32',
			numberOfChannels,
			sampleRate: 192000,
			timestamp: 0,
		}));
		await output.finalize();
		return output.target.buffer!;
	};

	const convert = async (buffer: ArrayBuffer, audio: ConversionAudioOptions) => {
		using input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, audio });
		await conversion.execute();

		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = await result.getPrimaryAudioTrack();
		assert(track);
		return [await track.getCodec(), await track.getNumberOfChannels(), await track.getSampleRate()];
	};

	// 5.1 stays 5.1 instead of being downmixed to stereo
	expect(await convert(await createWav(6), { codec: 'aac' })).toEqual(['aac', 6, 48000]);
	// An explicitly requested channel count is kept
	expect(await convert(await createWav(2), { codec: 'aac', numberOfChannels: 1 })).toEqual(['aac', 1, 48000]);
});

test('AAC encoding of samples that hold NaN or infinite values', async () => {
	registerAacEncoder();

	const sampleRate = 48000;
	const channels = 2;
	const data = createSineWave(sampleRate, channels, 1);
	data[1000] = NaN; // Like a glitch in a float WAV file or an unstable audio effect
	data[30000] = Infinity;
	data[30001] = -Infinity;

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: 128000 }) });
	output.addAudioTrack(audioSource);

	await output.start();
	using sample = new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: channels,
		sampleRate,
		timestamp: 0,
	});
	await audioSource.add(sample);
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.computeDuration()).toBeCloseTo(1, 1);
});
