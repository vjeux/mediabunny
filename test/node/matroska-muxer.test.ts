import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Matroska muxer internally converts ADTS to AAC', async () => {
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
		format: new MkvOutputFormat(),
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

	expect(await outputTrack.getCodec()).toBe('aac');
	expect(await outputTrack.getSampleRate()).toBe(await inputTrack.getSampleRate());
	expect(await outputTrack.getNumberOfChannels()).toBe(await inputTrack.getNumberOfChannels());

	const outputDecoderConfig = await outputTrack.getDecoderConfig();
	expect(outputDecoderConfig!.description).toBeDefined();

	const outputSink = new EncodedPacketSink(outputTrack);

	let count = 0;
	for await (const packet of outputSink.packets()) {
		// Packets should NOT be ADTS frames (should not start with 0xFFF sync word)
		const isAdts = packet.data[0] === 0xff && (packet.data[1]! & 0xf0) === 0xf0;
		expect(isAdts).toBe(false);
		count++;
	}

	expect(count).toBe(4557);
});

test('Opus identification headers missing required bytes are rejected', async () => {
	// RFC 7845, 5.1: 'OpusHead', version, channel count, pre-skip, input sample rate, output gain and mapping family,
	// then, for any family but 0, the stream count, the coupled stream count and one mapping byte per channel
	const opusHead = (channels: number, family: number, withMappingTable: boolean) => new Uint8Array([
		...new TextEncoder().encode('OpusHead'),
		1, channels, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00, 0x00, 0x00, family,
		...(withMappingTable ? [4, 2, ...Array.from({ length: channels }, (_, i) => i)] : []),
	]);

	const addFirstPacket = async (description: Uint8Array, numberOfChannels: number) => {
		const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(source);
		await output.start();
		// A one-frame 20 ms CELT packet
		await source.add(new EncodedPacket(new Uint8Array([0xf8, 0xff, 0xfe]), 'key', 0, 0.02), {
			decoderConfig: { codec: 'opus', sampleRate: 48000, numberOfChannels, description },
		});
	};

	await addFirstPacket(opusHead(2, 0, false), 2);
	await addFirstPacket(opusHead(6, 1, true), 6);

	// These were written as CodecPrivate, which FFmpeg's decoder rejects ("Invalid extradata size"): one byte short
	// of the mapping family, a family 1 header without its channel mapping table, and one with only part of it
	await expect(addFirstPacket(opusHead(2, 0, false).subarray(0, 18), 2)).rejects.toThrow(TypeError);
	await expect(addFirstPacket(opusHead(6, 1, false), 6)).rejects.toThrow(TypeError);
	await expect(addFirstPacket(opusHead(6, 1, true).subarray(0, 26), 6)).rejects.toThrow(TypeError);
});

test('Negative start timestamps', async () => {
	await testNegativeTimestampRoundTrip(
		Array.from({ length: 50 }, (_, index) => (index - 10) / 10),
		0.1,
		10,
	);
});

test('Wholly negative timestamps', async () => {
	await testNegativeTimestampRoundTrip([-1, -0.9, -0.8, -0.7, -0.6], 0.1, 10);
});

const testNegativeTimestampRoundTrip = async (timestamps: number[], duration: number, frameRate: number) => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, { frameRate });

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	const inputPackets = timestamps.map((timestamp, index) => new EncodedPacket(
		new Uint8Array(1024).fill(index),
		'key',
		timestamp,
		duration,
	));

	for (let i = 0; i < inputPackets.length; i++) {
		await source.add(inputPackets[i]!, i === 0 ? meta : undefined);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const outputPackets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		outputPackets.push(packet);
	}

	expect(outputPackets.map(packet => ({
		timestamp: packet.timestamp,
		duration: packet.duration,
	}))).toEqual(inputPackets.map(packet => ({
		timestamp: packet.timestamp,
		duration: packet.duration,
	})));

	for (const inputPacket of inputPackets) {
		const outputPacket = await sink.getPacket(inputPacket.timestamp);
		assert(outputPacket);

		expect({
			timestamp: outputPacket.timestamp,
			duration: outputPacket.duration,
		}).toEqual({
			timestamp: inputPacket.timestamp,
			duration: inputPacket.duration,
		});
	}
};

test('Negative audio start timestamps via CodecDelay', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);

	await output.start();

	const meta = {
		decoderConfig: {
			codec: 'mp4a.40.2',
			numberOfChannels: 2,
			sampleRate: 32000, // Makes the first frame start at exactly -32 ms
			description: new Uint8Array([0x12, 0x90]),
		},
	};
	const inputPackets = Array.from({ length: 50 }, (_, index) => new EncodedPacket(
		new Uint8Array(64).fill(index),
		'key',
		(index - 1) * 32 / 1000,
		32 / 1000,
	));

	for (let i = 0; i < inputPackets.length; i++) {
		await source.add(inputPackets[i]!, i === 0 ? meta : undefined);
	}

	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	expect(containsBytes(bytes, [0x56, 0xaa])).toBe(true); // CodecDelay element ID

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await input.getDurationFromMetadata()).toBe(49 * 32 / 1000);
	expect(await input.computeDuration()).toBe(49 * 32 / 1000);

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const outputPackets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		outputPackets.push(packet);
	}

	expect(outputPackets.map(packet => packet.timestamp)).toEqual(inputPackets.map(packet => packet.timestamp));

	for (const inputPacket of inputPackets) {
		const outputPacket = await sink.getPacket(inputPacket.timestamp);
		assert(outputPacket);

		expect(outputPacket.timestamp).toBe(inputPacket.timestamp);
	}
});

const containsBytes = (haystack: Uint8Array, needle: number[]) => {
	for (let i = 0; i <= haystack.length - needle.length; i++) {
		if (needle.every((byte, j) => haystack[i + j] === byte)) {
			return true;
		}
	}

	return false;
};
