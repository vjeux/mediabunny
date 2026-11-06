import { expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { CustomSource } from '../../src/source.js';
import { countMovedArrayElements } from './array-moves.js';

test('Cached sources evict their least recently used entry in constant time', async () => {
	// 60k ADTS frames of 8 bytes each; without prefetching, every frame header becomes its own cache entry
	const frame = [0xff, 0xf1, 0x50, 0x80, 0x01, 0x1f, 0xfc, 0x00];
	const frameCount = 60_000;
	const file = new Uint8Array(frame.length * frameCount);
	for (let i = 0; i < frameCount; i++) {
		file.set(frame, i * frame.length);
	}

	// The cache holds half the file, so it's evicting during the second half; finding the entry to evict used to scan
	// all ~30k entries
	using input = new Input({
		source: new CustomSource({
			getSize: () => file.length,
			read: (start, end) => file.subarray(start, end),
			maxCacheSize: file.length / 2,
		}),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	expect(track).not.toBeNull();
	const sink = new EncodedPacketSink(track!);

	let packetCount = 0;
	let halfStart = performance.now();
	let firstHalfDuration = 0;
	const options = { metadataOnly: true };
	const movedElements = await countMovedArrayElements(async () => {
		let packet = await sink.getFirstPacket(options);
		while (packet) {
			packetCount++;
			if (packetCount === frameCount / 2) {
				firstHalfDuration = performance.now() - halfStart;
				halfStart = performance.now();
			}
			packet = await sink.getNextPacket(packet, options);
		}
	});
	const secondHalfDuration = performance.now() - halfStart;

	expect(packetCount).toBe(frameCount);
	// Linear: evictions don't splice the cache array one entry at a time (main moved ~9e8 elements)
	expect(movedElements).toBeLessThan(frameCount);
	// Finding the entry to evict used to scan the whole cache, which leaves no count to check, hence a timing check
	// with a generous margin (main: ~4.5 s vs ~0.15 s)
	expect(secondHalfDuration).toBeLessThan(4 * firstHalfDuration + 500);
});
