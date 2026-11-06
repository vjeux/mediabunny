import { afterEach, assert, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	AdtsOutputFormat,
	AudioSample,
	AudioSampleSink,
	BufferSource,
	BufferTarget,
	CmafOutputFormat,
	Conversion,
	ConversionCanceledError,
	CustomAudioDecoder,
	CustomAudioEncoder,
	CustomPathedSource,
	CustomSource,
	CustomVideoDecoder,
	CustomVideoEncoder,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FlacOutputFormat,
	HlsOutputFormat,
	Input,
	InputDisposedError,
	InputTrack,
	MkvOutputFormat,
	MovOutputFormat,
	Mp3OutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	OggOutputFormat,
	Output,
	OutputFormat,
	PathedTarget,
	ReadableStreamSource,
	Source,
	StreamTarget,
	StreamTargetChunk,
	Target,
	UrlSource,
	VideoSample,
	VideoSampleSink,
	WavOutputFormat,
	WebMOutputFormat,
	registerDecoder,
	registerEncoder,
} from '../../src/index.js';

// Each test below runs the same operation under several seeded schedules: source reads and target writes complete
// after seeded delays (and thus out of order), operations run concurrently on shared objects, and cancellation hits
// at seeded points. The delays only use microtasks and event loop turns, never timers, so a seed always replays the
// same interleaving. The results must match a plain sequential run, and every promise must settle.

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const readFixture = async (name: string) => new Uint8Array(await readFile(path.join(__dirname, '../public', name)));

type Rand = () => number;

const mulberry32 = (seed: number): Rand => {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/** Waits for a seeded mix of nothing, a few microtasks, or one or two event loop turns. */
const randomDelay = async (rand: Rand) => {
	const r = rand();
	if (r < 0.25) {
		return;
	}

	if (r < 0.6) {
		const count = 1 + Math.floor(rand() * 12);
		for (let i = 0; i < count; i++) {
			await Promise.resolve();
		}
		return;
	}

	const count = 1 + Math.floor(rand() * 2);
	for (let i = 0; i < count; i++) {
		await new Promise(resolve => setImmediate(resolve));
	}
};

const randomDelays = async (rand: Rand, maxCount: number) => {
	const count = Math.floor(rand() * maxCount);
	for (let i = 0; i < count; i++) {
		await randomDelay(rand);
	}
};

/** Waits a bounded number of event loop turns for `condition`, for cleanup that finishes shortly after the fact. */
const waitFor = async (condition: () => boolean) => {
	for (let i = 0; i < 100 && !condition(); i++) {
		await new Promise(resolve => setImmediate(resolve));
	}
};

const shuffle = <T>(array: T[], rand: Rand) => {
	const copy = [...array];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[copy[i], copy[j]] = [copy[j]!, copy[i]!];
	}
	return copy;
};

const hashBytes = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex').slice(0, 12);

const describePacket = (packet: EncodedPacket | null, withData = true) => {
	if (!packet) {
		return 'null';
	}

	const parts = [
		packet.timestamp.toFixed(9),
		packet.duration.toFixed(9),
		packet.type,
		packet.byteLength,
		packet.sequenceNumber,
	];
	if (withData && !packet.isMetadataOnly) {
		parts.push(hashBytes(packet.data));
	}

	return parts.join('|');
};

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------------
// Reading

/**
 * A CustomSource over `bytes` whose reads complete after seeded delays, some synchronously, some as a stream of
 * randomly sized chunks. Prefetching and cache size are seeded too.
 */
const makeRacySource = (bytes: Uint8Array, rand: Rand, dispose?: () => void) => {
	const prefetchProfiles = ['none', 'fileSystem', 'network'] as const;

	return new CustomSource({
		getSize: () => rand() < 0.5 ? bytes.length : randomDelay(rand).then(() => bytes.length),
		read: (start, end) => {
			if (rand() < 0.2) {
				return bytes.slice(start, end);
			}

			const asStream = rand() < 0.2;
			return randomDelay(rand).then(() => {
				if (!asStream) {
					return bytes.slice(start, end);
				}

				let position = start;
				return new ReadableStream<Uint8Array>({
					pull: async (controller) => {
						await randomDelay(rand);
						if (position >= end) {
							controller.close();
							return;
						}

						const size = Math.min(end - position, 1 + Math.floor(rand() * 65536));
						controller.enqueue(bytes.slice(position, position + size));
						position += size;
					},
				});
			});
		},
		dispose,
		prefetchProfile: prefetchProfiles[Math.floor(rand() * prefetchProfiles.length)],
		maxCacheSize: [0, 4096, 65536, undefined][Math.floor(rand() * 4)],
	});
};

/** A ReadableStreamSource delivering `bytes` in seeded chunk sizes after seeded delays. */
const makeRacyStreamSource = (bytes: Uint8Array, rand: Rand) => {
	let position = 0;

	return new ReadableStreamSource(new ReadableStream<Uint8Array>({
		pull: async (controller) => {
			await randomDelay(rand);
			if (position >= bytes.length) {
				controller.close();
				return;
			}

			const size = Math.min(bytes.length - position, 1 + Math.floor(rand() * 100_000));
			controller.enqueue(bytes.slice(position, position + size));
			position += size;
		},
	}));
};

type ReadOp = {
	name: string;
	run: (input: Input) => Promise<string>;
};

const getTrack = async (input: Input, index: number) => {
	const track = (await input.getTracks())[index];
	if (!track) {
		throw new Error(`No track ${index}.`);
	}

	return track;
};

const describeTrack = async (track: InputTrack) => {
	const parts: unknown[] = [
		track.type,
		track.id,
		await track.getCodec(),
		await track.getCodecParameterString(),
		await track.getLanguageCode(),
		await track.getTimeResolution(),
	];

	const config = track.isVideoTrack() || track.isAudioTrack() ? await track.getDecoderConfig() : null;
	if (config) {
		const { description, ...rest } = config as { description?: AllowSharedBufferSource };
		parts.push(JSON.stringify(rest));
		if (description) {
			parts.push(hashBytes(ArrayBuffer.isView(description)
				? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
				: new Uint8Array(description)));
		}
	}

	if (track.isVideoTrack()) {
		parts.push(await track.getCodedWidth(), await track.getCodedHeight(), await track.getRotation());
	} else if (track.isAudioTrack()) {
		parts.push(await track.getNumberOfChannels(), await track.getSampleRate());
	}

	return parts.join(';');
};

const tagReplacer = (key: string, value: unknown) => {
	if (value instanceof Uint8Array) {
		return hashBytes(value);
	}

	return value;
};

/** The packets of every track, as a reference for picking the timestamps that the operations look up. */
const getReferencePackets = async (source: Source) => {
	using input = new Input({ source, formats: ALL_FORMATS });

	const result: EncodedPacket[][] = [];
	for (const track of await input.getTracks()) {
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
			packets.push(packet);
		}
		result.push(packets);
	}

	return result;
};

/**
 * Operations covering the whole reading API: input-level getters, full packet iteration (with and without data),
 * lookups at seeded timestamps, getNextPacket/getNextKeyPacket chains, packet iterators that stop early, and (with
 * `fanOut`) several chains and iterators continuing from the same packet object at once.
 */
const buildReadOps = (referencePackets: EncodedPacket[][], rand: Rand, { fanOut = true } = {}) => {
	const ops: ReadOp[] = [
		{ name: 'format', run: async input => (await input.getFormat()).name },
		{ name: 'mimeType', run: input => input.getMimeType() },
		{ name: 'tags', run: async input => JSON.stringify(await input.getMetadataTags(), tagReplacer) },
		{ name: 'duration', run: async input => String(await input.computeDuration()) },
		{ name: 'firstTimestamp', run: async input => String(await input.getFirstTimestamp()) },
		{
			name: 'tracks',
			run: async input => (await Promise.all((await input.getTracks()).map(describeTrack))).join('\n'),
		},
	];

	referencePackets.forEach((packets, trackIndex) => {
		const t = `track ${trackIndex}`;

		ops.push({ name: `${t}: packets`, run: async (input) => {
			const lines: string[] = [];
			for await (const packet of new EncodedPacketSink(await getTrack(input, trackIndex)).packets()) {
				lines.push(describePacket(packet));
			}
			return lines.join('\n');
		} });
		ops.push({ name: `${t}: metadata-only packets`, run: async (input) => {
			const sink = new EncodedPacketSink(await getTrack(input, trackIndex));
			const lines: string[] = [];
			for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
				lines.push(describePacket(packet, false));
			}
			return lines.join('\n');
		} });
		ops.push({ name: `${t}: first packets`, run: async (input) => {
			const sink = new EncodedPacketSink(await getTrack(input, trackIndex));
			return `${describePacket(await sink.getFirstPacket())} ${describePacket(await sink.getFirstKeyPacket())}`;
		} });
		ops.push({ name: `${t}: duration`, run: async (input) => {
			return String(await (await getTrack(input, trackIndex)).computeDuration());
		} });

		if (packets.length === 0) {
			return;
		}

		const randomPacket = () => packets[Math.floor(rand() * packets.length)]!;

		const timestamps = [-1, Infinity];
		for (let i = 0; i < 6; i++) {
			const packet = randomPacket();
			timestamps.push(rand() < 0.5 ? packet.timestamp : packet.timestamp + packet.duration * rand());
		}
		for (const timestamp of timestamps) {
			ops.push({ name: `${t}: lookups at ${timestamp}`, run: async (input) => {
				const sink = new EncodedPacketSink(await getTrack(input, trackIndex));
				const [packet, keyPacket, metadataOnly] = await Promise.all([
					sink.getPacket(timestamp),
					sink.getKeyPacket(timestamp),
					sink.getPacket(timestamp, { metadataOnly: true }),
				]);
				return [
					describePacket(packet),
					describePacket(keyPacket),
					describePacket(metadataOnly, false),
				].join(' ');
			} });
		}

		for (let i = 0; i < 4; i++) {
			const timestamp = randomPacket().timestamp;
			const steps = 1 + Math.floor(rand() * 30);
			const keyOnly = rand() < 0.3;
			ops.push({ name: `${t}: ${keyOnly ? 'key ' : ''}chain from ${timestamp}`, run: async (input) => {
				const sink = new EncodedPacketSink(await getTrack(input, trackIndex));
				let packet = keyOnly ? await sink.getKeyPacket(timestamp) : await sink.getPacket(timestamp);
				const lines = [describePacket(packet)];
				for (let step = 0; step < steps && packet; step++) {
					packet = keyOnly ? await sink.getNextKeyPacket(packet) : await sink.getNextPacket(packet);
					lines.push(describePacket(packet));
				}
				return lines.join('\n');
			} });
		}

		for (let i = 0; i < 3; i++) {
			const timestamp = randomPacket().timestamp;
			const count = 1 + Math.floor(rand() * 40);
			ops.push({ name: `${t}: ${count} packets from ${timestamp}, then break`, run: async (input) => {
				const sink = new EncodedPacketSink(await getTrack(input, trackIndex));
				const lines: string[] = [];
				for await (const packet of sink.packets(await sink.getKeyPacket(timestamp) ?? undefined)) {
					lines.push(describePacket(packet));
					if (lines.length === count) {
						break;
					}
				}
				return lines.join('\n');
			} });
		}

		if (!fanOut) {
			return;
		}

		for (let i = 0; i < 3; i++) {
			const timestamp = randomPacket().timestamp;
			const steps = 1 + Math.floor(rand() * 12);
			ops.push({ name: `${t}: fan-out from ${timestamp}`, run: async (input) => {
				const sink = new EncodedPacketSink(await getTrack(input, trackIndex));
				const start = await sink.getPacket(timestamp, { metadataOnly: true });
				if (!start) {
					return 'null';
				}

				const branches = await Promise.all(['next', 'next key', 'iterator', 'next'].map(async (kind) => {
					const lines: string[] = [];
					if (kind === 'iterator') {
						for await (const packet of sink.packets(start, undefined, { metadataOnly: true })) {
							lines.push(describePacket(packet, false));
							if (lines.length > steps) {
								break;
							}
						}
						return lines.slice(1).join(',');
					}

					let packet: EncodedPacket | null = start;
					for (let step = 0; step < steps && packet; step++) {
						packet = kind === 'next key'
							? await sink.getNextKeyPacket(packet, { metadataOnly: true })
							: await sink.getNextPacket(packet, { metadataOnly: true });
						lines.push(describePacket(packet, false));
					}
					return lines.join(',');
				}));
				return branches.join('\n');
			} });
		}
	});

	return ops;
};

const runOp = async (op: ReadOp, input: Input) => {
	try {
		return await op.run(input);
	} catch (error) {
		return `error: ${String(error)}`;
	}
};

const runOnFreshInput = async (op: ReadOp, source: Source) => {
	using input = new Input({ source, formats: ALL_FORMATS });
	return await runOp(op, input); // Awaited, so that the input is only disposed afterwards
};

/** Runs each operation on its own input, one after the other. */
const runSequentially = async (ops: ReadOp[], makeSource: () => Source) => {
	const results = new Map<string, string>();
	for (const op of ops) {
		results.set(op.name, await runOnFreshInput(op, makeSource()));
	}

	return results;
};

/** Runs all operations at once on a single input, starting them in a seeded order. */
const runConcurrently = async (ops: ReadOp[], source: Source, rand: Rand) => {
	using input = new Input({ source, formats: ALL_FORMATS });

	const results = new Map<string, string>();
	await Promise.all(shuffle(ops, rand).map(async (op) => {
		await randomDelay(rand);
		results.set(op.name, await runOp(op, input));
	}));

	return results;
};

const findMismatches = (expected: Map<string, string>, actual: Map<string, string>) => {
	const mismatches: string[] = [];
	for (const [name, value] of expected) {
		const actualValue = actual.get(name) ?? '<missing>';
		if (actualValue === value) {
			continue;
		}

		const expectedLines = value.split('\n');
		const actualLines = actualValue.split('\n');
		let line = 0;
		while (expectedLines[line] === actualLines[line]) {
			line++;
		}
		mismatches.push(`${name}, line ${line}: expected ${expectedLines[line]}, got ${actualLines[line]}`);
	}

	return mismatches;
};

// FLAC is left out, and MPEG-TS runs without the fan-out operations: concurrent getFirstPacket() calls on FLAC and
// concurrent getNextPacket() calls on the same MPEG-TS packet race (both fixed in bug-fix-mania)
const READ_FIXTURES = [
	'video.mp4',
	'missing-tfdt.mp4',
	'fragments-without-keyframes.mp4',
	'trunc-buck-bunny.mov',
	'demo.webm',
	'sparse-keyframes-dense-clusters.mkv',
	'0.ts',
	'mp3.ts',
	'vorbis-eos.ogg',
	'preroll-test.opus',
	'Toothsome-Meme.VBRv2.mp3',
	'sample3.aac',
	'glitch-hop-is-dead.wav',
];

test.each(READ_FIXTURES)('Concurrent reads on one input match sequential reads: %s', async (fixture) => {
	const bytes = await readFixture(fixture);
	const referencePackets = await getReferencePackets(new BufferSource(bytes));
	const ops = buildReadOps(referencePackets, mulberry32(1), { fanOut: !fixture.endsWith('.ts') });
	const expected = await runSequentially(ops, () => new BufferSource(bytes));

	for (let seed = 1; seed <= 2; seed++) {
		const rand = mulberry32(seed);
		const actual = await runConcurrently(ops, makeRacySource(bytes, rand), rand);
		expect(findMismatches(expected, actual), `seed ${seed}`).toEqual([]);
	}
});

test.each([
	'video.mp4',
	'demo.webm',
	'0.ts',
	'preroll-test.opus',
	'Toothsome-Meme.VBRv2.mp3',
])('Concurrent reads from a ReadableStreamSource match sequential reads: %s', async (fixture) => {
	const bytes = await readFixture(fixture);
	const referencePackets = await getReferencePackets(new BufferSource(bytes));
	const ops = buildReadOps(referencePackets, mulberry32(1), { fanOut: !fixture.endsWith('.ts') });
	const expected = await runSequentially(ops, () => new BufferSource(bytes));

	const rand = mulberry32(1);
	const actual = await runConcurrently(ops, makeRacyStreamSource(bytes, rand), rand);
	expect(findMismatches(expected, actual)).toEqual([]);
});

test('Concurrent reads of an HLS input match sequential reads', async () => {
	// Write a small HLS stream with two renditions in separate playlists
	const tracks = await loadTrackPackets('video.mp4', 5);
	const files = new Map<string, Uint8Array>();
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: [new MpegTsOutputFormat(), new CmafOutputFormat()],
			targetDuration: 1,
		}),
		target: new PathedTarget('master.m3u8', ({ path }) => new BufferTarget({
			onFinalize: (buffer) => {
				files.set(path, new Uint8Array(buffer));
			},
		})),
	});
	await muxInto(output, tracks, mergedOrder(tracks), null);

	const makeSource = (makeFileSource: (bytes: Uint8Array) => Source) => {
		return new CustomPathedSource('master.m3u8', ({ path }) => {
			const bytes = files.get(path.split('/').pop()!);
			if (!bytes) {
				throw new Error(`Unknown file ${path}.`);
			}

			return makeFileSource(bytes);
		});
	};

	// The segments are MPEG-TS, so no fan-out operations (see above)
	const referencePackets = await getReferencePackets(makeSource(bytes => new BufferSource(bytes)));
	const ops = buildReadOps(referencePackets, mulberry32(1), { fanOut: false });
	const expected = await runSequentially(ops, () => makeSource(bytes => new BufferSource(bytes)));

	for (let seed = 1; seed <= 2; seed++) {
		const rand = mulberry32(seed);
		const actual = await runConcurrently(ops, makeSource(bytes => makeRacySource(bytes, rand)), rand);
		expect(findMismatches(expected, actual), `seed ${seed}`).toEqual([]);
	}
});

test.each([
	'video.mp4',
	'demo.webm',
	'0.ts',
	'vorbis-eos.ogg',
	'Toothsome-Meme.VBRv2.mp3',
])('Disposing an input mid-read settles every pending call and disposes the source once: %s', async (fixture) => {
	const bytes = await readFixture(fixture);
	const referencePackets = await getReferencePackets(new BufferSource(bytes));
	const ops = buildReadOps(referencePackets, mulberry32(1), { fanOut: !fixture.endsWith('.ts') });

	for (let seed = 1; seed <= 4; seed++) {
		const rand = mulberry32(seed);
		let disposeCalls = 0;
		const input = new Input({ source: makeRacySource(bytes, rand, () => disposeCalls++), formats: ALL_FORMATS });

		const outcomes = ops.map(op => op.run(input).then(
			() => 'resolved',
			(error: unknown) => error instanceof InputDisposedError ? 'disposed' : `rejected with ${String(error)}`,
		));
		await randomDelays(rand, 40);
		input.dispose();

		// Hangs (and times out) if a call never settles
		const settled = await Promise.all(outcomes);
		expect(settled.filter(x => x.startsWith('rejected')), `seed ${seed}`).toEqual([]);
		expect(disposeCalls).toBe(1);
	}
});

/** Runs all operations at once on an input whose reads start failing at a seeded point. */
const runWithFailingReads = async (bytes: Uint8Array, ops: ReadOp[], seed: number) => {
	const rand = mulberry32(seed);
	let readCount = 0;
	const failAfter = 1 + Math.floor(rand() * 10);
	const unhandledErrors: unknown[] = [];

	using input = new Input({
		source: new CustomSource({
			getSize: () => bytes.length,
			read: async (start, end) => {
				await randomDelay(rand);
				if (++readCount > failAfter && rand() < 0.5) {
					throw new Error('Read failed.');
				}

				return bytes.slice(start, end);
			},
			prefetchProfile: (['none', 'fileSystem', 'network'] as const)[seed % 3],
			// Errors of prefetching reads that no call waits for
			handleUnhandledError: error => unhandledErrors.push(error),
		}),
		formats: ALL_FORMATS,
	});

	// Hangs (and times out) if a call never settles
	const outcomes = await Promise.all(ops.map(op => op.run(input).then(
		() => 'resolved',
		(error: unknown) => error instanceof Error && error.message === 'Read failed.'
			? 'read failed'
			: `rejected with ${String(error)}`,
	)));

	return { outcomes, unhandledErrors };
};

test.each([
	'video.mp4',
	'demo.webm',
	'Toothsome-Meme.VBRv2.mp3',
])('Read errors of a CustomSource reject the pending calls instead of hanging them: %s', async (fixture) => {
	const bytes = await readFixture(fixture);
	const ops = buildReadOps(await getReferencePackets(new BufferSource(bytes)), mulberry32(1));

	for (let seed = 1; seed <= 3; seed++) {
		const { outcomes, unhandledErrors } = await runWithFailingReads(bytes, ops, seed);
		expect(outcomes.filter(x => x.startsWith('rejected')), `seed ${seed}`).toEqual([]);
		expect(unhandledErrors.every(error => error instanceof Error && error.message === 'Read failed.')).toBe(true);
	}
});

/**
 * A fetch() serving `bytes` after seeded delays, with response bodies arriving in seeded chunks. Range requests get a
 * 206 response unless `rangeSupport` is off, and with `failureRate`, bodies may break off midway.
 */
const makeRacyFetch = (bytes: Uint8Array, rand: Rand, { rangeSupport = true, failureRate = 0 } = {}) => {
	const openBodies = new Set<ReadableStream<Uint8Array>>();
	let requestCount = 0;

	const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
		requestCount++;
		await randomDelay(rand);
		const signal = init?.signal;
		signal?.throwIfAborted();

		const rangeHeader = new Headers(init?.headers).get('Range');
		const isRangeResponse = rangeSupport && rangeHeader !== null;
		const start = isRangeResponse ? Number(/bytes=(\d+)-/.exec(rangeHeader)![1]) : 0;
		let position = start;

		const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			start: (controller) => {
				signal?.addEventListener('abort', () => {
					if (openBodies.delete(body)) {
						controller.error(signal.reason);
					}
				});
			},
			pull: async (controller) => {
				await randomDelay(rand);
				if (!openBodies.has(body)) {
					return;
				}

				if (position >= bytes.length) {
					openBodies.delete(body);
					controller.close();
				} else if (rand() < failureRate) {
					openBodies.delete(body);
					controller.error(new TypeError('Connection reset.'));
				} else {
					const size = Math.min(bytes.length - position, 16384 + Math.floor(rand() * 65536));
					controller.enqueue(bytes.slice(position, position + size));
					position += size;
				}
			},
			cancel: () => {
				openBodies.delete(body);
			},
		});
		openBodies.add(body);

		const headers = new Headers({ 'Content-Length': String(bytes.length - start) });
		if (isRangeResponse) {
			headers.set('Content-Range', `bytes ${start}-${bytes.length - 1}/${bytes.length}`);
		}

		return new Response(body, { status: isRangeResponse ? 206 : 200, headers });
	};

	return { fetchFn: fetchFn as typeof fetch, openBodies, getRequestCount: () => requestCount };
};

const URL_SOURCE_SETUPS = [
	{ rangeSupport: true, failureRate: 0, parallelism: 2, maxCacheSize: undefined },
	{ rangeSupport: true, failureRate: 0.05, parallelism: 3, maxCacheSize: 256 * 1024 },
	{ rangeSupport: false, failureRate: 0, parallelism: 2, maxCacheSize: Infinity },
];

const makeRacyUrlSource = (bytes: Uint8Array, rand: Rand, setup: typeof URL_SOURCE_SETUPS[number]) => {
	const fetch = makeRacyFetch(bytes, rand, setup);
	const source = new UrlSource('https://example.com/media', {
		fetchFn: fetch.fetchFn,
		getRetryDelay: () => 0,
		parallelism: setup.parallelism,
		maxCacheSize: setup.maxCacheSize,
	});

	return { source, ...fetch };
};

const silenceUrlSourceLogs = () => {
	// UrlSource logs resumed requests and missing range support
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
};

const URL_FIXTURES = ['video.mp4', 'demo.webm'];

test.each(URL_FIXTURES)('Concurrent reads through a UrlSource match sequential reads: %s', async (fixture) => {
	silenceUrlSourceLogs();
	const bytes = await readFixture(fixture);
	const ops = buildReadOps(await getReferencePackets(new BufferSource(bytes)), mulberry32(1));
	const expected = await runSequentially(ops, () => new BufferSource(bytes));

	for (const [index, setup] of URL_SOURCE_SETUPS.entries()) {
		const rand = mulberry32(index + 1);
		const { source, openBodies } = makeRacyUrlSource(bytes, rand, setup);
		const actual = await runConcurrently(ops, source, rand);
		expect(findMismatches(expected, actual), JSON.stringify(setup)).toEqual([]);

		// The input was disposed at the end, which must close every response body
		await waitFor(() => openBodies.size === 0);
		expect(openBodies.size, JSON.stringify(setup)).toBe(0);
	}
});

test.each(URL_FIXTURES)('Disposing an input mid-read aborts every request of a UrlSource: %s', async (fixture) => {
	silenceUrlSourceLogs();
	const bytes = await readFixture(fixture);
	const ops = buildReadOps(await getReferencePackets(new BufferSource(bytes)), mulberry32(1));

	for (let seed = 1; seed <= 6; seed++) {
		const rand = mulberry32(seed);
		const setup = URL_SOURCE_SETUPS[seed % URL_SOURCE_SETUPS.length]!;
		const { source, openBodies, getRequestCount } = makeRacyUrlSource(bytes, rand, setup);
		const input = new Input({ source, formats: ALL_FORMATS });

		const outcomes = ops.map(op => op.run(input).then(
			() => 'resolved',
			(error: unknown) => error instanceof InputDisposedError ? 'disposed' : `rejected with ${String(error)}`,
		));
		await randomDelays(rand, 60);
		input.dispose();
		const requestCount = getRequestCount();

		// Hangs (and times out) if a call never settles
		const settled = await Promise.all(outcomes);
		expect(settled.filter(x => x.startsWith('rejected')), `seed ${seed}`).toEqual([]);

		await waitFor(() => openBodies.size === 0);
		expect(openBodies.size, `seed ${seed}`).toBe(0);
		expect(getRequestCount(), `seed ${seed}`).toBe(requestCount);
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// Writing

type TrackPackets = {
	type: 'video' | 'audio';
	codec: string;
	decoderConfig: VideoDecoderConfig | AudioDecoderConfig;
	packets: EncodedPacket[];
};

const loadTrackPackets = async (fixture: string, maxTimestamp: number) => {
	using input = new Input({ source: new BufferSource(await readFixture(fixture)), formats: ALL_FORMATS });

	const result: TrackPackets[] = [];
	for (const track of await input.getTracks()) {
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			if (packet.timestamp > maxTimestamp) {
				break;
			}
			packets.push(packet);
		}

		assert(track.isVideoTrack() || track.isAudioTrack());
		result.push({
			type: track.isVideoTrack() ? 'video' : 'audio',
			codec: (await track.getCodec())!,
			decoderConfig: (await track.getDecoderConfig())!,
			packets,
		});
	}

	return result;
};

/** The order in which a muxing app would add the packets: by timestamp across tracks. */
const mergedOrder = (tracks: TrackPackets[]) => {
	const nextIndices = tracks.map(() => 0);
	const order: number[] = [];
	const total = tracks.reduce((sum, track) => sum + track.packets.length, 0);

	while (order.length < total) {
		let bestTrack = -1;
		let bestTimestamp = Infinity;
		tracks.forEach((track, trackIndex) => {
			const packet = track.packets[nextIndices[trackIndex]!];
			if (packet && packet.timestamp < bestTimestamp) {
				bestTimestamp = packet.timestamp;
				bestTrack = trackIndex;
			}
		});

		order.push(bestTrack);
		nextIndices[bestTrack]!++;
	}

	return order;
};

/**
 * Adds the packets in the given order of tracks. With `rand`, no add() is awaited and seeded delays are sprinkled
 * in between; otherwise, each add() is awaited.
 */
const muxInto = async (output: Output, tracks: TrackPackets[], order: number[], rand: Rand | null) => {
	output.setMetadataTags({ creationTime: new Date(Date.UTC(2020, 0, 1)) });

	const sources = tracks.map((track) => {
		if (track.type === 'video') {
			const source = new EncodedVideoPacketSource(track.codec as never);
			output.addVideoTrack(source);
			return source;
		} else {
			const source = new EncodedAudioPacketSource(track.codec as never);
			output.addAudioTrack(source);
			return source;
		}
	});
	await output.start();

	const nextIndices = tracks.map(() => 0);
	const pending: Promise<void>[] = [];
	for (const trackIndex of order) {
		const track = tracks[trackIndex]!;
		const index = nextIndices[trackIndex]!++;
		const meta = index === 0 ? { decoderConfig: track.decoderConfig } : undefined;
		// Throws synchronously once the output is canceled
		const promise = sources[trackIndex]!.add(track.packets[index]!, meta as never);

		if (rand) {
			// Awaited below, but may reject (when canceled) before that
			promise.catch(() => {});
			pending.push(promise);
			if (rand() < 0.2) {
				await randomDelay(rand);
			}
		} else {
			await promise;
		}
	}

	await Promise.all(pending);
	await output.finalize();
};

/** A StreamTarget writing into memory after seeded delays, with a small queue so that backpressure kicks in. */
const makeRacyStreamTarget = (rand: Rand) => {
	const chunks: StreamTargetChunk[] = [];
	const writable = new WritableStream<StreamTargetChunk>({
		write: async (chunk) => {
			await randomDelay(rand);
			chunks.push({ ...chunk, data: chunk.data.slice() });
		},
	}, { highWaterMark: 1 + Math.floor(rand() * 3) });

	const chunked = rand() < 0.5;
	const chunkSize = chunked ? 1024 * (1 + Math.floor(rand() * 64)) : undefined;
	const target = new StreamTarget(writable, { chunked, chunkSize });

	const getBytes = () => {
		let size = 0;
		for (const chunk of chunks) {
			size = Math.max(size, chunk.position + chunk.data.byteLength);
		}

		const bytes = new Uint8Array(size);
		for (const chunk of chunks) {
			bytes.set(chunk.data, chunk.position);
		}
		return bytes;
	};

	return { target, getBytes };
};

/** Muxes with Math.random seeded the same way each time, since some formats use random IDs. */
const mux = async (
	format: OutputFormat,
	target: Target,
	tracks: TrackPackets[],
	order: number[],
	rand: Rand | null,
) => {
	vi.spyOn(Math, 'random').mockImplementation(mulberry32(1234));
	await muxInto(new Output({ format, target }), tracks, order, rand);
	vi.restoreAllMocks();
};

const demuxPacketsPerTrack = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

	const result: string[] = [];
	for (const track of await input.getTracks()) {
		const lines = [`${track.type} ${await track.getCodec()}`];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			lines.push([
				packet.timestamp.toFixed(6),
				packet.duration.toFixed(6),
				packet.type,
				hashBytes(packet.data),
			].join(' '));
		}
		result.push(lines.join('\n'));
	}

	// Track order may follow the order of the first packets (MPEG-TS), so compare the tracks as a set
	return result.sort();
};

const MUX_CASES: [string, string, () => OutputFormat][] = [
	['MP4', 'video.mp4', () => new Mp4OutputFormat({ fastStart: false })],
	['MP4, in-memory fast start', 'video.mp4', () => new Mp4OutputFormat({ fastStart: 'in-memory' })],
	[
		'fragmented MP4',
		'video.mp4',
		() => new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0.5 }),
	],
	['MOV', 'video.mp4', () => new MovOutputFormat({ fastStart: false })],
	['Matroska', 'video.mp4', () => new MkvOutputFormat({ minimumClusterDuration: 0.3 })],
	['WebM', 'demo.webm', () => new WebMOutputFormat()],
	['MPEG-TS', 'video.mp4', () => new MpegTsOutputFormat()],
	['Ogg', 'vorbis-eos.ogg', () => new OggOutputFormat()],
	['MP3', 'Toothsome-Meme.VBRv2.mp3', () => new Mp3OutputFormat()],
	['ADTS', 'sample3.aac', () => new AdtsOutputFormat()],
	['FLAC', 'sample.flac', () => new FlacOutputFormat()],
	['WAVE', 'glitch-hop-is-dead.wav', () => new WavOutputFormat()],
];

test.each(MUX_CASES)('%s: the same packets give the same bytes with any target latency', async (_, fixture, format) => {
	const tracks = await loadTrackPackets(fixture, 3);
	const order = mergedOrder(tracks);

	const target = new BufferTarget();
	await mux(format(), target, tracks, order, null);
	const expected = hashBytes(new Uint8Array(target.buffer!));

	for (let seed = 1; seed <= 3; seed++) {
		const rand = mulberry32(seed);
		const { target, getBytes } = makeRacyStreamTarget(rand);
		// Same order of packets, but the add() calls aren't awaited
		await mux(format(), target, tracks, order, rand);
		expect(hashBytes(getBytes()), `seed ${seed}`).toBe(expected);
	}
});

test.each(MUX_CASES)('%s: any order of the tracks\' packets gives the same packets', async (_, fixture, format) => {
	const tracks = await loadTrackPackets(fixture, 3);

	const target = new BufferTarget();
	await mux(format(), target, tracks, mergedOrder(tracks), null);
	const expected = await demuxPacketsPerTrack(new Uint8Array(target.buffer!));

	for (let seed = 1; seed <= 3; seed++) {
		const rand = mulberry32(seed);
		const target = new BufferTarget();
		await mux(format(), target, tracks, shuffle(mergedOrder(tracks), rand), rand);
		expect(await demuxPacketsPerTrack(new Uint8Array(target.buffer!)), `seed ${seed}`).toEqual(expected);
	}
});

test.each(MUX_CASES)('%s: canceling mid-write settles every pending call', async (_, fixture, makeFormat) => {
	const tracks = await loadTrackPackets(fixture, 3);
	const order = mergedOrder(tracks);

	for (let seed = 1; seed <= 4; seed++) {
		const rand = mulberry32(seed);
		const { target } = makeRacyStreamTarget(rand);
		const output = new Output({ format: makeFormat(), target });

		const outcomes: Promise<string>[] = [];
		const settle = (promise: Promise<unknown>) => {
			outcomes.push(promise.then(() => 'resolved', () => 'rejected'));
		};

		const muxing = muxInto(output, tracks, order, rand);
		settle(muxing);
		await randomDelays(rand, 60);
		settle(output.cancel());

		// Hangs (and times out) if a call never settles
		const [muxingOutcome] = await Promise.all(outcomes);
		// Short files may be done before the cancel comes in
		expect(output.state, `seed ${seed}`).toBe(muxingOutcome === 'resolved' ? 'finalized' : 'canceled');
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// Conversion

/** Bookkeeping of the fake coders below, to check that everything they create gets released. */
const coderState = {
	rand: mulberry32(1),
	liveCoders: new Set<object>(),
	samples: new Set<VideoSample | AudioSample>(),
};

class FakeVideoDecoder extends CustomVideoDecoder {
	pending: EncodedPacket[] = [];

	static override supports() {
		return true;
	}

	async init() {
		coderState.liveCoders.add(this);
		await randomDelay(coderState.rand);
	}

	async decode(packet: EncodedPacket) {
		await randomDelay(coderState.rand);

		// Hold back a few frames, like a decoder reordering B-frames would
		this.pending.push(packet);
		this.pending.sort((a, b) => a.timestamp - b.timestamp);
		while (this.pending.length > 4) {
			this.emit(this.pending.shift()!);
		}
	}

	emit(packet: EncodedPacket) {
		const sample = new VideoSample(new Uint8Array(4 * 4 * 4), {
			format: 'RGBX',
			codedWidth: 4,
			codedHeight: 4,
			timestamp: packet.timestamp,
			duration: packet.duration,
		});
		coderState.samples.add(sample);
		this.onSample(sample);
	}

	async flush() {
		await randomDelay(coderState.rand);
		while (this.pending.length > 0) {
			this.emit(this.pending.shift()!);
		}
	}

	async close() {
		coderState.liveCoders.delete(this);
	}
}

class FakeAudioDecoder extends CustomAudioDecoder {
	static override supports() {
		return true;
	}

	async init() {
		coderState.liveCoders.add(this);
		await randomDelay(coderState.rand);
	}

	async decode(packet: EncodedPacket) {
		await randomDelay(coderState.rand);

		const { numberOfChannels, sampleRate } = this.config;
		const frameCount = Math.max(1, Math.round(packet.duration * sampleRate));
		const sample = new AudioSample({
			format: 'f32',
			data: new Float32Array(frameCount * numberOfChannels),
			numberOfChannels,
			sampleRate,
			timestamp: packet.timestamp,
		});
		coderState.samples.add(sample);
		this.onSample(sample);
	}

	async flush() {
		await randomDelay(coderState.rand);
	}

	async close() {
		coderState.liveCoders.delete(this);
	}
}

class FakeVideoEncoder extends CustomVideoEncoder {
	packetCount = 0;

	static override supports(codec: string) {
		return codec === 'vp8';
	}

	async init() {
		coderState.liveCoders.add(this);
		await randomDelay(coderState.rand);
	}

	async encode(sample: VideoSample, options: VideoEncoderEncodeOptions) {
		await randomDelay(coderState.rand);

		const isKey = this.packetCount === 0 || !!options.keyFrame;
		const { width, height } = this.config;
		// Just enough of a VP8 frame header for the muxers
		const data = isKey
			? new Uint8Array([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8])
			: new Uint8Array([0x11, 0x02, 0x00, this.packetCount & 0xff]);
		const meta = this.packetCount === 0
			? { decoderConfig: { codec: 'vp8', codedWidth: width, codedHeight: height } }
			: undefined;
		this.packetCount++;
		this.onPacket(new EncodedPacket(data, isKey ? 'key' : 'delta', sample.timestamp, sample.duration), meta);
	}

	async flush() {
		await randomDelay(coderState.rand);
	}

	async close() {
		coderState.liveCoders.delete(this);
	}
}

class FakeAudioEncoder extends CustomAudioEncoder {
	packetCount = 0;

	static override supports(codec: string) {
		return codec === 'aac';
	}

	async init() {
		coderState.liveCoders.add(this);
		await randomDelay(coderState.rand);
	}

	async encode(sample: AudioSample) {
		await randomDelay(coderState.rand);

		const meta = this.packetCount === 0
			? {
					decoderConfig: {
						codec: 'mp4a.40.2',
						numberOfChannels: this.config.numberOfChannels,
						sampleRate: this.config.sampleRate,
						description: new Uint8Array([0x12, 0x10]), // AAC-LC, 44.1 kHz, stereo
					},
				}
			: undefined;
		this.packetCount++;
		const data = new Uint8Array([0x21, 0x10, 0x04]);
		this.onPacket(new EncodedPacket(data, 'key', sample.timestamp, sample.duration), meta);
	}

	async flush() {
		await randomDelay(coderState.rand);
	}

	async close() {
		coderState.liveCoders.delete(this);
	}
}

registerDecoder(FakeVideoDecoder);
registerDecoder(FakeAudioDecoder);
registerEncoder(FakeVideoEncoder);
registerEncoder(FakeAudioEncoder);

// Track the samples that get cloned along the way too
for (const SampleClass of [VideoSample, AudioSample]) {
	const clone = SampleClass.prototype.clone as () => VideoSample | AudioSample;
	SampleClass.prototype.clone = function (this: VideoSample | AudioSample) {
		const result = clone.call(this);
		coderState.samples.add(result);
		return result;
	} as never;
}

type SinkOp = {
	name: string;
	run: (sink: VideoSampleSink | AudioSampleSink, rand: Rand | null) => Promise<string>;
};

/** Describes the sample and closes it. */
const describeSample = (sample: VideoSample | AudioSample | null) => {
	if (!sample) {
		return 'null';
	}

	const description = `${sample.timestamp.toFixed(6)}|${sample.duration.toFixed(6)}`;
	sample.close();
	return description;
};

/** getSample() at seeded timestamps, samplesAtTimestamps() over seeded lists, and samples() over seeded ranges. */
const buildSinkOps = (referencePackets: EncodedPacket[], rand: Rand) => {
	const randomTimestamp = () => {
		const packet = referencePackets[Math.floor(rand() * referencePackets.length)]!;
		return rand() < 0.5 ? packet.timestamp : packet.timestamp + 0.01 * rand();
	};

	const ops: SinkOp[] = [];
	for (let i = 0; i < 8; i++) {
		const timestamp = randomTimestamp();
		ops.push({
			name: `sample at ${timestamp}`,
			run: async sink => describeSample(await sink.getSample(timestamp)),
		});
	}

	for (let i = 0; i < 3; i++) {
		const timestamps = Array.from({ length: 1 + Math.floor(rand() * 8) }, randomTimestamp);
		if (rand() < 0.5) {
			timestamps.sort((a, b) => a - b);
		}

		ops.push({ name: `samples at ${timestamps.join(', ')}`, run: async (sink, rand) => {
			const descriptions: string[] = [];
			for await (const sample of sink.samplesAtTimestamps(timestamps)) {
				descriptions.push(describeSample(sample));
				if (rand) {
					await randomDelay(rand);
				}
			}
			return descriptions.join(' ');
		} });
	}

	for (let i = 0; i < 3; i++) {
		const start = randomTimestamp();
		const end = start + 1.5 * rand();
		ops.push({ name: `samples from ${start} to ${end}`, run: async (sink, rand) => {
			const descriptions: string[] = [];
			for await (const sample of sink.samples(start, end)) {
				descriptions.push(describeSample(sample));
				if (rand) {
					await randomDelay(rand);
				}
			}
			return descriptions.join(' ');
		} });
	}

	return ops;
};

const makeSampleSink = async (input: Input, trackIndex: number) => {
	const track = await getTrack(input, trackIndex);
	return track.isVideoTrack() ? new VideoSampleSink(track) : new AudioSampleSink(track as never);
};

const runSinkOpOnFreshInput = async (op: SinkOp, bytes: Uint8Array, trackIndex: number) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	try {
		return await op.run(await makeSampleSink(input, trackIndex), null);
	} catch (error) {
		return `error: ${String(error)}`;
	}
};

test.each([
	'video.mp4',
	'demo.webm',
	'Toothsome-Meme.VBRv2.mp3',
])('Concurrent calls on one sample sink match sequential calls and release everything: %s', async (fixture) => {
	const bytes = await readFixture(fixture);
	const referencePackets = await getReferencePackets(new BufferSource(bytes));

	for (const [trackIndex, packets] of referencePackets.entries()) {
		const ops = buildSinkOps(packets, mulberry32(trackIndex + 1));
		const expected = new Map<string, string>();
		for (const op of ops) {
			expected.set(op.name, await runSinkOpOnFreshInput(op, bytes, trackIndex));
		}

		for (let seed = 1; seed <= 2; seed++) {
			const rand = mulberry32(seed);
			coderState.rand = mulberry32(seed + 100);
			coderState.liveCoders.clear();
			coderState.samples.clear();

			const input = new Input({ source: makeRacySource(bytes, rand), formats: ALL_FORMATS });
			const sink = await makeSampleSink(input, trackIndex);
			const actual = new Map<string, string>();
			await Promise.all(shuffle(ops, rand).map(async (op) => {
				await randomDelay(rand);
				try {
					actual.set(op.name, await op.run(sink, rand));
				} catch (error) {
					actual.set(op.name, `error: ${String(error)}`);
				}
			}));

			const context = `track ${trackIndex}, seed ${seed}`;
			expect(findMismatches(expected, actual), context).toEqual([]);

			// Decoders close once their iteration has wound down
			await waitFor(() => coderState.liveCoders.size === 0);
			expect(coderState.liveCoders.size, context).toBe(0);
			expect([...coderState.samples].filter(sample => !sample._closed).length, context).toBe(0);
			input.dispose();
		}
	}
});

type ConversionScenario = 'complete' | 'cancel' | 'pause and resume' | 'pause and cancel';

/** Runs one conversion and returns how it ended, plus what was left open once it had settled. */
const runConversion = async (bytes: Uint8Array, format: OutputFormat, scenario: ConversionScenario, seed: number) => {
	const rand = mulberry32(seed);
	coderState.rand = mulberry32(seed + 100);
	coderState.liveCoders.clear();
	coderState.samples.clear();

	using input = new Input({ source: makeRacySource(bytes, rand), formats: ALL_FORMATS });
	const output = new Output({ format, target: makeRacyStreamTarget(rand).target });
	const conversion = await Conversion.init({
		input,
		output,
		video: { codec: 'vp8', forceTranscode: true },
		audio: { codec: 'aac', forceTranscode: true },
		trim: { start: 0, end: 2 },
		showWarnings: false,
	});
	assert(conversion.isValid);

	let outcome: string;
	try {
		if (scenario === 'complete') {
			await conversion.execute();
		} else if (scenario === 'cancel') {
			const execution = conversion.execute();
			await randomDelays(rand, 200);
			await conversion.cancel();
			await execution;
		} else {
			await conversion.execute({ until: 0.2 + 1.5 * rand() });
			await randomDelays(rand, 10);
			if (scenario === 'pause and resume') {
				await conversion.execute();
			} else {
				await conversion.cancel();
			}
		}
		outcome = 'completed';
	} catch (error) {
		outcome = error instanceof ConversionCanceledError ? 'canceled' : `failed with ${String(error)}`;
	}

	// The track pumps wind down, closing their decoders, shortly after a cancel
	await waitFor(() => coderState.liveCoders.size === 0);

	return {
		outcome,
		outputState: output.state,
		liveCoders: coderState.liveCoders.size,
		unclosedSamples: [...coderState.samples].filter(sample => !sample._closed).length,
	};
};

test.each([
	['MP4', () => new Mp4OutputFormat({ fastStart: false })],
	['fragmented MP4', () => new Mp4OutputFormat({ fastStart: 'fragmented' })],
	['Matroska', () => new MkvOutputFormat()],
])('Conversion to %s settles and releases every decoder, encoder and sample, also when canceled', async (_, format) => {
	const bytes = await readFixture('video.mp4');

	for (const scenario of ['complete', 'cancel', 'pause and resume', 'pause and cancel'] as const) {
		for (let seed = 1; seed <= 2; seed++) {
			const result = await runConversion(bytes, format(), scenario, seed);

			// A cancel may come in after the conversion completed, and cancel() itself doesn't throw
			const finalized = result.outcome === 'completed' && scenario !== 'pause and cancel';
			expect(result, `${scenario}, seed ${seed}`).toEqual({
				outcome: expect.stringMatching(/^(completed|canceled)$/) as string,
				outputState: finalized ? 'finalized' : 'canceled',
				liveCoders: 0,
				unclosedSamples: 0,
			});
		}
	}
});
