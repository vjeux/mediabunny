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
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';

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

test('MPEG-TS reads AAC declared as private data without descriptors, as FFmpeg\'s m2ts mode writes it', async () => {
	// Made with FFmpeg 8.0.3, which writes the AAC as stream_type 0x06 without any descriptor in .m2ts files:
	// ffmpeg -f lavfi -i testsrc2=size=160x120:rate=25:duration=1
	//   -f lavfi -i sine=frequency=440:sample_rate=48000:duration=1
	//   -c:v libx264 -preset ultrafast -c:a aac -b:a 32k aac-private-data.m2ts
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/aac-private-data.m2ts')),
		formats: ALL_FORMATS,
	});

	expect(await input.getVideoTracks()).toHaveLength(1);
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getCodec()).toBe('aac');
	expect(await track.getSampleRate()).toBe(48000);
	expect(await track.getNumberOfChannels()).toBe(1);

	let count = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		expect(packet.byteLength).toBeGreaterThan(0);
		count++;
	}
	expect(count).toBe(48); // As ffprobe counts
});

test('MPEG-TS tells the audio codec of a private data stream without descriptors from its payload', async () => {
	// 30 AAC frames (48 kHz stereo) with stub payloads
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();
	for (let i = 0; i < 30; i++) {
		await source.add(
			new EncodedPacket(new Uint8Array(100).fill(0x11), 'key', i * 1024 / 48000, 1024 / 48000),
			i === 0
				? {
						decoderConfig: {
							codec: 'mp4a.40.2',
							numberOfChannels: 2,
							sampleRate: 48000,
							description: new Uint8Array([0x11, 0x90]),
						},
					}
				: undefined,
		);
	}
	await output.finalize();
	const bytes = new Uint8Array(output.target.buffer!);

	const crc32 = (data: Uint8Array) => {
		let crc = 0xffffffff;
		for (const byte of data) {
			crc ^= byte << 24;
			for (let k = 0; k < 8; k++) {
				crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
			}
		}
		return crc >>> 0;
	};

	// Turns the PMT's stream_type for the AAC (0x0f) into private data (0x06), like FFmpeg's m2ts mode writes it
	const declareAsPrivateData = (data: Uint8Array) => {
		const copy = data.slice();
		for (let pos = 0; pos < copy.length; pos += 188) {
			const section = copy.subarray(pos + 5 + copy[pos + 4]!); // After the pointer field
			if (!(copy[pos + 1]! & 0x40) || section[0] !== 0x02) {
				continue;
			}

			const sectionLength = ((section[1]! & 0x0f) << 8) | section[2]!;
			const programInfoLength = ((section[10]! & 0x0f) << 8) | section[11]!;
			const streamTypePos = 12 + programInfoLength;
			expect(section[streamTypePos]).toBe(0x0f);
			section[streamTypePos] = 0x06;
			const crcPos = 3 + sectionLength - 4;
			new DataView(section.buffer, section.byteOffset).setUint32(crcPos, crc32(section.subarray(0, crcPos)));
		}
		return copy;
	};

	const readAudio = async (data: Uint8Array) => {
		using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		if (!track) {
			return { codec: null, count: 0 };
		}

		let count = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			count += packet.byteLength > 0 ? 1 : 0;
		}
		return { codec: await track.getCodec(), count };
	};

	expect(await readAudio(bytes)).toEqual({ codec: 'aac', count: 30 });
	const privateData = declareAsPrivateData(bytes);
	expect(await readAudio(privateData)).toEqual({ codec: 'aac', count: 30 });

	// A payload that isn't audio we know leaves the stream out, as before
	for (let pos = 0; pos < privateData.length; pos += 188) {
		const pesStart = pos + 4 + (privateData[pos + 3]! & 0x20 ? 1 + privateData[pos + 4]! : 0);
		if (privateData[pos + 1]! & 0x40 && privateData[pesStart + 3] === 0xc0) {
			privateData[pesStart + 9 + privateData[pesStart + 8]!] = 0x00; // The first frame's sync word
			break;
		}
	}
	expect(await readAudio(privateData)).toEqual({ codec: null, count: 0 });
});

test('MPEG-TS gives up on private data streams without descriptors that hold no audio', async () => {
	// From L46's review. mp3.ts (one MP3 stream) with extra stream_type 0x06 entries in its PMT, without descriptors
	const crc32 = (data: Uint8Array) => {
		let crc = 0xffffffff;
		for (const byte of data) {
			crc ^= byte << 24;
			for (let k = 0; k < 8; k++) {
				crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
			}
		}
		return crc >>> 0;
	};
	const withPrivateStreams = (
		extraPids: number[],
		extraPackets: Uint8Array[],
		nullPacketCount: number,
		bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, '../public/mp3.ts'))),
	) => {
		const pidAt = (pos: number) => ((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!;
		const packets: Uint8Array[] = [];
		let pmtPid = -1;
		let patched = false;
		for (let pos = 0; pos + 188 <= bytes.length; pos += 188) {
			const packet = bytes.slice(pos, pos + 188);
			const sectionStart = 5 + packet[4]!;
			if (pidAt(pos) === 0 && pmtPid === -1) {
				pmtPid = ((packet[sectionStart + 10]! & 0x1f) << 8) | packet[sectionStart + 11]!;
			} else if (pidAt(pos) === pmtPid && packet[1]! & 0x40 && !patched) {
				const sectionLength = ((packet[sectionStart + 1]! & 0x0f) << 8) | packet[sectionStart + 2]!;
				const body = [...packet.subarray(sectionStart + 3, sectionStart + 3 + sectionLength - 4)];
				for (const pid of extraPids) {
					body.push(0x06, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0x00);
				}
				const newLength = body.length + 4;
				const section = [packet[sectionStart]!, 0xb0 | (newLength >> 8), newLength & 0xff, ...body];
				const crc = crc32(new Uint8Array(section));
				section.push(crc >>> 24, (crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff);
				packet.fill(0xff, sectionStart);
				packet.set(section, sectionStart);
				patched = true;
				packets.push(packet, ...extraPackets);
				continue;
			}
			packets.push(packet);
		}

		const nullPacket = new Uint8Array(188).fill(0xff);
		nullPacket.set([0x47, 0x1f, 0xff, 0x10]);
		for (let i = 0; i < nullPacketCount; i++) {
			packets.push(nullPacket);
		}

		const file = new Uint8Array(188 * packets.length);
		packets.forEach((packet, i) => file.set(packet, 188 * i));
		return file;
	};
	const open = (file: Uint8Array) => {
		const counter = { bytes: 0 };
		const input = new Input({
			source: new CustomSource({
				getSize: () => file.byteLength,
				read: (start, end) => {
					counter.bytes += end - start;
					return file.subarray(start, end);
				},
			}),
			formats: ALL_FORMATS,
		});
		return { input, counter };
	};

	// A stream that never carries a PES packet doesn't make the metadata scan read the whole file (16 MiB of null
	// packets after the content)
	const withEmptyStream = open(withPrivateStreams([0x1ff0], [], 16 * 2 ** 20 / 188));
	expect(await withEmptyStream.input.getTracks()).toHaveLength(1);
	expect(withEmptyStream.counter.bytes).toBeLessThan(8 * 2 ** 20); // 4 MiB past the MP3 stream's setup
	withEmptyStream.input.dispose();

	// Nor does it make a sequential source that keeps only what its cache holds (a ReadableStreamSource) read so far
	// ahead that the other streams' start is gone (found in L15's streamed check): such sources look 1 MiB ahead. 6 MB
	// of H.264 frames of 60 kB, written by Mediabunny, with such a stream added, read through a 2 MiB cache.
	const nalUnit = (bytes: number[]) => [0, 0, 0, 1, ...bytes];
	const sps = [0x67, 0x64, 0x00, 0x0a, 0xac, 0xd3, 0x10, 0x9b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00,
		0x03, 0x03, 0x20, 0xf1, 0x22, 0x53, 0x80];
	const pps = [0x68, 0xef, 0x8f, 0xcb];
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource, { frameRate: 25 });
	await output.start();
	for (let i = 0; i < 100; i++) {
		const isKey = i % 25 === 0;
		const slice = nalUnit([isKey ? 0x65 : 0x41, 0x88, ...new Array<number>(60_000).fill(0x20 + i % 50)]);
		await videoSource.add(
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
	const streamedFile = withPrivateStreams([0x1ff0], [], 0, new Uint8Array(output.target.buffer!));
	let position = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull: (controller) => {
			if (position >= streamedFile.length) {
				controller.close();
				return;
			}

			controller.enqueue(streamedFile.slice(position, position + 65536));
			position += 65536;
		},
	});
	{
		using streamedInput = new Input({
			source: new ReadableStreamSource(stream, { maxCacheSize: 2 ** 21 }),
			formats: ALL_FORMATS,
		});
		const streamedTracks = await streamedInput.getTracks();
		expect(streamedTracks.map(track => track.type)).toEqual(['video']);
		let packetCount = 0;
		for await (const packet of new EncodedPacketSink(streamedTracks[0]!).packets()) {
			expect(packet.byteLength).toBeGreaterThan(60_000);
			packetCount++;
		}
		expect(packetCount).toBe(100);
	}

	// A stream whose first PES packet merely starts with an ADTS-like header, followed by random data, stays out
	let seed = 1;
	const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
	const fakePesPacket = (counter: number, isStart: boolean) => {
		const packet = new Uint8Array(188);
		packet.set([0x47, (isStart ? 0x40 : 0) | 0x1f, 0xf1, 0x10 | counter]);
		let pos = 4;
		if (isStart) {
			const pesHeader = [0, 0, 1, 0xc0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1];
			packet.set([...pesHeader, 0xff, 0xf1, 0x4c, 0x80, 0x2e, 0x7f, 0xfc], 4); // Then an ADTS header
			pos = 25;
		}
		for (; pos < 188; pos++) {
			packet[pos] = random();
		}
		return packet;
	};
	const withFakeAudio = open(withPrivateStreams(
		[0x1ff1],
		[fakePesPacket(0, true), fakePesPacket(1, false), fakePesPacket(2, true), fakePesPacket(3, false)],
		0,
	));
	const tracks = await withFakeAudio.input.getTracks();
	expect(tracks).toHaveLength(1);
	for await (const packet of new EncodedPacketSink(tracks[0]!).packets()) {
		expect(packet.byteLength).toBeGreaterThan(0);
	}
	withFakeAudio.input.dispose();
});
