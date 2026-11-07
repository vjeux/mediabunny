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

test('MPEG-TS finds audio frames in PES packets that start inside a frame', async () => {
	// Found by L80. Audio PES packets needn't be aligned to frames (data_alignment_indicator 0), so a PES packet can
	// begin with the tail of a frame, and the frame sync search that a lookup starts there locks onto any bytes in it
	// that look like a frame header. Here, MP3 frames of 104 bytes (MPEG-1 Layer III, 32 kbit/s, 44.1 kHz, stereo) in
	// PES packets of 150 bytes, each stamped with the PTS of the first frame starting in it (H.222.0), with a fake
	// header in each leftover.
	const frameSize = 104;
	const frameCount = 24;
	const frames = new Uint8Array(frameSize * frameCount);
	for (let i = 0; i < frameCount; i++) {
		frames.set([0xff, 0xfb, 0x10, 0x00], i * frameSize);
	}
	for (let start = 150; start < frames.length; start += 150) {
		const frameEnd = Math.ceil(start / frameSize) * frameSize;
		if (frameEnd - start >= 8) {
			frames.set([0xff, 0xf6, 0xd4, 0xed], start + 2); // A fake header (24 kHz, mono) in the leftover
		}
	}

	// The stream, from `skip` bytes into the frames on
	const buildFile = (skip: number, data = frames, streamType = 0x03, ticksPerFrame = 1152 * 90_000 / 44_100) => {
		const packets: Uint8Array[] = [];
		const pushPackets = (pid: number, payload: number[]) => {
			for (let i = 0; i < payload.length; i += 184) {
				const chunk = payload.slice(i, i + 184);
				const packet = new Uint8Array(188);
				const stuffing = 184 - chunk.length;
				packet.set([0x47, (i === 0 ? 0x40 : 0) | (pid >> 8), pid & 0xff, stuffing ? 0x30 : 0x10], 0);
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
			0x00, 0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00,
			streamType, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0,
		]);
		for (let start = skip; start < data.length; start += 150) {
			const pts = Math.round(Math.ceil(start / frameSize) * ticksPerFrame);
			const payload = [...data.subarray(start, start + 150)];
			pushPackets(0x100, [
				0, 0, 1, 0xc0, (payload.length + 8) >> 8, (payload.length + 8) & 0xff, 0x84, 0x80, 5,
				0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff, ((pts >> 14) & 0xfe) | 1, (pts >> 7) & 0xff,
				((pts << 1) & 0xfe) | 1, ...payload,
			]);
		}

		const bytes = new Uint8Array(188 * packets.length);
		packets.forEach((packet, i) => bytes.set(packet, 188 * i));
		return bytes;
	};

	const readAll = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: [MPEG_TS] });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const packets: [number, number][] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push([packet.timestamp, packet.byteLength]);
		}
		return {
			sampleRate: await track.getSampleRate(),
			numberOfChannels: await track.getNumberOfChannels(),
			packets,
		};
	};

	// Every frame's own timestamp finds it, as sequential reading does
	const bytes = buildFile(0);
	const { packets } = await readAll(bytes);
	expect(packets).toHaveLength(frameCount);
	for (const [timestamp, byteLength] of packets) {
		// A fresh input, so that the lookup can't use reading state from before
		using input = new Input({ source: new BufferSource(bytes), formats: [MPEG_TS] });
		const packet = await new EncodedPacketSink((await input.getPrimaryAudioTrack())!).getPacket(timestamp);
		expect([packet?.timestamp, packet?.byteLength]).toEqual([timestamp, byteLength]);
	}

	// A stream whose first PES packet begins with the tail of a frame, with a fake header in it, must not take its
	// sample rate and channel count from that header
	frames.set([0xff, 0xf6, 0xd4, 0xed], 56);
	const lateStart = await readAll(buildFile(52));
	expect(lateStart.sampleRate).toBe(44100);
	expect(lateStart.numberOfChannels).toBe(2);
	expect(lateStart.packets.map(x => x[1])).toEqual(Array<number>(frameCount - 1).fill(frameSize));

	// The same with AAC (ADTS frames of 104 bytes, 48 kHz stereo), with header-like runs in the tail: one with a CRC
	// whose aac_frame_length (8) is less than its own header (9 bytes), followed by one 8 bytes later
	const aacFrames = new Uint8Array(frameSize * frameCount);
	for (let i = 0; i < frameCount; i++) {
		const header = [0xff, 0xf1, 0x4c, 0x80, (frameSize >> 3) & 0xff, ((frameSize & 7) << 5) | 0x1f, 0xfc];
		aacFrames.set(header, i * frameSize);
	}
	aacFrames.set([0xff, 0xf0, 0x4c, 0x80, 0x01, 0x00, 0x00], 60);
	aacFrames.set([0xff, 0xf1, 0x4c, 0x80, 0x01, 0x00, 0x00], 68);
	const aacLateStart = await readAll(buildFile(52, aacFrames, 0x0f, 1024 * 90_000 / 48_000));
	expect(aacLateStart.sampleRate).toBe(48000);
	expect(aacLateStart.packets.map(x => x[1])).toEqual(Array<number>(frameCount - 1).fill(frameSize));
});

test('MPEG-TS drops an audio frame cut off by the end of the file or a lost TS packet', async () => {
	// Found by L80. A recording that stopped mid-write ends inside an audio frame, which doesn't decode (WebCodecs
	// then fails the whole run); the ADTS and MP3 demuxers drop such a frame too. And a capture that lost a TS packet
	// (a UDP datagram) inside an audio frame made that frame swallow the start of the next one. 30 AAC frames of 400
	// bytes, then the same without the last TS packet, or without one in the middle of the 10th frame. Each packet
	// must hold the whole frame its header announces.
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();
	for (let i = 0; i < 30; i++) {
		await source.add(
			new EncodedPacket(new Uint8Array(400).fill(0x11), 'key', i * 1024 / 48000, 1024 / 48000),
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

	const readFrames = async (data: Uint8Array) => {
		using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
		const result: { byteLength: number; frameLength: number; intact: boolean }[] = [];
		for await (const packet of new EncodedPacketSink((await input.getPrimaryAudioTrack())!).packets()) {
			const d = packet.data;
			const frameLength = ((d[3]! & 0x03) << 11) | (d[4]! << 3) | (d[5]! >> 5); // aac_frame_length
			result.push({ byteLength: d.byteLength, frameLength, intact: d.subarray(7).every(x => x === 0x11) });
		}
		return result;
	};

	const complete = await readFrames(bytes);
	expect(complete).toHaveLength(30);
	expect(complete.every(x => x.byteLength === x.frameLength)).toBe(true);

	const truncated = await readFrames(bytes.subarray(0, bytes.length - 188));
	expect(truncated).toHaveLength(29);
	expect(truncated.every(x => x.byteLength === x.frameLength && x.intact)).toBe(true);

	const damaged = await readFrames(new Uint8Array([...bytes.subarray(0, 30 * 188), ...bytes.subarray(31 * 188)]));
	expect(damaged).toHaveLength(29);
	expect(damaged.every(x => x.byteLength === x.frameLength && x.intact)).toBe(true);
});

test('MPEG-TS keeps the frames around an audio sample rate change', async () => {
	// From L46's review: the frame sync takes a frame header only if another header follows the frame, which at a
	// sample rate change has the other rate. MPEG-1 Layer III frames at 128 kbit/s with empty payloads, 384 bytes at
	// 48 kHz and 417 bytes at 44.1 kHz: 10 at 48 kHz, 10 at 44.1 kHz and 10 at 48 kHz, like a broadcast switching
	// programs, then the same ending at 44.1 kHz.
	const mp3Frame = (sampleRate: number) => {
		const frame = new Uint8Array(sampleRate === 48000 ? 384 : 417);
		frame.set([0xff, 0xfb, sampleRate === 48000 ? 0x94 : 0x90, 0x00]);
		return frame;
	};

	for (const rates of [
		[...Array<number>(10).fill(48000), ...Array<number>(10).fill(44100), ...Array<number>(10).fill(48000)],
		[...Array<number>(10).fill(48000), ...Array<number>(10).fill(44100)],
	]) {
		const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('mp3');
		output.addAudioTrack(source);
		await output.start();
		let timestamp = 0;
		for (const [i, rate] of rates.entries()) {
			await source.add(
				new EncodedPacket(mp3Frame(rate), 'key', timestamp, 1152 / rate),
				i === 0 ? { decoderConfig: { codec: 'mp3', sampleRate: 48000, numberOfChannels: 2 } } : undefined,
			);
			timestamp += 1152 / rate;
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const sizes: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			sizes.push(packet.byteLength);
		}
		expect(sizes).toEqual(rates.map(rate => (rate === 48000 ? 384 : 417)));
	}
});

test('MPEG-TS lookups at the end of a track whose last audio frame is cut off', async () => {
	// From L15's and L46's reviews. With the cut frame dropped, getPacket(Infinity) must still find the last complete
	// frame, with its duration, and computeDuration() must end where it does: 30 MPEG-1 Layer III frames (128 kbit/s,
	// 48 kHz: 384 bytes each, empty payload) in PES packets of 184 bytes, so that frames span PES packets
	const packets: number[][] = [];
	let continuityCounter = 0;
	const psi = (pid: number, section: number[]) => {
		let crc = 0xffffffff;
		for (const byte of section) {
			crc ^= byte << 24;
			for (let i = 0; i < 8; i++) {
				crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
			}
		}
		const packet = [0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, 0, ...section];
		packet.push(crc >>> 24, (crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff);
		return [...packet, ...new Array<number>(188 - packet.length).fill(0xff)];
	};
	packets.push(psi(0, [0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00]));
	packets.push(psi(0x1000, [
		0x02, 0xb0, 18, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x03, 0xe1, 0x00, 0xf0, 0x00,
	]));

	const frame = [0xff, 0xfb, 0x94, 0x00, ...new Array<number>(380).fill(0)];
	const es = Array.from({ length: 30 }, () => frame).flat();
	for (let offset = 0; offset < es.length; offset += 184) {
		const data = es.slice(offset, offset + 184);
		const frameIndex = Math.ceil(offset / 384);
		const hasFrameStart = frameIndex * 384 < offset + data.length;
		const pts = 126000 + frameIndex * 2160;
		const header = hasFrameStart
			? [0, 0, 1, 0xc0, (data.length + 8) >> 8, (data.length + 8) & 0xff, 0x80, 0x80, 5,
					0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff, ((pts >> 14) & 0xfe) | 1, (pts >> 7) & 0xff,
					((pts << 1) & 0xfe) | 1]
			: [0, 0, 1, 0xc0, (data.length + 3) >> 8, (data.length + 3) & 0xff, 0x80, 0, 0];
		let pes = [...header, ...data];
		let first = true;
		while (pes.length > 0) {
			const payloadUnitStart = first ? 0x40 : 0;
			if (pes.length >= 184) {
				packets.push([0x47, payloadUnitStart | 0x01, 0x00, 0x10 | continuityCounter, ...pes.slice(0, 184)]);
				pes = pes.slice(184);
			} else {
				const stuffing = 183 - pes.length;
				const adaptationField = stuffing > 0
					? [stuffing, 0, ...new Array<number>(stuffing - 1).fill(0xff)]
					: [0];
				packets.push(
					[0x47, payloadUnitStart | 0x01, 0x00, 0x30 | continuityCounter, ...adaptationField, ...pes],
				);
				pes = [];
			}
			continuityCounter = (continuityCounter + 1) & 0xf;
			first = false;
		}
	}
	const cut = new Uint8Array(packets.slice(0, -1).flat()); // The last frame loses its end

	using iterationInput = new Input({ source: new BufferSource(cut), formats: ALL_FORMATS });
	const iterationTrack = await iterationInput.getPrimaryAudioTrack();
	assert(iterationTrack);
	const iterated: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(iterationTrack).packets()) {
		iterated.push(packet);
	}
	expect(iterated).toHaveLength(29);
	const lastIterated = iterated.at(-1)!;

	using input = new Input({ source: new BufferSource(cut), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const lastPacket = await new EncodedPacketSink(track).getPacket(Infinity);
	expect(lastPacket?.timestamp).toBe(lastIterated.timestamp);
	expect(lastPacket?.duration).toBe(0.024);
	expect(lastIterated.duration).toBe(0.024);

	using durationInput = new Input({ source: new BufferSource(cut), formats: ALL_FORMATS });
	expect(await durationInput.computeDuration()).toBe(lastIterated.timestamp + 0.024);
});
