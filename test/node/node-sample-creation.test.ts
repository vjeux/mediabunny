import { expect, test } from 'vitest';
import {
	AudioSample,
	VideoSample,
	VideoSampleColorSpace,
	VideoSampleInit,
	VideoSampleResource,
} from '../../src/sample.js';
import { SetRequired } from '../../src/misc.js';

test('VideoSample creation from bytes', async () => {
	const bytes = new Uint8Array(1024);
	const sample = new VideoSample(bytes, {
		codedWidth: 1280,
		codedHeight: 720,
		format: 'RGBA',
		timestamp: 0,
	});

	sample.close();
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
