import { expect, test } from 'vitest';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { EncodedPacket } from '../../src/packet.js';

test('VideoSample creation from bytes', async () => {
	const bytes = new Uint8Array(1024);
	const sample = new VideoSample(bytes, {
		codedWidth: 1280,
		codedHeight: 720,
		format: 'RGBA',
		timestamp: 0,
	});

	sample.close();
});

test('AudioSample creation from bytes', async () => {
	const bytes = new Uint8Array(1024);
	const sample = new AudioSample({
		data: bytes,
		numberOfChannels: 2,
		format: 's16',
		sampleRate: 48000,
		timestamp: 0,
	});

	sample.close();
});

test('Missing data is rejected with the intended TypeError', () => {
	for (const data of [undefined, null]) {
		expect(() => new EncodedPacket(data as never, 'key', 0, 0)).toThrow(
			new TypeError('data must be a Uint8Array.'),
		);
		expect(() => new AudioSample({
			data: data as never,
			format: 's16',
			numberOfChannels: 2,
			sampleRate: 48000,
			timestamp: 0,
		})).toThrow(new TypeError('Invalid AudioDataInit: data is not a BufferSource.'));
	}
});
