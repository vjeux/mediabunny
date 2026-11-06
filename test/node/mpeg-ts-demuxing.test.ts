import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource, ReadableStreamSource, CustomSource } from '../../src/source.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { ALL_FORMATS, MPEG_TS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { MpegTsDemuxer } from '../../src/mpeg-ts/mpeg-ts-demuxer.js';
import { MpegTsStreamType } from '../../src/mpeg-ts/mpeg-ts-misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('MPEG-TS input format', async () => {
	expect(MPEG_TS.mimeType).toBe('video/MP2T');
	expect(MPEG_TS.name).toBe('MPEG Transport Stream');
});

test('MPEG-TS metadata reading', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MPEG_TS);
	expect((await input.getFormat()).mimeType).toBe('video/MP2T');
	expect(await input.getMimeType()).toBe('video/MP2T; codecs="avc1.640020, mp4a.40.2"');

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	expect(videoTrack.id).toBe(0x100);
	expect(await videoTrack.getCodec()).toBe('avc');
	expect(await videoTrack.getInternalCodecId()).toBe(0x1b);
	expect(await videoTrack.getDisplayWidth()).toEqual(720);
	expect(await videoTrack.getDisplayHeight()).toEqual(720);
	expect(await videoTrack.getTimeResolution()).toBe(90_000);

	const videoDecoderConfig = await videoTrack.getDecoderConfig();
	expect(videoDecoderConfig).toEqual({
		codec: 'avc1.640020',
		codedWidth: 720,
		codedHeight: 720,
		colorSpace: {
			primaries: 'bt2020',
			transfer: 'hlg',
			matrix: 'bt2020-ncl',
			fullRange: false,
		},
		// No description, it's Annex B
	});

	expect(await videoTrack.getFirstTimestamp()).toBe(10.033333333333333);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(audioTrack.id).toBe(0x101);
	expect(await audioTrack.getCodec()).toBe('aac');
	expect(await audioTrack.getNumberOfChannels()).toBe(2);
	expect(await audioTrack.getSampleRate()).toBe(48000);

	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	expect(audioDecoderConfig).toEqual({
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		// No description, it's ADTS audio
	});

	expect(await audioTrack.getFirstTimestamp()).toBe(10.012);
});

test('MPEG-TS durations', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
		formats: ALL_FORMATS,
	});

	const firstTimestamp = await input.getFirstTimestamp();
	expect(firstTimestamp).toBe(10.012);

	const duration = await input.computeDuration();
	expect(duration).toBeCloseTo(15.004);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const videoFirstTimestamp = await videoTrack.getFirstTimestamp();
	expect(videoFirstTimestamp).toBe(10.033333333333333);

	const videoDuration = await videoTrack.computeDuration();
	expect(videoDuration).toBeCloseTo(15);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const audioFirstTimestamp = await audioTrack.getFirstTimestamp();
	expect(audioFirstTimestamp).toBe(10.012);

	const audioDuration = await audioTrack.computeDuration();
	expect(audioDuration).toBeCloseTo(15.004);
});

test('MPEG-TS AVC video packets', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	expect([...firstPacket.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);
	expect(firstPacket.data.byteLength).toBe(23813);
	expect(firstPacket.type).toBe('key');
	expect(firstPacket.timestamp).toBe(10.033333333333333);
	expect(firstPacket.duration).toBe(0.016666666666666666);
	expect(firstPacket.sequenceNumber).not.toBe(-1);

	const firstPacketMetadataOnly = await sink.getFirstPacket({ metadataOnly: true });
	assert(firstPacketMetadataOnly);
	expect(firstPacketMetadataOnly.data).toHaveLength(0);
	expect(firstPacketMetadataOnly.byteLength).toBe(23813);

	const secondPacket = await sink.getNextPacket(firstPacket);
	assert(secondPacket);

	expect([...secondPacket.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);
	expect(secondPacket.data.byteLength).toBe(5700);
	expect(secondPacket.type).toBe('delta');
	expect(secondPacket.timestamp).toBe(10.1);
	expect(secondPacket.duration).toBe(0.016666666666666666);
	expect(secondPacket.sequenceNumber).toBeGreaterThan(firstPacket.sequenceNumber);

	let currentPacket: EncodedPacket | null = firstPacket;
	let count = 0;

	while (currentPacket) {
		expect(currentPacket.duration).toBe(0.016666666666666666);

		currentPacket = await sink.getNextPacket(currentPacket);
		count++;
	}

	expect(count).toBe(298);
});

test('MPEG-TS AAC audio packets', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	expect(firstPacket.data[0]).toEqual(0xff);
	expect(firstPacket.data.byteLength).toBe(348);
	expect(firstPacket.type).toBe('key');
	expect(firstPacket.timestamp).toBe(10.012);
	expect(firstPacket.duration).toBe(0.021333333333333333);
	expect(firstPacket.sequenceNumber).not.toBe(-1);

	const secondPacket = await sink.getNextPacket(firstPacket);
	assert(secondPacket);

	expect(secondPacket.data[0]).toEqual(0xff);
	expect(secondPacket.data.byteLength).toBe(349);
	expect(secondPacket.type).toBe('key');
	expect(secondPacket.timestamp).toBeCloseTo(10.033333333333333);
	expect(secondPacket.duration).toBe(0.021333333333333333);
	expect(secondPacket.sequenceNumber).toBeGreaterThan(firstPacket.sequenceNumber);

	let currentPacket: EncodedPacket | null = firstPacket;
	let count = 0;

	while (currentPacket) {
		expect(currentPacket.duration).toBe(0.021333333333333333);

		currentPacket = await sink.getNextPacket(currentPacket);
		count++;
	}

	expect(count).toBe(234);
});

test('MPEG-TS video seeking', async () => {
	for (let i = 0; i < 2; i++) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(videoTrack);

		const firstTimestamp = await videoTrack.getFirstTimestamp();
		const firstPacket = await sink.getPacket(firstTimestamp);
		assert(firstPacket);
		expect(firstPacket.timestamp).toBe(firstTimestamp);
		expect(firstPacket.duration).toBe(0.016666666666666666);
		expect(firstPacket.sequenceNumber).toBe((await sink.getFirstPacket())?.sequenceNumber);

		const lastPacket = await sink.getPacket(Infinity);
		assert(lastPacket);
		expect(lastPacket.timestamp).toBeCloseTo(14.983333333333333);
		expect(lastPacket.duration).toBe(0.016666666666666666);

		const beforeFirst = await sink.getPacket(-10);
		expect(beforeFirst).toBeNull();

		const middlePacket = await sink.getPacket(12.5);
		assert(middlePacket);
		expect(middlePacket.timestamp).toBeCloseTo(12.5);
		expect(middlePacket.duration).toBe(0.016666666666666666);

		const allPackets: EncodedPacket[] = [];
		let currentPacket: EncodedPacket | null = firstPacket;

		while (currentPacket) {
			allPackets.push(currentPacket);
			currentPacket = await sink.getNextPacket(currentPacket);
		}

		expect(allPackets).toHaveLength(298);

		for (const packet of allPackets) {
			const seekedPacket = await sink.getPacket(packet.timestamp);
			assert(seekedPacket);
			expect(seekedPacket.timestamp).toBe(packet.timestamp);
			expect(seekedPacket.duration).toBe(packet.duration);
			expect(seekedPacket.sequenceNumber).toBe(packet.sequenceNumber);
		}
	}
});

test('MPEG-TS audio seeking', async () => {
	for (let i = 0; i < 2; i++) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
			formats: ALL_FORMATS,
		});

		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(audioTrack);

		const firstTimestamp = await audioTrack.getFirstTimestamp();
		const firstPacket = await sink.getPacket(firstTimestamp);
		assert(firstPacket);
		expect(firstPacket.timestamp).toBe(firstTimestamp);
		expect(firstPacket.duration).toBe(0.021333333333333333);
		expect(firstPacket.sequenceNumber).toBe((await sink.getFirstPacket())?.sequenceNumber);

		const lastPacket = await sink.getPacket(Infinity);
		assert(lastPacket);
		expect(lastPacket.timestamp).toBeCloseTo(14.982666666666667);
		expect(lastPacket.duration).toBe(0.021333333333333333);

		const beforeFirst = await sink.getPacket(-10);
		expect(beforeFirst).toBeNull();

		const middlePacket = await sink.getPacket(12.5);
		assert(middlePacket);
		expect(middlePacket.timestamp).toBeCloseTo(12.486666666666666);
		expect(middlePacket.duration).toBe(0.021333333333333333);

		const allPackets: EncodedPacket[] = [];
		let currentPacket: EncodedPacket | null = firstPacket;

		while (currentPacket) {
			allPackets.push(currentPacket);
			currentPacket = await sink.getNextPacket(currentPacket);
		}

		expect(allPackets).toHaveLength(234);

		for (const packet of allPackets) {
			const seekedPacket = await sink.getPacket(packet.timestamp);
			assert(seekedPacket);
			expect(seekedPacket.timestamp).toBe(packet.timestamp); // The correct timestamp was retrieved
			expect(seekedPacket.duration).toBe(packet.duration); // The correct duration was retrieved
			expect(seekedPacket.sequenceNumber).toBe(packet.sequenceNumber);
		}
	}
});

test('MPEG-TS seeking race condition test', { timeout: 30_000 }, async () => {
	for (let i = 0; i < 2; i++) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(videoTrack);

		const allPackets: EncodedPacket[] = [];
		let currentPacket: EncodedPacket | null = await sink.getFirstPacket();

		while (currentPacket) {
			allPackets.push(currentPacket);
			currentPacket = await sink.getNextPacket(currentPacket);
		}

		// Perform all seeks concurrently
		const seekPromises = allPackets.map(packet => sink.getPacket(packet.timestamp));
		const seekedPackets = await Promise.all(seekPromises);

		for (let j = 0; j < allPackets.length; j++) {
			const originalPacket = allPackets[j]!;
			const seekedPacket = seekedPackets[j]!;
			assert(seekedPacket);
			expect(seekedPacket.timestamp).toBe(originalPacket.timestamp);
			expect(seekedPacket.duration).toBe(originalPacket.duration);
			expect(seekedPacket.sequenceNumber).toBe(originalPacket.sequenceNumber);
		}
	}
});

test('MPEG-TS video key packets', { timeout: 30_000 }, async () => {
	for (let i = 0; i < 2; i++) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/trim-buck-bunny-ffmpeg.ts')),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(videoTrack);

		const firstPacket = await sink.getFirstPacket();
		assert(firstPacket);
		expect(firstPacket.type).toBe('key');

		const secondPacket = await sink.getNextPacket(firstPacket);
		assert(secondPacket);
		expect(secondPacket.type).toBe('delta');

		const nextKeyPacket = await sink.getNextKeyPacket(firstPacket);
		assert(nextKeyPacket);
		expect(nextKeyPacket.type).toBe('key');
		expect(nextKeyPacket.sequenceNumber).toBeGreaterThan(secondPacket.sequenceNumber);

		const firstKeyPacket = await sink.getKeyPacket(firstPacket.timestamp + 0.5);
		assert(firstKeyPacket);
		expect(firstKeyPacket.type).toBe('key');
		expect(firstKeyPacket.sequenceNumber).toBe(firstPacket.sequenceNumber);

		const afterKeyPacket = await sink.getNextPacket(firstKeyPacket);
		expect(afterKeyPacket).not.toBe(null);
		expect(afterKeyPacket!.type).toBe('delta');
		expect(afterKeyPacket!.sequenceNumber).toBe(secondPacket.sequenceNumber);

		const secondKeyPacket = await sink.getKeyPacket(2.5);
		assert(secondKeyPacket);
		expect(secondKeyPacket.type).toBe('key');
		expect(secondKeyPacket.sequenceNumber).toBe(nextKeyPacket.sequenceNumber);

		const lastKeyPacket = await sink.getKeyPacket(Infinity);
		assert(lastKeyPacket);
		expect(lastKeyPacket.type).toBe('key');
		expect(lastKeyPacket.sequenceNumber).toBeGreaterThan(secondKeyPacket.sequenceNumber);

		const allKeyPackets: EncodedPacket[] = [];
		let currentKeyPacket: EncodedPacket | null = firstPacket;

		while (currentKeyPacket) {
			allKeyPackets.push(currentKeyPacket);
			currentKeyPacket = await sink.getNextKeyPacket(currentKeyPacket);
		}

		for (const packet of allKeyPackets) {
			const keyPacket = await sink.getKeyPacket(packet.timestamp);
			assert(keyPacket);
			expect(keyPacket.timestamp).toBe(packet.timestamp); // The correct timestamp was retrieved for this packet
			expect(keyPacket.duration).toBe(packet.duration); // The correct duration was retrieved for this packet
			expect(keyPacket.sequenceNumber).toBe(packet.sequenceNumber);
		}
	}
});

test('MPEG-TS audio key packets', async () => {
	for (let i = 0; i < 2; i++) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
			formats: ALL_FORMATS,
		});

		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(audioTrack);

		const firstPacket = await sink.getFirstPacket();
		assert(firstPacket);
		expect(firstPacket.type).toBe('key');

		const secondPacket = await sink.getNextPacket(firstPacket);
		assert(secondPacket);
		expect(secondPacket.type).toBe('key');

		const nextKeyPacket = await sink.getNextKeyPacket(firstPacket);
		assert(nextKeyPacket);
		expect(nextKeyPacket.type).toBe('key');
		expect(nextKeyPacket.sequenceNumber).toBe(secondPacket.sequenceNumber); // All audio packets are key packets

		const middleKeyPacket = await sink.getKeyPacket(12.5);
		assert(middleKeyPacket);
		expect(middleKeyPacket.type).toBe('key');

		const afterKeyPacket = await sink.getNextPacket(middleKeyPacket);
		expect(afterKeyPacket).not.toBe(null);
		expect(afterKeyPacket!.type).toBe('key');

		const lastPacket = await sink.getPacket(Infinity);
		assert(lastPacket);

		const lastKeyPacket = await sink.getKeyPacket(Infinity);
		assert(lastKeyPacket);
		expect(lastKeyPacket.type).toBe('key');
		expect(lastKeyPacket.sequenceNumber).toBe(lastPacket.sequenceNumber); // It's actually the last packet

		const allKeyPackets: EncodedPacket[] = [];
		let currentKeyPacket: EncodedPacket | null = firstPacket;

		while (currentKeyPacket) {
			allKeyPackets.push(currentKeyPacket);
			currentKeyPacket = await sink.getNextKeyPacket(currentKeyPacket);
		}

		for (const packet of allKeyPackets) {
			const keyPacket = await sink.getKeyPacket(packet.timestamp);
			assert(keyPacket);
			expect(keyPacket.timestamp).toBe(packet.timestamp); // The correct timestamp was retrieved for this packet
			expect(keyPacket.duration).toBe(packet.duration); // The correct duration was retrieved for this packet
			expect(keyPacket.sequenceNumber).toBe(packet.sequenceNumber);
		}
	}
});

test('MPEG-TS with unknown file size (ReadableStreamSource)', async () => {
	for (let i = 0; i < 2; i++) {
		const filePath = path.join(__dirname, '../public/0.ts');
		const fileStream = fs.createReadStream(filePath);
		const webStream = Readable.toWeb(fileStream) as ReadableStream<Uint8Array>;

		using input = new Input({
			source: new ReadableStreamSource(webStream),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(videoTrack);

		const firstPacket = await sink.getFirstPacket();
		assert(firstPacket);
		expect(firstPacket.type).toBe('key');
		expect(firstPacket.timestamp).toBe(10.033333333333333);

		const middlePacket = await sink.getPacket(12.5);
		assert(middlePacket);
		expect(middlePacket.timestamp).toBeCloseTo(12.5);

		const duration = await videoTrack.computeDuration();
		expect(duration).toBeCloseTo(15);
	}
});

test('MPEG-TS transmuxed by FFmpeg', { timeout: 30_000 }, async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/trim-buck-bunny-ffmpeg.ts')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const videoPacketStats = await videoTrack.computePacketStats();
	const audioPacketStats = await audioTrack.computePacketStats();

	expect(videoPacketStats.packetCount).toBe(121);
	expect(audioPacketStats.packetCount).toBe(235);
});

test('MPEG-TS with HEVC video', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/hevc.ts')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	expect(await videoTrack.getCodec()).toBe('hevc');
	expect(await videoTrack.getInternalCodecId()).toBe(0x24);
	expect(await videoTrack.getDisplayWidth()).toBe(1920);
	expect(await videoTrack.getDisplayHeight()).toBe(1080);

	const videoDecoderConfig = await videoTrack.getDecoderConfig();
	expect(videoDecoderConfig).toEqual({
		codec: 'hev1.1.6.L120.90',
		codedWidth: 1920,
		codedHeight: 1080,
		colorSpace: {
			primaries: 'bt709',
			transfer: 'bt709',
			matrix: 'bt709',
			fullRange: false,
		},
		// No description, it's Annex B
	});

	const sink = new EncodedPacketSink(videoTrack);

	let i = 0;
	for await (const packet of sink.packets()) {
		expect(packet.data.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 1])); // Annex B
		expect(packet.duration).toBeCloseTo(0.04166666666);
		expect(packet.type).toBe(i > 0 ? 'delta' : 'key');
		i++;
	}
});

test('MPEG-TS with MP3 audio', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/mp3.ts')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('mp3');
	expect(await audioTrack.getInternalCodecId()).toBe(0x03);

	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	expect(audioDecoderConfig).toEqual({
		codec: 'mp3',
		numberOfChannels: 2,
		sampleRate: 48000,
	});

	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	let count = 0;
	for await (const packet of sink.packets()) {
		expect(packet.data[0]).toBe(0xff);
		expect(packet.type).toBe('key');
		count++;
	}

	expect(count).toBeGreaterThan(0);
});

test('MPEG-TS with AC-3 audio (System A)', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/ac3.ts')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('ac3');
	expect(await audioTrack.getInternalCodecId()).toBe(MpegTsStreamType.AC3_SYSTEM_A);

	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	expect(audioDecoderConfig).toEqual({
		codec: 'ac-3',
		numberOfChannels: 6,
		sampleRate: 48000,
	});

	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	let count = 0;
	for await (const packet of sink.packets()) {
		expect(packet.data[0]).toBe(0x0b);
		expect(packet.data[1]).toBe(0x77);
		expect(packet.type).toBe('key');
		count++;
	}

	expect(count).toBeGreaterThan(0);
});

test('MPEG-TS with AC-3 audio (System B)', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/ac3-system-b.ts')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('ac3');
	expect(await audioTrack.getInternalCodecId()).toBe(MpegTsStreamType.PRIVATE_DATA);

	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	expect(audioDecoderConfig).toEqual({
		codec: 'ac-3',
		numberOfChannels: 6,
		sampleRate: 48000,
	});

	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	let count = 0;
	for await (const packet of sink.packets()) {
		expect(packet.data[0]).toBe(0x0b);
		expect(packet.data[1]).toBe(0x77);
		expect(packet.type).toBe('key');
		count++;
	}

	expect(count).toBeGreaterThan(0);
});

test('MPEG-TS with E-AC-3 audio (System A)', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/eac3.ts')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('eac3');
	expect(await audioTrack.getInternalCodecId()).toBe(MpegTsStreamType.EAC3_SYSTEM_A);

	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	expect(audioDecoderConfig).toEqual({
		codec: 'ec-3',
		numberOfChannels: 6,
		sampleRate: 48000,
	});

	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	let count = 0;
	for await (const packet of sink.packets()) {
		expect(packet.data[0]).toBe(0x0b);
		expect(packet.data[1]).toBe(0x77);
		expect(packet.type).toBe('key');
		count++;
	}

	expect(count).toBeGreaterThan(0);
});

test('MPEG-TS with E-AC-3 audio (System B)', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/eac3-system-b.ts')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('eac3');
	expect(await audioTrack.getInternalCodecId()).toBe(MpegTsStreamType.PRIVATE_DATA);

	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	expect(audioDecoderConfig).toEqual({
		codec: 'ec-3',
		numberOfChannels: 6,
		sampleRate: 48000,
	});

	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	let count = 0;
	for await (const packet of sink.packets()) {
		expect(packet.data[0]).toBe(0x0b);
		expect(packet.data[1]).toBe(0x77);
		expect(packet.type).toBe('key');
		count++;
	}

	expect(count).toBeGreaterThan(0);
});

test('MPEG-TS with E-AC-3 audio in a Blu-ray (BDAV) stream', async () => {
	// ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000 -t 1 -c:a eac3 -b:a 96k -mpegts_m2ts_mode 1 -f mpegts
	// eac3-bluray.m2ts (192-byte packets, 'HDMV' program registration, stream_type 0x84)
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/eac3-bluray.m2ts')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('eac3');
	expect(await audioTrack.getInternalCodecId()).toBe(0x84);
	expect(await audioTrack.getDecoderConfig()).toEqual({
		codec: 'ec-3',
		numberOfChannels: 1,
		sampleRate: 48000,
	});

	let count = 0;
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		expect(packet.data[0]).toBe(0x0b);
		expect(packet.data[1]).toBe(0x77);
		count++;
	}

	expect(count).toBe(32); // As counted by ffprobe
});

test('MPEG-TS files not starting with a whole packet', async () => {
	const file = await fs.promises.readFile(path.join(__dirname, '../public/ac3.ts'));

	const readPackets = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		expect(await input.getFormat()).toBe(MPEG_TS);

		const track = (await input.getAudioTracks())[0];
		assert(track);
		expect(await track.getCodec()).toBe('ac3');

		const packets: [number, number][] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push([packet.timestamp, packet.byteLength]);
		}

		return packets;
	};

	const expected = await readPackets(file);

	// Recorders like set-top boxes write their own header in front of the transport stream
	const withHeader = new Uint8Array(100 + file.length);
	withHeader.set(new TextEncoder().encode('PVR recording header'));
	withHeader.set(file, 100);
	expect(await readPackets(withHeader)).toEqual(expected);

	// A capture cut at an arbitrary byte starts in the middle of a packet
	const cut = await readPackets(file.subarray(1000));
	expect(cut.length).toBeGreaterThan(expected.length - 5);
	expect(cut.at(-1)).toEqual(expected.at(-1));
});

test('MPEG-TS partial reading', async () => {
	const fullPath = path.join(__dirname, '../public/193039199_mp4_h264_aac_fhd_7.ts');
	const buffer = await fs.promises.readFile(fullPath);
	let maxEnd = 0;

	using input = new Input({
		source: new CustomSource({
			getSize: () => {
				return buffer.byteLength;
			},
			read: (start, end) => {
				maxEnd = Math.max(maxEnd, end);
				return buffer.subarray(start, end);
			},
		}),
		formats: ALL_FORMATS,
	});

	await input.getTracks();

	// Not much of the file has been read since we only requested metadata
	expect(maxEnd).toBeLessThanOrEqual(86480);
});

test('MPEG-TS init input without stream data', async () => {
	const buffer = await fs.promises.readFile(path.join(__dirname, '../public/0.ts'));

	// Only the PAT and PMT, so the streams are declared but never set up
	using initInput = new Input({
		source: new BufferSource(buffer.subarray(0, 2 * 188)),
		formats: ALL_FORMATS,
	});
	await initInput.getTracks();

	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
		initInput,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getNumberOfChannels()).toBe(2);
	expect(await audioTrack.getSampleRate()).toBe(48000);
});

test('MPEG-TS with several programs uses the first one whose PMT shows up', async () => {
	// Like a DVB capture: the PAT lists three programs, the first of which isn't in the file
	const packets: Uint8Array[] = [];
	const pushPacket = (pid: number, payload: number[], payloadUnitStart = true) => {
		const packet = new Uint8Array(188).fill(0xff);
		packet.set([0x47, (payloadUnitStart ? 0x40 : 0) | (pid >> 8), pid & 0xff, 0x10 | (packets.length & 0xf)], 0);
		packet.set(payload, 4);
		packets.push(packet);
	};
	const section = (bytes: number[]) => [0x00, ...bytes, 0, 0, 0, 0]; // pointer_field, section, CRC (not checked)
	const pmt = (programNumber: number, pid: number) => section([
		0x02, 0xb0, 0x12, 0, programNumber, 0xc1, 0, 0, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0x00,
		0x0f, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0x00, // AAC
	]);
	const adtsPes = (pts: number) => [
		0, 0, 1, 0xc0, 0, 8 + 39, 0x84, 0x80, 5, 0x21, 0, 1, (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1,
		0xff, 0xf1, 0x4c, 0x80, 0x04, 0xff, 0xfc, ...new Array<number>(32).fill(0), // AAC-LC, 48 kHz, stereo
	];

	pushPacket(0x0000, section([
		0x00, 0xb0, 0x15, 0, 1, 0xc1, 0, 0,
		0, 1, 0xf0, 0x00, // Program 1 -> PMT PID 0x1000
		0, 2, 0xf0, 0x01, // Program 2 -> PMT PID 0x1001
		0, 3, 0xf0, 0x02, // Program 3 -> PMT PID 0x1002
	]));
	pushPacket(0x1001, pmt(2, 0x102));
	pushPacket(0x1002, pmt(3, 0x103));
	for (let i = 0; i < 3; i++) {
		pushPacket(0x102, adtsPes(1920 * i));
		pushPacket(0x103, adtsPes(1920 * i));
	}

	const bytes = new Uint8Array(188 * packets.length);
	packets.forEach((packet, i) => bytes.set(packet, 188 * i));

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks.map(track => track.id)).toEqual([0x102]);

	let packetCount = 0;
	for await (const packet of new EncodedPacketSink(tracks[0]!).packets()) {
		expect(packet.byteLength).toBe(39);
		packetCount++;
	}
	expect(packetCount).toBe(3);
});

test('MPEG-TS with an unreadable stream still opens with its other streams', async () => {
	// The PMT declares H.264 video, MPEG audio that actually carries AC-3 (as some broadcast muxers mislabel it) and
	// AAC whose PES packets are scrambled
	const packets: Uint8Array[] = [];
	const pushPacket = (pid: number, payload: number[], payloadUnitStart = true) => {
		const packet = new Uint8Array(188).fill(0xff);
		packet.set([0x47, (payloadUnitStart ? 0x40 : 0) | (pid >> 8), pid & 0xff, 0x10 | (packets.length & 0xf)], 0);
		packet.set(payload, 4);
		packets.push(packet);
	};
	const pes = (streamId: number, pts: number, data: number[]) => [
		0, 0, 1, streamId, 0, 0, 0x84, 0x80, 5, 0x21, 0, 1, (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1, ...data,
	];

	pushPacket(0x0000, [0x00, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0]);
	pushPacket(0x1000, [
		0x00, 0x02, 0xb0, 0x1c, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00,
		0x1b, 0xe1, 0x00, 0xf0, 0x00, // H.264
		0x03, 0xe1, 0x01, 0xf0, 0x00, // MPEG audio
		0x0f, 0xe1, 0x02, 0xf0, 0x00, // AAC
		0, 0, 0, 0, // CRC (not checked)
	]);

	const sps = [0x67, 0x42, 0xc0, 0x0a, 0xda, 0x10, 0x9b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03,
		0x03, 0x20, 0xf1, 0x22, 0x6a]; // x264, 64x64
	const pps = [0x68, 0xce, 0x0f, 0xc8];
	const idr = [0x65, 0x88, 0x84, 0x00, 0x33, 0xff, 0xaa, 0xaa, 0xaa, 0xaa];
	pushPacket(0x100, pes(0xe0, 0, [0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps, 0, 0, 0, 1, ...idr]));

	const ac3Frame = new Array<number>(128).fill(0);
	ac3Frame.splice(0, 6, 0x0b, 0x77, 0x00, 0x00, 0x00, 0x40); // 48 kHz, 32 kbit/s, 128 bytes
	pushPacket(0x101, pes(0xbd, 0, ac3Frame));

	// Scrambled (transport_scrambling_control = 0b10), so the PES header is unreadable too
	pushPacket(0x102, [0x5a, 0x13, 0xe7, 0x02, 0x99, 0x41]);
	packets.at(-1)![3]! |= 0x80;

	const bytes = new Uint8Array(188 * packets.length);
	packets.forEach((packet, i) => bytes.set(packet, 188 * i));

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks.map(track => track.id)).toEqual([0x100]);
	expect(await tracks[0]!.getCodec()).toBe('avc');
});

test('MPEG-TS with field-coded H.264 keeps both fields of a frame in one packet', async () => {
	// Like camcorder AVCHD recordings (PAFF): each frame is a top and a bottom field picture, each with its own AUD,
	// in one PES packet. One frame-coded picture and one unpaired field are mixed in.
	const fromBits = (bits: string) => {
		const padded = bits + '1' + '0'.repeat((8 - ((bits.length + 1) % 8)) % 8); // rbsp_stop_one_bit + alignment
		return padded.match(/.{8}/g)!.map(byte => parseInt(byte, 2));
	};
	const ue = (value: number) => {
		const code = (value + 1).toString(2);
		return '0'.repeat(code.length - 1) + code;
	};
	const bits4 = (value: number) => value.toString(2).padStart(4, '0');

	// Main profile, 64x64, log2_max_frame_num 4, frame_mbs_only_flag 0
	const sps = [0x67, 0x4d, 0x40, 0x28, ...fromBits('1111' + '010' + '0' + ue(3) + ue(1) + '0' + '0' + '1' + '00')];
	const pps = [0x68, 0xce, 0x0f, 0xc8];
	const aud = [0x09, 0xf0];
	// field: 0 = frame, 1 = top field, 2 = bottom field
	const slice = (idr: boolean, frameNum: number, field: 0 | 1 | 2) => [
		idr ? 0x65 : 0x41,
		...fromBits('1' + ue(idr ? 7 : 5) + '1' + bits4(frameNum) + (field === 0 ? '0' : field === 1 ? '10' : '11')),
		...new Array<number>(40).fill(0xaa),
	];
	const annexB = (nalUnits: number[][]) => nalUnits.flatMap(nalUnit => [0, 0, 0, 1, ...nalUnit]);

	const frames = [
		annexB([aud, sps, pps, slice(true, 0, 1), aud, slice(false, 0, 2)]),
		annexB([aud, slice(false, 1, 1), aud, slice(false, 1, 2)]),
		annexB([aud, slice(false, 2, 0)]), // Frame-coded
		annexB([aud, slice(false, 3, 2), aud, slice(false, 3, 1)]), // Bottom field first
		annexB([aud, slice(false, 4, 1)]), // Unpaired
		annexB([aud, slice(false, 5, 1), aud, slice(false, 5, 2)]),
	];

	const packets: Uint8Array[] = [];
	const pushPackets = (pid: number, payload: number[]) => {
		for (let i = 0; i < payload.length; i += 184) {
			const chunk = payload.slice(i, i + 184);
			const packet = new Uint8Array(188);
			const stuffing = 184 - chunk.length;
			const header = [0x47, (i === 0 ? 0x40 : 0) | (pid >> 8), pid & 0xff, (stuffing ? 0x30 : 0x10)];
			packet.set(header, 0);
			if (stuffing) {
				packet.set([stuffing - 1, ...(stuffing > 1 ? [0x00] : [])], 4);
				packet.fill(0xff, 6, 4 + stuffing);
			}
			packet.set(chunk, 4 + stuffing);
			packets.push(packet);
		}
	};

	pushPackets(0x0000, [0x00, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0]);
	pushPackets(0x1000, [
		0x00, 0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0,
	]);
	frames.forEach((frame, i) => {
		const pts = 3600 * i;
		pushPackets(0x100, [
			0, 0, 1, 0xe0, 0, 0, 0x84, 0x80, 5, 0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff,
			((pts >> 14) & 0xfe) | 1, (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1, ...frame,
		]);
	});

	const bytes = new Uint8Array(188 * packets.length);
	packets.forEach((packet, i) => bytes.set(packet, 188 * i));

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryVideoTrack())!;
	const result = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		result.push({ timestamp: packet.timestamp, duration: packet.duration, size: packet.byteLength });
	}

	expect(result).toEqual(frames.map((frame, i) => ({ timestamp: 0.04 * i, duration: 0.04, size: frame.length })));
});

test('MPEG-TS with a PMT whose packets have other packets between them finds all streams', async () => {
	// The PMT is too long for one TS packet, and a null packet sits between its two packets, as remultiplexers do
	const packets: Uint8Array[] = [];
	const pushPacket = (pid: number, payload: number[], payloadUnitStart: boolean) => {
		const packet = new Uint8Array(188).fill(0xff);
		packet.set([0x47, (payloadUnitStart ? 0x40 : 0) | (pid >> 8), pid & 0xff, 0x10 | (packets.length & 0xf)], 0);
		packet.set(payload, 4);
		packets.push(packet);
	};
	const adtsPes = (pts: number) => [
		0, 0, 1, 0xc0, 0, 8 + 39, 0x84, 0x80, 5, 0x21, 0, 1, (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1,
		0xff, 0xf1, 0x4c, 0x80, 0x04, 0xff, 0xfc, ...new Array<number>(32).fill(0), // AAC-LC, 48 kHz, stereo
	];

	const privateDescriptor = [0xf0, 200, ...new Array<number>(200).fill(0x55)];
	const pmtBody = [
		0, 1, 0xc1, 0, 0, 0xe1, 0x01, 0xf0, privateDescriptor.length, ...privateDescriptor,
		0x0f, 0xe1, 0x01, 0xf0, 0x00, // AAC on PID 0x101
		0x0f, 0xe1, 0x02, 0xf0, 0x00, // AAC on PID 0x102
		0, 0, 0, 0, // CRC (not checked)
	];
	const pmtSection = [0x00, 0x02, 0xb0 | (pmtBody.length >> 8), pmtBody.length & 0xff, ...pmtBody];

	pushPacket(0x0000, [0x00, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0], true);
	pushPacket(0x1000, pmtSection.slice(0, 184), true);
	pushPacket(0x1fff, [], false); // Null packet
	pushPacket(0x1000, pmtSection.slice(184), false);
	for (let i = 0; i < 3; i++) {
		pushPacket(0x101, adtsPes(1920 * i), true);
		pushPacket(0x102, adtsPes(1920 * i), true);
	}

	const bytes = new Uint8Array(188 * packets.length);
	packets.forEach((packet, i) => bytes.set(packet, 188 * i));

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks.map(track => track.id)).toEqual([0x101, 0x102]);

	for (const track of tracks) {
		let packetCount = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			expect(packet.byteLength).toBe(39);
			packetCount++;
		}
		expect(packetCount).toBe(3);
	}
});

test('MPEG-TS with a damaged H.264 slice header reads past it', async () => {
	// The header of the sixth frame's slice is zeroed out, as in a damaged recording
	const packets: Uint8Array[] = [];
	const pushPackets = (pid: number, payload: number[]) => {
		for (let i = 0; i < payload.length; i += 184) {
			const chunk = payload.slice(i, i + 184);
			const packet = new Uint8Array(188);
			const stuffing = 184 - chunk.length;
			packet.set([0x47, (i === 0 ? 0x40 : 0) | (pid >> 8), pid & 0xff, (stuffing ? 0x30 : 0x10)], 0);
			if (stuffing) {
				packet.set([stuffing - 1, ...(stuffing > 1 ? [0x00] : [])], 4);
				packet.fill(0xff, 6, 4 + stuffing);
			}
			packet.set(chunk, 4 + stuffing);
			packets.push(packet);
		}
	};

	const sps = [0x67, 0x42, 0xc0, 0x0a, 0xda, 0x10, 0x9b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03,
		0x03, 0x20, 0xf1, 0x22, 0x6a]; // x264, 64x64
	const pps = [0x68, 0xce, 0x0f, 0xc8];
	const aud = [0x09, 0xf0];
	const slice = (idr: boolean, damaged: boolean) => [
		idr ? 0x65 : 0x41,
		...(damaged ? new Array<number>(12).fill(0) : [0x88, 0x84, 0x00, 0x33]),
		...new Array<number>(40).fill(0xaa),
	];
	const annexB = (nalUnits: number[][]) => nalUnits.flatMap(nalUnit => [0, 0, 0, 1, ...nalUnit]);
	const frames = Array.from({ length: 10 }, (_, i) => i === 0
		? annexB([aud, sps, pps, slice(true, false)])
		: annexB([aud, slice(false, i === 5)]),
	);

	pushPackets(0x0000, [0x00, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0]);
	pushPackets(0x1000, [
		0x00, 0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0,
	]);
	frames.forEach((frame, i) => {
		const pts = 3000 * i;
		pushPackets(0x100, [
			0, 0, 1, 0xe0, 0, 0, 0x84, 0x80, 5, 0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff,
			((pts >> 14) & 0xfe) | 1, (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1, ...frame,
		]);
	});

	const bytes = new Uint8Array(188 * packets.length);
	packets.forEach((packet, i) => bytes.set(packet, 188 * i));

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryVideoTrack())!;
	const sizes: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		sizes.push(packet.byteLength);
	}

	expect(sizes).toEqual(frames.map(frame => frame.length));
});

test('MPEG-TS key packet lookup returns the same packet as reading in order', async () => {
	// The file starts with a PES packet holding only SPS and PPS, then the IDR frame's PES packet, both with PTS 0 and
	// random_access_indicator set. The first access unit spans both.
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/no-aud.ts')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	const sink = new EncodedPacketSink(track!);

	const firstPacket = await sink.getFirstPacket();
	const keyPacket = await sink.getKeyPacket(0);
	expect(firstPacket!.timestamp).toBe(0);
	expect(keyPacket!.sequenceNumber).toBe(firstPacket!.sequenceNumber);
	expect(keyPacket!.data).toEqual(firstPacket!.data);
});

test('MPEG-TS key packet lookup finds key frames whose PES packet starts with the previous frame', async () => {
	// Like Apple's bipbop HLS sample: pictures have two slices, and each PES packet begins with the second slice of
	// the previous picture before its own AUD. There are no random_access_indicator flags.
	const packets: Uint8Array[] = [];
	const pushPackets = (pid: number, payload: number[]) => {
		for (let i = 0; i < payload.length; i += 184) {
			const chunk = payload.slice(i, i + 184);
			const packet = new Uint8Array(188);
			const stuffing = 184 - chunk.length;
			packet.set([0x47, (i === 0 ? 0x40 : 0) | (pid >> 8), pid & 0xff, (stuffing ? 0x30 : 0x10)], 0);
			if (stuffing) {
				packet.set([stuffing - 1, ...(stuffing > 1 ? [0x00] : [])], 4);
				packet.fill(0xff, 6, 4 + stuffing);
			}
			packet.set(chunk, 4 + stuffing);
			packets.push(packet);
		}
	};

	const sps = [0x67, 0x42, 0xc0, 0x0a, 0xda, 0x10, 0x9b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03,
		0x03, 0x20, 0xf1, 0x22, 0x6a]; // x264, 64x64 (16 macroblocks)
	const pps = [0x68, 0xce, 0x0f, 0xc8];
	const aud = [0x09, 0xf0];
	// first_mb_in_slice 0 is the bit 1, 8 is 0001001
	const slice = (idr: boolean, secondHalf: boolean) => [
		idr ? 0x65 : 0x41, ...(secondHalf ? [0x12, 0x22] : [0x88, 0x84]), ...new Array<number>(30).fill(0xaa),
	];
	const nal = (nalUnit: number[]) => [0, 0, 0, 1, ...nalUnit];

	const frameCount = 12;
	pushPackets(0x0000, [0x00, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0]);
	pushPackets(0x1000, [
		0x00, 0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0,
	]);
	for (let i = 0; i < frameCount; i++) {
		const isKey = i % 4 === 0;
		const previousTail = i > 0 ? nal(slice((i - 1) % 4 === 0, true)) : [];
		const head = [
			...nal(aud),
			...(isKey ? [...nal(sps), ...nal(pps)] : []),
			...nal(slice(isKey, false)),
			...(i === frameCount - 1 ? nal(slice(isKey, true)) : []),
		];
		const pts = 3000 * i;
		pushPackets(0x100, [
			0, 0, 1, 0xe0, 0, 0, 0x84, 0x80, 5, 0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff,
			((pts >> 14) & 0xfe) | 1, (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1, ...previousTail, ...head,
		]);
	}

	const bytes = new Uint8Array(188 * packets.length);
	packets.forEach((packet, i) => bytes.set(packet, 188 * i));

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	const sink = new EncodedPacketSink(track!);

	const keyPackets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		if (packet.type === 'key') {
			keyPackets.push(packet);
		}
	}
	expect(keyPackets.map(packet => packet.timestamp)).toEqual([0, 4 / 30, 8 / 30]);

	for (const keyPacket of keyPackets) {
		const found = await sink.getKeyPacket(keyPacket.timestamp);
		expect(found?.sequenceNumber).toBe(keyPacket.sequenceNumber);
	}
});

test('MPEG-TS first packet key packet forcing', async () => {
	for (let i = 0; i < 2; i++) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/missing-keyframe-labels.ts')),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(videoTrack);

		// Test that the first packet is indeed a key packet even if the file doesn't label it that way (L muxer)
		const firstPacket = await sink.getFirstPacket();
		assert(firstPacket);
		expect(firstPacket.type).toBe('key');

		const firstPacketSeeked = await sink.getPacket(firstPacket.timestamp);
		assert(firstPacketSeeked);
		expect(firstPacketSeeked.type).toBe('key');
		expect(firstPacketSeeked.sequenceNumber).toBe(firstPacket.sequenceNumber);

		const firstKeyPacketSeeked = await sink.getKeyPacket(firstPacket.timestamp);
		assert(firstKeyPacketSeeked);
		expect(firstKeyPacketSeeked.type).toBe('key');
		expect(firstKeyPacketSeeked.sequenceNumber).toBe(firstPacket.sequenceNumber);
	}
});

test('MPEG-TS without initial key packet', async () => {
	for (let i = 0; i < 2; i++) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/no-initial-keyframe.ts')),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(videoTrack);

		const firstPacket = await sink.getFirstPacket();
		assert(firstPacket);
		expect(firstPacket.type).toBe('delta'); // First packet is delta

		const noPacket = await sink.getKeyPacket(firstPacket.timestamp);
		expect(noPacket).toBeNull();

		const aKeyPacket = await sink.getKeyPacket(Infinity);
		assert(aKeyPacket);
		expect(aKeyPacket.type).toBe('key');
	}
});

test('MPEG-TS with "extension" PES packets without PTS', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/entry24-segment3.ts')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const packetSizes: number[] = [];
	const sink = new EncodedPacketSink(videoTrack);

	for await (const packet of sink.packets()) {
		packetSizes.push(packet.data.byteLength);

		const seeked = await sink.getPacket(packet.timestamp);
		expect(seeked!.timestamp).toBe(packet.timestamp);
		expect(seeked!.sequenceNumber).toBe(packet.sequenceNumber);
	}

	expect(packetSizes).toEqual([
		// These reference values come from ffprobe
		30635, 5980, 3452, 2076, 2692, 9559, 5754, 2171, 2989, 13962,
		4156, 209260, 25698, 152, 2299, 128, 94, 102, 74, 28898,
		233, 127, 99, 1449, 130, 99, 3988, 202, 130, 139,
		92, 18652, 200, 146, 98, 8666, 190, 151, 156, 108,
		9991, 162, 97, 81, 9929, 130, 106, 13362, 133, 117,
		7606, 274, 109, 106, 12359, 218, 123, 111, 24109, 261,
		142, 120, 13417, 789, 153, 139, 12490, 549, 192, 135,
		13191, 428, 159, 150, 30815, 309, 135, 119, 9231, 354,
		147, 116, 11835, 263, 162, 103, 6693, 202, 100, 101,
		4693, 223, 144, 174, 118, 9155, 1188, 379, 169, 213,
	]);
});

test('MPEG-TS with AUD-less video packets', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/no-aud.ts')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);
	const secondPacket = await sink.getNextPacket(firstPacket);
	assert(secondPacket);
	const thirdPacket = await sink.getNextPacket(secondPacket);
	assert(thirdPacket);

	expect(firstPacket.data.byteLength).toBe(331774);
	expect(secondPacket.data.byteLength).toBe(1749);
	expect(thirdPacket.data.byteLength).toBe(4273);
});

test('MPEG-TS random_access_indicator on non-key frames does not make them key packets', async () => {
	// no-aud.ts sets random_access_indicator on every video PES packet, entry24-segment3.ts sets it on its second one
	// (a TRAIL_R picture). Only the bitstream can tell (ffprobe agrees: one key packet each, the first).
	const cases = [['no-aud.ts', 0.292], ['entry24-segment3.ts', 20.728088888888887]] as const;
	for (const [fileName, lastTimestamp] of cases) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public', fileName)),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		const sink = new EncodedPacketSink(videoTrack);

		// Looked up first, before reading any packets
		const keyPacket = await sink.getKeyPacket(lastTimestamp);
		assert(keyPacket);
		expect(keyPacket.timestamp).toBe(await videoTrack.getFirstTimestamp());

		const packets: EncodedPacket[] = [];
		for await (const packet of sink.packets()) {
			packets.push(packet);
		}

		expect(packets.map(packet => packet.type)).toEqual(packets.map((_, i) => i === 0 ? 'key' : 'delta'));
		expect(keyPacket.sequenceNumber).toBe(packets[0]!.sequenceNumber);
	}
});

test('MPEG-TS with trailing junk or a damaged packet reads to the end', async () => {
	const buffer = new Uint8Array(await fs.promises.readFile(path.join(__dirname, '../public/0.ts')));

	const readAll = async (bytes: Uint8Array) => {
		using input = new Input({
			source: new BufferSource(bytes),
			formats: ALL_FORMATS,
		});

		const counts: number[] = [];
		for (const track of await input.getTracks()) {
			let count = 0;
			for await (const packet of new EncodedPacketSink(track).packets()) {
				expect(packet.byteLength).toBeGreaterThan(0);
				count++;
			}
			counts.push(count);
		}

		return { counts, duration: await input.computeDuration() };
	};

	const reference = await readAll(buffer);
	expect(reference).toEqual({ counts: [298, 234], duration: 15.004 });

	// Zero padding up to the next 64 KiB, as left behind by recorders that write whole blocks
	const zeroPadded = new Uint8Array(Math.ceil(buffer.byteLength / 65536) * 65536);
	zeroPadded.set(buffer);
	expect(await readAll(zeroPadded)).toEqual(reference);

	// A few bytes that aren't TS packets at all
	const textTail = new Uint8Array(buffer.byteLength + 16);
	textTail.set(buffer);
	textTail.set(new TextEncoder().encode('end of recording'), buffer.byteLength);
	expect(await readAll(textTail)).toEqual(reference);

	// The sync byte of a packet in the middle of a video PES packet is damaged
	const damaged = buffer.slice();
	damaged[188 * 5000] = 0x00;
	expect(await readAll(damaged)).toEqual(reference);
});

test('MPEG-TS metadata reading gives up on declared streams that never show up', async () => {
	// The PMT declares two AAC streams, but only the first one has any packets (like a recording that dropped a
	// language). 30 seconds of it, one ADTS frame per PES packet and TS packet.
	const packets: Uint8Array[] = [];
	const continuityCounters = new Map<number, number>();
	const pushPacket = (pid: number, payload: Uint8Array, isSection: boolean) => {
		const packet = new Uint8Array(188).fill(0xff);
		const cc = continuityCounters.get(pid) ?? 0;
		continuityCounters.set(pid, (cc + 1) & 0xf);
		packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff], 0);
		if (isSection || payload.length === 184) {
			packet[3] = 0x10 | cc;
			packet.set(payload, 4);
		} else {
			packet[3] = 0x30 | cc; // Adaptation field stuffing
			packet[4] = 183 - payload.length;
			packet[5] = 0x00;
			packet.set(payload, 188 - payload.length);
		}
		packets.push(packet);
	};
	const section = (bytes: number[]) => [0x00, ...bytes, 0, 0, 0, 0]; // pointer_field, section, CRC (not checked)

	pushPacket(0x0000, new Uint8Array(section([0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00])), true);
	pushPacket(0x1000, new Uint8Array(section([
		0x02, 0xb0, 0x17, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00,
		0x0f, 0xe1, 0x00, 0xf0, 0x00, // AAC on PID 0x100
		0x0f, 0xe1, 0x01, 0xf0, 0x00, // AAC on PID 0x101, never sent
	])), true);

	const adtsFrame = new Uint8Array(39); // LC, 48 kHz, stereo, 39 bytes
	adtsFrame.set([0xff, 0xf1, 0x4c, 0x80, 0x04, 0xff, 0xfc]);

	const frameCount = Math.round(30 * 48000 / 1024);
	for (let i = 0; i < frameCount; i++) {
		const pts = Math.round(i * 1024 * 90000 / 48000);
		const pes = new Uint8Array(14 + adtsFrame.length);
		pes.set([0, 0, 1, 0xc0, 0, 8 + adtsFrame.length, 0x84, 0x80, 5]);
		pes.set([0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff, ((pts >> 14) & 0xfe) | 1], 9);
		pes.set([(pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1], 12);
		pes.set(adtsFrame, 14);
		pushPacket(0x100, pes, false);
	}

	const bytes = new Uint8Array(188 * packets.length);
	packets.forEach((packet, i) => bytes.set(packet, 188 * i));

	let maxEnd = 0;
	using input = new Input({
		source: new CustomSource({
			getSize: () => bytes.byteLength,
			read: (start, end) => {
				maxEnd = Math.max(maxEnd, end);
				return bytes.subarray(start, end);
			},
		}),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(1);
	expect(tracks[0]!.id).toBe(0x100);

	// It stopped looking for the missing stream well before the end of the file
	expect(maxEnd).toBeLessThan(bytes.byteLength / 2);

	let packetCount = 0;
	for await (const packet of new EncodedPacketSink(tracks[0]!).packets()) {
		expect(packet.byteLength).toBe(39);
		packetCount++;
	}
	expect(packetCount).toBe(frameCount);
});

test('MPEG-TS track language and audio type come from the ISO 639 language descriptor', async () => {
	// FFmpeg wrote these with an ISO_639_language_descriptor saying 'eng' for the audio stream, and none for video
	using hevcInput = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/hevc.ts')),
		formats: ALL_FORMATS,
	});
	expect(await (await hevcInput.getPrimaryAudioTrack())!.getLanguageCode()).toBe('eng');
	expect(await (await hevcInput.getPrimaryVideoTrack())!.getLanguageCode()).toBe('und');

	const buffer = new Uint8Array(await fs.promises.readFile(path.join(__dirname, '../public/mp3.ts')));
	const descriptor = [0x0a, 0x04, 0x65, 0x6e, 0x67, 0x00]; // tag, length, 'eng', audio_type

	const cases = [[0, false, false], [2, true, false], [3, false, true]] as const;
	for (const [audioType, hearingImpaired, visuallyImpaired] of cases) {
		const patched = buffer.slice();
		for (let i = 0; i < patched.length - descriptor.length; i++) {
			if (descriptor.every((byte, j) => patched[i + j] === byte)) {
				patched[i + 5] = audioType;
			}
		}

		using input = new Input({
			source: new BufferSource(patched),
			formats: ALL_FORMATS,
		});
		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);

		expect(await audioTrack.getLanguageCode()).toBe('eng');
		const disposition = await audioTrack.getDisposition();
		expect(disposition.hearingImpaired).toBe(hearingImpaired);
		expect(disposition.visuallyImpaired).toBe(visuallyImpaired);
	}
});

test('MPEG-TS reading one track after another stays linear', async () => {
	// Two AAC streams with one PES packet per TS packet, interleaved. Reading the second track used to insert each of
	// its section ends into the middle of a sorted array holding the first track's, which took quadratic time.
	const count = 80_000;
	const tsPacket = (pid: number, payload: number[]) => {
		const packet = new Uint8Array(188).fill(0xff);
		const adaptationFieldLength = 183 - payload.length;
		packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x30, adaptationFieldLength, 0x00]);
		packet.set(payload, 188 - payload.length);
		return packet;
	};
	const streams = [0x100, 0x101].flatMap(pid => [0x0f, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0x00]);
	const adtsFrame = [0xff, 0xf1, 0x50, 0x80, 0x01, 0x1f, 0xfc, 0x00];

	const file = new Uint8Array(188 * (2 + 2 * count));
	file.set(tsPacket(0, [0, 0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0]), 0);
	file.set(tsPacket(0x1000, [
		0, 0x02, 0xb0, 13 + streams.length, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, ...streams, 0, 0, 0, 0,
	]), 188);
	for (let i = 0; i < count; i++) {
		const pts = 90_000 + Math.round(i * 1024 * 90_000 / 44_100);
		const pes = [
			0, 0, 1, 0xc0, 0, 8 + adtsFrame.length, 0x80, 0x80, 5,
			0x21 | ((Math.floor(pts / 2 ** 30) % 8) << 1),
			(pts >> 22) & 0xff,
			(((pts >> 15) & 0x7f) << 1) | 1,
			(pts >> 7) & 0xff,
			((pts & 0x7f) << 1) | 1,
			...adtsFrame,
		];
		file.set(tsPacket(0x100, pes), 188 * (2 + 2 * i));
		file.set(tsPacket(0x101, pes), 188 * (3 + 2 * i));
	}

	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const tracks = await input.getAudioTracks();
	expect(tracks).toHaveLength(2);

	const durations: number[] = [];
	for (const track of tracks) {
		const start = performance.now();
		let packetCount = 0;
		for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
			void packet;
			packetCount++;
		}
		durations.push(performance.now() - start);
		expect(packetCount).toBeGreaterThan(count - 2);
	}

	// Both tracks span the same bytes, so reading the second one shouldn't take much longer than the first
	expect(durations[1]!).toBeLessThan(2 * durations[0]! + 100);
});
