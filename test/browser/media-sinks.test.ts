import { expect, test, vi } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, CustomPathedSource, UrlSource, CustomSource } from '../../src/source.js';
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
	// Each period starts at its first packet: the timeline restarts with the decoder
	expect(periods[1]!.start).toBeCloseTo(1.021333, 4); // Rounded to the sample rate
	expect(periods[2]!.start).toBeCloseTo(1.021333 + 1.04644, 4);
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

test('HLS: audio after a decoder config switch starts at its first packet, wherever the previous ended', async () => {
	// The ad's EXTINF is a bit longer than its audio, so the content after it starts after a little gap
	const playlist = new TextDecoder().decode(await (await fetch('/hls-disc-audio/adisc.m3u8')).arrayBuffer())
		.replace('#EXTINF:1.04644,', '#EXTINF:1.06,');
	using input = new Input({
		source: new CustomPathedSource('p.m3u8', ({ path }) => (path === 'p.m3u8'
			? new BufferSource(new TextEncoder().encode(playlist))
			: new UrlSource('/hls-disc-audio/' + path))),
		formats: ALL_FORMATS,
	});
	const starts: number[] = [];
	let lastRate = 0;
	for await (const sample of new AudioSampleSink((await input.getPrimaryAudioTrack())!).samples()) {
		if (sample.sampleRate !== lastRate) {
			starts.push(sample.timestamp);
			lastRate = sample.sampleRate;
		}
		sample.close();
	}
	expect(starts).toHaveLength(3);
	expect(starts[1]).toBeCloseTo(1.021333, 4);
	expect(starts[2]).toBeCloseTo(1.021333 + 1.06, 4);
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

test('Annex B AVC decodes when the first packet has its parameter sets before the AUD', async () => {
	// Where the start code of the next NAL unit of the given type begins (4-byte or 3-byte)
	const findStartCode = (bytes: Uint8Array, nalUnitType: number, from = 0) => {
		for (let i = from; i + 3 < bytes.length; i++) {
			if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3]! & 0x1f) === nalUnitType) {
				return i > from && bytes[i - 1] === 0 ? i - 1 : i;
			}
		}
		throw new Error(`No NAL unit of type ${nalUnitType}`);
	};

	const decodeAll = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		// Annex B with the parameter sets in-band
		expect((await track.getDecoderConfig())!.description).toBeUndefined();

		let count = 0;
		for await (const sample of new VideoSampleSink(track).samples()) {
			count++;
			sample.close();
		}
		return count;
	};

	// The first sample of annex-b.mp4 is AUD, SPS, PPS, NAL unit 14, IDR slice. Some muxers put the parameter sets in
	// front of the AUD (found by lane L66; FFmpeg trac #697's sample carries them in a PES packet of their own), so
	// rewrite it to SPS, PPS, AUD, ... in place.
	const original = new Uint8Array(await (await fetch('/annex-b.mp4')).arrayBuffer());
	const audStart = findStartCode(original, 9);
	const spsStart = findStartCode(original, 7, audStart + 4);
	const ppsStart = findStartCode(original, 8, spsStart + 4);
	const afterPps = findStartCode(original, 14, ppsStart + 4);
	expect(spsStart).toBe(audStart + 6); // 00 00 00 01 09 xx

	const reordered = original.slice();
	const parameterSets = original.subarray(spsStart, afterPps);
	reordered.set(parameterSets, audStart);
	reordered.set(original.subarray(audStart, spsStart), audStart + parameterSets.length);

	const frameCount = await decodeAll(original);
	expect(frameCount).toBeGreaterThan(0);
	expect(await decodeAll(reordered)).toBe(frameCount);
});

test.each([
	['with', false],
	['without', true],
])('Looking up H.264 frames gives the frames samples() gives, %s composition offsets', async (_, stripOffsets) => {
	const bytes = new Uint8Array(await (await fetch('/video.mp4')).arrayBuffer()); // H.264 with B-frames
	if (stripOffsets) {
		// What `ffmpeg -i in.h264 -c copy out.mp4` writes for a raw H.264 stream with B-frames: no ctts, so the
		// timestamps are in decode order, and Chromium's frames get them in sorted order. Found by lane L64.
		let ctts = 0;
		while (String.fromCharCode(...bytes.subarray(ctts, ctts + 4)) !== 'ctts') {
			ctts++;
		}
		bytes.set([0x66, 0x72, 0x65, 0x65], ctts); // 'free'
	}

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new VideoSampleSink(track);

	// A small picture of the frame, to tell frames apart
	const getSignature = (sample: VideoSample) => {
		const canvas = new OffscreenCanvas(8, 8);
		const context = canvas.getContext('2d')!;
		sample.draw(context, 0, 0, 8, 8);
		return context.getImageData(0, 0, 8, 8).data.filter((_, i) => i % 4 === 1).join(',');
	};

	const signatures = new Map<number, string>();
	for await (using sample of sink.samples()) {
		signatures.set(sample.timestamp, getSignature(sample));
	}

	// Each lookup decodes from its key frame with a fresh decoder, which is slow, so only a few of them
	const timestamps = [...signatures.keys()].filter((_, i) => i % 25 === 2);
	for (const timestamp of timestamps) {
		using sample = await sink.getSample(timestamp);
		assert(sample);
		expect(sample.timestamp).toBe(timestamp);
		expect(getSignature(sample), `frame at ${timestamp}`).toBe(signatures.get(timestamp));
	}

	// Every frame and the points halfway to the next one, in one go
	const allTimestamps = [...signatures.keys()];
	const queries = allTimestamps.slice(0, -1).flatMap((timestamp, i) => [
		timestamp,
		(timestamp + allTimestamps[i + 1]!) / 2,
	]);
	let index = 0;
	for await (using sample of sink.samplesAtTimestamps(queries)) {
		assert(sample);
		const expected = allTimestamps.filter(timestamp => timestamp <= queries[index]!).at(-1)!;
		expect(sample.timestamp, `query ${queries[index]}`).toBe(expected);
		expect(getSignature(sample), `query ${queries[index]}`).toBe(signatures.get(expected));
		index++;
	}
});

test('Frame lookups in a stream without B-frames stay exact when the reorder depth is unknown', async () => {
	// An SPS without bitstream restriction info (which many encoders leave out) gives no reorder depth, so
	// Mediabunny assumes the worst, 16 frames. In a stream without B-frames, no frame after the one asked for may
	// answer a lookup all the same (found by lane L46).
	using input = new Input({ source: new UrlSource('/missing-tfdt.mp4'), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new VideoSampleSink(track);
	sink._getReorderDepth = async () => 16;

	const timestamps: number[] = [];
	for await (using sample of sink.samples()) {
		timestamps.push(sample.timestamp);
		if (timestamps.length === 40) {
			break;
		}
	}

	const queries = timestamps.slice(0, -1).flatMap((timestamp, i) => [
		timestamp,
		(timestamp + timestamps[i + 1]!) / 2,
	]);
	let index = 0;
	for await (using sample of sink.samplesAtTimestamps(queries)) {
		const expected = timestamps.filter(timestamp => timestamp <= queries[index]!).at(-1);
		expect(sample?.timestamp, `query ${queries[index]}`).toBe(expected);
		index++;
	}

	using sample = await sink.getSample(timestamps[20]!);
	expect(sample?.timestamp).toBe(timestamps[20]);
});

test('Frame lookups at the live edge of a stream return without waiting for it to go on', async () => {
	// A live HLS stream (no EXT-X-ENDLIST) whose next segment never comes, as when its encoder stopped. Segments made
	// with ffmpeg -f lavfi -i testsrc2=size=160x120:rate=25:duration=2 -c:v libx264 -g 12 -bf 2 -f hls -hls_time 0.5
	const playlist = [
		'#EXTM3U',
		'#EXT-X-VERSION:3',
		'#EXT-X-TARGETDURATION:1',
		'#EXT-X-MEDIA-SEQUENCE:0',
		'#EXTINF:0.96,',
		'segment0.ts',
		'#EXTINF:0.48,',
		'segment1.ts',
		'#EXTINF:0.48,',
		'segment2.ts',
	].join('\n');
	using input = new Input({
		source: new CustomPathedSource('index.m3u8', ({ path }) => path === 'index.m3u8'
			? new BufferSource(new TextEncoder().encode(playlist))
			: new UrlSource('/hls-live/' + path)),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new VideoSampleSink(track);

	// Decoding ahead of the frame (for its reorder depth) must not wait for packets past the live edge
	for (const timestamp of [1.68, 1.84, 1.88]) {
		const sample = await Promise.race([
			sink.getSample(timestamp),
			new Promise<null>(resolve => setTimeout(() => resolve(null), 3000)),
		]);
		expect(sample?.timestamp, `frame at ${timestamp}`).toBe(timestamp);
		sample?.close();
	}
});

test('Canvas iterators end on return() while a next() is still pending', async () => {
	const settles = (promise: Promise<unknown>) => Promise.race([
		promise.then(() => true, () => true),
		new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
	]);

	// Timestamps that arrive on demand (from scrubbing, for example): two come in, then none for now
	const timestampsThenStall = async function* () {
		yield 0.5;
		yield 1;
		await new Promise(() => {});
	};

	{
		using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const canvases = new CanvasSink(track).canvasesAtTimestamps(timestampsThenStall());
		await canvases.next();
		const pendingNext = canvases.next(); // Waits for the next timestamp

		// Async generator functions queued return() behind the pending next(), so neither ever settled and the decoder
		// was never freed (found by lane L70)
		expect(await settles(canvases.return())).toBe(true);
		expect(await settles(pendingNext)).toBe(true);
	}

	// The same with canvases(), over a source whose second half never arrives (a stalled connection, for example)
	const bytes = new Uint8Array(await (await fetch('/video.mp4')).arrayBuffer());
	using input = new Input({
		source: new CustomSource({
			getSize: () => bytes.byteLength,
			read: (start, end) => start < bytes.byteLength / 2 ? bytes.slice(start, end) : new Promise(() => {}),
		}),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new CanvasSink(track);

	const canvases = sink.canvases();
	let pendingNext = canvases.next();
	let canvasCount = 0;
	while (await settles(pendingNext)) {
		canvasCount++;
		pendingNext = canvases.next();
	}
	expect(canvasCount).toBeGreaterThan(1);

	expect(await settles(canvases.return())).toBe(true);
	expect(await settles(pendingNext)).toBe(true);

	if (typeof Symbol.asyncDispose === 'symbol') {
		// Like async generators, the iterators can be declared with `await using`
		const disposableCanvases = sink.canvases() as AsyncGenerator<unknown> & AsyncDisposable;
		await disposableCanvases[Symbol.asyncDispose]();
		expect(await disposableCanvases.next()).toEqual({ value: undefined, done: true });
	}
});

test('Canvas iterators open no decoder until they are iterated', async () => {
	// Counts the WebCodecs decoders and decoded frames that are open
	const countOpen = async (run: (sink: CanvasSink) => Promise<void>) => {
		let openDecoders = 0;
		const frames: VideoFrame[] = [];
		const OriginalVideoDecoder = globalThis.VideoDecoder;
		globalThis.VideoDecoder = class extends OriginalVideoDecoder {
			constructor(init: VideoDecoderInit) {
				super({
					...init,
					output: (frame) => {
						frames.push(frame);
						init.output(frame);
					},
				});
				openDecoders++;
			}

			override close() {
				if (this.state !== 'closed') {
					openDecoders--;
				}
				super.close();
			}
		};

		try {
			using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
			const track = await input.getPrimaryVideoTrack();
			assert(track);
			await run(new CanvasSink(track));
			await new Promise(resolve => setTimeout(resolve, 500));

			// A closed frame has no format anymore
			return { openDecoders, openFrames: frames.filter(frame => frame.format !== null).length };
		} finally {
			globalThis.VideoDecoder = OriginalVideoDecoder;
		}
	};

	// An iterator created up front and pulled from on demand, for example (found by lane L46)
	expect(await countOpen(async (sink) => {
		void sink.canvases();
		void sink.canvasesAtTimestamps([0.5, 1]);
	})).toEqual({ openDecoders: 0, openFrames: 0 });

	expect(await countOpen(async (sink) => {
		const canvases = sink.canvases();
		await canvases.next();
		await canvases.return();
		expect(await canvases.next()).toEqual({ value: undefined, done: true });
	})).toEqual({ openDecoders: 0, openFrames: 0 });

	expect(await countOpen(async (sink) => {
		const canvases = sink.canvases();
		await canvases.next();
		await expect(canvases.throw(new Error('Stop'))).rejects.toThrow('Stop');
	})).toEqual({ openDecoders: 0, openFrames: 0 });
});

test('Returning from sample iterators at the live edge closes the decoder', async () => {
	// A live HLS stream (no EXT-X-ENDLIST) whose next segment never comes, as when its encoder stopped. Segments made
	// with ffmpeg -f lavfi -i testsrc2=size=160x120:rate=25:duration=2 -c:v libx264 -g 12 -bf 2 -f hls -hls_time 0.5
	const playlist = [
		'#EXTM3U',
		'#EXT-X-VERSION:3',
		'#EXT-X-TARGETDURATION:1',
		'#EXT-X-MEDIA-SEQUENCE:0',
		'#EXTINF:0.96,',
		'segment0.ts',
		'#EXTINF:0.48,',
		'segment1.ts',
		'#EXTINF:0.48,',
		'segment2.ts',
	].join('\n');

	let openDecoders = 0;
	const OriginalVideoDecoder = globalThis.VideoDecoder;
	globalThis.VideoDecoder = class extends OriginalVideoDecoder {
		constructor(init: VideoDecoderInit) {
			super(init);
			openDecoders++;
		}

		override close() {
			if (this.state !== 'closed') {
				openDecoders--;
			}
			super.close();
		}
	};

	try {
		using input = new Input({
			source: new CustomPathedSource('index.m3u8', ({ path }) => path === 'index.m3u8'
				? new BufferSource(new TextEncoder().encode(playlist))
				: new UrlSource('/hls-live/' + path)),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const sink = new VideoSampleSink(track);

		const timeout = (ms: number) => new Promise<null>(resolve => setTimeout(() => resolve(null), ms));
		const pullUntilStuck = async (samples: AsyncGenerator<VideoSample | null, void, unknown>) => {
			let sampleCount = 0;
			while (true) {
				const result = await Promise.race([samples.next(), timeout(1000)]);
				if (!result) {
					return sampleCount; // Waiting for the live stream to go on
				}

				expect(result.done).toBe(false);
				result.value?.close();
				sampleCount++;
			}
		};

		// Found by lane L70: the decoder stayed open until the stream went on, or the input was disposed
		const samples = sink.samples();
		expect(await pullUntilStuck(samples)).toBeGreaterThan(0);
		await samples.return();
		await timeout(100);
		expect(openDecoders).toBe(0);

		// A timestamp the stream hasn't reached yet
		const samplesAtTimestamps = sink.samplesAtTimestamps([10]);
		expect(await pullUntilStuck(samplesAtTimestamps)).toBe(0);
		expect(openDecoders).toBe(1);
		await samplesAtTimestamps.return();
		await timeout(100);
		expect(openDecoders).toBe(0);
	} finally {
		globalThis.VideoDecoder = OriginalVideoDecoder;
	}
});
