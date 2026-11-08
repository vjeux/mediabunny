import { describe, expect, test, type TestContext } from 'vitest';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { analyzeInput, type MediaView } from './helpers/convmatrix-analysis.js';
import { buildSyntheticInput, SYNTHETIC_INPUTS } from './helpers/convmatrix-inputs.js';
import {
	audioDecodingResponds,
	decodesNatively,
	getPlatformSupport,
	NATIVE_PROBES,
	type PlatformSupport,
} from './helpers/convmatrix-probes.js';
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
//
// Cells that decode FLAC or Vorbis run last, and only where WebCodecs decodes a tiny known-good stream of that codec:
// on WebKitGTK, a FLAC or Vorbis decode stalls every later audio decode on the page. Likewise, cells that need Opus or
// AAC encoding, decoding past negative timestamps, AV1 decoding or AVC encoding are skipped where WebCodecs fails on
// those (see helpers/convmatrix-probes.ts), and every skip is reported.

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
type PublicInput = { id: string; url: string; videoCodec: string | null; audioCodec: string | null };
const PUBLIC_INPUTS: PublicInput[] = FULL
	? [
			{ id: 'mp4-b-frames-edit-list', url: '/edts.mp4', videoCodec: 'avc', audioCodec: 'aac' },
			{ id: 'mp4-sar-b-frames', url: '/sar_2x1.mp4', videoCodec: 'avc', audioCodec: null },
			{ id: 'mp4-rotated-51', url: '/rotate-buck-bunny.mp4', videoCodec: 'avc', audioCodec: 'aac' },
			{ id: 'webm-vp9-opus-negative-start', url: '/demo.webm', videoCodec: 'vp9', audioCodec: 'opus' },
			{ id: 'ts-b-frames', url: '/0.ts', videoCodec: 'avc', audioCodec: 'aac' },
			{ id: 'ogg-opus-preroll', url: '/preroll-test.opus', videoCodec: null, audioCodec: 'opus' },
			{ id: 'ogg-vorbis', url: '/vorbis-eos.ogg', videoCodec: null, audioCodec: 'vorbis' },
			{ id: 'adts-aac', url: '/sample3.aac', videoCodec: null, audioCodec: 'aac' },
			{ id: 'mp3-vbr-24k', url: '/Toothsome-Meme.VBRv2.mp3', videoCodec: null, audioCodec: 'mp3' },
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

// Issues on main that open pull requests fix. isKnownIssue tolerates each one only while its flag is on: a branch that
// merges the fix turns the flag off, so the matrix checks it again.
const KNOWN_ISSUES: Record<string, boolean> = {
	'#303+#306': true, // Opus encoding of audio at other rates than 48 kHz comes out late in Chrome (fixed by both)
	'#75': true, // The encoder fallback changes both the channel count and the sample rate
	'#304': true, // Trimming the end of MPEG-TS input throws "Assertion failed."
	'#312': true, // HLS lists tracks without packets in CODECS
	'#629': true, // Windows' AAC encoder silences the first ~512 samples
	'#635': true, // The FLAC muxer writes a minimum block size of 0 for a single frame
};

/** Issues known on main, with the PRs that fix them. */
const isKnownIssue = (cell: Cell, inView: MediaView, run: RunResult, issue: Issue) => {
	// Windows' AAC encoder (Media Foundation) silences the first ~512 samples, so a beep right at the start of
	// transcoded AAC comes out late (#629)
	if (
		KNOWN_ISSUES['#629']
		&& run.outputCodecs.audio === 'aac'
		&& run.copied.audio === false
		&& issue.fromStartBeepsOnly
	) {
		return true;
	}
	// Opus encoding in Chrome leaves audio at other rates than 48 kHz late by up to 5.5 ms (#303, #306)
	const encodedRate = cell.options.audio?.sampleRate ?? inView.audio?.decodedSampleRate;
	if (
		KNOWN_ISSUES['#303+#306']
		&& run.outputCodecs.audio === 'opus'
		&& encodedRate !== 48000
		&& (issue.kind === 'audio-offset' || issue.kind === 'av-sync')
	) {
		return Math.abs(Number.parseFloat(issue.detail.match(/(-?[\d.]+) ms/)![1]!)) < 6;
	}
	// When the encoder can't take the channel count or the sample rate, Conversion falls back to stereo at 48 kHz,
	// changing both (#75)
	if (
		KNOWN_ISSUES['#75']
		&& run.outputCodecs.audio === 'mp3'
		&& (issue.kind === 'audio-sample-rate' || issue.kind === 'audio-channels')
		&& ((inView.audio?.decodedNumberOfChannels ?? 0) > 2 || (cell.options.audio?.sampleRate ?? 0) > 48000)
	) {
		return true;
	}
	// The FLAC muxer writes a minimum block size of 0 when there's a single frame, which decoders reject (#635, from
	// upstream's bug-fix-mania branch)
	if (
		KNOWN_ISSUES['#635']
		&& cell.output === 'flac'
		&& issue.kind === 'audio-decode'
		&& cell.id.includes('trim-one-frame')
	) {
		return true;
	}
	// When no track gets a single packet, WAVE, FLAC and MP3 throw "Cannot finalize an empty file" and Ogg writes 0
	// bytes (MP4 writes a file without tracks); what such a conversion should give is an open question
	const emptyOgg = cell.output === 'ogg' && issue.detail.includes('unsupported');
	if (issue.kind === 'error' && (issue.detail.includes('Cannot finalize an empty') || emptyOgg)) {
		return true;
	}
	// HLS lists a track that never got a packet in CODECS, so reading the output back fails (#312)
	if (
		KNOWN_ISSUES['#312']
		&& cell.output.startsWith('hls')
		&& issue.kind === 'error'
		&& issue.detail.includes('No matching track found')
	) {
		return true;
	}
	// Trimming the end of MPEG-TS input races two reads of the same packet and throws "Assertion failed." (#304)
	if (
		KNOWN_ISSUES['#304']
		&& cell.input.startsWith('ts-')
		&& cell.options.trim?.end !== undefined
		&& issue.kind === 'error'
	) {
		return issue.detail.includes('Assertion failed') || issue.detail.includes('randomAccessIndicator');
	}

	return false;
};

type DeferredCodec = 'flac' | 'vorbis';

/** The codec a cell decodes that can stall the page's audio decoding, known from its input and options. */
const deferredCodecOf = (cell: Cell, inputAudioCodec: string | null): DeferredCodec | null => {
	if (inputAudioCodec === 'vorbis') {
		return 'vorbis';
	}
	if (inputAudioCodec === 'flac' || cell.output === 'flac' || cell.options.audio?.codec === 'flac') {
		return 'flac';
	}

	return null;
};

/** Cells whose output audio turned out to use a deferred codec, by codec and input. */
const deferredAtRuntime = new Map<string, Cell[]>();

// Codecs whose encoders delay the audio (AAC priming, Opus pre-skip, the MP3 encoder delay), which Mediabunny signals
// with timestamps before zero
const PRIMED_AUDIO_CODECS = ['opus', 'aac', 'mp3'];

/** Why the platform can't run a matrix input at all (building it, or decoding it to know what it holds). */
const getInputSkipReason = (matrixInput: MatrixInput, support: PlatformSupport) => {
	if (matrixInput.url === null && matrixInput.audioCodec === 'opus' && !support.opusEncoding) {
		return 'Opus encoding';
	}
	if (PRIMED_AUDIO_CODECS.includes(matrixInput.audioCodec ?? '') && !support.negativeTimestamps) {
		return 'decoding past negative timestamps';
	}
	if (matrixInput.videoCodec === 'av1' && !support.av1Decoding) {
		return 'AV1 decoding';
	}

	return null;
};

/** Why the platform can't run a cell, from the conversion's track decisions and the input's key frames. */
const getCellSkipReason = (cell: Cell, support: PlatformSupport, inView: MediaView) => (run: RunResult) => {
	const audioCodec = run.outputCodecs.audio;
	if (run.copied.audio === false && audioCodec === 'opus' && !support.opusEncoding) {
		return 'Opus encoding';
	}
	if (run.copied.audio === false && audioCodec === 'aac' && !support.aacEncoding) {
		return 'AAC encoding';
	}
	if (run.copied.video === false && run.outputCodecs.video === 'avc' && !support.avcEncoding) {
		return 'AVC encoding';
	}
	if (run.outputCodecs.video === 'av1' && !support.av1Decoding) {
		return 'AV1 decoding';
	}
	// Primed audio starts before zero, and so does a copy trimmed into compressed audio (its decoder pre-roll)
	const trimmedCopy = run.copied.audio === true && (cell.options.trim?.start ?? -Infinity) > run.startTimestamp - 1
		&& audioCodec !== null && !audioCodec.startsWith('pcm') && audioCodec !== 'flac';
	if ((PRIMED_AUDIO_CODECS.includes(audioCodec ?? '') || trimmedCopy) && !support.negativeTimestamps) {
		return 'decoding past negative timestamps';
	}
	// A video copy that starts at a key frame before the trim start puts the frames before it at negative
	// timestamps ('shrink' leaves those frames out)
	const policy = (typeof cell.options.copy === 'object' && cell.options.copy.boundaryPolicy) || 'expand';
	if (run.copied.video === true && inView.video && policy === 'expand') {
		const keys = inView.video.verifiedKeyPacketTimestamps;
		const startKey = keys.filter(t => t <= run.startTimestamp + 1e-9).at(-1) ?? keys[0];
		const startsBeforeTrim = startKey !== undefined && startKey < run.startTimestamp - 1e-6;
		if (startsBeforeTrim && !support.negativeVideoTimestamps[run.outputCodecs.video ?? '']) {
			return 'decoding video past negative timestamps';
		}
	}
	return null;
};

type CellsResult = { failures: string[]; skipReasons: string[]; ran: number };

const runCells = async (
	bytes: Uint8Array,
	view: MediaView,
	cells: Cell[],
	matrixInput: MatrixInput,
	support: PlatformSupport,
	deferAudioCodecs: DeferredCodec[],
): Promise<CellsResult> => {
	const result: CellsResult = { failures: [], skipReasons: [], ran: 0 };

	for (const cell of cells) {
		const getSkipReason = getCellSkipReason(cell, support, view);
		const run = await runCell(bytes, cell, deferAudioCodecs, getSkipReason);
		if (run.deferredCodec !== null) {
			const key = `${run.deferredCodec} ${cell.input}`;
			deferredAtRuntime.set(key, [...deferredAtRuntime.get(key) ?? [], cell]);
			continue;
		}
		if (run.skipReason !== null) {
			result.skipReasons.push(run.skipReason);
			continue;
		}
		result.ran++;

		const issues = verifyCell(cell, view, run, matrixInput.markers)
			.filter(issue => !isKnownIssue(cell, view, run, issue));

		if (cell.options.repeat && run.outputBytes) {
			const again = await runCell(bytes, cell);
			const a = run.outputBytes;
			const b = again.outputBytes;
			if (!b || a.length !== b.length || a.some((byte, i) => byte !== b[i])) {
				issues.push({ kind: 'determinism', detail: 'A second run gave different bytes' });
			}
		}

		if (issues.length > 0) {
			result.failures.push(`${cell.id}: ${issues.map(x => `${x.kind}: ${x.detail}`).join('; ')}`);
		}
	}

	return result;
};

/** Reports the cells the platform couldn't run: skips the test when none ran, notes the count otherwise. */
const reportSkips = async (result: CellsResult, context: TestContext) => {
	if (result.skipReasons.length === 0) {
		return;
	}

	const counts = new Map<string, number>();
	for (const reason of result.skipReasons) {
		counts.set(reason, (counts.get(reason) ?? 0) + 1);
	}
	const summary = [...counts].map(([reason, count]) => `${reason} (${count})`).join(', ');
	if (result.ran === 0 && result.failures.length === 0) {
		context.skip(`WebCodecs fails here on ${summary}`);
	}
	await context.annotate(`${result.skipReasons.length} cells skipped, as WebCodecs fails here on ${summary}`);
};

type MatrixInput = {
	id: string;
	videoCodec: string | null;
	audioCodec: string | null;
	markers: boolean;
	url: string | null;
};

const MATRIX_INPUTS: MatrixInput[] = [
	...SYNTHETIC_INPUTS.map(spec => ({
		id: spec.id,
		videoCodec: spec.video?.codec ?? null,
		audioCodec: spec.audio?.codec ?? null,
		markers: true,
		url: null,
	})),
	...PUBLIC_INPUTS.map(({ id, url, videoCodec, audioCodec }) => ({
		id,
		videoCodec,
		audioCodec,
		markers: false,
		url,
	})),
];

const loadedInputs = new Map<string, Promise<{ bytes: Uint8Array; view: MediaView; cells: Cell[] }>>();

/** The input's bytes, its decoded view and its cells (loaded once). */
const loadInput = (matrixInput: MatrixInput) => {
	let promise = loadedInputs.get(matrixInput.id);
	if (!promise) {
		promise = (async () => {
			const bytes = matrixInput.url === null
				? await buildSyntheticInput(SYNTHETIC_INPUTS.find(x => x.id === matrixInput.id)!)
				: new Uint8Array(await (await fetch(matrixInput.url)).arrayBuffer());
			using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
			const view = await analyzeInput(input);
			const cells = matrixInput.url === null
				? CELLS.filter(x => x.input === matrixInput.id)
				: publicCells({
						id: matrixInput.id,
						hasVideo: !!view.video,
						hasAudio: !!view.audio,
						start: await input.getFirstTimestamp(),
					});

			return { bytes, view, cells };
		})();
		loadedInputs.set(matrixInput.id, promise);
	}

	return promise;
};

const testTimeout = (matrixInput: MatrixInput) => (FULL || matrixInput.url !== null ? 1_800_000 : 300_000);

describe('Conversion matrix', () => {
	for (const matrixInput of MATRIX_INPUTS) {
		// Every cell of a FLAC or Vorbis input decodes it
		if (matrixInput.audioCodec === 'flac' || matrixInput.audioCodec === 'vorbis') {
			continue;
		}

		test(matrixInput.id, async (context) => {
			const support = await getPlatformSupport();
			const inputSkipReason = getInputSkipReason(matrixInput, support);
			if (inputSkipReason !== null) {
				context.skip(`WebCodecs fails here on ${inputSkipReason}`);
			}

			const { bytes, view, cells } = await loadInput(matrixInput);
			const plainCells = cells.filter(cell => deferredCodecOf(cell, matrixInput.audioCodec) === null);

			const result = await runCells(bytes, view, plainCells, matrixInput, support, ['flac', 'vorbis']);
			await reportSkips(result, context);
			expect(result.failures).toEqual([]);
		}, testTimeout(matrixInput));
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
	const getInput = (id: string) => loadInput(MATRIX_INPUTS.find(x => x.id === id)!);
	/** Skips the test where the platform can't run the input at all. */
	const requireInput = async (id: string, context: TestContext) => {
		const inputSkipReason = getInputSkipReason(MATRIX_INPUTS.find(x => x.id === id)!, await getPlatformSupport());
		if (inputSkipReason !== null) {
			context.skip(`WebCodecs fails here on ${inputSkipReason}`);
		}
	};
	/** Runs a baseline cell, or skips the test where the platform can't run it. */
	const runBaseline = async (bytes: Uint8Array, cell: Cell, context: TestContext) => {
		const { view } = await getInput(cell.input);
		const run = await runCell(bytes, cell, [], getCellSkipReason(cell, await getPlatformSupport(), view));
		if (run.skipReason !== null) {
			context.skip(`WebCodecs fails here on ${run.skipReason}`);
		}
		return run;
	};

	test('rejects wrong frames, timing, dimensions, beeps and progress', async (context) => {
		await requireInput('mp4-avc-opus', context);
		const { bytes, view } = await getInput('mp4-avc-opus');
		const transcode: Cell = { id: 'transcode', input: 'mp4-avc-opus', output: 'mp4', options: { copy: false } };
		const canvas: Cell = { ...transcode, id: 'canvas', options: { video: { processPreset: 'canvas' } } };
		const vp9: Cell = { ...transcode, id: 'vp9', output: 'webm' };

		for (const cell of [transcode, canvas, vp9]) {
			const run = await runBaseline(bytes, cell, context);
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

		const run = await runBaseline(bytes, transcode, context);
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

	test('requires evidence of cancellation', async (context) => {
		await requireInput('mp4-avc-opus', context);
		const { bytes, view } = await getInput('mp4-avc-opus');
		const cell: Cell = {
			id: 'cancel',
			input: 'mp4-avc-opus',
			output: 'webm',
			options: { copy: false, cancelAt: 0.5 },
		};
		const run = await runBaseline(bytes, cell, context);
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

// Last, the cells that decode FLAC, then those that decode Vorbis, where WebCodecs decodes them at all. After a failed
// probe, the page's audio decoding may have stalled, so the Vorbis cells then also need it to still respond.
let flacDecodes: Promise<boolean> | null = null;
let vorbisDecodes: Promise<boolean> | null = null;
let audioDecodingStalled: Promise<boolean> = Promise.resolve(false);

const flacRuns = () => flacDecodes ??= decodesNatively(NATIVE_PROBES.flac).then((decodes) => {
	if (!decodes) {
		audioDecodingStalled = audioDecodingResponds().then(responds => !responds);
	}
	return decodes;
});

const vorbisRuns = async () => {
	if (await audioDecodingStalled) {
		return false;
	}
	return vorbisDecodes ??= decodesNatively(NATIVE_PROBES.vorbis).then((decodes) => {
		if (!decodes) {
			audioDecodingStalled = audioDecodingResponds().then(responds => !responds);
		}
		return decodes;
	});
};

describe('Conversion matrix, FLAC', () => {
	for (const matrixInput of MATRIX_INPUTS) {
		if (matrixInput.audioCodec === null || matrixInput.audioCodec === 'vorbis') {
			continue;
		}

		test(matrixInput.id, async (context) => {
			if (!await flacRuns()) {
				context.skip('WebCodecs doesn\'t decode FLAC here');
			}
			const support = await getPlatformSupport();
			const inputSkipReason = getInputSkipReason(matrixInput, support);
			if (inputSkipReason !== null) {
				context.skip(`WebCodecs fails here on ${inputSkipReason}`);
			}

			const { bytes, view, cells } = await loadInput(matrixInput);
			const flacCells = [
				...cells.filter(cell => deferredCodecOf(cell, matrixInput.audioCodec) === 'flac'),
				...deferredAtRuntime.get(`flac ${matrixInput.id}`) ?? [],
			];

			const result = await runCells(bytes, view, flacCells, matrixInput, support, ['vorbis']);
			await reportSkips(result, context);
			expect(result.failures).toEqual([]);
		}, testTimeout(matrixInput));
	}
});

describe('Conversion matrix, Vorbis', () => {
	for (const matrixInput of MATRIX_INPUTS) {
		if (matrixInput.audioCodec !== 'vorbis') {
			continue;
		}

		test(matrixInput.id, async (context) => {
			if (!await vorbisRuns()) {
				context.skip('WebCodecs doesn\'t decode Vorbis here, or the page\'s audio decoding stalled');
			}
			const support = await getPlatformSupport();
			const inputSkipReason = getInputSkipReason(matrixInput, support);
			if (inputSkipReason !== null) {
				context.skip(`WebCodecs fails here on ${inputSkipReason}`);
			}

			const { bytes, view, cells } = await loadInput(matrixInput);
			const result = await runCells(bytes, view, cells, matrixInput, support, []);
			await reportSkips(result, context);
			expect(result.failures).toEqual([]);
		}, testTimeout(matrixInput));
	}

	// Cells of other inputs whose output audio turned out to be Vorbis
	test('Vorbis outputs', async (context) => {
		const deferred = MATRIX_INPUTS.filter(x => deferredAtRuntime.has(`vorbis ${x.id}`));
		if (deferred.length === 0) {
			return;
		}
		if (!await vorbisRuns()) {
			context.skip('WebCodecs doesn\'t decode Vorbis here, or the page\'s audio decoding stalled');
		}
		const support = await getPlatformSupport();

		const result: CellsResult = { failures: [], skipReasons: [], ran: 0 };
		for (const matrixInput of deferred) {
			const { bytes, view } = await loadInput(matrixInput);
			const cells = deferredAtRuntime.get(`vorbis ${matrixInput.id}`)!;
			const inputResult = await runCells(bytes, view, cells, matrixInput, support, []);
			result.failures.push(...inputResult.failures);
			result.skipReasons.push(...inputResult.skipReasons);
			result.ran += inputResult.ran;
		}
		await reportSkips(result, context);
		expect(result.failures).toEqual([]);
	}, FULL ? 1_800_000 : 300_000);
});
