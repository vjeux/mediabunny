import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { CmafOutputFormat, MkvOutputFormat } from '../../src/output-format.js';
import { BufferTarget, Target } from '../../src/target.js';
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

test.each(['a target', 'a function'])('Output emits a target event for the CMAF init target, given as %s', async (
	kind,
) => {
	const initTarget = new BufferTarget();
	const output = new Output({
		format: new CmafOutputFormat(),
		target: new BufferTarget(),
		initTarget: kind === 'a target' ? initTarget : () => initTarget,
	});

	const events: { target: Target; isRoot: boolean }[] = [];
	output.on('target', ({ target, isRoot }) => events.push({ target, isRoot }));

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();
	const description = new Uint8Array([0x11, 0x88]);
	await source.add(new EncodedPacket(new Uint8Array(10), 'key', 0, 0.02), {
		decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 1, sampleRate: 48000, description },
	});
	await output.finalize();

	expect(initTarget.buffer).not.toBeNull(); // The init segment was written to it
	expect(events.filter(x => x.target === initTarget)).toEqual([{ target: initTarget, isRoot: false }]);
});
