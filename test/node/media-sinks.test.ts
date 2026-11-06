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

test('packets() keeps a constant cost per packet when its queue runs far ahead', async () => {
	const frame = [0xff, 0xf1, 0x50, 0x80, 0x01, 0x1f, 0xfc, 0x00];
	const count = 200_000;
	const file = new Uint8Array(frame.length * count);
	for (let i = 0; i < count; i++) {
		file.set(frame, i * frame.length);
	}

	// With a frozen clock, all packets dequeued so far count as the last second's, which is how many the iterator
	// queues ahead
	vi.spyOn(performance, 'now').mockReturnValue(0);

	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	expect(track).not.toBeNull();
	const packets = new EncodedPacketSink(track!).packets(undefined, undefined, { metadataOnly: true });

	let start = Date.now();
	for (let i = 0; i < count / 2; i++) {
		await packets.next();
	}
	const firstHalfDuration = Date.now() - start;

	// A consumer that awaits something (like a muxer waiting on its writer) lets the iterator fill its queue, whose
	// packets were taken off with Array.prototype.shift(), copying the whole queue each time
	await new Promise(resolve => setTimeout(resolve, 200));

	start = Date.now();
	let packetCount = count / 2;
	while (!(await packets.next()).done) {
		packetCount++;
	}
	const secondHalfDuration = Date.now() - start;

	expect(packetCount).toBe(count);
	expect(secondHalfDuration).toBeLessThan(2 * firstHalfDuration + 100);
});
