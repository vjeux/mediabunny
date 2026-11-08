import { expect, test } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
import { assert } from '../../src/misc.js';
import { Reader, readBytes } from '../../src/reader.js';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	Logging,
	LogLevel,
	MkvOutputFormat,
	Mp4OutputFormat,
	Output,
	UrlSource,
} from '../../src/index.js';

test('UrlSource rejects a retry delay that isn\'t a non-negative finite number', async () => {
	const waitFor = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
	// Responses whose body breaks off at once (with and without range support), or ends without any data
	const read = async (retryDelay: unknown, status: 200 | 206, body: 'error' | 'empty') => {
		let fetches = 0;
		const fetchFn = (async () => {
			fetches++;
			const stream = new ReadableStream<Uint8Array>({
				pull: (controller) => {
					if (body === 'error') {
						controller.error(new Error('Connection reset'));
					} else {
						controller.close();
					}
				},
			});
			return new Response(stream, {
				status,
				headers: { 'Content-Length': '1000', ...(status === 206 && { 'Content-Range': 'bytes 0-999/1000' }) },
			});
		}) as typeof fetch;

		const input = new Input({
			source: new UrlSource('https://example.com/video.mp4', {
				fetchFn,
				getRetryDelay: () => retryDelay as number,
			}),
			formats: ALL_FORMATS,
		});
		const result = input.getFormat().then(() => 'resolved', (error: Error) => error.message);
		const settled = await Promise.race([result, waitFor(300).then(() => 'still pending')]);
		input.dispose();
		return { fetches, settled };
	};

	const logs = captureLogs();

	try {
		for (const [status, body] of [[206, 'error'], [206, 'empty'], [200, 'error']] as const) {
			for (const retryDelay of [-1, NaN, Infinity, undefined]) {
				// Such a delay used to make the retries come back to back, hundreds of requests per second
				expect(await read(retryDelay, status, body), `${retryDelay}, ${status}, ${body}`).toEqual({
					fetches: 1,
					settled: 'Retry delay must be a non-negative finite number.',
				});
			}
		}

		// A delay of a second is waited out
		expect(await read(1, 206, 'error')).toEqual({ fetches: 1, settled: 'still pending' });
	} finally {
		logs.stop();
	}
});

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const videoFilePath = path.join(__dirname, '..', 'public/video.mp4');

test('UrlSource sends every value of a header given more than once in a header list', async () => {
	let received: string | string[] | undefined;
	let receivedRange: string | undefined;
	const server = http.createServer((req, res) => {
		received = req.headers['x-tag'];
		receivedRange = req.headers.range;
		const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')?.[1] ?? 0);
		res.writeHead(206, { 'Content-Range': `bytes ${start}-199/200`, 'Content-Length': 200 - start });
		res.end(Buffer.alloc(200 - start));
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		const url = `http://localhost:${address.port}/data.bin`;

		const headerLists: [string, string][][] = [[['X-Tag', 'a'], ['X-Tag', 'b']], [['x-tag', 'a'], ['X-Tag', 'b']]];
		for (const headers of headerLists) {
			// What fetch() itself sends for this header list: both values
			await (await fetch(url, { headers })).arrayBuffer();
			const expected = received;
			expect(expected).toBe('a, b');

			using ref = new UrlSource(url, { requestInit: { headers } }).ref();
			await new Reader(ref.source).requestSlice(0, 4);
			expect(received).toBe(expected);
		}

		// Range is the exception: UrlSource maps it onto a byte offset, and the last one given is used
		const rangeHeaders: [string, string][] = [['Range', 'bytes=100-'], ['Range', 'bytes=7-']];
		using ref = new UrlSource(url, { requestInit: { headers: rangeHeaders } }).ref();
		await new Reader(ref.source).requestSlice(0, 4);
		expect(receivedRange).toBe('bytes=7-');
		expect(await ref.source.getSizeOrNull()).toBe(193);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('UrlSource works against a server without range request support', async () => {
	const server = await startRangelessServer();
	const logs = captureLogs();

	try {
		using input = new Input({
			source: new UrlSource(server.url),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		const sink = new EncodedPacketSink(track);

		const timestamps: number[] = [];
		for await (const packet of sink.packets()) {
			timestamps.push(packet.timestamp);
		}

		expect(timestamps).toHaveLength(125);

		// The default cache size exceeds the file size, so random access back to the start of the file still works
		const firstPacket = await sink.getFirstPacket();
		if (!firstPacket) throw new Error('No first packet found');

		expect(firstPacket.timestamp).toBe(0);
		expect(firstPacket.data.byteLength).toBeGreaterThan(0);

		expect(logs.warnings.filter(
			x => x.includes('did not respond to a range request with 206 Partial Content'),
		)).toHaveLength(1);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource fails at once on a request fetch() can\'t make', async () => {
	const getFormatError = async (makeSource: () => UrlSource) => {
		try {
			using input = new Input({ source: makeSource(), formats: ALL_FORMATS });
			return await Promise.race([
				input.getFormat().then(() => 'resolved', (error: unknown) => error),
				new Promise(resolve => setTimeout(() => resolve('still pending'), 3000)),
			]);
		} catch (error) {
			return error;
		}
	};

	// fetch() rejects these with the same TypeError every time, without sending anything: a relative URL has no base
	// URL outside of a browser, and header values must be ByteStrings
	expect(await getFormatError(() => new UrlSource('video.mp4'))).toBeInstanceOf(TypeError);
	expect(await getFormatError(() => new UrlSource('http://127.0.0.1:9/video.mp4', {
		requestInit: { headers: { Authorization: 'Bearer \u4e2d' } },
	}))).toBeInstanceOf(TypeError);
}, 15_000);

test('UrlSource throws when reading from an evicted region in sequential mode', async () => {
	const server = await startRangelessServer();
	const logs = captureLogs();

	try {
		using input = new Input({
			// Much smaller than the file, so the start of the file will get evicted during full iteration
			source: new UrlSource(server.url, { maxCacheSize: 2 ** 20 /* 1 MiB */ }),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		const sink = new EncodedPacketSink(track);

		const timestamps: number[] = [];
		for await (const packet of sink.packets()) {
			timestamps.push(packet.timestamp);
		}

		expect(timestamps).toHaveLength(125);

		await expect(sink.getFirstPacket()).rejects.toThrow(/already-evicted part of the cache/);

		expect(logs.warnings.filter(
			x => x.includes('did not respond to a range request with 206 Partial Content'),
		)).toHaveLength(1);
	} finally {
		logs.stop();
		server.close();
	}
});

test('Disposing an Input clears the pending UrlSource retry timer', async () => {
	const countTimers = () => process.getActiveResourcesInfo().filter(type => type === 'Timeout').length;
	const logs = captureLogs();

	try {
		// Nothing listens on port 9, so the default policy keeps retrying, waiting longer and longer
		const input = new Input({ source: new UrlSource('http://127.0.0.1:9/video.mp4'), formats: ALL_FORMATS });
		const result = input.getFormat().catch((error: unknown) => error);
		await new Promise(resolve => setTimeout(resolve, 1000)); // Now waiting before the third attempt
		const timersWhileWaiting = countTimers();

		input.dispose();
		await result;

		// A pending timer would keep Node from exiting, up to 16 seconds after disposal with the default policy
		expect(countTimers()).toBe(timersWhileWaiting - 1);
	} finally {
		logs.stop();
	}
});

test('UrlSource resumes with correct data when the connection dies in sequential mode', async () => {
	// The server kills the connection partway through the first two responses. Since it doesn't support range
	// requests, each resume response starts back at byte 0 and the already-delivered prefix must be skipped over
	// exactly; any off-by-one would corrupt the packet data.
	const server = await startRangelessServer({ responseByteLimits: [700_000, 1_500_000] });
	const logs = captureLogs();

	try {
		using referenceInput = new Input({
			source: new FilePathSource(videoFilePath),
			formats: ALL_FORMATS,
		});

		const referenceTrack = await referenceInput.getPrimaryVideoTrack();
		if (!referenceTrack) throw new Error('No video track found');

		const referencePackets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(referenceTrack).packets()) {
			referencePackets.push(packet);
		}

		using input = new Input({
			source: new UrlSource(server.url, { getRetryDelay: () => 0 }),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		let packetIndex = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			const referencePacket = referencePackets[packetIndex]!;

			expect(packet.timestamp).toBe(referencePacket.timestamp);
			expect(Buffer.from(packet.data).equals(Buffer.from(referencePacket.data))).toBe(true);

			packetIndex++;
		}

		expect(packetIndex).toBe(referencePackets.length);

		// Initial request plus one resume per killed response
		expect(server.requestCount()).toBe(3);
		expect(logs.errors.filter(x => x.includes('Attempting to resume'))).toHaveLength(2);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource passes a growing attempt count to getRetryDelay while responses keep dying', async () => {
	const data = new Uint8Array(2 ** 20).map((_, i) => i & 0xff);

	for (const honorRanges of [true, false]) {
		let requestCount = 0;
		const server = http.createServer((req, res) => {
			res.on('error', () => {});
			const start = honorRanges ? Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')?.[1] ?? 0) : 0;
			res.writeHead(honorRanges ? 206 : 200, {
				...(honorRanges && { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` }),
				'Content-Length': data.length - start,
			});

			// The first response delivers some data; every response dies after a moment. Without range support,
			// each response sends the same first bytes again, which are no new data.
			if (requestCount++ === 0 || !honorRanges) {
				res.write(data.subarray(start, start + 1000));
			}
			res.flushHeaders();
			setTimeout(() => res.destroy(), 10);
		});

		await new Promise<void>(resolve => server.listen(0, resolve));
		const logs = captureLogs();

		try {
			const address = server.address();
			assert(address && typeof address !== 'string');
			const attempts: number[] = [];
			using ref = new UrlSource(`http://localhost:${address.port}/data.bin`, {
				getRetryDelay: (previousAttempts) => {
					attempts.push(previousAttempts);
					return previousAttempts >= 3 || attempts.length >= 10 ? null : 0;
				},
			}).ref();

			await expect(async () => new Reader(ref.source).requestSlice(0, 500_000)).rejects.toThrow();
			expect(attempts, honorRanges ? 'range requests' : 'sequential mode').toEqual([1, 2, 3]);
		} finally {
			logs.stop();
			server.closeAllConnections();
			server.close();
		}
	}
});

test('UrlSource with maxCacheSize: Infinity allows random access against a rangeless server', async () => {
	const server = await startRangelessServer();
	const logs = captureLogs();

	try {
		using input = new Input({
			// This is the escape hatch recommended by the eviction error message: with an infinite cache, nothing
			// is ever evicted and random access keeps working
			source: new UrlSource(server.url, { maxCacheSize: Infinity }),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		const sink = new EncodedPacketSink(track);

		const timestamps: number[] = [];
		for await (const packet of sink.packets()) {
			timestamps.push(packet.timestamp);
		}

		expect(timestamps).toHaveLength(125);

		const firstPacket = await sink.getFirstPacket();
		if (!firstPacket) throw new Error('No first packet found');

		expect(firstPacket.timestamp).toBe(0);
		expect(firstPacket.data.byteLength).toBeGreaterThan(0);

		expect(logs.warnings.filter(
			x => x.includes('did not respond to a range request with 206 Partial Content'),
		)).toHaveLength(1);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource rejects responses for a resource that got shorter while it was being read', async () => {
	const v1 = new Uint8Array(3 * 2 ** 20).map((_, i) => i & 0xff);
	const v2 = new Uint8Array(2 * 2 ** 20).map((_, i) => (i * 7 + 3) & 0xff);

	for (const honorRanges of [true, false]) {
		for (const changes of [false, true]) {
			let requestCount = 0;
			const server = http.createServer((req, res) => {
				res.on('error', () => {});
				const isFirst = requestCount++ === 0;
				const data = isFirst || !changes ? v1 : v2;

				if (honorRanges) {
					const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')![1]);
					res.writeHead(206, {
						'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}`,
						'Content-Length': data.length - start,
					});
					res.end(data.subarray(start));
				} else {
					res.writeHead(200, { 'Content-Length': data.length });
					if (isFirst) {
						// The connection dies, so that the download resumes with a second request
						res.write(data.subarray(0, 100_000), () => res.destroy());
					} else {
						res.end(data);
					}
				}
			});

			await new Promise<void>(resolve => server.listen(0, resolve));
			const logs = captureLogs();

			try {
				const address = server.address();
				assert(address && typeof address !== 'string');
				const url = `http://localhost:${address.port}/data.bin`;
				using ref = new UrlSource(url, { getRetryDelay: () => 0 }).ref();
				const reader = new Reader(ref.source);

				// With range requests, a second request is made for a far-away read once the length is known
				const [start, length] = honorRanges ? [1_900_000, 100] : [0, 500_000];
				if (honorRanges) {
					await reader.requestSlice(0, 100);
				}

				const read = async () => reader.requestSlice(start, length);
				if (changes) {
					await expect(read).rejects.toThrow(
						`Error fetching ${url}: the resource changed while it was being read; it was 3145728`
						+ ' bytes long, now it is 2097152.',
					);
				} else {
					const slice = await read();
					expect(Buffer.compare(readBytes(slice!, length), v1.subarray(start, start + length))).toBe(0);
				}
			} finally {
				logs.stop();
				server.closeAllConnections();
				server.close();
			}
		}
	}
});

test('UrlSource keeps reading a file that grows while it is read, within the length first stated', async () => {
	// Like a server serving a recording in progress: every response states the length written so far, and the bytes
	// already written never change
	const full = new Uint8Array(3_000_000).map((_, i) => (i * 7 + (i >> 9)) & 0xff);
	const lengths = [1_000_000, 1_500_000, 2_000_000];
	const requestStarts: number[] = [];
	const fetchFn = (async (_url: unknown, init?: RequestInit) => {
		const length = lengths[Math.min(requestStarts.length, lengths.length - 1)]!;
		const start = Number(/^bytes=(\d+)-$/.exec(new Headers(init?.headers).get('Range') ?? '')![1]);
		requestStarts.push(start);

		let pos = start;
		const body = new ReadableStream<Uint8Array>({
			pull: (controller) => {
				if (pos >= length) {
					controller.close();
					return;
				}

				controller.enqueue(full.slice(pos, Math.min(pos + 16384, length)));
				pos += 16384;
			},
		});

		return new Response(body, {
			status: 206,
			headers: {
				'Content-Range': `bytes ${start}-${length - 1}/${length}`,
				'Content-Length': String(length - start),
			},
		});
	}) as typeof fetch;

	// A small cache, so that the later reads need new requests
	using ref = new UrlSource('https://example.com/recording.mkv', { fetchFn, maxCacheSize: 2 ** 16 }).ref();
	const reader = new Reader(ref.source);

	for (const start of [0, 900_000, 100_000]) {
		const slice = await reader.requestSlice(start, 1000);
		expect(Buffer.compare(readBytes(slice!, 1000), full.subarray(start, start + 1000))).toBe(0);
	}

	expect(requestStarts.length).toBeGreaterThanOrEqual(3);
	expect(await ref.source.getSize()).toBe(1_000_000);
});

test('UrlSource in sequential mode downloads lazily and aborts the response on dispose', async () => {
	// The resource is padded to a size far beyond what kernel socket buffers can swallow. This matters: the server
	// can only observe the client's laziness through backpressure, and on some systems (like Linux with its TCP
	// buffer autotuning), the kernel happily buffers multiple megabytes of sent data that the client never read.
	const paddingSize = 2 ** 26; // 64 MiB
	const totalSize = fs.statSync(videoFilePath).size + paddingSize;

	const server = await startRangelessServer({ trailingPaddingSize: paddingSize });
	const logs = captureLogs();

	const input = new Input({
		source: new UrlSource(server.url),
		formats: ALL_FORMATS,
	});

	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		// If the client were downloading eagerly, the entire resource would easily arrive during this window.
		// Instead, the server is expected to stall, since data is only pulled down when reads demand it.
		await new Promise(resolve => setTimeout(resolve, 3000));

		expect(server.bytesSent()).toBeLessThan(totalSize / 2);

		// The response is merely suspended, not dead: reading still works
		const sink = new EncodedPacketSink(track);
		const firstPacket = await sink.getFirstPacket();
		if (!firstPacket) throw new Error('No first packet found');

		expect(firstPacket.timestamp).toBe(0);
		expect(firstPacket.data.byteLength).toBeGreaterThan(0);

		input.dispose();

		// Give the abort a moment to propagate to the server
		await new Promise(resolve => setTimeout(resolve, 250));

		// Disposal terminated the response early, long before the entire resource was sent
		expect(server.abortedResponses()).toBe(1);
		expect(server.bytesSent()).toBeLessThan(totalSize / 2);
	} finally {
		input.dispose();
		logs.stop();
		server.close();
	}
}, 10_000);

test('UrlSource rejects Range headers it cannot map onto the resource', () => {
	for (const range of ['bytes=-500', 'bytes=0-99,200-299', 'bytes=500-100', 'items=0-9']) {
		expect(() => new UrlSource('https://example.com/a.mp4', { requestInit: { headers: { Range: range } } }))
			.toThrow(new TypeError(
				`Unsupported Range header '${range}': only 'bytes=<start>-' and 'bytes=<start>-<end>'`
				+ ` (with end >= start) can be mapped onto the resource.`,
			));
		expect(() => new UrlSource(new Request('https://example.com/a.mp4', { headers: { Range: range } })))
			.toThrow(TypeError);
	}

	// Range unit names are case-insensitive (RFC 9110, Section 14.1)
	for (const range of ['bytes=100-', 'Bytes=100-199', 'BYTES=0-0']) {
		expect(() => new UrlSource('https://example.com/a.mp4', { requestInit: { headers: { Range: range } } }))
			.not.toThrow();
	}
});

test('UrlSource reads the full decoded body of a compressed response', async () => {
	const text = 'Some playlist text\n'.repeat(256);
	const content = Buffer.from(text);
	const compressed = brotliCompressSync(content);
	const server = http.createServer((req, res) => {
		res.writeHead(200, {
			'Content-Type': 'text/plain',
			'Content-Encoding': 'br',
			'Content-Length': compressed.byteLength,
		});
		res.end(compressed);
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		const source = new UrlSource(`http://localhost:${address.port}/playlist.m3u8`);
		using ref = source.ref();
		const reader = new Reader(ref.source);

		const slice = await reader.requestEntireFile();
		expect(slice).not.toBeNull();
		expect(compressed.byteLength).toBeLessThan(content.byteLength);
		expect(slice!.length).toBe(content.byteLength);
		expect(Buffer.from(readBytes(slice!, slice!.length)).toString()).toBe(text);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('UrlSource reports the real size when its Range window ends past the end of the resource', async () => {
	const data = new Uint8Array(1000);
	const server = http.createServer((req, res) => {
		const [, start, end] = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')!;
		const last = Math.min(end ? Number(end) : Infinity, data.length - 1);
		res.writeHead(206, {
			'Content-Range': `bytes ${start}-${last}/${data.length}`,
			'Content-Length': last - Number(start) + 1,
		});
		res.end(data.subarray(Number(start), last + 1));
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		const url = `http://localhost:${address.port}/data.bin`;

		// RFC 9110 reads a last-pos past the end as "up to the end"
		const source = new UrlSource(url, { requestInit: { headers: { Range: 'bytes=100-99999' } } });
		expect(await source.getSize()).toBe(900);

		const withinBounds = new UrlSource(url, { requestInit: { headers: { Range: 'bytes=100-199' } } });
		expect(await withinBounds.getSize()).toBe(100);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('UrlSource reads the full decoded body of a compressed 206 response', async () => {
	// A 206 carrying Content-Encoding states its Content-Range in compressed bytes, so trusting that
	// total truncates the decoded document.
	const text = 'Some playlist text\n'.repeat(256);
	const content = Buffer.from(text);
	const compressed = brotliCompressSync(content);
	const server = http.createServer((req, res) => {
		res.writeHead(206, {
			'Content-Type': 'text/plain',
			'Content-Encoding': 'br',
			'Content-Range': `bytes 0-${compressed.byteLength - 1}/${compressed.byteLength}`,
			'Content-Length': compressed.byteLength,
			'Accept-Ranges': 'bytes',
		});
		res.end(compressed);
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		const source = new UrlSource(`http://localhost:${address.port}/playlist.m3u8`);
		using ref = source.ref();
		const reader = new Reader(ref.source);

		const slice = await reader.requestEntireFile();
		expect(slice).not.toBeNull();
		expect(compressed.byteLength).toBeLessThan(content.byteLength);
		expect(slice!.length).toBe(content.byteLength);
		expect(Buffer.from(readBytes(slice!, slice!.length)).toString()).toBe(text);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('UrlSource places 206 bodies at the range their Content-Range states', async () => {
	const data = new Uint8Array(3_000_000).map((_, i) => Math.imul(i, 2654435761) >>> 24); // Not periodic
	let rangeUnit = 'bytes';
	const server = http.createServer((req, res) => {
		// Answer with a range that starts at the MiB boundary before the requested position
		const requested = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')![1]);
		const start = requested - (requested % 2 ** 20);
		res.writeHead(206, {
			'Content-Range': `${rangeUnit} ${start}-${data.length - 1}/${data.length}`,
			'Content-Length': data.length - start,
		});
		res.end(data.subarray(start));
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	const readAt = async (url: string, starts: number[]) => {
		using ref = new UrlSource(url).ref();
		const reader = new Reader(ref.source);

		for (const start of starts) {
			const slice = await reader.requestSlice(start, 16);
			expect(slice).not.toBeNull();
			expect([...readBytes(slice!, 16)]).toEqual([...data.subarray(start, start + 16)]);
		}
	};

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');

		// Range unit names are case-insensitive (RFC 9110, Section 14.1)
		for (const unit of ['bytes', 'Bytes']) {
			rangeUnit = unit;
			await readAt(`http://localhost:${address.port}/data.bin`, [0, 2_500_123]);
		}
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('UrlSource rejects 206 bodies that start after the requested position', async () => {
	const server = http.createServer((req, res) => {
		const requested = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')![1]);
		res.writeHead(206, { 'Content-Range': `bytes ${requested + 10}-999/1000`, 'Content-Length': 990 - requested });
		res.end(new Uint8Array(990 - requested));
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		const url = `http://localhost:${address.port}/data.bin`;
		using ref = new UrlSource(url).ref();

		await expect(async () => new Reader(ref.source).requestSlice(0, 16)).rejects.toThrow(
			`Error fetching ${url}: requested bytes from 0, but the server sent bytes 10-999.`,
		);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('UrlSource resumes sequential mode at the start its 206 response states', async () => {
	const data = new Uint8Array(3_000_000).map((_, i) => Math.imul(i, 2654435761) >>> 24); // Not periodic
	let requestCount = 0;
	const server = http.createServer((req, res) => {
		res.on('error', () => {});

		if (requestCount++ === 0) {
			// No range support at first, and the connection dies partway through
			res.writeHead(200, { 'Content-Length': data.length });
			res.write(data.subarray(0, 1_000_000), () => res.destroy());
			return;
		}

		// The resume request gets a range that starts at the MiB boundary before the requested position
		const requested = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')![1]);
		const start = requested - (requested % 2 ** 20);
		res.writeHead(206, {
			'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}`,
			'Content-Length': data.length - start,
		});
		res.end(data.subarray(start));
	});

	await new Promise<void>(resolve => server.listen(0, resolve));
	const logs = captureLogs();

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		using ref = new UrlSource(`http://localhost:${address.port}/data.bin`, { getRetryDelay: () => 0 }).ref();
		const reader = new Reader(ref.source);

		const slice = await reader.requestSlice(0, data.length);
		expect(Buffer.compare(readBytes(slice!, data.length), data)).toBe(0);
		expect(requestCount).toBe(2);
	} finally {
		logs.stop();
		server.closeAllConnections();
		server.close();
	}
});

test('UrlSource learns the size from where a 206 body without a total really starts', async () => {
	const data = new Uint8Array(3_000_000);
	const server = http.createServer((req, res) => {
		// The range starts at the MiB boundary before the requested position, and the total size is unknown
		const requested = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')![1]);
		const start = requested - (requested % 2 ** 20);
		res.writeHead(206, {
			'Content-Range': `bytes ${start}-${data.length - 1}/*`,
			'Content-Length': data.length - start,
		});
		res.end(data.subarray(start));
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		const source = new UrlSource(`http://localhost:${address.port}/data.bin`);
		using ref = source.ref();
		await new Reader(ref.source).requestSlice(2_500_123, 16);

		expect(await source.getSize()).toBe(data.length);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

const startRangelessServer = async (
	options: { responseByteLimits?: number[]; trailingPaddingSize?: number } = {},
) => {
	const fileSize = fs.statSync(videoFilePath).size;
	const paddingSize = options.trailingPaddingSize ?? 0;
	let requestCount = 0;
	let bytesSent = 0;
	let abortedResponses = 0;

	const server = http.createServer((req, res) => {
		const byteLimit = options.responseByteLimits?.[requestCount] ?? Infinity;
		requestCount++;

		res.on('error', () => {}); // The client may abort the connection at any time
		res.on('close', () => {
			if (!res.writableFinished) {
				abortedResponses++;
			}
		});
		res.writeHead(200, {
			'Content-Type': 'video/mp4',
			'Content-Length': fileSize + paddingSize,
		});

		// Stream the file with backpressure and a small chunk size, so that the amount of sent bytes closely
		// tracks how much the client actually consumes
		const stream = fs.createReadStream(videoFilePath, { highWaterMark: 2 ** 14 });
		let bytesSentThisResponse = 0;

		stream.on('data', (chunk) => {
			const canContinue = res.write(chunk);
			bytesSent += chunk.length;
			bytesSentThisResponse += chunk.length;

			if (bytesSentThisResponse >= byteLimit) {
				stream.destroy();
				res.destroy(); // Kill the connection mid-response

				return;
			}

			if (!canContinue) {
				stream.pause();
				res.once('drain', () => stream.resume());
			}
		});
		stream.on('end', () => {
			if (paddingSize === 0) {
				res.end();
				return;
			}

			// Append a giant 'free' box: valid ISOBMFF, but never read by the demuxer
			const header = Buffer.alloc(8);
			header.writeUInt32BE(paddingSize, 0);
			header.write('free', 4, 'latin1');

			const zeroes = Buffer.alloc(2 ** 14);
			let paddingSent = 0;

			const writeMore = () => {
				while (paddingSent < paddingSize) {
					const chunk = paddingSent === 0
						? header
						: zeroes.subarray(0, Math.min(paddingSize - paddingSent, zeroes.length));

					paddingSent += chunk.length;
					bytesSent += chunk.length;

					if (!res.write(chunk)) {
						res.once('drain', writeMore);
						return;
					}
				}

				res.end();
			};
			writeMore();
		});
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Unexpected server address');

	return {
		url: `http://localhost:${address.port}/video.mp4`,
		requestCount: () => requestCount,
		bytesSent: () => bytesSent,
		abortedResponses: () => abortedResponses,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
};

test('UrlSource takes the size from a range response stating Content-Encoding: identity', async () => {
	const bytes = new Uint8Array(1000).map((_, i) => i & 0xff);

	for (const contentEncoding of [null, 'identity', 'Identity']) {
		const server = http.createServer((req, res) => {
			const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')?.[1] ?? 0);
			res.writeHead(206, {
				'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
				'Content-Length': bytes.length - start,
				// "identity" means no content coding, so the lengths still count the resource's own bytes
				...(contentEncoding !== null && { 'Content-Encoding': contentEncoding }),
			});
			res.end(bytes.subarray(start));
		});

		await new Promise<void>(resolve => server.listen(0, resolve));

		try {
			const address = server.address();
			assert(address && typeof address !== 'string');
			using ref = new UrlSource(`http://localhost:${address.port}/data.bin`).ref();
			expect(await ref.source.getSizeOrNull(), String(contentEncoding)).toBe(bytes.length);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	}
});

test('UrlSource retries requests that failed with a transient HTTP status', async () => {
	const data = new Uint8Array(1000).map((_, i) => i & 0xff);
	let failures: number[] = [];
	let requestCount = 0;
	const server = http.createServer((req, res) => {
		requestCount++;
		const status = failures.shift();
		if (status !== undefined) {
			res.writeHead(status);
			res.end();
			return;
		}

		const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')?.[1] ?? 0);
		res.writeHead(206, {
			'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}`,
			'Content-Length': data.length - start,
		});
		res.end(data.subarray(start));
	});

	await new Promise<void>(resolve => server.listen(0, resolve));
	const logs = captureLogs();

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		const url = `http://localhost:${address.port}/data.bin`;
		const read = async (statuses: number[], retry = true) => {
			failures = [...statuses];
			const attempts: [number, unknown][] = [];
			using ref = new UrlSource(url, {
				getRetryDelay: (previousAttempts, error) => {
					// The error carries the status, so that policies can tell this apart from a network error
					attempts.push([previousAttempts, (error as { status?: unknown }).status]);
					return retry ? 0 : null;
				},
			}).ref();

			try {
				const slice = await new Reader(ref.source).requestSlice(0, 4);
				return { attempts, result: [...readBytes(slice!, 4)] };
			} catch (error) {
				return { attempts, result: String(error) };
			}
		};

		// Server errors, timeouts and rate limiting can go away, so they're retried like network errors...
		expect(await read([503, 429, 502])).toEqual({ attempts: [[1, 503], [2, 429], [3, 502]], result: [0, 1, 2, 3] });
		// ...as long as the retry policy wants to
		expect(await read([503], false)).toEqual({
			attempts: [[1, 503]],
			result: `Error: Error fetching ${url}: 503 Service Unavailable`,
		});
		// Other failures are final
		expect(await read([404])).toEqual({ attempts: [], result: `Error: Error fetching ${url}: 404 Not Found` });

		// The default policy gives up on a server that keeps answering such a status, after 5 retries (15.5 seconds of
		// waiting, which this test skips), while it retries network errors indefinitely
		const defaultPolicy = new UrlSource(url)._getRetryDelay;
		const delays: (number | null)[] = [];
		failures = new Array<number>(100).fill(503);
		requestCount = 0;
		using ref = new UrlSource(url, {
			getRetryDelay: (previousAttempts, error, source) => {
				const delay = defaultPolicy(previousAttempts, error, source);
				delays.push(delay);
				return delay === null ? null : 0;
			},
		}).ref();
		await expect(new Reader(ref.source).requestSlice(0, 4)).rejects.toThrow(
			`Error fetching ${url}: 503 Service Unavailable`,
		);
		expect(delays).toEqual([0.5, 1, 2, 4, 8, null]);
		expect(requestCount).toBe(6);
		expect(defaultPolicy(100, new TypeError('fetch failed'), url)).toBe(16);
	} finally {
		logs.stop();
		server.closeAllConnections();
		server.close();
	}
});

test('UrlSource frees the response of a transient HTTP status when its retry policy fails', async () => {
	// Far too big for the client to take in by itself, so a response whose body is neither read nor cancelled keeps
	// its connection busy for good
	const body = Buffer.alloc(32 * 2 ** 20, 0x20);
	const openSockets = new Set<http.IncomingMessage['socket']>();
	const controlSockets = new Set<http.IncomingMessage['socket']>();
	const server = http.createServer((req, res) => {
		const sockets = req.url === '/control' ? controlSockets : openSockets;
		if (!sockets.has(req.socket)) {
			sockets.add(req.socket);
			req.socket.on('close', () => sockets.delete(req.socket));
		}

		res.writeHead(503, { 'Content-Length': body.length });
		res.end(body);
	});
	// Keeps every response referenced, so that garbage collection can't free a forgotten one behind the test's back
	const responses: Response[] = [];
	const fetchFn = (async (...args: Parameters<typeof fetch>) => {
		const response = await fetch(...args);
		responses.push(response);
		return response;
	}) as typeof fetch;
	// Waits until all connections of the failed responses are closed, however long the system takes for that
	const allClosed = async () => {
		for (const deadline = Date.now() + 10_000; openSockets.size > 0 && Date.now() < deadline;) {
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		return openSockets.size === 0;
	};

	await new Promise<void>(resolve => server.listen(0, resolve));
	const logs = captureLogs();

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');

		// Control: a response whose body is left alone keeps its connection open
		const control = await fetch(`http://localhost:${address.port}/control`);

		const policies: [() => number, string][] = [
			[() => {
				throw new Error('Policy failed');
			}, 'Policy failed'],
			[() => -1, 'Retry delay must be a non-negative finite number.'],
		];
		for (const [getRetryDelay, message] of policies) {
			const inputs: Input[] = [];
			for (let i = 0; i < 10; i++) {
				const input = new Input({
					source: new UrlSource(`http://localhost:${address.port}/data.bin`, { fetchFn, getRetryDelay }),
					formats: ALL_FORMATS,
				});
				inputs.push(input);
				await expect(input.getFormat()).rejects.toThrow(message);
			}

			// The failed responses get cancelled, which closes their connections, even while the inputs are still
			// around (disposing them would abort the requests anyway)
			expect(await allClosed(), message).toBe(true);
			inputs.forEach(input => input.dispose());
		}

		expect(responses).toHaveLength(20);
		expect(controlSockets.size).toBe(1);
		await control.body?.cancel();
	} finally {
		logs.stop();
		server.closeAllConnections();
		server.close();
	}
}, 60_000);

/** Collects logged warnings and errors, keeping the console clean while doing so. */
const captureLogs = () => {
	const warnings: string[] = [];
	const errors: string[] = [];
	const unsubscribeWarn = Logging.on('warn', args => warnings.push(args.map(String).join(' ')));
	const unsubscribeError = Logging.on('error', args => errors.push(args.map(String).join(' ')));

	const previousLogLevel = Logging.level;
	Logging.level = LogLevel.Silent;

	return {
		warnings,
		errors,
		stop: () => {
			unsubscribeWarn();
			unsubscribeError();
			Logging.level = previousLogLevel;
		},
	};
};

test('UrlSource with a small cache only requests what fits into it', async () => {
	// Prefetching more than the cache holds evicts the data before it's read, so it got requested again on nearly every
	// read
	const file = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'public/0.ts')));
	let requestCount = 0;
	let transferredBytes = 0;
	const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
		requestCount++;
		const range = /bytes=(\d+)-/.exec(new Headers(init?.headers).get('Range') ?? '');
		const start = Number(range?.[1] ?? 0);
		let pos = start;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pos >= file.length) {
					controller.close();
					return;
				}

				const chunk = file.slice(pos, pos + 16384);
				transferredBytes += chunk.length;
				pos += chunk.length;
				controller.enqueue(chunk);
			},
		});

		return new Response(body, {
			status: 206,
			headers: { 'Content-Range': `bytes ${start}-${file.length - 1}/${file.length}` },
		});
	}) as typeof fetch;

	using input = new Input({
		source: new UrlSource('https://example.com/0.ts', { fetchFn, maxCacheSize: 2 ** 16 }),
		formats: ALL_FORMATS,
	});

	let packetCount = 0;
	for (const track of await input.getTracks()) {
		for await (const packet of new EncodedPacketSink(track).packets()) {
			void packet;
			packetCount++;
		}
	}

	expect(packetCount).toBe(532);
	// Main made 28k requests, transferring 13.8 GB of this 1.9 MB file
	expect(requestCount).toBeLessThan(1000);
	expect(transferredBytes).toBeLessThan(10 * file.length);
});

test('UrlSource reads files larger than its cache in order from a server without range support', async () => {
	// 300 VP9 packets of 1 kB with a key frame every second, in small fragments or clusters
	const buildVideoFile = async (format: Mp4OutputFormat | MkvOutputFormat) => {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source, { frameRate: 30 });
		await output.start();
		for (let i = 0; i < 300; i++) {
			const type = i % 30 === 0 ? 'key' : 'delta';
			const packet = new EncodedPacket(new Uint8Array(1000).fill(i), type, i / 30, 1 / 30);
			await source.add(packet, {
				decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 320, codedHeight: 240 },
			});
		}
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	// 16-bit stereo 48 kHz WAVE with 600 kB of audio, then a LIST INFO chunk (where many taggers put it)
	const list = Buffer.from('LIST\x12\0\0\0INFOINAM\x06\0\0\0Title\0', 'latin1');
	const waveHeader = Buffer.alloc(44);
	waveHeader.write('RIFF', 0);
	waveHeader.writeUInt32LE(36 + 600_000 + list.length, 4);
	waveHeader.write('WAVEfmt ', 8);
	waveHeader.writeUInt32LE(16, 16);
	waveHeader.writeUInt16LE(1, 20);
	waveHeader.writeUInt16LE(2, 22);
	waveHeader.writeUInt32LE(48000, 24);
	waveHeader.writeUInt32LE(48000 * 4, 28);
	waveHeader.writeUInt16LE(4, 32);
	waveHeader.writeUInt16LE(16, 34);
	waveHeader.write('data', 36);
	waveHeader.writeUInt32LE(600_000, 40);

	// An MP3 without an ID3v2 tag, for which reading the metadata tags looks for an ID3v1 tag at the end
	const mp3 = fs.readFileSync(path.join(__dirname, '../public/Toothsome-Meme.VBRv2.mp3'));
	assert(mp3.toString('latin1', 0, 3) === 'ID3');
	const id3V2Size = ((mp3[6]! & 0x7f) << 21) | ((mp3[7]! & 0x7f) << 14) | ((mp3[8]! & 0x7f) << 7) | (mp3[9]! & 0x7f);

	const files = [
		await buildVideoFile(new Mp4OutputFormat({ fastStart: 'fragmented' })),
		await buildVideoFile(new MkvOutputFormat()),
		new Uint8Array(Buffer.concat([waveHeader, Buffer.alloc(600_000), list])),
		new Uint8Array(mp3.subarray(10 + id3V2Size)),
	];

	// Like `python3 -m http.server`: Range is ignored, and the whole file comes back as a 200 with a Content-Length
	let file = files[0]!;
	const server = http.createServer((req, res) => res.writeHead(200, { 'Content-Length': file.length }).end(file));
	await new Promise<void>(resolve => server.listen(0, resolve));
	const logs = captureLogs(); // UrlSource warns that it can only read sequentially

	const countPackets = async (source: UrlSource | BufferSource) => {
		using input = new Input({ source, formats: ALL_FORMATS });
		await input.getMetadataTags();
		const track = (await input.getPrimaryVideoTrack()) ?? (await input.getPrimaryAudioTrack());
		let count = 0;
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			count += packet.data.length > 0 ? 1 : 0;
		}

		return count;
	};

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');

		// Reading must not need data that streaming has already evicted from the 64 KiB cache, so all the packets come
		// out, like from memory. On main, each file fails with "Attempted to read data from an already-evicted part of
		// the cache".
		const expected: number[] = [];
		const counts: (number | string)[] = [];
		for (file of files) {
			expected.push(await countPackets(new BufferSource(file)));
			const source = new UrlSource(`http://localhost:${address.port}/media`, { maxCacheSize: 2 ** 16 });
			counts.push(await countPackets(source).catch((error: unknown) => String(error).slice(0, 80)));
		}

		expect(expected.every(count => count > 70)).toBe(true);
		expect(counts).toEqual(expected);
	} finally {
		logs.stop();
		server.close();
	}
});
