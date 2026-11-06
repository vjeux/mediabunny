import { describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import {
	AudioBufferSink,
	AudioSampleSink,
	CanvasSink,
	EncodedPacketSink,
	VideoSampleSink,
} from '../../src/media-sink.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { assert } from '../../src/misc.js';

// Checks that every sink lookup returns exactly the right decoded frame or audio, across hard real-world structures.
//
// The video fixtures are 64x64 and every frame shows its index as a 4x4 grid of 16x16 cells (bit b in cell b, white
// = 1), so a decoded frame is identified by its pixels, independently of its timestamp. They were made with FFmpeg 8.0:
// ffmpeg -f lavfi -i "color=s=64x64:r=30:d=2,format=yuv420p,
//   geq=lum='if(bitand(N\,pow(2\,floor(X/16)+4*floor(Y/16)))\,235\,16)':cb=128:cr=128" <options> <file>
// with these options, where x264(P) is -c:v libx264 -preset veryfast -crf 18 -x264-params P and
// BF3 is keyint=30:min-keyint=30:scenecut=0:bframes=3:b-adapt=0:b-pyramid=normal:
//   seek-avc-bframes.mp4         x264(BF3)
//   seek-avc-negative-cts.mp4    x264(BF3) -movflags negative_cts_offsets (ctts v1)
//   seek-avc-bframes16.mp4       d=3, x264(keyint=45:min-keyint=45:scenecut=0:bframes=16:b-adapt=0:b-pyramid=normal)
//   seek-avc-open-gop.mkv        x264(keyint=30:min-keyint=30:scenecut=0:bframes=3:b-adapt=0:open-gop=1)
//   seek-avc-intra-refresh.mp4   x264(keyint=30:scenecut=0:bframes=0:intra-refresh=1) (one IDR, then recovery points)
//   seek-avc-bframes.mkv         x264(BF3) (with Cues)
//   seek-avc-live.mkv            x264(BF3) -live 1 -f matroska (no Cues, unknown sizes)
//   seek-avc-small-clusters.mkv  x264(BF3) -cluster_time_limit 100 -cluster_size_limit 200 (clusters cut mid-GOP)
//   seek-avc-bframes.ts          x264(BF3)
//   seek-avc-pts-wrap.ts         x264(BF3) -output_ts_offset 95441 (the PTS wraps around 2^33 mid-file)
//   seek-avc-fragmented.mp4      x264(BF3) -movflags frag_keyframe+empty_moov+default_base_moof
//   seek-avc-ntsc.mp4            r=30000/1001, x264(BF3)
//   seek-avc-23.976.mkv          r=24000/1001,
//                                x264(keyint=24:min-keyint=24:scenecut=0:bframes=3:b-adapt=0:b-pyramid=normal)
//   seek-avc-vfr.mkv             -vf "settb=1/1000,
//                                setpts='(N*33+if(eq(mod(N\,5)\,2)\,9\,0)+if(eq(mod(N\,7)\,3)\,-7\,0))/1000/TB'"
//                                -fps_mode passthrough -enc_time_base 1/1000 x264(BF3)
//   seek-avc-delayed.mp4         x264(BF3) -output_ts_offset 1 (empty edit, starts at 1 s)
//   seek-avc-copy-cut.mp4        d=3, x264(BF3), then -ss 1.5 -c copy (edit list starting mid-GOP)
//   seek-avc-mbaff.mp4           x264(keyint=30:min-keyint=30:scenecut=0:bframes=2:b-adapt=0:interlaced=1:tff=1)
//   seek-vp8.webm                -c:v libvpx -b:v 200k -g 30
//   seek-vp9-altref.webm         -c:v libvpx-vp9 -b:v 200k -g 30, two-pass (hidden alt-ref frames in superframes)
//   seek-av1.mp4, seek-av1.webm  -c:v libaom-av1 -cpu-used 8 -crf 30 -g 30 (show_existing_frame overlays)
// The expected timelines below match FFmpeg's decode of these files (frame index read from the pixels).

type Frame = { index: number; timestamp: number };

const cfr = (
	count: number,
	fps: number,
	{ start = 0, firstIndex = 0, fpsDen = 1, milliseconds = false } = {},
): Frame[] => Array.from({ length: count }, (_, i) => ({
	index: firstIndex + i,
	// Matroska rounds timestamps to whole milliseconds
	timestamp: milliseconds
		? Math.round(start * 1000 + i * 1000 * fpsDen / fps) / 1000
		: start + i * fpsDen / fps,
}));

const vfrFrames = Array.from({ length: 60 }, (_, i) => ({
	index: i,
	// setpts truncates its result to whole ticks
	timestamp: Math.trunc((33 * i + (i % 5 === 2 ? 9 : 0) + (i % 7 === 3 ? -7 : 0)) / 1000 / (1 / 1000)) / 1000,
})).sort((a, b) => a.timestamp - b.timestamp);

type VideoCase = {
	file: string;
	codec: ProbedCodec;
	frames: Frame[];
	/** Mediabunny hands the decoder timestamps below zero (pre-roll before an edit, a wrapped PTS). */
	negativeTimestamps?: boolean;
	/** Decoding can start at the recovery point of an open GOP (where the platform allows it). */
	openGop?: boolean;
};

const ms = { milliseconds: true };
const videoCases: VideoCase[] = [
	{ file: 'seek-avc-bframes.mp4', codec: 'avc', frames: cfr(60, 30) },
	{ file: 'seek-avc-negative-cts.mp4', codec: 'avc', frames: cfr(60, 30) },
	{ file: 'seek-avc-bframes16.mp4', codec: 'avc', frames: cfr(90, 30) },
	{ file: 'seek-avc-open-gop.mkv', codec: 'avc', frames: cfr(60, 30, ms), openGop: true },
	{ file: 'seek-avc-intra-refresh.mp4', codec: 'avc', frames: cfr(60, 30) },
	{ file: 'seek-avc-bframes.mkv', codec: 'avc', frames: cfr(60, 30, ms) },
	{ file: 'seek-avc-live.mkv', codec: 'avc', frames: cfr(60, 30, ms) },
	{ file: 'seek-avc-small-clusters.mkv', codec: 'avc', frames: cfr(60, 30, ms) },
	{ file: 'seek-avc-bframes.ts', codec: 'avc', frames: cfr(60, 30, { start: 1.4 + 2 / 30 }) },
	{
		file: 'seek-avc-pts-wrap.ts',
		codec: 'avc',
		frames: cfr(60, 30, { start: -118592 / 90000 }),
		negativeTimestamps: true,
	},
	{ file: 'seek-avc-fragmented.mp4', codec: 'avc', frames: cfr(60, 30, { start: 2 / 30 }) },
	{ file: 'seek-avc-ntsc.mp4', codec: 'avc', frames: cfr(60, 30000, { fpsDen: 1001 }) },
	{ file: 'seek-avc-23.976.mkv', codec: 'avc', frames: cfr(48, 24000, { fpsDen: 1001, ...ms }) },
	{ file: 'seek-avc-vfr.mkv', codec: 'avc', frames: vfrFrames },
	{ file: 'seek-avc-delayed.mp4', codec: 'avc', frames: cfr(60, 30, { start: 1 }) },
	// The frames before the cut (indices 30 to 44) are kept at negative timestamps for decoding
	{ file: 'seek-avc-copy-cut.mp4', codec: 'avc', frames: cfr(45, 30, { firstIndex: 45 }), negativeTimestamps: true },
	{ file: 'seek-avc-mbaff.mp4', codec: 'avc', frames: cfr(60, 30) },
	{ file: 'seek-vp8.webm', codec: 'vp8', frames: cfr(60, 30, ms) },
	{ file: 'seek-vp9-altref.webm', codec: 'vp9', frames: cfr(60, 30, ms) },
	{ file: 'seek-av1.mp4', codec: 'av1', frames: cfr(60, 30) },
	{ file: 'seek-av1.webm', codec: 'av1', frames: cfr(60, 30, ms) },
];

const readFrameIndex = (rgba: Uint8Array | Uint8ClampedArray, stride: number) => {
	let index = 0;
	for (let bit = 0; bit < 16; bit++) {
		const cellX = (bit % 4) * 16;
		const cellY = Math.floor(bit / 4) * 16;

		// Average the middle of the cell, away from compression artifacts at the edges
		let sum = 0;
		for (let y = 4; y < 12; y++) {
			for (let x = 4; x < 12; x++) {
				sum += rgba[(cellY + y) * stride + (cellX + x) * 4]!;
			}
		}

		if (sum / 64 > 128) {
			index |= 1 << bit;
		}
	}

	return index;
};

// WebKitGTK's VideoFrame.copyTo() doesn't convert YUV frames to RGBA, so read decoded frames by drawing them there
// instead
const nativeYuvToRgbaWorks = await (async () => {
	const frame = new VideoFrame(new Uint8Array([235, 235, 235, 235, 128, 128]), {
		format: 'I420', codedWidth: 2, codedHeight: 2, timestamp: 0,
	});
	const rgba = new Uint8Array(16);
	await frame.copyTo(rgba, { format: 'RGBA' });
	frame.close();
	return rgba[3] === 255 && rgba[7] === 255;
})();

// WebKitGTK's GStreamer decoders scramble the timestamps that follow a negative one (they flip the playback direction
// of their segment), so there, files that start before zero can't be checked
const negativeTimestampsDecodeCorrectly = await (async () => {
	const timestamps: number[] = [];
	const decoder = new AudioDecoder({
		output: (data) => {
			timestamps.push(data.timestamp);
			data.close();
		},
		error: () => {},
	});
	decoder.configure({ codec: 'pcm-s16', sampleRate: 48000, numberOfChannels: 1 });
	for (const timestamp of [-20000, 0, 20000]) {
		decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: new Uint8Array(1920) }));
	}
	await decoder.flush();
	decoder.close();
	return timestamps.join() === '-20000,0,20000';
})();

// Whether the platform can decode a codec is decided with WebCodecs alone, on tiny known-good streams, never with
// Mediabunny (so that a Mediabunny failure on a capable platform fails instead of skipping). isConfigSupported() isn't
// enough: WebKitGTK says it decodes AV1 and FLAC but then doesn't, and bare Firefox says the same of AAC. Each probe is
// a decoder config and the first packets of 0.4 s of black 64x64 video or 0.1 s of mono silence, made by FFmpeg and
// read with ffprobe -show_streams -show_packets -show_data:
//   avc               -c:v libx264 -x264-params keyint=30:bframes=0 (.mp4; avcC, the IDR without its SEI)
//   avcRecoveryPoint  from seek-avc-open-gop.mkv below: its avcC, and its first recovery point I-frame (at 1 s)
//                     with the 7 packets after it in decode order (the first is a leading B-frame)
//   vp8, vp9          -c:v libvpx / libvpx-vp9 -b:v 50k (.webm)
//   av1               -c:v libaom-av1 -cpu-used 8 -crf 50 (-f obu, with its sequence header)
//   mp3               -c:a libmp3lame -b:a 32k -write_xing 0 (48 kHz)
//   aac               -c:a aac -b:a 32k (.m4a, 48 kHz)
//   opus              -c:a libopus -b:a 16k (.ogg)
//   flac              -c:a flac (16 kHz; "fLaC" + the STREAMINFO block)
type ProbedCodec = 'avc' | 'vp8' | 'vp9' | 'av1' | 'mp3' | 'aac' | 'opus' | 'flac';
type Probe = { codec: string; sampleRate?: number; description?: string; chunks: string[] };
const PLATFORM_PROBES: Record<ProbedCodec | 'avcRecoveryPoint', Probe> = {
	avc: {
		codec: 'avc1.64000a',
		description: 'AWQACv/hABZnZAAKrLQhNgIgAAADACAAAAeB4kTUAQAEaO8Py/34+AA=',
		chunks: ['AAAAImWIhAv/zfge5+dNGJXY/99lBqplGekvDAt4kBWRdmF/jqw='],
	},
	avcRecoveryPoint: {
		codec: 'avc1.64000a',
		description: 'AWQACv/hABhnZAAKrNlEJsBEAAADAAQAAAMA8DxIllgBAAVo74I8sP34+AA=',
		chunks: [
			'AAAABQYGAcSAAAAAQUGI/4DP4n8F3v7vuThbn27O1/qL5PGgLXffd3/Vei/PqrP9G7bB33udk1U8PvlMfZSGK65crXhfyPbD+gQLuhR4',
			'AAAAEQGeHUQn//AoNieOr9YU5LOA',
			'AAAAG0GaAjkyippYX//6mwkfeO+z1K35DE70QPOrpw==',
			'AAAAD0GeIEIX/3/H2jSsKPPcmg==',
			'AAAAEAGeX0Qn//AoNicsvKU7248=',
			'AAAAEAGeQUQn/+z0AG6JDrl0KKI=',
			'AAAADkGaRjRMQv/8Yvx3qzp0',
			'AAAAD0GeZEURLCf/kLBLHvNggA==',
		],
	},
	vp8: {
		codec: 'vp8',
		chunks: ['8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v+rUIA='],
	},
	vp9: {
		codec: 'vp09.00.10.08',
		chunks: ['gkmDQgAD8AP2ADgkHBhCAAAwYAAAZz///1mvETuzAA=='],
	},
	av1: {
		codec: 'av01.0.00M.08',
		chunks: ['EgAKCgAAAAKv/5tfIAgyDRAAuoAAAkAAAAPOF7o='],
	},
	mp3: {
		codec: 'mp3',
		sampleRate: 48000,
		chunks: [
			'//sUxAADwAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV'
			+ 'VVVVVVVVVVVVVVVVVVVVVVVVVVVV',
			'//sUxCWDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV'
			+ 'VVVVVVVVVVVVVVVVVVVVVVVVVVVV',
			'//sUxEsDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV'
			+ 'VVVVVVVVVVVVVVVVVVVVVVVVVVVV',
		],
	},
	aac: {
		codec: 'mp4a.40.2',
		sampleRate: 48000,
		description: 'EYhW5QA=',
		chunks: ['3gIATGF2YzYyLjExLjEwMwACMEAO', 'ARggBw==', 'ARggBw=='],
	},
	opus: {
		codec: 'opus',
		sampleRate: 48000,
		description: 'T3B1c0hlYWQBATgBgLsAAAAAAA==',
		chunks: ['eAvkwTbsxY2MSUaZpCaw', 'eAfJcifhROpV8fDA1d3pUmA=', 'eAfJecjJV8CiEiP672fzZMDg'],
	},
	flac: {
		codec: 'flac',
		sampleRate: 16000,
		description: 'ZkxhQ4AAACIEgASAAAALAAANA+gA8AAABkCfCt/b50DLnNgYijV2HiR2',
		chunks: ['//g1CAADAAAAakQ=', '//h1CAEBv70AAAAGlg=='],
	},
};

const fromBase64 = (base64: string) => Uint8Array.from(atob(base64), x => x.charCodeAt(0));

const decodesNatively = async (probe: Probe) => {
	const isVideo = probe.sampleRate === undefined;
	if (isVideo ? typeof VideoDecoder === 'undefined' : typeof AudioDecoder === 'undefined') {
		return false;
	}

	const description = probe.description !== undefined ? fromBase64(probe.description) : undefined;
	const videoConfig: VideoDecoderConfig = { codec: probe.codec, codedWidth: 64, codedHeight: 64, description };
	const audioConfig: AudioDecoderConfig = {
		codec: probe.codec,
		sampleRate: probe.sampleRate!,
		numberOfChannels: 1,
		description,
	};
	try {
		const support = isVideo
			? await VideoDecoder.isConfigSupported(videoConfig)
			: await AudioDecoder.isConfigSupported(audioConfig);
		if (!support.supported) {
			return false;
		}
	} catch {
		return false;
	}

	let outputs = 0;
	let failed = false;
	const init = {
		output: (data: VideoFrame | AudioData) => {
			outputs++;
			data.close();
		},
		error: () => {
			failed = true;
		},
	};
	const decoder = isVideo ? new VideoDecoder(init) : new AudioDecoder(init);

	try {
		if (decoder instanceof VideoDecoder) {
			decoder.configure(videoConfig);
			probe.chunks.forEach((chunk, i) => decoder.decode(new EncodedVideoChunk({
				type: i === 0 ? 'key' : 'delta',
				timestamp: i * 33_333,
				data: fromBase64(chunk),
			})));
		} else {
			decoder.configure(audioConfig);
			probe.chunks.forEach((chunk, i) => decoder.decode(new EncodedAudioChunk({
				type: 'key',
				timestamp: i * 20_000,
				data: fromBase64(chunk),
			})));
		}
		// A decoder that hangs doesn't decode
		await Promise.race([decoder.flush(), new Promise(resolve => setTimeout(resolve, 2000))]);
	} catch {
		failed = true;
	}
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return !failed && outputs > 0;
};

const platformDecodes = Object.fromEntries(await Promise.all(
	(Object.keys(PLATFORM_PROBES) as (keyof typeof PLATFORM_PROBES)[])
		.map(async key => [key, await decodesNatively(PLATFORM_PROBES[key])] as const),
)) as Record<keyof typeof PLATFORM_PROBES, boolean>;

// Mediabunny starts decoding at recovery points everywhere but in Chromium (which rejects them as first frames).
// WebKitGTK can't either, so there, open-GOP files can't be checked.
const isChromiumUserAgent = /Chrome/.test(navigator.userAgent);
const isFirefoxUserAgent = navigator.userAgent.includes('Firefox');
const recoveryPointsUnsupported = !isChromiumUserAgent && !platformDecodes.avcRecoveryPoint;

/** Skips for what the platform can't do; Mediabunny itself must then agree that the track can be decoded. */
const skipUnlessPlatformCapable = (
	codec: ProbedCodec,
	{ negativeTimestamps = false, openGop = false },
	skip: (note: string) => never,
) => {
	if (!platformDecodes[codec]) {
		skip(`${codec} can't be decoded here (native probe)`);
	}
	if (negativeTimestamps && !negativeTimestampsDecodeCorrectly) {
		skip('the decoder scrambles negative timestamps here (native probe)');
	}
	if (openGop && recoveryPointsUnsupported) {
		skip('the decoder can\'t start at a recovery point here (native probe)');
	}
	if (openGop && isFirefoxUserAgent) {
		// Known: Firefox drops the leading pictures of open GOPs, which shifts the decoded timestamps (fork PR #191)
		skip('Firefox drops open-GOP leading pictures (#191)');
	}
};

const readSample = async (sample: VideoSample): Promise<Frame> => {
	if (!nativeYuvToRgbaWorks) {
		const canvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
		const context = canvas.getContext('2d')!;
		sample.draw(context, 0, 0);
		const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
		return { index: readFrameIndex(rgba, canvas.width * 4), timestamp: sample.timestamp };
	}

	const rgba = new Uint8Array(sample.allocationSize({ format: 'RGBA' }));
	await sample.copyTo(rgba, { format: 'RGBA' });

	return { index: readFrameIndex(rgba, sample.visibleRect.width * 4), timestamp: sample.timestamp };
};

const readCanvas = (canvas: HTMLCanvasElement | OffscreenCanvas, timestamp: number): Frame => {
	const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	const rgba = context.getImageData(0, 0, 64, 64).data;

	return { index: readFrameIndex(rgba, 64 * 4), timestamp };
};

// Timestamps within this tolerance of the expected one are fine (the container's own rounding is in the expectations)
const TIMESTAMP_TOLERANCE = 1e-6;

const expectFrame = (actual: Frame | null, expected: Frame | null, context: string) => {
	if (expected === null) {
		expect(actual, context).toBeNull();
		return;
	}

	expect(actual, context).not.toBeNull();
	expect(actual!.index, context).toBe(expected.index);
	expect(Math.abs(actual!.timestamp - expected.timestamp), context).toBeLessThan(TIMESTAMP_TOLERANCE);
};

type Query = { timestamp: number; expected: Frame | null };

const runVideoCase = async (videoCase: VideoCase, track: InputVideoTrack) => {
	const { frames } = videoCase;
	const first = frames[0]!;
	const last = frames[frames.length - 1]!;

	// The frame displayed at a timestamp: the last one starting at or before it. Pre-roll frames that the file only
	// keeps for decoding (at timestamps before the first displayed frame) aren't asserted on.
	const frameAt = (timestamp: number) => {
		let result: Frame | null = null;
		for (const frame of frames) {
			if (frame.timestamp <= timestamp) {
				result = frame;
			}
		}

		return result;
	};

	// The container's own timeline matches FFmpeg's
	const packetSink = new EncodedPacketSink(track);
	const packetTimestamps: number[] = [];
	for await (const packet of packetSink.packets(undefined, undefined, { metadataOnly: true })) {
		packetTimestamps.push(packet.timestamp);
	}
	packetTimestamps.sort((a, b) => a - b);

	const displayedTimestamps = packetTimestamps.filter(x => x > first.timestamp - TIMESTAMP_TOLERANCE);
	expect(displayedTimestamps).toHaveLength(frames.length);
	for (let i = 0; i < frames.length; i++) {
		expect(Math.abs(displayedTimestamps[i]! - frames[i]!.timestamp)).toBeLessThan(TIMESTAMP_TOLERANCE);
	}

	// Queries: on, just before and between frame starts (using the container's own timestamps), and out of range
	const queries: Query[] = [];
	for (let i = 0; i < frames.length; i++) {
		const timestamp = displayedTimestamps[i]!;
		queries.push({ timestamp, expected: frames[i]! });
		queries.push({ timestamp: timestamp - 1e-6, expected: i === 0 ? null : frames[i - 1]! });
		if (i + 1 < frames.length) {
			queries.push({ timestamp: (timestamp + displayedTimestamps[i + 1]!) / 2, expected: frames[i]! });
		}
	}
	const hasPreRollFrames = packetTimestamps[0]! < first.timestamp - TIMESTAMP_TOLERANCE;
	const assertedQueries = queries.filter(x => x.expected !== null || !hasPreRollFrames);
	assertedQueries.push({ timestamp: last.timestamp + 10, expected: last });
	assertedQueries.push({ timestamp: Infinity, expected: last });
	if (!hasPreRollFrames) {
		assertedQueries.push({ timestamp: first.timestamp - 1, expected: null });
		assertedQueries.push({ timestamp: -Infinity, expected: null });
	}

	const sink = new VideoSampleSink(track);

	// Iterating everything yields every frame once, in presentation order
	const iterated: Frame[] = [];
	for await (using sample of sink.samples()) {
		iterated.push(await readSample(sample));
	}
	const displayed = iterated.filter(x => x.timestamp > first.timestamp - TIMESTAMP_TOLERANCE);
	expect(displayed.map(x => x.index)).toEqual(frames.map(x => x.index));
	displayed.forEach((frame, i) => expectFrame(frame, frames[i]!, `samples() #${i}`));

	// Single lookups, in a scrambled order on the same sink
	const scrambled = assertedQueries
		.map((query, i) => ({ query, key: (i * 7919) % assertedQueries.length }))
		.sort((a, b) => a.key - b.key)
		.map(x => x.query);
	for (const { timestamp, expected } of scrambled) {
		using sample = await sink.getSample(timestamp);
		expectFrame(sample && await readSample(sample), expected, `getSample(${timestamp})`);
	}

	// Batched lookups, sorted, then unsorted with duplicates
	const sorted = [...assertedQueries].sort((a, b) => a.timestamp - b.timestamp);
	const unsorted = [...scrambled.filter((_, i) => i % 3 === 0), ...scrambled.slice(0, 8)];
	for (const batch of [sorted, unsorted]) {
		let i = 0;
		for await (using sample of sink.samplesAtTimestamps(batch.map(x => x.timestamp))) {
			const { timestamp, expected } = batch[i++]!;
			expectFrame(sample && await readSample(sample), expected, `samplesAtTimestamps(..., ${timestamp}, ...)`);
		}
		expect(i).toBe(batch.length);
	}

	// Ranges start with the frame displayed at their start and end before their (exclusive) end
	// Each range ends between two frames, twelve frames later
	const midpoint = (i: number) => (displayedTimestamps[i]! + displayedTimestamps[i + 1]!) / 2;
	const ranges = [
		[displayedTimestamps[5]!, midpoint(17)],
		[displayedTimestamps[13]! - 1e-6, midpoint(25)],
		[displayedTimestamps[29]! + 0.01, midpoint(41)],
	] as const;
	for (const [start, end] of ranges) {
		const expected = frames.filter(x => x.timestamp < end && (x.timestamp > start || x === frameAt(start)));

		const actual: Frame[] = [];
		for await (using sample of sink.samples(start, end)) {
			actual.push(await readSample(sample));
		}
		expect(actual.map(x => x.index), `samples(${start}, ${end})`).toEqual(expected.map(x => x.index));
	}

	// The canvas sink draws the same frames
	const canvasSink = new CanvasSink(track);
	const canvasQueries = sorted.filter((_, i) => i % 5 === 0);
	for (const { timestamp, expected } of canvasQueries) {
		const wrapped = await canvasSink.getCanvas(timestamp);
		expectFrame(wrapped && readCanvas(wrapped.canvas, wrapped.timestamp), expected, `getCanvas(${timestamp})`);
	}
	let canvasIndex = 0;
	for await (const wrapped of canvasSink.canvasesAtTimestamps(canvasQueries.map(x => x.timestamp))) {
		const { timestamp, expected } = canvasQueries[canvasIndex++]!;
		expectFrame(
			wrapped && readCanvas(wrapped.canvas, wrapped.timestamp),
			expected,
			`canvasesAtTimestamps(..., ${timestamp}, ...)`,
		);
	}
	expect(canvasIndex).toBe(canvasQueries.length);

	const [rangeStart, rangeEnd] = ranges[1];
	const canvasRange: number[] = [];
	for await (const wrapped of canvasSink.canvases(rangeStart, rangeEnd)) {
		canvasRange.push(readCanvas(wrapped.canvas, wrapped.timestamp).index);
	}
	expect(canvasRange).toEqual(
		frames.filter(x => x.timestamp < rangeEnd && (x.timestamp > rangeStart || x === frameAt(rangeStart)))
			.map(x => x.index),
	);

	// Packet lookups agree, and key packet lookups give a verified key packet at or before the timestamp
	for (const { timestamp, expected } of assertedQueries.filter((_, i) => i % 2 === 0)) {
		const packet = await packetSink.getPacket(timestamp, { metadataOnly: true });
		if (expected === null) {
			expect(packet, `getPacket(${timestamp})`).toBeNull();
		} else {
			expect(packet, `getPacket(${timestamp})`).not.toBeNull();
			expect(Math.abs(packet!.timestamp - expected.timestamp)).toBeLessThan(TIMESTAMP_TOLERANCE);

			const keyPacket = await packetSink.getKeyPacket(timestamp, { verifyKeyPackets: true });
			assert(keyPacket);
			expect(keyPacket.type).toBe('key');
			expect(keyPacket.timestamp).toBeLessThanOrEqual(timestamp);
		}
	}
};

describe('Video', () => {
	for (const videoCase of videoCases) {
		test(videoCase.file, async (context) => {
			skipUnlessPlatformCapable(videoCase.codec, videoCase, note => context.skip(note));

			using input = new Input({
				source: new UrlSource(`/${videoCase.file}`),
				formats: ALL_FORMATS,
			});

			const track = await input.getPrimaryVideoTrack();
			assert(track);
			expect(await track.canDecode()).toBe(true);

			await runVideoCase(videoCase, track);
		});
	}

	test('MPEG-TS without random access indicators (key frames found in the bitstream)', async (context) => {
		skipUnlessPlatformCapable('avc', {}, note => context.skip(note));

		const bytes = new Uint8Array(await (await fetch('/seek-avc-bframes.ts')).arrayBuffer());
		let cleared = 0;
		for (let i = 0; i + 188 <= bytes.length; i += 188) {
			const adaptationFieldControl = (bytes[i + 3]! >> 4) & 0b11;
			const hasAdaptationField = adaptationFieldControl === 2 || adaptationFieldControl === 3;
			if (hasAdaptationField && bytes[i + 4]! > 0 && (bytes[i + 5]! & 0x40)) {
				bytes[i + 5]! &= ~0x40;
				cleared++;
			}
		}
		expect(cleared).toBe(2);

		using input = new Input({
			source: new BufferSource(bytes),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		assert(track);
		expect(await track.canDecode()).toBe(true);

		await runVideoCase(videoCases.find(x => x.file === 'seek-avc-bframes.ts')!, track);
	});
});

// Audio: each lookup must return the chunk containing the timestamp, with the same timestamp and the same data as
// decoding straight through from the start (after the decoder pre-roll). Made with FFmpeg 8.0 from
// -f lavfi -i "aevalsrc=0.4*sin(2*PI*(220*t+300*t*t))+0.1*sin(2*PI*1234*t):s=48000:d=1.5" and:
//   seek-audio.mp3   -c:a libmp3lame -q:a 6 (VBR, Xing header)
//   seek-audio.flac  s=16000, -c:a flac -frame_size 1024
//   seek-audio.opus  -c:a libopus -b:a 32k (Ogg)
//   seek-audio.m4a   -c:a libfdk_aac -b:a 64k (edit list for the priming)
//   seek-audio.aac   -c:a libfdk_aac -b:a 64k (ADTS)
type AudioCase = {
	file: string;
	codec: ProbedCodec;
	maxDifference: number;
	/** The encoder delay (LAME delay, AAC priming, Opus pre-skip) puts the first packet before zero. */
	negativeTimestamps?: boolean;
};
const audioCases: AudioCase[] = [
	{ file: 'seek-audio.mp3', codec: 'mp3', maxDifference: 1e-4, negativeTimestamps: true },
	{ file: 'seek-audio.flac', codec: 'flac', maxDifference: 0 },
	// 80 ms pre-roll converges closely, not exactly
	{ file: 'seek-audio.opus', codec: 'opus', maxDifference: 1e-3, negativeTimestamps: true },
	{ file: 'seek-audio.m4a', codec: 'aac', maxDifference: 1e-4, negativeTimestamps: true },
	{ file: 'seek-audio.aac', codec: 'aac', maxDifference: 1e-4 },
];

const getChannelData = (sample: AudioSample) => {
	const data = new Float32Array(sample.numberOfFrames);
	sample.copyTo(data, { format: 'f32-planar', planeIndex: 0 });
	return data;
};

const runAudioCase = async (audioCase: AudioCase, track: InputAudioTrack) => {
	const sampleRate = await track.getSampleRate();
	const sink = new AudioSampleSink(track);

	// Decoding straight through gives the reference, and must be contiguous
	const chunks: { timestamp: number; data: Float32Array }[] = [];
	for await (using sample of sink.samples()) {
		const previous = chunks[chunks.length - 1];
		if (previous) {
			const previousEnd = previous.timestamp + previous.data.length / sampleRate;
			expect(Math.abs(sample.timestamp - previousEnd) * sampleRate).toBeLessThan(0.5);
		}
		chunks.push({ timestamp: sample.timestamp, data: getChannelData(sample) });
	}
	expect(chunks.length).toBeGreaterThan(10);

	const firstTimestamp = chunks[0]!.timestamp;
	const lastChunk = chunks[chunks.length - 1]!;

	const expectChunk = (sample: AudioSample | null, timestamp: number, context: string) => {
		expect(sample, context).not.toBeNull();
		assert(sample);
		const chunk = chunks.find(x => Math.abs(x.timestamp - sample.timestamp) < 0.5 / sampleRate);
		expect(chunk, `${context}: no chunk of the full decode starts at ${sample.timestamp}`).toBeDefined();
		assert(chunk);

		const end = chunk.timestamp + chunk.data.length / sampleRate;
		expect(chunk.timestamp, context).toBeLessThanOrEqual(timestamp);
		if (chunk !== lastChunk) {
			expect(timestamp, context).toBeLessThan(end);
		}

		const data = getChannelData(sample);
		expect(data.length, context).toBe(chunk.data.length);
		let difference = 0;
		for (let i = 0; i < data.length; i++) {
			difference = Math.max(difference, Math.abs(data[i]! - chunk.data[i]!));
		}
		expect(difference, context).toBeLessThanOrEqual(audioCase.maxDifference);
	};

	// Chunk starts, a sample before and after them, and chunk middles
	const timestamps: number[] = [];
	for (let i = 1; i < chunks.length; i += 2) {
		const { timestamp, data } = chunks[i]!;
		timestamps.push(timestamp, timestamp - 1 / sampleRate, timestamp + 1 / sampleRate);
		timestamps.push(timestamp + data.length / sampleRate / 2);
	}
	timestamps.push(lastChunk.timestamp + 5);

	for (const timestamp of timestamps) {
		using sample = await sink.getSample(timestamp);
		expectChunk(sample, timestamp, `getSample(${timestamp})`);
	}
	using beforeStart = await sink.getSample(firstTimestamp - 0.1);
	expect(beforeStart).toBeNull();

	const scrambled = timestamps
		.map((timestamp, i) => ({ timestamp, key: (i * 7919) % timestamps.length }))
		.sort((a, b) => a.key - b.key)
		.map(x => x.timestamp);
	for (const batch of [[...timestamps].sort((a, b) => a - b), [...scrambled, ...scrambled.slice(0, 5)]]) {
		let i = 0;
		for await (using sample of sink.samplesAtTimestamps(batch)) {
			const timestamp = batch[i++]!;
			expectChunk(sample, timestamp, `samplesAtTimestamps(..., ${timestamp}, ...)`);
		}
		expect(i).toBe(batch.length);
	}

	// Each range ends in the middle of a chunk, eight chunks later
	const chunkMiddle = (i: number) => chunks[i]!.timestamp + chunks[i]!.data.length / sampleRate / 2;
	const ranges = [
		[chunks[3]!.timestamp, chunkMiddle(11)],
		[chunks[7]!.timestamp + 0.001, chunkMiddle(15)],
		[chunks[12]!.timestamp - 1 / sampleRate, chunkMiddle(19)],
	] as const;
	for (const [start, end] of ranges) {
		let previousEnd: number | null = null;
		for await (using sample of sink.samples(start, end)) {
			if (previousEnd === null) {
				expectChunk(sample, start, `samples(${start}, ${end})`);
			} else {
				expect(Math.abs(sample.timestamp - previousEnd) * sampleRate).toBeLessThan(0.5);
				expectChunk(sample, sample.timestamp, `samples(${start}, ${end})`);
			}
			expect(sample.timestamp).toBeLessThan(end);
			previousEnd = sample.timestamp + sample.numberOfFrames / sampleRate;
		}
		expect(previousEnd).toBeGreaterThanOrEqual(end);
	}

	// AudioBufferSink returns the same chunks
	const bufferSink = new AudioBufferSink(track);
	for (const timestamp of timestamps.filter((_, i) => i % 6 === 0)) {
		const buffer = await bufferSink.getBuffer(timestamp);
		using sample = await sink.getSample(timestamp);
		assert(buffer && sample);
		expect(buffer.timestamp).toBe(sample.timestamp);
		expect(buffer.buffer.getChannelData(0)).toEqual(getChannelData(sample));
	}
};

describe('Audio', () => {
	for (const audioCase of audioCases) {
		test(audioCase.file, async (context) => {
			skipUnlessPlatformCapable(audioCase.codec, audioCase, note => context.skip(note));

			using input = new Input({
				source: new UrlSource(`/${audioCase.file}`),
				formats: ALL_FORMATS,
			});

			const track = await input.getPrimaryAudioTrack();
			assert(track);
			expect(await track.canDecode()).toBe(true);

			await runAudioCase(audioCase, track);
		});
	}
});
