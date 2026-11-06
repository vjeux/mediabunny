import { describe, expect, test } from 'vitest';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { analyzeInput, type MediaView } from './helpers/convmatrix-analysis.js';
import { buildSyntheticInput, SYNTHETIC_INPUTS } from './helpers/convmatrix-inputs.js';
import {
	AUDIO_ONLY_OUTPUTS,
	runCell,
	verifyCell,
	type Cell,
	type CellOptions,
	type Issue,
	type OutputKey,
	type RunResult,
} from './helpers/convmatrix-verify.js';

// A matrix of conversions (input formats and codecs x output formats x Conversion options) whose outputs are decoded
// and checked against a model of Conversion: which frames come out at which timestamps (copy, transcode, frame rate
// normalization), which beeps at which times, dimensions, sample rates, channel mixing, key frames and progress.
// The inputs are built here with Mediabunny: flat gray frames whose level identifies the frame, and beeps whose
// frequency identifies the beep (see helpers/convmatrix-signal.ts).
//
// A default run covers every input with every output format. Set VITE_CONVERSION_MATRIX_FULL=1 for the full matrix
// (more trims and boundary policies, every video and audio option on every input, more codecs; several minutes).

const FULL = !!(import.meta as unknown as { env: Record<string, string | undefined> })
	.env['VITE_CONVERSION_MATRIX_FULL'];

registerMp3Encoder();
registerFlacEncoder();

const ALL_OUTPUTS: OutputKey[] = ['mp4', 'mp4-frag', 'mov', 'mkv', 'webm', 'ts', 'ogg', 'mp3', 'flac', 'wav', 'hls-ts',
	'hls-cmaf'];

type InputInfo = { id: string; hasVideo: boolean; hasAudio: boolean; start: number };

const INPUT_INFO: InputInfo[] = SYNTHETIC_INPUTS.map(spec => ({
	id: spec.id,
	hasVideo: !!spec.video,
	hasAudio: !!spec.audio,
	start: Math.min(spec.video ? spec.video.start ?? 0 : Infinity, spec.audio ? spec.audio.start ?? 0 : Infinity),
}));

// Files from elsewhere (B-frames, edit lists, odd start times, real codec settings), in the full matrix only. They
// don't carry the generator's markers, so only timing and format are checked for them, on their first 3 seconds.
const PUBLIC_INPUTS: { id: string; url: string }[] = FULL
	? [
			{ id: 'mp4-b-frames-edit-list', url: '/edts.mp4' },
			{ id: 'mp4-sar-b-frames', url: '/sar_2x1.mp4' },
			{ id: 'mp4-rotated-51', url: '/rotate-buck-bunny.mp4' },
			{ id: 'webm-vp9-opus-negative-start', url: '/demo.webm' },
			{ id: 'ts-b-frames', url: '/0.ts' },
			{ id: 'ogg-opus-preroll', url: '/preroll-test.opus' },
			{ id: 'ogg-vorbis', url: '/vorbis-eos.ogg' },
			{ id: 'adts-aac', url: '/sample3.aac' },
			{ id: 'mp3-vbr-24k', url: '/Toothsome-Meme.VBRv2.mp3' },
		]
	: [];

const publicCells = (input: InputInfo) => {
	const cells: Cell[] = [];
	const outputs = ALL_OUTPUTS.filter(output => input.hasAudio || !AUDIO_ONLY_OUTPUTS.includes(output));
	const head = { start: input.start, end: input.start + 3 };
	const middle = { start: input.start + 0.3, end: input.start + 1.1 };
	// Transcodes get a small size to stay fast
	const small = input.hasVideo ? { video: { width: 320 } } : {};
	for (const output of outputs) {
		const add = (label: string, options: CellOptions) => {
			cells.push({ id: `${input.id} -> ${output} (${label})`, input: input.id, output, options });
		};
		add('first 3 s', { trim: head });
		add('first 3 s, transcode', { trim: head, copy: false, ...small });
		add('trim-mid-gop', { trim: middle });
		add('trim-mid-gop, transcode', { trim: middle, copy: false, ...small });
	}
	return cells;
};

const TRIMS: [string, { start?: number; end?: number }][] = [
	['trim-mid-gop', { start: 0.3, end: 1.1 }],
	...(FULL
		? [
				['trim-key-frames', { start: 0.48, end: 1.44 }],
				['trim-start', { start: 0.7 }],
				['trim-end', { end: 1.3 }],
				['trim-past-end', { start: 0.5, end: 10 }],
				['trim-before-start', { start: -0.5, end: 1 }],
				['trim-one-frame', { start: 0, end: 0.04 }],
			] as [string, { start?: number; end?: number }][]
		: []),
];

const VIDEO_OPTIONS: [string, CellOptions['video']][] = [
	['width', { width: 100 }],
	['contain', { width: 128, height: 128, fit: 'contain' }],
	['crop', { crop: { left: 10, top: 10, width: 50, height: 40 } }],
	['rotate', { rotate: 90 }],
	['fps-30', { frameRate: 30 }],
	['fps-10', { frameRate: 10 }],
	['key-frames-only', { keyFrameInterval: 0 }],
	['process-drop-odd', { processPreset: 'drop-odd' }],
	['process-canvas', { processPreset: 'canvas' }],
	['force-transcode', { forceTranscode: true }],
	...(FULL
		? [
				['height', { height: 64 }],
				['cover', { width: 128, height: 128, fit: 'cover' }],
				['fill', { width: 128, height: 128, fit: 'fill' }],
				['rotate-no-metadata', { rotate: 180, allowRotationMetadata: false }],
				['fps-24', { frameRate: 24 }],
				['fps-60', { frameRate: 60 }],
				['key-frames-0.3', { keyFrameInterval: 0.3 }],
				['process-identity', { processPreset: 'identity' }],
				['process-async', { processPreset: 'async-identity' }],
				['quality-low', { forceTranscode: true, bitrate: 100_000 }],
			] as [string, CellOptions['video']][]
		: []),
];

const AUDIO_OPTIONS: [string, CellOptions['audio']][] = [
	['rate-22050', { sampleRate: 22050 }],
	['mono', { numberOfChannels: 1 }],
	['stereo', { numberOfChannels: 2 }],
	['process-split', { processPreset: 'split' }],
	...(FULL
		? [
				['rate-8000', { sampleRate: 8000 }],
				['rate-96000', { sampleRate: 96000 }],
				['six-channels', { numberOfChannels: 6 }],
				['process-identity', { processPreset: 'identity' }],
				['process-async', { processPreset: 'async-identity' }],
				['force-transcode', { forceTranscode: true }],
			] as [string, CellOptions['audio']][]
		: []),
];

const buildCells = () => {
	const cells: Cell[] = [];
	const add = (input: InputInfo, output: OutputKey, label: string, options: CellOptions) => {
		cells.push({ id: `${input.id} -> ${output} (${label})`, input: input.id, output, options });
	};
	const shiftTrim = (input: InputInfo, trim: { start?: number; end?: number }) => ({
		...(trim.start !== undefined ? { start: input.start + trim.start } : {}),
		...(trim.end !== undefined ? { end: input.start + trim.end } : {}),
	});

	for (const input of INPUT_INFO) {
		const outputs = ALL_OUTPUTS.filter(output => input.hasAudio || !AUDIO_ONLY_OUTPUTS.includes(output));
		for (const output of outputs) {
			add(input, output, 'default', {});
			add(input, output, 'transcode', { copy: false });
			for (const [label, trim] of TRIMS) {
				add(input, output, label, { trim: shiftTrim(input, trim) });
				if (FULL || input.hasVideo) {
					add(input, output, `${label}, transcode`, { trim: shiftTrim(input, trim), copy: false });
				}
				if (FULL && ['mp4', 'mkv'].includes(output)) {
					add(input, output, `${label}, shrink`, {
						trim: shiftTrim(input, trim),
						copy: { boundaryPolicy: 'shrink' },
					});
					add(input, output, `${label}, shift`, {
						trim: shiftTrim(input, trim),
						copy: { shiftTolerance: Infinity },
					});
				}
			}
		}

		if (input.hasVideo && (FULL || input.id === 'mp4-avc-opus')) {
			for (const output of (FULL ? ['mp4', 'webm', 'mkv'] : ['mp4', 'webm']) as OutputKey[]) {
				for (const [label, video] of VIDEO_OPTIONS) {
					add(input, output, label, { video });
				}
			}
		}
		if (input.hasVideo && (FULL || input.id === 'mkv-vp8-alpha-flac')) {
			add(input, 'webm', 'keep alpha', { video: { alpha: 'keep', forceTranscode: true } });
			add(input, 'webm', 'discard alpha', { video: { alpha: 'discard', forceTranscode: true } });
		}
		if (input.hasVideo && (FULL || input.id === 'mp4-avc-opus')) {
			for (const codec of ['avc', 'vp8', 'vp9', 'av1'] as const) {
				add(input, 'mkv', `video ${codec}`, { video: { codec, forceTranscode: true } });
			}
		}

		if (input.hasAudio && (FULL || input.id === 'mov-avc30-pcm' || input.id === 'flac-51')) {
			for (const output of (FULL ? ['mp4', 'mkv', 'ogg', 'mp3', 'flac', 'wav'] : ['mp4', 'wav']) as OutputKey[]) {
				for (const [label, audio] of AUDIO_OPTIONS) {
					add(input, output, label, { audio });
				}
			}
		}
		if (input.hasAudio && (FULL || input.id === 'mp4-avc-opus')) {
			for (const codec of ['opus', 'flac', 'pcm-s16', 'pcm-f32', 'mp3'] as const) {
				add(input, 'mkv', `audio ${codec}`, { audio: { codec, forceTranscode: true } });
			}
		}

		if (FULL || input.id === 'mp4-avc-opus') {
			add(input, 'mp4', 'forced copy, trim mid-GOP', {
				copy: { mode: 'forced' },
				trim: shiftTrim(input, TRIMS[0]![1]),
			});
			add(input, 'webm', 'cancel', { copy: false, cancelAt: 0.5 });
			add(input, 'mp4', 'stepwise', { stepwise: 0.3 });
			add(input, 'mkv', 'stepwise, transcode', { copy: false, stepwise: 0.3 });
			add(input, 'mp4', 'deterministic', { repeat: true });
			add(input, 'webm', 'deterministic, transcode', { copy: false, repeat: true });
		}
	}

	return cells;
};

const CELLS = buildCells();

/** Issues known on main, with the fork PRs that fix them. */
const isKnownIssue = (cell: Cell, inView: MediaView, run: RunResult, issue: Issue) => {
	// Opus encoding in Chrome leaves audio at other rates than 48 kHz late by up to 5.5 ms (#303, #306)
	const encodedRate = cell.options.audio?.sampleRate ?? inView.audio?.decodedSampleRate;
	if (
		run.outputCodecs.audio === 'opus'
		&& encodedRate !== 48000
		&& (issue.kind === 'audio-offset' || issue.kind === 'av-sync')
	) {
		return Math.abs(Number.parseFloat(issue.detail.match(/(-?[\d.]+) ms/)![1]!)) < 6;
	}
	// When the encoder can't take the channel count or the sample rate, Conversion falls back to stereo at 48 kHz,
	// changing both (#75)
	if (
		run.outputCodecs.audio === 'mp3'
		&& (issue.kind === 'audio-sample-rate' || issue.kind === 'audio-channels')
		&& ((inView.audio?.decodedNumberOfChannels ?? 0) > 2 || (cell.options.audio?.sampleRate ?? 0) > 48000)
	) {
		return true;
	}
	// The FLAC muxer writes a minimum block size of 0 when there's a single frame, which decoders reject (fixed on
	// upstream's bug-fix-mania branch)
	if (cell.output === 'flac' && issue.kind === 'audio-decode' && cell.id.includes('trim-one-frame')) {
		return true;
	}
	// When no track gets a single packet, WAVE, FLAC and MP3 throw "Cannot finalize an empty file" and Ogg writes 0
	// bytes (MP4 writes a file without tracks); what such a conversion should give is an open question
	const emptyOgg = cell.output === 'ogg' && issue.detail.includes('unsupported');
	if (issue.kind === 'error' && (issue.detail.includes('Cannot finalize an empty') || emptyOgg)) {
		return true;
	}
	// HLS lists a track that never got a packet in CODECS, so reading the output back fails (#312)
	if (cell.output.startsWith('hls') && issue.kind === 'error' && issue.detail.includes('No matching track found')) {
		return true;
	}
	// Trimming the end of MPEG-TS input races two reads of the same packet and throws "Assertion failed." (#304)
	if (cell.input.startsWith('ts-') && cell.options.trim?.end !== undefined && issue.kind === 'error') {
		return issue.detail.includes('Assertion failed') || issue.detail.includes('randomAccessIndicator');
	}

	return false;
};

const runCells = async (bytes: Uint8Array, view: MediaView, cells: Cell[], markers: boolean) => {
	const failures: string[] = [];

	for (const cell of cells) {
		const run = await runCell(bytes, cell);
		const issues = verifyCell(cell, view, run, markers).filter(issue => !isKnownIssue(cell, view, run, issue));

		if (cell.options.repeat && run.outputBytes) {
			const again = await runCell(bytes, cell);
			const a = run.outputBytes;
			const b = again.outputBytes;
			if (!b || a.length !== b.length || a.some((byte, i) => byte !== b[i])) {
				issues.push({ kind: 'determinism', detail: 'A second run gave different bytes' });
			}
		}

		if (issues.length > 0) {
			failures.push(`${cell.id}: ${issues.map(x => `${x.kind}: ${x.detail}`).join('; ')}`);
		}
	}

	return failures;
};

describe('Conversion matrix', () => {
	for (const info of INPUT_INFO) {
		test(info.id, async () => {
			const bytes = await buildSyntheticInput(SYNTHETIC_INPUTS.find(x => x.id === info.id)!);
			using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
			const view = await analyzeInput(input);

			const failures = await runCells(bytes, view, CELLS.filter(x => x.input === info.id), true);
			expect(failures).toEqual([]);
		}, FULL ? 1_800_000 : 120_000);
	}

	for (const { id, url } of PUBLIC_INPUTS) {
		test(id, async () => {
			const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
			using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
			const view = await analyzeInput(input);
			const info: InputInfo = {
				id,
				hasVideo: !!view.video,
				hasAudio: !!view.audio,
				start: await input.getFirstTimestamp(),
			};

			const failures = await runCells(bytes, view, publicCells(info), false);
			expect(failures).toEqual([]);
		}, 1_800_000);
	}
});

// Negative controls: outputs that are wrong in one way each, which the checks above must catch
describe('Conversion matrix oracle', () => {
	const kinds = (issues: Issue[]) => issues.map(issue => issue.kind);
	const mutate = (run: RunResult, change: (copy: RunResult) => void) => {
		const copy = structuredClone(run);
		change(copy);
		return copy;
	};
	const getInput = async (id: string) => {
		const bytes = await buildSyntheticInput(SYNTHETIC_INPUTS.find(x => x.id === id)!);
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return { bytes, view: await analyzeInput(input) };
	};

	test('rejects wrong frames, timing, dimensions, beeps and progress', async () => {
		const { bytes, view } = await getInput('mp4-avc-opus');
		const transcode: Cell = { id: 'transcode', input: 'mp4-avc-opus', output: 'mp4', options: { copy: false } };
		const canvas: Cell = { ...transcode, id: 'canvas', options: { video: { processPreset: 'canvas' } } };
		const vp9: Cell = { ...transcode, id: 'vp9', output: 'webm' };

		for (const cell of [transcode, canvas, vp9]) {
			const run = await runCell(bytes, cell);
			expect(verifyCell(cell, view, run)).toEqual([]);

			// Blank frames, and a frozen output
			const blank = mutate(run, (copy) => {
				for (const frame of copy.view!.video!.frames) {
					frame.level = -1;
					frame.gray = 0;
				}
			});
			expect(kinds(verifyCell(cell, view, blank))).toContain('video-content');
			const frozen = mutate(run, (copy) => {
				for (const frame of copy.view!.video!.frames) {
					frame.level = copy.view!.video!.frames[0]!.level;
				}
			});
			expect(kinds(verifyCell(cell, view, frozen))).toContain('video-content');
		}

		const run = await runCell(bytes, transcode);
		const check = (change: (copy: RunResult) => void) => kinds(verifyCell(transcode, view, mutate(run, change)));

		expect(check((copy) => {
			const levels = copy.view!.video!.frames.map(frame => frame.level).reverse();
			copy.view!.video!.frames.forEach((frame, i) => {
				frame.level = levels[i]!;
			});
		})).toContain('video-content');
		expect(check(copy => copy.view!.video!.frames.splice(10, 1))).toContain('video-count');
		expect(check((copy) => {
			for (const frame of copy.view!.video!.frames) {
				frame.timestamp += 0.04;
			}
		})).toEqual(expect.arrayContaining(['video-offset', 'av-sync']));
		expect(check((copy) => {
			copy.view!.video!.frames[20]!.timestamp += 0.01;
		})).toContain('video-timestamps');
		expect(check((copy) => {
			copy.view!.video!.displayWidth += 2;
		})).toContain('video-dimensions');
		expect(check((copy) => {
			copy.view!.video!.firstPacketIsKey = false;
		})).toContain('video-key');

		expect(check(copy => copy.view!.audio!.beeps.splice(2, 1))).toContain('audio-beeps');
		expect(check((copy) => {
			for (const beep of copy.view!.audio!.beeps) {
				beep.time += 0.005;
			}
		})).toEqual(expect.arrayContaining(['audio-offset', 'av-sync']));
		expect(check((copy) => {
			for (const beep of copy.view!.audio!.beeps) {
				beep.amplitudes = beep.amplitudes.map(amplitude => amplitude / 2);
			}
		})).toContain('audio-level');
		expect(check((copy) => {
			copy.view!.audio!.decodedNumberOfChannels = 1;
		})).toContain('audio-channels');
		expect(check((copy) => {
			copy.view!.audio!.discontinuities.push({ at: 1, delta: 0.01 });
		})).toContain('audio-gaps');
		expect(check((copy) => {
			copy.view!.audio!.endTimestamp! -= 0.5;
		})).toContain('audio-end');

		expect(check((copy) => {
			copy.progress = [0, 0.6, 0.4, 1];
		})).toContain('progress');
		expect(check((copy) => {
			copy.progress = [0, 0.5];
		})).toContain('progress');
	});

	test('requires evidence of cancellation', async () => {
		const { bytes, view } = await getInput('mp4-avc-opus');
		const cell: Cell = {
			id: 'cancel',
			input: 'mp4-avc-opus',
			output: 'webm',
			options: { copy: false, cancelAt: 0.5 },
		};
		const run = await runCell(bytes, cell);
		expect(verifyCell(cell, view, run)).toEqual([]);

		// Progress never reaches 2, so the conversion runs to the end
		const neverCanceled: Cell = { ...cell, options: { copy: false, cancelAt: 2 } };
		expect(kinds(verifyCell(neverCanceled, view, await runCell(bytes, neverCanceled)))).toEqual(['cancel']);

		// With every track discarded, the conversion is invalid and never runs
		const invalid: Cell = {
			...cell,
			options: { cancelAt: 0.5, video: { discard: true }, audio: { discard: true } },
		};
		expect(kinds(verifyCell(invalid, view, await runCell(bytes, invalid)))).toEqual(['invalid']);

		// execute() resolving, or anything left uncanceled, doesn't count either
		expect(kinds(verifyCell(cell, view, mutate(run, (copy) => {
			copy.error = null;
		})))).toEqual(['cancel']);
		expect(kinds(verifyCell(cell, view, mutate(run, (copy) => {
			copy.outputState = 'finalized';
		})))).toEqual(['cancel']);
	});
});
