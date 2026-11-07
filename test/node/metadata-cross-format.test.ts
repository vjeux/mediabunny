import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ADTS,
	ALL_FORMATS,
	AdtsOutputFormat,
	AttachedFile,
	AttachedImage,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacketSink,
	FlacOutputFormat,
	Input,
	InputFormat,
	MATROSKA,
	MetadataTags,
	MkvOutputFormat,
	MovOutputFormat,
	MP3,
	Mp3OutputFormat,
	MP4,
	Mp4OutputFormat,
	OGG,
	OggOutputFormat,
	Output,
	OutputFormat,
	QTFF,
	RichImageData,
	WAVE,
	WavOutputFormat,
	WEBM,
	WebMOutputFormat,
	FLAC,
} from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicFile = (name: string) => new Uint8Array(fs.readFileSync(path.join(__dirname, '../public', name)));

// Minimal but well-formed image payloads, so readers that sniff signatures are happy too
const JPEG = new Uint8Array([
	0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9,
]);
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const FRONT_COVER: AttachedImage = { data: JPEG, mimeType: 'image/jpeg', kind: 'coverFront', description: 'Front' };
const BACK_COVER: AttachedImage = { data: PNG, mimeType: 'image/png', kind: 'coverBack', description: 'Back' };

const TAGS = {
	title: 'Tïtle – 鱼 😀',
	description: 'A description',
	artist: 'Artist',
	album: 'Album',
	albumArtist: 'Album Artist',
	genre: 'Genre',
	comment: 'A comment',
	lyrics: 'Line one\nLine two',
	trackNumber: 3,
	tracksTotal: 12,
	discNumber: 2,
	discsTotal: 4,
	beatsPerMinute: 128,
	date: new Date('2021-04-23T13:14:15Z'),
	images: [FRONT_COVER, BACK_COVER],
	creationTime: new Date('2020-01-02T03:04:05Z'),
} satisfies MetadataTags;

type Field = Exclude<keyof MetadataTags, 'raw' | 'images' | 'creationTime' | 'date'>;
const ALL_FIELDS: Field[] = [
	'title', 'description', 'artist', 'album', 'albumArtist', 'genre', 'comment', 'lyrics',
	'trackNumber', 'tracksTotal', 'discNumber', 'discsTotal', 'beatsPerMinute',
];

type FormatCase = {
	name: string;
	makeFormat: () => OutputFormat;
	inputFormat: InputFormat;
	fixture: string;
	fields: Field[];
	/** Which images come back, by kind; null if the test doesn't write images to this format. */
	imageKinds: AttachedImage['kind'][] | null;
	imageDescriptions: boolean;
	creationTime: boolean;
};

const cases: FormatCase[] = [
	{
		name: 'MP4',
		makeFormat: () => new Mp4OutputFormat(),
		inputFormat: MP4,
		fixture: 'sample3.aac',
		fields: ALL_FIELDS,
		imageKinds: ['coverFront'],
		imageDescriptions: false,
		creationTime: true,
	},
	{
		name: 'MOV',
		makeFormat: () => new MovOutputFormat(),
		inputFormat: QTFF,
		fixture: 'sample3.aac',
		fields: ['title', 'description', 'artist', 'album', 'albumArtist', 'genre', 'comment', 'lyrics'],
		imageKinds: [],
		imageDescriptions: false,
		creationTime: true,
	},
	{
		name: 'MKV',
		makeFormat: () => new MkvOutputFormat(),
		inputFormat: MATROSKA,
		fixture: 'sample3.aac',
		fields: ALL_FIELDS,
		imageKinds: ['coverFront', 'coverBack'],
		imageDescriptions: true,
		creationTime: true,
	},
	{
		name: 'WebM',
		makeFormat: () => new WebMOutputFormat(),
		inputFormat: WEBM,
		fixture: 'preroll-test.opus',
		fields: ALL_FIELDS,
		// The WebM spec leaves out Matroska's Attachments element, where cover art would go
		imageKinds: null,
		imageDescriptions: true,
		creationTime: true,
	},
	{
		name: 'Ogg',
		makeFormat: () => new OggOutputFormat(),
		inputFormat: OGG,
		fixture: 'preroll-test.opus',
		fields: ALL_FIELDS,
		imageKinds: ['coverFront', 'coverBack'],
		imageDescriptions: true,
		creationTime: false,
	},
	{
		name: 'MP3',
		makeFormat: () => new Mp3OutputFormat(),
		inputFormat: MP3,
		fixture: 'Toothsome-Meme.VBRv2.mp3',
		fields: ALL_FIELDS,
		imageKinds: ['coverFront', 'coverBack'],
		imageDescriptions: true,
		creationTime: false,
	},
	{
		name: 'ADTS',
		makeFormat: () => new AdtsOutputFormat(),
		inputFormat: ADTS,
		fixture: 'sample3.aac',
		fields: ALL_FIELDS,
		imageKinds: ['coverFront', 'coverBack'],
		imageDescriptions: true,
		creationTime: false,
	},
	{
		name: 'FLAC',
		makeFormat: () => new FlacOutputFormat(),
		inputFormat: FLAC,
		fixture: 'sample.flac',
		fields: ALL_FIELDS,
		imageKinds: ['coverFront', 'coverBack'],
		imageDescriptions: true,
		creationTime: false,
	},
	{
		name: 'WAVE (ID3)',
		makeFormat: () => new WavOutputFormat({ metadataFormat: 'id3' }),
		inputFormat: WAVE,
		fixture: 'glitch-hop-is-dead.wav',
		fields: ALL_FIELDS,
		imageKinds: ['coverFront', 'coverBack'],
		imageDescriptions: true,
		creationTime: false,
	},
	{
		name: 'WAVE (INFO)',
		makeFormat: () => new WavOutputFormat(),
		inputFormat: WAVE,
		fixture: 'glitch-hop-is-dead.wav',
		// INFO has no fields for the rest, and its strings are ISO 8859-1, so the non-Latin-1 title is dropped
		fields: ['artist', 'album', 'genre', 'comment', 'trackNumber', 'tracksTotal'],
		imageKinds: [],
		imageDescriptions: false,
		creationTime: false,
	},
];

/** Copies the first packets of the fixture's primary audio track into a new file of the given format. */
const remuxWithTags = async (fixture: string, format: OutputFormat, tags: MetadataTags) => {
	using input = new Input({ source: new BufferSource(publicFile(fixture)), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	const decoderConfig = (await track.getDecoderConfig())!;

	const output = new Output({ format, target: new BufferTarget() });
	output.setMetadataTags(tags);
	const source = new EncodedAudioPacketSource((await track.getCodec())!);
	output.addAudioTrack(source);
	await output.start();

	let count = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		await source.add(packet, count === 0 ? { decoderConfig } : undefined);
		if (++count === 20) {
			break;
		}
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

const readTags = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	return { format: await input.getFormat(), tags: await input.getMetadataTags() };
};

describe('Metadata tags across formats', () => {
	test.each(cases)('$name keeps the fields it can store', async (formatCase) => {
		const writtenTags = formatCase.imageKinds === null ? { ...TAGS, images: [] } : TAGS;
		const bytes = await remuxWithTags(formatCase.fixture, formatCase.makeFormat(), writtenTags);
		const { format, tags } = await readTags(bytes);
		expect(format).toBe(formatCase.inputFormat);

		for (const field of ALL_FIELDS) {
			if (formatCase.fields.includes(field)) {
				expect(tags[field], field).toEqual(TAGS[field]);
			} else {
				expect(tags[field], field).toBeUndefined();
			}
		}

		// Every format stores the calendar date only
		expect(tags.date).toEqual(new Date('2021-04-23T00:00:00Z'));

		const images = tags.images ?? [];
		expect(images.map(image => image.kind)).toEqual(formatCase.imageKinds ?? []);
		for (const image of images) {
			const written = image.kind === 'coverFront' ? FRONT_COVER : BACK_COVER;
			expect(image.data).toEqual(written.data);
			expect(image.mimeType).toBe(written.mimeType);
			expect(image.description).toBe(formatCase.imageDescriptions ? written.description : undefined);
		}

		if (formatCase.creationTime) {
			expect(tags.creationTime).toEqual(TAGS.creationTime);
		}
	});

	test.each(cases)('$name writes nothing for empty tags', async (formatCase) => {
		const bytes = await remuxWithTags(formatCase.fixture, formatCase.makeFormat(), { creationTime: null });
		const { tags } = await readTags(bytes);

		for (const field of [...ALL_FIELDS, 'date', 'images'] as const) {
			expect(tags[field], field).toBeUndefined();
		}
	});

	test.each(cases.filter(x => x.fields.includes('trackNumber')))(
		'$name stores a track number without a total',
		async (formatCase) => {
			const bytes = await remuxWithTags(formatCase.fixture, formatCase.makeFormat(), {
				trackNumber: 7,
				discNumber: formatCase.fields.includes('discNumber') ? 1 : undefined,
			});
			const { tags } = await readTags(bytes);

			expect(tags.trackNumber).toBe(7);
			expect(tags.tracksTotal).toBeUndefined();
			if (formatCase.fields.includes('discNumber')) {
				expect(tags.discNumber).toBe(1);
				expect(tags.discsTotal).toBeUndefined();
			}
		},
	);

	test('INFO chunks keep Latin-1 titles', async () => {
		const bytes = await remuxWithTags('glitch-hop-is-dead.wav', new WavOutputFormat(), { title: 'Café olé' });
		const { tags } = await readTags(bytes);
		expect(tags.title).toBe('Café olé');
	});
});

describe('Reading tags written by FFmpeg', () => {
	// Each fixture is 0.1 s of a 440 Hz sine, generated with FFmpeg 7.0.2:
	// ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000 -t 0.1 -fflags +bitexact -metadata title=Title
	//   -metadata artist=Artist -metadata album=Album -metadata album_artist="Album Artist" -metadata genre=Genre
	//   -metadata comment=Comment -metadata track=3/12 -metadata disc=2/4 -metadata date=2021-04-23 <codec> <file>
	// with -c:a aac -b:a 32k (m4a), libopus -b:a 16k (mka, opus), flac (flac); the MP3 uses 44.1 kHz with
	// libmp3lame -b:a 32k, the WAVE 8 kHz with pcm_s16le.
	const common = {
		artist: 'Artist',
		album: 'Album',
		genre: 'Genre',
		trackNumber: 3,
		tracksTotal: 12,
		date: new Date('2021-04-23T00:00:00Z'),
	};
	const withDiscs = { ...common, albumArtist: 'Album Artist', discNumber: 2, discsTotal: 4 };

	test.each([
		['ffmpeg-tags.m4a', MP4, { ...withDiscs, title: 'Title', comment: 'Comment' }],
		// FFmpeg writes the title into the segment info, not into a tag
		['ffmpeg-tags.mka', MATROSKA, { ...withDiscs, comment: 'Comment' }],
		// FFmpeg maps its comment to the Vorbis DESCRIPTION field
		['ffmpeg-tags.opus', OGG, { ...withDiscs, title: 'Title', description: 'Comment' }],
		['ffmpeg-tags.flac', FLAC, { ...withDiscs, title: 'Title', description: 'Comment' }],
		// FFmpeg 7 writes its comment as a TXXX frame, which stays in raw.TXXX
		['ffmpeg-tags.mp3', MP3, { ...withDiscs, title: 'Title' }],
		['ffmpeg-tags.wav', WAVE, { ...common, title: 'Title', comment: 'Comment' }],
	] as [string, InputFormat, MetadataTags][])('%s', async (name, format, expected) => {
		using input = new Input({ source: new BufferSource(publicFile(name)), formats: ALL_FORMATS });
		expect(await input.getFormat()).toBe(format);

		const tags = await input.getMetadataTags();
		expect(tags).toMatchObject(expected);
	});
});

describe('Metadata tag validation', () => {
	const validate = (tags: MetadataTags) => () => {
		const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		output.setMetadataTags(tags);
	};

	test.each([
		[{ title: 1 }, 'tags.title, when provided, must be a string.'],
		[{ trackNumber: 0 }, 'tags.trackNumber, when provided, must be a positive integer.'],
		[{ trackNumber: 1.5 }, 'tags.trackNumber, when provided, must be a positive integer.'],
		[{ tracksTotal: -1 }, 'tags.tracksTotal, when provided, must be a positive integer.'],
		[{ discNumber: 0 }, 'tags.discNumber, when provided, must be a positive integer.'],
		[{ discsTotal: NaN }, 'tags.discsTotal, when provided, must be a positive integer.'],
		[{ beatsPerMinute: 0 }, 'tags.beatsPerMinute, when provided, must be a positive integer.'],
		[{ date: new Date(NaN) }, 'tags.date, when provided, must be a valid Date.'],
		[{ date: '2021-04-23' }, 'tags.date, when provided, must be a valid Date.'],
		[{ creationTime: new Date(NaN) }, 'tags.creationTime, when provided, must be a valid Date or null.'],
		[{ images: {} }, 'tags.images, when provided, must be an array.'],
		[{ images: [null] }, 'Each image in tags.images must be an object.'],
		[{ images: [{ data: [1], mimeType: 'image/png', kind: 'coverFront' }] }, 'image.data must be a Uint8Array'],
		[{ images: [{ data: PNG, kind: 'coverFront' }] }, 'Each image.mimeType must be a string.'],
		[{ images: [{ data: PNG, mimeType: 'image/png', kind: 'poster' }] }, 'Each image.kind must be'],
		[{ raw: 'x' }, 'tags.raw, when provided, must be an object.'],
		[{ raw: { a: 1 } }, 'Each value in tags.raw must be'],
		[{ raw: { a: ['x', 1] } }, 'Each value in tags.raw must be'],
		[{ raw: { a: { b: 1 } } }, 'Each value in tags.raw must be'],
	] as [Record<string, unknown>, string][])('rejects %o', (tags, message) => {
		expect(validate(tags as MetadataTags)).toThrow(message);
	});

	test('accepts every documented raw value type', () => {
		expect(validate({
			raw: {
				a: 'string',
				b: ['x', 'y'],
				c: new Uint8Array(1),
				d: [new Uint8Array(1), new Uint8Array(2)],
				e: new RichImageData(PNG, 'image/png'),
				f: new AttachedFile(new Uint8Array(1), 'font/ttf', 'f.ttf', 'A font'),
				g: { key: 'value' },
				h: null,
			},
			creationTime: null,
		})).not.toThrow();
	});

	test('RichImageData and AttachedFile validate their arguments', () => {
		expect(() => new RichImageData([1] as never, 'image/png')).toThrow(new TypeError('data must be a Uint8Array.'));
		expect(() => new RichImageData(PNG, 1 as never)).toThrow(new TypeError('mimeType must be a string.'));
		expect(() => new AttachedFile([1] as never)).toThrow(new TypeError('data must be a Uint8Array.'));
		expect(() => new AttachedFile(PNG, 1 as never)).toThrow(
			new TypeError('mimeType, when provided, must be a string.'),
		);
		expect(() => new AttachedFile(PNG, undefined, 1 as never)).toThrow(
			new TypeError('name, when provided, must be a string.'),
		);
		expect(() => new AttachedFile(PNG, undefined, undefined, 1 as never)).toThrow(
			new TypeError('description, when provided, must be a string.'),
		);
	});

	test('metadata can only be set before the output starts', async () => {
		const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(source);
		await output.start();
		expect(() => output.setMetadataTags({ title: 'Late' })).toThrow(
			'Cannot set metadata tags after output has been started or canceled.',
		);
		await output.cancel();
	});
});
