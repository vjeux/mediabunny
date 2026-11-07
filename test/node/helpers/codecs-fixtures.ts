// Header data written by real encoders, together with what FFmpeg reads from the same bytes (ffprobe for sizes,
// aspect ratios and colors, the trace_headers bitstream filter for the syntax elements).

export const hexToBytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map(x => parseInt(x, 16)));

export type AvcSpsFixture = {
	name: string;
	/** x264 options after `ffmpeg -f lavfi -i testsrc2=size=WxH:rate=25 -frames:v 1 -c:v libx264` */
	args: string;
	sps: string;
	pps: string;
	expected: {
		profileIdc: number;
		levelIdc: number;
		constraintFlags: number;
		chromaFormatIdc: number;
		bitDepthLumaMinus8: number;
		bitDepthChromaMinus8: number;
		displayWidth: number;
		displayHeight: number;
		pixelAspectRatio: { num: number; den: number };
		colourPrimaries: number;
		transferCharacteristics: number;
		matrixCoefficients: number;
		fullRangeFlag: number;
		numReorderFrames: number;
		maxDecFrameBuffering: number;
	};
};

export const AVC_SPS_FIXTURES: AvcSpsFixture[] = [
	{
		name: 'avc_baseline_320x240',
		args: 'size=320x240: -profile:v baseline -pix_fmt yuv420p',
		sps: '6742c00dd90141fb011000000300100000030320f142a480',
		pps: '68cb83cb20',
		expected: {
			profileIdc: 66, levelIdc: 13, constraintFlags: 0xc0,
			chromaFormatIdc: 1, bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			displayWidth: 320, displayHeight: 240, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0, numReorderFrames: 0, maxDecFrameBuffering: 3,
		},
	},
	{
		name: 'avc_main_640x360',
		args: 'size=640x360: -profile:v main -pix_fmt yuv420p',
		sps: '674d401eeca05017fcb808800000030080000019078b16cb',
		pps: '68ebe3cb20',
		expected: {
			profileIdc: 77, levelIdc: 30, constraintFlags: 0x40,
			chromaFormatIdc: 1, bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			displayWidth: 640, displayHeight: 360, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0, numReorderFrames: 2, maxDecFrameBuffering: 4,
		},
	},
	{
		name: 'avc_high_1920x1080',
		args: 'size=1920x1080: -profile:v high -pix_fmt yuv420p',
		sps: '67640028acd940780227e5c044000003000400000300c83c60c658',
		pps: '68ebe3cb22c0',
		expected: {
			profileIdc: 100, levelIdc: 40, constraintFlags: 0x00,
			chromaFormatIdc: 1, bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			displayWidth: 1920, displayHeight: 1080, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0, numReorderFrames: 2, maxDecFrameBuffering: 4,
		},
	},
	{
		name: 'avc_high10_1280x720',
		args: 'size=1280x720: -pix_fmt yuv420p10le',
		sps: '676e001fa6cd9405005bb011000003000100000300320f183196',
		pps: '68ebe3cb22c0',
		expected: {
			profileIdc: 110, levelIdc: 31, constraintFlags: 0x00,
			chromaFormatIdc: 1, bitDepthLumaMinus8: 2, bitDepthChromaMinus8: 2,
			displayWidth: 1280, displayHeight: 720, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0, numReorderFrames: 2, maxDecFrameBuffering: 4,
		},
	},
	{
		name: 'avc_high422_720x486',
		args: 'size=720x486: -pix_fmt yuv422p',
		sps: '677a001ebcd940b43ff8bc0440000003004000000c83c58b6580',
		pps: '68ebe3cb22c0',
		expected: {
			profileIdc: 122, levelIdc: 30, constraintFlags: 0x00,
			chromaFormatIdc: 2, bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			displayWidth: 720, displayHeight: 486, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0, numReorderFrames: 2, maxDecFrameBuffering: 4,
		},
	},
	{
		name: 'avc_high444_350x198',
		args: 'size=350x198: -pix_fmt yuv444p',
		sps: '67f4000d919b282c37dc5e0220000003002000000641e28532c0',
		pps: '68ebe3c44844',
		expected: {
			profileIdc: 244, levelIdc: 13, constraintFlags: 0x00,
			chromaFormatIdc: 3, bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			displayWidth: 350, displayHeight: 198, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0, numReorderFrames: 2, maxDecFrameBuffering: 4,
		},
	},
	{
		name: 'avc_gray_176x144',
		args: 'size=176x144: -pix_fmt gray',
		sps: '6764000bf3650b13b016c80000030008000003019078a14cb0',
		pps: '68ebe3cb22c0',
		expected: {
			profileIdc: 100, levelIdc: 11, constraintFlags: 0x00,
			chromaFormatIdc: 0, bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			displayWidth: 176, displayHeight: 144, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 1, numReorderFrames: 2, maxDecFrameBuffering: 4,
		},
	},
	{
		name: 'avc_hdr_pq_full_range',
		args: 'size=640x480: -pix_fmt yuv420p10le -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc'
			+ ' -color_range pc',
		sps: '676e001ea6cd940a03db016e122012800000030080000019078b16cb',
		pps: '68ebe3cb22c0',
		expected: {
			profileIdc: 110, levelIdc: 30, constraintFlags: 0x00,
			chromaFormatIdc: 1, bitDepthLumaMinus8: 2, bitDepthChromaMinus8: 2,
			displayWidth: 640, displayHeight: 480, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 9, transferCharacteristics: 16, matrixCoefficients: 9,
			fullRangeFlag: 1, numReorderFrames: 2, maxDecFrameBuffering: 4,
		},
	},
	{
		name: 'avc_bt601_sar_40_33',
		args: 'size=704x576: -pix_fmt yuv420p -vf setsar=40/33 -color_primaries bt470bg -color_trc smpte170m'
			+ ' -colorspace bt470bg',
		sps: '6764001eacd940b0126c15a828302a000003000200000300641e2c5b2c',
		pps: '68ebe3cb22c0',
		expected: {
			profileIdc: 100, levelIdc: 30, constraintFlags: 0x00,
			chromaFormatIdc: 1, bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			displayWidth: 704, displayHeight: 576, pixelAspectRatio: { num: 40, den: 33 },
			colourPrimaries: 5, transferCharacteristics: 6, matrixCoefficients: 5,
			fullRangeFlag: 0, numReorderFrames: 2, maxDecFrameBuffering: 4,
		},
	},
	{
		name: 'avc_extended_sar_7_5',
		args: 'size=640x480: -pix_fmt yuv420p -vf setsar=7/5',
		sps: '6764001eacd940a03dbff000700051000003000100000300320f162d96',
		pps: '68ebe3cb22c0',
		expected: {
			profileIdc: 100, levelIdc: 30, constraintFlags: 0x00,
			chromaFormatIdc: 1, bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			displayWidth: 640, displayHeight: 480, pixelAspectRatio: { num: 7, den: 5 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0, numReorderFrames: 2, maxDecFrameBuffering: 4,
		},
	},
	{
		name: 'avc_cqm_jvt_scaling_lists',
		args: 'size=320x240: -pix_fmt yuv420p -x264-params cqm=jvt',
		sps: '6764000dacd94141fb011000000300100000030320f1429960',
		pps: '68ebe3cb3002c0',
		expected: {
			profileIdc: 100, levelIdc: 13, constraintFlags: 0x00,
			chromaFormatIdc: 1, bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			displayWidth: 320, displayHeight: 240, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0, numReorderFrames: 2, maxDecFrameBuffering: 4,
		},
	},
	{
		name: 'avc_cqm_jvt_444',
		args: 'size=320x240: -pix_fmt yuv444p -x264-params cqm=jvt',
		sps: '67f4000d919b28283f6022000003000200000300641e28532c',
		pps: '68ebe3c44c000440',
		expected: {
			profileIdc: 244, levelIdc: 13, constraintFlags: 0x00,
			chromaFormatIdc: 3, bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			displayWidth: 320, displayHeight: 240, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0, numReorderFrames: 2, maxDecFrameBuffering: 4,
		},
	},
	{
		name: 'avc_no_bframes',
		args: 'size=320x240: -pix_fmt yuv420p -bf 0',
		sps: '6764000dacb20283f60220000003002000000641e28549',
		pps: '68ebc3cb22c0',
		expected: {
			profileIdc: 100, levelIdc: 13, constraintFlags: 0x00,
			chromaFormatIdc: 1, bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			displayWidth: 320, displayHeight: 240, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0, numReorderFrames: 0, maxDecFrameBuffering: 3,
		},
	},
	{
		name: 'avc_hlg_bt2020',
		args: 'size=320x240: -pix_fmt yuv420p10le -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc',
		sps: '676e000da6cd94141fb016a12241280000030008000003019078a14cb0',
		pps: '68ebe3cb22c0',
		expected: {
			profileIdc: 110, levelIdc: 13, constraintFlags: 0x00,
			chromaFormatIdc: 1, bitDepthLumaMinus8: 2, bitDepthChromaMinus8: 2,
			displayWidth: 320, displayHeight: 240, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 9, transferCharacteristics: 18, matrixCoefficients: 9,
			fullRangeFlag: 0, numReorderFrames: 2, maxDecFrameBuffering: 4,
		},
	},
];

export type HevcSpsFixture = {
	name: string;
	/** x265 options after `ffmpeg -f lavfi -i testsrc2=size=WxH:rate=25 -frames:v 1 -c:v libx265` */
	args: string;
	vps: string;
	sps: string;
	pps: string;
	expected: {
		generalProfileIdc: number;
		generalTierFlag: number;
		generalLevelIdc: number;
		/** Indices j of the set general_profile_compatibility_flag[j] */
		compatibleProfiles: number[];
		chromaFormatIdc: number;
		bitDepthLumaMinus8: number;
		bitDepthChromaMinus8: number;
		spsMaxSubLayersMinus1: number;
		spsTemporalIdNestingFlag: number;
		spsMaxNumReorderPics: number;
		entropyCodingSyncEnabled: number;
		displayWidth: number;
		displayHeight: number;
		pixelAspectRatio: { num: number; den: number };
		colourPrimaries: number;
		transferCharacteristics: number;
		matrixCoefficients: number;
		fullRangeFlag: number;
	};
};

export const HEVC_SPS_FIXTURES: HevcSpsFixture[] = [
	{
		name: 'hevc_main_1920x1080',
		args: 'size=1920x1080: -x265-params log-level=error -pix_fmt yuv420p',
		vps: '40010c01ffff016000000300900000030000030078959809',
		sps: '420101016000000300900000030000030078a003c08010e596566924caf0168080000003008000000c84',
		pps: '4401c172b46240',
		expected: {
			generalProfileIdc: 1, generalTierFlag: 0, generalLevelIdc: 120,
			compatibleProfiles: [1, 2], chromaFormatIdc: 1,
			bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			spsMaxSubLayersMinus1: 0, spsTemporalIdNestingFlag: 1,
			spsMaxNumReorderPics: 2, entropyCodingSyncEnabled: 1,
			displayWidth: 1920, displayHeight: 1080, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0,
		},
	},
	{
		name: 'hevc_main10_1280x720',
		args: 'size=1280x720: -x265-params log-level=error -pix_fmt yuv420p10le',
		vps: '40010c01ffff02200000030090000003000003005d959809',
		sps: '42010102200000030090000003000003005da00280802d1365959a4932bc05a02000000300200000030321',
		pps: '4401c172b46240',
		expected: {
			generalProfileIdc: 2, generalTierFlag: 0, generalLevelIdc: 93,
			compatibleProfiles: [2], chromaFormatIdc: 1,
			bitDepthLumaMinus8: 2, bitDepthChromaMinus8: 2,
			spsMaxSubLayersMinus1: 0, spsTemporalIdNestingFlag: 1,
			spsMaxNumReorderPics: 2, entropyCodingSyncEnabled: 1,
			displayWidth: 1280, displayHeight: 720, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0,
		},
	},
	{
		name: 'hevc_rext_422_10_350x198',
		args: 'size=350x198: -x265-params log-level=error -pix_fmt yuv422p10le',
		vps: '40010c01ffff0408000003009d0800000300003c959809',
		sps: '4201010408000003009d0800000300003cb00b080c9d5b65959a4932bc05a02000000300200000030321',
		pps: '4401c172b46240',
		expected: {
			generalProfileIdc: 4, generalTierFlag: 0, generalLevelIdc: 60,
			compatibleProfiles: [4], chromaFormatIdc: 2,
			bitDepthLumaMinus8: 2, bitDepthChromaMinus8: 2,
			spsMaxSubLayersMinus1: 0, spsTemporalIdNestingFlag: 1,
			spsMaxNumReorderPics: 2, entropyCodingSyncEnabled: 1,
			displayWidth: 350, displayHeight: 198, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0,
		},
	},
	{
		name: 'hevc_rext_444_8_352x200',
		args: 'size=352x200: -x265-params log-level=error -pix_fmt yuv444p',
		vps: '40010c01ffff0408000003009e0800000300003c959809',
		sps: '4201010408000003009e0800000300003c9001610192cb2b349265780b4040000003004000000642',
		pps: '4401c172860c4624',
		expected: {
			generalProfileIdc: 4, generalTierFlag: 0, generalLevelIdc: 60,
			compatibleProfiles: [4], chromaFormatIdc: 3,
			bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			spsMaxSubLayersMinus1: 0, spsTemporalIdNestingFlag: 1,
			spsMaxNumReorderPics: 2, entropyCodingSyncEnabled: 1,
			displayWidth: 352, displayHeight: 200, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0,
		},
	},
	{
		name: 'hevc_gray_176x144',
		args: 'size=176x144: -x265-params log-level=error -pix_fmt gray',
		vps: '40010c01ffff0408000003009fc800000300003c959809',
		sps: '4201010408000003009fc800000300003cc058809165959a4932bc05b02000000300200000030321',
		pps: '4401c172b46240',
		expected: {
			generalProfileIdc: 4, generalTierFlag: 0, generalLevelIdc: 60,
			compatibleProfiles: [4], chromaFormatIdc: 0,
			bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			spsMaxSubLayersMinus1: 0, spsTemporalIdNestingFlag: 1,
			spsMaxNumReorderPics: 2, entropyCodingSyncEnabled: 1,
			displayWidth: 176, displayHeight: 144, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 1,
		},
	},
	{
		name: 'hevc_hdr10_full_range',
		args: 'size=640x480: -x265-params log-level=error -pix_fmt yuv420p10le -color_primaries bt2020'
			+ ' -color_trc smpte2084 -colorspace bt2020nc -color_range pc',
		vps: '40010c01ffff02200000030090000003000003005a959809',
		sps: '42010102200000030090000003000003005aa0050201e1365959a4932bc05b848804820000030002000003003210',
		pps: '4401c172b46240',
		expected: {
			generalProfileIdc: 2, generalTierFlag: 0, generalLevelIdc: 90,
			compatibleProfiles: [2], chromaFormatIdc: 1,
			bitDepthLumaMinus8: 2, bitDepthChromaMinus8: 2,
			spsMaxSubLayersMinus1: 0, spsTemporalIdNestingFlag: 1,
			spsMaxNumReorderPics: 2, entropyCodingSyncEnabled: 1,
			displayWidth: 640, displayHeight: 480, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 9, transferCharacteristics: 16, matrixCoefficients: 9,
			fullRangeFlag: 1,
		},
	},
	{
		name: 'hevc_sar_16_11',
		args: 'size=720x576: -x265-params log-level=error -pix_fmt yuv420p -vf setsar=16/11',
		vps: '40010c01ffff01600000030090000003000003005a959809',
		sps: '42010101600000030090000003000003005aa005a20090596566924caf046808000003000800000300c840',
		pps: '4401c172b46240',
		expected: {
			generalProfileIdc: 1, generalTierFlag: 0, generalLevelIdc: 90,
			compatibleProfiles: [1, 2], chromaFormatIdc: 1,
			bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			spsMaxSubLayersMinus1: 0, spsTemporalIdNestingFlag: 1,
			spsMaxNumReorderPics: 2, entropyCodingSyncEnabled: 1,
			displayWidth: 720, displayHeight: 576, pixelAspectRatio: { num: 16, den: 11 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0,
		},
	},
	{
		name: 'hevc_extended_sar_7_5',
		args: 'size=640x480: -x265-params log-level=error -pix_fmt yuv420p -vf setsar=7/5',
		vps: '40010c01ffff01600000030090000003000003005a959809',
		sps: '42010101600000030090000003000003005aa0050201e165959a4932bffc001c0015a02000000300200000030321',
		pps: '4401c172b46240',
		expected: {
			generalProfileIdc: 1, generalTierFlag: 0, generalLevelIdc: 90,
			compatibleProfiles: [1, 2], chromaFormatIdc: 1,
			bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			spsMaxSubLayersMinus1: 0, spsTemporalIdNestingFlag: 1,
			spsMaxNumReorderPics: 2, entropyCodingSyncEnabled: 1,
			displayWidth: 640, displayHeight: 480, pixelAspectRatio: { num: 7, den: 5 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0,
		},
	},
	{
		name: 'hevc_temporal_layers',
		args: 'size=320x240: -pix_fmt yuv420p -x265-params log-level=error:temporal-layers=1:b-adapt=0:bframes=3',
		vps: '40010c02ffff01600000030090000003000003003c00009594aca048',
		sps: '42010201600000030090000003000003003c0000a00a080f1659594acb24995e02d0100000030010000003019080',
		pps: '4401c172b46240',
		expected: {
			generalProfileIdc: 1, generalTierFlag: 0, generalLevelIdc: 60,
			compatibleProfiles: [1, 2], chromaFormatIdc: 1,
			bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			spsMaxSubLayersMinus1: 1, spsTemporalIdNestingFlag: 0,
			spsMaxNumReorderPics: 2, entropyCodingSyncEnabled: 1,
			displayWidth: 320, displayHeight: 240, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0,
		},
	},
	{
		name: 'hevc_high_tier',
		args: 'size=1920x1080: -pix_fmt yuv420p -x265-params log-level=error:level-idc=5.1:high-tier=1',
		vps: '40010c01ffff216000000300900000030000030099959809',
		sps: '420101216000000300900000030000030099a003c08010e596566924caf0168080000003008000000c84',
		pps: '4401c172b46240',
		expected: {
			generalProfileIdc: 1, generalTierFlag: 1, generalLevelIdc: 153,
			compatibleProfiles: [1, 2], chromaFormatIdc: 1,
			bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			spsMaxSubLayersMinus1: 0, spsTemporalIdNestingFlag: 1,
			spsMaxNumReorderPics: 2, entropyCodingSyncEnabled: 1,
			displayWidth: 1920, displayHeight: 1080, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0,
		},
	},
	{
		name: 'hevc_hrd_vui',
		args: 'size=320x240: -pix_fmt yuv420p -x265-params log-level=error:hrd=1:vbv-bufsize=1000:vbv-maxrate=1000',
		vps: '40010c01ffff01600000030090000003000003003c959809',
		sps: '42010101600000030090000003000003003ca00a080f165959a4932bc05a0200000300020000030032c0292cbc001e848003d091',
		pps: '4401c172b46240',
		expected: {
			generalProfileIdc: 1, generalTierFlag: 0, generalLevelIdc: 60,
			compatibleProfiles: [1, 2], chromaFormatIdc: 1,
			bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0,
			spsMaxSubLayersMinus1: 0, spsTemporalIdNestingFlag: 1,
			spsMaxNumReorderPics: 2, entropyCodingSyncEnabled: 1,
			displayWidth: 320, displayHeight: 240, pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2,
			fullRangeFlag: 0,
		},
	},
];
export type Av1Fixture = {
	name: string;
	/** Options after `ffmpeg -f lavfi -i testsrc2=size=176x144:rate=25 -frames:v 3 -c:v libaom-av1 -cpu-used 8` */
	args: string;
	/** The first four bytes of the av1C box FFmpeg writes into MP4 */
	av1cHeader: string;
	/** The configOBUs of that av1C box, i.e. the sequence header OBU */
	sequenceHeaderObu: string;
	expected: {
		profile: number;
		level: number;
		tier: number;
		bitDepth: number;
		monochrome: number;
		chromaSubsamplingX: number;
		chromaSubsamplingY: number;
		chromaSamplePosition: number;
		videoFullRangeFlag: number;
		colourPrimaries: number;
		transferCharacteristics: number;
		matrixCoefficients: number;
	};
};

const av1Info = (
	profile: number,
	bitDepth: number,
	monochrome: number,
	subsampling: [number, number],
	videoFullRangeFlag: number,
	colors: [number, number, number],
) => ({
	profile,
	level: 0,
	tier: 0,
	bitDepth,
	monochrome,
	chromaSubsamplingX: subsampling[0],
	chromaSubsamplingY: subsampling[1],
	chromaSamplePosition: 0,
	videoFullRangeFlag,
	colourPrimaries: colors[0],
	transferCharacteristics: colors[1],
	matrixCoefficients: colors[2],
});

export const AV1_FIXTURES: Av1Fixture[] = [
	{
		name: 'av1_main_8bit',
		args: '-pix_fmt yuv420p',
		av1cHeader: '81000c00',
		sequenceHeaderObu: '0a0b00000003bd7c79b5f20080',
		expected: av1Info(0, 8, 0, [1, 1], 0, [2, 2, 2]),
	},
	{
		name: 'av1_main_10bit_pq',
		args: '-pix_fmt yuv420p10le -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -color_range tv',
		av1cHeader: '81004c00',
		sequenceHeaderObu: '0a0e00000003bd7c79b5f2a122012080',
		expected: av1Info(0, 10, 0, [1, 1], 0, [9, 16, 9]),
	},
	{
		name: 'av1_high_444',
		args: '-pix_fmt yuv444p',
		av1cHeader: '81200000',
		sequenceHeaderObu: '0a0a20000003bd7c79b5f204',
		expected: av1Info(1, 8, 0, [0, 0], 0, [2, 2, 2]),
	},
	{
		name: 'av1_professional_422',
		args: '-pix_fmt yuv422p',
		av1cHeader: '81400800',
		sequenceHeaderObu: '0a0a40000003bd7c79b5f202',
		expected: av1Info(2, 8, 0, [1, 0], 0, [2, 2, 2]),
	},
	{
		name: 'av1_professional_12bit',
		args: '-pix_fmt yuv420p12le',
		av1cHeader: '81406c00',
		sequenceHeaderObu: '0a0b40000003bd7c79b5f2c610',
		expected: av1Info(2, 12, 0, [1, 1], 0, [2, 2, 2]),
	},
	{
		name: 'av1_monochrome',
		args: '-pix_fmt gray',
		av1cHeader: '81001c00',
		sequenceHeaderObu: '0a0a00000003bd7c79b5f254',
		expected: av1Info(0, 8, 1, [1, 1], 1, [2, 2, 2]),
	},
	{
		name: 'av1_srgb',
		args: '-pix_fmt gbrp',
		av1cHeader: '81200000',
		sequenceHeaderObu: '0a0d20000003bd7c79b5f240434008',
		expected: av1Info(1, 8, 0, [0, 0], 1, [1, 13, 0]),
	},
];

export type Vp9Fixture = {
	name: string;
	/** Options after `ffmpeg -f lavfi -i testsrc2=size=WxH:rate=25 -frames:v 1 -c:v libvpx-vp9 -deadline realtime` */
	args: string;
	/** The start of the first (key) frame */
	keyFrameStart: string;
	expected: {
		profile: number;
		bitDepth: number;
		chromaSubsampling: number;
		videoFullRangeFlag: number;
		colourPrimaries: number;
		transferCharacteristics: number;
		matrixCoefficients: number;
		level: number;
	};
	/** Primaries and transfer that are just as correct when the color space only determines the matrix */
	alsoAcceptedPrimariesAndTransfer?: [number, number];
};

export const VP9_FIXTURES: Vp9Fixture[] = [
	{
		name: 'vp9_profile0_unknown_color_space',
		args: 'size=176x144: -pix_fmt yuv420p',
		keyFrameStart: '82498342000af008f60038241c184a00',
		// color_space = CS_UNKNOWN
		expected: {
			profile: 0, bitDepth: 8, chromaSubsampling: 1, videoFullRangeFlag: 0,
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2, level: 10,
		},
	},
	{
		name: 'vp9_profile0_bt709',
		args: 'size=176x144: -pix_fmt yuv420p -colorspace bt709',
		keyFrameStart: '82498342400af008f60038241c184a00',
		expected: {
			profile: 0, bitDepth: 8, chromaSubsampling: 1, videoFullRangeFlag: 0,
			colourPrimaries: 1, transferCharacteristics: 1, matrixCoefficients: 1, level: 10,
		},
	},
	{
		name: 'vp9_profile0_bt601_full_range',
		args: 'size=176x144: -pix_fmt yuv420p -colorspace bt470bg -color_range pc',
		keyFrameStart: '82498342300af008f60038241c184a00',
		// color_space = CS_BT_601, color_range = 1. BT.601 has both 625-line (BT.470BG) and 525-line (SMPTE 170M)
		// systems, so only the matrix is certain: primaries and transfer may be either of them or unspecified (2, as
		// in FFmpeg).
		expected: {
			profile: 0, bitDepth: 8, chromaSubsampling: 1, videoFullRangeFlag: 1,
			colourPrimaries: 5, transferCharacteristics: 6, matrixCoefficients: 5, level: 10,
		},
		alsoAcceptedPrimariesAndTransfer: [2, 2],
	},
	{
		name: 'vp9_profile0_1080p_smpte170m',
		args: 'size=1920x1080: -pix_fmt yuv420p -colorspace smpte170m',
		keyFrameStart: '824983426077f043760638241c184a18',
		expected: {
			profile: 0, bitDepth: 8, chromaSubsampling: 1, videoFullRangeFlag: 0,
			colourPrimaries: 6, transferCharacteristics: 6, matrixCoefficients: 6, level: 40,
		},
	},
	{
		name: 'vp9_profile1_444',
		args: 'size=176x144: -pix_fmt yuv444p',
		keyFrameStart: 'a249834200015e011ec0070483830940',
		expected: {
			profile: 1, bitDepth: 8, chromaSubsampling: 3, videoFullRangeFlag: 0,
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2, level: 10,
		},
	},
	{
		name: 'vp9_profile2_10bit_bt2020',
		args: 'size=176x144: -pix_fmt yuv420p10le -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc',
		keyFrameStart: '92498342500578047b011c120e0c2c00',
		// color_space = CS_BT_2020, which says nothing about the transfer, so BT.2020's own one is assumed
		expected: {
			profile: 2, bitDepth: 10, chromaSubsampling: 1, videoFullRangeFlag: 0,
			colourPrimaries: 9, transferCharacteristics: 14, matrixCoefficients: 9, level: 10,
		},
	},
	{
		name: 'vp9_profile3_422_12bit',
		args: 'size=176x144: -pix_fmt yuv422p12le',
		keyFrameStart: 'b124c1a14200578047b011c120e0c2e0',
		expected: {
			profile: 3, bitDepth: 12, chromaSubsampling: 2, videoFullRangeFlag: 0,
			colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2, level: 10,
		},
	},
];

export type Ac3Fixture = {
	name: string;
	/** `ffmpeg -f lavfi -i sine=frequency=440:sample_rate=RATE:duration=0.2 ...` */
	command: string;
	/** The start of the first syncframe */
	frameStart: string;
	/** As reported by ffprobe */
	expected: { sampleRate: number; numberOfChannels: number; bitRate: number };
};

export const AC3_FIXTURES: Ac3Fixture[] = [
	{
		name: 'ac3_stereo_48k',
		command: 'sample_rate=48000 -ac 2 -c:a ac3 -b:a 192k -f ac3',
		frameStart: '0b77fe95144043e106f46370c0c0c218',
		expected: { sampleRate: 48000, numberOfChannels: 2, bitRate: 192000 },
	},
	{
		name: 'ac3_5.1_44.1k',
		command: 'sample_rate=44100 -af pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0 -c:a ac3 -b:a 448k -f ac3',
		frameStart: '0b7760d15e40ebf8403eff9df1662cc5',
		expected: { sampleRate: 44100, numberOfChannels: 6, bitRate: 448000 },
	},
	{
		name: 'ac3_mono_32k',
		command: 'sample_rate=32000 -ac 1 -c:a ac3 -b:a 96k -f ac3',
		frameStart: '0b77952f8c402f842bf1cefab0fdf3f7',
		expected: { sampleRate: 32000, numberOfChannels: 1, bitRate: 96000 },
	},
];

export const EAC3_FIXTURES: Ac3Fixture[] = [
	{
		name: 'eac3_5.1_48k',
		command: 'sample_rate=48000 -af pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0 -c:a eac3 -b:a 384k -f eac3',
		frameStart: '0b7702ff3f87c00020a4210842084210',
		expected: { sampleRate: 48000, numberOfChannels: 6, bitRate: 384000 },
	},
	{
		name: 'eac3_stereo_48k',
		command: 'sample_rate=48000 -ac 2 -c:a eac3 -b:a 96k -f eac3',
		frameStart: '0b7700bf3487c00020fc210830c00006',
		expected: { sampleRate: 48000, numberOfChannels: 2, bitRate: 96000 },
	},
];

const base64ToBytes = (base64: string) => Uint8Array.from(atob(base64), x => x.charCodeAt(0));

// Decoder descriptions for 48 kHz stereo, in the format of the WebCodecs registrations, written by FFmpeg:
// ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000:duration=0.1 -ac 2 -fflags +bitexact -flags:a +bitexact
//   -c:a libvorbis out.mka (or -c:a flac out.flac)

/** The Matroska CodecPrivate: the Xiph-laced identification, comment and setup headers */
export const VORBIS_DESCRIPTION = base64ToBytes(
	'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'
	+ 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
	+ 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
	+ 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
	+ 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
	+ 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
	+ 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
	+ 'AAAAAAAAAAAQAAAQ4AAAEGAhFBqyIgCIEwBwSBIkCZIEzQNIlgVNg6bBNAGSZUHToGkwTQAAAAAAAAAAAAAkTYOmQdMgigBJ06Bp'
	+ '0DSIIgAAAAAAAAAAAACSpkHToGkQRYCkadA0aBpEEQAAAAAAAAAAAADPNCGKEEWYJsAzTYgiRBGmCQAAAAAAAAAAAAAAAAAAAAAA'
	+ 'AAAAAAAIAAAYcAAACDChDBQasiIAiBMAcDiKZQEAgOM4lgUAAI7jWBYAAFiWJYoAAGBZmigCAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
	+ 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAABhwAAAIMKEMFBqyEgCIAgBwKIplAcexLOA4lgUk'
	+ 'ybIAlgXQPICmAUQRAAgAAChwAAAIsEFTYnGAQkNWAgBRAAAGxbEsTRNFkqRpmieKJEnTPE8UaZrneZ5pwvM8zzQhiqJomhBFUTRN'
	+ 'mKZpqiowTVUVAABQ4AAAEGCDpsTiAIWGrAQAQgIAHIpiWZrmeZ4niqapmiRJ0zxPFEXRNE1TVUmSpnmeKIqiaZqmqrIsTfM8URRF'
	+ '01RVVYWmeZ4oiqJpqqrqwvM8TxRF0TRV1XXheZ4niqJomqrquhBFUTRN01RNVXVdIIqmaZqqqqquC0RPFE1TVV3XdYHniaJpqqqr'
	+ 'ui4QTdNUVVV1XVkGmKZpqqrryjJAVVXVdV1XlgGqqqqu67qyDFBV13VdWZZlAK7rurIsywIAAA4cAAACjKCTjCqLsNGECw9AoSEr'
	+ 'AoAoAADAGKYUU8owJiGkEBrGJIQUQiYlpdJSqiCkUlIpFYRUSiolo5RSailVEFIpqZQKQiollVIAANiBAwDYgYVQaMhKACAPAIAw'
	+ 'RinGGHNOIqQUY845JxFSijHnnJNKMeacc85JKRlzzDnnpJTOOeecc1JK5pxzzjkppXPOOeeclFJK55xzTkopJYTOQSellNI555wT'
	+ 'AABU4AAAEGCjyOYEI0GFhqwEAFIBAAyOY1ma5nmiaJqWJGma53meKJqmJkma5nmeJ4qqyfM8TxRF0TRVled5niiKommqKtcVRdM0'
	+ 'TVVVXbIsiqZpmqrqujBN01RV13VdmKZpqqrrui5sW1VV1XVlGbatqqrqurIMXNd1ZdmWgSy7ruzasgAA8AQHAKACG1ZHOCkaCyw0'
	+ 'ZCUAkAEAQBiDkEIIIWUQQgohhJRSCAkAABhwAAAIMKEMFBqyEgBIBQAAjLHWWmuttdZAZ6211lprrYDMWmuttdZaa6211lprrbXW'
	+ 'UmuttdZaa6211lprrbXWWmuttdZaa6211lprrbXWWmuttdZaa6211lprrbXWWmuttdZaay2llFJKKaWUUkoppZRSSimllFJKBQD6'
	+ 'VTgA+D/YsDrCSdFYYKEhKwGAcAAAwBilGHMMQimlVAgx5px0VFqLsUKIMeckpNRabMVzzkEoIZXWYiyecw5CKSnFVmNRKYRSUkot'
	+ 'tliLSqGjklJKrdVYjDGppNZai63GYoxJKbTUWosxFiNsTam12GqrsRhjayottBhjjMUIX2RsLabaag3GCCNbLC3VWmswxhjdW4ul'
	+ 'tpqLMT742lIsMdZcAAB3gwMARIKNM6wknRWOBhcashIACAkAIBBSijHGGHPOOeekUow55pxzDkIIoVSKMcaccw5CCCGUjDHmnHMQ'
	+ 'QgghhFJKxpxzEEIIIYSQUuqccxBCCCGEEEopnXMOQgghhBBCKaWDEEIIIYQQSiilpBRCCCGEEEIIqaSUQgghhFJCKCGVlFIIIYQQ'
	+ 'QiklpJRSCiGEUkIIoYSUUkophRBCCKWUklJKKaUSSgklhBJSKSmlFEoIIZRSSkoppVRKCaGEEkopJaWUUkohhBBKKQUAABw4AAAE'
	+ 'GEEnGVUWYaMJFx6AQkNWAgBkAACQopRSKS1FgiKlGKQYS0YVc1BaiqhyDFLNqVLOIOYklogxhJSTVDLmFEIMQuocdUwpBi2VGELG'
	+ 'GKTYckuhcw4AAABBAICAkAAAAwQFMwDA4ADhcxB0AgRHGwCAIERmiETDQnB4UAkQEVMBQGKCQi4AVFhcpF1cQJcBLujirgMhBCEI'
	+ 'QSwOoIAEHJxwwxNveMINTtApKnUgAAAAAAAMAPAAAJBcABER0cxhZGhscHR4fICEiIyQCAAAAAAAFwB8AAAkJUBERDRzGBkaGxwd'
	+ 'Hh8gISIjJAEAgAACAAAAACCAAAQEBAAAAAAAAgAAAAQE',
);

/** 'fLaC' and the STREAMINFO block, marked as the last metadata block */
export const FLAC_DESCRIPTION = hexToBytes(
	'664c614380000022120012000000780005110bb802f0000012c0ba43705036a3bb057849a9f54f6928a3',
);
