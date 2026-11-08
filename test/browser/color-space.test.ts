import { expect, test } from 'vitest';
import { VideoCodec } from '../../src/codec.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { assert, colorSpaceIsComplete } from '../../src/misc.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { EncodedPacket } from '../../src/packet.js';
import { BufferSource, Source, UrlSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

test('Color space extraction, AVC in MP4', async () => {
	const source = await readPackets('/video.mp4');
	const buffer = await remuxWithoutColorSpace(new Mp4OutputFormat(), source);

	await expectColorSpace(new BufferSource(buffer), {
		primaries: undefined,
		transfer: undefined,
		matrix: 'bt470bg',
		fullRange: true,
	});
});

test('Color space extraction, HEVC in MP4', async () => {
	const source = await readPackets('/video-h265.mp4');
	const buffer = await remuxWithoutColorSpace(new Mp4OutputFormat(), source);

	await expectColorSpace(new BufferSource(buffer), {
		primaries: undefined,
		transfer: undefined,
		matrix: 'bt470bg',
		fullRange: true,
	});
});

test('Color space extraction, VP9 in MP4', async () => {
	const source = await readPackets('/vp9-smpte170m.webm');
	const buffer = await remuxWithoutColorSpace(new Mp4OutputFormat(), source);

	await expectColorSpace(new BufferSource(buffer), {
		primaries: 'smpte170m',
		transfer: 'smpte170m',
		matrix: 'smpte170m',
		fullRange: false,
	});
});

test('Color space extraction, AV1 in MP4', async () => {
	const source = await encodePackets('av1', 'av01.0.04M.08');
	const buffer = await remuxWithoutColorSpace(new Mp4OutputFormat(), source);

	await expectCompleteColorSpace(new BufferSource(buffer));
});

test('Color space extraction, AVC in Matroska', async () => {
	const source = await readPackets('/video.mp4');
	const buffer = await remuxWithoutColorSpace(new MkvOutputFormat(), source);

	await expectColorSpace(new BufferSource(buffer), {
		primaries: undefined,
		transfer: undefined,
		matrix: 'bt470bg',
		fullRange: true,
	});
});

test('Color space extraction, HEVC in Matroska', async () => {
	const source = await readPackets('/video-h265.mp4');
	const buffer = await remuxWithoutColorSpace(new MkvOutputFormat(), source);

	await expectColorSpace(new BufferSource(buffer), {
		// The SPS only signals the matrix and the range, leaving the rest unspecified
		primaries: undefined,
		transfer: undefined,
		matrix: 'bt470bg',
		fullRange: true,
	});
});

test('Color space extraction, VP9 in Matroska', async () => {
	const source = await readPackets('/vp9-smpte170m.webm');
	const buffer = await remuxWithoutColorSpace(new MkvOutputFormat(), source);

	await expectColorSpace(new BufferSource(buffer), {
		primaries: 'smpte170m',
		transfer: 'smpte170m',
		matrix: 'smpte170m',
		fullRange: false,
	});
});

test('Color space extraction, AV1 in Matroska', async () => {
	const source = await encodePackets('av1', 'av01.0.04M.08');
	const buffer = await remuxWithoutColorSpace(new MkvOutputFormat(), source);

	await expectCompleteColorSpace(new BufferSource(buffer));
});

const readPackets = async (path: string) => {
	using input = new Input({
		source: new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const codec = await track.getCodec();
	assert(codec);

	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const sink = new EncodedPacketSink(track);
	const packets: EncodedPacket[] = [];

	for await (const packet of sink.packets()) {
		packets.push(packet);

		if (packets.length === 10) {
			break;
		}
	}

	return { codec, decoderConfig, packets };
};

const encodePackets = async (codec: VideoCodec, codecString: string) => {
	const width = 320;
	const height = 240;

	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext('2d')!;

	let decoderConfig: VideoDecoderConfig | null = null;
	const packets: EncodedPacket[] = [];

	// We manually go through WebCodecs here so we can intercept the decoder config
	const encoder = new VideoEncoder({
		output: (chunk, metadata) => {
			decoderConfig ??= metadata?.decoderConfig ?? null;
			packets.push(EncodedPacket.fromEncodedChunk(chunk));
		},
		error: (error) => {
			throw error;
		},
	});
	encoder.configure({ codec: codecString, width, height });

	for (let i = 0; i < 10; i++) {
		context.fillStyle = `hsl(${36 * i}, 100%, 50%)`;
		context.fillRect(0, 0, width, height);
		context.fillStyle = 'black';
		context.fillRect(20 * i, 10 * i, 80, 80);

		const frame = new VideoFrame(canvas, { timestamp: i * 1e6 / 30, duration: 1e6 / 30 });
		encoder.encode(frame, { keyFrame: i === 0 });
		frame.close();
	}

	await encoder.flush();
	encoder.close();

	assert(decoderConfig);

	return { codec, decoderConfig, packets };
};

const remuxWithoutColorSpace = async (
	format: Mp4OutputFormat | MkvOutputFormat,
	source: { codec: VideoCodec; decoderConfig: VideoDecoderConfig; packets: EncodedPacket[] },
) => {
	const output = new Output({
		format,
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource(source.codec);
	output.addVideoTrack(videoSource);

	await output.start();

	const decoderConfig = { ...source.decoderConfig };
	delete decoderConfig.colorSpace;

	let isFirstPacket = true;
	for (const packet of source.packets) {
		await videoSource.add(packet, isFirstPacket ? { decoderConfig } : undefined);
		isFirstPacket = false;
	}

	await output.finalize();

	const buffer = output.target.buffer;
	assert(buffer);

	return buffer;
};

const expectColorSpace = async (source: Source, expected: VideoColorSpaceInit) => {
	using input = new Input({
		source,
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	expect(await track.getColorSpace()).toEqual(expected);
	expect({ ...decoderConfig.colorSpace }).toEqual(expected);
};

const expectCompleteColorSpace = async (source: Source) => {
	using input = new Input({
		source,
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	expect(colorSpaceIsComplete(await track.getColorSpace())).toBe(true);
	expect(colorSpaceIsComplete(decoderConfig.colorSpace)).toBe(true);
};

test('VP8 and untagged VP9 decode with the BT.601 matrix', async ({ skip }) => {
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

	// Four bars holding the limited-range BT.601 code values of red, green, blue and gray, made with FFmpeg 7.0.2:
	// ffmpeg -f lavfi -i "color=s=64x64:d=0.5:r=10,format=yuv420p,geq=lum='if(lt(X,16),81,if(lt(X,32),145,
	//   if(lt(X,48),41,128)))':cb='if(lt(X,8),90,if(lt(X,16),54,if(lt(X,24),240,128)))':cr='if(lt(X,8),240,
	//   if(lt(X,16),34,if(lt(X,24),110,128)))'" -c:v libvpx-vp9 -lossless 1 vp9-untagged-bars.webm
	// (and -c:v libvpx -b:v 5M -qmin 0 -qmax 4 vp8-bars.webm). VP8 is always BT.601 (RFC 6386, section 9.2), and
	// FFmpeg and Chrome's <video> render VP9 that signals no color space (CS_UNKNOWN) as BT.601 too. Some browsers
	// (Firefox) ignore the decoder config's matrix for such VP9 and use BT.709 regardless, so VP9 is only checked
	// where a plain VideoDecoder (not Mediabunny's) renders it with the BT.601 matrix of its config.
	const decoderAppliesConfigMatrix = async () => {
		using input = new Input({ source: new UrlSource('/vp9-untagged-bars.webm'), formats: ALL_FORMATS });
		const videoTrack = (await input.getPrimaryVideoTrack())!;
		const decoderConfig = (await videoTrack.getDecoderConfig())!;
		const packet = (await new EncodedPacketSink(videoTrack).getFirstPacket())!;

		const frames: VideoFrame[] = [];
		const decoder = new VideoDecoder({ output: frame => frames.push(frame), error: () => {} });
		try {
			// Mediabunny's own config (its coded size keeps hardware decoders that can't take a frame this small out),
			// with the BT.601 matrix
			decoder.configure({
				...decoderConfig,
				colorSpace: { matrix: 'smpte170m', primaries: 'bt709', transfer: 'bt709', fullRange: false },
			});
			decoder.decode(packet.toEncodedVideoChunk());
			await decoder.flush();
		} catch {
			// The browser can't decode the file on its own, so it can't be probed
			return false;
		} finally {
			if (decoder.state !== 'closed') {
				decoder.close();
			}
		}

		const frame = frames[0];
		if (!frame) {
			return false;
		}

		const { width, height } = frame.visibleRect!;
		const rgba = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
		await frame.copyTo(rgba, { format: 'RGBA' });
		frames.forEach(x => x.close());
		// The green channel of the red bar: 0 with the BT.601 matrix, 24 with BT.709
		return rgba[(Math.floor(height / 2) * width + 8) * 4 + 1]! <= 4;
	};
	const paths = ['/vp8-bars.webm', ...(await decoderAppliesConfigMatrix() ? ['/vp9-untagged-bars.webm'] : [])];
	for (const path of paths) {
		using input = new Input({ source: new UrlSource(path), formats: ALL_FORMATS });
		const videoTrack = (await input.getPrimaryVideoTrack())!;
		const sink = new VideoSampleSink(videoTrack);
		using sample = (await sink.getSample(0))!;

		const rgba = new Uint8Array(sample.allocationSize({ format: 'RGBA' }));
		await sample.copyTo(rgba, { format: 'RGBA' });
		const bars = [8, 24, 40, 56].map(x => Array.from(rgba.subarray((32 * 64 + x) * 4, (32 * 64 + x) * 4 + 3)));

		// With the BT.709 matrix, red would come out as (255, 24, 0) and green as (0, 216, 0)
		const expected = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [130, 130, 130]];
		for (let i = 0; i < 4; i++) {
			for (let j = 0; j < 3; j++) {
				expect(Math.abs(bars[i]![j]! - expected[i]![j]!), `${path}: ${bars.join(' ')}`).toBeLessThanOrEqual(4);
			}
		}
	}
});
