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
import fs from 'node:fs';
import ts from 'typescript';
import os from 'node:os';
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

test('Declarations of the disposable classes compile without TypeScript\'s esnext lib', () => {
	// Emits the declaration files the package ships and type-checks a consumer against them with skipLibCheck off and
	// the ES2022 lib, which has no Disposable or Symbol.dispose
	const outDir = path.join(__dirname, '../../node_modules/.cache/mediabunny-disposable-declarations-test');
	fs.rmSync(outDir, { recursive: true, force: true });
	const config = ts.getParsedCommandLineOfConfigFile(path.join(__dirname, '../../src/tsconfig.json'), {}, {
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: () => {},
	})!;
	ts.createProgram({
		rootNames: [path.join(__dirname, '../../src/index.ts')],
		options: {
			...config.options, outDir, noCheck: true, emitDeclarationOnly: true, composite: false, incremental: false,
		},
	}).emit();

	const consumerFile = path.join(outDir, 'consumer.ts');
	fs.writeFileSync(consumerFile, [
		`import { Input, SourceRef, VideoSample, AudioSample } from './src/index.js';`,
		'export const used = [Input, SourceRef, VideoSample, AudioSample];',
	].join('\n'));
	const consumer = ts.createProgram({
		rootNames: [consumerFile],
		options: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
			types: [],
			strict: true,
			skipLibCheck: false,
			noEmit: true,
		},
	});
	const errorsInOwnDeclarations = ts.getPreEmitDiagnostics(consumer)
		.filter((diagnostic) => {
			// TypeScript's file names use / on every platform
			const file = diagnostic.file && path.relative(outDir, diagnostic.file.fileName).split(path.sep).join('/');
			return file?.startsWith('src/');
		})
		.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
	expect(errorsInOwnDeclarations).toEqual([]);
}, 60_000);

test('FilePathSource reads of 2 GiB or more are split into reads Node accepts', async () => {
	// Node rejects file reads of 2 GiB or more, and Linux transfers at most 0x7ffff000 bytes per call. A sparse file of
	// that size, read through a stand-in file handle that behaves like that without touching the buffer.
	const size = 2 ** 31 + 2 ** 20;
	const filePath = path.join(os.tmpdir(), `mediabunny-large-read-${process.pid}.bin`);
	await writeFile(filePath, new Uint8Array(0));
	await truncate(filePath, size);

	try {
		const source = new FilePathSource(filePath);
		expect(await source.getSize()).toBe(size);

		const realHandle = source._fileHandle!;
		const calls: { offset: number; length: number; position: number }[] = [];
		source._fileHandle = {
			read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
				if (length > 2 ** 31 - 1) {
					throw new RangeError(`The value of "length" is out of range. Received ${length}`);
				}
				calls.push({ offset, length, position });
				return { bytesRead: Math.min(length, 0x7ffff000), buffer };
			},
			close: () => realHandle.close(),
		} as unknown as FileHandle;

		const bytes = await source._customSource._options.read(0, size) as Uint8Array;
		expect(bytes.byteLength).toBe(size);

		// The reads cover the whole range, each one picking up where the previous one stopped
		let pos = 0;
		for (const call of calls) {
			expect(call.offset).toBe(pos);
			expect(call.position).toBe(pos);
			pos += Math.min(call.length, 0x7ffff000);
		}
		expect(pos).toBe(size);

		source._dispose();
	} finally {
		await rm(filePath);
	}
});

test('FilePathSource reads of 2 GiB or more stop with an error where a shrunken file ends', async () => {
	// The same sparse file, read through a stand-in file handle for which the file now ends after 1.5 GiB
	const size = 2 ** 31 + 2 ** 20;
	const filePath = path.join(os.tmpdir(), `mediabunny-large-shrunk-read-${process.pid}.bin`);
	await writeFile(filePath, new Uint8Array(0));
	await truncate(filePath, size);

	try {
		const source = new FilePathSource(filePath);
		expect(await source.getSize()).toBe(size);

		const realHandle = source._fileHandle!;
		const shrunkSize = 1.5 * 2 ** 30;
		source._fileHandle = {
			read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
				if (length > 2 ** 31 - 1) {
					throw new RangeError(`The value of "length" is out of range. Received ${length}`);
				}
				return { bytesRead: Math.max(0, Math.min(length, shrunkSize - position)), buffer };
			},
			close: () => realHandle.close(),
		} as unknown as FileHandle;

		await expect(source._customSource._options.read(0, size)).rejects.toThrow(
			`Unexpected end of file at byte ${shrunkSize}`,
		);

		source._dispose();
	} finally {
		await rm(filePath);
	}
});
