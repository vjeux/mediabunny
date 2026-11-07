import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	Conversion,
	EncodedPacket,
	EncodedVideoPacketSource,
	Input,
	MkvOutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	Output,
	OutputFormat,
	Rotation,
	TransformationMatrix,
	VideoTrackMetadata,
} from '../../src/index.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const WIDTH = 1280;
const HEIGHT = 720;

test('MP4, no metadata', async () => {
	await expectRoundTrip(new Mp4OutputFormat(), 0, false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('MP4, rotation', async () => {
	await expectRoundTrip(new Mp4OutputFormat(), 90, false, [0, 1, 0, -1, 0, 0, HEIGHT, 0, 1]);
});

test('MP4, flip', async () => {
	await expectRoundTrip(new Mp4OutputFormat(), 0, true, [-1, 0, 0, 0, 1, 0, WIDTH, 0, 1]);
});

test('MP4, rotation with flip', async () => {
	await expectRoundTrip(new Mp4OutputFormat(), 270, true, [0, -1, 0, -1, 0, 0, HEIGHT, WIDTH, 1]);
});

test('Matroska, no metadata', async () => {
	await expectRoundTrip(new MkvOutputFormat(), 0, false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('Matroska, rotation', async () => {
	await expectRoundTrip(new MkvOutputFormat(), 90, false, [0, 1, 0, -1, 0, 0, HEIGHT, 0, 1]);
});

test('Matroska, flip', async () => {
	await expectRoundTrip(new MkvOutputFormat(), 0, true, [-1, 0, 0, 0, 1, 0, WIDTH, 0, 1]);
});

test('Matroska, rotation with flip', async () => {
	await expectRoundTrip(new MkvOutputFormat(), 270, true, [0, -1, 0, -1, 0, 0, HEIGHT, WIDTH, 1]);
});

test('MP4, explicit matrix', async () => {
	await expectMatrixRoundTrip(new Mp4OutputFormat(), [0, 1, 0, -1, 0, 0, HEIGHT, 0, 1], 90, false);
});

test('MP4, explicit matrix with flip', async () => {
	await expectMatrixRoundTrip(new Mp4OutputFormat(), [0, 1, 0, 1, 0, 0, 0, 0, 1], 90, true);
});

test('MP4, degenerate matrix', async () => {
	await expectMatrixRoundTrip(new Mp4OutputFormat(), [0, 0, 0, 0, 1, 0, 0, 0, 1], 0, false);
});

test('Matroska, explicit matrix', async () => {
	await expectMatrixRoundTrip(new MkvOutputFormat(), [0, 1, 0, -1, 0, 0, HEIGHT, 0, 1], 90, false);
});

test('Matroska, explicit matrix with flip', async () => {
	await expectMatrixRoundTrip(new MkvOutputFormat(), [0, 1, 0, 1, 0, 0, 0, 0, 1], 90, true);
});

test('Matroska, degenerate matrix', async () => {
	await expectMatrixRoundTrip(new MkvOutputFormat(), [0, 0, 0, 0, 1, 0, 0, 0, 1], 0, false);
});

const expectRoundTrip = async (
	format: OutputFormat,
	rotation: Rotation,
	flip: boolean,
	expectedMatrix: TransformationMatrix,
) => {
	const track = await roundTrip(format, {
		rotation,
		flip,
	});

	expect(await track.getRotation()).toBe(rotation);
	expect(await track.getFlip()).toBe(flip);
	expect(await track.getTransformationMatrix()).toEqual(expectedMatrix);

	const [expectedWidth, expectedHeight] = rotation % 180 === 0 ? [WIDTH, HEIGHT] : [HEIGHT, WIDTH];
	expect(await track.getDisplayWidth()).toBe(expectedWidth);
	expect(await track.getDisplayHeight()).toBe(expectedHeight);
};

const expectMatrixRoundTrip = async (
	format: OutputFormat,
	matrix: TransformationMatrix,
	expectedRotation: Rotation,
	expectedFlip: boolean,
) => {
	// Conflicting rotation and flip to prove the matrix takes precedence
	const track = await roundTrip(format, {
		rotation: 180,
		flip: !expectedFlip,
		transformationMatrix: matrix,
	});

	expect(await track.getRotation()).toBe(expectedRotation);
	expect(await track.getFlip()).toBe(expectedFlip);
	expect(await track.getTransformationMatrix()).toEqual(matrix);
};

const roundTrip = async (format: OutputFormat, metadata: VideoTrackMetadata) => {
	const output = new Output({
		format,
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, metadata);

	await output.start();
	for (let i = 0; i < 3; i++) {
		await source.add(
			new EncodedPacket(new Uint8Array(1024), i === 0 ? 'key' : 'delta', i * 0.1, 0.1),
			{
				decoderConfig: {
					codec: 'vp8',
					codedWidth: WIDTH,
					codedHeight: HEIGHT,
				},
			},
		);
	}
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	return track;
};

test('Exact pixel aspect ratios, and their remuxes', async () => {
	// A 1920x1080 frame with 32:27 pixels (NTSC 16:9 DVD pixels) is 2275.56 square pixels wide, which no whole pixel
	// size can say exactly: the pixel aspect ratio and the display aspect of the decoder config must stay exact
	const description = new Uint8Array(
		('0164000cffe100196764000cacd941011b011000000300100000030320f142996001000668ebe3cb22c0fdf8f800')
			.match(/../g)!.map(x => parseInt(x, 16)),
	);
	const write = async (format: OutputFormat, decoderConfig: VideoDecoderConfig) => {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source);
		await output.start();
		// A length-prefixed IDR slice NAL unit
		await source.add(new EncodedPacket(new Uint8Array([0, 0, 0, 4, 0x65, 0x88, 0x84, 0x00]), 'key', 0, 1), {
			decoderConfig,
		});
		await output.finalize();
		return output.target.buffer!;
	};
	const read = async (buffer: ArrayBuffer) => {
		using input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const decoderConfig = await track.getDecoderConfig();
		return {
			pixelAspectRatio: await track.getPixelAspectRatio(),
			squarePixelWidth: await track.getSquarePixelWidth(),
			displayAspect: [decoderConfig?.displayAspectWidth, decoderConfig?.displayAspectHeight],
		};
	};
	const remux = async (buffer: ArrayBuffer, format: OutputFormat) => {
		using input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
		const output = new Output({ format, target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output });
		await conversion.execute();
		return output.target.buffer!;
	};

	const anamorphic = { codec: 'avc1.64000c', codedWidth: 1920, codedHeight: 1080, description };
	for (const format of [new Mp4OutputFormat(), new MkvOutputFormat()]) {
		const written = await write(format, { ...anamorphic, displayAspectWidth: 512, displayAspectHeight: 243 });
		const expected = { pixelAspectRatio: { num: 32, den: 27 }, squarePixelWidth: 2276, displayAspect: [512, 243] };
		expect(await read(written)).toEqual(expected);
		// Copying the packets keeps the pixel aspect ratio
		expect(await read(await remux(written, new Mp4OutputFormat()))).toEqual(expected);
		expect(await read(await remux(written, new MkvOutputFormat()))).toEqual(expected);
	}

	// When the frame size in square pixels is whole, the decoder config holds it, as before
	const exact = await write(
		new Mp4OutputFormat(),
		{ ...anamorphic, codedWidth: 1440, displayAspectWidth: 1920, displayAspectHeight: 1080 },
	);
	expect(await read(exact)).toEqual({
		pixelAspectRatio: { num: 4, den: 3 },
		squarePixelWidth: 1920,
		displayAspect: [1920, 1080],
	});
});

test('Exact pixel aspect ratios from the SPS, in MP4 and MPEG-TS', async () => {
	// These fixtures' SPS gives 9:16 pixels, which makes 64x64 frames 113.78 square pixels high
	for (const fileName of ['sps-only-sar-h264.mp4', 'sps-only-sar-hevc.mp4']) {
		const bytes = readFileSync(path.join(__dirname, '../public', fileName));
		const fromMp4 = await (async () => {
			using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
			const track = await input.getPrimaryVideoTrack();
			assert(track);
			const decoderConfig = await track.getDecoderConfig();
			expect(await track.getPixelAspectRatio()).toEqual({ num: 9, den: 16 });
			expect(await track.getSquarePixelHeight()).toBe(114);
			expect([decoderConfig?.displayAspectWidth, decoderConfig?.displayAspectHeight]).toEqual([9, 16]);

			// The same stream in MPEG-TS, where only the SPS carries the ratio
			const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
			const conversion = await Conversion.init({ input, output });
			await conversion.execute();
			return output.target.buffer!;
		})();

		using input = new Input({ source: new BufferSource(fromMp4), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		expect(await track.getPixelAspectRatio()).toEqual({ num: 9, den: 16 });
	}
});
