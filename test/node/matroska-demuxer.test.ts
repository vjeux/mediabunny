import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	CustomSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	MATROSKA,
	MkvOutputFormat,
	Output,
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

test('Files are read whenever their read versions are supported, whatever their versions', async () => {
	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(8), 'key', 0, 1), {
		decoderConfig: { codec: 'vp8', codedWidth: 64, codedHeight: 64 },
	});
	await output.finalize();

	// Sets a one-byte value of the EBML header
	const withHeaderValue = (id: number[], value: number) => {
		const bytes = new Uint8Array(output.target.buffer!);
		const index = bytes.findIndex((_, i) => id.every((byte, j) => bytes[i + j] === byte) && bytes[i + 2] === 0x81);
		bytes[index + 3] = value;
		return bytes;
	};

	const canRead = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return await input.canRead() && await input.getFormat() === MATROSKA && (await input.getTracks()).length === 1;
	};

	// mkvmerge sets DocTypeVersion 5 when it writes Matroska v5 elements (like edition names) but leaves
	// DocTypeReadVersion at 2, since players don't need them. Readers of v4 must read such files (RFC 9559, Section 7).
	expect(await canRead(withHeaderValue([0x42, 0x87], 5))).toBe(true); // DocTypeVersion
	expect(await canRead(withHeaderValue([0x42, 0x86], 2))).toBe(true); // EBMLVersion
	expect(await canRead(withHeaderValue([0x42, 0x85], 5))).toBe(false); // DocTypeReadVersion
	expect(await canRead(withHeaderValue([0x42, 0xf7], 2))).toBe(false); // EBMLReadVersion
});
