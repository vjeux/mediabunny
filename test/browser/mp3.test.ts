import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { WavOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { CustomAudioDecoder, registerDecoder } from '../../src/custom-coder.js';
import { AudioSample } from '../../src/sample.js';
import { AudioCodec } from '../../src/codec.js';
import { EncodedPacket } from '../../src/packet.js';

// Silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz) with the given channel modes (3 = mono, 1 = joint stereo)
const buildMp3 = (modes: number[]) => {
	const stream = new Uint8Array(modes.length * 417);
	modes.forEach((mode, i) => stream.set([0xff, 0xfb, 0x90, mode << 6], i * 417));
	return stream;
};

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

	// The decoder outputs the stereo frames with two channels, which get mixed down to the track's one channel
	expect(await audioTrack.getNumberOfChannels()).toBe(1);
	const channelCounts: number[] = [];
	for await (using sample of new AudioSampleSink(audioTrack).samples()) {
		channelCounts.push(sample.numberOfChannels);
	}
	expect(channelCounts).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
});

test('Converts MP3s that switch between mono and stereo', async () => {
	const convertToWav = async (modes: number[]) => {
		using input = new Input({ source: new BufferSource(buildMp3(modes)), formats: ALL_FORMATS });
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, showWarnings: false });
		expect(conversion.discardedTracks).toEqual([]);
		await conversion.execute();

		using wavInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = (await wavInput.getPrimaryAudioTrack())!;
		return { channels: await track.getNumberOfChannels(), duration: await track.computeDuration() };
	};

	// Encoders need a constant channel count, so the frames with the other one are mixed to the track's
	expect(await convertToWav([3, 3, 3, 1, 1, 1, 3, 3, 3])).toEqual({ channels: 1, duration: 9 * 1152 / 44100 });
	expect(await convertToWav([1, 1, 1, 3, 3, 3, 1, 1, 1])).toEqual({ channels: 2, duration: 9 * 1152 / 44100 });
});

test('Mixes decoded MP3 frames to the track\'s channel count, keeping the sample format', async () => {
	// A stand-in decoder that outputs every frame with the frame's own channel count, as s16: 0.5 in the first (or
	// only) channel, -0.25 in the second
	let enabled = true;
	class FakeMp3Decoder extends CustomAudioDecoder {
		static override supports(codec: AudioCodec) {
			return enabled && codec === 'mp3';
		}

		init() {}
		decode(packet: EncodedPacket) {
			const numberOfChannels = (packet.data[3]! >> 6) === 3 ? 1 : 2;
			const data = new Int16Array(1152 * numberOfChannels);
			for (let i = 0; i < 1152; i++) {
				data[i * numberOfChannels] = 0.5 * 32768;
				if (numberOfChannels === 2) {
					data[i * 2 + 1] = -0.25 * 32768;
				}
			}

			this.onSample(new AudioSample({
				data,
				format: 's16',
				numberOfChannels,
				sampleRate: 44100,
				timestamp: packet.timestamp,
			}));
		}

		flush() {}
		close() {}
	}
	registerDecoder(FakeMp3Decoder);

	try {
		const decode = async (modes: number[]) => {
			using input = new Input({ source: new BufferSource(buildMp3(modes)), formats: ALL_FORMATS });
			const track = (await input.getPrimaryAudioTrack())!;

			const frames: string[] = [];
			for await (using sample of new AudioSampleSink(track).samples()) {
				const data = new Int16Array(sample.allocationSize({ planeIndex: 0, format: 's16' }) / 2);
				sample.copyTo(data, { planeIndex: 0, format: 's16' });
				frames.push(`${sample.format} ${[...data.subarray(0, sample.numberOfChannels)].join(',')}`);
			}
			return frames;
		};

		// Stereo frames in a mono track are averaged: (0.5 - 0.25) / 2 = 0.125
		expect(await decode([3, 3, 1, 3])).toEqual(['s16 16384', 's16 16384', 's16 4096', 's16 16384']);
		// Mono frames in a stereo track are copied to both channels
		expect(await decode([1, 1, 3, 1])).toEqual([
			's16 16384,-8192',
			's16 16384,-8192',
			's16 16384,16384',
			's16 16384,-8192',
		]);
	} finally {
		enabled = false;
	}
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
