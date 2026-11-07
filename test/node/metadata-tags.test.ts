import { expect, onTestFinished, test, vi } from 'vitest';
import { Output } from '../../src/output.js';
import {
	AdtsOutputFormat,
	FlacOutputFormat,
	MkvOutputFormat,
	MovOutputFormat,
	Mp3OutputFormat,
	Mp4OutputFormat,
	OggOutputFormat,
	OutputFormat,
	WavOutputFormat,
} from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AttachedFile, MetadataTags, RichImageData } from '../../src/metadata.js';
import { VERSIONED_NAME } from '../../src/version.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioCodec, buildAudioCodecString } from '../../src/codec.js';
import { Conversion } from '../../src/conversion.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const createDummyAudioTrack = (codec: AudioCodec, output: Output) => {
	const source = new EncodedAudioPacketSource(codec);
	output.addAudioTrack(source);

	return {
		async addPacket() {
			// Data to make it behave like an MP3 frame
			const data = new Uint8Array(2000);
			data[0] = 255;
			data[1] = 251;
			data[2] = 224;
			data[3] = 100;

			const description = codec === 'flac'
				? new Uint8Array([
					102, 76, 97, 67, 128, 0, 0, 34, 16, 0,
					16, 0, 0, 6, 45, 0, 37, 173, 10, 196,
					66, 240, 0, 13, 68, 24, 85, 22, 231, 0,
					113, 139, 185, 1, 33, 54, 155, 80, 241, 191,
					203, 112,
				])
				// Opus description
				: new Uint8Array([
					79, 112, 117, 115, 72, 101, 97, 100, 1, 2, 56, 1, 68, 172, 0, 0, 0, 0, 0,
				]);

			await source.add(
				new EncodedPacket(data, 'key', 0, 1),
				{
					decoderConfig: {
						codec: buildAudioCodecString(codec, 2, 44100),
						numberOfChannels: 2,
						sampleRate: 44100,
						description,
					},
				},
			);
		},
	};
};

const coverArt = new Uint8Array(1024);
coverArt[0] = 69;
const songMetadata: MetadataTags = {
	title: 'Trying to Feel Alive',
	description: 'A song',
	artist: 'Porter Robinson & others',
	album: 'Nurture',
	albumArtist: 'Porter Robinson',
	genre: 'Electronic',
	comment: 'Some of this info is intentionally incorrect',
	lyrics: 'Well, do you feel better now?\nI thought I\'d run until the sky came out',
	trackNumber: 13,
	tracksTotal: 14,
	discNumber: 1,
	discsTotal: 1,
	beatsPerMinute: 128,
	date: new Date(2021, 3, 23),
	images: [{
		data: coverArt,
		kind: 'coverFront',
		mimeType: 'image/jpeg',
		description: 'This image shows a person laying in a field of grass',
	}],
};

test('Read and write metadata, MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			'©hog': 'pish',
			'©nam': 'Cheerleader', // Test that it doesn't override the main title
		},
	});

	const dummyTrack = createDummyAudioTrack('aac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.discsTotal).toBe(songMetadata.discsTotal);
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toBeUndefined(); // Lost in MP4

	expect(readTags.raw!['©nam']).toBe(songMetadata.title);
	expect(readTags.raw!['trkn']).instanceOf(Uint8Array);
	expect(readTags.raw!['©hog']).toBe('pish');
});

test('MP4 leaves out track numbers and tempos that don\'t fit their 16-bit iTunes fields', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({ trackNumber: 70000, tracksTotal: 12, beatsPerMinute: 40000 });

	const dummyTrack = createDummyAudioTrack('aac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();
	expect(readTags.trackNumber).toBeUndefined(); // Was 70000 - 65536 = 4464
	expect(readTags.tracksTotal).toBe(12);
	expect(readTags.raw!['tmpo']).toBeUndefined(); // Was the signed 16-bit value 40000 - 65536
});

test('Read and write metadata, QuickTime', async () => {
	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			'©sic': 'ko mode',
			'cust': new Uint8Array([1, 2, 3, 4]),
		},
	});

	const dummyTrack = createDummyAudioTrack('aac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.beatsPerMinute).toBeUndefined();
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBeUndefined(); // All of these don't work in MOV
	expect(readTags.tracksTotal).toBeUndefined();
	expect(readTags.discNumber).toBeUndefined();
	expect(readTags.discsTotal).toBeUndefined();
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toBeUndefined();

	expect(readTags.raw!['©nam']).toBe(songMetadata.title);
	// We don't know what the data type is, so the demuxer just returns Uint8Array
	expect(readTags.raw!['©sic']).toBe('ko mode'); // Parsed as string because it begins with ©
	expect(readTags.raw!['cust']).toEqual(new Uint8Array([1, 2, 3, 4]));
});

test('QuickTime text tags longer than 64 KiB keep as much text as their 16-bit length field allows', async () => {
	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});

	// 65534 bytes of 'a', then a two-byte character that would straddle the 65535-byte limit
	const lyrics = 'a'.repeat(65534) + 'é' + 'b'.repeat(5000);
	output.setMetadataTags({ title: 'Title', lyrics });

	const dummyTrack = createDummyAudioTrack('aac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();
	expect(readTags.title).toBe('Title');
	expect(readTags.lyrics).toBe('a'.repeat(65534)); // The length used to wrap around to 70536 - 65536 bytes
});

test('Read and write metadata, MP4 with mdta format', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({
			metadataFormat: 'mdta',
		}),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			'AIGC': 'yes',
			'this key is': 'crazy long',
			'bytes': new Uint8Array([2, 3, 4, 5]),
		},
	});

	const dummyTrack = createDummyAudioTrack('aac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.beatsPerMinute).toBeUndefined();
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBeUndefined(); // Not written
	expect(readTags.discsTotal).toBeUndefined();
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toBeUndefined(); // Lost in MP4

	expect(readTags.raw!['title']).toBe(songMetadata.title);
	expect(readTags.raw!['AIGC']).toBe('yes');
	expect(readTags.raw!['this key is']).toBe('crazy long');
	expect(readTags.raw!['bytes']).toEqual(new Uint8Array([2, 3, 4, 5]));
});

test('Read MOV metadata tags, ilst with keys', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/trunc-buck-bunny.mov')),
		formats: ALL_FORMATS,
	});

	const tags = await input.getMetadataTags();
	expect(tags.raw).not.toBeUndefined();
	expect(tags.raw!['com.apple.quicktime.version']).toBe('7.4.1 (14) 0x7418000 (Mac OS X, 10.5.2, 9C31)');
	expect(tags.raw!['com.apple.quicktime.player.movie.audio.gain']).toEqual(new Uint8Array([63, 128, 0, 0]));
});

test('FFmpeg-unsafe raw udta tags, MP4', async () => {
	const hmmt = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 250]);

	for (const metadataFormat of ['mdir', 'mdta', 'udta'] as const) {
		const output = new Output({
			format: new Mp4OutputFormat({ metadataFormat }),
			target: new BufferTarget(),
		});

		output.setMetadataTags({
			raw: {
				HMMT: hmmt,
				cust: new Uint8Array([1, 2, 3, 4]),
			},
		});

		const dummyTrack = createDummyAudioTrack('aac', output);

		await output.start();
		await dummyTrack.addPacket();
		await output.finalize();

		using input = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});

		const readTags = await input.getMetadataTags();

		// FFmpeg would misparse HMMT as an ilst item, so it's only dropped in that case
		expect(readTags.raw!['HMMT']).toEqual(metadataFormat === 'mdir' ? undefined : hmmt);
		expect(readTags.raw!['cust']).toEqual(new Uint8Array([1, 2, 3, 4]));
	}
});

test('Read the iTunes gnre genre number, MP4', async () => {
	const readGenre = async (gnre: string | Uint8Array) => {
		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});

		// A string is written as text, a Uint8Array as binary data
		output.setMetadataTags({ raw: { gnre } });

		const dummyTrack = createDummyAudioTrack('aac', output);

		await output.start();
		await dummyTrack.addPacket();
		await output.finalize();

		using input = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});

		return (await input.getMetadataTags()).genre;
	};

	// iTunes and AtomicParsley store predefined genres as an ID3v1 genre number plus one
	expect(await readGenre(new Uint8Array([0, 18]))).toBe('Rock');
	// Some writers put text there instead
	expect(await readGenre('Rock')).toBe('Rock');
});

test('Read every image of an MP4 covr item', async () => {
	// iTunes, AtomicParsley and mutagen put all cover images into one covr item, one data box each
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const mvhd = box('mvhd', u32(0), u32(0), u32(0), u32(1000), u32(0), u32(0x10000), [1, 0], zeros(10),
		u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000), zeros(28));
	const png = [0x89, 0x50, 0x4e, 0x47];
	const jpeg = [0xff, 0xd8, 0xff];
	const file = new Uint8Array([
		...box('ftyp', ascii('M4A '), u32(0), ascii('M4A ')),
		...box('moov', mvhd, box('udta', box('meta', u32(0),
			box('hdlr', u32(0), u32(0), ascii('mdir'), zeros(13)),
			box('ilst', box('covr', box('data', u32(14), u32(0), png), box('data', u32(13), u32(0), jpeg))),
		))),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const images = (await input.getMetadataTags()).images;
	expect(images?.map(image => [image.mimeType, [...image.data]])).toEqual([
		['image/png', png],
		['image/jpeg', jpeg],
	]);
});

test('Read and write metadata, Matroska', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			'CUSTOM': 'Levels',
			// This number cannot be represented by f64, so this tests correct BigInt usage
			'9007199254740993': new AttachedFile(
				new Uint8Array(20),
				'font/ttf',
				'Heya',
				'A font file',
			),
			// And this one we don't expect to get attached again, since it mirrors the image we're also attaching
			'987654': new AttachedFile(
				songMetadata.images![0]!.data,
				songMetadata.images![0]!.mimeType,
				songMetadata.images![0]!.name,
				songMetadata.images![0]!.description,
			),
		},
	});

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.discsTotal).toBe(songMetadata.discsTotal);
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toEqual(songMetadata.images![0]!.description);
	expect(readTags.images![0]!.name).toEqual('cover.jpg'); // It constructed this name

	expect(readTags.raw!['TITLE']).toBe(songMetadata.title);
	expect(readTags.raw!['PART_NUMBER']).toBe('13/14');
	expect(readTags.raw!['CUSTOM']).toBe('Levels');

	const files = Object.entries(readTags.raw!).filter(x => x[1] instanceof AttachedFile);
	expect(files).toHaveLength(2);

	const imageFile = files.find(x => (x[1] as AttachedFile).mimeType === 'image/jpeg');
	expect((imageFile![1] as AttachedFile).data).toEqual(songMetadata.images![0]!.data);

	const secondFile = files.find(x => (x[1] as AttachedFile).mimeType === 'font/ttf');
	expect(secondFile![0]).toBe('9007199254740993');
	expect((secondFile![1] as AttachedFile).data).toHaveLength(20);
	expect((secondFile![1] as AttachedFile).mimeType).toBe('font/ttf');
	expect((secondFile![1] as AttachedFile).name).toBe('Heya');
	expect((secondFile![1] as AttachedFile).description).toBe('A font file');
});

test('Read and write metadata, MP3', async () => {
	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			TXXY: 'ID3v2 goated',
			TXXZ: '鱼',
			TXXX: {
				foo: 'bar',
				baz: 'qux',
				你: '好',
			},
		},
	});

	const dummyTrack = createDummyAudioTrack('mp3', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	// ID3v2 is goated, so pretty much everything was copied:
	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.discsTotal).toBe(songMetadata.discsTotal);
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toEqual(songMetadata.images![0]!.description);
	expect(readTags.images![0]!.name).toBeUndefined(); // Can't be contained in ID3v2

	expect(readTags.raw!['TIT2']).toBe(songMetadata.title);
	expect(readTags.raw!['APIC']).instanceOf(Uint8Array);
	expect(readTags.raw!['TXXY']).toBe('ID3v2 goated');
	expect(readTags.raw!['TXXZ']).toBe('鱼');
	expect(readTags.raw!['TXXX']).toEqual({
		foo: 'bar',
		baz: 'qux',
		你: '好',
	});
});

test('Read and write metadata, Ogg', async () => {
	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			vendor: 'Mediabunny',
			COMPOSER: 'Hans Zimmer',
		},
	});

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.discsTotal).toBe(songMetadata.discsTotal);
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toEqual(songMetadata.images![0]!.description);
	expect(readTags.images![0]!.name).toBeUndefined(); // Can't be contained in Vorbis-style metadata

	expect(readTags.raw!['vendor']).toBe(VERSIONED_NAME);
	expect(readTags.raw!['COMPOSER']).toBe('Hans Zimmer');
});

test('Read and write metadata, FLAC', async () => {
	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			vendor: 'Mediabunny',
			COMPOSER: 'Hans Zimmer',
		},
	});

	const dummyTrack = createDummyAudioTrack('flac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.discsTotal).toBe(songMetadata.discsTotal);
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toEqual(songMetadata.images![0]!.description);
	expect(readTags.images![0]!.name).toBeUndefined(); // Can't be contained in Vorbis-style metadata

	expect(readTags.raw!['vendor']).toBe(VERSIONED_NAME);
	expect(readTags.raw!['COMPOSER']).toBe('Hans Zimmer');
});

test('Read and write metadata, ADTS', async () => {
	const originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample3.aac')),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input: originalInput,
		output,
		tags: {
			...songMetadata,
			raw: {
				TXXY: 'ID3v2 goated',
			},
		},
	});
	await conversion.execute();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	// ID3v2 is goated, so pretty much everything was copied:
	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.discsTotal).toBe(songMetadata.discsTotal);
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toEqual(songMetadata.images![0]!.description);
	expect(readTags.images![0]!.name).toBeUndefined(); // Can't be contained in ID3v2

	expect(readTags.raw!['TIT2']).toBe(songMetadata.title);
	expect(readTags.raw!['APIC']).instanceOf(Uint8Array);
	expect(readTags.raw!['TXXY']).toBe('ID3v2 goated');
});

test('Read an ID3v1 tag, ADTS', async () => {
	// Three AAC-LC frames (44.1 kHz, stereo, 100 bytes each) followed by an ID3v1 tag, which MP3 files get read too
	const frame = new Uint8Array(100);
	frame.set([0xff, 0xf1, 0x50, 0x80, 100 >> 3, ((100 & 7) << 5) | 0x1f, 0xfc]);

	const id3V1Tag = new Uint8Array(128);
	id3V1Tag.set([...'TAGSample title'].map(char => char.charCodeAt(0)));
	id3V1Tag[127] = 12; // Genre: Other

	using input = new Input({
		source: new BufferSource(new Uint8Array([...frame, ...frame, ...frame, ...id3V1Tag])),
		formats: ALL_FORMATS,
	});

	const tags = await input.getMetadataTags();
	expect(tags.title).toBe('Sample title');
	expect(tags.genre).toBe('Other');
});

test('Read and write metadata, WAVE', async () => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			IKEK: 'RIFF INFO lowkey mid',
		},
	});

	const dummyTrack = createDummyAudioTrack('pcm-s16', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.beatsPerMinute).toBeUndefined();
	expect(readTags.description).toBeUndefined();
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBeUndefined();
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBeUndefined();
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBeUndefined();
	expect(readTags.discsTotal).toBeUndefined();
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toBeUndefined();

	expect(readTags.raw!['INAM']).toBe(songMetadata.title);
	expect(readTags.raw!['IKEK']).toBe('RIFF INFO lowkey mid');
});

test('Metadata dates outside the years 0 to 9999 are left out instead of written malformed', async () => {
	// toISOString().slice(0, 10) would give '+010000-01' and '-000001-01'
	const writeAndRead = async (format: OutputFormat, codec: AudioCodec, date: Date) => {
		const output = new Output({ format, target: new BufferTarget() });
		output.setMetadataTags({ title: 'Title', date });
		const track = createDummyAudioTrack(codec, output);
		await output.start();
		await track.addPacket();
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		return await input.getMetadataTags();
	};

	const formats: [() => OutputFormat, AudioCodec][] = [
		[() => new Mp4OutputFormat(), 'opus'],
		[() => new MkvOutputFormat(), 'opus'],
		[() => new OggOutputFormat(), 'opus'],
		[() => new Mp3OutputFormat(), 'mp3'],
		[() => new FlacOutputFormat(), 'flac'],
		[() => new WavOutputFormat(), 'pcm-s16'],
	];
	for (const [format, codec] of formats) {
		for (const date of [new Date(Date.UTC(10000, 0, 15)), new Date(Date.UTC(-1, 0, 15))]) {
			const tags = await writeAndRead(format(), codec, date);
			expect(tags.title).toBe('Title');
			expect(tags.date).toBeUndefined();
		}
	}
});

test('Conversion copies tags of an input whose date lies past the year 9999', async () => {
	// A ©day such as Mediabunny itself wrote for such dates before
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	output.setMetadataTags({ title: 'Title', raw: { '©day': '+010000-01' } });
	const dummyTrack = createDummyAudioTrack('opus', output);
	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	expect((await input.getMetadataTags()).date!.getUTCFullYear()).toBe(10000);

	const output2 = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output: output2 });
	await conversion.execute();

	using input2 = new Input({ source: new BufferSource(output2.target.buffer!), formats: ALL_FORMATS });
	const tags = await input2.getMetadataTags();
	expect(tags.title).toBe('Title');
	expect(tags.date).toBeUndefined();
});

const writeWithDummyTrack = async (format: OutputFormat, codec: AudioCodec, tags: MetadataTags) => {
	const output = new Output({ format, target: new BufferTarget() });
	output.setMetadataTags(tags);
	const dummyTrack = createDummyAudioTrack(codec, output);
	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();
	return output.target.buffer!;
};
/** Writes MPEG-1 Layer III frames of 417 bytes (128 kbit/s, 44.1 kHz) back to back, like a real stream. */
const writeMp3Frames = async (format: OutputFormat, tags: MetadataTags) => {
	const output = new Output({ format, target: new BufferTarget() });
	output.setMetadataTags(tags);
	const source = new EncodedAudioPacketSource('mp3');
	output.addAudioTrack(source);
	await output.start();

	for (let i = 0; i < 10; i++) {
		const data = new Uint8Array(417);
		data.set([0xff, 0xfb, 0x90, 0x00]);
		const decoderConfig = { codec: 'mp3', numberOfChannels: 2, sampleRate: 44100 };
		await source.add(
			new EncodedPacket(data, 'key', i * 1152 / 44100, 1152 / 44100),
			i === 0 ? { decoderConfig } : undefined,
		);
	}

	await output.finalize();
	return output.target.buffer!;
};

/** Copies a real file of the format into a new one with the given tags. */
const writeFromFixture = async (fixtureName: string, format: OutputFormat, tags: MetadataTags) => {
	const fixturePath = path.join(__dirname, '../public', fixtureName);
	using fixture = new Input({ source: new FilePathSource(fixturePath), formats: ALL_FORMATS });
	const output = new Output({ format, target: new BufferTarget() });
	const conversion = await Conversion.init({ input: fixture, output, tags });
	await conversion.execute();
	return output.target.buffer!;
};

test('A same-format conversion leaves out an unrepresentable date instead of copying its raw tag back', async () => {
	// Converting to the same format keeps the raw tags, which hold the date in its original form
	const convertToSameFormat = async (bytes: ArrayBuffer, format: OutputFormat) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const inputYear = (await input.getMetadataTags()).date?.getUTCFullYear();

		const output = new Output({ format, target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output });
		await conversion.execute();

		using converted = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		return { inputYear, tags: await converted.getMetadataTags() };
	};

	// Where the demuxer checks the stream, the audio has to be a valid one rather than a dummy packet
	type Writer = (format: OutputFormat, tags: MetadataTags) => Promise<ArrayBuffer>;
	const dummy = (codec: AudioCodec): Writer => (format, tags) => writeWithDummyTrack(format, codec, tags);
	const flacFixture: Writer = (format, tags) => writeFromFixture('sample.flac', format, tags);
	const cases: [string, () => OutputFormat, Writer, string][] = [
		['MP4', () => new Mp4OutputFormat(), dummy('opus'), '©day'],
		['MOV', () => new MovOutputFormat(), dummy('pcm-s16'), '©day'],
		['MKV', () => new MkvOutputFormat(), dummy('opus'), 'DATE'],
		['MP3', () => new Mp3OutputFormat(), writeMp3Frames, 'TDRC'],
		['FLAC', () => new FlacOutputFormat(), flacFixture, 'DATE'], // Same Vorbis comment writer as Ogg
		['WAVE', () => new WavOutputFormat(), dummy('pcm-s16'), 'ICRD'],
	];
	for (const [name, format, write, dateKey] of cases) {
		// A date tag such as Mediabunny itself wrote for years past 9999 before
		const writtenTags: MetadataTags = { title: 'Title', raw: { [dateKey]: '+010000-01' } };
		const bytes = await write(format(), writtenTags);
		const { inputYear, tags } = await convertToSameFormat(bytes, format());
		expect(inputYear, name).toBe(10000);
		expect(tags.title, name).toBe('Title');
		expect(tags.date, name).toBeUndefined();
		expect(tags.raw?.[dateKey], name).toBeUndefined();
	}
});

test('A left-out date can\'t come back through a raw date tag in another letter case', async () => {
	// Vorbis comment field names are case-insensitive, and Mediabunny reads Matroska tag names that way too
	const writers: [string, (tags: MetadataTags) => Promise<ArrayBuffer>][] = [
		['MKV', tags => writeWithDummyTrack(new MkvOutputFormat(), 'opus', tags)],
		['FLAC', tags => writeFromFixture('sample.flac', new FlacOutputFormat(), tags)],
	];
	for (const [name, write] of writers) {
		const readBack = async (tags: MetadataTags) => {
			using input = new Input({ source: new BufferSource(await write(tags)), formats: ALL_FORMATS });
			return await input.getMetadataTags();
		};

		const date = new Date(Date.UTC(10000, 0, 15));
		const omitted = await readBack({ title: 'Title', date, raw: { date: '+010000-01' } });
		expect(omitted.title, name).toBe('Title');
		expect(omitted.date, name).toBeUndefined();

		// Without a date to leave out, the raw tag is still written as it is
		const rawOnly = await readBack({ title: 'Title', raw: { date: '2021-04-23' } });
		expect(rawOnly.date, name).toEqual(new Date('2021-04-23T00:00:00Z'));
	}
});

test('Conversion metadata tags, default case', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags(songMetadata);

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const output2 = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output: output2 });
	await conversion.execute();

	const input2 = new Input({
		source: new BufferSource(output2.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input2.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.discsTotal).toBe(songMetadata.discsTotal);
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
});

test('Conversion metadata tags, modified', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags(songMetadata);

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const output2 = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output: output2,
		tags: inputTags => ({
			title: 'Blossom',
			artist: inputTags.artist,
			raw: inputTags.raw, // This should NOT be copied
		}),
	});
	await conversion.execute();

	const input2 = new Input({
		source: new BufferSource(output2.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input2.getMetadataTags();

	expect(Object.keys(readTags).length).toBe(4);
	expect(readTags.title).toBe('Blossom');
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(Object.keys(readTags.raw!).length).toBe(2);
});

test('Read the ID3v1 tag behind an ID3v2 tag without text, MP3', async () => {
	// Like files tagged by Windows Media Player, whose ID3v2 tag only holds PRIV frames, with the title left in ID3v1
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const priv = [...ascii('PeakValue'), 0, 0x05, 0x53, 0, 0];
	const frame = [...ascii('PRIV'), 0, 0, 0, priv.length, 0, 0, ...priv];
	const id3V2Tag = [...ascii('ID3'), 3, 0, 0, 0, 0, 0, frame.length, ...frame];

	const mp3Frames = new Uint8Array(3 * 417);
	for (let i = 0; i < 3; i++) {
		mp3Frames.set([0xff, 0xfb, 0x90, 0x00], i * 417);
	}

	const id3V1Tag = new Uint8Array(128);
	id3V1Tag.set([...ascii('TAG'), ...ascii('Sample title')]);
	id3V1Tag[127] = 12; // Genre: Other

	using input = new Input({
		source: new BufferSource(new Uint8Array([...id3V2Tag, ...mp3Frames, ...id3V1Tag])),
		formats: ALL_FORMATS,
	});

	const tags = await input.getMetadataTags();
	expect(tags.title).toBe('Sample title');
	expect(tags.genre).toBe('Other');
	expect(tags.raw!['PRIV']).toEqual(new Uint8Array(priv));
});

test('Read ID3v2 tags from WAV file', async () => {
	const filePath = path.join(import.meta.dirname, '../public/glitch-hop-is-dead.wav');

	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const tags = await input.getMetadataTags();

	const expectedTitle = 'Glitch Hop Is Dead';
	const expectedArtist = 'GRiZ';
	const expectedTrackNumber = 19;

	// Specific expectations for the test WAV file
	expect(tags.title).toBe(expectedTitle);
	expect(tags.artist).toBe(expectedArtist);
	expect(tags.trackNumber).toBe(expectedTrackNumber);

	if (!tags.images) {
		throw new Error('No images found in the file');
	}

	const frontCover = tags.images[0];

	if (!frontCover) {
		throw new Error('No front cover found in the file');
	}

	expect(frontCover.kind).toBe('coverFront');
	expect(frontCover.mimeType).toBe('image/jpg');
	expect(frontCover.data).toBeInstanceOf(Uint8Array);
	expect(frontCover.data.length).toBeGreaterThan(0);

	if (!tags.raw) {
		throw new Error('No raw tags found in the file');
	}

	expect(tags.raw['TIT2']).toBe(expectedTitle); // Title
	expect(tags.raw['TPE1']).toBe(expectedArtist); // Artist
	expect(tags.raw['TRCK']).toBe(String(expectedTrackNumber)); // Track number
	expect(tags.raw['APIC']).toBeInstanceOf(Uint8Array);
});

test('Write WAV with ID3 tags', async () => {
	const output = new Output({
		target: new BufferTarget(),
		format: new WavOutputFormat({ metadataFormat: 'id3' }),
	});

	output.setMetadataTags(songMetadata);

	const dummyTrack = createDummyAudioTrack('pcm-f32', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.genre).toBe(songMetadata.genre);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);

	expect(readTags.date).toBeDefined();

	expect(readTags.raw).toBeDefined();
	if (readTags.raw) {
		// Verify RIFF INFO tags are not present
		expect(readTags.raw['INAM']).toBeUndefined();

		// Verify ID3 tags are also present
		expect(readTags.raw['TIT2']).toBe(songMetadata.title);
		expect(readTags.raw['TPE1']).toBe(songMetadata.artist);
		expect(readTags.raw['TALB']).toBe(songMetadata.album);
		expect(readTags.raw['TPE2']).toBe(songMetadata.albumArtist);
		expect(readTags.raw['TCON']).toBe(songMetadata.genre);
		expect(readTags.raw['COMM']).toBeDefined();
		expect(readTags.raw['USLT']).toBeDefined();
		expect(readTags.raw['TRCK']).toBe(`${songMetadata.trackNumber}/${songMetadata.tracksTotal}`);
		expect(readTags.raw['TPOS']).toBe(`${songMetadata.discNumber}/${songMetadata.discsTotal}`);
		expect(readTags.raw['TDRC']).toBeDefined();
	}
});

test('Default creation time, ISOBMFF', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	onTestFinished(() => {
		vi.useRealTimers();
	});
	vi.setSystemTime(new Date('2024-02-29T13:37:42.123Z'));

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	// The format only stores whole seconds
	expect(readTags.creationTime).toEqual(new Date('2024-02-29T13:37:42Z'));
});

test('Default creation time, Matroska', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	onTestFinished(() => {
		vi.useRealTimers();
	});
	vi.setSystemTime(new Date('2024-02-29T13:37:42.123Z'));

	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.creationTime).toEqual(new Date('2024-02-29T13:37:42.123Z'));
});

test('Creation time override, ISOBMFF', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({ creationTime: new Date('2024-02-29T13:37:42Z') });

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.creationTime).toEqual(new Date('2024-02-29T13:37:42Z'));

	const nullOutput = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	nullOutput.setMetadataTags({ creationTime: null });

	const nullDummyTrack = createDummyAudioTrack('opus', nullOutput);

	await nullOutput.start();
	await nullDummyTrack.addPacket();
	await nullOutput.finalize();

	using nullInput = new Input({
		source: new BufferSource(nullOutput.target.buffer!),
		formats: ALL_FORMATS,
	});

	const nullReadTags = await nullInput.getMetadataTags();

	expect(nullReadTags.creationTime).toBeUndefined();
});

test('Creation time override, Matroska', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({ creationTime: new Date('2024-02-29T13:37:42.123Z') });

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.creationTime).toEqual(new Date('2024-02-29T13:37:42.123Z'));

	const nullOutput = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	nullOutput.setMetadataTags({ creationTime: null });

	const nullDummyTrack = createDummyAudioTrack('opus', nullOutput);

	await nullOutput.start();
	await nullDummyTrack.addPacket();
	await nullOutput.finalize();

	using nullInput = new Input({
		source: new BufferSource(nullOutput.target.buffer!),
		formats: ALL_FORMATS,
	});

	const nullReadTags = await nullInput.getMetadataTags();

	expect(nullReadTags.creationTime).toBeUndefined();
});

test('Creation time not copied in conversion', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({ creationTime: new Date('2010-01-01T00:00:00Z') });

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const output2 = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	vi.useFakeTimers({ toFake: ['Date'] });
	onTestFinished(() => {
		vi.useRealTimers();
	});
	vi.setSystemTime(new Date('2024-02-29T13:37:42.123Z'));

	const conversion = await Conversion.init({ input, output: output2 });
	await conversion.execute();

	using input2 = new Input({
		source: new BufferSource(output2.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input2.getMetadataTags();

	expect(readTags.creationTime).toEqual(new Date('2024-02-29T13:37:42.123Z'));
});

test('Creation time override in conversion', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({ creationTime: new Date('2010-01-01T00:00:00Z') });

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const output2 = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output: output2,
		tags: { creationTime: new Date('2024-02-29T13:37:42.123Z') },
	});
	await conversion.execute();

	using input2 = new Input({
		source: new BufferSource(output2.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input2.getMetadataTags();

	expect(readTags.creationTime).toEqual(new Date('2024-02-29T13:37:42.123Z'));

	const nullOutput = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const nullConversion = await Conversion.init({
		input,
		output: nullOutput,
		tags: { creationTime: null },
	});
	await nullConversion.execute();

	using nullInput = new Input({
		source: new BufferSource(nullOutput.target.buffer!),
		formats: ALL_FORMATS,
	});

	const nullReadTags = await nullInput.getMetadataTags();

	expect(nullReadTags.creationTime).toBeUndefined();
});

test('MP4 writes the description into the iTunes \'desc\' atom', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({ description: 'A song' });

	const dummyTrack = createDummyAudioTrack('aac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();
	expect(readTags.description).toBe('A song');
	expect(readTags.raw!['desc']).toBe('A song'); // The atom iTunes and FFmpeg read
	expect(readTags.raw!['©des']).toBeUndefined();
});

test('Remuxing MP4 tags read from a \'©des\' atom writes the description once', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	// What reading an MP4 with a '©des' atom gives (e.g. one written by earlier versions)
	output.setMetadataTags({ description: 'A song', raw: { '©des': 'A song' } });

	const dummyTrack = createDummyAudioTrack('aac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();
	expect(readTags.description).toBe('A song');
	expect(readTags.raw!['desc']).toBe('A song');
	expect(readTags.raw!['©des']).toBeUndefined();
});

test('MP4 with mdta format writes cover art under the QuickTime artwork key', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ metadataFormat: 'mdta' }),
		target: new BufferTarget(),
	});

	output.setMetadataTags({ images: songMetadata.images });

	const dummyTrack = createDummyAudioTrack('aac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);

	// 'covr' is an ilst atom name; in a keys box, the artwork key is com.apple.quicktime.artwork (also read by FFmpeg)
	expect(Object.keys(readTags.raw!)).toEqual(['com.apple.quicktime.artwork']);
});

test('Remuxing mdta tags whose cover was read under the iTunes key keeps a single cover', async () => {
	const writeAndRead = async (tags: MetadataTags) => {
		const output = new Output({
			format: new Mp4OutputFormat({ metadataFormat: 'mdta' }),
			target: new BufferTarget(),
		});

		output.setMetadataTags(tags);

		const dummyTrack = createDummyAudioTrack('aac', output);

		await output.start();
		await dummyTrack.addPacket();
		await output.finalize();

		using input = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});

		const readTags = await input.getMetadataTags();
		return readTags;
	};

	// What reading an mdta file with a 'covr' key gives (e.g. one written by earlier versions): the cover in both
	// images and raw
	const read = await writeAndRead({
		images: [{ data: coverArt, mimeType: 'image/jpeg', kind: 'coverFront' }],
		raw: { covr: new RichImageData(coverArt, 'image/jpeg') },
	});
	expect(read.images).toHaveLength(1);

	const remuxed = await writeAndRead(read);
	expect(remuxed.images).toHaveLength(1);
	expect(Object.keys(remuxed.raw!)).toEqual(['com.apple.quicktime.artwork']);
});
