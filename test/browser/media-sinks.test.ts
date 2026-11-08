import { expect, test, vi } from 'vitest';
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
import { EncodedPacket } from '../../src/packet.js';
import { OPUS_PRE_ROLL_DURATION } from '../../src/codec.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';

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

// SBR keeps state across frames, so HE-AAC needs two frames of pre-roll, and parametric stereo (HE-AACv2) only kicks in
// at a frame carrying a PS header, which libfdk sends every 10 frames. SBR's noise generator never quite converges,
// hence the higher error bound than for AAC-LC. The files were made with:
// ffmpeg -f lavfi -i "anoisesrc=color=pink:amplitude=0.5:duration=2:seed=1,lowpass=f=4000"
//   -c:a libfdk_aac -profile:a aac_he -b:a 32k he-aac-2s.m4a (and he-aac-2s.aac)
// ffmpeg -f lavfi -i "aevalsrc=0.4*sin(2*PI*(220*t+300*t*t))|0.3*sin(2*PI*330*t):s=48000:d=2"
//   -c:a libfdk_aac -profile:a aac_he_v2 he-aac-v2-2s.m4a (and he-aac-v2-2s.aac)
// In ADTS, SBR and PS are only signaled implicitly. The MP4 files start below zero (an edit list cuts the encoder
// delay).
const heAacPreRollCases = [
	{ label: 'HE-AAC', url: '/he-aac-2s.m4a', startsBelowZero: true },
	{ label: 'HE-AAC signaled implicitly, ADTS', url: '/he-aac-2s.aac', startsBelowZero: false },
	{ label: 'HE-AACv2', url: '/he-aac-v2-2s.m4a', startsBelowZero: true },
	{ label: 'HE-AACv2, ADTS', url: '/he-aac-v2-2s.aac', startsBelowZero: false },
];

// WebKitGTK's GStreamer decoders scramble the timestamps that follow a negative one, so there, a file that starts below
// zero can't be decoded straight through for the reference. This asks the platform's own decoder, not Mediabunny.
const decodesNegativeTimestampsInOrder = async () => {
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
	await Promise.race([decoder.flush().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]);
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return timestamps.join() === '-20000,0,20000';
};

for (const { label, url, startsBelowZero } of heAacPreRollCases) {
	test(`Audio decoder pre-roll (${label})`, async (context) => {
		if (startsBelowZero && !(await decodesNegativeTimestampsInOrder())) {
			context.skip('the platform\'s decoder scrambles negative timestamps (native probe)');
		}

		using input = new Input({
			source: new UrlSource(url),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryAudioTrack();
		assert(track);

		await testAudioDecoderPreRoll(track, -30);
	});
}

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
	skip(!(await vorbisDecodesNatively()), 'Vorbis can\'t be decoded here (native probe)');

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

// Whether the platform decodes Vorbis is decided with WebCodecs alone, never with Mediabunny, so that a Mediabunny
// failure fails instead of skipping. Some platforms don't support Vorbis, and WebKitGTK's GStreamer decoder hangs
// instead of decoding or failing. vorbis-probe.json holds a tiny stream, from
// ffmpeg -f lavfi -i anullsrc=r=8000:cl=mono -t 0.06 -c:a libvorbis -q:a 0 (decoder config and packets).
let vorbisDecodesNativelyPromise: Promise<boolean> | null = null;
const vorbisDecodesNatively = () => vorbisDecodesNativelyPromise ??= (async () => {
	const probe = await (await fetch('/vorbis-probe.json')).json() as {
		codec: string;
		sampleRate: number;
		numberOfChannels: number;
		description: string;
		chunks: string[];
	};
	const fromBase64 = (base64: string) => Uint8Array.from(atob(base64), x => x.charCodeAt(0));
	const config: AudioDecoderConfig = {
		codec: probe.codec,
		sampleRate: probe.sampleRate,
		numberOfChannels: probe.numberOfChannels,
		description: fromBase64(probe.description),
	};

	const decoders: AudioDecoder[] = [];
	const decode = async () => {
		if (!(await AudioDecoder.isConfigSupported(config)).supported) {
			return false;
		}

		let failed = false;
		const decoder = new AudioDecoder({
			output: data => data.close(),
			error: () => {
				failed = true;
			},
		});
		decoders.push(decoder);
		decoder.configure(config);
		for (const [i, chunk] of probe.chunks.entries()) {
			decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: i * 32000, data: fromBase64(chunk) }));
		}
		await decoder.flush();

		return !failed;
	};

	try {
		// A hung decoder (or a page whose decoding an earlier hang stalled) neither decodes nor fails
		return await Promise.race([
			decode(),
			new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5000)),
		]);
	} catch {
		return false;
	} finally {
		for (const decoder of decoders) {
			if (decoder.state !== 'closed') {
				decoder.close();
			}
		}
	}
})();

// vorbis-clicks.ogg was made with:
// ffmpeg -f lavfi -i "aevalsrc=exprs='if(lt(mod(t\,0.5)\,0.004)\,0.8*sin(2*PI*1000*t)\,0)':s=44100:d=3" \
//   -c:a libvorbis -q:a 4 vorbis-clicks.ogg
test('Vorbis audio keeps its timing, also after seeking', async ({ skip }) => {
	skip(!(await vorbisDecodesNatively()), 'Vorbis can\'t be decoded here (native probe)');

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

// One IDR, then I-frames with recovery point SEIs whose leading B-frames reference the previous GOP. The luma of each
// frame encodes its index:
// ffmpeg -f lavfi -i "nullsrc=s=64x64:r=30:d=2.5,geq=lum='mod(N\,16)*16+8':cb=128:cr=128,format=yuv420p" \
//   -c:v libx264 -preset fast -bf 2 -x264-params "open-gop=1:keyint=30:min-keyint=30:scenecut=0" \
//   -movflags +faststart open-gop-h264.mp4
// ffmpeg -i open-gop-h264.mp4 -c copy open-gop-h264.ts
const expectOpenGopSeeking = async (input: Input) => {
	const track = (await input.getPrimaryVideoTrack())!;
	const firstTimestamp = await track.getFirstTimestamp();
	const sink = new VideoSampleSink(track);
	const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!;

	for (const frame of [29, 30, 31, 32, 45, 59, 61]) {
		const sample = await sink.getSample(firstTimestamp + (frame + 0.5) / 30);
		expect(sample, `frame ${frame}`).not.toBeNull();
		assert(sample);
		expect(Math.round((sample.timestamp - firstTimestamp) * 30), `frame ${frame}`).toBe(frame);

		sample.draw(context, 0, 0, 1, 1);
		sample.close();
		const expectedGray = clamp(Math.round(((frame % 16) * 16 + 8 - 16) * 255 / 219), 0, 255);
		const gray = context.getImageData(0, 0, 1, 1).data[1]!;
		expect(Math.abs(gray - expectedGray), `frame ${frame}`).toBeLessThan(6);
	}
};

test('Seeking into open-GOP H.264 returns the right frames, MP4', async (context) => {
	using input = new Input({ source: new UrlSource('/open-gop-h264.mp4'), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;

	// Outside Chromium, decoding starts at recovery points, which not every decoder can do (WebKitGTK's can't). So
	// probe the platform's decoder with the recovery point at 1 s and the packets following it.
	const packetSink = new EncodedPacketSink(track);
	const recoveryPoint = (await packetSink.getKeyPacket(await track.getFirstTimestamp() + 1))!;
	if (await track.determinePacketType(recoveryPoint) === 'key') {
		let outputs = 0;
		let failed = false;
		const decoder = new VideoDecoder({
			output: (frame) => {
				outputs++;
				frame.close();
			},
			error: () => failed = true,
		});
		decoder.configure((await track.getDecoderConfig())!);
		let packet: EncodedPacket | null = recoveryPoint;
		for (let i = 0; i < 8 && packet; i++) {
			decoder.decode(packet.toEncodedVideoChunk());
			packet = await packetSink.getNextPacket(packet);
		}
		await decoder.flush().catch(() => failed = true);
		if (decoder.state !== 'closed') {
			decoder.close();
		}

		if (failed || outputs === 0) {
			context.skip();
		}
	}

	await expectOpenGopSeeking(input);
});

test('Seeking into open-GOP H.264 returns the right frames, MPEG-TS', async () => {
	using input = new Input({ source: new UrlSource('/open-gop-h264.ts'), formats: ALL_FORMATS });
	await expectOpenGopSeeking(input);
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

test('VP8 alt-ref frames do not shift the timestamps of the frames decoded after them', async () => {
	// Two-pass libvpx stores its alt-ref frames as invisible packets of their own. Each frame shows its index as a 4x4
	// grid of 16x16 cells (bit b in cell b, white = 1):
	// ffmpeg -f lavfi -i "color=s=64x64:r=30:d=2,format=yuv420p,
	//   geq=lum='if(bitand(N\,pow(2\,floor(X/16)+4*floor(Y/16)))\,235\,16)':cb=128:cr=128"
	//   -c:v libvpx -b:v 100k -auto-alt-ref 1 -lag-in-frames 25 -g 30 -pass 1 -f null -
	// and the same with -pass 2 vp8-alt-ref.webm
	using input = new Input({
		source: new UrlSource('/vp8-alt-ref.webm'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	// Drawn rather than read with copyTo({ format: 'RGBA' }), which WebKitGTK doesn't convert from YUV
	const canvas = new OffscreenCanvas(64, 64);
	const context = canvas.getContext('2d')!;
	const readFrameIndex = (sample: VideoSample) => {
		sample.draw(context, 0, 0);
		const pixels = context.getImageData(0, 0, 64, 64).data;

		let index = 0;
		for (let bit = 0; bit < 16; bit++) {
			const x = (bit % 4) * 16 + 8;
			const y = Math.floor(bit / 4) * 16 + 8;
			if (pixels[(y * 64 + x) * 4]! > 128) {
				index |= 1 << bit;
			}
		}

		return index;
	};
	const frameTimestamp = (index: number) => Math.round(index * 1000 / 30) / 1000;

	const sink = new VideoSampleSink(track);
	const frames: { index: number; timestamp: number }[] = [];
	for await (using sample of sink.samples()) {
		frames.push({ index: readFrameIndex(sample), timestamp: sample.timestamp });
	}

	expect(frames.map(x => x.index)).toEqual([...Array(60).keys()]);
	expect(frames.map(x => x.timestamp)).toEqual(frames.map(x => frameTimestamp(x.index)));

	const indices: number[] = [];
	for await (using sample of sink.samplesAtTimestamps([0.4, 0.5, 1.4, 1.5])) {
		assert(sample);
		indices.push(readFrameIndex(sample));
	}

	expect(indices).toEqual([12, 15, 42, 45]);
});

test('Sample lookups agree on timestamps a rounding error before a frame', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	// Stepping through this 25 fps video in increments of 1 / 25 reaches 0.39999999999999997 for the frame at 0.4
	let timestamp = 0;
	for (let i = 0; i < 10; i++) {
		timestamp += 1 / 25;
	}
	expect(timestamp).toBeLessThan(0.4);

	const sink = new VideoSampleSink(track);
	using sample = await sink.getSample(timestamp);
	expect(sample?.timestamp).toBe(0.4);

	for await (using sample of sink.samples(timestamp)) {
		expect(sample.timestamp).toBe(0.4);
		break;
	}

	// The end stays exclusive, so an empty range at a frame yields nothing
	for await (using sample of sink.samples(0, 0)) {
		expect.unreachable(`samples(0, 0) yielded the frame at ${sample.timestamp}`);
	}

	// The frame at 0.44 comes after the one at 0.4 in decode order, the frame at 0.48 before it. Both are found.
	for await (using sample of sink.samplesAtTimestamps([0.44 - 1e-11, 0.48 - 1e-11])) {
		assert(sample);
		expect([0.44, 0.48]).toContain(sample.timestamp);
	}
});

test('Decoding with a hardware acceleration the decoder refuses fails with the decodability error', async (context) => {
	// video.mp4 is 1920x1080 H.264 High at level 4.0; Chromium refuses 'prefer-hardware' without hardware decoding
	const hardware = await VideoDecoder.isConfigSupported({
		codec: 'avc1.640028',
		codedWidth: 1920,
		codedHeight: 1080,
		hardwareAcceleration: 'prefer-hardware',
	});
	if (hardware.supported) {
		context.skip('This platform decodes H.264 in hardware');
	}

	using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new VideoSampleSink(track, { hardwareAcceleration: 'prefer-hardware' });
	await expect(sink.getSample(0)).rejects.toThrow(
		'This video track cannot be decoded in this environment with hardwareAcceleration \'prefer-hardware\'.',
	);

	using sample = await new VideoSampleSink(track, { hardwareAcceleration: 'prefer-software' }).getSample(0);
	expect(sample?.timestamp).toBe(0);
});

test('HLS: video after a discontinuity with a new EXT-X-MAP decodes with its own parameter sets', async () => {
	// Two x264 encodes with different SPS/PPS (64x48 baseline, then 96x96 high), the way an ad break stitched into a
	// stream brings its own init section
	using input = new Input({ source: new UrlSource('/hls-disc/disc.m3u8'), formats: ALL_FORMATS });
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sizes: string[] = [];
	for await (const sample of new VideoSampleSink(videoTrack).samples()) {
		sizes.push(`${sample.codedWidth}x${sample.codedHeight}`);
		sample.close();
	}

	expect(sizes).toEqual([...Array<string>(10).fill('64x48'), ...Array<string>(10).fill('96x96')]);
});

test('HLS: video returning from an ad break to the first EXT-X-MAP decodes with its parameter sets', async () => {
	// Content, an ad break with its own init section, then content with the first init section again: the decoder has
	// just received the ad's parameter sets under the same IDs, so the returning content must send its own
	using input = new Input({ source: new UrlSource('/hls-disc/disc-return.m3u8'), formats: ALL_FORMATS });
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	const sink = new VideoSampleSink(videoTrack);

	// The decoder is also reconfigured at each switch, for decoders that don't apply new parameter sets from the
	// bitstream (WebKit's keeps the first resolution)
	const configuredSizes: string[] = [];
	const configureSpy = vi.spyOn(VideoDecoder.prototype, 'configure');

	const sizes: string[] = [];
	try {
		for await (const sample of sink.samples()) {
			sizes.push(`${sample.codedWidth}x${sample.codedHeight}`);
			sample.close();
		}
	} finally {
		for (const [config] of configureSpy.mock.calls) {
			configuredSizes.push(`${config.codedWidth}x${config.codedHeight}`);
		}
		configureSpy.mockRestore();
	}
	expect(configuredSizes).toEqual(['64x48', '96x96', '64x48']);
	expect(sizes).toEqual([
		...Array<string>(10).fill('64x48'),
		...Array<string>(10).fill('96x96'),
		...Array<string>(10).fill('64x48'),
	]);

	// Lookups that jump back and forth across the ad break in one decoding run
	const lookups: (string | null)[] = [];
	for await (const sample of sink.samplesAtTimestamps([1.5, 0.5, 2.5, 1.2])) {
		lookups.push(sample && `${sample.codedWidth}x${sample.codedHeight}`);
		sample?.close();
	}
	expect(lookups).toEqual(['96x96', '64x48', '64x48', '96x96']);
});
