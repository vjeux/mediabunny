import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat, WavOutputFormat, WebMOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { AudioSampleSource, MediaStreamAudioTrackSource, VideoSampleSource } from '../../src/media-source.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { Quality } from '../../src/encode.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource } from '../../src/source.js';
import { AudioSampleSink, VideoSampleSink } from '../../src/media-sink.js';
import { assert, Rotation } from '../../src/misc.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';
import { CustomAudioEncoder, customAudioEncoders, registerEncoder } from '../../src/custom-coder.js';
import { EncodedPacket } from '../../src/packet.js';
import { AudioCodec } from '../../src/codec.js';

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

test('MediaStreamAudioTrackSource, a busy main thread loses no audio', async ({ skip }) => {
	const audioContext = new AudioContext({ sampleRate: 48000 });
	await Promise.race([audioContext.resume(), new Promise(resolve => setTimeout(resolve, 1000))]);
	if (audioContext.state !== 'running') {
		await audioContext.close();
		skip('Web Audio cannot run here without a user gesture');
	}

	// A continuous tone, rendered off the main thread
	const destination = audioContext.createMediaStreamDestination();
	const oscillator = audioContext.createOscillator();
	oscillator.frequency.value = 441;
	const gain = audioContext.createGain();
	gain.gain.value = 0.5;
	oscillator.connect(gain).connect(destination);
	oscillator.start();
	const track = destination.stream.getAudioTracks()[0]!;

	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const audioSource = new MediaStreamAudioTrackSource(track, { codec: 'opus', quality: new Quality('high') });
	const errors: unknown[] = [];
	audioSource.errorPromise.catch(error => errors.push(error));
	output.addAudioTrack(audioSource);
	await output.start();

	await new Promise(resolve => setTimeout(resolve, 500));
	const stallStart = performance.now();
	while (performance.now() - stallStart < 300) {
		// A long task keeping the main thread busy for 300 ms
	}
	await new Promise(resolve => setTimeout(resolve, 500));

	await output.finalize();
	track.stop();
	await audioContext.close();
	expect(errors).toEqual([]);

	// Count the 2 ms stretches in which the tone is missing
	const { input, track: audioTrack } = await readBackAudioTrack(output.target.buffer!);
	let missingMs = 0;
	let toneStarted = false;
	for await (using sample of new AudioSampleSink(audioTrack).samples()) {
		const data = new Float32Array(sample.numberOfFrames);
		sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
		for (let i = 0; i + 96 <= data.length; i += 96) {
			const peak = Math.max(...data.subarray(i, i + 96).map(Math.abs));
			if (peak > 0.3) {
				toneStarted = true;
			} else if (toneStarted && peak < 0.05) {
				missingMs += 2;
			}
		}
	}
	input.dispose();

	expect(missingMs).toBeLessThan(60);
});

test('MediaStreamAudioTrackSource, audio behind a busy encoder is kept, but not if captured while paused', async () => {
	// An encoder that holds on to everything until released, so that audio piles up behind it
	let releaseEncoder!: () => void;
	const encoderReleased = new Promise<void>((resolve) => {
		releaseEncoder = resolve;
	});
	class StalledPcmEncoder extends CustomAudioEncoder {
		static override supports(codec: AudioCodec) {
			return codec === 'pcm-f32';
		}

		init() {}

		async encode(audioSample: AudioSample) {
			await encoderReleased;
			const data = new Float32Array(audioSample.numberOfFrames);
			audioSample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
			this.onPacket(
				new EncodedPacket(new Uint8Array(data.buffer), 'key', audioSample.timestamp, audioSample.duration),
				{ decoderConfig: { codec: 'pcm-f32', sampleRate: audioSample.sampleRate, numberOfChannels: 1 } },
			);
		}

		flush() {}
		close() {}
	}
	registerEncoder(StalledPcmEncoder);

	try {
		const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
		const writer = generator.writable.getWriter();
		const output = new Output({
			format: new WavOutputFormat(),
			target: new BufferTarget(),
		});
		const audioSource = new MediaStreamAudioTrackSource(generator as unknown as MediaStreamAudioTrack, {
			codec: 'pcm-f32',
		});
		const errors: unknown[] = [];
		audioSource.errorPromise.catch(error => errors.push(error));
		output.addAudioTrack(audioSource);
		await output.start();

		// 10 ms chunks of a constant value: 0.25 before the pause, 0.75 during it, 0.5 after it
		let chunks = 0;
		const writeChunk = async (value: number) => {
			await writer.write(new AudioData({
				format: 'f32-planar',
				sampleRate: 48000,
				numberOfChannels: 1,
				numberOfFrames: 480,
				timestamp: 10000 * chunks++,
				data: new Float32Array(480).fill(value),
			}));
			await new Promise(resolve => setTimeout(resolve, 12)); // Lets the chunk arrive at the source
		};
		for (let i = 0; i < 10; i++) {
			await writeChunk(0.25);
		}
		audioSource.pause();
		for (let i = 0; i < 3; i++) {
			await writeChunk(0.75);
		}
		audioSource.resume();
		releaseEncoder();
		for (let i = 0; i < 3; i++) {
			await writeChunk(0.5);
		}
		await new Promise(resolve => setTimeout(resolve, 50));
		await output.finalize();
		await writer.close();
		expect(errors).toEqual([]);

		const frameCounts = new Map<number, number>();
		const { input, track } = await readBackAudioTrack(output.target.buffer!);
		for await (using sample of new AudioSampleSink(track).samples()) {
			const data = new Float32Array(sample.numberOfFrames);
			sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
			for (const value of data) {
				frameCounts.set(value, (frameCounts.get(value) ?? 0) + 1);
			}
		}
		input.dispose();

		// All ten chunks from before the pause, although the encoder could only take eight of them at first
		expect(frameCounts.get(0.25)).toBe(4800);
		expect(frameCounts.get(0.75)).toBeUndefined();
		expect(frameCounts.get(0.5)).toBeGreaterThan(0);
	} finally {
		releaseEncoder();
		customAudioEncoders.splice(customAudioEncoders.indexOf(StalledPcmEncoder), 1);
	}
});
