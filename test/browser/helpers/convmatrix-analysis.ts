// Decodes a file into what the conversion matrix compares: per track the packet structure (timestamps, key packets),
// every video frame's timestamp, gray level and alpha, and the audio's beeps, gaps and extent.
import { Input } from '../../../src/input.js';
import { InputAudioTrack, InputVideoTrack } from '../../../src/input-track.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../../src/media-sink.js';
import { classifyFullRangeGray, detectBeeps, type Beep } from './convmatrix-signal.js';

export type FrameInfo = {
	timestamp: number;
	duration: number;
	/** Generator gray level index (0-3), -1 when unclassifiable. */
	level: number;
	gray: number;
	alpha: number;
};

export type VideoView = {
	codec: string | null;
	codedWidth: number;
	codedHeight: number;
	displayWidth: number;
	displayHeight: number;
	rotation: number;
	frames: FrameInfo[];
	packetCount: number;
	firstPacketIsKey: boolean | null;
	keyPacketTimestamps: number[];
	/** Key packets that pass `verifyKeyPackets` (open-GOP I-frames don't), as Conversion's copy path uses */
	verifiedKeyPacketTimestamps: number[];
	/** Packet timestamps in decode order. */
	packetTimestamps: number[];
	decodeError: string | null;
};

export type AudioView = {
	codec: string | null;
	sampleRate: number;
	numberOfChannels: number;
	decodedSampleRate: number | null;
	decodedNumberOfChannels: number | null;
	firstTimestamp: number | null;
	endTimestamp: number | null;
	totalFrames: number;
	/** Jumps between consecutive decoded samples, in seconds (positive: gap, negative: overlap). */
	discontinuities: { at: number; delta: number }[];
	beeps: Beep[];
	packetCount: number;
	firstPacketTimestamp: number | null;
	/** [timestamp, duration] of every packet, in decode order. */
	packets: [number, number][];
	decodeError: string | null;
};

export type MediaView = {
	formatName: string;
	duration: number;
	videoTrackCount: number;
	audioTrackCount: number;
	video: VideoView | null;
	audio: AudioView | null;
};

let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;

type Drawable = {
	draw: (context: OffscreenCanvasRenderingContext2D, x: number, y: number, width: number, height: number) => void;
};

const measureFrame = (sample: Drawable) => {
	if (!canvas) {
		canvas = new OffscreenCanvas(16, 16);
		context = canvas.getContext('2d', { willReadFrequently: true })!;
	}
	context!.clearRect(0, 0, 16, 16);
	sample.draw(context!, 0, 0, 16, 16);
	// The center only, so letterboxing ('contain') stays out of the measurement
	const data = context!.getImageData(7, 7, 2, 2).data;
	let gray = 0;
	let alpha = 0;
	for (let i = 0; i < data.length; i += 4) {
		gray += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
		alpha += data[i + 3]!;
	}
	gray /= data.length / 4;
	alpha /= data.length / 4;
	return { gray, alpha };
};

export const analyzeVideoTrack = async (
	track: InputVideoTrack,
	options: { decode?: boolean } = {},
): Promise<VideoView> => {
	const view: VideoView = {
		codec: await track.getCodec(),
		codedWidth: await track.getCodedWidth(),
		codedHeight: await track.getCodedHeight(),
		displayWidth: await track.getDisplayWidth(),
		displayHeight: await track.getDisplayHeight(),
		rotation: await track.getRotation(),
		frames: [],
		packetCount: 0,
		firstPacketIsKey: null,
		keyPacketTimestamps: [],
		verifiedKeyPacketTimestamps: [],
		packetTimestamps: [],
		decodeError: null,
	};

	const packetSink = new EncodedPacketSink(track);
	for await (const packet of packetSink.packets(undefined, undefined, { metadataOnly: true })) {
		if (view.packetCount === 0) {
			view.firstPacketIsKey = packet.type === 'key';
		}
		if (packet.type === 'key') {
			view.keyPacketTimestamps.push(packet.timestamp);
		}
		view.packetTimestamps.push(packet.timestamp);
		view.packetCount++;
	}
	try {
		for await (const packet of packetSink.packets(undefined, undefined, { verifyKeyPackets: true })) {
			if (packet.type === 'key') {
				view.verifiedKeyPacketTimestamps.push(packet.timestamp);
			}
		}
	} catch {
		view.verifiedKeyPacketTimestamps = [...view.keyPacketTimestamps];
	}

	if (options.decode !== false && await track.canDecode()) {
		try {
			const sink = new VideoSampleSink(track);
			for await (const sample of sink.samples()) {
				const { gray, alpha } = measureFrame(sample);
				view.frames.push({
					timestamp: sample.timestamp,
					duration: sample.duration,
					gray,
					alpha,
					level: classifyFullRangeGray(gray),
				});
				sample.close();
			}
		} catch (error) {
			view.decodeError = String(error);
		}
	} else if (options.decode !== false) {
		view.decodeError = 'cannot decode';
	}

	return view;
};

export const analyzeAudioTrack = async (
	track: InputAudioTrack,
	options: { decode?: boolean } = {},
): Promise<AudioView> => {
	const view: AudioView = {
		codec: await track.getCodec(),
		sampleRate: await track.getSampleRate(),
		numberOfChannels: await track.getNumberOfChannels(),
		decodedSampleRate: null,
		decodedNumberOfChannels: null,
		firstTimestamp: null,
		endTimestamp: null,
		totalFrames: 0,
		discontinuities: [],
		beeps: [],
		packetCount: 0,
		firstPacketTimestamp: null,
		packets: [],
		decodeError: null,
	};

	const packetSink = new EncodedPacketSink(track);
	for await (const packet of packetSink.packets(undefined, undefined, { metadataOnly: true })) {
		if (view.packetCount === 0) {
			view.firstPacketTimestamp = packet.timestamp;
		}
		view.packets.push([packet.timestamp, packet.duration]);
		view.packetCount++;
	}

	if (options.decode === false) {
		return view;
	}
	if (!await track.canDecode()) {
		view.decodeError = 'cannot decode';
		return view;
	}

	try {
		const sink = new AudioSampleSink(track);
		let planes: Float32Array[] = [];
		let capacity = 0;
		let sampleRate = 0;
		let channels = 0;
		let expectedNext: number | null = null;
		let maxEndFrame = 0;

		for await (const sample of sink.samples()) {
			if (view.firstTimestamp === null) {
				view.firstTimestamp = sample.timestamp;
				sampleRate = sample.sampleRate;
				channels = sample.numberOfChannels;
				view.decodedSampleRate = sampleRate;
				view.decodedNumberOfChannels = channels;
				capacity = Math.ceil(sampleRate * 4);
				planes = Array.from({ length: channels }, () => new Float32Array(capacity));
			}

			if (expectedNext !== null && Math.abs(sample.timestamp - expectedNext) > 0.5 / sampleRate) {
				view.discontinuities.push({ at: sample.timestamp, delta: sample.timestamp - expectedNext });
			}
			expectedNext = sample.timestamp + sample.numberOfFrames / sample.sampleRate;
			view.totalFrames += sample.numberOfFrames;
			view.endTimestamp = Math.max(view.endTimestamp ?? -Infinity, expectedNext);

			const offset = Math.round((sample.timestamp - view.firstTimestamp) * sampleRate);
			const end = offset + sample.numberOfFrames;
			if (end > capacity) {
				const newCapacity = Math.max(end, capacity * 2);
				planes = planes.map((plane) => {
					const grown = new Float32Array(newCapacity);
					grown.set(plane);
					return grown;
				});
				capacity = newCapacity;
			}
			const scratch = new Float32Array(sample.numberOfFrames);
			for (let c = 0; c < Math.min(channels, sample.numberOfChannels); c++) {
				sample.copyTo(scratch, { planeIndex: c, format: 'f32-planar' });
				if (offset >= 0) {
					planes[c]!.set(scratch, offset);
				}
			}
			maxEndFrame = Math.max(maxEndFrame, end);
			sample.close();
		}

		if (view.firstTimestamp !== null) {
			const used = planes.map(plane => plane.subarray(0, maxEndFrame));
			view.beeps = detectBeeps(used, sampleRate, view.firstTimestamp);
		}
	} catch (error) {
		view.decodeError = String(error);
	}

	return view;
};

export const analyzeInput = async (input: Input, options: { decode?: boolean } = {}): Promise<MediaView> => {
	const videoTracks = await input.getVideoTracks();
	const audioTracks = await input.getAudioTracks();
	const primaryVideo = await input.getPrimaryVideoTrack();
	const primaryAudio = await input.getPrimaryAudioTrack();

	return {
		formatName: (await input.getFormat()).name,
		duration: await input.computeDuration(),
		videoTrackCount: videoTracks.length,
		audioTrackCount: audioTracks.length,
		video: primaryVideo ? await analyzeVideoTrack(primaryVideo, options) : null,
		audio: primaryAudio ? await analyzeAudioTrack(primaryAudio, options) : null,
	};
};
