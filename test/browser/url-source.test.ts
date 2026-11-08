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

test('UrlSource gives up on blob: URLs that fail instead of retrying forever', async () => {
	// Reading a blob doesn't touch the network, and the Fetch standard reports a range at or past its end, or a revoked
	// blob URL, as a network error, so retrying can't help
	const outcome = (promise: Promise<unknown>) => Promise.race([
		promise.then(() => 'resolved', (error: unknown) => `rejected: ${String(error)}`),
		new Promise<string>(resolve => setTimeout(() => resolve('pending after 4 s'), 4000)),
	]);

	// An empty blob, like a failed recording
	const emptyUrl = URL.createObjectURL(new Blob([]));
	using input = new Input({ source: new UrlSource(emptyUrl), formats: ALL_FORMATS });
	expect(await outcome(input.getFormat())).toMatch(/^rejected: TypeError/);
	URL.revokeObjectURL(emptyUrl);

	// A blob URL revoked after the first read
	const revokedUrl = URL.createObjectURL(new Blob([new Uint8Array(3 * 2 ** 20)]));
	const reader = new Reader(new UrlSource(revokedUrl));
	expect(await reader.requestSlice(0, 1000)).not.toBeNull();
	URL.revokeObjectURL(revokedUrl);
	expect(await outcome(Promise.resolve(reader.requestSlice(2 * 2 ** 20, 1000)))).toMatch(/^rejected: TypeError/);

	// A requested range past the end of a blob
	const smallUrl = URL.createObjectURL(new Blob([new Uint8Array(500)]));
	const rangedSource = new UrlSource(smallUrl, { requestInit: { headers: { Range: 'bytes=1000-' } } });
	const rangedRead = Promise.resolve(new Reader(rangedSource).requestSlice(0, 10));
	expect(await outcome(rangedRead)).toMatch(/^rejected: TypeError/);
	URL.revokeObjectURL(smallUrl);
}, 20_000);
