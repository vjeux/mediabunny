import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat, WebMOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { AudioSample, AudioSampleCopyToOptions } from '../../src/sample.js';
import { OPUS_PRE_ROLL_DURATION } from '../../src/codec.js';
import { InputAudioTrack } from '../../src/input-track.js';
import { EncodedPacket } from '../../src/packet.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';

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

/** Remuxes the first packets of a VP9 file into WebM, with the last packet's color or alpha data cut in half. */
const remuxVp9WithCutLastPacket = async (url: string, packetCount: number, cut: 'color' | 'alpha') => {
	using input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
		if (packets.length === packetCount) {
			break;
		}
	}

	const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source);
	await output.start();
	for (const [i, packet] of packets.entries()) {
		const cutIfLast = (data: Uint8Array) => i === packets.length - 1 ? data.slice(0, data.length >> 1) : data;
		const alpha = packet.sideData.alpha;
		await source.add(
			new EncodedPacket(
				cut === 'color' ? cutIfLast(packet.data) : packet.data,
				packet.type,
				packet.timestamp,
				packet.duration,
				undefined,
				undefined,
				alpha ? { alpha: cut === 'alpha' ? cutIfLast(alpha) : alpha } : {},
			),
			i === 0 ? { decoderConfig } : undefined,
		);
	}
	await output.finalize();

	return { buffer: output.target.buffer!, timestamps: packets.map(x => x.timestamp) };
};

/**
 * How many frames of a file the platform's decoders output before reporting an error (or all of them, if they
 * report none). With alpha, a frame needs the output of both the color and the alpha decoder. Frames a decoder still
 * holds when it fails are lost with it.
 */
const countNativeFrames = async (buffer: ArrayBuffer) => {
	using input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	const countOutputs = async (chunks: EncodedVideoChunk[]) => {
		let count = 0;
		const decoder = new VideoDecoder({
			output: (frame) => {
				frame.close();
				count++;
			},
			error: () => {}, // Only the frames that came out before count
		});
		decoder.configure(decoderConfig);
		for (const chunk of chunks) {
			decoder.decode(chunk);
		}
		await decoder.flush().catch(() => {});
		if (decoder.state !== 'closed') {
			decoder.close();
		}

		return count;
	};

	const colorCount = await countOutputs(packets.map(x => x.toEncodedVideoChunk()));
	if (!packets.some(x => x.sideData.alpha)) {
		return colorCount;
	}

	return Math.min(colorCount, await countOutputs(packets.map(x => x.alphaToEncodedVideoChunk())));
};

/** The timestamps of the samples samples() yields, and the error it throws, if any. */
const decodeAllSamples = async (buffer: ArrayBuffer, delayPerSample = 0) => {
	using input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const timestamps: number[] = [];
	let error: unknown = null;
	try {
		for await (using sample of new VideoSampleSink(track).samples()) {
			timestamps.push(sample.timestamp);
			if (delayPerSample > 0) {
				await new Promise(resolve => setTimeout(resolve, delayPerSample));
			}
		}
	} catch (caught) {
		error = caught;
	}

	return { timestamps, error };
};

test.for(['color', 'alpha'] as const)(
	'Transparent video yields every frame decoded before a decode error, with the last frame\'s %s cut',
	async (cut) => {
		// The frames still being merged with their alpha when the decoder reported the error were dropped, as were
		// those the other decoder (color or alpha) hadn't output yet. Whether a decoder reports an error for the cut
		// frame, and how many frames it still holds then, depends on the platform.
		const { buffer, timestamps } = await remuxVp9WithCutLastPacket('/transparency.webm', 30, cut);
		const nativeFrameCount = await countNativeFrames(buffer);
		const decoded = await decodeAllSamples(buffer);
		expect(decoded.timestamps.slice(0, nativeFrameCount)).toEqual(timestamps.slice(0, nativeFrameCount));
	},
);

test('Video yields the frames waiting in the queue before a decode error', async () => {
	// Reading slowly, so that the decoder reports the cut last frame while the frames before it still wait in the
	// queue. They were dropped, and the error thrown right away.
	const { buffer, timestamps } = await remuxVp9WithCutLastPacket('/demo.webm', 6, 'color');
	const nativeFrameCount = await countNativeFrames(buffer);
	const decoded = await decodeAllSamples(buffer, 50);
	expect(decoded.timestamps.slice(0, nativeFrameCount)).toEqual(timestamps.slice(0, nativeFrameCount));
});

test('Transparent video yields the frames before an error its color decoder reports inside decode()', async () => {
	// Chromium's decoder sometimes calls its error callback right inside decode(). Reporting the color decoder's error
	// flushed the alpha decoder, which was then given the same packet's alpha and threw "A key frame is required after
	// configure() or flush()" before any frame came out. A stand-in color decoder reports the error that way for the
	// last packet. Like a decoder that fails, it loses the frames it hadn't output yet, so the frames to expect are the
	// ones it output before.
	const { buffer, timestamps } = await remuxVp9WithCutLastPacket('/transparency.webm', 30, 'color');
	const lastTimestamp = timestamps.at(-1)!;
	const globals = globalThis as { VideoDecoder: typeof VideoDecoder };
	const OriginalVideoDecoder = globals.VideoDecoder;
	let decoderCount = 0;
	const colorOutputTimestamps: number[] = [];
	globals.VideoDecoder = class extends OriginalVideoDecoder {
		reportError: ((error: DOMException) => void) | null = null;

		constructor(init: VideoDecoderInit) {
			const isColorDecoder = decoderCount++ === 0; // The color decoder is created first
			const colorDecoderInit: VideoDecoderInit = {
				...init,
				output: (frame) => {
					colorOutputTimestamps.push(Math.round(frame.timestamp / 1000) / 1000);
					init.output(frame);
				},
			};
			super(isColorDecoder ? colorDecoderInit : init);
			if (isColorDecoder) {
				this.reportError = init.error;
			}
		}

		override decode(chunk: EncodedVideoChunk) {
			if (this.reportError && Math.abs(chunk.timestamp / 1e6 - lastTimestamp) < 1e-3) {
				this.close();
				this.reportError(new DOMException('Decoding error.', 'EncodingError'));
				return;
			}

			super.decode(chunk);
		}
	};

	try {
		const decoded = await decodeAllSamples(buffer);
		expect(colorOutputTimestamps.length).toBeGreaterThan(0);
		expect(decoded.timestamps.slice(0, colorOutputTimestamps.length)).toEqual(colorOutputTimestamps);
		// The error is the color decoder's, unless decoding again after the failure recovered the frames
		if (decoded.error !== null) {
			expect(decoded.error).toBeInstanceOf(DOMException);
			expect((decoded.error as DOMException).name).toBe('EncodingError');
		}
	} finally {
		globals.VideoDecoder = OriginalVideoDecoder;
	}
});
