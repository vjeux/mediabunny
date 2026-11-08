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

test('getPacket at the end of a packet that starts before zero returns the next packet', async () => {
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
	const block = (timestamp: number) => element(
		EBMLId.SimpleBlock,
		[0x81, (timestamp >> 8) & 0xff, timestamp & 0xff, 0x80, 0, 0],
	);

	// As FFmpeg writes MP3 in Matroska: the first packet starts before zero, at -25 ms, and lasts 26 ms
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
				element(EBMLId.Audio, element(EBMLId.BitDepth, [16])),
			)),
			element(EBMLId.Cluster, element(EBMLId.Timestamp, [0]), block(-25), block(1), block(27)),
		),
	]);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const first = await sink.getFirstPacket();
	assert(first);
	expect([first.timestamp, first.duration]).toEqual([-0.025, 0.026]);
	// -0.025 + 0.026 is 0.0009999999999999974 in floating point
	expect((await sink.getPacket(first.timestamp + first.duration))?.timestamp).toBe(0.001);
	// Controls
	expect((await sink.getPacket(0.001))?.timestamp).toBe(0.001);
	expect((await sink.getPacket(0.0005))?.timestamp).toBe(-0.025);
});
