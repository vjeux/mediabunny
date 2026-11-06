import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv } from 'node:crypto';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	MP4,
	MovOutputFormat,
	Mp4OutputFormat,
	Output,
} from '../../src/index.js';
import { assert, toUint8Array } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Should be able to get packets from a .MP4 file', async () => {
	const filePath = path.join(__dirname, '..', 'public/video.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP4);
	expect(await input.getMimeType()).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"');
	expect(await input.computeDuration()).toBe(5.056);

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	const sink = new EncodedPacketSink(track);

	let samples = 0;
	const timestamps: number[] = [];

	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		samples++;
	}

	expect(samples).toBe(125);
	expect(timestamps.slice(0, 10)).toEqual([
		0, 0.16, 0.08, 0.04, 0.12, 0.32, 0.24, 0.2, 0.28, 0.48,
	]);
});

test('MP4 nclx color information', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1),
		{
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 1280,
				codedHeight: 720,
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
		},
	);
	await output.finalize();

	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('nclc')).toBe(false);
	expect(str.includes('nclx')).toBe(true);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt2020',
		transfer: 'pq',
		matrix: 'bt2020-ncl',
		fullRange: false,
	});
	expect(await track.hasHighDynamicRange()).toBe(true);
});

test('QuickTime nclc color information', async () => {
	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1),
		{
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 1280,
				codedHeight: 720,
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
		},
	);
	await output.finalize();

	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('nclc')).toBe(true);
	expect(str.includes('nclx')).toBe(false);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt2020',
		transfer: 'pq',
		matrix: 'bt2020-ncl',
		fullRange: undefined,
	});
	expect(await track.hasHighDynamicRange()).toBe(true);
});

// Annex B isn't supposed to exist in MP4, but some files have it anyway, with an empty avcC box
test('Annex B', async () => {
	const filePath = path.join(__dirname, '..', 'public/annex-b.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	const decoderConfig = (await track.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('avc1.424028');
	expect(decoderConfig.description).toBeUndefined();

	const sink = new EncodedPacketSink(track);
	const firstPacket = (await sink.getFirstPacket())!;
	expect([...firstPacket.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);
});

test('HEVC codec strings start with the sample entry type', async () => {
	// The first file stores its track as 'hev1', the second one as 'hvc1'
	const expected = [
		['video-h265.mp4', 'hev1.1.6.L120.90'],
		['sps-only-sar-hevc.mp4', 'hvc1.1.6.L30.90'],
	];

	for (const [fileName, codecString] of expected) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '..', 'public', fileName!)),
			formats: ALL_FORMATS,
		});

		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.getCodecParameterString()).toBe(codecString);
		expect((await track.getDecoderConfig())!.codec).toBe(codecString);
		expect(await input.getMimeType()).toContain(codecString);
	}
});

test('HE-AAC v2 audio config is parsed correctly', async () => {
	const filePath = path.join(__dirname, '..', 'public/he-aac-v2.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getSampleRate()).toBe(44100);
	expect(await track.getNumberOfChannels()).toBe(2);

	const decoderConfig = (await track.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('mp4a.40.29');
	expect(decoderConfig.sampleRate).toBe(44100);
	expect(decoderConfig.numberOfChannels).toBe(2);
	expect([...toUint8Array(decoderConfig.description!)]).toEqual([0xeb, 0x8a, 0x08, 0x00]);
});

test('PCM track with stsc not starting at the first chunk', async () => {
	// The stsc box's first entry starts at the second chunk, leaving three chunks of PCM audio
	const filePath = path.join(__dirname, '..', 'public/pcm-stsc-not-first-chunk.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);

	let packetCount = 0;
	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		void packet;
		packetCount++;
	}

	expect(packetCount).toBe(3);
});

test('Missing tfdt and tfra entries referencing non-first samples', async () => {
	// See https://github.com/Vanilagy/mediabunny/issues/578
	const filePath = path.join(__dirname, '..', 'public/missing-tfdt.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(Number(packet.timestamp.toFixed(6)));
	}

	// Taken from ffprobe
	expect(timestamps).toEqual([
		0, 0.016667, 0.033333, 0.05, 0.066667, 0.083333, 0.1, 0.116667, 0.133333, 0.15,
		0.166667, 0.183333, 0.2, 0.216667, 0.233333, 0.25, 0.266667, 0.283333, 0.3, 0.316667,
		0.333333, 0.35, 0.366667, 0.383333, 0.4, 0.416667, 0.433333, 0.45, 0.466667, 0.483333,
		0.5, 0.516667, 0.533333, 0.55, 0.566667, 0.583333, 0.6, 0.616667, 0.633333, 0.65,
		0.666667, 0.683333, 0.7, 0.716667, 0.733333, 0.75, 0.766667, 0.783333, 0.8, 0.816667,
		0.833333, 0.85, 0.866667, 0.883333, 0.9, 0.916667, 0.933333, 0.95, 0.966667, 0.983333,
		1, 1.016667, 1.033333, 1.05, 1.066667, 1.083333, 1.1, 1.116667, 1.133333, 1.15,
		1.166667, 1.183333, 1.2, 1.216667, 1.233333, 1.25, 1.266667, 1.283333, 1.3, 1.316667,
		1.333333, 1.35, 1.366667, 1.383333, 1.4, 1.416667, 1.433333, 1.45, 1.466667, 1.483333,
		1.5, 1.516667, 1.533333, 1.55, 1.566667, 1.583333, 1.6, 1.616667, 1.633333, 1.65,
		1.666667, 1.683333, 1.7, 1.716667, 1.733333, 1.75, 1.766667, 1.783333, 1.8, 1.816667,
		1.833333, 1.85, 1.866667, 1.883333, 1.9, 1.916667, 1.933333, 1.95, 1.966667, 1.983333,
		2, 2.016667, 2.033333, 2.05, 2.066667, 2.083333, 2.1, 2.116667, 2.133333, 2.15,
		2.166667, 2.183333, 2.2, 2.216667, 2.233333, 2.25, 2.266667, 2.283333, 2.3, 2.316667,
		2.333333, 2.35, 2.366667, 2.383333, 2.4, 2.416667, 2.433333, 2.45, 2.466667, 2.483333,
		2.5, 2.516667, 2.533333, 2.55, 2.566667, 2.583333, 2.6, 2.616667, 2.633333, 2.65,
		2.666667, 2.683333, 2.7, 2.716667, 2.733333, 2.75, 2.766667, 2.783333, 2.8, 2.816667,
		2.833333, 2.85, 2.866667, 2.883333, 2.9, 2.916667, 2.933333, 2.95, 2.966667, 2.983333,
		3, 3.016667, 3.033333, 3.05, 3.066667, 3.083333, 3.1, 3.116667, 3.133333, 3.15,
		3.166667, 3.183333, 3.2, 3.216667, 3.233333, 3.25, 3.266667, 3.283333, 3.3, 3.316667,
		3.333333, 3.35, 3.366667, 3.383333, 3.4, 3.416667, 3.433333, 3.45, 3.466667, 3.483333,
		3.5, 3.516667, 3.533333, 3.55, 3.566667, 3.583333, 3.6, 3.616667, 3.633333, 3.65,
		3.666667, 3.683333, 3.7, 3.716667, 3.733333, 3.75, 3.766667, 3.783333, 3.8, 3.816667,
		3.833333, 3.85, 3.866667, 3.883333, 3.9, 3.916667, 3.933333, 3.95, 3.966667, 3.983333,
	]);
});

test('Key packet lookup after reading fragments without key frames', async () => {
	// See https://github.com/Vanilagy/mediabunny/issues/584
	const filePath = path.join(__dirname, '..', 'public/fragments-without-keyframes.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	expect((await sink.getKeyPacket(1.2))?.timestamp).toBe(1);

	for await (const packet of sink.packets()) {
		void packet;
	}

	expect((await sink.getKeyPacket(1.2))?.timestamp).toBe(1);
});

test('AV1 track with an empty av1C box', async () => {
	// ffmpeg -f lavfi -i testsrc2=size=64x64:rate=10 -t 1 -c:v libaom-av1 -cpu-used 8 -row-mt 1 -g 10 -crf 50
	//   -movflags frag_keyframe+empty_moov av1-empty-av1c.mp4
	// libaom has no extradata when the empty moov is written, so FFmpeg writes an av1C box without content
	const filePath = path.join(__dirname, '..', 'public/av1-empty-av1c.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	expect(await track.getCodec()).toBe('av1');
	expect((await track.getDecoderConfig())?.codec).toBe('av01.0.00M.08'); // From the sequence header

	let packetCount = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		void packet;
		packetCount++;
	}
	expect(packetCount).toBe(10);
});

test('MP3 audio in a QuickTime .mp3 sample entry', async () => {
	// ffmpeg -f lavfi -i sine=frequency=440:sample_rate=22050 -t 1 -c:a libmp3lame -b:a 32k mp3-in-mov.mov
	const filePath = path.join(__dirname, '..', 'public/mp3-in-mov.mov');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toBe('mp3');
	expect(await track.getDecoderConfig()).toEqual({
		codec: 'mp3',
		numberOfChannels: 1,
		sampleRate: 22050,
		description: undefined,
	});

	const sink = new EncodedPacketSink(track);
	const firstPacket = await sink.getFirstPacket();
	expect(firstPacket?.timestamp).toBeCloseTo(-0.050113); // Encoder delay cut by the edit list
	expect(firstPacket?.byteLength).toBe(104);
});

test('MP3 in a QuickTime sample table that counts decoded samples', async () => {
	// Old QuickTime files (e.g. samples.ffmpeg.org archive/all/mov+svq3+mp3++svq3_mediakey.mov) describe MP3 like PCM:
	// one stsz entry of size 1 per decoded sample, with the packet layout in a version 1 sound description (here
	// 1152 samples in 288 bytes, i.e. two 144-byte MPEG-2 frames)
	const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...[...type].map(char => char.charCodeAt(0)), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];

	const frames = Array.from({ length: 8 }, (_, i) => [0xff, 0xf3, 0x48, 0x50, i, ...zeros(139)]);
	const sampleEntry = box('ms\u0000U',
		zeros(6), u16(1), // Data reference index
		u16(1), zeros(6), // Version 1
		u16(2), u16(16), u16(0xffff), u16(0), u32(16000 * 0x10000),
		u32(1152), u32(144), u32(288), u32(2), // Samples per packet, bytes per packet, frame and sample
	);

	const moov = (chunkOffsets: number[]) => box('moov',
		box('mvhd', zeros(12), u32(16000), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, zeros(8)),
			box('mdia',
				box('mdhd', zeros(12), u32(16000), u32(4608), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('soun'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(1), sampleEntry),
					box('stts', u32(0), u32(1), u32(4608), u32(1)),
					box('stsc', u32(0), u32(1), u32(1), u32(2304), u32(1)),
					box('stsz', u32(0), u32(1), u32(4608)),
					box('stco', u32(0), u32(2), ...chunkOffsets.map(u32)),
				)),
			),
		),
	);
	const ftyp = box('ftyp', ascii('qt  '), u32(0), ascii('qt  '));
	const dataStart = ftyp.length + moov([0, 0]).length + 8;
	const gap = zeros(10);

	using input = new Input({
		source: new BufferSource(new Uint8Array([
			...ftyp,
			...moov([dataStart, dataStart + 4 * 144 + gap.length]),
			...box('mdat', ...frames.slice(0, 4), gap, ...frames.slice(4)),
		])),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getCodec()).toBe('mp3');

	const packets: number[][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([packet.timestamp, packet.duration, packet.byteLength, packet.data[4]!]);
	}
	expect(packets).toEqual(frames.map((_, i) => [i * 576 / 16000, 576 / 16000, 144, i]));
});

test('Packet lookup by timestamp with B-frames spread over fragments', async () => {
	// One frame per fragment (like FFmpeg's frag_every_frame), so the fragments interleave in presentation order
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...[...type].map(char => char.charCodeAt(0)), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const moov = box('moov',
		box('mvhd', zeros(12), u32(10), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(10), u32(0), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), [...'vide'].map(char => char.charCodeAt(0)), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(1), box('avc1', zeros(24), [0, 64, 0, 64], zeros(50))),
					box('stts', zeros(8)),
					box('stsc', zeros(8)),
					box('stsz', zeros(12)),
					box('stco', zeros(8)),
				)),
			),
		),
		box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
	);

	// Decode order I P B B P B B, presented as I B B P B B P
	const compositionOffsets = [1, 3, 0, 0, 3, 0, 0];
	const fragments = compositionOffsets.flatMap((offset, i) => {
		const traf = (dataOffset: number) => box('traf',
			box('tfhd', u32(0x020000), u32(1)),
			box('tfdt', u32(0), u32(i)),
			box('trun', u32(0xf01), u32(1), u32(dataOffset), u32(1), u32(1), u32(i === 0 ? 0 : 0x10000), u32(offset)),
		);
		const moofSize = box('moof', box('mfhd', u32(0), u32(i + 1)), traf(0)).length;
		return [...box('moof', box('mfhd', u32(0), u32(i + 1)), traf(moofSize + 8)), ...box('mdat', [i])];
	});

	const ftyp = box('ftyp', [...'iso5'].map(char => char.charCodeAt(0)), u32(0));
	using input = new Input({
		source: new BufferSource(new Uint8Array([...ftyp, ...moov, ...fragments])),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	expect((await sink.getPacket(0.65))?.timestamp).toBe(0.6); // The last fragment's B-frame
	expect((await sink.getPacket(0.45))?.timestamp).toBe(0.4); // The P-frame decoded before it
	expect((await sink.getPacket(Infinity))?.timestamp).toBe(0.7); // Not the frame decoded last
	expect(await track.computeDuration()).toBe(0.8);
});

test('Packet lookup by timestamp is the same however many fragments were read before', async () => {
	// One frame per fragment, so that the fragments interleave in presentation order; only the first frame is a sync
	// sample. What the first fragments show of the composition offsets says nothing about the later ones.
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const moov = box('moov',
		box('mvhd', zeros(12), u32(10), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(10), u32(0), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(1), box('avc1', zeros(24), [0, 64, 0, 64], zeros(50))),
					box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
				)),
			),
		),
		box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
	);
	const build = (compositionOffsets: number[], trunVersion: number) => new Uint8Array([
		...box('ftyp', ascii('iso6'), u32(0)),
		...moov,
		...compositionOffsets.flatMap((offset, i) => {
			const traf = (dataOffset: number) => box('traf',
				box('tfhd', u32(0x020000), u32(1)),
				box('tfdt', u32(0), u32(i)),
				box('trun', [trunVersion, 0, 0x0f, 0x01], u32(1), u32(dataOffset), u32(1), u32(1),
					u32(i === 0 ? 0 : 0x10000), u32(offset >>> 0)),
			);
			const moofSize = box('moof', box('mfhd', u32(0), u32(i + 1)), traf(0)).length;
			return [...box('moof', box('mfhd', u32(0), u32(i + 1)), traf(moofSize + 8)), ...box('mdat', [i])];
		}),
	]);
	const withSink = async <T>(bytes: Uint8Array, use: (sink: EncodedPacketSink) => Promise<T>) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		return await use(new EncodedPacketSink(track));
	};
	const lookUp = async (sink: EncodedPacketSink, timestamps: number[]) => {
		const result = new Map<number, number | null>();
		for (const timestamp of timestamps) {
			result.set(timestamp, (await sink.getPacket(timestamp))?.timestamp ?? null);
		}
		return timestamps.map(timestamp => result.get(timestamp));
	};

	const sequences: [compositionOffsets: number[], trunVersion: number][] = [
		[[1, 3, 0, 0, 3, 0, 0], 0], // Decode order I P B B P B B
		[[0, 2, -1, -1, 2, -1, -1], 1], // The same with negative offsets, which the first two fragments don't show
		[[1, 1, 1, 5, 0, 0, 0, 0], 0], // Reordering that gets deeper after the first fragments
	];
	for (const [compositionOffsets, trunVersion] of sequences) {
		const bytes = build(compositionOffsets, trunVersion);
		const presentationTimestamps = compositionOffsets.map((offset, i) => i + offset);

		// Between every two presentation timestamps: the latest one presented at or before it
		const timestamps = Array.from({ length: Math.max(...presentationTimestamps) + 3 }, (_, i) => (i - 0.5) / 10);
		const expected = timestamps.map((timestamp) => {
			const presented = presentationTimestamps.filter(x => x / 10 <= timestamp);
			return presented.length > 0 ? Math.max(...presented) / 10 : null;
		});

		const cold: (number | null | undefined)[] = [];
		for (const timestamp of timestamps) {
			cold.push((await withSink(bytes, sink => lookUp(sink, [timestamp])))[0]);
		}
		expect(cold).toEqual(expected);

		// After the other lookups, in reverse order
		const reversed = await withSink(bytes, sink => lookUp(sink, [...timestamps].reverse()));
		expect(reversed.reverse()).toEqual(expected);

		// After reading every packet
		expect(await withSink(bytes, async (sink) => {
			for await (const packet of sink.packets()) {
				expect(packet.timestamp).toBeGreaterThanOrEqual(0);
			}
			return lookUp(sink, timestamps);
		})).toEqual(expected);
	}
});

test('Clear lead samples of an encrypted track stay unencrypted', async () => {
	// Shaka Packager's default 5 s clear lead: the stsd holds an encrypted (encv) and a clear (avc1) entry, and clear
	// fragments select the clear one through the tfhd's sample description index
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
	const iv = Buffer.from('0f0e0d0c0b0a09080706050403020100', 'hex');
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const visualSampleEntry = (type: string, ...children: number[][]) => box(type,
		zeros(6), [0, 1], zeros(16), [0, 64, 0, 64], zeros(12), [0, 1], zeros(32), [0, 24, 0xff, 0xff],
		box('avcC', [1, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x00]), ...children,
	);
	const sinf = box('sinf', box('frma', ascii('avc1')), box('schm', u32(0), ascii('cbcs'), u32(0x10000)), box('schi',
		box('tenc', u32(1 << 24), [0, 0x19, 1, 0], zeros(16), [16], [...iv]), // Pattern 1:9, constant IV
	));
	const moov = box('moov',
		box('mvhd', zeros(12), u32(10), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(10), u32(0), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(2), visualSampleEntry('encv', sinf), visualSampleEntry('avc1')),
					box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
				)),
			),
		),
		box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
	);

	const plaintext = [0, 0, 0, 161, 0x65, ...zeros(160).map((_, i) => i)]; // One NAL unit
	const ciphertext = [...plaintext]; // cbcs 1:9 only encrypts the first 16-byte block after the 5 clear bytes
	ciphertext.splice(5, 16, ...createCipheriv('aes-128-cbc', key, iv).setAutoPadding(false)
		.update(Buffer.from(plaintext.slice(5, 21))));

	const fragment = (sequenceNumber: number, sampleDescriptionIndex: number, data: number[]) => {
		const moof = (dataOffset: number) => box('moof', box('mfhd', u32(0), u32(sequenceNumber)), box('traf',
			box('tfhd', u32(0x020002), u32(1), u32(sampleDescriptionIndex)),
			box('tfdt', u32(0), u32(sequenceNumber - 1)),
			box('trun', u32(0x701), u32(1), u32(dataOffset), u32(1), u32(data.length), u32(0)),
			...(sampleDescriptionIndex === 1 ? [box('senc', u32(2), u32(1), [0, 1, 0, 5], u32(160))] : []),
		));
		return [...moof(moof(0).length + 8), ...box('mdat', data)];
	};

	using input = new Input({
		source: new BufferSource(new Uint8Array([
			...box('ftyp', ascii('iso6'), u32(0)),
			...moov,
			...fragment(1, 2, plaintext), // Clear lead
			...fragment(2, 1, ciphertext),
		])),
		formats: ALL_FORMATS,
		formatOptions: { isobmff: { resolveKeyId: () => key.toString('hex') } },
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const packets: number[][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([...packet.data]);
	}
	expect(packets).toEqual([plaintext, plaintext]);
});

test('Packet durations with B-frames spread over fragments', async () => {
	// Fragments that don't start a GOP: a frame's successor in presentation order can be in the next fragment
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const moov = box('moov',
		box('mvhd', zeros(12), u32(10), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(10), u32(0), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(1), box('avc1', zeros(24), [0, 64, 0, 64], zeros(50))),
					box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
				)),
			),
		),
		box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
	);

	// Decode order I P | B B P | B B with a decode duration of 1 each, presented as I B B P B B P
	const fragments = [[1, 3], [0, 0, 3], [0, 0]].flatMap((compositionOffsets, i) => {
		const traf = (dataOffset: number) => box('traf',
			box('tfhd', u32(0x020000), u32(1)),
			box('tfdt', u32(0), u32([0, 2, 5][i]!)),
			box('trun', u32(0xf01), u32(compositionOffsets.length), u32(dataOffset), ...compositionOffsets.map(
				(offset, j) => [...u32(1), ...u32(1), ...u32(i === 0 && j === 0 ? 0 : 0x10000), ...u32(offset)],
			)),
		);
		const moofSize = box('moof', box('mfhd', u32(0), u32(i + 1)), traf(0)).length;
		return [
			...box('moof', box('mfhd', u32(0), u32(i + 1)), traf(moofSize + 8)),
			...box('mdat', zeros(compositionOffsets.length)),
		];
	});

	using input = new Input({
		source: new BufferSource(new Uint8Array([...box('ftyp', ascii('iso5'), u32(0)), ...moov, ...fragments])),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const packets: number[][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([packet.timestamp, packet.duration]);
	}
	expect(packets).toEqual([[0.1, 0.1], [0.4, 0.1], [0.2, 0.1], [0.3, 0.1], [0.7, 0.1], [0.5, 0.1], [0.6, 0.1]]);
});

test('Fragmented video frames that depend on others are not key frames, even if marked as sync samples', async () => {
	// Every sample is a sync sample (no sample_is_non_sync_sample bit), but only the first doesn't depend on others
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const moov = box('moov',
		box('mvhd', zeros(12), u32(10), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(10), u32(0), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(1), box('avc1', zeros(24), [0, 64, 0, 64], zeros(50))),
					box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
				)),
			),
		),
		box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
	);

	const sampleFlags = [0x02000000, 0x01000000, 0x01000000, 0x02000000, 0x01000000];
	const traf = (dataOffset: number) => box('traf',
		box('tfhd', u32(0x020000), u32(1)),
		box('tfdt', u32(0), u32(0)),
		box('trun', u32(0x701), u32(sampleFlags.length), u32(dataOffset), ...sampleFlags.map(
			flags => [...u32(1), ...u32(1), ...u32(flags)],
		)),
	);
	const moofSize = box('moof', box('mfhd', u32(0), u32(1)), traf(0)).length;
	const fragment = [...box('moof', box('mfhd', u32(0), u32(1)), traf(moofSize + 8)), ...box('mdat', zeros(5))];

	using input = new Input({
		source: new BufferSource(new Uint8Array([...box('ftyp', ascii('iso5'), u32(0)), ...moov, ...fragment])),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	const types: string[] = [];
	for await (const packet of sink.packets()) {
		types.push(packet.type);
	}
	expect(types).toEqual(['key', 'delta', 'delta', 'key', 'delta']);
	expect((await sink.getKeyPacket(0.25))?.timestamp).toBe(0);
});
