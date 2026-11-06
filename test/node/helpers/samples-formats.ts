// Shared helpers for the VideoSample/AudioSample conformance tests.

/** One plane of a pixel format, as described by the "Pixel Format" section (9.8) of the WebCodecs spec. */
export type PixelFormatPlane = {
	/** Bytes per sample, times samples per position (2 for NV12's interleaved UV plane, 4 for RGBA). */
	sampleBytes: number;
	/** Horizontal sub-sampling factor. */
	subX: number;
	/** Vertical sub-sampling factor. */
	subY: number;
};

const yuvPlanes = (bytes: number, subX: number, subY: number, alpha: boolean): PixelFormatPlane[] => {
	const planes = [
		{ sampleBytes: bytes, subX: 1, subY: 1 },
		{ sampleBytes: bytes, subX, subY },
		{ sampleBytes: bytes, subX, subY },
	];
	if (alpha) {
		planes.push({ sampleBytes: bytes, subX: 1, subY: 1 });
	}

	return planes;
};

/** Plane structure of every VideoPixelFormat, written down from the WebCodecs spec independently of src/. */
export const PIXEL_FORMAT_PLANES: Record<string, PixelFormatPlane[]> = {
	I420: yuvPlanes(1, 2, 2, false),
	I420P10: yuvPlanes(2, 2, 2, false),
	I420P12: yuvPlanes(2, 2, 2, false),
	I420A: yuvPlanes(1, 2, 2, true),
	I420AP10: yuvPlanes(2, 2, 2, true),
	I420AP12: yuvPlanes(2, 2, 2, true),
	I422: yuvPlanes(1, 2, 1, false),
	I422P10: yuvPlanes(2, 2, 1, false),
	I422P12: yuvPlanes(2, 2, 1, false),
	I422A: yuvPlanes(1, 2, 1, true),
	I422AP10: yuvPlanes(2, 2, 1, true),
	I422AP12: yuvPlanes(2, 2, 1, true),
	I444: yuvPlanes(1, 1, 1, false),
	I444P10: yuvPlanes(2, 1, 1, false),
	I444P12: yuvPlanes(2, 1, 1, false),
	I444A: yuvPlanes(1, 1, 1, true),
	I444AP10: yuvPlanes(2, 1, 1, true),
	I444AP12: yuvPlanes(2, 1, 1, true),
	NV12: [{ sampleBytes: 1, subX: 1, subY: 1 }, { sampleBytes: 2, subX: 2, subY: 2 }],
	RGBA: [{ sampleBytes: 4, subX: 1, subY: 1 }],
	RGBX: [{ sampleBytes: 4, subX: 1, subY: 1 }],
	BGRA: [{ sampleBytes: 4, subX: 1, subY: 1 }],
	BGRX: [{ sampleBytes: 4, subX: 1, subY: 1 }],
};

export type PlaneGeometry = { offset: number; stride: number; rows: number };

/** The tightly-packed layout the spec's "Compute Layout and Allocation Size" gives for a rect of the given size. */
export const tightLayout = (format: string, width: number, height: number): PlaneGeometry[] => {
	let offset = 0;
	return PIXEL_FORMAT_PLANES[format]!.map((plane) => {
		const stride = Math.ceil(width / plane.subX) * plane.sampleBytes;
		const rows = Math.ceil(height / plane.subY);
		const geometry = { offset, stride, rows };
		offset += stride * rows;
		return geometry;
	});
};

export const layoutSize = (layout: PlaneGeometry[]) => {
	return Math.max(...layout.map(plane => plane.offset + plane.stride * plane.rows));
};

/** Deterministic pseudo-random bytes. */
export const seededBytes = (length: number, seed: number) => {
	const bytes = new Uint8Array(length);
	let state = seed >>> 0 || 1;
	for (let i = 0; i < length; i++) {
		// xorshift32
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		bytes[i] = state & 0xff;
	}

	return bytes;
};

/**
 * Copies the rect (in pixels) out of planes laid out as `layout` within `data`, into a tightly-packed buffer. This is
 * the reference copy that VideoSample.copyTo is compared against.
 */
export const referenceCopy = (
	format: string,
	data: Uint8Array,
	layout: PlaneGeometry[],
	rect: { x: number; y: number; width: number; height: number },
) => {
	const out = tightLayout(format, rect.width, rect.height);
	const result = new Uint8Array(layoutSize(out));
	PIXEL_FORMAT_PLANES[format]!.forEach((plane, i) => {
		const top = rect.y / plane.subY;
		const leftBytes = (rect.x / plane.subX) * plane.sampleBytes;
		for (let row = 0; row < out[i]!.rows; row++) {
			const start = layout[i]!.offset + (top + row) * layout[i]!.stride + leftBytes;
			result.set(data.subarray(start, start + out[i]!.stride), out[i]!.offset + row * out[i]!.stride);
		}
	});

	return result;
};
