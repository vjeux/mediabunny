import { describe, expect, test } from 'vitest';
import {
	AC3_ACMOD_CHANNEL_COUNTS,
	addAvcBitstreamRestriction,
	addEmulationPreventionBytes,
	concatNalUnitsInAnnexB,
	concatNalUnitsInLengthPrefixed,
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
	determineVideoPacketType,
	extractAv1CodecInfoFromPacket,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	extractVp9CodecInfoFromPacket,
	getEac3ChannelCount,
	getEac3SampleRate,
	iterateAv1PacketObus,
	iterateNalUnitsInAnnexB,
	iterateNalUnitsInLengthPrefixed,
	parseAc3SyncFrame,
	parseAvcSps,
	parseEac3SyncFrame,
	parseHevcSps,
	parseOpusIdentificationHeader,
	parseOpusTocByte,
	serializeAvcDecoderConfigurationRecord,
	serializeHevcDecoderConfigurationRecord,
} from '../../src/codec-data.js';
import { extractVideoCodecString } from '../../src/codec.js';
import { AC3_SAMPLE_RATES } from '../../shared/ac3-misc.js';
import { buildAacAudioSpecificConfig, parseAacAudioSpecificConfig } from '../../shared/aac-misc.js';
import { Bitstream } from '../../shared/bitstream.js';
import {
	AC3_FIXTURES,
	AV1_FIXTURES,
	AVC_SPS_FIXTURES,
	EAC3_FIXTURES,
	HEVC_SPS_FIXTURES,
	VP9_FIXTURES,
	hexToBytes,
} from './helpers/codecs-fixtures.js';

// The syntax follows H.264/H.265 as implemented by FFmpeg's h264_ps.c and hevc/ps.c (the oracles for the fixtures),
// the AV1 and VP9 bitstream specifications, ISO/IEC 14496-3 (AudioSpecificConfig), RFC 6716/7845 (Opus) and
// ETSI TS 102 366 (AC-3, E-AC-3).

const annexB = (...nalUnits: Uint8Array[]) => concatNalUnitsInAnnexB(nalUnits);

const toHex = (bytes: Uint8Array) => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');

/** Writes the given (bit count, value) fields MSB-first, padding with zero bits to whole bytes. */
const bits = (fields: [number, number][]) => {
	const totalBits = fields.reduce((a, [n]) => a + n, 0);
	const bytes = new Uint8Array(Math.ceil(totalBits / 8));
	const bitstream = new Bitstream(bytes);
	for (const [n, value] of fields) {
		bitstream.writeBits(n, value);
	}

	return bytes;
};

describe('H.264 parameter sets', () => {
	test('SPS fields match FFmpeg for x264 output', () => {
		for (const fixture of AVC_SPS_FIXTURES) {
			const sps = parseAvcSps(hexToBytes(fixture.sps));
			expect(sps, fixture.name).not.toBe(null);
			const { expected } = fixture;

			expect({
				profileIdc: sps!.profileIdc,
				levelIdc: sps!.levelIdc,
				constraintFlags: sps!.constraintFlags,
				chromaFormatIdc: sps!.chromaFormatIdc,
				bitDepthLumaMinus8: sps!.bitDepthLumaMinus8,
				bitDepthChromaMinus8: sps!.bitDepthChromaMinus8,
				displayWidth: sps!.displayWidth,
				displayHeight: sps!.displayHeight,
				pixelAspectRatio: sps!.pixelAspectRatio,
				colourPrimaries: sps!.colourPrimaries,
				transferCharacteristics: sps!.transferCharacteristics,
				matrixCoefficients: sps!.matrixCoefficients,
				fullRangeFlag: sps!.fullRangeFlag,
				numReorderFrames: sps!.numReorderFrames,
				maxDecFrameBuffering: sps!.maxDecFrameBuffering,
			}, fixture.name).toEqual(expected);

			// x264 always writes the bitstream restriction
			expect(sps!.bitstreamRestrictionFlag, fixture.name).toBe(1);
			expect(sps!.frameMbsOnlyFlag, fixture.name).toBe(1);
		}
	});

	test('avcC built from an Annex B access unit matches the one FFmpeg writes', () => {
		// ffmpeg -i out.h264 -c copy out.mp4, then the avcC box payload
		const ffmpegAvcc: Record<string, string> = {
			avc_baseline_320x240: '0142c00dffe100186742c00dd90141fb011000000300100000030320f142a480'
				+ '01000568cb83cb20',
			avc_main_640x360: '014d401effe10018674d401eeca05017fcb808800000030080000019078b16cb'
				+ '01000568ebe3cb20',
			avc_high_1920x1080: '01640028ffe1001b67640028acd940780227e5c044000003000400000300c83c60c658'
				+ '01000668ebe3cb22c0fdf8f800',
			avc_high10_1280x720: '016e001fffe1001a676e001fa6cd9405005bb011000003000100000300320f183196'
				+ '01000668ebe3cb22c0fdfafa00',
			avc_high422_720x486: '017a001effe1001a677a001ebcd940b43ff8bc0440000003004000000c83c58b6580'
				+ '01000668ebe3cb22c0fef8f800',
		};

		let checked = 0;
		for (const fixture of AVC_SPS_FIXTURES) {
			const expectedHex = ffmpegAvcc[fixture.name];
			if (!expectedHex) {
				continue;
			}
			checked++;

			// An access delimiter and an IDR slice around the parameter sets don't matter
			const accessUnit = annexB(
				new Uint8Array([0x09, 0xf0]),
				hexToBytes(fixture.sps),
				hexToBytes(fixture.pps),
				new Uint8Array([0x65, 0x88, 0x84, 0x00]),
			);
			const record = extractAvcDecoderConfigurationRecord(accessUnit)!;
			expect(record, fixture.name).not.toBe(null);
			expect(record.avcProfileIndication).toBe(fixture.expected.profileIdc);
			expect(record.profileCompatibility).toBe(fixture.expected.constraintFlags);
			expect(record.avcLevelIndication).toBe(fixture.expected.levelIdc);

			const serialized = serializeAvcDecoderConfigurationRecord(record);
			expect(toHex(serialized), fixture.name).toBe(expectedHex);

			const deserialized = deserializeAvcDecoderConfigurationRecord(serialized)!;
			expect(deserialized.sequenceParameterSets.map(toHex)).toEqual([fixture.sps]);
			expect(deserialized.pictureParameterSets.map(toHex)).toEqual([fixture.pps]);
			expect(deserialized.lengthSizeMinusOne).toBe(3);
			expect(deserialized.chromaFormat).toBe(record.chromaFormat);
			expect(deserialized.bitDepthLumaMinus8).toBe(record.bitDepthLumaMinus8);

			// The codec string is made of the profile, constraint and level bytes
			const codecString = extractVideoCodecString({
				width: fixture.expected.displayWidth,
				height: fixture.expected.displayHeight,
				codec: 'avc',
				codecDescription: serialized,
				colorSpace: null,
				avcType: 1,
				avcCodecInfo: null,
				hevcCodecInfo: null,
				vp9CodecInfo: null,
				av1CodecInfo: null,
				proresFormat: null,
			});
			expect(codecString).toBe('avc1.' + expectedHex.slice(2, 8));
		}
		expect(checked).toBe(Object.keys(ffmpegAvcc).length);

		// Parameter sets are required
		expect(extractAvcDecoderConfigurationRecord(annexB(new Uint8Array([0x65, 0x88])))).toBe(null);
		const sps = hexToBytes(AVC_SPS_FIXTURES[0]!.sps);
		expect(extractAvcDecoderConfigurationRecord(annexB(sps, new Uint8Array([0x65, 0x88])))).toBe(null);
	});

	test('Adding the bitstream restriction to an SPS', () => {
		// The rewritten SPS were checked with FFmpeg's trace_headers bitstream filter (and decode fine). Both come from
		// the BA1_Sony_D conformance stream: as is (no VUI), and with a VUI without bitstream restriction, added by
		// FFmpeg's h264_metadata bitstream filter (video_full_range_flag, colour_primaries, transfer_characteristics
		// and matrix_coefficients set to 1).
		const cases = [
			{
				sps: '2742e00c8d8d416272',
				bitstreamRestrictionFlag: null,
				rewritten: '2742e00c8d8d41627403682211088460',
				fullRangeFlag: 0,
				colourPrimaries: 2,
			},
			{
				sps: '2742e00c8d8d416274dc04040408',
				bitstreamRestrictionFlag: 0,
				rewritten: '2742e00c8d8d416274dc0404041b4110884423',
				fullRangeFlag: 1,
				colourPrimaries: 1,
			},
		];

		for (const { sps, bitstreamRestrictionFlag, rewritten, fullRangeFlag, colourPrimaries } of cases) {
			const before = parseAvcSps(hexToBytes(sps))!;
			expect(before.bitstreamRestrictionFlag).toBe(bitstreamRestrictionFlag);
			// Inferred when absent: MaxDpbFrames for level 1.2 at 11x9 macroblocks, capped at 16
			expect(before.numReorderFrames).toBe(16);
			expect(before.maxDecFrameBuffering).toBe(16);

			const result = addAvcBitstreamRestriction(before);
			expect(toHex(result)).toBe(rewritten);

			const after = parseAvcSps(result)!;
			expect(after.bitstreamRestrictionFlag).toBe(1);
			expect(after.numReorderFrames).toBe(16);
			expect(after.maxDecFrameBuffering).toBe(16);
			expect(after.displayWidth).toBe(176);
			expect(after.displayHeight).toBe(144);
			expect(after.fullRangeFlag).toBe(fullRangeFlag);
			expect(after.colourPrimaries).toBe(colourPrimaries);
		}
	});

	test('Emulation prevention', () => {
		// 0x03 goes in after two zero bytes followed by a byte up to 0x03
		const cases: [number[], number[]][] = [
			[[0, 0, 0], [0, 0, 3, 0]],
			[[0, 0, 1], [0, 0, 3, 1]],
			[[0, 0, 2, 0, 0, 3], [0, 0, 3, 2, 0, 0, 3, 3]],
			[[0, 0, 4], [0, 0, 4]],
			[[0, 0, 0, 0, 0], [0, 0, 3, 0, 0, 3, 0]],
			[[1, 0, 0, 0x80], [1, 0, 0, 0x80]],
		];

		for (const [input, output] of cases) {
			expect([...addEmulationPreventionBytes(new Uint8Array(input))]).toEqual(output);
		}

		// The parser removes them again: an SPS whose VUI timing info contains 00 00 03
		const fixture = AVC_SPS_FIXTURES.find(x => x.sps.includes('000003'))!;
		expect(parseAvcSps(hexToBytes(fixture.sps))!.displayWidth).toBe(fixture.expected.displayWidth);
	});
});

describe('H.265 parameter sets', () => {
	test('SPS fields match FFmpeg for x265 output', () => {
		for (const fixture of HEVC_SPS_FIXTURES) {
			const sps = parseHevcSps(hexToBytes(fixture.sps));
			expect(sps, fixture.name).not.toBe(null);
			const { expected } = fixture;

			let compatibilityFlags = 0;
			for (const j of expected.compatibleProfiles) {
				compatibilityFlags |= 1 << (31 - j);
			}

			expect({
				generalProfileIdc: sps!.generalProfileIdc,
				generalTierFlag: sps!.generalTierFlag,
				generalLevelIdc: sps!.generalLevelIdc,
				generalProfileCompatibilityFlags: sps!.generalProfileCompatibilityFlags,
				chromaFormatIdc: sps!.chromaFormatIdc,
				bitDepthLumaMinus8: sps!.bitDepthLumaMinus8,
				bitDepthChromaMinus8: sps!.bitDepthChromaMinus8,
				spsMaxSubLayersMinus1: sps!.spsMaxSubLayersMinus1,
				spsTemporalIdNestingFlag: sps!.spsTemporalIdNestingFlag,
				displayWidth: sps!.displayWidth,
				displayHeight: sps!.displayHeight,
				pixelAspectRatio: sps!.pixelAspectRatio,
				colourPrimaries: sps!.colourPrimaries,
				transferCharacteristics: sps!.transferCharacteristics,
				matrixCoefficients: sps!.matrixCoefficients,
				fullRangeFlag: sps!.fullRangeFlag,
			}, fixture.name).toEqual({
				generalProfileIdc: expected.generalProfileIdc,
				generalTierFlag: expected.generalTierFlag,
				generalLevelIdc: expected.generalLevelIdc,
				generalProfileCompatibilityFlags: compatibilityFlags >>> 0,
				chromaFormatIdc: expected.chromaFormatIdc,
				bitDepthLumaMinus8: expected.bitDepthLumaMinus8,
				bitDepthChromaMinus8: expected.bitDepthChromaMinus8,
				spsMaxSubLayersMinus1: expected.spsMaxSubLayersMinus1,
				spsTemporalIdNestingFlag: expected.spsTemporalIdNestingFlag,
				displayWidth: expected.displayWidth,
				displayHeight: expected.displayHeight,
				pixelAspectRatio: expected.pixelAspectRatio,
				colourPrimaries: expected.colourPrimaries,
				transferCharacteristics: expected.transferCharacteristics,
				matrixCoefficients: expected.matrixCoefficients,
				fullRangeFlag: expected.fullRangeFlag,
			});
		}
	});

	test('hvcC built from an Annex B access unit', () => {
		for (const fixture of HEVC_SPS_FIXTURES) {
			const vps = hexToBytes(fixture.vps);
			const sps = hexToBytes(fixture.sps);
			const pps = hexToBytes(fixture.pps);
			const idrSlice = new Uint8Array([0x26, 0x01, 0xaf, 0x00]);

			const record = extractHevcDecoderConfigurationRecord(annexB(vps, sps, pps, idrSlice))!;
			expect(record, fixture.name).not.toBe(null);
			const spsInfo = parseHevcSps(sps)!;

			expect(record.generalProfileSpace).toBe(0);
			expect(record.generalProfileIdc).toBe(fixture.expected.generalProfileIdc);
			expect(record.generalTierFlag).toBe(fixture.expected.generalTierFlag);
			expect(record.generalLevelIdc).toBe(fixture.expected.generalLevelIdc);
			expect(record.generalProfileCompatibilityFlags).toBe(spsInfo.generalProfileCompatibilityFlags);
			expect([...record.generalConstraintIndicatorFlags]).toEqual([...spsInfo.generalConstraintIndicatorFlags]);
			expect(record.chromaFormatIdc).toBe(fixture.expected.chromaFormatIdc);
			expect(record.bitDepthLumaMinus8).toBe(fixture.expected.bitDepthLumaMinus8);
			expect(record.bitDepthChromaMinus8).toBe(fixture.expected.bitDepthChromaMinus8);
			expect(record.numTemporalLayers).toBe(fixture.expected.spsMaxSubLayersMinus1 + 1);
			expect(record.temporalIdNested).toBe(fixture.expected.spsTemporalIdNestingFlag);
			expect(record.lengthSizeMinusOne).toBe(3);

			// One array per parameter set type (VPS 32, SPS 33, PPS 34), holding the NAL units as they were
			const arrays = record.arrays.filter(x => x.nalUnitType >= 32 && x.nalUnitType <= 34);
			expect(arrays.map(x => x.nalUnitType)).toEqual([32, 33, 34]);
			expect(arrays.map(x => x.nalUnits.map(toHex))).toEqual([[fixture.vps], [fixture.sps], [fixture.pps]]);

			const serialized = serializeHevcDecoderConfigurationRecord(record);
			const roundTripped = deserializeHevcDecoderConfigurationRecord(serialized);
			expect(roundTripped).toEqual(record);

			// x265 marks its output as progressive, frame-only content (general_progressive_source_flag and
			// general_frame_only_constraint_flag), which leads the constraint bytes in the codec string
			const codecString = extractVideoCodecString({
				width: fixture.expected.displayWidth,
				height: fixture.expected.displayHeight,
				codec: 'hevc',
				codecDescription: null,
				colorSpace: null,
				avcType: null,
				avcCodecInfo: null,
				hevcCodecInfo: record,
				vp9CodecInfo: null,
				av1CodecInfo: null,
				proresFormat: null,
			});
			const compatibility = fixture.expected.compatibleProfiles.reduce((a, j) => a | (1 << j), 0);
			const tier = fixture.expected.generalTierFlag ? 'H' : 'L';
			expect(codecString, fixture.name).toMatch(new RegExp(
				`^hev1\\.${fixture.expected.generalProfileIdc}\\.${compatibility.toString(16).toUpperCase()}\\.`
				+ `${tier}${fixture.expected.generalLevelIdc}\\.9`,
			));
		}

		// All three parameter sets are needed
		const fixture = HEVC_SPS_FIXTURES[0]!;
		expect(extractHevcDecoderConfigurationRecord(annexB(
			hexToBytes(fixture.vps),
			hexToBytes(fixture.sps),
		))).toBe(null);
	});
});

describe('VP9, VP8 and AV1 headers', () => {
	test('VP9 uncompressed headers written by libvpx', () => {
		for (const fixture of VP9_FIXTURES) {
			const keyFrameStart = hexToBytes(fixture.keyFrameStart);
			const { colourPrimaries, transferCharacteristics, ...info } = extractVp9CodecInfoFromPacket(keyFrameStart)!;
			const {
				colourPrimaries: expectedPrimaries,
				transferCharacteristics: expectedTransfer,
				...expectedInfo
			} = fixture.expected;
			expect(info, fixture.name).toEqual(expectedInfo);

			// The color space determines the primaries and transfer only for some values (not for CS_BT_601)
			const accepted = [[expectedPrimaries, expectedTransfer]];
			if (fixture.alsoAcceptedPrimariesAndTransfer) {
				accepted.push(fixture.alsoAcceptedPrimariesAndTransfer);
			}
			expect(accepted, fixture.name).toContainEqual([colourPrimaries, transferCharacteristics]);

			expect(determineVideoPacketType('vp9', { codec: 'vp09.00.10.08' }, keyFrameStart)).toBe('key');
		}

		// An inter frame (frame_type = 1) has no color config, and a frame that only shows an existing one has no
		// frame type at all
		const interFrame = new Uint8Array([0x86, 0x00, 0x40, 0x92]);
		expect(extractVp9CodecInfoFromPacket(interFrame)).toBe(null);
		expect(determineVideoPacketType('vp9', { codec: 'vp09.00.10.08' }, interFrame)).toBe('delta');
		const showExistingFrame = new Uint8Array([0x88]);
		expect(determineVideoPacketType('vp9', { codec: 'vp09.00.10.08' }, showExistingFrame)).toBe(null);
		// Profile 3 has a reserved bit before show_existing_frame
		expect(determineVideoPacketType('vp9', { codec: 'vp09.03.10.12' }, new Uint8Array([0xb2]))).toBe('delta');
		expect(determineVideoPacketType('vp9', { codec: 'vp09.03.10.12' }, new Uint8Array([0xb1]))).toBe('key');
	});

	test('VP8 frame tags', () => {
		// libvpx key frame: frame tag, start code 9d 01 2a, then 176x144
		const keyFrame = hexToBytes('904d009d012ab0009000000708858588');
		expect(determineVideoPacketType('vp8', { codec: 'vp8' }, keyFrame)).toBe('key');
		expect(determineVideoPacketType('vp8', { codec: 'vp8' }, new Uint8Array([0x31, 0x04, 0x00]))).toBe('delta');
	});

	test('AV1 sequence headers written by libaom', () => {
		for (const fixture of AV1_FIXTURES) {
			const obu = hexToBytes(fixture.sequenceHeaderObu);
			expect(extractAv1CodecInfoFromPacket(obu), fixture.name).toEqual(fixture.expected);
		}

		const main8Bit = AV1_FIXTURES[0]!.expected;
		// The same encoder with timing info (-aom-params timing-info=constant), a decoder model
		// (-aom-params timing-info=model), as a still picture with reduced header (-still-picture 1) and at 1920x1080
		const variants: [string, string, object][] = [
			['timing info', '0a14040000000400000067400000bbbd7c79b5f20080', main8Bit],
			['decoder model', '0a1e040000000400000065780000000a530000035f915f90bbbd7c79b5f20080', main8Bit],
			['reduced still picture header', '0a07181debe3da0080', main8Bit],
			['level 4.0', '0a0b00000042abbfc3732be401', { ...main8Bit, level: 8 }],
		];
		for (const [name, hex, expected] of variants) {
			expect(extractAv1CodecInfoFromPacket(hexToBytes(hex)), name).toEqual(expected);
		}
	});

	test('AV1 OBU framing', () => {
		const sequenceHeader = hexToBytes(AV1_FIXTURES[1]!.sequenceHeaderObu);
		const temporalDelimiter = new Uint8Array([0x12, 0x00]);
		const keyFrame = new Uint8Array([0x32, 0x01, 0x10]); // OBU_FRAME: show_existing_frame 0, frame_type KEY_FRAME
		const interFrame = new Uint8Array([0x32, 0x01, 0x30]); // frame_type INTER_FRAME
		const shownExistingFrame = new Uint8Array([0x32, 0x01, 0x80]);

		const temporalUnit = new Uint8Array([...temporalDelimiter, ...sequenceHeader, ...keyFrame]);
		expect([...iterateAv1PacketObus(temporalUnit)].map(x => [x.type, x.data.byteLength])).toEqual([
			[2, 0],
			[1, sequenceHeader.byteLength - 2],
			[6, 1],
		]);
		expect(extractAv1CodecInfoFromPacket(temporalUnit)).toEqual(AV1_FIXTURES[1]!.expected);
		expect(determineVideoPacketType('av1', { codec: 'av01.0.00M.10' }, temporalUnit)).toBe('key');
		expect(determineVideoPacketType('av1', { codec: 'av01.0.00M.10' }, interFrame)).toBe('delta');
		expect(determineVideoPacketType('av1', { codec: 'av01.0.00M.10' }, shownExistingFrame)).toBe(null);
		expect(extractAv1CodecInfoFromPacket(new Uint8Array([...temporalDelimiter, ...interFrame]))).toBe(null);

		// With an extension header (temporal and spatial ID) and, as the last OBU, without obu_size
		const withExtension = new Uint8Array([0x0e, 0x00, ...sequenceHeader.subarray(1)]);
		expect(extractAv1CodecInfoFromPacket(withExtension)).toEqual(AV1_FIXTURES[1]!.expected);
		const withoutSize = new Uint8Array([0x08, ...sequenceHeader.subarray(2)]);
		expect(extractAv1CodecInfoFromPacket(withoutSize)).toEqual(AV1_FIXTURES[1]!.expected);

		// A reduced still picture header makes every frame a key frame
		const still = hexToBytes('0a07181debe3da0080');
		const stillFrame = new Uint8Array([...still, 0x32, 0x01, 0x00]);
		expect(determineVideoPacketType('av1', { codec: 'av01.0.00M.08' }, stillFrame)).toBe('key');
	});
});

describe('H.264 and H.265 packet types', () => {
	const avcConfig = { codec: 'avc1.42c00d' };
	const hevcConfig = { codec: 'hev1.1.6.L93.B0' };

	test('AVC', () => {
		const sps = hexToBytes(AVC_SPS_FIXTURES[0]!.sps);
		const pps = hexToBytes(AVC_SPS_FIXTURES[0]!.pps);

		expect(determineVideoPacketType('avc', avcConfig, annexB(sps, pps, new Uint8Array([0x65, 0x88])))).toBe('key');
		expect(determineVideoPacketType('avc', avcConfig, annexB(new Uint8Array([0x41, 0x9a])))).toBe('delta');
		// Data partition A
		expect(determineVideoPacketType('avc', avcConfig, annexB(new Uint8Array([0x22, 0x9a])))).toBe('delta');
		// Only parameter sets
		expect(determineVideoPacketType('avc', avcConfig, annexB(sps, pps))).toBe('delta');

		// Length-prefixed, with the length size taken from the description
		const avcc = serializeAvcDecoderConfigurationRecord(
			extractAvcDecoderConfigurationRecord(annexB(sps, pps))!,
		);
		const lengthPrefixed = concatNalUnitsInLengthPrefixed([new Uint8Array([0x06, 0x05, 0x00, 0x80]),
			new Uint8Array([0x65, 0x88])], 4);
		expect(determineVideoPacketType('avc', { ...avcConfig, description: avcc }, lengthPrefixed)).toBe('key');
	});

	test('HEVC', () => {
		// The NAL unit type sits in bits 1 to 6 of the first header byte. IRAP pictures (BLA, IDR, CRA: types 16 to 23)
		// are key frames.
		const slice = (type: number) => new Uint8Array([type << 1, 0x01, 0xaf]);
		const vps = hexToBytes(HEVC_SPS_FIXTURES[0]!.vps);

		for (const type of [16, 17, 18, 19, 20, 21]) {
			expect(determineVideoPacketType('hevc', hevcConfig, annexB(vps, slice(type))), String(type)).toBe('key');
		}
		for (const type of [0, 1, 2, 8, 9]) {
			expect(determineVideoPacketType('hevc', hevcConfig, annexB(vps, slice(type))), String(type)).toBe('delta');
		}
	});
});

describe('NAL unit framing', () => {
	const locations = (data: number[]) => [...iterateNalUnitsInAnnexB(new Uint8Array(data))]
		.map(x => [x.offset, x.length]);

	test('Annex B', () => {
		// 4- and 3-byte start codes
		expect(locations([0, 0, 0, 1, 0x67, 0xaa, 0, 0, 1, 0x68, 0xbb])).toEqual([[4, 2], [9, 2]]);
		// Leading zero bytes before the first start code
		expect(locations([0, 0, 0, 0, 0, 1, 0x65, 0xcc])).toEqual([[6, 2]]);
		// Emulation prevention isn't a start code
		expect(locations([0, 0, 1, 0x65, 0, 0, 3, 1, 0xdd])).toEqual([[3, 6]]);
		// Empty NAL units are skipped
		expect(locations([0, 0, 1, 0, 0, 1, 0x41, 0xee])).toEqual([[6, 2]]);
		// No start code, no NAL units
		expect(locations([0x65, 0x88, 0x84, 0x00])).toEqual([]);
		expect(locations([])).toEqual([]);
	});

	test('Length-prefixed', () => {
		for (const lengthSize of [1, 2, 3, 4] as const) {
			const nalUnits = [new Uint8Array([0x67, 1, 2]), new Uint8Array([0x68, 3]), new Uint8Array([0x65])];
			const data = concatNalUnitsInLengthPrefixed(nalUnits, lengthSize);
			expect(data.byteLength).toBe(6 + 3 * lengthSize);

			const found = [...iterateNalUnitsInLengthPrefixed(data, lengthSize)]
				.map(x => [...data.subarray(x.offset, x.offset + x.length)]);
			expect(found).toEqual(nalUnits.map(x => [...x]));
		}

		// Converting back to Annex B gives four-byte start codes
		expect([...concatNalUnitsInAnnexB([new Uint8Array([0x65, 0x88]), new Uint8Array([0x06])])])
			.toEqual([0, 0, 0, 1, 0x65, 0x88, 0, 0, 0, 1, 0x06]);
	});
});

describe('Audio configuration', () => {
	test('AudioSpecificConfig', () => {
		// [description, AudioSpecificConfig fields, [objectType, core and output sample rate, output channel count,
		// frame length]]. Where FFmpeg's AAC decoder supports the configuration (it rejects explicit sampling
		// frequencies), it reports the same for an MP4 carrying it.
		const cases: [string, [number, number][], [number, number, number, number, number]][] = [
			['AAC-LC, 44.1 kHz, stereo', [[5, 2], [4, 4], [4, 2], [3, 0]], [2, 44100, 44100, 2, 1024]],
			['AAC-LC, 7.1', [[5, 2], [4, 3], [4, 7], [3, 0]], [2, 48000, 48000, 8, 1024]],
			['AAC-LC, 960-sample frames', [[5, 2], [4, 3], [4, 2], [1, 1], [2, 0]], [2, 48000, 48000, 2, 960]],
			['AAC-LC, explicit frequency', [[5, 2], [4, 15], [24, 37800], [4, 2], [3, 0]], [2, 37800, 37800, 2, 1024]],
			['AAC Main', [[5, 1], [4, 3], [4, 2], [3, 0]], [1, 48000, 48000, 2, 1024]],
			['AAC LTP', [[5, 4], [4, 3], [4, 2], [3, 0]], [4, 48000, 48000, 2, 1024]],
			['HE-AAC, hierarchical', [[5, 5], [4, 7], [4, 2], [4, 4], [5, 2], [3, 0]], [5, 22050, 44100, 2, 1024]],
			['HE-AAC v2, hierarchical', [[5, 29], [4, 7], [4, 1], [4, 4], [5, 2], [3, 0]], [29, 22050, 44100, 2, 1024]],
			[
				'HE-AAC, backward-compatible',
				[[5, 2], [4, 7], [4, 2], [3, 0], [11, 0x2b7], [5, 5], [1, 1], [4, 4]],
				[2, 22050, 44100, 2, 1024],
			],
			[
				'HE-AAC v2, backward-compatible',
				[[5, 2], [4, 7], [4, 1], [3, 0], [11, 0x2b7], [5, 5], [1, 1], [4, 4], [11, 0x548], [1, 1]],
				[2, 22050, 44100, 2, 1024],
			],
			['xHE-AAC, escaped object type', [[5, 31], [6, 10], [4, 3], [4, 2], [8, 0]], [42, 48000, 48000, 2, 1024]],
		];

		for (const [name, fields, expected] of cases) {
			const config = parseAacAudioSpecificConfig(bits(fields));
			expect([
				config.objectType,
				config.coreSampleRate,
				config.outputSampleRate,
				config.outputNumberOfChannels,
				config.frameLength,
			], name).toEqual(expected);
		}

		// FFmpeg's AAC-LC encoder output (48 kHz stereo) and a config built for the same parameters
		const ffmpegLc = new Uint8Array([0x11, 0x90]);
		expect(parseAacAudioSpecificConfig(ffmpegLc).outputSampleRate).toBe(48000);
		// Stereo needs no program config element. (A variable rather than a literal argument, so this also compiles
		// against versions of the builder without that field.)
		const lcConfig = {
			objectType: 2,
			outputSampleRate: 48000,
			outputNumberOfChannels: 2,
			programConfigElement: null,
		};
		expect([...buildAacAudioSpecificConfig(lcConfig)]).toEqual([...ffmpegLc]);
	});

	test('Opus identification header', () => {
		// RFC 7845, 5.1: 'OpusHead', version, channel count, pre-skip, input sample rate, output gain, mapping family
		const head = (channels: number, family: number, table: number[] = []) => new Uint8Array([
			...new TextEncoder().encode('OpusHead'),
			1, channels, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00, 0xfe, 0xff, family, ...table,
		]);

		expect(parseOpusIdentificationHeader(head(2, 0))).toEqual({
			outputChannelCount: 2,
			preSkip: 312,
			inputSampleRate: 48000,
			outputGain: -2,
			channelMappingFamily: 0,
			channelMappingTable: null,
		});

		// Family 1: stream count, coupled stream count, then one mapping byte per channel
		const surround = parseOpusIdentificationHeader(head(6, 1, [4, 2, 0, 4, 1, 2, 3, 5]));
		expect(surround.channelMappingFamily).toBe(1);
		expect([...surround.channelMappingTable!]).toEqual([4, 2, 0, 4, 1, 2, 3, 5]);

		expect(() => parseOpusIdentificationHeader(head(2, 0).subarray(0, 18))).toThrow();
	});

	test('Opus packet durations', () => {
		// RFC 6716, 3.1: config (5 bits), stereo flag, frame count code (2 bits)
		const toc = (config: number, code: number) => (config << 3) | code;
		const cases: [number[], number][] = [
			[[toc(0, 0)], 480], // SILK NB 10 ms
			[[toc(3, 0)], 2880], // SILK NB 60 ms
			[[toc(13, 0)], 960], // Hybrid SWB 20 ms
			[[toc(16, 0)], 120], // CELT NB 2.5 ms
			[[toc(31, 0)], 960], // CELT FB 20 ms
			[[toc(31, 1)], 1920], // Two frames
			[[toc(31, 2)], 1920], // Two frames of different sizes
			[[toc(31, 3), 0x83], 2880], // Code 3: frame count in the next byte (VBR flag set)
			[[toc(16, 3), 48], 48 * 120], // 48 frames of 2.5 ms, the 120 ms maximum
		];

		for (const [packet, duration] of cases) {
			expect(parseOpusTocByte(new Uint8Array(packet)).durationInSamples, packet.join(',')).toBe(duration);
		}
	});

	test('AC-3 and E-AC-3 syncframes written by FFmpeg', () => {
		// Table 4.13 of ETSI TS 102 366, nominal bit rate in kbps indexed by frmsizecod / 2
		const bitRates = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];

		for (const fixture of AC3_FIXTURES) {
			const frame = parseAc3SyncFrame(hexToBytes(fixture.frameStart))!;
			expect(frame, fixture.name).not.toBe(null);
			expect(frame.bsid).toBe(8);
			expect(AC3_SAMPLE_RATES[frame.fscod], fixture.name).toBe(fixture.expected.sampleRate);
			expect(AC3_ACMOD_CHANNEL_COUNTS[frame.acmod]! + frame.lfeon, fixture.name)
				.toBe(fixture.expected.numberOfChannels);
			expect(bitRates[frame.bitRateCode]! * 1000, fixture.name).toBe(fixture.expected.bitRate);

			// The E-AC-3 parser may reject AC-3 frames, or describe them the way dec3 does for the AC-3 core of Blu-ray
			// Dolby Digital Plus; either way it mustn't contradict the frame
			const asEac3 = parseEac3SyncFrame(hexToBytes(fixture.frameStart));
			if (asEac3) {
				expect(asEac3.substreams, fixture.name).toHaveLength(1);
				expect(getEac3SampleRate(asEac3), fixture.name).toBe(fixture.expected.sampleRate);
				expect(getEac3ChannelCount(asEac3), fixture.name).toBe(fixture.expected.numberOfChannels);
				expect(asEac3.dataRate * 1000, fixture.name).toBe(fixture.expected.bitRate);
			}
		}

		for (const fixture of EAC3_FIXTURES) {
			const frame = parseEac3SyncFrame(hexToBytes(fixture.frameStart))!;
			expect(frame, fixture.name).not.toBe(null);
			expect(frame.substreams).toHaveLength(1);
			expect(frame.substreams[0]!.bsid).toBe(16);
			expect(getEac3SampleRate(frame), fixture.name).toBe(fixture.expected.sampleRate);
			expect(getEac3ChannelCount(frame), fixture.name).toBe(fixture.expected.numberOfChannels);
			expect(frame.dataRate * 1000, fixture.name).toBe(fixture.expected.bitRate);

			// Not AC-3
			expect(parseAc3SyncFrame(hexToBytes(fixture.frameStart)), fixture.name).toBe(null);
		}

		// No sync word
		expect(parseAc3SyncFrame(new Uint8Array([0x0b, 0x78, 0, 0, 0x14, 0x40, 0x43]))).toBe(null);
		// fscod = 3 is reserved
		expect(parseAc3SyncFrame(new Uint8Array([0x0b, 0x77, 0, 0, 0xd4, 0x40, 0x43]))).toBe(null);
	});
});
