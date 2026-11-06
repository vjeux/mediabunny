// Generators of random, spec-valid codec bitstream headers, with the values every field was written with. Each
// generator follows the syntax tables of its spec; the H.264/H.265/AV1/VP9 ones were cross-checked against FFmpeg's
// trace_headers bitstream filter (CBS) on thousands of outputs.

export class BitWriter {
	bits: number[] = [];

	u(n: number, value: number) {
		for (let i = n - 1; i >= 0; i--) {
			this.bits.push(Math.floor(value / 2 ** i) % 2);
		}
	}

	flag(value: boolean | number) {
		this.bits.push(value ? 1 : 0);
	}

	ue(value: number) {
		const codeNum = value + 1;
		const length = Math.floor(Math.log2(codeNum));
		this.u(length, 0);
		this.u(length + 1, codeNum);
	}

	se(value: number) {
		this.ue(value <= 0 ? -2 * value : 2 * value - 1);
	}

	byteAlign() {
		while (this.bits.length % 8) {
			this.bits.push(0);
		}
	}

	trailingBits() {
		this.bits.push(1);
		this.byteAlign();
	}

	bytes() {
		const result = new Uint8Array(Math.ceil(this.bits.length / 8));
		for (let i = 0; i < this.bits.length; i++) {
			if (this.bits[i]) {
				result[i >> 3]! |= 0x80 >> (i & 7);
			}
		}

		return result;
	}
}

/** Deterministic xorshift PRNG. */
export const createRng = (seed: number) => {
	let state = seed >>> 0 || 1;
	const next = () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 2 ** 32;
	};

	return {
		int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
		bool: (probability = 0.5) => next() < probability,
		pick: <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!,
	};
};

export type Rng = ReturnType<typeof createRng>;

/** Inserts emulation prevention bytes into an H.264/H.265 NAL unit payload. */
const addEmulationPrevention = (rbsp: Uint8Array) => {
	const result: number[] = [];
	let zeros = 0;
	for (const byte of rbsp) {
		if (zeros >= 2 && byte <= 3) {
			result.push(3);
			zeros = 0;
		}

		result.push(byte);
		zeros = byte === 0 ? zeros + 1 : 0;
	}

	return new Uint8Array(result);
};

const toNalUnit = (writer: BitWriter, headerLength: number) => {
	const rbsp = writer.bytes();
	return new Uint8Array([...rbsp.subarray(0, headerLength), ...addEmulationPrevention(rbsp.subarray(headerLength))]);
};

export const annexB = (nalUnits: Uint8Array[]) => {
	return new Uint8Array(nalUnits.flatMap(nalUnit => [0, 0, 0, 1, ...nalUnit]));
};

/** Table E-1 of ITU-T H.264 / H.265 */
export const SAR_TABLE: Record<number, [number, number]> = {
	1: [1, 1], 2: [12, 11], 3: [10, 11], 4: [16, 11], 5: [40, 33], 6: [24, 11], 7: [20, 11], 8: [32, 11], 9: [80, 33],
	10: [18, 11], 11: [15, 11], 12: [64, 33], 13: [160, 99], 14: [4, 3], 15: [3, 2], 16: [2, 1],
};

const sarFromVui = (aspectRatioIdc: number | null, extendedSar: [number, number] | null) => {
	if (aspectRatioIdc === null) {
		return { num: 1, den: 1 };
	}

	const [num, den] = aspectRatioIdc === 255 ? extendedSar! : SAR_TABLE[aspectRatioIdc] ?? [1, 1];
	return { num, den };
};

type VideoSignal = { fullRange: number; colour: [number, number, number] | null } | null;

const writeVideoSignal = (writer: BitWriter, rng: Rng) => {
	let signal: VideoSignal = null;
	if (rng.bool(0.6)) {
		writer.flag(1);
		writer.u(3, rng.int(0, 5)); // video_format
		const fullRange = rng.bool() ? 1 : 0;
		writer.flag(fullRange);
		let colour: [number, number, number] | null = null;
		if (rng.bool(0.7)) {
			colour = [
				rng.pick([1, 2, 4, 5, 6, 7, 9, 12, 22]),
				rng.pick([1, 2, 4, 6, 8, 13, 14, 16, 18]),
				rng.pick([0, 1, 2, 5, 6, 9, 10, 14]),
			];
			writer.flag(1);
			colour.forEach(value => writer.u(8, value));
		} else {
			writer.flag(0);
		}

		signal = { fullRange, colour };
	} else {
		writer.flag(0);
	}

	return signal;
};

const writeAspectRatio = (writer: BitWriter, rng: Rng) => {
	let aspectRatioIdc: number | null = null;
	let extendedSar: [number, number] | null = null;
	if (rng.bool(0.6)) {
		aspectRatioIdc = rng.pick([0, 1, 2, 3, 4, 5, 13, 14, 15, 16, 17, 100, 254, 255, 255, 255]);
		writer.flag(1);
		writer.u(8, aspectRatioIdc);
		if (aspectRatioIdc === 255) {
			extendedSar = [rng.pick([1, 4, 16, 37, 64, 65535]), rng.pick([1, 3, 11, 29, 45, 65535])];
			writer.u(16, extendedSar[0]);
			writer.u(16, extendedSar[1]);
		}
	} else {
		writer.flag(0);
	}

	return { aspectRatioIdc, extendedSar };
};

// ---------------------------------------------------------------------------------------------------------------------
// H.264 sequence parameter set (ITU-T H.264 7.3.2.1.1, E.1.1)

// The profiles whose SPS has chroma_format_idc and the bit depths, plus the old High 4:4:4 profile 144 like FFmpeg
const AVC_HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135, 144];

export type AvcSpsParams = {
	profileIdc: number;
	constraintByte: number;
	levelIdc: number;
	chromaFormatIdc: number;
	separateColourPlane: number;
	bitDepthLumaMinus8: number;
	bitDepthChromaMinus8: number;
	frameMbsOnly: number;
	widthInMbs: number;
	heightInMapUnits: number;
	crop: [number, number, number, number] | null;
	aspectRatioIdc: number | null;
	extendedSar: [number, number] | null;
	videoSignal: VideoSignal;
	hasVui: boolean;
	restriction: { reorder: number; maxDecFrameBuffering: number } | null;
};

const writeAvcHrd = (writer: BitWriter, rng: Rng) => {
	const cpbCount = rng.int(1, 4);
	writer.ue(cpbCount - 1);
	writer.u(4, rng.int(0, 15));
	writer.u(4, rng.int(0, 15));
	for (let i = 0; i < cpbCount; i++) {
		writer.ue(rng.int(0, 5000));
		writer.ue(rng.int(0, 5000));
		writer.flag(rng.bool());
	}

	writer.u(20, rng.int(0, 2 ** 20 - 1)); // Four 5-bit lengths
};

const writeAvcScalingList = (writer: BitWriter, rng: Rng, size: number) => {
	let lastScale = 8;
	let nextScale = 8;
	for (let j = 0; j < size; j++) {
		if (nextScale !== 0) {
			// Sometimes end the list early by making nextScale 0
			const delta = rng.bool(0.08) ? (lastScale <= 128 ? -lastScale : 256 - lastScale) : rng.int(-20, 20);
			writer.se(delta);
			nextScale = (lastScale + delta + 256) % 256;
		}

		lastScale = nextScale === 0 ? lastScale : nextScale;
	}
};

export const randomAvcSps = (rng: Rng, options: { profiles?: number[]; interlaced?: boolean } = {}) => {
	const writer = new BitWriter();
	writer.u(8, 0x67); // nal_ref_idc 3, nal_unit_type 7

	const profileIdc = rng.pick(options.profiles ?? [66, 77, 88, 100, 100, 100, 110, 122, 244, ...AVC_HIGH_PROFILES]);
	const constraintByte = rng.int(0, 63) << 2;
	const levelIdc = rng.pick([9, 10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52, 60, 61, 62]);
	writer.u(8, profileIdc);
	writer.u(8, constraintByte);
	writer.u(8, levelIdc);
	writer.ue(rng.int(0, 31)); // seq_parameter_set_id

	let chromaFormatIdc = 1;
	let separateColourPlane = 0;
	let bitDepthLumaMinus8 = 0;
	let bitDepthChromaMinus8 = 0;
	if (AVC_HIGH_PROFILES.includes(profileIdc)) {
		chromaFormatIdc = rng.pick([0, 1, 1, 2, 3]);
		writer.ue(chromaFormatIdc);
		if (chromaFormatIdc === 3) {
			separateColourPlane = rng.bool(0.3) ? 1 : 0;
			writer.flag(separateColourPlane);
		}

		bitDepthLumaMinus8 = rng.pick([0, 0, 2, 4, 6]);
		bitDepthChromaMinus8 = rng.pick([0, 0, 2, 4, 6]);
		writer.ue(bitDepthLumaMinus8);
		writer.ue(bitDepthChromaMinus8);
		writer.flag(rng.bool(0.2)); // qpprime_y_zero_transform_bypass_flag

		const scalingMatrix = rng.bool(0.3);
		writer.flag(scalingMatrix);
		if (scalingMatrix) {
			for (let i = 0; i < (chromaFormatIdc !== 3 ? 8 : 12); i++) {
				const present = rng.bool();
				writer.flag(present);
				if (present) {
					writeAvcScalingList(writer, rng, i < 6 ? 16 : 64);
				}
			}
		}
	}

	writer.ue(rng.int(0, 12)); // log2_max_frame_num_minus4
	const pocType = rng.pick([0, 1, 2]);
	writer.ue(pocType);
	if (pocType === 0) {
		writer.ue(rng.int(0, 12));
	} else if (pocType === 1) {
		writer.flag(rng.bool());
		writer.se(rng.int(-100, 100));
		writer.se(rng.int(-100, 100));
		const cycleLength = rng.int(0, 10);
		writer.ue(cycleLength);
		for (let i = 0; i < cycleLength; i++) {
			writer.se(rng.int(-100, 100));
		}
	}

	writer.ue(rng.int(0, 16)); // max_num_ref_frames
	writer.flag(rng.bool(0.1)); // gaps_in_frame_num_value_allowed_flag

	const widthInMbs = rng.int(1, 130);
	const heightInMapUnits = rng.int(1, 70);
	writer.ue(widthInMbs - 1);
	writer.ue(heightInMapUnits - 1);
	const frameMbsOnly = options.interlaced === false || rng.bool(0.7) ? 1 : 0;
	writer.flag(frameMbsOnly);
	if (!frameMbsOnly) {
		writer.flag(rng.bool()); // mb_adaptive_frame_field_flag
	}

	writer.flag(frameMbsOnly ? rng.bool() : 1); // direct_8x8_inference_flag, must be 1 for field coding

	let crop: AvcSpsParams['crop'] = null;
	if (rng.bool()) {
		const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
		const cropUnitX = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1;
		const cropUnitY = (chromaArrayType === 1 ? 2 : 1) * (2 - frameMbsOnly);
		const maxX = Math.floor((widthInMbs * 16 - cropUnitX) / cropUnitX);
		const maxY = Math.floor((heightInMapUnits * 16 * (2 - frameMbsOnly) - cropUnitY) / cropUnitY);
		const left = rng.int(0, Math.min(maxX, 8));
		const right = rng.int(0, Math.min(maxX - left, 8));
		const top = rng.int(0, Math.min(maxY, 8));
		const bottom = rng.int(0, Math.min(maxY - top, 8));
		crop = [left, right, top, bottom];
	}

	writer.flag(crop !== null);
	crop?.forEach(value => writer.ue(value));

	const hasVui = rng.bool(0.85);
	writer.flag(hasVui);
	let aspect: ReturnType<typeof writeAspectRatio> = { aspectRatioIdc: null, extendedSar: null };
	let videoSignal: VideoSignal = null;
	let restriction: AvcSpsParams['restriction'] = null;
	if (hasVui) {
		aspect = writeAspectRatio(writer, rng);
		if (rng.bool(0.3)) {
			writer.flag(1); // overscan_info_present_flag
			writer.flag(rng.bool());
		} else {
			writer.flag(0);
		}

		videoSignal = writeVideoSignal(writer, rng);
		if (rng.bool(0.3)) {
			writer.flag(1); // chroma_loc_info_present_flag
			writer.ue(rng.int(0, 5));
			writer.ue(rng.int(0, 5));
		} else {
			writer.flag(0);
		}

		if (rng.bool(0.6)) {
			writer.flag(1); // timing_info_present_flag
			writer.u(32, rng.int(1, 1001));
			writer.u(32, rng.int(1, 120000));
			writer.flag(rng.bool());
		} else {
			writer.flag(0);
		}

		const nalHrd = rng.bool(0.3);
		writer.flag(nalHrd);
		if (nalHrd) {
			writeAvcHrd(writer, rng);
		}

		const vclHrd = rng.bool(0.2);
		writer.flag(vclHrd);
		if (vclHrd) {
			writeAvcHrd(writer, rng);
		}

		if (nalHrd || vclHrd) {
			writer.flag(rng.bool()); // low_delay_hrd_flag
		}

		writer.flag(rng.bool(0.3)); // pic_struct_present_flag
		if (rng.bool(0.6)) {
			writer.flag(1); // bitstream_restriction_flag
			writer.flag(rng.bool());
			for (let i = 0; i < 4; i++) {
				writer.ue(rng.int(0, 16));
			}

			const maxDecFrameBuffering = rng.int(0, 16);
			const reorder = rng.int(0, maxDecFrameBuffering);
			writer.ue(reorder);
			writer.ue(maxDecFrameBuffering);
			restriction = { reorder, maxDecFrameBuffering };
		} else {
			writer.flag(0);
		}
	}

	writer.trailingBits();

	const params: AvcSpsParams = {
		profileIdc, constraintByte, levelIdc, chromaFormatIdc, separateColourPlane, bitDepthLumaMinus8,
		bitDepthChromaMinus8, frameMbsOnly, widthInMbs, heightInMapUnits, crop, ...aspect, videoSignal, hasVui,
		restriction,
	};

	return { nalUnit: toNalUnit(writer, 1), params };
};

/** The values ITU-T H.264 derives from the SPS fields (7.4.2.1.1, E.2.1). */
export const expectedAvcSpsFields = (params: AvcSpsParams) => {
	const chromaArrayType = params.separateColourPlane ? 0 : params.chromaFormatIdc;
	const cropUnitX = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1;
	const cropUnitY = (chromaArrayType === 1 ? 2 : 1) * (2 - params.frameMbsOnly);
	const codedWidth = params.widthInMbs * 16;
	const codedHeight = params.heightInMapUnits * 16 * (2 - params.frameMbsOnly);
	const [left, right, top, bottom] = params.crop ?? [0, 0, 0, 0];

	return {
		profileIdc: params.profileIdc,
		constraintFlags: params.constraintByte,
		levelIdc: params.levelIdc,
		frameMbsOnlyFlag: params.frameMbsOnly,
		chromaFormatIdc: params.chromaFormatIdc,
		bitDepthLumaMinus8: params.bitDepthLumaMinus8,
		bitDepthChromaMinus8: params.bitDepthChromaMinus8,
		codedWidth,
		codedHeight,
		displayWidth: codedWidth - cropUnitX * (left + right),
		displayHeight: codedHeight - cropUnitY * (top + bottom),
		pixelAspectRatio: sarFromVui(params.aspectRatioIdc, params.extendedSar),
		// Unspecified (2) when absent, E.2.1
		colourPrimaries: params.videoSignal?.colour?.[0] ?? 2,
		transferCharacteristics: params.videoSignal?.colour?.[1] ?? 2,
		matrixCoefficients: params.videoSignal?.colour?.[2] ?? 2,
		fullRangeFlag: params.videoSignal?.fullRange ?? 0,
		...(params.restriction && {
			numReorderFrames: params.restriction.reorder,
			maxDecFrameBuffering: params.restriction.maxDecFrameBuffering,
		}),
	};
};

/** A minimal PPS referencing SPS 0, for Annex B access units. */
export const AVC_PPS = new Uint8Array([0x68, 0xce, 0x38, 0x80]);

// ---------------------------------------------------------------------------------------------------------------------
// H.265 sequence parameter set (ITU-T H.265 7.3.2.2.1, 7.3.3, 7.3.7, E.2.1)

export type HevcSpsParams = {
	maxSubLayersMinus1: number;
	temporalIdNesting: number;
	tier: number;
	profileIdc: number;
	compatibilityFlags: boolean[];
	constraintBytes: number[];
	levelIdc: number;
	chromaFormatIdc: number;
	separateColourPlane: number;
	width: number;
	height: number;
	conformanceWindow: [number, number, number, number] | null;
	bitDepthLumaMinus8: number;
	bitDepthChromaMinus8: number;
	maxNumReorderPics: number[];
	interPredictedRps: number;
	longTermRefPics: number;
	aspectRatioIdc: number | null;
	extendedSar: [number, number] | null;
	videoSignal: VideoSignal;
	minSpatialSegmentationIdc: number;
};

const writeHevcProfileTierLevel = (writer: BitWriter, rng: Rng, maxSubLayersMinus1: number) => {
	const tier = rng.bool(0.3) ? 1 : 0;
	const profileIdc = rng.pick([1, 1, 2, 2, 3, 4, 4, 5, 9]);
	writer.u(2, 0); // general_profile_space
	writer.flag(tier);
	writer.u(5, profileIdc);
	const compatibilityFlags = Array.from({ length: 32 }, (_, j) => j === profileIdc || (j > 0 && rng.bool(0.08)));
	compatibilityFlags.forEach(value => writer.flag(value));

	// progressive/interlaced/non-packed/frame-only, then the 43 + 1 bits that the RExt profiles use as flags
	const constraintBits: number[] = Array.from({ length: 48 }, (_, i) => {
		if (i < 4) {
			return rng.bool() ? 1 : 0;
		}

		return i < 13 && profileIdc >= 4 && rng.bool(0.4) ? 1 : 0;
	});
	constraintBits.forEach(value => writer.flag(value));
	const constraintBytes = Array.from(
		{ length: 6 },
		(_, i) => constraintBits.slice(8 * i, 8 * i + 8).reduce((byte, bit) => 2 * byte + bit, 0),
	);

	const levelIdc = rng.pick([30, 60, 63, 90, 93, 120, 123, 150, 153, 156, 180, 183, 186]);
	writer.u(8, levelIdc);

	const subLayers = Array.from({ length: maxSubLayersMinus1 }, () => ({
		profilePresent: rng.bool(0.4),
		levelPresent: rng.bool(),
	}));
	for (const subLayer of subLayers) {
		writer.flag(subLayer.profilePresent);
		writer.flag(subLayer.levelPresent);
	}

	if (maxSubLayersMinus1 > 0) {
		for (let i = maxSubLayersMinus1; i < 8; i++) {
			writer.u(2, 0); // reserved_zero_2bits
		}
	}

	for (const subLayer of subLayers) {
		if (subLayer.profilePresent) {
			writer.u(8, profileIdc); // Space 0, tier 0
			for (let j = 0; j < 32; j++) {
				writer.flag(j === profileIdc);
			}

			writer.u(4, 0b1001);
			writer.u(44, 0);
		}

		if (subLayer.levelPresent) {
			writer.u(8, rng.pick([30, 60, 90, 120]));
		}
	}

	return { tier, profileIdc, compatibilityFlags, constraintBytes, levelIdc };
};

const writeHevcScalingListData = (writer: BitWriter, rng: Rng) => {
	for (let sizeId = 0; sizeId < 4; sizeId++) {
		for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
			const predModeFlag = rng.bool();
			writer.flag(predModeFlag);
			if (!predModeFlag) {
				writer.ue(rng.int(0, sizeId === 3 ? matrixId / 3 : matrixId)); // scaling_list_pred_matrix_id_delta
			} else {
				const coefficientCount = Math.min(64, 1 << (4 + (sizeId << 1)));
				let nextCoefficient = 8;
				if (sizeId > 1) {
					const dc = rng.int(-7, 247);
					writer.se(dc);
					nextCoefficient = dc + 8;
				}

				for (let i = 0; i < coefficientCount; i++) {
					const delta = rng.int(Math.max(-128, 1 - nextCoefficient), Math.min(127, 255 - nextCoefficient));
					writer.se(delta);
					nextCoefficient = (nextCoefficient + delta + 256) % 256;
				}
			}
		}
	}
};

const writeHevcHrdParameters = (writer: BitWriter, rng: Rng, maxSubLayersMinus1: number) => {
	const nal = rng.bool(0.6);
	const vcl = rng.bool(0.4);
	writer.flag(nal);
	writer.flag(vcl);
	let subPic = false;
	if (nal || vcl) {
		subPic = rng.bool(0.4);
		writer.flag(subPic);
		if (subPic) {
			writer.u(8, rng.int(0, 255));
			writer.u(5, rng.int(0, 31));
			writer.flag(rng.bool());
			writer.u(5, rng.int(0, 31));
		}

		writer.u(8, rng.int(0, 255)); // bit_rate_scale, cpb_size_scale
		if (subPic) {
			writer.u(4, rng.int(0, 15));
		}

		writer.u(15, rng.int(0, 2 ** 15 - 1)); // Three 5-bit lengths
	}

	for (let i = 0; i <= maxSubLayersMinus1; i++) {
		const fixedPicRateGeneral = rng.bool();
		writer.flag(fixedPicRateGeneral);
		let fixedPicRateWithinCvs = true;
		if (!fixedPicRateGeneral) {
			fixedPicRateWithinCvs = rng.bool();
			writer.flag(fixedPicRateWithinCvs);
		}

		let lowDelay = false;
		if (fixedPicRateWithinCvs) {
			writer.ue(rng.int(0, 100)); // elemental_duration_in_tc_minus1
		} else {
			lowDelay = rng.bool();
			writer.flag(lowDelay);
		}

		let cpbCount = 1;
		if (!lowDelay) {
			cpbCount = rng.int(1, 4);
			writer.ue(cpbCount - 1);
		}

		for (let k = 0; k < Number(nal) + Number(vcl); k++) {
			for (let j = 0; j < cpbCount; j++) {
				writer.ue(rng.int(0, 3000));
				writer.ue(rng.int(0, 3000));
				if (subPic) {
					writer.ue(rng.int(0, 3000));
					writer.ue(rng.int(0, 3000));
				}

				writer.flag(rng.bool());
			}
		}
	}
};

export const randomHevcSps = (rng: Rng) => {
	const writer = new BitWriter();
	writer.u(16, 0x4201); // nal_unit_type 33, layer 0, temporal id 1
	writer.u(4, 0); // sps_video_parameter_set_id
	const maxSubLayersMinus1 = rng.pick([0, 0, 0, 1, 2, 3, 6]);
	const temporalIdNesting = maxSubLayersMinus1 === 0 || rng.bool() ? 1 : 0;
	writer.u(3, maxSubLayersMinus1);
	writer.flag(temporalIdNesting);
	const ptl = writeHevcProfileTierLevel(writer, rng, maxSubLayersMinus1);
	writer.ue(rng.int(0, 15)); // sps_seq_parameter_set_id

	const chromaFormatIdc = rng.pick([0, 1, 1, 1, 2, 3]);
	writer.ue(chromaFormatIdc);
	let separateColourPlane = 0;
	if (chromaFormatIdc === 3) {
		separateColourPlane = rng.bool(0.3) ? 1 : 0;
		writer.flag(separateColourPlane);
	}

	const width = 8 * rng.int(1, 260);
	const height = 8 * rng.int(1, 140);
	writer.ue(width);
	writer.ue(height);

	let conformanceWindow: HevcSpsParams['conformanceWindow'] = null;
	if (rng.bool()) {
		const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
		const subWidthC = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1;
		const subHeightC = chromaArrayType === 1 ? 2 : 1;
		const maxX = Math.floor((width - subWidthC) / subWidthC);
		const maxY = Math.floor((height - subHeightC) / subHeightC);
		const left = rng.int(0, Math.min(maxX, 8));
		const right = rng.int(0, Math.min(maxX - left, 8));
		const top = rng.int(0, Math.min(maxY, 8));
		const bottom = rng.int(0, Math.min(maxY - top, 8));
		conformanceWindow = [left, right, top, bottom];
	}

	writer.flag(conformanceWindow !== null);
	conformanceWindow?.forEach(value => writer.ue(value));

	const bitDepthLumaMinus8 = rng.pick([0, 0, 2, 4, 8]);
	const bitDepthChromaMinus8 = rng.pick([0, 0, 2, 4, 8]);
	writer.ue(bitDepthLumaMinus8);
	writer.ue(bitDepthChromaMinus8);
	const log2MaxPocLsbMinus4 = rng.int(0, 12);
	writer.ue(log2MaxPocLsbMinus4);

	const subLayerOrderingInfo = rng.bool();
	writer.flag(subLayerOrderingInfo);
	const maxNumReorderPics: number[] = [];
	let maxDecPicBufferingMinus1 = 0;
	for (let i = subLayerOrderingInfo ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
		maxDecPicBufferingMinus1 = rng.int(maxDecPicBufferingMinus1, 15);
		const reorder = rng.int(maxNumReorderPics.at(-1) ?? 0, maxDecPicBufferingMinus1);
		writer.ue(maxDecPicBufferingMinus1);
		writer.ue(reorder);
		writer.ue(rng.int(0, 10)); // sps_max_latency_increase_plus1
		maxNumReorderPics.push(reorder);
	}

	const ctbLog2SizeY = 3 + rng.int(1, 3);
	writer.ue(0); // log2_min_luma_coding_block_size_minus3
	writer.ue(ctbLog2SizeY - 3);
	writer.ue(0); // log2_min_luma_transform_block_size_minus2
	writer.ue(rng.int(0, Math.min(ctbLog2SizeY, 5) - 2));
	writer.ue(rng.int(0, ctbLog2SizeY - 2));
	writer.ue(rng.int(0, ctbLog2SizeY - 2));

	const scalingList = rng.bool(0.3);
	writer.flag(scalingList);
	if (scalingList) {
		const dataPresent = rng.bool(0.6);
		writer.flag(dataPresent);
		if (dataPresent) {
			writeHevcScalingListData(writer, rng);
		}
	}

	writer.flag(rng.bool()); // amp_enabled_flag
	writer.flag(rng.bool()); // sample_adaptive_offset_enabled_flag
	const pcm = rng.bool(0.2);
	writer.flag(pcm);
	if (pcm) {
		writer.u(8, rng.int(0, 255) & 0x77); // PCM bit depths no deeper than the 8-bit samples
		const log2MinPcmMinus3 = rng.int(0, Math.min(ctbLog2SizeY, 5) - 3);
		writer.ue(log2MinPcmMinus3);
		writer.ue(rng.int(0, Math.min(ctbLog2SizeY, 5) - 3 - log2MinPcmMinus3));
		writer.flag(rng.bool());
	}

	// Short-term reference picture sets (7.3.7): explicit ones, and ones predicted from the previous set where every
	// predicted entry has a nonzero delta POC
	const shortTermRpsCount = rng.int(0, 8);
	writer.ue(shortTermRpsCount);
	const sets: { s0: number[]; s1: number[] }[] = [];
	let interPredictedRps = 0;
	for (let i = 0; i < shortTermRpsCount; i++) {
		const predicted = i > 0 && rng.bool();
		if (i > 0) {
			writer.flag(predicted);
		}

		if (predicted) {
			interPredictedRps++;
			const reference = sets[i - 1]!;
			const deltaRps = rng.pick([-3, -2, -1, 1, 2, 3]);
			writer.flag(deltaRps < 0); // delta_rps_sign
			writer.ue(Math.abs(deltaRps) - 1);

			// Entries in the order of the syntax: S0, S1, then the reference picture itself
			const candidates = [...reference.s0, ...reference.s1, 0].map(deltaPoc => deltaPoc + deltaRps);
			const s0: number[] = [];
			const s1: number[] = [];
			for (const deltaPoc of candidates) {
				const used = deltaPoc !== 0 && rng.bool(0.6);
				writer.flag(used);
				let useDelta = used;
				if (!used) {
					useDelta = deltaPoc !== 0 && rng.bool();
					writer.flag(useDelta);
				}

				if (useDelta) {
					(deltaPoc < 0 ? s0 : s1).push(deltaPoc);
				}
			}

			s0.sort((a, b) => b - a);
			s1.sort((a, b) => a - b);
			sets.push({ s0, s1 });
		} else {
			const negativeCount = rng.int(0, Math.min(4, maxDecPicBufferingMinus1));
			const positiveCount = rng.int(0, Math.min(2, maxDecPicBufferingMinus1 - negativeCount));
			writer.ue(negativeCount);
			writer.ue(positiveCount);
			const s0: number[] = [];
			const s1: number[] = [];
			for (let k = 0; k < negativeCount + positiveCount; k++) {
				const deltaMinus1 = rng.int(0, 3);
				writer.ue(deltaMinus1);
				writer.flag(rng.bool());
				if (k < negativeCount) {
					s0.push((s0.at(-1) ?? 0) - deltaMinus1 - 1);
				} else {
					s1.push((s1.at(-1) ?? 0) + deltaMinus1 + 1);
				}
			}

			sets.push({ s0, s1 });
		}
	}

	let longTermRefPics = 0;
	const longTerm = rng.bool(0.3);
	writer.flag(longTerm);
	if (longTerm) {
		longTermRefPics = rng.int(0, 5);
		writer.ue(longTermRefPics);
		for (let i = 0; i < longTermRefPics; i++) {
			writer.u(log2MaxPocLsbMinus4 + 4, rng.int(0, 2 ** (log2MaxPocLsbMinus4 + 4) - 1));
			writer.flag(rng.bool());
		}
	}

	writer.flag(rng.bool()); // sps_temporal_mvp_enabled_flag
	writer.flag(rng.bool()); // strong_intra_smoothing_enabled_flag

	let aspect: ReturnType<typeof writeAspectRatio> = { aspectRatioIdc: null, extendedSar: null };
	let videoSignal: VideoSignal = null;
	let minSpatialSegmentationIdc = 0;
	const vui = rng.bool(0.85);
	writer.flag(vui);
	if (vui) {
		aspect = writeAspectRatio(writer, rng);
		if (rng.bool(0.3)) {
			writer.flag(1); // overscan_info_present_flag
			writer.flag(rng.bool());
		} else {
			writer.flag(0);
		}

		videoSignal = writeVideoSignal(writer, rng);
		if (rng.bool(0.3)) {
			writer.flag(1); // chroma_loc_info_present_flag
			writer.ue(rng.int(0, 5));
			writer.ue(rng.int(0, 5));
		} else {
			writer.flag(0);
		}

		writer.flag(0); // neutral_chroma_indication_flag
		writer.flag(rng.bool(0.2)); // field_seq_flag
		writer.flag(rng.bool(0.2)); // frame_field_info_present_flag
		if (rng.bool(0.3)) {
			writer.flag(1); // default_display_window_flag
			for (let i = 0; i < 4; i++) {
				writer.ue(rng.int(0, 4));
			}
		} else {
			writer.flag(0);
		}

		if (rng.bool()) {
			writer.flag(1); // vui_timing_info_present_flag
			writer.u(32, rng.int(1, 1001));
			writer.u(32, rng.int(1, 60000));
			if (rng.bool(0.3)) {
				writer.flag(1); // vui_poc_proportional_to_timing_flag
				writer.ue(rng.int(0, 3));
			} else {
				writer.flag(0);
			}

			const hrd = rng.bool();
			writer.flag(hrd);
			if (hrd) {
				writeHevcHrdParameters(writer, rng, maxSubLayersMinus1);
			}
		} else {
			writer.flag(0);
		}

		if (rng.bool()) {
			writer.flag(1); // bitstream_restriction_flag
			writer.u(3, rng.int(0, 7));
			minSpatialSegmentationIdc = rng.int(0, 4095);
			writer.ue(minSpatialSegmentationIdc);
			writer.ue(rng.int(0, 16));
			writer.ue(rng.int(0, 16));
			writer.ue(rng.int(0, 15));
			writer.ue(rng.int(0, 15));
		} else {
			writer.flag(0);
		}
	}

	writer.flag(0); // sps_extension_present_flag
	writer.trailingBits();

	const params: HevcSpsParams = {
		maxSubLayersMinus1, temporalIdNesting, ...ptl, chromaFormatIdc, separateColourPlane, width, height,
		conformanceWindow, bitDepthLumaMinus8, bitDepthChromaMinus8, maxNumReorderPics, interPredictedRps,
		longTermRefPics, ...aspect, videoSignal, minSpatialSegmentationIdc,
	};

	return { nalUnit: toNalUnit(writer, 2), params };
};

/** A PPS with every flag off, referencing SPS 0. */
export const createHevcPps = () => {
	const writer = new BitWriter();
	writer.u(16, 0x4401); // nal_unit_type 34
	writer.ue(0); // pps_pic_parameter_set_id
	writer.ue(0); // pps_seq_parameter_set_id
	writer.u(7, 0); // Flags and num_extra_slice_header_bits
	writer.ue(0); // num_ref_idx_l0_default_active_minus1
	writer.ue(0); // num_ref_idx_l1_default_active_minus1
	writer.se(0); // init_qp_minus26
	writer.u(3, 0); // constrained_intra_pred, transform_skip_enabled, cu_qp_delta_enabled
	writer.se(0); // pps_cb_qp_offset
	writer.se(0); // pps_cr_qp_offset
	writer.u(8, 0); // Up to pps_deblocking_filter_control_present_flag
	writer.flag(0); // pps_scaling_list_data_present_flag
	writer.flag(0); // lists_modification_present_flag
	writer.ue(0); // log2_parallel_merge_level_minus2
	writer.u(2, 0); // slice_segment_header_extension_present_flag, pps_extension_present_flag
	writer.trailingBits();
	return toNalUnit(writer, 2);
};

export const expectedHevcSpsFields = (params: HevcSpsParams) => {
	const chromaArrayType = params.separateColourPlane ? 0 : params.chromaFormatIdc;
	const subWidthC = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1;
	const subHeightC = chromaArrayType === 1 ? 2 : 1;
	const [left, right, top, bottom] = params.conformanceWindow ?? [0, 0, 0, 0];

	return {
		displayWidth: params.width - subWidthC * (left + right),
		displayHeight: params.height - subHeightC * (top + bottom),
		pixelAspectRatio: sarFromVui(params.aspectRatioIdc, params.extendedSar),
		colourPrimaries: params.videoSignal?.colour?.[0] ?? 2,
		transferCharacteristics: params.videoSignal?.colour?.[1] ?? 2,
		matrixCoefficients: params.videoSignal?.colour?.[2] ?? 2,
		fullRangeFlag: params.videoSignal?.fullRange ?? 0,
		spsMaxSubLayersMinus1: params.maxSubLayersMinus1,
		spsTemporalIdNestingFlag: params.temporalIdNesting,
		generalProfileSpace: 0,
		generalTierFlag: params.tier,
		generalProfileIdc: params.profileIdc,
		generalLevelIdc: params.levelIdc,
		chromaFormatIdc: params.chromaFormatIdc,
		bitDepthLumaMinus8: params.bitDepthLumaMinus8,
		bitDepthChromaMinus8: params.bitDepthChromaMinus8,
		minSpatialSegmentationIdc: params.minSpatialSegmentationIdc,
	};
};

/** The hev1/hvc1 codec string suffix of ISO/IEC 14496-15 E.3. */
export const expectedHevcCodecStringSuffix = (params: HevcSpsParams) => {
	// The compatibility flags in reverse bit order: flag 0 is the least significant bit
	const compatibility = params.compatibilityFlags.reduce((sum, flag, j) => sum + (flag ? 2 ** j : 0), 0);
	const constraintBytes = [...params.constraintBytes];
	while (constraintBytes.length > 0 && constraintBytes.at(-1) === 0) {
		constraintBytes.pop();
	}

	return [
		String(params.profileIdc),
		compatibility.toString(16).toUpperCase(),
		(params.tier ? 'H' : 'L') + params.levelIdc,
		...constraintBytes.map(byte => byte.toString(16).toUpperCase()),
	].join('.');
};

// ---------------------------------------------------------------------------------------------------------------------
// AV1 sequence header OBU (AV1 bitstream spec 5.5)

export type Av1SequenceHeaderParams = {
	profile: number;
	reducedStillPictureHeader: boolean;
	levelIdx: number;
	tier: number;
	bitDepth: number;
	monochrome: number;
	subsamplingX: number;
	subsamplingY: number;
	chromaSamplePosition: number;
	colour: [number, number, number] | null;
	colorRange: number;
};

const writeLeb128 = (value: number) => {
	const bytes: number[] = [];
	do {
		let byte = value & 0x7f;
		value = Math.floor(value / 128);
		if (value > 0) {
			byte |= 0x80;
		}

		bytes.push(byte);
	} while (value > 0);

	return bytes;
};

const writeUvlc = (writer: BitWriter, value: number) => {
	const length = Math.floor(Math.log2(value + 1));
	writer.u(length, 0);
	writer.u(length + 1, value + 1);
};

export const randomAv1SequenceHeader = (rng: Rng) => {
	const writer = new BitWriter();
	const profile = rng.pick([0, 0, 1, 2]);
	const reducedStillPictureHeader = rng.bool(0.15);
	writer.u(3, profile);
	writer.flag(reducedStillPictureHeader || rng.bool(0.1)); // still_picture
	writer.flag(reducedStillPictureHeader);

	let levelIdx: number;
	let tier = 0;
	if (reducedStillPictureHeader) {
		levelIdx = rng.int(0, 23);
		writer.u(5, levelIdx);
	} else {
		const timingInfo = rng.bool(0.4);
		writer.flag(timingInfo);
		let decoderModelInfo = false;
		let bufferDelayLength = 0;
		if (timingInfo) {
			writer.u(32, rng.int(1, 1001));
			writer.u(32, rng.int(1, 120000));
			const equalPictureInterval = rng.bool();
			writer.flag(equalPictureInterval);
			if (equalPictureInterval) {
				writeUvlc(writer, rng.int(0, 1000));
			}

			decoderModelInfo = rng.bool();
			writer.flag(decoderModelInfo);
			if (decoderModelInfo) {
				bufferDelayLength = rng.int(1, 32);
				writer.u(5, bufferDelayLength - 1);
				writer.u(32, rng.int(1, 1000));
				writer.u(5, rng.int(0, 31));
				writer.u(5, rng.int(0, 31));
			}
		}

		const initialDisplayDelay = rng.bool(0.3);
		writer.flag(initialDisplayDelay);
		const operatingPoints = rng.pick([1, 1, 1, 2, 4, 32]);
		writer.u(5, operatingPoints - 1);
		levelIdx = 0;
		for (let i = 0; i < operatingPoints; i++) {
			writer.u(12, operatingPoints === 1 ? 0 : rng.int(1, 4095)); // operating_point_idc
			const opLevelIdx = rng.pick([0, 1, 4, 5, 8, 9, 12, 13, 14, 15, 16, 19, 31]);
			writer.u(5, opLevelIdx);
			let opTier = 0;
			if (opLevelIdx > 7) {
				opTier = rng.bool() ? 1 : 0;
				writer.flag(opTier);
			}

			if (i === 0) {
				levelIdx = opLevelIdx;
				tier = opTier;
			}

			if (decoderModelInfo) {
				const present = rng.bool();
				writer.flag(present);
				if (present) {
					writer.u(bufferDelayLength, rng.int(0, 2 ** bufferDelayLength - 1));
					writer.u(bufferDelayLength, rng.int(0, 2 ** bufferDelayLength - 1));
					writer.flag(rng.bool());
				}
			}

			if (initialDisplayDelay) {
				const present = rng.bool();
				writer.flag(present);
				if (present) {
					writer.u(4, rng.int(0, 9));
				}
			}
		}
	}

	const frameWidthBits = rng.int(1, 16);
	const frameHeightBits = rng.int(1, 16);
	writer.u(4, frameWidthBits - 1);
	writer.u(4, frameHeightBits - 1);
	writer.u(frameWidthBits, rng.int(0, 2 ** frameWidthBits - 1));
	writer.u(frameHeightBits, rng.int(0, 2 ** frameHeightBits - 1));
	if (!reducedStillPictureHeader) {
		const frameIdNumbers = rng.bool(0.2);
		writer.flag(frameIdNumbers);
		if (frameIdNumbers) {
			writer.u(4, rng.int(0, 15));
			writer.u(3, rng.int(0, 7));
		}
	}

	writer.u(3, rng.int(0, 7)); // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
	if (!reducedStillPictureHeader) {
		writer.u(4, rng.int(0, 15)); // interintra, masked compound, warped motion, dual filter
		const enableOrderHint = rng.bool();
		writer.flag(enableOrderHint);
		if (enableOrderHint) {
			writer.u(2, rng.int(0, 3)); // enable_jnt_comp, enable_ref_frame_mvs
		}

		const chooseScreenContentTools = rng.bool();
		writer.flag(chooseScreenContentTools);
		let forceScreenContentTools = 2;
		if (!chooseScreenContentTools) {
			forceScreenContentTools = rng.bool() ? 1 : 0;
			writer.flag(forceScreenContentTools);
		}

		if (forceScreenContentTools > 0) {
			const chooseIntegerMv = rng.bool();
			writer.flag(chooseIntegerMv);
			if (!chooseIntegerMv) {
				writer.flag(rng.bool()); // seq_force_integer_mv
			}
		}

		if (enableOrderHint) {
			writer.u(3, rng.int(0, 7));
		}
	}

	writer.u(3, rng.int(0, 7)); // enable_superres, enable_cdef, enable_restoration

	// color_config()
	const highBitdepth = rng.bool() ? 1 : 0;
	writer.flag(highBitdepth);
	let bitDepth = highBitdepth ? 10 : 8;
	if (profile === 2 && highBitdepth) {
		const twelveBit = rng.bool();
		writer.flag(twelveBit);
		bitDepth = twelveBit ? 12 : 10;
	}

	let monochrome = 0;
	if (profile !== 1) {
		monochrome = rng.bool(0.2) ? 1 : 0;
		writer.flag(monochrome);
	}

	// sRGB (BT.709, sRGB transfer, identity matrix) means 4:4:4, which profile 0 and 10-bit profile 2 can't do
	const canBeSrgb = !monochrome && (profile === 1 || bitDepth === 12);
	let colour: [number, number, number] | null = null;
	if (canBeSrgb && rng.bool(0.3)) {
		colour = [1, 13, 0];
	} else if (rng.bool(0.6)) {
		colour = [rng.pick([1, 2, 5, 6, 9, 12]), rng.pick([1, 2, 6, 8, 16, 18]), rng.pick([1, 2, 5, 6, 9])];
		if (colour.every(value => value === 2)) {
			// An explicit 2/2/2 can't be told apart from no color description in the parsed info
			colour = [9, 16, 9];
		}
	}

	writer.flag(colour !== null);
	colour?.forEach(value => writer.u(8, value));

	let colorRange = 1;
	let subsamplingX = 1;
	let subsamplingY = 1;
	let chromaSamplePosition = 0;
	if (monochrome) {
		colorRange = rng.bool() ? 1 : 0;
		writer.flag(colorRange);
	} else if (colour?.[0] === 1 && colour[1] === 13 && colour[2] === 0) {
		subsamplingX = 0;
		subsamplingY = 0;
	} else {
		colorRange = rng.bool() ? 1 : 0;
		writer.flag(colorRange);
		if (profile === 0) {
			subsamplingX = 1;
			subsamplingY = 1;
		} else if (profile === 1) {
			subsamplingX = 0;
			subsamplingY = 0;
		} else if (bitDepth === 12) {
			subsamplingX = rng.bool() ? 1 : 0;
			writer.flag(subsamplingX);
			subsamplingY = subsamplingX && rng.bool() ? 1 : 0;
			if (subsamplingX) {
				writer.flag(subsamplingY);
			}
		} else {
			subsamplingX = 1;
			subsamplingY = 0;
		}

		if (subsamplingX && subsamplingY) {
			chromaSamplePosition = rng.int(0, 2);
			writer.u(2, chromaSamplePosition);
		}
	}

	if (!monochrome) {
		writer.flag(rng.bool()); // separate_uv_delta_q
	}

	writer.flag(rng.bool()); // film_grain_params_present
	writer.trailingBits();

	const payload = writer.bytes();
	const obu = new Uint8Array([0x0a, ...writeLeb128(payload.byteLength), ...payload]); // OBU_SEQUENCE_HEADER
	const params: Av1SequenceHeaderParams = {
		profile, reducedStillPictureHeader, levelIdx, tier, bitDepth, monochrome, subsamplingX, subsamplingY,
		chromaSamplePosition, colour, colorRange,
	};

	return { obu, params };
};

/** A temporal delimiter OBU, as in front of every temporal unit in a low overhead bitstream. */
export const AV1_TEMPORAL_DELIMITER = new Uint8Array([0x12, 0x00]);

// ---------------------------------------------------------------------------------------------------------------------
// VP9 uncompressed header of a key frame (VP9 bitstream spec 6.2)

export type Vp9KeyFrameParams = {
	profile: number;
	bitDepth: number;
	colorSpace: number;
	colorRange: number;
	subsamplingX: number;
	subsamplingY: number;
	width: number;
	height: number;
};

export const randomVp9KeyFrame = (rng: Rng) => {
	const writer = new BitWriter();
	const profile = rng.int(0, 3);
	writer.u(2, 2); // frame_marker
	writer.flag(profile & 1);
	writer.flag(profile >> 1);
	if (profile === 3) {
		writer.flag(0); // reserved_zero
	}

	writer.flag(0); // show_existing_frame
	writer.flag(0); // frame_type: KEY_FRAME
	writer.flag(1); // show_frame
	writer.flag(rng.bool()); // error_resilient_mode
	writer.u(24, 0x498342); // frame_sync_code

	let bitDepth = 8;
	if (profile >= 2) {
		const twelveBit = rng.bool();
		writer.flag(twelveBit);
		bitDepth = twelveBit ? 12 : 10;
	}

	// RGB is only allowed in profiles 1 and 3
	const colorSpace = profile & 1 && rng.bool(0.3) ? 7 : rng.int(0, 6);
	writer.u(3, colorSpace);
	let colorRange = 1;
	let subsamplingX = 1;
	let subsamplingY = 1;
	if (colorSpace !== 7) {
		colorRange = rng.bool() ? 1 : 0;
		writer.flag(colorRange);
		if (profile & 1) {
			// Profiles 1 and 3 are not 4:2:0. 4:4:0 (0, 1) exists but has no codec string value, so it's left out.
			[subsamplingX, subsamplingY] = rng.pick([[1, 0], [0, 0]]);
			writer.flag(subsamplingX);
			writer.flag(subsamplingY);
			writer.flag(0); // reserved_zero
		}
	} else {
		subsamplingX = 0;
		subsamplingY = 0;
		writer.flag(0); // reserved_zero
	}

	const width = rng.pick([1, 2, 63, 64, 352, 1280, 1920, 4096, 8192, 16384]);
	const height = rng.pick([1, 2, 47, 48, 288, 720, 1080, 2160, 4352, 8704]);
	writer.u(16, width - 1);
	writer.u(16, height - 1);
	writer.flag(0); // render_and_frame_size_different
	writer.u(6, rng.int(0, 63)); // refresh_frame_context etc. (the rest of the header isn't parsed)
	writer.byteAlign();

	return {
		data: writer.bytes(),
		params: { profile, bitDepth, colorSpace, colorRange, subsamplingX, subsamplingY, width, height },
	};
};

// ---------------------------------------------------------------------------------------------------------------------
// MPEG-4 AudioSpecificConfig (ISO/IEC 14496-3 1.6.2.1, 4.4.1)

export const AAC_SAMPLE_RATES = [
	96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

export type AudioSpecificConfigParams = {
	objectType: number;
	coreObjectType: number;
	sampleRate: number;
	channelConfiguration: number;
	frameLength: number;
	/** Rate after SBR, if signaled */
	sbrSampleRate: number | null;
	ps: boolean;
	signaling: 'none' | 'explicit' | 'backward-compatible';
};

const writeAudioObjectType = (writer: BitWriter, objectType: number) => {
	if (objectType >= 32) {
		writer.u(5, 31);
		writer.u(6, objectType - 32);
	} else {
		writer.u(5, objectType);
	}
};

const writeSamplingFrequency = (writer: BitWriter, rng: Rng, sampleRate: number) => {
	const index = AAC_SAMPLE_RATES.indexOf(sampleRate);
	if (index === -1 || rng.bool(0.1)) {
		writer.u(4, 15); // Explicit 24-bit frequency
		writer.u(24, sampleRate);
	} else {
		writer.u(4, index);
	}
};

const writeGaSpecificConfig = (writer: BitWriter, rng: Rng, objectType: number, frameLength: number) => {
	// SBR/PS behind a sync extension is found by scanning for the sync word (like FFmpeg), so no random bits here
	writer.flag(frameLength === 960);
	writer.flag(0); // dependsOnCoreCoder

	writer.flag(0); // extensionFlag
	if (objectType === 6 || objectType === 20) {
		writer.u(3, rng.int(0, 7)); // layerNr
	}
};

export const randomAudioSpecificConfig = (rng: Rng) => {
	const writer = new BitWriter();
	const signaling = rng.pick(['none', 'none', 'explicit', 'backward-compatible'] as const);
	const coreObjectType = signaling === 'none' ? rng.pick([1, 2, 2, 2, 3, 4, 6, 17, 19, 20, 23, 33]) : 2;
	const sampleRate = rng.bool(0.9) ? rng.pick(AAC_SAMPLE_RATES.slice(signaling === 'none' ? 0 : 5)) : 37800;
	// Configurations 1-7 only: a PCE (channelConfiguration 0) isn't generated
	const channelConfiguration = signaling !== 'none' && rng.bool(0.4) ? 1 : rng.int(1, 7);
	// frameLengthFlag selects 960 samples for these; for AAC-LD (23) it selects 480 instead of 512
	const frameLength = [1, 2, 3, 4, 6, 17, 19, 20].includes(coreObjectType) && rng.bool(0.2) ? 960 : 1024;
	const ps = signaling !== 'none' && channelConfiguration === 1 && rng.bool();
	const sbrSampleRate = signaling === 'none' ? null : 2 * sampleRate;
	const objectType = signaling === 'explicit' ? (ps ? 29 : 5) : coreObjectType;

	writeAudioObjectType(writer, objectType);
	writeSamplingFrequency(writer, rng, sampleRate);
	writer.u(4, channelConfiguration);
	if (signaling === 'explicit') {
		writeSamplingFrequency(writer, rng, sbrSampleRate!);
		writeAudioObjectType(writer, coreObjectType);
	}

	if (![33].includes(coreObjectType)) {
		writeGaSpecificConfig(writer, rng, coreObjectType, frameLength);
	}

	if (signaling === 'backward-compatible') {
		writer.u(11, 0x2b7);
		writeAudioObjectType(writer, 5);
		writer.flag(1); // sbrPresentFlag
		writeSamplingFrequency(writer, rng, sbrSampleRate!);
		if (ps || rng.bool()) {
			writer.u(11, 0x548);
			writer.flag(ps);
		}
	}

	writer.byteAlign();

	const params: AudioSpecificConfigParams = {
		objectType, coreObjectType, sampleRate, channelConfiguration, frameLength, sbrSampleRate, ps, signaling,
	};
	return { asc: writer.bytes(), params };
};

// ---------------------------------------------------------------------------------------------------------------------
// AC-3 / E-AC-3 syncframe headers (ETSI TS 102 366 4.3, E.1.2)

export type Ac3SyncFrameParams = {
	fscod: number;
	frmsizecod: number;
	bsid: number;
	bsmod: number;
	acmod: number;
	lfeon: number;
};

export const randomAc3SyncFrame = (rng: Rng) => {
	const writer = new BitWriter();
	const fscod = rng.int(0, 2);
	const frmsizecod = rng.int(0, 37);
	const bsid = rng.pick([6, 8, 8]);
	const bsmod = rng.int(0, 7);
	const acmod = rng.int(0, 7);
	const lfeon = rng.bool() ? 1 : 0;
	writer.u(16, 0x0b77);
	writer.u(16, 0); // crc1
	writer.u(2, fscod);
	writer.u(6, frmsizecod);
	writer.u(5, bsid);
	writer.u(3, bsmod);
	writer.u(3, acmod);
	if ((acmod & 1) && acmod !== 1) {
		writer.u(2, rng.int(0, 2)); // cmixlev
	}

	if (acmod & 4) {
		writer.u(2, rng.int(0, 2)); // surmixlev
	}

	if (acmod === 2) {
		writer.u(2, rng.int(0, 2)); // dsurmod
	}

	writer.flag(lfeon);
	writer.byteAlign();
	return { data: writer.bytes(), params: { fscod, frmsizecod, bsid, bsmod, acmod, lfeon } };
};

export type Eac3SyncFrameParams = {
	frmsiz: number;
	fscod: number;
	fscod2: number;
	numblkscod: number;
	acmod: number;
	lfeon: number;
	bsid: number;
};

export const randomEac3SyncFrame = (rng: Rng) => {
	const writer = new BitWriter();
	const frmsiz = rng.int(10, 2047);
	const fscod = rng.pick([0, 0, 1, 2, 3]);
	const fscod2 = fscod === 3 ? rng.int(0, 2) : 0;
	const numblkscod = fscod === 3 ? 3 : rng.int(0, 3);
	const acmod = rng.int(0, 7);
	const lfeon = rng.bool() ? 1 : 0;
	const bsid = 16;
	writer.u(16, 0x0b77);
	writer.u(2, 0); // strmtyp: independent
	writer.u(3, 0); // substreamid
	writer.u(11, frmsiz);
	writer.u(2, fscod);
	writer.u(2, fscod === 3 ? fscod2 : numblkscod);
	writer.u(3, acmod);
	writer.flag(lfeon);
	writer.u(5, bsid);
	writer.u(5, rng.int(1, 31)); // dialnorm
	writer.byteAlign();
	return { data: writer.bytes(), params: { frmsiz, fscod, fscod2, numblkscod, acmod, lfeon, bsid } };
};
