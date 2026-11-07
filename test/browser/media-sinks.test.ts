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

	// From 0, without the priming packet's negative timestamp, which WebKitGTK's decoder mishandles
	const firstTimestamp = await track.getFirstTimestamp();
	let index = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		if (packet.timestamp >= 2) {
			break;
		}

		const timestamp = getTimestamp(packet.timestamp - firstTimestamp, index++);
		await source.add(packet.clone({ timestamp }), { decoderConfig });
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

test('Decoded audio stays contiguous when a packet is stamped like the one after it', async () => {
	// Like Chromium's front-discard.mp4, where a zero-duration packet shares the next one's timestamp: no audio is
	// missing, so this must not open a gap (found by lane L15)
	let packetTimestamps: number[];
	{
		using original = await remuxDemoAudio(timestamp => timestamp);
		const originalTrack = await original.getPrimaryAudioTrack();
		assert(originalTrack);
		packetTimestamps = await getPacketTimestamps(originalTrack);
	}

	// A sample before the next packet's timestamp, so that it's also less than a frame late where outputs are stamped
	// with their own packet's timestamp (outside Chromium)
	using input = await remuxDemoAudio((timestamp, index) => (
		index === 20 ? packetTimestamps[21]! - 1 / 48000 : timestamp
	));
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

test('Decoded audio stays in order when a packet decodes to nothing', async ({ skip }) => {
	skip(!(await vorbisDecoderFinishes()), 'the Vorbis decoder hangs here (native probe)');

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

// WebKitGTK's GStreamer Vorbis decoder hangs instead of decoding or failing, which can't be helped here. Whether the
// platform's decoder finishes is decided with WebCodecs alone, never with Mediabunny, so that a Mediabunny failure
// fails instead of skipping. vorbis-probe.json holds a tiny stream, from
// ffmpeg -f lavfi -i anullsrc=r=8000:cl=mono -t 0.06 -c:a libvorbis -q:a 0 (decoder config and packets).
let vorbisDecoderFinishesPromise: Promise<boolean> | null = null;
const vorbisDecoderFinishes = () => vorbisDecoderFinishesPromise ??= (async () => {
	const probe = await (await fetch('/vorbis-probe.json')).json() as {
		codec: string;
		sampleRate: number;
		numberOfChannels: number;
		description: string;
		chunks: string[];
	};
	const fromBase64 = (base64: string) => Uint8Array.from(atob(base64), x => x.charCodeAt(0));

	const decoder = new AudioDecoder({ output: data => data.close(), error: () => {} });
	decoder.configure({
		codec: probe.codec,
		sampleRate: probe.sampleRate,
		numberOfChannels: probe.numberOfChannels,
		description: fromBase64(probe.description),
	});
	probe.chunks.forEach((chunk, i) => decoder.decode(new EncodedAudioChunk({
		type: 'key',
		timestamp: i * 32000,
		data: fromBase64(chunk),
	})));

	// Decoding or failing both count as finishing; only a hang doesn't
	const finished = await Promise.race([
		decoder.flush().then(() => true, () => true),
		new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5000)),
	]);
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return finished;
})();

// vorbis-clicks.ogg was made with:
// ffmpeg -f lavfi -i "aevalsrc=exprs='if(lt(mod(t\,0.5)\,0.004)\,0.8*sin(2*PI*1000*t)\,0)':s=44100:d=3" \
//   -c:a libvorbis -q:a 4 vorbis-clicks.ogg
test('Vorbis audio keeps its timing, also after seeking', async ({ skip }) => {
	skip(!(await vorbisDecoderFinishes()), 'the Vorbis decoder hangs here (native probe)');

	using input = new Input({
		source: new UrlSource('/vorbis-clicks.ogg'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const sink = new AudioSampleSink(track);

	// A 1 kHz tone burst starts every 0.5 seconds
	const findBurst = async (startTimestamp?: number) => {
		for await (using sample of sink.samples(startTimestamp)) {
			const index = getSampleData(sample).findIndex(x => Math.abs(x) > 0.3);
			if (index !== -1) {
				return sample.timestamp + index / sample.sampleRate;
			}
		}

		return null;
	};

	expect(await findBurst()).toBeCloseTo(0, 3);
	expect(await findBurst(0.9)).toBeCloseTo(1, 3);
	expect(await findBurst(1.45)).toBeCloseTo(1.5, 3);
	expect(await findBurst(2.2)).toBeCloseTo(2.5, 3);
});
