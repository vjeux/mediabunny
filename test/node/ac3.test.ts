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
import { AC3_REGISTRATION_DESCRIPTOR, EAC3_REGISTRATION_DESCRIPTOR, parseEac3SyncFrame } from '../../src/codec-data.js';
import { canEncode, Quality } from '../../src/encode.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { AudioSampleSource, EncodedAudioPacketSource } from '../../src/media-source.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { EncodedPacket } from '../../src/packet.js';
import { registerAc3Decoder, registerAc3Encoder } from '@mediabunny/ac3';
import { assert } from '../../src/misc.js';

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

// An independent E-AC-3 substream signals its service type (bsmod) in the informational metadata, and dec3 carries it
// over (ETSI TS 102 366 E.1.2.2, F.6.2.8). In the 5.1 file, mixing metadata comes first, which moves it:
// ffmpeg -f lavfi -i anullsrc=r=48000:cl=stereo -t 0.1 -c:a eac3 -audio_service_type vi eac3-visually-impaired.mkv
// ffmpeg -f lavfi -i anullsrc=r=48000:cl=5.1 -t 0.1 -c:a eac3 -audio_service_type hi -dmix_mode ltrt \
//   -ltrt_cmixlev 0.5 -ltrt_surmixlev 0.5 -loro_cmixlev 0.5 -loro_surmixlev 0.5 eac3-5.1-hearing-impaired.mkv
test.each([
	['eac3-visually-impaired.mkv', 2],
	['eac3-5.1-hearing-impaired.mkv', 3],
	['eac3.ts', 0],
])('keeps the E-AC-3 bit stream mode in dec3 (%s)', async (fileName, bsmod) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public', fileName)),
		formats: ALL_FORMATS,
	});

	const firstPacket = (await new EncodedPacketSink((await input.getPrimaryAudioTrack())!).getFirstPacket())!;
	expect(parseEac3SyncFrame(firstPacket.data)?.substreams[0]?.bsmod).toBe(bsmod);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, copy: { mode: 'forced' } });
	await conversion.execute();

	// Like FFmpeg's -c copy: bsmod follows data_rate, num_ind_sub, fscod, bsid and asvc in dec3
	const bytes = Buffer.from(output.target.buffer!);
	const dec3 = bytes.indexOf('dec3');
	expect(dec3).toBeGreaterThan(0);
	expect((bytes[dec3 + 7]! >> 4) & 0b111).toBe(bsmod);
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

test('AC-3 and E-AC-3 encode a NaN or infinite sample like silence or full scale', async () => {
	registerAc3Encoder();

	const encode = async (codec: 'ac3' | 'eac3', data: Float32Array) => {
		const packets: Uint8Array[] = [];
		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});
		const audioSource = new AudioSampleSource({
			codec,
			quality: new Quality({ bitrate: 192000 }),
			onEncodedPacket: packet => packets.push(packet.data),
		});
		output.addAudioTrack(audioSource);

		await output.start();
		const sample = new AudioSample({ data, format: 'f32', numberOfChannels: 2, sampleRate: 48000, timestamp: 0 });
		await audioSource.add(sample);
		sample.close();
		await output.finalize();

		return packets;
	};

	// FFmpeg's MDCT turns a non-finite sample into silence for the blocks around it, so it has to be encoded like the
	// conversion to integer samples maps it: NaN to silence, infinities to full scale
	for (const codec of ['ac3', 'eac3'] as const) {
		for (const [value, replacement] of [[NaN, 0], [Infinity, 1], [-Infinity, -1]] as const) {
			const withValue = createSineWave(48000, 2, 1);
			withValue[20000] = value;
			const withReplacement = createSineWave(48000, 2, 1);
			withReplacement[20000] = replacement;

			const packets = await encode(codec, withValue);
			expect(packets.length).toBeGreaterThan(0);
			expect(packets, `${codec}, ${value}`).toEqual(await encode(codec, withReplacement));
		}
	}
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

test.each(['ac3', 'eac3'] as const)('%s encoding ends where the input ends', async (codec) => {
	registerAc3Encoder();

	const sampleRate = 48000;
	const channels = 2;
	const data = createSineWave(sampleRate, channels, 1); // Not a whole number of 1536-sample frames

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec, quality: new Quality({ bitrate: 192000 }) });
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
	const lastPacket = (await new EncodedPacketSink(track).getPacket(Infinity))!;

	// The silence that fills the last frame isn't part of the audio
	expect(lastPacket.timestamp + lastPacket.duration).toBeCloseTo(1, 6);
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

// ETSI TS 102 366 F.2: an E-AC-3 sample in ISOBMFF holds six audio blocks (1536 samples, the stts delta), so
// syncframes with fewer blocks are combined, as FFmpeg's MP4 muxer does. FFmpeg's encoder uses 3-block syncframes here:
// ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000:duration=0.1 -ac 2 -c:a eac3 -b:a 1536k \
//   eac3-three-block-frames.mkv
test('writes E-AC-3 syncframes with fewer than six blocks as 1536-sample MP4 samples', async () => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3-three-block-frames.mkv')),
		formats: ALL_FORMATS,
	});

	const originalPackets: Uint8Array[] = [];
	for await (const packet of new EncodedPacketSink((await originalInput.getPrimaryAudioTrack())!).packets()) {
		originalPackets.push(packet.data);
	}
	expect(originalPackets.length).toBe(7);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input: originalInput, output, copy: { mode: 'forced' } });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const newPackets = [];
	for await (const packet of new EncodedPacketSink((await newInput.getPrimaryAudioTrack())!).packets()) {
		newPackets.push(packet);
	}

	// Pairs of 3-block syncframes, then the leftover one
	expect(newPackets.map(x => x.data.byteLength)).toEqual([6144, 6144, 6144, 3072]);
	expect(newPackets.slice(0, 3).map(x => Math.round(x.duration * 48000))).toEqual([1536, 1536, 1536]);
	expect([...newPackets[0]!.data]).toEqual([...originalPackets[0]!, ...originalPackets[1]!]);
	expect([...newPackets[3]!.data]).toEqual([...originalPackets[6]!]);

	// Every syncframe of a sample is decoded
	registerAc3Decoder();
	const timestamps: number[] = [];
	for await (using sample of new AudioSampleSink((await newInput.getPrimaryAudioTrack())!).samples()) {
		expect(sample.numberOfFrames).toBe(768);
		timestamps.push(Math.round(sample.timestamp * 48000));
	}

	expect(timestamps).toEqual([-240, 528, 1296, 2064, 2832, 3600, 4368]);
});

test('combines E-AC-3 syncframes into one MP4 sample only across contiguous timestamps', async () => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3-three-block-frames.mkv')),
		formats: ALL_FORMATS,
	});

	const originalTrack = (await originalInput.getPrimaryAudioTrack())!;
	const decoderConfig = (await originalTrack.getDecoderConfig())!;
	const packetSink = new EncodedPacketSink(originalTrack);
	const first = (await packetSink.getFirstPacket())!;
	const second = (await packetSink.getNextPacket(first))!;

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource('eac3');
	output.addAudioTrack(source);
	await output.start();

	// Two 3-block syncframes with a gap of almost a second between them
	await source.add(new EncodedPacket(first.data, 'key', 0, 768 / 48000), { decoderConfig });
	await source.add(new EncodedPacket(second.data, 'key', 1, 768 / 48000));
	await output.finalize();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const newTrack = (await newInput.getPrimaryAudioTrack())!;

	const packets = [];
	for await (const packet of new EncodedPacketSink(newTrack).packets()) {
		packets.push([packet.timestamp, packet.data.byteLength]);
	}

	expect(packets).toEqual([[0, 3072], [1, 3072]]);
	expect(await newTrack.computeDuration()).toBeCloseTo(1 + 768 / 48000);
});
