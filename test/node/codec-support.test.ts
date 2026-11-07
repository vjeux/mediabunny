import { expect, test } from 'vitest';
import {
	AUDIO_CODECS,
	getDecodableAudioCodecs,
	getDecodableVideoCodecs,
	getEncodableAudioCodecs,
	getEncodableSubtitleCodecs,
	getEncodableVideoCodecs,
	getFirstEncodableAudioCodec,
	getFirstEncodableSubtitleCodec,
	getFirstEncodableVideoCodec,
	NON_PCM_AUDIO_CODECS,
	PCM_AUDIO_CODECS,
	SUBTITLE_CODECS,
	VIDEO_CODECS,
} from '../../src/index.js';

test('Codec queries accept the exported codec lists', async () => {
	// The lists are read-only tuples, ordered by encoding preference, so they're the natural input for these queries.
	// Node has no WebCodecs: only Mediabunny's own PCM coders and WebVTT are available.
	expect(await getFirstEncodableAudioCodec(NON_PCM_AUDIO_CODECS)).toBe(null);
	expect(await getFirstEncodableAudioCodec(AUDIO_CODECS)).toBe('pcm-s16');
	expect(await getEncodableAudioCodecs(PCM_AUDIO_CODECS)).toEqual([...PCM_AUDIO_CODECS]);
	expect(await getDecodableAudioCodecs(PCM_AUDIO_CODECS)).toEqual([...PCM_AUDIO_CODECS]);

	expect(await getFirstEncodableVideoCodec(VIDEO_CODECS)).toBe(null);
	expect(await getEncodableVideoCodecs(VIDEO_CODECS)).toEqual([]);
	expect(await getDecodableVideoCodecs(VIDEO_CODECS)).toEqual([]);

	expect(await getFirstEncodableSubtitleCodec(SUBTITLE_CODECS)).toBe('webvtt');
	expect(await getEncodableSubtitleCodecs(SUBTITLE_CODECS)).toEqual(['webvtt']);

	// Mutable arrays keep working
	expect(await getFirstEncodableAudioCodec(['aac', 'ulaw'])).toBe('ulaw');
});
