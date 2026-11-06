import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import {
	AudioBufferSink,
	AudioSampleSink,
	CanvasSink,
	CanvasSinkOptions,
	EncodedPacketSink,
	VideoSampleSink,
} from '../../src/media-sink.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { assert } from '../../src/misc.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';

// Fixtures, made with FFmpeg 7.0.2:
//
// frame-index-*: 64x64, 30 fps, 90 frames. The luma of frame i encodes i: the top half is 16 + 13 * (i >> 4), the
// bottom half 16 + 13 * (i & 15).
//   INDEX="color=c=black:s=64x64:r=30:d=3,format=yuv420p,geq=lum='if(lt(Y\,H/2)\,16+13*floor(N/16)\,16+13*mod(N\,16))'
//     :cb=128:cr=128"
//   X264="-c:v libx264 -preset medium -crf 12 -g 30 -bf 3 -x264-params b-pyramid=normal"
//   ffmpeg -f lavfi -i "$INDEX" $X264 frame-index-x264-bframes.mp4 (and .mkv, .ts)
//   ffmpeg -f lavfi -i "$INDEX,settb=1/90000,setpts=3000*N+540*mod(N*7\,5)" -fps_mode passthrough $X264
//     -video_track_timescale 90000 frame-index-x264-vfr.mp4
//   ffmpeg -f lavfi -i "$INDEX" -c:v libvpx-vp9 -crf 20 -b:v 0 -g 30 frame-index-vp9.webm
//   ffmpeg -f lavfi -i "$INDEX" -c:v libaom-av1 -cpu-used 8 -crf 20 -g 30 frame-index-av1.mp4
//
// quadrants*: red, green, blue and white quadrants (top left, top right, bottom left, bottom right), 10 frames.
//   QUAD="format=gbrp,geq=r='if(lt(X\,W/2)*lt(Y\,H/2)+gte(X\,W/2)*gte(Y\,H/2)\,255\,0)'
//     :g='if(gte(X\,W/2)*lt(Y\,H/2)+gte(X\,W/2)*gte(Y\,H/2)\,255\,0)'
//     :b='if(lt(X\,W/2)*gte(Y\,H/2)+gte(X\,W/2)*gte(Y\,H/2)\,255\,0)'"
//   ffmpeg -f lavfi -i "color=black:s=128x64:r=10:d=1,$QUAD" -c:v libx264 -crf 5 -pix_fmt yuv420p quad.mkv
//   ffmpeg -i quad.mkv -c copy quadrants.mp4
//   ffmpeg -display_rotation:v 90 -i quad.mkv -c copy quadrants-ccw90.mp4
//   ffmpeg -display_rotation:v 90 -display_hflip:v -i quad.mkv -c copy quadrants-ccw90-hflip.mp4
//   ffmpeg -f lavfi -i "color=black:s=64x64:r=10:d=1,$QUAD,setsar=2/1" -c:v libx264 -crf 5 -pix_fmt yuv420p
//     quadrants-sar2.mp4
//
// clicks-*: mono, 3 s, a 4 ms 1 kHz tone burst starting every 0.5 s.
//   CLICKS="aevalsrc=exprs='if(lt(mod(t\,0.5)\,0.004)\,0.8*sin(2*PI*1000*t)\,0)':d=3"
//   ffmpeg -f lavfi -i "$CLICKS:s=44100" -c:a aac -b:a 64k clicks-aac.m4a
//   ffmpeg -f lavfi -i "$CLICKS:s=48000" -c:a libopus -b:a 48k clicks-opus.ogg
//   ffmpeg -f lavfi -i "$CLICKS:s=44100" -c:a libmp3lame -b:a 64k clicks-mp3.mp3
//   ffmpeg -f lavfi -i "$CLICKS:s=44100" -c:a flac clicks-flac.flac

// Tracks the frames and decoders WebCodecs hands out, to catch leaks. A closed VideoFrame or AudioData reports a format
// of null (and zero sizes).
const decodedFrames: (VideoFrame | AudioData)[] = [];
const decoders: (VideoDecoder | AudioDecoder)[] = [];

const originalVideoDecoder = globalThis.VideoDecoder;
const originalAudioDecoder = globalThis.AudioDecoder;

beforeEach(() => {
	globalThis.VideoDecoder = class extends originalVideoDecoder {
		constructor(init: VideoDecoderInit) {
			super({
				output: (frame) => {
					decodedFrames.push(frame);
					init.output(frame);
				},
				error: init.error,
			});
			decoders.push(this);
		}
	};
	globalThis.AudioDecoder = class extends originalAudioDecoder {
		constructor(init: AudioDecoderInit) {
			super({
				output: (data) => {
					decodedFrames.push(data);
					init.output(data);
				},
				error: init.error,
			});
			decoders.push(this);
		}
	};
});

afterEach(() => {
	globalThis.VideoDecoder = originalVideoDecoder;
	globalThis.AudioDecoder = originalAudioDecoder;
	decodedFrames.length = 0;
	decoders.length = 0;
});

const expectNoLeaks = async () => {
	// Closing happens asynchronously after the iterator returns
	await new Promise(resolve => setTimeout(resolve, 100));

	expect(decodedFrames.length).toBeGreaterThan(0);
	expect(decodedFrames.filter(frame => frame.format !== null)).toHaveLength(0);
	expect(decoders.filter(decoder => decoder.state !== 'closed')).toHaveLength(0);
};

const openInput = (file: string) => new Input({
	source: new UrlSource(`/${file}`),
	formats: ALL_FORMATS,
});

const videoTrackOf = async (input: Input) => {
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	return track;
};

const audioTrackOf = async (input: Input) => {
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	return track;
};

const indexCanvas = new OffscreenCanvas(64, 64);
const indexContext = indexCanvas.getContext('2d', { willReadFrequently: true })!;

/** Reads the frame index encoded in the luma of a frame-index-* frame. */
const readFrameIndex = (sample: VideoSample) => {
	indexContext.drawImage(sample.toCanvasImageSource(), 0, 0, 64, 64);
	const lumaLevel = (y: number) => {
		const gray = indexContext.getImageData(32, y, 1, 1).data[0]!;
		return Math.round((gray * 219 / 255) / 13);
	};

	return 16 * lumaLevel(16) + lumaLevel(48);
};

type VideoFixture = {
	file: string;
	/** Presentation timestamp of frame i, as stored in the file. */
	frameTimestamp: (i: number) => number;
};

const VIDEO_FIXTURES: VideoFixture[] = [
	{ file: 'frame-index-x264-bframes.mp4', frameTimestamp: i => i / 30 },
	{ file: 'frame-index-x264-bframes.mkv', frameTimestamp: i => Math.round(i * 1000 / 30) / 1000 },
	{ file: 'frame-index-x264-bframes.ts', frameTimestamp: i => (132000 + 3000 * i) / 90000 },
	{ file: 'frame-index-x264-vfr.mp4', frameTimestamp: i => (3000 * i + 540 * ((7 * i) % 5)) / 90000 },
	{ file: 'frame-index-vp9.webm', frameTimestamp: i => Math.round(i * 1000 / 30) / 1000 },
	{ file: 'frame-index-av1.mp4', frameTimestamp: i => i / 30 },
];
const FRAME_COUNT = 90;

/** The index of the frame displayed at the given timestamp, or null if it's before the first frame. */
const frameIndexAt = (fixture: VideoFixture, timestamp: number) => {
	let result: number | null = null;
	for (let i = 0; i < FRAME_COUNT; i++) {
		if (fixture.frameTimestamp(i) <= timestamp) {
			result = i;
		}
	}

	return result;
};

/** Timestamps around every few frames, plus some out-of-range ones. */
const probeTimestamps = (fixture: VideoFixture) => {
	const first = fixture.frameTimestamp(0);
	const last = fixture.frameTimestamp(FRAME_COUNT - 1);
	const timestamps = [-Infinity, first - 1, first - 1e-6, Infinity, last + 1];

	for (let i = 0; i < FRAME_COUNT; i += 7) {
		const timestamp = fixture.frameTimestamp(i);
		timestamps.push(timestamp, timestamp - 1e-6, timestamp + 1e-6, timestamp + 0.01);
	}

	return timestamps;
};

describe('VideoSampleSink', () => {
	test.each(VIDEO_FIXTURES)('$file: samples() yields every frame once, in presentation order', async (fixture) => {
		using input = openInput(fixture.file);
		const track = await videoTrackOf(input);

		const sink = new VideoSampleSink(track);
		let i = 0;
		for await (using sample of sink.samples()) {
			expect(readFrameIndex(sample)).toBe(i);
			expect(sample.timestamp).toBeCloseTo(fixture.frameTimestamp(i), 6);
			expect(sample.duration).toBeGreaterThan(0);
			i++;
		}

		expect(i).toBe(FRAME_COUNT);
		await expectNoLeaks();
	});

	test.each(VIDEO_FIXTURES)('$file: getSample(t) returns the frame displayed at t', async (fixture) => {
		using input = openInput(fixture.file);
		const track = await videoTrackOf(input);

		const sink = new VideoSampleSink(track);
		for (const timestamp of probeTimestamps(fixture)) {
			using sample = await sink.getSample(timestamp);
			const expectedIndex = frameIndexAt(fixture, timestamp);

			if (expectedIndex === null) {
				expect(sample).toBe(null);
			} else {
				assert(sample);
				expect(readFrameIndex(sample)).toBe(expectedIndex);
				expect(sample.timestamp).toBeCloseTo(fixture.frameTimestamp(expectedIndex), 6);
			}
		}

		await expectNoLeaks();
	});

	test.each(VIDEO_FIXTURES)(
		'$file: samplesAtTimestamps() answers sorted, unsorted, repeated and out-of-range timestamps',
		async (fixture) => {
			using input = openInput(fixture.file);
			const track = await videoTrackOf(input);

			const sink = new VideoSampleSink(track);
			const probes = probeTimestamps(fixture).filter(x => Number.isFinite(x));
			const middle = fixture.frameTimestamp(45);
			const sequences = [
				[...probes].sort((a, b) => a - b),
				probes,
				[...probes].sort((a, b) => b - a),
				[middle, middle, middle + 0.001, fixture.frameTimestamp(3), fixture.frameTimestamp(3), -5, Infinity],
			];

			for (const timestamps of sequences) {
				const indices: (number | null)[] = [];
				for await (using sample of sink.samplesAtTimestamps(timestamps)) {
					indices.push(sample && readFrameIndex(sample));
				}

				expect(indices).toEqual(timestamps.map(x => frameIndexAt(fixture, x)));
			}

			await expectNoLeaks();
		},
	);

	test.each(VIDEO_FIXTURES)(
		'$file: samples(start, end) starts with the frame displayed at start and excludes end',
		async (fixture) => {
			using input = openInput(fixture.file);
			const track = await videoTrackOf(input);

			const sink = new VideoSampleSink(track);
			const at = fixture.frameTimestamp;
			const ranges: [number, number][] = [
				[at(30), at(40)], // Frame-aligned
				[at(30) + 0.01, at(40) + 0.01], // Mid-frame
				[at(30) - 1e-6, at(40) - 1e-6], // Just before frame starts
				[at(0) - 1, at(5)], // Starting before the first frame
				[at(85), Infinity], // Until the end
				[at(45) + 0.001, at(45) + 0.002], // Within one frame
			];

			for (const [start, end] of ranges) {
				const indices: number[] = [];
				for await (using sample of sink.samples(start, end)) {
					indices.push(readFrameIndex(sample));
				}

				const first = frameIndexAt(fixture, start) ?? 0;
				const expected: number[] = [];
				for (let i = first; i < FRAME_COUNT && at(i) < end; i++) {
					expected.push(i);
				}

				expect(indices).toEqual(expected);
			}

			await expectNoLeaks();
		},
	);

	test('Breaking out of iterators early closes their decoders and frames', async () => {
		using input = openInput('frame-index-x264-bframes.mp4');
		const track = await videoTrackOf(input);

		const sink = new VideoSampleSink(track);

		let count = 0;
		for await (using sample of sink.samples()) {
			void sample;
			if (++count === 3) {
				break;
			}
		}

		const iterator = sink.samplesAtTimestamps([0.5, 1.5, 2.5]);
		const result = await iterator.next();
		result.value?.close();
		await iterator.return();

		const canvasIterator = new CanvasSink(track).canvases(1);
		await canvasIterator.next();
		await canvasIterator.return();

		await expectNoLeaks();
	});

	test('Concurrent iterators on one sink are independent', async () => {
		using input = openInput('frame-index-x264-bframes.mp4');
		const track = await videoTrackOf(input);

		const sink = new VideoSampleSink(track);
		const first = sink.samples(0, 1);
		const second = sink.samples(1, 2);

		const firstIndices: number[] = [];
		const secondIndices: number[] = [];
		while (true) {
			const [a, b] = await Promise.all([first.next(), second.next()]);
			if (!a.done) {
				firstIndices.push(readFrameIndex(a.value));
				a.value.close();
			}
			if (!b.done) {
				secondIndices.push(readFrameIndex(b.value));
				b.value.close();
			}
			if (a.done && b.done) {
				break;
			}
		}

		expect(firstIndices).toEqual([...Array(30).keys()]);
		expect(secondIndices).toEqual([...Array(30).keys()].map(x => x + 30));
		await expectNoLeaks();
	});

	test('Tracks that cannot be decoded reject instead of hanging', async () => {
		using input = openInput('video-h265.mp4');
		const track = await videoTrackOf(input);

		if (await track.canDecode()) {
			return; // This browser decodes HEVC, nothing to check
		}

		const sink = new VideoSampleSink(track);
		await expect(sink.getSample(0)).rejects.toThrow('cannot be decoded');
		await expect(sink.samples().next()).rejects.toThrow('cannot be decoded');
		await expect(new CanvasSink(track).getCanvas(0)).rejects.toThrow('cannot be decoded');
	});
});

type Rgb = [number, number, number];

const QUADRANT_COLORS: Rgb[][] = [
	[[255, 0, 0], [0, 255, 0]], // Top: red, green
	[[0, 0, 255], [255, 255, 255]], // Bottom: blue, white
];

/** Linear part of the display transform: (u, v) maps to (a * u + c * v, b * u + d * v), with y pointing down. */
type LinearMap = { a: number; b: number; c: number; d: number };

const rotationAndFlipMap = (rotation: number, flip: boolean): LinearMap => {
	// Clockwise rotation, then a horizontal flip
	const cos = Math.round(Math.cos(rotation * Math.PI / 180));
	const sin = Math.round(Math.sin(rotation * Math.PI / 180));
	const map = { a: cos, b: sin, c: -sin, d: cos };

	return flip ? { a: -map.a, b: map.b, c: -map.c, d: map.d } : map;
};

type CanvasExpectation = {
	width: number;
	height: number;
	/** The expected color at a canvas pixel, or null if it's too close to an edge to tell. */
	colorAt: (x: number, y: number) => Rgb | null;
};

/** Independent model of CanvasSink's documented geometry: rotate, flip, crop, then fit into the canvas. */
const expectCanvas = (
	squarePixelWidth: number,
	squarePixelHeight: number,
	rotation: number,
	flip: boolean,
	options: CanvasSinkOptions,
): CanvasExpectation => {
	const map = rotationAndFlipMap(rotation, flip);
	const corners = [[0, 0], [squarePixelWidth, 0], [0, squarePixelHeight], [squarePixelWidth, squarePixelHeight]]
		.map(([u, v]) => [map.a * u! + map.c * v!, map.b * u! + map.d * v!] as const);
	const minX = Math.min(...corners.map(p => p[0]));
	const minY = Math.min(...corners.map(p => p[1]));
	const displayWidth = Math.max(...corners.map(p => p[0])) - minX;
	const displayHeight = Math.max(...corners.map(p => p[1])) - minY;

	let crop = { left: 0, top: 0, width: displayWidth, height: displayHeight };
	if (options.crop) {
		const left = Math.min(Math.max(options.crop.left, 0), displayWidth);
		const top = Math.min(Math.max(options.crop.top, 0), displayHeight);
		crop = {
			left,
			top,
			width: Math.min(options.crop.width, displayWidth - left),
			height: Math.min(options.crop.height, displayHeight - top),
		};
	}

	let width = crop.width;
	let height = crop.height;
	if (options.width !== undefined && options.height === undefined) {
		width = options.width;
		height = Math.round(width * crop.height / crop.width);
	} else if (options.width === undefined && options.height !== undefined) {
		height = options.height;
		width = Math.round(height * crop.width / crop.height);
	} else if (options.width !== undefined && options.height !== undefined) {
		width = options.width;
		height = options.height;
	}

	const fit = options.fit ?? 'fill';
	const scaleX = fit === 'fill'
		? width / crop.width
		: (fit === 'contain' ? Math.min : Math.max)(width / crop.width, height / crop.height);
	const scaleY = fit === 'fill' ? height / crop.height : scaleX;
	const offsetX = (width - crop.width * scaleX) / 2;
	const offsetY = (height - crop.height * scaleY) / 2;

	const colorAt = (x: number, y: number): Rgb | null => {
		const displayX = crop.left + (x + 0.5 - offsetX) / scaleX;
		const displayY = crop.top + (y + 0.5 - offsetY) / scaleY;

		// Stay clear of edges, where filtering blends colors
		const margin = 3 / Math.min(scaleX, scaleY);
		const insideX = displayX > crop.left + margin && displayX < crop.left + crop.width - margin;
		const insideY = displayY > crop.top + margin && displayY < crop.top + crop.height - margin;
		const outsideX = displayX < crop.left - margin || displayX > crop.left + crop.width + margin;
		const outsideY = displayY < crop.top - margin || displayY > crop.top + crop.height + margin;
		if (outsideX || outsideY) {
			return [0, 0, 0]; // Letterboxing
		}
		if (!insideX || !insideY) {
			return null;
		}

		// Map back into the frame
		const px = displayX + minX;
		const py = displayY + minY;
		const determinant = map.a * map.d - map.c * map.b;
		const u = (map.d * px - map.c * py) / determinant;
		const v = (-map.b * px + map.a * py) / determinant;
		if (
			Math.abs(u - squarePixelWidth / 2) < 4
			|| Math.abs(v - squarePixelHeight / 2) < 4
			|| u < 3 || v < 3 || u > squarePixelWidth - 3 || v > squarePixelHeight - 3
		) {
			return null;
		}

		return QUADRANT_COLORS[v < squarePixelHeight / 2 ? 0 : 1]![u < squarePixelWidth / 2 ? 0 : 1]!;
	};

	return { width, height, colorAt };
};

describe('CanvasSink', () => {
	const QUADRANT_FIXTURES = [
		// File, expected rotation, expected flip, expected square-pixel size
		['quadrants.mp4', 0, false, 128, 64],
		['quadrants-ccw90.mp4', 270, false, 128, 64],
		['quadrants-ccw90-hflip.mp4', 270, true, 128, 64],
		['quadrants-sar2.mp4', 0, false, 128, 64],
	] as const;

	const OPTIONS: CanvasSinkOptions[] = [
		{},
		{ width: 50 },
		{ height: 50 },
		{ width: 100, height: 40, fit: 'fill' },
		{ width: 100, height: 40, fit: 'contain' },
		{ width: 100, height: 40, fit: 'cover' },
		{ width: 40, height: 100, fit: 'contain' },
		{ width: 40, height: 100, fit: 'cover' },
		{ rotation: 90 },
		{ rotation: 180 },
		{ rotation: 270, flip: true },
		{ rotation: 0, flip: false },
		{ crop: { left: 10, top: 6, width: 40, height: 30 } },
		{ crop: { left: 10, top: 6, width: 40, height: 30 }, rotation: 90 },
		{ crop: { left: 10, top: 6, width: 40, height: 30 }, width: 80, height: 80, fit: 'contain' },
		{ crop: { left: 30, top: 20, width: 1000, height: 1000 } }, // Clamped
		{ width: 16, height: 16, fit: 'cover' }, // Mipmapped downscale
	];

	test.each(QUADRANT_FIXTURES)(
		'%s: geometry follows rotation, flip, crop and fit',
		async (file, rotation, flip, squarePixelWidth, squarePixelHeight) => {
			using input = openInput(file);
			const track = await videoTrackOf(input);

			expect(await track.getRotation()).toBe(rotation);
			expect(await track.getFlip()).toBe(flip);
			expect(await track.getSquarePixelWidth()).toBe(squarePixelWidth);
			expect(await track.getSquarePixelHeight()).toBe(squarePixelHeight);

			for (const options of OPTIONS) {
				const expected = expectCanvas(
					squarePixelWidth,
					squarePixelHeight,
					options.rotation ?? rotation,
					options.flip ?? flip,
					options,
				);

				const wrapped = await new CanvasSink(track, options).getCanvas(0);
				assert(wrapped);
				const { canvas } = wrapped;
				const label = JSON.stringify(options);
				expect([canvas.width, canvas.height], label).toEqual([expected.width, expected.height]);

				const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
				const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
				for (let gridY = 0; gridY < 8; gridY++) {
					for (let gridX = 0; gridX < 8; gridX++) {
						const x = Math.floor((gridX + 0.5) * canvas.width / 8);
						const y = Math.floor((gridY + 0.5) * canvas.height / 8);
						const color = expected.colorAt(x, y);
						if (!color) {
							continue;
						}

						const offset = 4 * (y * canvas.width + x);
						const actual = [...pixels.subarray(offset, offset + 3)];
						const matches = actual.every((value, i) => Math.abs(value - color[i]!) < 70);
						expect(matches, `${label} at (${x}, ${y}): ${JSON.stringify([actual, color])}`).toBe(true);
					}
				}
			}
		},
	);

	test('poolSize recycles canvases round-robin and clears them before drawing', async () => {
		using input = openInput('quadrants.mp4');
		const track = await videoTrackOf(input);

		const sink = new CanvasSink(track, { poolSize: 2, width: 100, height: 100, fit: 'contain', alpha: true });
		const a = await sink.getCanvas(0);
		const b = await sink.getCanvas(0.5);
		const c = await sink.getCanvas(0.9);
		assert(a && b && c);

		expect(a.canvas).not.toBe(b.canvas);
		expect(c.canvas).toBe(a.canvas);
		expect([a.timestamp, b.timestamp, c.timestamp]).toEqual([0, 0.5, 0.9]);

		// The letterbox bars stay transparent, nothing of the previous draw shows through
		const context = c.canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
		expect([...context.getImageData(50, 2, 1, 1).data]).toEqual([0, 0, 0, 0]);
		expect(context.getImageData(30, 40, 1, 1).data[3]).toBe(255);
	});

	test('canvases() yields the frames of samples() with the same timing', async () => {
		using input = openInput('frame-index-x264-bframes.mp4');
		const track = await videoTrackOf(input);

		const expected: [number, number][] = [];
		for await (using sample of new VideoSampleSink(track).samples(1, 2)) {
			expected.push([sample.timestamp, sample.duration]);
		}

		const actual: [number, number][] = [];
		for await (const { timestamp, duration } of new CanvasSink(track, { poolSize: 1 }).canvases(1, 2)) {
			actual.push([timestamp, duration]);
		}

		expect(actual).toEqual(expected);
		await expectNoLeaks();
	});
});

const AUDIO_FIXTURES = ['clicks-aac.m4a', 'clicks-opus.ogg', 'clicks-mp3.mp3', 'clicks-flac.flac'];

const channelData = (sample: AudioSample) => {
	const options = { planeIndex: 0, format: 'f32-planar' } as const;
	const data = new Float32Array(sample.allocationSize(options) / Float32Array.BYTES_PER_ELEMENT);
	sample.copyTo(data, options);

	return data;
};

/** Finds the start of the first tone burst at or after the given timestamp. */
const findBurst = async (sink: AudioSampleSink, startTimestamp?: number) => {
	for await (using sample of sink.samples(startTimestamp)) {
		const data = channelData(sample);
		for (let i = 0; i < data.length; i++) {
			const timestamp = sample.timestamp + i / sample.sampleRate;
			if (Math.abs(data[i]!) > 0.3 && (startTimestamp === undefined || timestamp >= startTimestamp)) {
				return timestamp;
			}
		}
	}

	return null;
};

describe('AudioSampleSink', () => {
	test.each(AUDIO_FIXTURES)('%s: audio lands at its source time, also after seeking', async (file) => {
		using input = openInput(file);
		const track = await audioTrackOf(input);

		const sink = new AudioSampleSink(track);

		// The first burst starts at 0 once the encoder delay (edit list, pre-skip, LAME tag) is accounted for
		expect(await findBurst(sink)).toBeCloseTo(0, 3);
		for (const burst of [1, 1.5, 2.5]) {
			expect(await findBurst(sink, burst - 0.1)).toBeCloseTo(burst, 3);
			expect(await findBurst(sink, burst - 0.4)).toBeCloseTo(burst, 3);
		}

		await expectNoLeaks();
	});

	test.each(AUDIO_FIXTURES)('%s: samples are contiguous and getSample(t) agrees with samples()', async (file) => {
		using input = openInput(file);
		const track = await audioTrackOf(input);

		const sink = new AudioSampleSink(track);
		const samples: { timestamp: number; numberOfFrames: number }[] = [];
		for await (using sample of sink.samples()) {
			const previous = samples.at(-1);
			if (previous) {
				const previousEnd = previous.timestamp + previous.numberOfFrames / sample.sampleRate;
				expect(sample.timestamp).toBeCloseTo(previousEnd, 6);
			}

			samples.push({ timestamp: sample.timestamp, numberOfFrames: sample.numberOfFrames });
		}

		// Decoding starts with the first packet, minus what the decoder discards (the Opus pre-skip)
		const firstTimestamp = await track.getFirstTimestamp();
		expect(samples[0]!.timestamp).toBeGreaterThanOrEqual(firstTimestamp);
		expect(samples[0]!.timestamp).toBeLessThan(firstTimestamp + 0.01);

		for (let i = 0; i < samples.length; i += 9) {
			const reference = samples[i]!;
			for (const timestamp of [reference.timestamp, reference.timestamp + 0.001]) {
				using sample = await sink.getSample(timestamp);
				assert(sample);
				expect(sample.timestamp).toBe(reference.timestamp);
				expect(sample.numberOfFrames).toBe(reference.numberOfFrames);
			}
		}

		expect(await sink.getSample(samples[0]!.timestamp - 0.001)).toBe(null);
		await expectNoLeaks();
	});

	test('AudioBufferSink yields the samples as AudioBuffers', async () => {
		using input = openInput('clicks-aac.m4a');
		const track = await audioTrackOf(input);

		const expected: [number, number, number][] = [];
		for await (using sample of new AudioSampleSink(track).samples(1, 1.2)) {
			expected.push([sample.timestamp, sample.duration, sample.numberOfFrames]);
		}

		const actual: [number, number, number][] = [];
		for await (const { buffer, timestamp, duration } of new AudioBufferSink(track).buffers(1, 1.2)) {
			expect(buffer.sampleRate).toBe(await track.getSampleRate());
			expect(buffer.numberOfChannels).toBe(await track.getNumberOfChannels());
			actual.push([timestamp, duration, buffer.length]);
		}

		expect(actual).toEqual(expected);
		await expectNoLeaks();
	});

	test('Breaking out of audio iterators early closes their decoders and data', async () => {
		using input = openInput('clicks-opus.ogg');
		const track = await audioTrackOf(input);

		const sink = new AudioSampleSink(track);
		let count = 0;
		for await (using sample of sink.samples()) {
			void sample;
			if (++count === 2) {
				break;
			}
		}

		const iterator = new AudioBufferSink(track).buffersAtTimestamps([0.5, 1, 1.5]);
		await iterator.next();
		await iterator.return();

		await expectNoLeaks();
	});

	test('Packet sinks see the priming the decoded audio drops', async () => {
		// The first packet starts before 0 (AAC priming, Opus pre-skip, LAME delay), while the decoded audio is
		// placed such that the source starts at 0
		for (const file of ['clicks-aac.m4a', 'clicks-opus.ogg', 'clicks-mp3.mp3']) {
			using input = openInput(file);
			const track = await audioTrackOf(input);

			const firstPacket = await new EncodedPacketSink(track).getFirstPacket();
			assert(firstPacket);
			expect(firstPacket.timestamp).toBeLessThan(0);
			expect(await track.getFirstTimestamp()).toBe(firstPacket.timestamp);
		}
	});
});

void InputAudioTrack;
void InputVideoTrack;
