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

test('Cues reference every subtitle block, with its duration', async () => {
	// "For each subtitle track present, each subtitle frame SHOULD be referenced by a CuePoint element with a
	// CueDuration element", so that a subtitle still shown at a seek target can be found

	// Returns [CueTime, CueTrack, CueDuration] for each CueTrackPositions
	const readCuePoints = (bytes: Uint8Array) => {
		const readVint = (position: number, keepMarker: boolean) => {
			let length = 1;
			while (!(bytes[position]! & (0x80 >> (length - 1)))) {
				length++;
			}

			let value = keepMarker ? bytes[position]! : bytes[position]! & (0xff >> length);
			for (let i = 1; i < length; i++) {
				value = value * 256 + bytes[position + i]!;
			}
			return { value, length };
		};

		const result: (number | null)[][] = [];
		const walk = (start: number, end: number, cue: (number | null)[]) => {
			for (let position = start; position < end;) {
				const id = readVint(position, true);
				const size = readVint(position + id.length, false);
				const dataStart = position + id.length + size.length;
				const dataEnd = Math.min(end, dataStart + size.value);
				const uint = () => bytes.subarray(dataStart, dataEnd).reduce((value, byte) => value * 256 + byte, 0);

				if (id.value === 0x18538067 || id.value === 0x1c53bb6b) {
					walk(dataStart, dataEnd, cue); // Segment, Cues
				} else if (id.value === 0xbb) {
					walk(dataStart, dataEnd, [null, null, null]); // CuePoint
				} else if (id.value === 0xb3) {
					cue[0] = uint(); // CueTime
				} else if (id.value === 0xb7) {
					const positions = [cue[0]!, null, null];
					walk(dataStart, dataEnd, positions); // CueTrackPositions
					result.push(positions);
				} else if (id.value === 0xf7) {
					cue[1] = uint(); // CueTrack
				} else if (id.value === 0xb2) {
					cue[2] = uint(); // CueDuration
				}

				position = dataEnd;
			}
		};

		walk(0, bytes.length, []);
		return result;
	};

	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const video = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(video);
	const subtitles = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(subtitles);
	await output.start();

	// B, from 2 to 8 s, is still shown in the cluster that begins at 5 s
	await subtitles.add(
		'WEBVTT\n\n00:00.500 --> 00:01.500\nA\n\n00:02.000 --> 00:08.000\nB\n\n00:03.000 --> 00:03.500\nC\n',
	);
	subtitles.close();
	for (let i = 0; i < 100; i++) {
		const packet = new EncodedPacket(new Uint8Array(100), i % 50 === 0 ? 'key' : 'delta', i / 10, 0.1);
		await video.add(packet, { decoderConfig: { codec: 'avc1.42001f', codedWidth: 64, codedHeight: 64 } });
	}
	await output.finalize();

	const cuePoints = readCuePoints(new Uint8Array(output.target.buffer!));
	// The video key frames at 0 and 5 s, as before
	expect(cuePoints.filter(([, track]) => track === 1)).toEqual([[0, 1, null], [5000, 1, null]]);
	expect(cuePoints.filter(([, track]) => track === 2)).toEqual([[500, 2, 1000], [2000, 2, 6000], [3000, 2, 500]]);
});
