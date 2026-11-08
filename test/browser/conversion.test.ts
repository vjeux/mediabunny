import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import {
	AdtsOutputFormat,
	HlsOutputFormat,
	MkvOutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	OutputFormat,
	WavOutputFormat,
	WebMOutputFormat,
} from '../../src/output-format.js';
import { Output, OutputTrackGroup } from '../../src/output.js';
import { BufferSource, CustomPathedSource, Source, UrlSource } from '../../src/source.js';
import { expect, test } from 'vitest';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import {
	Conversion,
	ConversionCanceledError,
	ConversionOptions,
	ConversionVideoOptions,
} from '../../src/conversion.js';
import { assert, uint8ArraysAreEqual } from '../../src/misc.js';
import { InputVideoTrack } from '../../src/input-track.js';
import {
	CanvasSource,
	EncodedAudioPacketSource,
	VideoSampleSource,
	EncodedVideoPacketSource,
} from '../../src/media-source.js';
import { Quality } from '../../src/encode.js';
import { EncodedPacket } from '../../src/packet.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { PCM_AUDIO_CODECS } from '../../src/codec.js';
import { VideoSample } from '../../src/sample.js';
import { CustomVideoDecoder, registerDecoder } from '../../src/custom-coder.js';

test('Rotation is baked in when rerendering', async () => {
	using input = new Input({
		source: new UrlSource('/rotate-buck-bunny.mp4'),
		formats: ALL_FORMATS,
	});

	const ogTrack = await input.getPrimaryVideoTrack();
	assert(ogTrack);

	expect(await ogTrack.getRotation()).toBe(90);
	expect(await ogTrack.getCodedWidth()).toBe(1920);
	expect(await ogTrack.getCodedHeight()).toBe(1080);
	expect(await ogTrack.getDisplayWidth()).toBe(1080);
	expect(await ogTrack.getDisplayHeight()).toBe(1920);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, video: {
		width: 320,
	} });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await newInput.getPrimaryVideoTrack();
	assert(track);

	expect(await track.getCodedWidth()).toBe(320);
	expect(await track.getCodedHeight()).toBe(570);
	expect(await track.getDisplayWidth()).toBe(320);
	expect(await track.getDisplayHeight()).toBe(570);
	expect(await track.getRotation()).toBe(0);
});

// Whether this browser can decode a file's video at all, decided by VideoDecoder.isConfigSupported (WebKitGTK can't
// decode VP9 profile 1 or AV1 4:4:4, say)
const decodesVideoNatively = async (url: string) => {
	using input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
	const decoderConfig = await (await input.getPrimaryVideoTrack())?.getDecoderConfig();
	return !!decoderConfig && (await VideoDecoder.isConfigSupported(decoderConfig)).supported === true;
};

const testGbrTranscode = async (url: string, color: readonly number[]) => {
	const firstPixel = async (input: Input) => {
		using sample = (await new VideoSampleSink((await input.getPrimaryVideoTrack())!).getSample(0))!;
		const rgba = new Uint8Array(sample.allocationSize({ format: 'RGBA' }));
		await sample.copyTo(rgba, { format: 'RGBA' });
		return [...rgba.subarray(0, 3)];
	};

	for (const [createFormat, codec] of [
		[() => new Mp4OutputFormat(), 'avc'],
		[() => new WebMOutputFormat(), 'vp8'],
		[() => new WebMOutputFormat(), 'vp9'],
	] as const) {
		using input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
		expect((await (await input.getPrimaryVideoTrack())!.getColorSpace()).matrix).toBe('rgb');

		const output = new Output({ format: createFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, video: { codec, forceTranscode: true } });
		await conversion.execute();

		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const pixel = await firstPixel(result);
		for (let i = 0; i < 3; i++) {
			expect(Math.abs(pixel[i]! - color[i]!)).toBeLessThan(15);
		}
	}
};

for (const [url, color] of [
	// 32x32 solid (200, 200, 200), VP9 profile 1 GBR 4:4:4, as FFmpeg makes lossless VP9 from RGB sources:
	// ffmpeg -f lavfi -i "color=0xc8c8c8:s=32x32:r=10:d=0.2,format=gbrp" -c:v libvpx-vp9 -lossless 1
	['/vp9-gbr-lossless.webm', [200, 200, 200]],
	// 32x32 solid (48, 128, 192), AV1 GBR 4:4:4:
	// ffmpeg -f lavfi -i "color=0x3080c0:s=32x32:r=10:d=0.2,format=gbrp" -c:v libaom-av1 -cpu-used 8 -crf 0
	['/av1-gbr-lossless.mkv', [48, 128, 192]],
] as const) {
	test.skipIf(!(await decodesVideoNatively(url)))(
		`Transcoding GBR-coded video (identity matrix) keeps its colors: ${url}`,
		async () => {
			await testGbrTranscode(url, color);
		},
	);
}

test('Flip is forwarded as metadata when copying', async () => {
	const buffer = await encodeFlippedVideo();
	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const conversion = await Conversion.init({ input, output, copy: { mode: 'forced' } });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await newInput.getPrimaryVideoTrack();
	assert(track);

	expect(await track.getRotation()).toBe(90);
	expect(await track.getFlip()).toBe(true);
});

test('Flip is baked in when rerendering', async () => {
	const buffer = await encodeFlippedVideo();
	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const conversion = await Conversion.init({ input, output, video: {
		width: 80,
	} });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await newInput.getPrimaryVideoTrack();
	assert(track);

	expect(await track.getRotation()).toBe(0);
	expect(await track.getFlip()).toBe(false);
	expect(await track.getCodedWidth()).toBe(80);
	expect(await track.getCodedHeight()).toBe(160);
});

test('Additional flip is composed with the input flip', async () => {
	const buffer = await encodeFlippedVideo();
	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const conversion = await Conversion.init({
		input,
		output,
		copy: { mode: 'forced' },
		video: { flip: true },
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await newInput.getPrimaryVideoTrack();
	assert(track);

	// The two flips cancel out
	expect(await track.getRotation()).toBe(90);
	expect(await track.getFlip()).toBe(false);
});

/** A short 320x160 video with rotation 90 and flip metadata. */
const encodeFlippedVideo = async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const canvas = new OffscreenCanvas(320, 160);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(0, 0, 320, 160);

	const videoSource = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('high') });
	output.addVideoTrack(videoSource, {
		rotation: 90,
		flip: true,
	});

	await output.start();
	for (let i = 0; i < 4; i++) {
		await videoSource.add(i / 4, 1 / 4);
	}
	await output.finalize();

	return output.target.buffer!;
};

test('A fit without both width and height applies to video that changes size, even if it could be copied', async () => {
	// A VP9 WebM switching from 64x48 to 32x32 mid-stream, as WebRTC and MediaRecorder recordings do
	const encodeVp9 = async (width: number, height: number, first: number, count: number) => {
		const chunks: { chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }[] = [];
		const encoder = new VideoEncoder({
			output: (chunk, meta) => chunks.push({ chunk, meta }),
			error: (error) => {
				throw error;
			},
		});
		encoder.configure({ codec: 'vp09.00.10.08', width, height, bitrate: 1e5 });

		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d')!;
		for (let i = first; i < first + count; i++) {
			context.fillStyle = `rgb(${i * 40}, 128, 64)`;
			context.fillRect(0, 0, width, height);
			const frame = new VideoFrame(canvas, { timestamp: i * 100_000, duration: 100_000 });
			encoder.encode(frame, { keyFrame: i === first });
			frame.close();
		}

		await encoder.flush();
		encoder.close();
		return chunks;
	};

	const sourceOutput = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	const videoSource = new EncodedVideoPacketSource('vp9');
	sourceOutput.addVideoTrack(videoSource);
	await sourceOutput.start();
	for (const { chunk, meta } of [...await encodeVp9(64, 48, 0, 3), ...await encodeVp9(32, 32, 3, 3)]) {
		await videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta);
	}
	await sourceOutput.finalize();

	const convertedFrameSizes = async (video: ConversionVideoOptions) => {
		using input = new Input({ source: new BufferSource(sourceOutput.target.buffer!), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, video });
		await conversion.execute();

		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const sizes: string[] = [];
		for await (using sample of new VideoSampleSink((await result.getPrimaryVideoTrack())!).samples()) {
			sizes.push(`${sample.displayWidth}x${sample.displayHeight}`);
		}

		return sizes;
	};

	const expected = Array(6).fill('64x48');
	// Control: when a transcode happens anyway, fit handles the size change
	expect(await convertedFrameSizes({ width: 64, height: 48, fit: 'contain', forceTranscode: true }))
		.toEqual(expected);
	// fit alone has no other role, so it must be applied too
	expect(await convertedFrameSizes({ fit: 'contain' })).toEqual(expected);
	expect(await convertedFrameSizes({ width: 64, fit: 'contain' })).toEqual(expected);
});

test('Exceeding max allowed track count', async () => {
	using input = new Input({
		source: new UrlSource('/multiple-aac-tracks.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	expect(conversion.utilizedTracks).toHaveLength(1);
	expect(conversion.discardedTracks).toHaveLength(1);
	expect(conversion.discardedTracks[0]!.reason).toBe('max_track_count_reached');
});

test('Fan-out', { timeout: 30_000 }, async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: [{ height: 480 }, { height: 360 }],
		audio: [], // Identical to discarding it
		showWarnings: false,
	});
	expect(conversion.utilizedTracks).toHaveLength(2);
	expect(conversion.discardedTracks).toHaveLength(1);
	expect(conversion.discardedTracks[0]!.reason).toBe('discarded_by_user');

	await conversion.execute();

	using otherInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const tracks = await otherInput.getTracks() as InputVideoTrack[];
	expect(tracks.map(x => x.type)).toEqual(['video', 'video']);

	expect(await tracks[0]!.getDisplayHeight()).toBe(480);
	expect(await tracks[1]!.getDisplayHeight()).toBe(360);
});

// eslint-disable-next-line @stylistic/max-len
const aacPacketData = new Uint8Array([255, 241, 77, 128, 3, 159, 252, 0, 208, 0, 1, 3, 64, 0, 13, 0, 0, 17, 52, 0, 0, 208, 0, 3, 6, 128, 0, 56]);
const aacMetadata: EncodedAudioChunkMetadata = {
	decoderConfig: {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
	},
};

const addAacPackets = async (source: EncodedAudioPacketSource, durationSeconds: number) => {
	const packetDuration = 1024 / 48000;
	const count = Math.ceil(durationSeconds / packetDuration);
	for (let i = 0; i < count; i++) {
		await source.add(
			new EncodedPacket(aacPacketData, 'key', i * packetDuration, packetDuration),
			i === 0 ? aacMetadata : undefined,
		);
	}
};

const sanitizeMasterPlaylist = (text: string) => {
	return text.replace(/CODECS=".+?"/g, 'CODECS="?"');
};

test('HLS track assignability is kept #1', async () => {
	const files = new Map<string, ArrayBuffer>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget(
			'master.m3u8',
			({ path }) => {
				const target = new BufferTarget();
				target.on('finalized', () => {
					files.set(path, target.buffer!);
				});

				return target;
			},
		),
	});

	const canvas = new OffscreenCanvas(1280, 720);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(100, 100, 200, 200);

	const videoSource = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('high') });
	output.addVideoTrack(videoSource);

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();

	for (let i = 0; i < 4; i++) {
		await videoSource.add(i / 2, 1 / 2);
	}

	await addAacPackets(audioSource, 2);

	await output.finalize();

	const masterPlaylist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('master.m3u8')));
	expect(masterPlaylist.match(/\.m3u8/g)?.length).toBe(1);

	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource(
			'master.m3u8',
			({ path }) => new BufferSource(files.get(path)!),
		),
	});

	const newOutput = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget(
			'new/master.m3u8',
			({ path }) => {
				const target = new BufferTarget();
				target.on('finalized', () => {
					files.set(path, target.buffer!);
				});

				return target;
			},
		),
	});

	const conversion = await Conversion.init({ input, output: newOutput });
	await conversion.execute();

	const newMasterPlaylist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('new/master.m3u8')));
	expect(newMasterPlaylist).toBe(masterPlaylist);
});

test('HLS track assignability is kept #2', async () => {
	const files = new Map<string, ArrayBuffer>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget(
			'master.m3u8',
			({ path }) => {
				const target = new BufferTarget();
				target.on('finalized', () => {
					files.set(path, target.buffer!);
				});

				return target;
			},
		),
	});

	const canvas = new OffscreenCanvas(1280, 720);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(100, 100, 200, 200);

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();

	const videoSource = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('high') });
	output.addVideoTrack(videoSource, { group: a });

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource, { group: b });

	await output.start();

	for (let i = 0; i < 4; i++) {
		await videoSource.add(i / 2, 1 / 2);
	}

	await addAacPackets(audioSource, 2);

	await output.finalize();

	const masterPlaylist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('master.m3u8')));
	expect(masterPlaylist.match(/\.m3u8/g)?.length).toBe(2);

	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource(
			'master.m3u8',
			({ path }) => new BufferSource(files.get(path)!),
		),
	});

	const newOutput = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget(
			'new/master.m3u8',
			({ path }) => {
				const target = new BufferTarget();
				target.on('finalized', () => {
					files.set(path, target.buffer!);
				});

				return target;
			},
		),
	});

	const conversion = await Conversion.init({ input, output: newOutput });
	await conversion.execute();

	const newMasterPlaylist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('new/master.m3u8')));
	expect(newMasterPlaylist).toBe(masterPlaylist);
});

test('HLS track assignability can be overridden', async () => {
	const files = new Map<string, ArrayBuffer>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget(
			'master.m3u8',
			({ path }) => {
				const target = new BufferTarget();
				target.on('finalized', () => {
					files.set(path, target.buffer!);
				});

				return target;
			},
		),
	});

	const canvas = new OffscreenCanvas(1280, 720);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(100, 100, 200, 200);

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();

	const videoSource = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('high') });
	output.addVideoTrack(videoSource, { group: a });

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource, { group: b });

	await output.start();

	for (let i = 0; i < 4; i++) {
		await videoSource.add(i / 2, 1 / 2);
	}

	await addAacPackets(audioSource, 2);

	await output.finalize();

	const masterPlaylist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('master.m3u8')));
	expect(masterPlaylist.match(/\.m3u8/g)?.length).toBe(2);

	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource(
			'master.m3u8',
			({ path }) => new BufferSource(files.get(path)!),
		),
	});

	const newOutput = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget(
			'new/master.m3u8',
			({ path }) => {
				const target = new BufferTarget();
				target.on('finalized', () => {
					files.set(path, target.buffer!);
				});

				return target;
			},
		),
	});

	const conversion = await Conversion.init({
		input,
		output: newOutput,
		video: { group: newOutput.defaultTrackGroup },
		audio: { group: newOutput.defaultTrackGroup },
	});
	await conversion.execute();

	const newMasterPlaylist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('new/master.m3u8')));
	expect(newMasterPlaylist).not.toBe(masterPlaylist);
	expect(newMasterPlaylist.match(/\.m3u8/g)?.length).toBe(1);
});

test('Transcoding keeps frames that have a duration of zero', async () => {
	// The last frame of each cluster in this Matroska file has no duration (no BlockDuration or DefaultDuration), the
	// first one at 4.81 s
	using input = new Input({ source: new UrlSource('/annex-b-avc.mkv'), formats: ALL_FORMATS });
	const inputTrack = (await input.getPrimaryVideoTrack())!;
	const inputPackets = [];
	const sink = new EncodedPacketSink(inputTrack);
	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		if (packet.timestamp >= 6) {
			break;
		}
		inputPackets.push(packet);
	}
	expect(inputPackets.some(x => x.duration === 0)).toBe(true);

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output, video: { width: 320 }, trim: { end: 6 } });
	await conversion.execute();

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const outputTrack = (await result.getPrimaryVideoTrack())!;
	expect((await outputTrack.computePacketStats()).packetCount).toBe(inputPackets.length);
});

test('Fractional audio sample boundary', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny-ffmpeg.ts'),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			discard: true,
		},
		audio: {
			forceTranscode: true,
		},
		trim: {
			start: 0.4 / 48000,
		},
	});
	await conversion.execute();
});

test('Trim start leaving less than half a sample of padding', async () => {
	using input = new Input({
		source: new UrlSource('/glitch-hop-is-dead.wav'),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		trim: {
			start: 0.0026,
			end: 0.1026,
		},
	});
	await conversion.execute();
});

test('Non-composable conversion requires a fresh output', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	output.addAudioTrack(new EncodedAudioPacketSource('aac')); // Makes the output non-fresh

	await expect(Conversion.init({ input, output })).rejects.toThrow(/must be fresh/);
});

test('Composable init works on an output that already has a track, but not on a started one', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	output.addAudioTrack(new EncodedAudioPacketSource('aac')); // A user-added track

	const conversion = await Conversion.init({
		input,
		output,
		composable: true,
		audio: { discard: true }, // Only contribute the video track
		showWarnings: false,
	});
	expect(conversion.isValid).toBe(true);
	expect(conversion.utilizedTracks).toHaveLength(1);
	expect(conversion.utilizedTracks[0]!.type).toBe('video');

	const startedOutput = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	startedOutput.addAudioTrack(new EncodedAudioPacketSource('aac'));
	await startedOutput.start();

	await expect(Conversion.init({ input, output: startedOutput, composable: true }))
		.rejects.toThrow(/not have been started/);

	await startedOutput.cancel();
});

test('Composable conversion rejects tags', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const makeOutput = () => new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	await expect(Conversion.init({
		input,
		output: makeOutput(),
		composable: true,
		tags: { title: 'Not allowed' },
	})).rejects.toThrow(/tags cannot be set by a composable conversion/);
});

test('Composable conversion composes with a user-added track', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const conversion = await Conversion.init({
		input,
		output,
		composable: true,
		audio: { discard: true }, // The user provides their own audio track
		showWarnings: false,
	});
	expect(conversion.utilizedTracks).toHaveLength(1);

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();

	await Promise.all([
		conversion.execute(),
		(async () => {
			await addAacPackets(audioSource, 5);
			audioSource.close();
		})(),
	]);

	// The composable conversion must not have finalized the output
	expect(output.state).toBe('started');

	await output.finalize();
	expect(output.state).toBe('finalized');

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const tracks = await result.getTracks();
	expect(tracks.map(t => t.type).sort()).toEqual(['audio', 'video']);

	const videoTrack = await result.getPrimaryVideoTrack();
	const audioTrack = await result.getPrimaryAudioTrack();
	expect(videoTrack).not.toBeNull();
	expect(audioTrack).not.toBeNull();
	expect(await videoTrack!.getCodec()).toBe('avc');
	expect(await audioTrack!.getCodec()).toBe('aac');
	expect(await videoTrack!.computeDuration()).toBeGreaterThan(4);
});

test('Two composable conversions compose into one output', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const videoConversion = await Conversion.init({
		input,
		output,
		composable: true,
		audio: { discard: true },
		showWarnings: false,
	});
	const audioConversion = await Conversion.init({
		input,
		output,
		composable: true,
		video: { discard: true },
		showWarnings: false,
	});
	expect(videoConversion.utilizedTracks).toHaveLength(1);
	expect(videoConversion.utilizedTracks[0]!.type).toBe('video');
	expect(audioConversion.utilizedTracks).toHaveLength(1);
	expect(audioConversion.utilizedTracks[0]!.type).toBe('audio');

	await output.start();
	await Promise.all([videoConversion.execute(), audioConversion.execute()]);
	expect(output.state).toBe('started');

	await output.finalize();

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const tracks = await result.getTracks();
	expect(tracks.map(t => t.type).sort()).toEqual(['audio', 'video']);
	expect(await (await result.getPrimaryVideoTrack())!.getCodec()).toBe('avc');
	expect(await (await result.getPrimaryAudioTrack())!.getCodec()).toBe('aac');
});

test('Composable conversion does not write metadata tags', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	// Sanity check: this input carries metadata tags that a non-composable conversion would copy over
	const inputTags = await input.getMetadataTags();
	expect(inputTags.comment).toBeDefined();

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const conversion = await Conversion.init({
		input,
		output,
		composable: true,
		audio: { discard: true },
		showWarnings: false,
	});

	// The conversion must not have touched the output's metadata tags
	expect(Object.keys(output._metadataTags)).toHaveLength(0);

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	// The user sets their own tags; these must survive
	output.setMetadataTags({ comment: 'User-owned' });

	await output.start();
	await Promise.all([
		conversion.execute(),
		(async () => {
			await addAacPackets(audioSource, 5);
			audioSource.close();
		})(),
	]);
	await output.finalize();

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const outTags = await result.getMetadataTags();
	// Only the user's tag is present; the input's tags were not copied
	expect(outTags.comment).toBe('User-owned');
});

test('Canceling a composable conversion leaves the output usable', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const conversion = await Conversion.init({
		input,
		output,
		composable: true,
		audio: { discard: true },
		showWarnings: false,
	});

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();

	const executePromise = conversion.execute();
	void conversion.cancel();
	expect(conversion.state).toBe('canceled');

	await expect(executePromise).rejects.toBeInstanceOf(ConversionCanceledError);

	// The output must not have been canceled by the composable conversion
	expect(output.state).toBe('started');

	// The user's own track can still finish, and the output can still be finalized
	await addAacPackets(audioSource, 2);
	audioSource.close();
	await output.finalize();
	expect(output.state).toBe('finalized');

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const audioTrack = await result.getPrimaryAudioTrack();
	expect(audioTrack).not.toBeNull();
	expect(await audioTrack!.getCodec()).toBe('aac');
});

test('Track capacity works correctly with composable conversions', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
	// The user already occupies the single audio slot that WAVE allows
	output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'));

	const conversion = await Conversion.init({
		input,
		output,
		composable: true,
		showWarnings: false,
	});

	// The conversion's audio track has no room left, so it gets discarded
	expect(conversion.isValid).toBe(true);
	expect(conversion.utilizedTracks).toHaveLength(0);
	expect(conversion.discardedTracks).toHaveLength(2);
	// WAVE allows only one track in total, so the total-count check fires before the per-type one
	expect(conversion.discardedTracks[0]!.reason).toBe('max_track_count_reached');
});

test('Blank execute', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output });
	expect(conversion.state).toBe('idle');

	const promise = conversion.execute();
	expect(conversion.state).toBe('executing');
	await promise;
	expect(conversion.state).toBe('done');
	expect(output.state).toBe('finalized');

	await conversion.execute();
	expect(conversion.state).toBe('done');
});

test('Stepwise until', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output });

	await conversion.execute({ until: 2 });
	expect(conversion.state).toBe('idle');
	expect(output.state).toBe('started');
	await conversion.execute({ until: 4 });
	expect(conversion.state).toBe('idle');
	await conversion.execute({ until: 6 });
	expect(conversion.state).toBe('done');
	expect(output.state).toBe('finalized');

	await conversion.execute();
	expect(conversion.state).toBe('done');

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const videoTrack = await result.getPrimaryVideoTrack();
	expect(await videoTrack!.computeDuration()).toBeGreaterThan(4);
});

test('Pause signal', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output });

	const controller = new AbortController();
	conversion.onProgress = (progress) => {
		if (progress >= 0.5 && !controller.signal.aborted) {
			controller.abort();
		}
	};

	await conversion.execute({ pauseSignal: controller.signal });
	expect(conversion.state).toBe('idle');
	expect(output.state).toBe('started');

	await conversion.execute();
	expect(conversion.state).toBe('done');
	expect(output.state).toBe('finalized');

	await conversion.execute();
	expect(conversion.state).toBe('done');
});

test.each(['video', 'audio'] as const)(
	'A pause requested while %s processing drops every sample still pauses the conversion',
	async (type) => {
		// Like a voice activity filter that drops everything until speech starts
		using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
		const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		const controller = new AbortController();
		let calls = 0;
		let dropAll = true;
		const process = <T>(sample: T) => {
			calls++;
			controller.abort();
			return dropAll ? null : sample;
		};

		const conversion = await Conversion.init({
			input,
			output,
			video: type === 'video' ? { process } : { discard: true },
			audio: type === 'audio' ? { process } : { discard: true },
		});

		await conversion.execute({ pauseSignal: controller.signal });
		expect(conversion.state).toBe('idle');
		expect(calls).toBe(1);

		dropAll = false;
		await conversion.execute();
		expect(conversion.state).toBe('done');
		expect(calls).toBeGreaterThan(1);
	},
);

test('Pre-signaled pause signal', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output });

	const controller = new AbortController();
	controller.abort();

	await conversion.execute({ pauseSignal: controller.signal });
	expect(conversion.state).toBe('idle');
	expect(output.state).toBe('started');

	await conversion.execute();
	expect(conversion.state).toBe('done');
	expect(output.state).toBe('finalized');

	await conversion.execute();
	expect(conversion.state).toBe('done');
});

test('Resizing at various scale factors', async () => {
	// The source is 1080p. 720p downscales by less than 2x, 240p downscales by more than 2x (which kicks in the manual
	// mipmapping path), and 1440p upscales.
	for (const height of [720, 240, 1440]) {
		using input = new Input({
			source: new UrlSource('/video.mp4'),
			formats: ALL_FORMATS,
		});

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			video: { height },
			trim: { end: 1 },
		});
		await conversion.execute();

		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const videoTrack = await result.getPrimaryVideoTrack();
		expect(await videoTrack!.getDisplayHeight()).toBe(height);
	}
});

test('Packet copy, whole file', async () => {
	await testCopy({
		conversionOptions: {},
		expectedTimeOffset: 0,
		videoStartTimestamp: 0,
		videoEndTimestamp: 5,
		audioStartTimestamp: -1024 / 48000,
		audioEndTimestamp: 5,
	});
});

test('Packet copy, keyframe trim', async () => {
	await testCopy({
		conversionOptions: {
			trim: {
				start: 1,
				end: 2,
			},
		},
		expectedTimeOffset: 1,
		videoStartTimestamp: 0,
		videoEndTimestamp: 1,
		audioStartTimestamp: -0.04,
		audioEndTimestamp: 1.0053333333333334,
	});
});

test('Packet copy, keyframe trim, shrink', async () => {
	await testCopy({
		conversionOptions: {
			trim: {
				start: 1,
				end: 2,
			},
			copy: {
				boundaryPolicy: 'shrink',
			},
		},
		expectedTimeOffset: 1,
		videoStartTimestamp: 0,
		videoEndTimestamp: 1,
		audioStartTimestamp: -0.04 + 2 * 1024 / 48000,
		audioEndTimestamp: 1.0053333333333334 - 1024 / 48000,
	});
});

test('Packet copy, delta frame trim', async () => {
	await testCopy({
		conversionOptions: {
			trim: {
				start: 1.5,
				end: 2.5,
			},
		},
		expectedTimeOffset: 1.5,
		videoStartTimestamp: -0.5,
		videoEndTimestamp: 1.02,
		audioStartTimestamp: -0.028,
		audioEndTimestamp: 1.0173333333333334,
	});
});

test('Packet copy, delta frame trim, shrink', async () => {
	await testCopy({
		conversionOptions: {
			trim: {
				start: 1.5,
				end: 2.5,
			},
			copy: {
				boundaryPolicy: 'shrink',
			},
		},
		expectedTimeOffset: 1.5,
		videoStartTimestamp: 0.5,
		videoEndTimestamp: 1, // The last presented packet is shrunk to end at the trim end
		audioStartTimestamp: -0.028 + 2 * 1024 / 48000,
		audioEndTimestamp: 1.0173333333333334 - 1024 / 48000,
	});
});

test('Packet copy, delta frame trim, boundary tolerance exceeded', async () => {
	await testCopy({
		conversionOptions: {
			trim: {
				start: 1.5,
				end: 2.5,
			},
			copy: {
				boundaryTolerance: 0.25,
			},
		},
		expectedTimeOffset: 1.5,
		videoStartTimestamp: 0,
		videoEndTimestamp: 1,
		audioStartTimestamp: -0.028,
		audioEndTimestamp: 1.0173333333333334,
		compareVideoPackets: false,
	});
});

test('Packet copy, whole file, Matroska', async () => {
	await testCopy({
		outputFormat: new MkvOutputFormat(),
		conversionOptions: {
			copy: {
				shiftTolerance: Infinity,
			},
		},
		expectedTimeOffset: -1024 / 48000,
		videoStartTimestamp: 0 + 1024 / 48000,
		videoEndTimestamp: 5 + 1024 / 48000 - 1 / 25,
		audioStartTimestamp: 0,
		audioEndTimestamp: 5 + 1024 / 48000,
		precision: 0.001,
	});
});

test('Packet copy, whole file, Matroska, forced', async () => {
	await testCopy({
		outputFormat: new MkvOutputFormat(),
		conversionOptions: {
			copy: {
				mode: 'forced',
			},
		},
		expectedTimeOffset: 0,
		videoStartTimestamp: 0,
		videoEndTimestamp: 5 - 1 / 25,
		audioStartTimestamp: -1024 / 48000,
		audioEndTimestamp: 5,
		precision: 0.001,
	});
});

test('Packet copy, delta frame trim, Matroska', async () => {
	await testCopy({
		outputFormat: new MkvOutputFormat(),
		conversionOptions: {
			trim: {
				start: 1.5,
				end: 2.5,
			},
			copy: {
				shiftTolerance: Infinity,
			},
		},
		expectedTimeOffset: 1,
		videoStartTimestamp: 0,
		videoEndTimestamp: 1.48,
		audioStartTimestamp: 0.472,
		audioEndTimestamp: 1.496 + 1024 / 48000,
		precision: 0.001,
	});
});

test('Packet copy, delta frame trim, video transcoded, Matroska', async () => {
	await testCopy({
		outputFormat: new MkvOutputFormat(),
		conversionOptions: {
			video: {
				forceTranscode: true,
				codec: 'vp9',
			},
			trim: {
				start: 1.5,
				end: 2.5,
			},
			copy: {
				shiftTolerance: Infinity,
			},
		},
		expectedTimeOffset: 1.472,
		videoStartTimestamp: 0.028,
		videoEndTimestamp: 1.028,
		audioStartTimestamp: 0,
		audioEndTimestamp: 1.024 + 1024 / 48000,
		precision: 0.001,
		compareVideoPackets: false,
	});
});

test('Packet copy, whole file, ADTS', async () => {
	await testCopy({
		outputFormat: new AdtsOutputFormat(),
		conversionOptions: {
			video: {
				discard: true,
			},
			copy: {
				mode: 'forced',
				shiftTolerance: Infinity,
			},
		},
		expectedTimeOffset: -1024 / 48000,
		audioStartTimestamp: 0,
		audioEndTimestamp: 5.034666666666666,
		processNewAudioPacketData: data => data.subarray(7),
	});
});

const testCopy = async (options: {
	outputFormat?: OutputFormat;
	conversionOptions: Omit<ConversionOptions, 'input' | 'output'>;
	expectedTimeOffset: number;
	videoStartTimestamp?: number;
	videoEndTimestamp?: number;
	audioStartTimestamp: number;
	audioEndTimestamp: number;
	precision?: number;
	processNewAudioPacketData?: (data: Uint8Array) => Uint8Array;
	compareVideoPackets?: boolean;
}) => {
	const precision = options.precision ?? 0.000001;

	const isCloseTo = (a: number, b: number) => {
		return Math.abs(a - b) <= precision;
	};

	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: options.outputFormat ?? new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);
	const videoSink = new EncodedPacketSink(videoTrack);
	const audioSink = new EncodedPacketSink(audioTrack);

	const conversion = await Conversion.init({
		input,
		output,
		...options.conversionOptions,
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const newVideoTrack = await newInput.getPrimaryVideoTrack();
	const newAudioTrack = await newInput.getPrimaryAudioTrack();

	if (newVideoTrack) {
		const newVideoSink = new EncodedPacketSink(newVideoTrack);

		expect(isCloseTo(await newVideoTrack.getFirstTimestamp(), options.videoStartTimestamp!)).toBe(true);
		expect(isCloseTo(await newVideoTrack.computeDuration(), options.videoEndTimestamp!)).toBe(true);

		if (options.compareVideoPackets ?? true) {
			for await (const newPacket of newVideoSink.packets()) {
				const oldPacket = await videoSink.getPacket(
					newPacket.timestamp + options.expectedTimeOffset + precision,
				);
				assert(oldPacket);

				expect(uint8ArraysAreEqual(oldPacket.data, newPacket.data)).toBe(true);
				expect(oldPacket.type).toEqual(newPacket.type);
			}
		}
	}

	if (newAudioTrack) {
		const newAudioSink = new EncodedPacketSink(newAudioTrack);

		expect(isCloseTo(await newAudioTrack.getFirstTimestamp(), options.audioStartTimestamp)).toBe(true);
		expect(isCloseTo(await newAudioTrack.computeDuration(), options.audioEndTimestamp)).toBe(true);

		for await (const newPacket of newAudioSink.packets()) {
			const oldPacket = await audioSink.getPacket(newPacket.timestamp + options.expectedTimeOffset + precision);
			assert(oldPacket);

			const process = options.processNewAudioPacketData ?? (x => x);

			expect(uint8ArraysAreEqual(oldPacket.data, process(newPacket.data))).toBe(true);
			expect(oldPacket.type).toEqual(newPacket.type);
		}
	}
};

test('Requested audio parameters apply when the decoded audio differs from the metadata', async () => {
	// ADTS signals HE-AACv2 implicitly, with the core's 22.05 kHz mono, while it decodes to 44.1 kHz stereo
	using mp4Input = new Input({
		source: new UrlSource('/he-aac-v2.mp4'),
		formats: ALL_FORMATS,
	});
	const adtsOutput = new Output({ format: new AdtsOutputFormat(), target: new BufferTarget() });
	const toAdts = await Conversion.init({
		input: mp4Input,
		output: adtsOutput,
		video: { discard: true },
		copy: { mode: 'forced', shiftTolerance: Infinity },
		trim: { end: 1 },
	});
	await toAdts.execute();

	using adtsInput = new Input({
		source: new BufferSource(adtsOutput.target.buffer!),
		formats: ALL_FORMATS,
	});
	const adtsTrack = await adtsInput.getPrimaryAudioTrack();
	assert(adtsTrack);
	expect(await adtsTrack.getSampleRate()).toBe(22050);
	expect(await adtsTrack.getNumberOfChannels()).toBe(1);

	for (const audio of [{ numberOfChannels: 1 }, { sampleRate: 22050 }]) {
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input: adtsInput, output, audio });
		await conversion.execute();

		using wavInput = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});
		const wavTrack = await wavInput.getPrimaryAudioTrack();
		assert(wavTrack);
		expect({
			numberOfChannels: await wavTrack.getNumberOfChannels(),
			sampleRate: await wavTrack.getSampleRate(),
		}).toEqual({ numberOfChannels: 2, sampleRate: 44100, ...audio });
	}
});

// video.mp4 is 1920x1080 H.264 High at level 4.0. Whether the platform has hardware video codecs is decided with
// WebCodecs alone (Chromium refuses 'prefer-hardware' without them).
const VIDEO_MP4_DECODER_CONFIG: VideoDecoderConfig = { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 };

test('Video that the requested hardware acceleration can\'t decode is discarded', async (context) => {
	const hardware = await VideoDecoder.isConfigSupported({
		...VIDEO_MP4_DECODER_CONFIG,
		hardwareAcceleration: 'prefer-hardware',
	});
	if (hardware.supported) {
		context.skip('This platform decodes H.264 in hardware');
	}

	using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({
		input,
		output,
		video: { forceTranscode: true, hardwareAcceleration: 'prefer-hardware' },
		audio: { discard: true },
		showWarnings: false,
	});
	expect(conversion.isValid).toBe(false);
	expect(conversion.discardedTracks.map(x => x.reason)).toContain('undecodable_source_codec');

	// Without the hint, it transcodes
	using softwareInput = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
	const softwareOutput = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const software = await Conversion.init({
		input: softwareInput,
		output: softwareOutput,
		video: { forceTranscode: true, hardwareAcceleration: 'prefer-software' },
		audio: { discard: true },
		trim: { start: 0, end: 0.2 },
		showWarnings: false,
	});
	expect(software.isValid).toBe(true);
	await software.execute();
});

// Stands in for a hardware decoder where there is none, for the duration of a test
let fakeHardwareDecoderEnabled = false;
class FakeHardwareDecoder extends CustomVideoDecoder {
	static override supports() {
		return fakeHardwareDecoderEnabled;
	}

	init() {}
	decode() {}
	flush() {}
	close() {}
}

test('Video that the requested hardware acceleration can\'t encode is discarded', async (context) => {
	const hardware = await VideoEncoder.isConfigSupported({
		codec: 'avc1.640028',
		width: 1920,
		height: 1080,
		bitrate: 5_000_000,
		hardwareAcceleration: 'prefer-hardware',
	});
	if (hardware.supported) {
		context.skip('This platform encodes H.264 in hardware');
	}

	// Like a platform that decodes in hardware but has no hardware encoder for the codec (common for HEVC and AV1)
	registerDecoder(FakeHardwareDecoder);
	fakeHardwareDecoderEnabled = true;
	try {
		using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			video: { codec: 'avc', forceTranscode: true, hardwareAcceleration: 'prefer-hardware' },
			audio: { discard: true },
			showWarnings: false,
		});
		expect(conversion.isValid).toBe(false);
		expect(conversion.discardedTracks.map(x => x.reason)).toContain('no_encodable_target_codec');
	} finally {
		fakeHardwareDecoderEnabled = false;
	}
});

test('Trim wholly before media data, transcode', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			forceTranscode: true,
		},
		audio: {
			forceTranscode: true,
		},
		trim: {
			start: -10,
			end: -5,
		},
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	expect(await newInput.getPrimaryVideoTrack()).toBeNull(); // No video data
	expect(await newInput.getPrimaryAudioTrack()).toBeNull(); // No audio data
});

test('Trim wholly before media data, copy', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		copy: { mode: 'forced' },
		trim: {
			start: -10,
			end: -5,
		},
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	expect(await newInput.getPrimaryVideoTrack()).toBeNull(); // No video data
	expect(await newInput.getPrimaryAudioTrack()).toBeNull(); // No audio data
});

test('Trim wholly past media data, transcode', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			forceTranscode: true,
		},
		audio: {
			forceTranscode: true,
		},
		trim: {
			start: 10,
			end: 15,
		},
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	expect(await newInput.getPrimaryVideoTrack()).toBeNull(); // No video data
	expect(await newInput.getPrimaryAudioTrack()).toBeNull(); // No audio data
});

test('Trim wholly past media data, copy', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		copy: { mode: 'forced' },
		trim: {
			start: 10,
			end: 15,
		},
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	// Don't test video yet; requires extensions to packet fetching logic. B-frames!!
	// expect(await newInput.getPrimaryVideoTrack()).toBeNull(); // No video data
	expect(await newInput.getPrimaryAudioTrack()).toBeNull(); // No audio data
});

test('Reserved fast start, copy', async () => {
	await testReservedFastStart({});
});

test('Reserved fast start, copy with trim', async () => {
	await testReservedFastStart({
		trim: {
			start: 1.3,
			end: 3.7,
		},
	});
});

test('Reserved fast start, transcode', async () => {
	await testReservedFastStart({
		video: {
			frameRate: 10,
			width: 320,
		},
		audio: {
			forceTranscode: true,
		},
		trim: {
			start: 1,
			end: 4,
		},
	});
});

test('Reserved fast start, PCM transcode', async () => {
	await testReservedFastStart({
		audio: {
			codec: 'pcm-s16',
		},
	});
});

test('Reserved fast start, PCM copy', async () => {
	await testReservedFastStart({ copy: { mode: 'forced' } }, '/glitch-hop-is-dead.wav');
});

test('Reserved fast start, manual maximum packet count', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'reserve' }),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			maximumPacketCount: 1000,
		},
		audio: {
			maximumPacketCount: 10,
		},
	});

	expect(output.tracks.map(x => x.metadata.maximumPacketCount)).toEqual([1000, 10]);

	// The audio track has way more packets than that
	await expect(conversion.execute()).rejects.toThrow('maximum packet count');
});

test('Maximum packet count is not set when not required', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	await Conversion.init({ input, output });

	expect(output.tracks.map(x => x.metadata.maximumPacketCount)).toEqual([undefined, undefined]);
});

const testReservedFastStart = async (
	conversionOptions: Omit<ConversionOptions, 'input' | 'output'>,
	inputUrl = '/demo.mp4',
) => {
	using input = new Input({
		source: new UrlSource(inputUrl),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'reserve' }),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		...conversionOptions,
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const newTracks = await newInput.getTracks();
	expect(newTracks).toHaveLength(output.tracks.length);

	for (let i = 0; i < newTracks.length; i++) {
		const maximumPacketCount = output.tracks[i]!.metadata.maximumPacketCount;
		assert(maximumPacketCount !== undefined);

		if ((PCM_AUDIO_CODECS as readonly string[]).includes((await newTracks[i]!.getCodec())!)) {
			continue;
		}

		// The estimate must be an upper bound, but shouldn't be a ridiculous one
		const { packetCount } = await newTracks[i]!.computePacketStats();
		expect(maximumPacketCount).toBeGreaterThanOrEqual(packetCount);
		expect(maximumPacketCount).toBeLessThanOrEqual(2 * packetCount + 64);
	}
};

test('Transcoding odd-sized video to AVC rounds its dimensions up to even ones', async () => {
	// Like a screen recording of an odd-sized window
	const sourceOutput = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	const canvas = new OffscreenCanvas(321, 241);
	canvas.getContext('2d')!.fillRect(0, 0, 321, 241);
	const canvasSource = new CanvasSource(canvas, { codec: 'vp9', quality: new Quality('medium') });
	sourceOutput.addVideoTrack(canvasSource);
	await sourceOutput.start();
	for (let i = 0; i < 5; i++) {
		await canvasSource.add(i / 10, 1 / 10);
	}
	await sourceOutput.finalize();

	using input = new Input({ source: new BufferSource(sourceOutput.target.buffer!), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output, video: { codec: 'avc' }, showWarnings: false });
	expect(conversion.discardedTracks.map(x => x.reason)).toEqual([]);
	await conversion.execute();

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const videoTrack = await result.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getCodec()).toBe('avc');
	expect(await videoTrack.getCodedWidth()).toBe(322);
	expect(await videoTrack.getCodedHeight()).toBe(242);
});

test('Transcoding to AVC with an odd-sized crop rounds the crop size up to even dimensions', async () => {
	using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({
		input,
		output,
		video: { codec: 'avc', crop: { left: 10, top: 10, width: 45, height: 81 } },
		trim: { end: 0.5 },
		showWarnings: false,
	});
	expect(conversion.discardedTracks.map(x => x.reason)).toEqual([]);
	await conversion.execute();

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const videoTrack = await result.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getCodec()).toBe('avc');
	expect([await videoTrack.getCodedWidth(), await videoTrack.getCodedHeight()]).toEqual([46, 82]);
});

/** Makes a 2 s WebM whose frames take some bits to encode, and transcodes it to VP8, returning the bitrate. */
const WAVE_WIDTH = 320;
const WAVE_HEIGHT = 180;

/** Frame i of a moving, slightly noisy wave pattern, as I420 data */
const waveFrameData = (i: number) => {
	const data = new Uint8Array(WAVE_WIDTH * WAVE_HEIGHT * 3 / 2).fill(128);
	for (let y = 0; y < WAVE_HEIGHT; y++) {
		for (let x = 0; x < WAVE_WIDTH; x++) {
			data[y * WAVE_WIDTH + x] = 128 + 60 * Math.sin(x * 0.05 + i * 0.3) * Math.cos(y * 0.07 - i * 0.2)
				+ ((x * 7 + y * 13 + i * 31) % 9) - 4;
		}
	}

	return data;
};

let vp8MeetsBitrateResult: Promise<boolean> | null = null;

/**
 * Whether the platform's VP8 encoder, told the frame rate, meets an explicit bitrate on the wave frames at 60 fps,
 * checked with WebCodecs alone. WebKitGTK's ignores the bitrate.
 */
const vp8MeetsBitrate = () => vp8MeetsBitrateResult ??= (async () => {
	const config: VideoEncoderConfig = {
		codec: 'vp8',
		width: WAVE_WIDTH,
		height: WAVE_HEIGHT,
		bitrate: 300_000,
		framerate: 60,
	};

	try {
		if (!(await VideoEncoder.isConfigSupported(config)).supported) {
			return false;
		}

		let bytes = 0;
		const encoder = new VideoEncoder({
			output: (chunk) => {
				bytes += chunk.byteLength;
			},
			error: () => {},
		});
		encoder.configure(config);
		for (let i = 0; i < 120; i++) {
			const frame = new VideoFrame(waveFrameData(i), {
				format: 'I420',
				codedWidth: WAVE_WIDTH,
				codedHeight: WAVE_HEIGHT,
				timestamp: Math.round(i * 1e6 / 60),
				duration: Math.round(1e6 / 60),
			});
			encoder.encode(frame, { keyFrame: i === 0 });
			frame.close();
		}
		await encoder.flush();
		encoder.close();

		// Two seconds of video
		const bitrate = bytes * 8 / 2;
		return bitrate > 0.7 * 300_000 && bitrate < 1.3 * 300_000;
	} catch {
		return false;
	}
})();

const transcodeToVp8 = async (
	frameRate: number,
	quality: Quality,
	process?: (sample: VideoSample) => VideoSample | null,
) => {
	const sourceOutput = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	const sourceVideo = new VideoSampleSource({ codec: 'vp9', quality: new Quality({ bitrate: 2_000_000 }) });
	sourceOutput.addVideoTrack(sourceVideo, { frameRate });
	await sourceOutput.start();

	const addFrame = async (i: number) => {
		using sample = new VideoSample(waveFrameData(i), {
			format: 'I420',
			codedWidth: WAVE_WIDTH,
			codedHeight: WAVE_HEIGHT,
			timestamp: i / frameRate,
			duration: 1 / frameRate,
		});
		await sourceVideo.add(sample);
	};

	for (let i = 0; i < 2 * frameRate; i++) {
		await addFrame(i);
	}
	await sourceOutput.finalize();

	using input = new Input({ source: new BufferSource(sourceOutput.target.buffer!), formats: ALL_FORMATS });
	const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({
		input,
		output,
		video: { codec: 'vp8', quality, process },
	});
	await conversion.execute();

	using newInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = await newInput.getPrimaryVideoTrack();
	assert(track);

	return (await track.computePacketStats()).averageBitrate;
};

test('Transcoding 60 fps video keeps the requested bitrate', { timeout: 30_000 }, async ({ skip }) => {
	if (!await vp8MeetsBitrate()) {
		skip('The platform\'s VP8 encoder doesn\'t meet an explicit bitrate');
	}

	const averageBitrate = await transcodeToVp8(60, new Quality({ bitrate: 300_000 }));
	expect(averageBitrate).toBeGreaterThan(0.7 * 300_000);
	expect(averageBitrate).toBeLessThan(1.3 * 300_000);
});

test('Transcoding 60 fps video whose process function drops every other frame keeps the requested bitrate', {
	timeout: 30_000,
}, async ({ skip }) => {
	if (!await vp8MeetsBitrate()) {
		skip('The platform\'s VP8 encoder doesn\'t meet an explicit bitrate');
	}

	// The output runs at 30 fps, so the input's 60 fps must not be what the encoder budgets for
	let index = 0;
	const averageBitrate = await transcodeToVp8(60, new Quality({ bitrate: 300_000 }), (sample) => {
		return index++ % 2 === 0 ? sample : null;
	});
	expect(averageBitrate).toBeGreaterThan(0.7 * 300_000);
	expect(averageBitrate).toBeLessThan(1.3 * 300_000);
});

test('Transcoding 60 fps video with a quality level gets twice the bitrate of 30 fps', {
	timeout: 30_000,
}, async () => {
	// Quality levels are meant for up to 30 fps, and 60 fps has always ended up with twice the bitrate (before
	// encoders were told the frame rate, because they assumed 30 fps)
	const bitrate30 = await transcodeToVp8(30, new Quality('medium'));
	const bitrate60 = await transcodeToVp8(60, new Quality('medium'));
	expect(bitrate60 / bitrate30).toBeGreaterThan(1.6);
	expect(bitrate60 / bitrate30).toBeLessThan(2.4);
});

test('Audio whose sample rate and channel count change mid-stream converts with the first part\'s', async () => {
	// An HLS stream with a segment between discontinuities that has other audio parameters, like an inserted ad: 1 s of
	// 48 kHz mono, then after a short break 1 s of 44.1 kHz stereo, then 1 s of 48 kHz mono again. The playlist places
	// the middle segment at `middleStart`.
	const writeSegment = async (url: string) => {
		using input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);

		const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('aac');
		output.addAudioTrack(source);
		await output.start();
		for await (const packet of new EncodedPacketSink(track).packets()) {
			if (packet.timestamp < 0) {
				continue;
			}
			if (packet.timestamp >= 1) {
				break;
			}

			await source.add(packet, { decoderConfig });
		}
		await output.finalize();

		return output.target.buffer!;
	};

	const segments = new Map([
		['a.ts', await writeSegment('/demo.mp4')],
		['b.ts', await writeSegment('/sample3.aac')],
		['c.ts', await writeSegment('/demo.mp4')],
	]);
	const getSource = (middleStart: string) => {
		const playlist = new TextEncoder().encode([
			'#EXTM3U',
			'#EXT-X-VERSION:3',
			'#EXT-X-TARGETDURATION:2',
			`#EXTINF:${middleStart},`,
			'a.ts',
			'#EXT-X-DISCONTINUITY',
			'#EXTINF:1.0,',
			'b.ts',
			'#EXT-X-DISCONTINUITY',
			'#EXTINF:1.0,',
			'c.ts',
			'#EXT-X-ENDLIST',
		].join('\n')).buffer;

		return new CustomPathedSource('stream.m3u8', ({ path }) => {
			return new BufferSource(path === 'stream.m3u8' ? playlist : segments.get(path)!);
		});
	};

	const read = async (source: Source) => {
		using input = new Input({ source, formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const chunks: Float32Array[] = [];
		// Where the decoded audio switches to other parameters
		let switchTimestamp: number | null = null;
		for await (using sample of new AudioSampleSink(track).samples()) {
			if (sample.sampleRate !== await track.getSampleRate() && switchTimestamp === null) {
				switchTimestamp = sample.timestamp;
			}

			const chunk = new Float32Array(sample.numberOfFrames * sample.numberOfChannels);
			sample.copyTo(chunk, { planeIndex: 0, format: 'f32' });
			chunks.push(chunk);
		}
		const data = new Float32Array(chunks.reduce((total, x) => total + x.length, 0));
		chunks.reduce((offset, chunk) => (data.set(chunk, offset), offset + chunk.length), 0);

		return {
			sampleRate: await track.getSampleRate(),
			numberOfChannels: await track.getNumberOfChannels(),
			duration: await track.computeDuration(),
			switchTimestamp,
			data,
		};
	};

	const convert = async (source: Source, sampleRate: number) => {
		using input = new Input({ source, formats: ALL_FORMATS });
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, audio: { sampleRate }, showWarnings: false });
		await conversion.execute();

		return read(new BufferSource(output.target.buffer!));
	};

	// Halfway between two 48 kHz frames. The decoder rounds timestamps to the track's 48 kHz, which puts the middle
	// segment's samples up to a 44.1 kHz frame off from where they meet, now early, now late.
	const input = await read(getSource('1.0500104'));
	assert(input.switchTimestamp !== null);

	// At the first part's sample rate, and at another one, which the encoder resamples to
	for (const sampleRate of [48000, 22050]) {
		const result = await convert(getSource('1.0500104'), sampleRate);
		expect(result.sampleRate).toBe(sampleRate);
		expect(result.numberOfChannels).toBe(1);
		expect(result.duration).toBeCloseTo(input.duration, 1);

		// Each part comes out in its place, the middle one resampled and downmixed: it's louder than the others
		const levels = [0.2, input.switchTimestamp + 0.2, input.switchTimestamp + 1.2].map((start) => {
			const part = result.data.subarray(Math.round(start * sampleRate), Math.round((start + 0.6) * sampleRate));
			return Math.sqrt(part.reduce((total, x) => total + x * x, 0) / part.length);
		});
		expect(levels[0]).toBeGreaterThan(0.01);
		expect(levels[2]).toBeGreaterThan(0.01);
		expect(levels[1]).toBeGreaterThan(2 * Math.max(levels[0]!, levels[2]!));

		if (sampleRate === 48000) {
			// The middle part comes out exactly as with the segment placed on a 48 kHz frame, where the timestamps are
			// a fraction of a frame off at most: no frame doubled (a click) or dropped where the samples meet
			const onGridInput = await read(getSource('1.05'));
			const onGrid = await convert(getSource('1.05'), sampleRate);
			const offset = Math.round(input.switchTimestamp * sampleRate);
			const onGridOffset = Math.round(onGridInput.switchTimestamp! * sampleRate);
			let maxDifference = 0;
			for (let i = 0; i < Math.round(0.95 * sampleRate); i++) {
				maxDifference = Math.max(
					maxDifference,
					Math.abs(result.data[offset + i]! - onGrid.data[onGridOffset + i]!),
				);
			}
			expect(maxDifference).toBeLessThan(1e-4);
		}
	}
});
