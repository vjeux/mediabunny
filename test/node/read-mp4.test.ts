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

// The avcC of ffmpeg -f lavfi -i testsrc2=size=1920x1080 -frames:v 1 -c:v libx264 -profile:v high out.mp4
const X264_AVCC = new Uint8Array('01640028ffe1001b67640028acd940780227e5c044000003000400000300c83c60c658010006'
	.concat('68ebe3cb22c0fdf8f800').match(/../g)!.map(x => parseInt(x, 16)));

const u32 = (value: number) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];

/** Writes the given length-prefixed H.264 frames into an MP4 at 30 fps, each marked as a key frame there. */
const writeAvcFrames = async (frames: number[][]) => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	for (let i = 0; i < frames.length; i++) {
		const packet = new EncodedPacket(new Uint8Array(frames[i]!), 'key', i / 30, 1 / 30);
		await source.add(packet, i === 0
			? { decoderConfig: { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080, description: X264_AVCC } }
			: undefined);
	}
	await output.finalize();
	return output.target.buffer!;
};

test('Key frames of H.264 with several NAL units under one length (Android temporal layers)', async () => {
	// Android's MPEG4Writer only turns the first start code of a frame into a length, so each frame of temporally
	// layered video (as recorded by Samsung's slow motion modes) is an SVC prefix NAL unit, a start code and the slice,
	// all under one length
	const prefixNalUnit = [0x6e, 0xc0, 0x80, 0x0f]; // nal_unit_type 14, as in the Samsung files
	const idrSlice = [0x65, 0x88, 0x84, 0x00, 0x33, 0xff]; // nal_unit_type 5
	const nonIdrSlice = [0x41, 0x9a, 0x02, 0x04, 0x11, 0xff]; // nal_unit_type 1

	const layouts = [
		(slice: number[]) => [...u32(8 + slice.length), ...prefixNalUnit, 0, 0, 0, 1, ...slice], // Android's
		(slice: number[]) => [...u32(4), ...prefixNalUnit, ...u32(slice.length), ...slice], // One length per NAL unit
	];

	for (const frame of layouts) {
		using input = new Input({
			source: new BufferSource(await writeAvcFrames([frame(idrSlice), frame(nonIdrSlice)])),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new EncodedPacketSink(track);

		expect(await track.determinePacketType((await sink.getFirstPacket())!)).toBe('key');
		expect(await track.determinePacketType((await sink.getPacket(1 / 30))!)).toBe('delta');
		expect((await sink.getKeyPacket(1 / 30, { verifyKeyPackets: true }))?.timestamp).toBe(0);
	}
});

test('H.264 packet types come from the length-prefixed slices when there are any', async () => {
	// An unregistered user data SEI whose payload a writer failed to escape (against H.264 7.4.1), so that it holds a
	// start code followed by a NAL unit header
	const sei = (nalUnitHeader: number) => {
		const payload = [...Array.from({ length: 16 }, (_, i) => 0x10 + i), 0x41, 0, 0, 1, nalUnitHeader, 0x88, 0x84];
		return [0x06, 0x05, payload.length, ...payload, 0x80];
	};
	const slice = (nalUnitHeader: number) => [nalUnitHeader, 0x88, 0x84, 0x21, 0xa0, 0x5c, 0x37];
	const lengthPrefixed = (...nalUnits: number[][]) => nalUnits.flatMap(x => [...u32(x.length), ...x]);

	using input = new Input({
		source: new BufferSource(await writeAvcFrames([
			lengthPrefixed(slice(0x65)), // IDR
			lengthPrefixed(sei(0x65), slice(0x41)), // Not IDR, although the SEI holds "00 00 01 65"
			lengthPrefixed(sei(0x41), slice(0x65)), // IDR, although the SEI holds "00 00 01 41"
		])),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const sink = new EncodedPacketSink(track);

	const types: (string | null)[] = [];
	for await (const packet of sink.packets()) {
		types.push(await track.determinePacketType(packet));
	}
	expect(types).toEqual(['key', 'delta', 'key']);

	expect((await sink.getKeyPacket(1.5 / 30, { verifyKeyPackets: true }))?.timestamp).toBe(0);
	expect((await sink.getKeyPacket(2.5 / 30, { verifyKeyPackets: true }))?.timestamp).toBeCloseTo(2 / 30);
});

test('H.264 packet types ignore start codes in the bytes a broken length runs into', async () => {
	// As in broken files from the wild: after a few NAL units, a length that runs far past the end of the packet, over
	// bytes that happen to hold a start code and an IDR slice header
	const lengthPrefixed = (...nalUnits: number[][]) => nalUnits.flatMap(x => [...u32(x.length), ...x]);
	const brokenUnit = [...u32(0x5dc72a9a), 0x5d, 0x11, 0x22, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x33, 0xff];
	const sei = [0x06, 0x05, 0x10, ...Array.from({ length: 16 }, (_, i) => 0x10 + i), 0x80];
	const sps = [0x67, 0x64, 0x00, 0x28, 0xac, 0xd9];

	using input = new Input({
		source: new BufferSource(await writeAvcFrames([
			[...lengthPrefixed(sei, [0x16, 0x01, 0x02]), ...brokenUnit],
			[...lengthPrefixed(sps), ...brokenUnit],
		])),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const sink = new EncodedPacketSink(track);

	const types: (string | null)[] = [];
	for await (const packet of sink.packets()) {
		types.push(await track.determinePacketType(packet));
	}
	expect(types).toEqual(['delta', 'delta']);
	expect(await sink.getFirstKeyPacket({ verifyKeyPackets: true })).toBe(null);
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
