import { expect, test } from 'vitest';
import { decodesVorbis } from './helpers/platform-probes.js';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioBufferSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

// VLC creates OGG files with an empty EOS page, which previously caused decoding errors
test('can decode OGG Vorbis file with empty EOS page', async ({ skip }) => {
	using input = new Input({
		source: new UrlSource('/vorbis-eos.ogg'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	skip(!await decodesVorbis(), 'the platform can\'t decode Vorbis (native probe)');

	const sink = new AudioBufferSink(track);
	const buffers: AudioBuffer[] = [];

	for await (const { buffer } of sink.buffers(4, 10)) {
		buffers.push(buffer);
	}

	expect(buffers.length).toBeGreaterThan(0);
});
