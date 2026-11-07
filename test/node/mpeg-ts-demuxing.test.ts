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
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';

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

test('MPEG-TS drops the video frame that the end of the file cuts off', async () => {
	// From L80's review. A recording stopped mid-write or a partial download ends inside a frame, which fails decoding
	// (with WebCodecs at the final flush: "EncodingError: Error during flush.", which ends the whole run). Unbounded
	// PES packets don't say how long they are, and muxers end each one with stuffing in its last TS packet, unless its
	// data fills it exactly. So a frame without that stuffing is only dropped in a file that ends inside a TS packet.
	// 20 frames of a 64x64 x264 stream (SPS and PPS, then stub slices of 600 bytes, so each frame spans several TS
	// packets).
	const sps = [0x67, 0x64, 0x00, 0x0a, 0xac, 0xd3, 0x10, 0x9b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00,
		0x03, 0x03, 0x20, 0xf1, 0x22, 0x53, 0x80];
	const pps = [0x68, 0xef, 0x8f, 0xcb];
	const nalUnit = (bytes: number[]) => [0, 0, 0, 1, ...bytes];

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, { frameRate: 25 });
	await output.start();
	for (let i = 0; i < 20; i++) {
		const slice = nalUnit([i === 0 ? 0x65 : 0x41, 0x88, ...new Array<number>(600).fill(0x20 + i)]);
		await source.add(
			new EncodedPacket(
				new Uint8Array(i === 0 ? [...nalUnit(sps), ...nalUnit(pps), ...slice] : slice),
				i === 0 ? 'key' : 'delta',
				i / 25,
				1 / 25,
			),
			i === 0 ? { decoderConfig: { codec: 'avc1.64000a', codedWidth: 64, codedHeight: 64 } } : undefined,
		);
	}
	await output.finalize();
	const bytes = new Uint8Array(output.target.buffer!);

	const readFrames = async (data: Uint8Array) => {
		using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const frames: Uint8Array[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			frames.push(packet.data);
		}
		return frames;
	};

	const clean = await readFrames(bytes);
	expect(clean).toHaveLength(20); // Complete PES packets end with stuffing

	// Cut the file inside a TS packet, two TS packets into the last frame's PES packet: that frame goes. Cut at the TS
	// packet boundary there instead, nothing tells it from a complete frame without stuffing, so it stays, as before.
	const isVideoStart = (pos: number) => !!(bytes[pos + 1]! & 0x40)
		&& (((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!) === 0x100;
	let lastPesStart = bytes.length - 188;
	while (!isVideoStart(lastPesStart)) {
		lastPesStart -= 188;
	}
	expect(await readFrames(bytes.subarray(0, lastPesStart + 2 * 188 + 100))).toEqual(clean.slice(0, 19));
	const cutAtBoundary = await readFrames(bytes.subarray(0, lastPesStart + 2 * 188));
	expect(cutAtBoundary.slice(0, 19)).toEqual(clean.slice(0, 19));
	expect(cutAtBoundary).toHaveLength(20);

	// When the file ends inside the first frame, the track still opens: its SPS and PPS are there
	let firstPesStart = 0;
	while (!isVideoStart(firstPesStart)) {
		firstPesStart += 188;
	}
	expect(await readFrames(bytes.subarray(0, firstPesStart + 2 * 188 + 100))).toEqual([]);
});

test('MPEG-TS keeps the last video frame when its PES packet fills its last TS packet exactly', async () => {
	// A PES packet whose data fills its last TS packet exactly ends without stuffing, which Mediabunny's own output
	// does about once in 184 files (found by L15: 4 frames of an FFmpeg test clip converted to MPEG-TS read back as 3).
	// In a file that ends there, on a TS packet boundary, that's a complete frame. H.264 and HEVC streams of stub
	// frames, alone or with AAC, whose last frame has the size that makes this happen.
	const nalUnit = (bytes: number[]) => [0, 0, 0, 1, ...bytes];
	const hex = (text: string) => [...text.matchAll(/../g)].map(x => parseInt(x[0], 16));
	const avcParameterSets = [
		...nalUnit(hex('6764000aacd3109b011000000300100000030320f1225380')),
		...nalUnit(hex('68ef8fcb')),
	];
	// Those of test/public/hevc.ts
	const hevcParameterSets = [
		...nalUnit(hex('40010c01ffff016000000300900000030000030078959809')),
		...nalUnit(hex('420101016000000300900000030000030078a003c08010e596566924cae6a0202036c20000030002000003003010')),
		...nalUnit(hex('4401c172b46240')),
	];
	const aacConfig = {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		description: new Uint8Array([0x11, 0x90]),
	};

	const mux = async (codec: 'avc' | 'hevc', withAudio: boolean, lastFrameSize: number) => {
		const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
		const video = new EncodedVideoPacketSource(codec);
		output.addVideoTrack(video, { frameRate: 25 });
		const audio = new EncodedAudioPacketSource('aac');
		if (withAudio) {
			output.addAudioTrack(audio);
		}
		await output.start();

		for (let i = 0; i < 10; i++) {
			const size = i === 9 ? lastFrameSize : 400;
			const header = codec === 'avc'
				? [i === 0 ? 0x65 : 0x41, 0x88]
				: [i === 0 ? 0x26 : 0x02, 0x01, 0x80];
			const frame = nalUnit([...header, ...new Array<number>(size).fill(0x20 + i)]);
			await video.add(
				new EncodedPacket(
					new Uint8Array(i === 0
						? [...(codec === 'avc' ? avcParameterSets : hevcParameterSets), ...frame]
						: frame),
					i === 0 ? 'key' : 'delta',
					i / 25,
					1 / 25,
				),
				i === 0
					? {
							decoderConfig: codec === 'avc'
								? { codec: 'avc1.64000a', codedWidth: 64, codedHeight: 64 }
								: { codec: 'hev1.1.6.L120.90', codedWidth: 1920, codedHeight: 1080 },
						}
					: undefined,
			);

			if (withAudio) {
				// Raw AAC frames of 48 kHz stereo, two per video frame
				for (let j = 0; j < 2; j++) {
					const timestamp = (2 * i + j) * 1024 / 48000;
					await audio.add(
						new EncodedPacket(new Uint8Array(100).fill(0x10 + j), 'key', timestamp, 1024 / 48000),
						i === 0 && j === 0 ? { decoderConfig: aacConfig } : undefined,
					);
				}
			}
		}
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	// Whether the video's last TS packet carries payload only (no adaptation field, so no stuffing). The video PID is
	// the one whose PES packets have stream_id 0xe0.
	const lastVideoPacketIsFull = (bytes: Uint8Array) => {
		const pidAt = (pos: number) => ((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!;
		let videoPid = -1;
		for (let pos = 0; pos < bytes.length && videoPid === -1; pos += 188) {
			const payloadPos = pos + 4 + (bytes[pos + 3]! & 0x20 ? 1 + bytes[pos + 4]! : 0);
			if (bytes[pos + 1]! & 0x40 && bytes[payloadPos] === 0 && bytes[payloadPos + 1] === 0
				&& bytes[payloadPos + 2] === 1 && bytes[payloadPos + 3] === 0xe0) {
				videoPid = pidAt(pos);
			}
		}

		for (let pos = bytes.length - 188; pos >= 0; pos -= 188) {
			if (pidAt(pos) === videoPid) {
				return ((bytes[pos + 3]! >> 4) & 0b11) === 0b01;
			}
		}
		return false;
	};

	for (const [codec, withAudio] of [['avc', false], ['avc', true], ['hevc', false], ['hevc', true]] as const) {
		let bytes: Uint8Array | null = null;
		for (let size = 400; size < 400 + 188 && !bytes; size++) {
			const candidate = await mux(codec, withAudio, size);
			if (lastVideoPacketIsFull(candidate)) {
				bytes = candidate;
			}
		}
		assert(bytes);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			timestamps.push(Math.round(packet.timestamp * 25));
		}
		expect(timestamps).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	}
});
