/* eslint-disable @stylistic/max-len */
import { describe, expect, test } from 'vitest';
import { CmafOutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { InputTrack, InputVideoTrack } from '../../src/input-track.js';
import {
	concatBytes,
	createMemoryInput,
	createTimestampId3Tag,
	encodeText,
	encryptAes128,
	loadAdtsFrames,
	loadMp3Frames,
	MemoryFiles,
	readPackets,
	roundTo,
	segmentEdts,
} from './helpers/hls-real-fixtures.js';

// Structures of public HLS test streams: Apple's examples, the hls.js, Shaka and ExoPlayer demo lists, and CDN demo
// pages. The playlists follow the real ones (URIs shortened); the media comes from test/public, segmented in memory, so
// nothing touches the network.

const describeTrack = async (track: InputTrack) => {
	const disposition = await track.getDisposition();
	return {
		type: track.type,
		codec: await track.getCodec(),
		name: await track.getName(),
		language: await track.getLanguageCode(),
		bitrate: await track.getBitrate(),
		primary: disposition.primary,
		default: disposition.default,
		keyOnly: await track.hasOnlyKeyPackets(),
	};
};

describe('Multivariant playlists', () => {
	test('Apple bipbop 16x9: in-variant default audio, alternate audio, audio-only variant, subtitles, I-frames', async () => {
		// devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8 (fewer subtitles)
		const master = `#EXTM3U

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="bipbop_audio",LANGUAGE="eng",NAME="BipBop Audio 1",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="bipbop_audio",LANGUAGE="eng",NAME="BipBop Audio 2",AUTOSELECT=NO,DEFAULT=NO,URI="alternate_audio_aac/prog_index.m3u8"


#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="en",CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog, public.accessibility.describes-music-and-sound",URI="subtitles/eng/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English (Forced)",DEFAULT=NO,AUTOSELECT=NO,FORCED=YES,LANGUAGE="en",URI="subtitles/eng_forced/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="日本語",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,LANGUAGE="ja",CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog, public.accessibility.describes-music-and-sound",URI="subtitles/jpn/prog_index.m3u8"


#EXT-X-STREAM-INF:BANDWIDTH=263851,CODECS="mp4a.40.2, avc1.4d400d",RESOLUTION=416x234,AUDIO="bipbop_audio",SUBTITLES="subs"
gear1/prog_index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=28451,CODECS="avc1.4d400d",URI="gear1/iframe_index.m3u8"

#EXT-X-STREAM-INF:BANDWIDTH=577610,CODECS="mp4a.40.2, avc1.4d401e",RESOLUTION=640x360,AUDIO="bipbop_audio",SUBTITLES="subs"
gear2/prog_index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=181534,CODECS="avc1.4d401e",URI="gear2/iframe_index.m3u8"

#EXT-X-STREAM-INF:BANDWIDTH=915905,CODECS="mp4a.40.2, avc1.4d401f",RESOLUTION=960x540,AUDIO="bipbop_audio",SUBTITLES="subs"
gear3/prog_index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=297056,CODECS="avc1.4d401f",URI="gear3/iframe_index.m3u8"

#EXT-X-STREAM-INF:BANDWIDTH=1030138,CODECS="mp4a.40.2, avc1.4d401f",RESOLUTION=1280x720,AUDIO="bipbop_audio",SUBTITLES="subs"
gear4/prog_index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=339492,CODECS="avc1.4d401f",URI="gear4/iframe_index.m3u8"

#EXT-X-STREAM-INF:BANDWIDTH=1924009,CODECS="mp4a.40.2, avc1.4d401f",RESOLUTION=1920x1080,AUDIO="bipbop_audio",SUBTITLES="subs"
gear5/prog_index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=669554,CODECS="avc1.4d401f",URI="gear5/iframe_index.m3u8"

#EXT-X-STREAM-INF:BANDWIDTH=41457,CODECS="mp4a.40.2",AUDIO="bipbop_audio",SUBTITLES="subs"
gear0/prog_index.m3u8
`;
		using memory = createMemoryInput(new Map([['variant.m3u8', encodeText(master)]]), 'variant.m3u8');
		const { input, requests } = memory;

		const videoTracks = await input.getVideoTracks();
		const audioTracks = await input.getAudioTracks();

		// Each variant is a video track; the I-frame playlists are key-packet-only tracks of their own
		const regularVideo: InputVideoTrack[] = [];
		for (const track of videoTracks) {
			if (!(await track.hasOnlyKeyPackets())) {
				regularVideo.push(track);
			}
		}
		expect(await Promise.all(regularVideo.map(x => x.getBitrate()))).toEqual([263851, 577610, 915905, 1030138, 1924009]);
		expect(await Promise.all(regularVideo.map(x => x.getDisplayWidth()))).toEqual([416, 640, 960, 1280, 1920]);
		expect(await Promise.all(regularVideo.map(x => x.getCodecParameterString()))).toEqual([
			'avc1.4d400d', 'avc1.4d401e', 'avc1.4d401f', 'avc1.4d401f', 'avc1.4d401f',
		]);
		const iFrameVideo = videoTracks.filter(x => !regularVideo.includes(x));
		expect(await Promise.all(iFrameVideo.map(x => x.getBitrate()))).toEqual([28451, 181534, 297056, 339492, 669554]);
		for (const track of iFrameVideo) {
			expect(await track.getPairableAudioTracks()).toEqual([]);
		}

		// The URI-less DEFAULT rendition is the audio inside each variant's own playlist (RFC 8216, 4.3.4.2.1), so
		// every variant, the audio-only one included, has one; the alternate rendition is shared by all of them
		const described = await Promise.all(audioTracks.map(describeTrack));
		expect(described.filter(x => x.name === 'BipBop Audio 1').map(x => x.bitrate))
			.toEqual([263851, 577610, 915905, 1030138, 1924009, 41457]);
		expect(described.filter(x => x.name === 'BipBop Audio 1').every(x => x.primary && x.default && x.language === 'eng'))
			.toBe(true);
		expect(described.filter(x => x.name === 'BipBop Audio 2')).toEqual([{
			type: 'audio', codec: 'aac', name: 'BipBop Audio 2', language: 'eng', bitrate: null, primary: false,
			default: false, keyOnly: true,
		}]);

		const alternateAudio = audioTracks[described.findIndex(x => x.name === 'BipBop Audio 2')]!;
		for (const video of regularVideo) {
			const pairable = await video.getPairableAudioTracks();
			expect(pairable).toHaveLength(2);
			expect(pairable).toContain(alternateAudio);
			expect(await pairable.find(x => x !== alternateAudio)!.getBitrate()).toBe(await video.getBitrate());
		}

		expect(await input.getPrimaryVideoTrack()).toBe(regularVideo[4]);
		expect(await (await input.getPrimaryAudioTrack())!.getBitrate()).toBe(1924009);

		// Everything above comes from the multivariant playlist alone
		expect(requests).toEqual(['variant.m3u8']);
	});

	test('Apple advanced examples: one video playlist per resolution referenced with three audio groups', async () => {
		// devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8 (fewer variants)
		const master = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS


#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=2168183,BANDWIDTH=2177116,CODECS="avc1.640020,mp4a.40.2",RESOLUTION=960x540,FRAME-RATE=60.000,CLOSED-CAPTIONS="cc1",AUDIO="aud1",SUBTITLES="sub1"
v5/prog_index.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=530721,BANDWIDTH=541052,CODECS="avc1.640015,mp4a.40.2",RESOLUTION=480x270,FRAME-RATE=30.000,CLOSED-CAPTIONS="cc1",AUDIO="aud1",SUBTITLES="sub1"
v2/prog_index.m3u8


#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=2390686,BANDWIDTH=2399619,CODECS="avc1.640020,ac-3",RESOLUTION=960x540,FRAME-RATE=60.000,CLOSED-CAPTIONS="cc1",AUDIO="aud2",SUBTITLES="sub1"
v5/prog_index.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=753224,BANDWIDTH=763555,CODECS="avc1.640015,ac-3",RESOLUTION=480x270,FRAME-RATE=30.000,CLOSED-CAPTIONS="cc1",AUDIO="aud2",SUBTITLES="sub1"
v2/prog_index.m3u8


#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=2198686,BANDWIDTH=2207619,CODECS="avc1.640020,ec-3",RESOLUTION=960x540,FRAME-RATE=60.000,CLOSED-CAPTIONS="cc1",AUDIO="aud3",SUBTITLES="sub1"
v5/prog_index.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=561224,BANDWIDTH=571555,CODECS="avc1.640015,ec-3",RESOLUTION=480x270,FRAME-RATE=30.000,CLOSED-CAPTIONS="cc1",AUDIO="aud3",SUBTITLES="sub1"
v2/prog_index.m3u8


#EXT-X-I-FRAME-STREAM-INF:AVERAGE-BANDWIDTH=97767,BANDWIDTH=101378,CODECS="avc1.640020",RESOLUTION=960x540,URI="v5/iframe_index.m3u8"


#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",LANGUAGE="en",NAME="English",AUTOSELECT=YES,DEFAULT=YES,CHANNELS="2",URI="a1/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud2",LANGUAGE="en",NAME="English",AUTOSELECT=YES,DEFAULT=YES,CHANNELS="6",URI="a2/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud3",LANGUAGE="en",NAME="English",AUTOSELECT=YES,DEFAULT=YES,CHANNELS="6",URI="a3/prog_index.m3u8"


#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc1",LANGUAGE="en",NAME="English",AUTOSELECT=YES,DEFAULT=YES,INSTREAM-ID="CC1"


#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub1",LANGUAGE="en",NAME="English",AUTOSELECT=YES,DEFAULT=YES,FORCED=NO,URI="s1/en/prog_index.m3u8"
`;
		using memory = createMemoryInput(new Map([['master.m3u8', encodeText(master)]]), 'master.m3u8');
		const { input, requests } = memory;

		// Audio groups declared after the variants that reference them still apply; each video playlist is one track,
		// paired with the audio of all three groups, and with the highest of its BANDWIDTHs
		const videoTracks = await input.getVideoTracks();
		const audioTracks = await input.getAudioTracks();
		expect(await Promise.all(audioTracks.map(x => x.getCodec()))).toEqual(['aac', 'ac3', 'eac3']);
		expect(await Promise.all(audioTracks.map(x => x.getNumberOfChannels()))).toEqual([2, 6, 6]);

		const v5 = videoTracks[0]!;
		const v2 = videoTracks[1]!;
		expect(await v5.getBitrate()).toBe(2399619);
		expect(await v5.getAverageBitrate()).toBe(2390686);
		expect(await v2.getBitrate()).toBe(763555);
		for (const video of [v5, v2]) {
			expect(await video.getPairableAudioTracks()).toEqual(audioTracks);
		}
		expect(await videoTracks[2]!.hasOnlyKeyPackets()).toBe(true);
		expect(videoTracks).toHaveLength(3);

		expect(await input.getPrimaryVideoTrack()).toBe(v5);
		expect(await input.getPrimaryAudioTrack()).toBe(audioTracks[0]);
		expect(requests).toEqual(['master.m3u8']);
	});

	test('Shaka packager: six audio renditions of one group, the 6-channel one neither DEFAULT nor AUTOSELECT', async () => {
		// storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8 (fewer variants)
		const master = `#EXTM3U
## Generated with https://github.com/google/shaka-packager version v2.3.0-5bf8ad5-release

#EXT-X-MEDIA:TYPE=AUDIO,URI="playlist_a-eng-0128k-aac-2c.mp4.m3u8",GROUP-ID="default-audio-group",LANGUAGE="en",NAME="stream_5",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2"
#EXT-X-MEDIA:TYPE=AUDIO,URI="playlist_a-deu-0128k-aac-2c.mp4.m3u8",GROUP-ID="default-audio-group",LANGUAGE="de",NAME="stream_4",AUTOSELECT=YES,CHANNELS="2"
#EXT-X-MEDIA:TYPE=AUDIO,URI="playlist_a-ita-0128k-aac-2c.mp4.m3u8",GROUP-ID="default-audio-group",LANGUAGE="it",NAME="stream_8",AUTOSELECT=YES,CHANNELS="2"
#EXT-X-MEDIA:TYPE=AUDIO,URI="playlist_a-fra-0128k-aac-2c.mp4.m3u8",GROUP-ID="default-audio-group",LANGUAGE="fr",NAME="stream_7",AUTOSELECT=YES,CHANNELS="2"
#EXT-X-MEDIA:TYPE=AUDIO,URI="playlist_a-spa-0128k-aac-2c.mp4.m3u8",GROUP-ID="default-audio-group",LANGUAGE="es",NAME="stream_9",AUTOSELECT=YES,CHANNELS="2"
#EXT-X-MEDIA:TYPE=AUDIO,URI="playlist_a-eng-0384k-aac-6c.mp4.m3u8",GROUP-ID="default-audio-group",LANGUAGE="en",NAME="stream_6",CHANNELS="6"

#EXT-X-MEDIA:TYPE=SUBTITLES,URI="playlist_s-en.webvtt.m3u8",GROUP-ID="default-text-group",LANGUAGE="en",NAME="stream_0",DEFAULT=YES,AUTOSELECT=YES
#EXT-X-MEDIA:TYPE=SUBTITLES,URI="playlist_s-pt-BR.webvtt.m3u8",GROUP-ID="default-text-group",LANGUAGE="pt-BR",NAME="stream_3",AUTOSELECT=YES

#EXT-X-STREAM-INF:BANDWIDTH=8062646,AVERAGE-BANDWIDTH=1824731,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=768x576,AUDIO="default-audio-group",SUBTITLES="default-text-group"
playlist_v-0576p-1400k-libx264.mp4.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=827972,AVERAGE-BANDWIDTH=482170,CODECS="avc1.42c01e,mp4a.40.2",RESOLUTION=192x144,AUDIO="default-audio-group",SUBTITLES="default-text-group"
playlist_v-0144p-0100k-libx264.mp4.m3u8
`;
		using memory = createMemoryInput(new Map([['hls.m3u8', encodeText(master)]]), 'hls.m3u8');
		const { input } = memory;

		const audioTracks = await input.getAudioTracks();
		const described = await Promise.all(audioTracks.map(describeTrack));
		expect(described.map(x => [x.name, x.language, x.primary, x.default])).toEqual([
			['stream_5', 'en', true, true],
			['stream_4', 'de', false, true],
			['stream_8', 'it', false, true],
			['stream_7', 'fr', false, true],
			['stream_9', 'es', false, true],
			['stream_6', 'en', false, false],
		]);
		expect(await Promise.all(audioTracks.map(x => x.getNumberOfChannels()))).toEqual([2, 2, 2, 2, 2, 6]);
		expect(await input.getPrimaryAudioTrack()).toBe(audioTracks[0]);
		expect(await (await input.getPrimaryVideoTrack())!.getDisplayHeight()).toBe(576);
	});

	test('Audio-only renditions: no video codec in CODECS, URI-less DEFAULT rendition in the variant', async () => {
		// playertest.longtailvideo.com/adaptive/alt-audio-no-video/angel-one.m3u8 (hls.js "Alternate audio only")
		const master = `#EXTM3U
## Modified to only contain alternate audio tracks and no video

#EXT-X-MEDIA:TYPE=SUBTITLES,URI="playlist_s-en.webvtt.m3u8",GROUP-ID="default-text-group",LANGUAGE="en",NAME="English",DEFAULT=YES,AUTOSELECT=YES

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="default-audio-group",LANGUAGE="en",NAME="English",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2"
#EXT-X-MEDIA:TYPE=AUDIO,URI="playlist_a-deu-0128k-aac-2c.mp4.m3u8",GROUP-ID="default-audio-group",LANGUAGE="de",NAME="German",AUTOSELECT=YES,CHANNELS="2"
#EXT-X-MEDIA:TYPE=AUDIO,URI="playlist_a-spa-0128k-aac-2c.mp4.m3u8",GROUP-ID="default-audio-group",LANGUAGE="es",NAME="Spanish, Castilian",AUTOSELECT=YES,CHANNELS="2"
## #EXT-X-MEDIA:TYPE=AUDIO,URI="playlist_a-eng-0384k-aac-6c.mp4.m3u8",GROUP-ID="default-audio-group",LANGUAGE="en",NAME="English (6-ch)",CHANNELS="6"

#EXT-X-STREAM-INF:BANDWIDTH=482170,AVERAGE-BANDWIDTH=282170,CODECS="mp4a.40.2",AUDIO="default-audio-group",SUBTITLES="default-text-group"
https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/playlist_a-eng-0128k-aac-2c.mp4.m3u8
`;
		using memory = createMemoryInput(new Map([['angel-one.m3u8', encodeText(master)]]), 'angel-one.m3u8');
		const { input } = memory;

		// The "##" line is a comment, not a fourth rendition
		const tracks = await input.getTracks();
		expect(await Promise.all(tracks.map(describeTrack))).toEqual([
			{ type: 'audio', codec: 'aac', name: 'English', language: 'en', bitrate: 482170, primary: true, default: true, keyOnly: true },
			{ type: 'audio', codec: 'aac', name: 'German', language: 'de', bitrate: null, primary: false, default: true, keyOnly: true },
			{ type: 'audio', codec: 'aac', name: 'Spanish, Castilian', language: 'es', bitrate: null, primary: false, default: true, keyOnly: true },
		]);
		expect(await input.getPrimaryVideoTrack()).toBe(null);
		expect(await input.getPrimaryAudioTrack()).toBe(tracks[0]);
	});

	test('Unified Streaming: audio-only variants with URI-less renditions, and legacy decimal AVC codec strings', async () => {
		// s3.amazonaws.com/qa.jwplayer.com/~alex/121628/new_master.m3u8 (hls.js "Multiple non-alternate audio levels")
		const audioMaster = `#EXTM3U
#EXT-X-VERSION:4
## Created with Unified Streaming Platform(version=1.7.28)

# AUDIO groups
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aach-64",NAME="audio",AUTOSELECT=YES,DEFAULT=YES,CHANNELS="2"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aacl-128",NAME="audio",AUTOSELECT=YES,DEFAULT=YES,CHANNELS="2"

# variants
#EXT-X-STREAM-INF:BANDWIDTH=75000,AVERAGE-BANDWIDTH=68000,CODECS="mp4a.40.5",AUDIO="audio-aach-64"
live.isml/live-audio=64000.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=150000,AVERAGE-BANDWIDTH=136000,CODECS="mp4a.40.2",AUDIO="audio-aacl-128"
live.isml/live-audio=128000.m3u8
`;
		using audioInput = createMemoryInput(new Map([['new_master.m3u8', encodeText(audioMaster)]]), 'new_master.m3u8');
		const audioTracks = await audioInput.input.getTracks();
		expect(await Promise.all(audioTracks.map(describeTrack))).toEqual([
			{ type: 'audio', codec: 'aac', name: 'audio', language: 'und', bitrate: 75000, primary: true, default: true, keyOnly: true },
			{ type: 'audio', codec: 'aac', name: 'audio', language: 'und', bitrate: 150000, primary: true, default: true, keyOnly: true },
		]);
		expect(await Promise.all(audioTracks.map(x => x.getCodecParameterString()))).toEqual(['mp4a.40.5', 'mp4a.40.2']);
		expect(await audioInput.input.getPrimaryAudioTrack()).toBe(audioTracks[1]);

		// demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8: Apple's old
		// "avc1.<profile>.<level>" decimal form, which predates RFC 6381
		const videoMaster = `#EXTM3U
#EXT-X-VERSION:1
## Created with Unified Streaming Platform  (version=1.13.0-29687)

# variants
#EXT-X-STREAM-INF:BANDWIDTH=493000,CODECS="mp4a.40.2,avc1.66.30",RESOLUTION=224x100,FRAME-RATE=24
tears-of-steel-audio_eng=64008-video_eng=401000.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1197000,CODECS="mp4a.40.2,avc1.77.31",RESOLUTION=784x350,FRAME-RATE=24
tears-of-steel-audio_eng=128002-video_eng=1001000.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2468000,CODECS="mp4a.40.2,avc1.100.40",RESOLUTION=1680x750,FRAME-RATE=24,VIDEO-RANGE=SDR
tears-of-steel-audio_eng=128002-video_eng=2200000.m3u8

# variants
#EXT-X-STREAM-INF:BANDWIDTH=68000,CODECS="mp4a.40.2"
tears-of-steel-audio_eng=64008.m3u8
`;
		using videoInput = createMemoryInput(new Map([['tears-of-steel.ism/.m3u8', encodeText(videoMaster)]]), 'tears-of-steel.ism/.m3u8');
		const videoTracks = await videoInput.input.getVideoTracks();
		expect(await Promise.all(videoTracks.map(x => x.getCodec()))).toEqual(['avc', 'avc', 'avc']);
		expect(await Promise.all(videoTracks.map(x => x.getDisplayWidth()))).toEqual([224, 784, 1680]);
		expect(await videoInput.input.getAudioTracks()).toHaveLength(4);
		expect(videoInput.requests).toEqual(['tears-of-steel.ism/.m3u8']);
	});

	test('Apple Dolby Vision and Atmos: variants of unknown video codecs are left out, their audio stays', async () => {
		// devstreaming-cdn.apple.com/videos/streaming/examples/adv_dv_atmos/main.m3u8 (excerpt): Dolby Vision profile 5
		// (dvh1) and Motion JPEG trick play variants next to HDR10 HEVC ones
		const master = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ec3-48-768",NAME="English",LANGUAGE="en-US",AUTOSELECT=YES,DEFAULT=YES,CHANNELS="16/JOC",URI="atmos_en/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ec3-48-768",NAME="English (DVS)",LANGUAGE="en-US",AUTOSELECT=YES,DEFAULT=NO,CHANNELS="16/JOC",CHARACTERISTICS="public.accessibility.describes-video",URI="atmos_dvs_en/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aaclc-48-160",NAME="English",LANGUAGE="en-US",AUTOSELECT=YES,DEFAULT=YES,CHANNELS="2",URI="stereo160_en/prog_index.m3u8"

#EXT-X-I-FRAME-STREAM-INF:AVERAGE-BANDWIDTH=177512,BANDWIDTH=296000,VIDEO-RANGE=SDR,CODECS="mjpg",RESOLUTION=400x226,URI="motionJpegTrickPlay/iframe_index.m3u8"
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=25097073,BANDWIDTH=37409767,VIDEO-RANGE=PQ,CODECS="dvh1.05.06,ec-3",RESOLUTION=3840x2160,FRAME-RATE=23.976,CLOSED-CAPTIONS="cc",AUDIO="ec3-48-768",SUBTITLES="subtitles"
dolby_vision_2160/prog_index.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=16657358,BANDWIDTH=21623778,VIDEO-RANGE=PQ,CODECS="hvc1.2.20000000.H150.B0,ec-3",RESOLUTION=3840x2160,FRAME-RATE=23.976,CLOSED-CAPTIONS="cc",AUDIO="ec3-48-768",SUBTITLES="subtitles"
hdr10_2160/prog_index.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=2167358,BANDWIDTH=3623778,VIDEO-RANGE=SDR,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=23.976,CLOSED-CAPTIONS="cc",AUDIO="aaclc-48-160",SUBTITLES="subtitles"
sdr_720/prog_index.m3u8
`;
		using memory = createMemoryInput(new Map([['main.m3u8', encodeText(master)]]), 'main.m3u8');
		const { input, requests } = memory;

		const videoTracks = await input.getVideoTracks();
		expect(await Promise.all(videoTracks.map(x => x.getCodecParameterString())))
			.toEqual(['hvc1.2.20000000.H150.B0', 'avc1.64001f']);
		const audioTracks = await input.getAudioTracks();
		expect(await Promise.all(audioTracks.map(describeTrack))).toMatchObject([
			{ codec: 'eac3', name: 'English', language: 'en', primary: true },
			{ codec: 'eac3', name: 'English (DVS)', language: 'en', primary: false },
			{ codec: 'aac', name: 'English', language: 'en', primary: true },
		]);
		expect(await videoTracks[0]!.getPairableAudioTracks()).toEqual(audioTracks.slice(0, 2));
		expect(await videoTracks[1]!.getPairableAudioTracks()).toEqual(audioTracks.slice(2));
		expect(requests).toEqual(['main.m3u8']);
	});

	test('Wowza: MP3 audio declared as mp4a.40.34', async () => {
		// pl.streamingvideoprovider.com/mp3-playlist/playlist.m3u8 (hls.js "MPEG Audio Only demo")
		const master = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=63701,CODECS="mp4a.40.34"
chunklist_w905519204.m3u8
`;
		using memory = createMemoryInput(new Map([['playlist.m3u8', encodeText(master)]]), 'playlist.m3u8');
		const { input } = memory;

		const tracks = await input.getTracks();
		expect(await Promise.all(tracks.map(x => x.getCodec()))).toEqual(['mp3']);
	});
});

const readTrackPackets = async (input: Input, type: 'video' | 'audio', options: { skipLiveWait?: boolean } = {}) => {
	const track = (await input.getTracks()).find(x => x.type === type);
	if (!track) {
		throw new Error(`No ${type} track.`);
	}

	const packets = [];
	for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, options)) {
		packets.push(packet);
	}

	return packets;
};

const packetSummary = (packets: { timestamp: number; duration: number; byteLength: number; type: string }[]) =>
	packets.map(x => `${roundTo(x.timestamp)}/${roundTo(x.duration)}/${x.byteLength}/${x.type}`);

describe('Media playlists', () => {
	test('Apple bipbop: one TS file split into segments by byte ranges', async () => {
		const { segments } = await segmentEdts({ segmentFormat: new MpegTsOutputFormat() });
		const mainTs = concatBytes(segments.map(x => x.bytes));

		// devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/gear1/prog_index.m3u8: explicit offsets
		// and a tab after the EXTINF comma
		const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-VERSION:4', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
		const implicitLines = [...lines];
		const separateLines = [...lines];
		let offset = 0;
		for (const segment of segments) {
			lines.push(`#EXTINF:${segment.duration},\t`, `#EXT-X-BYTERANGE:${segment.bytes.length}@${offset}`, 'main.ts');
			// Offsets may also be left out after the first range
			implicitLines.push(`#EXTINF:${segment.duration},`, `#EXT-X-BYTERANGE:${segment.bytes.length}${offset === 0 ? '@0' : ''}`, 'main.ts');
			separateLines.push(`#EXTINF:${segment.duration},`, segment.uri);
			offset += segment.bytes.length;
		}
		const files: MemoryFiles = new Map([
			['prog_index.m3u8', encodeText([...lines, '#EXT-X-ENDLIST', ''].join('\n'))],
			['implicit.m3u8', encodeText([...implicitLines, '#EXT-X-ENDLIST', ''].join('\n'))],
			['separate.m3u8', encodeText([...separateLines, '#EXT-X-ENDLIST', ''].join('\n'))],
			['main.ts', mainTs],
			...segments.map(x => [x.uri, x.bytes] as const),
		]);

		const read = async (path: string) => {
			using memory = createMemoryInput(files, path);
			const { input, requests } = memory;
			return {
				video: packetSummary(await readTrackPackets(input, 'video')),
				audio: packetSummary(await readTrackPackets(input, 'audio')),
				requests,
			};
		};

		const byteRanges = await read('prog_index.m3u8');
		const implicit = await read('implicit.m3u8');
		const separate = await read('separate.m3u8');
		expect(byteRanges.video).toEqual(separate.video);
		expect(byteRanges.audio).toEqual(separate.audio);
		expect(implicit.video).toEqual(separate.video);
		expect(implicit.audio).toEqual(separate.audio);
		expect(byteRanges.requests).toEqual(['prog_index.m3u8', 'main.ts']);

		// Same packets as reading main.ts as one transport stream, shifted so that the video starts at 0
		using plainInput = new Input({ source: new BufferSource(mainTs), formats: ALL_FORMATS });
		const plainVideo = await readPackets((await plainInput.getVideoTracks())[0]!);
		const shift = plainVideo[0]!.timestamp;
		expect(byteRanges.video).toEqual(packetSummary(plainVideo.map(x => x.clone({ timestamp: x.timestamp - shift }))));
		expect(byteRanges.video.length).toBe(225);
	});

	test('Apple bipbop: packed AAC in one file, each byte range starting with an ID3 PRIV timestamp', async () => {
		const frames = loadAdtsFrames().slice(0, 3 * 430);
		const frameDuration = 1024 / 44100;
		// devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/gear0/prog_index.m3u8 (main.aac)
		const segments = [0, 1, 2].map(k => concatBytes([
			createTimestampId3Tag(10 + k * 430 * frameDuration),
			...frames.slice(k * 430, (k + 1) * 430),
		]));
		const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:11', '#EXT-X-VERSION:4', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
		let offset = 0;
		for (const segment of segments) {
			lines.push('#EXTINF:9.9846,\t', `#EXT-X-BYTERANGE:${segment.length}@${offset}`, 'main.aac');
			offset += segment.length;
		}
		lines.push('#EXT-X-ENDLIST', '');

		const files: MemoryFiles = new Map([
			['gear0/prog_index.m3u8', encodeText(lines.join('\n'))],
			['gear0/main.aac', concatBytes(segments)],
		]);
		using memory = createMemoryInput(files, 'gear0/prog_index.m3u8');
		const { input } = memory;

		const packets = await readTrackPackets(input, 'audio');
		expect(packets).toHaveLength(1290);
		expect(packets.map(x => x.byteLength)).toEqual(frames.map(x => x.length));
		for (let i = 0; i < packets.length; i++) {
			expect(packets[i]!.timestamp).toBeCloseTo(i * frameDuration, 4);
		}
	});

	test('Apple fMP4 examples: one fMP4 file with an EXT-X-MAP byte range and segment byte ranges', async () => {
		const { init, segments } = await segmentEdts({ segmentFormat: new CmafOutputFormat() });
		const mainMp4 = concatBytes([init!, ...segments.map(x => x.bytes)]);

		// devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/v7/prog_index.m3u8
		const header = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-VERSION:7', '#EXT-X-MEDIA-SEQUENCE:1', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
		const lines = [...header, `#EXT-X-MAP:URI="main.mp4",BYTERANGE="${init!.length}@0"`];
		const separateLines = [...header, '#EXT-X-MAP:URI="init.mp4"'];
		let offset = init!.length;
		for (const segment of segments) {
			lines.push(`#EXTINF:${segment.duration.toFixed(5)},\t`, `#EXT-X-BYTERANGE:${segment.bytes.length}@${offset}`, 'main.mp4');
			separateLines.push(`#EXTINF:${segment.duration.toFixed(5)},\t`, segment.uri);
			offset += segment.bytes.length;
		}
		const files: MemoryFiles = new Map([
			['v7/prog_index.m3u8', encodeText([...lines, '#EXT-X-ENDLIST', ''].join('\n'))],
			['v7/separate.m3u8', encodeText([...separateLines, '#EXT-X-ENDLIST', ''].join('\n'))],
			['v7/main.mp4', mainMp4],
			['v7/init.mp4', init!],
			...segments.map(x => [`v7/${x.uri}`, x.bytes] as const),
		]);

		const read = async (path: string) => {
			using memory = createMemoryInput(files, path);
			const { input, requests } = memory;
			return {
				video: packetSummary(await readTrackPackets(input, 'video')),
				audio: packetSummary(await readTrackPackets(input, 'audio')),
				requests,
			};
		};

		const byteRanges = await read('v7/prog_index.m3u8');
		const separate = await read('v7/separate.m3u8');
		expect(byteRanges.video).toEqual(separate.video);
		expect(byteRanges.audio).toEqual(separate.audio);
		expect(byteRanges.video.length).toBe(225);
		expect(byteRanges.requests).toEqual(['v7/prog_index.m3u8', 'v7/main.mp4']);
	});

	test('Bento4 AES-128 fMP4: the init section before EXT-X-KEY stays in the clear, unquoted key URI', async () => {
		const { init, segments } = await segmentEdts({ segmentFormat: new CmafOutputFormat() });
		const key = new Uint8Array(16).map((_, i) => 0x10 + i);

		// storage.googleapis.com/shaka-demo-assets/sintel-fmp4-aes/video/avc1/1/media.m3u8: no IV attribute, so each
		// segment's IV is its media sequence number
		const lines = [
			'#EXTM3U',
			'# Created with Bento4 mp4-dash.py, VERSION=2.0.0-639',
			'#',
			'#EXT-X-VERSION:6',
			'#EXT-X-PLAYLIST-TYPE:VOD',
			'#EXT-X-INDEPENDENT-SEGMENTS',
			'#EXT-X-TARGETDURATION:2',
			'#EXT-X-MEDIA-SEQUENCE:0',
			'#EXT-X-MAP:URI="init.mp4"',
			'#EXT-X-KEY:METHOD=AES-128,URI=key0.bin',
		];
		const clearLines = lines.filter(x => !x.startsWith('#EXT-X-KEY'));
		const files: MemoryFiles = new Map([['init.mp4', init!], ['key0.bin', key]]);
		for (let i = 0; i < segments.length; i++) {
			const iv = new Uint8Array(16);
			iv[15] = i;
			files.set(`seg-${i + 1}.m4s`, await encryptAes128(segments[i]!.bytes, key, iv));
			files.set(`clear-${i + 1}.m4s`, segments[i]!.bytes);
			lines.push(`#EXTINF:${segments[i]!.duration},`, `seg-${i + 1}.m4s`);
			clearLines.push(`#EXTINF:${segments[i]!.duration},`, `clear-${i + 1}.m4s`);
		}
		files.set('media.m3u8', encodeText([...lines, '#EXT-X-ENDLIST', ''].join('\n')));
		files.set('clear.m3u8', encodeText([...clearLines, '#EXT-X-ENDLIST', ''].join('\n')));

		using encrypted = createMemoryInput(files, 'media.m3u8');
		using clear = createMemoryInput(files, 'clear.m3u8');

		const encryptedVideo = await readTrackPackets(encrypted.input, 'video');
		const encryptedAudio = await readTrackPackets(encrypted.input, 'audio');
		const clearVideo = await readTrackPackets(clear.input, 'video');
		const clearAudio = await readTrackPackets(clear.input, 'audio');
		expect(encryptedVideo).toHaveLength(225);
		expect(encryptedAudio).toHaveLength(clearAudio.length);
		expect(clearAudio.length).toBeGreaterThan(380);
		expect(packetSummary(encryptedVideo)).toEqual(packetSummary(clearVideo));
		expect(packetSummary(encryptedAudio)).toEqual(packetSummary(clearAudio));

		// The decrypted payloads are the clear segments' bytes, not just boxes that happen to parse
		expect(encryptedVideo.map(x => x.data)).toEqual(clearVideo.map(x => x.data));
		expect(encryptedAudio.map(x => x.data)).toEqual(clearAudio.map(x => x.data));
		expect(encrypted.requests.filter(x => x === 'key0.bin')).toHaveLength(1);
	});
});

describe('Discontinuities, program date times and keys', () => {
	test('Yospace ad insertion: keys with query strings, ad breaks in the clear, an ad segment repeated in two breaks', async () => {
		const content = await segmentEdts({ segmentFormat: new MpegTsOutputFormat() });
		// The ads have timestamps of their own, like the ad server's transcodes in the real stream
		const ads = await segmentEdts({ segmentFormat: new MpegTsOutputFormat(), mediaTimestampBase: 71647 });

		const [c0, c1, c2] = content.segments;
		const [a0, a1] = ads.segments;
		const ivs = ['001BD02F', '001BD030', '001BD047'];
		const keys = [1, 2, 5].map(n => new Uint8Array(16).fill(n));
		const encrypt = (bytes: Uint8Array, index: number) => encryptAes128(bytes, keys[index]!, Uint8Array.from(
			ivs[index]!.padStart(32, '0').match(/../g)!.map(x => parseInt(x, 16)),
		));

		// test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8 (hls.js "Ad-insertion in event stream")
		const playlist = `#EXTM3U
#EXT-X-YOSPACE-ANALYTICS-URL:"https://csm-e.example.yospace.com/csm/analytics;jsessionid=E97CB20FD3BCE93F"
#EXT-X-TARGETDURATION:2
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-KEY:METHOD=AES-128,URI="key1.json?f=1041&s=0&p=1822767&m=1506045858",IV=0x000000000000000000000000${ivs[0]}
#EXTINF:${c0!.duration},
1041_6_1822767.ts?m=1506045858
#EXT-X-KEY:METHOD=AES-128,URI="key2.json?f=1041&s=0&p=1822768&m=1506045858",IV=0x000000000000000000000000${ivs[1]}
#EXTINF:${c1!.duration},
1041_6_1822768.ts?m=1506045858
#EXT-X-DISCONTINUITY
#EXT-X-KEY:METHOD=NONE
#EXTINF:${a0!.duration},
u-6400-m-720x408-1628-a-96-1-1.ts
#EXTINF:${a1!.duration},
u-6400-m-720x408-1628-a-96-1-2.ts
#EXT-X-DISCONTINUITY
#EXTINF:${a0!.duration},
u-6400-m-720x408-1628-a-96-1-1-2.ts
#EXTINF:${a1!.duration},
u-6400-m-720x408-1628-a-96-1-2.ts
#EXT-X-DISCONTINUITY
#EXT-X-KEY:METHOD=AES-128,URI="key5.json?f=1041&s=0&p=1822791&m=1506045858",IV=0x000000000000000000000000${ivs[2]}
#EXTINF:${c2!.duration},
1041_6_1822791.ts?m=1506045858
#EXT-X-ENDLIST
`;
		const files: MemoryFiles = new Map([
			['manifest.m3u8', encodeText(playlist)],
			['key1.json?f=1041&s=0&p=1822767&m=1506045858', keys[0]!],
			['key2.json?f=1041&s=0&p=1822768&m=1506045858', keys[1]!],
			['key5.json?f=1041&s=0&p=1822791&m=1506045858', keys[2]!],
			['1041_6_1822767.ts?m=1506045858', await encrypt(c0!.bytes, 0)],
			['1041_6_1822768.ts?m=1506045858', await encrypt(c1!.bytes, 1)],
			['1041_6_1822791.ts?m=1506045858', await encrypt(c2!.bytes, 2)],
			['u-6400-m-720x408-1628-a-96-1-1.ts', a0!.bytes],
			['u-6400-m-720x408-1628-a-96-1-2.ts', a1!.bytes],
			['u-6400-m-720x408-1628-a-96-1-1-2.ts', a0!.bytes],
		]);
		using memory = createMemoryInput(files, 'manifest.m3u8');
		const { input, requests } = memory;

		const video = await readTrackPackets(input, 'video');
		const audio = await readTrackPackets(input, 'audio');

		// Each discontinuity's video starts where the playlist places it, so the timeline stays continuous
		const readSegmentVideo = async (bytes: Uint8Array) => {
			using segmentInput = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
			return await readPackets((await segmentInput.getVideoTracks())[0]!);
		};
		const breaks = [[c0!, c1!], [a0!, a1!], [a0!, a1!], [c2!]];
		let start = 0;
		let index = 0;
		for (const segments of breaks) {
			const clearPackets = [];
			for (const segment of segments) {
				clearPackets.push(...await readSegmentVideo(segment.bytes));
			}

			const breakPackets = video.slice(index, index + clearPackets.length);
			expect(breakPackets[0]!.timestamp).toBeCloseTo(start, 3);
			const breakEnd = start + segments.reduce((sum, segment) => sum + segment.duration, 0);
			expect(breakPackets.every(x => x.timestamp >= start - 1e-3 && x.timestamp < breakEnd)).toBe(true);
			// The decrypted content carries the clear segments' bytes
			expect(breakPackets.map(x => x.data)).toEqual(clearPackets.map(x => x.data));

			index += clearPackets.length;
			start = breakEnd;
		}
		expect(video).toHaveLength(index);
		expect(index).toBeGreaterThan(300);

		for (let i = 1; i < audio.length; i++) {
			expect(audio[i]!.timestamp).toBeGreaterThan(audio[i - 1]!.timestamp);
		}

		// Key URIs keep their query strings
		expect(requests).toContain('key1.json?f=1041&s=0&p=1822767&m=1506045858');
		expect(requests).toContain('key5.json?f=1041&s=0&p=1822791&m=1506045858');
	});

	test('Wowza packed MP3: timestamps follow the ID3 PRIV timestamps, not the rounded EXTINF durations', async () => {
		// pl.streamingvideoprovider.com/mp3-playlist/chunklist_w905519204.m3u8: every EXTINF says 10.0 while the
		// segments' PRIV timestamps advance by the actual audio duration
		const frames = (await loadMp3Frames()).slice(100, 100 + 3 * 400);
		const frameDuration = 576 / 24000;
		const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0'];
		const files: MemoryFiles = new Map();
		for (let k = 0; k < 3; k++) {
			const uri = `media_w905519204_${k}.mp3`;
			files.set(uri, concatBytes([
				createTimestampId3Tag(k * 400 * frameDuration),
				...frames.slice(k * 400, (k + 1) * 400),
			]));
			lines.push('#EXTINF:10.0,', uri);
		}
		lines.push('#EXT-X-ENDLIST', '');
		files.set('chunklist_w905519204.m3u8', encodeText(lines.join('\n')));
		files.set('playlist.m3u8', encodeText('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=63701,CODECS="mp4a.40.34"\nchunklist_w905519204.m3u8\n'));

		using memory = createMemoryInput(files, 'playlist.m3u8');
		const { input } = memory;

		const packets = await readTrackPackets(input, 'audio');
		expect(packets).toHaveLength(1200);
		expect(packets.map(x => x.byteLength)).toEqual(frames.map(x => x.length));
		for (let i = 0; i < packets.length; i++) {
			expect(packets[i]!.timestamp).toBeCloseTo(i * frameDuration, 4);
		}
		expect(await (await input.getPrimaryAudioTrack())!.getDurationFromMetadata()).toBe(30);
	});

	test('Boxee: one TS file as every segment, with program date time jumps between discontinuities', async () => {
		const { segments } = await segmentEdts({ segmentFormat: new MpegTsOutputFormat() });
		const fragment = segments[0]!;

		// playertest.longtailvideo.com/adaptive/boxee/playlist.m3u8 (hls.js "PDT with large gaps")
		const dates = [
			'2012-12-06T19:10:03+00:00',
			'2012-12-06T19:11:06+00:00',
			'2012-12-06T19:23:23+00:00',
			'2012-12-06T19:23:29+00:00',
			'2012-12-06T19:24:56+00:00',
		];
		const playlist = [
			'#EXTM3U',
			'#EXT-X-PLAYLIST-TYPE:VOD',
			'#EXT-X-MEDIA-SEQUENCE:1',
			'#EXT-X-ALLOW-CACHE:YES',
			'#EXT-X-TARGETDURATION:2',
			'#EXT-X-VERSION:3',
			`#EXT-X-PROGRAM-DATE-TIME:${dates[0]}`,
			...dates.flatMap(date => [
				'#EXT-X-DISCONTINUITY',
				`#EXT-X-PROGRAM-DATE-TIME:${date}`,
				`#EXTINF:${fragment.duration},{}`,
				'fragment.ts',
			]),
			'#EXT-X-ENDLIST',
			'',
		].join('\n');
		const files: MemoryFiles = new Map([['playlist.m3u8', encodeText(playlist)], ['fragment.ts', fragment.bytes]]);
		using memory = createMemoryInput(files, 'playlist.m3u8');
		const { input, requests } = memory;

		const videoTrack = (await input.getVideoTracks())[0]!;
		expect(await videoTrack.isRelativeToUnixEpoch()).toBe(true);

		const video = await readTrackPackets(input, 'video');
		const perSegment = video.length / dates.length;
		expect(perSegment).toBe(Math.round(perSegment));
		for (const [k, date] of dates.entries()) {
			expect(video[k * perSegment]!.timestamp).toBe(Date.parse(date) / 1000);
		}

		// A timestamp in a gap finds the last packet before it
		const sink = new EncodedPacketSink(videoTrack);
		const lastBeforeGap = video.slice(0, perSegment).reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
		expect((await sink.getPacket(Date.parse(dates[0]!) / 1000 + 30))!.timestamp).toBe(lastBeforeGap.timestamp);
		expect(requests.filter(x => x === 'fragment.ts')).toHaveLength(1);
	});
});

const liveSegmentUri = (sequenceNumber: number) => `https://chunk.example.mux.com/v1/chunk/4bGIpBHyHlmZS3nRRb01eBLE/${sequenceNumber}.m4s?skid=default&signature=NmFmNzE3ZTBf==&zone=2`;

describe('Live playlists', () => {
	test('Mux low-latency HLS: partial segments and hints are skipped, EXT-X-MAP comes before the media sequence', async () => {
		const { init, segments } = await segmentEdts({ segmentFormat: new CmafOutputFormat() });

		// stream.mux.com/v69RSHhFelSm4701snP22dYz2jICy4E4FUyk02rW4gxRM.m3u8 (hls.js "Live HLS"): absolute, signed URIs
		const initUri = 'https://chunk.example.mux.com/v1/chunk/4bGIpBHyHlmZS3nRRb01eBLE/18446744073709551615.m4s?skid=default&signature=NmFmNzE3ZTBf==&zone=2';
		const start = Date.parse('2026-11-06T13:34:51.252Z');
		let time = start;
		const lines = [
			'#EXTM3U',
			'#EXT-X-VERSION:7',
			'#EXT-X-TARGETDURATION:2',
			'#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=2.171',
			'#EXT-X-PART-INF:PART-TARGET=1.034',
			`#EXT-X-MAP:URI="${initUri}"`,
			'#EXT-X-MEDIA-SEQUENCE:9889',
		];
		const files: MemoryFiles = new Map([[initUri, init!]]);
		for (let i = 0; i < 4; i++) {
			lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(time).toISOString().replace('Z', '+00:00')}`, `#EXTINF:${segments[i]!.duration},`, liveSegmentUri(9889 + i));
			files.set(liveSegmentUri(9889 + i), segments[i]!.bytes);
			time += segments[i]!.duration * 1000;
		}
		lines.push(
			`#EXT-X-PROGRAM-DATE-TIME:${new Date(time).toISOString().replace('Z', '+00:00')}`,
			`#EXT-X-PART:DURATION=1,URI="${liveSegmentUri(9893).replace('.m4s', '.0.m4s')}",INDEPENDENT=YES`,
			`#EXT-X-PART:DURATION=1,URI="${liveSegmentUri(9893).replace('.m4s', '.1.m4s')}"`,
			`#EXT-X-PRELOAD-HINT:TYPE=PART,URI="${liveSegmentUri(9893).replace('.m4s', '.2.m4s')}"`,
			'#EXT-X-RENDITION-REPORT:URI="../tuwpAW1WnqG1dmJLfRiLh9p9R2H/rendition.m3u8",LAST-MSN=9892,LAST-PART=1',
			'',
		);
		const playlistUri = 'https://manifest.example.mux.com/Is4YwjUOJOy9G8KlK3Pase3fJEkl/rendition.m3u8?cdn=fastly&expires=1794578400&live=1&skid=edgemv-default-1&signature=NmFmNzE3ZTBfOGJm==';
		files.set(playlistUri, encodeText(lines.join('\n')));

		using memory = createMemoryInput(files, playlistUri);
		const { input, requests } = memory;

		const videoTrack = (await input.getVideoTracks())[0]!;
		expect(await videoTrack.isLive()).toBe(true);
		expect(await videoTrack.getLiveRefreshInterval()).toBe(2);
		expect(await videoTrack.isRelativeToUnixEpoch()).toBe(true);

		const video = await readTrackPackets(input, 'video', { skipLiveWait: true });
		expect(video[0]!.timestamp).toBeCloseTo(start / 1000, 4);
		expect(video).toHaveLength(4 * 48);
		// 192 frames of 40 ms; the first segment's EXTINF also covers the audio that starts before the video
		expect(await videoTrack.computeDuration({ skipLiveWait: true })).toBeCloseTo(start / 1000 + 192 * 0.04, 3);

		// Partial segments and preload hints are low-latency extras; the full segments carry the same media
		expect(requests.some(x => x.includes('.0.m4s') || x.includes('.1.m4s') || x.includes('.2.m4s'))).toBe(false);
		expect(requests.filter(x => x === initUri)).toHaveLength(1);
	});

	test('Unified Streaming live: SCTE-35 date ranges, USP timestamp maps and microsecond program date times', async () => {
		const { segments } = await segmentEdts({ segmentFormat: new MpegTsOutputFormat() });

		// demo.unified-streaming.com/k8s/live/stable/scte35.isml/scte35-audio_eng=128000-video=1000000.m3u8
		const lines = [
			'#EXTM3U',
			'#EXT-X-VERSION:4',
			'## Created with Unified Streaming Platform (version=1.15.29-33409)',
			'#EXT-X-MEDIA-SEQUENCE:934360187',
			'#EXT-X-INDEPENDENT-SEGMENTS',
			'#EXT-X-TARGETDURATION:3',
			'#USP-X-TIMESTAMP-MAP:MPEGTS=1030449568,LOCAL=2026-11-06T13:25:57.120000Z',
			'## splice_insert(auto_return)',
			'#EXT-X-DATERANGE:ID="14831114-1793971549",START-DATE="2026-11-06T13:25:49.440000Z",PLANNED-DURATION=38.4,SCTE35-OUT=0xFC302000000000000000FFF00F0500E24E0A7FFFFE0034BC00C00000000000E4612424',
			'#EXT-X-PROGRAM-DATE-TIME:2026-11-06T13:25:57.120000Z',
		];
		const files: MemoryFiles = new Map();
		for (let i = 0; i < 4; i++) {
			const uri = `scte35-audio_eng=128000-video=1000000-${934360187 + i}.ts`;
			lines.push(`#EXTINF:${segments[i]!.duration}, no desc`, uri);
			files.set(uri, segments[i]!.bytes);
		}
		files.set('scte35.m3u8', encodeText([...lines, ''].join('\n')));

		using memory = createMemoryInput(files, 'scte35.m3u8');
		const { input } = memory;

		const tracks = await input.getTracks();
		expect(await Promise.all(tracks.map(x => x.getLiveRefreshInterval()))).toEqual([3, 3]);
		const video = await readTrackPackets(input, 'video', { skipLiveWait: true });
		expect(video[0]!.timestamp).toBe(Date.parse('2026-11-06T13:25:57.120Z') / 1000);
		expect(await tracks[0]!.getUnixTimeForTimestamp(video[0]!.timestamp)).toBe(video[0]!.timestamp);
	});

	test('Sliding live window: reloads every target duration, continues the timeline, and stops after dispose', { timeout: 20_000 }, async () => {
		const { segments } = await segmentEdts({ segmentFormat: new MpegTsOutputFormat() });

		// The window slides by one segment per reload, like demo.unified-streaming.com's live demos
		const createLiveInput = (endAfterReloads: number) => {
			const reloadTimes: number[] = [];
			const getPlaylist = () => {
				const reload = reloadTimes.length;
				reloadTimes.push(performance.now());
				const first = Math.min(reload, 2);
				const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${100 + first}`];
				for (let i = first; i < first + 3; i++) {
					lines.push(`#EXTINF:${segments[i]!.duration},`, `live-${100 + i}.ts`);
				}
				if (reload >= endAfterReloads) {
					lines.push('#EXT-X-ENDLIST');
				}

				return encodeText([...lines, ''].join('\n'));
			};

			const files: MemoryFiles = new Map(segments.map((x, i) => [`live-${100 + i}.ts`, x.bytes] as const));
			const memory = createMemoryInput(files, 'live.m3u8', {
				getFile: path => (path === 'live.m3u8' ? getPlaylist() : undefined),
			});

			return { ...memory, reloadTimes };
		};

		using live = createLiveInput(2);
		const { input, reloadTimes } = live;

		const videoTrack = (await input.getVideoTracks())[0]!;
		expect(await videoTrack.isLive()).toBe(true);
		expect(await videoTrack.getLiveRefreshInterval()).toBe(1);

		// Reading waits for the reloads until the stream ends; the segments of all reloads form one timeline
		const video = await readTrackPackets(input, 'video');
		const presentation = video.map(x => x.timestamp).sort((a, b) => a - b);
		expect(presentation).toHaveLength(225);
		for (let i = 1; i < presentation.length; i++) {
			expect(presentation[i]! - presentation[i - 1]!).toBeCloseTo(0.04, 3);
		}
		expect(await videoTrack.isLive()).toBe(false);
		expect(reloadTimes).toHaveLength(3);
		for (let i = 1; i < reloadTimes.length; i++) {
			expect(reloadTimes[i]! - reloadTimes[i - 1]!).toBeGreaterThan(900);
		}

		// A stream that never ends: disposing while waiting at the live edge rejects the read and stops reloading
		const endless = createLiveInput(Infinity);
		try {
			const reading = readTrackPackets(endless.input, 'video');
			reading.catch(() => {}); // Awaited below, once the dispose has rejected it
			while (endless.reloadTimes.length < 2) {
				await new Promise(resolve => setTimeout(resolve, 50));
			}
			endless.input.dispose();
			await expect(reading).rejects.toThrow();
			const requestCount = endless.requests.length;
			await new Promise(resolve => setTimeout(resolve, 1500));
			expect(endless.requests).toHaveLength(requestCount);
		} finally {
			endless.input.dispose();
		}
	});

	test('BBC test card: the multivariant playlist redirects to a CDN, and relative URIs resolve against the CDN', async () => {
		const { init, segments } = await segmentEdts({ segmentFormat: new CmafOutputFormat(), video: false });

		// rdmedia.bbc.co.uk/testcard/vod/manifests/radio-flac-en.m3u8 redirects to vod-dash-ww-rd-live.akamaized.net;
		// RFC 3986 5.1.3 makes the redirect target the base URI
		const requestedUrl = 'https://rdmedia.example.co.uk/testcard/vod/manifests/radio-en.m3u8';
		const redirectedUrl = 'https://vod.example.net/testcard/2/manifests/radio-en.m3u8';
		const mediaUrl = 'https://vod.example.net/testcard/2/audio/en-2_0/audio.m3u8';
		const files = new Map<string, Uint8Array>([
			[redirectedUrl, encodeText('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=220000,AVERAGE-BANDWIDTH=200000,CODECS="mp4a.40.2"\n../audio/en-2_0/audio.m3u8\n')],
			[mediaUrl, encodeText([
				'#EXTM3U',
				'#EXT-X-TARGETDURATION:2',
				'#EXT-X-VERSION:7',
				'#EXT-X-PLAYLIST-TYPE:VOD',
				'#EXT-X-MAP:URI="IS.mp4"',
				...segments.flatMap((x, i) => [`#EXTINF:${x.duration},`, `${String(i + 1).padStart(6, '0')}.m4s`]),
				'#EXT-X-ENDLIST',
				'',
			].join('\n'))],
			['https://vod.example.net/testcard/2/audio/en-2_0/IS.mp4', init!],
			...segments.map((x, i) => [`https://vod.example.net/testcard/2/audio/en-2_0/${String(i + 1).padStart(6, '0')}.m4s`, x.bytes] as const),
		]);

		const requests: string[] = [];
		const fetchFn = async (resource: RequestInfo | URL, init?: RequestInit) => {
			const url = resource instanceof Request ? resource.url : resource.toString();
			requests.push(url);
			const file = files.get(url === requestedUrl ? redirectedUrl : url);
			if (!file) {
				return new Response(null, { status: 404 });
			}

			const range = /bytes=(\d+)-(\d*)/.exec(new Headers(init?.headers).get('Range') ?? '');
			const start = range ? Number(range[1]) : 0;
			const end = range?.[2] ? Number(range[2]) + 1 : file.length;
			const response = new Response(file.slice(start, end), {
				status: range ? 206 : 200,
				headers: range ? { 'Content-Range': `bytes ${start}-${end - 1}/${file.length}` } : {},
			});
			if (url === requestedUrl) {
				Object.defineProperty(response, 'redirected', { value: true });
				Object.defineProperty(response, 'url', { value: redirectedUrl });
			}

			return response;
		};

		using input = new Input({ source: new UrlSource(requestedUrl, { fetchFn }), formats: ALL_FORMATS });
		const audio = await readTrackPackets(input, 'audio');
		expect(audio.length).toBeGreaterThan(380);
		expect(requests[0]).toBe(requestedUrl);
		expect(requests.slice(1).every(x => x.startsWith('https://vod.example.net/testcard/2/audio/en-2_0/'))).toBe(true);
	});
});
