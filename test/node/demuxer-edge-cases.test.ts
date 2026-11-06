import { describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { EBMLId } from '../../src/matroska/ebml.js';
import { buildIsobmffMimeType, parsePsshBoxContents, psshBoxesAreEqual } from '../../src/isobmff/isobmff-misc.js';
import {
	adtsFrame,
	annexB,
	ascii,
	buildAvcSps,
	buildFragmentedMp4,
	buildMp4,
	concatBytes,
	ebml,
	ebmlFloat,
	ebmlString,
	ebmlUint,
	flacFile,
	flacFrame,
	id3v24Tag,
	mkvFile,
	mkvSimpleBlock,
	mp4Box,
	Mp4FragmentRun,
	mp4FullBox,
	mp4IlstItem,
	mp4MdtaMeta,
	mp4SoundEntry,
	mp4SoundEntryV2,
	mp4VisualEntry,
	riffChunk,
	tsPackets,
	tsPat,
	tsPes,
	tsPmt,
	u16be,
	u32be,
	u32le,
	waveFile,
	waveFmt,
} from './helpers/mutation-bytes.js';

const openBytes = (bytes: Uint8Array) => new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

const mkvAudioTrack = (codecId: string, bitDepth: number | null, channels = 2, extra: Uint8Array[] = []) => ebml(
	EBMLId.TrackEntry,
	ebmlUint(EBMLId.TrackNumber, 1),
	ebmlUint(EBMLId.TrackUID, 1),
	ebmlUint(EBMLId.TrackType, 2),
	ebmlString(EBMLId.CodecID, codecId),
	ebml(
		EBMLId.Audio,
		ebmlFloat(EBMLId.SamplingFrequency, 48000),
		ebmlUint(EBMLId.Channels, channels),
		...(bitDepth === null ? [] : [ebmlUint(EBMLId.BitDepth, bitDepth)]),
	),
	...extra,
);

const mkvVideoTrack = (codecId: string, videoChildren: Uint8Array[], extra: Uint8Array[] = []) => ebml(
	EBMLId.TrackEntry,
	ebmlUint(EBMLId.TrackNumber, 1),
	ebmlUint(EBMLId.TrackUID, 1),
	ebmlUint(EBMLId.TrackType, 1),
	ebmlString(EBMLId.CodecID, codecId),
	ebml(EBMLId.Video, ...videoChildren),
	...extra,
);

const mkvCluster = (timestamp: number, ...simpleBlocks: Uint8Array[]) => ebml(
	EBMLId.Cluster,
	ebmlUint(EBMLId.Timestamp, timestamp),
	...simpleBlocks.map(block => ebml(EBMLId.SimpleBlock, block)),
);

describe('MP4 sample tables', () => {
	const sps = buildAvcSps({ profileIdc: 66, levelIdc: 30, widthInMbs: 20, heightInMapUnits: 15 });
	const pps = [0x68, 0xce, 0x3c, 0x80];
	const avcC = mp4Box(
		'avcC',
		[1, 66, 0xc0, 30, 0xff, 0xe1], u16be(sps.length), sps, [1], u16be(pps.length), pps,
	);
	const videoSample = (i: number, size = 6) => {
		const data = new Uint8Array(size);
		data.set([0, 0, 0, size - 4, 0x41, i]);
		return data;
	};

	test('PCM chunks become one packet each, timed across several stts entries', async () => {
		// 3000 stereo s16 frames; chunks of 1000, 1000, 500 and 500 frames
		const frames = Array.from({ length: 3000 }, (_, i) => new Uint8Array([i & 0xff, i >> 8, 0, 0]));
		const bytes = buildMp4({
			handler: 'soun',
			timescale: 48000,
			sampleEntry: mp4SoundEntry('sowt', 2, 16, 48000),
			samples: frames,
			stts: [[1200, 1], [1800, 1]],
			stsc: [[1, 1000], [3, 500]],
			constantSampleSize: 4,
		});
		using input = openBytes(bytes);
		const track = await input.getPrimaryAudioTrack();
		expect(await track!.getCodec()).toBe('pcm-s16');
		const packets = [];
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			packets.push(packet);
		}
		expect(packets.map(p => p.timestamp * 48000)).toEqual([0, 1000, 2000, 2500]);
		expect(packets.map(p => Math.round(p.duration * 48000))).toEqual([1000, 1000, 500, 500]);
		expect(packets.map(p => p.data.byteLength)).toEqual([4000, 4000, 2000, 2000]);
		// Each packet starts with its first frame's index
		expect(packets.map(p => p.data[0]! + 256 * p.data[1]!)).toEqual([0, 1000, 2000, 2500]);
	});

	test.each([false, true])('samples are found through a multi-entry stsc layout (co64: %s)', async (co64) => {
		const samples = Array.from({ length: 7 }, (_, i) => videoSample(i));
		const bytes = buildMp4({
			handler: 'vide',
			timescale: 30000,
			sampleEntry: mp4VisualEntry('avc1', 320, 240, avcC),
			samples,
			stts: [[7, 1000]],
			stsc: [[1, 3], [2, 1], [4, 2]],
			stss: [1, 5],
			co64,
			width: 320,
			height: 240,
		});
		using input = openBytes(bytes);
		const track = await input.getPrimaryVideoTrack();
		const sink = new EncodedPacketSink(track!);
		const packets = [];
		for await (const packet of sink.packets()) {
			packets.push(packet);
		}
		expect(packets.map(p => p.data[5])).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(packets.map(p => p.type)).toEqual(['key', 'delta', 'delta', 'delta', 'key', 'delta', 'delta']);
		expect(packets.map(p => p.timestamp * 30)).toEqual([0, 1, 2, 3, 4, 5, 6]);

		expect((await sink.getKeyPacket(3.5 / 30))!.data[5]).toBe(0);
		expect((await sink.getKeyPacket(4 / 30))!.data[5]).toBe(4);
		expect((await sink.getNextKeyPacket(packets[1]!))!.data[5]).toBe(4);
		expect(await sink.getNextKeyPacket(packets[4]!)).toBe(null);
	});

	test('a constant stsz sample size applies to every sample', async () => {
		const samples = Array.from({ length: 4 }, (_, i) => videoSample(i, 10));
		const bytes = buildMp4({
			handler: 'vide',
			timescale: 25,
			sampleEntry: mp4VisualEntry('avc1', 320, 240, avcC),
			samples,
			stts: [[4, 1]],
			stsc: [[1, 2]],
			constantSampleSize: 10,
			width: 320,
			height: 240,
		});
		using input = openBytes(bytes);
		const track = await input.getPrimaryVideoTrack();
		const packets = [];
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			packets.push(packet);
		}
		expect(packets.map(p => [p.data.byteLength, p.data[5]])).toEqual([[10, 0], [10, 1], [10, 2], [10, 3]]);
	});

	test('ctts version 1 negative offsets give presentation order and lookups by presentation time', async () => {
		// Decode order I P B B with composition offsets 0, +3, -1, -1 frames (I0 B1 B2 P3 in presentation order)
		const samples = Array.from({ length: 4 }, (_, i) => videoSample(i));
		const bytes = buildMp4({
			handler: 'vide',
			timescale: 1000,
			sampleEntry: mp4VisualEntry('avc1', 320, 240, avcC),
			samples,
			stts: [[4, 100]],
			ctts: { version: 1, entries: [[1, 0], [1, 200], [2, -100]] },
			stsc: [[1, 4]],
			stss: [1],
			width: 320,
			height: 240,
		});
		using input = openBytes(bytes);
		const track = await input.getPrimaryVideoTrack();
		const sink = new EncodedPacketSink(track!);
		const packets = [];
		for await (const packet of sink.packets()) {
			packets.push(packet);
		}
		// Decode order, with presentation timestamps
		const order = packets.map(p => [p.data[5], Math.round(p.timestamp * 1000)]);
		expect(order).toEqual([[0, 0], [1, 300], [2, 100], [3, 200]]);
		expect((await sink.getPacket(0.25))!.data[5]).toBe(3);
		expect((await sink.getPacket(0.1))!.data[5]).toBe(2);
		expect((await sink.getPacket(0.35))!.data[5]).toBe(1);
		expect(await sink.getPacket(-0.01)).toBe(null);
		expect(await track!.computeDuration()).toBeCloseTo(0.4, 6);
	});
});

describe('ADTS demuxing', () => {
	// 44.1 kHz (index 4) stereo AAC-LC frames of 1024 samples
	const frames = [adtsFrame(20, { fill: 1 }), adtsFrame(30, { fill: 2 }), adtsFrame(25, { fill: 3, crc: true })];
	const frameDuration = 1024 / 44100;

	const readAll = async (bytes: Uint8Array) => {
		using input = openBytes(bytes);
		const track = await input.getPrimaryAudioTrack();
		const packets = [];
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			packets.push(packet);
		}
		return packets;
	};

	test('every frame is one key packet carrying the whole frame, header included', async () => {
		const packets = await readAll(concatBytes(...frames));
		expect(packets.map(p => p.data.byteLength)).toEqual([27, 37, 34]);
		expect(packets.map(p => p.data[p.data.length - 1])).toEqual([1, 2, 3]);
		expect(packets.every(p => p.type === 'key')).toBe(true);
		expect(packets.map(p => p.timestamp)).toEqual([0, frameDuration, 2 * frameDuration]);
		expect(packets.map(p => p.duration)).toEqual([frameDuration, frameDuration, frameDuration]);
	});

	test('a final frame cut short by the end of the file is dropped, one ending right at the end is kept', async () => {
		const whole = concatBytes(...frames);
		expect(await readAll(whole.subarray(0, whole.length - 1))).toHaveLength(2);
		expect(await readAll(whole)).toHaveLength(3);
	});

	test('a leading ID3v2 tag is skipped and read as metadata', async () => {
		const bytes = concatBytes(id3v24Tag([['TIT2', 'Title'], ['TPE1', 'Artist']]), ...frames);
		using input = openBytes(bytes);
		const tags = await input.getMetadataTags();
		expect(tags.title).toBe('Title');
		expect(tags.artist).toBe('Artist');
		const track = await input.getPrimaryAudioTrack();
		const first = await new EncodedPacketSink(track!).getFirstPacket();
		expect(first!.data.byteLength).toBe(27);
		expect(first!.timestamp).toBe(0);
	});

	test('metadata-only packets have no data but report the frame size', async () => {
		using input = openBytes(concatBytes(...frames));
		const track = await input.getPrimaryAudioTrack();
		const sink = new EncodedPacketSink(track!);
		const first = await sink.getFirstPacket({ metadataOnly: true });
		expect(first!.isMetadataOnly).toBe(true);
		expect(first!.data.byteLength).toBe(0);
		expect(first!.byteLength).toBe(27);
		const second = await sink.getNextPacket(first!, { metadataOnly: true });
		expect(second!.byteLength).toBe(37);
		expect(second!.timestamp).toBe(frameDuration);
	});

	test('track properties', async () => {
		using input = openBytes(concatBytes(...frames));
		const track = (await input.getPrimaryAudioTrack())!;
		expect(track.id).toBe(1);
		expect(track.number).toBe(1);
		expect(await track.getCodec()).toBe('aac');
		expect(await track.getSampleRate()).toBe(44100);
		expect(await track.getNumberOfChannels()).toBe(2);
		expect(await track.getTimeResolution()).toBe(44100);
		expect(await track.getLanguageCode()).toBe('und');
		expect(await track.getName()).toBe(null);
		expect(await track.isRelativeToUnixEpoch()).toBe(false);
		expect(await track.getDisposition()).toMatchObject({ default: true, forced: false });
		expect(await track.getDecoderConfig()).toEqual({ codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 44100 });
		expect(await track.getDurationFromMetadata()).toBe(null);
	});

	test('packet lookups by timestamp', async () => {
		using input = openBytes(concatBytes(...frames));
		const track = (await input.getPrimaryAudioTrack())!;
		const sink = new EncodedPacketSink(track);
		expect(await sink.getPacket(-0.001)).toBe(null);
		expect((await sink.getPacket(0))!.timestamp).toBe(0);
		expect((await sink.getPacket(frameDuration))!.timestamp).toBe(frameDuration);
		expect((await sink.getPacket(frameDuration * 1.5))!.timestamp).toBe(frameDuration);
		expect((await sink.getPacket(100))!.timestamp).toBe(2 * frameDuration);
		expect((await sink.getKeyPacket(frameDuration * 2.5))!.timestamp).toBe(2 * frameDuration);
		const last = await sink.getPacket(100);
		expect(await sink.getNextPacket(last!)).toBe(null);
	});
});

describe('MP4 PCM sample entries', () => {
	const pcmCodec = async (sampleEntry: Uint8Array, bytesPerFrame: number) => {
		const bytes = buildMp4({
			handler: 'soun',
			timescale: 48000,
			sampleEntry,
			samples: Array.from({ length: 8 }, () => new Uint8Array(bytesPerFrame)),
			stts: [[8, 1]],
			stsc: [[1, 8]],
			constantSampleSize: bytesPerFrame,
		});
		using input = openBytes(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		return {
			codec: await track.getCodec(),
			channels: await track.getNumberOfChannels(),
			sampleRate: await track.getSampleRate(),
		};
	};

	test.each([
		// bits, lpcm format flags (1 = float, 2 = big-endian, 4 = signed integer, 8 = packed), expected codec
		[8, 0x0c, 'pcm-s8'],
		[8, 0x08, 'pcm-u8'],
		[16, 0x0c, 'pcm-s16'],
		[16, 0x0e, 'pcm-s16be'],
		[24, 0x0c, 'pcm-s24'],
		[24, 0x0e, 'pcm-s24be'],
		[32, 0x0c, 'pcm-s32'],
		[32, 0x0e, 'pcm-s32be'],
		[32, 0x09, 'pcm-f32'],
		[32, 0x0b, 'pcm-f32be'],
		[20, 0x0c, 'pcm-s24'], // 20 bits are stored in 3 bytes
		[16, 0x08, null], // unsigned 16-bit has no codec
		[24, 0x09, null], // 24-bit float doesn't exist
		[0, 0x0c, null],
		[72, 0x0c, null],
	])('QuickTime v2 lpcm with %i bits and flags %i reads as %s', async (bits, flags, expected) => {
		const entry = mp4SoundEntryV2('lpcm', 2, bits, flags, 44100);
		const info = await pcmCodec(entry, 2 * Math.ceil(bits / 8));
		expect(info).toEqual({ codec: expected, channels: 2, sampleRate: 44100 });
	});

	test.each([
		['ipcm', 0x01, 16, 'pcm-s16'],
		['ipcm', 0x01, 24, 'pcm-s24'],
		['ipcm', 0x01, 32, 'pcm-s32'],
		['ipcm', 0x00, 16, 'pcm-s16be'],
		['ipcm', 0x00, 24, 'pcm-s24be'],
		['ipcm', 0x00, 32, 'pcm-s32be'],
		['ipcm', 0x01, 8, null],
		['fpcm', 0x01, 32, 'pcm-f32'],
		['fpcm', 0x01, 64, 'pcm-f64'],
		['fpcm', 0x00, 32, 'pcm-f32be'],
		['fpcm', 0x00, 64, 'pcm-f64be'],
		['fpcm', 0x00, 16, null],
	])('%s with pcmC format flags %i and %i bits reads as %s', async (format, formatFlags, bits, expected) => {
		const pcmC = mp4FullBox('pcmC', 0, 0, [formatFlags, bits]);
		const entry = mp4SoundEntry(format, 2, bits, 48000, pcmC);
		expect((await pcmCodec(entry, 2 * Math.ceil(bits / 8))).codec).toBe(expected);
	});

	test.each([
		['sowt', 8, null, 'pcm-s8'],
		['twos', 8, null, 'pcm-s8'],
		['twos', 16, null, 'pcm-s16be'],
		['twos', 16, [0, 1], 'pcm-s16'], // enda says little-endian
		['raw ', 8, null, 'pcm-u8'],
		['in24', 24, null, 'pcm-s24be'],
		['in24', 24, [0, 1], 'pcm-s24'],
		['in32', 32, null, 'pcm-s32be'],
		['fl32', 32, [0, 1], 'pcm-f32'],
		['fl64', 64, null, 'pcm-f64be'],
	])('QuickTime %j with %i-bit samples (enda %j) reads as %s', async (format, bits, enda, expected) => {
		const entry = mp4SoundEntry(format, 1, bits, 48000, ...(enda ? [mp4Box('enda', enda)] : []));
		expect((await pcmCodec(entry, Math.ceil(bits / 8))).codec).toBe(expected);
	});

	test('an enda box inside a wave box (as FFmpeg writes it for MOV) makes in24/in32/fl32 little-endian', async () => {
		const cases = [['in24', 24, 'pcm-s24'], ['in32', 32, 'pcm-s32'], ['fl32', 32, 'pcm-f32']] as const;
		for (const [format, bits, expected] of cases) {
			const wave = mp4Box('wave', mp4Box('frma', ascii(format)), mp4Box('enda', [0, 1]), new Uint8Array(8));
			expect((await pcmCodec(mp4SoundEntry(format, 2, bits, 48000, wave), 2 * bits / 8)).codec).toBe(expected);
		}
	});
});

describe('MP4 metadata items', () => {
	const withMetadata = async (moovExtra: Uint8Array[]) => {
		const bytes = buildMp4({
			handler: 'soun',
			timescale: 1000,
			sampleEntry: mp4SoundEntry('sowt', 1, 16, 8000),
			samples: [new Uint8Array(2)],
			stts: [[1, 1]],
			stsc: [[1, 1]],
			moovExtra,
		});
		using input = openBytes(bytes);
		return await input.getMetadataTags();
	};
	const utf16be = (text: string) => [...text].flatMap(char => [0, char.charCodeAt(0)]);

	test('QuickTime mdta keys (as Apple devices write them) map onto the tags', async () => {
		const jpeg = [0xff, 0xd8, 0xff, 0xe0];
		const tags = await withMetadata([mp4MdtaMeta([
			['com.apple.quicktime.title', 1, 'A title'],
			['com.apple.quicktime.description', 1, 'A description'],
			['com.apple.quicktime.artist', 1, 'An artist'],
			['com.apple.quicktime.album', 1, 'An album'],
			['com.apple.quicktime.comment', 1, 'A comment'],
			['com.apple.quicktime.genre', 1, 'A genre'],
			['com.apple.quicktime.creationdate', 1, '2023-05-01T12:34:56+0200'],
			['com.apple.quicktime.artwork', 13, jpeg],
			['com.apple.quicktime.make', 1, 'Apple'],
		])]);
		expect(tags).toMatchObject({
			title: 'A title',
			description: 'A description',
			artist: 'An artist',
			album: 'An album',
			comment: 'A comment',
			genre: 'A genre',
			date: new Date('2023-05-01T10:34:56Z'),
		});
		expect(tags.images).toEqual([{ data: new Uint8Array(jpeg), kind: 'coverFront', mimeType: 'image/jpeg' }]);
		expect(tags.raw!['com.apple.quicktime.make']).toBe('Apple');
	});

	test('3GPP-style and iTunes item names map onto the tags; the first value of a tag wins', async () => {
		const ilst = mp4Box(
			'ilst',
			mp4IlstItem('titl', 1, 'First title'),
			mp4IlstItem('©nam', 1, 'Second title'),
			mp4IlstItem('dscp', 2, utf16be('UTF-16 description')),
			mp4IlstItem('albm', 1, 'Album'),
			mp4IlstItem('aART', 1, 'Album artist'),
			mp4IlstItem('©gen', 1, 'Genre'),
			mp4IlstItem('©lyr', 1, 'Lyrics'),
			mp4IlstItem('rldt', 1, '2015-06'),
			mp4IlstItem('tmpo', 21, [0, 120]),
			mp4IlstItem('trkn', 0, [0, 0, 0, 3, 0, 12, 0, 0]),
			mp4IlstItem('disk', 0, [0, 0, 0, 1, 0, 2]),
			mp4IlstItem('covr', 14, [0x89, 0x50, 0x4e, 0x47]),
			mp4IlstItem('covr', 27, [0x42, 0x4d]),
			mp4IlstItem('covr', 0, [1, 2, 3]),
		);
		const hdlr = mp4FullBox('hdlr', 0, 0, u32be(0), ascii('mdir'), new Uint8Array(12), [0]);
		const meta = mp4FullBox('meta', 0, 0, hdlr, ilst);
		const tags = await withMetadata([mp4Box('udta', meta)]);
		expect(tags).toMatchObject({
			title: 'First title',
			description: 'UTF-16 description',
			album: 'Album',
			albumArtist: 'Album artist',
			genre: 'Genre',
			lyrics: 'Lyrics',
			date: new Date('2015-06-01T00:00:00Z'),
			beatsPerMinute: 120,
			trackNumber: 3,
			tracksTotal: 12,
			discNumber: 1,
			discsTotal: 2,
		});
		expect(tags.images!.map(image => image.mimeType)).toEqual(['image/png', 'image/bmp', 'image/*']);
	});

	test('a "track" string item gives the track number and total; invalid values are ignored', async () => {
		const tags = await withMetadata([mp4MdtaMeta([['track', 1, '7/9']])]);
		expect([tags.trackNumber, tags.tracksTotal]).toEqual([7, 9]);

		const invalid = await withMetadata([mp4MdtaMeta([
			['track', 1, '0/x'],
			['tmpo', 21, [0, 0]],
			['date', 1, 'not a date'],
			['title', 0, [1, 2]],
		])]);
		expect([invalid.trackNumber, invalid.tracksTotal, invalid.beatsPerMinute, invalid.date, invalid.title])
			.toEqual([undefined, undefined, undefined, undefined, undefined]);
	});
});

const VP8_KEY_FRAME = [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01];

describe('Matroska demuxing', () => {
	test.each([
		['A_PCM/INT/LIT', 8, 'pcm-u8'],
		['A_PCM/INT/LIT', 16, 'pcm-s16'],
		['A_PCM/INT/LIT', 24, 'pcm-s24'],
		['A_PCM/INT/LIT', 32, 'pcm-s32'],
		['A_PCM/INT/BIG', 8, 'pcm-u8'],
		['A_PCM/INT/BIG', 16, 'pcm-s16be'],
		['A_PCM/INT/BIG', 24, 'pcm-s24be'],
		['A_PCM/INT/BIG', 32, 'pcm-s32be'],
		['A_PCM/FLOAT/IEEE', 32, 'pcm-f32'],
		['A_PCM/FLOAT/IEEE', 64, 'pcm-f64'],
	])('%s with BitDepth %i reads as %s', async (codecId, bitDepth, expected) => {
		const bytes = mkvFile({
			trackEntries: [mkvAudioTrack(codecId, bitDepth)],
			rest: [mkvCluster(0, mkvSimpleBlock(1, 0, 0x80, new Uint8Array(bitDepth / 8 * 2 * 480)))],
		});
		using input = openBytes(bytes);
		const track = await input.getPrimaryAudioTrack();
		expect(await track!.getCodec()).toBe(expected);
	});

	test('PCM with an unsupported bit depth has no codec', async () => {
		const bytes = mkvFile({
			trackEntries: [mkvAudioTrack('A_PCM/FLOAT/IEEE', 16)],
			rest: [mkvCluster(0, mkvSimpleBlock(1, 0, 0x80, new Uint8Array(64)))],
		});
		using input = openBytes(bytes);
		const track = await input.getPrimaryAudioTrack();
		expect(await track!.getCodec()).toBe(null);
	});

	test.each([
		// DisplayWidth/DisplayHeight → square-pixel size and decoder config aspect
		[[853, 480], [853, 480], { displayAspectWidth: 853, displayAspectHeight: 480 }],
		[[640, 960], [640, 960], { displayAspectWidth: 640, displayAspectHeight: 960 }],
		[[16, 9], [853, 480], { displayAspectWidth: 853, displayAspectHeight: 480 }],
		[[640, 480], [640, 480], {}],
		[[0, 480], [640, 480], {}],
	] as const)('DisplayWidth/Height %j on 640x480 give a %j display size', async ([dw, dh], [ew, eh], aspect) => {
		const bytes = mkvFile({
			trackEntries: [mkvVideoTrack('V_VP8', [
				ebmlUint(EBMLId.PixelWidth, 640),
				ebmlUint(EBMLId.PixelHeight, 480),
				ebmlUint(EBMLId.DisplayWidth, dw),
				ebmlUint(EBMLId.DisplayHeight, dh),
			])],
			rest: [mkvCluster(0, mkvSimpleBlock(1, 0, 0x80, VP8_KEY_FRAME))],
		});
		using input = openBytes(bytes);
		const track = await input.getPrimaryVideoTrack();
		expect(await track!.getDisplayWidth()).toBe(ew);
		expect(await track!.getDisplayHeight()).toBe(eh);
		const config = await track!.getDecoderConfig();
		expect(config!.codedWidth).toBe(640);
		expect(config!.codedHeight).toBe(480);
		expect(config!.displayAspectWidth).toBe((aspect as { displayAspectWidth?: number }).displayAspectWidth);
		expect(config!.displayAspectHeight).toBe((aspect as { displayAspectHeight?: number }).displayAspectHeight);
	});

	test('colour values missing from the Colour element are filled in from the SPS', async () => {
		// BT.709 primaries/transfer, BT.470BG matrix, full range in the SPS; the container only names the matrix
		const sps = buildAvcSps({
			profileIdc: 66,
			levelIdc: 30,
			widthInMbs: 40,
			heightInMapUnits: 30,
			vui: { videoSignal: { fullRange: true, colour: [1, 1, 5] } },
		});
		const pps = [0x68, 0xce, 0x3c, 0x80];
		const avcC = concatBytes([1, 66, 0xc0, 30, 0xff, 0xe1], u16be(sps.length), sps, [1], u16be(pps.length), pps);
		const bytes = mkvFile({
			trackEntries: [mkvVideoTrack('V_MPEG4/ISO/AVC', [
				ebmlUint(EBMLId.PixelWidth, 640),
				ebmlUint(EBMLId.PixelHeight, 480),
				ebml(EBMLId.Colour, ebmlUint(EBMLId.MatrixCoefficients, 6)),
			], [ebml(EBMLId.CodecPrivate, avcC)])],
			rest: [mkvCluster(0, mkvSimpleBlock(1, 0, 0x80, [0, 0, 0, 2, 0x65, 0x88]))],
		});
		using input = openBytes(bytes);
		const track = await input.getPrimaryVideoTrack();
		const config = await track!.getDecoderConfig();
		expect(config!.colorSpace).toEqual({
			primaries: 'bt709',
			transfer: 'bt709',
			matrix: 'smpte170m',
			fullRange: true,
		});
	});

	test('a track with FlagEnabled 0 is left out, one with FlagEnabled 1 is kept', async () => {
		const disabled = mkvFile({
			trackEntries: [
				mkvAudioTrack('A_PCM/INT/LIT', 16, 2, [ebmlUint(EBMLId.FlagEnabled, 0)]),
			],
			rest: [mkvCluster(0, mkvSimpleBlock(1, 0, 0x80, new Uint8Array(64)))],
		});
		using disabledInput = openBytes(disabled);
		expect(await disabledInput.getTracks()).toHaveLength(0);

		const enabled = mkvFile({
			trackEntries: [mkvAudioTrack('A_PCM/INT/LIT', 16, 2, [ebmlUint(EBMLId.FlagEnabled, 1)])],
			rest: [mkvCluster(0, mkvSimpleBlock(1, 0, 0x80, new Uint8Array(64)))],
		});
		using enabledInput = openBytes(enabled);
		expect(await enabledInput.getTracks()).toHaveLength(1);
	});

	const simpleTag = (name: string, value: string) => ebml(
		EBMLId.SimpleTag,
		ebmlString(EBMLId.TagName, name),
		ebmlString(EBMLId.TagString, value),
	);

	test.each([
		['PART_NUMBER', '3', { trackNumber: 3 }],
		['PART_NUMBER', '0', {}],
		['PART_NUMBER', '-1', {}],
		['TRACK_NUMBER', '4/10', { trackNumber: 4, tracksTotal: 10 }],
		['TRACK_NUMBER', '0/0', {}],
		['TRACK_NUMBER', '4/-2', { trackNumber: 4 }],
		['DISC', '5', { discNumber: 5 }],
		['DISC_NUMBER', '2/3', { discNumber: 2, discsTotal: 3 }],
		['DISC_NUMBER', '0/-3', {}],
		['BPM', '0', {}],
		['BPM', '96', { beatsPerMinute: 96 }],
		['DATE_RELEASED', 'garbage', {}],
	])('the %s tag %j reads as %j', async (name, value, expected) => {
		const targets = ebml(EBMLId.Targets, ebmlUint(EBMLId.TargetTypeValue, 50));
		const bytes = mkvFile({
			trackEntries: [mkvAudioTrack('A_PCM/INT/LIT', 16)],
			rest: [
				ebml(EBMLId.Tags, ebml(EBMLId.Tag, targets, simpleTag(name, value))),
				mkvCluster(0, mkvSimpleBlock(1, 0, 0x80, new Uint8Array(64))),
			],
		});
		using input = openBytes(bytes);
		const { raw, ...tags } = await input.getMetadataTags();
		expect(raw).toBeDefined();
		expect(tags).toEqual(expected);
	});
});

describe('Matroska cue-based lookups', () => {
	const trackEntry = ebml(
		EBMLId.TrackEntry,
		ebmlUint(EBMLId.TrackNumber, 1),
		ebmlUint(EBMLId.TrackUID, 1),
		ebmlUint(EBMLId.TrackType, 1),
		ebmlString(EBMLId.CodecID, 'V_VP8'),
		ebml(EBMLId.Video, ebmlUint(EBMLId.PixelWidth, 640), ebmlUint(EBMLId.PixelHeight, 480)),
	);
	// Three one-second clusters, each with a key frame followed by three delta frames
	const clusters = [0, 1000, 2000].map(start => ebml(
		EBMLId.Cluster,
		ebmlUint(EBMLId.Timestamp, start),
		...[0, 250, 500, 750].map((offset) => {
			const isKey = offset === 0;
			const block = mkvSimpleBlock(1, offset, isKey ? 0x80 : 0x00, [isKey ? 0x10 : 0x11, 0, 0]);
			return ebml(EBMLId.SimpleBlock, block);
		}),
	));
	const build = (withCues: boolean) => {
		const info = ebml(EBMLId.Info, ebmlUint(EBMLId.TimestampScale, 1_000_000));
		const tracks = ebml(EBMLId.Tracks, trackEntry);
		const buildCues = (cuesLength: number) => {
			const clusterPositions: number[] = [];
			let position = info.length + tracks.length + cuesLength;
			for (const cluster of clusters) {
				clusterPositions.push(position);
				position += cluster.length;
			}
			const cuePoint = (index: number) => ebml(
				EBMLId.CuePoint,
				ebmlUint(EBMLId.CueTime, index * 1000),
				ebml(
					EBMLId.CueTrackPositions,
					ebmlUint(EBMLId.CueTrack, 1),
					ebmlUint(EBMLId.CueClusterPosition, clusterPositions[index]!),
				),
			);
			// Out of order and with a duplicate, which the demuxer has to sort out
			return ebml(EBMLId.Cues, cuePoint(2), cuePoint(0), cuePoint(1), cuePoint(1));
		};
		// The cues sit before the clusters, so their own size shifts the cluster positions they point to
		let cues = buildCues(0);
		cues = buildCues(cues.length);
		cues = buildCues(cues.length);
		return concatBytes(
			ebml(EBMLId.EBML, ebmlString(EBMLId.DocType, 'webm')),
			ebml(EBMLId.Segment, info, tracks, ...(withCues ? [cues] : []), ...clusters),
		);
	};

	test.each([true, false])('lookups are exact (with cues: %s)', async (withCues) => {
		using input = openBytes(build(withCues));
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		const at = (packet: EncodedPacket | null) => packet && Math.round(packet.timestamp * 1000);

		expect(at(await sink.getPacket(1.3))).toBe(1250);
		expect(at(await sink.getPacket(2.999))).toBe(2750);
		expect(await sink.getPacket(-0.1)).toBe(null);
		expect(at(await sink.getKeyPacket(1.6))).toBe(1000);
		expect(at(await sink.getKeyPacket(2.9))).toBe(2000);
		expect(at(await sink.getKeyPacket(0.999))).toBe(0);

		const delta = (await sink.getPacket(0.5))!;
		expect(at(await sink.getNextKeyPacket(delta))).toBe(1000);
		expect(at(await sink.getNextPacket(delta))).toBe(750);
		const lastKey = (await sink.getKeyPacket(2.5))!;
		expect(await sink.getNextKeyPacket(lastKey)).toBe(null);

		const all: number[] = [];
		for await (const packet of sink.packets()) {
			all.push(at(packet)!);
		}
		expect(all).toEqual([0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750]);
	});
});

describe('MPEG-TS demuxing', () => {
	const aacFrames = [0, 1, 2, 3].map((i) => {
		return adtsFrame(20 + i, { samplingFrequencyIndex: 3, channelConfiguration: 1, fill: i });
	});

	const buildTs = (options: {
		prefix?: number;
		suffix?: number;
		programs?: [number, number][];
		streams?: [number, number, number[]?][];
		pes?: Uint8Array[];
	} = {}) => {
		const { prefix, suffix } = options;
		const counter = { value: 0 };
		const pes = options.pes ?? [
			tsPes(0xc0, concatBytes(aacFrames[0]!, aacFrames[1]!), 90000),
			tsPes(0xc0, concatBytes(aacFrames[2]!, aacFrames[3]!), 90000 + 3840, 90000 + 3840),
		];
		return concatBytes(
			tsPackets(0, tsPat(options.programs ?? [[1, 0x1000]]), { prefix, suffix }),
			tsPackets(0x1000, tsPmt(1, options.streams ?? [[0x0f, 0x101]]), { prefix, suffix }),
			...pes.map(packet => tsPackets(0x101, packet, { prefix, suffix, counter })),
		);
	};

	const describeTrack = async (bytes: Uint8Array) => {
		using input = openBytes(bytes);
		const tracks = await input.getTracks();
		const track = (await input.getPrimaryAudioTrack())!;
		const packets: string[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(`${Math.round(packet.timestamp * 1e5) / 1e5}:${packet.byteLength}`);
		}
		return {
			mimeType: await input.getMimeType(),
			trackCount: tracks.length,
			codec: await track.getCodec(),
			sampleRate: await track.getSampleRate(),
			channels: await track.getNumberOfChannels(),
			packets,
		};
	};

	const expected = {
		mimeType: 'video/MP2T; codecs="mp4a.40.2"',
		trackCount: 1,
		codec: 'aac',
		sampleRate: 48000,
		channels: 1,
		packets: ['1:27', '1.02133:28', '1.04267:29', '1.064:30'],
	};

	test.each([
		['188-byte packets', 0, 0],
		['192-byte M2TS packets', 4, 0],
		['204-byte packets with FEC trailers', 0, 16],
	])('reads %s', async (_, prefix, suffix) => {
		expect(await describeTrack(buildTs({ prefix, suffix }))).toEqual(expected);
	});

	test('a PES packet spread over several transport packets is reassembled', async () => {
		const frames = Array.from({ length: 12 }, (_, i) => {
			return adtsFrame(60, { samplingFrequencyIndex: 3, channelConfiguration: 1, fill: i });
		});
		const info = await describeTrack(buildTs({ pes: [tsPes(0xc0, concatBytes(...frames), 0)] }));
		expect(info.packets).toEqual(frames.map((_, i) => `${Math.round(i * 1024 / 48000 * 1e5) / 1e5}:67`));
	});

	test('lookups in a long H.264 stream land on the right frames and key frames', async () => {
		// 60 frames at 25 fps starting at 1 s, a key frame every 10 frames, ~2 KB each so that lookups have to search
		const sps = buildAvcSps({ profileIdc: 66, levelIdc: 30, widthInMbs: 20, heightInMapUnits: 15 });
		const pps = [0x68, 0xce, 0x38, 0x80];
		const counter = { value: 0 };
		const frames = Array.from({ length: 60 }, (_, i) => {
			const isKey = i % 10 === 0;
			const slice = [isKey ? 0x65 : 0x41, 0x88, 0x84, ...new Array<number>(2000).fill((i & 0xff) | 1)];
			const accessUnit = isKey ? annexB([0x09, 0xf0], sps, pps, slice) : annexB([0x09, 0xf0], slice);
			const pts = 90000 + i * 3600;
			return tsPackets(0x100, tsPes(0xe0, accessUnit, pts, pts), { counter });
		});
		const bytes = concatBytes(
			tsPackets(0, tsPat([[1, 0x1000]])),
			tsPackets(0x1000, tsPmt(1, [[0x1b, 0x100]])),
			...frames,
		);

		using input = openBytes(bytes);
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.getCodec()).toBe('avc');
		expect([await track.getCodedWidth(), await track.getCodedHeight()]).toEqual([320, 240]);
		expect(await track.computeDuration()).toBeCloseTo(3.4, 10);
		const sink = new EncodedPacketSink(track);
		const frameIndex = (packet: EncodedPacket | null) => packet && Math.round((packet.timestamp - 1) / 0.04);

		let count = 0;
		for await (const packet of sink.packets()) {
			expect([frameIndex(packet), packet.type]).toEqual([count, count % 10 === 0 ? 'key' : 'delta']);
			count++;
		}
		expect(count).toBe(60);

		for (let i = 0; i < 60; i += 7) {
			for (const t of [1 + i * 0.04, 1 + i * 0.04 + 0.02]) {
				expect(frameIndex(await sink.getPacket(t))).toBe(i);
				expect(frameIndex(await sink.getKeyPacket(t))).toBe(i - (i % 10));
			}
		}
		expect(await sink.getPacket(0.5)).toBe(null);
		expect(frameIndex(await sink.getPacket(10))).toBe(59);
		const middle = (await sink.getPacket(1.5))!;
		expect(frameIndex(await sink.getNextKeyPacket(middle))).toBe(20);
		expect(frameIndex(await sink.getNextPacket(middle))).toBe(13);
	});

	test('the network PID entry in the PAT and unknown stream types are skipped', async () => {
		const bytes = buildTs({
			programs: [[0, 0x10], [1, 0x1000]],
			streams: [[0x15, 0x102], [0x0f, 0x101]],
		});
		expect(await describeTrack(bytes)).toEqual(expected);
	});
});

describe('WAVE demuxing', () => {
	const fmt = (formatTag: number, channels: number, bitsPerSample: number, extensible = false) => {
		return riffChunk('fmt ', waveFmt({ formatTag, channels, sampleRate: 8000, bitsPerSample, extensible }));
	};
	const probe = async (bytes: Uint8Array) => {
		using input = openBytes(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		const packets: string[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(`${packet.timestamp}+${Math.round(packet.duration * 1e6) / 1e6}:${packet.byteLength}`);
		}
		return {
			codec: await track.getCodec(),
			channels: await track.getNumberOfChannels(),
			duration: await track.computeDuration(),
			packets,
		};
	};

	test('PCM data is cut into packets of 2048 frames', async () => {
		const bytes = waveFile([fmt(1, 2, 16), riffChunk('data', new Uint8Array(5000 * 4))]);
		expect(await probe(bytes)).toEqual({
			codec: 'pcm-s16',
			channels: 2,
			duration: 0.625,
			packets: ['0+0.256:8192', '0.256+0.256:8192', '0.512+0.113:3616'],
		});
	});

	test.each([
		[1, 8, false, 'pcm-u8'],
		[1, 24, false, 'pcm-s24'],
		[1, 32, false, 'pcm-s32'],
		[3, 32, false, 'pcm-f32'],
		[3, 64, false, 'pcm-f64'],
		[6, 8, false, 'alaw'],
		[7, 8, false, 'ulaw'],
		[1, 24, true, 'pcm-s24'],
		[3, 32, true, 'pcm-f32'],
	])('format tag %i with %i bits (extensible: %s) reads as %s', async (formatTag, bits, extensible, codec) => {
		const data = riffChunk('data', new Uint8Array(100 * bits / 8));
		const bytes = waveFile([fmt(formatTag, 1, bits, extensible), data]);
		const info = await probe(bytes);
		expect(info.codec).toBe(codec);
		expect(info.packets).toEqual([`0+0.0125:${100 * bits / 8}`]);
	});

	test.each([
		[1, 12, 'Unsupported WAVE PCM bit depth (12)'],
		[3, 16, 'Unsupported WAVE float bit depth (16)'],
		[2, 4, 'Unsupported WAVE codec (format tag 2)'],
	])('format tag %i with %i bits is rejected', async (formatTag, bits, message) => {
		const bytes = waveFile([fmt(formatTag, 1, bits), riffChunk('data', new Uint8Array(100))]);
		await expect(probe(bytes)).rejects.toThrow(message);
	});

	test('missing fmt or data chunks are errors', async () => {
		await expect(probe(waveFile([riffChunk('data', new Uint8Array(40))]))).rejects.toThrow('missing "fmt " chunk');
		await expect(probe(waveFile([fmt(1, 2, 16)]))).rejects.toThrow('missing "data" chunk');
	});

	test('RF64 takes its sizes from ds64, which must come first', async () => {
		const ds64 = (riffSizeHigh: number, dataSizeHigh: number) => riffChunk(
			'ds64',
			concatBytes(u32le(672), u32le(riffSizeHigh), u32le(400), u32le(dataSizeHigh), u32le(0), u32le(0), u32le(0)),
		);
		const data = riffChunk('data', new Uint8Array(600), { size: 0xffffffff });
		const rf64 = (ds: Uint8Array) => waveFile([ds, fmt(1, 1, 16), data], { riff: 'RF64', size: 0xffffffff });
		expect((await probe(rf64(ds64(0, 0)))).packets).toEqual(['0+0.025:400']);
		// 64-bit sizes beyond the file are clamped to what is there
		expect((await probe(rf64(ds64(1, 1)))).packets).toEqual(['0+0.0375:600']);
		const withoutDs64 = waveFile([fmt(1, 1, 16), data], { riff: 'RF64' });
		await expect(probe(withoutDs64)).rejects.toThrow('First chunk must be "ds64"');
	});

	test('odd-sized chunks are padded, the data size is clamped to the file and to whole frames', async () => {
		const pcm = new Uint8Array(40);
		expect((await probe(waveFile([riffChunk('junk', [1, 2, 3]), fmt(1, 2, 16), riffChunk('data', pcm)]))).packets)
			.toEqual(['0+0.00125:40']);
		expect((await probe(waveFile([fmt(1, 2, 16), riffChunk('data', pcm, { size: 4000 })]))).packets)
			.toEqual(['0+0.00125:40']);
		expect((await probe(waveFile([fmt(1, 2, 16), riffChunk('data', new Uint8Array(42))]))).packets)
			.toEqual(['0+0.00125:40']);
	});

	test('LIST INFO chunks provide the metadata tags; other LIST types are ignored', async () => {
		const info = riffChunk('LIST', concatBytes(
			ascii('INFO'),
			riffChunk('INAM', [...ascii('Title'), 0]),
			riffChunk('IART', ascii('Artist')),
			riffChunk('IPRD', ascii('Album')),
			riffChunk('ITRK', ascii('3/10')),
			riffChunk('ICRD', ascii('2015-06-12')),
			riffChunk('IGNR', ascii('Genre')),
			riffChunk('ICMT', ascii('Comment')),
			riffChunk('TIT3', ascii('Description')),
		));
		const adtl = riffChunk('LIST', concatBytes(ascii('adtl'), riffChunk('INAM', ascii('Not a title'))));
		using input = openBytes(waveFile([fmt(1, 2, 16), adtl, info, riffChunk('data', new Uint8Array(40))]));
		expect(await input.getMetadataTags()).toMatchObject({
			title: 'Title',
			artist: 'Artist',
			album: 'Album',
			trackNumber: 3,
			tracksTotal: 10,
			date: new Date('2015-06-12T00:00:00Z'),
			genre: 'Genre',
			comment: 'Comment',
			description: 'Description',
		});
	});
});

describe('FLAC frame parsing', () => {
	const filler = (length: number) => new Array<number>(length).fill(0x11);
	const packetsOf = async (bytes: Uint8Array) => {
		using input = openBytes(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		const packets: string[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			const start = Math.round(packet.timestamp * 48000);
			packets.push(`${start}+${Math.round(packet.duration * 48000)}:${packet.byteLength}`);
		}
		return packets;
	};

	test('every block size code gives the right packet duration and header length', async () => {
		const codes: [number, number?][] = [[1], [2], [3], [8], [6, 100], [7, 1000], [12], [15]];
		const frames = codes.map(([blockSizeCode, uncommonBlockSize], num) => {
			return flacFrame({ num, blockSizeCode, uncommonBlockSize, sampleRateCode: 10, payload: filler(30) });
		});
		const bytes = flacFile({ sampleRate: 48000, minBlockSize: 16, maxBlockSize: 32768, totalSamples: 0, frames });
		expect(await packetsOf(bytes)).toEqual([
			'0+192:36', '192+576:36', '768+1152:36', '1920+256:36', '2176+100:37', '2276+1000:38', '3276+4096:36',
			'7372+32768:36',
		]);
	});

	test.each([
		[0, undefined, 26], // Sample rate from STREAMINFO
		[13, 48000, 28], // 16-bit Hz
		[14, 4800, 28], // 16-bit tens of Hz
	])('sample rate code %i is accepted when it matches STREAMINFO', async (sampleRateCode, uncommonRate, size) => {
		const frames = [0, 1, 2].map((num) => {
			const payload = filler(20);
			return flacFrame({ num, blockSizeCode: 8, sampleRateCode, uncommonSampleRate: uncommonRate, payload });
		});
		const bytes = flacFile({ sampleRate: 48000, minBlockSize: 256, maxBlockSize: 256, totalSamples: 768, frames });
		expect(await packetsOf(bytes)).toEqual([`0+256:${size}`, `256+256:${size}`, `512+256:${size}`]);
	});

	test('sync codes inside frame data only split frames when a whole, consistent header follows', async () => {
		const brokenCrc = [0xff, 0xf8, 0x8a, 0x08, 0x01, 0x00];
		const wrongNumber = flacFrame({ num: 5, blockSizeCode: 8, sampleRateCode: 10, payload: [] });
		const wrongRate = flacFrame({ num: 1, blockSizeCode: 8, sampleRateCode: 9, payload: [] });
		const otherBlocking = flacFrame({
			num: 1,
			variableBlocking: true,
			blockSizeCode: 8,
			sampleRateCode: 10,
			payload: [],
		});
		const frames = [
			flacFrame({
				num: 0,
				blockSizeCode: 8,
				sampleRateCode: 10,
				payload: [...filler(10), ...brokenCrc, ...filler(5), ...wrongNumber, ...wrongRate, ...otherBlocking],
			}),
			flacFrame({ num: 1, blockSizeCode: 8, sampleRateCode: 10, payload: filler(4) }),
			flacFrame({ num: 2, blockSizeCode: 8, sampleRateCode: 10, payload: filler(12) }),
		];
		const bytes = flacFile({ sampleRate: 48000, minBlockSize: 256, maxBlockSize: 256, totalSamples: 768, frames });
		expect(await packetsOf(bytes)).toEqual(['0+256:45', '256+256:10', '512+256:18']);
	});

	test('with variable blocking, frame headers carry sample numbers that must follow on', async () => {
		const frame = (num: number, uncommonBlockSize: number, payload: number[]) => flacFrame({
			num,
			variableBlocking: true,
			blockSizeCode: 7,
			uncommonBlockSize,
			sampleRateCode: 10,
			payload,
		});
		const fakeHeader = frame(999, 256, []);
		const frames = [
			frame(0, 1000, [...filler(8), ...fakeHeader, ...filler(4)]),
			frame(1000, 500, filler(20)),
			frame(1500, 2000, filler(20)),
		];
		const bytes = flacFile({
			sampleRate: 48000,
			minBlockSize: 256,
			maxBlockSize: 2000,
			totalSamples: 3500,
			frames,
		});
		expect(await packetsOf(bytes)).toEqual(['0+1000:29', '1000+500:29', '1500+2000:29']);
	});
});

describe('Fragmented MP4 track runs', () => {
	const sps = buildAvcSps({ profileIdc: 66, levelIdc: 30, widthInMbs: 20, heightInMapUnits: 15 });
	const pps = [0x68, 0xce, 0x3c, 0x80];
	const avcC = mp4Box('avcC', [1, 66, 0xc0, 30, 0xff, 0xe1], u16be(sps.length), sps, [1], u16be(pps.length), pps);
	const sampleEntry = mp4VisualEntry('avc1', 320, 240, avcC);
	const sample = (i: number, size = 6) => {
		const data = new Uint8Array(size);
		data.set([0, 0, 0, size - 4, 0x41, i]);
		return data;
	};
	const SYNC = 0x02000000;
	const NON_SYNC = 0x01010000;

	const read = async (bytes: Uint8Array) => {
		using input = openBytes(bytes);
		const track = (await input.getPrimaryVideoTrack())!;
		const packets: string[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			const [start, length] = [Math.round(packet.timestamp * 1000), Math.round(packet.duration * 1000)];
			packets.push(`${packet.data[5]}@${start}+${length}${packet.type[0]}`);
		}
		return { packets, duration: await track.computeDuration() };
	};

	test('per-sample fields, first sample flags and composition offsets across two fragments', async () => {
		const bytes = buildFragmentedMp4({
			handler: 'vide',
			timescale: 1000,
			sampleEntry,
			trex: { duration: 1, size: 1, flags: NON_SYNC },
			fragments: [0, 1].map(f => ({
				baseMediaDecodeTime: f * 400,
				tfdtVersion: f === 1 ? 1 as const : 0 as const,
				runs: [{
					sampleFields: { duration: true, size: true, flags: true, compositionOffset: true },
					firstSampleFlags: SYNC,
					samples: [
						// I P B B in decode order; signed offsets put the B frames before the P frame
						{ duration: 100, flags: NON_SYNC, compositionOffset: 0, data: sample(4 * f, 7) },
						{ duration: 100, flags: NON_SYNC, compositionOffset: 200, data: sample(4 * f + 1, 8) },
						{ duration: 100, flags: NON_SYNC, compositionOffset: -100, data: sample(4 * f + 2, 9) },
						{ duration: 100, flags: NON_SYNC, compositionOffset: -100, data: sample(4 * f + 3, 6) },
					],
				}],
			})),
		});
		const { packets } = await read(bytes);
		expect(packets).toEqual([
			'0@0+100k', '1@300+100d', '2@100+100d', '3@200+100d',
			'4@400+100k', '5@700+100d', '6@500+100d', '7@600+100d',
		]);
	});

	test('samples fall back to tfhd defaults, then to trex defaults', async () => {
		const run = (from: number, count: number): Mp4FragmentRun => ({
			sampleFields: {},
			samples: Array.from({ length: count }, (_, i) => ({ data: sample(from + i, 10) })),
		});
		const bytes = buildFragmentedMp4({
			handler: 'vide',
			timescale: 1000,
			sampleEntry,
			trex: { duration: 50, size: 10, flags: SYNC },
			fragmentDuration: 400,
			fragments: [
				{ baseMediaDecodeTime: 0, runs: [run(0, 2)] },
				// Two runs in one fragment, with fragment-level defaults
				{
					baseMediaDecodeTime: 100,
					defaults: { duration: 150, flags: NON_SYNC },
					runs: [run(2, 1), run(3, 1)],
				},
			],
		});
		const { packets } = await read(bytes);
		expect(packets).toEqual(['0@0+50k', '1@50+50k', '2@100+150d', '3@250+150d']);
	});

	test('zero trex values still count as defaults for fields a run leaves out', async () => {
		const bytes = buildFragmentedMp4({
			handler: 'vide',
			timescale: 1000,
			sampleEntry,
			trex: { duration: 0, size: 0, flags: 0 },
			fragments: [{
				baseMediaDecodeTime: 0,
				runs: [{ sampleFields: { duration: true, size: true }, samples: [{ duration: 10, data: sample(0) }] }],
			}],
		});
		expect((await read(bytes)).packets).toEqual(['0@0+10k']);
	});
});

describe('ISOBMFF MIME types and pssh boxes', () => {
	test.each([
		[
			{
				isQuickTime: false,
				hasVideo: true,
				hasAudio: true,
				codecStrings: ['avc1.42c01e', 'mp4a.40.2', 'mp4a.40.2'],
			},
			'video/mp4; codecs="avc1.42c01e, mp4a.40.2"',
		],
		[{ isQuickTime: false, hasVideo: false, hasAudio: true, codecStrings: ['opus'] }, 'audio/mp4; codecs="opus"'],
		[{ isQuickTime: true, hasVideo: true, hasAudio: false, codecStrings: [] }, 'video/quicktime'],
		[{ isQuickTime: true, hasVideo: false, hasAudio: true, codecStrings: [] }, 'audio/quicktime'],
		[{ isQuickTime: false, hasVideo: false, hasAudio: false, codecStrings: [] }, 'application/mp4'],
	])('buildIsobmffMimeType(%j) is %s', (info, expected) => {
		expect(buildIsobmffMimeType(info)).toBe(expected);
	});

	const systemId = Array.from({ length: 16 }, (_, i) => 0xe0 + i);
	const kid = (fill: number) => new Array<number>(16).fill(fill);
	const hex = (bytes: number[]) => bytes.map(b => b.toString(16).padStart(2, '0')).join('');

	test('parses version 0 and version 1 pssh contents', () => {
		const v0 = parsePsshBoxContents(new Uint8Array([0, 0, 0, 0, ...systemId, ...u32be(3), 7, 8, 9]));
		expect(v0).toEqual({ systemId: hex(systemId), keyIds: null, data: new Uint8Array([7, 8, 9]) });

		const v1 = parsePsshBoxContents(new Uint8Array([
			1, 0, 0, 0, ...systemId, ...u32be(2), ...kid(0x11), ...kid(0x22), ...u32be(2), 5, 6,
		]));
		expect(v1).toEqual({
			systemId: hex(systemId),
			keyIds: [hex(kid(0x11)), hex(kid(0x22))],
			data: new Uint8Array([5, 6]),
		});

		const noKeys = parsePsshBoxContents(new Uint8Array([1, 0, 0, 0, ...systemId, ...u32be(0), ...u32be(0)]));
		expect(noKeys).toEqual({ systemId: hex(systemId), keyIds: null, data: new Uint8Array(0) });
	});

	test('rejects pssh contents that are too small or claim too many key IDs', () => {
		expect(() => parsePsshBoxContents(new Uint8Array(23))).toThrow('too small');
		const tooManyKeys = new Uint8Array([1, 0, 0, 0, ...systemId, ...u32be(2), ...kid(1), ...u32be(0)]);
		expect(() => parsePsshBoxContents(tooManyKeys)).toThrow('key ID count exceeds box size');
	});

	test('pssh boxes differ when their system ID or data differ', () => {
		const box = { systemId: 'aa', keyIds: null, data: new Uint8Array([1, 2]) };
		expect(psshBoxesAreEqual(box, { ...box, data: new Uint8Array([1, 2]) })).toBe(true);
		expect(psshBoxesAreEqual(box, { ...box, data: new Uint8Array([1, 3]) })).toBe(false);
		expect(psshBoxesAreEqual(box, { ...box, systemId: 'ab' })).toBe(false);
	});
});
