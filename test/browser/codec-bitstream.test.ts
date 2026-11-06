import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, VideoSampleSink } from '../../src/media-sink.js';

// Chrome's decoders as the oracle for the decoder configurations Mediabunny derives from the bitstream: each
// FFmpeg-encoded fixture (see public/codec-bitstream/README.md) must decode with the derived config, and what comes out
// must agree with the track's metadata. The expected codec strings are the codecs parameters of RFC 6381, VP codec
// ISOBMFF and AV1-ISOBMFF for the stream fields that FFmpeg's trace_headers shows.

const VIDEO_FIXTURES: [fileName: string, codecString: string][] = [
	['h264-high10.mp4', 'avc1.6e000a'],
	['h264-high422.mp4', 'avc1.7a000a'],
	['h264-high444.mp4', 'avc1.f4000a'],
	['h264-34x18.mp4', 'avc1.64000a'],
	['h264-sar-16-11.mp4', 'avc1.64000a'],
	['h264-bt709-full.mp4', 'avc1.64000a'],
	['vp8.webm', 'vp8'],
	['vp9-profile1-422.webm', 'vp09.01.10.08.02.02.02.02.00'],
	['vp9-profile1-444.webm', 'vp09.01.10.08.03.02.02.02.00'],
	['vp9-profile2-10bit.webm', 'vp09.02.10.10.01.02.02.02.00'],
	['vp9-profile3-444-12bit.webm', 'vp09.03.10.12.03.02.02.02.00'],
	['vp9-bt2020-pq.webm', 'vp09.02.10.10.01.09.16.09.00'],
	['av1-main-10bit.mp4', 'av01.0.00M.10'],
	['av1-high-444.webm', 'av01.1.00M.08.0.000.01.01.01.0'],
	['av1-professional-422-10bit.webm', 'av01.2.00M.10.0.100.01.01.01.0'],
	['av1-bt709-full.mp4', 'av01.0.00M.08.0.110.01.01.01.1'],
	['av1-monochrome.webm', 'av01.0.00M.08.1.110.01.01.01.1'],
];

const AUDIO_FIXTURES: [fileName: string, codecString: string, sampleRate: number, numberOfChannels: number][] = [
	['aac-he.mp4', 'mp4a.40.5', 48000, 2],
	['aac-he-v2.mp4', 'mp4a.40.29', 48000, 2],
	['aac-lc-6.1.mp4', 'mp4a.40.2', 48000, 7],
	['opus-5.1.webm', 'opus', 48000, 6],
	['opus-family255-quad.webm', 'opus', 48000, 4],
	['vorbis.webm', 'vorbis', 44100, 2],
	['flac-5.1-24bit.mkv', 'flac', 48000, 6],
	['mp3.mp3', 'mp3', 44100, 2],
];

// Codec strings that are wrong on main, with the open PR fixing each
const KNOWN_CODEC_STRING_DIVERGENCES: Record<string, string> = {
	// PR #25: the VP9 codec string takes the transfer from the bitstream's color_space (14) over WebM's Colour (16)
	'vp9-bt2020-pq.webm': 'vp09.02.10.10.01.09.14.09.00',
};

test.each(VIDEO_FIXTURES)('Derived video decoder config: %s', async (fileName, codecString) => {
	using input = new Input({
		source: new UrlSource(`/codec-bitstream/${fileName}`),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryVideoTrack())!;
	expect(await track.getCodecParameterString()).toBe(KNOWN_CODEC_STRING_DIVERGENCES[fileName] ?? codecString);
	expect(await track.canDecode()).toBe(true);

	// The color space fields the track specifies must reach the decoded frames
	const colorSpace = Object.fromEntries(
		Object.entries(await track.getColorSpace()).filter(([, value]) => value !== undefined),
	);

	let count = 0;
	for await (using sample of new VideoSampleSink(track).samples()) {
		expect(sample.codedWidth).toBe(await track.getCodedWidth());
		expect(sample.codedHeight).toBe(await track.getCodedHeight());
		expect(sample.displayWidth).toBe(await track.getDisplayWidth());
		expect(sample.displayHeight).toBe(await track.getDisplayHeight());
		expect({ ...sample.colorSpace }).toMatchObject(colorSpace);
		count++;
	}

	expect(count).toBe(6);
});

test.each(AUDIO_FIXTURES)(
	'Derived audio decoder config: %s',
	async (fileName, codecString, sampleRate, numberOfChannels) => {
		using input = new Input({
			source: new UrlSource(`/codec-bitstream/${fileName}`),
			formats: ALL_FORMATS,
		});

		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getCodecParameterString()).toBe(codecString);
		expect(await track.getSampleRate()).toBe(sampleRate);
		expect(await track.getNumberOfChannels()).toBe(numberOfChannels);
		expect(await track.canDecode()).toBe(true);

		let count = 0;
		for await (using sample of new AudioSampleSink(track).samples()) {
			expect(sample.sampleRate).toBe(sampleRate);
			expect(sample.numberOfChannels).toBe(numberOfChannels);
			count++;
		}

		// Vorbis decodes its first packet to nothing (the first window only overlaps the next one)
		const { packetCount } = await track.computePacketStats();
		expect(count).toBe(codecString === 'vorbis' ? packetCount - 1 : packetCount);
	},
);
