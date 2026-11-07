import { expect, test } from 'vitest';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Reader, readBytes } from '../../src/reader.js';

test('Should be able to load a very small video file via URL (<512 kB)', async () => {
	const source = new UrlSource('/frames.webm');
	using input = new Input({
		source,
		formats: ALL_FORMATS,
	});
	const primaryVideoTrack = await input.getPrimaryVideoTrack();
	if (!primaryVideoTrack) {
		throw new Error('No video track found');
	};

	const duration = await primaryVideoTrack.computeDuration();
	expect(duration).toBeCloseTo(3.33333);
});

test('UrlSource does not retry a suspected CORS failure, in a window or in a worker', async () => {
	// Nothing listens on port 9 (discard) of another origin, which Chrome reports as "Failed to fetch", like a CORS
	// failure. Retrying couldn't help, so the read should fail instead of retrying forever.
	const crossOriginUrl = 'http://127.0.0.1:9/video.mp4';
	const settle = (promise: Promise<string>) => Promise.race([
		promise,
		new Promise<string>(resolve => setTimeout(() => resolve('still pending'), 3000)),
	]);

	const reader = new Reader(new UrlSource(crossOriginUrl));
	const inWindow = await settle((async () => {
		try {
			await reader.requestSlice(0, 1);
			return 'resolved';
		} catch (error) {
			return `rejected: ${String(error)}`;
		}
	})());
	expect(inWindow, 'window').toMatch(/^rejected/);

	const worker = new Worker(new URL('./helpers/io-url-source-worker.ts', import.meta.url), { type: 'module' });
	try {
		const inWorker = await settle(new Promise<string>((resolve) => {
			worker.onmessage = (event: MessageEvent<string>) => resolve(event.data);
			worker.postMessage(crossOriginUrl);
		}));
		expect(inWorker, 'worker').toMatch(/^rejected/);
	} finally {
		worker.terminate();
	}
});

test('requestInit with Range', async () => {
	const url = makeRampedUrl();

	const source = new UrlSource(url, {
		requestInit: {
			headers: { Range: 'bytes=10-' },
		},
	});
	const reader = new Reader(source);

	const slice = await reader.requestSlice(0, 5);
	expect(slice).not.toBeNull();

	expect([...readBytes(slice!, 5)]).toEqual([10, 11, 12, 13, 14]);

	expect(reader.fileSize).toBe(256 - 10);

	URL.revokeObjectURL(url);
});

test('Request with Range', async () => {
	const url = makeRampedUrl();

	const request = new Request(url, {
		headers: { Range: 'bytes=20-29' },
	});

	const source = new UrlSource(request);
	const reader = new Reader(source);

	const slice = await reader.requestSlice(2, 4);
	expect(slice).not.toBeNull();

	expect([...readBytes(slice!, 4)]).toEqual([22, 23, 24, 25]);

	expect(reader.fileSize).toBe(10);

	expect(await reader.requestSlice(8, 4)).toBeNull();

	URL.revokeObjectURL(url);
});

const makeRampedUrl = () => {
	const data = new Uint8Array(256);
	for (let i = 0; i < data.length; i++) {
		data[i] = i;
	}

	const blob = new Blob([data.buffer]);
	return URL.createObjectURL(blob);
};
