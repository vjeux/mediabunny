import { describe, expect, test } from 'vitest';
import {
	addAvcBitstreamRestriction,
	extractAv1CodecInfoFromPacket,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	extractVp9CodecInfoFromPacket,
	getEac3ChannelCount,
	getEac3SampleRate,
	parseAc3SyncFrame,
	parseAvcSps,
	parseEac3SyncFrame,
	parseHevcSps,
	serializeAvcDecoderConfigurationRecord,
} from '../../src/codec-data.js';
import {
	extractAudioCodecString,
	extractColorSpace,
	extractVideoCodecString,
} from '../../src/codec.js';
import { parseAacAudioSpecificConfig } from '../../shared/aac-misc.js';
import {
	annexB,
	AV1_TEMPORAL_DELIMITER,
	AVC_PPS,
	AvcSpsParams,
	createHevcPps,
	createRng,
	expectedAvcSpsFields,
	expectedHevcCodecStringSuffix,
	expectedHevcSpsFields,
	HevcSpsParams,
	randomAc3SyncFrame,
	randomAudioSpecificConfig,
	randomAv1SequenceHeader,
	randomAvcSps,
	randomEac3SyncFrame,
	randomHevcSps,
	randomVp9KeyFrame,
	Vp9KeyFrameParams,
} from './helpers/l31-bitstream-gen.js';

// Differential tests of the codec bitstream parsers: random headers following the syntax of their spec are generated,
// and what Mediabunny derives from them is compared against the values they were written with, run through the
// arithmetic of the respective spec. The expectations don't come from Mediabunny's own tables. The generators were
// cross-checked against FFmpeg's CBS parsers (trace_headers) on thousands of headers each; the mismatches that remain
// on main are listed below, each fixed elsewhere.

type KnownDivergence<T> = { reason: string; applies: (params: T) => boolean };

/** Compares the listed fields and returns one line per mismatch. */
const diffFields = (label: string, actual: object, expected: Record<string, unknown>) => {
	const mismatches: string[] = [];
	for (const [key, value] of Object.entries(expected)) {
		let actualValue = (actual as Record<string, unknown>)[key];
		if (actualValue instanceof Uint8Array) {
			actualValue = [...actualValue];
		}

		if (JSON.stringify(actualValue) !== JSON.stringify(value)) {
			mismatches.push(`${label}: ${key} is ${JSON.stringify(actualValue)}, expected ${JSON.stringify(value)}`);
		}
	}

	return mismatches;
};

const toHex = (...bytes: number[]) => bytes.map(x => x.toString(16).padStart(2, '0')).join('');

const VIDEO_CODEC_STRING_INFO = {
	width: 0,
	height: 0,
	codecDescription: null,
	colorSpace: null,
	avcType: null,
	avcCodecInfo: null,
	hevcCodecInfo: null,
	vp9CodecInfo: null,
	av1CodecInfo: null,
	proresFormat: null,
};

describe('H.264 sequence parameter sets', () => {
	const KNOWN_DIVERGENCES: KnownDivergence<AvcSpsParams>[] = [
		{
			// bug-fix-mania: "Interlaced H.264 heights" (frame_mbs_only_flag 0 doubles the map unit height)
			reason: 'field-coded heights',
			applies: params => params.frameMbsOnly === 0,
		},
		{
			// bug-fix-mania: "profiles 134/135/138/139/144" (their SPS has chroma_format_idc and the bit depths)
			reason: 'MFC/MVCD profiles and the old High 4:4:4 profile',
			applies: params => [134, 135, 138, 139, 144].includes(params.profileIdc),
		},
	];

	const cases = (count: number, seed: number) => {
		const rng = createRng(seed);
		return Array.from({ length: count }, () => randomAvcSps(rng))
			.filter(({ params }) => !KNOWN_DIVERGENCES.some(x => x.applies(params)));
	};

	test('Every derived field of 600 random SPS', () => {
		const mismatches: string[] = [];
		const checked = cases(600, 1);
		for (const [i, { nalUnit, params }] of checked.entries()) {
			const sps = parseAvcSps(nalUnit);
			if (!sps) {
				mismatches.push(`#${i}: not parsed`);
				continue;
			}

			const label = `#${i} (profile_idc ${params.profileIdc})`;
			mismatches.push(...diffFields(label, sps, expectedAvcSpsFields(params)));
		}

		expect(checked.length).toBeGreaterThan(300);
		expect(mismatches).toEqual([]);
	});

	test('addAvcBitstreamRestriction only adds bitstream_restriction_flag and the reorder values', () => {
		let patched = 0;
		for (const [i, { nalUnit, params }] of cases(400, 3).entries()) {
			const sps = parseAvcSps(nalUnit)!;
			if (sps.bitstreamRestrictionFlag === 1) {
				continue;
			}

			const reparsed = parseAvcSps(addAvcBitstreamRestriction(sps));
			const expected = {
				...expectedAvcSpsFields(params),
				bitstreamRestrictionFlag: 1,
				numReorderFrames: sps.numReorderFrames,
				maxDecFrameBuffering: sps.maxDecFrameBuffering,
			};
			expect(diffFields(`#${i}`, reparsed!, expected)).toEqual([]);
			patched++;
		}

		expect(patched).toBeGreaterThan(100);
	});

	test('avcC built from an Annex B access unit', () => {
		const mismatches: string[] = [];
		for (const [i, { nalUnit, params }] of cases(300, 12).entries()) {
			const record = extractAvcDecoderConfigurationRecord(annexB([nalUnit, AVC_PPS]))!;
			const avcC = serializeAvcDecoderConfigurationRecord(record);

			// ISO/IEC 14496-15 5.3.3.1, with 4-byte NAL unit lengths. Every profile but Baseline, Main and Extended
			// carries the chroma format and bit depths at the end.
			const sizes = (unit: Uint8Array) => [unit.byteLength >> 8, unit.byteLength & 0xff, ...unit];
			const expected = [
				1, params.profileIdc, params.constraintByte, params.levelIdc, 0xff,
				0xe1, ...sizes(nalUnit),
				1, ...sizes(AVC_PPS),
			];
			if (![66, 77, 88].includes(params.profileIdc)) {
				if (![100, 110, 122, 144].includes(params.profileIdc)) {
					continue; // bug-fix-mania: "avcC ext for all profiles except 66/77/88"
				}

				expected.push(
					0xfc | params.chromaFormatIdc,
					0xf8 | params.bitDepthLumaMinus8,
					0xf8 | params.bitDepthChromaMinus8,
					0,
				);
			}

			if (toHex(...avcC) !== toHex(...expected)) {
				mismatches.push(`#${i} (profile_idc ${params.profileIdc}): ${toHex(...avcC)}`);
			}
		}

		expect(mismatches).toEqual([]);
	});

	test('avc1 codec string of an Annex B access unit', () => {
		for (const { nalUnit, params } of cases(200, 4)) {
			const record = extractAvcDecoderConfigurationRecord(annexB([nalUnit, AVC_PPS]));
			const codecString = extractVideoCodecString({
				...VIDEO_CODEC_STRING_INFO,
				codec: 'avc',
				avcType: 1,
				avcCodecInfo: record,
			});

			// RFC 6381 3.3: profile_idc, the constraint flags byte and level_idc of the SPS
			expect(codecString).toBe(`avc1.${toHex(params.profileIdc, params.constraintByte, params.levelIdc)}`);
		}
	});
});

describe('H.265 sequence parameter sets', () => {
	const KNOWN_DIVERGENCES: KnownDivergence<HevcSpsParams>[] = [
		{
			// bug-fix-mania: "HEVC inter-RPS" (the predicted set's entry count)
			reason: 'inter-predicted short-term reference picture sets',
			applies: params => params.interPredictedRps > 0,
		},
		{
			// bug-fix-mania: "lt_ref_pic_poc_lsb_sps" (read with the wrong width)
			reason: 'long-term reference pictures in the SPS',
			applies: params => params.longTermRefPics > 0,
		},
	];

	const cases = (count: number, seed: number) => {
		const rng = createRng(seed);
		return Array.from({ length: count }, () => randomHevcSps(rng))
			.filter(({ params }) => !KNOWN_DIVERGENCES.some(x => x.applies(params)));
	};

	test('Every derived field of 1000 random SPS', () => {
		const mismatches: string[] = [];
		const checked = cases(1000, 5);
		for (const [i, { nalUnit, params }] of checked.entries()) {
			const sps = parseHevcSps(nalUnit);
			if (!sps) {
				mismatches.push(`#${i}: not parsed`);
				continue;
			}

			mismatches.push(...diffFields(`#${i}`, sps, {
				...expectedHevcSpsFields(params),
				generalConstraintIndicatorFlags: params.constraintBytes,
				// sps_max_num_reorder_pics of the highest sub-layer, plus one (capped at 16)
				maxDecFrameBuffering: Math.min(params.maxNumReorderPics.at(-1)! + 1, 16),
			}));
		}

		expect(checked.length).toBeGreaterThan(200);
		expect(mismatches).toEqual([]);
	});

	test('hev1 codec string of an Annex B access unit', () => {
		const pps = createHevcPps();
		for (const { nalUnit, params } of cases(200, 6)) {
			const record = extractHevcDecoderConfigurationRecord(annexB([nalUnit, pps]));
			const codecString = extractVideoCodecString({
				...VIDEO_CODEC_STRING_INFO,
				codec: 'hevc',
				hevcCodecInfo: record,
			});

			// ISO/IEC 14496-15 E.3 (the hev1 vs hvc1 prefix is up to the container)
			expect(codecString.slice(5)).toBe(expectedHevcCodecStringSuffix(params));
		}
	});
});

describe('AV1 sequence headers', () => {
	test('Every derived field and the av01 codec string of 500 random sequence headers', () => {
		const rng = createRng(7);
		const mismatches: string[] = [];
		for (let i = 0; i < 500; i++) {
			const { obu, params } = randomAv1SequenceHeader(rng);
			const info = extractAv1CodecInfoFromPacket(new Uint8Array([...AV1_TEMPORAL_DELIMITER, ...obu]));
			if (!info) {
				mismatches.push(`#${i}: not parsed`);
				continue;
			}

			const [primaries, transfer, matrix] = params.colour ?? [2, 2, 2]; // Unspecified when absent (6.4.2)
			mismatches.push(...diffFields(`#${i}`, info, {
				profile: params.profile,
				level: params.levelIdx,
				tier: params.tier,
				bitDepth: params.bitDepth,
				monochrome: params.monochrome,
				chromaSubsamplingX: params.subsamplingX,
				chromaSubsamplingY: params.subsamplingY,
				chromaSamplePosition: params.chromaSamplePosition,
				videoFullRangeFlag: params.colorRange,
				colourPrimaries: primaries,
				transferCharacteristics: transfer,
				matrixCoefficients: matrix,
			}));

			// AV1-ISOBMFF 5: the colour fields default to BT.709 without a color description, and the all-default
			// trailing part is omitted
			const pad = (value: number) => value.toString().padStart(2, '0');
			const [cp, tc, mc] = params.colour ?? [1, 1, 1];
			const tier = params.tier ? 'H' : 'M';
			let expected = `av01.${params.profile}.${pad(params.levelIdx)}${tier}.${pad(params.bitDepth)}`;
			const chroma = `${params.subsamplingX}${params.subsamplingY}${params.chromaSamplePosition}`;
			const optional = `.${params.monochrome}.${chroma}.${pad(cp)}.${pad(tc)}.${pad(mc)}.${params.colorRange}`;
			if (optional !== '.0.110.01.01.01.0') {
				expected += optional;
			}

			// The demuxers pass the color space they derived from the sequence header when there's no colr box
			const colorSpace = extractColorSpace({
				...VIDEO_CODEC_STRING_INFO,
				codec: 'av1',
				av1CodecInfo: info,
				proresCodecInfo: null,
			});
			const codecString = extractVideoCodecString({
				...VIDEO_CODEC_STRING_INFO,
				codec: 'av1',
				av1CodecInfo: info,
				colorSpace,
			});
			if (codecString !== expected) {
				mismatches.push(`#${i}: codec string ${codecString}, expected ${expected}`);
			}
		}

		expect(mismatches).toEqual([]);
	});
});

describe('VP9 key frame headers', () => {
	// The limits of every level: the maximum luma picture size from the VP9 bitstream spec's Annex A, and the maximum
	// width and height of the luma picture from the WebM project's VP9 levels page, as libvpx's level definitions carry
	// them (max_luma_picture_breadth in vp9_level_defs, vp9/encoder/vp9_encoder.c, checked by vp9_get_level)
	const LEVEL_LIMITS: [level: number, maxLumaPictureSize: number, maxLumaPictureBreadth: number][] = [
		[10, 36864, 512], [11, 73728, 768], [20, 122880, 960], [21, 245760, 1344], [30, 552960, 2048],
		[31, 983040, 2752], [40, 2228224, 4160], [41, 2228224, 4160], [50, 8912896, 8384], [51, 8912896, 8384],
		[52, 8912896, 8384], [60, 35651584, 16832], [61, 35651584, 16832], [62, 35651584, 16832],
	];

	// A key frame header has neither the frame rate nor the bitrate, so the level can only follow from the frame
	// dimensions: the lowest level that holds them. No level holds a larger picture; Mediabunny reports the highest one
	// then (libvpx's vp9_get_level returns LEVEL_UNKNOWN, FFmpeg's vpcc.c writes 0).
	const expectedLevel = (width: number, height: number) => {
		return LEVEL_LIMITS.find(([, maxSize, maxBreadth]) => {
			return width * height <= maxSize && Math.max(width, height) <= maxBreadth;
		})?.[0] ?? 62;
	};

	const KNOWN_DIVERGENCES: KnownDivergence<Vp9KeyFrameParams>[] = [
		{
			// bug-fix-mania: "VP9 RGB reserved bit" (profiles 1 and 3 have reserved_zero after CS_RGB too)
			reason: 'RGB in profiles 1 and 3',
			applies: params => params.colorSpace === 7,
		},
		{
			// #487: on main, the level only follows from the picture size, without the maximum width and height
			reason: 'frames wider or taller than the level of their picture size allows',
			applies: ({ width, height }) => {
				const levelFromSize = LEVEL_LIMITS.find(([, maxSize]) => width * height <= maxSize)?.[0] ?? 62;
				return levelFromSize !== expectedLevel(width, height);
			},
		},
	];

	// color_space (7.2.2) names a standard, and these are its ISO/IEC 23001-8 code points (primaries, transfer and
	// matrix). Unspecified (2) is always allowed for the primaries and transfer: BT.601 doesn't pin one set of
	// primaries (625 or 525 lines), and a BT.2020 stream may well carry PQ or HLG, which only the container says.
	const COLOR_SPACES: { primaries: number[]; transfer: number[]; matrix: number }[] = [
		{ primaries: [2], transfer: [2], matrix: 2 }, // CS_UNKNOWN
		{ primaries: [2, 5, 6], transfer: [2, 1, 6], matrix: 5 }, // CS_BT_601 (5 and 6 are the same matrix)
		{ primaries: [2, 1], transfer: [2, 1], matrix: 1 }, // CS_BT_709
		{ primaries: [2, 6], transfer: [2, 6, 1], matrix: 6 }, // CS_SMPTE_170
		{ primaries: [2, 7], transfer: [2, 7], matrix: 7 }, // CS_SMPTE_240
		{ primaries: [2, 9], transfer: [2, 14, 15], matrix: 9 }, // CS_BT_2020 (non-constant luminance, per the note)
		{ primaries: [2], transfer: [2], matrix: 2 }, // CS_RESERVED
		{ primaries: [2, 1], transfer: [2, 13], matrix: 0 }, // CS_RGB (sRGB)
	];

	test('Every derived field and the vp09 codec string of 1000 random key frames', () => {
		const rng = createRng(8);
		const mismatches: string[] = [];
		let checked = 0;
		for (let i = 0; i < 1000; i++) {
			const { data, params } = randomVp9KeyFrame(rng);
			if (KNOWN_DIVERGENCES.some(x => x.applies(params))) {
				continue;
			}

			checked++;
			const info = extractVp9CodecInfoFromPacket(data);
			if (!info) {
				mismatches.push(`#${i}: not parsed`);
				continue;
			}

			const level = expectedLevel(params.width, params.height);
			// VP codec ISOBMFF chromaSubsampling: 1 = 4:2:0 (co-located), 2 = 4:2:2, 3 = 4:4:4
			const chromaSubsampling = params.subsamplingX ? (params.subsamplingY ? 1 : 2) : 3;
			const colorSpace = COLOR_SPACES[params.colorSpace]!;
			mismatches.push(...diffFields(`#${i}`, info, {
				profile: params.profile,
				level,
				bitDepth: params.bitDepth,
				chromaSubsampling,
				videoFullRangeFlag: params.colorRange,
				matrixCoefficients: colorSpace.matrix,
			}));

			if (!colorSpace.primaries.includes(info.colourPrimaries)) {
				mismatches.push(`#${i}: primaries ${info.colourPrimaries} for color_space ${params.colorSpace}`);
			}

			if (!colorSpace.transfer.includes(info.transferCharacteristics)) {
				mismatches.push(`#${i}: transfer ${info.transferCharacteristics} for color_space ${params.colorSpace}`);
			}

			// VP codec ISOBMFF "Codecs Parameter String", without the all-default trailing fields (with the primaries
			// and transfer checked above)
			const pad = (value: number) => value.toString().padStart(2, '0');
			let expected = `vp09.${pad(params.profile)}.${pad(level)}.${pad(params.bitDepth)}`;
			const colour = [info.colourPrimaries, info.transferCharacteristics, colorSpace.matrix];
			const optional = `.${[chromaSubsampling, ...colour, params.colorRange].map(pad).join('.')}`;
			if (optional !== '.01.01.01.01.00') {
				expected += optional;
			}

			const codecString = extractVideoCodecString({
				...VIDEO_CODEC_STRING_INFO,
				codec: 'vp9',
				vp9CodecInfo: info,
			});
			if (codecString !== expected) {
				mismatches.push(`#${i}: codec string ${codecString}, expected ${expected}`);
			}
		}

		expect(checked).toBeGreaterThan(450);
		expect(mismatches).toEqual([]);
	});

	test('Level at the picture size limits of Annex A', () => {
		// The example frame sizes of Annex A fill each limit exactly; one more row needs the next larger limit
		const SIZES_AT_LIMITS: [width: number, height: number][] = [
			[256, 144], [384, 192], [480, 256], [640, 384], [1080, 512], [1280, 768], [2048, 1088], [4096, 2176],
			[8192, 4352],
		];

		const rng = createRng(13);
		let checked = 0;
		for (const [width, height] of SIZES_AT_LIMITS) {
			for (const rows of [height, height + 1]) {
				// Other random fields are drawn again until they're clear of the known divergences
				let frame = randomVp9KeyFrame(rng, { width, height: rows });
				for (let tries = 0; tries < 20 && KNOWN_DIVERGENCES.some(x => x.applies(frame.params)); tries++) {
					frame = randomVp9KeyFrame(rng, { width, height: rows });
				}

				if (KNOWN_DIVERGENCES.some(x => x.applies(frame.params))) {
					continue;
				}

				const level = extractVp9CodecInfoFromPacket(frame.data)?.level;
				const expected = expectedLevel(width, rows);
				expect({ width, height: rows, level }).toEqual({ width, height: rows, level: expected });
				checked++;
			}
		}

		expect(checked).toBe(2 * SIZES_AT_LIMITS.length);

		// Spot checks of the table lookup itself
		expect(expectedLevel(256, 144)).toBe(10);
		expect(expectedLevel(256, 145)).toBe(11);
		expect(expectedLevel(2048, 1089)).toBe(50);
		expect(expectedLevel(8192, 4352)).toBe(60);
		expect(expectedLevel(8192, 4353)).toBe(62);
		expect(expectedLevel(513, 1)).toBe(11); // Wider than level 1's 512
		expect(expectedLevel(4096, 16)).toBe(40);
		expect(expectedLevel(16, 2048)).toBe(30);
	});
});

describe('AAC AudioSpecificConfig', () => {
	const CHANNEL_COUNTS = [0, 1, 2, 3, 4, 5, 6, 8];

	test('Parsed fields and the mp4a codec string of 500 random configs', () => {
		const rng = createRng(9);
		const mismatches: string[] = [];
		for (let i = 0; i < 500; i++) {
			const { asc, params } = randomAudioSpecificConfig(rng);
			const label = `#${i} (${params.signaling}, object type ${params.objectType})`;
			let config: ReturnType<typeof parseAacAudioSpecificConfig>;
			try {
				config = parseAacAudioSpecificConfig(asc);
			} catch (error) {
				mismatches.push(`${label}: ${String(error)}`);
				continue;
			}

			// ISO/IEC 14496-3 1.6.5: PS turns the mono core into stereo
			const channels = CHANNEL_COUNTS[params.channelConfiguration]!;
			mismatches.push(...diffFields(label, config, {
				objectType: params.objectType,
				coreObjectType: params.coreObjectType,
				coreSampleRate: params.sampleRate,
				outputSampleRate: params.sbrSampleRate ?? params.sampleRate,
				outputNumberOfChannels: params.ps ? 2 : channels,
				// AAC-LD's 512/480-sample frames aren't modeled (they only feed the pre-roll duration)
				...(params.coreObjectType !== 23 && { frameLength: params.frameLength }),
			}));

			// RFC 6381 3.3: the audioObjectType that the config starts with
			const codecString = extractAudioCodecString({
				codec: 'aac',
				codecDescription: asc,
				aacCodecInfo: { isMpeg2: false, objectType: null },
				dtsFormat: null,
			});
			if (codecString !== `mp4a.40.${params.objectType}`) {
				mismatches.push(`${label}: codec string ${codecString}`);
			}
		}

		expect(mismatches).toEqual([]);
	});
});

describe('AC-3 and E-AC-3 syncframe headers', () => {
	// ETSI TS 102 366 Table 4.3: full-bandwidth channels per acmod
	const ACMOD_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];

	test('AC-3 bit stream information of 300 random syncframes', () => {
		const rng = createRng(10);
		for (let i = 0; i < 300; i++) {
			const { data, params } = randomAc3SyncFrame(rng);
			expect(parseAc3SyncFrame(data)).toEqual({
				fscod: params.fscod,
				bsid: params.bsid,
				bsmod: params.bsmod,
				acmod: params.acmod,
				lfeon: params.lfeon,
				bitRateCode: params.frmsizecod >> 1,
			});
		}
	});

	test('E-AC-3 bit stream information of 300 random syncframes', () => {
		const rng = createRng(11);
		for (let i = 0; i < 300; i++) {
			const { data, params } = randomEac3SyncFrame(rng);
			const info = parseEac3SyncFrame(data)!;
			expect(info.substreams).toHaveLength(1);
			expect(info.substreams[0]).toMatchObject({
				fscod: params.fscod,
				fscod2: params.fscod2,
				bsid: params.bsid,
				acmod: params.acmod,
				lfeon: params.lfeon,
			});

			// Table E.1.3 and E.1.4: fscod 3 selects the reduced rates through fscod2, with six blocks
			const sampleRate = params.fscod === 3
				? [24000, 22050, 16000][params.fscod2]!
				: [48000, 44100, 32000][params.fscod]!;
			expect(getEac3SampleRate(info)).toBe(sampleRate);
			expect(getEac3ChannelCount(info)).toBe(ACMOD_CHANNELS[params.acmod]! + params.lfeon);

			// F.6.2: kbit/s from the frame size, the sample rate and the blocks per syncframe
			const blocks = [1, 2, 3, 6][params.numblkscod]!;
			const dataRate = (params.frmsiz + 1) * 2 * 8 * sampleRate / (blocks * 256) / 1000;
			expect(Math.abs(info.dataRate - dataRate)).toBeLessThanOrEqual(0.5);
		}
	});
});
