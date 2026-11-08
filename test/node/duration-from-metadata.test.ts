import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	BufferSource,
	Input,
	FilePathSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
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

	// A frame count whose frames hold fewer samples than the delays, like one MPEG-2 frame of 576 samples, gives 0
	const mpeg2Frame = () => {
		const bytes = new Uint8Array(208); // MPEG-2 Layer III, 64 kbps, 22.05 kHz, mono
		bytes.set([0xff, 0xf3, 0x80, 0xc0]);
		return bytes;
	};
	const header = mpeg2Frame();
	const view = new DataView(header.buffer);
	header.set([...'Info'].map(char => char.charCodeAt(0)), 4 + 9); // Behind the side information
	view.setUint32(4 + 9 + 4, 0x3); // Frame count and byte count present
	view.setUint32(4 + 9 + 8, 1);
	view.setUint32(4 + 9 + 12, 2 * 208);
	header.set([...'LAME3.100'].map(char => char.charCodeAt(0)), 4 + 9 + 16);
	header.set([576 >> 4, (576 & 0xf) << 4], 4 + 9 + 16 + 21);

	using input = new Input({
		source: new BufferSource(new Uint8Array([...header, ...mpeg2Frame()])),
		formats: ALL_FORMATS,
	});
	expect(await input.getDurationFromMetadata()).toBe(0);
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
	const metadataDuration = async (parts: Uint8Array[]) => {
		const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
		let offset = 0;
		for (const part of parts) {
			bytes.set(part, offset);
			offset += part.length;
		}
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return await input.getDurationFromMetadata();
	};
	const ascii = (text: string) => new Uint8Array([...text].map(char => char.charCodeAt(0)));
	const id3V1Tag = new Uint8Array(128);
	id3V1Tag.set(ascii('TAGTitle'));
	// An ID3v2.4 tag with a footer, as appended at the end of a file, holding a TIT2 frame and padding
	const appendedId3V2Tag = new Uint8Array(10 + 65536 + 10);
	appendedId3V2Tag.set([...ascii('ID3'), 4, 0, 0x10, 0, 4, 0, 0]);
	appendedId3V2Tag.set([...ascii('TIT2'), 0, 0, 0, 6, 0, 0, 0, ...ascii('Title')], 10);
	appendedId3V2Tag.set([...ascii('3DI'), 4, 0, 0x10, 0, 4, 0, 0], 10 + 65536);
	const lyrics3V2Tag = (() => {
		const block = `LYRICSBEGININD00003110LYR30000${'x'.repeat(30000)}`;
		return ascii(`${block}${String(block.length).padStart(6, '0')}LYRICS200`);
	})();

	// One stream: its header's frame count
	const tenSeconds = 383 * 1152 / 44100;
	expect(await metadataDuration(stream(383))).toBeCloseTo(tenSeconds, 6);

	// 1 s, then 10 s without a header (`cat ad.mp3 episode.mp3`, as with podcast ad insertion). FFmpeg detects an
	// "invalid concatenated file" (the file is over 1/16 larger than the header's byte count) and goes by the bitrate.
	const elevenSeconds = 421 * 1152 / 44100;
	expect(await metadataDuration([...stream(38), ...stream(383).slice(1)])).toBeCloseTo(elevenSeconds, 1);
	// Also when the first file ends with an ID3v1 tag and the second one starts with an ID3v2 tag
	const id3V2Tag = appendedId3V2Tag.slice(0, 20 + 6);
	id3V2Tag.set([...ascii('ID3'), 4, 0, 0, 0, 0, 0, 16]);
	expect(await metadataDuration([...stream(38), id3V1Tag, id3V2Tag, ...stream(383)])).toBeCloseTo(elevenSeconds, 1);

	// Tags or other data behind a single stream don't make it joined: an ID3v1 tag behind a Lyrics3v2 tag, as Winamp
	// and Mp3tag write them, an appended ID3v2 tag, or junk
	for (const trailer of [[lyrics3V2Tag, id3V1Tag], [appendedId3V2Tag], [new Uint8Array(20000)]]) {
		expect(await metadataDuration([...stream(383), ...trailer])).toBeCloseTo(tenSeconds, 6);
	}

	// A file cut off within the stream still gets the header's frame count
	expect(await metadataDuration(stream(383).slice(0, 200))).toBeCloseTo(tenSeconds, 6);
});

test('MP3 duration metadata ignores a Lyrics3v2 tag at the end of the file', async () => {
	// A VBR file with a Xing header, then a Lyrics3v2 tag and an ID3v1 tag, as Winamp and Mp3tag write them
	const mp3 = new Uint8Array(readFileSync(publicPath('Toothsome-Meme.VBRv2.mp3')));
	const encoder = new TextEncoder();
	const block = `LYRICSBEGININD00003110LYR30000${'x'.repeat(30000)}`;
	const lyrics3 = encoder.encode(`${block}${String(block.length).padStart(6, '0')}LYRICS200`);
	const id3V1 = new Uint8Array(128);
	id3V1.set(encoder.encode('TAGTitle'));

	const withTags = new Uint8Array(mp3.length + lyrics3.length + id3V1.length);
	withTags.set(mp3, 0);
	withTags.set(lyrics3, mp3.length);
	withTags.set(id3V1, mp3.length + lyrics3.length);

	using plain = new Input({ source: new BufferSource(mp3), formats: ALL_FORMATS });
	const expected = await plain.getDurationFromMetadata();
	expect(expected).not.toBeNull(); // The Xing header's frame count

	using tagged = new Input({ source: new BufferSource(withTags), formats: ALL_FORMATS });
	expect(await tagged.getDurationFromMetadata()).toBe(expected);
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

test('MP3 priming from an iTunes gapless comment', async () => {
	// Apple's encoders write no LAME tag, but an iTunSMPB comment holding the priming (including the decoder delay),
	// the end padding and the sample count, in hex
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const comment = [
		0, // ISO-8859-1
		...ascii('eng'),
		...ascii('iTunSMPB'), 0,
		...ascii(' 00000000 00000210 000003E0 0000000000002710'),
	];
	const frame = [...ascii('COMM'), 0, 0, 0, comment.length, 0, 0, ...comment];
	const tag = [...ascii('ID3'), 3, 0, 0, 0, 0, 0, frame.length, ...frame];

	// 10 silent MPEG-1 Layer III frames, 128 kbps at 44.1 kHz
	const bytes = new Uint8Array(tag.length + 10 * 417);
	bytes.set(tag);
	for (let i = 0; i < 10; i++) {
		bytes.set([0xff, 0xfb, 0x90, 0x00], tag.length + i * 417);
	}

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getFirstTimestamp()).toBe(-528 / 44100);
	expect(await input.computeDuration()).toBe((10 * 1152 - 528) / 44100);
});

test('MP3 priming from an iTunes gapless comment in an ID3v2.4 tag with plain frame sizes', async () => {
	// iTunes writes ID3v2.4 tags whose frame sizes aren't synchsafe. With a frame of 128 bytes or more (like cover art)
	// in front of the iTunSMPB comment, reading its size as synchsafe would step into the middle of the frame.
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const picture = [0, ...ascii('image/png'), 0, 3, 0, ...Array.from({ length: 1000 }, (_, i) => (i * 7) & 0x7f)];
	const comment = [
		0, // ISO-8859-1
		...ascii('eng'),
		...ascii('iTunSMPB'), 0,
		...ascii(' 00000000 00000210 000003E0 0000000000002710'),
	];
	const frames = [
		...ascii('APIC'), ...u32(picture.length), 0, 0, ...picture,
		...ascii('COMM'), ...u32(comment.length), 0, 0, ...comment,
	];
	const synchsafeSize = [
		(frames.length >> 21) & 0x7f, (frames.length >> 14) & 0x7f, (frames.length >> 7) & 0x7f, frames.length & 0x7f,
	];
	const tag = [...ascii('ID3'), 4, 0, 0, ...synchsafeSize, ...frames];

	// 10 silent MPEG-1 Layer III frames, 128 kbps at 44.1 kHz
	const bytes = new Uint8Array(tag.length + 10 * 417);
	bytes.set(tag);
	for (let i = 0; i < 10; i++) {
		bytes.set([0xff, 0xfb, 0x90, 0x00], tag.length + i * 417);
	}

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getFirstTimestamp()).toBe(-528 / 44100);
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

test('Fragmented MP4 duration metadata with a damaged sample table', async () => {
	// Two fragmented PCM tracks, the second of which has an stts box claiming 1000 entries that aren't there
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target: new BufferTarget() });
	const sources = [new EncodedAudioPacketSource('pcm-s16'), new EncodedAudioPacketSource('pcm-s16')];
	for (const source of sources) {
		output.addAudioTrack(source);
	}
	await output.start();
	for (let i = 0; i < 50; i++) {
		for (const source of sources) {
			await source.add(new EncodedPacket(new Uint8Array(320), 'key', i * 0.02, 0.02), {
				decoderConfig: { codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 8000 },
			});
		}
	}
	await output.finalize();
	const bytes = new Uint8Array(output.target.buffer!);

	const sttsPositions: number[] = [];
	for (let i = 0; i + 4 <= bytes.byteLength; i++) {
		if (new TextDecoder().decode(bytes.subarray(i, i + 4)) === 'stts') {
			sttsPositions.push(i);
		}
	}
	new DataView(bytes.buffer).setUint32(sttsPositions[1]! + 8, 1000); // The entry count, after version and flags

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const tracks = await input.getTracks();
	expect(await tracks[0]!.computeDuration()).toBeCloseTo(1, 5);

	// Unknown, as before, rather than an error
	expect(await tracks[1]!.getDurationFromMetadata()).toBe(null);
	expect(await input.getDurationFromMetadata()).toBe(null);
});
