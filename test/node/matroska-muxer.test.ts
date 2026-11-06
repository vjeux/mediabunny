import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { MkvOutputFormat, WebMOutputFormat } from '../../src/output-format.js';
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

test('Segment Duration ends with the media when audio starts below zero next to video', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(videoSource);
	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();

	// Video from 0 to 1 s, audio from -0.512 s (written via CodecDelay) to 1.28 s
	const packets = [
		...Array.from({ length: 30 }, (_, index) => ({
			source: videoSource,
			packet: new EncodedPacket(new Uint8Array(64).fill(index), 'key', index / 30, 1 / 30),
		})),
		...Array.from({ length: 56 }, (_, index) => ({
			source: audioSource,
			packet: new EncodedPacket(new Uint8Array(64).fill(index), 'key', (index - 16) * 32 / 1000, 32 / 1000),
		})),
	].sort((a, b) => a.packet.timestamp - b.packet.timestamp);

	let videoStarted = false;
	let audioStarted = false;
	for (const { source, packet } of packets) {
		if (source === videoSource) {
			await videoSource.add(packet, videoStarted
				? undefined
				: { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } });
			videoStarted = true;
		} else {
			const decoderConfig = {
				codec: 'mp4a.40.2',
				numberOfChannels: 2,
				sampleRate: 32000,
				description: new Uint8Array([0x12, 0x90]),
			};
			await audioSource.add(packet, audioStarted ? undefined : { decoderConfig });
			audioStarted = true;
		}
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await input.computeDuration()).toBe(1.28);
	expect(await input.getDurationFromMetadata()).toBe(1.28);
});

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

test('WebM output stores the display size in pixels', async () => {
	// WebM only allows pixels as the DisplayUnit. WebKit and Gecko read DisplayWidth/DisplayHeight as a pixel size.
	const mux = async (displayAspectWidth: number, displayAspectHeight: number) => {
		const output = new Output({
			format: new WebMOutputFormat(),
			target: new BufferTarget(),
		});

		const source = new EncodedVideoPacketSource('vp8');
		output.addVideoTrack(source);
		await output.start();

		await source.add(new EncodedPacket(new Uint8Array(64), 'key', 0, 0.04), {
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 640,
				codedHeight: 480,
				displayAspectWidth,
				displayAspectHeight,
			},
		});
		await output.finalize();

		return new Uint8Array(output.target.buffer!);
	};

	const bytes = await mux(16, 9);
	expect(containsBytes(bytes, [0x54, 0xb0, 0x82, 0x03, 0x55])).toBe(true); // DisplayWidth 853
	expect(containsBytes(bytes, [0x54, 0xba, 0x82, 0x01, 0xe0])).toBe(true); // DisplayHeight 480
	expect(containsBytes(bytes, [0x54, 0xb2])).toBe(false); // No DisplayUnit

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	expect(await track.getSquarePixelWidth()).toBe(853);
	expect(await track.getSquarePixelHeight()).toBe(480);

	// DisplayWidth must not be 0, which 480 * 1/2000 would round to
	expect(containsBytes(await mux(1, 2000), [0x54, 0xb0, 0x81, 0x01])).toBe(true); // DisplayWidth 1
});

test('Negative audio start timestamps that aren\'t whole milliseconds stay within half a millisecond', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);

	await output.start();

	// AAC with the usual 1024 priming samples at 44.1 kHz: the first frame starts at -23.2199... ms
	const frameDuration = 1024 / 44100;
	const meta = {
		decoderConfig: {
			codec: 'mp4a.40.2',
			numberOfChannels: 2,
			sampleRate: 44100,
			description: new Uint8Array([0x12, 0x10]),
		},
	};
	const inputPackets = Array.from({ length: 20 }, (_, index) => new EncodedPacket(
		new Uint8Array(64).fill(index),
		'key',
		(index - 1) * frameDuration,
		frameDuration,
	));

	for (let i = 0; i < inputPackets.length; i++) {
		await source.add(inputPackets[i]!, i === 0 ? meta : undefined);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const outputTimestamps: number[] = [];
	for await (const packet of sink.packets()) {
		outputTimestamps.push(packet.timestamp);
	}

	// Matroska stores millisecond ticks, so each timestamp should be the input rounded to the nearest millisecond
	expect(outputTimestamps).toEqual(inputPackets.map(packet => Math.round(packet.timestamp * 1000) / 1000));
});

test('Negative audio start timestamps at half milliseconds keep their spacing', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(source);

	await output.start();

	// Like WebCodecs Opus: 312 samples of pre-skip (-6.5 ms) and 20 ms frames, on whole microseconds
	const meta = {
		decoderConfig: {
			codec: 'opus',
			numberOfChannels: 2,
			sampleRate: 48000,
		},
	};
	const inputPackets = Array.from({ length: 500 }, (_, index) => new EncodedPacket(
		new Uint8Array([0xfc, index & 0xff]),
		'key',
		(index * 20000 - 6500) / 1e6,
		0.02,
	));

	for (let i = 0; i < inputPackets.length; i++) {
		await source.add(inputPackets[i]!, i === 0 ? meta : undefined);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const outputTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		outputTimestamps.push(packet.timestamp);
	}

	expect(outputTimestamps).toHaveLength(inputPackets.length);
	for (let i = 0; i < outputTimestamps.length; i++) {
		expect(Math.abs(outputTimestamps[i]! - inputPackets[i]!.timestamp)).toBeLessThanOrEqual(0.0005 + 1e-9);
		if (i > 0) {
			expect(outputTimestamps[i]! - outputTimestamps[i - 1]!).toBeCloseTo(0.02, 9);
		}
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

test('WebM output leaves out the Matroska v4 track flags', async () => {
	// FlagHearingImpaired, FlagVisualImpaired, FlagOriginal and FlagCommentary aren't WebM elements, and Chrome's WebM
	// parser (MSE) rejects files that contain them
	const mux = async (format: MkvOutputFormat) => {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(source, {
			disposition: { hearingImpaired: true, visuallyImpaired: true, original: true, commentary: true },
		});
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array([0xfc, 0xff]), 'key', 0, 0.02), {
			decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000 },
		});
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	const flagIds = [0x55ab, 0x55ac, 0x55ae, 0x55af];
	const hasFlag = (bytes: Uint8Array, id: number) => bytes.some((byte, i) => {
		return byte === id >> 8 && bytes[i + 1] === (id & 0xff) && bytes[i + 2] === 0x81 && bytes[i + 3] === 1;
	});

	const webm = await mux(new WebMOutputFormat());
	expect(flagIds.map(id => hasFlag(webm, id))).toEqual([false, false, false, false]);

	const mkv = await mux(new MkvOutputFormat());
	expect(flagIds.map(id => hasFlag(mkv, id))).toEqual([true, true, true, true]);
});

test('Opus without a decoder description still gets its identification header as CodecPrivate', async () => {
	// The Matroska Opus mapping requires the OpusHead in CodecPrivate, e.g. for packets remuxed from MPEG-TS. Its
	// pre-skip and the CodecDelay both hold the negative start, in 48 kHz samples and nanoseconds.
	const muxAndRead = async (firstTimestamp: number, configBeforeStart = false) => {
		const decoderConfig = { codec: 'opus', numberOfChannels: 2, sampleRate: 44100 };
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(source, configBeforeStart ? { decoderConfig } : {});
		await output.start();
		for (let i = 0; i < 3; i++) {
			await source.add(
				new EncodedPacket(new Uint8Array([0xfc, 0xff]), 'key', firstTimestamp + 0.02 * i, 0.02),
				i === 0 ? { decoderConfig } : undefined,
			);
		}
		await output.finalize();
		const bytes = new Uint8Array(output.target.buffer!);

		// CodecDelay, in nanoseconds
		const delayIndex = bytes.findIndex((byte, i) => byte === 0x56 && bytes[i + 1] === 0xaa);
		let codecDelay = 0;
		for (let i = 0; delayIndex !== -1 && i < (bytes[delayIndex + 2]! & 0x7f); i++) {
			codecDelay = codecDelay * 256 + bytes[delayIndex + 3 + i]!;
		}

		using input = new Input({
			source: new BufferSource(bytes),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const config = await track.getDecoderConfig();
		return {
			description: config!.description && [...new Uint8Array(config!.description as ArrayBuffer)],
			codecDelay,
			firstTimestamp: await track.getFirstTimestamp(),
		};
	};

	const opusHead = (preSkip: number) => [
		...[...'OpusHead'].map(x => x.charCodeAt(0)),
		1, 2, preSkip & 0xff, preSkip >> 8, 0x44, 0xac, 0, 0, 0, 0, 0,
	];

	const check = async (firstTimestamp: number, configBeforeStart: boolean, preSkip: number) => {
		const result = await muxAndRead(firstTimestamp, configBeforeStart);
		expect(result.description).toEqual(opusHead(preSkip));
		expect(result.codecDelay).toBe(Math.round(preSkip * 1e9 / 48000));
		// Read back within a tick (1 ms), as readers round CodecDelay to whole ticks
		expect(Math.abs(result.firstTimestamp - firstTimestamp)).toBeLessThan(0.001);
	};

	await check(0, false, 0);
	await check(-0.0065, false, 312);
	await check(-0.0065, true, 312); // The decoder config is known before the first packet
	// The pre-skip can't hold more than 65535 samples; the rest of a longer delay stays in the block timestamps
	await check(-2, false, 65535);
});

test('Movie-level tags are written without a TargetType string', async () => {
	// FFmpeg prefixes every tag name with the TargetType (MOVIE/TITLE instead of title), so its own muxer leaves it
	// out of global tags; TargetTypeValue 50 alone marks the tags as movie-level
	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(source);
	output.setMetadataTags({ title: 'Title', artist: 'Artist' });
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array([0xfc, 0xff]), 'key', 0, 0.02), {
		decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000 },
	});
	await output.finalize();
	const bytes = new Uint8Array(output.target.buffer!);

	const containsId = (id: number[]) => bytes.some((_, i) => id.every((byte, j) => bytes[i + j] === byte));
	expect(containsId([0x63, 0xca])).toBe(false); // TargetType
	expect(containsId([0x68, 0xca, 0x81, 50])).toBe(true); // TargetTypeValue 50

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const tags = await input.getMetadataTags();
	expect([tags.title, tags.artist]).toEqual(['Title', 'Artist']);
});

test('AV1 blocks are stored without temporal delimiter OBUs', async () => {
	const target = new BufferTarget();
	const output = new Output({ target, format: new MkvOutputFormat() });
	const source = new EncodedVideoPacketSource('av1');
	output.addVideoTrack(source);
	await output.start();

	// Temporal unit as WebCodecs encoders emit it: OBU_TEMPORAL_DELIMITER followed by an OBU_FRAME
	const frame = [0x32, 0x03, 0xaa, 0xbb, 0xcc];
	await source.add(new EncodedPacket(new Uint8Array([0x12, 0x00, ...frame]), 'key', 0, 1), {
		decoderConfig: { codec: 'av01.0.04M.08', codedWidth: 320, codedHeight: 240 },
	});
	await output.finalize();

	using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	// The Matroska AV1 mapping says temporal delimiters SHOULD NOT be stored; FFmpeg's matroskaenc strips them too
	const packet = await new EncodedPacketSink(track).getFirstPacket();
	expect(packet?.data).toEqual(new Uint8Array(frame));
});

test('Equally spaced packets at half milliseconds stay equally spaced', async () => {
	// Timestamps computed in floating point land a hair off their exact half millisecond: (0.0135 + 0.02 * 29) * 1000
	// is 593.4999999999999. All of them must round the same way, or the 20 ms spacing becomes 19 and 21 ms.
	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(source);
	await output.start();
	for (let i = 0; i < 100; i++) {
		await source.add(
			new EncodedPacket(new Uint8Array([0xfc, 0xff]), 'key', 0.0135 + 0.02 * i, 0.02),
			i === 0 ? { decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000 } } : undefined,
		);
	}
	await output.finalize();

	using input = new Input({
		source: new BufferSource(new Uint8Array(output.target.buffer!)),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const timestampsInMs: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		timestampsInMs.push(Math.round(packet.timestamp * 1000));
	}
	expect(timestampsInMs).toEqual(Array.from({ length: 100 }, (_, i) => 14 + 20 * i));
});

test('Frames that outgrow a 4-byte element size keep their size', async () => {
	// Blocks reserve 4 size bytes, which hold up to 2^28 - 2
	const frameSizes = [2 ** 28, 100];

	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source);
	await output.start();

	const decoderConfig = { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 };
	await source.add(new EncodedPacket(new Uint8Array(frameSizes[0]!), 'key', 0, 0.5), { decoderConfig });
	await source.add(new EncodedPacket(new Uint8Array(frameSizes[1]!), 'delta', 0.5, 0.5));
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const sizes: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
		sizes.push(packet.byteLength);
	}
	expect(sizes).toEqual(frameSizes);
});
