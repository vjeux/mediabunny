import { expect, test } from 'vitest';
import {
	CustomAudioDecoder,
	CustomVideoEncoder,
	registerDecoder,
	registerEncoder,
	registerVideoSampleTransformer,
	VideoSample,
} from '../../src/index.js';

test('registration functions reject missing coders and non-function transformers', async () => {
	for (const value of [undefined, null]) {
		expect(() => registerDecoder(value as never)).toThrow(
			new TypeError('Decoder must be a CustomVideoDecoder or CustomAudioDecoder.'),
		);
		expect(() => registerEncoder(value as never)).toThrow(
			new TypeError('Encoder must be a CustomVideoEncoder or CustomAudioEncoder.'),
		);
	}
	// The base classes themselves aren't implementations
	expect(() => registerDecoder(CustomAudioDecoder)).toThrow(TypeError);
	expect(() => registerEncoder(CustomVideoEncoder)).toThrow(TypeError);

	for (const value of [undefined, null, 'transform', {}]) {
		expect(() => registerVideoSampleTransformer(value as never)).toThrow(
			new TypeError('transformer must be a function.'),
		);
	}

	// A rejected transformer must not end up in the registry, where every later transform would call it
	using sample = new VideoSample(new Uint8Array(16), { format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 0 });
	await expect(sample.transform({ width: 4 })).rejects.toThrow('Cannot transform VideoSamples in this environment.');
});
