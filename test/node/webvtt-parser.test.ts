import { describe, expect, test } from 'vitest';
import {
	SubtitleCue,
	SubtitleMetadata,
	SubtitleParser,
	formatSubtitleTimestamp,
	inlineTimestampRegex,
	parseSubtitleTimestamp,
} from '../../src/subtitles.js';
import {
	BufferTarget,
	MkvOutputFormat,
	Mp4OutputFormat,
	Output,
	OutputFormat,
	TextSubtitleSource,
	WebMOutputFormat,
} from '../../src/index.js';

const parseAll = (chunks: string[]) => {
	const cues: SubtitleCue[] = [];
	const metadata: SubtitleMetadata[] = [];
	const parser = new SubtitleParser({
		codec: 'webvtt',
		output: (cue, meta) => {
			cues.push(cue);
			metadata.push(meta);
		},
	});
	for (const chunk of chunks) {
		parser.parse(chunk);
	}
	return { cues, metadata };
};

const SAMPLE = `WEBVTT - A title
Kind: captions

STYLE
::cue { color: yellow }

intro
00:00.000 --> 00:01.500 align:start line:0
First line
second line

NOTE a comment between cues

01:02:03.004 --> 01:02:05.000
<v Speaker>Hello <00:01:02:04.000>there</v>

01:02:10.000 --> 01:02:11.000
Last
`;

describe('WebVTT parsing', () => {
	test('parses timings with and without hours, identifiers, settings and multi-line text', () => {
		const { cues } = parseAll([SAMPLE]);
		expect(cues).toHaveLength(3);

		expect(cues[0]).toMatchObject({
			timestamp: 0,
			duration: 1.5,
			identifier: 'intro',
			settings: 'align:start line:0',
			text: 'First line\nsecond line',
		});
		expect(cues[1]!.timestamp).toBeCloseTo(3723.004, 9);
		expect(cues[1]!.duration).toBeCloseTo(1.996, 9);
		expect(cues[1]!.identifier).toBeUndefined();
		expect(cues[1]!.text).toBe('<v Speaker>Hello <00:01:02:04.000>there</v>');
		expect(cues[2]).toMatchObject({ timestamp: 3730, duration: 1, text: 'Last' });
	});

	test('hands the header and style blocks to the first cue only, and NOTE blocks to the next cue', () => {
		const { cues, metadata } = parseAll([SAMPLE]);
		expect(metadata[0]!.config!.description).toBe(
			'WEBVTT - A title\nKind: captions\n\nSTYLE\n::cue { color: yellow }',
		);
		expect(metadata[1]!.config).toBeUndefined();
		expect(metadata[2]!.config).toBeUndefined();
		expect(cues[1]!.notes).toContain('NOTE a comment between cues');
		expect(cues[2]!.notes).toBe('');
	});

	test.each([
		['CRLF', '\r\n'],
		['CR', '\r'],
	])('treats %s line endings like LF', (_, newline) => {
		const { cues } = parseAll([SAMPLE.replaceAll('\n', newline)]);
		expect(cues).toEqual(parseAll([SAMPLE]).cues);
	});

	test('accepts the file in chunks that hold whole cues', () => {
		const firstCueEnd = SAMPLE.indexOf('NOTE');
		const lastCueStart = SAMPLE.lastIndexOf('01:02:10.000');
		const chunks = [
			SAMPLE.slice(0, firstCueEnd),
			SAMPLE.slice(firstCueEnd, lastCueStart),
			SAMPLE.slice(lastCueStart),
		];
		expect(parseAll(chunks).cues).toEqual(parseAll([SAMPLE]).cues);
	});

	test('rejects text that does not start with the WEBVTT header', () => {
		expect(() => parseAll(['00:00.000 --> 00:01.000\nHi\n'])).toThrow('WebVTT preamble incorrect.');
		expect(() => parseAll(['WEBVT\n\n00:00.000 --> 00:01.000\nHi\n'])).toThrow('WebVTT preamble incorrect.');
	});

	test('a file with a header only has no cues', () => {
		expect(parseAll(['WEBVTT\n\n']).cues).toEqual([]);
	});
});

describe('WebVTT timestamps', () => {
	test.each([
		['00:00.000', 0],
		['00:00.999', 999],
		['59:59.999', 3_599_999],
		['00:00:00.001', 1],
		['01:00:00.000', 3_600_000],
		['99:59:59.999', 359_999_999],
	])('parses %s as %i ms and formats it back', (text, milliseconds) => {
		expect(parseSubtitleTimestamp(text)).toBe(milliseconds);
		const formatted = formatSubtitleTimestamp(milliseconds);
		expect(parseSubtitleTimestamp(formatted)).toBe(milliseconds);
		expect(formatted).toMatch(/^\d{2,}:\d{2}:\d{2}\.\d{3}$/);
	});

	test('formats with zero padding and hours beyond 99', () => {
		expect(formatSubtitleTimestamp(0)).toBe('00:00:00.000');
		expect(formatSubtitleTimestamp(61_001)).toBe('00:01:01.001');
		expect(formatSubtitleTimestamp(100 * 3_600_000 + 5)).toBe('100:00:00.005');
	});

	test('finds inline timestamps in cue text', () => {
		const text = 'a <00:01.500> b <01:00:02.250> c <not a timestamp>';
		inlineTimestampRegex.lastIndex = 0;
		const matches = [...text.matchAll(inlineTimestampRegex)].map(match => match[0]);
		expect(matches).toEqual(['<00:01.500>', '<01:00:02.250>']);
	});
});

describe('WebVTT muxing', () => {
	const muxCues = async (format: OutputFormat, text: string) => {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new TextSubtitleSource('webvtt');
		output.addSubtitleTrack(source);
		await output.start();
		await source.add(text);
		source.close();
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	const contains = (haystack: Uint8Array, needle: string) => {
		return Buffer.from(haystack).includes(Buffer.from(needle));
	};

	test.each([
		['MP4', () => new Mp4OutputFormat()],
		['MKV', () => new MkvOutputFormat()],
		['WebM', () => new WebMOutputFormat()],
	] as [string, () => OutputFormat][])('%s carries the cue payloads, identifiers, settings and header', async (
		_,
		format,
	) => {
		const bytes = await muxCues(format(), SAMPLE);
		for (const needle of ['First line\nsecond line', 'Last', 'intro', 'align:start line:0', 'Kind: captions']) {
			expect(contains(bytes, needle), needle).toBe(true);
		}
	});

	test('MP4 stores WebVTT as wvtt samples with vttC, vttc and payl boxes', async () => {
		const bytes = await muxCues(new Mp4OutputFormat(), SAMPLE);
		for (const needle of ['wvtt', 'vttC', 'vttc', 'payl', 'iden', 'sttg']) {
			expect(contains(bytes, needle), needle).toBe(true);
		}
	});

	test('Matroska stores WebVTT under the S_TEXT/WEBVTT codec ID', async () => {
		expect(contains(await muxCues(new MkvOutputFormat(), SAMPLE), 'S_TEXT/WEBVTT')).toBe(true);
	});
});
