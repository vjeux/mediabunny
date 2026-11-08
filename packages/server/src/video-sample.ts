/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	type MaybePromise,
	VideoSamplePixelFormat,
	VideoSampleResource,
	VideoSampleColorSpace,
	SetRequired,
	VideoSampleInit,
	VideoSample,
	VideoDataPlane,
	VideoSampleTransformationDescription,
} from 'mediabunny';
import * as NodeAv from 'node-av';
import { assert, toUint8Array } from '../../../src/misc';
import {
	isRgbPixelFormat,
	toPixelFormat,
	unmapColorPrimaries,
	unmapTransferCharacteristics,
	unmapMatrixCoefficients,
	fromPixelFormat,
	mapColorPrimaries,
	mapMatrixCoefficients,
	mapTransferCharacteristics,
} from './misc';

const JPEG_RANGE_PIX_FORMATS = new Set([
	NodeAv.AV_PIX_FMT_YUVJ411P,
	NodeAv.AV_PIX_FMT_YUVJ420P,
	NodeAv.AV_PIX_FMT_YUVJ422P,
	NodeAv.AV_PIX_FMT_YUVJ440P,
	NodeAv.AV_PIX_FMT_YUVJ444P,
]);

/** Monochrome formats (monochrome AV1, 4:0:0 HEVC), handed out as 4:2:0 with neutral chroma, like Chromium does. */
const GRAY_PIX_FORMATS = new Map<NodeAv.AVPixelFormat, VideoSamplePixelFormat>([
	[NodeAv.AV_PIX_FMT_GRAY8, 'I420'],
	[NodeAv.AV_PIX_FMT_GRAY10LE, 'I420P10'],
	[NodeAv.AV_PIX_FMT_GRAY12LE, 'I420P12'],
]);

/** Planar RGB formats, handed out as 4:4:4 (see toPixelFormat), whose planes are G, B and R. */
const GBR_PIX_FORMATS = new Set([
	NodeAv.AV_PIX_FMT_GBRP,
	NodeAv.AV_PIX_FMT_GBRP10LE,
	NodeAv.AV_PIX_FMT_GBRP12LE,
]);

/**
 * A custom `VideoSampleResource` backed by NodeAV's
 * [`Frame`](https://seydx.github.io/node-av/api/lib/classes/Frame.html), which in turn is backed by FFmpeg's
 * [`AVFrame`](https://ffmpeg.org/doxygen/2.7/structAVFrame.html). You can use this resource to create `VideoSample`
 * instances that are directly backed by FFmpeg's `AVFrame` without data having to be copied. Since `AVFrame`s can
 * themselves be backed by data on the GPU, this enables zero-copy hardware-accelerated decode and encode paths.
 *
 * When using Electron, you can directly create `Frame` instances without the data having to leave the GPU. For more,
 * see [NodeAV's docs](https://seydx.github.io/node-av/api/lib/classes/Frame.html).
 *
 * When passed, the `Frame` is now owned by resource, meaning it takes care of closing the frame later. If you want to
 * keep a copy for your own use, clone the frame first.
 *
 * @group \@mediabunny/server
 * @public
 */
export class AvFrameVideoSampleResource extends VideoSampleResource {
	/** @internal */
	_frame: NodeAv.Frame | null;
	/** @internal A top-down copy of a frame stored bottom-up, made when its planes are first needed. */
	_topDownFrame: NodeAv.Frame | null = null;

	/**
	 * The NodeAV [`Frame`](https://seydx.github.io/node-av/api/lib/classes/Frame.html) instance backing this resource.
	 * Access throws if the resource has already been closed.
	 */
	get frame() {
		if (!this._frame) {
			throw new Error('AvFrameVideoSampleResource has been closed.');
		}

		return this._frame;
	}

	constructor(frame: NodeAv.Frame) {
		super();

		if (!(frame instanceof NodeAv.Frame)) {
			throw new TypeError('frame must be a NodeAv.Frame.');
		}
		if (frame.getMediaType() !== NodeAv.AVMEDIA_TYPE_VIDEO) {
			throw new Error('AvFrameVideoSampleResource must be initialized with a video frame.');
		}

		this._frame = frame;
	}

	getFormat(): VideoSamplePixelFormat | null {
		const format = this.frame.format as NodeAv.AVPixelFormat;
		return GRAY_PIX_FORMATS.get(format) ?? toPixelFormat(format);
	}

	getCodedWidth(): number {
		return this.frame.width;
	}

	getCodedHeight(): number {
		return this.frame.height;
	}

	getSquarePixelWidth(): number {
		if (this.frame.sampleAspectRatio.num > this.frame.sampleAspectRatio.den) {
			return Math.round(this.frame.width * this.frame.sampleAspectRatio.num / this.frame.sampleAspectRatio.den);
		} else {
			return this.frame.width;
		}
	}

	getSquarePixelHeight(): number {
		if (
			this.frame.sampleAspectRatio.num > this.frame.sampleAspectRatio.den
			// FFmpeg uses 0/1 for an unknown aspect ratio, meaning square pixels
			|| this.frame.sampleAspectRatio.num === 0
		) {
			return this.frame.height;
		} else {
			return Math.round(this.frame.height * this.frame.sampleAspectRatio.den / this.frame.sampleAspectRatio.num);
		}
	}

	getColorSpace(): VideoSampleColorSpace {
		// Planar RGB planes are G, B and R, at full range, whatever the frame is tagged with
		const isGbr = GBR_PIX_FORMATS.has(this.frame.format as NodeAv.AVPixelFormat);

		return new VideoSampleColorSpace({
			primaries: unmapColorPrimaries(this.frame.colorPrimaries) as VideoColorPrimaries | null,
			transfer: unmapTransferCharacteristics(this.frame.colorTrc) as VideoTransferCharacteristics | null,
			matrix: isGbr ? 'rgb' : unmapMatrixCoefficients(this.frame.colorSpace) as VideoMatrixCoefficients | null,
			fullRange: isGbr
				|| this.frame.colorRange === NodeAv.AVCOL_RANGE_JPEG
				|| JPEG_RANGE_PIX_FORMATS.has(this.frame.format as NodeAv.AVPixelFormat)
				? true
				: this.frame.colorRange === NodeAv.AVCOL_RANGE_MPEG
					? false
					: null,
		});
	}

	close(): void {
		this.frame.free();
		this._frame = null;
		this._topDownFrame?.free();
		this._topDownFrame = null;
	}

	getDataPlanes(): MaybePromise<VideoDataPlane[]> {
		let frame = this.frame;

		if (frame.linesize.some(lineSize => lineSize < 0)) {
			// NodeAV doesn't expose planes stored bottom-up (negative line sizes, like after FFmpeg's vflip filter), so
			// copy the frame into a top-down one first
			if (!this._topDownFrame) {
				const copy = new NodeAv.Frame();
				copy.alloc();
				copy.format = frame.format;
				copy.width = frame.width;
				copy.height = frame.height;
				NodeAv.FFmpegError.throwIfError(copy.allocBuffer(), 'allocBuffer');
				NodeAv.FFmpegError.throwIfError(copy.copy(frame), 'copy');
				this._topDownFrame = copy;
			}

			frame = this._topDownFrame;
		}

		assert(frame.data);

		const planes = frame.data.map((data, i) => ({
			data: toUint8Array(data),
			stride: frame.linesize[i]!,
		}));

		const grayFormat = GRAY_PIX_FORMATS.get(this.frame.format as NodeAv.AVPixelFormat);
		if (grayFormat) {
			// Add the chroma planes that monochrome frames don't have, at the middle of the value range
			const bytesPerSample = grayFormat === 'I420' ? 1 : 2;
			const stride = Math.ceil(this.frame.width / 2) * bytesPerSample;
			const chroma = new Uint8Array(stride * Math.ceil(this.frame.height / 2));
			if (bytesPerSample === 1) {
				chroma.fill(128);
			} else {
				new Uint16Array(chroma.buffer).fill(grayFormat === 'I420P10' ? 512 : 2048);
			}

			return [planes[0]!, { data: chroma, stride }, { data: chroma, stride }];
		}

		return planes;
	}

	async toRgbSample(
		init: SetRequired<VideoSampleInit, 'timestamp'>,
		// Will respect it when somebody complains
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		colorSpace: PredefinedColorSpace,
	): Promise<VideoSample> {
		const width = this.frame.width;
		const height = this.frame.height;

		// A separate ref so we can fill in unspecified color properties without changing the original frame
		const srcFrame = new NodeAv.Frame();
		srcFrame.alloc();
		srcFrame.ref(this.frame);

		const srcIsRgb = isRgbPixelFormat(srcFrame.format as NodeAv.AVPixelFormat);
		if (srcFrame.colorPrimaries === NodeAv.AVCOL_PRI_UNSPECIFIED) {
			srcFrame.colorPrimaries = NodeAv.AVCOL_PRI_BT709;
		}
		if (srcFrame.colorTrc === NodeAv.AVCOL_TRC_UNSPECIFIED) {
			srcFrame.colorTrc = srcIsRgb ? NodeAv.AVCOL_TRC_IEC61966_2_1 : NodeAv.AVCOL_TRC_BT709;
		}
		if (srcFrame.colorSpace === NodeAv.AVCOL_SPC_UNSPECIFIED) {
			srcFrame.colorSpace = srcIsRgb ? NodeAv.AVCOL_SPC_RGB : NodeAv.AVCOL_SPC_BT709;
		}
		if (srcFrame.colorRange === NodeAv.AVCOL_RANGE_UNSPECIFIED) {
			srcFrame.colorRange = srcIsRgb ? NodeAv.AVCOL_RANGE_JPEG : NodeAv.AVCOL_RANGE_MPEG;
		}

		const dstFrame = new NodeAv.Frame();
		dstFrame.alloc();
		dstFrame.width = width;
		dstFrame.height = height;
		dstFrame.format = fromPixelFormat('RGBA');
		dstFrame.allocBuffer();

		dstFrame.colorPrimaries = srcFrame.colorPrimaries;
		dstFrame.colorTrc = srcFrame.colorTrc;
		dstFrame.colorSpace = NodeAv.AVCOL_SPC_RGB;
		dstFrame.colorRange = NodeAv.AVCOL_RANGE_JPEG;

		// Left unconfigured on purpose: getContext/initContext ignore the frames' color properties and use BT.601
		const scaler = new NodeAv.SoftwareScaleContext();
		scaler.allocContext();
		scaler.setOption('sws_flags', 'bilinear');

		try {
			const ret = await scaler.scaleFrame(dstFrame, srcFrame);
			NodeAv.FFmpegError.throwIfError(ret, 'Scale frame');
		} finally {
			scaler.freeContext();
			srcFrame.free();
		}

		dstFrame.sampleAspectRatio = this.frame.sampleAspectRatio;

		return new VideoSample(new AvFrameVideoSampleResource(dstFrame), init);
	}
}

export const copyVideoSampleToAvFrame = async (sample: VideoSample, frame: NodeAv.Frame, lastBuffer: Buffer | null) => {
	assert(sample.format !== null);

	frame.unref();

	frame.format = fromPixelFormat(sample.format);
	frame.width = sample.codedWidth;
	frame.height = sample.codedHeight;
	frame.sampleAspectRatio = new NodeAv.Rational(
		sample.pixelAspectRatio.num,
		sample.pixelAspectRatio.den,
	);
	frame.colorPrimaries = mapColorPrimaries(sample.colorSpace.primaries ?? 'unknown')
		?? NodeAv.AVCOL_PRI_UNSPECIFIED;
	frame.colorSpace = mapMatrixCoefficients(sample.colorSpace.matrix ?? 'unknown')
		?? NodeAv.AVCOL_SPC_UNSPECIFIED;
	frame.colorTrc = mapTransferCharacteristics(sample.colorSpace.transfer ?? 'unknown')
		?? NodeAv.AVCOL_TRC_UNSPECIFIED;
	frame.colorRange = sample.colorSpace.fullRange === false
		? NodeAv.AVCOL_RANGE_MPEG
		: sample.colorSpace.fullRange === true
			? NodeAv.AVCOL_RANGE_JPEG
			: NodeAv.AVCOL_RANGE_UNSPECIFIED;

	const size = sample.allocationSize();
	if (!lastBuffer || lastBuffer.byteLength !== size) {
		lastBuffer = Buffer.from({ length: size });
	}

	await sample.copyTo(lastBuffer);
	frame.fromBuffer(lastBuffer);

	return lastBuffer;
};

/**
 * Whether FFmpeg's exact crop misplaces the chroma of a pixel format at odd horizontal offsets. It moves each chroma
 * plane by (x * bytes per sample) >> chroma subsampling bytes (vf_crop.c), which only works for 1-byte samples, so
 * semi-planar formats (NV12, P010...) and planar formats above 8 bits with horizontally subsampled chroma break.
 */
const hasInexactOddCrop = (pixelFormatName: string) => {
	return /^(nv(12|21|16|20)|p[02]\d\d|yuva?42[02]p\d)/.test(pixelFormatName);
};

/** What those formats are cropped as instead: 8-bit planar 4:2:0 or 4:2:2, or 4:4:4 at the same bit depth. */
const EXACT_CROP_FORMAT_FILTER = 'format=pix_fmts=' + [
	'yuv420p', 'yuv422p',
	'yuv444p', 'yuv444p9le', 'yuv444p10le', 'yuv444p12le', 'yuv444p14le', 'yuv444p16le',
	'yuva444p', 'yuva444p9le', 'yuva444p10le', 'yuva444p12le', 'yuva444p16le',
].join('|');

export const transformVideoSample = async (
	sample: VideoSample,
	description: VideoSampleTransformationDescription,
): Promise<VideoSample | null> => {
	let srcFrame: NodeAv.Frame;
	let srcFrameOwned = false;

	if (sample._data instanceof AvFrameVideoSampleResource) {
		srcFrame = sample._data.frame;
	} else {
		if (sample.format === null) {
			return null;
		}

		srcFrame = new NodeAv.Frame();
		srcFrame.alloc();
		srcFrameOwned = true;

		await copyVideoSampleToAvFrame(sample, srcFrame, null);
	}

	// Build the filter chain. Order: square-pixel normalize -> rotate -> flip -> crop -> resize-with-fit.
	const chain: string[] = [];

	if (sample.squarePixelWidth !== sample.codedWidth || sample.squarePixelHeight !== sample.codedHeight) {
		chain.push(`scale=${sample.squarePixelWidth}:${sample.squarePixelHeight}`);
		chain.push('setsar=1');
	}

	if (description.rotation === 90) {
		chain.push('transpose=1');
	} else if (description.rotation === 180) {
		chain.push('transpose=1,transpose=1');
	} else if (description.rotation === 270) {
		chain.push('transpose=2');
	}

	if (description.flip) {
		chain.push('hflip');
	}

	// The crops are exact (exact=1), since the crop filter otherwise rounds the offsets and the size down to the
	// chroma subsampling (to even numbers for 4:2:0). For the formats where an exact crop at an odd horizontal offset
	// misplaces the chroma, convert to one where it doesn't first, and back at the end.
	const srcPixelFormatName = NodeAv.avGetPixFmtName(srcFrame.format as NodeAv.AVPixelFormat) ?? '';
	const convertForCrop = hasInexactOddCrop(srcPixelFormatName)
		&& (Math.round(description.crop.left) % 2 !== 0 || description.fit === 'cover');
	if (convertForCrop) {
		chain.push(EXACT_CROP_FORMAT_FILTER);
	}

	chain.push(`crop=${Math.round(description.crop.width)}:${Math.round(description.crop.height)}`
		+ `:${Math.round(description.crop.left)}:${Math.round(description.crop.top)}:exact=1`);

	if (description.fit === 'fill') {
		chain.push(`scale=${description.width}:${description.height}`);
	} else if (description.fit === 'contain') {
		chain.push(`scale=${description.width}:${description.height}:force_original_aspect_ratio=decrease`);
		chain.push(`pad=${description.width}:${description.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
	} else if (description.fit === 'cover') {
		chain.push(`scale=${description.width}:${description.height}:force_original_aspect_ratio=increase`);
		chain.push(`crop=${description.width}:${description.height}:exact=1`);
	}

	if (convertForCrop) {
		chain.push(`format=${srcPixelFormatName}`);
	}

	chain.push('setsar=1');

	let graphDescription = `[in]${chain.join(',')}[out]`;

	const pixelFormatName = NodeAv.avGetPixFmtName(srcFrame.format as NodeAv.AVPixelFormat) ?? '';
	const hasAlpha = /^(yuva|gbrap|rgba|bgra|argb|abgr|ya\d|ayuv|vuya)/.test(pixelFormatName);

	if (description.alpha === 'discard' && hasAlpha) {
		// Like the canvas transformer, paint the frame (including transparent padding) onto black, keeping the pixel
		// format, now with every pixel opaque. The blending runs in the source's chroma subsampling, and in at least 10
		// bits for high-bit-depth sources, the most the overlay filter does.
		const yuvMatch = /^yuva(420|422|444)p(\d+)?/.exec(pixelFormatName);
		const blendFormat = yuvMatch
			? `yuv${yuvMatch[1]}${yuvMatch[2] ? 'p10' : ''}`
			: /^(rgba|bgra|argb|abgr)/.test(pixelFormatName) ? 'rgb' : 'auto';

		graphDescription = `[in]${chain.join(',')},split[fg][copy];`
			+ '[copy]drawbox=t=fill:c=black:replace=1[bg];'
			+ `[bg][fg]overlay=format=${blendFormat},format=pix_fmts=${pixelFormatName}[out]`;
	}

	const graph = new NodeAv.FilterGraph();
	graph.alloc();

	try {
		// The matrix and range describe the filter links, so leaving them out would get them dropped from the output
		const srcArgs = `video_size=${srcFrame.width}x${srcFrame.height}`
			+ `:pix_fmt=${srcFrame.format}`
			+ `:time_base=1/1000000`
			+ `:pixel_aspect=${sample.pixelAspectRatio.num}/${sample.pixelAspectRatio.den}`
			+ `:colorspace=${srcFrame.colorSpace}`
			+ `:range=${srcFrame.colorRange}`;

		const bufferSrc = graph.createFilter(NodeAv.Filter.getByName('buffer')!, 'src', srcArgs);
		const bufferSink = graph.createFilter(NodeAv.Filter.getByName('buffersink')!, 'sink');
		assert(bufferSrc && bufferSink);

		// The naming here looks inverted but matches FFmpeg's parse semantics: from the parsed chain's
		// perspective, its inputs are fed by the graph's existing outputs (the buffer src), and its outputs
		// feed the graph's existing inputs (the buffer sink).
		const outputs = NodeAv.FilterInOut.createList([{ name: 'in', filterCtx: bufferSrc, padIdx: 0 }]);
		const inputs = NodeAv.FilterInOut.createList([{ name: 'out', filterCtx: bufferSink, padIdx: 0 }]);

		const parseRet = graph.parsePtr(graphDescription, inputs, outputs);
		NodeAv.FFmpegError.throwIfError(parseRet, 'FilterGraph.parsePtr');

		const configRet = await graph.config();
		NodeAv.FFmpegError.throwIfError(configRet, 'FilterGraph.config');

		// Without KEEP_REF, the graph would take the frame's buffers away from the sample
		const addRet = await bufferSrc.buffersrcAddFrame(srcFrame, NodeAv.AV_BUFFERSRC_FLAG_KEEP_REF);
		NodeAv.FFmpegError.throwIfError(addRet, 'buffersrcAddFrame');

		// Flush - we only ever push a single frame through this graph.
		await bufferSrc.buffersrcAddFrame(null);

		const dstFrame = new NodeAv.Frame();
		dstFrame.alloc();

		const getRet = await bufferSink.buffersinkGetFrame(dstFrame);
		NodeAv.FFmpegError.throwIfError(getRet, 'buffersinkGetFrame');

		return new VideoSample(new AvFrameVideoSampleResource(dstFrame), {
			timestamp: sample.timestamp,
			duration: sample.duration,
			// Baked in by the filter graph:
			rotation: 0,
			flip: false,
		});
	} finally {
		graph.free();

		if (srcFrameOwned) {
			srcFrame.free();
		}
	}
};
