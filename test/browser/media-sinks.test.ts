import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { AudioSample, AudioSampleCopyToOptions, VideoSample } from '../../src/sample.js';
import { OPUS_PRE_ROLL_DURATION } from '../../src/codec.js';
import { InputAudioTrack } from '../../src/input-track.js';
import { EncodedPacket } from '../../src/packet.js';
import { deserializeAvcDecoderConfigurationRecord } from '../../src/codec-data.js';

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

test('Annex B H.264 whose parameter sets are only in the first key frame decodes from any key frame', async () => {
	// demo.mp4's H.264 (a key frame every second) in MPEG-TS, with its SPS and PPS only in the first key frame, as
	// x264 writes them unless told to repeat them. A decoder that starts at a later key frame lacked them, so lookups
	// there threw or gave nothing (found by lanes L15 and L46, with issue1315's test.ts).
	using mp4 = new Input({ source: new UrlSource('/demo.mp4'), formats: ALL_FORMATS });
	const mp4Track = await mp4.getPrimaryVideoTrack();
	assert(mp4Track);
	const mp4DecoderConfig = await mp4Track.getDecoderConfig();
	assert(mp4DecoderConfig?.description);
	const record = deserializeAvcDecoderConfigurationRecord(
		new Uint8Array(mp4DecoderConfig.description as ArrayBuffer),
	);
	assert(record);

	/** Length-prefixed NAL units to Annex B, after the given extra NAL units. */
	const toAnnexB = (data: Uint8Array, extraNalUnits: Uint8Array[]) => {
		const lengthSize = record.lengthSizeMinusOne + 1;
		const nalUnits = [...extraNalUnits];
		for (let offset = 0; offset < data.length;) {
			let length = 0;
			for (let i = 0; i < lengthSize; i++) {
				length = length * 256 + data[offset++]!;
			}

			nalUnits.push(data.subarray(offset, offset + length));
			offset += length;
		}

		const result = new Uint8Array(nalUnits.reduce((sum, x) => sum + 4 + x.length, 0));
		let position = 0;
		for (const nalUnit of nalUnits) {
			result.set([0, 0, 0, 1], position);
			result.set(nalUnit, position + 4);
			position += 4 + nalUnit.length;
		}
		return result;
	};

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	let isFirstPacket = true;
	for await (const packet of new EncodedPacketSink(mp4Track).packets()) {
		const parameterSets = isFirstPacket ? [...record.sequenceParameterSets, ...record.pictureParameterSets] : [];
		await source.add(
			new EncodedPacket(toAnnexB(packet.data, parameterSets), packet.type, packet.timestamp, packet.duration),
			isFirstPacket
				? { decoderConfig: { ...mp4DecoderConfig, description: undefined } } // Annex B
				: undefined,
		);
		isFirstPacket = false;
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const keyTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		if (packet.type === 'key') {
			keyTimestamps.push(packet.timestamp);
		}
	}
	expect(keyTimestamps.length).toBeGreaterThan(2);

	const getChecksum = async (sample: VideoSample) => {
		const data = new Uint8Array(sample.allocationSize());
		await sample.copyTo(data);
		expect(data.some(x => x !== 0)).toBe(true);
		return data.reduce((sum, x, i) => (sum + x * (i % 251 + 1)) % 1_000_000_007, 0);
	};

	const sink = new VideoSampleSink(track);
	const checksums = new Map<number, number>();
	for await (using sample of sink.samples()) {
		checksums.set(sample.timestamp, await getChecksum(sample));
	}

	for (const timestamp of keyTimestamps.slice(1)) {
		using sample = await sink.getSample(timestamp);
		expect(sample?.timestamp, `getSample(${timestamp})`).toBe(timestamp);
		expect(await getChecksum(sample!)).toBe(checksums.get(timestamp));

		const range: number[] = [];
		for await (using rangeSample of sink.samples(timestamp, timestamp + 0.2)) {
			range.push(rangeSample.timestamp);
			expect(await getChecksum(rangeSample)).toBe(checksums.get(rangeSample.timestamp));
		}
		expect(range.length, `samples(${timestamp}, …)`).toBeGreaterThan(0);
	}
});
