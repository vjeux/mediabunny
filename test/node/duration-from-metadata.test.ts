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

test('MP3 duration metadata with a Xing/Info frame count of 0', async () => {
	// MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono: 417 bytes and 1152 samples per frame
	const frame = () => {
		const bytes = new Uint8Array(417);
		bytes.set([0xff, 0xfb, 0x90, 0xc0]);
		return bytes;
	};
	// A Xing or Info frame declaring the given frame count, with a LAME tag giving an encoder delay of 576 samples,
	// followed by 10 frames
	const metadataDuration = async (tag: 'Xing' | 'Info', frameCount: number) => {
		const header = frame();
		const view = new DataView(header.buffer);
		header.set([...tag].map(char => char.charCodeAt(0)), 4 + 17); // Behind the side information
		view.setUint32(4 + 17 + 4, 0x3); // Frame count and byte count present
		view.setUint32(4 + 17 + 8, frameCount);
		view.setUint32(4 + 17 + 12, frameCount === 0 ? 0 : (frameCount + 1) * 417);
		header.set([...'LAME3.100'].map(char => char.charCodeAt(0)), 4 + 17 + 16);
		header.set([576 >> 4, (576 & 0xf) << 4], 4 + 17 + 16 + 21);

		const bytes = new Uint8Array(11 * 417);
		bytes.set(header);
		for (let i = 1; i < 11; i++) {
			bytes.set(frame(), i * 417);
		}

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return await input.getDurationFromMetadata();
	};

	// The 10 frames, less the LAME encoder delay and the decoder delay
	const duration = (10 * 1152 - 576 - 529) / 44100;
	expect(await metadataDuration('Info', 10)).toBe(duration);

	// FFmpeg only takes the duration from a frame count that isn't 0, and estimates it from the bitrate otherwise
	expect(await metadataDuration('Info', 0)).toBeCloseTo(duration, 6);
	// Which for a VBR stream it can't
	expect(await metadataDuration('Xing', 0)).toBe(null);
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
