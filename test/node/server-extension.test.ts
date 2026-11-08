import { beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import { registerMediabunnyServer } from '@mediabunny/server';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert, last, toUint8Array } from '../../src/misc.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { NodeAvVideoDecoder } from '../../packages/server/src/video-decoder.js';
import { getAlphaPixelFormat, NodeAvVideoEncoder } from '../../packages/server/src/video-encoder.js';
import { NodeAvAudioDecoder } from '../../packages/server/src/audio-decoder.js';
import { NodeAvAudioEncoder } from '../../packages/server/src/audio-encoder.js';
import { AudioSample, VideoSample, VideoSampleColorSpace } from '../../src/sample.js';
import {
	AudioCodec,
	buildAudioCodecString,
	buildVideoCodecString,
	NON_PCM_AUDIO_CODECS,
	PRORES_FOURCCS,
	VideoCodec,
} from '../../src/codec.js';
import { EncodedPacket } from '../../src/packet.js';
import {
	AvcNalUnitType,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	HevcNalUnitType,
	iterateNalUnitsInAnnexB,
	iterateNalUnitsInLengthPrefixed,
} from '../../src/codec-data.js';
import { Output } from '../../src/output.js';
import { FlacOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { AudioSampleSource, VideoSampleSource } from '../../src/media-source.js';
import { buildQuantizerEncodeOptions, Quality } from '../../src/encode.js';
import { AvFrameVideoSampleResource } from '../../packages/server/src/video-sample.js';
import { AvFrameAudioSampleResource } from '../../packages/server/src/audio-sample.js';
import { _serverOptions, toAvFrame } from '../../packages/server/src/index.js';
import * as NodeAv from 'node-av';
import os from 'node:os';
import { createHash } from 'node:crypto';

beforeAll(() => {
	registerMediabunnyServer();
});

describe('Video', async () => {
	test('Decoder lifecycle', async () => {
		using input = new Input({
			source: new FilePathSource('./test/public/video.mp4'),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		const decoder = new NodeAvVideoDecoder();
		// @ts-expect-error Readonly
		decoder.codec = await videoTrack.getCodec();
		// @ts-expect-error Readonly
		decoder.config = await videoTrack.getDecoderConfig();

		let sampleCount = 0;
		const packetTimestamps: number[] = [];

		// @ts-expect-error Readonly
		decoder.onSample = (sample: VideoSample) => {
			expect(sample.timestamp).toBe(packetTimestamps[sampleCount]);
			expect(sample.duration).toBe(1 / 25);

			sampleCount++;
			sample.close();
		};

		await decoder.init();

		const sink = new EncodedPacketSink(videoTrack);
		let packetCount = 0;
		for await (const packet of sink.packets()) {
			packetTimestamps.push(packet.timestamp);
			packetTimestamps.sort((a, b) => a - b); // Because of B-frames
			await decoder.decode(packet);

			if (++packetCount === 10) {
				break;
			}
		}

		await decoder.flush();

		expect(sampleCount).toBe(10);

		// And, go again
		sampleCount = 0;
		packetTimestamps.length = 0;

		packetCount = 0;
		for await (const packet of sink.packets((await sink.getKeyPacket(2))!)) {
			packetTimestamps.push(packet.timestamp);
			packetTimestamps.sort((a, b) => a - b); // Because of B-frames
			await decoder.decode(packet);

			if (++packetCount === 10) {
				break;
			}
		}

		await decoder.flush();

		expect(sampleCount).toBe(10);

		await decoder.close();
	});

	test('Encoder lifecycle', async () => {
		const encoder = new NodeAvVideoEncoder();
		// @ts-expect-error Readonly
		encoder.codec = 'avc';
		// @ts-expect-error Readonly
		encoder.config = {
			codec: buildVideoCodecString('avc', 1280, 720, 1e6, false),
			width: 1280,
			height: 720,
			bitrate: 1e6,
		} satisfies VideoEncoderConfig;

		const encodedPackets: EncodedPacket[] = [];
		const sampleTimestamps: number[] = [];

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket, meta: EncodedVideoChunkMetadata) => {
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(encodedPackets.length ? 'delta' : 'key');

			if (encodedPackets.length === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('avc1.')).toBe(true);
				expect(meta.decoderConfig!.codedWidth).toBe(1280);
				expect(meta.decoderConfig!.codedHeight).toBe(720);
				expect(meta.decoderConfig!.description).toBeDefined();
			}

			encodedPackets.push(packet);
		};

		await encoder.init();

		const data = new Uint8Array(1280 * 720 * 4).fill(0xff); // White
		for (let i = 0; i < 10; i++) {
			using sample = new VideoSample(data, {
				format: 'RGBX',
				codedWidth: 1280,
				codedHeight: 720,
				timestamp: i / 30,
				duration: 1 / 30,
			});

			sampleTimestamps.push(sample.timestamp);

			await encoder.encode(sample, {});
		}

		await encoder.flush();

		expect(encodedPackets).toHaveLength(10);

		let sortedTimestamps = encodedPackets.map(x => x.timestamp).sort((a, b) => a - b);
		expect(sortedTimestamps).toEqual(sampleTimestamps);

		// And, go again
		encodedPackets.length = 0;
		sampleTimestamps.length = 0;

		for (let i = 0; i < 10; i++) {
			using sample = new VideoSample(data, {
				format: 'RGBX',
				codedWidth: 1280,
				codedHeight: 720,
				timestamp: i / 30,
				duration: 1 / 30,
			});

			sampleTimestamps.push(sample.timestamp);

			await encoder.encode(sample, {});
		}

		await encoder.flush();

		expect(encodedPackets).toHaveLength(10);

		sortedTimestamps = encodedPackets.map(x => x.timestamp).sort((a, b) => a - b);
		expect(sortedTimestamps).toEqual(sampleTimestamps);

		await encoder.close();
	});

	test('Forced key frame encode', async () => {
		const encoder = new NodeAvVideoEncoder();
		// @ts-expect-error Readonly
		encoder.codec = 'avc';
		// @ts-expect-error Readonly
		encoder.config = {
			codec: buildVideoCodecString('avc', 1280, 720, 1e6, false),
			width: 1280,
			height: 720,
			bitrate: 1e6,
		} satisfies VideoEncoderConfig;

		let packetCount = 0;

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket) => {
			expect(packet.type).toBe(packetCount % 2 ? 'delta' : 'key');
			packetCount++;
		};

		await encoder.init();

		const data = new Uint8Array(1280 * 720 * 4).fill(0xff); // White
		for (let i = 0; i < 10; i++) {
			using sample = new VideoSample(data, {
				format: 'RGBX',
				codedWidth: 1280,
				codedHeight: 720,
				timestamp: i / 30,
				duration: 1 / 30,
			});

			await encoder.encode(sample, { keyFrame: i % 2 === 0 });
		}

		await encoder.flush();
		await encoder.close();
	});

	test('AVC encode and decode, length-prefixed', async () => {
		await encodeDecodeTest('avc', {}, async (packet, meta, i) => {
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');
			expect([...packet.data.slice(0, 4)]).not.toEqual([0, 0, 0, 1]);

			for (const loc of iterateNalUnitsInLengthPrefixed(packet.data, 4)) {
				const naluType = extractNalUnitTypeForAvc(packet.data[loc.offset]!);
				// These have been stripped
				expect(
					naluType !== AvcNalUnitType.SPS
					&& naluType !== AvcNalUnitType.PPS
					&& naluType !== AvcNalUnitType.SPS_EXT,
				).toBe(true);
			}

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('avc1.')).toBe(true);
				expect(meta.decoderConfig!.description).toBeDefined();
				expect(toUint8Array(meta.decoderConfig!.description!)[0]).toBe(1); // configurationVersion
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white
		});
	});

	test('AVC encode and decode, Annex B', async () => {
		await encodeDecodeTest('avc', { avc: { format: 'annexb' } }, async (packet, meta, i) => {
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');
			expect([...packet.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);

			if (i === 0) {
				// In Annex B there's no description, so SPS/PPS are inlined into the keyframe
				const naluTypes: number[] = [];
				for (const loc of iterateNalUnitsInAnnexB(packet.data)) {
					naluTypes.push(extractNalUnitTypeForAvc(packet.data[loc.offset]!));
				}
				expect(naluTypes).toContain(AvcNalUnitType.SPS);
				expect(naluTypes).toContain(AvcNalUnitType.PPS);

				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('avc1.')).toBe(true);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white
		});
	});

	test('HEVC encode and decode, length-prefixed', async () => {
		await encodeDecodeTest('hevc', {}, async (packet, meta, i) => {
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');
			expect([...packet.data.slice(0, 4)]).not.toEqual([0, 0, 0, 1]);

			for (const loc of iterateNalUnitsInLengthPrefixed(packet.data, 4)) {
				const naluType = extractNalUnitTypeForHevc(packet.data[loc.offset]!);
				// These have been stripped
				expect(
					naluType !== HevcNalUnitType.SPS_NUT
					&& naluType !== HevcNalUnitType.PPS_NUT
					&& naluType !== HevcNalUnitType.VPS_NUT,
				).toBe(true);
			}

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('hev1.')).toBe(true);
				expect(meta.decoderConfig!.description).toBeDefined();
				expect(toUint8Array(meta.decoderConfig!.description!)[0]).toBe(1); // configurationVersion
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBe(255); // White
		});
	});

	test('HEVC encode and decode, Annex B', async () => {
		// @ts-expect-error Fucky types
		await encodeDecodeTest('hevc', { hevc: { format: 'annexb' } }, async (packet, meta, i) => {
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');
			expect([...packet.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);

			if (i === 0) {
				// In Annex B there's no description, so VPS/SPS/PPS are inlined into the keyframe
				const naluTypes: number[] = [];
				for (const loc of iterateNalUnitsInAnnexB(packet.data)) {
					naluTypes.push(extractNalUnitTypeForHevc(packet.data[loc.offset]!));
				}
				expect(naluTypes).toContain(HevcNalUnitType.VPS_NUT);
				expect(naluTypes).toContain(HevcNalUnitType.SPS_NUT);
				expect(naluTypes).toContain(HevcNalUnitType.PPS_NUT);

				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('hev1.')).toBe(true);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBe(255); // White
		});
	});

	test('VP8 encode and decode', async () => {
		await encodeDecodeTest('vp8', {}, async (packet, meta, i) => {
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('vp8');
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white
		});
	});

	test('VP9 encode and decode, opaque', async () => {
		await encodeDecodeTest('vp9', {}, async (packet, meta, i) => {
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');
			expect(packet.sideData.alpha).toBeUndefined();

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('vp09.')).toBe(true);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white
		});
	});

	test('VP9 encode and decode, transparent', async () => {
		await encodeDecodeTest('vp9', { alpha: 'keep' }, async (packet, meta, i) => {
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');
			expect(packet.sideData.alpha).toBeDefined();
			expect(packet.sideData.alpha!.byteLength).toBeGreaterThan(0);

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('vp09.')).toBe(true);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420A');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBA' }));
			await sample.copyTo(buf, { format: 'RGBA' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white

			// Check transparency
			expect(Math.abs(buf[3]! - 0x80)).toBeLessThan(3);
		}, true);
	});

	test('AV1 encode and decode', async () => {
		await encodeDecodeTest('av1', {}, async (packet, meta, i) => {
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('av01.')).toBe(true);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white
		});
	});

	test('Hardware encoder that fails to open falls back to software', async () => {
		// CUDA contexts list av1_nvenc even on NVIDIA GPUs without AV1 encoding (RTX 30 and older), where, like on
		// machines without an NVIDIA GPU, it fails to open
		const hardwareCodec = NodeAv.Codec.findEncoderByName(NodeAv.FF_ENCODER_AV1_NVENC);
		assert(hardwareCodec);
		const hardwareContext = Object.assign(
			Object.create(NodeAv.HardwareContext.prototype) as NodeAv.HardwareContext,
			{ getEncoderCodec: () => hardwareCodec, getDecoderCodec: () => null },
		);

		_serverOptions.hardwareContext = () => hardwareContext;
		try {
			await encodeDecodeTest('av1', {}, async () => {}, async () => {});
		} finally {
			delete _serverOptions.hardwareContext;
		}
	});

	test.each(['avc', 'av1'] as VideoCodec[])('%s encode with alpha kept but no alpha format', async (codec) => {
		// libx264 and libsvtav1 can't encode alpha, so the stream stays plain 8-bit 4:2:0 instead of switching to
		// whichever format comes closest to a YUVA source
		await encodeDecodeTest(codec, { alpha: 'keep' }, async (packet, meta, i) => {
			if (i === 0 && codec === 'avc') {
				// Not High 4:4:4 Predictive, which most hardware decoders can't play
				expect(meta.decoderConfig!.codec.startsWith('avc1.f4')).toBe(false);
			}
		}, async (sample) => {
			expect(sample.format).toBe('I420');
		}, true);
	});

	test('Pixel format for alpha: \'keep\'', () => {
		// prores_videotoolbox (macOS) only takes alpha packed, as ayuv64le or bgra
		expect(getAlphaPixelFormat('prores', [
			NodeAv.AV_PIX_FMT_VIDEOTOOLBOX,
			NodeAv.AV_PIX_FMT_YUV420P,
			NodeAv.AV_PIX_FMT_NV12,
			NodeAv.AV_PIX_FMT_AYUV64LE,
			NodeAv.AV_PIX_FMT_UYVY422,
			NodeAv.AV_PIX_FMT_P010LE,
			NodeAv.AV_PIX_FMT_BGRA,
		])).toBe(NodeAv.AV_PIX_FMT_AYUV64LE);

		// h264_nvenc takes RGBA input, but AVC can't carry alpha
		expect(getAlphaPixelFormat('avc', [
			NodeAv.AV_PIX_FMT_YUV420P,
			NodeAv.AV_PIX_FMT_NV12,
			NodeAv.AV_PIX_FMT_P010LE,
			NodeAv.AV_PIX_FMT_YUV444P,
			NodeAv.AV_PIX_FMT_YUV444P16LE,
			NodeAv.AV_PIX_FMT_BGR0,
			NodeAv.AV_PIX_FMT_BGRA,
			NodeAv.AV_PIX_FMT_RGBA,
		])).toBeNull();

		// libvpx-vp9, prores_ks and libsvtav1
		expect(getAlphaPixelFormat('vp9', [
			NodeAv.AV_PIX_FMT_YUV420P,
			NodeAv.AV_PIX_FMT_YUVA420P,
			NodeAv.AV_PIX_FMT_YUV444P,
			NodeAv.AV_PIX_FMT_YUVA444P,
			NodeAv.AV_PIX_FMT_GBRAP,
		])).toBe(NodeAv.AV_PIX_FMT_YUVA420P);
		expect(getAlphaPixelFormat('prores', [
			NodeAv.AV_PIX_FMT_YUV422P10LE,
			NodeAv.AV_PIX_FMT_YUV444P10LE,
			NodeAv.AV_PIX_FMT_YUVA444P10LE,
		])).toBe(NodeAv.AV_PIX_FMT_YUVA444P10LE);
		expect(getAlphaPixelFormat('av1', [
			NodeAv.AV_PIX_FMT_YUV420P,
			NodeAv.AV_PIX_FMT_YUV420P10LE,
		])).toBeNull();
	});

	test.each([
		['avc', 10],
		['avc', 1],
		['vp9', 10],
		['vp9', 1],
		['hevc', 10],
		['hevc', 1],
		['av1', 10],
		['av1', 1],
	] as [VideoCodec, number][])('%s key frames only at a keyFrameInterval of %i s', async (codec, interval) => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new VideoSampleSource({ codec, quality: new Quality('low'), keyFrameInterval: interval });
		output.addVideoTrack(source, { frameRate: 30 });
		await output.start();

		// 3 s at 30 fps of a slowly changing gray
		for (let i = 0; i < 90; i++) {
			using sample = new VideoSample(new Uint8Array(64 * 64 * 1.5).fill(100 + i), {
				format: 'I420',
				codedWidth: 64,
				codedHeight: 64,
				timestamp: i / 30,
				duration: 1 / 30,
			});
			await source.add(sample);
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		const keyFrameTimestamps: number[] = [];
		for await (const packet of sink.packets(undefined, undefined, { verifyKeyPackets: true })) {
			if (packet.type === 'key') {
				keyFrameTimestamps.push(Math.round(packet.timestamp * 30) / 30);
			}
		}

		// The encoder adds no key frames of its own, as with WebCodecs encoders
		expect(keyFrameTimestamps).toEqual(interval === 10 ? [0] : [0, 1, 2]);
	});

	const QUANTIZER_TEST_CODECS = [
		{ codec: 'avc', name: 'AVC', low: 10, high: 45 },
		{ codec: 'hevc', name: 'HEVC', low: 10, high: 45 },
		{ codec: 'vp9', name: 'VP9', low: 40, high: 220 },
		{ codec: 'av1', name: 'AV1', low: 40, high: 220 },
	] as const;

	for (const { codec, name, low, high } of QUANTIZER_TEST_CODECS) {
		test(`${name} quantizer encode`, { timeout: 20_000 }, async () => {
			const lowQuantizerPackets = await quantizerEncodeTest(codec, () => low);
			const highQuantizerPackets = await quantizerEncodeTest(codec, () => high);

			// A lower quantizer means higher quality, which shows in the encoded size
			expect(lowQuantizerPackets.reduce((sum, packet) => sum + packet.data.byteLength, 0))
				.toBeGreaterThan(highQuantizerPackets.reduce((sum, packet) => sum + packet.data.byteLength, 0));
		});

		test(`${name} mid-stream quantizer change`, { timeout: 20_000 }, async () => {
			const packets = await quantizerEncodeTest(codec, i => i < 5 ? low : high);

			// Changing the quantizer forces a fresh encoder stream, which begins with a new key frame
			expect(packets[5]!.type).toBe('key');

			expect(packets.slice(0, 5).reduce((sum, packet) => sum + packet.data.byteLength, 0))
				.toBeGreaterThan(packets.slice(5).reduce((sum, packet) => sum + packet.data.byteLength, 0));
		});
	}

	test('ProRes encode', async () => {
		// ProRes can't be decoded by node-av's wrapper here, so this is encode-only.
		const encoder = new NodeAvVideoEncoder();
		// @ts-expect-error Readonly
		encoder.codec = 'prores';
		// @ts-expect-error Readonly
		encoder.config = {
			codec: 'apch',
			width: 1280,
			height: 720,
			bitrate: 1e6,
		} satisfies VideoEncoderConfig;

		const packets: EncodedPacket[] = [];
		const sampleTimestamps: number[] = [];

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket, meta: EncodedVideoChunkMetadata) => {
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe('key');
			expect(String.fromCharCode(...packet.data.slice(4, 8))).toBe('icpf');

			if (packets.length === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('apch');
				expect(meta.decoderConfig!.codedWidth).toBe(1280);
				expect(meta.decoderConfig!.codedHeight).toBe(720);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}

			packets.push(packet);
		};

		await encoder.init();

		const data = new Uint8Array(1280 * 720 * 4).fill(0xff); // White
		for (let i = 0; i < 10; i++) {
			using sample = new VideoSample(data, {
				format: 'RGBX',
				codedWidth: 1280,
				codedHeight: 720,
				timestamp: i / 30,
				duration: 1 / 30,
			});

			sampleTimestamps.push(sample.timestamp);

			await encoder.encode(sample, {});
		}

		await encoder.flush();

		expect(packets).toHaveLength(10);
		expect(packets.map(x => x.timestamp)).toEqual(sampleTimestamps);

		await encoder.close();
	});

	test('ProRes Proxy encode', async () => {
		const encoder = new NodeAvVideoEncoder();
		// @ts-expect-error Readonly
		encoder.codec = 'prores';
		// @ts-expect-error Readonly
		encoder.config = {
			codec: 'apco', // Force ProRes 422 Proxy
			width: 1280,
			height: 720,
			bitrate: 1e6,
		} satisfies VideoEncoderConfig;

		const packets: EncodedPacket[] = [];
		const sampleTimestamps: number[] = [];

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket, meta: EncodedVideoChunkMetadata) => {
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe('key');
			expect(String.fromCharCode(...packet.data.slice(4, 8))).toBe('icpf');

			if (packets.length === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(PRORES_FOURCCS).toContain(meta.decoderConfig!.codec);
				expect(meta.decoderConfig!.codec).toBe('apco');
				expect(meta.decoderConfig!.codedWidth).toBe(1280);
				expect(meta.decoderConfig!.codedHeight).toBe(720);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}

			packets.push(packet);
		};

		await encoder.init();

		const data = new Uint8Array(1280 * 720 * 4).fill(0xff); // White
		for (let i = 0; i < 10; i++) {
			using sample = new VideoSample(data, {
				format: 'RGBX',
				codedWidth: 1280,
				codedHeight: 720,
				timestamp: i / 30,
				duration: 1 / 30,
			});

			sampleTimestamps.push(sample.timestamp);

			await encoder.encode(sample, {});
		}

		await encoder.flush();

		expect(packets).toHaveLength(10);
		expect(packets.map(x => x.timestamp)).toEqual(sampleTimestamps);

		await encoder.close();
	});

	test('ProRes encoding runs on several threads', async () => {
		// libavcodec defaults to a single thread, with which prores_ks took 19 s to encode 5 s of 1080p
		const encoder = new NodeAvVideoEncoder();
		// @ts-expect-error Readonly
		encoder.codec = 'prores';
		// @ts-expect-error Readonly
		encoder.config = {
			codec: 'apch',
			width: 1920,
			height: 1080,
			bitrate: 1e6,
		} satisfies VideoEncoderConfig;
		// @ts-expect-error Readonly
		encoder.onPacket = () => {};

		await encoder.init();

		using sample = new VideoSample(new Uint8Array(1920 * 1080 * 4), {
			format: 'RGBX',
			codedWidth: 1920,
			codedHeight: 1080,
			timestamp: 0,
			duration: 1 / 30,
		});
		await encoder.encode(sample, {});

		assert(encoder.codecContext);
		// Slice threads, unlike frame threads, give the exact same bytes as a single thread
		expect(encoder.codecContext.threadType).toBe(NodeAv.FF_THREAD_SLICE);
		if (os.availableParallelism() > 1) {
			expect(encoder.codecContext.threadCount).toBeGreaterThan(1);
		}

		await encoder.flush();
		await encoder.close();
	});

	test('Transparent ProRes encode and decode', async () => {
		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});

		const source = new VideoSampleSource({
			codec: 'prores',
			quality: new Quality({ quality: 0.75, preferBitrate: true }),
			alpha: 'keep',
		});
		output.addVideoTrack(source);

		await output.start();

		// Solid red at 50% alpha
		const data = new Uint8Array(640 * 480 * 4);
		for (let i = 0; i < data.byteLength; i += 4) {
			data[i] = 0xff;
			data[i + 3] = 0x80;
		}

		using inputSample = new VideoSample(data, {
			format: 'RGBA',
			codedWidth: 640,
			codedHeight: 480,
			timestamp: 0,
			duration: 1,
		});
		await source.add(inputSample);

		await output.finalize();

		using input = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});

		const videoTrack = (await input.getPrimaryVideoTrack())!;
		expect(await videoTrack.canBeTransparent()).toBe(true);

		const sink = new VideoSampleSink(videoTrack);
		using sample = (await sink.getSample(0))!;

		expect(sample.format).toBe('I444AP12');

		const decodedData = new Uint8Array(sample.allocationSize());
		const layout = await sample.copyTo(decodedData);

		const view = new DataView(decodedData.buffer);
		const alphaPlane = layout[3]!;
		let minAlpha = Infinity;
		let maxAlpha = -Infinity;
		for (let y = 0; y < sample.codedHeight; y++) {
			for (let x = 0; x < sample.codedWidth; x++) {
				const alpha = view.getUint16(alphaPlane.offset + y * alphaPlane.stride + x * 2, true);
				minAlpha = Math.min(minAlpha, alpha);
				maxAlpha = Math.max(maxAlpha, alpha);
			}
		}

		expect(maxAlpha).toBeLessThan(4095);
		expect(Math.abs(minAlpha - 4095 / 2)).toBeLessThan(32);
		expect(Math.abs(maxAlpha - 4095 / 2)).toBeLessThan(32);
	});

	test('Non-square pixels encode and decode #1', async () => {
		await encodeDecodeTest('avc', { displayWidth: 2 * 1280, displayHeight: 720 }, async (packet, meta, i) => {
			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codedWidth).toBe(1280);
				expect(meta.decoderConfig!.codedHeight).toBe(720);
				expect(meta.decoderConfig!.displayAspectWidth).toBe(2 * 1280);
				expect(meta.decoderConfig!.displayAspectHeight).toBe(720);
			}
		}, async (sample) => {
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.squarePixelWidth).toBe(2 * 1280);
			expect(sample.squarePixelHeight).toBe(720);
		});
	});

	test('Non-square pixels encode and decode #2', async () => {
		await encodeDecodeTest('avc', { displayWidth: 1280, displayHeight: 2 * 720 }, async (packet, meta, i) => {
			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codedWidth).toBe(1280);
				expect(meta.decoderConfig!.codedHeight).toBe(720);
				expect(meta.decoderConfig!.displayAspectWidth).toBe(1280);
				expect(meta.decoderConfig!.displayAspectHeight).toBe(2 * 720);
			}
		}, async (sample) => {
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.squarePixelWidth).toBe(1280);
			expect(sample.squarePixelHeight).toBe(2 * 720);
		});
	});

	const encodeDecodeTest = async (
		codec: VideoCodec,
		extraConfig: Partial<VideoEncoderConfig>,
		onPacket: (packet: EncodedPacket, meta: EncodedVideoChunkMetadata, i: number) => Promise<void>,
		onSample: (sample: VideoSample, i: number) => Promise<void>,
		transparent = false,
	) => {
		const encoder = new NodeAvVideoEncoder();
		// @ts-expect-error Readonly
		encoder.codec = codec;
		// @ts-expect-error Readonly
		encoder.config = {
			codec: buildVideoCodecString(codec, 1280, 720, 1e6, false),
			width: 1280,
			height: 720,
			bitrate: 1e6,
			...extraConfig,
		} satisfies VideoEncoderConfig;

		const sampleTimestamps: number[] = [];
		const packets: EncodedPacket[] = [];
		const metas: EncodedVideoChunkMetadata[] = [];

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket, meta: EncodedVideoChunkMetadata) => {
			packets.push(packet);
			metas.push(meta);
		};

		await encoder.init();

		const data = new Uint8Array(1280 * 720 * 4).fill(0xff); // White
		if (transparent) {
			for (let i = 0; i < data.byteLength; i += 4) {
				data[i + 3] = 0x80;
			}
		}

		for (let i = 0; i < 10; i++) {
			using sample = new VideoSample(data, {
				format: transparent ? 'RGBA' : 'RGBX',
				codedWidth: 1280,
				codedHeight: 720,
				timestamp: i / 30,
				duration: 1 / 30,
			});

			sampleTimestamps.push(sample.timestamp);

			await encoder.encode(sample, {});
		}

		await encoder.flush();

		expect(packets).toHaveLength(10);

		const sortedTimestamps = packets.map(x => x.timestamp).sort((a, b) => a - b);
		expect(sortedTimestamps).toEqual(sampleTimestamps);

		for (let i = 0; i < packets.length; i++) {
			await onPacket(packets[i]!, metas[i]!, i);
		}

		const decoder = new NodeAvVideoDecoder();
		// @ts-expect-error Readonly
		decoder.codec = codec;
		// @ts-expect-error Readonly
		decoder.config = metas[0]!.decoderConfig!;

		const decodedSamples: VideoSample[] = [];

		// @ts-expect-error Readonly
		decoder.onSample = (sample: VideoSample) => {
			decodedSamples.push(sample);
		};

		await decoder.init();

		for (const packet of packets) {
			await decoder.decode(packet);
		}

		await decoder.flush();

		expect(decodedSamples).toHaveLength(10);

		for (using sample of decodedSamples) {
			await onSample(sample, decodedSamples.indexOf(sample));
		}
	};

	const quantizerEncodeTest = async (codec: VideoCodec, getQuantizer: (frameIndex: number) => number) => {
		const width = 640;
		const height = 360;

		const encoder = new NodeAvVideoEncoder();
		// @ts-expect-error Readonly
		encoder.codec = codec;
		// @ts-expect-error Readonly
		encoder.config = {
			codec: buildVideoCodecString(codec, width, height, 1e6, false),
			width,
			height,
			bitrateMode: 'quantizer',
		} satisfies VideoEncoderConfig;

		const packets: EncodedPacket[] = [];

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket) => {
			packets.push(packet);
		};

		await encoder.init();

		// Noise, so that quality differences clearly show in the encoded size
		const data = new Uint8Array(width * height * 4);
		let seed = 123456789;
		for (let i = 0; i < data.length; i++) {
			seed = (seed * 48271) % 2147483647;
			data[i] = seed & 0xff;
		}

		for (let i = 0; i < 10; i++) {
			using sample = new VideoSample(data, {
				format: 'RGBX',
				codedWidth: width,
				codedHeight: height,
				timestamp: i / 30,
				duration: 1 / 30,
			});

			await encoder.encode(sample, buildQuantizerEncodeOptions(codec, getQuantizer(i)));
		}

		await encoder.flush();
		await encoder.close();

		expect(packets).toHaveLength(10);
		expect(packets[0]!.type).toBe('key');

		return packets;
	};

	test('AVC conversion roundtrip', { timeout: 20_000 }, async () => {
		await conversionRoundtrip('avc');
	});

	test('HEVC conversion roundtrip', { timeout: 20_000 }, async () => {
		await conversionRoundtrip('hevc', 1); // GitHub is extremely slow on this one
	});

	test('VP8 conversion roundtrip', { timeout: 20_000 }, async () => {
		await conversionRoundtrip('vp8');
	});

	test('VP9 conversion roundtrip', { timeout: 20_000 }, async () => {
		await conversionRoundtrip('vp9');
	});

	test('AV1 conversion roundtrip', { timeout: 20_000 }, async () => {
		await conversionRoundtrip('av1');
	});

	test('ProRes conversion roundtrip', { timeout: 30_000 }, async () => {
		// Encoding the whole clip as ProRes takes 30 CPU-seconds, which can exceed the timeout under parallel load
		await conversionRoundtrip('prores', 1);
	});

	const conversionRoundtrip = async (codec: VideoCodec, duration?: number) => {
		using input = new Input({
			source: new FilePathSource('./test/public/video.mp4'),
			formats: ALL_FORMATS,
		});

		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});

		const inputTrack = await input.getPrimaryVideoTrack();
		assert(inputTrack);

		const packetTimestamps: number[] = [];
		const packetSink = new EncodedPacketSink(inputTrack);

		for await (const packet of packetSink.packets()) {
			if (duration !== undefined && packet.timestamp >= duration) {
				break;
			}

			packetTimestamps.push(packet.timestamp);
		}

		packetTimestamps.sort((a, b) => a - b);

		const conversion = await Conversion.init({
			input,
			output,
			video: {
				codec,
				forceTranscode: true,
			}, audio: {
				discard: true,
			},
			trim: {
				end: duration,
			},
		});
		await conversion.execute();

		using newInput = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});

		const newInputTrack = await newInput.getPrimaryVideoTrack();
		assert(newInputTrack);

		expect(await newInputTrack.getCodec()).toBe(codec);

		const sink = new VideoSampleSink(newInputTrack);

		let sampleCount = 0;
		for await (using sample of sink.samples()) {
			expect(sample.codedWidth).toBe(await inputTrack.getCodedWidth());
			expect(sample.codedHeight).toBe(await inputTrack.getCodedHeight());
			expect(sample.timestamp).toBe(packetTimestamps[sampleCount]);

			sampleCount++;
		}

		expect(sampleCount).toBe(packetTimestamps.length);
	};

	test('Decoded samples carry the color space of the decoder config', async () => {
		// 16x16 gray, one frame, VP9 profile 2 tagged BT.2020/PQ. The VP9 bitstream itself can only signal the matrix,
		// so the primaries and transfer are only in the WebM Colour element:
		// ffmpeg -f lavfi -i "color=gray:s=16x16:r=10:d=0.1" -c:v libvpx-vp9 -pix_fmt yuv420p10le -profile:v 2
		//   -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -color_range tv vp9-pq-16x16.webm
		using input = new Input({
			source: new FilePathSource('./test/public/vp9-pq-16x16.webm'),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;
		const expected = { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false };
		expect((await track.getDecoderConfig())!.colorSpace).toEqual(expected);

		// Like in WebCodecs, the config's color space applies to the decoded samples
		using sample = (await new VideoSampleSink(track).getSample(0))!;
		expect(sample.colorSpace.toJSON()).toEqual(expected);
	});

	test('Decoded H.264 samples take the container\'s color space where the bitstream has none', async () => {
		// 16x16 orange-red, one frame of H.264 whose VUI signals no color, with BT.601 color in the MP4 colr box:
		// ffmpeg -f lavfi -i "color=c=0xC83020:s=16x16:r=10:d=0.1" -c:v libx264 -pix_fmt yuv420p untagged.mp4
		// ffmpeg -i untagged.mp4 -c copy -color_primaries smpte170m -color_trc smpte170m -colorspace smpte170m
		//   -color_range tv -movflags +write_colr h264-untagged-colr-bt601.mp4
		using input = new Input({
			source: new FilePathSource('./test/public/h264-untagged-colr-bt601.mp4'),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;
		const expected = { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false };
		expect((await track.getDecoderConfig())!.colorSpace).toEqual(expected);

		using sample = (await new VideoSampleSink(track).getSample(0))!;
		expect(sample.colorSpace.toJSON()).toEqual(expected);

		// Converted to RGB with the BT.601 matrix, as Chromium does
		const rgba = new Uint8Array(16 * 16 * 4);
		await sample.copyTo(rgba, { format: 'RGBA' });
		expect(Math.abs(rgba[0]! - 200)).toBeLessThanOrEqual(3);
		expect(Math.abs(rgba[1]! - 48)).toBeLessThanOrEqual(3);
		expect(Math.abs(rgba[2]! - 32)).toBeLessThanOrEqual(3);
	});

	test('Color space, RGB to BT.709 encode', async () => {
		const width = 320;
		const height = 180;

		// Solid red
		const data = new Uint8Array(width * height * 4);
		for (let i = 0; i < data.byteLength; i += 4) {
			data[i] = 0xff;
			data[i + 3] = 0xff;
		}

		// No explicit colorSpace: RGBA samples default to sRGB
		const createSample = (i: number) => new VideoSample(data, {
			format: 'RGBA',
			codedWidth: width,
			codedHeight: height,
			timestamp: i / 30,
			duration: 1 / 30,
		});

		const expectedColorSpace: VideoColorSpaceInit = {
			primaries: 'bt709',
			transfer: 'bt709',
			matrix: 'bt709',
			fullRange: false,
		};

		const { packets, decoderConfig } = await encodeFrames(width, height, createSample);
		expectColorSpace(decoderConfig.colorSpace, expectedColorSpace);

		const samples = await decodePackets(decoderConfig, packets);
		expect(samples.length).toBeGreaterThan(0);

		using sample = samples[0]!;
		// The decoder gets these from the bitstream (SPS VUI), so this proves the tags were actually written
		expectColorSpace(sample.colorSpace, expectedColorSpace);

		expect(sample.format).toBe('I420');
		const yuv = new Uint8Array(sample.allocationSize());
		await sample.copyTo(yuv);

		// Pure red in limited-range BT.709 is Y'=63, Cb=102, Cr=240; the BT.601 matrix would give Y'=81, Cb=90
		const lumaSize = width * height;
		expect(Math.abs(yuv[0]! - 63)).toBeLessThanOrEqual(3);
		expect(Math.abs(yuv[lumaSize]! - 102)).toBeLessThanOrEqual(3);
		expect(Math.abs(yuv[lumaSize + lumaSize / 4]! - 240)).toBeLessThanOrEqual(3);

		for (const sample of samples.slice(1)) {
			sample.close();
		}

		// And the color space must make it into the container
		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});
		const source = new VideoSampleSource({ codec: 'avc', bitrate: 1e6 });
		output.addVideoTrack(source);
		await output.start();

		using inputSample = createSample(0);
		await source.add(inputSample);
		await output.finalize();

		using input = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});
		const videoTrack = (await input.getPrimaryVideoTrack())!;
		expectColorSpace(await videoTrack.getColorSpace(), expectedColorSpace);
	});

	test('Color space, RGB to BT.2020 encode', async () => {
		const width = 320;
		const height = 180;

		// Solid red
		const data = new Uint8Array(width * height * 4);
		for (let i = 0; i < data.byteLength; i += 4) {
			data[i] = 0xff;
			data[i + 3] = 0xff;
		}

		const { packets, decoderConfig } = await encodeFrames(width, height, i => new VideoSample(data, {
			format: 'RGBA',
			codedWidth: width,
			codedHeight: height,
			timestamp: i / 30,
			duration: 1 / 30,
			colorSpace: {
				primaries: 'bt2020' as VideoColorPrimaries,
				transfer: 'pq' as VideoTransferCharacteristics,
				matrix: 'rgb',
				fullRange: true,
			},
		}));

		const expectedColorSpace: VideoColorSpaceInit = {
			primaries: 'bt2020' as VideoColorPrimaries,
			transfer: 'pq' as VideoTransferCharacteristics,
			matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
			fullRange: false,
		};
		expectColorSpace(decoderConfig.colorSpace, expectedColorSpace);

		const samples = await decodePackets(decoderConfig, packets);
		expect(samples.length).toBeGreaterThan(0);

		using sample = samples[0]!;
		expectColorSpace(sample.colorSpace, expectedColorSpace);

		const yuv = new Uint8Array(sample.allocationSize());
		await sample.copyTo(yuv);

		// Pure red in limited-range BT.2020 NCL is Y'=74, Cb=97, Cr=240 (BT.709 would give Y'=63, Cb=102)
		const lumaSize = width * height;
		expect(Math.abs(yuv[0]! - 74)).toBeLessThanOrEqual(3);
		expect(Math.abs(yuv[lumaSize]! - 97)).toBeLessThanOrEqual(3);
		expect(Math.abs(yuv[lumaSize + lumaSize / 4]! - 240)).toBeLessThanOrEqual(3);

		for (const sample of samples.slice(1)) {
			sample.close();
		}
	});

	test('Color space, YUV color space passthrough', async () => {
		const width = 320;
		const height = 180;
		const lumaSize = width * height;

		// Arbitrary but distinct plane values, so we can tell if any matrix or range conversion happened
		const data = new Uint8Array(lumaSize * 3 / 2);
		data.fill(81, 0, lumaSize);
		data.fill(90, lumaSize, lumaSize + lumaSize / 4);
		data.fill(240, lumaSize + lumaSize / 4);

		// Deliberately not the BT.709 defaults, so defaulting would be caught. (Note that x264 rewrites some VUI codes
		// to equivalent ones, e.g. bt470bg -> smpte170m, which is why these particular values are used here.)
		const colorSpaces: VideoColorSpaceInit[] = [
			{
				primaries: 'bt2020' as VideoColorPrimaries,
				transfer: 'pq' as VideoTransferCharacteristics,
				matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
				fullRange: false,
			},
			{ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true },
		];

		for (const colorSpace of colorSpaces) {
			const { packets, decoderConfig } = await encodeFrames(width, height, i => new VideoSample(data, {
				format: 'I420',
				codedWidth: width,
				codedHeight: height,
				timestamp: i / 30,
				duration: 1 / 30,
				colorSpace,
			}));
			expectColorSpace(decoderConfig.colorSpace, colorSpace);

			const samples = await decodePackets(decoderConfig, packets);
			expect(samples.length).toBeGreaterThan(0);

			using sample = samples[0]!;
			expectColorSpace(sample.colorSpace, colorSpace);

			expect(sample.format).toBe('I420');
			const yuv = new Uint8Array(sample.allocationSize());
			await sample.copyTo(yuv);

			expect(Math.abs(yuv[0]! - 81)).toBeLessThanOrEqual(3);
			expect(Math.abs(yuv[lumaSize]! - 90)).toBeLessThanOrEqual(3);
			expect(Math.abs(yuv[lumaSize + lumaSize / 4]! - 240)).toBeLessThanOrEqual(3);

			for (const sample of samples.slice(1)) {
				sample.close();
			}
		}
	});

	test('Color space, YUV to RGB conversion', async () => {
		const width = 320;
		const height = 180;
		const lumaSize = width * height;

		// Pure red, as limited-range BT.709 and as limited-range BT.601. Converted with the right matrix, both come out
		// as (255, 0, 0); the wrong one gives (233, 0, 2) or (255, 24, 0).
		const cases = [
			{
				yuv: [63, 102, 240],
				colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
			},
			{
				yuv: [81, 90, 240],
				colorSpace: { primaries: 'bt470bg', transfer: 'smpte170m', matrix: 'bt470bg', fullRange: false },
			},
		] satisfies { yuv: number[]; colorSpace: VideoColorSpaceInit }[];

		for (const { yuv, colorSpace } of cases) {
			const data = new Uint8Array(lumaSize * 3 / 2);
			data.fill(yuv[0]!, 0, lumaSize);
			data.fill(yuv[1]!, lumaSize, lumaSize + lumaSize / 4);
			data.fill(yuv[2]!, lumaSize + lumaSize / 4);

			const { packets, decoderConfig } = await encodeFrames(width, height, i => new VideoSample(data, {
				format: 'I420',
				codedWidth: width,
				codedHeight: height,
				timestamp: i / 30,
				duration: 1 / 30,
				colorSpace,
			}));

			const samples = await decodePackets(decoderConfig, packets);
			expect(samples.length).toBeGreaterThan(0);

			using sample = samples[0]!;
			expect(sample.format).toBe('I420');

			const rgba = new Uint8Array(sample.allocationSize({ format: 'RGBA' }));
			await sample.copyTo(rgba, { format: 'RGBA' });

			expect(rgba[0]).toBeGreaterThanOrEqual(250);
			expect(rgba[1]).toBeLessThanOrEqual(5);
			expect(rgba[2]).toBeLessThanOrEqual(5);

			for (const sample of samples.slice(1)) {
				sample.close();
			}
		}
	});

	const encodeFrames = async (
		width: number,
		height: number,
		createSample: (i: number) => VideoSample,
	) => {
		const encoder = new NodeAvVideoEncoder();
		// @ts-expect-error Readonly
		encoder.codec = 'avc';
		// @ts-expect-error Readonly
		encoder.config = {
			codec: buildVideoCodecString('avc', width, height, 1e6, false),
			width,
			height,
			bitrate: 1e6,
		} satisfies VideoEncoderConfig;

		const packets: EncodedPacket[] = [];
		const metas: EncodedVideoChunkMetadata[] = [];

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket, meta: EncodedVideoChunkMetadata) => {
			packets.push(packet);
			metas.push(meta);
		};

		await encoder.init();

		for (let i = 0; i < 3; i++) {
			using sample = createSample(i);
			await encoder.encode(sample, {});
		}

		await encoder.flush();
		await encoder.close();

		return { packets, decoderConfig: metas[0]!.decoderConfig! };
	};

	const decodePackets = async (decoderConfig: VideoDecoderConfig, packets: EncodedPacket[]) => {
		const decoder = new NodeAvVideoDecoder();
		// @ts-expect-error Readonly
		decoder.codec = 'avc';
		// @ts-expect-error Readonly
		decoder.config = decoderConfig;

		const samples: VideoSample[] = [];

		// @ts-expect-error Readonly
		decoder.onSample = (sample: VideoSample) => {
			samples.push(sample);
		};

		await decoder.init();

		for (const packet of packets) {
			await decoder.decode(packet);
		}

		await decoder.flush();
		await decoder.close();

		return samples;
	};

	const expectColorSpace = (
		actual: VideoColorSpaceInit | VideoSampleColorSpace | undefined,
		expected: VideoColorSpaceInit,
	) => {
		expect(actual?.primaries).toBe(expected.primaries);
		expect(actual?.transfer).toBe(expected.transfer);
		expect(actual?.matrix).toBe(expected.matrix);
		expect(actual?.fullRange).toBe(expected.fullRange);
	};

	test('Custom VideoSample resource', async () => {
		using input = new Input({
			source: new FilePathSource('./test/public/video.mp4'),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		const sink = new VideoSampleSink(videoTrack);
		using sample = await sink.getSample(0);
		assert(sample);

		expect(sample._data).toBeInstanceOf(AvFrameVideoSampleResource);
		expect(sample.format).toBe('I420');
		expect(sample.codedWidth).toBe(1920);
		expect(sample.codedHeight).toBe(1080);
		expect(sample.squarePixelWidth).toBe(1920);
		expect(sample.squarePixelHeight).toBe(1080);
		expect(sample.displayWidth).toBe(1920);
		expect(sample.displayHeight).toBe(1080);
		expect(sample.visibleRect).toEqual({
			left: 0,
			top: 0,
			width: 1920,
			height: 1080,
		});
		expect(sample.rotation).toBe(0);
		expect(sample.timestamp).toBe(0);
		expect(sample.duration).toBe(1 / 25);

		// Default expected YUV size
		expect(sample.allocationSize()).toBe(1920 * 1080 * 1.5);
		// This is the same
		expect(sample.allocationSize({ format: 'I420' })).toBe(1920 * 1080 * 1.5);
		// Expected RGBA size
		expect(sample.allocationSize({ format: 'RGBA' })).toBe(1920 * 1080 * 4);
		// Can't convert to a non-RGBA format
		expect(() => sample.allocationSize({ format: 'NV12' })).toThrow('Invalid destination format');
		// Default YUV layout
		expect(sample.allocationSize({ layout: [
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1920 / 2 },
			{ offset: 1920 * 1080 + (1920 / 2) * (1080 / 2), stride: 1920 / 2 },
		] })).toBe(1920 * 1080 * 1.5);
		// Custom YUV layout
		expect(sample.allocationSize({ layout: [
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1000 },
			{ offset: 1920 * 1080 + (1000) * (1080 / 2), stride: 1920 / 2 },
		] })).toBe(1920 * 1080 + (1000) * (1080 / 2) + (1920 / 2) * (1080 / 2));
		// Default RGBA layout
		expect(sample.allocationSize({ format: 'RGBA', layout: [
			{ offset: 0, stride: 1920 * 4 },
		] })).toBe(1920 * 1080 * 4);
		// Custom RGBA layout
		expect(sample.allocationSize({ format: 'RGBA', layout: [
			{ offset: 0, stride: 1920 * 5 },
		] })).toBe(1920 * 1080 * 5);
		// Subrect with YUV
		expect(sample.allocationSize({ rect: {
			x: 0,
			y: 0,
			width: 400,
			height: 200,
		} })).toBe(400 * 200 * 1.5);
		// Subrect with RGBA
		expect(sample.allocationSize({ format: 'RGBA', rect: {
			x: 0,
			y: 0,
			width: 400,
			height: 200,
		} })).toBe(400 * 200 * 4);

		const buffer = new ArrayBuffer(1920 * 1080 * 5);

		// Default YUV layout
		expect(await sample.copyTo(buffer)).toEqual([
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1920 / 2 },
			{ offset: 1920 * 1080 + (1920 / 2) * (1080 / 2), stride: 1920 / 2 },
		]);
		// This is the same
		expect(await sample.copyTo(buffer, { format: 'I420' })).toEqual([
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1920 / 2 },
			{ offset: 1920 * 1080 + (1920 / 2) * (1080 / 2), stride: 1920 / 2 },
		]);
		// Default RGBA layout
		expect(await sample.copyTo(buffer, { format: 'RGBA' })).toEqual([
			{ offset: 0, stride: 1920 * 4 },
		]);
		// Can't convert to a non-RGBA format
		await expect(sample.copyTo(buffer, { format: 'NV12' })).rejects.toThrow('Invalid destination format');
		// Explicit default YUV layout
		expect(await sample.copyTo(buffer, { layout: [
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1920 / 2 },
			{ offset: 1920 * 1080 + (1920 / 2) * (1080 / 2), stride: 1920 / 2 },
		] })).toEqual([
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1920 / 2 },
			{ offset: 1920 * 1080 + (1920 / 2) * (1080 / 2), stride: 1920 / 2 },
		]);
		// Custom YUV layout
		expect(await sample.copyTo(buffer, { layout: [
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1000 },
			{ offset: 1920 * 1080 + (1000) * (1080 / 2), stride: 1920 / 2 },
		] })).toEqual([
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1000 },
			{ offset: 1920 * 1080 + (1000) * (1080 / 2), stride: 1920 / 2 },
		]);
		// Explicit default RGBA layout
		expect(await sample.copyTo(buffer, { format: 'RGBA', layout: [
			{ offset: 0, stride: 1920 * 4 },
		] })).toEqual([
			{ offset: 0, stride: 1920 * 4 },
		]);
		// Custom RGBA layout
		expect(await sample.copyTo(buffer, { format: 'RGBA', layout: [
			{ offset: 0, stride: 1920 * 5 },
		] })).toEqual([
			{ offset: 0, stride: 1920 * 5 },
		]);
		// Subrect with YUV
		expect(await sample.copyTo(buffer, { rect: {
			x: 0,
			y: 0,
			width: 400,
			height: 200,
		} })).toEqual([
			{ offset: 0, stride: 400 },
			{ offset: 400 * 200, stride: 400 / 2 },
			{ offset: 400 * 200 + (400 / 2) * (200 / 2), stride: 400 / 2 },
		]);
		// Subrect with RGBA
		expect(await sample.copyTo(buffer, { format: 'RGBA', rect: {
			x: 0,
			y: 0,
			width: 400,
			height: 200,
		} })).toEqual([
			{ offset: 0, stride: 400 * 4 },
		]);
	});

	test('toAvFrame with RGBA VideoSample', async () => {
		const width = 16;
		const height = 8;
		const data = new Uint8Array(width * height * 4);
		for (let i = 0; i < width * height; i++) {
			data[i * 4] = 0x12;
			data[i * 4 + 1] = 0x34;
			data[i * 4 + 2] = 0x56;
			data[i * 4 + 3] = 0xff;
		}

		using sample = new VideoSample(data, {
			format: 'RGBA',
			codedWidth: width,
			codedHeight: height,
			timestamp: 0.5,
			duration: 1 / 30,
		});

		using frame = new NodeAv.Frame();
		frame.alloc();

		await toAvFrame(sample, frame);

		expect(frame.getMediaType()).toBe(NodeAv.AVMEDIA_TYPE_VIDEO);
		expect(frame.format).toBe(NodeAv.AV_PIX_FMT_RGBA);
		expect(frame.width).toBe(width);
		expect(frame.height).toBe(height);
		expect(Number(frame.pts)).toBe(Math.round(0.5 * 1e6));
		expect(Number(frame.duration)).toBe(Math.round((1 / 30) * 1e6));
		expect(frame.timeBase.num).toBe(1);
		expect(frame.timeBase.den).toBe(1e6);

		assert(frame.data);
		const plane = toUint8Array(frame.data[0]!);
		expect(plane[0]).toBe(0x12);
		expect(plane[1]).toBe(0x34);
		expect(plane[2]).toBe(0x56);
		expect(plane[3]).toBe(0xff);
	});

	// https://github.com/Vanilagy/mediabunny/issues/392
	test('Memory doesn\'t leak', { timeout: 10_000 }, async () => {
		const encoder = new NodeAvVideoEncoder();
		// @ts-expect-error Readonly
		encoder.codec = 'avc';
		// @ts-expect-error Readonly
		encoder.config = {
			codec: buildVideoCodecString('avc', 1920, 1080, 1e6, false),
			width: 1920,
			height: 1080,
			bitrate: 1e6,
		} satisfies VideoEncoderConfig;

		const pendingPackets: EncodedPacket[] = [];
		const decodedFrames: VideoSample[] = [];
		let decoderConfig: VideoDecoderConfig | null = null;

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket, meta: EncodedVideoChunkMetadata) => {
			if (meta.decoderConfig) {
				decoderConfig = meta.decoderConfig;
			}
			pendingPackets.push(packet);
		};

		await encoder.init();

		// Encode a single white frame to get one packet (and the decoder config) to drive the loop with
		const data = new Uint8Array(1920 * 1080 * 4).fill(0xff); // White
		using bootstrapSample = new VideoSample(data, {
			format: 'RGBX',
			codedWidth: 1920,
			codedHeight: 1080,
			timestamp: 0,
			duration: 1 / 30,
		});
		await encoder.encode(bootstrapSample, {});
		await encoder.flush();
		assert(decoderConfig);
		assert(pendingPackets.length > 0);

		const sourcePacket = pendingPackets[0]!;
		pendingPackets.length = 0;

		const decoder = new NodeAvVideoDecoder();
		// @ts-expect-error Readonly
		decoder.codec = 'avc';
		// @ts-expect-error Readonly
		decoder.config = decoderConfig;
		// @ts-expect-error Readonly
		decoder.onSample = (sample: VideoSample) => {
			decodedFrames.push(sample);
		};
		await decoder.init();

		const iterations = 300;
		let baselineRss = 0;

		for (let i = 1; i <= iterations; i++) {
			await decoder.decode(sourcePacket.clone({ timestamp: i / 30 }));

			for (const frame of decodedFrames) {
				await encoder.encode(frame, {});
				frame.close();
			}
			decodedFrames.length = 0;
			pendingPackets.length = 0;

			if (i === 100) { // Should have stabilized by then
				baselineRss = process.memoryUsage().rss;
			}
		}

		const finalRss = process.memoryUsage().rss;
		const growth = finalRss - baselineRss;

		expect(growth).toBeLessThan(10 * 1024 * 1024);

		await encoder.close();
		await decoder.close();
	});

	test('No B-frames are skipped when decoding AVC', async () => {
		using input = new Input({
			source: new FilePathSource('./test/public/missing-reorder-metadata-v1.mp4'),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const sink = new VideoSampleSink(track, {
			hardwareAcceleration: 'prefer-software',
		});
		let count = 0;

		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		for await (using sample of sink.samples()) {
			count++;
		}

		expect(count).toBe(48);
	});

	describe('Threading', () => {
		// libavcodec opens codecs on a single thread unless told otherwise, which is what these compare against
		const withSingleThreadedCodecs = async <T>(fn: () => Promise<T>) => {
			const prototype = NodeAv.CodecContext.prototype;
			const descriptor = Object.getOwnPropertyDescriptor(prototype, 'open2');
			assert(descriptor);
			const open2 = descriptor.value as typeof prototype.open2;

			Object.defineProperty(prototype, 'open2', {
				...descriptor,
				value: function (this: NodeAv.CodecContext, ...args: Parameters<typeof prototype.open2>) {
					this.threadCount = 1;
					return open2.apply(this, args);
				},
			});

			try {
				return await fn();
			} finally {
				Object.defineProperty(prototype, 'open2', descriptor);
			}
		};

		const fingerprint = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

		const readPackets = async (path: string, count: number) => {
			using input = new Input({
				source: new FilePathSource(path),
				formats: ALL_FORMATS,
			});

			const track = await input.getPrimaryVideoTrack();
			assert(track);

			const packets: EncodedPacket[] = [];
			for await (const packet of new EncodedPacketSink(track).packets()) {
				packets.push(packet);
				if (packets.length === count) {
					break;
				}
			}

			const codec = await track.getCodec();
			const decoderConfig = await track.getDecoderConfig();
			assert(codec && decoderConfig);

			return { codec, decoderConfig, packets };
		};

		const encodePackets = async (codec: VideoCodec, width: number, height: number) => {
			const encoder = new NodeAvVideoEncoder();
			// @ts-expect-error Readonly
			encoder.codec = codec;
			// @ts-expect-error Readonly
			encoder.config = {
				codec: buildVideoCodecString(codec, width, height, 2e6, false),
				width,
				height,
				bitrate: 2e6,
			} satisfies VideoEncoderConfig;

			const packets: EncodedPacket[] = [];
			let decoderConfig: VideoDecoderConfig | undefined;
			// @ts-expect-error Readonly
			encoder.onPacket = (packet: EncodedPacket, meta: EncodedVideoChunkMetadata) => {
				packets.push(packet);
				decoderConfig ??= meta.decoderConfig;
			};

			await encoder.init();

			let threadCount = 0;
			const data = new Uint8Array(width * height * 4);
			for (let i = 0; i < 20; i++) {
				// A moving gradient, so that every frame has something to encode
				for (let y = 0; y < height; y++) {
					for (let x = 0; x < width; x++) {
						const offset = 4 * (y * width + x);
						data[offset] = (x + 4 * i) & 0xff;
						data[offset + 1] = (y + 2 * i) & 0xff;
						data[offset + 2] = (x ^ y) & 0xff;
					}
				}

				using sample = new VideoSample(data, {
					format: 'RGBX',
					codedWidth: width,
					codedHeight: height,
					timestamp: i / 30,
					duration: 1 / 30,
				});
				await encoder.encode(sample, {});

				assert(encoder.codecContext);
				threadCount = encoder.codecContext.threadCount;
			}

			await encoder.flush();
			await encoder.close();

			assert(decoderConfig);
			return { packets, decoderConfig, threadCount };
		};

		const decodePackets = async (
			codec: VideoCodec,
			decoderConfig: VideoDecoderConfig,
			packets: EncodedPacket[],
		) => {
			const decoder = new NodeAvVideoDecoder();
			// @ts-expect-error Readonly
			decoder.codec = codec;
			// @ts-expect-error Readonly
			decoder.config = decoderConfig;

			const samples: VideoSample[] = [];
			// @ts-expect-error Readonly
			decoder.onSample = (sample: VideoSample) => {
				samples.push(sample);
			};

			await decoder.init();

			// How many frames have come out after each packet
			const framesOut: number[] = [];
			for (const packet of packets) {
				await decoder.decode(packet);
				framesOut.push(samples.length);
			}

			await decoder.flush();

			assert(decoder.codecContext);
			const threadCount = decoder.codecContext.threadCount;
			await decoder.close();

			const frames: string[] = [];
			for (using sample of samples) {
				const data = new Uint8Array(sample.allocationSize());
				await sample.copyTo(data);
				frames.push(`${sample.timestamp}: ${fingerprint(data)}`);
			}

			return { frames, framesOut, threadCount };
		};

		test('Decoders run on several threads and give the same frames as on one', { timeout: 30_000 }, async () => {
			const inputs = [
				await readPackets('./test/public/video.mp4', 30), // H.264
				await readPackets('./test/public/video-h265.mp4', 30), // HEVC
				await readPackets('./test/public/demo.webm', 30), // VP9
				await readPackets('./test/public/transparency.webm', 10), // VP9 with alpha, decoded by libvpx
				{ codec: 'vp8' as const, ...await encodePackets('vp8', 640, 360) },
				{ codec: 'av1' as const, ...await encodePackets('av1', 640, 360) }, // Decoded by dav1d
			];

			for (const { codec, decoderConfig, packets } of inputs) {
				const threaded = await decodePackets(codec, decoderConfig, packets);
				const singleThreaded = await withSingleThreadedCodecs(
					() => decodePackets(codec, decoderConfig, packets),
				);

				expect(singleThreaded.threadCount).toBe(1);
				if (os.availableParallelism() > 1) {
					expect(threaded.threadCount, codec).toBeGreaterThan(1);
				}

				expect(threaded.frames, codec).toHaveLength(packets.length);
				expect(threaded.frames, codec).toEqual(singleThreaded.frames);
			}
		});

		test('Decoders asked to minimize latency output frames as early as on one thread', async () => {
			// Frame threading holds back frames until more packets come in, so it must be off here
			const inputs = [
				await readPackets('./test/public/video.mp4', 20), // H.264
				await readPackets('./test/public/demo.webm', 20), // VP9
				{ codec: 'av1' as const, ...await encodePackets('av1', 640, 360) }, // dav1d, which threads by itself
			];

			for (const { codec, decoderConfig, packets } of inputs) {
				const lowLatency = await decodePackets(codec, { ...decoderConfig, optimizeForLatency: true }, packets);
				const singleThreaded = await withSingleThreadedCodecs(
					() => decodePackets(codec, decoderConfig, packets),
				);

				expect(lowLatency.framesOut, codec).toEqual(singleThreaded.framesOut);
				expect(lowLatency.frames, codec).toEqual(singleThreaded.frames);
			}
		});

		test('VP9 encoding runs on several threads and gives the same packets as on one', async () => {
			const threaded = await encodePackets('vp9', 1280, 720);
			const singleThreaded = await withSingleThreadedCodecs(() => encodePackets('vp9', 1280, 720));

			expect(singleThreaded.threadCount).toBe(1);
			if (os.availableParallelism() > 1) {
				expect(threaded.threadCount).toBeGreaterThan(1);
			}

			const describePackets = (packets: EncodedPacket[]) => packets.map(
				packet => `${packet.timestamp} ${packet.type}: ${fingerprint(packet.data)}`,
			);
			expect(describePackets(threaded.packets)).toEqual(describePackets(singleThreaded.packets));
		});
	});

	describe('VideoSample transformation', () => {
		// 400x400 image: red everywhere, with a 200x200 blue square filling the bottom-left quadrant.
		const TEST_IMAGE = (() => {
			const buf = new Uint8Array(400 * 400 * 4);
			for (let i = 0; i < 400 * 400; i++) {
				buf[i * 4] = 255;
				buf[i * 4 + 1] = 0;
				buf[i * 4 + 2] = 0;
				buf[i * 4 + 3] = 255;
			}
			for (let y = 200; y < 400; y++) {
				for (let x = 0; x < 200; x++) {
					const i = y * 400 + x;
					buf[i * 4] = 0;
					buf[i * 4 + 1] = 0;
					buf[i * 4 + 2] = 255;
					buf[i * 4 + 3] = 255;
				}
			}
			return buf;
		})();

		const makeSample = () => new VideoSample(TEST_IMAGE, {
			format: 'RGBA',
			codedWidth: 400,
			codedHeight: 400,
			timestamp: 0,
		});

		const readRgba = async (sample: VideoSample) => {
			const buffer = new Uint8Array(sample.codedWidth * sample.codedHeight * 4);
			await sample.copyTo(buffer, { format: 'RGBA' });
			return buffer;
		};

		const getColorAt = (rgba: Uint8Array, width: number, x: number, y: number) => {
			const i = (y * width + x) * 4;
			return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!];
		};

		const expectColor = (actual: number[], expected: number[], tolerance = 4) => {
			for (let i = 0; i < 3; i++) {
				expect(
					Math.abs(actual[i]! - expected[i]!),
					`channel ${i}: got ${actual[i]}, expected ${expected[i]} (+/-${tolerance})`,
				).toBeLessThanOrEqual(tolerance);
			}
		};

		test('Resize to 200x200', async () => {
			using sample = makeSample();
			using result = await sample.transform({ width: 200, height: 200, fit: 'fill' });

			expect(result.codedWidth).toBe(200);
			expect(result.codedHeight).toBe(200);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 200, 50, 50), [255, 0, 0]); // top-left
			expectColor(getColorAt(rgba, 200, 150, 50), [255, 0, 0]); // top-right
			expectColor(getColorAt(rgba, 200, 50, 150), [0, 0, 255]); // bottom-left (blue)
			expectColor(getColorAt(rgba, 200, 150, 150), [255, 0, 0]); // bottom-right
		});

		test('Rotate 90 deg clockwise', async () => {
			using sample = makeSample();
			using result = await sample.transform({ rotate: 90 });

			expect(result.codedWidth).toBe(400);
			expect(result.codedHeight).toBe(400);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 400, 50, 50), [0, 0, 255]); // top-left (blue)
			expectColor(getColorAt(rgba, 400, 350, 50), [255, 0, 0]);
			expectColor(getColorAt(rgba, 400, 50, 350), [255, 0, 0]);
			expectColor(getColorAt(rgba, 400, 350, 350), [255, 0, 0]);
		});

		test('Crop top-left, no rotation', async () => {
			using sample = makeSample();
			using result = await sample.transform({ crop: { left: 0, top: 0, width: 200, height: 200 } });

			expect(result.codedWidth).toBe(200);
			expect(result.codedHeight).toBe(200);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 200, 50, 50), [255, 0, 0]);
			expectColor(getColorAt(rgba, 200, 150, 50), [255, 0, 0]);
			expectColor(getColorAt(rgba, 200, 50, 150), [255, 0, 0]);
			expectColor(getColorAt(rgba, 200, 150, 150), [255, 0, 0]);
		});

		test('Rotate 90 deg then crop top-left, crop applies after rotation', async () => {
			using sample = makeSample();
			using result = await sample.transform({
				rotate: 90,
				crop: { left: 0, top: 0, width: 200, height: 200 },
			});

			expect(result.codedWidth).toBe(200);
			expect(result.codedHeight).toBe(200);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 200, 50, 50), [0, 0, 255]);
			expectColor(getColorAt(rgba, 200, 150, 50), [0, 0, 255]);
			expectColor(getColorAt(rgba, 200, 50, 150), [0, 0, 255]);
			expectColor(getColorAt(rgba, 200, 150, 150), [0, 0, 255]);
		});

		test('Flip horizontally', async () => {
			using sample = makeSample();
			using result = await sample.transform({ flip: true });

			expect(result.flip).toBe(false);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 400, 50, 50), [255, 0, 0]);
			expectColor(getColorAt(rgba, 400, 350, 50), [255, 0, 0]);
			expectColor(getColorAt(rgba, 400, 50, 350), [255, 0, 0]);
			expectColor(getColorAt(rgba, 400, 350, 350), [0, 0, 255]); // bottom-right (blue)
		});

		test('Rotate 90 deg and flip', async () => {
			using sample = makeSample();
			using result = await sample.transform({ rotate: 90, flip: true });

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 400, 50, 50), [255, 0, 0]);
			expectColor(getColorAt(rgba, 400, 350, 50), [0, 0, 255]); // top-right (blue)
			expectColor(getColorAt(rgba, 400, 50, 350), [255, 0, 0]);
			expectColor(getColorAt(rgba, 400, 350, 350), [255, 0, 0]);
		});

		test('Rotate 90 deg and flip and crop top-right', async () => {
			using sample = makeSample();
			using result = await sample.transform({
				rotate: 90,
				flip: true,
				crop: { left: 200, top: 0, width: 200, height: 200 },
			});

			expect(result.codedWidth).toBe(200);
			expect(result.codedHeight).toBe(200);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 200, 50, 50), [0, 0, 255]);
			expectColor(getColorAt(rgba, 200, 150, 50), [0, 0, 255]);
			expectColor(getColorAt(rgba, 200, 50, 150), [0, 0, 255]);
			expectColor(getColorAt(rgba, 200, 150, 150), [0, 0, 255]);
		});

		test('Sample flip metadata composed with additional rotation', async () => {
			using sample = makeSample();
			sample.setFlip(true);

			// The sample's own flip comes first, then the additional rotation: blue goes bottom-left -> bottom-right
			// -> bottom-left
			using result = await sample.transform({ rotate: 90 });

			expect(result.rotation).toBe(0);
			expect(result.flip).toBe(false);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 400, 50, 50), [255, 0, 0]);
			expectColor(getColorAt(rgba, 400, 350, 50), [255, 0, 0]);
			expectColor(getColorAt(rgba, 400, 50, 350), [0, 0, 255]); // bottom-left (blue)
			expectColor(getColorAt(rgba, 400, 350, 350), [255, 0, 0]);
		});

		test('Resize to 400x200 with fill, vertically squished', async () => {
			using sample = makeSample();
			using result = await sample.transform({ width: 400, height: 200, fit: 'fill' });

			expect(result.codedWidth).toBe(400);
			expect(result.codedHeight).toBe(200);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 400, 50, 50), [255, 0, 0]); // top-left
			expectColor(getColorAt(rgba, 400, 300, 50), [255, 0, 0]); // top-right
			expectColor(getColorAt(rgba, 400, 50, 175), [0, 0, 255]); // bottom-left (blue)
			expectColor(getColorAt(rgba, 400, 300, 175), [255, 0, 0]); // bottom-right
		});

		test('Resize to 400x200 with contain, letterboxed', async () => {
			using sample = makeSample();
			using result = await sample.transform({ width: 400, height: 200, fit: 'contain' });

			expect(result.codedWidth).toBe(400);
			expect(result.codedHeight).toBe(200);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 400, 50, 100), [0, 0, 0]); // left letterbox
			expectColor(getColorAt(rgba, 400, 350, 100), [0, 0, 0]); // right letterbox
			expectColor(getColorAt(rgba, 400, 150, 50), [255, 0, 0]); // top-left of image (red)
			expectColor(getColorAt(rgba, 400, 150, 150), [0, 0, 255]); // bottom-left of image (blue)
			expectColor(getColorAt(rgba, 400, 250, 150), [255, 0, 0]); // bottom-right of image (red)
		});

		test('Resize to 400x200 with cover, vertical center crop', async () => {
			using sample = makeSample();
			using result = await sample.transform({ width: 400, height: 200, fit: 'cover' });

			expect(result.codedWidth).toBe(400);
			expect(result.codedHeight).toBe(200);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 400, 50, 50), [255, 0, 0]); // top-left (red)
			expectColor(getColorAt(rgba, 400, 350, 50), [255, 0, 0]); // top-right (red)
			expectColor(getColorAt(rgba, 400, 50, 150), [0, 0, 255]); // bottom-left (blue)
			expectColor(getColorAt(rgba, 400, 350, 150), [255, 0, 0]); // bottom-right (red)
		});

		test('alpha: \'discard\' paints transparent pixels onto black', async () => {
			// 4x2 RGBA: the left half is fully transparent red, the right half opaque green
			const data = new Uint8Array(4 * 2 * 4);
			for (let i = 0; i < 8; i++) {
				data.set((i % 4) < 2 ? [255, 0, 0, 0] : [0, 255, 0, 255], i * 4);
			}
			using sample = new VideoSample(data, { format: 'RGBA', codedWidth: 4, codedHeight: 2, timestamp: 0 });

			const readPixels = async (sample: VideoSample) => {
				const bytes = new Uint8Array(sample.allocationSize({ format: 'RGBA' }));
				await sample.copyTo(bytes, { format: 'RGBA' });
				return bytes;
			};

			// Control: 'keep' leaves the transparent pixels transparent
			using kept = await sample.transform({ alpha: 'keep' });
			expect((await readPixels(kept))[3]).toBe(0);

			// Like the canvas transformer, 'discard' paints the frame onto black, making every pixel opaque
			using discarded = await sample.transform({ alpha: 'discard' });
			expect(discarded.format).toBe('RGBA');
			const pixels = await readPixels(discarded);
			expect([...pixels.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
			expect([...pixels.subarray(8, 12)]).toEqual([0, 255, 0, 255]);

			// The letterbox bars of 'contain' are opaque black as well
			using letterboxed = await sample.transform({ width: 4, height: 4, fit: 'contain', alpha: 'discard' });
			expect([...(await readPixels(letterboxed)).subarray(0, 4)]).toEqual([0, 0, 0, 255]);
		});

		test.each([
			['I420A', 8],
			['I420AP10', 10],
			['I444AP12', 12],
		] as const)('alpha: \'discard\' on %s', async (format, bitDepth) => {
			// 16x16, white, transparent on the left half
			const width = 16;
			const height = 16;
			const chromaSize = format.startsWith('I420') ? (width / 2) * (height / 2) : width * height;
			const max = 2 ** bitDepth - 1;
			const values = bitDepth === 8
				? new Uint8Array(width * height * 2 + chromaSize * 2)
				: new Uint16Array(width * height * 2 + chromaSize * 2);
			values.fill(Math.round(235 / 255 * max), 0, width * height); // Y
			values.fill(Math.round(128 / 255 * max), width * height, width * height + chromaSize * 2); // U, V
			const alpha = values.subarray(width * height + chromaSize * 2);
			for (let y = 0; y < height; y++) {
				alpha.fill(0, y * width, y * width + width / 2);
				alpha.fill(max, y * width + width / 2, (y + 1) * width);
			}
			using sample = new VideoSample(new Uint8Array(values.buffer), {
				format,
				codedWidth: width,
				codedHeight: height,
				timestamp: 0,
			});

			// The format (and bit depth) stays, with every pixel opaque
			using discarded = await sample.transform({ width: 32, height: 32, fit: 'fill', alpha: 'discard' });
			expect(discarded.format).toBe(format);

			const rgba = new Uint8Array(32 * 32 * 4);
			await discarded.copyTo(rgba, { format: 'RGBA' });
			expectColor(getColorAt(rgba, 32, 4, 16), [0, 0, 0]);
			expectColor(getColorAt(rgba, 32, 27, 16), [255, 255, 255]);
			expect(rgba.filter((_, i) => i % 4 === 3).every(value => value === 255)).toBe(true);
		});

		test('VideoSample transformation via Conversion API', async () => {
			using input = new Input({
				source: new FilePathSource('./test/public/video.mp4'),
				formats: ALL_FORMATS,
			});

			const output = new Output({
				format: new Mp4OutputFormat(),
				target: new BufferTarget(),
			});

			const conversion = await Conversion.init({
				input,
				output,
				video: {
					width: 300,
					height: 300,
					fit: 'contain',
				},
			});
			await conversion.execute();
		});
	});
});

describe('Audio', async () => {
	/** A DTS bitrate that clears the encoder's per-frame minimum at the 48 kHz stereo the tests here use. */
	const DTS_BITRATE = 768000;

	// In samples, as signaled by FFmpeg's encoders through negative packet timestamps
	const PRIMING_DELAYS: Partial<Record<AudioCodec, number>> = {
		aac: 1024,
		opus: 312,
		mp3: 1105,
		vorbis: 128,
		ac3: 256,
		eac3: 256,
	};

	test('Decoding a packet that holds several frames', async () => {
		using input = new Input({
			source: new FilePathSource('./test/public/eac3.mp4'),
			formats: ALL_FORMATS,
		});

		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);

		// Like FFmpeg's E-AC-3 MP4 samples at high bitrates, which hold several syncframes each
		const sink = new EncodedPacketSink(audioTrack);
		const packets: EncodedPacket[] = [];
		for await (const packet of sink.packets()) {
			packets.push(packet);
			if (packets.length === 3) {
				break;
			}
		}

		const combinedData = new Uint8Array(packets.reduce((sum, packet) => sum + packet.data.byteLength, 0));
		let offset = 0;
		for (const packet of packets) {
			combinedData.set(packet.data, offset);
			offset += packet.data.byteLength;
		}
		const combined = new EncodedPacket(
			combinedData,
			'key',
			packets[0]!.timestamp,
			packets.reduce((sum, packet) => sum + packet.duration, 0),
		);

		const decoder = new NodeAvAudioDecoder();
		// @ts-expect-error Readonly
		decoder.codec = await audioTrack.getCodec();
		// @ts-expect-error Readonly
		decoder.config = await audioTrack.getDecoderConfig();

		const timestamps: number[] = [];
		// @ts-expect-error Readonly
		decoder.onSample = (sample: AudioSample) => {
			timestamps.push(sample.timestamp);
			sample.close();
		};

		await decoder.init();
		await decoder.decode(combined);
		await decoder.flush();
		await decoder.close();

		expect(timestamps).toHaveLength(3);
		for (let i = 0; i < 3; i++) {
			expect(timestamps[i]).toBeCloseTo(packets[i]!.timestamp, 6);
		}
	});

	test('Decoder lifecycle', async () => {
		using input = new Input({
			source: new FilePathSource('./test/public/trim-buck-bunny-ffmpeg.ts'),
			formats: ALL_FORMATS,
		});

		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);

		const decoder = new NodeAvAudioDecoder();
		// @ts-expect-error Readonly
		decoder.codec = await audioTrack.getCodec();
		// @ts-expect-error Readonly
		decoder.config = await audioTrack.getDecoderConfig();

		let sampleCount = 0;
		const packetTimestamps: number[] = [];

		// @ts-expect-error Readonly
		decoder.onSample = (sample: AudioSample) => {
			expect(sample.timestamp).toBe(packetTimestamps[sampleCount]);

			if (sampleCount > 0) {
				expect(sample.duration).toBeCloseTo(
					packetTimestamps[sampleCount]! - packetTimestamps[sampleCount - 1]!,
				);
			}

			sampleCount++;
			sample.close();
		};

		await decoder.init();

		const sink = new EncodedPacketSink(audioTrack);
		let packetCount = 0;
		for await (const packet of sink.packets()) {
			packetTimestamps.push(packet.timestamp);
			await decoder.decode(packet);

			if (++packetCount === 10) {
				break;
			}
		}

		await decoder.flush();

		expect(sampleCount).toBe(10);

		// And, go again
		sampleCount = 0;
		packetTimestamps.length = 0;

		packetCount = 0;
		for await (const packet of sink.packets((await sink.getKeyPacket(5))!)) {
			packetTimestamps.push(packet.timestamp);
			await decoder.decode(packet);

			if (++packetCount === 10) {
				break;
			}
		}

		await decoder.flush();

		expect(sampleCount).toBe(10);

		await decoder.close();
	});

	test('Encoder lifecycle', async () => {
		const encoder = new NodeAvAudioEncoder();
		// @ts-expect-error Readonly
		encoder.codec = 'aac';
		// @ts-expect-error Readonly
		encoder.config = {
			codec: buildAudioCodecString('aac', 2, 48000),
			numberOfChannels: 2,
			sampleRate: 48000,
			bitrate: 128000,
		} satisfies AudioEncoderConfig;

		let packetCount = 0;
		let lastPacket: EncodedPacket | null = null;

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket, meta: EncodedAudioChunkMetadata) => {
			if (lastPacket) {
				// Every packet but the last holds a full frame
				expect(lastPacket.duration).toBe(1024 / 48000);
			}
			lastPacket = packet;

			expect(packet.type).toBe('key');

			if (packetCount === 0) {
				expect(packet.timestamp).toBe(-1024 / 48000); // Due to priming delay!

				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('mp4a.40.2');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig?.description).toBeDefined();
			}

			packetCount++;
		};

		await encoder.init();

		const data = createF32SineWave(48000, 2, 2);
		using sample1 = new AudioSample({
			data,
			format: 'f32',
			timestamp: 0,
			numberOfChannels: 2,
			sampleRate: 48000,
		});
		await encoder.encode(sample1);

		await encoder.flush();

		const minPacketCount = 2 * 48000 / 1024;
		expect(packetCount).toBeGreaterThan(minPacketCount);
		expect(lastPacket!.timestamp + lastPacket!.duration).toBeCloseTo(2, 10);

		packetCount = 0;
		lastPacket = null;

		using sample2 = new AudioSample({
			data,
			format: 'f32',
			timestamp: 0,
			numberOfChannels: 2,
			sampleRate: 48000,
		});
		await encoder.encode(sample2);

		await encoder.flush();

		expect(packetCount).toBeGreaterThan(minPacketCount);
		expect(lastPacket!.timestamp + lastPacket!.duration).toBeCloseTo(2, 10);

		await encoder.close();
	});

	test('AAC encoding of samples that hold NaN or infinite values', async () => {
		const encoder = new NodeAvAudioEncoder();
		// @ts-expect-error Readonly
		encoder.codec = 'aac';
		// @ts-expect-error Readonly
		encoder.config = {
			codec: buildAudioCodecString('aac', 2, 48000),
			numberOfChannels: 2,
			sampleRate: 48000,
			bitrate: 128000,
		} satisfies AudioEncoderConfig;

		let packetCount = 0;
		// @ts-expect-error Readonly
		encoder.onPacket = () => {
			packetCount++;
		};

		await encoder.init();

		const data = createF32SineWave(48000, 2, 1);
		data[1000] = NaN; // Like a glitch in a float WAV file or an unstable audio effect
		data[30000] = Infinity;
		data[30001] = -Infinity;
		using sample = new AudioSample({
			data,
			format: 'f32',
			timestamp: 0,
			numberOfChannels: 2,
			sampleRate: 48000,
		});

		await encoder.encode(sample);
		await encoder.flush();
		await encoder.close();

		expect(packetCount).toBe(Math.ceil(48000 / 1024) + 1);
	});

	const createF32SineWave = (sampleRate: number, channels: number, durationSeconds: number) => {
		const totalFrames = sampleRate * durationSeconds;
		const data = new Float32Array(totalFrames * channels);

		for (let i = 0; i < totalFrames; i++) {
			const value = Math.sin(2 * Math.PI * 440 * i / sampleRate);
			for (let ch = 0; ch < channels; ch++) {
				data[i * channels + ch] = value;
			}
		}

		return data;
	};

	test('AAC encode & decode, AAC format', async () => {
		await encodeDecodeTest('aac', {
			// @ts-expect-error Fucky type
			aac: { format: 'aac' },
		}, async (packet, meta, i, n) => {
			expect(packet.type).toBe('key');

			if (i < n - 1) {
				expect(packet.duration).toBe(1024 / 48000);
			}

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('mp4a.40.2');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeDefined();
			}
		}, async (sample) => {
			expect(sample.duration).toBe(1024 / 48000);
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
		});
	});

	test('AAC encode & decode, ADTS format', async () => {
		await encodeDecodeTest('aac', {
			// @ts-expect-error Fucky type
			aac: { format: 'adts' },
		}, async (packet, meta, i, n) => {
			expect(packet.type).toBe('key');

			if (i < n - 1) {
				expect(packet.duration).toBe(1024 / 48000);
			}
			expect(packet.data[0]).toBe(0xff);

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('mp4a.40.2');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample) => {
			expect(sample.duration).toBe(1024 / 48000);
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
		});
	});

	test('Opus encode & decode', async () => {
		await encodeDecodeTest('opus', {}, async (packet, meta, i, n) => {
			expect(packet.type).toBe('key');

			if (i < n - 1) {
				expect(packet.duration).toBe(0.02);
			}

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('opus');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeDefined();
				expect([...toUint8Array(meta.decoderConfig!.description!).slice(0, 8)]).toEqual([
					// OpusHead
					0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64,
				]);
			}
		}, async (sample, i, n) => {
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);

			if (i > 0 && i < n - 1) {
				expect(sample.duration).toBe(0.02);
			}
		});
	});

	test('MP3 encode & decode', async () => {
		await encodeDecodeTest('mp3', {}, async (packet, meta, i, n) => {
			expect(packet.type).toBe('key');

			if (i < n - 1) {
				expect(packet.duration).toBe(1152 / 48000);
			}

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('mp3');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample) => {
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
			expect(sample.duration).toBe(1152 / 48000);
		});
	});

	test('Vorbis encode & decode', async () => {
		await encodeDecodeTest('vorbis', {}, async (packet, meta, i) => {
			expect(packet.type).toBe('key');

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('vorbis');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeDefined();
				expect(toUint8Array(meta.decoderConfig!.description!)[0]).toBe(2); // "Xiph extradata format"
			}
		}, async (sample) => {
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
		});
	});

	test('FLAC encode & decode', async () => {
		await encodeDecodeTest('flac', {}, async (packet, meta, i, n) => {
			expect(packet.type).toBe('key');

			if (i < n - 1) {
				expect(packet.duration).toBe(0.096);
			}

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('flac');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeDefined();
				expect([...toUint8Array(meta.decoderConfig!.description!).slice(0, 4)]).toEqual([
					// fLaC
					0x66, 0x4c, 0x61, 0x43,
				]);
			}
		}, async (sample, i, n) => {
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);

			if (i < n - 1) {
				expect(sample.duration).toBe(0.096);
			}
		});
	});

	test('AC-3 encode & decode', async () => {
		await encodeDecodeTest('ac3', {}, async (packet, meta, i, n) => {
			expect(packet.type).toBe('key');

			if (i < n - 1) {
				expect(packet.duration).toBe(0.032);
			}

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('ac-3');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample) => {
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
			expect(sample.duration).toBe(0.032);
		});
	});

	test('E-AC-3 encode & decode', async () => {
		await encodeDecodeTest('eac3', {}, async (packet, meta, i, n) => {
			expect(packet.type).toBe('key');

			if (i < n - 1) {
				expect(packet.duration).toBe(0.032);
			}

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('ec-3');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample) => {
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
			expect(sample.duration).toBe(0.032);
		});
	});

	test('DTS encode & decode', async () => {
		await encodeDecodeTest('dts', { bitrate: DTS_BITRATE }, async (packet, meta, i, n) => {
			expect(packet.type).toBe('key');

			if (i < n - 1) {
				expect(packet.duration).toBeCloseTo(512 / 48000);
			}

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('dtsc');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample) => {
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
			expect(sample.duration).toBeCloseTo(512 / 48000);
		});
	});

	test('TrueHD encode & decode', async () => {
		await encodeDecodeTest('truehd', {}, async (packet, meta, i) => {
			// libav's encoder writes a major sync every 16 access units
			expect(packet.type).toBe(i % 16 === 0 ? 'key' : 'delta');
			expect(packet.duration).toBeCloseTo(40 / 48000);

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('mlpa');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample) => {
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
			expect(sample.duration).toBeCloseTo(40 / 48000);
		});
	});

	test.each([
		'aac', 'opus', 'mp3', 'vorbis', 'flac', 'ac3', 'eac3', 'dts', 'truehd',
	] as AudioCodec[])('%s encoding ends where the input ends', async (codec) => {
		const sampleRate = 48000;
		const frameCount = 48485; // Not a whole number of frames for any of these codecs

		const encoder = new NodeAvAudioEncoder();
		// @ts-expect-error Readonly
		encoder.codec = codec;
		// @ts-expect-error Readonly
		encoder.config = {
			codec: buildAudioCodecString(codec, 2, sampleRate),
			numberOfChannels: 2,
			sampleRate,
			bitrate: codec === 'dts' ? DTS_BITRATE : 128000,
		} satisfies AudioEncoderConfig;

		const packets: EncodedPacket[] = [];
		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket) => {
			packets.push(packet);
		};

		await encoder.init();

		using sample = new AudioSample({
			data: createF32SineWave(sampleRate, 2, 2).subarray(0, 2 * frameCount),
			format: 'f32',
			timestamp: 0,
			numberOfChannels: 2,
			sampleRate,
		});
		await encoder.encode(sample);
		await encoder.flush();
		await encoder.close();

		// The silence that fills up the last frame isn't part of the audio
		const lastPacket = last(packets)!;
		expect(lastPacket.timestamp + lastPacket.duration).toBeCloseTo(frameCount / sampleRate, 10);
	});

	test('FLAC encoding is lossless', async () => {
		const output = new Output({ format: new FlacOutputFormat(), target: new BufferTarget() });
		const source = new AudioSampleSource({ codec: 'flac' });
		output.addAudioTrack(source);
		await output.start();

		// 10000 frames isn't a multiple of the encoder's 4608-frame block size
		const data = Int16Array.from({ length: 10000 }, (_, i) => Math.round(8000 * Math.sin(i / 7)));
		using sample = new AudioSample({ data, format: 's16', numberOfChannels: 1, sampleRate: 48000, timestamp: 0 });
		await source.add(sample);
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		const decoded: number[] = [];
		for await (using decodedSample of new AudioSampleSink(track).samples()) {
			const values = new Int16Array(decodedSample.numberOfFrames);
			decodedSample.copyTo(values, { planeIndex: 0, format: 's16' });
			decoded.push(...values);
		}

		expect(await input.computeDuration()).toBe(10000 / 48000);
		expect(decoded).toEqual([...data]);
	});

	test.each([1, 15, 16])('FLAC encoding of %i samples has a valid maximum block size', async (frameCount) => {
		const output = new Output({ format: new FlacOutputFormat(), target: new BufferTarget() });
		const source = new AudioSampleSource({ codec: 'flac' });
		output.addAudioTrack(source);
		await output.start();

		const data = new Float32Array(2 * frameCount).fill(0.5);
		using sample = new AudioSample({ data, format: 'f32', numberOfChannels: 2, sampleRate: 48000, timestamp: 0 });
		await source.add(sample);
		await output.finalize();

		// STREAMINFO follows 'fLaC' and its block header. Blocks of fewer than 16 samples aren't allowed (RFC 9639,
		// section 8.2), and FFmpeg rejects a stream whose maximum block size is below that.
		const bytes = new Uint8Array(output.target.buffer!);
		const maximumBlockSize = (bytes[10]! << 8) | bytes[11]!;
		expect(maximumBlockSize).toBeGreaterThanOrEqual(16);
	});

	for (const codec of NON_PCM_AUDIO_CODECS) {
		test(`${codec} encode & decode, negative timestamps`, async () => {
			await timestampTest(codec, -1);
		});

		test(`${codec} encode & decode, positive timestamps`, async () => {
			await timestampTest(codec, 1);
		});

		test(`${codec} encode & decode, huge timestamps`, async () => {
			await timestampTest(codec, 1e9);
		});
	}

	const timestampTest = async (codec: AudioCodec, startTimestamp: number) => {
		let previousPacket: EncodedPacket | null = null;
		let previousSample: AudioSample | null = null;

		const testDuration = codec !== 'opus';
		const testSampleStart = codec !== 'vorbis';

		// The harness' default bitrate is below what DTS needs to fit its per-channel side info into a frame
		const extraConfig = codec === 'dts' ? { bitrate: DTS_BITRATE } : {};
		const primingDelay = (PRIMING_DELAYS[codec] ?? 0) / 48000;

		await encodeDecodeTest(codec, extraConfig, async (packet, _meta, i) => {
			if (i === 0) {
				expect(packet.timestamp).toBe(startTimestamp - primingDelay);
			} else if (testDuration) {
				expect(packet.timestamp).toBeCloseTo(previousPacket!.timestamp + previousPacket!.duration);
			}
			previousPacket = packet;
		}, async (sample, i) => {
			if (i === 0) {
				if (testSampleStart) {
					// The decoder discards Opus' pre-skip itself
					const expectedDelay = codec === 'opus' ? 0 : primingDelay;
					expect(sample.timestamp).toBe(startTimestamp - expectedDelay);
				}
			} else if (testDuration) {
				expect(sample.timestamp).toBeCloseTo(previousSample!.timestamp + previousSample!.duration);
			}
			previousSample = sample;
		}, startTimestamp);
	};

	const encodeDecodeTest = async (
		codec: AudioCodec,
		extraConfig: Partial<AudioEncoderConfig>,
		onPacket: (packet: EncodedPacket, meta: EncodedAudioChunkMetadata, i: number, n: number) => Promise<void>,
		onSample: (sample: AudioSample, i: number, n: number) => Promise<void>,
		startTimestamp = 0,
	) => {
		const sampleRate = 48000;
		const numberOfChannels = 2;

		const encoder = new NodeAvAudioEncoder();
		// @ts-expect-error Readonly
		encoder.codec = codec;
		// @ts-expect-error Readonly
		encoder.config = {
			codec: buildAudioCodecString(codec, numberOfChannels, sampleRate),
			numberOfChannels,
			sampleRate,
			bitrate: 128000,
			...extraConfig,
		} satisfies AudioEncoderConfig;

		const packets: EncodedPacket[] = [];
		const metas: EncodedAudioChunkMetadata[] = [];

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket, meta: EncodedAudioChunkMetadata) => {
			packets.push(packet);
			metas.push(meta);
		};

		await encoder.init();

		const data = createF32SineWave(sampleRate, numberOfChannels, 2);
		using inputSample = new AudioSample({
			data,
			format: 'f32',
			timestamp: startTimestamp,
			numberOfChannels,
			sampleRate,
		});
		await encoder.encode(inputSample);

		await encoder.flush();

		// Any silence filling up the last frame isn't part of the audio
		expect(last(packets)!.timestamp + last(packets)!.duration).toBeCloseTo(startTimestamp + 2, 6);

		for (let i = 0; i < packets.length; i++) {
			await onPacket(packets[i]!, metas[i]!, i, packets.length);
		}

		const decoder = new NodeAvAudioDecoder();
		// @ts-expect-error Readonly
		decoder.codec = codec;
		// @ts-expect-error Readonly
		decoder.config = metas[0]!.decoderConfig!;

		const decodedSamples: AudioSample[] = [];

		// @ts-expect-error Readonly
		decoder.onSample = (sample: AudioSample) => {
			decodedSamples.push(sample);
		};

		await decoder.init();

		for (const packet of packets) {
			await decoder.decode(packet);
		}

		await decoder.flush();

		expect(decodedSamples.length).toBeGreaterThan(0);
		expect(last(decodedSamples)!.timestamp + last(decodedSamples)!.duration).toBeGreaterThanOrEqual(
			startTimestamp + 2,
		);

		for (let i = 0; i < decodedSamples.length; i++) {
			await onSample(decodedSamples[i]!, i, decodedSamples.length);
		}

		const signalChunks: Float32Array[] = [];

		for (const sample of decodedSamples) {
			const buf = new Float32Array(new ArrayBuffer(sample.allocationSize({
				format: 'f32-planar', planeIndex: 0,
			})));
			sample.copyTo(buf, { format: 'f32-planar', planeIndex: 0 });
			signalChunks.push(buf);

			sample.close();
		}

		const totalSize = signalChunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const signal = new Float32Array(totalSize);
		let offset = 0;
		for (const chunk of signalChunks) {
			signal.set(chunk, offset);
			offset += chunk.length;
		}

		const score = sine440Score(signal, sampleRate, 440);
		expect(score).toBeGreaterThan(0.98);

		await encoder.close();
		await decoder.close();
	};

	const sine440Score = (x: Float32Array, sampleRate: number, freq: number) => {
		const w = 2 * Math.PI * freq / sampleRate;

		let ss = 0, cc = 0, sc = 0;
		let xs = 0, xc = 0;
		let xx = 0;

		for (let n = 0; n < x.length; n++) {
			const s = Math.sin(w * n);
			const c = Math.cos(w * n);

			ss += s * s;
			cc += c * c;
			sc += s * c;

			xs += x[n]! * s;
			xc += x[n]! * c;
			xx += x[n]! * x[n]!;
		}

		const det = ss * cc - sc * sc;

		const a = (xs * cc - xc * sc) / det;
		const b = (xc * ss - xs * sc) / det;

		let fitEnergy = 0;

		for (let n = 0; n < x.length; n++) {
			const y = a * Math.sin(w * n) + b * Math.cos(w * n);
			fitEnergy += y * y;
		}

		const score = fitEnergy / xx;
		return score;
	};

	test('AAC conversion roundtrip', async () => {
		await conversionRoundtrip('aac');
	});

	test('Opus conversion roundtrip', async () => {
		await conversionRoundtrip('opus');
	});

	test('MP3 conversion roundtrip', async () => {
		await conversionRoundtrip('mp3');
	});

	test('Vorbis conversion roundtrip', async () => {
		await conversionRoundtrip('vorbis');
	});

	test('FLAC conversion roundtrip', async () => {
		await conversionRoundtrip('flac');
	});

	test('AC-3 conversion roundtrip', async () => {
		await conversionRoundtrip('ac3');
	});

	test('E-AC-3 conversion roundtrip', async () => {
		await conversionRoundtrip('eac3');
	});

	test('TrueHD conversion roundtrip', async () => {
		await conversionRoundtrip('truehd');
	});

	const conversionRoundtrip = async (codec: AudioCodec) => {
		using input = new Input({
			source: new FilePathSource('./test/public/trim-buck-bunny-ffmpeg.ts'),
			formats: ALL_FORMATS,
		});

		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});

		const inputTrack = await input.getPrimaryAudioTrack();
		assert(inputTrack);

		const conversion = await Conversion.init({
			input,
			output,
			video: {
				discard: true,
			}, audio: {
				codec,
				forceTranscode: true,
			},
			trim: {
				start: 0,
			},
		});
		await conversion.execute();

		using newInput = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});

		const newInputTrack = await newInput.getPrimaryAudioTrack();
		assert(newInputTrack);

		expect(await newInputTrack.getCodec()).toBe(codec);
		expect(await newInputTrack.computeDuration()).toBeCloseTo(await inputTrack.computeDuration(), 0);

		const sink = new AudioSampleSink(newInputTrack);

		let sampleCount = 0;
		for await (using sample of sink.samples()) {
			expect([await inputTrack.getNumberOfChannels(), 2].includes(sample.numberOfChannels)).toBe(true);
			expect(sample.sampleRate).toBe(await inputTrack.getSampleRate());

			sampleCount++;
		}

		expect(sampleCount).toBeGreaterThan(0);
	};

	test('Custom AudioSample resource', async () => {
		using input = new Input({
			source: new FilePathSource('./test/public/trim-buck-bunny-ffmpeg.ts'),
			formats: ALL_FORMATS,
		});

		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);

		const sink = new AudioSampleSink(audioTrack);
		using sample = await sink.getSample(await audioTrack.getFirstTimestamp());
		assert(sample);

		expect(sample._data).toBeInstanceOf(AvFrameAudioSampleResource);
		expect(sample.format).toBe('f32-planar');
		expect(sample.numberOfChannels).toBe(6);
		expect(sample.sampleRate).toBe(48000);
		expect(sample.timestamp).toBe(await audioTrack.getFirstTimestamp());
		expect(sample.duration).toBe(1024 / 48000);
		expect(sample.numberOfFrames).toBe(1024);

		const size = sample.allocationSize({ planeIndex: 0 });
		expect(size).toBe(1024 * Float32Array.BYTES_PER_ELEMENT);

		// Test a bunch of copyTo()s:
		const buf = new ArrayBuffer(1e6);
		sample.copyTo(buf, { planeIndex: 0 });
		sample.copyTo(buf, { planeIndex: 1 });
		sample.copyTo(buf, { planeIndex: 2 });
		sample.copyTo(buf, { planeIndex: 3 });
		sample.copyTo(buf, { planeIndex: 4 });
		sample.copyTo(buf, { planeIndex: 5 });
		sample.copyTo(buf, { format: 'f32', planeIndex: 0 });
	});

	test('toAvFrame with f32 AudioSample', async () => {
		const sampleRate = 48000;
		const numberOfChannels = 2;
		const numberOfFrames = 1024;
		const data = createF32SineWave(sampleRate, numberOfChannels, numberOfFrames / sampleRate);

		using sample = new AudioSample({
			data,
			format: 'f32',
			timestamp: 0.25,
			numberOfChannels,
			sampleRate,
		});

		using frame = new NodeAv.Frame();
		frame.alloc();

		await toAvFrame(sample, frame);

		expect(frame.getMediaType()).toBe(NodeAv.AVMEDIA_TYPE_AUDIO);
		expect(frame.format).toBe(NodeAv.AV_SAMPLE_FMT_FLT);
		expect(frame.sampleRate).toBe(sampleRate);
		expect(frame.channels).toBe(numberOfChannels);
		expect(frame.nbSamples).toBe(numberOfFrames);
		expect(Number(frame.pts)).toBe(Math.round(0.25 * sampleRate));
		expect(Number(frame.duration)).toBe(numberOfFrames);
		expect(frame.timeBase.num).toBe(1);
		expect(frame.timeBase.den).toBe(sampleRate);

		assert(frame.data);
		const u8 = toUint8Array(frame.data[0]!);
		const plane = new Float32Array(u8.buffer, u8.byteOffset, numberOfFrames * numberOfChannels);
		expect(plane[0]).toBe(data[0]);
		expect(plane[1]).toBe(data[1]);
	});

	// This used to fail/crash because the buffer wasn't being reallocated
	test('toAvFrame with growing AudioSamples into a reused frame', async () => {
		using frame = new NodeAv.Frame();
		frame.alloc();

		using smallSample = new AudioSample({
			data: createF32SineWave(48000, 2, 1024 / 48000),
			format: 'f32',
			timestamp: 0,
			numberOfChannels: 2,
			sampleRate: 48000,
		});
		await toAvFrame(smallSample, frame);

		const largeData = new Float32Array(2 * 48000).fill(0.25);
		using largeSample = new AudioSample({
			data: largeData,
			format: 'f32',
			timestamp: 1,
			numberOfChannels: 2,
			sampleRate: 48000,
		});
		await toAvFrame(largeSample, frame);

		expect(frame.nbSamples).toBe(48000);
		expect(frame.linesize[0]).toBeGreaterThanOrEqual(largeData.byteLength);

		assert(frame.data);
		const u8 = toUint8Array(frame.data[0]!);
		const plane = new Float32Array(u8.buffer, u8.byteOffset, largeData.length);
		expect(plane[plane.length - 1]).toBe(0.25);
	});
});

describe('Packaging', () => {
	// The bundles are built by `npm run pre-test`
	test('Bundles load @mediabunny/prores instead of inlining a copy of it', () => {
		for (const file of ['mediabunny-server.cjs', 'mediabunny-server.mjs']) {
			const code = fs.readFileSync(`./packages/server/dist/bundles/${file}`, 'utf8');
			expect(code).toMatch(/(require\(|from )"@mediabunny\/prores"/);
			// turbores only has an "import" export, so a require() of it throws ERR_PACKAGE_PATH_NOT_EXPORTED
			expect(code).not.toContain('turbores');
		}
	});
});
