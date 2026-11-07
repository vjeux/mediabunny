import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource, ReadableStreamSource, CustomSource } from '../../src/source.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { ALL_FORMATS, MPEG_TS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { MpegTsDemuxer } from '../../src/mpeg-ts/mpeg-ts-demuxer.js';
import { MpegTsStreamType } from '../../src/mpeg-ts/mpeg-ts-misc.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';

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

test('MPEG-TS drops a video frame that lost a TS packet, and discards duplicate TS packets', async () => {
	// Found by L80. A capture that lost TS packets (UDP, weak reception) leaves frames with holes, which don't decode:
	// with WebCodecs, the decoder then fails altogether. So like for the packets the demodulator marks with
	// transport_error_indicator, such frames are left out, which the continuity counters tell (H.222.0 2.4.3.3), and
	// so are the frames after them up to the next key frame, which may refer to them. A TS packet sent twice (allowed
	// once, with the same counter) is discarded instead of being read twice. 20 frames of a 64x64 x264 stream with a
	// key frame every 4 (SPS and PPS, then stub slices of 600 bytes, so each frame spans several TS packets, with bytes
	// that differ from one TS packet to the next).
	const sps = [0x67, 0x64, 0x00, 0x0a, 0xac, 0xd3, 0x10, 0x9b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00,
		0x03, 0x03, 0x20, 0xf1, 0x22, 0x53, 0x80];
	const pps = [0x68, 0xef, 0x8f, 0xcb];
	const nalUnit = (bytes: number[]) => [0, 0, 0, 1, ...bytes];

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, { frameRate: 25 });
	await output.start();
	for (let i = 0; i < 20; i++) {
		const sliceData = Array.from({ length: 600 }, (_, j) => 0x20 + (7 * j + i) % 0x60);
		const slice = nalUnit([i % 4 === 0 ? 0x65 : 0x41, 0x88, ...sliceData]);
		await source.add(
			new EncodedPacket(
				new Uint8Array(i % 4 === 0 ? [...nalUnit(sps), ...nalUnit(pps), ...slice] : slice),
				i % 4 === 0 ? 'key' : 'delta',
				i / 25,
				1 / 25,
			),
			i === 0 ? { decoderConfig: { codec: 'avc1.64000a', codedWidth: 64, codedHeight: 64 } } : undefined,
		);
	}
	await output.finalize();
	const bytes = new Uint8Array(output.target.buffer!);
	const tsPackets = Array.from({ length: bytes.length / 188 }, (_, i) => bytes.slice(188 * i, 188 * (i + 1)));

	const readFrames = async (packets: Uint8Array[]) => {
		const data = new Uint8Array(188 * packets.length);
		packets.forEach((packet, i) => data.set(packet, 188 * i));
		using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const frames: { timestamp: number; data: Uint8Array }[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			frames.push({ timestamp: packet.timestamp, data: packet.data });
		}
		return frames;
	};

	const clean = await readFrames(tsPackets);
	expect(clean).toHaveLength(20);
	const expectFrames = async (packets: Uint8Array[], missingFrames: number[]) => {
		expect(await readFrames(packets)).toEqual(clean.filter((_, i) => !missingFrames.includes(i)));
	};

	// The index of each frame's first TS packet (the video's PID is 0x100)
	const isVideo = (packet: Uint8Array) => (((packet[1]! & 0x1f) << 8) | packet[2]!) === 0x100;
	const frameStarts = tsPackets.flatMap((packet, i) => (isVideo(packet) && packet[1]! & 0x40 ? [i] : []));
	expect(frameStarts).toHaveLength(20);

	// Frame 5 loses its second TS packet, frame 18 its last one, frame 9 gets its second sent twice, frame 11 its
	// first, and frame 13's second has transport_error_indicator set and garbage in it
	const damaged = tsPackets.flatMap((packet, i) => {
		if (i === frameStarts[5]! + 1 || i === frameStarts[19]! - 1) {
			return [];
		} else if (i === frameStarts[9]! + 1 || i === frameStarts[11]) {
			return [packet, packet];
		} else if (i === frameStarts[13]! + 1) {
			const garbage = packet.map((byte, j) => (j < 4 ? byte : (j * 37) & 0xff));
			garbage[1]! |= 0x80;
			return [garbage];
		}
		return [packet];
	});
	await expectFrames(damaged, [5, 6, 7, 13, 14, 15, 18, 19]);

	// When the first frame loses a TS packet, the track still opens (setup reads its parameter sets, which come
	// first), and that frame's GOP goes
	await expectFrames(tsPackets.filter((_, i) => i !== frameStarts[0]! + 1), [0, 1, 2, 3]);

	// A capture that begins in the middle of a GOP (here inside frame 1, after the PAT and PMT) keeps its frames
	// before the first key frame as they are, even when its first whole PES packet (frame 2) lost a TS packet: they
	// don't decode without their key frame either way
	const lostInFrame2 = tsPackets[frameStarts[2]! + 1];
	const midGop = [...tsPackets.slice(0, 2), ...tsPackets.slice(frameStarts[1]! + 1)].filter(x => x !== lostInFrame2);
	const midGopFrames = await readFrames(midGop);
	const frameNumbers = (frames: { timestamp: number }[]) => frames.map(x => Math.round(x.timestamp * 25));
	expect(frameNumbers(midGopFrames)).toEqual(frameNumbers(clean.slice(2)));
	expect(midGopFrames.slice(1)).toEqual(clean.slice(3));

	// Muxers that never increment the counters, or that also count packets without payload, lose nothing, not even
	// identical TS packets in a row, which are data there (like in frame 3, here made of the same byte throughout)
	const setCounter = (packet: Uint8Array, counter: number) => {
		const copy = packet.slice();
		copy[3] = (copy[3]! & 0xf0) | (counter & 0xf);
		return copy;
	};
	const neverIncrementing = tsPackets.map((packet, i) => {
		if (!isVideo(packet)) {
			return packet;
		}

		const copy = setCounter(packet, 0);
		if (i > frameStarts[3]! && i < frameStarts[4]! - 1) {
			copy.fill(0x55, 4); // Whole TS packets of payload, all the same
		}
		return copy;
	});
	const neverIncrementingFrames = await readFrames(neverIncrementing);
	expect(neverIncrementingFrames.map(x => x.data.byteLength)).toEqual(clean.map(x => x.data.byteLength));
	expect(neverIncrementingFrames.filter((_, i) => i !== 3)).toEqual(clean.filter((_, i) => i !== 3));

	let counter = 0;
	const countingPacketsWithoutPayload = tsPackets.flatMap((packet, i) => {
		if (!isVideo(packet)) {
			return [packet];
		}

		const result = [setCounter(packet, counter++)];
		if (i === frameStarts[15]! + 1) {
			// A packet with just an adaptation field, which wrongly increments the counter
			const adaptationOnly = new Uint8Array(188).fill(0xff);
			adaptationOnly.set([0x47, 0x01, 0x00, 0x20, 183, 0x00]);
			result.push(setCounter(adaptationOnly, counter++));
		}
		return result;
	});
	await expectFrames(countingPacketsWithoutPayload, []);

	// Two files joined, like `cat` of segments that `ffmpeg -f segment` writes (from L46's review): the counters start
	// over at the join without discontinuity_indicator, but no packet is missing
	const withoutDiscontinuityIndicator = (packet: Uint8Array) => {
		const copy = packet.slice();
		if (copy[3]! & 0x20 && copy[4]! > 0) {
			copy[5]! &= 0x7f;
		}
		return copy;
	};
	// The first file has frames 0 to 9, the second one (with its own PAT and PMT) frames 10 to 19
	const firstFile = tsPackets.slice(0, frameStarts[10]).map(withoutDiscontinuityIndicator);
	const secondFile = [...tsPackets.slice(0, 2), ...tsPackets.slice(frameStarts[10])].map((packet) => {
		const copy = withoutDiscontinuityIndicator(packet);
		if (isVideo(copy)) {
			copy[3] = (copy[3]! & 0xf0) | ((copy[3]! + 7) & 0xf); // Make the counters jump at the join in any case
		}
		return copy;
	});
	expect(await readFrames([...firstFile, ...secondFile])).toEqual(clean);
	// Even without the PAT and PMT, since the first file's last PES packet ends with stuffing, as complete ones do
	expect(await readFrames([...firstFile, ...secondFile.slice(2)])).toEqual(clean);
});

test('MPEG-TS keeps the frame before one that lost a TS packet when PES packets begin mid-frame', async () => {
	// In 0.ts, each video PES packet begins with the end of the previous frame, then the next frame's AUD. Losing a TS
	// packet in the middle of one must not cost the end of the previous frame. (The frames after it go, up to the
	// next key frame, which 0.ts doesn't have.)
	const bytes = new Uint8Array(await fs.promises.readFile(path.join(__dirname, '../public/0.ts')));
	const readFrames = async (data: Uint8Array) => {
		using input = new Input({ source: new BufferSource(data), formats: [MPEG_TS] });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const frames: [number, string][] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			frames.push([packet.timestamp, createHash('sha1').update(packet.data).digest('hex')]);
		}
		return frames;
	};

	const clean = await readFrames(bytes);
	expect(clean).toHaveLength(298);

	// The 10th TS packet of the video PES packet that holds most of frame 21 (PID 0x100)
	let pesCount = 0;
	let lostPos = -1;
	for (let pos = 0; pos < bytes.length && lostPos === -1; pos += 188) {
		if ((((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!) === 0x100 && bytes[pos + 1]! & 0x40) {
			if (pesCount++ === 21) {
				let count = 0;
				for (let next = pos; ; next += 188) {
					if ((((bytes[next + 1]! & 0x1f) << 8) | bytes[next + 2]!) === 0x100 && ++count === 10) {
						lostPos = next;
						break;
					}
				}
			}
		}
	}

	const damaged = new Uint8Array([...bytes.subarray(0, lostPos), ...bytes.subarray(lostPos + 188)]);
	expect(await readFrames(damaged)).toEqual(clean.slice(0, 21));
});

test('MPEG-TS drops the rest of the GOP after a video frame that lost a TS packet, also for lookups', async () => {
	// With B-frames, the frames after a damaged one can refer to it, and Chromium's decoder fails on a frame whose
	// reference is missing (from L46's review). So everything up to the next key frame goes, and lookups made after
	// reading through it agree. 3 GOPs of 8 frames of a 64x64 x264 stream, in decode order I0 P3 B1 B2 P6 B4 B5 P7.
	const sps = [0x67, 0x64, 0x00, 0x0a, 0xac, 0xd3, 0x10, 0x9b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00,
		0x03, 0x03, 0x20, 0xf1, 0x22, 0x53, 0x80];
	const pps = [0x68, 0xef, 0x8f, 0xcb];
	const nalUnit = (bytes: number[]) => [0, 0, 0, 1, ...bytes];
	const presentationOffsets = [0, 3, 1, 2, 6, 4, 5, 7];

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, { frameRate: 25 });
	await output.start();
	for (let i = 0; i < 24; i++) {
		const isKey = i % 8 === 0;
		const sliceData = Array.from({ length: 600 }, (_, j) => 0x20 + (7 * j + i) % 0x60);
		const slice = nalUnit([isKey ? 0x65 : 0x41, 0x88, ...sliceData]);
		await source.add(
			new EncodedPacket(
				new Uint8Array(i === 0 ? [...nalUnit(sps), ...nalUnit(pps), ...slice] : slice),
				isKey ? 'key' : 'delta',
				(8 * Math.floor(i / 8) + presentationOffsets[i % 8]!) / 25,
				1 / 25,
			),
			i === 0 ? { decoderConfig: { codec: 'avc1.64000a', codedWidth: 64, codedHeight: 64 } } : undefined,
		);
	}
	await output.finalize();
	const bytes = new Uint8Array(output.target.buffer!);

	// Frame 9 in decode order (the second GOP's P3) loses its second TS packet
	const isVideo = (pos: number) => (((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!) === 0x100;
	const frameStarts: number[] = [];
	for (let pos = 0; pos < bytes.length; pos += 188) {
		if (isVideo(pos) && bytes[pos + 1]! & 0x40) {
			frameStarts.push(pos);
		}
	}
	expect(frameStarts).toHaveLength(24);
	const lostPos = frameStarts[9]! + 188;
	const damaged = new Uint8Array([...bytes.subarray(0, lostPos), ...bytes.subarray(lostPos + 188)]);

	const read = async (data: Uint8Array, input: Input) => {
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const sink = new EncodedPacketSink(track);
		const packets: EncodedPacket[] = [];
		for await (const packet of sink.packets()) {
			packets.push(packet);
		}
		return { sink, packets };
	};

	using cleanInput = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const clean = (await read(bytes, cleanInput)).packets;
	expect(clean).toHaveLength(24);

	using input = new Input({ source: new BufferSource(damaged), formats: ALL_FORMATS });
	const { sink, packets } = await read(damaged, input);
	const kept = clean.filter((_, i) => i < 9 || i >= 16);
	expect(packets.map(x => [x.timestamp, x.data])).toEqual(kept.map(x => [x.timestamp, x.data]));

	// The second GOP's B4 was dropped, so the packet at its timestamp is the last one kept before it: the GOP's key
	// frame, which is followed by the third GOP's key frame
	const packet = await sink.getPacket(12 / 25);
	assert(packet);
	expect(packet.timestamp).toBe(8 / 25);
	expect(packet.data).toEqual(clean[8]!.data);
	expect((await sink.getKeyPacket(12 / 25))?.timestamp).toBe(8 / 25);
	expect((await sink.getNextPacket(packet))?.data).toEqual(clean[16]!.data);

	// Lookups at every dropped frame, one after the other (each leaves reference points for the next ones)
	for (let frame = 9; frame < 16; frame++) {
		expect((await sink.getPacket(frame / 25))?.timestamp).toBe(8 / 25);
	}
});

test('MPEG-TS lookups find the frames before the first key frame that iteration keeps', async () => {
	// From L46's review. A capture that starts at frame 3, mid-GOP, and where frame 5, before the first key frame,
	// loses a TS packet: those frames are kept as they are, and a lookup on a fresh input at each frame's timestamp
	// must find it, even before anything was read from the track's start. 20 frames of a 64x64 x264 stream (stub
	// slices of 600 bytes), with key frames (carrying SPS and PPS) at 0 and 10.
	const sps = [0x67, 0x64, 0x00, 0x0a, 0xac, 0xd3, 0x10, 0x9b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00,
		0x03, 0x03, 0x20, 0xf1, 0x22, 0x53, 0x80];
	const pps = [0x68, 0xef, 0x8f, 0xcb];
	const nalUnit = (bytes: number[]) => [0, 0, 0, 1, ...bytes];

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, { frameRate: 25 });
	await output.start();
	for (let i = 0; i < 20; i++) {
		const isKey = i % 10 === 0;
		const sliceData = Array.from({ length: 600 }, (_, j) => 0x20 + (7 * j + i) % 0x60);
		const slice = nalUnit([isKey ? 0x65 : 0x41, 0x88, ...sliceData]);
		await source.add(
			new EncodedPacket(
				new Uint8Array(isKey ? [...nalUnit(sps), ...nalUnit(pps), ...slice] : slice),
				isKey ? 'key' : 'delta',
				i / 25,
				1 / 25,
			),
			i === 0 ? { decoderConfig: { codec: 'avc1.64000a', codedWidth: 64, codedHeight: 64 } } : undefined,
		);
	}
	await output.finalize();
	const bytes = new Uint8Array(output.target.buffer!);
	const tsPackets = Array.from({ length: bytes.length / 188 }, (_, i) => bytes.slice(188 * i, 188 * (i + 1)));
	const isVideo = (packet: Uint8Array) => (((packet[1]! & 0x1f) << 8) | packet[2]!) === 0x100;
	const frameStarts = tsPackets.flatMap((packet, i) => (isVideo(packet) && packet[1]! & 0x40 ? [i] : []));

	const damaged = tsPackets.filter(
		(packet, i) => (!isVideo(packet) || i >= frameStarts[3]!) && i !== frameStarts[5]! + 1,
	);
	const data = new Uint8Array(188 * damaged.length);
	damaged.forEach((packet, i) => data.set(packet, 188 * i));

	using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const iterated: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		iterated.push(packet);
	}
	expect(iterated.map(x => Math.round(x.timestamp * 25))).toEqual(
		[3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
	);

	for (const packet of iterated) {
		using freshInput = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
		const freshTrack = await freshInput.getPrimaryVideoTrack();
		assert(freshTrack);
		const found = await new EncodedPacketSink(freshTrack).getPacket(packet.timestamp);
		expect([found?.timestamp, found?.byteLength]).toEqual([packet.timestamp, packet.byteLength]);
	}
});

test('MPEG-TS keeps the frames before a late first key frame when one of them lost a TS packet', async () => {
	// From L46's review. 1210 frames of a 64x64 x264 stream (stub slices of 300 bytes, 2 TS packets each), with key
	// frames (carrying SPS and PPS) at 0 and 1200: a long GOP, like a capture of a stream with rare key frames
	const sps = [0x67, 0x64, 0x00, 0x0a, 0xac, 0xd3, 0x10, 0x9b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00,
		0x03, 0x03, 0x20, 0xf1, 0x22, 0x53, 0x80];
	const pps = [0x68, 0xef, 0x8f, 0xcb];
	const nalUnit = (bytes: number[]) => [0, 0, 0, 1, ...bytes];

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, { frameRate: 25 });
	await output.start();
	for (let i = 0; i < 1210; i++) {
		const isKey = i % 1200 === 0;
		const sliceData = Array.from({ length: 300 }, (_, j) => 0x20 + (7 * j + i) % 0x60);
		const slice = nalUnit([isKey ? 0x65 : 0x41, 0x88, ...sliceData]);
		await source.add(
			new EncodedPacket(
				new Uint8Array(isKey ? [...nalUnit(sps), ...nalUnit(pps), ...slice] : slice),
				isKey ? 'key' : 'delta',
				i / 25,
				1 / 25,
			),
			i === 0 ? { decoderConfig: { codec: 'avc1.64000a', codedWidth: 64, codedHeight: 64 } } : undefined,
		);
	}
	await output.finalize();
	const bytes = new Uint8Array(output.target.buffer!);
	const tsPackets = Array.from({ length: bytes.length / 188 }, (_, i) => bytes.slice(188 * i, 188 * (i + 1)));
	const isVideo = (packet: Uint8Array) => (((packet[1]! & 0x1f) << 8) | packet[2]!) === 0x100;
	const frameStarts = tsPackets.flatMap((packet, i) => (isVideo(packet) && packet[1]! & 0x40 ? [i] : []));

	const toBytes = (packets: Uint8Array[]) => {
		const data = new Uint8Array(188 * packets.length);
		packets.forEach((packet, i) => data.set(packet, 188 * i));
		return data;
	};
	const read = async (data: Uint8Array) => {
		using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			timestamps.push(packet.timestamp);
		}
		return timestamps;
	};

	// A capture that starts at frame 3, so its first key frame comes 1197 frames in. Frame 1100, before it, loses a
	// TS packet: like on main, the frames before the first key frame are kept as they are.
	const capture = toBytes(tsPackets.filter((packet, i) => !isVideo(packet) || i >= frameStarts[3]!));
	const damaged = toBytes(tsPackets.filter(
		(packet, i) => (!isVideo(packet) || i >= frameStarts[3]!) && i !== frameStarts[1100]! + 1,
	));
	const timestamps = await read(damaged);
	expect(timestamps).toEqual(await read(capture));

	// Lookups on a fresh input agree, after the hole too
	for (const timestamp of [timestamps[1096]!, timestamps[1150]!, timestamps[1200]!]) {
		using freshInput = new Input({ source: new BufferSource(damaged), formats: ALL_FORMATS });
		const freshTrack = await freshInput.getPrimaryVideoTrack();
		assert(freshTrack);
		expect((await new EncodedPacketSink(freshTrack).getPacket(timestamp))?.timestamp).toBe(timestamp);
	}
});
