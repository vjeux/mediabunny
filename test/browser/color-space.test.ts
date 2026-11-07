import { expect, test } from 'vitest';
import { VideoCodec } from '../../src/codec.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { assert } from '../../src/misc.js';
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

// The sequence header carries the color space, which the container then doesn't:
// ffmpeg -f lavfi -i "color=c=0x808080:s=64x64:r=10:d=0.2" -c:v libaom-av1 -cpu-used 8 -crf 50 -color_primaries bt709 \
//   -color_trc bt709 -colorspace bt709 -color_range tv -pix_fmt yuv420p -movflags +faststart av1-bt709.mp4
const AV1_FIXTURE_COLOR_SPACE: VideoColorSpaceInit = {
	primaries: 'bt709',
	transfer: 'bt709',
	matrix: 'bt709',
	fullRange: false,
};

test('Color space extraction, AV1 in MP4', async () => {
	const source = await readPackets('/av1-bt709.mp4');
	const buffer = await remuxWithoutColorSpace(new Mp4OutputFormat(), source);

	await expectColorSpace(new BufferSource(buffer), AV1_FIXTURE_COLOR_SPACE);
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
	const source = await readPackets('/av1-bt709.mp4');
	const buffer = await remuxWithoutColorSpace(new MkvOutputFormat(), source);

	await expectColorSpace(new BufferSource(buffer), AV1_FIXTURE_COLOR_SPACE);
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
