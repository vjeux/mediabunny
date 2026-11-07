import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	MkvOutputFormat,
	Mp4OutputFormat,
	Output,
	OutputFormat,
} from '../../src/index.js';
import { findUnderlyingFrameRate } from '../../src/input-track.js';
import { assert } from '../../src/misc.js';

test('findUnderlyingFrameRate with 30 FPS at 30 Hz time resolution', () => {
	const ticks = makeTicks(30, 30);
	expect(findUnderlyingFrameRate(ticks, 30)).toBe(30);
});

test('findUnderlyingFrameRate with 30 FPS at 1000 Hz time resolution', () => {
	expect(findUnderlyingFrameRate(makeTicks(30, 1000, { quantize: Math.floor }), 1000)).toBe(30);
	expect(findUnderlyingFrameRate(makeTicks(30, 1000, { quantize: Math.round }), 1000)).toBe(30);
	expect(findUnderlyingFrameRate(makeTicks(30, 1000, { quantize: Math.ceil }), 1000)).toBe(30);
});

test('findUnderlyingFrameRate with 30 FPS at 30 Hz with dropped frames', () => {
	const ticks = makeTicks(30, 30, { dropFrame: dropSomeFrames });
	expect(findUnderlyingFrameRate(ticks, 30)).toBe(30);
});

test('findUnderlyingFrameRate with 30 FPS at 1000 Hz with dropped frames', () => {
	expect(findUnderlyingFrameRate(
		makeTicks(30, 1000, { quantize: Math.floor, dropFrame: dropSomeFrames }),
		1000,
	)).toBe(30);
	expect(findUnderlyingFrameRate(
		makeTicks(30, 1000, { quantize: Math.round, dropFrame: dropSomeFrames }),
		1000,
	)).toBe(30);
	expect(findUnderlyingFrameRate(
		makeTicks(30, 1000, { quantize: Math.ceil, dropFrame: dropSomeFrames }),
		1000,
	)).toBe(30);
});

test('findUnderlyingFrameRate with 24/1.001 FPS at 24000 Hz time resolution', () => {
	const ticks = makeTicks(24000 / 1001, 24000);
	expect(findUnderlyingFrameRate(ticks, 24000)).toBe(24000 / 1001);
});

test('findUnderlyingFrameRate with 24/1.001 FPS at 1000 Hz time resolution (1 minute)', () => {
	const frameCount = Math.floor(60 * 24000 / 1001);
	const ticks = makeTicks(24000 / 1001, 1000, { frameCount });
	expect(findUnderlyingFrameRate(ticks, 1000)).toBe(24000 / 1001);
});

test('findUnderlyingFrameRate with 24/1.001 FPS at 1000 Hz time resolution (60 minutes)', () => {
	const frameCount = Math.floor(3600 * 24000 / 1001);
	const ticks = makeTicks(24000 / 1001, 1000, { frameCount });
	expect(findUnderlyingFrameRate(ticks, 1000)).toBe(24000 / 1001);
});

test('findUnderlyingFrameRate with 30 FPS at 1000 Hz starting at 1e9 seconds', () => {
	const ticks = makeTicks(30, 1000, { startTime: 1e9 });
	expect(findUnderlyingFrameRate(ticks, 1000)).toBe(30);
});

test('findUnderlyingFrameRate with millisecond-rounded timestamps at a finer time resolution', () => {
	// Timestamps from Matroska/WebM keep their rounding to whole milliseconds when copied into MP4 or MPEG-TS, and must
	// give the same frame rate as they do at 1000 Hz
	for (const resolution of [1000, 15360, 90000]) {
		for (const frameRate of [30, 24000 / 1001, 60]) {
			const ticks = makeTicks(frameRate, resolution, {
				quantize: x => Math.round(Math.round(x * 1000 / resolution) * resolution / 1000),
			});
			expect(findUnderlyingFrameRate(ticks, resolution), `${frameRate} at ${resolution} Hz`).toBe(frameRate);
		}

		// Jittered timestamps stay variable
		const jitteredTicks = makeTicks(30, resolution, {
			quantize: x => Math.round(Math.round(x * 1000 / resolution + 5 * Math.sin(x)) * resolution / 1000),
		});
		expect(findUnderlyingFrameRate(jitteredTicks, resolution)).toBe(null);
	}
});

test('findUnderlyingFrameRate with millisecond-rounded VFR at a finer time resolution', () => {
	// A drifting ~30 fps capture stored in whole milliseconds, as in a WebM. FFmpeg's -c copy into MP4 gives such a
	// track a 16000 Hz timescale. It stays variable there, as it is at 1000 Hz (found by lane L46).
	const milliseconds = [
		0, 33, 66, 98, 131, 164, 197, 231, 264, 298, 330, 363, 396, 429, 462, 495, 528, 561, 594, 627,
	];
	expect(findUnderlyingFrameRate(Float64Array.from(milliseconds), 1000)).toBe(null);
	expect(findUnderlyingFrameRate(Float64Array.from(milliseconds, x => x * 16), 16000)).toBe(null);
});

test('findUnderlyingFrameRate with irregular timestamps yields null', () => {
	const ticks = new Float64Array([0, 0.2, 0.5].map(x => Math.round(x * 100)));
	expect(findUnderlyingFrameRate(ticks, 100)).toBe(null);
});

test('findUnderlyingFrameRate with cursed VFR timestamps yields null', async () => {
	const { ticks, timeResolution } = await getSortedTrackTicks(publicPath('cursed-vfr.mp4'));
	expect(findUnderlyingFrameRate(ticks, timeResolution)).toBe(null);
});

test('computeFrameRateMetrics with constant frame rate video', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const metrics = await videoTrack.computeFrameRateMetrics();

	expect(metrics.underlyingFrameRate).toBe(25);
	expect(metrics.bestGuessFrameRate).toBe(25);
	expect(metrics.minFrameRate).toBe(25);
	expect(metrics.maxFrameRate).toBe(25);
	expect(metrics.averageFrameRate).toBe(25);
	expect(metrics.medianFrameRate).toBe(25);
	expect(metrics.frameRateIsConstant).toBe(true);
});

test('computeFrameRateMetrics with cursed VFR video', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('cursed-vfr.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const metrics = await videoTrack.computeFrameRateMetrics();

	expect(metrics.underlyingFrameRate).toBe(null);
	expect(metrics.bestGuessFrameRate).toBe(30);
	expect(metrics.minFrameRate).toBe(0.6369426751592356);
	expect(metrics.maxFrameRate).toBe(188.85245901639345);
	expect(metrics.averageFrameRate).toBe(8.664659340979288);
	expect(metrics.medianFrameRate).toBe(30.165016356826754);
	expect(metrics.frameRateIsConstant).toBe(false);
});

const makeTicks = (
	frameRate: number,
	timeResolution: number,
	options: {
		frameCount?: number;
		startTime?: number;
		quantize?: (value: number) => number;
		dropFrame?: (index: number) => boolean;
	} = {},
) => {
	const frameCount = options.frameCount ?? 300;
	const startTime = options.startTime ?? 0;
	const quantize = options.quantize ?? Math.round;

	const ticks: number[] = [];

	for (let i = 0; i < frameCount; i++) {
		if (options.dropFrame?.(i)) {
			continue;
		}

		ticks.push(quantize((startTime + i / frameRate) * timeResolution));
	}

	return new Float64Array(ticks);
};

const dropSomeFrames = (index: number) => index % 11 === 4 || index % 17 === 9;

const getSortedTrackTicks = async (filePath: string) => {
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const timeResolution = await videoTrack.getTimeResolution();
	const sink = new EncodedPacketSink(videoTrack);
	const ticks: number[] = [];

	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		ticks.push(Math.round(packet.timestamp * timeResolution));
	}

	ticks.sort((a, b) => a - b);

	const dedupedTicks = ticks.filter((tick, index) => index === 0 || tick !== ticks[index - 1]);

	return { ticks: new Float64Array(dedupedTicks), timeResolution };
};

/** Writes 30 fps video whose timestamps were rounded to whole milliseconds, as Matroska/WebM stores them. */
const writeMillisecondRoundedVideo = async (format: OutputFormat) => {
	const output = new Output({ format, target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source);
	await output.start();

	for (let i = 0; i < 90; i++) {
		const timestamp = Math.round(i * 1000 / 30) / 1000;
		const packet = new EncodedPacket(new Uint8Array([0x82, 0x49, 0x83, 0x42, 0x00]), 'key', timestamp, 0.033);
		await source.add(packet, {
			decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 320, codedHeight: 240 },
		});
	}
	await output.finalize();

	return output.target.buffer!;
};

test('computeFrameRateMetrics gives millisecond-rounded video the same frame rate in Matroska and MP4', async () => {
	// Found by lane L55. MP4 stores the copied timestamps in a finer timescale, which used to make them look variable.
	for (const format of [new MkvOutputFormat(), new Mp4OutputFormat()]) {
		using input = new Input({
			source: new BufferSource(await writeMillisecondRoundedVideo(format)),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const metrics = await track.computeFrameRateMetrics({ targetPacketCount: Infinity });
		expect(metrics.underlyingFrameRate, format.constructor.name).toBe(30);
		expect(metrics.frameRateIsConstant, format.constructor.name).toBe(true);
	}
});

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicPath = (file: string) => path.join(__dirname, '../public', file);
