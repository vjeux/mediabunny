import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert, toDataView } from '../../src/misc.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('ISOBMFF muxer internally converts ADTS to AAC', async () => {
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
		format: new Mp4OutputFormat(),
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

test('Fragmented fMP4 with video+audio preserves B-frame CTS', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	const originalVideoSink = new EncodedPacketSink(videoTrack);
	const originalTimestamps: number[] = [];
	for await (const packet of originalVideoSink.packets()) {
		originalTimestamps.push(packet.timestamp);
	}

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputVideoTrack = await outputAsInput.getPrimaryVideoTrack();
	assert(outputVideoTrack);

	const videoSink = new EncodedPacketSink(outputVideoTrack);

	const timestamps: number[] = [];
	for await (const packet of videoSink.packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual(originalTimestamps);
});

test('Zero start timestamp, regular MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') || str.includes('elst')).toBe(false);
});

test('Non-zero start timestamp, regular MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') && str.includes('elst')).toBe(true);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	const durations: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		durations.push(packet.duration);
	}

	expect(timestamps).toEqual([1, 1.1, 1.2, 1.3]);
	expect(durations).toEqual([0.1, 0.1, 0.1, 0.1]);
});

test('Non-zero start timestamp, fragmented MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') || str.includes('elst')).toBe(false);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	const durations: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		durations.push(packet.duration);
	}

	expect(timestamps).toEqual([1, 1.1, 1.2, 1.3]);
	expect(durations).toEqual([0.1, 0.1, 0.1, 0.1]);
});

test('Negative start timestamps, regular MP4', async () => {
	await testNegativeTimestampRoundTrip(Array.from({ length: 50 }, (_, index) => (index - 10) / 10), 0.1, false);
});

test('Negative start timestamps, fragmented MP4', async () => {
	await testNegativeTimestampRoundTrip(Array.from({ length: 50 }, (_, index) => (index - 10) / 10), 0.1, true);
});

test('Wholly negative timestamps, regular MP4', async () => {
	await testNegativeTimestampRoundTrip([-1, -0.9, -0.8, -0.7, -0.6], 0.1, false);
});

test('Wholly negative timestamps, fragmented MP4', async () => {
	await testNegativeTimestampRoundTrip([-1, -0.9, -0.8, -0.7, -0.6], 0.1, true);
});

const testNegativeTimestampRoundTrip = async (
	timestamps: number[],
	duration: number,
	fragmented: boolean,
) => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: fragmented ? 'fragmented' : false }),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, { frameRate: 10 });

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

test('PCM audio', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBe(0);
});

test('PCM audio with non-zero timestamp', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBe(1);
});

test('PCM audio, silence padding', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('pcm-s16');
	const numChannels = await audioTrack.getNumberOfChannels();

	const expectedFrameCount = 48000 + 256;
	const sink = new EncodedPacketSink(audioTrack);
	let frameCount = 0;

	for await (const packet of sink.packets()) {
		frameCount += packet.byteLength / 2 / numChannels;
	}

	expect(frameCount).toBe(expectedFrameCount);
});

test('PCM audio, no silence padding with approximate timestamps', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);
	// 0.006 is 256/48000 "rounded up", but it's close enough for silence padding not to kick in
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0.006, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('pcm-s16');
	const numChannels = await audioTrack.getNumberOfChannels();

	const expectedFrameCount = 256 + 256;
	const sink = new EncodedPacketSink(audioTrack);
	let frameCount = 0;

	for await (const packet of sink.packets()) {
		frameCount += packet.byteLength / 2 / numChannels;
	}

	expect(frameCount).toBe(expectedFrameCount);
});

// https://github.com/Vanilagy/mediabunny/pull/391
test('At least one track is enabled even if all are added disabled', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	const source1 = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source1, { disposition: { default: false } });

	const source2 = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source2, { disposition: { default: false } });

	await output.start();

	await source1.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);
	await source2.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getVideoTracks();
	expect(tracks.length).toBe(2);

	// Even though both tracks were added disabled, the muxer forces the first one to be enabled
	expect((await tracks[0]!.getDisposition()).default).toBe(true);
	expect((await tracks[1]!.getDisposition()).default).toBe(false);
});

test('btrt boxes computed from packet sizes, regular MP4', async () => {
	const bytes = await copyVideoMp4(new Mp4OutputFormat());
	const boxes = findBtrtBoxes(bytes);

	expect(boxes).toEqual([
		{
			bufferSizeDB: 0,
			maxBitrate: 3261384,
			avgBitrate: 2858330,
		},
		{
			bufferSizeDB: 0,
			maxBitrate: 318224,
			avgBitrate: 317375,
		},
	]);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	expect(await videoTrack.getBitrate()).toBe(3261384);
	expect(await videoTrack.getAverageBitrate()).toBe(2858330);
	expect(await audioTrack.getBitrate()).toBe(318224);
	expect(await audioTrack.getAverageBitrate()).toBe(317375);
});

test('btrt boxes copied from input metadata in conversion, fragmented MP4', async () => {
	const bytes = await copyVideoMp4(new Mp4OutputFormat({ fastStart: 'fragmented' }));

	// These are equal to what was in the input file
	expect(findBtrtBoxes(bytes)).toEqual([
		{
			bufferSizeDB: 0,
			maxBitrate: 2858329,
			avgBitrate: 2858329,
		},
		{
			bufferSizeDB: 0,
			maxBitrate: 320000,
			avgBitrate: 317375,
		},
	]);
});

test('No btrt boxes, fragmented MP4 without bitrate metadata', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource((await videoTrack.getCodec())!);
	const audioSource = new EncodedAudioPacketSource((await audioTrack.getCodec())!);
	output.addVideoTrack(videoSource);
	output.addAudioTrack(audioSource);

	await output.start();

	const videoMeta = { decoderConfig: (await videoTrack.getDecoderConfig())! };
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		await videoSource.add(packet, videoMeta);
	}

	const audioMeta = { decoderConfig: (await audioTrack.getDecoderConfig())! };
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		await audioSource.add(packet, audioMeta);
	}

	await output.finalize();

	expect(findBtrtBoxes(new Uint8Array(output.target.buffer!))).toEqual([]);
});

const copyVideoMp4 = async (format: Mp4OutputFormat) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format,
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	return new Uint8Array(output.target.buffer!);
};

const findBtrtBoxes = (bytes: Uint8Array) => {
	const view = toDataView(bytes);
	const boxes: { bufferSizeDB: number; maxBitrate: number; avgBitrate: number }[] = [];

	for (let i = 0; i < bytes.length - 4; i++) {
		if (bytes[i] !== 0x62 || bytes[i + 1] !== 0x74 || bytes[i + 2] !== 0x72 || bytes[i + 3] !== 0x74) {
			continue;
		}

		const boxSize = view.getUint32(i - 4);
		expect(boxSize).toBe(20);

		boxes.push({
			bufferSizeDB: view.getUint32(i + 4),
			maxBitrate: view.getUint32(i + 8),
			avgBitrate: view.getUint32(i + 12),
		});
	}

	return boxes;
};

test('Chunks written in chronological order, no Fast Start', async () => {
	await testChunkOrder(false);
});

test('Chunks written in chronological order, in-memory Fast Start', async () => {
	await testChunkOrder('in-memory');
});

test('Chunks written in chronological order, reserved Fast Start', async () => {
	await testChunkOrder('reserve');
});

const testChunkOrder = async (fastStart: false | 'in-memory' | 'reserve') => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource('vp8');
	const audioSource = new EncodedAudioPacketSource('mp3');
	output.addVideoTrack(videoSource, { maximumPacketCount: 1000 });
	output.addAudioTrack(audioSource, { maximumPacketCount: 1000 });

	await output.start();

	// Add all video before all audio, so the muxer can't just write chunks in the order they complete
	const videoMeta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	for (let i = 0; i < 150; i++) {
		const packet = new EncodedPacket(new Uint8Array(8), i === 0 ? 'key' : 'delta', i / 30, 1 / 30);
		await videoSource.add(packet, videoMeta);
	}

	const audioMeta = { decoderConfig: { codec: 'mp3', numberOfChannels: 2, sampleRate: 48000 } };
	for (let i = 0; i < 200; i++) {
		const packet = new EncodedPacket(new Uint8Array(8), 'key', 0.01 + 1152 * i / 48000, 1152 / 48000);
		await audioSource.add(packet, audioMeta);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	// Packet data read from a BufferSource is a view into the file, so its byte offset is its position in the file
	const packets: { trackIndex: number; timestamp: number; offset: number }[] = [];
	const tracks = await input.getTracks();
	for (let i = 0; i < tracks.length; i++) {
		for await (const packet of new EncodedPacketSink(tracks[i]!).packets()) {
			packets.push({
				trackIndex: i,
				timestamp: packet.timestamp,
				offset: packet.data.byteOffset,
			});
		}
	}

	expect(packets).toHaveLength(350);
	const packetsInFileOrder = packets.sort((a, b) => a.offset - b.offset);

	const chunkStartTimestamps: number[] = [];
	for (let i = 0; i < packetsInFileOrder.length; i++) {
		if (i === 0 || packetsInFileOrder[i]!.trackIndex !== packetsInFileOrder[i - 1]!.trackIndex) {
			chunkStartTimestamps.push(packetsInFileOrder[i]!.timestamp);
		}
	}

	expect(chunkStartTimestamps.length).toBeGreaterThan(10);
	expect(chunkStartTimestamps).toEqual([...chunkStartTimestamps].sort((a, b) => a - b));
};

test('Reserved Fast Start rejects a maximum packet count beyond u32', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'reserve' }),
		target: new BufferTarget(),
	});
	output.addVideoTrack(new EncodedVideoPacketSource('vp8'), { maximumPacketCount: 2 ** 32 });

	await expect(output.start()).rejects.toThrow('exceeds the maximum');
});

test('Fragmented MP4 keeps the start offset of a track starting after the first fragment could be cut', async () => {
	// The avcC of video.mp4, so that a real SPS is parsed; the packet payloads are stubs
	const avcDescription = new Uint8Array([
		0x01, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x1e, 0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02,
		0x27, 0xe5, 0xc0, 0x5b, 0x81, 0x01, 0x02, 0xd2, 0x80, 0x00, 0x00, 0x03, 0x00, 0x80, 0x00, 0x00, 0x19,
		0x07, 0x8c, 0x18, 0xcb, 0x01, 0x00, 0x06, 0x68, 0xeb, 0xe0, 0x8c, 0xb2, 0x2c, 0xfd, 0xf8, 0xf8, 0x00,
	]);

	const muxStaggered = async (minimumFragmentDuration: number) => {
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration }),
			target: new BufferTarget(),
		});
		const video = new EncodedVideoPacketSource('avc');
		const audio = new EncodedAudioPacketSource('opus');
		output.addVideoTrack(video);
		output.addAudioTrack(audio);
		await output.start();

		// Video starts at -0.5 s (a key frame every other frame), the Opus track at -0.02 s; added in timestamp order
		const packets: { timestamp: number; isVideo: boolean; index: number }[] = [];
		for (let i = 0; i < 60; i++) {
			packets.push({ timestamp: -0.5 + i / 30, isVideo: true, index: i });
			packets.push({ timestamp: -0.02 + i * 0.02, isVideo: false, index: i });
		}
		packets.sort((a, b) => a.timestamp - b.timestamp);

		const videoConfig = { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080, description: avcDescription };
		const audioConfig = { codec: 'opus', numberOfChannels: 2, sampleRate: 48000 };
		for (const { timestamp, isVideo, index } of packets) {
			if (isVideo) {
				const data = new Uint8Array([0, 0, 0, 2, 0x65, 0x88]);
				const packet = new EncodedPacket(data, index % 2 === 0 ? 'key' : 'delta', timestamp, 1 / 30);
				await video.add(packet, index === 0 ? { decoderConfig: videoConfig } : undefined);
			} else {
				const packet = new EncodedPacket(new Uint8Array([0xfc, 0xff, 0xfe]), 'key', timestamp, 0.02);
				await audio.add(packet, index === 0 ? { decoderConfig: audioConfig } : undefined);
			}
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const firstTimestamps: number[] = [];
		for (const track of await input.getTracks()) {
			for await (const packet of new EncodedPacketSink(track).packets()) {
				firstTimestamps.push(packet.timestamp);
				break;
			}
		}
		return firstTimestamps;
	};

	// With the default fragment duration, no fragment is cut before the audio track is underway
	expect(await muxStaggered(1)).toEqual([-0.5, -0.02]);

	// With short fragments, the moov went out before the audio track's start offset was known: it had no edit list,
	// and its audio was read back from 0
	expect(await muxStaggered(0)).toEqual([-0.5, -0.02]);
});

// This used to cause an assertion failure in the box writing code
test('Reserved Fast Start with a B-frame GOP completed before all tracks are known', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'reserve' }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource('vp8');
	const audioSource = new EncodedAudioPacketSource('mp3');
	output.addVideoTrack(videoSource, { maximumPacketCount: 100 });
	output.addAudioTrack(audioSource, { maximumPacketCount: 100 });

	await output.start();

	const videoMeta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	const videoTimestamps = [0, 0.2, 0.1, 0.3];
	for (let i = 0; i < videoTimestamps.length; i++) {
		const type = i === 0 || i === 3 ? 'key' : 'delta';
		await videoSource.add(new EncodedPacket(new Uint8Array(8), type, videoTimestamps[i]!, 0.1), videoMeta);
	}

	const audioMeta = { decoderConfig: { codec: 'mp3', numberOfChannels: 2, sampleRate: 48000 } };
	await audioSource.add(new EncodedPacket(new Uint8Array(8), 'key', 0, 1152 / 48000), audioMeta);

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual(videoTimestamps);
});

test('Fragmented MP4 preserves interior key packets', async () => {
	const target = new BufferTarget();
	const output = new Output({
		target,
		format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 10 }),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();

	for (let i = 0; i < 6; i++) {
		await source.add(new EncodedPacket(new Uint8Array(1), i % 2 === 0 ? 'key' : 'delta', i, 1), {
			decoderConfig: { codec: 'vp8', codedWidth: 320, codedHeight: 180 },
		});
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	const first = await sink.getFirstKeyPacket({ metadataOnly: true });
	assert(first);

	expect((await sink.getNextKeyPacket(first, { metadataOnly: true }))?.timestamp).toBe(2);
	expect((await sink.getKeyPacket(4.1, { metadataOnly: true }))?.timestamp).toBe(4);
});
