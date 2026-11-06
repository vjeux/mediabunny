// Builds the conversion matrix's synthetic inputs in the browser, with Mediabunny itself: flat gray frames whose level
// identifies the frame (see convmatrix-signal.ts), and short beeps every 250 ms whose frequency identifies the beep.
import { Output, VideoTrackMetadata } from '../../../src/output.js';
import { BufferTarget } from '../../../src/target.js';
import {
	FlacOutputFormat,
	MkvOutputFormat,
	MovOutputFormat,
	Mp3OutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	OggOutputFormat,
	OutputFormat,
	WavOutputFormat,
	WebMOutputFormat,
} from '../../../src/output-format.js';
import { AudioSampleSource, CanvasSource } from '../../../src/media-source.js';
import { AudioCodec, VideoCodec } from '../../../src/codec.js';
import { AudioSample } from '../../../src/sample.js';
import { Quality } from '../../../src/encode.js';
import {
	BEEP_INTERVAL,
	BEEP_LENGTH,
	beepFrequency,
	channelAmplitude,
	frameAlpha,
	frameLevel,
	LEVELS,
} from './convmatrix-signal.js';

export type SyntheticVideo = {
	codec: VideoCodec;
	width?: number;
	height?: number;
	frameRate?: number;
	frameCount?: number;
	/** Timestamp of the first frame. */
	start?: number;
	keyFrameInterval?: number;
	alpha?: boolean;
	rotation?: VideoTrackMetadata['rotation'];
};

export type SyntheticAudio = {
	codec: AudioCodec;
	sampleRate?: number;
	numberOfChannels?: number;
	duration?: number;
	/** Timestamp of the first sample. */
	start?: number;
};

export type SyntheticInput = {
	id: string;
	format: () => OutputFormat;
	video?: SyntheticVideo;
	audio?: SyntheticAudio;
};

/** Full-range gray value that encodes to the limited-range luma of a level. */
const levelGray = (level: number) => Math.round((LEVELS[level]! - 16) * 255 / 219);

/** The beeps as planar float data: beep k starts at k * 250 ms (relative to the first sample). */
export const makeBeepData = (sampleRate: number, numberOfChannels: number, duration: number) => {
	const numberOfFrames = Math.round(sampleRate * duration);
	const data = new Float32Array(numberOfFrames * numberOfChannels);
	const beepFrames = Math.round(BEEP_LENGTH * sampleRate);

	for (let k = 0; k * BEEP_INTERVAL < duration; k++) {
		const start = Math.round(k * BEEP_INTERVAL * sampleRate);
		const frequency = beepFrequency(k);
		for (let i = 0; i < beepFrames && start + i < numberOfFrames; i++) {
			const value = Math.sin(2 * Math.PI * frequency * i / sampleRate);
			for (let c = 0; c < numberOfChannels; c++) {
				data[c * numberOfFrames + start + i] = channelAmplitude(c) * value;
			}
		}
	}

	return { data, numberOfFrames };
};

export const buildSyntheticInput = async (spec: SyntheticInput) => {
	const output = new Output({ format: spec.format(), target: new BufferTarget() });

	let videoSource: CanvasSource | null = null;
	let canvas: OffscreenCanvas | null = null;
	if (spec.video) {
		const video = spec.video;
		canvas = new OffscreenCanvas(video.width ?? 160, video.height ?? 90);
		videoSource = new CanvasSource(canvas, {
			codec: video.codec,
			quality: new Quality('high'),
			keyFrameInterval: video.keyFrameInterval ?? 0.48,
			alpha: video.alpha ? 'keep' : 'discard',
		});
		output.addVideoTrack(videoSource, {
			frameRate: video.frameRate ?? 25,
			...(video.rotation !== undefined ? { rotation: video.rotation } : {}),
		});
	}

	let audioSource: AudioSampleSource | null = null;
	if (spec.audio) {
		audioSource = new AudioSampleSource({ codec: spec.audio.codec, quality: new Quality('high') });
		output.addAudioTrack(audioSource);
	}

	await output.start();

	if (spec.video && videoSource && canvas) {
		const video = spec.video;
		const frameRate = video.frameRate ?? 25;
		const context = canvas.getContext('2d')!;
		for (let n = 0; n < (video.frameCount ?? 2 * frameRate); n++) {
			const gray = levelGray(frameLevel(n));
			context.clearRect(0, 0, canvas.width, canvas.height);
			context.fillStyle = video.alpha
				? `rgba(${gray}, ${gray}, ${gray}, ${frameAlpha(n) / 255})`
				: `rgb(${gray}, ${gray}, ${gray})`;
			context.fillRect(0, 0, canvas.width, canvas.height);
			await videoSource.add((video.start ?? 0) + n / frameRate, 1 / frameRate);
		}
		videoSource.close();
	}

	if (spec.audio && audioSource) {
		const sampleRate = spec.audio.sampleRate ?? 48000;
		const numberOfChannels = spec.audio.numberOfChannels ?? 2;
		const { data, numberOfFrames } = makeBeepData(sampleRate, numberOfChannels, spec.audio.duration ?? 2);
		const sample = new AudioSample({
			data,
			format: 'f32-planar',
			sampleRate,
			numberOfChannels,
			numberOfFrames,
			timestamp: spec.audio.start ?? 0,
		});
		await audioSource.add(sample);
		sample.close();
		audioSource.close();
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

/** The corpus every run covers. Codecs are ones Chrome on Linux encodes (plus the MP3 and FLAC extensions). */
export const SYNTHETIC_INPUTS: SyntheticInput[] = [
	{
		id: 'mp4-avc-opus',
		format: () => new Mp4OutputFormat(),
		video: { codec: 'avc' },
		audio: { codec: 'opus' },
	},
	{
		id: 'webm-vp9-opus-mono',
		format: () => new WebMOutputFormat(),
		video: { codec: 'vp9' },
		audio: { codec: 'opus', numberOfChannels: 1 },
	},
	{
		id: 'mkv-vp8-alpha-flac',
		format: () => new MkvOutputFormat(),
		video: { codec: 'vp8', alpha: true },
		audio: { codec: 'flac', sampleRate: 44100 },
	},
	{
		id: 'mov-avc30-pcm',
		format: () => new MovOutputFormat(),
		video: { codec: 'avc', frameRate: 30, keyFrameInterval: 0.5 },
		audio: { codec: 'pcm-s16', sampleRate: 44100 },
	},
	{
		id: 'ts-avc-mp3',
		format: () => new MpegTsOutputFormat(),
		video: { codec: 'avc' },
		audio: { codec: 'mp3', sampleRate: 44100 },
	},
	{
		id: 'mp4-av1-rotated-late',
		format: () => new Mp4OutputFormat(),
		video: { codec: 'av1', rotation: 90, start: 1 },
		audio: { codec: 'opus', start: 1 },
	},
	{
		id: 'mkv-avc-opus-late-audio',
		format: () => new MkvOutputFormat(),
		video: { codec: 'avc' },
		audio: { codec: 'opus', start: 1, duration: 1 },
	},
	{
		id: 'wav-22k-mono',
		format: () => new WavOutputFormat(),
		audio: { codec: 'pcm-s16', sampleRate: 22050, numberOfChannels: 1 },
	},
	{
		id: 'flac-51',
		format: () => new FlacOutputFormat(),
		audio: { codec: 'flac', numberOfChannels: 6 },
	},
	{
		id: 'ogg-opus',
		format: () => new OggOutputFormat(),
		audio: { codec: 'opus' },
	},
	{
		id: 'mp3-44k',
		format: () => new Mp3OutputFormat(),
		audio: { codec: 'mp3', sampleRate: 44100 },
	},
];
