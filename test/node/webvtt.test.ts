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
