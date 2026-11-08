import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	Conversion,
	CustomSource,
	EncodedPacket,
	EncodedAudioPacketSource,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	ReadableStreamSource,
	MATROSKA,
	MkvOutputFormat,
	Output,
	WebMOutputFormat,
	Mp4OutputFormat,
} from '../../src/index.js';
import { assert, toUint8Array } from '../../src/misc.js';
import { EBMLId } from '../../src/matroska/ebml.js';
import { parseAacAudioSpecificConfig } from '../../shared/aac-misc.js';

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

test('Deprecated A_AAC codec IDs without CodecPrivate', async () => {
	// Old mkvmerge versions named the AAC profile in the codec ID and wrote no AudioSpecificConfig
	const element = (id: number[], ...parts: ArrayLike<number>[]) => {
		const content = parts.flatMap(part => Array.from(part));
		const size = [0x01, 0, 0, 0, 0, 0, content.length >> 8, content.length & 0xff]; // 8-byte vint
		return [...id, ...size, ...content];
	};
	const float64 = (value: number) => {
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setFloat64(0, value);
		return bytes;
	};
	const file = (codecId: string, outputSamplingFrequency: number | null = null) => new Uint8Array([
		...element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], [...'matroska'].map(char => char.charCodeAt(0)))),
		...element([0x18, 0x53, 0x80, 0x67],
			element([0x16, 0x54, 0xae, 0x6b], element([0xae],
				element([0xd7], [1]), // TrackNumber
				element([0x83], [2]), // TrackType: audio
				element([0x86], [...codecId].map(char => char.charCodeAt(0))),
				element([0xe1],
					element([0xb5], float64(22050)), // SamplingFrequency
					...(outputSamplingFrequency === null
						? []
						: [element([0x78, 0xb5], float64(outputSamplingFrequency))]), // OutputSamplingFrequency
					element([0x9f], [2]), // Channels: stereo
				),
			)),
			element([0x1f, 0x43, 0xb6, 0x75], element([0xe7], [0]), element([0xa3], [0x81, 0, 0, 0x80, 0x21, 0x10])),
		),
	]);

	const expectations = [
		['A_AAC/MPEG4/LC/SBR', 'mp4a.40.5'],
		['A_AAC/MPEG4/LC', 'mp4a.40.2'],
		['A_AAC/MPEG4/MAIN', 'mp4a.40.1'],
		['A_AAC/MPEG4/LTP', 'mp4a.40.4'],
		['A_AAC/MPEG2/LC', 'mp4a.67'],
	];
	for (const [codecId, codecString] of expectations) {
		using input = new Input({ source: new BufferSource(file(codecId!)), formats: ALL_FORMATS });
		const track = (await input.getAudioTracks())[0];
		assert(track);

		expect(await track.getCodec()).toBe('aac');
		expect(await track.getCodecParameterString()).toBe(codecString);
		expect(await input.getMimeType()).toBe(`audio/x-matroska; codecs="${codecString}"`);
	}

	// SamplingFrequency is the core coder's rate, and OutputSamplingFrequency (defaulting to it) the rate after SBR
	const rates = [
		// Codec ID, OutputSamplingFrequency, expected core rate, expected output rate
		['A_AAC/MPEG4/LC', 22050, 22050, 22050],
		['A_AAC/MPEG4/LC/SBR', 44100, 22050, 44100],
		['A_AAC/MPEG4/LC/SBR', 22050, 22050, 22050], // Downsampled SBR
		['A_AAC/MPEG4/LC/SBR', null, 22050, 22050],
	] as const;
	for (const [codecId, outputSamplingFrequency, coreSampleRate, outputSampleRate] of rates) {
		using input = new Input({
			source: new BufferSource(file(codecId, outputSamplingFrequency)),
			formats: ALL_FORMATS,
		});
		const track = (await input.getAudioTracks())[0];
		assert(track);

		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig?.description);
		const audioSpecificConfig = parseAacAudioSpecificConfig(toUint8Array(decoderConfig.description));
		expect(audioSpecificConfig.coreSampleRate).toBe(coreSampleRate);
		expect(audioSpecificConfig.outputSampleRate).toBe(outputSampleRate);
		expect(decoderConfig.sampleRate).toBe(outputSampleRate);
		expect(await track.getSampleRate()).toBe(outputSampleRate);
	}
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

test('EBML header with Void padding or a DocTypeExtension', async () => {
	// Both may be larger than the 8 bytes an integer element can have

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
	const docTypeExtension = element(
		0x4281, // DocTypeExtension
		element(0x4283, ascii('extension-name')), // DocTypeExtensionName
		element(0x4284, [1]), // DocTypeExtensionVersion
	);

	for (const extra of [element(EBMLId.Void, new Array<number>(16).fill(0)), docTypeExtension]) {
		const file = new Uint8Array([
			...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska')), extra),
			...element(EBMLId.Segment, element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [2]),
				element(EBMLId.CodecID, ascii('A_AC3')),
			))),
		]);

		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});

		expect(await input.getTracks()).toHaveLength(1);
	}
});

test('TrackType after the Video or Audio element', async () => {
	// Element order within a TrackEntry is free

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
	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		...element(EBMLId.Segment, element(
			EBMLId.Tracks,
			element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.Video, element(EBMLId.PixelWidth, [0x01, 0x40]), element(EBMLId.PixelHeight, [0xf0])),
				element(EBMLId.CodecID, ascii('V_VP8')),
				element(EBMLId.TrackType, [1]),
			),
			element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [2]),
				element(
					EBMLId.Audio,
					element(EBMLId.SamplingFrequency, [0x47, 0x3b, 0x80, 0]), // 48000
					element(EBMLId.Channels, [2]),
				),
				element(EBMLId.CodecID, ascii('A_AC3')),
				element(EBMLId.TrackType, [2]),
			),
		)),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getCodedWidth()).toBe(320);
	expect(await videoTrack.getCodedHeight()).toBe(240);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getSampleRate()).toBe(48000);
	expect(await audioTrack.getNumberOfChannels()).toBe(2);
});

test('Nested SimpleTags', async () => {
	// Nested SimpleTags describe their parent, as in the Matroska tagging examples

	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const utf8 = (text: string) => [...new TextEncoder().encode(text)];
	const simpleTag = (...children: number[][]) => element(EBMLId.SimpleTag, ...children);
	const tagName = (name: string) => element(EBMLId.TagName, utf8(name));
	const tagString = (value: string) => element(EBMLId.TagString, utf8(value));

	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, utf8('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [2]),
				element(EBMLId.CodecID, utf8('A_AC3')),
			)),
			element(EBMLId.Tags, element(
				EBMLId.Tag,
				element(EBMLId.Targets, element(EBMLId.TargetTypeValue, [50])),
				simpleTag(
					tagName('ARTIST'),
					simpleTag(tagName('SORT_WITH'), tagString('Beatles, The')),
					tagString('The Beatles'),
				),
				simpleTag(tagName('ORIGINAL'), simpleTag(tagName('TITLE'), tagString('Original title'))),
				simpleTag(tagName('TITLE'), tagString('Title')),
				// Element order within a SimpleTag is free: the nested tag and the value may come before the name
				simpleTag(
					simpleTag(tagName('SORT_WITH'), tagString('Brel, Jacques')),
					tagString('Jacques Brel'),
					tagName('COMPOSER'),
				),
				simpleTag(tagString('Some album'), tagName('ALBUM')),
			)),
		),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const tags = await input.getMetadataTags();
	expect(tags.artist).toBe('The Beatles');
	expect(tags.title).toBe('Title');
	expect(tags.album).toBe('Some album');
	expect(tags.raw).toMatchObject({
		'ARTIST/SORT_WITH': 'Beatles, The',
		'ORIGINAL/TITLE': 'Original title',
		'COMPOSER': 'Jacques Brel',
		'COMPOSER/SORT_WITH': 'Brel, Jacques',
	});
});

test('BlockGroup children before the Block', async () => {
	// Element order within a BlockGroup is free

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
	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [1]),
				element(EBMLId.CodecID, ascii('V_VP8')),
				element(
					EBMLId.Video,
					element(EBMLId.PixelWidth, [16]),
					element(EBMLId.PixelHeight, [16]),
					element(EBMLId.AlphaMode, [1]),
				),
			)),
			element(
				EBMLId.Cluster,
				element(EBMLId.Timestamp, [0]),
				element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, 1]),
				element(
					EBMLId.BlockGroup,
					element(EBMLId.BlockDuration, [25]),
					element(EBMLId.ReferenceBlock, [0xd8]), // -40
					element(EBMLId.BlockAdditions, element(
						EBMLId.BlockMore,
						element(EBMLId.BlockAddID, [1]),
						element(EBMLId.BlockAdditional, [9, 9]),
					)),
					element(EBMLId.Block, [0x81, 0, 40, 0, 2]),
				),
			),
		),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	expect(packets.map(x => [x.timestamp, x.duration, x.type])).toEqual([[0, 0.04, 'key'], [0.04, 0.025, 'delta']]);
	expect([...packets[1]!.sideData.alpha!]).toEqual([9, 9]);
});

test('Tag with Targets after its SimpleTags', async () => {
	// Element order within a Tag is free; these tags apply to the track, not to the movie

	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const utf8 = (text: string) => [...new TextEncoder().encode(text)];
	const title = (value: string) => element(
		EBMLId.SimpleTag,
		element(EBMLId.TagName, utf8('TITLE')),
		element(EBMLId.TagString, utf8(value)),
	);
	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, utf8('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackUID, [1]),
				element(EBMLId.TrackType, [2]),
				element(EBMLId.CodecID, utf8('A_AC3')),
			)),
			element(
				EBMLId.Tags,
				element(
					EBMLId.Tag,
					title('Track'),
					element(EBMLId.Targets, element(EBMLId.TagTrackUID, [1])),
				),
				element(
					EBMLId.Tag,
					title('Movie'),
					element(EBMLId.Targets, element(EBMLId.TargetTypeValue, [50])),
				),
			),
		),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	expect((await input.getMetadataTags()).title).toBe('Movie');
});

test('Last block of a cluster without BlockDuration or DefaultDuration (Opus, PCM)', async () => {
	// As in Chrome's MediaRecorder files: no DefaultDuration, so each cluster's last block has no next block to take
	// its duration from. Opus and PCM packets tell their own duration.

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
	const block = (track: number, relativeTimestamp: number, data: number[]) => element(
		EBMLId.SimpleBlock,
		[0x80 | track, 0, relativeTimestamp, 0x80, ...data],
	);
	const opusHead = [...ascii('OpusHead'), 1, 1, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0];
	const opus20ms = [0xfc, 0xff]; // CELT, 20 ms
	const opus60ms = [0x18, 0xff]; // SILK, 60 ms

	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('webm'))),
		...element(
			EBMLId.Segment,
			element(
				EBMLId.Tracks,
				element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, ascii('A_OPUS')),
					element(EBMLId.CodecPrivate, opusHead),
				),
				element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [2]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, ascii('A_PCM/INT/LIT')),
					element(EBMLId.Audio, element(EBMLId.BitDepth, [16])), // 8000 Hz mono by default
				),
			),
			element(
				EBMLId.Cluster,
				element(EBMLId.Timestamp, [0]),
				block(1, 0, opus20ms),
				block(1, 20, opus20ms),
				block(2, 0, new Array<number>(80).fill(0)), // 40 samples = 5 ms
				block(2, 5, new Array<number>(80).fill(0)),
			),
			element(EBMLId.Cluster, element(EBMLId.Timestamp, [40]), block(1, 0, opus60ms)),
		),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const [opusTrack, pcmTrack] = await input.getAudioTracks();
	assert(opusTrack && pcmTrack);

	const durations = async (track: typeof opusTrack) => {
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		return packets.map(x => x.duration);
	};

	expect(await durations(opusTrack)).toEqual([0.02, 0.02, 0.06]);
	expect(await durations(pcmTrack)).toEqual([0.005, 0.005]);
	expect(await opusTrack.computeDuration()).toBe(0.1);
});

test('Last block of a cluster without BlockDuration or DefaultDuration (AAC, MP3, FLAC, AC-3, E-AC-3)', async () => {
	// As in FFmpeg's and OBS's Matroska output: each cluster's last block, mid-stream or at the end, takes its
	// duration from its frame

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
	const float64 = (value: number) => {
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setFloat64(0, value);
		return [...bytes];
	};

	// Blocks at 0 and 10 ms in one cluster, and at 100 ms in the next
	const readDurations = async (
		codecId: string,
		sampleRate: number,
		codecPrivate: number[] | null,
		frame: number[],
	) => {
		const block = (relativeTimestamp: number) => element(
			EBMLId.SimpleBlock,
			[0x81, 0, relativeTimestamp, 0x80, ...frame, ...new Array<number>(16).fill(0)],
		);

		const file = new Uint8Array([
			...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
			...element(
				EBMLId.Segment,
				element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
				element(EBMLId.Tracks, element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, ascii(codecId)),
					...(codecPrivate ? [element(EBMLId.CodecPrivate, codecPrivate)] : []),
					element(
						EBMLId.Audio,
						element(EBMLId.SamplingFrequency, float64(sampleRate)),
						element(EBMLId.Channels, [2]),
					),
				)),
				element(EBMLId.Cluster, element(EBMLId.Timestamp, [0]), block(0), block(10)),
				element(EBMLId.Cluster, element(EBMLId.Timestamp, [100]), block(0)),
			),
		]);

		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const durations: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			durations.push(packet.duration);
		}
		return durations;
	};

	// AAC-LC, 48 kHz: 1024 samples
	expect(await readDurations('A_AAC', 48000, [0x11, 0x90], [0x21])).toEqual([0.01, 0.021, 0.021]);
	// HE-AAC (SBR), 24 kHz core: 1024 samples at the core rate, whichever rate the track declares
	expect(await readDurations('A_AAC', 48000, [0x2b, 0x11, 0x88, 0x00], [0x21])).toEqual([0.01, 0.043, 0.043]);
	// MPEG-1 Layer III, 44.1 kHz: 1152 samples
	expect(await readDurations('A_MPEG/L3', 44100, null, [0xff, 0xfb, 0x90, 0x44])).toEqual([0.01, 0.026, 0.026]);
	// FLAC, 44.1 kHz: a common block size (4096) and an uncommon one (3276, coded after the frame number)
	expect(await readDurations('A_FLAC', 44100, null, [0xff, 0xf8, 0xc9, 0x18, 0x00, 0x00]))
		.toEqual([0.01, 0.093, 0.093]);
	expect(await readDurations('A_FLAC', 44100, null, [0xff, 0xf8, 0x79, 0x18, 0x00, 0x0c, 0xcb, 0x00]))
		.toEqual([0.01, 0.074, 0.074]);
	// AC-3, 48 kHz: 1536 samples
	expect(await readDurations('A_AC3', 48000, null, [0x0b, 0x77, 0, 0, 0x10])).toEqual([0.01, 0.032, 0.032]);
	// E-AC-3, 48 kHz, two blocks: 512 samples
	expect(await readDurations('A_EAC3', 48000, null, [0x0b, 0x77, 0x00, 0x3f, 0x10]))
		.toEqual([0.01, 0.011, 0.011]);
});

test('Cluster without a Timestamp', async () => {
	// Timestamp is mandatory in a Cluster; a broken file without it should read as if it were 0

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
	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [2]),
				element(EBMLId.CodecID, ascii('A_AC3')),
			)),
			element(
				EBMLId.Cluster,
				element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, 1]),
				element(EBMLId.SimpleBlock, [0x81, 0, 32, 0x80, 2]),
			),
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

	expect(packets.map(x => x.timestamp)).toEqual([0, 0.032]);
});

test('Unknown-size Cues and cue points', async () => {
	// Livestreamed WebM, as written by browsers (Chromium's media/test/data/bear-320x240-live.webm): the clusters, the
	// Cues and every CuePoint inside it have an unknown size
	const element = (id: number[], ...parts: ArrayLike<number>[]) => {
		const content = parts.flatMap(part => Array.from(part));
		const size = [0x01, 0, 0, 0, 0, 0, content.length >> 8, content.length & 0xff]; // 8-byte vint
		return [...id, ...size, ...content];
	};
	const unknownSizeElement = (id: number[], ...parts: ArrayLike<number>[]) => {
		return [...id, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...parts.flatMap(part => Array.from(part))];
	};
	const cluster = (timestamp: number) => unknownSizeElement(
		[0x1f, 0x43, 0xb6, 0x75],
		element([0xe7], [timestamp]),
		element([0xa3], [0x81, 0, 0, 0x80, 0x10, 0x02, 0x00]), // SimpleBlock: track 1, key frame
	);
	const bytes = new Uint8Array([
		...element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], [...'webm'].map(char => char.charCodeAt(0)))),
		...unknownSizeElement([0x18, 0x53, 0x80, 0x67],
			element([0x15, 0x49, 0xa9, 0x66], element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40])), // 1 ms ticks
			element([0x16, 0x54, 0xae, 0x6b], element([0xae],
				element([0xd7], [1]), // TrackNumber
				element([0x83], [1]), // TrackType: video
				element([0x86], [...'V_VP8'].map(char => char.charCodeAt(0))),
				element([0xe0], element([0xb0], [16]), element([0xba], [16])),
			)),
			cluster(0),
			cluster(40),
			unknownSizeElement([0x1c, 0x53, 0xbb, 0x6b], unknownSizeElement(
				[0xbb],
				element([0xb3], [0]), // CueTime
				unknownSizeElement([0xb7], element([0xf7], [1]), element([0xf1], [0])),
			)),
		),
	]);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual([0, 0.04]);
	expect((await sink.getPacket(Infinity))!.timestamp).toBe(0.04);
});

test('Official Matroska tag names for the date and the track total', async () => {
	// The Matroska tagging spec names the dates DATE_RELEASED, DATE_RECORDED, ... and the track total TOTAL_PARTS

	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const utf8 = (text: string) => [...new TextEncoder().encode(text)];
	const simpleTag = (name: string, value: string) => element(
		EBMLId.SimpleTag,
		element(EBMLId.TagName, utf8(name)),
		element(EBMLId.TagString, utf8(value)),
	);

	const fileWithTags = (...simpleTags: number[][]) => new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, utf8('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [2]),
				element(EBMLId.CodecID, utf8('A_AC3')),
			)),
			element(EBMLId.Tags, element(
				EBMLId.Tag,
				element(EBMLId.Targets, element(EBMLId.TargetTypeValue, [50])),
				...simpleTags,
			)),
		),
	]);

	const readTags = async (file: Uint8Array) => {
		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});

		return await input.getMetadataTags();
	};

	const released = await readTags(fileWithTags(
		simpleTag('DATE_RELEASED', '2019-05-01'),
		simpleTag('TOTAL_PARTS', '12'),
	));
	expect(released.date).toEqual(new Date('2019-05-01'));
	expect(released.tracksTotal).toBe(12);

	const recorded = await readTags(fileWithTags(simpleTag('DATE_RECORDED', '2018-02-03')));
	expect(recorded.date).toEqual(new Date('2018-02-03'));
});

test('Files are read whenever their read versions are supported, whatever their versions', async () => {
	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(8), 'key', 0, 1), {
		decoderConfig: { codec: 'vp8', codedWidth: 64, codedHeight: 64 },
	});
	await output.finalize();

	// Sets a one-byte value of the EBML header
	const withHeaderValue = (id: number[], value: number) => {
		const bytes = new Uint8Array(output.target.buffer!);
		const index = bytes.findIndex((_, i) => id.every((byte, j) => bytes[i + j] === byte) && bytes[i + 2] === 0x81);
		bytes[index + 3] = value;
		return bytes;
	};

	const canRead = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return await input.canRead() && await input.getFormat() === MATROSKA && (await input.getTracks()).length === 1;
	};

	// mkvmerge sets DocTypeVersion 5 when it writes Matroska v5 elements (like edition names) but leaves
	// DocTypeReadVersion at 2, since players don't need them. Readers of v4 must read such files (RFC 9559, Section 7).
	expect(await canRead(withHeaderValue([0x42, 0x87], 5))).toBe(true); // DocTypeVersion
	expect(await canRead(withHeaderValue([0x42, 0x86], 2))).toBe(true); // EBMLVersion
	expect(await canRead(withHeaderValue([0x42, 0x85], 5))).toBe(false); // DocTypeReadVersion
	expect(await canRead(withHeaderValue([0x42, 0xf7], 2))).toBe(false); // EBMLReadVersion
});

test('Blocks last their BlockDuration or the DefaultDuration, not until the next block', async () => {
	// Mediabunny itself writes a BlockGroup with a BlockDuration for every frame of a video with alpha, and a
	// DefaultDuration for a track with a frame rate
	const readBackDurations = async (timestamps: number[], options: { alpha?: boolean; frameRate?: number }) => {
		const target = new BufferTarget();
		const output = new Output({ format: new WebMOutputFormat(), target });
		const source = new EncodedVideoPacketSource('vp8');
		output.addVideoTrack(source, options.frameRate === undefined ? {} : { frameRate: options.frameRate });
		await output.start();
		for (const [i, timestamp] of timestamps.entries()) {
			const data = new Uint8Array(i === 0
				? [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x10, 0x00, 0x10, 0x00] // VP8 key frame header, 16x16
				: [0x11, 0x02]);
			const sideData = options.alpha ? { alpha: data } : undefined;
			await source.add(
				new EncodedPacket(data, i === 0 ? 'key' : 'delta', timestamp, 1 / 30, -1, undefined, sideData),
				{ decoderConfig: { codec: 'vp8', codedWidth: 16, codedHeight: 16 } },
			);
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const durations: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			durations.push(packet.duration);
		}

		// Durations are whole multiples of the time resolution, like the timestamps. (Not checked for the last block
		// of the cluster, which takes the DefaultDuration in an older code path.)
		const resolution = await track.getTimeResolution();
		for (const duration of durations.slice(0, -1)) {
			const ticks = duration * resolution;
			expect(Math.abs(ticks - Math.round(ticks))).toBeLessThan(1e-9);
		}

		return durations;
	};

	// The frame before the gap used to last 134 ms, until the next frame, despite its BlockDuration of 33 ms
	const withGap = await readBackDurations([0, 0.033, 0.066, 0.2, 0.233], { alpha: true });
	expect(withGap.map(duration => Math.round(duration * 1000))).toEqual([33, 33, 33, 33, 33]);

	// The millisecond timestamps of 29.97 fps video used to give durations of 33 and 34 ms instead of the
	// DefaultDuration of 33.3667 ms, which is 33 ms in whole ticks of the 1 ms timestamp scale
	const ntscTimestamps = [0, 1, 2, 3, 4].map(i => i * 1001 / 30000);
	const constantRate = await readBackDurations(ntscTimestamps, { frameRate: 30000 / 1001 });
	expect(constantRate.slice(0, -1)).toEqual([0.033, 0.033, 0.033, 0.033]);
});

// Builders for hand-made Matroska files. Every element gets an 8-byte size.
const mkvElement = (id: number[], ...parts: (number[] | Uint8Array)[]) => {
	const size = parts.reduce((sum, part) => sum + part.length, 0);
	const sizeBytes = [0x01, 0, 0, 0, size >>> 24, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff];
	return [...id, ...sizeBytes, ...parts.flatMap(part => [...part])];
};
const mkvUint = (id: number[], value: number) => mkvElement(
	id,
	[value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff],
);
const mkvAscii = (text: string) => [...text].map(char => char.charCodeAt(0));
/** A Matroska file with a 1 ms timestamp scale. */
const buildMkv = (tracks: number[][], clusters: number[][]) => new Uint8Array([
	...mkvElement([0x1a, 0x45, 0xdf, 0xa3], mkvElement([0x42, 0x82], mkvAscii('matroska'))), // EBML header
	...mkvElement(
		[0x18, 0x53, 0x80, 0x67], // Segment
		mkvElement([0x15, 0x49, 0xa9, 0x66], mkvUint([0x2a, 0xd7, 0xb1], 1_000_000)), // Info with TimestampScale
		mkvElement([0x16, 0x54, 0xae, 0x6b], ...tracks), // Tracks
		...clusters,
	),
]);

test('Laced blocks spread their frames over the gap to the next block', async () => {
	// As in a broadcast recording remuxed to MKV: eight audio frames of 32 ms per block, blocks 256 ms apart, and a
	// DefaultDuration of 192 ms that can't be the duration of each frame. The frames must stay 32 ms apart instead of
	// following the DefaultDuration into the next block.
	const frameSize = 512; // 32 ms of 16-bit mono PCM at 8 kHz
	const lacedBlock = (relativeTimestamp: number) => mkvElement(
		[0xa3], // SimpleBlock
		[0x81, relativeTimestamp >> 8, relativeTimestamp & 0xff, 0x84, 8 - 1], // Track 1, key frame, fixed-size lacing
		new Uint8Array(8 * frameSize),
	);
	const bytes = buildMkv(
		[mkvElement(
			[0xae], // TrackEntry
			mkvUint([0xd7], 1),
			mkvUint([0x73, 0xc5], 1),
			mkvUint([0x83], 2),
			mkvElement([0x86], mkvAscii('A_PCM/INT/LIT')),
			mkvUint([0x23, 0xe3, 0x83], 192_000_000), // DefaultDuration
			mkvElement(
				[0xe1], // Audio
				mkvElement([0xb5], [0x40, 0xbf, 0x40, 0, 0, 0, 0, 0]), // SamplingFrequency 8000
				mkvUint([0x9f], 1), // Channels
				mkvUint([0x62, 0x64], 16), // BitDepth
			),
		)],
		[mkvElement([0x1f, 0x43, 0xb6, 0x75], mkvUint([0xe7], 0), lacedBlock(0), lacedBlock(256), lacedBlock(512))],
	);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packets: [number, number][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([Math.round(packet.timestamp * 1000), Math.round(packet.duration * 1000)]);
	}
	expect(packets.slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, i) => [32 * i, 32]));
});

test('A BlockDuration of 0 is the block\'s duration, not a missing one', async () => {
	// Only an absent BlockDuration is inferred, from the DefaultDuration or the next block (RFC 9559). Chromium also
	// takes 0 as the duration.
	const videoTrack = (trackNumber: number, ...extra: number[][]) => mkvElement(
		[0xae], // TrackEntry
		mkvUint([0xd7], trackNumber),
		mkvUint([0x73, 0xc5], trackNumber),
		mkvUint([0x83], 1),
		mkvElement([0x86], mkvAscii('V_VP8')),
		mkvElement([0xe0], mkvUint([0xb0], 16), mkvUint([0xba], 16)), // Video: 16x16
		...extra,
	);
	const blockGroup = (trackNumber: number, relativeTimestamp: number, blockDuration: number | null) => mkvElement(
		[0xa0], // BlockGroup
		mkvElement([0xa1], [0x80 | trackNumber, relativeTimestamp >> 8, relativeTimestamp & 0xff, 0, 0]), // Block
		...(blockDuration === null ? [] : [mkvUint([0x9b], blockDuration)]), // BlockDuration
	);
	const bytes = buildMkv(
		[videoTrack(1), videoTrack(2, mkvUint([0x23, 0xe3, 0x83], 10_000_000))], // Track 2: DefaultDuration 10 ms
		[mkvElement(
			[0x1f, 0x43, 0xb6, 0x75], // Cluster
			mkvUint([0xe7], 0),
			blockGroup(1, 0, 0),
			blockGroup(1, 20, 1),
			blockGroup(1, 40, 0),
			blockGroup(2, 0, 0),
			blockGroup(2, 20, null),
			blockGroup(2, 40, 0),
		)],
	);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const durations: Record<number, number[]> = {};
	for (const track of await input.getVideoTracks()) {
		const trackDurations: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			trackDurations.push(Math.round(packet.duration * 1000));
		}
		durations[track.number] = trackDurations;
	}

	// The zero durations used to become the 20 ms gap to the next block, or the DefaultDuration
	expect(durations).toEqual({ 1: [0, 1, 0], 2: [0, 10, 0] });
});

test('An invalid SamplingFrequency or Channels value only affects its own track', async () => {
	// Like samples.ffmpeg.org's matroska+h264+ac3+dvdsub+NoDuration.mkv, whose AC-3 track has a SamplingFrequency of
	// 0.0. The values are ignored like missing elements (8000 Hz, mono by default) instead of failing the whole file.
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
	const audioTrack = (trackNumber: number, audio: number[]) => element(
		EBMLId.TrackEntry,
		element(EBMLId.TrackNumber, [trackNumber]),
		element(EBMLId.TrackType, [2]),
		element(EBMLId.CodecID, ascii('A_AC3')),
		element(EBMLId.Audio, audio),
	);

	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		...element(
			EBMLId.Segment,
			element(
				EBMLId.Tracks,
				element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [1]),
					element(EBMLId.CodecID, ascii('V_VP8')),
					element(EBMLId.Video, element(EBMLId.PixelWidth, [16]), element(EBMLId.PixelHeight, [16])),
				),
				audioTrack(2, [
					...element(EBMLId.SamplingFrequency, [0, 0, 0, 0]), // 0.0 as a 4-byte float
					...element(EBMLId.Channels, [2]),
				]),
				audioTrack(3, [
					...element(EBMLId.SamplingFrequency, [0x47, 0x3b, 0x80, 0]), // 48000
					...element(EBMLId.Channels, [0]),
				]),
			),
			element(
				EBMLId.Cluster,
				element(EBMLId.Timestamp, [0]),
				element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, 1]),
				element(EBMLId.SimpleBlock, [0x82, 0, 0, 0x80, 2]),
				element(EBMLId.SimpleBlock, [0x83, 0, 0, 0x80, 3]),
			),
		),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks.map(x => x.type)).toEqual(['video', 'audio', 'audio']);

	const [zeroRate, zeroChannels] = await input.getAudioTracks();
	assert(zeroRate && zeroChannels);
	expect([await zeroRate.getSampleRate(), await zeroRate.getNumberOfChannels()]).toEqual([8000, 2]);
	expect([await zeroChannels.getSampleRate(), await zeroChannels.getNumberOfChannels()]).toEqual([48000, 1]);
	expect((await new EncodedPacketSink(zeroRate).getFirstPacket())?.data).toEqual(new Uint8Array([2]));
});

test('MPEG audio Layer I and II tracks', async () => {
	// FFmpeg writes MP2 (e.g. DVB broadcast audio) as A_MPEG/L2. Like in MP4 and MPEG-TS, all three layers go by 'mp3',
	// which WebCodecs decodes.
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
	const audioTrack = (trackNumber: number, codecId: string) => element(
		EBMLId.TrackEntry,
		element(EBMLId.TrackNumber, [trackNumber]),
		element(EBMLId.TrackType, [2]),
		element(EBMLId.CodecID, ascii(codecId)),
		element(EBMLId.Audio, element(EBMLId.SamplingFrequency, [0x47, 0x3b, 0x80, 0])), // 48000
	);

	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		...element(EBMLId.Segment, element(
			EBMLId.Tracks,
			audioTrack(1, 'A_MPEG/L1'),
			audioTrack(2, 'A_MPEG/L2'),
			audioTrack(3, 'A_MPEG/L3'),
		)),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getAudioTracks();
	expect(await Promise.all(tracks.map(x => x.getCodec()))).toEqual(['mp3', 'mp3', 'mp3']);
	expect((await tracks[1]!.getDecoderConfig())!.codec).toBe('mp3');
});

test('TrackTimestampScale scales block timestamps and durations', async () => {
	// Legacy (Matroska v1 to v3): block timestamps and BlockDuration are in Track Ticks, which TrackTimestampScale
	// converts into the Segment Ticks of the cluster timestamp

	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const float64 = (value: number) => {
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setFloat64(0, value);
		return [...bytes];
	};

	const readTimings = async (trackTimestampScale: number) => {
		const block = (timestamp: number) => element(
			EBMLId.BlockGroup,
			element(EBMLId.Block, [0x81, 0, timestamp, 0], new Array<number>(320).fill(0)), // 20 ms at 8 kHz
			element(EBMLId.BlockDuration, [20]),
		);

		const file = new Uint8Array([
			...element(EBMLId.EBML, element(EBMLId.DocType, [...'matroska'].map(x => x.charCodeAt(0)))),
			...element(
				EBMLId.Segment,
				element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
				element(EBMLId.Tracks, element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, [...'A_PCM/INT/LIT'].map(x => x.charCodeAt(0))),
					element(EBMLId.TrackTimestampScale, float64(trackTimestampScale)),
					element(
						EBMLId.Audio,
						element(EBMLId.SamplingFrequency, float64(8000)),
						element(EBMLId.Channels, [1]),
						element(EBMLId.BitDepth, [16]),
					),
				)),
				element(EBMLId.Cluster, element(EBMLId.Timestamp, [100]), block(0), block(20)),
			),
		]);

		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const timings: number[][] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			timings.push([packet.timestamp, packet.duration]);
		}
		return timings;
	};

	expect(await readTimings(1)).toEqual([[0.1, 0.02], [0.12, 0.02]]);
	expect(await readTimings(2)).toEqual([[0.1, 0.04], [0.14, 0.04]]); // Like FFmpeg
});

test('A SeekPreRoll longer than the codec\'s pre-roll is honored', async () => {
	// SeekPreRoll is how much the decoder must decode after a discontinuity before its output is valid

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
	const uint32 = (value: number) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];

	const getPreRollDuration = async (seekPreRollNs: number | null) => {
		const file = new Uint8Array([
			...element(EBMLId.EBML, element(EBMLId.DocType, ascii('webm'))),
			...element(
				EBMLId.Segment,
				element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
				element(EBMLId.Tracks, element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, ascii('A_OPUS')),
					element(EBMLId.CodecPrivate, [...ascii('OpusHead'), 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]),
					...(seekPreRollNs === null ? [] : [element(EBMLId.SeekPreRoll, uint32(seekPreRollNs))]),
					element(EBMLId.Audio, element(EBMLId.Channels, [2])),
				)),
				element(
					EBMLId.Cluster,
					element(EBMLId.Timestamp, [0]),
					element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, 0xfc, 0xff]),
				),
			),
		]);

		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		return track.getPreRollDuration();
	};

	expect(await getPreRollDuration(800_000_000)).toBe(0.8);
	// The 80 ms that Opus files usually declare, or none, leaves the codec's own (more conservative) pre-roll
	expect(await getPreRollDuration(80_000_000)).toBe(0.4);
	expect(await getPreRollDuration(null)).toBe(0.4);

	// SeekPreRoll is in whole nanoseconds, so the codec's own pre-roll comes back rounded (Mediabunny's muxer writes it
	// for every audio track). That doesn't count as more: AAC at 44.1 kHz keeps 1024 / 44100 s after a round trip.
	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]), 'key', 0, 1024 / 44100), {
		decoderConfig: {
			codec: 'mp4a.40.2',
			numberOfChannels: 1,
			sampleRate: 44100,
			description: new Uint8Array([0x12, 0x08]), // AAC-LC, 44.1 kHz, mono
		},
	});
	await output.finalize();

	using roundTripped = new Input({
		source: new BufferSource(new Uint8Array(output.target.buffer!)),
		formats: ALL_FORMATS,
	});
	const aacTrack = await roundTripped.getPrimaryAudioTrack();
	assert(aacTrack);
	expect(await aacTrack.getPreRollDuration()).toBe(1024 / 44100);
});

test('EBML lacing with frame size differences of any width', async () => {
	// The size differences are signed VINTs of up to 8 bytes

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
	const float64 = (value: number) => {
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setFloat64(0, value);
		return [...bytes];
	};

	const readFrameSizes = async (sizeDifference: number[]) => {
		// Three frames: frame count minus one, the first size (320 as a 2-byte VINT), one difference, 960 bytes in all
		const lace = [2, 0x41, 0x40, ...sizeDifference];
		const file = new Uint8Array([
			...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
			...element(
				EBMLId.Segment,
				element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
				element(EBMLId.Tracks, element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, ascii('A_PCM/INT/LIT')),
					element(EBMLId.DefaultDuration, [0x01, 0x31, 0x2d, 0x00]), // 20 ms
					element(
						EBMLId.Audio,
						element(EBMLId.SamplingFrequency, float64(8000)),
						element(EBMLId.Channels, [1]),
						element(EBMLId.BitDepth, [16]),
					),
				)),
				element(
					EBMLId.Cluster,
					element(EBMLId.Timestamp, [0]),
					// Track 1, timestamp 0, key frame with EBML lacing
					element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x86], lace, new Array<number>(960).fill(0)),
				),
			),
		]);

		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const sizes: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			sizes.push(packet.data.byteLength);
		}
		return sizes;
	};

	// Frames of 320, 322 and (implied) 318 bytes: a difference of +2
	expect(await readFrameSizes([0xc1])).toEqual([320, 322, 318]); // 65, minus the bias of 2^6 - 1
	expect(await readFrameSizes([0x0c, 0, 0, 0, 1])).toEqual([320, 322, 318]); // 2^34 + 1, bias 2^34 - 1
	expect(await readFrameSizes([0x01, 0x80, 0, 0, 0, 0, 0, 1])).toEqual([320, 322, 318]); // 2^55 + 1, bias 2^55 - 1
	// And -2
	expect(await readFrameSizes([0xbd])).toEqual([320, 318, 322]);
	expect(await readFrameSizes([0x01, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfd])).toEqual([320, 318, 322]);
});

test('Laced frames that header stripping removed entirely', async () => {
	// Header stripping (ContentCompAlgo 3) removes the same leading bytes from every frame; when that's all of a frame,
	// nothing of it is stored

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
	const float64 = (value: number) => {
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setFloat64(0, value);
		return [...bytes];
	};

	// Three silent 320-byte PCM frames, of which `strippedSize` bytes each are in ContentCompSettings
	const readFrameSizes = async (strippedSize: number) => {
		const contentEncoding = element(EBMLId.ContentEncoding, element(
			EBMLId.ContentCompression,
			element(EBMLId.ContentCompAlgo, [3]),
			element(EBMLId.ContentCompSettings, new Array<number>(strippedSize).fill(0)),
		));

		const file = new Uint8Array([
			...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
			...element(
				EBMLId.Segment,
				element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
				element(EBMLId.Tracks, element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, ascii('A_PCM/INT/LIT')),
					element(EBMLId.DefaultDuration, [0x01, 0x31, 0x2d, 0x00]), // 20 ms
					element(EBMLId.ContentEncodings, contentEncoding),
					element(
						EBMLId.Audio,
						element(EBMLId.SamplingFrequency, float64(8000)),
						element(EBMLId.Channels, [1]),
						element(EBMLId.BitDepth, [16]),
					),
				)),
				element(
					EBMLId.Cluster,
					element(EBMLId.Timestamp, [0]),
					// Track 1, timestamp 0, key frame with fixed-size lacing of three frames
					element(
						EBMLId.SimpleBlock,
						[0x81, 0, 0, 0x84, 2],
						new Array<number>(3 * (320 - strippedSize)).fill(0),
					),
				),
			),
		]);

		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const sizes: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			sizes.push(packet.data.byteLength);
		}
		return sizes;
	};

	expect(await readFrameSizes(319)).toEqual([320, 320, 320]);
	expect(await readFrameSizes(320)).toEqual([320, 320, 320]);
});

test('The display size applies to the frame after PixelCrop', async () => {
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

	// A 64x64 frame shown at 64x64, after removing `crop` pixels on the left and on the right
	const open = (crop: number) => new Input({
		source: new BufferSource(new Uint8Array([
			...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
			...element(
				EBMLId.Segment,
				element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
				element(EBMLId.Tracks, element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [1]),
					element(EBMLId.CodecID, ascii('V_VP8')),
					element(
						EBMLId.Video,
						element(EBMLId.PixelWidth, [64]),
						element(EBMLId.PixelHeight, [64]),
						element(EBMLId.PixelCropLeft, [crop]),
						element(EBMLId.PixelCropRight, [crop]),
						element(EBMLId.DisplayWidth, [64]),
						element(EBMLId.DisplayHeight, [64]),
					),
				)),
				element(
					EBMLId.Cluster,
					element(EBMLId.Timestamp, [0]),
					element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, 0]),
				),
			),
		])),
		formats: ALL_FORMATS,
	});

	{
		using input = open(0);
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		expect(await track.getPixelAspectRatio()).toEqual({ num: 1, den: 1 });
	}

	{
		// The visible 32x64 frame is shown at 64x64, so the pixels are twice as wide as high (like FFmpeg's 2:1 SAR)
		using input = open(16);
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		expect(await track.getPixelAspectRatio()).toEqual({ num: 2, den: 1 });
		expect([await track.getCodedWidth(), await track.getCodedHeight()]).toEqual([64, 64]);
	}
});

test('Tags whose target UID is 0 apply to the whole segment', async () => {
	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const utf8 = (text: string) => [...new TextEncoder().encode(text)];

	const readArtist = async (uidElementId: number, uid: number[]) => {
		const file = new Uint8Array([
			...element(EBMLId.EBML, element(EBMLId.DocType, utf8('matroska'))),
			...element(
				EBMLId.Segment,
				element(EBMLId.Tracks, element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackUID, [1]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, utf8('A_AC3')),
				)),
				element(EBMLId.Tags, element(
					EBMLId.Tag,
					element(EBMLId.Targets, element(uidElementId, uid)),
					element(
						EBMLId.SimpleTag,
						element(EBMLId.TagName, utf8('ARTIST')),
						element(EBMLId.TagString, utf8('Artist')),
					),
				)),
			),
		]);

		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});
		return (await input.getMetadataTags()).artist;
	};

	// "If the value is 0 at this level, the tags apply to all tracks in the Segment", like for the other UIDs
	for (const uidElementId of [
		EBMLId.TagTrackUID,
		EBMLId.TagEditionUID,
		EBMLId.TagChapterUID,
		EBMLId.TagAttachmentUID,
	]) {
		expect(await readArtist(uidElementId, [0])).toBe('Artist');
		expect(await readArtist(uidElementId, [])).toBe('Artist'); // An empty element is 0, the default
		expect(await readArtist(uidElementId, [1])).toBe(undefined); // Tags of one track (or edition, ...)
	}
});

test('The best of the Matroska spec\'s cover art versions is the front cover', async () => {
	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const utf8 = (text: string) => [...new TextEncoder().encode(text)];

	const readKinds = async (names: string[]) => {
		const file = new Uint8Array([
			...element(EBMLId.EBML, element(EBMLId.DocType, utf8('matroska'))),
			...element(
				EBMLId.Segment,
				element(EBMLId.Tracks, element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, utf8('A_AC3')),
				)),
				element(EBMLId.Attachments, ...names.map((name, i) => element(
					EBMLId.AttachedFile,
					element(EBMLId.FileName, utf8(name)),
					element(EBMLId.FileMediaType, utf8(name.endsWith('.png') ? 'image/png' : 'image/jpeg')),
					element(EBMLId.FileData, [0xff, 0xd8, 0xff, i]),
					element(EBMLId.FileUID, [i + 1]),
				))),
			),
		]);

		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});
		const { images } = await input.getMetadataTags();
		return images!.map(x => x.kind);
	};

	// The spec's normal, small, landscape and small landscape covers: versions of one cover, the normal one first
	expect(await readKinds(['cover.jpg', 'small_cover.png', 'cover_land.png', 'small_cover_land.jpg', 'poster.jpg']))
		.toEqual(['coverFront', 'unknown', 'unknown', 'unknown', 'unknown']);
	// Whatever their order (attachments come in the order they were added)
	expect(await readKinds(['small_cover.jpg', 'cover.jpg'])).toEqual(['unknown', 'coverFront']);
	// Without a normal cover, the best version there is the front cover
	expect(await readKinds(['small_cover_land.jpg', 'small_cover.png', 'cover_land.png']))
		.toEqual(['unknown', 'unknown', 'coverFront']);
	expect(await readKinds(['small_cover_land.jpg'])).toEqual(['coverFront']);
});

test('Converting Matroska to MP4 keeps the normal cover as the cover art', async () => {
	// Attachments come in the order they were added, here the small cover before the normal one
	const jpeg = (marker: string) => new Uint8Array([0xff, 0xd8, 0xff, 0xd9, ...new TextEncoder().encode(marker)]);
	const mkv = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('opus');
	mkv.addAudioTrack(source);
	mkv.setMetadataTags({
		images: [
			{ data: jpeg('small'), mimeType: 'image/jpeg', kind: 'unknown', name: 'small_cover.jpg' },
			{ data: jpeg('normal'), mimeType: 'image/jpeg', kind: 'coverFront', name: 'cover.jpg' },
		],
	});
	await mkv.start();
	const opusHead = new Uint8Array([
		...new TextEncoder().encode('OpusHead'),
		1, 2, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0,
	]);
	for (let i = 0; i < 5; i++) {
		await source.add(new EncodedPacket(new Uint8Array([0xfc, 0xff, 0xfe]), 'key', i * 0.02, 0.02), {
			decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000, description: opusHead },
		});
	}
	await mkv.finalize();

	using input = new Input({ source: new BufferSource(mkv.target.buffer!), formats: ALL_FORMATS });
	const mp4 = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output: mp4, tags: tags => tags });
	await conversion.execute();

	using output = new Input({ source: new BufferSource(mp4.target.buffer!), formats: ALL_FORMATS });
	const covers = (await output.getMetadataTags()).images!;
	expect(new TextDecoder().decode(covers[0]!.data.subarray(4))).toBe('normal');
});

test('Of several SimpleTags with the same name, the default one wins', async () => {
	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const utf8 = (text: string) => [...new TextEncoder().encode(text)];
	const simpleTag = (name: string, ...children: number[][]) => element(
		EBMLId.SimpleTag,
		element(EBMLId.TagName, utf8(name)),
		...children,
	);
	const tagString = (value: string) => element(EBMLId.TagString, utf8(value));
	const tagLanguage = (language: string) => element(EBMLId.TagLanguage, utf8(language));

	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, utf8('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [2]),
				element(EBMLId.CodecID, utf8('A_AC3')),
			)),
			element(EBMLId.Tags, element(
				EBMLId.Tag,
				element(EBMLId.Targets),
				// A translation first, as FFmpeg writes `-metadata artist-ger=... -metadata artist=...`
				simpleTag('ARTIST', tagLanguage('ger'), tagString('Künstler')),
				simpleTag('ARTIST', tagString('Artist')),
				// A value flagged as not the default first
				simpleTag('TITLE', element(EBMLId.TagDefault, [0]), tagString('Non-default')),
				simpleTag('TITLE', tagString('Title')),
				// The only value, in another language (given after the value)
				simpleTag('ALBUM', tagString('Album'), tagLanguage('fre')),
				// TagLanguageBCP47 takes precedence over TagLanguage
				simpleTag(
					'COMMENT',
					element(EBMLId.TagLanguageBCP47, utf8('de')),
					tagLanguage('fre'),
					tagString('Kommentar'),
				),
			)),
		),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});
	const tags = await input.getMetadataTags();
	expect(tags.artist).toBe('Artist');
	expect(tags.title).toBe('Title');
	expect(tags.album).toBe('Album');
	// Translations are also kept under their own names, like FFmpeg does
	expect(tags.raw).toMatchObject({
		'ARTIST': 'Artist',
		'ARTIST-ger': 'Künstler',
		'TITLE': 'Title',
		'ALBUM': 'Album',
		'ALBUM-fre': 'Album',
		'COMMENT-de': 'Kommentar',
	});
	expect(tags.raw!['COMMENT-fre']).toBe(undefined);
});

test('Attachments before the clusters are only read once the metadata tags are asked for', async () => {
	// Muxers put attachments (fonts, cover art) before the clusters, and they can be large
	const element = (id: number, ...parts: (number[] | Uint8Array)[]) => {
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const length = parts.reduce((sum, part) => sum + part.length, 0);
		const bytes = new Uint8Array(idBytes.length + 4 + length);
		bytes.set(idBytes);
		bytes.set([0x10, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff], idBytes.length); // 4-byte VINT
		let position = idBytes.length + 4;
		for (const part of parts) {
			bytes.set(part, position);
			position += part.length;
		}
		return bytes;
	};

	const ascii = (text: string) => [...text].map(x => x.charCodeAt(0));
	const image = new Uint8Array(4 * 2 ** 20);
	image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG signature

	const header = element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska')));
	const segment = element(
		EBMLId.Segment,
		element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
		element(EBMLId.Tracks, element(
			EBMLId.TrackEntry,
			element(EBMLId.TrackNumber, [1]),
			element(EBMLId.TrackType, [2]),
			element(EBMLId.CodecID, ascii('A_AC3')),
		)),
		element(EBMLId.Attachments, element(
			EBMLId.AttachedFile,
			element(EBMLId.FileName, ascii('cover.png')),
			element(EBMLId.FileMediaType, ascii('image/png')),
			element(EBMLId.FileData, image),
			element(EBMLId.FileUID, [1]),
		)),
		element(EBMLId.Cluster, element(EBMLId.Timestamp, [0]), element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, 0])),
	);
	const file = new Uint8Array(header.length + segment.length);
	file.set(header);
	file.set(segment, header.length);

	{
		let bytesRead = 0;
		using input = new Input({
			source: new CustomSource({
				getSize: () => file.length,
				read: (start, end) => {
					bytesRead += end - start;
					return file.subarray(start, end);
				},
			}),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryAudioTrack();
		assert(track);
		expect(bytesRead).toBeLessThan(2 ** 20);

		const { images } = await input.getMetadataTags();
		expect(images?.map(x => [x.name, x.data.length])).toEqual([['cover.png', image.length]]);
	}

	{
		// A source of unknown size, read in order: the attachments are read right away, as before
		using input = new Input({
			source: new ReadableStreamSource(new ReadableStream({
				start: (controller) => {
					controller.enqueue(file);
					controller.close();
				},
			})),
			formats: ALL_FORMATS,
		});

		await input.getPrimaryAudioTrack();
		const { images } = await input.getMetadataTags();
		expect(images?.map(x => [x.name, x.data.length])).toEqual([['cover.png', image.length]]);
	}
});

test('A cluster cut off by the end of the file keeps its complete blocks', async () => {
	// As in an interrupted recording: the file ends in the middle of its last cluster

	const ascii = (text: string) => [...text].map(x => x.charCodeAt(0));
	const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
	const element = (id: number, data: number[], unknownSize = false) => {
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = unknownSize
			? UNKNOWN_SIZE
			: [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	// Two clusters of ten 20 ms blocks, the second one cut off after its first `blocksLeft` blocks
	const makeFile = (unknownSizes: boolean, blocksLeft: number) => {
		const block = (relativeTimestamp: number) => element(
			EBMLId.SimpleBlock,
			[0x81, 0, relativeTimestamp, 0x80, ...new Array<number>(100).fill(0)],
		);
		const cluster = (timestamp: number) => element(EBMLId.Cluster, [
			...element(EBMLId.Timestamp, [0, timestamp]),
			...Array.from({ length: 10 }, (_, i) => block(20 * i)).flat(),
		], unknownSizes);

		const bytes = [
			...element(EBMLId.EBML, element(EBMLId.DocType, ascii('webm'))),
			...element(EBMLId.Segment, [
				...element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
				...element(EBMLId.Tracks, element(EBMLId.TrackEntry, [
					...element(EBMLId.TrackNumber, [1]),
					...element(EBMLId.TrackType, [2]),
					...element(EBMLId.CodecID, ascii('A_PCM/INT/LIT')),
					...element(EBMLId.Audio, element(EBMLId.BitDepth, [16])),
				])),
				...cluster(0),
				...cluster(200),
			], unknownSizes),
		];

		// The end of the last cluster's Timestamp and first `blocksLeft` blocks, and a part of the next block
		const blockSize = block(0).length;
		const secondClusterEnd = bytes.length;
		const cut = secondClusterEnd - (10 - blocksLeft) * blockSize + Math.floor(blockSize / 2);
		return new Uint8Array(bytes.slice(0, cut));
	};

	const readTimestamps = async (file: Uint8Array) => {
		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			timestamps.push(Math.round(packet.timestamp * 1000));
		}

		// And looking up a packet in the cut-off cluster
		const lookup = await new EncodedPacketSink(track).getPacket(0.25);
		return { timestamps, lookup: lookup && Math.round(lookup.timestamp * 1000) };
	};

	const firstCluster = Array.from({ length: 10 }, (_, i) => 20 * i);
	// Clusters of unknown size, as browsers' MediaRecorder writes them, and of known size, as FFmpeg does
	for (const unknownSizes of [true, false]) {
		expect(await readTimestamps(makeFile(unknownSizes, 4))).toEqual({
			timestamps: [...firstCluster, 200, 220, 240, 260],
			lookup: 240,
		});
	}
});

test('A cut-off cluster whose start a stream no longer holds is dropped instead of failing', async () => {
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

	// 48 kHz mono 16-bit PCM in 20 ms blocks; each cluster holds 300 of them (6 s, 577 kB)
	const cluster = (startMs: number) => element(
		EBMLId.Cluster,
		element(EBMLId.Timestamp, [(startMs >> 8) & 0xff, startMs & 0xff]),
		...Array.from({ length: 300 }, (_, i) => element(
			EBMLId.SimpleBlock,
			[0x81, ((i * 20) >> 8) & 0xff, (i * 20) & 0xff, 0x80, ...new Array<number>(1920).fill(0)],
		)),
	);
	const lastCluster = cluster(12000);
	const fullFile = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // Segment of unknown size
		...element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
		...element(EBMLId.Tracks, element(
			EBMLId.TrackEntry,
			element(EBMLId.TrackNumber, [1]),
			element(EBMLId.TrackType, [2]),
			element(EBMLId.CodecID, ascii('A_PCM/INT/LIT')),
			element(
				EBMLId.Audio,
				element(EBMLId.SamplingFrequency, [0x40, 0xe7, 0x70, 0, 0, 0, 0, 0]), // 48000
				element(EBMLId.BitDepth, [16]),
			),
		)),
		...cluster(0),
		...cluster(6000),
		...lastCluster,
	]);
	// Cut 400 kB into the last cluster
	const file = fullFile.subarray(0, fullFile.length - lastCluster.length + 400_000);

	const readStreamed = async (maxCacheSize: number) => {
		const open = () => {
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

			return new Input({ source: new ReadableStreamSource(stream, { maxCacheSize }), formats: ALL_FORMATS });
		};

		using durationInput = open();
		const duration = await (await durationInput.getPrimaryAudioTrack())!.computeDuration();

		using input = open();
		let count = 0;
		for await (const packet of new EncodedPacketSink((await input.getPrimaryAudioTrack())!).packets()) {
			void packet;
			count++;
		}

		return [duration, count];
	};

	// With a cache that holds what's left of the cluster, its 207 complete blocks are kept: the last one starts at
	// 16.12 s. (Whether it also gets its 20 ms depends on whether durations are derived from PCM block sizes.)
	const [keptDuration, keptCount] = await readStreamed(2 ** 20);
	expect(keptCount).toBe(807);
	expect(keptDuration).toBeGreaterThanOrEqual(16.12);
	expect(keptDuration).toBeLessThanOrEqual(16.14);
	// Once the stream has read past the cluster's start (to find out where the file ends), it can't give it again:
	// the cluster is dropped then, as it was before, ending the track with the second cluster's last block at 11.98 s
	const [droppedDuration, droppedCount] = await readStreamed(2 ** 18);
	expect(droppedCount).toBe(600);
	expect(droppedDuration).toBeGreaterThanOrEqual(11.98);
	expect(droppedDuration).toBeLessThanOrEqual(12);
});

test('Matroska Language with a country code gives the ISO 639-2 code', async () => {
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

	const readLanguage = async (language: string) => {
		const bytes = new Uint8Array([
			...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
			...element(
				EBMLId.Segment,
				element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
				element(EBMLId.Tracks, element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, ascii('A_PCM/INT/LIT')),
					element(EBMLId.Language, ascii(language)),
					element(EBMLId.Audio, element(EBMLId.BitDepth, [16])),
				)),
				element(
					EBMLId.Cluster,
					element(EBMLId.Timestamp, [0]),
					element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, 0, 0]),
				),
			),
		]);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return (await input.getTracks())[0]!.getLanguageCode();
	};

	// RFC 9559, section 12: Matroska v1 to v3 use ISO 639-2 codes, optionally followed by a dash and a country code,
	// like "fre-ca" (FFmpeg writes what it's given, like -metadata:s:a:0 language=por-br)
	expect(await readLanguage('por-br')).toBe('por');
	expect(await readLanguage('spa-mx')).toBe('spa');
	expect(await readLanguage('por')).toBe('por');
	expect(await readLanguage('xx-yy')).toBe('und');
});
