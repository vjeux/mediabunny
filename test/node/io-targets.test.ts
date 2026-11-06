import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writer } from '../../src/writer.js';
import {
	AppendOnlyStreamTarget,
	AudioSample,
	AudioSampleSource,
	BufferTarget,
	FilePathTarget,
	MkvOutputFormat,
	Mp4OutputFormat,
	NullTarget,
	Output,
	OutputFormat,
	StreamTarget,
	StreamTargetChunk,
	Target,
	WavOutputFormat,
} from '../../src/index.js';
import { bytesEqual, createRandom } from './helpers/io-random.js';

type WriteOp = { kind: 'write'; position: number; data: Uint8Array } | { kind: 'flush' };

/** Generates a deterministic sequence of writes (with seeks and gaps unless monotonic) and flushes. */
const createWriteOps = (seed: number, monotonic: boolean) => {
	const random = createRandom(seed);
	const ops: WriteOp[] = [];
	let position = 0;
	const count = 40 + ((random() * 120) | 0);

	for (let i = 0; i < count; i++) {
		const roll = random();
		if (roll < 0.15) {
			ops.push({ kind: 'flush' });
			continue;
		}

		if (!monotonic && roll < 0.35) {
			position = (random() * (position + 1)) | 0; // Seek back, like patching a header
		} else if (!monotonic && roll < 0.4) {
			position += (random() * 5000) | 0; // Seek forward, leaving a gap
		}

		const length = random() < 0.1 ? 0 : 1 + ((random() * (random() < 0.3 ? 70_000 : 300)) | 0);
		const data = new Uint8Array(length);
		for (let k = 0; k < length; k++) {
			data[k] = (random() * 256) | 0;
		}

		ops.push({ kind: 'write', position, data });
		position += length;
	}

	return ops;
};

const expectedBytes = (ops: WriteOp[]) => {
	let size = 0;
	for (const op of ops) {
		if (op.kind === 'write') {
			size = Math.max(size, op.position + op.data.length);
		}
	}

	const bytes = new Uint8Array(size);
	for (const op of ops) {
		if (op.kind === 'write') {
			bytes.set(op.data, op.position);
		}
	}

	return bytes;
};

const runWriteOps = async (target: Target, ops: WriteOp[], monotonic: boolean) => {
	const writer = new Writer(target, monotonic);
	writer.start();
	for (const op of ops) {
		if (op.kind === 'flush') {
			await writer.flush();
		} else {
			writer.seek(op.position);
			writer.write(op.data);
		}
	}
	await writer.flush();
	await writer.finalize();
};

/** A WritableStream that records StreamTargetChunks and can assemble them into the final file. */
const createRecordingStream = (options: { delayMs?: number; failOnWrite?: number } = {}) => {
	const writes: { position: number; data: Uint8Array }[] = [];
	let closeCount = 0;

	const stream = new WritableStream<StreamTargetChunk>({
		write: async (chunk) => {
			if (options.failOnWrite !== undefined && writes.length === options.failOnWrite) {
				throw new Error('Disk full');
			}
			if (options.delayMs) {
				await new Promise(resolve => setTimeout(resolve, options.delayMs));
			}
			expect(chunk.type).toBe('write');
			writes.push({ position: chunk.position, data: chunk.data.slice() });
		},
		close: () => {
			closeCount++;
		},
	}, { highWaterMark: 1 });

	return {
		stream,
		writes,
		closeCount: () => closeCount,
		assemble: () => {
			let size = 0;
			for (const write of writes) {
				size = Math.max(size, write.position + write.data.length);
			}
			const bytes = new Uint8Array(size);
			for (const write of writes) {
				bytes.set(write.data, write.position);
			}
			return bytes;
		},
	};
};

/** Muxes one second of mono 48 kHz PCM into the given output, with a fixed creation time for reproducible bytes. */
const writePcmOutput = async (output: Output) => {
	output.setMetadataTags({ creationTime: new Date('2020-01-01T00:00:00Z') });
	const source = new AudioSampleSource({ codec: 'pcm-s16' });
	output.addAudioTrack(source);
	await output.start();

	for (let i = 0; i < 10; i++) {
		const data = new Float32Array(4800);
		for (let k = 0; k < data.length; k++) {
			data[k] = Math.sin((i * 4800 + k) / 10);
		}
		await source.add(new AudioSample({
			data,
			format: 'f32',
			numberOfChannels: 1,
			sampleRate: 48000,
			timestamp: i * 0.1,
		}));
	}

	await output.finalize();
};

const formats: [string, () => OutputFormat][] = [
	// The default fastStart depends on the target type, so it's pinned here
	['MP4', () => new Mp4OutputFormat({ fastStart: false })],
	['MP4 (fast start, in memory)', () => new Mp4OutputFormat({ fastStart: 'in-memory' })],
	['MP4 (fragmented)', () => new Mp4OutputFormat({ fastStart: 'fragmented' })],
	['MKV', () => new MkvOutputFormat()],
	['WAVE', () => new WavOutputFormat()],
];

describe('Writer and targets, randomized', () => {
	test('BufferTarget and StreamTarget (chunked and not) end up with the same bytes as the writes', async () => {
		for (let seed = 1; seed <= 40; seed++) {
			for (const monotonic of [false, true]) {
				const ops = createWriteOps(seed, monotonic);
				const expected = expectedBytes(ops);

				const bufferTarget = new BufferTarget();
				await runWriteOps(bufferTarget, ops, monotonic);
				expect(bytesEqual(new Uint8Array(bufferTarget.buffer!), expected)).toBe(true);

				for (const options of [{}, { chunked: true, chunkSize: 1024 }, { chunked: true, chunkSize: 65536 }]) {
					const recording = createRecordingStream();
					await runWriteOps(new StreamTarget(recording.stream, options), ops, monotonic);
					expect(bytesEqual(recording.assemble(), expected)).toBe(true);
					expect(recording.closeCount()).toBe(1);

					if (monotonic) {
						// Monotonic writes must reach the stream strictly in order
						let next = 0;
						for (const write of recording.writes) {
							expect(write.position).toBe(next);
							next += write.data.length;
						}
					}
				}
			}
		}
	}, 30_000);

	test('a target can only have one writer', () => {
		const target = new BufferTarget();
		void new Writer(target, false);
		expect(() => new Writer(target, false)).toThrow('Can\'t have multiple Writers for the same Target.');
	});
});

describe('BufferTarget', () => {
	test('grows past its initial size, zero-fills gaps and ends exactly at the last written byte', async () => {
		const target = new BufferTarget();
		const writer = new Writer(target, false);
		writer.start();
		writer.seek(200_000);
		writer.write(new Uint8Array([1, 2, 3]));
		writer.seek(10);
		writer.write(new Uint8Array([9]));
		await writer.flush();

		expect(target.buffer).toBeNull(); // Only available once finalized
		await writer.finalize();

		const bytes = new Uint8Array(target.buffer!);
		expect(bytes.length).toBe(200_003);
		expect(bytes[10]).toBe(9);
		expect([...bytes.subarray(200_000)]).toEqual([1, 2, 3]);
		expect(bytes.subarray(11, 200_000).every(x => x === 0)).toBe(true);
	});

	test('emits write events for every write and finalized once', async () => {
		const target = new BufferTarget();
		const writes: [number, number][] = [];
		const finalized = vi.fn();
		target.on('write', ({ start, end }) => writes.push([start, end]));
		target.on('finalized', finalized);

		const writer = new Writer(target, false);
		writer.start();
		writer.write(new Uint8Array(5));
		writer.seek(2);
		writer.write(new Uint8Array(10));
		await writer.finalize();

		expect(writes).toEqual([[0, 5], [2, 12]]);
		expect(finalized).toHaveBeenCalledTimes(1);
	});

	test('validates its options', () => {
		expect(() => new BufferTarget(null as never)).toThrow(
			new TypeError('BufferTarget options, when provided, must be an object.'),
		);
		expect(() => new BufferTarget({ onFinalize: 1 as never })).toThrow(
			new TypeError('options.onFinalize, when provided, must be a function.'),
		);
	});
});

describe('StreamTarget', () => {
	test('in chunked mode, writes full chunks that never straddle a chunk boundary', async () => {
		const recording = createRecordingStream();
		const output = new Output({
			format: new WavOutputFormat(),
			target: new StreamTarget(recording.stream, { chunked: true, chunkSize: 4096 }),
		});
		await writePcmOutput(output);

		const fileSize = recording.assemble().length;
		for (const write of recording.writes) {
			const chunkStart = Math.floor(write.position / 4096) * 4096;
			expect(write.position + write.data.length).toBeLessThanOrEqual(chunkStart + 4096);
		}
		// All but the writes touching the last chunk, plus the patched header, are full chunks
		const fullChunks = recording.writes.filter(write => write.data.length === 4096);
		expect(fullChunks.length).toBeGreaterThanOrEqual(Math.floor(fileSize / 4096) - 1);
	});

	test('respects backpressure from a slow stream without losing data', async () => {
		const reference = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		await writePcmOutput(reference);

		const recording = createRecordingStream({ delayMs: 2 });
		const output = new Output({ format: new MkvOutputFormat(), target: new StreamTarget(recording.stream) });
		await writePcmOutput(output);

		expect(bytesEqual(recording.assemble(), new Uint8Array(reference.target.buffer!))).toBe(true);
		expect(recording.closeCount()).toBe(1);
	});

	test('surfaces stream write errors from finalize', async () => {
		const recording = createRecordingStream({ failOnWrite: 1 });
		const output = new Output({ format: new MkvOutputFormat(), target: new StreamTarget(recording.stream) });
		await expect(writePcmOutput(output)).rejects.toThrow('Disk full');
	});

	test('validates its arguments', () => {
		const stream = new WritableStream<StreamTargetChunk>();
		expect(() => new StreamTarget({} as never)).toThrow(
			new TypeError('StreamTarget requires a WritableStream instance.'),
		);
		expect(() => new StreamTarget(stream, { chunked: 'yes' as never })).toThrow(
			new TypeError('options.chunked, when provided, must be a boolean.'),
		);
		for (const chunkSize of [1023, 2048.5, -1]) {
			expect(() => new StreamTarget(stream, { chunked: true, chunkSize })).toThrow(
				new TypeError('options.chunkSize, when provided, must be an integer and not smaller than 1024.'),
			);
		}
		expect(() => new StreamTarget(stream, { chunked: true, chunkSize: 1024 })).not.toThrow();
	});
});

describe('Targets produce identical files', () => {
	test.each(formats)('%s: StreamTarget, chunked StreamTarget and FilePathTarget match BufferTarget', async (
		_,
		format,
	) => {
		const reference = new Output({ format: format(), target: new BufferTarget() });
		await writePcmOutput(reference);
		const expected = new Uint8Array(reference.target.buffer!);

		const plain = createRecordingStream();
		await writePcmOutput(new Output({ format: format(), target: new StreamTarget(plain.stream) }));
		expect(bytesEqual(plain.assemble(), expected)).toBe(true);

		const chunked = createRecordingStream();
		await writePcmOutput(new Output({
			format: format(),
			target: new StreamTarget(chunked.stream, { chunked: true, chunkSize: 2048 }),
		}));
		expect(bytesEqual(chunked.assemble(), expected)).toBe(true);

		const filePath = path.join(os.tmpdir(), `mediabunny-io-targets-${process.pid}-${Math.random()}.bin`);
		try {
			const target = new FilePathTarget(filePath, { chunkSize: 4096 });
			await writePcmOutput(new Output({ format: format(), target }));
			expect(bytesEqual(new Uint8Array(fs.readFileSync(filePath)), expected)).toBe(true);
		} finally {
			fs.rmSync(filePath, { force: true });
		}
	});

	test('NullTarget reports the same write ranges as BufferTarget', async () => {
		const bufferTarget = new BufferTarget();
		const nullTarget = new NullTarget();
		const bufferWrites: [number, number][] = [];
		const nullWrites: [number, number][] = [];
		bufferTarget.on('write', ({ start, end }) => bufferWrites.push([start, end]));
		nullTarget.on('write', ({ start, end }) => nullWrites.push([start, end]));

		await writePcmOutput(new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: bufferTarget }));
		await writePcmOutput(new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: nullTarget }));

		expect(nullWrites).toEqual(bufferWrites);
		expect(Math.max(...nullWrites.map(x => x[1]))).toBe(bufferTarget.buffer!.byteLength);
	});
});

describe('AppendOnlyStreamTarget', () => {
	const collect = () => {
		const chunks: Uint8Array[] = [];
		const stream = new WritableStream<Uint8Array>({
			write: (chunk) => {
				chunks.push(chunk.slice());
			},
		});
		return {
			stream,
			bytes: () => {
				const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
				const result = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) {
					result.set(chunk, offset);
					offset += chunk.length;
				}
				return result;
			},
		};
	};

	test.each([
		['MKV (append-only)', () => new MkvOutputFormat({ appendOnly: true })],
		['MP4 (fragmented)', () => new Mp4OutputFormat({ fastStart: 'fragmented' })],
	] as [string, () => OutputFormat][])('%s: produces the same bytes as BufferTarget', async (_, format) => {
		const reference = new Output({ format: format(), target: new BufferTarget() });
		await writePcmOutput(reference);

		const collected = collect();
		await writePcmOutput(new Output({ format: format(), target: new AppendOnlyStreamTarget(collected.stream) }));

		expect(bytesEqual(collected.bytes(), new Uint8Array(reference.target.buffer!))).toBe(true);
	});

	test('refuses formats that seek back', async () => {
		const collected = collect();
		const target = new AppendOnlyStreamTarget(collected.stream);
		const output = new Output({ format: new WavOutputFormat(), target });
		await expect(writePcmOutput(output)).rejects.toThrow(
			'AppendOnlyStreamTarget requires that data be written monotonically',
		);
	});
});

describe('Target.slice (RangedTarget)', () => {
	test('validates the offset', () => {
		const target = new BufferTarget();
		expect(() => target.slice(-1)).toThrow(new TypeError('offset must be a non-negative integer.'));
		expect(() => target.slice(0.5)).toThrow(new TypeError('offset must be a non-negative integer.'));
	});

	test('writes into the base target at its offset and reports writes in its own coordinates', async () => {
		const base = new BufferTarget();
		const baseWrites: [number, number][] = [];
		base.on('write', ({ start, end }) => baseWrites.push([start, end]));

		const slice = base.slice(4);
		const writes: [number, number][] = [];
		slice.on('write', ({ start, end }) => writes.push([start, end]));
		const sliceWriter = new Writer(slice, false);
		sliceWriter.start();
		sliceWriter.write(new Uint8Array([5, 6]));
		sliceWriter.seek(0);
		sliceWriter.write(new Uint8Array([7]));
		await sliceWriter.finalize();

		expect(writes).toEqual([[0, 2], [0, 1]]);
		expect(baseWrites).toEqual([[4, 6], [4, 5]]);
	});
});
