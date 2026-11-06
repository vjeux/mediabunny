import { describe, expect, test } from 'vitest';
import { AudioSample, VideoSample } from '../../src/sample.js';

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
