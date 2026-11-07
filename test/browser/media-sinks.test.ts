import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat, MpegTsOutputFormat, OutputFormat } from '../../src/output-format.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { AudioSample, AudioSampleCopyToOptions } from '../../src/sample.js';
import { OPUS_PRE_ROLL_DURATION } from '../../src/codec.js';
import { InputAudioTrack } from '../../src/input-track.js';
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

// WebKitGTK's decoders scramble the timestamps that follow a negative one
const decodesNegativeTimestamps = async () => {
	const timestamps: number[] = [];
	const decoder = new AudioDecoder({
		output: (data) => {
			timestamps.push(data.timestamp);
			data.close();
		},
		error: () => {},
	});
	decoder.configure({ codec: 'pcm-s16', sampleRate: 48000, numberOfChannels: 1 });
	for (const timestamp of [-20000, 0, 20000]) {
		decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: new Uint8Array(1920) }));
	}
	await decoder.flush();
	decoder.close();

	return timestamps.join() === '-20000,0,20000';
};

// FFmpeg's AAC decoder, which Chromium and Firefox use, discards the first frame of AAC from libfaac as encoder
// priming. It recognizes such AAC by the encoder name in a fill element of the first frame, which FFmpeg's own encoder
// writes too, one byte earlier: demo.mp4's AAC with that name changed is such AAC (found by lane L79, with Chromium's
// bear.mp4).
const withLibfaacName = (data: Uint8Array) => {
	data = data.slice();
	const offset = new TextDecoder('latin1').decode(data).indexOf('Lavc');
	assert(offset !== -1);
	data.set(new TextEncoder().encode(' libfaac 1.28'), offset);
	return data;
};

/** Remuxes the first second of demo.mp4's AAC, which starts a frame below 0. */
const remuxDemoAac = async (options: {
	libfaac: boolean;
	format?: OutputFormat;
	shiftInFrames?: number;
	firstSharesTimestamp?: boolean;
}) => {
	using input = new Input({ source: new UrlSource('/demo.mp4'), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);
	const frameDuration = 1024 / decoderConfig.sampleRate;

	const output = new Output({ format: options.format ?? new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();
	let isFirstPacket = true;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		if (packet.timestamp >= 1) {
			break;
		}

		const data = options.libfaac && isFirstPacket ? withLibfaacName(packet.data) : packet.data;
		let timestamp = packet.timestamp + (options.shiftInFrames ?? 1) * frameDuration;
		let duration = packet.duration;
		if (options.firstSharesTimestamp && isFirstPacket) {
			// As in Chromium's bear-1280x720.mp4: the first packet lasts 0 and shares its timestamp with the next
			timestamp += frameDuration;
			duration = 0;
		}

		await source.add(new EncodedPacket(data, packet.type, timestamp, duration), { decoderConfig });
		isFirstPacket = false;
	}
	await output.finalize();

	return new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
};

/**
 * Whether the platform's decoder discards the track's first frame and stamps the next two apart, decided with WebCodecs
 * alone. WebKitGTK's stamps the frames after a discarded one with the timestamps of the packets before them.
 */
const decoderDiscardsFirstFrame = async (track: InputAudioTrack) => {
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const timestamps: number[] = [];
	const decoder = new AudioDecoder({
		output: (data) => {
			timestamps.push(data.timestamp);
			data.close();
		},
		error: () => {},
	});
	decoder.configure(decoderConfig);
	const packetSink = new EncodedPacketSink(track);
	let packet = await packetSink.getFirstPacket();
	for (let i = 0; i < 3 && packet; i++) {
		decoder.decode(packet.toEncodedAudioChunk());
		packet = await packetSink.getNextPacket(packet);
	}
	await decoder.flush();
	decoder.close();

	return timestamps.length === 2 && timestamps[1]! > timestamps[0]!;
};

const getAudioSignature = (sample: AudioSample) => {
	const data = new Float32Array(sample.numberOfFrames);
	sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
	return [...data.subarray(0, 64)].map(x => x.toFixed(6)).join();
};

// Decoding from a frame earlier (the pre-roll) isn't bit-exact, unlike a frame's worth of other audio
const expectSameAudio = (signature: string, expected: string) => {
	const values = signature.split(',').map(Number);
	const expectedValues = expected.split(',').map(Number);
	expect(Math.max(...values.map((x, i) => Math.abs(x - expectedValues[i]!)))).toBeLessThan(0.001);
};

const decodeAudioTrack = async (input: Input) => {
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const samples: { timestamp: number; signature: string }[] = [];
	for await (using sample of new AudioSampleSink(track).samples()) {
		samples.push({ timestamp: sample.timestamp, signature: getAudioSignature(sample) });
	}
	return { track, samples };
};

test.for([
	['at 0', 1],
	['below 0, as an edit list leaves it', 0],
] as const)('AAC that decoders start a frame late keeps the timestamps of its packets, starting %s', async (
	[, shiftInFrames],
	{ skip },
) => {
	if (shiftInFrames === 0) {
		// Chromium stamps the audio after a discarded frame with the first packet's timestamp, unless that's negative
		skip(!(await decodesNegativeTimestamps()), 'the decoder scrambles negative timestamps here');
	}

	using original = await remuxDemoAac({ libfaac: false, shiftInFrames });
	using libfaac = await remuxDemoAac({ libfaac: true, shiftInFrames });
	const { samples: originalSamples } = await decodeAudioTrack(original);
	const { track, samples } = await decodeAudioTrack(libfaac);

	// The same audio at the same timestamps, but for the first frame where the decoder discards it
	expect(samples.length).toBeGreaterThanOrEqual(originalSamples.length - 1);
	expect(samples).toEqual(originalSamples.slice(originalSamples.length - samples.length));

	const sink = new AudioSampleSink(track);
	for (const { timestamp, signature } of samples.slice(0, 3)) {
		using sample = await sink.getSample(timestamp);
		assert(sample);
		expect(sample.timestamp).toBe(timestamp);
		expectSameAudio(getAudioSignature(sample), signature);
	}
});

test.for([
	['MP4 whose first two packets share a timestamp', () => new Mp4OutputFormat(), true],
	['MPEG-TS, with its ADTS headers', () => new MpegTsOutputFormat(), false],
] as const)('AAC that decoders start a frame late is timed from its second packet: %s', async (
	[, createFormat, firstSharesTimestamp],
	{ skip },
) => {
	// As FFmpeg times it (found by lane L46)
	using input = await remuxDemoAac({ libfaac: true, format: createFormat(), firstSharesTimestamp });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	skip(
		!(await decoderDiscardsFirstFrame(track)),
		'the decoder keeps the first frame here, or stamps the next ones alike',
	);
	const packetTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packetTimestamps.push(packet.timestamp);
	}

	const { samples } = await decodeAudioTrack(input);
	expect(samples.map(x => x.timestamp)).toEqual(packetTimestamps.slice(1));

	const sink = new AudioSampleSink(track);
	for (const { timestamp, signature } of samples.slice(0, 3)) {
		using sample = await sink.getSample(timestamp);
		assert(sample);
		expect(sample.timestamp).toBe(timestamp);
		expectSameAudio(getAudioSignature(sample), signature);
	}
});
