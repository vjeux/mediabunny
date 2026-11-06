import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
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

test('Output validates initTarget and isRelativeToUnixEpoch like its other options', () => {
	expect(() => new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
		initTarget: 'init.mp4' as never,
	})).toThrow(new TypeError(
		'options.initTarget, when provided, must be a Target or a function that returns or resolves to a Target.',
	));

	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	for (const isRelativeToUnixEpoch of ['false', 1, null]) {
		expect(() => output.addVideoTrack(new EncodedVideoPacketSource('avc'), {
			isRelativeToUnixEpoch: isRelativeToUnixEpoch as never,
		})).toThrow(new TypeError('metadata.isRelativeToUnixEpoch, when provided, must be a boolean.'));
	}
	expect(output.tracks).toHaveLength(0);
});
