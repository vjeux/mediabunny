import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
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

test('Audio that starts before zero decodes in order, with no negative timestamps for the decoder', async () => {
	// A 1 kHz tone whose amplitude steps up by 0.02 every 20 ms, for 0.4 s:
	// ffmpeg -f lavfi -i "aevalsrc='0.02*(1+floor(t/0.02))*sin(2*PI*1000*t)':s=48000:d=0.4" -c:a libopus -b:a 64k
	//   staircase-tone.ogg (and -c:a aac -b:a 64k -movflags +faststart staircase-tone.m4a, -c:a libmp3lame -b:a 64k
	//   staircase-tone.mp3). Each starts before zero: the Opus pre-skip, the AAC priming, the LAME delay.
	// WebKit's GStreamer decoders (WPE, GTK) play a stream backwards from a negative chunk timestamp
	const NativeAudioDecoder = globalThis.AudioDecoder;
	const chunkTimestamps: number[] = [];
	globalThis.AudioDecoder = class extends NativeAudioDecoder {
		override decode(chunk: EncodedAudioChunk) {
			chunkTimestamps.push(chunk.timestamp);
			super.decode(chunk);
		}
	} as typeof AudioDecoder;

	try {
		for (const file of ['/staircase-tone.ogg', '/staircase-tone.m4a', '/staircase-tone.mp3']) {
			using input = new Input({
				source: new UrlSource(file),
				formats: ALL_FORMATS,
			});

			const track = await input.getPrimaryAudioTrack();
			assert(track);
			const firstPacket = await new EncodedPacketSink(track).getFirstPacket();
			assert(firstPacket);
			expect(firstPacket.timestamp, file).toBeLessThan(0);

			chunkTimestamps.length = 0;
			const samples: { timestamp: number; duration: number; peak: number }[] = [];
			for await (using sample of new AudioSampleSink(track).samples()) {
				const data = new Float32Array(sample.numberOfFrames);
				sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
				samples.push({
					timestamp: sample.timestamp,
					duration: sample.duration,
					peak: data.reduce((max, x) => Math.max(max, Math.abs(x)), 0),
				});
			}

			for (let i = 1; i < samples.length; i++) {
				expect(samples[i]!.timestamp, file).toBeGreaterThan(samples[i - 1]!.timestamp);
			}

			// The tone gets louder over time
			const peakAt = (time: number) => {
				return samples.find(x => x.timestamp <= time && time < x.timestamp + x.duration)!.peak;
			};
			expect(peakAt(0.05), file).toBeLessThan(0.15);
			expect(peakAt(0.35), file).toBeGreaterThan(0.25);

			if (file.endsWith('.ogg')) {
				// The first sample ends where the first packet does, whether the decoder dropped the pre-skip or not
				const firstSample = samples[0]!;
				const firstPacketEnd = firstPacket.timestamp + firstPacket.duration;
				expect(firstSample.timestamp + firstSample.duration).toBeCloseTo(firstPacketEnd, 6);
			}

			expect(Math.min(...chunkTimestamps), file).toBeGreaterThanOrEqual(0);
		}
	} finally {
		globalThis.AudioDecoder = NativeAudioDecoder;
	}
});

test('Video that starts before zero decodes fully, with no negative timestamps for the decoder', async () => {
	// ffmpeg -f lavfi -i testsrc2=size=64x64:rate=30 -frames:v 40 -c:v libx264 -pix_fmt yuv420p -crf 40
	//   -x264-params keyint=20:min-keyint=20:scenecut=0 src.mp4, trimmed the usual way:
	// ffmpeg -ss 0.4 -i src.mp4 -c copy -movflags +faststart trimmed-mid-gop.mp4
	// That keeps the whole first GOP, which the edit list times from -0.4 s.
	// WebKit's GStreamer decoders (WPE, GTK) lose the frames after a negative chunk timestamp
	const NativeVideoDecoder = globalThis.VideoDecoder;
	const chunkTimestamps: number[] = [];
	globalThis.VideoDecoder = class extends NativeVideoDecoder {
		override decode(chunk: EncodedVideoChunk) {
			chunkTimestamps.push(chunk.timestamp);
			super.decode(chunk);
		}
	} as typeof VideoDecoder;

	try {
		using input = new Input({
			source: new UrlSource('/trimmed-mid-gop.mp4'),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		assert(track);
		expect(await track.getFirstTimestamp()).toBeCloseTo(-0.4, 10);

		const packetTimestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packetTimestamps.push(packet.timestamp);
		}
		packetTimestamps.sort((a, b) => a - b);

		const timestamps: number[] = [];
		for await (using sample of new VideoSampleSink(track).samples()) {
			timestamps.push(sample.timestamp);
		}

		expect(timestamps).toEqual(packetTimestamps);
		expect(Math.min(...chunkTimestamps)).toBeGreaterThanOrEqual(0);
	} finally {
		globalThis.VideoDecoder = NativeVideoDecoder;
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
