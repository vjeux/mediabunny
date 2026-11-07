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
