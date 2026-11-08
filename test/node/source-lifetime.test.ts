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

test('Disposing an input rejects reads waiting on a user callback that never settles', async () => {
	const { BufferSource, CustomPathedSource } = await import('../../src/source.js');
	const outcome = (promise: Promise<unknown>) => Promise.race([
		promise.then(
			() => 'resolved',
			(error: unknown) => error instanceof InputDisposedError ? 'InputDisposedError' : String(error),
		),
		new Promise<string>(resolve => setTimeout(() => resolve('pending after 2 s'), 2000)),
	]);

	// A getSize that never settles, like a HEAD request without a timeout
	const customInput = new Input({
		source: new CustomSource({ getSize: () => new Promise<number>(() => {}), read: () => new Uint8Array(0) }),
		formats: ALL_FORMATS,
	});
	const format = customInput.getFormat();
	await setImmediate();
	customInput.dispose();
	// On main, this stayed pending forever
	expect(await outcome(format)).toBe('InputDisposedError');

	// A request handler that never settles for a segment, like a resolver fetching a signed URL
	const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:40\n#EXTINF:38.5,\nsegment.mp3\n#EXT-X-ENDLIST\n';
	const requestedPaths: string[] = [];
	const hlsInput = new Input({
		source: new CustomPathedSource('https://example.com/media.m3u8', ({ path }) => {
			requestedPaths.push(path);
			return path.endsWith('.m3u8')
				? new BufferSource(new TextEncoder().encode(playlist))
				: new Promise<InstanceType<typeof BufferSource>>(() => {});
		}),
		formats: ALL_FORMATS,
	});
	const tracks = hlsInput.getTracks();
	while (!requestedPaths.some(x => x.endsWith('.mp3'))) {
		await setImmediate();
	}
	hlsInput.dispose();
	// On main, this stayed pending forever
	expect(await outcome(tracks)).toBe('InputDisposedError');

	// The same for the root file, which a CustomPathedSource requests itself (L46)
	const rootInput = new Input({
		source: new CustomPathedSource(
			'https://example.com/media.m3u8',
			() => new Promise<InstanceType<typeof BufferSource>>(() => {}),
		),
		formats: ALL_FORMATS,
	});
	const rootFormat = rootInput.getFormat();
	await setImmediate();
	rootInput.dispose();
	// On main, this stayed pending forever
	expect(await outcome(rootFormat)).toBe('InputDisposedError');
});

test('Waiting on user callbacks that settle holds on to nothing until disposal', async () => {
	const { BufferSource, CustomPathedSource } = await import('../../src/source.js');
	const { EncodedPacketSink } = await import('../../src/media-sink.js');

	// An HLS playlist of 3 segments in memory, read whole. Each request for a segment is waited on until disposal,
	// which must not keep hold of it once settled, or a long live stream would keep every segment until disposal.
	const mp3 = await readFile(path.join(__dirname, '../public/Toothsome-Meme.VBRv2.mp3'));
	const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:40\n'
		+ [0, 1, 2].map(i => `#EXTINF:38.5,\nsegment${i}.mp3\n`).join('')
		+ '#EXT-X-ENDLIST\n';
	const source = new CustomPathedSource('https://example.com/media.m3u8', async ({ path }) => {
		return new BufferSource(path.endsWith('.m3u8') ? new TextEncoder().encode(playlist) : mp3);
	});
	using input = new Input({ source, formats: ALL_FORMATS });
	let packetCount = 0;
	for await (const packet of new EncodedPacketSink((await input.getPrimaryAudioTrack())!).packets()) {
		void packet;
		packetCount++;
	}
	expect(packetCount).toBeGreaterThan(3 * 1000);
	expect(input._disposalSignal.pendingRejecters.size).toBe(0);
	expect(source._disposalSignal.pendingRejecters.size).toBe(0);

	// The same for a CustomSource's getSize
	const customSource = new CustomSource({
		getSize: async () => mp3.length,
		read: (start, end) => mp3.subarray(start, end),
	});
	using customInput = new Input({ source: customSource, formats: ALL_FORMATS });
	expect(await customInput.getTracks()).toHaveLength(1);
	expect(customSource._disposalSignal.pendingRejecters.size).toBe(0);
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
