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

test('Fragmented MP4 samples end where the next fragment starts with millisecond timestamps', async () => {
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source);
	await output.start();

	// 29.97 fps with timestamps rounded to milliseconds and exact frame durations, as in WebM files from FFmpeg
	for (let i = 0; i < 300; i++) {
		const timestamp = Math.round(i * 1001 / 30) / 1000;
		const packet = new EncodedPacket(new Uint8Array(16), i % 30 === 0 ? 'key' : 'delta', timestamp, 1001 / 30000);
		await source.add(packet, { decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } });
	}
	await output.finalize();

	// Each traf's decode time and the sum of its sample durations
	const bytes = new Uint8Array(output.target.buffer!);
	const view = toDataView(bytes);
	const type = (pos: number) => String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
	const fragments: { decodeTime: number; duration: number }[] = [];
	for (let pos = 0; pos < bytes.byteLength; pos += view.getUint32(pos)) {
		if (type(pos) !== 'moof') {
			continue;
		}

		const traf = pos + 8 + view.getUint32(pos + 8); // After mfhd
		let decodeTime = 0;
		let defaultDuration = 0;
		let duration = 0;
		for (let child = traf + 8; child < traf + view.getUint32(traf); child += view.getUint32(child)) {
			const flags = view.getUint32(child + 8) & 0xffffff;
			if (type(child) === 'tfhd' && flags & 0x08) {
				defaultDuration = view.getUint32(child + 16 + (flags & 0x01 ? 8 : 0) + (flags & 0x02 ? 4 : 0));
			} else if (type(child) === 'tfdt') {
				const isVersion1 = bytes[child + 8] === 1;
				decodeTime = isVersion1 ? Number(view.getBigUint64(child + 12)) : view.getUint32(child + 12);
			} else if (type(child) === 'trun') {
				const sampleCount = view.getUint32(child + 12);
				let entry = child + 16 + (flags & 0x01 ? 4 : 0) + (flags & 0x04 ? 4 : 0);
				const entrySize = 4 * [0x100, 0x200, 0x400, 0x800].filter(x => flags & x).length;
				for (let i = 0; i < sampleCount; i++, entry += entrySize) {
					duration += flags & 0x100 ? view.getUint32(entry) : defaultDuration;
				}
			}
		}
		fragments.push({ decodeTime, duration });
	}

	// ISO/IEC 14496-12: a fragment's decode time is the sum of the durations of all earlier samples. Each fragment's
	// last sample used to keep its packet duration, ending up to a third of a millisecond after the next fragment's
	// start, which readers adding up durations accumulate.
	expect(fragments).toHaveLength(10);
	for (let i = 1; i < fragments.length; i++) {
		expect(fragments[i]!.decodeTime).toBe(fragments[i - 1]!.decodeTime + fragments[i - 1]!.duration);
	}
});

test('Fragmented MP4 fragments start where the previous one ends, except after real gaps', async () => {
	type TestPacket = { timestamp: number; type: 'key' | 'delta'; duration: number };

	// Returns the track's timescale and each traf's decode time and end (decode time plus sample durations)
	const writeFragments = async (packets: TestPacket[], frameRate?: number) => {
		const format = new Mp4OutputFormat({ fastStart: 'fragmented' });
		const output = new Output({ format, target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source, { frameRate });
		await output.start();
		for (const { timestamp, type, duration } of packets) {
			const packet = new EncodedPacket(new Uint8Array(16), type, timestamp, duration);
			await source.add(packet, { decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } });
		}
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		const view = toDataView(bytes);
		const type = (pos: number) => String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
		const children = (start: number, end: number) => {
			const result: number[] = [];
			for (let pos = start; pos < end; pos += view.getUint32(pos)) {
				result.push(pos);
			}
			return result;
		};
		const child = (box: number, name: string) => {
			return children(box + 8, box + view.getUint32(box)).find(x => type(x) === name)!;
		};

		const moov = children(0, bytes.byteLength).find(x => type(x) === 'moov')!;
		const mdhd = child(child(child(moov, 'trak'), 'mdia'), 'mdhd');
		const timescale = view.getUint32(mdhd + (bytes[mdhd + 8] === 1 ? 28 : 20));

		const fragments: { decodeTime: number; end: number }[] = [];
		for (const moof of children(0, bytes.byteLength).filter(x => type(x) === 'moof')) {
			const traf = child(moof, 'traf');
			let decodeTime = 0;
			let defaultDuration = 0;
			let duration = 0;
			for (const box of children(traf + 8, traf + view.getUint32(traf))) {
				const flags = view.getUint32(box + 8) & 0xffffff;
				if (type(box) === 'tfhd' && flags & 0x08) {
					defaultDuration = view.getUint32(box + 16 + (flags & 0x01 ? 8 : 0) + (flags & 0x02 ? 4 : 0));
				} else if (type(box) === 'tfdt') {
					const isVersion1 = bytes[box + 8] === 1;
					decodeTime = isVersion1 ? Number(view.getBigUint64(box + 12)) : view.getUint32(box + 12);
				} else if (type(box) === 'trun') {
					const sampleCount = view.getUint32(box + 12);
					let entry = box + 16 + (flags & 0x01 ? 4 : 0) + (flags & 0x04 ? 4 : 0);
					const entrySize = 4 * [0x100, 0x200, 0x400, 0x800].filter(x => flags & x).length;
					for (let i = 0; i < sampleCount; i++, entry += entrySize) {
						duration += flags & 0x100 ? view.getUint32(entry) : defaultDuration;
					}
				}
			}
			fragments.push({ decodeTime, end: decodeTime + duration });
		}

		// The holes between fragments, in seconds
		const holes = fragments.slice(1).map((x, i) => (x.decodeTime - fragments[i]!.end) / timescale);
		return { timescale, holes };
	};

	// 60 fps with timestamps rounded to milliseconds, as in WebM files from FFmpeg: frames are 16 or 17 ms apart and
	// last 16.67 ms each, so a fragment's last sample used to end a third of a millisecond before a key frame 17 ms
	// away. A fragment's decode time is the sum of all earlier sample durations (ISO/IEC 14496-12), and readers that
	// add durations up (like mp4box.js) accumulate such holes.
	const packets: TestPacket[] = [];
	for (let i = 0; i < 600; i++) {
		const timestamp = Math.round(i * 1000 / 60) / 1000;
		packets.push({ timestamp, type: i % 66 === 0 ? 'key' : 'delta', duration: 1 / 60 });
	}
	const { holes } = await writeFragments(packets);
	expect(holes).toEqual(Array<number>(9).fill(0));

	// A real pause before a key frame stays
	const paused = packets.map((x, i) => i < 330 ? x : { ...x, timestamp: x.timestamp + 0.5 });
	const { holes: pausedHoles } = await writeFragments(paused);
	expect(pausedHoles.filter(x => x !== 0)).toHaveLength(1);
	expect(pausedHoles[4]).toBeGreaterThan(0.45);

	// So does a frame dropped right before a key frame, even when that's a single tick of a frame rate timescale
	const dropped: TestPacket[] = [];
	for (let i = 0; i < 90; i++) {
		if (i !== 59) {
			dropped.push({ timestamp: i / 30, type: i % 30 === 0 ? 'key' : 'delta', duration: 1 / 30 });
		}
	}
	const { timescale: frameRateTimescale, holes: droppedHoles } = await writeFragments(dropped, 30);
	expect(frameRateTimescale).toBe(30);
	expect(droppedHoles).toEqual([0, 1 / 30]);

	// The same 60 fps stream with B-frames (closed GOPs: I, then P B B in decode order), as x264 writes it into MKV
	const reordered: TestPacket[] = [];
	for (let start = 0; start + 61 <= 610; start += 61) {
		const order = [start];
		for (let i = 0; i < 20; i++) {
			order.push(start + 3 * i + 3, start + 3 * i + 1, start + 3 * i + 2);
		}
		for (const index of order) {
			const timestamp = Math.round(index * 1000 / 60) / 1000;
			reordered.push({ timestamp, type: index === start ? 'key' : 'delta', duration: 1 / 60 });
		}
	}
	const { holes: reorderedHoles } = await writeFragments(reordered);
	expect(reorderedHoles).toEqual(Array<number>(9).fill(0));
});

test('Fragmented AAC with millisecond timestamps doesn\'t overlap the next fragment', async () => {
	// 44.1 kHz AAC frames with timestamps rounded to milliseconds, starting at -23 ms (encoder priming), with
	// durations as Matroska gives them: the gap to the next block. The track then doesn't start on a whole tick.
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();
	const timestamp = (index: number) => Math.round((index - 1) * 1024 / 44.1) / 1000;
	for (let i = 0; i < 1300; i++) {
		const duration = timestamp(i + 1) - timestamp(i);
		const packet = new EncodedPacket(new Uint8Array(20).fill(i & 0xff), 'key', timestamp(i), duration);
		await source.add(packet, {
			decoderConfig: {
				codec: 'mp4a.40.2',
				sampleRate: 44100,
				numberOfChannels: 2,
				description: new Uint8Array([0x12, 0x10]),
			},
		});
	}
	await output.finalize();

	// Each traf's decode time and end (decode time plus sample durations)
	const bytes = new Uint8Array(output.target.buffer!);
	const view = toDataView(bytes);
	const type = (pos: number) => String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
	const fragments: { decodeTime: number; end: number }[] = [];
	for (let pos = 0; pos < bytes.byteLength; pos += view.getUint32(pos)) {
		if (type(pos) !== 'moof') {
			continue;
		}

		const traf = pos + 8 + view.getUint32(pos + 8); // After mfhd
		let decodeTime = 0;
		let defaultDuration = 0;
		let duration = 0;
		for (let child = traf + 8; child < traf + view.getUint32(traf); child += view.getUint32(child)) {
			const flags = view.getUint32(child + 8) & 0xffffff;
			if (type(child) === 'tfhd' && flags & 0x08) {
				defaultDuration = view.getUint32(child + 16 + (flags & 0x01 ? 8 : 0) + (flags & 0x02 ? 4 : 0));
			} else if (type(child) === 'tfdt') {
				const isVersion1 = bytes[child + 8] === 1;
				decodeTime = isVersion1 ? Number(view.getBigUint64(child + 12)) : view.getUint32(child + 12);
			} else if (type(child) === 'trun') {
				const sampleCount = view.getUint32(child + 12);
				let entry = child + 16 + (flags & 0x01 ? 4 : 0) + (flags & 0x04 ? 4 : 0);
				const entrySize = 4 * [0x100, 0x200, 0x400, 0x800].filter(x => flags & x).length;
				for (let i = 0; i < sampleCount; i++, entry += entrySize) {
					duration += flags & 0x100 ? view.getUint32(entry) : defaultDuration;
				}
			}
		}
		fragments.push({ decodeTime, end: decodeTime + duration });
	}

	// The decode times are written relative to the track's start, so they're rounded differently than the durations
	expect(fragments.length).toBeGreaterThan(20);
	const joins = fragments.slice(1).map((x, i) => x.decodeTime - fragments[i]!.end);
	expect(joins.filter(x => x < 0)).toEqual([]);
	expect(joins.filter(x => x > 0)).toEqual([]);
});

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
