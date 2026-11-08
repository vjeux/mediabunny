import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, CustomSource, ReadableStreamSource } from '../../src/source.js';
import { ALL_FORMATS, MP3 } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

test('Does not read tags between or after MP3 frames as frames', async () => {
	// Silent MPEG-1 Layer III frames, 128 kbps at 44.1 kHz
	const frames = (count: number) => {
		const bytes = new Uint8Array(count * 417);
		for (let i = 0; i < count; i++) {
			bytes.set([0xff, 0xfb, 0x90, 0x00], i * 417);
		}
		return bytes;
	};

	// An ID3v2.3 tag with cover art that happens to contain something that looks like a frame
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const u32le = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
	const apic = [0, ...ascii('image/jpeg'), 0, 3, 0, ...frames(1)];
	const frame = [...ascii('APIC'), 0, 0, apic.length >> 8, apic.length & 0xff, 0, 0, ...apic];
	const tag = [...ascii('ID3'), 3, 0, 0, 0, 0, frame.length >> 7, frame.length & 0x7f, ...frame];

	const readTimestamps = async (bytes: Uint8Array) => {
		using input = new Input({
			source: new BufferSource(bytes),
			formats: ALL_FORMATS,
		});

		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);

		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
			timestamps.push(packet.timestamp);
		}
		return timestamps;
	};

	const expectedTimestamps = (count: number) => Array.from({ length: count }, (_, i) => i * 1152 / 44100);

	// Two concatenated files, the second one with a tag
	expect(await readTimestamps(new Uint8Array([...frames(5), ...tag, ...frames(5)]))).toEqual(expectedTimestamps(10));
	// A tag at the end of the file
	expect(await readTimestamps(new Uint8Array([...frames(5), ...tag]))).toEqual(expectedTimestamps(5));

	// An APEv2 tag (with header and footer) holding the same picture as a binary item, followed by an ID3v1 tag
	const apeItem = [...u32le(apic.length), ...u32le(2), ...ascii('Cover Art (Front)'), 0, ...apic];
	const apeHeaderOrFooter = (isHeader: boolean) => [
		...ascii('APETAGEX'),
		...u32le(2000), // Version
		...u32le(apeItem.length + 32), // Tag size, including the footer
		...u32le(1), // Item count
		...u32le((1 << 31) | (isHeader ? 1 << 29 : 0)), // Flags: has a header, is the header
		0, 0, 0, 0, 0, 0, 0, 0,
	];
	const apeTag = [...apeHeaderOrFooter(true), ...apeItem, ...apeHeaderOrFooter(false)];
	const id3V1Tag = [...ascii('TAG'), ...new Array<number>(125).fill(0)];
	expect(await readTimestamps(new Uint8Array([...frames(5), ...apeTag, ...id3V1Tag]))).toEqual(expectedTimestamps(5));
});

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
