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

	// With a cache that holds what's left of the cluster, its 207 complete blocks are kept
	expect(await readStreamed(2 ** 20)).toEqual([16.12, 807]);
	// Once the stream has read past the cluster's start (to find out where the file ends), it can't give it again:
	// the cluster is dropped then, as it was before
	expect(await readStreamed(2 ** 18)).toEqual([11.98, 600]);
});
