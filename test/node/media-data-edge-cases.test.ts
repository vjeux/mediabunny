import { describe, expect, test } from 'vitest';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { EBMLId } from '../../src/matroska/ebml.js';
import { ebml, ebmlFloat, ebmlString, ebmlUint, mkvFile, mkvSimpleBlock } from './helpers/mutation-bytes.js';

describe('EncodedPacketSink verifyKeyPackets', () => {
	const vp9Frame = (frameType: number, showExisting = false) => {
		// frame_marker 10, profile 0, show_existing_frame, frame_type, then filler
		const first = 0b1000_0000 | (showExisting ? 0b1000 : 0) | (showExisting ? 0 : frameType << 2);
		return [first, 0x49, 0x83, 0x42, 0x00, 0x13, 0xf0, 0x0b, 0x30];
	};
	const bytes = mkvFile({
		trackEntries: [ebml(
			EBMLId.TrackEntry,
			ebmlUint(EBMLId.TrackNumber, 1),
			ebmlUint(EBMLId.TrackUID, 1),
			ebmlUint(EBMLId.TrackType, 1),
			ebmlString(EBMLId.CodecID, 'V_VP9'),
			ebml(EBMLId.Video, ebmlUint(EBMLId.PixelWidth, 320), ebmlUint(EBMLId.PixelHeight, 240)),
		)],
		rest: [ebml(
			EBMLId.Cluster,
			ebmlUint(EBMLId.Timestamp, 0),
			ebml(EBMLId.SimpleBlock, mkvSimpleBlock(1, 0, 0x80, vp9Frame(0))), // key, and really key
			ebml(EBMLId.SimpleBlock, mkvSimpleBlock(1, 40, 0x80, vp9Frame(1))), // claims key, is an inter frame
			ebml(EBMLId.SimpleBlock, mkvSimpleBlock(1, 80, 0x80, vp9Frame(0, true))), // claims key, can't tell
			ebml(EBMLId.SimpleBlock, mkvSimpleBlock(1, 120, 0x00, vp9Frame(0))), // claims delta, bitstream says key
		)],
	});

	test('key packets are checked against the bitstream; delta and undecidable packets keep their type', async () => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new EncodedPacketSink(track);

		const claimed = [];
		for await (const packet of sink.packets()) {
			claimed.push(packet.type);
		}
		expect(claimed).toEqual(['key', 'key', 'key', 'delta']);

		const verified = [];
		for await (const packet of sink.packets(undefined, undefined, { verifyKeyPackets: true })) {
			verified.push(packet.type);
		}
		expect(verified).toEqual(['key', 'delta', 'key', 'delta']);

		const options = { verifyKeyPackets: true };
		expect((await sink.getFirstPacket(options))!.type).toBe('key');
		const second = await sink.getPacket(0.04, options);
		expect(second!.type).toBe('delta');
		expect((await sink.getNextPacket(second!, options))!.type).toBe('key');
		expect((await sink.getPacket(0.12, options))!.type).toBe('delta');
	});

	test('verifyKeyPackets must be a boolean and cannot be combined with metadataOnly', async () => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new EncodedPacketSink(track);
		await expect(sink.getFirstPacket({ verifyKeyPackets: 1 as never })).rejects.toThrow(TypeError);
		await expect(sink.getFirstPacket({ verifyKeyPackets: true, metadataOnly: true })).rejects.toThrow(TypeError);
	});
});

describe('VideoSample from raw pixels: init validation', () => {
	const base = { format: 'RGBA' as const, codedWidth: 4, codedHeight: 2, timestamp: 0 };
	const data = new Uint8Array(4 * 2 * 4);

	test.each([
		['displayWidth 0', { displayWidth: 0, displayHeight: 2 }],
		['displayHeight 0', { displayWidth: 4, displayHeight: 0 }],
		['displayHeight -2', { displayWidth: 4, displayHeight: -2 }],
		['only displayWidth', { displayWidth: 4 }],
		['a null layout entry', { layout: [null] }],
		['a numeric layout entry', { layout: [16] }],
		['an array layout entry', { layout: [[0, 16]] }],
		['a negative stride', { layout: [{ offset: 0, stride: -16 }] }],
		['a fractional stride', { layout: [{ offset: 0, stride: 16.5 }] }],
		['a negative offset', { layout: [{ offset: -1, stride: 16 }] }],
		['a layout that is not an array', { layout: { offset: 0, stride: 16 } }],
		['a flip that is not a boolean', { flip: 1 }],
		['rotation 45', { rotation: 45 }],
		['an infinite timestamp', { timestamp: Infinity }],
		['a negative duration', { duration: -1 }],
		['codedWidth 0', { codedWidth: 0 }],
		['a fractional codedHeight', { codedHeight: 1.5 }],
		['an unknown format', { format: 'RGB24' }],
	])('rejects %s with a TypeError', (_, override) => {
		expect(() => new VideoSample(data, { ...base, ...override } as never)).toThrow(TypeError);
	});

	test('accepts zero strides and offsets, and stride equal to the row size', () => {
		using sample = new VideoSample(data, { ...base, layout: [{ offset: 0, stride: 16 }] });
		expect(sample.codedWidth).toBe(4);
		expect(sample.displayWidth).toBe(4);
		expect(sample.displayHeight).toBe(2);
	});

	test('init display sizes are the displayed (rotated) size; without them, rotation swaps the coded size', () => {
		using wide = new VideoSample(data, { ...base, displayWidth: 8, displayHeight: 2 });
		expect([wide.displayWidth, wide.displayHeight]).toEqual([8, 2]);
		expect([wide.squarePixelWidth, wide.squarePixelHeight]).toEqual([8, 2]);
		using rotated = new VideoSample(data, { ...base, displayWidth: 8, displayHeight: 2, rotation: 90 });
		expect([rotated.displayWidth, rotated.displayHeight]).toEqual([8, 2]);
		expect([rotated.squarePixelWidth, rotated.squarePixelHeight]).toEqual([2, 8]);
		using rotatedCoded = new VideoSample(data, { ...base, rotation: 270 });
		expect([rotatedCoded.displayWidth, rotatedCoded.displayHeight]).toEqual([2, 4]);
	});
});

describe('VideoSample from raw pixels: copyTo', () => {
	// 4x4 I420: 16 luma bytes, then 2x2 U and 2x2 V
	const i420 = new Uint8Array([...Array.from({ length: 16 }, (_, i) => i), 100, 101, 102, 103, 200, 201, 202, 203]);

	test('copies I420 planes tightly packed by default and reports their layout', async () => {
		using sample = new VideoSample(i420, { format: 'I420', codedWidth: 4, codedHeight: 4, timestamp: 0 });
		expect(sample.allocationSize()).toBe(24);
		const dest = new Uint8Array(24);
		const layout = await sample.copyTo(dest);
		expect(layout).toEqual([{ offset: 0, stride: 4 }, { offset: 16, stride: 2 }, { offset: 20, stride: 2 }]);
		expect([...dest]).toEqual([...i420]);
	});

	test('copies a sub-rectangle of every plane', async () => {
		using sample = new VideoSample(i420, { format: 'I420', codedWidth: 4, codedHeight: 4, timestamp: 0 });
		const rect = { x: 2, y: 2, width: 2, height: 2 };
		expect(sample.allocationSize({ rect })).toBe(6);
		const dest = new Uint8Array(6);
		const layout = await sample.copyTo(dest, { rect });
		expect(layout).toEqual([{ offset: 0, stride: 2 }, { offset: 4, stride: 1 }, { offset: 5, stride: 1 }]);
		expect([...dest]).toEqual([10, 11, 14, 15, 103, 203]);
	});

	test('honors a destination layout with padded strides', async () => {
		using sample = new VideoSample(i420, { format: 'I420', codedWidth: 4, codedHeight: 4, timestamp: 0 });
		const layout = [{ offset: 0, stride: 6 }, { offset: 24, stride: 3 }, { offset: 30, stride: 3 }];
		// Each plane spans stride * height bytes, padding of its last row included (WebCodecs allocation size)
		expect(sample.allocationSize({ layout })).toBe(36);
		const dest = new Uint8Array(36).fill(0xee);
		expect(await sample.copyTo(dest, { layout })).toEqual(layout);
		expect([...dest.subarray(0, 12)]).toEqual([0, 1, 2, 3, 0xee, 0xee, 4, 5, 6, 7, 0xee, 0xee]);
		expect([...dest.subarray(24, 30)]).toEqual([100, 101, 0xee, 102, 103, 0xee]);
		expect([...dest.subarray(30, 36)]).toEqual([200, 201, 0xee, 202, 203, 0xee]);
	});

	test.each([
		['RGBA', 'BGRA', [10, 20, 30, 40], [30, 20, 10, 40]],
		['BGRA', 'RGBA', [10, 20, 30, 40], [30, 20, 10, 40]],
		['RGBX', 'RGBA', [10, 20, 30, 40], [10, 20, 30, 255]],
		['BGRX', 'RGBA', [10, 20, 30, 40], [30, 20, 10, 255]],
		['RGBX', 'BGRX', [10, 20, 30, 40], [30, 20, 10, 40]],
		['RGBA', 'RGBX', [10, 20, 30, 40], [10, 20, 30, 40]],
	] as const)('copying %s pixels as %s swaps channels and fills alpha', async (from, to, pixel, expected) => {
		using sample = new VideoSample(new Uint8Array([...pixel, ...pixel]), {
			format: from,
			codedWidth: 2,
			codedHeight: 1,
			timestamp: 0,
		});
		const dest = new Uint8Array(8);
		await sample.copyTo(dest, { format: to });
		expect([...dest]).toEqual([...expected, ...expected]);
	});
});

describe('AudioSample copyTo and allocationSize validation', () => {
	// 4 frames of stereo f32 (interleaved): L0 R0 L1 R1 ...
	const makeSample = () => new AudioSample({
		data: new Float32Array([0, 10, 1, 11, 2, 12, 3, 13]),
		format: 'f32',
		numberOfChannels: 2,
		sampleRate: 48000,
		timestamp: 0,
	});

	test('an interleaved destination must hold every channel of every copied frame', () => {
		using sample = makeSample();
		expect(sample.allocationSize({ planeIndex: 0 })).toBe(32);
		// One byte short
		expect(() => sample.copyTo(new Uint8Array(31), { planeIndex: 0 })).toThrow(RangeError);
		// Big enough for the frames of one channel only
		expect(() => sample.copyTo(new Float32Array(4), { planeIndex: 0, format: 'f32' })).toThrow(RangeError);
		const exact = new Float32Array(8);
		sample.copyTo(exact, { planeIndex: 0, format: 'f32' });
		expect([...exact]).toEqual([0, 10, 1, 11, 2, 12, 3, 13]);
	});

	test('planar copies take one channel and check the plane index', () => {
		using sample = makeSample();
		const right = new Float32Array(4);
		sample.copyTo(right, { planeIndex: 1, format: 'f32-planar' });
		expect([...right]).toEqual([10, 11, 12, 13]);
		expect(sample.allocationSize({ planeIndex: 1, format: 'f32-planar' })).toBe(16);
		expect(() => sample.copyTo(new Float32Array(4), { planeIndex: 2, format: 'f32-planar' })).toThrow(RangeError);
		expect(() => sample.copyTo(new Float32Array(8), { planeIndex: 1, format: 'f32' })).toThrow(RangeError);
	});

	test('frameOffset and frameCount select a range and must stay inside the sample', () => {
		using sample = makeSample();
		const middle = new Float32Array(2);
		sample.copyTo(middle, { planeIndex: 0, format: 'f32-planar', frameOffset: 1, frameCount: 2 });
		expect([...middle]).toEqual([1, 2]);
		const tail = new Float32Array(2);
		sample.copyTo(tail, { planeIndex: 1, format: 'f32-planar', frameOffset: 2 });
		expect([...tail]).toEqual([12, 13]);
		expect(sample.allocationSize({ planeIndex: 0, format: 'f32-planar', frameOffset: 1, frameCount: 3 })).toBe(12);

		const options = { planeIndex: 0, format: 'f32-planar' as const };
		const big = new Float32Array(8);
		expect(() => sample.copyTo(big, { ...options, frameOffset: 1, frameCount: 4 })).toThrow(RangeError);
		expect(() => sample.copyTo(new Float32Array(8), { ...options, frameOffset: 4 })).toThrow(RangeError);
		expect(() => sample.copyTo(new Float32Array(8), { ...options, frameOffset: -1 })).toThrow(TypeError);
		expect(() => sample.copyTo(new Float32Array(8), { ...options, frameCount: -1 })).toThrow(TypeError);
		expect(() => sample.copyTo(new Float32Array(8), { ...options, frameCount: 1.5 })).toThrow(TypeError);
		expect(() => sample.allocationSize({ ...options, frameOffset: -1 })).toThrow(TypeError);
		expect(() => sample.allocationSize({ ...options, frameCount: -2 })).toThrow(TypeError);
	});

	test('copyTo and allocationSize reject non-object options and invalid formats', () => {
		using sample = makeSample();
		expect(() => sample.copyTo(new Float32Array(8), null as never)).toThrow(TypeError);
		expect(() => sample.copyTo(new Float32Array(8), 0 as never)).toThrow(TypeError);
		expect(() => sample.allocationSize(null as never)).toThrow(TypeError);
		expect(() => sample.allocationSize('x' as never)).toThrow(TypeError);
		expect(() => sample.copyTo(new Float32Array(8), { planeIndex: 0, format: 'f16' as never })).toThrow(TypeError);
		expect(() => sample.copyTo([] as never, { planeIndex: 0 })).toThrow(TypeError);
	});

	test('converts between sample formats when copying', () => {
		using sample = makeSample();
		const s16 = new Int16Array(4);
		sample.copyTo(s16, { planeIndex: 0, format: 's16-planar' });
		// Values above 1 clip to the largest sample
		expect([...s16]).toEqual([0, 32767, 32767, 32767]);
		const u8 = new Uint8Array(8);
		sample.copyTo(u8, { planeIndex: 0, format: 'u8' });
		expect(u8[0]).toBe(128);
	});
});

describe('AudioSampleSink ranges and timestamps on PCM audio', () => {
	// Four 10 ms blocks of 8 kHz mono 16-bit PCM at 0, 10, 20 and 30 ms
	const bytes = mkvFile({
		trackEntries: [ebml(
			EBMLId.TrackEntry,
			ebmlUint(EBMLId.TrackNumber, 1),
			ebmlUint(EBMLId.TrackUID, 1),
			ebmlUint(EBMLId.TrackType, 2),
			ebmlString(EBMLId.CodecID, 'A_PCM/INT/LIT'),
			ebml(
				EBMLId.Audio,
				ebmlFloat(EBMLId.SamplingFrequency, 8000),
				ebmlUint(EBMLId.Channels, 1),
				ebmlUint(EBMLId.BitDepth, 16),
			),
		)],
		rest: [ebml(
			EBMLId.Cluster,
			ebmlUint(EBMLId.Timestamp, 0),
			...[0, 10, 20, 30].map((t, i) => {
				return ebml(EBMLId.SimpleBlock, mkvSimpleBlock(1, t, 0x80, new Array(160).fill(i)));
			}),
		)],
	});

	const millis = async (samples: AsyncGenerator<AudioSample | null>) => {
		const result: (number | null)[] = [];
		for await (const sample of samples) {
			result.push(sample ? Math.round(sample.timestamp * 1000) : null);
			sample?.close();
		}
		return result;
	};

	test.each([
		[0.015, 0.025, [10, 20]],
		[0.015, undefined, [10, 20, 30]],
		[undefined, 0.025, [0, 10, 20]],
		[0.035, undefined, [30]],
		[0.05, undefined, [30]], // starts with the last sample at or before the start
		[0.01, 0.02, [10]],
		[0.02, 0.02, []],
		[0, 0.04, [0, 10, 20, 30]],
		[0, Infinity, [0, 10, 20, 30]],
	])('samples(%s, %s) yields the samples starting at %j ms', async (start, end, expected) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const sink = new AudioSampleSink((await input.getPrimaryAudioTrack())!);
		expect(await millis(sink.samples(start, end))).toEqual(expected);
	});

	test('samplesAtTimestamps and getSample return the sample covering each timestamp', async () => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const sink = new AudioSampleSink((await input.getPrimaryAudioTrack())!);
		expect(await millis(sink.samplesAtTimestamps([0.005, 0.005, 0.025, -1, 0.1, 0.0399, 0.012])))
			.toEqual([0, 0, 20, null, 30, 30, 10]);

		const sample = (await sink.getSample(0.012))!;
		expect([sample.timestamp, sample.numberOfFrames, sample.numberOfChannels, sample.sampleRate])
			.toEqual([0.01, 80, 1, 8000]);
		sample.close();
		expect(await sink.getSample(-0.5)).toBe(null);
		const last = (await sink.getSample(0.5))!;
		expect(last.timestamp).toBe(0.03);
		last.close();
	});
});
