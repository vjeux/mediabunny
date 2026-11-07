import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { EncodedAudioPacketSource, EncodedPacket, WavOutputFormat } from '../../src/index.js';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import {
	AppendOnlyStreamTarget,
	BufferTarget,
	StreamTarget,
	FilePathTarget,
	StreamTargetChunk,
	Target,
} from '../../src/target.js';
import type { FileHandle } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const samplePath = path.join(__dirname, '../public/video.mp4');

const startPcmOutput = async (target: Target) => {
	const output = new Output({ format: new WavOutputFormat(), target });
	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(960).fill(7), 'key', 0, 0.01), {
		decoderConfig: { codec: 'pcm-s16', sampleRate: 48000, numberOfChannels: 1 },
	});
	return output;
};

const writePcmFile = async (target: Target) => {
	const output = await startPcmOutput(target);
	await output.finalize();
};

test('A slice of a target writes a file into a section of it', async () => {
	const reference = new BufferTarget();
	await writePcmFile(reference);
	const file = new Uint8Array(reference.buffer!);

	const bufferTarget = new BufferTarget();
	await writePcmFile(bufferTarget.slice(100));
	expect(bufferTarget.buffer).not.toBeNull();
	expect(new Uint8Array(bufferTarget.buffer!)).toEqual(new Uint8Array([...new Uint8Array(100), ...file]));

	// The stream receives the file at the offset (StreamTarget fills the gap before it) and gets closed in the end
	const chunks: StreamTargetChunk[] = [];
	let closed = false;
	const streamTarget = new StreamTarget(new WritableStream<StreamTargetChunk>({
		write: (chunk) => {
			chunks.push(chunk);
		},
		close: () => {
			closed = true;
		},
	}));
	await writePcmFile(streamTarget.slice(100));
	expect(closed).toBe(true);
	const streamed = new Uint8Array(100 + file.length);
	for (const chunk of chunks) {
		streamed.set(chunk.data, chunk.position);
	}
	expect(streamed).toEqual(new Uint8Array([...new Uint8Array(100), ...file]));
});

test('Slices of a target used at the same time finalize it once the last one is done', async () => {
	const reference = new BufferTarget();
	await writePcmFile(reference);
	const file = new Uint8Array(reference.buffer!);

	const target = new BufferTarget();
	const first = await startPcmOutput(target.slice(0));
	const second = await startPcmOutput(target.slice(file.length));
	await first.finalize();
	expect(target.buffer).toBeNull();
	await second.finalize();
	expect(new Uint8Array(target.buffer!)).toEqual(new Uint8Array([...file, ...file]));

	// Once finalized, the target takes no further slices
	await expect(writePcmFile(target.slice(0))).rejects.toThrow(
		'Cannot use a slice of a target that has already been finalized or closed.',
	);
});

test('Canceling the output of a slice closes the sliced target', async () => {
	let closed = false;
	const streamTarget = new StreamTarget(new WritableStream<StreamTargetChunk>({
		close: () => {
			closed = true;
		},
	}));
	const output = await startPcmOutput(streamTarget.slice(0));
	await output.cancel();
	expect(closed).toBe(true);
});

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
