import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat, WebMOutputFormat, WavOutputFormat } from '../../src/output-format.js';
import { BufferTarget, StreamTarget, StreamTargetChunk } from '../../src/target.js';
import {
	AudioSampleSource,
	MediaStreamVideoTrackSource,
	VideoSampleSource,
	MediaStreamAudioTrackSource,
	CanvasSource,
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

// First in this file on purpose: the priming of an encoder is only measured for its first use on the page
test('AudioSampleSource, encoding starts even when measuring the encoder\'s priming hangs', async () => {
	// The measurement decodes the encoder's output, and some platform decoders never finish flushing (WebKitGTK's
	// Vorbis decoder). Emulated by an AudioDecoder whose flush() never settles
	let decoderCount = 0;
	const RealAudioDecoder = AudioDecoder;
	globalThis.AudioDecoder = class extends RealAudioDecoder {
		constructor(init: AudioDecoderInit) {
			super(init);
			decoderCount++;
		}

		override flush() {
			return new Promise<void>(() => {});
		}
	};

	const encode = async () => {
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const source = new AudioSampleSource({ codec: 'opus', quality: new Quality('medium') });
		output.addAudioTrack(source);
		await output.start();

		using sample = new AudioSample({
			data: new Float32Array(960),
			format: 'f32',
			numberOfChannels: 1,
			sampleRate: 48000,
			timestamp: 0,
		});
		await source.add(sample);
		await output.finalize();
		return 'finalized';
	};

	try {
		for (let i = 1; i <= 2; i++) {
			expect(await Promise.race([
				encode(),
				new Promise(resolve => setTimeout(() => resolve('hung'), 6000)),
			])).toBe('finalized');

			// The timed-out measurement isn't remembered, so the next encoder measures again (and nothing stays cached
			// for the tests after this one)
			expect(decoderCount).toBe(i);
		}
	} finally {
		globalThis.AudioDecoder = RealAudioDecoder;
	}
}, 15_000);

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

test('AudioSampleSource, the encoder priming measurement skips empty decoder outputs', async () => {
	// Firefox's Vorbis decoder starts with an AudioData of 0 frames, which can't be copied from. Emulated by handing
	// such an output to the first AudioDecoder (the one measuring the encoder's priming) ahead of its real ones
	const errors: unknown[] = [];
	const onError = (event: ErrorEvent) => errors.push(event.error);
	window.addEventListener('error', onError);
	const RealAudioDecoder = AudioDecoder;
	let emptyOutputGiven = false;
	globalThis.AudioDecoder = class extends RealAudioDecoder {
		constructor(init: AudioDecoderInit) {
			super({
				...init,
				output: (audioData) => {
					if (!emptyOutputGiven) {
						emptyOutputGiven = true;
						init.output({
							numberOfFrames: 0,
							copyTo: () => {
								throw new RangeError('Frame offset of 0 greater or equal than frame count 0');
							},
							close: () => {},
						} as unknown as AudioData);
					}

					init.output(audioData);
				},
			});
		}
	};

	try {
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const source = new AudioSampleSource({ codec: 'opus', quality: new Quality('medium') });
		output.addAudioTrack(source);
		await output.start();

		// Stereo at 24 kHz, which no other test encodes, as the measurement only runs for the first encoder of a
		// configuration on the page
		using sample = new AudioSample({
			data: new Float32Array(2 * 480),
			format: 'f32',
			numberOfChannels: 2,
			sampleRate: 24000,
			timestamp: 0,
		});
		await source.add(sample);
		globalThis.AudioDecoder = RealAudioDecoder;
		await output.finalize();
	} finally {
		globalThis.AudioDecoder = RealAudioDecoder;
		window.removeEventListener('error', onError);
	}

	expect(emptyOutputGiven).toBe(true);
	expect(errors).toEqual([]);
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

test.each([
	['avc', 'discard'],
	['vp9', 'keep'],
] as const)('VideoSampleSource, %s encoding of frames with negative timestamps (alpha: %s)', async (codec, alpha) => {
	// Emulates Windows' Media Foundation hardware encoders, which wrap negative timestamps around and stall: a negative
	// timestamp breaks the encoder, and its flush() then never settles
	const encoderTimestamps: number[] = [];
	const RealVideoEncoder = VideoEncoder;
	globalThis.VideoEncoder = class extends RealVideoEncoder {
		private broken = false;

		override encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions) {
			encoderTimestamps.push(frame.timestamp);
			this.broken ||= frame.timestamp < 0;
			if (!this.broken) {
				super.encode(frame, options);
			}
		}

		override flush() {
			return this.broken ? new Promise<void>(() => {}) : super.flush();
		}
	};

	try {
		const output = new Output({
			format: codec === 'avc' ? new Mp4OutputFormat() : new WebMOutputFormat(),
			target: new BufferTarget(),
		});
		const packetTimestamps: number[] = [];
		const source = new VideoSampleSource({
			codec,
			quality: new Quality('medium'),
			alpha,
			onEncodedPacket: packet => packetTimestamps.push(packet.timestamp),
		});
		output.addVideoTrack(source);
		await output.start();

		const canvas = new OffscreenCanvas(64, 64);
		canvas.getContext('2d')!.fillRect(0, 0, 32, 64); // Half transparent, for the alpha encoder
		const timestamps = Array.from({ length: 30 }, (_, i) => -1.5 + i / 30);
		const encoding = (async () => {
			for (const timestamp of timestamps) {
				using sample = new VideoSample(canvas, { timestamp, duration: 1 / 30 });
				await source.add(sample);
			}
			await output.finalize();
			return 'finalized';
		})();

		expect(await Promise.race([
			encoding,
			new Promise(resolve => setTimeout(() => resolve('hung'), 5000)),
		])).toBe('finalized');
		expect(Math.min(...encoderTimestamps)).toBeGreaterThanOrEqual(0);
		// The packets keep the frames' timestamps exactly
		expect(packetTimestamps.sort((a, b) => a - b)).toEqual(timestamps);
	} finally {
		globalThis.VideoEncoder = RealVideoEncoder;
	}
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

test.each(['video', 'audio'] as const)(
	'Canceling while the first %s sample\'s async process function runs closes the encoder',
	async (type) => {
		// Keep track of the encoders that get created
		const encoders: (VideoEncoder | AudioEncoder)[] = [];
		const RealVideoEncoder = VideoEncoder;
		const RealAudioEncoder = AudioEncoder;
		globalThis.VideoEncoder = class extends RealVideoEncoder {
			constructor(init: VideoEncoderInit) {
				super(init);
				encoders.push(this);
			}
		};
		globalThis.AudioEncoder = class extends RealAudioEncoder {
			constructor(init: AudioEncoderInit) {
				super(init);
				encoders.push(this);
			}
		};

		try {
			let release!: () => void;
			const gate = new Promise<void>(resolve => release = resolve);
			const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });

			let addPromise: Promise<void>;
			if (type === 'video') {
				const source = new VideoSampleSource({
					codec: 'vp9',
					quality: new Quality('medium'),
					transform: {
						process: async (sample) => {
							await gate;
							return sample;
						},
					},
				});
				output.addVideoTrack(source);
				await output.start();

				using sample = new VideoSample(new Uint8Array(320 * 240 * 4), {
					format: 'RGBA', codedWidth: 320, codedHeight: 240, timestamp: 0, duration: 1 / 30,
				});
				addPromise = source.add(sample);
			} else {
				const source = new AudioSampleSource({
					codec: 'opus',
					quality: new Quality('medium'),
					transform: {
						process: async (sample) => {
							await gate;
							return sample;
						},
					},
				});
				output.addAudioTrack(source);
				await output.start();

				using sample = new AudioSample({
					data: new Float32Array(2 * 960),
					format: 'f32',
					numberOfChannels: 2,
					sampleRate: 48000,
					timestamp: 0,
				});
				addPromise = source.add(sample);
			}

			await new Promise(resolve => setTimeout(resolve, 20));
			await output.cancel();
			release();
			await addPromise.catch(() => {});

			expect(encoders.map(x => x.state)).not.toContain('configured');
		} finally {
			globalThis.VideoEncoder = RealVideoEncoder;
			globalThis.AudioEncoder = RealAudioEncoder;
		}
	},
);

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

test.each([
	['vp9', { width: 45, height: 81, fit: 'fill' }, [45, 81]],
	['vp9', { crop: { left: 10, top: 10, width: 45, height: 81 } }, [45, 81]],
	['avc', { crop: { left: 10, top: 10, width: 45, height: 81 } }, [46, 82]], // AVC needs even dimensions
] as const)('VideoSampleSource, %s keeps transformed sizes it can encode (%o)', async (codec, transform, size) => {
	const buffer = await encodeFrames(
		{ codec, quality: new Quality('medium'), transform },
		[{ width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples.map(x => [x.codedWidth, x.codedHeight])).toEqual([size, size]);
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

test('VideoSampleSource, canceling while transform.frameRate pads a gap ends the add quietly', async () => {
	const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	const source = new VideoSampleSource({
		codec: 'vp9',
		quality: new Quality('high'),
		transform: { frameRate: 30 },
	});
	output.addVideoTrack(source);
	await output.start();

	const makeSample = (timestamp: number) => new VideoSample(new Uint8Array(640 * 480 * 4), {
		format: 'RGBA', codedWidth: 640, codedHeight: 480, timestamp, duration: 1 / 30,
	});
	using first = makeSample(0);
	await source.add(first);

	using second = makeSample(2); // A 2 s gap, padded with about 59 repeated frames
	const addPromise = source.add(second);
	await output.cancel();

	const error = await addPromise.then(() => null, (error: Error) => error);
	expect(error === null || error.message === 'Output has been canceled.', String(error)).toBe(true);
});

test.each([false, true])(
	'VideoSampleSource, canceling while a frame is transformed leaves no sample open (during the add: %s)',
	async (cancelDuringAdd) => {
		// Counts the samples made by clone() and transform() that are never closed, and lets transform() be held back
		// like a slow one (large frames, a busy GPU)
		const open = new Set<VideoSample>();
		const prototype = VideoSample.prototype as unknown as {
			clone: (this: VideoSample) => VideoSample;
			close: (this: VideoSample) => void;
			transform: (this: VideoSample, ...args: unknown[]) => Promise<VideoSample>;
		};
		const { clone, close, transform } = prototype;
		let gate: Promise<void> | null = null;
		prototype.clone = function () {
			const sample = clone.call(this);
			open.add(sample);
			return sample;
		};
		prototype.close = function () {
			open.delete(this);
			close.call(this);
		};
		prototype.transform = async function (...args) {
			if (gate) {
				await gate;
			}
			const sample = await transform.apply(this, args);
			open.add(sample);
			return sample;
		};

		try {
			const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
			const source = new VideoSampleSource({
				codec: 'avc',
				quality: new Quality('medium'),
				transform: { width: 32, height: 32, fit: 'fill', frameRate: 30 },
			});
			output.addVideoTrack(source);
			await output.start();

			const makeSample = (timestamp: number) => new VideoSample(makeCanvas(64, 64), {
				timestamp,
				duration: 1 / 30,
			});

			using first = makeSample(0);
			await source.add(first);

			using second = makeSample(0.5);
			let release = () => {};
			if (cancelDuringAdd) {
				gate = new Promise<void>(resolve => release = resolve);
			}
			const addPromise = source.add(second).catch(() => {});
			if (cancelDuringAdd) {
				await output.cancel(); // Completes while the add still awaits the transform
				release();
			}
			await addPromise;
			if (!cancelDuringAdd) {
				await output.cancel();
			}

			expect(open.size).toBe(0);
		} finally {
			Object.assign(prototype, { clone, close, transform });
		}
	},
);

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

test.each([10, 1800000000])(
	'VideoSampleSource, transform.frameRate puts a timestamp 1 ms before the frame at %s s in the frame before',
	async (boundary) => {
		// Only floating point error may be snapped away, also at Unix-epoch-scale timestamps
		const timestamps: number[] = [];
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const videoSource = new VideoSampleSource({
			codec: 'vp8',
			quality: new Quality('medium'),
			transform: { frameRate: 30 },
			onEncodedSample: sample => timestamps.push(sample.timestamp),
		});
		output.addVideoTrack(videoSource, { isRelativeToUnixEpoch: true });
		await output.start();

		using sample = new VideoSample(makeCanvas(100, 100), { timestamp: boundary - 0.001, duration: 1 / 30 });
		await videoSource.add(sample);
		await output.finalize();

		expect(timestamps[0]).toBe((boundary * 30 - 1) / 30);
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

test.each([undefined, 10])('CanvasSource closes every frame it captures (frame rate: %s)', async (frameRate) => {
	// Count the VideoFrames still open at the end
	const createdFrames: VideoFrame[] = [];
	const RealVideoFrame = VideoFrame;
	globalThis.VideoFrame = new Proxy(RealVideoFrame, {
		construct: (target, args) => {
			const frame = Reflect.construct(target, args) as VideoFrame;
			createdFrames.push(frame);
			return frame;
		},
	});

	try {
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const canvas = new OffscreenCanvas(320, 240);
		const context = canvas.getContext('2d')!;
		const canvasSource = new CanvasSource(canvas, {
			codec: 'vp8',
			quality: new Quality('medium'),
			transform: frameRate !== undefined ? { frameRate } : undefined,
		});
		output.addVideoTrack(canvasSource);
		await output.start();

		for (let i = 0; i < 30; i++) {
			context.fillStyle = `hsl(${i * 10}, 80%, 50%)`;
			context.fillRect(0, 0, 320, 240);
			await canvasSource.add(i / 30, 1 / 30);
		}

		await output.finalize();
	} finally {
		globalThis.VideoFrame = RealVideoFrame;
	}

	expect(createdFrames.length).toBeGreaterThan(0);
	expect(createdFrames.filter(frame => frame.format !== null)).toHaveLength(0);
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

test('VideoSampleSource, frame rate normalization puts a key frame request on the first frame showing it', async () => {
	const keyFrameTimestamps = async (
		requestVia: 'add' | 'sample',
		frames: { timestamp: number; duration: number; keyFrame?: boolean }[],
		frameRate?: number,
	) => {
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const source = new VideoSampleSource({
			codec: 'vp9',
			quality: new Quality('medium'),
			keyFrameInterval: 100,
			transform: frameRate ? { frameRate } : undefined,
		});
		output.addVideoTrack(source);
		await output.start();

		const canvas = new OffscreenCanvas(48, 48);
		const context = canvas.getContext('2d')!;
		for (const [i, frame] of frames.entries()) {
			context.fillStyle = `rgb(${(i * 20) % 256}, 0, 0)`;
			context.fillRect(0, 0, 48, 48);
			const sample = new VideoSample(canvas, {
				timestamp: frame.timestamp,
				duration: frame.duration,
				encodeOptions: requestVia === 'sample' && frame.keyFrame ? { keyFrame: true } : undefined,
			});
			await source.add(sample, requestVia === 'add' && frame.keyFrame ? { keyFrame: true } : undefined);
			sample.close();
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, {
			verifyKeyPackets: true,
		})) {
			if (packet.type === 'key') {
				timestamps.push(Math.round(packet.timestamp * 1000) / 1000);
			}
		}
		return timestamps;
	};

	// 10 fps, with a key frame requested for the frame at 0.5 s
	const tenFps = Array.from({ length: 10 }, (_, i) => ({ timestamp: i / 10, duration: 1 / 10, keyFrame: i === 5 }));
	// Like a screen capture that only emits frames on change: the frame at 0.05 s takes the first 10 fps slot from the
	// one at 0 s, and nothing changes until 0.3 s, so its picture first shows at 0.1 s, as padding
	const onChange = [
		{ timestamp: 0, duration: 0.05 },
		{ timestamp: 0.05, duration: 0.25, keyFrame: true },
		{ timestamp: 0.3, duration: 0.1 },
		{ timestamp: 0.4, duration: 0.1 },
	];
	// 32 fps down to 8 fps: the frame at 0.15625 s that asks for a key frame is dropped, so the next one shown takes it
	const thirtyTwoFps = Array.from({ length: 32 }, (_, i) => ({
		timestamp: i / 32,
		duration: 1 / 32,
		keyFrame: i === 5,
	}));

	for (const requestVia of ['add', 'sample'] as const) {
		// Normalized to 30 fps, each input frame is followed by two repeats, which aren't the frame that asked
		expect(await keyFrameTimestamps(requestVia, tenFps, 30)).toEqual([0, 0.5]);
		expect(await keyFrameTimestamps(requestVia, tenFps)).toEqual([0, 0.5]);
		expect(await keyFrameTimestamps(requestVia, onChange, 10)).toEqual([0, 0.1]);
		expect(await keyFrameTimestamps(requestVia, thirtyTwoFps, 8)).toEqual([0, 0.25]);
	}
});

test('VideoSampleSource, keyFrameInterval puts a key frame on every multiple of a fractional interval', async () => {
	const keyFrameIndices = async (keyFrameInterval: number, frameRate: number, frameCount: number) => {
		const keyTimestamps: number[] = [];
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const source = new VideoSampleSource({
			codec: 'vp8',
			quality: new Quality('low'),
			keyFrameInterval,
			// In quality mode, encoders may add key frames of their own, which WebCodecs allows (Firefox's VP8 encoder
			// places some at scene cuts)
			latencyMode: 'realtime',
			onEncodedPacket: (packet) => {
				if (packet.type === 'key') {
					keyTimestamps.push(packet.timestamp);
				}
			},
		});
		output.addVideoTrack(source, { frameRate });
		await output.start();

		const canvas = new OffscreenCanvas(64, 64);
		const context = canvas.getContext('2d')!;
		for (let i = 0; i < frameCount; i++) {
			context.fillStyle = `rgb(${(i * 10) % 256}, 0, 0)`;
			context.fillRect(0, 0, 64, 64);
			const sample = new VideoSample(canvas, { timestamp: i / frameRate, duration: 1 / frameRate });
			await source.add(sample);
			sample.close();
		}

		await output.finalize();
		return keyTimestamps.map(x => Math.round(x * frameRate));
	};

	// 0.6 / 0.2 is 2.9999999999999996 in floating point, but 0.6 s is still a multiple of 0.2 s
	expect(await keyFrameIndices(0.2, 30, 25)).toEqual([0, 6, 12, 18, 24]);
	expect(await keyFrameIndices(0.1, 30, 31)).toEqual(Array.from({ length: 11 }, (_, i) => 3 * i));
	expect(await keyFrameIndices(0.4, 25, 51)).toEqual([0, 10, 20, 30, 40, 50]);
	// Binary-exact intervals were fine already
	expect(await keyFrameIndices(0.5, 30, 46)).toEqual([0, 15, 30, 45]);
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

test('AudioSampleSource, canceling while a gap is filled with silence ends the add quietly', async () => {
	const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	const source = new AudioSampleSource({ codec: 'opus', quality: new Quality('medium') });
	output.addAudioTrack(source);
	await output.start();

	const makeSample = (timestamp: number) => new AudioSample({
		data: new Float32Array(2 * 960), format: 'f32', numberOfChannels: 2, sampleRate: 48000, timestamp,
	});
	for (let i = 0; i < 3; i++) {
		using sample = makeSample(i * 0.02);
		await source.add(sample);
	}

	using gapped = makeSample(1); // About 0.94 s after the end of the previous sample
	const addPromise = source.add(gapped);
	await output.cancel();

	const error = await addPromise.then(() => null, (error: Error) => error);
	expect(error === null || error.message === 'Output has been canceled.', String(error)).toBe(true);
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

// Needs the platform's AAC encoder (Windows, macOS; not Chromium on Linux)
const aacEncodable = await AudioEncoder.isConfigSupported({
	codec: 'mp4a.40.2',
	numberOfChannels: 2,
	sampleRate: 48000,
	bitrate: 128_000,
}).then(support => support.supported === true, () => false);

test.skipIf(!aacEncodable)('AudioSampleSource, AAC encoding keeps the start of the audio', async () => {
	// Some platform encoders silence the first samples they get (WebKit's the first 1024, Windows' Media Foundation
	// encoder about 512), which must not cut off a sound that starts right away
	const sampleRate = 48000;
	const data = new Float32Array(2 * sampleRate / 2);
	for (let i = 0; i < data.length / 2; i++) {
		data[2 * i] = data[2 * i + 1] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / sampleRate);
	}

	const buffer = await encodeAudio(
		{ codec: 'aac', quality: new Quality('high') },
		new AudioSample({ data, format: 'f32', numberOfChannels: 2, sampleRate, timestamp: 0 }),
	);

	const { input, track } = await readBackAudioTrack(buffer);
	const { AudioSampleSink } = await import('../../src/media-sink.js');
	let peak = 0;
	for await (using sample of new AudioSampleSink(track).samples(0, 0.05)) {
		const values = new Float32Array(sample.numberOfFrames);
		sample.copyTo(values, { planeIndex: 0, format: 'f32-planar' });
		for (let i = 0; i < values.length; i++) {
			const time = sample.timestamp + i / sample.sampleRate;
			if (time >= 0 && time < 256 / sampleRate) {
				peak = Math.max(peak, Math.abs(values[i]!));
			}
		}
	}

	expect(peak).toBeGreaterThan(0.3); // The first 256 samples carry the sine
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

test.each([
	['s16', 'pcm-s16', Int16Array.from([16384, 20000, 32767, -32768, -16384, 1, -1, 0])],
	['u8', 'pcm-u8', Uint8Array.from([0, 1, 64, 127, 128, 129, 192, 255])],
] as const)('AudioSampleSource, PCM encoding of %s AudioData is lossless', async (format, codec, values) => {
	// Like an app wrapping its own PCM data in AudioData
	const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
	const audioSource = new AudioSampleSource({ codec });
	output.addAudioTrack(audioSource);
	await output.start();

	using sample = new AudioSample(new AudioData({
		format,
		sampleRate: 48000,
		numberOfChannels: 1,
		numberOfFrames: values.length,
		timestamp: 0,
		data: values,
	}));
	await audioSource.add(sample);
	await output.finalize();

	const data = output.target.buffer!.slice(44); // After the canonical 44-byte header
	expect([...(format === 's16' ? new Int16Array(data) : new Uint8Array(data))]).toEqual([...values]);
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

// Whether this browser's Opus encoder keeps the end of its input in place when it's followed by 50 ms of silence, as
// Mediabunny pads it. Decided with WebCodecs alone: a click 0.5 ms before the end of 1 s of 48 kHz audio must come back
// at its time from an encode and decode (WebKitGTK's encoder gives every packet timestamp 0 and loses 13 ms)
const opusEncoderKeepsPaddedEnd = await (async () => {
	const sampleRate = 48000;
	const encoderConfig = { codec: 'opus', numberOfChannels: 1, sampleRate, bitrate: 128_000 };
	if (!(await AudioEncoder.isConfigSupported(encoderConfig)).supported) {
		return false;
	}

	const chunks: EncodedAudioChunk[] = [];
	let decoderConfig: AudioDecoderConfig | undefined;
	const encoder = new AudioEncoder({
		output: (chunk, meta) => {
			chunks.push(chunk);
			decoderConfig ??= meta?.decoderConfig;
		},
		error: () => {},
	});
	encoder.configure(encoderConfig);
	const data = new Float32Array(sampleRate * 1.05);
	data[sampleRate - 24] = 1;
	const audioData = new AudioData({
		data, format: 'f32', numberOfChannels: 1, numberOfFrames: data.length, sampleRate, timestamp: 0,
	});
	encoder.encode(audioData);
	audioData.close();
	await encoder.flush();
	encoder.close();
	if (!decoderConfig) {
		return false;
	}

	let peak = 0;
	let peakTime = -Infinity;
	const decoder = new AudioDecoder({
		output: (decoded) => {
			const values = new Float32Array(decoded.numberOfFrames);
			if (values.length > 0) {
				decoded.copyTo(values, { planeIndex: 0, format: 'f32-planar' });
			}
			for (let i = 0; i < values.length; i++) {
				if (Math.abs(values[i]!) > peak) {
					peak = Math.abs(values[i]!);
					peakTime = decoded.timestamp / 1e6 + i / decoded.sampleRate;
				}
			}
			decoded.close();
		},
		error: () => {},
	});
	decoder.configure(decoderConfig);
	chunks.forEach(chunk => decoder.decode(chunk));
	await decoder.flush();
	decoder.close();
	return peak > 0.5 && Math.abs(peakTime - (sampleRate - 24) / sampleRate) < 0.005;
})();

test.skipIf(!opusEncoderKeepsPaddedEnd)(
	'AudioSampleSource, Opus encoding of 44.1 kHz audio keeps its last milliseconds',
	async () => {
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
	},
);

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
	// Firefox and WebKitGTK claim support for Opus with 3 or 4 channels but fail to encode it
	for (const numberOfChannels of [2, 3, 4, 6]) {
		if (!await canEncodeAudio('opus', { numberOfChannels })) {
			continue;
		}

		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const audioSource = new AudioSampleSource({ codec: 'opus', quality: new Quality('medium') });
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

		expect(peak, `${numberOfChannels} channels`).toBeGreaterThan(0.1);
	}
});

let opusTimestampsFollowAudioResult: Promise<boolean> | null = null;

/**
 * Whether the platform's Opus encoder stamps its chunks along the audio, checked with WebCodecs alone. WebKitGTK's
 * gives every chunk the timestamp of the audio data it came from (and its decoder shifts by the pre-skip instead of
 * trimming it), so the timing of encoded Opus can't be checked there.
 */
const opusTimestampsFollowAudio = () => opusTimestampsFollowAudioResult ??= (async () => {
	const config: AudioEncoderConfig = { codec: 'opus', sampleRate: 16000, numberOfChannels: 1, bitrate: 32_000 };

	try {
		if (!(await AudioEncoder.isConfigSupported(config)).supported) {
			return false;
		}

		const timestamps: number[] = [];
		const encoder = new AudioEncoder({
			output: (chunk) => {
				timestamps.push(chunk.timestamp);
			},
			error: () => {},
		});
		encoder.configure(config);
		const data = new AudioData({
			format: 'f32',
			sampleRate: 16000,
			numberOfChannels: 1,
			numberOfFrames: 8000,
			timestamp: 0,
			data: new Float32Array(8000),
		});
		encoder.encode(data);
		data.close();
		await encoder.flush();
		encoder.close();

		// Half a second of audio comes out as about 25 chunks of 20 ms
		return timestamps.length > 1
			&& timestamps.every((timestamp, i) => i === 0 || timestamp > timestamps[i - 1]!)
			&& timestamps[timestamps.length - 1]! >= 300_000;
	} catch {
		return false;
	}
})();

test('AudioSampleSource, Opus encoding of 16 kHz audio keeps its timing', async ({ skip }) => {
	if (!await opusTimestampsFollowAudio()) {
		skip('The platform\'s Opus encoder doesn\'t stamp its chunks along the audio');
	}

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

/**
 * Whether the platform's own Opus encoder and decoder keep the timing of audio that needs no resampling: a 20 ms burst
 * at 0.5 s in 1 s of 48 kHz audio, encoded in one piece and decoded, must come back within 2 ms of its time. WebKitGTK
 * stamps every encoded chunk with the timestamp of the input it came from, and its decoder delays the audio by the
 * pre-skip instead of trimming it, so there, encoded timing can't be checked.
 */
const nativeOpusKeepsTiming = async () => {
	const withTimeout = <T>(promise: Promise<T>) => Promise.race([
		promise,
		new Promise<null>(resolve => setTimeout(() => resolve(null), 3000)),
	]);

	const sampleRate = 48000;
	const config: AudioEncoderConfig = { codec: 'opus', sampleRate, numberOfChannels: 1, bitrate: 64000 };
	if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined') {
		return false;
	}
	if (!(await withTimeout(AudioEncoder.isConfigSupported(config)))?.supported) {
		return false;
	}

	const data = new Float32Array(sampleRate);
	for (let i = 0; i < sampleRate / 50; i++) {
		data[sampleRate / 2 + i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / sampleRate);
	}

	const chunks: EncodedAudioChunk[] = [];
	let decoderConfig: AudioDecoderConfig | undefined;
	let onset: number | null = null;
	let failed = false;
	const encoder = new AudioEncoder({
		output: (chunk, meta) => {
			chunks.push(chunk);
			decoderConfig ??= meta?.decoderConfig;
		},
		error: () => failed = true,
	});
	const decoder = new AudioDecoder({
		output: (output) => {
			const values = new Float32Array(output.numberOfFrames);
			output.copyTo(values, { planeIndex: 0, format: 'f32-planar' });
			const index = values.findIndex(x => Math.abs(x) > 0.15);
			if (index !== -1 && onset === null) {
				onset = output.timestamp / 1e6 + index / output.sampleRate;
			}
			output.close();
		},
		error: () => failed = true,
	});

	try {
		encoder.configure(config);
		const audioData = new AudioData({
			format: 'f32-planar', sampleRate, numberOfChannels: 1, numberOfFrames: sampleRate, timestamp: 0, data,
		});
		encoder.encode(audioData);
		audioData.close();
		if (await withTimeout(encoder.flush()) === null || !decoderConfig) {
			return false;
		}

		decoder.configure(decoderConfig);
		chunks.forEach(chunk => decoder.decode(chunk));
		if (await withTimeout(decoder.flush()) === null) {
			return false;
		}
	} catch {
		return false;
	} finally {
		for (const codec of [encoder, decoder]) {
			if (codec.state !== 'closed') {
				codec.close();
			}
		}
	}

	return !failed && onset !== null && Math.abs(onset - 0.5) < 0.002;
};

test('AudioSampleSource, Opus encoding of 22.05 kHz audio keeps its timing', async (context) => {
	if (!(await nativeOpusKeepsTiming())) {
		context.skip('The platform\'s own Opus encoding and decoding don\'t keep timing');
	}

	// 1 s of silence with a 20 ms burst starting at 0.5 s. Chrome's Opus encoder resamples it to 48 kHz internally,
	// which delays its output.
	const sampleRate = 22050;
	const data = new Float32Array(sampleRate);
	const burstStart = sampleRate / 2;
	for (let i = 0; i < sampleRate / 50; i++) {
		data[burstStart + i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / sampleRate);
	}
	const sample = new AudioSample({ data, format: 'f32', sampleRate, numberOfChannels: 1, timestamp: 0 });
	const buffer = await encodeAudio({ codec: 'opus', quality: new Quality('high') }, sample);

	const { input, track } = await readBackAudioTrack(buffer);
	let onset: number | null = null;
	for await (using decoded of new AudioSampleSink(track).samples()) {
		const values = new Float32Array(decoded.numberOfFrames);
		decoded.copyTo(values, { planeIndex: 0, format: 'f32-planar' });
		const index = values.findIndex(x => Math.abs(x) > 0.15);
		if (index !== -1) {
			onset = decoded.timestamp + index / decoded.sampleRate;
			break;
		}
	}
	input.dispose();

	assert(onset !== null);
	expect(onset).toBeCloseTo(0.5, 3);
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

test('AudioSampleSource, Opus starting before zero keeps its audio in WebM and Matroska', async () => {
	// The pre-skip only covers the encoder's priming; the audio before zero must come back when decoded
	const encode = async (format: WebMOutputFormat | MkvOutputFormat) => {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new AudioSampleSource({ codec: 'opus', bitrate: new Quality('medium') });
		output.addAudioTrack(source);
		await output.start();
		for (let i = 0; i < 10; i++) {
			const sample = new AudioSample({
				data: new Float32Array(4800).map((_, j) => 0.1 * Math.sin(j / 10)), // 0.1 s
				format: 'f32',
				numberOfChannels: 1,
				sampleRate: 48000,
				timestamp: -0.5 + 0.1 * i,
			});
			await source.add(sample);
			sample.close();
		}
		await output.finalize();
		return output.target.buffer!;
	};

	const decode = async (buffer: ArrayBuffer) => {
		using input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const description = (await track.getDecoderConfig())?.description;
		assert(description);
		const header = ArrayBuffer.isView(description)
			? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
			: new Uint8Array(description);
		const preSkip = header[10]! | (header[11]! << 8); // OpusHead

		let firstTimestamp: number | null = null;
		let frames = 0;
		for await (const sample of new AudioSampleSink(track).samples()) {
			firstTimestamp ??= sample.timestamp;
			frames += sample.numberOfFrames;
			sample.close();
		}
		return { firstTimestamp, frames, preSkip };
	};

	// Whether the platform's Opus decoder trims the pre-skip from its output, as Chromium's and Firefox's do. WebKit's
	// (GStreamer) shifts its output by the pre-skip instead, so the decoded audio starts that much earlier there.
	const decoderTrimsPreSkip = async () => {
		const chunks: EncodedAudioChunk[] = [];
		let decoderConfig: AudioDecoderConfig | undefined;
		const encoder = new AudioEncoder({
			output: (chunk, meta) => {
				chunks.push(chunk);
				decoderConfig ??= meta?.decoderConfig;
			},
			error: (error) => {
				throw error;
			},
		});
		encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
		const data = new Float32Array(4800);
		encoder.encode(new AudioData({
			format: 'f32', sampleRate: 48000, numberOfChannels: 1, numberOfFrames: 4800, timestamp: 0, data,
		}));
		await encoder.flush();
		encoder.close();

		let firstFrames = 0;
		const decoder = new AudioDecoder({
			output: (audioData) => {
				firstFrames ||= audioData.numberOfFrames;
				audioData.close();
			},
			error: (error) => {
				throw error;
			},
		});
		decoder.configure(decoderConfig ?? { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
		decoder.decode(chunks[0]!);
		await decoder.flush();
		decoder.close();

		return firstFrames < 960; // A 20 ms packet
	};
	const trimsPreSkip = await decoderTrimsPreSkip();

	for (const format of [new WebMOutputFormat(), new MkvOutputFormat()]) {
		const { firstTimestamp, frames, preSkip } = await decode(await encode(format));
		expect(firstTimestamp).toBeCloseTo(-0.5 - (trimsPreSkip ? 0 : preSkip / 48000), 2);
		expect(frames).toBeGreaterThanOrEqual(48000);
	}
});

test('MediaStreamVideoTrackSource, records every requested frame of a captureStream(0) canvas', async ({ skip }) => {
	// Without a frame rate, frames can only be captured through MediaStreamTrackProcessor
	if (typeof MediaStreamTrackProcessor === 'undefined') {
		skip('Needs MediaStreamTrackProcessor on the main thread (Chromium)');
	}

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

test.for(['audio', 'video'] as const)(
	'MediaStream sources, an ended %s track stops holding back the other track',
	async (endingTrack, { skip }) => {
		if (typeof MediaStreamTrackGenerator === 'undefined') {
			skip('Needs MediaStreamTrackGenerator (Chromium)');
		}

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

/** Whether workers have MediaStreamTrackProcessor (Safari); MediaStreamVideoTrackSource then captures video there. */
const hasWorkerTrackProcessor = async () => {
	const url = URL.createObjectURL(new Blob(
		['postMessage(typeof MediaStreamTrackProcessor !== \'undefined\')'],
		{ type: 'application/javascript' },
	));
	const worker = new Worker(url);
	const supported = await new Promise<boolean>((resolve) => {
		worker.onmessage = event => resolve(event.data as boolean);
	});
	worker.terminate();
	URL.revokeObjectURL(url);
	return supported;
};

test.for(['video', 'audio'] as const)(
	'MediaStream sources, track.stop() closes the %s source when capturing without MediaStreamTrackProcessor',
	async (kind, { skip }) => {
		// Without MediaStreamTrackProcessor (Firefox, Safari), video is sampled from a <video> element and audio comes
		// through a ScriptProcessorNode. Stopping a track with track.stop() fires no 'ended' event.
		if (kind === 'video' && await hasWorkerTrackProcessor()) {
			skip('Captures video through MediaStreamTrackProcessor in a worker here, not through a <video> element');
		}

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
			// Sampling from a <video> element needs a frame rate, which Firefox and Safari don't report for canvas
			// capture tracks
			const source = new MediaStreamVideoTrackSource(
				track,
				{ codec: 'vp8', quality: new Quality('low') },
				{ frameRate: 30 },
			);
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

test.for(['video', 'audio'] as const)(
	'MediaStream sources, an already-ended %s track closes its source instead of failing start()',
	async (endedKind, { skip }) => {
		if (typeof MediaStreamTrackGenerator === 'undefined') {
			skip('Needs MediaStreamTrackGenerator (Chromium)');
		}

		const videoGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
		const audioGenerator = new MediaStreamTrackGenerator({ kind: 'audio' });
		(endedKind === 'video' ? videoGenerator : audioGenerator).stop();

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

		// The other track records as usual
		const canvas = new OffscreenCanvas(64, 48);
		const context = canvas.getContext('2d')!;
		const videoWriter = endedKind === 'audio' ? videoGenerator.writable.getWriter() : null;
		const audioWriter = endedKind === 'video' ? audioGenerator.writable.getWriter() : null;
		for (let i = 0; i < 30; i++) {
			if (videoWriter) {
				context.fillStyle = `rgb(${8 * i}, 0, 0)`;
				context.fillRect(0, 0, canvas.width, canvas.height);
				await videoWriter.write(new VideoFrame(canvas, { timestamp: 33333 * i }));
			} else {
				await audioWriter!.write(new AudioData({
					format: 'f32-planar',
					sampleRate: 48000,
					numberOfChannels: 1,
					numberOfFrames: 480,
					timestamp: 10000 * i,
					data: new Float32Array(480),
				}));
			}
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		await output.finalize();

		expect(errors).toEqual([]);
		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const tracks = await input.getTracks();
		expect(tracks.map(track => track.type)).toEqual([endedKind === 'video' ? 'audio' : 'video']);
	},
);

test('MediaStream sources, pausing and resuming keeps audio and video in sync', async ({ skip }) => {
	if (typeof MediaStreamTrackGenerator === 'undefined') {
		skip('Needs MediaStreamTrackGenerator (Chromium)');
	}

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
	if (typeof MediaStreamTrackProcessor === 'undefined') {
		skip('Needs MediaStreamTrackProcessor on the main thread (Chromium) to compare against');
	}

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

	// Even then, the output may only report its timing a while later (Chrome on Windows); the beeps are scheduled from
	// currentTime if it never does
	const outputWaitStart = performance.now();
	const hasOutputTiming = () => (audioContext.getOutputTimestamp().performanceTime ?? 0) > 0;
	while (!hasOutputTiming() && performance.now() - outputWaitStart < 1000) {
		await new Promise(resolve => setTimeout(resolve, 10));
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
	const startContextTime = contextTime !== undefined && performanceTime !== undefined && performanceTime > 0
		? contextTime + (start - performanceTime) / 1000
		: audioContext.currentTime + (start - performance.now()) / 1000;
	for (let i = 0; i < 6; i++) {
		const beepTime = startContextTime + 0.5 * i;
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

// Safari exposes MediaStreamTrackProcessor only inside workers, so there, MediaStreamVideoTrackSource hands the track
// to a worker. This path only exists in browsers like that.
const workerHasTrackProcessor = () => new Promise<boolean>((resolve) => {
	const code = 'postMessage(typeof MediaStreamTrackProcessor !== "undefined")';
	const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
	worker.addEventListener('message', (event: MessageEvent<boolean>) => {
		worker.terminate();
		resolve(event.data);
	});
});
const usesWorkerTrackProcessor = typeof MediaStreamTrackProcessor === 'undefined' && await workerHasTrackProcessor();

test.skipIf(!usesWorkerTrackProcessor)('MediaStreamVideoTrackSource, records through the worker path', async () => {
	const canvas = document.createElement('canvas');
	canvas.width = 160;
	canvas.height = 120;
	const context = canvas.getContext('2d')!;
	let frame = 0;
	const interval = setInterval(() => {
		context.fillStyle = `hsl(${(frame++ * 30) % 360}, 100%, 50%)`;
		context.fillRect(0, 0, canvas.width, canvas.height);
	}, 20);

	const track = canvas.captureStream(30).getVideoTracks()[0]!;
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new MediaStreamVideoTrackSource(track, { codec: 'avc', bitrate: 1e6 });
	let sourceError: unknown = null;
	source.errorPromise.catch((error: unknown) => {
		sourceError = error;
	});
	output.addVideoTrack(source);

	try {
		await output.start(); // Threw a DataCloneError on WebKit, since tracks can only be transferred to workers
		await new Promise(resolve => setTimeout(resolve, 500));
		await output.finalize();
	} finally {
		clearInterval(interval);
	}

	expect(sourceError).toBe(null);
	expect(track.readyState).toBe('live'); // The caller's track stays usable

	const { input, track: videoTrack } = await readBackTrack(output.target.buffer!);
	expect(await videoTrack.computeDuration()).toBeGreaterThan(0);
	input.dispose();
	track.stop();
});

type FinalizeOutcome = { status: 'resolved' } | { status: 'rejected'; error: unknown } | { status: 'hung' };

/**
 * Records three frames with a MediaStreamVideoTrackSource and finalizes the output (after closing the source, if
 * `closeFirst`) while the source's encoder is still being set up: `VideoEncoder.isConfigSupported` is held until then.
 * `createEncoder` may replace `VideoEncoder`, given the one with the held `isConfigSupported`.
 */
const finalizeDuringEncoderSetup = async (
	closeFirst: boolean,
	createEncoder: (HeldVideoEncoder: typeof VideoEncoder) => typeof VideoEncoder = Encoder => Encoder,
) => {
	const canvas = document.createElement('canvas');
	canvas.width = 64;
	canvas.height = 48;
	const track = canvas.captureStream(0).getVideoTracks()[0]!;

	// Frames reach the source through a stand-in MediaStreamTrackProcessor, so the test knows when it has them
	let controller!: ReadableStreamDefaultController<VideoFrame>;
	const globals = globalThis as { MediaStreamTrackProcessor?: unknown; VideoEncoder: typeof VideoEncoder };
	const originalProcessor = globals.MediaStreamTrackProcessor;
	globals.MediaStreamTrackProcessor = class {
		readable = new ReadableStream<VideoFrame>({
			start: (c) => {
				controller = c;
			},
		}, { highWaterMark: 0 });
	};

	let releaseSetup!: () => void;
	const setupReleased = new Promise<void>((resolve) => {
		releaseSetup = resolve;
	});
	const OriginalVideoEncoder = globals.VideoEncoder;
	class HeldVideoEncoder extends OriginalVideoEncoder {
		static override async isConfigSupported(config: VideoEncoderConfig) {
			await setupReleased;
			return OriginalVideoEncoder.isConfigSupported(config);
		}
	}
	globals.VideoEncoder = createEncoder(HeldVideoEncoder);

	try {
		const output = new Output({
			format: new WebMOutputFormat(),
			target: new BufferTarget(),
		});
		const videoSource = new MediaStreamVideoTrackSource(
			track,
			{ codec: 'vp8', quality: new Quality('low') },
			{ frameRate: null },
		);
		const errors: unknown[] = [];
		videoSource.errorPromise.catch(error => errors.push(error));
		output.addVideoTrack(videoSource);
		try {
			await output.start();
		} finally {
			globals.MediaStreamTrackProcessor = originalProcessor;
		}

		// A short recording: three frames
		const context = canvas.getContext('2d')!;
		const start = 1000 * performance.now();
		for (let i = 0; i < 3; i++) {
			context.fillStyle = `rgb(${100 * i}, 0, 0)`;
			context.fillRect(0, 0, canvas.width, canvas.height);
			controller.enqueue(new VideoFrame(canvas, { timestamp: start + 40000 * i, duration: 40000 }));
		}
		while (controller.desiredSize! < 0) {
			await new Promise(resolve => setTimeout(resolve, 0)); // Until the source has taken them all
		}
		await new Promise(resolve => setTimeout(resolve, 0));

		if (closeFirst) {
			videoSource.close();
		}
		const finalized = output.finalize();
		releaseSetup();
		const outcome = await Promise.race<FinalizeOutcome>([
			finalized.then(() => ({ status: 'resolved' }), (error: unknown) => ({ status: 'rejected', error })),
			new Promise(resolve => setTimeout(() => resolve({ status: 'hung' }), 2000)),
		]);
		track.stop();

		return { outcome, errors, buffer: output.target.buffer };
	} finally {
		releaseSetup();
		globals.VideoEncoder = OriginalVideoEncoder;
		globals.MediaStreamTrackProcessor = originalProcessor;
	}
};

test.for(['finalize', 'close'] as const)(
	'MediaStreamVideoTrackSource, frames received while the encoder is set up survive a quick %s()',
	async (ending, { skip }) => {
		if (typeof VideoEncoder === 'undefined') {
			skip('Needs VideoEncoder');
		}

		const { outcome, errors, buffer } = await finalizeDuringEncoderSetup(ending === 'close');
		expect(outcome).toEqual({ status: 'resolved' });
		expect(errors).toEqual([]);

		using input = new Input({ source: new BufferSource(buffer!), formats: ALL_FORMATS });
		const videoTrack = await input.getPrimaryVideoTrack();
		const timestamps: number[] = [];
		if (videoTrack) {
			for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
				timestamps.push(packet.timestamp);
			}
		}
		expect(timestamps).toEqual([0, 0.04, 0.08]);
	},
);

test.for([
	{
		failure: 'an unsupported configuration',
		createEncoder: (HeldVideoEncoder: typeof VideoEncoder) => class extends HeldVideoEncoder {
			static override async isConfigSupported(config: VideoEncoderConfig) {
				await HeldVideoEncoder.isConfigSupported(config);
				return { supported: false, config };
			}
		},
	},
	{
		failure: 'configure() throwing',
		createEncoder: (HeldVideoEncoder: typeof VideoEncoder) => class extends HeldVideoEncoder {
			override configure() {
				throw new DOMException('Configuration rejected', 'NotSupportedError');
			}
		},
	},
	{
		failure: 'an asynchronous configuration error',
		createEncoder: (HeldVideoEncoder: typeof VideoEncoder) => {
			// Fails its configuration the way the WebCodecs spec's "Close VideoEncoder" algorithm does: pending flushes
			// are rejected with the error, the encoder is closed and the error callback is called
			class AsyncFailingEncoder {
				state: CodecState = 'unconfigured';
				encodeQueueSize = 0;
				private pendingFlushes: ((error: DOMException) => void)[] = [];

				constructor(private init: VideoEncoderInit) {}

				static isConfigSupported(config: VideoEncoderConfig) {
					return HeldVideoEncoder.isConfigSupported(config);
				}

				configure() {
					this.state = 'configured';
					setTimeout(() => {
						const error = new DOMException('Unsupported configuration', 'NotSupportedError');
						for (const reject of this.pendingFlushes.splice(0)) {
							reject(error);
						}
						this.state = 'closed';
						this.init.error(error);
					}, 5);
				}

				encode() {
					if (this.state !== 'configured') {
						throw new DOMException('Cannot call encode on a closed codec', 'InvalidStateError');
					}
				}

				flush() {
					if (this.state !== 'configured') {
						return Promise.reject(new DOMException('Cannot flush a closed codec', 'InvalidStateError'));
					}

					return new Promise<void>((resolve, reject) => {
						this.pendingFlushes.push(reject);
					});
				}

				close() {
					this.state = 'closed';
				}

				addEventListener() {}
				removeEventListener() {}
			}

			return AsyncFailingEncoder as unknown as typeof VideoEncoder;
		},
	},
])('MediaStreamVideoTrackSource, a quick finalize() settles and reports $failure in the encoder setup', async (
	{ createEncoder },
	{ skip },
) => {
	if (typeof VideoEncoder === 'undefined') {
		skip('Needs VideoEncoder');
	}

	const { outcome, errors } = await finalizeDuringEncoderSetup(false, createEncoder);
	expect(outcome.status).not.toBe('hung');

	// The configuration's own error is reported, through errorPromise or by finalize() itself
	const reported = outcome.status === 'rejected' ? [...errors, outcome.error] : errors;
	expect(reported.length).toBeGreaterThan(0);
	for (const error of reported) {
		expect(String(error)).toMatch(/not supported|NotSupportedError/);
	}
});

/**
 * Records a generated track (40 frames, 30 FPS timestamps) through a MediaStreamVideoTrackSource into a fragmented MP4
 * StreamTarget. With `stall`, the target's sink stops taking data at its second write (like a stalled upload) until the
 * recording is done. The frames handed to the source by the real MediaStreamTrackProcessor are observed on the way.
 */
const recordIntoSink = async (options: { stall: boolean; frameRate: number | null; frameIntervalMs: number }) => {
	const deliveredFrames: VideoFrame[] = [];
	const globals = globalThis as { MediaStreamTrackProcessor?: unknown };
	const RealProcessor = MediaStreamTrackProcessor;
	globals.MediaStreamTrackProcessor = class {
		readable: ReadableStream<VideoFrame>;

		constructor(init: { track: MediaStreamVideoTrack }) {
			this.readable = new RealProcessor(init).readable.pipeThrough(new TransformStream<VideoFrame, VideoFrame>({
				transform: (frame, controller) => {
					deliveredFrames.push(frame);
					controller.enqueue(frame);
				},
			}));
		}
	};

	try {
		let writes = 0;
		let encoded = 0;
		let encodedBeforeStall: number | null = null;
		let releaseSink!: () => void;
		const sinkReleased = new Promise<void>((resolve) => {
			releaseSink = resolve;
		});
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0.05 }),
			target: new StreamTarget(new WritableStream<StreamTargetChunk>({
				write: () => {
					writes++;
					if (!options.stall || writes === 1) {
						return;
					}

					encodedBeforeStall ??= encoded;
					return sinkReleased;
				},
			})),
		});

		const generator = new MediaStreamTrackGenerator({ kind: 'video' });
		const writer = generator.writable.getWriter();
		const videoSource = new MediaStreamVideoTrackSource(
			generator as unknown as MediaStreamVideoTrack,
			{
				codec: 'vp8',
				quality: new Quality('low'),
				keyFrameInterval: 0.1,
				onEncodedSample: () => encoded++,
			},
			{ frameRate: options.frameRate },
		);
		const errors: unknown[] = [];
		videoSource.errorPromise.catch(error => errors.push(error));
		output.addVideoTrack(videoSource);
		await output.start();

		const canvas = new OffscreenCanvas(320, 240);
		const context = canvas.getContext('2d')!;
		for (let i = 0; i < 40; i++) {
			context.fillStyle = `hsl(${9 * i}, 80%, 50%)`;
			context.fillRect(0, 0, canvas.width, canvas.height);
			await writer.write(new VideoFrame(canvas, { timestamp: 33333 * i }));
			await new Promise(resolve => setTimeout(resolve, options.frameIntervalMs));
		}
		await new Promise(resolve => setTimeout(resolve, 200));

		const result = {
			delivered: deliveredFrames.length,
			open: deliveredFrames.filter(frame => frame.format !== null).length,
			encoded,
			encodedWhileStalled: encodedBeforeStall === null ? null : encoded - encodedBeforeStall,
		};

		releaseSink();
		await writer.close();
		await output.finalize();
		expect(errors).toEqual([]);

		return result;
	} finally {
		globals.MediaStreamTrackProcessor = RealProcessor;
	}
};

test.for([
	{ name: 'as they come', frameRate: null, frameIntervalMs: 10 },
	{ name: 'at a constant frame rate', frameRate: 30, frameIntervalMs: 25 },
])(
	'MediaStreamVideoTrackSource, frames taken $name are dropped rather than held while the output can\'t take data',
	async ({ frameRate, frameIntervalMs }, { skip }) => {
		if (typeof MediaStreamTrackGenerator === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') {
			skip('Needs MediaStreamTrackGenerator and MediaStreamTrackProcessor (Chromium)');
		}

		const result = await recordIntoSink({ stall: true, frameRate, frameIntervalMs });
		expect(result.delivered).toBeGreaterThanOrEqual(30);
		expect(result.encodedWhileStalled).not.toBe(null);

		// Each frame handed to the encoder is held until the output has taken what came before it. So, while the output
		// takes nothing, at most a few frames get through, the ones that were on their way when it stopped
		expect(result.encodedWhileStalled).toBeLessThanOrEqual(16);
		if (frameRate === null) {
			// The frames themselves, which here are the ones the processor delivered
			expect(result.open).toBeLessThanOrEqual(10);
		}
	},
);

test('MediaStreamVideoTrackSource, drops no frame and holds none when the output keeps up', async ({ skip }) => {
	if (typeof MediaStreamTrackGenerator === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') {
		skip('Needs MediaStreamTrackGenerator and MediaStreamTrackProcessor (Chromium)');
	}

	const result = await recordIntoSink({ stall: false, frameRate: null, frameIntervalMs: 10 });
	expect(result.delivered).toBeGreaterThanOrEqual(30);
	expect(result.encoded).toBe(result.delivered);
	expect(result.open).toBeLessThanOrEqual(1);
});

test('MediaStreamVideoTrackSource, frames waiting for the encoder\'s setup aren\'t dropped', async ({ skip }) => {
	if (typeof MediaStreamTrackGenerator === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') {
		skip('Needs MediaStreamTrackGenerator and MediaStreamTrackProcessor (Chromium)');
	}

	// Holds the encoder's setup, like a slow hardware encoder would
	let releaseSetup!: () => void;
	const setupReleased = new Promise<void>((resolve) => {
		releaseSetup = resolve;
	});
	const originalIsConfigSupported = VideoEncoder.isConfigSupported.bind(VideoEncoder);
	VideoEncoder.isConfigSupported = async (config) => {
		await setupReleased;
		return originalIsConfigSupported(config);
	};

	try {
		const output = new Output({
			format: new WebMOutputFormat(),
			target: new BufferTarget(),
		});
		const generator = new MediaStreamTrackGenerator({ kind: 'video' });
		const writer = generator.writable.getWriter();
		let encoded = 0;
		const videoSource = new MediaStreamVideoTrackSource(
			generator as unknown as MediaStreamVideoTrack,
			{ codec: 'vp8', quality: new Quality('low'), onEncodedSample: () => encoded++ },
			{ frameRate: null },
		);
		const errors: unknown[] = [];
		videoSource.errorPromise.catch(error => errors.push(error));
		output.addVideoTrack(videoSource);
		await output.start();

		const canvas = new OffscreenCanvas(64, 48);
		const context = canvas.getContext('2d')!;
		for (let i = 0; i < 20; i++) {
			context.fillStyle = `rgb(${10 * i}, 0, 0)`;
			context.fillRect(0, 0, canvas.width, canvas.height);
			await writer.write(new VideoFrame(canvas, { timestamp: 33333 * i }));
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		releaseSetup();

		// Let the encoder take the frames before finalizing
		const deadline = performance.now() + 2000;
		while (encoded < 20 && performance.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		await writer.close();
		await output.finalize();
		expect(errors).toEqual([]);

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		let packets = 0;
		for await (const packet of new EncodedPacketSink((await input.getPrimaryVideoTrack())!).packets()) {
			expect(packet.timestamp).toBeCloseTo(packets / 30, 3);
			packets++;
		}
		expect(packets).toBe(20);
	} finally {
		releaseSetup();
		VideoEncoder.isConfigSupported = originalIsConfigSupported;
	}
});

/**
 * Records frames with the given capture timestamps (in microseconds) through a MediaStreamVideoTrackSource, handing
 * them over through a stand-in MediaStreamTrackProcessor, and returns the error the recording failed with, if any, and
 * the timestamps of the recorded packets.
 */
const recordCaptureTimestamps = async (timestamps: number[]) => {
	let controller!: ReadableStreamDefaultController<VideoFrame>;
	const globals = globalThis as { MediaStreamTrackProcessor?: unknown };
	const originalProcessor = globals.MediaStreamTrackProcessor;
	globals.MediaStreamTrackProcessor = class {
		readable = new ReadableStream<VideoFrame>({
			start: (c) => {
				controller = c;
			},
		});
	};

	const track = document.createElement('canvas').captureStream(0).getVideoTracks()[0]!;
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const videoSource = new MediaStreamVideoTrackSource(
		track,
		{ codec: 'vp8', quality: new Quality('low'), keyFrameInterval: 0.5 },
		{ frameRate: null },
	);
	const errors: unknown[] = [];
	videoSource.errorPromise.catch(error => errors.push(error));
	output.addVideoTrack(videoSource);
	try {
		await output.start();
	} finally {
		globals.MediaStreamTrackProcessor = originalProcessor;
	}

	const canvas = new OffscreenCanvas(64, 48);
	const context = canvas.getContext('2d')!;
	for (const [i, timestamp] of timestamps.entries()) {
		context.fillStyle = `rgb(${10 * i}, 0, 0)`;
		context.fillRect(0, 0, canvas.width, canvas.height);
		const frame = new VideoFrame(canvas, { timestamp });
		try {
			controller.enqueue(frame);
		} catch {
			// The source stopped reading, after an error
			frame.close();
			break;
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}

	const finalizeError = await output.finalize().then(() => null, (error: unknown) => error);
	track.stop();
	if (finalizeError !== null || errors.length > 0) {
		return { error: finalizeError ?? errors[0], packetTimestamps: [] };
	}

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const packetTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink((await input.getPrimaryVideoTrack())!).packets()) {
		packetTimestamps.push(packet.timestamp);
	}

	return { error: null, packetTimestamps };
};

// 24 frames at 30 FPS
const regularCaptureTimestamps = Array.from({ length: 24 }, (_, i) => 1e9 + Math.round(1e6 * i / 30));

test('MediaStreamVideoTrackSource, a frame stamped back across a key frame is dropped', async ({ skip }) => {
	if (typeof VideoEncoder === 'undefined') {
		skip('Needs VideoEncoder');
	}

	// Frame 15 is captured at 0.502 s, and frame 16 stamped 4 ms earlier, on the other side of the 0.5 s key frame
	const timestamps = regularCaptureTimestamps.map((timestamp, i) => {
		return i === 15 ? 1e9 + 502000 : i === 16 ? 1e9 + 498000 : timestamp;
	});
	const { error, packetTimestamps } = await recordCaptureTimestamps(timestamps);
	expect(error).toBe(null);
	expect(packetTimestamps).toHaveLength(23);
	for (let i = 1; i < packetTimestamps.length; i++) {
		expect(packetTimestamps[i]!).toBeGreaterThan(packetTimestamps[i - 1]!);
	}
});

test('MediaStreamVideoTrackSource, increasing capture timestamps keep every frame', async ({ skip }) => {
	if (typeof VideoEncoder === 'undefined') {
		skip('Needs VideoEncoder');
	}

	const { error, packetTimestamps } = await recordCaptureTimestamps(regularCaptureTimestamps);
	expect(error).toBe(null);
	expect(packetTimestamps).toHaveLength(24);
});

/**
 * Runs `callback` with MediaStreamTrackProcessor hidden, so that MediaStreamAudioTrackSource captures through an
 * AudioContext, as it does in browsers without MediaStreamTrackProcessor (Firefox, Safari).
 */
const withoutMediaStreamTrackProcessor = async <T>(callback: () => Promise<T>) => {
	const globals = globalThis as { MediaStreamTrackProcessor?: unknown };
	const processor = globals.MediaStreamTrackProcessor;
	globals.MediaStreamTrackProcessor = undefined;
	try {
		return await callback();
	} finally {
		globals.MediaStreamTrackProcessor = processor;
	}
};

const settlesWithin = (promise: Promise<unknown>, ms: number) => Promise.race([
	promise.then(() => 'resolved' as const, () => 'rejected' as const),
	new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), ms)),
]);

test.for(['cancel', 'finalize'] as const)(
	'MediaStreamAudioTrackSource, an AudioContext that can\'t start yet doesn\'t block the output (%s)',
	async (ending) => {
		// Without a user gesture on the page, an AudioContext can't start, and its resume() stays pending until then.
		// That's simulated for the context the source creates, whatever this browser's autoplay policy is.
		const RealAudioContext = globalThis.AudioContext;
		const createdContexts: AudioContext[] = [];
		class NotAllowedToStartAudioContext extends RealAudioContext {
			constructor(options?: AudioContextOptions) {
				super(options);
				createdContexts.push(this);
				Object.defineProperty(this, 'state', { get: () => 'suspended' });
			}

			override resume() {
				return new Promise<void>(() => {});
			}
		}

		const trackContext = new RealAudioContext();
		const track = trackContext.createMediaStreamDestination().stream.getAudioTracks()[0]!;
		globalThis.AudioContext = NotAllowedToStartAudioContext;
		try {
			const output = new Output({
				format: new WebMOutputFormat(),
				target: new BufferTarget(),
			});
			const audioSource = new MediaStreamAudioTrackSource(track, { codec: 'opus', quality: new Quality('low') });
			audioSource.errorPromise.catch(() => {});
			output.addAudioTrack(audioSource);

			expect(await withoutMediaStreamTrackProcessor(() => settlesWithin(output.start(), 2000))).toBe('resolved');
			const ended = ending === 'cancel' ? output.cancel() : output.finalize();
			expect(await settlesWithin(ended, 2000)).toBe('resolved');
		} finally {
			globalThis.AudioContext = RealAudioContext;
			track.stop();
			await Promise.all([trackContext, ...createdContexts].map(context => context.close()));
		}
	},
);

test('MediaStreamAudioTrackSource without MediaStreamTrackProcessor records once its AudioContext runs', async ({
	skip,
}) => {
	const trackContext = new AudioContext();
	await Promise.race([trackContext.resume(), new Promise(resolve => setTimeout(resolve, 1000))]);
	if (trackContext.state !== 'running') {
		await trackContext.close();
		skip('Web Audio cannot run here without a user gesture');
	}

	// A continuous tone
	const destination = trackContext.createMediaStreamDestination();
	const oscillator = trackContext.createOscillator();
	oscillator.connect(destination);
	oscillator.start();
	const track = destination.stream.getAudioTracks()[0]!;

	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const audioSource = new MediaStreamAudioTrackSource(track, { codec: 'opus', quality: new Quality('low') });
	const errors: unknown[] = [];
	audioSource.errorPromise.catch(error => errors.push(error));
	output.addAudioTrack(audioSource);
	await withoutMediaStreamTrackProcessor(() => output.start());
	await new Promise(resolve => setTimeout(resolve, 1000));
	// (An audio callback already queued when finalize() starts can still run after it; that's a separate issue)
	const errorsWhileRecording = [...errors];
	await output.finalize();
	track.stop();
	await trackContext.close();

	expect(errorsWhileRecording).toEqual([]);
	const { input, track: audioTrack } = await readBackAudioTrack(output.target.buffer!);
	expect(await audioTrack.computeDuration()).toBeGreaterThan(0.5);
	input.dispose();
});

test('MediaStreamAudioTrackSource, timestamp jitter adds no silence, real gaps still get filled', async ({ skip }) => {
	if (typeof MediaStreamTrackGenerator === 'undefined') {
		skip('Needs MediaStreamTrackGenerator (Chromium)');
	}

	const audioGenerator = new MediaStreamTrackGenerator({ kind: 'audio' });
	const audioWriter = audioGenerator.writable.getWriter();

	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});
	const audioSource = new MediaStreamAudioTrackSource(audioGenerator as unknown as MediaStreamAudioTrack, {
		codec: 'pcm-f32',
	});
	const errors: unknown[] = [];
	audioSource.errorPromise.catch(error => errors.push(error));
	output.addAudioTrack(audioSource);
	await output.start();

	// Continuous, never-silent audio in 10 ms chunks, whose capture timestamps jitter by up to 9 ms like those of a
	// Web Audio-sourced track. 60 chunks in, 6 chunks (60 ms) go missing.
	const jitter = [6, 3, 9, 4, 8, 2, 7, 5];
	const start = performance.now();
	let writtenFrames = 0;
	for (let i = 0; i < 100; i++) {
		while (performance.now() - start < 10 * i) {
			await new Promise(resolve => setTimeout(resolve, 2));
		}
		if (i >= 60 && i < 66) {
			continue;
		}

		const data = new Float32Array(480);
		for (let j = 0; j < 480; j++) {
			data[j] = 0.5 + 0.25 * Math.sin(2 * Math.PI * 440 * (480 * i + j) / 48000);
		}
		const jitterMs = i === 0 || i === 66 ? 0 : jitter[i % jitter.length]!;
		await audioWriter.write(new AudioData({
			format: 'f32-planar',
			sampleRate: 48000,
			numberOfChannels: 1,
			numberOfFrames: 480,
			timestamp: Math.round(1000 * (start + 10 * i + jitterMs)),
			data,
		}));
		writtenFrames += 480;
	}

	await new Promise(resolve => setTimeout(resolve, 50));
	await output.finalize();
	await audioWriter.close();
	expect(errors).toEqual([]);

	const { input, track } = await readBackAudioTrack(output.target.buffer!);
	let frames = 0;
	const silentRuns: number[] = [];
	let silentRun = 0;
	for await (using sample of new AudioSampleSink(track).samples()) {
		const data = new Float32Array(sample.numberOfFrames);
		sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
		for (const value of data) {
			if (value === 0) {
				silentRun++;
			} else if (silentRun > 0) {
				silentRuns.push(silentRun);
				silentRun = 0;
			}
		}
		frames += sample.numberOfFrames;
	}
	input.dispose();

	// The only silence is the one filling the 60 ms gap (2880 frames, give or take the timestamps' rounding)
	expect(silentRuns).toHaveLength(1);
	expect(Math.abs(silentRuns[0]! - 2880)).toBeLessThanOrEqual(10);
	expect(frames).toBe(writtenFrames + silentRuns[0]!);
});
