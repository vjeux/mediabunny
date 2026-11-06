import { describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { VideoSampleSink } from '../../src/media-sink.js';
import { isFirefox } from '../../src/misc.js';
import { VideoSample } from '../../src/sample.js';
import { UrlSource } from '../../src/source.js';
import {
	buildYuvFrame,
	createErrorAccumulator,
	MatrixName,
	to8Bit,
	yuvFormatInfo,
	yuvToRgb,
} from '../node/helpers/pixels-reference.js';

// The oracle is the YUV -> R'G'B' math of ITU-T H.273 (BT.601, BT.709 and BT.2020 non-constant luminance), see
// test/node/helpers/pixels-reference.ts. Frames are made of 8x8 patches of one color each and are measured in the
// patch centers, so chroma subsampling and upsampling filters don't matter.

const YUV_FORMATS = [
	'I420', 'I420A', 'I422', 'I422A', 'I444', 'I444A', 'NV12',
	'I420P10', 'I420AP10', 'I422P10', 'I422AP10', 'I444P10', 'I444AP10',
	'I420P12', 'I420AP12', 'I422P12', 'I422AP12', 'I444P12', 'I444AP12',
];
const MATRICES: MatrixName[] = ['bt709', 'smpte170m', 'bt470bg', 'bt2020-ncl'];

const PATCH = 8;
const COLUMNS = 16;

/** 8-bit Y/Cb/Cr triplets whose colors stay inside the RGB cube for every matrix and range, so nothing clips. */
const TRIPLETS = (() => {
	const triplets: [number, number, number][] = [];
	for (const y of [32, 80, 128, 176, 224]) {
		for (const u of [80, 104, 128, 152, 176]) {
			for (const v of [80, 104, 128, 152, 176]) {
				const inside = MATRICES.every(matrix => [false, true].every((fullRange) => {
					return yuvToRgb(y, u, v, matrix, fullRange, 8).every(c => c > 0.02 && c < 0.98);
				}));
				if (inside) {
					triplets.push([y, u, v]);
				}
			}
		}
	}
	return triplets;
})();
const WIDTH = COLUMNS * PATCH;
const HEIGHT = Math.ceil(TRIPLETS.length / COLUMNS) * PATCH;
// Chrome converts frames with alpha through premultiplied colors, which loses the color under very low alpha (alpha 0
// comes out black), so the alpha values stay above that
const ALPHAS = [64, 128, 200, 255];

const supportsFormat = (format: string) => {
	try {
		const frame = new VideoFrame(new Uint8Array(4 * 4 * 4 * 2), {
			format: format as VideoPixelFormat,
			codedWidth: 4,
			codedHeight: 4,
			timestamp: 0,
		});
		frame.close();
		return true;
	} catch {
		return false;
	}
};

const testedFormats = () => YUV_FORMATS.filter((format) => {
	// Firefox's own conversion of NV12 frames reads the wrong chroma samples
	return supportsFormat(format) && !(format === 'NV12' && isFirefox());
});
const testedMatrices = () => MATRICES.filter((matrix) => {
	// Firefox converts 'bt470bg' frames with the BT.709 matrix
	return !(matrix === 'bt470bg' && isFirefox());
});

/** Code values of the patch at (x, y), scaled to the format's bit depth: [y, u, v, a]. */
const patchValues = (format: string, x: number, y: number) => {
	const { bitDepth } = yuvFormatInfo(format);
	const scale = 2 ** (bitDepth - 8);
	const index = Math.floor(y / PATCH) * COLUMNS + Math.floor(x / PATCH);
	const [yy, u, v] = TRIPLETS[index] ?? [128, 128, 128];
	const alpha = ALPHAS[index % ALPHAS.length]!;
	return [yy * scale, u * scale, v * scale, Math.round(alpha * (2 ** bitDepth - 1) / 255)] as const;
};

const makeSample = (format: string, matrix: MatrixName, fullRange: boolean) => {
	const { data, layout } = buildYuvFrame(format, WIDTH, HEIGHT, (x, y) => patchValues(format, x, y));
	return new VideoSample(data, {
		format: format as VideoPixelFormat,
		codedWidth: WIDTH,
		codedHeight: HEIGHT,
		timestamp: 0,
		layout,
		// BT.709 primaries and transfer throughout, so that only the matrix and range change the result
		colorSpace: { matrix: matrix as VideoMatrixCoefficients, primaries: 'bt709', transfer: 'bt709', fullRange },
	});
};

/**
 * Measures the patch centers of an RGBA image of a frame made by makeSample. Allows 2 LSB per channel and a mean bias
 * below 1 LSB, with two exceptions coming from Chrome's conversion: blue with the limited-range BT.709 and BT.2020
 * matrices may be off by up to 8 LSB (libyuv can't represent their Cb -> B coefficient in its 8-bit fixed-point tables
 * and clamps it), and colors under alpha may be off by another 127.5 / alpha (Chrome converts through premultiplied
 * colors).
 */
const measureColors = (
	rgba: Uint8ClampedArray | Uint8Array,
	format: string,
	matrix: MatrixName,
	fullRange: boolean,
	hasAlpha: boolean,
) => {
	const { bitDepth } = yuvFormatInfo(format);
	const errors = createErrorAccumulator();
	const maxErrors = [0, 0, 0];
	let maxExcess = 0;
	let maxAlphaError = 0;
	const blueTolerance = !fullRange && (matrix === 'bt709' || matrix === 'bt2020-ncl') ? 8 : 2;

	for (let i = 0; i < TRIPLETS.length; i++) {
		const x = (i % COLUMNS) * PATCH + PATCH / 2;
		const y = Math.floor(i / COLUMNS) * PATCH + PATCH / 2;
		const [yy, u, v, a] = patchValues(format, x, y);
		const expected = yuvToRgb(yy, u, v, matrix, fullRange, bitDepth).map(to8Bit);
		const offset = (y * WIDTH + x) * 4;
		const actual = [rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!];
		const expectedAlpha = hasAlpha ? Math.round(a * 255 / (2 ** bitDepth - 1)) : 255;
		const premultiplyRoundOff = 127.5 / expectedAlpha - 0.5;

		errors.add(actual, expected);
		for (let c = 0; c < 3; c++) {
			const error = Math.abs(actual[c]! - expected[c]!);
			const tolerance = (c === 2 ? blueTolerance : 2) + premultiplyRoundOff;
			maxErrors[c] = Math.max(maxErrors[c]!, error);
			maxExcess = Math.max(maxExcess, error - tolerance);
		}
		if (hasAlpha) {
			maxAlphaError = Math.max(maxAlphaError, Math.abs(rgba[offset + 3]! - expectedAlpha));
		}
	}

	const { meanSigned } = errors.result();
	return {
		maxExcess,
		meanSigned,
		maxAlphaError,
		withinTolerances: maxExcess <= 0 && meanSigned.every(mean => Math.abs(mean) < 1) && maxAlphaError <= 1,
		message: `${format} ${matrix} ${fullRange ? 'full' : 'limited'}: max errors ${maxErrors.join('/')}, `
			+ `mean errors ${meanSigned.map(x => x.toFixed(2)).join('/')}, max alpha error ${maxAlphaError}`,
	};
};

const expectMatchingColors = (
	rgba: Uint8ClampedArray | Uint8Array,
	format: string,
	matrix: MatrixName,
	fullRange: boolean,
	hasAlpha: boolean,
) => {
	const { maxExcess, meanSigned, maxAlphaError, message } = measureColors(rgba, format, matrix, fullRange, hasAlpha);
	expect(maxExcess, message).toBeLessThanOrEqual(0);
	for (const mean of meanSigned) {
		expect(Math.abs(mean), message).toBeLessThan(1);
	}
	expect(maxAlphaError, message).toBeLessThanOrEqual(1);
};

// WebKitGTK's VideoFrame.copyTo() doesn't convert YUV frames to RGBA, and its drawImage() converts them a few LSB off
// (beyond the tolerances above, which are Chrome's), so there, the browser can't be the reference. Both probes use the
// browser's own APIs only, never Mediabunny, so that a broken Mediabunny can't turn its tests into skips.
const nativeYuvToRgbaWorks = await (async () => {
	const frame = new VideoFrame(new Uint8Array([235, 235, 235, 235, 128, 128]), {
		format: 'I420', codedWidth: 2, codedHeight: 2, timestamp: 0,
	});
	const rgba = new Uint8Array(16);
	await frame.copyTo(rgba, { format: 'RGBA' });
	frame.close();
	return rgba[3] === 255 && rgba[7] === 255;
})();
const nativeDrawIsPrecise = (() => {
	const { data, layout } = buildYuvFrame('I420', WIDTH, HEIGHT, (x, y) => patchValues('I420', x, y));
	const frame = new VideoFrame(data, {
		format: 'I420',
		codedWidth: WIDTH,
		codedHeight: HEIGHT,
		timestamp: 0,
		layout,
		colorSpace: { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false },
	});
	const context = new OffscreenCanvas(WIDTH, HEIGHT).getContext('2d', { willReadFrequently: true })!;
	context.drawImage(frame, 0, 0);
	frame.close();
	return measureColors(context.getImageData(0, 0, WIDTH, HEIGHT).data, 'I420', 'bt709', false, false)
		.withinTolerances;
})();

describe('YUV to RGB conversion', () => {
	test.skipIf(!nativeYuvToRgbaWorks)(
		'copyTo() follows the matrix and range of every YUV format, keeping alpha straight',
		async () => {
			const formats = testedFormats();
			expect(formats).toContain('I420');

			for (const format of formats) {
				for (const matrix of testedMatrices()) {
					for (const fullRange of [false, true]) {
						using sample = makeSample(format, matrix, fullRange);
						const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
						await sample.copyTo(rgba, { format: 'RGBA', colorSpace: 'srgb' });
						expectMatchingColors(rgba, format, matrix, fullRange, yuvFormatInfo(format).alpha);
					}
				}
			}
		},
	);

	test.skipIf(!nativeDrawIsPrecise)('draw() follows the same matrices and ranges', async () => {
		const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
		const context = canvas.getContext('2d', { willReadFrequently: true })!;

		// Opaque formats only, as canvases store premultiplied colors
		for (const format of testedFormats().filter(format => !yuvFormatInfo(format).alpha)) {
			for (const matrix of testedMatrices()) {
				for (const fullRange of [false, true]) {
					using sample = makeSample(format, matrix, fullRange);
					context.clearRect(0, 0, WIDTH, HEIGHT);
					sample.draw(context, 0, 0);
					const { data } = context.getImageData(0, 0, WIDTH, HEIGHT);
					expectMatchingColors(data, format, matrix, fullRange, false);
				}
			}
		}
	});
});

test.skipIf(!nativeYuvToRgbaWorks)('Decoded colors follow the color space tagged in the file', async () => {
	// Four bars holding the limited-range BT.601 code values of red, green, blue and gray (made with FFmpeg 7.0.2):
	// ffmpeg -f lavfi -i "color=s=64x64:d=0.3:r=10,format=yuv420p,geq=lum='if(lt(X,16),81,if(lt(X,32),145,
	//   if(lt(X,48),41,128)))':cb='if(lt(X,8),90,if(lt(X,16),54,if(lt(X,24),240,128)))':cr='if(lt(X,8),240,
	//   if(lt(X,16),34,if(lt(X,24),110,128)))'" <encoder> -color_primaries P -color_trc T -colorspace M
	//   -color_range R out
	// with <encoder> = -c:v libvpx-vp9 -lossless 1, -c:v libx264 -profile:v high -qp 2, or
	// -c:v libaom-av1 -cpu-used 8 -crf 0, and the tags in the file name (tv range unless "full", then pc).
	const bars: [number, number, number][] = [[81, 90, 240], [145, 54, 34], [41, 240, 110], [128, 128, 128]];
	const files: [string, MatrixName, boolean][] = [
		['/bars-vp9-bt709.webm', 'bt709', false],
		['/bars-vp9-smpte170m.webm', 'smpte170m', false],
		['/bars-vp9-bt709-full.webm', 'bt709', true],
		['/bars-avc-bt709.mp4', 'bt709', false],
		['/bars-avc-smpte170m.mp4', 'smpte170m', false],
		['/bars-avc-bt709-full.mp4', 'bt709', true],
		['/bars-av1-bt709.mp4', 'bt709', false],
	];

	for (const [path, matrix, fullRange] of files) {
		using input = new Input({ source: new UrlSource(path), formats: ALL_FORMATS });
		const videoTrack = (await input.getPrimaryVideoTrack())!;
		if (!(await videoTrack.canDecode())) {
			continue;
		}

		const sink = new VideoSampleSink(videoTrack);
		using sample = (await sink.getSample(0))!;
		const rgba = new Uint8Array(sample.allocationSize({ format: 'RGBA' }));
		await sample.copyTo(rgba, { format: 'RGBA' });

		for (let i = 0; i < bars.length; i++) {
			const [y, u, v] = bars[i]!;
			const expected = yuvToRgb(y, u, v, matrix, fullRange, 8).map(to8Bit);
			const offset = (32 * 64 + 8 + 16 * i) * 4;
			const actual = Array.from(rgba.subarray(offset, offset + 3));
			for (let c = 0; c < 3; c++) {
				// The H.264 and AV1 files are not quite lossless
				expect(Math.abs(actual[c]! - expected[c]!), `${path} bar ${i}: ${actual.join()} vs ${expected.join()}`)
					.toBeLessThanOrEqual(3);
			}
		}
	}
});
