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
	ReadableStreamSource,
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

test('getPacket finds B-frames in a cluster that starts before the cluster preceding it', async () => {
	// x264's B-pyramid (decode order I0 P4 B2 b1 b3 ...), cut into clusters of a few blocks, each cluster's Timestamp
	// being its first block's, as FFmpeg writes when it hits its cluster size limit (-f matroska to a pipe, or high
	// bitrates). A cluster can then hold frames presented before the start of the cluster in front of it.
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
	const cluster = (timestamp: number, ...presentationTimestamps: number[]) => element(
		EBMLId.Cluster,
		element(EBMLId.Timestamp, [timestamp >> 8, timestamp & 0xff]),
		...presentationTimestamps.map((pts) => {
			const relative = pts - timestamp;
			const flags = pts === 0 ? 0x80 : 0; // Only the first frame is a key frame
			return element(EBMLId.SimpleBlock, [0x81, (relative >> 8) & 0xff, relative & 0xff, flags, 1]);
		}),
	);
	const makeFile = (...clusters: number[][]) => new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [1]),
				element(EBMLId.CodecID, ascii('V_MPEG4/ISO/AVC')),
				element(EBMLId.DefaultDuration, [0x02, 0x62, 0x5a, 0x00]), // 40 ms
				element(EBMLId.Video, element(EBMLId.PixelWidth, [16]), element(EBMLId.PixelHeight, [16])),
			)),
			...clusters,
		),
	]);

	const lookUp = async (file: Uint8Array, timestamps: number[]) => {
		using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const sink = new EncodedPacketSink(track);

		const found: number[] = [];
		for (const timestamp of timestamps) {
			found.push((await sink.getPacket(timestamp))!.timestamp);
		}
		return found;
	};

	// The 40 ms frame sits two clusters after the key frame, behind a cluster starting at 80 ms
	const forward = makeFile(cluster(0, 0), cluster(160, 160, 80), cluster(40, 40, 120));
	for (const timestamp of [0, 0.04, 0.08, 0.12, 0.16]) {
		expect(await lookUp(forward, [timestamp])).toEqual([timestamp]);
	}

	// Once a lookup has cached the cluster at 280 ms, the 320 ms frame two clusters before it must still be found
	const backward = makeFile(cluster(0, 0), cluster(40, 40, 120, 320), cluster(240, 240, 200), cluster(280, 280, 480));
	expect(await lookUp(backward, [0.28, 0.32])).toEqual([0.28, 0.32]);

	// FFmpeg's cluster size limit cut the last GOP after its last P frame (240 ms), so the last cluster only holds the
	// B-frame presented before it (200 ms). Once a lookup has cached that cluster, the packet presented last (as
	// computeDuration looks it up) must still be the P frame.
	const lastGop = makeFile(cluster(0, 0, 120, 40, 80), cluster(160, 240, 160), cluster(200, 200));
	expect(await lookUp(lastGop, [0.2, Infinity])).toEqual([0.2, 0.24]);
	expect(await lookUp(lastGop, [Infinity])).toEqual([0.24]);
	{
		using input = new Input({ source: new BufferSource(lastGop), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		await new EncodedPacketSink(track).getPacket(0.2);
		expect(await track.computeDuration()).toBe(0.28);
	}

	// Control: the same frames, cut only in front of the P frames
	const control = makeFile(cluster(0, 0), cluster(160, 160, 80, 40, 120));
	expect(await lookUp(control, [0, 0.04, 0.08, 0.12, 0.16])).toEqual([0, 0.04, 0.08, 0.12, 0.16]);
});

test('getPacket in a long GOP with B-frames doesn\'t rescan the clusters since its key frame', async () => {
	// 5 minutes at 25 fps with a single key frame (x264 keyint=infinite, long screen recordings), B-frames (decode
	// order I0 P3 B1 B2 P6 B4 B5 ...), 8 blocks per cluster, 200-byte frames, no Cues (piped output)
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

	const frameCount = 7500;
	const order: number[] = [0];
	for (let i = 3; i < frameCount; i += 3) {
		order.push(i, i - 2, i - 1);
	}

	const clusters: number[][] = [];
	for (let i = 0; i < order.length; i += 8) {
		const timestamps = order.slice(i, i + 8).map(n => n * 40);
		const base = timestamps[0]!;
		clusters.push(element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [(base >>> 16) & 0xff, (base >>> 8) & 0xff, base & 0xff]),
			...timestamps.map(timestamp => element(EBMLId.SimpleBlock, [
				0x81,
				((timestamp - base) >> 8) & 0xff,
				(timestamp - base) & 0xff,
				timestamp === 0 ? 0x80 : 0,
				...new Array<number>(200).fill(1),
			])),
		));
	}

	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [1]),
				element(EBMLId.CodecID, ascii('V_MPEG4/ISO/AVC')),
				element(EBMLId.Video, element(EBMLId.PixelWidth, [16]), element(EBMLId.PixelHeight, [16])),
			)),
			...clusters,
		),
	]);

	let bytesRead = 0;
	using input = new Input({
		source: new CustomSource({
			getSize: () => file.byteLength,
			read: (start, end) => {
				bytesRead += end - start;
				return file.subarray(start, end);
			},
			maxCacheSize: 2 ** 16,
		}),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	// Learn every cluster
	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		void packet;
	}

	bytesRead = 0;
	let seed = 1;
	for (let i = 0; i < 100; i++) {
		seed = (seed * 16807) % 2147483647;
		const timestamp = (seed % 299000) / 1000;
		const packet = await sink.getPacket(timestamp, { metadataOnly: true });
		// Frames are 40 ms apart, so the match is at most 40 ms before the timestamp
		expect(timestamp - packet!.timestamp).toBeLessThan(0.04 + 1e-9);
		expect(packet!.timestamp).toBeLessThanOrEqual(timestamp + 1e-9);
	}

	// A lookup needs the clusters around the timestamp (a few KiB each), not all of them since the key frame (about
	// 830 KiB per lookup on average)
	expect(bytesRead / 100).toBeLessThan(64 * 1024);
}, 120_000);

test('B-frame lookups on a stream don\'t need clusters the stream no longer holds', async () => {
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
	const cluster = (timestamp: number, frames: [number, number][]) => element(
		EBMLId.Cluster,
		element(EBMLId.Timestamp, [timestamp >> 8, timestamp & 0xff]),
		...frames.map(([pts, size]) => element(EBMLId.SimpleBlock, [
			0x81,
			((pts - timestamp) >> 8) & 0xff,
			(pts - timestamp) & 0xff,
			pts === 0 ? 0x80 : 0,
			...new Array<number>(size).fill(0),
		])),
	);
	const makeFile = (...clusters: number[][]) => new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [1]),
				element(EBMLId.CodecID, ascii('V_MPEG4/ISO/AVC')),
				element(EBMLId.DefaultDuration, [0x02, 0x62, 0x5a, 0x00]), // 40 ms
				element(EBMLId.Video, element(EBMLId.PixelWidth, [16]), element(EBMLId.PixelHeight, [16])),
			)),
			...clusters,
		),
	]);

	// Decode order I0 P120 B40 B80 P240 ... P1200, in a 580 kB cluster, and then the B-frames 1120 and 1160 in what
	// follows: the frame presented last (P1200) sits in a cluster more than the stream's cache size before the end
	const frames: [number, number][] = [[0, 20_000]];
	for (let p = 120; p <= 1200; p += 120) {
		frames.push([p, 20_000], [p - 80, 20_000], [p - 40, 20_000]);
	}
	const head = frames.slice(0, -2);

	const lookUpStreamed = async (file: Uint8Array) => {
		let offset = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull: (controller) => {
				if (offset >= file.length) {
					controller.close();
					return;
				}

				controller.enqueue(file.slice(offset, offset + 2 ** 16));
				offset += 2 ** 16;
			},
		});

		using input = new Input({
			source: new ReadableStreamSource(stream, { maxCacheSize: 2 ** 18 }),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		// Like computeDuration, the second lookup looks for the frame presented last
		const duration = await track.computeDuration();
		const last = await new EncodedPacketSink(track).getPacket(Infinity, { metadataOnly: true });
		return [duration, last!.timestamp];
	};

	// The two clusters read last are kept, so the second lookup finds P1200 again without reading
	expect(await lookUpStreamed(makeFile(cluster(0, head), cluster(1120, [[1120, 100], [1160, 100]]))))
		.toEqual([1.24, 1.2]);

	// When the cluster holding it isn't among them, the stream can't give it again, and the lookup does without it
	// instead of failing, as it did before B-frames were looked for: it finds the frame presented last in what follows
	const split = makeFile(cluster(0, head), cluster(1120, [[1120, 100]]), cluster(1160, [[1160, 100]]));
	expect(await lookUpStreamed(split)).toEqual([1.24, 1.16]);
});
