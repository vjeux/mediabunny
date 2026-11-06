import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, OggOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';

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

test.each([
	['Matroska', () => new MkvOutputFormat()],
	['Ogg', () => new OggOutputFormat()],
])('%s: a track closed while its only packet is still queued is kept', async (_, makeFormat) => {
	const target = new BufferTarget();
	const output = new Output({ format: makeFormat(), target });
	const sources = [0, 1, 2].map(() => new EncodedAudioPacketSource('opus'));
	for (const source of sources) {
		output.addAudioTrack(source);
	}
	await output.start();

	// OpusHead: version 1, 2 channels, 312 samples of pre-skip, 48 kHz, no gain, channel mapping family 0
	const description = new Uint8Array([
		...new TextEncoder().encode('OpusHead'), 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0,
	]);
	const meta = { decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000, description } };
	// TOC byte 0xfc: one 20 ms stereo CELT frame
	const packet = (index: number) => new EncodedPacket(new Uint8Array([0xfc, 1, 2, 3]), 'key', index * 0.02, 0.02);

	// None of these are awaited: the first track gets ahead, then the third track's first packet and the second
	// track's only packet are queued, and the second track is closed right away
	const pending: Promise<void>[] = [];
	for (let i = 0; i < 10; i++) {
		pending.push(sources[0]!.add(packet(i), i === 0 ? meta : undefined));
	}
	pending.push(sources[2]!.add(packet(0), meta));
	pending.push(sources[1]!.add(packet(0), meta));
	sources[1]!.close();
	for (let i = 1; i < 10; i++) {
		pending.push(sources[2]!.add(packet(i)));
	}
	await Promise.all(pending);
	await output.finalize();

	using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	const packetCounts: number[] = [];
	for (const track of await input.getTracks()) {
		let count = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			void packet;
			count++;
		}
		packetCounts.push(count);
	}

	expect(packetCounts.sort((a, b) => a - b)).toEqual([1, 10, 10]);
});
