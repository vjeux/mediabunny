import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, WavOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { AudioSampleSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { AudioSample } from '../../src/sample.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';

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

test('Samples added right after close() are rejected', async () => {
	const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
	const source = new AudioSampleSource({ codec: 'pcm-s16' });
	output.addAudioTrack(source);
	await output.start();

	const createSample = (timestamp: number) => new AudioSample({
		data: new Float32Array(4800).fill(0.5),
		format: 'f32',
		numberOfChannels: 1,
		sampleRate: 48000,
		timestamp,
	});

	await source.add(createSample(0));
	source.close(); // Not awaited, closing finishes later
	await expect(source.add(createSample(0.1))).rejects.toThrow('Source is closed.');
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	expect(await (await input.getPrimaryAudioTrack())!.computeDuration()).toBe(0.1);
});
