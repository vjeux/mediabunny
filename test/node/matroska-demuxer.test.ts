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

// Builders for hand-made Matroska files. Every element gets an 8-byte size.
const mkvElement = (id: number[], ...parts: (number[] | Uint8Array)[]) => {
	const size = parts.reduce((sum, part) => sum + part.length, 0);
	const sizeBytes = [0x01, 0, 0, 0, size >>> 24, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff];
	return [...id, ...sizeBytes, ...parts.flatMap(part => [...part])];
};
const mkvUint = (id: number[], value: number) => mkvElement(
	id,
	[value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff],
);
const mkvAscii = (text: string) => [...text].map(char => char.charCodeAt(0));
/** A Matroska file with a 1 ms timestamp scale. */
const buildMkv = (tracks: number[][], clusters: number[][]) => new Uint8Array([
	...mkvElement([0x1a, 0x45, 0xdf, 0xa3], mkvElement([0x42, 0x82], mkvAscii('matroska'))), // EBML header
	...mkvElement(
		[0x18, 0x53, 0x80, 0x67], // Segment
		mkvElement([0x15, 0x49, 0xa9, 0x66], mkvUint([0x2a, 0xd7, 0xb1], 1_000_000)), // Info with TimestampScale
		mkvElement([0x16, 0x54, 0xae, 0x6b], ...tracks), // Tracks
		...clusters,
	),
]);

test('Laced blocks spread their frames over the gap to the next block', async () => {
	// As in a broadcast recording remuxed to MKV: eight audio frames of 32 ms per block, blocks 256 ms apart, and a
	// DefaultDuration of 192 ms that can't be the duration of each frame. The frames must stay 32 ms apart instead of
	// following the DefaultDuration into the next block.
	const frameSize = 512; // 32 ms of 16-bit mono PCM at 8 kHz
	const lacedBlock = (relativeTimestamp: number) => mkvElement(
		[0xa3], // SimpleBlock
		[0x81, relativeTimestamp >> 8, relativeTimestamp & 0xff, 0x84, 8 - 1], // Track 1, key frame, fixed-size lacing
		new Uint8Array(8 * frameSize),
	);
	const bytes = buildMkv(
		[mkvElement(
			[0xae], // TrackEntry
			mkvUint([0xd7], 1),
			mkvUint([0x73, 0xc5], 1),
			mkvUint([0x83], 2),
			mkvElement([0x86], mkvAscii('A_PCM/INT/LIT')),
			mkvUint([0x23, 0xe3, 0x83], 192_000_000), // DefaultDuration
			mkvElement(
				[0xe1], // Audio
				mkvElement([0xb5], [0x40, 0xbf, 0x40, 0, 0, 0, 0, 0]), // SamplingFrequency 8000
				mkvUint([0x9f], 1), // Channels
				mkvUint([0x62, 0x64], 16), // BitDepth
			),
		)],
		[mkvElement([0x1f, 0x43, 0xb6, 0x75], mkvUint([0xe7], 0), lacedBlock(0), lacedBlock(256), lacedBlock(512))],
	);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packets: [number, number][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([Math.round(packet.timestamp * 1000), Math.round(packet.duration * 1000)]);
	}
	expect(packets.slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, i) => [32 * i, 32]));
});

test('A BlockDuration of 0 is the block\'s duration, not a missing one', async () => {
	// Only an absent BlockDuration is inferred, from the DefaultDuration or the next block (RFC 9559). Chromium also
	// takes 0 as the duration.
	const videoTrack = (trackNumber: number, ...extra: number[][]) => mkvElement(
		[0xae], // TrackEntry
		mkvUint([0xd7], trackNumber),
		mkvUint([0x73, 0xc5], trackNumber),
		mkvUint([0x83], 1),
		mkvElement([0x86], mkvAscii('V_VP8')),
		mkvElement([0xe0], mkvUint([0xb0], 16), mkvUint([0xba], 16)), // Video: 16x16
		...extra,
	);
	const blockGroup = (trackNumber: number, relativeTimestamp: number, blockDuration: number | null) => mkvElement(
		[0xa0], // BlockGroup
		mkvElement([0xa1], [0x80 | trackNumber, relativeTimestamp >> 8, relativeTimestamp & 0xff, 0, 0]), // Block
		...(blockDuration === null ? [] : [mkvUint([0x9b], blockDuration)]), // BlockDuration
	);
	const bytes = buildMkv(
		[videoTrack(1), videoTrack(2, mkvUint([0x23, 0xe3, 0x83], 10_000_000))], // Track 2: DefaultDuration 10 ms
		[mkvElement(
			[0x1f, 0x43, 0xb6, 0x75], // Cluster
			mkvUint([0xe7], 0),
			blockGroup(1, 0, 0),
			blockGroup(1, 20, 1),
			blockGroup(1, 40, 0),
			blockGroup(2, 0, 0),
			blockGroup(2, 20, null),
			blockGroup(2, 40, 0),
		)],
	);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const durations: Record<number, number[]> = {};
	for (const track of await input.getVideoTracks()) {
		const trackDurations: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			trackDurations.push(Math.round(packet.duration * 1000));
		}
		durations[track.number] = trackDurations;
	}

	// The zero durations used to become the 20 ms gap to the next block, or the DefaultDuration
	expect(durations).toEqual({ 1: [0, 1, 0], 2: [0, 10, 0] });
});
