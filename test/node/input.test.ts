import { expect, test } from 'vitest';
import { Input, UnsupportedInputFormatError } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource } from '../../src/source.js';

test('A WAVE file holding MPEG audio is read as MP3', async () => {
	// "RIFF MP3", as written by Windows' ACM codecs or FFmpeg (`ffmpeg -i in.wav -c:a libmp3lame out.wav`): the "fmt "
	// chunk has an MPEG audio format tag, and the data chunk holds a plain MPEG audio stream
	const le16 = (value: number) => [value & 0xff, value >> 8];
	const le32 = (value: number) => [...le16(value & 0xffff), ...le16(value >>> 16)];
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const makeFile = (formatTag: number, frameHeader: number[], frameSize: number) => {
		const frame = [...frameHeader, ...new Array<number>(frameSize - frameHeader.length).fill(0)];
		const data = Array.from({ length: 40 }, () => frame).flat();
		const fmt = [...le16(formatTag), ...le16(1), ...le32(44100), ...le32(16000), ...le16(1), ...le16(0)];
		const body = [
			...ascii('WAVE'),
			...ascii('fmt '), ...le32(fmt.length), ...fmt,
			...ascii('data'), ...le32(data.length), ...data,
		];
		return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body]);
	};
	const readFile = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return [(await input.getFormat()).name, await input.computeDuration()];
	};

	// 40 frames of 1152 samples at 44.1 kHz, mono: MPEG-1 Layer III at 128 kbit/s, and Layer II at 192 kbit/s
	const duration = 40 * 1152 / 44100;
	expect(await readFile(makeFile(0x0055, [0xff, 0xfb, 0x90, 0xc0], 417))).toEqual(['MP3', duration]);
	expect(await readFile(makeFile(0x0050, [0xff, 0xfd, 0xa0, 0xc0], 626))).toEqual(['MP3', duration]);
});

test('MP3 in a WAVE file is read from the data chunk only', async () => {
	// Taggers append chunks to WAVE files, like an id3 chunk after the data chunk. Its bytes aren't audio, so they
	// mustn't count toward the duration estimate or be searched for frames
	const le16 = (value: number) => [value & 0xff, value >> 8];
	const le32 = (value: number) => [...le16(value & 0xffff), ...le16(value >>> 16)];
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const chunk = (id: string, body: number[]) => [
		...ascii(id), ...le32(body.length), ...body, ...(body.length % 2 ? [0] : []),
	];

	// 10 frames of 1152 samples at 44.1 kHz, mono, MPEG-1 Layer III at 128 kbit/s
	const frame = [0xff, 0xfb, 0x90, 0xc0, ...new Array<number>(413).fill(0)];
	const fmt = [...le16(0x0055), ...le16(1), ...le32(44100), ...le32(16000), ...le16(1), ...le16(0)];
	const tit2 = [...ascii('TIT2'), 0, 0, 0, 6, 0, 0, 0, ...ascii('Title')];
	const priv = [...ascii('PRIV'), 0, 0, 0x9c, 0x40, 0, 0, ...new Array<number>(20000).fill(0x55)];
	const id3 = [...ascii('ID3'), 3, 0, 0, 0, 0, (tit2.length + priv.length) >> 7, (tit2.length + priv.length) & 0x7f];
	const body = [
		...ascii('WAVE'),
		...chunk('fmt ', fmt),
		...chunk('LIST', [...ascii('INFO'), ...chunk('IART', [...ascii('Artist'), 0])]),
		...chunk('data', Array.from({ length: 10 }, () => frame).flat()),
		...chunk('id3 ', [...id3, ...tit2, ...priv]),
	];

	using input = new Input({
		source: new BufferSource(new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body])),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getDurationFromMetadata()).toBe(10 * 1152 / 44100);
	expect(await track.computeDuration()).toBe(10 * 1152 / 44100);
});

test('MP3 in a WAVE file whose data chunk starts far in is read as MP3', async () => {
	// Recorders and broadcast systems put alignment (JUNK) chunks or a long bext chunk in front of the data, so the
	// frames can start more than the first few KB into the file
	const le16 = (value: number) => [value & 0xff, value >> 8];
	const le32 = (value: number) => [...le16(value & 0xffff), ...le16(value >>> 16)];
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const chunk = (id: string, body: number[]) => [...ascii(id), ...le32(body.length), ...body];

	// 10 frames of 1152 samples at 44.1 kHz, mono, MPEG-1 Layer III at 128 kbit/s
	const frame = [0xff, 0xfb, 0x90, 0xc0, ...new Array<number>(413).fill(0)];
	const fmt = [...le16(0x0055), ...le16(1), ...le32(44100), ...le32(16000), ...le16(1), ...le16(0)];
	const body = [
		...ascii('WAVE'),
		...chunk('fmt ', fmt),
		...chunk('JUNK', new Array<number>(4096).fill(0)),
		...chunk('data', Array.from({ length: 10 }, () => frame).flat()),
	];

	using input = new Input({
		source: new BufferSource(new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body])),
		formats: ALL_FORMATS,
	});
	expect((await input.getFormat()).name).toBe('MP3');
	const track = (await input.getPrimaryAudioTrack())!;
	expect((await track.computePacketStats()).packetCount).toBe(10);
	expect(await track.computeDuration()).toBe(10 * 1152 / 44100);
});

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
