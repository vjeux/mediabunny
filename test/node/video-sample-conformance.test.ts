import { describe, expect, test } from 'vitest';
import {
	VIDEO_SAMPLE_PIXEL_FORMATS,
	VideoDataPlane,
	VideoSample,
	VideoSampleColorSpace,
	VideoSampleInit,
	VideoSamplePixelFormat,
	VideoSampleResource,
	VideoSampleTransformationDescription,
	registerVideoSampleTransformer,
} from '../../src/sample.js';
import { MaybePromise, SetRequired } from '../../src/misc.js';
import {
	PIXEL_FORMAT_PLANES,
	PlaneGeometry,
	layoutSize,
	referenceCopy,
	seededBytes,
	tightLayout,
} from './helpers/samples-formats.js';

const makeRaw = (
	format: VideoSamplePixelFormat,
	width: number,
	height: number,
	init: Partial<VideoSampleInit> = {},
	seed = 1,
) => {
	const data = seededBytes(layoutSize(tightLayout(format, width, height)), seed);
	const sample = new VideoSample(data, { format, codedWidth: width, codedHeight: height, timestamp: 0, ...init });
	return { data, sample };
};

const copyAll = async (sample: VideoSample, options: VideoFrameCopyToOptions = {}) => {
	const bytes = new Uint8Array(sample.allocationSize(options));
	const layout = await sample.copyTo(bytes, options);
	return { bytes, layout };
};

const toPlaneLayouts = (layout: PlaneGeometry[]) => layout.map(({ offset, stride }) => ({ offset, stride }));

const HDR_COLOR_SPACE = {
	primaries: 'bt2020' as VideoColorPrimaries,
	transfer: 'pq' as VideoTransferCharacteristics,
	matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
	fullRange: false,
};

describe('VideoSample: construction from raw data', () => {
	test('copies back the input bytes in the default layout of every pixel format', async () => {
		expect([...VIDEO_SAMPLE_PIXEL_FORMATS].sort()).toEqual(Object.keys(PIXEL_FORMAT_PLANES).sort());

		// Even widths only, odd ones differ on main (fixed on Vanilagy's bug-fix-mania branch)
		for (const format of VIDEO_SAMPLE_PIXEL_FORMATS) {
			for (const [width, height] of [[4, 4], [6, 2], [2, 3], [8, 5]]) {
				const { data, sample } = makeRaw(format, width!, height!);
				const expectedLayout = tightLayout(format, width!, height!);

				expect(sample.format).toBe(format);
				expect(sample.allocationSize()).toBe(data.byteLength);

				const { bytes, layout } = await copyAll(sample);
				expect(layout).toEqual(toPlaneLayouts(expectedLayout));
				expect(bytes).toEqual(data);
				sample.close();
			}
		}
	});

	test('reads planes through an explicit source layout with padding and reordered planes', async () => {
		// The I420 4x2 frame of WPT's videoFrame-copyTo, stored as V, U, Y with gaps and padding at the end of rows
		const data = new Uint8Array(24).fill(0xee);
		data.set([11, 12], 1); // V
		data.set([9, 10], 6); // U
		data.set([1, 2, 3, 4], 12); // Y, row 0
		data.set([5, 6, 7, 8], 18); // Y, row 1
		const layout = [{ offset: 12, stride: 6 }, { offset: 6, stride: 3 }, { offset: 1, stride: 2 }];

		using sample = new VideoSample(data, { format: 'I420', codedWidth: 4, codedHeight: 2, timestamp: 0, layout });
		const { bytes, layout: outLayout } = await copyAll(sample);
		expect(outLayout).toEqual([{ offset: 0, stride: 4 }, { offset: 8, stride: 2 }, { offset: 10, stride: 2 }]);
		expect([...bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

		// Cloning keeps the source layout
		using clone = sample.clone();
		expect([...(await copyAll(clone)).bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
	});

	test('copies the input buffer instead of referencing it', async () => {
		const data = new Uint8Array([1, 2, 3, 4]);
		using sample = new VideoSample(data, { format: 'RGBA', codedWidth: 1, codedHeight: 1, timestamp: 0 });
		data.fill(0);

		const { bytes } = await copyAll(sample);
		expect([...bytes]).toEqual([1, 2, 3, 4]);
	});

	test('accepts every kind of buffer source', async () => {
		const pixels = [10, 20, 30, 40, 50, 60, 70, 80];
		const backing = new Uint8Array([0, 0, ...pixels, 0]);
		const sources: AllowSharedBufferSource[] = [
			new Uint8Array(pixels).buffer,
			backing.subarray(2, 10),
			new DataView(backing.buffer, 2, 8),
			new Uint16Array(new Uint8Array(pixels).buffer),
		];
		if (typeof SharedArrayBuffer !== 'undefined') {
			const shared = new SharedArrayBuffer(8);
			new Uint8Array(shared).set(pixels);
			sources.push(shared);
		}

		for (const source of sources) {
			using sample = new VideoSample(source, { format: 'RGBA', codedWidth: 2, codedHeight: 1, timestamp: 0 });
			const { bytes } = await copyAll(sample);
			expect([...bytes]).toEqual(pixels);
		}
	});

	test('rejects invalid init', () => {
		const data = new Uint8Array(64);
		const valid = { format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 0 } as const;
		const invalid: Record<string, unknown>[] = [
			{ format: undefined },
			{ format: 'YUYV' },
			{ codedWidth: 0 },
			{ codedWidth: 2.5 },
			{ codedHeight: -1 },
			{ codedHeight: undefined },
			{ rotation: 45 },
			{ flip: 1 },
			{ timestamp: undefined },
			{ timestamp: NaN },
			{ timestamp: Infinity },
			{ duration: -1 },
			{ duration: NaN },
			{ layout: {} },
			{ layout: [null] },
			{ layout: [{ offset: -1, stride: 8 }] },
			{ layout: [{ offset: 0, stride: 1.5 }] },
			{ visibleRect: { left: -1, top: 0, width: 1, height: 1 } },
			{ visibleRect: { left: 0, top: 0.5, width: 1, height: 1 } },
			{ visibleRect: 'full' },
			{ displayWidth: 4 },
			{ displayWidth: 0, displayHeight: 2 },
			{ displayWidth: 2, displayHeight: 2.5 },
			{ colorSpace: { primaries: 'bt2100' } },
			{ colorSpace: { transfer: 'gamma22' } },
			{ colorSpace: { matrix: 'ycgco' } },
			{ colorSpace: { fullRange: 'yes' } },
		];

		for (const override of invalid) {
			expect(() => new VideoSample(data, { ...valid, ...override } as never), JSON.stringify(override))
				.toThrow(TypeError);
		}

		expect(() => new VideoSample(data, undefined as never)).toThrow(TypeError);
		expect(() => new VideoSample({} as never, { timestamp: 0 })).toThrow(TypeError);
	});

	test('picks the sRGB color space for RGB formats and REC709 otherwise', () => {
		// WebCodecs "Pick Color Space"
		const srgb = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true };
		const rec709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };

		for (const format of VIDEO_SAMPLE_PIXEL_FORMATS) {
			const { sample } = makeRaw(format, 2, 2);
			const isRgb = format.startsWith('RGB') || format.startsWith('BGR');
			expect(sample.colorSpace).toBeInstanceOf(VideoSampleColorSpace);
			expect(sample.colorSpace.toJSON()).toEqual(isRgb ? srgb : rec709);
			sample.close();
		}

		// An explicit color space is taken as is, including missing members
		const { sample } = makeRaw('I420', 2, 2, { colorSpace: { matrix: 'smpte170m', fullRange: true } });
		expect(sample.colorSpace.toJSON())
			.toEqual({ primaries: null, transfer: null, matrix: 'smpte170m', fullRange: true });
		sample.close();
	});

	test('derives the display size from the visible rect, rotation and explicit display size', () => {
		// Default: the visible rect, swapped for quarter turns
		for (const rotation of [0, 90, 180, 270] as const) {
			const visibleRect = { left: 0, top: 0, width: 5, height: 3 };
			const { sample } = makeRaw('RGBA', 6, 4, { rotation, visibleRect });
			const quarter = rotation % 180 !== 0;
			expect([sample.codedWidth, sample.codedHeight]).toEqual([5, 3]);
			expect([sample.squarePixelWidth, sample.squarePixelHeight]).toEqual([5, 3]);
			expect([sample.displayWidth, sample.displayHeight]).toEqual(quarter ? [3, 5] : [5, 3]);
			expect(sample.pixelAspectRatio).toEqual({ num: 1, den: 1 });
			sample.close();
		}

		// An explicit display size is the size after rotation, as with VideoFrame
		for (const rotation of [0, 90, 180, 270] as const) {
			const quarter = rotation % 180 !== 0;
			const { sample } = makeRaw('I420', 1440, 1080, {
				rotation,
				displayWidth: quarter ? 1080 : 1920,
				displayHeight: quarter ? 1920 : 1080,
			});
			expect([sample.squarePixelWidth, sample.squarePixelHeight]).toEqual([1920, 1080]);
			expect([sample.displayWidth, sample.displayHeight]).toEqual(quarter ? [1080, 1920] : [1920, 1080]);
			expect(sample.pixelAspectRatio).toEqual({ num: 4, den: 3 });
			sample.close();
		}

		// Anamorphic NTSC DV: 720x480 shown at 640x480 gives a pixel aspect ratio of 8:9
		const { sample } = makeRaw('I422', 720, 480, { displayWidth: 640, displayHeight: 480 });
		expect(sample.pixelAspectRatio).toEqual({ num: 8, den: 9 });
		sample.close();
	});

	test('keeps timing metadata in seconds and truncates microsecond getters toward zero', () => {
		const { sample } = makeRaw('RGBA', 1, 1, { timestamp: 1.0000019, duration: 1 / 30 });
		expect(sample.timestamp).toBe(1.0000019);
		expect(sample.microsecondTimestamp).toBe(1000001);
		expect(sample.microsecondDuration).toBe(33333);

		sample.setTimestamp(-0.0000019);
		expect(sample.microsecondTimestamp).toBe(-1);

		// Integer microsecond timestamps survive the trip through seconds
		for (const microseconds of [1, 3, 999999, 1000001, 33366667, 123456789, -1000001, 2 ** 40 + 7]) {
			sample.setTimestamp(microseconds / 1e6);
			expect(sample.microsecondTimestamp).toBe(microseconds);
		}

		sample.close();
	});

	test('reports whether the pixel format has an alpha channel', () => {
		for (const format of VIDEO_SAMPLE_PIXEL_FORMATS) {
			const { sample } = makeRaw(format, 2, 2);
			const hasAlphaPlane = PIXEL_FORMAT_PLANES[format]!.length === 4 || format === 'RGBA' || format === 'BGRA';
			expect(!!sample.hasAlpha, format).toBe(hasAlphaPlane);
			sample.close();
		}
	});

	test('validates metadata setters', () => {
		const { sample } = makeRaw('RGBA', 1, 1);

		expect(() => sample.setRotation(45 as never)).toThrow(TypeError);
		expect(() => sample.setFlip(1 as never)).toThrow(TypeError);
		expect(() => sample.setTimestamp(NaN)).toThrow(TypeError);
		expect(() => sample.setDuration(-1)).toThrow(TypeError);
		expect(() => sample.setEncodeOptions(null as never)).toThrow(TypeError);

		sample.setRotation(270);
		sample.setFlip(true);
		sample.setTimestamp(-2);
		sample.setDuration(0.5);
		sample.setEncodeOptions({ keyFrame: true });
		expect([sample.rotation, sample.flip, sample.timestamp, sample.duration]).toEqual([270, true, -2, 0.5]);
		expect(sample.encodeOptions).toEqual({ keyFrame: true });
		sample.close();
	});
});

// Ported from WPT webcodecs/videoFrame-copyTo.any.js and videoFrame-copyTo-chroma-subsampling.any.js, using
// ArrayBuffer-backed samples (Mediabunny's own copy implementation) instead of VideoFrames
describe('VideoSample: allocationSize and copyTo (WPT ports)', () => {
	const I420_DATA = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
	const makeI420 = () => new VideoSample(new Uint8Array(I420_DATA), {
		format: 'I420',
		codedWidth: 4,
		codedHeight: 2,
		timestamp: 0,
	});

	test('copies an I420 frame into every kind of destination', async () => {
		using sample = makeI420();
		expect(sample.allocationSize()).toBe(12);

		const destinations: AllowSharedBufferSource[] = [
			new ArrayBuffer(12),
			new Uint8Array(12),
			new DataView(new ArrayBuffer(12)),
		];
		if (typeof SharedArrayBuffer !== 'undefined') {
			destinations.push(new SharedArrayBuffer(12));
		}
		for (const destination of destinations) {
			const layout = await sample.copyTo(destination);
			expect(layout).toEqual([{ offset: 0, stride: 4 }, { offset: 8, stride: 2 }, { offset: 10, stride: 2 }]);
			const bytes = ArrayBuffer.isView(destination)
				? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
				: new Uint8Array(destination);
			expect([...bytes]).toEqual(I420_DATA);
		}

		// Into a view that starts in the middle of a buffer
		const backing = new Uint8Array(20);
		await sample.copyTo(backing.subarray(5, 17));
		expect([...backing.subarray(5, 17)]).toEqual(I420_DATA);
		expect([...backing.subarray(0, 5), ...backing.subarray(17)]).toEqual(new Array(8).fill(0));

		await expect(sample.copyTo([] as never)).rejects.toThrow(TypeError);
	});

	test('copies RGBA and NV12 frames', async () => {
		const rgba = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
		using rgbaSample = new VideoSample(new Uint8Array(rgba), {
			format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 0,
		});
		const rgbaCopy = await copyAll(rgbaSample);
		expect(rgbaCopy.layout).toEqual([{ offset: 0, stride: 8 }]);
		expect([...rgbaCopy.bytes]).toEqual(rgba);

		using nv12Sample = new VideoSample(new Uint8Array(I420_DATA), {
			format: 'NV12', codedWidth: 4, codedHeight: 2, timestamp: 0,
		});
		const nv12Copy = await copyAll(nv12Sample);
		expect(nv12Copy.layout).toEqual([{ offset: 0, stride: 4 }, { offset: 8, stride: 4 }]);
		expect([...nv12Copy.bytes]).toEqual(I420_DATA);
	});

	test('rejects an undersized destination', async () => {
		using sample = makeI420();
		await expect(sample.copyTo(new Uint8Array(11))).rejects.toThrow(TypeError);
	});

	test('rejects a layout with the wrong plane count', async () => {
		using sample = makeI420();
		const options = { layout: [{ offset: 0, stride: 4 }] };
		expect(() => sample.allocationSize(options)).toThrow(TypeError);
		await expect(sample.copyTo(new Uint8Array(12), options)).rejects.toThrow(TypeError);
	});

	test('writes planes at the requested offsets and strides', async () => {
		using sample = makeI420();

		// Reordered planes
		const reordered = { layout: [{ offset: 4, stride: 4 }, { offset: 0, stride: 2 }, { offset: 2, stride: 2 }] };
		expect(sample.allocationSize(reordered)).toBe(12);
		const reorderedBytes = new Uint8Array(12);
		expect(await sample.copyTo(reorderedBytes, reordered)).toEqual(reordered.layout);
		expect([...reorderedBytes]).toEqual([9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8]);

		// With padding, which must stay untouched
		const padded = { layout: [{ offset: 9, stride: 5 }, { offset: 1, stride: 3 }, { offset: 5, stride: 3 }] };
		expect(sample.allocationSize(padded)).toBe(19);
		const paddedBytes = new Uint8Array(19).fill(0xaa);
		expect(await sample.copyTo(paddedBytes, padded)).toEqual(padded.layout);
		const P = 0xaa;
		expect([...paddedBytes]).toEqual([
			P, 9, 10, P, P, 11, 12, P, P,
			1, 2, 3, 4, P,
			5, 6, 7, 8, P,
		]);
	});

	test('writes I420A and NV12 planes at the requested offsets', async () => {
		using i420a = new VideoSample(new Uint8Array([
			1, 2, 3, 4, 5, 6, 7, 8, // y
			9, 10, // u
			11, 12, // v
			13, 14, 15, 16, 17, 18, 19, 20, // a
		]), { format: 'I420A', codedWidth: 4, codedHeight: 2, timestamp: 0 });
		const i420aOptions = {
			layout: [
				{ offset: 12, stride: 4 },
				{ offset: 8, stride: 2 },
				{ offset: 10, stride: 2 },
				{ offset: 0, stride: 4 },
			],
		};
		const i420aBytes = new Uint8Array(i420a.allocationSize(i420aOptions));
		expect(await i420a.copyTo(i420aBytes, i420aOptions)).toEqual(i420aOptions.layout);
		expect([...i420aBytes]).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8]);

		using nv12 = new VideoSample(new Uint8Array(I420_DATA), {
			format: 'NV12', codedWidth: 4, codedHeight: 2, timestamp: 0,
		});
		const nv12Options = { layout: [{ offset: 4, stride: 4 }, { offset: 0, stride: 4 }] };
		const nv12Bytes = new Uint8Array(nv12.allocationSize(nv12Options));
		expect(await nv12.copyTo(nv12Bytes, nv12Options)).toEqual(nv12Options.layout);
		expect([...nv12Bytes]).toEqual([9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8]);
	});

	test('rejects too small strides, overlapping planes and overflowing offsets', async () => {
		using sample = makeI420();
		const invalidLayouts = [
			[{ offset: 0, stride: 1 }, { offset: 8, stride: 2 }, { offset: 10, stride: 2 }],
			[{ offset: 0, stride: 4 }, { offset: 8, stride: 1 }, { offset: 10, stride: 2 }],
			[{ offset: 0, stride: 4 }, { offset: 7, stride: 2 }, { offset: 10, stride: 2 }],
			[{ offset: 0, stride: 4 }, { offset: 8, stride: 2 }, { offset: 8, stride: 2 }],
			[{ offset: 2, stride: 4 }, { offset: 1, stride: 2 }, { offset: 10, stride: 2 }],
			[{ offset: 0, stride: 4 }, { offset: 8, stride: 2 }, { offset: 2 ** 32 - 2, stride: 2 }],
		];

		for (const layout of invalidLayouts) {
			expect(() => sample.allocationSize({ layout }), JSON.stringify(layout)).toThrow(TypeError);
			await expect(sample.copyTo(new Uint8Array(64), { layout })).rejects.toThrow(TypeError);
		}

		// Planes that only touch don't overlap
		expect(sample.allocationSize({
			layout: [{ offset: 4, stride: 4 }, { offset: 12, stride: 2 }, { offset: 2, stride: 2 }],
		})).toBe(14);
	});

	test('copies a rect of the frame', async () => {
		using sample = makeI420();

		// The full coded rect
		const full = await copyAll(sample, { rect: { x: 0, y: 0, width: 4, height: 2 } });
		expect([...full.bytes]).toEqual(I420_DATA);

		// Left crop
		const crop = await copyAll(sample, { rect: { x: 2, y: 0, width: 2, height: 2 } });
		expect(crop.layout).toEqual([{ offset: 0, stride: 2 }, { offset: 4, stride: 1 }, { offset: 5, stride: 1 }]);
		expect([...crop.bytes]).toEqual([3, 4, 7, 8, 10, 12]);

		// Empty and out-of-bounds rects
		for (const rect of [
			{ x: 0, y: 0, width: 4, height: 0 },
			{ x: 0, y: 0, width: 0, height: 2 },
			{ x: 0, y: 0, width: 4, height: 4 },
			{ x: 2, y: 0, width: 4, height: 2 },
		]) {
			expect(() => sample.allocationSize({ rect }), JSON.stringify(rect)).toThrow(TypeError);
			await expect(sample.copyTo(new Uint8Array(64), { rect })).rejects.toThrow(TypeError);
		}
	});

	test('requires rect offsets to be aligned to the chroma sub-sampling', () => {
		const sizes = (format: VideoSamplePixelFormat, rect: DOMRectInit) => {
			const { sample } = makeRaw(format, 4, 2);
			try {
				return sample.allocationSize({ rect });
			} finally {
				sample.close();
			}
		};

		// videoFrame-copyTo-chroma-subsampling: allocation sizes of a 4x2 frame
		expect(sizes('I420', { x: 0, y: 0, width: 4, height: 2 })).toBe(4 * 2 + 2 + 2);
		expect(sizes('I422', { x: 0, y: 0, width: 4, height: 2 })).toBe(4 * 2 + 2 * 2 * 2);
		expect(sizes('I444', { x: 0, y: 0, width: 4, height: 2 })).toBe(4 * 2 * 3);

		// I422 allows an odd y but not an odd x; I444 allows any offset; I420 and NV12 neither
		expect(sizes('I422', { x: 0, y: 1, width: 4, height: 1 })).toBe(4 + 2 + 2);
		expect(() => sizes('I422', { x: 1, y: 0, width: 2, height: 2 })).toThrow(TypeError);
		expect(sizes('I444', { x: 1, y: 1, width: 3, height: 1 })).toBe(3 * 3);
		expect(sizes('RGBA', { x: 1, y: 1, width: 3, height: 1 })).toBe(3 * 4);
		for (const format of ['I420', 'I420AP10', 'NV12'] as const) {
			expect(() => sizes(format, { x: 1, y: 0, width: 2, height: 2 })).toThrow(TypeError);
			expect(() => sizes(format, { x: 0, y: 1, width: 2, height: 1 })).toThrow(TypeError);
		}
	});

	test('copies arbitrary aligned rects of every pixel format into tight and padded layouts', async () => {
		let seed = 1;
		for (const format of VIDEO_SAMPLE_PIXEL_FORMATS) {
			const planes = PIXEL_FORMAT_PLANES[format]!;
			const subX = Math.max(...planes.map(plane => plane.subX));
			const subY = Math.max(...planes.map(plane => plane.subY));
			const { data, sample } = makeRaw(format, 8, 6, {}, seed++);
			const sourceLayout = tightLayout(format, 8, 6);

			for (const rect of [
				{ x: 0, y: 0, width: 8, height: 6 },
				{ x: subX, y: subY, width: 4, height: 3 },
				{ x: 2 * subX, y: 0, width: 2, height: 1 },
				{ x: 8 - 2, y: 6 - subY, width: 2, height: subY },
			]) {
				const expected = referenceCopy(format, data, sourceLayout, rect);
				const tight = await copyAll(sample, { rect });
				expect(tight.bytes, `${format} ${JSON.stringify(rect)}`).toEqual(expected);
				expect(tight.layout).toEqual(toPlaneLayouts(tightLayout(format, rect.width, rect.height)));

				// The same rect into a layout with a leading gap and row padding
				const destLayout = tightLayout(format, rect.width, rect.height).map((plane, i) => ({
					offset: 3 + 2 * plane.offset + 5 * i,
					stride: plane.stride + 3,
				}));
				const padded = new Uint8Array(sample.allocationSize({ rect, layout: destLayout })).fill(0xaa);
				expect(await sample.copyTo(padded, { rect, layout: destLayout })).toEqual(destLayout);
				const reference = new Uint8Array(padded.byteLength).fill(0xaa);
				const tightPlanes = tightLayout(format, rect.width, rect.height);
				tightPlanes.forEach((plane, i) => {
					for (let row = 0; row < plane.rows; row++) {
						const start = plane.offset + row * plane.stride;
						reference.set(
							expected.subarray(start, start + plane.stride),
							destLayout[i]!.offset + row * destLayout[i]!.stride,
						);
					}
				});
				expect(padded, `${format} padded ${JSON.stringify(rect)}`).toEqual(reference);
			}

			sample.close();
		}
	});

	test('converts between RGB formats by swapping channels and making X opaque', async () => {
		const pixels = [10, 20, 30, 40, 50, 60, 70, 80];
		for (const from of ['RGBA', 'RGBX', 'BGRA', 'BGRX'] as const) {
			using sample = new VideoSample(new Uint8Array(pixels), {
				format: from, codedWidth: 2, codedHeight: 1, timestamp: 0,
			});
			for (const to of ['RGBA', 'RGBX', 'BGRA', 'BGRX'] as const) {
				const swap = from[0] !== to[0];
				const opaque = from.endsWith('X') && to.endsWith('A');
				const expected = [0, 4].flatMap(i => [
					pixels[i + (swap ? 2 : 0)]!,
					pixels[i + 1]!,
					pixels[i + (swap ? 0 : 2)]!,
					opaque ? 255 : pixels[i + 3]!,
				]);
				expect(sample.allocationSize({ format: to })).toBe(8);
				const { bytes, layout } = await copyAll(sample, { format: to });
				expect(layout).toEqual([{ offset: 0, stride: 8 }]);
				expect([...bytes], `${from} -> ${to}`).toEqual(expected);
			}
		}
	});

	test('sizes RGB conversions of YUV frames, but needs VideoFrame to perform them', async () => {
		const { sample } = makeRaw('I420', 4, 2);
		expect(sample.allocationSize({ format: 'RGBA' })).toBe(4 * 2 * 4);
		expect(sample.allocationSize({ format: 'BGRX', rect: { x: 2, y: 0, width: 2, height: 2 } })).toBe(2 * 2 * 4);
		await expect(sample.copyTo(new Uint8Array(32), { format: 'RGBA' })).rejects.toThrow('VideoFrame');

		// Converting into another YUV format isn't supported
		expect(() => sample.allocationSize({ format: 'I444' })).toThrow();
		await expect(sample.copyTo(new Uint8Array(64), { format: 'NV12' })).rejects.toThrow();
		sample.close();
	});

	test('validates copy options', async () => {
		using sample = makeI420();
		const invalidOptions: unknown[] = [
			null,
			'rect',
			{ colorSpace: 'rec2020' },
			{ format: 1 },
			{ layout: {} },
			{ layout: [null, null, null] },
			{ layout: [{ offset: -1, stride: 4 }, { offset: 8, stride: 2 }, { offset: 10, stride: 2 }] },
			{ layout: [{ offset: 0, stride: 4.5 }, { offset: 8, stride: 2 }, { offset: 10, stride: 2 }] },
			{ rect: 'all' },
			{ rect: { x: -2, y: 0, width: 2, height: 2 } },
			{ rect: { x: 0, y: 0, width: 2.5, height: 2 } },
		];

		for (const options of invalidOptions) {
			expect(() => sample.allocationSize(options as never), JSON.stringify(options)).toThrow(TypeError);
			await expect(sample.copyTo(new Uint8Array(64), options as never)).rejects.toThrow(TypeError);
		}
	});
});

describe('VideoSample: lifecycle', () => {
	test('close() is idempotent and makes data access throw', async () => {
		const { sample } = makeRaw('I420', 4, 2);
		sample.close();
		sample.close();
		sample[Symbol.dispose]();

		expect(() => sample.allocationSize()).toThrow('VideoSample is closed.');
		await expect(sample.copyTo(new Uint8Array(12))).rejects.toThrow('VideoSample is closed.');
		expect(() => sample.clone()).toThrow('VideoSample is closed.');
		expect(() => sample.toVideoFrame()).toThrow('VideoSample is closed.');
		expect(() => sample.toCanvasImageSource()).toThrow('VideoSample is closed.');

		// Metadata stays readable
		expect([sample.format, sample.codedWidth, sample.codedHeight]).toEqual(['I420', 4, 2]);
	});

	test('clone() keeps all metadata and outlives the original', async () => {
		const { data, sample } = makeRaw('I422', 6, 4, {
			timestamp: 1.5,
			duration: 0.25,
			rotation: 90,
			flip: true,
			visibleRect: { left: 0, top: 0, width: 6, height: 3 },
			displayWidth: 3,
			displayHeight: 12,
			colorSpace: HDR_COLOR_SPACE,
			encodeOptions: { keyFrame: true },
		});
		const clone = sample.clone();
		sample.close();

		expect(clone.format).toBe('I422');
		expect(clone.visibleRect).toEqual({ left: 0, top: 0, width: 6, height: 3 });
		expect([clone.timestamp, clone.duration, clone.rotation, clone.flip]).toEqual([1.5, 0.25, 90, true]);
		expect([clone.squarePixelWidth, clone.squarePixelHeight]).toEqual([12, 3]);
		expect([clone.displayWidth, clone.displayHeight]).toEqual([3, 12]);
		expect(clone.pixelAspectRatio).toEqual({ num: 2, den: 1 });
		expect(clone.colorSpace.toJSON()).toEqual(HDR_COLOR_SPACE);
		expect(clone.encodeOptions).toEqual({ keyFrame: true });

		const { bytes } = await copyAll(clone);
		const visible = { x: 0, y: 0, width: 6, height: 3 };
		expect(bytes).toEqual(referenceCopy('I422', data, tightLayout('I422', 6, 4), visible));
		clone.close();
	});
});

class PlanesResource extends VideoSampleResource {
	closeCount = 0;
	rgbRequests: { init: SetRequired<VideoSampleInit, 'timestamp'>; colorSpace: PredefinedColorSpace }[] = [];
	toRgbResult: (() => unknown) | null = null;

	constructor(
		public format: VideoSamplePixelFormat | null,
		public width: number,
		public height: number,
		public planes: () => MaybePromise<VideoDataPlane[]>,
		public squarePixelSize: [number, number] = [width, height],
	) {
		super();
	}

	getFormat() {
		return this.format;
	}

	getCodedWidth() {
		return this.width;
	}

	getCodedHeight() {
		return this.height;
	}

	getSquarePixelWidth() {
		return this.squarePixelSize[0];
	}

	getSquarePixelHeight() {
		return this.squarePixelSize[1];
	}

	getColorSpace() {
		return new VideoSampleColorSpace({ primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m' });
	}

	getDataPlanes() {
		return this.planes();
	}

	toRgbSample(init: SetRequired<VideoSampleInit, 'timestamp'>, colorSpace: PredefinedColorSpace) {
		this.rgbRequests.push({ init, colorSpace });
		if (this.toRgbResult) {
			return this.toRgbResult() as VideoSample;
		}

		return new VideoSample(new Uint8Array(this.width * this.height * 4).fill(7), {
			...init,
			format: 'RGBX',
			codedWidth: this.width,
			codedHeight: this.height,
		});
	}

	close() {
		this.closeCount++;
	}
}

describe('VideoSample: custom resources', () => {
	const paddedPlanes = (format: VideoSamplePixelFormat, width: number, height: number, seed: number) => {
		// Each plane gets 3 bytes of row padding
		const tight = tightLayout(format, width, height);
		const data = seededBytes(layoutSize(tight), seed);
		const planes = tight.map((plane) => {
			const padded = new Uint8Array((plane.stride + 3) * plane.rows).fill(0xee);
			for (let row = 0; row < plane.rows; row++) {
				const start = plane.offset + row * plane.stride;
				padded.set(data.subarray(start, start + plane.stride), row * (plane.stride + 3));
			}
			return { data: padded, stride: plane.stride + 3 };
		});
		return { data, tight, planes };
	};

	test('takes metadata from the resource and copies from its planes', async () => {
		for (const format of ['I420', 'NV12', 'I444AP12', 'BGRA'] as const) {
			const { data, tight, planes } = paddedPlanes(format, 6, 4, 3);
			for (const async of [false, true]) {
				const getPlanes = () => (async ? Promise.resolve(planes) : planes);
				const resource = new PlanesResource(format, 6, 4, getPlanes, [12, 4]);
				using sample = new VideoSample(resource, { timestamp: 2, duration: 1, rotation: 180 });
				expect(sample.format).toBe(format);
				expect([sample.codedWidth, sample.codedHeight]).toEqual([6, 4]);
				expect([sample.displayWidth, sample.displayHeight]).toEqual([12, 4]);
				expect(sample.pixelAspectRatio).toEqual({ num: 2, den: 1 });
				expect(sample.colorSpace.matrix).toBe('smpte170m');

				expect(sample.allocationSize()).toBe(data.byteLength);
				const { bytes } = await copyAll(sample);
				expect(bytes).toEqual(data);

				const rect = { x: 2, y: 2, width: 4, height: 2 };
				expect((await copyAll(sample, { rect })).bytes).toEqual(referenceCopy(format, data, tight, rect));
			}
		}
	});

	test('closes the resource when the last sample using it is closed', () => {
		const resource = new PlanesResource('RGBA', 1, 1, () => [{ data: new Uint8Array(4), stride: 4 }]);
		const sample = new VideoSample(resource, { timestamp: 0 });
		const clone = sample.clone();
		const other = new VideoSample(resource, { timestamp: 1 });

		sample.close();
		clone.close();
		expect(resource.closeCount).toBe(0);
		other.close();
		other.close();
		expect(resource.closeCount).toBe(1);
	});

	test('rejects invalid resource metadata', () => {
		const make = (override: Partial<PlanesResource>) => {
			const resource = new PlanesResource('RGBA', 2, 2, () => []);
			Object.assign(resource, override);
			return () => new VideoSample(resource, { timestamp: 0 });
		};

		expect(make({ format: 'YUY2' as never })).toThrow(TypeError);
		expect(make({ width: 0 })).toThrow(TypeError);
		expect(make({ height: 1.5 })).toThrow(TypeError);
		expect(make({ squarePixelSize: [0, 2] })).toThrow(TypeError);
		expect(make({ squarePixelSize: [2, NaN] })).toThrow(TypeError);

		const resource = new PlanesResource('RGBA', 2, 2, () => []);
		expect(() => new VideoSample(resource, {} as never)).toThrow(TypeError);
		expect(() => new VideoSample(resource, { timestamp: 0, rotation: 30 as never })).toThrow(TypeError);
		expect(() => new VideoSample(resource, { timestamp: 0, duration: -1 })).toThrow(TypeError);
	});

	test('rejects invalid data planes', async () => {
		for (const planes of [
			{} as never,
			[{ data: [1, 2, 3, 4], stride: 4 }] as never,
			[{ data: new Uint8Array(4), stride: -4 }],
			[{ data: new Uint8Array(4), stride: 4.5 }],
		]) {
			using sample = new VideoSample(new PlanesResource('RGBA', 1, 1, () => planes), { timestamp: 0 });
			await expect(sample.copyTo(new Uint8Array(4))).rejects.toThrow(TypeError);
		}
	});

	test('converts to RGB through toRgbSample()', async () => {
		const resource = new PlanesResource('I420', 2, 2, () => [
			{ data: new Uint8Array(4), stride: 2 },
			{ data: new Uint8Array(1), stride: 1 },
			{ data: new Uint8Array(1), stride: 1 },
		]);
		using sample = new VideoSample(resource, { timestamp: 3, duration: 0.5, rotation: 90, flip: true });

		const dest = new Uint8Array(16);
		expect(await sample.copyTo(dest, { format: 'RGBA' })).toEqual([{ offset: 0, stride: 8 }]);
		// RGBX came back, so the X channel is made opaque
		expect([...dest]).toEqual([7, 7, 7, 255, 7, 7, 7, 255, 7, 7, 7, 255, 7, 7, 7, 255]);
		await sample.copyTo(dest, { format: 'BGRX', colorSpace: 'display-p3' });

		expect(resource.rgbRequests).toEqual([
			{ init: { timestamp: 3, duration: 0.5, rotation: 90, flip: true }, colorSpace: 'srgb' },
			{ init: { timestamp: 3, duration: 0.5, rotation: 90, flip: true }, colorSpace: 'display-p3' },
		]);

		// The RGB sample is closed after the copy
		let rgbSample: VideoSample | null = null;
		resource.toRgbResult = () => {
			rgbSample = new VideoSample(new Uint8Array(16), {
				format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 3,
			});
			return rgbSample;
		};
		await sample.copyTo(dest, { format: 'RGBA' });
		expect(() => rgbSample!.allocationSize()).toThrow('VideoSample is closed.');

		resource.toRgbResult = () => ({ format: 'RGBA' });
		await expect(sample.copyTo(dest, { format: 'RGBA' })).rejects.toThrow(TypeError);

		resource.toRgbResult = () => new VideoSample(new Uint8Array(6), {
			format: 'I420', codedWidth: 2, codedHeight: 2, timestamp: 3,
		});
		await expect(sample.copyTo(dest, { format: 'RGBA' })).rejects.toThrow('RGB format');
	});

	test('requires a format to copy data from a resource without a pixel format', async () => {
		const resource = new PlanesResource(null, 2, 2, () => []);
		using sample = new VideoSample(resource, { timestamp: 0 });
		expect(sample.format).toBe(null);
		expect(sample.hasAlpha).toBeFalsy();

		expect(() => sample.allocationSize()).toThrow('format is null');
		await expect(sample.copyTo(new Uint8Array(16))).rejects.toThrow('format is null');

		expect(sample.allocationSize({ format: 'RGBA' })).toBe(16);
		const dest = new Uint8Array(16);
		await sample.copyTo(dest, { format: 'RGBA' });
		expect(dest[0]).toBe(7);
	});
});

describe('VideoSample: transformation descriptions', () => {
	// Transformers are global, so this one only handles samples with a marker timestamp
	const MARKER = 4242;
	const descriptions: VideoSampleTransformationDescription[] = [];
	const transformer = async (sample: VideoSample, description: VideoSampleTransformationDescription) => {
		if (sample.timestamp !== MARKER) {
			return null;
		}

		descriptions.push(description);
		return new VideoSample(new Uint8Array(4), { format: 'RGBA', codedWidth: 1, codedHeight: 1, timestamp: 1 });
	};
	registerVideoSampleTransformer(transformer);
	registerVideoSampleTransformer(transformer); // No-op

	const describeTransform = async (sampleInit: Partial<VideoSampleInit>, options: object) => {
		const width = sampleInit.codedWidth ?? 1920;
		const height = sampleInit.codedHeight ?? 1080;
		using sample = new VideoSample(new Uint8Array(width * height * 4), {
			format: 'RGBA', codedWidth: width, codedHeight: height, ...sampleInit, timestamp: MARKER,
		});
		descriptions.length = 0;
		using result = await sample.transform(options);
		expect(result.timestamp).toBe(1);
		expect(descriptions).toHaveLength(1);
		return descriptions[0]!;
	};

	test('describes the identity transform', async () => {
		expect(await describeTransform({}, {})).toEqual({
			width: 1920,
			height: 1080,
			fit: 'fill',
			rotation: 0,
			flip: false,
			crop: { left: 0, top: 0, width: 1920, height: 1080 },
			alpha: 'keep',
		});
	});

	test('composes the requested rotation and flip with the sample\'s own', async () => {
		// Rotate first, then flip: a flip conjugates any rotation that comes after it
		for (const rotation of [0, 90, 180, 270] as const) {
			for (const flip of [false, true]) {
				for (const rotate of [0, 90, 180, 270] as const) {
					for (const extraFlip of [false, true]) {
						const description = await describeTransform({ rotation, flip }, { rotate, flip: extraFlip });
						const expectedRotation = (((rotation + (flip ? -rotate : rotate)) % 360) + 360) % 360;
						const quarter = expectedRotation % 180 !== 0;
						expect(description.rotation).toBe(expectedRotation);
						expect(description.flip).toBe(flip !== extraFlip);
						expect([description.width, description.height]).toEqual(quarter ? [1080, 1920] : [1920, 1080]);
						expect(description.crop).toEqual({
							left: 0, top: 0, width: quarter ? 1080 : 1920, height: quarter ? 1920 : 1080,
						});
					}
				}
			}
		}
	});

	test('normalizes the pixel aspect ratio', async () => {
		// 1440x1080 shown as 1920x1080
		const description = await describeTransform(
			{ codedWidth: 1440, codedHeight: 1080, displayWidth: 1920, displayHeight: 1080 },
			{ rotate: 90 },
		);
		expect([description.width, description.height]).toEqual([1080, 1920]);
	});

	test('clamps the crop rectangle to the rotated frame', async () => {
		expect((await describeTransform({}, { crop: { left: 1800, top: 1000, width: 500, height: 500 } })).crop)
			.toEqual({ left: 1800, top: 1000, width: 120, height: 80 });
		const rotatedCrop = { left: 0, top: 1800, width: 2000, height: 500 };
		expect((await describeTransform({}, { rotate: 90, crop: rotatedCrop })).crop)
			.toEqual({ left: 0, top: 1800, width: 1080, height: 120 });
		expect(await describeTransform({}, { crop: { left: 100, top: 50, width: 640, height: 360 } }))
			.toMatchObject({ width: 640, height: 360, crop: { left: 100, top: 50, width: 640, height: 360 } });
	});

	test('derives a missing dimension from the aspect ratio of the cropped frame', async () => {
		expect(await describeTransform({}, { width: 640 })).toMatchObject({ width: 640, height: 360 });
		expect(await describeTransform({}, { height: 480 })).toMatchObject({ width: 853, height: 480 });
		expect(await describeTransform({}, { width: 101 })).toMatchObject({ width: 101, height: 57 });
		expect(await describeTransform({}, { width: 100, crop: { left: 0, top: 0, width: 400, height: 100 } }))
			.toMatchObject({ width: 100, height: 25 });
		expect(await describeTransform({}, { width: 540, rotate: 270 })).toMatchObject({ width: 540, height: 960 });
		expect(await describeTransform({}, { width: 300, height: 100, fit: 'contain' }))
			.toMatchObject({ width: 300, height: 100, fit: 'contain' });
	});

	test('rounds dimensions to the nearest multiple of roundDimensionsTo', async () => {
		expect(await describeTransform({}, { height: 480, roundDimensionsTo: 2 }))
			.toMatchObject({ width: 854, height: 480 });
		expect(await describeTransform({ codedWidth: 1918, codedHeight: 1078 }, { roundDimensionsTo: 16 }))
			.toMatchObject({ width: 1920, height: 1072 });
		expect(await describeTransform({}, { crop: { left: 0, top: 0, width: 33, height: 17 }, roundDimensionsTo: 4 }))
			.toMatchObject({ width: 32, height: 16, crop: { left: 0, top: 0, width: 33, height: 17 } });
	});

	test('passes alpha and fit through', async () => {
		expect(await describeTransform({}, { alpha: 'discard' })).toMatchObject({ alpha: 'discard', fit: 'fill' });
		expect(await describeTransform({}, { width: 10, height: 10, fit: 'cover' })).toMatchObject({ fit: 'cover' });
	});

	test('validates options', async () => {
		using sample = new VideoSample(new Uint8Array(4), {
			format: 'RGBA', codedWidth: 1, codedHeight: 1, timestamp: MARKER,
		});
		for (const options of [
			null,
			{ width: 0 },
			{ height: 1.5 },
			{ roundDimensionsTo: 0 },
			{ fit: 'stretch' },
			{ width: 10, height: 10 },
			{ rotate: 45 },
			{ flip: 'yes' },
			{ crop: { left: -1, top: 0, width: 1, height: 1 } },
			{ crop: { left: 0, top: 0, width: 1.5, height: 1 } },
			{ alpha: 'premultiply' },
		]) {
			await expect(sample.transform(options as never), JSON.stringify(options)).rejects.toThrow(TypeError);
		}
	});

	test('falls back to canvases when no transformer takes the sample, which Node doesn\'t have', async () => {
		using sample = new VideoSample(new Uint8Array(4), {
			format: 'RGBA', codedWidth: 1, codedHeight: 1, timestamp: 0,
		});
		await expect(sample.transform({})).rejects.toThrow('registerVideoSampleTransformer');
	});
});

describe('VideoSampleColorSpace', () => {
	test('defaults every member to null', () => {
		const empty = { primaries: null, transfer: null, matrix: null, fullRange: null };
		expect(new VideoSampleColorSpace().toJSON()).toEqual(empty);
		expect(new VideoSampleColorSpace({}).toJSON()).toEqual(empty);
	});

	test('accepts every WebCodecs value and rejects others', () => {
		const values = {
			primaries: ['bt709', 'bt470bg', 'smpte170m', 'bt2020', 'smpte432'],
			transfer: ['bt709', 'smpte170m', 'iec61966-2-1', 'linear', 'pq', 'hlg'],
			matrix: ['rgb', 'bt709', 'bt470bg', 'smpte170m', 'bt2020-ncl'],
		};
		for (const [key, list] of Object.entries(values)) {
			for (const value of list) {
				expect(new VideoSampleColorSpace({ [key]: value }).toJSON()[key as 'matrix']).toBe(value);
			}
			expect(() => new VideoSampleColorSpace({ [key]: 'unspecified' })).toThrow(TypeError);
		}
		expect(new VideoSampleColorSpace({ fullRange: false }).fullRange).toBe(false);
		expect(() => new VideoSampleColorSpace({ fullRange: 0 as never })).toThrow(TypeError);
		expect(() => new VideoSampleColorSpace(null as never)).toThrow(TypeError);
	});
});
