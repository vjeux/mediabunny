// Reference math for YUV -> RGB conversions, following ITU-T H.273 (BT.601, BT.709 and BT.2020 non-constant
// luminance). The oracle of the pixel format accuracy tests.

export type MatrixName = 'bt709' | 'bt470bg' | 'smpte170m' | 'bt2020-ncl';

/** The Kr and Kb luma coefficients of each matrix (H.273, table 4). */
export const LUMA_COEFFICIENTS: Record<MatrixName, [number, number]> = {
	'bt709': [0.2126, 0.0722],
	'bt470bg': [0.299, 0.114],
	'smpte170m': [0.299, 0.114],
	'bt2020-ncl': [0.2627, 0.0593],
};

/** Normalizes Y, Cb and Cr code values to Y' in [0, 1] and Cb, Cr in [-0.5, 0.5] (H.273, equations 20 to 28). */
export const normalizeYuv = (y: number, u: number, v: number, fullRange: boolean, bitDepth: number) => {
	if (fullRange) {
		const max = 2 ** bitDepth - 1;
		const mid = 2 ** (bitDepth - 1);
		return [y / max, (u - mid) / max, (v - mid) / max] as const;
	}

	const scale = 2 ** (bitDepth - 8);
	return [
		(y - 16 * scale) / (219 * scale),
		(u - 128 * scale) / (224 * scale),
		(v - 128 * scale) / (224 * scale),
	] as const;
};

/** Converts code values to non-linear R', G' and B' in [0, 1], unclamped. */
export const yuvToRgb = (
	y: number,
	u: number,
	v: number,
	matrix: MatrixName,
	fullRange: boolean,
	bitDepth: number,
): [number, number, number] => {
	const [kr, kb] = LUMA_COEFFICIENTS[matrix];
	const [yn, cb, cr] = normalizeYuv(y, u, v, fullRange, bitDepth);
	const r = yn + 2 * (1 - kr) * cr;
	const b = yn + 2 * (1 - kb) * cb;
	const g = (yn - kr * r - kb * b) / (1 - kr - kb);
	return [r, g, b];
};

/** Clamps a value in [0, 1] and rounds it to an 8-bit code. */
export const to8Bit = (x: number) => Math.round(255 * Math.min(Math.max(x, 0), 1));

export type ErrorStats = {
	count: number;
	maxAbs: number;
	/** Mean signed error per channel (positive when the output is larger than the reference). */
	meanSigned: [number, number, number];
	meanAbs: number;
};

export const createErrorAccumulator = () => {
	let count = 0;
	let maxAbs = 0;
	let sumAbs = 0;
	const sumSigned = [0, 0, 0];

	return {
		add: (actual: ArrayLike<number>, expected: ArrayLike<number>) => {
			for (let c = 0; c < 3; c++) {
				const difference = actual[c]! - expected[c]!;
				maxAbs = Math.max(maxAbs, Math.abs(difference));
				sumAbs += Math.abs(difference);
				sumSigned[c]! += difference;
			}
			count++;
		},
		result: (): ErrorStats => ({
			count,
			maxAbs,
			meanSigned: sumSigned.map(x => x / Math.max(count, 1)) as [number, number, number],
			meanAbs: sumAbs / Math.max(3 * count, 1),
		}),
	};
};

export type YuvFormatInfo = {
	bitDepth: number;
	/** Horizontal chroma subsampling factor */
	chromaWidth: number;
	/** Vertical chroma subsampling factor */
	chromaHeight: number;
	alpha: boolean;
	nv12: boolean;
};

export const yuvFormatInfo = (format: string): YuvFormatInfo => {
	if (format === 'NV12') {
		return { bitDepth: 8, chromaWidth: 2, chromaHeight: 2, alpha: false, nv12: true };
	}

	const match = /^I(420|422|444)(A?)(P10|P12)?$/.exec(format);
	if (!match) {
		throw new Error(`Not a YUV format: ${format}`);
	}

	return {
		bitDepth: match[3] === 'P10' ? 10 : match[3] === 'P12' ? 12 : 8,
		chromaWidth: match[1] === '444' ? 1 : 2,
		chromaHeight: match[1] === '420' ? 2 : 1,
		alpha: match[2] === 'A',
		nv12: false,
	};
};

/**
 * Builds a tightly packed YUV frame (the default WebCodecs layout) from the code values [y, u, v, a] that `pixelAt`
 * returns per pixel. Chroma is taken from the top-left pixel of each subsampled block, so callers should keep it
 * constant within blocks.
 */
export const buildYuvFrame = (
	format: string,
	width: number,
	height: number,
	pixelAt: (x: number, y: number) => readonly [number, number, number, number?],
) => {
	const info = yuvFormatInfo(format);
	const bytesPerSample = info.bitDepth > 8 ? 2 : 1;
	const chromaWidth = Math.ceil(width / info.chromaWidth);
	const chromaHeight = Math.ceil(height / info.chromaHeight);
	const chromaSize = chromaWidth * chromaHeight;
	const planeSizes = info.nv12
		? [width * height, chromaSize * 2]
		: [width * height, chromaSize, chromaSize, ...(info.alpha ? [width * height] : [])];

	const layout: { offset: number; stride: number }[] = [];
	let offset = 0;
	for (let i = 0; i < planeSizes.length; i++) {
		const stride = (i === 0 || i === 3) ? width : info.nv12 ? chromaWidth * 2 : chromaWidth;
		layout.push({ offset: offset * bytesPerSample, stride: stride * bytesPerSample });
		offset += planeSizes[i]!;
	}

	const buffer = new ArrayBuffer(offset * bytesPerSample);
	const view = bytesPerSample === 2 ? new Uint16Array(buffer) : new Uint8Array(buffer);
	const put = (plane: number, index: number, value: number) => {
		view[layout[plane]!.offset / bytesPerSample + index] = value;
	};

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [luma, , , alpha] = pixelAt(x, y);
			put(0, y * width + x, luma);
			if (info.alpha) {
				put(3, y * width + x, alpha ?? (2 ** info.bitDepth - 1));
			}
		}
	}
	for (let y = 0; y < chromaHeight; y++) {
		for (let x = 0; x < chromaWidth; x++) {
			const [, u, v] = pixelAt(x * info.chromaWidth, y * info.chromaHeight);
			if (info.nv12) {
				put(1, (y * chromaWidth + x) * 2, u);
				put(1, (y * chromaWidth + x) * 2 + 1, v);
			} else {
				put(1, y * chromaWidth + x, u);
				put(2, y * chromaWidth + x, v);
			}
		}
	}

	return { data: new Uint8Array(buffer), layout };
};
