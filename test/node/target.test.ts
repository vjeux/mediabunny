import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget, FilePathTarget } from '../../src/target.js';
import type { FileHandle } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const samplePath = path.join(__dirname, '../public/video.mp4');

test('BufferTarget onFinalize callback', async () => {
	let received: ArrayBuffer | null = null;
	let asyncCallbackDone = false;

	using input = new Input({
		source: new FilePathSource(samplePath),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget({
			onFinalize: async (buffer) => {
				received = buffer;
				await new Promise(resolve => setTimeout(resolve, 20));
				asyncCallbackDone = true;
			},
		}),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	expect(received).not.toBeNull();
	expect(received).toBe(output.target.buffer);
	expect(asyncCallbackDone).toBe(true);
	expect(output.target.buffer!.byteLength).toBeGreaterThan(0);
});

test('BufferTarget internal buffer transfer on finalize', async () => {
	const target = new BufferTarget();
	target._write(new Uint8Array([1, 2, 3, 4, 5]), 0);
	target._write(new Uint8Array([6, 7]), 3);

	const internalBuffer = target._buffer!;
	await target._finalize();

	expect(internalBuffer).toHaveProperty('detached', true);
	expect(target._buffer).toBeNull();
	expect(target._bytes).toBeNull();

	expect(target.buffer).toHaveProperty('resizable', false);
	expect([...new Uint8Array(target.buffer!)]).toEqual([1, 2, 3, 6, 7]);
});

test('FilePathTarget writes of 2 GiB or more are split into writes Node accepts', async () => {
	// Node rejects file writes of 2 GiB or more, and Linux transfers at most 0x7ffff000 bytes per call. Written
	// through a stand-in file handle that behaves like that without touching the data.
	const filePath = path.join(os.tmpdir(), `mediabunny-large-write-${process.pid}.bin`);
	const target = new FilePathTarget(filePath, { chunked: false });
	const writer = target._streamTarget._writable.getWriter();
	// Once this first write is done, the file is open
	await writer.write({ type: 'write', data: new Uint8Array(1000), position: 0 });

	try {
		const realHandle = target._fileHandle!;
		const calls: { offset: number; length: number; position: number }[] = [];
		target._fileHandle = {
			write: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
				if (length > 2 ** 31 - 1) {
					throw new RangeError(`The value of "length" is out of range. Received ${length}`);
				}
				calls.push({ offset, length, position });
				return { bytesWritten: Math.min(length, 0x7ffff000), buffer };
			},
			close: () => realHandle.close(),
		} as unknown as FileHandle;

		const size = 2 ** 31 + 2 ** 20;
		await writer.write({ type: 'write', data: new Uint8Array(size), position: 1000 });

		// The writes cover the whole chunk, each one picking up where the previous one stopped
		let pos = 0;
		for (const call of calls) {
			expect(call.offset).toBe(pos);
			expect(call.position).toBe(1000 + pos);
			pos += Math.min(call.length, 0x7ffff000);
		}
		expect(pos).toBe(size);

		await writer.close();
	} finally {
		await rm(filePath);
	}
});
