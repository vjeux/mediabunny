import { describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EBMLId } from '../../src/matroska/ebml.js';
import {
	adtsFrame,
	ascii,
	buildAvcSps,
	buildMp4,
	concatBytes,
	ebml,
	ebmlFloat,
	ebmlString,
	ebmlUint,
	id3v24Tag,
	mkvFile,
	mkvSimpleBlock,
	mp4Box,
	mp4FullBox,
	mp4IlstItem,
	mp4MdtaMeta,
	mp4SoundEntry,
	mp4SoundEntryV2,
	mp4VisualEntry,
	u16be,
	u32be,
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
