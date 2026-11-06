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

test('DiscardPadding shortens the last Opus packet', async () => {
	// FFmpeg ends every Opus track whose length isn't a multiple of the frame duration like this: the last 20 ms
	// block carries 13.5 ms of padding, and there's no BlockDuration or DefaultDuration
	const opusPacket = [0xfc, 0xff, 0xfe]; // CELT, 20 ms
	const padding = element(0x75a2, [0x00, 0xcd, 0xfe, 0x60]); // DiscardPadding: 13,500,000 ns

	const makeFile = (lastBlockExtra: number[]) => matroskaFile(
		element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
		element(EBMLId.Tracks, element(
			EBMLId.TrackEntry,
			element(EBMLId.TrackNumber, [1]),
			element(EBMLId.TrackType, [2]),
			element(EBMLId.CodecID, [...'A_OPUS'].map(x => x.charCodeAt(0))),
			element(EBMLId.Audio, element(EBMLId.Channels, [2])),
		)),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [0]),
			element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, ...opusPacket]),
			element(EBMLId.BlockGroup, element(EBMLId.Block, [0x81, 0, 20, 0, ...opusPacket]), lastBlockExtra),
		),
	);

	for (const lastBlockExtra of [padding, [...element(EBMLId.BlockDuration, [20]), ...padding]]) {
		using input = new Input({
			source: new BufferSource(makeFile(lastBlockExtra)),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const sink = new EncodedPacketSink(track);
		const durations: number[] = [];
		for await (const packet of sink.packets()) {
			durations.push(packet.duration);
		}

		expect(durations).toEqual([0.02, 0.0065]);
	}
});

const matroskaFile = (...segmentChildren: number[][]) => new Uint8Array([
	...element(EBMLId.EBML, element(EBMLId.DocType, [...'webm'].map(x => x.charCodeAt(0)))),
	...element(EBMLId.Segment, segmentChildren.flat()),
]);

const element = (id: number, ...parts: number[][]) => {
	const data = parts.flat();
	const idBytes: number[] = [];
	for (let value = id; value > 0; value = Math.floor(value / 256)) {
		idBytes.unshift(value & 0xff);
	}

	const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
	return [...idBytes, ...size, ...data];
};
