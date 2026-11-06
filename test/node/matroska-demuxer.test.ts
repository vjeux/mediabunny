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
