import { expect, test, vi } from 'vitest';
import { CustomSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input, InputDisposedError } from '../../src/input.js';
import { ALL_FORMATS, MP4 } from '../../src/input-format.js';
import { promiseWithResolvers } from '../../src/misc.js';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';

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

// Named pipes don't live in the file system on Windows
test.skipIf(process.platform === 'win32')('FilePathSource refuses a named pipe instead of hanging', async () => {
	const { execFileSync } = await import('node:child_process');
	const fs = await import('node:fs');
	const os = await import('node:os');
	const fifoPath = path.join(os.tmpdir(), `mediabunny-fifo-${process.pid}-${Date.now()}`);
	execFileSync('mkfifo', [fifoPath]);

	const getFormatOutcome = async () => {
		using input = new Input({ source: new FilePathSource(fifoPath), formats: ALL_FORMATS });
		return await Promise.race([
			input.getFormat().then(format => format.name, (error: unknown) => String(error)),
			new Promise<string>(resolve => setTimeout(() => resolve('pending after 2 s'), 2000)),
		]);
	};
	const error = /^TypeError: FilePathSource needs a regular file/;

	try {
		// Nothing writes to the pipe yet. On main, opening it waited for a writer, so this never settled.
		expect(await getFormatOutcome()).toMatch(error);

		// A valid MP3 written into the pipe. On main, the pipe stated a size of 0, so this was "unsupported format".
		const mp3 = await readFile(path.join(__dirname, '..', 'public', 'Toothsome-Meme.VBRv2.mp3'));
		const writer = fs.promises.open(fifoPath, 'w') // Opens once a reader does
			.then(async (handle) => {
				await handle.write(mp3.subarray(0, 32768)).catch(() => {});
				await handle.close();
			});
		expect(await getFormatOutcome()).toMatch(error);

		// Let the writer finish: open the reading end without waiting, then close it
		const readFd = fs.openSync(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		await writer;
		fs.closeSync(readFd);
	} finally {
		fs.unlinkSync(fifoPath);
	}
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
