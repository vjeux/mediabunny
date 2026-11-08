import { expect, test } from 'vitest';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Reader, readBytes } from '../../src/reader.js';
import { Logging, LogLevel } from '../../src/logging.js';

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

test('UrlSource resumes a cross-origin response body that fails with WebKit\'s "Load failed"', async () => {
	// WebKit (Safari, iOS) reports any failure of a response body as `TypeError: Load failed`, the text it also uses
	// for CORS failures. For a URL on another origin, the default retry policy took it for one and gave up instead of
	// resuming. Here, the response for bytes=0- dies after 100 kB.
	const data = new Uint8Array(1_000_000).map((_, i) => i % 251);
	// Firefox may ask for bytes=0- twice, refetching past its HTTP cache, so a repeated first request is left out
	const withoutRefetch = (ranges: string[]) => (ranges[1] === 'bytes=0-' ? ranges.slice(1) : ranges);

	const makeFetchFn = (honorsRanges: boolean, requestedRanges: string[]) => {
		return async (url: string | URL | Request, init?: RequestInit) => {
			const range = new Headers(init?.headers).get('Range') ?? 'bytes=0-';
			requestedRanges.push(range);
			const start = honorsRanges ? Number(/^bytes=(\d+)-$/.exec(range)![1]) : 0;
			const body = data.subarray(start);
			const failAfter = range === 'bytes=0-' ? 100_000 : Infinity;

			let sent = 0;
			const stream = new ReadableStream<Uint8Array>({
				pull: (controller) => {
					if (sent >= failAfter) {
						controller.error(new TypeError('Load failed'));
					} else if (sent >= body.length) {
						controller.close();
					} else {
						const chunk = body.subarray(sent, sent + 50_000);
						controller.enqueue(chunk.slice());
						sent += chunk.length;
					}
				},
			});

			return honorsRanges
				? new Response(stream, {
					status: 206,
					headers: { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` },
				})
				: new Response(stream, { status: 200, headers: { 'Content-Length': String(data.length) } });
		};
	};

	const previousLevel = Logging.level;
	Logging.level = LogLevel.Silent;

	try {
		// With a server that honors range requests, and with one that doesn't (sequential mode)
		for (const honorsRanges of [true, false]) {
			const requestedRanges: string[] = [];
			const fetchFn = makeFetchFn(honorsRanges, requestedRanges);
			using ref = new UrlSource('https://cdn.example.com/video.mp4', { fetchFn }).ref();
			const slice = await new Reader(ref.source).requestSlice(0, 400_000);

			expect(slice).not.toBeNull();
			expect(readBytes(slice!, 400_000)).toEqual(data.subarray(0, 400_000));
			expect(withoutRefetch(requestedRanges)).toEqual(['bytes=0-', 'bytes=100000-']);
		}

		// A blob: URL is read without touching the network, so retrying its failed body can't help: give up instead
		const requestedRanges: string[] = [];
		const blobUrl = 'blob:https://example.com/00000000-0000-0000-0000-000000000000';
		using ref = new UrlSource(blobUrl, { fetchFn: makeFetchFn(true, requestedRanges) }).ref();
		await expect(Promise.resolve(new Reader(ref.source).requestSlice(0, 400_000))).rejects.toThrow('Load failed');
		expect(requestedRanges).toEqual(['bytes=0-']);
	} finally {
		Logging.level = previousLevel;
	}
});

test('UrlSource retries a failed fetch() once the URL got through CORS, but not before', async () => {
	// A CDN on another origin. `failingRequests` lists which requests (1-based) fail before any response, the way
	// Chrome reports a reset connection or a network change: fetch() rejects with "TypeError: Failed to fetch"
	const data = new Uint8Array(4_000_000).map((_, i) => i % 251);
	const makeCdnFetch = (failingRequests: number[]) => {
		let requestCount = 0;
		return async (url: string | URL | Request, init?: RequestInit) => {
			requestCount++;
			if (failingRequests.includes(requestCount)) {
				throw new TypeError('Failed to fetch');
			}

			const start = Number(/^bytes=(\d+)-$/.exec(new Headers(init?.headers).get('Range')!)![1]);
			let position = start;
			const body = new ReadableStream<Uint8Array>({
				pull: (controller) => {
					if (position >= data.length) {
						controller.close();
					} else {
						controller.enqueue(data.slice(position, position + 65536));
						position += 65536;
					}
				},
			});

			return new Response(body, {
				status: 206,
				headers: { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` },
			});
		};
	};

	const previousLevel = Logging.level;
	Logging.level = LogLevel.Silent;

	try {
		// Request 1 works, request 2 (for data far away, past the 1 MiB cache) hits a transient network failure
		using ref = new UrlSource('https://cdn.example.com/video.mp4', {
			fetchFn: makeCdnFetch([2]),
			maxCacheSize: 2 ** 20,
		}).ref();
		const reader = new Reader(ref.source);

		expect(await reader.requestSlice(0, 1000)).not.toBeNull();
		// On main, this rejects with "TypeError: Failed to fetch" after warning that a CORS error is suspected,
		// although this URL's responses already got through CORS
		const slice = await reader.requestSlice(3_000_000, 1000);
		expect(slice && readBytes(slice, 1000)).toEqual(data.subarray(3_000_000, 3_001_000));

		// The same in sequential mode: a server without range support, whose body for bytes=0- dies after 100 kB
		// (Chrome: "network error"), and whose first request to resume then fails before any response. So does a
		// second request for bytes=0-, which Firefox makes to refetch past its HTTP cache: it comes after a response
		// that got through CORS, so it's retried too.
		const sequentialRanges: string[] = [];
		const sequentialFetch = async (url: string | URL | Request, init?: RequestInit) => {
			const range = new Headers(init?.headers).get('Range') ?? '';
			sequentialRanges.push(range);
			const count = sequentialRanges.filter(x => x === range).length;
			if ((range === 'bytes=100000-' && count === 1) || (range === 'bytes=0-' && count === 2)) {
				throw new TypeError('Failed to fetch');
			}

			let sent = 0;
			const failAfter = range === 'bytes=0-' ? 100_000 : Infinity;
			const body = new ReadableStream<Uint8Array>({
				pull: (controller) => {
					if (sent >= failAfter) {
						controller.error(new TypeError('network error'));
					} else if (sent >= data.length) {
						controller.close();
					} else {
						controller.enqueue(data.slice(sent, sent + 50_000));
						sent += 50_000;
					}
				},
			});

			return new Response(body, { status: 200, headers: { 'Content-Length': String(data.length) } });
		};
		using sequentialRef = new UrlSource('https://cdn.example.com/video.mp4', { fetchFn: sequentialFetch }).ref();
		const sequentialSlice = await new Reader(sequentialRef.source).requestSlice(0, 400_000);
		expect(sequentialSlice && readBytes(sequentialSlice, 400_000)).toEqual(data.subarray(0, 400_000));
		// Firefox's refetches of bytes=0- are left out
		const firstResume = sequentialRanges.findIndex(x => x !== 'bytes=0-');
		expect([sequentialRanges[0], ...sequentialRanges.slice(firstResume)])
			.toEqual(['bytes=0-', 'bytes=100000-', 'bytes=100000-']);

		// Control: when the very first request fails, CORS stays the suspect and nothing is retried
		using firstFailsRef = new UrlSource('https://cdn.example.com/video.mp4', {
			fetchFn: makeCdnFetch([1]),
		}).ref();
		await expect(Promise.resolve(new Reader(firstFailsRef.source).requestSlice(0, 1000)))
			.rejects.toThrow('Failed to fetch');
	} finally {
		Logging.level = previousLevel;
	}
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

	// A blob URL revoked after the first read. Chrome and Firefox fail the next request, while WebKit keeps serving
	// the blob, so all that matters is that the read settles
	const revokedUrl = URL.createObjectURL(new Blob([new Uint8Array(3 * 2 ** 20)]));
	const reader = new Reader(new UrlSource(revokedUrl));
	expect(await reader.requestSlice(0, 1000)).not.toBeNull();
	URL.revokeObjectURL(revokedUrl);
	expect(await outcome(Promise.resolve(reader.requestSlice(2 * 2 ** 20, 1000)))).not.toBe('pending after 4 s');

	// A requested range past the end of a blob
	const smallUrl = URL.createObjectURL(new Blob([new Uint8Array(500)]));
	const rangedSource = new UrlSource(smallUrl, { requestInit: { headers: { Range: 'bytes=1000-' } } });
	const rangedRead = Promise.resolve(new Reader(rangedSource).requestSlice(0, 10));
	expect(await outcome(rangedRead)).toMatch(/^rejected: TypeError/);
	URL.revokeObjectURL(smallUrl);
}, 20_000);
