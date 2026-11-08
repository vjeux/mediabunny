import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
	ALL_FORMATS,
	BufferSource,
	EncodedPacket,
	EncodedPacketSink,
	Input,
	ReadableStreamSource,
} from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// A source that can only read the file in order, keeping the last `cacheSize` bytes
const streamedSource = (file: Uint8Array, cacheSize: number) => {
	let offset = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= file.length) {
				controller.close();
				return;
			}
			controller.enqueue(file.slice(offset, offset + 16384));
			offset += 16384;
		},
	});
	return new ReadableStreamSource(stream, { maxCacheSize: cacheSize });
};

test('Ogg: Duration of a stream longer than its cache, after reading its packets', async () => {
	// Reading to the end of the stream makes its size known, but the source can't read back what has left its cache,
	// which a binary search for the last packet would do
	const file = new Uint8Array(readFileSync(path.join(__dirname, '../public/preroll-test.opus')));
	using input = new Input({ source: streamedSource(file, 32 * 1024), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	const sink = new EncodedPacketSink(track);
	let lastTimestamp = 0;
	let end = 0;
	for await (const packet of sink.packets()) {
		lastTimestamp = packet.timestamp;
		end = packet.timestamp + packet.duration;
	}

	expect(await track.computeDuration()).toBe(end);
	expect((await sink.getPacket(Infinity))?.timestamp).toBe(lastTimestamp);
});

test('Ogg: Seeking forward in a stream longer than its cache, after playing part of it', async () => {
	// The lookup must read on from where playback got to: the start of the stream has left the cache by then
	const file = new Uint8Array(readFileSync(path.join(__dirname, '../public/preroll-test.opus')));
	const packets: EncodedPacket[] = [];
	using reference = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	for await (const packet of new EncodedPacketSink((await reference.getPrimaryAudioTrack())!).packets()) {
		packets.push(packet);
	}

	using input = new Input({ source: streamedSource(file, 32 * 1024), formats: ALL_FORMATS });
	const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
	for await (const packet of sink.packets()) {
		if (packet.sequenceNumber === packets[225]!.sequenceNumber) {
			break;
		}
	}

	for (const target of [packets[270]!, packets[280]!, packets.at(-1)!]) {
		const packet = await sink.getPacket(target.timestamp);
		expect([packet?.timestamp, packet?.byteLength]).toEqual([target.timestamp, target.byteLength]);
	}
});
