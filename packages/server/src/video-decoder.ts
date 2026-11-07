/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CustomVideoDecoder, VideoCodec, EncodedPacket, VideoSample, type MaybePromise, Rational } from 'mediabunny';
import * as NodeAv from 'node-av';
import { CODEC_TO_CODEC_ID, getHardwareDecoderCodec } from './misc';
import { assert, binarySearchLessOrEqual, simplifyRational, toUint8Array } from '../../../src/misc';
import { AvFrameVideoSampleResource } from './video-sample';

/** The formats VP9 decodes to, and the same format with an alpha plane. */
const WITH_ALPHA_PLANE = new Map<NodeAv.AVPixelFormat, NodeAv.AVPixelFormat>([
	[NodeAv.AV_PIX_FMT_YUV420P, NodeAv.AV_PIX_FMT_YUVA420P],
	[NodeAv.AV_PIX_FMT_YUV422P, NodeAv.AV_PIX_FMT_YUVA422P],
	[NodeAv.AV_PIX_FMT_YUV444P, NodeAv.AV_PIX_FMT_YUVA444P],
	[NodeAv.AV_PIX_FMT_YUV420P10LE, NodeAv.AV_PIX_FMT_YUVA420P10LE],
	[NodeAv.AV_PIX_FMT_YUV422P10LE, NodeAv.AV_PIX_FMT_YUVA422P10LE],
	[NodeAv.AV_PIX_FMT_YUV444P10LE, NodeAv.AV_PIX_FMT_YUVA444P10LE],
	[NodeAv.AV_PIX_FMT_YUV444P12LE, NodeAv.AV_PIX_FMT_YUVA444P12LE],
	[NodeAv.AV_PIX_FMT_GBRP, NodeAv.AV_PIX_FMT_GBRAP],
	[NodeAv.AV_PIX_FMT_GBRP10LE, NodeAv.AV_PIX_FMT_GBRAP10LE],
	[NodeAv.AV_PIX_FMT_GBRP12LE, NodeAv.AV_PIX_FMT_GBRAP12LE],
]);

const getBitDepth = (pixelFormat: NodeAv.AVPixelFormat) => {
	return Number(/p(\d+)le$/.exec(NodeAv.avGetPixFmtName(pixelFormat) ?? '')?.[1] ?? 8);
};

/**
 * Combines a decoded VP9 frame with the frame decoded from its alpha data, whose luma is the alpha plane, the way
 * FFmpeg's libvpx decoder does. Returns null if they don't fit together.
 */
const addAlphaPlane = (frame: NodeAv.Frame, alphaFrame: NodeAv.Frame) => {
	const format = WITH_ALPHA_PLANE.get(frame.format as NodeAv.AVPixelFormat);
	const bitDepth = getBitDepth(frame.format as NodeAv.AVPixelFormat);
	if (
		format === undefined
		|| alphaFrame.width !== frame.width
		|| alphaFrame.height !== frame.height
		|| getBitDepth(alphaFrame.format as NodeAv.AVPixelFormat) !== bitDepth
	) {
		return null;
	}

	// The planes of a format with alpha, packed, are those of the format without it followed by the alpha plane
	const alphaPlaneSize = frame.width * frame.height * (bitDepth > 8 ? 2 : 1);
	const data = Buffer.concat([frame.toBuffer(), alphaFrame.toBuffer().subarray(0, alphaPlaneSize)]);

	const result = new NodeAv.Frame();
	result.alloc();
	result.format = format;
	result.width = frame.width;
	result.height = frame.height;
	NodeAv.FFmpegError.throwIfError(result.fromBuffer(data), 'fromBuffer');

	result.pts = frame.pts;
	result.duration = frame.duration;
	result.colorPrimaries = frame.colorPrimaries;
	result.colorTrc = frame.colorTrc;
	result.colorSpace = frame.colorSpace;
	result.colorRange = frame.colorRange;

	return result;
};

export class NodeAvVideoDecoder extends CustomVideoDecoder {
	frame!: NodeAv.Frame;
	packet!: NodeAv.Packet;
	codecContext: NodeAv.CodecContext | null = null;
	pixelAspectRatio!: Rational;

	// Bookkeeping to restore the original timing information
	preciseTimings: {
		microsecondTimestamp: number;
		timestamp: number;
		duration: number;
		timestampIsValid: boolean;
		durationIsValid: boolean;
	}[] = [];

	// VP9 alpha is decoded separately, like Chromium does: the alpha data of each packet is a VP9 frame of its own,
	// whose luma is the alpha plane. Unlike with FFmpeg's libvpx decoder, which decodes both, alpha can then start and
	// stop on any frame.
	alphaCodecContext: NodeAv.CodecContext | null = null;
	alphaPacket: NodeAv.Packet | null = null;
	alphaFrame: NodeAv.Frame | null = null;
	/** Decoded alpha frames by their microsecond timestamp, until the frame they belong to comes out. */
	alphaFrames = new Map<number, NodeAv.Frame>();

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	static override supports(codec: VideoCodec, config: VideoDecoderConfig): boolean {
		return codec === 'avc' || codec === 'hevc' || codec === 'vp8' || codec === 'vp9' || codec === 'av1';
	}

	async init() {
		this.frame = new NodeAv.Frame();
		this.frame.alloc();
		this.packet = new NodeAv.Packet();
		this.packet.alloc();
	}

	async initCodecContext(packet: EncodedPacket) {
		assert(this.codecContext === null);

		const codecId = CODEC_TO_CODEC_ID[this.codec];
		assert(codecId !== undefined);

		let codec: NodeAv.Codec | null;
		if (this.codec === 'vp9' && packet.sideData.alpha) {
			// Software decoding, whose frames the alpha planes can be added to
			codec = NodeAv.Codec.findDecoder(codecId);
		} else if (
			// This check used to be "is not prefer-hardware", meaning it would default to using software decode. I
			// didn't leave a comment for that back then so I actually don't know what it was for. I'm sure it was to
			// work around an issue but, I don't know. Not using hardware decode at all by defaults feels wrong to me,
			// so I changed it to what it is right now. If an issue is encountered, I can always change it.
			this.config.hardwareAcceleration === 'prefer-software'
			|| this.codec === 'av1' // https://github.com/opencv/opencv/issues/24430
		) {
			codec = NodeAv.Codec.findDecoder(codecId);
		} else {
			codec = (await getHardwareDecoderCodec(codecId)) ?? NodeAv.Codec.findDecoder(codecId);
		}

		if (!codec) {
			throw new Error(`Unable to obtain libav codec for '${this.codec}'.`);
		}

		const codecContext = new NodeAv.CodecContext();
		codecContext.allocContext3(codec);

		this.pixelAspectRatio = simplifyRational({
			num: (this.config.displayAspectWidth ?? this.config.codedWidth ?? 0) * (this.config.codedHeight ?? 0),
			den: (this.config.displayAspectHeight ?? this.config.codedHeight ?? 0) * (this.config.codedWidth ?? 0) || 1,
		});

		codecContext.width = this.config.codedWidth ?? 0; // Fucky that the dimensions can be optional, but oh well
		codecContext.height = this.config.codedHeight ?? 0;
		codecContext.codecType = NodeAv.AVMEDIA_TYPE_VIDEO;
		codecContext.codecId = codecId;
		codecContext.extraData = this.config.description
			? Buffer.from(toUint8Array(this.config.description))
			: null;
		codecContext.sampleAspectRatio = new NodeAv.Rational(this.pixelAspectRatio.num, this.pixelAspectRatio.den);

		// Honor inferred H.264 reorder buffering even when bitstream restrictions aren't explicitly signaled
		// See https://github.com/Vanilagy/mediabunny/issues/488
		const options = NodeAv.Dictionary.fromObject({ strict: NodeAv.FF_COMPLIANCE_STRICT });

		const ret = await codecContext.open2(codec, options);
		NodeAv.FFmpegError.throwIfError(ret, 'Open codec context');

		this.codecContext = codecContext;
	}

	async decode(packet: EncodedPacket) {
		if (this.codecContext === null) {
			await this.initCodecContext(packet);
		}

		assert(this.codecContext);

		this.packet.isKeyframe = packet.type === 'key';
		this.packet.data = Buffer.from(packet.data);
		this.packet.timeBase = { num: 1, den: 1e6 };
		this.packet.pts = BigInt(packet.microsecondTimestamp);
		this.packet.dts = NodeAv.AV_NOPTS_VALUE;
		this.packet.duration = BigInt(packet.microsecondDuration);

		if (this.codec === 'vp9' && packet.sideData.alpha) {
			await this.decodeAlpha(packet.sideData.alpha, packet.microsecondTimestamp);
		}

		const preciseTimingIndex = binarySearchLessOrEqual(
			this.preciseTimings,
			packet.microsecondTimestamp,
			x => x.microsecondTimestamp,
		);
		const existingEntry = preciseTimingIndex !== -1
			? this.preciseTimings[preciseTimingIndex]
			: null;
		if (existingEntry && existingEntry.microsecondTimestamp === packet.microsecondTimestamp) {
			if (existingEntry.timestamp !== packet.timestamp) {
				// Mapping isn't unique, can't use the timestamp
				existingEntry.timestampIsValid = false;
			}
			if (existingEntry.duration !== packet.duration) {
				// Mapping isn't unique, can't use the duration
				existingEntry.durationIsValid = false;
			}
		} else {
			this.preciseTimings.splice(preciseTimingIndex + 1, 0, {
				microsecondTimestamp: packet.microsecondTimestamp,
				timestamp: packet.timestamp,
				duration: packet.duration,
				timestampIsValid: true,
				durationIsValid: true,
			});

			// Make sure it doesn't grow indefinitely
			if (this.preciseTimings.length > 128) {
				this.preciseTimings.shift();
			}
		}

		const ret = await this.codecContext.sendPacket(this.packet);
		NodeAv.FFmpegError.throwIfError(ret, 'Send packet');

		this.packet.unref(); // Don't need the data again, so just unref it

		while (true) {
			const receiveRet = await this.codecContext.receiveFrame(this.frame);
			if (receiveRet === NodeAv.AVERROR_EAGAIN || receiveRet === NodeAv.AVERROR_EOF) {
				break;
			}

			this.receiveFrame(receiveRet);
		}
	}

	async decodeAlpha(data: Uint8Array, microsecondTimestamp: number) {
		if (!this.alphaCodecContext) {
			const codec = NodeAv.Codec.findDecoder(NodeAv.AV_CODEC_ID_VP9);
			assert(codec);

			const codecContext = new NodeAv.CodecContext();
			codecContext.allocContext3(codec);
			NodeAv.FFmpegError.throwIfError(await codecContext.open2(codec), 'Open alpha codec context');

			this.alphaCodecContext = codecContext;
			this.alphaPacket = new NodeAv.Packet();
			this.alphaPacket.alloc();
			this.alphaFrame = new NodeAv.Frame();
			this.alphaFrame.alloc();
		}
		assert(this.alphaPacket && this.alphaFrame);

		this.alphaPacket.data = Buffer.from(data);
		this.alphaPacket.timeBase = { num: 1, den: 1e6 };
		this.alphaPacket.pts = BigInt(microsecondTimestamp);
		this.alphaPacket.dts = NodeAv.AV_NOPTS_VALUE;

		// Alpha data that can't be decoded, like a delta frame whose reference frames are missing because the alpha
		// started on it, leaves its frame opaque until the alpha's next key frame, like in Chromium
		const ret = await this.alphaCodecContext.sendPacket(this.alphaPacket);
		this.alphaPacket.unref();
		if (ret < 0) {
			return;
		}

		while (true) {
			const receiveRet = await this.alphaCodecContext.receiveFrame(this.alphaFrame);
			if (receiveRet < 0) {
				break;
			}

			const clone = this.alphaFrame.clone();
			if (!clone) {
				throw new Error('Frame clone allocation failed.');
			}
			this.alphaFrames.get(microsecondTimestamp)?.free();
			this.alphaFrames.set(microsecondTimestamp, clone);
		}
	}

	receiveFrame(ret: number) {
		NodeAv.FFmpegError.throwIfError(ret, 'Receive frame');

		this.frame.sampleAspectRatio = new NodeAv.Rational(this.pixelAspectRatio.num, this.pixelAspectRatio.den);

		let timestamp = Number(this.frame.pts) / 1e6;
		let duration = Number(this.frame.duration) / 1e6;

		const preciseTimingIndex = binarySearchLessOrEqual(
			this.preciseTimings,
			Number(this.frame.pts),
			x => x.microsecondTimestamp,
		);
		const entry = preciseTimingIndex !== -1
			? this.preciseTimings[preciseTimingIndex]
			: null;

		// If there's a relevant timing entry, refine the frame's timing data to get better accuracy than
		// microseconds
		if (entry && entry.microsecondTimestamp === Number(this.frame.pts)) {
			if (entry.timestampIsValid) {
				timestamp = entry.timestamp;
			}
			if (entry.durationIsValid) {
				duration = entry.duration;
			}
		}

		let clone: NodeAv.Frame | null = null;

		const alphaFrame = this.alphaFrames.get(Number(this.frame.pts));
		if (alphaFrame) {
			this.alphaFrames.delete(Number(this.frame.pts));
			clone = addAlphaPlane(this.frame, alphaFrame);
			alphaFrame.free();

			if (clone) {
				clone.sampleAspectRatio = this.frame.sampleAspectRatio;
			}
		}

		// Alpha frames for frames that came out before them won't be needed anymore
		for (const [microsecondTimestamp, frame] of this.alphaFrames) {
			if (microsecondTimestamp < Number(this.frame.pts)) {
				frame.free();
				this.alphaFrames.delete(microsecondTimestamp);
			}
		}

		clone ??= this.frame.clone();
		if (!clone) {
			throw new Error('Frame clone allocation failed.');
		}

		this.onSample(new VideoSample(new AvFrameVideoSampleResource(clone), {
			timestamp,
			duration,
		}));
	}

	async flush() {
		if (!this.codecContext) {
			return;
		}

		// Send null packet to signal flush
		const ret = await this.codecContext.sendPacket(null);
		NodeAv.FFmpegError.throwIfError(ret, 'Flush decoder');

		// Keep receiving frames until no more are available
		while (true) {
			const receiveRet = await this.codecContext.receiveFrame(this.frame);
			if (receiveRet === NodeAv.AVERROR_EAGAIN || receiveRet === NodeAv.AVERROR_EOF) {
				// No more frames available
				break;
			}

			this.receiveFrame(receiveRet);
		}

		this.codecContext.flushBuffers();

		this.alphaCodecContext?.flushBuffers();
		for (const frame of this.alphaFrames.values()) {
			frame.free();
		}
		this.alphaFrames.clear();
	}

	close(): MaybePromise<void> {
		this.codecContext?.freeContext();
		this.frame.free();
		this.packet.free();

		this.alphaCodecContext?.freeContext();
		this.alphaPacket?.free();
		this.alphaFrame?.free();
		for (const frame of this.alphaFrames.values()) {
			frame.free();
		}
		this.alphaFrames.clear();
	}
}
