/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { buildAacAudioSpecificConfig, parseAacAudioSpecificConfig } from '../shared/aac-misc';
import {
	AUDIO_CODECS,
	AudioCodec,
	extractAudioCodecString,
	extractVideoCodecString,
	getAudioEncoderConfigExtension,
	MediaCodec,
	OPUS_SAMPLE_RATE,
	parsePcmCodec,
	PCM_AUDIO_CODECS,
	PcmAudioCodec,
	SUBTITLE_CODECS,
	SubtitleCodec,
	VIDEO_CODECS,
	VideoCodec,
} from './codec';
import { OutputAudioTrack, OutputSubtitleTrack, OutputTrack, OutputVideoTrack } from './output';
import {
	assert,
	assertNever,
	binarySearchLessOrEqual,
	CallSerializer,
	clamp,
	clearIntervalUnthrottled,
	COLOR_PRIMARIES_MAP,
	isCodecReclaimedError,
	isFirefox,
	isThenable,
	isWebKit,
	isWindowsChromium,
	last,
	MATRIX_COEFFICIENTS_MAP,
	missingWebCodecsClassMessage,
	promiseWithResolvers,
	roundToDivisor,
	setInt24,
	setIntervalUnthrottled,
	setUint24,
	toDataView,
	toUint8Array,
	TRANSFER_CHARACTERISTICS_MAP,
	UnthrottledTimerHandle,
	wait,
} from './misc';
import { Muxer } from './muxer';
import { SubtitleParser } from './subtitles';
import { toAlaw, toUlaw } from './pcm';
import {
	CustomVideoEncoder,
	CustomAudioEncoder,
	customVideoEncoders,
	customAudioEncoders,
} from './custom-coder';
import { EncodedPacket, EncodedPacketSideData, PacketType } from './packet';
import {
	AudioSample,
	audioSampleToInterleavedFormat,
	getBytesPerSample,
	toInterleavedAudioFormat,
	VideoSample,
	VideoSamplePixelFormat,
} from './sample';
import {
	AudioEncodingConfig,
	buildAudioEncoderConfig,
	buildQuantizerEncodeOptions,
	buildVideoEncoderConfigs,
	resolveQuality,
	validateAudioEncodingConfig,
	validateVideoEncodingConfig,
	VideoEncoderConfigCandidate,
	VideoEncodingConfig,
} from './encode';
import { AudioResampler } from './resample';
import {
	deserializeAvcDecoderConfigurationRecord,
	determineVideoPacketType,
	extractAv1CodecInfoFromPacket,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	extractVp9CodecInfoFromPacket,
	parseOpusIdentificationHeader,
	serializeAvcDecoderConfigurationRecord,
	Vp9CodecInfo,
} from './codec-data';
import { Logging } from './logging';
import { readEsDescriptor } from './isobmff/isobmff-reader';
import { FileSlice } from './reader';

/**
 * Base class for media sources. Media sources are used to add media samples to an output file.
 * @group Media sources
 * @public
 */
export abstract class MediaSource {
	/** @internal */
	abstract readonly _codec: MediaCodec;
	/** @internal */
	_connectedTrack: OutputTrack | null = null;
	/** @internal */
	_closingPromise: Promise<void> | null = null;
	/** @internal */
	_closed = false;
	/**
	 * Set when the encoder is configured with a bitrate.
	 * @internal
	 */
	_nominalBitrate: number | null = null;

	/** @internal */
	_ensureValidAdd() {
		if (!this._connectedTrack) {
			throw new Error('Source is not connected to an output track.');
		}

		if (this._connectedTrack.output.state === 'canceled') {
			throw new Error('Output has been canceled.');
		}

		if (this._connectedTrack.output.state === 'finalizing' || this._connectedTrack.output.state === 'finalized') {
			throw new Error('Output has been finalized.');
		}

		if (this._connectedTrack.output.state === 'pending') {
			throw new Error('Output has not started.');
		}

		if (this._closed) {
			throw new Error('Source is closed.');
		}
	}

	/** @internal */
	async _start() {}
	/** @internal */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async _flushAndClose(forceClose: boolean) {}

	/**
	 * Closes this source. This prevents future samples from being added and signals to the output file that no further
	 * samples will come in for this track. Calling `.close()` is optional but recommended after adding the
	 * last sample - for improved performance and reduced memory usage.
	 */
	close() {
		if (this._closingPromise) {
			return;
		}

		const connectedTrack = this._connectedTrack;

		if (!connectedTrack) {
			throw new Error('Cannot call close without connecting the source to an output track.');
		}

		if (connectedTrack.output.state === 'pending') {
			throw new Error('Cannot call close before output has been started.');
		}

		this._closingPromise = (async () => {
			await this._flushAndClose(false);

			this._closed = true;

			if (connectedTrack.output.state === 'finalizing' || connectedTrack.output.state === 'finalized') {
				return;
			}

			await connectedTrack.output._muxer.onTrackClose(connectedTrack);
		})();

		// Closing errors surface once the output is finalized or canceled, so don't let them go unhandled until then
		this._closingPromise.catch(() => {});
	}

	/** @internal */
	async _flushOrWaitForOngoingClose(forceClose: boolean) {
		return this._closingPromise ??= (async () => {
			await this._flushAndClose(forceClose);
			this._closed = true;
		})();
	}
}

/**
 * Base class for video sources - sources for video tracks.
 * @group Media sources
 * @public
 */
export abstract class VideoSource extends MediaSource {
	/** @internal */
	declare _connectedTrack: OutputVideoTrack | null;
	/** @internal */
	override readonly _codec: VideoCodec;
	/**
	 * The rate at which frames are expected to come in, if whoever feeds this source knows it. Encoders are told this
	 * frame rate when neither the encoding config nor the track metadata specify one.
	 * @internal
	 */
	_frameRateHint: number | null = null;
	/**
	 * Whether the source encodes the samples' alpha (`alpha: 'keep'`), so the track can turn transparent at any frame,
	 * even if the first ones are opaque.
	 * @internal
	 */
	_keepsAlpha = false;

	/** Internal constructor. */
	constructor(codec: VideoCodec) {
		super();

		if (!VIDEO_CODECS.includes(codec)) {
			throw new TypeError(`Invalid video codec '${codec}'. Must be one of: ${VIDEO_CODECS.join(', ')}.`);
		}

		this._codec = codec;
	}
}

const maybeEnsureIsKeyPacket = (track: OutputVideoTrack, packet: EncodedPacket) => {
	if (track.metadata.hasOnlyKeyPackets && packet.type !== 'key') {
		throw new Error('Cannot add non-key packets to a hasOnlyKeyPackets video track.');
	}
};

/**
 * The most basic video source; can be used to directly pipe encoded packets into the output file.
 * @group Media sources
 * @public
 */
export class EncodedVideoPacketSource extends VideoSource {
	/** Creates a new {@link EncodedVideoPacketSource} whose packets are encoded using `codec`. */
	constructor(codec: VideoCodec) {
		super(codec);
	}

	/**
	 * Adds an encoded packet to the output video track. Packets must be added in *decode order*, while a packet's
	 * timestamp must be its *presentation timestamp*. B-frames are handled automatically.
	 *
	 * @param meta - Additional metadata from the encoder. You should pass this for the first call, including a valid
	 * decoder config.
	 *
	 * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
	 * to respect writer and encoder backpressure.
	 */
	add(packet: EncodedPacket, meta?: EncodedVideoChunkMetadata) {
		if (!(packet instanceof EncodedPacket)) {
			throw new TypeError('packet must be an EncodedPacket.');
		}
		if (packet.isMetadataOnly) {
			throw new TypeError('Metadata-only packets cannot be added.');
		}
		if (meta !== undefined && (!meta || typeof meta !== 'object')) {
			throw new TypeError('meta, when provided, must be an object.');
		}

		this._ensureValidAdd();

		maybeEnsureIsKeyPacket(this._connectedTrack!, packet);
		return this._connectedTrack!.output._muxer.addEncodedVideoPacket(this._connectedTrack!, packet, meta);
	}
}

/**
 * Floors the timestamp to the start of the frame it falls into at the given frame rate. Timestamps meant to sit exactly
 * on a frame boundary often land a hair below it due to floating point error (1/30 + 1/30 + ..., or 0.3 - (0.1 + 0.2)
 * for zero), so those count as being on the boundary. Only that much error is absorbed: a few units in the last place
 * of the frame position, and at least that much around zero.
 */
const floorToFrame = (timestamp: number, frameRate: number) => {
	const position = timestamp * frameRate;
	const nearest = Math.round(position);
	const tolerance = 16 * Number.EPSILON * Math.max(1, Math.abs(nearest));
	const snapped = Math.abs(position - nearest) <= tolerance ? nearest : position;

	return Math.floor(snapped) / frameRate;
};

/** H.264 and HEVC encoders only take even dimensions, since they encode 4:2:0. */
const hasOddH26xDimension = (codec: VideoCodec, width: number, height: number) => {
	return (codec === 'avc' || codec === 'hevc') && (width % 2 === 1 || height % 2 === 1);
};

const oddH26xDimensionError = (codec: VideoCodec, width: number, height: number) => {
	return new Error(
		`The dimensions ${width}x${height} are not supported for codec '${codec}'; both width and height must be even`
		+ ` numbers. Make sure to round your dimensions to the nearest even number.`,
	);
};

class VideoEncoderWrapper {
	private ensureEncoderPromise: Promise<void> | null = null;
	/** Resolved once the wrapper is closed, so that nothing keeps waiting for an encoder that may never come. */
	private closedSignal = promiseWithResolvers();
	private encoderInitialized = false;
	private encoder: VideoEncoder | null = null;
	private encoderConfig: VideoEncoderConfig | null = null;
	// Set when the browser closed our encoders due to inactivity; they'll be recreated on the next encode
	private encodersReclaimed = false;
	private muxer: Muxer | null = null;
	private lastMultipleOfKeyFrameInterval = -1;
	private emittedEncoderPackets = 0;
	private chunkTimestampsAreShiftedByDuration = false; // See detectAvcChunkTimestampShift
	private encoderTimestampOffset: number | null = null; // See shiftFrameForEncoder

	// Tracks the input dimensions of the first frame
	private codedWidth: number | null = null;
	private codedHeight: number | null = null;
	// Tracks the output dimensions of the first frame (used to lock dimensions for fill/contain/cover)
	private outputWidth: number | null = null;
	private outputHeight: number | null = null;

	// Frame rate normalization state
	private frameRateLastSample: VideoSample | null = null;
	private frameRateLastTimestamp: number | null = null;
	private frameRateLastEndTimestamp: number | null = null;
	/** The encode options that the last frame rate sample was added with. */
	private frameRateLastEncodeOptions: VideoEncoderEncodeOptions | undefined = undefined;
	/**
	 * Whether a key frame was requested for a sample that took the last frame rate slot without being encoded, so the
	 * next frame encoded (the first one showing its picture, or the one after it) must be a key frame.
	 */
	private frameRateKeyFramePending = false;

	// VideoEncoder converts everything to microseconds, so we need to do some bookkeeping to restore the original
	// timing information
	private preciseTimings: {
		microsecondTimestamp: number;
		timestamp: number;
		duration: number;
		timestampIsValid: boolean;
		durationIsValid: boolean;
	}[] = [];

	private customEncoder: CustomVideoEncoder | null = null;
	private customEncoderCallSerializer = new CallSerializer();
	private customEncoderQueueSize = 0;

	// Set when the encoder uses quantizer-based rate control; carries the quantizer value applied to each frame
	private defaultEncodeOptions: VideoEncoderEncodeOptions = {};

	// Alpha stuff
	private alphaEncoder: VideoEncoder | null = null;
	private splitter: ColorAlphaSplitter | null = null;
	private splitterCreationFailed = false;
	private alphaFrameQueue: (VideoFrame | null)[] = [];

	/**
	 * Encoders typically throw their errors "out of band", meaning asynchronously in some other execution context.
	 * However, we want to surface these errors to the user within the normal control flow, so they don't go uncaught.
	 * So, we keep track of the encoder error and throw it as soon as we get the chance.
	 */
	private error: unknown = null;
	private errorSet = false;

	private setError(error: unknown) {
		if (!this.errorSet) {
			this.error = error;
			this.errorSet = true;
		}
	}

	private lastMuxerPromise: Promise<void> = Promise.resolve();
	/** How many adds are waiting for the writer to take what's been encoded so far; they still hold their samples. */
	private writerWaitCount = 0;
	private closed = false;

	constructor(private source: VideoSource, private encodingConfig: VideoEncodingConfig) {
		source._keepsAlpha = encodingConfig.alpha === 'keep';
	}

	async add(videoSample: VideoSample, shouldClose: boolean, encodeOptions?: VideoEncoderEncodeOptions) {
		const originalSample = videoSample;

		try {
			this.checkForEncoderError();
			this.source._ensureValidAdd();

			const config = this.encodingConfig;
			const sizeChangeBehavior = config.sizeChangeBehavior ?? 'deny';
			let isSizeChange = false;

			// Ensure video sample size remains constant or handle the change
			if (this.codedWidth !== null && this.codedHeight !== null) {
				if (videoSample.codedWidth !== this.codedWidth || videoSample.codedHeight !== this.codedHeight) {
					isSizeChange = true;
					if (sizeChangeBehavior === 'deny') {
						throw new Error(
							`Video sample size must remain constant. Expected ${this.codedWidth}x${this.codedHeight},`
							+ ` got ${videoSample.codedWidth}x${videoSample.codedHeight}. To allow the sample size to`
							+ ` change over time, set \`sizeChangeBehavior\` to a value other than 'deny' in the`
							+ ` encoding options.`,
						);
					}
				}
			} else {
				this.codedWidth = videoSample.codedWidth;
				this.codedHeight = videoSample.codedHeight;
			}

			// Determine if we need to apply transformations via canvas
			const hasTransformConfig = config.transform?.width !== undefined
				|| config.transform?.height !== undefined
				|| config.transform?.rotate !== undefined
				|| config.transform?.flip !== undefined
				|| config.transform?.crop !== undefined
				|| config.transform?.force === true;
			const needsTransform = hasTransformConfig || (isSizeChange && sizeChangeBehavior !== 'passThrough');

			if (needsTransform) {
				let targetWidth = config.transform?.width;
				let targetHeight = config.transform?.height;
				let appliedFit: 'fill' | 'contain' | 'cover' = config.transform?.fit ?? 'fill';

				// If the size changed and behavior is fill/contain/cover, lock to the original output dimensions
				if (isSizeChange && sizeChangeBehavior !== 'passThrough') {
					assert(this.outputWidth);
					assert(this.outputHeight);
					assert(sizeChangeBehavior !== 'deny');

					targetWidth = this.outputWidth!;
					targetHeight = this.outputHeight!;
					appliedFit = sizeChangeBehavior;
				}

				// AVC, HEVC and others require even dimensions; these codecs encode any size
				const anySize = config.codec === 'vp8' || config.codec === 'vp9' || config.codec === 'av1';
				const transformed = await videoSample.transform({
					width: targetWidth,
					height: targetHeight,
					roundDimensionsTo: anySize ? 1 : 2,
					crop: config.transform?.crop,
					rotate: config.transform?.rotate,
					flip: config.transform?.flip,
					fit: appliedFit,
					alpha: config.alpha,
				});

				// Save the output dimensions of the first frame
				if (this.outputWidth === null || this.outputHeight === null) {
					this.outputWidth = transformed.displayWidth;
					this.outputHeight = transformed.displayHeight;
				}

				if (shouldClose) {
					videoSample.close();
				}

				videoSample = transformed;
				shouldClose = true;

				if (this.closed) {
					// The source got closed (or the output canceled) while the frame was being transformed
					return;
				}
			} else {
				// If no canvas is needed, we still need to record the output dimensions for the first frame
				if (this.outputWidth === null || this.outputHeight === null) {
					this.outputWidth = videoSample.codedWidth;
					this.outputHeight = videoSample.codedHeight;
				}
			}

			const frameRate = config.transform?.frameRate;
			if (frameRate !== undefined) {
				// Apply frame rate normalization
				const originalEndTimestamp = videoSample.timestamp + videoSample.duration;
				const alignedTimestamp = floorToFrame(videoSample.timestamp, frameRate);

				if (this.frameRateLastSample !== null) {
					if (alignedTimestamp <= this.frameRateLastTimestamp!) {
						// Same frame rate slot, replace stored sample with the newer one. It isn't encoded itself, so a
						// key frame request of it goes to the next frame that is.
						this.frameRateLastSample.close();
						this.frameRateLastSample = videoSample.clone();
						this.frameRateLastEndTimestamp = originalEndTimestamp;
						this.frameRateLastEncodeOptions = encodeOptions;
						const keyFrame = encodeOptions?.keyFrame ?? videoSample.encodeOptions.keyFrame;
						this.frameRateKeyFramePending ||= keyFrame === true;
						return;
					} else {
						// Pad the gap by repeating the previous frame
						await this.padFrameRate(alignedTimestamp);

						if (this.closed) {
							return;
						}
					}
				}

				// Clone if the sample is still the user's, to avoid mutating externally-owned data. A sample we were
				// asked to close is ours, and cloning it would leave it unclosed.
				if (videoSample === originalSample && !shouldClose) {
					videoSample = videoSample.clone();
					shouldClose = true;
				}

				videoSample.setTimestamp(alignedTimestamp);
				videoSample.setDuration(1 / frameRate);

				this.frameRateLastSample?.close();
				this.frameRateLastSample = videoSample.clone();
				this.frameRateLastTimestamp = alignedTimestamp;
				this.frameRateLastEndTimestamp = originalEndTimestamp;
				this.frameRateLastEncodeOptions = encodeOptions;

				if (this.frameRateKeyFramePending) {
					// A key frame request of a sample that was replaced without being shown
					this.frameRateKeyFramePending = false;
					await this.processAndEncode(videoSample, { ...encodeOptions, keyFrame: true });
					return;
				}
			}

			await this.processAndEncode(videoSample, encodeOptions);
		} finally {
			if (shouldClose) {
				videoSample.close();
			}
		}
	}

	/**
	 * Runs the process function (if any) and encodes the resulting samples.
	 */
	private async processAndEncode(
		videoSample: VideoSample,
		encodeOptions?: VideoEncoderEncodeOptions,
	) {
		const config = this.encodingConfig;
		let samplesToEncode: VideoSample[];

		// Apply the user-defined process function, if any
		if (config.transform?.process) {
			let processed = config.transform.process(videoSample);
			if (isThenable(processed)) {
				processed = await processed;
			}

			if (processed === null) {
				return;
			}

			if (!Array.isArray(processed)) {
				processed = [processed];
			}

			const mappedSamples: VideoSample[] = [];

			try {
				for (const x of processed) {
					if (x instanceof VideoSample) {
						mappedSamples.push(x);
					} else if (typeof VideoFrame !== 'undefined' && x instanceof VideoFrame) {
						mappedSamples.push(new VideoSample(x, { encodeOptions: videoSample.encodeOptions }));
					} else {
						// Calling the VideoSample constructor here will automatically handle input validation for us
						// (it throws for any non-legal argument).
						mappedSamples.push(new VideoSample(x as CanvasImageSource, {
							timestamp: videoSample.timestamp,
							duration: videoSample.duration,
							encodeOptions: videoSample.encodeOptions,
						}));
					}
				}
			} catch (error) {
				// One of the returned elements was invalid; close everything closable so no resource is leaked
				for (const sample of mappedSamples) {
					if (sample !== videoSample) {
						sample.close();
					}
				}
				for (const x of processed) {
					if (x instanceof VideoSample && x !== videoSample) {
						x.close();
					} else if (typeof VideoFrame !== 'undefined' && x instanceof VideoFrame) {
						x.close();
					}
				}

				throw error;
			}

			samplesToEncode = mappedSamples;
		} else {
			samplesToEncode = [videoSample];
		}

		try {
			for (const sampleToEncode of samplesToEncode) {
				if (!this.encoderInitialized) {
					if (this.closed) {
						// The source got closed (or the output canceled) while we were awaiting, e.g. the process
						// function, so don't create an encoder nothing would close anymore
						break;
					}

					if (!this.ensureEncoderPromise) {
						this.ensureEncoder(sampleToEncode);
					}

					// No, this "if" statement is not useless. Sometimes, the above call to
					// `ensureEncoder` might have synchronously completed and the encoder is
					// already initialized. In this case, we don't need to await the promise
					// anymore. This also fixes nasty async race condition bugs when multiple
					// code paths are calling this method: It's important that the call that
					// initialized the encoder go through this code first.
					if (!this.encoderInitialized) {
						// Racing the close: an initialization may never finish (one hanging in a platform codec, say)
						await Promise.race([this.ensureEncoderPromise, this.closedSignal.promise]);
						if (this.closed) {
							break;
						}
					}
				}
				assert(this.encoderInitialized);

				if (this.closed) {
					break;
				}

				if (this.encodersReclaimed) {
					this.recreateWebCodecsEncoders();
				}

				// A track that can only hold key packets gets nothing but key frames
				const keyFrameInterval = this.source._connectedTrack?.metadata.hasOnlyKeyPackets
					? 0
					: this.encodingConfig.keyFrameInterval ?? 2;
				// Counted in whole microseconds, the precision of WebCodecs timestamps, since in floating point a
				// multiple of a fractional interval can come out just short of it (0.6 / 0.2 = 2.9999999999999996)
				const multipleOfKeyFrameInterval = Math.floor(
					Math.round(sampleToEncode.timestamp * 1e6) / Math.max(Math.round(keyFrameInterval * 1e6), 1),
				);

				const mergedEncodeOptions = {
					...this.defaultEncodeOptions,
					...sampleToEncode.encodeOptions,
					...encodeOptions,
				};

				const finalEncodeOptions = {
					...mergedEncodeOptions,
					keyFrame: mergedEncodeOptions.keyFrame !== undefined
						? mergedEncodeOptions.keyFrame
						// Ensure a key frame every keyFrameInterval seconds. It is important that all video tracks
						// follow the same "key frame" rhythm, because aligned key frames are required to start new
						// fragments in ISOBMFF or clusters in Matroska (or at least desirable).
						: keyFrameInterval === 0
							|| multipleOfKeyFrameInterval !== this.lastMultipleOfKeyFrameInterval,
				};
				this.lastMultipleOfKeyFrameInterval = multipleOfKeyFrameInterval;

				this.encodingConfig.onEncodedSample?.(sampleToEncode);

				if (this.customEncoder) {
					this.customEncoderQueueSize++;

					// We clone the sample so it cannot be closed on us from the outside before it reaches the encoder
					const clonedSample = sampleToEncode.clone();

					const promise = this.customEncoderCallSerializer
						.call(() => this.customEncoder!.encode(clonedSample, finalEncodeOptions))
						.catch((error: unknown) => this.setError(error))
						.finally(() => {
							this.customEncoderQueueSize--;
							clonedSample.close();
						});

					if (this.customEncoderQueueSize >= 4) {
						await promise;
					}
				} else {
					assert(this.encoder);

					let videoFrame = sampleToEncode.toVideoFrame();

					const preciseTimingIndex = binarySearchLessOrEqual(
						this.preciseTimings,
						videoFrame.timestamp,
						x => x.microsecondTimestamp,
					);
					const existingEntry = preciseTimingIndex !== -1
						? this.preciseTimings[preciseTimingIndex]
						: null;
					if (existingEntry && existingEntry.microsecondTimestamp === videoFrame.timestamp) {
						if (existingEntry.timestamp !== sampleToEncode.timestamp) {
							// Mapping isn't unique, can't use the timestamp
							existingEntry.timestampIsValid = false;
						}
						if (existingEntry.duration !== sampleToEncode.duration) {
							// Mapping isn't unique, can't use the duration
							existingEntry.durationIsValid = false;
						}
					} else {
						this.preciseTimings.splice(preciseTimingIndex + 1, 0, {
							microsecondTimestamp: videoFrame.timestamp,
							timestamp: sampleToEncode.timestamp,
							duration: sampleToEncode.duration,
							timestampIsValid: true,
							durationIsValid: true,
						});

						// Make sure it doesn't grow indefinitely
						if (this.preciseTimings.length > 128) {
							this.preciseTimings.shift();
						}
					}

					videoFrame = this.shiftFrameForEncoder(videoFrame);

					if (!this.alphaEncoder) {
						// No alpha encoder, simple case
						try {
							this.encoder.encode(videoFrame, finalEncodeOptions);
						} finally {
							videoFrame.close();
						}
					} else {
						// We're expected to encode alpha as well
						const frameDefinitelyHasNoAlpha = !!videoFrame.format && !videoFrame.format.includes('A');

						if (frameDefinitelyHasNoAlpha || this.splitterCreationFailed) {
							this.alphaFrameQueue.push(null);
							try {
								this.encoder.encode(videoFrame, finalEncodeOptions);
							} finally {
								videoFrame.close();
							}
						} else {
							if (!this.splitter) {
								this.splitter = new ColorAlphaSplitter();
							}

							// Frames made from canvases and images come with premultiplied colors, but the color
							// frame must hold straight ones, as the alpha channel is applied on top when decoding
							const premultiplied = sampleToEncode._fromImageSource
								&& await imageSourceFramesArePremultiplied();

							// The splitter takes ownership, so no need to close the frames ourselves
							const { colorFrame, alphaFrame } = await this.splitter.split(videoFrame, premultiplied);

							this.alphaFrameQueue.push(alphaFrame);
							try {
								this.encoder.encode(colorFrame, finalEncodeOptions);
							} finally {
								colorFrame.close();
							}
						}
					}

					// We need to do this after sending the frame to the encoder as the frame otherwise might be closed
					if (this.encoder.encodeQueueSize >= 4) {
						await new Promise(resolve =>
							this.encoder!.addEventListener('dequeue', resolve, { once: true }),
						);
					}
				}

				this.writerWaitCount++;
				try {
					await this.lastMuxerPromise; // Allow the writer to apply backpressure
				} finally {
					this.writerWaitCount--;
				}
			}
		} finally {
			for (const sample of samplesToEncode) {
				if (sample !== videoSample) {
					sample.close();
				}
			}
		}
	}

	/** Repeats the last frame rate sample to fill the gap up to the given timestamp. */
	private async padFrameRate(until: number) {
		const frameRate = this.encodingConfig.transform!.frameRate!;
		assert(this.frameRateLastSample);

		const frameDifference = Math.round((until - this.frameRateLastTimestamp!) * frameRate);

		// The repeats are encoded with the options of the sample they repeat, except for its key frame request, which
		// is only for the first frame showing its picture: the sample itself if it was encoded, else the first repeat
		const encodeOptions = { ...this.frameRateLastEncodeOptions };
		delete encodeOptions.keyFrame;

		for (let i = 1; i < frameDifference; i++) {
			if (this.closed || !this.frameRateLastSample) {
				// The source got closed (or the output canceled) while we were encoding the previous repeat
				return;
			}

			using sample = this.frameRateLastSample.clone();
			sample.setTimestamp(this.frameRateLastTimestamp! + i / frameRate);
			sample.setDuration(1 / frameRate);
			if (sample.encodeOptions.keyFrame !== undefined) {
				const sampleEncodeOptions = { ...sample.encodeOptions } as VideoEncoderEncodeOptions;
				delete sampleEncodeOptions.keyFrame;
				sample.setEncodeOptions(sampleEncodeOptions);
			}

			if (this.frameRateKeyFramePending) {
				this.frameRateKeyFramePending = false;
				await this.processAndEncode(sample, { ...encodeOptions, keyFrame: true });
			} else {
				await this.processAndEncode(sample, encodeOptions);
			}
		}
	}

	private ensureEncoder(videoSample: VideoSample) {
		this.ensureEncoderPromise = (async () => {
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			const quality = resolveQuality(this.encodingConfig.quality, this.encodingConfig.bitrate);
			assert(quality !== undefined);

			const candidates = buildVideoEncoderConfigs({
				...this.encodingConfig,
				quality,
				width: videoSample.codedWidth,
				height: videoSample.codedHeight,
				squarePixelWidth: videoSample.squarePixelWidth,
				squarePixelHeight: videoSample.squarePixelHeight,
				// Encoders split the bitrate across frames based on this rate (browsers assume 30 Hz without it), so
				// pass whichever rate the frames are known to come in at. A process function can drop, duplicate or
				// retime frames, in which case only the track's declared frame rate can be trusted.
				framerate: this.encodingConfig.transform?.process
					? this.source._connectedTrack?.metadata.frameRate
					: this.encodingConfig.transform?.frameRate
						?? this.source._connectedTrack?.metadata.frameRate
						?? this.source._frameRateHint
						?? undefined,
			});

			// Try the candidate configs in order of preference until we find one that is supported
			let selected: VideoEncoderConfigCandidate | null = null;
			let MatchingCustomEncoder: (typeof customVideoEncoders)[number] | undefined;

			for (const candidate of candidates) {
				const candidateConfig = candidate.config;
				this.encodingConfig.onEncoderConfig?.(candidateConfig);

				MatchingCustomEncoder = customVideoEncoders.find(x => x.supports(
					this.encodingConfig.codec,
					candidateConfig,
				));
				if (MatchingCustomEncoder) {
					selected = candidate;
					break;
				}

				if (typeof VideoEncoder === 'undefined') {
					continue;
				}

				candidateConfig.alpha = 'discard'; // Since we handle alpha ourselves

				if (this.encodingConfig.alpha === 'keep') {
					// Encoding alpha requires using two parallel encoders, so we need to make sure they stay in sync
					// and that neither of them drops frames. Setting latencyMode to 'quality' achieves this, because
					// "User Agents MUST not drop frames to achieve the target bitrate and/or framerate."
					candidateConfig.latencyMode = 'quality';
				}

				const { codec } = this.encodingConfig;
				if (hasOddH26xDimension(codec, candidateConfig.width, candidateConfig.height)) {
					// Throw a special error for this case as it gets hit often
					throw oddH26xDimensionError(codec, candidateConfig.width, candidateConfig.height);
				}

				try {
					const support = await VideoEncoder.isConfigSupported(candidateConfig);
					if (support.supported) {
						selected = candidate;
						break;
					}
				} catch {
					// Not supported
				}
			}

			if (!selected) {
				const { width, height } = candidates[0]!.config;
				if (hasOddH26xDimension(this.encodingConfig.codec, width, height)) {
					// Also when no custom encoder takes these dimensions, which says more than a missing VideoEncoder
					throw oddH26xDimensionError(this.encodingConfig.codec, width, height);
				}

				if (typeof VideoEncoder === 'undefined') {
					throw new Error(missingWebCodecsClassMessage('VideoEncoder'));
				}

				// The candidates only differ in their rate control, so we describe them as one config with a
				// slash-separated list of the attempted rate control methods
				const firstConfig = candidates[0]!.config;
				const rateControls = candidates.map(({ config, quantizer }) =>
					quantizer !== null ? `quantizer ${quantizer}` : `${config.bitrate} bps`,
				);

				throw new Error(
					`This specific encoder configuration (${firstConfig.codec}, ${rateControls.join(' / ')},`
					+ ` ${firstConfig.width}x${firstConfig.height}, hardware acceleration:`
					+ ` ${firstConfig.hardwareAcceleration ?? 'no-preference'}) is not supported in this environment.`
					+ ` Consider using another codec or changing your video parameters.`,
				);
			}

			const encoderConfig = selected.config;
			if (selected.quantizer !== null) {
				// The chosen config uses quantizer-based rate control, so each frame must carry the quantizer value
				this.defaultEncodeOptions = buildQuantizerEncodeOptions(
					this.encodingConfig.codec,
					selected.quantizer,
				);
			} else {
				this.source._nominalBitrate = encoderConfig.bitrate ?? null;
			}

			if (MatchingCustomEncoder) {
				// @ts-expect-error "Can't create instance of abstract class 🤓"
				this.customEncoder = new MatchingCustomEncoder() as CustomVideoEncoder;
				// @ts-expect-error It's technically readonly
				this.customEncoder.codec = this.encodingConfig.codec;
				// @ts-expect-error It's technically readonly
				this.customEncoder.config = encoderConfig;
				// @ts-expect-error It's technically readonly
				this.customEncoder.onPacket = (packet, meta) => {
					if (!(packet instanceof EncodedPacket)) {
						throw new TypeError('The first argument passed to onPacket must be an EncodedPacket.');
					}
					if (meta !== undefined && (!meta || typeof meta !== 'object')) {
						throw new TypeError('The second argument passed to onPacket must be an object or undefined.');
					}

					maybeEnsureIsKeyPacket(this.source._connectedTrack!, packet);

					this.encodingConfig.onEncodedPacket?.(packet, meta);
					this.lastMuxerPromise
						= this.muxer!.addEncodedVideoPacket(this.source._connectedTrack!, packet, meta)
							.catch((error) => {
								this.setError(error);
							});
				};
				// @ts-expect-error It's technically readonly
				this.customEncoder.onError = (error) => {
					this.setError(error);
				};

				await this.customEncoder.init();
			} else {
				this.encoderConfig = encoderConfig;

				if (this.encodingConfig.codec === 'avc' && isFirefox()) {
					this.chunkTimestampsAreShiftedByDuration = await detectAvcChunkTimestampShift();
				}

				this.createWebCodecsEncoders();
			}

			assert(this.source._connectedTrack);
			this.muxer = this.source._connectedTrack.output._muxer;

			if (this.closed) {
				// Closed (or canceled) while this initialization was pending, when there was no encoder to close yet:
				// nothing else will close the ones just created
				if (this.encoder && this.encoder.state !== 'closed') {
					this.encoder.close();
				}
				if (this.alphaEncoder && this.alphaEncoder.state !== 'closed') {
					this.alphaEncoder.close();
				}
			}

			this.encoderInitialized = true;
		})();

		// An initialization error has to stick like encoding errors do, so that it also fails finalize(), even when the
		// add() that started the initialization wasn't awaited
		this.ensureEncoderPromise.catch((error: unknown) => this.setError(error));
	}

	private createWebCodecsEncoders() {
		const encoderConfig = this.encoderConfig;
		assert(encoderConfig);

		/** Queue of color chunks waiting for their alpha counterpart. */
		const colorChunkQueue: {
			chunk: EncodedVideoChunk;
			meta: EncodedVideoChunkMetadata | undefined;
		}[] = [];
		/** Each value is the number of encoded alpha chunks at which a null alpha chunk should be added. */
		const nullAlphaChunkQueue: number[] = [];
		let encodedAlphaChunkCount = 0;
		let alphaEncoderQueue = 0;

		const handleError = (error: DOMException, stack: string | undefined) => {
			if (isCodecReclaimedError(error)) {
				this.encodersReclaimed = true;
				return;
			}

			error.stack = stack; // Provide a more useful stack trace, the default one sucks
			this.setError(error);
		};

		const stack = new Error('Encoding error').stack;

		this.encoder = new VideoEncoder({
			output: (chunk, meta) => {
				if (!this.alphaEncoder) {
					// We're done
					this.addPacket(chunk, null, meta);
					return;
				}

				const alphaFrame = this.alphaFrameQueue.shift();
				assert(alphaFrame !== undefined);

				if (alphaFrame) {
					this.alphaEncoder.encode(alphaFrame, {
						...this.defaultEncodeOptions,
						// Crucial: The alpha frame is forced to be a key frame whenever the color frame
						// also is. Without this, playback can glitch and even crash in some browsers.
						// This is the reason why the two encoders are wired in series and not in parallel.
						keyFrame: chunk.type === 'key',
					});
					alphaEncoderQueue++;
					alphaFrame.close();
					colorChunkQueue.push({ chunk, meta });
				} else {
					// There was no alpha component for this frame
					if (alphaEncoderQueue === 0) {
						// No pending alpha encodes either, so we're done
						this.addPacket(chunk, null, meta);
					} else {
						// There are still alpha encodes pending, so we can't add the packet immediately since
						// we'd end up with out-of-order packets. Instead, let's queue a null alpha chunk to be
						// added in the future, after the current encoder workload has completed:
						nullAlphaChunkQueue.push(encodedAlphaChunkCount + alphaEncoderQueue);
						colorChunkQueue.push({ chunk, meta });
					}
				}
			},
			error: error => handleError(error, stack),
		});
		this.encoder.configure(encoderConfig);

		if (this.encodingConfig.alpha === 'keep') {
			const stack = new Error('Encoding error').stack;

			// We need to encode alpha as well, which we do with a separate encoder
			this.alphaEncoder = new VideoEncoder({
				// We ignore the alpha chunk's metadata
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				output: (chunk, meta) => {
					alphaEncoderQueue--;

					// There has to be a color chunk because the encoders are wired in series
					const colorChunk = colorChunkQueue.shift();
					assert(colorChunk !== undefined);

					this.addPacket(colorChunk.chunk, chunk, colorChunk.meta);

					// See if there are any null alpha chunks queued up
					encodedAlphaChunkCount++;
					while (
						nullAlphaChunkQueue.length > 0
						&& nullAlphaChunkQueue[0] === encodedAlphaChunkCount
					) {
						nullAlphaChunkQueue.shift();
						const colorChunk = colorChunkQueue.shift();
						assert(colorChunk !== undefined);

						this.addPacket(colorChunk.chunk, null, colorChunk.meta);
					}
				},
				error: error => handleError(error, stack),
			});
			this.alphaEncoder.configure(encoderConfig);
		}
	}

	private addPacket(
		colorChunk: EncodedVideoChunk,
		alphaChunk: EncodedVideoChunk | null,
		meta: EncodedVideoChunkMetadata | undefined,
	) {
		const sideData: EncodedPacketSideData = {};

		if (alphaChunk) {
			const alphaData = new Uint8Array(alphaChunk.byteLength);
			alphaChunk.copyTo(alphaData);

			sideData.alpha = alphaData;
		}

		let packet = EncodedPacket.fromEncodedChunk(colorChunk, sideData);

		const encoderConfig = this.encoderConfig;
		assert(encoderConfig);

		if (meta?.decoderConfig?.colorSpace) {
			// WebKitGTK's encoder passes the input frames' color space through, including its non-standard values like
			// 'unspecified' (the same ones VideoSample treats as unknown), so treat those as unknown here too
			const { primaries, transfer, matrix, fullRange } = meta.decoderConfig.colorSpace;
			meta.decoderConfig.colorSpace = {
				primaries: primaries != null && primaries in COLOR_PRIMARIES_MAP ? primaries : null,
				transfer: transfer != null && transfer in TRANSFER_CHARACTERISTICS_MAP ? transfer : null,
				matrix: matrix != null && matrix in MATRIX_COEFFICIENTS_MAP ? matrix : null,
				fullRange,
			};
		}

		if (meta?.decoderConfig) {
			let vp9CodecInfo: Vp9CodecInfo | null = null;
			if (this.encodingConfig.codec === 'vp9') {
				vp9CodecInfo = extractVp9CodecInfoFromPacket(packet.data);

				// VP9 bitstreams don't signal a level, so the one derived from the frame size is only a lower bound.
				// Keep the configured level, which also accounts for frame rate and bitrate, if it's higher.
				const configuredLevel = Number(encoderConfig.codec.split('.')[2]);
				if (vp9CodecInfo && Number.isInteger(configuredLevel) && configuredLevel > vp9CodecInfo.level) {
					vp9CodecInfo.level = configuredLevel;
				}
			}

			// Let's correct the codec string based on the actual bitstream data, rather than leaving it on the default
			// value (which is just what was in the encoder config). This provides better consistency.
			meta.decoderConfig.codec = extractVideoCodecString({
				width: encoderConfig.width,
				height: encoderConfig.height,
				codec: this.encodingConfig.codec,
				codecDescription: meta.decoderConfig.description
					? toUint8Array(meta.decoderConfig.description)
					: null,
				colorSpace: meta.decoderConfig.colorSpace ?? null,
				avcType: encoderConfig.codec.includes('avc1.')
					? 1
					: encoderConfig.codec.includes('avc3.')
						? 3
						: null,
				avcCodecInfo: this.encodingConfig.codec === 'avc' && !meta.decoderConfig.description
					? extractAvcDecoderConfigurationRecord(packet.data)
					: null,
				hevcCodecInfo: this.encodingConfig.codec === 'hevc' && !meta.decoderConfig.description
					? extractHevcDecoderConfigurationRecord(packet.data)
					: null,
				vp9CodecInfo,
				av1CodecInfo: this.encodingConfig.codec === 'av1'
					? extractAv1CodecInfoFromPacket(packet.data)
					: null,
				proresFormat: null, // Can't be encoded by WebCodecs
			});

			if (this.encodingConfig.codec === 'hevc' && meta.decoderConfig.description) {
				// A description means the parameter sets are out of band, which is what 'hvc1' stands for (ISO/IEC
				// 14496-15). It's also the sample entry the ISOBMFF muxer writes, which the codec string must name.
				meta.decoderConfig.codec = meta.decoderConfig.codec.replace(/^hev1\./, 'hvc1.');
			}

			if (this.encodingConfig.codec === 'avc' && meta.decoderConfig.description && isFirefox()) {
				// This works around https://bugzilla.mozilla.org/show_bug.cgi?id=2082867
				// Also see https://github.com/Vanilagy/mediabunny/issues/559
				const parsed = deserializeAvcDecoderConfigurationRecord(toUint8Array(meta.decoderConfig.description));
				let sps = parsed?.sequenceParameterSets[0];

				if (sps && sps[0] === sps[1]) { // The first two bytes of the SPS being the same is a reliable signal
					assert(parsed);
					sps = sps.subarray(1);

					let pps = parsed.pictureParameterSets[0];
					if (pps) {
						pps = pps.subarray(1);
					}

					const record = serializeAvcDecoderConfigurationRecord({
						...parsed,
						sequenceParameterSets: [sps],
						pictureParameterSets: pps ? [pps] : [],
					});
					meta.decoderConfig.description = record;
				}
			}
		}

		let microsecondTimestamp = colorChunk.timestamp;
		if (this.encoderTimestampOffset) {
			// The encoder got the frame's timestamp shifted, so undo that (see shiftFrameForEncoder)
			microsecondTimestamp -= this.encoderTimestampOffset;
			packet = packet.clone({ timestamp: microsecondTimestamp / 1e6 });
		}
		if (this.chunkTimestampsAreShiftedByDuration) {
			// The encoder added the frame's duration to its timestamp, so undo that
			microsecondTimestamp -= colorChunk.duration ?? 0;
			packet = packet.clone({ timestamp: microsecondTimestamp / 1e6 });
		}

		// See if there's a relevant timing entry to refine the packet's timing data
		const preciseTimingIndex = binarySearchLessOrEqual(
			this.preciseTimings,
			microsecondTimestamp,
			x => x.microsecondTimestamp,
		);
		const entry = preciseTimingIndex !== -1
			? this.preciseTimings[preciseTimingIndex]
			: null;

		let actualType: PacketType | null = null;
		if (this.emittedEncoderPackets === 0 && packet.type === 'delta' && meta?.decoderConfig) {
			// https://github.com/Vanilagy/mediabunny/issues/365
			// We expect the first packet to be a key packet. If it's not, let's actually verify that it's
			// not by getting the actual type.
			actualType = determineVideoPacketType(
				this.encodingConfig.codec,
				meta.decoderConfig,
				packet.data,
			);
		}

		// Define the packet
		if ((entry && entry.microsecondTimestamp === microsecondTimestamp) || actualType !== null) {
			packet = packet.clone({
				timestamp: entry?.timestampIsValid ? entry.timestamp : undefined,
				duration: entry?.durationIsValid ? entry.duration : undefined,
				type: actualType ?? undefined,
			});
		}

		maybeEnsureIsKeyPacket(this.source._connectedTrack!, packet);

		this.encodingConfig.onEncodedPacket?.(packet, meta);
		this.lastMuxerPromise
			= this.muxer!.addEncodedVideoPacket(this.source._connectedTrack!, packet, meta)
				.catch((error) => {
					this.setError(error);
				});

		this.emittedEncoderPackets++;
	}

	/**
	 * Some encoders can't take negative timestamps: Windows' Media Foundation hardware encoders (as used by Chrome)
	 * wrap them around and stall. So when the first frame's timestamp is negative, every frame reaches the encoder
	 * shifted by a constant offset that makes it non-negative, which is subtracted from the encoded chunks again.
	 */
	private shiftFrameForEncoder(videoFrame: VideoFrame) {
		this.encoderTimestampOffset ??= videoFrame.timestamp < 0
			? Math.ceil(-videoFrame.timestamp / 1e6) * 1e6 // Whole seconds, in microseconds
			: 0;
		if (this.encoderTimestampOffset === 0) {
			return videoFrame;
		}

		const shiftedFrame = new VideoFrame(videoFrame, {
			timestamp: videoFrame.timestamp + this.encoderTimestampOffset,
		});
		videoFrame.close();

		return shiftedFrame;
	}

	// Browsers may reclaim codecs that have been inactive for a while (see
	// https://github.com/Vanilagy/mediabunny/issues/531), closing them and reporting a QuotaExceededError. Since a
	// reclaimed encoder was idle, no frames are lost, so we transparently replace the encoders with fresh ones.
	private recreateWebCodecsEncoders() {
		assert(this.encoder);

		if (this.encoder.state !== 'closed') {
			this.encoder.close();
		}
		if (this.alphaEncoder && this.alphaEncoder.state !== 'closed') {
			this.alphaEncoder.close();
		}

		this.alphaFrameQueue.forEach(x => x?.close());
		this.alphaFrameQueue.length = 0;

		this.encodersReclaimed = false;
		this.lastMultipleOfKeyFrameInterval = -1; // The fresh encoder must start with a key frame

		this.createWebCodecsEncoders();
	}

	async flushAndClose(forceClose: boolean, initializationSettled = false) {
		// When force closing, don't wait for an initialization that may never finish (one hanging in a platform codec,
		// say), but close the encoder once the initialization has settled, either way (a failed one can still leave an
		// encoder behind)
		const closeEncoderLater = forceClose
			&& !initializationSettled
			&& !!this.ensureEncoderPromise
			&& !this.encoderInitialized;
		if (closeEncoderLater) {
			const closeEncoder = () => this.flushAndClose(true, true);
			void this.ensureEncoderPromise!.then(closeEncoder, closeEncoder).catch(() => {});
		} else {
			// An encoder that's still initializing can't be flushed or closed yet, so let it finish (or fail) first
			await this.ensureEncoderPromise?.catch(() => {});
		}

		try {
			if (!forceClose) {
				this.checkForEncoderError();

				// Final frame rate padding: fill remaining frames up to the last sample's original end timestamp
				if (this.frameRateLastSample) {
					const frameRate = this.encodingConfig.transform!.frameRate!;
					const alignedEnd = floorToFrame(this.frameRateLastEndTimestamp!, frameRate);
					await this.padFrameRate(alignedEnd);
				}
			}

			this.closed = true;

			if (!forceClose) {
				if (this.customEncoder) {
					void this.customEncoderCallSerializer.call(() => this.customEncoder!.flush())
						.catch((error: unknown) => this.setError(error));
				} else if (this.encoder && !this.encodersReclaimed) {
					// These are wired in series, therefore they must also be flushed in series. An encoder whose
					// configure() threw is left unconfigured; there's nothing to flush then (it would throw).
					if (this.encoder.state === 'configured') {
						await this.encoder.flush();
					}
					if (this.alphaEncoder?.state === 'configured') {
						await this.alphaEncoder.flush();
					}

					// Workaround for https://issues.chromium.org/issues/529852980 to give it time for errors to
					// surface
					await wait(25);
				}
			}
		} finally {
			// This cleanup must also run when padding or flushing threw (e.g. due to an encoder error), otherwise
			// samples, frames and encoders would be left dangling
			this.closed = true;
			this.closedSignal.resolve();

			this.frameRateLastSample?.close();
			this.frameRateLastSample = null;
			this.frameRateLastEncodeOptions = undefined;
			this.frameRateKeyFramePending = false;

			if (this.customEncoder) {
				if (!closeEncoderLater) {
					await this.customEncoderCallSerializer.call(() => this.customEncoder!.close())
						.catch((error: unknown) => this.setError(error));
				}
			} else if (this.encoder) {
				if (this.encoder.state !== 'closed') {
					this.encoder.close();
				}
				if (this.alphaEncoder && this.alphaEncoder.state !== 'closed') {
					this.alphaEncoder.close();
				}

				this.alphaFrameQueue.forEach(x => x?.close());
				this.alphaFrameQueue.length = 0;

				this.splitter?.close();
			}
		}

		if (!forceClose) {
			this.checkForEncoderError();
		}
	}

	/**
	 * How many samples this encoder is still working on: the ones queued in the encoder, and the ones whose add is
	 * waiting for the writer to apply backpressure (they're held until then).
	 */
	getQueueSize() {
		if (this.customEncoder) {
			return this.customEncoderQueueSize + this.writerWaitCount;
		} else {
			// Because the color and alpha encoders are wired in series, there's no need to also include the alpha
			// encoder's queue size here
			return (this.encoder?.encodeQueueSize ?? 0) + this.writerWaitCount;
		}
	}

	checkForEncoderError() {
		if (this.errorSet) {
			throw this.error;
		}
	}
}

let avcChunkTimestampShiftPromise: Promise<boolean> | null = null;

// Detects https://bugzilla.mozilla.org/show_bug.cgi?id=2082890 so we can work around it
const detectAvcChunkTimestampShift = () => {
	return avcChunkTimestampShiftPromise ??= (async () => {
		let chunkTimestamp: number | null = null;
		const encoder = new VideoEncoder({
			output: (chunk) => {
				chunkTimestamp ??= chunk.timestamp;
			},
			error: () => {},
		});

		try {
			encoder.configure({
				codec: 'avc1.64001f',
				width: 1280,
				height: 720,
			});

			const frame = new VideoFrame(new Uint8Array(1280 * 720 * 1.5), {
				format: 'I420',
				codedWidth: 1280,
				codedHeight: 720,
				timestamp: 0,
				duration: 500,
			});
			encoder.encode(frame, { keyFrame: true });
			frame.close();

			await encoder.flush();
		} catch {
			return false;
		} finally {
			if (encoder.state !== 'closed') {
				encoder.close();
			}
		}

		return chunkTimestamp === 500;
	})();
};

let splitterWorkerUrl: string | null = null;

let imageSourceFramesArePremultipliedPromise: Promise<boolean> | null = null;

/**
 * Browsers store canvases and images premultiplied by alpha, and VideoFrames created from them hand out these
 * premultiplied color values from copyTo() (Chromium and Firefox both do). Detects this once.
 */
const imageSourceFramesArePremultiplied = () => {
	return imageSourceFramesArePremultipliedPromise ??= (async () => {
		let frame: VideoFrame | null = null;

		try {
			const canvas = new OffscreenCanvas(1, 1);
			const context = canvas.getContext('2d');
			if (!context) {
				return false;
			}

			context.fillStyle = 'rgba(255, 0, 0, 0.5)';
			context.fillRect(0, 0, 1, 1);

			frame = new VideoFrame(canvas, { timestamp: 0 });
			if (frame.format !== 'RGBA' && frame.format !== 'BGRA') {
				return false;
			}

			const data = new Uint8Array(frame.allocationSize());
			await frame.copyTo(data);

			// Red reads as 255 when straight and as 128 when premultiplied
			return data[frame.format === 'RGBA' ? 0 : 2]! < 192;
		} catch {
			return false;
		} finally {
			frame?.close();
		}
	})();
};

/** Utility class for splitting a composite frame into separate color and alpha parts on the CPU in a worker. */
export class ColorAlphaSplitter {
	private worker: Worker | null = null;
	private pendingRequests = new Map<
		number,
		ReturnType<typeof promiseWithResolvers<{ colorFrame: VideoFrame; alphaFrame: VideoFrame }>>
	>();

	private nextRequestId = 0;

	/** `premultiplied` says whether the color values of an RGBA source frame are premultiplied by alpha. */
	split(
		sourceFrame: VideoFrame,
		premultiplied: boolean,
	): Promise<{ colorFrame: VideoFrame; alphaFrame: VideoFrame }> {
		if (!this.worker) {
			if (!splitterWorkerUrl) {
				const blob = new Blob(
					[`(${colorAlphaSplitterWorkerCode.toString()})()`],
					{ type: 'application/javascript' },
				);
				splitterWorkerUrl = URL.createObjectURL(blob);
			}

			this.worker = new Worker(splitterWorkerUrl);

			this.worker.addEventListener('message', (event: MessageEvent<ColorAlphaSplitterWorkerResponse>) => {
				const data = event.data;
				const pending = this.pendingRequests.get(data.id);
				if (!pending) {
					return;
				}
				this.pendingRequests.delete(data.id);

				if ('error' in data) {
					pending.reject(new Error(data.error));
				} else {
					pending.resolve({ colorFrame: data.colorFrame, alphaFrame: data.alphaFrame });
				}
			});

			this.worker.addEventListener('error', (event) => {
				const error = new Error(event.message || 'Color/alpha splitter worker error.');
				for (const pending of this.pendingRequests.values()) {
					pending.reject(error);
				}
				this.pendingRequests.clear();
			});
		}

		const id = this.nextRequestId++;
		const pending = promiseWithResolvers<{ colorFrame: VideoFrame; alphaFrame: VideoFrame }>();
		this.pendingRequests.set(id, pending);
		this.worker.postMessage({ id, sourceFrame, premultiplied }, { transfer: [sourceFrame] });

		return pending.promise;
	}

	close() {
		this.worker?.terminate();
		this.worker = null;

		const error = new Error('Color/alpha splitter closed.');
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}
}

type ColorAlphaSplitterWorkerRequest = {
	id: number;
	sourceFrame: VideoFrame;
	premultiplied: boolean;
};

type ColorAlphaSplitterWorkerResponse =
	| { id: number; colorFrame: VideoFrame; alphaFrame: VideoFrame }
	| { id: number; error: string };

const colorAlphaSplitterWorkerCode = () => {
	// Reused across frames as long as the size matches, since consecutive frames usually share dimensions.
	let cpuSourceBuffer: Uint8Array | null = null;

	// Serialize execution internally so concurrent requests don't race on the shared cpuSourceBuffer.
	let chain: Promise<void> = Promise.resolve();
	self.addEventListener('message', (event: MessageEvent<ColorAlphaSplitterWorkerRequest>) => {
		const { id, sourceFrame, premultiplied } = event.data;
		chain = chain.then(async () => {
			try {
				const { colorFrame, alphaFrame } = await split(sourceFrame, premultiplied);
				self.postMessage({ id, colorFrame, alphaFrame }, { transfer: [colorFrame, alphaFrame] });
			} catch (error) {
				self.postMessage({ id, error: (error as Error).message });
			} finally {
				sourceFrame.close();
			}
		});
	});

	const split = async (sourceFrame: VideoFrame, premultiplied: boolean) => {
		const format = sourceFrame.format as VideoSamplePixelFormat | null;
		if (!format) {
			throw new Error('CPU color/alpha splitting requires a known VideoFrame format.');
		}

		const sourceSize = sourceFrame.allocationSize();

		if (!cpuSourceBuffer || cpuSourceBuffer.byteLength !== sourceSize) {
			cpuSourceBuffer = new Uint8Array(sourceSize);
		}
		const layout = await sourceFrame.copyTo(cpuSourceBuffer);

		if (format === 'RGBA' || format === 'BGRA') {
			return splitInterleavedRgba(cpuSourceBuffer, format, sourceFrame, premultiplied);
		} else if (
			format === 'I420A' || format === 'I420AP10' || format === 'I420AP12'
			|| format === 'I422A' || format === 'I422AP10' || format === 'I422AP12'
			|| format === 'I444A' || format === 'I444AP10' || format === 'I444AP12'
		) {
			return splitPlanarYuvA(cpuSourceBuffer, layout, format, sourceFrame);
		}

		throw new Error(`CPU color/alpha splitting does not support format '${format}'.`);
	};

	const splitInterleavedRgba = (
		source: Uint8Array,
		format: 'RGBA' | 'BGRA',
		sourceFrame: VideoFrame,
		premultiplied: boolean,
	) => {
		const width = sourceFrame.visibleRect?.width ?? sourceFrame.codedWidth;
		const height = sourceFrame.visibleRect?.height ?? sourceFrame.codedHeight;

		// Firefox only accepts I420 frames with even coded dimensions
		// (https://bugzilla.mozilla.org/show_bug.cgi?id=1899811), so pad the alpha frame and crop it via visibleRect
		const alphaCodedWidth = width + (width % 2);
		const alphaCodedHeight = height + (height % 2);
		const lumaSize = alphaCodedWidth * alphaCodedHeight;
		const alphaSize = lumaSize + 2 * (alphaCodedWidth / 2) * (alphaCodedHeight / 2);

		// Encode alpha as I420: Y = source A bytes, UV = 128
		const alphaBuffer = new Uint8Array(alphaSize);
		for (let y = 0, j = 3; y < height; y++) {
			const rowStart = y * alphaCodedWidth;
			for (let x = 0; x < width; x++, j += 4) {
				alphaBuffer[rowStart + x] = source[j]!;
			}
			if (alphaCodedWidth > width) {
				// Repeat the edge, since some encoders scale the whole coded frame instead of cropping it
				alphaBuffer[rowStart + width] = alphaBuffer[rowStart + width - 1]!;
			}
		}
		if (alphaCodedHeight > height) {
			const lastRowStart = (height - 1) * alphaCodedWidth;
			alphaBuffer.copyWithin(height * alphaCodedWidth, lastRowStart, lastRowStart + alphaCodedWidth);
		}
		alphaBuffer.fill(128, lumaSize);

		if (premultiplied) {
			// Undo the premultiplication so that the color frame holds the straight colors
			for (let i = 0; i < width * height * 4; i += 4) {
				const alpha = source[i + 3]!;
				if (alpha !== 0 && alpha !== 255) {
					const scale = 255 / alpha;
					source[i] = Math.min(Math.round(source[i]! * scale), 255);
					source[i + 1] = Math.min(Math.round(source[i + 1]! * scale), 255);
					source[i + 2] = Math.min(Math.round(source[i + 2]! * scale), 255);
				}
			}
		}

		// Hand the source buffer straight to VideoFrame as RGBX/BGRX so the A bytes are ignored
		const colorFrame = new VideoFrame(source, {
			format: format === 'RGBA' ? 'RGBX' : 'BGRX',
			codedWidth: width,
			codedHeight: height,
			timestamp: sourceFrame.timestamp,
			duration: sourceFrame.duration ?? undefined,
			// No transfer!
		});
		const alphaInit = {
			format: 'I420' as const,
			codedWidth: alphaCodedWidth,
			codedHeight: alphaCodedHeight,
			visibleRect: { x: 0, y: 0, width, height },
			timestamp: sourceFrame.timestamp,
			duration: sourceFrame.duration ?? undefined,
			colorSpace: {
				fullRange: true,
				matrix: 'bt709',
				primaries: 'bt709',
				transfer: 'bt709',
			} as const,
			transfer: [alphaBuffer.buffer],
		};
		const alphaFrame = new VideoFrame(alphaBuffer, alphaInit);
		return { colorFrame, alphaFrame };
	};

	const splitPlanarYuvA = (
		source: Uint8Array,
		layout: PlaneLayout[],
		format:
			| 'I420A' | 'I420AP10' | 'I420AP12'
			| 'I422A' | 'I422AP10' | 'I422AP12'
			| 'I444A' | 'I444AP10' | 'I444AP12',
		sourceFrame: VideoFrame,
	) => {
		const width = sourceFrame.visibleRect?.width ?? sourceFrame.codedWidth;
		const height = sourceFrame.visibleRect?.height ?? sourceFrame.codedHeight;

		const is10 = format.includes('P10');
		const is12 = format.includes('P12');
		const bytesPerSample = (is10 || is12) ? 2 : 1;

		let chromaW: number;
		let chromaH: number;
		if (format.startsWith('I420')) {
			chromaW = Math.ceil(width / 2);
			chromaH = Math.ceil(height / 2);
		} else if (format.startsWith('I422')) {
			chromaW = Math.ceil(width / 2);
			chromaH = height;
		} else {
			chromaW = width;
			chromaH = height;
		}

		const ySamples = width * height;
		const uvSamples = chromaW * chromaH;
		const yBytes = ySamples * bytesPerSample;
		const uvBytes = uvSamples * bytesPerSample;
		const aBytes = ySamples * bytesPerSample;

		const colorBytes = yBytes + uvBytes * 2;
		const colorFormat = format.replace('A', '') as VideoPixelFormat;

		const alphaChromaW = Math.ceil(width / 2);
		const alphaChromaH = Math.ceil(height / 2);
		const alphaUvSamples = alphaChromaW * alphaChromaH;
		const alphaUvBytes = alphaUvSamples * bytesPerSample;
		const alphaSize = aBytes + 2 * alphaUvBytes;
		const alphaBuffer = new Uint8Array(alphaSize);

		const aPlaneStart = colorBytes;
		alphaBuffer.set(source.subarray(aPlaneStart, aPlaneStart + aBytes), 0);

		// Fill UV planes with the neutral chroma value
		const uvOffset = aBytes;
		const neutralChroma = is10 ? 512 : (is12 ? 2048 : 128);

		if (bytesPerSample === 1) {
			alphaBuffer.fill(neutralChroma, uvOffset);
		} else {
			const uvView = new Uint16Array(alphaBuffer.buffer, uvOffset, 2 * alphaUvSamples);
			uvView.fill(neutralChroma);
		}

		const alphaFormat = (is10 ? 'I420P10' : (is12 ? 'I420P12' : 'I420')) as VideoPixelFormat;

		if (width % 2 === 1 || height % 2 === 1) {
			return splitOddPlanarYuvA(
				source,
				layout,
				colorFormat,
				alphaFormat,
				bytesPerSample,
				neutralChroma,
				sourceFrame,
			);
		}

		// Color frame is simply a prefix of the combined bytes, so it keeps the source's color space
		const colorFrame = new VideoFrame(source.subarray(0, colorBytes), {
			format: colorFormat,
			codedWidth: width,
			codedHeight: height,
			timestamp: sourceFrame.timestamp,
			duration: sourceFrame.duration ?? undefined,
			colorSpace: sourceFrame.colorSpace.toJSON(),
		});
		const alphaInit = {
			format: alphaFormat,
			codedWidth: width,
			codedHeight: height,
			timestamp: sourceFrame.timestamp,
			duration: sourceFrame.duration ?? undefined,
			colorSpace: {
				fullRange: true,
				matrix: 'bt709',
				primaries: 'bt709',
				transfer: 'bt709',
			} as const,
			transfer: [alphaBuffer.buffer],
		};
		const alphaFrame = new VideoFrame(alphaBuffer, alphaInit);
		return { colorFrame, alphaFrame };
	};

	/**
	 * Firefox only accepts subsampled frames with even coded dimensions
	 * (https://bugzilla.mozilla.org/show_bug.cgi?id=1899811), so both frames get padded and cropped via visibleRect.
	 * Also, Firefox rounds the chroma planes of odd copies down instead of up
	 * (https://bugzilla.mozilla.org/show_bug.cgi?id=2068332), so the planes are read through the copy's layout.
	 */
	const splitOddPlanarYuvA = (
		source: Uint8Array,
		layout: PlaneLayout[],
		colorFormat: VideoPixelFormat,
		alphaFormat: VideoPixelFormat,
		bytesPerSample: number,
		neutralChroma: number,
		sourceFrame: VideoFrame,
	) => {
		const width = sourceFrame.visibleRect?.width ?? sourceFrame.codedWidth;
		const height = sourceFrame.visibleRect?.height ?? sourceFrame.codedHeight;
		const subX = colorFormat.startsWith('I444') ? 1 : 2;
		const subY = colorFormat.startsWith('I420') ? 2 : 1;

		// Copies a plane into a tightly packed target plane, repeating the edge into the padding, since some encoders
		// scale the whole coded frame instead of cropping it
		const copyPlane = (
			planeIndex: number,
			sourceWidth: number,
			sourceHeight: number,
			target: Uint8Array,
			targetOffset: number,
			targetWidth: number,
			targetHeight: number,
		) => {
			const { offset, stride } = layout[planeIndex]!;
			const nextOffset = layout[planeIndex + 1]?.offset ?? source.byteLength;
			const rowBytes = Math.min(sourceWidth * bytesPerSample, stride);
			const rows = Math.min(sourceHeight, Math.floor((nextOffset - offset) / stride));
			const targetStride = targetWidth * bytesPerSample;

			for (let y = 0; y < targetHeight; y++) {
				const sourceStart = offset + Math.min(y, rows - 1) * stride;
				const rowStart = targetOffset + y * targetStride;
				target.set(source.subarray(sourceStart, sourceStart + rowBytes), rowStart);

				for (let x = rowBytes; x < targetStride; x += bytesPerSample) {
					target.copyWithin(rowStart + x, rowStart + rowBytes - bytesPerSample, rowStart + rowBytes);
				}
			}
		};

		const colorWidth = Math.ceil(width / subX) * subX;
		const colorHeight = Math.ceil(height / subY) * subY;
		const colorLumaBytes = colorWidth * colorHeight * bytesPerSample;
		const colorChromaBytes = (colorWidth / subX) * (colorHeight / subY) * bytesPerSample;
		const colorBuffer = new Uint8Array(colorLumaBytes + 2 * colorChromaBytes);
		copyPlane(0, width, height, colorBuffer, 0, colorWidth, colorHeight);
		for (const i of [1, 2]) {
			copyPlane(
				i,
				Math.ceil(width / subX),
				Math.ceil(height / subY),
				colorBuffer,
				colorLumaBytes + (i - 1) * colorChromaBytes,
				colorWidth / subX,
				colorHeight / subY,
			);
		}

		const alphaWidth = width + (width % 2);
		const alphaHeight = height + (height % 2);
		const alphaLumaBytes = alphaWidth * alphaHeight * bytesPerSample;
		const alphaBuffer = new Uint8Array(alphaLumaBytes + (alphaWidth / 2) * (alphaHeight / 2) * 2 * bytesPerSample);
		copyPlane(3, width, height, alphaBuffer, 0, alphaWidth, alphaHeight);
		if (bytesPerSample === 1) {
			alphaBuffer.fill(neutralChroma, alphaLumaBytes);
		} else {
			new Uint16Array(alphaBuffer.buffer, alphaLumaBytes).fill(neutralChroma);
		}

		const visibleRect = { x: 0, y: 0, width, height };
		const colorInit = {
			format: colorFormat,
			codedWidth: colorWidth,
			codedHeight: colorHeight,
			visibleRect,
			timestamp: sourceFrame.timestamp,
			duration: sourceFrame.duration ?? undefined,
			colorSpace: sourceFrame.colorSpace.toJSON(),
			transfer: [colorBuffer.buffer],
		};
		const alphaInit = {
			format: alphaFormat,
			codedWidth: alphaWidth,
			codedHeight: alphaHeight,
			visibleRect,
			timestamp: sourceFrame.timestamp,
			duration: sourceFrame.duration ?? undefined,
			colorSpace: {
				fullRange: true,
				matrix: 'bt709',
				primaries: 'bt709',
				transfer: 'bt709',
			} as const,
			transfer: [alphaBuffer.buffer],
		};
		const colorFrame = new VideoFrame(colorBuffer, colorInit);
		const alphaFrame = new VideoFrame(alphaBuffer, alphaInit);
		return { colorFrame, alphaFrame };
	};
};

/**
 * This source can be used to add raw, unencoded video samples (frames) to an output video track. These frames will
 * automatically be encoded and then piped into the output.
 * @group Media sources
 * @public
 */
export class VideoSampleSource extends VideoSource {
	/** @internal */
	private _encoder: VideoEncoderWrapper;

	/**
	 * Creates a new {@link VideoSampleSource} whose samples are encoded according to the specified
	 * {@link VideoEncodingConfig}.
	 */
	constructor(encodingConfig: VideoEncodingConfig) {
		validateVideoEncodingConfig(encodingConfig);

		super(encodingConfig.codec);
		this._encoder = new VideoEncoderWrapper(this, encodingConfig);
	}

	/**
	 * Encodes a video sample (frame) and then adds it to the output.
	 *
	 * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
	 * to respect writer and encoder backpressure.
	 */
	add(videoSample: VideoSample, encodeOptions?: VideoEncoderEncodeOptions) {
		if (!(videoSample instanceof VideoSample)) {
			throw new TypeError('videoSample must be a VideoSample.');
		}

		return this._encoder.add(videoSample, false, encodeOptions);
	}

	/** @internal */
	override _flushAndClose(forceClose: boolean) {
		return this._encoder.flushAndClose(forceClose);
	}
}

/**
 * This source can be used to add video frames to the output track from a fixed canvas element. Since canvases are often
 * used for rendering, this source provides a convenient wrapper around {@link VideoSampleSource}.
 * @group Media sources
 * @public
 */
export class CanvasSource extends VideoSource {
	/** @internal */
	private _encoder: VideoEncoderWrapper;
	/** @internal */
	private _canvas: HTMLCanvasElement | OffscreenCanvas;

	/**
	 * Creates a new {@link CanvasSource} from a canvas element or `OffscreenCanvas` whose samples are encoded
	 * according to the specified {@link VideoEncodingConfig}.
	 */
	constructor(canvas: HTMLCanvasElement | OffscreenCanvas, encodingConfig: VideoEncodingConfig) {
		if (
			!(typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement)
			&& !(typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas)
		) {
			throw new TypeError('canvas must be an HTMLCanvasElement or OffscreenCanvas.');
		}
		validateVideoEncodingConfig(encodingConfig);

		super(encodingConfig.codec);
		this._encoder = new VideoEncoderWrapper(this, encodingConfig);
		this._canvas = canvas;
	}

	/**
	 * Captures the current canvas state as a video sample (frame), encodes it and adds it to the output.
	 *
	 * @param timestamp - The timestamp of the sample, in seconds.
	 * @param duration - The duration of the sample, in seconds.
	 *
	 * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
	 * to respect writer and encoder backpressure.
	 */
	add(timestamp: number, duration = 0, encodeOptions?: VideoEncoderEncodeOptions) {
		if (!Number.isFinite(timestamp)) {
			throw new TypeError('timestamp must be a finite number.');
		}
		if (!Number.isFinite(duration) || duration < 0) {
			throw new TypeError('duration must be a non-negative number.');
		}

		const sample = new VideoSample(this._canvas, { timestamp, duration });
		return this._encoder.add(sample, true, encodeOptions);
	}

	/** @internal */
	override _flushAndClose(forceClose: boolean) {
		return this._encoder.flushAndClose(forceClose);
	}
}

/**
 * Returns how much of a pause that started at `pauseStartTime` and ends now lies after `timelineStartTime`, the
 * moment that maps to timestamp 0 (both in seconds, in the `performance.now()` time base). Only that part has to be
 * removed from the timestamps of the media captured after the pause.
 */
const getPauseDurationOnTimeline = (pauseStartTime: number, timelineStartTime: number | null) => {
	if (timelineStartTime === null) {
		return 0; // The timeline hasn't started yet, so the entire pause precedes it
	}

	return Math.max(performance.now() / 1000 - Math.max(pauseStartTime, timelineStartTime), 0);
};

/**
 * Options for {@link MediaStreamVideoTrackSource}.
 * @group Media sources
 * @public
 */
export type MediaStreamVideoTrackSourceOptions = {
	/**
	 * The frame rate at which the underlying video track is sampled. Defaults to the frame rate specified in the
	 * track's [`MediaTrackSettings`](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings), or to
	 * `null` if the track reports none or a frame rate of 0 (like `captureStream(0)` canvas tracks). Set to
	 * `null` to only add a frame whenever the underlying track pushes one - this minimizes frame count but can
	 * lead to wildly irregular FPS.
	 */
	frameRate?: number | null;
	/**
	 * Controls the basis (zero point) for video frame timestamps.
	 *
	 * When set to `'synced-zero'`, timestamps will be relative to the first chunk of media from a `MediaStreamTrack`
	 * added to the {@link Output}.
	 *
	 * When set to `'zero'`, timestamps will be relative to the first video frame emitted by this source.
	 *
	 * When set to `'unix'`, timestamps will be relative to the Unix epoch, so clearly associated with a distinct point
	 * in time. Here, pausing via {@link MediaStreamVideoTrackSource.pause} will also create gaps in timestamps. Be sure
	 * to pair this mode with {@link BaseTrackMetadata.isRelativeToUnixEpoch}.
	 *
	 * Defaults to `'synced-zero'`.
	 */
	timestampBase?: 'synced-zero' | 'zero' | 'unix';
};

/**
 * Video source that encodes the frames of a
 * [`MediaStreamVideoTrack`](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack) and pipes them into the
 * output. This is useful for capturing live or real-time data such as webcams or screen captures. Frames will
 * automatically start being captured once the connected {@link Output} is started, and will keep being captured until
 * the {@link Output} is finalized or this source is closed. The source closes itself once the track has ended.
 * @group Media sources
 * @public
 */
export class MediaStreamVideoTrackSource extends VideoSource {
	/** @internal */
	private _options: MediaStreamVideoTrackSourceOptions;
	/** @internal */
	private _encoder: VideoEncoderWrapper;
	/** @internal */
	private _abortController: AbortController | null = null;
	/** @internal */
	private _track: MediaStreamVideoTrack;
	/** @internal */
	private _workerTrackId: number | null = null;
	/** @internal */
	private _workerListener: ((event: MessageEvent) => void) | null = null;
	/** @internal */
	private _promiseWithResolvers = promiseWithResolvers();
	/** @internal */
	private _errorPromiseAccessed = false;
	/** @internal */
	private _paused = false;
	/** @internal */
	private _pauseStartTime = 0;
	/**
	 * The paused time, in seconds, removed from the timestamps of frames captured from now on. It's measured in wall
	 * clock time rather than in dropped frames, so that sources paused and resumed together stay in sync.
	 * @internal
	 */
	private _pausedTime = 0;
	/** @internal */
	private _firstFrameTime: number | null = null;
	/** @internal */
	private _lastVideoFrame: VideoFrame | null = null;
	/** @internal */
	private _timerHandle: UnthrottledTimerHandle | null = null;
	/** @internal */
	private _videoElement: HTMLVideoElement | null = null;
	/** @internal */
	private _trackEndedListener: (() => void) | null = null;
	/** @internal */
	private _pendingAdds = new Set<Promise<void>>();

	/** A promise that rejects upon any error within this source. This promise never resolves. */
	get errorPromise() {
		this._errorPromiseAccessed = true;
		return this._promiseWithResolvers.promise;
	}

	/** Whether this source is currently paused as a result of calling `.pause()`. */
	get paused() {
		return this._paused;
	}

	/**
	 * Creates a new {@link MediaStreamVideoTrackSource} from a
	 * [`MediaStreamVideoTrack`](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack), which will pull
	 * video samples from the stream in real time and encode them according to {@link VideoEncodingConfig}.
	 */
	constructor(
		track: MediaStreamVideoTrack,
		encodingConfig: VideoEncodingConfig,
		options: MediaStreamVideoTrackSourceOptions = {},
	) {
		if (typeof MediaStreamTrack === 'undefined' || !(track instanceof MediaStreamTrack) || track.kind !== 'video') {
			throw new TypeError('track must be a video MediaStreamTrack.');
		}
		validateVideoEncodingConfig(encodingConfig);
		if (typeof options !== 'object' || !options) {
			throw new TypeError('options must be an object.');
		}
		if (options.frameRate != null && (typeof options.frameRate !== 'number' || options.frameRate <= 0)) {
			throw new TypeError('options.frameRate, when provided, must be either a positive number or null.');
		}
		if (
			options.timestampBase !== undefined
			&& options.timestampBase !== 'synced-zero'
			&& options.timestampBase !== 'zero'
			&& options.timestampBase !== 'unix'
		) {
			throw new TypeError(
				'options.timestampBase, when provided, must be one of \'synced-zero\', \'zero\', or \'unix\'.',
			);
		}

		encodingConfig = {
			...encodingConfig,
			latencyMode: 'realtime',
		};

		super(encodingConfig.codec);

		this._options = options;
		this._encoder = new VideoEncoderWrapper(this, encodingConfig);
		this._track = track;
	}

	/** @internal */
	override async _start() {
		if (!this._errorPromiseAccessed) {
			Logging._warn(
				'Make sure not to ignore the `errorPromise` field on MediaStreamVideoTrackSource, so that any internal'
				+ ' errors get bubbled up properly.',
			);
		}

		let frameRate: number | null;
		if (this._options.frameRate !== undefined) {
			frameRate = this._options.frameRate;
		} else {
			// Tracks can report a frame rate of 0, like canvas capture tracks created with captureStream(0), which only
			// emit frames when requestFrame() is called. There's no rate to sample at, so take the frames as they come.
			const settingsFrameRate = this._track.getSettings().frameRate;
			frameRate = settingsFrameRate !== undefined && Number.isFinite(settingsFrameRate) && settingsFrameRate > 0
				? settingsFrameRate
				: null;
		}
		this._frameRateHint = frameRate !== null && Number.isFinite(frameRate) && frameRate > 0 ? frameRate : null;

		this._abortController = new AbortController();

		let firstVideoFrameTimestamp: number | null = null;
		let lastFrameTime: number | null = null;
		let frameCount = 0;
		let errored = false;
		let timestampOffset = 0;
		let lastAddedTimestamp: number | null = null; // Capture timestamp of the last frame handed to the encoder

		// An ended track can't produce any more frames, so we close this source. Otherwise, the output would keep
		// waiting for frames from this track, holding back the media of all other tracks until finalization.
		const onTrackEnded = () => {
			if (errored || this._closingPromise || this._connectedTrack!.output.state !== 'started') {
				return;
			}

			this.close();
			this._closingPromise!.catch((error) => {
				this._promiseWithResolvers.reject(error);
			});
		};

		const tick = () => {
			assert(frameRate !== null);

			// A track stopped with track.stop() fires no 'ended' event, and sampling from a <video> element has no
			// stream that could end, so check here. Otherwise, the last frame would be repeated until finalization.
			if (this._track.readyState === 'ended') {
				onTrackEnded();
				return;
			}

			if (!this._lastVideoFrame) {
				return;
			}

			assert(lastFrameTime !== null);
			assert(firstVideoFrameTimestamp !== null);

			const now = performance.now();

			// Add as many frames as warranted by the elapsed time.
			// > instead of >= intentionally because tick() is called before the _lastVideoFrame is changed
			while (now - lastFrameTime > 1000 / frameRate) {
				lastFrameTime += 1000 / frameRate;
				const timestamp = firstVideoFrameTimestamp + frameCount / frameRate;

				const frame = new VideoFrame(this._videoElement ?? this._lastVideoFrame, {
					timestamp: 1e6 * timestamp,
					duration: 1e6 / frameRate,
				});

				addVideoFrame(frame, now);
			}
		};

		if (frameRate !== null) {
			this._timerHandle = setIntervalUnthrottled(tick, 4); // Run it at 250 Hz
		}

		const onVideoFrame = (videoFrame: VideoFrame) => {
			if (frameRate === null) {
				addVideoFrame(videoFrame);
			} else {
				const now = performance.now();

				if (!this._lastVideoFrame) {
					addVideoFrame(videoFrame.clone(), now);
					lastFrameTime = now;
					this._lastVideoFrame = videoFrame;
				} else {
					tick();
					this._lastVideoFrame?.close();
					this._lastVideoFrame = videoFrame;
				}
			}
		};

		const addVideoFrame = (videoFrame: VideoFrame, now = performance.now()) => {
			if (errored) {
				videoFrame.close();
				return;
			}

			frameCount++;
			const currentTimestamp = videoFrame.timestamp / 1e6;

			if (this._paused) {
				videoFrame.close();
				return;
			}

			if (firstVideoFrameTimestamp === null) {
				firstVideoFrameTimestamp = currentTimestamp;
				this._firstFrameTime = now / 1000;

				let target: number;
				const timestampBase = this._options.timestampBase ?? 'synced-zero';
				if (timestampBase === 'unix') {
					target = Date.now() / 1000;
				} else if (timestampBase === 'zero') {
					target = 0;
				} else {
					const output = this._connectedTrack!.output;
					if (output._firstMediaStreamTimestamp === null) {
						output._firstMediaStreamTimestamp = now / 1000;
						target = 0;
					} else {
						target = now / 1000 - output._firstMediaStreamTimestamp;
					}
				}

				timestampOffset = target - firstVideoFrameTimestamp;
			}

			if (lastAddedTimestamp !== null && currentTimestamp <= lastAddedTimestamp) {
				// Capture timestamps don't always increase (see https://crbug.com/618407). A frame stamped no later
				// than the one before it would break the order of the packets: a key frame from before the previous
				// GOP is rejected by the muxer, which fails the whole recording. So drop it.
				videoFrame.close();
				return;
			}

			if (this._encoder.getQueueSize() >= 8) {
				// Drop frames if the encoder is overloaded or the output can't take its data fast enough, rather than
				// holding on to them (frames may come from a small pool, like a camera's)
				videoFrame.close();
				return;
			}

			lastAddedTimestamp = currentTimestamp;
			const pausedTime = this._options.timestampBase === 'unix' ? 0 : this._pausedTime;
			const sample = new VideoSample(videoFrame, {
				timestamp: currentTimestamp + timestampOffset - pausedTime,
			});

			const addPromise: Promise<void> = this._encoder.add(sample, true)
				.catch((error) => {
					errored = true;

					this._abortController?.abort();
					this._promiseWithResolvers.reject(error);

					if (this._workerTrackId !== null) {
						// Tell the worker to stop the track
						sendMessageToMediaStreamTrackProcessorWorker({
							type: 'stopTrack',
							trackId: this._workerTrackId,
						});
					}
				})
				.finally(() => {
					this._pendingAdds.delete(addPromise);
				});
			this._pendingAdds.add(addPromise);
		};

		this._trackEndedListener = onTrackEnded;
		this._track.addEventListener('ended', onTrackEnded);

		if (this._track.readyState === 'ended') {
			// The track ended before the recording started (a screen share stopped right away, for example). There's
			// nothing to capture from it, and MediaStreamTrackProcessor can't even be created for an ended track.
			onTrackEnded();
			return;
		}

		if (typeof MediaStreamTrackProcessor !== 'undefined') {
			// We can do it here directly, perfect
			const processor = new MediaStreamTrackProcessor({ track: this._track });
			const consumer = new WritableStream<VideoFrame>({ write: onVideoFrame });

			processor.readable.pipeTo(consumer, {
				signal: this._abortController.signal,
			}).then(onTrackEnded, (error) => { // The stream ends once the track has ended
				// Handle AbortError silently
				if (error instanceof DOMException && error.name === 'AbortError') return;

				this._promiseWithResolvers.reject(error);
			});
		} else {
			// It might still be supported in a worker, so let's check that
			const supportedInWorker = await mediaStreamTrackProcessorIsSupportedInWorker();

			if (supportedInWorker) {
				this._workerTrackId = nextMediaStreamTrackProcessorWorkerId++;

				// MediaStreamTracks can only be transferred, not cloned via postMessage (WebKit throws a DataCloneError
				// otherwise). Transfer a clone so that the caller's own track stays live; the worker stops the clone.
				const workerTrack = this._track.clone();
				sendMessageToMediaStreamTrackProcessorWorker({
					type: 'videoTrack',
					trackId: this._workerTrackId,
					track: workerTrack,
				}, [workerTrack as unknown as Transferable]);

				this._workerListener = (event: MessageEvent) => {
					const message = event.data as MediaStreamTrackProcessorWorkerMessage;

					if (message.type === 'videoFrame' && message.trackId === this._workerTrackId) {
						if (this._track.readyState === 'ended') {
							// The worker's copy of the track keeps running after track.stop(), which fires no 'ended'
							// event
							message.videoFrame.close();
							onTrackEnded();
							return;
						}

						onVideoFrame(message.videoFrame);
					} else if (message.type === 'error' && message.trackId === this._workerTrackId) {
						this._promiseWithResolvers.reject(message.error);
					}
				};

				mediaStreamTrackProcessorWorker!.addEventListener('message', this._workerListener);
			} else if (frameRate !== null) {
				// No MediaStreamTrackProcessor support at all (e.g. Firefox), but we have a frame rate, so we can
				// manually sample from a hidden <video> element instead.
				const video = document.createElement('video');
				video.style.position = 'fixed';
				video.style.left = '-10000px';
				video.style.top = '-10000px';
				video.style.width = '1px';
				video.style.height = '1px';
				video.style.opacity = '0';
				video.style.pointerEvents = 'none';
				video.muted = true;
				video.srcObject = new MediaStream([this._track]);
				document.body.appendChild(video);
				this._videoElement = video;

				video.addEventListener('loadeddata', () => {
					if (errored || !this._videoElement) {
						return;
					}

					// This will be the first frame
					const frame = new VideoFrame(video, {
						timestamp: 1000 * performance.now(),
					});
					onVideoFrame(frame);
					frame.close();
				}, { once: true });

				void video.play().catch((error) => {
					errored = true;
					this._promiseWithResolvers.reject(error);
				});
			} else {
				throw new Error(
					'When no explicit frame rate is set, MediaStreamTrackProcessor is required; but it\'s not available'
					+ ' in this environment.',
				);
			}
		}
	}

	/**
	 * Pauses the capture of video frames - any video frames emitted by the underlying media stream will be ignored
	 * while paused. This does *not* close the underlying `MediaStreamVideoTrack`, it just ignores its output.
	 */
	pause() {
		if (this._paused) {
			return;
		}

		this._paused = true;
		this._pauseStartTime = performance.now() / 1000;
	}

	/** Resumes the capture of video frames after being paused. */
	resume() {
		if (!this._paused) {
			return;
		}

		this._paused = false;

		const timelineStartTime = this._options.timestampBase === 'zero'
			? this._firstFrameTime
			: (this._connectedTrack?.output._firstMediaStreamTimestamp ?? null);
		this._pausedTime += getPauseDurationOnTimeline(this._pauseStartTime, timelineStartTime);
	}

	/** @internal */
	override async _flushAndClose(forceClose: boolean) {
		try {
			if (this._abortController) {
				this._abortController.abort();
				this._abortController = null;
			}

			if (this._trackEndedListener) {
				this._track.removeEventListener('ended', this._trackEndedListener);
				this._trackEndedListener = null;
			}

			if (this._timerHandle) {
				clearIntervalUnthrottled(this._timerHandle);
			}
			this._lastVideoFrame?.close();

			if (this._videoElement) {
				this._videoElement.srcObject = null;
				this._videoElement.remove();
				this._videoElement = null;
			}

			if (this._workerTrackId !== null) {
				assert(this._workerListener);

				sendMessageToMediaStreamTrackProcessorWorker({
					type: 'stopTrack',
					trackId: this._workerTrackId,
				});

				// Wait for the worker to stop the track
				await new Promise<void>((resolve) => {
					const listener = (event: MessageEvent) => {
						const message = event.data as MediaStreamTrackProcessorWorkerMessage;

						if (message.type === 'trackStopped' && message.trackId === this._workerTrackId) {
							assert(this._workerListener);
							mediaStreamTrackProcessorWorker!.removeEventListener('message', this._workerListener);
							mediaStreamTrackProcessorWorker!.removeEventListener('message', listener);

							resolve();
						}
					};

					mediaStreamTrackProcessorWorker!.addEventListener('message', listener);
				});
			}
		} finally {
			if (!forceClose) {
				// Frames are handed to the encoder without waiting for it, and the first ones wait for its
				// (asynchronous) setup. Closing it before they got to it would discard them.
				await Promise.all(this._pendingAdds);
			}

			// The encoder must be closed even if the track teardown above threw
			await this._encoder.flushAndClose(forceClose);
		}
	}
}

/**
 * Base class for audio sources - sources for audio tracks.
 * @group Media sources
 * @public
 */
export abstract class AudioSource extends MediaSource {
	/** @internal */
	declare _connectedTrack: OutputAudioTrack | null;
	/** @internal */
	override readonly _codec: AudioCodec;

	/** Internal constructor. */
	constructor(codec: AudioCodec) {
		super();

		if (!AUDIO_CODECS.includes(codec)) {
			throw new TypeError(`Invalid audio codec '${codec}'. Must be one of: ${AUDIO_CODECS.join(', ')}.`);
		}

		this._codec = codec;
	}
}

/**
 * The most basic audio source; can be used to directly pipe encoded packets into the output file.
 * @group Media sources
 * @public
 */
export class EncodedAudioPacketSource extends AudioSource {
	/** Creates a new {@link EncodedAudioPacketSource} whose packets are encoded using `codec`. */
	constructor(codec: AudioCodec) {
		super(codec);
	}

	/**
	 * Adds an encoded packet to the output audio track. Packets must be added in *decode order*.
	 *
	 * @param meta - Additional metadata from the encoder. You should pass this for the first call, including a valid
	 * decoder config.
	 *
	 * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
	 * to respect writer and encoder backpressure.
	 */
	add(packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) {
		if (!(packet instanceof EncodedPacket)) {
			throw new TypeError('packet must be an EncodedPacket.');
		}
		if (packet.isMetadataOnly) {
			throw new TypeError('Metadata-only packets cannot be added.');
		}
		if (meta !== undefined && (!meta || typeof meta !== 'object')) {
			throw new TypeError('meta, when provided, must be an object.');
		}

		this._ensureValidAdd();
		return this._connectedTrack!.output._muxer.addEncodedAudioPacket(this._connectedTrack!, packet, meta);
	}
}

export const PCM_ENCODER_PACKET_SIZE = 2048; // In frames
const MAX_GAP_FILL_SAMPLE_SIZE = 2 ** 24; // In bytes

// Silence fed to Opus encoders with non-48 kHz input before flushing them, and how far past the input's end a packet
// may start and still be kept (to allow for the uncompensated delay of the encoder's resampler)
const END_PADDING_DURATION = 0.05;
const END_PADDING_SLACK = 0.01;

class AudioEncoderWrapper {
	private ensureEncoderPromise: Promise<void> | null = null;
	/** Resolved once the wrapper is closed, so that nothing keeps waiting for an encoder that may never come. */
	private closedSignal = promiseWithResolvers();
	private encoderInitialized = false;
	private encoder: AudioEncoder | null = null;
	private muxer: Muxer | null = null;
	private lastNumberOfChannels: number | null = null;
	private lastSampleRate: number | null = null;

	private isPcmEncoder = false;
	private outputSampleSize: number | null = null;
	private writeOutputValue: ((view: DataView, byteOffset: number, value: number) => void) | null = null;
	private pcmMeta: EncodedAudioChunkMetadata | null = null;
	private pcmStartTimestamp = 0;
	private pcmEmittedFrames = 0;
	private pcmReadBuffer = new ArrayBuffer(0);
	private pcmScratchView: DataView | null = null;
	private pcmScratchFrames = 0;

	private customEncoder: CustomAudioEncoder | null = null;
	private customEncoderCallSerializer = new CallSerializer();
	private customEncoderQueueSize = 0;

	private lastEndSampleIndex: number | null = null;

	// Tracks the audio passed to the WebCodecs encoder, needed for the padding at the end (see flushAndClose)
	private lastAudioDataParams: {
		format: AudioSampleFormat;
		numberOfChannels: number;
		sampleRate: number;
	} | null = null;

	private inputEndTimestamp = -Infinity;
	private endPaddingAdded = false;

	private resampler: AudioResampler | null = null;

	/**
	 * Encoders typically throw their errors "out of band", meaning asynchronously in some other execution context.
	 * However, we want to surface these errors to the user within the normal control flow, so they don't go uncaught.
	 * So, we keep track of the encoder error and throw it as soon as we get the chance.
	 */
	private error: unknown = null;
	private errorSet = false;

	private setError(error: unknown) {
		if (!this.errorSet) {
			this.error = error;
			this.errorSet = true;
		}
	}

	private lastMuxerPromise: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(private source: AudioSource, private encodingConfig: AudioEncodingConfig) {}

	async add(audioSample: AudioSample, shouldClose: boolean) {
		try {
			this.checkForEncoderError();
			this.source._ensureValidAdd();

			// Ensure audio parameters remain constant
			if (this.lastNumberOfChannels !== null && this.lastSampleRate !== null) {
				if (
					audioSample.numberOfChannels !== this.lastNumberOfChannels
					|| audioSample.sampleRate !== this.lastSampleRate
				) {
					throw new Error(
						`Audio parameters must remain constant. Expected ${this.lastNumberOfChannels} channels at`
						+ ` ${this.lastSampleRate} Hz, got ${audioSample.numberOfChannels} channels at`
						+ ` ${audioSample.sampleRate} Hz.`,
					);
				}
			} else {
				this.lastNumberOfChannels = audioSample.numberOfChannels;
				this.lastSampleRate = audioSample.sampleRate;
			}

			const config = this.encodingConfig;
			const needsResample = (
				config.transform?.numberOfChannels !== undefined
				&& config.transform.numberOfChannels !== audioSample.numberOfChannels
			) || (
				config.transform?.sampleRate !== undefined
				&& config.transform.sampleRate !== audioSample.sampleRate
			);

			if (needsResample) {
				if (!this.resampler) {
					// Initialize the resampler on first sample
					this.resampler = new AudioResampler({
						targetNumberOfChannels: config.transform!.numberOfChannels
							?? audioSample.numberOfChannels,
						targetSampleRate: config.transform!.sampleRate
							?? audioSample.sampleRate,
						onSample: async (sample) => {
							await this.processAndEncode(sample, true);
						},
					});
				}

				await this.resampler.add(audioSample);
			} else {
				await this.processAndEncode(audioSample, shouldClose);
			}
		} finally {
			if (shouldClose) {
				audioSample.close();
			}
		}
	}

	/**
	 * Runs the process function (if any) and encodes the resulting samples.
	 */
	private async processAndEncode(audioSample: AudioSample, shouldClose: boolean) {
		const config = this.encodingConfig;

		if (config.transform?.process) {
			try {
				let processed = config.transform.process(audioSample);
				if (isThenable(processed)) {
					processed = await processed;
				}

				if (processed === null) {
					return;
				}

				if (!Array.isArray(processed)) {
					processed = [processed];
				}

				try {
					for (const sample of processed) {
						if (!(sample instanceof AudioSample)) {
							throw new TypeError(
								'The audio process function must return an AudioSample, null, or an array of'
								+ ' AudioSamples.',
							);
						}
					}

					for (const sample of processed) {
						await this.encodeSample(sample, true);
					}
				} finally {
					// encodeSample closes the samples it was passed; this additionally covers the samples never
					// reached because an earlier one threw (closing is idempotent)
					for (const sample of processed) {
						if (sample instanceof AudioSample) {
							sample.close();
						}
					}
				}
			} finally {
				if (shouldClose) {
					audioSample.close();
				}
			}
		} else {
			await this.encodeSample(audioSample, shouldClose);
		}
	}

	/**
	 * Encodes a single audio sample, handling encoder init, gap padding, and backpressure.
	 */
	private async encodeSample(audioSample: AudioSample, shouldClose: boolean) {
		try {
			const sampleFormat = this.encodingConfig.transform?.sampleFormat;
			if (sampleFormat !== undefined && toInterleavedAudioFormat(audioSample.format) !== sampleFormat) {
				// Converted right before encoding, so that it also applies to the samples returned by process
				const newSample = audioSampleToInterleavedFormat(audioSample, sampleFormat);

				if (shouldClose) {
					audioSample.close();
				}

				audioSample = newSample;
				shouldClose = true;
			}

			if (!this.encoderInitialized) {
				if (this.closed) {
					// The source got closed (or the output canceled) while we were awaiting, e.g. the process
					// function, so don't create an encoder nothing would close anymore
					return;
				}

				if (!this.ensureEncoderPromise) {
					this.ensureEncoder(audioSample);
				}

				// No, this "if" statement is not useless. Sometimes, the above call to `ensureEncoder` might have
				// synchronously completed and the encoder is already initialized. In this case, we don't need to await
				// the promise anymore. This also fixes nasty async race condition bugs when multiple code paths are
				// calling this method: It's important that the call that initialized the encoder go through this
				// code first.
				if (!this.encoderInitialized) {
					// Racing the close: an initialization may never finish (one hanging in a platform codec, say)
					await Promise.race([this.ensureEncoderPromise, this.closedSignal.promise]);
					if (this.closed) {
						return;
					}
				}
			}
			assert(this.encoderInitialized);

			if (this.closed) {
				return;
			}

			// Handle padding of gaps with silence to avoid audio drift over time, like in
			// https://github.com/Vanilagy/mediabunny/issues/176
			// TODO An open question is how encoders deal with the first AudioData having a non-zero timestamp, and with
			// AudioDatas that have an overlapping timestamp range.
			{
				const startSampleIndex = Math.round(
					audioSample.timestamp * audioSample.sampleRate,
				);
				const endSampleIndex = Math.round(
					(audioSample.timestamp + audioSample.duration) * audioSample.sampleRate,
				);

				if (this.lastEndSampleIndex === null) {
					this.lastEndSampleIndex = endSampleIndex;
				} else {
					const sampleDiff = startSampleIndex - this.lastEndSampleIndex;

					if (sampleDiff >= 64) {
						// The gap is big enough, let's add correction samples. They're at most 16 MiB each, since long
						// gaps would otherwise allocate all their silence at once (over 2 GB for 90 minutes of 48 kHz
						// stereo f32, more than an AudioData can hold).
						const bytesPerFrame = getBytesPerSample(audioSample.format) * audioSample.numberOfChannels;
						const maxFramesPerSample = Math.max(1, Math.floor(MAX_GAP_FILL_SAMPLE_SIZE / bytesPerFrame));
						let remainingFrames = sampleDiff;

						while (remainingFrames > 0 && !this.closed) {
							const numberOfFrames = Math.min(remainingFrames, maxFramesPerSample);
							const data = new Uint8Array(bytesPerFrame * numberOfFrames);
							if (audioSample.format === 'u8' || audioSample.format === 'u8-planar') {
								data.fill(2 ** 7); // Fill it with the silent value
							}

							const fillSample = new AudioSample({
								data,
								format: audioSample.format,
								sampleRate: audioSample.sampleRate,
								numberOfChannels: audioSample.numberOfChannels,
								numberOfFrames,
								timestamp: this.lastEndSampleIndex / audioSample.sampleRate,
							});

							await this.encodeSample(fillSample, true); // Recursive call, advances lastEndSampleIndex
							remainingFrames -= numberOfFrames;
						}

						if (this.closed) {
							// The source got closed (or the output canceled) while the gap was being filled
							return;
						}
					}

					this.lastEndSampleIndex += audioSample.numberOfFrames;
				}
			}

			this.encodingConfig.onEncodedSample?.(audioSample);

			if (this.customEncoder) {
				this.customEncoderQueueSize++;

				// We clone the sample so it cannot be closed on us from the outside before it reaches the encoder
				const clonedSample = audioSample.clone();

				const promise = this.customEncoderCallSerializer
					.call(() => this.customEncoder!.encode(clonedSample))
					.catch((error: unknown) => this.setError(error))
					.finally(() => {
						this.customEncoderQueueSize--;
						clonedSample.close();
					});

				if (this.customEncoderQueueSize >= 4) {
					await promise;
				}

				await this.lastMuxerPromise; // Allow the writer to apply backpressure
			} else if (this.isPcmEncoder) {
				await this.doPcmEncoding(audioSample, shouldClose);
			} else {
				assert(this.encoder);
				const audioData = audioSample.toAudioData();
				this.encoder.encode(audioData);
				audioData.close();

				this.lastAudioDataParams = {
					format: audioSample.format,
					numberOfChannels: audioSample.numberOfChannels,
					sampleRate: audioSample.sampleRate,
				};
				this.inputEndTimestamp = Math.max(this.inputEndTimestamp, audioSample.timestamp + audioSample.duration);

				if (shouldClose) {
					audioSample.close();
				}

				if (this.encoder.encodeQueueSize >= 4) {
					await new Promise(resolve => this.encoder!.addEventListener('dequeue', resolve, { once: true }));
				}

				await this.lastMuxerPromise; // Allow the writer to apply backpressure
			}
		} finally {
			if (shouldClose) {
				audioSample.close();
			}
		}
	}

	private async doPcmEncoding(audioSample: AudioSample, shouldClose: boolean) {
		assert(this.outputSampleSize);
		assert(this.writeOutputValue);

		// Need to extract data from the audio data before we close it
		const { numberOfChannels, numberOfFrames, sampleRate, timestamp } = audioSample;

		if (!this.pcmMeta) {
			this.pcmMeta = {
				decoderConfig: {
					codec: this.encodingConfig.codec,
					numberOfChannels,
					sampleRate,
				},
			};
			// Gaps get padded with silence before reaching us, so it's one contiguous run from here on
			this.pcmStartTimestamp = timestamp;
		}

		// Read the whole sample interleaved into our reusable read buffer, growing it if needed. It's read in its own
		// sample type and converted here: converting AudioData-backed samples is up to the browser otherwise, and
		// Chrome scales positive values by 1/32767 (s16) and 1/127 (u8), which made copies off by one
		const readFormat = toInterleavedAudioFormat(audioSample.format);

		const allocationSize = audioSample.allocationSize({ planeIndex: 0, format: readFormat });
		if (this.pcmReadBuffer.byteLength < allocationSize) {
			this.pcmReadBuffer = new ArrayBuffer(allocationSize);
		}

		let values: Uint8Array | Int16Array | Int32Array | Float32Array;
		let bias = 0;
		let scale = 1;
		if (readFormat === 'u8') {
			values = new Uint8Array(this.pcmReadBuffer, 0, allocationSize);
			bias = -128;
			scale = 1 / 128;
		} else if (readFormat === 's16') {
			values = new Int16Array(this.pcmReadBuffer, 0, allocationSize / 2);
			scale = 1 / 32768;
		} else if (readFormat === 's32') {
			values = new Int32Array(this.pcmReadBuffer, 0, allocationSize / 4);
			scale = 1 / 2147483648;
		} else {
			values = new Float32Array(this.pcmReadBuffer, 0, allocationSize / 4);
		}
		audioSample.copyTo(values, { planeIndex: 0, format: readFormat });

		if (shouldClose) {
			audioSample.close();
		}

		// Fill up the scratch buffer, emitting it as a packet each time it's full
		let frame = 0;
		while (frame < numberOfFrames) {
			this.pcmScratchView ??= new DataView(
				new ArrayBuffer(PCM_ENCODER_PACKET_SIZE * numberOfChannels * this.outputSampleSize),
			);

			const frameCount = Math.min(PCM_ENCODER_PACKET_SIZE - this.pcmScratchFrames, numberOfFrames - frame);
			const valueOffset = this.pcmScratchFrames * numberOfChannels;
			const readOffset = frame * numberOfChannels;

			for (let i = 0; i < frameCount * numberOfChannels; i++) {
				this.writeOutputValue(
					this.pcmScratchView,
					(valueOffset + i) * this.outputSampleSize,
					(values[readOffset + i]! + bias) * scale,
				);
			}

			this.pcmScratchFrames += frameCount;
			frame += frameCount;

			if (this.pcmScratchFrames === PCM_ENCODER_PACKET_SIZE) {
				await this.emitPcmScratchPacket();
			}
		}
	}

	private async emitPcmScratchPacket() {
		assert(this.outputSampleSize);
		assert(this.pcmScratchView);
		assert(this.pcmMeta?.decoderConfig);

		const { numberOfChannels, sampleRate } = this.pcmMeta.decoderConfig;
		const byteLength = this.pcmScratchFrames * numberOfChannels * this.outputSampleSize;

		const packet = new EncodedPacket(
			new Uint8Array(this.pcmScratchView.buffer, 0, byteLength),
			'key',
			this.pcmStartTimestamp + this.pcmEmittedFrames / sampleRate,
			this.pcmScratchFrames / sampleRate,
		);
		this.pcmEmittedFrames += this.pcmScratchFrames;

		// The packet now owns the buffer
		this.pcmScratchView = null;
		this.pcmScratchFrames = 0;

		this.encodingConfig.onEncodedPacket?.(packet, this.pcmMeta);
		// With backpressure:
		await this.muxer!.addEncodedAudioPacket(this.source._connectedTrack!, packet, this.pcmMeta);
	}

	private ensureEncoder(audioSample: AudioSample) {
		this.ensureEncoderPromise = (async () => {
			const { format, numberOfChannels, sampleRate, timestamp } = audioSample;

			// eslint-disable-next-line @typescript-eslint/no-deprecated
			const quality = resolveQuality(this.encodingConfig.quality, this.encodingConfig.bitrate);

			const encoderConfig = buildAudioEncoderConfig({
				numberOfChannels,
				sampleRate,
				...this.encodingConfig,
				quality,
			});
			this.encodingConfig.onEncoderConfig?.(encoderConfig);
			this.source._nominalBitrate = encoderConfig.bitrate ?? null;

			const MatchingCustomEncoder = customAudioEncoders.find(x => x.supports(
				this.encodingConfig.codec,
				encoderConfig,
			));

			if (MatchingCustomEncoder) {
				// @ts-expect-error "Can't create instance of abstract class 🤓"
				this.customEncoder = new MatchingCustomEncoder() as CustomAudioEncoder;
				// @ts-expect-error It's technically readonly
				this.customEncoder.codec = this.encodingConfig.codec;
				// @ts-expect-error It's technically readonly
				this.customEncoder.config = encoderConfig;
				// @ts-expect-error It's technically readonly
				this.customEncoder.onPacket = (packet, meta) => {
					if (!(packet instanceof EncodedPacket)) {
						throw new TypeError('The first argument passed to onPacket must be an EncodedPacket.');
					}
					if (meta !== undefined && (!meta || typeof meta !== 'object')) {
						throw new TypeError('The second argument passed to onPacket must be an object or undefined.');
					}

					this.encodingConfig.onEncodedPacket?.(packet, meta);
					this.lastMuxerPromise
						= this.muxer!.addEncodedAudioPacket(this.source._connectedTrack!, packet, meta)
							.catch((error) => {
								this.setError(error);
							});
				};
				// @ts-expect-error It's technically readonly
				this.customEncoder.onError = (error) => {
					this.setError(error);
				};

				await this.customEncoder.init();
			} else if ((PCM_AUDIO_CODECS as readonly string[]).includes(this.encodingConfig.codec)) {
				this.initPcmEncoder();
			} else {
				if (typeof AudioEncoder === 'undefined') {
					throw new Error(missingWebCodecsClassMessage('AudioEncoder'));
				}

				let supported: boolean;

				try {
					const support = await AudioEncoder.isConfigSupported(encoderConfig);
					supported = support.supported ?? false;
				} catch {
					supported = false;
				}

				if (!supported) {
					throw new Error(
						`This specific encoder configuration (${encoderConfig.codec}, ${encoderConfig.bitrate} bps,`
						+ ` ${encoderConfig.numberOfChannels} channels, ${encoderConfig.sampleRate} Hz) is not`
						+ ` supported in this environment. Consider using another codec or changing your`
						+ ` audio parameters.`,
					);
				}

				const primingShift = await detectAudioEncoderPrimingShift( // In seconds
					this.encodingConfig.codec,
					encoderConfig.codec,
					encoderConfig.sampleRate,
					encoderConfig.numberOfChannels,
				);
				let opusPreSkip = 0; // In seconds

				const stack = new Error('Encoding error').stack;
				this.encoder = new AudioEncoder({
					output: (chunk, meta) => {
						if (meta?.decoderConfig) {
							fixAudioDecoderConfig(this.encodingConfig.codec, encoderConfig, meta.decoderConfig);

							// We want Opus packet timestamps to include the pre-skip
							if (this.encodingConfig.codec === 'opus' && meta.decoderConfig.description) {
								const description = toUint8Array(meta.decoderConfig.description);
								opusPreSkip = parseOpusIdentificationHeader(description).preSkip / OPUS_SAMPLE_RATE;
							}
						}

						let packet = EncodedPacket.fromEncodedChunk(chunk);

						// Snap the timing information to the sample rate to recover information lost in microsecond
						// conversion
						packet = packet.clone({
							timestamp: roundToDivisor(
								packet.timestamp - primingShift - opusPreSkip,
								encoderConfig.sampleRate,
							),
							duration: chunk.duration != null
								? roundToDivisor(packet.duration, encoderConfig.sampleRate)
								: undefined,
						});

						if (isFirefox()) {
							// For Firefox, we only need to offset the first timestamp
							opusPreSkip = 0;
						}

						if (this.endPaddingAdded && packet.timestamp >= this.inputEndTimestamp + END_PADDING_SLACK) {
							// Only holds the silence added at the end, see flushAndClose
							return;
						}

						this.encodingConfig.onEncodedPacket?.(packet, meta);
						this.lastMuxerPromise
							= this.muxer!.addEncodedAudioPacket(this.source._connectedTrack!, packet, meta)
								.catch((error) => {
									this.setError(error);
								});
					},
					error: (error) => {
						error.stack = stack; // Provide a more useful stack trace
						this.setError(error);
					},
				});
				this.encoder.configure(encoderConfig);

				if (this.encodingConfig.codec === 'aac' && aacEncoderSilencesLeadingSamples()) {
					encodeAacSilencePrefix(this.encoder, format, numberOfChannels, sampleRate, timestamp);
				}
			}

			assert(this.source._connectedTrack);
			this.muxer = this.source._connectedTrack.output._muxer;

			if (this.closed && this.encoder && this.encoder.state !== 'closed') {
				// Closed (or canceled) while this initialization was pending, when there was no encoder to close yet:
				// nothing else will close the one just created
				this.encoder.close();
			}

			this.encoderInitialized = true;
		})();

		// An initialization error has to stick like encoding errors do, so that it also fails finalize(), even when the
		// add() that started the initialization wasn't awaited
		this.ensureEncoderPromise.catch((error: unknown) => this.setError(error));
	}

	private initPcmEncoder() {
		this.isPcmEncoder = true;

		const codec = this.encodingConfig.codec as PcmAudioCodec;
		const { dataType, sampleSize, littleEndian } = parsePcmCodec(codec);

		this.outputSampleSize = sampleSize;

		// All these functions receive a float sample as input and map it into the desired format

		switch (sampleSize) {
			case 1: {
				if (dataType === 'unsigned') {
					this.writeOutputValue = (view, byteOffset, value) =>
						view.setUint8(byteOffset, clamp(Math.round(value * 128) + 128, 0, 255));
				} else if (dataType === 'signed') {
					this.writeOutputValue = (view, byteOffset, value) => {
						view.setInt8(byteOffset, clamp(Math.round(value * 128), -128, 127));
					};
				} else if (dataType === 'ulaw') {
					this.writeOutputValue = (view, byteOffset, value) => {
						const int16 = clamp(Math.round(value * 32768), -32768, 32767);
						view.setUint8(byteOffset, toUlaw(int16));
					};
				} else if (dataType === 'alaw') {
					this.writeOutputValue = (view, byteOffset, value) => {
						const int16 = clamp(Math.round(value * 32768), -32768, 32767);
						view.setUint8(byteOffset, toAlaw(int16));
					};
				} else {
					assert(false);
				}
			}; break;
			case 2: {
				if (dataType === 'unsigned') {
					this.writeOutputValue = (view, byteOffset, value) =>
						view.setUint16(byteOffset, clamp(Math.round(value * 32768) + 32768, 0, 65535), littleEndian);
				} else if (dataType === 'signed') {
					this.writeOutputValue = (view, byteOffset, value) =>
						view.setInt16(byteOffset, clamp(Math.round(value * 32768), -32768, 32767), littleEndian);
				} else {
					assert(false);
				}
			}; break;
			case 3: {
				if (dataType === 'unsigned') {
					this.writeOutputValue = (view, byteOffset, value) =>
						setUint24(
							view,
							byteOffset,
							clamp(Math.round(value * 8388608) + 8388608, 0, 16777215),
							littleEndian,
						);
				} else if (dataType === 'signed') {
					this.writeOutputValue = (view, byteOffset, value) =>
						setInt24(
							view,
							byteOffset,
							clamp(Math.round(value * 8388608), -8388608, 8388607),
							littleEndian,
						);
				} else {
					assert(false);
				}
			}; break;
			case 4: {
				if (dataType === 'unsigned') {
					this.writeOutputValue = (view, byteOffset, value) =>
						view.setUint32(
							byteOffset,
							clamp(Math.round(value * 2147483648) + 2147483648, 0, 4294967295),
							littleEndian,
						);
				} else if (dataType === 'signed') {
					this.writeOutputValue = (view, byteOffset, value) =>
						view.setInt32(
							byteOffset,
							clamp(Math.round(value * 2147483648), -2147483648, 2147483647),
							littleEndian,
						);
				} else if (dataType === 'float') {
					this.writeOutputValue = (view, byteOffset, value) =>
						view.setFloat32(byteOffset, value, littleEndian);
				} else {
					assert(false);
				}
			}; break;
			case 8: {
				if (dataType === 'float') {
					this.writeOutputValue = (view, byteOffset, value) =>
						view.setFloat64(byteOffset, value, littleEndian);
				} else {
					assert(false);
				}
			}; break;
			default: {
				assertNever(sampleSize);
				assert(false);
			};
		}
	}

	async flushAndClose(forceClose: boolean, initializationSettled = false) {
		// When force closing, don't wait for an initialization that may never finish (one hanging in a platform codec,
		// say), but close the encoder once the initialization has settled, either way (a failed one can still leave an
		// encoder behind)
		const closeEncoderLater = forceClose
			&& !initializationSettled
			&& !!this.ensureEncoderPromise
			&& !this.encoderInitialized;
		if (closeEncoderLater) {
			const closeEncoder = () => this.flushAndClose(true, true);
			void this.ensureEncoderPromise!.then(closeEncoder, closeEncoder).catch(() => {});
		} else {
			// An encoder that's still initializing can't be flushed or closed yet, so let it finish (or fail) first
			await this.ensureEncoderPromise?.catch(() => {});
		}

		try {
			if (!forceClose) {
				this.checkForEncoderError();

				// Finalize the resampler to flush any buffered audio
				if (this.resampler) {
					await this.resampler.finalize();
				}

				if (this.pcmScratchFrames > 0) {
					await this.emitPcmScratchPacket();
				}

				if (
					this.encoder?.state === 'configured'
					&& this.encodingConfig.codec === 'opus'
					&& this.lastAudioDataParams
					&& this.lastAudioDataParams.sampleRate !== OPUS_SAMPLE_RATE
				) {
					// Opus encoders resample anything but 48 kHz internally, and Chrome's holds back the last few
					// milliseconds of input at flush, so push them out with some silence. Packets holding nothing but
					// that silence are dropped again.
					const { format, numberOfChannels, sampleRate } = this.lastAudioDataParams;
					const numberOfFrames = Math.ceil(END_PADDING_DURATION * sampleRate);
					const data = new Uint8Array(getBytesPerSample(format) * numberOfFrames * numberOfChannels);
					if (format === 'u8' || format === 'u8-planar') {
						data.fill(2 ** 7); // Fill it with the silent value
					}

					const audioData = new AudioData({
						data,
						format,
						numberOfChannels,
						numberOfFrames,
						sampleRate,
						timestamp: Math.round(1e6 * this.inputEndTimestamp),
					});
					this.encoder.encode(audioData);
					audioData.close();
					this.endPaddingAdded = true;
				}
			}

			this.closed = true;

			if (!forceClose) {
				if (this.customEncoder) {
					void this.customEncoderCallSerializer.call(() => this.customEncoder!.flush())
						.catch((error: unknown) => this.setError(error));
				} else if (this.encoder) {
					await this.encoder.flush();
				}
			}
		} finally {
			// This cleanup must also run when flushing threw (e.g. due to an encoder error), otherwise the encoder
			// would be left dangling
			this.closed = true;
			this.closedSignal.resolve();
			this.resampler = null;

			if (this.customEncoder) {
				if (!closeEncoderLater) {
					await this.customEncoderCallSerializer.call(() => this.customEncoder!.close())
						.catch((error: unknown) => this.setError(error));
				}
			} else if (this.encoder && this.encoder.state !== 'closed') {
				this.encoder.close();
			}
		}

		if (!forceClose) {
			this.checkForEncoderError();
		}
	}

	getQueueSize() {
		if (this.customEncoder) {
			return this.customEncoderQueueSize;
		} else if (this.isPcmEncoder) {
			return 0;
		} else {
			return this.encoder?.encodeQueueSize ?? 0;
		}
	}

	checkForEncoderError() {
		if (this.errorSet) {
			throw this.error;
		}
	}
}

const audioEncoderPrimingShiftPromises = new Map<string, Promise<number>>();
const AUDIO_ENCODER_PRIMING_MEASUREMENT_TIMEOUT = 3000; // In milliseconds

// WebCodecs audio encoders have encoder priming delay but don't surface this delay whatsoever, meaning they typically
// just emit audio at incorrect timestamps. This priming delay depends heavily on the browser-OS combo, so instead of
// hardcoding it, we simply detect it locally. It also depends on the sample rate, since encoders may resample the input
// internally (Chrome's Opus encoder resamples everything to 48 kHz, which delays other rates by up to 5.5 ms), so it's
// detected with the sample rate and channel count of the actual encoder. Resolves to the shift in seconds.
const detectAudioEncoderPrimingShift = (
	codec: AudioCodec,
	codecString: string,
	sampleRate: number,
	numberOfChannels: number,
) => {
	const key = `${codecString} ${sampleRate} ${numberOfChannels}`;
	let promise = audioEncoderPrimingShiftPromises.get(key);
	if (promise) {
		return promise;
	}

	promise = (async () => {
		const encoderConfig: AudioEncoderConfig = {
			codec: codecString,
			numberOfChannels,
			sampleRate,
			...getAudioEncoderConfigExtension(codec),
		};
		const impulseIndex = 4096;
		const numberOfFrames = 2 * impulseIndex;
		const format = 'f32-planar';

		const chunks: EncodedAudioChunk[] = [];
		let decoderConfig = null as AudioDecoderConfig | null;
		let peakIndex = null as number | null;
		let peakValue = -Infinity;
		let decodedFrames = 0;
		let decodedSampleRate = sampleRate; // Decoders may output another rate than the one encoded
		let codecError = null as DOMException | null;

		const encoder = new AudioEncoder({
			output: (chunk, meta) => {
				if (meta?.decoderConfig) {
					decoderConfig ??= meta.decoderConfig;
				}

				chunks.push(chunk);
			},
			error: (error) => {
				codecError ??= error;
			},
		});
		const decoder = new AudioDecoder({
			output: (audioData) => {
				decodedSampleRate = audioData.sampleRate;
				const values = new Float32Array(audioData.numberOfFrames);
				if (values.length > 0) { // Firefox's Vorbis decoder starts with an empty one, which can't be copied
					audioData.copyTo(values, { planeIndex: 0, format });
				}
				audioData.close();

				for (let i = 0; i < values.length; i++) {
					if (values[i]! > peakValue) {
						peakValue = values[i]!;
						peakIndex = decodedFrames + i;
					}
				}

				decodedFrames += values.length;
			},
			error: (error) => {
				codecError ??= error;
			},
		});

		// The measurement relies on the platform's codecs, which can hang (WebKitGTK's Vorbis decoder never finishes
		// flushing), so it gives up after a while rather than never letting the encoding start
		let timedOut = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<void>((resolve) => {
			timeoutId = setTimeout(() => {
				timedOut = true;
				resolve();
			}, AUDIO_ENCODER_PRIMING_MEASUREMENT_TIMEOUT);
		});
		const withinDeadline = async (promise: Promise<void>) => {
			promise.catch(() => {}); // Rejects when the codec gets closed after the deadline
			await Promise.race([promise, deadline]);
		};

		try {
			encoder.configure(encoderConfig);

			if (codec === 'aac' && aacEncoderSilencesLeadingSamples()) {
				encodeAacSilencePrefix(encoder, format, numberOfChannels, sampleRate, 0);
			}

			const data = new Float32Array(numberOfChannels * numberOfFrames);
			data[impulseIndex] = 1; // In the first channel

			const audioData = new AudioData({
				data,
				format,
				numberOfChannels,
				numberOfFrames,
				sampleRate,
				timestamp: 0,
			});
			encoder.encode(audioData);
			audioData.close();

			await withinDeadline(encoder.flush());

			if (!timedOut) {
				assert(decoderConfig);
				fixAudioDecoderConfig(codec, encoderConfig, decoderConfig);

				decoder.configure(decoderConfig);
				for (const chunk of chunks) {
					decoder.decode(chunk);
				}

				await withinDeadline(decoder.flush());
			}
		} catch (error) {
			throw codecError ?? error;
		} finally {
			clearTimeout(timeoutId);

			if (encoder.state !== 'closed') {
				encoder.close();
			}
			if (decoder.state !== 'closed') {
				decoder.close();
			}
		}

		if (timedOut) {
			Logging._warn(
				`Measuring the priming of the ${codecString} encoder timed out; assuming none, so the encoded audio may`
				+ ` be shifted by the encoder's delay.`,
			);

			// Not remembered, as the platform may just have been slow (found by identity rather than by key, so that
			// this doesn't depend on how the cache is keyed)
			for (const [key, value] of audioEncoderPrimingShiftPromises) {
				if (value === promise) {
					audioEncoderPrimingShiftPromises.delete(key);
				}
			}
			return 0;
		}

		assert(peakIndex !== null);

		return peakIndex / decodedSampleRate - impulseIndex / sampleRate + chunks[0]!.timestamp / 1e6;
	})();

	audioEncoderPrimingShiftPromises.set(key, promise);

	// Don't remember failures because they _could_ be transient
	promise.catch(() => audioEncoderPrimingShiftPromises.delete(key));

	return promise;
};

/**
 * Whether the platform's AAC encoder silences the start of what it encodes: WebKit's swallows the first 1024 samples
 * (https://bugs.webkit.org/show_bug.cgi?id=328491), and Windows' Media Foundation encoder, as used by Chromium, about
 * the first 512.
 */
const aacEncoderSilencesLeadingSamples = () => isWebKit() || isWindowsChromium();

/** Encodes a frame of silence ahead of the actual audio, for encoders that silence the start of what they encode. */
const encodeAacSilencePrefix = (
	encoder: AudioEncoder,
	format: AudioSampleFormat, // Must match the format of the actual audio data for this workaround to work
	numberOfChannels: number,
	sampleRate: number,
	timestamp: number, // In seconds, the timestamp of the first actual sample
) => {
	const numberOfFrames = 1024;
	const bytesPerSample = getBytesPerSample(format);
	const data = new Uint8Array(bytesPerSample * numberOfFrames * numberOfChannels);
	if (format === 'u8' || format === 'u8-planar') {
		data.fill(2 ** 7); // Fill it with the silent value
	}

	const audioData = new AudioData({
		data,
		format,
		numberOfChannels,
		numberOfFrames,
		sampleRate,
		timestamp: Math.round(1e6 * (timestamp - numberOfFrames / sampleRate)),
	});
	encoder.encode(audioData);
	audioData.close();
};

const fixAudioDecoderConfig = (
	codec: AudioCodec,
	encoderConfig: AudioEncoderConfig,
	decoderConfig: AudioDecoderConfig,
) => {
	// WebKit emits an invalid description for AAC (https://bugs.webkit.org/show_bug.cgi?id=302253), which we try to
	// detect here. If detected, we'll provide our own description instead, derived from the codec string and audio
	// parameters.
	if (codec === 'aac') {
		if (
			decoderConfig.description
			&& decoderConfig.description.byteLength > 0
			&& toUint8Array(decoderConfig.description)[0] === 0x03
		) {
			// We were handed an ES descriptor instead of an AudioSpecificConfig
			const { decoderSpecificInfo } = readEsDescriptor(
				FileSlice.tempFromBytes(toUint8Array(decoderConfig.description)),
			);
			decoderConfig.description = decoderSpecificInfo ?? undefined;
		}

		let needsDescriptionOverwrite = false;
		if (!decoderConfig.description || decoderConfig.description.byteLength < 2) {
			needsDescriptionOverwrite = true;
		} else {
			const audioSpecificConfig = parseAacAudioSpecificConfig(toUint8Array(decoderConfig.description));
			needsDescriptionOverwrite = audioSpecificConfig.objectType === 0;
		}

		if (needsDescriptionOverwrite) {
			const objectType = Number(last(encoderConfig.codec.split('.')));

			decoderConfig.description = buildAacAudioSpecificConfig({
				objectType,
				outputNumberOfChannels: decoderConfig.numberOfChannels,
				outputSampleRate: decoderConfig.sampleRate,
				programConfigElement: null,
			});
		}

		// The codec string is the one the encoder was configured with, but the encoder may well have produced a
		// different object type (Media Foundation encodes AAC-LC when asked for HE-AAC). So, like for any other AAC
		// track, derive the codec string from the AudioSpecificConfig.
		if (decoderConfig.codec.startsWith('mp4a.40.')) {
			decoderConfig.codec = extractAudioCodecString({
				codec: 'aac',
				codecDescription: toUint8Array(decoderConfig.description!),
				aacCodecInfo: { isMpeg2: false, objectType: null },
				dtsFormat: null,
			});
		}
	} else if (codec === 'opus' && decoderConfig.description && decoderConfig.description.byteLength >= 19) {
		// Chromium encodes 8, 12, 16 and 24 kHz input at that rate and writes the encoder's lookahead as the
		// identification header's pre-skip without converting it to 48 kHz samples, which is the unit RFC 7845 (5.1)
		// defines (FFmpeg's libopusenc scales it). Since libopus's lookahead is always 6.5 ms (2.5 ms for restricted
		// low delay), a pre-skip that equals it in samples at the encoder's rate gives the mistake away.
		const rate = decoderConfig.sampleRate;
		const description = toUint8Array(decoderConfig.description).slice();
		const view = toDataView(description);
		const preSkip = view.getUint16(10, true);

		if (
			[8000, 12000, 16000, 24000].includes(rate)
			&& (preSkip * 2000 === rate * 13 || preSkip * 400 === rate)
		) {
			view.setUint16(10, preSkip * OPUS_SAMPLE_RATE / rate, true);
			decoderConfig.description = description;
		}
	}
};

/**
 * This source can be used to add raw, unencoded audio samples to an output audio track. These samples will
 * automatically be encoded and then piped into the output.
 * @group Media sources
 * @public
 */
export class AudioSampleSource extends AudioSource {
	/** @internal */
	private _encoder: AudioEncoderWrapper;

	/**
	 * Creates a new {@link AudioSampleSource} whose samples are encoded according to the specified
	 * {@link AudioEncodingConfig}.
	 */
	constructor(encodingConfig: AudioEncodingConfig) {
		validateAudioEncodingConfig(encodingConfig);

		super(encodingConfig.codec);
		this._encoder = new AudioEncoderWrapper(this, encodingConfig);
	}

	/**
	 * Encodes an audio sample and then adds it to the output.
	 *
	 * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
	 * to respect writer and encoder backpressure.
	 */
	add(audioSample: AudioSample) {
		if (!(audioSample instanceof AudioSample)) {
			throw new TypeError('audioSample must be an AudioSample.');
		}

		return this._encoder.add(audioSample, false);
	}

	/** @internal */
	override _flushAndClose(forceClose: boolean) {
		return this._encoder.flushAndClose(forceClose);
	}
}

/**
 * Options for {@link AudioBufferSource}.
 * @group Media sources
 * @public
 */
export type AudioBufferSourceOptions = {
	/**
	 * The timestamp of the first `AudioBuffer`, in seconds. Subsequent buffers are placed directly after the previous
	 * one. Defaults to 0.
	 */
	startTimestamp?: number;
};

/**
 * This source can be used to add audio data from an AudioBuffer to the output track. This is useful when working with
 * the Web Audio API.
 * @group Media sources
 * @public
 */
export class AudioBufferSource extends AudioSource {
	/** @internal */
	private _encoder: AudioEncoderWrapper;
	/** @internal */
	private _accumulatedTime: number;

	/**
	 * Creates a new {@link AudioBufferSource} whose `AudioBuffer` instances are encoded according to the specified
	 * {@link AudioEncodingConfig} and {@link AudioBufferSourceOptions}.
	 */
	constructor(encodingConfig: AudioEncodingConfig, options: AudioBufferSourceOptions = {}) {
		validateAudioEncodingConfig(encodingConfig);
		if (typeof options !== 'object' || !options) {
			throw new TypeError('options must be an object.');
		}
		if (options.startTimestamp !== undefined && !Number.isFinite(options.startTimestamp)) {
			throw new TypeError('options.startTimestamp, when provided, must be a finite number.');
		}

		super(encodingConfig.codec);
		this._encoder = new AudioEncoderWrapper(this, encodingConfig);
		this._accumulatedTime = options.startTimestamp ?? 0;
	}

	/**
	 * Converts an AudioBuffer to audio samples, encodes them and adds them to the output. The first `AudioBuffer` will
	 * be played at the configured start timestamp (the default is 0), and each subsequent `AudioBuffer` will be placed
	 * directly after the previous one.
	 *
	 * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
	 * to respect writer and encoder backpressure.
	 */
	async add(audioBuffer: AudioBuffer) {
		if (typeof AudioBuffer === 'undefined' || !(audioBuffer instanceof AudioBuffer)) {
			throw new TypeError('audioBuffer must be an AudioBuffer.');
		}

		const iterator = AudioSample._fromAudioBuffer(audioBuffer, this._accumulatedTime);
		this._accumulatedTime += audioBuffer.duration;

		for (const audioSample of iterator) {
			await this._encoder.add(audioSample, true);
		}
	}

	/** @internal */
	override _flushAndClose(forceClose: boolean) {
		return this._encoder.flushAndClose(forceClose);
	}
}

/**
 * Options for {@link MediaStreamAudioTrackSource}.
 * @group Media sources
 * @public
 */
export type MediaStreamAudioTrackSourceOptions = {
	/**
	 * Controls the basis (zero point) for audio sample timestamps.
	 *
	 * When set to `'synced-zero'`, timestamps will be relative to the first chunk of media from a `MediaStreamTrack`
	 * added to the {@link Output}.
	 *
	 * When set to `'zero'`, timestamps will be relative to the first audio sample emitted by this source.
	 *
	 * When set to `'unix'`, timestamps will be relative to the Unix epoch, so clearly associated with a distinct point
	 * in time. Here, pausing via {@link MediaStreamAudioTrackSource.pause} will also create gaps in timestamps. Be sure
	 * to pair this mode with {@link BaseTrackMetadata.isRelativeToUnixEpoch}.
	 *
	 * Defaults to `'synced-zero'`.
	 */
	timestampBase?: 'synced-zero' | 'zero' | 'unix';
};

/**
 * Audio source that encodes the data of a
 * [`MediaStreamAudioTrack`](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack) and pipes it into the
 * output. This is useful for capturing live or real-time audio such as microphones or audio from other media elements.
 * Audio will automatically start being captured once the connected {@link Output} is started, and will keep being
 * captured until the {@link Output} is finalized or this source is closed. The source closes itself once the track has
 * ended.
 * @group Media sources
 * @public
 */
export class MediaStreamAudioTrackSource extends AudioSource {
	/** @internal */
	private _options: MediaStreamAudioTrackSourceOptions;
	/** @internal */
	private _encoder: AudioEncoderWrapper;
	/** @internal */
	private _abortController: AbortController | null = null;
	/** @internal */
	private _track: MediaStreamAudioTrack;
	/** @internal */
	private _audioContext: AudioContext | null = null;
	/** @internal */
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	private _scriptProcessorNode: ScriptProcessorNode | null = null; // Deprecated but goated
	/** @internal */
	private _promiseWithResolvers = promiseWithResolvers();
	/** @internal */
	private _errorPromiseAccessed = false;
	/** @internal */
	private _paused = false;
	/** @internal */
	private _trackEndedListener: (() => void) | null = null;
	/** @internal */
	private _pauseStartTime = 0;
	/**
	 * The paused time, in seconds, removed from the timestamps of audio captured from now on. It's measured in wall
	 * clock time rather than in dropped audio, so that sources paused and resumed together stay in sync.
	 * @internal
	 */
	private _pausedTime = 0;
	/** @internal */
	private _firstSampleTime: number | null = null;
	/** @internal */
	private _resumedSinceLastSample = false;

	/** A promise that rejects upon any error within this source. This promise never resolves. */
	get errorPromise() {
		this._errorPromiseAccessed = true;
		return this._promiseWithResolvers.promise;
	}

	/** Whether this source is currently paused as a result of calling `.pause()`. */
	get paused() {
		return this._paused;
	}

	/**
	 * Creates a new {@link MediaStreamAudioTrackSource} from a `MediaStreamAudioTrack`, which will pull audio samples
	 * from the stream in real time and encode them according to {@link AudioEncodingConfig}.
	 */
	constructor(
		track: MediaStreamAudioTrack,
		encodingConfig: AudioEncodingConfig,
		options: MediaStreamAudioTrackSourceOptions = {},
	) {
		if (typeof MediaStreamTrack === 'undefined' || !(track instanceof MediaStreamTrack) || track.kind !== 'audio') {
			throw new TypeError('track must be an audio MediaStreamTrack.');
		}
		validateAudioEncodingConfig(encodingConfig);
		if (typeof options !== 'object' || !options) {
			throw new TypeError('options must be an object.');
		}
		if (
			options.timestampBase !== undefined
			&& options.timestampBase !== 'synced-zero'
			&& options.timestampBase !== 'zero'
			&& options.timestampBase !== 'unix'
		) {
			throw new TypeError(
				'options.timestampBase, when provided, must be one of \'synced-zero\', \'zero\', or \'unix\'.',
			);
		}

		super(encodingConfig.codec);
		this._options = options;
		this._encoder = new AudioEncoderWrapper(this, encodingConfig);
		this._track = track;
	}

	/** @internal */
	override async _start() {
		if (!this._errorPromiseAccessed) {
			Logging._warn(
				'Make sure not to ignore the `errorPromise` field on MediaStreamAudioTrackSource, so that any internal'
				+ ' errors get bubbled up properly.',
			);
		}

		this._abortController = new AbortController();

		let firstAudioDataTimestamp: number | null = null;
		let errored = false;
		let timestampOffset = 0;
		let lastEndTimestamp: number | null = null;

		// `captureTime` is when the sample's first audio frame was captured (in seconds, performance.now() time base)
		const onAudioSample = (audioSample: AudioSample, captureTime = performance.now() / 1000) => {
			if (errored) {
				audioSample.close();
				return;
			}

			const currentTimestamp = audioSample.timestamp;

			if (this._paused) {
				audioSample.close();
				return;
			}

			if (firstAudioDataTimestamp === null) {
				firstAudioDataTimestamp = audioSample.timestamp;
				this._firstSampleTime = captureTime;

				let target: number;
				const timestampBase = this._options.timestampBase ?? 'synced-zero';
				if (timestampBase === 'unix') {
					target = Date.now() / 1000;
				} else if (timestampBase === 'zero') {
					target = 0;
				} else {
					const output = this._connectedTrack!.output;
					if (output._firstMediaStreamTimestamp === null) {
						output._firstMediaStreamTimestamp = captureTime;
						target = 0;
					} else {
						target = captureTime - output._firstMediaStreamTimestamp;
					}
				}

				timestampOffset = target - firstAudioDataTimestamp;
			}

			if (this._encoder.getQueueSize() >= 8) {
				// Drop data if the encoder is overloaded
				audioSample.close();
				return;
			}

			const pausedTime = this._options.timestampBase === 'unix' ? 0 : this._pausedTime;
			let timestamp = currentTimestamp + timestampOffset - pausedTime;

			if (this._resumedSinceLastSample && lastEndTimestamp !== null && timestamp < lastEndTimestamp) {
				// Since exactly the paused time is removed, the first audio after resuming can begin before the end of
				// the last audio before pausing (audio data spans many milliseconds). Cut off the overlapping start to
				// keep the audio in place, in sync with the other tracks.
				const overlappingFrames = Math.round((lastEndTimestamp - timestamp) * audioSample.sampleRate);
				if (overlappingFrames >= audioSample.numberOfFrames) {
					audioSample.close();
					return;
				}

				if (overlappingFrames > 0) {
					const trimmed = audioSample.trim(overlappingFrames);
					audioSample.close();
					audioSample = trimmed;
					timestamp += overlappingFrames / audioSample.sampleRate;
				}
			}

			this._resumedSinceLastSample = false;
			audioSample.setTimestamp(timestamp);
			lastEndTimestamp = timestamp + audioSample.duration;

			void this._encoder.add(audioSample, true)
				.catch((error) => {
					errored = true;

					this._abortController?.abort();
					this._promiseWithResolvers.reject(error);
					void this._audioContext?.suspend();
				});
		};

		// An ended track can't produce any more data, so we close this source. Otherwise, the output would keep
		// waiting for data from this track, holding back the media of all other tracks until finalization.
		const onTrackEnded = () => {
			if (errored || this._closingPromise || this._connectedTrack!.output.state !== 'started') {
				return;
			}

			this.close();
			this._closingPromise!.catch((error) => {
				this._promiseWithResolvers.reject(error);
			});
		};
		this._trackEndedListener = onTrackEnded;
		this._track.addEventListener('ended', onTrackEnded);

		if (this._track.readyState === 'ended') {
			// The track ended before the recording started (a microphone unplugged right away, for example). There's
			// nothing to capture from it, and MediaStreamTrackProcessor can't even be created for an ended track.
			onTrackEnded();
			return;
		}

		if (typeof MediaStreamTrackProcessor !== 'undefined') {
			// Great, MediaStreamTrackProcessor is supported, this is the preferred way of doing things
			const processor = new MediaStreamTrackProcessor({ track: this._track });
			const consumer = new WritableStream<AudioData>({
				write: audioData => onAudioSample(new AudioSample(audioData)),
			});

			processor.readable.pipeTo(consumer, {
				signal: this._abortController.signal,
			}).then(onTrackEnded, (error) => { // The stream ends once the track has ended
				// Handle AbortError silently
				if (error instanceof DOMException && error.name === 'AbortError') return;

				this._promiseWithResolvers.reject(error);
			});
		} else {
			// Let's fall back to an AudioContext approach

			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
			const AudioContext = window.AudioContext || (window as any).webkitAudioContext;

			this._audioContext = new AudioContext({ sampleRate: this._track.getSettings().sampleRate });
			const sourceNode = this._audioContext.createMediaStreamSource(new MediaStream([this._track]));
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			this._scriptProcessorNode = this._audioContext.createScriptProcessor(4096);

			if (this._audioContext.state === 'suspended') {
				// A context that isn't allowed to start yet (as long as the page hasn't had a user gesture) only
				// resolves this once it is, so don't wait for it: the audio comes in once the context runs. Waiting
				// would keep the output from ever starting, and from being canceled or finalized, since those wait
				// for the start.
				this._audioContext.resume().catch(() => {});
			}

			sourceNode.connect(this._scriptProcessorNode);
			this._scriptProcessorNode.connect(this._audioContext.destination);

			let totalDuration = 0;

			// eslint-disable-next-line @typescript-eslint/no-deprecated
			this._scriptProcessorNode.onaudioprocess = (event) => {
				// A track stopped with track.stop() fires no 'ended' event, and the node keeps delivering silence
				if (this._track.readyState === 'ended') {
					onTrackEnded();
					return;
				}

				// The event only fires once the whole buffer has been captured, so its start was captured a buffer's
				// duration ago (~93 ms for 4096 frames at 44.1 kHz). Placing it by the time of the event would put the
				// audio that much too late relative to the other tracks.
				// eslint-disable-next-line @typescript-eslint/no-deprecated
				const bufferCaptureTime = performance.now() / 1000 - event.inputBuffer.duration;
				const bufferTimestamp = totalDuration;

				// eslint-disable-next-line @typescript-eslint/no-deprecated
				const iterator = AudioSample._fromAudioBuffer(event.inputBuffer, totalDuration);
				// eslint-disable-next-line @typescript-eslint/no-deprecated
				totalDuration += event.inputBuffer.duration;

				for (const audioSample of iterator) {
					onAudioSample(audioSample, bufferCaptureTime + audioSample.timestamp - bufferTimestamp);
				}
			};
		}
	}

	/**
	 * Pauses the capture of audio data - any audio data emitted by the underlying media stream will be ignored
	 * while paused. This does *not* close the underlying `MediaStreamAudioTrack`, it just ignores its output.
	 */
	pause() {
		if (this._paused) {
			return;
		}

		this._paused = true;
		this._pauseStartTime = performance.now() / 1000;
	}

	/** Resumes the capture of audio data after being paused. */
	resume() {
		if (!this._paused) {
			return;
		}

		this._paused = false;
		this._resumedSinceLastSample = true;

		const timelineStartTime = this._options.timestampBase === 'zero'
			? this._firstSampleTime
			: (this._connectedTrack?.output._firstMediaStreamTimestamp ?? null);
		this._pausedTime += getPauseDurationOnTimeline(this._pauseStartTime, timelineStartTime);
	}

	/** @internal */
	override async _flushAndClose(forceClose: boolean) {
		try {
			if (this._abortController) {
				this._abortController.abort();
				this._abortController = null;
			}

			if (this._trackEndedListener) {
				this._track.removeEventListener('ended', this._trackEndedListener);
				this._trackEndedListener = null;
			}

			if (this._audioContext) {
				assert(this._scriptProcessorNode);

				this._scriptProcessorNode.disconnect();
				await this._audioContext.suspend();
			}
		} finally {
			// The encoder must be closed even if the track teardown above threw
			await this._encoder.flushAndClose(forceClose);
		}
	}
}

// === MEDIA STREAM TRACK PROCESSOR WORKER ===

type MediaStreamTrackProcessorWorkerMessage = {
	type: 'support';
	supported: boolean;
} | {
	type: 'videoFrame';
	trackId: number;
	videoFrame: VideoFrame;
} | {
	type: 'trackStopped';
	trackId: number;
} | {
	type: 'error';
	trackId: number;
	error: unknown;
};

type MediaStreamTrackProcessorControllerMessage = {
	type: 'videoTrack';
	trackId: number;
	track: MediaStreamVideoTrack;
} | {
	type: 'stopTrack';
	trackId: number;
};

const mediaStreamTrackProcessorWorkerCode = () => {
	const sendMessage = (message: MediaStreamTrackProcessorWorkerMessage, transfer?: Transferable[]) => {
		if (transfer) {
			self.postMessage(message, { transfer });
		} else {
			self.postMessage(message);
		}
	};

	// Immediately send a message to the main thread, letting them know of the support
	sendMessage({
		type: 'support',
		supported: typeof MediaStreamTrackProcessor !== 'undefined',
	});

	const abortControllers = new Map<number, AbortController>();
	const activeTracks = new Map<number, MediaStreamVideoTrack>();

	self.addEventListener('message', (event) => {
		const message = event.data as MediaStreamTrackProcessorControllerMessage;

		switch (message.type) {
			case 'videoTrack': {
				activeTracks.set(message.trackId, message.track);

				const processor = new MediaStreamTrackProcessor({ track: message.track });
				const consumer = new WritableStream<VideoFrame>({
					write: (videoFrame) => {
						if (!activeTracks.has(message.trackId)) {
							videoFrame.close();
							return;
						}

						// Send it to the main thread
						sendMessage({
							type: 'videoFrame',
							trackId: message.trackId,
							videoFrame,
						}, [videoFrame]);
					},
				});

				const abortController = new AbortController();
				abortControllers.set(message.trackId, abortController);

				processor.readable.pipeTo(consumer, {
					signal: abortController.signal,
				}).catch((error: unknown) => {
					// Handle AbortError silently
					if (error instanceof DOMException && error.name === 'AbortError') return;

					sendMessage({
						type: 'error',
						trackId: message.trackId,
						error,
					});
				});
			}; break;

			case 'stopTrack': {
				const abortController = abortControllers.get(message.trackId);
				if (abortController) {
					abortController.abort();
					abortControllers.delete(message.trackId);
				}

				const track = activeTracks.get(message.trackId);
				track?.stop();
				activeTracks.delete(message.trackId);

				sendMessage({
					type: 'trackStopped',
					trackId: message.trackId,
				});
			}; break;

			default: assertNever(message);
		}
	});
};

let nextMediaStreamTrackProcessorWorkerId = 0;
let mediaStreamTrackProcessorWorker: Worker | null = null;

const initMediaStreamTrackProcessorWorker = () => {
	const blob = new Blob(
		[`(${mediaStreamTrackProcessorWorkerCode.toString()})()`],
		{ type: 'application/javascript' },
	);
	const url = URL.createObjectURL(blob);

	mediaStreamTrackProcessorWorker = new Worker(url);
};

let mediaStreamTrackProcessorIsSupportedInWorkerCache: boolean | null = null;
const mediaStreamTrackProcessorIsSupportedInWorker = async () => {
	if (mediaStreamTrackProcessorIsSupportedInWorkerCache !== null) {
		return mediaStreamTrackProcessorIsSupportedInWorkerCache;
	}

	if (!mediaStreamTrackProcessorWorker) {
		initMediaStreamTrackProcessorWorker();
	}

	return new Promise<boolean>((resolve) => {
		assert(mediaStreamTrackProcessorWorker);

		const listener = (event: MessageEvent) => {
			const message = event.data as MediaStreamTrackProcessorWorkerMessage;

			if (message.type === 'support') {
				mediaStreamTrackProcessorIsSupportedInWorkerCache = message.supported;
				mediaStreamTrackProcessorWorker!.removeEventListener('message', listener);

				resolve(message.supported);
			}
		};

		mediaStreamTrackProcessorWorker.addEventListener('message', listener);
	});
};

const sendMessageToMediaStreamTrackProcessorWorker = (
	message: MediaStreamTrackProcessorControllerMessage,
	transfer?: Transferable[],
) => {
	assert(mediaStreamTrackProcessorWorker);

	if (transfer) {
		mediaStreamTrackProcessorWorker.postMessage(message, transfer);
	} else {
		mediaStreamTrackProcessorWorker.postMessage(message);
	}
};

/**
 * Base class for subtitle sources - sources for subtitle tracks.
 * @group Media sources
 * @public
 */
export abstract class SubtitleSource extends MediaSource {
	/** @internal */
	declare _connectedTrack: OutputSubtitleTrack | null;
	/** @internal */
	override readonly _codec: SubtitleCodec;

	/** Internal constructor. */
	constructor(codec: SubtitleCodec) {
		super();

		if (!SUBTITLE_CODECS.includes(codec)) {
			throw new TypeError(`Invalid subtitle codec '${codec}'. Must be one of: ${SUBTITLE_CODECS.join(', ')}.`);
		}

		this._codec = codec;
	}
}

/**
 * This source can be used to add subtitles from a subtitle text file.
 * @group Media sources
 * @public
 */
export class TextSubtitleSource extends SubtitleSource {
	/** @internal */
	private _parser: SubtitleParser;
	/** @internal */
	private _error: unknown = null;
	/** @internal */
	private _errorSet = false;
	/** @internal */
	private _lastMuxerPromise: Promise<void> = Promise.resolve();

	/** Creates a new {@link TextSubtitleSource} where added text chunks are in the specified `codec`. */
	constructor(codec: SubtitleCodec) {
		super(codec);

		this._parser = new SubtitleParser({
			codec,
			output: (cue, metadata) => {
				this._lastMuxerPromise
					= this._connectedTrack!.output._muxer.addSubtitleCue(this._connectedTrack!, cue, metadata)
						.catch((error) => {
							this._setError(error);
						});
			},
		});
	}

	/**
	 * Parses the subtitle text according to the specified codec and adds it to the output track. You don't have to
	 * add the entire subtitle file at once here; you can provide it in chunks.
	 *
	 * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
	 * to respect writer and encoder backpressure.
	 */
	add(text: string) {
		if (typeof text !== 'string') {
			throw new TypeError('text must be a string.');
		}

		this._checkForError();

		this._ensureValidAdd();
		this._parser.parse(text);

		return this._lastMuxerPromise; // Allow the writer to apply backpressure
	}

	/** @internal */
	private _setError(error: unknown) {
		if (!this._errorSet) {
			this._error = error;
			this._errorSet = true;
		}
	}

	/** @internal */
	_checkForError() {
		if (this._errorSet) {
			throw this._error;
		}
	}

	/** @internal */
	override async _flushAndClose(forceClose: boolean) {
		if (!forceClose) {
			this._checkForError();
		}
	}
}
