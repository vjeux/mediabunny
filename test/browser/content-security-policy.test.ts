import { beforeAll, expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { WebMOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { CanvasSource, MediaStreamVideoTrackSource } from '../../src/media-source.js';
import { Quality } from '../../src/encode.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { EncodedPacketSink, CanvasSink, VideoSampleSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

// Pages with a Content Security Policy like this one (common on sites, and what browser extensions run under on
// third-party pages) can't start workers from blob: URLs. It applies to the whole page, hence this file of its own
beforeAll(() => {
	const meta = document.createElement('meta');
	meta.httpEquiv = 'Content-Security-Policy';
	meta.content = 'worker-src \'self\'';
	document.head.appendChild(meta);
});

const encodeTransparentVideo = async () => {
	const canvas = new OffscreenCanvas(64, 64);
	const context = canvas.getContext('2d')!;
	const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	const source = new CanvasSource(canvas, { codec: 'vp9', quality: new Quality('high'), alpha: 'keep' });
	output.addVideoTrack(source);
	await output.start();

	for (let i = 0; i < 5; i++) {
		context.clearRect(0, 0, 64, 64);
		context.fillStyle = 'red';
		context.fillRect(0, 0, 32, 64); // Left half opaque, right half transparent
		await source.add(i / 30, 1 / 30);
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	let alphaPacketCount = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		alphaPacketCount += packet.sideData.alpha ? 1 : 0;
	}

	return alphaPacketCount;
};

test('Transparent video encodes under a CSP without blob: workers', async () => {
	// The color/alpha splitter normally runs in a blob: worker, which fails to load here. It's only tried once per page
	const RealWorker = Worker;
	let workerCount = 0;
	globalThis.Worker = class extends RealWorker {
		constructor(...args: ConstructorParameters<typeof Worker>) {
			super(...args);
			workerCount++;
		}
	};

	try {
		expect(await encodeTransparentVideo()).toBe(5);
		expect(await encodeTransparentVideo()).toBe(5);
		expect(workerCount).toBe(1);
	} finally {
		globalThis.Worker = RealWorker;
	}
});

test('Transparent video decodes where the policy forbids blob: workers', async () => {
	// Merging color and alpha ran in blob: workers only, so every read of video with alpha failed with "Color/alpha
	// merge worker error." (the workers never load, which browsers report with an error event). The merge now runs on
	// the calling thread where the workers can't start (found by the lane L89 review).
	using input = new Input({ source: new UrlSource('/transparency.webm'), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	// Twice, as later sinks skip the workers right away
	for (let i = 0; i < 2; i++) {
		using sample = await new VideoSampleSink(track).getSample(0.5);
		assert(sample);
		expect(sample.hasAlpha).toBe(true);

		const canvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
		const context = canvas.getContext('2d');
		assert(context);
		sample.draw(context, 0, 0);
		expect(context.getImageData(0, 0, 1, 1).data[3]).toBeLessThan(255); // Transparent pixels
	}

	const wrappedCanvas = await new CanvasSink(track, { alpha: true }).getCanvas(0.5);
	assert(wrappedCanvas);
	expect(wrappedCanvas.canvas.width).toBe(1280);
	const canvasContext = (wrappedCanvas.canvas as OffscreenCanvas).getContext('2d');
	assert(canvasContext);
	expect(canvasContext.getImageData(0, 0, 1, 1).data[3]).toBeLessThan(255);
});

const settlesWithin = (promise: Promise<unknown>, ms: number) => Promise.race([
	promise.then(() => 'settled', () => 'settled'),
	new Promise<string>(resolve => setTimeout(() => resolve('pending'), ms)),
]);

// Records a canvas track for a second the way browsers without MediaStreamTrackProcessor on the main thread do
// (Safari for video, Firefox): they check for it in a blob: worker, and fall back to a <video> element ticked by a
// timer that also runs in a blob: worker
const recordWithoutMainThreadProcessor = async (frameRate: number | null) => {
	const canvas = document.createElement('canvas');
	canvas.width = 64;
	canvas.height = 64;
	const context = canvas.getContext('2d')!;
	let frame = 0;
	const interval = setInterval(() => {
		context.fillStyle = `rgb(${(frame++ * 10) % 256}, 0, 0)`;
		context.fillRect(0, 0, 64, 64);
	}, 16);
	const track = canvas.captureStream(30).getVideoTracks()[0]!;
	const globals = globalThis as Record<string, unknown>;
	const processor = globals['MediaStreamTrackProcessor'];
	delete globals['MediaStreamTrackProcessor'];

	try {
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const source = new MediaStreamVideoTrackSource(
			track,
			{ codec: 'vp9', quality: new Quality('medium') },
			{ frameRate },
		);
		source.errorPromise.catch(() => {});
		output.addVideoTrack(source);

		const start = output.start();
		const startState = await settlesWithin(start, 3000);
		if (startState === 'pending' || !(await start.then(() => true, () => false))) {
			return { startState, cancelState: await settlesWithin(output.cancel(), 2000), packetCount: 0 };
		}

		await new Promise(resolve => setTimeout(resolve, 1000));
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);
		let packetCount = 0;
		for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
			packetCount += packet ? 1 : 0;
		}

		return { startState, cancelState: 'not needed', packetCount };
	} finally {
		globals['MediaStreamTrackProcessor'] = processor;
		clearInterval(interval);
		track.stop();
	}
};

test('MediaStreamVideoTrackSource without a frame rate fails cleanly without blob: workers', async () => {
	// No MediaStreamTrackProcessor anywhere then, which must reject rather than hang the output
	const { startState, cancelState } = await recordWithoutMainThreadProcessor(null);
	expect(startState).toBe('settled');
	expect(cancelState).toBe('settled');
});

test('MediaStreamVideoTrackSource with a frame rate records via <video> without blob: workers', async () => {
	const { packetCount } = await recordWithoutMainThreadProcessor(30);
	expect(packetCount).toBeGreaterThan(20);
});
