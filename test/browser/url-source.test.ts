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

test('A 200 for a range request after 206s is asked for again past the HTTP cache', async () => {
	// When Chrome completes a range request from its HTTP cache with If-Range and the server's ETag differs from the
	// cached one (as with ETags that differ per backend), the server rightly answers with a 200 and the whole resource.
	// Here, every range request past the start that may use the cache gets such a 200.
	const data = new Uint8Array(4_000_000).map((_, i) => i % 251);
	const requests: string[] = [];
	const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
		const start = Number(/^bytes=(\d+)-$/.exec(new Headers(init?.headers).get('Range')!)![1]);
		const revalidated = start > 0 && init?.cache !== 'no-store';
		requests.push(`${start} ${revalidated ? 200 : 206}`);
		const body = revalidated ? data : data.subarray(start);
		let position = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull: (controller) => {
				if (position >= body.length) {
					controller.close();
				} else {
					controller.enqueue(body.slice(position, position + 65536));
					position += 65536;
				}
			},
		});

		return revalidated
			? new Response(stream, { status: 200, headers: { 'Content-Length': String(data.length) } })
			: new Response(stream, {
				status: 206,
				headers: { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` },
			});
	};

	using ref = new UrlSource('https://cdn.example.com/video.mp4', { fetchFn, maxCacheSize: 2 ** 20 }).ref();
	const reader = new Reader(ref.source);

	// The start of the file must still be readable after reading far into it. On main, the 200 made UrlSource read the
	// file sequentially from then on, so the start had been evicted from its cache.
	for (const start of [0, 3_000_000, 0]) {
		const slice = await reader.requestSlice(start, 1000);
		expect(slice).not.toBeNull();
		expect(readBytes(slice!, 1000)).toEqual(data.subarray(start, start + 1000));
	}
	// The 200 was asked for again past the cache, at the same position, which got a 206
	const firstRevalidated = requests.findIndex(request => request.endsWith(' 200'));
	expect(firstRevalidated).toBeGreaterThan(0);
	expect(requests[firstRevalidated + 1]).toBe(requests[firstRevalidated]!.replace(' 200', ' 206'));
});

const makeRampedUrl = () => {
	const data = new Uint8Array(256);
	for (let i = 0; i < data.length; i++) {
		data[i] = i;
	}

	const blob = new Blob([data.buffer]);
	return URL.createObjectURL(blob);
};
