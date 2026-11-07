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

test('HLS: audio after a discontinuity with a new EXT-X-MAP decodes with its own AudioSpecificConfig', async () => {
	// AAC-LC 48 kHz stereo, then an ad break as AAC-LC 22.05 kHz mono with its own init section, then the first again
	using input = new Input({ source: new UrlSource('/hls-disc-audio/adisc.m3u8'), formats: ALL_FORMATS });
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new AudioSampleSink(audioTrack);
	const periods: { format: string; frames: number; start: number; end: number }[] = [];
	let offGrid = 0;
	for await (const sample of sink.samples()) {
		// Timestamps are rounded to the sample rate of their own period
		if (Math.abs(sample.timestamp * sample.sampleRate - Math.round(sample.timestamp * sample.sampleRate)) > 1e-6) {
			offGrid++;
		}
		const format = `${sample.sampleRate} Hz, ${sample.numberOfChannels} ch`;
		const last = periods[periods.length - 1];
		if (last?.format === format) {
			last.frames += sample.numberOfFrames;
			last.end = sample.timestamp + sample.duration;
		} else {
			periods.push({
				format,
				frames: sample.numberOfFrames,
				start: sample.timestamp,
				end: sample.timestamp + sample.duration,
			});
		}
		sample.close();
	}

	expect(periods.map(x => x.format)).toEqual(['48000 Hz, 2 ch', '22050 Hz, 1 ch', '48000 Hz, 2 ch']);
	// Every period decodes completely (48 and 23 AAC frames of 1024 samples) and in its place on the timeline
	expect(periods.map(x => x.frames)).toEqual([48 * 1024, 23 * 1024, 48 * 1024]);
	expect(periods[1]!.start).toBeCloseTo(1.021333, 2);
	expect(periods[2]!.start).toBeCloseTo(1.021333 + 1.04644, 2);
	expect(offGrid).toBe(0);

	// Decoding that starts in the ad break, and lookups across the switches
	const samples = [];
	for await (const sample of sink.samplesAtTimestamps([1.5, 0.5, 2.5])) {
		samples.push(sample && `${sample.sampleRate} Hz, ${sample.numberOfChannels} ch`);
		sample?.close();
	}
	expect(samples).toEqual(['22050 Hz, 1 ch', '48000 Hz, 2 ch', '48000 Hz, 2 ch']);
	const adSample = await sink.getSample(1.5);
	expect(adSample?.sampleRate).toBe(22050);
	adSample?.close();
});

test('HLS: an ad break of several segments sharing an init section decodes like the ad alone', async () => {
	const segment = (init: string, name: string, discontinuity: boolean) =>
		`${discontinuity ? '#EXT-X-DISCONTINUITY\n' : ''}#EXT-X-MAP:URI="${init}"\n#EXTINF:1.0,\n${name}\n`;
	const playlist = (body: string) => `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n${body}#EXT-X-ENDLIST\n`;

	// Channel 0 of every decoded sample at 22.05 kHz (the ad's rate), concatenated
	const decodeAd = async (text: string) => {
		using input = new Input({
			source: new CustomPathedSource('p.m3u8', ({ path }) => (path === 'p.m3u8'
				? new BufferSource(new TextEncoder().encode(text))
				: new UrlSource('/hls-disc-audio/' + path))),
			formats: ALL_FORMATS,
		});
		const chunks: Float32Array[] = [];
		for await (const sample of new AudioSampleSink((await input.getPrimaryAudioTrack())!).samples()) {
			if (sample.sampleRate === 22050) {
				const data = new Float32Array(sample.numberOfFrames);
				sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
				chunks.push(data);
			}
			sample.close();
		}
		const result = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}
		return result;
	};

	// Content (48 kHz stereo), then an ad break (22.05 kHz mono) of two segments with the same init section: the
	// decoder switches once, and keeps its state between the ad's segments
	const withContent = await decodeAd(playlist(
		segment('c_init.mp4', 'c_0.m4s', false)
		+ segment('d_init.mp4', 'd_0.m4s', true)
		+ segment('d_init.mp4', 'd_0.m4s', true),
	));
	// The same two ad segments without content before them: no switch at all
	const alone = await decodeAd(playlist(
		segment('d_init.mp4', 'd_0.m4s', false)
		+ segment('d_init.mp4', 'd_0.m4s', true),
	));

	expect(withContent.length).toBe(alone.length);
	expect(alone.length).toBe(2 * 23 * 1024);
	let maxDifference = 0;
	for (let i = 0; i < alone.length; i++) {
		maxDifference = Math.max(maxDifference, Math.abs(withContent[i]! - alone[i]!));
	}
	expect(maxDifference).toBeLessThan(1e-4);
});
