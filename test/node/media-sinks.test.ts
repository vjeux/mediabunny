import { expect, test, vi } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { BufferSource } from '../../src/source.js';

test('packets() keeps a constant cost per packet for consumers dequeuing over 100k packets per second', async () => {
	// 200k minimal ADTS frames (77 min at 44.1 kHz)
	const frame = [0xff, 0xf1, 0x50, 0x80, 0x01, 0x1f, 0xfc, 0x00];
	const count = 200_000;
	const file = new Uint8Array(frame.length * count);
	for (let i = 0; i < count; i++) {
		file.set(frame, i * frame.length);
	}

	// The iterator remembers when each packet was dequeued during the last second. With a clock advancing 10 µs per
	// call, that's 100k packets, which used to be evicted one by one with Array.prototype.shift(), copying the array.
	let now = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => now += 0.01);

	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	expect(track).not.toBeNull();

	let packetCount = 0;
	let halfStart = Date.now();
	let firstHalfDuration = 0;
	for await (const packet of new EncodedPacketSink(track!).packets(undefined, undefined, { metadataOnly: true })) {
		void packet;
		packetCount++;
		if (packetCount === count / 2) {
			firstHalfDuration = Date.now() - halfStart;
			halfStart = Date.now();
		}
	}
	const secondHalfDuration = Date.now() - halfStart;

	expect(packetCount).toBe(count);
	// The window is full only during the second half
	expect(secondHalfDuration).toBeLessThan(2 * firstHalfDuration + 100);
});
