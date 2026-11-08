import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource, ReadableStreamSource, CustomSource } from '../../src/source.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { ALL_FORMATS, HLS_FORMATS, MPEG_TS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { MpegTsDemuxer } from '../../src/mpeg-ts/mpeg-ts-demuxer.js';
import { MpegTsStreamType } from '../../src/mpeg-ts/mpeg-ts-misc.js';
import { Logging, LogLevel } from '../../src/logging.js';
import { Conversion } from '../../src/conversion.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { countMovedArrayElements } from './array-moves.js';

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

test('MPEG-TS with Blu-ray Dolby Digital Plus made of an AC-3 core and an E-AC-3 extension', async () => {
	// Blu-ray's Dolby Digital Plus (stream_type 0x84) carries an AC-3 frame as the core of each frame, optionally
	// followed by an E-AC-3 dependent substream frame extending it (to 7.1, say)
	const ac3Core = new Uint8Array(128); // 48 kHz, 32 kbit/s, 5.1
	// The crc1 bytes 0x40 0x00 look like the strmtyp of an E-AC-3 dependent substream, if read as one
	ac3Core.set([0x0b, 0x77, 0x40, 0x00, 0x00, 0x40, 0xe1]);
	// strmtyp 1, frmsiz 31, 6 blocks, bsid 16, chanmap with the Lrs/Rrs pair (making it 7.1)
	const eac3Dependent = new Uint8Array(64);
	eac3Dependent.set([0x0b, 0x77, 0x40, 0x1f, 0x34, 0x80, 0x10, 0x20]);

	const buildFile = (withExtension: boolean) => {
		const packets: Uint8Array[] = [];
		const pushPacket = (pid: number, payload: number[], payloadUnitStart: boolean) => {
			// 192-byte packets: a 4-byte TP_extra_header before each TS packet
			const packet = new Uint8Array(192).fill(0xff);
			packet.set([0, 0, 0, 0, 0x47, (payloadUnitStart ? 0x40 : 0) | (pid >> 8), pid & 0xff], 0);
			const stuffing = 184 - payload.length;
			if (stuffing > 0) {
				packet[7] = 0x30;
				packet.set([stuffing - 1, ...(stuffing > 1 ? [0x00] : [])], 8);
			} else {
				packet[7] = 0x10;
			}
			packet.set(payload, 8 + stuffing);
			packets.push(packet);
		};

		pushPacket(0x0000, [0x00, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0], true);
		pushPacket(0x0100, [
			0x00, 0x02, 0xb0, 0x18, 0, 1, 0xc1, 0, 0, 0xf1, 0x00, 0xf0, 0x06,
			0x05, 0x04, 0x48, 0x44, 0x4d, 0x56, // Registration descriptor: 'HDMV'
			0x84, 0xf1, 0x00, 0xf0, 0x00, // Dolby Digital Plus on PID 0x1100
			0, 0, 0, 0, // CRC (not checked)
		], true);

		for (let i = 0; i < 8; i++) {
			const frame = withExtension ? [...ac3Core, ...eac3Dependent] : [...ac3Core];
			const pts = 2880 * i;
			const pes = [
				0, 0, 1, 0xbd, (frame.length + 8) >> 8, (frame.length + 8) & 0xff, 0x80, 0x80, 5,
				0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff, ((pts >> 14) & 0xfe) | 1, (pts >> 7) & 0xff,
				((pts << 1) & 0xfe) | 1, ...frame,
			];
			for (let offset = 0; offset < pes.length; offset += 184) {
				pushPacket(0x1100, pes.slice(offset, offset + 184), offset === 0);
			}
		}

		const bytes = new Uint8Array(192 * packets.length);
		packets.forEach((packet, i) => bytes.set(packet, 192 * i));
		return bytes;
	};

	for (const withExtension of [false, true]) {
		using input = new Input({
			source: new BufferSource(buildFile(withExtension)),
			formats: ALL_FORMATS,
		});

		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);
		expect(await audioTrack.getCodec()).toBe('eac3');
		const numberOfChannels = withExtension ? 8 : 6;
		expect(await audioTrack.getDecoderConfig()).toEqual({ codec: 'ec-3', numberOfChannels, sampleRate: 48000 });

		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
			packets.push(packet);
		}

		// One packet per frame, the extension included
		const frameSize = ac3Core.length + (withExtension ? eac3Dependent.length : 0);
		expect(packets.map(packet => [packet.timestamp, packet.duration, packet.byteLength])).toEqual(
			[0, 1, 2, 3, 4, 5, 6, 7].map(i => [0.032 * i, 0.032, frameSize]),
		);

		// The packets can be copied to MP4, whose dec3 box describes the AC-3 core and its extension
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output });
		await conversion.execute();

		using mp4Input = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});
		const mp4AudioTrack = await mp4Input.getPrimaryAudioTrack();
		assert(mp4AudioTrack);
		expect(await mp4AudioTrack.getCodec()).toBe('eac3');
		expect(await mp4AudioTrack.getNumberOfChannels()).toBe(numberOfChannels);
		expect(await mp4AudioTrack.getSampleRate()).toBe(48000);

		const mp4Packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(mp4AudioTrack).packets()) {
			mp4Packets.push(packet);
		}
		expect(mp4Packets.map(packet => packet.byteLength)).toEqual(new Array<number>(8).fill(frameSize));

		// dec3's data_rate (13 bits, in kbit/s) is the whole bitstream's: 32 for the core, plus 16 for the extension
		const mp4Bytes = new Uint8Array(output.target.buffer!);
		const dec3Pos = mp4Bytes.findIndex((_, i) => String.fromCharCode(...mp4Bytes.subarray(i, i + 4)) === 'dec3');
		expect(((mp4Bytes[dec3Pos + 4]! << 8) | mp4Bytes[dec3Pos + 5]!) >> 3).toBe(withExtension ? 48 : 32);
	}
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

	// Repeated bytes holding 0x47 line up at any even stride, but they aren't packet headers (an MP3 whose frames
	// contain such padding, samples.ffmpeg.org trac/ticket3844/tuu_gekisinn.mp3, was taken for MPEG-TS)
	const padding = new Uint8Array(2000).map((_, i) => (i % 2 === 0 ? 0x4f : 0x47));
	using paddingInput = new Input({ source: new BufferSource(padding), formats: [MPEG_TS] });
	await expect(paddingInput.getFormat()).rejects.toThrow('unsupported or unrecognizable');
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

test('MPEG-TS random_access_indicator on every frame with per-frame SEI messages', async () => {
	// Every PES packet is flagged with random_access_indicator, and every frame carries an SEI message (a pic_timing
	// one, as x264 writes with pic-struct, or broadcast caption data). Only the IDR frame and the frame with a recovery
	// point SEI message are random access points.
	const packets: Uint8Array[] = [];
	const pushPes = (pid: number, payload: number[], randomAccess: boolean) => {
		for (let i = 0; i < payload.length; i += 182) {
			const chunk = payload.slice(i, i + 182);
			const packet = new Uint8Array(188).fill(0xff);
			const adaptationLength = 184 - chunk.length; // At least 2: length and flags
			packet.set([0x47, (i === 0 ? 0x40 : 0) | (pid >> 8), pid & 0xff, 0x30, adaptationLength - 1], 0);
			packet[5] = i === 0 && randomAccess ? 0x40 : 0x00;
			packet.set(chunk, 4 + adaptationLength);
			packets.push(packet);
		}
	};

	const sps = [0x67, 0x42, 0xc0, 0x0a, 0xda, 0x10, 0x9b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03,
		0x03, 0x20, 0xf1, 0x22, 0x6a]; // x264, 64x64
	const pps = [0x68, 0xce, 0x0f, 0xc8];
	const aud = [0x09, 0xf0];
	const picTimingSei = [0x06, 0x01, 0x02, 0x00, 0x00, 0x80]; // payloadType 1
	const recoveryPointSei = [0x06, 0x01, 0x02, 0x00, 0x00, 0x06, 0x01, 0x80, 0x80]; // pic_timing, then payloadType 6
	const idr = [0x65, 0x88, 0x84, 0x00, 0x33, ...new Array<number>(30).fill(0xaa)];
	const slice = [0x41, 0x9a, 0x02, 0x04, ...new Array<number>(20).fill(0xaa)];
	const nal = (nalUnit: number[]) => [0, 0, 0, 1, ...nalUnit];

	pushPes(0x0000, [0x00, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0], false);
	pushPes(0x1000, [
		0x00, 0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0,
	], false);

	const expectedTypes = ['key', 'delta', 'delta', 'delta', 'key', 'delta', 'delta', 'delta'];
	expectedTypes.forEach((type, i) => {
		const au = i === 0
			? [aud, sps, pps, picTimingSei, idr]
			: [aud, type === 'key' ? recoveryPointSei : picTimingSei, slice];
		const pts = 3000 * i;
		pushPes(0x100, [
			0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff,
			((pts >> 14) & 0xfe) | 1, (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1, ...au.flatMap(nal),
		], true);
	});

	const bytes = new Uint8Array(188 * packets.length);
	packets.forEach((packet, i) => bytes.set(packet, 188 * i));

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
	const types: string[] = [];
	for await (const packet of sink.packets()) {
		types.push(packet.type);
	}

	expect(types).toEqual(expectedTypes);
});

test('MPEG-TS random_access_indicator on PES packets holding several frames', async () => {
	// random_access_indicator marks the PES packet holding the start of a random access point: the first access unit
	// in it. It doesn't tell about the access units after that one in the same PES packet, which may or may not be key
	// frames (several, in all-intra or short-GOP streams), and it didn't lie about them.
	const packets: Uint8Array[] = [];
	const pushPes = (pid: number, payload: number[], randomAccess: boolean) => {
		for (let i = 0; i < payload.length; i += 182) {
			const chunk = payload.slice(i, i + 182);
			const packet = new Uint8Array(188).fill(0xff);
			const adaptationLength = 184 - chunk.length; // At least 2: length and flags
			packet.set([0x47, (i === 0 ? 0x40 : 0) | (pid >> 8), pid & 0xff, 0x30, adaptationLength - 1], 0);
			packet[5] = i === 0 && randomAccess ? 0x40 : 0x00;
			packet.set(chunk, 4 + adaptationLength);
			packets.push(packet);
		}
	};

	const sps = [0x67, 0x42, 0xc0, 0x0a, 0xda, 0x10, 0x9b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03,
		0x03, 0x20, 0xf1, 0x22, 0x6a]; // x264, 64x64
	const pps = [0x68, 0xce, 0x0f, 0xc8];
	const aud = [0x09, 0xf0];
	const idr = [0x65, 0x88, 0x84, 0x00, 0x33, ...new Array<number>(30).fill(0xaa)];
	const slice = [0x41, 0x9a, 0x02, 0x04, ...new Array<number>(20).fill(0xaa)];
	const nal = (nalUnit: number[]) => [0, 0, 0, 1, ...nalUnit];
	const keyFrame = [aud, sps, pps, idr].flatMap(nal);
	const deltaFrame = [aud, slice].flatMap(nal);

	pushPes(0x0000, [0x00, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0], false);
	pushPes(0x1000, [
		0x00, 0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0,
	], false);

	// Several frames per PES packet; the PES packets that begin with a key frame are flagged
	const pesPackets = [
		[keyFrame, deltaFrame, deltaFrame],
		[deltaFrame, deltaFrame, deltaFrame],
		[keyFrame, deltaFrame, keyFrame],
		[keyFrame, keyFrame, deltaFrame],
	];
	pesPackets.forEach((frames, i) => {
		const pts = 9000 * i;
		pushPes(0x100, [
			0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff,
			((pts >> 14) & 0xfe) | 1, (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1, ...frames.flat(),
		], frames[0] === keyFrame);
	});

	const bytes = new Uint8Array(188 * packets.length);
	packets.forEach((packet, i) => bytes.set(packet, 188 * i));

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
	const types: string[] = [];
	for await (const packet of sink.packets()) {
		types.push(packet.type);
	}

	expect(types).toEqual(pesPackets.flat().map(frame => frame === keyFrame ? 'key' : 'delta'));

	// The flags stay trusted, so key packet lookups keep relying on them instead of reading the bitstream
	const demuxer = (await input._getDemuxer()) as MpegTsDemuxer;
	expect(demuxer.elementaryStreams.map(stream => stream.canBeTrustedWithKeyPackets)).toEqual([true]);
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

	// The access units of each frame: two for a field pair
	const frames = [
		[annexB([aud, sps, pps, slice(true, 0, 1)]), annexB([aud, slice(false, 0, 2)])],
		[annexB([aud, slice(false, 1, 1)]), annexB([aud, slice(false, 1, 2)])],
		[annexB([aud, slice(false, 2, 0)])], // Frame-coded
		[annexB([aud, slice(false, 3, 2)]), annexB([aud, slice(false, 3, 1)])], // Bottom field first
		[annexB([aud, slice(false, 4, 1)])], // Unpaired
		[annexB([aud, slice(false, 5, 1)]), annexB([aud, slice(false, 5, 2)])],
	];

	const buildStream = (pesPackets: { pts: number; data: number[] }[]) => {
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

		pushPackets(0x0000, [0x00, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0]);
		pushPackets(0x1000, [
			0x00, 0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0,
		]);
		for (const { pts, data } of pesPackets) {
			pushPackets(0x100, [
				0, 0, 1, 0xe0, 0, 0, 0x84, 0x80, 5, 0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff,
				((pts >> 14) & 0xfe) | 1, (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1, ...data,
			]);
		}

		const bytes = new Uint8Array(188 * packets.length);
		packets.forEach((packet, i) => bytes.set(packet, 188 * i));
		return bytes;
	};

	const readPackets = async (bytes: Uint8Array) => {
		using input = new Input({
			source: new BufferSource(bytes),
			formats: ALL_FORMATS,
		});

		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		const packets: EncodedPacket[] = [];
		for await (const packet of sink.packets()) {
			packets.push(packet);
		}

		// Looking a packet up by its timestamp must give the same packet
		for (const packet of packets) {
			expect((await sink.getPacket(packet.timestamp))?.sequenceNumber).toBe(packet.sequenceNumber);
		}

		// Concurrent calls for the next packet of the same packet (as Conversion makes when trimming) agree
		const first = await sink.getFirstPacket();
		const nextPackets = await Promise.all([sink.getNextPacket(first!), sink.getNextPacket(first!)]);
		expect(nextPackets.map(packet => packet?.sequenceNumber)).toEqual([1, 1].map(() => packets[1]!.sequenceNumber));

		return packets;
	};

	// Both fields in one PES packet, which has the frame's PTS
	const merged = await readPackets(buildStream(frames.map((aus, i) => ({ pts: 3600 * i, data: aus.flat() }))));
	expect(merged.map(packet => [packet.timestamp, packet.duration])).toEqual(frames.map((_, i) => [0.04 * i, 0.04]));
	// The second field's AUD is left out, as it would make a packet look like it ends there
	const withoutSecondAud = (aus: number[][]) => [...aus[0]!, ...(aus[1]?.slice(6) ?? [])];
	expect(merged.map(packet => [...packet.data])).toEqual(frames.map(withoutSecondAud));

	// Each field in a PES packet of its own, with its own PTS: these stay separate packets, timed by their PES packets
	const separate = await readPackets(buildStream(frames.flatMap((aus, i) => aus.map((au, j) => ({
		pts: 3600 * i + 1800 * j,
		data: au,
	})))));
	expect(separate.map(packet => [Math.round(packet.timestamp * 90_000), packet.byteLength])).toEqual(
		frames.flatMap((aus, i) => aus.map((au, j) => [3600 * i + 1800 * j, au.length])),
	);
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
	// the previous picture before its own AUD, the first one too (the file was cut from a longer stream). There are no
	// random_access_indicator flags.
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
		const previousTail = nal(slice(i > 0 && (i - 1) % 4 === 0, true));
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
		const foundLater = await sink.getKeyPacket(keyPacket.timestamp + 1 / 30);
		expect(foundLater?.sequenceNumber).toBe(keyPacket.sequenceNumber);
	}
});

test('MPEG-TS key packet lookup finds key frames sharing their PTS with the frame before them', async () => {
	// 30 fps, every 10th frame a key frame that has the previous frame's timestamp (seen with Mediabunny's own output
	// for such input). Key frames are flagged with random_access_indicator.
	const packets: Uint8Array[] = [];
	const pushPackets = (pid: number, payload: number[], randomAccess = false) => {
		for (let i = 0; i < payload.length; i += 184 - (i === 0 && randomAccess ? 2 : 0)) {
			const isFirst = i === 0;
			const adaptation = isFirst && randomAccess ? [0x01, 0x40] : []; // random_access_indicator
			const chunk = payload.slice(i, i + 184 - adaptation.length);
			const packet = new Uint8Array(188);
			const stuffing = 184 - adaptation.length - chunk.length;
			const header = [0x47, (isFirst ? 0x40 : 0) | (pid >> 8), pid & 0xff];
			if (adaptation.length > 0 || stuffing > 0) {
				const adaptationLength = adaptation.length + stuffing;
				packet.set([...header, 0x30, adaptationLength - 1], 0);
				packet.set(adaptationLength > 1 ? [adaptation[1] ?? 0x00] : [], 5);
				packet.fill(0xff, 6, 4 + adaptationLength);
				packet.set(chunk, 4 + adaptationLength);
			} else {
				packet.set([...header, 0x10], 0);
				packet.set(chunk, 4);
			}
			packets.push(packet);
		}
	};

	const sps = [0x67, 0x42, 0xc0, 0x0a, 0xda, 0x10, 0x9b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03,
		0x03, 0x20, 0xf1, 0x22, 0x6a]; // x264, 64x64
	const pps = [0x68, 0xce, 0x0f, 0xc8];
	const aud = [0x09, 0xf0];
	const nal = (nalUnit: number[]) => [0, 0, 0, 1, ...nalUnit];

	pushPackets(0x0000, [0x00, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0]);
	pushPackets(0x1000, [
		0x00, 0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0,
	]);
	for (let i = 0; i < 40; i++) {
		const isKey = i % 10 === 0;
		const au = isKey
			? [...nal(aud), ...nal(sps), ...nal(pps), ...nal([0x65, 0x88, 0x84, 0x00, 0x33, 0xaa, 0xaa])]
			: [...nal(aud), ...nal([0x41, 0x9a, 0x02, 0x04, 0xaa, 0xaa])];
		const pts = 3000 * (isKey && i > 0 ? i - 1 : i);
		pushPackets(0x100, [
			0, 0, 1, 0xe0, 0, 0, 0x84, 0x80, 5, 0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff,
			((pts >> 14) & 0xfe) | 1, (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1, ...au,
		], isKey);
	}

	const bytes = new Uint8Array(188 * packets.length);
	packets.forEach((packet, i) => bytes.set(packet, 188 * i));

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
	const keyPackets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		if (packet.type === 'key') {
			keyPackets.push(packet);
		}
	}
	expect(keyPackets.map(packet => Math.round(packet.timestamp * 30))).toEqual([0, 9, 19, 29]);

	for (const keyPacket of keyPackets) {
		expect((await sink.getKeyPacket(keyPacket.timestamp))?.sequenceNumber).toBe(keyPacket.sequenceNumber);
	}
});

test('MPEG-TS key packet lookup returns key frames split over several PES packets whole', async () => {
	// The first access unit comes in PES packets with PTS 0: AUD + SPS, PPS, possibly many SEI ones, and SEI + IDR. The
	// first and last are flagged with random_access_indicator, the middle ones aren't, or all of them are.
	const sps = [0x67, 0x42, 0xc0, 0x0a, 0xda, 0x10, 0x9b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03,
		0x03, 0x20, 0xf1, 0x22, 0x6a]; // x264, 64x64
	const pps = [0x68, 0xce, 0x0f, 0xc8];
	const aud = [0x09, 0xf0];
	const sei = [0x06, 0x05, 0x01, 0x00, 0x80];
	const idr = [0x65, 0x88, 0x84, 0x00, 0x33, ...new Array<number>(30).fill(0xaa)];
	const slice = [0x41, 0x9a, 0x02, 0x04, ...new Array<number>(20).fill(0xaa)];
	const nal = (nalUnit: number[]) => [0, 0, 0, 1, ...nalUnit];

	const buildFile = (flagMiddle: boolean, seiPesCount: number) => {
		const packets: Uint8Array[] = [];
		const pushPes = (pid: number, payload: number[], randomAccess: boolean) => {
			// One TS packet per PES packet: adaptation field (flags + stuffing), then the payload
			const packet = new Uint8Array(188).fill(0xff);
			const adaptationLength = 184 - payload.length;
			const flags = randomAccess ? 0x40 : 0x00;
			packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x30, adaptationLength - 1, flags], 0);
			packet.set(payload, 4 + adaptationLength);
			packets.push(packet);
		};
		const pes = (pts: number, nalUnits: number[][]) => [
			0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1,
			...nalUnits.flatMap(nal),
		];

		pushPes(0x0000, [0x00, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0], false);
		pushPes(0x1000, [
			0x00, 0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0,
		], false);
		pushPes(0x100, pes(0, [aud, sps]), true);
		pushPes(0x100, pes(0, [pps]), flagMiddle);
		for (let i = 0; i < seiPesCount; i++) {
			pushPes(0x100, pes(0, [sei]), flagMiddle);
		}
		pushPes(0x100, pes(0, [sei, idr]), true);
		for (let i = 1; i < 4; i++) {
			pushPes(0x100, pes(3000 * i, [aud, slice]), false);
		}

		const bytes = new Uint8Array(188 * packets.length);
		packets.forEach((packet, i) => bytes.set(packet, 188 * i));
		return bytes;
	};

	for (const [flagMiddle, seiPesCount] of [[false, 0], [true, 0], [false, 70]] as const) {
		using input = new Input({
			source: new BufferSource(buildFile(flagMiddle, seiPesCount)),
			formats: ALL_FORMATS,
		});

		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		const firstPacket = await sink.getFirstPacket();
		const nalUnits = [aud, sps, pps, ...new Array<number[]>(seiPesCount).fill(sei), sei, idr];
		expect(firstPacket!.byteLength).toBe(nalUnits.flatMap(nal).length);

		const keyPacket = await sink.getKeyPacket(0);
		expect(keyPacket?.type).toBe('key');
		expect(keyPacket?.sequenceNumber).toBe(firstPacket!.sequenceNumber);
		expect(keyPacket?.data).toEqual(firstPacket!.data);
	}
});

test('MPEG-TS getNextPacket finds the next audio frame when PES packets start inside a frame', async () => {
	// MP3 frames of 104 bytes in PES packets of 150 bytes, so most PES packets begin with the end of a frame. In the
	// second PES packet, those leftover bytes happen to look like an MP3 frame header.
	const frameSize = 104;
	const frameCount = 12;
	const frames = new Uint8Array(frameSize * frameCount);
	for (let i = 0; i < frameCount; i++) {
		frames.set([0xff, 0xfb, 0x10, 0x00], i * frameSize); // MPEG-1 Layer III, 32 kbit/s, 44.1 kHz
	}
	frames.set([0xff, 0xf6, 0xd4, 0xed], 160); // Inside frame 1, which ends at byte 208

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

	pushPackets(0x0000, [0x00, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0]);
	pushPackets(0x1000, [
		0x00, 0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x03, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0,
	]);
	for (let start = 0; start < frames.length; start += 150) {
		// The PTS belongs to the first frame that starts in the PES packet
		const firstFrame = Math.ceil(start / frameSize);
		const pts = Math.round(firstFrame * 1152 * 90_000 / 44_100);
		const data = [...frames.subarray(start, start + 150)];
		pushPackets(0x100, [
			0, 0, 1, 0xc0, (data.length + 8) >> 8, (data.length + 8) & 0xff, 0x84, 0x80, 5,
			0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff, ((pts >> 14) & 0xfe) | 1, (pts >> 7) & 0xff,
			((pts << 1) & 0xfe) | 1, ...data,
		]);
	}

	const bytes = new Uint8Array(188 * packets.length);
	packets.forEach((packet, i) => bytes.set(packet, 188 * i));

	using input = new Input({
		source: new BufferSource(bytes),
		formats: [MPEG_TS], // Two MP3 frame headers within one TS packet would make MP3 detection claim the file
	});

	const track = await input.getPrimaryAudioTrack();
	const sink = new EncodedPacketSink(track!);

	const allPackets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		allPackets.push(packet);
	}
	expect(allPackets).toHaveLength(frameCount);

	// These packets carry no reading state anymore, so getNextPacket has to read again from their PES packet
	for (let i = 0; i < allPackets.length - 1; i++) {
		const next = await sink.getNextPacket(allPackets[i]!);
		expect(next?.sequenceNumber).toBe(allPackets[i + 1]!.sequenceNumber);
		expect(next?.timestamp).toBe(allPackets[i + 1]!.timestamp);
	}
});

test('MPEG-TS with small MP3 frames is not taken for an MP3 file', async () => {
	// 32 kbit/s MP3 (104-byte frames), several frames per PES packet. The PSI sections are padded with
	// adaptation-field stuffing, so the first frame header in the file is followed by another one 104 bytes later.
	const frameSize = 104;
	const frameCount = 12;
	const frames = new Uint8Array(frameSize * frameCount);
	for (let i = 0; i < frameCount; i++) {
		frames.set([0xff, 0xfb, 0x10, 0x00], i * frameSize); // MPEG-1 Layer III, 32 kbit/s, 44.1 kHz
	}

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

	pushPackets(0x0000, [0x00, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0]);
	pushPackets(0x1000, [
		0x00, 0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x03, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0,
	]);
	for (let i = 0; i < frameCount; i += 3) {
		const pts = 90_000 + Math.round(i * 1152 * 90_000 / 44_100);
		const data = [...frames.subarray(i * frameSize, (i + 3) * frameSize)];
		pushPackets(0x100, [
			0, 0, 1, 0xc0, (data.length + 8) >> 8, (data.length + 8) & 0xff, 0x84, 0x80, 5,
			0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff, ((pts >> 14) & 0xfe) | 1, (pts >> 7) & 0xff,
			((pts << 1) & 0xfe) | 1, ...data,
		]);
	}

	const bytes = new Uint8Array(188 * packets.length);
	packets.forEach((packet, i) => bytes.set(packet, 188 * i));

	for (const formats of [ALL_FORMATS, HLS_FORMATS]) {
		using input = new Input({
			source: new BufferSource(bytes),
			formats,
		});

		expect(await input.getFormat()).toBe(MPEG_TS);

		const track = await input.getPrimaryAudioTrack();
		let packetCount = 0;
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			expect(packet.byteLength).toBe(frameSize);
			packetCount++;
		}
		expect(packetCount).toBe(frameCount);
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

test('MPEG-TS metadata reading gives up on declared streams that never show up, and finds late ones', async () => {
	// The PMT declares two AAC streams. 20 minutes of the first one, one ADTS frame per PES packet and TS packet. The
	// second one is never sent (like a recording that dropped a language), starts 3 minutes in, or is only there for
	// 5 seconds a minute in.
	const buildFile = (secondStreamFrames: [number, number] | null) => {
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
			0x0f, 0xe1, 0x01, 0xf0, 0x00, // AAC on PID 0x101
		])), true);

		const adtsFrame = new Uint8Array(39); // LC, 48 kHz, stereo, 39 bytes
		adtsFrame.set([0xff, 0xf1, 0x4c, 0x80, 0x04, 0xff, 0xfc]);
		const pushFrame = (pid: number, pts: number) => {
			const pes = new Uint8Array(14 + adtsFrame.length);
			pes.set([0, 0, 1, 0xc0, 0, 8 + adtsFrame.length, 0x84, 0x80, 5]);
			pes.set([0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff, ((pts >> 14) & 0xfe) | 1], 9);
			pes.set([(pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1], 12);
			pes.set(adtsFrame, 14);
			pushPacket(pid, pes, false);
		};

		const frameCount = Math.round(1200 * 48000 / 1024);
		for (let i = 0; i < frameCount; i++) {
			const pts = Math.round(i * 1024 * 90000 / 48000);
			pushFrame(0x100, pts);
			if (secondStreamFrames && i >= secondStreamFrames[0] && i < secondStreamFrames[1]) {
				pushFrame(0x101, pts);
			}
		}

		const bytes = new Uint8Array(188 * packets.length);
		packets.forEach((packet, i) => bytes.set(packet, 188 * i));
		return bytes;
	};

	const getTracks = async (
		bytes: Uint8Array,
		options: { maxMissingStreamScanSize?: number; unknownSize?: boolean } = {},
	) => {
		let bytesRead = 0;
		let readCount = 0;
		const warnings: string[] = [];
		const previousLogLevel = Logging.level;
		Logging.level = LogLevel.Silent;
		const stopCapturing = Logging.on('warn', args => warnings.push(args.map(String).join(' ')));

		try {
			using input = new Input({
				source: options.unknownSize
					? new ReadableStreamSource(new ReadableStream({
						start(controller) {
							for (let i = 0; i < bytes.length; i += 2 ** 16) {
								controller.enqueue(bytes.slice(i, i + 2 ** 16));
							}
							controller.close();
						},
					}))
					: new CustomSource({
						getSize: () => bytes.byteLength,
						read: (start, end) => {
							bytesRead += end - start;
							readCount++;
							return bytes.subarray(start, end);
						},
					}),
				formats: ALL_FORMATS,
			});

			if (options.maxMissingStreamScanSize !== undefined) {
				const demuxer = (await input._getDemuxer()) as MpegTsDemuxer;
				demuxer.maxMissingStreamScanSize = options.maxMissingStreamScanSize;
			}

			const tracks = await input.getTracks();
			return {
				bytesRead,
				readCount,
				warnings: warnings.filter(warning => warning.includes('declared but')),
				tracks: await Promise.all(tracks.map(async track => [track.id, await track.getFirstTimestamp()])),
			};
		} finally {
			stopCapturing();
			Logging.level = previousLogLevel;
		}
	};

	// Never sent: the file gets scanned for it in large chunks, instead of packet by packet (tens of thousands of
	// reads). The whole file was scanned, so nothing was left out that's in it, and there's no warning.
	const absent = buildFile(null);
	const absentResult = await getTracks(absent);
	expect(absentResult.tracks).toEqual([[0x100, 0]]);
	expect(absentResult.readCount).toBeLessThan(2000);
	expect(absentResult.warnings).toEqual([]);

	const late = buildFile([8400, Infinity]); // 179.2 s
	expect(await getTracks(late)).toMatchObject({ tracks: [[0x100, 0], [0x101, 179.2]], warnings: [] });

	// Only there for a moment, between spots a sampling approach would look at
	const brief = buildFile([2850, 3085]); // 60.8 s to 65.8 s
	expect(await getTracks(brief)).toMatchObject({ tracks: [[0x100, 0], [0x101, 60.8]], warnings: [] });

	// When the search gives up before the end of the file (it scans 256 MiB, here less), a stream that starts later
	// is left out, with a warning
	const limited = await getTracks(late, { maxMissingStreamScanSize: 2 ** 20 });
	expect(limited.tracks).toEqual([[0x100, 0]]);
	expect(limited.bytesRead).toBeLessThan(late.byteLength / 3);
	expect(limited.warnings).toEqual([expect.stringContaining('within 1 MiB of the file')]);
	expect(limited.warnings[0]).toContain('PID 257 (stream_type 0x0f)');

	// The same for sources of unknown size, where the search gives up after 2 minutes of media
	const unknownSize = await getTracks(late, { unknownSize: true });
	expect(unknownSize.tracks).toEqual([[0x100, 0]]);
	expect(unknownSize.warnings).toEqual([expect.stringContaining('within the first 120 seconds of media')]);
	expect(unknownSize.warnings[0]).toContain('PID 257 (stream_type 0x0f)');
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

	// Some muxers write the language code in upper case
	const upperCase = buffer.slice();
	for (let i = 0; i < upperCase.length - descriptor.length; i++) {
		if (descriptor.every((byte, j) => upperCase[i + j] === byte)) {
			upperCase.set([0x45, 0x4e, 0x47], i + 2); // 'ENG'
		}
	}

	using upperCaseInput = new Input({
		source: new BufferSource(upperCase),
		formats: ALL_FORMATS,
	});
	expect(await (await upperCaseInput.getPrimaryAudioTrack())!.getLanguageCode()).toBe('eng');
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

	const packetCounts: number[] = [];
	const movedElements = await countMovedArrayElements(async () => {
		for (const track of tracks) {
			const sink = new EncodedPacketSink(track);
			let packetCount = 0;
			for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
				void packet;
				packetCount++;
			}
			packetCounts.push(packetCount);
		}
	});

	expect(packetCounts[0]).toBeGreaterThan(count - 2);
	expect(packetCounts[1]).toBeGreaterThan(count - 2);
	// Linear: no per-packet array copies (main moved ~4e9 elements)
	expect(movedElements).toBeLessThan(2 * count);
});

test('MPEG-TS uses an intact copy of a damaged PAT or PMT', async () => {
	// FFmpeg output, which repeats the PAT and PMT (PID 0x1000) several times per second, like broadcasts do
	const bytes = new Uint8Array(await fs.promises.readFile(path.join(__dirname, '../public/mp3.ts')));
	const findFirstSection = (pid: number) => {
		for (let pos = 0; pos < bytes.length; pos += 188) {
			if (((bytes[pos + 1]! & 0x1f) << 8 | bytes[pos + 2]!) === pid && bytes[pos + 1]! & 0x40) {
				return pos + 4 + 1 + bytes[pos + 4]!; // Skip the header and pointer_field
			}
		}

		throw new Error('Section not found');
	};

	const readTracks = async (data: Uint8Array) => {
		using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
		return Promise.all((await input.getTracks()).map(track => track.getCodec()));
	};

	// A bit error in the first PAT turns its program into the network PID entry
	const damagedPat = bytes.slice();
	damagedPat[findFirstSection(0) + 9] = 0x00; // program_number 1 -> 0
	expect(await readTracks(damagedPat)).toEqual(['mp3']);

	// A bit error in the first PMT changes the stream type
	const damagedPmt = bytes.slice();
	damagedPmt[findFirstSection(0x1000) + 12] = 0x13; // stream_type 0x03 (MPEG-1 audio) -> 0x13
	expect(await readTracks(damagedPmt)).toEqual(['mp3']);

	// A bit error in the first PAT's pointer_field, so its section (and table_id) is looked for in the wrong place
	const damagedPointerField = bytes.slice();
	damagedPointerField[findFirstSection(0) - 1]! ^= 0x80; // pointer_field 0 -> 128
	expect(await readTracks(damagedPointerField)).toEqual(['mp3']);

	// Some muxers write bad CRCs throughout, so without an intact copy, the damaged one is still used
	const allBad = bytes.slice();
	for (let pos = 0; pos < allBad.length; pos += 188) {
		const pid = (allBad[pos + 1]! & 0x1f) << 8 | allBad[pos + 2]!;
		if ((pid === 0 || pid === 0x1000) && allBad[pos + 1]! & 0x40) {
			const sectionStart = pos + 4 + 1 + allBad[pos + 4]!;
			const sectionEnd = sectionStart + 3 + ((allBad[sectionStart + 1]! & 0x0f) << 8 | allBad[sectionStart + 2]!);
			allBad.fill(0, sectionEnd - 4, sectionEnd); // CRC_32
		}
	}
	expect(await readTracks(allBad)).toEqual(['mp3']);

	// With a single damaged copy of each, the search for an intact one stops after a few seconds of media rather than
	// reading the whole file
	const singleBad = allBad.slice();
	let tableCount = 0;
	for (let pos = 0; pos < singleBad.length; pos += 188) {
		const pid = (singleBad[pos + 1]! & 0x1f) << 8 | singleBad[pos + 2]!;
		if ((pid === 0 || pid === 0x1000) && ++tableCount > 2) {
			singleBad.set([0x1f, 0xff], pos + 1); // Turn into a null packet
		}
	}

	let maxEnd = 0;
	using input = new Input({
		source: new CustomSource({
			getSize: () => singleBad.byteLength,
			read: (start, end) => {
				maxEnd = Math.max(maxEnd, end);
				return singleBad.subarray(start, end);
			},
		}),
		formats: ALL_FORMATS,
	});
	expect(await Promise.all((await input.getTracks()).map(track => track.getCodec()))).toEqual(['mp3']);
	expect(maxEnd).toBeLessThan(singleBad.byteLength / 2);
});
