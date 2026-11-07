/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { assert, simplifyRational } from './misc';
import { AudioSample } from './sample';

/** Zero crossings of the resampling kernel on each side of its center. */
const KERNEL_ZERO_CROSSINGS = 16;
/** Cutoff frequency of the kernel, relative to the lower of the two Nyquist frequencies. */
const KERNEL_CUTOFF = 0.9;
/** Entries of the kernel table per source frame. Values in between are interpolated linearly. */
const KERNEL_TABLE_RESOLUTION = 512;
/** The maximum number of weights computed upfront for all phases. */
const MAX_PHASE_TABLE_SIZE = 2 ** 18;

/**
 * Utility class to handle audio resampling, handling both sample rate resampling as well as channel up/downmixing.
 * The advantage over doing this manually rather than using OfflineAudioContext to do it for us is the artifact-free
 * handling of putting multiple resampled audio samples back to back, which produces flaky results using
 * OfflineAudioContext.
 *
 * Resampling uses a windowed-sinc low-pass kernel (like Chromium's SincResampler), so that downsampling doesn't alias
 * and upsampling doesn't image. Each input sample adds its contribution to the output frames within the kernel's
 * reach, which makes the result independent of how the input is split into samples.
 */
export class AudioResampler {
	sourceSampleRate: number | null = null;
	targetSampleRate: number;
	sourceNumberOfChannels: number | null = null;
	targetNumberOfChannels: number;
	startTime: number | null = null;
	onSample: (sample: AudioSample) => Promise<void>;

	bufferSizeInFrames: number;
	bufferSizeInSamples: number;
	bufferCapacityInFrames!: number;
	/** Accumulates in double precision, so that the contributions of several samples add up exactly */
	outputBuffer!: Float64Array;
	/** Start frame of current buffer */
	bufferStartFrame = 0;
	/** The highest index written to in the current buffer */
	maxWrittenFrame: number | null = null;
	channelMixer!: (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => number;
	tempSourceBuffer!: Float32Array;
	/** The source data mixed to the target channel count, interleaved */
	mixedBuffer!: Float32Array;

	/** Whether the sample rates match, so the samples only need their channels mixed */
	passThrough = false;
	/** The kernel, sampled from its center outwards (it's symmetric) */
	kernelTable!: Float32Array;
	/** Half the width of the kernel, in source frames */
	kernelRadius = 0;
	/**
	 * When the ratio of the sample rates has a small enough denominator, output frames only fall on that many different
	 * positions (phases) between two source frames, so the weights are computed once per phase upfront. 0 otherwise.
	 */
	phaseCount = 0;
	/** Source frames per output frame, times the phase count */
	phaseStep = 0;
	/** The space reserved for the weights of one output frame */
	weightsStride = 0;
	/**
	 * The normalized weights of the source frames within the kernel's reach of an output frame, for every phase (or for
	 * the current output frame only, if there are too many phases)
	 */
	weights!: Float64Array;
	/** For every phase, the first source frame within reach, relative to the source frame at or before the output */
	phaseFirstSourceFrames!: Int32Array;
	/** For every phase, the number of source frames within reach */
	phaseWeightCounts!: Int32Array;
	/** Where the weights of the current output frame start */
	weightsOffset = 0;
	/** The number of weights of the current output frame */
	weightCount = 0;
	/** The mixed first frame of the audio, which counts as repeated before the start (so the edges keep their level) */
	firstFrame: Float32Array | null = null;
	/** The mixed last frame of the audio so far, which counts as repeated after the end */
	lastFrame!: Float32Array;
	/** Source frame index (relative to the start) at the end of the audio so far */
	sourceEndFrame = 0;

	constructor(options: {
		targetSampleRate: number;
		targetNumberOfChannels: number;
		onSample: (sample: AudioSample) => Promise<void>;
	}) {
		this.targetSampleRate = options.targetSampleRate;
		this.targetNumberOfChannels = options.targetNumberOfChannels;
		this.onSample = options.onSample;

		this.bufferSizeInFrames = Math.floor(this.targetSampleRate * 5.0); // 5 seconds
		this.bufferSizeInSamples = this.bufferSizeInFrames * this.targetNumberOfChannels;
	}

	/**
	 * Sets up the channel mixer to handle up/downmixing in the case where input and output channel counts don't match.
	 */
	doChannelMixerSetup(): void {
		assert(this.sourceNumberOfChannels !== null);

		const sourceNum = this.sourceNumberOfChannels;
		const targetNum = this.targetNumberOfChannels;

		// Logic taken from
		// https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Basic_concepts_behind_Web_Audio_API
		// Most of the mapping functions are branchless.

		if (sourceNum === 1 && targetNum === 2) {
			// Mono to Stereo: M -> L, M -> R
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum]!;
			};
		} else if (sourceNum === 1 && targetNum === 4) {
			// Mono to Quad: M -> L, M -> R, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum]! * +(targetChannelIndex < 2);
			};
		} else if (sourceNum === 1 && targetNum === 6) {
			// Mono to 5.1: 0 -> L, 0 -> R, M -> C, 0 -> LFE, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum]! * +(targetChannelIndex === 2);
			};
		} else if (sourceNum === 2 && targetNum === 1) {
			// Stereo to Mono: 0.5 * (L + R)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return 0.5 * (sourceData[baseIdx]! + sourceData[baseIdx + 1]!);
			};
		} else if (sourceNum === 2 && targetNum === 4) {
			// Stereo to Quad: L -> L, R -> R, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return targetChannelIndex < 2
					? sourceData[sourceFrameIndex * sourceNum + targetChannelIndex]!
					: 0;
			};
		} else if (sourceNum === 2 && targetNum === 6) {
			// Stereo to 5.1: L -> L, R -> R, 0 -> C, 0 -> LFE, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return targetChannelIndex < 2
					? sourceData[sourceFrameIndex * sourceNum + targetChannelIndex]!
					: 0;
			};
		} else if (sourceNum === 4 && targetNum === 1) {
			// Quad to Mono: 0.25 * (L + R + SL + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return 0.25 * (
					sourceData[baseIdx]! + sourceData[baseIdx + 1]!
					+ sourceData[baseIdx + 2]! + sourceData[baseIdx + 3]!
				);
			};
		} else if (sourceNum === 4 && targetNum === 2) {
			// Quad to Stereo: 0.5 * (L + SL), 0.5 * (R + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return 0.5 * (
					sourceData[baseIdx + targetChannelIndex]!
					+ sourceData[baseIdx + targetChannelIndex + 2]!
				);
			};
		} else if (sourceNum === 4 && targetNum === 6) {
			// Quad to 5.1: L -> L, R -> R, 0 -> C, 0 -> LFE, SL -> SL, SR -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;

				// It's a bit harder to do this one branchlessly
				if (targetChannelIndex < 2) return sourceData[baseIdx + targetChannelIndex]!; // L, R
				if (targetChannelIndex === 2 || targetChannelIndex === 3) return 0; // C, LFE
				return sourceData[baseIdx + targetChannelIndex - 2]!; // SL, SR
			};
		} else if (sourceNum === 6 && targetNum === 1) {
			// 5.1 to Mono: sqrt(1/2) * (L + R) + C + 0.5 * (SL + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return Math.SQRT1_2 * (sourceData[baseIdx]! + sourceData[baseIdx + 1]!)
					+ sourceData[baseIdx + 2]!
					+ 0.5 * (sourceData[baseIdx + 4]! + sourceData[baseIdx + 5]!);
			};
		} else if (sourceNum === 6 && targetNum === 2) {
			// 5.1 to Stereo: L + sqrt(1/2) * (C + SL), R + sqrt(1/2) * (C + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return sourceData[baseIdx + targetChannelIndex]!
					+ Math.SQRT1_2 * (sourceData[baseIdx + 2]! + sourceData[baseIdx + targetChannelIndex + 4]!);
			};
		} else if (sourceNum === 6 && targetNum === 4) {
			// 5.1 to Quad: L + sqrt(1/2) * C, R + sqrt(1/2) * C, SL, SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;

				// It's a bit harder to do this one branchlessly
				if (targetChannelIndex < 2) {
					return sourceData[baseIdx + targetChannelIndex]! + Math.SQRT1_2 * sourceData[baseIdx + 2]!;
				}
				return sourceData[baseIdx + targetChannelIndex + 2]!; // SL, SR
			};
		} else {
			// Discrete fallback: direct mapping with zero-fill or drop
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return targetChannelIndex < sourceNum
					? sourceData[sourceFrameIndex * sourceNum + targetChannelIndex]!
					: 0;
			};
		}
	}

	/** Sets up the windowed-sinc kernel, unless the sample rates match. */
	doKernelSetup(): void {
		assert(this.sourceSampleRate !== null);

		if (this.sourceSampleRate === this.targetSampleRate) {
			this.passThrough = true;
			return;
		}

		// Relative to the source's Nyquist frequency. When downsampling, the cutoff must also stay below the target's
		// Nyquist frequency, as everything above it would alias.
		const cutoff = KERNEL_CUTOFF * Math.min(1, this.targetSampleRate / this.sourceSampleRate);
		this.kernelRadius = KERNEL_ZERO_CROSSINGS / cutoff;

		const tableLength = Math.ceil(this.kernelRadius * KERNEL_TABLE_RESOLUTION) + 2;
		this.kernelTable = new Float32Array(tableLength);

		for (let i = 0; i < tableLength; i++) {
			const t = i / KERNEL_TABLE_RESOLUTION;
			if (t >= this.kernelRadius) {
				break; // Rest stays 0
			}

			const x = Math.PI * cutoff * t;
			const sinc = x === 0 ? 1 : Math.sin(x) / x;
			const u = Math.PI * t / this.kernelRadius;
			const blackmanWindow = 0.42 + 0.5 * Math.cos(u) + 0.08 * Math.cos(2 * u);

			this.kernelTable[i] = cutoff * sinc * blackmanWindow;
		}

		this.weightsStride = Math.ceil(2 * this.kernelRadius) + 1;

		if (Number.isInteger(this.sourceSampleRate) && Number.isInteger(this.targetSampleRate)) {
			const ratio = simplifyRational({ num: this.sourceSampleRate, den: this.targetSampleRate });

			if (ratio.den * this.weightsStride <= MAX_PHASE_TABLE_SIZE) {
				this.phaseCount = ratio.den;
				this.phaseStep = ratio.num;
				this.weights = new Float64Array(this.phaseCount * this.weightsStride);
				this.phaseFirstSourceFrames = new Int32Array(this.phaseCount);
				this.phaseWeightCounts = new Int32Array(this.phaseCount);

				for (let phase = 0; phase < this.phaseCount; phase++) {
					this.phaseFirstSourceFrames[phase] = this.computeWeights(
						phase / this.phaseCount,
						phase * this.weightsStride,
					);
					this.phaseWeightCounts[phase] = this.weightCount;
				}

				return;
			}
		}

		this.weights = new Float64Array(this.weightsStride);
	}

	/** Evaluates the kernel at the given distance from its center, in source frames. */
	kernelAt(distance: number) {
		const index = Math.abs(distance) * KERNEL_TABLE_RESOLUTION;
		const lower = Math.floor(index);
		const lowerValue = this.kernelTable[lower]!;

		return lowerValue + (index - lower) * (this.kernelTable[lower + 1]! - lowerValue);
	}

	ensureTempBufferSizes(frames: number): void {
		assert(this.sourceNumberOfChannels !== null);

		let length = this.tempSourceBuffer.length / this.sourceNumberOfChannels;
		while (length < frames) {
			length *= 2;
		}

		if (length * this.sourceNumberOfChannels !== this.tempSourceBuffer.length) {
			this.tempSourceBuffer = new Float32Array(length * this.sourceNumberOfChannels);
			this.mixedBuffer = new Float32Array(length * this.targetNumberOfChannels);
		}
	}

	async add(audioSample: AudioSample) {
		if (this.sourceSampleRate === null) {
			// This is the first sample, so let's init the missing data. Initing the sample rate from the decoded
			// sample is more reliable than using the file's metadata, because decoders are free to emit any sample rate
			// they see fit.
			this.sourceSampleRate = audioSample.sampleRate;
			this.sourceNumberOfChannels = audioSample.numberOfChannels;
			this.startTime = audioSample.timestamp;

			this.doKernelSetup();

			// An input sample affects the output frames within the kernel's reach, which is why we need padding in the
			// buffer to not lose any data. The padding also makes sure that a buffer is only finalized once no later
			// sample can contribute to it anymore.
			const overflowFrames = Math.ceil(
				(2 * this.kernelRadius + 2) * this.targetSampleRate / this.sourceSampleRate,
			) + 2;
			this.bufferCapacityInFrames = this.bufferSizeInFrames + overflowFrames;
			this.outputBuffer = new Float64Array(
				this.bufferCapacityInFrames * this.targetNumberOfChannels,
			);

			// Pre-allocate temporary buffers for source data
			this.tempSourceBuffer = new Float32Array(this.sourceSampleRate * this.sourceNumberOfChannels);
			this.mixedBuffer = new Float32Array(this.sourceSampleRate * this.targetNumberOfChannels);
			this.lastFrame = new Float32Array(this.targetNumberOfChannels);

			this.doChannelMixerSetup();
		}

		assert(this.startTime !== null);
		assert(this.sourceNumberOfChannels !== null);

		const numberOfFrames = audioSample.numberOfFrames;
		if (numberOfFrames === 0) {
			return;
		}

		this.ensureTempBufferSizes(numberOfFrames);

		// Copy the audio data to the temp buffer
		const sourceDataSize = audioSample.allocationSize({ planeIndex: 0, format: 'f32' });
		const sourceView = new Float32Array(this.tempSourceBuffer.buffer, 0, sourceDataSize / 4);
		audioSample.copyTo(sourceView, { planeIndex: 0, format: 'f32' });

		// Mix the channels first. Mixing is linear and works frame by frame, so it doesn't matter that it happens
		// before the resampling. The mixed data is planar, which makes the resampling loops faster.
		const channels = this.targetNumberOfChannels;
		const mixed = this.mixedBuffer;
		const planeLength = mixed.length / channels;
		for (let channel = 0; channel < channels; channel++) {
			const planeStart = channel * planeLength;
			for (let frame = 0; frame < numberOfFrames; frame++) {
				mixed[planeStart + frame] = this.channelMixer(sourceView, frame, channel);
			}
		}

		// Audio sample is snapped to the input sample rate grid
		const sourceStartFrame = Math.round((audioSample.timestamp - this.startTime) * this.sourceSampleRate);
		const sourceEndFrame = sourceStartFrame + numberOfFrames;

		const isFirstSample = this.firstFrame === null;
		if (isFirstSample) {
			this.firstFrame = new Float32Array(channels);
			for (let channel = 0; channel < channels; channel++) {
				this.firstFrame[channel] = mixed[channel * planeLength]!;
			}
		}
		if (sourceEndFrame >= this.sourceEndFrame) {
			for (let channel = 0; channel < channels; channel++) {
				this.lastFrame[channel] = mixed[channel * planeLength + numberOfFrames - 1]!;
			}
			this.sourceEndFrame = sourceEndFrame;
		}

		const radius = this.kernelRadius;

		// Compute which output frames are affected by this sample. Output frame i sits at source position
		// i * sourceSampleRate / targetSampleRate.
		const outputStartFrame = this.passThrough
			? sourceStartFrame
			: Math.floor((sourceStartFrame - radius) * this.targetSampleRate / this.sourceSampleRate) + 1;
		const outputEndFrame = this.passThrough
			? sourceEndFrame
			: Math.ceil((sourceEndFrame - 1 + radius) * this.targetSampleRate / this.sourceSampleRate);
		// The kernel reaches past the end of the sample, but only the frames before this belong to the audio so far
		const coveredEndFrame = Math.ceil(sourceEndFrame * this.targetSampleRate / this.sourceSampleRate);

		for (let outputFrame = outputStartFrame; outputFrame < outputEndFrame; outputFrame++) {
			if (outputFrame < this.bufferStartFrame) {
				continue; // Skip writes to the past
			}

			while (outputFrame >= this.bufferStartFrame + this.bufferCapacityInFrames) {
				// The write is wholly after the current buffer, so finalize it
				await this.finalizeCurrentBuffer();
				this.bufferStartFrame += this.bufferSizeInFrames;
			}

			const bufferFrameIndex = outputFrame - this.bufferStartFrame;
			assert(bufferFrameIndex < this.bufferCapacityInFrames);
			const outputIndex = bufferFrameIndex * channels;

			if (this.passThrough) {
				const sourceFrame = outputFrame - sourceStartFrame;
				for (let channel = 0; channel < channels; channel++) {
					this.outputBuffer[outputIndex + channel]! += mixed[channel * planeLength + sourceFrame]!;
				}
			} else {
				const firstSourceFrame = this.prepareWeights(outputFrame) - sourceStartFrame;
				const lastSourceFrame = firstSourceFrame + this.weightCount - 1;

				// Add in case of overlapping samples; the frames of other samples within the kernel's reach add their
				// contributions when those samples are added
				this.addContributions(
					outputIndex,
					mixed,
					firstSourceFrame,
					Math.max(firstSourceFrame, 0),
					Math.min(lastSourceFrame, numberOfFrames - 1),
				);

				if (isFirstSample && firstSourceFrame < -sourceStartFrame) {
					// The kernel reaches before the start of the audio, where the first frame counts as repeated
					this.addRepeatedFrameContributions(
						outputIndex,
						this.firstFrame!,
						firstSourceFrame,
						firstSourceFrame,
						-sourceStartFrame - 1,
					);
				}
			}

			if (outputFrame < coveredEndFrame) {
				if (this.maxWrittenFrame === null) {
					this.maxWrittenFrame = bufferFrameIndex;
				} else {
					this.maxWrittenFrame = Math.max(this.maxWrittenFrame, bufferFrameIndex);
				}
			}
		}
	}

	/**
	 * Computes the weights of the source frames within the kernel's reach of the given source position, normalized to
	 * sum up to 1 so that the level is kept exactly, and stores them at the given offset. Returns the index of the
	 * first of these source frames.
	 */
	computeWeights(position: number, offset: number) {
		const first = Math.floor(position - this.kernelRadius) + 1;
		const count = Math.ceil(position + this.kernelRadius) - first;

		let sum = 0;
		for (let i = 0; i < count; i++) {
			const weight = this.kernelAt(position - (first + i));
			this.weights[offset + i] = weight;
			sum += weight;
		}
		for (let i = 0; i < count; i++) {
			this.weights[offset + i]! /= sum;
		}

		this.weightCount = count;
		return first;
	}

	/**
	 * Makes the weights of the source frames within the kernel's reach of the given output frame the current ones.
	 * Returns the index of the first of these source frames.
	 */
	prepareWeights(outputFrame: number) {
		if (this.phaseCount > 0) {
			// Exact integer math
			const numerator = outputFrame * this.phaseStep;
			const sourceFrame = Math.floor(numerator / this.phaseCount);
			const phase = numerator - sourceFrame * this.phaseCount;

			this.weightsOffset = phase * this.weightsStride;
			this.weightCount = this.phaseWeightCounts[phase]!;
			return sourceFrame + this.phaseFirstSourceFrames[phase]!;
		}

		assert(this.sourceSampleRate !== null);

		this.weightsOffset = 0;
		return this.computeWeights(outputFrame * this.sourceSampleRate / this.targetSampleRate, 0);
	}

	/**
	 * Adds the source frames from `from` to `to` (inclusive) of the planar source data to the output frame, using the
	 * current weights, which start at source frame `first`.
	 */
	addContributions(outputIndex: number, source: Float32Array, first: number, from: number, to: number) {
		const channels = this.targetNumberOfChannels;
		const planeLength = source.length / channels;
		const weights = this.weights;
		const offset = this.weightsOffset - first;

		for (let channel = 0; channel < channels; channel++) {
			const sourceOffset = channel * planeLength;

			let sum = 0;
			for (let i = from; i <= to; i++) {
				sum += weights[offset + i]! * source[sourceOffset + i]!;
			}

			this.outputBuffer[outputIndex + channel]! += sum;
		}
	}

	/** Like `addContributions`, but for one frame repeated at the source positions from `from` to `to`. */
	addRepeatedFrameContributions(outputIndex: number, frame: Float32Array, first: number, from: number, to: number) {
		const offset = this.weightsOffset - first;

		let weightSum = 0;
		for (let i = from; i <= to; i++) {
			weightSum += this.weights[offset + i]!;
		}

		for (let channel = 0; channel < this.targetNumberOfChannels; channel++) {
			this.outputBuffer[outputIndex + channel]! += weightSum * frame[channel]!;
		}
	}

	async finalizeCurrentBuffer() {
		if (this.maxWrittenFrame === null) {
			return; // Nothing to finalize
		}

		assert(this.startTime !== null);

		const samplesWritten = Math.min(this.maxWrittenFrame + 1, this.bufferSizeInFrames)
			* this.targetNumberOfChannels;

		const outputData = new Float32Array(samplesWritten);
		outputData.set(this.outputBuffer.subarray(0, samplesWritten));

		const audioSample = new AudioSample({
			format: 'f32',
			sampleRate: this.targetSampleRate,
			numberOfChannels: this.targetNumberOfChannels,
			timestamp: this.startTime + this.bufferStartFrame / this.targetSampleRate,
			data: outputData,
		});

		await this.onSample(audioSample);

		this.outputBuffer.copyWithin(0, this.bufferSizeInSamples);
		this.outputBuffer.fill(0, this.outputBuffer.length - this.bufferSizeInSamples);
		this.maxWrittenFrame = this.maxWrittenFrame >= this.bufferSizeInFrames
			? this.maxWrittenFrame - this.bufferSizeInFrames
			: null;
	}

	async finalize() {
		if (this.maxWrittenFrame !== null && !this.passThrough) {
			assert(this.sourceSampleRate !== null);

			// The kernel reaches past the end of the audio, where the last frame counts as repeated
			const end = this.sourceEndFrame;
			const firstAffectedFrame = Math.max(
				Math.floor((end - this.kernelRadius) * this.targetSampleRate / this.sourceSampleRate) + 1,
				this.bufferStartFrame,
			);
			const coveredEndFrame = Math.ceil(end * this.targetSampleRate / this.sourceSampleRate);

			for (let outputFrame = firstAffectedFrame; outputFrame < coveredEndFrame; outputFrame++) {
				const firstSourceFrame = this.prepareWeights(outputFrame);

				this.addRepeatedFrameContributions(
					(outputFrame - this.bufferStartFrame) * this.targetNumberOfChannels,
					this.lastFrame,
					firstSourceFrame,
					end,
					firstSourceFrame + this.weightCount - 1,
				);
			}
		}

		while (this.maxWrittenFrame !== null) {
			await this.finalizeCurrentBuffer();
			this.bufferStartFrame += this.bufferSizeInFrames;
		}
	}
}
