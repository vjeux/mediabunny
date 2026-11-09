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

	// A lookup counts a sample starting up to one tick of the time resolution after the timestamp, since the packet
	// timestamps are rounded to it. WebKitGTK's decoder, which shifts its output by a fraction of a millisecond, gets
	// such a sample here.
	const tick = 1 / await track.getTimeResolution();
	expect(results[3]!.timestamp).toBeLessThanOrEqual(1 + tick);
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

test('Decoded audio samples can be looked up by their own timestamps (Matroska)', async () => {
	using input = new Input({
		source: new UrlSource('/demo.webm'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const sink = new AudioSampleSink(track);
	const samples: { timestamp: number; numberOfFrames: number }[] = [];
	for await (using sample of sink.samples(0, 1)) {
		samples.push({ timestamp: sample.timestamp, numberOfFrames: sample.numberOfFrames });
	}

	// Matroska stores packet timestamps in milliseconds, while decoded audio is timed by its sample count. Decoding
	// from elsewhere can move a sample by up to that precision, but must not give the sample before it (20 ms earlier).
	for (const { timestamp, numberOfFrames } of samples.slice(1)) {
		using sample = await sink.getSample(timestamp);
		assert(sample);
		expect(sample.timestamp).toBeCloseTo(timestamp, 2);
		expect(sample.numberOfFrames).toBe(numberOfFrames);

		for await (using first of sink.samples(timestamp)) {
			expect(first.timestamp).toBeCloseTo(timestamp, 2);
			break;
		}
	}
});

test('Sample ranges keep their exclusive end with timestamp tolerance', async () => {
	// Video has no tolerance, PCM WAVE packets sit on the sample grid, Matroska audio is compared within a millisecond
	const sinks = [
		['/video.mp4', 'video'],
		['/glitch-hop-is-dead.wav', 'audio'],
		['/demo.webm', 'audio'],
	] as const;

	for (const [file, type] of sinks) {
		using input = new Input({
			source: new UrlSource(file),
			formats: ALL_FORMATS,
		});

		const track = type === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
		assert(track);
		const sink = track.isVideoTrack() ? new VideoSampleSink(track) : new AudioSampleSink(track);

		const timestamps: number[] = [];
		for await (using sample of sink.samples()) {
			timestamps.push(sample.timestamp);
			if (timestamps.length === 3) {
				break;
			}
		}

		// The first sample, at the start of an empty range, isn't yielded
		const first = timestamps[0]!;
		const emptyRange: number[] = [];
		for await (using sample of sink.samples(first, first)) {
			emptyRange.push(sample.timestamp);
		}
		expect(emptyRange, file).toEqual([]);

		// A range ending at the third sample yields the first two
		const third = timestamps[2];
		assert(third !== undefined);
		const range: number[] = [];
		for await (using sample of sink.samples(first, third)) {
			range.push(sample.timestamp);
		}
		expect(range, file).toEqual(timestamps.slice(0, 2));
	}
});

// WebKitGTK's GStreamer FLAC decoder fails, and then stalls every later audio decode on the page, so this comes last.
// Whether the platform decodes FLAC is decided with WebCodecs alone, never with Mediabunny, so that a Mediabunny
// failure fails instead of skipping. The probe is the start of a tiny stream (as in the conformance suite), from
// ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 0.1 -c:a flac ("fLaC" + the STREAMINFO block, then two frames).
const flacDecodesNatively = async () => {
	const fromBase64 = (base64: string) => Uint8Array.from(atob(base64), x => x.charCodeAt(0));
	const decoder = new AudioDecoder({ output: data => data.close(), error: () => {} });
	decoder.configure({
		codec: 'flac',
		sampleRate: 16000,
		numberOfChannels: 1,
		description: fromBase64('ZkxhQ4AAACIEgASAAAALAAANA+gA8AAABkCfCt/b50DLnNgYijV2HiR2'),
	});
	['//g1CAADAAAAakQ=', '//h1CAEBv70AAAAGlg=='].forEach((chunk, i) => decoder.decode(new EncodedAudioChunk({
		type: 'key',
		timestamp: i * 64000,
		data: fromBase64(chunk),
	})));

	const decodes = await Promise.race([
		decoder.flush().then(() => true, () => false),
		new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5000)),
	]);
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return decodes;
};

// MP3 and FLAC time packets in samples, so a timestamp one sample before a packet still belongs to the packet before it
test.for(['/Toothsome-Meme.VBRv2.mp3', '/sample.flac'])(
	'Audio lookups stay sample-exact where packets sit on the sample grid (%s)',
	async (file, { skip }) => {
		if (file.endsWith('.flac')) {
			skip(!(await flacDecodesNatively()), 'FLAC can\'t be decoded here (native probe)');
		}

		using input = new Input({
			source: new UrlSource(file),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const sampleRate = await track.getSampleRate();

		// Far enough in that decoding doesn't start at the first packets, which start below 0 (MP3's encoder delay), as
		// WebKitGTK's decoder scrambles the timestamps following a negative one. The MP3 pre-roll is over 2 s here.
		const packetSink = new EncodedPacketSink(track);
		const packet = await packetSink.getPacket(3);
		assert(packet);
		const previousPacket = await packetSink.getPacket(packet.timestamp - 1 / sampleRate);
		assert(previousPacket && previousPacket.timestamp < packet.timestamp);

		const sink = new AudioSampleSink(track);
		using sampleBefore = await sink.getSample(packet.timestamp - 1 / sampleRate);
		using sampleAt = await sink.getSample(packet.timestamp);
		expect(sampleBefore?.timestamp).toBeCloseTo(previousPacket.timestamp, 6);
		expect(sampleAt?.timestamp).toBeCloseTo(packet.timestamp, 6);

		for await (using first of sink.samples(packet.timestamp - 1 / sampleRate)) {
			expect(first.timestamp).toBeCloseTo(previousPacket.timestamp, 6);
			break;
		}
	},
);
