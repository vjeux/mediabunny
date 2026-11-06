import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget, StreamTarget, StreamTargetChunk } from '../../src/target.js';
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

test('StreamTarget in chunked mode handles a write spanning many chunks', async () => {
	const writes: StreamTargetChunk[] = [];
	const target = new StreamTarget(new WritableStream<StreamTargetChunk>({
		write: (chunk) => {
			writes.push({ ...chunk, data: chunk.data.slice() });
		},
	}), { chunked: true, chunkSize: 1024 });

	// Like the media data of an in-memory fast start MP4, written in one go: 32 MiB, so 32768 chunks
	const data = new Uint8Array(2 ** 25);
	for (let i = 0; i < data.length; i += 4096) {
		data[i] = (i / 4096) & 0xff;
	}

	target._start();
	target._write(data, 0);
	await target._flush();
	await target._finalize();

	const result = new Uint8Array(data.length);
	for (const write of writes) {
		expect(write.data.byteLength).toBeLessThanOrEqual(1024);
		result.set(write.data, write.position);
	}
	expect(result.every((byte, i) => byte === data[i])).toBe(true);
});
