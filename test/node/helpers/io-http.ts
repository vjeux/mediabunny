import http from 'node:http';
import { gzipSync } from 'node:zlib';

export type ByteServerOptions = {
	/** When false, the server ignores Range headers and always answers 200 with the whole resource. */
	honorRanges?: boolean;
	/** How a 206 response states the complete length: a number, '*' (unknown), or not at all. */
	contentRange?: 'total' | 'star' | 'none';
	/** Whether to send Content-Length. */
	contentLength?: boolean;
	/** Caps the number of bytes per response, like servers that don't answer open-ended ranges in full. */
	cap?: number;
	/** Body chunk size. With `trickle`, the server yields to the event loop between chunks. */
	chunkSize?: number;
	trickle?: boolean;
	/** Waits this long between body chunks. */
	chunkDelayMs?: number;
	/** The first N requests are answered by destroying the socket, causing a network error. */
	failFirstRequests?: number;
	/** Paths answered with a 302 redirect to the resource. */
	redirectPaths?: string[];
	/** Gzip the whole body and send Content-Encoding (Content-Length/Content-Range then count encoded bytes). */
	gzip?: boolean;
	/** Status for requests whose range starts at or past the end (default 416). */
	statusAtEnd?: number;
};

export type RecordedRequest = {
	url: string;
	range: string | null;
	headers: http.IncomingHttpHeaders;
};

/** Starts a local HTTP server serving `data` at `/file.bin` with configurable range semantics. */
export const startByteServer = async (data: Uint8Array, options: ByteServerOptions = {}) => {
	const requests: RecordedRequest[] = [];
	let failuresLeft = options.failFirstRequests ?? 0;

	const server = http.createServer((req, res) => {
		res.on('error', () => {});
		requests.push({ url: req.url ?? '', range: req.headers.range ?? null, headers: req.headers });

		if (failuresLeft > 0) {
			failuresLeft--;
			req.socket.destroy();
			return;
		}

		if (options.redirectPaths?.includes(req.url ?? '')) {
			res.writeHead(302, { Location: '/file.bin' });
			res.end();
			return;
		}

		if (req.url !== '/file.bin') {
			res.writeHead(404);
			res.end();
			return;
		}

		const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
		const honorRanges = options.honorRanges ?? true;

		let status = 200;
		let start = 0;
		let end = data.length;
		const headers: Record<string, string | number> = { 'Accept-Ranges': honorRanges ? 'bytes' : 'none' };

		if (honorRanges && match) {
			start = Number(match[1]);
			end = match[2] ? Math.min(Number(match[2]) + 1, data.length) : data.length;

			if (start >= data.length) {
				res.writeHead(options.statusAtEnd ?? 416, { 'Content-Range': `bytes */${data.length}` });
				res.end();
				return;
			}

			if (options.cap !== undefined) {
				end = Math.min(end, start + options.cap);
			}

			status = 206;
			const contentRange = options.contentRange ?? 'total';
			if (contentRange !== 'none') {
				headers['Content-Range'] = `bytes ${start}-${end - 1}/${contentRange === 'star' ? '*' : data.length}`;
			}
		}

		let body = Buffer.from(data.buffer, data.byteOffset + start, end - start);
		if (options.gzip) {
			body = gzipSync(body);
			headers['Content-Encoding'] = 'gzip';
		}

		if (options.contentLength ?? true) {
			headers['Content-Length'] = body.length;
		}

		res.writeHead(status, headers);

		const chunkSize = options.chunkSize ?? body.length;
		let position = 0;
		const pump = () => {
			while (position < body.length) {
				const piece = body.subarray(position, position + chunkSize);
				position += piece.length;
				const canContinue = res.write(piece);

				if (options.chunkDelayMs) {
					setTimeout(pump, options.chunkDelayMs);
					return;
				}
				if (options.trickle) {
					// Not a timer, whose granularity is ~16 ms on some platforms
					setImmediate(pump);
					return;
				}
				if (!canContinue) {
					res.once('drain', pump);
					return;
				}
			}

			res.end();
		};
		pump();
	});

	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Unexpected server address.');
	}

	const origin = `http://127.0.0.1:${address.port}`;

	return {
		origin,
		url: `${origin}/file.bin`,
		requests,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
};
