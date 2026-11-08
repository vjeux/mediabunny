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
import { EncodedAudioPacketSource, EncodedVideoPacketSource, TextSubtitleSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { EBMLId } from '../../src/matroska/ebml.js';

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

test('WebVTT cues that don\'t end after they start aren\'t written to Matroska', async () => {
	// The subtitle blocks of a Matroska file: [timestamp in ms, BlockDuration or null, text]
	const readSubtitleBlocks = (bytes: Uint8Array) => {
		const readVint = (pos: number, keepMarker: boolean) => {
			const first = bytes[pos]!;
			const length = Math.clz32(first) - 23;
			let value = keepMarker ? first : first & (0xff >> length);
			for (let i = 1; i < length; i++) {
				value = value * 256 + bytes[pos + i]!;
			}
			return { value, length };
		};
		const children = (start: number, end: number) => {
			const result: { id: number; start: number; end: number }[] = [];
			for (let pos = start; pos < end;) {
				const id = readVint(pos, true);
				const size = readVint(pos + id.length, false);
				const dataStart = pos + id.length + size.length;
				result.push({ id: id.value, start: dataStart, end: dataStart + size.value });
				pos = dataStart + size.value;
			}
			return result;
		};
		const readUint = (element: { start: number; end: number }) => {
			return bytes.subarray(element.start, element.end).reduce((value, byte) => value * 256 + byte, 0);
		};

		const blocks: [number, number | null, string][] = [];
		const segment = children(0, bytes.length).find(x => x.id === EBMLId.Segment)!;
		for (const cluster of children(segment.start, segment.end).filter(x => x.id === EBMLId.Cluster)) {
			const elements = children(cluster.start, cluster.end);
			const clusterTimestamp = readUint(elements.find(x => x.id === EBMLId.Timestamp)!);
			for (const group of elements.filter(x => x.id === EBMLId.BlockGroup)) {
				const parts = children(group.start, group.end);
				const block = parts.find(x => x.id === EBMLId.Block)!;
				const duration = parts.find(x => x.id === EBMLId.BlockDuration);
				// The track number (one byte here), a 16-bit relative timestamp and the flags precede the cue text
				const relativeTimestamp = ((bytes[block.start + 1]! << 8) | bytes[block.start + 2]!) << 16 >> 16;
				blocks.push([
					clusterTimestamp + relativeTimestamp,
					duration ? readUint(duration) : null,
					new TextDecoder().decode(bytes.subarray(block.start + 4, block.end)),
				]);
			}
		}
		return blocks;
	};

	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);
	await output.start();
	await source.add([
		'WEBVTT',
		'',
		'00:01.000 --> 00:02.000',
		'A',
		'',
		'00:02.500 --> 00:02.500',
		'Zero',
		'',
		'00:03.000 --> 00:02.000',
		'Negative',
		'',
		'00:04.000 --> 00:05.000',
		'B',
		'',
	].join('\n'));
	source.close();
	await output.finalize();

	// A WebVTT cue is shown while start <= t < end, so the second and third ones never are. Without a BlockDuration,
	// a Matroska block would last until the next one instead (RFC 9559).
	expect(readSubtitleBlocks(new Uint8Array(output.target.buffer!))).toEqual([
		[1000, 1000, 'A'],
		[4000, 1000, 'B'],
	]);
});
