import { describe, expect, test } from 'vitest';
import {
	ALL_FORMATS,
	AudioSampleSink,
	BufferSource,
	EncodedPacket,
	EncodedPacketSink,
	Input,
	InputAudioTrack,
	InputVideoTrack,
	MATROSKA,
	WEBM,
} from '../../src/index.js';
import { EBMLId } from '../../src/matroska/ebml.js';
import {
	aacLcConfig,
	ascii,
	audioTrack,
	blockGroup,
	Bytes,
	cluster,
	concatBytes,
	cuePoint,
	ebmlHeader,
	el,
	elUnknownSize,
	elWithSizeWidth,
	ExtraId,
	float32,
	float64,
	info,
	KEY,
	mkv,
	opusHead,
	opusPacket,
	seekEntry,
	simpleBlock,
	simpleTag,
	str,
	tag,
	tracks,
	uint,
	utf8,
	videoTrack,
	webm,
} from './helpers/matroska-ebml.js';

// Matroska/WebM demuxing conformance. Files are built element by element (see helpers/matroska-ebml.ts). Expected
// values come from RFC 9559 (Matroska), RFC 8794 (EBML), the Matroska codec mappings, and, where noted, from what
// FFmpeg 7 reports for the same structures (ffprobe -show_packets / -show_streams).

const open = (bytes: Uint8Array) => new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

const readPackets = async (bytes: Uint8Array, trackIndex = 0) => {
	using input = open(bytes);
	const track = (await input.getTracks())[trackIndex]!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	return packets;
};

const timings = (packets: EncodedPacket[]) => packets.map(x => [x.timestamp, x.duration]);

const hex = (string: string) => Uint8Array.from(string.match(/../g)!.map(x => parseInt(x, 16)));

describe('EBML header and detection', () => {
	test('detects DocType "matroska" as Matroska and "webm" as WebM', async () => {
		using a = open(mkv(info(), tracks(videoTrack(1))));
		expect(await a.getFormat()).toBe(MATROSKA);

		using b = open(webm(info(), tracks(videoTrack(1))));
		expect(await b.getFormat()).toBe(WEBM);
	});

	test('accepts a DocType padded with trailing NUL bytes', async () => {
		const header = el(
			EBMLId.EBML,
			uint(EBMLId.EBMLVersion, 1),
			uint(EBMLId.EBMLReadVersion, 1),
			el(EBMLId.DocType, ascii('webm'), [0, 0, 0]),
		);
		using input = open(concatBytes(header, el(EBMLId.Segment, info(), tracks(videoTrack(1)))));
		expect(await input.getFormat()).toBe(WEBM);
	});

	test('accepts a CRC-32 element inside the EBML header', async () => {
		const header = ebmlHeader('matroska', [el(ExtraId.CRC32, [1, 2, 3, 4])]);
		using input = open(concatBytes(header, el(EBMLId.Segment, info(), tracks(videoTrack(1)))));
		expect(await input.getFormat()).toBe(MATROSKA);
		expect(await input.getTracks()).toHaveLength(1);
	});

	test('accepts non-minimal size encodings for the EBML header and its children', async () => {
		const header = elWithSizeWidth(
			EBMLId.EBML,
			8,
			elWithSizeWidth(EBMLId.EBMLVersion, 4, [1]),
			elWithSizeWidth(EBMLId.EBMLReadVersion, 8, [1]),
			elWithSizeWidth(EBMLId.DocType, 2, ascii('matroska')),
		);
		using input = open(concatBytes(header, el(EBMLId.Segment, info(), tracks(videoTrack(1)))));
		expect(await input.getFormat()).toBe(MATROSKA);
	});

	test('rejects an EBMLReadVersion other than 1', async () => {
		const header = el(
			EBMLId.EBML,
			uint(EBMLId.EBMLVersion, 2),
			uint(EBMLId.EBMLReadVersion, 2),
			str(EBMLId.DocType, 'matroska'),
		);
		using input = open(concatBytes(header, el(EBMLId.Segment, info(), tracks(videoTrack(1)))));
		await expect(input.getFormat()).rejects.toThrow();
	});

	test('rejects other DocTypes', async () => {
		using input = open(concatBytes(ebmlHeader('mka-but-not-really'), el(EBMLId.Segment, info())));
		await expect(input.getFormat()).rejects.toThrow();
	});

	test('builds the MIME type from the DocType, the track types and the codecs', async () => {
		using video = open(webm(
			info(),
			tracks(videoTrack(1), audioTrack(2, 'A_OPUS', { codecPrivate: opusHead() })),
		));
		expect(await video.getMimeType()).toBe('video/webm; codecs="vp8, opus"');

		using audio = open(mkv(info(), tracks(audioTrack(1, 'A_AC3'))));
		expect(await audio.getMimeType()).toBe('audio/x-matroska; codecs="ac-3"');
	});
});

describe('Element sizes and generic elements', () => {
	test('reads a Segment with an unknown size at every size width', async () => {
		for (let width = 1; width <= 8; width++) {
			const file = concatBytes(
				ebmlHeader(),
				elUnknownSize(EBMLId.Segment, width, info(), tracks(videoTrack(1)), cluster(
					0,
					simpleBlock(1, 0, KEY),
					simpleBlock(1, 40, 0),
				)),
			);

			const packets = await readPackets(file);
			expect(packets.map(x => x.timestamp), `width ${width}`).toEqual([0, 0.04]);
		}
	});

	test('reads Clusters with the 1- and 8-byte unknown sizes that live muxers write', async () => {
		// libwebm (MediaRecorder) and GStreamer write 0x01FFFFFFFFFFFFFF, other tools 0xFF
		for (const width of [1, 8]) {
			const unknownCluster = (timestamp: number) => elUnknownSize(
				EBMLId.Cluster,
				width,
				uint(EBMLId.Timestamp, timestamp),
				simpleBlock(1, 0, KEY),
				simpleBlock(1, 500, 0),
			);
			const file = mkv(info(), tracks(videoTrack(1)), unknownCluster(0), unknownCluster(1000));

			const packets = await readPackets(file);
			expect(packets.map(x => x.timestamp), `width ${width}`).toEqual([0, 0.5, 1, 1.5]);
		}
	});

	test('reads elements whose sizes use more bytes than needed', async () => {
		const file = concatBytes(ebmlHeader(), elWithSizeWidth(
			EBMLId.Segment,
			8,
			elWithSizeWidth(EBMLId.Info, 8, elWithSizeWidth(EBMLId.TimestampScale, 4, [0x0f, 0x42, 0x40])),
			elWithSizeWidth(EBMLId.Tracks, 3, videoTrack(1)),
			elWithSizeWidth(
				EBMLId.Cluster,
				8,
				elWithSizeWidth(EBMLId.Timestamp, 8, [0x03, 0xe8]),
				elWithSizeWidth(EBMLId.SimpleBlock, 5, [0x81, 0, 0, KEY, 1, 2, 3]),
			),
		));

		const packets = await readPackets(file);
		expect(packets.map(x => [x.timestamp, x.byteLength])).toEqual([[1, 3]]);
	});

	test('reads 8-byte unsigned integers', async () => {
		const file = mkv(
			info(),
			tracks(videoTrack(1)),
			el(EBMLId.Cluster, uint(EBMLId.Timestamp, 2000, 8), simpleBlock(1, 0, KEY)),
		);
		expect((await readPackets(file)).map(x => x.timestamp)).toEqual([2]);
	});

	test('treats a zero-length Timestamp as 0 and a zero-length Duration as absent', async () => {
		const file = mkv(
			info({ extra: [el(EBMLId.Duration, [])] }),
			tracks(videoTrack(1)),
			cluster(0, el(EBMLId.Timestamp, []), simpleBlock(1, 5, KEY)),
		);

		using input = open(file);
		expect(await input.getDurationFromMetadata()).toBe(null);
		expect((await readPackets(file)).map(x => x.timestamp)).toEqual([0.005]);
	});

	test('reads a 4-byte (float32) Duration', async () => {
		using input = open(mkv(
			el(EBMLId.Info, uint(EBMLId.TimestampScale, 1e6), float32(EBMLId.Duration, 1500)),
			tracks(videoTrack(1)),
		));
		expect(await input.getDurationFromMetadata()).toBe(1.5);
	});

	test('skips Void and CRC-32 elements at every level', async () => {
		// FFmpeg writes a CRC-32 as the first child of every top-level element
		const voidElement = el(EBMLId.Void, new Uint8Array(7));
		const crc = el(ExtraId.CRC32, [0, 0, 0, 0]);
		const file = mkv(
			crc,
			voidElement,
			el(EBMLId.Info, crc, uint(EBMLId.TimestampScale, 1e6), voidElement),
			el(EBMLId.Tracks, crc, voidElement, el(
				EBMLId.TrackEntry,
				crc,
				uint(EBMLId.TrackNumber, 1),
				voidElement,
				uint(EBMLId.TrackType, 1),
				str(EBMLId.CodecID, 'V_VP8'),
				el(EBMLId.Video, crc, uint(EBMLId.PixelWidth, 64), voidElement, uint(EBMLId.PixelHeight, 48)),
			)),
			voidElement,
			el(EBMLId.Cluster, crc, uint(EBMLId.Timestamp, 0), voidElement, simpleBlock(1, 0, KEY), voidElement),
			voidElement,
		);

		using input = open(file);
		const track = (await input.getVideoTracks())[0]!;
		expect(await track.getCodedWidth()).toBe(64);
		expect((await readPackets(file)).length).toBe(1);
	});

	test('skips unknown elements at every level', async () => {
		const unknown = el(0x4fff, [1, 2, 3]); // Not a Matroska element
		const file = mkv(
			el(EBMLId.Info, unknown, uint(EBMLId.TimestampScale, 1e6)),
			el(EBMLId.Tracks, unknown, el(
				EBMLId.TrackEntry,
				unknown,
				uint(EBMLId.TrackNumber, 1),
				uint(EBMLId.TrackType, 1),
				str(EBMLId.CodecID, 'V_VP8'),
				el(EBMLId.Video, unknown, uint(EBMLId.PixelWidth, 64), uint(EBMLId.PixelHeight, 48)),
			)),
			el(EBMLId.Cluster, uint(EBMLId.Timestamp, 0), unknown, simpleBlock(1, 0, KEY)),
		);

		expect((await readPackets(file)).length).toBe(1);
	});

	test('reads strings as UTF-8 and stops at a NUL terminator', async () => {
		const name = el(EBMLId.Name, new TextEncoder().encode('Commentaire — 日本語'), [0, 0x41]);
		using input = open(mkv(info(), tracks(videoTrack(1, 'V_VP8', { extra: [name] }))));
		expect(await (await input.getVideoTracks())[0]!.getName()).toBe('Commentaire — 日本語');
	});
});

describe('Segment layout', () => {
	test('reads Cues and Tags at the end of the file through a SeekHead (FFmpeg layout)', async () => {
		const trackElement = tracks(videoTrack(1));
		const clusters = [cluster(0, simpleBlock(1, 0, KEY)), cluster(1000, simpleBlock(1, 0, KEY))];
		const seekHeadLength = el(EBMLId.SeekHead, seekEntry(EBMLId.Cues, 0), seekEntry(EBMLId.Tags, 0)).length;
		const clustersStart = seekHeadLength + info().length + trackElement.length;
		const cues = el(
			EBMLId.Cues,
			cuePoint(0, { track: 1, clusterPosition: clustersStart }),
			cuePoint(1000, { track: 1, clusterPosition: clustersStart + clusters[0]!.length }),
		);
		const cuesPosition = clustersStart + clusters[0]!.length + clusters[1]!.length;
		const file = mkv(
			el(
				EBMLId.SeekHead,
				seekEntry(EBMLId.Cues, cuesPosition),
				seekEntry(EBMLId.Tags, cuesPosition + cues.length),
			),
			info(),
			trackElement,
			...clusters,
			cues,
			el(EBMLId.Tags, tag([], simpleTag('ARTIST', 'At the end'))),
		);

		using input = open(file);
		expect((await input.getMetadataTags()).artist).toBe('At the end');
		const sink = new EncodedPacketSink((await input.getVideoTracks())[0]!);
		expect((await sink.getKeyPacket(1.5))!.timestamp).toBe(1);
	});

	test('follows a SeekHead to a second SeekHead (mkvmerge layout)', async () => {
		// mkvmerge's front SeekHead points to Info, Tracks and a second SeekHead at the end, which lists the Tags
		const trackElement = tracks(videoTrack(1));
		const clusterElement = cluster(0, simpleBlock(1, 0, KEY));
		const frontSeekHeadLength = el(EBMLId.SeekHead, seekEntry(EBMLId.SeekHead, 0)).length;
		const tagsPosition = frontSeekHeadLength + info().length + trackElement.length + clusterElement.length;
		const tagsElement = el(EBMLId.Tags, tag([], simpleTag('TITLE', 'Found it')));
		const secondSeekHeadPosition = tagsPosition + tagsElement.length;

		const file = mkv(
			el(EBMLId.SeekHead, seekEntry(EBMLId.SeekHead, secondSeekHeadPosition)),
			info(),
			trackElement,
			clusterElement,
			tagsElement,
			el(EBMLId.SeekHead, seekEntry(EBMLId.Tags, tagsPosition)),
		);

		using input = open(file);
		expect((await input.getMetadataTags()).title).toBe('Found it');
	});

	test('reads Tracks found only through the SeekHead', async () => {
		// The Tracks element sits after the first Cluster, which is valid as long as the SeekHead points to it
		const clusterElement = cluster(0, simpleBlock(1, 0, KEY));
		const seekHeadLength = el(EBMLId.SeekHead, seekEntry(EBMLId.Tracks, 0)).length;
		const tracksPosition = seekHeadLength + info().length + clusterElement.length;
		const file = mkv(
			el(EBMLId.SeekHead, seekEntry(EBMLId.Tracks, tracksPosition)),
			info(),
			clusterElement,
			tracks(videoTrack(1)),
		);

		using input = open(file);
		expect(await input.getTracks()).toHaveLength(1);
		expect((await readPackets(file)).length).toBe(1);
	});

	test('reads a MediaRecorder-style file: unknown sizes, no SeekHead, no Cues, no Duration', async () => {
		const file = concatBytes(
			ebmlHeader('webm'),
			elUnknownSize(
				EBMLId.Segment,
				8,
				info(),
				tracks(videoTrack(1), audioTrack(2, 'A_OPUS', { codecPrivate: opusHead() })),
				elUnknownSize(
					EBMLId.Cluster,
					8,
					uint(EBMLId.Timestamp, 0),
					simpleBlock(1, 0, KEY),
					simpleBlock(2, 0, KEY, opusPacket()),
					simpleBlock(2, 20, KEY, opusPacket()),
					simpleBlock(1, 33, 0),
				),
				elUnknownSize(
					EBMLId.Cluster,
					8,
					uint(EBMLId.Timestamp, 66),
					simpleBlock(1, 0, KEY),
					simpleBlock(2, 0, KEY, opusPacket()),
				),
			),
		);

		using input = open(file);
		expect(await input.getDurationFromMetadata()).toBe(null);
		expect((await readPackets(file, 0)).map(x => x.timestamp)).toEqual([0, 0.033, 0.066]);
		expect((await readPackets(file, 1)).map(x => x.timestamp)).toEqual([0, 0.02, 0.066]);
	});

	test('reads Clusters that follow a Segment whose size doesn\'t include them', async () => {
		const segment = el(EBMLId.Segment, info(), tracks(videoTrack(1)));
		const file = concatBytes(
			ebmlHeader(),
			segment,
			cluster(0, simpleBlock(1, 0, KEY)),
			cluster(1000, simpleBlock(1, 0, KEY)),
		);
		expect((await readPackets(file)).map(x => x.timestamp)).toEqual([0, 1]);
	});

	test('resyncs to the next Cluster over garbage between Clusters', async () => {
		const file = mkv(
			info(),
			tracks(videoTrack(1)),
			cluster(0, simpleBlock(1, 0, KEY)),
			new Uint8Array(100).fill(0x42),
			cluster(1000, simpleBlock(1, 0, KEY)),
		);
		expect((await readPackets(file)).map(x => x.timestamp)).toEqual([0, 1]);
	});
});

describe('Segment Info', () => {
	test('reads DateUTC as the creation time', async () => {
		// 2001-01-01T00:00:01Z is 1 s after the Matroska epoch
		using input = open(mkv(
			info({ extra: [el(EBMLId.DateUTC, [0, 0, 0, 0, 0x3b, 0x9a, 0xca, 0x00])] }),
			tracks(videoTrack(1)),
		));
		expect((await input.getMetadataTags()).creationTime).toEqual(new Date('2001-01-01T00:00:01Z'));
	});

	test('reads a DateUTC before the Matroska epoch', async () => {
		using input = open(mkv(
			info({ extra: [el(EBMLId.DateUTC, [0xff, 0xff, 0xff, 0xff, 0xc4, 0x65, 0x36, 0x00])] }), // -1 s
			tracks(videoTrack(1)),
		));
		expect((await input.getMetadataTags()).creationTime).toEqual(new Date('2000-12-31T23:59:59Z'));
	});

	test('applies a TimestampScale other than 1 ms', async () => {
		// 1 tick = 100 us
		const file = mkv(
			info({ timestampScale: 100_000, duration: 25_000 }),
			tracks(videoTrack(1)),
			cluster(10_000, simpleBlock(1, 0, KEY), simpleBlock(1, 400, 0)),
		);

		using input = open(file);
		expect(await input.getDurationFromMetadata()).toBe(2.5);
		expect(await (await input.getTracks())[0]!.getTimeResolution()).toBe(10_000);
		expect((await readPackets(file)).map(x => x.timestamp)).toEqual([1, 1.04]);
	});

	test('falls back to 1 ms ticks when TimestampScale is missing', async () => {
		const file = mkv(info({ timestampScale: null }), tracks(videoTrack(1)), cluster(1000, simpleBlock(1, 0, KEY)));
		expect((await readPackets(file)).map(x => x.timestamp)).toEqual([1]);
	});

	test('treats Duration as the end timestamp, minus the smallest CodecDelay', async () => {
		// FFmpeg shifts Opus blocks up by the codec delay and includes that shift in Duration (matroskaenc.c)
		using input = open(mkv(
			info({ duration: 2006.5 }),
			tracks(audioTrack(1, 'A_OPUS', { codecPrivate: opusHead(), extra: [uint(EBMLId.CodecDelay, 6_500_000)] })),
		));
		expect(await input.getDurationFromMetadata()).toBeCloseTo(1.9995, 9);
	});
});

describe('Track entries', () => {
	test('uses the Matroska defaults for missing flags, language and audio properties', async () => {
		const entry = el(
			EBMLId.TrackEntry,
			uint(EBMLId.TrackNumber, 1),
			uint(EBMLId.TrackType, 2),
			str(EBMLId.CodecID, 'A_AC3'),
		);

		using input = open(mkv(info(), tracks(entry)));
		const track = (await input.getAudioTracks())[0]!;
		expect(await track.getLanguageCode()).toBe('eng');
		expect((await track.getDisposition()).default).toBe(true);
		expect((await track.getDisposition()).forced).toBe(false);
		expect(await track.getSampleRate()).toBe(8000);
		expect(await track.getNumberOfChannels()).toBe(1);
	});

	test('reads track flags into the disposition', async () => {
		const entry = videoTrack(1, 'V_VP8', {
			extra: [
				uint(EBMLId.FlagDefault, 0),
				uint(EBMLId.FlagForced, 1),
				uint(EBMLId.FlagHearingImpaired, 1),
				uint(EBMLId.FlagVisualImpaired, 1),
				uint(EBMLId.FlagOriginal, 1),
				uint(EBMLId.FlagCommentary, 1),
			],
		});

		using input = open(mkv(info(), tracks(entry)));
		const track = (await input.getVideoTracks())[0]!;
		expect(await track.getDisposition()).toMatchObject({
			default: false,
			forced: true,
			hearingImpaired: true,
			visuallyImpaired: true,
			original: true,
			commentary: true,
		});
	});

	test('prefers LanguageBCP47 over Language, in either order', async () => {
		for (const order of ['bcp47-first', 'bcp47-last']) {
			const language = str(EBMLId.Language, 'ger');
			const bcp47 = str(EBMLId.LanguageBCP47, 'fr-CA');
			const extra = order === 'bcp47-first' ? [bcp47, language] : [language, bcp47];

			using input = open(mkv(info(), tracks(videoTrack(1, 'V_VP8', { extra }))));
			expect(await (await input.getVideoTracks())[0]!.getLanguageCode(), order).toBe('fr');
		}
	});

	test('maps an invalid Language to "und"', async () => {
		using input = open(mkv(info(), tracks(videoTrack(1, 'V_VP8', { extra: [str(EBMLId.Language, 'english')] }))));
		expect(await (await input.getVideoTracks())[0]!.getLanguageCode()).toBe('und');
	});

	test('reads track numbers that need multi-byte VINTs', async () => {
		const file = mkv(
			info(),
			tracks(videoTrack(300), audioTrack(20000, 'A_OPUS', { codecPrivate: opusHead() })),
			cluster(0, simpleBlock(300, 0, KEY), simpleBlock(20000, 0, KEY, opusPacket())),
		);

		using input = open(file);
		expect((await input.getTracks()).map(x => x.type)).toEqual(['video', 'audio']);
		expect((await readPackets(file, 0)).length).toBe(1);
		expect((await readPackets(file, 1)).length).toBe(1);
	});

	test('ignores blocks of tracks that are not declared, and subtitle tracks', async () => {
		const subtitleTrack = el(
			EBMLId.TrackEntry,
			uint(EBMLId.TrackNumber, 2),
			uint(EBMLId.TrackType, 17),
			str(EBMLId.CodecID, 'S_TEXT/UTF8'),
		);
		const file = mkv(
			info(),
			tracks(videoTrack(1), subtitleTrack),
			cluster(0, simpleBlock(2, 0, KEY), simpleBlock(1, 0, KEY), simpleBlock(3, 10, KEY), simpleBlock(1, 40, 0)),
		);

		using input = open(file);
		expect((await input.getTracks()).map(x => x.type)).toEqual(['video']);
		expect((await readPackets(file)).map(x => x.timestamp)).toEqual([0, 0.04]);
	});

	test('numbers tracks per type in file order', async () => {
		using input = open(mkv(info(), tracks(
			audioTrack(1, 'A_AC3'),
			videoTrack(2),
			audioTrack(3, 'A_EAC3'),
			videoTrack(4, 'V_VP9'),
		)));
		const result = (await input.getTracks()).map(x => `${x.type}${x.number}`);
		expect(result).toEqual(['audio1', 'video1', 'audio2', 'video2']);
	});
});

describe('Codec mapping', () => {
	const audioCodecCases: { codecId: string; bitDepth?: number; codecPrivate?: Bytes; codec: string | null }[] = [
		{ codecId: 'A_OPUS', codecPrivate: opusHead(), codec: 'opus' },
		{ codecId: 'A_AAC', codecPrivate: aacLcConfig(), codec: 'aac' },
		{ codecId: 'A_MPEG/L3', codec: 'mp3' },
		{ codecId: 'A_FLAC', codec: 'flac' },
		{ codecId: 'A_VORBIS', codec: 'vorbis' },
		{ codecId: 'A_AC3', codec: 'ac3' },
		{ codecId: 'A_EAC3', codec: 'eac3' },
		{ codecId: 'A_DTS', codec: 'dts' },
		{ codecId: 'A_TRUEHD', codec: 'truehd' },
		{ codecId: 'A_PCM/INT/LIT', bitDepth: 8, codec: 'pcm-u8' },
		{ codecId: 'A_PCM/INT/LIT', bitDepth: 16, codec: 'pcm-s16' },
		{ codecId: 'A_PCM/INT/LIT', bitDepth: 24, codec: 'pcm-s24' },
		{ codecId: 'A_PCM/INT/LIT', bitDepth: 32, codec: 'pcm-s32' },
		{ codecId: 'A_PCM/INT/BIG', bitDepth: 16, codec: 'pcm-s16be' },
		{ codecId: 'A_PCM/INT/BIG', bitDepth: 24, codec: 'pcm-s24be' },
		{ codecId: 'A_PCM/INT/BIG', bitDepth: 32, codec: 'pcm-s32be' },
		{ codecId: 'A_PCM/FLOAT/IEEE', bitDepth: 32, codec: 'pcm-f32' },
		{ codecId: 'A_PCM/FLOAT/IEEE', bitDepth: 64, codec: 'pcm-f64' },
		{ codecId: 'A_REAL/COOK', codec: null },
		{ codecId: 'A_MS/ACM', codec: null },
	];

	test.each(audioCodecCases)('maps $codecId (bit depth $bitDepth) to $codec', async (testCase) => {
		const { codecId, codecPrivate, bitDepth, codec } = testCase;
		using input = open(mkv(info(), tracks(audioTrack(1, codecId, { codecPrivate, bitDepth }))));
		const track = (await input.getAudioTracks())[0]!;
		expect(await track.getCodec()).toBe(codec);
		expect(await track.getInternalCodecId()).toBe(codecId);
	});

	const videoCodecCases: { codecId: string; codec: string | null }[] = [
		{ codecId: 'V_VP8', codec: 'vp8' },
		{ codecId: 'V_VP9', codec: 'vp9' },
		{ codecId: 'V_AV1', codec: 'av1' },
		{ codecId: 'V_MPEG4/ISO/AVC', codec: 'avc' },
		{ codecId: 'V_MPEGH/ISO/HEVC', codec: 'hevc' },
		{ codecId: 'V_MPEG2', codec: null },
		{ codecId: 'V_MPEG4/ISO/ASP', codec: null },
		{ codecId: 'V_THEORA', codec: null },
		{ codecId: 'V_MS/VFW/FOURCC', codec: null },
	];

	test.each(videoCodecCases)('maps $codecId to $codec', async ({ codecId, codec }) => {
		using input = open(mkv(info(), tracks(videoTrack(1, codecId))));
		const track = (await input.getVideoTracks())[0]!;
		expect(await track.getCodec()).toBe(codec);
	});

	test('maps the DTS codec ID variants to their codec strings', async () => {
		for (const [codecId, codecString] of [['A_DTS/EXPRESS', 'dtse'], ['A_DTS/LOSSLESS', 'dtsl']] as const) {
			using input = open(mkv(info(), tracks(audioTrack(1, codecId))));
			const config = await (await input.getAudioTracks())[0]!.getDecoderConfig();
			expect(config!.codec).toBe(codecString);
		}
	});

	test('forces the Opus sample rate to 48 kHz', async () => {
		const codecPrivate = opusHead(2, 312, 44100);
		using input = open(mkv(info(), tracks(audioTrack(1, 'A_OPUS', { codecPrivate, sampleRate: 44100 }))));
		expect(await (await input.getAudioTracks())[0]!.getSampleRate()).toBe(48000);
	});

	test('passes CodecPrivate through as the audio decoder description', async () => {
		const cases: [string, Bytes, string][] = [
			['A_OPUS', opusHead(1, 3840), 'opus'],
			['A_AAC', aacLcConfig(4, 1), 'mp4a.40.2'],
			['A_VORBIS', [2, 30, 1, ...new Array<number>(31).fill(3)], 'vorbis'], // Xiph-laced headers
			['A_FLAC', [...ascii('fLaC'), 0x80, 0, 0, 34, ...new Array<number>(34).fill(0)], 'flac'],
		];
		for (const [codecId, codecPrivate, codecString] of cases) {
			using input = open(mkv(info(), tracks(audioTrack(1, codecId, { codecPrivate, channels: 1 }))));
			const config = await (await input.getAudioTracks())[0]!.getDecoderConfig();
			expect(config!.codec, codecId).toBe(codecString);
			expect(config!.numberOfChannels).toBe(1);
			expect(new Uint8Array(config!.description as ArrayBuffer), codecId).toEqual(new Uint8Array(codecPrivate));
		}
	});

	test('uses the avcC CodecPrivate of AVC tracks as the decoder description', async () => {
		// The CodecPrivate FFmpeg writes for x264 High profile at 320x240 (Level 1.3)
		const avcC = hex(
			'0164000dffe100196764000dacd94141fb0110000003001000000303c0f142996001000668ebe3cb22c0fdf8f800',
		);
		using input = open(mkv(info(), tracks(videoTrack(1, 'V_MPEG4/ISO/AVC', {
			width: 320,
			height: 240,
			extra: [el(EBMLId.CodecPrivate, avcC)],
		}))));
		const config = await (await input.getVideoTracks())[0]!.getDecoderConfig();
		expect(config!.codec).toBe('avc1.64000d');
		expect(new Uint8Array(config!.description as ArrayBuffer)).toEqual(avcC);
		expect([config!.codedWidth, config!.codedHeight]).toEqual([320, 240]);
	});

	test('derives the VP9 codec string from the first key frame', async () => {
		// The start of the first frame of an FFmpeg libvpx-vp9 encode (profile 0, 8 bits, BT.709)
		const frame = hex('82498342000af008f60638241c184a0009b05fcdf7f7fcdf');
		using input = open(mkv(
			info(),
			tracks(videoTrack(1, 'V_VP9', { width: 176, height: 144 })),
			cluster(0, simpleBlock(1, 0, KEY, frame)),
		));
		const config = await (await input.getVideoTracks())[0]!.getDecoderConfig();
		expect(config!.codec).toBe('vp09.00.10.08.01.02.02.02.00');
	});

	test('derives the AV1 codec string from the sequence header in the first packet', async () => {
		// The start of the first packet of an FFmpeg libaom-av1 encode
		const packet = hex('0a0b00000003bd7c79b532008032b52a10010000dd6d7834afa7786ac87350dedcdde4d2eca46e36');
		using input = open(mkv(
			info(),
			tracks(videoTrack(1, 'V_AV1', { width: 176, height: 144 })),
			cluster(0, simpleBlock(1, 0, KEY, packet)),
		));
		const config = await (await input.getVideoTracks())[0]!.getDecoderConfig();
		expect(config!.codec).toBe('av01.0.00M.08');
	});

	test('puts the ProRes frame container header back in front of each frame', async () => {
		// Matroska stores ProRes frames without their 8-byte 'icpf' atom header (FFmpeg strips it, matroskaenc.c)
		using input = open(mkv(
			info(),
			tracks(videoTrack(1, 'V_PRORES', { extra: [el(EBMLId.CodecPrivate, ascii('apcn'))] })),
			cluster(0, simpleBlock(1, 0, KEY, [1, 2, 3, 4])),
		));
		const track = (await input.getVideoTracks())[0]!;
		expect(await track.getCodec()).toBe('prores');
		const packet = await new EncodedPacketSink(track).getFirstPacket();
		expect([...packet!.data]).toEqual([0, 0, 0, 12, ...ascii('icpf'), 1, 2, 3, 4]);
	});

	test('decodes PCM tracks with the byte order and signedness of their codec ID', async () => {
		const decode = async (codecId: string, bitDepth: number, data: number[]) => {
			using input = open(mkv(
				info(),
				tracks(audioTrack(1, codecId, { bitDepth, channels: 1 })),
				cluster(0, simpleBlock(1, 0, KEY, data)),
			));
			const sink = new AudioSampleSink((await input.getAudioTracks())[0]!);
			const values: number[] = [];
			for await (const sample of sink.samples()) {
				const buffer = new Float32Array(sample.numberOfFrames);
				sample.copyTo(buffer, { planeIndex: 0, format: 'f32-planar' });
				values.push(...buffer);
				sample.close();
			}

			return values;
		};

		expect(await decode('A_PCM/INT/LIT', 16, [0x00, 0x40, 0x00, 0xc0])).toEqual([0.5, -0.5]);
		expect(await decode('A_PCM/INT/BIG', 16, [0x40, 0x00, 0xc0, 0x00])).toEqual([0.5, -0.5]);
		expect(await decode('A_PCM/INT/LIT', 8, [0xc0, 0x40])).toEqual([0.5, -0.5]); // Unsigned
		expect(await decode('A_PCM/INT/BIG', 24, [0x40, 0, 0, 0xc0, 0, 0])).toEqual([0.5, -0.5]);
		expect(await decode('A_PCM/FLOAT/IEEE', 32, [0, 0, 0, 0x3f, 0, 0, 0, 0xbf])).toEqual([0.5, -0.5]);
	});
});

describe('Video properties', () => {
	test('computes square pixel dimensions from DisplayWidth/DisplayHeight in pixels', async () => {
		using input = open(mkv(info(), tracks(videoTrack(1, 'V_VP8', {
			width: 720,
			height: 576,
			videoExtra: [uint(EBMLId.DisplayWidth, 1024), uint(EBMLId.DisplayHeight, 576)],
		}))));
		const track = (await input.getVideoTracks())[0]!;
		expect(await track.getSquarePixelWidth()).toBe(1024);
		expect(await track.getSquarePixelHeight()).toBe(576);
	});

	test('computes square pixel dimensions from a display aspect ratio (DisplayUnit 3)', async () => {
		using input = open(mkv(info(), tracks(videoTrack(1, 'V_VP8', {
			width: 720,
			height: 480,
			videoExtra: [uint(EBMLId.DisplayWidth, 16), uint(EBMLId.DisplayHeight, 9), uint(EBMLId.DisplayUnit, 3)],
		}))));
		const track = (await input.getVideoTracks())[0]!;
		expect(await track.getSquarePixelWidth()).toBe(853);
		expect(await track.getSquarePixelHeight()).toBe(480);
		const config = await track.getDecoderConfig();
		expect([config!.displayAspectWidth, config!.displayAspectHeight]).toEqual([853, 480]);
	});

	test('grows the height for display sizes narrower than the pixel aspect ratio', async () => {
		// 1920x1080 coded, displayed as 4:3
		using input = open(mkv(info(), tracks(videoTrack(1, 'V_VP8', {
			width: 1920,
			height: 1080,
			videoExtra: [uint(EBMLId.DisplayWidth, 1440), uint(EBMLId.DisplayHeight, 1080)],
		}))));
		const track = (await input.getVideoTracks())[0]!;
		expect(await track.getSquarePixelWidth()).toBe(1920);
		expect(await track.getSquarePixelHeight()).toBe(1440);
	});

	test('reads the Colour element', async () => {
		using input = open(mkv(info(), tracks(videoTrack(1, 'V_VP8', {
			videoExtra: [el(
				EBMLId.Colour,
				uint(EBMLId.MatrixCoefficients, 9),
				uint(EBMLId.TransferCharacteristics, 16),
				uint(EBMLId.Primaries, 9),
				uint(EBMLId.Range, 2),
			)],
		})), cluster(0, simpleBlock(1, 0, KEY))));
		const track = (await input.getVideoTracks())[0]!;
		expect(await track.getColorSpace()).toEqual({
			matrix: 'bt2020-ncl',
			transfer: 'pq',
			primaries: 'bt2020',
			fullRange: true,
		});
	});

	test('maps Colour Range 1 to limited range and leaves Range 3 to the codec', async () => {
		for (const [range, fullRange] of [[1, false], [3, undefined]] as const) {
			using input = open(mkv(info(), tracks(videoTrack(1, 'V_VP8', {
				videoExtra: [el(EBMLId.Colour, uint(EBMLId.MatrixCoefficients, 1), uint(EBMLId.Range, range))],
			}))));
			const track = (await input.getVideoTracks())[0]!;
			expect((await track.getColorSpace()).fullRange, `Range ${range}`).toBe(fullRange);
		}
	});

	test('reads AlphaMode', async () => {
		using input = open(mkv(info(), tracks(videoTrack(1, 'V_VP8', { videoExtra: [uint(EBMLId.AlphaMode, 1)] }))));
		expect(await (await input.getVideoTracks())[0]!.canBeTransparent()).toBe(true);
	});

	// The Projection values FFmpeg 7 writes for MP4 sources with each display matrix (ffmpeg -display_rotation R
	// [-display_hflip] -i in.mp4 -c copy out.mkv), and the matrix FFmpeg and Mediabunny read from the MP4 source
	const projectionCases: { yaw: number; roll: number; matrix: number[] }[] = [
		{ yaw: 180, roll: 0, matrix: [-1, 0, 0, 0, 1, 0] },
		{ yaw: 0, roll: 90, matrix: [0, -1, 0, 1, 0, 0] },
		{ yaw: 180, roll: -90, matrix: [0, -1, 0, -1, 0, 0] },
		{ yaw: 0, roll: 180, matrix: [-1, 0, 0, 0, -1, 0] },
		{ yaw: 180, roll: 180, matrix: [1, 0, 0, 0, -1, 0] },
		{ yaw: 0, roll: -90, matrix: [0, 1, 0, -1, 0, 0] },
		{ yaw: 180, roll: 90, matrix: [0, 1, 0, 1, 0, 0] },
	];

	test.each(projectionCases)('reads ProjectionPoseYaw $yaw / Roll $roll like FFmpeg', async (testCase) => {
		const { yaw, roll, matrix } = testCase;
		using input = open(mkv(info(), tracks(videoTrack(1, 'V_VP8', {
			videoExtra: [el(
				EBMLId.Projection,
				uint(EBMLId.ProjectionType, 0),
				yaw ? float64(EBMLId.ProjectionPoseYaw, yaw) : [],
				roll ? float64(EBMLId.ProjectionPoseRoll, roll) : [],
			)],
		}))));
		const track = (await input.getVideoTracks())[0]!;
		const actual = (await track.getTransformationMatrix()).slice(0, 6).map(x => Math.round(x) + 0);
		expect(actual).toEqual(matrix);
	});
});

describe('Blocks and timing', () => {
	test('adds the relative block timestamp to the cluster timestamp, including negative ones', async () => {
		const file = mkv(
			info(),
			tracks(videoTrack(1)),
			cluster(5000, simpleBlock(1, 0, KEY), simpleBlock(1, -1000, 0), simpleBlock(1, 32767, 0)),
			cluster(70000, simpleBlock(1, -32768, 0)),
		);
		const packets = await readPackets(file);
		expect(packets.map(x => x.timestamp).sort((a, b) => a - b)).toEqual([4, 5, 37.232, 37.767]);
	});

	test('reads key frame flags from SimpleBlocks and from ReferenceBlocks in BlockGroups', async () => {
		const file = mkv(
			info(),
			tracks(videoTrack(1)),
			cluster(
				0,
				simpleBlock(1, 0, KEY),
				simpleBlock(1, 40, 0),
				blockGroup(1, 80, [1]),
				blockGroup(1, 120, [1], [el(EBMLId.ReferenceBlock, [0xd8])]), // -40
			),
		);
		const packets = await readPackets(file);
		expect(packets.map(x => x.type)).toEqual(['key', 'delta', 'key', 'delta']);
	});

	test('treats audio packets of codecs without delta packets as key packets regardless of the flag', async () => {
		// Firefox's MediaRecorder doesn't set the key flag on its Opus SimpleBlocks
		const file = mkv(
			info(),
			tracks(audioTrack(1, 'A_OPUS', { codecPrivate: opusHead() })),
			cluster(0, simpleBlock(1, 0, 0, opusPacket()), simpleBlock(1, 20, 0, opusPacket())),
		);
		expect((await readPackets(file)).map(x => x.type)).toEqual(['key', 'key']);
	});

	test('derives durations from the next block in presentation order', async () => {
		const file = mkv(
			info(),
			tracks(videoTrack(1)),
			cluster(0, simpleBlock(1, 0, KEY), simpleBlock(1, 40, 0), simpleBlock(1, 100, 0), simpleBlock(1, 120, 0)),
		);
		expect(timings(await readPackets(file)).slice(0, 3)).toEqual([[0, 0.04], [0.04, 0.06], [0.1, 0.02]]);
	});

	test('uses BlockDuration for the last block of a cluster', async () => {
		const file = mkv(
			info(),
			tracks(videoTrack(1)),
			cluster(0, simpleBlock(1, 0, KEY), blockGroup(1, 40, [1], [uint(EBMLId.BlockDuration, 25)])),
		);
		expect(timings(await readPackets(file))).toEqual([[0, 0.04], [0.04, 0.025]]);
	});

	test('uses DefaultDuration for the last block of a cluster', async () => {
		const file = mkv(
			info(),
			tracks(videoTrack(1, 'V_VP8', { extra: [uint(EBMLId.DefaultDuration, 40_000_000)] })),
			cluster(0, simpleBlock(1, 0, KEY), simpleBlock(1, 40, 0)),
			cluster(80, simpleBlock(1, 0, KEY)),
		);
		expect(timings(await readPackets(file))).toEqual([[0, 0.04], [0.04, 0.04], [0.08, 0.04]]);
	});

	test('subtracts CodecDelay from block timestamps', async () => {
		const file = mkv(
			info(),
			tracks(audioTrack(1, 'A_OPUS', { codecPrivate: opusHead(), extra: [uint(EBMLId.CodecDelay, 6_000_000)] })),
			cluster(0, simpleBlock(1, 0, KEY, opusPacket()), simpleBlock(1, 20, KEY, opusPacket())),
		);
		const packets = await readPackets(file);
		expect(packets.map(x => x.timestamp)).toEqual([-0.006, 0.014]);

		using input = open(file);
		const sink = new EncodedPacketSink((await input.getAudioTracks())[0]!);
		expect((await sink.getPacket(0))!.timestamp).toBe(-0.006);
		expect((await sink.getPacket(0.014))!.timestamp).toBe(0.014);
	});

	test('rounds CodecDelay to whole ticks, like FFmpeg', async () => {
		// The 6.5 ms Opus pre-skip becomes 7 ticks (matroskadec.c, codec_delay_in_track_tb)
		const file = mkv(
			info(),
			tracks(audioTrack(1, 'A_OPUS', { codecPrivate: opusHead(), extra: [uint(EBMLId.CodecDelay, 6_500_000)] })),
			cluster(0, simpleBlock(1, 0, KEY, opusPacket()), simpleBlock(1, 20, KEY, opusPacket())),
		);
		expect((await readPackets(file)).map(x => x.timestamp)).toEqual([-0.007, 0.013]);
	});

	test('sorts packets with out-of-order presentation timestamps (B-frames) within a cluster', async () => {
		// Decode order I P B B with presentation order I B B P
		const file = mkv(
			info(),
			tracks(videoTrack(1, 'V_VP8', { extra: [uint(EBMLId.DefaultDuration, 40_000_000)] })),
			cluster(0, simpleBlock(1, 0, KEY), simpleBlock(1, 120, 0), simpleBlock(1, 40, 0), simpleBlock(1, 80, 0)),
		);
		const packets = await readPackets(file);
		expect(timings(packets)).toEqual([[0, 0.04], [0.12, 0.04], [0.04, 0.04], [0.08, 0.04]]);

		using input = open(file);
		const sink = new EncodedPacketSink((await input.getVideoTracks())[0]!);
		expect((await sink.getPacket(0.05))!.timestamp).toBe(0.04);
		expect((await sink.getPacket(0.13))!.timestamp).toBe(0.12);
	});

	test('reads the alpha BlockAdditional (BlockAddID 1) as alpha side data', async () => {
		const file = mkv(
			info(),
			tracks(videoTrack(1, 'V_VP8', { videoExtra: [uint(EBMLId.AlphaMode, 1)] })),
			cluster(0, blockGroup(1, 0, [1, 2], [el(EBMLId.BlockAdditions, el(
				EBMLId.BlockMore,
				uint(EBMLId.BlockAddID, 1),
				el(EBMLId.BlockAdditional, [9, 8, 7]),
			))], KEY), blockGroup(1, 40, [3], [el(EBMLId.BlockAdditions, el(
				EBMLId.BlockMore,
				el(EBMLId.BlockAdditional, [6]), // BlockAddID defaults to 1
			))])),
		);
		const packets = await readPackets(file);
		expect(packets.map(x => [...(x.sideData.alpha ?? [])])).toEqual([[9, 8, 7], [6]]);
	});

	test('ignores BlockAdditionals with other BlockAddIDs, and alpha data without AlphaMode', async () => {
		const blockWithAddition = (addId: number) => blockGroup(1, 0, [1, 2], [el(EBMLId.BlockAdditions, el(
			EBMLId.BlockMore,
			uint(EBMLId.BlockAddID, addId),
			el(EBMLId.BlockAdditional, [9, 8, 7]),
		))], KEY);

		const withOtherId = mkv(
			info(),
			tracks(videoTrack(1, 'V_VP8', { videoExtra: [uint(EBMLId.AlphaMode, 1)] })),
			cluster(0, blockWithAddition(4)),
		);
		expect((await readPackets(withOtherId))[0]!.sideData.alpha).toBeUndefined();

		const withoutAlphaMode = mkv(info(), tracks(videoTrack(1)), cluster(0, blockWithAddition(1)));
		expect((await readPackets(withoutAlphaMode))[0]!.sideData.alpha).toBeUndefined();
	});
});

describe('Lacing', () => {
	const ac3Track = tracks(audioTrack(1, 'A_AC3', { extra: [uint(EBMLId.DefaultDuration, 32_000_000)] }));

	test('splits Xiph-laced blocks', async () => {
		// 3 frames: 300 bytes (255 + 45), 2 bytes, and the rest (4 bytes)
		const data = [2, 255, 45, 2, ...new Array<number>(300).fill(1), 2, 2, 3, 3, 3, 3];
		const packets = await readPackets(mkv(info(), ac3Track, cluster(0, simpleBlock(1, 0, KEY | 0x02, data))));
		expect(packets.map(x => x.byteLength)).toEqual([300, 2, 4]);
		expect(timings(packets)).toEqual([[0, 0.032], [0.032, 0.032], [0.064, 0.032]]);
	});

	test('splits Xiph-laced blocks with a frame of exactly 255 bytes', async () => {
		const data = [1, 255, 0, ...new Array<number>(255).fill(1), 2, 2];
		const packets = await readPackets(mkv(info(), ac3Track, cluster(0, simpleBlock(1, 0, KEY | 0x02, data))));
		expect(packets.map(x => x.byteLength)).toEqual([255, 2]);
	});

	test('splits fixed-size-laced blocks', async () => {
		const data = [3, 1, 1, 2, 2, 3, 3, 4, 4];
		const packets = await readPackets(mkv(info(), ac3Track, cluster(0, simpleBlock(1, 0, KEY | 0x04, data))));
		expect(packets.map(x => [...x.data])).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
	});

	test('splits EBML-laced blocks with positive and negative size differences', async () => {
		// Sizes 100, 98 (-2), 300 (+202), and the rest (5)
		const data = [
			3,
			0x40, 100, // 100 as a 2-byte VINT
			0x80 | (63 - 2), // -2 as a 1-byte signed VINT (bias 63)
			0x40 | ((8191 + 202) >> 8), (8191 + 202) & 0xff, // +202 as a 2-byte signed VINT (bias 8191)
			...new Array<number>(100).fill(1),
			...new Array<number>(98).fill(2),
			...new Array<number>(300).fill(3),
			4, 4, 4, 4, 4,
		];
		const packets = await readPackets(mkv(info(), ac3Track, cluster(0, simpleBlock(1, 0, KEY | 0x06, data))));
		expect(packets.map(x => x.byteLength)).toEqual([100, 98, 300, 5]);
	});

	test('spreads a laced block over its BlockDuration', async () => {
		const data = [1, 1, 1, 2, 2];
		const packets = await readPackets(mkv(
			info(),
			tracks(audioTrack(1, 'A_AC3')),
			cluster(0, blockGroup(1, 0, data, [uint(EBMLId.BlockDuration, 64)], 0x04 | KEY)),
		));
		expect(timings(packets)).toEqual([[0, 0.032], [0.032, 0.032]]);
	});

	test('spreads a laced block over the time until the next block', async () => {
		const packets = await readPackets(mkv(
			info(),
			tracks(audioTrack(1, 'A_AC3')),
			cluster(0, simpleBlock(1, 0, KEY | 0x04, [1, 1, 2]), simpleBlock(1, 64, KEY, [3])),
		));
		expect(timings(packets).slice(0, 2)).toEqual([[0, 0.032], [0.032, 0.032]]);
	});
});

describe('Content encodings', () => {
	const stripping = (header: number[]) => el(EBMLId.ContentEncodings, el(EBMLId.ContentEncoding, el(
		EBMLId.ContentCompression,
		uint(EBMLId.ContentCompAlgo, 3),
		el(EBMLId.ContentCompSettings, header),
	)));

	test('prepends the stripped header to every frame', async () => {
		// mkvmerge strips the AC-3 sync word like this
		const file = mkv(
			info(),
			tracks(audioTrack(1, 'A_AC3', {
				extra: [stripping([0x0b, 0x77]), uint(EBMLId.DefaultDuration, 32_000_000)],
			})),
			cluster(0, simpleBlock(1, 0, KEY, [1, 2]), simpleBlock(1, 32, KEY | 0x04, [1, 3, 3, 4, 4])),
		);
		const packets = await readPackets(file);
		expect(packets.map(x => [...x.data])).toEqual([[0x0b, 0x77, 1, 2], [0x0b, 0x77, 3, 3], [0x0b, 0x77, 4, 4]]);
	});

	test('applies header stripping before reading the codec info from the first packet', async () => {
		// A VP9 key frame whose first two bytes were stripped
		const frame = hex('82498342000af008f60638241c184a0009b05fcdf7f7fcdf');
		using input = open(mkv(
			info(),
			tracks(videoTrack(1, 'V_VP9', { width: 176, height: 144, extra: [stripping([...frame.subarray(0, 2)])] })),
			cluster(0, simpleBlock(1, 0, KEY, frame.subarray(2))),
		));
		const config = await (await input.getVideoTracks())[0]!.getDecoderConfig();
		expect(config!.codec).toBe('vp09.00.10.08.01.02.02.02.00');
	});

	test('drops tracks whose content is compressed with an unsupported algorithm or encrypted', async () => {
		const zlib = el(EBMLId.ContentEncodings, el(EBMLId.ContentEncoding, el(
			EBMLId.ContentCompression,
			uint(EBMLId.ContentCompAlgo, 0),
		)));
		const encrypted = el(EBMLId.ContentEncodings, el(EBMLId.ContentEncoding, el(EBMLId.ContentEncryption)));
		using input = open(mkv(info(), tracks(
			videoTrack(1),
			audioTrack(2, 'A_AC3', { extra: [zlib] }),
			audioTrack(3, 'A_AC3', { extra: [encrypted] }),
		)));
		expect((await input.getTracks()).map(x => x.id)).toEqual([1]);
	});
});

describe('Cues and seeking', () => {
	const makeFile = (withCues: boolean) => {
		const trackElement = tracks(
			videoTrack(1, 'V_VP8', { extra: [uint(EBMLId.DefaultDuration, 40_000_000)] }),
			audioTrack(2, 'A_OPUS', { codecPrivate: opusHead() }),
		);
		const clusters: Uint8Array[] = [];
		for (let i = 0; i < 10; i++) {
			const blocks: Uint8Array[] = [simpleBlock(1, 0, KEY)];
			for (let j = 1; j < 25; j++) {
				// A key frame every half second
				blocks.push(simpleBlock(1, 40 * j, j === 12 ? KEY : 0));
			}
			for (let j = 0; j < 50; j++) {
				blocks.push(simpleBlock(2, 20 * j, KEY, opusPacket()));
			}
			clusters.push(cluster(1000 * i, ...blocks));
		}

		const infoElement = info({ duration: 10_000 });
		const cuesLength = el(EBMLId.Cues, ...clusters.map(() => cuePoint(0, { track: 1, clusterPosition: 0 }))).length;
		let position = infoElement.length + trackElement.length + (withCues ? cuesLength : 0);
		const points: Uint8Array[] = [];
		for (let i = 0; i < clusters.length; i++) {
			points.push(cuePoint(1000 * i, { track: 1, clusterPosition: position }));
			position += clusters[i]!.length;
		}

		return mkv(infoElement, trackElement, withCues ? el(EBMLId.Cues, ...points) : [], ...clusters);
	};

	test.each([true, false])('seeks to packets and key packets (cues: %s)', async (withCues) => {
		using input = open(makeFile(withCues));
		const [video, audio] = await input.getTracks() as [InputVideoTrack, InputAudioTrack];
		const videoSink = new EncodedPacketSink(video);
		const audioSink = new EncodedPacketSink(audio);

		expect((await videoSink.getPacket(5.5))!.timestamp).toBe(5.48);
		expect((await videoSink.getKeyPacket(5.5))!.timestamp).toBe(5.48);
		expect((await videoSink.getKeyPacket(5.47))!.timestamp).toBe(5);
		expect((await videoSink.getPacket(9.99))!.timestamp).toBe(9.96);
		expect((await audioSink.getPacket(7.31))!.timestamp).toBe(7.3);
		expect((await audioSink.getPacket(0))!.timestamp).toBe(0);
		expect(await videoSink.getPacket(-1)).toBe(null);
		expect(await video.computeDuration()).toBe(10);

		const keyPacket = (await videoSink.getNextKeyPacket((await videoSink.getKeyPacket(5.2))!))!;
		expect(keyPacket.timestamp).toBe(5.48);
		expect((await videoSink.getNextKeyPacket(keyPacket))!.timestamp).toBe(6);
	});

	test('finds every packet by its own timestamp, in any order', async () => {
		const file = makeFile(true);
		const packets = await readPackets(file, 0);

		using input = open(file);
		const sink = new EncodedPacketSink((await input.getVideoTracks())[0]!);
		const order = packets.map((_, i) => (i * 37) % packets.length); // A deterministic shuffle
		for (const i of order) {
			expect((await sink.getPacket(packets[i]!.timestamp))!.timestamp).toBe(packets[i]!.timestamp);
		}
	});

	test('falls back to scanning when cue points point at the wrong clusters', async () => {
		// Every cue point points at the first cluster
		const trackElement = tracks(videoTrack(1));
		const clusters = Array.from({ length: 5 }, (_, i) => cluster(1000 * i, simpleBlock(1, 0, KEY)));
		const cues = el(EBMLId.Cues, ...clusters.map((_, i) => cuePoint(1000 * i, { track: 1, clusterPosition: 0 })));
		const clustersStart = info().length + trackElement.length + cues.length;
		const fixedCues = el(
			EBMLId.Cues,
			...clusters.map((_, i) => cuePoint(1000 * i, { track: 1, clusterPosition: clustersStart })),
		);

		using input = open(mkv(info(), trackElement, fixedCues, ...clusters));
		const sink = new EncodedPacketSink((await input.getVideoTracks())[0]!);
		expect((await sink.getPacket(3.5))!.timestamp).toBe(3);
		expect((await sink.getKeyPacket(4.5))!.timestamp).toBe(4);
	});
});

describe('Tags and attachments', () => {
	test('reads movie-level SimpleTags and ignores track-level and lower-level ones', async () => {
		const tags = el(
			EBMLId.Tags,
			tag([], simpleTag('TITLE', 'Movie title'), simpleTag('ARTIST', 'Someone')),
			tag([uint(EBMLId.TargetTypeValue, 50)], simpleTag('GENRE', 'Drama')),
			tag([uint(EBMLId.TagTrackUID, 1)], simpleTag('TITLE', 'Track title'), simpleTag('COMMENT', 'track')),
			tag([uint(EBMLId.TargetTypeValue, 30)], simpleTag('ALBUM', 'Not the movie')),
		);
		using input = open(mkv(info(), tracks(videoTrack(1)), tags));
		const metadata = await input.getMetadataTags();
		expect(metadata.title).toBe('Movie title');
		expect(metadata.artist).toBe('Someone');
		expect(metadata.genre).toBe('Drama');
		expect(metadata.comment).toBeUndefined();
		expect(metadata.album).toBeUndefined();
	});

	test('maps the tag names FFmpeg writes to metadata fields', async () => {
		const tags = el(EBMLId.Tags, tag(
			[],
			simpleTag('DATE', '2021-03-04'),
			simpleTag('PART_NUMBER', '3/12'),
			simpleTag('DISC', '1/2'),
			simpleTag('ALBUM_ARTIST', 'Various'),
			simpleTag('BPM', '128'),
			simpleTag('DESCRIPTION', 'Desc'),
			simpleTag('LYRICS', 'La la'),
			simpleTag('ENCODER', 'Lavf61.1.100'),
			simpleTag('COVER_ART_DATA', [1, 2, 3]),
		));
		using input = open(mkv(info(), tracks(videoTrack(1)), tags));
		const metadata = await input.getMetadataTags();
		expect(metadata).toMatchObject({
			date: new Date('2021-03-04'),
			trackNumber: 3,
			tracksTotal: 12,
			discNumber: 1,
			discsTotal: 2,
			albumArtist: 'Various',
			beatsPerMinute: 128,
			description: 'Desc',
			lyrics: 'La la',
		});
		expect(metadata.raw).toMatchObject({ ENCODER: 'Lavf61.1.100', COVER_ART_DATA: new Uint8Array([1, 2, 3]) });
	});

	test('keeps the first value of a tag that occurs more than once', async () => {
		const tags = el(EBMLId.Tags, tag([], simpleTag('TITLE', 'First')), tag([], simpleTag('TITLE', 'Second')));
		using input = open(mkv(info(), tracks(videoTrack(1)), tags));
		expect((await input.getMetadataTags()).title).toBe('First');
	});

	test('reads attachments, treating cover.* images as front covers', async () => {
		const attachment = (name: string, mime: string, data: number[], uid: number) => el(
			EBMLId.AttachedFile,
			utf8(EBMLId.FileName, name),
			str(EBMLId.FileMediaType, mime),
			el(EBMLId.FileData, data),
			uint(EBMLId.FileUID, uid, 8),
		);
		using input = open(mkv(info(), tracks(videoTrack(1)), el(
			EBMLId.Attachments,
			attachment('cover.jpg', 'image/jpeg', [1, 2, 3], 11),
			attachment('small_cover.png', 'image/png', [4], 12),
			attachment('font.ttf', 'font/ttf', [4, 5], 13),
		)));
		const metadata = await input.getMetadataTags();
		expect(metadata.images!.map(x => [x.name, x.kind, x.mimeType])).toEqual([
			['cover.jpg', 'coverFront', 'image/jpeg'],
			['small_cover.png', 'unknown', 'image/png'],
		]);
		expect(Object.keys(metadata.raw!).sort()).toEqual(['11', '12', '13']);
	});
});
