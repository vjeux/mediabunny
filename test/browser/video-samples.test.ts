import { expect, test } from 'vitest';
import { VideoSample, registerVideoSampleTransformer } from '../../src/sample.js';
import { VideoSampleSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Quality } from '../../src/encode.js';
import { PacketType } from '../../src/packet.js';
import { Rotation } from '../../src/misc.js';

test('allocationSize', async () => {
	{
		const canvas = new OffscreenCanvas(1280, 720);
		canvas.getContext('2d');

		using sample = new VideoSample(canvas, { timestamp: 0 });

		const size1 = sample.allocationSize();
		expect(size1).toBe(1280 * 720 * 4);

		const size2 = sample.allocationSize({
			layout: [{
				offset: 0,
				stride: 1300 * 4,
			}],
		});
		expect(size2).toBe(1300 * 720 * 4);
	}

	{
		const data = new Uint8Array(1280 * 720 * 4);
		using sample = new VideoSample(data, {
			timestamp: 0,
			codedWidth: 1280,
			codedHeight: 720,
			format: 'RGBA',
		});

		const size1 = sample.allocationSize();
		expect(size1).toBe(1280 * 720 * 4);

		const size2 = sample.allocationSize({
			layout: [{
				offset: 0,
				stride: 1300 * 4,
			}],
		});
		expect(size2).toBe(1300 * 720 * 4);
	}

	{
		const data = new Uint8Array(1280 * 720 * 1.5);
		using sample = new VideoSample(data, {
			timestamp: 0,
			codedWidth: 1280,
			codedHeight: 720,
			format: 'I420',
		});

		const size1 = sample.allocationSize();
		expect(size1).toBe(1280 * 720 * 1.5);

		const size2 = sample.allocationSize({ format: 'RGBA' });
		expect(size2).toBe(1280 * 720 * 4);

		const size3 = sample.allocationSize({
			format: 'RGBA',
			layout: [{
				offset: 0,
				stride: 1300 * 4,
			}],
		});
		expect(size3).toBe(1300 * 720 * 4);
	}
});

test('copyTo and plane layouts', async () => {
	const buffer = new ArrayBuffer(1e7);

	{
		const canvas = new OffscreenCanvas(1280, 720);
		canvas.getContext('2d');

		using sample = new VideoSample(canvas, { timestamp: 0 });
		const layout = await sample.copyTo(buffer);

		expect(layout).toEqual([{
			offset: 0,
			stride: 1280 * 4,
		}]);
	}

	{
		const canvas = new OffscreenCanvas(1280, 720);
		canvas.getContext('2d');

		using sample = new VideoSample(canvas, { timestamp: 0 });
		const layout = await sample.copyTo(buffer, {
			layout: [{
				offset: 0,
				stride: 1300 * 4,
			}],
		});

		expect(layout).toEqual([{
			offset: 0,
			stride: 1300 * 4,
		}]);
	}

	{
		const data = new Uint8Array(1280 * 720 * 4);
		using sample = new VideoSample(data, {
			timestamp: 0,
			codedWidth: 1280,
			codedHeight: 720,
			format: 'RGBA',
		});
		const layout = await sample.copyTo(buffer);

		expect(layout).toEqual([{
			offset: 0,
			stride: 1280 * 4,
		}]);
	}

	{
		const data = new Uint8Array(1280 * 720 * 4);
		using sample = new VideoSample(data, {
			timestamp: 0,
			codedWidth: 1280,
			codedHeight: 720,
			format: 'RGBA',
		});
		const layout = await sample.copyTo(buffer, {
			layout: [{
				offset: 0,
				stride: 1300 * 4,
			}],
		});

		expect(layout).toEqual([{
			offset: 0,
			stride: 1300 * 4,
		}]);
	}

	{
		const data = new Uint8Array(1300 * 720 * 4);
		using sample = new VideoSample(data, {
			timestamp: 0,
			codedWidth: 1280,
			codedHeight: 720,
			format: 'RGBA',
			layout: [{
				offset: 0,
				stride: 1300 * 4,
			}],
		});
		const layout = await sample.copyTo(buffer);

		expect(layout).toEqual([{
			offset: 0,
			stride: 1280 * 4,
		}]);

		using clone = sample.clone();
		const clonedLayout = await clone.copyTo(buffer);

		expect(clonedLayout).toEqual([{
			offset: 0,
			stride: 1280 * 4,
		}]);
	}

	{
		const data = new Uint8Array(1280 * 720 * 1.5);
		using sample = new VideoSample(data, {
			timestamp: 0,
			codedWidth: 1280,
			codedHeight: 720,
			format: 'I420',
		});
		const layout = await sample.copyTo(buffer);

		expect(layout).toEqual([{
			offset: 0,
			stride: 1280,
		}, {
			offset: 1280 * 720,
			stride: 1280 / 2,
		}, {
			offset: 1280 * 720 + (1280 / 2) * (720 / 2),
			stride: 1280 / 2,
		}]);

		const rgbLayout = await sample.copyTo(buffer, { format: 'RGBA' });

		expect(rgbLayout).toEqual([{
			offset: 0,
			stride: 4 * 1280,
		}]);
	}
});

test('RGB conversion for ArrayBuffer-backed data', async () => {
	// 2x2 RGBA image with distinct, easily-verifiable pixels
	const src = new Uint8Array([
		10, 20, 30, 255, 40, 50, 60, 255,
		70, 80, 90, 255, 100, 110, 120, 255,
	]);

	{
		// RGBA -> BGRA: R and B should swap
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: 2,
			codedHeight: 2,
			format: 'RGBA',
		});

		const dest = new Uint8Array(2 * 2 * 4);
		const layout = await sample.copyTo(dest, { format: 'BGRA' });

		expect(layout).toEqual([{ offset: 0, stride: 2 * 4 }]);
		expect(Array.from(dest)).toEqual([
			30, 20, 10, 255, 60, 50, 40, 255,
			90, 80, 70, 255, 120, 110, 100, 255,
		]);
	}

	{
		// RGBA -> RGBA: no swap, bytes copied through unchanged
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: 2,
			codedHeight: 2,
			format: 'RGBA',
		});

		const dest = new Uint8Array(2 * 2 * 4);
		await sample.copyTo(dest, { format: 'RGBA' });

		expect(Array.from(dest)).toEqual(Array.from(src));
	}

	{
		// RGBA -> BGRX: R and B should swap
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: 2,
			codedHeight: 2,
			format: 'RGBA',
		});

		const dest = new Uint8Array(2 * 2 * 4);
		await sample.copyTo(dest, { format: 'BGRX' });

		expect(Array.from(dest)).toEqual([
			30, 20, 10, 255, 60, 50, 40, 255,
			90, 80, 70, 255, 120, 110, 100, 255,
		]);
	}

	{
		// BGRA -> RGBA: R and B should swap
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: 2,
			codedHeight: 2,
			format: 'BGRA',
		});

		const dest = new Uint8Array(2 * 2 * 4);
		await sample.copyTo(dest, { format: 'RGBA' });

		expect(Array.from(dest)).toEqual([
			30, 20, 10, 255, 60, 50, 40, 255,
			90, 80, 70, 255, 120, 110, 100, 255,
		]);
	}

	{
		// BGRA -> BGRA: no swap
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: 2,
			codedHeight: 2,
			format: 'BGRA',
		});

		const dest = new Uint8Array(2 * 2 * 4);
		await sample.copyTo(dest, { format: 'BGRA' });

		expect(Array.from(dest)).toEqual(Array.from(src));
	}

	{
		// RGBX -> RGBA: X (whatever it is) becomes 255 to mean A
		const xSrc = new Uint8Array([
			10, 20, 30, 0, 40, 50, 60, 77,
			70, 80, 90, 128, 100, 110, 120, 200,
		]);

		using sample = new VideoSample(xSrc.slice(), {
			timestamp: 0,
			codedWidth: 2,
			codedHeight: 2,
			format: 'RGBX',
		});

		const dest = new Uint8Array(2 * 2 * 4);
		await sample.copyTo(dest, { format: 'RGBA' });

		expect(Array.from(dest)).toEqual([
			10, 20, 30, 255, 40, 50, 60, 255,
			70, 80, 90, 255, 100, 110, 120, 255,
		]);
	}

	{
		// RGBX -> BGRA: R and B swap, X becomes 255 to mean A
		const xSrc = new Uint8Array([
			10, 20, 30, 0, 40, 50, 60, 77,
			70, 80, 90, 128, 100, 110, 120, 200,
		]);

		using sample = new VideoSample(xSrc.slice(), {
			timestamp: 0,
			codedWidth: 2,
			codedHeight: 2,
			format: 'RGBX',
		});

		const dest = new Uint8Array(2 * 2 * 4);
		await sample.copyTo(dest, { format: 'BGRA' });

		expect(Array.from(dest)).toEqual([
			30, 20, 10, 255, 60, 50, 40, 255,
			90, 80, 70, 255, 120, 110, 100, 255,
		]);
	}
});

test('RGB conversion for ArrayBuffer-backed data converts into the target color space', async () => {
	// Not every browser's VideoFrame converts color spaces correctly here (Firefox ignores the color space of a Display
	// P3 frame, WebKitGTK copies RGB planes verbatim). Mediabunny then copies the pixels as they are, only reordering
	// the channels, like it always did.
	const nativeOrange = async (primaries: string, options: VideoFrameCopyToOptions) => {
		const frame = new VideoFrame(new Uint8Array([200, 100, 50, 255]), {
			format: 'RGBA',
			codedWidth: 1,
			codedHeight: 1,
			timestamp: 0,
			colorSpace: {
				primaries: primaries as VideoColorPrimaries, transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true,
			},
		});
		const bytes = new Uint8Array(4);
		await frame.copyTo(bytes, options);
		frame.close();
		return bytes;
	};
	const toDisplayP3 = await nativeOrange('bt709', { format: 'BGRA', colorSpace: 'display-p3' });
	const toSrgb = await nativeOrange('smpte432', { format: 'RGBA', colorSpace: 'srgb' });
	const browserConverts = toDisplayP3[2]! > toDisplayP3[0]! && toDisplayP3[0] !== 50 && toSrgb[0] !== 200;
	const asIs = (bytes: Uint8Array, format: string) => {
		const result = [...bytes];
		if (format.startsWith('BGR')) {
			for (let i = 0; i < result.length; i += 4) {
				[result[i], result[i + 2]] = [result[i + 2]!, result[i]!];
			}
		}
		return result;
	};

	const data = new Uint8Array([200, 100, 50, 255, 0, 255, 0, 255]);
	const displayP3 = {
		primaries: 'smpte432' as VideoColorPrimaries,
		transfer: 'iec61966-2-1' as VideoTransferCharacteristics,
		matrix: 'rgb' as VideoMatrixCoefficients,
		fullRange: true,
	};

	// Same results as VideoFrame, for sRGB and Display P3 data
	for (const colorSpace of [undefined, displayP3]) {
		const init = { format: 'RGBA', codedWidth: 2, codedHeight: 1, timestamp: 0, colorSpace } as const;
		using sample = new VideoSample(data, init);
		const frame = new VideoFrame(data, init);
		const optionSets: VideoFrameCopyToOptions[] = [
			{ format: 'RGBA' },
			{ format: 'BGRA', colorSpace: 'srgb' },
			{ format: 'RGBA', colorSpace: 'display-p3' },
			{ format: 'BGRX', colorSpace: 'display-p3' },
		];
		for (const options of optionSets) {
			const actual = new Uint8Array(8);
			await sample.copyTo(actual, options);
			if (browserConverts) {
				const expected = new Uint8Array(8);
				await frame.copyTo(expected, options);
				expect([...actual], JSON.stringify({ colorSpace, options })).toEqual([...expected]);
			} else {
				expect([...actual], JSON.stringify({ colorSpace, options })).toEqual(asIs(data, options.format!));
			}
		}
		frame.close();
	}

	if (!browserConverts) {
		return;
	}

	// A visible rect that doesn't start at the origin: R, G, B, orange cropped to G, B
	const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 128, 0, 255]);
	const croppedInit = { format: 'RGBA', codedWidth: 4, codedHeight: 1, timestamp: 0 } as const;
	using cropped = new VideoSample(pixels, { ...croppedInit, visibleRect: { left: 1, top: 0, width: 2, height: 1 } });
	const croppedFrame = new VideoFrame(pixels, { ...croppedInit, visibleRect: { x: 1, y: 0, width: 2, height: 1 } });
	const croppedOptionSets: VideoFrameCopyToOptions[] = [
		{ format: 'RGBA', colorSpace: 'display-p3' },
		{ format: 'BGRA', colorSpace: 'display-p3', rect: { x: 1, y: 0, width: 1, height: 1 } },
	];
	for (const options of croppedOptionSets) {
		const expected = new Uint8Array(croppedFrame.allocationSize(options));
		await croppedFrame.copyTo(expected, options);
		const actual = new Uint8Array(cropped.allocationSize(options));
		await cropped.copyTo(actual, options);
		expect([...actual], JSON.stringify(options)).toEqual([...expected]);
	}
	croppedFrame.close();

	// E.g. sRGB orange as Display P3 (this point is only reached where the browser's VideoFrame converts, see above)
	using srgbSample = new VideoSample(data, { format: 'RGBA', codedWidth: 2, codedHeight: 1, timestamp: 0 });
	const p3Bytes = new Uint8Array(8);
	await srgbSample.copyTo(p3Bytes, { format: 'RGBA', colorSpace: 'display-p3' });
	[187, 105, 62].forEach((value, i) => expect(Math.abs(p3Bytes[i]! - value)).toBeLessThanOrEqual(2));
});

test('Closing a sample right after calling copyTo() still copies it, also when converting color spaces', async () => {
	const displayP3 = {
		primaries: 'smpte432' as VideoColorPrimaries,
		transfer: 'iec61966-2-1' as VideoTransferCharacteristics,
		matrix: 'rgb' as VideoMatrixCoefficients,
		fullRange: true,
	};

	for (const colorSpace of [displayP3, undefined]) {
		const sample = new VideoSample(new Uint8Array([200, 100, 50, 255]), {
			format: 'RGBA',
			codedWidth: 1,
			codedHeight: 1,
			timestamp: 0,
			colorSpace,
		});

		// As with VideoFrame, the copy reads the pixels as they are when copyTo() is called
		const bytes = new Uint8Array(4);
		const promise = sample.copyTo(bytes, { format: 'RGBA' });
		sample.close();
		await expect(promise).resolves.toBeDefined();
		expect(bytes[3]).toBe(255);
	}
});

test('crop (rect option) for ArrayBuffer-backed data', async () => {
	// 4x4 RGBA image where each pixel's R/G channels encode (x, y)
	const width = 4;
	const height = 4;
	const src = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			src[i] = x;
			src[i + 1] = y;
			src[i + 2] = 0;
			src[i + 3] = 255;
		}
	}

	{
		// Crop a 2x2 region at (1, 1)
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: width,
			codedHeight: height,
			format: 'RGBA',
		});

		const size = sample.allocationSize({ rect: { x: 1, y: 1, width: 2, height: 2 } });
		expect(size).toBe(2 * 2 * 4);

		const dest = new Uint8Array(size);
		const layout = await sample.copyTo(dest, { rect: { x: 1, y: 1, width: 2, height: 2 } });

		expect(layout).toEqual([{ offset: 0, stride: 2 * 4 }]);
		expect(Array.from(dest)).toEqual([
			1, 1, 0, 255, 2, 1, 0, 255,
			1, 2, 0, 255, 2, 2, 0, 255,
		]);
	}

	{
		// Crop an offset rect at the top-right corner
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: width,
			codedHeight: height,
			format: 'RGBA',
		});

		const dest = new Uint8Array(2 * 1 * 4);
		const layout = await sample.copyTo(dest, { rect: { x: 2, y: 0, width: 2, height: 1 } });

		expect(layout).toEqual([{ offset: 0, stride: 2 * 4 }]);
		expect(Array.from(dest)).toEqual([
			2, 0, 0, 255, 3, 0, 0, 255,
		]);
	}

	{
		// Crop combined with a custom destination stride (padding between rows)
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: width,
			codedHeight: height,
			format: 'RGBA',
		});

		const stride = 3 * 4; // wider than the crop, leaving trailing padding
		const dest = new Uint8Array(stride * 2);
		const layout = await sample.copyTo(dest, {
			rect: { x: 0, y: 2, width: 2, height: 2 },
			layout: [{ offset: 0, stride }],
		});

		expect(layout).toEqual([{ offset: 0, stride }]);
		// Row 0 of crop (y=2): pixels (0,2) and (1,2), then 4 bytes of untouched padding
		expect(Array.from(dest.subarray(0, 8))).toEqual([0, 2, 0, 255, 1, 2, 0, 255]);
		expect(Array.from(dest.subarray(stride, stride + 8))).toEqual([0, 3, 0, 255, 1, 3, 0, 255]);
	}
});

test('draw with flip', () => {
	using sample = makeCoordinateSample({ flip: true });
	const pixels = drawToPixels(sample, 4, 4);

	expect(pixelAt(pixels, 4, 0, 0)).toEqual([3, 0]);
	expect(pixelAt(pixels, 4, 3, 0)).toEqual([0, 0]);
	expect(pixelAt(pixels, 4, 0, 3)).toEqual([3, 3]);
});

test('draw with rotation then flip', () => {
	using sample = makeCoordinateSample({ rotation: 90, flip: true });
	const pixels = drawToPixels(sample, 4, 4);

	expect(pixelAt(pixels, 4, 0, 0)).toEqual([0, 0]);
	expect(pixelAt(pixels, 4, 3, 0)).toEqual([0, 3]);
	expect(pixelAt(pixels, 4, 0, 3)).toEqual([3, 0]);
});

test('drawWithFit with rotation, flip and crop', () => {
	using sample = makeCoordinateSample({ rotation: 90, flip: true });

	const canvas = new OffscreenCanvas(1, 4);
	const context = canvas.getContext('2d', { willReadFrequently: true })!;
	context.imageSmoothingEnabled = false;
	sample.drawWithFit(context, {
		fit: 'fill',
		crop: { left: 3, top: 0, width: 1, height: 4 },
	});

	const pixels = context.getImageData(0, 0, 1, 4).data;
	expect(pixelAt(pixels, 1, 0, 0)).toEqual([0, 3]);
	expect(pixelAt(pixels, 1, 0, 3)).toEqual([3, 3]);
});

test('transform never produces empty or infinite sizes', async () => {
	const descriptions: string[] = [];
	registerVideoSampleTransformer((sample, description) => {
		if (sample.timestamp === 4242) {
			descriptions.push(`${description.width}x${description.height}`);
		}
		return null;
	});

	// Extreme aspect ratios round to at least one pixel, or one multiple of roundDimensionsTo
	using strip = new VideoSample(new Uint8Array(1000 * 4), {
		format: 'RGBA', codedWidth: 1000, codedHeight: 1, timestamp: 4242,
	});
	using thin = await strip.transform({ width: 2 });
	expect([thin.displayWidth, thin.displayHeight]).toEqual([2, 1]);
	using rounded = await strip.transform({ width: 16, roundDimensionsTo: 4 });
	expect([rounded.displayWidth, rounded.displayHeight]).toEqual([16, 4]);
	expect(descriptions).toEqual(['2x1', '16x4']);

	// A crop that selects nothing is rejected
	using sample = makeCoordinateSample({});
	const outside = { left: 10, top: 0, width: 2, height: 2 };
	await expect(sample.transform({ crop: outside })).rejects.toThrow('lies outside the 4x4 frame');
	await expect(sample.transform({ crop: outside, width: 2 })).rejects.toThrow('lies outside the 4x4 frame');
	const context = new OffscreenCanvas(2, 2).getContext('2d')!;
	expect(() => sample.drawWithFit(context, { fit: 'fill', crop: outside })).toThrow('lies outside the 4x4 frame');
	await expect(sample.transform({ crop: { left: 0, top: 0, width: 0, height: 2 }, height: 2 }))
		.rejects.toThrow('options.crop.width must be a positive integer');
});

test('transform with flip metadata and additional rotation', async () => {
	using sample = makeCoordinateSample({ flip: true });
	using result = await sample.transform({ rotate: 90 });

	expect(result.rotation).toBe(0);
	expect(result.flip).toBe(false);

	const pixels = drawToPixels(result, 4, 4);
	expect(pixelAt(pixels, 4, 3, 3)).toEqual([0, 0]);
	expect(pixelAt(pixels, 4, 0, 3)).toEqual([0, 3]);
	expect(pixelAt(pixels, 4, 3, 0)).toEqual([3, 0]);
});

// Firefox's VideoFrame has no rotation or flip (it bakes an image's orientation into the pixels)
test.runIf('rotation' in VideoFrame.prototype)('VideoFrame rotation and flip become sample metadata', async () => {
	// A JPEG with EXIF orientation 6 (how phones store portrait photos): stored as 8x4, displayed as 4x8
	const canvas = new OffscreenCanvas(8, 4);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(0, 0, 8, 4);
	ctx.fillStyle = 'blue';
	ctx.fillRect(0, 0, 4, 2);
	const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 1 })).arrayBuffer());
	// APP1 segment holding a big-endian TIFF with a single IFD entry: Orientation (0x0112) = 6
	const exif = [
		0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8,
		0, 1, 1, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0,
	];
	const app1 = new Uint8Array([0xff, 0xe1, 0, exif.length + 2, ...exif]);
	const image = new Image();
	image.src = URL.createObjectURL(new Blob([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
	await image.decode();
	URL.revokeObjectURL(image.src);
	expect([image.naturalWidth, image.naturalHeight]).toEqual([4, 8]);

	using sample = new VideoSample(image, { timestamp: 0 });
	expect(sample.rotation).toBe(90);
	expect(sample.flip).toBe(false);
	expect([sample.squarePixelWidth, sample.squarePixelHeight]).toEqual([8, 4]);
	expect([sample.displayWidth, sample.displayHeight]).toEqual([4, 8]);
	expect(sample.pixelAspectRatio).toEqual({ num: 1, den: 1 });

	// Drawing it must look like drawing the image itself, so the rotation isn't applied twice
	const expected = new OffscreenCanvas(4, 8).getContext('2d', { willReadFrequently: true })!;
	expected.drawImage(image, 0, 0);
	const actual = new OffscreenCanvas(4, 8).getContext('2d', { willReadFrequently: true })!;
	sample.draw(actual, 0, 0);
	expect([...actual.getImageData(0, 0, 4, 8).data]).toEqual([...expected.getImageData(0, 0, 4, 8).data]);

	// A frame's flip is composed with the init's rotation and flip, like the VideoFrame constructor does
	const frame = new VideoFrame(new Uint8Array(4 * 2 * 4), {
		format: 'RGBX', codedWidth: 4, codedHeight: 2, timestamp: 0, rotation: 90, flip: true,
	} as VideoFrameBufferInit);
	const flipped = new VideoSample(frame, { rotation: 90, flip: true });
	expect([flipped.rotation, flipped.flip]).toEqual([0, false]);
	expect([flipped.displayWidth, flipped.displayHeight]).toEqual([4, 2]);

	// The passed frame stays usable until the sample is closed
	expect(frame.format).toBe('RGBX');
	flipped.close();
	expect(frame.format).toBe(null);
});

/** 4x4 RGBA sample where each pixel's R/G channels encode its (x, y) position. */
const makeCoordinateSample = (init: { rotation?: Rotation; flip?: boolean }) => {
	const data = new Uint8Array(4 * 4 * 4);
	for (let y = 0; y < 4; y++) {
		for (let x = 0; x < 4; x++) {
			const i = (y * 4 + x) * 4;
			data[i] = x;
			data[i + 1] = y;
			data[i + 2] = 0;
			data[i + 3] = 255;
		}
	}

	return new VideoSample(data, {
		format: 'RGBA',
		codedWidth: 4,
		codedHeight: 4,
		timestamp: 0,
		rotation: init.rotation,
		flip: init.flip,
	});
};

const drawToPixels = (sample: VideoSample, width: number, height: number) => {
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext('2d', { willReadFrequently: true })!;
	context.imageSmoothingEnabled = false;
	sample.draw(context, 0, 0, width, height);

	return context.getImageData(0, 0, width, height).data;
};

const pixelAt = (pixels: Uint8ClampedArray, width: number, x: number, y: number) => {
	const i = (y * width + x) * 4;
	return [pixels[i]!, pixels[i + 1]!];
};

test('null format', async () => {
	const canvas = new OffscreenCanvas(1280, 720);
	canvas.getContext('2d');

	const frame = new VideoFrame(canvas, { timestamp: 0 });
	using sample = new VideoSample(frame);
	// @ts-expect-error Sybau
	sample.format = null;

	expect(() => sample.allocationSize()).toThrow('when format is null');
	await expect(async () => sample.copyTo(new ArrayBuffer())).rejects.toThrow('when format is null');

	// BUT: See https://github.com/Vanilagy/mediabunny/issues/267
	const size = sample.allocationSize({ format: 'RGBA' });
	expect(size).toBe(1280 * 720 * 4);
	const buffer = new ArrayBuffer(size);
	const layout = await sample.copyTo(buffer, { format: 'RGBA' });

	expect(layout).toEqual([{
		offset: 0,
		stride: 1280 * 4,
	}]);

	sample.allocationSize({ format: 'RGBX' });
	sample.allocationSize({ format: 'BGRA' });
	sample.allocationSize({ format: 'BGRX' });
	await sample.copyTo(buffer, { format: 'RGBX' });
	await sample.copyTo(buffer, { format: 'BGRA' });
	await sample.copyTo(buffer, { format: 'BGRX' });
});

test('Samples not backed by a canvas fail cleanly when VideoFrame is missing', async () => {
	const globals = globalThis as { VideoFrame?: unknown };
	const OriginalVideoFrame = globals.VideoFrame;
	delete globals.VideoFrame;

	try {
		using sample = new VideoSample(new Uint8Array(16), {
			format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 0,
		});
		const context = new OffscreenCanvas(2, 2).getContext('2d')!;
		expect(() => sample.draw(context, 0, 0)).toThrow('VideoFrame is not available');
		expect(() => sample.toVideoFrame()).toThrow('VideoFrame is not available');
		await expect(sample.transform({ width: 7 })).rejects.toThrow('VideoFrame is not available');

		// Canvas-backed samples don't need it
		using canvasSample = new VideoSample(new OffscreenCanvas(2, 2), { timestamp: 0 });
		canvasSample.draw(context, 0, 0);
	} finally {
		globals.VideoFrame = OriginalVideoFrame;
	}
});

test('encodeOptions', () => {
	const canvas = new OffscreenCanvas(100, 100);
	canvas.getContext('2d');

	// The default is an empty object
	using a = new VideoSample(canvas, { timestamp: 0 });
	expect(a.encodeOptions).toEqual({});

	// It can be overridden via the setter
	a.setEncodeOptions({ keyFrame: true });
	expect(a.encodeOptions).toEqual({ keyFrame: true });

	// Cloning carries the encode options over
	using aClone = a.clone();
	expect(aClone.encodeOptions).toEqual({ keyFrame: true });

	// It can be set via the constructor
	using b = new VideoSample(canvas, { timestamp: 0, encodeOptions: { keyFrame: true } });
	expect(b.encodeOptions).toEqual({ keyFrame: true });
});

test('encodeOptions, key frame forcing', async () => {
	const samples = Array.from({ length: 5 }, (_, i) => makeRedSample(i / 30, { keyFrame: true }));

	await encodeAndAssertPacketTypes(
		samples,
		['key', 'key', 'key', 'key', 'key'],
	);
});

test('encodeOptions add() override', async () => {
	const samples = Array.from({ length: 5 }, (_, i) => makeRedSample(i / 30, { keyFrame: true }));

	await encodeAndAssertPacketTypes(
		samples,
		['key', 'delta', 'delta', 'delta', 'delta'],
		samples.map(() => ({ keyFrame: false })),
	);
});

const makeRedSample = (timestamp: number, encodeOptions?: VideoEncoderEncodeOptions) => {
	const canvas = new OffscreenCanvas(100, 100);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(0, 0, 100, 100);

	return new VideoSample(canvas, {
		timestamp,
		duration: 1 / 30,
		encodeOptions,
	});
};

const encodeAndAssertPacketTypes = async (
	samples: VideoSample[],
	expectedPacketTypes: PacketType[],
	addOptions?: (VideoEncoderEncodeOptions | undefined)[],
) => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	let i = 0;
	const videoSource = new VideoSampleSource({
		codec: 'vp8',
		quality: new Quality('medium'),
		onEncodedPacket: packet => expect(packet.type).toBe(expectedPacketTypes[i++]),
	});
	output.addVideoTrack(videoSource);
	await output.start();

	for (let i = 0; i < samples.length; i++) {
		await videoSource.add(samples[i]!, addOptions?.[i]);
		samples[i]!.close();
	}

	await output.finalize();
};

test('Treat non-standard VideoFrame color space values as unknown', () => {
	const frame = new VideoFrame(new Uint8Array(16), { format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 0 });

	Object.defineProperty(frame, 'colorSpace', {
		value: { primaries: 'unspecified', transfer: 'unspecified', matrix: 'smpte170m', fullRange: true },
	});

	using sample = new VideoSample(frame);
	expect(sample.colorSpace.primaries).toBe(null);
	expect(sample.colorSpace.transfer).toBe(null);
	expect(sample.colorSpace.matrix).toBe('smpte170m');
	expect(sample.colorSpace.fullRange).toBe(true);
});

test('init visibleRect and display size refine a wrapped VideoFrame', () => {
	using source = makeCoordinateSample({});

	// Pixels are only checked where the browser's own VideoFrame draws a visible rect correctly (WebKitGTK draws it
	// from the frame's origin)
	const uncropped = source.toVideoFrame();
	const nativeCrop = new VideoFrame(uncropped, { visibleRect: { x: 2, y: 0, width: 2, height: 4 } });
	const probe = new OffscreenCanvas(2, 4).getContext('2d', { willReadFrequently: true })!;
	probe.drawImage(nativeCrop, 0, 0);
	const browserDrawsCrops = pixelAt(probe.getImageData(0, 0, 2, 4).data, 2, 0, 0)[0] === 2;
	nativeCrop.close();
	uncropped.close();

	const frame = source.toVideoFrame();
	const cropped = new VideoSample(frame, { visibleRect: { left: 2, top: 0, width: 2, height: 4 } });
	expect(cropped.visibleRect).toEqual({ left: 2, top: 0, width: 2, height: 4 });
	expect([cropped.displayWidth, cropped.displayHeight]).toEqual([2, 4]);
	if (browserDrawsCrops) {
		const pixels = drawToPixels(cropped, 2, 4);
		expect(pixelAt(pixels, 2, 0, 0)).toEqual([2, 0]);
		expect(pixelAt(pixels, 2, 1, 3)).toEqual([3, 3]);
	}

	// The passed frame stays usable until the sample is closed
	expect(frame.format).toBe('RGBA');
	cropped.close();
	expect(frame.format).toBe(null);

	using stretched = new VideoSample(source.toVideoFrame(), { displayWidth: 8, displayHeight: 4 });
	expect([stretched.displayWidth, stretched.displayHeight]).toEqual([8, 4]);
	expect(stretched.pixelAspectRatio).toEqual({ num: 2, den: 1 });

	// Like for ArrayBuffer-backed samples, the display size is the one after rotation
	using rotated = new VideoSample(source.toVideoFrame(), { rotation: 90, displayWidth: 4, displayHeight: 8 });
	expect([rotated.squarePixelWidth, rotated.squarePixelHeight]).toEqual([8, 4]);

	// Image sources get cropped only once
	const canvas = new OffscreenCanvas(4, 4);
	source.draw(canvas.getContext('2d')!, 0, 0);
	using fromCanvas = new VideoSample(canvas, {
		timestamp: 0,
		visibleRect: { left: 2, top: 2, width: 2, height: 2 },
		displayWidth: 4,
		displayHeight: 2,
	});
	expect([fromCanvas.codedWidth, fromCanvas.codedHeight]).toEqual([2, 2]);
	expect([fromCanvas.displayWidth, fromCanvas.displayHeight]).toEqual([4, 2]);
	if (browserDrawsCrops) {
		expect(pixelAt(drawToPixels(fromCanvas, 4, 2), 4, 0, 0)).toEqual([2, 2]);
	}
});

// Firefox's VideoFrame has no rotation
const frameHasRotation = 'rotation' in VideoFrame.prototype;

test.runIf(frameHasRotation)('init display size and crop of a VideoFrame with its own rotation', () => {
	// Like Chrome's frames of EXIF-rotated images or rotated videos
	const makeRotatedFrame = () => {
		const canvas = new OffscreenCanvas(8, 4);
		canvas.getContext('2d')!.fillRect(0, 0, 8, 4);
		return new VideoFrame(canvas, { timestamp: 0, rotation: 90 } as VideoFrameInit);
	};

	// The display size in init is the one after all rotation, the frame's own included
	for (const rotation of [0, 90] as const) {
		using sample = new VideoSample(makeRotatedFrame(), { rotation, displayWidth: 16, displayHeight: 8 });
		expect([sample.displayWidth, sample.displayHeight], `init rotation ${rotation}`).toEqual([16, 8]);
	}

	// The caller's frame is closed together with the sample
	const inits = [{ visibleRect: { left: 0, top: 0, width: 4, height: 4 } }, { displayWidth: 16, displayHeight: 8 }];
	for (const init of inits) {
		const frame = makeRotatedFrame();
		new VideoSample(frame, init).close();
		expect(frame.format, JSON.stringify(init)).toBe(null);
	}
});
