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

test('WebVTT text starting with a byte order mark is read', async () => {
	// Windows tools save UTF-8 text with a byte order mark, which reading a file with Node keeps
	for (const format of [new Mp4OutputFormat(), new MkvOutputFormat()]) {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new TextSubtitleSource('webvtt');
		output.addSubtitleTrack(source);
		await output.start();

		// On main, this threw "WebVTT preamble incorrect."
		await source.add('\uFEFFWEBVTT\n\n00:01.000 --> 00:02.000\nHello\n');
		await output.finalize();

		const written = new TextDecoder().decode(output.target.buffer!);
		expect(written).toContain('Hello');
		expect(written).toContain('WEBVTT');
		expect(written).not.toContain('\uFEFF'); // Not in the header either
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
