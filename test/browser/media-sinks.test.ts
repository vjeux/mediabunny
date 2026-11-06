import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert, promiseWithResolvers, clamp } from '../../src/misc.js';
import {
	AudioBufferSink,
	AudioSampleSink,
	EncodedPacketSink,
	VideoSampleSink,
	CanvasSink,
} from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { AudioSample, AudioSampleCopyToOptions, VideoSample } from '../../src/sample.js';
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

test('High-profile AVC at level 1b can be decoded', async () => {
	// x264 picks level_idc 9 (level 1b in the High profiles) on its own for this one:
	// ffmpeg -f lavfi -i testsrc=size=64x48:rate=10:duration=0.3 -c:v libx264 -profile:v high -pix_fmt yuv420p \
	//   -b:v 100k -maxrate 100k -bufsize 200k avc-high-level-1b.mp4
	using input = new Input({
		source: new UrlSource('/avc-high-level-1b.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	expect(await track.getCodecParameterString()).toBe('avc1.640009');
	expect(await track.canDecode()).toBe(true);

	const sink = new VideoSampleSink(track);
	let count = 0;

	for await (using sample of sink.samples()) {
		expect(sample.displayWidth).toBe(64);
		count++;
	}

	expect(count).toBe(3);
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

// vorbis-clicks.ogg was made with:
// ffmpeg -f lavfi -i "aevalsrc=exprs='if(lt(mod(t\,0.5)\,0.004)\,0.8*sin(2*PI*1000*t)\,0)':s=44100:d=3" \
//   -c:a libvorbis -q:a 4 vorbis-clicks.ogg
test('Vorbis audio keeps its timing, also after seeking', async () => {
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

test('Empty packets are skipped when decoding', async () => {
	// MP4 allows zero-size samples (Chromium's test file bear-1280x720-zero-stsz-entry.mp4 ends with one), and
	// WebCodecs decoders error out on empty chunks
	using sourceInput = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
	const sourceVideoTrack = (await sourceInput.getPrimaryVideoTrack())!;
	const sourceAudioTrack = (await sourceInput.getPrimaryAudioTrack())!;

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const videoSource = new EncodedVideoPacketSource('avc');
	const audioSource = new EncodedAudioPacketSource('aac');
	output.addVideoTrack(videoSource);
	output.addAudioTrack(audioSource);
	await output.start();

	const copyPackets = async (
		track: InputVideoTrack | InputAudioTrack,
		source: EncodedVideoPacketSource | EncodedAudioPacketSource,
		count: number,
	) => {
		const decoderConfig = await track.getDecoderConfig();
		let last: EncodedPacket | null = null;
		let i = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			await source.add(packet, i === 0 ? { decoderConfig } as never : undefined);
			last = packet;
			if (++i === count) {
				break;
			}
		}
		const empty = new EncodedPacket(new Uint8Array(0), 'delta', last!.timestamp + last!.duration, last!.duration);
		await source.add(empty);
	};
	await copyPackets(sourceVideoTrack, videoSource, 30);
	await copyPackets(sourceAudioTrack, audioSource, 40);
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const audioTrack = (await input.getPrimaryAudioTrack())!;
	expect((await new EncodedPacketSink(videoTrack).getPacket(Infinity))!.byteLength).toBe(0);

	let frameCount = 0;
	for await (const sample of new VideoSampleSink(videoTrack).samples()) {
		frameCount++;
		sample.close();
	}
	expect(frameCount).toBe(30);

	let audioSampleCount = 0;
	for await (const sample of new AudioSampleSink(audioTrack).samples()) {
		audioSampleCount++;
		sample.close();
	}
	expect(audioSampleCount).toBeGreaterThan(30);
});

test('Empty PCM packets are skipped when decoding', async () => {
	// PCM doesn't go through a decoder, so it needs its own check: samples and AudioBuffers can't have zero frames
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array([1, 0, 2, 0]), 'key', 0, 2 / 48000), {
		decoderConfig: { codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 48000 },
	});
	await source.add(new EncodedPacket(new Uint8Array(0), 'key', 2 / 48000, 0));
	await source.add(new EncodedPacket(new Uint8Array([5]), 'key', 2 / 48000, 0)); // Less than one frame
	await source.add(new EncodedPacket(new Uint8Array([3, 0, 4, 0]), 'key', 2 / 48000, 2 / 48000));
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;

	const packetSizes: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packetSizes.push(packet.byteLength);
	}
	expect(packetSizes).toEqual([4, 0, 1, 4]);

	const sampleFrames: number[] = [];
	for await (const sample of new AudioSampleSink(track).samples()) {
		sampleFrames.push(sample.numberOfFrames);
		sample.close();
	}
	expect(sampleFrames).toEqual([2, 2]);

	const bufferFrames: number[] = [];
	for await (const { buffer } of new AudioBufferSink(track).buffers()) {
		bufferFrames.push(buffer.length);
	}
	expect(bufferFrames).toEqual([2, 2]);
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

test('Audio lookups stay sample-exact where packets sit on the sample grid', async () => {
	// MP3 and FLAC time packets in samples, so a timestamp one sample before a packet still belongs to the packet
	// before it
	for (const file of ['/Toothsome-Meme.VBRv2.mp3', '/sample.flac']) {
		using input = new Input({
			source: new UrlSource(file),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const sampleRate = await track.getSampleRate();

		const packetSink = new EncodedPacketSink(track);
		const packet = await packetSink.getPacket(1);
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

test('Empty sample ranges yield nothing', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new VideoSampleSink(track);
	for (const [start, end] of [[1, 1], [1, 0.5]] as const) {
		const timestamps: number[] = [];
		for await (using sample of sink.samples(start, end)) {
			timestamps.push(sample.timestamp);
		}

		expect(timestamps).toEqual([]);
	}
});

test('Seeking into open-GOP H.264 returns the right frames', async () => {
	// One IDR, then I-frames with recovery point SEIs whose leading B-frames reference the previous GOP. The luma of
	// each frame encodes its index:
	// ffmpeg -f lavfi -i "nullsrc=s=64x64:r=30:d=2.5,geq=lum='mod(N\,16)*16+8':cb=128:cr=128,format=yuv420p" \
	//   -c:v libx264 -preset fast -bf 2 -x264-params "open-gop=1:keyint=30:min-keyint=30:scenecut=0" \
	//   -movflags +faststart open-gop-h264.mp4
	// ffmpeg -i open-gop-h264.mp4 -c copy open-gop-h264.ts
	const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!;

	for (const file of ['open-gop-h264.mp4', 'open-gop-h264.ts']) {
		using input = new Input({ source: new UrlSource(`/${file}`), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const firstTimestamp = await track.getFirstTimestamp();
		const sink = new VideoSampleSink(track);

		for (const frame of [29, 30, 31, 32, 45, 59, 61]) {
			const sample = await sink.getSample(firstTimestamp + (frame + 0.5) / 30);
			expect(sample, `${file} frame ${frame}`).not.toBeNull();
			assert(sample);
			expect(Math.round((sample.timestamp - firstTimestamp) * 30), `${file} frame ${frame}`).toBe(frame);

			sample.draw(context, 0, 0, 1, 1);
			sample.close();
			const expectedGray = clamp(Math.round(((frame % 16) * 16 + 8 - 16) * 255 / 219), 0, 255);
			const gray = context.getImageData(0, 0, 1, 1).data[1]!;
			expect(Math.abs(gray - expectedGray), `${file} frame ${frame}`).toBeLessThan(6);
		}
	}
});

// https://github.com/Vanilagy/mediabunny/issues/602
test('Video whose AVC decoder config changes mid-stream decodes in full after muxing', async () => {
	// Two clips with different parameter sets (High and Constrained Baseline), as when the browser replaces a
	// failing hardware encoder with a software one
	using firstInput = new Input({ source: new UrlSource('/avc-config-change-high.mp4'), formats: ALL_FORMATS });
	using secondInput = new Input({ source: new UrlSource('/avc-config-change-baseline.mp4'), formats: ALL_FORMATS });
	const firstTrack = (await firstInput.getPrimaryVideoTrack())!;
	const secondTrack = (await secondInput.getPrimaryVideoTrack())!;

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, { frameRate: 10 });
	await output.start();

	let meta: EncodedVideoChunkMetadata | undefined = { decoderConfig: (await firstTrack.getDecoderConfig())! };
	for await (const packet of new EncodedPacketSink(firstTrack).packets()) {
		await source.add(packet, meta);
		meta = undefined;
	}
	meta = { decoderConfig: (await secondTrack.getDecoderConfig())! };
	for await (const packet of new EncodedPacketSink(secondTrack).packets()) {
		await source.add(packet.clone({ timestamp: packet.timestamp + 1 }), meta);
		meta = undefined;
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
	const secondSink = new VideoSampleSink(secondTrack);

	const getPixels = (sample: VideoSample) => {
		const context = new OffscreenCanvas(sample.displayWidth, sample.displayHeight).getContext('2d')!;
		sample.draw(context, 0, 0);
		return context.getImageData(0, 0, sample.displayWidth, sample.displayHeight).data;
	};

	let count = 0;
	for await (using sample of sink.samples()) {
		if (sample.timestamp >= 1) {
			using expected = (await secondSink.getSample(sample.timestamp - 1))!;
			expect(getPixels(sample)).toEqual(getPixels(expected));
		}
		count++;
	}
	expect(count).toBe(20);

	// Decoding can also start at a later key frame of the second clip
	using seeked = (await sink.getSample(1.7))!;
	using expected = (await secondSink.getSample(0.7))!;
	expect(getPixels(seeked)).toEqual(getPixels(expected));
});

test('CanvasSink rejects null options like other non-objects', async () => {
	using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;

	for (const options of [null, 'fit', 1]) {
		expect(() => new CanvasSink(track, options as never)).toThrow(new TypeError('options must be an object.'));
	}
});
