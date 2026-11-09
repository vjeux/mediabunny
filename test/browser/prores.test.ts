import { afterEach, expect, test } from 'vitest';
import { registerProresDecoder } from '@mediabunny/prores';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { VideoSampleSink } from '../../src/media-sink.js';

// ffmpeg -f lavfi -i testsrc2=s=64x32:r=10:d=0.2 -c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le
//   -fflags +bitexact -flags:v +bitexact prores-422hq-64x32.mov
const FIXTURE = '/prores-422hq-64x32.mov';

const realHardwareConcurrency = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency')!;

const setHardwareConcurrency = (value: number) => {
	Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => value, configurable: true });
};

afterEach(() => {
	Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', realHardwareConcurrency);
});

// TurboRes keeps its workers around for the whole page, so the order of these tests matters: the first one starts
// the workers.
const decodeFirstFrame = async () => {
	using input = new Input({ source: new UrlSource(FIXTURE), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	using sample = (await new VideoSampleSink(track).getSample(0))!;
	return `${sample.codedWidth}x${sample.codedHeight}`;
};

const withTimeout = async <T>(promise: Promise<T>, ms: number) => {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error('ProRes decoding hung.')), ms);
			}),
		]);
	} finally {
		clearTimeout(timeoutId);
	}
};

test('ProRes decoding works for several files at once', { timeout: 20_000 }, async () => {
	registerProresDecoder();

	// Like an editor showing 8 ProRes clips side by side on a 16-thread machine
	setHardwareConcurrency(16);

	const results = await withTimeout(Promise.all([...Array(8).keys()].map(() => decodeFirstFrame())), 10_000);
	expect(results).toEqual(Array(8).fill('64x32'));
});

test('ProRes decoding works on machines with many cores', { timeout: 20_000 }, async () => {
	registerProresDecoder();

	// Like a 96-core/192-thread workstation
	setHardwareConcurrency(192);

	expect(await withTimeout(decodeFirstFrame(), 10_000)).toBe('64x32');
});
