import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

test('Output, onFinalize', async () => {
	let callCount = 0;
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
		onFinalize: async () => {
			await new Promise(resolve => setTimeout(resolve, 200));

			callCount++;
		},
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.5), {
		decoderConfig: {
			codec: 'avc1.640028',
			codedWidth: 1920,
			codedHeight: 1080,
		},
	});

	await output.finalize();

	expect(callCount).toBe(1);
});

test('Opus with more than two channels needs a decoder description', async () => {
	const addFirstPacket = async (numberOfChannels: number) => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array([0xfc, 0xff, 0xfe]), 'key', 0, 0.02), {
			decoderConfig: { codec: 'opus', numberOfChannels, sampleRate: 48000 },
		});
		await output.finalize();
	};

	// Without a description, channel mapping family 0 applies, which only covers mono and stereo. Six channels used to
	// be written as a dOps box with mapping family 0 (FFmpeg: "Channel mapping 0 is only specified for up to 2
	// channels"), and as a Matroska track without CodecPrivate, which readers take for stereo.
	await expect(addFirstPacket(6)).rejects.toThrow(TypeError);
	await addFirstPacket(2);
});
