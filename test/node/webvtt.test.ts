import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { TextSubtitleSource } from '../../src/media-source.js';

test('WebVTT timestamps with a one-digit hour field are read as hours', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);

	await output.start();

	// Matroska stores the timestamps in a cue's text relative to its start, which shows where each cue starts
	await source.add('WEBVTT\n\n'
		+ '0:00:01.000 --> 0:00:02.000\nA <0:00:01.250>a\n\n'
		+ '1:00:00.000 --> 1:00:05.000\nB <01:00:00.500>b\n\n'
		+ '2:00:00.000 --> 02:00:05.000\nC <02:00:00.750>c\n');

	await output.finalize();

	const written = new TextDecoder().decode(output.target.buffer!);
	const cueTexts = ['A', 'B', 'C'].map((letter) => {
		const index = written.indexOf(`${letter} <`);
		return index === -1 ? null : written.slice(index, index + 17);
	});
	expect(cueTexts).toEqual(['A <00:00:00.250>a', 'B <00:00:00.500>b', 'C <00:00:00.750>c']);
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
