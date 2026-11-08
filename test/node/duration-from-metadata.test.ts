import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, BufferSource, Input, FilePathSource } from '../../src/index.js';
import { assert } from '../../src/misc.js';
import { EncodedPacketSink } from '../../src/media-sink.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicPath = (file: string) => path.join(__dirname, '../public', file);

test('MP4 ISOBMFF duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('video.mp4')),
		formats: ALL_FORMATS,
	});

	expect(await input.getDurationFromMetadata()).toBe(5.056);
	expect(await input.computeDuration()).toBe(5.056);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getDurationFromMetadata()).toBe(5);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getDurationFromMetadata()).toBe(5.056);
});

test('Matroska MKV duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('ac3.mkv')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFirstTimestamp()).toBe(-0.005);
	expect(await input.getDurationFromMetadata()).toBe(1.995);
	expect(await input.computeDuration()).toBe(1.995);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getFirstTimestamp()).toBe(-0.005);
	expect(await audioTrack.getDurationFromMetadata()).toBe(1.995);
});

test('MPEG-TS duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('0.ts')),
		formats: ALL_FORMATS,
	});

	expect(await input.getDurationFromMetadata()).toBe(null);
	expect(await input.computeDuration()).not.toBe(null);

	const tracks = await input.getTracks();
	for (const track of tracks) {
		expect(await track.getDurationFromMetadata()).toBe(null);
	}
});

test('FLAC duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('sample.flac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getDurationFromMetadata()).toBe(19.714285714285715);
	expect(await input.computeDuration()).toBe(19.714285714285715);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getDurationFromMetadata()).toBe(19.714285714285715);
});

test('WAV duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('glitch-hop-is-dead.wav')),
		formats: ALL_FORMATS,
	});

	expect(await input.getDurationFromMetadata()).toBe(9.63718820861678);
	expect(await input.computeDuration()).toBe(9.63718820861678);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getDurationFromMetadata()).toBe(9.63718820861678);
});

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, joint stereo, no CRC
const FRAME_HEADER = [0xff, 0xfb, 0x90, 0x64];
const FRAME_SIZE = 417;

// MPEG-1 Layer II, 192 kbps, 44.1 kHz, stereo, no CRC
const LAYER_2_FRAME_HEADER = [0xff, 0xfd, 0xa0, 0x04];
const LAYER_2_FRAME_SIZE = 626;

const textEncoder = new TextEncoder();

test('VBRI header', async () => {
	const frameCount = 10;
	using input = new Input({
		source: new BufferSource(concat(
			vbriFrame(frameCount, FRAME_SIZE * (frameCount + 1)),
			...Array.from({ length: frameCount }, createMp3Frame),
		)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getDurationFromMetadata()).toBe(frameCount * 1152 / 44100);

	// Like the Xing frame, the VBRI frame holds no audio
	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual(Array.from({ length: frameCount }, (_, i) => i * 1152 / 44100));
});

const vbriFrame = (frameCount: number, byteCount: number) => {
	const frame = createMp3Frame();
	const view = new DataView(frame.buffer);

	frame.set(textEncoder.encode('VBRI'), 36);
	view.setUint16(40, 1); // Version
	view.setUint32(46, byteCount);
	view.setUint32(50, frameCount);

	return frame;
};

test('VBRI-like bytes in Layer II', async () => {
	// VBRI headers only exist for Layer III
	const frames = Array.from({ length: 10 }, createLayer2Frame);
	frames[0]!.set(textEncoder.encode('VBRI'), 36);
	new DataView(frames[0]!.buffer).setUint16(40, 1); // Version

	using input = new Input({
		source: new BufferSource(concat(...frames)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;

	let packetCount = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		expect(packet.byteLength).toBe(LAYER_2_FRAME_SIZE);
		packetCount++;
	}
	expect(packetCount).toBe(10);
});

const createMp3Frame = () => {
	const frame = new Uint8Array(FRAME_SIZE);
	frame.set(FRAME_HEADER);
	return frame;
};

const createLayer2Frame = () => {
	const frame = new Uint8Array(LAYER_2_FRAME_SIZE);
	frame.set(LAYER_2_FRAME_HEADER);
	return frame;
};

const concat = (...parts: (Uint8Array | number[])[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}

	return result;
};

test('OGG Vorbis duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('vorbis-eos.ogg')),
		formats: ALL_FORMATS,
	});

	expect(await input.getDurationFromMetadata()).toBe(null);

	const tracks = await input.getTracks();
	for (const track of tracks) {
		expect(await track.getDurationFromMetadata()).toBe(null);
	}
});

test('ADTS AAC duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('sample3.aac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getDurationFromMetadata()).toBe(null);

	const tracks = await input.getTracks();
	for (const track of tracks) {
		expect(await track.getDurationFromMetadata()).toBe(null);
	}
});

test('MP3 duration metadata', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('Toothsome-Meme.VBRv2.mp3')),
		formats: ALL_FORMATS,
	});

	// The LAME tag declares 1,681 encoder samples plus the 529-sample decoder delay.
	const expectedDuration = (38.568 * 48000 - 2210) / 48000;
	expect(await input.getDurationFromMetadata()).toBe(expectedDuration);
	expect(await input.computeDuration()).toBe(expectedDuration);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getDurationFromMetadata()).toBe(expectedDuration);
});
