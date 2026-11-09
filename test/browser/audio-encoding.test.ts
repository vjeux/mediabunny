import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { AudioSample } from '../../src/sample.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';
import { AudioCodec } from '../../src/codec.js';

const NativeAudioEncoder = AudioEncoder;

/**
 * Like WebKit's GStreamer-based AudioEncoder, stamps every chunk with the timestamp and duration of the AudioData it
 * came from.
 */
class RestampingAudioEncoder extends NativeAudioEncoder {
	input: { timestamp: number; duration: number };

	constructor(init: AudioEncoderInit) {
		const input = { timestamp: 0, duration: 0 };
		super({
			output: (chunk, metadata) => {
				const data = new Uint8Array(chunk.byteLength);
				chunk.copyTo(data);
				init.output(new EncodedAudioChunk({
					type: chunk.type,
					timestamp: input.timestamp,
					duration: input.duration,
					data,
				}), metadata);
			},
			error: init.error,
		});
		this.input = input;
	}

	override encode(data: AudioData) {
		this.input.timestamp = data.timestamp;
		this.input.duration = data.duration;
		super.encode(data);
	}
}

test('Audio packets get their timing from the bitstream if the encoder stamps chunks with their input\'s', async () => {
	for (const codec of ['opus', 'aac'] as AudioCodec[]) {
		const codecString = codec === 'opus' ? 'opus' : 'mp4a.40.2';
		const support = await NativeAudioEncoder.isConfigSupported({
			codec: codecString,
			numberOfChannels: 2,
			sampleRate: 48000,
			bitrate: 128e3,
		});
		if (!support.supported) {
			continue; // Chromium builds without proprietary codecs have no AAC encoder
		}

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		globalThis.AudioEncoder = RestampingAudioEncoder;
		try {
			const source = new AudioSampleSource({ codec, bitrate: 128e3 });
			output.addAudioTrack(source);
			await output.start();

			// Five 100 ms samples of a tone
			for (let i = 0; i < 5; i++) {
				const data = new Float32Array(2 * 4800);
				for (let j = 0; j < data.length; j++) {
					data[j] = 0.5 * Math.sin(2 * Math.PI * 440 * (i * 4800 + j % 4800) / 48000);
				}
				using sample = new AudioSample({
					data,
					format: 'f32-planar',
					numberOfChannels: 2,
					sampleRate: 48000,
					timestamp: i / 10,
				});
				await source.add(sample);
			}
			await output.finalize();
		} finally {
			globalThis.AudioEncoder = NativeAudioEncoder;
		}

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const packets: { timestamp: number; duration: number }[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push({ timestamp: packet.timestamp, duration: packet.duration });
		}

		// Each packet lasts as long as its frames (20 ms for Opus here, 1024 samples for AAC) and starts where the one
		// before ended
		const frameDuration = codec === 'opus' ? 0.02 : 1024 / 48000;
		expect(packets.length).toBeGreaterThan(20);
		for (let i = 1; i < packets.length; i++) {
			expect(packets[i - 1]!.duration).toBeCloseTo(frameDuration, 5);
			expect(packets[i]!.timestamp).toBeCloseTo(packets[i - 1]!.timestamp + frameDuration, 5);
		}
		expect(await track.computeDuration()).toBeCloseTo(0.5, 1);
	}
});
