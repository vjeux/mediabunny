/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	CustomAudioEncoder,
	AudioCodec,
	AudioSample,
	EncodedPacket,
	registerEncoder,
} from 'mediabunny';
import { sendCommand, refWorker, unrefWorker } from './worker-client';
import { assert } from './shared';
import { AC3_SAMPLE_RATES } from '../../../shared/ac3-misc';

// The valid AC-3 bitrates
const AC3_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640]
	.map(kbps => kbps * 1000);

// FFmpeg's AC-3 encoder rounds the requested bitrate to the closest valid one, the lower one on a tie
const roundToAc3Bitrate = (bitrate: number) => {
	return AC3_BITRATES.reduce((closest, x) => Math.abs(x - bitrate) < Math.abs(closest - bitrate) ? x : closest);
};

/**
 * The lowest bitrate at which FFmpeg's bit allocation fits real content (sine tones and music, measured with this
 * extension's encoder) and every higher one does too, by codec, sample rate and channel count (the index, up to 6).
 * Below it, the encode fails with "Bit allocation failed" for such content. 0 means no failure down to the lowest
 * bitrate measured.
 */
const MIN_BITRATES: Record<'ac3' | 'eac3', Record<number, number[]>> = {
	ac3: {
		32000: [0, 0, 0, 0, 40000, 48000, 48000],
		44100: [0, 0, 0, 0, 56000, 64000, 64000],
		48000: [0, 0, 40000, 40000, 56000, 80000, 80000],
	},
	eac3: {
		32000: [0, 0, 0, 0, 40000, 48000, 48000],
		44100: [0, 0, 32000, 32000, 56000, 64000, 64000],
		48000: [0, 0, 32000, 40000, 56000, 72000, 72000],
	},
};

class Ac3Encoder extends CustomAudioEncoder {
	private ctx = 0;
	private encoderFrameSize = 0;
	private sampleRate = 0;
	private numberOfChannels = 0;
	private chunkMetadata: EncodedAudioChunkMetadata = {};

	// Accumulate interleaved f32 samples until we have a full frame
	private pendingBuffer = new Float32Array(2 ** 16);
	private pendingFrames = 0;
	private nextSampleTimestampInSamples: number | null = null;
	private packetCount = 0;

	static override supports(codec: AudioCodec, config: AudioEncoderConfig): boolean {
		// FFmpeg's encoders top out at 5.1 and can't do E-AC-3's reduced sample rates
		if (
			(codec !== 'ac3' && codec !== 'eac3')
			|| config.numberOfChannels < 1
			|| config.numberOfChannels > 6
			|| !AC3_SAMPLE_RATES.includes(config.sampleRate)
			|| config.bitrate === undefined
		) {
			return false;
		}

		// E-AC-3 takes the requested bitrate as it is
		const bitrate = codec === 'ac3' ? roundToAc3Bitrate(config.bitrate) : config.bitrate;
		return bitrate >= (MIN_BITRATES[codec][config.sampleRate]?.[config.numberOfChannels] ?? 0);
	}

	async init() {
		await refWorker();

		assert(this.config.bitrate !== undefined);
		this.sampleRate = this.config.sampleRate;
		this.numberOfChannels = this.config.numberOfChannels;

		const result = await sendCommand({
			type: 'init-encoder',
			data: {
				codec: this.codec,
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
				bitrate: this.config.bitrate,
			},
		});

		this.ctx = result.ctx;
		this.encoderFrameSize = result.frameSize;

		this.resetInternalState();
	}

	private resetInternalState() {
		this.pendingFrames = 0;
		this.nextSampleTimestampInSamples = null;
		this.packetCount = 0;

		this.chunkMetadata = {
			decoderConfig: {
				codec: this.codec === 'ac3' ? 'ac-3' : 'ec-3',
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
			},
		};
	}

	async encode(audioSample: AudioSample) {
		if (this.nextSampleTimestampInSamples === null) {
			this.nextSampleTimestampInSamples = Math.round(audioSample.timestamp * this.sampleRate);
		}

		const channels = this.numberOfChannels;
		const incomingFrames = audioSample.numberOfFrames;

		// Extract interleaved f32 data
		const totalBytes = audioSample.allocationSize({ format: 'f32', planeIndex: 0 });
		const audioBytes = new Uint8Array(totalBytes);
		audioSample.copyTo(audioBytes, { format: 'f32', planeIndex: 0 });
		const incomingData = new Float32Array(audioBytes.buffer);

		// A NaN or infinite sample makes FFmpeg's encoder silence the blocks around it in that channel, so map those
		// like the conversion to integer samples does: NaN to silence, infinities to full scale
		for (let i = 0; i < incomingData.length; i++) {
			const value = incomingData[i]!;
			if (!Number.isFinite(value)) {
				incomingData[i] = Number.isNaN(value) ? 0 : Math.sign(value);
			}
		}

		const requiredSamples = (this.pendingFrames + incomingFrames) * channels;
		if (requiredSamples > this.pendingBuffer.length) {
			let newSize = this.pendingBuffer.length;
			while (newSize < requiredSamples) {
				newSize *= 2;
			}
			const newBuffer = new Float32Array(newSize);
			newBuffer.set(this.pendingBuffer.subarray(0, this.pendingFrames * channels));
			this.pendingBuffer = newBuffer;
		}
		this.pendingBuffer.set(incomingData, this.pendingFrames * channels);
		this.pendingFrames += incomingFrames;

		while (this.pendingFrames >= this.encoderFrameSize) {
			await this.encodeOneFrame();
		}
	}

	async flush() {
		// Pad remaining samples with silence to fill a full frame
		if (this.pendingFrames > 0) {
			assert(this.nextSampleTimestampInSamples !== null);

			const channels = this.numberOfChannels;
			const frameSize = this.encoderFrameSize;
			const usedSamples = this.pendingFrames * channels;
			const frameSamples = frameSize * channels;

			// The padding isn't part of the audio, so the last packet must end where the input does. Except when it's
			// the only packet: FFmpeg misplaces the audio of an MP4 track that is one shortened packet.
			const inputEndInSamples = this.packetCount > 0
				? this.nextSampleTimestampInSamples + this.pendingFrames
				: undefined;

			this.pendingBuffer.fill(0, usedSamples, frameSamples);
			this.pendingFrames = frameSize;

			await this.encodeOneFrame(inputEndInSamples);
		}

		await sendCommand({ type: 'flush-encoder', data: { ctx: this.ctx } });

		this.resetInternalState();
	}

	close() {
		// Close shouldn't throw
		sendCommand({ type: 'close-encoder', data: { ctx: this.ctx } }).catch(() => {});
		void unrefWorker();
	}

	private async encodeOneFrame(inputEndInSamples?: number) {
		assert(this.nextSampleTimestampInSamples !== null);

		const channels = this.numberOfChannels;
		const frameSize = this.encoderFrameSize;
		const frameSamples = frameSize * channels;

		const frameData = this.pendingBuffer.slice(0, frameSamples);

		// Shift remaining using copyWithin
		this.pendingFrames -= frameSize;
		if (this.pendingFrames > 0) {
			this.pendingBuffer.copyWithin(0, frameSamples, frameSamples + this.pendingFrames * channels);
		}

		const audioData = frameData.buffer;
		const result = await sendCommand({
			type: 'encode',
			data: {
				ctx: this.ctx,
				audioData,
				timestamp: this.nextSampleTimestampInSamples,
			},
		}, [audioData]);

		this.nextSampleTimestampInSamples += frameSize;
		this.packetCount++;

		let duration = result.duration;
		if (inputEndInSamples !== undefined) {
			duration = Math.min(duration, inputEndInSamples - result.pts);
		}

		// We always get exactly one packet because we encode the correct frame size
		const packet = new EncodedPacket(
			new Uint8Array(result.encodedData),
			'key',
			result.pts / this.sampleRate,
			duration / this.sampleRate,
		);

		this.onPacket(
			packet,
			this.chunkMetadata,
		);

		this.chunkMetadata = {};
	}
}

let registered = false;

/**
 * Registers AC-3 and E-AC-3 encoders, which Mediabunny will then use automatically when applicable. Make sure to call
 * this function before starting any encoding task.
 *
 * @group \@mediabunny/ac3
 * @public
 */
export const registerAc3Encoder = () => {
	if (registered) {
		return;
	}
	registered = true;

	registerEncoder(Ac3Encoder);
};
