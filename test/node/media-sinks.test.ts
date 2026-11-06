import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('throw() on the packets() iterator ends the iteration', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	const iterator = new EncodedPacketSink(track!).packets();

	expect((await iterator.next()).done).toBe(false);
	await expect(iterator.throw(new Error('Stop'))).rejects.toThrow('Stop');

	// Like for a generator function, the iterator is done after the throw
	expect(await iterator.next()).toEqual({ value: undefined, done: true });
});
