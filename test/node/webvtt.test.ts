import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { TextSubtitleSource } from '../../src/media-source.js';

test.each(['MP4', 'Matroska'] as const)(
	'A cue that the muxer rejects fails finalize() even when add() wasn\'t awaited (%s)',
	async (formatName) => {
		const output = new Output({
			format: formatName === 'MP4' ? new Mp4OutputFormat() : new MkvOutputFormat(),
			target: new BufferTarget(),
		});
		const source = new TextSubtitleSource('webvtt');
		output.addSubtitleTrack(source);
		await output.start();

		// The second cue starts before the first one, which the muxer rejects. The TSDoc only says add() should be
		// awaited.
		void source.add(`WEBVTT

00:05.000 --> 00:06.000
A

00:01.000 --> 00:02.000
B

00:07.000 --> 00:08.000
C
`).catch(() => {});
		source.close();
		await expect(output.finalize()).rejects.toThrow();
	},
);

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
