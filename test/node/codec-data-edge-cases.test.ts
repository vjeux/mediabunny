import { describe, expect, test } from 'vitest';
import {
	addEmulationPreventionBytes,
	av1CodecInfoHasColorInfo,
	createVorbisComments,
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
	determineVideoPacketType,
	extractAv1CodecInfoFromPacket,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	extractVp9CodecInfoFromPacket,
	getEac3ChannelCount,
	getEac3SampleRate,
	iterateNalUnitsInAnnexB,
	parseAc3SyncFrame,
	parseAvcSps,
	parseEac3Config,
	parseEac3SyncFrame,
	parseHevcSps,
	parseOpusIdentificationHeader,
	parseOpusTocByte,
	readVorbisComments,
	serializeAvcDecoderConfigurationRecord,
	serializeHevcDecoderConfigurationRecord,
	vp9CodecInfoHasColorInfo,
} from '../../src/codec-data.js';
import { MetadataTags } from '../../src/metadata.js';
import {
	addEmulationPrevention,
	annexB,
	ascii,
	av1SequenceHeaderObu,
	Av1SequenceHeaderOptions,
	BitWriter,
	buildAvcSps,
	buildHevcPps,
	buildHevcSps,
	concatBytes,
	lengthPrefixed,
	u32le,
} from './helpers/mutation-bytes.js';

// MaxDpbMbs from H.264 Table A-1, keyed by level_idc
const MAX_DPB_MBS: Record<number, number> = {
	10: 396, 11: 900, 12: 2376, 13: 2376, 20: 2376, 21: 4752, 22: 8100, 30: 8100, 31: 18000, 32: 20480,
	40: 32768, 41: 32768, 42: 34816, 50: 110400, 51: 184320, 52: 184320, 60: 696320, 61: 696320, 62: 696320,
};
const maxDpbFrames = (levelIdc: number, widthInMbs: number, frameHeightInMbs: number) => {
	return Math.min(Math.floor(MAX_DPB_MBS[levelIdc]! / (widthInMbs * frameHeightInMbs)), 16);
};

describe('parseAvcSps', () => {
	test('reads the coded size and crops it with 4:2:0 crop units', () => {
		const info = parseAvcSps(buildAvcSps({
			profileIdc: 100,
			widthInMbs: 120,
			heightInMapUnits: 68,
			crop: [0, 0, 0, 4],
		}));
		expect(info).toMatchObject({
			profileIdc: 100,
			levelIdc: 40,
			chromaFormatIdc: 1,
			bitDepthLumaMinus8: 0,
			bitDepthChromaMinus8: 0,
			frameMbsOnlyFlag: 1,
			codedWidth: 1920,
			codedHeight: 1088,
			displayWidth: 1920,
			displayHeight: 1080,
		});

		// Left and right offsets count in chroma samples (2 luma samples each)
		const sides = parseAvcSps(buildAvcSps({
			profileIdc: 66,
			widthInMbs: 20,
			heightInMapUnits: 15,
			crop: [1, 3, 2, 1],
		}));
		expect(sides).toMatchObject({ codedWidth: 320, codedHeight: 240, displayWidth: 312, displayHeight: 234 });
	});

	test('uses 4:2:2 and 4:4:4 crop units and reads the high-profile bit depths', () => {
		const yuv422 = parseAvcSps(buildAvcSps({
			profileIdc: 122,
			chromaFormatIdc: 2,
			bitDepthLuma: 10,
			bitDepthChroma: 10,
			widthInMbs: 80,
			heightInMapUnits: 45,
			crop: [1, 1, 3, 5],
		}));
		expect(yuv422).toMatchObject({
			chromaFormatIdc: 2,
			bitDepthLumaMinus8: 2,
			bitDepthChromaMinus8: 2,
			displayWidth: 1280 - 4,
			displayHeight: 720 - 8,
		});

		const yuv444 = parseAvcSps(buildAvcSps({
			profileIdc: 244,
			chromaFormatIdc: 3,
			bitDepthLuma: 12,
			bitDepthChroma: 9,
			widthInMbs: 80,
			heightInMapUnits: 45,
			crop: [1, 2, 3, 4],
		}));
		expect(yuv444).toMatchObject({
			chromaFormatIdc: 3,
			bitDepthLumaMinus8: 4,
			bitDepthChromaMinus8: 1,
			displayWidth: 1280 - 3,
			displayHeight: 720 - 7,
		});
	});

	test('separate colour planes and monochrome crop in luma samples', () => {
		const separate = parseAvcSps(buildAvcSps({
			profileIdc: 244,
			chromaFormatIdc: 3,
			separateColourPlane: true,
			widthInMbs: 10,
			heightInMapUnits: 10,
			crop: [1, 2, 3, 4],
		}));
		expect(separate).toMatchObject({ displayWidth: 160 - 3, displayHeight: 160 - 7 });

		const monochrome = parseAvcSps(buildAvcSps({
			profileIdc: 100,
			chromaFormatIdc: 0,
			widthInMbs: 10,
			heightInMapUnits: 10,
			crop: [1, 2, 3, 4],
		}));
		expect(monochrome).toMatchObject({ chromaFormatIdc: 0, displayWidth: 160 - 3, displayHeight: 160 - 7 });
	});

	test.each([44, 83, 86, 110, 118, 128])('profile_idc %i carries the chroma format and bit depths', (profileIdc) => {
		const info = parseAvcSps(buildAvcSps({
			profileIdc,
			chromaFormatIdc: 2,
			bitDepthLuma: 10,
			bitDepthChroma: 10,
			widthInMbs: 40,
			heightInMapUnits: 30,
		}));
		expect(info).toMatchObject({
			profileIdc,
			chromaFormatIdc: 2,
			bitDepthLumaMinus8: 2,
			codedWidth: 640,
			codedHeight: 480,
		});
	});

	test('skips scaling lists (8 for 4:2:0, 12 for 4:4:4), including ones ended early by a zero scale', () => {
		const lists = [
			Array.from({ length: 16 }, () => 1), // a full 4x4 list
			[-8], // delta -8 from 8 makes nextScale 0 right away (use the default list)
			null,
			[4, -12], // reaches nextScale 0 after two entries
			null,
			null,
			Array.from({ length: 64 }, (_, i) => (i % 2 ? -3 : 3)), // a full 8x8 list
			null,
			[5, 5, -18],
			null,
			null,
			Array.from({ length: 64 }, () => 0),
		];
		const yuv420 = parseAvcSps(buildAvcSps({
			widthInMbs: 45,
			heightInMapUnits: 30,
			scalingLists: lists,
			crop: [0, 2, 0, 1],
		}));
		expect(yuv420).toMatchObject({ codedWidth: 720, codedHeight: 480, displayWidth: 716, displayHeight: 478 });

		const yuv444 = parseAvcSps(buildAvcSps({
			profileIdc: 244,
			chromaFormatIdc: 3,
			widthInMbs: 45,
			heightInMapUnits: 30,
			scalingLists: lists,
			crop: [0, 2, 0, 1],
		}));
		expect(yuv444).toMatchObject({ codedWidth: 720, codedHeight: 480, displayWidth: 718, displayHeight: 479 });
	});

	test('skips picture order count type 1 cycles and type 2', () => {
		const type1 = parseAvcSps(buildAvcSps({
			widthInMbs: 22,
			heightInMapUnits: 18,
			pocType: 1,
			pocCycle: [3, -7, 120],
		}));
		expect(type1).toMatchObject({ codedWidth: 352, codedHeight: 288 });
		const type2 = parseAvcSps(buildAvcSps({ widthInMbs: 22, heightInMapUnits: 18, pocType: 2 }));
		expect(type2).toMatchObject({ codedWidth: 352, codedHeight: 288 });
	});

	test('reads the VUI aspect ratio, colour description and bitstream restriction', () => {
		const info = parseAvcSps(buildAvcSps({
			profileIdc: 77,
			levelIdc: 31,
			widthInMbs: 45,
			heightInMapUnits: 36,
			vui: {
				sar: 4,
				overscan: true,
				videoSignal: { fullRange: true, colour: [9, 16, 9] },
				chromaLoc: true,
				timing: [1001, 60000, true],
				nalHrd: 2,
				vclHrd: 1,
				restriction: { numReorderFrames: 2, maxDecFrameBuffering: 3 },
			},
		}));
		expect(info).toMatchObject({
			pixelAspectRatio: { num: 16, den: 11 },
			fullRangeFlag: 1,
			colourPrimaries: 9,
			transferCharacteristics: 16,
			matrixCoefficients: 9,
			bitstreamRestrictionFlag: 1,
			numReorderFrames: 2,
			maxDecFrameBuffering: 3,
		});
	});

	test.each([
		[1, { num: 1, den: 1 }],
		[2, { num: 12, den: 11 }],
		[13, { num: 160, den: 99 }],
		[16, { num: 2, den: 1 }],
		[17, { num: 1, den: 1 }], // reserved: left at 1:1
		[[37, 26] as [number, number], { num: 37, den: 26 }], // Extended_SAR
	])('aspect_ratio_idc %j gives a pixel aspect ratio of %j', (sar, expected) => {
		const info = parseAvcSps(buildAvcSps({ widthInMbs: 45, heightInMapUnits: 36, vui: { sar } }));
		expect(info!.pixelAspectRatio).toEqual(expected);
	});

	test('without a colour description, colour fields are unspecified (2) and the range is limited', () => {
		const info = parseAvcSps(buildAvcSps({
			widthInMbs: 45,
			heightInMapUnits: 36,
			vui: { videoSignal: { fullRange: false } },
		}));
		expect(info).toMatchObject({
			colourPrimaries: 2,
			transferCharacteristics: 2,
			matrixCoefficients: 2,
			fullRangeFlag: 0,
		});
		const noVui = parseAvcSps(buildAvcSps({ widthInMbs: 45, heightInMapUnits: 36 }));
		expect(noVui).toMatchObject({
			colourPrimaries: 2,
			pixelAspectRatio: { num: 1, den: 1 },
			bitstreamRestrictionFlag: null,
			bitstreamRestrictionFlagBitOffset: null,
		});
	});

	test('caps num_reorder_frames and max_dec_frame_buffering at 16', () => {
		const info = parseAvcSps(buildAvcSps({
			widthInMbs: 45,
			heightInMapUnits: 36,
			vui: { restriction: { numReorderFrames: 40, maxDecFrameBuffering: 1000 } },
		}));
		expect(info).toMatchObject({ numReorderFrames: 16, maxDecFrameBuffering: 16 });
	});

	test.each([44, 86, 100, 110, 122, 244])(
		'infers no reordering for profile_idc %i with constraint_set3_flag and no bitstream restriction',
		(profileIdc) => {
			const info = parseAvcSps(buildAvcSps({
				profileIdc,
				constraintFlags: 0x10,
				widthInMbs: 120,
				heightInMapUnits: 68,
			}));
			expect(info).toMatchObject({ numReorderFrames: 0, maxDecFrameBuffering: 0 });
		},
	);

	test.each([
		// profile_idc, constraint flags, level_idc, width in MBs, height in MBs
		[100, 0x00, 40, 120, 68],
		[77, 0x10, 40, 120, 68], // constraint_set3_flag only matters for the listed profiles
		[118, 0x10, 31, 80, 45],
		[66, 0x00, 10, 11, 9],
		[100, 0x00, 51, 80, 45], // capped at 16
		[100, 0x00, 21, 22, 18],
		[100, 0x00, 42, 120, 68],
	])('infers MaxDpbFrames for profile %i, flags %i, level %i at %ix%i MBs', (profileIdc, flags, levelIdc, w, h) => {
		const info = parseAvcSps(buildAvcSps({
			profileIdc,
			constraintFlags: flags,
			levelIdc,
			widthInMbs: w,
			heightInMapUnits: h,
		}));
		const expected = maxDpbFrames(levelIdc, w, h);
		expect(info).toMatchObject({ numReorderFrames: expected, maxDecFrameBuffering: expected });
	});

	test('a level_idc above the table uses the largest level and level_idc 9 (level 1b) the level 1 limits', () => {
		const huge = parseAvcSps(buildAvcSps({ levelIdc: 70, widthInMbs: 240, heightInMapUnits: 135 }));
		expect(huge!.maxDecFrameBuffering).toBe(maxDpbFrames(62, 240, 135));
		const level1b = parseAvcSps(buildAvcSps({ levelIdc: 9, widthInMbs: 11, heightInMapUnits: 9 }));
		expect(level1b!.maxDecFrameBuffering).toBe(maxDpbFrames(10, 11, 9));
	});

	test('returns null for other NAL unit types and for pictures cropped down to nothing', () => {
		const sps = buildAvcSps({ widthInMbs: 45, heightInMapUnits: 36 });
		expect(parseAvcSps(concatBytes([0x68], sps.subarray(1)))).toBe(null);
		expect(parseAvcSps(buildAvcSps({ widthInMbs: 2, heightInMapUnits: 2, crop: [0, 0, 8, 8] }))).toBe(null);
		expect(parseAvcSps(buildAvcSps({ widthInMbs: 2, heightInMapUnits: 2, crop: [8, 8, 0, 0] }))).toBe(null);
		expect(parseAvcSps(buildAvcSps({ widthInMbs: 2, heightInMapUnits: 2, crop: [0, 0, 7, 8] }))).toMatchObject({
			displayHeight: 2,
		});
	});
});

const AVC_SPS = [0x67, 0x42, 0xc0, 0x1e, 0xda, 0x02, 0x80, 0xbf, 0xe5, 0x80];
const AVC_PPS = [0x68, 0xce, 0x3c, 0x80];
const AVC_NON_IDR_SLICE = [0x41, 0x9a, 0x21, 0x6c, 0x41, 0xff];
const AVC_IDR_SLICE = [0x65, 0x88, 0x84, 0x00, 0x33, 0xff];

/** recovery_point() SEI payload (H.264 D.1.8), byte-aligned with bit_equal_to_one + zero bits. */
const recoveryPointPayload = (recoveryFrameCount: number, exactMatch: boolean) => {
	const writer = new BitWriter()
		.writeUe(recoveryFrameCount)
		.writeFlag(exactMatch)
		.writeFlag(false) // broken_link_flag
		.writeBits(2, 0); // changing_slice_group_idc
	if (writer.bitLength % 8 !== 0) {
		writer.writeTrailingBits();
	}
	return writer.toBytes();
};

/** ff_byte-coded value as used for SEI payloadType and payloadSize. */
const seiVarint = (value: number) => {
	const out: number[] = [];
	while (value >= 255) {
		out.push(0xff);
		value -= 255;
	}
	out.push(value);
	return out;
};

const seiMessage = (payloadType: number, payload: Uint8Array | number[]) => {
	return concatBytes(seiVarint(payloadType), seiVarint(payload.length), payload);
};

/** An SEI NAL unit (type 6) carrying the given messages, with RBSP trailing bits and emulation prevention. */
const seiNal = (...messages: Uint8Array[]) => {
	const rbsp = concatBytes(...messages, [0x80]);
	return concatBytes([0x06], addEmulationPrevention(rbsp));
};

const avcAnnexBConfig = { codec: 'avc1.42c01e' };
const avcLengthPrefixedConfig = {
	codec: 'avc1.42c01e',
	// Only lengthSizeMinusOne (byte 4) matters for NAL unit iteration
	description: new Uint8Array([1, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x00]),
};

describe('determineVideoPacketType: AVC', () => {
	test('an IDR slice makes a key packet and a non-IDR slice a delta packet', () => {
		expect(determineVideoPacketType('avc', avcAnnexBConfig, annexB(AVC_SPS, AVC_PPS, AVC_IDR_SLICE))).toBe('key');
		expect(determineVideoPacketType('avc', avcAnnexBConfig, annexB(AVC_NON_IDR_SLICE))).toBe('delta');
		// Data partition A (type 2) and slice type 5 sit at the ends of the slice range
		expect(determineVideoPacketType('avc', avcAnnexBConfig, annexB([0x42, 0x80, 0x11]))).toBe('delta');
		expect(determineVideoPacketType('avc', avcAnnexBConfig, annexB([0x44, 0x80, 0x11]))).toBe('delta');
	});

	test('the first slice decides, whatever follows it', () => {
		const deltaFirst = annexB(AVC_NON_IDR_SLICE, AVC_IDR_SLICE);
		expect(determineVideoPacketType('avc', avcAnnexBConfig, deltaFirst)).toBe('delta');
		expect(determineVideoPacketType('avc', avcAnnexBConfig, annexB(AVC_IDR_SLICE, AVC_NON_IDR_SLICE))).toBe('key');
	});

	test('a packet with only parameter sets is a delta packet', () => {
		expect(determineVideoPacketType('avc', avcAnnexBConfig, annexB(AVC_SPS, AVC_PPS))).toBe('delta');
	});

	test('a recovery point SEI with recovery_frame_cnt 0 and exact_match_flag 1 makes a key packet', () => {
		const sei = seiNal(seiMessage(6, recoveryPointPayload(0, true)));
		const packet = annexB(AVC_SPS, AVC_PPS, sei, AVC_NON_IDR_SLICE);
		expect(determineVideoPacketType('avc', avcAnnexBConfig, packet)).toBe('key');
	});

	test('a recovery point SEI without exact match or with a nonzero recovery_frame_cnt does not', () => {
		const noExactMatch = annexB(
			AVC_SPS,
			AVC_PPS,
			seiNal(seiMessage(6, recoveryPointPayload(0, false))),
			AVC_NON_IDR_SLICE,
		);
		expect(determineVideoPacketType('avc', avcAnnexBConfig, noExactMatch)).toBe('delta');

		const laterRecovery = annexB(
			AVC_SPS,
			AVC_PPS,
			seiNal(seiMessage(6, recoveryPointPayload(2, true))),
			AVC_NON_IDR_SLICE,
		);
		expect(determineVideoPacketType('avc', avcAnnexBConfig, laterRecovery)).toBe('delta');
	});

	test('SEI messages of other payload types are skipped by their payloadSize', () => {
		const userDataUnregistered = new Uint8Array(17).fill(0x11);
		const packet = annexB(
			AVC_SPS,
			AVC_PPS,
			seiNal(seiMessage(5, userDataUnregistered), seiMessage(6, recoveryPointPayload(0, true))),
			AVC_NON_IDR_SLICE,
		);
		expect(determineVideoPacketType('avc', avcAnnexBConfig, packet)).toBe('key');

		// An SEI with only other messages doesn't make the packet a key packet
		const onlyUserData = annexB(AVC_SPS, AVC_PPS, seiNal(seiMessage(5, userDataUnregistered)), AVC_NON_IDR_SLICE);
		expect(determineVideoPacketType('avc', avcAnnexBConfig, onlyUserData)).toBe('delta');
	});

	test('SEI payload types and sizes of 255 and above use 0xFF continuation bytes', () => {
		// payloadType 256 (0xFF 0x01) with a 300-byte payload (0xFF 0x2D), then the recovery point
		const packet = annexB(
			AVC_SPS,
			AVC_PPS,
			seiNal(seiMessage(256, new Uint8Array(300).fill(0x22)), seiMessage(6, recoveryPointPayload(0, true))),
			AVC_NON_IDR_SLICE,
		);
		expect(determineVideoPacketType('avc', avcAnnexBConfig, packet)).toBe('key');

		// A payloadType of 255 + 6 is not a recovery point
		const notRecovery = annexB(
			AVC_SPS,
			AVC_PPS,
			seiNal(seiMessage(261, recoveryPointPayload(0, true))),
			AVC_NON_IDR_SLICE,
		);
		expect(determineVideoPacketType('avc', avcAnnexBConfig, notRecovery)).toBe('delta');
	});

	test('payloadSize counts SEI payload bytes after emulation prevention bytes are removed', () => {
		// The first payload is 00 00 00 01, written as 00 00 03 00 01 in the NAL unit
		const packet = annexB(
			AVC_SPS,
			AVC_PPS,
			seiNal(seiMessage(5, [0, 0, 0, 1]), seiMessage(6, recoveryPointPayload(0, true))),
			AVC_NON_IDR_SLICE,
		);
		expect(packet.includes(3)).toBe(true);
		expect(determineVideoPacketType('avc', avcAnnexBConfig, packet)).toBe('key');
	});

	test('recovery point SEIs are found in length-prefixed packets too', () => {
		const packet = lengthPrefixed(4, seiNal(seiMessage(6, recoveryPointPayload(0, true))), AVC_NON_IDR_SLICE);
		expect(determineVideoPacketType('avc', avcLengthPrefixedConfig, packet)).toBe('key');

		const delta = lengthPrefixed(4, seiNal(seiMessage(6, recoveryPointPayload(1, true))), AVC_NON_IDR_SLICE);
		expect(determineVideoPacketType('avc', avcLengthPrefixedConfig, delta)).toBe('delta');
	});
});

/** A Vorbis comment block (RFC 7845 5.2 / Vorbis I 5.2.1): vendor string, then length-prefixed UTF-8 comments. */
const vorbisCommentBlock = (vendor: string, comments: string[], declaredCount = comments.length) => {
	const encoder = new TextEncoder();
	const vendorBytes = encoder.encode(vendor);
	return concatBytes(
		u32le(vendorBytes.length),
		vendorBytes,
		u32le(declaredCount),
		...comments.map((comment) => {
			const bytes = encoder.encode(comment);
			return concatBytes(u32le(bytes.length), bytes);
		}),
	);
};

describe('readVorbisComments', () => {
	test('maps the standard fields, keeps the first value of a field and collects repeats in raw', () => {
		const tags: MetadataTags = {};
		readVorbisComments(vorbisCommentBlock('libVorbis I 20200704', [
			'title=First title',
			'TITLE=Second title',
			'Artist=A',
			'ARTIST=B',
			'ARTIST=C',
			'ALBUM=Album',
			'ALBUMARTIST=Album artist',
			'DESCRIPTION=Description',
			'COMMENT=Comment',
			'LYRICS=Lyrics',
			'GENRE=Genre',
			'no separator here',
			'EMPTY=',
		]), tags);
		expect(tags).toMatchObject({
			title: 'First title',
			artist: 'A',
			album: 'Album',
			albumArtist: 'Album artist',
			description: 'Description',
			comment: 'Comment',
			lyrics: 'Lyrics',
			genre: 'Genre',
		});
		expect(tags.raw).toEqual({
			vendor: 'libVorbis I 20200704',
			TITLE: ['First title', 'Second title'],
			ARTIST: ['A', 'B', 'C'],
			ALBUM: 'Album',
			ALBUMARTIST: 'Album artist',
			DESCRIPTION: 'Description',
			COMMENT: 'Comment',
			LYRICS: 'Lyrics',
			GENRE: 'Genre',
			EMPTY: '',
		});
	});

	test('an empty vendor string is not exposed', () => {
		const tags: MetadataTags = {};
		readVorbisComments(vorbisCommentBlock('', ['GENRE=Jazz']), tags);
		expect(tags.raw).toEqual({ GENRE: 'Jazz' });
	});

	test.each([
		['TRACKNUMBER=3', { trackNumber: 3 }],
		['TRACKNUMBER=3/12', { trackNumber: 3, tracksTotal: 12 }],
		['TRACKNUMBER=0/12', { tracksTotal: 12 }],
		['TRACKNUMBER=-2/-5', {}],
		['TRACKNUMBER=3/0', { trackNumber: 3 }],
		['TRACKNUMBER=x/y', {}],
		['TRACKTOTAL=9', { tracksTotal: 9 }],
		['TRACKTOTAL=0', {}],
		['DISCNUMBER=2/3', { discNumber: 2, discsTotal: 3 }],
		['DISCNUMBER=0/0', {}],
		['DISCNUMBER=-1/-4', {}],
		['DISCNUMBER=1', { discNumber: 1 }],
		['DISCTOTAL=4', { discsTotal: 4 }],
		['DISCTOTAL=0', {}],
		['DISCTOTAL=-4', {}],
		['BPM=128', { beatsPerMinute: 128 }],
		['BPM=0', {}],
		['BPM=-90', {}],
		['BPM=fast', {}],
		['DATE=not a date', {}],
	])('%s reads as %j', (comment, expected) => {
		const tags: MetadataTags = {};
		readVorbisComments(vorbisCommentBlock('v', [comment]), tags);
		const { raw, ...rest } = tags;
		expect(raw).toBeDefined();
		expect(rest).toEqual(expected);
	});

	test('a DATE that parses becomes the date tag', () => {
		const tags: MetadataTags = {};
		readVorbisComments(vorbisCommentBlock('v', ['DATE=2021-03-04']), tags);
		expect(tags.date?.toISOString()).toBe('2021-03-04T00:00:00.000Z');
	});

	test('keeps the comments read before the list is cut off', () => {
		const full = vorbisCommentBlock('v', ['TITLE=Kept', 'ARTIST=Cut']);
		const tags: MetadataTags = {};
		// Cut inside the second comment's length field
		readVorbisComments(full.subarray(0, full.length - 'ARTIST=Cut'.length - 2), tags);
		expect(tags.title).toBe('Kept');
		expect(tags.artist).toBeUndefined();

		// The list declares more comments than there are
		const overstated: MetadataTags = {};
		readVorbisComments(vorbisCommentBlock('v', ['TITLE=Only'], 5), overstated);
		expect(overstated.title).toBe('Only');
	});

	test('a block without the comment count, or shorter than the vendor length field, gives only the vendor', () => {
		const vendorOnly: MetadataTags = {};
		readVorbisComments(concatBytes(u32le(3), ascii('abc')), vendorOnly);
		expect(vendorOnly).toEqual({ raw: { vendor: 'abc' } });

		const countCut: MetadataTags = {};
		readVorbisComments(concatBytes(u32le(1), ascii('x'), [1, 0, 0]), countCut);
		expect(countCut).toEqual({ raw: { vendor: 'x' } });

		const tooShort: MetadataTags = {};
		readVorbisComments(new Uint8Array([4, 0, 0]), tooShort);
		expect(tooShort).toEqual({});
	});
});
/** A VP9 key frame uncompressed header (profile, colour config, frame size), as far as codec info parsing reads. */
const vp9KeyFrameHeader = (options: {
	profile: number;
	bitDepth?: number;
	colorSpace: number;
	fullRange?: boolean;
	subsampling?: [number, number];
	width: number;
	height: number;
	frameType?: number;
	showExisting?: boolean;
	syncCode?: number;
}) => {
	const writer = new BitWriter()
		.writeBits(2, 2)
		.writeBits(1, options.profile & 1)
		.writeBits(1, options.profile >> 1);
	if (options.profile === 3) {
		writer.writeBits(1, 0);
	}
	writer.writeFlag(options.showExisting ?? false);
	if (options.showExisting) {
		return writer.writeBits(3, 0).alignZero().toBytes();
	}
	writer.writeBits(1, options.frameType ?? 0).writeBits(1, 1).writeBits(1, 0);
	writer.writeBits(24, options.syncCode ?? 0x498342);
	if (options.profile >= 2) {
		writer.writeFlag(options.bitDepth === 12);
	}
	writer.writeBits(3, options.colorSpace).writeFlag(options.fullRange ?? false);
	if (options.profile === 1 || options.profile === 3) {
		const [x, y] = options.subsampling ?? [1, 1];
		writer.writeBits(1, x).writeBits(1, y).writeBits(1, 0);
	}
	writer.writeBits(16, options.width - 1).writeBits(16, options.height - 1).writeBits(1, 0);
	return writer.alignZero().toBytes();
};

describe('extractVp9CodecInfoFromPacket', () => {
	test.each([
		// profile, subsampling_x/y, expected chromaSubsampling (vpcC: 1 = 4:2:0, 2 = 4:2:2, 3 = 4:4:4)
		[0, undefined, 1],
		[1, [1, 0] as [number, number], 2],
		[1, [0, 0] as [number, number], 3],
		[1, [1, 1] as [number, number], 1],
		[3, [1, 0] as [number, number], 2],
	])('profile %i with subsampling %j has chroma subsampling %i', (profile, subsampling, expected) => {
		const info = extractVp9CodecInfoFromPacket(vp9KeyFrameHeader({
			profile,
			bitDepth: profile >= 2 ? 10 : 8,
			colorSpace: 2,
			subsampling,
			width: 320,
			height: 240,
		}));
		expect(info).toMatchObject({ profile, chromaSubsampling: expected });
	});

	test('profiles 2 and 3 carry the 10/12-bit flag; 0 and 1 are 8-bit', () => {
		const p2 = extractVp9CodecInfoFromPacket(vp9KeyFrameHeader({
			profile: 2,
			bitDepth: 12,
			colorSpace: 5,
			width: 64,
			height: 64,
		}));
		expect(p2).toMatchObject({ profile: 2, bitDepth: 12 });
		const p3 = extractVp9CodecInfoFromPacket(vp9KeyFrameHeader({
			profile: 3,
			bitDepth: 10,
			colorSpace: 5,
			subsampling: [0, 0],
			width: 64,
			height: 64,
		}));
		expect(p3).toMatchObject({ profile: 3, bitDepth: 10, chromaSubsampling: 3 });
		const p1 = extractVp9CodecInfoFromPacket(vp9KeyFrameHeader({
			profile: 1,
			colorSpace: 1,
			width: 64,
			height: 64,
		}));
		expect(p1).toMatchObject({ profile: 1, bitDepth: 8 });
	});

	test.each([
		[0, [2, 2, 2]], // CS_UNKNOWN
		[2, [1, 1, 1]], // CS_BT_709
		[3, [6, 6, 6]], // CS_SMPTE_170
		[4, [7, 7, 7]], // CS_SMPTE_240
		[5, [9, 14, 9]], // CS_BT_2020
		[6, [2, 2, 2]], // CS_RESERVED
	])('color_space %i maps to primaries/transfer/matrix %j', (colorSpace, [p, t, m]) => {
		const info = extractVp9CodecInfoFromPacket(vp9KeyFrameHeader({
			profile: 0,
			colorSpace,
			fullRange: true,
			width: 64,
			height: 64,
		}));
		expect(info).toMatchObject({
			colourPrimaries: p,
			transferCharacteristics: t,
			matrixCoefficients: m,
			videoFullRangeFlag: 1,
		});
		expect(vp9CodecInfoHasColorInfo(info!)).toBe(p !== 2);
	});

	test.each([
		[192, 192, 10], // 36864: level 1
		[192, 193, 11],
		[384, 320, 20], // 122880: level 2
		[384, 321, 21],
		[1920, 1080, 40],
		[1920, 1161, 50], // 2229120 > 2228224: past level 4/4.1's picture size
		[8192, 4352, 60],
		[16384, 16384, 62], // larger than every level: the highest
	])('a %ix%i frame gets level %i from the picture size', (width, height, level) => {
		const info = extractVp9CodecInfoFromPacket(vp9KeyFrameHeader({ profile: 0, colorSpace: 2, width, height }));
		expect(info!.level).toBe(level);
	});

	test('inter frames, shown existing frames and bad sync codes or frame markers give no codec info', () => {
		const base = { profile: 0, colorSpace: 2, width: 64, height: 64 };
		expect(extractVp9CodecInfoFromPacket(vp9KeyFrameHeader({ ...base, frameType: 1 }))).toBe(null);
		expect(extractVp9CodecInfoFromPacket(vp9KeyFrameHeader({ ...base, showExisting: true }))).toBe(null);
		expect(extractVp9CodecInfoFromPacket(vp9KeyFrameHeader({ ...base, syncCode: 0x498343 }))).toBe(null);
		const badMarker = vp9KeyFrameHeader(base);
		badMarker[0]! &= 0x3f;
		expect(extractVp9CodecInfoFromPacket(badMarker)).toBe(null);
	});

	test('colour info is present as soon as any of primaries, transfer or matrix is specified', () => {
		const info = { profile: 0, level: 10, bitDepth: 8, chromaSubsampling: 1, videoFullRangeFlag: 0 };
		const unspecified = { colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2 };
		expect(vp9CodecInfoHasColorInfo({ ...info, ...unspecified })).toBe(false);
		expect(vp9CodecInfoHasColorInfo({ ...info, ...unspecified, colourPrimaries: 1 })).toBe(true);
		expect(vp9CodecInfoHasColorInfo({ ...info, ...unspecified, transferCharacteristics: 16 })).toBe(true);
		expect(vp9CodecInfoHasColorInfo({ ...info, ...unspecified, matrixCoefficients: 9 })).toBe(true);
	});
});

describe('parseOpusIdentificationHeader', () => {
	const opusHead = (channels: number, family: number, extra: number[] = []) => concatBytes(
		ascii('OpusHead'),
		[1, channels],
		[0x38, 0x01], // pre-skip 312
		u32le(44100),
		[0xfe, 0xff], // output gain -2
		[family],
		extra,
	);

	test('reads the fields, and the channel mapping table only for nonzero mapping families', () => {
		expect(parseOpusIdentificationHeader(opusHead(2, 0))).toEqual({
			outputChannelCount: 2,
			preSkip: 312,
			inputSampleRate: 44100,
			outputGain: -2,
			channelMappingFamily: 0,
			channelMappingTable: null,
		});
		const surround = parseOpusIdentificationHeader(opusHead(6, 1, [4, 2, 0, 4, 1, 2, 3, 5]));
		expect(surround.channelMappingFamily).toBe(1);
		expect([...surround.channelMappingTable!]).toEqual([4, 2, 0, 4, 1, 2, 3, 5]);
	});

	test('rejects headers shorter than 19 bytes', () => {
		expect(() => parseOpusIdentificationHeader(opusHead(2, 0).subarray(0, 18))).toThrow();
	});
});

/** A two-byte HEVC NAL unit header of the given type (layer 0, TemporalId 0) followed by a few payload bytes. */
const hevcNal = (type: number) => [type << 1, 0x01, 0xaf, 0x09, 0x40];

describe('parseHevcSps and extractHevcDecoderConfigurationRecord', () => {
	test('crops by the conformance window in chroma units for each chroma format', () => {
		expect(parseHevcSps(buildHevcSps({
			width: 1920,
			height: 1088,
			conformanceWindow: [0, 0, 0, 4],
		}))).toMatchObject({
			displayWidth: 1920,
			displayHeight: 1080,
			chromaFormatIdc: 1,
		});
		expect(parseHevcSps(buildHevcSps({
			chromaFormatIdc: 2,
			width: 1280,
			height: 720,
			conformanceWindow: [1, 2, 3, 4],
		}))).toMatchObject({ displayWidth: 1280 - 6, displayHeight: 720 - 7, chromaFormatIdc: 2 });
		expect(parseHevcSps(buildHevcSps({
			chromaFormatIdc: 3,
			width: 1280,
			height: 720,
			conformanceWindow: [1, 2, 3, 4],
		}))).toMatchObject({ displayWidth: 1280 - 3, displayHeight: 720 - 7 });
		expect(parseHevcSps(buildHevcSps({
			chromaFormatIdc: 3,
			separateColourPlane: true,
			width: 64,
			height: 64,
			conformanceWindow: [1, 0, 0, 2],
		}))).toMatchObject({ displayWidth: 63, displayHeight: 62 });
		expect(parseHevcSps(buildHevcSps({
			chromaFormatIdc: 0,
			width: 64,
			height: 64,
			conformanceWindow: [1, 0, 0, 2],
		}))).toMatchObject({ displayWidth: 63, displayHeight: 62, chromaFormatIdc: 0 });
	});

	test('a conformance window covering the whole picture makes the SPS invalid', () => {
		expect(parseHevcSps(buildHevcSps({ width: 64, height: 64, conformanceWindow: [16, 16, 0, 0] }))).toBe(null);
		expect(parseHevcSps(buildHevcSps({ width: 64, height: 64, conformanceWindow: [0, 0, 16, 16] }))).toBe(null);
		expect(parseHevcSps(buildHevcSps({ width: 64, height: 64, conformanceWindow: [0, 0, 15, 16] }))).toMatchObject({
			displayHeight: 2,
		});
	});

	test('reads profile, tier, level, compatibility and constraint flags', () => {
		const info = parseHevcSps(buildHevcSps({
			profileSpace: 0,
			tierFlag: 1,
			profileIdc: 2,
			compatibilityFlags: 0x20000000,
			constraintFlags: [0xb0, 0x01, 0x02, 0x03, 0x04, 0x05],
			levelIdc: 153,
			bitDepthLuma: 10,
			bitDepthChroma: 10,
			width: 3840,
			height: 2160,
		}));
		expect(info).toMatchObject({
			generalProfileSpace: 0,
			generalTierFlag: 1,
			generalProfileIdc: 2,
			generalProfileCompatibilityFlags: 0x20000000,
			generalLevelIdc: 153,
			bitDepthLumaMinus8: 2,
			bitDepthChromaMinus8: 2,
		});
		expect([...info!.generalConstraintIndicatorFlags]).toEqual([0xb0, 0x01, 0x02, 0x03, 0x04, 0x05]);
	});

	test('skips sub-layer profile and level data and takes the highest sub-layer\'s reorder depth', () => {
		const info = parseHevcSps(buildHevcSps({
			maxSubLayersMinus1: 2,
			subLayerFlags: [[1, 1], [0, 1]],
			subLayerOrderingInfo: true,
			reorderPics: [0, 1, 3],
			width: 640,
			height: 360,
		}));
		expect(info).toMatchObject({ spsMaxSubLayersMinus1: 2, maxDecFrameBuffering: 4, displayWidth: 640 });

		const single = parseHevcSps(buildHevcSps({ maxSubLayersMinus1: 1, reorderPics: [2], width: 640, height: 360 }));
		expect(single).toMatchObject({ spsMaxSubLayersMinus1: 1, maxDecFrameBuffering: 3, displayHeight: 360 });
	});

	test('skips scaling list data, PCM parameters and several short-term reference picture sets', () => {
		const info = parseHevcSps(buildHevcSps({
			width: 1280,
			height: 720,
			scalingListData: true,
			pcm: true,
			shortTermRps: [[2, 0], [1, 1], [0, 3]],
			vui: { videoSignal: { fullRange: true, colour: [9, 16, 9] } },
		}));
		expect(info).toMatchObject({
			displayWidth: 1280,
			colourPrimaries: 9,
			transferCharacteristics: 16,
			matrixCoefficients: 9,
			fullRangeFlag: 1,
		});
	});

	test('reads the VUI aspect ratio, colour description and min_spatial_segmentation_idc past optional fields', () => {
		const info = parseHevcSps(buildHevcSps({
			width: 720,
			height: 576,
			vui: {
				sar: 12,
				videoSignal: { fullRange: false, colour: [5, 6, 5] },
				defaultDisplayWindow: true,
				timing: { pocProportional: true },
				minSpatialSegmentationIdc: 7,
			},
		}));
		expect(info).toMatchObject({
			pixelAspectRatio: { num: 64, den: 33 },
			colourPrimaries: 5,
			transferCharacteristics: 6,
			matrixCoefficients: 5,
			fullRangeFlag: 0,
			minSpatialSegmentationIdc: 7,
		});

		const extendedSar = parseHevcSps(buildHevcSps({ width: 720, height: 576, vui: { sar: [16, 15] } }));
		expect(extendedSar!.pixelAspectRatio).toEqual({ num: 16, den: 15 });
		const plain = parseHevcSps(buildHevcSps({ width: 720, height: 576 }));
		expect(plain).toMatchObject({
			pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2,
			minSpatialSegmentationIdc: 0,
		});
	});

	test.each([
		[true, false, false, 2], // tiles: tile-based
		[false, true, false, 3], // wavefront
		[true, true, true, 0], // both: mixed
	])('tiles %s, entropy coding sync %s (cu_qp_delta %s): parallelismType %i', (tiles, wpp, cuQpDelta, expected) => {
		const vps = [0x40, 0x01, 0x0c, 0x01, 0xff, 0xff];
		const sps = buildHevcSps({ width: 640, height: 360, vui: { minSpatialSegmentationIdc: 4 } });
		const pps = buildHevcPps(tiles, wpp, cuQpDelta);
		const prefixSei = [0x4e, 0x01, 0x05, 0x01, 0x11, 0x80];
		const record = extractHevcDecoderConfigurationRecord(annexB(vps, sps, pps, prefixSei, hevcNal(19)));
		expect(record).toMatchObject({
			parallelismType: expected,
			minSpatialSegmentationIdc: 4,
			generalProfileIdc: 1,
			numTemporalLayers: 1,
			lengthSizeMinusOne: 3,
		});
		expect(record!.arrays.map(array => [array.nalUnitType, array.nalUnits.length])).toEqual([
			[32, 1], [33, 1], [34, 1], [39, 1],
		]);
	});

	test('no record without both an SPS and a PPS', () => {
		const sps = buildHevcSps({ width: 640, height: 360 });
		expect(extractHevcDecoderConfigurationRecord(annexB(sps, hevcNal(19)))).toBe(null);
		expect(extractHevcDecoderConfigurationRecord(annexB(buildHevcPps(false, false), hevcNal(19)))).toBe(null);
	});
});

describe('determineVideoPacketType: HEVC', () => {
	test.each([
		[0, 'delta'], // TRAIL_N
		[1, 'delta'], // TRAIL_R
		[8, 'delta'], // RASL_N
		[9, 'delta'], // RASL_R
		[15, 'delta'], // RSV_VCL_R15
		[16, 'key'], // BLA_W_LP
		[19, 'key'], // IDR_W_RADL
		[20, 'key'], // IDR_N_LP
		[21, 'key'], // CRA_NUT
		[22, 'key'], // RSV_IRAP_VCL22
		[23, 'key'], // RSV_IRAP_VCL23
	] as const)('VCL NAL unit type %i makes a %s packet', (type, expected) => {
		const packet = annexB(hevcNal(32), hevcNal(33), hevcNal(34), hevcNal(39), hevcNal(type));
		expect(determineVideoPacketType('hevc', { codec: 'hvc1.1.6.L93.B0' }, packet)).toBe(expected);
	});

	test('non-VCL NAL units alone (AUD, parameter sets, reserved non-IRAP types) give a delta packet', () => {
		const packet = annexB(hevcNal(35), hevcNal(32), hevcNal(33), hevcNal(34), hevcNal(24), hevcNal(40));
		expect(determineVideoPacketType('hevc', { codec: 'hvc1.1.6.L93.B0' }, packet)).toBe('delta');
	});
});

describe('determineVideoPacketType: VP8 and VP9', () => {
	test('VP8 key frames have a zero frame type bit', () => {
		expect(determineVideoPacketType('vp8', { codec: 'vp8' }, new Uint8Array([0x10, 0x02, 0x00]))).toBe('key');
		expect(determineVideoPacketType('vp8', { codec: 'vp8' }, new Uint8Array([0x11, 0x02, 0x00]))).toBe('delta');
	});

	test.each([
		// frame_marker 10, profile_low_bit, profile_high_bit, [reserved_zero for profile 3], show_existing_frame,
		// frame_type
		[0b1000_0000, 'key'], // profile 0, key frame
		[0b1000_0100, 'delta'], // profile 0, inter frame
		[0b1010_0000, 'key'], // profile 1
		[0b1010_0100, 'delta'],
		[0b1001_0000, 'key'], // profile 2
		[0b1001_0100, 'delta'],
		[0b1011_0000, 'key'], // profile 3: reserved bit, then show_existing_frame and frame_type
		[0b1011_0010, 'delta'],
		[0b1000_1000, null], // show_existing_frame
		[0b1011_0100, null], // profile 3, show_existing_frame
		[0b0100_0000, null], // invalid frame marker
	] as const)('VP9 uncompressed header byte %i gives %s', (firstByte, expected) => {
		const packet = new Uint8Array([firstByte, 0x49, 0x83, 0x42, 0x00]);
		expect(determineVideoPacketType('vp9', { codec: 'vp09.00.10.08' }, packet)).toBe(expected);
	});
});

/** An AV1 OBU with obu_has_size_field set (leb128 size). */
const obu = (type: number, payload: number[], extension = false) => {
	const header = [(type << 3) | (extension ? 0b100 : 0) | 0b10];
	if (extension) {
		header.push(0b0010_0000); // temporal_id 1, spatial_id 0
	}
	return [...header, payload.length, ...payload];
};

const av1Config = { codec: 'av01.0.04M.08' };

describe('determineVideoPacketType: AV1', () => {
	const temporalDelimiter = obu(2, []);
	// seq_profile 0, still_picture 0, reduced_still_picture_header 0 (only the first bits are read)
	const sequenceHeader = obu(1, [0b0000_0000, 0x00, 0x00]);
	// seq_profile 0, still_picture 1, reduced_still_picture_header 1
	const stillSequenceHeader = obu(1, [0b0001_1000, 0x00, 0x00]);

	test.each([
		// show_existing_frame, frame_type (2 bits)
		[0b0000_0000, 'key'], // KEY_FRAME
		[0b0010_0000, 'delta'], // INTER_FRAME
		[0b0100_0000, 'delta'], // INTRA_ONLY_FRAME
		[0b0110_0000, 'delta'], // SWITCH_FRAME
		[0b1000_0000, null], // show_existing_frame
	] as const)('an OBU_FRAME starting with byte %i gives %s', (firstByte, expected) => {
		const packet = new Uint8Array([...temporalDelimiter, ...sequenceHeader, ...obu(6, [firstByte, 0x12, 0x34])]);
		expect(determineVideoPacketType('av1', av1Config, packet)).toBe(expected);
	});

	test('frame headers and redundant frame headers are read like frames', () => {
		const frameHeader = new Uint8Array([...temporalDelimiter, ...obu(3, [0b0010_0000, 0x00])]);
		expect(determineVideoPacketType('av1', av1Config, frameHeader)).toBe('delta');
		const redundant = new Uint8Array([...temporalDelimiter, ...obu(7, [0b0000_0000, 0x00])]);
		expect(determineVideoPacketType('av1', av1Config, redundant)).toBe('key');
	});

	test('with reduced_still_picture_header, every frame is a key frame', () => {
		const packet = new Uint8Array([...temporalDelimiter, ...stillSequenceHeader, ...obu(6, [0b1110_0000, 0x00])]);
		expect(determineVideoPacketType('av1', av1Config, packet)).toBe('key');
	});

	test('OBU extension headers are skipped', () => {
		const packet = new Uint8Array([...obu(2, [], true), ...obu(6, [0b0010_0000, 0x00], true)]);
		expect(determineVideoPacketType('av1', av1Config, packet)).toBe('delta');
	});

	test('a packet without frame OBUs has no packet type', () => {
		const packet = new Uint8Array([...temporalDelimiter, ...sequenceHeader, ...obu(5, [0x01, 0x02])]);
		expect(determineVideoPacketType('av1', av1Config, packet)).toBe(null);
	});

	test('the last OBU may omit its size field and extend to the end of the packet', () => {
		const packet = new Uint8Array([...temporalDelimiter, (6 << 3), 0b0010_0000, 0x55, 0x66]);
		expect(determineVideoPacketType('av1', av1Config, packet)).toBe('delta');
	});
});

describe('Annex B scanning and emulation prevention', () => {
	const nalUnits = (bytes: number[]) => {
		const data = new Uint8Array(bytes);
		return [...iterateNalUnitsInAnnexB(data)].map(({
			offset,
			length,
		}) => [...data.subarray(offset, offset + length)]);
	};

	test.each([
		['a 4-byte start code', [0, 0, 0, 1, 0x65, 0xaa], [[0x65, 0xaa]]],
		['3-byte start codes', [0, 0, 1, 0x67, 0, 0, 1, 0x68], [[0x67], [0x68]]],
		['leading bytes before the first start code', [0xff, 0x00, 0, 0, 1, 0x65], [[0x65]]],
		['zeros inside a NAL unit', [0, 0, 1, 0x65, 0, 0xbb, 0, 0, 2, 0xcc], [[0x65, 0, 0xbb, 0, 0, 2, 0xcc]]],
		['back-to-back start codes', [0, 0, 1, 0, 0, 1, 0x41], [[0x41]]],
		['a start code at the very end', [0, 0, 1, 0x41, 0x99, 0, 0, 1], [[0x41, 0x99]]],
		['no start code at all', [0x65, 0x88, 0x84], []],
		['too little data', [0, 0], []],
	])('handles %s', (_, bytes, expected) => {
		expect(nalUnits(bytes)).toEqual(expected);
	});

	test.each([
		[[0, 0, 0], [0, 0, 3, 0]],
		[[0, 0, 1], [0, 0, 3, 1]],
		[[0, 0, 2], [0, 0, 3, 2]],
		[[0, 0, 3], [0, 0, 3, 3]],
		[[0, 0, 4], [0, 0, 4]],
		[[0, 0, 0, 0, 1], [0, 0, 3, 0, 0, 3, 1]],
		[[0, 1, 0, 0, 0x80, 0, 0], [0, 1, 0, 0, 0x80, 0, 0]],
	])('addEmulationPreventionBytes(%j) is %j', (input, expected) => {
		expect([...addEmulationPreventionBytes(new Uint8Array(input))]).toEqual(expected);
	});
});

describe('parseOpusTocByte', () => {
	test.each([
		[0, 480], [1, 960], [2, 1920], [3, 2880], // SILK NB
		[8, 480], [11, 2880], // SILK WB
		[12, 480], [13, 960], [15, 960], // Hybrid
		[16, 120], [17, 240], [18, 480], [19, 960], // CELT NB
		[28, 120], [31, 960], // CELT FB
	])('config %i lasts %i samples per frame', (config, samples) => {
		expect(parseOpusTocByte(new Uint8Array([config << 3])).durationInSamples).toBe(samples);
	});

	test('frame count codes 1 and 2 hold two frames; code 3 reads the count from the next byte', () => {
		const config = 19 << 3; // 20 ms CELT
		expect(parseOpusTocByte(new Uint8Array([config | 1])).durationInSamples).toBe(1920);
		expect(parseOpusTocByte(new Uint8Array([config | 2])).durationInSamples).toBe(1920);
		expect(parseOpusTocByte(new Uint8Array([config | 3, 0b1000_0101])).durationInSamples).toBe(5 * 960);
		expect(parseOpusTocByte(new Uint8Array([config | 3, 0b0011_1111])).durationInSamples).toBe(63 * 960);
	});
});

describe('createVorbisComments', () => {
	test('round-trips through readVorbisComments', () => {
		const tags = {
			title: 'Title',
			description: 'Description',
			artist: 'Artist',
			album: 'Album',
			albumArtist: 'Album artist',
			genre: 'Genre',
			date: new Date('2015-06-12T00:00:00Z'),
			comment: 'Comment',
			lyrics: 'Lyrics',
			trackNumber: 3,
			tracksTotal: 12,
			discNumber: 1,
			discsTotal: 2,
			images: [{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', kind: 'coverFront' as const }],
		};
		const header = new Uint8Array([0x03, ...[...'vorbis'].map(char => char.charCodeAt(0))]);
		const bytes = createVorbisComments(header, tags, true);
		expect([...bytes.subarray(0, 7)]).toEqual([...header]);

		const read: MetadataTags = {};
		readVorbisComments(bytes.subarray(7), read);
		expect(read).toMatchObject({
			...tags,
			images: [{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', kind: 'coverFront' }],
		});

		const withoutImages: MetadataTags = {};
		readVorbisComments(createVorbisComments(new Uint8Array(0), tags, false), withoutImages);
		expect(withoutImages.images).toBeUndefined();
		expect(withoutImages.title).toBe('Title');
	});
});

describe('extractAv1CodecInfoFromPacket', () => {
	const info = (options: Av1SequenceHeaderOptions, before: number[][] = []) => {
		// Temporal delimiter and padding OBUs before the sequence header are skipped
		return extractAv1CodecInfoFromPacket(concatBytes(...before, av1SequenceHeaderObu(options)));
	};
	const base = {
		profile: 0,
		level: 8,
		tier: 0,
		bitDepth: 8,
		monochrome: 0,
		chromaSubsamplingX: 1,
		chromaSubsamplingY: 1,
		chromaSamplePosition: 0,
		videoFullRangeFlag: 0,
		colourPrimaries: 2,
		transferCharacteristics: 2,
		matrixCoefficients: 2,
	};

	test('reads a Main profile 8-bit 4:2:0 header after other OBUs', () => {
		expect(info({ profile: 0 }, [[0x12, 0x00], [0x7a, 0x02, 0xaa, 0xbb]])).toEqual(base);
	});

	test.each([
		['Main 10-bit', { profile: 0, highBitdepth: true }, { bitDepth: 10 }],
		[
			'High 4:4:4',
			{ profile: 1, highBitdepth: true },
			{ profile: 1, bitDepth: 10, chromaSubsamplingX: 0, chromaSubsamplingY: 0 },
		],
		[
			'Professional 10-bit 4:2:2',
			{ profile: 2, highBitdepth: true },
			{ profile: 2, bitDepth: 10, chromaSubsamplingY: 0 },
		],
		['Professional 8-bit', { profile: 2 }, { profile: 2, chromaSubsamplingY: 0 }],
		[
			'Professional 12-bit 4:2:0 with a chroma sample position',
			{ profile: 2, highBitdepth: true, twelveBit: true, subsampling: [1, 1], chromaSamplePosition: 2 },
			{ profile: 2, bitDepth: 12, chromaSamplePosition: 2 },
		],
		[
			'Professional 12-bit 4:2:2',
			{ profile: 2, highBitdepth: true, twelveBit: true, subsampling: [1, 0] },
			{ profile: 2, bitDepth: 12, chromaSubsamplingY: 0 },
		],
		[
			'Professional 12-bit 4:4:4',
			{ profile: 2, highBitdepth: true, twelveBit: true, subsampling: [0, 0] },
			{ profile: 2, bitDepth: 12, chromaSubsamplingX: 0, chromaSubsamplingY: 0 },
		],
		[
			'monochrome full range',
			{ profile: 0, monochrome: true, fullRange: true },
			{ monochrome: 1, videoFullRangeFlag: 1 },
		],
		[
			'BT.2020 PQ colour description',
			{ profile: 0, highBitdepth: true, colour: [9, 16, 9], fullRange: false },
			{ bitDepth: 10, colourPrimaries: 9, transferCharacteristics: 16, matrixCoefficients: 9 },
		],
		[
			'sRGB with an identity matrix (implicitly full range 4:4:4)',
			{ profile: 1, colour: [1, 13, 0] },
			{
				profile: 1,
				colourPrimaries: 1,
				transferCharacteristics: 13,
				matrixCoefficients: 0,
				videoFullRangeFlag: 1,
				chromaSubsamplingX: 0,
				chromaSubsamplingY: 0,
			},
		],
	] as [string, Av1SequenceHeaderOptions, object][])('reads %s', (_, options, expected) => {
		expect(info(options)).toEqual({ ...base, ...expected });
	});

	test('takes level and tier from the first operating point, past timing and decoder model info', () => {
		expect(info({
			profile: 0,
			level: 13,
			tier: 1,
			timing: { equalPictureInterval: 5, decoderModel: { bufferDelayLengthMinus1: 9 } },
			initialDisplayDelay: true,
			extraOperatingPoints: [[4, 0], [12, 0]],
			colour: [1, 1, 1],
		})).toEqual({
			...base,
			level: 13,
			tier: 1,
			colourPrimaries: 1,
			transferCharacteristics: 1,
			matrixCoefficients: 1,
		});

		// A level of 7 or below has no tier bit
		expect(info({ profile: 0, level: 5, timing: {}, colour: [6, 6, 6] }))
			.toEqual({ ...base, level: 5, colourPrimaries: 6, transferCharacteristics: 6, matrixCoefficients: 6 });
	});

	test('handles reduced still picture headers, frame ID numbers and the screen content tool variants', () => {
		expect(info({ profile: 0, reducedStillPicture: true, level: 9, colour: [1, 1, 1] }))
			.toEqual({ ...base, level: 9, colourPrimaries: 1, transferCharacteristics: 1, matrixCoefficients: 1 });
		for (const screenContent of ['off', 'on', 'select'] as const) {
			expect(info({ profile: 0, frameIdNumbers: true, orderHint: false, screenContent, colour: [5, 6, 7] }))
				.toEqual({ ...base, colourPrimaries: 5, transferCharacteristics: 6, matrixCoefficients: 7 });
		}
	});

	test('no sequence header, no info; colour info is only reported when present', () => {
		expect(extractAv1CodecInfoFromPacket(new Uint8Array([0x12, 0x00, 0x32, 0x01, 0x00]))).toBe(null);
		expect(av1CodecInfoHasColorInfo(base)).toBe(false);
		expect(av1CodecInfoHasColorInfo({ ...base, colourPrimaries: 1 })).toBe(true);
		expect(av1CodecInfoHasColorInfo({ ...base, transferCharacteristics: 16 })).toBe(true);
		expect(av1CodecInfoHasColorInfo({ ...base, matrixCoefficients: 9 })).toBe(true);
	});
});

describe('AVC and HEVC decoder configuration records', () => {
	const pps = new Uint8Array([0x68, 0xce, 0x38, 0x80]);
	const idr = new Uint8Array([0x65, 0x88, 0x84]);

	test('a High profile record carries chroma format, bit depths and SPS extensions, and round-trips', () => {
		const sps = buildAvcSps({
			profileIdc: 100,
			chromaFormatIdc: 1,
			bitDepthLuma: 10,
			bitDepthChroma: 10,
			widthInMbs: 20,
			heightInMapUnits: 15,
		});
		const spsExt = new Uint8Array([0x6d, 0x11, 0x22]);
		const record = extractAvcDecoderConfigurationRecord(annexB(sps, pps, spsExt, idr))!;
		expect(record).toMatchObject({
			configurationVersion: 1,
			avcProfileIndication: 100,
			lengthSizeMinusOne: 3,
			chromaFormat: 1,
			bitDepthLumaMinus8: 2,
			bitDepthChromaMinus8: 2,
		});
		expect(record.sequenceParameterSets.map(x => [...x])).toEqual([[...sps]]);
		expect(record.pictureParameterSets.map(x => [...x])).toEqual([[...pps]]);
		expect(record.sequenceParameterSetExt!.map(x => [...x])).toEqual([[...spsExt]]);

		const bytes = serializeAvcDecoderConfigurationRecord(record);
		expect(bytes[4]).toBe(0xff); // reserved bits + lengthSizeMinusOne
		expect(bytes[5]).toBe(0xe1); // reserved bits + one SPS
		const roundTripped = deserializeAvcDecoderConfigurationRecord(bytes)!;
		expect({ ...roundTripped, sequenceParameterSets: 0, pictureParameterSets: 0, sequenceParameterSetExt: 0 })
			.toEqual({ ...record, sequenceParameterSets: 0, pictureParameterSets: 0, sequenceParameterSetExt: 0 });
		expect(roundTripped.sequenceParameterSetExt!.map(x => [...x])).toEqual([[...spsExt]]);

		// Without the trailing extension bytes, the extension fields are absent
		const truncated = deserializeAvcDecoderConfigurationRecord(bytes.subarray(0, bytes.length - 9))!;
		expect([truncated.chromaFormat, truncated.sequenceParameterSetExt]).toEqual([null, null]);
	});

	test('a Baseline record has no extension fields; records need both an SPS and a PPS', () => {
		const sps = buildAvcSps({ profileIdc: 66, widthInMbs: 20, heightInMapUnits: 15 });
		const record = extractAvcDecoderConfigurationRecord(annexB(sps, pps, new Uint8Array([0x6d, 0x01]), idr))!;
		const { avcProfileIndication, chromaFormat, sequenceParameterSetExt } = record;
		expect([avcProfileIndication, chromaFormat, sequenceParameterSetExt]).toEqual([66, null, null]);
		const bytes = serializeAvcDecoderConfigurationRecord(record);
		expect(bytes.length).toBe(6 + 2 + sps.length + 1 + 2 + pps.length);
		const parsed = deserializeAvcDecoderConfigurationRecord(bytes)!;
		expect(parsed.pictureParameterSets.map(x => [...x])).toEqual([[...pps]]);

		expect(extractAvcDecoderConfigurationRecord(annexB(sps, idr))).toBe(null);
		expect(extractAvcDecoderConfigurationRecord(annexB(pps, idr))).toBe(null);
	});

	test('an HEVC record round-trips through serialization', () => {
		const vps = new Uint8Array([0x40, 0x01, 0x0c, 0x01, 0xff, 0xff]);
		const sps = buildHevcSps({
			width: 1280,
			height: 720,
			tierFlag: 1,
			levelIdc: 120,
			maxSubLayersMinus1: 1,
			vui: { minSpatialSegmentationIdc: 3 },
		});
		const record = extractHevcDecoderConfigurationRecord(annexB(vps, sps, buildHevcPps(false, true), hevcNal(19)))!;
		const bytes = serializeHevcDecoderConfigurationRecord(record);
		const roundTripped = deserializeHevcDecoderConfigurationRecord(bytes)!;
		const simplify = (r: typeof record) => ({
			...r,
			generalConstraintIndicatorFlags: [...r.generalConstraintIndicatorFlags],
			arrays: r.arrays.map(a => ({ ...a, nalUnits: a.nalUnits.map(x => [...x]) })),
		});
		expect(simplify(roundTripped)).toEqual(simplify(record));
		expect(roundTripped).toMatchObject({
			generalTierFlag: 1,
			generalLevelIdc: 120,
			minSpatialSegmentationIdc: 3,
			parallelismType: 3,
			numTemporalLayers: 2,
			lengthSizeMinusOne: 3,
		});
	});
});

describe('AC-3 and E-AC-3 headers', () => {
	type Ac3Fields = {
		fscod?: number;
		frmsizecod?: number;
		bsid?: number;
		bsmod?: number;
		acmod: number;
		lfeon: number;
	};
	const ac3Header = (fields: Ac3Fields) => {
		const w = new BitWriter()
			.writeBits(16, 0x0b77)
			.writeBits(16, 0) // crc1
			.writeBits(2, fields.fscod ?? 0)
			.writeBits(6, fields.frmsizecod ?? 28)
			.writeBits(5, fields.bsid ?? 8)
			.writeBits(3, fields.bsmod ?? 0)
			.writeBits(3, fields.acmod);
		if ((fields.acmod & 1) && fields.acmod !== 1) {
			w.writeBits(2, 0b01); // cmixlev
		}
		if (fields.acmod & 4) {
			w.writeBits(2, 0b10); // surmixlev
		}
		if (fields.acmod === 2) {
			w.writeBits(2, 0b11); // dsurmod
		}
		w.writeBits(1, fields.lfeon).writeBits(5, 27).writeBits(16, 0);
		return w.toBytes();
	};

	test.each([0, 1, 2, 3, 4, 5, 6, 7])('reads acmod %i and the LFE flag past the optional mix levels', (acmod) => {
		for (const lfeon of [0, 1]) {
			const info = parseAc3SyncFrame(ac3Header({ acmod, lfeon, bsmod: 5, frmsizecod: 29, fscod: 1, bsid: 6 }));
			expect(info).toEqual({ fscod: 1, bsid: 6, bsmod: 5, acmod, lfeon, bitRateCode: 14 });
		}
	});

	test('rejects bad sync words, reserved sample rates, E-AC-3 bitstream IDs and short data', () => {
		expect(parseAc3SyncFrame(ac3Header({ acmod: 2, lfeon: 0, fscod: 3 }))).toBe(null);
		expect(parseAc3SyncFrame(ac3Header({ acmod: 2, lfeon: 0, bsid: 9 }))).toBe(null);
		const badSync = ac3Header({ acmod: 2, lfeon: 0 });
		badSync[1] = 0x78;
		expect(parseAc3SyncFrame(badSync)).toBe(null);
		expect(parseAc3SyncFrame(ac3Header({ acmod: 2, lfeon: 0 }).subarray(0, 6))).toBe(null);
	});

	type Eac3Fields = {
		strmtyp?: number;
		frmsiz: number;
		fscod: number;
		fscod2OrBlocks: number;
		acmod: number;
		lfeon: number;
		bsid?: number;
	};
	const eac3Header = (fields: Eac3Fields) => {
		return new BitWriter()
			.writeBits(16, 0x0b77)
			.writeBits(2, fields.strmtyp ?? 0)
			.writeBits(3, 0) // substreamid
			.writeBits(11, fields.frmsiz)
			.writeBits(2, fields.fscod)
			.writeBits(2, fields.fscod2OrBlocks)
			.writeBits(3, fields.acmod)
			.writeBits(1, fields.lfeon)
			.writeBits(5, fields.bsid ?? 16)
			.writeBits(16, 0)
			.toBytes();
	};

	test('E-AC-3 sync frames give the data rate, sample rate and channel count', () => {
		// 48 kHz, 6 blocks, frmsiz 767 (1536 bytes): 1536 * 8 bits per 1536 samples at 48 kHz = 384 kbps
		const full = parseEac3SyncFrame(eac3Header({ frmsiz: 767, fscod: 0, fscod2OrBlocks: 3, acmod: 7, lfeon: 1 }))!;
		expect(full.dataRate).toBe(384);
		expect(full.substreams).toEqual([
			{ fscod: 0, fscod2: 0, bsid: 16, bsmod: 0, acmod: 7, lfeon: 1, numDepSub: 0, chanLoc: 0 },
		]);
		expect([getEac3SampleRate(full), getEac3ChannelCount(full)]).toEqual([48000, 6]);

		// One block per frame at 44.1 kHz
		const oneBlock = parseEac3SyncFrame(eac3Header({
			frmsiz: 127,
			fscod: 1,
			fscod2OrBlocks: 0,
			acmod: 2,
			lfeon: 0,
			bsid: 11,
		}))!;
		expect(oneBlock.dataRate).toBe(Math.round(128 * 44.1 / 16));
		expect([getEac3SampleRate(oneBlock), getEac3ChannelCount(oneBlock)]).toEqual([44100, 2]);

		// fscod 3 switches to the reduced sample rates, with 6 blocks implied
		const reduced = parseEac3SyncFrame(eac3Header({
			frmsiz: 383,
			fscod: 3,
			fscod2OrBlocks: 1,
			acmod: 1,
			lfeon: 0,
		}))!;
		expect(reduced.substreams[0]!.fscod2).toBe(1);
		expect(reduced.dataRate).toBe(Math.round(384 * 22.05 / 96));
		expect([getEac3SampleRate(reduced), getEac3ChannelCount(reduced)]).toEqual([22050, 1]);

		expect(parseEac3SyncFrame(eac3Header({
			strmtyp: 1,
			frmsiz: 767,
			fscod: 0,
			fscod2OrBlocks: 3,
			acmod: 2,
			lfeon: 0,
		}))).toBe(null);
		expect(parseEac3SyncFrame(eac3Header({
			frmsiz: 767,
			fscod: 0,
			fscod2OrBlocks: 3,
			acmod: 2,
			lfeon: 0,
			bsid: 8,
		}))).toBe(null);
		expect(parseEac3SyncFrame(eac3Header({
			frmsiz: 767,
			fscod: 0,
			fscod2OrBlocks: 3,
			acmod: 2,
			lfeon: 0,
			bsid: 17,
		}))).toBe(null);
		expect(parseEac3SyncFrame(new Uint8Array([0x0b, 0x77, 0, 0, 0]))).toBe(null);
	});

	test('dec3 boxes with dependent substreams add their channel locations', () => {
		const dec3 = new BitWriter()
			.writeBits(13, 640) // data rate
			.writeBits(3, 1) // two independent substreams
			// First: 48 kHz, 5.1 with a dependent substream carrying a channel pair (the middle chan_loc bit, Lsd/Rsd)
			.writeBits(2, 0).writeBits(5, 16).writeBits(1, 0).writeBits(1, 0).writeBits(3, 2)
			.writeBits(3, 7).writeBits(1, 1).writeBits(3, 0).writeBits(4, 1).writeBits(9, 0b0_0001_0000)
			// Second: stereo, no dependent substreams
			.writeBits(2, 0).writeBits(5, 16).writeBits(1, 0).writeBits(1, 0).writeBits(3, 0)
			.writeBits(3, 2).writeBits(1, 0).writeBits(3, 0).writeBits(4, 0).writeBits(1, 0)
			.toBytes();
		const config = parseEac3Config(dec3)!;
		expect(config.dataRate).toBe(640);
		expect(config.substreams).toEqual([
			{ fscod: 0, fscod2: null, bsid: 16, bsmod: 2, acmod: 7, lfeon: 1, numDepSub: 1, chanLoc: 0b0_0001_0000 },
			{ fscod: 0, fscod2: null, bsid: 16, bsmod: 0, acmod: 2, lfeon: 0, numDepSub: 0, chanLoc: 0 },
		]);
		expect([getEac3SampleRate(config), getEac3ChannelCount(config)]).toEqual([48000, 8]);

		// A truncated second substream is dropped; no substream at all is no config
		expect(parseEac3Config(dec3.subarray(0, 6))!.substreams.length).toBe(1);
		expect(parseEac3Config(new Uint8Array([0x50, 0x00]))).toBe(null);
		expect(parseEac3Config(new Uint8Array([0x50]))).toBe(null);
	});
});
