import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat, WebMOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { AudioSampleSource, MediaStreamVideoTrackSource, VideoSampleSource } from '../../src/media-source.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { canEncodeAudio, Quality } from '../../src/encode.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { EncodedPacketSink, VideoSampleSink, AudioSampleSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { assert, Rotation } from '../../src/misc.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';

test('VideoSampleSource, normal usage', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium') },
		[{ width: 100, height: 100 }, { width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(3);

	for (const sample of samples) {
		expect(sample.codedWidth).toBe(100);
		expect(sample.codedHeight).toBe(100);
	}
});

test('VideoSampleSource, .close() should be idempotent after finalize()', async () => {
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new VideoSampleSource({
		codec: 'vp8',
		quality: new Quality('medium'),
	});

	output.addVideoTrack(videoSource);
	await output.start();

	const canvas = new OffscreenCanvas(100, 100);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(0, 0, 100, 100);

	const sample = new VideoSample(canvas, { timestamp: 0, duration: 1 / 30 });
	await videoSource.add(sample);
	sample.close();

	await output.finalize();

	videoSource.close(); // This previously threw
});

test('VideoSampleSource, changing input dimensions throws with deny (default)', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new VideoSampleSource({
		codec: 'vp8',
		quality: new Quality('medium'),
	});

	output.addVideoTrack(videoSource);
	await output.start();

	const sample1 = new VideoSample(makeCanvas(100, 100), { timestamp: 0, duration: 1 / 30 });
	await videoSource.add(sample1);
	sample1.close();

	const sample2 = new VideoSample(makeCanvas(200, 150), { timestamp: 1 / 30, duration: 1 / 30 });
	await expect(videoSource.add(sample2)).rejects.toThrow(/Video sample size must remain constant/);
	sample2.close();

	videoSource.close();
});

test('VideoSampleSource, changing input dimensions with passThrough preserves per-frame dimensions', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), sizeChangeBehavior: 'passThrough' },
		[{ width: 100, height: 100 }, { width: 200, height: 150 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(2);
	expect(samples[0]).toMatchObject({ codedWidth: 100, codedHeight: 100 });
	expect(
		// Either are valid; WebCodecs encoders don't like changing dimensions sometimes
		(samples[1]!.codedWidth === 100 && samples[1]!.codedHeight === 100)
		|| (samples[1]!.codedWidth === 200 && samples[1]!.codedHeight === 150),
	).toBe(true);
});

test(
	'VideoSampleSource, changing input dimensions with fill/contain/cover locks output to first frame dimensions',
	async () => {
		for (const behavior of ['fill', 'contain', 'cover'] as const) {
			const buffer = await encodeFrames(
				{ codec: 'vp8', quality: new Quality('medium'), sizeChangeBehavior: behavior },
				[{ width: 100, height: 100 }, { width: 200, height: 150 }],
			);

			const { input, track } = await readBackTrack(buffer);
			expect(await track.getCodedWidth()).toBe(100);
			expect(await track.getCodedHeight()).toBe(100);
			input.dispose();
		}
	},
);

test('VideoSampleSource, same-sized frames with width and height set', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { width: 50, height: 80, fit: 'fill' } },
		[{ width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(await track.getCodedWidth()).toBe(50);
	expect(await track.getCodedHeight()).toBe(80);
	input.dispose();
});

test('VideoSampleSource, same-sized frames with rotation set to 90', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { rotate: 90 } },
		[{ width: 200, height: 100 }, { width: 200, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(await track.getCodedWidth()).toBe(100);
	expect(await track.getCodedHeight()).toBe(200);
	input.dispose();
});

test('VideoSampleSource, same-sized frames with rotation, width and height', async () => {
	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
			transform: { rotate: 90, width: 50, height: 80, fit: 'contain' },
		},
		[{ width: 200, height: 100 }, { width: 200, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(await track.getCodedWidth()).toBe(50);
	expect(await track.getCodedHeight()).toBe(80);
	input.dispose();
});

test('VideoSampleSource, changing dimensions with passThrough and rotation 90', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), sizeChangeBehavior: 'passThrough', transform: { rotate: 90 } },
		[{ width: 200, height: 100 }, { width: 300, height: 150 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(2);
	expect(samples[0]).toMatchObject({ codedWidth: 100, codedHeight: 200 });
	expect(
		// Either are valid; WebCodecs encoders don't like changing dimensions sometimes
		(samples[1]!.codedWidth === 150 && samples[1]!.codedHeight === 300)
		|| (samples[1]!.codedWidth === 100 && samples[1]!.codedHeight === 200),
	).toBe(true);
});

test('VideoSampleSource, changing dimensions with passThrough, width and height set', async () => {
	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
			sizeChangeBehavior: 'passThrough',
			transform: {
				width: 50,
				height: 80,
				fit: 'fill',
			},
		},
		[{ width: 100, height: 100 }, { width: 200, height: 150 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(2);
	// Both frames should be resized to the fixed width/height
	expect(samples[0]).toMatchObject({ codedWidth: 50, codedHeight: 80 });
	expect(samples[1]).toMatchObject({ codedWidth: 50, codedHeight: 80 });
});

test('VideoSampleSource, encoding rotated video frames', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium') },
		[{ width: 200, height: 100, rotation: 90 }, { width: 200, height: 100, rotation: 90 }],
	);

	const samples = await readBackSamples(buffer);

	// They were encoded with no regard for the rotation metadata
	for (const sample of samples) {
		expect(sample.codedWidth).toBe(200);
		expect(sample.codedHeight).toBe(100);
	}
});

test('VideoSampleSource, flip is baked in via transform', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { flip: true } },
		[{ width: 200, height: 100, leftHalfBlue: true }, { width: 200, height: 100, leftHalfBlue: true }],
	);

	// After the flip, the blue half is on the right
	const { input, track } = await readBackTrack(buffer);
	const sink = new VideoSampleSink(track);
	using sample = (await sink.getSample(0))!;
	expect(sample.flip).toBe(false);

	const canvas = new OffscreenCanvas(200, 100);
	const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
	sample.draw(ctx, 0, 0);
	const left = ctx.getImageData(50, 50, 1, 1).data;
	const right = ctx.getImageData(150, 50, 1, 1).data;
	expect(left[0]).toBeGreaterThan(200); // red
	expect(right[2]).toBeGreaterThan(200); // blue

	input.dispose();
});

test('VideoSampleSource, encoding flipped video frames with forced transform', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { force: true } },
		[{ width: 200, height: 100, flip: true, leftHalfBlue: true }],
	);

	const { input, track } = await readBackTrack(buffer);
	const sink = new VideoSampleSink(track);
	using sample = (await sink.getSample(0))!;

	const canvas = new OffscreenCanvas(200, 100);
	const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
	sample.draw(ctx, 0, 0);
	expect(ctx.getImageData(150, 50, 1, 1).data[2]).toBeGreaterThan(200); // blue on the right now

	input.dispose();
});

test('VideoSampleSource, encoding rotated video frames with forced transform', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { force: true } },
		[{ width: 200, height: 100, rotation: 90 }, { width: 200, height: 100, rotation: 90 }],
	);

	const samples = await readBackSamples(buffer);

	// The rotation has been baked into the samples
	for (const sample of samples) {
		expect(sample.codedWidth).toBe(100);
		expect(sample.codedHeight).toBe(200);
	}
});

test('VideoSampleSource, transform.process identity function', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { process: sample => sample } },
		[{ width: 100, height: 100 }, { width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(3);
	for (const sample of samples) {
		expect(sample.codedWidth).toBe(100);
		expect(sample.codedHeight).toBe(100);
	}
});

test('VideoSampleSource, transform.process manual resize', async () => {
	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
			transform: {
				process: (sample) => {
					const canvas = new OffscreenCanvas(60, 40);
					const ctx = canvas.getContext('2d')!;
					sample.draw(ctx, 0, 0, 60, 40);
					sample.close();

					return canvas;
				},
			},
		},
		[{ width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(await track.getCodedWidth()).toBe(60);
	expect(await track.getCodedHeight()).toBe(40);
	input.dispose();
});

test('VideoSampleSource, transform.process receives pre-transformed frames', async () => {
	const receivedDimensions: { width: number; height: number }[] = [];

	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
			transform: {
				width: 50,
				height: 80,
				fit: 'fill',
				process: (sample) => {
					receivedDimensions.push({
						width: sample.codedWidth,
						height: sample.codedHeight,
					});
					return sample;
				},
			},
		},
		[{ width: 200, height: 200 }, { width: 200, height: 200 }],
	);

	expect(receivedDimensions).toHaveLength(2);
	for (const dim of receivedDimensions) {
		expect(dim.width).toBe(50);
		expect(dim.height).toBe(80);
	}

	const { input, track } = await readBackTrack(buffer);
	expect(await track.getCodedWidth()).toBe(50);
	expect(await track.getCodedHeight()).toBe(80);
	input.dispose();
});

test('VideoSampleSource, transform.process keeps the encode options of the input sample', async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const packetTypes: string[] = [];
	const videoSource = new VideoSampleSource({
		codec: 'vp8',
		quality: new Quality('medium'),
		transform: {
			// Returns non-sample data, which inherits the input sample's timing and encode options
			process: (sample) => {
				const canvas = new OffscreenCanvas(100, 100);
				sample.draw(canvas.getContext('2d')!, 0, 0);
				return canvas;
			},
		},
		onEncodedPacket: packet => packetTypes.push(packet.type),
	});
	output.addVideoTrack(videoSource);
	await output.start();

	for (let i = 0; i < 4; i++) {
		using sample = new VideoSample(makeCanvas(100, 100), {
			timestamp: i / 30,
			duration: 1 / 30,
			encodeOptions: { keyFrame: true },
		});
		await videoSource.add(sample);
	}

	await output.finalize();
	expect(packetTypes).toEqual(['key', 'key', 'key', 'key']);
});

test('VideoSampleSource, transform.process drops all frames after the first', async () => {
	let frameIndex = 0;

	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
			transform: {
				process: (sample) => {
					if (frameIndex++ > 0) {
						return null;
					}
					return sample;
				},
			},
		},
		[{ width: 100, height: 100 }, { width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(1);
});

test('VideoSampleSource, transform.process expands every frame into two', async () => {
	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
			transform: {
				process: (sample) => {
					const t = sample.timestamp;
					const d = sample.duration;
					const clone = sample.clone();
					clone.setTimestamp(2 * t);
					clone.setDuration(d);
					const clone2 = sample.clone();
					clone2.setTimestamp(2 * t + d);
					clone2.setDuration(d);
					return [clone, clone2];
				},
			},
		},
		[{ width: 100, height: 100 }, { width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(6);

	const d = 1 / 30;
	for (let i = 0; i < 6; i++) {
		expect(samples[i]!.timestamp).toBe(i * d);
		expect(samples[i]!.duration).toBe(d);
	}
});

test('VideoSampleSource, transform.frameRate normalizes variable-rate input to fixed rate', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { frameRate: 10 } },
		[
			{ width: 100, height: 100, timestamp: 0, duration: 0.15 },
			{ width: 100, height: 100, timestamp: 0.15, duration: 0.1 },
			{ width: 100, height: 100, timestamp: 0.25, duration: 0.05 },
		],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(3);
	for (let i = 0; i < 3; i++) {
		expect(samples[i]!.timestamp).toBeCloseTo(i * 0.1);
		expect(samples[i]!.duration).toBeCloseTo(0.1);
	}
});

test('VideoSampleSource, transform.frameRate pads gaps by repeating last frame', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { frameRate: 10 } },
		[
			{ width: 100, height: 100, timestamp: 0, duration: 0.1 },
			{ width: 100, height: 100, timestamp: 0.3, duration: 0.1 },
		],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(4);
	for (let i = 0; i < 4; i++) {
		expect(samples[i]!.timestamp).toBeCloseTo(i * 0.1);
		expect(samples[i]!.duration).toBeCloseTo(0.1);
	}
});

test('VideoSampleSource, transform.frameRate deduplicates frames in the same slot', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { frameRate: 10 } },
		[
			{ width: 100, height: 100, timestamp: 0, duration: 0.03 },
			{ width: 100, height: 100, timestamp: 0.03, duration: 0.03 },
			{ width: 100, height: 100, timestamp: 0.06, duration: 0.04 },
			{ width: 100, height: 100, timestamp: 0.1, duration: 0.1 },
		],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(2);
	expect(samples[0]!.timestamp).toBe(0);
	expect(samples[1]!.timestamp).toBeCloseTo(0.1);
});

test('VideoSampleSource, transform.frameRate final padding fills remaining duration', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { frameRate: 10 } },
		[
			{ width: 100, height: 100, timestamp: 0, duration: 0.5 },
		],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(5);
	for (let i = 0; i < 5; i++) {
		expect(samples[i]!.timestamp).toBeCloseTo(i * 0.1);
	}
});

test('VideoSampleSource, transform.frameRate is not thrown off by floating point error', async () => {
	// 30 Hz frames doubled to 60 Hz. 5/30 + 1/30 sums to 0.19999999999999998 rather than 0.2, which must still
	// count as the end of the 12th output frame.
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { frameRate: 60 } },
		Array.from({ length: 6 }, (_, i) => ({ width: 100, height: 100, timestamp: i / 30, duration: 1 / 30 })),
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(12);
	for (let i = 0; i < 12; i++) {
		expect(samples[i]!.timestamp).toBeCloseTo(i / 60);
	}
});

test('VideoSampleSource, transform.frameRate skipping and padding combined', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { frameRate: 10 } },
		[
			{ width: 100, height: 100, timestamp: 0, duration: 0.02 },
			{ width: 100, height: 100, timestamp: 0.02, duration: 0.02 },
			{ width: 100, height: 100, timestamp: 0.04, duration: 0.02 },
			{ width: 100, height: 100, timestamp: 0.3, duration: 0.05 },
			{ width: 100, height: 100, timestamp: 0.35, duration: 0.05 },
		],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(4);
	for (let i = 0; i < 4; i++) {
		expect(samples[i]!.timestamp).toBeCloseTo(i * 0.1);
		expect(samples[i]!.duration).toBeCloseTo(0.1);
	}
});

test('VideoSampleSource, transform.frameRate works with transform', async () => {
	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
			transform: { width: 50, height: 50, fit: 'fill', frameRate: 10 },
		},
		[
			{ width: 100, height: 100, timestamp: 0, duration: 0.3 },
		],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(3);
	for (let i = 0; i < 3; i++) {
		expect(samples[i]!.timestamp).toBeCloseTo(i * 0.1);
		expect(samples[i]!.duration).toBe(0.1);
		expect(samples[i]!.codedWidth).toBe(50);
		expect(samples[i]!.codedHeight).toBe(50);
	}
});

test('VideoSampleSource, transform.frameRate works with process', async () => {
	const processedTimestamps: number[] = [];

	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
			transform: {
				frameRate: 10,
				process: (sample) => {
					processedTimestamps.push(sample.timestamp);

					const canvas = new OffscreenCanvas(60, 40);
					const ctx = canvas.getContext('2d')!;
					sample.draw(ctx, 0, 0, 60, 40);

					return canvas;
				},
			},
		},
		[
			{ width: 100, height: 100, timestamp: 0, duration: 0.3 },
		],
	);

	expect(processedTimestamps).toHaveLength(3);
	for (let i = 0; i < 3; i++) {
		expect(processedTimestamps[i]).toBeCloseTo(i * 0.1);
	}

	const { input, track } = await readBackTrack(buffer);
	expect(await track.getCodedWidth()).toBe(60);
	expect(await track.getCodedHeight()).toBe(40);

	input.dispose();
});

const makeCanvas = (width: number, height: number, leftHalfBlue = false) => {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(0, 0, width, height);

	if (leftHalfBlue) {
		ctx.fillStyle = 'blue';
		ctx.fillRect(0, 0, width / 2, height);
	}

	return canvas;
};

const encodeFrames = async (
	encodingConfig: ConstructorParameters<typeof VideoSampleSource>[0],
	frames: {
		width: number;
		height: number;
		timestamp?: number;
		duration?: number;
		rotation?: Rotation;
		flip?: boolean;
		leftHalfBlue?: boolean;
	}[],
) => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new VideoSampleSource(encodingConfig);
	output.addVideoTrack(videoSource);
	await output.start();

	for (let i = 0; i < frames.length; i++) {
		const f = frames[i]!;
		const canvas = makeCanvas(f.width, f.height, f.leftHalfBlue);
		const sample = new VideoSample(canvas, {
			timestamp: f.timestamp ?? i / 30,
			duration: f.duration ?? 1 / 30,
			rotation: f.rotation,
			flip: f.flip,
		});
		await videoSource.add(sample);
		sample.close();
	}

	await output.finalize();
	return output.target.buffer!;
};

const readBackTrack = async (buffer: ArrayBuffer) => {
	const input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack() as InputVideoTrack;
	assert(track);

	return { input, track };
};

const readBackSamples = async (buffer: ArrayBuffer) => {
	const { input, track } = await readBackTrack(buffer);
	const sink = new VideoSampleSink(track);
	const samples: { codedWidth: number; codedHeight: number; timestamp: number; duration: number }[] = [];

	for await (using sample of sink.samples()) {
		samples.push({
			codedWidth: sample.codedWidth,
			codedHeight: sample.codedHeight,
			timestamp: sample.timestamp,
			duration: sample.duration,
		});
	}

	input.dispose();
	return samples;
};

test('AudioSampleSource, normal usage', async () => {
	const sample = makeSineWave(48000, 2, 1);
	const buffer = await encodeAudio({ codec: 'pcm-s16' }, sample);

	const { input, track } = await readBackAudioTrack(buffer);
	expect(await track.getNumberOfChannels()).toBe(2);
	expect(await track.getSampleRate()).toBe(48000);
	expect(await track.computeDuration()).toBe(1);
	input.dispose();
});

test('AudioSampleSource, remixed to mono', async () => {
	const sample = makeSineWave(48000, 2, 1);
	const buffer = await encodeAudio(
		{ codec: 'pcm-s16', transform: { numberOfChannels: 1 } },
		sample,
	);

	const { input, track } = await readBackAudioTrack(buffer);
	expect(await track.getNumberOfChannels()).toBe(1);
	expect(await track.getSampleRate()).toBe(48000);
	expect(await track.computeDuration()).toBe(1);
	input.dispose();
});

test('AudioSampleSource, resampled to 44100 Hz', async () => {
	const sample = makeSineWave(48000, 2, 1);
	const buffer = await encodeAudio(
		{ codec: 'pcm-s16', transform: { sampleRate: 44100 } },
		sample,
	);

	const { input, track } = await readBackAudioTrack(buffer);
	expect(await track.getNumberOfChannels()).toBe(2);
	expect(await track.getSampleRate()).toBe(44100);
	expect(await track.computeDuration()).toBe(1);
	input.dispose();
});

test('AudioSampleSource, resampled stereo with non-zero start timestamp', async () => {
	const sample = makeSineWave(48000, 2, 1, 1);
	const buffer = await encodeAudio(
		{ codec: 'pcm-s16', transform: { numberOfChannels: 2 } },
		sample,
	);

	const { input, track } = await readBackAudioTrack(buffer);
	expect(await track.getNumberOfChannels()).toBe(2);
	expect(await track.getSampleRate()).toBe(48000);

	expect(await track.getFirstTimestamp()).toBe(1);
	expect(await track.computeDuration()).toBe(2);
	input.dispose();
});

test('AudioSampleSource, Opus encoding of 44.1 kHz audio keeps its last milliseconds', async () => {
	// The encoder resamples to 48 kHz internally. A click 0.5 ms before the end of 1 s of audio must survive.
	const sampleRate = 44100;
	const data = new Float32Array(sampleRate);
	data[sampleRate - 22] = 1;

	const buffer = await encodeAudio(
		{ codec: 'opus', quality: new Quality('high') },
		new AudioSample({ data, format: 'f32', numberOfChannels: 1, sampleRate, timestamp: 0 }),
	);

	const { input, track } = await readBackAudioTrack(buffer);
	let peak = 0;
	for await (using sample of new AudioSampleSink(track).samples(0.9)) {
		const values = new Float32Array(sample.numberOfFrames);
		sample.copyTo(values, { planeIndex: 0, format: 'f32-planar' });
		peak = Math.max(peak, ...values.map(Math.abs));
	}

	expect(peak).toBeGreaterThan(0.5);
	input.dispose();
});

test('AudioSampleSource, AAC codec string follows the AudioSpecificConfig the encoder produced', async () => {
	// Real AAC-LC frames and AudioSpecificConfig, standing in for an encoder that, like Media Foundation's, produces
	// AAC-LC even when configured for HE-AAC
	using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);
	const lcConfig = await inputTrack.getDecoderConfig();
	assert(lcConfig?.description);
	const frames: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(inputTrack).packets()) {
		frames.push(packet);
		if (frames.length === 50) {
			break;
		}
	}

	class FakeAacEncoder {
		state = 'unconfigured';
		encodeQueueSize = 0;
		config: AudioEncoderConfig | null = null;
		pending: Promise<void>[] = [];
		emittedConfig = false;
		nextFrame = 0;

		constructor(private init: AudioEncoderInit) {}

		static isConfigSupported(config: AudioEncoderConfig) {
			return Promise.resolve({ supported: true, config });
		}

		configure(config: AudioEncoderConfig) {
			this.config = config;
			this.state = 'configured';
		}

		encode(audioData: AudioData) {
			const frameDuration = 1024 / audioData.sampleRate * 1e6;
			for (let i = 0; i < Math.ceil(audioData.numberOfFrames / 1024); i++) {
				const chunk = new EncodedAudioChunk({
					type: 'key',
					timestamp: Math.round(audioData.timestamp + i * frameDuration),
					duration: Math.round(frameDuration),
					data: frames[this.nextFrame++ % frames.length]!.data,
				});
				// The codec string just echoes the configured one
				const meta = this.emittedConfig
					? undefined
					: { decoderConfig: { ...lcConfig!, codec: this.config!.codec } };
				this.emittedConfig = true;
				this.pending.push(Promise.resolve().then(() => this.init.output(chunk, meta)));
			}
		}

		async flush() {
			await Promise.all(this.pending);
		}

		close() {
			this.state = 'closed';
		}

		addEventListener() {}
		removeEventListener() {}
	}

	const globals = globalThis as { AudioEncoder: unknown };
	const OriginalAudioEncoder = globals.AudioEncoder;
	globals.AudioEncoder = FakeAacEncoder;

	try {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new AudioSampleSource({
			codec: 'aac',
			quality: new Quality('medium'),
			fullCodecString: 'mp4a.40.5',
		});
		output.addAudioTrack(source);
		await output.start();

		const sample = makeSineWave(48000, 2, 0.5);
		await source.add(sample);
		sample.close();
		await output.finalize();

		// The AudioSpecificConfig says AAC-LC (object type 2), and so must the codec string
		expect(await output.getMimeType()).toMatch(/codecs="mp4a\.40\.2"/);
	} finally {
		globals.AudioEncoder = OriginalAudioEncoder;
	}
});

test('canEncodeAudio only reports configs that encode audibly', async () => {
	// Firefox claims support for Opus with 3 or 4 channels but fails to encode it, and encodes Vorbis as silence
	const configs = [['opus', 2], ['opus', 3], ['opus', 4], ['opus', 6], ['vorbis', 2]] as const;
	for (const [codec, numberOfChannels] of configs) {
		if (!await canEncodeAudio(codec, { numberOfChannels })) {
			continue;
		}

		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const audioSource = new AudioSampleSource({ codec, quality: new Quality('medium') });
		output.addAudioTrack(audioSource);
		await output.start();
		const sample = makeSineWave(48000, numberOfChannels, 0.5);
		await audioSource.add(sample);
		sample.close();
		await output.finalize();

		const { input, track } = await readBackAudioTrack(output.target.buffer!);
		let peak = 0;
		for await (const decoded of new AudioSampleSink(track).samples()) {
			const values = new Float32Array(decoded.numberOfFrames);
			decoded.copyTo(values, { planeIndex: 0, format: 'f32-planar' });
			decoded.close();
			for (const value of values) {
				peak = Math.max(peak, Math.abs(value));
			}
		}
		input.dispose();

		expect(peak, `${codec}, ${numberOfChannels} channels`).toBeGreaterThan(0.1);
	}
});

const makeSineWave = (
	sampleRate: number,
	numberOfChannels: number,
	durationSeconds: number,
	timestamp = 0,
) => {
	const numberOfFrames = Math.round(sampleRate * durationSeconds);
	const data = new Float32Array(numberOfFrames * numberOfChannels);

	for (let frame = 0; frame < numberOfFrames; frame++) {
		const value = Math.sin(2 * Math.PI * 440 * frame / sampleRate);
		for (let ch = 0; ch < numberOfChannels; ch++) {
			data[frame * numberOfChannels + ch] = value;
		}
	}

	return new AudioSample({
		data,
		format: 'f32-planar',
		sampleRate,
		numberOfChannels,
		numberOfFrames,
		timestamp,
	});
};

const encodeAudio = async (
	encodingConfig: ConstructorParameters<typeof AudioSampleSource>[0],
	sample: AudioSample,
) => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }), // Fragmented to avoid the PCM transformation
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource(encodingConfig);
	output.addAudioTrack(audioSource);
	await output.start();

	await audioSource.add(sample);
	sample.close();

	await output.finalize();
	return output.target.buffer!;
};

const readBackAudioTrack = async (buffer: ArrayBuffer) => {
	const input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack() as InputAudioTrack;
	assert(track);

	return { input, track };
};

test('VideoSampleSource, HEVC output with a description gets an hvc1 codec string', async () => {
	// Real HEVC parameter sets and key frame, since HEVC encoding isn't available everywhere
	using input = new Input({ source: new UrlSource('/video-h265.mp4'), formats: ALL_FORMATS });
	const inputTrack = await input.getPrimaryVideoTrack();
	assert(inputTrack);
	const decoderConfig = await inputTrack.getDecoderConfig();
	assert(decoderConfig?.description);
	const keyPacket = await new EncodedPacketSink(inputTrack).getFirstPacket();
	assert(keyPacket);

	// Stands in for a platform HEVC encoder in its default 'hevc' bitstream format, which provides an hvcC description
	class FakeHevcEncoder {
		state = 'unconfigured';
		encodeQueueSize = 0;
		pending: Promise<void>[] = [];
		emittedConfig = false;

		constructor(private init: VideoEncoderInit) {}

		static isConfigSupported(config: VideoEncoderConfig) {
			return Promise.resolve({ supported: true, config });
		}

		configure() {
			this.state = 'configured';
		}

		encode(frame: VideoFrame) {
			const chunk = new EncodedVideoChunk({ type: 'key', timestamp: frame.timestamp, data: keyPacket!.data });
			const meta = this.emittedConfig
				? undefined
				: { decoderConfig: { ...decoderConfig!, codec: 'hvc1.1.6.L120.90' } };
			this.emittedConfig = true;
			this.pending.push(Promise.resolve().then(() => this.init.output(chunk, meta)));
		}

		async flush() {
			await Promise.all(this.pending);
		}

		close() {
			this.state = 'closed';
		}

		addEventListener() {}
		removeEventListener() {}
	}

	const globals = globalThis as { VideoEncoder: unknown };
	const OriginalVideoEncoder = globals.VideoEncoder;
	globals.VideoEncoder = FakeHevcEncoder;

	try {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new VideoSampleSource({ codec: 'hevc', quality: new Quality('high') });
		output.addVideoTrack(source);
		await output.start();

		const canvas = new OffscreenCanvas(1920, 1080);
		canvas.getContext('2d')!.fillRect(0, 0, 1920, 1080);
		using sample = new VideoSample(canvas, { timestamp: 0, duration: 1 / 30 });
		await source.add(sample);
		await output.finalize();

		// The MP4 sample entry is hvc1, and the codec string must name it
		expect(await output.getMimeType()).toMatch(/codecs="hvc1\./);
	} finally {
		globals.VideoEncoder = OriginalVideoEncoder;
	}
});

test('MediaStreamVideoTrackSource, records every requested frame of a captureStream(0) canvas', async () => {
	const canvas = document.createElement('canvas');
	canvas.width = 64;
	canvas.height = 48;
	document.body.appendChild(canvas);
	const context = canvas.getContext('2d')!;

	// A frame rate of 0 means the canvas only emits frames when requestFrame() is called
	const track = canvas.captureStream(0).getVideoTracks()[0] as CanvasCaptureMediaStreamTrack & MediaStreamVideoTrack;
	expect(track.getSettings().frameRate).toBe(0);

	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new MediaStreamVideoTrackSource(track, {
		codec: 'vp8',
		quality: new Quality('low'),
	});
	let sourceError: unknown = null;
	videoSource.errorPromise.catch((error) => {
		sourceError = error;
	});

	output.addVideoTrack(videoSource);
	await output.start();

	for (let i = 0; i < 10; i++) {
		context.fillStyle = `rgb(${i * 25}, 0, 0)`;
		context.fillRect(0, 0, canvas.width, canvas.height);
		track.requestFrame();
		await new Promise(resolve => setTimeout(resolve, 50));
	}

	await output.finalize();
	track.stop();
	canvas.remove();

	expect(sourceError).toBe(null);

	const { input, track: videoTrack } = await readBackTrack(output.target.buffer!);
	expect((await videoTrack.computePacketStats()).packetCount).toBe(10);
	input.dispose();
});
