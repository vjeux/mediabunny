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
	WavOutputFormat,
} from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AttachedFile, MetadataTags } from '../../src/metadata.js';
import { VERSIONED_NAME } from '../../src/version.js';
import path from 'node:path';
import { readFileSync } from 'node:fs';
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

test('Conversion metadata tags, fields removed by the tags function stay removed', async () => {
	type Format = Mp4OutputFormat | MkvOutputFormat | WavOutputFormat | FlacOutputFormat;
	const convert = async (bytes: Uint8Array, format: Format) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const output = new Output({ format, target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			showWarnings: false,
			// The way the docs remove a field
			tags: inputTags => ({ ...inputTags, artist: undefined, comment: undefined, images: [] }),
		});
		await conversion.execute();

		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		return await result.getMetadataTags();
	};

	// Same-format conversions copy the raw tags over, which mustn't bring the removed fields back
	for (const [makeFormat, codec] of [
		[() => new Mp4OutputFormat(), 'aac'],
		[() => new MkvOutputFormat(), 'aac'],
		[() => new WavOutputFormat(), 'pcm-s16'],
		[() => new WavOutputFormat({ metadataFormat: 'id3' }), 'pcm-s16'],
	] as const) {
		const output = new Output({ format: makeFormat(), target: new BufferTarget() });
		output.setMetadataTags({
			title: 'Title',
			artist: 'Artist',
			comment: 'Comment',
			images: [{ data: coverArt, mimeType: 'image/jpeg', kind: 'coverFront' }],
		});
		const source = new EncodedAudioPacketSource(codec);
		output.addAudioTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(4096), 'key', 0, 1024 / 44100), {
			decoderConfig: codec === 'aac'
				// AAC-LC, 44.1 kHz, stereo
				? { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 44100, description: new Uint8Array([18, 16]) }
				: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 44100 },
		});
		await output.finalize();

		const tags = await convert(new Uint8Array(output.target.buffer!), makeFormat());
		expect(tags.title).toBe('Title');
		expect(tags.artist).toBeUndefined();
		expect(tags.comment).toBeUndefined();
		expect(tags.images ?? []).toEqual([]);
	}

	// FLAC (Vorbis comments)
	const flac = new Uint8Array(readFileSync(path.join(__dirname, '../public/sample.flac')));
	const tags = await convert(flac, new FlacOutputFormat());
	expect(tags.title).toBe('The Happy Meeting');
	expect(tags.artist).toBeUndefined();
	expect(tags.raw!['ARTIST']).toBeUndefined();
	expect(tags.raw!['ALBUM']).toBe('Samples files');

	// Fields that a file carries twice, in two tag blocks or under two keys
	const removeTitleAndTotal = async (bytes: Uint8Array, format: Format) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const output = new Output({ format, target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			showWarnings: false,
			tags: inputTags => ({ ...inputTags, title: undefined, tracksTotal: undefined }),
		});
		await conversion.execute();

		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		return await result.getMetadataTags();
	};

	// A WAVE file with both RIFF INFO chunks and an ID3 chunk, like DAWs and taggers write
	const writeWave = async (metadataFormat: 'info' | 'id3') => {
		const output = new Output({ format: new WavOutputFormat({ metadataFormat }), target: new BufferTarget() });
		output.setMetadataTags({ title: 'Title', artist: 'Artist' });
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(4096), 'key', 0, 1024 / 44100), {
			decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 44100 },
		});
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};
	const infoWave = await writeWave('info');
	const id3Wave = await writeWave('id3');
	const id3ChunkStart = Buffer.from(id3Wave).indexOf('ID3 ');
	const id3ChunkSize = 8 + new DataView(id3Wave.buffer).getUint32(id3ChunkStart + 4, true);
	const bothWave = new Uint8Array([...infoWave, ...id3Wave.subarray(id3ChunkStart, id3ChunkStart + id3ChunkSize)]);
	new DataView(bothWave.buffer).setUint32(4, bothWave.length - 8, true);

	for (const metadataFormat of ['info', 'id3'] as const) {
		const tags = await removeTitleAndTotal(bothWave, new WavOutputFormat({ metadataFormat }));
		expect(tags.title).toBeUndefined();
		expect(tags.artist).toBe('Artist');
	}

	// A FLAC file with an ID3v2.4 tag (TIT2 "Old title") in front of its Vorbis comments
	const id3Tag = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20, 0x54, 0x49, 0x54, 0x32, 0, 0, 0, 10, 0, 0, 3]
		.concat([...'Old title'].map(x => x.charCodeAt(0)));
	const id3Flac = await removeTitleAndTotal(new Uint8Array([...id3Tag, ...flac]), new FlacOutputFormat());
	expect(id3Flac.title).toBeUndefined();
	expect(id3Flac.album).toBe('Samples files');

	// Vorbis comments with the track total both in TRACKNUMBER and in TRACKTOTAL
	using flacInput = new Input({ source: new BufferSource(flac), formats: ALL_FORMATS });
	const flacOutput = new Output({ format: new FlacOutputFormat(), target: new BufferTarget() });
	const tagging = await Conversion.init({
		input: flacInput,
		output: flacOutput,
		showWarnings: false,
		tags: { raw: { TRACKNUMBER: '3/12', TRACKTOTAL: '12' } },
	});
	await tagging.execute();
	const totals = await removeTitleAndTotal(new Uint8Array(flacOutput.target.buffer!), new FlacOutputFormat());
	expect(totals.trackNumber).toBe(3);
	expect(totals.tracksTotal).toBeUndefined();
});

test('Reading tags that fail to parse midway leaves plain data properties', async () => {
	const accessorFields = (tags: object) => Object.entries(Object.getOwnPropertyDescriptors(tags))
		.filter(([, descriptor]) => !('value' in descriptor)) // Accessor properties have a getter and setter instead
		.map(([key]) => key);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));

	// An ID3v2.4 tag whose TIT2 and TPE1 frames are fine, but whose TALB frame uses the undefined text encoding 4, so
	// the reader throws in the middle of it
	const frame = (id: string, body: number[]) => [...ascii(id), 0, 0, 0, body.length, 0, 0, ...body];
	const frames = [
		...frame('TIT2', [0, ...ascii('Title')]),
		...frame('TPE1', [0, ...ascii('Artist')]),
		...frame('TALB', [4, ...ascii('Bad')]),
	];
	const tag = [...ascii('ID3'), 4, 0, 0, 0, 0, 0, frames.length, ...frames];
	const mp3 = new Uint8Array([...tag, ...readFileSync(path.join(__dirname, '../public/Toothsome-Meme.VBRv2.mp3'))]);

	using mp3Input = new Input({ source: new BufferSource(mp3), formats: ALL_FORMATS });
	await expect(mp3Input.getMetadataTags()).rejects.toThrow('Unsupported text encoding: 4');
	const demuxerTags = async (input: Input) => {
		const demuxer = await input._getDemuxer();
		return (demuxer as unknown as { metadataTags: MetadataTags }).metadataTags;
	};
	const mp3Tags = await demuxerTags(mp3Input);
	expect(mp3Tags.title).toBe('Title');
	expect(accessorFields(mp3Tags)).toEqual([]);

	// An MP4 udta whose last item claims a longer string than the file holds
	const output = new Output({ format: new Mp4OutputFormat({ metadataFormat: 'udta' }), target: new BufferTarget() });
	output.setMetadataTags({ title: 'Title', artist: 'Artist' });
	const dummyTrack = createDummyAudioTrack('aac', output);
	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();
	const mp4 = new Uint8Array(output.target.buffer!);
	const artistPos = Buffer.from(mp4).lastIndexOf(Buffer.from('\u00a9ART', 'latin1'));
	mp4.set([0xff, 0xff], artistPos + 4);

	using mp4Input = new Input({ source: new BufferSource(mp4), formats: ALL_FORMATS });
	await mp4Input.getMetadataTags().catch(() => {});
	const mp4Tags = await demuxerTags(mp4Input);
	expect(mp4Tags.title).toBe('Title');
	expect(accessorFields(mp4Tags)).toEqual([]);
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
