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
	];
	for (const query of listQueries) {
		for (const checkedCodecs of [null, 'avc', 1]) {
			await expect((query as (codecs: unknown) => Promise<unknown>)(checkedCodecs)).rejects.toThrow(
				new TypeError('checkedCodecs must be an array.'),
			);
		}
	}
	// These only iterate over the codecs, so any iterable works (but not a string, which yields characters)
	const firstQueries = [getFirstEncodableVideoCodec, getFirstEncodableAudioCodec, getFirstEncodableSubtitleCodec];
	for (const query of firstQueries) {
		for (const checkedCodecs of [undefined, null, 'avc', 1, {}]) {
			await expect((query as (codecs: unknown) => Promise<unknown>)(checkedCodecs)).rejects.toThrow(
				new TypeError('checkedCodecs must be an iterable of codecs.'),
			);
		}
	}

	expect(await getFirstEncodableAudioCodec(['aac', 'pcm-s16'])).toBe('pcm-s16');
	expect(await getFirstEncodableAudioCodec(new Set(['aac', 'pcm-s16']) as never)).toBe('pcm-s16');
	expect(await getFirstEncodableSubtitleCodec((function* () {
		yield 'webvtt' as const;
	})() as never)).toBe('webvtt');
	expect(await getEncodableAudioCodecs(['pcm-s16', 'pcm-f32'], { numberOfChannels: 1 }))
		.toEqual(['pcm-s16', 'pcm-f32']);
});
