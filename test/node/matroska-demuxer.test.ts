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
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	FilePathSource,
	Input,
	MkvOutputFormat,
	Mp4OutputFormat,
	Output,
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
