import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, MovOutputFormat, Mp4OutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

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

// Annex B access units: SPS + PPS + IDR slice, and a non-IDR slice
const AVC_KEY_FRAME = new Uint8Array([
	0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x0a, 0xd9, 0x06, 0x26, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03,
	0x00, 0xf0, 0x3c, 0x48, 0x99, 0x20,
	0, 0, 0, 1, 0x68, 0xcb, 0x83, 0xcb, 0x20,
	0, 0, 0, 1, 0x65, 0x88, 0x84, 0x10, 0x20, 0x40, 0x80, 0x01,
]);
const AVC_DELTA_FRAME = new Uint8Array([0, 0, 0, 1, 0x41, 0x9a, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40]);

test('frameRate snaps video timestamps to the frame grid in every timestamped format', async () => {
	const frameRate = 30000 / 1001;
	const jitter = [0, 0.004, -0.003, 0.006, 0.002];
	const formats = [
		new Mp4OutputFormat(),
		new Mp4OutputFormat({ fastStart: 'fragmented' }),
		new MovOutputFormat(),
		new MkvOutputFormat(),
		new MpegTsOutputFormat(),
	];

	for (const format of formats) {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source, { frameRate });
		await output.start();

		for (let i = 0; i < jitter.length; i++) {
			await source.add(
				new EncodedPacket(
					i === 0 ? AVC_KEY_FRAME : AVC_DELTA_FRAME,
					i === 0 ? 'key' : 'delta',
					i / frameRate + jitter[i]!,
					1 / frameRate,
				),
				i === 0 ? { decoderConfig: { codec: 'avc1.42c00a', codedWidth: 96, codedHeight: 64 } } : undefined,
			);
		}

		await output.finalize();

		const input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			timestamps.push(packet.timestamp);
		}
		input.dispose();

		// Within the container's precision (milliseconds for Matroska) of the frame grid
		expect(timestamps.map((timestamp, i) => Math.abs(timestamp - i / frameRate) < 0.0006), format._name)
			.toEqual(jitter.map(() => true));
	}
});
