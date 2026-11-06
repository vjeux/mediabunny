import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, AudioSampleSink, EncodedPacketSink, Input, FilePathSource } from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Should handle WAV file with oversized ID3 chunk', async () => {
	const filePath = path.join(__dirname, '..', 'public/oversized-id3.wav');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track found');
	}

	const sink = new EncodedPacketSink(track);

	for await (const packet of sink.packets()) {
		void packet;
	}
});

test('samplesAtTimestamps rejects non-iterable timestamps with a TypeError', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav')),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	const sink = new AudioSampleSink(track!);

	for (const timestamps of [null, undefined, 5, 'timestamps']) {
		expect(() => sink.samplesAtTimestamps(timestamps as never)).toThrow(
			new TypeError('Argument must be an iterable or async iterable.'),
		);
	}
});
