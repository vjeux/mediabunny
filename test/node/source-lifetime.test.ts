import { expect, test, vi } from 'vitest';
import { CustomSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input, InputDisposedError } from '../../src/input.js';
import { ALL_FORMATS, MP4 } from '../../src/input-format.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';
import { AudioSampleSink } from '../../src/media-sink.js';
import { AudioSample } from '../../src/sample.js';
import { CustomAudioDecoder, registerDecoder } from '../../src/custom-coder.js';
import { AudioCodec } from '../../src/codec.js';
import { EncodedPacket } from '../../src/packet.js';
import { readFile } from 'node:fs/promises';
import { setImmediate, setTimeout } from 'node:timers/promises';

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

// A stand-in AAC decoder, active only while a test enables it, that keeps track of what it emits and whether it's
// closed
let countingDecoderActive = false;
const countingDecoderSamples: AudioSample[] = [];
let countingDecoderCloseCount = 0;

class CountingAacDecoder extends CustomAudioDecoder {
	static override supports(codec: AudioCodec) {
		return codec === 'aac' && countingDecoderActive;
	}

	init() {}

	decode(packet: EncodedPacket) {
		const sample = new AudioSample({
			data: new Float32Array(1024),
			format: 'f32',
			numberOfChannels: 1,
			sampleRate: 48000,
			timestamp: packet.timestamp,
		});
		countingDecoderSamples.push(sample);
		this.onSample(sample);
	}

	flush() {}

	close() {
		countingDecoderCloseCount++;
	}
}
registerDecoder(CountingAacDecoder);

test.each([
	['samples()', (sink: AudioSampleSink) => sink.samples()],
	['samplesAtTimestamps()', (sink: AudioSampleSink) => sink.samplesAtTimestamps([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4])],
] as const)('Disposing the input closes the decoder and samples of an open %s iterator', async (_, iterate) => {
	countingDecoderActive = true;
	countingDecoderSamples.length = 0;
	countingDecoderCloseCount = 0;

	try {
		const input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const iterator = iterate(new AudioSampleSink(track));
		const first = await iterator.next();
		first.value?.close();

		// The sink decodes ahead until its queue is full, then waits for the consumer, which stops here and just
		// disposes the input (a player being torn down, for example), found by lane L57
		await setTimeout(50);
		expect(countingDecoderSamples.length).toBeGreaterThan(1);
		input.dispose();
		await setTimeout(50);

		expect(countingDecoderCloseCount).toBe(1);
		expect(countingDecoderSamples.filter(sample => !sample._closed)).toHaveLength(0);
		await expect(iterator.next()).rejects.toThrow(InputDisposedError);
	} finally {
		countingDecoderActive = false;
	}
});
