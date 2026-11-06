import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat, MpegTsOutputFormat, OggOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { countMovedArrayElements } from './array-moves.js';

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

test('Muxers write out a track queued far ahead of the others in linear time', async () => {
	// Adding one track's packets before the other's (as the docs suggest when interleaving isn't possible) queues them
	// all; they used to be taken off the queue with Array.prototype.shift(), which copies the whole queue each time.
	const count = 100_000;
	const avcConfig = {
		codec: 'avc1.42c01e',
		codedWidth: 32,
		codedHeight: 32,
		description: new Uint8Array([
			0x01, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x0a, 0x67, 0x42, 0xc0, 0x1e, 0xda, 0x02, 0x80, 0xbf, 0xe5, 0x84,
			0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80,
		]),
	};
	const aacConfig = {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		description: new Uint8Array([0x11, 0x90]),
	};
	const opusConfig = {
		codec: 'opus',
		numberOfChannels: 2,
		sampleRate: 48000,
		// 'OpusHead', version 1, 2 channels, pre-skip 312, 48 kHz
		description: new Uint8Array([
			0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0,
		]),
	};
	const opusPacket = new Uint8Array([0xfc, 0xff, 0xfe]); // 20 ms

	const formats = [new Mp4OutputFormat(), new MkvOutputFormat(), new MpegTsOutputFormat(), new OggOutputFormat()];
	for (const format of formats) {
		// Ogg holds no video, so it gets two Opus tracks
		const withVideo = !(format instanceof OggOutputFormat);
		const output = new Output({ format, target: new BufferTarget() });
		const videoSource = new EncodedVideoPacketSource('avc');
		const firstAudioSource = new EncodedAudioPacketSource('opus');
		const secondAudioSource = new EncodedAudioPacketSource(withVideo ? 'aac' : 'opus');
		if (withVideo) {
			output.addVideoTrack(videoSource);
		} else {
			output.addAudioTrack(firstAudioSource);
		}
		output.addAudioTrack(secondAudioSource);
		await output.start();

		const frameDuration = withVideo ? 1 / 30 : 0.02;
		const movedElements = await countMovedArrayElements(async () => {
			for (let i = 0; i < count; i++) {
				if (withVideo) {
					const type = i % 30 === 0 ? 'key' : 'delta';
					await videoSource.add(
						new EncodedPacket(new Uint8Array(8), type, i * frameDuration, frameDuration),
						i === 0 ? { decoderConfig: avcConfig } : undefined,
					);
				} else {
					await firstAudioSource.add(
						new EncodedPacket(opusPacket, 'key', i * frameDuration, frameDuration),
						i === 0 ? { decoderConfig: opusConfig } : undefined,
					);
				}
			}

			// A packet of the other track past all of them lets the muxer write out the whole queue
			await secondAudioSource.add(
				new EncodedPacket(withVideo ? new Uint8Array(8) : opusPacket, 'key', count * frameDuration, 0.02),
				{ decoderConfig: withVideo ? aacConfig : opusConfig },
			);
			await output.finalize();
		});

		// Linear: no per-packet copies of the queue (main moved ~5e9 elements per format)
		expect(movedElements).toBeLessThan(2 * count);
	}
});
