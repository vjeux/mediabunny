import { expect, test, vi } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { EncodedPacket } from '../../src/packet.js';
import { BufferSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

test('packets() caps how much packet data it reads ahead', async () => {
	const packetSize = 2 ** 19;

	// 160 frames of 512 KiB, like high-bitrate (lossless, ProRes) video: once as frame data and once as alpha side data
	for (const withAlpha of [false, true]) {
		const target = new BufferTarget();
		const output = new Output({ format: new MkvOutputFormat(), target });
		const videoSource = new EncodedVideoPacketSource('vp8');
		output.addVideoTrack(videoSource);
		await output.start();
		for (let i = 0; i < 160; i++) {
			const data = new Uint8Array(withAlpha ? 16 : packetSize);
			const sideData = withAlpha ? { alpha: new Uint8Array(packetSize) } : {};
			await videoSource.add(new EncodedPacket(data, 'key', i / 30, 1 / 30, undefined, undefined, sideData), {
				decoderConfig: { codec: 'vp8', codedWidth: 1920, codedHeight: 1080 },
			});
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		expect(track).not.toBeNull();
		const sink = new EncodedPacketSink(track!);

		// Count the bytes of every packet the iterator fetches
		let fetchedBytes = 0;
		const countBytes = (packet: EncodedPacket | null) => {
			fetchedBytes += (packet?.data.byteLength ?? 0) + (packet?.sideData.alpha?.byteLength ?? 0);
			return packet;
		};
		const getFirstPacket = sink.getFirstPacket.bind(sink);
		const getNextPacket = sink.getNextPacket.bind(sink);
		sink.getFirstPacket = async options => countBytes(await getFirstPacket(options));
		sink.getNextPacket = async (packet, options) => countBytes(await getNextPacket(packet, options));

		// A frozen clock makes the queue limit "everything dequeued so far", as if all of it happened within one second
		vi.spyOn(performance, 'now').mockReturnValue(0);

		const packets = sink.packets();
		let consumedBytes = 0;
		for (let i = 0; i < 80; i++) {
			const { value } = await packets.next();
			consumedBytes += value!.data.byteLength + (value!.sideData.alpha?.byteLength ?? 0);
		}

		// Let the iterator read ahead as far as it wants while the consumer pauses
		await new Promise(resolve => setTimeout(resolve, 100));
		const readAheadBytes = fetchedBytes - consumedBytes;
		await packets.return();

		// Up to 80 packets (40 MiB) used to be queued
		expect(readAheadBytes).toBeLessThan(2 ** 25 + 4 * packetSize);
	}
});
