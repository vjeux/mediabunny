// What the platform's WebCodecs can do, decided with WebCodecs alone on tiny known-good inputs: never with Mediabunny,
// so that a Mediabunny failure on a capable platform fails instead of skipping. isConfigSupported() isn't enough:
// WebKitGTK says it handles all of these, but:
// - its GStreamer decoders fail on FLAC and hang on Vorbis, and after either, every later audio decode on the page
//   stalls (isConfigSupported() included);
// - its AudioEncoder stamps every chunk with the timestamp of the input it came from;
// - its decoders scramble the timestamps that follow a negative one (as encoder priming and copies trimmed into a
//   GOP make them);
// - its AV1 decoder fails, and its AVC encoder drops frames at low bitrates.
// The FLAC and Vorbis streams are 0.1 s of silence made by FFmpeg, read with ffprobe -show_streams -show_packets
// -show_data:
//   flac    -c:a flac (16 kHz mono; "fLaC" + the STREAMINFO block)
//   vorbis  -c:a libvorbis -q:a -1 (16 kHz mono; the Xiph-laced headers)
// and the video ones are the first frame of 0.4 s of black 64x64 video:
//   avc     -c:v libx264 -x264-params keyint=30:bframes=0 (.mp4; avcC, the IDR without its SEI)
//   vp8     -c:v libvpx -b:v 50k (.webm)
//   vp9     -c:v libvpx-vp9 -b:v 50k (.webm)
//   av1     -c:v libaom-av1 -cpu-used 8 -crf 50 (-f obu, with its sequence header)

type NativeProbe = { codec: string; sampleRate: number; description: string; chunks: string[] };

export const NATIVE_PROBES = {
	flac: {
		codec: 'flac',
		sampleRate: 16000,
		description:
			'ZkxhQ4AAACIEgASAAAALAAANA+gA8AAABkCfCt/b50DLnNgYijV2HiR2',
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
} satisfies Record<string, NativeProbe>;

const fromBase64 = (base64: string) => Uint8Array.from(atob(base64), x => x.charCodeAt(0));

const withTimeout = <T>(promise: Promise<T>, ms: number) => Promise.race([
	promise.then(value => ({ value })),
	new Promise<null>(resolve => setTimeout(() => resolve(null), ms)),
]);

/** Whether WebCodecs decodes the probe stream, within a few seconds. */
export const decodesNatively = async (probe: NativeProbe) => {
	if (typeof AudioDecoder === 'undefined') {
		return false;
	}

	const config: AudioDecoderConfig = {
		codec: probe.codec,
		sampleRate: probe.sampleRate,
		numberOfChannels: 1,
		description: fromBase64(probe.description),
	};
	const support = await withTimeout(
		AudioDecoder.isConfigSupported(config).then(x => !!x.supported, () => false),
		1000,
	);
	if (!support?.value) {
		return false;
	}

	let outputs = 0;
	let failed = false;
	const decoder = new AudioDecoder({
		output: (data) => {
			outputs++;
			data.close();
		},
		error: () => {
			failed = true;
		},
	});
	try {
		decoder.configure(config);
		probe.chunks.forEach((chunk, i) => decoder.decode(new EncodedAudioChunk({
			type: 'key',
			timestamp: i * 20_000,
			data: fromBase64(chunk),
		})));
		const flushed = await withTimeout(decoder.flush(), 3000);
		if (flushed === null) {
			failed = true;
		}
	} catch {
		failed = true;
	}
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return !failed && outputs > 0;
};

/** Whether the page's audio decoding still responds: isConfigSupported() settles within a second. */
export const audioDecodingResponds = async () => {
	if (typeof AudioDecoder === 'undefined') {
		return false;
	}

	const settled = await withTimeout(
		AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }).catch(() => null),
		1000,
	);
	return settled !== null;
};

type ProbedVideoCodec = 'avc' | 'vp8' | 'vp9' | 'av1';

const VIDEO_KEYFRAMES: Record<ProbedVideoCodec, { codec: string; description?: string; chunk: string }> = {
	avc: {
		codec: 'avc1.64000a',
		description: 'AWQACv/hABZnZAAKrLQhNgIgAAADACAAAAeB4kTUAQAEaO8Py/34+AA=',
		chunk: 'AAAAImWIhAv/zfge5+dNGJXY/99lBqplGekvDAt4kBWRdmF/jqw=',
	},
	vp8: { codec: 'vp8', chunk: '8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v+rUIA=' },
	vp9: { codec: 'vp09.00.10.08', chunk: 'gkmDQgAD8AP2ADgkHBhCAAAwYAAAZz///1mvETuzAA==' },
	av1: { codec: 'av01.0.00M.08', chunk: 'EgAKCgAAAAKv/5tfIAgyDRAAuoAAAkAAAAPOF7o=' },
};

/** Decodes the codec's keyframe once per timestamp; gives the output timestamps, or null if decoding failed. */
const decodeKeyframes = async (codec: ProbedVideoCodec, timestamps: number[]) => {
	if (typeof VideoDecoder === 'undefined') {
		return null;
	}

	const keyframe = VIDEO_KEYFRAMES[codec];
	const config: VideoDecoderConfig = {
		codec: keyframe.codec,
		codedWidth: 64,
		codedHeight: 64,
		description: keyframe.description !== undefined ? fromBase64(keyframe.description) : undefined,
	};
	const support = await withTimeout(
		VideoDecoder.isConfigSupported(config).then(x => !!x.supported, () => false),
		1000,
	);
	if (!support?.value) {
		return null;
	}

	const outputs: number[] = [];
	let failed = false;
	const decoder = new VideoDecoder({
		output: (frame) => {
			outputs.push(frame.timestamp);
			frame.close();
		},
		error: () => {
			failed = true;
		},
	});
	try {
		decoder.configure(config);
		for (const timestamp of timestamps) {
			decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp, data: fromBase64(keyframe.chunk) }));
		}
		if (await withTimeout(decoder.flush(), 3000) === null) {
			failed = true;
		}
	} catch {
		failed = true;
	}
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return failed ? null : outputs;
};

/** Whether WebCodecs decodes the codec's keyframe. */
export const videoDecodes = async (codec: ProbedVideoCodec) => (await decodeKeyframes(codec, [0]))?.length === 1;

/** Whether decoded video keeps the timestamps that follow a negative one (the keyframe at -40, 0 and 40 ms). */
export const negativeVideoTimestampsDecode = async (codec: ProbedVideoCodec) => {
	const timestamps = await decodeKeyframes(codec, [-40_000, 0, 40_000]);
	return timestamps?.join() === '-40000,0,40000';
};

/** Whether WebCodecs encodes a multi-frame input with timestamps that advance from chunk to chunk. */
export const audioEncodingWorks = async (codec: 'opus' | 'mp4a.40.2') => {
	if (typeof AudioEncoder === 'undefined') {
		return false;
	}

	const config: AudioEncoderConfig = { codec, sampleRate: 48000, numberOfChannels: 1, bitrate: 64000 };
	const support = await withTimeout(
		AudioEncoder.isConfigSupported(config).then(x => !!x.supported, () => false),
		1000,
	);
	if (!support?.value) {
		return false;
	}

	const timestamps: number[] = [];
	let failed = false;
	const encoder = new AudioEncoder({
		output: chunk => timestamps.push(chunk.timestamp),
		error: () => {
			failed = true;
		},
	});
	try {
		encoder.configure(config);
		// 100 ms of silence in one piece
		const data = new AudioData({
			format: 'f32-planar',
			sampleRate: 48000,
			numberOfChannels: 1,
			numberOfFrames: 4800,
			timestamp: 0,
			data: new Float32Array(4800),
		});
		encoder.encode(data);
		data.close();
		if (await withTimeout(encoder.flush(), 3000) === null) {
			failed = true;
		}
	} catch {
		failed = true;
	}
	if (encoder.state !== 'closed') {
		encoder.close();
	}

	return !failed && timestamps.length > 1 && timestamps.every((t, i) => i === 0 || t > timestamps[i - 1]!);
};

/** Whether decoded audio keeps the timestamps that follow a negative one (16-bit PCM at -20, 0 and 20 ms). */
export const negativeTimestampsDecode = async () => {
	if (typeof AudioDecoder === 'undefined') {
		return false;
	}

	const timestamps: number[] = [];
	let failed = false;
	const decoder = new AudioDecoder({
		output: (data) => {
			timestamps.push(data.timestamp);
			data.close();
		},
		error: () => {
			failed = true;
		},
	});
	try {
		decoder.configure({ codec: 'pcm-s16', sampleRate: 48000, numberOfChannels: 1 });
		for (const timestamp of [-20_000, 0, 20_000]) {
			decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: new Uint8Array(1920) }));
		}
		if (await withTimeout(decoder.flush(), 3000) === null) {
			failed = true;
		}
	} catch {
		failed = true;
	}
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return !failed && timestamps.join() === '-20000,0,20000';
};

/** Whether 8 flat gray 64x64 frames through a literal 32 kbps AVC config all come back, in order. */
export const avcKeepsEveryFrame = async () => {
	if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
		return false;
	}

	const config: VideoEncoderConfig = { codec: 'avc1.42001f', width: 64, height: 64, bitrate: 32_000, framerate: 30 };
	const support = await withTimeout(
		VideoEncoder.isConfigSupported(config).then(x => !!x.supported, () => false),
		1000,
	);
	if (!support?.value) {
		return false;
	}

	const canvas = new OffscreenCanvas(64, 64);
	const context = canvas.getContext('2d')!;
	const levels = Array.from({ length: 8 }, (_, i) => i * 32 + 16);
	const chunks: EncodedVideoChunk[] = [];
	let decoderConfig: VideoDecoderConfig | undefined;
	let failed = false;
	const encoder = new VideoEncoder({
		output: (chunk, meta) => {
			chunks.push(chunk);
			decoderConfig ??= meta?.decoderConfig;
		},
		error: () => {
			failed = true;
		},
	});
	const decoded: number[] = [];
	const decoder = new VideoDecoder({
		output: (frame) => {
			const pixel = new OffscreenCanvas(8, 8).getContext('2d')!;
			pixel.drawImage(frame, 0, 0, 8, 8);
			decoded.push(pixel.getImageData(4, 4, 1, 1).data[0]!);
			frame.close();
		},
		error: () => {
			failed = true;
		},
	});
	try {
		encoder.configure(config);
		levels.forEach((level, i) => {
			context.fillStyle = `rgb(${level}, ${level}, ${level})`;
			context.fillRect(0, 0, 64, 64);
			const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / 30), duration: 33_333 });
			encoder.encode(frame, { keyFrame: i === 0 });
			frame.close();
		});
		if (await withTimeout(encoder.flush(), 3000) === null || !decoderConfig) {
			failed = true;
		} else {
			decoder.configure(decoderConfig);
			chunks.forEach(chunk => decoder.decode(chunk));
			if (await withTimeout(decoder.flush(), 3000) === null) {
				failed = true;
			}
		}
	} catch {
		failed = true;
	}
	for (const codec of [encoder, decoder]) {
		if (codec.state !== 'closed') {
			codec.close();
		}
	}

	return !failed
		&& decoded.length === levels.length
		&& decoded.every((level, i) => Math.abs(level - levels[i]!) <= 8);
};

export type PlatformSupport = {
	opusEncoding: boolean;
	aacEncoding: boolean;
	negativeTimestamps: boolean;
	negativeVideoTimestamps: Record<string, boolean>;
	av1Decoding: boolean;
	avcEncoding: boolean;
};

let platformSupport: Promise<PlatformSupport> | null = null;

/** The probes that can't stall the page (all but FLAC and Vorbis), run once. */
export const getPlatformSupport = () => platformSupport ??= (async () => {
	const negativeVideoTimestamps: Record<string, boolean> = {};
	for (const codec of Object.keys(VIDEO_KEYFRAMES) as ProbedVideoCodec[]) {
		negativeVideoTimestamps[codec] = await negativeVideoTimestampsDecode(codec);
	}

	return {
		opusEncoding: await audioEncodingWorks('opus'),
		aacEncoding: await audioEncodingWorks('mp4a.40.2'),
		negativeTimestamps: await negativeTimestampsDecode(),
		negativeVideoTimestamps,
		av1Decoding: await videoDecodes('av1'),
		avcEncoding: await avcKeepsEveryFrame(),
	};
})();
