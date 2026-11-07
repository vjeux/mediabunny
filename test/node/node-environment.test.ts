import { expect, test } from 'vitest';
import {
	AudioBufferSource,
	AudioSample,
	BufferTarget,
	EncodedPacket,
	MediaStreamAudioTrackSource,
	MediaStreamVideoTrackSource,
	Output,
	Quality,
	WavOutputFormat,
} from '../../src/index.js';

// Node has neither WebCodecs nor Web Audio. APIs built on them must fail with deliberate errors there, like
// EncodedPacket.toEncodedVideoChunk() does, instead of ReferenceErrors from the missing globals.
test('Browser-only APIs fail with deliberate errors when their globals are missing', async () => {
	expect(() => EncodedPacket.fromEncodedChunk({} as never)).toThrow(
		new TypeError('chunk must be an EncodedVideoChunk or EncodedAudioChunk.'),
	);

	using sample = new AudioSample({
		data: new Float32Array(2),
		format: 'f32',
		numberOfChannels: 1,
		sampleRate: 48000,
		timestamp: 0,
	});
	expect(() => sample.toAudioData()).toThrow(new Error('AudioData is not available in this environment.'));
	expect(() => sample.toAudioBuffer()).toThrow(new Error('AudioBuffer is not available in this environment.'));
	expect(() => AudioSample.fromAudioBuffer({} as never, 0)).toThrow(
		new TypeError('audioBuffer must be an AudioBuffer.'),
	);

	const source = new AudioBufferSource({ codec: 'pcm-s16' });
	const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
	output.addAudioTrack(source);
	await output.start();
	await expect(source.add({} as never)).rejects.toThrow(new TypeError('audioBuffer must be an AudioBuffer.'));
	await output.cancel();

	const quality = new Quality('medium');
	expect(() => new MediaStreamVideoTrackSource({} as never, { codec: 'avc', quality })).toThrow(
		new TypeError('track must be a video MediaStreamTrack.'),
	);
	expect(() => new MediaStreamAudioTrackSource({} as never, { codec: 'opus', quality })).toThrow(
		new TypeError('track must be an audio MediaStreamTrack.'),
	);
});
