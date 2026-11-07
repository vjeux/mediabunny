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

test('Random access keeps working when the browser has the resource cached', async () => {
	// A plain fetch puts the whole file into the HTTP cache, from which Firefox answers bytes=0- with a 200
	const expected = new Uint8Array(await (await fetch('/video.mp4')).arrayBuffer());

	const source = new UrlSource('/video.mp4', { maxCacheSize: 2 ** 16 });
	const reader = new Reader(source);

	// The start of the file must still be readable after reading its end
	for (const start of [0, expected.length - 1000, 0]) {
		const slice = await reader.requestSlice(start, 1000);
		expect(slice).not.toBeNull();
		expect(readBytes(slice!, 1000)).toEqual(expected.subarray(start, start + 1000));
	}
});

const makeRampedUrl = () => {
	const data = new Uint8Array(256);
	for (let i = 0; i < data.length; i++) {
		data[i] = i;
	}

	const blob = new Blob([data.buffer]);
	return URL.createObjectURL(blob);
};
