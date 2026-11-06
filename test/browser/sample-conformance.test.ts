import { describe, expect, test } from 'vitest';
import {
	AudioSample,
	VIDEO_SAMPLE_PIXEL_FORMATS,
	VideoDataPlane,
	VideoSample,
	VideoSampleColorSpace,
	VideoSamplePixelFormat,
	VideoSampleResource,
} from '../../src/sample.js';
import { isChromium, Rotation } from '../../src/misc.js';
import {
	PIXEL_FORMAT_PLANES,
	layoutSize,
	referenceCopy,
	seededBytes,
	tightLayout,
} from '../node/helpers/samples-formats.js';

// The browser's VideoFrame and AudioData are the reference implementation for everything in here. The expectations
// are Chrome's; elsewhere, cases the browser's VideoFrame refuses are skipped (Firefox, for instance, has no 4:2:2 or
// 4:4:4 formats, no odd YUV sizes and no rects of odd height in sub-sampled formats).

const tryCall = <T>(fn: () => T) => {
	try {
		return { ok: true as const, value: fn() };
	} catch (error) {
		return { ok: false as const, error };
	}
};

const SUPPORTED_FORMATS = VIDEO_SAMPLE_PIXEL_FORMATS.filter((format) => {
	const frame = tryCall(() => new VideoFrame(new Uint8Array(256), {
		format: format as VideoPixelFormat, codedWidth: 4, codedHeight: 4, timestamp: 0,
	}));
	if (frame.ok) {
		frame.value.close();
	}
	return frame.ok;
});

class PlanesResource extends VideoSampleResource {
	constructor(
		public format: VideoSamplePixelFormat,
		public width: number,
		public height: number,
		public planes: VideoDataPlane[],
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
		return this.width;
	}

	getSquarePixelHeight() {
		return this.height;
	}

	getColorSpace() {
		return new VideoSampleColorSpace({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false });
	}

	getDataPlanes() {
		return this.planes;
	}

	toRgbSample(): never {
		throw new Error('Not needed');
	}

	close() {}
}

/** Builds pixel data for the format with every plane padded by `padding` bytes per row and gaps between planes. */
const makePlanes = (format: VideoSamplePixelFormat, width: number, height: number, padding: number, seed: number) => {
	let offset = padding;
	const layout = tightLayout(format, width, height).map((plane) => {
		const geometry = { offset, stride: plane.stride + padding, rows: plane.rows };
		offset += geometry.stride * geometry.rows + padding;
		return geometry;
	});
	const data = seededBytes(layoutSize(layout) + padding, seed);
	return { data, layout };
};

const copyWith = async (source: VideoSample | VideoFrame, options: VideoFrameCopyToOptions) => {
	const size = tryCall(() => source.allocationSize(options));
	if (!size.ok) {
		return { error: true };
	}

	const bytes = new Uint8Array(size.value + 8).fill(0xaa);
	try {
		const layout = await source.copyTo(bytes, options);
		return { size: size.value, layout, bytes: [...bytes] };
	} catch {
		return { error: true };
	}
};

describe('VideoSample matches VideoFrame', () => {
	test('the browser supports most pixel formats', () => {
		// Without these, the parity tests below would cover little
		const expected = ['I420', 'I420A', 'NV12', 'RGBA', 'BGRX', ...(isChromium() ? ['I422', 'I444'] : [])];
		expect(SUPPORTED_FORMATS).toEqual(expect.arrayContaining(expected));
	});

	test('in allocationSize() and copyTo() of ArrayBuffer- and resource-backed samples', async () => {
		let seed = 1;
		for (const format of SUPPORTED_FORMATS) {
			const planes = PIXEL_FORMAT_PLANES[format]!;
			const subX = Math.max(...planes.map(plane => plane.subX));
			const subY = Math.max(...planes.map(plane => plane.subY));

			// Even widths only, odd ones differ on main (fixed on Vanilagy's bug-fix-mania branch)
			for (const [width, height] of [[4, 4], [6, 2], [8, 5]] as const) {
				for (const padding of [0, 3]) {
					const { data, layout } = makePlanes(format, width, height, padding, seed++);
					const planeLayouts = layout.map(({ offset, stride }) => ({ offset, stride }));
					const init = { format, codedWidth: width, codedHeight: height, timestamp: 0, layout: planeLayouts };

					// The reference frame gets the same pixels tightly packed, as not all browsers honor `layout`
					const tight = referenceCopy(format, data, layout, { x: 0, y: 0, width, height });
					const frameResult = tryCall(() => new VideoFrame(tight, {
						format: format as VideoPixelFormat, codedWidth: width, codedHeight: height, timestamp: 0,
					}));
					if (!frameResult.ok) {
						expect(isChromium(), `${format} ${width}x${height}`).toBe(false);
						continue;
					}
					const frame = frameResult.value;
					using raw = new VideoSample(data, init);
					using resource = new VideoSample(new PlanesResource(format, width, height, layout.map(plane => ({
						data: data.subarray(plane.offset, plane.offset + plane.stride * plane.rows),
						stride: plane.stride,
					}))), { timestamp: 0 });

					const top = height > subY ? subY : 0;
					const destLayout = tightLayout(format, width, height).map((plane, i) => ({
						offset: 5 + 2 * plane.offset + i,
						stride: plane.stride + 1,
					}));
					const optionSets: VideoFrameCopyToOptions[] = [
						{},
						{ rect: { x: 0, y: 0, width, height } },
						{ rect: { x: subX, y: top, width: 2, height: height - top } },
						{ rect: { x: width - 2, y: 0, width: 2, height: 1 } },
						{ rect: { x: 1, y: 0, width: 2, height: 1 } }, // Misaligned for sub-sampled formats
						{ layout: destLayout },
						{ rect: { x: 0, y: 0, width: width + 2, height } },
					];
					for (const [i, options] of optionSets.entries()) {
						const label = `${format} ${width}x${height} +${padding} ${JSON.stringify(options)}`;
						const expected = await copyWith(frame, options);
						// Only the misaligned and the out-of-bounds rects fail
						const misaligned = i === 4 && (subX > 1 || subY > 1);
						if (isChromium()) {
							expect('error' in expected, label).toBe(misaligned || i === 6);
						} else if ('error' in expected !== (misaligned || i === 6)) {
							continue; // This browser's VideoFrame can't serve as the reference here
						}

						expect(await copyWith(raw, options), `raw ${label}`).toEqual(expected);
						expect(await copyWith(resource, options), `resource ${label}`).toEqual(expected);
					}

					frame.close();
				}
			}
		}
	});

	test('in toVideoFrame()', async () => {
		let seed = 100;
		for (const format of SUPPORTED_FORMATS) {
			const { data, layout } = makePlanes(format, 6, 4, 2, seed++);
			const planeLayouts = layout.map(({ offset, stride }) => ({ offset, stride }));
			const colorSpace = {
				primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: true,
			} as const;
			const init = {
				format,
				codedWidth: 6,
				codedHeight: 4,
				timestamp: 0,
				layout: planeLayouts,
				displayWidth: 12,
				displayHeight: 4,
			};
			// Built from tightly packed pixels, as not all browsers honor `layout`
			const reference = new VideoFrame(referenceCopy(format, data, layout, { x: 0, y: 0, width: 6, height: 4 }), {
				format: format as VideoPixelFormat,
				codedWidth: 6,
				codedHeight: 4,
				timestamp: 0,
				colorSpace,
			});
			const expected = new Uint8Array(reference.allocationSize());
			await reference.copyTo(expected);

			using raw = new VideoSample(data, { ...init, timestamp: 2.5, duration: 0.04, colorSpace });
			using resource = new VideoSample(new PlanesResource(format, 6, 4, layout.map(plane => ({
				data: data.subarray(plane.offset, plane.offset + plane.stride * plane.rows),
				stride: plane.stride,
			}))), { timestamp: 2.5, duration: 0.04 });

			for (const sample of [raw, resource]) {
				const frame = sample.toVideoFrame();
				expect(frame.format).toBe(format);
				expect([frame.timestamp, frame.duration]).toEqual([2500000, 40000]);
				const actual = new Uint8Array(frame.allocationSize());
				await frame.copyTo(actual);
				expect(actual, format).toEqual(expected);
				frame.close();
			}

			const rawFrame = raw.toVideoFrame();
			expect([rawFrame.displayWidth, rawFrame.displayHeight]).toEqual([12, 4]);
			expect(rawFrame.colorSpace.toJSON()).toEqual(colorSpace);
			rawFrame.close();
			reference.close();
		}
	});

	test('with a visible rect smaller than the coded size', async () => {
		// Like a decoder's 1920x1088 output showing 1920x1080
		const data = seededBytes(16 * 10 * 3 / 2, 5);
		const init = { format: 'I420' as const, codedWidth: 16, codedHeight: 10, timestamp: 0 };
		const reference = new VideoFrame(data, { ...init, visibleRect: { x: 0, y: 0, width: 14, height: 8 } });
		using sample = new VideoSample(data, { ...init, visibleRect: { left: 0, top: 0, width: 14, height: 8 } });

		expect([sample.displayWidth, sample.displayHeight]).toEqual([reference.displayWidth, reference.displayHeight]);
		const expected = await copyWith(reference, {});
		expect(await copyWith(sample, {})).toEqual(expected);
		expect(await copyWith(sample, { rect: { x: 2, y: 2, width: 6, height: 4 } }))
			.toEqual(await copyWith(reference, { rect: { x: 2, y: 2, width: 6, height: 4 } }));

		const frame = sample.toVideoFrame();
		expect(await copyWith(frame, {})).toEqual(expected);
		frame.close();
		reference.close();
	});
});

describe('VideoSample wrapping a VideoFrame', () => {
	test('takes over the frame\'s metadata, refined by init', () => {
		const colorSpace = {
			primaries: 'bt2020' as VideoColorPrimaries,
			transfer: 'hlg' as VideoTransferCharacteristics,
			matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
			fullRange: false,
		};
		const frame = new VideoFrame(new Uint8Array(8 * 4 * 3 / 2), {
			format: 'I420',
			codedWidth: 8,
			codedHeight: 4,
			timestamp: -40000,
			duration: 20000,
			displayWidth: 16,
			displayHeight: 4,
			colorSpace,
		});
		using sample = new VideoSample(frame);
		expect(sample.format).toBe('I420');
		expect([sample.timestamp, sample.duration]).toEqual([-0.04, 0.02]);
		expect(sample.visibleRect).toEqual({ left: 0, top: 0, width: 8, height: 4 });
		expect([sample.squarePixelWidth, sample.squarePixelHeight]).toEqual([16, 4]);
		expect(sample.pixelAspectRatio).toEqual({ num: 2, den: 1 });
		expect(sample.colorSpace.toJSON()).toEqual(colorSpace);

		using refined = new VideoSample(sample.toVideoFrame(), {
			timestamp: 7, duration: 1, rotation: 270, flip: true,
		});
		expect([refined.timestamp, refined.duration, refined.rotation, refined.flip]).toEqual([7, 1, 270, true]);
		expect([refined.displayWidth, refined.displayHeight]).toEqual([4, 16]);
	});

	test('owns the frame', () => {
		const frame = new VideoFrame(new Uint8Array(16), {
			format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 0,
		});
		const sample = new VideoSample(frame);
		const clone = sample.clone();
		expect(sample.toCanvasImageSource()).toBe(frame);

		sample.close();
		expect(frame.format).toBe(null);
		expect(clone.allocationSize()).toBe(16);
		clone.close();
	});

	test('gives toVideoFrame() the sample\'s current timing', () => {
		using sample = new VideoSample(new VideoFrame(new Uint8Array(16), {
			format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 1000, duration: 500,
		}));
		const unchanged = sample.toVideoFrame();
		expect([unchanged.timestamp, unchanged.duration]).toEqual([1000, 500]);
		unchanged.close();

		sample.setTimestamp(3);
		sample.setDuration(0.25);
		const changed = sample.toVideoFrame();
		expect([changed.timestamp, changed.duration]).toEqual([3000000, 250000]);
		changed.close();
	});

	test('passes copies through to the frame', async () => {
		const data = seededBytes(6 * 4 * 3 / 2, 9);
		const frame = new VideoFrame(data, { format: 'I420', codedWidth: 6, codedHeight: 4, timestamp: 0 });
		using sample = new VideoSample(frame.clone());
		for (const options of [{}, { rect: { x: 2, y: 2, width: 4, height: 2 } }, { format: 'RGBA' as const }]) {
			expect(await copyWith(sample, options)).toEqual(await copyWith(frame, options));
		}
		frame.close();
	});
});

// Source pixel (x, y) is drawn as R = 10 * x + 5, G = 10 * y + 5
const makeCoordinateData = (width: number, height: number) => {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			data.set([10 * x + 5, 10 * y + 5, 0, 255], (y * width + x) * 4);
		}
	}
	return data;
};

const readCoordinates = (context: OffscreenCanvasRenderingContext2D) => {
	const { width, height } = context.canvas;
	const pixels = context.getImageData(0, 0, width, height).data;
	const coordinates: string[] = [];
	for (let i = 0; i < pixels.length; i += 4) {
		const [x, y] = [Math.round((pixels[i]! - 5) / 10), Math.round((pixels[i + 1]! - 5) / 10)];
		coordinates.push(pixels[i + 3]! < 128 ? '-' : `${x},${y}`);
	}
	return coordinates;
};

const newContext = (width: number, height: number) => {
	const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
	context.imageSmoothingEnabled = false;
	return context;
};

/**
 * For a sample of width x height, with square pixels (width * stretch) x height, shown with rotation and flip: maps
 * display pixels to source pixels.
 */
const orientationMap = (width: number, height: number, stretch: number, rotation: Rotation, flip: boolean) => {
	const sqWidth = width * stretch;
	const [displayWidth, displayHeight] = rotation % 180 === 0 ? [sqWidth, height] : [height, sqWidth];
	const map = (x: number, y: number) => {
		if (flip) {
			x = displayWidth - 1 - x;
		}
		// Undo the clockwise rotation
		const [sx, sy] = rotation === 0
			? [x, y]
			: rotation === 90
				? [y, height - 1 - x]
				: rotation === 180
					? [sqWidth - 1 - x, height - 1 - y]
					: [sqWidth - 1 - y, x];
		return `${Math.floor(sx / stretch)},${sy}`;
	};
	const region = (left: number, top: number, w: number, h: number) => {
		const result: string[] = [];
		for (let y = top; y < top + h; y++) {
			for (let x = left; x < left + w; x++) {
				result.push(map(x, y));
			}
		}
		return result;
	};
	return { displayWidth, displayHeight, region };
};

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

describe('VideoSample drawing and transformation', () => {
	const cases = ROTATIONS.flatMap(rotation => [false, true].flatMap(flip => [1, 2].flatMap(stretch =>
		(['raw', 'frame'] as const).map(backing => ({ rotation, flip, stretch, backing })),
	)));

	const makeOriented = ({ rotation, flip, stretch, backing }: typeof cases[number]) => {
		const [width, height] = [3, 2];
		const data = makeCoordinateData(width, height);
		const quarter = rotation % 180 !== 0;
		const display = stretch === 1
			? {}
			: { displayWidth: quarter ? height : width * stretch, displayHeight: quarter ? width * stretch : height };
		return backing === 'raw'
			? new VideoSample(data, {
				format: 'RGBA', codedWidth: width, codedHeight: height, timestamp: 0, rotation, flip, ...display,
			})
			: new VideoSample(new VideoFrame(data, {
				format: 'RGBA',
				codedWidth: width,
				codedHeight: height,
				timestamp: 0,
				...(stretch === 1 ? {} : { displayWidth: width * stretch, displayHeight: height }),
			}), { rotation, flip });
	};

	test('draw() applies rotation, flip and pixel aspect ratio', () => {
		for (const testCase of cases) {
			using sample = makeOriented(testCase);
			const { rotation, flip, stretch } = testCase;
			const { displayWidth, displayHeight, region } = orientationMap(3, 2, stretch, rotation, flip);
			expect([sample.displayWidth, sample.displayHeight]).toEqual([displayWidth, displayHeight]);

			const full = newContext(displayWidth, displayHeight);
			sample.draw(full, 0, 0);
			expect(readCoordinates(full), JSON.stringify(testCase)).toEqual(region(0, 0, displayWidth, displayHeight));

			// A source rect is in display space
			const part = newContext(2, 1);
			sample.draw(part, displayWidth - 2, displayHeight - 1, 2, 1, 0, 0);
			expect(readCoordinates(part), JSON.stringify(testCase))
				.toEqual(region(displayWidth - 2, displayHeight - 1, 2, 1));
		}
	});

	test('drawWithFit() crops in display space', () => {
		for (const testCase of cases) {
			using sample = makeOriented(testCase);
			const { rotation, flip, stretch } = testCase;
			const { displayWidth, displayHeight, region } = orientationMap(3, 2, stretch, rotation, flip);
			const crop = { left: 1, top: 0, width: displayWidth - 1, height: displayHeight };
			const context = newContext(crop.width, crop.height);
			sample.drawWithFit(context, { fit: 'fill', crop });
			expect(readCoordinates(context), JSON.stringify(testCase)).toEqual(region(1, 0, crop.width, crop.height));

			// Overriding the orientation
			const plain = orientationMap(3, 2, testCase.stretch, 0, false);
			const unrotated = newContext(plain.displayWidth, plain.displayHeight);
			sample.drawWithFit(unrotated, { fit: 'fill', rotation: 0, flip: false });
			expect(readCoordinates(unrotated)).toEqual(plain.region(0, 0, plain.displayWidth, plain.displayHeight));
		}
	});

	test('drawWithFit() letterboxes with contain and fills with cover', () => {
		// A 4x2 sample into a 4x4 canvas
		using sample = new VideoSample(makeCoordinateData(4, 2), {
			format: 'RGBA', codedWidth: 4, codedHeight: 2, timestamp: 0,
		});
		const contain = newContext(4, 4);
		sample.drawWithFit(contain, { fit: 'contain' });
		expect(readCoordinates(contain)).toEqual([
			'-', '-', '-', '-',
			'0,0', '1,0', '2,0', '3,0',
			'0,1', '1,1', '2,1', '3,1',
			'-', '-', '-', '-',
		]);

		const cover = newContext(2, 2);
		sample.drawWithFit(cover, { fit: 'cover' });
		// Scaled by 1 vertically, only the middle two columns fit
		expect(readCoordinates(cover)).toEqual(['1,0', '2,0', '1,1', '2,1']);
	});

	test('transform() bakes in rotation, flip and crop', async () => {
		for (const testCase of cases) {
			for (const rotate of ROTATIONS) {
				for (const extraFlip of [false, true]) {
					using sample = makeOriented(testCase);
					const combined = testCase.rotation + (testCase.flip ? -rotate : rotate);
					const rotation = ((combined % 360) + 360) % 360 as Rotation;
					const flip = testCase.flip !== extraFlip;
					const map = orientationMap(3, 2, testCase.stretch, rotation, flip);
					const { displayWidth, displayHeight, region } = map;
					const crop = { left: 0, top: 1, width: displayWidth, height: displayHeight - 1 };

					using result = await sample.transform({ rotate, flip: extraFlip, crop });
					expect([result.rotation, result.flip]).toEqual([0, false]);
					expect([result.displayWidth, result.displayHeight]).toEqual([crop.width, crop.height]);
					const context = newContext(crop.width, crop.height);
					result.draw(context, 0, 0);
					expect(readCoordinates(context), `${JSON.stringify(testCase)} +${rotate} ${extraFlip}`)
						.toEqual(region(0, 1, crop.width, crop.height));
				}
			}
		}
	});

	test('transform() resizes to the requested size and keeps or discards alpha', async () => {
		const canvas = new OffscreenCanvas(40, 20);
		const context = canvas.getContext('2d')!;
		context.fillStyle = 'rgb(255, 0, 0)';
		context.fillRect(0, 0, 20, 20); // The right half stays transparent
		using sample = new VideoSample(canvas, { timestamp: 1, duration: 0.5 });

		for (const [options, size] of [
			[{ width: 20 }, [20, 10]],
			[{ height: 5 }, [10, 5]],
			[{ width: 9, height: 9, fit: 'contain' }, [9, 9]],
			[{ height: 7, roundDimensionsTo: 2 }, [14, 8]],
		] as const) {
			using result = await sample.transform(options);
			expect([result.displayWidth, result.displayHeight], JSON.stringify(options)).toEqual(size);
			expect([result.timestamp, result.duration]).toEqual([1, 0.5]);
		}

		const readPixel = async (result: VideoSample, x: number, y: number) => {
			const bytes = new Uint8Array(4);
			await result.copyTo(bytes, { format: 'RGBA', rect: { x, y, width: 1, height: 1 } });
			return [...bytes];
		};
		using kept = await sample.transform({ width: 20 });
		expect(await readPixel(kept, 2, 5)).toEqual([255, 0, 0, 255]);
		expect((await readPixel(kept, 17, 5))[3]).toBe(0);

		using discarded = await sample.transform({ width: 20, alpha: 'discard' });
		expect(await readPixel(discarded, 17, 5)).toEqual([0, 0, 0, 255]);
	});
});

type AudioFormat = 'u8' | 's16' | 's32' | 'f32' | 'u8-planar' | 's16-planar' | 's32-planar' | 'f32-planar';
const AUDIO_FORMATS: AudioFormat[] = ['u8', 's16', 's32', 'f32', 'u8-planar', 's16-planar', 's32-planar', 'f32-planar'];

describe('VideoSample from image sources', () => {
	const makeCanvas = () => {
		// Left half red, right half blue
		const canvas = new OffscreenCanvas(4, 2);
		const context = canvas.getContext('2d')!;
		context.fillStyle = 'rgb(255, 0, 0)';
		context.fillRect(0, 0, 2, 2);
		context.fillStyle = 'rgb(0, 0, 255)';
		context.fillRect(2, 0, 2, 2);
		return canvas;
	};

	const readRgb = (sample: VideoSample) => {
		const context = newContext(sample.displayWidth, sample.displayHeight);
		sample.draw(context, 0, 0);
		const pixels = context.getImageData(0, 0, sample.displayWidth, sample.displayHeight).data;
		const colors: string[] = [];
		for (let i = 0; i < pixels.length; i += 4) {
			colors.push(pixels[i]! > 128 ? 'R' : pixels[i + 2]! > 128 ? 'B' : '?');
		}
		return colors.join('');
	};

	test('wraps canvases, bitmaps and images with the given timing', async () => {
		const canvas = makeCanvas();
		const image = new Image();
		image.src = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
		await image.decode();
		URL.revokeObjectURL(image.src);
		const bitmap = await createImageBitmap(canvas);

		for (const source of [canvas, bitmap, image]) {
			using sample = new VideoSample(source, { timestamp: -0.0333333, duration: 0.04 });
			expect([sample.displayWidth, sample.displayHeight]).toEqual([4, 2]);
			expect([sample.timestamp, sample.duration]).toEqual([-0.0333333, 0.04]);
			expect(sample.colorSpace.toJSON())
				.toEqual({ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true });
			expect(readRgb(sample)).toBe('RRBBRRBB');

			const frame = sample.toVideoFrame();
			expect([frame.timestamp, frame.duration]).toEqual([-33333, 40000]);
			frame.close();

			expect(() => new VideoSample(source, {} as never)).toThrow(TypeError);
		}
		bitmap.close();
	});

	test('crops image sources to the visible rect', () => {
		const visibleRect = { left: 1, top: 0, width: 2, height: 2 };
		using sample = new VideoSample(makeCanvas(), { timestamp: 0, visibleRect });
		expect([sample.codedWidth, sample.codedHeight, sample.displayWidth, sample.displayHeight])
			.toEqual([2, 2, 2, 2]);
		expect(readRgb(sample)).toBe('RBRB');
	});

	test('toCanvasImageSource() turns raw data into a VideoFrame that closes after the current microtask', async () => {
		using sample = new VideoSample(makeCoordinateData(2, 2), {
			format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 0,
		});
		const source = sample.toCanvasImageSource() as VideoFrame;
		expect(source).toBeInstanceOf(VideoFrame);
		const context = newContext(2, 2);
		context.drawImage(source, 0, 0);
		expect(readCoordinates(context)).toEqual(['0,0', '1,0', '0,1', '1,1']);

		await Promise.resolve();
		expect(source.format).toBe(null);
	});

	test('works with canvas sources when VideoFrame isn\'t available', async () => {
		const globals = globalThis as { VideoFrame?: unknown };
		const OriginalVideoFrame = globals.VideoFrame;
		delete globals.VideoFrame;

		try {
			using sample = new VideoSample(makeCanvas(), {
				timestamp: 1,
				rotation: 90,
				visibleRect: { left: 1, top: 0, width: 3, height: 2 },
			});
			expect(sample.format).toBe('RGBX');
			expect([sample.codedWidth, sample.codedHeight, sample.displayWidth, sample.displayHeight])
				.toEqual([3, 2, 2, 3]);
			expect(sample.colorSpace.matrix).toBe('rgb');

			const bytes = new Uint8Array(sample.allocationSize());
			expect(await sample.copyTo(bytes)).toEqual([{ offset: 0, stride: 12 }]);
			const red = [255, 0, 0, 255];
			const blue = [0, 0, 255, 255];
			expect([...bytes]).toEqual([...red, ...blue, ...blue, ...red, ...blue, ...blue]);

			using clone = sample.clone();
			expect([clone.format, clone.codedWidth, clone.rotation]).toEqual(['RGBX', 3, 90]);
			expect(readRgb(clone)).toBe('RRBBBB');

			using transformed = await sample.transform({ width: 4 });
			expect([transformed.displayWidth, transformed.displayHeight, transformed.rotation]).toEqual([4, 6, 0]);
		} finally {
			globals.VideoFrame = OriginalVideoFrame;
		}
	});
});

describe('AudioSample matches AudioData', () => {
	const makePair = (format: AudioFormat, frames: number, channels: number, seed: number) => {
		const bytesPerSample = format.startsWith('u8') ? 1 : format.startsWith('s16') ? 2 : 4;
		const data = seededBytes(frames * channels * bytesPerSample, seed);
		if (format.startsWith('f32')) {
			// Keep the floats finite
			const floats = new Float32Array(data.buffer);
			floats.forEach((_, i) => floats[i] = ((data[i * 4]! / 255) * 2.4) - 1.2);
		}
		const init = {
			format, sampleRate: 44100, numberOfFrames: frames, numberOfChannels: channels, timestamp: -21000, data,
		};
		return {
			audioData: new AudioData(init),
			raw: new AudioSample({ ...init, timestamp: -0.021, data: data.slice() }),
		};
	};

	test('in allocationSize() and copyTo() without format conversion', () => {
		let seed = 1;
		for (const format of AUDIO_FORMATS) {
			for (const channels of [1, 2, 5, 12]) {
				const { audioData, raw } = makePair(format, 17, channels, seed++);
				using backed = new AudioSample(audioData.clone());

				const planar = format.endsWith('-planar');
				const otherArrangement = planar ? format.replace('-planar', '') : `${format}-planar`;
				for (const destFormat of [format, otherArrangement]) {
					const planes = destFormat.endsWith('-planar') ? channels : 1;
					for (const planeIndex of [0, planes - 1, planes]) {
						const ranges = [
							[undefined, undefined], [5, undefined], [3, 7], [16, 1], [17, undefined], [2, 16],
						];
						for (const [frameOffset, frameCount] of ranges) {
							const options = { planeIndex, format: destFormat as AudioFormat, frameOffset, frameCount };
							const size = tryCall(() => audioData.allocationSize(options));
							const label = `${format} x${channels} ${JSON.stringify(options)}`;
							for (const sample of [raw, backed]) {
								const actualSize = tryCall(() => sample.allocationSize(options));
								expect(actualSize.ok, label).toBe(size.ok);
								if (!size.ok || !actualSize.ok) {
									continue;
								}

								expect(actualSize.value, label).toBe(size.value);
								const expected = new Uint8Array(size.value + 4);
								audioData.copyTo(expected, options);
								const actual = new Uint8Array(size.value + 4);
								sample.copyTo(actual, options);
								expect(actual, label).toEqual(expected);
							}
						}
					}
				}

				raw.close();
				audioData.close();
			}
		}
	});

	test('in toAudioData()', () => {
		let seed = 50;
		for (const format of AUDIO_FORMATS) {
			const { audioData, raw } = makePair(format, 9, 3, seed++);
			using backed = new AudioSample(audioData.clone());
			using shifted = new AudioSample(audioData.clone());
			shifted.setTimestamp(1);

			for (const [sample, timestamp] of [[raw, -21000], [backed, -21000], [shifted, 1000000]] as const) {
				const result = sample.toAudioData();
				const { format: resultFormat, sampleRate, numberOfFrames, numberOfChannels } = result;
				expect([resultFormat, sampleRate, numberOfFrames, numberOfChannels, result.timestamp])
					.toEqual([format, 44100, 9, 3, timestamp]);
				for (let plane = 0; plane < (format.endsWith('-planar') ? 3 : 1); plane++) {
					const expected = new Uint8Array(audioData.allocationSize({ planeIndex: plane }));
					audioData.copyTo(expected, { planeIndex: plane });
					const actual = new Uint8Array(result.allocationSize({ planeIndex: plane }));
					result.copyTo(actual, { planeIndex: plane });
					expect(actual, `${format} plane ${plane}`).toEqual(expected);
				}
				result.close();
			}

			raw.close();
			audioData.close();
		}
	});

	test('when wrapping an AudioData', () => {
		const audioData = new AudioData({
			format: 's16',
			sampleRate: 22050,
			numberOfFrames: 441,
			numberOfChannels: 2,
			timestamp: 123456,
			data: new Int16Array(882),
		});
		const sample = new AudioSample(audioData);
		expect([sample.format, sample.sampleRate, sample.numberOfFrames, sample.numberOfChannels])
			.toEqual(['s16', 22050, 441, 2]);
		expect([sample.timestamp, sample.duration]).toEqual([0.123456, 0.02]);
		expect(sample.microsecondDuration).toBe(audioData.duration);

		const clone = sample.clone();
		sample.close();
		expect(audioData.format).toBe(null);
		expect(clone.allocationSize({ planeIndex: 0 })).toBe(882 * 2);
		clone.close();
	});
});

describe('AudioSample and AudioBuffer', () => {
	test('round trip, splitting long buffers into contiguous samples', () => {
		const channels = 6;
		const length = 50000; // More than the 240000 floats per sample
		const audioBuffer = new AudioBuffer({ numberOfChannels: channels, length, sampleRate: 48000 });
		for (let c = 0; c < channels; c++) {
			audioBuffer.copyToChannel(Float32Array.from({ length }, (_, i) => Math.sin(i / (c + 1)) * 0.9), c);
		}

		const samples = AudioSample.fromAudioBuffer(audioBuffer, 10);
		expect(samples.map(sample => sample.numberOfFrames)).toEqual([40000, 10000]);
		expect(samples.map(sample => sample.timestamp)).toEqual([10, 10 + 40000 / 48000]);

		let frame = 0;
		for (const sample of samples) {
			expect([sample.format, sample.numberOfChannels, sample.sampleRate])
				.toEqual(['f32-planar', channels, 48000]);
			const back = sample.toAudioBuffer();
			expect([back.numberOfChannels, back.length, back.sampleRate])
				.toEqual([channels, sample.numberOfFrames, 48000]);
			for (let c = 0; c < channels; c++) {
				const original = audioBuffer.getChannelData(c).subarray(frame, frame + sample.numberOfFrames);
				expect(back.getChannelData(c)).toEqual(original);
			}
			frame += sample.numberOfFrames;
			sample.close();
		}

		expect(AudioSample.fromAudioBuffer(new AudioBuffer({ length: 1, sampleRate: 8000 }), 0)).toHaveLength(1);
		expect(() => AudioSample.fromAudioBuffer({} as never, 0)).toThrow(TypeError);
	});

	test('converts every sample format into an AudioBuffer', () => {
		for (const format of AUDIO_FORMATS) {
			const values = [-1, -0.5, 0, 0.5];
			const raw = format.startsWith('u8')
				? Uint8Array.from(values, x => x * 128 + 128)
				: format.startsWith('s16')
					? Int16Array.from(values, x => x * 32768)
					: format.startsWith('s32')
						? Int32Array.from(values, x => x * 2 ** 31)
						: Float32Array.from(values);
			using sample = new AudioSample({ data: raw, format, numberOfChannels: 2, sampleRate: 8000, timestamp: 0 });
			const buffer = sample.toAudioBuffer();
			const [left, right] = format.endsWith('-planar') ? [[-1, -0.5], [0, 0.5]] : [[-1, 0], [-0.5, 0.5]];
			expect([...buffer.getChannelData(0)], format).toEqual(left);
			expect([...buffer.getChannelData(1)], format).toEqual(right);
		}
	});
});
