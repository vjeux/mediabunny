import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Reader } from '../../src/reader.js';
import {
	ALL_FORMATS,
	BlobSource,
	BufferSource,
	CustomPathedSource,
	CustomSource,
	EncodedPacketSink,
	FilePathSource,
	Input,
	InputDisposedError,
	Logging,
	LogLevel,
	MP4,
	ReadableStreamSource,
	Source,
	SourceRef,
	UnsupportedInputFormatError,
	UrlSource,
	WEBM,
} from '../../src/index.js';
import { bytesEqual, createRampBytes, createRandom, createRandomBytes } from './helpers/io-random.js';
import { ByteServerOptions, startByteServer } from './helpers/io-http.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const videoMp4Path = path.join(__dirname, '../public/video.mp4');
const framesWebmPath = path.join(__dirname, '../public/frames.webm');

/** Reads [start, start + length) through a Reader, returning the bytes or null. */
const readRange = async (reader: Reader, start: number, length: number) => {
	const slice = await reader.requestSlice(start, length);
	if (!slice) {
		return null;
	}

	return slice.bytes.slice(slice.bufferPos, slice.bufferPos + length);
};

/**
 * Hammers a source with deterministic batches of concurrent random reads (in-bounds, straddling the end, zero-length)
 * and checks every result against the expected bytes.
 */
const fuzzReads = async (source: Source, expected: Uint8Array, options: {
	seed?: number;
	rounds?: number;
	concurrency?: number;
	maxLength?: number;
} = {}) => {
	const random = createRandom(options.seed ?? 1);
	const rounds = options.rounds ?? 30;
	const concurrency = options.concurrency ?? 4;
	const maxLength = options.maxLength ?? 200_000;
	const size = expected.length;

	using ref = source.ref();
	const reader = new Reader(ref.source);
	const problems: string[] = [];

	for (let round = 0; round < rounds; round++) {
		const reads: { start: number; length: number }[] = [];
		for (let i = 0; i < concurrency; i++) {
			const kind = random();
			if (kind < 0.1) {
				reads.push({ start: size - ((random() * 1000) | 0), length: (random() * 2000) | 0 });
			} else if (kind < 0.15) {
				reads.push({ start: (random() * size) | 0, length: 0 });
			} else {
				const length = 1 + ((random() * (random() < 0.5 ? 64 : maxLength)) | 0);
				reads.push({ start: (random() * size) | 0, length });
			}
		}

		const results = await Promise.all(reads.map(({ start, length }) => readRange(reader, start, length)));
		for (let i = 0; i < reads.length; i++) {
			const { start, length } = reads[i]!;
			const result = results[i]!;

			if (start + length > size) {
				if (result !== null) {
					problems.push(`[${start}, +${length}) lies past the end but returned data`);
				}
			} else if (result === null) {
				problems.push(`[${start}, +${length}) returned null`);
			} else if (!bytesEqual(result, expected.subarray(start, start + length))) {
				problems.push(`[${start}, +${length}) returned wrong bytes`);
			}
		}
	}

	expect(problems).toEqual([]);
};

const readFileBytes = (filePath: string) => new Uint8Array(fs.readFileSync(filePath));

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

const silenceLogs = () => {
	const previous = Logging.level;
	Logging.level = LogLevel.Silent;
	return () => {
		Logging.level = previous;
	};
};

const FUZZ_DATA = createRandomBytes(2 * 2 ** 20 + 4321, 42);

describe('BufferSource', () => {
	test('reads ArrayBuffers, typed array views with a byteOffset, DataViews and SharedArrayBuffers', async () => {
		const data = createRampBytes(1000);
		const backing = new Uint8Array(1500);
		backing.set(data, 300);
		const shared = new SharedArrayBuffer(1000);
		new Uint8Array(shared).set(data);
		const nodeBuffer = Buffer.alloc(1000);
		nodeBuffer.set(data);

		const sources = [
			new BufferSource(data.slice().buffer),
			new BufferSource(backing.subarray(300, 1300)),
			new BufferSource(new DataView(backing.buffer, 300, 1000)),
			new BufferSource(new Int16Array(backing.buffer, 300, 500)),
			new BufferSource(shared),
			new BufferSource(new Uint8Array(shared)),
			new BufferSource(nodeBuffer),
		];

		for (const source of sources) {
			expect(await source.getSize()).toBe(1000);
			using ref = source.ref();
			const reader = new Reader(ref.source);
			expect(await readRange(reader, 0, 4)).toEqual(new Uint8Array([0, 1, 2, 3]));
			expect(await readRange(reader, 996, 4)).toEqual(new Uint8Array([228, 229, 230, 231]));
			expect(await readRange(reader, 997, 4)).toBeNull();
			expect(await readRange(reader, 1000, 0)).toEqual(new Uint8Array(0));
			expect(await readRange(reader, -1, 2)).toBeNull();
		}
	});

	test('reads a Node.js Buffer that lives inside a pooled allocation', async () => {
		const pooled = Buffer.from('xxThe quick brown foxyy').subarray(2, 21); // Shares the pool, byteOffset != 0
		expect(pooled.byteOffset).toBeGreaterThan(0);

		using ref = new BufferSource(pooled).ref();
		const reader = new Reader(ref.source);
		expect(new TextDecoder().decode((await readRange(reader, 0, 19))!)).toBe('The quick brown fox');
	});

	test('rejects values that are not buffers', () => {
		for (const value of ['abc', 123, [1, 2, 3], null, {}]) {
			expect(() => new BufferSource(value as never)).toThrow(
				new TypeError('buffer must be an ArrayBuffer, SharedArrayBuffer, or ArrayBufferView.'),
			);
		}
	});

	test('emits a single read event spanning the whole buffer, also to the deprecated onread callback', async () => {
		const source = new BufferSource(new Uint8Array(500));
		const events: [number, number][] = [];
		const legacyEvents: [number, number][] = [];
		source.on('read', ({ start, end }) => events.push([start, end]));
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		source.onread = (start, end) => legacyEvents.push([start, end]);

		using ref = source.ref();
		const reader = new Reader(ref.source);
		await readRange(reader, 100, 10);
		await readRange(reader, 300, 10);

		expect(events).toEqual([[0, 500]]);
		expect(legacyEvents).toEqual([[0, 500]]);
	});

	test('an empty buffer has size 0 and is not a recognizable format', async () => {
		using input = new Input({ source: new BufferSource(new ArrayBuffer(0)), formats: ALL_FORMATS });
		expect(await input.source.getSize()).toBe(0);
		expect(await input.canRead()).toBe(false);
		await expect(input.getFormat()).rejects.toBeInstanceOf(UnsupportedInputFormatError);
	});
});

describe('Source.slice (RangedSource)', () => {
	test('validates offset and length', () => {
		const source = new BufferSource(new Uint8Array(10));
		expect(() => source.slice(-1)).toThrow(new TypeError('offset must be a non-negative integer.'));
		expect(() => source.slice(1.5)).toThrow(new TypeError('offset must be a non-negative integer.'));
		expect(() => source.slice(0, -1)).toThrow(
			new TypeError('length, when provided, must be a non-negative integer.'),
		);
		expect(() => source.slice(0, 2.5)).toThrow(
			new TypeError('length, when provided, must be a non-negative integer.'),
		);
	});

	test('maps reads and sizes onto the base source, also when nested', async () => {
		const data = createRampBytes(1000);
		const base = new BufferSource(data);

		const tail = base.slice(100);
		expect(await tail.getSize()).toBe(900);

		const window = base.slice(100, 50);
		expect(await window.getSize()).toBe(50);

		const nested = base.slice(100, 500).slice(50, 20);
		expect(await nested.getSize()).toBe(20);

		const pastTheEnd = base.slice(2000);
		expect(await pastTheEnd.getSize()).toBe(0);

		using tailRef = tail.ref();
		using windowRef = window.ref();
		using nestedRef = nested.ref();
		expect(await readRange(new Reader(tailRef.source), 0, 3)).toEqual(new Uint8Array([100, 101, 102]));
		expect(await readRange(new Reader(windowRef.source), 47, 3)).toEqual(new Uint8Array([147, 148, 149]));
		expect(await readRange(new Reader(windowRef.source), 48, 3)).toBeNull();
		expect(await readRange(new Reader(nestedRef.source), 0, 20)).toEqual(createRampBytes(20, 150));
		expect(await readRange(new Reader(nestedRef.source), 1, 20)).toBeNull();
	});

	test('reads a media file embedded within a larger file', async () => {
		const mp4 = readFileBytes(videoMp4Path);
		const container = new Uint8Array(mp4.length + 3000);
		container.set(createRandomBytes(1000, 3), 0);
		container.set(mp4, 1000);
		container.set(createRandomBytes(2000, 4), 1000 + mp4.length);

		using standalone = new Input({ source: new BufferSource(mp4), formats: ALL_FORMATS });
		using embedded = new Input({
			source: new BufferSource(container).slice(1000, mp4.length),
			formats: ALL_FORMATS,
		});

		expect(await embedded.getFormat()).toBe(MP4);
		expect(await embedded.computeDuration()).toBe(await standalone.computeDuration());
		expect(await countPackets(embedded)).toBe(await countPackets(standalone));
	});

	test('cannot slice a disposed source', () => {
		const source = new BufferSource(new Uint8Array(10));
		source.ref().free();
		expect(() => source.slice(1)).toThrow('Cannot create a slice of a disposed source.');
	});

	test('passes the random read fuzz over a BufferSource and a CustomSource base', async () => {
		const padded = new Uint8Array(FUZZ_DATA.length + 5000);
		padded.set(FUZZ_DATA, 1234);

		await fuzzReads(new BufferSource(padded).slice(1234, FUZZ_DATA.length), FUZZ_DATA);
		await fuzzReads(
			new CustomSource({
				getSize: () => padded.length,
				read: (start, end) => padded.slice(start, end),
				prefetchProfile: 'fileSystem',
			}).slice(1234, FUZZ_DATA.length),
			FUZZ_DATA,
		);
	});
});

describe('BlobSource', () => {
	test('knows its size without reading', async () => {
		const source = new BlobSource(new Blob([new Uint8Array(12345)]));
		const read = vi.fn();
		source.on('read', read);
		expect(await source.getSize()).toBe(12345);
		expect(read).not.toHaveBeenCalled();
	});

	test.each([
		{ name: 'stream reader', options: {} },
		{ name: 'arrayBuffer() reads', options: { useStreamReader: false } },
		{ name: 'a tiny cache', options: { maxCacheSize: 4096 } },
		{ name: 'no cache', options: { maxCacheSize: 0 } },
	])('passes the random read fuzz with $name', async ({ options }) => {
		await fuzzReads(new BlobSource(new Blob([FUZZ_DATA]), options), FUZZ_DATA);
	});

	test('emits read events that stay within the blob and cover every requested byte', async () => {
		const data = createRandomBytes(300_000, 5);
		const source = new BlobSource(new Blob([data]), { useStreamReader: false });
		const events: [number, number][] = [];
		source.on('read', ({ start, end }) => events.push([start, end]));

		using ref = source.ref();
		const reader = new Reader(ref.source);
		const requested: [number, number][] = [[0, 10], [150_000, 150_100], [299_990, 300_000]];
		for (const [start, end] of requested) {
			await readRange(reader, start, end - start);
		}

		for (const [start, end] of events) {
			expect(start).toBeGreaterThanOrEqual(0);
			expect(end).toBeLessThanOrEqual(data.length);
			expect(start).toBeLessThan(end);
		}
		for (const [start, end] of requested) {
			expect(events.some(([eventStart, eventEnd]) => eventStart <= start && end <= eventEnd)).toBe(true);
		}
	});

	test('validates its arguments', () => {
		expect(() => new BlobSource(new Uint8Array(1) as never)).toThrow(new TypeError('blob must be a Blob.'));
		const blob = new Blob([]);
		expect(() => new BlobSource(blob, null as never)).toThrow(new TypeError('options must be an object.'));
		expect(() => new BlobSource(blob, { maxCacheSize: -1 })).toThrow(
			new TypeError('options.maxCacheSize, when provided, must be a non-negative number.'),
		);
		expect(() => new BlobSource(blob, { maxCacheSize: NaN })).toThrow(TypeError);
		expect(() => new BlobSource(blob, { useStreamReader: 1 as never })).toThrow(
			new TypeError('options.useStreamReader, when provided, must be a boolean.'),
		);
		expect(() => new BlobSource(blob, { handleUnhandledError: 1 as never })).toThrow(
			new TypeError('options.handleUnhandledError, when provided, must be a function.'),
		);
		expect(() => new BlobSource(blob, { maxCacheSize: Infinity })).not.toThrow();
	});

	test('reads a WebM file the same as a BufferSource does', async () => {
		const bytes = readFileBytes(framesWebmPath);
		using fromBlob = new Input({ source: new BlobSource(new Blob([bytes])), formats: ALL_FORMATS });
		using fromBuffer = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

		expect(await fromBlob.getFormat()).toBe(WEBM);
		expect(await countPackets(fromBlob)).toBe(await countPackets(fromBuffer));
	});
});

describe('CustomSource', () => {
	test('calls read with 0 <= start < end <= size, end reaching the size for the last bytes', async () => {
		const data = createRampBytes(5000);
		const calls: [number, number][] = [];
		using ref = new CustomSource({
			getSize: () => data.length,
			read: (start, end) => {
				calls.push([start, end]);
				return data.slice(start, end);
			},
		}).ref();
		const reader = new Reader(ref.source);

		expect(await readRange(reader, 4990, 10)).toEqual(data.slice(4990));
		expect(await readRange(reader, 0, 1)).toEqual(new Uint8Array([0]));
		expect(await readRange(reader, 4999, 2)).toBeNull();

		expect(calls.length).toBeGreaterThan(0);
		for (const [start, end] of calls) {
			expect(start).toBeGreaterThanOrEqual(0);
			expect(start).toBeLessThan(end);
			expect(end).toBeLessThanOrEqual(data.length);
		}
		expect(calls.some(([, end]) => end === data.length)).toBe(true);
	});

	test('calls getSize before the first read', async () => {
		const order: string[] = [];
		using ref = new CustomSource({
			getSize: async () => {
				order.push('getSize');
				return 100;
			},
			read: (start, end) => {
				order.push('read');
				return new Uint8Array(end - start);
			},
		}).ref();
		await readRange(new Reader(ref.source), 10, 10);
		expect(order[0]).toBe('getSize');
		expect(order).toContain('read');
	});

	test('accepts Node.js Buffers and ReadableStreams of any chunking from read', async () => {
		const data = createRandomBytes(100_000, 6);
		await fuzzReads(new CustomSource({
			getSize: () => data.length,
			read: (start, end) => Buffer.from(data.subarray(start, end)),
		}), data, { rounds: 10, maxLength: 20_000 });

		await fuzzReads(new CustomSource({
			getSize: () => data.length,
			read: (start, end) => new ReadableStream<Uint8Array>({
				start(controller) {
					// Awkward chunk sizes, including empty chunks
					let position = start;
					let step = 1;
					while (position < end) {
						controller.enqueue(new Uint8Array(0));
						controller.enqueue(data.slice(position, Math.min(end, position + step)));
						position += step;
						step = step * 3 + 1;
					}
					controller.close();
				},
			}),
		}), data, { rounds: 10, maxLength: 20_000 });
	});

	test.each(['none', 'fileSystem', 'network'] as const)(
		'passes the random read fuzz with the %s prefetch profile, sync, async and with a small cache',
		async (prefetchProfile) => {
			await fuzzReads(new CustomSource({
				getSize: () => FUZZ_DATA.length,
				read: (start, end) => FUZZ_DATA.slice(start, end),
				prefetchProfile,
			}), FUZZ_DATA);

			await fuzzReads(new CustomSource({
				getSize: async () => FUZZ_DATA.length,
				read: async (start, end) => {
					await new Promise(resolve => setTimeout(resolve, 1));
					return FUZZ_DATA.slice(start, end);
				},
				prefetchProfile,
				maxCacheSize: 100_000,
			}), FUZZ_DATA, { rounds: 15 });
		},
	);

	test('rejects reads that return the wrong number of bytes', async () => {
		using ref = new CustomSource({
			getSize: () => 1000,
			read: () => new Uint8Array(3),
		}).ref();

		await expect(readRange(new Reader(ref.source), 0, 10)).rejects.toThrow(
			'options.read returned a Uint8Array with unexpected length: Requested 10 bytes, but got 3.',
		);
	});

	test('rejects streams that end early or yield non-Uint8Array chunks', async () => {
		using shortRef = new CustomSource({
			getSize: () => 1000,
			read: () => new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(4));
					controller.close();
				},
			}),
		}).ref();
		await expect(readRange(new Reader(shortRef.source), 0, 10)).rejects.toThrow(
			'ReadableStream returned by options.read ended before supplying enough data. Requested 10 bytes, but got 4',
		);

		using badChunkRef = new CustomSource({
			getSize: () => 1000,
			read: () => new ReadableStream<unknown>({
				start(controller) {
					controller.enqueue('not bytes');
					controller.close();
				},
			}) as ReadableStream<Uint8Array>,
		}).ref();
		await expect(readRange(new Reader(badChunkRef.source), 0, 10)).rejects.toThrow(
			new TypeError('ReadableStream returned by options.read must yield Uint8Array chunks.'),
		);

		using badValueRef = new CustomSource({
			getSize: () => 1000,
			read: () => [1, 2, 3] as never,
		}).ref();
		await expect(readRange(new Reader(badValueRef.source), 0, 3)).rejects.toThrow(
			new TypeError('options.read must return or resolve to a Uint8Array or a ReadableStream.'),
		);
	});

	test.each([-1, 1.5, NaN, '10'])('rejects getSize results like %s', async (size) => {
		using syncRef = new CustomSource({ getSize: () => size as number, read: () => new Uint8Array(1) }).ref();
		expect(() => new Reader(syncRef.source).requestSlice(0, 1)).toThrow(
			new TypeError('options.getSize must return or resolve to a non-negative integer.'),
		);

		using asyncRef = new CustomSource({
			getSize: async () => size as number,
			read: () => new Uint8Array(1),
		}).ref();
		await expect(readRange(new Reader(asyncRef.source), 0, 1)).rejects.toThrow(
			new TypeError('options.getSize must return or resolve to a non-negative integer.'),
		);
	});

	test('surfaces read errors through the Input and calls dispose exactly once', async () => {
		const error = new Error('Disk on fire');
		const dispose = vi.fn();
		const input = new Input({
			source: new CustomSource({ getSize: () => 1000, read: () => { throw error; }, dispose }),
			formats: ALL_FORMATS,
		});

		await expect(input.getFormat()).rejects.toBe(error);
		input.dispose();
		input.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	test('validates its options', () => {
		const read = () => new Uint8Array(0);
		const getSize = () => 0;
		expect(() => new CustomSource(null as never)).toThrow(new TypeError('options must be an object.'));
		expect(() => new CustomSource({ read } as never)).toThrow(
			new TypeError('options.getSize must be a function.'),
		);
		expect(() => new CustomSource({ getSize } as never)).toThrow(new TypeError('options.read must be a function.'));
		expect(() => new CustomSource({ getSize, read, dispose: 1 as never })).toThrow(
			new TypeError('options.dispose, when provided, must be a function.'),
		);
		expect(() => new CustomSource({ getSize, read, maxCacheSize: -5 })).toThrow(
			new TypeError('options.maxCacheSize, when provided, must be a non-negative number.'),
		);
		expect(() => new CustomSource({ getSize, read, prefetchProfile: 'turbo' as never })).toThrow(
			new TypeError(
				'options.prefetchProfile, when provided, must be one of \'none\', \'fileSystem\' or \'network\'.',
			),
		);
		expect(() => new CustomSource({ getSize, read, handleUnhandledError: 'no' as never })).toThrow(
			new TypeError('options.handleUnhandledError, when provided, must be a function.'),
		);
	});
});

describe('FilePathSource', () => {
	test('reads files and knows their size', async () => {
		const tempPath = path.join(os.tmpdir(), `mediabunny-io-sources-${process.pid}.bin`);
		fs.writeFileSync(tempPath, FUZZ_DATA);

		try {
			const source = new FilePathSource(tempPath);
			expect(await source.getSize()).toBe(FUZZ_DATA.length);
			source.ref().free();

			await fuzzReads(new FilePathSource(tempPath), FUZZ_DATA);
			await fuzzReads(new FilePathSource(tempPath, { maxCacheSize: 0 }), FUZZ_DATA, { rounds: 10 });
		} finally {
			fs.rmSync(tempPath, { force: true });
		}
	});

	test('reads a media file the same as a BufferSource does', async () => {
		using fromPath = new Input({ source: new FilePathSource(videoMp4Path), formats: ALL_FORMATS });
		using fromBuffer = new Input({ source: new BufferSource(readFileBytes(videoMp4Path)), formats: ALL_FORMATS });
		expect(await countPackets(fromPath)).toBe(await countPackets(fromBuffer));
	});

	test('rejects with the file system error for missing files', async () => {
		using input = new Input({
			source: new FilePathSource(path.join(os.tmpdir(), 'mediabunny-definitely-missing.mp4')),
			formats: ALL_FORMATS,
		});
		await expect(input.getFormat()).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('validates its arguments', () => {
		expect(() => new FilePathSource(1 as never)).toThrow(new TypeError('filePath must be a string.'));
		expect(() => new FilePathSource('x', null as never)).toThrow(new TypeError('options must be an object.'));
		expect(() => new FilePathSource('x', { maxCacheSize: -1 })).toThrow(
			new TypeError('options.maxCacheSize, when provided, must be a non-negative number.'),
		);
	});
});

describe('ReadableStreamSource', () => {
	const streamOf = (data: Uint8Array, chunkSizes: (index: number) => number) => {
		return new ReadableStream<Uint8Array>({
			start(controller) {
				let position = 0;
				let index = 0;
				while (position < data.length) {
					const size = chunkSizes(index++);
					controller.enqueue(data.slice(position, position + size));
					position += size;
				}
				controller.close();
			},
		});
	};

	test('is unsized', async () => {
		const source = new ReadableStreamSource(streamOf(new Uint8Array(10), () => 10));
		expect(await source.getSizeOrNull()).toBeNull();
		await expect(source.getSize()).rejects.toThrow('Cannot determine the size of an unsized source.');
	});

	test('reads sequentially across chunks of any size, including empty and 1-byte chunks', async () => {
		const data = createRandomBytes(50_000, 7);
		const random = createRandom(8);
		const chunkSizes = (i: number) => (i % 5 === 0 ? 0 : 1 + ((random() * 3000) | 0));
		using ref = new ReadableStreamSource(streamOf(data, chunkSizes)).ref();
		const reader = new Reader(ref.source);

		let position = 0;
		while (position < data.length) {
			const length = Math.min(1 + ((random() * 5000) | 0), data.length - position);
			expect(await readRange(reader, position, length)).toEqual(data.subarray(position, position + length));
			position += length;
		}

		expect(await readRange(reader, data.length - 10, 11)).toBeNull();
		expect(reader.fileSize).toBe(data.length);
		expect(await readRange(reader, data.length, 1)).toBeNull();
	});

	test('serves backwards reads from the cache and throws once data was evicted', async () => {
		const data = createRandomBytes(200_000, 9);
		using ref = new ReadableStreamSource(streamOf(data, () => 10_000), { maxCacheSize: 50_000 }).ref();
		const reader = new Reader(ref.source);

		expect(await readRange(reader, 150_000, 10)).toEqual(data.subarray(150_000, 150_010));
		expect(await readRange(reader, 110_000, 10)).toEqual(data.subarray(110_000, 110_010));
		expect(() => reader.requestSlice(10_000, 10)).toThrow(
			'Attempted to read data from an already-evicted part of the cache. With ReadableStreamSource, you must'
			+ ' access the data more sequentially or increase the size of its cache.',
		);
	});

	test('rejects pending reads with InputDisposedError on dispose and cancels the stream', async () => {
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(10));
			},
			cancel,
		});
		const source = new ReadableStreamSource(stream);
		const ref = source.ref();
		const pending = readRange(new Reader(source), 0, 100);
		ref.free();

		await expect(pending).rejects.toBeInstanceOf(InputDisposedError);
		await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
	});

	test('demuxes a WebM file streamed in small chunks like a BufferSource does', async () => {
		const bytes = readFileBytes(framesWebmPath);
		using fromStream = new Input({
			source: new ReadableStreamSource(streamOf(bytes, () => 1000)),
			formats: ALL_FORMATS,
		});
		using fromBuffer = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

		expect(await fromStream.getFormat()).toBe(WEBM);
		expect(await countPackets(fromStream)).toBe(await countPackets(fromBuffer));
	});

	test('validates its arguments', () => {
		expect(() => new ReadableStreamSource(new Uint8Array(1) as never)).toThrow(
			new TypeError('stream must be a ReadableStream.'),
		);
		const stream = new ReadableStream<Uint8Array>();
		expect(() => new ReadableStreamSource(stream, null as never)).toThrow(
			new TypeError('options must be an object.'),
		);
		expect(() => new ReadableStreamSource(stream, { maxCacheSize: -1 })).toThrow(
			new TypeError('options.maxCacheSize, when provided, must be a non-negative number.'),
		);
		expect(() => new ReadableStreamSource(stream, { handleUnhandledError: 1 as never })).toThrow(
			new TypeError('options.handleUnhandledError, when provided, must be a function.'),
		);
	});
});

describe('UrlSource', () => {
	const withServer = async (
		data: Uint8Array,
		options: ByteServerOptions,
		run: (server: Awaited<ReturnType<typeof startByteServer>>) => Promise<void>,
	) => {
		const server = await startByteServer(data, options);
		const restoreLogs = silenceLogs();
		try {
			await run(server);
		} finally {
			restoreLogs();
			server.close();
		}
	};

	test.each([
		{ name: 'Content-Range with the total size', options: {} },
		{ name: 'no Content-Length or Content-Range', options: { contentRange: 'none', contentLength: false } },
		{ name: 'a body trickling in', options: { chunkSize: 4096, trickle: true } },
	] satisfies { name: string; options: ByteServerOptions }[])(
		'passes the random read fuzz against 206 responses with $name',
		async ({ options }) => {
			await withServer(FUZZ_DATA, options, async (server) => {
				await fuzzReads(new UrlSource(server.url), FUZZ_DATA, { rounds: 15 });
				await fuzzReads(new UrlSource(server.url, { parallelism: 3, maxCacheSize: 300_000 }), FUZZ_DATA, {
					rounds: 15,
					seed: 2,
				});
			});
		},
		30_000,
	);

	test('passes the random read fuzz without a cache and with reads larger than the prefetch', async () => {
		await withServer(FUZZ_DATA, {}, async (server) => {
			for (const parallelism of [1, 2]) {
				await fuzzReads(new UrlSource(server.url, { maxCacheSize: 0, parallelism }), FUZZ_DATA, {
					rounds: 10,
					maxLength: 600_000,
				});
			}
		});
	}, 30_000);

	test('passes the random read fuzz when the server ignores Range and sends the whole file', async () => {
		for (const contentLength of [true, false]) {
			await withServer(FUZZ_DATA, { honorRanges: false, contentLength }, async (server) => {
				await fuzzReads(new UrlSource(server.url), FUZZ_DATA, { rounds: 15 });
			});
		}
	}, 30_000);

	test('names the cause when a server without Range support makes it read evicted data', async () => {
		await withServer(FUZZ_DATA, { honorRanges: false }, async (server) => {
			using ref = new UrlSource(server.url, { maxCacheSize: 300_000 }).ref();
			const reader = new Reader(ref.source);
			await reader.requestSlice(FUZZ_DATA.length - 100, 100);
			await expect(async () => reader.requestSlice(0, 100)).rejects.toThrow(
				'Because the HTTP server did not honor the range request, data can only be read sequentially',
			);
		});
	});

	test('learns the size from Content-Range, or from the end of the body when the server states none', async () => {
		await withServer(FUZZ_DATA, {}, async (server) => {
			const source = new UrlSource(server.url);
			expect(await source.getSize()).toBe(FUZZ_DATA.length);
		});

		await withServer(createRampBytes(1000), { contentRange: 'none', contentLength: false }, async (server) => {
			const source = new UrlSource(server.url);
			using ref = source.ref();
			const reader = new Reader(ref.source);
			expect(await readRange(reader, 0, 10)).toEqual(createRampBytes(10));
			expect(reader.fileSizeNonStrict).toBeNull(); // Unknown while the body is still coming in

			expect(await readRange(reader, 995, 10)).toBeNull();
			expect(reader.fileSize).toBe(1000);
			expect(await readRange(reader, 995, 5)).toEqual(createRampBytes(5, 995));
		});
	});

	test('always asks for an open-ended byte range', async () => {
		await withServer(FUZZ_DATA, {}, async (server) => {
			using ref = new UrlSource(server.url).ref();
			const reader = new Reader(ref.source);
			await readRange(reader, 0, 10);
			await readRange(reader, 1_500_000, 10);

			expect(server.requests.length).toBeGreaterThan(0);
			for (const request of server.requests) {
				expect(request.range).toMatch(/^bytes=\d+-$/);
			}
		});
	});

	test('treats a Range header in requestInit as a byte window into the resource', async () => {
		const data = createRampBytes(1000);
		await withServer(data, {}, async (server) => {
			const openEnded = new UrlSource(server.url, { requestInit: { headers: { range: 'bytes=100-' } } });
			expect(await openEnded.getSize()).toBe(900);
			using openEndedRef = openEnded.ref();
			expect(await readRange(new Reader(openEndedRef.source), 0, 3)).toEqual(new Uint8Array([100, 101, 102]));

			const bounded = new UrlSource(server.url, { requestInit: { headers: { Range: 'bytes=200-209' } } });
			using boundedRef = bounded.ref();
			const reader = new Reader(boundedRef.source);
			expect(await readRange(reader, 5, 5)).toEqual(new Uint8Array([205, 206, 207, 208, 209]));
			expect(await readRange(reader, 5, 6)).toBeNull();
			expect(reader.fileSize).toBe(10);
		});
	});

	test('sends requestInit headers, letting its own Range header win case-insensitively', async () => {
		await withServer(createRampBytes(100), {}, async (server) => {
			using ref = new UrlSource(server.url, {
				requestInit: { headers: new Headers({ 'X-Custom': 'yes', 'Accept': 'video/mp4' }) },
			}).ref();
			await readRange(new Reader(ref.source), 0, 10);

			const request = server.requests[0]!;
			expect(request.headers['x-custom']).toBe('yes');
			expect(request.headers['accept']).toBe('video/mp4');
			expect(request.range).toBe('bytes=0-');
		});
	});

	test('routes every request through fetchFn', async () => {
		await withServer(FUZZ_DATA, {}, async (server) => {
			const fetchFn = vi.fn((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
			await fuzzReads(new UrlSource(server.url, { fetchFn }), FUZZ_DATA, { rounds: 5 });
			expect(fetchFn.mock.calls.length).toBeGreaterThan(0);
			expect(fetchFn.mock.calls.length).toBe(server.requests.length);
		});
	});

	test('follows redirects and resolves later paths against the final URL', async () => {
		await withServer(createRampBytes(100), { redirectPaths: ['/old.bin'] }, async (server) => {
			const source = new UrlSource(`${server.origin}/old.bin`);
			using ref = source.ref();
			expect(await readRange(new Reader(ref.source), 0, 4)).toEqual(new Uint8Array([0, 1, 2, 3]));
			expect(source.rootPath).toBe(server.url);
		});
	});

	test('rejects with the HTTP status for error responses', async () => {
		await withServer(createRampBytes(100), {}, async (server) => {
			using input = new Input({ source: new UrlSource(`${server.origin}/missing.bin`), formats: ALL_FORMATS });
			await expect(input.getFormat()).rejects.toThrow(
				`Error fetching ${server.origin}/missing.bin: 404 Not Found`,
			);
		});
	});

	test('rejects when a 206 response delivers no data and getRetryDelay gives up', async () => {
		const server = http.createServer((req, res) => {
			const start = /^bytes=(\d+)-/.exec(req.headers.range ?? '')![1];
			res.writeHead(206, { 'Content-Range': `bytes ${start}-999/1000`, 'Content-Length': 0 });
			res.end();
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const restoreLogs = silenceLogs();

		try {
			const { port } = server.address() as { port: number };
			using ref = new UrlSource(`http://127.0.0.1:${port}/empty.bin`, { getRetryDelay: () => null }).ref();
			await expect(async () => new Reader(ref.source).requestSlice(0, 10)).rejects.toThrow(
				'Range response ended without delivering any data.',
			);
		} finally {
			restoreLogs();
			server.closeAllConnections();
			server.close();
		}
	});

	test('retries failed fetches with the delays from getRetryDelay', async () => {
		await withServer(createRampBytes(100), { failFirstRequests: 2 }, async (server) => {
			const getRetryDelay = vi.fn(() => 0);
			using ref = new UrlSource(server.url, { getRetryDelay }).ref();
			expect(await readRange(new Reader(ref.source), 0, 4)).toEqual(new Uint8Array([0, 1, 2, 3]));

			expect(getRetryDelay.mock.calls.map(call => (call as unknown[])[0])).toEqual([1, 2]);
			for (const call of getRetryDelay.mock.calls as unknown[][]) {
				expect(call[1]).toBeInstanceOf(Error);
				expect(call[2]).toBe(server.url);
			}
		});
	});

	test('gives up when getRetryDelay returns null, and rejects invalid delays', async () => {
		await withServer(createRampBytes(100), { failFirstRequests: 1 }, async (server) => {
			using ref = new UrlSource(server.url, { getRetryDelay: () => null }).ref();
			await expect(readRange(new Reader(ref.source), 0, 4)).rejects.toThrow('fetch failed');
		});

		await withServer(createRampBytes(100), { failFirstRequests: 1 }, async (server) => {
			using ref = new UrlSource(server.url, { getRetryDelay: () => -1 }).ref();
			await expect(readRange(new Reader(ref.source), 0, 4)).rejects.toThrow(
				new TypeError('Retry delay must be a non-negative finite number.'),
			);
		});
	});

	test('reads the decoded bytes of a gzip-encoded 206 response in full', async () => {
		const data = new TextEncoder().encode('#EXTM3U\n'.repeat(5000));
		await withServer(data, { gzip: true }, async (server) => {
			using ref = new UrlSource(server.url).ref();
			const slice = await new Reader(ref.source).requestEntireFile();
			expect(slice!.length).toBe(data.length);
		});
	});

	test('rejects pending reads with InputDisposedError on dispose', async () => {
		await withServer(FUZZ_DATA, { chunkSize: 1024, chunkDelayMs: 20 }, async (server) => {
			const input = new Input({ source: new UrlSource(server.url), formats: ALL_FORMATS });
			const pending = input.getFormat();
			await new Promise(resolve => setTimeout(resolve, 30));
			input.dispose();
			await expect(pending).rejects.toBeInstanceOf(InputDisposedError);
		});
	});

	test('validates its arguments', () => {
		expect(() => new UrlSource(1 as never)).toThrow(new TypeError('url must be a string, URL or Request.'));
		expect(() => new UrlSource('x', null as never)).toThrow(new TypeError('options must be an object.'));
		expect(() => new UrlSource('x', { requestInit: 1 as never })).toThrow(
			new TypeError('options.requestInit, when provided, must be an object.'),
		);
		expect(() => new UrlSource('x', { getRetryDelay: 1 as never })).toThrow(
			new TypeError('options.getRetryDelay, when provided, must be a function.'),
		);
		expect(() => new UrlSource('x', { maxCacheSize: -1 })).toThrow(
			new TypeError('options.maxCacheSize, when provided, must be a non-negative number.'),
		);
		expect(() => new UrlSource('x', { parallelism: 0 })).toThrow(
			new TypeError('options.parallelism, when provided, must be a positive number.'),
		);
		expect(() => new UrlSource('x', { parallelism: 1.5 })).toThrow(TypeError);
		expect(() => new UrlSource('x', { fetchFn: 1 as never })).toThrow(
			new TypeError('options.fetchFn, when provided, must be a function.'),
		);
		expect(() => new UrlSource('x', { handleUnhandledError: 1 as never })).toThrow(
			new TypeError('options.handleUnhandledError, when provided, must be a function.'),
		);
		expect(new UrlSource(new URL('https://example.com/a.mp4?x=1')).rootPath).toBe('https://example.com/a.mp4?x=1');
		expect(new UrlSource(new Request('https://example.com/b.mp4')).rootPath).toBe('https://example.com/b.mp4');
	});
});

describe('SourceRef', () => {
	test('reference counts the source and disposes it once the last ref is freed', () => {
		const source = new BufferSource(new Uint8Array(10));
		const a = source.ref();
		const b = source.ref();
		expect(a.source).toBe(source);

		a.free();
		expect(a.freed).toBe(true);
		expect(source._disposed).toBe(false);
		expect(() => a.source).toThrow('Can\'t get source; ref has already been freed.');
		expect(() => a.free()).toThrow('Illegal operation: double free on SourceRef.');

		{
			using c = source.ref();
			void c;
		}
		expect(source._disposed).toBe(false);

		b.free();
		expect(source._disposed).toBe(true);
		expect(() => source.ref()).toThrow('Cannot ref a disposed source.');
	});

	test('[Symbol.dispose] does not double free', () => {
		const ref = new BufferSource(new Uint8Array(10)).ref();
		ref.free();
		expect(() => ref[Symbol.dispose]()).not.toThrow();
	});

	test('an Input takes ownership of a passed SourceRef and frees it on dispose', async () => {
		const source = new BufferSource(readFileBytes(videoMp4Path));
		const keepAlive = source.ref();
		const ref = source.ref();

		const input = new Input({ source: ref, formats: ALL_FORMATS });
		expect(input.source).toBe(source);
		expect(await input.getFormat()).toBe(MP4);
		input.dispose();

		expect(ref.freed).toBe(true);
		expect(source._disposed).toBe(false); // keepAlive still holds it
		keepAlive.free();
		expect(source._disposed).toBe(true);
	});

	test('an Input rejects disposed sources', () => {
		const source = new BufferSource(new Uint8Array(10));
		source.ref().free();
		expect(() => new Input({ source, formats: ALL_FORMATS })).toThrow(
			new TypeError('options.source must not be a disposed Source.'),
		);
		expect(() => new Input({ source: {} as never, formats: ALL_FORMATS })).toThrow(
			new TypeError('options.source must be a Source or SourceRef.'),
		);
		expect(SourceRef).toBeTypeOf('function');
	});
});

describe('CustomPathedSource', () => {
	test('resolves the root path through the request handler, accepting Sources and SourceRefs', async () => {
		const bytes = readFileBytes(videoMp4Path);
		const requests: unknown[] = [];

		using sourceInput = new Input({
			source: new CustomPathedSource('media/video.mp4', (request) => {
				requests.push(request);
				return new BufferSource(bytes);
			}),
			formats: ALL_FORMATS,
		});
		expect(await sourceInput.getFormat()).toBe(MP4);
		expect(requests).toEqual([{ path: 'media/video.mp4', isRoot: true }]);

		const shared = new BufferSource(bytes);
		using sharedRef = shared.ref();
		using refInput = new Input({
			source: new CustomPathedSource('video.mp4', async () => shared.ref()),
			formats: ALL_FORMATS,
		});
		expect(await refInput.getFormat()).toBe(MP4);
		expect(await refInput.source.getSize()).toBe(bytes.length);
		void sharedRef;
	});

	test('rejects request handlers that return something else', async () => {
		using input = new Input({
			source: new CustomPathedSource('a.mp4', () => new Uint8Array(10) as never),
			formats: ALL_FORMATS,
		});
		await expect(input.getFormat()).rejects.toThrow(
			new TypeError('requestHandler must return or resolve to a Source or SourceRef.'),
		);
	});

	test('validates its arguments', () => {
		expect(() => new CustomPathedSource(1 as never, () => new BufferSource(new Uint8Array(1)))).toThrow(
			new TypeError('rootPath must be a string.'),
		);
		expect(() => new CustomPathedSource('a', 1 as never)).toThrow(
			new TypeError('requestHandler must be a function.'),
		);
	});
});
