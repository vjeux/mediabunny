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

test('Keeps reading MP3 frames that switch between mono and stereo', async () => {
	// Silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz), going from mono to joint stereo and back. The channel mode
	// may change from frame to frame, as in the ISO/IEC 11172-4 he_mode conformance stream or in spliced files.
	const modes = [3, 3, 3, 1, 1, 1, 3, 3, 3];
	const stream = new Uint8Array(modes.length * 417);
	modes.forEach((mode, i) => stream.set([0xff, 0xfb, 0x90, mode << 6], i * 417));

	using input = new Input({
		source: new BufferSource(stream),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual(modes.map((_, i) => i * 1152 / 44100));

	const channelCounts: number[] = [];
	for await (using sample of new AudioSampleSink(audioTrack).samples()) {
		channelCounts.push(sample.numberOfChannels);
	}
	expect(channelCounts).toEqual([1, 1, 1, 2, 2, 2, 1, 1, 1]);
});

test('Keeps reading concatenated MP3s whose channel counts differ', async () => {
	// A joint-stereo part and a mono part with junk in between, like two files joined after a stray tag. The junk
	// starts with a mono frame header that isn't followed by another frame, which must not count as a frame.
	const frames = (count: number, mode: number) => {
		const bytes = new Uint8Array(count * 417);
		for (let i = 0; i < count; i++) {
			bytes.set([0xff, 0xfb, 0x90, mode << 6], i * 417);
		}
		return bytes;
	};
	const junk = new Uint8Array(45).fill(0x55);
	junk.set([0xff, 0xfb, 0x90, 0xc0]);

	using input = new Input({
		source: new BufferSource(new Uint8Array([...frames(3, 1), ...junk, ...frames(3, 3)])),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual([0, 1, 2, 3, 4, 5].map(i => i * 1152 / 44100));
});
