import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	FilePathSource,
	Input,
	Mp4OutputFormat,
	Output,
} from '../../src/index.js';
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

test('Fragmented MP4 duration metadata', async () => {
	// Two seconds of PCM audio, all in fragments
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);
	await output.start();
	for (let i = 0; i < 20; i++) {
		await source.add(new EncodedPacket(new Uint8Array(9600), 'key', i / 10, 1 / 10), {
			decoderConfig: { codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 48000 },
		});
	}
	await output.finalize();
	const file = new Uint8Array(output.target.buffer!);

	const findBox = (bytes: Uint8Array, type: string) => {
		for (let i = 0; i + 8 <= bytes.byteLength; i++) {
			if (new TextDecoder().decode(bytes.subarray(i + 4, i + 8)) === type) {
				return i;
			}
		}

		throw new Error(`No ${type} box`);
	};
	// Writes the duration field of the first box of this type (version 0 mvhd, tkhd or mdhd)
	const setDuration = (bytes: Uint8Array, type: string, duration: number) => {
		const offset = findBox(bytes, type) + 8 + 4 + 8 + (type === 'tkhd' ? 8 : 4);
		expect(bytes[offset - (type === 'tkhd' ? 20 : 16)]).toBe(0); // Version 0
		new DataView(bytes.buffer, bytes.byteOffset).setUint32(offset, duration);
	};
	const readDurations = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		return [await track.getDurationFromMetadata(), await track.computeDuration()];
	};

	// Nothing says how long the fragments are
	expect(await readDurations(file)).toEqual([null, 2]);

	// Chrome's MediaRecorder writes every duration in the moov box in milliseconds, even in the mdhd box (whose
	// timescale is 48000 here). The mdhd box only describes the samples in the moov box anyway, and there are none.
	const chromeLike = file.slice();
	expect(new DataView(chromeLike.buffer).getUint32(findBox(chromeLike, 'mvhd') + 20)).toBe(57600); // Timescale
	setDuration(chromeLike, 'mvhd', 2 * 57600);
	setDuration(chromeLike, 'tkhd', 2 * 57600);
	setDuration(chromeLike, 'mdhd', 2000);
	expect(await readDurations(chromeLike)).toEqual([2, 2]);

	// The mehd box gives the duration including the fragments, in the movie timescale
	const mvex = findBox(file, 'mvex');
	const moov = findBox(file, 'moov');
	const mfra = findBox(file, 'mfra'); // Holds moof offsets that inserting a box would invalidate, so drop it
	const mehd = new Uint8Array([0, 0, 0, 16, ...new TextEncoder().encode('mehd'), 0, 0, 0, 0, 0, 0, 0, 0]);
	new DataView(mehd.buffer).setUint32(12, 2.5 * 57600);
	const withMehd = new Uint8Array([...file.subarray(0, mvex + 8), ...mehd, ...file.subarray(mvex + 8, mfra)]);
	const view = new DataView(withMehd.buffer);
	view.setUint32(mvex, view.getUint32(mvex) + 16);
	view.setUint32(moov, view.getUint32(moov) + 16);
	expect(await readDurations(withMehd)).toEqual([2.5, 2]);
});
