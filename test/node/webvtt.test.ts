import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { TextSubtitleSource } from '../../src/media-source.js';
import { SubtitleCue, SubtitleParser } from '../../src/subtitles.js';

test('ISOBMFF muxing', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);

	await output.start();

	await source.add(`WEBVTT

00:00.000 --> 00:00.900
Hildy!

00:01.000 --> 00:01.400
How are you?

00:01.500 --> 00:02.900
Tell me, is the lord of the universe in?
`);

	await output.finalize();
});

test('WebVTT cue timings may omit the spaces around the arrow', () => {
	const cues: SubtitleCue[] = [];
	let config: string | undefined;
	const parser = new SubtitleParser({
		codec: 'webvtt',
		output: (cue, meta) => {
			cues.push(cue);
			config ??= meta.config?.description;
		},
	});
	parser.parse('WEBVTT\n\n00:00.000-->00:01.000\nHi\n\n00:02.000 --> 00:03.000\nThere\n');

	expect(cues.map(cue => [cue.timestamp, cue.duration, cue.text])).toEqual([[0, 1, 'Hi'], [2, 1, 'There']]);
	expect(config).toBe('WEBVTT');
});

test('A WebVTT timing line ends the previous cue even without a blank line before it', () => {
	const cues: SubtitleCue[] = [];
	const parser = new SubtitleParser({ codec: 'webvtt', output: cue => cues.push(cue) });
	parser.parse('WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n00:02.000 --> 00:03.000\nThere\n');

	expect(cues.map(cue => [cue.timestamp, cue.duration, cue.text])).toEqual([[0, 1, 'Hi'], [2, 1, 'There']]);
});

test('A WebVTT cue whose timing line ends the text has empty text', () => {
	const parse = (...chunks: string[]) => {
		const cues: SubtitleCue[] = [];
		const parser = new SubtitleParser({
			codec: 'webvtt',
			output: (cue) => {
				cues.push(cue);
				if (cues.length > 10) {
					throw new Error('The parser keeps emitting cues.'); // Instead of hanging the test
				}
			},
		});
		chunks.forEach(chunk => parser.parse(chunk));
		return cues.map(cue => [cue.timestamp, cue.duration, cue.text, cue.settings]);
	};

	expect(parse('WEBVTT\n\n00:00.000 --> 00:01.000')).toEqual([[0, 1, '', '']]);
	expect(parse('WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n00:02.000 --> 00:03.000 align:start')).toEqual([
		[0, 1, 'Hi', ''],
		[2, 1, '', 'align:start'],
	]);
	expect(parse('WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n\n00:01.000 --> 00:02.000')).toEqual([
		[0, 1, 'Hi', ''],
		[1, 1, '', ''],
	]);
	// A chunk passed to TextSubtitleSource.add may end right after a timing line too
	expect(parse('WEBVTT\n\n', '00:00.000 --> 00:01.000')).toEqual([[0, 1, '', '']]);
});

test('Matroska muxing', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);

	await output.start();

	await source.add(`WEBVTT

00:00.000 --> 00:00.900
Hildy!

00:01.000 --> 00:01.400
How are you?

00:01.500 --> 00:02.900
Tell me, is the lord of the universe in?
`);

	await output.finalize();
});

test('A WebVTT file can consist of just its header', () => {
	const cues: SubtitleCue[] = [];
	const configs: (string | undefined)[] = [];
	const parse = (text: string) => {
		const parser = new SubtitleParser({
			codec: 'webvtt',
			output: (cue, meta) => {
				cues.push(cue);
				configs.push(meta.config?.description);
			},
		});
		parser.parse(text);
		return parser;
	};

	expect(() => parse('WEBVTT')).not.toThrow();
	expect(() => parse('WEBVTT - Title\nKind: captions\n')).not.toThrow();
	expect(cues).toEqual([]);

	// Such a header can be the first chunk, with the cues following in later chunks
	parse('WEBVTT\n').parse('\n00:00.000 --> 00:01.000\nHi\n');
	expect(cues.map(cue => cue.text)).toEqual(['Hi']);
	expect(configs).toEqual(['WEBVTT']);
});

test('WebVTT NOTE blocks added in their own chunk stay with the next cue', () => {
	const parse = (chunks: string[]) => {
		const cues: SubtitleCue[] = [];
		const parser = new SubtitleParser({ codec: 'webvtt', output: cue => cues.push(cue) });
		chunks.forEach(chunk => parser.parse(chunk));
		return cues;
	};

	const chunks = [
		'WEBVTT\n\n',
		'00:00.000 --> 00:01.000\nHi\n\n',
		'NOTE Next speaker\n\n',
		'00:02.000 --> 00:03.000\nThere\n\n',
	];
	expect(parse(chunks)).toEqual(parse([chunks.join('')]));
	expect(parse(chunks)[1]!.notes).toBe('NOTE Next speaker\n\n');
});
