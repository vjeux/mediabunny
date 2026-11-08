import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { VideoSampleSink, AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { AvcNalUnitType, extractNalUnitTypeForAvc, iterateNalUnitsInAnnexB } from '../../src/codec-data.js';

test('MPEG-TS video samples are decodable', async () => {
	using input = new Input({
		source: new UrlSource('/0.ts'),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new VideoSampleSink(videoTrack);

	let count = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of sink.samples()) {
		count++;
	}

	assert(count > 0);
});

test('MPEG-TS audio samples are decodable', async () => {
	using input = new Input({
		source: new UrlSource('/0.ts'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new AudioSampleSink(audioTrack);

	let count = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of sink.samples()) {
		count++;
	}

	assert(count > 0);
});

test('MPEG-TS key frames without parameter sets of their own decode from where they are', async () => {
	// From L15's review. trim-buck-bunny-ffmpeg.ts (x264, six key frames, each with its SPS and PPS) remuxed with the
	// parameter sets removed from every key frame but the first, as some broadcast streams send them. On main, a
	// decoder that starts at a later key frame has none: "EncodingError: Error during flush."
	using original = new Input({ source: new UrlSource('/trim-buck-bunny-ffmpeg.ts'), formats: ALL_FORMATS });
	const originalTrack = await original.getPrimaryVideoTrack();
	assert(originalTrack);

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	const keyTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(originalTrack).packets()) {
		let data = packet.data;
		if (packet.type === 'key') {
			if (keyTimestamps.length > 0) {
				const nalUnits = [...iterateNalUnitsInAnnexB(data)].filter((location) => {
					const type = extractNalUnitTypeForAvc(data[location.offset]!);
					return type !== AvcNalUnitType.SPS && type !== AvcNalUnitType.PPS;
				});
				data = new Uint8Array(nalUnits.flatMap(location => [
					0, 0, 0, 1, ...data.subarray(location.offset, location.offset + location.length),
				]));
			}
			keyTimestamps.push(packet.timestamp);
		}

		await source.add(
			new EncodedPacket(data, packet.type, packet.timestamp, packet.duration),
			keyTimestamps.length === 1 && packet.type === 'key'
				? { decoderConfig: (await originalTrack.getDecoderConfig())! }
				: undefined,
		);
	}
	await output.finalize();
	expect(keyTimestamps.length).toBeGreaterThan(2);

	const hashFrame = async (input: Input, timestamp: number) => {
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		using sample = await new VideoSampleSink(track).getSample(timestamp);
		assert(sample);
		const data = new Uint8Array(sample.allocationSize());
		await sample.copyTo(data);
		return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))];
	};

	// Decoding starting at each key frame gives the picture the original file gives there
	for (const timestamp of keyTimestamps) {
		using fresh = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		using freshOriginal = new Input({ source: new UrlSource('/trim-buck-bunny-ffmpeg.ts'), formats: ALL_FORMATS });
		expect(await hashFrame(fresh, timestamp)).toEqual(await hashFrame(freshOriginal, timestamp));
	}
});
