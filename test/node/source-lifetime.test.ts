import { expect, test, vi } from 'vitest';
import { CustomPathedSource, CustomSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input, InputDisposedError } from '../../src/input.js';
import { ALL_FORMATS, MP4 } from '../../src/input-format.js';
import { promiseWithResolvers } from '../../src/misc.js';
import { FileHandle, open, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Reader } from '../../src/reader.js';
import { setImmediate } from 'node:timers/promises';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Logging } from '../../src/logging.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Direct source disposal', async () => {
	const filePath = path.join(__dirname, '../public/video.mp4');
	const source = new FilePathSource(filePath);

	expect(!source._disposed);

	const ref = source.ref();
	ref.free();
	expect(source._disposed);
});

test('Implicit source disposal', async () => {
	const filePath = path.join(__dirname, '../public/video.mp4');
	const source = new FilePathSource(filePath);

	const input = new Input({
		source,
		formats: ALL_FORMATS,
	});
	expect(await input.getFormat()).toBe(MP4);

	expect(!source._disposed);
	input.dispose();
	expect(source._disposed);
});

test('Implicit source disposal, double input', async () => {
	const filePath = path.join(__dirname, '../public/video.mp4');
	const source = new FilePathSource(filePath);

	const input1 = new Input({
		source,
		formats: ALL_FORMATS,
	});
	const input2 = new Input({
		source,
		formats: ALL_FORMATS,
	});

	expect(await input1.getFormat()).toBe(MP4);
	expect(await input2.getFormat()).toBe(MP4);

	expect(!source._disposed);
	input1.dispose();
	expect(!source._disposed);
	input2.dispose();
	expect(source._disposed);
});

test.each([
	{ delayed: false, cancelRejects: false },
	{ delayed: false, cancelRejects: true },
	{ delayed: true, cancelRejects: false },
	{ delayed: true, cancelRejects: true },
])('CustomSource disposal (delayed=$delayed, rejects=$cancelRejects)', async ({ delayed, cancelRejects }) => {
	const started = promiseWithResolvers();
	const readResult = promiseWithResolvers<ReadableStream<Uint8Array>>();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const cancel = vi.fn(() => {
		if (cancelRejects) {
			throw new Error('Cancel failed');
		}
	});
	const stream = new ReadableStream<Uint8Array>({
		start(value) { controller = value; },
		pull() { started.resolve(); },
		cancel,
	}, { highWaterMark: 0 });
	const dispose = vi.fn();
	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomSource({
			getSize: () => 1024,
			read: () => {
				if (delayed) {
					started.resolve();
					return readResult.promise;
				}
				return stream;
			},
			dispose,
		}),
	});
	const result = input.getFormat().catch((error: unknown) => error);
	await started.promise;
	input.dispose();
	readResult.resolve(stream);
	try {
		expect(await result).toBeInstanceOf(InputDisposedError);
		await setImmediate();
		expect(dispose).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
		expect(stream.locked).toBe(false);
	} finally {
		if (cancel.mock.calls.length === 0) {
			controller.close();
		}
	}
});

test('CustomSource releases stream readers after successful reads', async () => {
	const bytes = await readFile(path.join(__dirname, '../public/video.mp4'));
	const streams: ReadableStream<Uint8Array>[] = [];
	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomSource({
			getSize: () => bytes.length,
			read: (start, end) => {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes.subarray(start, end));
						controller.close();
					},
				});
				streams.push(stream);
				return stream;
			},
		}),
	});
	expect(await input.getFormat()).toBe(MP4);
	expect(streams.length).toBeGreaterThan(0);
	expect(streams.every(stream => !stream.locked)).toBe(true);
});

test('CustomSource releases stream readers after read errors', async () => {
	const error = new Error('Read failed');
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) { controller.error(error); },
	});
	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomSource({ getSize: () => 1024, read: () => stream }),
	});
	await expect(input.getFormat()).rejects.toBe(error);
	expect(stream.locked).toBe(false);
});

test('FilePathSource rejects reads past the end of a file that got shorter', async () => {
	const filePath = path.join(tmpdir(), `mediabunny-shrinking-${process.pid}.bin`);
	await writeFile(filePath, new Uint8Array(100_000).fill(1));

	try {
		using ref = new FilePathSource(filePath, { maxCacheSize: 0 }).ref();
		const reader = new Reader(ref.source);
		expect(await reader.requestSlice(0, 10)).not.toBeNull(); // Learns the size: 100,000 bytes

		await truncate(filePath, 50_000);
		await expect(async () => reader.requestSlice(49_000, 2000)).rejects.toThrow(
			'Unexpected end of file at byte 50000',
		);
	} finally {
		await rm(filePath, { force: true });
	}
});

test('FilePathSource fills reads that the file system answers in parts', async () => {
	const filePath = path.join(tmpdir(), `mediabunny-partial-${process.pid}.bin`);
	const data = new Uint8Array(100_000).map((_, i) => i % 251);
	await writeFile(filePath, data);

	// Like FUSE or network file systems may, deliver at most 1000 bytes per read call
	const handle = await open(filePath, 'r');
	const fileHandlePrototype = Object.getPrototypeOf(handle) as FileHandle;
	await handle.close();
	const originalRead = Object.getOwnPropertyDescriptor(fileHandlePrototype, 'read')!.value as (
		...args: unknown[]
	) => Promise<unknown>;
	vi.spyOn(fileHandlePrototype, 'read').mockImplementation(function (
		this: FileHandle,
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	) {
		return originalRead.call(this, buffer, offset, Math.min(length, 1000), position);
	} as never);

	try {
		using ref = new FilePathSource(filePath).ref();
		const slice = await new Reader(ref.source).requestSlice(10_000, 50_000);
		const bytes = slice!.bytes.subarray(slice!.bufferPos, slice!.bufferPos + 50_000);
		expect(Buffer.compare(bytes, data.subarray(10_000, 60_000))).toBe(0);
	} finally {
		await rm(filePath, { force: true });
	}
});

test('CustomSource rejects falsy prefetchProfile values it cannot use', async () => {
	for (const prefetchProfile of ['', false, 0, null]) {
		expect(() => new CustomSource({
			getSize: () => 1024,
			read: (start, end) => new Uint8Array(end - start),
			prefetchProfile: prefetchProfile as never,
		})).toThrow(new TypeError(
			'options.prefetchProfile, when provided, must be one of \'none\', \'fileSystem\' or \'network\'.',
		));
	}
});

test('A throwing CustomSource dispose callback does not stop the rest of the input from disposing', async () => {
	// Minimal ADTS frames (AAC-LC, 44.1 kHz, stereo) with zeroed payloads
	const adtsFrames = (count: number) => {
		const frameLength = 7 + 10;
		const bytes = new Uint8Array(count * frameLength);
		for (let i = 0; i < count; i++) {
			const header = [0xff, 0xf1, 0x50, 0x80, frameLength >> 3, ((frameLength & 7) << 5) | 0x1f, 0xfc];
			bytes.set(header, i * frameLength);
		}
		return bytes;
	};

	const files = new Map<string, Uint8Array>([
		['index.m3u8', new TextEncoder().encode([
			'#EXTM3U',
			'#EXT-X-TARGETDURATION:1',
			'#EXT-X-PLAYLIST-TYPE:VOD',
			'#EXTINF:0.1,',
			'a.aac',
			'#EXTINF:0.1,',
			'b.aac',
			'#EXT-X-ENDLIST',
		].join('\n'))],
		['a.aac', adtsFrames(4)],
		['b.aac', adtsFrames(4)],
	]);

	const disposed: string[] = [];
	const loggedErrors: unknown[] = [];
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const unsubscribe = Logging.on('error', args => loggedErrors.push(args[1]));

	const input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource('index.m3u8', ({ path }) => {
			const name = path.split('/').pop()!;
			const bytes = files.get(name)!;
			return new CustomSource({
				getSize: () => bytes.length,
				read: (start, end) => bytes.subarray(start, end),
				dispose: () => {
					disposed.push(name);
					if (name === 'index.m3u8') {
						throw new Error('Dispose failed');
					}
				},
			});
		}),
	});

	try {
		const track = await input.getPrimaryAudioTrack();
		let packetCount = 0;
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			void packet;
			packetCount++;
		}
		expect(packetCount).toBe(8); // Both segments were read

		input.dispose();
		await setImmediate(); // The demuxer, and with it the segment inputs, gets disposed asynchronously

		expect(disposed.sort()).toEqual(['a.aac', 'b.aac', 'index.m3u8']);
		expect(loggedErrors).toEqual([new Error('Dispose failed')]);
	} finally {
		unsubscribe();
	}
});
