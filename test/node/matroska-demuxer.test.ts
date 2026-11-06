import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	CustomSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	MATROSKA,
	MkvOutputFormat,
	Output,
	WebMOutputFormat,
} from '../../src/index.js';
import { assert, toUint8Array } from '../../src/misc.js';
import { EBMLId } from '../../src/matroska/ebml.js';
import { parseAacAudioSpecificConfig } from '../../shared/aac-misc.js';

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

	const simpleBlock = (timestamp: number, key = false) => element(
		EBMLId.SimpleBlock,
		[0x81, (timestamp >> 8) & 0xff, timestamp & 0xff, key ? 0x80 : 0, 1],
	);
	// A BlockGroup declaring a 40 ms BlockDuration; non-key frames reference another frame
	const blockGroup = (timestamp: number, key = false) => element(
		EBMLId.BlockGroup,
		element(EBMLId.Block, [0x81, (timestamp >> 8) & 0xff, timestamp & 0xff, 0, 1]),
		element(EBMLId.BlockDuration, [40]),
		key ? [] : element(EBMLId.ReferenceBlock, [0xd8]), // -40
	);

	const makeFile = (defaultDuration: number[][], block: typeof simpleBlock) => matroskaFile(
		element(EBMLId.Info, element(EBMLId.TimestampScale, [0x0f, 0x42, 0x40])),
		element(EBMLId.Tracks, element(
			EBMLId.TrackEntry,
			element(EBMLId.TrackNumber, [1]),
			element(EBMLId.TrackType, [1]),
			element(EBMLId.CodecID, [...'V_MPEG4/ISO/AVC'].map(x => x.charCodeAt(0))),
			...defaultDuration,
			element(EBMLId.Video, element(EBMLId.PixelWidth, [16]), element(EBMLId.PixelHeight, [16])),
		)),
		element(EBMLId.Cluster, element(EBMLId.Timestamp, [0]), block(0, true), block(120)),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [40]),
			block(0), block(40), block(200), block(120), block(160),
		),
	);

	const files = [
		makeFile([element(EBMLId.DefaultDuration, [0x02, 0x62, 0x5a, 0x00])], simpleBlock), // 40 ms
		makeFile([], simpleBlock), // DefaultDuration is optional
		// A nominal DefaultDuration of 120 ms, which the blocks' own BlockDurations of 40 ms override
		makeFile([element(EBMLId.DefaultDuration, [0x07, 0x27, 0x0e, 0x00])], blockGroup),
	];

	const checkLookups = async (file: Uint8Array, order: number[]) => {
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
	};

	const timestamps = [0, 0.04, 0.08, 0.12, 0.16, 0.2, 0.24];
	for (const file of files) {
		await checkLookups(file, timestamps);
		await checkLookups(file, [...timestamps].reverse());
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
	const file = (codecId: string, outputSamplingFrequency: number | null = null) => new Uint8Array([
		...element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], [...'matroska'].map(char => char.charCodeAt(0)))),
		...element([0x18, 0x53, 0x80, 0x67],
			element([0x16, 0x54, 0xae, 0x6b], element([0xae],
				element([0xd7], [1]), // TrackNumber
				element([0x83], [2]), // TrackType: audio
				element([0x86], [...codecId].map(char => char.charCodeAt(0))),
				element([0xe1],
					element([0xb5], float64(22050)), // SamplingFrequency
					...(outputSamplingFrequency === null
						? []
						: [element([0x78, 0xb5], float64(outputSamplingFrequency))]), // OutputSamplingFrequency
					element([0x9f], [2]), // Channels: stereo
				),
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

	// SamplingFrequency is the core coder's rate, and OutputSamplingFrequency (defaulting to it) the rate after SBR
	const rates = [
		// Codec ID, OutputSamplingFrequency, expected core rate, expected output rate
		['A_AAC/MPEG4/LC', 22050, 22050, 22050],
		['A_AAC/MPEG4/LC/SBR', 44100, 22050, 44100],
		['A_AAC/MPEG4/LC/SBR', 22050, 22050, 22050], // Downsampled SBR
		['A_AAC/MPEG4/LC/SBR', null, 22050, 22050],
	] as const;
	for (const [codecId, outputSamplingFrequency, coreSampleRate, outputSampleRate] of rates) {
		using input = new Input({
			source: new BufferSource(file(codecId, outputSamplingFrequency)),
			formats: ALL_FORMATS,
		});
		const track = (await input.getAudioTracks())[0];
		assert(track);

		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig?.description);
		const audioSpecificConfig = parseAacAudioSpecificConfig(toUint8Array(decoderConfig.description));
		expect(audioSpecificConfig.coreSampleRate).toBe(coreSampleRate);
		expect(audioSpecificConfig.outputSampleRate).toBe(outputSampleRate);
		expect(decoderConfig.sampleRate).toBe(outputSampleRate);
		expect(await track.getSampleRate()).toBe(outputSampleRate);
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

	const readTimings = async (...clusters: number[][]) => {
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
				...clusters,
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

		// The duration of the last packet, an unlaced block at the end of the file, isn't what's tested here
		return packets.map((x, i) => [x.timestamp, i === packets.length - 1 ? null : x.duration]);
	};

	expect(await readTimings(
		// 100 ms of frames, which fit before the track's next block
		element(EBMLId.Cluster, element(EBMLId.Timestamp, [0]), lace(0, [opus20ms, opus20ms, opus60ms])),
		// 80 ms of frames, but the track's next block starts 50 ms later, so they're squeezed to fit
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
	)).toEqual([
		[0, 0.02], [0.02, 0.02], [0.04, 0.06],
		[0.1, 0.012], [0.112, 0.013], [0.125, 0.012], [0.137, 0.013],
		[0.15, null],
	]);

	// The next cluster's timestamp only serves as the base of its blocks' relative timestamps, so it's the track's
	// next block, not the cluster's start, that bounds the lace (here 70 ms after the base, as when the next cluster
	// starts with another track's block)
	expect(await readTimings(
		element(EBMLId.Cluster, element(EBMLId.Timestamp, [0]), lace(0, [opus20ms, opus20ms, opus20ms])),
		element(
			EBMLId.Cluster,
			element(EBMLId.Timestamp, [30]),
			element(EBMLId.SimpleBlock, [0x81, 0, 70, 0x80, ...opus20ms]),
		),
	)).toEqual([[0, 0.02], [0.02, 0.02], [0.04, 0.02], [0.1, null]]);
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

test('TrackType after the Video or Audio element', async () => {
	// Element order within a TrackEntry is free

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
	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		...element(EBMLId.Segment, element(
			EBMLId.Tracks,
			element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.Video, element(EBMLId.PixelWidth, [0x01, 0x40]), element(EBMLId.PixelHeight, [0xf0])),
				element(EBMLId.CodecID, ascii('V_VP8')),
				element(EBMLId.TrackType, [1]),
			),
			element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [2]),
				element(
					EBMLId.Audio,
					element(EBMLId.SamplingFrequency, [0x47, 0x3b, 0x80, 0]), // 48000
					element(EBMLId.Channels, [2]),
				),
				element(EBMLId.CodecID, ascii('A_AC3')),
				element(EBMLId.TrackType, [2]),
			),
		)),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getCodedWidth()).toBe(320);
	expect(await videoTrack.getCodedHeight()).toBe(240);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getSampleRate()).toBe(48000);
	expect(await audioTrack.getNumberOfChannels()).toBe(2);
});

test('Nested SimpleTags', async () => {
	// Nested SimpleTags describe their parent, as in the Matroska tagging examples

	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const utf8 = (text: string) => [...new TextEncoder().encode(text)];
	const simpleTag = (...children: number[][]) => element(EBMLId.SimpleTag, ...children);
	const tagName = (name: string) => element(EBMLId.TagName, utf8(name));
	const tagString = (value: string) => element(EBMLId.TagString, utf8(value));

	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, utf8('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [2]),
				element(EBMLId.CodecID, utf8('A_AC3')),
			)),
			element(EBMLId.Tags, element(
				EBMLId.Tag,
				element(EBMLId.Targets, element(EBMLId.TargetTypeValue, [50])),
				simpleTag(
					tagName('ARTIST'),
					simpleTag(tagName('SORT_WITH'), tagString('Beatles, The')),
					tagString('The Beatles'),
				),
				simpleTag(tagName('ORIGINAL'), simpleTag(tagName('TITLE'), tagString('Original title'))),
				simpleTag(tagName('TITLE'), tagString('Title')),
				// Element order within a SimpleTag is free: the nested tag and the value may come before the name
				simpleTag(
					simpleTag(tagName('SORT_WITH'), tagString('Brel, Jacques')),
					tagString('Jacques Brel'),
					tagName('COMPOSER'),
				),
				simpleTag(tagString('Some album'), tagName('ALBUM')),
			)),
		),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const tags = await input.getMetadataTags();
	expect(tags.artist).toBe('The Beatles');
	expect(tags.title).toBe('Title');
	expect(tags.album).toBe('Some album');
	expect(tags.raw).toMatchObject({
		'ARTIST/SORT_WITH': 'Beatles, The',
		'ORIGINAL/TITLE': 'Original title',
		'COMPOSER': 'Jacques Brel',
		'COMPOSER/SORT_WITH': 'Brel, Jacques',
	});
});

test('BlockGroup children before the Block', async () => {
	// Element order within a BlockGroup is free

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
	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [1]),
				element(EBMLId.CodecID, ascii('V_VP8')),
				element(
					EBMLId.Video,
					element(EBMLId.PixelWidth, [16]),
					element(EBMLId.PixelHeight, [16]),
					element(EBMLId.AlphaMode, [1]),
				),
			)),
			element(
				EBMLId.Cluster,
				element(EBMLId.Timestamp, [0]),
				element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, 1]),
				element(
					EBMLId.BlockGroup,
					element(EBMLId.BlockDuration, [25]),
					element(EBMLId.ReferenceBlock, [0xd8]), // -40
					element(EBMLId.BlockAdditions, element(
						EBMLId.BlockMore,
						element(EBMLId.BlockAddID, [1]),
						element(EBMLId.BlockAdditional, [9, 9]),
					)),
					element(EBMLId.Block, [0x81, 0, 40, 0, 2]),
				),
			),
		),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	expect(packets.map(x => [x.timestamp, x.duration, x.type])).toEqual([[0, 0.04, 'key'], [0.04, 0.025, 'delta']]);
	expect([...packets[1]!.sideData.alpha!]).toEqual([9, 9]);
});

test('Tag with Targets after its SimpleTags', async () => {
	// Element order within a Tag is free; these tags apply to the track, not to the movie

	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const utf8 = (text: string) => [...new TextEncoder().encode(text)];
	const title = (value: string) => element(
		EBMLId.SimpleTag,
		element(EBMLId.TagName, utf8('TITLE')),
		element(EBMLId.TagString, utf8(value)),
	);
	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, utf8('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackUID, [1]),
				element(EBMLId.TrackType, [2]),
				element(EBMLId.CodecID, utf8('A_AC3')),
			)),
			element(
				EBMLId.Tags,
				element(
					EBMLId.Tag,
					title('Track'),
					element(EBMLId.Targets, element(EBMLId.TagTrackUID, [1])),
				),
				element(
					EBMLId.Tag,
					title('Movie'),
					element(EBMLId.Targets, element(EBMLId.TargetTypeValue, [50])),
				),
			),
		),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	expect((await input.getMetadataTags()).title).toBe('Movie');
});

test('Last block of a cluster without BlockDuration or DefaultDuration (Opus, PCM)', async () => {
	// As in Chrome's MediaRecorder files: no DefaultDuration, so each cluster's last block has no next block to take
	// its duration from. Opus and PCM packets tell their own duration.

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
	const block = (track: number, relativeTimestamp: number, data: number[]) => element(
		EBMLId.SimpleBlock,
		[0x80 | track, 0, relativeTimestamp, 0x80, ...data],
	);
	const opusHead = [...ascii('OpusHead'), 1, 1, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0];
	const opus20ms = [0xfc, 0xff]; // CELT, 20 ms
	const opus60ms = [0x18, 0xff]; // SILK, 60 ms

	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('webm'))),
		...element(
			EBMLId.Segment,
			element(
				EBMLId.Tracks,
				element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, ascii('A_OPUS')),
					element(EBMLId.CodecPrivate, opusHead),
				),
				element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [2]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, ascii('A_PCM/INT/LIT')),
					element(EBMLId.Audio, element(EBMLId.BitDepth, [16])), // 8000 Hz mono by default
				),
			),
			element(
				EBMLId.Cluster,
				element(EBMLId.Timestamp, [0]),
				block(1, 0, opus20ms),
				block(1, 20, opus20ms),
				block(2, 0, new Array<number>(80).fill(0)), // 40 samples = 5 ms
				block(2, 5, new Array<number>(80).fill(0)),
			),
			element(EBMLId.Cluster, element(EBMLId.Timestamp, [40]), block(1, 0, opus60ms)),
		),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const [opusTrack, pcmTrack] = await input.getAudioTracks();
	assert(opusTrack && pcmTrack);

	const durations = async (track: typeof opusTrack) => {
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		return packets.map(x => x.duration);
	};

	expect(await durations(opusTrack)).toEqual([0.02, 0.02, 0.06]);
	expect(await durations(pcmTrack)).toEqual([0.005, 0.005]);
	expect(await opusTrack.computeDuration()).toBe(0.1);
});

test('Cluster without a Timestamp', async () => {
	// Timestamp is mandatory in a Cluster; a broken file without it should read as if it were 0

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
	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [2]),
				element(EBMLId.CodecID, ascii('A_AC3')),
			)),
			element(
				EBMLId.Cluster,
				element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, 1]),
				element(EBMLId.SimpleBlock, [0x81, 0, 32, 0x80, 2]),
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

	expect(packets.map(x => x.timestamp)).toEqual([0, 0.032]);
});

test('Unknown-size Cues and cue points', async () => {
	// Livestreamed WebM, as written by browsers (Chromium's media/test/data/bear-320x240-live.webm): the clusters, the
	// Cues and every CuePoint inside it have an unknown size
	const element = (id: number[], ...parts: ArrayLike<number>[]) => {
		const content = parts.flatMap(part => Array.from(part));
		const size = [0x01, 0, 0, 0, 0, 0, content.length >> 8, content.length & 0xff]; // 8-byte vint
		return [...id, ...size, ...content];
	};
	const unknownSizeElement = (id: number[], ...parts: ArrayLike<number>[]) => {
		return [...id, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...parts.flatMap(part => Array.from(part))];
	};
	const cluster = (timestamp: number) => unknownSizeElement(
		[0x1f, 0x43, 0xb6, 0x75],
		element([0xe7], [timestamp]),
		element([0xa3], [0x81, 0, 0, 0x80, 0x10, 0x02, 0x00]), // SimpleBlock: track 1, key frame
	);
	const bytes = new Uint8Array([
		...element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], [...'webm'].map(char => char.charCodeAt(0)))),
		...unknownSizeElement([0x18, 0x53, 0x80, 0x67],
			element([0x15, 0x49, 0xa9, 0x66], element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40])), // 1 ms ticks
			element([0x16, 0x54, 0xae, 0x6b], element([0xae],
				element([0xd7], [1]), // TrackNumber
				element([0x83], [1]), // TrackType: video
				element([0x86], [...'V_VP8'].map(char => char.charCodeAt(0))),
				element([0xe0], element([0xb0], [16]), element([0xba], [16])),
			)),
			cluster(0),
			cluster(40),
			unknownSizeElement([0x1c, 0x53, 0xbb, 0x6b], unknownSizeElement(
				[0xbb],
				element([0xb3], [0]), // CueTime
				unknownSizeElement([0xb7], element([0xf7], [1]), element([0xf1], [0])),
			)),
		),
	]);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual([0, 0.04]);
	expect((await sink.getPacket(Infinity))!.timestamp).toBe(0.04);
});

test('Official Matroska tag names for the date and the track total', async () => {
	// The Matroska tagging spec names the dates DATE_RELEASED, DATE_RECORDED, ... and the track total TOTAL_PARTS

	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const utf8 = (text: string) => [...new TextEncoder().encode(text)];
	const simpleTag = (name: string, value: string) => element(
		EBMLId.SimpleTag,
		element(EBMLId.TagName, utf8(name)),
		element(EBMLId.TagString, utf8(value)),
	);

	const fileWithTags = (...simpleTags: number[][]) => new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, utf8('matroska'))),
		...element(
			EBMLId.Segment,
			element(EBMLId.Tracks, element(
				EBMLId.TrackEntry,
				element(EBMLId.TrackNumber, [1]),
				element(EBMLId.TrackType, [2]),
				element(EBMLId.CodecID, utf8('A_AC3')),
			)),
			element(EBMLId.Tags, element(
				EBMLId.Tag,
				element(EBMLId.Targets, element(EBMLId.TargetTypeValue, [50])),
				...simpleTags,
			)),
		),
	]);

	const readTags = async (file: Uint8Array) => {
		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});

		return await input.getMetadataTags();
	};

	const released = await readTags(fileWithTags(
		simpleTag('DATE_RELEASED', '2019-05-01'),
		simpleTag('TOTAL_PARTS', '12'),
	));
	expect(released.date).toEqual(new Date('2019-05-01'));
	expect(released.tracksTotal).toBe(12);

	const recorded = await readTags(fileWithTags(simpleTag('DATE_RECORDED', '2018-02-03')));
	expect(recorded.date).toEqual(new Date('2018-02-03'));
});

test('Files are read whenever their read versions are supported, whatever their versions', async () => {
	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(8), 'key', 0, 1), {
		decoderConfig: { codec: 'vp8', codedWidth: 64, codedHeight: 64 },
	});
	await output.finalize();

	// Sets a one-byte value of the EBML header
	const withHeaderValue = (id: number[], value: number) => {
		const bytes = new Uint8Array(output.target.buffer!);
		const index = bytes.findIndex((_, i) => id.every((byte, j) => bytes[i + j] === byte) && bytes[i + 2] === 0x81);
		bytes[index + 3] = value;
		return bytes;
	};

	const canRead = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return await input.canRead() && await input.getFormat() === MATROSKA && (await input.getTracks()).length === 1;
	};

	// mkvmerge sets DocTypeVersion 5 when it writes Matroska v5 elements (like edition names) but leaves
	// DocTypeReadVersion at 2, since players don't need them. Readers of v4 must read such files (RFC 9559, Section 7).
	expect(await canRead(withHeaderValue([0x42, 0x87], 5))).toBe(true); // DocTypeVersion
	expect(await canRead(withHeaderValue([0x42, 0x86], 2))).toBe(true); // EBMLVersion
	expect(await canRead(withHeaderValue([0x42, 0x85], 5))).toBe(false); // DocTypeReadVersion
	expect(await canRead(withHeaderValue([0x42, 0xf7], 2))).toBe(false); // EBMLReadVersion
});

test('Blocks last their BlockDuration or the DefaultDuration, not until the next block', async () => {
	// Mediabunny itself writes a BlockGroup with a BlockDuration for every frame of a video with alpha, and a
	// DefaultDuration for a track with a frame rate
	const readBackDurations = async (timestamps: number[], options: { alpha?: boolean; frameRate?: number }) => {
		const target = new BufferTarget();
		const output = new Output({ format: new WebMOutputFormat(), target });
		const source = new EncodedVideoPacketSource('vp8');
		output.addVideoTrack(source, options.frameRate === undefined ? {} : { frameRate: options.frameRate });
		await output.start();
		for (const [i, timestamp] of timestamps.entries()) {
			const data = new Uint8Array(i === 0
				? [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x10, 0x00, 0x10, 0x00] // VP8 key frame header, 16x16
				: [0x11, 0x02]);
			const sideData = options.alpha ? { alpha: data } : undefined;
			await source.add(
				new EncodedPacket(data, i === 0 ? 'key' : 'delta', timestamp, 1 / 30, -1, undefined, sideData),
				{ decoderConfig: { codec: 'vp8', codedWidth: 16, codedHeight: 16 } },
			);
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const durations: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			durations.push(packet.duration);
		}
		return durations;
	};

	// The frame before the gap used to last 134 ms, until the next frame, despite its BlockDuration of 33 ms
	const withGap = await readBackDurations([0, 0.033, 0.066, 0.2, 0.233], { alpha: true });
	expect(withGap.map(duration => Math.round(duration * 1000))).toEqual([33, 33, 33, 33, 33]);

	// The millisecond timestamps of 30 fps video used to give durations of 33 and 34 ms instead of the DefaultDuration
	const constantRate = await readBackDurations([0, 1, 2, 3, 4].map(i => i / 30), { frameRate: 30 });
	for (const duration of constantRate.slice(0, -1)) {
		expect(duration).toBeCloseTo(1 / 30, 6);
	}
});

// Builders for hand-made Matroska files. Every element gets an 8-byte size.
const mkvElement = (id: number[], ...parts: (number[] | Uint8Array)[]) => {
	const size = parts.reduce((sum, part) => sum + part.length, 0);
	const sizeBytes = [0x01, 0, 0, 0, size >>> 24, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff];
	return [...id, ...sizeBytes, ...parts.flatMap(part => [...part])];
};
const mkvUint = (id: number[], value: number) => mkvElement(
	id,
	[value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff],
);
const mkvAscii = (text: string) => [...text].map(char => char.charCodeAt(0));
/** A Matroska file with a 1 ms timestamp scale. */
const buildMkv = (tracks: number[][], clusters: number[][]) => new Uint8Array([
	...mkvElement([0x1a, 0x45, 0xdf, 0xa3], mkvElement([0x42, 0x82], mkvAscii('matroska'))), // EBML header
	...mkvElement(
		[0x18, 0x53, 0x80, 0x67], // Segment
		mkvElement([0x15, 0x49, 0xa9, 0x66], mkvUint([0x2a, 0xd7, 0xb1], 1_000_000)), // Info with TimestampScale
		mkvElement([0x16, 0x54, 0xae, 0x6b], ...tracks), // Tracks
		...clusters,
	),
]);

test('Laced blocks spread their frames over the gap to the next block', async () => {
	// As in a broadcast recording remuxed to MKV: eight audio frames of 32 ms per block, blocks 256 ms apart, and a
	// DefaultDuration of 192 ms that can't be the duration of each frame. The frames must stay 32 ms apart instead of
	// following the DefaultDuration into the next block.
	const frameSize = 512; // 32 ms of 16-bit mono PCM at 8 kHz
	const lacedBlock = (relativeTimestamp: number) => mkvElement(
		[0xa3], // SimpleBlock
		[0x81, relativeTimestamp >> 8, relativeTimestamp & 0xff, 0x84, 8 - 1], // Track 1, key frame, fixed-size lacing
		new Uint8Array(8 * frameSize),
	);
	const bytes = buildMkv(
		[mkvElement(
			[0xae], // TrackEntry
			mkvUint([0xd7], 1),
			mkvUint([0x73, 0xc5], 1),
			mkvUint([0x83], 2),
			mkvElement([0x86], mkvAscii('A_PCM/INT/LIT')),
			mkvUint([0x23, 0xe3, 0x83], 192_000_000), // DefaultDuration
			mkvElement(
				[0xe1], // Audio
				mkvElement([0xb5], [0x40, 0xbf, 0x40, 0, 0, 0, 0, 0]), // SamplingFrequency 8000
				mkvUint([0x9f], 1), // Channels
				mkvUint([0x62, 0x64], 16), // BitDepth
			),
		)],
		[mkvElement([0x1f, 0x43, 0xb6, 0x75], mkvUint([0xe7], 0), lacedBlock(0), lacedBlock(256), lacedBlock(512))],
	);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packets: [number, number][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([Math.round(packet.timestamp * 1000), Math.round(packet.duration * 1000)]);
	}
	expect(packets.slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, i) => [32 * i, 32]));
});

test('A BlockDuration of 0 is the block\'s duration, not a missing one', async () => {
	// Only an absent BlockDuration is inferred, from the DefaultDuration or the next block (RFC 9559). Chromium also
	// takes 0 as the duration.
	const videoTrack = (trackNumber: number, ...extra: number[][]) => mkvElement(
		[0xae], // TrackEntry
		mkvUint([0xd7], trackNumber),
		mkvUint([0x73, 0xc5], trackNumber),
		mkvUint([0x83], 1),
		mkvElement([0x86], mkvAscii('V_VP8')),
		mkvElement([0xe0], mkvUint([0xb0], 16), mkvUint([0xba], 16)), // Video: 16x16
		...extra,
	);
	const blockGroup = (trackNumber: number, relativeTimestamp: number, blockDuration: number | null) => mkvElement(
		[0xa0], // BlockGroup
		mkvElement([0xa1], [0x80 | trackNumber, relativeTimestamp >> 8, relativeTimestamp & 0xff, 0, 0]), // Block
		...(blockDuration === null ? [] : [mkvUint([0x9b], blockDuration)]), // BlockDuration
	);
	const bytes = buildMkv(
		[videoTrack(1), videoTrack(2, mkvUint([0x23, 0xe3, 0x83], 10_000_000))], // Track 2: DefaultDuration 10 ms
		[mkvElement(
			[0x1f, 0x43, 0xb6, 0x75], // Cluster
			mkvUint([0xe7], 0),
			blockGroup(1, 0, 0),
			blockGroup(1, 20, 1),
			blockGroup(1, 40, 0),
			blockGroup(2, 0, 0),
			blockGroup(2, 20, null),
			blockGroup(2, 40, 0),
		)],
	);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const durations: Record<number, number[]> = {};
	for (const track of await input.getVideoTracks()) {
		const trackDurations: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			trackDurations.push(Math.round(packet.duration * 1000));
		}
		durations[track.number] = trackDurations;
	}

	// The zero durations used to become the 20 ms gap to the next block, or the DefaultDuration
	expect(durations).toEqual({ 1: [0, 1, 0], 2: [0, 10, 0] });
});

test('An invalid SamplingFrequency or Channels value only affects its own track', async () => {
	// Like samples.ffmpeg.org's matroska+h264+ac3+dvdsub+NoDuration.mkv, whose AC-3 track has a SamplingFrequency of
	// 0.0. The values are ignored like missing elements (8000 Hz, mono by default) instead of failing the whole file.
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
	const audioTrack = (trackNumber: number, audio: number[]) => element(
		EBMLId.TrackEntry,
		element(EBMLId.TrackNumber, [trackNumber]),
		element(EBMLId.TrackType, [2]),
		element(EBMLId.CodecID, ascii('A_AC3')),
		element(EBMLId.Audio, audio),
	);

	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		...element(
			EBMLId.Segment,
			element(
				EBMLId.Tracks,
				element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [1]),
					element(EBMLId.CodecID, ascii('V_VP8')),
					element(EBMLId.Video, element(EBMLId.PixelWidth, [16]), element(EBMLId.PixelHeight, [16])),
				),
				audioTrack(2, [
					...element(EBMLId.SamplingFrequency, [0, 0, 0, 0]), // 0.0 as a 4-byte float
					...element(EBMLId.Channels, [2]),
				]),
				audioTrack(3, [
					...element(EBMLId.SamplingFrequency, [0x47, 0x3b, 0x80, 0]), // 48000
					...element(EBMLId.Channels, [0]),
				]),
			),
			element(
				EBMLId.Cluster,
				element(EBMLId.Timestamp, [0]),
				element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, 1]),
				element(EBMLId.SimpleBlock, [0x82, 0, 0, 0x80, 2]),
				element(EBMLId.SimpleBlock, [0x83, 0, 0, 0x80, 3]),
			),
		),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks.map(x => x.type)).toEqual(['video', 'audio', 'audio']);

	const [zeroRate, zeroChannels] = await input.getAudioTracks();
	assert(zeroRate && zeroChannels);
	expect([await zeroRate.getSampleRate(), await zeroRate.getNumberOfChannels()]).toEqual([8000, 2]);
	expect([await zeroChannels.getSampleRate(), await zeroChannels.getNumberOfChannels()]).toEqual([48000, 1]);
	expect((await new EncodedPacketSink(zeroRate).getFirstPacket())?.data).toEqual(new Uint8Array([2]));
});
