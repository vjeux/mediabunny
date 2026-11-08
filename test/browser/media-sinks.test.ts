import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { AudioSample, AudioSampleCopyToOptions } from '../../src/sample.js';
import { OPUS_PRE_ROLL_DURATION } from '../../src/codec.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';
import { EncodedPacket } from '../../src/packet.js';

// https://github.com/Vanilagy/mediabunny/issues/370
test('Negative audio timestamps are preserved', async () => {
	using input = new Input({
		source: new UrlSource('/edts.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getFirstTimestamp()).toBeLessThan(0);

	const sink = new AudioSampleSink(track);

	for await (using sample of sink.samples()) {
		expect(sample.timestamp).toBe(await track.getFirstTimestamp());
		break;
	}
});

test('No B-frames are skipped when software-decoding AVC', async () => {
	using input = new Input({
		source: new UrlSource('/missing-reorder-metadata-v1.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new VideoSampleSink(track, {
		hardwareAcceleration: 'prefer-software',
	});
	let count = 0;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of sink.samples()) {
		count++;
	}

	expect(count).toBe(48);
});

test('No B-frames are skipped when software-decoding AVC, Annex B edition', async () => {
	using input = new Input({
		source: new UrlSource('/missing-reorder-metadata-v1.mp4'),
		formats: ALL_FORMATS,
	});

	// Force Annex B by converting to MPEG-TS
	const output = new Output({
		format: new MpegTsOutputFormat(),
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

	const sink = new VideoSampleSink(track, {
		hardwareAcceleration: 'prefer-software',
	});
	let count = 0;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of sink.samples()) {
		count++;
	}

	expect(count).toBe(48);
});

test('Fallback sample past the end survives iterator return', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new VideoSampleSink(track);
	const iterator = sink.samples(await track.computeDuration() + 0.5);

	const { value: sample } = await iterator.next();
	assert(sample);
	await iterator.return();

	expect(sample._closed).toBe(false);
	sample.close();
});

test('Audio decoder pre-roll (AAC)', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toBe('aac');
	expect(await track.getPreRollDuration()).toBe(1024 / await track.getSampleRate());

	await testAudioDecoderPreRoll(track, -90);
});

test('Audio decoder pre-roll (Opus)', async () => {
	using input = new Input({
		source: new UrlSource('/preroll-test.opus'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toBe('opus');
	expect(await track.getPreRollDuration()).toBe(OPUS_PRE_ROLL_DURATION);

	await testAudioDecoderPreRoll(track, -90);
});

const testAudioDecoderPreRoll = async (track: InputAudioTrack, maxErrorDb: number) => {
	const sink = new AudioSampleSink(track);

	// Decoding straight through from the start gives us a reference sample with fully converged decoder state
	let referenceTimestamp: number | null = null;
	let referenceData: Float32Array | null = null;
	for await (using sample of sink.samples(0)) {
		if (sample.timestamp >= 1) {
			referenceTimestamp = sample.timestamp;
			referenceData = getSampleData(sample);
			break;
		}
	}
	assert(referenceTimestamp !== null);
	assert(referenceData);

	for await (using sample of sink.samples(referenceTimestamp)) {
		expect(sample.timestamp).toBe(referenceTimestamp);
		expectSimilarData(getSampleData(sample), referenceData, maxErrorDb);
		break;
	}

	for await (using sample of sink.samplesAtTimestamps([referenceTimestamp])) {
		assert(sample);
		expect(sample.timestamp).toBe(referenceTimestamp);
		expectSimilarData(getSampleData(sample), referenceData, maxErrorDb);
	}
};

const getSampleData = (sample: AudioSample) => {
	const options: AudioSampleCopyToOptions = {
		planeIndex: 0,
		format: 'f32',
	};

	const data = new Float32Array(sample.allocationSize(options) / Float32Array.BYTES_PER_ELEMENT);
	sample.copyTo(data, options);

	return data;
};

const expectSimilarData = (actual: Float32Array, expected: Float32Array, maxErrorDb: number) => {
	expect(actual.length).toBe(expected.length);

	let maxDifference = 0;
	for (let i = 0; i < actual.length; i++) {
		maxDifference = Math.max(maxDifference, Math.abs(actual[i]! - expected[i]!));
	}

	expect(20 * Math.log10(maxDifference)).toBeLessThan(maxErrorDb);
};

test('Sample retrieval within Opus pre-skip', async () => {
	using input = new Input({
		source: new UrlSource('/demo.webm'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toBe('opus');
	expect(await track.getPreRollDuration()).toBe(OPUS_PRE_ROLL_DURATION);

	const firstPacket = await new EncodedPacketSink(track).getFirstPacket();
	assert(firstPacket);

	const sink = new AudioSampleSink(track);

	// The decoder trims the pre-skip off the first packet, so the first sample starts after it
	let firstSampleTimestamp: number | null = null;
	for await (using sample of sink.samples()) {
		firstSampleTimestamp = sample.timestamp;
		break;
	}
	assert(firstSampleTimestamp !== null);
	expect(firstSampleTimestamp).toBeGreaterThan(firstPacket.timestamp);

	const timestamps = [
		firstPacket.timestamp,
		(firstPacket.timestamp + firstSampleTimestamp) / 2,
		firstSampleTimestamp,
		1,
	];
	const results: ({ timestamp: number; duration: number } | null)[] = [];
	for await (using sample of sink.samplesAtTimestamps(timestamps)) {
		results.push(sample && {
			timestamp: sample.timestamp,
			duration: sample.duration,
		});
	}

	// No sample starts at or before these
	expect(results[0]).toBe(null);
	expect(results[1]).toBe(null);

	expect(results[2]!.timestamp).toBe(firstSampleTimestamp);

	expect(results[3]!.timestamp).toBeLessThanOrEqual(1);
	expect(results[3]!.timestamp + results[3]!.duration).toBeGreaterThan(1);
});

test('Samples at timestamps come out while timestamps are still coming in', async () => {
	using input = new Input({
		source: new UrlSource('/glitch-hop-is-dead.wav'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packetSink = new EncodedPacketSink(track);
	const firstPacket = await packetSink.getFirstPacket();
	assert(firstPacket);
	const secondPacket = await packetSink.getNextPacket(firstPacket);
	assert(secondPacket);

	// The timestamps only end once the first sample has come out, which hangs if the sink holds off decoding until
	// the run of consecutive packets is over
	const { promise: firstSampleReceived, resolve: onFirstSampleReceived } = promiseWithResolvers();
	const timestamps = async function* () {
		yield firstPacket.timestamp;
		yield secondPacket.timestamp;
		await firstSampleReceived;
	};

	const sink = new AudioSampleSink(track);
	const sampleTimestamps: number[] = [];
	for await (using sample of sink.samplesAtTimestamps(timestamps())) {
		assert(sample);
		sampleTimestamps.push(sample.timestamp);
		onFirstSampleReceived();
	}

	expect(sampleTimestamps).toEqual([firstPacket.timestamp, secondPacket.timestamp]);
});

test.for([
	['a delta frame', '/video.mp4', 40, 'delta'],
	['a key frame', '/demo.mp4', 26, 'key'],
] as const)('Video whose last frame, %s, was cut short decodes all other frames', async (
	[, file, packetCount, cutType],
) => {
	// The first frames of a file in MPEG-TS, cut one TS packet into the last frame, as a recording that stopped
	// mid-frame leaves it. Chromium's decoder fails its flush on the cut frame and loses the frames it still held,
	// so the sample iterators threw (found by lanes L15 and L80 in real files, and by L46 for a key frame, where the
	// frames lost are the previous GOP's).
	using source = new Input({ source: new UrlSource(file), formats: ALL_FORMATS });
	const sourceTrack = await source.getPrimaryVideoTrack();
	assert(sourceTrack);
	const decoderConfig = await sourceTrack.getDecoderConfig();
	assert(decoderConfig);

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const packetSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(packetSource);
	await output.start();
	let addedPackets = 0;
	for await (const packet of new EncodedPacketSink(sourceTrack).packets()) {
		await packetSource.add(packet, addedPackets === 0 ? { decoderConfig } : undefined);
		if (++addedPackets === packetCount) {
			break;
		}
	}
	await output.finalize();

	// The last TS packet starting a video PES (payload_unit_start_indicator set, stream ID 0xe0) starts the last frame
	const bytes = new Uint8Array(output.target.buffer!);
	let lastFrameOffset = -1;
	for (let offset = 0; offset < bytes.length; offset += 188) {
		const payloadOffset = offset + 4 + ((bytes[offset + 3]! & 0x20) ? 1 + bytes[offset + 4]! : 0);
		if ((bytes[offset + 1]! & 0x40) && bytes[payloadOffset + 3] === 0xe0) {
			lastFrameOffset = offset;
		}
	}
	assert(lastFrameOffset !== -1);

	using input = new Input({
		source: new BufferSource(bytes.slice(0, lastFrameOffset + 188)),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	expect(packets).toHaveLength(packetCount);
	const cutPacket = packets.at(-1)!;
	expect(cutPacket.type).toBe(cutType);
	const cutTimestamp = cutPacket.timestamp;
	const otherTimestamps = packets.slice(0, -1).map(x => x.timestamp).sort((a, b) => a - b);

	// All frames but the cut one, which a decoder can also decode as far as it goes
	const sink = new VideoSampleSink(track);
	const timestamps: number[] = [];
	for await (using sample of sink.samples()) {
		timestamps.push(sample.timestamp);
	}
	expect(timestamps.filter(x => x !== cutTimestamp)).toEqual(otherTimestamps);

	const queries = [...otherTimestamps, cutTimestamp].sort((a, b) => a - b);
	let index = 0;
	for await (using sample of sink.samplesAtTimestamps(queries)) {
		assert(sample);
		const query = queries[index++]!;
		if (query !== cutTimestamp) {
			expect(sample.timestamp).toBe(query);
		}
	}
	expect(index).toBe(queries.length);

	// Starting at the cut frame gives the frame before it (or the cut frame, if decoded)
	const expected = [cutTimestamp, otherTimestamps.filter(x => x < cutTimestamp).at(-1)];
	for await (using sample of sink.samplesAtTimestamps([cutTimestamp])) {
		expect(expected).toContain(sample?.timestamp);
	}
	for await (using sample of sink.samples(cutTimestamp)) {
		expect(expected).toContain(sample.timestamp);
		break;
	}
});

/** Whether the platform's decoder reports an error for a track's packets, decided with WebCodecs alone. */
const nativeDecodingFails = async (track: InputVideoTrack | InputAudioTrack) => {
	let failed = false;
	const onError = () => {
		failed = true;
	};

	let decoder: VideoDecoder | AudioDecoder;
	let decode: (packet: EncodedPacket) => void;
	if (track.isVideoTrack()) {
		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);
		const videoDecoder = new VideoDecoder({ output: frame => frame.close(), error: onError });
		videoDecoder.configure(decoderConfig);
		decoder = videoDecoder;
		decode = packet => videoDecoder.decode(packet.toEncodedVideoChunk());
	} else {
		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);
		const audioDecoder = new AudioDecoder({ output: data => data.close(), error: onError });
		audioDecoder.configure(decoderConfig);
		decoder = audioDecoder;
		decode = packet => audioDecoder.decode(packet.toEncodedAudioChunk());
	}

	for await (const packet of new EncodedPacketSink(track).packets()) {
		if (decoder.state === 'closed') {
			break;
		}

		decode(packet);
	}
	if (decoder.state !== 'closed') {
		await decoder.flush().catch(onError);
	}
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return failed;
};

test('A decoder failing on a frame before the last key frame still throws, instead of losing frames', async ({
	skip,
}) => {
	// demo.mp4's first 53 frames in MPEG-TS (key frames at 0, 25 and 50), the frame 4 packets from the end, before
	// the last key frame, cut to a third. The error surfaces as the decoder flushes, but decoding again from the last
	// key frame must not count as recovering from it: the frames after the broken one would be lost unnoticed.
	using mp4 = new Input({ source: new UrlSource('/demo.mp4'), formats: ALL_FORMATS });
	const mp4Track = await mp4.getPrimaryVideoTrack();
	assert(mp4Track);
	const decoderConfig = await mp4Track.getDecoderConfig();
	assert(decoderConfig);

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	let index = 0;
	for await (const packet of new EncodedPacketSink(mp4Track).packets()) {
		const data = index === 49 ? packet.data.slice(0, Math.floor(packet.data.length / 3)) : packet.data;
		await source.add(new EncodedPacket(data, packet.type, packet.timestamp, packet.duration), { decoderConfig });
		if (++index === 53) {
			break;
		}
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	skip(!(await nativeDecodingFails(track)), 'the decoder conceals the broken frame here');

	const sink = new VideoSampleSink(track);
	await expect((async () => {
		for await (using sample of sink.samples()) {
			void sample;
		}
	})()).rejects.toThrow();
});

test('Audio a decoder fails on still throws at the end', async ({ skip }) => {
	// The first MP3 frames of a file with an invalid bitrate in their headers, in MP4. Audio decoders hold back no
	// frames, so their failed flush has nothing to recover, and decoding again must not swallow its error.
	using mp3 = new Input({ source: new UrlSource('/Toothsome-Meme.VBRv2.mp3'), formats: ALL_FORMATS });
	const mp3Track = await mp3.getPrimaryAudioTrack();
	assert(mp3Track);
	const decoderConfig = await mp3Track.getDecoderConfig();
	assert(decoderConfig);

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('mp3');
	output.addAudioTrack(source);
	await output.start();
	let index = 0;
	for await (const packet of new EncodedPacketSink(mp3Track).packets()) {
		const data = packet.data.slice();
		data[2] = (data[2]! & 0x0f) | 0xf0; // Bitrate index 15, which is invalid
		await source.add(new EncodedPacket(data, 'key', packet.timestamp, packet.duration), { decoderConfig });
		if (++index === 3) {
			break;
		}
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	skip(!(await nativeDecodingFails(track)), 'the decoder conceals the broken frames here');

	await expect((async () => {
		for await (using sample of new AudioSampleSink(track).samples()) {
			void sample;
		}
	})()).rejects.toThrow();
});
