import { describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import {
	MkvOutputFormat,
	Mp4OutputFormat,
	OutputFormat,
	WavOutputFormat,
	WebMOutputFormat,
} from '../../src/output-format.js';
import { Conversion, ConversionCanceledError, ConversionOptions } from '../../src/conversion.js';
import {
	AudioBufferSource,
	CanvasSource,
	MediaStreamAudioTrackSource,
	MediaStreamVideoTrackSource,
	VideoSampleSource,
} from '../../src/media-source.js';
import { Quality } from '../../src/encode.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { VideoSample } from '../../src/sample.js';
import { assert, Rotation } from '../../src/misc.js';
import { InputTrack } from '../../src/input-track.js';

type Quadrants = 'R' | 'G' | 'B' | 'W' | 'K' | '?';

const QUADRANT_COLORS = ['#f00', '#0f0', '#00f', '#fff'];

/** Draws red, green, blue and white quadrants (top left, top right, bottom left, bottom right). */
const drawQuadrants = (context: OffscreenCanvasRenderingContext2D, width: number, height: number) => {
	QUADRANT_COLORS.forEach((color, i) => {
		context.fillStyle = color;
		context.fillRect((i % 2) * width / 2, Math.floor(i / 2) * height / 2, width / 2, height / 2);
	});
};

/** A 10-frame AVC MP4 showing the quadrant pattern, with the given rotation metadata. */
const createQuadrantVideo = async (width: number, height: number, rotation: Rotation = 0) => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const canvas = new OffscreenCanvas(width, height);
	drawQuadrants(canvas.getContext('2d')!, width, height);

	const source = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('very-high') });
	output.addVideoTrack(source, { rotation, frameRate: 10 });
	await output.start();
	for (let i = 0; i < 10; i++) {
		await source.add(i / 10, 1 / 10);
	}
	await output.finalize();

	return output.target.buffer!;
};

/**
 * A video whose frames encode their index (modulo 8) as gray levels 32 apart. Gray has the same luma under every YUV
 * matrix, so this survives encoders that convert with one matrix but signal another.
 */
const createCountingVideo = async (frameCount: number, frameRate: number) => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const canvas = new OffscreenCanvas(64, 64);
	const context = canvas.getContext('2d')!;

	const source = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('very-high') });
	output.addVideoTrack(source, { frameRate });
	await output.start();
	for (let i = 0; i < frameCount; i++) {
		const level = (i % 8) * 32 + 16;
		context.fillStyle = `rgb(${level}, ${level}, ${level})`;
		context.fillRect(0, 0, 64, 64);
		await source.add(i / frameRate, 1 / frameRate);
	}
	await output.finalize();

	return output.target.buffer!;
};

const classifyColor = (r: number, g: number, b: number): Quadrants => {
	if (r > 200 && g > 200 && b > 200) {
		return 'W';
	}
	if (r > 150 && g < 100 && b < 100) {
		return 'R';
	}
	if (g > 150 && r < 100 && b < 100) {
		return 'G';
	}
	if (b > 150 && r < 100 && g < 100) {
		return 'B';
	}
	if (r < 50 && g < 50 && b < 50) {
		return 'K';
	}
	return '?';
};

/** Reads the first frame as presented (rotation applied) and reports the colors at the given relative points. */
const inspectFirstFrame = async (buffer: ArrayBuffer, points: [number, number][]) => {
	using input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	using sample = await new VideoSampleSink(track).getSample(await track.getFirstTimestamp());
	assert(sample);

	const canvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
	const context = canvas.getContext('2d')!;
	sample.draw(context, 0, 0, sample.displayWidth, sample.displayHeight);

	const colors = points.map(([x, y]) => {
		const pixel = context.getImageData(
			Math.floor(x * (sample.displayWidth - 1)),
			Math.floor(y * (sample.displayHeight - 1)),
			1,
			1,
		).data;
		return classifyColor(pixel[0]!, pixel[1]!, pixel[2]!);
	}).join('');

	return {
		codedSize: `${await track.getCodedWidth()}x${await track.getCodedHeight()}`,
		displaySize: `${await track.getDisplayWidth()}x${await track.getDisplayHeight()}`,
		rotation: await track.getRotation(),
		colors,
	};
};

const QUADRANT_CENTERS: [number, number][] = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];

const convert = async (
	buffer: ArrayBuffer,
	format: OutputFormat,
	options: Omit<ConversionOptions, 'input' | 'output'> = {},
) => {
	using input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
	const output = new Output({ format, target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output, showWarnings: false, ...options });
	expect(conversion.discardedTracks.map(x => x.reason)).toEqual([]);
	await conversion.execute();

	return output.target.buffer!;
};

const readPackets = async (track: InputTrack) => {
	const packets: { timestamp: number; duration: number; type: string }[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push({ timestamp: packet.timestamp, duration: packet.duration, type: packet.type });
	}

	return packets.sort((a, b) => a.timestamp - b.timestamp);
};

/** Decodes all frames and returns the frame indices encoded by createCountingVideo. */
const readFrameIndices = async (track: InputTrack) => {
	assert(track.isVideoTrack());
	const indices: number[] = [];
	const canvas = new OffscreenCanvas(8, 8);
	const context = canvas.getContext('2d')!;

	for await (using sample of new VideoSampleSink(track).samples()) {
		sample.draw(context, 0, 0, 8, 8);
		indices.push(Math.floor(context.getImageData(4, 4, 1, 1).data[0]! / 32));
	}

	return indices;
};

// Whether this browser has an AVC encoder at all, which the source videos of the transform, frame rate and process
// tests are encoded with (Firefox has none without a system FFmpeg). Decided by VideoEncoder.isConfigSupported
const avcEncodable = await (async () => {
	try {
		const config = { codec: 'avc1.42001f', width: 320, height: 180, bitrate: 2e6 };
		return (await VideoEncoder.isConfigSupported(config)).supported === true;
	} catch {
		return false;
	}
})();

// Quality levels give small frames small bitrates, at which WebKitGTK's AVC encoder (OpenH264) flattens colors and
// drops frames, so conversions that re-encode frames to read back their colors ask for an ample bitrate
const AMPLE_VIDEO_QUALITY = new Quality({ bitrate: 2e6 });

describe.skipIf(!avcEncodable)('Video transforms', () => {
	test('a width alone keeps the aspect ratio, rounded to even dimensions', async () => {
		const source = await createQuadrantVideo(320, 180);
		const result = await inspectFirstFrame(await convert(source, new Mp4OutputFormat(), {
			video: { width: 100, quality: AMPLE_VIDEO_QUALITY },
		}), QUADRANT_CENTERS);

		expect(result.codedSize).toBe('100x56'); // 100 / (16 / 9) = 56.25
		expect(result.colors).toBe('RGBW');
	});

	test('a height alone keeps the aspect ratio, rounded up to even dimensions', async () => {
		const source = await createQuadrantVideo(320, 180);
		const result = await inspectFirstFrame(await convert(source, new Mp4OutputFormat(), {
			video: { height: 101, quality: AMPLE_VIDEO_QUALITY },
		}), QUADRANT_CENTERS);

		expect(result.codedSize).toBe('182x102');
		expect(result.colors).toBe('RGBW');
	});

	test('fit: \'contain\' letterboxes, \'cover\' crops and \'fill\' stretches', async () => {
		const source = await createQuadrantVideo(320, 180);
		// Quadrant centers plus the middle of the top and bottom edges
		const points: [number, number][] = [...QUADRANT_CENTERS, [0.5, 0.02], [0.5, 0.98]];

		const contain = await inspectFirstFrame(await convert(source, new Mp4OutputFormat(), {
			video: { width: 200, height: 200, fit: 'contain', quality: AMPLE_VIDEO_QUALITY },
		}), points);
		expect(contain.codedSize).toBe('200x200');
		expect(contain.colors).toBe('RGBWKK');

		const cover = await inspectFirstFrame(await convert(source, new Mp4OutputFormat(), {
			video: { width: 200, height: 200, fit: 'cover', quality: AMPLE_VIDEO_QUALITY },
		}), [[0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98]]);
		expect(cover.colors).toBe('RGBW');

		const fill = await inspectFirstFrame(await convert(source, new Mp4OutputFormat(), {
			video: { width: 200, height: 200, fit: 'fill', quality: AMPLE_VIDEO_QUALITY },
		}), [[0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98]]);
		expect(fill.colors).toBe('RGBW');
	});

	test('rotate is written as metadata where possible and composes with the source rotation', async () => {
		const source = await createQuadrantVideo(320, 180);
		const rotated = await inspectFirstFrame(await convert(source, new Mp4OutputFormat(), {
			video: { rotate: 90 },
		}), QUADRANT_CENTERS);
		expect(rotated).toEqual({ codedSize: '320x180', displaySize: '180x320', rotation: 90, colors: 'BRWG' });

		const rotatedSource = await createQuadrantVideo(320, 180, 90);
		const twiceRotated = await inspectFirstFrame(await convert(rotatedSource, new Mp4OutputFormat(), {
			video: { rotate: 90 },
		}), QUADRANT_CENTERS);
		expect(twiceRotated).toEqual({ codedSize: '320x180', displaySize: '320x180', rotation: 180, colors: 'WBGR' });
	});

	test('rotation is baked in when the format has no rotation metadata or it is disallowed', async () => {
		const rotatedSource = await createQuadrantVideo(320, 180, 90);

		const mkv = await inspectFirstFrame(await convert(rotatedSource, new MkvOutputFormat(), {
			video: { quality: AMPLE_VIDEO_QUALITY },
		}), QUADRANT_CENTERS);
		expect(mkv).toEqual({ codedSize: '180x320', displaySize: '180x320', rotation: 0, colors: 'BRWG' });

		const disallowed = await inspectFirstFrame(await convert(rotatedSource, new Mp4OutputFormat(), {
			video: { rotate: 90, allowTransformationMetadata: false, quality: AMPLE_VIDEO_QUALITY },
		}), QUADRANT_CENTERS);
		expect(disallowed).toEqual({ codedSize: '320x180', displaySize: '320x180', rotation: 0, colors: 'WBGR' });
	});

	test('flip mirrors the frame horizontally, after the source rotation', async () => {
		const source = await createQuadrantVideo(320, 180);
		const flipped = await inspectFirstFrame(await convert(source, new Mp4OutputFormat(), {
			video: { flip: true, allowTransformationMetadata: false, quality: AMPLE_VIDEO_QUALITY },
		}), QUADRANT_CENTERS);
		expect(flipped.colors).toBe('GRWB');

		const rotatedSource = await createQuadrantVideo(320, 180, 90);
		const rotatedFlipped = await inspectFirstFrame(await convert(rotatedSource, new Mp4OutputFormat(), {
			video: { flip: true, allowTransformationMetadata: false, quality: AMPLE_VIDEO_QUALITY },
		}), QUADRANT_CENTERS);
		expect(rotatedFlipped).toMatchObject({ codedSize: '180x320', colors: 'RBGW' });
	});

	test('crop applies in the coordinates of the rotated frame and is clamped to it', async () => {
		const rotatedSource = await createQuadrantVideo(320, 180, 90); // Presented as 180x320

		const topHalf = await inspectFirstFrame(await convert(rotatedSource, new Mp4OutputFormat(), {
			video: { crop: { left: 0, top: 0, width: 180, height: 160 }, quality: AMPLE_VIDEO_QUALITY },
		}), QUADRANT_CENTERS);
		expect(topHalf).toMatchObject({ codedSize: '180x160', rotation: 0, colors: 'BRBR' });

		const clamped = await inspectFirstFrame(await convert(rotatedSource, new Mp4OutputFormat(), {
			video: { crop: { left: 90, top: 160, width: 1000, height: 1000 }, quality: AMPLE_VIDEO_QUALITY },
		}), QUADRANT_CENTERS);
		expect(clamped).toMatchObject({ codedSize: '90x160', colors: 'GGGG' });
	});
});

// The counting video is encoded at the 32 kbps that very-high quality gives 64x64 frames. WebKitGTK's AVC encoder
// starves at that bitrate (its first frames come back as flat gray and repeat), so there, frame indices can't be read
// back. Decided with WebCodecs alone: 8 flat gray 64x64 frames through a literal 32 kbps config must decode in order.
const avcKeepsEveryFrameAt32Kbps = avcEncodable && await (async () => {
	const canvas = new OffscreenCanvas(64, 64);
	const context = canvas.getContext('2d')!;
	const chunks: EncodedVideoChunk[] = [];
	let decoderConfig: VideoDecoderConfig | undefined;
	const encoder = new VideoEncoder({
		output: (chunk, meta) => {
			chunks.push(chunk);
			decoderConfig ??= meta?.decoderConfig;
		},
		error: () => {},
	});
	encoder.configure({ codec: 'avc1.42001f', width: 64, height: 64, bitrate: 32_000, framerate: 30 });
	const levels = Array.from({ length: 8 }, (_, i) => i * 32 + 16);
	levels.forEach((level, i) => {
		context.fillStyle = `rgb(${level}, ${level}, ${level})`;
		context.fillRect(0, 0, 64, 64);
		const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / 30), duration: 33_333 });
		encoder.encode(frame, { keyFrame: i === 0 });
		frame.close();
	});
	await encoder.flush();
	encoder.close();
	if (!decoderConfig) {
		return false;
	}

	const decoded: number[] = [];
	const decoder = new VideoDecoder({
		output: (frame) => {
			const pixel = new OffscreenCanvas(8, 8).getContext('2d')!;
			pixel.drawImage(frame, 0, 0, 8, 8);
			decoded.push(pixel.getImageData(4, 4, 1, 1).data[0]!);
			frame.close();
		},
		error: () => {},
	});
	decoder.configure(decoderConfig);
	chunks.forEach(chunk => decoder.decode(chunk));
	await decoder.flush();
	decoder.close();
	return decoded.length === levels.length && decoded.every((level, i) => Math.abs(level - levels[i]!) <= 8);
})().catch(() => false);

describe('Frame rate conversion', () => {
	const testIfFramesSurvive = test.skipIf(!avcKeepsEveryFrameAt32Kbps);

	testIfFramesSurvive('converting to the same frame rate keeps every frame', async () => {
		const source = await createCountingVideo(30, 30);
		using input = new Input({
			source: new BufferSource(await convert(source, new Mp4OutputFormat(), { video: { frameRate: 30 } })),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;

		const packets = await readPackets(track);
		expect(packets.map(x => x.timestamp)).toEqual(Array.from({ length: 30 }, (_, i) => i / 30));
		expect(await readFrameIndices(track)).toEqual(Array.from({ length: 30 }, (_, i) => i % 8));
	});

	testIfFramesSurvive('converting to a third of the frame rate keeps every third frame', async () => {
		const source = await createCountingVideo(30, 30);
		using input = new Input({
			source: new BufferSource(await convert(source, new Mp4OutputFormat(), { video: { frameRate: 10 } })),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;

		expect((await readPackets(track)).map(x => x.timestamp)).toEqual(Array.from({ length: 10 }, (_, i) => i / 10));
		expect(await readFrameIndices(track)).toEqual(Array.from({ length: 10 }, (_, i) => (3 * i) % 8));
		expect(await track.computeDuration()).toBe(1);
	});

	testIfFramesSurvive('converting to twice the frame rate shows every frame twice', async () => {
		const source = await createCountingVideo(30, 30);
		using input = new Input({
			source: new BufferSource(await convert(source, new Mp4OutputFormat(), { video: { frameRate: 60 } })),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;

		const packets = await readPackets(track);
		expect(packets).toHaveLength(60);
		expect(packets.every((x, i) => Math.abs(x.timestamp - i / 60) < 1e-9)).toBe(true);
		expect(await readFrameIndices(track)).toEqual(Array.from({ length: 60 }, (_, i) => Math.floor(i / 2) % 8));
	});

	test('variable frame rate input comes out on the fixed frame grid', async () => {
		using input = new Input({ source: new UrlSource('/cursed-vfr.mp4'), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, video: { frameRate: 10, width: 320 } });
		await conversion.execute();

		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = (await result.getPrimaryVideoTrack())!;
		const timestamps = (await readPackets(track)).map(x => x.timestamp);

		// One frame for each 0.1 s slot up to the end of the input
		expect(timestamps).toHaveLength(Math.floor(10 * await input.computeDuration()));
		expect(timestamps.every((x, i) => Math.abs(x - i / 10) < 1e-9)).toBe(true);
	});
});

describe('Key frames', () => {
	const keyFrameTimestamps = async (buffer: ArrayBuffer) => {
		using input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
		const packets = await readPackets((await input.getPrimaryVideoTrack())!);
		return packets.filter(x => x.type === 'key').map(x => Math.round(10 * x.timestamp) / 10);
	};

	test('keyFrameInterval sets the key frame spacing in seconds; 0 makes every frame a key frame', async () => {
		// 5 s of a still frame, so the encoder has no reason for extra key frames
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const canvas = new OffscreenCanvas(64, 64);
		canvas.getContext('2d')!.fillRect(0, 0, 64, 64);
		// VP9, as WebKitGTK's AVC encoder adds a key frame every 15 frames on its own
		const source = new CanvasSource(canvas, { codec: 'vp9', quality: new Quality('medium'), keyFrameInterval: 5 });
		output.addVideoTrack(source, { frameRate: 10 });
		await output.start();
		for (let i = 0; i < 50; i++) {
			await source.add(i / 10, 1 / 10);
		}
		await output.finalize();
		const video = output.target.buffer!;

		expect(await keyFrameTimestamps(await convert(video, new Mp4OutputFormat(), {
			video: { codec: 'vp9', forceTranscode: true },
		}))).toEqual([0, 2, 4]); // The default interval is 2 s
		expect(await keyFrameTimestamps(await convert(video, new Mp4OutputFormat(), {
			video: { codec: 'vp9', keyFrameInterval: 1 },
		}))).toEqual([0, 1, 2, 3, 4]);
		expect(await keyFrameTimestamps(await convert(video, new Mp4OutputFormat(), {
			video: { codec: 'vp9', keyFrameInterval: 0 },
		}))).toHaveLength(50);
	});
});

describe.skipIf(!avcEncodable)('Process callbacks', () => {
	test('returning null drops a frame and returning an array emits several', async () => {
		const source = await createCountingVideo(10, 10);
		const buffer = await convert(source, new Mp4OutputFormat(), {
			video: {
				process: (sample) => {
					const index = Math.round(sample.timestamp * 10);
					if (index % 2 === 1) {
						return null;
					}

					// Followed by a copy half a frame later
					const copy = sample.clone();
					copy.setTimestamp(sample.timestamp + 0.05);
					copy.setDuration(0.05);
					return [sample, copy];
				},
			},
		});

		using input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
		const timestamps = (await readPackets((await input.getPrimaryVideoTrack())!)).map(x => x.timestamp);
		expect(timestamps).toEqual([0, 0.05, 0.2, 0.25, 0.4, 0.45, 0.6, 0.65, 0.8, 0.85]);
	});

	test('a canvas of another size can be returned, announced by processedWidth and processedHeight', async () => {
		const source = await createQuadrantVideo(320, 180);
		const buffer = await convert(source, new Mp4OutputFormat(), {
			video: {
				process: (sample) => {
					const canvas = new OffscreenCanvas(64, 64);
					sample.draw(canvas.getContext('2d')!, 0, 0, 64, 64);
					return canvas;
				},
				processedWidth: 64,
				processedHeight: 64,
			},
		});

		const result = await inspectFirstFrame(buffer, QUADRANT_CENTERS);
		expect(result).toMatchObject({ codedSize: '64x64', colors: 'RGBW' });
	});
});

describe('Audio transcoding', () => {
	test('PCM is transcoded to Opus at 48 kHz with the requested channel count', async () => {
		using input = new Input({ source: new UrlSource('/glitch-hop-is-dead.wav'), formats: ALL_FORMATS });
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			audio: { numberOfChannels: 1 },
			trim: { end: 2 },
		});
		await conversion.execute();

		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = (await result.getPrimaryAudioTrack())!;
		expect(await track.getCodec()).toBe('opus');
		expect(await track.getNumberOfChannels()).toBe(1);
		expect(await track.getSampleRate()).toBe(48000);
		expect(await track.computeDuration()).toBeCloseTo(2, 1);
	});

	test('the audio process callback can drop samples', async () => {
		using input = new Input({ source: new UrlSource('/glitch-hop-is-dead.wav'), formats: ALL_FORMATS });
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		let calls = 0;
		const conversion = await Conversion.init({
			input,
			output,
			audio: {
				process: (sample) => {
					calls++;
					return sample.timestamp < 1 ? sample : null;
				},
			},
		});
		await conversion.execute();

		expect(calls).toBeGreaterThan(1);
		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const duration = await (await result.getPrimaryAudioTrack())!.computeDuration();
		expect(duration).toBeGreaterThanOrEqual(1);
		expect(duration).toBeLessThan(1.1);
	});
});

describe('Trimming while transcoding', () => {
	test('both tracks start at 0 and end at the trim length', async () => {
		using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			video: { width: 320 },
			trim: { start: 1.234, end: 3 },
		});
		await conversion.execute();

		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const video = await readPackets((await result.getPrimaryVideoTrack())!);
		const audio = await readPackets((await result.getPrimaryAudioTrack())!);
		const end = 3 - 1.234;

		expect(video[0]!.timestamp).toBe(0);
		expect(video.at(-1)!.timestamp + video.at(-1)!.duration).toBeCloseTo(end, 2);
		// Opus starts with its pre-skip before zero
		expect(audio[0]!.timestamp).toBeCloseTo(-312 / 48000, 2);
		expect(audio.at(-1)!.timestamp + audio.at(-1)!.duration).toBeCloseTo(end, 1);
	});
});

describe('Cancellation, errors and pausing', () => {
	const unhandledRejections: unknown[] = [];
	window.addEventListener('unhandledrejection', (event) => {
		unhandledRejections.push(event.reason);
	});

	// A process callback that holds the given frame until released, so that a cancel or pause request lands while the
	// conversion is still running
	const createGate = (frameNumber: number) => {
		let markEntered!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});

		let calls = 0;
		const process = async (sample: VideoSample) => {
			if (++calls === frameNumber) {
				markEntered();
				await released;
			}

			return sample;
		};

		return { process, entered, release };
	};

	test('canceling while transcoding rejects with ConversionCanceledError and cancels the output', async () => {
		// While the first frame is processed, and while a later one is
		for (const frameNumber of [1, 10]) {
			using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
			const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
			const gate = createGate(frameNumber);
			const conversion = await Conversion.init({ input, output, video: { width: 320, process: gate.process } });

			const promise = conversion.execute();
			await gate.entered;
			const cancelPromise = conversion.cancel();
			gate.release();
			await cancelPromise;

			await expect(promise).rejects.toBeInstanceOf(ConversionCanceledError);
			expect(conversion.state).toBe('canceled');
			expect(output.state).toBe('canceled');
		}

		await new Promise(resolve => setTimeout(resolve, 100));
		expect(unhandledRejections).toEqual([]);
	});

	test('an error in a process callback rejects execute and cancels the output', async () => {
		using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		let calls = 0;
		const conversion = await Conversion.init({
			input,
			output,
			video: {
				process: (sample) => {
					if (++calls === 5) {
						throw new Error('Process failed');
					}
					return sample;
				},
			},
		});

		await expect(conversion.execute()).rejects.toThrow('Process failed');
		expect(output.state).toBe('canceled');
		await new Promise(resolve => setTimeout(resolve, 100));
		expect(unhandledRejections).toEqual([]);
	});

	test('a paused conversion resumes where it left off', async () => {
		using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const gate = createGate(10);
		const conversion = await Conversion.init({ input, output, video: { width: 320, process: gate.process } });

		const controller = new AbortController();
		const promise = conversion.execute({ pauseSignal: controller.signal });
		await gate.entered;
		controller.abort();
		gate.release();
		await promise;
		expect(conversion.state).toBe('idle');
		expect(output.state).toBe('started');

		await conversion.execute();
		expect(conversion.state).toBe('done');

		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		expect(await readPackets((await result.getPrimaryVideoTrack())!)).toHaveLength(125);
	});
});

describe('Media sources', () => {
	// MediaStreamTrackGenerator (and the MediaStreamTrackProcessor the sources use without a frame rate) are
	// Chromium-only
	test.skipIf(typeof MediaStreamTrackGenerator === 'undefined')(
		'MediaStream sources record continuous video and audio; pausing removes the gap',
		async () => {
			// Tracks that need no capture device or permission
			const canvas = document.createElement('canvas');
			canvas.width = 320;
			canvas.height = 240;
			const context = canvas.getContext('2d')!;
			let frame = 0;
			const draw = () => {
				context.fillStyle = `hsl(${(frame++ * 10) % 360}, 100%, 50%)`;
				context.fillRect(0, 0, 320, 240);
			};
			draw();
			const drawInterval = setInterval(draw, 1000 / 30);
			const videoTrack = canvas.captureStream(30).getVideoTracks()[0]!;

			const audioTrack = new MediaStreamTrackGenerator({ kind: 'audio' });
			const audioWriter = audioTrack.writable.getWriter();
			let writtenFrames = 0;
			const writeAudio = () => {
				const data = new Float32Array(960)
					.map((_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * (writtenFrames + i) / 48000));
				void audioWriter.write(new AudioData({
					format: 'f32',
					sampleRate: 48000,
					numberOfChannels: 1,
					numberOfFrames: 960,
					timestamp: Math.round(1e6 * writtenFrames / 48000),
					data,
				}));
				writtenFrames += 960;
			};
			const audioInterval = setInterval(writeAudio, 20);

			let resumed = false;
			let videoFramesAfterResume = 0;
			let audioSamplesAfterResume = 0;
			let encodedAudioDuration = 0;
			let capturedDuration: number;
			let buffer: ArrayBuffer;

			try {
				const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
				const quality = new Quality('low');
				const videoSource = new MediaStreamVideoTrackSource(videoTrack, {
					codec: 'vp8',
					quality,
					onEncodedSample: () => {
						videoFramesAfterResume += resumed ? 1 : 0;
					},
				});
				const audioSource = new MediaStreamAudioTrackSource(audioTrack, {
					codec: 'opus',
					quality,
					// Includes the silence that fills gaps
					onEncodedSample: (sample) => {
						audioSamplesAfterResume += resumed ? 1 : 0;
						encodedAudioDuration += sample.duration;
					},
				});
				output.addVideoTrack(videoSource);
				output.addAudioTrack(audioSource);

				// Timers can fire late under load, so measure how long was actually captured
				await output.start();
				const startTime = performance.now();
				await new Promise(resolve => setTimeout(resolve, 600));
				videoSource.pause();
				audioSource.pause();
				const pauseTime = performance.now();
				await new Promise(resolve => setTimeout(resolve, 400));
				videoSource.resume();
				audioSource.resume();
				resumed = true;
				const resumeTime = performance.now();
				await new Promise(resolve => setTimeout(resolve, 600));
				const endTime = performance.now();
				await output.finalize();

				capturedDuration = (pauseTime - startTime + endTime - resumeTime) / 1000;
				buffer = output.target.buffer!;
			} finally {
				clearInterval(drawInterval);
				clearInterval(audioInterval);
				videoTrack.stop();
				audioTrack.stop();
			}

			using input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
			const video = await readPackets((await input.getPrimaryVideoTrack())!);
			const audio = await readPackets((await input.getPrimaryAudioTrack())!);

			// Both tracks went on after the pause
			expect(videoFramesAfterResume).toBeGreaterThan(0);
			expect(audioSamplesAfterResume).toBeGreaterThan(0);

			// The timeline starts at the first captured sample of either track ('synced-zero'); the audio's first
			// packet starts the Opus pre-skip before it
			const preSkip = 312 / 48000;
			expect(Math.min(video[0]!.timestamp, audio[0]!.timestamp + preSkip)).toBeCloseTo(0, 2);

			// The pause (at least 400 ms) doesn't show: neither track lasts longer than the time actually captured
			for (const packets of [video, audio]) {
				expect(packets.at(-1)!.timestamp + packets.at(-1)!.duration).toBeLessThan(capturedDuration + 0.1);
			}
			for (let i = 1; i < video.length; i++) {
				expect(video[i]!.timestamp).toBeGreaterThan(video[i - 1]!.timestamp);
			}

			// The Opus packets come out back to back (the encoder counts samples, so capture jitter doesn't show, and
			// gaps get filled with silence), but WebM stores timestamps in whole milliseconds: when the timeline puts
			// them on half milliseconds (the audio started it, so the 6.5 ms pre-skip shows), rounding can make
			// consecutive packets 19 or 21 ms apart
			for (let i = 1; i < audio.length; i++) {
				const spacing = audio[i]!.timestamp - audio[i - 1]!.timestamp;
				expect(Math.abs(spacing - 0.02)).toBeLessThanOrEqual(0.001 + 1e-9);
			}

			// And together, they hold exactly the audio given to the encoder plus the pre-skip, rounded up to whole
			// packets
			const audioSpan = audio.at(-1)!.timestamp + audio.at(-1)!.duration - audio[0]!.timestamp;
			expect(audioSpan).toBeGreaterThanOrEqual(encodedAudioDuration + preSkip - 0.002);
			expect(audioSpan).toBeLessThanOrEqual(encodedAudioDuration + preSkip + 0.022);
		},
	);

	test('CanvasSource frames keep their timestamps and durations', async () => {
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const canvas = new OffscreenCanvas(64, 64);
		canvas.getContext('2d')!.fillRect(0, 0, 64, 64);
		const source = new CanvasSource(canvas, { codec: 'vp9', quality: new Quality('medium') });
		output.addVideoTrack(source);
		await output.start();
		const timestamps = [0, 0.1, 0.15, 0.5, 0.75];
		for (let i = 0; i < timestamps.length; i++) {
			await source.add(timestamps[i]!, (timestamps[i + 1] ?? 1) - timestamps[i]!);
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const packets = await readPackets(track);
		expect(packets.map(x => x.timestamp)).toEqual(timestamps);
		expect(packets[0]!.type).toBe('key');
		expect(await track.computeDuration()).toBe(1);
	});

	test('AudioBufferSource places many small buffers back to back without drift', async () => {
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const source = new AudioBufferSource({ codec: 'pcm-s16' });
		output.addAudioTrack(source);
		await output.start();

		const sampleRate = 44100;
		const bufferCount = 3445; // 10 s of 128-frame buffers, like an AudioWorklet delivers them
		for (let i = 0; i < bufferCount; i++) {
			const audioBuffer = new AudioBuffer({ numberOfChannels: 1, length: 128, sampleRate });
			audioBuffer.getChannelData(0).fill(((i % 100) + 1) / 200);
			await source.add(audioBuffer);
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		let frames = 0;
		let lastValue = 0;
		for await (using sample of new AudioSampleSink(track).samples()) {
			frames += sample.numberOfFrames;
			const values = new Float32Array(sample.numberOfFrames);
			sample.copyTo(values, { planeIndex: 0, format: 'f32-planar' });
			lastValue = values.at(-1)!;
		}

		expect(frames).toBe(bufferCount * 128);
		expect(lastValue).toBeCloseTo((((bufferCount - 1) % 100) + 1) / 200, 3);
	});

	test('sizeChangeBehavior: \'contain\' letterboxes frames of another size into the first size', async () => {
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const source = new VideoSampleSource({
			codec: 'vp9',
			quality: new Quality('very-high'),
			sizeChangeBehavior: 'contain',
		});
		output.addVideoTrack(source);
		await output.start();

		const square = new OffscreenCanvas(100, 100);
		drawQuadrants(square.getContext('2d')!, 100, 100);
		const wide = new OffscreenCanvas(200, 100);
		drawQuadrants(wide.getContext('2d')!, 200, 100);

		using first = new VideoSample(square, { timestamp: 0, duration: 0.1 });
		await source.add(first);
		using second = new VideoSample(wide, { timestamp: 0.1, duration: 0.1 });
		await source.add(second);
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new VideoSampleSink(track);
		using secondFrame = (await sink.getSample(0.1))!;
		expect(secondFrame.displayWidth).toBe(100);
		expect(secondFrame.displayHeight).toBe(100);

		const canvas = new OffscreenCanvas(100, 100);
		const context = canvas.getContext('2d')!;
		secondFrame.draw(context, 0, 0);
		const color = (x: number, y: number) => {
			const pixel = context.getImageData(x, y, 1, 1).data;
			return classifyColor(pixel[0]!, pixel[1]!, pixel[2]!);
		};
		// Black bars above and below the 100x50 image
		expect(color(50, 5) + color(25, 37) + color(75, 62) + color(50, 95)).toBe('KRWK');
	});
});
