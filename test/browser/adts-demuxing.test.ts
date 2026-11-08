import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

test('ADTS demuxing', async () => {
	using input = new Input({
		source: new UrlSource('/sample3.aac'),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('aac');
	expect(await audioTrack.getSampleRate()).toBe(44100);
	expect(await audioTrack.getNumberOfChannels()).toBe(2);

	const decoderConfig = await audioTrack.getDecoderConfig();
	assert(decoderConfig);

	expect(decoderConfig).toEqual({
		codec: 'mp4a.40.2',
		sampleRate: 44100,
		numberOfChannels: 2,
		// No description
	});

	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	expect(firstPacket.data[0]).toBe(0xff);
	expect((firstPacket.data[1]! & 0xf0)).toBe(0xf0); // Second nibble is also all 1s
	expect(firstPacket.type).toBe('key');

	const secondPacket = await sink.getNextPacket(firstPacket);
	assert(secondPacket);

	expect(secondPacket.data[0]).toBe(0xff);
	expect((secondPacket.data[1]! & 0xf0)).toBe(0xf0);
	expect(secondPacket.type).toBe('key');
});

test('ADTS packet decodability', async () => {
	using input = new Input({
		source: new UrlSource('/sample3.aac'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new AudioSampleSink(audioTrack);

	let count = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of sink.samples()) {
		count++;
	}

	expect(count).toBeGreaterThan(0);
});

test('ADTS getPacket() at the end of a packet returns the next packet', async () => {
	// AAC-LC, 44.1 kHz, stereo: 300-byte frames of 1024 samples
	const bytes = new Uint8Array(40 * 300);
	for (let i = 0; i < 40; i++) {
		bytes.set([0xff, 0xf1, 0x50, 0x80, (300 >> 3) & 0xff, ((300 & 7) << 5) | 0x1f, 0xfc], i * 300);
	}

	using input = new Input({
		source: new BufferSource(bytes),
		formats: [ADTS],
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
