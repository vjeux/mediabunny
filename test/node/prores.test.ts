import { expect, test } from 'vitest';
import { registerProresDecoder } from '@mediabunny/prores';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, MovOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

const SAMPLE_URL = 'https://pub-1ee78aacb848486482b20a72b55b3121.r2.dev/turbores-sample.mov';

test.concurrent('ProRes MOV file reading', { timeout: 20_000 }, async () => {
	using input = new Input({
		source: new UrlSource(SAMPLE_URL),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('prores');
	expect(await videoTrack.getCodedWidth()).toBe(1920);
	expect(await videoTrack.getCodedHeight()).toBe(1080);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('apch');
	expect(decoderConfig.description).toBeUndefined();
});

test.concurrent('ProRes transmuxing into MOV', { timeout: 20_000 }, async () => {
	using input = new Input({
		source: new UrlSource(SAMPLE_URL),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		audio: {
			discard: true,
		},
		trim: {
			end: 0.5,
		},
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await newInput.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('prores');
	expect((await videoTrack.computePacketStats()).packetCount).toBe(15);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('apch');
	expect(decoderConfig.description).toBeUndefined();
});

test.concurrent('ProRes transmuxing into MKV', { timeout: 20_000 }, async () => {
	using input = new Input({
		source: new UrlSource(SAMPLE_URL),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		audio: {
			discard: true,
		},
		trim: {
			end: 0.5,
		},
	});
	await conversion.execute();

	// No 'icpf' means the frame container atom headers were successfully stripped from the ProRes packets
	let str = new TextDecoder('ascii').decode(output.target.buffer!);
	expect(str.includes('icpf')).toBe(false);

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await newInput.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('prores');
	expect((await videoTrack.computePacketStats()).packetCount).toBe(15);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('apch');
	expect(decoderConfig.description).toBeUndefined();

	const sink = new EncodedPacketSink(videoTrack);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	// The frame container atom headers are added back when reading out the packets
	str = new TextDecoder('ascii').decode(firstPacket.data);
	expect(str.includes('icpf')).toBe(true);
});

test('Custom coder registration', { timeout: 20_000 }, async () => {
	using input = new Input({
		source: new UrlSource(SAMPLE_URL),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('prores');

	// Without a registered decoder, there's no way to decode ProRes in this environment
	expect(await videoTrack.canDecode()).toBe(false);

	registerProresDecoder();

	expect(await videoTrack.canDecode()).toBe(true);
});

test('ProRes samples take the pixel aspect ratio from the container', async () => {
	// prores_ks, like Apple's encoders, writes the pixel aspect ratio (here 4:3) only into the pasp box, with
	// aspect_ratio_information 0 (unknown) in the frame header. Made with (FFmpeg 7.0.2):
	// ffmpeg -f lavfi -i testsrc2=s=64x32:r=10:d=0.2 -c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le -vf setsar=4/3 \
	//   -fflags +bitexact -flags:v +bitexact prores-422hq-64x32-sar4x3.mov
	registerProresDecoder();

	using input = new Input({
		source: new FilePathSource('./test/public/prores-422hq-64x32-sar4x3.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.getDisplayWidth()).toBe(85);
	expect(await videoTrack.getDisplayHeight()).toBe(32);

	using sample = await new VideoSampleSink(videoTrack).getSample(0);
	assert(sample);

	expect(sample.codedWidth).toBe(64);
	expect(sample.displayWidth).toBe(85);
	expect(sample.displayHeight).toBe(32);
});

test('ProRes decoding', { timeout: 20_000 }, async () => {
	registerProresDecoder();

	using input = new Input({
		source: new UrlSource(SAMPLE_URL),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const firstTimestamp = await videoTrack.getFirstTimestamp();

	const sink = new VideoSampleSink(videoTrack);
	using sample = await sink.getSample(firstTimestamp);
	assert(sample);

	expect(sample.timestamp).toBe(firstTimestamp);
	expect(sample.duration).toBeGreaterThan(0);

	expect(sample.displayWidth).toBe(1920);
	expect(sample.displayHeight).toBe(1080);
	expect(sample.codedWidth).toBe(1920);
	expect(sample.codedHeight).toBe(1080); // Technically a lie but the field is ill-defined
	expect(sample.visibleRect).toEqual({
		left: 0,
		top: 0,
		width: 1920,
		height: 1080,
	});
	expect(sample.format).toBe('I422P10');

	const allocationSize = sample.allocationSize();
	expect(allocationSize).toBeGreaterThan(0);

	const pixels = new Uint8Array(allocationSize);
	await sample.copyTo(pixels);
	expect(pixels.some(byte => byte !== 0)).toBe(true);
});
