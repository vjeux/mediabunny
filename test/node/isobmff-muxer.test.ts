import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget, NullTarget } from '../../src/target.js';
import { CmafOutputFormat, Mp4OutputFormat, WebMOutputFormat, MovOutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert, toDataView } from '../../src/misc.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { IsobmffMuxer } from '../../src/isobmff/isobmff-muxer.js';

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

test('btrt max bitrate counts the samples of one second, not one more', async () => {
	for (const frameRate of [24, 25, 30, 60]) {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source);
		await output.start();

		// Constant frame rate and size, so every one-second window holds exactly `frameRate` frames
		for (let i = 0; i < 3 * frameRate; i++) {
			const type = i === 0 ? 'key' : 'delta';
			const packet = new EncodedPacket(new Uint8Array(1000), type, i / frameRate, 1 / frameRate);
			await source.add(packet, { decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } });
		}
		await output.finalize();

		expect(findBtrtBoxes(new Uint8Array(output.target.buffer!))).toEqual([{
			bufferSizeDB: 0,
			maxBitrate: 8 * 1000 * frameRate,
			avgBitrate: 8 * 1000 * frameRate,
		}]);
	}
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

test('Reserved Fast Start leaves room for many short tracks', async () => {
	const audioConfig = {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		description: new Uint8Array([0x11, 0x90]),
	};
	const videoConfig = { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 };

	for (const kind of ['video', 'audio'] as const) {
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'reserve' }),
			target: new BufferTarget(),
		});

		// Few packets per track, starting at 1 s: each track's edit list, btrt and sample group (audio) or
		// stss/ctts/cslg (video) headers outweigh the slack in its sample table estimate
		const trackCount = kind === 'audio' ? 100 : 40;
		const packetCount = kind === 'audio' ? 2 : 3;
		const sources = Array.from({ length: trackCount }, () => {
			if (kind === 'audio') {
				const source = new EncodedAudioPacketSource('aac');
				output.addAudioTrack(source, { maximumPacketCount: packetCount });
				return source;
			} else {
				const source = new EncodedVideoPacketSource('vp9');
				output.addVideoTrack(source, { maximumPacketCount: packetCount });
				return source;
			}
		});
		await output.start();

		for (let i = 0; i < packetCount; i++) {
			for (const source of sources) {
				if (source instanceof EncodedAudioPacketSource) {
					const packet = new EncodedPacket(new Uint8Array(10), 'key', 1 + i * 1024 / 48000, 1024 / 48000);
					await source.add(packet, { decoderConfig: audioConfig });
				} else {
					// I P B in decode order, with slightly uneven frame times
					const frame = [0, 2, 1][i]!;
					const timestamp = 1 + frame / 30 + i * 1e-4;
					const packet = new EncodedPacket(new Uint8Array(10), i === 0 ? 'key' : 'delta', timestamp, 1 / 30);
					await source.add(packet, { decoderConfig: videoConfig });
				}
			}
		}

		await output.finalize(); // Threw "The moov box … exceed the space reserved for them"

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const tracks = await input.getTracks();
		expect(tracks).toHaveLength(trackCount);
		let packetsRead = 0;
		for await (const packet of new EncodedPacketSink(tracks.at(-1)!).packets()) {
			expect(packet.timestamp).toBeGreaterThanOrEqual(1);
			packetsRead++;
		}
		expect(packetsRead).toBe(packetCount);
	}
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

test('FLAC sample entry declares the bit depth from STREAMINFO', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('flac');
	output.addAudioTrack(source);
	await output.start();

	// 'fLaC', last STREAMINFO block header, then STREAMINFO: 48 kHz, 2 channels, 24 bits per sample
	const description = new Uint8Array([
		0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22,
		0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0b, 0xb8, 0x03, 0x70,
		0x00, 0x00, 0x00, 0x00, ...new Uint8Array(16),
	]);
	await source.add(new EncodedPacket(new Uint8Array(100), 'key', 0, 4096 / 48000), {
		decoderConfig: { codec: 'flac', numberOfChannels: 2, sampleRate: 48000, description },
	});
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	const entryType = bytes.findIndex((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === 'fLaC');
	expect(entryType).toBeGreaterThan(0);

	// AudioSampleEntry: reserved (6), data_reference_index, reserved (8), channelcount, samplesize
	const sampleSize = toDataView(bytes).getUint16(entryType + 4 + 6 + 2 + 8 + 2);
	expect(sampleSize).toBe(24); // FLAC-in-ISOBMFF requires samplesize to equal the STREAMINFO bit depth
});

test('CMAF sidx uses the timescale and ID of the referenced track', async () => {
	const output = new Output({
		format: new CmafOutputFormat(),
		target: new BufferTarget(),
		initTarget: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();

	const decoderConfig = {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		description: new Uint8Array([0x11, 0x90]), // AAC-LC, 48 kHz, stereo
	};
	for (let i = 0; i < 10; i++) {
		const packet = new EncodedPacket(new Uint8Array(16), 'key', i * 1024 / 48000, 1024 / 48000);
		await source.add(packet, { decoderConfig });
	}
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	const view = toDataView(bytes);
	const sidxType = bytes.findIndex((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === 'sidx');
	expect(sidxType).toBeGreaterThan(0);

	// ISO 14496-12 recommends the mdhd timescale of the reference track; FFmpeg takes the subsegment duration as is
	expect(view.getUint32(sidxType + 8)).toBe(1); // reference_ID
	expect(view.getUint32(sidxType + 12)).toBe(48000); // timescale
	expect(view.getUint32(sidxType + 40)).toBe(10 * 1024); // subsegment_duration
});

test('Reserved Fast Start conversion of a video whose frame rate rises later on', async () => {
	// Like a screen recording: one frame per second while nothing changes, then 60 fps
	const timestamps = [
		...Array.from({ length: 300 }, (_, i) => i),
		...Array.from({ length: 2000 }, (_, i) => 300 + i / 60),
	];

	const inputOutput = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const inputSource = new EncodedVideoPacketSource('vp8');
	inputOutput.addVideoTrack(inputSource);
	await inputOutput.start();
	for (let i = 0; i < timestamps.length; i++) {
		const duration = (timestamps[i + 1] ?? timestamps[i]! + 1 / 60) - timestamps[i]!;
		await inputSource.add(
			new EncodedPacket(new Uint8Array(8).fill(i), i === 0 ? 'key' : 'delta', timestamps[i]!, duration),
			i === 0 ? { decoderConfig: { codec: 'vp8', codedWidth: 16, codedHeight: 16 } } : undefined,
		);
	}
	await inputOutput.finalize();

	using input = new Input({ source: new BufferSource(inputOutput.target.buffer!), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'reserve' }), target: new BufferTarget() });

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute(); // Used to exceed the estimated maximum packet count

	using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const outputTrack = await outputInput.getPrimaryVideoTrack();
	assert(outputTrack);
	expect((await outputTrack.computePacketStats()).packetCount).toBe(timestamps.length);
});

test('Reserved Fast Start conversion of audio whose packet rate rises later on', async () => {
	// Like a WebRTC recording with DTX: one Opus packet per 400 ms during silence, then one per 20 ms
	const timestamps = [
		...Array.from({ length: 300 }, (_, i) => i * 0.4),
		...Array.from({ length: 3000 }, (_, i) => 120 + i * 0.02),
	];

	const inputOutput = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	const inputSource = new EncodedAudioPacketSource('opus');
	inputOutput.addAudioTrack(inputSource);
	await inputOutput.start();
	for (let i = 0; i < timestamps.length; i++) {
		await inputSource.add(
			new EncodedPacket(new Uint8Array([0xfc, i & 0xff]), 'key', timestamps[i]!, 0.02),
			i === 0 ? { decoderConfig: { codec: 'opus', numberOfChannels: 1, sampleRate: 48000 } } : undefined,
		);
	}
	await inputOutput.finalize();

	using input = new Input({ source: new BufferSource(inputOutput.target.buffer!), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'reserve' }), target: new BufferTarget() });

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute(); // Used to exceed the estimated maximum packet count

	using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const outputTrack = await outputInput.getPrimaryAudioTrack();
	assert(outputTrack);
	expect((await outputTrack.computePacketStats()).packetCount).toBe(timestamps.length);
});

test('Opus sample entry and dOps both declare 48 kHz, whatever the input sample rate was', async () => {
	for (const sampleRate of [48000, 16000]) {
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new BufferTarget(),
		});

		const source = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(source);
		await output.start();

		// OpusHead of a stream encoded from 44.1 kHz input, as Chromium's encoder writes it
		const description = new Uint8Array([
			0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x44, 0xac, 0x00, 0x00, 0, 0, 0,
		]);
		await source.add(new EncodedPacket(new Uint8Array([0xfc, 0xff, 0xfe]), 'key', 0, 0.02), {
			decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate, description },
		});
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		const view = toDataView(bytes);
		const find = (type: string) => bytes.findIndex(
			(_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === type,
		);

		// Opus-in-ISOBMFF requires 48000 in the sample entry, and Chromium requires dOps' InputSampleRate to match it
		const entryRate = view.getUint32(find('Opus') + 4 + 6 + 2 + 8 + 2 + 2 + 4) / 0x10000;
		const inputSampleRate = view.getUint32(find('dOps') + 4 + 1 + 1 + 2);
		expect(entryRate).toBe(48000);
		expect(inputSampleRate).toBe(48000);
	}
});

test('In-memory Fast Start keeps chunk offsets right when a second track crosses 4 GiB late', async () => {
	// Every packet is a view into this buffer, and the target drops the data, so the 5 GiB file never exists in memory
	const buffer = new Uint8Array(138_000_100);
	const videoSize = (i: number) => 138_000_000 + i;
	const audioSize = (i: number, padding: number) => 100_000 + i + (i === 0 ? padding : 0);

	const mux = async (padding: number) => {
		let moov: Uint8Array | null = null;
		const writePositions = new Map<number, number>(); // Packet size -> where it was written
		const target = new NullTarget();
		target.on('write', ({ start, end }) => writePositions.set(end - start, start));

		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'in-memory', onMoov: data => moov = data.slice() }),
			target,
		});
		const videoSource = new EncodedVideoPacketSource('vp9');
		const audioSource = new EncodedAudioPacketSource('aac');
		output.addVideoTrack(videoSource);
		output.addAudioTrack(audioSource);
		await output.start();

		// One chunk per packet; the audio track ends 9 large video chunks before the end
		for (let i = 0; i < 40; i++) {
			await videoSource.add(
				new EncodedPacket(buffer.subarray(0, videoSize(i)), i === 0 ? 'key' : 'delta', i, 1),
				{ decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } },
			);
			if (i < 31) {
				await audioSource.add(
					new EncodedPacket(buffer.subarray(0, audioSize(i, padding)), 'key', i, 1),
					{ decoderConfig: {
						codec: 'mp4a.40.2',
						numberOfChannels: 2,
						sampleRate: 48000,
						description: new Uint8Array([0x11, 0x90]),
					} },
				);
			}
		}
		await output.finalize();

		// The stco/co64 chunk offsets of each track
		assert(moov);
		const bytes: Uint8Array = moov;
		const view = toDataView(bytes);
		const offsetTables: number[][] = [];
		for (let i = 0; i + 4 <= bytes.length; i++) {
			const type = String.fromCharCode(...bytes.subarray(i, i + 4));
			if (type === 'stco' || type === 'co64') {
				offsetTables.push(Array.from({ length: view.getUint32(i + 8) }, (_, j) => type === 'co64'
					? Number(view.getBigUint64(i + 12 + 8 * j))
					: view.getUint32(i + 12 + 4 * j),
				));
			}
		}

		return { offsetTables, writePositions };
	};

	// The audio track's last chunk starts below 4 GiB, so only the video track needs co64. Before the moov grew by
	// 4 bytes for each video chunk offset and the mdat header by 8 bytes, that audio chunk sat this much lower:
	const unpadded = await mux(0);
	const videoChunkCount = unpadded.offsetTables[0]!.length;
	const lastAudioChunk = unpadded.offsetTables[1]!.at(-1)! - 4 * videoChunkCount - 8;

	// Pad the audio so that this chunk starts just below 4 GiB in the first layout, but past it once the moov grew
	const padding = 2 ** 32 - 8 - lastAudioChunk;
	const { offsetTables, writePositions } = await mux(padding);
	expect(offsetTables[1]!.at(-1)).toBeGreaterThanOrEqual(2 ** 32);

	expect(offsetTables[0]).toEqual(offsetTables[0]!.map((_, i) => writePositions.get(videoSize(i))));
	expect(offsetTables[1]).toEqual(offsetTables[1]!.map((_, i) => writePositions.get(audioSize(i, padding))));
});

test('getMimeType names the hvc1 sample entry when remuxing an hev1 HEVC track', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video-h265.mp4')),
		formats: ALL_FORMATS,
	});
	const inputTrack = await input.getPrimaryVideoTrack();
	assert(inputTrack);
	const decoderConfig = await inputTrack.getDecoderConfig();
	assert(decoderConfig);
	expect(decoderConfig.codec).toBe('hev1.1.6.L120.90'); // The source uses an 'hev1' sample entry

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('hevc');
	output.addVideoTrack(source);
	await output.start();
	const packet = await new EncodedPacketSink(inputTrack).getFirstPacket();
	assert(packet);
	await source.add(packet, { decoderConfig });
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	const contains = (fourCc: string) => bytes.some(
		(_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === fourCc,
	);
	expect(contains('hvc1')).toBe(true);
	expect(contains('hev1')).toBe(false);

	// The codec string's first element is the sample entry's four-character code (RFC 6381)
	expect(await output.getMimeType()).toBe('video/mp4; codecs="hvc1.1.6.L120.90"');
});

test('Media handler boxes have pre_defined = 0 in MP4 and the mhlr component type in MOV', async () => {
	for (const [format, expected] of [[new Mp4OutputFormat(), '\0\0\0\0'], [new MovOutputFormat(), 'mhlr']] as const) {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(10), 'key', 0, 1), {
			decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 },
		});
		await output.finalize();

		// The handler box of the track's media box, the one with the 'vide' handler type
		const bytes = new Uint8Array(output.target.buffer!);
		const text = (start: number) => String.fromCharCode(...bytes.subarray(start, start + 4));
		const hdlr = bytes.findIndex((_, i) => text(i) === 'hdlr' && text(i + 12) === 'vide');
		expect(hdlr).toBeGreaterThan(0);
		expect(text(hdlr + 8)).toBe(expected); // pre_defined, or the component type in QuickTime
	}
});

test('Fragmented MP4 does not keep the samples of fragments it already wrote', async () => {
	const target = new BufferTarget();
	const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: 'fragmented' }) });

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();

	// 100 s at 30 fps with a key frame every second, so roughly one fragment per second
	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 320, codedHeight: 180 } };
	for (let i = 0; i < 3000; i++) {
		await source.add(new EncodedPacket(new Uint8Array(1), i % 30 === 0 ? 'key' : 'delta', i / 30, 1 / 30), meta);
	}

	// A written fragment is only needed for its tfra entry: at most its first key sample should stay in memory, not
	// all of them (which grows without bound for long live streams)
	const trackData = (output._muxer as IsobmffMuxer).trackDatas[0]!;
	expect(trackData.finalizedChunks.length).toBeGreaterThan(90);
	const retainedSampleCount = trackData.finalizedChunks.reduce((sum, chunk) => sum + chunk.samples.length, 0);
	expect(retainedSampleCount).toBe(trackData.finalizedChunks.length);

	await output.finalize();

	using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);
	expect((await sink.getKeyPacket(50.5, { metadataOnly: true }))?.timestamp).toBe(50);
	expect((await sink.getPacket(Infinity, { metadataOnly: true }))?.timestamp).toBeCloseTo(2999 / 30);
});
