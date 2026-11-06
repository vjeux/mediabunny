import { createCipheriv } from 'node:crypto';
import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
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

test('AAC encoder delay from the iTunSMPB tag when there is no edit list', async () => {
	// Like iTunes/QuickTime X output: the 2112 priming samples are only declared in iTunSMPB, without an edts box
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	// ES_Descriptor > DecoderConfigDescriptor (AAC) > AudioSpecificConfig (AAC-LC, 44100 Hz, stereo), SLConfig
	const esds = box(
		'esds',
		zeros(4),
		[3, 25, 0, 1, 0],
		[4, 17, 0x40, 0x15, ...zeros(11)],
		[5, 2, 0x12, 0x10],
		[6, 1, 2],
	);
	const smpb = ' 00000000 00000840 00000338 0000000000015888 00000000 00000000 00000000 00000000';
	const itunes = box('udta', box('meta', zeros(4), box('hdlr', zeros(8), ascii('mdir'), zeros(13)), box('ilst',
		box('----', box('mean', zeros(4), ascii('com.apple.iTunes')), box('name', zeros(4), ascii('iTunSMPB')),
			box('data', u32(1), u32(0), ascii(smpb))),
	)));

	const build = (edts: number[]) => {
		const moov = (chunkOffset: number) => box('moov',
			box('mvhd', zeros(12), u32(44100), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
			box('trak',
				box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, zeros(8)),
				edts,
				box('mdia',
					box('mdhd', zeros(12), u32(44100), u32(4096), [0x55, 0xc4, 0, 0]),
					box('hdlr', zeros(8), ascii('soun'), zeros(13)),
					box('minf', box('stbl',
						box('stsd', u32(0), u32(1), box('mp4a', zeros(6), [0, 1], zeros(8), [0, 2, 0, 16], zeros(4),
							u32(44100 * 0x10000), esds)),
						box('stts', u32(0), u32(1), u32(4), u32(1024)),
						box('stsc', u32(0), u32(1), u32(1), u32(4), u32(1)),
						box('stsz', u32(0), u32(10), u32(4)),
						box('stco', u32(0), u32(1), u32(chunkOffset)),
					)),
				),
			),
			itunes,
		);
		const ftyp = box('ftyp', ascii('M4A '), u32(0), ascii('M4A '));
		const moovSize = moov(0).length;
		return new Uint8Array([...ftyp, ...moov(ftyp.length + moovSize + 8), ...box('mdat', zeros(40))]);
	};

	const firstTimestamp = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return (await input.getPrimaryAudioTrack())!.getFirstTimestamp();
	};

	expect(await firstTimestamp(build([]))).toBeCloseTo(-2112 / 44100, 12);

	// An edit list takes precedence over iTunSMPB
	const edts = box('edts', box('elst', zeros(4), u32(1), u32(4096 - 1024), u32(1024), u32(0x10000)));
	expect(await firstTimestamp(build(edts))).toBeCloseTo(-1024 / 44100, 12);
});

test('Tracks whose hdlr box comes after minf', async () => {
	// Box order within mdia is free; some MPEG-4 Systems encoders write mdhd, minf, hdlr
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const avcC = box('avcC', [1, 0x42, 0, 0x1e, 0xff, 0xe0, 0]);
	const avc1 = box('avc1', zeros(6), [0, 1], zeros(16), [0, 64, 0, 64], zeros(50), avcC);
	const mp4a = box('mp4a', zeros(6), [0, 1], zeros(8), [0, 2, 0, 16], zeros(4), u32(44100 * 0x10000), box('esds',
		zeros(4), [3, 25, 0, 1, 0], [4, 17, 0x40, 0x15, ...zeros(11)], [5, 2, 0x12, 0x10], [6, 1, 2],
	));

	const trak = (id: number, handlerType: string, timescale: number, entry: number[], chunkOffset: number) => box(
		'trak',
		box('tkhd', u32(3), zeros(8), u32(id), zeros(24), matrix, zeros(8)),
		box('mdia',
			box('mdhd', zeros(12), u32(timescale), u32(0), [0x55, 0xc4, 0, 0]),
			box('minf', box('stbl',
				box('stsd', u32(0), u32(1), entry),
				box('stts', u32(0), u32(1), u32(2), u32(timescale / 10)),
				box('stsc', u32(0), u32(1), u32(1), u32(2), u32(1)),
				box('stsz', u32(0), u32(5), u32(2)),
				box('stco', u32(0), u32(1), u32(chunkOffset)),
			)),
			box('hdlr', zeros(8), ascii(handlerType), zeros(13)),
		),
	);
	const moov = (dataStart: number) => box('moov',
		box('mvhd', zeros(12), u32(1000), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		trak(1, 'vide', 30, avc1, dataStart),
		trak(2, 'soun', 44100, mp4a, dataStart + 10),
	);
	const ftyp = box('ftyp', ascii('mp42'), u32(0), ascii('mp42'));
	const moovSize = moov(0).length;

	using input = new Input({
		source: new BufferSource(new Uint8Array([
			...ftyp,
			...moov(ftyp.length + moovSize + 8),
			...box('mdat', zeros(20)),
		])),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack && audioTrack);
	expect(await videoTrack.getCodec()).toBe('avc');
	expect(await videoTrack.getCodedWidth()).toBe(64);
	expect(await audioTrack.getCodec()).toBe('aac');
	expect(await audioTrack.getSampleRate()).toBe(44100);
	expect(await videoTrack.computeDuration()).toBeCloseTo(0.2);
});

test('VP9 with a version 0 vpcC box', async () => {
	using webmInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/vp9-smpte170m.webm')),
		formats: ALL_FORMATS,
	});
	const webmTrack = await webmInput.getPrimaryVideoTrack();
	assert(webmTrack);
	const keyFrame = await new EncodedPacketSink(webmTrack).getFirstPacket();
	assert(keyFrame);

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source);
	await output.start();
	await source.add(keyFrame, { decoderConfig: (await webmTrack.getDecoderConfig())! });
	await output.finalize();

	// Rewrite vpcC in the layout of the spec's early draft (as found in WebKit's bipbop-vp9.mp4): profile, level,
	// bitDepth + colorSpace, chromaSubsampling + transferFunction + videoFullRangeFlag, codecInitializationDataSize
	const bytes = new Uint8Array(output.target.buffer!);
	const vpcCPos = String.fromCharCode(...bytes).indexOf('vpcC');
	expect(vpcCPos).toBeGreaterThan(0);
	bytes.set([0, 0, 0, 0, 0, 0, 0x80, 0x10, 0, 0, 0, 0], vpcCPos + 4);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	// The early layout doesn't have the fields we'd read, so the codec info comes from the key frame
	expect(await track.getCodecParameterString()).toBe(await webmTrack.getCodecParameterString());
	expect(await track.getColorSpace()).toEqual(await webmTrack.getColorSpace());
});

test('24 and 32-bit PCM in twos and sowt sample entries', async () => {
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];

	// A QuickTime sound sample description (version 0), stereo, 48 kHz, 4 PCM frames in one chunk
	const read = async (fourCc: string, sampleSize: number, littleEndian = false) => {
		const frameSize = 2 * sampleSize / 8;
		const pcm = Array.from({ length: 4 * frameSize }, (_, i) => i);
		const moov = (chunkOffset: number) => box('moov',
			box('mvhd', zeros(12), u32(1000), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
			box('trak',
				box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, zeros(8)),
				box('mdia',
					box('mdhd', zeros(12), u32(48000), u32(4), [0x55, 0xc4, 0, 0]),
					box('hdlr', zeros(8), ascii('soun'), zeros(13)),
					box('minf', box('stbl',
						box('stsd', u32(0), u32(1), box(fourCc, zeros(6), [0, 1], zeros(8), [0, 2, 0, sampleSize],
							zeros(4), u32(48000 * 0x10000), littleEndian
								? box('wave', box('frma', ascii(fourCc)), box('enda', [0, 1]), zeros(8))
								: [])),
						box('stts', u32(0), u32(1), u32(4), u32(1)),
						box('stsc', u32(0), u32(1), u32(1), u32(4), u32(1)),
						box('stsz', u32(0), u32(frameSize), u32(4)),
						box('stco', u32(0), u32(1), u32(chunkOffset)),
					)),
				),
			),
		);
		const ftyp = box('ftyp', ascii('qt  '), u32(0), ascii('qt  '));
		const moovSize = moov(0).length;

		using input = new Input({
			source: new BufferSource(new Uint8Array([
				...ftyp,
				...moov(ftyp.length + moovSize + 8),
				...box('mdat', pcm),
			])),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const packet = await new EncodedPacketSink(track).getFirstPacket();

		return { codec: await track.getCodec(), data: [...packet!.data], expected: pcm };
	};

	for (const [fourCc, sampleSize, littleEndian, codec] of [
		['twos', 24, false, 'pcm-s24be'],
		['twos', 32, false, 'pcm-s32be'],
		['twos', 24, true, 'pcm-s24'], // enda = 1, like for 16-bit twos
		['twos', 32, true, 'pcm-s32'],
		['sowt', 24, false, 'pcm-s24'],
		['sowt', 32, false, 'pcm-s32'],
	] as const) {
		const result = await read(fourCc, sampleSize, littleEndian);
		expect(result.codec).toBe(codec);
		expect(result.data).toEqual(result.expected);
	}
});

test('Fragment data after the traf of a track that is not read', async () => {
	// Without base data offsets in tfhd, a traf's data follows the previous traf's data (like FFmpeg's
	// omit_tfhd_offset), so the skipped subtitle track's data must be accounted for
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const trak = (id: number, handlerType: string, sampleEntry: number[]) => box('trak',
		box('tkhd', u32(3), zeros(8), u32(id), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
		box('mdia',
			box('mdhd', zeros(12), u32(10), u32(0), [0x55, 0xc4, 0, 0]),
			box('hdlr', zeros(8), ascii(handlerType), zeros(13)),
			box('minf', box('stbl',
				box('stsd', u32(0), u32(1), sampleEntry),
				box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
			)),
		),
	);
	const moov = box('moov',
		box('mvhd', zeros(12), u32(10), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		trak(1, 'text', box('tx3g', zeros(38))),
		trak(2, 'vide', box('avc1', zeros(24), [0, 64, 0, 64], zeros(50))),
		box('mvex',
			box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0)),
			box('trex', u32(0), u32(2), u32(1), u32(1), u32(0), u32(0)),
		),
	);

	const subtitleSamples = [[1, 1, 1, 1, 1], [2, 2, 2]];
	const videoSamples = [[3, 3, 3, 3], [4, 4, 4, 4, 4, 4]];
	const trun = (dataOffset: number, sampleSizes: number[]) => box('trun', u32(0x000301), u32(sampleSizes.length),
		u32(dataOffset), ...sampleSizes.map(size => [...u32(1), ...u32(size)]));
	const moof = (subtitleDataOffset: number) => box('moof',
		box('mfhd', u32(0), u32(1)),
		box('traf', box('tfhd', u32(0), u32(1)), box('tfdt', u32(0), u32(0)),
			trun(subtitleDataOffset, subtitleSamples.map(x => x.length))),
		// The base data offset is the end of the subtitle data, where the video data starts
		box('traf', box('tfhd', u32(0x000020), u32(2), u32(0)), box('tfdt', u32(0), u32(0)),
			trun(0, videoSamples.map(x => x.length))),
	);
	const moofSize = moof(0).length;
	const fragment = [...moof(moofSize + 8), ...box('mdat', ...subtitleSamples, ...videoSamples)];

	using input = new Input({
		source: new BufferSource(new Uint8Array([...box('ftyp', ascii('iso5'), u32(0)), ...moov, ...fragment])),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const packets: number[][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([...packet.data]);
	}
	expect(packets).toEqual(videoSamples);
});

test('Pattern encryption whose last pattern ends inside the encrypted blocks', async () => {
	// With a 2:8 pattern over 184 protected bytes, the last pattern holds one complete block, which is encrypted,
	// and 8 bytes that stay clear (ISO/IEC 23001-7 10.4.2)
	const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
	const iv = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', 'hex');
	const keyId = zeros(16).map((_, i) => 0x10 + i);

	const plaintext = Array.from({ length: 5 + 184 }, (_, i) => (i * 7) & 0xff);
	const cryptBlocks = [[5, 32], [5 + 160, 16]]; // [offset, length] of the encrypted parts

	const build = (scheme: 'cens' | 'cbcs') => {
		const cipher = scheme === 'cens'
			? createCipheriv('aes-128-ctr', key, iv)
			: createCipheriv('aes-128-cbc', key, iv).setAutoPadding(false);
		const ciphertext = [...plaintext];
		for (const [offset, length] of cryptBlocks) {
			const encrypted = cipher.update(Buffer.from(plaintext.slice(offset, offset! + length!)));
			ciphertext.splice(offset!, length!, ...encrypted);
		}

		const tenc = box('tenc', [1, 0, 0, 0], [0, 0x28, 1, scheme === 'cens' ? 16 : 0], keyId,
			scheme === 'cbcs' ? [16, ...iv] : []);
		const encv = box('encv', zeros(24), [0, 64, 0, 64], zeros(50), box('sinf', box('frma', ascii('avc1')),
			box('schm', zeros(4), ascii(scheme), u32(0x10000)), box('schi', tenc)));
		const moov = box('moov',
			box('mvhd', zeros(12), u32(10), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
			box('trak',
				box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
				box('mdia',
					box('mdhd', zeros(12), u32(10), u32(0), [0x55, 0xc4, 0, 0]),
					box('hdlr', zeros(8), ascii('vide'), zeros(13)),
					box('minf', box('stbl',
						box('stsd', u32(0), u32(1), encv),
						box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
					)),
				),
			),
			box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
		);
		const senc = box('senc', u32(2), u32(1), scheme === 'cens' ? [...iv] : [], u16(1), u16(5), u32(184));
		const traf = (dataOffset: number) => box('traf',
			box('tfhd', u32(0x020000), u32(1)),
			box('tfdt', u32(0), u32(0)),
			box('trun', u32(0x301), u32(1), u32(dataOffset), u32(1), u32(ciphertext.length)),
			senc,
		);
		const moofSize = box('moof', box('mfhd', u32(0), u32(1)), traf(0)).length;

		return new Uint8Array([
			...box('ftyp', ascii('iso6'), u32(0)),
			...moov,
			...box('moof', box('mfhd', u32(0), u32(1)), traf(moofSize + 8)),
			...box('mdat', ciphertext),
		]);
	};

	for (const scheme of ['cens', 'cbcs'] as const) {
		using input = new Input({
			source: new BufferSource(build(scheme)),
			formats: ALL_FORMATS,
			formatOptions: { isobmff: { resolveKeyId: () => key } },
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const packet = await new EncodedPacketSink(track).getFirstPacket();
		expect([...packet!.data]).toEqual(plaintext);
	}
});

test('cbcs subsamples with the pattern 0:0 have all their complete blocks encrypted', async () => {
	const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
	const iv = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', 'hex');
	const keyId = zeros(16).map((_, i) => 0x10 + i);

	// Two subsamples (5 clear + 100 protected, 3 clear + 40 protected); the CBC chain restarts at each one and
	// trailing partial blocks stay clear
	const plaintext = Array.from({ length: 148 }, (_, i) => (i * 7) & 0xff);
	const ciphertext = [...plaintext];
	for (const [offset, length] of [[5, 96], [108, 32]]) {
		const cipher = createCipheriv('aes-128-cbc', key, iv).setAutoPadding(false);
		ciphertext.splice(offset!, length!, ...cipher.update(Buffer.from(plaintext.slice(offset, offset! + length!))));
	}

	const tenc = box('tenc', [1, 0, 0, 0], [0, 0x00, 1, 0], keyId, [16, ...iv]);
	const encv = box('encv', zeros(24), [0, 64, 0, 64], zeros(50), box('sinf', box('frma', ascii('avc1')),
		box('schm', zeros(4), ascii('cbcs'), u32(0x10000)), box('schi', tenc)));
	const moov = box('moov',
		box('mvhd', zeros(12), u32(10), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(10), u32(0), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(1), encv),
					box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
				)),
			),
		),
		box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
	);
	const senc = box('senc', u32(2), u32(1), u16(2), u16(5), u32(100), u16(3), u32(40));
	const traf = (dataOffset: number) => box('traf',
		box('tfhd', u32(0x020000), u32(1)),
		box('tfdt', u32(0), u32(0)),
		box('trun', u32(0x301), u32(1), u32(dataOffset), u32(1), u32(ciphertext.length)),
		senc,
	);
	const moofSize = box('moof', box('mfhd', u32(0), u32(1)), traf(0)).length;

	using input = new Input({
		source: new BufferSource(new Uint8Array([
			...box('ftyp', ascii('iso6'), u32(0)),
			...moov,
			...box('moof', box('mfhd', u32(0), u32(1)), traf(moofSize + 8)),
			...box('mdat', ciphertext),
		])),
		formats: ALL_FORMATS,
		formatOptions: { isobmff: { resolveKeyId: () => key } },
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const packet = await new EncodedPacketSink(track).getFirstPacket();
	expect([...packet!.data]).toEqual(plaintext);
});

test('Decoder config of a track with several sample descriptions', async () => {
	// Like concatenated files: chunk 1 uses the first description, chunk 2 the second
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const avc1 = (width: number, height: number, profile: number, level: number) => box('avc1', zeros(6), [0, 1],
		zeros(16), [width >> 8, width & 0xff, height >> 8, height & 0xff], zeros(50),
		box('avcC', [1, profile, 0, level, 0xff, 0xe0, 0]));

	const moov = (chunkOffsets: number[]) => box('moov',
		box('mvhd', zeros(12), u32(30), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(320 << 16), u32(240 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(30), u32(4), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(2), avc1(320, 240, 0x42, 0x1e), avc1(640, 480, 0x64, 0x1f)),
					box('stts', u32(0), u32(1), u32(4), u32(1)),
					box('stsc', u32(0), u32(2), u32(1), u32(2), u32(1), u32(2), u32(2), u32(2)),
					box('stsz', u32(0), u32(3), u32(4)),
					box('stco', u32(0), u32(2), ...chunkOffsets.map(u32)),
				)),
			),
		),
	);
	const ftyp = box('ftyp', ascii('isom'), u32(0), ascii('isom'));
	const dataStart = ftyp.length + moov([0, 0]).length + 8;

	using input = new Input({
		source: new BufferSource(new Uint8Array([
			...ftyp,
			...moov([dataStart, dataStart + 6]),
			...box('mdat', zeros(12)),
		])),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	expect(await track.getCodedWidth()).toBe(320);
	expect(await track.getCodedHeight()).toBe(240);
	expect((await track.getDecoderConfig())?.codec).toBe('avc1.42001e');
});

test('Encryption info from a sample description other than the one in use', async () => {
	// A clear lead whose clear sample description comes first: the first fragment uses the clear description, which
	// the track's codec info comes from, but the second fragment's encrypted description must still be decryptable
	const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
	const keyId = zeros(16).map((_, i) => 0x10 + i);
	const iv = [1, 2, 3, 4, 5, 6, 7, 8];

	const plaintext = Array.from({ length: 40 }, (_, i) => i);
	const counter = Buffer.alloc(16);
	counter.set(iv);
	const ciphertext = [...plaintext.slice(0, 4), ...createCipheriv('aes-128-ctr', key, counter).update(
		Buffer.from(plaintext.slice(4)),
	)];

	const avcC = box('avcC', [1, 0x42, 0, 0x1e, 0xff, 0xe0, 0]);
	const avc1 = box('avc1', zeros(24), [0, 64, 0, 64], zeros(50), avcC);
	const encv = box('encv', zeros(24), [0, 64, 0, 64], zeros(50), avcC, box('sinf', box('frma', ascii('avc1')),
		box('schm', zeros(4), ascii('cenc'), u32(0x10000)), box('schi', box('tenc', zeros(4), [0, 0, 1, 8], keyId))));
	const moov = box('moov',
		box('mvhd', zeros(12), u32(10), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(10), u32(0), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(2), avc1, encv),
					box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
				)),
			),
		),
		box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
	);
	const fragment = (sequence: number, sampleDescriptionIndex: number, data: number[], extra: number[][]) => {
		const traf = (dataOffset: number) => box('traf',
			box('tfhd', u32(0x020002), u32(1), u32(sampleDescriptionIndex)),
			box('tfdt', u32(0), u32(sequence - 1)),
			box('trun', u32(0x301), u32(1), u32(dataOffset), u32(1), u32(data.length)),
			...extra,
		);
		const moofSize = box('moof', box('mfhd', u32(0), u32(sequence)), traf(0)).length;
		return [...box('moof', box('mfhd', u32(0), u32(sequence)), traf(moofSize + 8)), ...box('mdat', data)];
	};

	using input = new Input({
		source: new BufferSource(new Uint8Array([
			...box('ftyp', ascii('iso6'), u32(0)),
			...moov,
			...fragment(1, 1, plaintext, []),
			...fragment(2, 2, ciphertext, [box('senc', u32(2), u32(1), iv, u16(1), u16(4), u32(plaintext.length - 4))]),
		])),
		formats: ALL_FORMATS,
		formatOptions: { isobmff: { resolveKeyId: () => key } },
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	expect(await track.getInternalCodecId()).toBe('avc1');
	const packets: number[][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([...packet.data]);
	}
	expect(packets).toEqual([plaintext, plaintext]);
});

test('Codec info from the sample description the samples use', async () => {
	// Like samples.ffmpeg.org trac/ticket1762/counter-10mn_mp3_dash.mp4: a fragmented track has an AAC and an MP3
	// description, trex refers to a description that doesn't exist, and the fragments use the MP3 one
	const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const mp4a = (objectTypeIndication: number, decoderSpecificInfo: number[]) => {
		const dsi = decoderSpecificInfo.length > 0 ? [0x05, decoderSpecificInfo.length, ...decoderSpecificInfo] : [];
		const decoderConfig = [0x04, 13 + dsi.length, objectTypeIndication, 0x15, ...zeros(11), ...dsi];
		const esds = box('esds', zeros(4), [0x03, 3 + decoderConfig.length + 3, 0, 1, 0], decoderConfig, [6, 1, 2]);
		return box('mp4a', zeros(6), u16(1), zeros(8), u16(1), u16(16), zeros(4), u32(44100 * 0x10000), esds);
	};
	const aac = mp4a(0x40, [0x12, 0x08]);
	const mp3 = mp4a(0x6b, []);

	const read = async (entries: number[][], trexIndex: number, tfhdIndex: number | null) => {
		const moov = box('moov',
			box('mvhd', zeros(12), u32(44100), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
			box('trak',
				box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, zeros(8)),
				box('mdia',
					box('mdhd', zeros(12), u32(44100), u32(0), [0x55, 0xc4, 0, 0]),
					box('hdlr', zeros(8), ascii('soun'), zeros(13)),
					box('minf', box('stbl',
						box('stsd', u32(0), u32(entries.length), ...entries),
						box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
					)),
				),
			),
			box('mvex', box('trex', u32(0), u32(1), u32(trexIndex), u32(1152), u32(0), u32(0))),
		);
		const tfhd = tfhdIndex === null
			? box('tfhd', u32(0x020000), u32(1))
			: box('tfhd', u32(0x020002), u32(1), u32(tfhdIndex));
		const traf = (dataOffset: number) => box('traf', tfhd, box('tfdt', u32(0), u32(0)),
			box('trun', u32(0x201), u32(1), u32(dataOffset), u32(4)));
		const moofSize = box('moof', box('mfhd', u32(0), u32(1)), traf(0)).length;

		using input = new Input({
			source: new BufferSource(new Uint8Array([
				...box('ftyp', ascii('iso6'), u32(0)),
				...moov,
				...box('sidx', zeros(24)),
				...box('moof', box('mfhd', u32(0), u32(1)), traf(moofSize + 8)),
				...box('mdat', [0xff, 0xfb, 0x50, 0xc4]),
			])),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		return track.getCodec();
	};

	expect(await read([aac, mp3], 1024, 2)).toBe('mp3'); // The fragments' tfhd
	expect(await read([mp3, aac], 1024, 1)).toBe('mp3');
	expect(await read([aac, mp3], 2, null)).toBe('mp3'); // trex
	expect(await read([mp3, aac], 1, null)).toBe('mp3');
});

test('Vorbis with length-prefixed headers in esds', async () => {
	// gpac (samples.ffmpeg.org MPEG-4/vorbis-in-mp4/*.mp4) prefixes each Vorbis header with a 16-bit length instead of
	// the Xiph lacing that decoders expect
	using oggInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/vorbis-eos.ogg')),
		formats: ALL_FORMATS,
	});
	const oggTrack = await oggInput.getPrimaryAudioTrack();
	assert(oggTrack);
	const oggConfig = (await oggTrack.getDecoderConfig())!;

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('vorbis');
	output.addAudioTrack(source);
	await output.start();
	let i = 0;
	for await (const packet of new EncodedPacketSink(oggTrack).packets()) {
		await source.add(packet, i === 0 ? { decoderConfig: oggConfig } : undefined);
		if (++i === 10) {
			break;
		}
	}
	await output.finalize();

	// Split the Xiph-laced headers, which only works for this fixture's small comment header
	const laced = toUint8Array(oggConfig.description!);
	expect([laced[0], laced[1]]).toEqual([2, 30]);
	const identification = laced.subarray(3, 3 + 30);
	const comment = laced.subarray(3 + 30, 3 + 30 + laced[2]!);
	const setup = laced.subarray(3 + 30 + laced[2]!);

	// Rewrite the description in place. The length prefixes take 3 more bytes than the segment table, so make up for
	// it by cutting 3 bytes off the vendor string in the comment header.
	const view = new DataView(comment.buffer, comment.byteOffset);
	const vendorLength = view.getUint32(7, true);
	const shortComment = new Uint8Array([
		...comment.subarray(0, 7),
		0, 0, 0, 0, // Vendor length, set below
		...comment.subarray(11, 11 + vendorLength - 3),
		...comment.subarray(11 + vendorLength),
	]);
	new DataView(shortComment.buffer).setUint32(7, vendorLength - 3, true);
	const lengthPrefixed = new Uint8Array([
		0, 30, ...identification,
		shortComment.length >> 8, shortComment.length & 0xff, ...shortComment,
		setup.length >> 8, setup.length & 0xff, ...setup,
	]);
	expect(lengthPrefixed.length).toBe(laced.length);

	const bytes = new Uint8Array(output.target.buffer!);
	const descriptionPos = bytes.findIndex((_, pos) => laced.every((byte, j) => bytes[pos + j] === byte));
	expect(descriptionPos).toBeGreaterThan(0);
	bytes.set(lengthPrefixed, descriptionPos);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const config = (await track.getDecoderConfig())!;

	const expectedDescription = [2, 30, shortComment.length, ...identification, ...shortComment, ...setup];
	expect([...toUint8Array(config.description!)]).toEqual(expectedDescription);
	expect(config.numberOfChannels).toBe(oggConfig.numberOfChannels);
	expect(config.sampleRate).toBe(oggConfig.sampleRate);
});

test('Key rotation through CENC sample groups in fragments', async () => {
	// Like Shaka Packager with key rotation: each fragment declares its key in a 'seig' sample group description
	// that all of its samples map to, overriding the key (and here the IV size) of the tenc box
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const keys = [Buffer.alloc(16, 0x11), Buffer.alloc(16, 0x22)];
	const keyIds = [zeros(16).fill(0xa1), zeros(16).fill(0xb2)];
	const ivs = [zeros(8).fill(1), zeros(16).fill(2)];

	const plaintext = Array.from({ length: 40 }, (_, i) => i);
	const encrypt = (fragment: number) => {
		const counter = Buffer.alloc(16);
		counter.set(ivs[fragment]!);
		return [...createCipheriv('aes-128-ctr', keys[fragment]!, counter).update(Buffer.from(plaintext))];
	};

	const tenc = box('tenc', zeros(4), [0, 0, 1, 8], keyIds[0]!);
	const encv = box('encv', zeros(24), [0, 64, 0, 64], zeros(50), box('sinf', box('frma', ascii('avc1')),
		box('schm', zeros(4), ascii('cenc'), u32(0x10000)), box('schi', tenc)));
	const moov = box('moov',
		box('mvhd', zeros(12), u32(10), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(10), u32(0), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(1), encv),
					box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
				)),
			),
		),
		box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
	);

	const fragment = (index: number) => {
		const groups = index === 1
			? [
					box('sbgp', zeros(4), ascii('seig'), u32(1), u32(1), u32(0x10001)),
					box('sgpd', [1, 0, 0, 0], ascii('seig'), u32(20), u32(1), [0, 0, 1, 16], keyIds[1]!),
				]
			: [];
		const traf = (dataOffset: number) => box('traf',
			box('tfhd', u32(0x020000), u32(1)),
			box('tfdt', u32(0), u32(index)),
			box('trun', u32(0x301), u32(1), u32(dataOffset), u32(1), u32(plaintext.length)),
			box('senc', u32(0), u32(1), ivs[index]!),
			...groups,
		);
		const moofSize = box('moof', box('mfhd', u32(0), u32(index + 1)), traf(0)).length;
		return [
			...box('moof', box('mfhd', u32(0), u32(index + 1)), traf(moofSize + 8)),
			...box('mdat', encrypt(index)),
		];
	};

	const bytes = new Uint8Array([...box('ftyp', ascii('iso6'), u32(0)), ...moov, ...fragment(0), ...fragment(1)]);

	const requestedKeyIds: string[] = [];
	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
		formatOptions: {
			isobmff: {
				resolveKeyId: ({ keyId }) => {
					requestedKeyIds.push(keyId);
					return keys[keyId === Buffer.from(keyIds[0]!).toString('hex') ? 0 : 1]!;
				},
			},
		},
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const packets: number[][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([...packet.data]);
	}
	expect(packets).toEqual([plaintext, plaintext]);
	expect(requestedKeyIds).toEqual(keyIds.map(x => Buffer.from(x).toString('hex')));
});

test('VP9 whose vpcC box has level 0', async () => {
	// The vpcC box of Chrome's MediaRecorder MP4 recordings, at 320x240: profile 0, level 0, 8-bit 4:2:0, full range,
	// BT.709 primaries and matrix, sRGB transfer
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const vpcC = box('vpcC', [1, 0, 0, 0], [0x00, 0x00, 0x81, 0x01, 0x0d, 0x01, 0x00, 0x00]);
	const moov = (chunkOffset: number) => box('moov',
		box('mvhd', zeros(12), u32(1000), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(320 << 16), u32(240 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(30), u32(1), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(1), box('vp09', zeros(6), [0, 1], zeros(16), [1, 64, 0, 240], zeros(50),
						vpcC)),
					box('stts', u32(0), u32(1), u32(1), u32(1)),
					box('stsc', u32(0), u32(1), u32(1), u32(1), u32(1)),
					box('stsz', u32(0), u32(4), u32(1)),
					box('stco', u32(0), u32(1), u32(chunkOffset)),
				)),
			),
		),
	);
	const ftyp = box('ftyp', ascii('isom'), u32(0), ascii('isom'));
	const moovSize = moov(0).length;

	using input = new Input({
		source: new BufferSource(new Uint8Array([
			...ftyp,
			...moov(ftyp.length + moovSize + 8),
			...box('mdat', zeros(4)),
		])),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	// Level 2 is the lowest that fits 320x240
	expect((await track.getDecoderConfig())?.codec).toBe('vp09.00.20.08.00.01.13.01.01');
});

test('QuickTime text in Mac Roman with a trailing NUL', async () => {
	// QuickTime-era files tag their udta text with a Macintosh language code, which means Mac Roman, and often count a
	// terminating NUL into the length (e.g. samples.ffmpeg.org V-codecs/SVQ1/audi_a4.mov, SVQ3/shrek2_tsr_qt_240.mov)
	const output = new Output({ format: new MovOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	output.setMetadataTags({ title: 'Az új Audi A4' });
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 0.1), {
		decoderConfig: { codec: 'vp8', codedWidth: 16, codedHeight: 16 },
	});
	await output.finalize();

	// Rewrite the title in place with language code 0 (English): Mac Roman text plus a NUL takes the same 14 bytes as
	// the UTF-8 text
	const bytes = new Uint8Array(output.target.buffer!);
	const titlePos = bytes.findIndex((_, i) => bytes[i] === 0xa9 && bytes[i + 1] === 0x6e && bytes[i + 2] === 0x61
		&& bytes[i + 3] === 0x6d); // ©nam
	expect(titlePos).toBeGreaterThan(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	bytes.set([0, 14, 0, 0, ...ascii('Az '), 0x9c, ...ascii('j Audi A4'), 0], titlePos + 4);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	expect((await input.getMetadataTags()).title).toBe('Az új Audi A4');
});
