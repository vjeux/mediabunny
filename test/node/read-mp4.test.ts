import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
