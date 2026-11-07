import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
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
