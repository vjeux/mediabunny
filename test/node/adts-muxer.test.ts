import { beforeAll, expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerMediabunnyServer } from '@mediabunny/server';
import { NodeAvAudioDecoder } from '../../packages/server/src/audio-decoder.js';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { AudioSampleSource, EncodedAudioPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import {
	AdtsOutputFormat,
	MkvOutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	OutputFormat,
} from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';
import { EncodedPacket } from '../../src/packet.js';
import { AudioSample } from '../../src/sample.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

beforeAll(() => {
	registerMediabunnyServer();
});

test('ADTS muxer with raw AAC input', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const inputDecoderConfig = await audioTrack.getDecoderConfig();
	assert(inputDecoderConfig!.description); // MP4 has description

	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await outputAsInput.getFormat()).toBe(ADTS);

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	expect(await outputTrack.getCodec()).toBe('aac');
	expect(await outputTrack.getSampleRate()).toBe(await audioTrack.getSampleRate());
	expect(await outputTrack.getNumberOfChannels()).toBe(await audioTrack.getNumberOfChannels());

	const outputDecoderConfig = await outputTrack.getDecoderConfig();
	expect(outputDecoderConfig!.description).toBeUndefined(); // ADTS has no description

	const outputSink = new EncodedPacketSink(outputTrack);

	let count = 0;
	for await (const packet of outputSink.packets()) {
		// All packets should be ADTS frames now (start with 0xfff sync word)
		expect(packet.data[0]).toBe(0xff);
		expect((packet.data[1]! & 0xf0)).toBe(0xf0);
		count++;
	}

	expect(count).toBe(237);
});

test('ADTS muxer with ADTS input (passthrough)', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample3.aac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);

	const inputDecoderConfig = await inputTrack.getDecoderConfig();
	expect(inputDecoderConfig!.description).toBeUndefined(); // ADTS input has no description

	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	const inputSink = new EncodedPacketSink(inputTrack);
	const outputSink = new EncodedPacketSink(outputTrack);

	let inputPacket = await inputSink.getFirstPacket();
	let outputPacket = await outputSink.getFirstPacket();
	let count = 0;

	while (inputPacket && outputPacket) {
		// Verify that the packets are identical
		expect(outputPacket.data).toEqual(inputPacket.data);
		expect(outputPacket.timestamp).toBe(inputPacket.timestamp);
		expect(outputPacket.duration).toBe(inputPacket.duration);

		inputPacket = await inputSink.getNextPacket(inputPacket);
		outputPacket = await outputSink.getNextPacket(outputPacket);
		count++;
	}

	expect(inputPacket).toBeNull();
	expect(outputPacket).toBeNull();
	expect(count).toBe(4557);
});

test('ADTS muxer with the decoder config given with the track instead of with the packets', async () => {
	// Copies the first 10 packets of a file, giving the decoder config when adding the track, not with any packet
	const copyPackets = async (file: string) => {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public', file)),
			formats: ALL_FORMATS,
		});
		const inputTrack = await input.getPrimaryAudioTrack();
		assert(inputTrack);

		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(inputTrack).packets()) {
			packets.push(packet);
			if (packets.length === 10) {
				break;
			}
		}

		const output = new Output({ format: new AdtsOutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('aac');
		output.addAudioTrack(source, { decoderConfig: (await inputTrack.getDecoderConfig())! });
		await output.start();
		for (const packet of packets) {
			await source.add(packet);
		}
		await output.finalize();

		using outputAsInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const outputTrack = await outputAsInput.getPrimaryAudioTrack();
		assert(outputTrack);

		const outputPackets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(outputTrack).packets()) {
			outputPackets.push(packet);
		}
		return { packets, outputPackets };
	};

	// Raw AAC (with a description), which gets an ADTS header in front of each packet
	const fromMp4 = await copyPackets('video.mp4');
	expect(fromMp4.outputPackets.map(packet => packet.data.subarray(7))).toEqual(
		fromMp4.packets.map(packet => packet.data),
	);

	// ADTS frames (without a description), which are written as they are
	const fromAdts = await copyPackets('sample3.aac');
	expect(fromAdts.outputPackets.map(packet => packet.data)).toEqual(fromAdts.packets.map(packet => packet.data));
});

test('Program config element', async () => {
	const frames: Uint8Array[] = [];
	const output = new Output({
		format: new AdtsOutputFormat({ onFrame: data => frames.push(data.slice()) }),
		target: new BufferTarget(),
	});

	const source = new AudioSampleSource({
		codec: 'aac',
		bitrate: 128e3,
	});
	output.addAudioTrack(source);
	await output.start();

	const numberOfChannels = 4;
	const sampleRate = 48000;
	const data = new Float32Array(numberOfChannels * sampleRate);
	for (let i = 0; i < data.length; i++) {
		data[i] = Math.sin(2 * Math.PI * 440 * Math.floor(i / numberOfChannels) / sampleRate);
	}

	using sample = new AudioSample({
		data,
		format: 'f32',
		numberOfChannels,
		sampleRate,
		timestamp: 0,
	});
	await source.add(sample);
	await output.finalize();

	// FFmpeg's encoder describes the quad layout with a PCE instead of a channel configuration
	const channelConfiguration = ((frames[0]![2]! & 1) << 2) | (frames[0]![3]! >> 6);
	expect(channelConfiguration).toBe(0);

	expect(await decodeAacFrames(frames)).toEqual(frames.map(() => numberOfChannels));
	// Every frame carries the PCE, so decoding can start anywhere
	expect(await decodeAacFrames(frames.slice(10))).toEqual(frames.slice(10).map(() => numberOfChannels));

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getNumberOfChannels()).toBe(numberOfChannels);

	// Formats holding raw AAC take the PCE into the description
	for (const format of [new Mp4OutputFormat(), new MkvOutputFormat(), new MpegTsOutputFormat()]) {
		const remuxOutput = new Output({
			format,
			target: new BufferTarget(),
		});
		const remuxSource = new EncodedAudioPacketSource('aac');
		remuxOutput.addAudioTrack(remuxSource);
		await remuxOutput.start();

		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);
		for await (const packet of new EncodedPacketSink(track).packets()) {
			await remuxSource.add(packet, { decoderConfig });
		}
		await remuxOutput.finalize();

		using remuxInput = new Input({
			source: new BufferSource(remuxOutput.target.buffer!),
			formats: ALL_FORMATS,
		});
		const remuxTrack = await remuxInput.getPrimaryAudioTrack();
		assert(remuxTrack);
		expect(await remuxTrack.getNumberOfChannels()).toBe(numberOfChannels);

		const remuxFrames: Uint8Array[] = [];
		for await (const packet of new EncodedPacketSink(remuxTrack).packets()) {
			remuxFrames.push(packet.data);
		}
		const description = (await remuxTrack.getDecoderConfig())!.description;
		expect(await decodeAacFrames(remuxFrames, description)).toEqual(remuxFrames.map(() => numberOfChannels));
	}
});

const decodeAacFrames = async (frames: Uint8Array[], description?: AllowSharedBufferSource) => {
	const decoder = new NodeAvAudioDecoder();
	// @ts-expect-error Readonly
	decoder.codec = 'aac';
	// Without a description, the frames are taken as ADTS
	// @ts-expect-error Readonly
	decoder.config = {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		description,
	};

	const channelCounts: number[] = [];
	// @ts-expect-error Readonly
	decoder.onSample = (sample: AudioSample) => {
		channelCounts.push(sample.numberOfChannels);
		sample.close();
	};

	await decoder.init();
	for (let i = 0; i < frames.length; i++) {
		await decoder.decode(new EncodedPacket(frames[i]!, 'key', 1024 * i / 48000, 1024 / 48000));
	}
	await decoder.flush();
	await decoder.close();

	return channelCounts;
};

test('ADTS and MPEG-TS output of an AAC config with a PCE carries the PCE in the frames', async () => {
	// FFmpeg's AAC encoder on 5.1(side) input (like any AC-3 5.1 transcode): channel configuration 0 plus a program
	// config element (PCE) describing the layout, 25 bytes, from `ffmpeg -i ac3_51.mka -c:a aac`
	const pceDescription = new Uint8Array([
		0x11, 0x80, 0x04, 0xc8, 0x44, 0x00, 0x20, 0x00, 0xc4, 0x0c, 0x4c, 0x61, 0x76, 0x63, 0x36, 0x31, 0x2e, 0x33,
		0x2e, 0x31, 0x30, 0x30, 0x56, 0xe5, 0x00,
	]);
	const stereoDescription = new Uint8Array([0x11, 0x90]);
	const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]);

	// Returns the first ADTS frame of the output
	const firstAdtsFrame = async (format: OutputFormat, description: Uint8Array, numberOfChannels: number) => {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('aac');
		output.addAudioTrack(source);
		await output.start();
		for (let i = 0; i < 3; i++) {
			await source.add(new EncodedPacket(payload, 'key', i * 1024 / 48000, 1024 / 48000), {
				decoderConfig: { codec: 'mp4a.40.2', numberOfChannels, sampleRate: 48000, description },
			});
		}
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		// At the start of an ADTS file, or behind the header of the first audio PES packet in MPEG-TS
		let pos = 0;
		if (format instanceof MpegTsOutputFormat) {
			while (!(bytes[pos] === 0 && bytes[pos + 1] === 0 && bytes[pos + 2] === 1 && bytes[pos + 3] === 0xc0)) {
				pos++;
			}
			pos += 9 + bytes[pos + 8]!; // PES header and PES_header_data_length
		}

		const channelConfiguration = ((bytes[pos + 2]! & 1) << 2) | (bytes[pos + 3]! >> 6);
		const frameLength = ((bytes[pos + 3]! & 3) << 11) | (bytes[pos + 4]! << 3) | (bytes[pos + 5]! >> 5);
		return { channelConfiguration, frameLength, rawDataBlock: bytes.subarray(pos + 7, pos + frameLength) };
	};

	for (const format of [new AdtsOutputFormat(), new MpegTsOutputFormat()]) {
		// Channel configuration 2: the raw data block is just the packet
		const stereo = await firstAdtsFrame(format, stereoDescription, 2);
		expect(stereo.channelConfiguration).toBe(2);
		expect(stereo.rawDataBlock).toEqual(payload);

		// Channel configuration 0 means the layout is in a PCE at the start of the raw data block (ISO 14496-3,
		// 1.6.3.4). Without one, FFmpeg reports 0 channels and fails to decode every frame.
		const surround = await firstAdtsFrame(format, pceDescription, 6);
		expect(surround.channelConfiguration).toBe(0);
		expect(surround.rawDataBlock[0]! >> 5).toBe(5); // ID_PCE
		expect(surround.rawDataBlock.subarray(-payload.length)).toEqual(payload);
	}
});
