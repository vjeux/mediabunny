import { expect, test } from 'vitest';
import {
	ALL_FORMATS,
	AudioSampleSink,
	BlobSource,
	EncodedPacket,
	EncodedPacketSink,
	Input,
	MP4,
	VideoSampleSink,
} from '../../src/index.js';
import { assert } from '../../src/misc.js';

// Real-world producer: the browser's own MediaRecorder MP4 output (fragmented, written by Chrome's MP4 muxer)

const record = async (mimeType: string, durationMs: number) => {
	const stream = new MediaStream();
	const hasVideo = mimeType.startsWith('video/');

	let interval: ReturnType<typeof setInterval> | null = null;
	if (hasVideo) {
		const canvas = document.createElement('canvas');
		canvas.width = 320;
		canvas.height = 240;
		const context = canvas.getContext('2d')!;
		let frame = 0;
		interval = setInterval(() => {
			context.fillStyle = `hsl(${(frame++ * 7) % 360} 80% 50%)`;
			context.fillRect(0, 0, 320, 240);
		}, 1000 / 30);
		stream.addTrack(canvas.captureStream(30).getVideoTracks()[0]!);
	}

	const audioContext = new AudioContext();
	if (!hasVideo || mimeType.includes('opus')) {
		const oscillator = audioContext.createOscillator();
		const destination = audioContext.createMediaStreamDestination();
		oscillator.connect(destination);
		oscillator.start();
		stream.addTrack(destination.stream.getAudioTracks()[0]!);
	}

	const recorder = new MediaRecorder(stream, { mimeType });
	const chunks: Blob[] = [];
	recorder.ondataavailable = event => chunks.push(event.data);
	const stopped = new Promise(resolve => recorder.onstop = resolve);
	recorder.start(200);
	await new Promise(resolve => setTimeout(resolve, durationMs));
	recorder.stop();
	await stopped;

	if (interval) {
		clearInterval(interval);
	}
	await audioContext.close();

	return new Blob(chunks);
};

const checkRecording = async (mimeType: string, expectedCodecs: string[], decodable: boolean) => {
	using input = new Input({ source: new BlobSource(await record(mimeType, 1000)), formats: ALL_FORMATS });
	expect(await input.getFormat()).toBe(MP4);

	const tracks = await input.getTracks();
	expect(await Promise.all(tracks.map(x => x.getCodec()))).toEqual(expectedCodecs);

	for (const track of tracks) {
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
			packets.push(packet);
		}

		expect(packets.length).toBeGreaterThan(5);
		expect(packets[0]!.type).toBe('key');
		expect(packets[0]!.timestamp).toBe(0);
		// No B-frames: decode order is presentation order
		expect(packets.every((x, i) => i === 0 || x.timestamp > packets[i - 1]!.timestamp)).toBe(true);

		const duration = await track.computeDuration();
		expect(duration).toBeGreaterThan(0.5);
		expect(duration).toBeLessThan(2);

		if (decodable || track.type === 'audio') {
			expect(await track.canDecode()).toBe(true);
			if (track.isVideoTrack()) {
				using sample = await new VideoSampleSink(track).getSample(0);
				assert(sample);
				expect([sample.displayWidth, sample.displayHeight]).toEqual([320, 240]);
			} else if (track.isAudioTrack()) {
				using sample = await new AudioSampleSink(track).getSample(0.5);
				assert(sample);
				expect(sample.sampleRate).toBe(48000);
			}
		}
	}
};

// Not every browser has MediaRecorder (WebKit's WPE port ships without it)
const canRecord = (mimeType: string) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType);

test('reads H.264 MediaRecorder MP4 recordings', async (context) => {
	if (!canRecord('video/mp4;codecs=avc1')) {
		context.skip();
	}
	await checkRecording('video/mp4;codecs=avc1', ['avc'], true);
});

test('reads AV1 and Opus MediaRecorder MP4 recordings', async (context) => {
	if (!canRecord('video/mp4;codecs=av01,opus')) {
		context.skip();
	}
	await checkRecording('video/mp4;codecs=av01,opus', ['av1', 'opus'], true);
});

test('reads VP9 MediaRecorder MP4 recordings', async (context) => {
	if (!canRecord('video/mp4;codecs=vp9')) {
		context.skip();
	}
	// Not decoded: Chrome writes level 0 into vpcC, which ends up in a codec string VideoDecoder rejects
	await checkRecording('video/mp4;codecs=vp9', ['vp9'], false);
});

test('reads Opus MediaRecorder MP4 recordings', async (context) => {
	if (!canRecord('audio/mp4;codecs=opus')) {
		context.skip();
	}
	await checkRecording('audio/mp4;codecs=opus', ['opus'], true);
});
