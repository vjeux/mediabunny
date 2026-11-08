import { expect, test } from 'vitest';
import {
	AudioSample,
	VideoSample,
	VideoSampleColorSpace,
	VideoSampleInit,
	VideoSampleResource,
} from '../../src/sample.js';
import { SetRequired } from '../../src/misc.js';
import { EncodedPacket } from '../../src/packet.js';

test('VideoSample creation from bytes', async () => {
	const bytes = new Uint8Array(1280 * 720 * 4);
	const sample = new VideoSample(bytes, {
		codedWidth: 1280,
		codedHeight: 720,
		format: 'RGBA',
		timestamp: 0,
	});

	sample.close();
});

test('VideoSample creation from bytes rejects data that doesn\'t fit its plane layout', () => {
	const rgba = { format: 'RGBA', codedWidth: 4, codedHeight: 2, timestamp: 0 } as const;
	const i420 = { format: 'I420', codedWidth: 4, codedHeight: 4, timestamp: 0 } as const;

	// A stride given in pixels instead of bytes
	expect(() => new VideoSample(new Uint8Array(32), { ...rgba, layout: [{ offset: 0, stride: 4 }] }))
		.toThrow(TypeError);
	// Overlapping planes
	expect(() => new VideoSample(new Uint8Array(24), {
		...i420,
		layout: [{ offset: 0, stride: 4 }, { offset: 12, stride: 2 }, { offset: 20, stride: 2 }],
	})).toThrow(TypeError);
	// Too little data
	expect(() => new VideoSample(new Uint8Array(31), rgba)).toThrow(TypeError);
	expect(() => new VideoSample(new Uint8Array(32), { ...rgba, layout: [{ offset: 1, stride: 16 }] }))
		.toThrow(TypeError);

	// Padding, gaps and reordered planes are fine
	new VideoSample(new Uint8Array(40), { ...rgba, layout: [{ offset: 2, stride: 18 }] }).close();
	new VideoSample(new Uint8Array(26), {
		...i420,
		layout: [{ offset: 10, stride: 4 }, { offset: 0, stride: 2 }, { offset: 5, stride: 2 }],
	}).close();
});

test('AudioSample creation from bytes', async () => {
	const bytes = new Uint8Array(1024);
	const sample = new AudioSample({
		data: bytes,
		numberOfChannels: 2,
		format: 's16',
		sampleRate: 48000,
		timestamp: 0,
	});

	sample.close();
});

test('VideoSampleResource RGB output is copied without converting its color space again', async () => {
	// toRgbSample() converts into the requested color space, so its result must be copied as it is
	const requested: PredefinedColorSpace[] = [];
	class YuvResource extends VideoSampleResource {
		getFormat() {
			return 'I420' as const;
		}

		getCodedWidth() {
			return 2;
		}

		getCodedHeight() {
			return 2;
		}

		getSquarePixelWidth() {
			return 2;
		}

		getSquarePixelHeight() {
			return 2;
		}

		getColorSpace() {
			return new VideoSampleColorSpace();
		}

		getDataPlanes() {
			return [
				{ data: new Uint8Array(4), stride: 2 },
				{ data: new Uint8Array(1), stride: 1 },
				{ data: new Uint8Array(1), stride: 1 },
			];
		}

		toRgbSample(init: SetRequired<VideoSampleInit, 'timestamp'>, colorSpace: PredefinedColorSpace) {
			requested.push(colorSpace);
			const pixel = [200, 100, 50, 255];
			return new VideoSample(new Uint8Array([...pixel, ...pixel, ...pixel, ...pixel]), {
				...init, format: 'RGBA', codedWidth: 2, codedHeight: 2,
			});
		}

		close() {}
	}

	using sample = new VideoSample(new YuvResource(), { timestamp: 0 });
	const bytes = new Uint8Array(16);
	await sample.copyTo(bytes, { format: 'BGRX', colorSpace: 'display-p3' });
	expect(requested).toEqual(['display-p3']);
	expect([...bytes.subarray(0, 4)]).toEqual([50, 100, 200, 255]);
});

test('Raw RGB data is copied as it is where VideoFrame can\'t convert color spaces', async () => {
	using sample = new VideoSample(new Uint8Array([200, 100, 50, 255, 0, 255, 0, 255]), {
		format: 'RGBA',
		codedWidth: 2,
		codedHeight: 1,
		timestamp: 0,
	});

	// Node has no VideoFrame to convert with, so the pixels keep their colors and only get their channels reordered
	const bytes = new Uint8Array(8);
	await sample.copyTo(bytes, { format: 'BGRA', colorSpace: 'display-p3' });
	expect([...bytes]).toEqual([50, 100, 200, 255, 0, 255, 0, 255]);
});

test('Missing data is rejected with the intended TypeError', () => {
	for (const data of [undefined, null]) {
		expect(() => new EncodedPacket(data as never, 'key', 0, 0)).toThrow(
			new TypeError('data must be a Uint8Array.'),
		);
		expect(() => new AudioSample({
			data: data as never,
			format: 's16',
			numberOfChannels: 2,
			sampleRate: 48000,
			timestamp: 0,
		})).toThrow(new TypeError('Invalid AudioDataInit: data is not a BufferSource.'));
	}
});
