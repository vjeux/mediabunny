import { describe, expect, test } from 'vitest';
import { PCM_AUDIO_CODECS } from '../../src/codec.js';
import {
	CustomAudioEncoder,
	CustomVideoDecoder,
	CustomVideoEncoder,
	registerDecoder,
	registerEncoder,
} from '../../src/custom-coder.js';
import { canDecode, canDecodeAudio, canDecodeVideo, getDecodableAudioCodecs } from '../../src/decode.js';
import {
	buildAudioEncoderConfig,
	buildVideoEncoderConfigs,
	canEncode,
	canEncodeAudio,
	canEncodeSubtitles,
	canEncodeVideo,
	getEncodableAudioCodecs,
	getFirstEncodableAudioCodec,
	getFirstEncodableVideoCodec,
	Quality,
	QUALITY_HIGH,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_VERY_HIGH,
	QUALITY_VERY_LOW,
	QualityLevel,
	validateAudioEncodingConfig,
	validateVideoEncodingConfig,
} from '../../src/encode.js';
import { VideoCodec } from '../../src/codec.js';

// Node has no WebCodecs, so support queries only report what Mediabunny itself (PCM) or custom coders can handle.

const VIDEO_CODECS_BY_EFFICIENCY: VideoCodec[] = ['av1', 'hevc', 'avc', 'vp8'];

describe('Quality', () => {
	test('Constructor validation', () => {
		const invalid: unknown[] = [
			undefined,
			null,
			'ultra',
			'',
			Number.NaN,
			{ quality: 'best' },
			{ quality: 0.5, preferBitrate: 'yes' },
			{ quality: 0.5, bitrate: 1_000_000 },
			{ quality: 0.5, quantizer: 20 },
			{ quality: 0.5, bitrateMode: 'average' },
			{},
			{ bitrate: 0 },
			{ bitrate: 1.5 },
			{ bitrate: -1000 },
			{ quantizer: -1 },
			{ quantizer: 1.5 },
			{ bitrate: 1_000_000, preferBitrate: true },
		];
		for (const options of invalid) {
			expect(() => new Quality(options as QualityLevel), JSON.stringify(options)).toThrow(TypeError);
		}

		const valid: unknown[] = [
			0,
			0.3,
			'very-high',
			{ quality: 'low', preferBitrate: true },
			{ quality: 2 }, // Outside of 0-1 is allowed
			{ quantizer: 0 },
			{ bitrate: 1 },
			{ bitrate: 1_000_000, quantizer: 20, bitrateMode: 'constant' },
		];
		for (const options of valid) {
			expect(() => new Quality(options as QualityLevel), JSON.stringify(options)).not.toThrow();
		}
	});

	test('Named quality levels', () => {
		/* eslint-disable @typescript-eslint/no-deprecated */
		const named: [Quality, Quality, number][] = [
			[QUALITY_VERY_LOW, new Quality('very-low'), 0],
			[QUALITY_LOW, new Quality('low'), 0.25],
			[QUALITY_MEDIUM, new Quality('medium'), 0.5],
			[QUALITY_HIGH, new Quality('high'), 0.75],
			[QUALITY_VERY_HIGH, new Quality('very-high'), 1],
		];
		/* eslint-enable @typescript-eslint/no-deprecated */

		for (const [constant, level, number] of named) {
			const expected = new Quality(number)._toVideoBitrate('avc', 1920, 1080);
			expect(constant._toVideoBitrate('avc', 1920, 1080)).toBe(expected);
			expect(level._toVideoBitrate('avc', 1920, 1080)).toBe(expected);
			expect(new Quality({ quality: number })._toVideoBitrate('avc', 1920, 1080)).toBe(expected);
		}
	});

	test('Video bit rates', () => {
		// The lowest level is 0.3 times the 3 Mbps reference for 1080p AVC
		expect(new Quality('very-low')._toVideoBitrate('avc', 1920, 1080)).toBe(900_000);

		const levels: QualityLevel[] = ['very-low', 'low', 'medium', 'high', 'very-high'];
		for (const codec of ['avc', 'hevc', 'vp8', 'vp9', 'av1', 'prores'] as VideoCodec[]) {
			const bitrates = levels.map(level => new Quality(level)._toVideoBitrate(codec, 1920, 1080));

			// Strictly increasing with quality, in whole kbps
			for (let i = 0; i < bitrates.length; i++) {
				expect(bitrates[i]! % 1000, codec).toBe(0);
				if (i > 0) {
					expect(bitrates[i]!, codec).toBeGreaterThan(bitrates[i - 1]!);
				}
			}

			// Slightly sublinear in the pixel count
			const at4k = new Quality('medium')._toVideoBitrate(codec, 3840, 2160);
			expect(at4k / bitrates[2]!, codec).toBeCloseTo(Math.pow(4, 0.95), 2);
		}

		// More efficient codecs get lower bit rates; VP9 is on par with HEVC
		const mediumBitrates = VIDEO_CODECS_BY_EFFICIENCY.map(codec =>
			new Quality('medium')._toVideoBitrate(codec, 1280, 720),
		);
		expect([...mediumBitrates].sort((a, b) => a - b)).toEqual(mediumBitrates);
		expect(new Quality('medium')._toVideoBitrate('vp9', 1280, 720)).toBe(mediumBitrates[1]);

		// ProRes is anchored at 220 Mbps for 1080p 422 HQ
		expect(new Quality(0.4)._toVideoBitrate('prores', 1920, 1080) / 220_000_000).toBeCloseTo(
			new Quality(0.4)._toVideoBitrate('avc', 1920, 1080) / 3_000_000,
			2,
		);

		// Explicit bit rates are used as they are
		expect(new Quality({ bitrate: 1_234_567 })._toVideoBitrate('av1', 640, 480)).toBe(1_234_567);
	});

	test('Video rate control', () => {
		const rateControl = (quality: Quality, codec: VideoCodec, fallbackMode?: 'constant' | 'variable') =>
			quality._toVideoRateControl(codec, 1920, 1080, fallbackMode);

		// Qualitative levels map linearly onto each codec's reasonable quantizer range: QP 41 to 16 for AVC/HEVC, 208
		// to 80 on the 0-255 scale for VP9/AV1
		expect(rateControl(new Quality('very-low'), 'avc').quantizer).toBe(41);
		expect(rateControl(new Quality('very-high'), 'avc').quantizer).toBe(16);
		expect(rateControl(new Quality('medium'), 'hevc').quantizer).toBe(29); // 28.5 rounded
		expect(rateControl(new Quality('very-low'), 'vp9').quantizer).toBe(208);
		expect(rateControl(new Quality('very-high'), 'av1').quantizer).toBe(80);
		// ... and are clamped to the legal range
		expect(rateControl(new Quality(2), 'avc').quantizer).toBe(0);
		expect(rateControl(new Quality(-1), 'avc').quantizer).toBe(51);
		expect(rateControl(new Quality(-1), 'av1').quantizer).toBe(255);

		// A bit rate is always derived as the fallback
		const medium = rateControl(new Quality('medium'), 'avc');
		expect(medium.bitrateMode).toBe('variable');
		expect(medium.bitrate).toBe(new Quality('medium')._toVideoBitrate('avc', 1920, 1080));

		// No quantizer for codecs without quantizer support, or when bit rates are preferred
		expect(rateControl(new Quality('medium'), 'vp8').quantizer).toBe(null);
		expect(rateControl(new Quality('medium'), 'prores').quantizer).toBe(null);
		expect(rateControl(new Quality({ quality: 0.5, preferBitrate: true }), 'avc').quantizer).toBe(null);

		// An explicit quantizer without bit rate means quantizer mode, with a bit rate estimate for the codec string
		const explicit = rateControl(new Quality({ quantizer: 31 }), 'avc');
		expect(explicit.quantizer).toBe(31);
		expect(explicit.bitrateMode).toBe('quantizer');
		expect(explicit.bitrate).toBe(new Quality(0.4)._toVideoBitrate('avc', 1920, 1080)); // (31 - 41) / (16 - 41)

		// With a bit rate, that's the fallback
		const withFallback = rateControl(new Quality({ quantizer: 31, bitrate: 2_000_000 }), 'avc');
		expect(withFallback).toEqual({ quantizer: 31, bitrate: 2_000_000, bitrateMode: 'variable' });

		// An unusable quantizer is an error, unless there is a bit rate to fall back to
		expect(() => rateControl(new Quality({ quantizer: 52 }), 'avc')).toThrow();
		expect(() => rateControl(new Quality({ quantizer: 20 }), 'vp8')).toThrow();
		expect(rateControl(new Quality({ quantizer: 52, bitrate: 2_000_000 }), 'avc').quantizer).toBe(null);
		expect(rateControl(new Quality({ quantizer: 20, bitrate: 2_000_000 }), 'vp8').quantizer).toBe(null);

		// The Quality's bit rate mode beats the fallback mode
		expect(rateControl(new Quality('medium'), 'vp8', 'constant').bitrateMode).toBe('constant');
		expect(rateControl(new Quality({ quality: 0.5, bitrateMode: 'variable' }), 'vp8', 'constant').bitrateMode)
			.toBe('variable');
	});

	test('Audio bit rates', () => {
		for (const codec of [...PCM_AUDIO_CODECS, 'flac', 'truehd'] as const) {
			expect(new Quality('medium')._toAudioBitrate(codec), codec).toBe(undefined);
		}

		// AAC snaps to the bit rates AAC encoders accept everywhere
		expect(new Quality('very-low')._toAudioBitrate('aac')).toBe(96_000);
		expect(new Quality('medium')._toAudioBitrate('aac')).toBe(128_000);
		expect(new Quality('very-high')._toAudioBitrate('aac')).toBe(192_000);

		// MP3 snaps to the MPEG-1 Layer III bit rates
		const mp3BitRates = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320].map(x => x * 1000);
		for (const quality of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
			expect(mp3BitRates, String(quality)).toContain(new Quality(quality)._toAudioBitrate('mp3'));
		}
		expect(new Quality('very-high')._toAudioBitrate('mp3')).toBe(320_000);

		// Opus and Vorbis don't go below 6 kbps
		expect(new Quality(-10)._toAudioBitrate('opus')).toBe(6000);
		expect(new Quality(-10)._toAudioBitrate('vorbis')).toBe(6000);

		for (const codec of ['aac', 'opus', 'mp3', 'vorbis', 'ac3', 'eac3', 'dts'] as const) {
			const levels: QualityLevel[] = ['very-low', 'low', 'medium', 'high', 'very-high'];
			const bitrates = levels.map(level => new Quality(level)._toAudioBitrate(codec)!);
			for (let i = 0; i < bitrates.length; i++) {
				expect(bitrates[i]! % 1000, codec).toBe(0);
				if (i > 0) {
					expect(bitrates[i]!, codec).toBeGreaterThanOrEqual(bitrates[i - 1]!);
				}
			}

			expect(new Quality({ bitrate: 123_456 })._toAudioBitrate(codec)).toBe(123_456);
			// A quantizer means nothing for audio
			expect(() => new Quality({ quantizer: 20 })._toAudioBitrate(codec)).toThrow();
		}
	});
});

describe('Encoder configs', () => {
	test('Video', () => {
		// Quantizer-based encoding first, then the bit rate fallback
		const candidates = buildVideoEncoderConfigs({
			codec: 'avc',
			width: 1280,
			height: 720,
			quality: new Quality('medium'),
			framerate: 30,
		});
		const bitrate = new Quality('medium')._toVideoBitrate('avc', 1280, 720);
		expect(candidates).toHaveLength(2);
		expect(candidates[0]).toEqual(
			{
				config: {
					codec: 'avc1.64001f',
					width: 1280,
					height: 720,
					displayWidth: undefined,
					displayHeight: undefined,
					bitrate: undefined,
					bitrateMode: 'quantizer',
					alpha: 'discard',
					framerate: 30,
					latencyMode: undefined,
					hardwareAcceleration: undefined,
					scalabilityMode: undefined,
					contentHint: undefined,
					avc: { format: 'avc' },
				},
				quantizer: 29,
			},
		);
		expect(candidates[1]).toMatchObject({
			config: { codec: 'avc1.64001f', bitrate, bitrateMode: 'variable', avc: { format: 'avc' } },
			quantizer: null,
		});

		// Only the bit rate when there's no quantizer support, or when it's preferred
		expect(buildVideoEncoderConfigs({
			codec: 'vp8',
			width: 640,
			height: 360,
			quality: new Quality('high'),
			framerate: undefined,
		}).map(x => x.quantizer)).toEqual([null]);
		expect(buildVideoEncoderConfigs({
			codec: 'hevc',
			width: 640,
			height: 360,
			quality: new Quality({ quality: 0.5, preferBitrate: true }),
			framerate: undefined,
		}).map(x => [x.quantizer, (x.config as { hevc?: object }).hevc])).toEqual([[null, { format: 'hevc' }]]);
		// Only the quantizer when there's no bit rate to fall back to
		expect(buildVideoEncoderConfigs({
			codec: 'av1',
			width: 640,
			height: 360,
			quality: new Quality({ quantizer: 100 }),
			framerate: undefined,
		}).map(x => [x.quantizer, x.config.bitrateMode])).toEqual([[100, 'quantizer']]);

		// The options are passed through, and a full codec string replaces the generated one
		const [config] = buildVideoEncoderConfigs({
			codec: 'vp9',
			width: 1920,
			height: 1080,
			quality: new Quality({ bitrate: 4_000_000, bitrateMode: 'constant' }),
			framerate: 25,
			squarePixelWidth: 1440,
			squarePixelHeight: 1080,
			alpha: 'keep',
			latencyMode: 'realtime',
			hardwareAcceleration: 'prefer-software',
			scalabilityMode: 'L1T2',
			contentHint: 'motion',
			fullCodecString: 'vp09.00.41.08',
		}).map(x => x.config);
		expect(config).toEqual({
			codec: 'vp09.00.41.08',
			width: 1920,
			height: 1080,
			displayWidth: 1440,
			displayHeight: 1080,
			bitrate: 4_000_000,
			bitrateMode: 'constant',
			alpha: 'keep',
			framerate: 25,
			latencyMode: 'realtime',
			hardwareAcceleration: 'prefer-software',
			scalabilityMode: 'L1T2',
			contentHint: 'motion',
		});

		// The codec string's level fits the bit rate estimate
		expect(buildVideoEncoderConfigs({
			codec: 'avc',
			width: 1920,
			height: 1080,
			quality: new Quality({ bitrate: 30_000_000 }),
			framerate: undefined,
		})[0]!.config.codec).toBe('avc1.640029');
		// ProRes with alpha picks a 4444 profile
		expect(buildVideoEncoderConfigs({
			codec: 'prores',
			width: 1920,
			height: 1080,
			quality: new Quality('medium'),
			framerate: undefined,
			alpha: 'keep',
		})[0]!.config.codec).toBe('ap4h');
	});

	test('Audio', () => {
		expect(buildAudioEncoderConfig({
			codec: 'aac',
			numberOfChannels: 2,
			sampleRate: 48000,
			quality: new Quality('medium'),
		})).toEqual({
			codec: 'mp4a.40.2',
			numberOfChannels: 2,
			sampleRate: 48000,
			bitrate: 128_000,
			bitrateMode: undefined,
			aac: { format: 'aac' },
		});

		expect(buildAudioEncoderConfig({
			codec: 'opus',
			numberOfChannels: 1,
			sampleRate: 48000,
			quality: new Quality({ bitrate: 32_000, bitrateMode: 'constant' }),
		})).toEqual({
			codec: 'opus',
			numberOfChannels: 1,
			sampleRate: 48000,
			bitrate: 32_000,
			bitrateMode: 'constant',
			opus: { format: 'opus' },
		});

		const flac = buildAudioEncoderConfig({
			codec: 'flac',
			numberOfChannels: 6,
			sampleRate: 96000,
			bitrateMode: 'variable',
		});
		expect(flac).toEqual({
			codec: 'flac',
			numberOfChannels: 6,
			sampleRate: 96000,
			bitrate: undefined,
			bitrateMode: 'variable',
		});

		expect(buildAudioEncoderConfig({
			codec: 'eac3',
			numberOfChannels: 6,
			sampleRate: 48000,
			quality: new Quality('low'),
			fullCodecString: 'ec-3',
		}).codec).toBe('ec-3');
	});

	test('Encoding config validation', () => {
		const quality = new Quality('medium');

		const invalidVideo: unknown[] = [
			null,
			{ codec: 'h264', quality },
			{ codec: 'avc' },
			{ codec: 'avc', quality, bitrate: 1_000_000 },
			{ codec: 'avc', quality: 'medium' },
			{ codec: 'avc', bitrate: 0 },
			{ codec: 'avc', quality, keyFrameInterval: -1 },
			{ codec: 'avc', quality, sizeChangeBehavior: 'stretch' },
			{ codec: 'avc', quality, transform: { rotate: 45 } },
			{ codec: 'avc', quality, transform: { width: 640, height: 360 } }, // Needs a fit
			{ codec: 'avc', quality, transform: { frameRate: 0 } },
			{ codec: 'avc', quality, alpha: 'premultiply' },
			{ codec: 'avc', quality, latencyMode: 'fast' },
			{ codec: 'avc', quality, fullCodecString: 'vp8' },
			{ codec: 'avc', quality, hardwareAcceleration: 'gpu' },
			{ codec: 'avc', quality, onEncodedPacket: 'callback' },
		];
		for (const config of invalidVideo) {
			expect(() => validateVideoEncodingConfig(config as never), JSON.stringify(config)).toThrow(TypeError);
		}

		const validVideo: unknown[] = [
			{ codec: 'avc', quality },
			{ codec: 'vp9', bitrate: 1_000_000 },
			{ codec: 'av1', bitrate: quality },
			{
				codec: 'hevc',
				quality,
				transform: { width: 640, height: 360, fit: 'contain' },
				fullCodecString: 'hvc1.1.6.L93.B0',
			},
		];
		for (const config of validVideo) {
			expect(() => validateVideoEncodingConfig(config as never), JSON.stringify(config)).not.toThrow();
		}

		const invalidAudio: unknown[] = [
			{ codec: 'aac' }, // Compressed codecs need a quality
			{ codec: 'wma', quality },
			{ codec: 'opus', quality, bitrate: 64_000 },
			{ codec: 'opus', quality, transform: { sampleRate: 44100.5 } },
			{ codec: 'opus', quality, transform: { sampleFormat: 's24' } },
			{ codec: 'opus', quality, fullCodecString: 'vorbis' },
		];
		for (const config of invalidAudio) {
			expect(() => validateAudioEncodingConfig(config as never), JSON.stringify(config)).toThrow(TypeError);
		}

		for (const codec of ['pcm-s16', 'flac', 'truehd', 'ulaw']) {
			expect(() => validateAudioEncodingConfig({ codec } as never), codec).not.toThrow();
		}
	});
});

describe('Support queries', () => {
	test('Without WebCodecs', async () => {
		expect(await canEncodeVideo('avc')).toBe(false);
		expect(await canEncodeVideo('h264' as VideoCodec)).toBe(false);
		expect(await canEncodeAudio('aac')).toBe(false);
		expect(await canEncodeAudio('pcm-s24be', { numberOfChannels: 8, sampleRate: 192000 })).toBe(true);
		expect(await canEncodeSubtitles('webvtt')).toBe(true);
		expect(await canEncode('alaw')).toBe(true);
		expect(() => canEncode('h264' as VideoCodec)).toThrow(TypeError);

		expect(await canDecodeVideo('vp9')).toBe(false);
		expect(await canDecodeAudio('opus')).toBe(false);
		expect(await canDecodeAudio('pcm-f64')).toBe(true);
		expect(await canDecode('webvtt')).toBe(false);

		expect(await getEncodableAudioCodecs()).toEqual(PCM_AUDIO_CODECS);
		expect(await getDecodableAudioCodecs(['mp3', 'ulaw', 'flac', 'pcm-u8'])).toEqual(['ulaw', 'pcm-u8']);
		expect(await getFirstEncodableAudioCodec(['aac', 'opus', 'pcm-s16', 'pcm-f32'])).toBe('pcm-s16');
		expect(await getFirstEncodableVideoCodec(['avc', 'vp9'])).toBe(null);
	});

	test('Argument validation', async () => {
		await expect(canEncodeVideo('avc', { width: 0 })).rejects.toThrow(TypeError);
		await expect(canEncodeVideo('avc', { height: 720.5 })).rejects.toThrow(TypeError);
		await expect(canEncodeVideo('avc', { frameRate: 0 })).rejects.toThrow(TypeError);
		await expect(canEncodeVideo('avc', { quality: new Quality('low'), bitrate: 1000 })).rejects.toThrow(TypeError);
		await expect(canEncodeVideo('avc', { fullCodecString: 'hev1.1.6.L93.B0' })).rejects.toThrow(TypeError);
		await expect(canEncodeAudio('opus', { numberOfChannels: 0 })).rejects.toThrow(TypeError);
		await expect(canEncodeAudio('opus', { bitrate: 1.5 })).rejects.toThrow(TypeError);
		await expect(canDecodeVideo('avc', { codec: 'vp8' })).rejects.toThrow(TypeError);
		await expect(canDecodeVideo('avc', { codedWidth: -1 })).rejects.toThrow(TypeError);
		await expect(canDecodeAudio('aac', { sampleRate: 0 })).rejects.toThrow(TypeError);
		await expect(canDecodeAudio('aac', { description: 'abc' as never })).rejects.toThrow(TypeError);

		// A quantizer without fallback can't work for a codec without quantizer support
		expect(await canEncodeVideo('vp8', { quality: new Quality({ quantizer: 10 }) })).toBe(false);
	});

	test('Custom coders', async () => {
		const seenVideoConfigs: VideoEncoderConfig[] = [];

		class Vp8Encoder extends CustomVideoEncoder {
			static override supports(codec: VideoCodec, config: VideoEncoderConfig) {
				seenVideoConfigs.push(config);
				return codec === 'vp8';
			}

			override init() {}
			override encode() {}
			override flush() {}
			override close() {}
		}

		class FlacEncoder extends CustomAudioEncoder {
			static override supports(codec: string) {
				return codec === 'flac';
			}

			override init() {}
			override encode() {}
			override flush() {}
			override close() {}
		}

		class Av1Decoder extends CustomVideoDecoder {
			static override supports(codec: VideoCodec, config: VideoDecoderConfig) {
				return codec === 'av1' && config.codedWidth! <= 1920;
			}

			override init() {}
			override decode() {}
			override flush() {}
			override close() {}
		}

		// Registering resets the memoized answers
		expect(await canEncodeVideo('vp8')).toBe(false);
		expect(await canEncodeAudio('flac')).toBe(false);
		expect(await canDecodeVideo('av1')).toBe(false);

		registerEncoder(Vp8Encoder);
		registerEncoder(FlacEncoder);
		registerDecoder(Av1Decoder);
		registerEncoder(Vp8Encoder); // Only warns

		expect(await canEncodeVideo('vp8')).toBe(true);
		expect(seenVideoConfigs.at(-1)).toMatchObject({ codec: 'vp8', width: 1280, height: 720, alpha: 'discard' });
		expect(await canEncodeVideo('vp8', { width: 1921, height: 1081, alpha: 'keep' })).toBe(true);
		// Mediabunny handles alpha itself, so the encoder never has to keep it
		expect(seenVideoConfigs.at(-1)).toMatchObject({ width: 1921, height: 1081, alpha: 'discard' });
		expect(await canEncodeVideo('avc')).toBe(false);

		expect(await canEncodeAudio('flac', { numberOfChannels: 8 })).toBe(true);
		expect(await getEncodableAudioCodecs(['aac', 'flac', 'pcm-s16'])).toEqual(['flac', 'pcm-s16']);
		expect(await getFirstEncodableAudioCodec(['opus', 'flac'])).toBe('flac');

		// The decoder sees the config with defaults filled in
		expect(await canDecodeVideo('av1')).toBe(true);
		expect(await canDecodeVideo('av1', { codedWidth: 3840, codedHeight: 2160 })).toBe(false);
		expect(await canDecodeVideo('av1', { codec: 'av01.0.08M.10', codedWidth: 1920, codedHeight: 1080 })).toBe(true);

		expect(() => registerEncoder(class {} as never)).toThrow(TypeError);
		expect(() => registerDecoder(Vp8Encoder as never)).toThrow(TypeError);
		expect(() => registerEncoder(Av1Decoder as never)).toThrow(TypeError);
	});
});
