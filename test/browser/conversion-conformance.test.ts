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

/** A video whose frames encode their index in their red channel, at multiples of 32. */
const createCountingVideo = async (frameCount: number, frameRate: number) => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const canvas = new OffscreenCanvas(64, 64);
	const context = canvas.getContext('2d')!;

	const source = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('very-high') });
	output.addVideoTrack(source, { frameRate });
	await output.start();
	for (let i = 0; i < frameCount; i++) {
		context.fillStyle = `rgb(${(i % 8) * 32}, 0, 0)`;
		context.fillRect(0, 0, 64, 64);
		await source.add(i / frameRate, 1 / frameRate);
	}
	await output.finalize();

	return output.target.buffer!;
};

const classifyColor = (r: number, g: number, b: number): Quadrants => {
	if (r > 200 && g > 200 && b > 200) return 'W';
	if (r > 150 && g < 100 && b < 100) return 'R';
	if (g > 150 && r < 100 && b < 100) return 'G';
	if (b > 150 && r < 100 && g < 100) return 'B';
	if (r < 50 && g < 50 && b < 50) return 'K';
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
		indices.push(Math.round(context.getImageData(4, 4, 1, 1).data[0]! / 32));
	}

	return indices;
};

describe('Video transforms', () => {
	test('a width alone keeps the aspect ratio, rounded to even dimensions', async () => {
		const source = await createQuadrantVideo(320, 180);
		const result = await inspectFirstFrame(await convert(source, new Mp4OutputFormat(), {
			video: { width: 100 },
		}), QUADRANT_CENTERS);

		expect(result.codedSize).toBe('100x56'); // 100 / (16 / 9) = 56.25
		expect(result.colors).toBe('RGBW');
	});

	test('a height alone keeps the aspect ratio, rounded up to even dimensions', async () => {
		const source = await createQuadrantVideo(320, 180);
		const result = await inspectFirstFrame(await convert(source, new Mp4OutputFormat(), {
			video: { height: 101 },
		}), QUADRANT_CENTERS);

		expect(result.codedSize).toBe('182x102');
		expect(result.colors).toBe('RGBW');
	});

	test('fit: \'contain\' letterboxes, \'cover\' crops and \'fill\' stretches', async () => {
		const source = await createQuadrantVideo(320, 180);
		// Quadrant centers plus the middle of the top and bottom edges
		const points: [number, number][] = [...QUADRANT_CENTERS, [0.5, 0.02], [0.5, 0.98]];

		const contain = await inspectFirstFrame(await convert(source, new Mp4OutputFormat(), {
			video: { width: 200, height: 200, fit: 'contain' },
		}), points);
		expect(contain.codedSize).toBe('200x200');
		expect(contain.colors).toBe('RGBWKK');

		const cover = await inspectFirstFrame(await convert(source, new Mp4OutputFormat(), {
			video: { width: 200, height: 200, fit: 'cover' },
		}), [[0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98]]);
		expect(cover.colors).toBe('RGBW');

		const fill = await inspectFirstFrame(await convert(source, new Mp4OutputFormat(), {
			video: { width: 200, height: 200, fit: 'fill' },
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

		const mkv = await inspectFirstFrame(await convert(rotatedSource, new MkvOutputFormat()), QUADRANT_CENTERS);
		expect(mkv).toEqual({ codedSize: '180x320', displaySize: '180x320', rotation: 0, colors: 'BRWG' });

		const disallowed = await inspectFirstFrame(await convert(rotatedSource, new Mp4OutputFormat(), {
			video: { rotate: 90, allowTransformationMetadata: false },
		}), QUADRANT_CENTERS);
		expect(disallowed).toEqual({ codedSize: '320x180', displaySize: '320x180', rotation: 0, colors: 'WBGR' });
	});

	test('flip mirrors the frame horizontally, after the source rotation', async () => {
		const source = await createQuadrantVideo(320, 180);
		const flipped = await inspectFirstFrame(await convert(source, new Mp4OutputFormat(), {
			video: { flip: true, allowTransformationMetadata: false },
		}), QUADRANT_CENTERS);
		expect(flipped.colors).toBe('GRWB');

		const rotatedSource = await createQuadrantVideo(320, 180, 90);
		const rotatedFlipped = await inspectFirstFrame(await convert(rotatedSource, new Mp4OutputFormat(), {
			video: { flip: true, allowTransformationMetadata: false },
		}), QUADRANT_CENTERS);
		expect(rotatedFlipped).toMatchObject({ codedSize: '180x320', colors: 'RBGW' });
	});

	test('crop applies in the coordinates of the rotated frame and is clamped to it', async () => {
		const rotatedSource = await createQuadrantVideo(320, 180, 90); // Presented as 180x320

		const topHalf = await inspectFirstFrame(await convert(rotatedSource, new Mp4OutputFormat(), {
			video: { crop: { left: 0, top: 0, width: 180, height: 160 } },
		}), QUADRANT_CENTERS);
		expect(topHalf).toMatchObject({ codedSize: '180x160', rotation: 0, colors: 'BRBR' });

		const clamped = await inspectFirstFrame(await convert(rotatedSource, new Mp4OutputFormat(), {
			video: { crop: { left: 90, top: 160, width: 1000, height: 1000 } },
		}), QUADRANT_CENTERS);
		expect(clamped).toMatchObject({ codedSize: '90x160', colors: 'GGGG' });
	});
});

describe('Frame rate conversion', () => {
	test('converting to the same frame rate keeps every frame', async () => {
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

	test('converting to a third of the frame rate keeps every third frame', async () => {
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

	test('converting to twice the frame rate shows every frame twice', async () => {
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
		const source = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('medium'), keyFrameInterval: 5 });
		output.addVideoTrack(source, { frameRate: 10 });
		await output.start();
		for (let i = 0; i < 50; i++) {
			await source.add(i / 10, 1 / 10);
		}
		await output.finalize();
		const video = output.target.buffer!;

		expect(await keyFrameTimestamps(await convert(video, new Mp4OutputFormat(), {
			video: { forceTranscode: true },
		}))).toEqual([0, 2, 4]); // The default interval is 2 s
		expect(await keyFrameTimestamps(await convert(video, new Mp4OutputFormat(), {
			video: { keyFrameInterval: 1 },
		}))).toEqual([0, 1, 2, 3, 4]);
		expect(await keyFrameTimestamps(await convert(video, new Mp4OutputFormat(), {
			video: { keyFrameInterval: 0 },
		}))).toHaveLength(50);
	});
});

describe('Process callbacks', () => {
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

	test('canceling while transcoding rejects with ConversionCanceledError and cancels the output', async () => {
		for (const delay of [0, 100]) {
			using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
			const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
			const conversion = await Conversion.init({ input, output, video: { width: 320 } });

			const promise = conversion.execute();
			await new Promise(resolve => setTimeout(resolve, delay));
			await conversion.cancel();

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
		const conversion = await Conversion.init({ input, output, video: { width: 320 } });

		const controller = new AbortController();
		const promise = conversion.execute({ pauseSignal: controller.signal });
		await new Promise(resolve => setTimeout(resolve, 100));
		controller.abort();
		await promise;
		expect(conversion.state).toBe('idle');

		await conversion.execute();
		expect(conversion.state).toBe('done');

		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		expect(await readPackets((await result.getPrimaryVideoTrack())!)).toHaveLength(125);
	});
});

describe('Media sources', () => {
	test('MediaStream sources record continuous video and audio; pausing removes the gap', async () => {
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

		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const videoSource = new MediaStreamVideoTrackSource(videoTrack, { codec: 'vp8', quality: new Quality('low') });
		const audioSource = new MediaStreamAudioTrackSource(audioTrack, { codec: 'opus', quality: new Quality('low') });
		output.addVideoTrack(videoSource);
		output.addAudioTrack(audioSource);

		await output.start();
		await new Promise(resolve => setTimeout(resolve, 600));
		videoSource.pause();
		audioSource.pause();
		await new Promise(resolve => setTimeout(resolve, 400));
		videoSource.resume();
		audioSource.resume();
		await new Promise(resolve => setTimeout(resolve, 600));
		await output.finalize();

		clearInterval(drawInterval);
		clearInterval(audioInterval);
		videoTrack.stop();
		audioTrack.stop();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const video = await readPackets((await input.getPrimaryVideoTrack())!);
		const audio = await readPackets((await input.getPrimaryAudioTrack())!);

		// About 1.2 s were captured, starting right away
		const videoEnd = video.at(-1)!.timestamp + video.at(-1)!.duration;
		const audioEnd = audio.at(-1)!.timestamp + audio.at(-1)!.duration;
		expect(videoEnd).toBeGreaterThan(0.9);
		expect(videoEnd).toBeLessThan(1.6);
		expect(Math.abs(audioEnd - videoEnd)).toBeLessThan(0.25);
		expect(video[0]!.timestamp).toBeLessThan(0.25);
		expect(audio[0]!.timestamp).toBeLessThan(0.25);

		// No 400 ms gap from the pause
		for (let i = 1; i < video.length; i++) {
			expect(video[i]!.timestamp).toBeGreaterThan(video[i - 1]!.timestamp);
			expect(video[i]!.timestamp - video[i - 1]!.timestamp).toBeLessThan(0.2);
		}
		for (let i = 1; i < audio.length; i++) {
			expect(audio[i]!.timestamp - audio[i - 1]!.timestamp).toBeCloseTo(0.02, 3);
		}
	});

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
