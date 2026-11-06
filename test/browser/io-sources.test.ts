import { expect, test } from 'vitest';
import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSource,
	BlobSource,
	BufferSource,
	BufferTarget,
	EncodedPacketSink,
	Input,
	MkvOutputFormat,
	Mp4OutputFormat,
	Output,
	OutputFormat,
	ReadableStreamSource,
	Source,
	StreamTarget,
	UrlSource,
	WavOutputFormat,
} from '../../src/index.js';
import { Reader } from '../../src/reader.js';

const createRandom = (seed: number) => {
	let state = seed | 0;
	return () => {
		state = state + 0x6d2b79f5 | 0;
		let t = Math.imul(state ^ state >>> 15, 1 | state);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
};

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Concurrent random reads, compared against the expected bytes. */
const fuzzReads = async (source: Source, expected: Uint8Array, seed = 1) => {
	const random = createRandom(seed);
	using ref = source.ref();
	const reader = new Reader(ref.source);
	const problems: string[] = [];

	for (let round = 0; round < 20; round++) {
		const reads = Array.from({ length: 4 }, () => {
			const start = (random() * expected.length) | 0;
			const length = random() < 0.1 ? 2 * (expected.length - start) : 1 + ((random() * 100_000) | 0);
			return { start, length };
		});

		const slices = await Promise.all(reads.map(async ({ start, length }) => reader.requestSlice(start, length)));
		reads.forEach(({ start, length }, i) => {
			const slice = slices[i]!;
			if (start + length > expected.length) {
				if (slice) {
					problems.push(`[${start}, +${length}) lies past the end but returned data`);
				}
			} else if (!slice) {
				problems.push(`[${start}, +${length}) returned null`);
			} else if (!bytesEqual(
				slice.bytes.subarray(slice.bufferPos, slice.bufferPos + length),
				expected.subarray(start, start + length),
			)) {
				problems.push(`[${start}, +${length}) returned wrong bytes`);
			}
		});
	}

	expect(problems).toEqual([]);
};

const fetchBytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());

const countPackets = async (input: Input) => {
	let count = 0;
	for (const track of await input.getTracks()) {
		for await (const packet of new EncodedPacketSink(track).packets()) {
			void packet;
			count++;
		}
	}
	return count;
};

test('UrlSource reads random ranges from the dev server correctly', async () => {
	const expected = await fetchBytes('/video.mp4');
	await fuzzReads(new UrlSource('/video.mp4'), expected);
	await fuzzReads(new UrlSource('/video.mp4', { parallelism: 1, maxCacheSize: 100_000 }), expected, 2);
});

test('UrlSource reads random ranges from a blob: URL correctly', async () => {
	const expected = await fetchBytes('/frames.webm');
	const url = URL.createObjectURL(new Blob([expected]));
	try {
		await fuzzReads(new UrlSource(url), expected);
	} finally {
		URL.revokeObjectURL(url);
	}
});

test('BlobSource reads random ranges from a File correctly, with and without the stream reader', async () => {
	const expected = await fetchBytes('/video.mp4');
	const file = new File([expected], 'video.mp4', { type: 'video/mp4' });
	await fuzzReads(new BlobSource(file), expected);
	await fuzzReads(new BlobSource(file, { useStreamReader: false }), expected, 3);
	await fuzzReads(new BlobSource(file, { maxCacheSize: 0 }), expected, 4);
});

test('Files, blob streams and URLs demux the same as an in-memory buffer', async () => {
	const bytes = await fetchBytes('/frames.webm');
	using fromBuffer = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const expectedCount = await countPackets(fromBuffer);

	using fromFile = new Input({ source: new BlobSource(new File([bytes], 'frames.webm')), formats: ALL_FORMATS });
	expect(await countPackets(fromFile)).toBe(expectedCount);

	const stream = new Blob([bytes]).stream();
	using fromStream = new Input({ source: new ReadableStreamSource(stream), formats: ALL_FORMATS });
	expect(await countPackets(fromStream)).toBe(expectedCount);

	using fromUrl = new Input({ source: new UrlSource('/frames.webm'), formats: ALL_FORMATS });
	expect(await countPackets(fromUrl)).toBe(expectedCount);
});

const writePcmOutput = async (output: Output) => {
	output.setMetadataTags({ creationTime: new Date('2020-01-01T00:00:00Z') });
	const source = new AudioSampleSource({ codec: 'pcm-s16' });
	output.addAudioTrack(source);
	await output.start();
	for (let i = 0; i < 10; i++) {
		const data = new Float32Array(4800).map((_, k) => Math.sin((i * 4800 + k) / 10));
		await source.add(new AudioSample({
			data,
			format: 'f32',
			numberOfChannels: 1,
			sampleRate: 48000,
			timestamp: i / 10,
		}));
	}
	await output.finalize();
};

test.each([
	['MP4', () => new Mp4OutputFormat({ fastStart: false })],
	['MKV', () => new MkvOutputFormat()],
	['WAVE', () => new WavOutputFormat()],
] as [string, () => OutputFormat][])('%s: StreamTarget writes the same file to an OPFS file', async (_, format) => {
	const reference = new Output({ format: format(), target: new BufferTarget() });
	await writePcmOutput(reference);
	const expected = new Uint8Array(reference.target.buffer!);

	const root = await navigator.storage.getDirectory();
	for (const options of [{}, { chunked: true, chunkSize: 4096 }]) {
		const name = `io-target-${Math.random().toString(36).slice(2)}.bin`;
		const handle = await root.getFileHandle(name, { create: true });
		try {
			const writable = await handle.createWritable();
			await writePcmOutput(new Output({ format: format(), target: new StreamTarget(writable, options) }));

			const written = new Uint8Array(await (await handle.getFile()).arrayBuffer());
			expect(bytesEqual(written, expected)).toBe(true);
		} finally {
			await root.removeEntry(name);
		}
	}
});
