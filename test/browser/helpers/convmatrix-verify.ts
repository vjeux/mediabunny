// Runs one conversion matrix cell and checks its output against a model of what Conversion should produce, by decoding
// the output and comparing frames (gray levels) and beeps with the decoded input.
import { ALL_FORMATS } from '../../../src/input-format.js';
import { Input } from '../../../src/input.js';
import { Output } from '../../../src/output.js';
import { BufferSource, CustomPathedSource } from '../../../src/source.js';
import { BufferTarget, PathedTarget } from '../../../src/target.js';
import {
	Conversion,
	ConversionAudioOptions,
	ConversionOptions,
	ConversionVideoOptions,
} from '../../../src/conversion.js';
import {
	AdtsOutputFormat,
	CmafOutputFormat,
	FlacOutputFormat,
	HlsOutputFormat,
	MkvOutputFormat,
	MovOutputFormat,
	Mp3OutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	OggOutputFormat,
	OutputFormat,
	WavOutputFormat,
	WebMOutputFormat,
} from '../../../src/output-format.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../../src/media-source.js';
import { AudioSample, VideoSample } from '../../../src/sample.js';
import { MetadataTags } from '../../../src/metadata.js';
import { analyzeInput, type MediaView } from './convmatrix-analysis.js';

export type OutputKey = 'mp4' | 'mp4-frag' | 'mov' | 'mkv' | 'webm' | 'ts' | 'ogg' | 'mp3' | 'adts' | 'flac' | 'wav'
	| 'hls-ts' | 'hls-cmaf';

export const AUDIO_ONLY_OUTPUTS: OutputKey[] = ['ogg', 'mp3', 'adts', 'flac', 'wav'];

const makeOutputFormat = (key: OutputKey): OutputFormat => {
	switch (key) {
		case 'mp4': return new Mp4OutputFormat();
		case 'mp4-frag': return new Mp4OutputFormat({ fastStart: 'fragmented' });
		case 'mov': return new MovOutputFormat();
		case 'mkv': return new MkvOutputFormat();
		case 'webm': return new WebMOutputFormat();
		case 'ts': return new MpegTsOutputFormat();
		case 'ogg': return new OggOutputFormat();
		case 'mp3': return new Mp3OutputFormat();
		case 'adts': return new AdtsOutputFormat();
		case 'flac': return new FlacOutputFormat();
		case 'wav': return new WavOutputFormat();
		case 'hls-ts': return new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat() });
		case 'hls-cmaf': return new HlsOutputFormat({ segmentFormat: new CmafOutputFormat() });
	}
};

export type VideoProcessPreset = 'identity' | 'async-identity' | 'drop-odd' | 'canvas';
export type AudioProcessPreset = 'identity' | 'async-identity' | 'split';

export type CellOptions = {
	video?: Omit<ConversionVideoOptions, 'process'> & { processPreset?: VideoProcessPreset };
	audio?: Omit<ConversionAudioOptions, 'process'> & { processPreset?: AudioProcessPreset };
	trim?: { start?: number; end?: number };
	copy?: ConversionOptions['copy'];
	/** Cancel once progress reaches this value. */
	cancelAt?: number;
	/** Run with `execute({ until })` in steps of this many seconds. */
	stepwise?: number;
	/** Run twice and compare the output bytes. */
	repeat?: boolean;
};

export type Cell = {
	id: string;
	input: string;
	output: OutputKey;
	options: CellOptions;
};

const makeVideoProcess = (preset: VideoProcessPreset) => {
	switch (preset) {
		case 'identity': return (sample: VideoSample) => sample;
		case 'async-identity': return async (sample: VideoSample) => {
			await new Promise(resolve => setTimeout(resolve, 0));
			return sample;
		};
		case 'drop-odd': {
			let n = 0;
			return (sample: VideoSample) => (n++ % 2 === 1 ? null : sample);
		}
		case 'canvas': {
			// The encoder then gets a canvas showing the frame instead of the sample
			let canvas: OffscreenCanvas | null = null;
			return (sample: VideoSample) => {
				canvas ??= new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
				const context = canvas.getContext('2d')!;
				context.clearRect(0, 0, canvas.width, canvas.height);
				sample.draw(context, 0, 0);
				return canvas;
			};
		}
	}
};

const makeAudioProcess = (preset: AudioProcessPreset) => {
	switch (preset) {
		case 'identity': return (sample: AudioSample) => sample;
		case 'async-identity': return async (sample: AudioSample) => {
			await new Promise(resolve => setTimeout(resolve, 0));
			return sample;
		};
		case 'split': return (sample: AudioSample) => {
			if (sample.numberOfFrames < 2) {
				return sample;
			}
			const half = Math.floor(sample.numberOfFrames / 2);
			return [sample.trim(0, half), sample.trim(half, sample.numberOfFrames)];
		};
	}
};

const buildConversionOptions = (options: CellOptions) => {
	const result: Omit<ConversionOptions, 'input' | 'output'> = { showWarnings: false };
	if (options.video) {
		const { processPreset, ...rest } = options.video;
		result.video = processPreset ? { ...rest, process: makeVideoProcess(processPreset) } : rest;
	}
	if (options.audio) {
		const { processPreset, ...rest } = options.audio;
		result.audio = processPreset ? { ...rest, process: makeAudioProcess(processPreset) } : rest;
	}
	if (options.trim) {
		result.trim = options.trim;
	}
	if (options.copy !== undefined) {
		result.copy = options.copy;
	}
	if (options.repeat) {
		// Muxers write the current time otherwise
		result.tags = (tags: MetadataTags) => ({ ...tags, creationTime: null });
	}
	return result;
};

export type RunResult = {
	error: string | null;
	isValid: boolean | null;
	discarded: string[];
	copied: { video: boolean | null; audio: boolean | null };
	outputCodecs: { video: string | null; audio: string | null };
	progress: number[];
	/** Whether the cell's `cancelAt` was reached, so that cancel() got called. */
	cancelRequested: boolean;
	/** Set when the output's audio codec was one of `deferAudioCodecs`, so the cell wasn't run. */
	deferredCodec: string | null;
	conversionState: string | null;
	outputState: string | null;
	startTimestamp: number;
	timestampOffset: number | null;
	view: MediaView | null;
	outputBytes: Uint8Array | null;
};

/**
 * Runs a cell. With `deferAudioCodecs`, a cell whose output audio would use one of these codecs isn't executed, for
 * running later (decoding it can stall the page's audio decoding on some platforms).
 */
export const runCell = async (
	inputBytes: Uint8Array,
	cell: Cell,
	deferAudioCodecs: string[] = [],
): Promise<RunResult> => {
	const result: RunResult = {
		error: null,
		isValid: null,
		discarded: [],
		copied: { video: null, audio: null },
		outputCodecs: { video: null, audio: null },
		progress: [],
		cancelRequested: false,
		deferredCodec: null,
		conversionState: null,
		outputState: null,
		startTimestamp: 0,
		timestampOffset: null,
		view: null,
		outputBytes: null,
	};

	using input = new Input({ source: new BufferSource(inputBytes), formats: ALL_FORMATS });
	const pathed = cell.output.startsWith('hls');
	const files = new Map<string, Uint8Array>();
	const target = pathed
		? new PathedTarget('master.m3u8', ({ path }) => {
			const fileTarget = new BufferTarget();
			fileTarget.on('finalized', () => {
				files.set(path, new Uint8Array(fileTarget.buffer!));
			});
			return fileTarget;
		})
		: new BufferTarget();
	const output = new Output({ format: makeOutputFormat(cell.output), target });
	let conversion: Conversion | null = null;
	const recordStates = () => {
		result.conversionState = conversion?.state ?? null;
		result.outputState = output.state;
	};

	try {
		conversion = await Conversion.init({ input, output, ...buildConversionOptions(cell.options) });
		result.isValid = conversion.isValid;
		result.discarded = conversion.discardedTracks.map(x => `${x.track.type}: ${x.reason}`);
		for (const track of output.tracks) {
			if (track.type === 'video') {
				result.copied.video = track.source instanceof EncodedVideoPacketSource;
				result.outputCodecs.video = track.source._codec;
			} else if (track.type === 'audio') {
				result.copied.audio = track.source instanceof EncodedAudioPacketSource;
				result.outputCodecs.audio = track.source._codec;
			}
		}
		result.startTimestamp = conversion._startTimestamp;
		if (result.outputCodecs.audio !== null && deferAudioCodecs.includes(result.outputCodecs.audio)) {
			result.deferredCodec = result.outputCodecs.audio;
			return result;
		}
		conversion.onProgress = (progress) => {
			result.progress.push(progress);
			if (cell.options.cancelAt !== undefined && progress >= cell.options.cancelAt && !result.cancelRequested) {
				result.cancelRequested = true;
				void conversion!.cancel();
			}
		};
		if (!conversion.isValid) {
			recordStates();
			return result;
		}

		if (cell.options.stepwise) {
			let until = cell.options.stepwise;
			while (conversion.state !== 'done') {
				await conversion.execute({ until });
				until += cell.options.stepwise;
				if (until > 1000) {
					throw new Error('Stepwise execution does not finish.');
				}
			}
		} else {
			await conversion.execute();
		}
		result.timestampOffset = conversion._timestampOffset;
	} catch (error) {
		result.error = String(error);
		recordStates();
		return result;
	}
	recordStates();

	if (!pathed) {
		result.outputBytes = new Uint8Array((target as BufferTarget).buffer!);
	}
	using outputInput = pathed
		? new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(files.get(path)!)),
			formats: ALL_FORMATS,
		})
		: new Input({ source: new BufferSource(result.outputBytes!), formats: ALL_FORMATS });
	try {
		result.view = await analyzeInput(outputInput);
	} catch (error) {
		result.error = `Reading the output: ${String(error)}`;
	}

	return result;
};

// ---- Expectations ----

export type Issue = { kind: string; detail: string };

const median = (values: number[]) => {
	if (values.length === 0) {
		return NaN;
	}
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
};

// Channel mixing matrices, [target][source], following the Web Audio "speakers" rules that Mediabunny's resampler uses
const MIX: Record<string, number[][]> = {
	'1>2': [[1], [1]],
	'1>6': [[0], [0], [1], [0], [0], [0]],
	'2>1': [[0.5, 0.5]],
	'2>6': [[1, 0], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0]],
	'6>1': [[Math.SQRT1_2, Math.SQRT1_2, 1, 0, 0.5, 0.5]],
	'6>2': [[1, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 0], [0, 1, Math.SQRT1_2, 0, 0, Math.SQRT1_2]],
};

const expectedAmplitudes = (source: number[], targetChannels: number) => {
	if (source.length === targetChannels) {
		return source;
	}
	const matrix = MIX[`${source.length}>${targetChannels}`];
	if (!matrix) {
		// Discrete
		return Array.from({ length: targetChannels }, (_, c) => source[c] ?? 0);
	}
	return matrix.map(row => row.reduce((sum, weight, c) => sum + weight * source[c]!, 0));
};

const LOSSLESS_CODECS = ['flac', 'pcm-s16', 'pcm-s24', 'pcm-s32', 'pcm-f32', 'pcm-u8', 'pcm-s16be', 'pcm-s24be',
	'pcm-s32be', 'pcm-f32be', 'pcm-f64', 'pcm-f64be'];

/** Checks of the output audio that don't need the beeps: format, gaps and where it ends. */
type AddIssue = (kind: string, detail: string) => void;

const checkAudioFormat = (cell: Cell, inView: MediaView, run: RunResult, add: AddIssue) => {
	const options = cell.options;
	const out = run.view!.audio!;
	const inAudio = inView.audio!;
	const S = run.startTimestamp;
	const E = options.trim?.end ?? Infinity;

	// Matroska stores millisecond timestamps, so packet boundaries round by up to half a millisecond
	const msTimestamps = cell.output === 'mkv' || cell.output === 'webm';
	const gaps = out.discontinuities.filter(d => !msTimestamps || Math.abs(d.delta) > 0.0006);
	if (gaps.length > 0) {
		add('audio-gaps', `${gaps.length} gaps or overlaps, first ${(gaps[0]!.delta * 1000).toFixed(3)} ms`);
	}

	const requestedRate = options.audio?.sampleRate;
	// Opus always decodes at 48 kHz, and MP3 goes up to 48 kHz (the fallback rate)
	const wantRate = out.codec === 'mp3' && requestedRate !== undefined && requestedRate > 48000
		? 48000
		: requestedRate;
	if (wantRate && out.decodedSampleRate !== wantRate && out.codec !== 'opus') {
		add('audio-sample-rate', `${out.decodedSampleRate} Hz, requested ${requestedRate} Hz`);
	}
	const wantChannels = options.audio?.numberOfChannels ?? inAudio.decodedNumberOfChannels!;
	// Encoders that can't take the channel count fall back to stereo (documented)
	const fallback = out.decodedNumberOfChannels === 2 && wantChannels > 2;
	if (out.decodedNumberOfChannels !== wantChannels && !fallback) {
		add('audio-channels', `${out.decodedNumberOfChannels} channels, expected ${wantChannels}`);
	}

	// The audio ends with the input or the trim (copies by whole packets, MP3 by whole frames)
	if (inAudio.endTimestamp !== null && out.endTimestamp !== null && !cell.output.startsWith('hls')) {
		const expectedEnd = Math.min(E, inAudio.endTimestamp) - S;
		const actualEnd = out.endTimestamp - (run.timestampOffset ?? -S) - S;
		const packetDuration = Math.max(0, ...inAudio.packets.map(p => p[1]));
		const tolerance = run.copied.audio
			? packetDuration + 0.001
			: (run.outputCodecs.audio === 'mp3' ? 0.15 : 0.05);
		if (Math.abs(actualEnd - expectedEnd) > tolerance) {
			add('audio-end', `Audio ends at ${actualEnd.toFixed(3)} s, expected ${expectedEnd.toFixed(3)} s`);
		}
	}
};

/**
 * Checks a cell's output against the input. Copied video is modeled on Conversion's packet loop, transcoded video on
 * its frame selection and frame rate normalization; every beep wholly inside the trim range must come out at its
 * input time minus the trim start. Without `markers` (inputs that aren't from the generator), frame contents and
 * beeps aren't checked.
 */
export const verifyCell = (cell: Cell, inView: MediaView, run: RunResult, markers = true): Issue[] => {
	const issues: Issue[] = [];
	const add = (kind: string, detail: string) => issues.push({ kind, detail });
	const options = cell.options;

	if (options.cancelAt !== undefined) {
		// A cancellation needs evidence: the conversion ran, cancel() got called, execute() rejected, and both the
		// conversion and the output ended up canceled. execute() is documented to throw a ConversionCanceledError, but
		// on main a sample still being added when the output gets canceled throws "Output has been canceled." first
		// (upstream's bug-fix-mania branch fixes that).
		if (!run.isValid) {
			add('invalid', run.discarded.join(', '));
		} else if (!run.cancelRequested) {
			add('cancel', `Progress never reached ${options.cancelAt}, so the conversion was never canceled`);
		} else if (!run.error) {
			add('cancel', 'execute() resolved although the conversion was canceled');
		} else if (!/ConversionCanceledError|has been canceled/.test(run.error)) {
			add('cancel', run.error);
		} else if (run.conversionState !== 'canceled' || run.outputState !== 'canceled') {
			add('cancel', `The conversion ended up ${run.conversionState} and the output ${run.outputState}`);
		}
		return issues;
	}
	if (run.error) {
		add('error', run.error);
		return issues;
	}
	if (!run.isValid) {
		add('invalid', run.discarded.join(', '));
		return issues;
	}
	const view = run.view!;

	const S = run.startTimestamp;
	const E = options.trim?.end ?? Infinity;
	const timestampTolerance = cell.output === 'mkv' || cell.output === 'webm' ? 1.1e-3 : 2e-4;
	const allowShift = (typeof options.copy === 'object' && (options.copy.shiftTolerance ?? 0) > 0)
		// HLS shifts all media so the first packet added lands on mediaTimestampBase
		|| cell.output.startsWith('hls');

	// ---- Video ----
	let videoOffset: number | null = null;
	if (run.copied.video !== null && inView.video) {
		const out = view.video;
		const inFrames = inView.video.frames;
		const frameRate = options.video?.frameRate;
		const process = options.video?.processPreset;
		// Each expected frame: its output timestamp, the input frame's gray level (null: don't check) and whether
		// that input frame is opaque
		let expected: { timestamp: number; level: number | null; opaque: boolean }[] = [];
		const opaque = (alpha: number) => alpha > 200;

		if (run.copied.video) {
			// Conversion's packet loop: decode order from the last verified key packet at or before the start;
			// 'expand' goes on past the end while one of the next 6 packets is still before it (B-frames)
			const policy = (typeof options.copy === 'object' && options.copy.boundaryPolicy) || 'expand';
			const timestamps = inView.video.packetTimestamps;
			const keys = inView.video.verifiedKeyPacketTimestamps;
			const keysBefore = keys.filter(t => t <= S + 1e-9);
			let startKey = keysBefore.length > 0 ? keysBefore.at(-1)! : keys[0]!;
			const frameDuration = inFrames.find(f => Math.abs(f.timestamp - startKey) < 1e-6)?.duration ?? 0;
			if (policy === 'shrink' && startKey < S - 1e-9 && startKey + frameDuration <= S + 1e-9) {
				startKey = keys[keys.indexOf(startKey) + 1] ?? Infinity;
			}
			const included: number[] = [];
			const startIndex = timestamps.findIndex(t => Math.abs(t - startKey) < 1e-9);
			for (let i = startIndex; i >= 0 && i < timestamps.length; i++) {
				const t = timestamps[i]!;
				if (t >= E - 1e-9) {
					if (policy === 'shrink' || !timestamps.slice(i + 1, i + 7).some(x => x < E - 1e-9)) {
						break;
					}
				}
				included.push(t);
			}
			included.sort((a, b) => a - b);
			for (const t of included) {
				const frame = inFrames.find(f => Math.abs(f.timestamp - t) < 1e-6);
				expected.push({
					timestamp: (policy === 'shrink' ? Math.max(t, S) : t) - S,
					level: frame?.level ?? null,
					opaque: opaque(frame?.alpha ?? 255),
				});
			}
		} else if (frameRate) {
			// The encoder's frame rate normalization: the first frame starting in a slot is encoded there, later
			// ones in the same slot only replace the frame that pads the next gap, and padding runs up to the slot
			// the last frame ends in. Slots get a tolerance for float error (fork PR #10 does the same).
			const slotOf = (t: number) => Math.floor(t * frameRate + 1e-6);
			const frames = inFrames
				.map(f => ({
					start: Math.max(f.timestamp, S) - S,
					end: Math.min(f.timestamp + f.duration, E) - S,
					level: f.level,
					opaque: opaque(f.alpha),
				}))
				.filter(f => f.end - f.start > 1e-9);
			let lastSlot: number | null = null;
			let lastFrame = frames[0];
			const pad = (untilSlot: number) => {
				for (let k = lastSlot! + 1; k < untilSlot; k++) {
					expected.push({ timestamp: k / frameRate, level: lastFrame!.level, opaque: lastFrame!.opaque });
				}
			};
			for (const frame of frames) {
				const slot = slotOf(frame.start);
				if (lastSlot === null || slot > lastSlot) {
					if (lastSlot !== null) {
						pad(slot);
					}
					expected.push({ timestamp: slot / frameRate, level: frame.level, opaque: frame.opaque });
					lastSlot = slot;
				}
				lastFrame = frame;
			}
			if (lastSlot !== null) {
				pad(slotOf(frames.at(-1)!.end));
			}
		} else {
			for (const frame of inFrames) {
				const start = Math.max(frame.timestamp, S);
				const end = Math.min(frame.timestamp + frame.duration, E);
				if (end - start > 1e-9) {
					expected.push({ timestamp: start - S, level: frame.level, opaque: opaque(frame.alpha) });
				}
			}
			if (process === 'drop-odd') {
				expected = expected.filter((_, i) => i % 2 === 0);
			}
		}

		if (!out) {
			// A trim range without frames (or without a key frame, with 'shrink') leaves an empty track, which the
			// muxers leave out
			if (expected.length > 0) {
				add('video-missing', 'The output has no video track');
			}
		} else if (out.decodeError) {
			add('video-decode', out.decodeError);
		} else {
			const outFrames = out.frames;
			if (outFrames.length !== expected.length) {
				add('video-count', `${outFrames.length} frames, expected ${expected.length}`);
			}
			const n = Math.min(outFrames.length, expected.length);
			const offsets: number[] = [];
			for (let i = 0; i < n; i++) {
				offsets.push(outFrames[i]!.timestamp - expected[i]!.timestamp);
			}
			videoOffset = median(offsets);
			let timestampMismatches = 0;
			let levelMismatches = 0;
			let repeatedFrames = 0;
			for (let i = 0; i < n; i++) {
				if (Math.abs(outFrames[i]!.timestamp - expected[i]!.timestamp - videoOffset) > timestampTolerance) {
					timestampMismatches++;
				}
				// The gray level of a translucent frame depends on how its alpha is kept, discarded (showing what the
				// encoder stored under it) or blended, so only opaque frames are compared (the alpha check covers the
				// rest)
				const level = expected[i]!.level;
				if (markers && level !== null && expected[i]!.opaque && outFrames[i]!.level !== level) {
					// Chrome's VP9 encoder with a per-frame quantizer sometimes doesn't update a flat frame after a big
					// change in brightness, so the decoded frame repeats the previous one (plain WebCodecs does the
					// same). Frames that show no generator level at all (blank, garbled) never count as such.
					const stale = !run.copied.video && run.outputCodecs.video === 'vp9' && i > 0
						&& outFrames[i]!.level >= 0 && outFrames[i]!.level === outFrames[i - 1]!.level;
					if (stale) {
						repeatedFrames++;
					} else {
						levelMismatches++;
					}
				}
			}
			if (Math.abs(videoOffset) > timestampTolerance && !allowShift) {
				add('video-offset', `Video timeline shifted by ${(videoOffset * 1000).toFixed(2)} ms`);
			}
			if (timestampMismatches > 0) {
				add('video-timestamps', `${timestampMismatches} of ${n} frames off the expected timestamps`);
			}
			// Realtime encoders occasionally leave a flat frame partially updated (mostly after a big change); copies
			// must be exact
			const allowedMismatches = run.copied.video ? 0 : Math.max(2, Math.ceil(0.04 * n));
			if (levelMismatches > allowedMismatches) {
				add('video-content', `${levelMismatches} of ${n} frames show another input frame`);
			}
			if (repeatedFrames > Math.ceil(0.2 * n)) {
				add('video-content', `${repeatedFrames} of ${n} frames repeat the previous frame instead of a new one`);
			}
			if (out.firstPacketIsKey === false) {
				add('video-key', 'The first packet is not a key packet');
			}

			// Dimensions: rotate, then crop (clamped to the frame), then resize to even sizes
			let [width, height] = (options.video?.rotate ?? 0) % 180 === 0
				? [inView.video.displayWidth, inView.video.displayHeight]
				: [inView.video.displayHeight, inView.video.displayWidth];
			const crop = options.video?.crop;
			if (crop) {
				const left = Math.min(Math.max(crop.left, 0), width);
				const top = Math.min(Math.max(crop.top, 0), height);
				width = Math.min(crop.width, width - left);
				height = Math.min(crop.height, height - top);
			}
			const ceilToEven = (x: number) => Math.ceil(x / 2) * 2;
			const aspect = width / height;
			const requestedWidth = options.video?.width;
			const requestedHeight = options.video?.height;
			if (requestedWidth !== undefined && requestedHeight === undefined) {
				width = ceilToEven(requestedWidth);
				height = ceilToEven(Math.round(width / aspect));
			} else if (requestedWidth === undefined && requestedHeight !== undefined) {
				height = ceilToEven(requestedHeight);
				width = ceilToEven(Math.round(height * aspect));
			} else if (requestedWidth !== undefined && requestedHeight !== undefined) {
				width = ceilToEven(requestedWidth);
				height = ceilToEven(requestedHeight);
			}
			if (out.displayWidth !== width || out.displayHeight !== height) {
				add('video-dimensions', `${out.displayWidth}x${out.displayHeight}, expected ${width}x${height}`);
			}

			// Transparency survives only with alpha: 'keep' (through a transcode), else frames are opaque
			const inAlpha = inFrames.some(f => f.alpha < 200);
			const keepAlpha = options.video?.alpha === 'keep' && inAlpha;
			if (!run.copied.video) {
				let alphaMismatches = 0;
				for (let i = 0; i < n; i++) {
					const source = inFrames.find(f => Math.abs(f.timestamp - (expected[i]!.timestamp + S)) < 1e-3);
					const want = keepAlpha && source ? source.alpha : 255;
					if (Math.abs(outFrames[i]!.alpha - want) > 24) {
						alphaMismatches++;
					}
				}
				if (alphaMismatches > 0) {
					add('video-alpha', `${alphaMismatches} of ${n} frames with the wrong alpha`);
				}
			}

			// Key frames: at most keyFrameInterval apart (the encoders' default is 2 s)
			if (!run.copied.video && outFrames.length > 1) {
				const interval = options.video?.keyFrameInterval ?? 2;
				const keys = [...out.keyPacketTimestamps].sort((a, b) => a - b);
				if (interval === 0) {
					if (keys.length !== out.packetCount) {
						add('video-key-frames', `${keys.length} key frames among ${out.packetCount} packets`);
					}
				} else {
					const gaps = keys.slice(1).map((k, i) => k - keys[i]!);
					gaps.push(outFrames.at(-1)!.timestamp - keys.at(-1)!);
					const frameDuration = median(outFrames.map(f => f.duration));
					if (Math.max(...gaps) > interval + frameDuration + 1e-6) {
						add('video-key-frames', `Key frames up to ${Math.max(...gaps).toFixed(3)} s apart`);
					}
				}
			}
		}
	}

	// ---- Audio ----
	if (run.copied.audio !== null && inView.audio) {
		const out = view.audio;
		const policy = (typeof options.copy === 'object' && options.copy.boundaryPolicy) || 'expand';
		// Copies keep whole packets: with 'shrink', only those wholly inside the trim range
		let keptStart = S;
		let keptEnd = E;
		if (run.copied.audio && policy === 'shrink') {
			const kept = inView.audio.packets.filter(([t, d]) => t >= S - 1e-9 && t + d <= E + 1e-9);
			keptStart = kept.length > 0 ? Math.min(...kept.map(([t]) => t)) : Infinity;
			keptEnd = kept.length > 0 ? Math.max(...kept.map(([t, d]) => t + d)) : -Infinity;
		}
		// A trim range that misses the audio leaves an empty track, which the muxers leave out
		const audioInRange = (inView.audio.firstTimestamp ?? Infinity) < E - 1e-3
			&& (inView.audio.endTimestamp ?? -Infinity) > S + 1e-3;
		if (!out) {
			if (keptStart < keptEnd && audioInRange) {
				add('audio-missing', 'The output has no audio track');
			}
		} else if (out.decodeError) {
			add('audio-decode', out.decodeError);
		} else if (run.copied.audio && policy === 'shrink' && ['opus', 'aac', 'mp3', 'vorbis'].includes(out.codec!)) {
			// Without the decoder pre-roll that 'shrink' leaves out, these decoders start with a burst of noise that
			// drowns the beeps, so only the format and the extent are checked
			checkAudioFormat(cell, inView, run, add);
		} else if (!markers) {
			checkAudioFormat(cell, inView, run, add);
		} else {
			const required = inView.audio.beeps.filter(
				b => b.time >= keptStart + 0.003 && b.time + 0.02 <= keptEnd - 0.003,
			);
			const outBeeps = out.beeps;
			// A shifted timeline moves the audio with the video; without video, take the most common offset between
			// output and expected beeps of the same frequency (to 10 ms)
			let shiftGuess = 0;
			if (allowShift && videoOffset !== null) {
				shiftGuess = videoOffset;
			} else if (allowShift) {
				const votes = new Map<number, number>();
				for (const outBeep of outBeeps) {
					for (const beep of required) {
						if (outBeep.k8 === beep.k8) {
							const offset = Math.round((outBeep.time - (beep.time - S)) * 100) / 100;
							votes.set(offset, (votes.get(offset) ?? 0) + 1);
						}
					}
				}
				let bestVotes = 0;
				for (const [offset, count] of votes) {
					if (count > bestVotes || (count === bestVotes && Math.abs(offset) < Math.abs(shiftGuess))) {
						bestVotes = count;
						shiftGuess = offset;
					}
				}
			}
			const deltas: number[] = [];
			const matched = new Set<number>();
			let missing = 0;
			let wrongBeeps = 0;
			for (const beep of required) {
				const want = beep.time - S + shiftGuess;
				let best = -1;
				for (let i = 0; i < outBeeps.length; i++) {
					const distance = Math.abs(outBeeps[i]!.time - want);
					if (distance < 0.06 && (best === -1 || distance < Math.abs(outBeeps[best]!.time - want))) {
						best = i;
					}
				}
				if (best === -1) {
					missing++;
					continue;
				}
				matched.add(best);
				deltas.push(outBeeps[best]!.time - (beep.time - S));
				if (outBeeps[best]!.k8 !== beep.k8 && outBeeps[best]!.k8 !== -1 && beep.k8 !== -1) {
					wrongBeeps++;
				}
			}
			if (missing > 0) {
				add('audio-beeps', `${missing} of ${required.length} beeps inside the trim range are missing`);
			}
			if (wrongBeeps > 0) {
				add('audio-beeps', `${wrongBeeps} beeps come out in the wrong place`);
			}
			// Copies keep whole packets and the decoder pre-roll before the start (Mediabunny takes 400 ms for Opus)
			const packetDuration = Math.max(0, ...inView.audio.packets.map(p => p[1]));
			const preRoll = run.copied.audio && policy === 'expand'
				? packetDuration + (out.codec === 'opus' ? 0.4 : out.codec === 'mp3' ? 0.3 : 0.05)
				: 0.005;
			const extra = outBeeps.filter((beep, i) => {
				const t = beep.time - shiftGuess;
				return !matched.has(i) && (t < -preRoll || t > E - S + preRoll);
			});
			// (A shift can only be told from the beeps that should be there)
			if (extra.length > 0 && !(allowShift && videoOffset === null && required.length === 0)) {
				const first = extra[0]!.time.toFixed(3);
				add('audio-beeps', `${extra.length} beeps outside the trim range, first at ${first}`);
			}

			const audioOffset = median(deltas);
			const spread = deltas.length > 0 ? Math.max(...deltas) - Math.min(...deltas) : 0;
			if (spread > 0.002) {
				add('audio-drift', `Beep offsets spread over ${(spread * 1000).toFixed(2)} ms`);
			}
			// ADTS can't signal encoder priming, so transcoded AAC starts one frame late there (FFmpeg alike)
			const adtsPriming = cell.output === 'adts'
				&& Math.abs(audioOffset - 1024 / out.decodedSampleRate!) < 0.0015;
			if (Math.abs(audioOffset) > 0.0015 && !allowShift && !adtsPriming) {
				add('audio-offset', `Audio timeline shifted by ${(audioOffset * 1000).toFixed(2)} ms`);
			}
			if (videoOffset !== null && Number.isFinite(audioOffset) && Math.abs(videoOffset - audioOffset) > 0.0025) {
				add('av-sync', `Audio moved ${((audioOffset - videoOffset) * 1000).toFixed(2)} ms against the video`);
			}

			checkAudioFormat(cell, inView, run, add);

			if (deltas.length > 2 && !options.audio?.processPreset) {
				const inChannels = inView.audio.decodedNumberOfChannels!;
				const targetChannels = out.decodedNumberOfChannels!;
				const inAmplitudes = Array.from(
					{ length: inChannels },
					(_, c) => median(inView.audio!.beeps.slice(1).map(b => b.amplitudes[c] ?? 0)),
				);
				const wantAmplitudes = expectedAmplitudes(inAmplitudes, targetChannels);
				const lossless = LOSSLESS_CODECS.includes(out.codec ?? '');
				for (let c = 0; c < targetChannels; c++) {
					const measured = median(outBeeps.slice(1).map(b => b.amplitudes[c] ?? 0));
					const want = wantAmplitudes[c]!;
					if (Math.abs(measured - want) > (lossless ? 0.03 * want + 0.01 : 0.25 * want + 0.02)) {
						add('audio-level', `Channel ${c} at ${measured.toFixed(3)}, expected ${want.toFixed(3)}`);
						break;
					}
				}
			}
		}
	}

	// ---- Progress ----
	for (let i = 1; i < run.progress.length; i++) {
		if (run.progress[i]! < run.progress[i - 1]! - 1e-9) {
			add('progress', `Progress went back from ${run.progress[i - 1]} to ${run.progress[i]}`);
			break;
		}
	}
	if (run.progress.length > 0 && Math.abs(run.progress.at(-1)! - 1) > 1e-9) {
		add('progress', `Progress ended at ${run.progress.at(-1)}`);
	}

	return issues;
};
