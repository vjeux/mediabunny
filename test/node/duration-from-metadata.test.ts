import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, BufferSource, Input, FilePathSource } from '../../src/index.js';
import { assert } from '../../src/misc.js';

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

test('MP3 duration metadata of joined files, where the Xing/Info header only covers the first one', async () => {
	// MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono: 417 bytes and 1152 samples per frame
	const frame = () => {
		const bytes = new Uint8Array(417);
		bytes.set([0xff, 0xfb, 0x90, 0xc0]);
		return bytes;
	};
	// A LAME-style Info (CBR) frame in front of the given number of frames, declaring their count and size
	const stream = (frameCount: number) => {
		const info = frame();
		info.set([...'Info'].map(char => char.charCodeAt(0)), 4 + 17); // Behind the side information
		const view = new DataView(info.buffer);
		view.setUint32(4 + 17 + 4, 0x3); // Frame count and byte count present
		view.setUint32(4 + 17 + 8, frameCount);
		view.setUint32(4 + 17 + 12, (frameCount + 1) * 417);
		return [info, ...Array.from({ length: frameCount }, frame)];
	};
	const metadataDuration = async (frames: Uint8Array[]) => {
		const bytes = new Uint8Array(frames.length * 417);
		frames.forEach((frame, i) => bytes.set(frame, i * 417));
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return await input.getDurationFromMetadata();
	};

	// One stream: its header's frame count
	expect(await metadataDuration(stream(383))).toBeCloseTo(383 * 1152 / 44100, 6);

	// 1 s, then 10 s without a header (`cat ad.mp3 episode.mp3`, as with podcast ad insertion). FFmpeg detects an
	// "invalid concatenated file" (the file is over 1/16 larger than the header's byte count) and goes by the bitrate.
	expect(await metadataDuration([...stream(38), ...stream(383).slice(1)])).toBeCloseTo(421 * 1152 / 44100, 1);

	// A file cut off within the stream still gets the header's frame count
	expect(await metadataDuration(stream(383).slice(0, 200))).toBeCloseTo(383 * 1152 / 44100, 6);
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
