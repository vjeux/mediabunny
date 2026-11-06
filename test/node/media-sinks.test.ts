import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { mapAsyncGenerator } from '../../src/misc.js';

const readOneValueThenDispose = async (iterator: AsyncGenerator<unknown, void, unknown>) => {
	// AsyncGenerator is AsyncDisposable in TypeScript's esnext lib, which this project doesn't use
	await using disposable = iterator as AsyncGenerator<unknown, void, unknown> & AsyncDisposable;
	const result = await disposable.next();
	expect(result.done).toBe(false);
	(result.value as { close?: () => void }).close?.();
};

test('Sink iterators end when disposed with await using, like native async generators', async () => {
	using input = new Input({
		source: new FilePathSource('./test/public/glitch-hop-is-dead.wav'),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	const sampleSink = new AudioSampleSink(track);

	const iterators: AsyncGenerator<unknown, void, unknown>[] = [
		new EncodedPacketSink(track).packets(),
		sampleSink.samples(),
		sampleSink.samplesAtTimestamps([0, 0.5, 1]),
		// What CanvasSink and AudioBufferSink return
		mapAsyncGenerator(new EncodedPacketSink(track).packets(), packet => packet.timestamp),
	];

	for (const iterator of iterators) {
		await readOneValueThenDispose(iterator);
		expect(await iterator.next()).toEqual({ value: undefined, done: true });
	}
});
