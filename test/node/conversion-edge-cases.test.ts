import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output, OutputTrackGroup } from '../../src/output.js';
import {
	AdtsOutputFormat,
	FlacOutputFormat,
	MkvOutputFormat,
	Mp3OutputFormat,
	Mp4OutputFormat,
	OggOutputFormat,
	OutputFormat,
	WavOutputFormat,
} from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion, ConversionAudioOptions } from '../../src/conversion.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { AudioSample } from '../../src/sample.js';
import { Quality } from '../../src/encode.js';

const QUALITY = new Quality('high');
import { EBMLId } from '../../src/matroska/ebml.js';
import {
	ebml,
	ebmlFloat,
	ebmlString,
	ebmlUint,
	mkvFile,
	mkvSimpleBlock,
	riffChunk,
	waveFile,
	waveFmt,
} from './helpers/mutation-bytes.js';

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);

const VP8_KEY_FRAME = [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x40, 0x00, 0x30, 0x00];

// A small WebM with one VP8 video track and one 16-bit PCM audio track
const inputBytes = mkvFile({
	trackEntries: [
		ebml(
			EBMLId.TrackEntry,
			ebmlUint(EBMLId.TrackNumber, 1),
			ebmlUint(EBMLId.TrackUID, 1),
			ebmlUint(EBMLId.TrackType, 1),
			ebmlString(EBMLId.CodecID, 'V_VP8'),
			ebml(EBMLId.Video, ebmlUint(EBMLId.PixelWidth, 64), ebmlUint(EBMLId.PixelHeight, 48)),
		),
		ebml(
			EBMLId.TrackEntry,
			ebmlUint(EBMLId.TrackNumber, 2),
			ebmlUint(EBMLId.TrackUID, 2),
			ebmlUint(EBMLId.TrackType, 2),
			ebmlString(EBMLId.CodecID, 'A_PCM/INT/LIT'),
			ebml(
				EBMLId.Audio,
				ebmlFloat(EBMLId.SamplingFrequency, 8000),
				ebmlUint(EBMLId.Channels, 1),
				ebmlUint(EBMLId.BitDepth, 16),
			),
		),
	],
	rest: [ebml(
		EBMLId.Cluster,
		ebmlUint(EBMLId.Timestamp, 0),
		ebml(EBMLId.SimpleBlock, mkvSimpleBlock(1, 0, 0x80, VP8_KEY_FRAME)),
		ebml(EBMLId.SimpleBlock, mkvSimpleBlock(2, 0, 0x80, new Array(160).fill(0))),
	)],
});

const init = (options: Record<string, unknown>) => {
	const input = new Input({ source: new BufferSource(inputBytes), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	return Conversion.init({ input, output, ...options } as never);
};

describe('Conversion video options validation', () => {
	test.each([
		['a non-object', 3, 'options.video, when provided, must be an object'],
		['discard as a string', { discard: 'yes' }, 'options.video.discard'],
		['forceTranscode as a number', { forceTranscode: 1 }, 'options.video.forceTranscode'],
		['an unknown codec', { codec: 'h266' }, 'options.video.codec'],
		['quality that is not a Quality', { quality: 0.5 }, 'options.video.quality, when provided, must be a Quality'],
		['both quality and bitrate', { quality: QUALITY, bitrate: 1e6 }, 'cannot both be provided'],
		['a fractional bitrate', { bitrate: 1.5 }, 'options.video.bitrate'],
		['a zero bitrate', { bitrate: 0 }, 'options.video.bitrate'],
		['a zero width', { width: 0 }, 'options.video.width'],
		['a fractional height', { height: 10.5 }, 'options.video.height'],
		['an unknown fit', { width: 10, height: 10, fit: 'stretch' }, 'options.video.fit, when provided'],
		['width and height without fit', { width: 10, height: 10 }, 'options.video.fit must also be provided'],
		['a rotation of 45', { rotate: 45 }, 'options.video.rotate'],
		['flip as a number', { flip: 1 }, 'options.video.flip'],
		['allowTransformationMetadata as a string', { allowTransformationMetadata: 'no' }, 'TransformationMetadata'],
		['allowRotationMetadata as a number', { allowRotationMetadata: 0 }, 'allowRotationMetadata'],
		['a zero frame rate', { frameRate: 0 }, 'options.video.frameRate'],
		['an infinite frame rate', { frameRate: Infinity }, 'options.video.frameRate'],
		['an unknown alpha mode', { alpha: 'premultiply' }, 'options.video.alpha'],
		['a negative key frame interval', { keyFrameInterval: -1 }, 'options.video.keyFrameInterval'],
		['an infinite key frame interval', { keyFrameInterval: Infinity }, 'options.video.keyFrameInterval'],
		['process that is not a function', { process: {} }, 'options.video.process'],
		['a zero processedWidth', { processedWidth: 0 }, 'options.video.processedWidth'],
		['a fractional processedHeight', { processedHeight: 1.5 }, 'options.video.processedHeight'],
		['an unknown hardwareAcceleration', { hardwareAcceleration: 'gpu' }, 'options.video.hardwareAcceleration'],
		['group that is not an OutputTrackGroup', { group: {} }, 'options.video.group'],
		['group with a non-group entry', { group: [new OutputTrackGroup(), {}] }, 'options.video.group'],
		['a negative maximumPacketCount', { maximumPacketCount: -1 }, 'options.video.maximumPacketCount'],
		['a fractional maximumPacketCount', { maximumPacketCount: 0.5 }, 'options.video.maximumPacketCount'],
	])('rejects %s', async (_, video, message) => {
		await expect(init({ video })).rejects.toThrow(TypeError);
		await expect(init({ video })).rejects.toThrow(message);
	});

	test('options returned from a per-track function are validated too', async () => {
		await expect(init({ video: () => ({ rotate: 45 }) })).rejects.toThrow('options.video.rotate');
		await expect(init({ video: () => [{ discard: true }, { flip: 'x' }] })).rejects.toThrow('options.video.flip');
	});

	test('accepts the boundary values', async () => {
		const conversion = await init({
			video: {
				width: 32,
				height: 32,
				fit: 'contain',
				rotate: 270,
				flip: false,
				frameRate: 0.5,
				keyFrameInterval: 0,
				bitrate: QUALITY,
				processedWidth: 1,
				processedHeight: 1,
				hardwareAcceleration: 'prefer-software',
				group: [new OutputTrackGroup()],
				maximumPacketCount: 0,
				alpha: 'keep',
			},
		});
		expect(conversion).toBeInstanceOf(Conversion);
	});
});

describe('Conversion audio options validation', () => {
	test.each([
		['a non-object', 'loud', 'options.audio, when provided, must be an object'],
		['discard as a number', { discard: 0 }, 'options.audio.discard'],
		['forceTranscode as a string', { forceTranscode: 'yes' }, 'options.audio.forceTranscode'],
		['an unknown codec', { codec: 'wma' }, 'options.audio.codec'],
		['quality that is not a Quality', { quality: 'high' }, 'options.audio.quality, when provided'],
		['both quality and bitrate', { quality: QUALITY, bitrate: 128000 }, 'cannot both be provided'],
		['a negative bitrate', { bitrate: -1 }, 'options.audio.bitrate'],
		['a zero channel count', { numberOfChannels: 0 }, 'options.audio.numberOfChannels'],
		['a fractional sample rate', { sampleRate: 44100.5 }, 'options.audio.sampleRate'],
		['an unknown sample format', { sampleFormat: 'f64' }, 'options.audio.sampleFormat'],
		['process that is not a function', { process: 'fn' }, 'options.audio.process'],
		['a zero processedNumberOfChannels', { processedNumberOfChannels: 0 }, 'processedNumberOfChannels'],
		['a fractional processedSampleRate', { processedSampleRate: 0.5 }, 'options.audio.processedSampleRate'],
		['group with a non-group entry', { group: [{}] }, 'options.audio.group'],
		['a negative maximumPacketCount', { maximumPacketCount: -2 }, 'options.audio.maximumPacketCount'],
	])('rejects %s', async (_, audio, message) => {
		await expect(init({ audio })).rejects.toThrow(TypeError);
		await expect(init({ audio })).rejects.toThrow(message);
	});

	test('options returned from a per-track function are validated too', async () => {
		await expect(init({ audio: () => ({ sampleRate: -1 }) })).rejects.toThrow('options.audio.sampleRate');
	});

	test('accepts the boundary values', async () => {
		const conversion = await init({
			audio: {
				numberOfChannels: 1,
				sampleRate: 8000,
				sampleFormat: 'u8',
				processedNumberOfChannels: 1,
				processedSampleRate: 1,
				group: new OutputTrackGroup(),
				maximumPacketCount: 0,
			},
		});
		expect(conversion).toBeInstanceOf(Conversion);
	});
});

describe('Conversion top-level options validation', () => {
	test.each([
		['tracks set to something else', { tracks: 'video' }, 'options.tracks'],
		['composable as a string', { composable: 'yes' }, 'options.composable'],
		['copy as a number', { copy: 1 }, 'options.copy, when provided, must be an object or false'],
		['copy as true', { copy: true }, 'options.copy, when provided, must be an object or false'],
		['an unknown copy mode', { copy: { mode: 'always' } }, 'options.copy.mode'],
		['a negative copy shiftTolerance', { copy: { shiftTolerance: -0.1 } }, 'options.copy.shiftTolerance'],
		['a string copy shiftTolerance', { copy: { shiftTolerance: '1' } }, 'options.copy.shiftTolerance'],
		['an unknown copy boundaryPolicy', { copy: { boundaryPolicy: 'nearest' } }, 'options.copy.boundaryPolicy'],
		['a negative copy boundaryTolerance', { copy: { boundaryTolerance: -1 } }, 'copy.boundaryTolerance'],
		['trim as a number', { trim: 5 }, 'options.trim, when provided, must be an object'],
		['trim as null', { trim: null }, 'options.trim, when provided, must be an object'],
		['an infinite trim start', { trim: { start: -Infinity } }, 'options.trim.start'],
		['a string trim end', { trim: { end: '2' } }, 'options.trim.end'],
		['a trim start equal to the end', { trim: { start: 1, end: 1 } }, 'options.trim.start must be less than'],
		['a trim start after the end', { trim: { start: 2, end: 1 } }, 'options.trim.start must be less than'],
		['tags as a string', { tags: 'title' }, 'options.tags, when provided, must be an object or a function'],
		['tags as null', { tags: null }, 'options.tags, when provided, must be an object or a function'],
		['tags with an invalid title', { tags: { title: 5 } }, 'title'],
		['showWarnings as a number', { showWarnings: 0 }, 'options.showWarnings'],
	])('rejects %s', async (_, options, message) => {
		await expect(init(options)).rejects.toThrow(TypeError);
		await expect(init(options)).rejects.toThrow(message);
	});

	test('requires an Input and an Output', async () => {
		const input = new Input({ source: new BufferSource(inputBytes), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		await expect(Conversion.init(null as never)).rejects.toThrow('options must be an object');
		await expect(Conversion.init({ input: {}, output } as never)).rejects.toThrow('input must be an Input');
		await expect(Conversion.init({ input, output: {} } as never)).rejects.toThrow('output must be an Output');
	});

	test('a non-composable conversion needs a fresh output; a composable one only an unstarted one', async () => {
		const input = new Input({ source: new BufferSource(inputBytes), formats: ALL_FORMATS });

		const withTags = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		withTags.setMetadataTags({ title: 'Existing' });
		await expect(Conversion.init({ input, output: withTags })).rejects.toThrow('options.output must be fresh');
		const composableWithTags = await Conversion.init({ input, output: withTags, composable: true });
		expect(composableWithTags).toBeInstanceOf(Conversion);

		const target = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		await expect(Conversion.init({ input, output: target, composable: true, tags: { title: 'x' } }))
			.rejects.toThrow('options.tags cannot be set by a composable conversion');
	});

	test('accepts copy: false, copy objects with boundary values, a tags function and tracks: primary', async () => {
		for (const options of [
			{ copy: false },
			{ copy: { mode: 'forced', shiftTolerance: 0, boundaryPolicy: 'shrink', boundaryTolerance: 0 } },
			{ copy: { mode: 'preferred', boundaryPolicy: 'expand' } },
			{ tags: () => ({ title: 'From a function' }) },
			{ tracks: 'primary', showWarnings: false, trim: { start: 0, end: Infinity } },
		]) {
			expect(await init(options)).toBeInstanceOf(Conversion);
		}
	});
});

describe('Conversion invalidity explanations', () => {
	const audioOnlyBytes = mkvFile({
		trackEntries: [ebml(
			EBMLId.TrackEntry,
			ebmlUint(EBMLId.TrackNumber, 1),
			ebmlUint(EBMLId.TrackUID, 1),
			ebmlUint(EBMLId.TrackType, 2),
			ebmlString(EBMLId.CodecID, 'A_PCM/INT/LIT'),
			ebml(
				EBMLId.Audio,
				ebmlFloat(EBMLId.SamplingFrequency, 8000),
				ebmlUint(EBMLId.Channels, 1),
				ebmlUint(EBMLId.BitDepth, 16),
			),
		)],
		rest: [ebml(
			EBMLId.Cluster,
			ebmlUint(EBMLId.Timestamp, 0),
			ebml(EBMLId.SimpleBlock, mkvSimpleBlock(1, 0, 0x80, new Array(160).fill(0))),
		)],
	});

	const convert = async (format: OutputFormat, audio?: Record<string, unknown>) => {
		const input = new Input({ source: new BufferSource(audioOnlyBytes), formats: ALL_FORMATS });
		const output = new Output({ format, target: new BufferTarget() });
		return Conversion.init({ input, output, audio, showWarnings: false } as never);
	};

	test.each([
		['MP3', () => new Mp3OutputFormat(), 'mp3', 'The @mediabunny/mp3-encoder extension package'],
		['ADTS', () => new AdtsOutputFormat(), 'aac', 'The @mediabunny/aac-encoder extension package'],
		['FLAC', () => new FlacOutputFormat(), 'flac', 'The @mediabunny/flac-encoder extension package'],
	])('an %s output without an encoder names the codec and the extension package', async (_, format, codec, hint) => {
		const conversion = await convert(format());
		expect(conversion.isValid).toBe(false);
		expect(conversion.discardedTracks.map(x => x.reason)).toEqual(['no_encodable_target_codec']);
		const error = await conversion.execute().catch((e: unknown) => e as Error);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('Due to discarded tracks, this conversion cannot be executed.');
		expect((error as Error).message).toContain(
			`Tracks were discarded because your environment is not able to encode '${codec}' with the provided`,
		);
		expect((error as Error).message).toContain(hint);
	});

	test('a requested codec is the only one named; AC-3 points to the ac3 package', async () => {
		const ac3 = await convert(new MkvOutputFormat(), { codec: 'ac3' });
		expect(ac3.isValid).toBe(false);
		const message = ((await ac3.execute().catch((e: unknown) => e)) as Error).message;
		expect(message).toContain('not able to encode \'ac3\' with the provided parameters.');
		expect(message).toContain('The @mediabunny/ac3 extension package provides support');
		expect(message).not.toContain('aac-encoder');
	});

	test('several unencodable codecs are listed together', async () => {
		const conversion = await convert(new OggOutputFormat());
		expect(conversion.isValid).toBe(false);
		const message = ((await conversion.execute().catch((e: unknown) => e)) as Error).message;
		expect(message).toMatch(/not able to encode any of the codecs ('opus', 'vorbis'|'vorbis', 'opus') with/);
		expect(message).not.toContain('extension package');
	});

	test('tracks discarded only by the user point to discardedTracks', async () => {
		const conversion = await convert(new Mp3OutputFormat(), { discard: true });
		expect(conversion.isValid).toBe(false);
		expect(conversion.discardedTracks.map(x => x.reason)).toEqual(['discarded_by_user']);
		const message = ((await conversion.execute().catch((e: unknown) => e)) as Error).message;
		expect(message).toContain('Check the discardedTracks field for more info.');
		expect(message).not.toContain('not able to encode');
	});

	test('a PCM-capable output stays valid by transcoding to PCM', async () => {
		const conversion = await convert(new WavOutputFormat(), { forceTranscode: true });
		expect(conversion.isValid).toBe(true);
		await conversion.execute();
	});
});

describe('Conversion execution in Node (copy and PCM paths)', () => {
	// VP8 frames at 0 and 20 ms, 10 ms PCM blocks at 0, 10, 20 and 30 ms
	const avBytes = mkvFile({
		trackEntries: [
			ebml(
				EBMLId.TrackEntry,
				ebmlUint(EBMLId.TrackNumber, 1),
				ebmlUint(EBMLId.TrackUID, 1),
				ebmlUint(EBMLId.TrackType, 1),
				ebmlString(EBMLId.CodecID, 'V_VP8'),
				ebml(EBMLId.Video, ebmlUint(EBMLId.PixelWidth, 64), ebmlUint(EBMLId.PixelHeight, 48)),
			),
			ebml(
				EBMLId.TrackEntry,
				ebmlUint(EBMLId.TrackNumber, 2),
				ebmlUint(EBMLId.TrackUID, 2),
				ebmlUint(EBMLId.TrackType, 2),
				ebmlString(EBMLId.CodecID, 'A_PCM/INT/LIT'),
				ebml(
					EBMLId.Audio,
					ebmlFloat(EBMLId.SamplingFrequency, 8000),
					ebmlUint(EBMLId.Channels, 1),
					ebmlUint(EBMLId.BitDepth, 16),
				),
			),
		],
		rest: [ebml(
			EBMLId.Cluster,
			ebmlUint(EBMLId.Timestamp, 0),
			ebml(EBMLId.SimpleBlock, mkvSimpleBlock(1, 0, 0x80, VP8_KEY_FRAME)),
			ebml(EBMLId.SimpleBlock, mkvSimpleBlock(2, 0, 0x80, new Array(160).fill(1))),
			ebml(EBMLId.SimpleBlock, mkvSimpleBlock(2, 10, 0x80, new Array(160).fill(2))),
			ebml(EBMLId.SimpleBlock, mkvSimpleBlock(1, 20, 0x00, [0x11, 0, 0])),
			ebml(EBMLId.SimpleBlock, mkvSimpleBlock(2, 20, 0x80, new Array(160).fill(3))),
			ebml(EBMLId.SimpleBlock, mkvSimpleBlock(2, 30, 0x80, new Array(160).fill(4))),
		)],
	});

	const run = async (format: OutputFormat, options: Record<string, unknown> = {}) => {
		const input = new Input({ source: new BufferSource(avBytes), formats: ALL_FORMATS });
		const target = new BufferTarget();
		const output = new Output({ format, target });
		const conversion = await Conversion.init({ input, output, showWarnings: false, ...options } as never);
		const progress: number[] = [];
		conversion.onProgress = p => progress.push(p);
		expect(conversion.isValid).toBe(true);
		await conversion.execute();
		await conversion.execute(); // A finished conversion is a no-op

		using result = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const tracks: string[][] = [];
		for (const track of await result.getTracks()) {
			const packets = [`${track.type}/${await track.getCodec()}`];
			for await (const packet of new EncodedPacketSink(track).packets()) {
				packets.push(`${Math.round(packet.timestamp * 1000)}:${packet.byteLength}:${packet.type}`);
			}
			tracks.push(packets);
		}
		return { conversion, tracks, progress };
	};

	test.each([
		['Matroska', () => new MkvOutputFormat()],
		['MP4', () => new Mp4OutputFormat()],
	])('copies VP8 and PCM into %s without decoding', async (_, format) => {
		const { conversion, tracks, progress } = await run(format());
		expect(conversion.utilizedTracks.length).toBe(2);
		expect(conversion.discardedTracks).toEqual([]);
		expect(tracks[0]).toEqual(['video/vp8', '0:10:key', '20:3:delta']);
		expect(tracks[1]![0]).toBe('audio/pcm-s16');
		expect(progress[0]).toBe(0);
		expect(progress.at(-1)).toBe(1);
		expect(progress.every((value, i) => i === 0 || value >= progress[i - 1]!)).toBe(true);
	});

	test('trimming drops the video track that would need decoding and cuts PCM at the boundaries', async () => {
		const { conversion, tracks } = await run(new MkvOutputFormat(), { trim: { start: 0.01, end: 0.03 } });
		const discarded = conversion.discardedTracks.map(x => [x.track.type, x.reason]);
		expect(discarded).toEqual([['video', 'undecodable_source_codec']]);
		expect(tracks).toEqual([['audio/pcm-s16', '0:160:key', '10:160:key']]);

		const wav = await run(new WavOutputFormat(), { trim: { start: 0.005, end: 0.025 } });
		expect(wav.conversion.discardedTracks.map(x => x.reason)).toEqual(['max_track_count_of_type_reached']);
		expect(wav.tracks).toEqual([['audio/pcm-s16', '0:320:key']]);
	});

	test('PCM audio is resampled and re-encoded with the requested codec', async () => {
		const resampled = await run(new WavOutputFormat(), { audio: { sampleRate: 16000 } });
		expect(resampled.tracks).toEqual([['audio/pcm-s16', '0:1280:key']]);
		const s32 = await run(new MkvOutputFormat(), { video: { discard: true }, audio: { codec: 'pcm-s32' } });
		expect(s32.tracks).toEqual([['audio/pcm-s32', '0:1280:key']]);
	});

	test('unintentionally discarded tracks are reported with a warning unless showWarnings is false', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const init = (showWarnings?: boolean) => Conversion.init({
				input: new Input({ source: new BufferSource(avBytes), formats: ALL_FORMATS }),
				output: new Output({ format: new WavOutputFormat(), target: new BufferTarget() }),
				showWarnings,
			});
			await init(false);
			expect(warn).not.toHaveBeenCalled();
			await init();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]![0]).toBe('Some tracks had to be discarded from the conversion:');
		} finally {
			warn.mockRestore();
		}
	});
});

describe('Ogg remuxing', () => {
	test.each(['vorbis-eos.ogg', 'preroll-test.opus'])('%s is copied packet for packet, shifted', async (name) => {
		const input = new Input({
			source: new FilePathSource(path.join(__dirname, '..', 'public', name)),
			formats: ALL_FORMATS,
		});
		const target = new BufferTarget();
		const output = new Output({ format: new OggOutputFormat(), target });
		// Ogg starts at zero, so the negative start (decoder delay) can only be kept by shifting
		const conversion = await Conversion.init({
			input,
			output,
			tags: { title: 'Remuxed', artist: 'Someone' },
			copy: { shiftTolerance: 0.1 },
			showWarnings: false,
		});
		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		const inputTrack = (await input.getPrimaryAudioTrack())!;
		const shift = -(await inputTrack.getFirstTimestamp());
		expect(shift).toBeGreaterThan(0);
		using result = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		expect(await result.getMetadataTags()).toMatchObject({ title: 'Remuxed', artist: 'Someone' });
		const outputTrack = (await result.getPrimaryAudioTrack())!;
		expect(await outputTrack.getCodec()).toBe(await inputTrack.getCodec());
		expect(await outputTrack.getNumberOfChannels()).toBe(await inputTrack.getNumberOfChannels());
		expect(await outputTrack.getSampleRate()).toBe(await inputTrack.getSampleRate());

		const original = [];
		for await (const packet of new EncodedPacketSink(inputTrack).packets()) {
			original.push(packet);
		}
		let count = 0;
		let mismatches = 0;
		for await (const packet of new EncodedPacketSink(outputTrack).packets()) {
			const source = original[count++]!;
			if (
				Math.abs(packet.timestamp - (source.timestamp + shift)) > 1e-9
				|| Math.abs(packet.duration - source.duration) > 1e-9
				|| !sameBytes(packet.data, source.data)
			) {
				mismatches++;
			}
		}
		expect([count, mismatches]).toEqual([original.length, 0]);
		input.dispose();
	});
});

describe('Audio-only remuxing', () => {
	test.each([
		['Toothsome-Meme.VBRv2.mp3', () => new Mp3OutputFormat()],
		['sample3.aac', () => new AdtsOutputFormat()],
		['sample.flac', () => new FlacOutputFormat()],
		['glitch-hop-is-dead.wav', () => new WavOutputFormat()],
	])('%s keeps every packet', async (name, format) => {
		const filePath = path.join(__dirname, '..', 'public', name);
		const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
		const target = new BufferTarget();
		const output = new Output({ format: format(), target });
		const conversion = await Conversion.init({
			input,
			output,
			tags: { title: 'Remuxed' },
			copy: { shiftTolerance: 0.1 },
			showWarnings: false,
		});
		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		const inputTrack = (await input.getPrimaryAudioTrack())!;
		using result = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		expect((await result.getMetadataTags()).title).toBe('Remuxed');
		const outputTrack = (await result.getPrimaryAudioTrack())!;
		expect(await outputTrack.getCodec()).toBe(await inputTrack.getCodec());

		const original = [];
		for await (const packet of new EncodedPacketSink(inputTrack).packets()) {
			original.push(packet);
		}
		let count = 0;
		let mismatches = 0;
		let shift: number | null = null;
		for await (const packet of new EncodedPacketSink(outputTrack).packets()) {
			const source = original[count++]!;
			// Formats without a way to store the encoder delay may shift everything to start at zero
			shift ??= packet.timestamp - source.timestamp;
			if (
				Math.abs(packet.timestamp - (source.timestamp + shift)) > 1e-9
				|| Math.abs(packet.duration - source.duration) > 1e-9
				|| !sameBytes(packet.data, source.data)
			) {
				mismatches++;
			}
		}
		expect([count, mismatches]).toEqual([original.length, 0]);
		expect(shift).toBeGreaterThanOrEqual(0);
		input.dispose();
	});
});

describe('PCM audio transcoding options', () => {
	// 100 ms of 8 kHz stereo s16: L = 0.25, R = -0.125 for the first half, then L = 0, R = 0.5
	const frames = Array.from({ length: 800 }, (_, i) => (i < 400 ? [8192, -4096] : [0, 16384]));
	const wav = waveFile([
		riffChunk('fmt ', waveFmt({ formatTag: 1, channels: 2, sampleRate: 8000, bitsPerSample: 16 })),
		riffChunk('data', new Uint8Array(new Int16Array(frames.flat()).buffer)),
	]);

	const convert = async (audio: ConversionAudioOptions) => {
		const input = new Input({ source: new BufferSource(wav), formats: ALL_FORMATS });
		const target = new BufferTarget();
		const output = new Output({ format: new WavOutputFormat(), target });
		const conversion = await Conversion.init({ input, output, audio, showWarnings: false });
		await conversion.execute();

		using result = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const track = (await result.getPrimaryAudioTrack())!;
		// The first frame of the first and second half
		const picks: number[][] = [];
		let frameCount = 0;
		for await (const sample of new AudioSampleSink(track).samples()) {
			const data = new Float32Array(sample.numberOfFrames * sample.numberOfChannels);
			sample.copyTo(data, { planeIndex: 0, format: 'f32' });
			for (let i = 0; i < sample.numberOfFrames; i++) {
				const frame = frameCount + i;
				if (frame === 0 || frame === sample.sampleRate / 20) {
					picks.push([...data.subarray(i * sample.numberOfChannels, (i + 1) * sample.numberOfChannels)]);
				}
			}
			frameCount += sample.numberOfFrames;
			sample.close();
		}
		return {
			codec: await track.getCodec(),
			channels: await track.getNumberOfChannels(),
			sampleRate: await track.getSampleRate(),
			frameCount,
			picks,
		};
	};

	test.each([
		['downmixing to mono averages the channels', { numberOfChannels: 1 }, 'pcm-s16', 8000, [[0.0625], [0.25]]],
		['upmixing to quad leaves the surround channels silent', { numberOfChannels: 4 },
			'pcm-s16', 8000, [[0.25, -0.125, 0, 0], [0, 0.5, 0, 0]]],
		['upmixing to 5.1 leaves center, LFE and surrounds silent', { numberOfChannels: 6 },
			'pcm-s16', 8000, [[0.25, -0.125, 0, 0, 0, 0], [0, 0.5, 0, 0, 0, 0]]],
		['halving the sample rate halves the frames', { sampleRate: 4000 },
			'pcm-s16', 4000, [[0.25, -0.125], [0, 0.5]]],
		['pcm-f32 output', { codec: 'pcm-f32' }, 'pcm-f32', 8000, [[0.25, -0.125], [0, 0.5]]],
		['pcm-u8 output', { codec: 'pcm-u8' }, 'pcm-u8', 8000, [[0.25, -0.125], [0, 0.5]]],
		['forced transcoding keeps the samples', { forceTranscode: true }, 'pcm-s16', 8000, [[0.25, -0.125], [0, 0.5]]],
	] as [string, ConversionAudioOptions, string, number, number[][]][])(
		'%s',
		async (_, audio, codec, sampleRate, picks) => {
			const result = await convert(audio);
			expect(result).toEqual({
				codec,
				channels: picks[0]!.length,
				sampleRate,
				frameCount: sampleRate / 10,
				picks,
			});
		},
	);

	test('process can transform samples, and change the channel count when it says so', async () => {
		const halved = await convert({
			process: (sample) => {
				const data = new Float32Array(sample.numberOfFrames * sample.numberOfChannels);
				sample.copyTo(data, { planeIndex: 0, format: 'f32' });
				return new AudioSample({
					data: data.map(value => value / 2),
					format: 'f32',
					numberOfChannels: sample.numberOfChannels,
					sampleRate: sample.sampleRate,
					timestamp: sample.timestamp,
				});
			},
		});
		expect(halved.picks).toEqual([[0.125, -0.0625], [0, 0.25]]);

		const mono = await convert({
			process: sample => new AudioSample({
				data: new Float32Array(sample.numberOfFrames).fill(0.25),
				format: 'f32',
				numberOfChannels: 1,
				sampleRate: sample.sampleRate,
				timestamp: sample.timestamp,
			}),
			processedNumberOfChannels: 1,
		});
		expect([mono.channels, mono.frameCount, mono.picks]).toEqual([1, 800, [[0.25], [0.25]]]);
	});
});
