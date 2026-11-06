import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { CanvasSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { WebMOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { CanvasSource, VideoSampleSource } from '../../src/media-source.js';
import { canEncodeVideo, Quality } from '../../src/encode.js';
import { VideoSample } from '../../src/sample.js';
import { Conversion } from '../../src/conversion.js';
import { isFirefox } from '../../src/misc.js';

const decodeTransparentVideoTest = async () => {
	using input = new Input({
		source: new UrlSource('/transparency.webm'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.canBeTransparent()).toBe(true);

	const sink = new VideoSampleSink(videoTrack);
	using sample = (await sink.getSample(0.5))!;

	expect(sample.format).toContain('A'); // Probably RGBA
	expect(sample.hasAlpha).toBe(true);

	const canvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
	const context = canvas.getContext('2d')!;

	sample.draw(context, 0, 0);

	const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
	expect(imageData.data[3]).toBeLessThan(255); // Check that there's actually transparent pixels
};

test('Can decode transparent video', async () => {
	await decodeTransparentVideoTest();
});

test('Can decode faulty transparent video and behaves gracefully', async () => {
	using input = new Input({
		source: new UrlSource('/transparency-faulty.webm'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const packetSink = new EncodedPacketSink(videoTrack);
	const secondKeyPacket = (await packetSink.getNextKeyPacket((await packetSink.getFirstPacket())!))!;

	const sink = new VideoSampleSink(videoTrack);

	using startSample = (await sink.getSample(await videoTrack.getFirstTimestamp()))!;
	expect(startSample.format).toContain('A');

	using secondSample = (await sink.getSample(secondKeyPacket.timestamp))!;
	expect(secondSample.format).not.toContain('A'); // There was no alpha key frame for this one
	expect(secondSample.hasAlpha).toBe(false);
});

test('Can extract transparent frames via CanvasSink', async () => {
	using input = new Input({
		source: new UrlSource('/transparency.webm'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const sink = new CanvasSink(videoTrack, { alpha: true });
	const wrappedCanvas = (await sink.getCanvas(await videoTrack.getFirstTimestamp()))!;

	const canvas = new OffscreenCanvas(wrappedCanvas.canvas.width, wrappedCanvas.canvas.height);
	const context = canvas.getContext('2d')!;
	context.drawImage(wrappedCanvas.canvas, 0, 0);

	let imageData = context.getImageData(0, 0, canvas.width, canvas.height);
	expect(imageData.data[3]).toBeLessThan(255); // Check that there's actually transparent pixels

	const opaqueSink = new CanvasSink(videoTrack); // Default is alpha: false
	const opaqueWrappedCanvas = (await opaqueSink.getCanvas(await videoTrack.getFirstTimestamp()))!;

	context.drawImage(opaqueWrappedCanvas.canvas, 0, 0);

	imageData = context.getImageData(0, 0, canvas.width, canvas.height);
	expect(imageData.data[3]).toBe(255);
});

const encodeTransparentVideoTest = async () => {
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const canvas = new OffscreenCanvas(1280, 720);
	const context = canvas.getContext('2d')!;

	const source = new CanvasSource(canvas, {
		codec: 'vp9',
		quality: new Quality('high'),
		alpha: 'keep',
	});
	output.addVideoTrack(source);

	await output.start();

	context.fillStyle = '#ff0000';
	context.fillRect(200, 200, 200, 200);
	await source.add(0, 1);

	context.fillStyle = '#00ff00';
	context.fillRect(300, 300, 200, 200);
	await source.add(1, 1);

	context.fillStyle = '#0000ff';
	context.fillRect(400, 400, 200, 200);
	await source.add(2, 1);

	await output.finalize();

	const blob = new Blob([output.target.buffer!], {
		type: output.format.mimeType,
	});
	const url = URL.createObjectURL(blob);

	const video = document.createElement('video');
	video.src = url;
	video.muted = true;
	void video.play();

	await new Promise(resolve => video.addEventListener('loadeddata', resolve));

	// Let the video play for a little bit to prevent flake
	while (video.currentTime < 0.1) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}

	expect(video.videoWidth).toBe(1280);
	expect(video.videoHeight).toBe(720);

	const probeCanvas = new OffscreenCanvas(1280, 720);
	const probeContext = probeCanvas.getContext('2d')!;

	probeContext.drawImage(video, 0, 0);

	let imageData = probeContext.getImageData(0, 0, probeCanvas.width, probeCanvas.height);
	const pos1 = { x: 100, y: 100 };
	const index1 = (pos1.x + pos1.y * probeCanvas.width) * 4;
	expect(imageData.data[index1 + 3]).toBe(0); // Transparent

	const pos2 = { x: 300, y: 300 }; // Dead center in the red square
	const index2 = (pos2.x + pos2.y * probeCanvas.width) * 4;

	// Red (within error)
	expect(imageData.data[index2 + 0]).greaterThanOrEqual(253);
	expect(imageData.data[index2 + 1]).lessThanOrEqual(3);
	expect(imageData.data[index2 + 2]).lessThanOrEqual(3);

	expect(imageData.data[index2 + 3]).toBe(255); // Opaque

	// Let's also check it's read correctly by Mediabunny
	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.canBeTransparent()).toBe(true);

	const sink = new VideoSampleSink(videoTrack);

	using firstSample = (await sink.getSample(0))!;
	expect(firstSample.format).toContain('A');

	probeContext.clearRect(0, 0, probeCanvas.width, probeCanvas.height);
	firstSample.draw(probeContext, 0, 0);

	imageData = probeContext.getImageData(0, 0, probeCanvas.width, probeCanvas.height);

	expect(imageData.data[4 * (2 * probeCanvas.width + 2) + 3]).toBe(0); // Transparent
};

test('Can encode transparent video', async () => {
	await encodeTransparentVideoTest();
});

test('Can encode video with alternating transparency', async () => {
	// This test is already brutal when it comes to finding async race conditions, so run it thrice to be MORE brutal
	for (let j = 0; j < 3; j++) {
		const output = new Output({
			format: new WebMOutputFormat(),
			target: new BufferTarget(),
		});

		const canvas1 = new OffscreenCanvas(640, 480);
		const context1 = canvas1.getContext('2d', { alpha: true })!;
		context1.fillStyle = '#ff000080';
		context1.fillRect(0, 0, canvas1.width, canvas1.height);

		const canvas2 = new OffscreenCanvas(640, 480);
		const context2 = canvas2.getContext('2d', { alpha: false })!;
		context2.fillStyle = '#0000ff';
		context2.fillRect(0, 0, canvas2.width, canvas2.height);

		const source = new VideoSampleSource({
			codec: 'vp9',
			quality: new Quality('high'),
			alpha: 'keep',
		});
		output.addVideoTrack(source);

		await output.start();

		for (let i = 0; i < 64; i++) {
			using sample = new VideoSample(new Uint8Array(640 * 480 * 4), {
				format: i % 2 ? 'RGBX' : 'RGBA',
				codedWidth: 640,
				codedHeight: 480,
				timestamp: i,
				duration: 1,
			});
			await source.add(sample);
		}

		await output.finalize();

		using input = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});

		const videoTrack = (await input.getPrimaryVideoTrack())!;
		const packetSink = new EncodedPacketSink(videoTrack);

		let i = 0;
		for await (const packet of packetSink.packets()) {
			if (i % 2) {
				expect(packet.sideData.alpha).toBeUndefined();
			} else {
				expect(packet.sideData.alpha).toBeDefined();
			}

			i++;
		}

		const sampleSink = new VideoSampleSink(videoTrack);

		i = 0;
		for await (using sample of sampleSink.samples()) {
			if (i % 2) {
				expect(sample.format).not.toContain('A');
			} else {
				expect(sample.format).toContain('A');
			}

			i++;
		}
	}
});

test('Can encode transparent video with odd dimensions', async () => {
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const canvas = new OffscreenCanvas(641, 479);
	const context = canvas.getContext('2d', { alpha: true })!;
	context.fillStyle = '#ff000080';
	context.fillRect(0, 0, canvas.width, canvas.height);

	const source = new CanvasSource(canvas, {
		codec: 'vp9',
		quality: new Quality('high'),
		alpha: 'keep',
	});
	output.addVideoTrack(source);

	await output.start();
	await source.add(0, 1);
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.getDisplayWidth()).toBe(641);
	expect(await videoTrack.getDisplayHeight()).toBe(479);
	expect(await videoTrack.canBeTransparent()).toBe(true);

	using sample = (await new VideoSampleSink(videoTrack).getSample(0))!;
	expect(sample.hasAlpha).toBe(true);

	// The last row and column keep their alpha too
	const readbackContext = new OffscreenCanvas(641, 479).getContext('2d')!;
	sample.draw(readbackContext, 0, 0);
	expect(readbackContext.getImageData(640, 478, 1, 1).data[3]).toBeGreaterThan(100);
});

test('Can encode transparent YUV frames with odd dimensions', async () => {
	// Decoders (like the ProRes one) hand out I420A frames with a padded coded size and an odd visible rect
	const width = 161;
	const height = 91;
	const codedWidth = 176;
	const codedHeight = 96;
	const lumaSize = codedWidth * codedHeight;
	const chromaSize = (codedWidth / 2) * (codedHeight / 2);
	const data = new Uint8Array(2 * lumaSize + 2 * chromaSize);
	data.fill(81, 0, lumaSize); // Red
	data.fill(90, lumaSize, lumaSize + chromaSize);
	data.fill(240, lumaSize + chromaSize, lumaSize + 2 * chromaSize);
	data.fill(160, lumaSize + 2 * chromaSize); // Alpha

	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new VideoSampleSource({
		codec: 'vp9',
		quality: new Quality('high'),
		alpha: 'keep',
	});
	output.addVideoTrack(source);
	await output.start();

	const frame = new VideoFrame(data, {
		format: 'I420A',
		codedWidth,
		codedHeight,
		visibleRect: { x: 0, y: 0, width, height },
		timestamp: 0,
		duration: 1e6,
	});
	using inputSample = new VideoSample(frame);
	await source.add(inputSample);
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.getDisplayWidth()).toBe(width);
	expect(await videoTrack.getDisplayHeight()).toBe(height);

	using sample = (await new VideoSampleSink(videoTrack).getSample(0))!;
	expect(sample.hasAlpha).toBe(true);

	// Including the last row and column. Read through copyTo, as Firefox draws non-opaque RGBA frames with wrong colors
	// (https://bugzilla.mozilla.org/show_bug.cgi?id=2079836)
	const pixels = new Uint8Array(width * height * 4);
	await sample.copyTo(pixels, { format: 'RGBA' });
	const [red, green, , alpha] = pixels.subarray(pixels.length - 4);
	expect(alpha).toBeGreaterThan(130);
	expect(alpha).toBeLessThan(190);
	expect(red).toBeGreaterThan(150);
	expect(green).toBeLessThan(80);
});

test('Positive encodability check with alpha', async () => {
	const result = await canEncodeVideo('vp9', { alpha: 'keep' });
	expect(result).toBe(true);
});

test('Can transmux transparent video, discards alpha by default', async () => {
	using input = new Input({
		source: new UrlSource('/transparency.webm'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
	});
	await conversion.execute();

	using outputInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await outputInput.getPrimaryVideoTrack())!;
	expect(await videoTrack.canBeTransparent()).toBe(false);

	const sink = new VideoSampleSink(videoTrack);
	using sample = (await sink.getSample(await videoTrack.getFirstTimestamp()))!;
	expect(sample.hasAlpha).toBe(false);
});

test('Can transmux transparent video, can keep alpha', async () => {
	using input = new Input({
		source: new UrlSource('/transparency.webm'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			alpha: 'keep',
		},
	});
	await conversion.execute();

	using outputInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await outputInput.getPrimaryVideoTrack())!;
	expect(await videoTrack.canBeTransparent()).toBe(true);

	const sink = new VideoSampleSink(videoTrack);
	using sample = (await sink.getSample(await videoTrack.getFirstTimestamp()))!;
	expect(sample.format).toContain('A');
	expect(sample.hasAlpha).toBe(true);
});

test('Can reencode transparent video, keeping alpha', async () => {
	using input = new Input({
		source: new UrlSource('/transparency.webm'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			width: 320,
			alpha: 'keep',
		},
		trim: {
			start: 0,
			end: 0.5,
		},
	});
	await conversion.execute();

	using outputInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await outputInput.getPrimaryVideoTrack())!;
	expect(await videoTrack.canBeTransparent()).toBe(true);
	expect(await videoTrack.getDisplayWidth()).toBe(320);

	const sink = new VideoSampleSink(videoTrack);
	using sample = (await sink.getSample(await videoTrack.getFirstTimestamp()))!;
	expect(sample.format).toContain('A');
	expect(sample.hasAlpha).toBe(true);
});

// Firefox's encoder always reports BT.709 limited range, whatever it encodes:
// https://bugzilla.mozilla.org/show_bug.cgi?id=2056028
test.skipIf(isFirefox())('Encoding planar YUV frames with alpha keeps their color space', async () => {
	// BT.601 full-range I420A frames, which take the CPU color/alpha splitting path
	const width = 64;
	const height = 64;
	const data = new Uint8Array(width * height * 2.5).fill(128);

	const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	let colorSpace: VideoColorSpaceInit | undefined;
	const videoSource = new VideoSampleSource({
		codec: 'vp9',
		quality: new Quality('high'),
		alpha: 'keep',
		onEncodedPacket: (packet, meta) => {
			colorSpace ??= meta?.decoderConfig?.colorSpace;
		},
	});
	output.addVideoTrack(videoSource);
	await output.start();

	for (let i = 0; i < 3; i++) {
		using sample = new VideoSample(data, {
			format: 'I420A',
			codedWidth: width,
			codedHeight: height,
			timestamp: i / 10,
			duration: 1 / 10,
			colorSpace: { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: true },
		});
		await videoSource.add(sample);
	}

	await output.finalize();

	expect(colorSpace).toMatchObject({ matrix: 'smpte170m', fullRange: true });
});
