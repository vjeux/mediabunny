import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input, UnsupportedInputFormatError } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { BufferSource } from '../../src/source.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Disposing after failed format detection does not emit an unhandled rejection', async () => {
	const input = new Input({
		source: new BufferSource(new Uint8Array([1, 2, 3, 4])),
		formats: ALL_FORMATS,
	});

	await expect(input.getFormat()).rejects.toThrow(UnsupportedInputFormatError);

	const unhandledRejections: unknown[] = [];
	const onUnhandledRejection = (reason: unknown) => {
		unhandledRejections.push(reason);
	};

	process.on('unhandledRejection', onUnhandledRejection);
	try {
		input.dispose();
		await new Promise(resolve => setTimeout(resolve, 0));
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	expect(unhandledRejections).toEqual([]);
});

/** Calls next() once per microtask until the first call resolves, like several consumers pulling at once. */
const pullConcurrently = async <T extends { timestamp: number }>(iterator: AsyncGenerator<T, void, unknown>) => {
	const calls = [iterator.next()];
	let firstCallResolved = false;
	void calls[0]!.then(() => {
		firstCallResolved = true;
	});

	while (!firstCallResolved && calls.length < 40) {
		await Promise.resolve();
		calls.push(iterator.next());
	}

	const results = await Promise.all(calls);
	await iterator.return();
	return results.map(result => result.done ? null : result.value.timestamp);
};

const pullSequentially = async <T extends { timestamp: number }>(
	iterator: AsyncGenerator<T, void, unknown>,
	count: number,
) => {
	const timestamps: (number | null)[] = [];
	for (let i = 0; i < count; i++) {
		const result = await iterator.next();
		timestamps.push(result.done ? null : result.value.timestamp);
	}
	await iterator.return();
	return timestamps;
};

test('Concurrent next() calls on a packets() iterator get the packets in order', async () => {
	using input = new Input({
		source: new BufferSource(await readFile(path.join(__dirname, '../public/video.mp4'))),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);

	const timestamps = await pullConcurrently(sink.packets());
	expect(timestamps).toEqual(await pullSequentially(sink.packets(), timestamps.length));
});

test('Concurrent next() calls on a samples() iterator get the samples in order', async () => {
	using input = new Input({
		source: new BufferSource(await readFile(path.join(__dirname, '../public/glitch-hop-is-dead.wav'))),
		formats: ALL_FORMATS,
	});
	const sink = new AudioSampleSink((await input.getPrimaryAudioTrack())!);

	const timestamps = await pullConcurrently(sink.samples());
	expect(timestamps).toEqual(await pullSequentially(sink.samples(), timestamps.length));
});
