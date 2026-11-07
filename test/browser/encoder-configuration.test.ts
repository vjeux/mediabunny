import { describe, expect, test } from 'vitest';
import {
	AudioCodec,
	AudioSampleSink,
	canEncodeAudio,
	canEncodeVideo,
	getFirstEncodableAudioCodec,
	getFirstEncodableVideoCodec,
	PCM_AUDIO_CODECS,
	Quality,
	VideoCodec,
} from '../../src/index.js';
import {
	containerFor,
	containersFor,
	decodeAudio,
	decodeVideo,
	descriptionBytes,
	encodeAudio,
	encodeVideo,
	makeAudio,
	openAudioTrack,
	openVideoTrack,
	VIDEO_TEST_CODECS,
} from './helpers/encoder-configs-harness.js';
import {
	readAv1SequenceHeader,
	readAvcSpsHeaderBytes,
	readVp9KeyFrameHeader,
} from './helpers/encoder-configs-bitstream.js';
import {
	av1DecodesNatively,
	avcHonorsProfile,
	avcKeepsEveryFrame,
	colorSpaceSupport,
	alphaPatternSurvives,
	hungCoderKinds,
	nativeAudioEncode,
	nativeSupportsPreferHardware,
	nativeVideoContradicts,
	negativeTimestampsDecodeCorrectly,
	opusDecodesAt48kHz,
	ProbedVideoCodec,
	qualityRaisesSize,
	videoRoundTrips,
	vp8MeetsBitrate,
	withTimeout,
} from './helpers/encoder-configs-platform.js';

const medium = () => new Quality('medium');

// Codecs both Mediabunny and the platform's own encoder and decoder (checked natively, see encoder-configs-platform.ts)
// can handle; the platform alone can't do much about the rest
const encodableVideoCodecs = async () => {
	const codecs: ProbedVideoCodec[] = [];
	for (const codec of VIDEO_TEST_CODECS as ProbedVideoCodec[]) {
		if (hungCoderKinds.has('video')) {
			return [];
		}

		if (
			await canEncodeVideo(codec, { width: 320, height: 240, quality: medium() })
			&& await videoRoundTrips(codec)
			&& (codec !== 'av1' || await av1DecodesNatively())
		) {
			codecs.push(codec);
		}
	}
	return codecs;
};

// Codecs whose platform encoder emits every frame at its own timestamp, needed for frame-exact checks
const frameExactVideoCodecs = async () => {
	const codecs = await encodableVideoCodecs();
	return await avcKeepsEveryFrame() ? codecs : codecs.filter(x => x !== 'avc');
};

const LITERAL_AUDIO_CODEC_STRINGS: Partial<Record<AudioCodec, string>> = {
	aac: 'mp4a.40.2',
	ac3: 'ac-3',
	eac3: 'ec-3',
};

const hex = (bytes: number[]) => bytes.map(x => x.toString(16).padStart(2, '0')).join('');

const errorMessage = (error: unknown) => error instanceof Error ? error.message : JSON.stringify(error);

describe('Support queries match real encodes', () => {
	test('canEncodeVideo agrees with what VideoSampleSource can encode, across frame sizes', {
		timeout: 60_000,
	}, async () => {
		const sizes: [number, number][] = [
			[320, 240], [16, 16], [18, 18], [8, 8], [2, 2], [1, 1], [17, 9], [321, 241], [1920, 64], [64, 1080],
		];

		for (const codec of VIDEO_TEST_CODECS) {
			for (const [width, height] of sizes) {
				const canEncode = await canEncodeVideo(codec, { width, height, quality: medium() });
				const result = await encodeVideo({
					config: { codec, quality: medium() },
					container: containerFor(codec),
					width,
					height,
					frameCount: 2,
				});

				const isOdd = width % 2 === 1 || height % 2 === 1;
				if (isOdd && (codec === 'avc' || codec === 'hevc')) {
					// 4:2:0 H.26x encoders need even dimensions, which is checked before asking the browser
					expect(canEncode).toBe(false);
					expect(errorMessage(result.error)).toContain('must be even numbers');
					continue;
				}

				if (
					canEncode
					&& result.error !== null
					&& await nativeVideoContradicts(codec as ProbedVideoCodec, width, height)
				) {
					// The platform's own support query accepts what its encoder then fails on
					continue;
				}

				expect({ codec, width, height, encoded: result.error === null }).toEqual({
					codec,
					width,
					height,
					encoded: canEncode,
				});
			}
		}
	});

	test('canEncodeAudio agrees with what AudioSampleSource can encode', { timeout: 120_000 }, async () => {
		// Mediabunny encodes PCM itself; the platform encodes the rest. The cases most likely to hang a platform
		// encoder (multichannel Opus, codecs browsers rarely encode) come last, since a hung encoder stalls all later
		// ones.
		const cases: [AudioCodec, number, number][] = PCM_AUDIO_CODECS.map(codec => [codec, 44100, 2]);
		for (const sampleRate of [8000, 16000, 22050, 44100, 48000, 96000]) {
			for (const numberOfChannels of [1, 2]) {
				cases.push(['opus', sampleRate, numberOfChannels]);
			}
		}
		for (const codec of ['aac', 'mp3', 'ac3', 'eac3', 'vorbis', 'flac'] as AudioCodec[]) {
			cases.push([codec, 48000, 2]);
		}
		cases.push(['opus', 48000, 6], ['opus', 44100, 6]);

		for (const [codec, sampleRate, numberOfChannels] of cases) {
			const isPcm = (PCM_AUDIO_CODECS as readonly string[]).includes(codec);
			const native = isPcm
				? 'works'
				: await nativeAudioEncode(LITERAL_AUDIO_CODEC_STRINGS[codec] ?? codec, sampleRate, numberOfChannels);
			if (native === 'hangs') {
				// The platform's encoder never settled, so no later audio call on this page can be trusted
				break;
			}
			if (native === 'silent') {
				// The platform's encoder outputs silence (Firefox's Vorbis encoder), so whether canEncodeAudio
				// accepts it is up to how Mediabunny treats a broken encoder, and nothing here to compare with
				continue;
			}

			const canEncode = await canEncodeAudio(codec, { sampleRate, numberOfChannels, quality: medium() });
			const encoded = await withTimeout(encodeAudio({
				codec,
				config: { quality: medium() },
				container: 'mov', // Holds every audio codec
				sample: makeAudio({ sampleRate, numberOfChannels, duration: 0.1 }),
			}), 20_000);
			expect({ codec, sampleRate, numberOfChannels, settled: encoded !== null }).toEqual({
				codec,
				sampleRate,
				numberOfChannels,
				settled: true,
			});
			const result = encoded!.value;

			if (canEncode && result.error !== null && native === 'fails') {
				// The platform's own support query accepts what its encoder then fails on
				continue;
			}

			expect({ codec, sampleRate, numberOfChannels, encoded: result.error === null }).toEqual({
				codec,
				sampleRate,
				numberOfChannels,
				encoded: canEncode,
			});
			if (!canEncode) {
				expect(errorMessage(result.error)).toContain('is not supported in this environment');
			}
		}
	});

	test('getFirstEncodable*Codec returns the first codec of the list that encodes', async () => {
		const videoList: VideoCodec[] = ['hevc', 'avc', 'vp9', 'av1', 'vp8'];
		let expectedVideo: VideoCodec | null = null;
		for (const codec of videoList) {
			if (await canEncodeVideo(codec, { width: 640, height: 480 })) {
				expectedVideo = codec;
				break;
			}
		}
		expect(await getFirstEncodableVideoCodec(videoList, { width: 640, height: 480 })).toBe(expectedVideo);
		// Odd sizes rule out the H.26x codecs
		const oddFirst = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9'], { width: 641, height: 480 });
		expect(oddFirst === 'vp9' || oddFirst === null).toBe(true);

		if (hungCoderKinds.has('audio')) {
			return;
		}

		const audioList: AudioCodec[] = ['aac', 'opus', 'pcm-s16'];
		let expectedAudio: AudioCodec | null = null;
		for (const codec of audioList) {
			if (await canEncodeAudio(codec, { numberOfChannels: 2, sampleRate: 48000 })) {
				expectedAudio = codec;
				break;
			}
		}
		expect(await getFirstEncodableAudioCodec(audioList, { numberOfChannels: 2, sampleRate: 48000 }))
			.toBe(expectedAudio);
		// PCM is always encodable, since Mediabunny encodes it itself
		expect(await getFirstEncodableAudioCodec(['pcm-s24'], { numberOfChannels: 8, sampleRate: 7350 }))
			.toBe('pcm-s24');
	});
});

describe('Codec strings match the encoded bitstream', () => {
	test('the decoder config, both containers and the bitstream signal the same codec parameters', {
		timeout: 60_000,
	}, async () => {
		for (const codec of await encodableVideoCodecs()) {
			const codecStrings: string[] = [];

			for (const container of containersFor(codec)) {
				const result = await encodeVideo({
					config: { codec, quality: medium() },
					container,
					width: 320,
					height: 240,
					frameCount: 4,
				});
				expect(result.error).toBe(null);
				expect(result.decoderConfigs.length).toBeGreaterThan(0);

				const decoderConfig = result.decoderConfigs[0]!;
				const { input, track } = await openVideoTrack(result.buffer!);
				const readBack = await track.getCodecParameterString();
				input.dispose();

				// Matroska has no sample entry type, so AVC comes back with the default avc1 prefix
				expect(readBack).toBe(decoderConfig.codec);
				codecStrings.push(decoderConfig.codec);

				const keyPacket = result.packets.find(x => x.type === 'key')!;
				if (codec === 'avc') {
					const description = descriptionBytes(decoderConfig);
					expect(description).not.toBe(null);
					const sps = readAvcSpsHeaderBytes(description!)!;
					expect(sps.nalUnitType).toBe(7);
					expect([sps.recordProfile, sps.recordCompatibility, sps.recordLevel])
						.toEqual([sps.profileIdc, sps.constraintFlags, sps.levelIdc]);
					expect(decoderConfig.codec.slice(5).toLowerCase())
						.toBe(hex([sps.profileIdc, sps.constraintFlags, sps.levelIdc]));
				} else if (codec === 'vp9') {
					const header = readVp9KeyFrameHeader(keyPacket.data)!;
					const [, profile, , bitDepth, chromaSubsampling] = decoderConfig.codec.split('.');
					expect(Number(profile)).toBe(header.profile);
					expect(Number(bitDepth)).toBe(header.bitDepth);
					// 4:2:0 is 0 (vertical) or 1 (colocated with luma) in the codec string; neither is signaled in VP9
					expect(header.subsamplingX && header.subsamplingY).toBe(1);
					if (chromaSubsampling !== undefined) {
						expect([0, 1]).toContain(Number(chromaSubsampling));
					}
					expect([header.width, header.height]).toEqual([320, 240]);
				} else if (codec === 'av1') {
					const header = readAv1SequenceHeader(keyPacket.data);
					expect(header).not.toBe(null);
					const parts = decoderConfig.codec.split('.');
					expect(Number(parts[1])).toBe(header!.seqProfile);
					expect(Number(parts[2]!.slice(0, 2))).toBe(header!.seqLevelIdx0);
					expect(parts[2]!.slice(2)).toBe(header!.seqTier0 ? 'H' : 'M');
					expect(Number(parts[3])).toBe(header!.bitDepth);
					if (parts.length > 4) {
						expect(Number(parts[4])).toBe(header!.monochrome);
						expect(parts[5]!.slice(0, 2)).toBe(`${header!.subsamplingX}${header!.subsamplingY}`);
						expect(Number(parts[9])).toBe(header!.colorRange);
						if (header!.colorDescriptionPresent) {
							expect([Number(parts[6]), Number(parts[7]), Number(parts[8])]).toEqual([
								header!.colorPrimaries,
								header!.transferCharacteristics,
								header!.matrixCoefficients,
							]);
						}
					}
				}
			}

			// Both containers signal the same parameters (modulo the sample entry type)
			expect(codecStrings[0]!.replace(/^avc3/, 'avc1')).toBe(codecStrings[1]!.replace(/^avc3/, 'avc1'));
		}
	});

	test('the signaled level covers the frame size', { timeout: 30_000 }, async () => {
		// Minimum levels for 720p30 and 1080p30: H.264 Table A-1 (MaxFS, MaxMBPS), the VP9 levels page
		// (https://www.webmproject.org/vp9/levels/) and AV1 Annex A.3 (MaxPicSize, MaxDisplayRate)
		const minimumLevels: Partial<Record<VideoCodec, [number, number]>> = {
			avc: [0x1f, 0x28],
			vp9: [31, 40],
			av1: [5, 8],
		};
		const levelOf = (codec: VideoCodec, codecString: string) => {
			if (codec === 'avc') {
				return parseInt(codecString.slice(9, 11), 16);
			}
			return Number(codecString.split('.')[2]!.slice(0, 2));
		};

		for (const codec of await encodableVideoCodecs()) {
			const minimum = minimumLevels[codec];
			if (!minimum) {
				continue;
			}

			for (const [i, [width, height]] of ([[1280, 720], [1920, 1080]] as const).entries()) {
				const result = await encodeVideo({
					config: { codec, quality: medium() },
					container: containerFor(codec),
					width,
					height,
					frameCount: 2,
					trackMetadata: { frameRate: 30 },
				});
				expect(result.error).toBe(null);

				const level = levelOf(codec, result.decoderConfigs[0]!.codec);
				expect({ codec, width, level: level >= minimum[i]! }).toEqual({ codec, width, level: true });
			}
		}
	});

	test('a requested AVC profile is what the SPS and codec string declare', async () => {
		const requests = [['avc1.42001f', 66], ['avc1.4d001f', 77], ['avc1.64001f', 100]] as const;
		for (const [fullCodecString, profileIdc] of requests) {
			if (
				!await canEncodeVideo('avc', { width: 320, height: 240, fullCodecString })
				|| !await avcHonorsProfile(fullCodecString)
			) {
				// Baseline-only encoders (like OpenH264 through GStreamer) produce Baseline whatever they're asked
				continue;
			}

			const result = await encodeVideo({
				config: { codec: 'avc', quality: medium(), fullCodecString },
				container: 'mp4',
				width: 320,
				height: 240,
				frameCount: 2,
			});
			expect(result.error).toBe(null);

			const decoderConfig = result.decoderConfigs[0]!;
			const sps = readAvcSpsHeaderBytes(descriptionBytes(decoderConfig)!)!;
			expect(sps.profileIdc).toBe(profileIdc);
			expect(parseInt(decoderConfig.codec.slice(5, 7), 16)).toBe(profileIdc);
		}
	});
});

describe('Rate control', () => {
	const complexFrameCount = 60;

	test('an explicit VP8 bitrate is met within 35% at 30 fps', { timeout: 30_000 }, async ({ skip }) => {
		if (!await vp8MeetsBitrate()) {
			skip('The platform\'s VP8 encoder misses explicit bitrates');
		}

		for (const bitrate of [300_000, 1_000_000]) {
			const result = await encodeVideo({
				config: { codec: 'vp8', quality: new Quality({ bitrate }) },
				container: 'webm',
				width: 320,
				height: 240,
				frameCount: complexFrameCount,
				kind: 'textured',
				trackMetadata: { frameRate: 30 },
			});
			expect(result.error).toBe(null);
			expect(result.encoderConfigs.at(-1)!.bitrate).toBe(bitrate);

			const bytes = result.packets.reduce((sum, packet) => sum + packet.byteLength, 0);
			const actualBitrate = 8 * bytes / (complexFrameCount / 30);
			expect(actualBitrate).toBeGreaterThan(0.65 * bitrate);
			expect(actualBitrate).toBeLessThan(1.35 * bitrate);
		}
	});

	test('higher quality levels give bigger output', { timeout: 60_000 }, async () => {
		for (const codec of await encodableVideoCodecs()) {
			if (!await qualityRaisesSize(codec)) {
				// The platform's encoder doesn't give more bytes for more quality, even when asked natively
				continue;
			}

			const sizes: number[] = [];
			for (const level of ['very-low', 'medium', 'very-high'] as const) {
				const result = await encodeVideo({
					config: { codec, quality: new Quality(level) },
					container: containerFor(codec),
					width: 320,
					height: 240,
					frameCount: 20,
					kind: 'textured',
					trackMetadata: { frameRate: 30 },
				});
				expect(result.error).toBe(null);
				sizes.push(result.packets.reduce((sum, packet) => sum + packet.byteLength, 0));
			}

			const increasing = sizes[0]! < sizes[1]! && sizes[1]! < sizes[2]!;
			expect({ codec, increasing }).toEqual({ codec, increasing: true });
		}
	});

	test('the rate control method in the encoder config follows the Quality', async () => {
		const configsFor = async (codec: VideoCodec, quality: Quality) => {
			const result = await encodeVideo({
				config: { codec, quality },
				container: containerFor(codec),
				width: 64,
				height: 64,
				frameCount: 1,
			});
			return result;
		};

		// VP8 has no quantizer support, so everything resolves to a bitrate
		const vp8 = await configsFor('vp8', new Quality({ bitrate: 500_000, bitrateMode: 'constant' }));
		expect(vp8.encoderConfigs.map(x => [x.bitrate, x.bitrateMode])).toEqual([[500_000, 'constant']]);

		const vp8Quantizer = await configsFor('vp8', new Quality({ quantizer: 30 }));
		expect(errorMessage(vp8Quantizer.error)).toContain('does not support quantizer-based encoding');

		// Quantizer-capable codecs try a quantizer config first and fall back to a bitrate
		for (const codec of await encodableVideoCodecs()) {
			if (codec === 'vp8') {
				continue;
			}

			const result = await configsFor(codec, new Quality('medium'));
			expect(result.error).toBe(null);
			expect(result.encoderConfigs[0]!.bitrateMode).toBe('quantizer');
			expect(result.encoderConfigs[0]!.bitrate).toBe(undefined);
			if (result.encoderConfigs.length > 1) {
				expect(result.encoderConfigs[1]!.bitrateMode).toBe('variable');
				expect(result.encoderConfigs[1]!.bitrate).toBeGreaterThan(0);
			}
		}
	});
});

describe('Key frames', () => {
	// In realtime mode, since in quality mode encoders may add key frames of their own, which WebCodecs allows:
	// Firefox's AV1 encoder adds one right after each requested one, and its VP8 encoder places some at scene cuts
	const keyTimestamps = async (codec: VideoCodec, keyFrameInterval: number | undefined, timestamps: number[]) => {
		const result = await encodeVideo({
			config: { codec, quality: medium(), keyFrameInterval, latencyMode: 'realtime' },
			container: containerFor(codec),
			width: 160,
			height: 120,
			frameCount: timestamps.length,
			timestamps,
		});
		expect(result.error).toBe(null);
		return result.packets
			.filter(x => x.type === 'key')
			.map(x => Math.round(x.timestamp * 1000) / 1000)
			.sort((a, b) => a - b);
	};

	test('keyFrameInterval puts key frames on its multiples of absolute time', { timeout: 60_000 }, async () => {
		const frames = (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i / 30);

		for (const codec of await frameExactVideoCodecs()) {
			expect(await keyTimestamps(codec, undefined, frames(0, 90))).toEqual([0, 2]);
			expect(await keyTimestamps(codec, 0.5, frames(0, 60))).toEqual([0, 0.5, 1, 1.5]);
			expect(await keyTimestamps(codec, 0, frames(0, 10)))
				.toEqual(frames(0, 10).map(x => Math.round(x * 1000) / 1000));
			expect(await keyTimestamps(codec, 1000, frames(0, 90))).toEqual([0]);
			// The first frame is always a key frame; the next one comes at the next multiple
			expect(await keyTimestamps(codec, 2, frames(1000.25, 60))).toEqual([1000.25, 1002.017]);
			expect(await keyTimestamps(codec, 2, frames(-1.5, 60))).toEqual([-1.5, 0]);
		}
	});
});

describe('Encoder options', () => {
	test('latencyMode, contentHint, scalabilityMode and hardwareAcceleration reach the encoder config', {
		timeout: 30_000,
	}, async () => {
		for (const codec of await encodableVideoCodecs()) {
			const result = await encodeVideo({
				config: {
					codec,
					quality: medium(),
					latencyMode: 'realtime',
					contentHint: 'detail',
					scalabilityMode: 'L1T2',
					hardwareAcceleration: 'prefer-software',
				},
				container: containerFor(codec),
				width: 160,
				height: 120,
				frameCount: 6,
				trackMetadata: { frameRate: 30 },
			});

			for (const config of result.encoderConfigs) {
				expect(config).toMatchObject({
					latencyMode: 'realtime',
					contentHint: 'detail',
					scalabilityMode: 'L1T2',
					hardwareAcceleration: 'prefer-software',
					framerate: 30,
					width: 160,
					height: 120,
				});
			}

			if (result.error === null) {
				const { input, track } = await openVideoTrack(result.buffer!);
				expect((await decodeVideo(track)).length).toBe(6);
				input.dispose();
			} else {
				expect(errorMessage(result.error)).toContain('is not supported in this environment');
			}
		}
	});

	test('temporal layers keep every frame decodable', { timeout: 30_000 }, async () => {
		for (const codec of await frameExactVideoCodecs()) {
			if (!await canEncodeVideo(codec, { width: 160, height: 120, scalabilityMode: 'L1T3' })) {
				continue;
			}

			const result = await encodeVideo({
				config: { codec, quality: medium(), scalabilityMode: 'L1T3' },
				container: containerFor(codec),
				width: 160,
				height: 120,
				frameCount: 12,
			});
			expect(result.error).toBe(null);

			const { input, track } = await openVideoTrack(result.buffer!);
			const frames = await decodeVideo(track);
			expect(frames.map(x => Math.round(x.timestamp * 30))).toEqual(Array.from({ length: 12 }, (_, i) => i));
			input.dispose();
		}
	});

	test('prefer-hardware either encodes or fails with a clear error', async () => {
		for (const codec of await encodableVideoCodecs()) {
			const result = await encodeVideo({
				config: { codec, quality: medium(), hardwareAcceleration: 'prefer-hardware' },
				container: containerFor(codec),
				width: 320,
				height: 240,
				frameCount: 2,
			});
			expect(result.encoderConfigs[0]!.hardwareAcceleration).toBe('prefer-hardware');
			if (result.error !== null && !await nativeSupportsPreferHardware(codec)) {
				// Where the platform accepts the config but its encoder fails later, the error is the platform's own
				expect(errorMessage(result.error))
					.toContain('hardware acceleration: prefer-hardware) is not supported');
			}
		}
	});

	test('a scalability mode the browser can\'t do fails with a clear error', async () => {
		for (const codec of await encodableVideoCodecs()) {
			const result = await encodeVideo({
				config: { codec, quality: medium(), scalabilityMode: 'L3T3_KEY' },
				container: containerFor(codec),
				width: 160,
				height: 120,
				frameCount: 1,
			});
			if (result.error !== null) {
				expect(errorMessage(result.error)).toContain('is not supported in this environment');
			}
		}
	});

	test('alpha: keep carries the alpha of I420A frames in WebM, discard drops it', { timeout: 30_000 }, async () => {
		for (const codec of (await encodableVideoCodecs()).filter(x => x === 'vp8' || x === 'vp9' || x === 'av1')) {
			// Alpha is encoded as the luma of a second stream, so its values depend on the platform's codec keeping
			// luma
			const alphaValuesSurvive = await alphaPatternSurvives(codec);

			for (const alpha of ['keep', 'discard'] as const) {
				const result = await encodeVideo({
					config: { codec, quality: new Quality({ bitrate: 2_000_000 }), alpha },
					container: 'webm',
					width: 160,
					height: 120,
					frameCount: 3,
					kind: 'I420A',
				});
				expect(result.error).toBe(null);
				expect(result.packets.every(x => !!x.sideData.alpha === (alpha === 'keep'))).toBe(true);

				const { input, track } = await openVideoTrack(result.buffer!);
				expect(await track.canBeTransparent()).toBe(alpha === 'keep');
				const frames = await decodeVideo(track);
				expect(frames.length).toBe(3);
				for (const frame of frames) {
					// Decoders may output the merged frames as I420A or, like Firefox's, as BGRA
					if (alpha === 'keep') {
						expect(frame.alpha).not.toBe(null);
						if (alphaValuesSurvive) {
							expect(frame.alpha![0]).toBeGreaterThan(245);
							expect(Math.abs(frame.alpha![1] - 64)).toBeLessThan(10);
						}
					} else {
						expect(frame.alpha === null || Math.min(...frame.alpha) > 245).toBe(true);
					}
				}
				input.dispose();
			}

			// MP4 has no way to store the alpha side data, so the video comes out opaque
			const mp4 = await encodeVideo({
				config: { codec, quality: medium(), alpha: 'keep' },
				container: 'mp4',
				width: 160,
				height: 120,
				frameCount: 2,
				kind: 'I420A',
			});
			expect(mp4.error).toBe(null);
			const { input, track } = await openVideoTrack(mp4.buffer!);
			expect((await decodeVideo(track)).map(x => x.alpha)).toEqual([null, null]);
			input.dispose();
		}
	});

	test('sizeChangeBehavior keeps the size of the first frame, and deny rejects other sizes', {
		timeout: 30_000,
	}, async () => {
		const sizes: [number, number][] = [[160, 120], [320, 240], [100, 100], [162, 120]];

		for (const codec of await frameExactVideoCodecs()) {
			for (const sizeChangeBehavior of ['passThrough', 'fill', 'contain', 'cover'] as const) {
				const result = await encodeVideo({
					config: { codec, quality: medium(), sizeChangeBehavior },
					container: containerFor(codec),
					width: 160,
					height: 120,
					frameCount: sizes.length,
					sizes,
				});
				expect(result.error).toBe(null);

				const { input, track } = await openVideoTrack(result.buffer!);
				expect([await track.getDisplayWidth(), await track.getDisplayHeight()]).toEqual([160, 120]);
				const frames = await decodeVideo(track);
				expect(frames.map(x => [x.codedWidth, x.codedHeight])).toEqual(sizes.map(() => [160, 120]));
				input.dispose();
			}

			const denied = await encodeVideo({
				config: { codec, quality: medium() },
				container: containerFor(codec),
				width: 160,
				height: 120,
				frameCount: sizes.length,
				sizes,
			});
			expect(errorMessage(denied.error)).toContain('Video sample size must remain constant');
		}
	});
});

describe('Frame geometry and timing', () => {
	test('non-square pixels reach the encoder config and the container', { timeout: 30_000 }, async () => {
		for (const codec of await encodableVideoCodecs()) {
			for (const container of containersFor(codec)) {
				for (const [displayWidth, displayHeight] of [[640, 240], [320, 480], [427, 240]] as const) {
					const result = await encodeVideo({
						config: { codec, quality: medium() },
						container,
						width: 320,
						height: 240,
						frameCount: 2,
						displaySize: [displayWidth, displayHeight],
					});
					expect(result.error).toBe(null);
					expect(result.encoderConfigs[0])
						.toMatchObject({ width: 320, height: 240, displayWidth, displayHeight });

					const { input, track } = await openVideoTrack(result.buffer!);
					expect([await track.getCodedWidth(), await track.getCodedHeight()]).toEqual([320, 240]);
					expect([await track.getDisplayWidth(), await track.getDisplayHeight()])
						.toEqual([displayWidth, displayHeight]);
					input.dispose();
				}
			}
		}
	});

	test('the encoder is configured with the size after transform', async () => {
		for (const codec of await encodableVideoCodecs()) {
			const result = await encodeVideo({
				config: { codec, quality: medium(), transform: { width: 200, height: 100, fit: 'fill' } },
				container: containerFor(codec),
				width: 320,
				height: 240,
				frameCount: 2,
			});
			expect(result.error).toBe(null);
			expect(result.encoderConfigs[0]).toMatchObject({ width: 200, height: 100 });

			const { input, track } = await openVideoTrack(result.buffer!);
			const frames = await decodeVideo(track);
			expect(frames.map(x => [x.codedWidth, x.codedHeight])).toEqual([[200, 100], [200, 100]]);
			input.dispose();
		}
	});

	test('with transform.frameRate, key frames fall on the normalized timeline', async () => {
		for (const codec of await frameExactVideoCodecs()) {
			const result = await encodeVideo({
				// Realtime mode, so that the key frames are the requested ones only (see keyTimestamps)
				config: {
					codec,
					quality: medium(),
					keyFrameInterval: 1,
					transform: { frameRate: 10 },
					latencyMode: 'realtime',
				},
				container: containerFor(codec),
				width: 160,
				height: 120,
				frameCount: 75, // 2.5 s at 30 fps
				frameRate: 30,
			});
			expect(result.error).toBe(null);
			expect(result.packets.length).toBe(25);
			const keyTimestamps = result.packets
				.filter(x => x.type === 'key')
				.map(x => Math.round(x.timestamp * 10) / 10)
				.sort((a, b) => a - b);
			expect(keyTimestamps).toEqual([0, 1, 2]);
		}
	});
});

describe('Callbacks', () => {
	test('onEncoderConfig, onEncodedPacket and onEncodedSample observe the encode', async () => {
		for (const codec of await frameExactVideoCodecs()) {
			const result = await encodeVideo({
				config: { codec, quality: medium() },
				container: containerFor(codec),
				width: 160,
				height: 120,
				frameCount: 5,
				trackMetadata: { frameRate: 25 },
				frameRate: 25,
			});
			expect(result.error).toBe(null);

			const lastConfig = result.encoderConfigs.at(-1)!;
			expect(lastConfig).toMatchObject({ width: 160, height: 120, framerate: 25, alpha: 'discard' });
			expect(result.packets.length).toBe(5);
			expect(result.decoderConfigs.length).toBeGreaterThan(0);
			expect(result.decoderConfigs[0]).toMatchObject({ codedWidth: 160, codedHeight: 120 });
			expect(result.encodedSampleTimestamps).toEqual([0, 0.04, 0.08, 0.12, 0.16]);
			// Packets come in decode order, which differs from presentation order with B-frames
			expect(result.packets.map(x => x.timestamp).sort((a, b) => a - b)).toEqual([0, 0.04, 0.08, 0.12, 0.16]);
		}
	});
});

describe('Color metadata', () => {
	const spaces: [string, VideoColorSpaceInit][] = [
		['bt709', { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }],
		['bt709 full range', { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true }],
		['smpte170m', { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false }],
		['bt470bg sRGB', { primaries: 'bt470bg', transfer: 'iec61966-2-1', matrix: 'bt470bg', fullRange: true }],
		['bt2020 PQ', {
			primaries: 'bt2020' as VideoColorPrimaries,
			transfer: 'pq' as VideoTransferCharacteristics,
			matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
			fullRange: false,
		}],
	];

	test('the color space of the frames reaches the decoder config, the container and the decoder', {
		timeout: 60_000,
	}, async () => {
		for (const codec of await encodableVideoCodecs()) {
			for (const container of containersFor(codec)) {
				for (const [name, colorSpace] of spaces) {
					// The color space reaches the container through the encoder's decoder config, and the decoded
					// frames through the platform's decoder
					const support = await colorSpaceSupport(JSON.stringify({ codec, colorSpace }));
					const { encoderReports, decoderReports } = support;

					const result = await encodeVideo({
						config: { codec, quality: medium() },
						container,
						width: 160,
						height: 120,
						frameCount: 2,
						colorSpace,
					});
					expect(result.error).toBe(null);

					const label = { codec, container, name };
					const { input, track } = await openVideoTrack(result.buffer!);
					if (encoderReports) {
						expect({ ...label, colorSpace: { ...result.decoderConfigs[0]!.colorSpace } })
							.toEqual({ ...label, colorSpace });
						expect({ ...label, colorSpace: await track.getColorSpace() }).toEqual({ ...label, colorSpace });
					}
					// The decoder gets the container's color space, so it needs the encoder to have reported it too
					if (encoderReports && decoderReports) {
						const frames = await decodeVideo(track);
						expect({ ...label, colorSpace: frames[0]!.colorSpace }).toEqual({ ...label, colorSpace });
					}
					input.dispose();
				}
			}
		}
	});
});

describe('Audio', () => {
	test('Opus output declares 48 kHz and keeps the channel count at any input rate', {
		timeout: 180_000,
	}, async ({ skip }) => {
		if (hungCoderKinds.has('audio') || await nativeAudioEncode('opus', 48000, 2, 48000) !== 'works') {
			skip('The platform can\'t encode and decode Opus');
		}

		// Encoded audio starts below zero (encoder delay), and some decoders scramble the timestamps that follow
		const timingDecodesCorrectly = await negativeTimestampsDecodeCorrectly();

		for (const sampleRate of [8000, 11025, 16000, 22050, 44100, 48000, 96000]) {
			for (const numberOfChannels of [1, 2]) {
				// Natively first, decoding at 48 kHz like the read-back does; a hung coder stalls everything after it
				const native = await nativeAudioEncode('opus', sampleRate, numberOfChannels, 48000);
				if (native === 'hangs') {
					return;
				} else if (native !== 'works') {
					continue;
				}

				const encoded = await withTimeout(encodeAudio({
					codec: 'opus',
					config: { quality: medium() },
					container: 'webm',
					sample: makeAudio({ sampleRate, numberOfChannels, duration: 1, clickTime: 0.25 }),
				}), 20_000);
				expect({ sampleRate, numberOfChannels, settled: encoded !== null })
					.toEqual({ sampleRate, numberOfChannels, settled: true });
				const result = encoded!.value;
				expect(result.error).toBe(null);
				expect(result.encoderConfigs[0]).toMatchObject({ codec: 'opus', sampleRate, numberOfChannels });

				const { input, track } = await openAudioTrack(result.buffer!);
				expect(await track.getSampleRate()).toBe(48000);
				expect(await track.getNumberOfChannels()).toBe(numberOfChannels);

				const decodedResult = await withTimeout(decodeAudio(track), 20_000);
				expect({ sampleRate, numberOfChannels, decoded: decodedResult !== null })
					.toEqual({ sampleRate, numberOfChannels, decoded: true });
				const decoded = decodedResult!.value;
				if (await opusDecodesAt48kHz()) {
					// Opus decodes at 48 kHz whatever the input rate was, though some decoders output the input rate
					expect(decoded.sampleRate).toBe(48000);
				}
				if (timingDecodesCorrectly) {
					// The click comes out where it went in, give or take a few milliseconds of encoder delay handling
					expect(Math.abs(decoded.peakTime - 0.25)).toBeLessThan(0.007);
					expect(decoded.end).toBeGreaterThan(0.96);
					expect(decoded.end).toBeLessThan(1.03);
				}
				input.dispose();
			}
		}
	});

	test('PCM codecs keep every sample, to within their precision', { timeout: 30_000 }, async () => {
		const tolerances: Record<string, number> = {
			'pcm-u8': 1 / 128, 'pcm-s8': 1 / 128, 'ulaw': 0.04, 'alaw': 0.04,
		};

		for (const codec of PCM_AUDIO_CODECS) {
			const sampleRate = 22050;
			const input = makeAudio({ sampleRate, numberOfChannels: 2, duration: 0.25 });
			const expected = new Float32Array(input.numberOfFrames);
			input.copyTo(expected, { planeIndex: 0, format: 'f32-planar' });

			const result = await encodeAudio({ codec, container: 'mov', sample: input });
			expect(result.error).toBe(null);

			const { input: readInput, track } = await openAudioTrack(result.buffer!);
			expect(await track.getCodec()).toBe(codec);
			let offset = 0;
			let maxError = 0;
			for await (using sample of new AudioSampleSink(track).samples()) {
				const values = new Float32Array(sample.numberOfFrames);
				sample.copyTo(values, { planeIndex: 0, format: 'f32-planar' });
				for (let i = 0; i < values.length; i++) {
					maxError = Math.max(maxError, Math.abs(values[i]! - expected[offset + i]!));
				}
				offset += values.length;
			}
			readInput.dispose();

			expect({ codec, frames: offset }).toEqual({ codec, frames: expected.length });
			expect(maxError).toBeLessThanOrEqual(tolerances[codec] ?? 1e-4);
		}
	});
});
