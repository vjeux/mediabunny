/*!
 * Independent bitstream readers for the encoder configuration suite: just enough of the AV1 sequence header (AV1
 * spec 5.5), the VP9 uncompressed header (VP9 spec 6.2) and the AVCDecoderConfigurationRecord (ISO/IEC 14496-15
 * 5.3.3.1) to compare what the encoder produced against the codec strings Mediabunny signals.
 */

class BitReader {
	pos = 0;

	constructor(private bytes: Uint8Array) {}

	read(n: number) {
		let value = 0;
		for (let i = 0; i < n; i++) {
			const byte = this.bytes[this.pos >> 3]!;
			value = value * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
			this.pos++;
		}
		return value;
	}

	uvlc() {
		let leadingZeros = 0;
		while (this.read(1) === 0) {
			leadingZeros++;
		}
		return leadingZeros >= 32 ? 2 ** 32 - 1 : this.read(leadingZeros) + 2 ** leadingZeros - 1;
	}
}

const readLeb128 = (bytes: Uint8Array, offset: number) => {
	let value = 0;
	let length = 0;
	for (let i = 0; i < 8; i++) {
		const byte = bytes[offset + i]!;
		value += (byte & 0x7f) * 2 ** (7 * i);
		length++;
		if (!(byte & 0x80)) {
			break;
		}
	}
	return { value, length };
};

export type Av1SequenceHeader = {
	seqProfile: number;
	seqLevelIdx0: number;
	seqTier0: number;
	bitDepth: number;
	monochrome: number;
	subsamplingX: number;
	subsamplingY: number;
	chromaSamplePosition: number;
	colorDescriptionPresent: boolean;
	colorPrimaries: number;
	transferCharacteristics: number;
	matrixCoefficients: number;
	colorRange: number;
};

/** Finds the first sequence header OBU in a temporal unit and reads its leading fields. */
export const readAv1SequenceHeader = (data: Uint8Array): Av1SequenceHeader | null => {
	let offset = 0;
	while (offset < data.length) {
		const header = data[offset]!;
		const type = (header >> 3) & 0xf;
		const hasExtension = (header >> 2) & 1;
		const hasSize = (header >> 1) & 1;
		let payloadStart = offset + 1 + hasExtension;
		let payloadSize = data.length - payloadStart;
		if (hasSize) {
			const leb = readLeb128(data, payloadStart);
			payloadStart += leb.length;
			payloadSize = leb.value;
		}

		if (type === 1) {
			return parseAv1SequenceHeader(data.subarray(payloadStart, payloadStart + payloadSize));
		}

		offset = payloadStart + payloadSize;
	}

	return null;
};

const parseAv1SequenceHeader = (payload: Uint8Array): Av1SequenceHeader => {
	const r = new BitReader(payload);
	const seqProfile = r.read(3);
	r.read(1); // still_picture
	const reducedStillPictureHeader = r.read(1);
	let seqLevelIdx0 = 0;
	let seqTier0 = 0;
	let decoderModelInfoPresent = 0;
	let bufferDelayLengthMinus1 = 0;

	if (reducedStillPictureHeader) {
		seqLevelIdx0 = r.read(5);
	} else {
		const timingInfoPresent = r.read(1);
		if (timingInfoPresent) {
			r.read(32); // num_units_in_display_tick
			r.read(32); // time_scale
			if (r.read(1)) { // equal_picture_interval
				r.uvlc();
			}
			decoderModelInfoPresent = r.read(1);
			if (decoderModelInfoPresent) {
				bufferDelayLengthMinus1 = r.read(5);
				r.read(32); // num_units_in_decoding_tick
				r.read(5); // buffer_removal_time_length_minus_1
				r.read(5); // frame_presentation_time_length_minus_1
			}
		}

		const initialDisplayDelayPresent = r.read(1);
		const operatingPointsCountMinus1 = r.read(5);
		for (let i = 0; i <= operatingPointsCountMinus1; i++) {
			r.read(12); // operating_point_idc
			const levelIdx = r.read(5);
			const tier = levelIdx > 7 ? r.read(1) : 0;
			if (i === 0) {
				seqLevelIdx0 = levelIdx;
				seqTier0 = tier;
			}
			if (decoderModelInfoPresent && r.read(1)) {
				const n = bufferDelayLengthMinus1 + 1;
				r.read(n); // decoder_buffer_delay
				r.read(n); // encoder_buffer_delay
				r.read(1); // low_delay_mode_flag
			}
			if (initialDisplayDelayPresent && r.read(1)) {
				r.read(4);
			}
		}
	}

	const frameWidthBitsMinus1 = r.read(4);
	const frameHeightBitsMinus1 = r.read(4);
	r.read(frameWidthBitsMinus1 + 1);
	r.read(frameHeightBitsMinus1 + 1);
	const frameIdNumbersPresent = reducedStillPictureHeader ? 0 : r.read(1);
	if (frameIdNumbersPresent) {
		r.read(4);
		r.read(3);
	}
	r.read(1); // use_128x128_superblock
	r.read(1); // enable_filter_intra
	r.read(1); // enable_intra_edge_filter
	if (!reducedStillPictureHeader) {
		r.read(1); // enable_interintra_compound
		r.read(1); // enable_masked_compound
		r.read(1); // enable_warped_motion
		r.read(1); // enable_dual_filter
		const enableOrderHint = r.read(1);
		if (enableOrderHint) {
			r.read(1); // enable_jnt_comp
			r.read(1); // enable_ref_frame_mvs
		}
		const seqChooseScreenContentTools = r.read(1);
		const seqForceScreenContentTools = seqChooseScreenContentTools ? 2 : r.read(1);
		if (seqForceScreenContentTools > 0) {
			const seqChooseIntegerMv = r.read(1);
			if (!seqChooseIntegerMv) {
				r.read(1); // seq_force_integer_mv
			}
		}
		if (enableOrderHint) {
			r.read(3); // order_hint_bits_minus_1
		}
	}
	r.read(1); // enable_superres
	r.read(1); // enable_cdef
	r.read(1); // enable_restoration

	// color_config()
	const highBitdepth = r.read(1);
	let bitDepth = 8;
	if (seqProfile === 2 && highBitdepth) {
		bitDepth = r.read(1) ? 12 : 10;
	} else if (highBitdepth) {
		bitDepth = 10;
	}
	const monochrome = seqProfile === 1 ? 0 : r.read(1);
	const colorDescriptionPresent = !!r.read(1);
	let colorPrimaries = 2;
	let transferCharacteristics = 2;
	let matrixCoefficients = 2;
	if (colorDescriptionPresent) {
		colorPrimaries = r.read(8);
		transferCharacteristics = r.read(8);
		matrixCoefficients = r.read(8);
	}

	let colorRange: number;
	let subsamplingX = 1;
	let subsamplingY = 1;
	let chromaSamplePosition = 0;
	if (monochrome) {
		colorRange = r.read(1);
	} else if (colorPrimaries === 1 && transferCharacteristics === 13 && matrixCoefficients === 0) {
		colorRange = 1;
		subsamplingX = 0;
		subsamplingY = 0;
	} else {
		colorRange = r.read(1);
		if (seqProfile === 0) {
			subsamplingX = 1;
			subsamplingY = 1;
		} else if (seqProfile === 1) {
			subsamplingX = 0;
			subsamplingY = 0;
		} else if (bitDepth === 12) {
			subsamplingX = r.read(1);
			subsamplingY = subsamplingX ? r.read(1) : 0;
		} else {
			subsamplingX = 1;
			subsamplingY = 0;
		}
		if (subsamplingX && subsamplingY) {
			chromaSamplePosition = r.read(2);
		}
	}

	return {
		seqProfile,
		seqLevelIdx0,
		seqTier0,
		bitDepth,
		monochrome,
		subsamplingX,
		subsamplingY,
		chromaSamplePosition,
		colorDescriptionPresent,
		colorPrimaries,
		transferCharacteristics,
		matrixCoefficients,
		colorRange,
	};
};

export type Vp9FrameHeader = {
	profile: number;
	bitDepth: number;
	colorSpace: number;
	colorRange: number;
	subsamplingX: number;
	subsamplingY: number;
	width: number;
	height: number;
};

/** Reads the uncompressed header of a VP9 key frame (VP9 spec 6.2); null for other frames. */
export const readVp9KeyFrameHeader = (data: Uint8Array): Vp9FrameHeader | null => {
	const r = new BitReader(data);
	if (r.read(2) !== 2) { // frame_marker
		return null;
	}
	const profileLowBit = r.read(1);
	const profileHighBit = r.read(1);
	const profile = (profileHighBit << 1) + profileLowBit;
	if (profile === 3) {
		r.read(1);
	}
	if (r.read(1)) { // show_existing_frame
		return null;
	}
	if (r.read(1) !== 0) { // frame_type: 0 is KEY_FRAME
		return null;
	}
	r.read(1); // show_frame
	r.read(1); // error_resilient_mode
	if (r.read(24) !== 0x498342) {
		return null;
	}

	let bitDepth = 8;
	if (profile >= 2) {
		bitDepth = r.read(1) ? 12 : 10;
	}
	const colorSpace = r.read(3);
	let colorRange = 1;
	let subsamplingX = 0;
	let subsamplingY = 0;
	if (colorSpace !== 7) { // CS_RGB
		colorRange = r.read(1);
		if (profile === 1 || profile === 3) {
			subsamplingX = r.read(1);
			subsamplingY = r.read(1);
			r.read(1);
		} else {
			subsamplingX = 1;
			subsamplingY = 1;
		}
	} else if (profile === 1 || profile === 3) {
		r.read(1);
	}

	const width = r.read(16) + 1;
	const height = r.read(16) + 1;

	return { profile, bitDepth, colorSpace, colorRange, subsamplingX, subsamplingY, width, height };
};

/** Returns the profile_idc, constraint flags byte and level_idc of the first SPS in an avcC record. */
export const readAvcSpsHeaderBytes = (avcC: Uint8Array) => {
	const spsCount = avcC[5]! & 0x1f;
	if (spsCount === 0) {
		return null;
	}
	const spsLength = (avcC[6]! << 8) | avcC[7]!;
	const sps = avcC.subarray(8, 8 + spsLength);
	// sps[0] is the NAL unit header (nal_unit_type 7)
	return {
		nalUnitType: sps[0]! & 0x1f,
		profileIdc: sps[1]!,
		constraintFlags: sps[2]!,
		levelIdc: sps[3]!,
		recordProfile: avcC[1]!,
		recordCompatibility: avcC[2]!,
		recordLevel: avcC[3]!,
	};
};
