import { expect, test, vi } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { EncodedPacket } from '../../src/packet.js';
import { CustomSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

test('packets() caps how much packet data it reads ahead', async () => {
	// 160 frames of 512 KiB, like high-bitrate (lossless, ProRes) video
	const packetSize = 2 ** 19;
	const target = new BufferTarget();
	const output = new Output({ format: new Mp4OutputFormat(), target });
	const videoSource = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(videoSource);
	await output.start();
	for (let i = 0; i < 160; i++) {
		await videoSource.add(new EncodedPacket(new Uint8Array(packetSize), 'key', i / 30, 1 / 30), {
			decoderConfig: { codec: 'vp8', codedWidth: 1920, codedHeight: 1080 },
		});
	}
	await output.finalize();
	const file = new Uint8Array(target.buffer!);

	let readEnd = 0;
	using input = new Input({
		source: new CustomSource({
			getSize: () => file.length,
			read: (start, end) => {
				readEnd = Math.max(readEnd, end);
				return file.subarray(start, end);
			},
		}),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	expect(track).not.toBeNull();

	// A frozen clock makes the queue limit "everything dequeued so far", as if all of it happened within one second
	vi.spyOn(performance, 'now').mockReturnValue(0);

	const packets = new EncodedPacketSink(track!).packets();
	let consumedEnd = 0;
	for (let i = 0; i < 80; i++) {
		const { value } = await packets.next();
		consumedEnd += value!.byteLength;
	}

	// Let the iterator read ahead as far as it wants while the consumer pauses
	await new Promise(resolve => setTimeout(resolve, 100));
	const readAheadBytes = readEnd - consumedEnd;
	await packets.return();

	// Up to 80 packets (40 MiB) used to be queued
	expect(readAheadBytes).toBeLessThan(2 ** 25 + 4 * packetSize);
});
