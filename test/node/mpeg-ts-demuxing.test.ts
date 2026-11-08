import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource, ReadableStreamSource, CustomSource } from '../../src/source.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
import { Mp4OutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { countMovedArrayElements } from './array-moves.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { InputTrack } from '../../src/input-track.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('MPEG-TS input format', async () => {
	expect(MPEG_TS.mimeType).toBe('video/mp2t');
	expect(MPEG_TS.name).toBe('MPEG Transport Stream');
});

test('MPEG-TS metadata reading', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MPEG_TS);
	expect((await input.getFormat()).mimeType).toBe('video/mp2t');
	expect(await input.getMimeType()).toBe('video/mp2t; codecs="avc1.640020, mp4a.40.2"');

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

test('MPEG-TS AVC with an unreferenced SPS in front of the active one', async () => {
	// The first access unit carries an extra SPS (id 1, 64x64) before the SPS its PPS and slices use (id 0, 130x98).
	// Like FFmpeg's h264_parser, the track's properties must come from the SPS the first slice refers to. Made with:
	// ffmpeg -f lavfi -i testsrc2=s=64x64 -frames:v 1 -c:v libx264 -x264-params sps-id=1 \
	//   -bsf:v filter_units=pass_types=7 -f h264 sps-id1.h264
	// ffmpeg -f lavfi -i testsrc2=s=130x98:r=25 -frames:v 3 -c:v libx264 -bf 0 -f h264 main.h264
	// cat sps-id1.h264 main.h264 | ffmpeg -fflags +genpts -r 25 -f h264 -i - -c copy avc-unused-sps.ts
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/avc-unused-sps.ts')),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;

	expect(await track.getCodedWidth()).toBe(130);
	expect(await track.getCodedHeight()).toBe(98);
	expect(await track.getDisplayWidth()).toBe(130);
	expect((await track.getDecoderConfig())!.codec).toBe('avc1.64000b');
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

test('MPEG-TS HEVC with an unreferenced SPS in front of the active one', async () => {
	// The first access unit of a 320x240 x265 stream carries an extra SPS (sps_seq_parameter_set_id 1, 160x96, taken
	// from another x265 stream) before the SPS its PPS and slices use (id 0). Like FFmpeg, the track's properties must
	// come from the SPS the first slice refers to. Made with:
	// ffmpeg -f lavfi -i testsrc2=s=320x240:r=25:d=0.2 -pix_fmt yuv420p -c:v libx265 -x265-params keyint=5:bframes=0 \
	//   -f hevc real.hevc
	// ffmpeg -f lavfi -i testsrc2=s=160x96:r=25:d=0.2 -pix_fmt yuv420p -c:v libx265 -f hevc donor.hevc
	// then the donor's SPS, with its sps_seq_parameter_set_id rewritten to 1, inserted in front of real.hevc's SPS, and
	// ffmpeg -fflags +genpts -r 25 -i hevc-unused-sps.hevc -c copy hevc-unused-sps.ts
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/hevc-unused-sps.ts')),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;

	expect(await track.getDisplayWidth()).toBe(320);
	expect(await track.getDisplayHeight()).toBe(240);
	expect(await track.getCodecParameterString()).toBe('hev1.1.6.L60.90'); // Main, level 2
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

	// Not much of the file has been read since we only requested metadata (up to the sync byte of the packet after the
	// last one)
	expect(maxEnd).toBeLessThanOrEqual(86481);
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

test('MPEG-TS with several programs skips the ones it can\'t read anything from', async () => {
	// Like a DVB multiplex: pay-TV programs are scrambled (transport_scrambling_control), which their PMT says with a
	// CA descriptor (for the program or for a stream), and radio programs may only have streams we don't support (LATM
	// AAC here). Recordings may keep the CA descriptors of packets that aren't scrambled.
	const caDescriptor = [0x09, 0x04, 0x01, 0x00, 0xe0, 0x50];
	type Program = {
		pmtPid: number;
		descriptors: number[];
		streams: [number, number, number[]][];
		inFile: boolean;
		scrambledPids?: number[];
	};

	const buildFile = (programs: Program[], pmtFirst: boolean) => {
		const packets: Uint8Array[] = [];
		const counters = new Map<number, number>();
		const pushPacket = (pid: number, payload: number[], scrambled = false) => {
			const packet = new Uint8Array(188).fill(0xff);
			const counter = counters.get(pid) ?? 0;
			counters.set(pid, (counter + 1) & 0xf);
			packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, (scrambled ? 0x80 : 0) | 0x10 | counter, ...payload], 0);
			packets.push(packet);
		};
		const section = (bytes: number[]) => [0x00, ...bytes, 0, 0, 0, 0]; // pointer_field, section, CRC (not checked)
		const adtsPes = (pts: number) => [
			0, 0, 1, 0xc0, 0, 8 + 39, 0x84, 0x80, 5, 0x21, 0, 1, (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1,
			0xff, 0xf1, 0x4c, 0x80, 0x04, 0xff, 0xfc, ...new Array<number>(32).fill(0), // AAC-LC, 48 kHz, stereo
		];

		const patEntries = programs.flatMap((program, i) => [
			0, i + 1, 0xe0 | (program.pmtPid >> 8), program.pmtPid & 0xff,
		]);
		const pat = section([0x00, 0xb0, 9 + patEntries.length, 0, 1, 0xc1, 0, 0, ...patEntries]);
		const pushPat = () => pushPacket(0x0000, pat);
		if (!pmtFirst) {
			pushPat();
		}

		programs.forEach((program, i) => {
			if (pmtFirst && i === 1) {
				pushPat();
			}
			if (!program.inFile) {
				return;
			}

			const body = [
				0, i + 1, 0xc1, 0, 0, 0xff, 0xff, 0xf0, program.descriptors.length, ...program.descriptors,
				...program.streams.flatMap(([streamType, pid, descriptors]) => [
					streamType, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, descriptors.length, ...descriptors,
				]),
			];
			pushPacket(program.pmtPid, section([0x02, 0xb0, body.length + 4, ...body]));
		});

		for (let i = 0; i < 3; i++) {
			for (const program of programs) {
				for (const [, pid] of program.streams) {
					if (program.scrambledPids?.includes(pid)) {
						pushPacket(pid, Array.from({ length: 184 }, (_, j) => (37 * j + i) & 0xff), true);
					} else {
						pushPacket(pid, adtsPes(1920 * i));
					}
				}
			}
		}

		const bytes = new Uint8Array(188 * packets.length);
		packets.forEach((packet, i) => bytes.set(packet, 188 * i));
		return bytes;
	};

	const readTracks = async (programs: Program[], pmtFirst = false) => {
		using input = new Input({
			source: new BufferSource(buildFile(programs, pmtFirst)),
			formats: ALL_FORMATS,
		});

		const result: [number, number][] = [];
		for (const track of await input.getTracks()) {
			let packetCount = 0;
			for await (const packet of new EncodedPacketSink(track).packets()) {
				void packet;
				packetCount++;
			}
			result.push([track.id, packetCount]);
		}

		return result;
	};

	const scrambled: Program = {
		pmtPid: 0x1000,
		descriptors: caDescriptor,
		streams: [[0x0f, 0x101, []]],
		inFile: true,
		scrambledPids: [0x101],
	};
	const radio: Program = { pmtPid: 0x1001, descriptors: [], streams: [[0x11, 0x102, []]], inFile: true };
	const scrambledStream: Program = {
		pmtPid: 0x1002,
		descriptors: [],
		streams: [[0x0f, 0x103, caDescriptor]],
		inFile: true,
		scrambledPids: [0x103],
	};
	const clear: Program = { pmtPid: 0x1003, descriptors: [], streams: [[0x0f, 0x104, []]], inFile: true };
	const partlyScrambled: Program = {
		pmtPid: 0x1004,
		descriptors: [],
		streams: [[0x0f, 0x105, caDescriptor], [0x0f, 0x106, []]],
		inFile: true,
		scrambledPids: [0x105],
	};
	// CA descriptors on packets that aren't scrambled, as recordings may keep them
	const unscrambled: Program = { ...scrambled, pmtPid: 0x1005, streams: [[0x0f, 0x107, []]], scrambledPids: [] };

	// The first program without CA descriptors, also when the first PMT comes before the PAT
	expect(await readTracks([scrambled, radio, scrambledStream, clear])).toEqual([[0x104, 3]]);
	expect(await readTracks([scrambled, radio, scrambledStream, clear], true)).toEqual([[0x104, 3]]);
	expect(await readTracks([partlyScrambled, clear])).toEqual([[0x104, 3]]);

	// Else the first program with streams without one, once all programs showed up, without its streams that
	// turn out scrambled
	expect(await readTracks([scrambled, partlyScrambled, radio])).toEqual([[0x106, 3]]);

	// Else the first program, which is read when its packets aren't scrambled despite the CA descriptors
	expect(await readTracks([unscrambled, scrambled])).toEqual([[0x107, 3]]);

	// When all its streams are scrambled, an error saying so, also when a program's PMT never shows up (rather than
	// reading the whole file)
	await expect(readTracks([scrambled, scrambledStream])).rejects.toThrow(/scrambled/);
	await expect(readTracks([{ ...clear, inFile: false }, scrambled])).rejects.toThrow(/scrambled/);

	// A single program is read as on main, CA descriptors or not, leaving out the streams that are scrambled
	expect(await readTracks([unscrambled])).toEqual([[0x107, 3]]);
	expect(await readTracks([partlyScrambled])).toEqual([[0x106, 3]]);
});

test('MPEG-TS with several programs keeps interleaved PES packets whole when the choice waits', async () => {
	// The PAT lists two programs, but only the PMT of the first, which has a CA descriptor (over packets that aren't
	// scrambled), is in the file, so the choice waits for the end of the file. Its two AAC streams have 300-byte frames
	// spanning two TS packets each, interleaved as in broadcast captures.
	const packets: Uint8Array[] = [];
	const counters = new Map<number, number>();
	const pushPacket = (pid: number, payload: number[], payloadUnitStart: boolean) => {
		const packet = new Uint8Array(188).fill(0xff);
		const counter = counters.get(pid) ?? 0;
		counters.set(pid, (counter + 1) & 0xf);
		const stuffing = 184 - payload.length;
		const adaptationFieldControl = stuffing > 0 ? 0x30 : 0x10;
		packet.set([0x47, (payloadUnitStart ? 0x40 : 0) | (pid >> 8), pid & 0xff, adaptationFieldControl | counter]);
		if (stuffing > 0) {
			packet.set([stuffing - 1, ...(stuffing > 1 ? [0x00] : [])], 4);
		}
		packet.set(payload, 4 + stuffing);
		packets.push(packet);
	};
	const section = (bytes: number[]) => [0x00, ...bytes, 0, 0, 0, 0]; // pointer_field, section, CRC (not checked)
	const caDescriptor = [0x09, 0x04, 0x0b, 0x00, 0xff, 0xf0];

	pushPacket(0x0000, section([0x00, 0xb0, 0x11, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 2, 0xf0, 0x01]), true);
	const pmtBody = [
		0, 1, 0xc1, 0, 0, 0xe1, 0x01, 0xf0, caDescriptor.length, ...caDescriptor,
		0x0f, 0xe1, 0x01, 0xf0, 0x00,
		0x0f, 0xe1, 0x02, 0xf0, 0x00,
	];
	pushPacket(0x1000, section([0x02, 0xb0, pmtBody.length + 4, ...pmtBody]), true);

	const frameLength = 300;
	const pes = (pts: number) => [
		0, 0, 1, 0xc0, ((8 + frameLength) >> 8) & 0xff, (8 + frameLength) & 0xff, 0x84, 0x80, 5,
		0x21, 0, 1, (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1,
		0xff, 0xf1, 0x4c, 0x80, (frameLength >> 3) & 0xff, ((frameLength & 7) << 5) | 0x1f, 0xfc, // ADTS
		...new Array<number>(frameLength - 7).fill(0x11),
	];
	for (let i = 0; i < 6; i++) {
		const first = pes(1920 * i);
		const second = pes(1920 * i);
		pushPacket(0x101, first.slice(0, 184), true);
		pushPacket(0x102, second.slice(0, 184), true);
		pushPacket(0x101, first.slice(184), false);
		pushPacket(0x102, second.slice(184), false);
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
		const sizes: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			sizes.push(packet.byteLength);
		}
		expect(sizes).toEqual(new Array<number>(6).fill(frameLength));
	}
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

test('MPEG-TS packet durations with B-frames do not depend on how the packets were reached', async () => {
	// The first 40 packets of an HEVC video with B-frames, so that the last frame shown is followed by a gap (the
	// frames filling it come later in the stream)
	using mp4 = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video-h265.mp4')),
		formats: ALL_FORMATS,
	});
	const mp4Track = await mp4.getPrimaryVideoTrack();
	assert(mp4Track);

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('hevc');
	output.addVideoTrack(source);
	await output.start();

	let count = 0;
	for await (const packet of new EncodedPacketSink(mp4Track).packets()) {
		await source.add(packet, count === 0 ? { decoderConfig: (await mp4Track.getDecoderConfig())! } : undefined);
		if (++count === 40) {
			break;
		}
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);
	const packets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		packets.push(packet);
	}

	// The last frame lasts one frame, however it's reached
	const lastPacket = packets.reduce((a, b) => b.timestamp > a.timestamp ? b : a);
	expect(lastPacket.timestamp).toBeCloseTo(1.4);
	expect(lastPacket.duration).toBeCloseTo(1 / 30);
	expect((await sink.getPacket(Infinity))!.duration).toBe(lastPacket.duration);
	expect(await track.computeDuration()).toBeCloseTo(1.4 + 1 / 30);
});

test('MPEG-TS gives the last frame of variable frame rate video a typical frame duration', async () => {
	// Frames 17.7, 20.3 and 10.9 ms long at the start, then 29 ms ones (seen in HLS streams, where every segment's
	// last frame has no successor)
	using mp4 = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/cursed-vfr.mp4')),
		formats: ALL_FORMATS,
	});
	const mp4Track = await mp4.getPrimaryVideoTrack();
	assert(mp4Track);

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();

	const timestamps = [0, 0.0177, 0.038, 0.0489];
	while (timestamps.length < 24) {
		timestamps.push(timestamps.at(-1)! + 0.029);
	}

	let i = 0;
	for await (const packet of new EncodedPacketSink(mp4Track).packets()) {
		const timestamp = timestamps[i]!;
		const duration = i + 1 < timestamps.length ? timestamps[i + 1]! - timestamp : 0.029;
		await source.add(
			packet.clone({ timestamp, duration }),
			i === 0 ? { decoderConfig: (await mp4Track.getDecoderConfig())! } : undefined,
		);
		if (++i === timestamps.length) {
			break;
		}
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const lastPacket = await sink.getPacket(Infinity);
	expect(lastPacket?.duration).toBeCloseTo(0.029);
	expect(await track.computeDuration()).toBeCloseTo(timestamps.at(-1)! + 0.029);
});

test('MPEG-TS with PIDs listed twice in the PMT', async () => {
	// The PAT, PMT and audio packets of FFmpeg's FATE sample ac3/mp3ac325-4864-small.ts, a DVB capture. Its PMT lists
	// the two audio PIDs as MPEG audio (stream_type 0x04) first, then again as private data with an AC-3 descriptor.
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/pmt-duplicate-pids.ts')),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getAudioTracks();
	expect(tracks.map(track => track.id)).toEqual([52, 53]);

	// What ffprobe reads, as the later entries say, except for the last frame of each, which the end of the file cuts
	// short: ffprobe keeps it, but it wouldn't decode, so Mediabunny drops it (#607)
	const results = await Promise.all(tracks.map(async (track) => {
		const packets: [number, number][] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push([Math.round(packet.timestamp * 90_000), packet.data.byteLength]);
		}

		return [await track.getCodec(), await track.getNumberOfChannels(), packets];
	}));
	expect(results).toEqual([
		['ac3', 6, [[3912633305, 1536], [3912636185, 1536], [3912639065, 1536], [3912641945, 1536]]],
		['ac3', 2, [[3912634060, 768], [3912636940, 768], [3912639820, 768], [3912642700, 768]]],
	]);
});

test('MPEG-TS packets can be advanced from twice at once', async () => {
	const bytes = fs.readFileSync(path.join(__dirname, '../public/0.ts'));

	// Conversion does this at the trim end, looking ahead from the packet its packet iterator is advancing from
	using conversionInput = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({
		input: conversionInput,
		output,
		trim: { end: await conversionInput.getFirstTimestamp() + 1 },
	});
	await conversion.execute();

	using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	expect((await outputInput.getTracks()).map(x => x.type)).toEqual(['video', 'audio']);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	const timestamps: number[] = [];
	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		timestamps.push(packet.timestamp);
		if (timestamps.length === 30) {
			break;
		}
	}

	let packet = await sink.getFirstPacket();
	for (let i = 1; i < 30; i++) {
		assert(packet);
		const [next, nextMetadata] = await Promise.all([
			sink.getNextPacket(packet),
			sink.getNextPacket(packet, { metadataOnly: true }),
		]);
		expect(next?.timestamp).toBe(timestamps[i]);
		expect(nextMetadata?.timestamp).toBe(timestamps[i]);
		packet = next;
	}
});

test('MPEG-TS with interlaced (field/MBAFF-coded) H.264 reports the full frame height', async () => {
	// ffmpeg -f lavfi -i testsrc=size=1920x1080:rate=25 -frames:v 2 -c:v libx264 -preset ultrafast -crf 51
	//   -flags +ildct+ilme -x264opts tff=1 -pix_fmt yuv420p -f mpegts interlaced-1080i-mbaff.ts
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/interlaced-1080i-mbaff.ts')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	// frame_mbs_only_flag is 0, so the 34 map units are field MB pairs: 68 MB rows, cropped by 8 to 1080
	expect(await videoTrack.getCodedWidth()).toBe(1920);
	expect(await videoTrack.getCodedHeight()).toBe(1080);
	expect(await videoTrack.getDisplayWidth()).toBe(1920);
	expect(await videoTrack.getDisplayHeight()).toBe(1080);
});

test('MPEG-TS with AC-3 and E-AC-3 named by a registration descriptor', async () => {
	// A private data stream (stream_type 0x06) can name its format with a registration descriptor ('AC-3', 'EAC3')
	// instead of a DVB AC-3 descriptor; ffprobe reads such streams. Made here by giving the audio of ac3.ts and
	// eac3.ts (PID 0x100) a PMT like that.
	const crc32 = (bytes: number[]) => {
		let crc = 0xffffffff;
		for (const byte of bytes) {
			crc ^= byte << 24;
			for (let i = 0; i < 8; i++) {
				crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
			}
		}

		crc >>>= 0;
		return [crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff];
	};
	const psiPacket = (pid: number, section: number[]) => {
		const packet = new Uint8Array(188).fill(0xff);
		packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, 0x00, ...section, ...crc32(section)]);
		return packet;
	};

	const readAudio = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: [MPEG_TS] });
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}
		return { codec: await track.getCodec(), packets };
	};

	for (const [codec, formatIdentifier] of [['ac3', 'AC-3'], ['eac3', 'EAC3']] as const) {
		const original = new Uint8Array(await fs.promises.readFile(path.join(__dirname, `../public/${codec}.ts`)));
		const packets = [
			psiPacket(0x0000, [0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00]),
			psiPacket(0x1000, [
				0x02, 0xb0, 24, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00,
				0x06, 0xe1, 0x00, 0xf0, 6, 0x05, 4, ...[...formatIdentifier].map(x => x.charCodeAt(0)),
			]),
		];
		for (let pos = 0; pos < original.length; pos += 188) {
			if ((((original[pos + 1]! & 0x1f) << 8) | original[pos + 2]!) === 0x100) {
				packets.push(original.subarray(pos, pos + 188));
			}
		}
		const bytes = new Uint8Array(188 * packets.length);
		packets.forEach((packet, i) => bytes.set(packet, 188 * i));

		const expected = await readAudio(original);
		const actual = await readAudio(bytes);
		expect(actual.codec).toBe(codec);
		expect(actual.packets.length).toBeGreaterThan(0);
		expect(actual.packets.map(x => [x.timestamp, x.byteLength]))
			.toEqual(expected.packets.map(x => [x.timestamp, x.byteLength]));
	}
});

test('MPEG-TS skips metadata streams, like the ID3 timed metadata of HLS, without a note', async () => {
	// Apple's timed metadata for HLS: ID3 tags in PES packets (stream_id 0xBD) of a stream_type 0x15 stream, described
	// by a metadata_pointer_descriptor in the program info and a metadata_descriptor in the stream info. Made here by
	// adding such a stream (PID 0x101), with one ID3 tag, to the AC-3 audio of ac3.ts (PID 0x100), next to an MPEG-2
	// video stream (stream_type 0x02, PID 0x102), whose codec isn't supported.
	const crc32 = (bytes: number[]) => {
		let crc = 0xffffffff;
		for (const byte of bytes) {
			crc ^= byte << 24;
			for (let i = 0; i < 8; i++) {
				crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
			}
		}

		crc >>>= 0;
		return [crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff];
	};
	const psiPacket = (pid: number, tableId: number, body: number[]) => {
		const section = [tableId, 0xb0 | ((body.length + 4) >> 8), (body.length + 4) & 0xff, ...body];
		const packet = new Uint8Array(188).fill(0xff);
		packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, 0x00, ...section, ...crc32(section)]);
		return packet;
	};
	const ascii = (text: string) => [...text].map(x => x.charCodeAt(0));

	// metadata_application_format 0xFFFF and metadata_format 0xFF, both identified as 'ID3 ', metadata_service_id 0
	const id3Format = [0xff, 0xff, ...ascii('ID3 '), 0xff, ...ascii('ID3 '), 0x00];
	const metadataPointerDescriptor = [0x25, 15, ...id3Format, 0x1f, 0x00, 0x01]; // For program 1
	const metadataDescriptor = [0x26, 13, ...id3Format, 0x0f];

	// An ID3v2.4 tag with the PRIV frame Apple uses to map the stream's timestamps
	const privFrameData = [...ascii('com.apple.streaming.transportStreamTimestamp\0'), 0, 0, 0, 0, 0, 0x01, 0xb7, 0x74];
	const id3Tag = [
		...ascii('ID3'), 4, 0, 0, 0, 0, 0, 10 + privFrameData.length,
		...ascii('PRIV'), 0, 0, 0, privFrameData.length, 0, 0, ...privFrameData,
	];
	const pesPacket = [
		0x00, 0x00, 0x01, 0xbd, 0x00, 8 + id3Tag.length, 0x84, 0x80, 5, 0x21, 0x00, 0x01, 0x00, 0x01, // PTS 0
		...id3Tag,
	];
	const id3Packet = new Uint8Array(188).fill(0xff);
	id3Packet.set([0x47, 0x41, 0x01, 0x30, 183 - pesPacket.length, 0x00]);
	id3Packet.set(pesPacket, 188 - pesPacket.length);

	const original = new Uint8Array(await fs.promises.readFile(path.join(__dirname, '../public/ac3.ts')));
	const packets = [
		psiPacket(0x0000, 0x00, [0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00]),
		psiPacket(0x1000, 0x02, [
			0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, metadataPointerDescriptor.length, ...metadataPointerDescriptor,
			0x81, 0xe1, 0x00, 0xf0, 6, 0x05, 4, ...ascii('AC-3'),
			0x15, 0xe1, 0x01, 0xf0, metadataDescriptor.length, ...metadataDescriptor,
			0x02, 0xe1, 0x02, 0xf0, 0,
		]),
		id3Packet,
	];
	for (let pos = 0; pos < original.length; pos += 188) {
		if ((((original[pos + 1]! & 0x1f) << 8) | original[pos + 2]!) === 0x100) {
			packets.push(original.subarray(pos, pos + 188));
		}
	}
	const bytes = new Uint8Array(188 * packets.length);
	packets.forEach((packet, i) => bytes.set(packet, 188 * i));

	const readTracks = async (data: Uint8Array) => {
		using input = new Input({ source: new BufferSource(data), formats: [MPEG_TS] });
		const tracks = await input.getTracks();
		const audioPackets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(tracks[0]!).packets()) {
			audioPackets.push(packet);
		}
		return { codecs: await Promise.all(tracks.map(x => x.getCodec())), audioPackets };
	};

	const notes: string[] = [];
	const unsubscribe = Logging.on('warn', args => notes.push(args.map(String).join(' ')));
	let actual: Awaited<ReturnType<typeof readTracks>>;
	try {
		actual = await readTracks(bytes);
	} finally {
		unsubscribe();
	}

	const expected = await readTracks(original);
	expect(actual.codecs).toEqual(['ac3']);
	expect(actual.audioPackets.length).toBeGreaterThan(0);
	expect(actual.audioPackets.map(x => [x.timestamp, x.byteLength]))
		.toEqual(expected.audioPackets.map(x => [x.timestamp, x.byteLength]));
	// No note for the metadata stream. (Unsupported codecs, like MPEG-2 video, get theirs only once per process, so
	// whether that one shows up here depends on the tests before.)
	expect(notes.filter(x => x.includes('stream_type 0x15'))).toEqual([]);
});

test('MPEG-TS leading pictures written just below zero read back as negative, not 26.5 hours later', async () => {
	// Found by L83. A conversion of an open-GOP source (x264 with open-gop, x265 by default) trimmed to start on an
	// open-GOP I-frame writes its leading B-frames just below zero, which wrap around to just below 2^33 in the file.
	// test/public/avc-open-gop.mp4: `ffmpeg -f lavfi -i testsrc2=s=96x64:r=25:d=3 -c:v libx264 -x264-params
	// keyint=25:min-keyint=25:open-gop=1:bframes=3:scenecut=0 -pix_fmt yuv420p` (FFmpeg 8.0.3)
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/avc-open-gop.mp4')),
		formats: ALL_FORMATS,
	});
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	// Starts on the open GOP's I-frame at 1 s; its leading B-frames (0.88-0.96 s) land just below zero
	const conversion = await Conversion.init({ input, output, trim: { start: 1 }, showWarnings: false });
	await conversion.execute();

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = await result.getPrimaryVideoTrack();
	assert(track);
	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
		timestamps.push(packet.timestamp);
	}
	// On main: [0, 95443.638, 95443.598, 95443.678, ...]
	expect(timestamps.slice(0, 4).map(x => Number(x.toFixed(3)))).toEqual([0, -0.08, -0.12, -0.04]);
	expect(Math.max(...timestamps)).toBeLessThan(2);
	expect(await result.computeDuration()).toBeCloseTo(2, 3);
});

const readAllPackets = async (sink: EncodedPacketSink) => {
	const packets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		packets.push(packet);
	}

	return packets;
};

const expectLookupsToFindEachPacket = async (sink: EncodedPacketSink, packets: EncodedPacket[]) => {
	for (const packet of packets) {
		const found = await sink.getPacket(packet.timestamp);
		expect(found?.sequenceNumber).toBe(packet.sequenceNumber);
		expect(found?.timestamp).toBe(packet.timestamp);
		expect(found?.duration).toBe(packet.duration);
	}
};

test('MPEG-TS with PES packets that have no PTS', async () => {
	// The first 400 TS packets of samples.ffmpeg.org/V-codecs/h264/last_samurai.ts. Its 25 fps video only has a PTS on
	// every 13th PES packet, its MP3 audio on every fifth or sixth one, starting with the third.
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sparse-pts.ts')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	const videoSink = new EncodedPacketSink(videoTrack);
	const videoPackets = await readAllPackets(videoSink);

	// ffprobe reports PTS 1898214 for the first frame, 1945014 for the 14th, and none for the rest
	expect(videoPackets.map(x => Math.round(x.timestamp * 90_000))).toEqual(
		Array.from({ length: 16 }, (_, i) => 1898214 + 3600 * i),
	);
	expect(videoPackets.every(x => x.duration === 0.04)).toBe(true);
	await expectLookupsToFindEachPacket(videoSink, videoPackets);
	expect(await videoTrack.computeDuration()).toBe(videoPackets.at(-1)!.timestamp + 0.04);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	const audioSink = new EncodedPacketSink(audioTrack);
	const audioPackets = await readAllPackets(audioSink);

	// What ffprobe reports: the frames continue from the last PTS, and the ones before the first PTS count back from
	// it. ffprobe also lists the last frame (at 1959514), which the end of the file cuts short; it wouldn't decode, so
	// Mediabunny drops it (#607).
	expect(audioPackets.map(x => Math.round(x.timestamp * 90_000))).toEqual([
		1891089, 1893440, 1895791, 1898142, 1900493, 1902844, 1905195, 1907546, 1909897, 1912248,
		1914599, 1916950, 1919301, 1921652, 1924003, 1926354, 1928705, 1931056, 1933407, 1935758,
		1938109, 1940460, 1942811, 1945162, 1947513, 1949864, 1952215,
	]);
	await expectLookupsToFindEachPacket(audioSink, audioPackets);
	expect(await audioTrack.getFirstTimestamp()).toBe(audioPackets[0]!.timestamp);
});

test('MPEG-TS with parameter sets in a PES packet of their own, without PTS', async () => {
	// The PAT, PMT and video packets of the first 578 TS packets of samples.ffmpeg.org/ffmpeg-bugs/trac/ticket697/
	// Deep%20Blue-short.ts. Before each I-frame, a PES packet without PTS holds an AUD, the SPS, the PPS and another
	// AUD.
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/parameter-sets-pes-without-pts.ts')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect((await videoTrack.getDecoderConfig())?.codec).toBe('avc1.644028');

	const sink = new EncodedPacketSink(videoTrack);
	const packets = await readAllPackets(sink);

	// Like ffprobe, one packet of 75203 bytes that begins with the parameter sets. Its timestamp is the PTS of the PES
	// packet with the picture (ffprobe reports none).
	expect(packets.map(x => [Math.round(x.timestamp * 90_000), x.data.byteLength])).toEqual([[800545050, 75203]]);
	expect([...packets[0]!.data.subarray(0, 12)]).toEqual([0, 0, 0, 1, 0x09, 0x10, 0, 0, 0, 1, 0x67, 0x64]);
	await expectLookupsToFindEachPacket(sink, packets);
});

/**
 * Builds a transport stream with an AVC stream on PID 0x100 out of the given PES packets' access units (or just an AUD
 * and parameter sets), optionally after a picture's second half or a whole picture whose AUD isn't there.
 */
const buildAvcTransportStream = (
	pesPackets: {
		pts: number | null;
		accessUnitCount: number;
		parameterSetsOnly?: boolean;
		leadingSlice?: 'pictureRest' | 'picture';
	}[],
) => {
	const startCode = [0, 0, 0, 1];
	const aud = [...startCode, 0x09, 0xf0];
	const sps = [
		...startCode, 0x67, 0x42, 0xc0, 0x0a, 0xda, 0x10, 0x9b, 0x01, 0x10, 0, 0, 3, 0, 0x10, 0, 0, 3, 3, 0x20,
	];
	const pps = [...startCode, 0x68, 0xce, 0x0f, 0xc8];
	const sliceData = new Array<number>(20).fill(0xaa);
	const slice = (key: boolean) => [...startCode, key ? 0x65 : 0x41, key ? 0x88 : 0x9a, 0x84, ...sliceData];

	const packets: Uint8Array[] = [];
	const packetize = (pid: number, payload: number[]) => {
		for (let offset = 0; offset < payload.length; offset += 184) {
			const chunk = payload.slice(offset, offset + 184);
			const stuffing = 184 - chunk.length;
			const packet = new Uint8Array(188).fill(0xff);
			packet.set([0x47, (offset === 0 ? 0x40 : 0) | (pid >> 8), pid & 0xff, stuffing > 0 ? 0x30 : 0x10]);
			if (stuffing > 0) {
				packet.set(stuffing > 1 ? [stuffing - 1, 0] : [0], 4);
			}
			packet.set(chunk, 4 + stuffing);
			packets.push(packet);
		}
	};

	packetize(0x0000, [0, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0]);
	packetize(0x1000, [
		0, 0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0,
	]);

	let frameIndex = 0;
	for (const { pts, accessUnitCount, parameterSetsOnly, leadingSlice } of pesPackets) {
		const data: number[] = [
			// A slice starting at macroblock 8, or at 0
			...(leadingSlice === 'pictureRest' ? [...startCode, 0x41, 0x12, 0x22, ...sliceData] : []),
			...(leadingSlice === 'picture' ? slice(false) : []),
			...(parameterSetsOnly ? [...aud, ...sps, ...pps] : []),
		];
		for (let i = 0; i < accessUnitCount; i++, frameIndex++) {
			data.push(...aud, ...(frameIndex === 0 ? [...sps, ...pps] : []), ...slice(frameIndex === 0));
		}

		const ptsBytes = pts === null
			? []
			: [
					0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff, ((pts >> 14) & 0xfe) | 1, (pts >> 7) & 0xff,
					((pts << 1) & 0xfe) | 1,
				];
		const header = [0x80, pts === null ? 0x00 : 0x80, ptsBytes.length, ...ptsBytes];
		packetize(0x100, [0, 0, 1, 0xe0, 0, 0, ...header, ...data]);
	}

	const bytes = new Uint8Array(188 * packets.length);
	packets.forEach((packet, i) => bytes.set(packet, 188 * i));
	return bytes;
};

const expectEvenlySpacedFrames = async (
	pesPackets: { pts: number | null; accessUnitCount: number }[],
	frameCount: number,
) => {
	using input = new Input({ source: new BufferSource(buildAvcTransportStream(pesPackets)), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);
	const packets = await readAllPackets(sink);

	expect(packets.map(x => Math.round(x.timestamp * 90_000))).toEqual(
		Array.from({ length: frameCount }, (_, i) => 90_000 + 3000 * i),
	);
	expect(packets.every(x => Math.round(x.duration * 90_000) === 3000)).toBe(true);
	await expectLookupsToFindEachPacket(sink, packets);

	for (const packet of packets) {
		const keyPacket = await sink.getKeyPacket(packet.timestamp);
		expect(keyPacket?.sequenceNumber).toBe(packets[0]!.sequenceNumber);
	}
};

test('MPEG-TS spaces out the frames that share a PES packet', async () => {
	// Three frames per PES packet, 0.1 seconds apart. The frames after the last PTS continue at the same rate.
	await expectEvenlySpacedFrames([
		{ pts: 90_000, accessUnitCount: 3 },
		{ pts: 99_000, accessUnitCount: 3 },
		{ pts: 108_000, accessUnitCount: 3 },
	], 9);
});

test('MPEG-TS times the frames of PES packets without PTS from the ones around them', async () => {
	// Like after damage to the PES packet headers
	await expectEvenlySpacedFrames([
		{ pts: 90_000, accessUnitCount: 1 },
		{ pts: null, accessUnitCount: 1 },
		{ pts: null, accessUnitCount: 1 },
		{ pts: 99_000, accessUnitCount: 1 },
		{ pts: 102_000, accessUnitCount: 1 },
		{ pts: null, accessUnitCount: 1 },
	], 6);
});

test('MPEG-TS takes the PTS of the PES packet an access unit begins in', async () => {
	// Like Chromium's extra-nalu.ts: a PES packet with only an AUD, the SPS and the PPS precedes the key frame's, and
	// both have a PTS. The key frame's access unit begins at the AUD in its own PES packet, so that one's PTS is its
	// (as in Chromium; FFmpeg takes the first one, which is the frame's DTS in that file).
	using input = new Input({
		source: new BufferSource(buildAvcTransportStream([
			{ pts: 87_000, accessUnitCount: 0, parameterSetsOnly: true },
			{ pts: 90_000, accessUnitCount: 1 },
			{ pts: 93_000, accessUnitCount: 1 },
		])),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);
	const packets = await readAllPackets(sink);

	expect(packets.map(x => Math.round(x.timestamp * 90_000))).toEqual([90_000, 93_000]);

	// The first packet still holds the parameter sets before its AUD
	const data = packets[0]!.data;
	const nalUnitTypes: number[] = [];
	for (let i = 0; i + 4 < data.length; i++) {
		if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
			nalUnitTypes.push(data[i + 4]! & 0x1f);
		}
	}
	expect(nalUnitTypes).toEqual([9, 7, 8, 9, 7, 8, 5]);
	await expectLookupsToFindEachPacket(sink, packets);
});

test('MPEG-TS places B-frames without PTS by their picture order', async () => {
	// The PAT, PMT and video packets of the first 717 TS packets of samples.ffmpeg.org/A-codecs/AAC/freetv_aac_latm.ts
	// (25 fps, I P B B B P B B B ...). Each PES packet of B-frames only has a PTS for the first one.
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/b-frames-without-pts.ts')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);
	const packets = await readAllPackets(sink);
	const ticks = packets.map(x => Math.round(x.timestamp * 90_000) - Math.round(packets[0]!.timestamp * 90_000));

	// The B-frames without PTS follow the one with it, 40 ms apart (FFmpeg's decoder puts them there too)
	expect(ticks.slice(0, 9)).toEqual([0, 14404, 3600, 7201, 10802, 28807, 18004, 21605, 25206]);

	// In presentation order, the frames are a frame duration apart, give or take the source's jitter, except where the
	// last frame in decode order would be: the end of the file cuts it short, so Mediabunny drops it (#618)
	const sorted = [...ticks].sort((a, b) => a - b);
	const irregularGaps = sorted.slice(1).map((tick, i) => tick - sorted[i]!).filter(gap => Math.abs(gap - 3600) > 15);
	expect(irregularGaps).toHaveLength(1);
	expect(Math.abs(irregularGaps[0]! - 7200)).toBeLessThanOrEqual(15);

	for (const packet of packets) {
		expect((await sink.getPacket(packet.timestamp))?.sequenceNumber).toBe(packet.sequenceNumber);
	}
});

test('MPEG-TS restores the timestamps of damaged PES headers in streams with B-frames', async () => {
	const bytes = new Uint8Array(await fs.promises.readFile(path.join(__dirname, '../public/0.ts')));

	const readVideoTimestamps = async (data: Uint8Array) => {
		using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const timestamps = new Map<number, number>();
		for await (const packet of new EncodedPacketSink(track).packets()) {
			timestamps.set(packet.sequenceNumber, Math.round(packet.timestamp * 90_000));
		}

		return timestamps;
	};

	const pesHeaderPositions: number[] = [];
	for (let pos = 0; pos < bytes.length; pos += 188) {
		const pid = ((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!;
		if (pid === 0x100 && bytes[pos + 1]! & 0x40) {
			pesHeaderPositions.push(pos + 4 + ((bytes[pos + 3]! & 0x20) ? 1 + bytes[pos + 4]! : 0));
		}
	}

	const original = await readVideoTimestamps(bytes);

	// Clear PTS_DTS_flags of every third of the 2nd to 40th video PES packet, then of the last four (B-frames at the
	// end of the stream, without a timed packet after them)
	const damagedPesPackets = [
		pesHeaderPositions.filter((_, i) => i >= 1 && i <= 39 && (i + 1) % 3 === 0),
		pesHeaderPositions.slice(-4),
	];

	for (const positions of damagedPesPackets) {
		const damaged = bytes.slice();
		for (const pos of positions) {
			damaged[pos + 7]! &= 0x3f;
		}

		// The picture order counts in the slice headers tell where the frames go, B-frames included
		const restored = await readVideoTimestamps(damaged);
		expect([...restored.keys()]).toEqual([...original.keys()]);
		for (const [sequenceNumber, timestamp] of original) {
			expect(Math.abs(restored.get(sequenceNumber)! - timestamp)).toBeLessThanOrEqual(1);
		}
	}
});

test('MPEG-TS with a file that starts in the middle of an access unit', async () => {
	// Like a file or segment cut from a longer stream, the first PES packet begins with the rest of an access unit (the
	// second half of a picture, or a whole picture without its AUD) before the first access unit beginning in it, which
	// the PES packet's PTS belongs to
	for (const leadingSlice of ['pictureRest', 'picture'] as const) {
		using input = new Input({
			source: new BufferSource(buildAvcTransportStream([
				{ pts: 90_000, accessUnitCount: 1, leadingSlice },
				{ pts: 93_000, accessUnitCount: 1 },
				{ pts: 96_000, accessUnitCount: 1 },
			])),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const packets = await readAllPackets(new EncodedPacketSink(track));

		// The key frame keeps the PTS, which the rest before it shares (like before)
		expect(packets.map(x => [Math.round(x.timestamp * 90_000), x.type])).toEqual([
			[90_000, 'delta'], [90_000, 'key'], [93_000, 'delta'], [96_000, 'delta'],
		]);
	}
});

test('MPEG-TS times frames without PTS by the frame rate in the SPS', async () => {
	// 3 frames of x264 output at 480 fps, its PES packets without a PTS but the first (made with `ffmpeg -f lavfi -i
	// testsrc=size=64x64:rate=480 -frames:v 3 -c:v libx264 -bf 0 -f mpegts`)
	const bytes = new Uint8Array(await fs.promises.readFile(path.join(__dirname, '../public/high-frame-rate.ts')));

	const readTimestamps = async (data: Uint8Array) => {
		using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const packets = await readAllPackets(new EncodedPacketSink(track));
		return packets.map(x => Math.round(x.timestamp * 90_000));
	};

	const damaged = bytes.slice();
	let pesPacketCount = 0;
	for (let pos = 0; pos < damaged.length; pos += 188) {
		const pid = ((damaged[pos + 1]! & 0x1f) << 8) | damaged[pos + 2]!;
		if (pid === 0x100 && damaged[pos + 1]! & 0x40 && ++pesPacketCount > 1) {
			damaged[pos + 4 + ((damaged[pos + 3]! & 0x20) ? 1 + damaged[pos + 4]! : 0) + 7]! &= 0x3f;
		}
	}

	expect(await readTimestamps(bytes)).toEqual([126000, 126188, 126375]);
	expect(await readTimestamps(damaged)).toEqual([126000, 126188, 126375]);
});

test('MPEG-TS finds frames presented before the first PES packet', async () => {
	// With open GOPs, the frames right after a key frame in decode order can be presented before it (like in an HLS
	// segment cut at such a key frame). Made here from video.mp4's first frames (I P B B B ...), the key frame shown
	// after the two B-frames presented before 0.1 seconds.
	using mp4 = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});
	const mp4Track = await mp4.getPrimaryVideoTrack();
	assert(mp4Track);

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();

	let count = 0;
	for await (const packet of new EncodedPacketSink(mp4Track).packets()) {
		await source.add(
			count === 0 ? packet.clone({ timestamp: 0.1, duration: 0.02 }) : packet,
			count === 0 ? { decoderConfig: (await mp4Track.getDecoderConfig())! } : undefined,
		);
		if (++count === 12) {
			break;
		}
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);
	const packets = await readAllPackets(sink);
	expect(packets.slice(0, 4).map(x => x.timestamp)).toEqual([0.1, 0.16, 0.08, 0.04]);

	for (const packet of packets) {
		expect((await sink.getPacket(packet.timestamp))?.sequenceNumber).toBe(packet.sequenceNumber);
	}
	expect(await sink.getPacket(0.02)).toBeNull();
	expect(await sink.getKeyPacket(0.09)).toBeNull();
	expect((await sink.getKeyPacket(0.11))?.sequenceNumber).toBe(packets[0]!.sequenceNumber);
});

test('MPEG-TS places a first frame without PTS by its picture order', async () => {
	// x264 output with B-frames and open GOPs (made with `ffmpeg -f lavfi -i mandelbrot=size=96x64:rate=25 -t 1.8 -c:v
	// libx264 -x264-params keyint=32:open-gop=1:bframes=3:b-adapt=0:repeat-headers=1 -f mpegts`). Its first video PES
	// packet loses its PTS, in the file as is (an IDR picture, shown before the B-frames after it) and in the file cut
	// at its second key frame (an I picture, shown after the three leading B-frames after it), also with uneven
	// timestamps among those B-frames.
	const original = new Uint8Array(await fs.promises.readFile(path.join(__dirname, '../public/open-gop.ts')));
	const getVideoPesPacketPositions = (bytes: Uint8Array) => {
		const positions: number[] = [];
		for (let pos = 0; pos < bytes.length; pos += 188) {
			if ((((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!) === 0x100 && bytes[pos + 1]! & 0x40) {
				positions.push(pos);
			}
		}

		return positions;
	};
	const getPesHeaderPos = (bytes: Uint8Array, pos: number) => {
		return pos + 4 + (bytes[pos + 3]! & 0x20 ? 1 + bytes[pos + 4]! : 0);
	};
	const readTimestamps = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const sink = new EncodedPacketSink(track);
		const packets = await readAllPackets(sink);
		for (const packet of packets) {
			expect((await sink.getPacket(packet.timestamp))?.sequenceNumber).toBe(packet.sequenceNumber);
		}

		return packets.map(x => Math.round(x.timestamp * 90_000));
	};

	const videoPositions = getVideoPesPacketPositions(original);
	const keyFramePositions = videoPositions.filter(pos => original[pos + 3]! & 0x20 && original[pos + 5]! & 0x40);
	const cut = new Uint8Array([
		...original.subarray(0, videoPositions[0]),
		...original.subarray(keyFramePositions[1]),
	]);

	// The second leading B-frame 2500 ticks early
	const uneven = cut.slice();
	const ptsPos = getPesHeaderPos(uneven, getVideoPesPacketPositions(uneven)[2]!) + 9;
	const pts = ((uneven[ptsPos]! >> 1) & 0x07) * 2 ** 30 + (uneven[ptsPos + 1]! << 22)
		+ ((uneven[ptsPos + 2]! >> 1) << 15) + (uneven[ptsPos + 3]! << 7) + (uneven[ptsPos + 4]! >> 1) - 2500;
	uneven.set([
		(uneven[ptsPos]! & 0xf1) | ((Math.floor(pts / 2 ** 30) & 0x07) << 1),
		(pts >> 22) & 0xff,
		((pts >> 14) & 0xfe) | 1,
		(pts >> 7) & 0xff,
		((pts << 1) & 0xfe) | 1,
	], ptsPos);

	for (const bytes of [original, cut, uneven]) {
		const damaged = bytes.slice();
		damaged[getPesHeaderPos(damaged, getVideoPesPacketPositions(damaged)[0]!) + 7]! &= 0x3f; // PTS_DTS_flags
		expect(await readTimestamps(damaged)).toEqual(await readTimestamps(bytes));
	}
});

test('MPEG-TS resyncs after bytes were added or lost', async () => {
	const bytes = new Uint8Array(await fs.promises.readFile(path.join(__dirname, '../public/mp3.ts')));

	const readPackets = async (data: Uint8Array) => {
		using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const sink = new EncodedPacketSink(track);
		const packets: EncodedPacket[] = [];
		for await (const packet of sink.packets()) {
			packets.push(packet);
		}

		// Lookups find the same packets
		for (const packet of packets.slice(-20)) {
			expect((await sink.getPacket(packet.timestamp))?.sequenceNumber).toBe(packet.sequenceNumber);
		}

		return packets.map(x => x.timestamp);
	};

	/** Replaces `removedCount` bytes in the middle of a TS packet with `addedCount` ones. */
	const damage = (removedCount: number, addedCount: number) => {
		const pos = 188 * 372 + 64;
		const result = new Uint8Array(bytes.length - removedCount + addedCount).fill(0x55);
		result.set(bytes.subarray(0, pos));
		result.set(bytes.subarray(pos + removedCount), pos + addedCount);
		return result;
	};

	const original = await readPackets(bytes);
	expect(original).toHaveLength(210);

	// Like ffprobe, we get all frames back. Chromium's extra-nalu.ts test file has 24 stray bytes.
	expect(await readPackets(damage(0, 1))).toEqual(original);
	expect(await readPackets(damage(0, 24))).toEqual(original);
	expect(await readPackets(damage(0, 500))).toEqual(original);

	// Lost bytes damage a frame, but the ones after it are all there
	expect((await readPackets(damage(1, 0))).slice(-100)).toEqual(original.slice(-100));
	expect((await readPackets(damage(100, 0))).slice(-100)).toEqual(original.slice(-100));

	// Junk at the end
	const withJunk = new Uint8Array(bytes.length + 1000);
	withJunk.set(bytes);
	expect(await readPackets(withJunk)).toEqual(original);
});

test('MPEG-TS with stray bytes between packets', async () => {
	// The first two packets (PAT and PMT), the 24 stray bytes after packet 556 and the 500 packets after them from
	// Chromium's media/test/data/extra-nalu.ts
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/stray-bytes.ts')),
		formats: ALL_FORMATS,
	});

	const readPackets = async (track: InputTrack | null) => {
		assert(track);
		const packets: [number, number][] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push([Math.round(packet.timestamp * 90_000), packet.data.byteLength]);
		}

		return packets;
	};

	// What ffprobe reads after the stray bytes (it merges the key frame with the PES packet holding its parameter
	// sets). ffprobe also lists the next video frame, which the end of the file cuts short; it wouldn't decode, so
	// Mediabunny drops it (#618).
	expect(await readPackets(await input.getPrimaryAudioTrack())).toEqual([[199355326, 360], [199357416, 360]]);
	expect(await readPackets(await input.getPrimaryVideoTrack())).toHaveLength(1);
});

test('MPEG-TS ignores a PMT that is not in effect yet', async () => {
	// Broadcasts may send the next version of a PMT (current_next_indicator 0) ahead of switching to it. First, one
	// that moves the audio to another PID comes before the PMT in effect (`ffprobe -f mpegts` reads the three frames).
	// Then, the file only has a PMT for later, which is taken after all, as before.
	const crc32 = (bytes: number[]) => {
		let crc = 0xffffffff;
		for (const byte of bytes) {
			crc ^= byte << 24;
			for (let i = 0; i < 8; i++) {
				crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
			}
		}

		crc >>>= 0;
		return [crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff];
	};
	const tsPacket = (pid: number, payload: number[]) => {
		const packet = new Uint8Array(188).fill(0xff);
		packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x30, 183 - payload.length, 0x00]);
		packet.set(payload, 188 - payload.length);
		return packet;
	};
	const psiPacket = (pid: number, section: number[]) => tsPacket(pid, [0x00, ...section, ...crc32(section)]);
	const pmt = (version: number, currentNext: number, audioPid: number) => psiPacket(0x1000, [
		0x02, 0xb0, 18, 0, 1, 0xc0 | (version << 1) | currentNext, 0, 0, 0xe1, 0x00, 0xf0, 0x00,
		0x0f, 0xe0 | (audioPid >> 8), audioPid & 0xff, 0xf0, 0x00, // AAC
	]);
	const adtsFrame = [0xff, 0xf1, 0x4c, 0x80, 0x01, 0xbf, 0xfc, 0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c];

	for (const pmts of [[pmt(1, 0, 0x101), pmt(0, 1, 0x100)], [pmt(0, 0, 0x100)]]) {
		const packets = [
			psiPacket(0x0000, [0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00]),
			...pmts,
			...[0, 1, 2].map(i => tsPacket(0x100, [
				0, 0, 1, 0xc0, 0, 8 + adtsFrame.length, 0x80, 0x80, 5,
				0x21, 0, 1, ((1920 * i) >> 7) & 0xff, ((1920 * i << 1) & 0xfe) | 1, ...adtsFrame,
			])),
		];
		const bytes = new Uint8Array(188 * packets.length);
		packets.forEach((packet, i) => bytes.set(packet, 188 * i));

		using input = new Input({ source: new BufferSource(bytes), formats: [MPEG_TS] });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		expect(track.id).toBe(0x100);

		let count = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			expect(packet.byteLength).toBe(adtsFrame.length);
			count++;
		}
		expect(count).toBe(3);
	}
});

test('MPEG-TS lookups past the end of a track, or in a gap of it, do not walk the rest of the file again', async () => {
	// Two AAC tracks over 3 minutes, the second one only there for the first 18 seconds (like an audio PID that stops
	// in a broadcast capture), or also for the last 18 seconds (one that stops for a while). Found by the L58 scale
	// review.
	for (const hasEnd of [false, true]) {
		const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
		const main = new EncodedAudioPacketSource('aac');
		const short = new EncodedAudioPacketSource('aac');
		output.addAudioTrack(main);
		output.addAudioTrack(short);
		await output.start();

		const decoderConfig = {
			codec: 'mp4a.40.2',
			numberOfChannels: 2,
			sampleRate: 48000,
			description: new Uint8Array([0x11, 0x90]),
		};
		const frameDuration = 1024 / 48000;
		const count = Math.round(180 / frameDuration);
		const data = new Uint8Array(300).fill(0x21);
		for (let i = 0; i < count; i++) {
			const packet = new EncodedPacket(data, 'key', i * frameDuration, frameDuration);
			await main.add(packet, { decoderConfig });
			if (i < count / 10 || (hasEnd && i > count * 0.9)) {
				await short.add(packet, { decoderConfig });
			}
		}
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		let bytesRead = 0;
		using input = new Input({
			formats: ALL_FORMATS,
			source: new CustomSource({
				// A cache much smaller than the file, as for any long recording
				maxCacheSize: 2 ** 16,
				getSize: () => bytes.byteLength,
				read: (start, end) => {
					bytesRead += end - start;
					return bytes.subarray(start, end);
				},
			}),
		});
		const shortTrack = (await input.getAudioTracks())[1];
		assert(shortTrack);
		const sink = new EncodedPacketSink(shortTrack);

		// Lookups within the track only read around the packet
		bytesRead = 0;
		expect((await sink.getPacket(10))!.timestamp).toBeCloseTo(10, 1);
		expect(bytesRead).toBeLessThan(bytes.byteLength / 4);

		// The first lookup past the part where the track is has to find out where it ends
		expect((await sink.getPacket(60))!.timestamp).toBeCloseTo(18, 1);

		for (const timestamp of [90, 120, 150]) {
			bytesRead = 0;
			expect((await sink.getPacket(timestamp))!.timestamp).toBeCloseTo(18, 1);
			// Each of these read most of the file again, twice
			expect(bytesRead).toBeLessThan(bytes.byteLength / 4);
		}
	}
});

test('MPEG-TS finds frames that come before a run of B-frames longer than the reorder depth', async () => {
	// Found by L80. The P/I frame before a run of B-frames in decode order is presented after all of them, so it's as
	// far back as the run is long, which the reorder depth doesn't bound: here num_reorder_frames is 1 and
	// max_dec_frame_buffering 2, with runs of up to 16 B-frames (the most x264 and x265 make), as made by x264 with
	// b-pyramid=none, x265 at slower presets or hardware encoders. SPS and PPS of a 64x64 x264 stream; the slices are
	// stubs with first_mb_in_slice = 0. Then a 1920x1080 level 4.0 SPS without VUI, whose inferred reorder depth
	// (MaxDpbFrames) is 4, with runs of 7.
	const x264Sps = [0x67, 0x64, 0x00, 0x0a, 0xac, 0xd3, 0x10, 0x9b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00,
		0x00, 0x03, 0x03, 0x20, 0xf1, 0x22, 0x53, 0x80];
	const unsignaledSps = [0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0x40];
	const pps = [0x68, 0xef, 0x8f, 0xcb];
	const nalUnit = (bytes: number[]) => [0, 0, 0, 1, ...bytes];
	const slice = (header: number) => nalUnit([header, 0x88, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);

	for (const [bFrameCount, sps] of [[2, x264Sps], [5, x264Sps], [16, x264Sps], [7, unsignaledSps]] as const) {
		// I0 P(n+1) B1..Bn P(2n+2) ..., with n B-frames between P/I frames and no pyramid
		const step = bFrameCount + 1;
		const frameCount = 4 * step + 1;
		const decodeOrder = [0];
		for (let anchor = step; anchor < frameCount; anchor += step) {
			decodeOrder.push(anchor);
			for (let frame = anchor - bFrameCount; frame < anchor; frame++) {
				decodeOrder.push(frame);
			}
		}

		const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source, { frameRate: 25 });
		await output.start();
		for (const frame of decodeOrder) {
			const isKey = frame === 0;
			const data = isKey
				? [...nalUnit(sps), ...nalUnit(pps), ...slice(0x65)]
				: slice(frame % step === 0 ? 0x41 : 0x01);
			await source.add(
				new EncodedPacket(new Uint8Array(data), isKey ? 'key' : 'delta', frame / 25, 1 / 25),
				isKey ? { decoderConfig: { codec: 'avc1.64000a', codedWidth: 64, codedHeight: 64 } } : undefined,
			);
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const sink = new EncodedPacketSink(track);
		const start = await track.getFirstTimestamp();

		// Every frame's own timestamp finds it
		const found: number[] = [];
		for (let frame = 0; frame < frameCount; frame++) {
			const packet = await sink.getPacket(start + frame / 25);
			assert(packet);
			found.push(Math.round((packet.timestamp - start) * 25));
		}
		expect({ bFrameCount, found }).toEqual({ bFrameCount, found: [...Array(frameCount).keys()] });
		expect(await track.computeDuration() - start).toBeCloseTo(frameCount / 25);
	}
});

test('MPEG-TS reads the packets in front of a late PAT and PMT', async () => {
	// Found by L80. A capture of a broadcast starts somewhere between two of its PSI repetitions, so packets of the
	// streams come before the first PAT and PMT. late-pmt.ts is the first 531 TS packets of FFmpeg's FATE sample
	// h264/h264_intra_first-small.ts without its video (PID 0x12b5, whose first SPS only comes later): MP2 audio
	// (0x12b2, 0x12b4) from TS packets 0 and 1, the PAT at packet 11 and the PMT at packet 17, of 24. Expected: the
	// packets ffprobe reads (PTS, size); on main, the file opens with no tracks at all.
	const readFirstPackets = async (bytes: Uint8Array, count: number) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const result: Record<number, number[][]> = {};
		for (const track of await input.getTracks()) {
			const packets: number[][] = [];
			for await (const packet of new EncodedPacketSink(track).packets()) {
				packets.push([Math.round(packet.timestamp * 90000), packet.byteLength]);
				if (packets.length === count) {
					break;
				}
			}
			result[track.id] = packets;
		}
		return result;
	};

	const lateCapture = new Uint8Array(await fs.promises.readFile(path.join(__dirname, '../public/late-pmt.ts')));
	expect(await readFirstPackets(lateCapture, Infinity)).toEqual({
		// ffprobe also lists the last frame of each, which the end of the file cuts short (416 and 112 of 672
		// bytes); it wouldn't decode, so Mediabunny drops it (#607)
		[0x12b4]: [[212003457, 672]],
		[0x12b2]: [[212002017, 672], [212004177, 672]],
	});

	// And synthetic ones: 30 AAC frames (stub payloads), with the PAT and PMT (the first two TS packets) moved behind
	// the first 5 TS packets of media, or to the very end
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

	const movePsiBack = (count: number) => {
		const result = new Uint8Array(bytes.length);
		result.set(bytes.subarray(2 * 188, (2 + count) * 188), 0);
		result.set(bytes.subarray(0, 2 * 188), count * 188);
		result.set(bytes.subarray((2 + count) * 188), (2 + count) * 188);
		return result;
	};

	const expected = await readFirstPackets(bytes, 30);
	expect(Object.values(expected)[0]).toHaveLength(30);
	expect(await readFirstPackets(movePsiBack(5), 30)).toEqual(expected);
	expect(await readFirstPackets(movePsiBack(bytes.length / 188 - 2), 30)).toEqual(expected);
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

test('MPEG-TS drops the GOP of a key frame that lost a TS packet, also in streams without reordering', async () => {
	// A stream of P-frames only loses just the frames that lost data, which decoders handle like a gap in frame_num.
	// But nothing decodes without its key frame, so a damaged key frame takes its GOP with it (coordinator ruling). 20
	// frames of a 64x64 x264 Baseline stream with a key frame every 4 (SPS and PPS, then stub slices of 600 bytes, so
	// each frame spans several TS packets).
	const sps = [0x67, 0x42, 0xc0, 0x0a, 0xd9, 0x04, 0x26, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03,
		0x00, 0xc8, 0x3c, 0x48, 0x99, 0x20];
	const pps = [0x68, 0xcb, 0x83, 0xcb, 0x20];
	const nalUnit = (bytes: number[]) => [0, 0, 0, 1, ...bytes];

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, { frameRate: 25 });
	await output.start();
	for (let i = 0; i < 20; i++) {
		const isKey = i % 4 === 0;
		const sliceData = Array.from({ length: 600 }, (_, j) => 0x20 + (7 * j + i) % 0x60);
		const slice = nalUnit([isKey ? 0x65 : 0x41, 0x88, ...sliceData]);
		await source.add(
			new EncodedPacket(
				new Uint8Array(isKey ? [...nalUnit(sps), ...nalUnit(pps), ...slice] : slice),
				isKey ? 'key' : 'delta',
				i / 25,
				1 / 25,
			),
			i === 0 ? { decoderConfig: { codec: 'avc1.42c00a', codedWidth: 64, codedHeight: 64 } } : undefined,
		);
	}
	await output.finalize();
	const bytes = new Uint8Array(output.target.buffer!);
	const tsPackets = Array.from({ length: bytes.length / 188 }, (_, i) => bytes.slice(188 * i, 188 * (i + 1)));
	const isVideo = (packet: Uint8Array) => (((packet[1]! & 0x1f) << 8) | packet[2]!) === 0x100;
	const frameStarts = tsPackets.flatMap((packet, i) => (isVideo(packet) && packet[1]! & 0x40 ? [i] : []));

	const readFrameNumbers = async (packets: Uint8Array[]) => {
		const data = new Uint8Array(188 * packets.length);
		packets.forEach((packet, i) => data.set(packet, 188 * i));
		using input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const frameNumbers: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			frameNumbers.push(Math.round(packet.timestamp * 25));
		}
		return frameNumbers;
	};
	const allFrames = Array.from({ length: 20 }, (_, i) => i);
	expect(await readFrameNumbers(tsPackets)).toEqual(allFrames);

	// Frame 5, a P-frame, loses a TS packet: only it goes. Frame 8, a key frame, gets transport_error_indicator on its
	// second TS packet: frames 8 to 11 go, and the next GOP is intact.
	const damaged = tsPackets.flatMap((packet, i) => {
		if (i === frameStarts[5]! + 1) {
			return [];
		} else if (i === frameStarts[8]! + 1) {
			const flagged = packet.slice();
			flagged[1]! |= 0x80;
			return [flagged];
		}

		return [packet];
	});
	expect(await readFrameNumbers(damaged)).toEqual(allFrames.filter(x => x !== 5 && (x < 8 || x > 11)));
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
	const withPrivateStreams = (extraPids: number[], extraPackets: Uint8Array[], nullPacketCount: number) => {
		const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, '../public/mp3.ts')));
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

	// Whether the video's last TS packet with payload carries payload only (no adaptation field, so no stuffing). The
	// video PID is the one whose PES packets have stream_id 0xe0.
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
			const adaptationFieldControl = (bytes[pos + 3]! >> 4) & 0b11;
			if (pidAt(pos) === videoPid && adaptationFieldControl & 0b01) {
				return adaptationFieldControl === 0b01;
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

test('MPEG-TS reading at a position inside a PES packet leaves the PES packet whole', async () => {
	// In damaged files, a packet header and the packet read at the same position can disagree while the packet
	// positions get resynced, so a section can be read where no section starts. That mustn't be remembered as a section
	// end, which cut the PES packet around it short and ended iteration there (found by L15 on FFmpeg's aac_crash.ts
	// sample, after a lookup at the end of the track).
	const bytes = new Uint8Array(await fs.promises.readFile(path.join(__dirname, '../public/0.ts')));
	const readFrames = async (input: Input) => {
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const frames: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			frames.push(packet.byteLength);
		}
		return frames;
	};

	using cleanInput = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const clean = await readFrames(cleanInput);

	// A video TS packet in the middle of a PES packet (PID 0x100, no payload_unit_start_indicator)
	let pos = 188 * 1000;
	while (!((((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!) === 0x100 && !(bytes[pos + 1]! & 0x40))) {
		pos += 188;
	}

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	await input.getTracks();
	const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
	expect(await demuxer.readSection(pos, false)).toBe(null);
	expect(await readFrames(input)).toEqual(clean);
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

test('MPEG-TS lookups find field pictures behind long runs of B-fields', async () => {
	// From L25's and L80's reviews, like FFmpeg's spatial_direct_mode_is_not_implemented.ts sample: interlaced H.264
	// (frame_mbs_only_flag 0, a reorder depth of 4 frames) whose fields come in PES packets of their own, each anchor
	// field pair followed in decode order by 14 B-fields shown before it. The SPS and PPS are that sample's.
	const sps = [0x67, 0x64, 0x00, 0x28, 0xac, 0x72, 0x94, 0x07, 0x80, 0x44, 0x7d, 0xe0, 0x2d, 0x40, 0x40, 0x40, 0x7c,
		0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xca, 0x50];
	const pps = [0x68, 0xfa, 0x42, 0x5c, 0x30];
	const nalUnit = (bytes: number[]) => [0, 0, 0, 1, ...bytes];

	// Fields at 50 per second: an I field pair, then groups of 16 fields in decode order: the anchor pair, then B-field
	// pairs in hierarchical order
	const fieldNumbers = [0, 1];
	for (let group = 0; group < 3; group++) {
		const base = 2 + 16 * group;
		fieldNumbers.push(...[14, 15, 6, 7, 2, 3, 0, 1, 4, 5, 10, 11, 8, 9, 12, 13].map(x => base + x));
	}

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, { frameRate: 50 });
	await output.start();
	for (let i = 0; i < fieldNumbers.length; i++) {
		const sliceData = Array.from({ length: 300 }, (_, j) => 0x20 + (7 * j + i) % 0x60);
		const slice = nalUnit([i < 2 ? 0x65 : 0x41, 0x88, ...sliceData]);
		await source.add(
			new EncodedPacket(
				new Uint8Array(i === 0 ? [...nalUnit(sps), ...nalUnit(pps), ...slice] : slice),
				i < 2 ? 'key' : 'delta',
				fieldNumbers[i]! / 50,
				1 / 50,
			),
			i === 0 ? { decoderConfig: { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1088 } } : undefined,
		);
	}
	await output.finalize();
	const bytes = new Uint8Array(output.target.buffer!);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	expect(packets.map(x => Math.round(x.timestamp * 50))).toEqual(fieldNumbers);

	// A cold lookup at each field's timestamp finds that field
	for (const packet of packets) {
		using coldInput = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const coldTrack = await coldInput.getPrimaryVideoTrack();
		assert(coldTrack);
		const found = await new EncodedPacketSink(coldTrack).getPacket(packet.timestamp);
		expect(found?.timestamp).toBe(packet.timestamp);
	}
});

test('MPEG-TS gives key packets without parameter sets the ones in force before them', async () => {
	// From L15's review. In Annex B, a decoder that starts at a key frame needs the parameter sets in-band, but some
	// streams only send them with some key frames: the others rely on those sent before. Some broadcast encoders also
	// send a PPS of different content with each GOP, so it's the last ones that count, not the first. 16 stub frames,
	// a key frame every 4: frame 0 has a VPS (HEVC), an SPS and a PPS, frame 4 another PPS, frames 8 and 12 none.
	const hex = (text: string) => [...text.matchAll(/../g)].map(x => parseInt(x[0], 16));
	const annexB = (nalUnits: number[][]) => new Uint8Array(nalUnits.flatMap(nalUnit => [0, 0, 0, 1, ...nalUnit]));
	const codecs = {
		avc: {
			aud: [0x09, 0xf0], // The one the muxer writes
			parameterSets: [hex('6764000aacd3109b011000000300100000030320f1225380')],
			pps: hex('68ef8fcb'),
			otherPps: hex('68ee3c80'),
			keySlice: [0x65, 0x88, 0x80, 0x40],
			deltaSlice: [0x41, 0x9a, 0x80, 0x40],
			decoderConfig: { codec: 'avc1.64000a', codedWidth: 64, codedHeight: 64 },
		},
		hevc: {
			aud: [0x46, 0x01], // The one the muxer writes
			// Those of test/public/hevc.ts
			parameterSets: [
				hex('40010c01ffff016000000300900000030000030078959809'),
				hex('420101016000000300900000030000030078a003c08010e596566924cae6a0202036c20000030002000003003010'),
			],
			pps: hex('4401c172b46240'),
			otherPps: hex('4401c172b44240'),
			keySlice: [0x26, 0x01, 0xaf, 0x80, 0x40],
			deltaSlice: [0x02, 0x01, 0xd0, 0x80, 0x40],
			decoderConfig: { codec: 'hev1.1.6.L120.90', codedWidth: 1920, codedHeight: 1080 },
		},
	};

	for (const [codec, nal] of Object.entries(codecs) as ['avc' | 'hevc', typeof codecs.avc][]) {
		const frames = Array.from({ length: 16 }, (_, i) => {
			if (i % 4 !== 0) {
				return [nal.aud, [...nal.deltaSlice, ...new Array<number>(16).fill(i)]];
			}

			const parameterSets = i === 0 ? [...nal.parameterSets, nal.pps] : i === 4 ? [nal.otherPps] : [];
			return [nal.aud, ...parameterSets, [...nal.keySlice, ...new Array<number>(16).fill(i)]];
		});

		const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource(codec);
		output.addVideoTrack(source, { frameRate: 25 });
		await output.start();
		for (const [i, nalUnits] of frames.entries()) {
			await source.add(
				new EncodedPacket(annexB(nalUnits), i % 4 === 0 ? 'key' : 'delta', i / 25, 1 / 25),
				i === 0 ? { decoderConfig: nal.decoderConfig } : undefined,
			);
		}
		await output.finalize();
		const bytes = new Uint8Array(output.target.buffer!);

		// Frames 8 and 12 get the SPS (and VPS) of frame 0 and the PPS of frame 4, right after their access unit
		// delimiter; nothing else changes
		const expected = frames.map((nalUnits, i) => annexB(
			i === 8 || i === 12 ? [nal.aud, ...nal.parameterSets, nal.otherPps, ...nalUnits.slice(1)] : nalUnits,
		));

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}
		expect(packets.map(x => [...x.data])).toEqual(expected.map(x => [...x]));

		// A lookup on a fresh input finds them too, looking back from where it starts reading
		for (const i of [8, 12]) {
			using freshInput = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
			const freshTrack = await freshInput.getPrimaryVideoTrack();
			assert(freshTrack);
			const packet = await new EncodedPacketSink(freshTrack).getPacket(i / 25);
			expect([...packet!.data]).toEqual([...expected[i]!]);
		}
	}
});
