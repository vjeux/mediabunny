import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';

// "joined" in the sense that it was two separate MP3s that were spliced together (I think)
test('Can decode malformed joined MP3', async () => {
	using input = new Input({
		source: new UrlSource('/malformed-join.mp3'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new AudioSampleSink(audioTrack);
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of sink.samples());
});

test('MP3 getPacket() at the end of a packet returns the next packet', async () => {
	// MPEG-1 Layer III, 128 kbps, 44.1 kHz: 417-byte frames of 1152 samples
	const bytes = new Uint8Array(40 * 417);
	for (let i = 0; i < 40; i++) {
		bytes.set([0xff, 0xfb, 0x90, 0x04], i * 417);
	}

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new EncodedPacketSink(audioTrack);
	const packets = [];
	for await (const packet of sink.packets()) {
		packets.push(packet);
	}
	expect(packets).toHaveLength(40);

	for (let i = 0; i < packets.length - 1; i++) {
		// The end of a packet, computed the obvious way, is where the next one starts, but the sum can come out a float
		// error below it
		const packet = await sink.getPacket(packets[i]!.timestamp + packets[i]!.duration);
		expect(packet!.timestamp).toBe(packets[i + 1]!.timestamp);
	}
});
