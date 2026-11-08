/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	AudioCodec,
	AudioSample,
	CustomAudioEncoder,
	type MaybePromise,
	Quality,
	EncodedPacket,
} from 'mediabunny';
import * as NodeAv from 'node-av';
import { CODEC_TO_CODEC_ID, getChannelLayout, getDtsChannelLayout, getTrueHdChannelLayout } from './misc';
import { assert, toUint8Array } from '../../../src/misc';
import { determineAudioPacketType } from '../../../src/codec-data';
import { copyAudioSampleToAvFrame, AvFrameAudioSampleResource } from './audio-sample';
import {
	AdtsHeaderTemplate,
	buildAdtsHeaderTemplate,
	parseAacAudioSpecificConfig,
} from '../../../shared/aac-misc';
import { DTS_CHANNEL_COUNTS, DTS_SAMPLE_RATES, dtsBitrateFits } from '../../../shared/dts-misc';
import { TRUEHD_CHANNEL_COUNTS, TRUEHD_SAMPLE_RATES } from '../../../shared/truehd-misc';

const AAC_SAMPLE_RATES
	= [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const OPUS_SAMPLE_RATES = [8000, 12000, 16000, 24000, 48000];
const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const AC3_SAMPLE_RATES = [32000, 44100, 48000];

const FRAME_SIZE_FALLBACK = 1024; // Just 'cause

export class NodeAvAudioEncoder extends CustomAudioEncoder {
	frame!: NodeAv.Frame;
	packet!: NodeAv.Packet;
	codecContext: NodeAv.CodecContext | null = null;
	resampler: NodeAv.SoftwareResampleContext | null = null;
	dstFrame: NodeAv.Frame | null = null;
	avCodec!: NodeAv.Codec;

	inputParametersKey: string | null = null;
	inputSampleFormat: AudioSampleFormat | null = null;
	resamplerInputSampleRate: number | null = null;
	nextResamplerPts: bigint | null = null;
	inputEndPts: bigint | null = null;
	flacBitsPerSample: 16 | 24 = 16;
	packetEmitted = false;
	adtsHeaderTemplate: AdtsHeaderTemplate | null = null;

	static override supports(codec: AudioCodec, config: AudioEncoderConfig): boolean {
		const { numberOfChannels, sampleRate } = config;

		return (
			codec === 'aac' && numberOfChannels >= 1 && numberOfChannels <= 48
			&& AAC_SAMPLE_RATES.includes(sampleRate)
		) || (
			// Other rates are resampled to 48 kHz, as WebCodecs encoders do
			codec === 'opus' && numberOfChannels >= 1 && numberOfChannels <= 255
			&& sampleRate >= 8000 && sampleRate <= 192000
		) || (
			codec === 'mp3' && numberOfChannels >= 1 && numberOfChannels <= 2
			&& MP3_SAMPLE_RATES.includes(sampleRate)
		) || (
			// NodeAV's resampler only passes on up to 8 planes, silencing any channel past that
			codec === 'vorbis' && numberOfChannels >= 1 && numberOfChannels <= 8
			&& sampleRate <= 200000
		) || (
			codec === 'flac' && numberOfChannels >= 1 && numberOfChannels <= 8
			&& sampleRate <= 655350
		) || (
			codec === 'ac3' && numberOfChannels >= 1 && numberOfChannels <= 6
			&& AC3_SAMPLE_RATES.includes(sampleRate)
		) || (
			codec === 'eac3' && numberOfChannels >= 1 && numberOfChannels <= 16
			&& AC3_SAMPLE_RATES.includes(sampleRate)
		) || (
			codec === 'dts' && DTS_CHANNEL_COUNTS.includes(numberOfChannels)
			&& DTS_SAMPLE_RATES.includes(sampleRate)
			&& dtsBitrateFits(resolveBitrate(config, codec), sampleRate, numberOfChannels)
		) || (
			codec === 'truehd' && TRUEHD_CHANNEL_COUNTS.includes(numberOfChannels)
			&& TRUEHD_SAMPLE_RATES.includes(sampleRate)
		);
	}

	async init(): Promise<void> {
		this.frame = new NodeAv.Frame();
		this.frame.alloc();
		this.packet = new NodeAv.Packet();
		this.packet.alloc();

		const codecId = CODEC_TO_CODEC_ID[this.codec];
		assert(codecId !== undefined);

		const codec = NodeAv.Codec.findEncoder(codecId);
		if (!codec) {
			throw new Error(`Unable to obtain libav codec for '${this.codec}'.`);
		}

		this.avCodec = codec;

		if (this.codec !== 'flac') {
			// FLAC's bit depth follows the first sample, so its context is created then
			await this.createCodecContext();
		}
	}

	async createCodecContext() {
		assert(this.codecContext === null);

		const codecContext = new NodeAv.CodecContext();
		codecContext.allocContext3(this.avCodec);

		let sampleFormat = NodeAv.AV_SAMPLE_FMT_FLTP;
		if (this.codec === 'truehd') {
			// The first listed format is 16-bit, which would needlessly truncate what's supposed to be lossless
			sampleFormat = NodeAv.AV_SAMPLE_FMT_S32P;
		} else if (this.codec === 'flac') {
			// Like @mediabunny/flac-encoder: 16-bit for 8- and 16-bit input, 24-bit otherwise
			sampleFormat = this.flacBitsPerSample === 24 ? NodeAv.AV_SAMPLE_FMT_S32 : NodeAv.AV_SAMPLE_FMT_S16;
			if (this.flacBitsPerSample === 24) {
				codecContext.bitsPerRawSample = 24;
			}
		} else if (this.avCodec.sampleFormats && !this.avCodec.sampleFormats.includes(NodeAv.AV_SAMPLE_FMT_FLTP)) {
			// Use a format that's supported
			sampleFormat = this.avCodec.sampleFormats[0]!;
		}

		// libopus only takes a few rates, and others are resampled to 48 kHz
		const encoderSampleRate = this.codec === 'opus' && !OPUS_SAMPLE_RATES.includes(this.config.sampleRate)
			? 48000
			: this.config.sampleRate;

		codecContext.sampleRate = encoderSampleRate;
		if (this.codec === 'dts') {
			codecContext.channelLayout = getDtsChannelLayout(this.config.numberOfChannels);
		} else if (this.codec === 'truehd') {
			codecContext.channelLayout = getTrueHdChannelLayout(this.config.numberOfChannels);
		} else {
			codecContext.channelLayout = getChannelLayout(this.config.numberOfChannels);
		}
		codecContext.codecType = NodeAv.AVMEDIA_TYPE_AUDIO;
		codecContext.codecId = CODEC_TO_CODEC_ID[this.codec]!;
		codecContext.sampleFormat = sampleFormat;
		codecContext.timeBase = new NodeAv.Rational(1, encoderSampleRate);
		codecContext.bitRate = BigInt(resolveBitrate(this.config, this.codec));

		if (this.config.bitrateMode === 'constant') {
			codecContext.rcMinRate = codecContext.bitRate;
			codecContext.rcMaxRate = codecContext.bitRate;

			if (this.avCodec.name === 'libopus') {
				// libopus doesn't look at the rate limits, only at its own VBR switch
				codecContext.setOption('vbr', 'off');
			}
		}

		const channels = this.config.numberOfChannels;
		if (this.avCodec.name === 'libopus' && channels >= 3 && channels <= 8) {
			// FFmpeg's default surround path codes 5- and 7-channel audio with a different channel mapping than it
			// writes into the header, moving the center to a rear channel. Mapping family 1 reorders the channels to
			// Vorbis order and lets libopus pick the mapping it writes.
			codecContext.setOption('mapping_family', '1');
		}

		// libav's DTS and TrueHD encoders are marked experimental, so they refuse to open at the default compliance
		// level
		const options = this.codec === 'dts' || this.codec === 'truehd'
			? NodeAv.Dictionary.fromObject({ strict: -2 })
			: null;

		const ret = await codecContext.open2(this.avCodec, options);
		NodeAv.FFmpegError.throwIfError(ret, 'Open codec context');

		this.codecContext = codecContext;
	}

	async encode(audioSample: AudioSample): Promise<void> {
		if (this.codecContext === null) {
			if (this.codec === 'flac') {
				const format = audioSample.format;
				this.flacBitsPerSample = format.startsWith('u8') || format.startsWith('s16') ? 16 : 24;
			}

			await this.createCodecContext();
			assert(this.codecContext);
		}

		// The resampler is set up for the first sample's format, so later samples are converted to it. Unlike the
		// sample rate and channel count, the format may change from one sample to the next.
		const sampleFormat = this.inputSampleFormat ?? audioSample.format;
		if (audioSample._data instanceof AvFrameAudioSampleResource && audioSample.format === sampleFormat) {
			// Release any buffers still referenced from the previous encode before reffing the new frame, otherwise
			// av_frame_ref leaks them
			// https://github.com/Vanilagy/mediabunny/issues/392
			this.frame.unref();
			this.frame.ref(audioSample._data.frame);
		} else {
			copyAudioSampleToAvFrame(audioSample, this.frame, sampleFormat);
		}
		this.inputSampleFormat = sampleFormat;

		if (this.codec === 'aac') {
			replaceNonFiniteSamples(this.frame);
		}

		this.frame.pts = BigInt(Math.round(audioSample.timestamp * this.config.sampleRate));
		this.frame.duration = BigInt(Math.round(audioSample.duration * this.config.sampleRate));
		this.frame.timeBase = new NodeAv.Rational(1, this.config.sampleRate);

		const key = `${this.frame.sampleRate}:${this.frame.channels}:${this.frame.format}`;
		if (this.inputParametersKey !== null && this.inputParametersKey !== key) {
			throw new Error(
				'Input audio parameters changed. For this audio encoder, you cannot change the input audio'
				+ ' parameters over time.',
			);
		}
		this.inputParametersKey = key;

		// We need the resampler when:
		// 1. Format conversion is needed (sample format, sample rate, or channel count differs)
		// 2. The codec requires fixed frame sizes
		const requiresResampler
			= this.codecContext.frameSize > 0
				|| this.codecContext.sampleFormat !== this.frame.format
				|| this.codecContext.sampleRate !== this.frame.sampleRate
				|| this.codecContext.channels !== this.frame.channels;

		if (requiresResampler) {
			if (!this.resampler) {
				this.resampler = new NodeAv.SoftwareResampleContext();
				this.resamplerInputSampleRate = this.frame.sampleRate;

				// Resample straight to whatever layout the encoder was opened with, since not every codec accepts
				// the layout that getChannelLayout hands out for a given channel count
				const outLayout = this.codecContext.channelLayout;
				const inLayout = getChannelLayout(this.frame.channels);

				const ret = this.resampler.allocSetOpts2(
					outLayout, this.codecContext.sampleFormat, this.codecContext.sampleRate,
					inLayout, this.frame.format as NodeAv.AVSampleFormat, this.frame.sampleRate,
				);
				NodeAv.FFmpegError.throwIfError(ret, 'allocSetOpts2');

				const ret2 = this.resampler.init();
				NodeAv.FFmpegError.throwIfError(ret2, 'init');

				this.dstFrame = new NodeAv.Frame();
				this.dstFrame.alloc();
				this.dstFrame.channelLayout = outLayout;
				this.dstFrame.sampleRate = this.codecContext.sampleRate;
				this.dstFrame.format = this.codecContext.sampleFormat;
				this.dstFrame.nbSamples = this.codecContext.frameSize || FRAME_SIZE_FALLBACK;
				this.dstFrame.duration = BigInt(this.dstFrame.nbSamples);
				this.dstFrame.allocBuffer();

				// In the encoder's sample rate, which can differ from the input's
				this.nextResamplerPts = BigInt(Math.round(audioSample.timestamp * this.codecContext.sampleRate));
			}

			const inputBuffers = this.frame.data;
			if (!inputBuffers) {
				throw new DOMException('Frame has no data', 'EncodingError');
			}
			await this.resampler.convert(null, 0, inputBuffers, this.frame.nbSamples);

			await this.pullResampledFrames();
		} else {
			await this.sendFrameAndReceivePackets(this.frame);
		}
	}

	async pullResampledFrames() {
		assert(this.codecContext);
		assert(this.resampler);
		assert(this.dstFrame);
		assert(this.nextResamplerPts !== null);

		const frameSize = this.codecContext.frameSize || FRAME_SIZE_FALLBACK;

		while (true) {
			const available = this.resampler.getOutSamples(0);
			if (available < frameSize) {
				break;
			}

			await this.resampler.convert(this.dstFrame.data, frameSize, null, 0);

			this.dstFrame.pts = this.nextResamplerPts;

			await this.sendFrameAndReceivePackets(this.dstFrame);
			this.nextResamplerPts += BigInt(frameSize);
		}
	}

	async sendFrameAndReceivePackets(frame: NodeAv.Frame | null) {
		assert(this.codecContext);

		const ret = await this.codecContext.sendFrame(frame);
		NodeAv.FFmpegError.throwIfError(ret, 'Send frame');

		while (true) {
			const receiveRet = await this.codecContext.receivePacket(this.packet);
			if (receiveRet === NodeAv.AVERROR_EAGAIN || receiveRet === NodeAv.AVERROR_EOF) {
				break;
			}

			this.receivePacket(receiveRet);
		}
	}

	receivePacket(ret: number) {
		assert(this.codecContext);
		NodeAv.FFmpegError.throwIfError(ret, 'Receive packet');

		if (!this.packet.data) {
			return;
		}

		let durationInSamples = Number(this.packet.duration);
		if (this.inputEndPts !== null) {
			// Leave out the silence that filled up the last frame
			const samplesInInput = Number(this.inputEndPts - this.packet.pts);
			if (samplesInInput <= 0) {
				return;
			}

			durationInSamples = Math.min(durationInSamples, samplesInInput);
		}

		const timestamp = Number(this.packet.pts) / this.codecContext.sampleRate;
		const duration = durationInSamples / this.codecContext.sampleRate;

		let data: Uint8Array = this.packet.data;

		let metadata: EncodedAudioChunkMetadata | undefined;
		if (this.packetEmitted) {
			metadata = {};
		} else {
			let codecString = this.config.codec;
			let description = this.codecContext.extraData
				? toUint8Array(this.codecContext.extraData)
				: undefined;

			if (this.codec === 'aac') {
				if (!description) {
					throw new Error('Extradata expected for AAC.');
				}

				// The configured codec string guesses HE-AAC at low sample rates, but FFmpeg's encoder only makes
				// AAC-LC, so take the object type from what it actually produced
				codecString = `mp4a.40.${parseAacAudioSpecificConfig(description).objectType}`;

				// eslint-disable-next-line @stylistic/max-len
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
				const isAdts = (this.config as any).aac?.format === 'adts';

				if (isAdts) {
					const parsedConfig = parseAacAudioSpecificConfig(description);
					this.adtsHeaderTemplate = buildAdtsHeaderTemplate(parsedConfig);
					description = undefined; // Not used with 'adts' format
				}
			} else if (this.codec === 'opus') {
				if (!description) {
					// Technically not required by the WebCodecs/Mediabunny Codec Registry, but we strive to be better
					throw new Error('Extradata expected for Opus.');
				}
			} else if (this.codec === 'vorbis') {
				if (!description) {
					throw new Error('Extradata expected for Vorbis.');
				}
			} else if (this.codec === 'flac') {
				if (!description) {
					throw new Error('Extradata expected for FLAC.');
				}

				// FFmpeg uses the STREAMINFO block as the extradata, but WebCodecs wants a different format:
				// 1. The bytes 0x66 0x4C 0x61 0x43 ("fLaC" in ASCII)
				// 2. A metadata block (called the STREAMINFO block) as described in section 7 of [FLAC]
				// 3. Other optional metadata blocks (not included here, because, well, they're optional)
				description = new Uint8Array([
					0x66, 0x4c, 0x61, 0x43, // 'fLaC'
					128, 0, 0, description.byteLength,
					...description,
				]);
			}

			metadata = {
				decoderConfig: {
					codec: codecString,
					sampleRate: this.codecContext.sampleRate,
					numberOfChannels: this.codecContext.channels,
					description,
				},
			};
		}

		if (this.adtsHeaderTemplate) {
			const frameLength = data.byteLength + this.adtsHeaderTemplate.header.byteLength;
			this.adtsHeaderTemplate.bitstream.pos = 30;
			this.adtsHeaderTemplate.bitstream.writeBits(13, frameLength);

			const final = new Uint8Array(this.adtsHeaderTemplate.header.byteLength + data.byteLength);
			final.set(this.adtsHeaderTemplate.header, 0);
			final.set(data, this.adtsHeaderTemplate.header.byteLength);

			data = final;
		}

		const packet = new EncodedPacket(
			data,
			determineAudioPacketType(this.codec, data),
			timestamp,
			duration,
		);

		this.packetEmitted = true;
		this.onPacket(packet, metadata);
	}

	async flush(): Promise<void> {
		if (!this.codecContext) {
			return;
		}

		outer:
		if (this.resampler) {
			assert(this.resamplerInputSampleRate !== null);
			assert(this.dstFrame);
			assert(this.nextResamplerPts !== null);

			const currentOutSamples = this.resampler.getOutSamples(0);
			if (currentOutSamples === 0) {
				break outer; // Clean cut-off point
			}

			const frameSize = this.codecContext.frameSize || FRAME_SIZE_FALLBACK;
			assert(currentOutSamples < frameSize); // Because if it's more, it would've already been retrieved

			// Silence filling up the last frame would become part of the decoded audio, so the encoder gets a
			// shorter last frame instead. Unless the whole track is one frame of fewer than 16 samples: FLAC doesn't
			// allow blocks that short (RFC 9639, section 8.2), and FFmpeg rejects such a stream.
			const isLossless = this.codec === 'flac' || this.codec === 'truehd';
			if (
				isLossless
				&& this.avCodec.capabilities & NodeAv.AV_CODEC_CAP_SMALL_LAST_FRAME
				&& (this.packetEmitted || currentOutSamples >= 16)
			) {
				while (true) {
					const samples = await this.resampler.convert(this.dstFrame.data, frameSize, null, 0);
					NodeAv.FFmpegError.throwIfError(samples, 'convert');
					if (samples === 0) {
						break;
					}

					this.dstFrame.nbSamples = samples;
					this.dstFrame.duration = BigInt(samples);
					this.dstFrame.pts = this.nextResamplerPts;

					await this.sendFrameAndReceivePackets(this.dstFrame);
					this.nextResamplerPts += BigInt(samples);

					if (samples < frameSize) {
						break;
					}
				}

				break outer;
			}

			// The silence that fills up the last frame isn't part of the audio, so the packets must end where the
			// input does. Except when no packet has come out yet: such a short track could end up as one shortened
			// packet, whose audio FFmpeg misplaces in MP4.
			if (this.packetEmitted) {
				this.inputEndPts = this.nextResamplerPts + BigInt(currentOutSamples);
			}

			const inputSamplesNeeded = Math.ceil(
				((frameSize - currentOutSamples) / this.codecContext.sampleRate) * this.resamplerInputSampleRate,
			);
			this.resampler.injectSilence(inputSamplesNeeded);

			await this.pullResampledFrames();
		}

		await this.sendFrameAndReceivePackets(null);

		this.codecContext.freeContext();
		this.codecContext = null;
		this.inputEndPts = null;
		this.packetEmitted = false;
		this.adtsHeaderTemplate = null;

		this.resampler?.free();
		this.resampler = null;
		this.inputParametersKey = null;
		this.inputSampleFormat = null;
		this.resamplerInputSampleRate = null;
		this.nextResamplerPts = null;
		this.dstFrame?.free();
		this.dstFrame = null;
	}

	close(): MaybePromise<void> {
		this.codecContext?.freeContext();
		this.frame.free();
		this.packet.free();
		this.dstFrame?.free();
		this.resampler?.free();
	}
}

/**
 * libav's AAC encoder rejects a whole frame if it holds a NaN or infinite sample, so this maps those like the
 * conversion to integer samples does: NaN to silence, infinities to full scale.
 */
const replaceNonFiniteSamples = (frame: NodeAv.Frame) => {
	const planar = frame.format === NodeAv.AV_SAMPLE_FMT_FLTP;
	if (!planar && frame.format !== NodeAv.AV_SAMPLE_FMT_FLT) {
		return;
	}

	const valuesPerPlane = planar ? frame.nbSamples : frame.nbSamples * frame.channels;
	const forEachValue = (callback: (view: DataView, offset: number, value: number) => void) => {
		for (const plane of frame.data ?? []) {
			const view = new DataView(plane.buffer, plane.byteOffset, plane.byteLength);
			for (let i = 0; i < valuesPerPlane; i++) {
				callback(view, 4 * i, view.getFloat32(4 * i, true));
			}
		}
	};

	let found = false;
	forEachValue((view, offset, value) => {
		found ||= !Number.isFinite(value);
	});
	if (!found) {
		return;
	}

	// The data may be shared with the decoded frame it was reffed from
	NodeAv.FFmpegError.throwIfError(frame.makeWritable(), 'makeWritable');
	forEachValue((view, offset, value) => {
		if (!Number.isFinite(value)) {
			view.setFloat32(offset, Number.isNaN(value) ? 0 : Math.sign(value), true);
		}
	});
};

const resolveBitrate = (config: AudioEncoderConfig, codec: AudioCodec) => {
	return config.bitrate ?? new Quality('medium')._toAudioBitrate(codec) ?? 0;
};
