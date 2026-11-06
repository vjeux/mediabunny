import { describe, expect, test, vi } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { AdtsOutputFormat, Mp3OutputFormat, WavOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { MetadataTags } from '../../src/metadata.js';

// Tests for reading and writing ID3v1 and ID3v2.2/2.3/2.4 tags (https://id3.org/id3v2.3.0,
// https://id3.org/id3v2.4.0-structure, https://id3.org/id3v2.4.0-frames). Tags are built byte by byte and placed in
// front of MP3 frames, which is where they're most common.

type Bytes = number[] | Uint8Array;

const concat = (...parts: Bytes[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
};

const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
const latin1 = (text: string) => [...text].map((char) => {
	const code = char.charCodeAt(0);
	if (code > 0xff) {
		throw new Error('Not ISO-8859-1');
	}
	return code;
});
const utf8 = (text: string) => [...new TextEncoder().encode(text)];
const codeUnits = (text: string) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const utf16Le = (text: string) => codeUnits(text).flatMap(code => [code & 0xff, code >> 8]);
const utf16Be = (text: string) => codeUnits(text).flatMap(code => [code >> 8, code & 0xff]);
const u32Be = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
const synchsafe = (value: number) => [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f];

// ID3v2 text encodings
const LATIN1 = 0;
const UTF16 = 1;
const UTF16BE = 2;
const UTF8 = 3;

const encodeText = (encoding: number, text: string, terminate = false) => {
	switch (encoding) {
		case LATIN1: return [...latin1(text), ...(terminate ? [0] : [])];
		case UTF16: return [0xff, 0xfe, ...utf16Le(text), ...(terminate ? [0, 0] : [])];
		case UTF16BE: return [...utf16Be(text), ...(terminate ? [0, 0] : [])];
		default: return [...utf8(text), ...(terminate ? [0] : [])];
	}
};

const frame = (majorVersion: number, id: string, data: Bytes, flags = 0) => {
	if (majorVersion === 2) {
		return concat(ascii(id), [data.length >> 16, (data.length >> 8) & 0xff, data.length & 0xff], data);
	}

	return concat(
		ascii(id),
		majorVersion === 4 ? synchsafe(data.length) : u32Be(data.length),
		[flags >> 8, flags & 0xff],
		data,
	);
};

const textFrame = (majorVersion: number, id: string, text: string, encoding = LATIN1) =>
	frame(majorVersion, id, [encoding, ...encodeText(encoding, text)]);

const tag = (majorVersion: number, body: Bytes, flags = 0) =>
	concat(ascii('ID3'), [majorVersion, 0, flags], synchsafe(body.length), body);

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, joint stereo: 417 bytes per frame
const MP3_FRAME_SIZE = 417;
const mp3Frames = (count: number) => {
	const frames = new Uint8Array(count * MP3_FRAME_SIZE);
	for (let i = 0; i < count; i++) {
		frames.set([0xff, 0xfb, 0x90, 0x64], i * MP3_FRAME_SIZE);
	}
	return frames;
};

const openFile = (bytes: Uint8Array) => new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

const readTags = async (...parts: Bytes[]) => {
	using input = openFile(concat(...parts, mp3Frames(3)));
	return await input.getMetadataTags();
};

const countPackets = async (input: Input) => {
	const track = await input.getPrimaryAudioTrack();
	let count = 0;
	for await (const packet of new EncodedPacketSink(track!).packets()) {
		void packet;
		count++;
	}
	return count;
};

const writeMp3 = async (tags: MetadataTags) => {
	const output = new Output({ format: new Mp3OutputFormat({ xingHeader: false }), target: new BufferTarget() });
	output.setMetadataTags(tags);
	const source = new EncodedAudioPacketSource('mp3');
	output.addAudioTrack(source);
	await output.start();

	const frames = mp3Frames(2);
	for (let i = 0; i < 2; i++) {
		const packet = new EncodedPacket(
			frames.subarray(i * MP3_FRAME_SIZE, (i + 1) * MP3_FRAME_SIZE),
			'key',
			i * 1152 / 44100,
			1152 / 44100,
		);
		await source.add(packet, { decoderConfig: { codec: 'mp3', numberOfChannels: 2, sampleRate: 44100 } });
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

// Walks the frames of an ID3v2.4 tag written by Mediabunny
const parseWrittenFrames = (bytes: Uint8Array) => {
	expect([...bytes.subarray(0, 5)]).toEqual([...ascii('ID3'), 4, 0]);
	const tagSize = (bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!;
	const frames: { id: string; flags: number; data: Uint8Array }[] = [];

	let pos = 10;
	while (pos < 10 + tagSize) {
		const id = String.fromCharCode(...bytes.subarray(pos, pos + 4));
		const size = (bytes[pos + 4]! << 21) | (bytes[pos + 5]! << 14) | (bytes[pos + 6]! << 7) | bytes[pos + 7]!;
		expect(bytes[pos + 4]! & 0x80).toBe(0); // Synchsafe
		frames.push({
			id,
			flags: (bytes[pos + 8]! << 8) | bytes[pos + 9]!,
			data: bytes.subarray(pos + 10, pos + 10 + size),
		});
		pos += 10 + size;
	}

	expect(pos).toBe(10 + tagSize);
	return frames;
};

describe('ID3v2 tag structure', () => {
	test('reads an ID3v2.3 tag and finds the audio right after it', async () => {
		using input = openFile(concat(
			tag(3, concat(
				textFrame(3, 'TIT2', 'Title'),
				textFrame(3, 'TPE1', 'Artist'),
				textFrame(3, 'TALB', 'Album'),
			)),
			mp3Frames(3),
		));

		const tags = await input.getMetadataTags();
		expect(tags.title).toBe('Title');
		expect(tags.artist).toBe('Artist');
		expect(tags.album).toBe('Album');
		expect(tags.raw!['TIT2']).toBe('Title');
		expect(await countPackets(input)).toBe(3);
	});

	test('reads ID3v2.2 tags with three-character frame IDs', async () => {
		const tags = await readTags(tag(2, concat(
			textFrame(2, 'TT2', 'Title'),
			textFrame(2, 'TT3', 'Subtitle'),
			textFrame(2, 'TP1', 'Artist'),
			textFrame(2, 'TP2', 'Band'),
			textFrame(2, 'TAL', 'Album'),
			textFrame(2, 'TRK', '4/9'),
			textFrame(2, 'TPA', '2/3'),
			textFrame(2, 'TYE', '1999'),
			textFrame(2, 'TCO', '(8)'),
			textFrame(2, 'TBP', '90'),
			frame(2, 'COM', [LATIN1, ...ascii('eng'), 0, ...ascii('Comment')]),
			frame(2, 'ULT', [LATIN1, ...ascii('eng'), 0, ...ascii('Lyrics')]),
			frame(2, 'PIC', [LATIN1, ...ascii('PNG'), 3, ...ascii('Cover'), 0, 0x89, 0x50, 0x4e, 0x47]),
		)));

		expect(tags.title).toBe('Title');
		expect(tags.description).toBe('Subtitle');
		expect(tags.artist).toBe('Artist');
		expect(tags.albumArtist).toBe('Band');
		expect(tags.album).toBe('Album');
		expect(tags.trackNumber).toBe(4);
		expect(tags.tracksTotal).toBe(9);
		expect(tags.discNumber).toBe(2);
		expect(tags.discsTotal).toBe(3);
		expect(tags.date).toEqual(new Date(Date.UTC(1999, 0, 1)));
		expect(tags.genre).toBe('Jazz');
		expect(tags.beatsPerMinute).toBe(90);
		expect(tags.comment).toBe('Comment');
		expect(tags.lyrics).toBe('Lyrics');
		expect(tags.images).toEqual([{
			data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
			mimeType: 'image/png',
			kind: 'coverFront',
			description: 'Cover',
		}]);
	});

	test('maps ID3v2.2 PIC image formats to MIME types', async () => {
		const pic = (format: string) => frame(2, 'PIC', [LATIN1, ...ascii(format), 0, 0, 1, 2]);
		const tags = await readTags(tag(2, concat(pic('JPG'), pic('PNG'), pic('GIF'))));

		expect(tags.images!.map(image => image.mimeType)).toEqual(['image/jpeg', 'image/png', 'image/*']);
	});

	test('reads ID3v2.4 frame sizes as synchsafe integers', async () => {
		// 300 bytes is where the synchsafe and the plain interpretation of the size differ
		const longTitle = 'x'.repeat(299);
		const tags = await readTags(tag(4, concat(
			textFrame(4, 'TIT2', longTitle),
			textFrame(4, 'TPE1', 'Artist'),
		)));

		expect(tags.title).toBe(longTitle);
		expect(tags.artist).toBe('Artist');
	});

	test('reads ID3v2.3 frame sizes as plain integers', async () => {
		const longTitle = 'y'.repeat(299);
		const tags = await readTags(tag(3, concat(
			textFrame(3, 'TIT2', longTitle),
			textFrame(3, 'TPE1', 'Artist'),
		)));

		expect(tags.title).toBe(longTitle);
		expect(tags.artist).toBe('Artist');
	});

	test('skips the ID3v2.3 extended header, whose size excludes itself', async () => {
		const extendedHeader = [...u32Be(6), 0, 0, 0, 0, 0, 0]; // Flags and padding size
		const tags = await readTags(tag(3, concat(extendedHeader, textFrame(3, 'TIT2', 'After')), 0x40));

		expect(tags.title).toBe('After');
	});

	test('skips the ID3v2.4 extended header, whose size includes itself', async () => {
		const extendedHeader = [...synchsafe(6), 1, 0]; // One flag byte, no flags set
		const tags = await readTags(tag(4, concat(extendedHeader, textFrame(4, 'TIT2', 'After')), 0x40));

		expect(tags.title).toBe('After');
	});

	test('skips the ID3v2.4 footer before looking for audio', async () => {
		const body = textFrame(4, 'TIT2', 'Footer');
		const footer = concat(ascii('3DI'), [4, 0, 0x10], synchsafe(body.length));

		using input = openFile(concat(tag(4, body, 0x10), footer, mp3Frames(3)));
		expect((await input.getMetadataTags()).title).toBe('Footer');
		expect(await countPackets(input)).toBe(3);
	});

	test('stops at the padding after the last frame', async () => {
		using input = openFile(concat(
			tag(3, concat(textFrame(3, 'TIT2', 'Padded'), new Uint8Array(1000))),
			mp3Frames(3),
		));

		const tags = await input.getMetadataTags();
		expect(tags.title).toBe('Padded');
		expect(Object.keys(tags.raw!)).toEqual(['TIT2']);
		expect(await countPackets(input)).toBe(3);
	});

	test('reads multiple consecutive tags, where the first one takes precedence', async () => {
		using input = openFile(concat(
			tag(3, concat(textFrame(3, 'TIT2', 'First'), textFrame(3, 'TPE1', 'First artist'))),
			tag(4, concat(textFrame(4, 'TIT2', 'Second'), textFrame(4, 'TALB', 'Second album'))),
			mp3Frames(3),
		));

		const tags = await input.getMetadataTags();
		expect(tags.title).toBe('First');
		expect(tags.artist).toBe('First artist');
		expect(tags.album).toBe('Second album');
		expect(await countPackets(input)).toBe(3);
	});

	test('skips tags of an unsupported major version but still finds the audio', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			using input = openFile(concat(tag(5, textFrame(3, 'TIT2', 'Future')), mp3Frames(3)));

			const tags = await input.getMetadataTags();
			expect(tags.title).toBeUndefined();
			expect(await countPackets(input)).toBe(3);
			expect(warn).toHaveBeenCalledWith('Unsupported ID3v2 major version: 5');
		} finally {
			warn.mockRestore();
		}
	});
});

describe('ID3v2 text encodings', () => {
	test('reads ISO-8859-1 text', async () => {
		const tags = await readTags(tag(3, frame(3, 'TIT2', [LATIN1, 0x43, 0x61, 0x66, 0xe9, 0x20, 0xbf, 0xff])));
		expect(tags.title).toBe('Café ¿ÿ');
	});

	test('reads UTF-16 text with either byte order mark', async () => {
		const tags = await readTags(tag(3, concat(
			frame(3, 'TIT2', [UTF16, 0xff, 0xfe, ...utf16Le('Little ✓')]),
			frame(3, 'TPE1', [UTF16, 0xfe, 0xff, ...utf16Be('Big ✓')]),
		)));

		expect(tags.title).toBe('Little ✓');
		expect(tags.artist).toBe('Big ✓');
	});

	test('reads UTF-16BE text without byte order mark', async () => {
		const tags = await readTags(tag(4, textFrame(4, 'TIT2', 'Ünïcode ✓', UTF16BE)));
		expect(tags.title).toBe('Ünïcode ✓');
	});

	test('reads UTF-8 text', async () => {
		const tags = await readTags(tag(4, textFrame(4, 'TIT2', '鱼 and 🐟', UTF8)));
		expect(tags.title).toBe('鱼 and 🐟');
	});

	test('reads characters outside the BMP in UTF-16', async () => {
		const tags = await readTags(tag(3, textFrame(3, 'TIT2', '🐟 fish', UTF16)));
		expect(tags.title).toBe('🐟 fish');
	});

	test('stops text at its terminator', async () => {
		for (const encoding of [LATIN1, UTF16, UTF16BE, UTF8]) {
			const majorVersion = encoding >= UTF16BE ? 4 : 3;
			const tags = await readTags(tag(majorVersion, frame(majorVersion, 'TIT2', [
				encoding,
				...encodeText(encoding, 'Terminated', true),
				...encodeText(encoding, 'garbage'),
			])));

			expect(tags.title).toBe('Terminated');
		}
	});

	test('reads empty text frames as empty strings', async () => {
		const tags = await readTags(tag(3, concat(frame(3, 'TPE1', [LATIN1]), textFrame(3, 'TIT2', 'Title'))));
		expect(tags.raw!['TPE1']).toBe('');
		expect(tags.title).toBe('Title');
	});
});

describe('ID3v2 frames', () => {
	test('reads track and disc numbers with and without totals', async () => {
		const tags = await readTags(tag(3, concat(textFrame(3, 'TRCK', '3/12'), textFrame(3, 'TPOS', '2'))));

		expect(tags.trackNumber).toBe(3);
		expect(tags.tracksTotal).toBe(12);
		expect(tags.discNumber).toBe(2);
		expect(tags.discsTotal).toBeUndefined();
	});

	test('ignores track and disc numbers that aren\'t positive integers', async () => {
		const tags = await readTags(tag(3, concat(textFrame(3, 'TRCK', '0/0'), textFrame(3, 'TPOS', 'A/B'))));

		expect(tags.trackNumber).toBeUndefined();
		expect(tags.tracksTotal).toBeUndefined();
		expect(tags.discNumber).toBeUndefined();
		expect(tags.discsTotal).toBeUndefined();
	});

	test('maps numeric genres to the ID3v1 genre list', async () => {
		const genreOf = async (majorVersion: number, text: string) =>
			(await readTags(tag(majorVersion, textFrame(majorVersion, 'TCON', text)))).genre;

		expect(await genreOf(3, '(17)')).toBe('Rock');
		expect(await genreOf(3, '(0)')).toBe('Blues');
		expect(await genreOf(3, '(4)Eurodisco')).toBe('Disco'); // A refinement of the numeric genre
		expect(await genreOf(4, '17')).toBe('Rock'); // ID3v2.4 drops the parentheses
		expect(await genreOf(4, '191')).toBe('Psybient'); // Last Winamp extension
		expect(await genreOf(3, '(192)')).toBe('(192)'); // Past the end of the list
		expect(await genreOf(3, 'Synthwave')).toBe('Synthwave');
	});

	test('reads the year from TYER and the full date from TDRC as UTC', async () => {
		expect((await readTags(tag(3, textFrame(3, 'TYER', '1987')))).date).toEqual(new Date(Date.UTC(1987, 0, 1)));
		expect((await readTags(tag(4, textFrame(4, 'TDRC', '2005-12-05')))).date)
			.toEqual(new Date(Date.UTC(2005, 11, 5)));
		expect((await readTags(tag(4, textFrame(4, 'TDRC', '2005')))).date).toEqual(new Date(Date.UTC(2005, 0, 1)));
		expect((await readTags(tag(4, textFrame(4, 'TDRC', 'unknown')))).date).toBeUndefined();
	});

	test('reads the BPM', async () => {
		expect((await readTags(tag(3, textFrame(3, 'TBPM', '174')))).beatsPerMinute).toBe(174);
	});

	test('reads description-less comments and lyrics, skipping their language code', async () => {
		const tags = await readTags(tag(3, concat(
			frame(3, 'COMM', [LATIN1, ...ascii('eng'), 0, ...ascii('A comment')]),
			frame(3, 'USLT', [
				UTF16,
				...ascii('deu'),
				...encodeText(UTF16, '', true),
				...encodeText(UTF16, 'Zeile 1\nZeile 2'),
			]),
		)));

		expect(tags.comment).toBe('A comment');
		expect(tags.lyrics).toBe('Zeile 1\nZeile 2');
	});

	test('collects user-defined text frames by their description', async () => {
		const tags = await readTags(tag(3, concat(
			frame(3, 'TXXX', [LATIN1, ...encodeText(LATIN1, 'REPLAYGAIN_TRACK_GAIN', true), ...ascii('-6.50 dB')]),
			frame(3, 'TXXX', [UTF16, ...encodeText(UTF16, 'Ünïcode', true), ...encodeText(UTF16, 'välue')]),
			frame(3, 'TXXX', [LATIN1, ...encodeText(LATIN1, 'REPLAYGAIN_TRACK_GAIN', true), ...ascii('ignored')]),
		)));

		expect(tags.raw!['TXXX']).toEqual({
			REPLAYGAIN_TRACK_GAIN: '-6.50 dB',
			Ünïcode: 'välue',
		});
	});

	test('reads attached pictures with their type and description', async () => {
		const apic = (pictureType: number, description: string, data: number[], encoding = LATIN1) => frame(3, 'APIC', [
			encoding,
			...ascii('image/jpeg'),
			0,
			pictureType,
			...encodeText(encoding, description, true),
			...data,
		]);

		const tags = await readTags(tag(3, concat(
			apic(3, 'Front', [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]), // The image data may contain null bytes
			apic(4, 'Back ✓', [1, 2, 3], UTF16),
			apic(0, '', [4, 5]),
			apic(8, 'Artist', [6]),
		)));

		expect(tags.images).toEqual([
			{
				data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]),
				mimeType: 'image/jpeg',
				kind: 'coverFront',
				description: 'Front',
			},
			{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg', kind: 'coverBack', description: 'Back ✓' },
			{ data: new Uint8Array([4, 5]), mimeType: 'image/jpeg', kind: 'unknown', description: '' },
			{ data: new Uint8Array([6]), mimeType: 'image/jpeg', kind: 'unknown', description: 'Artist' },
		]);
		expect(tags.raw!['APIC']).toHaveLength(4);
	});

	test('exposes unknown frames as raw bytes, collecting repeated ones into an array', async () => {
		const tags = await readTags(tag(3, concat(
			frame(3, 'PRIV', [...ascii('owner'), 0, 1, 2]),
			frame(3, 'UFID', [...ascii('http://musicbrainz.org'), 0, 9, 9]),
			frame(3, 'PRIV', [...ascii('other'), 0, 3]),
		)));

		expect(tags.raw!['UFID']).toEqual(new Uint8Array([...ascii('http://musicbrainz.org'), 0, 9, 9]));
		expect(tags.raw!['PRIV']).toEqual([
			new Uint8Array([...ascii('owner'), 0, 1, 2]),
			new Uint8Array([...ascii('other'), 0, 3]),
		]);
	});

	test('keeps the first occurrence of a repeated text frame', async () => {
		const tags = await readTags(tag(3, concat(textFrame(3, 'TIT2', 'First'), textFrame(3, 'TIT2', 'Second'))));

		expect(tags.title).toBe('First');
		expect(tags.raw!['TIT2']).toBe('First');
	});

	test('undoes ID3v2.4 per-frame unsynchronisation', async () => {
		// A UTF-16 BOM (FF FE) needs a zero byte inserted after the FF
		const tags = await readTags(tag(4, concat(
			frame(4, 'TIT2', [UTF16, 0xff, 0x00, 0xfe, ...utf16Le('Sync')], 0x0002),
			frame(4, 'APIC', [LATIN1, ...ascii('image/jpeg'), 0, 3, 0, 0xff, 0x00, 0xd8, 0xff, 0x00, 0xe0], 0x0002),
			textFrame(4, 'TPE1', 'Next'),
		)));

		expect(tags.title).toBe('Sync');
		expect(tags.images![0]!.data).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
		expect(tags.artist).toBe('Next');
	});

	test('undoes unsynchronisation on all frames when the ID3v2.4 tag header says so', async () => {
		const tags = await readTags(tag(4, concat(
			frame(4, 'TIT2', [UTF16, 0xff, 0x00, 0xfe, ...utf16Le('Header')]),
			textFrame(4, 'TPE1', 'Plain'),
		), 0x80));

		expect(tags.title).toBe('Header');
		expect(tags.artist).toBe('Plain');
	});

	test('skips encrypted and compressed frames, but keeps reading', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const tags = await readTags(tag(3, concat(
				frame(3, 'TIT2', [0x80, 0x01, 0x02], 0x0040), // Encrypted
				frame(3, 'TPE1', [0, 0, 0, 9, 0x78, 0x9c], 0x0080), // Compressed
				textFrame(3, 'TALB', 'Album'),
				textFrame(3, 'TIT2', 'Title'),
			)));

			expect(tags.title).toBe('Title');
			expect(tags.artist).toBeUndefined();
			expect(tags.album).toBe('Album');
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			warn.mockRestore();
		}
	});
});

describe('ID3v1', () => {
	const id3v1 = (options: {
		title?: string;
		artist?: string;
		album?: string;
		year?: string;
		comment?: number[];
		genre?: number;
	}) => {
		const bytes = new Uint8Array(128);
		bytes.set(ascii('TAG'));
		bytes.set(latin1(options.title ?? ''), 3);
		bytes.set(latin1(options.artist ?? ''), 33);
		bytes.set(latin1(options.album ?? ''), 63);
		bytes.set(latin1(options.year ?? ''), 93);
		bytes.set(options.comment ?? [], 97);
		bytes[127] = options.genre ?? 255;
		return bytes;
	};

	test('reads an ID3v1 tag at the end of the file', async () => {
		using input = openFile(concat(mp3Frames(3), id3v1({
			title: 'Title padded with spaces   ',
			artist: 'Ärtist',
			album: 'Album',
			year: '1994',
			comment: ascii('Comment'),
			genre: 17,
		})));

		const tags = await input.getMetadataTags();
		expect(tags.title).toBe('Title padded with spaces');
		expect(tags.artist).toBe('Ärtist');
		expect(tags.album).toBe('Album');
		expect(tags.date).toEqual(new Date(Date.UTC(1994, 0, 1)));
		expect(tags.comment).toBe('Comment');
		expect(tags.trackNumber).toBeUndefined();
		expect(tags.genre).toBe('Rock');
		expect(tags.raw!['TAG']).toHaveLength(125);

		// The tag isn't mistaken for audio
		expect(await countPackets(input)).toBe(3);
	});

	test('reads the ID3v1.1 track number from the end of the comment', async () => {
		const comment = [...ascii('Short comment'), ...new Array<number>(15).fill(0), 0, 7];
		using input = openFile(concat(mp3Frames(3), id3v1({ comment })));

		const tags = await input.getMetadataTags();

		expect(tags.comment).toBe('Short comment');
		expect(tags.trackNumber).toBe(7);
	});

	test('leaves out unset fields and the "none" genre', async () => {
		using input = openFile(concat(mp3Frames(3), id3v1({ title: 'Only a title', year: '0000' })));

		const tags = await input.getMetadataTags();
		expect(tags.title).toBe('Only a title');
		expect(tags.artist).toBeUndefined();
		expect(tags.album).toBeUndefined();
		expect(tags.date).toBeUndefined();
		expect(tags.comment).toBeUndefined();
		expect(tags.genre).toBeUndefined();
	});
});

describe('ID3v2 writing', () => {
	const image = (bytes: number[]) => new Uint8Array(bytes);

	test('writes an ID3v2.4 tag in front of the audio with one frame per field', async () => {
		const bytes = await writeMp3({
			title: 'Title',
			description: 'Description',
			artist: 'Artist',
			album: 'Album',
			albumArtist: 'Album artist',
			genre: 'Electronic',
			comment: 'Comment',
			lyrics: 'Lyrics',
			trackNumber: 3,
			tracksTotal: 12,
			discNumber: 1,
			discsTotal: 2,
			beatsPerMinute: 128,
			date: new Date(Date.UTC(2021, 3, 23)),
			images: [{ data: image([1, 2, 3]), mimeType: 'image/png', kind: 'coverFront', description: 'Front' }],
		});

		const frames = parseWrittenFrames(bytes);
		const frameData = Object.fromEntries(frames.map(frame => [frame.id, [...frame.data]]));

		expect(frames.map(frame => frame.flags)).toEqual(frames.map(() => 0));
		expect(frameData['TIT2']).toEqual([LATIN1, ...ascii('Title'), 0]);
		expect(frameData['TIT3']).toEqual([LATIN1, ...ascii('Description'), 0]);
		expect(frameData['TPE1']).toEqual([LATIN1, ...ascii('Artist'), 0]);
		expect(frameData['TALB']).toEqual([LATIN1, ...ascii('Album'), 0]);
		expect(frameData['TPE2']).toEqual([LATIN1, ...ascii('Album artist'), 0]);
		expect(frameData['TCON']).toEqual([LATIN1, ...ascii('Electronic'), 0]);
		expect(frameData['TRCK']).toEqual([LATIN1, ...ascii('3/12'), 0]);
		expect(frameData['TPOS']).toEqual([LATIN1, ...ascii('1/2'), 0]);
		expect(frameData['TBPM']).toEqual([LATIN1, ...ascii('128'), 0]);
		expect(frameData['TDRC']).toEqual([LATIN1, ...ascii('2021-04-23'), 0]);
		expect(frameData['COMM']).toEqual([LATIN1, ...ascii('und'), 0, ...ascii('Comment'), 0]);
		expect(frameData['USLT']).toEqual([LATIN1, ...ascii('und'), 0, ...ascii('Lyrics'), 0]);
		expect(frameData['APIC']).toEqual([LATIN1, ...ascii('image/png'), 0, 3, ...ascii('Front'), 0, 1, 2, 3]);

		// The audio follows the tag directly
		const tagEnd = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
		expect([...bytes.subarray(tagEnd, tagEnd + 2)]).toEqual([0xff, 0xfb]);
	});

	test('writes non-ISO-8859-1 text as UTF-8', async () => {
		const bytes = await writeMp3({
			title: 'Fish 鱼',
			comment: 'Comment “quoted”',
			images: [{ data: image([7]), mimeType: 'image/jpeg', kind: 'coverBack', description: 'Back ✓' }],
		});

		const frames = parseWrittenFrames(bytes);
		const frameData = Object.fromEntries(frames.map(frame => [frame.id, [...frame.data]]));

		expect(frameData['TIT2']).toEqual([UTF8, ...utf8('Fish 鱼'), 0]);
		expect(frameData['COMM']).toEqual([UTF8, ...ascii('und'), 0, ...utf8('Comment “quoted”'), 0]);
		expect(frameData['APIC']).toEqual([UTF8, ...ascii('image/jpeg'), 0, 4, ...utf8('Back ✓'), 0, 7]);
	});

	test('round-trips every field it writes', async () => {
		const tags: MetadataTags = {
			title: 'Tïtle 鱼',
			description: 'Description',
			artist: 'Ärtist',
			album: 'Album',
			albumArtist: 'Album artist',
			genre: 'Electronic',
			comment: 'Comment “quoted”',
			lyrics: 'Line 1\nLine 2',
			trackNumber: 3,
			tracksTotal: 12,
			discNumber: 1,
			discsTotal: 2,
			beatsPerMinute: 128,
			date: new Date(Date.UTC(2021, 3, 23)),
			images: [
				{ data: image([0x89, 0x50]), mimeType: 'image/png', kind: 'coverFront', description: 'Front ✓' },
				{ data: image([0xff, 0xd8, 0xff, 0x00]), mimeType: 'image/jpeg', kind: 'coverBack', description: 'B' },
				{ data: image([0x00]), mimeType: 'image/jpeg', kind: 'unknown', description: '' },
			],
		};

		using input = openFile(await writeMp3(tags));
		const readBack = await input.getMetadataTags();
		const { raw, ...fields } = readBack;

		expect(fields).toEqual(tags);
		expect(raw!['TIT2']).toBe('Tïtle 鱼');
	});

	test('writes raw frames, skipping keys that aren\'t frame IDs or that a field already wrote', async () => {
		const bytes = await writeMp3({
			title: 'Field title',
			raw: {
				TIT2: 'Raw title',
				TSRC: 'USRC17607839',
				TENC: 'Ëncoder ✓',
				PRIV: [new Uint8Array([...ascii('a'), 0, 1]), new Uint8Array([...ascii('b'), 0, 2])],
				MCDI: new Uint8Array([1, 2, 3]),
				TXXX: { 'MusicBrainz Album Id': 'abc', 'Ünïcode': '✓' },
				TOOLONG: 'ignored',
				TOO: 'ignored',
			},
		});

		const frames = parseWrittenFrames(bytes);
		expect(frames.map(frame => frame.id)).toEqual(['TIT2', 'TSRC', 'TENC', 'PRIV', 'PRIV', 'MCDI', 'TXXX', 'TXXX']);

		const data = frames.map(frame => [...frame.data]);
		expect(data[0]).toEqual([LATIN1, ...ascii('Field title'), 0]);
		expect(data[1]).toEqual([LATIN1, ...ascii('USRC17607839'), 0]);
		expect(data[2]).toEqual([UTF8, ...utf8('Ëncoder ✓'), 0]);
		expect(data[3]).toEqual([...ascii('a'), 0, 1]);
		expect(data[4]).toEqual([...ascii('b'), 0, 2]);
		expect(data[5]).toEqual([1, 2, 3]);
		expect(data[6]).toEqual([LATIN1, ...ascii('MusicBrainz Album Id'), 0, ...ascii('abc'), 0]);
		expect(data[7]).toEqual([UTF8, ...utf8('Ünïcode'), 0, ...utf8('✓'), 0]);

		using input = openFile(bytes);
		const tags = await input.getMetadataTags();
		expect(tags.raw!['TXXX']).toEqual({ 'MusicBrainz Album Id': 'abc', 'Ünïcode': '✓' });
		expect(tags.raw!['TENC']).toBe('Ëncoder ✓');
	});

	test('writes no tag when there is no metadata', async () => {
		const bytes = await writeMp3({});
		expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfb]);
	});

	test('writes the same tag at the start of ADTS files', async () => {
		const output = new Output({ format: new AdtsOutputFormat(), target: new BufferTarget() });
		output.setMetadataTags({ title: 'ADTS', artist: 'Ärtist' });
		const source = new EncodedAudioPacketSource('aac');
		output.addAudioTrack(source);
		await output.start();

		// AAC-LC, 44.1 kHz, stereo
		const description = new Uint8Array([0x12, 0x10]);
		for (let i = 0; i < 2; i++) {
			await source.add(
				new EncodedPacket(new Uint8Array([0x21, 0x00, 0x49, 0x90]), 'key', i * 1024 / 44100, 1024 / 44100),
				{ decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 44100, description } },
			);
		}
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		expect(parseWrittenFrames(bytes).map(frame => frame.id)).toEqual(['TIT2', 'TPE1']);

		using input = openFile(bytes);
		expect((await input.getFormat()).name).toBe('ADTS');
		const tags = await input.getMetadataTags();
		expect(tags.title).toBe('ADTS');
		expect(tags.artist).toBe('Ärtist');
	});

	test('writes the same tag into an "ID3 " chunk of WAVE files', async () => {
		const output = new Output({
			format: new WavOutputFormat({ metadataFormat: 'id3' }),
			target: new BufferTarget(),
		});
		output.setMetadataTags({
			title: 'WAVE',
			images: [{ data: image([9, 9]), mimeType: 'image/png', kind: 'coverFront' }],
		});
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(400), 'key', 0, 100 / 44100), {
			decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 44100 },
		});
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		const chunkStart = 12 + 8 + 16;
		expect(String.fromCharCode(...bytes.subarray(chunkStart, chunkStart + 4))).toBe('ID3 ');
		const frames = parseWrittenFrames(bytes.subarray(chunkStart + 8));
		expect(frames.map(frame => frame.id)).toEqual(['TIT2', 'APIC']);

		using input = openFile(bytes);
		const tags = await input.getMetadataTags();
		expect(tags.title).toBe('WAVE');
		expect(tags.images![0]!.data).toEqual(image([9, 9]));
	});
});
