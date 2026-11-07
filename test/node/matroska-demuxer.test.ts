import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
	ALL_FORMATS,
	BufferSource,
	CustomSource,
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

test('VP9 codec string follows the Colour element', async () => {
	// ffmpeg -f lavfi -i testsrc2=size=176x144:rate=25 -frames:v 1 -c:v libvpx-vp9 -deadline realtime
	//   -pix_fmt yuv420p10le -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc
	//   -fflags +bitexact out.webm
	const filePath = path.join(__dirname, '..', 'public/vp9-hdr10-pq.webm');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;

	// The bitstream only says BT.2020, the Colour element says that the transfer is PQ
	expect((await track.getDecoderConfig())!.colorSpace!.transfer).toBe('pq');
	expect(await track.getCodecParameterString()).toBe('vp09.02.10.10.01.09.16.09.00');
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

test('getPacket finds the first block of a cluster that starts before the previous one ends', async () => {
	// 60 fps as FFmpeg writes it: millisecond timestamps rounded from multiples of 16.667 ms, a 16.667 ms
	// DefaultDuration, and (with long GOPs) clusters that begin mid-GOP. The last block of the first cluster, at 67 ms,
	// lasts until 83.667 ms (or 84 ms with a rounded DefaultDuration), past the next cluster's first block at 83 ms.

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

	const block = (timestamp: number, key = false) => element(
		EBMLId.SimpleBlock,
		[0x81, 0, timestamp, key ? 0x80 : 0, 1],
	);
	const file = matroskaFile(
		element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
		element(EBMLId.Tracks, element(
			EBMLId.TrackEntry,
			element(EBMLId.TrackNumber, [1]),
			element(EBMLId.TrackType, [1]),
			element(EBMLId.CodecID, [...'V_VP8'].map(x => x.charCodeAt(0))),
			element(EBMLId.DefaultDuration, [0x00, 0xfe, 0x50, 0x6b]), // 16,666,667 ns
			element(EBMLId.Video, element(EBMLId.PixelWidth, [16]), element(EBMLId.PixelHeight, [16])),
		)),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [0]),
			block(0, true), block(17), block(33), block(50), block(67),
		),
		element(EBMLId.Cluster, element(EBMLId.Timestamp, [83]), block(0), block(17)),
	);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	for (const timestamp of [0, 0.017, 0.033, 0.05, 0.067, 0.083, 0.1]) {
		const packet = await sink.getPacket(timestamp);
		expect(packet?.timestamp).toBe(timestamp);
	}
});

test('getPacket finds B-frames that straddle a cluster boundary', async () => {
	// Clusters cut mid-GOP, as FFmpeg does in live mode or at its cluster size/time limits: the first cluster ends
	// with the P frame at 120 ms, the B-frames presented before it (40, 80 ms) start the next cluster

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

	const simpleBlock = (timestamp: number, key = false) => element(
		EBMLId.SimpleBlock,
		[0x81, (timestamp >> 8) & 0xff, timestamp & 0xff, key ? 0x80 : 0, 1],
	);
	// A BlockGroup declaring a 40 ms BlockDuration; non-key frames reference another frame
	const blockGroup = (timestamp: number, key = false) => element(
		EBMLId.BlockGroup,
		element(EBMLId.Block, [0x81, (timestamp >> 8) & 0xff, timestamp & 0xff, 0, 1]),
		element(EBMLId.BlockDuration, [40]),
		key ? [] : element(EBMLId.ReferenceBlock, [0xd8]), // -40
	);

	const makeFile = (defaultDuration: number[][], block: typeof simpleBlock) => matroskaFile(
		element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
		element(EBMLId.Tracks, element(
			EBMLId.TrackEntry,
			element(EBMLId.TrackNumber, [1]),
			element(EBMLId.TrackType, [1]),
			element(EBMLId.CodecID, [...'V_MPEG4/ISO/AVC'].map(x => x.charCodeAt(0))),
			...defaultDuration,
			element(EBMLId.Video, element(EBMLId.PixelWidth, [16]), element(EBMLId.PixelHeight, [16])),
		)),
		element(EBMLId.Cluster, element(EBMLId.Timestamp, [0]), block(0, true), block(120)),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [40]),
			block(0), block(40), block(200), block(120), block(160),
		),
	);

	const files = [
		makeFile([element(EBMLId.DefaultDuration, [0x02, 0x62, 0x5a, 0x00])], simpleBlock), // 40 ms
		makeFile([], simpleBlock), // DefaultDuration is optional
		// A nominal DefaultDuration of 120 ms, which the blocks' own BlockDurations of 40 ms override
		makeFile([element(EBMLId.DefaultDuration, [0x07, 0x27, 0x0e, 0x00])], blockGroup),
	];

	const checkLookups = async (file: Uint8Array, order: number[]) => {
		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const sink = new EncodedPacketSink(track);
		for (const timestamp of order) {
			expect((await sink.getPacket(timestamp))!.timestamp).toBe(timestamp);
		}
	};

	const timestamps = [0, 0.04, 0.08, 0.12, 0.16, 0.2, 0.24];
	for (const file of files) {
		await checkLookups(file, timestamps);
		await checkLookups(file, [...timestamps].reverse());
	}
});
