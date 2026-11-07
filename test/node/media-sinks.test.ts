import { expect, test, vi } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { countMovedArrayElements } from './array-moves.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 200k minimal ADTS frames (77 min at 44.1 kHz)
const createAdtsFile = (frameCount: number) => {
	const frame = [0xff, 0xf1, 0x50, 0x80, 0x01, 0x1f, 0xfc, 0x00];
	const file = new Uint8Array(frame.length * frameCount);
	for (let i = 0; i < frameCount; i++) {
		file.set(frame, i * frame.length);
	}

	return file;
};

test('packets() keeps a constant cost per packet for consumers dequeuing over 100k packets per second', async () => {
	const count = 200_000;

	// The iterator remembers when each packet was dequeued during the last second. With a clock advancing 10 µs per
	// call, that's 100k packets, which used to be evicted one by one with Array.prototype.shift(), copying the array.
	let now = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => now += 0.01);

	using input = new Input({ source: new BufferSource(createAdtsFile(count)), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	expect(track).not.toBeNull();

	const sink = new EncodedPacketSink(track!);
	let packetCount = 0;
	const movedElements = await countMovedArrayElements(async () => {
		for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
			void packet;
			packetCount++;
		}
	});

	expect(packetCount).toBe(count);
	// Linear: each entry is moved at most about once (main moved ~1e10)
	expect(movedElements).toBeLessThan(2 * count);
});

test('packets() keeps a constant cost per packet when its queue runs far ahead', async () => {
	const count = 200_000;

	// With a frozen clock, all packets dequeued so far count as the last second's, which is how many the iterator
	// queues ahead
	vi.spyOn(performance, 'now').mockReturnValue(0);

	using input = new Input({ source: new BufferSource(createAdtsFile(count)), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	expect(track).not.toBeNull();
	const packets = new EncodedPacketSink(track!).packets(undefined, undefined, { metadataOnly: true });

	let packetCount = 0;
	const movedElements = await countMovedArrayElements(async () => {
		for (; packetCount < count / 2; packetCount++) {
			await packets.next();
		}

		// A consumer that awaits something (like a muxer waiting on its writer) lets the iterator fill its queue, whose
		// packets were taken off with Array.prototype.shift(), copying the whole queue each time
		await new Promise(resolve => setTimeout(resolve, 200));

		while (!(await packets.next()).done) {
			packetCount++;
		}
	});

	expect(packetCount).toBe(count);
	// Linear: each entry is moved at most about once (main moved ~5e9)
	expect(movedElements).toBeLessThan(2 * count);
});

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
