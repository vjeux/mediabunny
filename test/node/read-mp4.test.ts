import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
