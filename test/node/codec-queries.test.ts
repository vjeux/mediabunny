import { expect, test } from 'vitest';
import {
	canDecodeAudio,
	canEncodeAudio,
	canEncodeVideo,
	getDecodableAudioCodecs,
	getDecodableVideoCodecs,
	getEncodableAudioCodecs,
	getEncodableSubtitleCodecs,
	getEncodableVideoCodecs,
	getFirstEncodableAudioCodec,
	getFirstEncodableSubtitleCodec,
	getFirstEncodableVideoCodec,
} from '../../src/index.js';

test('Codec support queries validate their options and codec lists', async () => {
	// Like canDecodeVideo/canDecodeAudio, which reject these with the same message
	for (const options of [null, 'stereo', 2]) {
		await expect(canEncodeVideo('avc', options as never)).rejects.toThrow(
			new TypeError('options must be an object.'),
		);
		await expect(canEncodeAudio('pcm-s16', options as never)).rejects.toThrow(
			new TypeError('options must be an object.'),
		);
		await expect(canDecodeAudio('pcm-s16', options as never)).rejects.toThrow(
			new TypeError('options must be an object.'),
		);
	}

	const listQueries = [
		getEncodableVideoCodecs,
		getEncodableAudioCodecs,
		getEncodableSubtitleCodecs,
		getDecodableVideoCodecs,
		getDecodableAudioCodecs,
		getFirstEncodableVideoCodec,
		getFirstEncodableAudioCodec,
		getFirstEncodableSubtitleCodec,
	];
	for (const query of listQueries) {
		for (const checkedCodecs of [null, 'avc', 1]) {
			await expect((query as (codecs: unknown) => Promise<unknown>)(checkedCodecs)).rejects.toThrow(
				new TypeError('checkedCodecs must be an array.'),
			);
		}
	}

	expect(await getFirstEncodableAudioCodec(['aac', 'pcm-s16'])).toBe('pcm-s16');
	expect(await getEncodableAudioCodecs(['pcm-s16', 'pcm-f32'], { numberOfChannels: 1 }))
		.toEqual(['pcm-s16', 'pcm-f32']);
});
