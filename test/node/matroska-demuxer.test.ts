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
