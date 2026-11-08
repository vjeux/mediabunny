import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { TextSubtitleSource } from '../../src/media-source.js';

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

test('WebVTT cues out of order are written in order of their start times', async () => {
	// The W3C WebVTT parser takes cues in any order, as browsers and FFmpeg do
	for (const format of [new Mp4OutputFormat(), new MkvOutputFormat()]) {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new TextSubtitleSource('webvtt');
		output.addSubtitleTrack(source);
		await output.start();

		// On main, this failed the output: "Timestamps cannot be smaller than the largest timestamp of the previous
		// GOP"
		await source.add('WEBVTT\n\n'
			+ '00:05.000 --> 00:06.000\nCue at five\n\n'
			+ '00:01.000 --> 00:02.000\nCue at one\n\n'
			+ '00:03.000 --> 00:04.000\nCue at three\n');
		await output.finalize();

		const written = new TextDecoder().decode(output.target.buffer!);
		const positions = ['one', 'three', 'five'].map(word => written.indexOf(`Cue at ${word}`));
		expect(positions.every(position => position !== -1)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	}
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
