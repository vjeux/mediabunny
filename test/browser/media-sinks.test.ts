import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, CustomPathedSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { AudioSample, AudioSampleCopyToOptions, VideoSample } from '../../src/sample.js';
import { OPUS_PRE_ROLL_DURATION } from '../../src/codec.js';
import { InputAudioTrack } from '../../src/input-track.js';

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

test.each([
	['with', false],
	['without', true],
])('Looking up H.264 frames gives the frames samples() gives, %s composition offsets', async (_, stripOffsets) => {
	const bytes = new Uint8Array(await (await fetch('/video.mp4')).arrayBuffer()); // H.264 with B-frames
	if (stripOffsets) {
		// What `ffmpeg -i in.h264 -c copy out.mp4` writes for a raw H.264 stream with B-frames: no ctts, so the
		// timestamps are in decode order, and Chromium's frames get them in sorted order. Found by lane L64.
		let ctts = 0;
		while (String.fromCharCode(...bytes.subarray(ctts, ctts + 4)) !== 'ctts') {
			ctts++;
		}
		bytes.set([0x66, 0x72, 0x65, 0x65], ctts); // 'free'
	}

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new VideoSampleSink(track);

	// A small picture of the frame, to tell frames apart
	const getSignature = (sample: VideoSample) => {
		const canvas = new OffscreenCanvas(8, 8);
		const context = canvas.getContext('2d')!;
		sample.draw(context, 0, 0, 8, 8);
		return context.getImageData(0, 0, 8, 8).data.filter((_, i) => i % 4 === 1).join(',');
	};

	const signatures = new Map<number, string>();
	for await (using sample of sink.samples()) {
		signatures.set(sample.timestamp, getSignature(sample));
	}

	const timestamps = [...signatures.keys()].filter((_, i) => i % 5 === 2);
	for (const timestamp of timestamps) {
		using sample = await sink.getSample(timestamp);
		assert(sample);
		expect(sample.timestamp).toBe(timestamp);
		expect(getSignature(sample), `frame at ${timestamp}`).toBe(signatures.get(timestamp));
	}

	let index = 0;
	for await (using sample of sink.samplesAtTimestamps(timestamps)) {
		assert(sample);
		expect(getSignature(sample)).toBe(signatures.get(timestamps[index++]!));
	}

	// Every frame and the points halfway to the next one, in one go
	const allTimestamps = [...signatures.keys()];
	const queries = allTimestamps.slice(0, -1).flatMap((timestamp, i) => [
		timestamp,
		(timestamp + allTimestamps[i + 1]!) / 2,
	]);
	index = 0;
	for await (using sample of sink.samplesAtTimestamps(queries)) {
		assert(sample);
		const expected = allTimestamps.filter(timestamp => timestamp <= queries[index]!).at(-1)!;
		expect(sample.timestamp, `query ${queries[index]}`).toBe(expected);
		expect(getSignature(sample), `query ${queries[index]}`).toBe(signatures.get(expected));
		index++;
	}
});

test('Frame lookups in a stream without B-frames stay exact when the reorder depth is unknown', async () => {
	// An SPS without bitstream restriction info (which many encoders leave out) gives no reorder depth, so
	// Mediabunny assumes the worst, 16 frames. In a stream without B-frames, no frame after the one asked for may
	// answer a lookup all the same (found by lane L46).
	using input = new Input({ source: new UrlSource('/missing-tfdt.mp4'), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new VideoSampleSink(track);
	sink._getReorderDepth = async () => 16;

	const timestamps: number[] = [];
	for await (using sample of sink.samples()) {
		timestamps.push(sample.timestamp);
		if (timestamps.length === 40) {
			break;
		}
	}

	const queries = timestamps.slice(0, -1).flatMap((timestamp, i) => [
		timestamp,
		(timestamp + timestamps[i + 1]!) / 2,
	]);
	let index = 0;
	for await (using sample of sink.samplesAtTimestamps(queries)) {
		const expected = timestamps.filter(timestamp => timestamp <= queries[index]!).at(-1);
		expect(sample?.timestamp, `query ${queries[index]}`).toBe(expected);
		index++;
	}

	using sample = await sink.getSample(timestamps[20]!);
	expect(sample?.timestamp).toBe(timestamps[20]);
});

test('Frame lookups at the live edge of a stream return without waiting for it to go on', async () => {
	// A live HLS stream (no EXT-X-ENDLIST) whose next segment never comes, as when its encoder stopped. Segments made
	// with ffmpeg -f lavfi -i testsrc2=size=160x120:rate=25:duration=2 -c:v libx264 -g 12 -bf 2 -f hls -hls_time 0.5
	const playlist = [
		'#EXTM3U',
		'#EXT-X-VERSION:3',
		'#EXT-X-TARGETDURATION:1',
		'#EXT-X-MEDIA-SEQUENCE:0',
		'#EXTINF:0.96,',
		'segment0.ts',
		'#EXTINF:0.48,',
		'segment1.ts',
		'#EXTINF:0.48,',
		'segment2.ts',
	].join('\n');
	using input = new Input({
		source: new CustomPathedSource('index.m3u8', ({ path }) => path === 'index.m3u8'
			? new BufferSource(new TextEncoder().encode(playlist))
			: new UrlSource('/hls-live/' + path)),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new VideoSampleSink(track);

	// Decoding ahead of the frame (for its reorder depth) must not wait for packets past the live edge
	for (const timestamp of [1.68, 1.84, 1.88]) {
		const sample = await Promise.race([
			sink.getSample(timestamp),
			new Promise<null>(resolve => setTimeout(() => resolve(null), 3000)),
		]);
		expect(sample?.timestamp, `frame at ${timestamp}`).toBe(timestamp);
		sample?.close();
	}
});
