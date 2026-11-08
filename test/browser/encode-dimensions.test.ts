import { expect, test } from 'vitest';
import { encodesVideo } from './helpers/platform-probes.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { NullTarget } from '../../src/target.js';
import { VideoSampleSource } from '../../src/media-source.js';
import { canEncodeVideo, Quality } from '../../src/encode.js';
import { VideoSample } from '../../src/sample.js';

test('Odd video dimensions fail for AVC', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new NullTarget(),
	});

	const source = new VideoSampleSource({
		codec: 'avc',
		quality: new Quality('high'),
	});
	output.addVideoTrack(source);

	await output.start();

	const canvas = document.createElement('canvas');
	canvas.width = 1281;
	canvas.height = 720;
	const sample = new VideoSample(canvas, { timestamp: 0 });

	await expect(source.add(sample)).rejects.toThrow('even number'); // The error message is explicit
});

test('Odd video dimensions fail for HEVC', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new NullTarget(),
	});

	const source = new VideoSampleSource({
		codec: 'hevc',
		quality: new Quality('high'),
	});
	output.addVideoTrack(source);

	await output.start();

	const canvas = document.createElement('canvas');
	canvas.width = 1281;
	canvas.height = 720;
	const sample = new VideoSample(canvas, { timestamp: 0 });

	await expect(source.add(sample)).rejects.toThrow('even number');
});

test('Odd video dimensions pass for VP9', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new NullTarget(),
	});

	const source = new VideoSampleSource({
		codec: 'vp9',
		quality: new Quality('high'),
	});
	output.addVideoTrack(source);

	await output.start();

	const canvas = document.createElement('canvas');
	canvas.width = 1281;
	canvas.height = 720;
	const sample = new VideoSample(canvas, { timestamp: 0 });

	await source.add(sample);
});

test('Odd video dimensions encodability checks', async ({ skip }) => {
	expect(await canEncodeVideo('avc', { width: 1920, height: 1081 })).toBe(false);
	expect(await canEncodeVideo('hevc', { width: 1920, height: 1081 })).toBe(false);
	expect(await canEncodeVideo('vp8', { width: 1920, height: 1081 })).toBe(true);
	expect(await canEncodeVideo('vp9', { width: 1920, height: 1081 })).toBe(true);
	skip(
		!await encodesVideo({ codec: 'av01.0.08M.08', width: 1920, height: 1080, bitrate: 5_000_000 }),
		'the platform has no AV1 encoder (native probe)',
	);
	expect(await canEncodeVideo('av1', { width: 1920, height: 1081 })).toBe(true);
});
