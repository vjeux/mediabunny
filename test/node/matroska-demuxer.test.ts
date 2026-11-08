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

test('Matroska video without a usable PixelWidth/PixelHeight takes the size from the bitstream', async () => {
	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};
	const uint = (id: number, value: number) => element(id, [(value >> 8) & 0xff, value & 0xff]);
	const ascii = (text: string) => [...text].map(x => x.charCodeAt(0));

	// A VP8 key frame header for a 320x240 frame (RFC 6386, section 9.1), padded with zeros
	const vp8KeyFrame = [0x50, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00, ...new Array<number>(20).fill(0)];

	const readVideo = async (videoChildren: number[][], frame = vp8KeyFrame, leadingDeltaFrame = false) => {
		const bytes = new Uint8Array([
			...element(EBMLId.EBML, element(EBMLId.DocType, ascii('webm'))),
			...element(
				EBMLId.Segment,
				element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
				element(EBMLId.Tracks, element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [1]),
					element(EBMLId.CodecID, ascii('V_VP8')),
					element(EBMLId.Video, ...videoChildren),
				)),
				element(
					EBMLId.Cluster,
					element(EBMLId.Timestamp, [0]),
					// A VP8 interframe (bit 0 of the first byte set), which doesn't give the size
					leadingDeltaFrame ? element(EBMLId.SimpleBlock, [0x81, 0, 0, 0, 0x01, 0, 0, 0, 0, 0]) : [],
					element(EBMLId.SimpleBlock, [0x81, 0, leadingDeltaFrame ? 40 : 0, 0x80, ...frame]),
				),
			),
		]);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		if (!track) {
			return null;
		}

		const config = await track.getDecoderConfig();
		return [await track.getCodedWidth(), await track.getCodedHeight(), config?.codedWidth, config?.codedHeight];
	};

	const pixelSize = (width: number, height: number) => [
		uint(EBMLId.PixelWidth, width),
		uint(EBMLId.PixelHeight, height),
	];

	// Control: the container gives the size
	expect(await readVideo(pixelSize(320, 240))).toEqual([320, 240, 320, 240]);
	// webm-writer-js writes PixelWidth/PixelHeight 0 when it's given WebP data URLs; FFmpeg reads 320x240
	expect(await readVideo(pixelSize(0, 0))).toEqual([320, 240, 320, 240]);
	// Missing PixelWidth/PixelHeight: the track mustn't disappear
	expect(await readVideo([])).toEqual([320, 240, 320, 240]);
	// A cut stream starting with a delta frame: the size comes from the first key frame
	expect(await readVideo(pixelSize(0, 0), vp8KeyFrame, true)).toEqual([320, 240, 320, 240]);
	// Without a size in the bitstream either, the size stays unknown, and the decoder config leaves it out (a coded
	// size of 0 makes decoders reject the config)
	expect(await readVideo([], new Array<number>(30).fill(0xff))).toEqual([0, 0, undefined, undefined]);
});
