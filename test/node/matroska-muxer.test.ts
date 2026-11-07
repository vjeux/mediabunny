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

test('Video frames less than a millisecond apart get distinct block timestamps, in presentation order', async () => {
	// Block timestamps are whole milliseconds. A trimmed transcode starts with the frame straddling the trim start,
	// which may then last a fraction of a millisecond.
	const decoderConfig = { codec: 'avc1.42001f', codedWidth: 64, codedHeight: 64 };
	const mux = async (packets: EncodedPacket[]) => {
		const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source);
		await output.start();
		for (const [i, packet] of packets.entries()) {
			await source.add(packet, i === 0 ? { decoderConfig } : undefined);
		}
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	const read = async (bytes: Uint8Array) => {
		using input = new Input({
			source: new BufferSource(bytes),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}
		return packets;
	};

	// [timestamp, key frame?] in decode order, each lasting 1/30 s unless given
	const frames = (list: [number, boolean, number?][]) => list.map(([timestamp, key, duration], i) => {
		return new EncodedPacket(new Uint8Array([i]), key ? 'key' : 'delta', timestamp, duration ?? 1 / 30);
	});

	// 60 fps from a trim start 0.27 ms before a frame: the second frame goes to the next millisecond
	const trimmed: [number, boolean, number?][] = [[0, true, 0.00027]];
	for (let i = 0; i < 5; i++) {
		trimmed.push([0.00027 + i / 60, false, 1 / 60]);
	}
	const trimmedPackets = await read(await mux(frames(trimmed)));
	expect(trimmedPackets.map(x => x.timestamp)).toEqual([0, 0.001, 0.017, 0.034, 0.05, 0.067]);

	// Frames can't move more than a millisecond past their own: they share a timestamp instead of drifting, never one
	// before an earlier frame's (which would make the file impossible to remux, as key frames can't go back)
	const denseFrames = frames([[0, true], [0.0004, false], [0.00045, false], [0.00047, true], [0.04, false]]);
	const dense = await read(await mux(denseFrames));
	expect(dense.map(x => x.timestamp)).toEqual([0, 0.001, 0.001, 0.001, 0.04]);
	await mux(dense);

	// B-frames: the decode order isn't the presentation order, and no frame is moved ahead once that shows; but no
	// frame goes before one presented earlier that was moved ahead
	const base = 14.306;
	const reordered: [number, boolean][] = [[base - 0.0001, true]];
	for (const offset of [0.234, 0.232, 0.221, 0.233, 0.362, 0.344, 0.244, 0.361]) {
		reordered.push([base + offset / 1000, false]);
	}
	const reorderedPackets = await read(await mux(frames(reordered)));
	const inPresentationOrder = reorderedPackets
		.map((packet, i) => ({ original: reordered[i]![0], timestamp: packet.timestamp }))
		.sort((a, b) => a.original - b.original);
	for (let i = 1; i < inPresentationOrder.length; i++) {
		expect(inPresentationOrder[i]!.timestamp).toBeGreaterThanOrEqual(inPresentationOrder[i - 1]!.timestamp);
	}
	await mux(reorderedPackets);

	// Frames shorter than a millisecond (here 1200 fps) can't all get their own timestamp, but they don't drift
	const fast = await read(await mux(frames(Array.from({ length: 120 }, (_, i) => [i / 1200, i === 0, 1 / 1200]))));
	for (const [i, packet] of fast.entries()) {
		expect(Math.abs(packet.timestamp - i / 1200)).toBeLessThan(0.0015);
		expect(packet.timestamp).toBeGreaterThanOrEqual(fast[i - 1]?.timestamp ?? 0);
	}
});
