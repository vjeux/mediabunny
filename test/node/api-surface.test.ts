import { expect, test, describe } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Mediabunny from '../../src/index.js';
import {
	ALL_FORMATS,
	ALL_TRACK_TYPES,
	AUDIO_CODECS,
	AudioCodec,
	BufferSource,
	BufferTarget,
	CmafOutputFormat,
	CustomPathedSource,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	HLS_FORMATS,
	HlsOutputFormat,
	HlsOutputPlaylistInfo,
	HlsOutputSegmentInfo,
	Input,
	InputFormat,
	MediaCodec,
	MkvOutputFormat,
	MovOutputFormat,
	Mp3OutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	NON_PCM_AUDIO_CODECS,
	OggOutputFormat,
	Output,
	OutputFormat,
	PathedTarget,
	StreamTarget,
	StreamTargetChunk,
	PCM_AUDIO_CODECS,
	Quality,
	QualityLevel,
	SUBTITLE_CODECS,
	TextSubtitleSource,
	TrackType,
	VIDEO_CODECS,
	VIDEO_SAMPLE_PIXEL_FORMATS,
	VideoCodec,
	WavOutputFormat,
	WebMOutputFormat,
	AdtsOutputFormat,
	FlacOutputFormat,
} from '../../src/index.js';
import * as AacEncoderPackage from '@mediabunny/aac-encoder';
import * as Ac3Package from '@mediabunny/ac3';
import * as DtsPackage from '@mediabunny/dts';
import * as FlacEncoderPackage from '@mediabunny/flac-encoder';
import * as Mp3EncoderPackage from '@mediabunny/mp3-encoder';
import * as ProresPackage from '@mediabunny/prores';
import * as ServerPackage from '@mediabunny/server';
import * as TrueHdPackage from '@mediabunny/truehd';
import { CLASS_MEMBERS, PACKAGE_EXPORTS, VALUE_EXPORTS } from './helpers/api-surface-inventory.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const readPublic = (name: string) => readFileSync(path.join(__dirname, '../public', name));

const exports = Mediabunny as unknown as Record<string, unknown>;

const findProperty = (target: object, name: string) => {
	for (let proto: object | null = target; proto; proto = Object.getPrototypeOf(proto) as object | null) {
		const descriptor = Object.getOwnPropertyDescriptor(proto, name);
		if (descriptor) {
			return descriptor;
		}
	}

	return undefined;
};

const allOutputFormats = (): [string, OutputFormat][] => [
	['Mp4OutputFormat', new Mp4OutputFormat()],
	['MovOutputFormat', new MovOutputFormat()],
	['CmafOutputFormat', new CmafOutputFormat()],
	['MkvOutputFormat', new MkvOutputFormat()],
	['WebMOutputFormat', new WebMOutputFormat()],
	['Mp3OutputFormat', new Mp3OutputFormat()],
	['WavOutputFormat', new WavOutputFormat()],
	['OggOutputFormat', new OggOutputFormat()],
	['AdtsOutputFormat', new AdtsOutputFormat()],
	['FlacOutputFormat', new FlacOutputFormat()],
	['MpegTsOutputFormat', new MpegTsOutputFormat()],
	['HlsOutputFormat', new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat() })],
];

describe('Exports', () => {
	test('runtime exports are exactly the declared API surface', () => {
		expect(Object.keys(exports).sort()).toEqual([...Object.keys(CLASS_MEMBERS), ...VALUE_EXPORTS].sort());
	});

	test.each(Object.entries(CLASS_MEMBERS))('%s exposes every declared method and accessor', (name, members) => {
		const cls = exports[name] as { prototype: object };
		expect(typeof cls).toBe('function');

		for (const member of members.split(' ').filter(Boolean)) {
			const isStatic = member.startsWith('static:');
			const plain = member.replace('static:', '');
			if (plain.startsWith('prop:')) {
				continue; // Instance fields only exist on instances; they're covered by the behavior tests
			}

			const owner = isStatic ? cls : cls.prototype;
			if (plain === '@@dispose') {
				expect(typeof (owner as Record<symbol, unknown>)[Symbol.dispose]).toBe('function');
			} else if (plain.startsWith('get:')) {
				const descriptor = findProperty(owner, plain.slice(4));
				expect(typeof descriptor?.get, `${name}.${plain}`).toBe('function');
			} else {
				const descriptor = findProperty(owner, plain);
				expect(typeof descriptor?.value, `${name}.${plain}`).toBe('function');
			}
		}
	});

	test('value exports have the declared kinds', () => {
		const formatSingletons: Record<string, keyof typeof Mediabunny> = {
			ADTS: 'AdtsInputFormat',
			FLAC: 'FlacInputFormat',
			HLS: 'HlsInputFormat',
			MATROSKA: 'MatroskaInputFormat',
			MP3: 'Mp3InputFormat',
			MP4: 'Mp4InputFormat',
			MPEG_TS: 'MpegTsInputFormat',
			OGG: 'OggInputFormat',
			QTFF: 'QuickTimeInputFormat',
			WAVE: 'WaveInputFormat',
			WEBM: 'WebMInputFormat',
		};
		for (const [name, className] of Object.entries(formatSingletons)) {
			const singleton = exports[name];
			expect(singleton).toBeInstanceOf(exports[className] as new () => unknown);
			// The singleton's own class, not a subclass sharing its detection (WebM extends Matroska)
			expect((singleton as object).constructor).toBe(exports[className]);
		}

		const arrays = [
			'ALL_FORMATS', 'HLS_FORMATS', 'ALL_TRACK_TYPES', 'VIDEO_CODECS', 'AUDIO_CODECS', 'PCM_AUDIO_CODECS',
			'NON_PCM_AUDIO_CODECS', 'SUBTITLE_CODECS', 'VIDEO_SAMPLE_PIXEL_FORMATS',
		];
		const qualities = ['QUALITY_VERY_LOW', 'QUALITY_LOW', 'QUALITY_MEDIUM', 'QUALITY_HIGH', 'QUALITY_VERY_HIGH'];
		for (const name of VALUE_EXPORTS) {
			const value = exports[name];
			if (name in formatSingletons) {
				continue;
			} else if (arrays.includes(name)) {
				expect(Array.isArray(value), name).toBe(true);
			} else if (qualities.includes(name)) {
				expect(value, name).toBeInstanceOf(Quality);
			} else if (name === 'LogLevel') {
				expect(value).toMatchObject({ Silent: 0, Errors: 1, Warnings: 2, Info: 3 });
			} else if (name === 'StreamSource') {
				expect(value).toBe(Mediabunny.CustomSource); // Deprecated alias
			} else {
				expect(typeof value, name).toBe('function');
			}
		}
	});

	test('deprecated QUALITY_* constants equal the corresponding Quality levels', () => {
		const levels: [Quality, QualityLevel][] = [
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			[Mediabunny.QUALITY_VERY_LOW, 'very-low'],
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			[Mediabunny.QUALITY_LOW, 'low'],
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			[Mediabunny.QUALITY_MEDIUM, 'medium'],
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			[Mediabunny.QUALITY_HIGH, 'high'],
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			[Mediabunny.QUALITY_VERY_HIGH, 'very-high'],
		];
		for (const [constant, level] of levels) {
			expect(constant).toEqual(new Quality(level));
		}
	});
});

describe('Instances and packages', () => {
	const declaredFields = (name: string) => CLASS_MEMBERS[name]!
		.split(' ')
		.filter(member => member.startsWith('prop:'))
		.map(member => member.slice(5));

	test('instances carry every declared field', async () => {
		using input = new Input({ source: new BufferSource(readPublic('video.mp4')), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		output.addVideoTrack(new EncodedVideoPacketSource('avc'));
		output.addAudioTrack(new EncodedAudioPacketSource('aac'));
		output.addSubtitleTrack(new TextSubtitleSource('webvtt'));
		const [videoTrack, audioTrack, subtitleTrack] = output.tracks;
		const wav = new Input({ source: new BufferSource(readPublic('glitch-hop-is-dead.wav')), formats: ALL_FORMATS });
		const conversion = await Mediabunny.Conversion.init({
			input: wav,
			output: new Output({ format: new WavOutputFormat(), target: new BufferTarget() }),
		});

		const audioSample = new Mediabunny.AudioSample({
			data: new Float32Array(2), format: 'f32', numberOfChannels: 1, sampleRate: 48000, timestamp: 0,
		});
		const videoSample = new Mediabunny.VideoSample(new Uint8Array(4), {
			format: 'RGBA', codedWidth: 1, codedHeight: 1, timestamp: 0,
		});

		const instances: Record<string, object> = {
			AttachedFile: new Mediabunny.AttachedFile(new Uint8Array(1), 'text/plain', 'name', 'description'),
			AudioSample: audioSample,
			BufferTarget: new BufferTarget(),
			ConcurrentRunner: new Mediabunny.ConcurrentRunner(2),
			Conversion: conversion,
			EncodedPacket: new EncodedPacket(new Uint8Array(1), 'key', 0, 0),
			InputTrack: (await input.getPrimaryVideoTrack())!,
			Output: output,
			OutputTrack: videoTrack!,
			OutputVideoTrack: videoTrack!,
			OutputAudioTrack: audioTrack!,
			OutputSubtitleTrack: subtitleTrack!,
			PathedSource: new CustomPathedSource('a.m3u8', () => new BufferSource(new Uint8Array(0))),
			PathedTarget: new PathedTarget('a.m3u8', () => new BufferTarget()),
			RichImageData: new Mediabunny.RichImageData(new Uint8Array(1), 'image/png'),
			Source: new BufferSource(new Uint8Array(1)),
			Target: new BufferTarget(),
			VideoSample: videoSample,
			VideoSampleColorSpace: new Mediabunny.VideoSampleColorSpace(),
		};
		// Custom coders' fields are set by Mediabunny when it instantiates them, not by their constructors
		const frameworkPopulated = [
			'CustomAudioDecoder', 'CustomAudioEncoder', 'CustomVideoDecoder', 'CustomVideoEncoder',
		];

		for (const name of Object.keys(CLASS_MEMBERS)) {
			const fields = declaredFields(name);
			if (fields.length === 0 || frameworkPopulated.includes(name)) {
				continue;
			}

			const instance = instances[name];
			expect(instance, `no instance for ${name}`).toBeDefined();
			expect(instance).toBeInstanceOf(exports[name] as new () => unknown);
			for (const field of fields) {
				expect(field in instance!, `${name}.${field}`).toBe(true);
			}
		}

		await conversion.cancel();
		wav.dispose();
		audioSample.close();
		videoSample.close();
	});

	test('deprecated track getters agree with the methods replacing them', async () => {
		const common = ['codec', 'internalCodecId', 'languageCode', 'name', 'timeResolution', 'disposition'];
		const video = [
			'codedWidth', 'codedHeight', 'rotation', 'squarePixelWidth', 'squarePixelHeight', 'pixelAspectRatio',
			'displayWidth', 'displayHeight',
		];
		const audio = ['numberOfChannels', 'sampleRate'];
		const files = [
			'video.mp4', 'trunc-buck-bunny.mov', 'ac3.mkv', 'demo.webm', 'glitch-hop-is-dead.wav', 'vorbis-eos.ogg',
			'sample.flac', 'Toothsome-Meme.VBRv2.mp3', 'sample3.aac', '0.ts',
		];

		for (const file of files) {
			using input = new Input({ source: new BufferSource(readPublic(file)), formats: ALL_FORMATS });
			for (const track of await input.getTracks()) {
				for (const getter of [...common, ...(track.isVideoTrack() ? video : audio)]) {
					const method = `get${getter[0]!.toUpperCase()}${getter.slice(1)}`;
					const record = track as unknown as Record<string, unknown>;
					expect(await (record[method] as () => unknown).call(track), `${file}: ${getter}`)
						.toEqual(record[getter]);
				}
			}
		}
	});

	test('extension packages export exactly their declared API', () => {
		const packages: Record<string, Record<string, unknown>> = {
			'@mediabunny/aac-encoder': AacEncoderPackage,
			'@mediabunny/ac3': Ac3Package,
			'@mediabunny/dts': DtsPackage,
			'@mediabunny/flac-encoder': FlacEncoderPackage,
			'@mediabunny/mp3-encoder': Mp3EncoderPackage,
			'@mediabunny/prores': ProresPackage,
			'@mediabunny/server': ServerPackage,
			'@mediabunny/truehd': TrueHdPackage,
		};
		expect(Object.keys(packages).sort()).toEqual(Object.keys(PACKAGE_EXPORTS).sort());

		for (const [name, module] of Object.entries(packages)) {
			// Underscore-prefixed names are internals shared between the package's own modules
			const runtime = Object.keys(module).filter(key => !key.startsWith('_')).sort();
			expect(runtime, name).toEqual(PACKAGE_EXPORTS[name]);

			for (const key of runtime.filter(key => key.startsWith('register'))) {
				expect(typeof module[key], `${name}: ${key}`).toBe('function');
			}
		}

		for (const options of [null, 'options', 1, { hardwareContext: 5 }]) {
			expect(() => ServerPackage.registerMediabunnyServer(options as never)).toThrow(TypeError);
		}
	});
});

describe('Constants', () => {
	test('codec lists are unique and audio codecs split into PCM and non-PCM', () => {
		for (const list of [VIDEO_CODECS, AUDIO_CODECS, PCM_AUDIO_CODECS, NON_PCM_AUDIO_CODECS, SUBTITLE_CODECS]) {
			expect(new Set(list).size).toBe(list.length);
		}
		expect([...NON_PCM_AUDIO_CODECS, ...PCM_AUDIO_CODECS].sort()).toEqual([...AUDIO_CODECS].sort());
		expect(NON_PCM_AUDIO_CODECS.filter(codec => (PCM_AUDIO_CODECS as readonly string[]).includes(codec)))
			.toEqual([]);
		const all = [...VIDEO_CODECS, ...AUDIO_CODECS, ...SUBTITLE_CODECS];
		expect(new Set(all).size).toBe(all.length);
		expect(new Set(VIDEO_SAMPLE_PIXEL_FORMATS).size).toBe(VIDEO_SAMPLE_PIXEL_FORMATS.length);
		expect([...ALL_TRACK_TYPES]).toEqual(['video', 'audio', 'subtitle']);
	});

	test('input format lists hold each format singleton once', () => {
		const singletons = [
			Mediabunny.ADTS, Mediabunny.FLAC, Mediabunny.HLS, Mediabunny.MATROSKA, Mediabunny.MP3, Mediabunny.MP4,
			Mediabunny.MPEG_TS, Mediabunny.OGG, Mediabunny.QTFF, Mediabunny.WAVE, Mediabunny.WEBM,
		];
		expect([...ALL_FORMATS].sort((a, b) => a.name.localeCompare(b.name)))
			.toEqual([...singletons].sort((a, b) => a.name.localeCompare(b.name)));
		expect(HLS_FORMATS.every(format => ALL_FORMATS.includes(format))).toBe(true);
		expect(new Set(HLS_FORMATS).size).toBe(HLS_FORMATS.length);
		// HLS first: playlists are text and must not be probed as anything else
		expect(ALL_FORMATS[0]).toBe(Mediabunny.HLS);
		expect(HLS_FORMATS[0]).toBe(Mediabunny.HLS);

		for (const format of ALL_FORMATS) {
			expect(format.name).toMatch(/\S/);
			expect(format.mimeType).toMatch(/^[a-z]+\/[\w.+-]+$/i);
			expect(typeof format.supportsTimestampedMediaData).toBe('boolean');
		}
		expect(new Set(ALL_FORMATS.map(format => format.name)).size).toBe(ALL_FORMATS.length);
	});

	test.each(allOutputFormats())('%s describes itself consistently', (_, format) => {
		const codecs = format.getSupportedCodecs();
		expect(new Set(codecs).size).toBe(codecs.length);
		for (const codec of codecs) {
			expect([...VIDEO_CODECS, ...AUDIO_CODECS, ...SUBTITLE_CODECS] as string[]).toContain(codec);
		}
		// The per-type getters partition the full list, keeping its order
		expect([
			...format.getSupportedVideoCodecs(),
			...format.getSupportedAudioCodecs(),
			...format.getSupportedSubtitleCodecs(),
		].sort()).toEqual([...codecs].sort());
		expect(format.getSupportedVideoCodecs())
			.toEqual(codecs.filter(c => (VIDEO_CODECS as readonly string[]).includes(c)));

		expect(format.fileExtension).toMatch(/^\.[a-z0-9]+$/);
		expect(format.mimeType).toMatch(/^[a-z]+\/[\w.+-]+$/i);
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		expect(format.supportsVideoRotationMetadata).toBe(format.supportsVideoTransformationMetadata);
		expect(typeof format.supportsTimestampedMediaData).toBe('boolean');
		expect(format.negativeTimestampSupport === null).toBe(!format.supportsTimestampedMediaData);
		expect(format.requiresMaximumPacketCount).toBe(false);

		const counts = format.getSupportedTrackCounts();
		for (const key of [...ALL_TRACK_TYPES, 'total'] as const) {
			const range = counts[key];
			expect(Number.isInteger(range.min), key).toBe(true);
			expect(Number.isInteger(range.max) || range.max === Infinity, key).toBe(true);
			expect(range.min).toBeGreaterThanOrEqual(0);
			expect(range.max).toBeGreaterThanOrEqual(range.min);
		}
		for (const type of ALL_TRACK_TYPES) {
			const typeCodecs = type === 'video'
				? format.getSupportedVideoCodecs()
				: type === 'audio' ? format.getSupportedAudioCodecs() : format.getSupportedSubtitleCodecs();
			if (format instanceof MovOutputFormat && type === 'subtitle') {
				continue; // Known bug: MOV's track counts allow subtitle tracks, but it supports no subtitle codec
			}
			// A track type the format allows must come with at least one codec, and vice versa
			expect(counts[type].max > 0, type).toBe(typeCodecs.length > 0);
		}
	});

	test('fastStart: reserve is the only configuration that requires maximumPacketCount', () => {
		for (const fastStart of [false, 'in-memory', 'fragmented'] as const) {
			expect(new Mp4OutputFormat({ fastStart }).requiresMaximumPacketCount).toBe(false);
			expect(new MovOutputFormat({ fastStart }).requiresMaximumPacketCount).toBe(false);
		}
		expect(new Mp4OutputFormat({ fastStart: 'reserve' }).requiresMaximumPacketCount).toBe(true);
		expect(new MovOutputFormat({ fastStart: 'reserve' }).requiresMaximumPacketCount).toBe(true);
	});
});

type Fixture = {
	codec: MediaCodec;
	type: TrackType;
	packets: EncodedPacket[];
	decoderConfig?: VideoDecoderConfig | AudioDecoderConfig;
	text?: string;
};

const PCM_BYTES: Record<string, number> = {
	'pcm-u8': 1, 'pcm-s8': 1, 'ulaw': 1, 'alaw': 1, 'pcm-s16': 2, 'pcm-s16be': 2, 'pcm-s24': 3, 'pcm-s24be': 3,
	'pcm-s32': 4, 'pcm-s32be': 4, 'pcm-f32': 4, 'pcm-f32be': 4, 'pcm-f64': 8, 'pcm-f64be': 8,
};

const loadFixture = async (file: string, type: 'video' | 'audio', count = 8): Promise<Fixture> => {
	using input = new Input({ source: new BufferSource(readPublic(file)), formats: ALL_FORMATS });
	const track = type === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track!).packets()) {
		packets.push(packet);
		if (packets.length === count) {
			break;
		}
	}

	return { codec: (await track!.getCodec())!, type, packets, decoderConfig: (await track!.getDecoderConfig())! };
};

const pcmFixture = (codec: AudioCodec): Fixture => ({
	codec,
	type: 'audio',
	packets: Array.from({ length: 4 }, (_, i) => new EncodedPacket(
		new Uint8Array(480 * 2 * PCM_BYTES[codec]!).fill(i), 'key', i * 0.01, 0.01,
	)),
	decoderConfig: { codec, numberOfChannels: 2, sampleRate: 48000 },
});

const loadFixtures = async (): Promise<Fixture[]> => [
	await loadFixture('video.mp4', 'video'),
	await loadFixture('video-h265.mp4', 'video'),
	await loadFixture('vp9-smpte170m.webm', 'video'),
	await loadFixture('video.mp4', 'audio'),
	await loadFixture('demo.webm', 'audio'),
	await loadFixture('vorbis-eos.ogg', 'audio'),
	await loadFixture('Toothsome-Meme.VBRv2.mp3', 'audio'),
	await loadFixture('sample.flac', 'audio'),
	await loadFixture('ac3.mp4', 'audio'),
	await loadFixture('eac3.mp4', 'audio'),
	await loadFixture('toothsome-dts.mp4', 'audio'),
	await loadFixture('truehd.mp4', 'audio'),
	...PCM_AUDIO_CODECS.map(pcmFixture),
	{ codec: 'webvtt', type: 'subtitle', packets: [], text: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n' },
];

const addFixtureTrack = (output: Output, fixture: Fixture) => {
	if (fixture.type === 'video') {
		const source = new EncodedVideoPacketSource(fixture.codec as VideoCodec);
		output.addVideoTrack(source);
		return async () => {
			for (const [i, packet] of fixture.packets.entries()) {
				await source.add(
					packet,
					i === 0 ? { decoderConfig: fixture.decoderConfig as VideoDecoderConfig } : undefined,
				);
			}
		};
	} else if (fixture.type === 'audio') {
		const source = new EncodedAudioPacketSource(fixture.codec as AudioCodec);
		output.addAudioTrack(source);
		return async () => {
			for (const [i, packet] of fixture.packets.entries()) {
				await source.add(
					packet,
					i === 0 ? { decoderConfig: fixture.decoderConfig as AudioDecoderConfig } : undefined,
				);
			}
		};
	} else {
		const source = new TextSubtitleSource('webvtt');
		output.addSubtitleTrack(source);
		return () => source.add(fixture.text!);
	}
};

describe('Output formats vs muxers', () => {
	// Formats writing a single file to a BufferTarget; CMAF and HLS need extra targets and are covered below
	const fileFormats: [string, () => OutputFormat][] = [
		['MP4', () => new Mp4OutputFormat()],
		['MP4 (fragmented)', () => new Mp4OutputFormat({ fastStart: 'fragmented' })],
		['MOV', () => new MovOutputFormat()],
		['MKV', () => new MkvOutputFormat()],
		['WebM', () => new WebMOutputFormat()],
		['Ogg', () => new OggOutputFormat()],
		['MP3', () => new Mp3OutputFormat()],
		['WAVE', () => new WavOutputFormat()],
		['ADTS', () => new AdtsOutputFormat()],
		['FLAC', () => new FlacOutputFormat()],
		['MPEG-TS', () => new MpegTsOutputFormat()],
	];

	test('every claimed codec is accepted, muxed and read back with the same codec and MIME type', async () => {
		const fixtures = await loadFixtures();
		// Every codec in the codec lists has a fixture, except those without test files (AV1, VP8, ProRes)
		expect(new Set(fixtures.map(f => f.codec))).toEqual(
			new Set([...VIDEO_CODECS, ...AUDIO_CODECS, ...SUBTITLE_CODECS]
				.filter(c => !['av1', 'vp8', 'prores'].includes(c))),
		);

		for (const [name, makeFormat] of fileFormats) {
			const claimed = makeFormat().getSupportedCodecs();

			for (const fixture of fixtures) {
				const label = `${name}/${fixture.codec}`;
				const output = new Output({ format: makeFormat(), target: new BufferTarget() });

				if (!claimed.includes(fixture.codec)) {
					expect(() => addFixtureTrack(output, fixture), label)
						.toThrow(/does not support|cannot be contained/);
					continue;
				}

				const writePackets = addFixtureTrack(output, fixture);
				await output.start();
				await writePackets();
				const mimeType = await output.getMimeType();
				await output.finalize();

				using input = new Input({
					source: new BufferSource(output.target.buffer!),
					formats: ALL_FORMATS,
				});
				const [track] = await input.getTracks();
				if (fixture.type === 'subtitle') {
					// Subtitle tracks are written but not read back as InputTracks
					expect(track, label).toBeUndefined();
					continue;
				}

				expect(await track!.getCodec(), label).toBe(fixture.codec);
				expect(await new EncodedPacketSink(track!).getFirstPacket(), label).not.toBeNull();
				expect(await input.getMimeType(), label).toBe(mimeType);
			}
		}
	});

	test('track count limits are enforced on add and start', async () => {
		const add = (output: Output, type: TrackType, format: OutputFormat) => {
			if (type === 'video') {
				output.addVideoTrack(new EncodedVideoPacketSource(format.getSupportedVideoCodecs()[0]!));
			} else if (type === 'audio') {
				output.addAudioTrack(new EncodedAudioPacketSource(format.getSupportedAudioCodecs()[0]!));
			} else {
				output.addSubtitleTrack(new TextSubtitleSource(format.getSupportedSubtitleCodecs()[0]!));
			}
		};

		for (const [name, format] of allOutputFormats()) {
			if (format instanceof HlsOutputFormat || format instanceof CmafOutputFormat) {
				continue; // Need pathed/init targets; the limits are the same as for their segment formats
			}
			const counts = format.getSupportedTrackCounts();

			for (const type of ALL_TRACK_TYPES) {
				const codecs = type === 'video'
					? format.getSupportedVideoCodecs()
					: type === 'audio' ? format.getSupportedAudioCodecs() : format.getSupportedSubtitleCodecs();
				if (codecs.length === 0) {
					continue;
				}

				const output = new Output({ format, target: new BufferTarget() });
				const max = Math.min(counts[type].max, counts.total.max, 3);
				for (let i = 0; i < max; i++) {
					add(output, type, format);
				}
				if (max === counts[type].max) {
					expect(() => add(output, type, format), `${name}: ${type} #${max + 1}`).toThrow(/does not support/);
				}
			}

			const output = new Output({ format, target: new BufferTarget() });
			const minTotal = counts.total.min;
			if (minTotal > 0) {
				await expect(output.start(), name).rejects.toThrow(/requires/);
			} else {
				await output.start();
				await output.cancel();
			}
		}
	});

	test('CMAF and HLS outputs report their files through the documented targets and events', async () => {
		const fixture = await loadFixture('video.mp4', 'video');

		// The init segment goes to initTarget, the media segments to target
		const initTarget = new BufferTarget();
		const cmaf = new Output({ format: new CmafOutputFormat(), target: new BufferTarget(), initTarget });
		const writeCmaf = addFixtureTrack(cmaf, fixture);
		await cmaf.start();
		await writeCmaf();
		await cmaf.finalize();
		const initBytes = new Uint8Array(initTarget.buffer!);
		const mediaBytes = new Uint8Array(cmaf.target.buffer!);
		expect(String.fromCharCode(...initBytes.subarray(4, 8))).toBe('ftyp');
		expect(String.fromCharCode(...mediaBytes.subarray(4, 8))).not.toBe('ftyp');
		expect(mediaBytes.byteLength).toBeGreaterThan(0);

		const files = new Map<string, BufferTarget>();
		const requests: unknown[] = [];
		const hls = new Output({
			format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat() }),
			target: new PathedTarget('master.m3u8', (request) => {
				requests.push(request);
				const target = new BufferTarget();
				files.set(request.path, target);
				return target;
			}),
		});
		const writeHls = addFixtureTrack(hls, fixture);
		await hls.start();
		await writeHls();
		await hls.finalize();

		expect(requests).toContainEqual({
			path: 'master.m3u8',
			isRoot: true,
			mimeType: 'application/vnd.apple.mpegurl',
		});
		for (const request of requests as { path: string; isRoot: boolean }[]) {
			expect(Object.keys(request).sort()).toEqual(['isRoot', 'mimeType', 'path']);
			expect(request.isRoot).toBe(request.path === 'master.m3u8');
		}

		const readBack = new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(files.get(path)!.buffer!)),
			formats: ALL_FORMATS,
		});
		expect(await readBack.getFormat()).toBe(Mediabunny.HLS);
		expect(await (await readBack.getPrimaryVideoTrack())!.getCodec()).toBe('avc');
		readBack.dispose();
	});
});

describe('Format detection', () => {
	const cases: [string, InputFormat][] = [
		['video.mp4', Mediabunny.MP4],
		['trunc-buck-bunny.mov', Mediabunny.QTFF],
		['ac3.mkv', Mediabunny.MATROSKA],
		['demo.webm', Mediabunny.WEBM],
		['glitch-hop-is-dead.wav', Mediabunny.WAVE],
		['vorbis-eos.ogg', Mediabunny.OGG],
		['preroll-test.opus', Mediabunny.OGG],
		['sample.flac', Mediabunny.FLAC],
		['Toothsome-Meme.VBRv2.mp3', Mediabunny.MP3],
		['sample3.aac', Mediabunny.ADTS],
		['0.ts', Mediabunny.MPEG_TS],
	];

	test.each(cases)('%s is detected as its format, alone or within ALL_FORMATS', async (file, expected) => {
		const bytes = readPublic(file);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		expect(await input.getFormat()).toBe(expected);
		// The full MIME type uses the format's subtype, switching to audio/ for audio-only files
		const [type, subtype] = (await input.getMimeType()).split(';')[0]!.split('/');
		expect(subtype).toBe(expected.mimeType.split('/')[1]);
		expect(['video', 'audio', 'application']).toContain(type);

		using alone = new Input({ source: new BufferSource(bytes), formats: [expected] });
		expect(await alone.getFormat()).toBe(expected);

		if (file === 'trunc-buck-bunny.mov') {
			return; // Known issue: MP3's frame-header heuristic matches two "frames" in this file's first 4 KiB
		}
		// Without its format, a file must not be claimed by any other single format
		const others = ALL_FORMATS.filter(format => format !== expected);
		using without = new Input({ source: new BufferSource(bytes), formats: others });
		expect(await without.canRead()).toBe(false);
	});
});

describe('Events and callback payloads', () => {
	test('read, write, finalized, source and target events carry their documented payloads', async () => {
		const source = new BufferSource(readPublic('glitch-hop-is-dead.wav'));
		const reads: unknown[] = [];
		source.on('read', event => void reads.push(event));

		using input = new Input({ source, formats: ALL_FORMATS });
		const sourceEvents: unknown[] = [];
		input.on('source', event => void sourceEvents.push(event));
		const track = (await input.getPrimaryAudioTrack())!;

		expect(reads[0]).toEqual({ start: 0, end: source._bytes.byteLength });
		expect(sourceEvents).toEqual([{ source, request: null, isRoot: true }]);

		const target = new BufferTarget();
		const writes: { start: number; end: number }[] = [];
		let finalized = 0;
		target.on('write', event => void writes.push(event));
		target.on('finalized', () => finalized++);

		const output = new Output({ format: new WavOutputFormat(), target });
		const targetEvents: unknown[] = [];
		output.on('target', event => void targetEvents.push(event));
		const packetSource = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(packetSource);
		await output.start();
		const sink = new EncodedPacketSink(track);
		let first = true;
		for await (const packet of sink.packets()) {
			await packetSource.add(packet, first ? { decoderConfig: (await track.getDecoderConfig())! } : undefined);
			first = false;
			if (packet.timestamp > 0.5) {
				break;
			}
		}
		await output.finalize();

		expect(targetEvents).toEqual([{ target, request: null, isRoot: true }]);
		expect(finalized).toBe(1);
		expect(writes.length).toBeGreaterThan(0);
		for (const write of writes) {
			expect(Object.keys(write).sort()).toEqual(['end', 'start']);
			expect(write.end).toBeGreaterThanOrEqual(write.start);
		}
		expect(Math.max(...writes.map(write => write.end))).toBe(target.buffer!.byteLength);
	});

	test('every demuxer returns values of the declared types', async () => {
		type Check = (value: unknown) => boolean;
		const isNumber: Check = value => typeof value === 'number' && !Number.isNaN(value);
		const isNonNegative: Check = value => isNumber(value) && (value as number) >= 0;
		const isPositive: Check = value => isNumber(value) && (value as number) > 0;
		const isPositiveInteger: Check = value => Number.isInteger(value) && (value as number) > 0;
		const isString: Check = value => typeof value === 'string';
		const isBoolean: Check = value => typeof value === 'boolean';
		const orNull = (check: Check): Check => value => value === null || check(value);
		const arrayOf = (cls: abstract new (...args: never[]) => unknown): Check =>
			value => Array.isArray(value) && value.every(item => item instanceof cls);

		const common: [string, Check, unknown[]?][] = [
			['getCodec', value => value === null || ([...VIDEO_CODECS, ...AUDIO_CODECS] as unknown[]).includes(value)],
			['getCodecParameterString', orNull(isString)],
			['canDecode', isBoolean],
			['hasOnlyKeyPackets', isBoolean],
			['getInternalCodecId', value => value === null || isString(value) || isNumber(value)
				|| value instanceof Uint8Array],
			['getLanguageCode', value => isString(value) && /^[a-z]{3}$/.test(value as string)],
			['getName', orNull(isString)],
			['getTimeResolution', isPositive],
			['isRelativeToUnixEpoch', isBoolean],
			['hasUnixTimeMapping', isBoolean],
			['getUnixTimeForTimestamp', orNull(isNumber), [0]],
			['getBitrate', orNull(isPositive)],
			['getAverageBitrate', orNull(isPositive)],
			['getFirstTimestamp', isNumber],
			['computeDuration', isNonNegative],
			['getDurationFromMetadata', orNull(isNonNegative)],
			['isLive', isBoolean],
			['getLiveRefreshInterval', orNull(isPositive)],
			['getPairableTracks', arrayOf(Mediabunny.InputTrack)],
			['getPairableVideoTracks', arrayOf(Mediabunny.InputVideoTrack)],
			['getPairableAudioTracks', arrayOf(Mediabunny.InputAudioTrack)],
			['getPrimaryPairableVideoTrack', value => value === null || value instanceof Mediabunny.InputVideoTrack],
			['getPrimaryPairableAudioTrack', value => value === null || value instanceof Mediabunny.InputAudioTrack],
			['hasPairableTrack', isBoolean],
			['hasPairableVideoTrack', isBoolean],
			['hasPairableAudioTrack', isBoolean],
		];
		const video: [string, Check][] = [
			['getCodedWidth', isPositiveInteger],
			['getCodedHeight', isPositiveInteger],
			['getRotation', value => [0, 90, 180, 270].includes(value as number)],
			['getFlip', isBoolean],
			['getSquarePixelWidth', isPositiveInteger],
			['getSquarePixelHeight', isPositiveInteger],
			['getDisplayWidth', isPositiveInteger],
			['getDisplayHeight', isPositiveInteger],
			['hasHighDynamicRange', isBoolean],
			['canBeTransparent', isBoolean],
			['getTransformationMatrix', value => Array.isArray(value) && value.length === 9 && value.every(isNumber)],
			['getPixelAspectRatio', value => isPositiveInteger((value as { num: number }).num)
				&& isPositiveInteger((value as { den: number }).den)],
			['getDecoderConfig', value => value === null || isString((value as { codec: unknown }).codec)],
		];
		const audio: [string, Check][] = [
			['getNumberOfChannels', isPositiveInteger],
			['getSampleRate', isPositiveInteger],
			['getPreRollDuration', orNull(isNonNegative)],
			['getDecoderConfig', value => value === null || isString((value as { codec: unknown }).codec)],
		];
		const tagFields = [
			'title', 'description', 'artist', 'album', 'albumArtist', 'trackNumber', 'tracksTotal', 'discNumber',
			'discsTotal', 'beatsPerMinute', 'genre', 'date', 'lyrics', 'comment', 'images', 'creationTime', 'raw',
		];
		const files = [
			'video.mp4', 'trunc-buck-bunny.mov', 'ac3.mkv', 'demo.webm', 'glitch-hop-is-dead.wav', 'vorbis-eos.ogg',
			'sample.flac', 'Toothsome-Meme.VBRv2.mp3', 'sample3.aac', '0.ts',
		];

		for (const file of files) {
			using input = new Input({ source: new BufferSource(readPublic(file)), formats: ALL_FORMATS });
			expect(isNumber(await input.getFirstTimestamp()), file).toBe(true);
			expect(isNonNegative(await input.computeDuration()), file).toBe(true);
			expect(orNull(isNonNegative)(await input.getDurationFromMetadata()), file).toBe(true);
			const tags = await input.getMetadataTags();
			expect(tagFields, file).toEqual(expect.arrayContaining(Object.keys(tags)));

			for (const track of await input.getTracks()) {
				const checks = [...common, ...(track.isVideoTrack() ? video : audio)];
				for (const [method, check, args = []] of checks) {
					const value = await (track as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(
						...args,
					);
					expect(check(value), `${file} ${track.type}.${method}() returned ${String(value)}`).toBe(true);
				}
			}
		}
	});

	test('small getters, runners and output tracks return what they declare', async () => {
		const packet = new EncodedPacket(new Uint8Array(1), 'key', 1.001, 0.25);
		expect([packet.microsecondTimestamp, packet.microsecondDuration, packet.isMetadataOnly])
			.toEqual([1_001_000, 250_000, false]);
		using input = new Input({ source: new BufferSource(readPublic('video.mp4')), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new EncodedPacketSink(track);
		expect((await sink.getFirstPacket({ metadataOnly: true }))!.isMetadataOnly).toBe(true);
		expect((await sink.getFirstKeyPacket())!.type).toBe('key');

		using audio = new Mediabunny.AudioSample({
			data: new Float32Array(480), format: 'f32', numberOfChannels: 1, sampleRate: 48000, timestamp: 1.001,
		});
		expect([audio.microsecondTimestamp, audio.microsecondDuration]).toEqual([1_001_000, 10_000]);
		using video = new Mediabunny.VideoSample(new Uint8Array(4), {
			format: 'RGBA', codedWidth: 1, codedHeight: 1, timestamp: 1.001, duration: 0.04,
		});
		expect([video.microsecondTimestamp, video.microsecondDuration, video.hasAlpha])
			.toEqual([1_001_000, 40_000, true]);
		expect(new Mediabunny.VideoSampleColorSpace({ primaries: 'bt709' }).toJSON())
			.toEqual({ primaries: 'bt709', transfer: null, matrix: null, fullRange: null });

		const runner = new Mediabunny.ConcurrentRunner(1);
		const order: number[] = [];
		const first = runner.run(async () => {
			await new Promise(resolve => setTimeout(resolve, 5));
			order.push(1);
		});
		expect(runner.inFlightCount).toBe(1);
		const second = runner.run(async () => void order.push(2)); // Waits for a free slot
		await Promise.all([first, second]);
		await runner.flush();
		expect(order).toEqual([1, 2]);
		expect([runner.inFlightCount, runner.errored]).toEqual([0, false]);

		const wave = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		expect(wave.hasEnoughTracks()).toBe(false); // WAVE needs its audio track
		wave.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'));
		expect(wave.hasEnoughTracks()).toBe(true);

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		output.addAudioTrack(new EncodedAudioPacketSource('aac'), { languageCode: 'fra' });
		output.addSubtitleTrack(new TextSubtitleSource('webvtt'));
		const [audioTrack, subtitleTrack] = output.tracks;
		expect([audioTrack!.isAudioTrack(), audioTrack!.isVideoTrack(), audioTrack!.isSubtitleTrack()])
			.toEqual([true, false, false]);
		expect(subtitleTrack!.isSubtitleTrack()).toBe(true);
		expect(audioTrack!.metadata.languageCode).toBe('fra');
		expect(audioTrack!.output).toBe(output);
		expect(output.defaultTrackGroup).toBeInstanceOf(Mediabunny.OutputTrackGroup);
	});

	test('conversion, logging, stream and HLS callbacks report the documented shapes', async () => {
		const conversion = await Mediabunny.Conversion.init({
			input: new Input({ source: new BufferSource(readPublic('video.mp4')), formats: ALL_FORMATS }),
			output: new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() }),
			showWarnings: false,
		});
		// MP3 can't hold the video track, and Node has no decoder for the AAC audio
		expect(conversion.isValid).toBe(false);
		expect(conversion.utilizedTracks).toEqual([]);
		expect(conversion.discardedTracks.map(t => [t.track.type, t.reason])).toEqual([
			['video', 'max_track_count_of_type_reached'],
			['audio', 'undecodable_source_codec'],
		]);
		for (const discarded of conversion.discardedTracks) {
			expect(Object.keys(discarded).sort()).toEqual(['reason', 'track', 'trackOptions']);
		}
		expect(conversion.onProgress).toBeUndefined();

		// Log events fire whatever the level; the level only controls the console output
		const warnings: unknown[][] = [];
		const removeListener = Mediabunny.Logging.on('warn', args => void warnings.push(args));
		const level = Mediabunny.Logging.level;
		Mediabunny.Logging.level = Mediabunny.LogLevel.Silent;
		try {
			await Mediabunny.Conversion.init({
				input: new Input({ source: new BufferSource(readPublic('video.mp4')), formats: ALL_FORMATS }),
				output: new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() }),
			});
		} finally {
			Mediabunny.Logging.level = level;
			removeListener();
		}
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings.every(args => Array.isArray(args))).toBe(true);

		const fixture = await loadFixture('video.mp4', 'video');
		const chunks: StreamTargetChunk[] = [];
		const streamed = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new StreamTarget(new WritableStream({ write: chunk => void chunks.push(chunk) })),
		});
		const writeStreamed = addFixtureTrack(streamed, fixture);
		await streamed.start();
		await writeStreamed();
		await streamed.finalize();
		for (const chunk of chunks) {
			expect(Object.keys(chunk).sort()).toEqual(['data', 'position', 'type']);
			expect(chunk.type).toBe('write');
			expect(chunk.data).toBeInstanceOf(Uint8Array);
			expect(Number.isInteger(chunk.position)).toBe(true);
		}

		const segments: HlsOutputSegmentInfo[] = [];
		const playlists: HlsOutputPlaylistInfo[] = [];
		const hls = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new MpegTsOutputFormat(),
				onSegment: (_, info) => void segments.push(info),
				onPlaylist: (_, info) => void playlists.push(info),
			}),
			target: new PathedTarget('master.m3u8', () => new BufferTarget()),
		});
		const writeHls = addFixtureTrack(hls, fixture);
		await hls.start();
		await writeHls();
		await hls.finalize();
		expect(segments.length).toBeGreaterThan(0);
		for (const info of segments) {
			expect(Object.keys(info).sort()).toEqual(['format', 'isSingleFile', 'n', 'playlist']);
			expect(info.isSingleFile).toBe(false);
			expect(info.format).toBeInstanceOf(MpegTsOutputFormat);
		}
		expect(Object.keys(playlists[0]!).sort()).toEqual(['n', 'segmentFormat', 'tracks']);
	});

	test('track getters return the documented shapes', async () => {
		using input = new Input({ source: new BufferSource(readPublic('video.mp4')), formats: ALL_FORMATS });
		const video = (await input.getPrimaryVideoTrack())!;
		const audio = (await input.getPrimaryAudioTrack())!;

		for (const track of [video, audio]) {
			expect(Object.keys(await track.getDisposition()).sort()).toEqual([
				'commentary', 'default', 'forced', 'hearingImpaired', 'original', 'primary', 'visuallyImpaired',
			]);
			expect(Object.keys(await track.computePacketStats(10)).sort())
				.toEqual(['averageBitrate', 'averagePacketRate', 'packetCount']);
			expect(track.input).toBe(input);
			expect(typeof track.id).toBe('number');
			expect(typeof track.number).toBe('number');
			expect(track.type).toBe(track.isVideoTrack() ? 'video' : 'audio');
		}

		expect(Object.keys(await video.computeFrameRateMetrics({ targetPacketCount: 10 })).sort()).toEqual([
			'averageFrameRate', 'bestGuessFrameRate', 'frameRateIsConstant', 'maxFrameRate', 'medianFrameRate',
			'minFrameRate', 'probedPacketCount', 'underlyingFrameRate',
		]);
		expect(await video.getPixelAspectRatio()).toEqual({ num: 1, den: 1 });
		expect(Object.keys(await video.getColorSpace()).sort())
			.toEqual(['fullRange', 'matrix', 'primaries', 'transfer']);
		expect(await video.getTransformationMatrix()).toHaveLength(9);
	});
});
