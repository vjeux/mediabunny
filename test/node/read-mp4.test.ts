import { createCipheriv } from 'node:crypto';
import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	AudioSampleSink,
	BufferSource,
	BufferTarget,
	CustomSource,
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
	ReadableStreamSource,
} from '../../src/index.js';
import { iterateNalUnitsInLengthPrefixed } from '../../src/codec-data.js';
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

test('AV1 codec string follows the colr box', async () => {
	// The sequence header leaves the primaries and matrix unspecified (2/1/2), and the colr box, retagged on a stream
	// copy, says BT.709 (1/1/1). AV1-ISOBMFF section 5: with an nclx colr box, the codec string's color fields equal
	// its values. Made with (FFmpeg 8):
	// ffmpeg -f lavfi -i color=c=red:s=64x64:r=1 -frames:v 1 \
	//   -vf setparams=color_trc=bt709:color_primaries=unknown:colorspace=unknown:range=tv -c:v libaom-av1 -cpu-used 8 \
	//   -color_trc bt709 -color_primaries unspecified -colorspace unspecified -color_range tv partial.mp4
	// ffmpeg -i partial.mp4 -c copy -color_primaries bt709 -colorspace bt709 av1-colr-retagged.mp4
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/av1-colr-retagged.mp4')),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const decoderConfig = (await track.getDecoderConfig())!;

	expect(decoderConfig.colorSpace).toEqual({
		primaries: 'bt709',
		transfer: 'bt709',
		matrix: 'bt709',
		fullRange: false,
	});
	expect(decoderConfig.codec).toBe('av01.0.00M.08'); // All color fields at their defaults (BT.709, limited range)
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

test('AAC channel configurations 11 to 14 give the channel count', async () => {
	// ISO/IEC 14496-3 added channelConfiguration 11 (6.1), 12 (7.1 rear), 13 (22.2) and 14 (7.1 top front), with 7, 8,
	// 24 and 8 channels (FFmpeg's ff_mpeg4audio_channels). The AudioSpecificConfig is what counts, not the sample
	// entry's channel count, which muxers often set to 2. Made with:
	// ffmpeg -f lavfi -i anullsrc=r=48000:cl=7.1 -t 0.1 -c:a aac aac-7.1.mp4
	// Its AudioSpecificConfig has configuration 7, which has the same channel elements as 12, so changing it to 12
	// gives a file that FFmpeg decodes to 8 channels.
	const original = readFileSync(path.join(__dirname, '..', 'public/aac-7.1.mp4'));
	const audioSpecificConfigOffset = original.indexOf(Buffer.from([0x11, 0xb8, 0x56, 0xe5, 0x00]));
	const sampleEntryOffset = original.indexOf('mp4a');
	expect(audioSpecificConfigOffset).toBeGreaterThan(0);
	expect(sampleEntryOffset).toBeGreaterThan(0);

	for (const [channelConfiguration, numberOfChannels] of [[7, 8], [11, 7], [12, 8], [13, 24], [14, 8]] as const) {
		const data = Buffer.from(original);
		data[audioSpecificConfigOffset + 1] = 0x80 | (channelConfiguration << 3);
		data.writeUInt16BE(2, sampleEntryOffset + 20); // The sample entry's channelcount

		using input = new Input({
			source: new BufferSource(data),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryAudioTrack())!;
		expect({ channelConfiguration, numberOfChannels: await track.getNumberOfChannels() })
			.toEqual({ channelConfiguration, numberOfChannels });
		expect((await track.getDecoderConfig())!.numberOfChannels).toBe(numberOfChannels);
	}
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

test('AAC config with channel configuration 0 but no program config element', async () => {
	// Channel configuration 0 means the layout is in a PCE following the config, but this one has none, so the
	// channel count has to come from the sample entry (2) instead
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();
	for (let i = 0; i < 3; i++) {
		await source.add(new EncodedPacket(new Uint8Array(20), 'key', i * 1024 / 44100, 1024 / 44100), {
			decoderConfig: {
				codec: 'mp4a.40.2',
				numberOfChannels: 2,
				sampleRate: 44100,
				description: new Uint8Array([0x12, 0x00]), // AAC-LC, 44.1 kHz, channel configuration 0
			},
		});
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getNumberOfChannels()).toBe(2);
	expect((await track.getDecoderConfig())!.numberOfChannels).toBe(2);
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

test('MP2 audio in a QuickTime .mp2 sample entry', async () => {
	// FFmpeg's MOV muxer writes MPEG-1/2 Layer II audio (e.g. from DVB broadcasts) as a .mp2 sample entry
	const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];

	const read = async (options: {
		sampleRate: number;
		frames: number[][];
		sampleEntryExtra: number[];
		version: number;
		stbl: (dataStart: number) => number[][];
	}) => {
		const sampleEntry = box('.mp2',
			zeros(6), u16(1), // Data reference index
			u16(options.version), zeros(6),
			u16(2), u16(16), u16(0xffff), u16(0), u32(options.sampleRate * 0x10000),
			options.sampleEntryExtra,
		);
		const moov = (dataStart: number) => box('moov',
			box('mvhd', zeros(12), u32(options.sampleRate), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
			box('trak',
				box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, zeros(8)),
				box('mdia',
					box('mdhd', zeros(12), u32(options.sampleRate), u32(0), [0x55, 0xc4, 0, 0]),
					box('hdlr', zeros(8), ascii('soun'), zeros(13)),
					box('minf', box('stbl', box('stsd', u32(0), u32(1), sampleEntry), ...options.stbl(dataStart))),
				),
			),
		);
		const ftyp = box('ftyp', ascii('qt  '), u32(0), ascii('qt  '));
		const dataStart = ftyp.length + moov(0).length + 8;

		using input = new Input({
			source: new BufferSource(new Uint8Array([...ftyp, ...moov(dataStart), ...box('mdat', ...options.frames)])),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const packets: number[][] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push([packet.timestamp, packet.duration, packet.byteLength, packet.data[4]!]);
		}
		return {
			codec: await track.getCodec(),
			sampleRate: await track.getSampleRate(),
			numberOfChannels: await track.getNumberOfChannels(),
			packets,
		};
	};

	// As FFmpeg writes it: one sample per frame (MPEG-1, 48 kHz, 192 kbit/s, 576 bytes)
	const frames48 = Array.from({ length: 2 }, (_, i) => [0xff, 0xfd, 0xa4, 0x00, i, ...zeros(571)]);
	expect(await read({
		sampleRate: 48000,
		frames: frames48,
		version: 0,
		sampleEntryExtra: [],
		stbl: dataStart => [
			box('stts', u32(0), u32(1), u32(2), u32(1152)),
			box('stsc', u32(0), u32(1), u32(1), u32(2), u32(1)),
			box('stsz', u32(0), u32(576), u32(2)),
			box('stco', u32(0), u32(1), u32(dataStart)),
		],
	})).toEqual({
		codec: 'mp3',
		sampleRate: 48000,
		numberOfChannels: 2,
		packets: [[0, 0.024, 576, 0], [0.024, 0.024, 576, 1]],
	});

	// In a sample table that counts decoded samples, with two frames per packet (MPEG-2, 24 kHz, 64 kbit/s, 384
	// bytes). Layer II frames hold 1152 samples at this rate too.
	const frames24 = Array.from({ length: 4 }, (_, i) => [0xff, 0xf5, 0x84, 0x00, i, ...zeros(379)]);
	expect((await read({
		sampleRate: 24000,
		frames: frames24,
		version: 1,
		sampleEntryExtra: [...u32(2304), ...u32(384), ...u32(768), ...u32(2)], // 2 frames per packet
		stbl: dataStart => [
			box('stts', u32(0), u32(1), u32(4608), u32(1)),
			box('stsc', u32(0), u32(1), u32(1), u32(4608), u32(1)),
			box('stsz', u32(0), u32(1), u32(4608)),
			box('stco', u32(0), u32(1), u32(dataStart)),
		],
	})).packets).toEqual(frames24.map((_, i) => [i * 1152 / 24000, 1152 / 24000, 384, i]));
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

test('Packet durations of a long-held frame with fragments that start a GOP', async () => {
	// Variable frame rate with x264's b-pyramid: decode timestamps trail the presentation ones by two frames, so the
	// decode duration covering the held frame's presentation gap is in the next fragment
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const moov = box('moov',
		box('mvhd', zeros(12), u32(30), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(30), u32(0), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(1), box('avc1', zeros(24), [0, 64, 0, 64], zeros(50))),
					box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
				)),
			),
		),
		box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
	);

	// One tick per frame. GOP 1 presents ticks 2 to 6 and holds 6 until 16, GOP 2 starts at 17; [duration, offset]
	const fragments = [
		{ decodeTimestamp: 0, samples: [[1, 2], [1, 5], [1, 2], [1, 0], [1, 1], [1, 11]] }, // I P B b b P
		{ decodeTimestamp: 6, samples: [[10, 11], [1, 2]] },
	].flatMap(({ decodeTimestamp, samples }, i) => {
		const traf = (dataOffset: number) => box('traf',
			box('tfhd', u32(0x020000), u32(1)),
			box('tfdt', u32(0), u32(decodeTimestamp)),
			box('trun', u32(0xf01), u32(samples.length), u32(dataOffset), ...samples.map(([duration, offset], j) =>
				[...u32(duration!), ...u32(1), ...u32(j === 0 ? 0 : 0x10000), ...u32(offset!)],
			)),
		);
		const moofSize = box('moof', box('mfhd', u32(0), u32(i + 1)), traf(0)).length;
		return [
			...box('moof', box('mfhd', u32(0), u32(i + 1)), traf(moofSize + 8)),
			...box('mdat', zeros(samples.length)),
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
		packets.push([Math.round(packet.timestamp * 30), Math.round(packet.duration * 30)]);
	}
	packets.sort((a, b) => a[0]! - b[0]!);

	// Every frame lasts until the next presented one
	expect(packets).toEqual([[2, 1], [3, 1], [4, 1], [5, 1], [6, 10], [16, 1], [17, 1], [18, 1]]);
});

test('Packet durations are the same however many fragments were read before', async () => {
	// Fragments that don't start a GOP, one to three frames each: a frame's successor in presentation order can be
	// decoded in an earlier fragment or a later one
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

	// Decode order I P B B P B B I P B B, presented as I B B P B B P I B B P, with a variable frame rate: frame
	// durations in presentation order 1 2 1 3 1 1 2 1 1 1 1
	const presentationTimestamps = [0, 1, 3, 4, 7, 8, 9, 11, 12, 13, 14];
	const decodeOrder = [0, 3, 1, 2, 6, 4, 5, 7, 10, 8, 9]; // Presented frame index of each decoded frame
	const fragmentSizes = [2, 3, 1, 2, 3];
	// Negative composition offsets instead of a decoding delay
	const decodeTimestamps = presentationTimestamps;
	let decoded = 0;
	const fragments = fragmentSizes.flatMap((size, i) => {
		const samples = decodeOrder.slice(decoded, decoded + size).map((frame, j) => {
			const index = decoded + j;
			const nextDecodeTimestamp = decodeTimestamps[index + 1] ?? decodeTimestamps[index]! + 1;
			return {
				duration: nextDecodeTimestamp - decodeTimestamps[index]!,
				offset: presentationTimestamps[frame]! - decodeTimestamps[index]!,
				isKeyFrame: frame === 0 || frame === 7,
			};
		});
		const startDecodeTimestamp = decodeTimestamps[decoded]!;
		decoded += size;

		const traf = (dataOffset: number) => box('traf',
			box('tfhd', u32(0x020000), u32(1)),
			box('tfdt', u32(0), u32(startDecodeTimestamp)),
			box('trun', [1, 0, 0x0f, 0x01], u32(samples.length), u32(dataOffset), ...samples.map(sample => [
				...u32(sample.duration),
				...u32(1),
				...u32(sample.isKeyFrame ? 0 : 0x10000),
				...u32(sample.offset >>> 0),
			])),
		);
		const moofSize = box('moof', box('mfhd', u32(0), u32(i + 1)), traf(0)).length;
		return [...box('moof', box('mfhd', u32(0), u32(i + 1)), traf(moofSize + 8)), ...box('mdat', zeros(size))];
	});
	const bytes = new Uint8Array([...box('ftyp', ascii('iso6'), u32(0)), ...moov, ...fragments]);

	const expected = presentationTimestamps.map((timestamp, i) => [
		timestamp / 10,
		((presentationTimestamps[i + 1] ?? timestamp + 1) - timestamp) / 10,
	]);
	const withSink = async <T>(use: (sink: EncodedPacketSink) => Promise<T>) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		return await use(new EncodedPacketSink(track));
	};

	// Reading every packet in decode order
	const sequential = await withSink(async (sink) => {
		const packets: number[][] = [];
		for await (const packet of sink.packets()) {
			packets.push([packet.timestamp, packet.duration]);
		}
		return packets.sort((a, b) => a[0]! - b[0]!);
	});
	expect(sequential).toEqual(expected);

	// Each packet on its own, looked up by timestamp with nothing read before: whichever packet the lookup returns,
	// it has the duration it has when reading every packet
	const durations = new Map(expected.map(([timestamp, duration]) => [timestamp!, duration!]));
	for (const [timestamp] of expected) {
		const packet = await withSink(sink => sink.getPacket(timestamp!));
		assert(packet);
		expect(packet.duration).toBe(durations.get(packet.timestamp));
	}
});

test('Packet durations with fragments that overlap in presentation time', async () => {
	// The second fragment restarts at a sync sample presented before the end of the first one (cut or edited
	// content). Nothing reorders across a sync sample, so the fragments don't shorten each other's frames.
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const moov = box('moov',
		box('mvhd', zeros(12), u32(20), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(20), u32(0), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(1), box('avc1', zeros(24), [0, 64, 0, 64], zeros(50))),
					box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
				)),
			),
		),
		box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
	);

	// Frames of 0.1 s: four starting at 0, then three starting at 0.15
	const fragments = [[0, 4], [3, 3]].flatMap(([decodeTimestamp, sampleCount], i) => {
		const traf = (dataOffset: number) => box('traf',
			box('tfhd', u32(0x020000), u32(1)),
			box('tfdt', u32(0), u32(decodeTimestamp!)),
			box('trun', u32(0x701), u32(sampleCount!), u32(dataOffset), ...Array.from(
				{ length: sampleCount! },
				(_, j) => [...u32(2), ...u32(1), ...u32(j === 0 ? 0 : 0x10000)],
			)),
		);
		const moofSize = box('moof', box('mfhd', u32(0), u32(i + 1)), traf(0)).length;
		return [
			...box('moof', box('mfhd', u32(0), u32(i + 1)), traf(moofSize + 8)),
			...box('mdat', zeros(sampleCount!)),
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
	expect(packets).toEqual([[0, 0.1], [0.1, 0.1], [0.2, 0.1], [0.3, 0.1], [0.15, 0.1], [0.25, 0.1], [0.35, 0.1]]);
});

test('A cold packet lookup in a file of many indexed fragments reads a bounded number of them', async () => {
	// One-sample fragments with a key frame every 60 and a tfra entry for each, like FFmpeg writes with
	// -movflags empty_moov+default_base_moof -frag_duration 1. Finding where a sample ends must not walk the file.
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const parts: number[][] = [box('ftyp', ascii('iso5'), u32(0)), box('moov',
		box('mvhd', zeros(12), u32(30), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(30), u32(0), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(1), box('avc1', zeros(24), [0, 64, 0, 64], zeros(50))),
					box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
				)),
			),
		),
		box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
	)];
	const tfraEntries: number[][] = [];
	let pos = parts.reduce((total, part) => total + part.length, 0);
	for (let i = 0; i < 20000; i++) {
		const traf = (dataOffset: number) => box('traf',
			box('tfhd', u32(0x020000), u32(1)),
			box('tfdt', u32(0), u32(i)),
			box('trun', u32(0x701), u32(1), u32(dataOffset), u32(1), u32(1), u32(i % 60 === 0 ? 0 : 0x10000)),
		);
		const moofSize = box('moof', box('mfhd', u32(0), u32(i + 1)), traf(0)).length;
		tfraEntries.push([...u32(0), ...u32(i), ...u32(0), ...u32(pos), ...u32(1), ...u32(1), ...u32(1)]);
		parts.push(box('moof', box('mfhd', u32(0), u32(i + 1)), traf(moofSize + 8)), box('mdat', [0]));
		pos += moofSize + 9;
	}
	// Version 1 (64-bit time and offset), 32-bit traf/trun/sample numbers
	const tfra = box('tfra', [1, 0, 0, 0], u32(1), u32(0x3f), u32(tfraEntries.length), tfraEntries.flat());
	parts.push(box('mfra', tfra, box('mfro', u32(0), u32(8 + tfra.length + 16))));
	const file = new Uint8Array(parts.flat());

	for (const timestamp of [10.5, 650.5]) {
		let reads = 0;
		using input = new Input({
			source: new CustomSource({
				getSize: () => file.length,
				read: (start, end) => {
					reads++;
					return file.slice(start, end);
				},
			}),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const packet = await new EncodedPacketSink(track).getPacket(timestamp);
		expect(packet?.timestamp).toBeCloseTo(Math.floor(timestamp * 30) / 30, 6);
		// At most back to the previous key frame and some way forward, never from the start of the file
		expect(reads).toBeLessThan(500);
	}
});

test('Packet durations of frames presented at the same time, fragmented or not', async () => {
	// From the L17 fuzz sweep: AVC with B-frames where two pairs of frames share a presentation timestamp. Like the
	// non-fragmented reading, the frame decoded first of a pair lasts 0, also when the pair spans fragments.
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];

	// In decode order, at a timescale of 57600; only the first frame is a sync sample
	const presentationTimestamps = [2892, 2950, 2957, 2950, 2956, 3017, 3015, 2957];
	const durations = [1, 1, 1, 1, 1, 57, 1, 1];
	const decodeTimestamps = durations.map((_, i) => 2800 + durations.slice(0, i).reduce((a, b) => a + b, 0));
	const offsets = presentationTimestamps.map((timestamp, i) => timestamp - decodeTimestamps[i]!);

	const trak = (stbl: number[][]) => box('trak',
		box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
		box('mdia',
			box('mdhd', zeros(12), u32(57600), u32(0), [0x55, 0xc4, 0, 0]),
			box('hdlr', zeros(8), ascii('vide'), zeros(13)),
			box('minf', box('stbl', box('stsd', u32(0), u32(1), box('avc1', zeros(24), [0, 64, 0, 64], zeros(50))),
				...stbl)),
		),
	);
	const mvhd = box('mvhd', zeros(12), u32(1000), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28));
	const ftyp = box('ftyp', ascii('iso5'), u32(0));

	const nonFragmented = () => {
		const moov = (chunkOffset: number) => box('moov', mvhd, trak([
			box('stts', u32(0), u32(3), u32(5), u32(1), u32(1), u32(57), u32(2), u32(1)),
			box('ctts', u32(0), u32(8), ...offsets.map(offset => [...u32(1), ...u32(offset)])),
			box('stss', u32(0), u32(1), u32(1)),
			box('stsc', u32(0), u32(1), u32(1), u32(8), u32(1)),
			box('stsz', u32(0), u32(1), u32(8)),
			box('stco', u32(0), u32(1), u32(chunkOffset)),
		]));
		const dataStart = ftyp.length + moov(0).length + 8;
		return new Uint8Array([...ftyp, ...moov(dataStart), ...box('mdat', zeros(8))]);
	};

	const fragmented = (fragmentSizes: number[]) => {
		const moov = box('moov', mvhd, trak([
			box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
		]), box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))));

		let start = 0;
		const fragments = fragmentSizes.flatMap((size, i) => {
			const indices = Array.from({ length: size }, (_, j) => start + j);
			const traf = (dataOffset: number) => box('traf',
				box('tfhd', u32(0x020000), u32(1)),
				box('tfdt', u32(0), u32(decodeTimestamps[indices[0]!]!)),
				box('trun', u32(0xf01), u32(size), u32(dataOffset), ...indices.map(index => [
					...u32(durations[index]!), ...u32(1), ...u32(index === 0 ? 0 : 0x10000), ...u32(offsets[index]!),
				])),
			);
			start += size;
			const moofSize = box('moof', box('mfhd', u32(0), u32(i + 1)), traf(0)).length;
			return [...box('moof', box('mfhd', u32(0), u32(i + 1)), traf(moofSize + 8)), ...box('mdat', zeros(size))];
		});
		return new Uint8Array([...ftyp, ...moov, ...fragments]);
	};

	const readDurations = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const result: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			result.push(Math.round(packet.duration * 57600));
		}
		return result;
	};

	// Each frame lasts until the next one in presentation order, ties ordered by decoding
	const expected = [58, 0, 0, 6, 1, 57, 2, 58];
	expect(await readDurations(nonFragmented())).toEqual(expected);
	expect(await readDurations(fragmented([8]))).toEqual(expected);
	expect(await readDurations(fragmented([3, 3, 2]))).toEqual(expected); // Both pairs span fragments
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

test('Video samples that the track fragment\'s sdtp box marks as dependent are delta frames', async () => {
	// Four video samples in one fragment whose sample flags leave sample_depends_on unknown (0) and mark them all as
	// sync samples. Like Chromium, the traf's sdtp box then tells: the first doesn't depend on others, the rest do.
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];

	const read = async (options: { handler: string; sampleFlags: number; sdtp: number[] | null }) => {
		const avc1 = box('avc1', zeros(6), [0, 1], zeros(16), [0, 64, 0, 64], zeros(50),
			box('avcC', [1, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x00]));
		const ipcm = box('ipcm', zeros(6), [0, 1], zeros(8), [0, 1, 0, 16], zeros(4), u32(48000 * 0x10000),
			box('pcmC', zeros(4), [1, 16]));
		const sampleEntry = options.handler === 'vide' ? avc1 : ipcm;
		const moov = box('moov',
			box('mvhd', zeros(12), u32(1000), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
			box('trak',
				box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, zeros(8)),
				box('mdia',
					box('mdhd', zeros(12), u32(1000), u32(0), [0x55, 0xc4, 0, 0]),
					box('hdlr', zeros(8), ascii(options.handler), zeros(13)),
					box('minf', box('stbl',
						box('stsd', zeros(4), u32(1), sampleEntry),
						box('stts', zeros(8)),
						box('stsc', zeros(8)),
						box('stsz', zeros(12)),
						box('stco', zeros(8)),
					)),
				),
			),
			box('mvex', box('trex', zeros(4), u32(1), u32(1), u32(40), u32(10), u32(options.sampleFlags))),
		);
		const moof = (dataOffset: number) => box('moof', box('mfhd', zeros(4), u32(1)), box('traf',
			box('tfhd', [0, 2, 0, 0], u32(1)), // Default base is moof
			box('tfdt', zeros(8)),
			box('trun', [0, 0, 0, 1], u32(4), u32(dataOffset)), // The trex box's defaults
			...(options.sdtp ? [box('sdtp', zeros(4), options.sdtp)] : []),
		));
		const ftyp = box('ftyp', ascii('iso6'), u32(0), ascii('iso6'));
		const file = [...ftyp, ...moov, ...moof(moof(0).length + 8), ...box('mdat', zeros(40))];

		using input = new Input({ source: new BufferSource(new Uint8Array(file)), formats: ALL_FORMATS });
		const track = (await input.getTracks())[0];
		assert(track);
		const types: string[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			types.push(packet.type);
		}
		return types;
	};

	const sdtp = [0x20, 0x10, 0x10, 0x10]; // sample_depends_on 2 (no), then 1 (yes)
	expect(await read({ handler: 'vide', sampleFlags: 0, sdtp: null })).toEqual(['key', 'key', 'key', 'key']);
	expect(await read({ handler: 'vide', sampleFlags: 0, sdtp })).toEqual(['key', 'delta', 'delta', 'delta']);
	// Sample flags that tell the dependency (2: none) win over the sdtp box
	expect(await read({ handler: 'vide', sampleFlags: 0x02000000, sdtp })).toEqual(['key', 'key', 'key', 'key']);
	// Audio samples may depend on others and still be random access points
	expect(await read({ handler: 'soun', sampleFlags: 0, sdtp })).toEqual(['key', 'key', 'key', 'key']);
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
	// ES_Descriptor > DecoderConfigDescriptor (AAC) > AudioSpecificConfig, SLConfig
	const esds = (audioSpecificConfig: number[]) => box(
		'esds',
		zeros(4),
		[3, 23 + audioSpecificConfig.length, 0, 1, 0],
		[4, 15 + audioSpecificConfig.length, 0x40, 0x15, ...zeros(11)],
		[5, audioSpecificConfig.length, ...audioSpecificConfig],
		[6, 1, 2],
	);
	const smpb = ' 00000000 00000840 00000338 0000000000015888 00000000 00000000 00000000 00000000';
	const itunes = box('udta', box('meta', zeros(4), box('hdlr', zeros(8), ascii('mdir'), zeros(13)), box('ilst',
		box('----', box('mean', zeros(4), ascii('com.apple.iTunes')), box('name', zeros(4), ascii('iTunSMPB')),
			box('data', u32(1), u32(0), ascii(smpb))),
	)));

	type Layout = 'lc' | 'explicit-sbr-core-timescale' | 'implicit-sbr-output-rate' | 'lc-22050-timescale-44100';
	const build = (edts: number[], layout: Layout = 'lc') => {
		// HE-AAC: the media timescale may follow the core coder at half the output rate (Nero, afconvert) or the output
		// rate (FFmpeg). With implicit SBR signaling, the AudioSpecificConfig only describes the core coder, and the
		// sample entry gives the output rate.
		const timescale = layout === 'explicit-sbr-core-timescale' ? 22050 : 44100;
		const sampleEntryRate = layout === 'explicit-sbr-core-timescale' || layout === 'lc-22050-timescale-44100'
			? 22050
			: 44100;
		const audioSpecificConfig = {
			'lc': [0x12, 0x10], // AAC-LC, 44100 Hz, stereo
			'explicit-sbr-core-timescale': [0x2b, 0x92, 0x08, 0x00], // SBR, 22050 Hz core, 44100 Hz output, stereo
			'implicit-sbr-output-rate': [0x13, 0x90], // AAC-LC, 22050 Hz, stereo
			'lc-22050-timescale-44100': [0x13, 0x90],
		}[layout];
		const moov = (chunkOffset: number) => box('moov',
			box('mvhd', zeros(12), u32(44100), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
			box('trak',
				box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, zeros(8)),
				edts,
				box('mdia',
					box('mdhd', zeros(12), u32(timescale), u32(4096), [0x55, 0xc4, 0, 0]),
					box('hdlr', zeros(8), ascii('soun'), zeros(13)),
					box('minf', box('stbl',
						box('stsd', u32(0), u32(1), box('mp4a', zeros(6), [0, 1], zeros(8), [0, 2, 0, 16], zeros(4),
							u32(sampleEntryRate * 0x10000), esds(audioSpecificConfig))),
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
	// iTunSMPB counts output samples
	expect(await firstTimestamp(build([], 'explicit-sbr-core-timescale'))).toBeCloseTo(-2112 / 44100, 12);
	expect(await firstTimestamp(build([], 'implicit-sbr-output-rate'))).toBeCloseTo(-2112 / 44100, 12);
	// Plain AAC-LC at 22050 Hz, which only its sample entry tells apart from implicit SBR
	expect(await firstTimestamp(build([], 'lc-22050-timescale-44100'))).toBeCloseTo(-2112 / 22050, 12);

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

test('16-bit samples in a QuickTime raw sample entry', async () => {
	// QuickTime defines 'raw ' as 8-bit offset binary, but FFmpeg reads an entry that says 16 bits per sample as
	// signed big-endian 16-bit PCM
	const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];

	const read = async (sampleSize: number) => {
		const raw = box('raw ', zeros(6), u16(1), zeros(8), u16(2), u16(sampleSize), zeros(4), u32(48000 * 0x10000));
		const ftyp = box('ftyp', ascii('qt  '), u32(0), ascii('qt  '));
		const moov = box('moov',
			box('mvhd', zeros(12), u32(48000), u32(480), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
			box('trak',
				box('tkhd', u32(3), zeros(8), u32(1), zeros(4), u32(480), zeros(16), matrix, zeros(8)),
				box('mdia',
					box('mdhd', zeros(12), u32(48000), u32(480), [0x55, 0xc4, 0, 0]),
					box('hdlr', zeros(8), ascii('soun'), zeros(13)),
					box('minf', box('stbl',
						box('stsd', zeros(4), u32(1), raw),
						box('stts', zeros(4), u32(1), u32(480), u32(1)),
						box('stsc', zeros(4), u32(1), u32(1), u32(480), u32(1)),
						box('stsz', zeros(4), u32(1), u32(480)),
						box('stco', zeros(4), u32(1), u32(ftyp.length + 8)),
					)),
				),
			),
		);
		const mdat = box('mdat', zeros(480 * 2 * sampleSize / 8)); // 480 stereo frames

		using input = new Input({
			source: new BufferSource(new Uint8Array([...ftyp, ...mdat, ...moov])),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const packet = await new EncodedPacketSink(track).getFirstPacket();
		return [await track.getCodec(), packet?.byteLength, packet?.duration];
	};

	expect(await read(8)).toEqual(['pcm-u8', 960, 0.01]);
	expect(await read(16)).toEqual(['pcm-s16be', 1920, 0.01]);
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

	const read = async (entries: number[][], trexIndex: number, tfhdIndex: number | null, freeBoxCount = 0) => {
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
				...Array.from({ length: freeBoxCount }, () => box('free')).flat(),
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
	// tfhd wins over a valid trex index, however many boxes come before the first moof box
	expect(await read([aac, mp3], 1, 2, 8)).toBe('mp3');
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

test('CENC sample group descriptions of every version, and their default entries', async () => {
	// ISO/IEC 14496-12 8.9.3: sgpd has a default entry length since version 1 and a default entry (for samples that
	// no sbgp maps) since version 2. Each case encrypts the two samples with the key and IV size their groups select,
	// and gives the IVs through senc or through saiz + saio.
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
	const plaintexts = [Array.from({ length: 40 }, (_, i) => i), Array.from({ length: 24 }, (_, i) => 100 + i)];

	// One entry selecting the second key, with 8-byte IVs unless told otherwise (tenc has 8-byte IVs and the first key)
	type SgpdOptions = { defaultLength?: number; defaultIndex?: number; ivSize?: number };
	const sgpd = (version: number, options: SgpdOptions = {}) => {
		const entry = [0, 0, 1, options.ivSize ?? 8, ...keyIds[1]!];
		const defaultLength = options.defaultLength ?? entry.length;
		return box('sgpd', [version, 0, 0, 0], ascii('seig'),
			version >= 1 ? u32(defaultLength) : [],
			version >= 2 ? u32(options.defaultIndex ?? 0) : [],
			u32(1),
			version >= 1 && defaultLength === 0 ? u32(entry.length) : [],
			entry,
		);
	};
	const sbgp = (runs: [count: number, index: number][]) => box('sbgp', zeros(4), ascii('seig'), u32(runs.length),
		...runs.map(([count, index]) => [...u32(count), ...u32(index)]));

	type Case = {
		trackGroups?: number[][];
		trafGroups: number[][];
		// The key (index) and IV size each sample's groups select
		expected: [key: number, ivSize: number][];
		auxInfo?: boolean;
	};

	const decrypt = async ({ trackGroups = [], trafGroups, expected, auxInfo = false }: Case) => {
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
						...trackGroups,
					)),
				),
			),
			box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
		);

		const ivs = expected.map(([, ivSize], i) => zeros(ivSize).fill(i + 1));
		const ciphertexts = plaintexts.map((data, i) => {
			const counter = Buffer.alloc(16);
			counter.set(ivs[i]!);
			return [...createCipheriv('aes-128-ctr', keys[expected[i]![0]]!, counter).update(Buffer.from(data))];
		});
		// With saiz + saio, the IVs come first in the mdat
		const auxData = auxInfo ? ivs.flat() : [];
		const traf = (mdatStart: number) => box('traf',
			box('tfhd', u32(0x020000), u32(1)),
			box('tfdt', u32(0), u32(0)),
			box('trun', u32(0x301), u32(2), u32(mdatStart + auxData.length),
				...ciphertexts.map(x => [...u32(1), ...u32(x.length)])),
			...(auxInfo
				? [
						box('saiz', zeros(4), [0], u32(2), ivs.map(x => x.length)),
						box('saio', zeros(4), u32(1), u32(mdatStart)),
					]
				: [box('senc', u32(0), u32(2), ...ivs)]),
			...trafGroups,
		);
		const moofSize = box('moof', box('mfhd', u32(0), u32(1)), traf(0)).length;

		using input = new Input({
			source: new BufferSource(new Uint8Array([
				...box('ftyp', ascii('iso6'), u32(0)),
				...moov,
				...box('moof', box('mfhd', u32(0), u32(1)), traf(moofSize + 8)),
				...box('mdat', auxData, ...ciphertexts),
			])),
			formats: ALL_FORMATS,
			formatOptions: {
				isobmff: {
					resolveKeyId: ({ keyId }) => keys[keyId === Buffer.from(keyIds[1]!).toString('hex') ? 1 : 0]!,
				},
			},
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const packets: number[][] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push([...packet.data]);
		}
		return packets;
	};

	const cases: Case[] = [
		// Fragment-local descriptions of each version, both samples mapped to their entry
		{ trafGroups: [sbgp([[2, 0x10001]]), sgpd(0)], expected: [[1, 8], [1, 8]] },
		{ trafGroups: [sbgp([[2, 0x10001]]), sgpd(1)], expected: [[1, 8], [1, 8]] },
		{ trafGroups: [sbgp([[2, 0x10001]]), sgpd(1, { defaultLength: 0 })], expected: [[1, 8], [1, 8]] },
		{ trafGroups: [sbgp([[2, 0x10001]]), sgpd(2)], expected: [[1, 8], [1, 8]] },
		// Version 2 default entries: for samples without a mapping, but not for samples mapped to no group (index 0)
		{ trafGroups: [sgpd(2, { defaultIndex: 1 })], expected: [[1, 8], [1, 8]] },
		{ trafGroups: [sbgp([[1, 0]]), sgpd(2, { defaultIndex: 1 })], expected: [[0, 8], [1, 8]] },
		// Track-level descriptions: through a track-level index, or through the default entry
		{ trackGroups: [sgpd(1)], trafGroups: [sbgp([[1, 1]])], expected: [[1, 8], [0, 8]] },
		{ trackGroups: [sgpd(2, { defaultIndex: 1 })], trafGroups: [], expected: [[1, 8], [1, 8]] },
		// The group's IV size, in senc and in the auxiliary information
		{ trafGroups: [sbgp([[1, 0], [1, 0x10001]]), sgpd(1, { ivSize: 16 })], expected: [[0, 8], [1, 16]] },
		{
			trafGroups: [sbgp([[1, 0], [1, 0x10001]]), sgpd(1, { ivSize: 16 })],
			expected: [[0, 8], [1, 16]],
			auxInfo: true,
		},
		{ trafGroups: [sbgp([[2, 0x10001]]), sgpd(2)], expected: [[1, 8], [1, 8]], auxInfo: true },
	];
	for (const testCase of cases) {
		expect(await decrypt(testCase)).toEqual(plaintexts);
	}
});

test('Key rotation and clear samples through CENC sample groups in a non-fragmented file', async () => {
	// The sample table's sbgp maps the second sample to a 'seig' entry with another key, and the third to one that
	// marks it as unprotected (with no IV in the auxiliary information)
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const keys = new Map([['a1'.repeat(16), Buffer.alloc(16, 0x11)], ['b2'.repeat(16), Buffer.alloc(16, 0x22)]]);
	const keyIds = [...keys.keys()];
	const plaintexts = [0, 1, 2].map(sample => Array.from({ length: 20 }, (_, i) => 10 * sample + i));
	const ivs = [zeros(8).fill(1), zeros(8).fill(2)];
	const samples = [
		...[0, 1].map(sample => [...createCipheriv('aes-128-ctr', keys.get(keyIds[sample]!)!,
			Buffer.from([...ivs[sample]!, ...zeros(8)])).update(Buffer.from(plaintexts[sample]!))]),
		plaintexts[2]!,
	];

	const encv = box('encv', zeros(24), [0, 64, 0, 64], zeros(50), box('sinf', box('frma', ascii('avc1')),
		box('schm', zeros(4), ascii('cenc'), u32(0x10000)),
		box('schi', box('tenc', zeros(4), [0, 0, 1, 8], [...Buffer.from(keyIds[0]!, 'hex')]))));
	const seigEntry = (isProtected: number, ivSize: number, keyId: string) => [
		0, 0, isProtected, ivSize, ...Buffer.from(keyId, 'hex'),
	];
	const moov = (mdatStart: number) => box('moov',
		box('mvhd', zeros(12), u32(10), u32(3), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(4), u32(3), zeros(16), matrix, u32(64 << 16), u32(64 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(10), u32(3), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', zeros(4), u32(1), encv),
					box('stts', zeros(4), u32(1), u32(3), u32(1)),
					box('stsc', zeros(4), u32(1), u32(1), u32(3), u32(1)),
					box('stsz', zeros(4), u32(20), u32(3)),
					box('stco', zeros(4), u32(1), u32(mdatStart + 8 + 16)),
					box('sbgp', zeros(4), ascii('seig'), u32(3), u32(1), u32(0), u32(1), u32(1), u32(1), u32(2)),
					box('sgpd', u32(1 << 24), ascii('seig'), u32(20), u32(2), seigEntry(1, 8, keyIds[1]!),
						seigEntry(0, 0, '00'.repeat(16))),
					box('saiz', zeros(4), [0], u32(3), [8, 8, 0]),
					box('saio', zeros(4), u32(1), u32(mdatStart + 8)),
				)),
			),
		),
	);
	const ftyp = box('ftyp', ascii('isom'), u32(0));
	const mdatStart = ftyp.length + moov(0).length;
	const file = new Uint8Array([...ftyp, ...moov(mdatStart), ...box('mdat', ...ivs, ...samples)]);

	const requestedKeyIds: string[] = [];
	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
		formatOptions: { isobmff: { resolveKeyId: ({ keyId }) => {
			requestedKeyIds.push(keyId);
			return keys.get(keyId)!;
		} } },
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const packets: number[][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([...packet.data]);
	}
	expect(packets).toEqual(plaintexts);
	expect(requestedKeyIds).toEqual(keyIds);
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
	const writeMovWithTitle = async (title: string) => {
		const output = new Output({ format: new MovOutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp8');
		output.addVideoTrack(source);
		output.setMetadataTags({ title });
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 0.1), {
			decoderConfig: { codec: 'vp8', codedWidth: 16, codedHeight: 16 },
		});
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		const titlePos = bytes.findIndex((_, i) => bytes[i] === 0xa9 && bytes[i + 1] === 0x6e && bytes[i + 2] === 0x61
			&& bytes[i + 3] === 0x6d); // ©nam, followed by the text's u16 length and u16 language code
		expect(titlePos).toBeGreaterThan(0);
		return { bytes, titlePos };
	};
	const readTitle = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		return (await input.getMetadataTags()).title;
	};

	// Rewrite the title in place with language code 0 (English): Mac Roman text plus a NUL takes the same 14 bytes as
	// the UTF-8 text
	const audi = await writeMovWithTitle('Az új Audi A4');
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	audi.bytes.set([0, 14, 0, 0, ...ascii('Az '), 0x9c, ...ascii('j Audi A4'), 0], audi.titlePos + 4);
	expect(await readTitle(audi.bytes)).toBe('Az új Audi A4');

	// Text that is valid UTF-8 stays UTF-8 under a Mac language code, even when it contains U+FFFD
	for (const title of ['Café é', 'Café \ufffd']) {
		const { bytes, titlePos } = await writeMovWithTitle(title);
		bytes.set([0, 0], titlePos + 6); // Language code 0
		expect(await readTitle(bytes)).toBe(title);
	}
});

test('Encryption info in the senc box of a non-fragmented file', async () => {
	// FFmpeg writes a senc box into the sample table of non-fragmented CENC files, plus saiz and saio boxes pointing
	// into it. Older versions got the saio offset wrong (FFmpeg's FATE sample mov/mov-3elist-encrypted.mov), and the
	// senc box alone is valid too.
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

	// Two samples with 4 clear bytes each, the rest encrypted with AES-CTR
	const ivs = [[1, 2, 3, 4, 5, 6, 7, 8], [8, 7, 6, 5, 4, 3, 2, 1]];
	const plaintexts = [Array.from({ length: 40 }, (_, i) => i), Array.from({ length: 24 }, (_, i) => 100 + i)];
	const ciphertexts = plaintexts.map((data, i) => {
		const counter = Buffer.alloc(16);
		counter.set(ivs[i]!);
		return [...data.slice(0, 4), ...createCipheriv('aes-128-ctr', key, counter).update(Buffer.from(data.slice(4)))];
	});

	const build = (auxInfo: 'none' | 'wrong-saio') => {
		const tenc = box('tenc', zeros(4), [0, 0, 1, 8], keyId);
		const encv = box('encv', zeros(24), [0, 64, 0, 64], zeros(50), box('sinf', box('frma', ascii('avc1')),
			box('schm', zeros(4), ascii('cenc'), u32(0x10000)), box('schi', tenc)));
		const senc = box('senc', u32(2), u32(2), ...plaintexts.map((data, i) => {
			return [...ivs[i]!, ...u16(1), ...u16(4), ...u32(data.length - 4)];
		}));
		const moov = (chunkOffset: number, sencPos: number) => box('moov',
			box('mvhd', zeros(12), u32(10), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
			box('trak',
				box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
				box('mdia',
					box('mdhd', zeros(12), u32(10), u32(2), [0x55, 0xc4, 0, 0]),
					box('hdlr', zeros(8), ascii('vide'), zeros(13)),
					box('minf', box('stbl',
						box('stsd', u32(0), u32(1), encv),
						box('stts', u32(0), u32(1), u32(2), u32(1)),
						box('stsc', u32(0), u32(1), u32(1), u32(2), u32(1)),
						box('stsz', u32(0), u32(0), u32(2), ...ciphertexts.map(x => u32(x.length))),
						box('stco', u32(0), u32(1), u32(chunkOffset)),
						senc,
						// Pointing at the start of the senc box rather than at its first entry
						...(auxInfo === 'wrong-saio'
							? [box('saio', u32(0), u32(1), u32(sencPos)), box('saiz', u32(0), [16], u32(2))]
							: []),
					)),
				),
			),
		);

		const ftyp = box('ftyp', ascii('isom'), u32(0), ascii('isom'));
		const draft = new Uint8Array([...ftyp, ...moov(0, 0)]);
		const sencPos = draft.findIndex((_, i) => String.fromCharCode(...draft.subarray(i, i + 4)) === 'senc') - 4;

		return new Uint8Array([
			...ftyp,
			...moov(draft.length + 8, sencPos),
			...box('mdat', ...ciphertexts),
		]);
	};

	const decrypt = async (bytes: Uint8Array) => {
		using input = new Input({
			source: new BufferSource(bytes),
			formats: ALL_FORMATS,
			formatOptions: { isobmff: { resolveKeyId: () => key } },
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const packets: number[][] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push([...packet.data]);
		}
		return packets;
	};

	expect(await decrypt(build('wrong-saio'))).toEqual(plaintexts);
	expect(await decrypt(build('none'))).toEqual(plaintexts);
});

test('Two colr boxes in a sample entry', async () => {
	// Like Firefox's dom/media/test/two-colr.mp4: two adjacent colr boxes, where the first one matches the bitstream
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source);
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 0.1), {
		decoderConfig: {
			codec: 'vp09.00.10.08',
			codedWidth: 16,
			codedHeight: 16,
			colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
		},
	});
	await output.finalize();

	// Turn the btrt box that follows the colr box into a second colr box (same 20-byte size) claiming BT.2020
	const bytes = new Uint8Array(output.target.buffer!);
	const btrtPos = bytes.findIndex((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === 'btrt') - 4;
	expect(String.fromCharCode(...bytes.subarray(btrtPos - 15, btrtPos - 11))).toBe('colr');
	bytes.set([0, 0, 0, 20, ...[...'colrnclx'].map(char => char.charCodeAt(0)), 0, 9, 0, 14, 0, 9, 0, 0], btrtPos);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = (await input.getVideoTracks())[0]!;
	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt709',
		transfer: 'bt709',
		matrix: 'bt709',
		fullRange: false,
	});
});

test('AAC whose esds box has no AudioSpecificConfig', async () => {
	// Like samples.ffmpeg.org archive/all/mov+mpeg4+aac++trutter1_problem.mp4: the DecoderConfigDescriptor carries no
	// DecoderSpecificInfo. FFmpeg decodes it as AAC-LC with the sample entry's sample rate and channel count.
	const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];

	// The descriptors of that file: ES_Descriptor > DecoderConfigDescriptor (AAC, no DecoderSpecificInfo), SLConfig
	const esds = box('esds', zeros(4), [0x03, 0x16, 0, 0, 0], [
		0x04, 0x0d, 0x40, 0x15, 0x03, 0xd0, 0x90, 0x00, 0x00, 0xfa, 0x00, 0x00, 0x00, 0x00, 0x00,
	], [0x06, 0x01, 0x02]);
	const mp4a = box('mp4a', zeros(6), u16(1), zeros(8), u16(2), u16(16), zeros(4), u32(48000 * 0x10000), esds);
	const moov = (chunkOffset: number) => box('moov',
		box('mvhd', zeros(12), u32(1000), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, zeros(8)),
			box('mdia',
				box('mdhd', zeros(12), u32(48000), u32(1024), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('soun'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(1), mp4a),
					box('stts', u32(0), u32(1), u32(1), u32(1024)),
					box('stsc', u32(0), u32(1), u32(1), u32(1), u32(1)),
					box('stsz', u32(0), u32(4), u32(1)),
					box('stco', u32(0), u32(1), u32(chunkOffset)),
				)),
			),
		),
	);
	const ftyp = box('ftyp', ascii('mp42'), u32(0), ascii('mp42'));
	const moovSize = moov(0).length;

	using input = new Input({
		source: new BufferSource(new Uint8Array([
			...ftyp,
			...moov(ftyp.length + moovSize + 8),
			...box('mdat', zeros(4)),
		])),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getDecoderConfig()).toEqual({
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		description: new Uint8Array([0x11, 0x90]), // AAC-LC, 48 kHz, stereo
	});
	expect(await input.getMimeType()).toBe('audio/mp4; codecs="mp4a.40.2"');
});

test('Video sample entries with zero dimensions', async () => {
	// Some writers leave the sample entry's width and height at 0 (samples.ffmpeg.org
	// archive/all/mov+h264+aac++mp4box_frag.mp4: 720×288 H.264). Like FFmpeg, take them from the SPS instead.
	const readDimensions = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = (await input.getVideoTracks())[0]!;
		const decoderConfig = await track.getDecoderConfig();
		return [
			await track.getCodedWidth(),
			await track.getCodedHeight(),
			await track.getDisplayWidth(),
			await track.getDisplayHeight(),
			decoderConfig!.codedWidth,
			decoderConfig!.codedHeight,
		];
	};

	for (const name of ['sps-only-sar-h264.mp4', 'sps-only-sar-hevc.mp4']) {
		const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, '../public', name)));
		const stsdPos = bytes.findIndex((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === 'stsd') - 4;
		const sampleEntryPos = stsdPos + 16;
		new DataView(bytes.buffer).setUint32(sampleEntryPos + 32, 0); // Width and height

		// The SPS says 64×64 with a pixel aspect ratio that gives a display size of 64×114
		expect(await readDimensions(bytes)).toEqual([64, 64, 64, 114, 64, 64]);
	}
});

test('AVC and HEVC tracks whose sample descriptions carry different parameter sets', async () => {
	// FFmpeg starts a new sample description when the parameter sets change mid-stream (FATE's
	// h264/extradata-reload-multi-stsd.mov and its HEVC twin, whose avcC/hvcC records these are). Each key sample gets
	// its own description's parameter sets in band, as Chromium does, so that the decoder switches.
	const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const hex = (text: string) => text.match(/../g)!.map(x => parseInt(x, 16));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const nal = (bytes: number[], lengthSize = 4) => [...(lengthSize === 4 ? u32 : u16)(bytes.length), ...bytes];

	const records = {
		avc: [
			'0164000cffe100196764000cacd941011b011000000300100000030320f142996001000668ebe3cb22c0fdf8f800',
			'0164000bffe100186764000bacd942046c0440000003004000000c83c50a658001000668ebe3cb22c0fdf8f800',
		].map(hex),
		hevc: [
			'0101600000009000000000001ef000fdfdf8f800000f03a00001001840010c01ffff01600000030090000003000003001e9598'
			+ '09a10001002942010101600000030090000003000003001ea0102020596566924caf01010000030001000003001908a2000100'
			+ '074401c172b42240',
			'0101600000009000000000003cf000fdfdf8f800000f03a00001001840010c01ffff01600000030090000003000003003c9598'
			+ '09a10001002842010101600000030090000003000003003ca0102010165959a4932bc04040000003004000000642a200010007'
			+ '4401c172b42240',
		].map(hex),
	};
	// The parameter set NAL units of each record, in order
	const parameterSets = {
		avc: records.avc.map((record) => {
			const spsLength = record[6]! << 8 | record[7]!;
			const pps = record.slice(8 + spsLength + 1);
			return [record.slice(8, 8 + spsLength), pps.slice(2, 2 + (pps[0]! << 8 | pps[1]!))];
		}),
		hevc: records.hevc.map((record) => {
			const units: number[][] = [];
			let pos = 23;
			for (let i = 0; i < record[22]!; i++) {
				const count = record[pos + 1]! << 8 | record[pos + 2]!;
				pos += 3;
				for (let j = 0; j < count; j++) {
					const length = record[pos]! << 8 | record[pos + 1]!;
					units.push(record.slice(pos + 2, pos + 2 + length));
					pos += 2 + length;
				}
			}
			return units;
		}),
	};

	const read = async (codec: 'avc' | 'hevc', secondLengthSize: 2 | 4) => {
		const secondRecord = records[codec][1]!.slice();
		const lengthSizePos = codec === 'avc' ? 4 : 21;
		secondRecord[lengthSizePos] = (secondRecord[lengthSizePos]! & 0xfc) | (secondLengthSize - 1);
		const entry = (record: number[]) => box(codec === 'avc' ? 'avc1' : 'hvc1', zeros(6), u16(1), zeros(16),
			u16(128), u16(128), zeros(50), box(codec === 'avc' ? 'avcC' : 'hvcC', record));

		// Key, delta with the first description, then key, delta with the second
		const slices = [[0x65, 1, 1], [0x41, 2], [0x65, 3, 3], [0x41, 4]].map(x => codec === 'hevc' ? [0x26, ...x] : x);
		const samples = slices.map((slice, i) => nal(slice, i < 2 ? 4 : secondLengthSize));

		const moov = (chunkOffsets: number[]) => box('moov',
			box('mvhd', zeros(12), u32(25), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
			box('trak',
				box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(128 << 16), u32(128 << 16)),
				box('mdia',
					box('mdhd', zeros(12), u32(25), u32(4), [0x55, 0xc4, 0, 0]),
					box('hdlr', zeros(8), ascii('vide'), zeros(13)),
					box('minf', box('stbl',
						box('stsd', u32(0), u32(2), entry(records[codec][0]!), entry(secondRecord)),
						box('stts', u32(0), u32(1), u32(4), u32(1)),
						box('stss', u32(0), u32(2), u32(1), u32(3)),
						box('stsc', u32(0), u32(2), u32(1), u32(2), u32(1), u32(2), u32(2), u32(2)),
						box('stsz', u32(0), u32(0), u32(4), ...samples.map(x => u32(x.length))),
						box('stco', u32(0), u32(2), ...chunkOffsets.map(u32)),
					)),
				),
			),
		);
		const ftyp = box('ftyp', ascii('qt  '), u32(0), ascii('qt  '));
		const dataStart = ftyp.length + moov([0, 0]).length + 8;

		using input = new Input({
			source: new BufferSource(new Uint8Array([
				...ftyp,
				...moov([dataStart, dataStart + samples[0]!.length + samples[1]!.length]),
				...box('mdat', ...samples),
			])),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const description = (await track.getDecoderConfig())!.description as Uint8Array;
		const configLengthSize = (description[codec === 'avc' ? 4 : 21]! & 0b11) + 1;

		const sink = new EncodedPacketSink(track);
		const packets: number[][] = [];
		for await (const packet of sink.packets()) {
			const metadataOnly = await sink.getPacket(packet.timestamp, { metadataOnly: true });
			expect(metadataOnly?.byteLength).toBe(packet.byteLength);
			packets.push([...packet.data]);
		}

		return { packets, slices, configLengthSize };
	};

	for (const codec of ['avc', 'hevc'] as const) {
		for (const secondLengthSize of [4, 2] as const) {
			const { packets, slices, configLengthSize } = await read(codec, secondLengthSize);
			const [first, second] = parameterSets[codec];
			const configNal = (bytes: number[]) => nal(bytes, configLengthSize);

			// All with the length prefix size of the decoder config
			expect(packets).toEqual([
				[...first!.flatMap(configNal), ...configNal(slices[0]!)],
				configNal(slices[1]!),
				[...second!.flatMap(configNal), ...configNal(slices[2]!)],
				configNal(slices[3]!),
			]);
		}
	}
});

test('Fragments whose sample description changes the parameter sets', async () => {
	const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const nal = (bytes: number[]) => [...u32(bytes.length), ...bytes];

	// Two avcC records with made-up parameter sets (an SPS of the right profile, then a PPS)
	const sps = [[0x67, 0x42, 0xc0, 0x0d, 0xd9, 0x01, 0x01, 0x80], [0x67, 0x42, 0xc0, 0x0d, 0xd9, 0x02, 0x02, 0x80]];
	const pps = [[0x68, 0xce, 0x3c, 0x80], [0x68, 0xce, 0x38, 0x80]];
	const avc1 = (i: number) => box('avc1', zeros(6), u16(1), zeros(16), u16(16), u16(16), zeros(50),
		box('avcC', [1, 0x42, 0xc0, 0x0d, 0xff, 0xe1], u16(sps[i]!.length), sps[i]!, [1], u16(pps[i]!.length),
			pps[i]!));
	const moov = box('moov',
		box('mvhd', zeros(12), u32(25), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(16 << 16), u32(16 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(25), u32(0), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(2), avc1(0), avc1(1)),
					box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
				)),
			),
		),
		box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
	);

	const slices = [[0x65, 1], [0x41, 2], [0x65, 3]];
	// The first fragment uses the first sample description, the second one the second
	const fragment = (sequence: number, sampleDescriptionIndex: number, sampleSlices: number[][], start: number) => {
		const traf = (dataOffset: number) => box('traf',
			box('tfhd', u32(0x020002), u32(1), u32(sampleDescriptionIndex)),
			box('tfdt', u32(0), u32(start)),
			box('trun', u32(0x701), u32(sampleSlices.length), u32(dataOffset), ...sampleSlices.map((slice, i) => [
				...u32(1), ...u32(slice.length + 4), ...u32(i === 0 ? 0x02000000 : 0x01010000),
			])),
		);
		const moofSize = box('moof', box('mfhd', u32(0), u32(sequence)), traf(0)).length;
		return [
			...box('moof', box('mfhd', u32(0), u32(sequence)), traf(moofSize + 8)),
			...box('mdat', ...sampleSlices.map(nal)),
		];
	};

	using input = new Input({
		source: new BufferSource(new Uint8Array([
			...box('ftyp', ascii('iso5'), u32(0)),
			...moov,
			...fragment(1, 1, slices.slice(0, 2), 0),
			...fragment(2, 2, slices.slice(2), 2),
		])),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const packets: number[][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([...packet.data]);
	}
	expect(packets).toEqual([
		[...nal(sps[0]!), ...nal(pps[0]!), ...nal(slices[0]!)],
		nal(slices[1]!),
		[...nal(sps[1]!), ...nal(pps[1]!), ...nal(slices[2]!)],
	]);
});

test('Sample descriptions with NAL unit length prefixes of different sizes', async () => {
	// Prefixes are only ever widened, to the largest size among the descriptions, so a 300-byte NAL unit keeps its
	// length even when the decoder config's own description uses 1-byte prefixes
	const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const hex = (text: string) => text.match(/../g)!.map(x => parseInt(x, 16));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const entry = (record: number[]) => box('avc1', zeros(6), u16(1), zeros(16), u16(128), u16(128), zeros(50),
		box('avcC', record));

	for (const smallLengthSize of [1, 2]) {
		// 4-byte prefixes
		const first = hex('0164000cffe100196764000cacd941011b011000000300100000030320f14299600100'
			+ '0668ebe3cb22c0fdf8f800');
		const second = hex('0164000bffe100186764000bacd942046c0440000003004000000c83c50a65800100'
			+ '0668ebe3cb22c0fdf8f800');
		second[4] = 0xfc | (smallLengthSize - 1);

		const largeNalUnit = [0x65, ...new Array<number>(299).fill(0xaa)];
		// The first chunk uses the description with small prefixes, so that one gives the decoder config
		const samples = [[...(smallLengthSize === 1 ? [3] : u16(3)), 0x65, 1, 1], [...u32(300), ...largeNalUnit]];
		const moov = (chunkOffsets: number[]) => box('moov',
			box('mvhd', zeros(12), u32(25), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
			box('trak',
				box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(128 << 16), u32(128 << 16)),
				box('mdia',
					box('mdhd', zeros(12), u32(25), u32(2), [0x55, 0xc4, 0, 0]),
					box('hdlr', zeros(8), ascii('vide'), zeros(13)),
					box('minf', box('stbl',
						box('stsd', u32(0), u32(2), entry(first), entry(second)),
						box('stts', u32(0), u32(1), u32(2), u32(1)),
						box('stsc', u32(0), u32(2), u32(1), u32(1), u32(2), u32(2), u32(1), u32(1)),
						box('stsz', u32(0), u32(0), u32(2), ...samples.map(x => u32(x.length))),
						box('stco', u32(0), u32(2), ...chunkOffsets.map(u32)),
					)),
				),
			),
		);
		const ftyp = box('ftyp', ascii('qt  '), u32(0), ascii('qt  '));
		const dataStart = ftyp.length + moov([0, 0]).length + 8;

		using input = new Input({
			source: new BufferSource(new Uint8Array([
				...ftyp,
				...moov([dataStart, dataStart + samples[0]!.length]),
				...box('mdat', ...samples),
			])),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const description = (await track.getDecoderConfig())!.description as Uint8Array;
		expect(description[4]! & 0b11).toBe(3); // 4-byte prefixes

		const sink = new EncodedPacketSink(track);
		const packet = await sink.getPacket(0.04);
		assert(packet);
		const nalUnits = [...iterateNalUnitsInLengthPrefixed(packet.data, 4)];
		expect(nalUnits.map(x => x.length).at(-1)).toBe(300);
		expect((await sink.getPacket(0.04, { metadataOnly: true }))?.byteLength).toBe(packet.byteLength);
	}
});

test('A metadata atom overrunning its item neither breaks the file nor leaks into the next atoms', async () => {
	const write = async (format: Mp4OutputFormat | MovOutputFormat) => {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp8');
		output.addVideoTrack(source);
		output.setMetadataTags({ title: 'Title', artist: 'Artist', comment: 'Comment' });
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), {
			decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 },
		});
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};
	const find = (bytes: Uint8Array, name: string) => {
		const index = Buffer.from(bytes).indexOf(Buffer.from(name, 'latin1'));
		assert(index !== -1);
		return index;
	};
	const read = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		expect(await input.getPrimaryVideoTrack()).not.toBeNull();
		return input.getMetadataTags();
	};

	// MP4: the ©ART item's data box claims 4096 bytes
	const mp4 = await write(new Mp4OutputFormat());
	new DataView(mp4.buffer).setUint32(find(mp4, '\xa9ART') + 4, 4096); // The size field of the item's data box
	const mp4Tags = await read(mp4);
	expect(mp4Tags.artist).toBe('Artist');
	expect(mp4Tags.title).toBe('Title');

	// MOV: the ©nam string claims to be 65535 bytes long
	const mov = await write(new MovOutputFormat());
	new DataView(mov.buffer).setUint16(find(mov, '\xa9nam') + 4, 0xffff);
	expect((await read(mov)).title).toBe('Title');
});

test('Negative sample deltas stored in stts', async () => {
	// Some writers store negative deltas as unsigned 32-bit values to correct the timestamps (samples.ffmpeg.org
	// mov/mp4-negative-stts-problem.mp4, whose AAC entries these are). Like FFmpeg, such a sample gets a delta of 1 and
	// the following ones are shortened until the timestamps have caught up.
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const esds = box('esds', zeros(4), [3, 25, 0, 1, 0], [4, 17, 0x40, 0x15, ...zeros(11)], [5, 2, 0x12, 0x10],
		[6, 1, 2]);
	const mp4a = box('mp4a', zeros(6), [0, 1], zeros(8), [0, 2, 0, 16], zeros(4), u32(44100 * 0x10000), esds);
	const timing = [[3, 1023], [1, -866], [2, 1023], [1, 2362], [2, 1023]];

	const moov = (chunkOffset: number) => box('moov',
		box('mvhd', zeros(12), u32(44100), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, zeros(8)),
			box('mdia',
				box('mdhd', zeros(12), u32(44100), u32(9 * 1023), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('soun'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(1), mp4a),
					box('stts', u32(0), u32(timing.length), ...timing.map(([count, delta]) => [
						...u32(count!),
						...u32(delta! >>> 0),
					])),
					box('stsc', u32(0), u32(1), u32(1), u32(9), u32(1)),
					box('stsz', u32(0), u32(4), u32(9)),
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
			...box('mdat', zeros(36)),
		])),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packets: number[][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([Math.round(packet.timestamp * 44100), Math.round(packet.duration * 44100)]);
	}
	// The timestamps and durations ffprobe reports for such entries
	expect(packets).toEqual([
		[0, 1023], [1023, 1023], [2046, 1023], [3069, 1], [3070, 590], [3660, 590], [4250, 2361], [6611, 1023],
		[7634, 1023],
	]);
});

test('Missing tfdt and tfra with positive composition offsets', async () => {
	// IPBB fragments with FFmpeg-style composition offsets, so each one is presented one frame past its decode end
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];

	const moof = (dataOffset: number) => box('moof', box('traf',
		box('tfhd', u32(0x020000), u32(1)), // Default base is moof
		box('trun', u32(0x000801), u32(4), u32(dataOffset), u32(1), u32(3), u32(0), u32(0)),
	));
	const fragment = [...moof(moof(0).length + 8), ...box('mdat', zeros(4))];

	const file = new Uint8Array([
		...box('ftyp', ascii('isom'), u32(0), ascii('isom')),
		...box('moov',
			box('mvhd', zeros(12), u32(1), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
			box('trak',
				box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
				box('mdia',
					box('mdhd', zeros(12), u32(1), u32(0), [0x55, 0xc4, 0, 0]),
					box('hdlr', zeros(8), ascii('vide'), zeros(13)),
					box('minf', box('stbl',
						box('stsd', u32(0), u32(1), box('vp08', zeros(24), [0, 64, 0, 64], zeros(50))),
						box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8)),
					)),
				),
			),
			box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(1), u32(0))),
		),
		...fragment,
		...fragment,
		...fragment,
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual([1, 4, 2, 3, 5, 8, 6, 7, 9, 12, 10, 11]);
});

test('Fragments without tfdt continue from the decode end of the fragment right before them', async () => {
	// I0 P2 B1 I3 with one frame of composition delay, one sample per fragment, no tfdt. The third fragment (B1) is
	// presented before the second one (P2), so the position cache, which only takes fragments in presentation
	// order, doesn't hold the second one.
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];

	const frames = [{ pts: 0, key: true }, { pts: 2, key: false }, { pts: 1, key: false }, { pts: 3, key: true }];
	const avc1 = box('avc1', zeros(6), [0, 1], zeros(16), [0, 64, 0, 64], zeros(50),
		box('avcC', [1, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x00]));
	const moov = box('moov',
		box('mvhd', zeros(12), u32(1000), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, zeros(8)),
			box('edts', box('elst', zeros(4), u32(1), u32(160), u32(40), [0, 1, 0, 0])), // Media time 40: the delay
			box('mdia',
				box('mdhd', zeros(12), u32(1000), u32(0), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', zeros(4), u32(1), avc1),
					box('stts', zeros(8)),
					box('stsc', zeros(8)),
					box('stsz', zeros(12)),
					box('stco', zeros(8)),
				)),
			),
		),
		box('mvex', box('trex', zeros(4), u32(1), u32(1), zeros(12))),
	);
	const fragments = frames.map((frame, i) => {
		const flags = frame.key ? 0x02000000 : 0x01010000;
		const moof = (dataOffset: number) => box('moof', box('mfhd', zeros(4), u32(i + 1)), box('traf',
			box('tfhd', [0, 2, 0, 0], u32(1)), // Default base is moof
			box('trun', [0, 0, 0x0f, 0x01], u32(1), u32(dataOffset), u32(40), u32(10), u32(flags),
				u32((frame.pts + 1 - i) * 40)),
		));
		return [...moof(moof(0).length + 8), ...box('mdat', zeros(10))];
	});
	const ftyp = box('ftyp', ascii('iso6'), u32(0), ascii('iso6'));

	using input = new Input({
		source: new BufferSource(new Uint8Array([...ftyp, ...moov, ...fragments.flat()])),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual([0, 0.08, 0.04, 0.12]);
});

test('Macintosh language codes in the mdhd box of QuickTime files', async () => {
	// Below 0x400, QuickTime's mdhd holds a Macintosh language code (0 is English), as in FFmpeg's FATE samples
	// apple_cv.mov and ctk_cpro.mov. In other MP4 files, such a value isn't a language code at all.
	const readLanguage = async (majorBrand: string, language: number) => {
		const bytes = readFileSync(path.join(__dirname, '../public/sps-only-sar-h264.mp4'));
		bytes.write(majorBrand, 8, 'ascii');
		const mdhd = bytes.indexOf('mdhd');
		assert(mdhd > 0 && bytes[mdhd + 4] === 0); // Version 0
		bytes.writeUInt16BE(language, mdhd + 24);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		return track.getLanguageCode();
	};

	expect(await readLanguage('qt  ', 0x1a41)).toBe('fra'); // Packed ISO 639-2/T
	expect(await readLanguage('qt  ', 0)).toBe('eng');
	expect(await readLanguage('qt  ', 1)).toBe('fra');
	expect(await readLanguage('qt  ', 2)).toBe('deu'); // As a terminology code
	expect(await readLanguage('qt  ', 129)).toBe('eus');
	expect(await readLanguage('qt  ', 100)).toBe('und'); // Unassigned
	expect(await readLanguage('qt  ', 0x7fff)).toBe('und'); // Unspecified
	expect(await readLanguage('isom', 0)).toBe('und');
});

test('A pasp box wins over the SPS whether it comes before or after the codec configuration', async () => {
	// The fixtures' SPS signals a pixel aspect ratio, which a 2:1 pasp box inserted into the sample entry overrides
	const readSquarePixelSize = async (fileName: string, paspFirst: boolean) => {
		const file = readFileSync(path.join(__dirname, '../public', fileName));
		const moovStart = file.indexOf('moov') - 4;
		assert(moovStart + file.readUInt32BE(moovStart) === file.length); // So no chunk offsets move

		const configStart = Math.max(file.indexOf('avcC'), file.indexOf('hvcC')) - 4;
		const insertionPos = paspFirst ? configStart : configStart + file.readUInt32BE(configStart);
		const pasp = Buffer.from([0, 0, 0, 16, ...Buffer.from('pasp'), 0, 0, 0, 2, 0, 0, 0, 1]);
		const bytes = Buffer.concat([file.subarray(0, insertionPos), pasp, file.subarray(insertionPos)]);

		// The boxes enclosing the sample entry grow by the inserted box
		let boxStart = moovStart;
		for (const name of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']) {
			boxStart = bytes.indexOf(name, boxStart) - 4;
			bytes.writeUInt32BE(bytes.readUInt32BE(boxStart) + 16, boxStart);
		}
		const sampleEntryStart = boxStart + 16;
		bytes.writeUInt32BE(bytes.readUInt32BE(sampleEntryStart) + 16, sampleEntryStart);
		const width = bytes.readUInt16BE(sampleEntryStart + 32);
		const height = bytes.readUInt16BE(sampleEntryStart + 34);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		return [await track.getSquarePixelWidth() / width, await track.getSquarePixelHeight() / height];
	};

	for (const fileName of ['sps-only-sar-h264.mp4', 'sps-only-sar-hevc.mp4']) {
		expect(await readSquarePixelSize(fileName, false)).toEqual([2, 1]);
		expect(await readSquarePixelSize(fileName, true)).toEqual([2, 1]);
	}
});

test('A moov box at the end of the file with a size of 0', async () => {
	// A size of 0 means that the last top-level box extends to the end of the file (ISO/IEC 14496-12 4.2, QuickTime)
	const file = readFileSync(path.join(__dirname, '../public/sps-only-sar-h264.mp4'));
	const moovStart = file.indexOf('moov') - 4;
	assert(moovStart + file.readUInt32BE(moovStart) === file.length);
	file.writeUInt32BE(0, moovStart);

	// Also from a source whose size is only known once it ends
	const sources = [
		new BufferSource(file),
		new ReadableStreamSource(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(file));
				controller.close();
			},
		})),
	];
	for (const source of sources) {
		using input = new Input({ source, formats: ALL_FORMATS });
		const tracks = await input.getVideoTracks();
		expect(tracks).toHaveLength(1);

		const packet = await new EncodedPacketSink(tracks[0]!).getFirstPacket();
		expect([packet?.timestamp, packet?.byteLength]).toEqual([0, 645]);
	}
});

test('A movie matrix in an mvhd box after the trak boxes', async () => {
	// The children of moov may come in any order (QuickTime File Format), so the movie header can follow the tracks
	const readRotation = async (mvhdLast: boolean) => {
		let bytes: Buffer = readFileSync(path.join(__dirname, '../public/sps-only-sar-h264.mp4'));
		bytes.write('qt  ', 8, 'ascii');
		const moovStart = bytes.indexOf('moov') - 4;
		const mvhdStart = bytes.indexOf('mvhd') - 4;
		const mvhdSize = bytes.readUInt32BE(mvhdStart);
		assert(moovStart + bytes.readUInt32BE(moovStart) === bytes.length); // So moving mvhd to the end keeps it inside
		assert(mvhdStart === moovStart + 8 && bytes[mvhdStart + 8] === 0); // First in moov, version 0

		// A rotation by 90 degrees, [0, 1, 0; -1, 0, 0; 0, 0, 1] in 16.16 and 2.30 fixed point
		[0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000].forEach((value, i) => {
			bytes.writeUInt32BE(value >>> 0, mvhdStart + 44 + 4 * i);
		});
		if (mvhdLast) {
			const mvhd = bytes.subarray(mvhdStart, mvhdStart + mvhdSize);
			bytes = Buffer.concat([bytes.subarray(0, mvhdStart), bytes.subarray(mvhdStart + mvhdSize), mvhd]);
		}

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const packet = await new EncodedPacketSink(track).getFirstPacket();
		expect([packet?.timestamp, packet?.byteLength]).toEqual([0, 645]);
		return track.getRotation();
	};

	expect(await readRotation(false)).toBe(90);
	expect(await readRotation(true)).toBe(90);
});

test('Duration from metadata of a track whose samples all last 0', async () => {
	// Like a still frame next to other media (from the L17 roundtrip fuzz sweep): its mdhd duration is 0, but the
	// sample table says where it is
	const avcC = new Uint8Array(
		('0164000cffe100196764000cacd941011b011000000300100000030320f142996001000668ebe3cb22c0fdf8f800')
			.match(/../g)!.map(x => parseInt(x, 16)),
	);
	const decoderConfig = { codec: 'avc1.64000c', codedWidth: 128, codedHeight: 128, description: avcC };

	for (const format of [new Mp4OutputFormat(), new MovOutputFormat()]) {
		const output = new Output({ format, target: new BufferTarget() });
		const moving = new EncodedVideoPacketSource('avc');
		const still = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(moving);
		output.addVideoTrack(still);
		await output.start();
		await moving.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 0.5), { decoderConfig });
		await moving.add(new EncodedPacket(new Uint8Array(16), 'key', 0.5, 0.5));
		await still.add(new EncodedPacket(new Uint8Array(16), 'key', 10, 0), { decoderConfig });
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const tracks = await input.getVideoTracks();
		expect(await Promise.all(tracks.map(track => track.getDurationFromMetadata()))).toEqual([1, 10]);
		expect(await input.getDurationFromMetadata()).toBe(10);
		expect(await input.computeDuration()).toBe(10);
	}
});

test('Duration from metadata with a damaged sample table and an mdhd duration of 0', async () => {
	// The second track's sample table can't be read: its metadata duration stays unknown, and the file's comes from
	// the first track (from the L46 deep review)
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const sources = [new EncodedVideoPacketSource('vp9'), new EncodedVideoPacketSource('vp9')];
	for (const source of sources) {
		output.addVideoTrack(source);
	}
	await output.start();
	for (let i = 0; i < 10; i++) {
		for (const source of sources) {
			await source.add(new EncodedPacket(new Uint8Array([i]), i === 0 ? 'key' : 'delta', i / 10, 0.1), {
				decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 },
			});
		}
	}
	await output.finalize();

	const bytes = Buffer.from(output.target.buffer!);
	const secondTrak = bytes.indexOf('trak', bytes.indexOf('trak') + 4);
	const mdhd = bytes.indexOf('mdhd', secondTrak);
	assert(bytes[mdhd + 4] === 0); // Version 0
	bytes.fill(0, mdhd + 4 + 16, mdhd + 4 + 20); // Duration 0
	// Turn the stsz box into an stz2 box with an invalid field size, which no reader can make sense of
	const stsz = bytes.indexOf('stsz', secondTrak);
	bytes.write('stz2', stsz, 'ascii');
	bytes[stsz + 11] = 7; // Field size, in bits

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const tracks = await input.getVideoTracks();
	expect(await tracks[0]!.getDurationFromMetadata()).toBeCloseTo(1, 6);
	expect(await tracks[1]!.getDurationFromMetadata()).toBe(null);
	expect(await input.getDurationFromMetadata()).toBeCloseTo(1, 6);
});

test('Fragmented lookups outside of a track\'s data don\'t rescan the fragments without the track', async () => {
	// Two Opus tracks over 3 minutes, the second of which has data only at the start (like a microphone that was
	// unplugged), at the start and at the end (a gap), or only at the end
	const makeFile = async (hasData: (timestamp: number) => boolean) => {
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new BufferTarget(),
		});
		const main = new EncodedAudioPacketSource('opus');
		const partial = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(main);
		output.addAudioTrack(partial);
		await output.start();

		const decoderConfig = {
			codec: 'opus',
			numberOfChannels: 2,
			sampleRate: 48000,
			// OpusHead: version 1, 2 channels, 312 pre-skip, 48 kHz, no gain, family 0
			description: new Uint8Array([
				0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0,
			]),
		};
		const frameDuration = 0.02;
		const data = new Uint8Array(300).fill(0xfc);
		for (let i = 0; i < 180 / frameDuration; i++) {
			const timestamp = i * frameDuration;
			await main.add(new EncodedPacket(data, 'key', timestamp, frameDuration), { decoderConfig });
			if (hasData(timestamp)) {
				await partial.add(new EncodedPacket(data, 'key', timestamp, frameDuration), { decoderConfig });
			}
		}
		await output.finalize();

		return new Uint8Array(output.target.buffer!);
	};

	const cases = [
		// Data in the partial track; a lookup inside it; lookups outside of it, with the timestamp they return
		{ hasData: (t: number) => t < 18, inside: 10, outside: [60, 90, 120, 150], result: 17.98 },
		{ hasData: (t: number) => t < 18 || t >= 162, inside: 170, outside: [60, 90, 120, 150], result: 17.98 },
		{ hasData: (t: number) => t >= 162, inside: 170, outside: [30, 60, 90, 120], result: null },
	];
	for (const { hasData, inside, outside, result } of cases) {
		const bytes = await makeFile(hasData);
		let bytesRead = 0;
		using input = new Input({
			formats: ALL_FORMATS,
			source: new CustomSource({
				// A cache much smaller than the file, as for any long recording
				maxCacheSize: 2 ** 16,
				getSize: () => bytes.byteLength,
				read: (start, end) => {
					bytesRead += end - start;
					return bytes.subarray(start, end);
				},
			}),
		});
		const partialTrack = (await input.getAudioTracks())[1]!;
		const sink = new EncodedPacketSink(partialTrack);

		// Lookups inside the data only read around the packet
		bytesRead = 0;
		expect((await sink.getPacket(inside))!.timestamp).toBeCloseTo(inside, 5);
		expect(bytesRead).toBeLessThan(bytes.byteLength / 4);

		// The first lookup outside of it may have to walk the fragments without the track, but later ones don't
		for (const [i, timestamp] of outside.entries()) {
			bytesRead = 0;
			const packet = await sink.getPacket(timestamp);
			if (result === null) {
				expect(packet).toBeNull();
			} else {
				expect(packet!.timestamp).toBeCloseTo(result, 5);
			}
			if (i > 0) {
				expect(bytesRead).toBeLessThan(bytes.byteLength / 4);
			}
		}
	}
}, 60_000);

test('MP4 files cut off in their media data end with the last packet whose data is there', async () => {
	// Ten 1-second VP8 frames of 1000 bytes each, with key frames at 0 and 5 s, cut off in the middle of frame 7, like
	// an interrupted download. Reading the packets stops after frame 6, so lookups and the duration must agree.
	const makeFile = async (format: Mp4OutputFormat) => {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp8');
		output.addVideoTrack(source);
		await output.start();
		for (let i = 0; i < 10; i++) {
			await source.add(
				new EncodedPacket(new Uint8Array(1000).fill(i + 1), i % 5 === 0 ? 'key' : 'delta', i, 1),
				{ decoderConfig: { codec: 'vp8', codedWidth: 64, codedHeight: 64 } },
			);
		}
		await output.finalize();

		return new Uint8Array(output.target.buffer!);
	};

	for (const fastStart of ['in-memory', 'fragmented'] as const) {
		const full = await makeFile(new Mp4OutputFormat({ fastStart, minimumFragmentDuration: 100 }));
		// Frame 7's bytes are all 8
		const frame7Start = full.findIndex((_, i) => full.subarray(i, i + 1000).every(byte => byte === 8));
		const cut = full.subarray(0, frame7Start + 500);

		using input = new Input({ source: new BufferSource(cut), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new EncodedPacketSink(track);

		const timestamps: number[] = [];
		for await (const packet of sink.packets()) {
			timestamps.push(packet.timestamp);
		}
		expect(timestamps).toEqual([0, 1, 2, 3, 4, 5, 6]);

		expect((await sink.getPacket(8.5))?.timestamp).toBe(6);
		expect((await sink.getPacket(Infinity))?.timestamp).toBe(6);
		expect((await sink.getPacket(6.5))?.timestamp).toBe(6);
		expect((await sink.getKeyPacket(8.5))?.timestamp).toBe(5);
		expect(await sink.getNextPacket((await sink.getPacket(6))!)).toBeNull();
		expect(await track.computeDuration()).toBe(7);

		// The complete file
		using fullInput = new Input({ source: new BufferSource(full), formats: ALL_FORMATS });
		const fullTrack = (await fullInput.getPrimaryVideoTrack())!;
		expect((await new EncodedPacketSink(fullTrack).getPacket(8.5))?.timestamp).toBe(8);
		expect(await fullTrack.computeDuration()).toBe(10);
	}
});

test('MP4 files cut off inside their moov box keep the tracks before the cut', async () => {
	// A non-fast-start MP4 (moov after mdat) with a video and an audio track, and its udta box last in the moov box
	const makeFile = async () => {
		const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new BufferTarget() });
		const video = new EncodedVideoPacketSource('vp8');
		const audio = new EncodedAudioPacketSource('opus');
		output.addVideoTrack(video);
		output.addAudioTrack(audio);
		output.setMetadataTags({ title: 'A title long enough to fill the udta box at the end of the moov box' });
		await output.start();
		for (let i = 0; i < 10; i++) {
			await video.add(
				new EncodedPacket(new Uint8Array(1000).fill(i + 1), i % 5 === 0 ? 'key' : 'delta', i, 1),
				{ decoderConfig: { codec: 'vp8', codedWidth: 64, codedHeight: 64 } },
			);
			await audio.add(new EncodedPacket(new Uint8Array(100), 'key', i, 1), {
				decoderConfig: {
					codec: 'opus',
					numberOfChannels: 2,
					sampleRate: 48000,
					description: new Uint8Array([
						0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0,
					]),
				},
			});
		}
		await output.finalize();

		return new Uint8Array(output.target.buffer!);
	};
	const read = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const result: { type: string; packetCount: number }[] = [];
		for (const track of await input.getTracks()) {
			let packetCount = 0;
			for await (const packet of new EncodedPacketSink(track).packets()) {
				void packet;
				packetCount++;
			}
			result.push({ type: track.type, packetCount });
		}

		return { tracks: result, title: (await input.getMetadataTags()).title };
	};

	// The offsets of the boxes with the given name (or of anything that looks like one, good enough here)
	const findBoxes = (bytes: Uint8Array, name: string) => {
		const offsets: number[] = [];
		for (let i = 0; i + 8 <= bytes.byteLength; i++) {
			if (new TextDecoder().decode(bytes.subarray(i + 4, i + 8)) === name) {
				offsets.push(i);
			}
		}

		return offsets;
	};

	const full = await makeFile();
	const complete = {
		tracks: [{ type: 'video', packetCount: 10 }, { type: 'audio', packetCount: 10 }],
		title: 'A title long enough to fill the udta box at the end of the moov box',
	};
	expect(await read(full)).toEqual(complete);

	// Cut off inside the udta box: only the title is lost
	const udtaEnd = full.byteLength;
	expect(new TextDecoder().decode(full.subarray(udtaEnd - 40))).toContain('end of the moov box');
	expect(await read(full.subarray(0, udtaEnd - 10))).toEqual({ ...complete, title: undefined });

	// A moov size that goes past the end of the file
	const view = new DataView(full.buffer, full.byteOffset, full.byteLength);
	const moovStart = findBoxes(full, 'moov')[0]!;
	const oversized = full.slice();
	new DataView(oversized.buffer).setUint32(moovStart, 0x7fffffff);
	expect(await read(oversized)).toEqual(complete);
	expect(view.getUint32(moovStart)).toBe(full.byteLength - moovStart);

	// Cut off inside the second track: the first one stays
	const secondTrakStart = findBoxes(full, 'trak')[1]!;
	expect(await read(full.subarray(0, secondTrakStart + 100))).toEqual({
		tracks: [{ type: 'video', packetCount: 10 }],
		title: undefined,
	});
});

test('Fragments following samples in the moov box', async () => {
	// FFmpeg writes files like these when fragmenting without empty_moov: The samples of the first fragment go into the
	// moov box, all others into movie fragments
	await testMoovSamplesThenFragment(true);
});

test('Fragments following samples in the moov box, without tfdt', async () => {
	// Without a tfdt, the first fragment starts where the samples in the moov box end
	await testMoovSamplesThenFragment(false);
});

const testMoovSamplesThenFragment = async (withTfdt: boolean) => {
	using input = new Input({
		source: new BufferSource(moovSamplesThenFragment(withTfdt)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getVideoTracks())[0]!;
	const sink = new EncodedPacketSink(track);

	const packets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		packets.push(packet);
	}

	expect(packets.map(x => x.timestamp)).toEqual([0, 0.04, 0.08, 0.12, 0.16, 0.2]);
	expect(packets.map(x => x.data[0])).toEqual([0, 1, 2, 3, 4, 5]);
	expect(packets.map(x => x.type)).toEqual(['key', 'delta', 'delta', 'key', 'delta', 'delta']);

	expect((await sink.getPacket(0.05))!.timestamp).toBe(0.04);
	expect((await sink.getPacket(0.13))!.timestamp).toBe(0.12);
	expect((await sink.getKeyPacket(0.1))!.timestamp).toBe(0);
	expect((await sink.getKeyPacket(0.2))!.timestamp).toBe(0.12);
	expect((await sink.getNextKeyPacket(packets[0]!))!.timestamp).toBe(0.12);

	expect(await track.computeDuration()).toBe(0.24);
	// The metadata only knows about the samples in the moov box
	expect(await track.getDurationFromMetadata()).toBe(null);
};

const moovSamplesThenFragment = (withTfdt: boolean) => {
	const moov = (dataOffset: number) => box('moov',
		mvhd(),
		trak('vide', fullBox('mdhd', 0, 0, zeros(8), u32(1000), u32(120), zeros(4)),
			fullBox('stsd', 0, 0, u32(1), videoSampleEntry('avc1')),
			fullBox('stts', 0, 0, u32(1), u32(3), u32(40)),
			fullBox('stss', 0, 0, u32(1), u32(1)),
			fullBox('stsc', 0, 0, u32(1), u32(1), u32(3), u32(1)),
			fullBox('stsz', 0, 0, u32(0), u32(3), u32(4), u32(4), u32(4)),
			fullBox('stco', 0, 0, u32(1), u32(dataOffset)),
		),
		box('mvex', fullBox('trex', 0, 0, u32(1), u32(1), u32(40), u32(4), u32(0x10000))),
	);
	const moof = (dataOffset: number) => box('moof', box('traf',
		fullBox('tfhd', 0, 0x020000, u32(1)), // Default base is moof
		...(withTfdt ? [fullBox('tfdt', 0, 0, u32(120))] : []),
		fullBox('trun', 0, 0x000005, u32(3), u32(dataOffset), u32(0)), // First sample is a key frame
	));

	const ftyp = box('ftyp', ascii('isom'), u32(0), ascii('isom'));
	const moovDataOffset = ftyp.length + moov(0).length + 8;

	return concat(
		ftyp,
		moov(moovDataOffset),
		box('mdat', sampleData(0), sampleData(1), sampleData(2)),
		moof(moof(0).length + 8),
		box('mdat', sampleData(3), sampleData(4), sampleData(5)),
	);
};

test('Fragments without tfdt next to a track whose sample table is damaged', async () => {
	// Two tracks with all of their samples in fragments without tfdt, the second of which has an stts box claiming
	// 1000 entries that aren't there. The first track reads as before.
	const trak = (trackId: number, damaged: boolean) => box('trak',
		fullBox('tkhd', 0, 1, zeros(8), u32(trackId), zeros(68)),
		box('mdia',
			fullBox('mdhd', 0, 0, zeros(8), u32(1000), u32(0), zeros(4)),
			fullBox('hdlr', 0, 0, zeros(4), ascii('vide'), zeros(13)),
			box('minf', box('stbl',
				fullBox('stsd', 0, 0, u32(1), videoSampleEntry('avc1')),
				fullBox('stts', 0, 0, u32(damaged ? 1000 : 0)),
				fullBox('stsc', 0, 0, u32(0)),
				fullBox('stsz', 0, 0, u32(0), u32(0)),
				fullBox('stco', 0, 0, u32(0)),
			)),
		),
	);
	const trex = (trackId: number) => fullBox('trex', 0, 0, u32(trackId), u32(1), u32(40), u32(4), u32(0x10000));
	const traf = (trackId: number, dataOffset: number) => box('traf',
		fullBox('tfhd', 0, 0x020000, u32(trackId)), // Default base is moof
		fullBox('trun', 0, 0x000005, u32(3), u32(dataOffset), u32(0)), // First sample is a key frame
	);
	const moof = (dataOffset: number) => box('moof', traf(1, dataOffset), traf(2, dataOffset + 12));

	const file = concat(
		box('ftyp', ascii('isom'), u32(0), ascii('isom')),
		box('moov', mvhd(), trak(1, false), trak(2, true), box('mvex', trex(1), trex(2))),
		moof(moof(0).length + 8),
		box('mdat', sampleData(0), sampleData(1), sampleData(2), sampleData(3), sampleData(4), sampleData(5)),
	);

	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const track = (await input.getVideoTracks())[0]!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	expect(packets.map(x => x.timestamp)).toEqual([0, 0.04, 0.08]);
	expect(packets.map(x => x.data[0])).toEqual([0, 1, 2]);
});

const sampleData = (value: number) => [value, value, value, value];

const videoSampleEntry = (name: string, ...children: Bytes[]) => box(
	name, zeros(6), u16(1), zeros(16), u16(64), u16(64), zeros(50), ...children,
);

const mvhd = () => fullBox('mvhd', 0, 0, zeros(8), u32(1000), zeros(84));

const trak = (handler: string, mediaHeader: Bytes, ...stblChildren: Bytes[]) => box('trak',
	fullBox('tkhd', 0, 1, zeros(8), u32(1), zeros(68)),
	box('mdia',
		mediaHeader,
		fullBox('hdlr', 0, 0, zeros(4), ascii(handler), zeros(13)),
		box('minf', box('stbl', ...stblChildren)),
	),
);

type Bytes = Uint8Array | number[];

const fullBox = (name: string, version: number, flags: number, ...parts: Bytes[]) => {
	return box(name, u8(version), u24(flags), ...parts);
};

const box = (name: string, ...parts: Bytes[]) => {
	const content = concat(...parts);
	return concat(u32(8 + content.length), ascii(name), content);
};

const concat = (...parts: Bytes[]) => {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}

	return result;
};

const u32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u24 = (value: number) => [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const u8 = (value: number) => [value & 0xff];
const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
const zeros = (length: number) => new Uint8Array(length);

test('Fragments without tfdt are placed the same whichever track is looked up first', async () => {
	// A video and an audio track in fragments without tfdt, where only the video track has tfra entries (like
	// FFmpeg's samples au30sec.mp4 and MAV_0001.3G2). A video lookup can jump to a late fragment, whose audio samples
	// can only be placed in time once the audio track's earlier fragments have been read.
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
		target: new BufferTarget(),
	});
	const video = new EncodedVideoPacketSource('vp8');
	const audio = new EncodedAudioPacketSource('opus');
	output.addVideoTrack(video);
	output.addAudioTrack(audio);
	await output.start();
	const audioConfig = {
		codec: 'opus',
		numberOfChannels: 2,
		sampleRate: 48000,
		// OpusHead: version 1, 2 channels, 312 pre-skip, 48 kHz, no gain, family 0
		description: new Uint8Array([
			0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0,
		]),
	};
	for (let i = 0; i < 500; i++) {
		if (i % 5 === 0) {
			await video.add(new EncodedPacket(new Uint8Array(100), i % 50 === 0 ? 'key' : 'delta', i / 50, 0.1), {
				decoderConfig: { codec: 'vp8', codedWidth: 64, codedHeight: 64 },
			});
		}
		await audio.add(new EncodedPacket(new Uint8Array(50), 'key', i / 50, 0.02), { decoderConfig: audioConfig });
	}
	await output.finalize();

	// Remove the tfdt boxes and the audio track's tfra box by renaming them (which keeps every offset valid)
	const bytes = new Uint8Array(output.target.buffer!);
	const tfraCount = { count: 0 };
	for (let i = 4; i + 4 <= bytes.byteLength; i++) {
		const name = new TextDecoder().decode(bytes.subarray(i, i + 4));
		if (name === 'tfdt' || (name === 'tfra' && tfraCount.count++ > 0)) {
			bytes.set(new TextEncoder().encode('free'), i);
		}
	}
	expect(tfraCount.count).toBe(2);

	const readAudio = async (lookUpVideoFirst: boolean) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const [videoTrack, audioTrack] = [(await input.getVideoTracks())[0]!, (await input.getAudioTracks())[0]!];
		if (lookUpVideoFirst) {
			expect(await videoTrack.computeDuration()).toBe(10);
		}

		const sink = new EncodedPacketSink(audioTrack);
		const timestamps: number[] = [];
		for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
			timestamps.push(packet.timestamp);
		}

		const last = (await sink.getPacket(Infinity))?.timestamp;
		return { timestamps, last, duration: await audioTrack.computeDuration() };
	};

	const fresh = await readAudio(false);
	expect(fresh.timestamps).toEqual(Array.from({ length: 500 }, (_, i) => i / 50));
	expect(fresh.duration).toBe(10);
	expect(await readAudio(true)).toEqual(fresh);
});

test('Video tracks whose samples are all sync samples only have key packets', async () => {
	// Without an stss box, every sample is a sync sample (ISO/IEC 14496-12 8.6.2.1); FFmpeg and Mediabunny leave it out
	// for all-intra video. Fragments flag their samples themselves.
	const read = async (types: ('key' | 'delta')[], fastStart?: 'fragmented') => {
		const output = new Output({ format: new Mp4OutputFormat({ fastStart }), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source);
		await output.start();
		for (const [i, type] of types.entries()) {
			await source.add(new EncodedPacket(new Uint8Array([i, 1, 2, 3]), type, i / 10, 1 / 10), {
				decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 },
			});
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const packetTypes: string[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packetTypes.push(packet.type);
		}

		return { packetTypes, hasOnlyKeyPackets: await track.hasOnlyKeyPackets() };
	};

	expect(await read(['key', 'key', 'key', 'key'])).toEqual({
		packetTypes: ['key', 'key', 'key', 'key'],
		hasOnlyKeyPackets: true,
	});
	expect(await read(['key', 'delta', 'delta', 'key'])).toEqual({
		packetTypes: ['key', 'delta', 'delta', 'key'],
		hasOnlyKeyPackets: false,
	});
	// The metadata of fragmented files doesn't say, so it's up to the codec, as before
	expect((await read(['key', 'key', 'key', 'key'], 'fragmented')).hasOnlyKeyPackets).toBe(false);
});

test('An invalid stss entry of 0 does not make a video track only have key packets', async () => {
	// Ten samples, all key frames but the last, with an extra stss entry 0 at the end (entries are 1-based; a table
	// starting at 0 would count from 0)
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source);
	await output.start();
	for (let i = 0; i < 10; i++) {
		await source.add(new EncodedPacket(new Uint8Array([i, 1, 2, 3]), i < 9 ? 'key' : 'delta', i / 10, 1 / 10), {
			decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 },
		});
	}
	await output.finalize();

	// Append the entry, growing stss and its ancestors by 4 bytes. The moov box comes last, so no offsets change.
	const bytes = new Uint8Array(output.target.buffer!);
	const view = new DataView(bytes.buffer);
	const findBox = (name: string) => bytes.findIndex(
		(_, i) => new TextDecoder().decode(bytes.subarray(i + 4, i + 8)) === name,
	);
	const stss = findBox('stss');
	const stssEnd = stss + view.getUint32(stss);
	const damaged = new Uint8Array([...bytes.subarray(0, stssEnd), 0, 0, 0, 0, ...bytes.subarray(stssEnd)]);
	const damagedView = new DataView(damaged.buffer);
	damagedView.setUint32(stss + 12, view.getUint32(stss + 12) + 1); // Entry count
	for (const name of ['stss', 'stbl', 'minf', 'mdia', 'trak', 'moov']) {
		const position = findBox(name);
		damagedView.setUint32(position, view.getUint32(position) + 4);
	}

	using input = new Input({ source: new BufferSource(damaged), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	let keyPacketCount = 0;
	for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
		keyPacketCount += packet.type === 'key' ? 1 : 0;
	}
	expect(keyPacketCount).toBe(9);
	expect(await track.hasOnlyKeyPackets()).toBe(false);
});

test('Sample rate not fitting the sample entry', async () => {
	// Without a srat box, the sample entry just says 0, leaving the media timescale as the best guess
	const sampleEntry = audioSampleEntry('ipcm', 0, 2, 16, 0, [
		fullBox('pcmC', 0, 0, u8(1), u8(16)),
	]);

	using input = new Input({
		source: new BufferSource(pcmFile({
			majorBrand: 'isom',
			stsd: fullBox('stsd', 0, 0, u32(1), sampleEntry),
			timescale: 96000,
			sampleDuration: 1,
			sampleSize: 4,
			data: zeros(4 * 96),
		})),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getSampleRate()).toBe(96000);
});

test('MP4 and MOV audio above 65535 Hz, as Mediabunny writes it, decodes at its sample rate', async () => {
	// The 16.16 sample rate field of the sample entry can't hold 96000, so Mediabunny and FFmpeg write 0 there
	const readBack = async (format: Mp4OutputFormat | MovOutputFormat) => {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(2 * 960), 'key', 0, 0.01), {
			decoderConfig: { codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 96000 },
		});
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		using sample = (await new AudioSampleSink(track).getSample(0))!;
		return [await track.getSampleRate(), sample.sampleRate, sample.numberOfFrames, sample.duration];
	};

	expect(await readBack(new Mp4OutputFormat())).toEqual([96000, 96000, 960, 0.01]);
	expect(await readBack(new MovOutputFormat())).toEqual([96000, 96000, 960, 0.01]);
});

const audioSampleEntry = (
	name: string,
	version: number,
	channelCount: number,
	sampleSize: number,
	sampleRate: number,
	extra: Bytes[] = [],
) => box(
	name, zeros(6), u16(1), u16(version), zeros(6), u16(channelCount), u16(sampleSize), zeros(4),
	u32(0x10000 * sampleRate), ...extra,
);

const pcmFile = (options: {
	majorBrand: string;
	stsd: Bytes;
	timescale: number;
	sampleDuration: number;
	sampleSize: number;
	data: Uint8Array;
}) => {
	const ftyp = box('ftyp', ascii(options.majorBrand), u32(0), ascii(options.majorBrand));
	const sampleCount = options.data.length / options.sampleSize;

	return concat(
		ftyp,
		box('mdat', options.data),
		box('moov',
			mvhd(),
			trak('soun', mdhd(options.timescale),
				options.stsd,
				fullBox('stts', 0, 0, u32(1), u32(sampleCount), u32(options.sampleDuration)),
				fullBox('stsc', 0, 0, u32(1), u32(1), u32(sampleCount), u32(1)),
				fullBox('stsz', 0, 0, u32(options.sampleSize), u32(sampleCount)),
				fullBox('stco', 0, 0, u32(1), u32(ftyp.length + 8)),
			),
		),
	);
};

const mdhd = (timescale: number) => fullBox('mdhd', 0, 0, zeros(8), u32(timescale), zeros(8));

test('Sample encryption entries without subsamples decrypt the whole sample', async () => {
	// senc flags 0x2 (subsamples present) with a subsample count of 0; FFmpeg decrypts the whole sample then
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const build = (scheme: string, tenc: number[], senc: number[], sample: number[]) => {
		const encv = box('encv', zeros(6), [0, 1], zeros(16), [0, 64, 0, 64], zeros(12), [0, 1], zeros(32),
			[0, 24, 0xff, 0xff], box('avcC', [1, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x00]),
			box('sinf', box('frma', ascii('avc1')), box('schm', u32(0), ascii(scheme), u32(0x10000)),
				box('schi', tenc)));
		const moof = (dataOffset: number) => box('moof', box('mfhd', u32(0), u32(1)), box('traf',
			box('tfhd', u32(0x020000), u32(1)),
			box('trun', u32(0x301), u32(1), u32(dataOffset), u32(1), u32(sample.length)),
			senc,
		));
		return new Uint8Array([
			...box('ftyp', ascii('iso6'), u32(0)),
			...box('moov',
				box('mvhd', zeros(12), u32(10), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
				box('trak',
					box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
					box('mdia',
						box('mdhd', zeros(12), u32(10), u32(0), [0x55, 0xc4, 0, 0]),
						box('hdlr', zeros(8), ascii('vide'), zeros(13)),
						box('minf', box('stbl',
							box('stsd', u32(0), u32(1), encv),
							box('stts', zeros(8)),
							box('stsc', zeros(8)),
							box('stsz', zeros(12)),
							box('stco', zeros(8)),
						)),
					),
				),
				box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
			),
			...moof(moof(0).length + 8),
			...box('mdat', sample),
		]);
	};
	const readFirstPacket = async (bytes: Uint8Array) => {
		using input = new Input({
			source: new BufferSource(bytes),
			formats: ALL_FORMATS,
			formatOptions: { isobmff: { resolveKeyId: () => key } },
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const packet = await new EncodedPacketSink(track).getFirstPacket();
		return [...packet!.data];
	};

	// cenc, with an 8-byte IV per sample
	const plaintext = [0, 0, 0, 12, 0x65, ...zeros(12).map((_, i) => i)];
	const iv = [...zeros(7), 1];
	const cencTenc = box('tenc', u32(0), [0, 0, 1, 8], zeros(16));
	const cencSample = [
		...createCipheriv('aes-128-ctr', key, Buffer.from([...iv, ...zeros(8)])).update(Buffer.from(plaintext)),
	];
	expect(await readFirstPacket(build('cenc', cencTenc, box('senc', u32(0), u32(1), iv), cencSample)))
		.toEqual(plaintext);
	expect(await readFirstPacket(build('cenc', cencTenc, box('senc', u32(2), u32(1), iv, [0, 0]), cencSample)))
		.toEqual(plaintext);

	// cbcs, with a constant IV: CBC over the whole blocks, and the rest stays clear
	const constantIv = zeros(16).map((_, i) => i);
	const cbcsTenc = box('tenc', u32(1 << 24), [0, 0x19, 1, 0], zeros(16), [16], constantIv);
	const longPlaintext = [...plaintext, ...plaintext, 0xaa, 0xbb];
	const cipher = createCipheriv('aes-128-cbc', key, Buffer.from(constantIv)).setAutoPadding(false);
	const cbcsSample = [...cipher.update(Buffer.from(longPlaintext.slice(0, 32))), ...longPlaintext.slice(32)];
	expect(await readFirstPacket(build('cbcs', cbcsTenc, box('senc', u32(0), u32(1)), cbcsSample)))
		.toEqual(longPlaintext);
	expect(await readFirstPacket(build('cbcs', cbcsTenc, box('senc', u32(2), u32(1), [0, 0]), cbcsSample)))
		.toEqual(longPlaintext);
});

test('The key resolver only gets the pssh boxes of its key ID in non-fragmented files too', async () => {
	// The pssh boxes in the moov box list different key IDs (version 1), and only one applies to the track
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
	const keyId = '0123456789abcdef0123456789abcdef';
	const otherKeyId = 'ffeeddccbbaa99887766554433221100';
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const encv = box('encv', zeros(6), [0, 1], zeros(16), [0, 64, 0, 64], zeros(12), [0, 1], zeros(32),
		[0, 24, 0xff, 0xff], box('avcC', [1, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x00]),
		box('sinf', box('frma', ascii('avc1')), box('schm', u32(0), ascii('cenc'), u32(0x10000)),
			box('schi', box('tenc', u32(0), [0, 0, 1, 8], [...Buffer.from(keyId, 'hex')]))));
	const pssh = (kid: string) => box('pssh', [1, 0, 0, 0], [...Buffer.from('1077efecc0b24d02ace33c1e52e2fb4b', 'hex')],
		u32(1), [...Buffer.from(kid, 'hex')], u32(0)); // Common pssh (version 1) listing one key ID
	const plaintext = [0, 0, 0, 12, 0x65, ...zeros(12)];
	const iv = [...zeros(7), 1];
	const ciphertext = [...createCipheriv('aes-128-ctr', key, Buffer.from([...iv, ...zeros(8)]))
		.update(Buffer.from(plaintext))];
	// mdat payload: the IV (sample auxiliary information), then the sample
	const moov = (mdatStart: number) => box('moov',
		box('mvhd', zeros(12), u32(10), u32(1), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(4), u32(1), zeros(16), matrix, u32(64 << 16), u32(64 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(10), u32(1), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl', box('stsd', u32(0), u32(1), encv),
					box('stts', u32(0), u32(1), u32(1), u32(1)),
					box('stsc', u32(0), u32(1), u32(1), u32(1), u32(1)),
					box('stsz', u32(0), u32(ciphertext.length), u32(1)),
					box('stco', u32(0), u32(1), u32(mdatStart + 8 + iv.length)),
					box('saiz', u32(0), [iv.length], u32(1)),
					box('saio', u32(0), u32(1), u32(mdatStart + 8)))),
			),
		),
		pssh(keyId),
		pssh(otherKeyId),
	);
	const head = [...box('ftyp', ascii('isom'), u32(0))];
	const mdatStart = head.length + moov(0).length;
	const file = new Uint8Array([...head, ...moov(mdatStart), ...box('mdat', iv, ciphertext)]);

	const seenKeyIds: string[][] = [];
	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
		formatOptions: { isobmff: { resolveKeyId: ({ psshBoxes }) => {
			seenKeyIds.push(psshBoxes.flatMap(x => x.keyIds ?? []));
			return key;
		} } },
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const packet = await new EncodedPacketSink(track).getFirstPacket();
	expect([...packet!.data]).toEqual(plaintext);
	expect(seenKeyIds).toEqual([[keyId]]);
});

test('Sample auxiliary information with one saio offset per track run or chunk', async () => {
	// ISO/IEC 14496-12 8.7.9: saio holds one offset, or one per track run (in fragments) or chunk. Here each sample's
	// IV sits right before it in the mdat box.
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const encv = box('encv', zeros(6), [0, 1], zeros(16), [0, 64, 0, 64], zeros(12), [0, 1], zeros(32),
		[0, 24, 0xff, 0xff], box('avcC', [1, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x00]),
		box('sinf', box('frma', ascii('avc1')), box('schm', u32(0), ascii('cenc'), u32(0x10000)),
			box('schi', box('tenc', u32(0), [0, 0, 1, 8], zeros(16)))));
	const plaintexts = [[0, 0, 0, 12, 0x65, ...zeros(12)], [0, 0, 0, 20, 0x41, ...zeros(20).map((_, i) => i)]];
	const ivs = [[...zeros(7), 1], [...zeros(7), 2]];
	const [c1, c2] = plaintexts.map((plaintext, i) => [
		...createCipheriv('aes-128-ctr', key, Buffer.from([...ivs[i]!, ...zeros(8)])).update(Buffer.from(plaintext)),
	]) as [number[], number[]];
	const mdat = box('mdat', ivs[0]!, c1, ivs[1]!, c2);
	const trak = (...stbl: number[][]) => box('trak',
		box('tkhd', u32(3), zeros(8), u32(1), zeros(4), u32(2), zeros(16), matrix, u32(64 << 16), u32(64 << 16)),
		box('mdia',
			box('mdhd', zeros(12), u32(10), u32(2), [0x55, 0xc4, 0, 0]),
			box('hdlr', zeros(8), ascii('vide'), zeros(13)),
			box('minf', box('stbl', box('stsd', u32(0), u32(1), encv), ...stbl)),
		),
	);
	const mvhd = box('mvhd', zeros(12), u32(10), u32(2), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28));
	const ftyp = box('ftyp', ascii('iso6'), u32(0));

	// Fragmented: two track runs. Offsets are relative to the moof box.
	const moof = (start: number) => box('moof', box('mfhd', u32(0), u32(1)), box('traf',
		box('tfhd', u32(0x020000), u32(1)),
		box('trun', u32(0x301), u32(1), u32(start + 8 + 8), u32(1), u32(c1.length)),
		box('trun', u32(0x301), u32(1), u32(start + 8 + 16 + c1.length), u32(1), u32(c2.length)),
		box('saiz', u32(0), [8], u32(2)),
		box('saio', u32(0), u32(2), u32(start + 8), u32(start + 8 + 8 + c1.length)),
	));
	const fragmented = [
		...ftyp,
		...box('moov',
			mvhd,
			trak(box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8))),
			box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
		),
		...moof(moof(0).length),
		...mdat,
	];

	// Not fragmented: two chunks. Offsets are absolute.
	const moov = (mdatStart: number) => box('moov', mvhd, trak(
		box('stts', u32(0), u32(1), u32(2), u32(1)),
		box('stsc', u32(0), u32(1), u32(1), u32(1), u32(1)),
		box('stsz', u32(0), u32(0), u32(2), u32(c1.length), u32(c2.length)),
		box('stco', u32(0), u32(2), u32(mdatStart + 16), u32(mdatStart + 24 + c1.length)),
		box('saiz', u32(0), [8], u32(2)),
		box('saio', u32(0), u32(2), u32(mdatStart + 8), u32(mdatStart + 16 + c1.length)),
	));
	const mdatStart = ftyp.length + moov(0).length;
	const regular = [...ftyp, ...moov(mdatStart), ...mdat];

	for (const file of [fragmented, regular]) {
		using input = new Input({
			source: new BufferSource(new Uint8Array(file)),
			formats: ALL_FORMATS,
			formatOptions: { isobmff: { resolveKeyId: () => key } },
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const packets: number[][] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push([...packet.data]);
		}
		expect(packets).toEqual(plaintexts);
	}
});

test('A failed key resolution is tried again for later samples', async () => {
	// E.g. a license server that's briefly unreachable: the next packet read asks resolveKeyId again
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const encv = box('encv', zeros(6), [0, 1], zeros(16), [0, 64, 0, 64], zeros(12), [0, 1], zeros(32),
		[0, 24, 0xff, 0xff], box('avcC', [1, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x00]),
		box('sinf', box('frma', ascii('avc1')), box('schm', u32(0), ascii('cenc'), u32(0x10000)),
			box('schi', box('tenc', u32(0), [0, 0, 1, 8], zeros(16)))));
	const plaintext = [0, 0, 0, 12, 0x65, ...zeros(12)];
	const iv = [...zeros(7), 1];
	const ciphertext = [...createCipheriv('aes-128-ctr', key, Buffer.from([...iv, ...zeros(8)]))
		.update(Buffer.from(plaintext))];
	const moof = (dataOffset: number) => box('moof', box('mfhd', u32(0), u32(1)), box('traf',
		box('tfhd', u32(0x020000), u32(1)),
		box('trun', u32(0x301), u32(1), u32(dataOffset), u32(1), u32(ciphertext.length)),
		box('senc', u32(0), u32(1), iv),
	));
	const file = new Uint8Array([
		...box('ftyp', ascii('iso6'), u32(0)),
		...box('moov',
			box('mvhd', zeros(12), u32(10), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
			box('trak',
				box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
				box('mdia',
					box('mdhd', zeros(12), u32(10), u32(0), [0x55, 0xc4, 0, 0]),
					box('hdlr', zeros(8), ascii('vide'), zeros(13)),
					box('minf', box('stbl',
						box('stsd', u32(0), u32(1), encv),
						box('stts', zeros(8)),
						box('stsc', zeros(8)),
						box('stsz', zeros(12)),
						box('stco', zeros(8)),
					)),
				),
			),
			box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
		),
		...moof(moof(0).length + 8),
		...box('mdat', ciphertext),
	]);

	let resolveCount = 0;
	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
		formatOptions: { isobmff: { resolveKeyId: () => {
			resolveCount++;
			if (resolveCount === 1) {
				throw new Error('License server unavailable');
			}
			return key;
		} } },
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	await expect(sink.getFirstPacket()).rejects.toThrow('License server unavailable');
	expect([...(await sink.getFirstPacket())!.data]).toEqual(plaintext);
	expect(resolveCount).toBe(2);
});

test('Samples encrypted with an unsupported protection scheme throw instead of coming back as ciphertext', async () => {
	// 'cbc1' (ISO/IEC 23001-7), 'piff' (PIFF 1.1, Smooth Streaming) and a sinf without schm can't be decrypted
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const plaintext = [0, 0, 0, 12, 0x65, ...zeros(12)];
	const iv = [...zeros(7), 1];
	const ciphertext = [
		...createCipheriv('aes-128-ctr', key, Buffer.from([...iv, ...zeros(8)])).update(Buffer.from(plaintext)),
	];
	const sampleEntry = (name: string, ...children: number[][]) => box(name, zeros(6), [0, 1], zeros(16),
		[0, 64, 0, 64], zeros(12), [0, 1], zeros(32), [0, 24, 0xff, 0xff],
		box('avcC', [1, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x00]), ...children);
	const encv = (scheme: string | null) => sampleEntry('encv', box('sinf', box('frma', ascii('avc1')),
		...(scheme ? [box('schm', u32(0), ascii(scheme), u32(0x10000))] : []),
		box('schi', box('tenc', u32(0), [0, 0, 1, 8], zeros(16)))));
	const trak = (sampleEntries: number[][], ...stbl: number[][]) => box('trak',
		box('tkhd', u32(3), zeros(8), u32(1), zeros(4), u32(1), zeros(16), matrix, u32(64 << 16), u32(64 << 16)),
		box('mdia',
			box('mdhd', zeros(12), u32(10), u32(1), [0x55, 0xc4, 0, 0]),
			box('hdlr', zeros(8), ascii('vide'), zeros(13)),
			box('minf', box('stbl', box('stsd', u32(0), u32(sampleEntries.length), ...sampleEntries), ...stbl)),
		),
	);
	const mvhd = box('mvhd', zeros(12), u32(10), u32(1), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28));
	const ftyp = box('ftyp', ascii('iso6'), u32(0));
	const fragmented = (sampleEntries: number[][], sampleDescriptionIndex: number, data: number[]) => {
		const moof = (dataOffset: number) => box('moof', box('mfhd', u32(0), u32(1)), box('traf',
			box('tfhd', u32(0x020002), u32(1), u32(sampleDescriptionIndex)),
			box('trun', u32(0x301), u32(1), u32(dataOffset), u32(1), u32(data.length)),
			box('senc', u32(0), u32(1), iv),
		));
		return [
			...ftyp,
			...box('moov',
				mvhd,
				trak(sampleEntries, box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)),
					box('stco', zeros(8))),
				box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
			),
			...moof(moof(0).length + 8),
			...box('mdat', data),
		];
	};
	const regular = (sampleEntries: number[][]) => {
		const moov = (mdatStart: number) => box('moov', mvhd, trak(sampleEntries,
			box('stts', u32(0), u32(1), u32(1), u32(1)),
			box('stsc', u32(0), u32(1), u32(1), u32(1), u32(1)),
			box('stsz', u32(0), u32(ciphertext.length), u32(1)),
			box('stco', u32(0), u32(1), u32(mdatStart + 8 + iv.length)),
			box('saiz', u32(0), [iv.length], u32(1)),
			box('saio', u32(0), u32(1), u32(mdatStart + 8)),
		));
		const mdatStart = ftyp.length + moov(0).length;
		return [...ftyp, ...moov(mdatStart), ...box('mdat', iv, ciphertext)];
	};
	const readFirstPacket = async (bytes: number[]) => {
		using input = new Input({
			source: new BufferSource(new Uint8Array(bytes)),
			formats: ALL_FORMATS,
			formatOptions: { isobmff: { resolveKeyId: () => key } },
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const packet = await new EncodedPacketSink(track).getFirstPacket();
		return [...packet!.data];
	};

	expect(await readFirstPacket(fragmented([encv('cenc')], 1, ciphertext))).toEqual(plaintext);
	expect(await readFirstPacket(regular([encv('cenc')]))).toEqual(plaintext);
	for (const scheme of ['cbc1', 'piff', null]) {
		await expect(readFirstPacket(fragmented([encv(scheme)], 1, ciphertext)))
			.rejects.toThrow(/unsupported protection scheme/);
		await expect(readFirstPacket(regular([encv(scheme)]))).rejects.toThrow(/unsupported protection scheme/);
	}

	// Clear lead samples, which use a clear sample description, can still be read
	expect(await readFirstPacket(fragmented([encv('cbc1'), sampleEntry('avc1')], 2, plaintext))).toEqual(plaintext);
});
