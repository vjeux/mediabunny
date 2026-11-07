import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BlobSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, VideoSampleSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

test('Encrypted MP4 without senc', async () => {
	using input = new Input({
		source: new UrlSource('/639955605-b752f7ad-7ce8-43c2-8ae9-88e74c6ae696.mp4'),
		formats: ALL_FORMATS,
		formatOptions: {
			isobmff: {
				resolveKeyId: () => 'aabbccddeeff00112233445566778899',
			},
		},
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	// Test that it can decode
	const sink = new AudioSampleSink(audioTrack);
	using firstSample = await sink.getSample(0);
	assert(firstSample);
	expect(firstSample.timestamp).toBe(0);
});

test('Decode a VP9 MP4 recording from MediaRecorder', async (context) => {
	// Chrome writes level 0 into the vpcC box of these recordings
	const mimeType = 'video/mp4;codecs=vp9';
	// WebKit's WPE port has no MediaRecorder
	if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(mimeType)) {
		context.skip();
	}

	const canvas = document.createElement('canvas');
	canvas.width = 320;
	canvas.height = 240;
	const canvasContext = canvas.getContext('2d')!;
	const stream = canvas.captureStream(30);

	let frame = 0;
	const interval = setInterval(() => {
		canvasContext.fillStyle = `hsl(${(frame++ * 7) % 360} 80% 50%)`;
		canvasContext.fillRect(0, 0, 320, 240);
	}, 1000 / 30);

	const recorder = new MediaRecorder(stream, { mimeType });
	const chunks: Blob[] = [];
	recorder.ondataavailable = event => chunks.push(event.data);
	const stopped = new Promise(resolve => recorder.onstop = resolve);
	recorder.start();
	await new Promise(resolve => setTimeout(resolve, 1000));
	recorder.stop();
	await stopped;
	clearInterval(interval);

	using input = new Input({ source: new BlobSource(new Blob(chunks)), formats: ALL_FORMATS });
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getCodec()).toBe('vp9');
	expect(await videoTrack.canDecode()).toBe(true);

	using sample = await new VideoSampleSink(videoTrack).getSample(0);
	assert(sample);
	expect(sample.displayWidth).toBe(320);
});
