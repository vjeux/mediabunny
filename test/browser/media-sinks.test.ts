import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { AudioSample, AudioSampleCopyToOptions } from '../../src/sample.js';
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

/** Remuxes the first two seconds of demo.mp4's AAC track (one decoded sample per packet) with new timestamps. */
const remuxDemoAudio = async (getTimestamp: (timestamp: number, index: number) => number) => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();

	let index = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		if (packet.timestamp >= 2) {
			break;
		}

		await source.add(packet.clone({ timestamp: getTimestamp(packet.timestamp, index++) }), { decoderConfig });
	}
	await output.finalize();

	return new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
};

/** Runs the callback with WebCodecs audio decoders that drop one output, like a packet that decodes to nothing. */
const withDroppedAudioOutput = async (outputIndex: number, callback: () => Promise<void>) => {
	const OriginalAudioDecoder = globalThis.AudioDecoder;
	globalThis.AudioDecoder = class extends OriginalAudioDecoder {
		constructor(init: AudioDecoderInit) {
			let outputCount = 0;
			super({
				output: (data) => {
					if (outputCount++ === outputIndex) {
						data.close();
						return;
					}

					init.output(data);
				},
				error: init.error,
			});
		}
	};

	try {
		await callback();
	} finally {
		globalThis.AudioDecoder = OriginalAudioDecoder;
	}
};

const getPacketTimestamps = async (track: InputAudioTrack) => {
	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
		timestamps.push(packet.timestamp);
	}

	return timestamps;
};

const getSampleTimestamps = async (track: InputAudioTrack) => {
	const timestamps: number[] = [];
	for await (using sample of new AudioSampleSink(track).samples()) {
		timestamps.push(sample.timestamp);
	}

	return timestamps;
};

test('Decoded audio keeps the gaps between packets', async () => {
	// A half-second gap at 1 s
	using input = await remuxDemoAudio(timestamp => timestamp >= 1 ? timestamp + 0.5 : timestamp);
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	// Each AAC packet decodes to one sample, which starts where the packet starts
	const packetTimestamps = await getPacketTimestamps(track);
	const sampleTimestamps = await getSampleTimestamps(track);
	expect(sampleTimestamps).toHaveLength(packetTimestamps.length);
	for (let i = 0; i < sampleTimestamps.length; i++) {
		expect(sampleTimestamps[i]).toBeCloseTo(packetTimestamps[i]!, 4);
	}
});

test('Decoded audio keeps a short gap between packets with exact timestamps', async () => {
	// FFmpeg's fragmented MP4 with B-frame video stretches the first audio packet over the video's delay, so the next
	// packet starts about 60 ms after the first one's audio ends (found by lane L64)
	using input = await remuxDemoAudio((timestamp, index) => index > 0 ? timestamp + 0.06 : timestamp);
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packetTimestamps = await getPacketTimestamps(track);
	const sampleTimestamps = await getSampleTimestamps(track);
	expect(sampleTimestamps).toHaveLength(packetTimestamps.length);
	for (let i = 0; i < sampleTimestamps.length; i++) {
		expect(sampleTimestamps[i]).toBeCloseTo(packetTimestamps[i]!, 4);
	}

	// Where seeking puts it too
	using sample = await new AudioSampleSink(track).getSample(packetTimestamps[40]! + 0.001);
	expect(sample!.timestamp).toBeCloseTo(sampleTimestamps[40]!, 4);
});

test('Decoded audio stays contiguous across packets that share a timestamp', async () => {
	// A run of eight packets stamped at the first one's timestamp, like the laced frames of a Matroska block with no
	// known durations
	let runTimestamp = 0;
	using input = await remuxDemoAudio((timestamp, index) => {
		if (index === 20) {
			runTimestamp = timestamp;
		}

		return index >= 20 && index < 28 ? runTimestamp : timestamp;
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	let previousEnd: number | null = null;
	for await (using sample of new AudioSampleSink(track).samples()) {
		if (previousEnd !== null) {
			expect(sample.timestamp).toBeCloseTo(previousEnd, 4);
		}

		previousEnd = sample.timestamp + sample.duration;
	}
});

test('Decoded audio stays in order when a packet decodes to nothing', async () => {
	await withDroppedAudioOutput(10, async () => {
		using input = new Input({
			source: new UrlSource('/vorbis-eos.ogg'), // Vorbis, so packet durations vary
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryAudioTrack();
		assert(track);

		let previousEnd = -Infinity;
		for await (using sample of new AudioSampleSink(track).samples(0, 2)) {
			expect(sample.timestamp).toBeGreaterThan(previousEnd - 1e-6); // No overlaps
			previousEnd = sample.timestamp + sample.duration;
		}
	});
});
