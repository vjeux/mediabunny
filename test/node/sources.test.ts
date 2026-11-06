import { expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { ReadableStreamSource } from '../../src/source.js';

test('ReadableStreamSource evicts small chunks in constant time', async () => {
	// 160k ADTS frames of 8 bytes each (62 min at 44.1 kHz), streamed in 16-byte chunks
	const frame = [0xff, 0xf1, 0x50, 0x80, 0x01, 0x1f, 0xfc, 0x00];
	const frameCount = 160_000;
	const file = new Uint8Array(frame.length * frameCount);
	for (let i = 0; i < frameCount; i++) {
		file.set(frame, i * frame.length);
	}

	const chunkSize = 16;
	let offset = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= file.length) {
				controller.close();
				return;
			}
			controller.enqueue(file.slice(offset, offset + chunkSize));
			offset += chunkSize;
		},
	});

	// The cache holds half the stream, so it's evicting one chunk per new chunk during the second half; each eviction
	// used to be an Array.prototype.shift() on its 40k entries
	using input = new Input({
		source: new ReadableStreamSource(stream, { maxCacheSize: file.length / 2 }),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	expect(track).not.toBeNull();
	const sink = new EncodedPacketSink(track!);

	let packetCount = 0;
	let halfStart = performance.now();
	let firstHalfDuration = 0;
	for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
		packetCount++;
		if (packetCount === frameCount / 2) {
			firstHalfDuration = performance.now() - halfStart;
			halfStart = performance.now();
		}
	}
	const secondHalfDuration = performance.now() - halfStart;

	expect(packetCount).toBe(frameCount);
	expect(secondHalfDuration).toBeLessThan(2 * firstHalfDuration + 100);
});
