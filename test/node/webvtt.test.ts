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

test('WebVTT lines may contain U+2028 and U+2029', () => {
	// WebVTT's only line terminators are line feeds and carriage returns, as in browsers
	const parse = (text: string) => {
		const cues: SubtitleCue[] = [];
		let config: string | undefined;
		const parser = new SubtitleParser({
			codec: 'webvtt',
			output: (cue, meta) => {
				cues.push(cue);
				config ??= meta.config?.description;
			},
		});
		parser.parse(text);
		return { config, cues: cues.map(cue => [cue.timestamp, cue.identifier ?? '', cue.text]) };
	};

	// On main, these two threw "WebVTT preamble incorrect."
	expect(parse('WEBVTT - Title\u2028more\n\n00:01.000 --> 00:02.000\nA\n')).toEqual({
		config: 'WEBVTT - Title\u2028more',
		cues: [[1, '', 'A']],
	});
	expect(parse('WEBVTT\nKind: captions\u2029\n\n00:01.000 --> 00:02.000\nA\n').cues).toEqual([[1, '', 'A']]);

	// On main, the identifiers were cut at U+2028 or U+2029, the rest going into the header or the cue's notes
	expect(parse('WEBVTT\n\nid\u2028x\n00:01.000 --> 00:02.000\nA\n')).toEqual({
		config: 'WEBVTT',
		cues: [[1, 'id\u2028x', 'A']],
	});
	expect(parse('WEBVTT\n\n00:01.000 --> 00:02.000\nA\n\nid\u2029y\n00:03.000 --> 00:04.000\nB\n').cues).toEqual([
		[1, '', 'A'],
		[3, 'id\u2029y', 'B'],
	]);

	// Lines full of them are parsed in linear time (identifier searches starting after each of them took about 3
	// seconds for a line of 120,000 characters)
	const separators = 'ab\u2028'.repeat(40_000);
	for (const text of [
		`WEBVTT\n\nNOTE ${separators}\n\n00:03.000 --> 00:04.000\nB\n`,
		`WEBVTT ${separators}\n\n00:03.000 --> 00:04.000\nB\n`,
		`WEBVTT\n\n00:01.000 --> 00:02.000\nA\n\n${separators}\n00:03.000 --> 00:04.000\nB\n`,
	]) {
		const startTime = performance.now();
		const { cues } = parse(text);
		expect(performance.now() - startTime).toBeLessThan(1000);
		expect(cues[cues.length - 1]![2]).toBe('B');
	}
});
