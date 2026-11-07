import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { TextSubtitleSource } from '../../src/media-source.js';

test('WebVTT cue text keeps its leading and trailing whitespace lines', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);

	await output.start();

	// YouTube's automatic captions keep a two-line layout with a line holding a single space; Chrome and FFmpeg keep it
	await source.add('WEBVTT\nKind: captions\nLanguage: en\n\n'
		+ '00:00:00.000 --> 00:00:02.000 align:start position:0%\n \nhello<00:00:00.480><c> world</c>\n\n'
		+ '00:00:02.000 --> 00:00:02.010 align:start position:0%\nhello world\n \n\n'
		+ '00:00:02.010 --> 00:00:04.000\n  indented\ntrailing  \n');

	await output.finalize();

	// Matroska stores the text of each cue as is
	const written = new TextDecoder().decode(output.target.buffer!);
	const cueTexts = [' \nhello<00:00:00.480><c> world</c>', 'hello world\n ', '  indented\ntrailing  '];
	expect(cueTexts.filter(cueText => !written.includes(cueText))).toEqual([]);
});

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
