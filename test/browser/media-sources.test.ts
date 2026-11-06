import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat, WebMOutputFormat, MkvOutputFormat } from '../../src/output-format.js';
import { BufferTarget, StreamTarget } from '../../src/target.js';
import {
	AudioSampleSource,
	MediaStreamVideoTrackSource,
	VideoSampleSource,
	MediaStreamAudioTrackSource,
} from '../../src/media-source.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { canEncodeAudio, Quality, VideoTransformOptions } from '../../src/encode.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { EncodedPacketSink, VideoSampleSink, AudioSampleSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { assert, Rotation, toDataView } from '../../src/misc.js';
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

test.each([0, 0.3 - (0.1 + 0.2)])(
	'VideoSampleSource, transform.frameRate puts a timestamp of %s on the first frame',
	async (timestamp) => {
		// 0.3 - (0.1 + 0.2) is -5.55e-17
		const buffer = await encodeFrames(
			{ codec: 'vp8', quality: new Quality('medium'), transform: { frameRate: 30 } },
			[{ width: 100, height: 100, timestamp, duration: 1 / 30 }],
		);

		const samples = await readBackSamples(buffer);
		expect(samples.map(x => x.timestamp)).toEqual([0]);
	},
);

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

test('VideoSampleSource, VP9 codec string level accounts for frame rate, bitrate and a requested level', async () => {
	const encodeVp9 = async (
		width: number,
		height: number,
		frameRate: number,
		config: Omit<ConstructorParameters<typeof VideoSampleSource>[0], 'codec'>,
	) => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const videoSource = new VideoSampleSource({ codec: 'vp9', ...config });
		output.addVideoTrack(videoSource, { frameRate });
		await output.start();

		for (let i = 0; i < 2; i++) {
			using sample = new VideoSample(makeCanvas(width, height), {
				timestamp: i / frameRate,
				duration: 1 / frameRate,
			});
			await videoSource.add(sample);
		}

		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		return (await track.getCodecParameterString())!.slice(0, 13);
	};

	// The frame size alone fits level 2.1, but at 60 fps it exceeds its luma sample rate (9216000/s)
	expect(await encodeVp9(640, 360, 60, { quality: new Quality('medium') })).toBe('vp09.00.30.08');
	// Level 2 by frame size, but 4 Mbps exceeds the maximum bitrate of levels 2 and 2.1
	expect(await encodeVp9(320, 240, 30, { quality: new Quality({ bitrate: 4_000_000 }) })).toBe('vp09.00.30.08');
	expect(await encodeVp9(320, 240, 30, { quality: new Quality('medium'), fullCodecString: 'vp09.00.41.08' }))
		.toBe('vp09.00.41.08');
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

test('VideoSampleSource, transform.frameRate is the frame rate the encoder is configured with', async () => {
	const configuredFramerate = async (transform: VideoTransformOptions) => {
		let framerate: number | undefined;
		await encodeFrames(
			{
				codec: 'vp8',
				quality: new Quality('medium'),
				transform,
				onEncoderConfig: (config) => {
					framerate = config.framerate;
				},
			},
			[{ width: 64, height: 64, timestamp: 0, duration: 1 / 60 }],
		);
		return framerate;
	};

	expect(await configuredFramerate({ frameRate: 60 })).toBe(60);
	// A process function may change the rate frames come out at
	expect(await configuredFramerate({ frameRate: 60, process: sample => sample })).toBe(undefined);
});

test('VideoSampleSource, quality-level bitrates grow above 30 fps while explicit bitrates stay', async () => {
	const configuredBitrate = async (quality: Quality, frameRate: number) => {
		let bitrate: number | undefined;
		await encodeFrames(
			{
				codec: 'vp8',
				quality,
				transform: { frameRate },
				onEncoderConfig: (config) => {
					bitrate = config.bitrate;
				},
			},
			[{ width: 64, height: 64, timestamp: 0, duration: 1 / frameRate }],
		);
		return bitrate!;
	};

	const bitrate30 = await configuredBitrate(new Quality('medium'), 30);
	expect(await configuredBitrate(new Quality('medium'), 24)).toBe(bitrate30);
	// Bitrates are rounded up to whole kbps
	expect(Math.abs(await configuredBitrate(new Quality('medium'), 60) - 2 * bitrate30)).toBeLessThanOrEqual(1000);
	expect(await configuredBitrate(new Quality({ bitrate: 300_000 }), 60)).toBe(300_000);
});

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

test('AudioSampleSource, Opus encoding of 16 kHz audio keeps its timing', async () => {
	const sampleRate = 16000;
	const data = new Float32Array(sampleRate);
	for (let i = 0; i < data.length; i++) {
		data[i] = 0.1 * Math.sin(2 * Math.PI * 440 * i / sampleRate);
	}
	data[sampleRate / 4] = 0.9; // A click at 0.25 s

	const buffer = await encodeAudio(
		{ codec: 'opus', quality: new Quality('medium') },
		new AudioSample({ data, format: 'f32', sampleRate, numberOfChannels: 1, timestamp: 0 }),
	);

	const { input, track } = await readBackAudioTrack(buffer);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig?.description);
	// RFC 7845 counts the pre-skip in 48 kHz samples: 312 is libopus's 6.5 ms lookahead
	expect(toDataView(decoderConfig.description).getUint16(10, true)).toBe(312);

	let peakTime = 0;
	let peakValue = 0;
	for await (using sample of new AudioSampleSink(track).samples()) {
		const values = new Float32Array(sample.numberOfFrames);
		sample.copyTo(values, { planeIndex: 0, format: 'f32-planar' });

		for (let i = 0; i < values.length; i++) {
			if (Math.abs(values[i]!) > peakValue) {
				peakValue = Math.abs(values[i]!);
				peakTime = sample.timestamp + i / sample.sampleRate;
			}
		}
	}

	expect(Math.abs(peakTime - 0.25)).toBeLessThan(0.001);
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

test.each(['audio', 'video'] as const)(
	'MediaStream sources, an ended %s track stops holding back the other track',
	async (endingTrack) => {
		const videoGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
		const audioGenerator = new MediaStreamTrackGenerator({ kind: 'audio' });
		const videoWriter = videoGenerator.writable.getWriter();
		const audioWriter = audioGenerator.writable.getWriter();

		let trackEndedAt: number | null = null;
		let lateFragments = 0;
		const output = new Output({
			format: new Mp4OutputFormat({
				fastStart: 'fragmented',
				minimumFragmentDuration: 0.25,
				onMoof: () => {
					// Count the fragments written well after the track ended
					if (trackEndedAt !== null && performance.now() - trackEndedAt > 300) {
						lateFragments++;
					}
				},
			}),
			target: new StreamTarget(new WritableStream()),
		});

		const videoSource = new MediaStreamVideoTrackSource(videoGenerator as unknown as MediaStreamVideoTrack, {
			codec: 'vp8',
			quality: new Quality('low'),
			keyFrameInterval: 0.25,
		});
		const audioSource = new MediaStreamAudioTrackSource(audioGenerator as unknown as MediaStreamAudioTrack, {
			codec: 'opus',
			quality: new Quality('low'),
		});
		const errors: unknown[] = [];
		videoSource.errorPromise.catch(error => errors.push(error));
		audioSource.errorPromise.catch(error => errors.push(error));

		output.addVideoTrack(videoSource);
		output.addAudioTrack(audioSource);
		await output.start();

		// Feed both tracks in real time, end one of them after 0.6 s and keep feeding the other for another second
		const canvas = new OffscreenCanvas(64, 48);
		const context = canvas.getContext('2d')!;
		const start = performance.now();
		let videoFrames = 0;
		let audioChunks = 0;

		while (performance.now() - start < 1600) {
			const elapsed = performance.now() - start;

			if (elapsed >= 600 && trackEndedAt === null) {
				await (endingTrack === 'audio' ? audioWriter : videoWriter).close();
				trackEndedAt = performance.now();
			}

			while (audioChunks * 10 <= elapsed && (endingTrack !== 'audio' || trackEndedAt === null)) {
				await audioWriter.write(new AudioData({
					format: 'f32-planar',
					sampleRate: 48000,
					numberOfChannels: 1,
					numberOfFrames: 480,
					timestamp: 1000 * (start + 10 * audioChunks),
					data: new Float32Array(480),
				}));
				audioChunks++;
			}

			while (videoFrames * 40 <= elapsed && (endingTrack !== 'video' || trackEndedAt === null)) {
				context.fillStyle = `rgb(${videoFrames * 5}, 0, 0)`;
				context.fillRect(0, 0, canvas.width, canvas.height);
				await videoWriter.write(new VideoFrame(canvas, { timestamp: 1000 * (start + 40 * videoFrames) }));
				videoFrames++;
			}

			await new Promise(resolve => setTimeout(resolve, 5));
		}

		const lateFragmentsBeforeFinalize = lateFragments;
		await output.finalize();

		expect(errors).toEqual([]);
		expect(lateFragmentsBeforeFinalize).toBeGreaterThan(0);
	},
);

test.for(['video', 'audio'] as const)(
	'MediaStream sources, track.stop() closes the %s source when capturing without MediaStreamTrackProcessor',
	async (kind, { skip }) => {
		// Without MediaStreamTrackProcessor (Firefox, Safari), video is sampled from a <video> element and audio comes
		// through a ScriptProcessorNode. Stopping a track with track.stop() fires no 'ended' event.
		let track: MediaStreamVideoTrack | MediaStreamAudioTrack;
		let audioContext: AudioContext | null = null;
		let stopDrawing = () => {};
		if (kind === 'video') {
			const canvas = document.createElement('canvas');
			canvas.width = 64;
			canvas.height = 48;
			document.body.appendChild(canvas);
			const context = canvas.getContext('2d')!;
			let frame = 0;
			const drawInterval = setInterval(() => {
				context.fillStyle = `rgb(${frame++ % 256}, 0, 0)`;
				context.fillRect(0, 0, canvas.width, canvas.height);
			}, 20);
			stopDrawing = () => {
				clearInterval(drawInterval);
				canvas.remove();
			};
			track = canvas.captureStream(30).getVideoTracks()[0]!;
		} else {
			audioContext = new AudioContext();
			await Promise.race([audioContext.resume(), new Promise(resolve => setTimeout(resolve, 1000))]);
			if (audioContext.state !== 'running') {
				await audioContext.close();
				skip('Web Audio cannot run here without a user gesture');
			}
			const destination = audioContext.createMediaStreamDestination();
			const oscillator = audioContext.createOscillator();
			oscillator.connect(destination);
			oscillator.start();
			track = destination.stream.getAudioTracks()[0]!;
		}

		const output = new Output({
			format: new WebMOutputFormat(),
			target: new BufferTarget(),
		});
		const errors: unknown[] = [];
		if (track.kind === 'video') {
			const source = new MediaStreamVideoTrackSource(track, { codec: 'vp8', quality: new Quality('low') });
			source.errorPromise.catch(error => errors.push(error));
			output.addVideoTrack(source);
		} else {
			const source = new MediaStreamAudioTrackSource(track, { codec: 'opus', quality: new Quality('low') });
			source.errorPromise.catch(error => errors.push(error));
			output.addAudioTrack(source);
		}

		const globals = globalThis as { MediaStreamTrackProcessor?: unknown };
		const processor = globals.MediaStreamTrackProcessor;
		globals.MediaStreamTrackProcessor = undefined;
		try {
			await output.start();
		} finally {
			globals.MediaStreamTrackProcessor = processor;
		}

		await new Promise(resolve => setTimeout(resolve, 600));
		track.stop();
		await new Promise(resolve => setTimeout(resolve, 600));
		await output.finalize();
		stopDrawing();
		await audioContext?.close();

		expect(errors).toEqual([]);

		// The recording ends where the track was stopped, instead of repeating the last frame (or silence) until
		// finalize()
		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const duration = await input.computeDuration();
		expect(duration).toBeGreaterThan(0.3);
		expect(duration).toBeLessThan(0.9);
	},
);

test('MediaStream sources, pausing and resuming keeps audio and video in sync', async () => {
	// A video track that emits no frames while paused (like a canvas that doesn't change), next to continuous audio
	const videoGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
	const audioGenerator = new MediaStreamTrackGenerator({ kind: 'audio' });
	const videoWriter = videoGenerator.writable.getWriter();
	const audioWriter = audioGenerator.writable.getWriter();

	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new MediaStreamVideoTrackSource(
		videoGenerator as unknown as MediaStreamVideoTrack,
		{ codec: 'vp8', quality: new Quality('low') },
		{ frameRate: null },
	);
	const audioSource = new MediaStreamAudioTrackSource(audioGenerator as unknown as MediaStreamAudioTrack, {
		codec: 'opus',
		quality: new Quality('low'),
	});
	const errors: unknown[] = [];
	videoSource.errorPromise.catch(error => errors.push(error));
	audioSource.errorPromise.catch(error => errors.push(error));

	output.addVideoTrack(videoSource);
	output.addAudioTrack(audioSource);
	await output.start();

	// Record for 0.5 s, pause for 0.8 s, then record for another 0.5 s
	const canvas = new OffscreenCanvas(64, 48);
	const context = canvas.getContext('2d')!;
	const start = performance.now();
	let videoFrames = 0;
	let audioChunks = 0;

	while (performance.now() - start < 1800) {
		const elapsed = performance.now() - start;

		if (elapsed >= 500 && elapsed < 1300 && !videoSource.paused) {
			videoSource.pause();
			audioSource.pause();
		} else if (elapsed >= 1300 && videoSource.paused) {
			videoSource.resume();
			audioSource.resume();
		}

		while (audioChunks * 10 <= elapsed) {
			await audioWriter.write(new AudioData({
				format: 'f32-planar',
				sampleRate: 48000,
				numberOfChannels: 1,
				numberOfFrames: 480,
				timestamp: 1000 * (start + 10 * audioChunks),
				data: new Float32Array(480),
			}));
			audioChunks++;
		}

		while (videoFrames * 40 <= elapsed) {
			if (!videoSource.paused) {
				context.fillStyle = `rgb(${videoFrames * 5}, 0, 0)`;
				context.fillRect(0, 0, canvas.width, canvas.height);
				await videoWriter.write(new VideoFrame(canvas, { timestamp: 1000 * (start + 40 * videoFrames) }));
			}
			videoFrames++;
		}

		await new Promise(resolve => setTimeout(resolve, 5));
	}

	await output.finalize();
	await videoWriter.close();
	await audioWriter.close();
	expect(errors).toEqual([]);

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const videoEnd = await (await input.getPrimaryVideoTrack())!.computeDuration();
	const audioEnd = await (await input.getPrimaryAudioTrack())!.computeDuration();
	input.dispose();

	// Both tracks lost the same 0.8 s to the pause
	expect(audioEnd).toBeCloseTo(1, 0);
	expect(Math.abs(videoEnd - audioEnd)).toBeLessThan(0.1);
});

test('MediaStreamAudioTrackSource, the Web Audio fallback keeps audio in sync like MediaStreamTrackProcessor', async ({
	skip,
}) => {
	// Without MediaStreamTrackProcessor (Firefox, Safari), audio is captured through a ScriptProcessorNode. Record the
	// same beeps and flashes both ways and compare where the beeps land relative to the flashes.
	const withProcessor = await measureBeepToFlashOffset(false);
	const withFallback = await measureBeepToFlashOffset(true);
	if (withProcessor === null || withFallback === null) {
		skip('Web Audio cannot run here without a user gesture');
	}

	expect(Math.abs(withFallback! - withProcessor!)).toBeLessThan(0.045);
});

/** Records 100 ms flashes and beeps every 500 ms and returns their mean offset (beep - flash) in the file. */
const measureBeepToFlashOffset = async (hideMediaStreamTrackProcessor: boolean) => {
	const audioContext = new AudioContext();
	await Promise.race([audioContext.resume(), new Promise(resolve => setTimeout(resolve, 1000))]);

	// A running context may not have rendered yet, and until it has, getOutputTimestamp() maps context time 0 to
	// performance time 0: the beeps would be scheduled at the page's age, minutes late in a long test run
	const renderWaitStart = performance.now();
	while (
		audioContext.state === 'running'
		&& audioContext.currentTime === 0
		&& performance.now() - renderWaitStart < 2000
	) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	if (audioContext.state !== 'running' || audioContext.currentTime === 0) {
		await audioContext.close();
		return null;
	}

	const destination = audioContext.createMediaStreamDestination();
	const oscillator = audioContext.createOscillator();
	oscillator.frequency.value = 1000;
	const gain = audioContext.createGain();
	gain.gain.value = 0;
	oscillator.connect(gain).connect(destination);
	oscillator.start();

	const canvas = document.createElement('canvas');
	canvas.width = 64;
	canvas.height = 48;
	document.body.appendChild(canvas);
	const context = canvas.getContext('2d')!;
	// 60 FPS keeps the frame quantization of the flashes small
	const videoTrack = canvas.captureStream(60).getVideoTracks()[0]!;
	const audioTrack = destination.stream.getAudioTracks()[0]!;

	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});
	output.addVideoTrack(new MediaStreamVideoTrackSource(videoTrack, { codec: 'vp8', quality: new Quality('low') }));
	output.addAudioTrack(new MediaStreamAudioTrackSource(audioTrack, { codec: 'pcm-f32' }));

	const globals = globalThis as { MediaStreamTrackProcessor?: unknown };
	const processor = globals.MediaStreamTrackProcessor;
	if (hideMediaStreamTrackProcessor) {
		globals.MediaStreamTrackProcessor = undefined;
	}
	try {
		await output.start();
	} finally {
		globals.MediaStreamTrackProcessor = processor;
	}

	// Schedule the beeps at the same moments the flashes start
	const start = performance.now() + 300;
	const { contextTime, performanceTime } = audioContext.getOutputTimestamp();
	for (let i = 0; i < 6; i++) {
		const beepTime = contextTime! + (start + 500 * i - performanceTime!) / 1000;
		gain.gain.setValueAtTime(0.5, beepTime);
		gain.gain.setValueAtTime(0, beepTime + 0.1);
	}
	let lastColor = '';
	const drawInterval = setInterval(() => {
		const elapsed = performance.now() - start;
		const color = elapsed >= 0 && elapsed % 500 < 100 ? 'white' : 'black';
		if (color !== lastColor) {
			context.fillStyle = color;
			context.fillRect(0, 0, canvas.width, canvas.height);
			lastColor = color;
		}
	}, 2);
	await new Promise(resolve => setTimeout(resolve, 3300));

	await output.finalize();
	clearInterval(drawInterval);
	videoTrack.stop();
	audioTrack.stop();
	canvas.remove();
	await audioContext.close();

	const input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const flashes: number[] = [];
	const lumaCanvas = new OffscreenCanvas(1, 1);
	const lumaContext = lumaCanvas.getContext('2d', { willReadFrequently: true })!;
	let wasBright = false;
	for await (using sample of new VideoSampleSink((await input.getPrimaryVideoTrack())!).samples()) {
		sample.draw(lumaContext, 0, 0, 1, 1);
		const isBright = lumaContext.getImageData(0, 0, 1, 1).data[0]! > 128;
		if (isBright && !wasBright) {
			flashes.push(sample.timestamp);
		}
		wasBright = isBright;
	}

	const beeps: number[] = [];
	let quietFrames = Infinity;
	for await (using sample of new AudioSampleSink((await input.getPrimaryAudioTrack())!).samples()) {
		const data = new Float32Array(sample.numberOfFrames);
		sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
		for (let i = 0; i < data.length; i++) {
			if (Math.abs(data[i]!) < 0.25) {
				quietFrames++;
				continue;
			}
			if (quietFrames > 0.2 * sample.sampleRate) {
				beeps.push(sample.timestamp + i / sample.sampleRate);
			}
			quietFrames = 0;
		}
	}
	input.dispose();

	const offsets = flashes
		.map(flash => beeps.find(beep => Math.abs(beep - flash) < 0.2)! - flash)
		.filter(offset => !Number.isNaN(offset));
	expect(offsets.length).toBeGreaterThanOrEqual(4);
	return offsets.reduce((a, b) => a + b, 0) / offsets.length;
};
