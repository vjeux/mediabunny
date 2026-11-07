import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { OggOutputFormat } from '../../src/output-format.js';
import { EncodedPacket } from '../../src/packet.js';
import { CustomSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

test('Lookups past the end of a logical stream that ends early don\'t scan the rest of the file again', async () => {
	// Two Opus streams over 3 minutes; the second one ends after 18 seconds, like a commentary track
	const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
	const mainSource = new EncodedAudioPacketSource('opus');
	const shortSource = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(mainSource);
	output.addAudioTrack(shortSource);
	await output.start();

	const decoderConfig = {
		codec: 'opus',
		numberOfChannels: 2,
		sampleRate: 48000,
		// OpusHead: version 1, 2 channels, 312 samples of pre-skip, 48 kHz, no gain, channel mapping family 0
		description: new Uint8Array([
			0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0,
		]),
	};
	const frameDuration = 0.02;
	const count = Math.round(180 / frameDuration);
	const data = new Uint8Array(300).fill(0xfc);
	for (let i = 0; i < count; i++) {
		await mainSource.add(new EncodedPacket(data, 'key', i * frameDuration, frameDuration), { decoderConfig });
		if (i < count / 10) {
			await shortSource.add(new EncodedPacket(data, 'key', i * frameDuration, frameDuration), { decoderConfig });
		}
		if (i === Math.ceil(count / 10)) {
			shortSource.close();
		}
	}
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	let bytesRead = 0;
	using input = new Input({
		source: new CustomSource({
			// A cache much smaller than the file, as for any long recording
			maxCacheSize: 2 ** 16,
			getSize: () => bytes.byteLength,
			read: (start, end) => {
				bytesRead += end - start;
				return bytes.subarray(start, end);
			},
		}),
		formats: ALL_FORMATS,
	});
	const shortTrack = (await input.getAudioTracks())[1]!;
	const sink = new EncodedPacketSink(shortTrack);

	// Lookups within the stream only read around the packet
	bytesRead = 0;
	expect((await sink.getPacket(10))!.timestamp).toBeCloseTo(10, 1);
	expect(bytesRead).toBeLessThan(bytes.byteLength / 4);

	// The first lookup past the end may have to find out where the stream ends
	expect((await sink.getPacket(60))!.timestamp).toBeCloseTo(18, 1);

	for (const timestamp of [90, 120, 150]) {
		bytesRead = 0;
		expect((await sink.getPacket(timestamp))!.timestamp).toBeCloseTo(18, 1);
		expect(bytesRead).toBeLessThan(bytes.byteLength / 4);
	}
}, 60_000);
