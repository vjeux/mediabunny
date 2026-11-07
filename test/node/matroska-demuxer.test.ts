import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
	ALL_FORMATS,
	BufferSource,
	CustomSource,
	EncodedPacket,
	EncodedPacketSink,
	FilePathSource,
	Input,
} from '../../src/index.js';
import { assert } from '../../src/misc.js';
import { EBMLId } from '../../src/matroska/ebml.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Zero-width unsigned integers', async () => {
	const filePath = path.join(__dirname, '..', 'public/zero-width-uint.webm');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	expect(await input.getTracks()).toHaveLength(1);
});

test('Zero timestamp scale', async () => {
	const filePath = path.join(__dirname, '..', 'public/zero-timestamp-scale.webm');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	await expect(input.getTracks()).rejects.toThrow(/TimestampScale/);
});

test('Concurrent metadata tag reads', async () => {
	const filePath = path.join(__dirname, '..', 'public/tags-after-clusters.webm');
	const buffer = await fs.promises.readFile(filePath);

	// Async reads, so that both calls are in the middle of loading the tags at the same time
	using input = new Input({
		source: new CustomSource({
			getSize: async () => buffer.byteLength,
			read: async (start, end) => buffer.subarray(start, end),
		}),
		formats: ALL_FORMATS,
	});

	const [first, second] = await Promise.all([input.getMetadataTags(), input.getMetadataTags()]);
	expect(first.title).toBe('Hi');
	expect(second.title).toBe('Hi');
});

test('Key packet lookup past position cache entries', async () => {
	// 0.5 s clusters with a key frame (and cue point) only every 10 s
	const filePath = path.join(__dirname, '..', 'public/sparse-keyframes-dense-clusters.mkv');
	const buffer = await fs.promises.readFile(filePath);

	let bytesRead = 0;
	using input = new Input({
		source: new CustomSource({
			getSize: () => buffer.byteLength,
			read: (start, end) => {
				bytesRead += end - start;
				return buffer.subarray(start, end);
			},
			maxCacheSize: Infinity,
		}),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	// Leaves the position cache with an entry at the start and dense entries from the cue point at 50 s up to 55.3 s
	await sink.getFirstPacket();
	await sink.getPacket(55.3);

	bytesRead = 0;
	const keyPacket = await sink.getKeyPacket(55.29);
	expect(keyPacket?.timestamp).toBe(50);
	expect(bytesRead).toBeLessThan(0.05 * buffer.byteLength);
});

test('Laced Vorbis frames get their own durations', async () => {
	// Vorbis at 8 kHz with 256/2048-sample blocks, one tick per sample. A frame lasts (previous block size + its own
	// block size) / 4 samples: 128 for short after short, 576 for a short and a long block, 1024 for long after long.

	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const matroskaFile = (...segmentChildren: number[][]) => new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, [...'matroska'].map(x => x.charCodeAt(0)))),
		...element(EBMLId.Segment, segmentChildren.flat()),
	]);

	const ascii = (text: string) => [...text].map(x => x.charCodeAt(0));
	const identificationHeader = [
		1, ...ascii('vorbis'), 0, 0, 0, 0, 1, 0x40, 0x1f, 0, 0, // Version 0, mono, 8000 Hz
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // Bitrates
		0xb8, 1, // Block sizes 2^8 and 2^11, framing bit
	];
	const commentHeader = [3, ...ascii('vorbis'), 0, 0, 0, 0, 0, 0, 0, 0, 1];
	// Ends with two modes: mode 0 uses short blocks, mode 1 long ones
	const setupHeader = [5, ...ascii('vorbis'), 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0x80, 0, 0, 0, 0, 0, 1];

	const SHORT = 0x00; // Mode 0
	const LONG_AFTER_SHORT = 0x02; // Mode 1, previous window flag clear
	const LONG_AFTER_LONG = 0x06; // Mode 1, previous window flag set

	const block = (relativeTimestamp: number, frames: number[]) => element(EBMLId.SimpleBlock, [
		0x81, relativeTimestamp >> 8, relativeTimestamp & 0xff,
		...(frames.length > 1
			? [0x80 | 0x02, frames.length - 1, ...frames.slice(0, -1).map(() => 2)] // Xiph lacing, 2-byte frames
			: [0x80]),
		...frames.flatMap(x => [x, 0xaa]),
	]);

	const header = [
		element(EBMLId.Info, element(EBMLId.TimestampScale, [0x01, 0xe8, 0x48])), // 125 us = 1 sample
		element(EBMLId.Tracks, element(
			EBMLId.TrackEntry,
			element(EBMLId.TrackNumber, [1]),
			element(EBMLId.TrackType, [2]),
			element(EBMLId.CodecID, ascii('A_VORBIS')),
			element(EBMLId.CodecPrivate, [
				2, identificationHeader.length, commentHeader.length,
				...identificationHeader, ...commentHeader, ...setupHeader,
			]),
			element(EBMLId.Audio, element(EBMLId.SamplingFrequency, [0x45, 0xfa, 0, 0]), element(EBMLId.Channels, [1])),
		)),
	];

	const readTimings = async (file: Uint8Array) => {
		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		return {
			timestamps: packets.map(x => x.timestamp * 8000),
			durations: packets.map(x => x.duration * 8000),
		};
	};

	const file = matroskaFile(
		...header,
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [0]),
			block(0, [SHORT, LONG_AFTER_SHORT, LONG_AFTER_LONG, SHORT]), // 128 + 576 + 1024 + 576 samples
			// The cluster's last block, unlaced, has no block after it to take its duration from: its 576 samples
			block(2304, [LONG_AFTER_SHORT]),
		),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [0x0b, 0x40]), // 2880
			// The first frame follows a long block from the previous cluster, so it lasts 576 samples. The frames'
			// 704 samples don't fit before the next block (some muxers round timestamps so that blocks overlap), so
			// they're squeezed into its 600, keeping the timestamps in order.
			block(0, [SHORT, SHORT]),
			// The cluster's last block has no BlockDuration: its frames last as long as they say (384 samples), but
			// not past the next cluster 168 samples later, so they're squeezed too
			block(600, [SHORT, SHORT, SHORT]),
		),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [0x0e, 0x40]), // 3648
			block(0, [SHORT, SHORT]), // At the end of the file, the frames last as long as they say
		),
	);

	const { timestamps, durations } = await readTimings(file);
	expect(timestamps).toEqual([
		0, 128, 704, 1728, 2304, // First cluster
		2880, 3370, 3480, 3536, 3592, // Second cluster
		3648, 3776, // Last cluster
	]);
	expect(durations).toEqual([128, 576, 1024, 576, 576, 490, 110, 56, 56, 56, 128, 128]);

	// Without lacing, as FFmpeg writes Vorbis: each cluster's last block lasts as long as its block sizes say
	expect(await readTimings(matroskaFile(
		...header,
		element(EBMLId.Cluster, element(EBMLId.Timestamp, [0]), block(0, [SHORT]), block(128, [LONG_AFTER_SHORT])),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [0x02, 0xc0]), // 704
			block(0, [LONG_AFTER_LONG]),
			block(1024, [SHORT]),
		),
	))).toEqual({ timestamps: [0, 128, 704, 1728], durations: [128, 576, 1024, 576] });
});

test('Laced Opus frames at the end of a cluster get their own durations', async () => {
	// The last block of a cluster without BlockDuration or DefaultDuration (as in Firefox's and mkvmerge's files) used
	// to give all its frames the block's timestamp and duration 0. Opus frames tell their own duration.
	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const ascii = (text: string) => [...text].map(x => x.charCodeAt(0));
	const opus20ms = [0xfc, 0xff];
	const opus60ms = [0x18, 0xff];
	const lace = (relativeTimestamp: number, frames: number[][]) => element(EBMLId.SimpleBlock, [
		0x81, 0, relativeTimestamp, 0x80 | 0x02, // Key frame, Xiph lacing
		frames.length - 1, ...frames.slice(0, -1).map(x => x.length),
		...frames.flat(),
	]);

	const readTimings = async (...clusters: number[][]) => {
		const file = new Uint8Array([
			...element(EBMLId.EBML, element(EBMLId.DocType, ascii('webm'))),
			...element(
				EBMLId.Segment,
				element(EBMLId.Tracks, element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, ascii('A_OPUS')),
					element(EBMLId.CodecPrivate, [...ascii('OpusHead'), 1, 2, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0]),
				)),
				...clusters,
			),
		]);

		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		// The duration of the last packet, an unlaced block at the end of the file, isn't what's tested here
		return packets.map((x, i) => [x.timestamp, i === packets.length - 1 ? null : x.duration]);
	};

	expect(await readTimings(
		// 100 ms of frames, which fit before the track's next block
		element(EBMLId.Cluster, element(EBMLId.Timestamp, [0]), lace(0, [opus20ms, opus20ms, opus60ms])),
		// 80 ms of frames, but the track's next block starts 50 ms later, so they're squeezed to fit
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [100]),
			lace(0, [opus20ms, opus20ms, opus20ms, opus20ms]),
		),
		// FFmpeg writes a CRC-32 before the Timestamp
		element(
			EBMLId.Cluster,
			element(0xbf, [0, 0, 0, 0]),
			element(EBMLId.Timestamp, [150]),
			element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, ...opus20ms]),
		),
	)).toEqual([
		[0, 0.02], [0.02, 0.02], [0.04, 0.06],
		[0.1, 0.012], [0.112, 0.013], [0.125, 0.012], [0.137, 0.013],
		[0.15, null],
	]);

	// The next cluster's timestamp only serves as the base of its blocks' relative timestamps, so it's the track's
	// next block, not the cluster's start, that bounds the lace (here 70 ms after the base, as when the next cluster
	// starts with another track's block)
	expect(await readTimings(
		element(EBMLId.Cluster, element(EBMLId.Timestamp, [0]), lace(0, [opus20ms, opus20ms, opus20ms])),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [30]),
			element(EBMLId.SimpleBlock, [0x81, 0, 70, 0x80, ...opus20ms]),
		),
	)).toEqual([[0, 0.02], [0.02, 0.02], [0.04, 0.02], [0.1, null]]);
});
