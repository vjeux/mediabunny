import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { OggOutputFormat } from '../../src/output-format.js';
import { EncodedPacket } from '../../src/packet.js';
import { BufferSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

test('Opus without a decoder description gets an identification header built from the config', async () => {
	const writeOpus = async (numberOfChannels: number) => {
		const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(source);
		await output.start();

		// 20 ms CELT packets (TOC 0xf8), without a description, as WebCodecs allows for Opus
		for (let i = 0; i < 5; i++) {
			await source.add(
				new EncodedPacket(new Uint8Array([0xf8, 0xff, 0xfe]), 'key', i * 0.02, 0.02),
				i === 0 ? { decoderConfig: { codec: 'opus', numberOfChannels, sampleRate: 44100 } } : undefined,
			);
		}
		await output.finalize();
		return output.target.buffer!;
	};

	for (const numberOfChannels of [1, 2]) {
		using input = new Input({ source: new BufferSource(await writeOpus(numberOfChannels)), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		expect(await track!.getCodec()).toBe('opus');
		expect(await track!.getNumberOfChannels()).toBe(numberOfChannels);
		expect(await track!.computeDuration()).toBe(0.1);

		// Version 1, no pre-skip, the input sample rate, no gain, channel mapping family 0
		const header = new Uint8Array((await track!.getDecoderConfig())!.description as ArrayBuffer);
		expect([...header]).toEqual([
			0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, numberOfChannels, 0, 0, 0x44, 0xac, 0, 0, 0, 0, 0,
		]);
	}

	// More channels need a channel mapping, which only a description can give
	await expect(writeOpus(6)).rejects.toThrow(/description/);
});
