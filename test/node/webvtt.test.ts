import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { TextSubtitleSource, EncodedAudioPacketSource } from '../../src/media-source.js';
import { SubtitleCue, SubtitleParser } from '../../src/subtitles.js';
import { EncodedPacket } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

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

test('A WebVTT cue right after the WEBVTT line is read, not taken for the header', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);

	await output.start();

	// Without a blank line after it, the header still ends there
	await source.add('WEBVTT\n00:00.000 --> 00:01.000\nFirst cue\n\n00:02.000 --> 00:03.000\nSecond cue\n');

	await output.finalize();

	const written = new TextDecoder().decode(output.target.buffer!);
	expect(['First cue', 'Second cue'].filter(cueText => !written.includes(cueText))).toEqual([]);
	expect(written.includes('WEBVTT\n00:00.000')).toBe(false); // The header is just the WEBVTT line
});

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

		// The second chunk's first cue starts before the first chunk's cue, which the muxer rejects. The TSDoc only
		// says add() should be awaited.
		void source.add('WEBVTT\n\n00:05.000 --> 00:06.000\nA\n\n').catch(() => {});
		void source.add('00:01.000 --> 00:02.000\nB\n\n00:07.000 --> 00:08.000\nC\n').catch(() => {});
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

	// Many such cues are parsed in linear time (looking for each cue's blank line up to the end of the text made 20,000
	// cues take about 3 seconds)
	const timestamp = (seconds: number) => [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
		.map(value => String(value).padStart(2, '0'))
		.join(':') + '.000';
	let manyCues = 'WEBVTT\n\n';
	for (let i = 0; i < 50_000; i++) {
		manyCues += `${timestamp(i)} --> ${timestamp(i + 1)}\nCue ${i}\n`;
	}
	let manyCueCount = 0;
	const manyCuesParser = new SubtitleParser({ codec: 'webvtt', output: () => manyCueCount++ });
	const startTime = performance.now();
	manyCuesParser.parse(manyCues);
	expect(performance.now() - startTime).toBeLessThan(2000);
	expect(manyCueCount).toBe(50_000);
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

test('Fragmented ISOBMFF muxing next to audio', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);
	const subtitleSource = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(subtitleSource);

	await output.start();

	// 3 seconds of audio, so that several fragments are written, and a single cue
	const decoderConfig = {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		description: new Uint8Array([0x11, 0x90]),
	};
	for (let i = 0; i < 150; i++) {
		if (i === 25) {
			await subtitleSource.add(`WEBVTT

00:00.500 --> 00:01.000
Hildy!
`);
		}

		await audioSource.add(
			new EncodedPacket(new Uint8Array(64).fill(i), 'key', i * 0.02, 0.02),
			i === 0 ? { decoderConfig } : undefined,
		);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	let packetCount = 0;
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		expect(packet.timestamp).toBeCloseTo(packetCount * 0.02, 6);
		packetCount++;
	}
	expect(packetCount).toBe(150);
});

test('WebVTT text with a long line before a cue is parsed in linear time', () => {
	// Like a NOTE block holding a long comment, or a STYLE block embedding a font
	const text = 'WEBVTT\n\nNOTE ' + 'x'.repeat(200_000) + '\n\nid\n00:01.000 --> 00:02.000\nHello\n';
	const cues: SubtitleCue[] = [];
	const parser = new SubtitleParser({ codec: 'webvtt', output: cue => cues.push(cue) });

	// On main, this took about 14 seconds (and a line of 1 MB didn't finish within 5 minutes)
	const startTime = performance.now();
	parser.parse(text);
	expect(performance.now() - startTime).toBeLessThan(1000);
	expect(cues.map(cue => [cue.timestamp, cue.identifier, cue.text])).toEqual([[1, 'id', 'Hello']]);
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
