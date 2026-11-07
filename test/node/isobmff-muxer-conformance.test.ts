import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Output, VideoTrackMetadata, AudioTrackMetadata } from '../../src/output.js';
import {
	CmafOutputFormat,
	IsobmffOutputFormat,
	IsobmffOutputFormatOptions,
	MovOutputFormat,
	Mp4OutputFormat,
} from '../../src/output-format.js';
import { BufferTarget, StreamTarget, StreamTargetChunk } from '../../src/target.js';
import {
	EncodedAudioPacketSource,
	EncodedVideoPacketSource,
	TextSubtitleSource,
} from '../../src/media-source.js';
import { EncodedPacket, PacketType } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { MetadataTags, RichImageData } from '../../src/metadata.js';
import { AudioCodec, VideoCodec } from '../../src/codec.js';
import {
	fieldReader,
	findBox,
	findBoxes,
	fourCc,
	fullBoxReader,
	hasBox,
	ParsedBox,
	parseBoxes,
	readAudioSampleEntry,
	readCslg,
	readElst,
	readHdlr,
	readMdhd,
	readMvhd,
	readSampleTable,
	readSbgp,
	readSgpdRoll,
	readStsc,
	readStss,
	readStts,
	readTfdt,
	readTfhd,
	readTkhd,
	readTrun,
	readVisualSampleEntry,
} from './helpers/isobmff-mux-boxes.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const MOVIE_TIMESCALE = 57600;
const SECONDS_FROM_1904_TO_1970 = 2_082_844_800;

const VP9_CONFIG: VideoDecoderConfig = { codec: 'vp09.00.10.08', codedWidth: 640, codedHeight: 360 };
// AudioSpecificConfig: AAC-LC (2), 48 kHz (index 3), 2 channels
const AAC_CONFIG: AudioDecoderConfig = {
	codec: 'mp4a.40.2',
	numberOfChannels: 2,
	sampleRate: 48000,
	description: new Uint8Array([0x11, 0x90]),
};
const AAC_FRAME = 1024 / 48000;

type TestPacket = {
	type?: PacketType;
	timestamp: number;
	duration: number;
	size?: number;
};

/** Returns packet data that identifies the packet, so its placement in the file can be checked. */
const packetData = (trackIndex: number, packetIndex: number, size = 24) => {
	const data = new Uint8Array(size);
	const view = new DataView(data.buffer);
	view.setUint16(0, 0xbeef);
	view.setUint8(2, trackIndex);
	view.setUint32(3, packetIndex);
	for (let i = 7; i < size; i++) {
		data[i] = (i * 31 + packetIndex) & 0xff;
	}
	return data;
};

type VideoTrackSpec = {
	kind: 'video';
	codec?: VideoCodec;
	config?: VideoDecoderConfig;
	metadata?: VideoTrackMetadata;
	packets: TestPacket[];
};

type AudioTrackSpec = {
	kind: 'audio';
	codec?: AudioCodec;
	config?: AudioDecoderConfig;
	metadata?: AudioTrackMetadata;
	packets: TestPacket[];
	data?: (packetIndex: number) => Uint8Array;
};

type TrackSpec = VideoTrackSpec | AudioTrackSpec;

/** Muxes the given tracks, adding their packets interleaved by timestamp, and returns the file bytes. */
const mux = async (
	tracks: TrackSpec[],
	options: {
		format?: IsobmffOutputFormat;
		target?: 'buffer' | 'stream' | 'chunked';
		tags?: MetadataTags;
	} = {},
) => {
	const format = options.format ?? new Mp4OutputFormat();
	const initTarget = format instanceof CmafOutputFormat ? new BufferTarget() : undefined;
	const chunks: StreamTargetChunk[] = [];
	const output = new Output({
		format,
		target: options.target === 'stream' || options.target === 'chunked'
			? new StreamTarget(
				new WritableStream({ write: chunk => void chunks.push({ ...chunk, data: chunk.data.slice() }) }),
				{ chunked: options.target === 'chunked', chunkSize: 4096 },
			)
			: new BufferTarget(),
		initTarget,
	});

	if (options.tags) {
		output.setMetadataTags(options.tags);
	}

	const sources = tracks.map((track) => {
		if (track.kind === 'video') {
			const source = new EncodedVideoPacketSource(track.codec ?? 'vp9');
			output.addVideoTrack(source, track.metadata);
			return source;
		} else {
			const source = new EncodedAudioPacketSource(track.codec ?? 'aac');
			output.addAudioTrack(source, track.metadata);
			return source;
		}
	});

	await output.start();

	const queue = tracks.flatMap((track, trackIndex) => track.packets.map((packet, packetIndex) => ({
		track, trackIndex, packet, packetIndex,
	})));
	// Stable sort by timestamp keeps each track's own (decode) order
	queue.sort((a, b) => a.packet.timestamp - b.packet.timestamp);
	// But never reorder packets within a track
	const perTrackNext = tracks.map(() => 0);
	const ordered: typeof queue = [];
	while (ordered.length < queue.length) {
		let best: (typeof queue)[number] | null = null;
		for (let t = 0; t < tracks.length; t++) {
			const next = tracks[t]!.packets[perTrackNext[t]!];
			if (!next) {
				continue;
			}
			if (!best || next.timestamp < best.packet.timestamp) {
				best = { track: tracks[t]!, trackIndex: t, packet: next, packetIndex: perTrackNext[t]! };
			}
		}
		perTrackNext[best!.trackIndex]!++;
		ordered.push(best!);
	}

	for (const { track, trackIndex, packet, packetIndex } of ordered) {
		const data = track.kind === 'audio' && track.data
			? track.data(packetIndex)
			: packetData(trackIndex, packetIndex, packet.size);
		const encodedPacket = new EncodedPacket(data, packet.type ?? 'key', packet.timestamp, packet.duration);
		const source = sources[trackIndex]!;
		if (track.kind === 'video') {
			const decoderConfig = track.config ?? VP9_CONFIG;
			await (source as EncodedVideoPacketSource).add(encodedPacket, { decoderConfig });
		} else {
			const decoderConfig = track.config ?? AAC_CONFIG;
			await (source as EncodedAudioPacketSource).add(encodedPacket, { decoderConfig });
		}
	}

	await output.finalize();

	let bytes: Uint8Array;
	if (options.target === 'stream' || options.target === 'chunked') {
		const size = Math.max(...chunks.map(chunk => chunk.position + chunk.data.byteLength));
		bytes = new Uint8Array(size);
		for (const chunk of chunks) {
			bytes.set(chunk.data, chunk.position);
		}
	} else {
		bytes = new Uint8Array((output.target as BufferTarget).buffer!);
	}

	const init = initTarget ? new Uint8Array(initTarget.buffer!) : null;
	return { bytes, boxes: parseBoxes(bytes), init, initBoxes: init ? parseBoxes(init) : null, output };
};

const videoPackets = (count: number, options: { fps?: number; gop?: number; start?: number; size?: number } = {}) => {
	const fps = options.fps ?? 30;
	const gop = options.gop ?? 15;
	return Array.from({ length: count }, (_, i): TestPacket => ({
		type: i % gop === 0 ? 'key' : 'delta',
		timestamp: (options.start ?? 0) + i / fps,
		duration: 1 / fps,
		size: options.size,
	}));
};

const audioPackets = (count: number, options: { frame?: number; start?: number; size?: number } = {}) => {
	const frame = options.frame ?? AAC_FRAME;
	return Array.from({ length: count }, (_, i): TestPacket => ({
		timestamp: (options.start ?? 0) + i * frame,
		duration: frame,
		size: options.size,
	}));
};

const traks = (boxes: ParsedBox[]) => findBoxes(boxes, 'moov/trak');

const topLevelTypes = (boxes: ParsedBox[]) => boxes.map(box => box.type);

/** Checks that every sample of every track points at the bytes of the packet it came from. */
const expectSamplesAtTheirData = (bytes: Uint8Array, boxes: ParsedBox[], packetCounts: number[]) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const mdat = findBox(boxes, 'mdat');
	traks(boxes).forEach((trak, trackIndex) => {
		const { samples } = readSampleTable(bytes, trak);
		expect(samples).toHaveLength(packetCounts[trackIndex]!);
		samples.forEach((sample, i) => {
			expect(sample.offset).toBeGreaterThanOrEqual(mdat.contentStart);
			expect(sample.offset + sample.size).toBeLessThanOrEqual(mdat.end);
			expect(view.getUint16(sample.offset)).toBe(0xbeef);
			expect(view.getUint8(sample.offset + 2)).toBe(trackIndex);
			expect(view.getUint32(sample.offset + 3)).toBe(i);
		});
	});
};

describe('File layout', () => {
	const twoTracks = (): TrackSpec[] => [
		{ kind: 'video', packets: videoPackets(60), metadata: { maximumPacketCount: 60 } },
		{ kind: 'audio', packets: audioPackets(94), metadata: { maximumPacketCount: 94 } },
	];

	test('fastStart: false writes ftyp, mdat, moov and places every sample at its data', async () => {
		const { bytes, boxes } = await mux(twoTracks(), { format: new Mp4OutputFormat({ fastStart: false }) });
		expect(topLevelTypes(boxes)).toEqual(['ftyp', 'mdat', 'moov']);
		expectSamplesAtTheirData(bytes, boxes, [60, 94]);
	});

	test('fastStart: \'in-memory\' writes ftyp, moov, mdat and places every sample at its data', async () => {
		const { bytes, boxes } = await mux(twoTracks(), { format: new Mp4OutputFormat({ fastStart: 'in-memory' }) });
		expect(topLevelTypes(boxes)).toEqual(['ftyp', 'moov', 'mdat']);
		expect(findBox(boxes, 'mdat').largeSize).toBe(false);
		expectSamplesAtTheirData(bytes, boxes, [60, 94]);
	});

	test('fastStart: \'reserve\' writes ftyp, moov, free, mdat and places every sample at its data', async () => {
		const { bytes, boxes } = await mux(twoTracks(), { format: new Mp4OutputFormat({ fastStart: 'reserve' }) });
		expect(topLevelTypes(boxes)).toEqual(['ftyp', 'moov', 'free', 'mdat']);
		expectSamplesAtTheirData(bytes, boxes, [60, 94]);
	});

	test('fastStart: \'fragmented\' writes ftyp, moov, then moof/mdat pairs and a trailing mfra', async () => {
		const { boxes } = await mux(twoTracks(), { format: new Mp4OutputFormat({ fastStart: 'fragmented' }) });
		const types = topLevelTypes(boxes);
		expect(types.slice(0, 2)).toEqual(['ftyp', 'moov']);
		expect(types.at(-1)).toBe('mfra');
		const fragmentTypes = types.slice(2, -1);
		expect(fragmentTypes.length).toBeGreaterThanOrEqual(4);
		fragmentTypes.forEach((type, i) => expect(type).toBe(i % 2 === 0 ? 'moof' : 'mdat'));
	});

	test('MOV uses the same layout as MP4', async () => {
		const { bytes, boxes } = await mux(twoTracks(), { format: new MovOutputFormat({ fastStart: false }) });
		expect(topLevelTypes(boxes)).toEqual(['ftyp', 'mdat', 'moov']);
		expectSamplesAtTheirData(bytes, boxes, [60, 94]);
	});

	test('fastStart defaults to \'in-memory\' for a BufferTarget and to false for a StreamTarget', async () => {
		const buffer = await mux(twoTracks(), { format: new Mp4OutputFormat() });
		expect(topLevelTypes(buffer.boxes)).toEqual(['ftyp', 'moov', 'mdat']);

		const stream = await mux(twoTracks(), { format: new Mp4OutputFormat(), target: 'stream' });
		expect(topLevelTypes(stream.boxes)).toEqual(['ftyp', 'mdat', 'moov']);
		expectSamplesAtTheirData(stream.bytes, stream.boxes, [60, 94]);
	});

	test('the written bytes are the same for BufferTarget and (chunked) StreamTarget', async () => {
		const tracks = (): TrackSpec[] => [
			{ kind: 'video', packets: videoPackets(150, { size: 700 }), metadata: { maximumPacketCount: 150 } },
			{ kind: 'audio', packets: audioPackets(235, { size: 150 }), metadata: { maximumPacketCount: 235 } },
		];
		for (const fastStart of [false, 'in-memory', 'reserve', 'fragmented'] as const) {
			const options = { tags: { creationTime: null } };
			const reference = await mux(tracks(), { ...options, format: new Mp4OutputFormat({ fastStart }) });
			for (const target of ['stream', 'chunked'] as const) {
				const file = await mux(tracks(), { ...options, format: new Mp4OutputFormat({ fastStart }), target });
				// Compared directly, since toEqual on Uint8Arrays of this size is slow
				expect(file.bytes.byteLength).toBe(reference.bytes.byteLength);
				expect(file.bytes.findIndex((byte, i) => byte !== reference.bytes[i])).toBe(-1);
			}
		}
	});

	test('fastStart: false reserves a large mdat header and shrinks it when the data stays below 4 GiB', async () => {
		const { bytes, boxes } = await mux(twoTracks(), { format: new Mp4OutputFormat({ fastStart: false }) });
		const mdat = findBox(boxes, 'mdat');
		const ftyp = findBox(boxes, 'ftyp');
		expect(mdat.start).toBe(ftyp.end);
		expect(mdat.largeSize).toBe(false);
		// The 8 bytes of the reserved 64-bit size field stay as unreferenced payload at the start of the mdat
		const { samples } = readSampleTable(bytes, traks(boxes)[0]!);
		expect(samples[0]!.offset).toBe(mdat.start + 16);
	});

	test('fastStart: \'reserve\' fills the reserved space exactly with moov and free', async () => {
		const { boxes } = await mux(twoTracks(), { format: new Mp4OutputFormat({ fastStart: 'reserve' }) });
		const [ftyp, moov, free, mdat] = boxes;
		expect(moov!.start).toBe(ftyp!.end);
		expect(free!.start).toBe(moov!.end);
		expect(mdat!.start).toBe(free!.end);
		expect(free!.size).toBeGreaterThanOrEqual(8);
	});

	test('chunks group samples into runs of at least half a second and interleave tracks chronologically', async () => {
		const { bytes, boxes } = await mux(twoTracks(), { format: new Mp4OutputFormat({ fastStart: 'in-memory' }) });
		const tables = traks(boxes).map(trak => readSampleTable(bytes, trak));
		const timescales = traks(boxes).map(trak => readMdhd(bytes, findBox(trak.children, 'mdia/mdhd')).timescale);

		const chunks = tables.flatMap((table, trackIndex) => {
			let sampleIndex = 0;
			return table.chunkOffsets.map((offset, chunkIndex) => {
				const entry = table.stsc.entries.filter(e => e.firstChunk <= chunkIndex + 1).at(-1)!;
				const first = table.samples[sampleIndex]!;
				const last = table.samples[sampleIndex + entry.samplesPerChunk - 1]!;
				sampleIndex += entry.samplesPerChunk;
				return {
					offset,
					trackIndex,
					start: first.cts / timescales[trackIndex]!,
					span: (last.cts + last.duration - first.cts) / timescales[trackIndex]!,
				};
			});
		}).sort((a, b) => a.offset - b.offset);

		// Except for each track's last chunk, a chunk spans at least 0.5 seconds
		for (let trackIndex = 0; trackIndex < 2; trackIndex++) {
			const trackChunks = chunks.filter(c => c.trackIndex === trackIndex);
			trackChunks.slice(0, -1).forEach(chunk => expect(chunk.span).toBeGreaterThanOrEqual(0.5 - 1e-9));
		}

		// Chunks appear in the file in chronological order
		const starts = chunks.map(c => c.start);
		expect(starts).toEqual([...starts].sort((a, b) => a - b));
	});

	test('a file with more than 4 GiB of media data uses co64 and a 64-bit mdat size', async () => {
		let moov: Uint8Array | null = null;
		let mdatHeader: { position: number; size: number; largeSize: boolean } | null = null;
		const writes: { data: Uint8Array; position: number }[] = [];
		const output = new Output({
			format: new Mp4OutputFormat({
				fastStart: false,
				onMoov: data => moov = data.slice(),
			}),
			target: new StreamTarget(new WritableStream({
				write: (chunk) => {
					// Only keep small writes (headers); the media data itself is dropped
					if (chunk.data.byteLength <= 64) {
						writes.push({ data: chunk.data.slice(), position: chunk.position });
					}
				},
			})),
		});

		const source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source, { frameRate: 1 });
		await output.start();

		const big = new Uint8Array(2 ** 28); // 256 MiB, reused for every packet
		const count = 17; // 4.25 GiB in total
		for (let i = 0; i < count; i++) {
			await source.add(new EncodedPacket(big, i === 0 ? 'key' : 'delta', i, 1), { decoderConfig: VP9_CONFIG });
		}
		await output.finalize();

		const moovBoxes = parseBoxes(moov!);
		const stbl = findBox(moovBoxes, 'moov/trak/mdia/minf/stbl');
		expect(hasBox(stbl.children, 'stco')).toBe(false);
		const co64 = findBox(stbl.children, 'co64');
		const { reader } = fullBoxReader(moov!, co64);
		const entryCount = reader.u32();
		const offsets = Array.from({ length: entryCount }, () => reader.u64());
		expect(offsets).toHaveLength(count);
		offsets.forEach((offset, i) => expect(offset).toBe(offsets[0]! + i * 2 ** 28));
		expect(offsets.at(-1)!).toBeGreaterThan(2 ** 32);

		// The mdat header was patched at the end with its 64-bit size
		const header = writes.filter(write => write.position === 24 && write.data.byteLength >= 16).at(-1)!;
		const headerView = new DataView(header.data.buffer, header.data.byteOffset);
		mdatHeader = {
			position: header.position,
			size: Number(headerView.getBigUint64(8)),
			largeSize: headerView.getUint32(0) === 1,
		};
		expect(fourCc(header.data, 4)).toBe('mdat');
		expect(mdatHeader.largeSize).toBe(true);
		expect(mdatHeader.size).toBe(16 + count * 2 ** 28);
		expect(offsets[0]).toBe(24 + 16);
	}, 60_000);
});

describe('File type, movie and track headers', () => {
	const readFtyp = (bytes: Uint8Array, box: ParsedBox) => {
		const reader = fieldReader(bytes, box);
		const majorBrand = reader.fourCc();
		const minorVersion = reader.u32();
		const compatibleBrands: string[] = [];
		while (reader.remaining() >= 4) {
			compatibleBrands.push(reader.fourCc());
		}
		return { majorBrand, minorVersion, compatibleBrands };
	};

	test('ftyp brands depend on the format and the codecs', async () => {
		const avc: TrackSpec = {
			kind: 'video',
			codec: 'avc',
			config: {
				codec: 'avc1.42001e',
				codedWidth: 64,
				codedHeight: 64,
				description: new Uint8Array([1, 0x42, 0, 0x1e, 0xff, 0xe0, 0]),
			},
			packets: videoPackets(3),
		};
		const vp9: TrackSpec = { kind: 'video', packets: videoPackets(3) };

		let file = await mux([avc]);
		expect(readFtyp(file.bytes, file.boxes[0]!)).toEqual({
			majorBrand: 'isom', minorVersion: 0x200, compatibleBrands: ['isom', 'avc1', 'mp41'],
		});

		file = await mux([vp9]);
		expect(readFtyp(file.bytes, file.boxes[0]!).compatibleBrands).toEqual(['isom', 'mp41']);

		file = await mux([vp9], { format: new Mp4OutputFormat({ fastStart: 'fragmented' }) });
		expect(readFtyp(file.bytes, file.boxes[0]!)).toEqual({
			majorBrand: 'iso5', minorVersion: 0x200, compatibleBrands: ['iso5', 'iso6', 'mp41'],
		});

		file = await mux([vp9], { format: new MovOutputFormat() });
		expect(readFtyp(file.bytes, file.boxes[0]!)).toEqual({
			majorBrand: 'qt  ', minorVersion: 0x200, compatibleBrands: ['qt  '],
		});

		file = await mux([vp9], { format: new CmafOutputFormat() });
		expect(readFtyp(file.init!, file.initBoxes![0]!)).toEqual({
			majorBrand: 'iso5', minorVersion: 0x200, compatibleBrands: ['iso5', 'iso6', 'mp41', 'cmfc', 'dash'],
		});
		expect(topLevelTypes(file.initBoxes!)).toEqual(['ftyp', 'moov']);
	});

	test('mvhd uses the 57600 movie timescale, the longest track duration and the next free track ID', async () => {
		const { bytes, boxes } = await mux([
			{ kind: 'video', packets: videoPackets(45) }, // 1.5 s
			{ kind: 'audio', packets: audioPackets(100) }, // 2.1333 s
		], { tags: { creationTime: new Date('2024-02-03T04:05:06Z') } });

		const mvhd = readMvhd(bytes, findBox(boxes, 'moov/mvhd'));
		expect(mvhd.version).toBe(0);
		expect(mvhd.timescale).toBe(MOVIE_TIMESCALE);
		expect(mvhd.duration).toBe(Math.round(100 * AAC_FRAME * MOVIE_TIMESCALE));
		expect(mvhd.nextTrackId).toBe(3);
		expect(mvhd.rate).toBe(1);
		expect(mvhd.volume).toBe(1);
		expect(mvhd.matrix).toEqual([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]);
		const expectedTime = Date.UTC(2024, 1, 3, 4, 5, 6) / 1000 + SECONDS_FROM_1904_TO_1970;
		expect(mvhd.creationTime).toBe(expectedTime);
		expect(mvhd.modificationTime).toBe(expectedTime);

		for (const trak of traks(boxes)) {
			const tkhd = readTkhd(bytes, findBox(trak.children, 'tkhd'));
			const mdhd = readMdhd(bytes, findBox(trak.children, 'mdia/mdhd'));
			expect([tkhd.creationTime, tkhd.modificationTime]).toEqual([expectedTime, expectedTime]);
			expect([mdhd.creationTime, mdhd.modificationTime]).toEqual([expectedTime, expectedTime]);
		}
	});

	test('creation times past 2040 switch the headers to version 1, and null writes 0', async () => {
		let file = await mux([{ kind: 'video', packets: videoPackets(3) }], {
			tags: { creationTime: new Date('2050-01-01T00:00:00Z') },
		});
		const expectedTime = Date.UTC(2050, 0, 1) / 1000 + SECONDS_FROM_1904_TO_1970;
		expect(expectedTime).toBeGreaterThan(2 ** 32);
		const mvhd = readMvhd(file.bytes, findBox(file.boxes, 'moov/mvhd'));
		expect(mvhd.version).toBe(1);
		expect(mvhd.creationTime).toBe(expectedTime);
		expect(mvhd.duration).toBe(3 * MOVIE_TIMESCALE / 30);
		const tkhd = readTkhd(file.bytes, findBox(file.boxes, 'moov/trak/tkhd'));
		expect([tkhd.version, tkhd.creationTime, tkhd.trackId]).toEqual([1, expectedTime, 1]);
		const mdhd = readMdhd(file.bytes, findBox(file.boxes, 'moov/trak/mdia/mdhd'));
		expect([mdhd.version, mdhd.creationTime]).toEqual([1, expectedTime]);

		file = await mux([{ kind: 'video', packets: videoPackets(3) }], { tags: { creationTime: null } });
		expect(readMvhd(file.bytes, findBox(file.boxes, 'moov/mvhd')).creationTime).toBe(0);
		expect(readTkhd(file.bytes, findBox(file.boxes, 'moov/trak/tkhd')).creationTime).toBe(0);
		expect(readMdhd(file.bytes, findBox(file.boxes, 'moov/trak/mdia/mdhd')).creationTime).toBe(0);
	});

	test('creation times before 1904 are rejected', async () => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		output.addVideoTrack(new EncodedVideoPacketSource('vp9'));
		output.setMetadataTags({ creationTime: new Date('1900-01-01T00:00:00Z') });
		await expect(output.start()).rejects.toThrow('1904');
	});

	test('tkhd numbers tracks in the order they were added and sets flags, groups, volume and size', async () => {
		const { bytes, boxes } = await mux([
			{ kind: 'audio', packets: audioPackets(10) },
			{ kind: 'video', packets: videoPackets(10) },
			{ kind: 'audio', packets: audioPackets(10), metadata: { disposition: { default: false } } },
		]);

		const headers = traks(boxes).map(trak => readTkhd(bytes, findBox(trak.children, 'tkhd')));
		expect(headers.map(h => h.trackId)).toEqual([1, 2, 3]);
		expect(headers.map(h => h.flags)).toEqual([3, 3, 2]); // enabled|in movie, disabled tracks are only in movie
		expect(headers.map(h => h.alternateGroup)).toEqual([1, 0, 1]); // Video must be in group 0
		expect(headers.map(h => h.volume)).toEqual([1, 0, 1]);
		expect(headers.map(h => [h.width, h.height])).toEqual([[0, 0], [640, 360], [0, 0]]);
		expect(headers.map(h => h.layer)).toEqual([0, 0, 0]);
		expect(headers[1]!.duration).toBe(10 * MOVIE_TIMESCALE / 30);
		expect(headers[0]!.duration).toBe(Math.round(10 * AAC_FRAME * MOVIE_TIMESCALE));
	});

	test('tkhd matrix encodes rotation and flip around the frame\'s center', async () => {
		const matrixFor = async (metadata: VideoTrackMetadata) => {
			const { bytes, boxes } = await mux([{ kind: 'video', packets: videoPackets(2), metadata }]);
			return readTkhd(bytes, findBox(boxes, 'moov/trak/tkhd')).matrix;
		};
		const one = 0x10000;
		const w = 640 * one;
		const h = 360 * one;
		const w30 = 0x40000000;

		expect(await matrixFor({})).toEqual([one, 0, 0, 0, one, 0, 0, 0, w30]);
		// Clockwise rotation: x' = h - y, y' = x (QuickTime's row-vector convention, as written by FFmpeg)
		expect(await matrixFor({ rotation: 90 })).toEqual([0, one, 0, -one, 0, 0, h, 0, w30]);
		expect(await matrixFor({ rotation: 180 })).toEqual([-one, 0, 0, 0, -one, 0, w, h, w30]);
		expect(await matrixFor({ rotation: 270 })).toEqual([0, -one, 0, one, 0, 0, 0, w, w30]);
		expect(await matrixFor({ flip: true })).toEqual([-one, 0, 0, 0, one, 0, w, 0, w30]);
		expect(await matrixFor({ transformationMatrix: [2, 0, 0, 0, 0.5, 0, 10, 20, 1] }))
			.toEqual([2 * one, 0, 0, 0, one / 2, 0, 10 * one, 20 * one, w30]);
	});

	test('mdhd timescale follows the frame rate, sample rate or subtitle default', async () => {
		const timescaleFor = async (track: TrackSpec) => {
			const { bytes, boxes } = await mux([track]);
			return readMdhd(bytes, findBox(boxes, 'moov/trak/mdia/mdhd')).timescale;
		};

		expect(await timescaleFor({ kind: 'video', packets: videoPackets(3) })).toBe(MOVIE_TIMESCALE);
		expect(await timescaleFor({ kind: 'video', packets: videoPackets(3), metadata: { frameRate: 30 } })).toBe(30);
		expect(await timescaleFor({
			kind: 'video', packets: videoPackets(3, { fps: 30000 / 1001 }), metadata: { frameRate: 30000 / 1001 },
		})).toBe(30000);
		expect(await timescaleFor({ kind: 'audio', packets: audioPackets(3) })).toBe(48000);
		expect(await timescaleFor({
			kind: 'audio',
			config: { ...AAC_CONFIG, sampleRate: 44100, description: new Uint8Array([0x12, 0x10]) },
			packets: audioPackets(3, { frame: 1024 / 44100 }),
		})).toBe(44100);
	});

	test('mdhd packs the ISO 639-2/T language code and defaults to und', async () => {
		const { bytes, boxes } = await mux([
			{ kind: 'video', packets: videoPackets(3) },
			{ kind: 'audio', packets: audioPackets(3), metadata: { languageCode: 'fra' } },
		]);
		const languages = traks(boxes).map(trak => readMdhd(bytes, findBox(trak.children, 'mdia/mdhd')));
		expect(languages.map(l => l.language)).toEqual(['und', 'fra']);
		expect(languages[0]!.packedLanguage).toBe(0x55c4);
		expect(languages[1]!.packedLanguage).toBe((6 << 10) | (18 << 5) | 1);
	});

	test('mdhd duration is the media duration in the track timescale', async () => {
		const { bytes, boxes } = await mux([
			{ kind: 'video', packets: videoPackets(45), metadata: { frameRate: 30 } },
			{ kind: 'audio', packets: audioPackets(100) },
		]);
		const durations = traks(boxes).map(trak => readMdhd(bytes, findBox(trak.children, 'mdia/mdhd')).duration);
		expect(durations).toEqual([45, 100 * 1024]);
	});

	test('hdlr and media header boxes match the track type', async () => {
		const { bytes, boxes } = await mux([
			{ kind: 'video', packets: videoPackets(3) },
			{ kind: 'audio', packets: audioPackets(3) },
		]);
		const [video, audio] = traks(boxes);
		const videoHdlr = readHdlr(bytes, findBox(video!.children, 'mdia/hdlr'));
		expect(videoHdlr.handlerType).toBe('vide');
		expect(new TextDecoder().decode(videoHdlr.nameBytes)).toBe('MediabunnyVideoHandler\0');
		expect(readHdlr(bytes, findBox(audio!.children, 'mdia/hdlr')).handlerType).toBe('soun');

		const vmhd = fullBoxReader(bytes, findBox(video!.children, 'mdia/minf/vmhd'));
		expect([vmhd.version, vmhd.flags]).toEqual([0, 1]);
		expect(hasBox(audio!.children, 'mdia/minf/smhd')).toBe(true);

		for (const trak of [video!, audio!]) {
			const dref = findBox(trak.children, 'mdia/minf/dinf/dref');
			expect(fullBoxReader(bytes, dref).reader.u32()).toBe(1);
			const url = findBox(dref.children, 'url ');
			expect(fullBoxReader(bytes, url).flags).toBe(1); // Media data is in the same file
		}
	});

	test('track names go into the track\'s udta name box', async () => {
		const { bytes, boxes } = await mux([
			{ kind: 'video', packets: videoPackets(3), metadata: { name: 'Caméra 1' } },
			{ kind: 'audio', packets: audioPackets(3) },
		]);
		const [video, audio] = traks(boxes);
		const name = findBox(video!.children, 'udta/name');
		expect(new TextDecoder().decode(bytes.subarray(name.contentStart, name.end))).toBe('Caméra 1');
		expect(hasBox(audio!.children, 'udta')).toBe(false);
	});
});

describe('Sample tables and timing', () => {
	// Decode order of an IPBB GOP pattern; presentation positions in frames
	const bFramePattern = [0, 3, 1, 2, 6, 4, 5];
	const bFramePackets = (fps = 30, start = 0) => bFramePattern.map((frame, i): TestPacket => ({
		type: i === 0 ? 'key' : 'delta',
		timestamp: start + frame / fps,
		duration: 1 / fps,
	}));

	test('B-frames get decode times in order and signed composition offsets in ctts version 1', async () => {
		const { bytes, boxes } = await mux([
			{ kind: 'video', packets: bFramePackets(), metadata: { frameRate: 30 } },
		]);
		const trak = traks(boxes)[0]!;
		const { samples, stts, ctts } = readSampleTable(bytes, trak);

		expect(stts.entries).toEqual([{ count: 7, delta: 1 }]);
		expect(ctts!.version).toBe(1);
		expect(ctts!.entries).toEqual([
			{ count: 1, offset: 0 },
			{ count: 1, offset: 2 },
			{ count: 2, offset: -1 },
			{ count: 1, offset: 2 },
			{ count: 2, offset: -1 },
		]);
		expect(samples.map(s => s.cts)).toEqual(bFramePattern);

		const cslg = readCslg(bytes, findBox(trak.children, 'mdia/minf/stbl/cslg'));
		expect(cslg).toEqual({
			version: 0,
			compositionToDtsShift: 1,
			leastDecodeToDisplayDelta: -1,
			greatestDecodeToDisplayDelta: 2,
			compositionStartTime: 0,
			compositionEndTime: 7,
		});
	});

	test('stss lists the 1-based key samples, and is omitted when every sample is a key sample', async () => {
		const { bytes, boxes } = await mux([
			{ kind: 'video', packets: videoPackets(31, { gop: 10 }) },
			{ kind: 'audio', packets: audioPackets(10) },
		]);
		const [video, audio] = traks(boxes);
		expect(readStss(bytes, findBox(video!.children, 'mdia/minf/stbl/stss')).entries).toEqual([1, 11, 21, 31]);
		expect(hasBox(audio!.children, 'mdia/minf/stbl/stss')).toBe(false);
	});

	test('no ctts or cslg box is written when presentation order equals decode order', async () => {
		const { boxes } = await mux([{ kind: 'video', packets: videoPackets(10) }]);
		const stbl = findBox(boxes, 'moov/trak/mdia/minf/stbl');
		expect(hasBox(stbl.children, 'ctts')).toBe(false);
		expect(hasBox(stbl.children, 'cslg')).toBe(false);
	});

	test('stts keeps variable frame durations and the last sample\'s own duration', async () => {
		const { bytes, boxes } = await mux([{
			kind: 'video',
			packets: [
				{ type: 'key', timestamp: 0, duration: 0.1 },
				{ type: 'delta', timestamp: 0.1, duration: 0.2 },
				{ type: 'delta', timestamp: 0.3, duration: 0.2 },
				{ type: 'delta', timestamp: 0.5, duration: 0.7 },
			],
		}]);
		const { stts } = readSampleTable(bytes, traks(boxes)[0]!);
		expect(stts.entries).toEqual([
			{ count: 1, delta: 5760 },
			{ count: 2, delta: 11520 },
			{ count: 1, delta: 40320 },
		]);
	});

	test('timestamps snap to the frame rate timescale', async () => {
		const { bytes, boxes } = await mux([{
			kind: 'video',
			metadata: { frameRate: 25 },
			packets: [0, 0.0401, 0.0799, 0.12].map((timestamp, i): TestPacket => ({
				type: i === 0 ? 'key' : 'delta', timestamp, duration: 0.04,
			})),
		}]);
		const { samples } = readSampleTable(bytes, traks(boxes)[0]!);
		expect(samples.map(s => s.dts)).toEqual([0, 1, 2, 3]);
		expect(samples.map(s => s.duration)).toEqual([1, 1, 1, 1]);
	});

	test('AAC, MP3 and Opus samples carry roll recovery groups for their decoder preroll', async () => {
		const rollsFor = async (codec: AudioCodec, config: AudioDecoderConfig, frame: number, count: number) => {
			const { bytes, boxes } = await mux([{
				kind: 'audio',
				codec,
				config,
				packets: audioPackets(count, { frame }),
				// 20 ms Opus packets (TOC config 1: SILK NB 20 ms, one frame)
				data: codec === 'opus' ? () => new Uint8Array([0x08, 0, 0, 0]) : undefined,
			}]);
			const stbl = findBox(boxes, 'moov/trak/mdia/minf/stbl');
			const sgpd = readSgpdRoll(bytes, findBox(stbl.children, 'sgpd'));
			const sbgp = readSbgp(bytes, findBox(stbl.children, 'sbgp'));
			expect(sgpd.groupingType).toBe('roll');
			expect(sbgp.groupingType).toBe('roll');
			expect(sgpd.version).toBe(1);
			expect(sgpd.defaultLength).toBe(2);
			// Expand to a roll distance per sample
			return sbgp.entries.flatMap(entry => Array<number>(entry.sampleCount).fill(
				entry.groupDescriptionIndex === 0 ? 0 : sgpd.entries[entry.groupDescriptionIndex - 1]!,
			));
		};

		expect(await rollsFor('aac', AAC_CONFIG, AAC_FRAME, 5)).toEqual([0, -1, -1, -1, -1]);
		expect(await rollsFor('mp3', { codec: 'mp3', numberOfChannels: 2, sampleRate: 48000 }, 1152 / 48000, 5))
			.toEqual([0, -1, -2, -2, -2]);

		// Opus needs 400 ms of preroll, i.e. 20 packets of 20 ms
		const opusRolls = await rollsFor('opus', { codec: 'opus', numberOfChannels: 2, sampleRate: 48000 }, 0.02, 25);
		expect(opusRolls).toEqual(Array.from({ length: 25 }, (_, i) => (i === 0 ? 0 : -Math.min(i, 20))));
	});

	test('PCM is stored with one sample per PCM frame and a constant sample size', async () => {
		const frames = [2048, 2048, 1000];
		const { bytes, boxes } = await mux([{
			kind: 'audio',
			codec: 'pcm-s16',
			config: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 },
			packets: frames.map((count, i) => ({
				timestamp: frames.slice(0, i).reduce((a, b) => a + b, 0) / 48000,
				duration: count / 48000,
				size: count * 4,
			})),
		}]);
		const stbl = findBox(boxes, 'moov/trak/mdia/minf/stbl');
		const total = 2048 + 2048 + 1000;
		expect(readStts(bytes, findBox(stbl.children, 'stts')).entries).toEqual([{ count: total, delta: 1 }]);
		const stsz = fullBoxReader(bytes, findBox(stbl.children, 'stsz')).reader;
		expect([stsz.u32(), stsz.u32()]).toEqual([4, total]);
		const stsc = readStsc(bytes, findBox(stbl.children, 'stsc'));
		const chunkCount = readSampleTable(bytes, traks(boxes)[0]!).chunkOffsets.length;
		expect(stsc.entries.reduce((sum, entry, i, all) => {
			const nextFirstChunk = all[i + 1]?.firstChunk ?? chunkCount + 1;
			return sum + (nextFirstChunk - entry.firstChunk) * entry.samplesPerChunk;
		}, 0)).toBe(total);
		expect(readMdhd(bytes, findBox(boxes, 'moov/trak/mdia/mdhd')).duration).toBe(total);
	});
});

describe('Edit lists', () => {
	test('tracks starting at zero have no edit list', async () => {
		const { boxes } = await mux([
			{ kind: 'video', packets: videoPackets(5) },
			{ kind: 'audio', packets: audioPackets(5) },
		]);
		expect(findBoxes(boxes, 'moov/trak/edts')).toHaveLength(0);
	});

	test('a positive start time becomes an empty edit followed by the media', async () => {
		const { bytes, boxes } = await mux([{ kind: 'video', packets: videoPackets(30, { start: 1.5 }) }]);
		const trak = traks(boxes)[0]!;
		expect(readElst(bytes, findBox(trak.children, 'edts/elst'))).toEqual({
			version: 0,
			entries: [
				{ segmentDuration: 1.5 * MOVIE_TIMESCALE, mediaTime: -1, mediaRate: 1 },
				{ segmentDuration: MOVIE_TIMESCALE, mediaTime: 0, mediaRate: 1 },
			],
		});
		expect(readTkhd(bytes, findBox(trak.children, 'tkhd')).duration).toBe(2.5 * MOVIE_TIMESCALE);
		expect(readMvhd(bytes, findBox(boxes, 'moov/mvhd')).duration).toBe(2.5 * MOVIE_TIMESCALE);
		// The samples themselves start at media time 0
		expect(readSampleTable(bytes, trak).samples[0]!.dts).toBe(0);
	});

	test('a negative start time (encoder priming) becomes a media time offset', async () => {
		const { bytes, boxes } = await mux([{ kind: 'audio', packets: audioPackets(48, { start: -AAC_FRAME }) }]);
		const trak = traks(boxes)[0]!;
		const visibleDuration = Math.round(48 * AAC_FRAME * MOVIE_TIMESCALE) - Math.round(AAC_FRAME * MOVIE_TIMESCALE);
		expect(readElst(bytes, findBox(trak.children, 'edts/elst'))).toEqual({
			version: 0,
			entries: [{ segmentDuration: visibleDuration, mediaTime: 1024, mediaRate: 1 }],
		});
		expect(readTkhd(bytes, findBox(trak.children, 'tkhd')).duration).toBe(visibleDuration);
		expect(readMdhd(bytes, findBox(trak.children, 'mdia/mdhd')).duration).toBe(48 * 1024);
	});

	test('fragmented files only use edit lists for negative start times, with an open-ended duration', async () => {
		const format = () => new Mp4OutputFormat({ fastStart: 'fragmented' });
		const primed: TrackSpec = { kind: 'audio', packets: audioPackets(48, { start: -AAC_FRAME }) };
		let file = await mux([primed], { format: format() });
		expect(readElst(file.bytes, findBox(file.boxes, 'moov/trak/edts/elst')).entries).toEqual([
			{ segmentDuration: 0, mediaTime: 1024, mediaRate: 1 },
		]);
		expect(readTfdt(file.bytes, findBox(file.boxes, 'moof/traf/tfdt')).baseMediaDecodeTime).toBe(0);

		file = await mux([{ kind: 'video', packets: videoPackets(30, { start: 2 }) }], { format: format() });
		expect(findBoxes(file.boxes, 'moov/trak/edts')).toHaveLength(0);
		expect(readTfdt(file.bytes, findBox(file.boxes, 'moof/traf/tfdt')).baseMediaDecodeTime)
			.toBe(2 * MOVIE_TIMESCALE);
	});

	test('timestamps round-trip through the demuxer for positive and negative starts', async () => {
		for (const fastStart of [false, 'in-memory', 'fragmented'] as const) {
			for (const start of [-0.5, 0, 3.25]) {
				const packets = videoPackets(20, { start, gop: 5 });
				const format = new Mp4OutputFormat({ fastStart });
				const { bytes } = await mux([{ kind: 'video', packets }], { format });
				using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
				const track = (await input.getPrimaryVideoTrack())!;
				const read: number[] = [];
				for await (const packet of new EncodedPacketSink(track).packets()) {
					read.push(packet.timestamp);
				}
				expect(read).toHaveLength(packets.length);
				read.forEach((timestamp, i) => expect(timestamp).toBeCloseTo(packets[i]!.timestamp, 4));
			}
		}
	});
});

/** Parses an MPEG-4 descriptor (tag + expandable size) tree, as used inside esds. */
type Descriptor = {
	tag: number;
	body: Uint8Array;
	children: Descriptor[];
};

const readDescriptors = (bytes: Uint8Array, start: number, end: number): Descriptor[] => {
	const result: Descriptor[] = [];
	let pos = start;
	while (pos < end) {
		const tag = bytes[pos++]!;
		let size = 0;
		let byte: number;
		do {
			byte = bytes[pos++]!;
			size = (size << 7) | (byte & 0x7f);
		} while (byte & 0x80);
		const body = bytes.subarray(pos, pos + size);
		let children: Descriptor[] = [];
		if (tag === 3) {
			children = readDescriptors(bytes, pos + 3, pos + size); // ES_ID (2) + flags (1)
		} else if (tag === 4) {
			children = readDescriptors(bytes, pos + 13, pos + size); // Fixed DecoderConfigDescriptor fields
		}
		result.push({ tag, body, children });
		pos += size;
	}
	return result;
};

const sampleEntry = (boxes: ParsedBox[], trackIndex = 0) => {
	const stsd = findBox(traks(boxes)[trackIndex]!.children, 'mdia/minf/stbl/stsd');
	expect(stsd.children).toHaveLength(1);
	return stsd.children[0]!;
};

const boxPayload = (bytes: Uint8Array, box: ParsedBox) => bytes.slice(box.contentStart, box.end);

describe('Video sample entries', () => {
	const avcDescription = new Uint8Array([
		0x01, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xc0, 0x1e, 0x01, 0x00, 0x02, 0x68, 0xce,
	]);

	test('avc1 holds the visual sample entry fields and the avcC from the description', async () => {
		const { bytes, boxes } = await mux([{
			kind: 'video',
			codec: 'avc',
			config: { codec: 'avc1.42c01e', codedWidth: 1280, codedHeight: 720, description: avcDescription },
			packets: videoPackets(3),
		}]);
		const entry = sampleEntry(boxes);
		expect(entry.type).toBe('avc1');
		const fields = readVisualSampleEntry(bytes, entry);
		expect(fields).toMatchObject({
			dataReferenceIndex: 1,
			width: 1280,
			height: 720,
			horizResolution: 72,
			vertResolution: 72,
			frameCount: 1,
			depth: 24,
			preDefined: -1,
		});
		expect(fields.compressorName).toMatch(/^Mediabunny/);
		expect(boxPayload(bytes, findBox(entry.children, 'avcC'))).toEqual(avcDescription);
	});

	test('avc3 codec strings use the avc3 sample entry', async () => {
		const { boxes } = await mux([{
			kind: 'video',
			codec: 'avc',
			config: { codec: 'avc3.42c01e', codedWidth: 64, codedHeight: 64, description: avcDescription },
			packets: videoPackets(3),
		}]);
		expect(sampleEntry(boxes).type).toBe('avc3');
	});

	test('Annex B AVC packets are converted to length-prefixed samples with an avcC built from SPS/PPS', async () => {
		// Baseline SPS/PPS from x264 (64x64)
		const sps = [
			0x67, 0x42, 0xc0, 0x0a, 0xd9, 0x1e, 0x84, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xc8, 0x3c,
			0x48, 0x99, 0x20,
		];
		const pps = [0x68, 0xcb, 0x83, 0xcb, 0x20];
		const slice = [0x65, 0x88, 0x84, 0x00, 0x33];
		const keyPacket = new Uint8Array([0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps, 0, 0, 1, ...slice]);
		const deltaPacket = new Uint8Array([0, 0, 0, 1, 0x41, 0x9a, 0x02, 0x03]);

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source);
		await output.start();
		const meta = { decoderConfig: { codec: 'avc1.42c00a', codedWidth: 64, codedHeight: 64 } };
		await source.add(new EncodedPacket(keyPacket, 'key', 0, 1 / 30), meta);
		await source.add(new EncodedPacket(deltaPacket, 'delta', 1 / 30, 1 / 30), meta);
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		const boxes = parseBoxes(bytes);
		const avcC = boxPayload(bytes, findBox(sampleEntry(boxes).children, 'avcC'));
		expect([...avcC.subarray(0, 4)]).toEqual([1, 0x42, 0xc0, 0x0a]); // version, profile, compatibility, level
		expect(avcC[4]! & 0x03).toBe(3); // 4-byte NAL unit lengths
		expect(avcC[5]! & 0x1f).toBe(1);
		expect([...avcC.subarray(6, 8)]).toEqual([0, sps.length]);
		expect([...avcC.subarray(8, 8 + sps.length)]).toEqual(sps);
		expect(avcC[8 + sps.length]).toBe(1);
		expect([...avcC.subarray(9 + sps.length)]).toEqual([0, pps.length, ...pps]);

		const { samples } = readSampleTable(bytes, traks(boxes)[0]!);
		const first = bytes.subarray(samples[0]!.offset, samples[0]!.offset + samples[0]!.size);
		expect([...first]).toEqual([
			0, 0, 0, sps.length, ...sps, 0, 0, 0, pps.length, ...pps, 0, 0, 0, slice.length, ...slice,
		]);
		const second = bytes.subarray(samples[1]!.offset, samples[1]!.offset + samples[1]!.size);
		expect([...second]).toEqual([0, 0, 0, 4, 0x41, 0x9a, 0x02, 0x03]);
	});

	test('hvc1 holds the hvcC from the description', async () => {
		const hvcC = new Uint8Array(23);
		hvcC[0] = 1;
		hvcC[21] = 0x03; // lengthSizeMinusOne = 3
		const { bytes, boxes } = await mux([{
			kind: 'video',
			codec: 'hevc',
			config: { codec: 'hvc1.1.6.L93.B0', codedWidth: 64, codedHeight: 64, description: hvcC },
			packets: videoPackets(3),
		}]);
		const entry = sampleEntry(boxes);
		expect(entry.type).toBe('hvc1');
		expect(boxPayload(bytes, findBox(entry.children, 'hvcC'))).toEqual(hvcC);
	});

	test('vp09 vpcC (version 1) takes profile, level, bit depth and color from the full codec string', async () => {
		const { bytes, boxes } = await mux([{
			kind: 'video',
			config: { codec: 'vp09.02.10.10.01.09.16.09.01', codedWidth: 64, codedHeight: 64 },
			packets: videoPackets(3),
		}]);
		const entry = sampleEntry(boxes);
		expect(entry.type).toBe('vp09');
		const { reader, version, flags } = fullBoxReader(bytes, findBox(entry.children, 'vpcC'));
		expect([version, flags]).toEqual([1, 0]);
		expect(reader.u8()).toBe(2); // profile
		expect(reader.u8()).toBe(10); // level
		const packed = reader.u8();
		expect([packed >> 4, (packed >> 1) & 0x7, packed & 1]).toEqual([10, 1, 1]); // bit depth, subsampling, range
		expect([reader.u8(), reader.u8(), reader.u8()]).toEqual([9, 16, 9]);
		expect(reader.u16()).toBe(0); // No codec initialization data
		expect(reader.remaining()).toBe(0);
	});

	test('vp09 vpcC falls back to the decoder config\'s color space for short codec strings', async () => {
		const { bytes, boxes } = await mux([{
			kind: 'video',
			config: {
				codec: 'vp09.00.31.08',
				codedWidth: 64,
				codedHeight: 64,
				colorSpace: { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: true },
			},
			packets: videoPackets(3),
		}]);
		const { reader } = fullBoxReader(bytes, findBox(sampleEntry(boxes).children, 'vpcC'));
		expect([reader.u8(), reader.u8()]).toEqual([0, 31]);
		const packed = reader.u8();
		expect([packed >> 4, (packed >> 1) & 0x7, packed & 1]).toEqual([8, 1, 1]);
		expect([reader.u8(), reader.u8(), reader.u8()]).toEqual([6, 6, 6]);
	});

	test('av01 av1C carries profile, level, tier, bit depth and chroma layout from the codec string', async () => {
		const av1CFor = async (codec: string) => {
			const { bytes, boxes } = await mux([{
				kind: 'video',
				codec: 'av1',
				config: { codec, codedWidth: 64, codedHeight: 64 },
				packets: videoPackets(2),
			}]);
			const entry = sampleEntry(boxes);
			expect(entry.type).toBe('av01');
			return [...boxPayload(bytes, findBox(entry.children, 'av1C'))];
		};

		// marker|version, profile|level, tier|high_bitdepth|twelve_bit|mono|ss_x|ss_y|csp, no presentation delay
		expect(await av1CFor('av01.0.04M.08')).toEqual([0x81, 0x04, 0x0c, 0x00]);
		expect(await av1CFor('av01.0.13H.10')).toEqual([0x81, 0x0d, 0xcc, 0x00]);
		expect(await av1CFor('av01.2.08M.12.0.110.09.16.09.1')).toEqual([0x81, 0x48, 0x6c, 0x00]);
		expect(await av1CFor('av01.1.05M.08.0.000.01.01.01.0')).toEqual([0x81, 0x25, 0x00, 0x00]);
	});

	test('ProRes in MOV uses the codec\'s four-character code and a depth of 32 for 4444', async () => {
		for (const [codec, depth] of [['apcn', 24], ['ap4h', 32], ['ap4x', 32]] as const) {
			const { bytes, boxes } = await mux([{
				kind: 'video',
				codec: 'prores',
				config: { codec, codedWidth: 64, codedHeight: 64 },
				packets: videoPackets(2),
			}], { format: new MovOutputFormat() });
			const entry = sampleEntry(boxes);
			expect(entry.type).toBe(codec);
			expect(readVisualSampleEntry(bytes, entry).depth).toBe(depth);
			expect(entry.children.map(child => child.type)).toEqual(['btrt']); // No decoder configuration box
		}
	});

	test('colr is nclx with a full range flag in MP4, nclc in MOV, and absent without color info', async () => {
		const config: VideoDecoderConfig = {
			...VP9_CONFIG,
			colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: true },
		};
		let file = await mux([{ kind: 'video', config, packets: videoPackets(2) }]);
		let colr = fieldReader(file.bytes, findBox(sampleEntry(file.boxes).children, 'colr'));
		expect([colr.fourCc(), colr.u16(), colr.u16(), colr.u16(), colr.u8()]).toEqual(['nclx', 1, 13, 1, 0x80]);
		expect(colr.remaining()).toBe(0);

		file = await mux([{ kind: 'video', config, packets: videoPackets(2) }], { format: new MovOutputFormat() });
		colr = fieldReader(file.bytes, findBox(sampleEntry(file.boxes).children, 'colr'));
		expect([colr.fourCc(), colr.u16(), colr.u16(), colr.u16()]).toEqual(['nclc', 1, 13, 1]);
		expect(colr.remaining()).toBe(0);

		file = await mux([{ kind: 'video', packets: videoPackets(2) }]);
		expect(hasBox(sampleEntry(file.boxes).children, 'colr')).toBe(false);
	});

	test('pasp holds the reduced pixel aspect ratio from the display aspect', async () => {
		const { bytes, boxes } = await mux([{
			kind: 'video',
			config: {
				...VP9_CONFIG, codedWidth: 480, codedHeight: 360, displayAspectWidth: 640, displayAspectHeight: 360,
			},
			packets: videoPackets(2),
		}]);
		const pasp = fieldReader(bytes, findBox(sampleEntry(boxes).children, 'pasp'));
		expect([pasp.u32(), pasp.u32()]).toEqual([4, 3]);

		const square = await mux([{ kind: 'video', packets: videoPackets(2) }]);
		expect(hasBox(sampleEntry(square.boxes).children, 'pasp')).toBe(false);
	});

	test('btrt reports the measured peak and average bitrates', async () => {
		// 30 frames of 1000 bytes over one second: 240 kbit/s in any one-second window
		const { bytes, boxes } = await mux([{
			kind: 'video', packets: videoPackets(60, { size: 1000 }),
		}]);
		const btrt = fieldReader(bytes, findBox(sampleEntry(boxes).children, 'btrt'));
		expect(btrt.u32()).toBe(0); // Buffer size unknown
		const maxBitrate = btrt.u32();
		expect(btrt.u32()).toBe(240_000);
		// The one-second window compares float timestamps, so it can catch one frame more than a second's worth
		expect(maxBitrate).toBeGreaterThanOrEqual(240_000);
		expect(maxBitrate).toBeLessThanOrEqual(248_000);
	});

	test('fragmented files take btrt from the track metadata and omit it without', async () => {
		const format = () => new Mp4OutputFormat({ fastStart: 'fragmented' });
		let file = await mux([{
			kind: 'video', packets: videoPackets(10), metadata: { bitrate: 5_000_000, averageBitrate: 3_000_000 },
		}], { format: format() });
		const btrt = fieldReader(file.bytes, findBox(sampleEntry(file.boxes).children, 'btrt'));
		expect([btrt.u32(), btrt.u32(), btrt.u32()]).toEqual([0, 5_000_000, 3_000_000]);

		file = await mux([{ kind: 'video', packets: videoPackets(10) }], { format: format() });
		expect(hasBox(sampleEntry(file.boxes).children, 'btrt')).toBe(false);
	});
});

describe('Audio sample entries', () => {
	const muxAudio = async (
		codec: AudioCodec,
		config: AudioDecoderConfig,
		options: {
			format?: IsobmffOutputFormat;
			frame?: number;
			data?: (i: number) => Uint8Array;
			count?: number;
		} = {},
	) => mux([{
		kind: 'audio',
		codec,
		config,
		packets: audioPackets(options.count ?? 3, { frame: options.frame ?? 0.02 }),
		data: options.data,
	}], { format: options.format });

	test('mp4a for AAC holds an esds with the AudioSpecificConfig, object type 0x40 and bitrates', async () => {
		const { bytes, boxes } = await muxAudio('aac', AAC_CONFIG, { frame: AAC_FRAME, count: 47 });
		const entry = sampleEntry(boxes);
		expect(entry.type).toBe('mp4a');
		expect(readAudioSampleEntry(bytes, entry)).toMatchObject({
			dataReferenceIndex: 1, version: 0, channelCount: 2, sampleSize: 16, compressionId: 0, sampleRate: 48000,
		});

		const esds = findBox(entry.children, 'esds');
		const { version, flags } = fullBoxReader(bytes, esds);
		expect([version, flags]).toEqual([0, 0]);
		const [es] = readDescriptors(bytes, esds.contentStart + 4, esds.end);
		expect(es!.tag).toBe(3);
		const [decoderConfig, slConfig] = es!.children;
		expect(decoderConfig!.tag).toBe(4);
		expect(decoderConfig!.body[0]).toBe(0x40); // MPEG-4 audio
		expect(decoderConfig!.body[1]! >> 2).toBe(5); // Audio stream
		const view = new DataView(decoderConfig!.body.buffer, decoderConfig!.body.byteOffset);
		const maxBitrate = view.getUint32(5);
		const avgBitrate = view.getUint32(9);
		expect(avgBitrate).toBe(Math.round(8 * 47 * 24 / (47 * AAC_FRAME)));
		expect(maxBitrate).toBeGreaterThanOrEqual(avgBitrate);
		expect(decoderConfig!.children).toHaveLength(1);
		expect(decoderConfig!.children[0]!.tag).toBe(5);
		expect([...decoderConfig!.children[0]!.body]).toEqual([0x11, 0x90]);
		expect(slConfig!.tag).toBe(6);
		expect([...slConfig!.body]).toEqual([2]);
	});

	test('mp4a for MP3 uses object type 0x6B without decoder specific info', async () => {
		const { bytes, boxes } = await muxAudio('mp3', { codec: 'mp3', numberOfChannels: 2, sampleRate: 44100 }, {
			frame: 1152 / 44100,
		});
		const entry = sampleEntry(boxes);
		expect(entry.type).toBe('mp4a');
		const esds = findBox(entry.children, 'esds');
		const [es] = readDescriptors(bytes, esds.contentStart + 4, esds.end);
		const decoderConfig = es!.children[0]!;
		expect(decoderConfig.body[0]).toBe(0x6b);
		expect(decoderConfig.children).toHaveLength(0);
	});

	test('MOV writes compressed audio with a version 1 sound description', async () => {
		const { bytes, boxes } = await muxAudio('aac', AAC_CONFIG, { format: new MovOutputFormat(), frame: AAC_FRAME });
		const entry = sampleEntry(boxes);
		expect(entry.type).toBe('mp4a');
		expect(readAudioSampleEntry(bytes, entry)).toMatchObject({
			version: 1, channelCount: 2, sampleSize: 16, compressionId: -2, sampleRate: 48000,
		});
		expect(hasBox(entry.children, 'esds')).toBe(true);
	});

	test('ADTS input gets an AudioSpecificConfig from the header and loses the header in the samples', async () => {
		// ADTS header: AAC-LC, 44.1 kHz (index 4), 2 channels, without and with CRC
		const adts = (payload: number[], crc: boolean) => {
			const length = (crc ? 9 : 7) + payload.length;
			return new Uint8Array([
				0xff, crc ? 0xf0 : 0xf1, 0x50, 0x80 | (length >> 11), (length >> 3) & 0xff,
				((length & 7) << 5) | 0x1f, 0xfc,
				...(crc ? [0x12, 0x34] : []),
				...payload,
			]);
		};

		for (const crc of [false, true]) {
			const config = { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 44100 };
			const { bytes, boxes } = await muxAudio('aac', config, {
				frame: 1024 / 44100,
				data: i => adts([0x21, 0x10, i], crc),
			});
			const esds = findBox(sampleEntry(boxes).children, 'esds');
			const [es] = readDescriptors(bytes, esds.contentStart + 4, esds.end);
			expect([...es!.children[0]!.children[0]!.body]).toEqual([0x12, 0x10]); // LC, 44.1 kHz, stereo

			const { samples } = readSampleTable(bytes, traks(boxes)[0]!);
			samples.forEach((sample, i) => {
				expect([...bytes.subarray(sample.offset, sample.offset + sample.size)]).toEqual([0x21, 0x10, i]);
			});
		}
	});

	test('Opus holds a big-endian dOps translated from the OpusHead description', async () => {
		const opusHead = new Uint8Array([
			...new TextEncoder().encode('OpusHead'), 1, 2, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00, 0xfe, 0xff, 0,
		]);
		const { bytes, boxes } = await muxAudio(
			'opus',
			{ codec: 'opus', numberOfChannels: 2, sampleRate: 48000, description: opusHead },
			{ data: () => new Uint8Array([0x08, 0, 0]) },
		);
		const entry = sampleEntry(boxes);
		expect(entry.type).toBe('Opus');
		expect(readAudioSampleEntry(bytes, entry)).toMatchObject({
			channelCount: 2, sampleSize: 16, sampleRate: 48000,
		});
		const dOps = fieldReader(bytes, findBox(entry.children, 'dOps'));
		expect(dOps.u8()).toBe(0); // Version
		expect(dOps.u8()).toBe(2); // OutputChannelCount
		expect(dOps.u16()).toBe(312); // PreSkip
		expect(dOps.u32()).toBe(48000); // InputSampleRate
		expect(dOps.i16()).toBe(-2); // OutputGain
		expect(dOps.u8()).toBe(0); // ChannelMappingFamily
		expect(dOps.remaining()).toBe(0);
	});

	test('Opus with channel mapping family 1 keeps the channel mapping table', async () => {
		const opusHead = new Uint8Array([
			...new TextEncoder().encode('OpusHead'), 1, 6, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 1,
			4, 2, 0, 4, 1, 2, 3, 5,
		]);
		const { bytes, boxes } = await muxAudio(
			'opus',
			{ codec: 'opus', numberOfChannels: 6, sampleRate: 48000, description: opusHead },
			{ data: () => new Uint8Array([0x08, 0, 0]) },
		);
		const entry = sampleEntry(boxes);
		expect(readAudioSampleEntry(bytes, entry).channelCount).toBe(6);
		const dOps = fieldReader(bytes, findBox(entry.children, 'dOps'));
		dOps.skip(10);
		expect(dOps.u8()).toBe(1); // ChannelMappingFamily
		expect([...dOps.bytesUntil()]).toEqual([4, 2, 0, 4, 1, 2, 3, 5]); // Streams, coupled, mapping
	});

	test('Opus without a description gets a default dOps', async () => {
		const { bytes, boxes } = await muxAudio(
			'opus',
			{ codec: 'opus', numberOfChannels: 1, sampleRate: 48000 },
			{ data: () => new Uint8Array([0x08, 0, 0]) },
		);
		const dOps = fieldReader(bytes, findBox(sampleEntry(boxes).children, 'dOps'));
		expect([dOps.u8(), dOps.u8(), dOps.u16(), dOps.u32(), dOps.i16(), dOps.u8()]).toEqual([0, 1, 312, 48000, 0, 0]);
	});

	test('fLaC holds a dfLa FullBox with the metadata blocks from the description', async () => {
		const streamInfo = [
			0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0xc4, 0x42, 0xf0, 0, 0, 0, 0,
			...Array<number>(16).fill(0),
		];
		const description = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, ...streamInfo]);
		const { bytes, boxes } = await muxAudio(
			'flac', { codec: 'flac', numberOfChannels: 2, sampleRate: 44100, description }, { frame: 4096 / 44100 },
		);
		const entry = sampleEntry(boxes);
		expect(entry.type).toBe('fLaC');
		expect(readAudioSampleEntry(bytes, entry)).toMatchObject({ channelCount: 2, sampleRate: 44100 });
		const dfLa = findBox(entry.children, 'dfLa');
		const { reader, version, flags } = fullBoxReader(bytes, dfLa);
		expect([version, flags]).toEqual([0, 0]);
		expect([...reader.bytesUntil()]).toEqual([0x80, 0, 0, 34, ...streamInfo]);
	});

	test('AC-3 and E-AC-3 get dac3/dec3 boxes derived from the first sync frame', async () => {
		// Headers of a 448 kbit/s 5.1 frame at 48 kHz from FFmpeg's ac3 and eac3 encoders; FFmpeg writes the same
		// dac3 bytes, and the same dec3 fields
		const ac3Frame = new Uint8Array([
			0x0b, 0x77, 0xb5, 0x0b, 0x1e, 0x40, 0xeb, 0xf8, 0x40, 0x3e, 0xff, 0x99, 0xff, 0x08, 0x41, 0xfc,
		]);
		const eac3Frame = new Uint8Array([
			0x0b, 0x77, 0x03, 0x7f, 0x3f, 0x87, 0xc0, 0x00, 0x20, 0xf8, 0x20, 0x00, 0x02, 0x00, 0x40, 0x00,
			0x04, 0x00, 0x1f, 0xcc, 0x7e, 0x01, 0x07, 0xe1,
		]);

		let file = await muxAudio('ac3', { codec: 'ac-3', numberOfChannels: 6, sampleRate: 48000 }, {
			frame: 1536 / 48000, data: () => ac3Frame,
		});
		let entry = sampleEntry(file.boxes);
		expect(entry.type).toBe('ac-3');
		expect([...boxPayload(file.bytes, findBox(entry.children, 'dac3'))]).toEqual([0x10, 0x3d, 0xe0]);

		file = await muxAudio('eac3', { codec: 'ec-3', numberOfChannels: 6, sampleRate: 48000 }, {
			frame: 1536 / 48000, data: () => eac3Frame,
		});
		entry = sampleEntry(file.boxes);
		expect(entry.type).toBe('ec-3');
		expect([...boxPayload(file.bytes, findBox(entry.children, 'dec3'))]).toEqual([0x0e, 0x00, 0x20, 0x0f, 0x00]);
	});

	test('AC-3, E-AC-3, DTS and TrueHD config boxes survive a remux byte for byte', async () => {
		for (const [file, configBox] of [
			['ac3.mp4', 'dac3'], ['eac3.mp4', 'dec3'], ['toothsome-dts.mp4', 'ddts'], ['truehd.mp4', 'dmlp'],
		] as const) {
			const sourceBytes = new Uint8Array(fs.readFileSync(path.join(__dirname, '../public', file)));
			using input = new Input({ source: new BufferSource(sourceBytes), formats: ALL_FORMATS });
			const track = (await input.getPrimaryAudioTrack())!;
			const codec = (await track.getCodec())!;
			const decoderConfig = (await track.getDecoderConfig())!;

			const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
			const source = new EncodedAudioPacketSource(codec);
			output.addAudioTrack(source);
			await output.start();
			let count = 0;
			for await (const packet of new EncodedPacketSink(track).packets()) {
				await source.add(packet, { decoderConfig });
				if (++count === 10) {
					break;
				}
			}
			await output.finalize();

			const bytes = new Uint8Array(output.target.buffer!);
			const written = sampleEntry(parseBoxes(bytes));
			const original = sampleEntry(parseBoxes(sourceBytes));
			expect(written.type).toBe(original.type);
			expect(readAudioSampleEntry(bytes, written).channelCount)
				.toBe(readAudioSampleEntry(sourceBytes, original).channelCount);
			expect(boxPayload(bytes, findBox(written.children, configBox)))
				.toEqual(boxPayload(sourceBytes, findBox(original.children, configBox)));
		}
	});

	test('16-bit PCM in MP4 uses ipcm with a pcmC box describing the sample format', async () => {
		for (const [codec, littleEndian] of [['pcm-s16', true], ['pcm-s16be', false]] as const) {
			const { bytes, boxes } = await muxAudio(codec, { codec, numberOfChannels: 2, sampleRate: 44100 }, {
				data: () => new Uint8Array(4 * 441),
				frame: 441 / 44100,
			});
			const entry = sampleEntry(boxes);
			expect(entry.type).toBe('ipcm');
			expect(readAudioSampleEntry(bytes, entry)).toMatchObject({
				version: 0, channelCount: 2, sampleSize: 16, sampleRate: 44100,
			});
			const { reader, version } = fullBoxReader(bytes, findBox(entry.children, 'pcmC'));
			expect([version, reader.u8(), reader.u8()]).toEqual([0, littleEndian ? 1 : 0, 16]);
		}
	});

	test('PCM in MOV uses the QuickTime formats with version 1 sound descriptions', async () => {
		const cases = [
			{ codec: 'pcm-s16', type: 'sowt', bytes: 2, endianBox: null },
			{ codec: 'pcm-s16be', type: 'twos', bytes: 2, endianBox: null },
			{ codec: 'pcm-s24', type: 'in24', bytes: 3, endianBox: 1 },
			{ codec: 'pcm-s24be', type: 'in24', bytes: 3, endianBox: 0 },
			{ codec: 'pcm-s32', type: 'in32', bytes: 4, endianBox: 1 },
			{ codec: 'pcm-f32be', type: 'fl32', bytes: 4, endianBox: 0 },
			{ codec: 'pcm-f64', type: 'fl64', bytes: 8, endianBox: 1 },
			{ codec: 'pcm-u8', type: 'raw ', bytes: 1, endianBox: null },
			{ codec: 'ulaw', type: 'ulaw', bytes: 1, endianBox: null },
			{ codec: 'alaw', type: 'alaw', bytes: 1, endianBox: null },
		] as const;

		for (const { codec, type, bytes: sampleBytes, endianBox } of cases) {
			const { bytes, boxes } = await muxAudio(codec, { codec, numberOfChannels: 2, sampleRate: 8000 }, {
				format: new MovOutputFormat(),
				data: () => new Uint8Array(2 * sampleBytes * 80),
				frame: 80 / 8000,
			});
			const entry = sampleEntry(boxes);
			expect(entry.type).toBe(type);
			const fields = readAudioSampleEntry(bytes, entry);
			expect(fields).toMatchObject({ version: 1, channelCount: 2, compressionId: 0, sampleRate: 8000 });
			expect(fields.sampleSize).toBe(Math.min(16, 8 * sampleBytes));
			expect(fields.v1).toMatchObject({
				samplesPerPacket: 1, bytesPerPacket: sampleBytes, bytesPerFrame: 2 * sampleBytes,
			});

			if (endianBox === null) {
				expect(hasBox(entry.children, 'wave')).toBe(false);
			} else {
				const wave = findBox(entry.children, 'wave');
				expect(fourCc(bytes, findBox(wave.children, 'frma').contentStart)).toBe(type);
				expect(fieldReader(bytes, findBox(wave.children, 'enda')).u16()).toBe(endianBox);
			}

			const { samples } = readSampleTable(bytes, traks(boxes)[0]!);
			expect(samples).toHaveLength(240); // One sample per PCM frame
			expect(samples[0]!.size).toBe(2 * sampleBytes);
		}
	});
});

type FragmentSample = {
	fragment: number;
	decodeTime: number;
	duration: number;
	size: number;
	flags: number;
	compositionOffset: number;
	offset: number;
};

/** Expands every moof of a fragmented file into per-track samples. */
const readFragments = (bytes: Uint8Array, boxes: ParsedBox[]) => {
	const tracks = new Map<number, FragmentSample[]>();
	const sequenceNumbers: number[] = [];
	boxes.filter(box => box.type === 'moof').forEach((moof, fragment) => {
		sequenceNumbers.push(fullBoxReader(bytes, findBox(moof.children, 'mfhd')).reader.u32());
		for (const traf of findBoxes(moof.children, 'traf')) {
			const tfhd = readTfhd(bytes, findBox(traf.children, 'tfhd'));
			const tfdt = readTfdt(bytes, findBox(traf.children, 'tfdt'));
			const truns = findBoxes(traf.children, 'trun').map(trun => readTrun(bytes, trun));
			expect(truns).toHaveLength(1);
			const trun = truns[0]!;
			expect(tfhd.defaultBaseIsMoof).toBe(true);

			const samples = tracks.get(tfhd.trackId) ?? [];
			tracks.set(tfhd.trackId, samples);
			let decodeTime = tfdt.baseMediaDecodeTime;
			let offset = moof.start + trun.dataOffset!;
			trun.samples.forEach((sample, i) => {
				const flags = sample.flags ?? (i === 0 && trun.firstSampleFlags !== null
					? trun.firstSampleFlags
					: tfhd.defaultSampleFlags!);
				const duration = sample.duration ?? tfhd.defaultSampleDuration!;
				const size = sample.size ?? tfhd.defaultSampleSize!;
				samples.push({
					fragment,
					decodeTime,
					duration,
					size,
					flags,
					compositionOffset: sample.compositionTimeOffset ?? 0,
					offset,
				});
				decodeTime += duration;
				offset += size;
			});
		}
	});
	return { tracks, sequenceNumbers };
};

const isSyncSample = (flags: number) => (flags & 0x10000) === 0;

describe('Fragmented MP4', () => {
	const fragmented = (options: IsobmffOutputFormatOptions = {}) => new Mp4OutputFormat({
		fastStart: 'fragmented', ...options,
	});

	test('moov declares every track in mvex/trex and holds no samples', async () => {
		const { bytes, boxes } = await mux([
			{ kind: 'video', packets: videoPackets(30) },
			{ kind: 'audio', packets: audioPackets(47) },
		], { format: fragmented() });

		const trexes = findBoxes(boxes, 'moov/mvex/trex').map((trex) => {
			const { reader } = fullBoxReader(bytes, trex);
			return [reader.u32(), reader.u32(), reader.u32(), reader.u32(), reader.u32()];
		});
		expect(trexes).toEqual([[1, 1, 0, 0, 0], [2, 1, 0, 0, 0]]);

		for (const trak of traks(boxes)) {
			const stbl = findBox(trak.children, 'mdia/minf/stbl');
			expect(readStts(bytes, findBox(stbl.children, 'stts')).entries).toEqual([]);
			expect(readStsc(bytes, findBox(stbl.children, 'stsc')).entries).toEqual([]);
			expect(readMdhd(bytes, findBox(trak.children, 'mdia/mdhd')).duration).toBe(0);
		}
		expect(readMvhd(bytes, findBox(boxes, 'moov/mvhd')).duration).toBe(0);
	});

	test('fragments reproduce every sample\'s decode time, duration, size, data and sync flag', async () => {
		const video = videoPackets(90, { gop: 30 });
		const audio = audioPackets(140);
		const { bytes, boxes } = await mux([
			{ kind: 'video', packets: video },
			{ kind: 'audio', packets: audio },
		], { format: fragmented() });
		const view = new DataView(bytes.buffer, bytes.byteOffset);
		const { tracks, sequenceNumbers } = readFragments(bytes, boxes);

		expect(sequenceNumbers).toEqual(sequenceNumbers.map((_, i) => i + 1));
		expect(sequenceNumbers.length).toBeGreaterThanOrEqual(3);

		const check = (samples: FragmentSample[], packets: TestPacket[], trackIndex: number, timescale: number) => {
			expect(samples).toHaveLength(packets.length);
			samples.forEach((sample, i) => {
				expect(sample.decodeTime).toBe(Math.round(packets[i]!.timestamp * timescale));
				expect(sample.duration).toBe(Math.round(packets[i]!.duration * timescale));
				expect(sample.compositionOffset).toBe(0);
				expect(isSyncSample(sample.flags)).toBe((packets[i]!.type ?? 'key') === 'key');
				expect(view.getUint16(sample.offset)).toBe(0xbeef);
				expect(view.getUint8(sample.offset + 2)).toBe(trackIndex);
				expect(view.getUint32(sample.offset + 3)).toBe(i);
			});
		};
		check(tracks.get(1)!, video, 0, MOVIE_TIMESCALE);
		check(tracks.get(2)!, audio, 1, 48000);
	});

	test('fragments start with a sync sample in every track and last at least minimumFragmentDuration', async () => {
		const { bytes, boxes } = await mux([
			{ kind: 'video', packets: videoPackets(150, { gop: 20 }) },
			{ kind: 'audio', packets: audioPackets(235) },
		], { format: fragmented({ minimumFragmentDuration: 1.5 }) });
		const { tracks } = readFragments(bytes, boxes);
		const video = tracks.get(1)!;

		const fragmentCount = video.at(-1)!.fragment + 1;
		for (let fragment = 0; fragment < fragmentCount; fragment++) {
			for (const samples of tracks.values()) {
				const first = samples.find(s => s.fragment === fragment);
				if (first) {
					expect(isSyncSample(first.flags)).toBe(true);
				}
			}
			const videoSamples = video.filter(s => s.fragment === fragment);
			if (fragment < fragmentCount - 1) {
				const last = videoSamples.at(-1)!;
				const span = last.decodeTime + last.duration - videoSamples[0]!.decodeTime;
				expect(span / MOVIE_TIMESCALE).toBeGreaterThanOrEqual(1.5);
			}
		}
		expect(fragmentCount).toBeGreaterThanOrEqual(2);
	});

	test('key frames inside a fragment keep their sync flag', async () => {
		const { bytes, boxes } = await mux([
			{ kind: 'video', packets: videoPackets(30, { gop: 5 }) },
		], { format: fragmented({ minimumFragmentDuration: 10 }) });
		const samples = readFragments(bytes, boxes).tracks.get(1)!;
		expect(new Set(samples.map(s => s.fragment)).size).toBe(1);
		expect(samples.map(s => isSyncSample(s.flags))).toEqual(samples.map((_, i) => i % 5 === 0));
	});

	test('sample flags mark key samples as independent and delta samples as dependent non-sync samples', async () => {
		const { bytes, boxes } = await mux([
			{ kind: 'video', packets: videoPackets(10, { gop: 10 }) },
		], { format: fragmented() });
		const samples = readFragments(bytes, boxes).tracks.get(1)!;
		expect(samples[0]!.flags).toBe(0x02000000); // sample_depends_on = 2
		samples.slice(1).forEach(s => expect(s.flags).toBe(0x01010000)); // depends_on = 1, non-sync
	});

	test('B-frame composition offsets are signed in trun version 1', async () => {
		const pattern = [0, 3, 1, 2, 6, 4, 5];
		const { bytes, boxes } = await mux([{
			kind: 'video',
			metadata: { frameRate: 30 },
			packets: pattern.map((frame, i) => ({
				type: i === 0 ? 'key' : 'delta', timestamp: frame / 30, duration: 1 / 30,
			})),
		}], { format: fragmented() });
		const trun = readTrun(bytes, findBox(boxes, 'moof/traf/trun'));
		expect(trun.version).toBe(1);
		const samples = readFragments(bytes, boxes).tracks.get(1)!;
		expect(samples.map(s => s.decodeTime + s.compositionOffset)).toEqual(pattern);
		expect(samples.map(s => s.decodeTime)).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	test('mfra indexes the first sync sample of every fragment and mfro holds the mfra size', async () => {
		const { bytes, boxes } = await mux([
			{ kind: 'video', packets: videoPackets(90, { gop: 30 }) },
			{ kind: 'audio', packets: audioPackets(140) },
		], { format: fragmented() });
		const mfra = boxes.at(-1)!;
		expect(mfra.type).toBe('mfra');
		const mfro = findBox(mfra.children, 'mfro');
		expect(fullBoxReader(bytes, mfro).reader.u32()).toBe(mfra.size);
		expect(mfro.end).toBe(bytes.byteLength);

		const moofs = boxes.filter(box => box.type === 'moof');
		const { tracks } = readFragments(bytes, boxes);
		const tfras = findBoxes(mfra.children, 'tfra');
		expect(tfras).toHaveLength(2);
		for (const tfra of tfras) {
			const { reader, version } = fullBoxReader(bytes, tfra);
			expect(version).toBe(1);
			const trackId = reader.u32();
			expect(reader.u32() & 0x3f).toBe(0x3f); // 4-byte traf/trun/sample numbers
			const count = reader.u32();
			const samples = tracks.get(trackId)!;
			expect(count).toBe(new Set(samples.map(s => s.fragment)).size);
			for (let i = 0; i < count; i++) {
				const time = reader.u64();
				const moofOffset = reader.u64();
				const trafNumber = reader.u32();
				const trunNumber = reader.u32();
				const sampleNumber = reader.u32();
				const moofIndex = moofs.findIndex(moof => moof.start === moofOffset);
				expect(moofIndex).toBeGreaterThanOrEqual(0);
				const trafs = findBoxes(moofs[moofIndex]!.children, 'traf');
				expect(readTfhd(bytes, findBox(trafs[trafNumber - 1]!.children, 'tfhd')).trackId).toBe(trackId);
				expect(trunNumber).toBe(1);
				const fragmentSamples = samples.filter(s => s.fragment === moofIndex);
				const sample = fragmentSamples[sampleNumber - 1]!;
				expect(isSyncSample(sample.flags)).toBe(true);
				expect(time).toBe(sample.decodeTime + sample.compositionOffset); // Presentation time
			}
		}
	});

	test('tracks that end early simply stop appearing in later fragments', async () => {
		const { bytes, boxes } = await mux([
			{ kind: 'video', packets: videoPackets(150, { gop: 30 }) },
			{ kind: 'audio', packets: audioPackets(47) },
		], { format: fragmented() });
		const { tracks } = readFragments(bytes, boxes);
		expect(tracks.get(1)).toHaveLength(150);
		expect(tracks.get(2)).toHaveLength(47);
		const lastAudioFragment = tracks.get(2)!.at(-1)!.fragment;
		expect(tracks.get(1)!.at(-1)!.fragment).toBeGreaterThan(lastAudioFragment);
	});

	test('callbacks receive each box\'s exact bytes and position', async () => {
		const seen: { type: string; data: Uint8Array; position: number; timestamp?: number }[] = [];
		const format = fragmented({
			onFtyp: (data, position) => seen.push({ type: 'ftyp', data: data.slice(), position }),
			onMoov: (data, position) => seen.push({ type: 'moov', data: data.slice(), position }),
			onMoof: (data, position, timestamp) => seen.push({ type: 'moof', data: data.slice(), position, timestamp }),
			onMdat: (data, position) => seen.push({ type: 'mdat', data: data.slice(), position }),
		});
		const track: TrackSpec = { kind: 'video', packets: videoPackets(90, { gop: 30, start: 1 }) };
		const { bytes, boxes } = await mux([track], { format });

		const expected = boxes.filter(box => box.type !== 'mfra');
		expect(seen.map(s => s.type)).toEqual(expected.map(box => box.type));
		seen.forEach((s, i) => {
			expect(s.position).toBe(expected[i]!.start);
			expect(s.data).toEqual(bytes.subarray(expected[i]!.start, expected[i]!.end));
		});
		expect(seen.filter(s => s.type === 'moof').map(s => s.timestamp)).toEqual([1, 2, 3]);
	});
});

describe('CMAF', () => {
	test('the init segment holds ftyp and moov, the segment styp, sidx, moof and mdat', async () => {
		const { bytes, boxes, init, initBoxes } = await mux([
			{ kind: 'video', packets: videoPackets(60, { gop: 30 }) },
		], { format: new CmafOutputFormat() });

		expect(topLevelTypes(initBoxes!)).toEqual(['ftyp', 'moov']);
		expect(hasBox(initBoxes!, 'moov/mvex/trex')).toBe(true);
		expect(topLevelTypes(boxes)).toEqual(['styp', 'sidx', 'moof', 'mdat']);
		expect(init!.byteLength).toBe(initBoxes!.at(-1)!.end);

		const styp = fieldReader(bytes, boxes[0]!);
		expect([styp.fourCc(), styp.u32(), styp.fourCc(), styp.fourCc(), styp.fourCc(), styp.fourCc(), styp.fourCc()])
			.toEqual(['iso5', 0, 'iso5', 'iso6', 'mp41', 'cmfc', 'dash']);

		const sidx = fullBoxReader(bytes, boxes[1]!);
		expect(sidx.version).toBe(1);
		sidx.reader.u32(); // reference_ID
		const timescale = sidx.reader.u32();
		expect(sidx.reader.u64()).toBe(0); // earliest_presentation_time
		expect(sidx.reader.u64()).toBe(0); // first_offset
		sidx.reader.u16();
		expect(sidx.reader.u16()).toBe(1); // reference_count
		const reference = sidx.reader.u32();
		expect(reference >>> 31).toBe(0); // reference_type: media
		expect(reference & 0x7fffffff).toBe(boxes[3]!.end - boxes[2]!.start); // moof + mdat
		expect(sidx.reader.u32() / timescale).toBeCloseTo(2, 6); // subsegment_duration
	});

	test('a CMAF segment can be cut into several fragments', async () => {
		const { boxes } = await mux([
			{ kind: 'video', packets: videoPackets(90, { gop: 30 }) },
		], { format: new CmafOutputFormat({ minimumFragmentDuration: 1 }) });
		expect(topLevelTypes(boxes)).toEqual(['styp', 'sidx', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat']);
	});

	test('CMAF requires an init target', async () => {
		const output = new Output({ format: new CmafOutputFormat(), target: new BufferTarget() });
		output.addVideoTrack(new EncodedVideoPacketSource('vp9'));
		await expect(output.start()).rejects.toThrow('initTarget');
	});
});

describe('Metadata tags', () => {
	const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);
	const tags: MetadataTags = {
		title: 'Tïtle',
		artist: 'Artist',
		album: 'Album',
		albumArtist: 'Album Artist',
		comment: 'Comment',
		genre: 'Genre',
		lyrics: 'La la la',
		date: new Date('2021-04-23T00:00:00Z'),
		trackNumber: 3,
		tracksTotal: 12,
		beatsPerMinute: 128,
		images: [
			{ data: jpeg, mimeType: 'image/jpeg', kind: 'coverFront' },
			{ data: png, mimeType: 'image/png', kind: 'coverFront' },
			{ data: png, mimeType: 'image/png', kind: 'coverBack' },
		],
	};

	type DataAtom = { type: number; locale: number; value: Uint8Array };

	const readDataAtom = (bytes: Uint8Array, item: ParsedBox): DataAtom => {
		const data = findBox(item.children, 'data');
		const reader = fieldReader(bytes, data);
		return { type: reader.u32(), locale: reader.u32(), value: reader.bytesUntil() };
	};

	const muxWithTags = async (format: IsobmffOutputFormat, metadataTags: MetadataTags) => {
		const track: TrackSpec = { kind: 'audio', packets: audioPackets(3) };
		return mux([track], { format, tags: { creationTime: null, ...metadataTags } });
	};

	test('MP4 writes iTunes-style ilst items under an mdir meta FullBox by default', async () => {
		const { bytes, boxes } = await muxWithTags(new Mp4OutputFormat(), tags);
		const meta = findBox(boxes, 'moov/udta/meta');
		expect(fullBoxReader(bytes, meta).version).toBe(0);
		const hdlr = readHdlr(bytes, findBox(meta.children, 'hdlr'));
		expect([hdlr.componentType, hdlr.handlerType, hdlr.manufacturer]).toEqual(['\0\0\0\0', 'mdir', 'appl']);

		const items = findBox(meta.children, 'ilst').children;
		const text = (type: string) => {
			const atom = readDataAtom(bytes, items.find(item => item.type === type)!);
			expect(atom.type).toBe(1); // UTF-8
			expect(atom.locale).toBe(0);
			return new TextDecoder().decode(atom.value);
		};
		expect(text('©nam')).toBe('Tïtle');
		expect(text('©ART')).toBe('Artist');
		expect(text('©alb')).toBe('Album');
		expect(text('aART')).toBe('Album Artist');
		expect(text('©cmt')).toBe('Comment');
		expect(text('©gen')).toBe('Genre');
		expect(text('©lyr')).toBe('La la la');
		expect(text('©day')).toBe('2021-04-23');

		const tmpo = readDataAtom(bytes, items.find(item => item.type === 'tmpo')!);
		expect([tmpo.type, ...tmpo.value]).toEqual([21, 0, 128]); // Big-endian signed integer
		const trkn = readDataAtom(bytes, items.find(item => item.type === 'trkn')!);
		expect([trkn.type, ...trkn.value]).toEqual([0, 0, 0, 0, 3, 0, 12, 0, 0]);

		// Only front covers are written, each tagged with its image type (13 = JPEG, 14 = PNG)
		const covers = items.filter(item => item.type === 'covr').map(item => readDataAtom(bytes, item));
		expect(covers.map(c => c.type)).toEqual([13, 14]);
		expect(covers.map(c => [...c.value])).toEqual([[...jpeg], [...png]]);
	});

	test('raw tags become ilst items next to the normalized ones without overriding them', async () => {
		const { bytes, boxes } = await muxWithTags(new Mp4OutputFormat(), {
			title: 'Real title',
			raw: {
				'©nam': 'Ignored',
				'©too': 'Encoder',
				'cust': new Uint8Array([1, 2, 3]),
				'covr': new RichImageData(png, 'image/png'),
				'too long key': 'skipped',
				'nul ': null,
			},
		});
		const items = findBox(boxes, 'moov/udta/meta/ilst').children;
		expect(items.map(item => item.type)).toEqual(['©nam', '©too', 'cust', 'covr']);
		expect(new TextDecoder().decode(readDataAtom(bytes, items[0]!).value)).toBe('Real title');
		expect(readDataAtom(bytes, items[1]!).type).toBe(1);
		expect(readDataAtom(bytes, items[2]!)).toEqual({ type: 0, locale: 0, value: new Uint8Array([1, 2, 3]) });
		expect(readDataAtom(bytes, items[3]!).type).toBe(14);
	});

	test('mdta writes a meta box with an mdta handler, a keys box and index-keyed items', async () => {
		const { bytes, boxes } = await muxWithTags(new Mp4OutputFormat({ metadataFormat: 'mdta' }), {
			title: 'Title',
			trackNumber: 3,
			tracksTotal: 12,
			raw: { 'com.example.custom-key': 'Value' },
		});
		const meta = findBox(boxes, 'moov/udta/meta');
		// Inside udta this is the ISO MetaBox, a FullBox (as FFmpeg writes it); QuickTime's version-less layout is also
		// accepted here
		const isFullBox = fourCc(bytes, meta.contentStart + 4) !== 'hdlr';
		if (isFullBox) {
			expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(meta.contentStart)).toBe(0); // Version, flags
		}
		expect(fourCc(bytes, meta.contentStart + (isFullBox ? 8 : 4))).toBe('hdlr');
		expect(readHdlr(bytes, findBox(meta.children, 'hdlr')).handlerType).toBe('mdta');

		const keysBox = findBox(meta.children, 'keys');
		const keyReader = fullBoxReader(bytes, keysBox).reader;
		const keyCount = keyReader.u32();
		const keys = keysBox.children.map((key) => {
			expect(key.type).toBe('mdta');
			return new TextDecoder().decode(bytes.subarray(key.contentStart, key.end));
		});
		expect(keyCount).toBe(keys.length);
		expect(keys).toEqual(['title', 'track', 'com.example.custom-key']);

		const items = findBox(meta.children, 'ilst').children;
		const view = new DataView(bytes.buffer, bytes.byteOffset);
		expect(items.map(item => view.getUint32(item.start + 4))).toEqual([1, 2, 3]); // Item types are key indices
		expect(items.map(item => new TextDecoder().decode(readDataAtom(bytes, item).value)))
			.toEqual(['Title', '3/12', 'Value']);
	});

	test('the udta format writes QuickTime user data text atoms with a language code', async () => {
		const { bytes, boxes } = await muxWithTags(new Mp4OutputFormat({ metadataFormat: 'udta' }), {
			title: 'Tïtle',
			artist: 'Artist',
			date: new Date('2020-02-02T00:00:00Z'),
			raw: { '©xyz': '+48.8577+002.2950/', 'Rbin': new Uint8Array([9, 8]) },
		});
		const udta = findBox(boxes, 'moov/udta');
		const atoms = Object.fromEntries(udta.children.map(child => [child.type, child]));
		const text = (type: string) => {
			const reader = fieldReader(bytes, atoms[type]!);
			const length = reader.u16();
			expect(reader.u16()).toBe(0x55c4); // 'und'
			const value = reader.bytesUntil();
			expect(value.byteLength).toBe(length);
			return new TextDecoder().decode(value);
		};
		expect(text('©nam')).toBe('Tïtle');
		expect(text('©ART')).toBe('Artist');
		expect(text('©day')).toBe('2020-02-02');
		expect(text('©xyz')).toBe('+48.8577+002.2950/');
		expect([...boxPayload(bytes, atoms['Rbin']!)]).toEqual([9, 8]);
		expect(hasBox(udta.children, 'meta')).toBe(false);
	});

	test('the auto format picks mdir for MP4 and udta for MOV', async () => {
		const mp4 = await muxWithTags(new Mp4OutputFormat(), { title: 'A' });
		expect(hasBox(mp4.boxes, 'moov/udta/meta/ilst/©nam')).toBe(true);

		const mov = await muxWithTags(new MovOutputFormat(), { title: 'A' });
		expect(hasBox(mov.boxes, 'moov/udta/©nam')).toBe(true);
		expect(hasBox(mov.boxes, 'moov/udta/meta')).toBe(false);
	});

	test('no movie udta is written without tags', async () => {
		const { boxes } = await muxWithTags(new Mp4OutputFormat(), {});
		expect(hasBox(boxes, 'moov/udta')).toBe(false);
	});

	test('the creation time can be omitted, overridden, or defaults to now', async () => {
		const before = Math.floor(Date.now() / 1000) + SECONDS_FROM_1904_TO_1970;
		const { bytes, boxes } = await mux([{ kind: 'audio', packets: audioPackets(3) }]);
		const after = Math.ceil(Date.now() / 1000) + SECONDS_FROM_1904_TO_1970;
		const creationTime = readMvhd(bytes, findBox(boxes, 'moov/mvhd')).creationTime;
		expect(creationTime).toBeGreaterThanOrEqual(before);
		expect(creationTime).toBeLessThanOrEqual(after);
	});
});

describe('Options, validation and lifecycle', () => {
	test('format options are validated', () => {
		expect(() => new Mp4OutputFormat({ fastStart: 'yes' as never })).toThrow(TypeError);
		expect(() => new Mp4OutputFormat({ minimumFragmentDuration: -1 })).toThrow(TypeError);
		expect(() => new Mp4OutputFormat({ minimumFragmentDuration: NaN })).toThrow(TypeError);
		expect(() => new Mp4OutputFormat({ onMoov: 5 as never })).toThrow(TypeError);
		expect(() => new Mp4OutputFormat({ onFtyp: 'x' as never })).toThrow(TypeError);
		expect(() => new Mp4OutputFormat({ onMdat: {} as never })).toThrow(TypeError);
		expect(() => new Mp4OutputFormat({ onMoof: [] as never })).toThrow(TypeError);
		expect(() => new Mp4OutputFormat({ metadataFormat: 'id3' as never })).toThrow(TypeError);
		expect(() => new MovOutputFormat(null as never)).toThrow(TypeError);
	});

	test('format properties describe MP4, MOV and CMAF', () => {
		const mp4 = new Mp4OutputFormat();
		const mov = new MovOutputFormat();
		const cmaf = new CmafOutputFormat();
		expect([mp4.fileExtension, mp4.mimeType]).toEqual(['.mp4', 'video/mp4']);
		expect([mov.fileExtension, mov.mimeType]).toEqual(['.mov', 'video/quicktime']);
		expect([cmaf.fileExtension, cmaf.mimeType]).toEqual(['.m4s', 'video/mp4']);
		expect(mp4.supportsVideoTransformationMetadata).toBe(true);
		expect(mp4.supportsTimestampedMediaData).toBe(true);
		expect(mp4.negativeTimestampSupport).toBe('full');
		expect(new Mp4OutputFormat({ fastStart: 'reserve' }).requiresMaximumPacketCount).toBe(true);
		expect(mp4.requiresMaximumPacketCount).toBe(false);
		expect(mp4.getSupportedSubtitleCodecs()).toEqual(['webvtt']);
		expect(mov.getSupportedSubtitleCodecs()).toEqual([]);
		expect(mp4.getSupportedAudioCodecs()).not.toContain('ulaw');
		expect(mov.getSupportedAudioCodecs()).toContain('ulaw');
	});

	test('fastStart: \'reserve\' requires maximumPacketCount and enforces it', async () => {
		let output = new Output({ format: new Mp4OutputFormat({ fastStart: 'reserve' }), target: new BufferTarget() });
		output.addVideoTrack(new EncodedVideoPacketSource('vp9'));
		await expect(output.start()).rejects.toThrow('maximumPacketCount');

		output = new Output({ format: new Mp4OutputFormat({ fastStart: 'reserve' }), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source, { maximumPacketCount: 2 });
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(4), 'key', 0, 0.1), { decoderConfig: VP9_CONFIG });
		await source.add(new EncodedPacket(new Uint8Array(4), 'delta', 0.1, 0.1));
		await expect(source.add(new EncodedPacket(new Uint8Array(4), 'delta', 0.2, 0.1)))
			.rejects.toThrow('maximum packet count');
	});

	test('packets must start with a key packet and not go back before the previous GOP', async () => {
		let output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		let source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source);
		await output.start();
		await expect(source.add(new EncodedPacket(new Uint8Array(4), 'delta', 0, 0.1), { decoderConfig: VP9_CONFIG }))
			.rejects.toThrow('key packet');

		output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(4), 'key', 1, 0.1), { decoderConfig: VP9_CONFIG });
		await expect(source.add(new EncodedPacket(new Uint8Array(4), 'key', 0.5, 0.1))).rejects.toThrow('GOP');
	});

	test('getMimeType lists the codec strings of all tracks', async () => {
		const { output } = await mux([
			{ kind: 'video', packets: videoPackets(3) },
			{ kind: 'audio', packets: audioPackets(3) },
		]);
		expect(await output.getMimeType()).toBe('video/mp4; codecs="vp09.00.10.08, mp4a.40.2"');

		const audioOnly = await mux([{ kind: 'audio', packets: audioPackets(3) }], { format: new MovOutputFormat() });
		expect(await audioOnly.output.getMimeType()).toBe('audio/quicktime; codecs="mp4a.40.2"');
	});

	test('an output without tracks is a valid file with only a movie header', async () => {
		for (const fastStart of [false, 'in-memory', 'fragmented'] as const) {
			const output = new Output({ format: new Mp4OutputFormat({ fastStart }), target: new BufferTarget() });
			await output.start();
			await output.finalize();
			const bytes = new Uint8Array(output.target.buffer!);
			const boxes = parseBoxes(bytes);
			expect(findBox(boxes, 'moov').children.map(child => child.type)).toEqual(
				fastStart === 'fragmented' ? ['mvhd', 'mvex'] : ['mvhd'],
			);
			expect(readMvhd(bytes, findBox(boxes, 'moov/mvhd')).nextTrackId).toBe(1);
		}
	});

	test('a track declared with a decoder config but no packets is written with an empty sample table', async () => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		output.addVideoTrack(new EncodedVideoPacketSource('vp9'), { decoderConfig: VP9_CONFIG });
		const audio = new EncodedAudioPacketSource('aac');
		output.addAudioTrack(audio);
		await output.start();
		for (let i = 0; i < 3; i++) {
			await audio.add(new EncodedPacket(new Uint8Array(4), 'key', i * AAC_FRAME, AAC_FRAME), {
				decoderConfig: AAC_CONFIG,
			});
		}
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		const boxes = parseBoxes(bytes);
		const [video, audioTrak] = traks(boxes);
		expect(sampleEntry(boxes).type).toBe('vp09');
		expect(readSampleTable(bytes, video!).samples).toEqual([]);
		expect(readTkhd(bytes, findBox(video!.children, 'tkhd')).duration).toBe(0);
		expect(readSampleTable(bytes, audioTrak!).samples).toHaveLength(3);
	});

	test('onFtyp, onMoov and onMdat receive each box\'s exact bytes and position', async () => {
		for (const fastStart of [false, 'in-memory', 'reserve'] as const) {
			const seen: { type: string; data: Uint8Array; position: number }[] = [];
			const format = new Mp4OutputFormat({
				fastStart,
				onFtyp: (data, position) => seen.push({ type: 'ftyp', data: data.slice(), position }),
				onMoov: (data, position) => seen.push({ type: 'moov', data: data.slice(), position }),
				onMdat: (data, position) => seen.push({ type: 'mdat', data: data.slice(), position }),
			});
			const { bytes, boxes } = await mux([
				{ kind: 'video', packets: videoPackets(30), metadata: { maximumPacketCount: 30 } },
			], { format });

			for (const type of ['ftyp', 'moov', 'mdat']) {
				const box = findBox(boxes, type);
				const reported = seen.filter(s => s.type === type);
				expect(reported).toHaveLength(1);
				expect(reported[0]!.position).toBe(box.start);
				if (type !== 'moov' || fastStart !== 'reserve') {
					expect(reported[0]!.data).toEqual(bytes.subarray(box.start, box.end));
				}
			}
		}
	});
});

describe('WebVTT subtitle tracks', () => {
	test('cues become wvtt samples of vttc boxes, gaps become vtte, and split cues share a source ID', async () => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new TextSubtitleSource('webvtt');
		output.addSubtitleTrack(source, { languageCode: 'eng' });
		await output.start();
		await source.add([
			'WEBVTT',
			'',
			'first',
			'00:00:01.000 --> 00:00:04.000 align:start',
			'Long cue',
			'',
			'00:00:02.000 --> 00:00:03.000',
			'Short cue',
			'',
		].join('\n'));
		source.close();
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		const boxes = parseBoxes(bytes);
		const trak = traks(boxes)[0]!;
		expect(readHdlr(bytes, findBox(trak.children, 'mdia/hdlr')).handlerType).toBe('text');
		expect(hasBox(trak.children, 'mdia/minf/nmhd')).toBe(true);
		expect(readMdhd(bytes, findBox(trak.children, 'mdia/mdhd')).timescale).toBe(1000);

		const entry = sampleEntry(boxes);
		expect(entry.type).toBe('wvtt');
		expect(new TextDecoder().decode(boxPayload(bytes, findBox(entry.children, 'vttC')))).toBe('WEBVTT');

		const { samples } = readSampleTable(bytes, trak);
		expect(samples.map(s => [s.dts, s.duration])).toEqual([[0, 1000], [1000, 1000], [2000, 1000], [3000, 1000]]);

		const sampleBoxes = samples.map(s => parseBoxes(bytes, s.offset, s.offset + s.size));
		expect(sampleBoxes[0]!.map(b => b.type)).toEqual(['vtte']);
		const describe = (cue: ParsedBox) => Object.fromEntries(cue.children.map(child => [
			child.type,
			child.type === 'vsid'
				? new DataView(bytes.buffer, bytes.byteOffset).getInt32(child.contentStart)
				: new TextDecoder().decode(boxPayload(bytes, child)),
		]));
		expect(sampleBoxes[1]!.map(describe)).toEqual([
			{ vsid: 0, iden: 'first', sttg: 'align:start', payl: 'Long cue' },
		]);
		const [long, short] = sampleBoxes[2]!.map(describe);
		expect(long).toEqual({ vsid: 0, iden: 'first', sttg: 'align:start', payl: 'Long cue' });
		expect(short).toMatchObject({ payl: 'Short cue' }); // Only appears in one sample, so it has no source ID
		expect(short).not.toHaveProperty('vsid');
		expect(sampleBoxes[2]).toHaveLength(2);
		expect(sampleBoxes[3]!.map(describe)).toEqual([
			{ vsid: 0, iden: 'first', sttg: 'align:start', payl: 'Long cue' },
		]);
	});
});

describe('Randomized round trips', () => {
	// Deterministic PRNG (mulberry32)
	const random = (seed: number) => () => {
		seed = seed + 0x6d2b79f5 | 0;
		let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};

	const randomVideoPackets = (rnd: () => number, start: number) => {
		const fps = [24, 25, 30, 60][Math.floor(rnd() * 4)]!;
		const bFrames = Math.floor(rnd() * 3);
		const packets: TestPacket[] = [];
		let time = start;
		const gops = 1 + Math.floor(rnd() * 4);
		for (let gop = 0; gop < gops; gop++) {
			const length = 1 + Math.floor(rnd() * 20);
			// Decode order: the key frame, then each anchor followed by the B-frames it precedes in presentation
			const order = [0];
			for (let i = 1; i < length;) {
				const anchor = Math.min(i + bFrames, length - 1);
				order.push(anchor);
				for (let b = i; b < anchor; b++) {
					order.push(b);
				}
				i = anchor + 1;
			}
			order.forEach((frame, i) => packets.push({
				type: i === 0 ? 'key' : 'delta',
				timestamp: time + frame / fps,
				duration: 1 / fps,
				size: 8 + Math.floor(rnd() * 40),
			}));
			time += length / fps;
		}
		return packets;
	};

	test('random multi-track files keep every packet\'s data, timestamp and type in every mode', async () => {
		for (let seed = 1; seed <= 150; seed++) {
			const rnd = random(seed);
			const mode = ['false', 'in-memory', 'reserve', 'fragmented', 'mov'][Math.floor(rnd() * 5)]!;
			const start = () => [0, 0, 0.5, -0.3, 2][Math.floor(rnd() * 5)]!;
			const tracks: TrackSpec[] = [];
			const videoCount = Math.floor(rnd() * 3);
			const audioCount = (videoCount === 0 ? 1 : 0) + Math.floor(rnd() * 3);
			for (let i = 0; i < videoCount; i++) {
				const packets = randomVideoPackets(rnd, start());
				tracks.push({ kind: 'video', packets, metadata: { maximumPacketCount: packets.length } });
			}
			for (let i = 0; i < audioCount; i++) {
				const packets = audioPackets(1 + Math.floor(rnd() * 120), { start: start(), size: 12 });
				tracks.push({ kind: 'audio', packets, metadata: { maximumPacketCount: packets.length } });
			}

			const fastStart = mode === 'false' ? false : mode as 'in-memory' | 'reserve' | 'fragmented';
			const minimumFragmentDuration = [0, 0.5, 2][Math.floor(rnd() * 3)];
			const format = mode === 'mov'
				? new MovOutputFormat()
				: new Mp4OutputFormat({ fastStart, minimumFragmentDuration });
			const { bytes } = await mux(tracks, { format });

			using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
			const inputTracks = await input.getTracks();
			expect(inputTracks).toHaveLength(tracks.length);
			for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
				const expected = tracks[trackIndex]!.packets;
				let count = 0;
				for await (const packet of new EncodedPacketSink(inputTracks[trackIndex]!).packets()) {
					const view = new DataView(packet.data.buffer, packet.data.byteOffset);
					expect(view.getUint8(2)).toBe(trackIndex);
					const original = expected[view.getUint32(3)]!;
					expect(packet.timestamp).toBeCloseTo(original.timestamp, 3);
					expect(packet.type).toBe(original.type ?? 'key');
					expect(packet.data.byteLength).toBe(original.size);
					count++;
				}
				expect(count).toBe(expected.length);
			}
		}
	}, 30_000);
});
