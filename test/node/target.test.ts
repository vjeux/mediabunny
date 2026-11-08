import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
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

test.each(['copy', 'transcode'] as const)(
	'A Conversion whose StreamTarget fails to write rejects without unhandled rejections (%s)',
	async (kind) => {
		// Like streaming the output to an HTTP response whose client disconnects. The conversion then cancels its
		// output, whose closing of the errored stream used to reject unhandled, which kills a Node process
		const { StreamTarget } = await import('../../src/target.js');
		const { WavOutputFormat } = await import('../../src/output-format.js');
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => void unhandledRejections.push(reason);
		process.on('unhandledRejection', onUnhandledRejection);

		try {
			using input = new Input({
				source: new FilePathSource(kind === 'copy'
					? samplePath
					: path.join(__dirname, '../public/glitch-hop-is-dead.wav')),
				formats: ALL_FORMATS,
			});
			let bytesWritten = 0;
			const output = new Output({
				format: kind === 'copy' ? new Mp4OutputFormat() : new WavOutputFormat(),
				target: new StreamTarget(new WritableStream({
					write: (chunk: { data: Uint8Array }) => {
						bytesWritten += chunk.data.byteLength;
						if (bytesWritten > 2 ** 16) {
							throw new Error('Client disconnected');
						}
					},
				}), { chunked: true, chunkSize: 2 ** 14 }),
			});
			const conversion = await Conversion.init({
				input,
				output,
				audio: kind === 'transcode' ? { sampleRate: 16000 } : undefined, // Resampling, so a PCM transcode
				showWarnings: false,
			});

			await expect(conversion.execute()).rejects.toThrow('Client disconnected');
			await new Promise(resolve => setTimeout(resolve, 100)); // Lets the cancel finish
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandledRejection);
		}
	},
);

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
