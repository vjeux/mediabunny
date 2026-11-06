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
