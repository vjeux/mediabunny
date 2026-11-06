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
	Output,
	WebMOutputFormat,
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

test('Blocks last their BlockDuration or the DefaultDuration, not until the next block', async () => {
	// Mediabunny itself writes a BlockGroup with a BlockDuration for every frame of a video with alpha, and a
	// DefaultDuration for a track with a frame rate
	const readBackDurations = async (timestamps: number[], options: { alpha?: boolean; frameRate?: number }) => {
		const target = new BufferTarget();
		const output = new Output({ format: new WebMOutputFormat(), target });
		const source = new EncodedVideoPacketSource('vp8');
		output.addVideoTrack(source, options.frameRate === undefined ? {} : { frameRate: options.frameRate });
		await output.start();
		for (const [i, timestamp] of timestamps.entries()) {
			const data = new Uint8Array(i === 0
				? [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x10, 0x00, 0x10, 0x00] // VP8 key frame header, 16x16
				: [0x11, 0x02]);
			const sideData = options.alpha ? { alpha: data } : undefined;
			await source.add(
				new EncodedPacket(data, i === 0 ? 'key' : 'delta', timestamp, 1 / 30, -1, undefined, sideData),
				{ decoderConfig: { codec: 'vp8', codedWidth: 16, codedHeight: 16 } },
			);
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const durations: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			durations.push(packet.duration);
		}
		return durations;
	};

	// The frame before the gap used to last 134 ms, until the next frame, despite its BlockDuration of 33 ms
	const withGap = await readBackDurations([0, 0.033, 0.066, 0.2, 0.233], { alpha: true });
	expect(withGap.map(duration => Math.round(duration * 1000))).toEqual([33, 33, 33, 33, 33]);

	// The millisecond timestamps of 30 fps video used to give durations of 33 and 34 ms instead of the DefaultDuration
	const constantRate = await readBackDurations([0, 1, 2, 3, 4].map(i => i / 30), { frameRate: 30 });
	for (const duration of constantRate.slice(0, -1)) {
		expect(duration).toBeCloseTo(1 / 30, 6);
	}
});
