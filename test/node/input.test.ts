import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input, UnsupportedInputFormatError } from '../../src/input.js';
import { ADTS, ALL_FORMATS, FLAC, MP3, OGG, WAVE } from '../../src/input-format.js';
import { BufferSource } from '../../src/source.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Disposing after failed format detection does not emit an unhandled rejection', async () => {
	const input = new Input({
		source: new BufferSource(new Uint8Array([1, 2, 3, 4])),
		formats: ALL_FORMATS,
	});

	await expect(input.getFormat()).rejects.toThrow(UnsupportedInputFormatError);

	const unhandledRejections: unknown[] = [];
	const onUnhandledRejection = (reason: unknown) => {
		unhandledRejections.push(reason);
	};

	process.on('unhandledRejection', onUnhandledRejection);
	try {
		input.dispose();
		await new Promise(resolve => setTimeout(resolve, 0));
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	expect(unhandledRejections).toEqual([]);
});

test('MP3 detection does not claim files of other containers', async () => {
	// With a format list like an audio-only app would use, this QuickTime file used to be read as MP3, since its sample
	// tables happen to contain two consecutive "frame headers"
	const mov = new Uint8Array(readFileSync(path.join(__dirname, '../public/trunc-buck-bunny.mov')));
	using movInput = new Input({ source: new BufferSource(mov), formats: [MP3, WAVE, FLAC, OGG, ADTS] });
	await expect(movInput.getFormat()).rejects.toThrow(UnsupportedInputFormatError);

	// A WAVE file holding MPEG audio frames is still read as WAVE, as it would be with ALL_FORMATS
	const frames = new Uint8Array(3 * 417);
	for (let i = 0; i < 3; i++) {
		frames.set([0xff, 0xfb, 0x90, 0x00], i * 417);
	}
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const u32le = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
	const fmt = [1, 0, 2, 0, ...u32le(44100), ...u32le(44100 * 4), 4, 0, 16, 0]; // PCM, stereo, 16-bit
	const wav = new Uint8Array([
		...ascii('RIFF'), ...u32le(4 + 8 + fmt.length + 8 + frames.length), ...ascii('WAVE'),
		...ascii('fmt '), ...u32le(fmt.length), ...fmt,
		...ascii('data'), ...u32le(frames.length), ...frames,
	]);
	using wavInput = new Input({ source: new BufferSource(wav), formats: [MP3, WAVE] });
	expect(await wavInput.getFormat()).toBe(WAVE);

	// MPEG-TS whose first packet holds small MP3 frames (8 kbps at 16 kHz, 36 bytes each) back to back
	const ts = new Uint8Array(5 * 188);
	for (let i = 0; i < 5; i++) {
		ts.set([0x47, 0x01, 0x00, 0x10], i * 188);
	}
	for (let pos = 4; pos + 4 <= 188; pos += 36) {
		ts.set([0xff, 0xf3, 0x18, 0xc0], pos);
	}
	using tsInput = new Input({ source: new BufferSource(ts), formats: [MP3, WAVE, FLAC, OGG, ADTS] });
	await expect(tsInput.getFormat()).rejects.toThrow(UnsupportedInputFormatError);

	// But MP3 data that merely holds 0x47 at the starts of the first two 188-byte packets (cut out of a stream, say)
	// is still MP3, since MPEG-TS has a sync byte at the start of every packet
	const mp3 = new Uint8Array([0x47, ...frames]);
	mp3[188] = 0x47;
	using mp3Input = new Input({ source: new BufferSource(mp3), formats: [MP3] });
	expect(await mp3Input.getFormat()).toBe(MP3);
});
