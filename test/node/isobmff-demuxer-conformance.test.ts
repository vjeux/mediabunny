import { createCipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
	ALL_FORMATS,
	BufferSource,
	EncodedPacket,
	EncodedPacketSink,
	Input,
	InputAudioTrack,
	InputTrack,
	InputVideoTrack,
	MP4,
	PsshBox,
	QTFF,
} from '../../src/index.js';
import {
	IsobmffInputFormatOptions,
} from '../../src/input-format.js';
import {
	ascii,
	audioSampleEntry,
	box,
	buildFragment,
	buildFragmentedMp4,
	buildInit,
	buildMp4,
	Bytes,
	FragmentedTrack,
	FragmentSample,
	co64,
	dataBox,
	elst,
	esds,
	ftyp,
	fullBox,
	hdlr,
	i16,
	ilstMeta,
	largeBox,
	Matrix,
	mdhd,
	mfra,
	mvhd,
	packLanguage,
	SAMPLE_FLAGS_NON_SYNC,
	SAMPLE_FLAGS_SYNC,
	soundV1Fields,
	soundV2Fields,
	stco,
	stsc,
	stsd,
	stsz,
	stts,
	stz2,
	TableSample,
	TableTrack,
	tkhd,
	u16,
	u24,
	u32,
	u64,
	udtaText,
	utf8,
	visualSampleEntry,
	zeros,
} from './helpers/isobmff-demux-builders.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Conformance suite for ISOBMFF reading (MP4, MOV, fMP4/CMAF): box framing, headers, sample entries, sample tables,
// edit lists, fragments, metadata and Common Encryption. Files are built in-test; expectations follow ISO/IEC 14496-12
// as implemented by FFmpeg (libavformat/mov.c) and Chromium (media/formats/mp4), QTFF 2001 and ISO/IEC 23001-7.

const open = (bytes: Uint8Array, isobmff?: IsobmffInputFormatOptions) => new Input({
	source: new BufferSource(bytes),
	formats: ALL_FORMATS,
	formatOptions: isobmff ? { isobmff } : undefined,
});

const collect = async (track: InputTrack, metadataOnly = true) => {
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly })) {
		packets.push(packet);
	}
	return packets;
};

/** Runs `fn` with an input that's disposed afterwards (keeps `using` out of loop bodies) */
const withInput = async (bytes: Uint8Array, fn: (input: Input) => Promise<void>) => {
	using input = open(bytes);
	await fn(input);
};

/** [timestamp, duration, key/delta, byte length] per packet, in decode order */
const describePackets = async (track: InputTrack) => {
	return (await collect(track)).map(packet => [
		packet.timestamp,
		packet.duration,
		packet.type === 'key' ? 'K' : 'D',
		packet.byteLength,
	]);
};

const firstVideoTrack = async (input: Input) => {
	const track = (await input.getVideoTracks())[0];
	expect(track).toBeDefined();
	return track as InputVideoTrack;
};

const firstAudioTrack = async (input: Input) => {
	const track = (await input.getAudioTracks())[0];
	expect(track).toBeDefined();
	return track as InputAudioTrack;
};

/** Samples with distinct payloads, so data offsets can be checked */
const samples = (count: number, duration: number, options: {
	size?: (i: number) => number;
	keyFrames?: (i: number) => boolean;
	compositionOffsets?: number[];
} = {}): TableSample[] => Array.from({ length: count }, (_, i) => ({
	data: Array.from({ length: options.size?.(i) ?? 10 + i }, (_, j) => (i * 7 + j) & 0xff),
	duration,
	compositionOffset: options.compositionOffsets?.[i],
	isKeyFrame: options.keyFrames?.(i) ?? true,
}));

const avcC = box('avcC', [1, 0x64, 0x00, 0x1f, 0xff, 0xe0, 0x00]); // High profile, level 3.1, no parameter sets
const avc1 = (options: { width?: number; height?: number; children?: Bytes[] } = {}) => visualSampleEntry('avc1', {
	...options,
	children: [avcC, ...(options.children ?? [])],
});
const mp4a = (options: Parameters<typeof esds>[0] & { channels?: number; sampleRate?: number } = {}) => {
	return audioSampleEntry('mp4a', {
		channels: options.channels ?? 2,
		sampleRate: options.sampleRate ?? 44100,
		children: [esds(options)],
	});
};

const videoTrack = (overrides: Partial<TableTrack> = {}): TableTrack => ({
	timescale: 30,
	sampleEntry: avc1(),
	samples: samples(6, 1),
	...overrides,
});

const audioTrack = (overrides: Partial<TableTrack> = {}): TableTrack => ({
	handlerType: 'soun',
	trackId: 2,
	timescale: 44100,
	sampleEntry: mp4a(),
	samples: samples(5, 1024),
	...overrides,
});

const readU32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer).getUint32(offset);
const indexOfBox = (bytes: Uint8Array, type: string, from = 0) => {
	for (let i = from; i + 8 <= bytes.length; i++) {
		if (String.fromCharCode(...bytes.subarray(i + 4, i + 8)) === type) {
			return i;
		}
	}
	return -1;
};

describe('Box framing', () => {
	test('reads an mdat with a 64-bit largesize field', async () => {
		using input = open(buildMp4({ tracks: [videoTrack()], largeMdat: true }));
		const track = await firstVideoTrack(input);

		const packets = await collect(track, false);
		expect(packets.map(x => [...x.data])).toEqual(samples(6, 1).map(x => x.data));
	});

	test('reads a moov placed after the mdat', async () => {
		using input = open(buildMp4({ tracks: [videoTrack(), audioTrack()], mdatFirst: true }));

		const packets = await collect(await firstAudioTrack(input), false);
		expect(packets.map(x => [...x.data])).toEqual(samples(5, 1024).map(x => x.data));
		expect(await input.computeDuration()).toBeCloseTo(0.2, 10);
	});

	test('reads a final mdat whose size is 0, meaning it extends to the end of the file', async () => {
		const bytes = buildMp4({ tracks: [videoTrack()] });
		const mdatPos = indexOfBox(bytes, 'mdat');
		new DataView(bytes.buffer).setUint32(mdatPos, 0);

		using input = open(bytes);
		const packets = await collect(await firstVideoTrack(input), false);
		expect(packets.map(x => [...x.data])).toEqual(samples(6, 1).map(x => x.data));
	});

	test('reads a moov with a 64-bit largesize field', async () => {
		const plain = buildMp4({ tracks: [videoTrack()] });
		const moovPos = indexOfBox(plain, 'moov');
		const moovSize = readU32(plain, moovPos);
		const moovContents = [...plain.subarray(moovPos + 8, moovPos + moovSize)];
		// The moov grows by 8 bytes, so shift the chunk offsets accordingly
		const stcoPos = indexOfBox(plain, 'stco') - moovPos - 8;
		const view = new DataView(new Uint8Array(moovContents).buffer);
		const entryCount = view.getUint32(stcoPos + 12);
		for (let i = 0; i < entryCount; i++) {
			view.setUint32(stcoPos + 16 + 4 * i, view.getUint32(stcoPos + 16 + 4 * i) + 8);
		}
		const patched = [...new Uint8Array(view.buffer)];

		const bytes = new Uint8Array([
			...plain.subarray(0, moovPos),
			...largeBox('moov', patched),
			...plain.subarray(moovPos + moovSize),
		]);

		using input = open(bytes);
		const packets = await collect(await firstVideoTrack(input), false);
		expect(packets.map(x => [...x.data])).toEqual(samples(6, 1).map(x => x.data));
	});

	test('skips free, skip, wide, uuid and unknown boxes anywhere', async () => {
		const unknownBoxes = [
			box('free', zeros(3)),
			box('skip'),
			box('wide'),
			box('uuid', zeros(16), [1, 2, 3]),
			box('abcd', [9, 9]),
		];
		const track = videoTrack({
			trakChildren: unknownBoxes,
			minfChildren: unknownBoxes,
			stbl: (_, defaults) => [
				...unknownBoxes,
				defaults.stts,
				defaults.stsz,
				...unknownBoxes,
				defaults.stsc,
				defaults.stco,
			],
		});

		using input = open(buildMp4({
			tracks: [track],
			leadingBoxes: unknownBoxes,
			moovChildren: unknownBoxes,
			trailingBoxes: unknownBoxes,
		}));

		expect(await input.getFormat()).toBe(MP4);
		const packets = await collect(await firstVideoTrack(input), false);
		expect(packets.map(x => [...x.data])).toEqual(samples(6, 1).map(x => x.data));
	});

	test('ignores trailing bytes that do not form a box', async () => {
		const bytes = buildMp4({ tracks: [videoTrack()], trailingBoxes: [[0, 0, 0, 3, 0x61]] });

		using input = open(bytes);
		expect(await describePackets(await firstVideoTrack(input))).toHaveLength(6);
	});

	test('stops at samples whose data lies past the end of a truncated file', async () => {
		const bytes = buildMp4({ tracks: [videoTrack()] });
		const truncated = bytes.subarray(0, bytes.length - 12); // Cuts into the last sample (15 bytes)

		using input = open(truncated);
		const track = await firstVideoTrack(input);
		expect(await collect(track)).toHaveLength(6); // The sample table is complete
		expect(await collect(track, false)).toHaveLength(5);
	});

	test('detects MP4 and QuickTime by the major brand', async () => {
		const detect = async (major: string) => {
			using input = open(buildMp4({ tracks: [videoTrack()], ftyp: ftyp(major, [major]) }));
			return await input.getFormat();
		};

		expect(await detect('isom')).toBe(MP4);
		expect(await detect('mp42')).toBe(MP4);
		expect(await detect('M4A ')).toBe(MP4);
		expect(await detect('3gp6')).toBe(MP4);
		expect(await detect('qt  ')).toBe(QTFF);
	});

	test('reports a QuickTime MIME type with codecs for qt files', async () => {
		using input = open(buildMp4({ tracks: [videoTrack(), audioTrack()], ftyp: ftyp('qt  ', ['qt  ']) }));
		expect(await input.getMimeType()).toBe('video/quicktime; codecs="avc1.64001f, mp4a.40.2"');
	});
});

describe('Movie and track headers', () => {
	test('reads the creation time from a version 0 and a version 1 mvhd', async () => {
		const creationTime = Date.UTC(2024, 1, 29, 12, 30, 15) / 1000 + 2082844800; // Seconds since 1904

		for (const version of [0, 1]) {
			await withInput(buildMp4({ tracks: [videoTrack()], mvhd: { version, creationTime } }), async (input) => {
				const tags = await input.getMetadataTags();
				expect(tags.creationTime).toEqual(new Date(Date.UTC(2024, 1, 29, 12, 30, 15)));
			});
		}

		using input = open(buildMp4({ tracks: [videoTrack()], mvhd: { creationTime: 0 } }));
		expect((await input.getMetadataTags()).creationTime).toBeUndefined();
	});

	test('reads version 1 tkhd and mdhd boxes', async () => {
		using input = open(buildMp4({
			tracks: [videoTrack({
				trackId: 7,
				tkhd: { version: 1, duration: 200 },
				mdhd: { version: 1, duration: 6 },
			})],
			mvhd: { version: 1 },
		}));

		const track = await firstVideoTrack(input);
		expect(await track.getTimeResolution()).toBe(30);
		expect(await track.getDurationFromMetadata()).toBeCloseTo(0.2, 10);
		expect(await describePackets(track)).toHaveLength(6);
	});

	test('maps timestamps exactly for unusual timescales', async () => {
		for (const timescale of [1, 600, 90000, 2 ** 31 - 1]) {
			await withInput(buildMp4({
				tracks: [videoTrack({ timescale, samples: samples(4, Math.max(1, Math.floor(timescale / 10))) })],
			}), async (input) => {
				const track = await firstVideoTrack(input);
				const duration = Math.max(1, Math.floor(timescale / 10));

				expect(await track.getTimeResolution()).toBe(timescale);
				const timestamps = (await collect(track)).map(x => x.timestamp);
				expect(timestamps).toEqual([0, 1, 2, 3].map(i => i * duration / timescale));
			});
		}
	});

	test('takes the default disposition from the tkhd enabled flag', async () => {
		using input = open(buildMp4({
			tracks: [
				videoTrack({ trackId: 1, tkhd: { flags: 0x3 } }),
				audioTrack({ trackId: 2, tkhd: { flags: 0x2 } }), // In movie, but not enabled
			],
		}));

		const [video, audio] = await input.getTracks();
		expect((await video!.getDisposition()).default).toBe(true);
		expect((await audio!.getDisposition()).default).toBe(false);
	});

	test('derives rotation and flipping from the tkhd matrix', async () => {
		const cases: [Matrix, number, boolean][] = [
			[[1, 0, 0, 0, 1, 0, 0, 0, 1], 0, false],
			[[0, 1, 0, -1, 0, 0, 240, 0, 1], 90, false],
			[[-1, 0, 0, 0, -1, 0, 320, 240, 1], 180, false],
			[[0, -1, 0, 1, 0, 0, 0, 320, 1], 270, false],
			[[-1, 0, 0, 0, 1, 0, 320, 0, 1], 0, true],
		];

		for (const [matrix, rotation, flip] of cases) {
			await withInput(buildMp4({ tracks: [videoTrack({ tkhd: { matrix } })] }), async (input) => {
				const track = await firstVideoTrack(input);

				expect(await track.getRotation()).toBe(rotation);
				expect(await track.getFlip()).toBe(flip);
				expect(await track.getTransformationMatrix()).toEqual(matrix);
			});
		}
	});

	test('multiplies the track matrix with the movie matrix', async () => {
		using input = open(buildMp4({
			tracks: [videoTrack({ tkhd: { matrix: [0, 1, 0, -1, 0, 0, 0, 0, 1] } })],
			mvhd: { matrix: [0, 1, 0, -1, 0, 0, 0, 0, 1] },
		}));

		expect(await (await firstVideoTrack(input)).getRotation()).toBe(180);
	});

	test('reads packed ISO 639-2/T language codes from mdhd', async () => {
		const read = async (language: string | number) => {
			using input = open(buildMp4({ tracks: [videoTrack({ mdhd: { language } })] }));
			return (await firstVideoTrack(input)).getLanguageCode();
		};

		expect(await read('fra')).toBe('fra');
		expect(await read('jpn')).toBe('jpn');
		expect(await read('und')).toBe('und');
		expect(await read(0)).toBe('und');
		expect(await read(packLanguage('zz{'))).toBe('und'); // Not letters
	});

	test('computes the duration from metadata as the first timestamp plus the mdhd duration', async () => {
		using input = open(buildMp4({
			tracks: [videoTrack({
				samples: samples(6, 1),
				edits: elst([[0, 2, 1]]), // Starts 2 frames into the media
				mdhd: { duration: 6 },
			})],
		}));
		const track = await firstVideoTrack(input);

		expect(await track.getFirstTimestamp()).toBeCloseTo(-2 / 30, 10);
		expect(await track.getDurationFromMetadata()).toBeCloseTo(4 / 30, 10);
		expect(await track.computeDuration()).toBeCloseTo(4 / 30, 10);
	});
});

describe('Handlers', () => {
	test('only turns video and sound handlers into tracks', async () => {
		const otherTrack = (handlerType: string, trackId: number): TableTrack => ({
			handlerType,
			trackId,
			timescale: 1000,
			sampleEntry: box('tx3g', zeros(38)),
			samples: samples(2, 500),
		});

		using input = open(buildMp4({
			tracks: [
				otherTrack('text', 1),
				videoTrack({ trackId: 2 }),
				otherTrack('sbtl', 3),
				otherTrack('subt', 4),
				otherTrack('tmcd', 5),
				otherTrack('meta', 6),
				otherTrack('hint', 7),
				audioTrack({ trackId: 8 }),
			],
		}));

		const tracks = await input.getTracks();
		expect(tracks.map(x => x.type)).toEqual(['video', 'audio']);
		expect(await (await input.getPrimaryVideoTrack())!.getCodec()).toBe('avc');
	});

	test('ignores the QuickTime data handler in minf', async () => {
		using input = open(buildMp4({
			tracks: [videoTrack({ minfChildren: [hdlr('alis')] }), audioTrack({ minfChildren: [hdlr('url ')] })],
			ftyp: ftyp('qt  ', ['qt  ']),
		}));

		expect((await input.getTracks()).map(x => x.type)).toEqual(['video', 'audio']);
	});

	test('keeps tracks with an unsupported codec, with a null codec', async () => {
		using input = open(buildMp4({
			tracks: [
				videoTrack({ sampleEntry: visualSampleEntry('mp4v', { width: 176, height: 144 }) }),
				audioTrack({ sampleEntry: audioSampleEntry('samr', { channels: 1, sampleRate: 8000 }) }),
			],
		}));

		const video = await firstVideoTrack(input);
		const audio = await firstAudioTrack(input);
		expect(await video.getCodec()).toBeNull();
		expect(await video.getInternalCodecId()).toBe('mp4v');
		expect(await video.getCodedWidth()).toBe(176);
		expect(await video.getDecoderConfig()).toBeNull();
		expect(await audio.getCodec()).toBeNull();
		expect(await audio.getInternalCodecId()).toBe('samr');
		expect(await audio.getSampleRate()).toBe(8000);
	});
});

describe('Video sample entries', () => {
	const read = async (sampleEntry: Bytes) => {
		using input = open(buildMp4({ tracks: [videoTrack({ sampleEntry })] }));
		const track = await firstVideoTrack(input);
		return {
			codec: await track.getCodec(),
			internalCodecId: await track.getInternalCodecId(),
			decoderConfig: await track.getDecoderConfig(),
			width: await track.getCodedWidth(),
			height: await track.getCodedHeight(),
			displayWidth: await track.getDisplayWidth(),
			displayHeight: await track.getDisplayHeight(),
		};
	};

	test('reads avc1 and avc3 entries with their avcC as the description', async () => {
		const avc1Info = await read(visualSampleEntry('avc1', { width: 320, height: 240, children: [avcC] }));
		expect(avc1Info.codec).toBe('avc');
		expect(avc1Info.decoderConfig).toMatchObject({ codec: 'avc1.64001f', codedWidth: 320, codedHeight: 240 });
		expect([...(avc1Info.decoderConfig!.description as Uint8Array)]).toEqual(avcC.slice(8));

		const avc3Info = await read(visualSampleEntry('avc3', { children: [avcC] }));
		expect(avc3Info.decoderConfig!.codec).toBe('avc3.64001f');
	});

	test('reads hev1 entries with their hvcC as the description', async () => {
		const hvcC = box('hvcC', [
			1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93, 0xf0, 0x00, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0,
		]);
		const info = await read(visualSampleEntry('hev1', { width: 1280, height: 720, children: [hvcC] }));

		expect(info.codec).toBe('hevc');
		expect(info.decoderConfig!.codec).toBe('hev1.1.6.L93.90');
		expect([...(info.decoderConfig!.description as Uint8Array)]).toEqual(hvcC.slice(8));
	});

	test('reads vp09 entries with vpcC', async () => {
		const vpcC = fullBox('vpcC', 1, 0, [0, 31, (10 << 4) | (1 << 1) | 1, 9, 16, 9], u16(0));
		const info = await read(visualSampleEntry('vp09', { children: [vpcC] }));

		expect(info.codec).toBe('vp9');
		expect(info.decoderConfig!.codec).toBe('vp09.00.31.10.01.09.16.09.01');
		expect(info.decoderConfig!.colorSpace).toEqual({
			primaries: 'bt2020',
			transfer: 'pq',
			matrix: 'bt2020-ncl',
			fullRange: true,
		});
	});

	test('reads av01 entries with av1C', async () => {
		// Main profile, level 8 (4.0), 10-bit 4:2:0, and a sequence header OBU without color description
		const av1C = box('av1C', [0x81, 0x08, 0x4c, 0x00]);
		const info = await read(visualSampleEntry('av01', { children: [av1C] }));

		expect(info.codec).toBe('av1');
		expect(info.decoderConfig!.codec).toMatch(/^av01\.0\.08M\.10/);
		expect(info.decoderConfig!.description).toBeUndefined();
	});

	test('reads ProRes entries', async () => {
		for (const fourCc of ['apco', 'apcs', 'apcn', 'apch', 'ap4h', 'ap4x']) {
			const info = await read(visualSampleEntry(fourCc, { width: 1920, height: 1080 }));
			expect(info.codec).toBe('prores');
			expect(info.internalCodecId).toBe(fourCc);
		}
	});

	test('reads nclx and nclc colr boxes', async () => {
		const nclx = box('colr', ascii('nclx'), u16(1), u16(1), u16(1), [0x80]);
		const nclxInfo = await read(visualSampleEntry('avc1', { children: [avcC, nclx] }));
		expect(nclxInfo.decoderConfig!.colorSpace).toEqual({
			primaries: 'bt709',
			transfer: 'bt709',
			matrix: 'bt709',
			fullRange: true,
		});

		const nclc = box('colr', ascii('nclc'), u16(9), u16(18), u16(9));
		const nclcInfo = await read(visualSampleEntry('avc1', { children: [avcC, nclc] }));
		expect(nclcInfo.decoderConfig!.colorSpace).toMatchObject({
			primaries: 'bt2020',
			transfer: 'hlg',
			matrix: 'bt2020-ncl',
		});

		// An ICC profile carries no code points, so it's skipped
		const prof = box('colr', ascii('prof'), zeros(16));
		const profInfo = await read(visualSampleEntry('avc1', { children: [avcC, prof] }));
		expect(profInfo.decoderConfig!.colorSpace?.primaries).toBeUndefined();
	});

	test('applies the pixel aspect ratio from pasp', async () => {
		const wide = await read(visualSampleEntry('avc1', {
			width: 720,
			height: 576,
			children: [avcC, box('pasp', u32(64), u32(45))],
		}));
		expect([wide.width, wide.height, wide.displayWidth, wide.displayHeight]).toEqual([720, 576, 1024, 576]);
		expect(wide.decoderConfig).toMatchObject({ displayAspectWidth: 1024, displayAspectHeight: 576 });

		const tall = await read(visualSampleEntry('avc1', {
			width: 720,
			height: 480,
			children: [avcC, box('pasp', u32(1), u32(2))],
		}));
		expect([tall.displayWidth, tall.displayHeight]).toEqual([720, 960]);

		// A zero ratio is invalid and ignored
		const invalid = await read(visualSampleEntry('avc1', {
			width: 720,
			height: 480,
			children: [avcC, box('pasp', u32(0), u32(1))],
		}));
		expect([invalid.displayWidth, invalid.displayHeight]).toEqual([720, 480]);
		expect(invalid.decoderConfig!.displayAspectWidth).toBeUndefined();
	});

	test('reads bitrates from btrt', async () => {
		using input = open(buildMp4({
			tracks: [videoTrack({
				sampleEntry: avc1({ children: [box('btrt', u32(0), u32(5_000_000), u32(3_000_000))] }),
			})],
		}));
		const track = await firstVideoTrack(input);

		expect(await track.getBitrate()).toBe(5_000_000);
		expect(await track.getAverageBitrate()).toBe(3_000_000);
	});
});

describe('Audio sample entries', () => {
	const read = async (sampleEntry: Bytes, timescale = 44100) => {
		using input = open(buildMp4({ tracks: [audioTrack({ sampleEntry, timescale })] }));
		const track = await firstAudioTrack(input);
		return {
			codec: await track.getCodec(),
			decoderConfig: await track.getDecoderConfig(),
			channels: await track.getNumberOfChannels(),
			sampleRate: await track.getSampleRate(),
		};
	};

	test('takes channels and sample rate from the AudioSpecificConfig over the sample entry', async () => {
		// The entry claims stereo 44100 Hz, the ASC says AAC-LC mono 48000 Hz
		const info = await read(mp4a({ channels: 2, sampleRate: 44100, decoderSpecificInfo: [0x11, 0x88] }));

		expect(info.codec).toBe('aac');
		expect(info.decoderConfig).toEqual({
			codec: 'mp4a.40.2',
			numberOfChannels: 1,
			sampleRate: 48000,
			description: new Uint8Array([0x11, 0x88]),
		});
	});

	test('reads esds descriptors with multi-byte sizes and optional ES_Descriptor fields', async () => {
		for (const lengthBytes of [1, 2, 3, 4]) {
			for (const esFlags of [0, 0x80, 0x40, 0x20, 0xe0]) {
				const info = await read(mp4a({ lengthBytes, esFlags }));
				expect(info.decoderConfig).toMatchObject({
					codec: 'mp4a.40.2',
					numberOfChannels: 2,
					sampleRate: 44100,
				});
			}
		}
	});

	test('maps esds object type indications to codecs', async () => {
		const codecOf = async (objectTypeIndication: number, decoderSpecificInfo: Bytes | null = null) => {
			return (await read(mp4a({ objectTypeIndication, decoderSpecificInfo }))).codec;
		};

		expect(await codecOf(0x40, [0x12, 0x10])).toBe('aac'); // MPEG-4 audio
		expect(await codecOf(0x67, [0x12, 0x10])).toBe('aac'); // MPEG-2 AAC LC
		expect(await codecOf(0x69)).toBe('mp3'); // MPEG-2 audio
		expect(await codecOf(0x6b)).toBe('mp3'); // MPEG-1 audio
		expect(await codecOf(0xdd)).toBe('vorbis');
		expect(await codecOf(0xa9)).toBe('dts');
		expect(await codecOf(0x20)).toBeNull(); // MPEG-4 visual is no audio codec
	});

	test('converts dOps into an OpusHead description', async () => {
		const dOps = box('dOps', [0, 2], u16(312), u32(44100), i16(-256), [0]);
		const info = await read(audioSampleEntry('Opus', { channels: 2, sampleRate: 48000, children: [dOps] }), 48000);

		expect(info.codec).toBe('opus');
		expect([info.channels, info.sampleRate]).toEqual([2, 48000]);
		expect([...(info.decoderConfig!.description as Uint8Array)]).toEqual([
			...ascii('OpusHead'), 1, 2, 0x38, 0x01, 0x44, 0xac, 0, 0, 0x00, 0xff, 0,
		]);
	});

	test('keeps the channel mapping table of dOps with mapping family 1', async () => {
		const dOps = box('dOps', [0, 6], u16(312), u32(48000), i16(0), [1, 4, 2, 0, 4, 1, 2, 3, 5]);
		const info = await read(audioSampleEntry('Opus', { channels: 6, sampleRate: 48000, children: [dOps] }), 48000);

		expect(info.channels).toBe(6);
		expect([...(info.decoderConfig!.description as Uint8Array)].slice(18)).toEqual([1, 4, 2, 0, 4, 1, 2, 3, 5]);
	});

	test('builds a FLAC description from dfLa metadata blocks', async () => {
		// STREAMINFO: block size 4096, 96000 Hz, 6 channels, 24 bits
		const streamInfo = [
			...u16(4096), ...u16(4096), ...u24(0), ...u24(0),
			...u32((96000 << 12) | (5 << 9) | (23 << 4)), ...zeros(4), ...zeros(16),
		];
		const dfLa = fullBox('dfLa', 0, 0, [0x00, ...u24(34), ...streamInfo], [0x84, ...u24(8), ...zeros(8)]);
		const info = await read(audioSampleEntry('fLaC', { channels: 2, sampleRate: 48000, children: [dfLa] }), 96000);

		expect(info.codec).toBe('flac');
		expect([info.channels, info.sampleRate]).toEqual([6, 96000]);
		expect([...(info.decoderConfig!.description as Uint8Array)]).toEqual([
			...ascii('fLaC'), 0x00, ...u24(34), ...streamInfo, 0x84, ...u24(8), ...zeros(8),
		]);
	});

	test('reads AC-3 and E-AC-3 configs from dac3 and dec3', async () => {
		// fscod 1 (44100 Hz), acmod 7 (3/2), LFE on
		const dac3 = box('dac3', [(1 << 6) | (8 << 1), (7 << 3) | (1 << 2), 0x00]);
		const ac3 = await read(audioSampleEntry('ac-3', { channels: 2, sampleRate: 48000, children: [dac3] }));
		expect([ac3.codec, ac3.channels, ac3.sampleRate]).toEqual(['ac3', 6, 44100]);

		// One independent substream: fscod 0 (48000 Hz), acmod 2 (stereo), no LFE
		const dec3 = box('dec3', u16(192 << 3), [0x00, (16 << 1), 2 << 1, 0x00]);
		const eac3 = await read(audioSampleEntry('ec-3', { channels: 6, sampleRate: 44100, children: [dec3] }));
		expect([eac3.codec, eac3.channels, eac3.sampleRate]).toEqual(['eac3', 2, 48000]);
	});

	test('maps QuickTime PCM entries, honoring enda in a wave atom', async () => {
		const pcm = async (type: string, sampleSize: number, littleEndian?: boolean) => {
			const children = littleEndian === undefined
				? []
				: [box('wave', box('frma', ascii(type)), box('enda', u16(littleEndian ? 1 : 0)), u32(8), u32(0))];
			return (await read(audioSampleEntry(type, { sampleSize, children }))).codec;
		};

		expect(await pcm('twos', 16)).toBe('pcm-s16be');
		expect(await pcm('twos', 8)).toBe('pcm-s8');
		expect(await pcm('sowt', 16)).toBe('pcm-s16');
		expect(await pcm('sowt', 8)).toBe('pcm-s8');
		expect(await pcm('raw ', 8)).toBe('pcm-u8');
		expect(await pcm('in24', 24)).toBe('pcm-s24be');
		expect(await pcm('in24', 24, true)).toBe('pcm-s24');
		expect(await pcm('in32', 32, false)).toBe('pcm-s32be');
		expect(await pcm('in32', 32, true)).toBe('pcm-s32');
		expect(await pcm('fl32', 32)).toBe('pcm-f32be');
		expect(await pcm('fl32', 32, true)).toBe('pcm-f32');
		expect(await pcm('fl64', 64)).toBe('pcm-f64be');
		expect(await pcm('fl64', 64, true)).toBe('pcm-f64');
		expect(await pcm('ulaw', 16)).toBe('ulaw');
		expect(await pcm('alaw', 16)).toBe('alaw');
	});

	test('maps ISO/IEC 23003-5 ipcm and fpcm entries by their pcmC box', async () => {
		const pcm = async (type: string, littleEndian: boolean, sampleSize: number) => {
			const pcmC = fullBox('pcmC', 0, 0, [littleEndian ? 1 : 0, sampleSize]);
			return (await read(audioSampleEntry(type, { sampleSize, children: [pcmC] }))).codec;
		};

		expect(await pcm('ipcm', false, 16)).toBe('pcm-s16be');
		expect(await pcm('ipcm', true, 16)).toBe('pcm-s16');
		expect(await pcm('ipcm', false, 24)).toBe('pcm-s24be');
		expect(await pcm('ipcm', true, 24)).toBe('pcm-s24');
		expect(await pcm('ipcm', true, 32)).toBe('pcm-s32');
		expect(await pcm('fpcm', false, 32)).toBe('pcm-f32be');
		expect(await pcm('fpcm', true, 64)).toBe('pcm-f64');
	});

	test('reads QuickTime sound descriptions version 1 and 2', async () => {
		// Version 1: 24-bit samples are only told by the bytes per packet
		const v1 = await read(audioSampleEntry('in24', {
			version: 1,
			sampleSize: 16,
			channels: 2,
			sampleRate: 48000,
			versionFields: soundV1Fields(1, 3, 6),
		}), 48000);
		expect([v1.codec, v1.channels, v1.sampleRate]).toEqual(['pcm-s24be', 2, 48000]);

		// Version 2 'lpcm': the format comes from the flags (1 float, 2 big-endian, 4 signed integer)
		const lpcm = async (bitsPerChannel: number, formatFlags: number) => read(audioSampleEntry('lpcm', {
			version: 2,
			channels: 3,
			sampleSize: 16,
			sampleRate: 1,
			versionFields: soundV2Fields({
				sampleRate: 96000,
				channels: 6,
				bitsPerChannel,
				formatFlags,
				bytesPerPacket: 6 * Math.ceil(bitsPerChannel / 8),
			}),
		}), 96000);

		expect(await lpcm(16, 4 | 2)).toMatchObject({ codec: 'pcm-s16be', channels: 6, sampleRate: 96000 });
		expect((await lpcm(16, 4)).codec).toBe('pcm-s16');
		expect((await lpcm(24, 4)).codec).toBe('pcm-s24');
		expect((await lpcm(32, 4 | 2)).codec).toBe('pcm-s32be');
		expect((await lpcm(32, 1)).codec).toBe('pcm-f32');
		expect((await lpcm(32, 1 | 2)).codec).toBe('pcm-f32be');
		expect((await lpcm(8, 0)).codec).toBe('pcm-u8');
		expect((await lpcm(16, 0)).codec).toBeNull(); // Unsigned 16-bit has no codec
	});
});

describe('Sample tables', () => {
	test('reads timestamps from several stts entries', async () => {
		const track = videoTrack({
			timescale: 1000,
			samples: [...samples(3, 40), ...samples(2, 20), ...samples(1, 100)],
		});

		using input = open(buildMp4({ tracks: [track] }));
		expect((await describePackets(await firstVideoTrack(input))).map(x => [x[0], x[1]])).toEqual([
			[0, 0.04], [0.04, 0.04], [0.08, 0.04], [0.12, 0.02], [0.14, 0.02], [0.16, 0.1],
		]);
	});

	test('applies ctts offsets, version 0 and version 1 with negative offsets', async () => {
		// Decode order I P B B: presented as I B B P
		const expected = [[0, 1, 'K'], [3, 1, 'D'], [1, 1, 'D'], [2, 1, 'D']];

		for (const [version, offsets] of [[0, [1, 3, 0, 0]], [1, [0, 2, -1, -1]]] as const) {
			await withInput(buildMp4({
				tracks: [videoTrack({
					timescale: 1,
					samples: samples(4, 1, { compositionOffsets: [...offsets], keyFrames: i => i === 0 }),
					cttsVersion: version,
					edits: version === 0 ? elst([[4000, 1, 1]]) : undefined,
				})],
			}), async (input) => {
				expect((await describePackets(await firstVideoTrack(input))).map(x => x.slice(0, 3))).toEqual(expected);
			});
		}
	});

	test('treats every sample as a key frame without stss, and only the listed ones with it', async () => {
		using withoutStss = open(buildMp4({ tracks: [videoTrack({ samples: samples(4, 1) })] }));
		const types = (await describePackets(await firstVideoTrack(withoutStss))).map(x => x[2]);
		expect(types).toEqual(['K', 'K', 'K', 'K']);

		using withStss = open(buildMp4({
			tracks: [videoTrack({ samples: samples(6, 1, { keyFrames: i => i % 3 === 0 }) })],
		}));
		expect((await describePackets(await firstVideoTrack(withStss))).map(x => x[2])).toEqual([
			'K', 'D', 'D', 'K', 'D', 'D',
		]);
	});

	test('reads a constant stsz sample size', async () => {
		const track = videoTrack({
			samples: samples(5, 1, { size: () => 12 }),
			stbl: (_, defaults) => [defaults.stts, stsz({ constantSize: 12, count: 5 }), defaults.stsc, defaults.stco],
		});

		using input = open(buildMp4({ tracks: [track] }));
		const packets = await collect(await firstVideoTrack(input), false);
		expect(packets.map(x => [...x.data])).toEqual(samples(5, 1, { size: () => 12 }).map(x => x.data));
	});

	test('reads compact sample sizes from stz2 with 4, 8 and 16-bit fields', async () => {
		for (const fieldSize of [4, 8, 16] as const) {
			const sizes = {
				4: [3, 15, 1, 7, 9],
				8: [200, 1, 255, 17, 64],
				16: [300, 1000, 2, 65535, 9],
			}[fieldSize];
			const track = videoTrack({
				samples: samples(sizes.length, 1, { size: i => sizes[i]! }),
				stbl: (_, defaults) => [defaults.stts, stz2(fieldSize, sizes), defaults.stsc, defaults.stco],
			});

			await withInput(buildMp4({ tracks: [track] }), async (input) => {
				const packets = await collect(await firstVideoTrack(input), false);
				expect(packets.map(x => x.byteLength)).toEqual(sizes);
				const expected = samples(sizes.length, 1, { size: i => sizes[i]! });
				expect(packets.map(x => [...x.data])).toEqual(expected.map(x => x.data));
			});
		}
	});

	test('reads 64-bit chunk offsets from co64', async () => {
		const track = videoTrack({
			stbl: (chunkOffsets, defaults) => [defaults.stts, defaults.stsz, defaults.stsc, co64(chunkOffsets)],
		});

		using input = open(buildMp4({ tracks: [track] }));
		const packets = await collect(await firstVideoTrack(input), false);
		expect(packets.map(x => [...x.data])).toEqual(samples(6, 1).map(x => x.data));
	});

	test('maps samples to chunks through stsc runs with changing samples per chunk', async () => {
		// Chunks of 3, 3, 1, 2 samples: stsc entries (1, 3), (3, 1), (4, 2)
		const layout = [3, 3, 1, 2];
		const allSamples = samples(9, 1);
		const chunks: Bytes[] = [];
		let sampleIndex = 0;
		for (const count of layout) {
			chunks.push(allSamples.slice(sampleIndex, sampleIndex + count).flatMap(x => x.data));
			sampleIndex += count;
		}
		// Put a gap between chunks so wrong chunk mapping would read wrong bytes
		const headerSize = ftyp().length;
		const gap = [0xee, 0xee];
		const moovFor = (chunkOffsets: number[]) => box('moov',
			mvhd(),
			box('trak',
				tkhd(),
				box('mdia',
					mdhd({ timescale: 30, duration: 9 }),
					hdlr('vide'),
					box('minf', box('stbl',
						stsd(avc1()),
						stts([[9, 1]]),
						stsz(allSamples.map(x => x.data.length)),
						stsc([[1, 3, 1], [3, 1, 1], [4, 2, 1]]),
						stco(chunkOffsets),
					)),
				),
			),
		);
		const moovSize = moovFor([0, 0, 0, 0]).length;
		const offsets: number[] = [];
		let position = headerSize + moovSize + 8;
		for (const chunk of chunks) {
			position += gap.length;
			offsets.push(position);
			position += chunk.length;
		}

		using input = open(new Uint8Array([
			...ftyp(),
			...moovFor(offsets),
			...box('mdat', chunks.flatMap(chunk => [...gap, ...chunk])),
		]));
		const packets = await collect(await firstVideoTrack(input), false);
		expect(packets.map(x => [...x.data])).toEqual(allSamples.map(x => x.data));
	});

	test('clamps the sample count to what stts, stsz and stsc all describe', async () => {
		const track = videoTrack({
			samples: samples(6, 1),
			// Only 4 timed samples
			stbl: (_, defaults) => [stts([[4, 1]]), defaults.stsz, defaults.stsc, defaults.stco],
		});

		using input = open(buildMp4({ tracks: [track] }));
		expect(await describePackets(await firstVideoTrack(input))).toHaveLength(4);
	});

	test('merges PCM samples into one packet per chunk', async () => {
		// 16-bit stereo: one sample per PCM frame, 4 bytes each, chunks of 3 frames
		const frames = Array.from({ length: 7 }, (_, i): TableSample => ({ data: [i, i, i, i], duration: 1 }));
		const track: TableTrack = {
			handlerType: 'soun',
			timescale: 8000,
			sampleEntry: audioSampleEntry('sowt', { channels: 2, sampleSize: 16, sampleRate: 8000 }),
			samples: frames,
			chunkSize: 3,
			stbl: (_, defaults) => [defaults.stts, stsz({ constantSize: 4, count: 7 }), defaults.stsc, defaults.stco],
		};

		using input = open(buildMp4({ tracks: [track] }));
		const audio = await firstAudioTrack(input);
		const packets = await collect(audio, false);

		expect(await audio.getCodec()).toBe('pcm-s16');
		expect(packets.map(x => [x.timestamp, x.duration, x.byteLength])).toEqual([
			[0, 3 / 8000, 12], [3 / 8000, 3 / 8000, 12], [6 / 8000, 1 / 8000, 4],
		]);
		expect(packets.flatMap(x => [...x.data])).toEqual(frames.flatMap(x => x.data));
	});

	test('finds packets and key packets by presentation timestamp with reordered frames', async () => {
		// GOPs of I P B B, presented I B B P
		const offsets = [1, 3, 0, 0, 1, 3, 0, 0, 1, 3, 0, 0];
		using input = open(buildMp4({
			tracks: [videoTrack({
				timescale: 10,
				samples: samples(12, 1, { compositionOffsets: offsets, keyFrames: i => i % 4 === 0 }),
				edits: elst([[1200, 1, 1]]),
			})],
		}));
		const track = await firstVideoTrack(input);
		const sink = new EncodedPacketSink(track);
		const all = await collect(track);

		for (let t = -0.05; t < 1.3; t += 0.025) {
			const candidates = all.filter(x => x.timestamp <= t + 1e-9);
			const latest = (a: EncodedPacket | null, b: EncodedPacket) => (!a || b.timestamp > a.timestamp ? b : a);
			const best = candidates.reduce<EncodedPacket | null>(latest, null);
			const bestKey = candidates.filter(x => x.type === 'key').reduce<EncodedPacket | null>(latest, null);

			expect((await sink.getPacket(t, { metadataOnly: true }))?.timestamp).toBe(best?.timestamp);
			expect((await sink.getKeyPacket(t, { metadataOnly: true }))?.timestamp).toBe(bestKey?.timestamp);
		}

		expect((await sink.getPacket(Infinity))?.timestamp).toBeCloseTo(1.1, 10);
		expect(await track.computeDuration()).toBeCloseTo(1.2, 10);
	});

	test('iterates key packets with getNextKeyPacket', async () => {
		using input = open(buildMp4({
			tracks: [videoTrack({ samples: samples(10, 1, { keyFrames: i => i === 0 || i === 4 || i === 9 }) })],
		}));
		const sink = new EncodedPacketSink(await firstVideoTrack(input));

		const keyTimestamps: number[] = [];
		let packet = await sink.getFirstPacket({ metadataOnly: true });
		while (packet) {
			keyTimestamps.push(packet.timestamp);
			packet = await sink.getNextKeyPacket(packet, { metadataOnly: true });
		}
		expect(keyTimestamps).toEqual([0, 4 / 30, 9 / 30]);
	});
});

describe('Edit lists', () => {
	test('shifts timestamps by the media time of the edit', async () => {
		using input = open(buildMp4({
			tracks: [videoTrack({ timescale: 1000, samples: samples(4, 40), edits: elst([[160, 80, 1]]) })],
		}));
		expect((await collect(await firstVideoTrack(input))).map(x => x.timestamp)).toEqual([-0.08, -0.04, 0, 0.04]);
	});

	test('delays the track by a leading empty edit, converting from the movie timescale', async () => {
		// Movie timescale 600: an empty edit of 300 is 0.5 s, then the media starts at media time 0
		using input = open(buildMp4({
			movieTimescale: 600,
			tracks: [audioTrack({ samples: samples(3, 1024), edits: elst([[300, -1, 1], [100, 0, 1]]) })],
		}));
		expect((await collect(await firstAudioTrack(input))).map(x => x.timestamp)).toEqual([
			0.5, 0.5 + 1024 / 44100, 0.5 + 2048 / 44100,
		]);
	});

	test('combines an empty edit with a media time offset', async () => {
		using input = open(buildMp4({
			movieTimescale: 1000,
			tracks: [videoTrack({
				timescale: 1000,
				samples: samples(3, 100),
				edits: elst([[250, -1, 1], [300, 50, 1]]),
			})],
		}));
		expect((await collect(await firstVideoTrack(input))).map(x => x.timestamp)).toEqual([0.2, 0.3, 0.4]);
	});

	test('reads version 1 edit lists', async () => {
		using input = open(buildMp4({
			tracks: [videoTrack({
				timescale: 1000,
				samples: samples(3, 100),
				edits: elst([[500, -1, 1], [300, 100, 1]], 1),
			})],
		}));
		expect((await collect(await firstVideoTrack(input))).map(x => x.timestamp)).toEqual([0.4, 0.5, 0.6]);
	});

	test('starts AAC with encoder delay at a negative timestamp', async () => {
		using input = open(buildMp4({
			tracks: [audioTrack({ samples: samples(4, 1024), edits: elst([[3000, 2112, 1]]) })],
		}));
		const audio = await firstAudioTrack(input);

		expect(await audio.getFirstTimestamp()).toBeCloseTo(-2112 / 44100, 12);
		expect(await audio.computeDuration()).toBeCloseTo((4 * 1024 - 2112) / 44100, 12);
	});
});

describe('Fragmented files', () => {
	const fragSamples = (count: number, duration: number, firstSize = 8): FragmentSample[] => Array.from(
		{ length: count },
		(_, i) => ({
			data: Array.from({ length: firstSize + i }, (_, j) => (i * 13 + j) & 0xff),
			duration,
			flags: i === 0 ? SAMPLE_FLAGS_SYNC : SAMPLE_FLAGS_NON_SYNC,
		}),
	);
	const videoInit = (trex?: FragmentedTrack['trex']): FragmentedTrack => ({
		trackId: 1,
		timescale: 1000,
		sampleEntries: [avc1()],
		trex,
	});

	test('takes missing sample values from trex', async () => {
		const sampleData = Array.from({ length: 4 }, (_, i) => zeros(6).map(() => i));
		using input = open(buildFragmentedMp4({
			tracks: [videoInit({ duration: 40, size: 6, flags: SAMPLE_FLAGS_NON_SYNC })],
			fragments: [[{
				trackId: 1,
				baseMediaDecodeTime: 0,
				truns: [{
					samples: sampleData.map(data => ({ data })),
					fields: { duration: false, size: false, flags: false, compositionOffset: false },
					firstSampleFlags: SAMPLE_FLAGS_SYNC,
				}],
			}]],
		}));
		const track = await firstVideoTrack(input);

		expect(await describePackets(track)).toEqual([
			[0, 0.04, 'K', 6], [0.04, 0.04, 'D', 6], [0.08, 0.04, 'D', 6], [0.12, 0.04, 'D', 6],
		]);
		expect((await collect(track, false)).map(x => [...x.data])).toEqual(sampleData);
	});

	test('lets tfhd defaults override trex', async () => {
		using input = open(buildFragmentedMp4({
			tracks: [videoInit({ duration: 40, size: 6, flags: SAMPLE_FLAGS_SYNC })],
			fragments: [[{
				trackId: 1,
				baseMediaDecodeTime: 0,
				defaultSampleDuration: 20,
				defaultSampleSize: 3,
				defaultSampleFlags: SAMPLE_FLAGS_NON_SYNC,
				truns: [{
					samples: [{ data: [1, 1, 1] }, { data: [2, 2, 2] }],
					fields: { duration: false, size: false, flags: false, compositionOffset: false },
				}],
			}]],
		}));

		expect(await describePackets(await firstVideoTrack(input))).toEqual([[0, 0.02, 'D', 3], [0.02, 0.02, 'D', 3]]);
	});

	test('resolves sample data for every way of establishing the base data offset', async () => {
		for (const base of ['moof', 'explicit-moof', 'explicit-data', 'implicit'] as const) {
			const videoSamples = fragSamples(3, 40);
			const audioSamples = fragSamples(4, 1024, 3).map(x => ({ ...x, flags: SAMPLE_FLAGS_SYNC }));
			const writeDataOffset = base !== 'explicit-data'; // Otherwise the data starts right at the base
			await withInput(buildFragmentedMp4({
				tracks: [
					videoInit(),
					{ handlerType: 'soun', trackId: 2, timescale: 44100, sampleEntries: [mp4a()] },
				],
				fragments: [[
					{ trackId: 1, base, baseMediaDecodeTime: 0, truns: [{ samples: videoSamples, writeDataOffset }] },
					{ trackId: 2, base, baseMediaDecodeTime: 0, truns: [{ samples: audioSamples, writeDataOffset }] },
				]],
			}), async (input) => {
				const video = await collect(await firstVideoTrack(input), false);
				const audio = await collect(await firstAudioTrack(input), false);
				expect(video.map(x => [...x.data])).toEqual(videoSamples.map(x => x.data));
				expect(audio.map(x => [...x.data])).toEqual(audioSamples.map(x => x.data));
			});
		}
	});

	test('continues the data of a trun without data offset right after the previous one', async () => {
		const first = fragSamples(2, 40);
		const second = fragSamples(3, 40, 20);
		using input = open(buildFragmentedMp4({
			tracks: [videoInit()],
			fragments: [[{
				trackId: 1,
				baseMediaDecodeTime: 0,
				truns: [{ samples: first }, { samples: second, writeDataOffset: false }],
			}]],
		}));
		const track = await firstVideoTrack(input);

		expect((await collect(track, false)).map(x => [...x.data])).toEqual([...first, ...second].map(x => x.data));
		expect((await collect(track)).map(x => x.timestamp)).toEqual([0, 0.04, 0.08, 0.12, 0.16]);
	});

	test('reads tfdt version 0 and version 1, including 64-bit decode times', async () => {
		for (const [tfdtVersion, baseMediaDecodeTime] of [[0, 2 ** 32 - 1000], [1, 2 ** 40]] as const) {
			await withInput(buildFragmentedMp4({
				tracks: [videoInit()],
				fragments: [[{
					trackId: 1,
					tfdtVersion,
					baseMediaDecodeTime,
					truns: [{ samples: fragSamples(2, 40) }],
				}]],
			}), async (input) => {
				expect((await collect(await firstVideoTrack(input))).map(x => x.timestamp)).toEqual([
					baseMediaDecodeTime / 1000,
					(baseMediaDecodeTime + 40) / 1000,
				]);
			});
		}
	});

	test('chains fragments without tfdt one after another', async () => {
		using input = open(buildFragmentedMp4({
			tracks: [videoInit()],
			fragments: [0, 1, 2].map(() => [{
				trackId: 1,
				baseMediaDecodeTime: null,
				truns: [{ samples: fragSamples(2, 50) }],
			}]),
		}));

		const timestamps = (await collect(await firstVideoTrack(input))).map(x => x.timestamp);
		expect(timestamps).toEqual([0, 0.05, 0.1, 0.15, 0.2, 0.25]);
	});

	test('marks only the first sample as key with first-sample-flags', async () => {
		using input = open(buildFragmentedMp4({
			tracks: [videoInit()],
			fragments: [[{
				trackId: 1,
				baseMediaDecodeTime: 0,
				defaultSampleFlags: SAMPLE_FLAGS_NON_SYNC,
				truns: [{
					samples: fragSamples(3, 40),
					fields: { flags: false },
					firstSampleFlags: SAMPLE_FLAGS_SYNC,
				}],
			}]],
		}));

		expect((await describePackets(await firstVideoTrack(input))).map(x => x[2])).toEqual(['K', 'D', 'D']);
	});

	test('applies signed composition offsets of version 1 truns', async () => {
		const frames = fragSamples(4, 40).map((x, i) => ({ ...x, compositionOffset: [0, 80, -40, -40][i] }));
		using input = open(buildFragmentedMp4({
			tracks: [videoInit()],
			fragments: [[{ trackId: 1, baseMediaDecodeTime: 0, truns: [{ version: 1, samples: frames }] }]],
		}));

		expect((await describePackets(await firstVideoTrack(input))).map(x => [x[0], x[1]])).toEqual([
			[0, 0.04], [0.12, 0.04], [0.04, 0.04], [0.08, 0.04],
		]);
	});

	test('skips trafs without samples and trafs of unknown tracks', async () => {
		using input = open(buildFragmentedMp4({
			tracks: [videoInit()],
			fragments: [
				[{ trackId: 1, baseMediaDecodeTime: 0, durationIsEmpty: true, truns: [] }],
				[
					{ trackId: 9, baseMediaDecodeTime: 0, truns: [{ samples: fragSamples(2, 40) }] },
					{ trackId: 1, baseMediaDecodeTime: 0, truns: [{ samples: fragSamples(2, 40) }] },
				],
			],
		}));

		expect((await collect(await firstVideoTrack(input))).map(x => x.timestamp)).toEqual([0, 0.04]);
	});

	test('interleaves tracks across fragments and computes their durations', async () => {
		using input = open(buildFragmentedMp4({
			tracks: [videoInit(), { handlerType: 'soun', trackId: 2, timescale: 48000, sampleEntries: [mp4a()] }],
			fragments: [0, 1, 2].map(i => [
				{ trackId: 1, baseMediaDecodeTime: i * 200, truns: [{ samples: fragSamples(5, 40) }] },
				{
					trackId: 2,
					baseMediaDecodeTime: i * 9600,
					truns: [{ samples: fragSamples(10, 960).map(x => ({ ...x, flags: SAMPLE_FLAGS_SYNC })) }],
				},
			]),
		}));
		const video = await firstVideoTrack(input);
		const audio = await firstAudioTrack(input);

		expect(await collect(video)).toHaveLength(15);
		expect(await collect(audio)).toHaveLength(30);
		expect(await video.computeDuration()).toBeCloseTo(0.6, 10);
		expect(await audio.computeDuration()).toBeCloseTo(0.6, 10);
		expect(await video.getDurationFromMetadata()).toBeNull(); // The moov holds no duration
	});

	test('finds packets in fragments by timestamp, cold and warm', async () => {
		const build = (withMfra: boolean) => buildFragmentedMp4({
			tracks: [videoInit()],
			fragments: Array.from({ length: 8 }, (_, i) => [
				{ trackId: 1, baseMediaDecodeTime: i * 400, truns: [{ samples: fragSamples(10, 40) }] },
			]),
			trailingBoxes: withMfra
				? offsets => [mfra([{ trackId: 1, entries: offsets.map((offset, i) => [i * 400, offset, 1, 1]) }])]
				: undefined,
		});

		for (const withMfra of [false, true]) {
			await withInput(build(withMfra), async (input) => {
				const sink = new EncodedPacketSink(await firstVideoTrack(input));

				expect((await sink.getKeyPacket(2.5, { metadataOnly: true }))?.timestamp).toBe(2.4);
				expect((await sink.getPacket(2.5, { metadataOnly: true }))?.timestamp).toBeCloseTo(2.48, 10);
				expect((await sink.getPacket(0.03, { metadataOnly: true }))?.timestamp).toBe(0);
				expect((await sink.getKeyPacket(1.99, { metadataOnly: true }))?.timestamp).toBe(1.6);
				expect((await sink.getPacket(Infinity, { metadataOnly: true }))?.timestamp).toBeCloseTo(3.16, 10);
				expect(await sink.getPacket(-0.1, { metadataOnly: true })).toBeNull();
			});
		}
	});

	test('skips sidx, emsg, prft and free boxes between fragments', async () => {
		const init = buildInit({ tracks: [videoInit()] });
		const between = [
			fullBox('sidx', 1, 0, u32(1), u32(1000), u64(0), u64(0), u16(0), u16(1), u32(100), u32(400), u32(1 << 31)),
			fullBox('emsg', 0, 0, ascii('urn:test\0'), ascii('1\0'), u32(1000), u32(0), u32(0xffff), u32(1), [1, 2, 3]),
			fullBox('prft', 1, 0, u32(1), u64(0), u64(0)),
			box('free', zeros(5)),
		].flat();
		const bytes = [...init, ...between];
		for (let i = 0; i < 3; i++) {
			bytes.push(...buildFragment(i + 1, [
				{ trackId: 1, baseMediaDecodeTime: i * 120, truns: [{ samples: fragSamples(3, 40) }] },
			], bytes.length));
			bytes.push(...between);
		}

		using input = open(new Uint8Array(bytes));
		const track = await firstVideoTrack(input);
		const timestamps = (await collect(track, false)).map(x => x.timestamp);
		expect(timestamps).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => i * 0.04));
	});

	test('reads a media segment through its init segment', async () => {
		const tracks = [videoInit()];
		const init = new Uint8Array(buildInit({ tracks }));
		const styp = box('styp', ascii('msdh'), u32(0), ascii('msdh'), ascii('msix'));
		const segment = new Uint8Array([
			...styp,
			...buildFragment(
				5,
				[{ trackId: 1, baseMediaDecodeTime: 2000, truns: [{ samples: fragSamples(3, 40) }] }],
				styp.length,
			),
		]);

		using initInput = open(init);
		using input = new Input({ source: new BufferSource(segment), formats: ALL_FORMATS, initInput });

		expect((await collect(await firstVideoTrack(input))).map(x => x.timestamp)).toEqual([2, 2.04, 2.08]);
	});

	test('applies the edit list of the init segment to fragments', async () => {
		using input = open(buildFragmentedMp4({
			tracks: [{ ...videoInit(), edits: elst([[0, 80, 1]]) }],
			fragments: [[{ trackId: 1, baseMediaDecodeTime: 0, truns: [{ samples: fragSamples(3, 40) }] }]],
		}));

		expect((await collect(await firstVideoTrack(input))).map(x => x.timestamp)).toEqual([-0.08, -0.04, 0]);
	});
});

describe('Metadata', () => {
	const readTags = async (moovChildren: Bytes[]) => {
		using input = open(buildMp4({ tracks: [audioTrack({ trackId: 1 })], moovChildren }));
		return await input.getMetadataTags();
	};
	const utf16be = (text: string) => [...text].flatMap(char => u16(char.charCodeAt(0)));

	test('reads iTunes ilst text items in UTF-8 and UTF-16', async () => {
		const tags = await readTags([box('udta', ilstMeta([
			box('©nam', dataBox(1, utf8('Tïtle'))),
			box('©ART', dataBox(2, utf16be('Artïst'))),
			box('©alb', dataBox(1, utf8('Album'))),
			box('aART', dataBox(1, utf8('Album Artist'))),
			box('©cmt', dataBox(1, utf8('Comment'))),
			box('©gen', dataBox(1, utf8('Genre'))),
			box('©lyr', dataBox(1, utf8('Lyrics'))),
			box('desc', dataBox(1, utf8('Description'))),
			box('©day', dataBox(1, utf8('2019-08-30'))),
		]))]);

		expect(tags).toMatchObject({
			title: 'Tïtle',
			artist: 'Artïst',
			album: 'Album',
			albumArtist: 'Album Artist',
			comment: 'Comment',
			genre: 'Genre',
			lyrics: 'Lyrics',
			description: 'Description',
			date: new Date('2019-08-30'),
		});
		expect(tags.raw!['©nam']).toBe('Tïtle');
	});

	test('reads iTunes ilst numbers and cover art', async () => {
		const jpeg = [0xff, 0xd8, 0xff, 0xe0];
		const png = [0x89, 0x50, 0x4e, 0x47];
		const tags = await readTags([box('udta', ilstMeta([
			box('trkn', dataBox(0, [0, 0, 0, 5, 0, 12, 0, 0])),
			box('disk', dataBox(0, [0, 0, 0, 1, 0, 2])),
			box('tmpo', dataBox(21, u16(128))),
			box('covr', dataBox(13, jpeg)),
			box('covr', dataBox(14, png)),
			box('covr', dataBox(27, [0x42, 0x4d])),
			box('covr', dataBox(0, [1, 2, 3])),
		]))]);

		expect(tags).toMatchObject({
			trackNumber: 5,
			tracksTotal: 12,
			discNumber: 1,
			discsTotal: 2,
			beatsPerMinute: 128,
		});
		expect(tags.images?.map(x => [x.mimeType, x.kind, [...x.data]])).toEqual([
			['image/jpeg', 'coverFront', jpeg],
			['image/png', 'coverFront', png],
			['image/bmp', 'coverFront', [0x42, 0x4d]],
			['image/*', 'coverFront', [1, 2, 3]],
		]);
	});

	test('reads QuickTime metadata with mdta keys', async () => {
		const tags = await readTags([ilstMeta([
			box('\0\0\0\x01', dataBox(1, utf8('Movie title'))),
			box('\0\0\0\x02', dataBox(1, utf8('2023-05-14T10:21:33Z'))),
			box('\0\0\0\x03', dataBox(1, utf8('Apple'))),
			box('\0\0\0\x04', dataBox(1, utf8('Someone'))),
		], 'mdta', [
			'com.apple.quicktime.title',
			'com.apple.quicktime.creationdate',
			'com.apple.quicktime.make',
			'com.apple.quicktime.artist',
		])]);

		expect(tags).toMatchObject({
			title: 'Movie title',
			artist: 'Someone',
			date: new Date('2023-05-14T10:21:33Z'),
		});
		expect(tags.raw!['com.apple.quicktime.make']).toBe('Apple');
	});

	test('reads QuickTime user data text atoms at the movie level', async () => {
		const tags = await readTags([box('udta',
			udtaText('©nam', 'Name'),
			udtaText('©ART', 'Performer'),
			udtaText('©alb', 'Album'),
			udtaText('©cmt', 'Comment'),
			udtaText('©des', 'Description'),
			udtaText('©gen', 'Genre'),
			udtaText('©day', '2001'),
			udtaText('©swr', 'Some encoder'),
		)]);

		expect(tags).toMatchObject({
			title: 'Name',
			artist: 'Performer',
			album: 'Album',
			comment: 'Comment',
			description: 'Description',
			genre: 'Genre',
			date: new Date('2001'),
		});
		expect(tags.raw!['©swr']).toBe('Some encoder');
	});

	test('reads track names from the track user data name atom', async () => {
		using input = open(buildMp4({
			tracks: [videoTrack({ trakChildren: [box('udta', box('name', utf8('Main camera')))] })],
		}));
		expect(await (await firstVideoTrack(input)).getName()).toBe('Main camera');
	});

	test('does not let track user data leak into the movie metadata', async () => {
		using input = open(buildMp4({
			tracks: [videoTrack({ trakChildren: [box('udta', udtaText('©nam', 'Track title'), ilstMeta([
				box('©ART', dataBox(1, utf8('Track artist'))),
			]))] })],
		}));
		const tags = await input.getMetadataTags();
		expect(tags.title).toBeUndefined();
		expect(tags.artist).toBeUndefined();
	});
});

describe('Common Encryption', () => {
	const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
	const keyId = Array.from({ length: 16 }, (_, i) => 0x10 + i);
	const keyIdHex = Buffer.from(keyId).toString('hex');

	const encryptedEntry = (scheme: string, tenc: Bytes) => visualSampleEntry('encv', {
		children: [avcC, box('sinf',
			box('frma', ascii('avc1')),
			fullBox('schm', 0, 0, ascii(scheme), u32(0x10000)),
			box('schi', tenc),
		)],
	});
	const tencBox = (options: { version?: number; pattern?: number; ivSize: number; constantIv?: Buffer }) => fullBox(
		'tenc',
		options.version ?? 0,
		0,
		[0, options.pattern ?? 0, 1, options.ivSize],
		keyId,
		options.constantIv ? [16, ...options.constantIv] : [],
	);
	const sencBox = (entries: { iv: Bytes; subsamples?: [number, number][] }[]) => {
		const useSubsamples = entries.some(x => x.subsamples);
		const subsampleBytes = (subsamples: [number, number][]) => [
			...u16(subsamples.length),
			...subsamples.flatMap(([clear, protectedLength]) => [...u16(clear), ...u32(protectedLength)]),
		];

		return fullBox('senc', 0, useSubsamples ? 2 : 0, u32(entries.length), ...entries.map(entry => [
			...entry.iv,
			...(useSubsamples ? subsampleBytes(entry.subsamples!) : []),
		]));
	};

	// AES-CTR over the concatenated ranges, so the counter continues across them (cenc/cens)
	const encryptCtr = (data: Bytes, iv: Bytes, ranges: [number, number][]) => {
		const counter = Buffer.alloc(16);
		counter.set(iv);
		const cipher = createCipheriv('aes-128-ctr', key, counter);
		const out = [...data];
		for (const [start, length] of ranges) {
			out.splice(start, length, ...cipher.update(Buffer.from(data.slice(start, start + length))));
		}
		return out;
	};
	// AES-CBC with the chain restarting at each subsample's protected range (cbcs)
	const encryptCbc = (data: Bytes, iv: Buffer, rangesPerSubsample: [number, number][][]) => {
		const out = [...data];
		for (const ranges of rangesPerSubsample) {
			const cipher = createCipheriv('aes-128-cbc', key, iv).setAutoPadding(false);
			for (const [start, length] of ranges) {
				out.splice(start, length, ...cipher.update(Buffer.from(data.slice(start, start + length))));
			}
		}
		return out;
	};
	// The crypt blocks of a pattern over a protected range
	const patternBlocks = (start: number, length: number, crypt: number, skip: number) => {
		const blocks: [number, number][] = [];
		for (let pos = start; pos + 16 * crypt <= start + length; pos += 16 * (crypt + skip)) {
			blocks.push([pos, 16 * crypt]);
		}
		return blocks;
	};

	const plaintexts = [
		[...u32(201), 0x65, ...Array.from({ length: 200 }, (_, i) => i & 0xff)],
		[...u32(51), 0x41, ...Array.from({ length: 50 }, (_, i) => (i * 3) & 0xff)],
	];

	const buildEncrypted = (
		entry: Bytes,
		ciphertexts: Bytes[],
		senc: Bytes | null,
		extraTrafChildren: Bytes[] = [],
	) => {
		return buildFragmentedMp4({
			tracks: [{ trackId: 1, timescale: 1000, sampleEntries: [entry] }],
			fragments: [[{
				trackId: 1,
				baseMediaDecodeTime: 0,
				truns: [{ samples: ciphertexts.map(data => ({ data, duration: 40 })) }],
				extraChildren: [...(senc ? [senc] : []), ...extraTrafChildren],
			}]],
		});
	};

	const decrypt = async (bytes: Uint8Array, resolveKeyId?: IsobmffInputFormatOptions['resolveKeyId']) => {
		using input = open(bytes, { resolveKeyId: resolveKeyId ?? (() => key.toString('hex')) });
		return (await collect(await firstVideoTrack(input), false)).map(x => [...x.data]);
	};

	test('decrypts cenc samples with 8-byte IVs and no subsamples', async () => {
		const ivs = [[1, 2, 3, 4, 5, 6, 7, 8], [9, 9, 9, 9, 9, 9, 9, 9]];
		const ciphertexts = plaintexts.map((data, i) => encryptCtr(data, ivs[i]!, [[0, data.length]]));

		const decrypted = await decrypt(buildEncrypted(
			encryptedEntry('cenc', tencBox({ ivSize: 8 })),
			ciphertexts,
			sencBox(ivs.map(iv => ({ iv }))),
		));
		expect(decrypted).toEqual(plaintexts);
	});

	test('decrypts cenc subsamples with 16-byte IVs, the counter running across subsamples', async () => {
		const ivs = [zeros(16).map((_, i) => i), zeros(16).map((_, i) => 0xf0 + i)];
		const subsamples: [number, number][][] = [[[5, 100], [10, 90]], [[5, 50]]];
		const ciphertexts = plaintexts.map((data, i) => {
			let pos = 0;
			const ranges = subsamples[i]!.map(([clear, protectedLength]): [number, number] => {
				const range: [number, number] = [pos + clear, protectedLength];
				pos += clear + protectedLength;
				return range;
			});
			return encryptCtr(data, ivs[i]!, ranges);
		});

		const decrypted = await decrypt(buildEncrypted(
			encryptedEntry('cenc', tencBox({ ivSize: 16 })),
			ciphertexts,
			sencBox(ivs.map((iv, i) => ({ iv, subsamples: subsamples[i] }))),
		));
		expect(decrypted).toEqual(plaintexts);
	});

	test('decrypts cens with a 1:9 pattern', async () => {
		const ivs = [zeros(8).map((_, i) => i + 1), zeros(8).map((_, i) => i + 2)];
		const ciphertexts = plaintexts.map((data, i) => {
			return encryptCtr(data, ivs[i]!, patternBlocks(5, data.length - 5, 1, 9));
		});

		const decrypted = await decrypt(buildEncrypted(
			encryptedEntry('cens', tencBox({ version: 1, pattern: 0x19, ivSize: 8 })),
			ciphertexts,
			sencBox(ivs.map((iv, i) => ({ iv, subsamples: [[5, plaintexts[i]!.length - 5]] }))),
		));
		expect(decrypted).toEqual(plaintexts);
	});

	test('decrypts cbcs with a 1:9 pattern and a constant IV', async () => {
		const constantIv = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', 'hex');
		const ciphertexts = plaintexts.map((data) => {
			return encryptCbc(data, constantIv, [patternBlocks(5, data.length - 5, 1, 9)]);
		});

		const decrypted = await decrypt(buildEncrypted(
			encryptedEntry('cbcs', tencBox({ version: 1, pattern: 0x19, ivSize: 0, constantIv })),
			ciphertexts,
			sencBox(plaintexts.map(data => ({ iv: [], subsamples: [[5, data.length - 5]] }))),
		));
		expect(decrypted).toEqual(plaintexts);
	});

	test('reads the per-sample IVs from saiz and saio when there is no senc', async () => {
		const ivs = [[1, 1, 1, 1, 1, 1, 1, 1], [2, 2, 2, 2, 2, 2, 2, 2]];
		const ciphertexts = plaintexts.map((data, i) => encryptCtr(data, ivs[i]!, [[0, data.length]]));

		// The aux info goes into a free box inside the traf; saio points at it relative to the moof start
		const entry = encryptedEntry('cenc', tencBox({ ivSize: 8 }));
		const build = (auxOffset: number) => buildEncrypted(entry, ciphertexts, null, [
			fullBox('saiz', 0, 0, [8], u32(2)),
			fullBox('saio', 0, 0, u32(1), u32(auxOffset)),
			box('free', ivs.flat()),
		]);
		const probe = build(0);
		const moofPos = indexOfBox(probe, 'moof');
		const auxPos = indexOfBox(probe, 'free', moofPos) + 8;

		expect(await decrypt(build(auxPos - moofPos))).toEqual(plaintexts);
	});

	test('passes the key ID and the pssh boxes of moov and moof to resolveKeyId', async () => {
		const ivs = [[1, 2, 3, 4, 5, 6, 7, 8], [8, 7, 6, 5, 4, 3, 2, 1]];
		const ciphertexts = plaintexts.map((data, i) => encryptCtr(data, ivs[i]!, [[0, data.length]]));
		const widevine = Array.from(Buffer.from('edef8ba979d64acea3c827dcd51d21ed', 'hex'));
		const clearKey = Array.from(Buffer.from('1077efecc0b24d02ace33c1e52e2fb4b', 'hex'));
		const bytes = buildFragmentedMp4({
			tracks: [{ trackId: 1, timescale: 1000, sampleEntries: [encryptedEntry('cenc', tencBox({ ivSize: 8 }))] }],
			moovChildren: [fullBox('pssh', 0, 0, widevine, u32(3), [7, 8, 9])],
			fragments: [[{
				trackId: 1,
				baseMediaDecodeTime: 0,
				truns: [{ samples: ciphertexts.map(data => ({ data, duration: 40 })) }],
				extraChildren: [sencBox(ivs.map(iv => ({ iv })))],
			}]],
		});
		// Add a version 1 pssh with key IDs to the moof
		const moofPos = indexOfBox(bytes, 'moof');
		const pssh = fullBox('pssh', 1, 0, clearKey, u32(1), keyId, u32(0));
		const moof = [...bytes.subarray(moofPos, moofPos + readU32(bytes, moofPos))];
		// The moof grows, so the trun data offset (relative to the moof) grows with it
		const trunPos = indexOfBox(new Uint8Array(moof), 'trun');
		const view = new DataView(new Uint8Array(moof).buffer);
		view.setUint32(trunPos + 16, view.getUint32(trunPos + 16) + pssh.length);
		const patchedMoof = [...new Uint8Array(view.buffer)];
		const grownMoof = [...u32(patchedMoof.length + pssh.length), ...patchedMoof.slice(4), ...pssh];
		const file = new Uint8Array([
			...bytes.subarray(0, moofPos),
			...grownMoof,
			...bytes.subarray(moofPos + moof.length),
		]);

		const calls: { keyId: string; psshBoxes: PsshBox[] }[] = [];
		const decrypted = await decrypt(file, (options) => {
			calls.push(options);
			return key;
		});

		expect(decrypted).toEqual(plaintexts);
		expect(calls).toHaveLength(1); // The key is cached
		expect(calls[0]!.keyId).toBe(keyIdHex);
		expect(calls[0]!.psshBoxes).toEqual([
			{ systemId: Buffer.from(widevine).toString('hex'), keyIds: null, data: new Uint8Array([7, 8, 9]) },
			{ systemId: Buffer.from(clearKey).toString('hex'), keyIds: [keyIdHex], data: new Uint8Array(0) },
		]);
	});

	test('requires a key resolver for encrypted sample data, but not for metadata', async () => {
		const bytes = buildEncrypted(
			encryptedEntry('cenc', tencBox({ ivSize: 8 })),
			plaintexts,
			sencBox(plaintexts.map(() => ({ iv: zeros(8) }))),
		);

		using input = open(bytes);
		const track = await firstVideoTrack(input);
		expect(await track.getCodec()).toBe('avc');
		expect(await collect(track)).toHaveLength(2);
		await expect(collect(track, false)).rejects.toThrow(/resolveKeyId/);

		await expect(decrypt(bytes, () => 'not a key')).rejects.toThrow(TypeError);
	});
});

describe('Repository files against ffprobe', () => {
	// [type, codec, packets, key packets, total bytes, first timestamp, sum of timestamps] per track, from
	// ffprobe -show_streams -show_packets -of json <file> (FFmpeg 7.0)
	const expectations: [string, [string, string, number, number, number, number, number][]][] = [
		['video.mp4', [['video', 'avc', 125, 1, 1786456, 0, 310], ['audio', 'aac', 237, 237, 200581, 0, 596.608]]],
		['demo.mp4', [['video', 'avc', 125, 5, 506310, 0, 310], ['audio', 'aac', 236, 236, 43595, -0.021333, 586.539]]],
		['edts.mp4', [['video', 'avc', 225, 5, 6870, 0, 1008], ['audio', 'aac', 390, 390, 76146, -0.047891, 1742.672]]],
		['cursed-vfr.mp4', [['video', 'avc', 63, 4, 907911, 0, 223.629]]],
		['missing-reorder-metadata-v1.mp4', [['video', 'avc', 48, 2, 1956144, 0, 47.001]]],
		['multiple-aac-tracks.mp4', [
			['audio', 'aac', 235, 235, 281775, 0, 586.56],
			['audio', 'aac', 235, 235, 281775, 0, 586.56],
		]],
		['sar_2x1.mp4', [['video', 'avc', 150, 1, 497748, 0, 372.5]]],
		['video-h265.mp4', [
			['video', 'hevc', 300, 2, 1273997, 0, 1495],
			['audio', 'aac', 470, 470, 160472, -0.021333, 2341.227],
		]],
		['ac3.mp4', [['audio', 'ac3', 63, 63, 112896, 0, 62.496]]],
		['eac3.mp4', [['audio', 'eac3', 63, 63, 96768, 0, 62.496]]],
		['toothsome-dts.mp4', [['audio', 'dts', 1805, 1805, 924160, 0, 34733.013]]],
		['truehd.mp4', [['audio', 'truehd', 6000, 375, 2200818, 0, 14997.5]]],
		['missing-tfdt.mp4', [['video', 'avc', 240, 4, 8403, 0, 478]]],
		['fragments-without-keyframes.mp4', [['video', 'avc', 120, 8, 207712, 0, 238]]],
	];

	for (const [fileName, tracks] of expectations) {
		test(`matches ffprobe's packets for ${fileName}`, async () => {
			using input = new Input({
				source: new BufferSource(readFileSync(path.join(__dirname, '..', 'public', fileName))),
				formats: ALL_FORMATS,
			});
			const inputTracks = await input.getTracks();
			expect(inputTracks).toHaveLength(tracks.length);

			for (let i = 0; i < tracks.length; i++) {
				const [type, codec, count, keyCount, totalBytes, firstTimestamp, timestampSum] = tracks[i]!;
				const packets = await collect(inputTracks[i]!);

				expect(inputTracks[i]!.type).toBe(type);
				expect(await inputTracks[i]!.getCodec()).toBe(codec);
				expect(packets).toHaveLength(count);
				expect(packets.filter(x => x.type === 'key')).toHaveLength(keyCount);
				expect(packets.reduce((a, b) => a + b.byteLength, 0)).toBe(totalBytes);
				expect(Math.min(...packets.map(x => x.timestamp))).toBeCloseTo(firstTimestamp, 5);
				expect(packets.reduce((a, b) => a + b.timestamp, 0)).toBeCloseTo(timestampSum, 2);
			}
		});
	}
});
