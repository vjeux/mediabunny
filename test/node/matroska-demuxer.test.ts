import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
	ALL_FORMATS,
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
