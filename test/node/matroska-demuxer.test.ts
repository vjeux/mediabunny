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

test('Matroska files with junk in front of the Segment, or a Segment size of 0, still get read', async () => {
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

	const ebmlHeader = element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska')));
	const segmentChildren = [
		element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
		element(EBMLId.Tracks, element(
			EBMLId.TrackEntry,
			element(EBMLId.TrackNumber, [1]),
			element(EBMLId.TrackType, [2]),
			element(EBMLId.CodecID, ascii('A_PCM/INT/LIT')),
			element(EBMLId.Audio, element(EBMLId.Channels, [1]), element(EBMLId.BitDepth, [16])),
		)),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [0]),
			element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, 1, 2]),
			element(EBMLId.SimpleBlock, [0x81, 0, 20, 0x80, 3, 4]),
		),
	].flat();
	const segment = element(EBMLId.Segment, segmentChildren);

	const countPackets = async (bytes: number[]) => {
		using input = new Input({ source: new BufferSource(new Uint8Array(bytes)), formats: ALL_FORMATS });
		const tracks = await input.getTracks();
		if (tracks.length === 0) {
			return 0;
		}

		let count = 0;
		for await (const packet of new EncodedPacketSink(tracks[0]!).packets()) {
			expect(packet.byteLength).toBe(2);
			count++;
		}
		return count;
	};

	// Control
	expect(await countPackets([...ebmlHeader, ...segment])).toBe(2);
	// Zero bytes and garbage between the EBML header and the Segment, which FFmpeg skips by resyncing
	expect(await countPackets([...ebmlHeader, ...new Array<number>(16).fill(0), ...segment])).toBe(2);
	expect(await countPackets([...ebmlHeader, ...ascii('this is junk!!!!'), ...segment])).toBe(2);
	// A Segment size left at 0 (FFmpeg reads the elements that follow as the Segment's)
	expect(await countPackets([...ebmlHeader, 0x18, 0x53, 0x80, 0x67, 0x80, ...segmentChildren])).toBe(2);
	// Zero padding after the Segment still just ends the file
	expect(await countPackets([...ebmlHeader, ...segment, ...new Array<number>(16).fill(0)])).toBe(2);
});
