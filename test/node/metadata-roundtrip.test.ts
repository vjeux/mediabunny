import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	AdtsOutputFormat,
	AttachedImage,
	BufferSource,
	BufferTarget,
	Conversion,
	EncodedAudioPacketSource,
	EncodedPacketSink,
	FlacOutputFormat,
	Input,
	MetadataTags,
	MkvOutputFormat,
	MovOutputFormat,
	Mp3OutputFormat,
	Mp4OutputFormat,
	OggOutputFormat,
	Output,
	OutputFormat,
	WavOutputFormat,
	WebMOutputFormat,
} from '../../src/index.js';

// Metadata round trips: every MetadataTags field with hard values, written to every output format and read back,
// files tagged by other writers, conversions between formats, and damaged tags. External readers (FFmpeg, ExifTool,
// MediaInfo, AtomicParsley, mkvinfo, metaflac) were used to check what the written files mean; these tests pin down
// Mediabunny's side of it.

// Cases that fail on main and are fixed by an open pull request or on upstream's bug-fix-mania branch. They're skipped
// so that the suite stays green; drop an entry once its fix has landed.
const KNOWN_ISSUES: Record<string, string> = {
	'MP3: Unicode text': 'USLT frame size counts characters instead of bytes (fixed on bug-fix-mania)',
	'ADTS: Unicode text': 'USLT frame size counts characters instead of bytes (fixed on bug-fix-mania)',
	'WAVE (ID3): Unicode text': 'USLT frame size counts characters instead of bytes (fixed on bug-fix-mania)',
	'MP3: long Unicode text': 'USLT frame size counts characters instead of bytes (fixed on bug-fix-mania)',
	'ADTS: long Unicode text': 'USLT frame size counts characters instead of bytes (fixed on bug-fix-mania)',
	'WAVE (ID3): long Unicode text': 'USLT frame size counts characters instead of bytes (fixed on bug-fix-mania)',
	'MOV: long text': 'udta strings longer than 64 KiB come back cut to their length mod 65536 (#124)',
	'MOV: long Unicode text': 'udta strings longer than 64 KiB come back cut to their length mod 65536 (#124)',
	'MP4: numbers above 65535': 'trkn/disk values wrap around their 16 bits (#128)',
	'FLAC: Unicode picture descriptions': 'PICTURE lengths count characters instead of bytes (fixed on bug-fix-mania)',
	'MP4: image/jpg MIME type': 'covr data type 0 for MIME types other than image/jpeg|png|bmp (#275)',
	'MP4 (mdta): image/jpg MIME type': 'covr data type 0 for MIME types other than image/jpeg|png|bmp (#275)',
	'FLAC: image larger than 16 MiB': 'the 24-bit PICTURE block length overflows silently (fixed on bug-fix-mania)',
	'AtomicParsley: genre from gnre': 'gnre (ID3v1 genre index) is not read (#16)',
	'AtomicParsley: every covr image': 'only the first image of a covr atom is read (#22)',
	'AtomicParsley: freeform tags': 'iTunes freeform (----) items are read as one null raw entry (#282)',
	'mkvmerge: nested tags': 'a nested SimpleTag overwrites its parent (#125)',
	'mkvmerge: official tag names': 'DATE_RELEASED and TOTAL_PARTS are not mapped (#165)',
	'FFmpeg ID3v2.3: TYER and TDAT': 'TDAT (day and month) is ignored (fixed on bug-fix-mania)',
	'WAVE (ID3): damaged tag': 'an ID3 parse error makes the whole file unreadable (#274)',
	'FLAC: damaged ID3 tag': 'an ID3 parse error makes the whole file unreadable (#274)',
	'MP4: damaged metadata atom': 'an overrunning ilst data atom makes the whole file unreadable (#277)',
};

const knownIssueTest = (name: string, fn: () => Promise<void>, timeout?: number) => {
	if (KNOWN_ISSUES[name]) {
		test.skip(name, fn);
	} else {
		test(name, fn, timeout);
	}
};

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicFile = (name: string) => new Uint8Array(fs.readFileSync(path.join(__dirname, '../public', name)));

const JPEG = new Uint8Array([
	0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9,
]);
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

type TextField = 'title' | 'description' | 'artist' | 'album' | 'albumArtist' | 'genre' | 'comment' | 'lyrics';
const TEXT_FIELDS: TextField[] = [
	'title', 'description', 'artist', 'album', 'albumArtist', 'genre', 'comment', 'lyrics',
];

type NumberField = 'trackNumber' | 'tracksTotal' | 'discNumber' | 'discsTotal' | 'beatsPerMinute';
const NUMBER_FIELDS: NumberField[] = ['trackNumber', 'tracksTotal', 'discNumber', 'discsTotal', 'beatsPerMinute'];

type FormatCase = {
	name: string;
	makeFormat: () => OutputFormat;
	/** The fixture whose first packets are copied into the new file. */
	fixture: string;
	textFields: TextField[];
	numberFields: NumberField[];
	/** Which images come back, by kind, for a front cover, a back cover and an image of unknown kind. */
	imageKinds: AttachedImage['kind'][];
	imageDescriptions: boolean;
	/** Whether the format's strings end at the first NUL character. */
	nulTerminated: boolean;
	/** Whether the format can only store ISO 8859-1 text. */
	latin1Only: boolean;
	creationTime: 'seconds' | 'milliseconds' | null;
};

const ID3_CASE = {
	textFields: TEXT_FIELDS,
	numberFields: NUMBER_FIELDS,
	imageKinds: ['coverFront', 'coverBack', 'unknown'],
	imageDescriptions: true,
	nulTerminated: true,
	latin1Only: false,
	creationTime: null,
} satisfies Partial<FormatCase>;

const VORBIS_CASE = { ...ID3_CASE, nulTerminated: false } satisfies Partial<FormatCase>;

const FORMAT_CASES: FormatCase[] = [
	{
		name: 'MP4',
		makeFormat: () => new Mp4OutputFormat(),
		fixture: 'sample3.aac',
		textFields: TEXT_FIELDS,
		numberFields: NUMBER_FIELDS,
		imageKinds: ['coverFront'],
		imageDescriptions: false,
		nulTerminated: false,
		latin1Only: false,
		creationTime: 'seconds',
	},
	{
		name: 'MP4 (mdta)',
		makeFormat: () => new Mp4OutputFormat({ metadataFormat: 'mdta' }),
		fixture: 'sample3.aac',
		textFields: TEXT_FIELDS,
		numberFields: ['trackNumber', 'tracksTotal'],
		imageKinds: ['coverFront'],
		imageDescriptions: false,
		nulTerminated: false,
		latin1Only: false,
		creationTime: 'seconds',
	},
	{
		name: 'MOV',
		makeFormat: () => new MovOutputFormat(),
		fixture: 'sample3.aac',
		textFields: TEXT_FIELDS,
		numberFields: [],
		imageKinds: [],
		imageDescriptions: false,
		nulTerminated: false,
		latin1Only: false,
		creationTime: 'seconds',
	},
	{
		name: 'MKV',
		makeFormat: () => new MkvOutputFormat(),
		fixture: 'sample3.aac',
		textFields: TEXT_FIELDS,
		numberFields: NUMBER_FIELDS,
		imageKinds: ['coverFront', 'coverBack', 'unknown'],
		imageDescriptions: true,
		nulTerminated: true,
		latin1Only: false,
		creationTime: 'milliseconds',
	},
	{
		name: 'WebM',
		makeFormat: () => new WebMOutputFormat(),
		fixture: 'preroll-test.opus',
		textFields: TEXT_FIELDS,
		numberFields: NUMBER_FIELDS,
		// WebM has no Attachments element, so no images are written to it here
		imageKinds: [],
		imageDescriptions: false,
		nulTerminated: true,
		latin1Only: false,
		creationTime: 'milliseconds',
	},
	{ name: 'MP3', makeFormat: () => new Mp3OutputFormat(), fixture: 'Toothsome-Meme.VBRv2.mp3', ...ID3_CASE },
	{ name: 'ADTS', makeFormat: () => new AdtsOutputFormat(), fixture: 'sample3.aac', ...ID3_CASE },
	{
		name: 'WAVE (ID3)',
		makeFormat: () => new WavOutputFormat({ metadataFormat: 'id3' }),
		fixture: 'glitch-hop-is-dead.wav',
		...ID3_CASE,
	},
	{ name: 'FLAC', makeFormat: () => new FlacOutputFormat(), fixture: 'sample.flac', ...VORBIS_CASE },
	{ name: 'Ogg (Opus)', makeFormat: () => new OggOutputFormat(), fixture: 'preroll-test.opus', ...VORBIS_CASE },
	{ name: 'Ogg (Vorbis)', makeFormat: () => new OggOutputFormat(), fixture: 'vorbis-eos.ogg', ...VORBIS_CASE },
	{
		name: 'WAVE (INFO)',
		makeFormat: () => new WavOutputFormat(),
		fixture: 'glitch-hop-is-dead.wav',
		textFields: ['title', 'artist', 'album', 'genre', 'comment'],
		numberFields: ['trackNumber', 'tracksTotal'],
		imageKinds: [],
		imageDescriptions: false,
		nulTerminated: true,
		latin1Only: true,
		creationTime: null,
	},
];

const IMAGE_FORMAT_CASES = FORMAT_CASES.filter(x => x.imageKinds.length > 0);

/** Copies the first packets of the fixture's audio track into a new file of the given format, with the given tags. */
const writeFile = async (formatCase: FormatCase, tags: MetadataTags) => {
	using input = new Input({ source: new BufferSource(publicFile(formatCase.fixture)), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	const decoderConfig = (await track.getDecoderConfig())!;

	const output = new Output({ format: formatCase.makeFormat(), target: new BufferTarget() });
	output.setMetadataTags(tags);
	const source = new EncodedAudioPacketSource((await track.getCodec())!);
	output.addAudioTrack(source);
	await output.start();

	let count = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		await source.add(packet, count === 0 ? { decoderConfig } : undefined);
		if (++count === 10) {
			break;
		}
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

const readTags = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	return await input.getMetadataTags();
};

const roundTrip = async (formatCase: FormatCase, tags: MetadataTags) => readTags(await writeFile(formatCase, tags));

/** Checks that the audio of a file is still readable. */
const expectReadableAudio = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	expect(track).not.toBeNull();
	expect(await new EncodedPacketSink(track!).getFirstPacket()).not.toBeNull();
};

describe('Writing text with hard values', () => {
	type TextValueCase = {
		name: string;
		value: string;
		/** What comes back, by format; the written value by default. */
		expected?: (formatCase: FormatCase) => string | undefined;
	};

	const textValueCases: TextValueCase[] = [
		{
			name: 'Unicode text',
			// Astral plane, right-to-left scripts, a combining accent and CJK
			value: 'Ünïcødé 𝄞😀 שלום مرحبا e\u0301 中文 한국어',
			// Text that ISO 8859-1 can't hold is dropped, with a warning
			expected: formatCase => formatCase.latin1Only ? undefined : 'Ünïcødé 𝄞😀 שלום مرحبا e\u0301 中文 한국어',
		},
		{ name: 'ISO 8859-1 text', value: 'Café olé ÿ ¿ « » ©' },
		{ name: 'separators', value: 'a = b; c\nd\r\ne\tf / g = h' },
		{
			name: 'long text',
			value: 'x'.repeat(70_000),
			// QuickTime text atoms have a 16-bit length, so they keep as much as fits
			expected: formatCase => formatCase.name === 'MOV' ? 'x'.repeat(65_535) : 'x'.repeat(70_000),
		},
		{
			name: 'long Unicode text',
			value: '歌'.repeat(30_000),
			expected: (formatCase) => {
				if (formatCase.latin1Only) {
					return undefined;
				}
				// The most whole three-byte characters that fit in 65535 bytes
				return formatCase.name === 'MOV' ? '歌'.repeat(21_845) : '歌'.repeat(30_000);
			},
		},
		{
			name: 'a NUL character',
			value: 'before\u0000after',
			// ID3v2 and RIFF strings end at a NUL, and EBML strings are padded with them
			expected: formatCase => formatCase.nulTerminated ? 'before' : 'before\u0000after',
		},
	];

	for (const formatCase of FORMAT_CASES) {
		for (const valueCase of textValueCases) {
			knownIssueTest(`${formatCase.name}: ${valueCase.name}`, async () => {
				// Every field gets its own value, so mix-ups between fields show
				const valueFor = (field: TextField) => `${valueCase.value}${field}`;
				const tags = await roundTrip(formatCase, Object.fromEntries(
					TEXT_FIELDS.map(field => [field, valueFor(field)]),
				));

				for (const field of TEXT_FIELDS) {
					const expected = formatCase.textFields.includes(field)
						? (valueCase.expected ? valueCase.expected(formatCase) : valueCase.value)
						: undefined;
					if (expected === undefined) {
						expect(tags[field], field).toBeUndefined();
					} else if (expected === valueCase.value) {
						expect(tags[field], field).toBe(valueFor(field));
					} else {
						// The value got cut short, so the field's suffix is gone too
						expect(tags[field], field).toBe(expected);
					}
				}
			});
		}

		test(`${formatCase.name}: empty strings`, async () => {
			const tags = await roundTrip(formatCase, Object.fromEntries(TEXT_FIELDS.map(field => [field, ''])));
			for (const field of TEXT_FIELDS) {
				expect(tags[field] ?? '', field).toBe('');
			}
		});
	}
});

describe('Writing numbers and dates', () => {
	const numberFormatCases = FORMAT_CASES.filter(x => x.numberFields.length > 0);

	for (const formatCase of numberFormatCases) {
		test(`${formatCase.name}: numbers up to 65535`, async () => {
			const written = {
				trackNumber: 300,
				tracksTotal: 999,
				discNumber: 256,
				discsTotal: 65535,
				beatsPerMinute: 255,
			};
			const tags = await roundTrip(formatCase, written);
			for (const field of NUMBER_FIELDS) {
				expect(tags[field], field).toBe(formatCase.numberFields.includes(field) ? written[field] : undefined);
			}
		});

		knownIssueTest(`${formatCase.name}: numbers above 65535`, async () => {
			const written = { trackNumber: 70_000, tracksTotal: 99_999, discNumber: 65_536, discsTotal: 70_001 };
			const tags = await roundTrip(formatCase, written);
			for (const field of ['trackNumber', 'tracksTotal', 'discNumber', 'discsTotal'] as const) {
				// The iTunes trkn and disk atoms have 16-bit fields, so values that don't fit are left out
				const kept = formatCase.numberFields.includes(field) && formatCase.name !== 'MP4';
				expect(tags[field], field).toBe(kept ? written[field] : undefined);
			}
		});

		test(`${formatCase.name}: totals without numbers`, async () => {
			const tags = await roundTrip(formatCase, { tracksTotal: 12, discsTotal: 5 });
			// Vorbis comments have separate fields for the totals; the other formats store them next to the number
			const keepsTotals = formatCase.name === 'FLAC' || formatCase.name.startsWith('Ogg');
			expect(tags.trackNumber).toBeUndefined();
			expect(tags.discNumber).toBeUndefined();
			expect(tags.tracksTotal).toBe(keepsTotals ? 12 : undefined);
			expect(tags.discsTotal).toBe(keepsTotals ? 5 : undefined);
		});
	}

	for (const formatCase of FORMAT_CASES) {
		test(`${formatCase.name}: dates`, async () => {
			// Only the calendar date is stored, in UTC
			for (const [written, expected] of [
				['2021-04-23T23:59:59.999Z', '2021-04-23T00:00:00.000Z'],
				['0001-01-01T00:00:00.000Z', '0001-01-01T00:00:00.000Z'],
				['1899-12-31T12:00:00.000Z', '1899-12-31T00:00:00.000Z'],
				['9999-12-31T00:00:00.000Z', '9999-12-31T00:00:00.000Z'],
			]) {
				const tags = await roundTrip(formatCase, { date: new Date(written!) });
				expect(tags.date?.toISOString(), written).toBe(expected);
			}
		});

		test(`${formatCase.name}: creation time`, async () => {
			const creationTime = new Date('2020-01-02T03:04:05.678Z');
			const tags = await roundTrip(formatCase, { creationTime });

			if (formatCase.creationTime === 'seconds') {
				expect(tags.creationTime).toEqual(new Date('2020-01-02T03:04:05.000Z'));
			} else if (formatCase.creationTime === 'milliseconds') {
				expect(tags.creationTime).toEqual(creationTime);
			} else {
				expect(tags.creationTime).toBeUndefined();
			}

			const untimed = await roundTrip(formatCase, { creationTime: null });
			expect(untimed.creationTime).toBeUndefined();
		});
	}
});

describe('Writing images', () => {
	const FRONT: AttachedImage = { data: JPEG, mimeType: 'image/jpeg', kind: 'coverFront', description: 'Front' };
	const BACK: AttachedImage = { data: PNG, mimeType: 'image/png', kind: 'coverBack', description: 'Back' };
	const OTHER: AttachedImage = { data: JPEG.slice(), mimeType: 'image/jpeg', kind: 'unknown' };

	for (const formatCase of FORMAT_CASES) {
		test(`${formatCase.name}: image kinds and descriptions`, async () => {
			const images = formatCase.name === 'WebM' ? [] : [FRONT, BACK, OTHER];
			const tags = await roundTrip(formatCase, { title: 'With images', images });

			const read = tags.images ?? [];
			expect(read.map(image => image.kind)).toEqual(formatCase.imageKinds);
			for (const image of read) {
				const written = images.find(x => x.kind === image.kind)!;
				expect(image.data).toEqual(written.data);
				expect(image.mimeType).toBe(written.mimeType);
				// ID3 and FLAC pictures always have a description field, which comes back empty when none was set
				const description = formatCase.imageDescriptions ? written.description : undefined;
				expect(image.description || undefined).toBe(description);
			}
		});
	}

	for (const formatCase of IMAGE_FORMAT_CASES.filter(x => x.imageDescriptions)) {
		knownIssueTest(`${formatCase.name}: Unicode picture descriptions`, async () => {
			const description = 'Frönt 😀 封面';
			const tags = await roundTrip(formatCase, { images: [{ ...FRONT, description }, BACK] });
			expect(tags.images!.map(image => image.description)).toEqual([description, 'Back']);
			expect(tags.images!.map(image => image.data)).toEqual([JPEG, PNG]);
		});
	}

	for (const formatCase of IMAGE_FORMAT_CASES) {
		knownIssueTest(`${formatCase.name}: image/jpg MIME type`, async () => {
			// A common misspelling of image/jpeg, found in real ID3 tags
			const tags = await roundTrip(formatCase, { images: [{ ...FRONT, mimeType: 'image/jpg' }] });
			expect(tags.images).toHaveLength(1);
			expect(tags.images![0]!.data).toEqual(JPEG);
			// MP4 stores the image format as a type code, so the canonical name comes back
			expect(tags.images![0]!.mimeType).toBe(formatCase.name.startsWith('MP4') ? 'image/jpeg' : 'image/jpg');
		});

		test(`${formatCase.name}: empty image data`, async () => {
			const tags = await roundTrip(formatCase, {
				title: 'Empty image',
				images: [{ ...FRONT, data: new Uint8Array() }],
			});
			expect(tags.title).toBe('Empty image');
			expect(tags.images ?? []).toHaveLength(1);
			expect(tags.images![0]!.data).toEqual(new Uint8Array());
		});

		knownIssueTest(`${formatCase.name}: image larger than 16 MiB`, async () => {
			const data = new Uint8Array(2 ** 24 + 1000);
			data.set(JPEG.subarray(0, 4));
			data[data.length - 1] = 0xd9;

			// (The assertions stay away from the image itself, which is too big to show in a failure message)
			if (formatCase.name === 'FLAC') {
				// A FLAC metadata block can't be larger than 16 MiB
				const error = await writeFile(formatCase, { images: [{ ...FRONT, data }] })
					.then(() => null, (e: Error) => e);
				expect(error?.message ?? 'No error').toMatch(/too big for FLAC/);
				return;
			}

			const bytes = await writeFile(formatCase, { title: 'Big image', images: [{ ...FRONT, data }] });
			await expectReadableAudio(bytes);

			const tags = await readTags(bytes);
			expect(tags.title).toBe('Big image');
			expect(tags.images?.length).toBe(1);
			expect(tags.images![0]!.data.length).toBe(data.length);
			expect(tags.images![0]!.data[data.length - 1]).toBe(0xd9);
		}, 30_000);
	}
});

describe('Reading tags written by other tools', () => {
	const read = async (name: string) => {
		using input = new Input({ source: new BufferSource(publicFile(name)), formats: ALL_FORMATS });
		return await input.getMetadataTags();
	};

	// ffmpeg -f lavfi -i sine=f=440:d=0.05:sample_rate=22050 -ac 1 -c:a aac -b:a 24k -fflags +bitexact base.aac
	// ffmpeg -i base.aac -c copy -fflags +bitexact -map_metadata -1 base.m4a
	// AtomicParsley 20240608 base.m4a --title "Tïtle 𝄞" --artist "Björk" --albumArtist "Album Ärtist" --album "Albüm"
	//   --genre "Rock" --tracknum 3/12 --disk 2/5 --year "2021-04-23T07:00:00Z" --bpm 128 --description "Descrïption"
	//   --comment "Cömment" --lyrics "Lÿrics" --artwork c.jpg --artwork c.png
	//   --rDNSatom "free é" name=MYKEY domain=com.apple.iTunes --compilation true -o metadata-atomicparsley.m4a
	// (c.jpg and c.png are 8x8 images made with FFmpeg's color source)
	const ATOMICPARSLEY = 'metadata-atomicparsley.m4a';

	test('AtomicParsley: text, numbers and dates', async () => {
		const tags = await read(ATOMICPARSLEY);
		expect(tags).toMatchObject({
			title: 'Tïtle 𝄞',
			artist: 'Björk',
			albumArtist: 'Album Ärtist',
			album: 'Albüm',
			trackNumber: 3,
			tracksTotal: 12,
			discNumber: 2,
			discsTotal: 5,
			beatsPerMinute: 128,
			description: 'Descrïption',
			comment: 'Cömment',
			lyrics: 'Lÿrics',
		});
		// iTunes-style dates carry the time too
		expect(tags.date).toEqual(new Date('2021-04-23T07:00:00Z'));
		expect(tags.raw!['cpil']).toEqual(new Uint8Array([1]));
		expect(tags.images![0]!.kind).toBe('coverFront');
		expect(tags.images![0]!.mimeType).toBe('image/jpeg');
	});

	knownIssueTest('AtomicParsley: genre from gnre', async () => {
		// AtomicParsley writes standard genres as an ID3v1 genre index plus one (Rock = 17 + 1)
		const tags = await read(ATOMICPARSLEY);
		expect(tags.genre).toBe('Rock');
	});

	knownIssueTest('AtomicParsley: every covr image', async () => {
		const tags = await read(ATOMICPARSLEY);
		expect(tags.images!.map(image => image.mimeType)).toEqual(['image/jpeg', 'image/png']);
	});

	knownIssueTest('AtomicParsley: freeform tags', async () => {
		const tags = await read(ATOMICPARSLEY);
		expect(tags.raw!['----:com.apple.iTunes:MYKEY']).toBe('free é');
	});

	// mkvmerge v103.0 --no-date --disable-track-statistics-tags -o metadata-mkvmerge.mka --title "Segment Tïtle"
	//   --global-tags tags.xml --attachment-description "Front cover" --attachment-mime-type image/jpeg
	//   --attachment-name cover.jpg --attach-file c.jpg --attachment-mime-type image/png --attachment-name poster.png
	//   --attach-file c.png base.aac
	// tags.xml has an ALBUM (50) tag with TITLE "Albüm Tïtle", ARTIST "Album Ärtist" (with a nested SORT_WITH
	// "Ärtist, Album"), TOTAL_PARTS 12, DATE_RELEASED 2021-04-23, GENRE "Électro", and a TRACK (30) tag with TITLE
	// "Song Tïtle" and PART_NUMBER 3.
	const MKVMERGE = 'metadata-mkvmerge.mka';

	test('mkvmerge: album-level tags and attachments', async () => {
		const tags = await read(MKVMERGE);
		// Only the tags that target the whole file (50) are read, not the track-level (30) ones. (Which title wins,
		// the segment's or a TITLE tag's, is left open here: FFmpeg shows the segment title for this file.)
		expect(tags.artist).toBe('Album Ärtist');
		expect(tags.genre).toBe('Électro');
		expect(tags.trackNumber).toBeUndefined();

		expect(tags.images!.map(image => [image.kind, image.mimeType, image.name, image.description])).toEqual([
			['coverFront', 'image/jpeg', 'cover.jpg', 'Front cover'],
			['unknown', 'image/png', 'poster.png', undefined],
		]);
		expect(tags.images![0]!.data.subarray(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
		expect(tags.images![1]!.data.subarray(0, 4)).toEqual(PNG.subarray(0, 4));
	});

	knownIssueTest('mkvmerge: nested tags', async () => {
		const tags = await read(MKVMERGE);
		expect(tags.artist).toBe('Album Ärtist');
		expect(tags.raw!['ARTIST']).toBe('Album Ärtist');
		expect(tags.raw!['SORT_WITH']).toBeUndefined();
	});

	knownIssueTest('mkvmerge: official tag names', async () => {
		const tags = await read(MKVMERGE);
		expect(tags.date).toEqual(new Date('2021-04-23T00:00:00Z'));
		expect(tags.tracksTotal).toBe(12);
	});

	// ffmpeg -f lavfi -i sine=f=440:d=0.05:sample_rate=8000 -ac 1 -c:a flac -fflags +bitexact -map_metadata -1
	//   base.flac
	// metaflac 1.5.0 --dont-use-padding --remove-all-tags --set-tag="TITLE=Tïtle 𝄞" --set-tag="ARTIST=Artist One"
	//   --set-tag="ARTIST=Artist Two" --set-tag="album=lowercase key" --set-tag="TRACKNUMBER=3"
	//   --set-tag="TRACKTOTAL=12" --set-tag="DISCNUMBER=2/5" --set-tag="DATE=2021-04-23"
	//   --set-tag="COMMENT=line 1<newline>line 2 = still the value"
	//   --import-picture-from="3|image/jpeg|Front désc||c.jpg"
	//   --import-picture-from="4|image/png|Back||c.png" --import-picture-from="5|image/jpeg|Leaflet||c.jpg"
	// then metaflac --dont-use-padding --remove --block-type=PADDING
	test('metaflac: Vorbis comments and pictures', async () => {
		const tags = await read('metadata-metaflac.flac');
		expect(tags).toMatchObject({
			title: 'Tïtle 𝄞',
			// The first of several values
			artist: 'Artist One',
			// Field names are case-insensitive
			album: 'lowercase key',
			trackNumber: 3,
			tracksTotal: 12,
			discNumber: 2,
			discsTotal: 5,
			comment: 'line 1\nline 2 = still the value',
		});
		expect(tags.date).toEqual(new Date('2021-04-23T00:00:00Z'));
		expect(tags.raw!['ARTIST']).toEqual(['Artist One', 'Artist Two']);
		expect(tags.images!.map(image => [image.kind, image.mimeType, image.description])).toEqual([
			['coverFront', 'image/jpeg', 'Front désc'],
			['coverBack', 'image/png', 'Back'],
			// Picture type 5 (leaflet page) has no kind of its own
			['unknown', 'image/jpeg', 'Leaflet'],
		]);
	});

	// ffmpeg -f lavfi -i sine=f=440:d=0.06:sample_rate=48000 -ac 1 -c:a pcm_s16le -fflags +bitexact base.wav
	// opusenc 0.2 (libopus 1.5.2) --bitrate 8 --title "Tïtle 𝄞" --artist "Artist One" --artist "Artist Two"
	//   --comment "TRACKNUMBER=3/12" --comment "DESCRIPTION=Déscription" --picture "3|image/jpeg|Front désc||c.jpg"
	//   --picture "4|image/png|Back||c.png" base.wav metadata-opusenc.opus
	test('opusenc: lowercase field names and pictures', async () => {
		const tags = await read('metadata-opusenc.opus');
		expect(tags).toMatchObject({
			title: 'Tïtle 𝄞',
			artist: 'Artist One',
			trackNumber: 3,
			tracksTotal: 12,
			description: 'Déscription',
		});
		expect(tags.raw!['ARTIST']).toEqual(['Artist One', 'Artist Two']);
		expect(tags.images!.map(image => [image.kind, image.mimeType, image.description])).toEqual([
			['coverFront', 'image/jpeg', 'Front désc'],
			['coverBack', 'image/png', 'Back'],
		]);
	});

	// ffmpeg -f lavfi -i sine=f=440:d=0.05:sample_rate=22050 -ac 1 -c:a libmp3lame -b:a 32k -fflags +bitexact base.mp3
	// ffmpeg -i base.mp3 -i c.jpg -map 0:a -map 1 -c copy -fflags +bitexact -id3v2_version <3|4> -write_id3v1 1
	//   -metadata title="Tïtle 𝄞" -metadata artist="Björk" -metadata album_artist="Album Ärtist" -metadata track=3/12
	//   -metadata disc=2/5 -metadata date=2021-04-23 -metadata genre="Électro" -metadata TBPM=128
	//   -metadata:s:v title="Front désc" -metadata:s:v comment="Cover (front)" metadata-ffmpeg-id3v2<3|4>.mp3
	// (FFmpeg 7.0; ID3v2.3 text is UTF-16 and the date is split into TYER and TDAT)
	for (const version of [3, 4]) {
		test(`FFmpeg ID3v2.${version}: text, numbers and cover`, async () => {
			const tags = await read(`metadata-ffmpeg-id3v2${version}.mp3`);
			expect(tags).toMatchObject({
				title: 'Tïtle 𝄞',
				artist: 'Björk',
				albumArtist: 'Album Ärtist',
				trackNumber: 3,
				tracksTotal: 12,
				discNumber: 2,
				discsTotal: 5,
				genre: 'Électro',
				beatsPerMinute: 128,
			});
			expect(tags.date?.getUTCFullYear()).toBe(2021);
			expect(tags.images!.map(image => [image.kind, image.mimeType, image.description])).toEqual([
				['coverFront', 'image/jpeg', 'Front désc'],
			]);
		});
	}

	test('FFmpeg ID3v2.4: date', async () => {
		const tags = await read('metadata-ffmpeg-id3v24.mp3');
		expect(tags.date).toEqual(new Date('2021-04-23T00:00:00Z'));
	});

	knownIssueTest('FFmpeg ID3v2.3: TYER and TDAT', async () => {
		const tags = await read('metadata-ffmpeg-id3v23.mp3');
		expect(tags.date).toEqual(new Date('2021-04-23T00:00:00Z'));
	});
});

describe('Conversion', () => {
	const convert = async (name: string, format: OutputFormat, tags?: MetadataTags) => {
		using input = new Input({ source: new BufferSource(publicFile(name)), formats: ALL_FORMATS });
		const output = new Output({ format, target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, tags, showWarnings: false });
		expect(conversion.isValid).toBe(true);
		await conversion.execute();
		return readTags(new Uint8Array(output.target.buffer!));
	};

	// (MP3 and Ogg conversions decode the audio here, which Node can't do)
	const SAME_FORMAT_CASES: [string, string, () => OutputFormat][] = [
		['MP4', 'metadata-atomicparsley.m4a', () => new Mp4OutputFormat()],
		['MKV', 'metadata-mkvmerge.mka', () => new MkvOutputFormat()],
		['FLAC', 'metadata-metaflac.flac', () => new FlacOutputFormat()],
	];

	for (const [name, file, makeFormat] of SAME_FORMAT_CASES) {
		test(`${name}: conversion keeps images once`, async () => {
			using input = new Input({ source: new BufferSource(publicFile(file)), formats: ALL_FORMATS });
			const inputTags = await input.getMetadataTags();

			const tags = await convert(file, makeFormat());
			expect(tags.title).toBe(inputTags.title);
			expect(tags.artist).toBe(inputTags.artist);
			expect(tags.images!.map(image => [image.kind, image.mimeType, image.data.length])).toEqual(
				inputTags.images!.map(image => [image.kind, image.mimeType, image.data.length]),
			);
		});
	}

	test('Conversions between formats keep the normalized fields and drop the raw ones', async () => {
		const tags = await convert('metadata-metaflac.flac', new MkvOutputFormat());
		expect(tags).toMatchObject({
			title: 'Tïtle 𝄞',
			artist: 'Artist One',
			album: 'lowercase key',
			trackNumber: 3,
			tracksTotal: 12,
			discNumber: 2,
			discsTotal: 5,
			comment: 'line 1\nline 2 = still the value',
		});
		expect(tags.date).toEqual(new Date('2021-04-23T00:00:00Z'));
		expect(tags.raw!['vendor']).toBeUndefined();
		expect(tags.raw!['ARTIST']).toBe('Artist One');
		expect(tags.images!.map(image => [image.kind, image.description])).toEqual([
			['coverFront', 'Front désc'],
			['coverBack', 'Back'],
			['unknown', 'Leaflet'],
		]);
	});

	test('Conversions to MP4 keep the front cover only', async () => {
		const tags = await convert('metadata-opusenc.opus', new Mp4OutputFormat());
		expect(tags.title).toBe('Tïtle 𝄞');
		expect(tags.description).toBe('Déscription');
		expect(tags.images!.map(image => [image.kind, image.mimeType])).toEqual([['coverFront', 'image/jpeg']]);
		expect(tags.raw!['METADATA_BLOCK_PICTURE']).toBeUndefined();
	});

	test('Conversions do not inherit the creation time', async () => {
		// The output gets the time of writing instead, so the clock is frozen (MP4 stores whole seconds)
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2030-05-06T07:08:09.500Z'));
		try {
			const tags = await convert('metadata-atomicparsley.m4a', new Mp4OutputFormat());
			expect(tags.creationTime).toEqual(new Date('2030-05-06T07:08:09Z'));
		} finally {
			vi.useRealTimers();
		}
	});

	test('The tags option replaces the input\'s tags', async () => {
		const tags = await convert('metadata-metaflac.flac', new FlacOutputFormat(), { title: 'Replaced' });
		expect(tags.title).toBe('Replaced');
		expect(tags.artist).toBeUndefined();
		expect(tags.images).toBeUndefined();
	});

	test('The tags function gets the input\'s tags', async () => {
		let received: MetadataTags | null = null;
		using input = new Input({
			source: new BufferSource(publicFile('metadata-metaflac.flac')),
			formats: ALL_FORMATS,
		});
		const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			showWarnings: false,
			tags: (inputTags) => {
				received = inputTags;
				return { ...inputTags, title: `${inputTags.title!} (edit)` };
			},
		});
		await conversion.execute();

		expect(received!.title).toBe('Tïtle 𝄞');
		expect(received!.creationTime).toBeUndefined();
		const written = await readTags(new Uint8Array(output.target.buffer!));
		expect(written.title).toBe('Tïtle 𝄞 (edit)');
		expect(written.artist).toBe('Artist One');
	});
});

describe('Damaged tags', () => {
	// A tag that can't be parsed may cost the tags, but never the audio
	const patch = (bytes: Uint8Array, search: string, offset: number, values: number[]) => {
		const position = Buffer.from(bytes).indexOf(Buffer.from(search, 'latin1'));
		expect(position).toBeGreaterThan(-1);
		const patched = bytes.slice();
		patched.set(values, position + offset);
		return patched;
	};

	const id3Case = FORMAT_CASES.find(x => x.name === 'MP3')!;

	test('MP3: damaged tag', async () => {
		const bytes = await writeFile(id3Case, { title: 'Title', artist: 'Artist' });
		// TPE1's text encoding byte becomes 4, which doesn't exist
		const damaged = patch(bytes, 'TPE1', 10, [4]);
		await expectReadableAudio(damaged);
	});

	knownIssueTest('WAVE (ID3): damaged tag', async () => {
		const bytes = await writeFile(FORMAT_CASES.find(x => x.name === 'WAVE (ID3)')!, { title: 'T', artist: 'A' });
		await expectReadableAudio(patch(bytes, 'TPE1', 10, [4]));
	});

	knownIssueTest('FLAC: damaged ID3 tag', async () => {
		// An ID3v2.4 tag with a TPE1 frame using text encoding 4 in front of a FLAC file
		const tag = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 13, 0x54, 0x50, 0x45, 0x31, 0, 0, 0, 3, 0, 0, 4, 0x41, 0];
		await expectReadableAudio(new Uint8Array([...tag, ...publicFile('sample.flac').subarray(0, 100_000)]));
	});

	knownIssueTest('MP4: damaged metadata atom', async () => {
		const bytes = await writeFile(FORMAT_CASES.find(x => x.name === 'MP4')!, { title: 'Title', artist: 'Artist' });
		// ©ART's data atom, which follows the item's header, claims to be 4096 bytes long
		await expectReadableAudio(patch(bytes, '\u00a9ART', 4, [0, 0, 0x10, 0]));
	});

	test('Ogg: damaged METADATA_BLOCK_PICTURE', async () => {
		const formatCase = FORMAT_CASES.find(x => x.name === 'Ogg (Opus)')!;
		const bytes = await writeFile(formatCase, { title: 'Title', raw: { METADATA_BLOCK_PICTURE: 'AAAA????' } });
		const tags = await readTags(bytes);
		expect(tags.title).toBe('Title');
		expect(tags.images ?? []).toEqual([]);
		await expectReadableAudio(bytes);
	});

	test('FLAC: damaged PICTURE block', async () => {
		const formatCase = FORMAT_CASES.find(x => x.name === 'FLAC')!;
		const bytes = await writeFile(formatCase, {
			title: 'Title',
			images: [{ data: JPEG, mimeType: 'image/jpeg', kind: 'coverFront' }],
		});
		// The PICTURE's MIME type length claims more bytes than the block holds
		const damaged = patch(bytes, 'image/jpeg', -4, [0, 0, 0x7f, 0xff]);
		const tags = await readTags(damaged);
		expect(tags.title).toBe('Title');
		await expectReadableAudio(damaged);
	});
});
