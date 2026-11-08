import { expect, test, TestContext } from 'vitest';
import { vp9EncoderKeepsRed } from './helpers/platform-probes.js';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { CanvasSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, WebMOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { CanvasSource, VideoSampleSource } from '../../src/media-source.js';
import { canEncodeVideo, Quality } from '../../src/encode.js';
import { VideoSample } from '../../src/sample.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';

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

const encodeTransparentVideoTest = async (annotate: TestContext['annotate']) => {
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

	// Red (within error), where the platform's own VP9 encoder keeps red that exact
	if (await vp9EncoderKeepsRed()) {
		expect(imageData.data[index2 + 0]).greaterThanOrEqual(253);
		expect(imageData.data[index2 + 1]).lessThanOrEqual(3);
		expect(imageData.data[index2 + 2]).lessThanOrEqual(3);
	} else {
		await annotate('Colors not checked: the platform\'s VP9 encoder doesn\'t keep red that exact (native probe)');
	}

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

test('Can encode transparent video', async ({ annotate }) => {
	await encodeTransparentVideoTest(annotate);
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

test('Can encode video that turns transparent after opaque frames', async () => {
	// The track's alpha mode is written before the later frames are known, so the first, opaque frame mustn't decide it
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

	for (let i = 0; i < 8; i++) {
		using sample = new VideoSample(new Uint8Array(64 * 48 * 4).fill(128), {
			format: i === 0 ? 'RGBX' : 'RGBA',
			codedWidth: 64,
			codedHeight: 48,
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
	expect(await videoTrack.canBeTransparent()).toBe(true);

	const withAlpha: boolean[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		withAlpha.push(packet.sideData.alpha !== undefined);
	}
	expect(withAlpha).toEqual([false, true, true, true, true, true, true, true]);

	const formatsWithAlpha: boolean[] = [];
	for await (using sample of new VideoSampleSink(videoTrack).samples()) {
		formatsWithAlpha.push(sample.format!.includes('A'));
	}
	expect(formatsWithAlpha).toEqual(withAlpha);
});

/**
 * Encodes a frame with alpha, decodes it again and reads it back through a canvas: the size, and the pixels in the
 * middle and at the edges (top right, bottom left, bottom right).
 */
const roundTripTransparentFrame = async (makeSample: () => VideoSample) => {
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
	using inputSample = makeSample();
	await source.add(inputSample);
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const width = await videoTrack.getDisplayWidth();
	const height = await videoTrack.getDisplayHeight();

	using sample = (await new VideoSampleSink(videoTrack).getSample(0))!;
	const context = new OffscreenCanvas(width, height).getContext('2d')!;
	sample.draw(context, 0, 0);
	const pixel = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data];

	return {
		width,
		height,
		canBeTransparent: await videoTrack.canBeTransparent(),
		hasAlpha: sample.hasAlpha,
		middle: pixel(width >> 1, height >> 1),
		edges: [pixel(width - 1, 0), pixel(0, height - 1), pixel(width - 1, height - 1)],
	};
};

// The edges of an odd-sized frame must come out like those of an even-sized one. Compared with that rather than with
// fixed values, since some platforms already lose the bottom rows of transparent frames when decoding them (WebKitGTK),
// and Firefox draws non-opaque frames with wrong colors (https://bugzilla.mozilla.org/show_bug.cgi?id=2079836).
const expectSameEdges = (odd: number[][], even: number[][]) => {
	for (let i = 0; i < odd.length; i++) {
		for (let channel = 0; channel < 4; channel++) {
			expect(Math.abs(odd[i]![channel]! - even[i]![channel]!), `edge ${i}, channel ${channel}`).toBeLessThan(16);
		}
	}
};

test('Can encode transparent video with odd dimensions', async () => {
	const makeCanvasSample = (width: number, height: number) => () => {
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d', { alpha: true })!;
		context.fillStyle = '#ff000080';
		context.fillRect(0, 0, width, height);
		return new VideoSample(canvas, { timestamp: 0, duration: 1 });
	};

	const odd = await roundTripTransparentFrame(makeCanvasSample(641, 479));
	expect([odd.width, odd.height]).toEqual([641, 479]);
	expect(odd.canBeTransparent).toBe(true);
	expect(odd.hasAlpha).toBe(true);
	expect(odd.middle[3]).toBeGreaterThan(100);
	expect(odd.middle[3]).toBeLessThan(160);

	const even = await roundTripTransparentFrame(makeCanvasSample(640, 480));
	expectSameEdges(odd.edges, even.edges);
});

test('Can encode transparent YUV frames with odd dimensions', async () => {
	// Decoders (like the ProRes one) hand out I420A frames with a padded coded size and a visible rect
	const makeYuvaSample = (width: number, height: number) => () => {
		const codedWidth = 176;
		const codedHeight = 96;
		const lumaSize = codedWidth * codedHeight;
		const chromaSize = (codedWidth / 2) * (codedHeight / 2);
		const data = new Uint8Array(2 * lumaSize + 2 * chromaSize);
		data.fill(81, 0, lumaSize); // Red
		data.fill(90, lumaSize, lumaSize + chromaSize);
		data.fill(240, lumaSize + chromaSize, lumaSize + 2 * chromaSize);
		data.fill(160, lumaSize + 2 * chromaSize); // Alpha

		return new VideoSample(new VideoFrame(data, {
			format: 'I420A',
			codedWidth,
			codedHeight,
			visibleRect: { x: 0, y: 0, width, height },
			timestamp: 0,
			duration: 1e6,
		}));
	};

	const odd = await roundTripTransparentFrame(makeYuvaSample(161, 91));
	expect([odd.width, odd.height]).toEqual([161, 91]);
	expect(odd.canBeTransparent).toBe(true);
	expect(odd.hasAlpha).toBe(true);
	expect(odd.middle[3]).toBeGreaterThan(130);
	expect(odd.middle[3]).toBeLessThan(190);
	expect(odd.middle[0]).toBeGreaterThan(odd.middle[1]! + 50); // Still red

	const even = await roundTripTransparentFrame(makeYuvaSample(160, 90));
	expectSameEdges(odd.edges, even.edges);
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

// Whether this browser's VP9 encoder reports the color space of the frames it encodes. Decided with WebCodecs alone:
// a BT.601 full-range I420 frame must come back with that color space in the decoder config (Firefox's encoder always
// reports BT.709 limited range, https://bugzilla.mozilla.org/show_bug.cgi?id=2056028, and WebKitGTK's doesn't match
// either)
const vp9EncoderKeepsColorSpace = await (async () => {
	const encoderConfig = { codec: 'vp09.00.10.08', width: 64, height: 64, bitrate: 1e6 };
	if (!(await VideoEncoder.isConfigSupported(encoderConfig)).supported) {
		return false;
	}

	let colorSpace: VideoColorSpaceInit | undefined;
	const encoder = new VideoEncoder({
		output: (chunk, meta) => {
			colorSpace ??= meta?.decoderConfig?.colorSpace;
		},
		error: () => {},
	});
	encoder.configure(encoderConfig);
	const frame = new VideoFrame(new Uint8Array(64 * 64 * 1.5).fill(128), {
		format: 'I420',
		codedWidth: 64,
		codedHeight: 64,
		timestamp: 0,
		colorSpace: { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: true },
	});
	encoder.encode(frame, { keyFrame: true });
	frame.close();
	await encoder.flush();
	encoder.close();

	return colorSpace?.matrix === 'smpte170m' && colorSpace.fullRange === true;
})();

test.skipIf(!vp9EncoderKeepsColorSpace)('Encoding planar YUV frames with alpha keeps their color space', async () => {
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

test('Encoding semi-transparent canvas content keeps the colors unpremultiplied', async ({ skip }) => {
	// WebKitGTK's VideoFrame.copyTo() returns YUV planes unconverted when asked for RGBA, so the colors can't be read
	// back there. This probes the browser itself, not Mediabunny.
	const probe = new VideoFrame(new Uint8Array([235, 235, 235, 235, 128, 128]), {
		format: 'I420',
		codedWidth: 2,
		codedHeight: 2,
		timestamp: 0,
	});
	const probeRgba = new Uint8Array(16);
	await probe.copyTo(probeRgba, { format: 'RGBA' }).catch(() => {});
	probe.close();
	skip(probeRgba[3] !== 255, 'VideoFrame.copyTo() does not convert YUV to RGBA here');

	const canvas = new OffscreenCanvas(64, 32);
	const context = canvas.getContext('2d')!;
	context.fillStyle = 'rgba(255, 64, 0, 0.5)';
	context.fillRect(0, 0, 32, 32);
	context.fillStyle = 'rgba(0, 128, 255, 0.25)';
	context.fillRect(32, 0, 32, 32);

	// Decodes only the color stream, which must hold the straight colors (the alpha stream is applied on top)
	const readColors = async (buffer: ArrayBuffer) => {
		using input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
		const videoTrack = (await input.getPrimaryVideoTrack())!;
		const packet = (await new EncodedPacketSink(videoTrack).getFirstPacket())!;
		expect(packet.sideData.alpha).toBeDefined();

		const decoderConfig = (await videoTrack.getDecoderConfig())!;
		const decoded = await new Promise<VideoFrame>((resolve, reject) => {
			const decoder = new VideoDecoder({ output: resolve, error: reject });
			decoder.configure(decoderConfig);
			decoder.decode(packet.toEncodedVideoChunk());
			void decoder.flush();
		});
		const data = new Uint8Array(decoded.allocationSize({ format: 'RGBA' }));
		await decoded.copyTo(data, { format: 'RGBA' });
		const width = decoded.visibleRect!.width;
		const row = Math.floor(decoded.visibleRect!.height / 2);
		decoded.close();

		const pixelAt = (x: number) => Array.from(data.subarray((row * width + x) * 4, (row * width + x) * 4 + 3));
		return [pixelAt(width / 4), pixelAt(3 * width / 4)];
	};
	// The saturated channel shows it best: premultiplied, it would read 128 and 64 instead of 255
	const expectStraightColors = ([left, right]: number[][]) => {
		expect(left![0], left!.join()).toBeGreaterThanOrEqual(240);
		expect(right![2], right!.join()).toBeGreaterThanOrEqual(240);
	};

	// Recording the canvas
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new CanvasSource(canvas, { codec: 'vp9', bitrate: 8e6, alpha: 'keep' });
	output.addVideoTrack(source);
	await output.start();
	await source.add(0, 1);
	await output.finalize();

	expectStraightColors(await readColors(output.target.buffer!));

	// Resizing in a conversion, which draws the frames onto a canvas
	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const resizedOutput = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const conversion = await Conversion.init({
		input,
		output: resizedOutput,
		video: { width: 32, bitrate: 8e6, alpha: 'keep' },
	});
	await conversion.execute();

	expectStraightColors(await readColors(resizedOutput.target.buffer!));
});

test('Decoded frames with alpha keep the color space of the color stream', async ({ skip }) => {
	// WebKitGTK's VideoFrame.copyTo() returns YUV planes unconverted when asked for RGBA, so the colors can't be read
	// back there. This probes the browser itself, not Mediabunny.
	const probe = new VideoFrame(new Uint8Array([235, 235, 235, 235, 128, 128]), {
		format: 'I420',
		codedWidth: 2,
		codedHeight: 2,
		timestamp: 0,
	});
	const probeRgba = new Uint8Array(16);
	await probe.copyTo(probeRgba, { format: 'RGBA' }).catch(() => {});
	probe.close();
	skip(probeRgba[3] !== 255, 'VideoFrame.copyTo() does not convert YUV to RGBA here');

	// Opaque gray bars encoded with alpha: 'keep', like a canvas recording from Chrome's MediaRecorder: the color
	// stream comes out full range, and every packet carries alpha side data. Grays, so that only the range matters.
	const colors = [[16, 16, 16], [64, 64, 64], [192, 192, 192], [240, 240, 240]];
	const data = new Uint8Array(64 * 16 * 4);
	for (let i = 0; i < 64 * 16; i++) {
		data.set([...colors[Math.floor((i % 64) / 16)]!, 255], i * 4);
	}

	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new VideoSampleSource({ codec: 'vp9', bitrate: 8e6, alpha: 'keep' });
	output.addVideoTrack(source);
	await output.start();
	using inputSample = new VideoSample(data, {
		format: 'RGBA',
		codedWidth: 64,
		codedHeight: 16,
		timestamp: 0,
		duration: 1,
	});
	await source.add(inputSample);
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const sink = new VideoSampleSink(videoTrack);
	using sample = (await sink.getSample(0))!;
	expect(sample.hasAlpha).toBe(true); // Went through the alpha merger

	const rgba = new Uint8Array(sample.allocationSize({ format: 'RGBA' }));
	await sample.copyTo(rgba, { format: 'RGBA' });
	for (let i = 0; i < colors.length; i++) {
		const offset = (8 * 64 + i * 16 + 8) * 4;
		const actual = Array.from(rgba.subarray(offset, offset + 3));
		for (let j = 0; j < 3; j++) {
			expect(Math.abs(actual[j]! - colors[i]![j]!), `${actual.join()} vs ${colors[i]!.join()}`)
				.toBeLessThanOrEqual(6);
		}
	}
});

test('Decoded frames with alpha keep the display size of the color stream', async () => {
	// The same 64x32 VP9 video with a 2:1 pixel aspect ratio (display size 128x32), with and without alpha, made with
	// FFmpeg 7.0.2:
	// ffmpeg -f lavfi -i "testsrc2=s=64x32:d=0.5:r=10,format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':
	//   cr='cr(X,Y)':a='X*4'" -vf setsar=2/1 -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 1M vp9-alpha-anamorphic.webm
	// ffmpeg -f lavfi -i "testsrc2=s=64x32:d=0.5:r=10" -vf setsar=2/1 -c:v libvpx-vp9 -b:v 1M vp9-anamorphic.webm
	const firstSample = async (path: string) => {
		using input = new Input({ source: new UrlSource(path), formats: ALL_FORMATS });
		const videoTrack = (await input.getPrimaryVideoTrack())!;
		expect(await videoTrack.getDisplayWidth()).toBe(128);
		return (await new VideoSampleSink(videoTrack).getSample(0))!;
	};

	using withAlpha = await firstSample('/vp9-alpha-anamorphic.webm');
	using withoutAlpha = await firstSample('/vp9-anamorphic.webm');
	expect(withAlpha.hasAlpha).toBe(true); // Went through the alpha merger

	// Merging in the alpha must not change the display size (which is 128x32 where the decoder applies the configured
	// display aspect: Chrome, Firefox)
	expect([withAlpha.displayWidth, withAlpha.displayHeight])
		.toEqual([withoutAlpha.displayWidth, withoutAlpha.displayHeight]);
	expect(withAlpha.pixelAspectRatio).toEqual(withoutAlpha.pixelAspectRatio);
});

test('Decodes the alpha of the first GOP of transparent AVC video', async ({ skip }) => {
	// Chromium's first-packet workarounds rewrote the packet without its alpha side data, so the alpha decoder missed
	// the first key frame and the whole first GOP came out opaque (found by the lane L90 review; bug-fix-mania's fix)
	skip(
		!(await canEncodeVideo('avc', { width: 64, height: 64, alpha: 'keep' })),
		'there is no AVC encoder that keeps alpha here',
	);

	const canvas = new OffscreenCanvas(64, 64);
	const context = canvas.getContext('2d');
	assert(context);
	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('high'), alpha: 'keep' });
	output.addVideoTrack(source);
	await output.start();
	for (let i = 0; i < 10; i++) {
		context.clearRect(0, 0, 64, 64);
		context.fillStyle = 'red';
		context.fillRect(0, 0, 32, 64); // The left half opaque, the right half fully transparent
		await source.add(i / 30, 1 / 30);
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	using sample = await new VideoSampleSink(track).getSample(0);
	assert(sample);

	// The format with alpha differs by browser (I420A in Chromium, BGRA in Firefox), so check the pixels
	const drawn = new OffscreenCanvas(64, 64);
	const drawnContext = drawn.getContext('2d');
	assert(drawnContext);
	sample.draw(drawnContext, 0, 0);
	expect(drawnContext.getImageData(16, 32, 1, 1).data[3]).toBe(255);
	expect(drawnContext.getImageData(48, 32, 1, 1).data[3]).toBe(0);
});
