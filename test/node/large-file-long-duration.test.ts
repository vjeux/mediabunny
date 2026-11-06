import { expect, test, describe } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import {
	CmafOutputFormat,
	HlsOutputFormat,
	MkvOutputFormat,
	MovOutputFormat,
	Mp4OutputFormat,
	OggOutputFormat,
	WavOutputFormat,
	WebMOutputFormat,
} from '../../src/output-format.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { BufferSource, CustomPathedSource, ReadableStreamSource } from '../../src/source.js';
import { VirtualFile, VirtualFileTarget } from './helpers/l38-virtual-file.js';

// Payloads of 256 MiB that are all views into one buffer: frame i is the view starting at byte i, so its first byte is
// i + 1 and identifies it, and the rest are zero pages that are never touched. Files built from these are written into
// a VirtualFile, which keeps payloads by reference, so the multi-GiB files in here never exist in memory.
const FRAME_SIZE = 2 ** 28;
const payloads = new Uint8Array(FRAME_SIZE + 256);
for (let i = 0; i < 64; i++) {
	payloads[i] = i + 1;
}
const bigFrame = (i: number) => payloads.subarray(i, i + FRAME_SIZE);

const vp9Config = { decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } };
const aacConfig = {
	decoderConfig: {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		description: new Uint8Array([0x11, 0x90]),
	},
};
const opusHead = new Uint8Array([
	0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // 'OpusHead'
	1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0, // Version 1, 2 channels, 312 pre-skip, 48 kHz, no gain, family 0
]);
const opusConfig = { decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000, description: opusHead } };

const markerFrame = (byte: number) => new Uint8Array(1000).fill(byte);

type Box = { type: string; start: number; size: number; headerSize: number };

/** Lists the boxes between start and end, following 64-bit sizes. */
const readBoxes = (file: VirtualFile, start: number, end: number) => {
	const boxes: Box[] = [];
	let pos = start;
	while (pos + 8 <= end) {
		const header = file.read(pos, pos + 16);
		const view = new DataView(header.buffer);
		let size = view.getUint32(0);
		let headerSize = 8;
		if (size === 1) {
			size = Number(view.getBigUint64(8));
			headerSize = 16;
		} else if (size === 0) {
			size = end - pos;
		}

		boxes.push({ type: String.fromCharCode(...header.subarray(4, 8)), start: pos, size, headerSize });
		pos += size;
	}

	return boxes;
};

const findBox = (file: VirtualFile, parent: Box, path: string[]): Box[] => {
	const children = readBoxes(file, parent.start + parent.headerSize, parent.start + parent.size);
	const matches = children.filter(x => x.type === path[0]);
	return path.length === 1 ? matches : matches.flatMap(x => findBox(file, x, path.slice(1)));
};

/** The chunk offsets of each track, and whether they're stored in a co64 box. */
const readChunkOffsets = (file: VirtualFile) => {
	const moov = readBoxes(file, 0, file.size).find(x => x.type === 'moov')!;
	return findBox(file, moov, ['trak']).map((trak) => {
		const [table] = [
			...findBox(file, trak, ['mdia', 'minf', 'stbl', 'stco']),
			...findBox(file, trak, ['mdia', 'minf', 'stbl', 'co64']),
		];
		const bytes = file.read(table!.start, table!.start + table!.size);
		const view = new DataView(bytes.buffer);
		const count = view.getUint32(12);
		const offsets = Array.from({ length: count }, (_, i) => table!.type === 'co64'
			? Number(view.getBigUint64(16 + 8 * i))
			: view.getUint32(16 + 4 * i),
		);
		return { type: table!.type, offsets };
	});
};

/** Reads the full box header: version and the 32- or 64-bit duration of mvhd, tkhd and mdhd. */
const readHeaderDuration = (file: VirtualFile, box: Box) => {
	const bytes = file.read(box.start + box.headerSize, box.start + box.headerSize + 36);
	const view = new DataView(bytes.buffer);
	const version = bytes[0]!;
	if (box.type === 'tkhd') {
		return { version, duration: version === 1 ? Number(view.getBigUint64(28)) : view.getUint32(20) };
	}

	return {
		version,
		timescale: version === 1 ? view.getUint32(20) : view.getUint32(12),
		duration: version === 1 ? Number(view.getBigUint64(24)) : view.getUint32(16),
	};
};

type EbmlElement = { id: number; start: number; size: number; dataStart: number };

const readEbmlElement = (file: VirtualFile, pos: number): EbmlElement => {
	const bytes = file.read(pos, pos + 16);
	const readVint = (offset: number, keepMarker: boolean) => {
		let width = 1;
		while (!(bytes[offset]! & (0x80 >> (width - 1)))) {
			width++;
		}
		let value = keepMarker ? bytes[offset]! : bytes[offset]! & (0xff >> width);
		for (let i = 1; i < width; i++) {
			value = value * 256 + bytes[offset + i]!;
		}
		return { value, width };
	};

	const id = readVint(0, true);
	const size = readVint(id.width, false);
	return { id: id.value, start: pos, size: size.value, dataStart: pos + id.width + size.width };
};

const readEbmlChildren = (file: VirtualFile, parent: EbmlElement) => {
	const children: EbmlElement[] = [];
	for (let pos = parent.dataStart; pos < parent.dataStart + parent.size;) {
		const child = readEbmlElement(file, pos);
		children.push(child);
		pos = child.dataStart + child.size;
	}

	return children;
};

const readEbmlUint = (file: VirtualFile, element: EbmlElement) => {
	let value = 0;
	for (const byte of file.read(element.dataStart, element.dataStart + element.size)) {
		value = value * 256 + byte;
	}

	return value;
};

/** Muxes `count` big video frames (one per second) plus a small marker frame, and AAC that ends after 2 seconds. */
const muxBigVideo = async (format: Mp4OutputFormat | MovOutputFormat, count: number) => {
	const target = new VirtualFileTarget();
	const output = new Output({ format, target });
	const video = new EncodedVideoPacketSource('vp9');
	const audio = new EncodedAudioPacketSource('aac');
	output.addVideoTrack(video, { frameRate: 1, maximumPacketCount: count + 1 });
	output.addAudioTrack(audio, { maximumPacketCount: 100 });
	await output.start();

	for (let i = 0; i < count; i++) {
		await video.add(new EncodedPacket(bigFrame(i), 'key', i, 1), vp9Config);
		if (i < 2) {
			for (let j = 0; j < 46; j++) {
				const timestamp = i + j * 1024 / 48000;
				await audio.add(new EncodedPacket(new Uint8Array(200), 'key', timestamp, 1024 / 48000), aacConfig);
			}
		}
	}
	audio.close();
	await video.add(new EncodedPacket(markerFrame(0xab), 'key', count, 1));
	await output.finalize();

	return target.file;
};

describe('MP4 and MOV past 4 GiB', () => {
	const checkBigVideoFile = async (file: VirtualFile, count: number) => {
		// Each track uses co64 only if its chunks need it: the video ends past 4 GiB, the audio well before
		const [videoTable, audioTable] = readChunkOffsets(file);
		expect(videoTable!.type).toBe('co64');
		expect(audioTable!.type).toBe('stco');
		expect(videoTable!.offsets.at(-1)).toBeGreaterThan(2 ** 32);

		// Every chunk offset points at the frame it should: chunks are a second long, so one frame each
		for (let i = 0; i < count; i++) {
			expect(file.read(videoTable!.offsets[i]!, videoTable!.offsets[i]! + 1)[0]).toBe(i + 1);
		}

		// The mdat holds more than 4 GiB, so it needs a 64-bit size that reaches exactly to its end
		const mdat = readBoxes(file, 0, file.size).find(x => x.type === 'mdat')!;
		expect(mdat.headerSize).toBe(16);
		expect(mdat.size).toBeGreaterThan(2 ** 32);
		const firstOffset = Math.min(...videoTable!.offsets, ...audioTable!.offsets);
		expect(mdat.start + mdat.headerSize).toBeLessThanOrEqual(firstOffset);
		expect(mdat.start + mdat.size).toBeGreaterThanOrEqual(videoTable!.offsets.at(-1)! + 1000);

		using input = new Input({ source: file.toSource(), formats: ALL_FORMATS });
		const [videoTrack, audioTrack] = await input.getTracks();

		const videoPackets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(videoTrack!).packets(undefined, undefined, {
			metadataOnly: true,
		})) {
			videoPackets.push(packet);
		}
		expect(videoPackets.map(x => x.timestamp)).toEqual(Array.from({ length: count + 1 }, (_, i) => i));
		expect(videoPackets.map(x => x.byteLength)).toEqual([...Array<number>(count).fill(FRAME_SIZE), 1000]);

		let audioPacketCount = 0;
		for await (const packet of new EncodedPacketSink(audioTrack!).packets()) {
			expect(packet.byteLength).toBe(200);
			audioPacketCount++;
		}
		expect(audioPacketCount).toBe(92);

		// The marker frame past 4 GiB reads back with its bytes
		const marker = await new EncodedPacketSink(videoTrack!).getPacket(count);
		expect(marker!.data).toEqual(markerFrame(0xab));
		expect(await input.computeDuration()).toBe(count + 1);
	};

	test('fastStart false puts the moov after a 64-bit mdat and switches tracks to co64 as needed', async () => {
		const file = await muxBigVideo(new Mp4OutputFormat({ fastStart: false }), 18);
		expect(file.size).toBeGreaterThan(18 * FRAME_SIZE);
		expect(readBoxes(file, 0, file.size).map(x => x.type)).toEqual(['ftyp', 'mdat', 'moov']);
		await checkBigVideoFile(file, 18);
	});

	test('fastStart reserve puts the moov before a 64-bit mdat and switches tracks to co64 as needed', async () => {
		const file = await muxBigVideo(new Mp4OutputFormat({ fastStart: 'reserve' }), 18);
		expect(readBoxes(file, 0, file.size).map(x => x.type)).toEqual(['ftyp', 'moov', 'free', 'mdat']);
		await checkBigVideoFile(file, 18);
	});

	test('MOV switches tracks to co64 past 4 GiB', async () => {
		const file = await muxBigVideo(new MovOutputFormat({ fastStart: false }), 18);
		await checkBigVideoFile(file, 18);
	});

	test('chunks starting just below 4 GiB keep 32-bit offsets while the mdat gets a 64-bit size', async () => {
		// After the 40 bytes of ftyp and mdat headers, the 16th frame starts 2^28 - 40 bytes below 4 GiB and ends past
		// it
		const target = new VirtualFileTarget();
		const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
		const video = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(video, { frameRate: 1 });
		await output.start();
		for (let i = 0; i < 15; i++) {
			await video.add(new EncodedPacket(bigFrame(i), 'key', i, 1), vp9Config);
		}
		await video.add(new EncodedPacket(bigFrame(15), 'key', 15, 1));
		await output.finalize();

		const [table] = readChunkOffsets(target.file);
		expect(table!.type).toBe('stco');
		expect(table!.offsets.at(-1)).toBeLessThan(2 ** 32);

		const mdat = readBoxes(target.file, 0, target.file.size).find(x => x.type === 'mdat')!;
		expect(mdat.size).toBeGreaterThan(2 ** 32);
		expect(mdat.headerSize).toBe(16);
		expect(readBoxes(target.file, 0, target.file.size).map(x => x.type)).toEqual(['ftyp', 'mdat', 'moov']);

		using input = new Input({ source: target.file.toSource(), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const last = await new EncodedPacketSink(track).getPacket(15, { metadataOnly: true });
		expect(last!.byteLength).toBe(FRAME_SIZE);
	});

	test('fragmented files keep every fragment readable past 4 GiB', async () => {
		const target = new VirtualFileTarget();
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
			target,
		});
		const video = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(video, { frameRate: 1 });
		await output.start();
		for (let i = 0; i < 18; i++) {
			await video.add(new EncodedPacket(bigFrame(i), 'key', i, 1), vp9Config);
		}
		await video.add(new EncodedPacket(markerFrame(0xcd), 'key', 18, 1));
		await output.finalize();

		const topLevel = readBoxes(target.file, 0, target.file.size);
		expect(topLevel.filter(x => x.type === 'moof')).toHaveLength(19);
		expect(topLevel.at(-1)!.type).toBe('mfra');
		expect(topLevel.filter(x => x.type === 'moof').at(-1)!.start).toBeGreaterThan(2 ** 32);

		using input = new Input({ source: target.file.toSource(), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new EncodedPacketSink(track);
		const timestamps: number[] = [];
		for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
			timestamps.push(packet.timestamp);
		}
		expect(timestamps).toEqual(Array.from({ length: 19 }, (_, i) => i));

		// Found through the mfra, whose 64-bit moof offsets point past 4 GiB
		const marker = await sink.getPacket(18.5);
		expect(marker!.data).toEqual(markerFrame(0xcd));
		const frame = await sink.getKeyPacket(17.2, { metadataOnly: true });
		expect(frame!.timestamp).toBe(17);
	});
});

describe('Matroska past 4 GiB', () => {
	test.each([
		['Matroska', () => new MkvOutputFormat()],
		['WebM', () => new WebMOutputFormat()],
	])('%s Cues and SeekHead point past 4 GiB', async (_, makeFormat) => {
		const target = new VirtualFileTarget();
		const output = new Output({ format: makeFormat(), target });
		const video = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(video);
		await output.start();
		for (let i = 0; i < 18; i++) {
			await video.add(new EncodedPacket(bigFrame(i), 'key', 2 * i, 2), vp9Config);
		}
		await video.add(new EncodedPacket(markerFrame(0xef), 'key', 36, 2));
		await output.finalize();
		const file = target.file;

		// EBML header, then a Segment whose size covers the rest of the file
		const ebmlHeader = readEbmlElement(file, 0);
		const segment = readEbmlElement(file, ebmlHeader.dataStart + ebmlHeader.size);
		expect(segment.id).toBe(0x18538067);
		expect(segment.dataStart + segment.size).toBe(file.size);

		const children = readEbmlChildren(file, segment);
		const clusters = children.filter(x => x.id === 0x1f43b675);
		expect(clusters).toHaveLength(19);
		expect(clusters.at(-1)!.start).toBeGreaterThan(2 ** 32);

		// The SeekHead's Cues entry and every CueClusterPosition point at the right element
		const seekHead = children.find(x => x.id === 0x114d9b74)!;
		const seekEntries = readEbmlChildren(file, seekHead).map((seek) => {
			const [seekId, seekPosition] = readEbmlChildren(file, seek);
			return {
				id: readEbmlUint(file, seekId!),
				position: readEbmlUint(file, seekPosition!),
			};
		});
		const cuesEntry = seekEntries.find(x => x.id === 0x1c53bb6b)!;
		expect(cuesEntry.position).toBeGreaterThan(2 ** 32);
		const cues = readEbmlElement(file, segment.dataStart + cuesEntry.position);
		expect(cues.id).toBe(0x1c53bb6b);

		const cueClusterPositions = readEbmlChildren(file, cues).map((cuePoint) => {
			const trackPositions = readEbmlChildren(file, cuePoint).find(x => x.id === 0xb7)!;
			return readEbmlUint(file, readEbmlChildren(file, trackPositions).find(x => x.id === 0xf1)!);
		});
		expect(cueClusterPositions).toEqual(clusters.map(x => x.start - segment.dataStart));

		using input = new Input({ source: file.toSource(), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new EncodedPacketSink(track);
		expect((await sink.getPacket(36.5))!.data).toEqual(markerFrame(0xef));
		expect((await sink.getKeyPacket(37.9, { metadataOnly: true }))!.timestamp).toBe(36);
		expect(await track.getDurationFromMetadata()).toBe(38);
	});
});

describe('HLS past 4 GiB', () => {
	test('one segment file per playlist gets byte ranges past 4 GiB', async () => {
		const files = new Map<string, VirtualFile>();
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new CmafOutputFormat(),
				targetDuration: 2,
				singleFilePerPlaylist: true,
			}),
			target: new PathedTarget('index.m3u8', ({ path }) => {
				const target = new VirtualFileTarget();
				files.set(path, target.file);
				return target;
			}),
		});
		const video = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(video, { frameRate: 1 });
		await output.start();
		for (let i = 0; i < 18; i++) {
			await video.add(new EncodedPacket(bigFrame(i), 'key', i, 1), vp9Config);
		}
		await video.add(new EncodedPacket(markerFrame(0x77), 'key', 18, 1));
		await output.finalize();

		const playlist = files.get('playlist-1.m3u8')!;
		const byteRanges = new TextDecoder().decode(playlist.read(0, playlist.size))
			.split('\n')
			.filter(line => line.startsWith('#EXT-X-BYTERANGE:'))
			.map((line) => {
				const [length, offset] = line.slice('#EXT-X-BYTERANGE:'.length).split('@').map(Number);
				return { length: length!, offset: offset! };
			});

		// Two frames per segment, so the last of the ten segments holds only the marker frame
		expect(byteRanges).toHaveLength(10);
		expect(byteRanges.at(-1)!.offset).toBeGreaterThan(2 ** 32);
		for (let i = 1; i < byteRanges.length; i++) {
			expect(byteRanges[i]!.offset).toBe(byteRanges[i - 1]!.offset + byteRanges[i - 1]!.length);
		}
		expect(byteRanges.at(-1)!.offset + byteRanges.at(-1)!.length).toBe(files.get('segments-1.m4s')!.size);

		using input = new Input({
			source: new CustomPathedSource('index.m3u8', ({ path }) => files.get(path)!.toSource()),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;
		expect((await new EncodedPacketSink(track).getPacket(18.5))!.data).toEqual(markerFrame(0x77));
		expect(await input.computeDuration()).toBe(19);
	});
});

describe('WAVE past 4 GiB', () => {
	const muxRf64 = async () => {
		// 18 packets of 256 MiB of 16-bit stereo at 48 kHz (each 23.3 minutes long), then a marker packet
		const target = new VirtualFileTarget();
		const output = new Output({ format: new WavOutputFormat({ large: true }), target });
		const audio = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(audio);
		await output.start();
		const decoderConfig = { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 };
		const frameDuration = FRAME_SIZE / 4 / 48000;
		for (let i = 0; i < 18; i++) {
			// The views start at even offsets so that they're whole sample frames
			const data = payloads.subarray(4 * i, 4 * i + FRAME_SIZE);
			await audio.add(new EncodedPacket(data, 'key', i * frameDuration, frameDuration), { decoderConfig });
		}
		await audio.add(new EncodedPacket(new Uint8Array(4096).fill(0x12), 'key', 18 * frameDuration, 1024 / 48000));
		await output.finalize();
		return target.file;
	};

	test('RF64 output stores 64-bit sizes in ds64', async () => {
		const file = await muxRf64();
		const header = file.read(0, 64);
		const view = new DataView(header.buffer);
		expect(String.fromCharCode(...header.subarray(0, 4))).toBe('RF64');
		expect(view.getUint32(4, true)).toBe(0xffffffff);
		expect(String.fromCharCode(...header.subarray(12, 16))).toBe('ds64');
		expect(Number(view.getBigUint64(20, true))).toBe(file.size - 8); // RIFF size
		const dataSize = 18 * FRAME_SIZE + 4096;
		expect(Number(view.getBigUint64(28, true))).toBe(dataSize);
		expect(Number(view.getBigUint64(36, true))).toBe(dataSize / 4); // Sample count
		expect(String.fromCharCode(...file.read(72, 76))).toBe('data');
		expect(new DataView(file.read(76, 80).buffer).getUint32(0, true)).toBe(0xffffffff);
	});

	test('RF64 files read through a ReadableStreamSource reach past 4 GiB', async () => {
		const file = await muxRf64();
		using input = new Input({ source: new ReadableStreamSource(file.toStream()), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		const duration = (18 * FRAME_SIZE + 4096) / 4 / 48000;
		expect(await track.getDurationFromMetadata()).toBeCloseTo(duration, 9);

		const last = (await new EncodedPacketSink(track).getPacket(duration - 0.001))!;
		expect(last.timestamp + last.duration).toBeCloseTo(duration, 9);
		expect(last.data.subarray(-4096)).toEqual(new Uint8Array(4096).fill(0x12));
	});

	test('plain RIFF output refuses to grow past 4 GiB', async () => {
		const output = new Output({ format: new WavOutputFormat(), target: new VirtualFileTarget() });
		const audio = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(audio);
		await output.start();
		const decoderConfig = { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 };
		const frameDuration = FRAME_SIZE / 4 / 48000;
		const mux = async () => {
			for (let i = 0; i < 16; i++) {
				const data = payloads.subarray(4 * i, 4 * i + FRAME_SIZE);
				await audio.add(new EncodedPacket(data, 'key', i * frameDuration, frameDuration), { decoderConfig });
			}
		};
		await expect(mux()).rejects.toThrow(/maximum RIFF size of 4 GiB/);
	});
});

describe('MP3 past 4 GiB', () => {
	// MPEG-1 Layer III at 44.1 kHz and 128 kbit/s, stereo: frames of 417 bytes without padding
	const mp3Frame = () => {
		const frame = new Uint8Array(417);
		frame.set([0xff, 0xfb, 0x90, 0x00]);
		return frame;
	};

	test('CBR durations are estimated from file sizes past 4 GiB', async () => {
		// A few frames, then zeros up to 5 GiB
		const file = new VirtualFile();
		for (let i = 0; i < 4; i++) {
			file.write(mp3Frame(), 417 * i);
		}
		file.size = 5 * 2 ** 30;

		using input = new Input({ source: file.toSource(), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		const averageFrameSize = 144 * 128000 / 44100;
		const frameCount = Math.round(5 * 2 ** 30 / averageFrameSize);
		expect(await track.getDurationFromMetadata()).toBeCloseTo(frameCount * 1152 / 44100, 9); // 93 hours
	});

	test('Xing frame counts past 2^32 samples give the full duration', async () => {
		// A Xing frame claiming 4 million frames (4.6e9 samples), then a few frames
		const xingFrame = mp3Frame();
		xingFrame.set([0x58, 0x69, 0x6e, 0x67, 0, 0, 0, 1], 36); // 'Xing', frame count present
		new DataView(xingFrame.buffer).setUint32(44, 4_000_000);

		const bytes = new Uint8Array(417 * 5);
		bytes.set(xingFrame);
		for (let i = 1; i < 5; i++) {
			bytes.set(mp3Frame(), 417 * i);
		}

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getDurationFromMetadata()).toBeCloseTo(4_000_000 * 1152 / 44100, 9); // 29 hours
	});
});

describe('Long durations', () => {
	test.each([
		['MP4', () => new Mp4OutputFormat({ fastStart: false })],
		['MOV', () => new MovOutputFormat({ fastStart: false })],
	])('%s headers switch to 64-bit durations past 2^32 timescale units', async (_, makeFormat) => {
		// 30 hours of frames every 10 seconds, starting 5 seconds in, so that there's an edit list. In the 57600 Hz
		// movie and video timescales, 30 hours are 6.2e9 units.
		const target = new BufferTarget();
		const output = new Output({ format: makeFormat(), target });
		const video = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(video);
		await output.start();
		for (let t = 5; t < 30 * 3600; t += 10) {
			await video.add(new EncodedPacket(new Uint8Array(10), 'key', t, 10), vp9Config);
		}
		await output.finalize();

		const file = new VirtualFile();
		file.write(new Uint8Array(target.buffer!), 0);
		const moov = readBoxes(file, 0, file.size).find(x => x.type === 'moov')!;
		const end = 30 * 3600 + 5;
		const mvhd = readHeaderDuration(file, findBox(file, moov, ['mvhd'])[0]!);
		expect(mvhd).toEqual({ version: 1, timescale: 57600, duration: end * 57600 });
		const tkhd = readHeaderDuration(file, findBox(file, moov, ['trak', 'tkhd'])[0]!);
		expect(tkhd).toEqual({ version: 1, duration: end * 57600 });
		const mdhd = readHeaderDuration(file, findBox(file, moov, ['trak', 'mdia', 'mdhd'])[0]!);
		expect(mdhd).toEqual({ version: 1, timescale: 57600, duration: 30 * 3600 * 57600 });

		// Edit list: an empty edit of 5 seconds, then the media
		const elst = findBox(file, moov, ['trak', 'edts', 'elst'])[0]!;
		const elstBytes = file.read(elst.start + 8, elst.start + elst.size);
		const elstView = new DataView(elstBytes.buffer);
		expect(elstBytes[0]).toBe(1);
		expect(Number(elstView.getBigUint64(8))).toBe(5 * 57600);
		expect(Number(elstView.getBigInt64(16))).toBe(-1);
		expect(Number(elstView.getBigUint64(28))).toBe(30 * 3600 * 57600);

		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.getDurationFromMetadata()).toBe(end);
		expect(await input.computeDuration()).toBe(end);
		const sink = new EncodedPacketSink(track);
		expect((await sink.getPacket(29.9 * 3600, { metadataOnly: true }))!.timestamp).toBe(107635);
		expect((await sink.getPacket(end, { metadataOnly: true }))!.timestamp).toBe(end - 10);
		expect((await sink.getFirstPacket({ metadataOnly: true }))!.timestamp).toBe(5);
	});

	test('fragmented MP4 base media decode times past 2^32 timescale units', async () => {
		const target = new BufferTarget();
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 3600 }),
			target,
		});
		const video = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(video);
		await output.start();
		for (let t = 0; t < 30 * 3600; t += 10) {
			await video.add(new EncodedPacket(new Uint8Array(10), 'key', t, 10), vp9Config);
		}
		await output.finalize();

		const file = new VirtualFile();
		file.write(new Uint8Array(target.buffer!), 0);
		const moofs = readBoxes(file, 0, file.size).filter(x => x.type === 'moof');
		expect(moofs).toHaveLength(30);
		const tfdt = findBox(file, moofs.at(-1)!, ['traf', 'tfdt'])[0]!;
		const tfdtBytes = file.read(tfdt.start + 8, tfdt.start + tfdt.size);
		expect(tfdtBytes[0]).toBe(1);
		expect(Number(new DataView(tfdtBytes.buffer).getBigUint64(4))).toBe(29 * 3600 * 57600);

		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await input.computeDuration()).toBe(30 * 3600);
		const sink = new EncodedPacketSink(track);
		expect((await sink.getPacket(29.5 * 3600 + 3, { metadataOnly: true }))!.timestamp).toBe(29.5 * 3600);
		let count = 0;
		for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
			expect(packet.timestamp).toBe(10 * count);
			count++;
		}
		expect(count).toBe(10800);
	});

	test('Matroska cluster timestamps past 2^32 milliseconds (50 days)', async () => {
		const target = new BufferTarget();
		const output = new Output({ format: new MkvOutputFormat(), target });
		const video = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(video);
		await output.start();
		const days = 60;
		for (let t = 0; t < days * 86400; t += 3600) {
			await video.add(new EncodedPacket(new Uint8Array(10), 'key', t, 3600), vp9Config);
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.getDurationFromMetadata()).toBe(days * 86400);
		const sink = new EncodedPacketSink(track);
		const timestamps: number[] = [];
		for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
			timestamps.push(packet.timestamp);
		}
		expect(timestamps).toEqual(Array.from({ length: days * 24 }, (_, i) => 3600 * i));
		expect((await sink.getPacket(55 * 86400 + 1, { metadataOnly: true }))!.timestamp).toBe(55 * 86400);
	});

	test('Ogg granule positions past 2^32 samples', async () => {
		// A stream starting 25 hours in: at 48 kHz, its granule positions start at 4.32e9
		const target = new BufferTarget();
		const output = new Output({ format: new OggOutputFormat(), target });
		const audio = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(audio);
		await output.start();
		const start = 25 * 3600;
		const packet = new Uint8Array([0xfc, 0, 0, 0]); // CELT, 20 ms
		for (let i = 0; i < 3000; i++) {
			await audio.add(new EncodedPacket(packet, 'key', start + i * 0.02, 0.02), opusConfig);
		}
		await output.finalize();

		// The granule position of the last page
		const bytes = new Uint8Array(target.buffer!);
		let lastPage = -1;
		for (let i = 0; i + 4 <= bytes.length; i++) {
			if (bytes[i] === 0x4f && bytes[i + 1] === 0x67 && bytes[i + 2] === 0x67 && bytes[i + 3] === 0x53) {
				lastPage = i;
			}
		}
		const granule = Number(new DataView(bytes.buffer).getBigInt64(lastPage + 6, true));
		expect(granule).toBe((start + 60) * 48000 + 312); // Plus the 312 pre-skip samples

		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getFirstTimestamp()).toBeCloseTo(start, 9);
		expect(await track.computeDuration()).toBeCloseTo(start + 60, 9);
		const sink = new EncodedPacketSink(track);
		expect((await sink.getPacket(start + 59.99, { metadataOnly: true }))!.timestamp).toBeCloseTo(start + 59.98, 9);
	});

	test('CMAF segments of several hours keep their fragment decode times', async () => {
		const initTarget = new BufferTarget();
		const target = new BufferTarget();
		const output = new Output({ format: new CmafOutputFormat(), target, initTarget });
		const video = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(video);
		await output.start();
		for (let t = 0; t < 20 * 3600; t += 10) {
			await video.add(new EncodedPacket(new Uint8Array(10), 'key', 24 * 3600 + t, 10), vp9Config);
		}
		await output.finalize();

		using input = new Input({
			source: new BufferSource(target.buffer!),
			formats: ALL_FORMATS,
			initInput: new Input({ source: new BufferSource(initTarget.buffer!), formats: ALL_FORMATS }),
		});
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.getFirstTimestamp()).toBe(24 * 3600);
		expect(await input.computeDuration()).toBe(44 * 3600);
	});
});
