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
	['mp3.mp3', 'mp3', 44100, 2],
	// Last, as WebKitGTK hangs on these, which stalls every later decode on the page
	['flac-5.1-24bit.mkv', 'flac', 48000, 6],
	['vorbis.webm', 'vorbis', 44100, 2],
	['opus-5.1.webm', 'opus', 48000, 6],
	['opus-family255-quad.webm', 'opus', 48000, 4],
];

// Codec strings that are wrong on main, with the open PR fixing each. Both values are accepted, so the suite passes
// with and without the fix.
const KNOWN_CODEC_STRING_DIVERGENCES: Record<string, string> = {
	// PR #25: the VP9 codec string takes the transfer from the bitstream's color_space (14) over WebM's Colour (16)
	'vp9-bt2020-pq.webm': 'vp09.02.10.10.01.09.14.09.00',
};

/** Whether the browser decodes this profile and bit depth at all (WebKitGTK only does VP9 and AV1 profile 0, Firefox
 * none of H.264's High 10, High 4:2:2 and High 4:4:4). */
const decodesProfile = async (codecString: string) => {
	const [family, profile, , bitDepth] = codecString.split('.');
	const canonicalCodecStrings: Record<string, string> = {
		vp09: `vp09.${profile}.10.${bitDepth}`,
		av01: `av01.${profile}.00M.${bitDepth}`,
		avc1: codecString, // Just the profile and level
	};
	const canonical = canonicalCodecStrings[family!];
	if (canonical === undefined) {
		return true;
	}

	const support = await VideoDecoder.isConfigSupported({ codec: canonical, codedWidth: 64, codedHeight: 64 });
	return !!support.supported;
};

/** Whether the browser decodes AAC at all (Firefox without the system's FFmpeg doesn't). */
const decodesAudioCodec = async (codecString: string, sampleRate: number, numberOfChannels: number) => {
	if (!codecString.startsWith('mp4a.')) {
		return true;
	}

	const support = await AudioDecoder.isConfigSupported({ codec: codecString, sampleRate, numberOfChannels });
	return !!support.supported;
};

// Whether the platform can decode something is decided with WebCodecs alone, never with Mediabunny, so that a
// Mediabunny failure on a capable platform fails instead of skipping. isConfigSupported() isn't enough: WebKitGTK says
// it decodes codecs that its GStreamer decoders then fail on or hang on. Each probe is a decoder config and the first
// packets of a tiny stream made by FFmpeg (0.4 s of black 64x64 video or 0.1 s of silence), read with
// ffprobe -show_streams -show_packets -show_data:
//   av1       -c:v libaom-av1 -cpu-used 8 -crf 50 (-f obu, with its sequence header)
//   av1Mono   -pix_fmt gray -c:v libaom-av1 -cpu-used 8 -crf 50 (monochrome, which Firefox's dav1d wrapper rejects)
//   avcSar2   -vf setsar=2/1 -c:v libx264 (64x64 with a 2:1 pixel aspect ratio in its SPS; the IDR without its SEI)
//   flac      -c:a flac (16 kHz mono; "fLaC" + the STREAMINFO block)
//   vorbis    -c:a libvorbis -q:a -1 (16 kHz mono; the Xiph-laced headers)
//   opus51    -c:a libopus -b:a 64k (5.1, channel mapping family 1)
//   opusQuad  -c:a libopus -b:a 48k -mapping_family 255 (4 channels)
type Probe = { codec: string; sampleRate?: number; numberOfChannels?: number; description?: string; chunks: string[] };
const PROBES = {
	av1: {
		codec: 'av01.0.00M.08',
		chunks: ['EgAKCgAAAAKv/5tfIAgyDRAAuoAAAkAAAAPOF7o='],
	},
	av1Mono: {
		codec: 'av01.0.00M.08',
		chunks: ['EgAKCgAAAAKv/5tfJUAyDBAA5AAACwAADlK87A==', 'EgAyECAD4EAAAANyAAAFgBAAmRAyEDADwQAAQAbkAAALAHAAnMA='],
	},
	avcSar2: {
		codec: 'avc1.64000a',
		description: 'AWQACv/hABhnZAAKrLIITYgIAAADAAgAAAMAoHiRMkABAAZo68PLIsD9+PgA',
		chunks: ['AAAAH2WIhA7//vdOvwKbVMIqA5JXCuqDugrYp08qbQaN+7k='],
	},
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
	opus51: {
		codec: 'opus',
		sampleRate: 48000,
		numberOfChannels: 6,
		description: 'T3B1c0hlYWQBBjgBgLsAAAAAAQQCAAQBAgMF',
		chunks: [
			'/AL//vwC//5oDQvkwTbsxY2MSUhCbNBoC+TBNuzFjYxJSEJs0A==',
			'/AL//vwC//5oDwfJcifhROpV8fDA0TIpMGgHyXIn4UTqVfHwwNEyKTA=',
			'/AL//vwC//5oDgfJecjJV8CiEiP6WSBwaAfJecjJV8CiEiP6WSBw',
		],
	},
	opusQuad: {
		codec: 'opus',
		sampleRate: 48000,
		numberOfChannels: 4,
		description: 'T3B1c0hlYWQBBDgBgLsAAAAA/wQAAAECAw==',
		chunks: [
			'aA0L5ME27MWNjElIQmzQaA0L5ME27MWNjElIQmzQaA0L5ME27MWNjElIQmzQaAvkwTbsxY2MSUhCbNA=',
			'aA8HyXIn4UTqVfHwwNEyKTBoDwfJcifhROpV8fDA0TIpMGgPB8lyJ+FE6lXx8MDRMikwaAfJcifhROpV8fDA0TIpMA==',
			'aA4HyXnIyVfAohIj+lkgcGgOB8l5yMlXwKISI/pZIHBoDgfJecjJV8CiEiP6WSBwaAfJecjJV8CiEiP6WSBw',
		],
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

type Needs = { probe?: ProbeName; anamorphic?: boolean };
/** What each fixture needs from the platform's decoder, as facts about the file (never asked of Mediabunny). */
const NEEDS: Record<string, Needs> = {
	'h264-sar-16-11.mp4': { anamorphic: true },
	'av1-main-10bit.mp4': { probe: 'av1' },
	'av1-high-444.webm': { probe: 'av1' },
	'av1-professional-422-10bit.webm': { probe: 'av1' },
	'av1-bt709-full.mp4': { probe: 'av1' },
	'av1-monochrome.webm': { probe: 'av1Mono' },
	'flac-5.1-24bit.mkv': { probe: 'flac' },
	'vorbis.webm': { probe: 'vorbis' },
	'opus-5.1.webm': { probe: 'opus51' },
	'opus-family255-quad.webm': { probe: 'opusQuad' },
};

/** Skips a fixture whose decoding the platform can't do (WebKitGTK fails on AV1, FLAC and multichannel Opus, hangs on
 * Vorbis, and scales anamorphic frames to square pixels; Firefox fails on monochrome AV1). */
const skipIfIncapable = async (fileName: string, skip: (condition: boolean, note?: string) => void) => {
	const needs = NEEDS[fileName] ?? {};
	if (needs.probe) {
		skip(!(await probe(needs.probe)).decodes, `${needs.probe} can't be decoded here (native probe)`);
	}
	if (needs.anamorphic) {
		const { visibleSizes } = await probe('avcSar2');
		skip(visibleSizes.some(x => x !== '64x64'), 'the decoder rescales anamorphic frames here (native probe)');
	}
};

test.for(VIDEO_FIXTURES)('Derived video decoder config: %s', async ([fileName, codecString], { skip }) => {
	using input = new Input({
		source: new UrlSource(`/codec-bitstream/${fileName}`),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryVideoTrack())!;
	const acceptedCodecStrings = [codecString, KNOWN_CODEC_STRING_DIVERGENCES[fileName] ?? codecString];
	expect(acceptedCodecStrings).toContain(await track.getCodecParameterString());
	skip(!(await decodesProfile(codecString)), 'the browser can\'t decode this profile at all');
	expect(await track.canDecode()).toBe(true);
	await skipIfIncapable(fileName, skip);

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

test.for(AUDIO_FIXTURES)(
	'Derived audio decoder config: %s',
	async ([fileName, codecString, sampleRate, numberOfChannels], { skip }) => {
		using input = new Input({
			source: new UrlSource(`/codec-bitstream/${fileName}`),
			formats: ALL_FORMATS,
		});

		skip(decodingStalled, 'an earlier decoder failure stalled decoding on this page');
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getCodecParameterString()).toBe(codecString);
		expect(await track.getSampleRate()).toBe(sampleRate);
		expect(await track.getNumberOfChannels()).toBe(numberOfChannels);
		skip(!(await decodesAudioCodec(codecString, sampleRate, numberOfChannels)), 'the browser can\'t decode AAC');
		expect(await track.canDecode()).toBe(true);
		await skipIfIncapable(fileName, skip);

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
