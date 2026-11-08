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
import { EBMLId } from '../../src/matroska/ebml.js';
import { assert } from '../../src/misc.js';

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

test('Laced frames can be looked up by their own timestamps', async () => {
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
	const uint16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];

	// As mkvmerge writes AAC by default: 8 frames (1024 samples at 48 kHz) per Xiph-laced block, block timestamps
	// rounded to the millisecond, no BlockDuration
	const blockTimestamps = Array.from({ length: 300 }, (_, i) => Math.round(i * 8 * 1024 / 48));
	const block = (relativeTimestamp: number) => element(
		EBMLId.SimpleBlock,
		[0x81, ...uint16(relativeTimestamp), 0x82], // Key frame, Xiph lacing
		[7, ...new Array<number>(7).fill(4)], // 8 frames of 4 bytes
		new Array<number>(32).fill(0),
	);
	const clusters: number[][] = [];
	for (let i = 0; i < blockTimestamps.length; i += 30) {
		const start = blockTimestamps[i]!;
		clusters.push(element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, uint16(start)),
			...blockTimestamps.slice(i, i + 30).map(timestamp => block(timestamp - start)),
		));
	}

	const bytes = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [2]),
				element(EBMLId.CodecID, ascii('A_AAC')),
				element(EBMLId.CodecPrivate, [0x11, 0x90]), // AAC-LC, 48 kHz, stereo
				element(EBMLId.DefaultDuration, [0x01, 0x45, 0x85, 0x55]), // 21.333333 ms
				element(EBMLId.Audio, element(EBMLId.Channels, [2])),
			)),
			...clusters,
		),
	]);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const misses: string[] = [];
	let count = 0;
	for await (const packet of sink.packets()) {
		count++;
		const found = await sink.getPacket(packet.timestamp);
		if (found?.timestamp !== packet.timestamp) {
			misses.push(`getPacket(${packet.timestamp}) -> ${found?.timestamp}`);
		}
	}

	expect(count).toBe(2400);
	expect(misses).toEqual([]);
});
