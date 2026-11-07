import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { CmafOutputFormat, HlsOutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { CanvasSource } from '../../src/media-source.js';
import { Quality } from '../../src/encode.js';
import { Input } from '../../src/input.js';
import { HLS_FORMATS } from '../../src/input-format.js';
import { BufferSource, CustomPathedSource } from '../../src/source.js';
import { VideoSampleSink } from '../../src/media-sink.js';

test('HLS output, key frames aligning with segment boundaries by default', async () => {
	let playlistText: string | null = null;

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onPlaylist: (text) => { playlistText = text; },
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	const canvas = new OffscreenCanvas(640, 480);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#ff0000';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	const videoSource = new CanvasSource(canvas, {
		codec: 'avc',
		quality: new Quality('high'),
	});
	output.addVideoTrack(videoSource);

	await output.start();

	const fps = 2;
	const frameDuration = 1 / fps;
	const totalFrames = 10 * fps;
	for (let i = 0; i < totalFrames; i++) {
		await videoSource.add(i * frameDuration, frameDuration);
	}

	await output.finalize();

	expect(playlistText).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:2,
segment-1-3.ts
#EXTINF:2,
segment-1-4.ts
#EXTINF:2,
segment-1-5.ts

#EXT-X-ENDLIST
`);
});

test.each(['MPEG-TS', 'CMAF'] as const)('HLS output decodes back frame by frame (%s)', async (segmentFormat) => {
	const files = new Map<string, Uint8Array>();
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: segmentFormat === 'CMAF' ? new CmafOutputFormat() : new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	// One gray level per second, so every frame tells which second it belongs to. Grays decode the same under the
	// BT.601 and BT.709 matrices, so this doesn't depend on encoders agreeing on the matrix (Firefox's encoder converts
	// with BT.601 but signals BT.709).
	const grays = [0, 64, 128, 192, 255];
	const canvas = new OffscreenCanvas(320, 240);
	const ctx = canvas.getContext('2d')!;

	const videoSource = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('high'), keyFrameInterval: 1 });
	output.addVideoTrack(videoSource, { frameRate: 10 });
	await output.start();

	for (let i = 0; i < 50; i++) {
		const gray = grays[Math.floor(i / 10)]!;
		ctx.fillStyle = `rgb(${gray}, ${gray}, ${gray})`;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		await videoSource.add(i / 10, 1 / 10);
	}
	await output.finalize();

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(files.get(path)!)),
		formats: HLS_FORMATS,
	});
	const videoTrack = await input.getPrimaryVideoTrack();
	const sink = new VideoSampleSink(videoTrack!);

	const readColor = (sample: Awaited<ReturnType<typeof sink.getSample>>) => {
		const readCanvas = new OffscreenCanvas(sample!.displayWidth, sample!.displayHeight);
		const readCtx = readCanvas.getContext('2d')!;
		sample!.draw(readCtx, 0, 0);
		return [...readCtx.getImageData(160, 120, 1, 1).data.subarray(0, 3)];
	};
	const expectGray = (actual: number[], second: number) => {
		// Adjacent seconds differ by at least 63
		for (const channel of actual) {
			expect(Math.abs(channel - grays[second]!)).toBeLessThan(16);
		}
	};

	let count = 0;
	for await (const sample of sink.samples()) {
		expect(sample.timestamp).toBeCloseTo(count / 10, 5);
		expectGray(readColor(sample), Math.floor(count / 10));
		sample.close();
		count++;
	}
	expect(count).toBe(50);

	// Random access into the middle of a later segment
	for (const timestamp of [3.55, 1.05, 4.95]) {
		const sample = await sink.getSample(timestamp);
		expect(sample!.timestamp).toBeCloseTo(Math.floor(timestamp * 10) / 10, 5);
		expectGray(readColor(sample), Math.floor(timestamp));
		sample!.close();
	}
});
