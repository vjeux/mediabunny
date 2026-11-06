/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Cases ported from the unit tests of reference implementations (Chromium, WebKit, FFmpeg's FATE suite and the
// web-platform-tests WebCodecs directory). Every block names the test file it was ported from. Where Mediabunny
// deliberately behaves differently from a reference, the case says so and asserts Mediabunny's behavior.

import { describe, expect, test } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { inferCodecFromCodecString, validateAudioChunkMetadata, validateVideoChunkMetadata } from '../../src/codec.js';
import {
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
	determineVideoPacketType,
	extractAv1CodecInfoFromPacket,
	extractAvcDecoderConfigurationRecord,
	extractVp9CodecInfoFromPacket,
	parseAvcSps,
	parseHevcSps,
	parseOpusTocByte,
	serializeAvcDecoderConfigurationRecord,
	serializeHevcDecoderConfigurationRecord,
} from '../../src/codec-data.js';
import { parseAacAudioSpecificConfig } from '../../shared/aac-misc.js';
import {
	BitWriter,
	EBML,
	annexB,
	ascii,
	audioSampleEntry,
	blockPayload,
	box,
	buildFragmentedMp4,
	buildSingleTrackMp4,
	buildWebm,
	ebml,
	ebmlUint,
	ebmlUnknownSize,
	escapeRbsp,
	esds,
	hexBytes,
	sampleFlags,
	toHex,
	visualSampleEntry,
	vp8Frame,
	webmAudioTrack,
	webmVideoTrack,
} from './helpers/reftests-builders.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const openBytes = (bytes: Uint8Array) => new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

const acceptsVideoCodecString = (codec: string) => {
	try {
		validateVideoChunkMetadata({ decoderConfig: { codec, codedWidth: 16, codedHeight: 16 } }, null);
		return true;
	} catch {
		return false;
	}
};

describe('Chromium media/base/video_codec_string_parsers_unittest.cc', () => {
	// Chromium's parsers accept a few forms the codec registrations don't (a single-digit VP9 bit depth, a partial
	// set of optional VP9/AV1 fields) and Mediabunny follows the registrations there. The cases below are the ones
	// on which Chromium and the VP9/AV1/HEVC codec string specifications agree.

	test('accepts the VP9 codec strings of ParseVP9CodecId.NewStyleVP9CodecIDs', () => {
		const accepted = [
			'vp09.00.10.08',
			'vp09.01.10.08',
			'vp09.02.10.10',
			'vp09.03.10.12',
			...[10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 52, 60, 61, 62].map(level => `vp09.00.${level}.08`),
			'vp09.02.10.10.00.01.01.01.00',
			'vp09.02.10.10.00.01.01.01.01',
			'vp09.02.10.10.01.06.06.06.00', // mime_util_unittest: REC601
		];
		for (const codec of accepted) {
			expect(acceptsVideoCodecString(codec), codec).toBe(true);
			expect(inferCodecFromCodecString(codec), codec).toBe('vp9');
		}
	});

	test('rejects VP9 codec strings without all four required fields', () => {
		for (const codec of ['vp9', 'vp09', 'vp09.00', 'vp09.00.10']) {
			expect(acceptsVideoCodecString(codec), codec).toBe(false);
		}
	});

	test('accepts the AV1 codec strings of ParseAv1CodecId', () => {
		const accepted = [
			'av01.0.04M.08',
			'av01.1.04M.10',
			'av01.2.04M.12',
			...Array.from({ length: 32 }, (_, level) => `av01.0.${String(level).padStart(2, '0')}M.08`),
			'av01.1.00H.08',
			'av01.0.00M.10',
			'av01.0.00M.12',
			'av01.0.00M.10.0.110.01.01.00.0',
			'av01.0.00M.10.0.110.01.01.00.1',
			'av01.0.00M.10.0.110.09.16.09.0',
		];
		for (const codec of accepted) {
			expect(acceptsVideoCodecString(codec), codec).toBe(true);
			expect(inferCodecFromCodecString(codec), codec).toBe('av1');
		}
	});

	test('rejects AV1 codec strings with missing fields, leading zeros, signs or a bad tier', () => {
		const rejected = [
			'av1',
			'av01',
			'av01.0',
			'av01.0.04M',
			'av01.00.04M.08', // Leading zero in the profile
			'av01.-0.04M.08',
			'av01.-1.04M.08',
			'av01.0.4M.08', // The level needs two digits
			'av01.0.-4M.08',
			'av01.0.04M.8', // The bit depth needs two digits
			...[...'ABCDEFGIJKLNOPQRSTUVWXYZ0123456789m'].map(tier => `av01.1.00${tier}.08`),
			'av01.0.04M.08.00', // The monochrome flag is a single digit
			'av01.0.00M.10.0.000.1', // Colour fields need two digits
			'av01.0.00M.10.0.000.-1',
			'av01.0.00M.10.0.110.01.1',
			'av01.0.00M.10.0.110.01.01.1',
			'av01.0.00M.10.0.110.01.01.00.00', // The full range flag is a single digit
			'av01.0.00M.10.0.110.01.01.00.-1',
		];
		for (const codec of rejected) {
			expect(acceptsVideoCodecString(codec), codec).toBe(false);
		}
	});

	test('accepts the HEVC codec strings of ParseHEVCCodecIdTest', () => {
		const accepted = [
			'hev1.1.6.L93.B0',
			'hvc1.1.6.L93.B0',
			'hev1.1.6.L93', // Constraint bytes are optional
			'hvc1.A1.6.L93.B0',
			'hvc1.B1.6.L93.B0',
			'hvc1.C1.6.L93.B0',
			'hvc1.0.6.L93.B0',
			'hvc1.31.6.L93.B0',
			'hvc1.2.4.L93.B0',
			'hvc1.3.E.L93.B0',
			'hvc1.4.10.L93.B0',
			'hvc1.4.10.L93.9E.28',
			'hvc1.4.10.L93.99.A0',
			'hvc1.5.20.L93.B0',
			'hvc1.11.800.L93.B0',
			'hvc1.1.0.L93.B0',
			'hvc1.1.FF.L93.B0',
			'hvc1.1.FFFF.L93.B0',
			'hvc1.1.FFFFFFFF.L93.B0',
			'hvc1.1.0.H93.B0',
			'hvc1.1.6.L0.B0',
			'hvc1.1.6.L1.B0',
			'hvc1.1.6.L150.B0',
			'hvc1.1.6.L255.B0',
			'hvc1.1.6.L0.0.0.0.0.0.0',
			'hvc1.1.6.L0.00.00.00.00.00.00',
			'hvc1.1.6.L0.12',
			'hvc1.1.6.L0.12.34.56',
			'hvc1.1.6.L0.12.34.56.78.9A.BC',
			'hvc1.1.6.L0.FF.FF.FF.FF.FF.FF',
		];
		for (const codec of accepted) {
			expect(acceptsVideoCodecString(codec), codec).toBe(true);
			expect(inferCodecFromCodecString(codec), codec).toBe('hevc');
		}
	});

	test('rejects malformed HEVC codec strings', () => {
		const rejected = [
			'hvc1', 'hev1', 'hvc1.', 'hvc1..', 'hvc1...', 'hvc1....',
			'hvc1.1', 'hvc1.1.', 'hvc1.1..', 'hvc1.1...',
			'hvc1.1.6', 'hvc1.1.6.', 'hvc1.1.6..', 'hvc1.1.6...',
			'hvc1.1..L93', 'hvc1.1..L93.', 'hvc1.1..L93..',
			'hvc1..6', 'hvc1..6.', 'hvc1..6..', 'hvc1..6...', 'hvc1..6.L93', 'hvc1..6.L93.', 'hvc1..6.L93..',
			// Empty constraint bytes
			'hvc1.1.6.L93.', 'hvc1.1.6.L93..', 'hvc1.1.6.L93...', 'hvc1.1.6.L93....', 'hvc1.1.6.L93.....',
			'hvc1.1.6.L93......', 'hvc1.1.6.L93.......', 'hvc1.1.6.L93.......0', 'hvc1.1.6.L93.0.', 'hvc1.1.6.L93.0..',
			'hvc1.1.6.L93.0..0', 'hvc1.1.6.L93.0..0.0.0.0.0', 'hvc1.1.6.L93.0.0.0.0.0.0.',
			'hvc1.D1.6.L93.B0', // Only A, B and C are profile spaces
			'hvc1.-1.6.L93.B0',
			'hvc1.A.6.L93.B0',
			'hvc1.1F.6.L93.B0',
			'hvc1.1.100000000.L93.B0', // More than 32 bits of compatibility flags
			'hvc1.1.FFFFFFFFF.L93.B0',
			'hvc1.1.-1.L93.B0',
			'hvc1.1.0G.L93.B0',
			'hvc1.1.0.93.B0', // No tier
			'hvc1.1.0.A93.B0',
			'hvc1.1.6.L-1.B0',
			'hvc1.1.6.L0.FF.FF.FF.FF.FF.FF.0', // Seven constraint bytes
			'hvc1.1.6.L0.100',
			'hvc1.1.6.L0.1FF',
			'hvc1.1.6.L0.-1',
		];
		for (const codec of rejected) {
			expect(acceptsVideoCodecString(codec), codec).toBe(false);
		}
	});

	test('keeps the optional VP9 and AV1 fields all-or-none, unlike Chromium', () => {
		// VP-codec-ISOBMFF and AV1-ISOBMFF make the optional fields "mutually inclusive (all or none)". Chromium
		// accepts any prefix of them, and a single-digit VP9 bit depth, for compatibility with strings in the wild.
		for (const codec of [
			'vp09.02.10.8',
			'vp09.02.10.10.00',
			'vp09.02.10.10.00.01',
			'vp09.02.10.10.00.01.01.00',
			'av01.0.00M.08.0',
			'av01.0.00M.10.0.110',
			'av01.0.00M.10.0.110.01.01.00',
		]) {
			expect(acceptsVideoCodecString(codec), codec).toBe(false);
		}
	});
});

describe('Chromium media/base/mime_util_unittest.cc and audio_codecs.cc', () => {
	test('infers the codec of the strings ParseVideoCodecString and ParseAudioCodecString accept', () => {
		const cases: [string, string][] = [
			['avc3.42E01E', 'avc'],
			['avc1.42E01E', 'avc'],
			['vp09.00.10.08', 'vp9'],
			['vp09.02.10.10.01.06.06.06', 'vp9'],
			['vp8', 'vp8'],
			['opus', 'opus'],
			['Opus', 'opus'],
			['mp4a.40.2', 'aac'],
			['mp4a.40.02', 'aac'],
			['mp4a.40.5', 'aac'],
			['mp4a.40.29', 'aac'],
			['mp4a.40.42', 'aac'], // xHE-AAC
			['mp4a.67', 'aac'], // MPEG-2 AAC LC
			['flac', 'flac'],
			['vorbis', 'vorbis'],
			['mp3', 'mp3'],
			['mp4a.69', 'mp3'],
			['mp4a.6B', 'mp3'],
			['ac-3', 'ac3'],
			['ec-3', 'eac3'],
			['dtsc', 'dts'],
			['dtse', 'dts'],
		];
		for (const [codecString, codec] of cases) {
			expect(inferCodecFromCodecString(codecString), codecString).toBe(codec);
		}
	});

	test('infers no codec for ambiguous, made-up or MIME-type strings', () => {
		for (const codecString of ['', 'bogus', 'mp4a.40', 'theora', 'vp9', 'video/webm', 'aac']) {
			expect(inferCodecFromCodecString(codecString), codecString).toBe(null);
		}
	});
});

describe('Chromium media/formats/mp4/aac_unittest.cc', () => {
	const parse = (bytes: number[]) => parseAacAudioSpecificConfig(new Uint8Array(bytes));

	test('BasicProfileTest: AAC-LC, 44.1 kHz, stereo', () => {
		const config = parse([0x12, 0x10]);
		expect(config.objectType).toBe(2);
		expect(config.outputSampleRate).toBe(44100);
		expect(config.outputNumberOfChannels).toBe(2);
	});

	test('ExtensionTest: SBR and PS signaled behind the sync extension', () => {
		const config = parse([0x13, 0x08, 0x56, 0xe5, 0x9d, 0x48, 0x80]);
		expect(config.objectType).toBe(2);
		expect(config.coreSampleRate).toBe(24000);
		expect(config.outputSampleRate).toBe(48000);
		expect(config.outputNumberOfChannels).toBe(2); // PS upmixes the mono core
	});

	test('ImplicitSBR: without signaling, the core rate and channel count are reported', () => {
		// Chromium reports the same without assuming implicit SBR
		expect(parse([0x13, 0x08])).toMatchObject({ outputSampleRate: 24000, outputNumberOfChannels: 1 });
		expect(parse([0x13, 0x10])).toMatchObject({ outputSampleRate: 24000, outputNumberOfChannels: 2 });
	});

	test('SixChannelTest: channel configuration 6 is 5.1', () => {
		expect(parse([0x11, 0xb0])).toMatchObject({ outputSampleRate: 48000, outputNumberOfChannels: 6 });
	});

	test('DataTooShortTest', () => {
		expect(() => parse([])).toThrow(TypeError);
		expect(() => parse([0x12])).toThrow(TypeError);
	});

	test('IncorrectFrequencyTest and IncorrectChannelTest: valid neighbors parse', () => {
		expect(parse([0x0e, 0x08])).toMatchObject({ objectType: 1, outputSampleRate: 7350, outputNumberOfChannels: 1 });
		expect(parse([0x08, 0x08])).toMatchObject({ objectType: 1, outputSampleRate: 96000 });
		expect(parse([0x12, 0x18])).toMatchObject({ objectType: 2, outputNumberOfChannels: 3 });
	});

	test('reserved channel configurations and frequency indices yield no value instead of a wrong one', () => {
		// Chromium rejects these configs outright. Mediabunny leaves the value to the container.
		expect(parse([0x0e, 0x00]).outputNumberOfChannels).toBe(null); // Channel configuration 0 without a PCE
		expect(parse([0x12, 0x78]).outputNumberOfChannels).toBe(null); // Channel configuration 15
		expect(parse([0x17, 0x10]).outputSampleRate).toBe(null); // Frequency index 14
		const reservedExtension = parse([0x29, 0x17, 0x08, 0x00]); // Explicit SBR with extension frequency index 14
		expect(reservedExtension.objectType).toBe(5);
		expect(reservedExtension.outputSampleRate).toBe(null);
	});

	test('XHE_AAC: escaped object type 42', () => {
		const config = parse([
			0xf9, 0x46, 0x43, 0x22, 0x2c, 0xc0, 0x4c, 0x00, 0x85, 0xa0, 0x01, 0x13, 0x84, 0x00, 0x20, 0x00, 0x02, 0x50,
			0x01, 0x19, 0x72, 0xc0, 0x00,
		]);
		expect(config).toMatchObject({ objectType: 42, outputSampleRate: 48000, outputNumberOfChannels: 2 });
	});

	test('FitsInAdts_ExplicitFrequencyReturnsFalse: explicit 24-bit sampling frequency', () => {
		const config = parse([0x17, 0x80, 0x2b, 0x11, 0x10]);
		expect(config).toMatchObject({ frequencyIndex: 15, coreSampleRate: 22050, outputNumberOfChannels: 2 });
	});

	test('the configs above in an MP4 esds give the track sample rate and channel count', async () => {
		const cases: [number[], number, number][] = [
			[[0x12, 0x10], 44100, 2],
			[[0x13, 0x08, 0x56, 0xe5, 0x9d, 0x48, 0x80], 48000, 2],
			[[0x11, 0xb0], 48000, 6],
			[[0x11, 0x90], 48000, 2], // media/muxers/mp4_muxer_box_writer_unittest.cc, Mp4AacAudioSampleEntry
		];
		for (const [config, sampleRate, numberOfChannels] of cases) {
			const bytes = buildSingleTrackMp4({
				type: 'audio',
				// The sample entry deliberately claims something else
				sampleEntry: audioSampleEntry('mp4a', { channels: 1, sampleRate: 8000 }, esds({
					objectTypeIndication: 0x40,
					decoderSpecificInfo: new Uint8Array(config),
				})),
				timescale: sampleRate,
				samples: [{ data: new Uint8Array(10), duration: 1024 }],
			});
			using input = openBytes(bytes);
			const track = (await input.getPrimaryAudioTrack())!;
			expect(await track.getSampleRate(), toHex(new Uint8Array(config))).toBe(sampleRate);
			expect(await track.getNumberOfChannels(), toHex(new Uint8Array(config))).toBe(numberOfChannels);
		}
	});
});

describe('Chromium media/formats/mp4/es_descriptor_unittest.cc', () => {
	const openEsds = async (box: Uint8Array) => {
		const bytes = buildSingleTrackMp4({
			type: 'audio',
			sampleEntry: audioSampleEntry('mp4a', { channels: 2, sampleRate: 44100 }, box),
			timescale: 44100,
			samples: [{ data: new Uint8Array(10), duration: 1024 }],
		});
		const input = openBytes(bytes);
		return { input, track: (await input.getPrimaryAudioTrack())! };
	};

	test('SingleByteLengthTest and MultiByteLengthTest: descriptor sizes with continuation bytes', async () => {
		for (const lengthBytes of [1, 2, 3, 4]) {
			const { input, track } = await openEsds(esds({
				objectTypeIndication: 0x40,
				decoderSpecificInfo: new Uint8Array([0x12, 0x10]),
				lengthBytes,
			}));
			expect(await track.getCodec()).toBe('aac');
			const config = (await track.getDecoderConfig())!;
			expect([...new Uint8Array(config.description as ArrayBuffer)]).toEqual([0x12, 0x10]);
			expect(config.codec).toBe('mp4a.40.2');
			input.dispose();
		}
	});

	test('the byte sequence of SingleByteLengthTest', async () => {
		const descriptor = hexBytes('03 19 00 01 00 04 11 40 15 00 00 00 00 00 00 00 00 00 00 00 05 02 12 10 06 01 02');
		const { input, track } = await openEsds(box('esds', [0, 0, 0, 0], descriptor));
		expect(await track.getCodec()).toBe('aac');
		expect((await track.getDecoderConfig())!.codec).toBe('mp4a.40.2');
		input.dispose();
	});

	test('the byte sequence of MultiByteLengthTest', async () => {
		const descriptor = hexBytes(
			'03 80 19 00 01 00 04 80 80 11 40 15 00 00 00 00 00 00 00 00 00 00 00 05 80 80 80 02 12 10 06 01 02',
		);
		const { input, track } = await openEsds(box('esds', [0, 0, 0, 0], descriptor));
		expect(await track.getCodec()).toBe('aac');
		expect([...new Uint8Array((await track.getDecoderConfig())!.description as ArrayBuffer)]).toEqual([0x12, 0x10]);
		input.dispose();
	});

	test('NonAACTest: an MPEG-2 AAC Main object type indication is not read as AAC', async () => {
		const descriptor = hexBytes('03 19 00 01 00 04 11 66 15 00 00 00 00 00 00 00 00 00 00 00 05 02 12 10 06 01 02');
		const { input, track } = await openEsds(box('esds', [0, 0, 0, 0], descriptor));
		expect(await track.getCodec()).toBe(null);
		input.dispose();
	});

	test('maps the object type indications of ISO/IEC 14496-1 that Mediabunny supports', async () => {
		const cases: [number, string][] = [[0x40, 'aac'], [0x67, 'aac'], [0x69, 'mp3'], [0x6b, 'mp3']];
		for (const [objectTypeIndication, codec] of cases) {
			const { input, track } = await openEsds(esds({
				objectTypeIndication,
				decoderSpecificInfo: objectTypeIndication === 0x40 ? new Uint8Array([0x12, 0x10]) : undefined,
			}));
			expect(await track.getCodec(), objectTypeIndication.toString(16)).toBe(codec);
			input.dispose();
		}
	});
});

describe('Chromium media/formats/mp4/ac3_unittest.cc and eac3_unittest.cc', () => {
	const openAudio = async (type: string, configBox: Uint8Array) => {
		const bytes = buildSingleTrackMp4({
			type: 'audio',
			sampleEntry: audioSampleEntry(type, { channels: 2, sampleRate: 48000 }, configBox),
			timescale: 48000,
			samples: [{ data: new Uint8Array(10), duration: 1536 }],
		});
		const input = openBytes(bytes);
		return { input, track: (await input.getPrimaryAudioTrack())! };
	};

	test('derives the channel count from dac3', async () => {
		const cases: [number[], number][] = [
			[[0x50, 0x11, 0x40], 2], // NormalInputTest
			[[0x10, 0x08, 0xc0], 1], // ChannelLayout_Mono_Test
			[[0x10, 0x11, 0x40], 2], // ChannelLayout_Stereo_Test
			[[0x10, 0x19, 0xa0], 3], // ChannelLayout_Surround_Test
			[[0x10, 0x15, 0x40], 3], // ChannelLayout_2Point1_Test
			[[0x10, 0x31, 0xc0], 4], // ChannelLayout_2_2_Test
			[[0x10, 0x29, 0xc0], 4], // ChannelLayout_4_0_Test
			[[0x10, 0x39, 0xe0], 5], // ChannelLayout_5_0_Test
			[[0x10, 0x3d, 0xc0], 6], // ChannelLayout_5_1_Test
		];
		for (const [config, channels] of cases) {
			const { input, track } = await openAudio('ac-3', box('dac3', config));
			expect(await track.getCodec()).toBe('ac3');
			expect(await track.getNumberOfChannels(), toHex(new Uint8Array(config))).toBe(channels);
			expect(await track.getSampleRate()).toBe([48000, 44100, 32000][config[0]! >> 6]); // fscod
			input.dispose();
		}
	});

	test('derives the channel count from dec3 without dependent substreams', async () => {
		const cases: [number[], number][] = [
			[[0x06, 0xc8, 0x60, 0x04, 0x00], 2], // NormalInputTest
			[[0x03, 0x00, 0x20, 0x02, 0x00], 1], // ChannelLayout_Mono_Test
			[[0x06, 0x00, 0x20, 0x04, 0x00], 2], // ChannelLayout_Stereo_Test
			[[0x0a, 0x00, 0x20, 0x06, 0x00], 3], // ChannelLayout_Surround_Test
			[[0x06, 0x00, 0x20, 0x05, 0x00], 3], // ChannelLayout_2Point1_Test
			[[0x0c, 0x00, 0x20, 0x0c, 0x00], 4], // ChannelLayout_2_2_Test
			[[0x0c, 0x00, 0x20, 0x0a, 0x00], 4], // ChannelLayout_4_0_Test
			[[0x0e, 0x00, 0x20, 0x0e, 0x00], 5], // ChannelLayout_5_0_Test
			[[0x0e, 0x00, 0x20, 0x0f, 0x00], 6], // ChannelLayout_5_1_Test
		];
		for (const [config, channels] of cases) {
			const { input, track } = await openAudio('ec-3', box('dec3', config));
			expect(await track.getCodec()).toBe('eac3');
			expect(await track.getNumberOfChannels(), toHex(new Uint8Array(config))).toBe(channels);
			input.dispose();
		}
	});
});

describe('Chromium media/formats/mp4/box_reader_unittest.cc (AVCDecoderConfigurationRecord)', () => {
	const RECORD_FROM_MP4 = hexBytes(
		'01 64 00 0c ff e1 00 19 67 64 00 0c ac d9 41 41 fb 01 10 00 00 03 00 10 00 00 03 01 40 f1 42 99 60 01 00 06'
		+ ' 68 eb e3 cb 22 c0 fd f8 f8 00',
	);
	const RECORD_FROM_STREAM = hexBytes(
		'01 4d 00 15 ff e1 00 2f 67 4d 40 15 96 52 02 83 f6 02 a1 00 00 03 00 01 00 00 03 00 28 e0 60 03 0d 40 00 49'
		+ ' 3e 7f 18 e3 03 00 18 6a 00 02 49 f3 f8 c7 0e d0 b1 68 90 01 00 04 68 eb 73 52',
	);

	test('AVCDecoderConfigurationRecordTakenFromMp4: High profile record with its extension round-trips', () => {
		const record = deserializeAvcDecoderConfigurationRecord(RECORD_FROM_MP4)!;
		expect(record).toMatchObject({
			configurationVersion: 1,
			avcProfileIndication: 0x64,
			profileCompatibility: 0,
			avcLevelIndication: 0x0c,
			lengthSizeMinusOne: 3,
			chromaFormat: 1,
			bitDepthLumaMinus8: 0,
			bitDepthChromaMinus8: 0,
		});
		expect(record.sequenceParameterSets.map(x => x.length)).toEqual([25]);
		expect(record.pictureParameterSets.map(x => x.length)).toEqual([6]);
		expect(record.sequenceParameterSetExt).toEqual([]);
		expect(toHex(serializeAvcDecoderConfigurationRecord(record))).toBe(toHex(RECORD_FROM_MP4));
	});

	test('AVCDecoderConfigurationRecordTakenFromStream: Main profile record round-trips', () => {
		const record = deserializeAvcDecoderConfigurationRecord(RECORD_FROM_STREAM)!;
		expect(record.avcProfileIndication).toBe(0x4d);
		expect(record.chromaFormat).toBe(null); // No extension for Main profile
		expect(toHex(serializeAvcDecoderConfigurationRecord(record))).toBe(toHex(RECORD_FROM_STREAM));
	});

	test('AVCDecoderConfigurationRecordAllowsShortSpsEntry: a PPS in the SPS list does not break reading', async () => {
		// Real-world malformed avcC: the second "SPS" is a PPS
		const record = hexBytes(
			'01 64 00 1f ff e2 00 14 67 64 00 1f ac 1b 1a 80 90 0a 1e f9 b8 08 08 08 3c 22 11 a8 00 04 68 ea 43 cb'
			+ ' 01 00 04 68 ea 43 cb',
		);
		const parsed = deserializeAvcDecoderConfigurationRecord(record)!;
		expect(parsed.sequenceParameterSets.map(x => x[0]! & 0x1f)).toEqual([7, 8]);
		expect(parsed.pictureParameterSets.map(x => x[0]! & 0x1f)).toEqual([8]);

		const bytes = buildSingleTrackMp4({
			type: 'video',
			sampleEntry: visualSampleEntry('avc1', { width: 1280, height: 720 }, box('avcC', record)),
			timescale: 30,
			samples: [{ data: new Uint8Array([0, 0, 0, 1, 0x65]), duration: 1 }],
			width: 1280,
			height: 720,
		});
		using input = openBytes(bytes);
		const track = (await input.getPrimaryVideoTrack())!;
		expect((await track.getDecoderConfig())!.codec).toBe('avc1.64001f');
		expect(await track.getCodedWidth()).toBe(1280);
	});
});

describe('Chromium media/formats/mp4/hevc_unittest.cc', () => {
	// Also the record of media/muxers/mp4_muxer_box_writer_unittest.cc, Mp4MovieHEVCDecoderConfigurationRecord
	const RECORD = hexBytes(
		'01 01 60 00 00 00 80 00 00 00 00 00 3c f0 00 fc fd f8 f8 00 00 0f 03 20 00 01 00 18 40 01 0c 01 ff ff 01 60'
		+ ' 00 00 03 00 80 00 00 03 00 00 03 00 3c 95 c0 90 21 00 01 00 27 42 01 01 01 60 00 00 03 00 80 00 00 03 00'
		+ ' 00 03 00 3c a0 0a 08 0b 9f 79 65 79 24 ca e0 10 00 00 06 40 00 00 bb 50 80 22 00 01 00 06 44 01 c1 73 d1'
		+ ' 89',
	);

	test('HEVCDecoderConfigurationRecordTakenFromStream: the record round-trips', () => {
		const record = deserializeHevcDecoderConfigurationRecord(RECORD)!;
		expect(record.generalProfileIdc).toBe(1);
		expect(record.generalLevelIdc).toBe(60);
		expect(record.arrays.map(x => x.nalUnitType)).toEqual([32, 33, 34]);
		expect(toHex(serializeHevcDecoderConfigurationRecord(record))).toBe(toHex(RECORD));
	});

	test('the record gives the codec string and the dimensions of its SPS (320x180, from bear.hevc)', async () => {
		const bytes = buildSingleTrackMp4({
			type: 'video',
			sampleEntry: visualSampleEntry('hev1', { width: 320, height: 180 }, box('hvcC', RECORD)),
			timescale: 30,
			samples: [{ data: new Uint8Array([0, 0, 0, 2, 0x26, 0x01]), duration: 1 }],
			width: 320,
			height: 180,
		});
		using input = openBytes(bytes);
		const track = (await input.getPrimaryVideoTrack())!;
		expect((await track.getDecoderConfig())!.codec).toBe('hev1.1.6.L60.80');
		const sps = deserializeHevcDecoderConfigurationRecord(RECORD)!.arrays[1]!.nalUnits[0]!;
		expect(parseHevcSps(sps)).toMatchObject({ displayWidth: 320, displayHeight: 180 });
	});
});

describe('Chromium media/formats/mp4/avc_unittest.cc and hevc_unittest.cc (AnalyzeAnnexB)', () => {
	// The string notation of nalu_test_helper.cc: every token is a NAL unit consisting of its header only.
	const AVC_TYPES: Record<string, number> = {
		P: 1, SDA: 2, SDB: 3, SDC: 4, I: 5, SEI: 6, SPS: 7, PPS: 8, AUD: 9, EOSeq: 10, EOStr: 11, FILL: 12,
		SPSExt: 13, Prefix: 14, SubsetSPS: 15, DPS: 16,
	};
	const HEVC_TYPES: Record<string, number> = {
		P: 0, I: 19, SPS: 33, AUD: 35, EOS: 36, EOB: 37, FD: 38, PREFIX_SEI: 39,
	};
	const avcAccessUnit = (spec: string) => annexB(
		...spec.split(/[ ,]/).map(name => new Uint8Array([AVC_TYPES[name]!])),
	);
	const hevcAccessUnit = (spec: string) => annexB(
		...spec.split(/[ ,]/).map(name => new Uint8Array([HEVC_TYPES[name]! << 1, 1])),
	);
	const avcConfig = { codec: 'avc1.64001f', codedWidth: 16, codedHeight: 16 };
	const hevcConfig = { codec: 'hev1.1.6.L93.B0', codedWidth: 16, codedHeight: 16 };

	test('AVC: ValidAnnexBConstructs and the keyframe verdicts of InvalidAnnexBConstructs', () => {
		const cases: [string, boolean][] = [
			['I', true], ['I I I I', true], ['AUD I', true], ['AUD SPS PPS I', true], ['I EOSeq', true],
			['I EOSeq EOStr', true], ['I EOStr', true], ['P', false], ['P P P P', false], ['AUD SPS PPS P', false],
			['SEI SEI I', true], ['SEI SEI Prefix I', true], ['SPS SPSExt SPS PPS I P', true], ['Prefix SEI I', true],
			['AUD,I', true], ['AUD,SEI I', true], ['AUD,SEI,SPS,PPS,I', true],
			// A non-IDR slice before the IDR slice makes it no key frame
			['SDA SDB SDC', false], ['P I', false], ['SDA I', false], ['SDB I', false], ['SDC I', false],
			// Non-conformant orderings with a determinable verdict
			['SPS PPS AUD I', true], ['SPSExt SPS P', false], ['SPS PPS SPSExt P', false], ['I EOStr EOSeq', true],
			['I Prefix', true], ['I SEI', true], ['SEI AUD I', true], ['P SPS P', false],
		];
		for (const [spec, isKey] of cases) {
			expect(determineVideoPacketType('avc', avcConfig, avcAccessUnit(spec)), spec).toBe(isKey ? 'key' : 'delta');
		}
	});

	test('HEVC: ValidAnnexBConstructs and the keyframe verdicts of InvalidAnnexBConstructs', () => {
		const cases: [string, boolean][] = [
			['I', true], ['I I I I', true], ['AUD I', true], ['AUD SPS I', true], ['I EOS', true], ['I EOS EOB', true],
			['I EOB', true], ['P', false], ['P P P P', false], ['AUD SPS P', false], ['AUD,I', true],
			['AUD,SPS,I', true],
			['SPS AUD I', true], ['I EOB EOS', true], ['I SPS', true], ['FD PREFIX_SEI I', true],
			['PREFIX_SEI AUD I', true], ['P SPS P', false],
		];
		for (const [spec, isKey] of cases) {
			expect(determineVideoPacketType('hevc', hevcConfig, hevcAccessUnit(spec)), spec)
				.toBe(isKey ? 'key' : 'delta');
		}
	});

	test('access units without a slice count as delta packets (Chromium leaves them undetermined)', () => {
		for (const spec of ['AUD', 'AUD,SEI', 'SPS PPS', 'EOSeq', 'EOStr']) {
			expect(determineVideoPacketType('avc', avcConfig, avcAccessUnit(spec)), spec).toBe('delta');
		}
		for (const spec of ['AUD', 'AUD,SPS', 'EOS', 'EOB']) {
			expect(determineVideoPacketType('hevc', hevcConfig, hevcAccessUnit(spec)), spec).toBe('delta');
		}
	});
});

describe('Chromium media/parsers/h264_parser_unittest.cc', () => {
	// The SPS of the BBB 480p clone in H264SPSTest.MakeSPS_BBB480p, with optional frame cropping
	const bbb480pSps = (crop?: [number, number, number, number]) => {
		const writer = new BitWriter()
			.u(8, 100).u(8, 0).u(8, 30) // profile_idc, constraint flags, level_idc
			.ue(0) // seq_parameter_set_id
			.ue(1).ue(0).ue(0) // chroma_format_idc, bit_depth_luma_minus8, bit_depth_chroma_minus8
			.bit(0).bit(0) // qpprime_y_zero_transform_bypass_flag, seq_scaling_matrix_present_flag
			.ue(0) // log2_max_frame_num_minus4
			.ue(0).ue(2) // pic_order_cnt_type, log2_max_pic_order_cnt_lsb_minus4
			.ue(5).bit(0) // max_num_ref_frames, gaps_in_frame_num_value_allowed_flag
			.ue(52).ue(29) // pic_width_in_mbs_minus1, pic_height_in_map_units_minus1
			.bit(1).bit(1); // frame_mbs_only_flag, direct_8x8_inference_flag
		if (crop) {
			writer.bit(1).ue(crop[0]).ue(crop[1]).ue(crop[2]).ue(crop[3]);
		} else {
			writer.bit(0);
		}
		writer
			.bit(1) // vui_parameters_present_flag
			.bit(0).bit(0).bit(0).bit(0) // aspect ratio, overscan, video signal, chroma location
			.bit(1).u(32, 1).u(32, 48).bit(1) // timing info
			.bit(0).bit(0).bit(0) // NAL HRD, VCL HRD, pic_struct_present_flag
			.bit(1).bit(1).ue(0).ue(0).ue(10).ue(10).ue(2).ue(5); // bitstream_restriction
		return new Uint8Array([0x67, ...escapeRbsp(writer.rbsp())]);
	};

	test('GetCodedSize and GetVisibleRect of the BBB 480p SPS', () => {
		expect(parseAvcSps(bbb480pSps())).toMatchObject({
			profileIdc: 100,
			levelIdc: 30,
			codedWidth: 848,
			codedHeight: 480,
			displayWidth: 848,
			displayHeight: 480,
			numReorderFrames: 2,
			maxDecFrameBuffering: 5,
		});
		// Crop offsets are in 2-sample chroma units for 4:2:0
		expect(parseAvcSps(bbb480pSps([1, 2, 3, 4]))).toMatchObject({ displayWidth: 848 - 6, displayHeight: 480 - 14 });
		expect(parseAvcSps(bbb480pSps([422, 1, 0, 0]))).toMatchObject({ displayWidth: 2, displayHeight: 480 });
		// "Invalid crop": nothing is left
		expect(parseAvcSps(bbb480pSps([423, 1, 0, 0]))).toBe(null);
	});

	test('the SPS of test-25fps.h264', () => {
		const sps = hexBytes('274d400da918283e600d418041adb0ad7bdf01');
		expect(parseAvcSps(sps)).toMatchObject({
			profileIdc: 77,
			levelIdc: 13,
			chromaFormatIdc: 1,
			codedWidth: 320,
			codedHeight: 240,
			displayWidth: 320,
			displayHeight: 240,
			colourPrimaries: 6,
			transferCharacteristics: 1,
			matrixCoefficients: 6,
			fullRangeFlag: 0,
		});
	});
});

describe('Chromium media/parsers/h265_parser_unittest.cc', () => {
	test('SpsParsing: the SPS of bear.hevc, cropped by its conformance window', () => {
		// pic_width_in_luma_samples 320, pic_height_in_luma_samples 184, conf_win_bottom_offset 2
		const sps = hexBytes('42010101600000030080000003000003003ca00a080b9f79657924cae010000006400000bb5080');
		expect(parseHevcSps(sps)).toMatchObject({
			generalProfileIdc: 1,
			generalLevelIdc: 60,
			chromaFormatIdc: 1,
			bitDepthLumaMinus8: 0,
			bitDepthChromaMinus8: 0,
			displayWidth: 320,
			displayHeight: 180,
			spsMaxSubLayersMinus1: 0,
			maxDecFrameBuffering: 3, // sps_max_num_reorder_pics[0] is 2
			pixelAspectRatio: { num: 1, den: 1 },
		});
	});

	test('the SPS of bbb.hevc signals a 16:11 sample aspect ratio', () => {
		const sps = hexBytes('42010101600000030090000003000003003ca0162024596566924caf04010000030001000003003c08');
		expect(parseHevcSps(sps)).toMatchObject({
			displayWidth: 176,
			displayHeight: 144,
			pixelAspectRatio: { num: 16, den: 11 },
		});
	});
});

describe('Chromium media/parsers/vp9_parser_unittest.cc', () => {
	test('the key frames of test-25fps.vp9 and test-25fps.vp9_2', () => {
		// The first bytes of each file's first frame
		const firstFrame = hexBytes('824983420013f00ef61238241c18820007807fd1fa3e8fe7');
		expect(extractVp9CodecInfoFromPacket(firstFrame)).toMatchObject({
			profile: 0,
			bitDepth: 8,
			chromaSubsampling: 1,
			level: 20, // 320x240
		});
		const firstFrame2 = hexBytes('924983420009f8077b081c120e0c4f0003987fd1fa3e8fe7');
		expect(extractVp9CodecInfoFromPacket(firstFrame2)).toMatchObject({
			profile: 2,
			bitDepth: 10,
			chromaSubsampling: 1,
			level: 20,
		});
	});
});

describe('WebKit Tools/TestWebKitAPI/Tests/WebCore/AV1UtilitiesTests.cpp', () => {
	// A sequence header OBU with a minimal reduced_still_picture_header for a 2x2 stream
	const SEQUENCE_HEADER = [0x0a, 0x04, 0x18, 0x00, 0x30, 0x00];

	test('SequenceHeaderOBUExactlyFillsBuffer', () => {
		expect(extractAv1CodecInfoFromPacket(new Uint8Array(SEQUENCE_HEADER))).toMatchObject({
			profile: 0,
			level: 0,
			tier: 0,
			bitDepth: 8,
			monochrome: 0,
			chromaSubsamplingX: 1,
			chromaSubsamplingY: 1,
		});
	});

	test('SequenceHeaderOBUFollowedByTrailingData', () => {
		const info = extractAv1CodecInfoFromPacket(new Uint8Array([...SEQUENCE_HEADER, 0x12, 0x00]));
		expect(info).toMatchObject({ profile: 0, level: 0, bitDepth: 8 });
	});

	test('a still picture is a key frame', () => {
		const temporalUnit = new Uint8Array([...SEQUENCE_HEADER, 0x32, 0x01, 0x00]); // Followed by an OBU_FRAME
		expect(determineVideoPacketType('av1', { codec: 'av01.0.00M.08' }, temporalUnit)).toBe('key');
	});
});

describe('WebKit Tools/TestWebKitAPI/Tests/WebCore/H264UtilitiesTests.cpp', () => {
	test('ComputesZeroMaxNumReorderFramesWhenPicOrderCntTypeIsTwo: libwebrtc SPS with a bitstream restriction', () => {
		// pic_order_cnt_type 2, max_num_reorder_frames 0, max_dec_frame_buffering 1, 1280x720
		expect(parseAvcSps(hexBytes('67428020da014016e806d0a135'))).toMatchObject({
			profileIdc: 66,
			levelIdc: 32,
			codedWidth: 1280,
			codedHeight: 720,
			numReorderFrames: 0,
			maxDecFrameBuffering: 1,
		});
	});

	test('FindAVCCMaxNumReorderFramesReturnsNonZeroValueFromBitstreamRestriction', () => {
		const rbsp = new BitWriter()
			.u(8, 66).u(8, 0).u(8, 30).ue(0).ue(0).ue(0).ue(0).ue(0).bit(0).ue(0).ue(0).bit(1).bit(0).bit(0)
			.bit(1).bit(0).bit(0).bit(0).bit(0).bit(0).bit(0).bit(0).bit(0)
			.bit(1).bit(0).ue(0).ue(0).ue(0).ue(0).ue(2).ue(2)
			.bytes(); // The WebKit test writes no rbsp_trailing_bits either
		const sps = new Uint8Array([0x67, ...rbsp]);
		expect(parseAvcSps(sps)).toMatchObject({ codedWidth: 16, codedHeight: 16, numReorderFrames: 2 });

		// WebKit's record stops after the SPS; numOfPictureParameterSets is mandatory, so it gets a zero count here
		const avcc = new Uint8Array([0x01, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0x00, sps.length, ...sps, 0x00]);
		expect(deserializeAvcDecoderConfigurationRecord(avcc)!.sequenceParameterSets[0]).toEqual(sps);
	});

	test('the CABAC and weighted prediction streams of libwebrtc', () => {
		// aspect_ratio_idc 1 and an explicitly unspecified colour description
		expect(parseAvcSps(hexBytes('2764000dac5230507ec05a8101011856bdef8080'))).toMatchObject({
			profileIdc: 100,
			levelIdc: 13,
			displayWidth: 320,
			displayHeight: 240,
			pixelAspectRatio: { num: 1, den: 1 },
			colourPrimaries: 2,
			transferCharacteristics: 2,
			matrixCoefficients: 2,
		});
		// 1920x1088 cropped to 1080, BT.709, pic_order_cnt_type 2
		expect(parseAvcSps(hexBytes('67640028acb403c0113f2e02d4040405000003000100000300308f1832a000000004')))
			.toMatchObject({
				profileIdc: 100,
				levelIdc: 40,
				codedWidth: 1920,
				codedHeight: 1088,
				displayWidth: 1920,
				displayHeight: 1080,
				colourPrimaries: 1,
				transferCharacteristics: 1,
				matrixCoefficients: 1,
				fullRangeFlag: 0,
				numReorderFrames: 0,
				maxDecFrameBuffering: 1,
			});
	});

	test('records that are too short to hold an SPS are rejected', () => {
		expect(deserializeAvcDecoderConfigurationRecord(new Uint8Array([0x01, 0x42, 0x00, 0x1f, 0xff, 0xe1])))
			.toBe(null);
	});
});

describe('WebKit Tools/TestWebKitAPI/Tests/WebCore/HEVCUtilitiesTests.cpp (libwebrtc streams)', () => {
	test('the SPS of each stream (dimensions checked against FFmpeg)', () => {
		// kH265VpsSpsPps: Format Range Extensions profile, 4:2:2, 1920x1080
		expect(parseHevcSps(hexBytes(
			'4201010408000003009d08000003000078b003c08010e596566924cae010000003001000000301e080',
		))).toMatchObject({
			generalProfileIdc: 4,
			generalLevelIdc: 120,
			chromaFormatIdc: 2,
			bitDepthLumaMinus8: 0,
			displayWidth: 1920,
			displayHeight: 1080,
		});
		// kH265SliceStrChunk: 2560x1600, level 5.1
		expect(parseHevcSps(hexBytes(
			'42010101000003000003000003000003000099a00140200641fe5949264d861622aa4c4c32fb3ebcdf967d7851189cbb20',
		))).toMatchObject({ generalLevelIdc: 153, displayWidth: 2560, displayHeight: 1600 });
	});
});

describe('ITU-T H.264 and H.265 conformance bitstreams (FFmpeg FATE suite: h264-conformance, hevc-conformance)', () => {
	// The first SPS of a selection of the conformance streams FATE decodes, one per profile, chroma format, bit depth,
	// cropping and VUI feature. The expected values are FFmpeg's (ffprobe -show_streams on the stream): display size,
	// pix_fmt (chroma format and bit depth), profile and level.
	type Row = [name: string, sps: string, width: number, height: number, chromaFormat: number, bitDepth: number,
		profile: number, level: number];

	test('H.264 SPS fields match FFmpeg', () => {
		const rows: Row[] = [
			[
				'AUD_MW_E.264',
				'6742e00a96528589c8',
				176, 144, 1, 8, 66, 10,
			],
			[
				'BA3_SVA_C.264',
				'675860158d94c16272',
				176, 144, 1, 8, 88, 21,
			],
			[
				'CABA1_SVA_B.264',
				'674d40158d94c16262',
				176, 144, 1, 8, 77, 21,
			],
			[
				'CVFC1_Sony_C.jsv',
				'2742e01f8d8d302c12e38707c3e8',
				300, 168, 1, 8, 66, 31,
			],
			[
				'CVSE2_Sony_B.jsv',
				'2742e0158d8d6162742000007d20001d4c1c0000030249f00000493e03ef706000003d0900001e8481f7b81f183258',
				176, 144, 1, 8, 66, 21,
			],
			[
				'CVSE3_Sony_H.jsv',
				'274d60158d8d38589d0800001f480007530700000300927c0000124f80fbdc1800000f42400007a1207dee07c60c28d8',
				176, 144, 1, 8, 77, 21,
			],
			[
				'FRext/FRExt1_Panasonic.avc',
				'67640015ad9464763b8ac4444a398e6820d2145464694647263b8a4c4455088acdcd9a6a14c42429b66488cd42229337'
				+ '3266889444cd1b9bc57c9f93f9bf27c9e4e4cd251a4689c9ebe4fd7f27ebe4f5c9a90b6c160944',
				352, 288, 1, 8, 100, 21,
			],
			[
				'FRext/HPCAMOLQ_BRCM_B.264',
				'27640028f6120f363c22090644c1587040bfffffffff04861820128605b141d04c1b0e870e14ffffffffe16618098487'
				+ '0370441c07a1c4180c874160c062281407c360b048b0b02f0c14c5921c04a3415102a301382c09c81f120a0402320260'
				+ '5b080a052405c3c280849ffffffffffffffff1b2a0582590',
				352, 288, 0, 8, 100, 40,
			],
			[
				'FRext/Hi422FR10_SONY_B.264',
				'677a0028bce6058259',
				352, 288, 2, 8, 122, 40,
			],
			[
				'FRext/Hi422FR13_SONY_B.264',
				'677a0028b6ce60582590',
				352, 288, 2, 10, 122, 40,
			],
			[
				'FRext/PPH10I2_Panasonic_A.264',
				'676e1020a6cd405005b9',
				1280, 720, 1, 10, 110, 32,
			],
			[
				'sp2_bt_b.h264',
				'6758200ad1d241627403c709b8',
				176, 144, 1, 8, 88, 10,
			],
		];
		for (const [name, hex, width, height, chromaFormat, bitDepth, profile, level] of rows) {
			const info = parseAvcSps(hexBytes(hex));
			expect(info, name).not.toBe(null);
			expect({
				width: info!.displayWidth,
				height: info!.displayHeight,
				chromaFormat: info!.chromaFormatIdc,
				bitDepth: info!.bitDepthLumaMinus8 + 8,
				profile: info!.profileIdc,
				level: info!.levelIdc,
			}, name).toEqual({ width, height, chromaFormat, bitDepth, profile, level });
		}
	});

	test('H.265 SPS fields match FFmpeg', () => {
		const rows: Row[] = [
			[
				'CONFWIN_A_Sony_1.bit',
				'420101214000000300100000030000030078a00d080f1a49634d6493222a92f2ee0500001f480003a980f84e08408000'
				+ '5b8d80002dc6c0000989680004c4b557080410',
				412, 236, 1, 8, 1, 120,
			],
			[
				'Main_422_10_A_RExt_Sony_1.bin',
				'4201020408000003000d080000030000780000b003c08010e7ed9657293248db0d2c4554989865f67d79bf2cfaf0a231'
				+ '3976d80044',
				1920, 1080, 2, 10, 4, 120,
			],
			[
				'PERSIST_RPARAM_A_RExt_Sony_3.bit',
				'420101040800000300082800000300005a90019100c0fca52fa69b6cf6d80f34',
				400, 384, 3, 12, 4, 90,
			],
			[
				'TSCL_A_VIDYO_5.bit',
				'4201060160000003000003000003000003003f0000a00d080f1fe5bc8a57313248db0e7111134488926d4454932623a9'
				+ '223d4472444aaaa23d575156aab9446272f7f5f640',
				416, 240, 1, 8, 1, 63,
			],
			[
				'VPSID_A_VIDYO_2.bit',
				'4201440160000003000003000003000003005d0000a00d080f1fe5932e5e491b60817924922d4924917a9248924924bf'
				+ '9fe4ffcff99ffe3640',
				416, 240, 1, 8, 1, 93,
			],
			[
				'IPCM_A_RExt_NEC.bit',
				'4201010408000003000d0800000300003cb00d080f1fb65f9247577a3db60011',
				416, 240, 2, 10, 4, 60,
			],
			[
				'ipcm_A_NEC_3.bit',
				'4201010160000003000003000003000003003ca00d080f1fe5f9247577b2d1',
				416, 240, 1, 8, 1, 60,
			],
			[
				'NoOutPrior_A_Qualcomm_1.bit',
				'4201010160000003000003000003000003005da0068201e1fe59499246d869622aa4c4c32fb3ebcdf967d7851189cbb6'
				+ '40',
				832, 480, 1, 8, 1, 93,
			],
			[
				'ADJUST_IPRED_ANGLE_A_RExt_Mitsubishi_1.bit',
				'4201010408000003000d080000030000bab003c08010e7ed97e491b67b6c079a',
				1920, 1080, 2, 10, 4, 186,
			],
			[
				'AMP_A_Samsung_6.bit',
				'42010100a00000030000030000030000030099a00140200641fe59494e46d869622aa4c4c32fb3ebcdf967d7851189cb'
				+ 'b640',
				2560, 1600, 1, 8, 0, 153,
			],
			[
				'BUMPING_A_ericsson_1.bit',
				'42010601600000030080000003000003005a0000a00d080f1659b3299cc5c96917200fe10082',
				416, 240, 1, 8, 1, 90,
			],
			[
				'IPRED_B_Nokia_3.bit',
				'42010103700000030000030000030000030078a003c08010e7f97e491b65b2',
				1920, 1080, 1, 8, 3, 120,
			],
			[
				'IPCM_B_RExt_NEC.bit',
				'420101040800000300080800000300003c9001a101e3f294bf248eaef47b6c0022',
				416, 240, 3, 12, 4, 60,
			],
		];
		for (const [name, hex, width, height, chromaFormat, bitDepth, profile, level] of rows) {
			const info = parseHevcSps(hexBytes(hex));
			expect(info, name).not.toBe(null);
			expect({
				width: info!.displayWidth,
				height: info!.displayHeight,
				chromaFormat: info!.chromaFormatIdc,
				bitDepth: info!.bitDepthLumaMinus8 + 8,
				profile: info!.generalProfileIdc,
				level: info!.generalLevelIdc,
			}, name).toEqual({ width, height, chromaFormat, bitDepth, profile, level });
		}
	});
});

describe('web-platform-tests webcodecs/videoDecoder-codec-specific-setup.js and audioDecoder-codec-specific', () => {
	// The WPT files (copied to test/public/wpt-webcodecs, see that directory's commands in WPT's README.md) come with
	// the decoder config and the byte ranges of the first chunks, which browsers decode in those tests. Mediabunny has
	// to hand out exactly these bytes.
	type Range = { offset: number; size: number; key?: boolean };
	const ranges = (pairs: [number, number][]) => pairs.map(([offset, size]) => ({ offset, size }));
	const loadWpt = (name: string) => new Uint8Array(
		readFileSync(path.join(__dirname, '..', 'public/wpt-webcodecs', name)),
	);
	const slice = (bytes: Uint8Array, range: Range) => bytes.subarray(range.offset, range.offset + range.size);

	const videoCases: {
		src: string;
		codec: string | RegExp;
		description?: Range;
		chunks: Range[];
	}[] = [
		{
			src: 'av1.mp4',
			// WPT configures 'av01.0.04M.08', but the file's av1C and sequence header say seq_level_idx 0
			codec: 'av01.0.00M.08',
			chunks: ranges([
				[48, 1938], [1986, 848], [2834, 3], [2837, 47], [2884, 3], [2887, 116], [3003, 3], [3006, 51],
				[3057, 25], [3082, 105],
			]),
		},
		{
			src: 'vp8.webm',
			codec: 'vp8',
			chunks: ranges([
				[522, 4826], [5355, 394], [5756, 621], [6384, 424], [6815, 532], [7354, 655], [8016, 670],
				[8693, 2413], [11113, 402], [11522, 686],
			]),
		},
		{
			src: 'vp9.mp4',
			// WPT configures 'vp09.00.10.08' ("TODO: Verify that the file is actually level 1"); its vpcC says level 20
			// and unspecified colour, which the codec string carries
			codec: 'vp09.00.20.08.01.02.02.02.00',
			chunks: ranges([
				[44, 3315], [3359, 203], [3562, 245], [3807, 172], [3979, 312], [4291, 170], [4461, 195], [4656, 181],
				[4837, 356], [5193, 159],
			]),
		},
		{
			src: 'h264.mp4',
			codec: 'avc1.64000b',
			description: { offset: 9490, size: 45 },
			chunks: ranges([
				[48, 4140], [4188, 604], [4792, 475], [5267, 561], [5828, 587], [6415, 519], [6934, 532], [7466, 523],
				[7989, 454], [8443, 528],
			]),
		},
		{
			src: 'h264_sei.mp4',
			codec: 'avc1.64000c', // From the avcC; WPT configures avc1.64000b
			description: { offset: 11989, size: 46 },
			chunks: [
				{ offset: 48, size: 4229, key: true }, ...ranges([[4277, 1114], [5391, 320], [5711, 188], [5899, 173]]),
				// An open-GOP I frame with a recovery point SEI, which the container marks as a sync sample
				{ offset: 6072, size: 3694, key: true },
				...ranges([[9766, 936], [10702, 345], [11047, 213], [11260, 210]]),
			],
		},
		{
			src: 'h265.mp4',
			// The sample entry is hvc1; WPT configures the hev1 form, which decoders accept just the same
			codec: /^(hev1|hvc1)\.1\.6\.L60\.90$/,
			description: { offset: 5821, size: 2406 },
			chunks: ranges([
				[44, 2515], [2559, 279], [2838, 327], [3165, 329], [3494, 308], [3802, 292], [4094, 352], [4446, 296],
				[4742, 216], [4958, 344],
			]),
		},
		{
			src: 'h264_interlaced.mp4',
			codec: 'avc1.640015', // From the avcC; WPT configures avc1.64000b
			description: { offset: 7501, size: 47 },
			chunks: ranges([
				[48, 4091], [4139, 949], [5088, 260], [5348, 134], [5482, 111], [5593, 660], [6253, 197], [6450, 96],
				[6546, 159], [6705, 277],
			]),
		},
		{
			src: 'h264_444.mp4',
			codec: 'avc1.f4000c',
			// WPT hands out the first 42 bytes; the avcC holds 4 more for the High 4:4:4 Predictive extension
			description: { offset: 7546, size: 46 },
			chunks: ranges([
				[48, 3653], [3701, 996], [4697, 345], [5042, 197], [5239, 167], [5406, 669], [6075, 272], [6347, 160],
				[6507, 179], [6686, 341],
			]),
		},
	];

	for (const { src, codec, description, chunks } of videoCases) {
		test(`decoder config and first chunks of ${src}`, async () => {
			const bytes = loadWpt(src);
			using input = openBytes(bytes);
			const track = (await input.getPrimaryVideoTrack())!;
			const config = (await track.getDecoderConfig())!;
			if (codec instanceof RegExp) {
				expect(config.codec).toMatch(codec);
			} else {
				expect(config.codec).toBe(codec);
			}
			expect(config.codedWidth).toBe(320);
			expect(config.codedHeight).toBe(240);
			expect(await track.getDisplayWidth()).toBe(320);
			expect(await track.getDisplayHeight()).toBe(240);
			if (description) {
				expect(toHex(new Uint8Array(config.description as ArrayBuffer))).toBe(toHex(slice(bytes, description)));
			} else {
				expect(config.description).toBeUndefined();
			}

			const sink = new EncodedPacketSink(track);
			let i = 0;
			for await (const packet of sink.packets()) {
				const chunk = chunks[i]!;
				expect(packet.data.length, `${src} chunk ${i}`).toBe(chunk.size);
				expect(toHex(packet.data) === toHex(slice(bytes, chunk)), `${src} chunk ${i}`).toBe(true);
				if (i === 0 || chunk.key) {
					expect(packet.type, `${src} chunk ${i}`).toBe('key');
				}
				if (++i === chunks.length) {
					break;
				}
			}
			expect(i).toBe(chunks.length);
		});
	}

	const audioCases: {
		src: string;
		codec: string;
		description?: Range | (number | Range)[];
		chunks?: Range[];
		pcmDataOffset?: number;
		firstTimestamps: number[];
	}[] = [
		{
			src: 'sfx.adts',
			codec: 'mp4a.40.2',
			chunks: ranges([
				[0, 248], [248, 280], [528, 258], [786, 125], [911, 230], [1141, 148], [1289, 224], [1513, 166],
				[1679, 216], [1895, 183],
			]),
			firstTimestamps: [0, 1024, 2048],
		},
		{
			src: 'sfx.mp3',
			codec: 'mp3',
			chunks: [333, 621, 909, 1197, 1485, 1773, 2061, 2349, 2637, 2925].map(offset => ({ offset, size: 288 })),
			// The LAME tag's encoder delay (576 + 529 decoder delay) puts the first frame before zero; FFmpeg signals
			// the same 1105 samples as skip_samples
			firstTimestamps: [-1105, 1152 - 1105, 2304 - 1105],
		},
		{
			src: 'sfx-aac.mp4',
			codec: 'mp4a.40.2',
			description: { offset: 2552, size: 5 },
			chunks: ranges([
				[44, 241], [285, 273], [558, 251], [809, 118], [927, 223], [1150, 141], [1291, 217], [1508, 159],
				[1667, 209], [1876, 176],
			]),
			firstTimestamps: [-1024, 0, 1024], // The edit list skips the encoder delay of one frame
		},
		{
			src: 'sfx-opus.ogg',
			codec: 'opus',
			description: { offset: 28, size: 19 },
			chunks: ranges([
				[185, 450], [635, 268], [903, 285], [1188, 296], [1484, 287], [1771, 308], [2079, 289], [2368, 286],
				[2654, 296], [2950, 294],
			]),
			firstTimestamps: [-312, 960 - 312, 1920 - 312], // Pre-skip 312
		},
		{
			src: 'sfx.flac',
			codec: 'flac',
			// WPT hands out all metadata blocks (8287 bytes); Mediabunny's description is the marker and STREAMINFO
			description: [0x66, 0x4c, 0x61, 0x43, 0x80, { offset: 5, size: 37 }],
			chunks: ranges([[8288, 2276], [10564, 2038], [12602, 521]]),
			firstTimestamps: [0, 4608, 9216],
		},
		{
			src: 'sfx-vorbis.ogg',
			codec: 'vorbis',
			// Xiph lacing of the three header packets
			description: [2, 30, 62, { offset: 28, size: 30 }, { offset: 101, size: 62 }, { offset: 163, size: 3771 }],
			chunks: ranges([[3968, 44], [4012, 21], [4033, 57], [4090, 37], [4127, 37], [4164, 107], [4271, 172]]),
			firstTimestamps: [-128, 0, 128],
		},
		{ src: 'sfx-ulaw.wav', codec: 'ulaw', pcmDataOffset: 0x5c, firstTimestamps: [0, 2048, 4096] },
		{ src: 'sfx-alaw.wav', codec: 'alaw', pcmDataOffset: 0x5c, firstTimestamps: [0, 2048, 4096] },
		{ src: 'sfx-pcm-u8.wav', codec: 'pcm-u8', pcmDataOffset: 0x4e, firstTimestamps: [0, 2048, 4096] },
		{ src: 'sfx-pcm-s16.wav', codec: 'pcm-s16', pcmDataOffset: 0x4e, firstTimestamps: [0, 2048, 4096] },
		{ src: 'sfx-pcm-s24.wav', codec: 'pcm-s24', pcmDataOffset: 0x66, firstTimestamps: [0, 2048, 4096] },
		{ src: 'sfx-pcm-s32.wav', codec: 'pcm-s32', pcmDataOffset: 0x66, firstTimestamps: [0, 2048, 4096] },
		{ src: 'sfx-pcm-f32.wav', codec: 'pcm-f32', pcmDataOffset: 0x72, firstTimestamps: [0, 2048, 4096] },
	];

	for (const { src, codec, description, chunks, pcmDataOffset, firstTimestamps } of audioCases) {
		test(`decoder config and first chunks of ${src}`, async () => {
			const bytes = loadWpt(src);
			using input = openBytes(bytes);
			const track = (await input.getPrimaryAudioTrack())!;
			const config = (await track.getDecoderConfig())!;
			expect(config.codec).toBe(codec);
			expect(config.sampleRate).toBe(48000);
			expect(config.numberOfChannels).toBe(1);
			if (description) {
				const expected = Array.isArray(description)
					? new Uint8Array(description.flatMap(
						part => typeof part === 'number' ? [part] : [...slice(bytes, part)],
					))
					: slice(bytes, description);
				expect(toHex(new Uint8Array(config.description as ArrayBuffer))).toBe(toHex(expected));
			}

			const sink = new EncodedPacketSink(track);
			const timestamps: number[] = [];
			let i = 0;
			for await (const packet of sink.packets()) {
				if (i < 3) {
					timestamps.push(Math.round(packet.timestamp * 48000));
				}
				if (chunks) {
					expect(toHex(packet.data) === toHex(slice(bytes, chunks[i]!)), `${src} chunk ${i}`).toBe(true);
				} else if (i === 0) {
					const expected = bytes.subarray(pcmDataOffset, pcmDataOffset! + 64);
					expect(toHex(packet.data.subarray(0, 64))).toBe(toHex(expected));
				}
				if (++i === (chunks?.length ?? 3)) {
					break;
				}
			}
			expect(timestamps).toEqual(firstTimestamps);
		});
	}
});

describe('Chromium media/formats/webm/webm_parser_unittest.cc and webm_cluster_parser_unittest.cc', () => {
	type Packet = { timestamp: number; duration: number };

	// Timestamps and durations in milliseconds, per track type
	const readPackets = async (bytes: Uint8Array) => {
		using input = openBytes(bytes);
		const result: Partial<Record<'video' | 'audio' | 'subtitle', Packet[]>> = {};
		for (const track of await input.getTracks()) {
			const packets: Packet[] = [];
			for await (const packet of new EncodedPacketSink(track).packets()) {
				packets.push({
					timestamp: Math.round(packet.timestamp * 1000),
					duration: Math.round(packet.duration * 1000),
				});
			}
			result[track.type] = packets;
		}
		return result;
	};
	const videoTimestamps = async (bytes: Uint8Array) => (await readPackets(bytes)).video!.map(x => x.timestamp);

	const cluster = (timestamp: number, ...blocks: Uint8Array[]) => ebml(
		EBML.Cluster,
		ebmlUint(EBML.Timestamp, timestamp),
		...blocks.map(block => ebml(EBML.SimpleBlock, block)),
	);
	const keyFrame = (relativeTimestamp: number) => blockPayload(1, relativeTimestamp, 0x80, vp8Frame(true));
	const deltaFrame = (relativeTimestamp: number) => blockPayload(1, relativeTimestamp, 0, vp8Frame(false));

	test('VoidAndCRC32InList: Void and CRC-32 elements are skipped in the Segment and in a Cluster', async () => {
		const bytes = buildWebm({ tracks: [webmVideoTrack(1)], body: [
			ebml(EBML.Void, [0, 0, 0]),
			ebml(EBML.Crc32, [0, 0, 0, 0]),
			ebml(
				EBML.Cluster,
				ebml(EBML.Crc32, [0, 0, 0, 0]),
				ebml(EBML.Void, [0, 0, 0]),
				ebmlUint(EBML.Timestamp, 0),
				ebml(EBML.SimpleBlock, keyFrame(0)),
				ebml(EBML.Void, [0, 0, 0]),
				ebml(EBML.SimpleBlock, deltaFrame(33)),
			),
		] });
		expect(await videoTimestamps(bytes)).toEqual([0, 33]);
	});

	test('EmptyClusterInSegment: an empty Cluster between two others', async () => {
		const bytes = buildWebm({ tracks: [webmVideoTrack(1)], body: [
			cluster(0, keyFrame(0)),
			ebml(EBML.Cluster),
			cluster(33, deltaFrame(0)),
		] });
		expect(await videoTimestamps(bytes)).toEqual([0, 33]);
	});

	test('ReservedSizes: a Cluster of unknown size, ended by the next Cluster', async () => {
		for (const sizeLength of [1, 8]) {
			const bytes = buildWebm({ tracks: [webmVideoTrack(1)], body: [
				ebmlUnknownSize(
					EBML.Cluster,
					sizeLength,
					ebmlUint(EBML.Timestamp, 0),
					ebml(EBML.SimpleBlock, keyFrame(0)),
					ebml(EBML.SimpleBlock, deltaFrame(33)),
				),
				cluster(66, deltaFrame(0)),
			] });
			expect(await videoTimestamps(bytes), `${sizeLength}-byte size`).toEqual([0, 33, 66]);
		}
	});

	test('ZeroPaddedStrings: DocType and CodecID padded with zero bytes', async () => {
		const track = ebml(
			EBML.TrackEntry,
			ebmlUint(EBML.TrackNumber, 1),
			ebmlUint(EBML.TrackUID, 1),
			ebmlUint(EBML.TrackType, 1),
			ebml(EBML.CodecID, ascii('V_VP8\0\0')),
			ebml(EBML.Video, ebmlUint(EBML.PixelWidth, 16), ebmlUint(EBML.PixelHeight, 16)),
		);
		const bytes = buildWebm({ docType: 'webm\0\0', tracks: [track], body: [cluster(0, keyFrame(0))] });
		using input = openBytes(bytes);
		expect(await (await input.getPrimaryVideoTrack())!.getCodec()).toBe('vp8');
	});

	test('ChildNonListLargerThanParent: a Cluster whose Timestamp runs past its end', async () => {
		const bytes = buildWebm({ tracks: [webmVideoTrack(1)], body: [
			cluster(0, keyFrame(0)),
			hexBytes('1f43b675 81 e7 81 01'), // Cluster (size 1) holding a Timestamp (size 1)
			cluster(33, deltaFrame(0)),
		] });
		expect(await videoTimestamps(bytes)).toEqual([0, 33]);
	});

	test('ParseWithoutAnyDurations{SimpleBlocks,BlockGroups}: a block lasts until the next of its track', async () => {
		// Without BlockDuration or DefaultDuration. (For the last block of each track in a cluster, Chromium estimates
		// the largest duration seen so far; that isn't asserted here.)
		const blocks: [track: number, timestamp: number][] = [
			[1, 0], [1, 23], [2, 33], [1, 45], [2, 66], [1, 68], [2, 100],
		];
		const frame = (track: number, timestamp: number) => blockPayload(
			track,
			timestamp,
			0x80,
			track === 1 ? new Array<number>(96).fill(0) : vp8Frame(true),
		);
		const tracks = [webmAudioTrack(1), webmVideoTrack(2)];
		for (const blockGroups of [false, true]) {
			const bytes = buildWebm({ tracks, body: [
				ebml(
					EBML.Cluster,
					ebmlUint(EBML.Timestamp, 0),
					...blocks.map(([track, timestamp]) => blockGroups
						? ebml(EBML.BlockGroup, ebml(EBML.Block, frame(track, timestamp)))
						: ebml(EBML.SimpleBlock, frame(track, timestamp))),
				),
			] });
			const packets = await readPackets(bytes);
			expect(packets.audio!.slice(0, -1), `BlockGroups: ${blockGroups}`).toEqual([
				{ timestamp: 0, duration: 23 },
				{ timestamp: 23, duration: 22 },
				{ timestamp: 45, duration: 23 },
			]);
			expect(packets.video!.slice(0, -1), `BlockGroups: ${blockGroups}`).toEqual([
				{ timestamp: 33, duration: 33 },
				{ timestamp: 66, duration: 34 },
			]);
		}
	});
});

describe('Chromium media/formats/webm/opus_packet_builder.cc (Opus packet durations from the TOC byte)', () => {
	test('every configuration with 1 to 48 frames, with and without VBR', () => {
		// WebMClusterParser::kOpusFrameDurationsMu, in microseconds
		const frameDurationsUs = [
			10000, 20000, 40000, 60000, 10000, 20000, 40000, 60000,
			10000, 20000, 40000, 60000, 10000, 20000, 10000, 20000,
			2500, 5000, 10000, 20000, 2500, 5000, 10000, 20000,
			2500, 5000, 10000, 20000, 2500, 5000, 10000, 20000,
		];
		for (let frameCount = 1; frameCount <= 48; frameCount++) {
			for (let config = 0; config < 32; config++) {
				for (const vbr of frameCount >= 2 ? [false, true] : [false]) {
					const code = frameCount === 1 ? 0 : frameCount === 2 ? (vbr ? 2 : 1) : 3;
					const frameCountByte = code === 3 ? [(vbr ? 0x80 : 0) | frameCount] : [];
					const packet = new Uint8Array([(config << 3) | code, ...frameCountByte, 0]);
					expect(parseOpusTocByte(packet).durationInSamples, `config ${config}, ${frameCount} frames`)
						.toBe(frameCount * frameDurationsUs[config]! * 48 / 1000);
				}
			}
		}
	});
});

describe('Chromium media/formats/mp4/track_run_iterator_unittest.cc', () => {
	// The fragment Chromium's tests build: a 25 Hz video track whose samples have durations and sizes 1, 2, ..., 10,
	// a sync first sample and non-sync others, and a 48 kHz audio track. The movie timescale is 1000.
	const avcEntry = visualSampleEntry('avc1', { width: 320, height: 240 }, box('avcC', hexBytes(
		'01 64 00 0c ff e1 00 19 67 64 00 0c ac d9 41 41 fb 01 10 00 00 03 00 10 00 00 03 01 40 f1 42 99 60 01 00 06'
		+ ' 68 eb e3 cb 22 c0 fd f8 f8 00',
	)));
	const aacEntry = audioSampleEntry(
		'mp4a',
		{ channels: 2, sampleRate: 48000 },
		esds({ objectTypeIndication: 0x40, decoderSpecificInfo: new Uint8Array([0x11, 0x90]) }),
	);
	const US = sampleFlags({ dependsOn: 0, nonSync: false });
	const UN = sampleFlags({ dependsOn: 0, nonSync: true });
	const ascending = Array.from({ length: 10 }, (_, i) => i + 1);
	const videoSamples = (compositionTimeOffsets?: number[]) => ascending.map((value, i) => ({
		duration: value,
		size: value,
		flags: i === 0 ? US : UN,
		...(compositionTimeOffsets ? { compositionTimeOffset: compositionTimeOffsets[i] ?? 0 } : {}),
	}));

	// Packets as [timestamp, duration, size, isKey], with times in the given timescale
	const readPackets = async (bytes: Uint8Array, timescale: number) => {
		using input = openBytes(bytes);
		const track = (await input.getTracks())[0]!;
		const packets: [number, number, number, boolean][] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push([
				Math.round(packet.timestamp * timescale),
				Math.round(packet.duration * timescale),
				packet.data.length,
				packet.type === 'key',
			]);
		}
		return packets;
	};

	test('BasicOperationTest: decode times continue from tfdt', async () => {
		const bytes = buildFragmentedMp4({
			type: 'video',
			sampleEntry: avcEntry,
			timescale: 25,
			fragments: [{ baseDecodeTime: 10, samples: videoSamples() }],
		});
		expect((await readPackets(bytes, 25)).slice(0, 3)).toEqual([
			[10, 1, 1, true],
			[11, 2, 2, false],
			[13, 3, 3, false],
		]);
	});

	test('TrackExtendsDefaultsTest: trex defaults apply when tfhd and trun give none', async () => {
		const bytes = buildFragmentedMp4({
			type: 'audio',
			sampleEntry: aacEntry,
			timescale: 48000,
			trex: { duration: 50, size: 3, flags: UN },
			fragments: [{ baseDecodeTime: 0, samples: ascending.map(() => ({})) }],
		});
		// Chromium also reports the non-sync audio samples as non-key
		expect((await readPackets(bytes, 48000)).slice(0, 2)).toEqual([
			[0, 50, 3, false],
			[50, 50, 3, false],
		]);
	});

	test('FirstSampleFlagTest: first_sample_flags override the defaults for the first sample only', async () => {
		const video = buildFragmentedMp4({
			type: 'video',
			sampleEntry: avcEntry,
			timescale: 25,
			fragments: [{
				baseDecodeTime: 10,
				defaults: { flags: UN },
				firstSampleFlags: US,
				samples: ascending.map(value => ({ duration: value, size: value })),
			}],
		});
		expect((await readPackets(video, 25)).map(packet => packet[3])).toEqual(ascending.map(value => value === 1));

		const audio = buildFragmentedMp4({
			type: 'audio',
			sampleEntry: aacEntry,
			timescale: 48000,
			fragments: [{
				baseDecodeTime: 0,
				defaults: { flags: US, duration: 1024, size: 4 },
				samples: ascending.map(value => ({ size: value })),
			}],
		});
		const audioPackets = await readPackets(audio, 48000);
		expect(audioPackets.map(packet => packet[3])).toEqual(ascending.map(() => true));
		expect(audioPackets.map(packet => packet[0])).toEqual(ascending.map(value => (value - 1) * 1024));
	});

	test('ReorderingTest: composition offsets and an edit list starting at media time 2', async () => {
		const bytes = buildFragmentedMp4({
			type: 'video',
			sampleEntry: avcEntry,
			timescale: 25,
			edits: [[0, 2]],
			fragments: [{ baseDecodeTime: 0, samples: videoSamples([2, 5, 0]) }],
		});
		expect((await readPackets(bytes, 25)).slice(0, 3).map(packet => packet[0])).toEqual([0, 4, 1]);
	});

	test('LeadingEmptyEditListTest: an 80 ms empty edit delays the track by 2 ticks of 25 Hz', async () => {
		const bytes = buildFragmentedMp4({
			type: 'video',
			sampleEntry: avcEntry,
			timescale: 25,
			edits: [[80, -1], [0, 0]],
			fragments: [{ baseDecodeTime: 0, samples: videoSamples() }],
		});
		expect((await readPackets(bytes, 25)).slice(0, 3)).toEqual([
			[2, 1, 1, true],
			[3, 2, 2, false],
			[5, 3, 3, false],
		]);
	});

	test('LeadingEmptyEditWithMediaOffsetTest: a 120 ms empty edit plus a media time of 2', async () => {
		const bytes = buildFragmentedMp4({
			type: 'video',
			sampleEntry: avcEntry,
			timescale: 25,
			edits: [[120, -1], [0, 2]],
			fragments: [{ baseDecodeTime: 0, samples: videoSamples([2, 5, 0]) }],
		});
		expect((await readPackets(bytes, 25)).slice(0, 3).map(packet => packet[0])).toEqual([3, 7, 4]);
	});
});

describe('Chromium media/formats/mpeg/mpeg1_audio_stream_parser_unittest.cc and adts_stream_parser_unittest.cc', () => {
	const loadChromium = (name: string) => new Uint8Array(
		readFileSync(path.join(__dirname, '..', 'public/chromium-media', name)),
	);
	const readAudio = async (bytes: Uint8Array) => {
		using input = openBytes(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		const packets: { timestamp: number; data: Uint8Array }[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push({ timestamp: packet.timestamp, data: packet.data });
		}
		return {
			codec: await track.getCodec(),
			sampleRate: await track.getSampleRate(),
			numberOfChannels: await track.getNumberOfChannels(),
			packets,
		};
	};

	test('UnalignedAppend and MetadataParsing: sfx.mp3', async () => {
		// A 32-byte ID3 tag and a 417-byte Xing frame come before the 12 frames of audio, the first one 182 bytes long
		const bytes = loadChromium('sfx.mp3');
		const { codec, sampleRate, numberOfChannels, packets } = await readAudio(bytes);
		expect([codec, sampleRate, numberOfChannels]).toEqual(['mp3', 44100, 1]);
		expect(packets).toHaveLength(12);
		expect(toHex(packets[0]!.data)).toBe(toHex(bytes.subarray(32 + 417, 32 + 417 + 182)));
		// Chromium checks that there's a codec delay. The LAME tag gives 576 samples of encoder delay, plus 529 of
		// decoder delay, which FFmpeg skips as well.
		expect(Math.round(packets[0]!.timestamp * sampleRate)).toBe(-1105);
	});

	test('UnalignedAppendMP2: sfx.mp2', async () => {
		const { sampleRate, numberOfChannels, packets } = await readAudio(loadChromium('sfx.mp2'));
		expect({ sampleRate, numberOfChannels }).toEqual({ sampleRate: 44100, numberOfChannels: 1 });
		expect(packets).toHaveLength(10);
	});

	test('AacLcAdts (es_parser_adts_unittest.cc): sfx.adts', async () => {
		const { codec, sampleRate, packets } = await readAudio(loadChromium('sfx.adts'));
		expect({ codec, sampleRate }).toEqual({ codec: 'aac', sampleRate: 44100 });
		expect(packets).toHaveLength(14);
	});

	test('ChannelLayoutMapping: ADTS channel configurations 1 to 7', async () => {
		const adtsFrame = (channelConfiguration: number) => {
			const length = 7 + 4;
			return [
				0xff, 0xf1, // MPEG-4, no CRC
				0x50 | (channelConfiguration >> 2), // AAC LC, 44.1 kHz
				((channelConfiguration & 3) << 6) | (length >> 11),
				(length >> 3) & 0xff,
				((length & 7) << 5) | 0x1f,
				0xfc,
				0, 0, 0, 0,
			];
		};
		const expectedChannels = [1, 2, 3, 4, 5, 6, 8]; // 7 is 7.1
		for (let channelConfiguration = 1; channelConfiguration <= 7; channelConfiguration++) {
			const frame = adtsFrame(channelConfiguration);
			const { numberOfChannels } = await readAudio(new Uint8Array([...frame, ...frame, ...frame]));
			expect(numberOfChannels, `channel configuration ${channelConfiguration}`)
				.toBe(expectedChannels[channelConfiguration - 1]);
		}
	});
});

describe('Chromium media/formats/mp4/mp4_stream_parser_unittest.cc', () => {
	const openChromium = (name: string) => openBytes(new Uint8Array(
		readFileSync(path.join(__dirname, '..', 'public/chromium-media', name)),
	));

	test('NaturalSizeWithoutPASP and NaturalSizeWithPASP: 639x360 from non-square pixels', async () => {
		for (const name of [
			'bear-640x360-non_square_pixel-without_pasp.mp4', // The pixel aspect ratio comes from the SPS
			'bear-640x360-non_square_pixel-with_pasp.mp4',
		]) {
			using input = openChromium(name);
			const track = (await input.getPrimaryVideoTrack())!;
			expect([await track.getDisplayWidth(), await track.getDisplayHeight()], name).toEqual([639, 360]);
		}
	});

	test('Vp9: profile 2, level 3.1 and the colour of vp9-hdr-init-segment.mp4', async () => {
		using input = openChromium('vp9-hdr-init-segment.mp4');
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.getCodecParameterString()).toBe('vp09.02.31.10.01.09.16.09.00');
		expect(await track.getColorSpace()).toEqual({
			primaries: 'bt2020',
			transfer: 'pq',
			matrix: 'bt2020-ncl',
			fullRange: false,
		});
	});

	test('MPEG4_XHE_AAC: one key frame followed by 23 others', async () => {
		using input = openChromium('noise-xhe-aac.mp4');
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getCodecParameterString()).toBe('mp4a.40.42');
		const types: string[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			types.push(packet.type);
		}
		expect(types).toEqual(['key', ...new Array<string>(23).fill('delta')]);
	});
});

describe('web-platform-tests webcodecs/video-decoder.https.any.js and audio-decoder.https.any.js (configs)', () => {
	// WebCodecs rejects the invalid configs with a TypeError and reports the valid but unsupported ones as unsupported.
	// Mediabunny's packet metadata validation has to refuse all of them, since a muxer couldn't describe them.
	const rejectsVideo = (config: object) => {
		try {
			validateVideoChunkMetadata({ decoderConfig: config as VideoDecoderConfig }, null);
			return false;
		} catch (error) {
			return error instanceof TypeError;
		}
	};
	const rejectsAudio = (config: object) => {
		try {
			validateAudioChunkMetadata({ decoderConfig: config as AudioDecoderConfig }, null);
			return false;
		} catch (error) {
			return error instanceof TypeError;
		}
	};

	test('video configs', () => {
		const size = { codedWidth: 16, codedHeight: 16 };
		for (const config of [
			{}, // Missing codec
			{ codec: '' }, // Empty codec
			{ codec: 'bogus', ...size }, // Unrecognized codec
			{ codec: 'vorbis', ...size }, // Audio codec
			{ codec: 'vp9', ...size }, // Ambiguous codec
			{ codec: 'Vp09.00.10.08', ...size }, // Codec with bad casing
			{ codec: 'video/webm; codecs="vp8"', ...size }, // Codec with MIME type
			{ codec: '  vp09.00.10.08  ', ...size }, // Codec with spaces
		]) {
			expect(rejectsVideo(config), JSON.stringify(config)).toBe(true);
		}
		expect(rejectsVideo({ codec: 'vp8', ...size })).toBe(false);
	});

	test('audio configs', () => {
		const format = { sampleRate: 48000, numberOfChannels: 2 };
		for (const config of [
			format, // Missing codec
			{ codec: '', ...format }, // Empty codec
			{ codec: 'opus', sampleRate: 48000 }, // Missing numberOfChannels
			{ codec: 'opus', sampleRate: 0, numberOfChannels: 2 }, // Zero sampleRate
			{ codec: 'opus', sampleRate: 8000, numberOfChannels: 0 }, // Zero channels
			{ codec: 'bogus', ...format }, // Unrecognized codec
			{ codec: 'vp8', ...format }, // Video codec
			{ codec: 'vp9', ...format }, // Ambiguous codec
			{ codec: 'audio/webm; codecs="opus"', ...format }, // Codec with MIME type
			{ codec: 'opus.123', ...format }, // Possible future opus codec string
			{ codec: 'mp4a.FF.9', ...format }, // Possible future aac codec string
			{ codec: '  mp3  ', ...format }, // Codec with spaces
			{ codec: 'opus', sampleRate: 48000, numberOfChannels: 3, description: new Uint8Array(9) }, // Too short
			{ codec: 'vorbis', ...format }, // Vorbis requires a description
			{ codec: 'flac', ...format }, // FLAC requires a description
		]) {
			expect(rejectsAudio(config), JSON.stringify(config)).toBe(true);
		}
		expect(rejectsAudio({ codec: 'opus', ...format })).toBe(false);
	});
});

describe('Chromium media/formats/mp4/h264_annex_b_to_avc_bitstream_converter_unittest.cc', () => {
	test('REXT: a High profile SPS extension goes into the avcC extension', () => {
		const chunk = annexB(
			new Uint8Array([39, 100, 0, 31, 172, 86, 128, 80, 5, 186, 106, 12, 2, 12, 4]), // SPS
			new Uint8Array([45, 208]), // SPS extension
			new Uint8Array([40, 238, 60, 176]), // PPS
			new Uint8Array([37, 184, 32, 1, 239, 27, 89, 188, 127, 248, 98, 186]), // IDR slice
		);
		const record = extractAvcDecoderConfigurationRecord(chunk)!;
		expect(record).toMatchObject({ avcProfileIndication: 100, avcLevelIndication: 31, chromaFormat: 1 });
		expect(record.sequenceParameterSets.map(toHex)).toEqual(['2764001fac56805005ba6a0c020c04']);
		expect(record.pictureParameterSets.map(toHex)).toEqual(['28ee3cb0']);
		expect(record.sequenceParameterSetExt!.map(toHex)).toEqual(['2dd0']);
		// High profile extension: chroma_format, bit depths, then one SPS extension of 2 bytes
		expect(toHex(serializeAvcDecoderConfigurationRecord(record)).endsWith('fdf8f80100022dd0')).toBe(true);
	});
});
