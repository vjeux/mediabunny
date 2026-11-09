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
	using reference = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const referenceTrack = (await reference.getPrimaryAudioTrack())!;
	const referenceLastPacket = await new EncodedPacketSink(referenceTrack).getPacket(Infinity);

	using input = new Input({ source: streamedSource(file, 32 * 1024), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	const sink = new EncodedPacketSink(track);
	for await (const packet of sink.packets()) {
		void packet;
	}

	expect(await track.computeDuration()).toBe(await referenceTrack.computeDuration());
	expect((await sink.getPacket(Infinity))?.timestamp).toBe(referenceLastPacket?.timestamp);
});

test('Ogg: Seeking forward in a stream longer than its cache, after playing part of it', async () => {
	// The lookup must read on from where playback got to: the start of the stream has left the cache by then
	const file = new Uint8Array(readFileSync(path.join(__dirname, '../public/preroll-test.opus')));
	const packets: EncodedPacket[] = [];
	using reference = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	for await (const packet of new EncodedPacketSink((await reference.getPrimaryAudioTrack())!).packets()) {
		packets.push(packet);
	}

	// The pages of this file are 1 s long, and a lookup reads the packet ending the page before, so the cache holds a
	// few pages
	using input = new Input({ source: streamedSource(file, 64 * 1024), formats: ALL_FORMATS });
	const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
	for await (const packet of sink.packets()) {
		if (packet.sequenceNumber === packets[225]!.sequenceNumber) {
			break;
		}
	}

	// Seek forward, play on a little from there, then seek forward again
	let packet = await sink.getPacket(packets[250]!.timestamp);
	expect([packet?.timestamp, packet?.byteLength]).toEqual([packets[250]!.timestamp, packets[250]!.byteLength]);
	for (let i = 251; i <= 260; i++) {
		packet = await sink.getNextPacket(packet!);
		expect(packet?.timestamp).toBe(packets[i]!.timestamp);
	}
	for (const target of [packets[280]!, packets.at(-1)!]) {
		const found = await sink.getPacket(target.timestamp);
		expect([found?.timestamp, found?.byteLength]).toEqual([target.timestamp, target.byteLength]);
	}
});

test('Ogg: Looking behind where reading got to, after a forward seek in a stream longer than its cache', async () => {
	const file = new Uint8Array(readFileSync(path.join(__dirname, '../public/preroll-test.opus')));
	using input = new Input({ source: streamedSource(file, 96 * 1024), formats: ALL_FORMATS });
	using reference = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
	const referenceSink = new EncodedPacketSink((await reference.getPrimaryAudioTrack())!);

	// Play up to 3 s, seek forward to 4.5 s, play on for 1 s, then look up 5 s, which lies behind where reading got to
	for await (const packet of sink.packets()) {
		if (packet.timestamp >= 3) {
			break;
		}
	}
	let packet = await sink.getPacket(4.5);
	for (let i = 0; i < 50 && packet; i++) {
		packet = await sink.getNextPacket(packet);
	}
	expect(packet?.timestamp).toBe((await referenceSink.getPacket(5.5))?.timestamp);
	expect((await sink.getPacket(5))?.timestamp).toBe((await referenceSink.getPacket(5))?.timestamp);
});

test('Ogg: Looking up packets around where reading got to, in a stream that fits its cache', async () => {
	const file = new Uint8Array(readFileSync(path.join(__dirname, '../public/preroll-test.opus'))); // 6 s, 301 packets
	using input = new Input({ source: streamedSource(file, 1024 * 1024), formats: ALL_FORMATS }); // The whole file fits
	using reference = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
	const referenceSink = new EncodedPacketSink((await reference.getPrimaryAudioTrack())!);

	// Read up to 1 s, seek forward to 4.5 s, then look up 2.5 s, which is behind where reading got to
	for await (const packet of sink.packets()) {
		if (packet.timestamp >= 1) {
			break;
		}
	}
	for (const timestamp of [4.5, 2.5, 0.5, 5.5]) {
		const packet = await sink.getPacket(timestamp);
		const expected = await referenceSink.getPacket(timestamp);
		expect(packet?.timestamp).toBe(expected?.timestamp);
	}
});
