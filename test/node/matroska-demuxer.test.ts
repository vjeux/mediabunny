import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
	ALL_FORMATS,
	BufferSource,
	CustomSource,
	EncodedPacket,
	EncodedPacketSink,
	FilePathSource,
	Input,
} from '../../src/index.js';
import { assert } from '../../src/misc.js';
import { EBMLId } from '../../src/matroska/ebml.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Zero-width unsigned integers', async () => {
	const filePath = path.join(__dirname, '..', 'public/zero-width-uint.webm');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	expect(await input.getTracks()).toHaveLength(1);
});

test('Zero timestamp scale', async () => {
	const filePath = path.join(__dirname, '..', 'public/zero-timestamp-scale.webm');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	await expect(input.getTracks()).rejects.toThrow(/TimestampScale/);
});

test('VP9 codec string follows the Colour element', async () => {
	// ffmpeg -f lavfi -i testsrc2=size=176x144:rate=25 -frames:v 1 -c:v libvpx-vp9 -deadline realtime
	//   -pix_fmt yuv420p10le -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc
	//   -fflags +bitexact out.webm
	const filePath = path.join(__dirname, '..', 'public/vp9-hdr10-pq.webm');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;

	// The bitstream only says BT.2020, the Colour element says that the transfer is PQ
	expect((await track.getDecoderConfig())!.colorSpace!.transfer).toBe('pq');
	expect(await track.getCodecParameterString()).toBe('vp09.02.10.10.01.09.16.09.00');
});

test('Concurrent metadata tag reads', async () => {
	const filePath = path.join(__dirname, '..', 'public/tags-after-clusters.webm');
	const buffer = await fs.promises.readFile(filePath);

	// Async reads, so that both calls are in the middle of loading the tags at the same time
	using input = new Input({
		source: new CustomSource({
			getSize: async () => buffer.byteLength,
			read: async (start, end) => buffer.subarray(start, end),
		}),
		formats: ALL_FORMATS,
	});

	const [first, second] = await Promise.all([input.getMetadataTags(), input.getMetadataTags()]);
	expect(first.title).toBe('Hi');
	expect(second.title).toBe('Hi');
});

test('Key packet lookup past position cache entries', async () => {
	// 0.5 s clusters with a key frame (and cue point) only every 10 s
	const filePath = path.join(__dirname, '..', 'public/sparse-keyframes-dense-clusters.mkv');
	const buffer = await fs.promises.readFile(filePath);

	let bytesRead = 0;
	using input = new Input({
		source: new CustomSource({
			getSize: () => buffer.byteLength,
			read: (start, end) => {
				bytesRead += end - start;
				return buffer.subarray(start, end);
			},
			maxCacheSize: Infinity,
		}),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	// Leaves the position cache with an entry at the start and dense entries from the cue point at 50 s up to 55.3 s
	await sink.getFirstPacket();
	await sink.getPacket(55.3);

	bytesRead = 0;
	const keyPacket = await sink.getKeyPacket(55.29);
	expect(keyPacket?.timestamp).toBe(50);
	expect(bytesRead).toBeLessThan(0.05 * buffer.byteLength);
});

test('getPacket finds the first block of a cluster that starts before the previous one ends', async () => {
	// 60 fps as FFmpeg writes it: millisecond timestamps rounded from multiples of 16.667 ms, a 16.667 ms
	// DefaultDuration, and (with long GOPs) clusters that begin mid-GOP. The last block of the first cluster, at 67 ms,
	// lasts until 83.667 ms (or 84 ms with a rounded DefaultDuration), past the next cluster's first block at 83 ms.

	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const matroskaFile = (...segmentChildren: number[][]) => new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, [...'matroska'].map(x => x.charCodeAt(0)))),
		...element(EBMLId.Segment, segmentChildren.flat()),
	]);

	const block = (timestamp: number, key = false) => element(
		EBMLId.SimpleBlock,
		[0x81, 0, timestamp, key ? 0x80 : 0, 1],
	);
	const file = matroskaFile(
		element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
		element(EBMLId.Tracks, element(
			EBMLId.TrackEntry,
			element(EBMLId.TrackNumber, [1]),
			element(EBMLId.TrackType, [1]),
			element(EBMLId.CodecID, [...'V_VP8'].map(x => x.charCodeAt(0))),
			element(EBMLId.DefaultDuration, [0x00, 0xfe, 0x50, 0x6b]), // 16,666,667 ns
			element(EBMLId.Video, element(EBMLId.PixelWidth, [16]), element(EBMLId.PixelHeight, [16])),
		)),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [0]),
			block(0, true), block(17), block(33), block(50), block(67),
		),
		element(EBMLId.Cluster, element(EBMLId.Timestamp, [83]), block(0), block(17)),
	);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	for (const timestamp of [0, 0.017, 0.033, 0.05, 0.067, 0.083, 0.1]) {
		const packet = await sink.getPacket(timestamp);
		expect(packet?.timestamp).toBe(timestamp);
	}
});

test('getPacket finds B-frames that straddle a cluster boundary', async () => {
	// Clusters cut mid-GOP, as FFmpeg does in live mode or at its cluster size/time limits: the first cluster ends
	// with the P frame at 120 ms, the B-frames presented before it (40, 80 ms) start the next cluster

	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const matroskaFile = (...segmentChildren: number[][]) => new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, [...'matroska'].map(x => x.charCodeAt(0)))),
		...element(EBMLId.Segment, segmentChildren.flat()),
	]);

	const block = (timestamp: number, key = false) => element(
		EBMLId.SimpleBlock,
		[0x81, (timestamp >> 8) & 0xff, timestamp & 0xff, key ? 0x80 : 0, 1],
	);
	const file = matroskaFile(
		element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
		element(EBMLId.Tracks, element(
			EBMLId.TrackEntry,
			element(EBMLId.TrackNumber, [1]),
			element(EBMLId.TrackType, [1]),
			element(EBMLId.CodecID, [...'V_VP8'].map(x => x.charCodeAt(0))),
			element(EBMLId.DefaultDuration, [0x02, 0x62, 0x5a, 0x00]), // 40 ms
			element(EBMLId.Video, element(EBMLId.PixelWidth, [16]), element(EBMLId.PixelHeight, [16])),
		)),
		element(EBMLId.Cluster, element(EBMLId.Timestamp, [0]), block(0, true), block(120)),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [40]),
			block(0), block(40), block(200), block(120), block(160),
		),
	);

	const timestamps = [0, 0.04, 0.08, 0.12, 0.16, 0.2, 0.24];
	for (const order of [timestamps, [...timestamps].reverse()]) {
		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const sink = new EncodedPacketSink(track);
		for (const timestamp of order) {
			expect((await sink.getPacket(timestamp))!.timestamp).toBe(timestamp);
		}
	}
});

test('Deprecated A_AAC codec IDs without CodecPrivate', async () => {
	// Old mkvmerge versions named the AAC profile in the codec ID and wrote no AudioSpecificConfig
	const element = (id: number[], ...parts: ArrayLike<number>[]) => {
		const content = parts.flatMap(part => Array.from(part));
		const size = [0x01, 0, 0, 0, 0, 0, content.length >> 8, content.length & 0xff]; // 8-byte vint
		return [...id, ...size, ...content];
	};
	const float64 = (value: number) => {
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setFloat64(0, value);
		return bytes;
	};
	const file = (codecId: string) => new Uint8Array([
		...element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], [...'matroska'].map(char => char.charCodeAt(0)))),
		...element([0x18, 0x53, 0x80, 0x67],
			element([0x16, 0x54, 0xae, 0x6b], element([0xae],
				element([0xd7], [1]), // TrackNumber
				element([0x83], [2]), // TrackType: audio
				element([0x86], [...codecId].map(char => char.charCodeAt(0))),
				element([0xe1], element([0xb5], float64(22050)), element([0x9f], [2])), // 22.05 kHz, stereo
			)),
			element([0x1f, 0x43, 0xb6, 0x75], element([0xe7], [0]), element([0xa3], [0x81, 0, 0, 0x80, 0x21, 0x10])),
		),
	]);

	const expectations = [
		['A_AAC/MPEG4/LC/SBR', 'mp4a.40.5'],
		['A_AAC/MPEG4/LC', 'mp4a.40.2'],
		['A_AAC/MPEG4/MAIN', 'mp4a.40.1'],
		['A_AAC/MPEG4/LTP', 'mp4a.40.4'],
		['A_AAC/MPEG2/LC', 'mp4a.67'],
	];
	for (const [codecId, codecString] of expectations) {
		using input = new Input({ source: new BufferSource(file(codecId!)), formats: ALL_FORMATS });
		const track = (await input.getAudioTracks())[0];
		assert(track);

		expect(await track.getCodec()).toBe('aac');
		expect(await track.getCodecParameterString()).toBe(codecString);
		expect(await input.getMimeType()).toBe(`audio/x-matroska; codecs="${codecString}"`);
	}
});

test('Laced Vorbis frames get their own durations', async () => {
	// Vorbis at 8 kHz with 256/2048-sample blocks, one tick per sample. A frame lasts (previous block size + its own
	// block size) / 4 samples: 128 for short after short, 576 for a short and a long block, 1024 for long after long.

	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const matroskaFile = (...segmentChildren: number[][]) => new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, [...'matroska'].map(x => x.charCodeAt(0)))),
		...element(EBMLId.Segment, segmentChildren.flat()),
	]);

	const ascii = (text: string) => [...text].map(x => x.charCodeAt(0));
	const identificationHeader = [
		1, ...ascii('vorbis'), 0, 0, 0, 0, 1, 0x40, 0x1f, 0, 0, // Version 0, mono, 8000 Hz
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // Bitrates
		0xb8, 1, // Block sizes 2^8 and 2^11, framing bit
	];
	const commentHeader = [3, ...ascii('vorbis'), 0, 0, 0, 0, 0, 0, 0, 0, 1];
	// Ends with two modes: mode 0 uses short blocks, mode 1 long ones
	const setupHeader = [5, ...ascii('vorbis'), 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0x80, 0, 0, 0, 0, 0, 1];

	const SHORT = 0x00; // Mode 0
	const LONG_AFTER_SHORT = 0x02; // Mode 1, previous window flag clear
	const LONG_AFTER_LONG = 0x06; // Mode 1, previous window flag set

	const block = (relativeTimestamp: number, frames: number[]) => element(EBMLId.SimpleBlock, [
		0x81, relativeTimestamp >> 8, relativeTimestamp & 0xff,
		...(frames.length > 1
			? [0x80 | 0x02, frames.length - 1, ...frames.slice(0, -1).map(() => 2)] // Xiph lacing, 2-byte frames
			: [0x80]),
		...frames.flatMap(x => [x, 0xaa]),
	]);

	const file = matroskaFile(
		element(EBMLId.Info, element(EBMLId.TimestampScale, [0x01, 0xe8, 0x48])), // 125 us = 1 sample
		element(EBMLId.Tracks, element(
			EBMLId.TrackEntry,
			element(EBMLId.TrackNumber, [1]),
			element(EBMLId.TrackType, [2]),
			element(EBMLId.CodecID, ascii('A_VORBIS')),
			element(EBMLId.CodecPrivate, [
				2, identificationHeader.length, commentHeader.length,
				...identificationHeader, ...commentHeader, ...setupHeader,
			]),
			element(EBMLId.Audio, element(EBMLId.SamplingFrequency, [0x45, 0xfa, 0, 0]), element(EBMLId.Channels, [1])),
		)),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [0]),
			block(0, [SHORT, LONG_AFTER_SHORT, LONG_AFTER_LONG, SHORT]), // 128 + 576 + 1024 + 576 samples
			block(2304, [LONG_AFTER_SHORT]),
		),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [0x0b, 0x40]), // 2880
			// The first frame follows a long block from the previous cluster, so it lasts 576 samples. The frames'
			// 704 samples don't fit before the next block (some muxers round timestamps so that blocks overlap), so
			// they're squeezed into its 600, keeping the timestamps in order.
			block(0, [SHORT, SHORT]),
			// The cluster's last block has no BlockDuration: its frames last as long as they say (384 samples), but
			// not past the next cluster 168 samples later, so they're squeezed too
			block(600, [SHORT, SHORT, SHORT]),
		),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [0x0e, 0x40]), // 3648
			block(0, [SHORT, SHORT]), // At the end of the file, the frames last as long as they say
		),
	);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	expect(packets.map(x => x.timestamp * 8000)).toEqual([
		0, 128, 704, 1728, 2304, // First cluster
		2880, 3370, 3480, 3536, 3592, // Second cluster
		3648, 3776, // Last cluster
	]);
	expect(packets.slice(0, 4).map(x => x.duration * 8000)).toEqual([128, 576, 1024, 576]);
	expect(packets.slice(5).map(x => x.duration * 8000)).toEqual([490, 110, 56, 56, 56, 128, 128]);
});

test('Laced Opus frames at the end of a cluster get their own durations', async () => {
	// The last block of a cluster without BlockDuration or DefaultDuration (as in Firefox's and mkvmerge's files) used
	// to give all its frames the block's timestamp and duration 0. Opus frames tell their own duration.
	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const ascii = (text: string) => [...text].map(x => x.charCodeAt(0));
	const opus20ms = [0xfc, 0xff];
	const opus60ms = [0x18, 0xff];
	const lace = (relativeTimestamp: number, frames: number[][]) => element(EBMLId.SimpleBlock, [
		0x81, 0, relativeTimestamp, 0x80 | 0x02, // Key frame, Xiph lacing
		frames.length - 1, ...frames.slice(0, -1).map(x => x.length),
		...frames.flat(),
	]);

	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('webm'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [2]),
				element(EBMLId.CodecID, ascii('A_OPUS')),
				element(EBMLId.CodecPrivate, [...ascii('OpusHead'), 1, 2, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0]),
			)),
			// 100 ms of frames, which fit before the next cluster
			element(EBMLId.Cluster, element(EBMLId.Timestamp, [0]), lace(0, [opus20ms, opus20ms, opus60ms])),
			// 80 ms of frames, but the next cluster starts 50 ms later, so they're squeezed to fit
			element(
				EBMLId.Cluster,
				element(EBMLId.Timestamp, [100]),
				lace(0, [opus20ms, opus20ms, opus20ms, opus20ms]),
			),
			// FFmpeg writes a CRC-32 before the Timestamp
			element(
				EBMLId.Cluster,
				element(0xbf, [0, 0, 0, 0]),
				element(EBMLId.Timestamp, [150]),
				element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, ...opus20ms]),
			),
		),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	expect(packets.map(x => x.timestamp)).toEqual([0, 0.02, 0.04, 0.1, 0.112, 0.125, 0.137, 0.15]);
	expect(packets.slice(0, 7).map(x => x.duration)).toEqual([0.02, 0.02, 0.06, 0.012, 0.013, 0.012, 0.013]);
});

test('EBML header with Void padding or a DocTypeExtension', async () => {
	// Both may be larger than the 8 bytes an integer element can have

	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const ascii = (text: string) => [...text].map(x => x.charCodeAt(0));
	const docTypeExtension = element(
		0x4281, // DocTypeExtension
		element(0x4283, ascii('extension-name')), // DocTypeExtensionName
		element(0x4284, [1]), // DocTypeExtensionVersion
	);

	for (const extra of [element(EBMLId.Void, new Array<number>(16).fill(0)), docTypeExtension]) {
		const file = new Uint8Array([
			...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska')), extra),
			...element(EBMLId.Segment, element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [2]),
				element(EBMLId.CodecID, ascii('A_AC3')),
			))),
		]);

		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});

		expect(await input.getTracks()).toHaveLength(1);
	}
});
