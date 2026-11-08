import { expect, test } from 'vitest';
import { ALL_FORMATS, MP3 } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { CustomSource, ReadableStreamSource } from '../../src/source.js';

test('Reading MP3 frames only requests a small slice per frame header', async () => {
	// 2000 CBR frames: MPEG-1 Layer III, 128 kbps, 44.1 kHz, 417 bytes each
	const frameSize = 417;
	const frameCount = 2000;
	const file = new Uint8Array(frameSize * frameCount);
	for (let i = 0; i < frameCount; i++) {
		file.set([0xff, 0xfb, 0x90, 0x00], i * frameSize);
	}

	// Without a cache or prefetching, every slice the demuxer requests becomes a read
	let requestedBytes = 0;
	using input = new Input({
		source: new CustomSource({
			getSize: () => file.length,
			read: (start, end) => {
				requestedBytes += end - start;
				return file.subarray(start, end);
			},
			maxCacheSize: 0,
		}),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	expect(track).not.toBeNull();

	let packetCount = 0;
	for await (const packet of new EncodedPacketSink(track!).packets()) {
		expect(packet.data.byteLength).toBe(frameSize);
		packetCount++;
	}
	expect(packetCount).toBe(frameCount);

	// Each frame header lookup used to request 64 KiB, which sources backed by a cache assemble by copying
	expect(requestedBytes).toBeLessThan(3 * file.length);
});

test('MP3 from an unsized source ignores a last frame cut off by the end of the stream', async () => {
	// MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo: 417-byte frames, payloads zeroed
	const frameCount = 400;
	const frameLength = 417;
	const bytes = new Uint8Array(frameCount * frameLength - 100); // The last frame lacks 100 bytes
	for (let i = 0; i < frameCount; i++) {
		bytes.set([0xff, 0xfb, 0x90, 0x04], i * frameLength);
	}

	const createInput = () => new Input({
		source: new ReadableStreamSource(new ReadableStream({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 4096) {
					controller.enqueue(bytes.slice(i, i + 4096));
				}
				controller.close();
			},
		})),
		formats: [MP3],
	});

	const completeFrameCount = frameCount - 1;

	using durationInput = createInput();
	const durationTrack = await durationInput.getPrimaryAudioTrack();
	expect(await durationTrack!.computeDuration()).toBeCloseTo(completeFrameCount * 1152 / 44100, 6);

	using packetInput = createInput();
	const packetTrack = await packetInput.getPrimaryAudioTrack();
	const lastPacket = await new EncodedPacketSink(packetTrack!).getPacket(Infinity);
	expect(lastPacket?.timestamp).toBeCloseTo((completeFrameCount - 1) * 1152 / 44100, 6);
});
