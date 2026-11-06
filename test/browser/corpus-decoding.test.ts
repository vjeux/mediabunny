import { describe, expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { UrlSource } from '../../src/source.js';

// Decodes the FFmpeg-written fixtures of test/node/corpus-conformance.test.ts in the browser: every video packet
// gives one 64x48 frame, in presentation order, and the decoded audio covers the source signal (0.8 s, or 0.3 s for
// the larger WAVE files).

const FILES = [
	'ffmpeg-mp4-default.mp4',
	'ffmpeg-mp4-faststart.mp4',
	'ffmpeg-mp4-negative-cts.mp4',
	'ffmpeg-mp4-no-editlist.mp4',
	'ffmpeg-mp4-frag-keyframe.mp4',
	'ffmpeg-mp4-frag-every-frame.mp4',
	'ffmpeg-mp4-separate-moof.mp4',
	'ffmpeg-mp4-omit-tfhd-offset.mp4',
	'ffmpeg-mp4-global-sidx.mp4',
	'ffmpeg-mp4-cmaf.mp4',
	'ffmpeg-mp4-delay-moov.mp4',
	'ffmpeg-mp4-frag-duration.mp4',
	'ffmpeg-mov-timecode.mov',
	'ffmpeg-3gp.3gp',
	'ffmpeg-mkv-default.mkv',
	'ffmpeg-mkv-small-clusters.mkv',
	'ffmpeg-mkv-live.mkv',
	'ffmpeg-webm-vp9-opus.webm',
	'ffmpeg-webm-vp8-vorbis.webm',
	'ffmpeg-ts-default.ts',
	'ffmpeg-m2ts.m2ts',
	'ffmpeg-ts-mp3-ac3.ts',
	'ffmpeg-ts-resend-headers.ts',
	'ffmpeg-adts.aac',
	'ffmpeg-mp3-cbr.mp3',
	'ffmpeg-mp3-vbr.mp3',
	'ffmpeg-ogg-opus.opus',
	'ffmpeg-ogg-vorbis.ogg',
	'ffmpeg-flac-16.flac',
	'ffmpeg-flac-24.flac',
	'ffmpeg-wav-s24.wav',
	'ffmpeg-wav-f32.wav',
	'ffmpeg-wav-alaw.wav',
	'ffmpeg-wav-mulaw.wav',
	'ffmpeg-wav-extensible-51.wav',
];

const expectVideoDecodes = async (track: InputVideoTrack) => {
	let packetCount = 0;
	for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
		void packet;
		packetCount++;
	}

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

	expect(frameCount).toBe(packetCount);
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

describe('Decoding files written by FFmpeg', () => {
	for (const file of FILES) {
		test(`decodes ${file}`, async () => {
			using input = new Input({ source: new UrlSource(`/${file}`), formats: ALL_FORMATS });
			let decodedTracks = 0;
			for (const track of await input.getTracks()) {
				if (!(await track.canDecode())) {
					continue; // AC-3 has no decoder in the browser
				}

				if (track.isVideoTrack()) {
					await expectVideoDecodes(track);
				} else if (track.isAudioTrack()) {
					await expectAudioDecodes(track, /wav-(s24|f32|extensible-51)\.wav$/.test(file) ? 0.3 : 0.8);
				}
				decodedTracks++;
			}

			expect(decodedTracks).toBeGreaterThan(0);
		});
	}
});
