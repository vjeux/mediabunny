import { describe, expect, test } from 'vitest';
import { buildVideoCodecString, extractVideoCodecString, VideoCodec } from '../../src/codec.js';
import { extractAv1CodecInfoFromPacket, extractVp9CodecInfoFromPacket, parseAvcSps } from '../../src/codec-data.js';
import { canDecodeAudio, canDecodeVideo } from '../../src/decode.js';
import { canEncodeAudio, canEncodeVideo, Quality } from '../../src/encode.js';
import { isWebKit } from '../../src/misc.js';
import { EncodedPacket } from '../../src/packet.js';
import { AV1_FIXTURES, AVC_SPS_FIXTURES, hexToBytes, VP9_FIXTURES } from '../node/helpers/codecs-fixtures.js';

type VideoTrackInfo = Parameters<typeof extractVideoCodecString>[0];

const videoTrackInfo = (info: Partial<VideoTrackInfo>): VideoTrackInfo => ({
	width: 176,
	height: 144,
	codec: null,
	codecDescription: null,
	colorSpace: null,
	avcType: null,
	avcCodecInfo: null,
	hevcCodecInfo: null,
	vp9CodecInfo: null,
	av1CodecInfo: null,
	proresFormat: null,
	...info,
});

const isDecodable = async (codec: string, width = 176, height = 144) => {
	const support = await VideoDecoder.isConfigSupported({ codec, codedWidth: width, codedHeight: height });
	return support.supported;
};

describe('Codec strings in the browser', () => {
	test('Strings derived from real streams are accepted', async () => {
		// Malformed strings are rejected, except by WebKit, whose codec string parser accepts them (the checks below
		// still hold there)
		if (!isWebKit()) {
			expect(await isDecodable('av01.0.04X.08')).toBe(false);
			expect(await isDecodable('vp09.00.10')).toBe(false);
		}

		for (const fixture of AV1_FIXTURES) {
			const av1CodecInfo = extractAv1CodecInfoFromPacket(hexToBytes(fixture.sequenceHeaderObu))!;
			const codecString = extractVideoCodecString(videoTrackInfo({ codec: 'av1', av1CodecInfo }));
			expect(await isDecodable(codecString), `${fixture.name}: ${codecString}`).toBe(true);
		}

		for (const fixture of VP9_FIXTURES) {
			const vp9CodecInfo = extractVp9CodecInfoFromPacket(hexToBytes(fixture.keyFrameStart))!;
			const codecString = extractVideoCodecString(videoTrackInfo({ codec: 'vp9', vp9CodecInfo }));
			expect(await isDecodable(codecString), `${fixture.name}: ${codecString}`).toBe(true);
		}

		// The H.264 profiles every WebCodecs implementation decodes
		for (const fixture of AVC_SPS_FIXTURES.filter(x => [66, 77, 100].includes(x.expected.profileIdc))) {
			const sps = parseAvcSps(hexToBytes(fixture.sps))!;
			const codecString = extractVideoCodecString(videoTrackInfo({
				codec: 'avc',
				avcType: 1,
				codecDescription: new Uint8Array([1, sps.profileIdc, sps.constraintFlags, sps.levelIdc]),
			}));
			const { displayWidth, displayHeight } = fixture.expected;
			expect(await isDecodable(codecString, displayWidth, displayHeight), `${fixture.name}: ${codecString}`)
				.toBe(true);
		}
	});

	test('Strings built for encoding are accepted', async () => {
		const sizes = [[176, 144], [640, 480], [1280, 720], [1920, 1080], [3840, 2160]] as const;

		for (const codec of ['avc', 'vp8', 'vp9', 'av1'] as VideoCodec[]) {
			for (const [width, height] of sizes) {
				for (const bitrate of [100_000, 5_000_000, 50_000_000]) {
					const codecString = buildVideoCodecString(codec, width, height, bitrate, false);
					expect(await isDecodable(codecString, width, height), codecString).toBe(true);
				}
			}
		}
	});

	test('Support queries agree with WebCodecs', async () => {
		for (const codec of ['avc', 'vp8', 'vp9', 'av1'] as VideoCodec[]) {
			const codecString = buildVideoCodecString(codec, 1280, 720, 1e6, false);
			expect(await canDecodeVideo(codec), codec).toBe(await isDecodable(codecString, 1280, 720));
		}

		// Vorbis and FLAC need a description, which is made up for the query
		for (const codec of ['vorbis', 'flac'] as const) {
			expect(await canDecodeAudio(codec), codec).toBe(true);
		}

		// AVC encoders need even dimensions
		if (await canEncodeVideo('avc', { width: 1280, height: 720 })) {
			expect(await canEncodeVideo('avc', { width: 1281, height: 720 })).toBe(false);
		}

		// Opus encoders take up to two channels; the query has to say so rather than fail later
		const opusSupport = await AudioEncoder.isConfigSupported({
			codec: 'opus',
			numberOfChannels: 6,
			sampleRate: 48000,
		});
		expect(await canEncodeAudio('opus', { numberOfChannels: 6, quality: new Quality('medium') }))
			.toBe(!!opusSupport.supported);
	});
});

describe('EncodedPacket and WebCodecs chunks', () => {
	test('Video chunks', () => {
		const data = new Uint8Array([1, 2, 3, 4]);
		const alpha = new Uint8Array([5, 6]);
		const packet = new EncodedPacket(data, 'key', 1001 / 30000, 1001 / 30000, -1, undefined, { alpha });

		const chunk = packet.toEncodedVideoChunk();
		expect(chunk.type).toBe('key');
		expect(chunk.timestamp).toBe(33366);
		expect(chunk.duration).toBe(33366);
		expect(chunk.byteLength).toBe(4);
		const copy = new Uint8Array(4);
		chunk.copyTo(copy);
		expect([...copy]).toEqual([1, 2, 3, 4]);

		const alphaChunk = packet.alphaToEncodedVideoChunk('delta');
		expect(alphaChunk.type).toBe('delta');
		expect(alphaChunk.byteLength).toBe(2);
		expect(alphaChunk.timestamp).toBe(33366);

		// And back
		const restored = EncodedPacket.fromEncodedChunk(chunk, { alpha });
		expect([...restored.data]).toEqual([1, 2, 3, 4]);
		expect(restored.data).not.toBe(data);
		expect(restored.type).toBe('key');
		expect(restored.microsecondTimestamp).toBe(33366);
		expect(restored.microsecondDuration).toBe(33366);
		expect(restored.sideData.alphaByteLength).toBe(2);
	});

	test('Audio chunks', () => {
		// Negative timestamps (encoder priming) are fine
		const packet = new EncodedPacket(new Uint8Array(10), 'key', -1024 / 48000, 1024 / 48000);
		const chunk = packet.toEncodedAudioChunk();
		expect(chunk.timestamp).toBe(-21333);
		expect(chunk.duration).toBe(21333);
		expect(chunk.byteLength).toBe(10);

		const restored = EncodedPacket.fromEncodedChunk(chunk);
		expect(restored.timestamp).toBe(-0.021333);
		expect(restored.duration).toBe(0.021333);
		expect(restored.microsecondTimestamp).toBe(-21333);

		// A chunk without duration
		const noDuration = new EncodedVideoChunk({ type: 'delta', timestamp: 40000, data: new Uint8Array(1) });
		expect(EncodedPacket.fromEncodedChunk(noDuration).duration).toBe(0);

		expect(() => EncodedPacket.fromEncodedChunk({} as EncodedVideoChunk)).toThrow(TypeError);
	});
});
