import { describe, expect, test } from 'vitest';
import {
	ALL_FORMATS,
	AttachedFile,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	Input,
	MkvOutputFormat,
	MkvOutputFormatOptions,
	Output,
	TextSubtitleSource,
	WebMOutputFormat,
} from '../../src/index.js';
import { EBMLId } from '../../src/matroska/ebml.js';
import {
	ExtraId,
	findAll,
	findFirst,
	findOptional,
	opusHead,
	parseBlock,
	parseEbml,
	ParsedElement,
	readFloat,
	readSigned,
	readString,
	readUnsigned,
} from './helpers/matroska-ebml.js';

// Matroska/WebM muxing conformance. The output is parsed back with a small independent EBML parser
// (helpers/matroska-ebml.ts) and checked against RFC 9559, the Matroska codec mappings and the WebM container
// guidelines; round trips through Mediabunny's demuxer check that nothing is lost.

type VideoTrackSpec = {
	type: 'video';
	codec: 'vp8' | 'vp9' | 'av1' | 'avc' | 'hevc' | 'prores';
	decoderConfig: VideoDecoderConfig;
	packets: EncodedPacket[];
	metadata?: Parameters<Output['addVideoTrack']>[1];
};

type AudioTrackSpec = {
	type: 'audio';
	codec: 'opus' | 'vorbis' | 'flac' | 'aac' | 'mp3' | 'ac3' | 'eac3' | 'pcm-s16' | 'pcm-s24be' | 'pcm-f32' | 'pcm-u8';
	decoderConfig: AudioDecoderConfig;
	packets: EncodedPacket[];
	metadata?: Parameters<Output['addAudioTrack']>[1];
};

type TrackSpec = VideoTrackSpec | AudioTrackSpec;

const mux = async (
	specs: TrackSpec[],
	options: { webm?: boolean; formatOptions?: MkvOutputFormatOptions; configure?: (output: Output) => void } = {},
) => {
	const format = options.webm
		? new WebMOutputFormat(options.formatOptions)
		: new MkvOutputFormat(options.formatOptions);
	const output = new Output({ format, target: new BufferTarget() });
	const sources = specs.map((spec) => {
		if (spec.type === 'video') {
			const source = new EncodedVideoPacketSource(spec.codec);
			output.addVideoTrack(source, spec.metadata);
			return source;
		} else {
			const source = new EncodedAudioPacketSource(spec.codec);
			output.addAudioTrack(source, spec.metadata);
			return source;
		}
	});
	options.configure?.(output);
	await output.start();

	// Interleave by timestamp, like a real producer would
	const positions = specs.map(() => 0);
	while (true) {
		let next = -1;
		for (let i = 0; i < specs.length; i++) {
			const packet = specs[i]!.packets[positions[i]!];
			if (packet && (next === -1 || packet.timestamp < specs[next]!.packets[positions[next]!]!.timestamp)) {
				next = i;
			}
		}
		if (next === -1) {
			break;
		}

		const spec = specs[next]!;
		const isFirst = positions[next] === 0;
		const packet = spec.packets[positions[next]!++]!;
		if (spec.type === 'video') {
			await (sources[next] as EncodedVideoPacketSource).add(
				packet,
				isFirst ? { decoderConfig: spec.decoderConfig } : undefined,
			);
		} else {
			await (sources[next] as EncodedAudioPacketSource).add(
				packet,
				isFirst ? { decoderConfig: spec.decoderConfig } : undefined,
			);
		}
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

const videoPackets = (count: number, options: { fps?: number; keyEvery?: number; start?: number } = {}) => {
	const fps = options.fps ?? 25;
	const keyEvery = options.keyEvery ?? 25;
	return Array.from({ length: count }, (_, i) => new EncodedPacket(
		new Uint8Array(32).fill(i & 0xff),
		i % keyEvery === 0 ? 'key' : 'delta',
		(options.start ?? 0) + i / fps,
		1 / fps,
	));
};

const audioPackets = (count: number, frameDuration = 0.02, start = 0) => Array.from(
	{ length: count },
	(_, i) => new EncodedPacket(new Uint8Array([0xfc, i & 0xff, 1]), 'key', start + i * frameDuration, frameDuration),
);

const vp8Track = (packets = videoPackets(50), metadata?: VideoTrackSpec['metadata']): VideoTrackSpec => ({
	type: 'video',
	codec: 'vp8',
	decoderConfig: { codec: 'vp8', codedWidth: 320, codedHeight: 240 },
	packets,
	metadata,
});

const opusTrack = (packets = audioPackets(100), metadata?: AudioTrackSpec['metadata']): AudioTrackSpec => {
	// Like an encoder's output, whose header's pre-skip is the negative start (if any)
	const preSkip = Math.round(Math.max(-(packets[0]?.timestamp ?? 0), 0) * 48000);
	return {
		type: 'audio',
		codec: 'opus',
		decoderConfig: {
			codec: 'opus',
			numberOfChannels: 2,
			sampleRate: 48000,
			description: new Uint8Array(opusHead(2, preSkip)),
		},
		packets,
		metadata,
	};
};

const open = (bytes: Uint8Array) => new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

const segmentOf = (bytes: Uint8Array) => findFirst(parseEbml(bytes), EBMLId.Segment);
const uintAt = (elements: ParsedElement[], ...path: number[]) => readUnsigned(findFirst(elements, ...path).data);

const trackEntries = (bytes: Uint8Array) => findAll(segmentOf(bytes).children, EBMLId.Tracks, EBMLId.TrackEntry);

/** All blocks of the file in file order, with their absolute timestamps in ticks. */
const allBlocks = (bytes: Uint8Array) => {
	const result: {
		cluster: ParsedElement;
		element: ParsedElement;
		trackNumber: number;
		timestamp: number;
		key: boolean | null; // null for Blocks, whose key-ness comes from ReferenceBlock
		referenceBlock: number | null;
		duration: number | null;
		payload: Uint8Array;
	}[] = [];

	for (const cluster of findAll(segmentOf(bytes).children, EBMLId.Cluster)) {
		const clusterTimestamp = uintAt(cluster.children, EBMLId.Timestamp);
		for (const child of cluster.children) {
			if (child.id === EBMLId.SimpleBlock) {
				const block = parseBlock(child.data);
				result.push({
					cluster,
					element: child,
					trackNumber: block.trackNumber,
					timestamp: clusterTimestamp + block.relativeTimestamp,
					key: !!(block.flags & 0x80),
					referenceBlock: null,
					duration: null,
					payload: block.payload,
				});
			} else if (child.id === EBMLId.BlockGroup) {
				const block = parseBlock(findFirst(child.children, EBMLId.Block).data);
				const reference = findOptional(child.children, EBMLId.ReferenceBlock);
				const duration = findOptional(child.children, EBMLId.BlockDuration);
				result.push({
					cluster,
					element: child,
					trackNumber: block.trackNumber,
					timestamp: clusterTimestamp + block.relativeTimestamp,
					key: null,
					referenceBlock: reference ? readSigned(reference.data) : null,
					duration: duration ? readUnsigned(duration.data) : null,
					payload: block.payload,
				});
			}
		}
	}

	return result;
};

describe('EBML header and Segment', () => {
	test.each([false, true])('writes the EBML header (WebM: %s)', async (webm) => {
		const bytes = await mux([vp8Track()], { webm });
		const header = findFirst(parseEbml(bytes), EBMLId.EBML).children;
		expect(uintAt(header, EBMLId.EBMLVersion)).toBe(1);
		expect(uintAt(header, EBMLId.EBMLReadVersion)).toBe(1);
		expect(uintAt(header, EBMLId.EBMLMaxIDLength)).toBe(4);
		expect(uintAt(header, EBMLId.EBMLMaxSizeLength)).toBe(8);
		expect(readString(findFirst(header, EBMLId.DocType).data)).toBe(webm ? 'webm' : 'matroska');
		expect(uintAt(header, EBMLId.DocTypeVersion)).toBe(4);
		expect(uintAt(header, EBMLId.DocTypeReadVersion)).toBe(2);
	});

	test('gives the Segment the exact size of its content', async () => {
		const bytes = await mux([vp8Track(), opusTrack()]);
		const top = parseEbml(bytes);
		expect(top.map(x => x.id)).toEqual([EBMLId.EBML, EBMLId.Segment]);
		expect(top[1]!.end).toBe(bytes.length);
	});

	test('points every SeekHead entry at an element with that ID', async () => {
		const bytes = await mux([vp8Track()], {
			configure: (output) => {
				output.setMetadataTags({
					title: 'T',
					images: [{ data: new Uint8Array([1]), mimeType: 'image/png', kind: 'coverFront' }],
				});
			},
		});
		const segment = segmentOf(bytes);
		const seeks = findAll(segment.children, EBMLId.SeekHead, EBMLId.Seek);
		const targets = seeks.map((seek) => {
			const id = readUnsigned(findFirst(seek.children, EBMLId.SeekID).data);
			const position = uintAt(seek.children, EBMLId.SeekPosition);
			const target = segment.children.find(x => x.start === segment.dataStart + position);
			return [id, target?.id];
		});
		expect(targets).toEqual([
			[EBMLId.Info, EBMLId.Info],
			[EBMLId.Tracks, EBMLId.Tracks],
			[EBMLId.Attachments, EBMLId.Attachments],
			[EBMLId.Tags, EBMLId.Tags],
			[EBMLId.Cues, EBMLId.Cues],
		]);
	});

	test('writes Info with TimestampScale, Duration, DateUTC and the muxing app', async () => {
		const creationTime = new Date('2024-02-03T04:05:06.789Z');
		const bytes = await mux([vp8Track(videoPackets(50))], {
			configure: output => output.setMetadataTags({ creationTime }),
		});
		const infoElement = findFirst(segmentOf(bytes).children, EBMLId.Info).children;
		expect(uintAt(infoElement, EBMLId.TimestampScale)).toBe(1e6);
		expect(readFloat(findFirst(infoElement, EBMLId.Duration).data)).toBe(2000);

		const dateUtc = findFirst(infoElement, EBMLId.DateUTC).data;
		const nanoseconds = new DataView(dateUtc.buffer, dateUtc.byteOffset, 8).getBigInt64(0);
		expect(Date.UTC(2001, 0, 1) + Number(nanoseconds / 1_000_000n)).toBe(creationTime.getTime());

		expect(readString(findFirst(infoElement, EBMLId.MuxingApp).data)).toMatch(/^Mediabunny/);
		expect(readString(findFirst(infoElement, EBMLId.WritingApp).data)).toMatch(/^Mediabunny/);

		using input = open(bytes);
		expect((await input.getMetadataTags()).creationTime).toEqual(creationTime);
		expect(await input.getDurationFromMetadata()).toBe(2);
	});
});

describe('Tracks', () => {
	test('writes track numbers, types, language, name and flags', async () => {
		const bytes = await mux([
			vp8Track(videoPackets(5), { languageCode: 'fre', name: 'Vidéo principale' }),
			opusTrack(audioPackets(5), {
				languageCode: 'jpn',
				disposition: { default: false, forced: true, hearingImpaired: true, commentary: true },
			}),
		]);
		const [video, audio] = trackEntries(bytes);
		expect(uintAt(video!.children, EBMLId.TrackNumber)).toBe(1);
		expect(uintAt(video!.children, EBMLId.TrackType)).toBe(1);
		expect(readString(findFirst(video!.children, EBMLId.Language).data)).toBe('fre');
		expect(readString(findFirst(video!.children, EBMLId.Name).data)).toBe('Vidéo principale');
		expect(findOptional(video!.children, EBMLId.FlagDefault)).toBe(null); // Defaults to 1

		expect(uintAt(audio!.children, EBMLId.TrackNumber)).toBe(2);
		expect(uintAt(audio!.children, EBMLId.TrackType)).toBe(2);
		expect(uintAt(audio!.children, EBMLId.FlagDefault)).toBe(0);
		expect(uintAt(audio!.children, EBMLId.FlagForced)).toBe(1);
		expect(uintAt(audio!.children, EBMLId.FlagHearingImpaired)).toBe(1);
		expect(uintAt(audio!.children, EBMLId.FlagCommentary)).toBe(1);

		using input = open(bytes);
		const [inputVideo, inputAudio] = await input.getTracks();
		expect(await inputVideo!.getName()).toBe('Vidéo principale');
		expect(await inputVideo!.getLanguageCode()).toBe('fre');
		expect(await inputAudio!.getLanguageCode()).toBe('jpn');
		expect(await inputAudio!.getDisposition()).toMatchObject({ default: false, forced: true, commentary: true });
	});

	test('writes "und" when the track has no language', async () => {
		const [entry] = trackEntries(await mux([vp8Track(videoPackets(5))]));
		expect(readString(findFirst(entry!.children, EBMLId.Language).data)).toBe('und');
	});

	type AudioCodecCase = { codec: AudioTrackSpec['codec']; codecString: string; codecId: string; bitDepth?: number };
	const audioCodecCases: AudioCodecCase[] = [
		{ codec: 'mp3', codecString: 'mp3', codecId: 'A_MPEG/L3' },
		{ codec: 'ac3', codecString: 'ac-3', codecId: 'A_AC3' },
		{ codec: 'eac3', codecString: 'ec-3', codecId: 'A_EAC3' },
		{ codec: 'pcm-s16', codecString: 'pcm-s16', codecId: 'A_PCM/INT/LIT', bitDepth: 16 },
		{ codec: 'pcm-u8', codecString: 'pcm-u8', codecId: 'A_PCM/INT/LIT', bitDepth: 8 },
		{ codec: 'pcm-s24be', codecString: 'pcm-s24be', codecId: 'A_PCM/INT/BIG', bitDepth: 24 },
		{ codec: 'pcm-f32', codecString: 'pcm-f32', codecId: 'A_PCM/FLOAT/IEEE', bitDepth: 32 },
	];

	test.each(audioCodecCases)('writes $codec as $codecId', async ({ codec, codecString, codecId, bitDepth }) => {
		const bytes = await mux([{
			type: 'audio',
			codec,
			decoderConfig: { codec: codecString, numberOfChannels: 2, sampleRate: 44100 },
			packets: audioPackets(5),
		}]);
		const [entry] = trackEntries(bytes);
		expect(readString(findFirst(entry!.children, EBMLId.CodecID).data)).toBe(codecId);
		const audioElement = findFirst(entry!.children, EBMLId.Audio).children;
		expect(readFloat(findFirst(audioElement, EBMLId.SamplingFrequency).data)).toBe(44100);
		expect(uintAt(audioElement, EBMLId.Channels)).toBe(2);
		expect(findOptional(audioElement, EBMLId.BitDepth) && uintAt(audioElement, EBMLId.BitDepth)).toBe(
			bitDepth ?? null,
		);

		using input = open(bytes);
		expect(await (await input.getAudioTracks())[0]!.getCodec()).toBe(codec);
	});

	test('derives VP9 CodecPrivate from the codec string (WebM codec features)', async () => {
		const bytes = await mux([{
			type: 'video',
			codec: 'vp9',
			decoderConfig: { codec: 'vp09.02.41.10.01.09.16.09.01', codedWidth: 320, codedHeight: 240 },
			packets: videoPackets(3),
		}], { webm: true });
		const [entry] = trackEntries(bytes);
		// ID 1 profile, ID 2 level, ID 3 bit depth, ID 4 chroma subsampling, each with a 1-byte length
		const codecPrivate = [...findFirst(entry!.children, EBMLId.CodecPrivate).data];
		expect(codecPrivate).toEqual([1, 1, 2, 2, 1, 41, 3, 1, 10, 4, 1, 1]);
	});

	test('derives the av1C CodecPrivate of AV1 tracks from the codec string', async () => {
		const bytes = await mux([{
			type: 'video',
			codec: 'av1',
			decoderConfig: { codec: 'av01.0.04M.08', codedWidth: 320, codedHeight: 240 },
			packets: videoPackets(3),
		}], { webm: true });
		const [entry] = trackEntries(bytes);
		const av1C = findFirst(entry!.children, EBMLId.CodecPrivate).data;
		expect(av1C[0]).toBe(0x81); // marker + version 1
		expect(av1C[1]).toBe((0 << 5) | 4); // seq_profile 0, seq_level_idx_0 4
		expect(av1C[2]! >> 7).toBe(0); // seq_tier_0 M
	});

	test('converts ADTS AAC to raw frames with an AudioSpecificConfig CodecPrivate', async () => {
		// ADTS: AAC-LC, 44.1 kHz (index 4), stereo, 7-byte header (no CRC), frame length 7 + 2
		const adts = [0xff, 0xf1, 0x50, 0x80, 0x01, 0x3f, 0xfc, 0xaa, 0xbb];
		const bytes = await mux([{
			type: 'audio',
			codec: 'aac',
			decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 44100 },
			packets: [0, 1, 2].map(i => new EncodedPacket(new Uint8Array(adts), 'key', i * 1024 / 44100, 1024 / 44100)),
		}]);
		const [entry] = trackEntries(bytes);
		expect([...findFirst(entry!.children, EBMLId.CodecPrivate).data]).toEqual([0x12, 0x10]);
		expect(allBlocks(bytes).map(x => [...x.payload])).toEqual([[0xaa, 0xbb], [0xaa, 0xbb], [0xaa, 0xbb]]);
	});

	test('writes the ProRes four-character code as CodecPrivate and strips the frame container header', async () => {
		const frame = new Uint8Array([0, 0, 0, 12, ...[...'icpf'].map(x => x.charCodeAt(0)), 1, 2, 3, 4]);
		const bytes = await mux([{
			type: 'video',
			codec: 'prores',
			decoderConfig: { codec: 'apch', codedWidth: 320, codedHeight: 240 },
			packets: [new EncodedPacket(frame, 'key', 0, 0.04)],
		}]);
		const [entry] = trackEntries(bytes);
		expect(readString(findFirst(entry!.children, EBMLId.CodecID).data)).toBe('V_PRORES');
		expect(readString(findFirst(entry!.children, EBMLId.CodecPrivate).data)).toBe('apch');
		expect([...allBlocks(bytes)[0]!.payload]).toEqual([1, 2, 3, 4]);

		using input = open(bytes);
		const packet = await new EncodedPacketSink((await input.getVideoTracks())[0]!).getFirstPacket();
		expect(packet!.data).toEqual(frame);
	});

	test('writes the Opus header, CodecDelay for a negative start and SeekPreRoll', async () => {
		// An Ogg Opus source with a 312-sample pre-skip starts at -6.5 ms
		const bytes = await mux([opusTrack(audioPackets(10, 0.02, -0.0065))]);
		const [entry] = trackEntries(bytes);
		expect(readString(findFirst(entry!.children, EBMLId.CodecID).data)).toBe('A_OPUS');
		expect([...findFirst(entry!.children, EBMLId.CodecPrivate).data]).toEqual(opusHead());
		expect(uintAt(entry!.children, EBMLId.CodecDelay)).toBe(6_500_000);
		expect(uintAt(entry!.children, EBMLId.SeekPreRoll)).toBeGreaterThanOrEqual(80_000_000);
		// Shifted up by the codec delay, so no block timestamp is negative
		expect(allBlocks(bytes)[0]!.timestamp).toBeGreaterThanOrEqual(0);

		using input = open(bytes);
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink((await input.getAudioTracks())[0]!).packets()) {
			packets.push(packet);
		}

		// Read back within half a tick (1 ms), however the 6.5 ms delay is rounded
		for (let i = 0; i < packets.length; i++) {
			expect(Math.abs(packets[i]!.timestamp - (-0.0065 + 0.02 * i))).toBeLessThanOrEqual(0.0005 + 1e-9);
		}
	});

	test('writes DefaultDuration from the frame rate', async () => {
		const [entry] = trackEntries(await mux([vp8Track(videoPackets(5, { fps: 25 }), { frameRate: 25 })]));
		expect(uintAt(entry!.children, EBMLId.DefaultDuration)).toBe(40_000_000);
	});

	test('writes the Colour element from the decoder config', async () => {
		const bytes = await mux([{
			type: 'video',
			codec: 'vp8',
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 320,
				codedHeight: 240,
				colorSpace: { primaries: 'bt470bg', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: true },
			},
			packets: videoPackets(3),
		}]);
		const [entry] = trackEntries(bytes);
		const colour = findFirst(entry!.children, EBMLId.Video, EBMLId.Colour).children;
		expect(uintAt(colour, EBMLId.MatrixCoefficients)).toBe(6);
		expect(uintAt(colour, EBMLId.TransferCharacteristics)).toBe(6);
		expect(uintAt(colour, EBMLId.Primaries)).toBe(5);
		expect(uintAt(colour, EBMLId.Range)).toBe(2);

		using input = open(bytes);
		expect(await (await input.getVideoTracks())[0]!.getColorSpace()).toEqual({
			primaries: 'bt470bg',
			transfer: 'smpte170m',
			matrix: 'smpte170m',
			fullRange: true,
		});
	});

	test('writes a display aspect ratio for non-square pixels in Matroska', async () => {
		const bytes = await mux([{
			type: 'video',
			codec: 'vp8',
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 720,
				codedHeight: 480,
				displayAspectWidth: 32,
				displayAspectHeight: 18,
			},
			packets: videoPackets(3),
		}]);
		const [entry] = trackEntries(bytes);
		const video = findFirst(entry!.children, EBMLId.Video).children;
		expect([uintAt(video, EBMLId.DisplayWidth), uintAt(video, EBMLId.DisplayHeight)]).toEqual([16, 9]);
		expect(uintAt(video, EBMLId.DisplayUnit)).toBe(3);

		using input = open(bytes);
		const track = (await input.getVideoTracks())[0]!;
		expect([await track.getSquarePixelWidth(), await track.getSquarePixelHeight()]).toEqual([853, 480]);
	});

	// Matches what FFmpeg 7 writes for, and reads from, the same display matrices (see the demuxer suite)
	const transformCases: { rotation: 0 | 90 | 180 | 270; flip: boolean; yaw: number; roll: number }[] = [
		{ rotation: 0, flip: true, yaw: 180, roll: 0 },
		{ rotation: 90, flip: false, yaw: 0, roll: -90 },
		{ rotation: 180, flip: false, yaw: 0, roll: -180 },
		{ rotation: 270, flip: false, yaw: 0, roll: 90 },
		{ rotation: 90, flip: true, yaw: 180, roll: 90 },
		{ rotation: 270, flip: true, yaw: 180, roll: -90 },
	];

	test.each(transformCases)('writes rotation $rotation, flip $flip as yaw $yaw, roll $roll', async (testCase) => {
		const { rotation, flip, yaw, roll } = testCase;
		const bytes = await mux([vp8Track(videoPackets(3), { rotation, flip })]);
		const [entry] = trackEntries(bytes);
		const projection = findFirst(entry!.children, EBMLId.Video, EBMLId.Projection).children;
		expect(uintAt(projection, EBMLId.ProjectionType)).toBe(0);
		const value = (id: number) => {
			const element = findOptional(projection, id);
			return element ? readFloat(element.data) : 0;
		};
		expect([value(EBMLId.ProjectionPoseYaw), value(EBMLId.ProjectionPosePitch), value(EBMLId.ProjectionPoseRoll)])
			.toEqual([yaw, 0, roll]);

		using input = open(bytes);
		const track = (await input.getVideoTracks())[0]!;
		expect([await track.getRotation(), await track.getFlip()]).toEqual([rotation, flip]);
	});
});

describe('Clusters and blocks', () => {
	test('starts clusters at video key frames, no sooner than a second apart', async () => {
		const bytes = await mux([vp8Track(videoPackets(250, { keyEvery: 10 })), opusTrack(audioPackets(500))]);
		const clusters = findAll(segmentOf(bytes).children, EBMLId.Cluster);
		const blocks = allBlocks(bytes);
		expect(clusters.length).toBe(9);

		let previousTimestamp = -Infinity;
		for (const cluster of clusters) {
			const timestamp = uintAt(cluster.children, EBMLId.Timestamp);
			expect(timestamp - previousTimestamp).toBeGreaterThanOrEqual(1000);
			previousTimestamp = timestamp;

			// The cluster may begin with the audio block right before the key frame (whose time span overlaps it)
			const firstVideoBlock = blocks.find(x => x.cluster.start === cluster.start && x.trackNumber === 1)!;
			expect(firstVideoBlock.key).toBe(true);
			expect(firstVideoBlock.timestamp - timestamp).toBeGreaterThanOrEqual(0);
			expect(firstVideoBlock.timestamp - timestamp).toBeLessThanOrEqual(20);
		}
	});

	test('respects minimumClusterDuration', async () => {
		const bytes = await mux([vp8Track(videoPackets(100, { keyEvery: 5 }))], {
			formatOptions: { minimumClusterDuration: 0.5 },
		});
		const clusters = findAll(segmentOf(bytes).children, EBMLId.Cluster);
		expect(clusters.map(x => uintAt(x.children, EBMLId.Timestamp))).toEqual([0, 600, 1200, 1800, 2400, 3000, 3600]);
	});

	test('starts a new cluster before relative timestamps overflow 16 bits, even without a key frame', async () => {
		// One key frame, then 40 s of delta frames
		const bytes = await mux([vp8Track(videoPackets(41, { fps: 1, keyEvery: 1000 }))]);
		const clusters = findAll(segmentOf(bytes).children, EBMLId.Cluster);
		expect(clusters.length).toBe(2);
		for (const block of allBlocks(bytes)) {
			const relative = block.timestamp - uintAt(block.cluster.children, EBMLId.Timestamp);
			expect(relative).toBeGreaterThanOrEqual(-32768);
			expect(relative).toBeLessThanOrEqual(32767);
		}

		const packets: EncodedPacket[] = [];
		using input = open(bytes);
		for await (const packet of new EncodedPacketSink((await input.getVideoTracks())[0]!).packets()) {
			packets.push(packet);
		}
		expect(packets.map(x => x.timestamp)).toEqual(Array.from({ length: 41 }, (_, i) => i));
	});

	test('writes the last delta frame of a cluster as a BlockGroup with ReferenceBlock and BlockDuration', async () => {
		const bytes = await mux([vp8Track(videoPackets(30, { keyEvery: 25 }))]);
		const blocks = allBlocks(bytes);
		const lastOfFirstCluster = blocks[24]!; // The block before the second key frame
		expect(lastOfFirstCluster.key).toBe(null);
		expect(lastOfFirstCluster.referenceBlock).toBe(-40);
		expect(lastOfFirstCluster.duration).toBe(40);
		expect(blocks.slice(0, 24).every(x => x.key !== null)).toBe(true); // SimpleBlocks
		expect(blocks.slice(1, 24).every(x => x.key === false)).toBe(true);
	});

	test('writes CuePoints for the first key frame of each track in each cluster', async () => {
		const bytes = await mux([vp8Track(videoPackets(75, { keyEvery: 25 })), opusTrack(audioPackets(150))]);
		const segment = segmentOf(bytes);
		const cuePoints = findAll(segment.children, EBMLId.Cues, EBMLId.CuePoint);
		const blocks = allBlocks(bytes);

		const resolved = cuePoints.flatMap((cuePoint) => {
			const time = uintAt(cuePoint.children, EBMLId.CueTime);
			return findAll(cuePoint.children, EBMLId.CueTrackPositions).map((positions) => {
				const track = uintAt(positions.children, EBMLId.CueTrack);
				const clusterPosition = segment.dataStart + uintAt(positions.children, EBMLId.CueClusterPosition);
				const cluster = segment.children.find(x => x.start === clusterPosition)!;
				expect(cluster.id).toBe(EBMLId.Cluster);

				const relativePosition = uintAt(positions.children, ExtraId.CueRelativePosition);
				const block = blocks.find(x => x.element.start === cluster.dataStart + relativePosition)!;
				expect(block.trackNumber).toBe(track);
				expect(block.timestamp).toBe(time);
				return [time, track];
			});
		});
		expect(resolved).toEqual([[0, 1], [0, 2], [1000, 1], [1000, 2], [2000, 1], [2000, 2]]);
	});

	test('round-trips B-frame packets in decode order with their presentation timestamps', async () => {
		// Decode order I P B B P B B P with 40 ms frames
		const order = [0, 3, 1, 2, 6, 4, 5, 7];
		const packets = order.map((frame, i) => new EncodedPacket(
			new Uint8Array([i]),
			i === 0 ? 'key' : 'delta',
			frame * 0.04,
			0.04,
		));
		const bytes = await mux([{
			type: 'video',
			codec: 'avc',
			decoderConfig: { codec: 'avc1.42001e', codedWidth: 320, codedHeight: 240, description: new Uint8Array(8) },
			packets,
		}]);

		using input = open(bytes);
		const result: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink((await input.getVideoTracks())[0]!).packets()) {
			result.push(packet);
		}
		expect(result.map(x => [x.data[0], x.timestamp, x.duration, x.type])).toEqual(
			packets.map(x => [x.data[0], x.timestamp, x.duration, x.type]),
		);
	});

	test('writes negative video timestamps relative to a cluster at 0', async () => {
		const bytes = await mux([vp8Track(videoPackets(10, { start: -0.2 }))]);
		const firstCluster = findAll(segmentOf(bytes).children, EBMLId.Cluster)[0]!;
		expect(uintAt(firstCluster.children, EBMLId.Timestamp)).toBe(0);
		expect(allBlocks(bytes)[0]!.timestamp).toBe(-200);

		using input = open(bytes);
		expect(await (await input.getVideoTracks())[0]!.getFirstTimestamp()).toBe(-0.2);
	});

	test('writes timestamps far from zero', async () => {
		const start = 100_000; // About 28 hours
		const bytes = await mux([vp8Track(videoPackets(50, { start })), opusTrack(audioPackets(100, 0.02, start))]);
		using input = open(bytes);
		const [video, audio] = await input.getTracks();
		expect(await video!.getFirstTimestamp()).toBe(start);
		expect(await audio!.getFirstTimestamp()).toBe(start);
		expect(await input.computeDuration()).toBe(start + 2);
	});

	test('stores alpha side data as a BlockAdditional with BlockAddID 1 and sets AlphaMode', async () => {
		const packets = videoPackets(3).map(packet => new EncodedPacket(
			packet.data,
			packet.type,
			packet.timestamp,
			packet.duration,
			undefined,
			undefined,
			{ alpha: new Uint8Array([7, 7, packet.data[0]!]) },
		));
		const bytes = await mux([vp8Track(packets)], { webm: true });
		const [entry] = trackEntries(bytes);
		expect(uintAt(entry!.children, EBMLId.Video, EBMLId.AlphaMode)).toBe(1);

		for (const block of allBlocks(bytes)) {
			const more = findFirst(block.element.children, EBMLId.BlockAdditions, EBMLId.BlockMore).children;
			expect(uintAt(more, EBMLId.BlockAddID)).toBe(1);
			expect([...findFirst(more, EBMLId.BlockAdditional).data]).toEqual([7, 7, block.payload[0]]);
		}

		using input = open(bytes);
		const track = (await input.getVideoTracks())[0]!;
		expect(await track.canBeTransparent()).toBe(true);
		const packet = await new EncodedPacketSink(track).getFirstPacket();
		expect([...packet!.sideData.alpha!]).toEqual([7, 7, 0]);
	});
});

describe('Subtitles', () => {
	test('stores WebVTT cues with BlockDuration, and their settings and identifier in BlockAdditions', async () => {
		const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		const source = new TextSubtitleSource('webvtt');
		output.addSubtitleTrack(source, { languageCode: 'eng' });
		await output.start();
		await source.add([
			'WEBVTT',
			'',
			'STYLE',
			'::cue { color: red }',
			'',
			'intro',
			'00:00:00.500 --> 00:00:01.000 align:start',
			'Hello <00:00:00.750>world',
			'',
			'00:00:02.000 --> 00:00:03.000',
			'Second',
			'',
		].join('\n'));
		await output.finalize();
		const bytes = new Uint8Array(output.target.buffer!);

		const [entry] = trackEntries(bytes);
		expect(uintAt(entry!.children, EBMLId.TrackType)).toBe(17);
		expect(readString(findFirst(entry!.children, EBMLId.CodecID).data)).toBe('S_TEXT/WEBVTT');
		expect(readString(findFirst(entry!.children, EBMLId.CodecPrivate).data)).toBe(
			'WEBVTT\n\nSTYLE\n::cue { color: red }',
		);

		const blocks = allBlocks(bytes);
		expect(blocks.map(x => [x.timestamp, x.duration, new TextDecoder().decode(x.payload)])).toEqual([
			[500, 500, 'Hello <00:00:00.250>world'], // In-cue timestamps are relative to the block
			[2000, 1000, 'Second'],
		]);

		// Matroska subtitles spec: settings line, identifier line, then comments
		const more = findFirst(blocks[0]!.element.children, EBMLId.BlockAdditions, EBMLId.BlockMore).children;
		expect(uintAt(more, EBMLId.BlockAddID)).toBe(1);
		expect(readString(findFirst(more, EBMLId.BlockAdditional).data)).toBe('align:start\nintro\n');
		expect(findOptional(blocks[1]!.element.children, EBMLId.BlockAdditions)).toBe(null);
	});
});

describe('Tags and attachments', () => {
	test('writes metadata as movie-level SimpleTags and round-trips them', async () => {
		const tags = {
			title: 'Tïtle',
			artist: 'Artist',
			albumArtist: 'Album artist',
			album: 'Album',
			genre: 'Genre',
			comment: 'Comment',
			description: 'Description',
			lyrics: 'Line 1\nLine 2',
			beatsPerMinute: 120,
			date: new Date('2021-03-04T00:00:00Z'),
			trackNumber: 3,
			tracksTotal: 12,
			discNumber: 1,
			discsTotal: 2,
			raw: { CUSTOM: 'value', BINARY: new Uint8Array([1, 2]) },
		};
		const bytes = await mux([vp8Track(videoPackets(3))], { configure: output => output.setMetadataTags(tags) });
		const tag = findFirst(segmentOf(bytes).children, EBMLId.Tags, EBMLId.Tag);
		expect(uintAt(tag.children, EBMLId.Targets, EBMLId.TargetTypeValue)).toBe(50);

		const simpleTags = Object.fromEntries(findAll(tag.children, ExtraId.SimpleTag).map((simpleTag) => {
			const name = readString(findFirst(simpleTag.children, EBMLId.TagName).data);
			const string = findOptional(simpleTag.children, EBMLId.TagString);
			const binary = findOptional(simpleTag.children, EBMLId.TagBinary);
			return [name, string ? readString(string.data) : [...binary!.data]];
		}));
		expect(simpleTags).toEqual({
			TITLE: 'Tïtle',
			ARTIST: 'Artist',
			ALBUM_ARTIST: 'Album artist',
			ALBUM: 'Album',
			GENRE: 'Genre',
			COMMENT: 'Comment',
			DESCRIPTION: 'Description',
			LYRICS: 'Line 1\nLine 2',
			BPM: '120',
			DATE: '2021-03-04',
			PART_NUMBER: '3/12',
			DISC: '1/2',
			CUSTOM: 'value',
			BINARY: [1, 2],
		});

		using input = open(bytes);
		const { raw, ...read } = await input.getMetadataTags();
		const { raw: rawWritten, ...written } = tags;
		expect(read).toMatchObject(written);
		expect(raw).toMatchObject(rawWritten);
	});

	test('writes images and attached files as Attachments', async () => {
		const bytes = await mux([vp8Track(videoPackets(3))], {
			configure: output => output.setMetadataTags({
				images: [
					{ data: new Uint8Array([1, 2]), mimeType: 'image/jpeg', kind: 'coverFront' },
					{
						data: new Uint8Array([3]),
						mimeType: 'image/png',
						kind: 'unknown',
						name: 'still.png',
						description: 'A still',
					},
				],
				raw: { 12345: new AttachedFile(new Uint8Array([4, 5]), 'font/ttf', 'font.ttf') },
			}),
		});
		const files = findAll(segmentOf(bytes).children, EBMLId.Attachments, EBMLId.AttachedFile).map(file => ({
			name: readString(findFirst(file.children, EBMLId.FileName).data),
			mimeType: readString(findFirst(file.children, EBMLId.FileMediaType).data),
			data: [...findFirst(file.children, EBMLId.FileData).data],
			uid: readUnsigned(findFirst(file.children, EBMLId.FileUID).data),
		}));
		expect(files.map(x => ({ name: x.name, mimeType: x.mimeType, data: x.data }))).toEqual([
			{ name: 'cover.jpg', mimeType: 'image/jpeg', data: [1, 2] },
			{ name: 'still.png', mimeType: 'image/png', data: [3] },
			{ name: 'font.ttf', mimeType: 'font/ttf', data: [4, 5] },
		]);
		expect(files.every(x => x.uid !== 0)).toBe(true);
		expect(files[2]!.uid).toBe(12345);

		using input = open(bytes);
		const metadata = await input.getMetadataTags();
		expect(metadata.images!.map(x => [x.name, x.kind, x.description])).toEqual([
			['cover.jpg', 'coverFront', undefined],
			['still.png', 'unknown', 'A still'],
		]);
	});
});

describe('Append-only output', () => {
	test('writes unknown sizes, no SeekHead and no Duration, and stays readable', async () => {
		const bytes = await mux([vp8Track(videoPackets(100)), opusTrack(audioPackets(200))], {
			formatOptions: { appendOnly: true },
		});
		const segment = segmentOf(bytes);
		expect(segment.size).toBe(null);
		expect(findOptional(segment.children, EBMLId.SeekHead)).toBe(null);
		expect(findOptional(segment.children, EBMLId.Info, EBMLId.Duration)).toBe(null);
		const clusters = findAll(segment.children, EBMLId.Cluster);
		expect(clusters.length).toBe(4);
		expect(clusters.every(x => x.size === null)).toBe(true);

		using input = open(bytes);
		expect(await input.getDurationFromMetadata()).toBe(null);
		expect(await input.computeDuration()).toBe(4);
		const sink = new EncodedPacketSink((await input.getVideoTracks())[0]!);
		expect((await sink.getKeyPacket(2.5))!.timestamp).toBe(2);
	});

	test('reports the EBML header, the Segment header and each Cluster through callbacks, in file order', async () => {
		const pieces: { kind: string; data: Uint8Array; position: number; timestamp?: number }[] = [];
		const bytes = await mux([vp8Track(videoPackets(75)), opusTrack(audioPackets(150))], {
			formatOptions: {
				appendOnly: true,
				onEbmlHeader: (data, position) => pieces.push({ kind: 'ebml', data: data.slice(), position }),
				onSegmentHeader: (data, position) => pieces.push({ kind: 'segment', data: data.slice(), position }),
				onCluster: (data, position, timestamp) => {
					pieces.push({ kind: 'cluster', data: data.slice(), position, timestamp });
				},
			},
		});

		expect(pieces.map(x => x.kind)).toEqual(['ebml', 'segment', 'cluster', 'cluster', 'cluster']);
		expect(pieces.filter(x => x.kind === 'cluster').map(x => x.timestamp)).toEqual([0, 1, 2]);

		let position = 0;
		for (const piece of pieces) {
			expect(piece.position).toBe(position);
			expect(bytes.subarray(position, position + piece.data.length)).toEqual(piece.data);
			position += piece.data.length;
		}

		// Only the Cues come after the last cluster
		expect(parseEbml(bytes, position).map(x => x.id)).toEqual([EBMLId.Cues]);
	});
});
