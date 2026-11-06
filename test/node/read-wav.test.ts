import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, AudioSampleSink, EncodedPacketSink, Input, FilePathSource } from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Should handle WAV file with oversized ID3 chunk', async () => {
	const filePath = path.join(__dirname, '..', 'public/oversized-id3.wav');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track found');
	}

	const sink = new EncodedPacketSink(track);

	for await (const packet of sink.packets()) {
		void packet;
	}
});

test('samplesAtTimestamps rejects non-iterable timestamps with a TypeError', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav')),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	const sink = new AudioSampleSink(track!);

	for (const timestamps of [null, undefined, 5, 'timestamps', () => [0]]) {
		expect(() => sink.samplesAtTimestamps(timestamps as never)).toThrow(
			new TypeError('Argument must be an iterable or async iterable.'),
		);
	}

	// Any object or function with an iterator is fine, as before
	const iterableFunction = Object.assign(() => {}, { [Symbol.iterator]: () => [0][Symbol.iterator]() });
	const asyncIterableFunction = Object.assign(() => {}, {
		[Symbol.asyncIterator]: async function* () {
			yield 0;
		},
	});
	for (const timestamps of [[0], new Set([0]), iterableFunction, asyncIterableFunction]) {
		const samples: number[] = [];
		for await (const sample of sink.samplesAtTimestamps(timestamps)) {
			samples.push(sample!.timestamp);
			sample!.close();
		}
		expect(samples).toEqual([0]);
	}
});
