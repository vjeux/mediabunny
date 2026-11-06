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

// WebKitGTK says it can decode these, then its GStreamer decoders fail on them or hang
const IS_WEBKIT = navigator.userAgent.includes('AppleWebKit') && !navigator.userAgent.includes('Chrome/');
const UNRELIABLE_WEBKIT_CODECS = ['flac', 'vorbis', 'pcm-s16'];

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

/** Whether the browser has a decoder for the track's codec, according to its own isConfigSupported. */
const browserHasDecoder = async (track: InputVideoTrack | InputAudioTrack) => {
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);
	if (PCM_CODECS.includes(decoderConfig.codec)) {
		return true;
	}

	const support = track.isVideoTrack()
		? await VideoDecoder.isConfigSupported(decoderConfig as VideoDecoderConfig)
		: await AudioDecoder.isConfigSupported(decoderConfig as AudioDecoderConfig);
	return support.supported === true;
};

let decodingStalled = false; // A hung WebKitGTK decoder stalls every later decode on the page, even once closed

/** Whether the browser's own decoder gets through the first packets of the track, within a time limit. */
const reallyDecodes = async (track: InputVideoTrack | InputAudioTrack) => {
	let failed = false;
	const output = (data: VideoFrame | AudioData) => data.close();
	const error = () => {
		failed = true;
	};

	let decoder: VideoDecoder | AudioDecoder;
	if (track instanceof InputVideoTrack) {
		const videoDecoder = new VideoDecoder({ output, error });
		videoDecoder.configure((await track.getDecoderConfig())!);
		decoder = videoDecoder;
	} else {
		const audioDecoder = new AudioDecoder({ output, error });
		audioDecoder.configure((await track.getDecoderConfig())!);
		decoder = audioDecoder;
	}

	const sink = new EncodedPacketSink(track);
	let packet = await sink.getFirstPacket();
	for (let i = 0; packet && i < 8 && !failed; i++) {
		try {
			if (decoder instanceof VideoDecoder) {
				decoder.decode(packet.toEncodedVideoChunk());
			} else {
				decoder.decode(packet.toEncodedAudioChunk());
			}
		} catch {
			failed = true;
		}
		packet = await sink.getNextPacket(packet);
	}
	const flushed = await Promise.race([
		decoder.flush().then(() => true, () => false),
		new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000)),
	]);
	if (decoder.state !== 'closed') {
		decoder.close();
	}
	decodingStalled ||= !flushed && !failed;

	return flushed && !failed;
};

describe('Decoding files written by FFmpeg', () => {
	for (const [file, expectedTracks] of FIXTURES) {
		test(`decodes ${file}`, async ({ skip }) => {
			skip(decodingStalled, 'an earlier decoder hang stalled decoding on this page');
			using input = new Input({ source: new UrlSource(`/${file}`), formats: ALL_FORMATS });
			const tracks = await input.getTracks();
			expect(tracks.map(track => track.type)).toEqual(expectedTracks.map(track => track.type));

			const skipped: string[] = [];
			for (let i = 0; i < tracks.length; i++) {
				const track = tracks[i]!;
				const expected = expectedTracks[i]!;
				assert(track.isVideoTrack() || track.isAudioTrack());
				expect(await track.getCodecParameterString()).toBe(expected.codecString);

				if (!(await browserHasDecoder(track))) {
					skipped.push(`this browser has no ${expected.codecString} decoder`); // AC-3 in Chrome
					continue;
				}
				if (
					IS_WEBKIT
					&& UNRELIABLE_WEBKIT_CODECS.includes(expected.codecString)
					&& !(await reallyDecodes(track))
				) {
					skipped.push(`WebKit's ${expected.codecString} decoder fails`);
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
