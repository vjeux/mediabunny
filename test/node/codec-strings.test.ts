import { describe, expect, test } from 'vitest';
import {
	buildAudioCodecString,
	buildVideoCodecString,
	extractAudioCodecString,
	extractVideoCodecString,
	generateAv1CodecConfigurationFromCodecString,
	generateVp9CodecConfigurationFromCodecString,
	inferCodecFromCodecString,
	validateAudioChunkMetadata,
	validateVideoChunkMetadata,
} from '../../src/codec.js';
import {
	HevcDecoderConfigurationRecord,
	extractAv1CodecInfoFromPacket,
	serializeHevcDecoderConfigurationRecord,
} from '../../src/codec-data.js';
import { AV1_FIXTURES, hexToBytes } from './helpers/codecs-fixtures.js';

// Codec strings follow RFC 6381 and ISO/IEC 14496-15 Annex E (avc1/avc3, hev1/hvc1), the codecs parameter sections of
// https://www.webmproject.org/vp9/mp4/ (vp09) and https://aomediacodec.github.io/av1-isobmff/ (av01), and the WebCodecs
// codec registrations.

type VideoTrackInfo = Parameters<typeof extractVideoCodecString>[0];

const videoTrackInfo = (info: Partial<VideoTrackInfo>): VideoTrackInfo => ({
	width: 1920,
	height: 1080,
	codec: null,
	codecDescription: null,
	colorSpace: null,
	avcType: null,
	avcCodecInfo: null,
	hevcCodecInfo: null,
	vp9CodecInfo: null,
	av1CodecInfo: null,
	proresFormat: null,
	...info,
});

const hevcRecord = (record: Partial<HevcDecoderConfigurationRecord>): HevcDecoderConfigurationRecord => ({
	configurationVersion: 1,
	generalProfileSpace: 0,
	generalTierFlag: 0,
	generalProfileIdc: 1,
	generalProfileCompatibilityFlags: 0x60000000,
	generalConstraintIndicatorFlags: new Uint8Array([0xb0, 0, 0, 0, 0, 0]),
	generalLevelIdc: 93,
	minSpatialSegmentationIdc: 0,
	parallelismType: 0,
	chromaFormatIdc: 1,
	bitDepthLumaMinus8: 0,
	bitDepthChromaMinus8: 0,
	avgFrameRate: 0,
	constantFrameRate: 0,
	numTemporalLayers: 1,
	temporalIdNested: 1,
	lengthSizeMinusOne: 3,
	arrays: [],
	...record,
});

describe('Codec strings for encoder configs', () => {
	test('AVC picks a level that fits frame size and bit rate', () => {
		// Table A-1 of H.264 (as reproduced by FFmpeg's libavcodec/h264_levels.c): level_idc, MaxFS in macroblocks and
		// MaxBR in units of cpbBrVclFactor bits/s. Level 1b, an optional rung, is left out.
		const levels: [number, number, number][] = [
			[10, 99, 64], [11, 396, 192], [12, 396, 384], [13, 396, 768], [20, 396, 2000], [21, 792, 4000],
			[22, 1620, 4000], [30, 1620, 10000], [31, 3600, 14000], [32, 5120, 20000], [40, 8192, 20000],
			[41, 8192, 50000], [42, 8704, 50000], [50, 22080, 135000], [51, 36864, 240000], [52, 36864, 240000],
			[60, 139264, 240000], [61, 139264, 480000], [62, 139264, 800000],
		];
		const lowestLevelIndex = (macroblocks: number, bitrate: number, cpbBrVclFactor: number) => {
			const index = levels.findIndex(([, maxFs, maxBr]) => {
				return macroblocks <= maxFs && bitrate <= maxBr * cpbBrVclFactor;
			});
			return index === -1 ? levels.length - 1 : index;
		};

		const cases: [number, number, number][] = [
			[176, 144, 64_000], // 99 MBs: level 1
			[176, 144, 100_000], // Above level 1's bit rate: level 1.1
			[320, 240, 300_000], // 300 MBs: level 1.2
			[352, 288, 1_000_000], // 396 MBs: level 2
			[640, 480, 1_000_000], // 1200 MBs: level 2.2
			[1280, 720, 5_000_000], // 3600 MBs: level 3.1
			[1920, 1080, 10_000_000], // 120x68 = 8160 MBs: level 4
			[1918, 1078, 10_000_000], // Partial macroblocks count fully
			[1920, 1080, 30_000_000], // Above level 4's bit rate: level 4.1
			[2560, 1440, 10_000_000], // 14400 MBs: level 5
			[3840, 2160, 40_000_000], // 32400 MBs: level 5.1
			[7680, 4320, 40_000_000], // 129600 MBs: level 6
			[1920, 1080, 500_000_000], // Level 6.1 for High profile bit rates, 6.2 for Baseline/Main ones
			[16384, 16384, 1_000_000], // Too large for any level: the highest one
		];

		for (const [width, height, bitrate] of cases) {
			const codecString = buildVideoCodecString('avc', width, height, bitrate, false);
			expect(codecString.slice(0, 9), codecString).toBe('avc1.6400'); // High profile, no constraints

			// The string is for the High profile, whose MaxBR is 1.25 times Table A-1's (cpbBrVclFactor 1250). Any
			// level from the lowest one that fits with that factor up to the lowest one that fits with the stricter
			// Baseline/Main factor (1000) declares the stream correctly.
			const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
			const lowest = lowestLevelIndex(macroblocks, bitrate, 1250);
			const conservative = lowestLevelIndex(macroblocks, bitrate, 1000);
			const index = levels.findIndex(([levelIdc]) => levelIdc === parseInt(codecString.slice(9), 16));
			expect(index, codecString).toBeGreaterThanOrEqual(lowest);
			expect(index, codecString).toBeLessThanOrEqual(conservative);
		}
	});

	test('HEVC picks the lowest level and tier that fit picture size and bit rate', () => {
		// Table A.8 of H.265: MaxLumaPs and the Main and High tier MaxBR
		const cases: [number, number, number, string][] = [
			[176, 144, 100_000, 'hev1.1.6.L30.B0'],
			[640, 480, 1_000_000, 'hev1.1.6.L90.B0'],
			[1280, 720, 8_000_000, 'hev1.1.6.L93.B0'],
			[1920, 1080, 5_000_000, 'hev1.1.6.L120.B0'],
			[1920, 1080, 25_000_000, 'hev1.1.6.H120.B0'], // Over the Main tier's 12 Mbps
			[3840, 2160, 20_000_000, 'hev1.1.6.L150.B0'],
			[7680, 4320, 50_000_000, 'hev1.1.6.L180.B0'],
			[16384, 16384, 1_000_000, 'hev1.1.6.H186.B0'],
		];

		for (const [width, height, bitrate, expected] of cases) {
			expect(buildVideoCodecString('hevc', width, height, bitrate, false)).toBe(expected);
		}
	});

	test('VP9 picks the lowest level that fits picture size and bit rate', () => {
		// https://www.webmproject.org/vp9/levels/
		const cases: [number, number, number, string][] = [
			[176, 144, 100_000, 'vp09.00.10.08'],
			[256, 144, 500_000, 'vp09.00.11.08'],
			[320, 240, 500_000, 'vp09.00.20.08'],
			[640, 480, 5_000_000, 'vp09.00.30.08'],
			[1280, 720, 2_000_000, 'vp09.00.31.08'],
			[1920, 1080, 10_000_000, 'vp09.00.40.08'],
			[1920, 1080, 25_000_000, 'vp09.00.41.08'],
			[3840, 2160, 40_000_000, 'vp09.00.50.08'],
			[7680, 4320, 100_000_000, 'vp09.00.60.08'],
			[16384, 16384, 1_000_000, 'vp09.00.62.08'],
		];

		for (const [width, height, bitrate, expected] of cases) {
			expect(buildVideoCodecString('vp9', width, height, bitrate, false)).toBe(expected);
		}
	});

	test('AV1 picks the lowest level and tier that fit picture size and bit rate', () => {
		// Annex A.3 of the AV1 specification: MaxPicSize and the Main and High tier MaxBitrate
		const cases: [number, number, number, string][] = [
			[176, 144, 100_000, 'av01.0.00M.08'], // 2.0
			[512, 288, 2_000_000, 'av01.0.01M.08'], // 2.1
			[640, 480, 1_000_000, 'av01.0.04M.08'], // 3.0
			[1280, 720, 5_000_000, 'av01.0.05M.08'], // 3.1
			[1920, 1080, 10_000_000, 'av01.0.08M.08'], // 4.0
			[1920, 1080, 25_000_000, 'av01.0.08H.08'], // 4.0, over the Main tier's 12 Mbps
			[3840, 2160, 20_000_000, 'av01.0.12M.08'], // 5.0
		];

		for (const [width, height, bitrate, expected] of cases) {
			expect(buildVideoCodecString('av1', width, height, bitrate, false)).toBe(expected);
		}
	});

	test('VP8 and ProRes', () => {
		expect(buildVideoCodecString('vp8', 1920, 1080, 5_000_000, false)).toBe('vp8');

		// The ProRes profile is the one whose target data rate (scaled by picture size) is closest to the bit rate
		expect(buildVideoCodecString('prores', 1920, 1080, 40_000_000, false)).toBe('apco');
		expect(buildVideoCodecString('prores', 1920, 1080, 110_000_000, false)).toBe('apcs');
		expect(buildVideoCodecString('prores', 1920, 1080, 150_000_000, false)).toBe('apcn');
		expect(buildVideoCodecString('prores', 1920, 1080, 1_000_000_000, false)).toBe('apch');
		expect(buildVideoCodecString('prores', 1920, 1080, 300_000_000, true)).toBe('ap4h');
		expect(buildVideoCodecString('prores', 1920, 1080, 600_000_000, true)).toBe('ap4x');
		// Four times the pixels raise the 422 HQ target above 800 Mbps
		expect(buildVideoCodecString('prores', 3840, 2160, 800_000_000, false)).toBe('apch');
		expect(buildVideoCodecString('prores', 3840, 2160, 400_000_000, false)).toBe('apcs');
	});

	test('Audio', () => {
		expect(buildAudioCodecString('aac', 2, 48000)).toBe('mp4a.40.2');
		expect(buildAudioCodecString('aac', 6, 44100)).toBe('mp4a.40.2');
		expect(buildAudioCodecString('mp3', 2, 44100)).toBe('mp3');
		expect(buildAudioCodecString('opus', 2, 48000)).toBe('opus');
		expect(buildAudioCodecString('vorbis', 2, 48000)).toBe('vorbis');
		expect(buildAudioCodecString('flac', 2, 48000)).toBe('flac');
		expect(buildAudioCodecString('ac3', 6, 48000)).toBe('ac-3');
		expect(buildAudioCodecString('eac3', 6, 48000)).toBe('ec-3');
		expect(buildAudioCodecString('dts', 6, 48000)).toBe('dtsc');
		expect(buildAudioCodecString('truehd', 8, 48000)).toBe('mlpa');

		for (const codec of ['pcm-s16', 'pcm-s24be', 'pcm-f32', 'pcm-u8', 'ulaw', 'alaw'] as const) {
			expect(buildAudioCodecString(codec, 2, 48000)).toBe(codec);
		}
	});
});

describe('Codec strings from track info', () => {
	test('AVC', () => {
		const record = {
			configurationVersion: 1,
			avcProfileIndication: 0x42,
			profileCompatibility: 0xc0,
			avcLevelIndication: 0x1e,
			lengthSizeMinusOne: 3,
			sequenceParameterSets: [],
			pictureParameterSets: [],
			chromaFormat: null,
			bitDepthLumaMinus8: null,
			bitDepthChromaMinus8: null,
			sequenceParameterSetExt: null,
		};

		// Lowercase hex digits of profile_idc, the constraint flags byte and level_idc
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'avc',
			avcType: 1,
			avcCodecInfo: record,
		}))).toBe('avc1.42c01e');
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'avc',
			avcType: 3,
			avcCodecInfo: record,
		}))).toBe('avc3.42c01e');

		// Bytes 1 to 3 of an avcC box
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'avc',
			avcType: 1,
			codecDescription: new Uint8Array([1, 0x64, 0x00, 0x2a, 0xff, 0xe1]),
		}))).toBe('avc1.64002a');

		expect(() => extractVideoCodecString(videoTrackInfo({
			codec: 'avc',
			avcType: 1,
			codecDescription: new Uint8Array([1, 0x64, 0x00]),
		}))).toThrow(TypeError);
	});

	test('HEVC', () => {
		// ISO/IEC 14496-15, E.3: profile space letter + profile_idc, the 32 compatibility flags in reverse bit order as
		// hex, tier letter + level_idc, then the six constraint bytes as hex without trailing zero bytes
		const cases: [Partial<HevcDecoderConfigurationRecord>, string][] = [
			[{}, 'hev1.1.6.L93.B0'], // The example from E.3
			[{
				generalProfileIdc: 2,
				generalProfileCompatibilityFlags: 0x20000000,
				generalLevelIdc: 120,
			}, 'hev1.2.4.L120.B0'],
			[{
				generalProfileSpace: 1,
				generalTierFlag: 1,
				generalProfileIdc: 4,
				generalProfileCompatibilityFlags: 0x01000000,
				generalLevelIdc: 153,
				generalConstraintIndicatorFlags: new Uint8Array([0x90, 0x00, 0x08, 0x00, 0x00, 0x00]),
			}, 'hev1.A4.80.H153.90.0.8'],
			[{
				generalProfileSpace: 3,
				generalProfileCompatibilityFlags: 0xffffffff,
				generalConstraintIndicatorFlags: new Uint8Array([1, 2, 3, 4, 5, 0xfe]),
			}, 'hev1.C1.FFFFFFFF.L93.1.2.3.4.5.FE'],
			[{
				generalConstraintIndicatorFlags: new Uint8Array(6),
			}, 'hev1.1.6.L93'],
		];

		for (const [fields, expected] of cases) {
			const record = hevcRecord(fields);
			expect(extractVideoCodecString(videoTrackInfo({ codec: 'hevc', hevcCodecInfo: record }))).toBe(expected);

			// The same, read from the serialized hvcC box
			expect(extractVideoCodecString(videoTrackInfo({
				codec: 'hevc',
				codecDescription: serializeHevcDecoderConfigurationRecord(record),
			}))).toBe(expected);
		}

		expect(() => extractVideoCodecString(videoTrackInfo({
			codec: 'hevc',
			codecDescription: new Uint8Array(22),
		}))).toThrow(TypeError);
	});

	test('VP9', () => {
		const info = {
			profile: 2,
			level: 41,
			bitDepth: 10,
			chromaSubsampling: 1,
			videoFullRangeFlag: 0,
			colourPrimaries: 9,
			transferCharacteristics: 16,
			matrixCoefficients: 9,
		};

		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'vp9',
			vp9CodecInfo: info,
		}))).toBe('vp09.02.41.10.01.09.16.09.00');

		// The optional fields are all-or-none, so they're only dropped when all of them have their default values
		const sdr = { ...info, profile: 0, level: 31, bitDepth: 8, colourPrimaries: 1, transferCharacteristics: 1 };
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'vp9',
			vp9CodecInfo: { ...sdr, matrixCoefficients: 1 },
		}))).toBe('vp09.00.31.08');
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'vp9',
			vp9CodecInfo: { ...sdr, matrixCoefficients: 1, chromaSubsampling: 0 },
		}))).toBe('vp09.00.31.08.00.01.01.01.00');
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'vp9',
			vp9CodecInfo: { ...sdr, matrixCoefficients: 1, videoFullRangeFlag: 1 },
		}))).toBe('vp09.00.31.08.01.01.01.01.01');
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'vp9',
			vp9CodecInfo: { ...sdr, matrixCoefficients: 6 },
		}))).toBe('vp09.00.31.08.01.01.01.06.00');

		// Without codec info, only the level can be derived (from the picture size)
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'vp9',
			width: 1280,
			height: 720,
		}))).toBe('vp09.00.31.08');
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'vp9',
			width: 7680,
			height: 4320,
		}))).toBe('vp09.00.60.08');
	});

	test('AV1', () => {
		const info = {
			profile: 0,
			level: 8,
			tier: 0,
			bitDepth: 10,
			monochrome: 0,
			chromaSubsamplingX: 1,
			chromaSubsamplingY: 1,
			chromaSamplePosition: 2,
			videoFullRangeFlag: 0,
			colourPrimaries: 9,
			transferCharacteristics: 16,
			matrixCoefficients: 9,
		};

		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'av1',
			av1CodecInfo: info,
		}))).toBe('av01.0.08M.10.0.112.09.16.09.0');
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'av1',
			av1CodecInfo: { ...info, tier: 1, level: 13, videoFullRangeFlag: 1 },
		}))).toBe('av01.0.13H.10.0.112.09.16.09.1');

		// The chroma sample position is only given for 4:2:0
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'av1',
			av1CodecInfo: { ...info, profile: 2, chromaSubsamplingY: 0 },
		}))).toBe('av01.2.08M.10.0.100.09.16.09.0');

		// The optional fields are dropped when they're all at their defaults
		const sdr = { ...info, level: 4, bitDepth: 8, chromaSamplePosition: 0 };
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'av1',
			av1CodecInfo: { ...sdr, colourPrimaries: 1, transferCharacteristics: 1, matrixCoefficients: 1 },
		}))).toBe('av01.0.04M.08');
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'av1',
			av1CodecInfo: { ...sdr, colourPrimaries: 1, transferCharacteristics: 13, matrixCoefficients: 1 },
		}))).toBe('av01.0.04M.08.0.110.01.13.01.0');

		// Without color description in the sequence header, the color space known from elsewhere is used...
		const unspecified = { ...sdr, colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2 };
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'av1',
			av1CodecInfo: unspecified,
			colorSpace: {
				primaries: 'bt2020' as VideoColorPrimaries,
				transfer: 'hlg' as VideoTransferCharacteristics,
				matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
				fullRange: false,
			},
		}))).toBe('av01.0.04M.08.0.110.09.18.09.0');
		// ... or else the BT.709 defaults
		expect(extractVideoCodecString(videoTrackInfo({
			codec: 'av1',
			av1CodecInfo: unspecified,
		}))).toBe('av01.0.04M.08');
	});

	test('AV1, from sequence headers written by libaom', () => {
		const expected: Record<string, string> = {
			av1_main_8bit: 'av01.0.00M.08',
			av1_main_10bit_pq: 'av01.0.00M.10.0.110.09.16.09.0',
			av1_high_444: 'av01.1.00M.08.0.000.01.01.01.0',
			av1_professional_422: 'av01.2.00M.08.0.100.01.01.01.0',
			av1_professional_12bit: 'av01.2.00M.12',
			av1_monochrome: 'av01.0.00M.08.1.110.01.01.01.1',
			av1_srgb: 'av01.1.00M.08.0.000.01.13.00.1',
		};

		for (const fixture of AV1_FIXTURES) {
			const av1CodecInfo = extractAv1CodecInfoFromPacket(hexToBytes(fixture.sequenceHeaderObu))!;
			const colorSpace = { fullRange: !!av1CodecInfo.videoFullRangeFlag };
			const codecString = extractVideoCodecString(videoTrackInfo({ codec: 'av1', av1CodecInfo, colorSpace }));
			expect(codecString, fixture.name).toBe(expected[fixture.name]);

			// Building av1C's first four bytes from the codec string gives what FFmpeg writes
			expect(generateAv1CodecConfigurationFromCodecString(codecString), fixture.name)
				.toEqual([...hexToBytes(fixture.av1cHeader)]);
		}
	});

	test('ProRes', () => {
		expect(extractVideoCodecString(videoTrackInfo({ codec: 'prores', proresFormat: 'ap4h' }))).toBe('ap4h');
		expect(extractVideoCodecString(videoTrackInfo({ codec: 'prores' }))).toBe('apch');
	});

	test('Audio', () => {
		const audioTrackInfo = (info: Partial<Parameters<typeof extractAudioCodecString>[0]>) => ({
			codec: null,
			codecDescription: null,
			aacCodecInfo: null,
			dtsFormat: null,
			...info,
		});

		expect(extractAudioCodecString(audioTrackInfo({
			codec: 'aac',
			aacCodecInfo: { isMpeg2: false, objectType: 2 },
		}))).toBe('mp4a.40.2');
		expect(extractAudioCodecString(audioTrackInfo({
			codec: 'aac',
			aacCodecInfo: { isMpeg2: true, objectType: null },
		}))).toBe('mp4a.67');

		// Without a known object type, it comes from the AudioSpecificConfig: HE-AAC (5), and the escape value 31
		// followed by 6 bits for xHE-AAC (31 + 11 = 42)
		expect(extractAudioCodecString(audioTrackInfo({
			codec: 'aac',
			aacCodecInfo: { isMpeg2: false, objectType: null },
			codecDescription: new Uint8Array([0x2b, 0x92, 0x08, 0x00]),
		}))).toBe('mp4a.40.5');
		expect(extractAudioCodecString(audioTrackInfo({
			codec: 'aac',
			aacCodecInfo: { isMpeg2: false, objectType: null },
			codecDescription: new Uint8Array([0xf9, 0x46, 0x40, 0x00]),
		}))).toBe('mp4a.40.42');
		expect(() => extractAudioCodecString(audioTrackInfo({ codec: 'aac' }))).toThrow(TypeError);

		expect(extractAudioCodecString(audioTrackInfo({ codec: 'dts', dtsFormat: 'dtsl' }))).toBe('dtsl');
		expect(extractAudioCodecString(audioTrackInfo({ codec: 'dts' }))).toBe('dtsc');
		expect(extractAudioCodecString(audioTrackInfo({ codec: 'eac3' }))).toBe('ec-3');
		expect(extractAudioCodecString(audioTrackInfo({ codec: 'pcm-s24be' }))).toBe('pcm-s24be');
		expect(() => extractAudioCodecString(audioTrackInfo({}))).toThrow(TypeError);
	});
});

describe('Codec inference from codec strings', () => {
	test('Known strings', () => {
		const cases: [string, string][] = [
			['avc1.64001f', 'avc'],
			['avc3.42c01e', 'avc'],
			['hev1.1.6.L93.B0', 'hevc'],
			['hvc1.2.4.L120.B0', 'hevc'],
			['vp8', 'vp8'],
			['vp09.00.10.08', 'vp9'],
			['av01.0.04M.08', 'av1'],
			['apcn', 'prores'],
			['ap4x', 'prores'],
			['mp4a.40.2', 'aac'],
			['mp4a.40.29', 'aac'],
			['mp4a.67', 'aac'],
			['mp3', 'mp3'],
			['mp4a.69', 'mp3'],
			['mp4a.6B', 'mp3'],
			['mp4a.6b', 'mp3'],
			['mp4a.40.34', 'mp3'],
			['opus', 'opus'],
			['Opus', 'opus'],
			['vorbis', 'vorbis'],
			['flac', 'flac'],
			['ac-3', 'ac3'],
			['ec-3', 'eac3'],
			['dtsc', 'dts'],
			['dtse', 'dts'],
			['mlpa', 'truehd'],
			['ulaw', 'ulaw'],
			['alaw', 'alaw'],
			['pcm-s16', 'pcm-s16'],
			['pcm-f64be', 'pcm-f64be'],
			['webvtt', 'webvtt'],
		];

		for (const [codecString, codec] of cases) {
			expect(inferCodecFromCodecString(codecString), codecString).toBe(codec);
		}
	});

	test('Unknown strings', () => {
		for (const codecString of ['', 'vp9', 'vp8.0', 'av1', 'h264', 'mp4a', 'mp4a.66', 'aac', 'pcm-s', 'apcz']) {
			expect(inferCodecFromCodecString(codecString), codecString).toBe(null);
		}
	});
});

describe('Decoder config validation', () => {
	const videoMetadata = (decoderConfig: Partial<VideoDecoderConfig>) => ({
		decoderConfig: { codec: 'avc1.64001f', codedWidth: 1280, codedHeight: 720, ...decoderConfig },
	});

	test('Video codec strings', () => {
		const valid = [
			'avc1.64001f',
			'avc3.42C01E',
			'hev1.1.6.L93.B0',
			'hvc1.A4.80.H153.90.0.8',
			'hev1.2.4.L120',
			'hev1.1.60000000.L93.B0.0.0.0.0.0',
			'vp8',
			'vp09.00.10.08',
			'vp09.02.41.10.01.09.16.09.00',
			'av01.0.04M.08',
			'av01.0.13H.10.0.112.09.16.09.1',
			'apch',
			'ap4x',
		];
		for (const codec of valid) {
			expect(() => validateVideoChunkMetadata(videoMetadata({ codec }), null), codec).not.toThrow();
		}

		const invalid = [
			'avc1.64001', // Five hex digits
			'avc1.64001g',
			'avc2.64001f',
			'hev1.1.6.93.B0', // No tier
			'hev1.1.123456789.L93', // Nine hex digits of compatibility flags
			'hev1.1.6.L93.B0.0.0.0.0.0.0', // Seven constraint bytes
			'hev1.D1.6.L93',
			'vp8.0',
			'vp09.00.10', // No bit depth
			'vp09.0.10.08',
			'vp09.00.10.08.01', // Optional fields are all-or-none
			'vp09.00.10.08.01.01.01.01',
			'av01.0.4M.08',
			'av01.0.04X.08',
			'av01.0.04M.08.0.110', // Optional fields are all-or-none
			'apchx',
			'vp9',
			'h264',
		];
		for (const codec of invalid) {
			expect(() => validateVideoChunkMetadata(videoMetadata({ codec }), null), codec).toThrow(TypeError);
		}

		// The codec string has to fit to the track
		expect(() => validateVideoChunkMetadata(videoMetadata({ codec: 'avc1.64001f' }), 'avc')).not.toThrow();
		expect(() => validateVideoChunkMetadata(videoMetadata({ codec: 'avc1.64001f' }), 'hevc')).toThrow(TypeError);
		expect(() => validateVideoChunkMetadata(videoMetadata({ codec: 'apco' }), 'prores')).not.toThrow();
	});

	test('Other video config fields', () => {
		expect(() => validateVideoChunkMetadata(undefined, null)).toThrow(TypeError);
		expect(() => validateVideoChunkMetadata({}, null)).toThrow(TypeError);

		const invalidConfigs: Partial<VideoDecoderConfig>[] = [
			{ codedWidth: 0 },
			{ codedWidth: 1280.5 },
			{ codedHeight: -720 },
			{ codedHeight: undefined },
			{ displayAspectWidth: 16 }, // Needs displayAspectHeight as well
			{ displayAspectWidth: 0, displayAspectHeight: 9 },
			{ description: [1, 2, 3] as unknown as Uint8Array },
			{ colorSpace: { primaries: 'bt2021' as VideoColorPrimaries } },
			{ colorSpace: { transfer: 'gamma22' as VideoTransferCharacteristics } },
			{ colorSpace: { matrix: 'ycgco' as VideoMatrixCoefficients } },
			{ colorSpace: { fullRange: 1 as unknown as boolean } },
		];
		for (const config of invalidConfigs) {
			expect(() => validateVideoChunkMetadata(videoMetadata(config), null), JSON.stringify(config))
				.toThrow(TypeError);
		}

		const validConfigs: Partial<VideoDecoderConfig>[] = [
			{ displayAspectWidth: 16, displayAspectHeight: 9 },
			{ description: new Uint8Array(4) },
			{ description: new ArrayBuffer(4) },
			{ description: new DataView(new ArrayBuffer(4)) },
			{ colorSpace: {} },
			{
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
			{ colorSpace: { primaries: null, transfer: null, matrix: null, fullRange: null } },
		];
		for (const config of validConfigs) {
			expect(() => validateVideoChunkMetadata(videoMetadata(config), null), JSON.stringify(config))
				.not.toThrow();
		}
	});

	test('Audio codec strings', () => {
		const audioMetadata = (decoderConfig: Partial<AudioDecoderConfig>) => ({
			decoderConfig: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, ...decoderConfig },
		});

		const valid: Partial<AudioDecoderConfig>[] = [
			{ codec: 'mp4a.40.2' },
			{ codec: 'mp4a.40.02' },
			{ codec: 'mp4a.40.5' },
			{ codec: 'mp4a.40.05' },
			{ codec: 'mp4a.40.29' },
			{ codec: 'mp4a.67' },
			{ codec: 'mp3' },
			{ codec: 'mp4a.69' },
			{ codec: 'mp4a.6B' },
			{ codec: 'mp4a.6b' },
			{ codec: 'opus' },
			{ codec: 'opus', description: new Uint8Array(19) },
			{ codec: 'vorbis', description: new Uint8Array(100) },
			{ codec: 'flac', description: new Uint8Array(42) },
			{ codec: 'ac-3' },
			{ codec: 'ec-3' },
			{ codec: 'dtsc' },
			{ codec: 'dtsh' },
			{ codec: 'dtsl' },
			{ codec: 'dtse' },
			{ codec: 'mlpa' },
			{ codec: 'ulaw' },
			{ codec: 'alaw' },
			{ codec: 'pcm-s16' },
			{ codec: 'pcm-u8' },
			{ codec: 'pcm-f64be' },
		];
		for (const config of valid) {
			expect(() => validateAudioChunkMetadata(audioMetadata(config), null), config.codec).not.toThrow();
		}

		const invalid: Partial<AudioDecoderConfig>[] = [
			{ codec: 'mp4a.40.3' },
			{ codec: 'mp4a.40' },
			{ codec: 'mp4a.68' },
			{ codec: 'mp3.1' },
			{ codec: 'opus', description: new Uint8Array(10) }, // Shorter than an identification header
			{ codec: 'Opus' },
			{ codec: 'vorbis' }, // The description is required
			{ codec: 'flac' }, // The description is required...
			{ codec: 'flac', description: new Uint8Array(41) }, // ... and must hold the STREAMINFO block
			{ codec: 'ac3' },
			{ codec: 'eac3' },
			{ codec: 'dtsx' },
			{ codec: 'mlpa.1' },
			{ codec: 'pcm-s20' },
			{ codec: 'pcm-u16' },
			{ codec: 'aac' },
			{ sampleRate: 0 },
			{ sampleRate: 44100.5 },
			{ numberOfChannels: 0 },
			{ description: 'abc' as unknown as Uint8Array },
		];
		for (const config of invalid) {
			expect(() => validateAudioChunkMetadata(audioMetadata(config), null), JSON.stringify(config))
				.toThrow(TypeError);
		}

		expect(() => validateAudioChunkMetadata(audioMetadata({ codec: 'mp4a.6B' }), 'mp3')).not.toThrow();
		expect(() => validateAudioChunkMetadata(audioMetadata({ codec: 'mp4a.40.2' }), 'mp3')).toThrow(TypeError);
	});
});

describe('Codec configuration from codec strings', () => {
	test('VP9 CodecPrivate', () => {
		// Feature ID, length and value for profile, level, bit depth and chroma subsampling
		expect(generateVp9CodecConfigurationFromCodecString('vp09.02.41.10.00.09.16.09.00'))
			.toEqual([1, 1, 2, 2, 1, 41, 3, 1, 10, 4, 1, 0]);
		// Chroma subsampling defaults to 1 (4:2:0, colocated)
		expect(generateVp9CodecConfigurationFromCodecString('vp09.00.31.08'))
			.toEqual([1, 1, 0, 2, 1, 31, 3, 1, 8, 4, 1, 1]);
	});

	test('AV1 av1C', () => {
		// marker + version, seq_profile + seq_level_idx_0, then tier, bit depth, monochrome, chroma subsampling and
		// chroma sample position bits
		expect(generateAv1CodecConfigurationFromCodecString('av01.0.04M.08')).toEqual([0x81, 0x04, 0x0c, 0x00]);
		expect(generateAv1CodecConfigurationFromCodecString('av01.2.08H.12.0.112.09.16.09.0'))
			.toEqual([0x81, 0x48, 0xee, 0x00]);
		expect(generateAv1CodecConfigurationFromCodecString('av01.0.31M.10.1.110.01.01.01.0'))
			.toEqual([0x81, 0x1f, 0x5c, 0x00]);
	});
});
