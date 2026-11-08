import { beforeAll, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { CanvasSink, VideoSampleSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

// The policy applies to the whole page, so it gets a file of its own
beforeAll(() => {
	const meta = document.createElement('meta');
	meta.httpEquiv = 'Content-Security-Policy';
	meta.content = 'worker-src \'self\'';
	document.head.appendChild(meta);
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
