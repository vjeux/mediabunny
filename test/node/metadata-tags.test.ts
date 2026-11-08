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
	WebMOutputFormat,
} from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';
import { BufferSource, FilePathSource, CustomSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AttachedFile, MetadataTags, RichImageData } from '../../src/metadata.js';
import { VERSIONED_NAME } from '../../src/version.js';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AudioCodec, buildAudioCodecString } from '../../src/codec.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import fs from 'node:fs';

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

const writeMp3 = async (tags: MetadataTags) => {
	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});
	output.setMetadataTags(tags);

	const dummyTrack = createDummyAudioTrack('mp3', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

const readMetadataTags = async (bytes: Uint8Array) => {
	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});
	return await input.getMetadataTags();
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

test('Picture links are not read as images', async () => {
	// A picture whose media type is "-->" holds a link to the picture, not the picture (RFC 9639, section 8.8;
	// ID3v2.3, section 4.15), so it's not one of the images
	const link = new TextEncoder().encode('https://example.com/cover.jpg');
	const images: MetadataTags['images'] = [
		{ data: link, mimeType: '-->', kind: 'coverFront' },
		songMetadata.images![0]!,
	];
	const formats = [[new FlacOutputFormat(), 'flac'], [new OggOutputFormat(), 'opus'], [new Mp3OutputFormat(), 'mp3']];

	for (const [format, codec] of formats as [FlacOutputFormat | OggOutputFormat | Mp3OutputFormat, AudioCodec][]) {
		const output = new Output({ format, target: new BufferTarget() });
		output.setMetadataTags({ images });
		const dummyTrack = createDummyAudioTrack(codec, output);
		await output.start();
		await dummyTrack.addPacket();
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const readTags = await input.getMetadataTags();
		expect(readTags.images).toHaveLength(1);
		expect(readTags.images![0]!.data).toEqual(coverArt);
	}

	// The same in an ID3v2.2 PIC frame, whose image format is "-->"
	const picFrameData = [0, ...new TextEncoder().encode('-->'), 3, 0, ...link];
	const id3V22Tag = new Uint8Array([
		0x49, 0x44, 0x33, 2, 0, 0, 0, 0, 0, 6 + picFrameData.length, // 'ID3', version 2.2, size
		0x50, 0x49, 0x43, 0, 0, picFrameData.length, ...picFrameData, // 'PIC', size
	]);
	const output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
	const dummyTrack = createDummyAudioTrack('mp3', output);
	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();
	using input = new Input({
		source: new BufferSource(new Uint8Array([...id3V22Tag, ...new Uint8Array(output.target.buffer!)])),
		formats: ALL_FORMATS,
	});
	const readTags = await input.getMetadataTags();
	expect(readTags.raw!['PIC']).toBeInstanceOf(Uint8Array);
	expect(readTags.images ?? []).toHaveLength(0);
});

test('Picture links survive copies to the same format and aren\'t written as images in others', async () => {
	const link = new TextEncoder().encode('https://example.com/cover.jpg');
	const images: MetadataTags['images'] = [
		{ data: link, mimeType: '-->', kind: 'coverFront' },
		songMetadata.images![0]!,
	];
	type Format = FlacOutputFormat | OggOutputFormat | Mp4OutputFormat | MkvOutputFormat;
	const convert = async (source: BufferSource | FilePathSource, format: Format, tags?: MetadataTags) => {
		using input = new Input({ source, formats: ALL_FORMATS });
		const output = new Output({ format, target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, tags });
		await conversion.execute();
		return output.target.buffer!;
	};
	const readTags = async (bytes: ArrayBuffer) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return await input.getMetadataTags();
	};
	// The media types of the METADATA_BLOCK_PICTURE raw tags, which hold FLAC PICTURE blocks
	const rawPictureMediaTypes = (tags: MetadataTags) => {
		const value = tags.raw?.['METADATA_BLOCK_PICTURE'];
		return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((value) => {
			const bytes = Uint8Array.from(atob(value as string), char => char.charCodeAt(0));
			const length = new DataView(bytes.buffer).getUint32(4);
			return new TextDecoder().decode(bytes.subarray(8, 8 + length));
		});
	};
	const expectOnlyTheCover = (tags: MetadataTags) => {
		expect(tags.images).toHaveLength(1);
		expect(tags.images![0]!.data).toEqual(coverArt);
	};

	// FLAC: converted again with the tags read, the link is kept. Converted to MP4 and Matroska, it's not an image.
	const flac = await convert(
		new FilePathSource(path.join(__dirname, '..', 'public/sample.flac')),
		new FlacOutputFormat(),
		{ images },
	);
	const convertedFlacTags = await readTags(await convert(new BufferSource(flac), new FlacOutputFormat()));
	expectOnlyTheCover(convertedFlacTags);
	expect(rawPictureMediaTypes(convertedFlacTags)).toEqual(['-->']);
	expectOnlyTheCover(await readTags(await convert(new BufferSource(flac), new Mp4OutputFormat())));
	expectOnlyTheCover(await readTags(await convert(new BufferSource(flac), new MkvOutputFormat())));

	// Ogg: the same, with the tags read written again
	const writeOgg = async (tags: MetadataTags) => {
		const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
		output.setMetadataTags(tags);
		const dummyTrack = createDummyAudioTrack('opus', output);
		await output.start();
		await dummyTrack.addPacket();
		await output.finalize();
		return output.target.buffer!;
	};
	const ogg = await writeOgg({ images });
	const copiedOggTags = await readTags(await writeOgg(await readTags(ogg)));
	expectOnlyTheCover(copiedOggTags);
	expect(rawPictureMediaTypes(copiedOggTags).sort()).toEqual(['-->', 'image/jpeg']);
	expectOnlyTheCover(await readTags(await convert(new BufferSource(ogg), new Mp4OutputFormat())));
});

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

test('MP4 cover art whose data type disagrees with the image', async () => {
	// Taggers get the type wrong: mutagen's MP4Cover, for one, writes PNG images with the JPEG type unless told
	// otherwise. Like in FFmpeg, the image's signature decides.
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
	const readCoverMimeType = async (image: Uint8Array, mimeType: string, typeIndicator: number) => {
		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});
		output.setMetadataTags({ images: [{ data: image, mimeType, kind: 'coverFront' }] });
		const dummyTrack = createDummyAudioTrack('aac', output);
		await output.start();
		await dummyTrack.addPacket();
		await output.finalize();

		// Rewrite the last byte of the type indicator, after the covr box's name and its data box's size and name
		const bytes = new Uint8Array(output.target.buffer!);
		const covr = bytes.findIndex((_, i) => [0x63, 0x6f, 0x76, 0x72].every((byte, j) => bytes[i + j] === byte));
		expect(bytes[covr + 4 + 4 + 4 + 3]).toBe(mimeType === 'image/png' ? 14 : 13);
		bytes[covr + 4 + 4 + 4 + 3] = typeIndicator;

		using input = new Input({
			source: new BufferSource(bytes),
			formats: ALL_FORMATS,
		});
		const images = (await input.getMetadataTags()).images!;
		expect(images).toHaveLength(1);
		expect(images[0]!.data).toEqual(image);

		return images[0]!.mimeType;
	};

	expect(await readCoverMimeType(png, 'image/png', 13)).toBe('image/png');
	expect(await readCoverMimeType(jpeg, 'image/jpeg', 14)).toBe('image/jpeg');
	expect(await readCoverMimeType(png, 'image/png', 14)).toBe('image/png');
	expect(await readCoverMimeType(jpeg, 'image/jpeg', 13)).toBe('image/jpeg');
	// Neither signature, so the type decides
	expect(await readCoverMimeType(coverArt, 'image/jpeg', 14)).toBe('image/png');
	expect(await readCoverMimeType(coverArt, 'image/jpeg', 13)).toBe('image/jpeg');
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

test('MP4 mdta metadata is written as a MetaBox with version and flags, like FFmpeg', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ metadataFormat: 'mdta' }),
		target: new BufferTarget(),
	});
	output.setMetadataTags({ title: 'Hello' });

	const dummyTrack = createDummyAudioTrack('aac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	const ascii = String.fromCharCode(...bytes);
	const metaPos = ascii.indexOf('meta', ascii.indexOf('udta'));
	expect(metaPos).toBeGreaterThan(0);

	// moov/udta/meta must carry version and flags before its hdlr child (ExifTool reads no tags otherwise)
	const view = new DataView(bytes.buffer, bytes.byteOffset);
	expect(view.getUint32(metaPos + 4)).toBe(0);
	expect(ascii.slice(metaPos + 12, metaPos + 16)).toBe('hdlr');
	expect(ascii.slice(metaPos + 24, metaPos + 28)).toBe('mdta');
});

test('MP4 writes cover art not tagged as the front cover when there\'s no front cover', async () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const writeAndRead = async (images: NonNullable<MetadataTags['images']>, metadataFormat: 'mdir' | 'mdta') => {
		const output = new Output({ format: new Mp4OutputFormat({ metadataFormat }), target: new BufferTarget() });
		output.setMetadataTags({ images });

		const dummyTrack = createDummyAudioTrack('aac', output);
		await output.start();
		await dummyTrack.addPacket();
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const readTags = await input.getMetadataTags();
		return readTags.images?.map(image => image.data) ?? [];
	};

	for (const metadataFormat of ['mdir', 'mdta'] as const) {
		// FFmpeg tags the covers it writes as "other" (ID3 APIC/FLAC PICTURE type 0), which are read as 'unknown'.
		// Such images used to be dropped, leaving no artwork at all.
		expect(await writeAndRead([{ data: png, mimeType: 'image/png', kind: 'unknown' }], metadataFormat))
			.toEqual([png]);
		expect(await writeAndRead([{ data: coverArt, mimeType: 'image/jpeg', kind: 'coverBack' }], metadataFormat))
			.toEqual([coverArt]);

		// With a front cover, only front covers are written, as before
		expect(await writeAndRead([
			{ data: coverArt, mimeType: 'image/jpeg', kind: 'coverFront' },
			{ data: png, mimeType: 'image/png', kind: 'unknown' },
		], metadataFormat)).toEqual([coverArt]);
	}
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

test('Read iTunes freeform tags, MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: false }),
		target: new BufferTarget(),
	});

	output.setMetadataTags({ title: 'Title' });

	const dummyTrack = createDummyAudioTrack('aac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	// Append two freeform items (as written by iTunes, AtomicParsley or Picard) to the ilst. The moov comes last, so
	// ilst, meta, udta and moov all end at the end of the file and only their sizes need to grow.
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const atom = (name: string, content: number[]) => [...u32(8 + content.length), ...ascii(name), ...content];
	const freeformItem = (mean: string, name: string, value: string) => atom('----', [
		...atom('mean', [0, 0, 0, 0, ...ascii(mean)]),
		...atom('name', [0, 0, 0, 0, ...ascii(name)]),
		...atom('data', [...u32(1), ...u32(0), ...ascii(value)]),
	]);
	const items = [
		...freeformItem('com.apple.iTunes', 'iTunSMPB', ' 00000000 00000840 000001C0 0000000000000000'),
		...freeformItem('com.apple.iTunes', 'MusicBrainz Track Id', 'b1a9c0e9-d987-4042-ae91-78d6a3267d69'),
	];

	const original = new Uint8Array(output.target.buffer!);
	const bytes = new Uint8Array(original.length + items.length);
	bytes.set(original, 0);
	bytes.set(items, original.length);
	const view = new DataView(bytes.buffer);
	for (const name of ['moov', 'udta', 'meta', 'ilst']) {
		const position = Buffer.from(original).lastIndexOf(Buffer.from(name)) - 4;
		view.setUint32(position, view.getUint32(position) + items.length);
	}

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const tags = await input.getMetadataTags();
	expect(tags.title).toBe('Title');
	expect(tags.raw!['----:com.apple.iTunes:iTunSMPB']).toBe(' 00000000 00000840 000001C0 0000000000000000');
	expect(tags.raw!['----:com.apple.iTunes:MusicBrainz Track Id']).toBe('b1a9c0e9-d987-4042-ae91-78d6a3267d69');
	expect('----' in tags.raw!).toBe(false);
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

test('WebM output leaves out Attachments, which WebM does not support', async () => {
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		title: songMetadata.title,
		images: songMetadata.images,
		raw: { 123: new AttachedFile(new Uint8Array(20), 'font/ttf', 'Heya') },
	});

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	const attachmentsId = [0x19, 0x41, 0xa4, 0x69];
	const hasAttachments = bytes.some((_, i) => attachmentsId.every((byte, j) => bytes[i + j] === byte));
	expect(hasAttachments).toBe(false);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();
	expect(readTags.title).toBe(songMetadata.title); // Tags are still written
	expect(readTags.images).toBeUndefined();
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

test('A malformed ID3 tag fails every getMetadataTags() call, MP3 and ADTS', async () => {
	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({ title: 'Title', artist: 'Artist' });

	const dummyTrack = createDummyAudioTrack('mp3', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	// TPE1's text encoding byte becomes 4, which doesn't exist
	const mp3 = new Uint8Array(output.target.buffer!);
	mp3[Buffer.from(mp3).indexOf('TPE1') + 10] = 4;

	// The same tag in front of an ADTS stream
	const tagSize = 10 + ((mp3[6]! << 21) | (mp3[7]! << 14) | (mp3[8]! << 7) | mp3[9]!);
	const aac = readFileSync(path.join(__dirname, '../public/sample3.aac')).subarray(0, 10_000);
	const adts = new Uint8Array([...mp3.subarray(0, tagSize), ...aac]);

	for (const bytes of [mp3, adts]) {
		const input = new Input({
			source: new BufferSource(bytes),
			formats: ALL_FORMATS,
		});

		await expect(input.getMetadataTags()).rejects.toThrow('Unsupported text encoding: 4');
		// Again, rather than the tags read before the error
		await expect(input.getMetadataTags()).rejects.toThrow('Unsupported text encoding: 4');

		input.dispose();
	}
});

test('Keep the raw COMM and USLT frames with a content descriptor when writing a comment and lyrics, MP3', async () => {
	const latin1 = (text: string) => [...text].map(char => char.charCodeAt(0));
	const utf16 = (text: string) => [0xff, 0xfe, ...latin1(text).flatMap(code => [code, 0])]; // With a BOM
	// An ID3v2.3 frame holding an encoding, a language, a content descriptor and a text, in ISO 8859-1 or UTF-16
	const describedFrame = (id: string, description: string, text: string, inUtf16 = false) => {
		const body = inUtf16
			? [1, ...latin1('eng'), ...utf16(description), 0, 0, ...utf16(text)]
			: [0, ...latin1('eng'), ...latin1(description), 0, ...latin1(text)];
		return [...latin1(id), 0, 0, 0, body.length, 0, 0, ...body];
	};
	const mp3Frame = new Uint8Array(417); // MPEG-1 Layer III, 128 kbps, 44.1 kHz
	mp3Frame.set([0xff, 0xfb, 0x90, 0x64]);

	const readTags = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return await input.getMetadataTags();
	};
	const writeMp3 = async (tags: MetadataTags) => {
		const output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
		output.setMetadataTags(tags);
		const source = new EncodedAudioPacketSource('mp3');
		output.addAudioTrack(source);
		await output.start();
		for (let i = 0; i < 3; i++) {
			await source.add(new EncodedPacket(mp3Frame, 'key', i * 1152 / 44100, 1152 / 44100), {
				decoderConfig: { codec: 'mp3', numberOfChannels: 2, sampleRate: 44100 },
			});
		}
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};
	const framesOf = (value: unknown) => value instanceof Uint8Array ? [value] : value as Uint8Array[];

	// Like iTunes, which keeps its gapless info in a COMM frame described "iTunSMPB", all in UTF-16
	const tagBody = [
		...describedFrame('COMM', '', 'A comment', true),
		...describedFrame('COMM', 'iTunSMPB', ' 00000000 00000210 0000096C', true),
		...describedFrame('USLT', '', 'Lyrics'),
		...describedFrame('USLT', 'Chorus', 'La la'),
	];
	const tags = await readTags(new Uint8Array([
		...latin1('ID3'), 3, 0, 0, ...[21, 14, 7, 0].map(shift => (tagBody.length >> shift) & 0x7f), ...tagBody,
		...mp3Frame, ...mp3Frame, ...mp3Frame,
	]));
	expect(tags.comment).toBe('A comment');
	expect(tags.lyrics).toBe('Lyrics');
	const iTunSmpb = framesOf(tags.raw!['COMM'])[1]!;
	const chorus = framesOf(tags.raw!['USLT'])[1]!;

	// Written back as read, and with a new comment and lyrics: the frames without a descriptor are replaced, the
	// others kept
	for (const [comment, lyrics] of [['A comment', 'Lyrics'], ['New comment', 'New lyrics']]) {
		const written = await readTags(await writeMp3({ ...tags, comment, lyrics }));
		expect(written.comment).toBe(comment);
		expect(written.lyrics).toBe(lyrics);
		expect(framesOf(written.raw!['COMM'])).toHaveLength(2);
		expect(framesOf(written.raw!['COMM'])[1]).toEqual(iTunSmpb);
		expect(framesOf(written.raw!['USLT'])).toHaveLength(2);
		expect(framesOf(written.raw!['USLT'])[1]).toEqual(chorus);
	}
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

test('Read metadata of Ogg files with several logical streams once', async () => {
	// Each logical stream carries its own comment header, with the same tags
	const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
	output.setMetadataTags({
		title: 'Title',
		images: songMetadata.images,
		raw: { ARTIST: ['Artist A', 'Artist B'] },
	});
	const dummyTracks = [createDummyAudioTrack('opus', output), createDummyAudioTrack('opus', output)];
	await output.start();
	for (const dummyTrack of dummyTracks) {
		await dummyTrack.addPacket();
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	expect(await input.getAudioTracks()).toHaveLength(2);
	const tags = await input.getMetadataTags();
	expect(tags.title).toBe('Title');
	expect(tags.raw!['TITLE']).toBe('Title');
	expect(tags.raw!['ARTIST']).toEqual(['Artist A', 'Artist B']);
	expect(tags.images).toHaveLength(1);
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

	// An ID3v2.3-style date split into the year (TYER) and the day and month (TDAT)
	const output = new Output({ format: new WavOutputFormat({ metadataFormat: 'id3' }), target: new BufferTarget() });
	output.setMetadataTags({ title: 'Title', raw: { TYER: '2021', TDAT: '2304' } });
	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(4096), 'key', 0, 1024 / 44100), {
		decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 44100 },
	});
	await output.finalize();

	// Removing or changing the date drops both frames, whose date would otherwise come back or stay in the file
	const convertWithDate = async (date: Date | undefined) => {
		using dateInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const dateOutput = new Output({
			format: new WavOutputFormat({ metadataFormat: 'id3' }),
			target: new BufferTarget(),
		});
		const dateConversion = await Conversion.init({
			input: dateInput,
			output: dateOutput,
			showWarnings: false,
			tags: inputTags => ({ ...inputTags, date }),
		});
		await dateConversion.execute();
		using dateResult = new Input({ source: new BufferSource(dateOutput.target.buffer!), formats: ALL_FORMATS });
		return await dateResult.getMetadataTags();
	};
	for (const date of [undefined, new Date('1999-06-01T00:00:00Z')]) {
		const dateTags = await convertWithDate(date);
		expect(dateTags.title).toBe('Title');
		expect(dateTags.date).toEqual(date);
		expect(dateTags.raw!['TYER']).toBeUndefined();
		expect(dateTags.raw!['TDAT']).toBeUndefined();
	}

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

test('Vorbis comments keep repeated fields when rewriting tags read from a file', async () => {
	const writeAndRead = async (format: 'flac' | 'ogg', tags: MetadataTags) => {
		const output = new Output({
			format: format === 'flac' ? new FlacOutputFormat() : new OggOutputFormat(),
			target: new BufferTarget(),
		});
		output.setMetadataTags(tags);
		const dummyTrack = createDummyAudioTrack(format === 'flac' ? 'flac' : 'opus', output);
		await output.start();
		await dummyTrack.addPacket();
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		return await input.getMetadataTags();
	};

	for (const format of ['flac', 'ogg'] as const) {
		// Fields repeat, as for several artists (RFC 9639, appendix D.2.3), when written by MusicBrainz Picard or
		// mutagen, for example
		const tags = await writeAndRead(format, {
			raw: { ARTIST: ['Artist A', 'Artist B'], GENRE: ['Jazz', 'Bebop'], TITLE: 'Title' },
		});
		expect(tags.artist).toBe('Artist A');
		expect(tags.raw!['ARTIST']).toEqual(['Artist A', 'Artist B']);

		// Writing the tags read, as a conversion does, keeps every value
		const rewrittenTags = await writeAndRead(format, tags);
		expect(rewrittenTags.artist).toBe('Artist A');
		expect(rewrittenTags.raw!['ARTIST']).toEqual(['Artist A', 'Artist B']);
		expect(rewrittenTags.raw!['GENRE']).toEqual(['Jazz', 'Bebop']);
		expect(rewrittenTags.raw!['TITLE']).toBe('Title');

		// A changed normalized tag replaces the field's values
		const changedTags = await writeAndRead(format, { ...tags, artist: 'Someone Else' });
		expect(changedTags.raw!['ARTIST']).toBe('Someone Else');

		// Field names are case-insensitive, so a raw tag doesn't repeat the field of a normalized one
		const caseTags = await writeAndRead(format, { title: 'Title', raw: { title: 'Title' } });
		expect(caseTags.raw!['TITLE']).toBe('Title');
	}
});

test('Conversion metadata tags, ID3v2 year that isn\'t a year', async () => {
	// The fixture's ID3v2.3 tag has the TYER "20190103": a whole date where the four-digit year belongs, as some
	// taggers write it
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/oversized-id3.wav')),
		formats: ALL_FORMATS,
	});

	const tags = await input.getMetadataTags();
	expect(tags.raw?.['TYER']).toBe('20190103');
	expect(tags.date).toBeUndefined(); // FFmpeg doesn't make a date of it either

	// Copying the tags used to throw, as they held an Invalid Date
	const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using converted = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	expect((await converted.getMetadataTags()).date).toBeUndefined();
});

test('Read ID3v2.3 dates from TYER and TDAT, MP3', async () => {
	const latin1 = (text: string) => [...text].map(char => char.charCodeAt(0));
	const mp3Frame = new Uint8Array(417); // MPEG-1 Layer III, 128 kbps, 44.1 kHz
	mp3Frame.set([0xff, 0xfb, 0x90, 0x64]);

	// Reads the date of an ID3v2 tag holding the given text frames, in front of three MP3 frames
	const readDate = async (frames: [string, string][], majorVersion = 3) => {
		const body = frames.flatMap(([id, text]) => {
			const size = text.length + 1;
			const sizeBytes = majorVersion === 4
				? [21, 14, 7, 0].map(shift => (size >> shift) & 0x7f)
				: [24, 16, 8, 0].map(shift => (size >>> shift) & 0xff);
			return [...latin1(id), ...sizeBytes, 0, 0, 0, ...latin1(text)];
		});
		const tagSize = [21, 14, 7, 0].map(shift => (body.length >> shift) & 0x7f);
		const bytes = new Uint8Array([
			...latin1('ID3'), majorVersion, 0, 0, ...tagSize, ...body,
			...mp3Frame, ...mp3Frame, ...mp3Frame,
		]);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return (await input.getMetadataTags()).date;
	};

	// A year
	expect(await readDate([['TYER', '2024']])).toEqual(new Date('2024-01-01T00:00:00Z'));
	// With the day and month ("DDMM"), as FFmpeg writes a whole date, in either order
	expect(await readDate([['TYER', '2021'], ['TDAT', '2304']])).toEqual(new Date('2021-04-23T00:00:00Z'));
	expect(await readDate([['TDAT', '2304'], ['TYER', '2021']])).toEqual(new Date('2021-04-23T00:00:00Z'));
	// A day and month that don't make a date are left out
	expect(await readDate([['TYER', '2021'], ['TDAT', '3102']])).toEqual(new Date('2021-01-01T00:00:00Z'));

	// A whole date where the year belongs gives no date, with or without a day, month and time
	expect(await readDate([['TYER', '20190103']])).toBeUndefined();
	expect(await readDate([['TYER', '20190103'], ['TDAT', '2304']])).toBeUndefined();
	expect(await readDate([['TYER', '20190103'], ['TDAT', '2304'], ['TIME', '1200']])).toBeUndefined();

	// The ID3v2.4 recording time is read as before
	expect(await readDate([['TDRC', '2024-03-15']], 4)).toEqual(new Date('2024-03-15T00:00:00Z'));
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

test('Read the ID3v2.4 release time as the date when there is no recording time, MP3', async () => {
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const textFrame = (id: string, text: string) => [...ascii(id), 0, 0, 0, text.length + 1, 0, 0, 0, ...ascii(text)];
	const tag = (frames: number[]) => [...ascii('ID3'), 4, 0, 0, 0, 0, 0, frames.length, ...frames];

	const mp3Frames = new Uint8Array(3 * 417);
	for (let i = 0; i < 3; i++) {
		mp3Frames.set([0xff, 0xfb, 0x90, 0x00], i * 417);
	}

	const readDate = async (...tags: number[][]) => {
		using input = new Input({
			source: new BufferSource(new Uint8Array([...tags.flat(), ...mp3Frames])),
			formats: ALL_FORMATS,
		});
		return (await input.getMetadataTags()).date;
	};

	// As written by older FFmpeg versions
	expect(await readDate(tag(textFrame('TDRL', '1997')))).toEqual(new Date('1997-01-01T00:00:00Z'));
	// The recording time still wins
	expect(await readDate(tag([...textFrame('TDRL', '1997'), ...textFrame('TDRC', '1995')])))
		.toEqual(new Date('1995-01-01T00:00:00Z'));
	// Even when it's in a later tag (the MP3 demuxer reads every ID3v2 tag in front of the audio)
	expect(await readDate(tag(textFrame('TDRL', '1997')), tag(textFrame('TDRC', '1995'))))
		.toEqual(new Date('1995-01-01T00:00:00Z'));
	expect(await readDate(tag(textFrame('TDRL', '1997')), tag(textFrame('TYER', '1995'))))
		.toEqual(new Date('1995-01-01T00:00:00Z'));
	// While the first recording time still beats one in a later tag
	expect(await readDate(tag(textFrame('TDRC', '1995')), tag(textFrame('TDRC', '1990'))))
		.toEqual(new Date('1995-01-01T00:00:00Z'));
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

test('Conversion metadata tags, raw ID3v2 frames of WAVE and FLAC files', async () => {
	const writeWave = async (metadataFormat: 'info' | 'id3', tags: MetadataTags) => {
		const output = new Output({ format: new WavOutputFormat({ metadataFormat }), target: new BufferTarget() });
		output.setMetadataTags(tags);
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(4410 * 4), 'key', 0, 0.1), {
			decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 44100 },
		});
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	const read = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return await input.getMetadataTags();
	};

	const convert = async (bytes: Uint8Array, format: WavOutputFormat | FlacOutputFormat) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const output = new Output({ format, target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, showWarnings: false });
		await conversion.execute();

		return read(new Uint8Array(output.target.buffer!));
	};

	// A WAVE file with an ID3 chunk keeps its fields, but its ID3v2 frames don't become RIFF INFO chunks...
	const id3Wave = await writeWave('id3', { artist: 'Artist', album: 'Album', raw: { TCOM: 'Composer' } });
	expect((await read(id3Wave)).raw).toEqual({ TPE1: 'Artist', TALB: 'Album', TCOM: 'Composer' });
	const fromId3 = await convert(id3Wave, new WavOutputFormat());
	expect(fromId3.artist).toBe('Artist');
	expect(fromId3.album).toBe('Album');
	expect(fromId3.raw).toEqual({ IART: 'Artist', IPRD: 'Album' });

	// ...and RIFF INFO chunks don't become ID3v2 frames, while they stay when the output writes them too
	const infoWave = await writeWave('info', { artist: 'Artist', raw: { ICOP: 'Copyright' } });
	expect((await convert(infoWave, new WavOutputFormat({ metadataFormat: 'id3' }))).raw).toEqual({ TPE1: 'Artist' });
	expect((await convert(infoWave, new WavOutputFormat())).raw).toEqual({ IART: 'Artist', ICOP: 'Copyright' });

	// A FLAC file with an ID3v2.4 tag (TCOM "Composer") in front keeps its Vorbis comments, but the ID3v2 frames don't
	// become Vorbis comments
	const tag = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 19, 0x54, 0x43, 0x4f, 0x4d, 0, 0, 0, 9, 0, 0, 3, ...'Composer']
		.map(x => typeof x === 'string' ? x.charCodeAt(0) : x);
	const flac = new Uint8Array([...tag, ...readFileSync(path.join(__dirname, '../public/sample.flac'))]);
	expect((await read(flac)).raw!['TCOM']).toBe('Composer');
	const fromFlac = await convert(flac, new FlacOutputFormat());
	expect(fromFlac.title).toBe('The Happy Meeting');
	expect(fromFlac.raw!['ARTIST']).toBe('Samples Files');
	expect(fromFlac.raw!['TCOM']).toBeUndefined();
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

test('Read the ID3 tags of a WAV file only for the metadata tags, not to get its track', async () => {
	// One second of 8 kHz mono 16-bit PCM, then an 'id3 ' chunk (as DJ software and taggers write it) holding an
	// ID3v2.3 tag with a title and an 8 MiB picture
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const imageSize = 8 * 2 ** 20;
	const titleFrame = [...ascii('TIT2'), 0, 0, 0, 6, 0, 0, 0, ...ascii('Title')];
	const apicBody = new Uint8Array(1 + 10 + 1 + 1 + imageSize);
	apicBody.set([0, ...ascii('image/png'), 0, 3, 0, 0x89, 0x50, 0x4e, 0x47]);
	const id3Size = titleFrame.length + 10 + apicBody.length;
	const id3 = new Uint8Array(10 + id3Size);
	id3.set([...ascii('ID3'), 3, 0, 0, ...[21, 14, 7, 0].map(shift => (id3Size >> shift) & 0x7f)]);
	id3.set(titleFrame, 10);
	const apicSize = [24, 16, 8, 0].map(shift => (apicBody.length >>> shift) & 0xff); // Plain in ID3v2.3
	id3.set([...ascii('APIC'), ...apicSize, 0, 0], 10 + titleFrame.length);
	id3.set(apicBody, 20 + titleFrame.length);

	const pcmSize = 16000;
	const bytes = new Uint8Array(12 + 24 + 8 + pcmSize + 8 + id3.length);
	const view = new DataView(bytes.buffer);
	bytes.set(ascii('RIFF'), 0);
	view.setUint32(4, bytes.length - 8, true);
	bytes.set(ascii('WAVEfmt '), 8);
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // Mono
	view.setUint32(24, 8000, true);
	view.setUint32(28, 16000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	bytes.set(ascii('data'), 36);
	view.setUint32(40, pcmSize, true);
	bytes.set(ascii('id3 '), 44 + pcmSize);
	view.setUint32(48 + pcmSize, id3.length, true);
	bytes.set(id3, 52 + pcmSize);

	let bytesRead = 0;
	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomSource({
			getSize: () => bytes.byteLength,
			read: (start, end) => {
				bytesRead += end - start;
				return bytes.subarray(start, end);
			},
		}),
	});

	const track = await input.getPrimaryAudioTrack();
	expect(await track!.getSampleRate()).toBe(8000);
	expect(bytesRead).toBeLessThan(2 ** 20);

	const tags = await input.getMetadataTags();
	expect(tags.title).toBe('Title');
	expect(tags.images![0]!.data.byteLength).toBe(imageSize);
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

test('Non-Latin-1 lyrics', async () => {
	const lyrics = String.fromCharCode(0x6b4c, 0x8a5e);
	const tags = await readMetadataTags(await writeMp3({
		lyrics,
		comment: 'Comment',
	}));

	expect(tags.lyrics).toBe(lyrics);
	expect(tags.comment).toBe('Comment');
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

test('Picture descriptions with non-ASCII characters, FLAC', async () => {
	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});

	const descriptions = ['Pochette – Café', '封面画像'];
	output.setMetadataTags({
		images: descriptions.map(description => ({
			data: coverArt,
			kind: 'coverFront',
			mimeType: 'image/jpeg',
			description,
		})),
	});

	const dummyTrack = createDummyAudioTrack('flac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();
	expect(readTags.images!.map(image => image.description)).toEqual(descriptions);
	expect(readTags.images!.map(image => image.data)).toEqual([coverArt, coverArt]);

	// The PICTURE block gives the description's length in bytes (RFC 9639, section 8.8), and the width, height,
	// color depth and number of colors after it are written as unknown
	const view = new DataView(bytes.buffer);
	const pictureFields: number[][] = [];
	for (let pos = 4, isLast = false; !isLast; pos += 4 + view.getUint32(pos) % 2 ** 24) {
		isLast = (bytes[pos]! & 0x80) !== 0;
		if ((bytes[pos]! & 0x7f) === 6) {
			const descriptionPos = pos + 12 + view.getUint32(pos + 8);
			const fieldsPos = descriptionPos + 4 + view.getUint32(descriptionPos);
			pictureFields.push([0, 4, 8, 12].map(offset => view.getUint32(fieldsPos + offset)));
		}
	}
	expect(pictureFields).toEqual([[0, 0, 0, 0], [0, 0, 0, 0]]);
});

test('MP3 to MP3 conversion with images', async () => {
	using input = new Input({
		source: new BufferSource(await writeMp3({
			images: [{
				data: new Uint8Array([1, 2, 3]),
				mimeType: 'image/png',
				kind: 'coverFront',
			}],
		})),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
	});
	await conversion.execute();

	const tags = await readMetadataTags(new Uint8Array(output.target.buffer!));
	expect(tags.images).toHaveLength(1);
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

test('Conversion metadata tags, RIFF INFO year that isn\'t a year', async () => {
	// A WAVE file whose RIFF INFO chunk has the given YEAR
	const writeWithYear = async (year: string) => {
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		output.setMetadataTags({ title: 'Title', raw: { YEAR: year } });
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(400), 'key', 0, 100 / 44100), {
			decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 44100 },
		});
		await output.finalize();
		return output.target.buffer!;
	};

	// A year, at the start of it in UTC like the other dates read
	using input2013 = new Input({ source: new BufferSource(await writeWithYear('2013')), formats: ALL_FORMATS });
	expect((await input2013.getMetadataTags()).date).toEqual(new Date('2013-01-01T00:00:00Z'));

	// A whole date where the year belongs: no date, rather than an Invalid Date
	using input = new Input({ source: new BufferSource(await writeWithYear('20190103')), formats: ALL_FORMATS });
	const tags = await input.getMetadataTags();
	expect(tags.raw?.['YEAR']).toBe('20190103');
	expect(tags.date).toBeUndefined();

	// Copying the tags used to throw, as they held an Invalid Date
	const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using converted = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const convertedTags = await converted.getMetadataTags();
	expect(convertedTags.title).toBe('Title');
	expect(convertedTags.date).toBeUndefined();
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

const bytesOf = (source: AllowSharedBufferSource) => ArrayBuffer.isView(source)
	? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
	: new Uint8Array(source);

test('Getters return copies that callers can modify without affecting the input', async () => {
	for (const file of ['video.mp4', 'demo.webm', 'Toothsome-Meme.VBRv2.mp3']) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '..', 'public', file)),
			formats: ALL_FORMATS,
		});
		const mimeType = await input.getMimeType();
		const track = (await input.getTracks())[0] as InputVideoTrack | InputAudioTrack;
		const codecString = await track.getCodecParameterString();

		const tags = await input.getMetadataTags();
		const title = tags.title;
		tags.title = 'Changed';
		tags.raw = {};
		const config = (await track.getDecoderConfig())!;
		config.codec = 'vp8';
		const description = config.description && bytesOf(config.description).slice();
		if (config.description) {
			bytesOf(config.description).fill(0); // Changed in place
		}
		const disposition = await track.getDisposition();
		disposition.default = !disposition.default;

		expect((await input.getMetadataTags()).title, file).toBe(title);
		expect((await track.getDecoderConfig())!.codec, file).toBe(codecString);
		const freshDescription = (await track.getDecoderConfig())!.description;
		expect(freshDescription && bytesOf(freshDescription), file).toEqual(description);
		expect(await track.getCodecParameterString(), file).toBe(codecString);
		expect(await input.getMimeType(), file).toBe(mimeType);
		expect((await track.getDisposition()).default, file).toBe(!disposition.default);

		if (track.isVideoTrack()) {
			const ratio = await track.getPixelAspectRatio();
			ratio.num = 99;
			expect((await track.getPixelAspectRatio()).num, file).not.toBe(99);
		}
	}

	// Tags holding Dates, image bytes, attachments and binary raw values, changed in place
	for (const format of [new Mp4OutputFormat(), new MkvOutputFormat()]) {
		const output = new Output({ format, target: new BufferTarget() });
		const track = createDummyAudioTrack('pcm-s16', output);
		output.setMetadataTags({
			date: new Date(Date.UTC(2024, 0, 2)),
			creationTime: new Date(Date.UTC(2025, 0, 1)),
			images: [{ data: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/png', kind: 'coverFront' }],
			raw: format instanceof MkvOutputFormat ? { CUSTOM_BINARY: new Uint8Array([5, 6, 7]) } : undefined,
		});
		await output.start();
		await track.addPacket();
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const original = await input.getMetadataTags();
		const tags = await input.getMetadataTags();
		tags.date!.setTime(0);
		tags.creationTime!.setTime(0);
		tags.images![0]!.data.fill(0);
		for (const value of Object.values(tags.raw!)) {
			if (value instanceof Uint8Array) {
				value.fill(0);
			} else if (value instanceof RichImageData || value instanceof AttachedFile) {
				value.data.fill(0);
			}
		}

		expect(await input.getMetadataTags()).toEqual(original);
		expect(original.creationTime!.getTime()).toBe(Date.UTC(2025, 0, 1));
		expect([...original.images![0]!.data]).toEqual([1, 2, 3, 4]);
	}
});

test('A malformed ID3 tag keeps WAVE and FLAC files readable', async () => {
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const frame = (id: string, body: number[]) => [...ascii(id), 0, 0, 0, body.length, 0, 0, ...body];
	// ID3v2.4: a valid TIT2 frame, then a TPE1 frame with the undefined text encoding 4
	const frames = [...frame('TIT2', [0, ...ascii('Title')]), ...frame('TPE1', [4, ...ascii('Artist')])];
	const tag = [...ascii('ID3'), 4, 0, 0, 0, 0, 0, frames.length, ...frames];

	const le32 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
	const wavChunks = [
		...ascii('WAVE'),
		...ascii('fmt '), ...le32(16), 1, 0, 1, 0, ...le32(8000), ...le32(16000), 2, 0, 16, 0, // Mono 16-bit PCM
		...ascii('data'), ...le32(4), 0, 0, 0, 0,
		...ascii('ID3 '), ...le32(tag.length), ...tag, ...(tag.length % 2 ? [0] : []),
	];
	const wav = new Uint8Array([...ascii('RIFF'), ...le32(wavChunks.length), ...wavChunks]);

	const flacFile = fs.readFileSync(path.join(__dirname, '..', 'public/sample.flac'));
	const flac = new Uint8Array(tag.length + flacFile.byteLength);
	flac.set(tag, 0);
	flac.set(flacFile, tag.length);

	for (const bytes of [wav, flac]) {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

		const track = await input.getPrimaryAudioTrack();
		expect(track).not.toBeNull();
		expect(await new EncodedPacketSink(track!).getFirstPacket()).not.toBeNull();

		// Like for MP3 files, only reading the tags fails
		await expect(input.getMetadataTags()).rejects.toThrow('Unsupported text encoding: 4');
	}
});

test('Read the disc number of FFmpeg use_metadata_tags files', async () => {
	// ffmpeg -i in.mp4 -c copy -movflags use_metadata_tags -metadata track=3/12 -metadata disc=2/5 out.mp4
	const output = new Output({
		format: new Mp4OutputFormat({ metadataFormat: 'mdta' }),
		target: new BufferTarget(),
	});

	// FFmpeg writes its generic keys, with string values
	output.setMetadataTags({ raw: { track: '3/12', disc: '2/5' } });

	const dummyTrack = createDummyAudioTrack('aac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();
	expect(readTags.trackNumber).toBe(3);
	expect(readTags.tracksTotal).toBe(12);
	expect(readTags.discNumber).toBe(2);
	expect(readTags.discsTotal).toBe(5);
});

test('Leave out raw ID3v2.3 date frames that contradict the written date, MP3', async () => {
	const latin1 = (text: string) => [...text].map(char => char.charCodeAt(0));
	const mp3Frame = new Uint8Array(417); // MPEG-1 Layer III, 128 kbps, 44.1 kHz
	mp3Frame.set([0xff, 0xfb, 0x90, 0x64]);

	const readTags = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return await input.getMetadataTags();
	};
	const writeAndRead = async (tags: MetadataTags) => {
		const output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
		output.setMetadataTags(tags);
		const source = new EncodedAudioPacketSource('mp3');
		output.addAudioTrack(source);
		await output.start();
		for (let i = 0; i < 3; i++) {
			await source.add(new EncodedPacket(mp3Frame, 'key', i * 1152 / 44100, 1152 / 44100), {
				decoderConfig: { codec: 'mp3', numberOfChannels: 2, sampleRate: 44100 },
			});
		}
		await output.finalize();
		return await readTags(new Uint8Array(output.target.buffer!));
	};

	// Raw frames as read from an ID3v2.3 tag, which stores the date as the year, "DDMM", "HHMM" and free text
	const raw = { TIT2: 'Title', TYER: '2021', TDAT: '2304', TIME: '1530', TRDA: '23rd April 2021' };
	const v23DateFrames = ['TYER', 'TDAT', 'TIME', 'TRDA'];
	const copiedV23DateFrames = (tags: MetadataTags) =>
		Object.keys(tags.raw!).filter(key => v23DateFrames.includes(key));

	// A changed date: ID3v2.4, which the writer writes, replaced those frames by TDRC, and FFmpeg would show the old
	// date from them instead of it
	for (const date of ['1999-01-01', '2021-06-01']) {
		const written = await writeAndRead({ date: new Date(`${date}T00:00:00Z`), raw });
		expect(written.raw!['TDRC']).toBe(date);
		expect(copiedV23DateFrames(written), date).toEqual([]);
	}

	// The date they hold, as read from them (the year, with TDAT's day and month, or TDAT on its own when it comes
	// first): still copied, as FFmpeg reads the day and month of an unchanged date from them
	for (const date of ['2021-01-01', '2021-04-23', '2304-01-01']) {
		const written = await writeAndRead({ date: new Date(`${date}T00:00:00Z`), raw });
		expect(copiedV23DateFrames(written), date).toEqual(v23DateFrames);
	}

	// Without a date, they're copied too
	expect((await writeAndRead({ raw })).raw).toMatchObject(raw);

	// End to end, like a Conversion: ID3v2.3 tags copied unchanged keep their date frames, whatever the date is read as
	const textFrame = (id: string, text: string) => [...latin1(id), 0, 0, 0, text.length + 1, 0, 0, 0, ...latin1(text)];
	for (const frames of [
		[textFrame('TYER', '2021'), textFrame('TDAT', '2304')], // As `ffmpeg -id3v2_version 3` writes a whole date
		[textFrame('TYER', '2021')], // A year alone
		[textFrame('TYER', '2021'), textFrame('TDAT', '2304'), textFrame('TIME', '1530')],
		[textFrame('TDAT', '2304'), textFrame('TYER', '2021')],
	]) {
		const body = frames.flat();
		const source = new Uint8Array([
			...latin1('ID3'), 3, 0, 0, 0, 0, 0, body.length, ...body,
			...mp3Frame, ...mp3Frame, ...mp3Frame,
		]);
		const written = await writeAndRead(await readTags(source));
		expect(copiedV23DateFrames(written)).toEqual(frames.map(frame => String.fromCharCode(...frame.slice(0, 4))));
	}
});
