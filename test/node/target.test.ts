import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { EncodedAudioPacketSource, EncodedPacket, WavOutputFormat } from '../../src/index.js';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget, StreamTarget, StreamTargetChunk, Target } from '../../src/target.js';
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
