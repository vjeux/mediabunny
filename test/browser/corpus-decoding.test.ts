import { describe, expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';
import { UrlSource } from '../../src/source.js';

// Decodes the FFmpeg-written fixtures of test/node/corpus-conformance.test.ts in the browser: every video packet
// gives one 64x48 frame, in presentation order, and the decoded audio covers the source signal (0.8 s, or 0.3 s for
// the larger WAVE files). Each fixture lists the tracks it must have, so a track that stops decoding or disappears
// fails the test. A track is only skipped when the browser itself has no decoder for its codec.

type ExpectedTrack =
	| { type: 'video'; codecString: string; packets: number }
	| { type: 'audio'; codecString: string };

const video = (codecString: string, packets: number): ExpectedTrack => ({ type: 'video', codecString, packets });
const audio = (codecString: string): ExpectedTrack => ({ type: 'audio', codecString });

const AVC_AAC = [video('avc1.64000a', 20), audio('mp4a.40.2')];

const FIXTURES: [string, ExpectedTrack[]][] = [
	['ffmpeg-mp4-default.mp4', AVC_AAC],
	['ffmpeg-mp4-faststart.mp4', AVC_AAC],
	['ffmpeg-mp4-negative-cts.mp4', AVC_AAC],
	['ffmpeg-mp4-no-editlist.mp4', AVC_AAC],
	['ffmpeg-mp4-frag-keyframe.mp4', AVC_AAC],
	['ffmpeg-mp4-frag-every-frame.mp4', AVC_AAC],
	['ffmpeg-mp4-separate-moof.mp4', AVC_AAC],
	['ffmpeg-mp4-omit-tfhd-offset.mp4', AVC_AAC],
	['ffmpeg-mp4-global-sidx.mp4', AVC_AAC],
	['ffmpeg-mp4-cmaf.mp4', AVC_AAC],
	['ffmpeg-mp4-delay-moov.mp4', AVC_AAC],
	['ffmpeg-mp4-frag-duration.mp4', AVC_AAC],
	['ffmpeg-mov-timecode.mov', AVC_AAC],
	['ffmpeg-3gp.3gp', AVC_AAC],
	['ffmpeg-mkv-default.mkv', AVC_AAC],
	['ffmpeg-mkv-small-clusters.mkv', AVC_AAC],
	['ffmpeg-mkv-live.mkv', AVC_AAC],
	['ffmpeg-webm-vp9-opus.webm', [video('vp09.00.10.08.01.02.02.02.00', 20), audio('opus')]],
	['ffmpeg-ts-default.ts', AVC_AAC],
	['ffmpeg-m2ts.m2ts', [video('avc1.64000a', 20), audio('ac-3')]],
	['ffmpeg-ts-mp3-ac3.ts', [video('avc1.64000a', 20), audio('mp3'), audio('ac-3')]],
	['ffmpeg-ts-resend-headers.ts', AVC_AAC],
	['ffmpeg-adts.aac', [audio('mp4a.40.2')]],
	['ffmpeg-mp3-cbr.mp3', [audio('mp3')]],
	['ffmpeg-mp3-vbr.mp3', [audio('mp3')]],
	['ffmpeg-ogg-opus.opus', [audio('opus')]],
	['ffmpeg-wav-s24.wav', [audio('pcm-s24')]],
	['ffmpeg-wav-f32.wav', [audio('pcm-f32')]],
	['ffmpeg-wav-alaw.wav', [audio('alaw')]],
	['ffmpeg-wav-mulaw.wav', [audio('ulaw')]],
	// Last, as WebKitGTK fails on or hangs on these, and a hang stalls every later decode on the page
	['ffmpeg-flac-16.flac', [audio('flac')]],
	['ffmpeg-flac-24.flac', [audio('flac')]],
	['ffmpeg-wav-extensible-51.wav', [audio('pcm-s16')]],
	['ffmpeg-webm-vp8-vorbis.webm', [video('vp8', 20), audio('vorbis')]],
	['ffmpeg-ogg-vorbis.ogg', [audio('vorbis')]],
];

// Decoded by Mediabunny itself rather than by a browser decoder
const PCM_CODECS = ['pcm-s16', 'pcm-s24', 'pcm-f32', 'alaw', 'ulaw'];

const expectVideoDecodes = async (track: InputVideoTrack, expectedPackets: number) => {
	let packetCount = 0;
	for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
		void packet;
		packetCount++;
	}
	expect(packetCount).toBe(expectedPackets);

	let frameCount = 0;
	let lastTimestamp = -Infinity;
	for await (const sample of new VideoSampleSink(track).samples()) {
		expect([sample.codedWidth, sample.codedHeight]).toEqual([64, 48]);
		// Not strictly increasing: FFmpeg gives two of the trailing B-frames of ffmpeg-mp4-frag-every-frame.mp4 the
		// same timestamp (ffprobe shows the same)
		expect(sample.timestamp).toBeGreaterThanOrEqual(lastTimestamp);
		lastTimestamp = sample.timestamp;
		frameCount++;
		sample.close();
	}

	expect(frameCount).toBe(expectedPackets);
};

const expectAudioDecodes = async (track: InputAudioTrack, sourceDuration: number) => {
	const sampleRate = await track.getSampleRate();
	const numberOfChannels = await track.getNumberOfChannels();

	let frames = 0;
	for await (const sample of new AudioSampleSink(track).samples()) {
		expect(sample.sampleRate).toBe(sampleRate);
		expect(sample.numberOfChannels).toBe(numberOfChannels);
		frames += sample.numberOfFrames;
		sample.close();
	}

	// Codecs pad the end to whole frames, so allow up to one frame (at most 2048 samples here) more
	expect(frames / sampleRate).toBeGreaterThanOrEqual(sourceDuration - 0.001);
	expect(frames / sampleRate).toBeLessThan(sourceDuration + 2048 / sampleRate);
};

/**
 * Whether the browser has a decoder for the fixture's codec, according to its own isConfigSupported(), asked about the
 * codec string the fixture lists rather than the config Mediabunny derives (so that a wrong config fails, not skips).
 */
const browserHasDecoder = async (expected: ExpectedTrack) => {
	if (PCM_CODECS.includes(expected.codecString)) {
		return true;
	}

	const support = expected.type === 'video'
		? await VideoDecoder.isConfigSupported({ codec: expected.codecString, codedWidth: 64, codedHeight: 48 })
		: await AudioDecoder.isConfigSupported({ codec: expected.codecString, sampleRate: 48000, numberOfChannels: 2 });
	return support.supported === true;
};

// Whether the platform can decode something is decided with WebCodecs alone, never with Mediabunny, so that a
// Mediabunny failure on a capable platform fails instead of skipping. isConfigSupported() isn't enough: WebKitGTK says
// it decodes codecs that its GStreamer decoders then fail on or hang on. Each probe is a decoder config and the first
// packets of a tiny stream made by FFmpeg (0.1 s of silence), read with
// ffprobe -show_streams -show_packets -show_data:
//   flac      -c:a flac (16 kHz mono; "fLaC" + the STREAMINFO block)
//   vorbis    -c:a libvorbis -q:a -1 (16 kHz mono; the Xiph-laced headers)
type Probe = { codec: string; sampleRate?: number; numberOfChannels?: number; description?: string; chunks: string[] };
const PROBES = {
	flac: {
		codec: 'flac',
		sampleRate: 16000,
		description: 'ZkxhQ4AAACIEgASAAAALAAANA+gA8AAABkCfCt/b50DLnNgYijV2HiR2',
		chunks: ['//g1CAADAAAAakQ=', '//h1CAEBv70AAAAGlg=='],
	},
	vorbis: {
		codec: 'vorbis',
		sampleRate: 16000,
		description:
			'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'
			+ 'QgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQuicc84555xzzjnnnHPOOeecc845JwDIt8IBwP/B'
			+ 'xhlWks4KR4MLDVkJAIQDAAAKQSilYhBKKSWSTjopnZNQSimRg1JK6aSUUkoJpZRSSgillFJKCB2UUkIppZRSSimllFJKKaWUUjop'
			+ 'pZRSSimllMo5KaWTUkoppUTOSSkhlFJKKaWEUkoppZRSSimllFJKKaWUUkoppYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEII'
			+ 'IYQQQgghhAIAuBscACASbJxhJemscDS40JCVAEBIAACgFHOOSggplJBSqJiijkIpKaRSSgoRY85J6hyFUFIoqYPKOQilpJRCKiF1'
			+ 'zkEHJYWQUgkhlY466CiUUFIqJZTSOSilhBRKSimVkEJIqXSUUigllZRCKiGVUkpIJZUQSgqdpFRKCqmkVFIInXSQQiclpJJKCqmT'
			+ 'lFIqJaWUSkoldFJCKimlEEJKqZQQSkgppU5SSamkFEIoIYWUUkolpZJKSiGVVEIJpaSUUiihpFRSSimlklIpAADgwAEAIMAIOsmo'
			+ 'sggbTbjwABQashIAIAMAQJR01mmnSSIIMUWZJw0pxiC1pCzDEFOSifEUY4w5KEZDDjHklBgXSgihg2I8JpVDylBRubfUOQXFFmN8'
			+ '77EXAQAACAIABIQEABggKJgBAAYHCCMHAh0BBA5tAICBCJkJDAqhwUEmADxAREgFAIkJitKFLgghgnQRZPHAhRM3nrjhhA5tEAAA'
			+ 'AAAAEADwAQCQUAAREdHMVVhcYGRobHB0eHyAhAQAAAAAAAgAfAAAJCJAREQ0cxUWFxgZGhscHR4fICEBAAAAAAAAAABAQEAAAAAA'
			+ 'ACAAAABAQA==',
		chunks: ['AA==', 'Cg==', 'Dg=='],
	},
} satisfies Record<string, Probe>;
type ProbeName = keyof typeof PROBES;

const fromBase64 = (base64: string) => Uint8Array.from(atob(base64), x => x.charCodeAt(0));

// Set once the page's decoders stall: then every later decode on the page would hang
let decodingStalled = false;

/** Decodes a probe with WebCodecs; tells whether it decoded and the visible size of each video frame. */
const runProbe = async (probe: Probe) => {
	const isVideo = probe.sampleRate === undefined;
	const description = probe.description !== undefined ? fromBase64(probe.description) : undefined;
	const videoConfig: VideoDecoderConfig = { codec: probe.codec, codedWidth: 64, codedHeight: 64, description };
	const audioConfig: AudioDecoderConfig = {
		codec: probe.codec,
		sampleRate: probe.sampleRate!,
		numberOfChannels: probe.numberOfChannels ?? 1,
		description,
	};
	const result = { decodes: false, visibleSizes: [] as string[] };
	try {
		const support = isVideo
			? await VideoDecoder.isConfigSupported(videoConfig)
			: await AudioDecoder.isConfigSupported(audioConfig);
		if (!support.supported) {
			return result;
		}
	} catch {
		return result;
	}

	let outputs = 0;
	let failed = false;
	const init = {
		output: (data: VideoFrame | AudioData) => {
			outputs++;
			if (data instanceof VideoFrame) {
				result.visibleSizes.push(`${data.visibleRect!.width}x${data.visibleRect!.height}`);
			}
			data.close();
		},
		error: () => {
			failed = true;
		},
	};
	const decoder = isVideo ? new VideoDecoder(init) : new AudioDecoder(init);
	let flushed = false;
	try {
		if (decoder instanceof VideoDecoder) {
			decoder.configure(videoConfig);
			probe.chunks.forEach((chunk, i) => decoder.decode(new EncodedVideoChunk({
				type: i === 0 ? 'key' : 'delta',
				timestamp: i * 33_333,
				data: fromBase64(chunk),
			})));
		} else {
			decoder.configure(audioConfig);
			probe.chunks.forEach((chunk, i) => decoder.decode(new EncodedAudioChunk({
				type: 'key',
				timestamp: i * 20_000,
				data: fromBase64(chunk),
			})));
		}
		flushed = await Promise.race([
			decoder.flush().then(() => true, () => false),
			new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000)),
		]);
	} catch {
		failed = true;
	}
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	result.decodes = flushed && !failed && outputs > 0;
	if (!result.decodes) {
		// A decoder that hung, or one that failed (WebKitGTK's FLAC decoder), can leave the page's other decoders of
		// that kind stalled. Then even isConfigSupported() never settles.
		const stillAnswers = isVideo
			? VideoDecoder.isConfigSupported({ codec: 'vp8', codedWidth: 64, codedHeight: 64 })
			: AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
		decodingStalled ||= !await Promise.race([
			stillAnswers.then(() => true, () => true),
			new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
		]);
	}

	return result;
};

const probeResults = new Map<ProbeName, ReturnType<typeof runProbe>>();
/** Runs each probe once, when first needed, so that one that hangs runs as late as possible. */
const probe = (name: ProbeName) => {
	if (!probeResults.has(name)) {
		probeResults.set(name, runProbe(PROBES[name]));
	}
	return probeResults.get(name)!;
};

// The codecs WebKitGTK says it decodes but then fails on or hangs on
const PROBE_FOR_CODEC: Record<string, ProbeName> = { flac: 'flac', vorbis: 'vorbis' };

describe('Decoding files written by FFmpeg', () => {
	for (const [file, expectedTracks] of FIXTURES) {
		test(`decodes ${file}`, async ({ skip }) => {
			using input = new Input({ source: new UrlSource(`/${file}`), formats: ALL_FORMATS });
			const tracks = await input.getTracks();
			expect(tracks.map(track => track.type)).toEqual(expectedTracks.map(track => track.type));

			const skipped: string[] = [];
			for (let i = 0; i < tracks.length; i++) {
				const track = tracks[i]!;
				const expected = expectedTracks[i]!;
				assert(track.isVideoTrack() || track.isAudioTrack());
				expect(await track.getCodecParameterString()).toBe(expected.codecString);

				if (decodingStalled && !PCM_CODECS.includes(expected.codecString)) {
					skipped.push('an earlier decoder failure stalled decoding on this page');
					continue;
				}
				if (!(await browserHasDecoder(expected))) {
					skipped.push(`this browser has no ${expected.codecString} decoder`); // AC-3 in Chrome
					continue;
				}
				const probeName = PROBE_FOR_CODEC[expected.codecString];
				if (probeName && !(await probe(probeName)).decodes) {
					skipped.push(`this browser's ${expected.codecString} decoder fails (native probe)`);
					continue;
				}

				if (expected.type === 'video') {
					assert(track.isVideoTrack());
					await expectVideoDecodes(track, expected.packets);
				} else {
					assert(track.isAudioTrack());
					await expectAudioDecodes(track, /wav-(s24|f32|extensible-51)\.wav$/.test(file) ? 0.3 : 0.8);
				}
			}

			skip(skipped.length === tracks.length, skipped.join(', '));
		});
	}
});
