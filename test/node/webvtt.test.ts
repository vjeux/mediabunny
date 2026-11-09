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

test('WebVTT cue blocks with invalid timings are skipped as a whole', async () => {
	// The W3C WebVTT parser rejects a timing line with minutes or seconds over 59, with text before its start time, or
	// with a malformed timestamp, and skips its whole cue block, identifier and text included, as browsers do
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

	// On main, the invalid timing line went into the header, and its cue's text became the next cue's identifier
	expect(parse('WEBVTT\n\nxx:01.000 --> 00:02.000\nBad\n00:03.000 --> 00:04.000\nGood\n')).toEqual({
		config: 'WEBVTT',
		cues: [[3, '', 'Good']],
	});

	// On main, these were cues at 3600, 60, 3600 and 3660 seconds, and one at 5 seconds with a "-" in the header
	expect(parse('WEBVTT\n\n'
		+ '00:60:00.000 --> 00:61:00.000\nA\n\n'
		+ '00:00:60.000 --> 00:01:01.000\nB\n\n'
		+ '60:00.000 --> 61:00.000\nC\n\n'
		+ 'id\n00:61:00.000 --> 00:62:00.000\nD\n\n'
		+ '-00:05.000 --> 00:06.000\nE\n\n'
		+ '00:07.000 --> 00:08.000\nGood\n')).toEqual({ config: 'WEBVTT', cues: [[7, '', 'Good']] });

	// A line containing "-->" deeper in a block starts a new block, so the line before it isn't the identifier of its
	// cue (on main, it was "d"), and it isn't cue text either
	expect(parse('WEBVTT\n\nNOTE c\nd\n00:05.000 --> 00:06.000\nGood\n').cues).toEqual([[5, '', 'Good']]);
	expect(parse('WEBVTT\n\n00:05.000 --> 00:06.000\nGood\nthen --> right\n').cues).toEqual([[5, '', 'Good']]);

	// A comma before the milliseconds, as SubRip writes, is still read
	expect(parse('WEBVTT\n\n00:00:09,000 --> 00:00:10,000\nGood\n').cues).toEqual([[9, '', 'Good']]);

	// On main, the cue read at 75 minutes made the next one fail the whole output
	for (const format of [new Mp4OutputFormat(), new MkvOutputFormat()]) {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new TextSubtitleSource('webvtt');
		output.addSubtitleTrack(source);
		await output.start();
		await source.add('WEBVTT\n\n'
			+ '00:05.000 --> 00:06.000\nA\n\n00:75:00.000 --> 00:75:01.000\nX\n\n00:07.000 --> 00:08.000\nB\n');
		await output.finalize();
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
