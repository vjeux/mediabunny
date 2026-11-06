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

test('Laced blocks spread their frames over the gap to the next block', async () => {
	// As in a broadcast recording remuxed to MKV: eight audio frames of 32 ms per block, blocks 256 ms apart, and a
	// DefaultDuration of 192 ms that can't be the duration of each frame. The frames must stay 32 ms apart instead of
	// following the DefaultDuration into the next block.
	const element = (id: number[], ...parts: (number[] | Uint8Array)[]) => {
		const size = parts.reduce((sum, part) => sum + part.length, 0);
		const sizeBytes = [0x01, 0, 0, 0, size >>> 24, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff];
		return [...id, ...sizeBytes, ...parts.flatMap(part => [...part])];
	};
	const uint = (id: number[], value: number) => element(
		id,
		[value >> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff],
	);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));

	const frameSize = 512; // 32 ms of 16-bit mono PCM at 8 kHz
	const lacedBlock = (relativeTimestamp: number) => element(
		[0xa3], // SimpleBlock
		[0x81, relativeTimestamp >> 8, relativeTimestamp & 0xff, 0x84, 8 - 1], // Track 1, key frame, fixed-size lacing
		new Uint8Array(8 * frameSize),
	);
	const bytes = new Uint8Array([
		...element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], ascii('matroska'))),
		...element(
			[0x18, 0x53, 0x80, 0x67], // Segment
			element([0x15, 0x49, 0xa9, 0x66], uint([0x2a, 0xd7, 0xb1], 1_000_000)), // Info: 1 ms timestamp scale
			element([0x16, 0x54, 0xae, 0x6b], element(
				[0xae], // TrackEntry
				uint([0xd7], 1),
				uint([0x73, 0xc5], 1),
				uint([0x83], 2),
				element([0x86], ascii('A_PCM/INT/LIT')),
				uint([0x23, 0xe3, 0x83], 192_000_000), // DefaultDuration
				element(
					[0xe1], // Audio
					element([0xb5], [0x40, 0xbf, 0x40, 0, 0, 0, 0, 0]), // SamplingFrequency 8000
					uint([0x9f], 1), // Channels
					uint([0x62, 0x64], 16), // BitDepth
				),
			)),
			element([0x1f, 0x43, 0xb6, 0x75], uint([0xe7], 0), lacedBlock(0), lacedBlock(256), lacedBlock(512)),
		),
	]);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packets: [number, number][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([Math.round(packet.timestamp * 1000), Math.round(packet.duration * 1000)]);
	}
	expect(packets.slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, i) => [32 * i, 32]));
});
