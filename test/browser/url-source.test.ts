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
	// resuming. Here, the first response dies after 100 kB.
	const data = new Uint8Array(1_000_000).map((_, i) => i % 251);

	const makeFetchFn = (honorsRanges: boolean, requestedRanges: string[]) => {
		return async (url: string | URL | Request, init?: RequestInit) => {
			const range = new Headers(init?.headers).get('Range') ?? 'bytes=0-';
			requestedRanges.push(range);
			const start = honorsRanges ? Number(/^bytes=(\d+)-$/.exec(range)![1]) : 0;
			const body = data.subarray(start);
			const failAfter = requestedRanges.length === 1 ? 100_000 : Infinity;

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
			expect(requestedRanges).toEqual(['bytes=0-', 'bytes=100000-']);
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
