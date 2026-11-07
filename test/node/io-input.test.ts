import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ADTS,
	ALL_FORMATS,
	BufferSource,
	CustomPathedSource,
	CustomSource,
	FLAC,
	HLS,
	HLS_FORMATS,
	Input,
	InputDisposedError,
	InputFormat,
	MATROSKA,
	MP3,
	MP4,
	MPEG_TS,
	OGG,
	QTFF,
	UnsupportedInputFormatError,
	WAVE,
	WEBM,
} from '../../src/index.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { createRandomBytes } from './helpers/io-random.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicFile = (name: string) => new Uint8Array(fs.readFileSync(path.join(__dirname, '../public', name)));

const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
const u32be = (value: number) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u32le = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
const concat = (...parts: (number[] | Uint8Array)[]) => {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return bytes;
};

const isobmffBox = (type: string, payload: number[] | Uint8Array = []) => {
	return concat(u32be(8 + payload.length), ascii(type), payload);
};
const ftyp = (majorBrand: string, compatibleBrands: string[] = []) => {
	return isobmffBox('ftyp', [...ascii(majorBrand), ...u32be(0), ...compatibleBrands.flatMap(ascii)]);
};

/** A minimal EBML header with the given DocType (string bytes, so padding can be tested) and versions. */
type EbmlHeaderOptions = {
	ebmlVersion?: number;
	ebmlReadVersion?: number;
	docTypeVersion?: number;
	docTypeReadVersion?: number;
	extra?: number[];
};
const ebmlHeader = (docType: number[], options: EbmlHeaderOptions = {}) => {
	const children = [
		0x42, 0x86, 0x81, options.ebmlVersion ?? 1, // EBMLVersion
		0x42, 0xf7, 0x81, options.ebmlReadVersion ?? 1, // EBMLReadVersion
		0x42, 0xf2, 0x81, 0x04, // EBMLMaxIDLength
		0x42, 0xf3, 0x81, 0x08, // EBMLMaxSizeLength
		0x42, 0x82, 0x80 | docType.length, ...docType, // DocType
		0x42, 0x87, 0x81, options.docTypeVersion ?? 4, // DocTypeVersion
		0x42, 0x85, 0x81, options.docTypeReadVersion ?? 2, // DocTypeReadVersion
		...(options.extra ?? []),
	];
	return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80 | children.length, ...children]);
};

const id3v2Tag = (payloadSize: number) => {
	const size = [21, 14, 7, 0].map(shift => (payloadSize >> shift) & 0x7f); // Synchsafe
	return concat(ascii('ID3'), [4, 0, 0], size, new Uint8Array(payloadSize));
};

/** An MPEG-1 Layer III frame: 128 kbit/s, 44.1 kHz, stereo, 417 bytes. */
const mp3Frame = () => concat([0xff, 0xfb, 0x90, 0x00], new Uint8Array(417 - 4));

/** An ADTS frame: AAC-LC, 48 kHz, stereo, with the given total length. */
const adtsFrame = (length = 100) => concat([
	0xff, 0xf1, 0x4c, 0x80 | (length >> 11), (length >> 3) & 0xff, ((length & 7) << 5) | 0x1f, 0xfc,
], new Uint8Array(length - 7));

const tsPackets = (packetSize: number, count: number, prefixSize = 0) => {
	const bytes = new Uint8Array(packetSize * count);
	for (let i = 0; i < count; i++) {
		bytes[i * packetSize + prefixSize] = 0x47;
		bytes[i * packetSize + prefixSize + 1] = 0x1f; // PID 0x1fff (null packet)
		bytes[i * packetSize + prefixSize + 2] = 0xff;
		bytes[i * packetSize + prefixSize + 3] = 0x10;
	}
	return bytes;
};

const detect = async (bytes: Uint8Array, formats: InputFormat[] = ALL_FORMATS) => {
	using input = new Input({ source: new BufferSource(bytes), formats });
	try {
		return await input.getFormat();
	} catch (error) {
		if (error instanceof UnsupportedInputFormatError) {
			return null;
		}
		throw error;
	}
};

describe('Format detection', () => {
	test.each([
		['ftyp isom', () => ftyp('isom', ['isom', 'mp41']), MP4],
		['ftyp M4A', () => ftyp('M4A ', ['M4A ', 'mp42']), MP4],
		['ftyp 3gp5', () => ftyp('3gp5', ['3gp5']), MP4],
		['ftyp qt', () => ftyp('qt  ', ['qt  ']), QTFF],
		['ftyp mp42 listing qt as compatible', () => ftyp('mp42', ['qt  ']), MP4],
		['styp (media segment)', () => isobmffBox('styp', [...ascii('msdh'), ...u32be(0), ...ascii('msdh')]), MP4],
		['a bare moof', () => isobmffBox('moof', isobmffBox('mfhd', new Uint8Array(8))), MP4],
		['a leading sidx', () => isobmffBox('sidx', new Uint8Array(24)), MP4],
		['emsg before moof', () => concat(isobmffBox('emsg', new Uint8Array(20)), isobmffBox('moof')), MP4],
		['prft and free before moof', () => concat(
			isobmffBox('prft', new Uint8Array(12)),
			isobmffBox('free'),
			isobmffBox('moof'),
		), MP4],
		['EBML DocType matroska', () => ebmlHeader(ascii('matroska')), MATROSKA],
		['EBML DocType webm', () => ebmlHeader(ascii('webm')), WEBM],
		['EBML DocType webm with zero padding', () => ebmlHeader([...ascii('webm'), 0, 0]), WEBM],
		['EBML header with a CRC-32 element', () => ebmlHeader(
			ascii('webm'),
			{ extra: [0xbf, 0x84, 1, 2, 3, 4] },
		), WEBM],
		['RIFF WAVE', () => concat(ascii('RIFF'), u32le(4), ascii('WAVE')), WAVE],
		['RIFX WAVE', () => concat(ascii('RIFX'), u32be(4), ascii('WAVE')), WAVE],
		['RF64 WAVE', () => concat(ascii('RF64'), u32le(0xffffffff), ascii('WAVE')), WAVE],
		['OggS', () => concat(ascii('OggS'), new Uint8Array(23)), OGG],
		['fLaC', () => concat(ascii('fLaC'), new Uint8Array(38)), FLAC],
		['fLaC behind two ID3v2 tags', () => concat(
			id3v2Tag(100),
			id3v2Tag(20),
			ascii('fLaC'),
			new Uint8Array(38),
		), FLAC],
		['two MP3 frames', () => concat(mp3Frame(), mp3Frame(), mp3Frame()), MP3],
		['MP3 frames behind an ID3v2 tag', () => concat(id3v2Tag(5000), mp3Frame(), mp3Frame()), MP3],
		['MP3 frames after a little junk', () => concat(new Uint8Array(100), mp3Frame(), mp3Frame()), MP3],
		['two ADTS frames', () => concat(adtsFrame(), adtsFrame(), adtsFrame()), ADTS],
		['ADTS frames behind an ID3v2 tag', () => concat(id3v2Tag(64), adtsFrame(), adtsFrame()), ADTS],
		['188-byte TS packets', () => tsPackets(188, 3), MPEG_TS],
		['192-byte M2TS packets', () => tsPackets(192, 3, 4), MPEG_TS],
		['204-byte TS packets', () => tsPackets(204, 3), MPEG_TS],
	] as [string, () => Uint8Array, InputFormat][])('recognizes %s', async (_, build, format) => {
		expect(await detect(build())).toBe(format);
	});

	test.each([
		['an empty file', () => new Uint8Array(0)],
		['a single byte', () => new Uint8Array([0x47])],
		['random bytes', () => createRandomBytes(10_000, 11)],
		['zeros', () => new Uint8Array(10_000)],
		['RIFF AVI', () => concat(ascii('RIFF'), u32le(4), ascii('AVI '), new Uint8Array(100))],
		['FORM AIFF', () => concat(ascii('FORM'), u32be(4), ascii('AIFF'), new Uint8Array(100))],
		['an unknown leading ISOBMFF box', () => isobmffBox('abcd', new Uint8Array(100))],
		['an ISOBMFF box smaller than its header', () => concat(u32be(4), ascii('moof'), new Uint8Array(9))],
		// Only the read versions say whether a reader can handle the file (RFC 8794 §11.2.3, RFC 9559 §7)
		['EBML needing DocType read version 5', () => ebmlHeader(ascii('matroska'), {
			docTypeVersion: 5,
			docTypeReadVersion: 5,
		})],
		['EBML needing EBML read version 2', () => ebmlHeader(ascii('matroska'), {
			ebmlVersion: 2,
			ebmlReadVersion: 2,
		})],
		['an unknown EBML DocType', () => ebmlHeader(ascii('mka'))],
		['a lone MP3 frame header and junk', () => concat(mp3Frame().subarray(0, 4), createRandomBytes(5000, 12))],
		['ADTS frames with differing sample rates', () => {
			const second = adtsFrame();
			second[2] = 0x48; // Sampling frequency index 2 (64 kHz) instead of 3
			return concat(adtsFrame(), second, adtsFrame());
		}],
		['a single 0x47 sync byte', () => concat([0x47], new Uint8Array(400))],
		['an ID3v2 tag followed by nothing recognizable', () => concat(id3v2Tag(100), createRandomBytes(5000, 13))],
	] as [string, () => Uint8Array][])('does not recognize %s', async (_, build) => {
		expect(await detect(build())).toBeNull();
	});

	test('recognizes the repository fixtures', async () => {
		const expectations: [string, InputFormat][] = [
			['video.mp4', MP4],
			['trunc-buck-bunny.mov', QTFF],
			['frames.webm', WEBM],
			['ac3.mkv', MATROSKA],
			['glitch-hop-is-dead.wav', WAVE],
			['sample.flac', FLAC],
			['Toothsome-Meme.VBRv2.mp3', MP3],
			['sample3.aac', ADTS],
			['0.ts', MPEG_TS],
			['vorbis-eos.ogg', OGG],
			['preroll-test.opus', OGG],
		];

		for (const [name, format] of expectations) {
			expect(await detect(publicFile(name)), name).toBe(format);
		}
	});

	test('detection stops at the first format in the list that accepts the file', async () => {
		// Let two formats accept anything, so that only their order decides
		const mp3Accepts = vi.spyOn(MP3, '_canReadInput').mockResolvedValue(true);
		const adtsAccepts = vi.spyOn(ADTS, '_canReadInput').mockResolvedValue(true);
		try {
			const bytes = createRandomBytes(1000, 15);
			expect(await detect(bytes, [MP3, ADTS])).toBe(MP3);
			expect(adtsAccepts).not.toHaveBeenCalled();
			expect(await detect(bytes, [ADTS, MP3])).toBe(ADTS);
			expect(await detect(bytes, [WAVE, FLAC, MP3, ADTS])).toBe(MP3); // The ones that reject are skipped
			expect(mp3Accepts).toHaveBeenCalledTimes(2);
		} finally {
			mp3Accepts.mockRestore();
			adtsAccepts.mockRestore();
		}

		expect(await detect(concat(mp3Frame(), mp3Frame(), mp3Frame()), [WAVE, FLAC])).toBeNull();
	});

	test('MATROSKA and WEBM each only accept their own DocType', async () => {
		expect(await detect(ebmlHeader(ascii('webm')), [MATROSKA])).toBeNull();
		expect(await detect(ebmlHeader(ascii('matroska')), [WEBM])).toBeNull();
		expect(await detect(ebmlHeader(ascii('webm')), [MATROSKA, WEBM])).toBe(WEBM);
	});

	test('HLS playlists need a PathedSource', async () => {
		const playlist = new TextEncoder().encode('#EXTM3U\n#EXT-X-ENDLIST\n');
		using bufferInput = new Input({ source: new BufferSource(playlist), formats: ALL_FORMATS });
		await expect(bufferInput.getFormat()).rejects.toThrow(
			new TypeError('HLS inputs require `InputOptions.source` to be a PathedSource or a ref to one.'),
		);

		using pathedInput = new Input({
			source: new CustomPathedSource('master.m3u8', () => new BufferSource(playlist)),
			formats: HLS_FORMATS,
		});
		expect(await pathedInput.getFormat()).toBe(HLS);

		// Without HLS in the list, the playlist is just an unknown text file
		expect(await detect(playlist, [MP4, MP3, ADTS, MPEG_TS])).toBeNull();
	});
});

describe('Input', () => {
	test('validates its options', () => {
		const source = new BufferSource(new Uint8Array(1));
		expect(() => new Input(null as never)).toThrow(new TypeError('options must be an object.'));
		expect(() => new Input({ source, formats: MP4 as never })).toThrow(
			new TypeError('options.formats must be an array of InputFormat.'),
		);
		expect(() => new Input({ source, formats: [MP4, 'mp3' as never] })).toThrow(
			new TypeError('options.formats must be an array of InputFormat.'),
		);
		expect(() => new Input({ source, formats: ALL_FORMATS, initInput: {} as never })).toThrow(
			new TypeError('options.initInput, when provided, must be an Input.'),
		);
		expect(() => new Input({ source, formats: ALL_FORMATS, formatOptions: 1 as never })).toThrow(
			new TypeError('formatOptions, when provided, must be an object.'),
		);
		expect(() => new Input({
			source,
			formats: ALL_FORMATS,
			formatOptions: { isobmff: { resolveKeyId: 1 as never } },
		})).toThrow(new TypeError('formatOptions.isobmff.resolveKeyId, when provided, must be a function.'));
		expect(() => new Input({
			source,
			formats: ALL_FORMATS,
			formatOptions: { hls: { offsetTimestampsByDateTime: 'yes' as never } },
		})).toThrow(new TypeError('formatOptions.hls.offsetTimestampsByDateTime, when provided, must be a boolean.'));
	});

	test('performs no reads until asked, then detects the format once', async () => {
		const read = vi.fn((start: number, end: number) => publicFile('video.mp4').slice(start, end));
		const source = new CustomSource({ getSize: () => publicFile('video.mp4').length, read });
		const input = new Input({ source, formats: ALL_FORMATS });
		expect(read).not.toHaveBeenCalled();

		const canReadInput = vi.spyOn(MP4, '_canReadInput');
		try {
			const [a, b] = await Promise.all([input.getFormat(), input.getFormat()]);
			expect(a).toBe(MP4);
			expect(b).toBe(MP4);
			expect(await input.canRead()).toBe(true);
			expect(canReadInput).toHaveBeenCalledTimes(1);
		} finally {
			canReadInput.mockRestore();
			input.dispose();
		}
	});

	test('emits a source event for the root source', async () => {
		const source = new BufferSource(publicFile('video.mp4'));
		using input = new Input({ source, formats: ALL_FORMATS });
		const events: unknown[] = [];
		input.on('source', event => events.push(event));

		await input.getFormat();
		await input.getTracks();
		expect(events).toEqual([{ source, request: null, isRoot: true }]);
	});

	test('emits a source event for every file an HLS input loads', async () => {
		// Split an ADTS file into three segments at frame boundaries
		const aac = publicFile('sample3.aac');
		const frameStarts: number[] = [];
		const frameLength = (pos: number) => ((aac[pos + 3]! & 3) << 11) | (aac[pos + 4]! << 3) | (aac[pos + 5]! >> 5);
		for (let pos = 0; pos < aac.length; pos += frameLength(pos)) {
			frameStarts.push(pos);
		}
		const third = Math.ceil(frameStarts.length / 3);
		const segments = [0, 1, 2].map(i => aac.subarray(frameStarts[i * third], frameStarts[(i + 1) * third]));
		const segmentDuration = (third * 1024 / 44100).toFixed(3);

		const files: Record<string, string | Uint8Array> = {
			'master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\naudio/media.m3u8\n',
			'audio/media.m3u8': '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n'
				+ segments.map((_, i) => `#EXTINF:${segmentDuration},\nseg${i}.aac\n`).join('')
				+ '#EXT-X-ENDLIST\n',
			...Object.fromEntries(segments.map((segment, i) => [`audio/seg${i}.aac`, segment])),
		};

		const source = new CustomPathedSource('master.m3u8', ({ path }) => {
			const file = files[path]!;
			return new BufferSource(typeof file === 'string' ? new TextEncoder().encode(file) : file);
		});
		using input = new Input({ source, formats: ALL_FORMATS });
		const events: { path: string | null; isRoot: boolean; requestIsRoot: boolean | null }[] = [];
		input.on('source', (event) => {
			expect(event.source).toBeInstanceOf(event.request ? BufferSource : CustomPathedSource);
			events.push({
				path: event.request?.path ?? null,
				isRoot: event.isRoot,
				requestIsRoot: event.request?.isRoot ?? null,
			});
		});

		const track = (await input.getPrimaryAudioTrack())!;
		let packetCount = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			void packet;
			packetCount++;
		}

		expect(packetCount).toBe(frameStarts.length);
		expect(events).toEqual([
			{ path: null, isRoot: true, requestIsRoot: null },
			...['audio/media.m3u8', 'audio/seg0.aac', 'audio/seg1.aac', 'audio/seg2.aac'].map(path => ({
				path,
				isRoot: false,
				requestIsRoot: false,
			})),
		]);
	});

	test('reports unsupported files through canRead and UnsupportedInputFormatError', async () => {
		using input = new Input({ source: new BufferSource(createRandomBytes(1000, 14)), formats: ALL_FORMATS });
		expect(await input.canRead()).toBe(false);

		const error = await input.getTracks().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(UnsupportedInputFormatError);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe('UnsupportedInputFormatError');
		expect((error as Error).message).toBe('Input has an unsupported or unrecognizable format.');
	});

	test('canRead rethrows errors that are not about the format', async () => {
		const failure = new Error('Network down');
		using input = new Input({
			source: new CustomSource({ getSize: () => 100, read: () => { throw failure; } }),
			formats: ALL_FORMATS,
		});
		await expect(input.canRead()).rejects.toBe(failure);
	});

	test('error classes carry their names and default messages', () => {
		const disposed = new InputDisposedError();
		expect(disposed.name).toBe('InputDisposedError');
		expect(disposed.message).toBe('Input has been disposed.');
		expect(new InputDisposedError('custom').message).toBe('custom');
		expect(new UnsupportedInputFormatError('custom').message).toBe('custom');
	});

	test('dispose is idempotent, sets disposed and rejects in-flight reads with InputDisposedError', async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => release = resolve);
		const input = new Input({
			source: new CustomSource({
				getSize: () => 1000,
				read: async (start, end) => {
					await gate;
					return new Uint8Array(end - start);
				},
			}),
			formats: ALL_FORMATS,
		});

		const pending = input.getFormat();
		await new Promise(resolve => setTimeout(resolve, 5));
		expect(input.disposed).toBe(false);
		input.dispose();
		input.dispose();
		expect(input.disposed).toBe(true);
		release();

		await expect(pending).rejects.toBeInstanceOf(InputDisposedError);
	});

	test('`using` disposes the input and its source', async () => {
		const source = new BufferSource(publicFile('video.mp4'));
		{
			using input = new Input({ source, formats: ALL_FORMATS });
			expect(await input.getFormat()).toBe(MP4);
		}
		expect(source._disposed).toBe(true);
	});

	test('computes durations and first timestamps over all tracks or a given subset', async () => {
		using input = new Input({ source: new BufferSource(publicFile('video.mp4')), formats: ALL_FORMATS });
		const tracks = await input.getTracks();
		const video = (await input.getPrimaryVideoTrack())!;
		const audio = (await input.getPrimaryAudioTrack())!;
		expect(tracks).toContain(video);
		expect(tracks).toContain(audio);

		const videoDuration = await video.computeDuration();
		const audioDuration = await audio.computeDuration();
		expect(await input.computeDuration()).toBe(Math.max(videoDuration, audioDuration));
		expect(await input.computeDuration([video])).toBe(videoDuration);
		expect(await input.computeDuration([])).toBe(0);

		expect(await input.getFirstTimestamp()).toBe(
			Math.min(await video.getFirstTimestamp(), await audio.getFirstTimestamp()),
		);
		expect(await input.getFirstTimestamp([])).toBe(0);
		expect(await input.getDurationFromMetadata([])).toBeNull();
	});

	test('returns the same track objects on every call', async () => {
		using input = new Input({ source: new BufferSource(publicFile('video.mp4')), formats: ALL_FORMATS });
		const first = await input.getTracks();
		const second = await input.getTracks();
		expect(second).toEqual(first);
		for (let i = 0; i < first.length; i++) {
			expect(second[i]).toBe(first[i]);
		}
		expect((await input.getVideoTracks())[0]).toBe(first.find(x => x.isVideoTrack()));
		expect((await input.getAudioTracks())[0]).toBe(first.find(x => x.isAudioTrack()));
	});

	test('has no primary video track for audio-only files and vice versa', async () => {
		using audioOnly = new Input({ source: new BufferSource(publicFile('sample.flac')), formats: ALL_FORMATS });
		expect(await audioOnly.getPrimaryVideoTrack()).toBeNull();
		expect(await audioOnly.getPrimaryAudioTrack()).not.toBeNull();

		using videoOnly = new Input({ source: new BufferSource(publicFile('frames.webm')), formats: ALL_FORMATS });
		expect(await videoOnly.getPrimaryAudioTrack()).toBeNull();
		expect(await videoOnly.getPrimaryVideoTrack()).not.toBeNull();
	});
});

describe('Input.getMimeType', () => {
	// RFC 2045: the type and subtype are case-insensitive (MPEG-TS is written video/MP2T or video/mp2t), but parameters
	// aren't
	const splitMimeType = (mimeType: string) => {
		const separator = mimeType.indexOf(';');
		return separator === -1
			? [mimeType.toLowerCase(), '']
			: [mimeType.slice(0, separator).toLowerCase(), mimeType.slice(separator)];
	};

	test.each([
		['video.mp4', 'video/mp4', true],
		['trunc-buck-bunny.mov', 'video/quicktime', true],
		['frames.webm', 'video/webm', true],
		['ac3.mkv', 'audio/x-matroska', true],
		['0.ts', 'video/MP2T', true],
		['preroll-test.opus', 'audio/ogg', true],
		['vorbis-eos.ogg', 'audio/ogg', true],
		['sample.flac', 'audio/flac', false],
		['Toothsome-Meme.VBRv2.mp3', 'audio/mpeg', false],
		['sample3.aac', 'audio/aac', false],
		['glitch-hop-is-dead.wav', 'audio/wav', false],
	])('%s is %s, listing its track codecs: %s', async (name, baseType, listsCodecs) => {
		using input = new Input({ source: new BufferSource(publicFile(name)), formats: ALL_FORMATS });
		const mimeType = await input.getMimeType();

		if (!listsCodecs) {
			expect(splitMimeType(mimeType)).toEqual([baseType.toLowerCase(), '']);
			return;
		}

		// RFC 6381: a quoted, comma-separated list of the codecs of every track, each listed once
		const trackCodecs = await Promise.all((await input.getTracks()).map(t => t.getCodecParameterString()));
		const uniqueCodecs = [...new Set(trackCodecs.filter(x => x !== null))];
		expect(splitMimeType(mimeType)).toEqual([baseType.toLowerCase(), `; codecs="${uniqueCodecs.join(', ')}"`]);
	});

	test('lists the codec of identical tracks only once', async () => {
		const source = new BufferSource(publicFile('multiple-aac-tracks.mp4'));
		using input = new Input({ source, formats: ALL_FORMATS });
		const tracks = await input.getTracks();
		expect(tracks.length).toBeGreaterThan(1);
		const mimeType = await input.getMimeType();
		const codecs = /codecs="([^"]+)"/.exec(mimeType)![1]!.split(', ');
		expect(new Set(codecs).size).toBe(codecs.length);
	});
});
