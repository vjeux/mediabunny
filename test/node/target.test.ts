import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { AppendOnlyStreamTarget, BufferTarget, StreamTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { FilePathTarget } from '../../src/target.js';

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

test('FilePathTarget leaves the file alone until there is something to write', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mediabunny-'));
	const filePath = path.join(directory, 'existing.mp4');
	await fs.writeFile(filePath, new Uint8Array(100));

	// Rejected options, then a target that's never used
	expect(() => new FilePathTarget(filePath, { chunkSize: 100 })).toThrow(TypeError);
	new FilePathTarget(filePath);
	await new Promise(resolve => setTimeout(resolve, 50));
	expect((await fs.stat(filePath)).size).toBe(100);

	// Writing still replaces the file
	using input = new Input({ source: new FilePathSource(samplePath), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat(), target: new FilePathTarget(filePath) });
	const conversion = await Conversion.init({ input, output });
	await conversion.execute();

	using written = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
	expect(await written.computeDuration()).toBeCloseTo(await input.computeDuration(), 1);

	await fs.rm(directory, { recursive: true });
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

test('Stream targets validate their constructor arguments', () => {
	expect(() => new StreamTarget(new WritableStream(), null as never)).toThrow(
		new TypeError('StreamTarget options, when provided, must be an object.'),
	);

	for (const writable of [undefined, null, {}, new ReadableStream()]) {
		expect(() => new AppendOnlyStreamTarget(writable as never)).toThrow(
			new TypeError('AppendOnlyStreamTarget requires a WritableStream.'),
		);
	}
});
