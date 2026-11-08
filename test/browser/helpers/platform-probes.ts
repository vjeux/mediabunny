// Native capability probes for the browser tests. Each decides with WebCodecs alone, never with Mediabunny, whether
// the platform can do what a test needs, so that a Mediabunny bug on a capable platform still fails the test.
// WebKitGTK and WPE, whose media backend is GStreamer, lack several of these things. Where a probe can't run at all
// (the platform has no such codec), it finds no evidence of the defect, and the test runs as it always has.

const fromBase64 = (base64: string) => Uint8Array.from(atob(base64), x => x.charCodeAt(0));

const withTimeLimit = <T>(promise: Promise<T>, milliseconds: number) => Promise.race([
	promise,
	new Promise<null>(resolve => setTimeout(() => resolve(null), milliseconds)),
]);

/** Asks the platform's own isConfigSupported(), which a stalled codec never answers. */
const supports = async (isConfigSupported: () => Promise<{ supported?: boolean }>) => {
	const support = await withTimeLimit(isConfigSupported().catch(() => null), 2000);
	return !!support?.supported;
};

const once = <T>(probe: () => Promise<T>) => {
	let result: Promise<T> | null = null;
	return () => result ??= probe();
};

type AudioProbe = { codec: string; sampleRate: number; description?: string; chunks: string[] };

// The first packets of 0.1 s of mono silence, read with ffprobe -show_streams -show_packets -show_data
// FFmpeg: -c:a flac (16 kHz; "fLaC" + the STREAMINFO block)
const FLAC_PROBE: AudioProbe = {
	codec: 'flac',
	sampleRate: 16000,
	description: 'ZkxhQ4AAACIEgASAAAALAAANA+gA8AAABkCfCt/b50DLnNgYijV2HiR2',
	chunks: ['//g1CAADAAAAakQ=', '//h1CAEBv70AAAAGlg=='],
};

// FFmpeg: -c:a libvorbis -q:a -1 (16 kHz; the Xiph-laced headers)
const VORBIS_PROBE: AudioProbe = {
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
};

/** Decodes a tiny stream with the platform's own decoder, which must neither fail nor hang. */
const decodesAudio = async (probe: AudioProbe) => {
	const config: AudioDecoderConfig = {
		codec: probe.codec,
		sampleRate: probe.sampleRate,
		numberOfChannels: 1,
		description: probe.description !== undefined ? fromBase64(probe.description) : undefined,
	};
	if (typeof AudioDecoder === 'undefined' || !await supports(() => AudioDecoder.isConfigSupported(config))) {
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
		const flushed = await withTimeLimit(decoder.flush().then(() => true, () => false), 2000);
		failed ||= !flushed;
	} catch {
		failed = true;
	}
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return !failed && outputs > 0;
};

/**
 * Whether the platform really decodes FLAC. WebKitGTK says it can, but its decoder then fails, and can leave the
 * page's other audio decoders stalled.
 */
export const decodesFlac = once(() => decodesAudio(FLAC_PROBE));

/** Whether the platform decodes Vorbis at all, and really: WebKitGTK says it can, but its decoder then hangs. */
export const decodesVorbis = once(() => decodesAudio(VORBIS_PROBE));

/** Whether the platform has an encoder for a video config, according to its own isConfigSupported(). */
export const encodesVideo = async (config: VideoEncoderConfig) => {
	return typeof VideoEncoder !== 'undefined' && await supports(() => VideoEncoder.isConfigSupported(config));
};

/**
 * Whether the platform's audio decoders keep the timestamps that follow a negative one. WebKitGTK's flip the
 * playback direction of their GStreamer segment instead, which scrambles files that start before zero (AAC priming,
 * Opus pre-skip).
 */
export const decodesPastNegativeTimestamps = once(async () => {
	const config: AudioDecoderConfig = { codec: 'pcm-s16', sampleRate: 48000, numberOfChannels: 1 };
	if (typeof AudioDecoder === 'undefined' || !await supports(() => AudioDecoder.isConfigSupported(config))) {
		return true;
	}

	const timestamps: number[] = [];
	const decoder = new AudioDecoder({
		output: (data) => {
			timestamps.push(data.timestamp);
			data.close();
		},
		error: () => {},
	});
	decoder.configure(config);
	for (const timestamp of [-20_000, 0, 20_000]) {
		decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: new Uint8Array(1920) }));
	}
	await withTimeLimit(decoder.flush().catch(() => {}), 2000);
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return timestamps.join() === '-20000,0,20000';
});

/**
 * Whether the platform's Opus encoder times its packets by the audio they carry, and encodes all of it. WebKitGTK's
 * stamps every packet with the timestamp of the input it came from, and drops the end.
 */
export const opusEncoderTimesItsPackets = once(async () => {
	const config: AudioEncoderConfig = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 64000 };
	if (typeof AudioEncoder === 'undefined' || !await supports(() => AudioEncoder.isConfigSupported(config))) {
		return true;
	}

	const packets: { timestamp: number; duration: number }[] = [];
	const encoder = new AudioEncoder({
		output: chunk => packets.push({ timestamp: chunk.timestamp, duration: chunk.duration ?? 0 }),
		error: () => {},
	});
	encoder.configure(config);
	const data = new AudioData({
		format: 'f32-planar',
		sampleRate: 48000,
		numberOfChannels: 1,
		numberOfFrames: 48000,
		timestamp: 0,
		data: new Float32Array(48000),
	});
	encoder.encode(data);
	data.close();
	await withTimeLimit(encoder.flush().catch(() => {}), 2000);
	if (encoder.state !== 'closed') {
		encoder.close();
	}

	const last = packets.at(-1);
	return !!last
		&& packets.every((packet, i) => i === 0 || packet.timestamp > packets[i - 1]!.timestamp)
		&& last.timestamp + last.duration >= 1_000_000;
});

/**
 * Whether the platform's video decoder keeps the coded size of frames with non-square pixels. WebKitGTK's scale them
 * to square pixels instead. Checked on a 64x64 H.264 frame with 2:1 pixels (FFmpeg: -vf setsar=2/1 -c:v libx264,
 * read with ffprobe -show_data, the IDR without its SEI).
 */
export const decoderKeepsFrameSizeOfNonSquarePixels = once(async () => {
	const config: VideoDecoderConfig = {
		codec: 'avc1.64000a',
		codedWidth: 64,
		codedHeight: 64,
		description: fromBase64('AWQACv/hABhnZAAKrLIITYgIAAADAAgAAAMAoHiRMkABAAZo68PLIsD9+PgA'),
	};
	if (typeof VideoDecoder === 'undefined' || !await supports(() => VideoDecoder.isConfigSupported(config))) {
		return true;
	}

	const sizes: string[] = [];
	const decoder = new VideoDecoder({
		output: (frame) => {
			sizes.push(`${frame.visibleRect!.width}x${frame.visibleRect!.height}`);
			frame.close();
		},
		error: () => {},
	});
	decoder.configure(config);
	decoder.decode(new EncodedVideoChunk({
		type: 'key',
		timestamp: 0,
		data: fromBase64('AAAAH2WIhA7//vdOvwKbVMIqA5JXCuqDugrYp08qbQaN+7k='),
	}));
	await withTimeLimit(decoder.flush().catch(() => {}), 2000);
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return sizes.length > 0 && sizes.every(size => size === '64x64');
});

/** Whether VideoFrame.copyTo() converts YUV frames to RGBA. WebKitGTK's copies the YUV planes instead. */
export const copyToConvertsYuvToRgba = once(async () => {
	const frame = new VideoFrame(new Uint8Array([235, 235, 235, 235, 128, 128]), {
		format: 'I420',
		codedWidth: 2,
		codedHeight: 2,
		timestamp: 0,
	});
	try {
		const rgba = new Uint8Array(16);
		const layout = await frame.copyTo(rgba, { format: 'RGBA' });
		return layout.length === 1 && rgba[3] === 255;
	} catch {
		return false;
	} finally {
		frame.close();
	}
});

/**
 * Whether the platform's VP9 encoder keeps a red square on a 1280x720 frame within two levels at the rate control
 * Quality('high') gets. Where the encoder has quantizer-based rate control, there's no evidence against it. Elsewhere
 * that's 1.7 Mbps, at which WebKitGTK's encoder (which has none) comes back five levels off.
 */
export const vp9EncoderKeepsRed = once(async () => {
	const base = { codec: 'vp09.00.31.08', width: 1280, height: 720 };
	const config: VideoEncoderConfig = { ...base, bitrate: 1_697_000 };
	if (
		typeof VideoEncoder === 'undefined'
		|| typeof VideoDecoder === 'undefined'
		|| await supports(() => VideoEncoder.isConfigSupported({ ...base, bitrateMode: 'quantizer' }))
		|| !await supports(() => VideoEncoder.isConfigSupported(config))
	) {
		return true;
	}

	const canvas = new OffscreenCanvas(1280, 720);
	const context = canvas.getContext('2d')!;
	context.fillStyle = '#ff0000';
	context.fillRect(200, 200, 200, 200);

	const chunks: EncodedVideoChunk[] = [];
	let decoderConfig: VideoDecoderConfig | undefined;
	const encoder = new VideoEncoder({
		output: (chunk, meta) => {
			chunks.push(chunk);
			decoderConfig ??= meta?.decoderConfig;
		},
		error: () => {},
	});
	encoder.configure(config);
	const frame = new VideoFrame(canvas, { timestamp: 0, alpha: 'discard' });
	encoder.encode(frame, { keyFrame: true });
	frame.close();
	await withTimeLimit(encoder.flush().catch(() => {}), 5000);
	if (encoder.state !== 'closed') {
		encoder.close();
	}
	if (!decoderConfig) {
		return false;
	}

	let pixel: number[] = [];
	const decoder = new VideoDecoder({
		output: (decoded) => {
			const drawn = new OffscreenCanvas(1280, 720).getContext('2d')!;
			drawn.drawImage(decoded, 0, 0);
			pixel = [...drawn.getImageData(300, 300, 1, 1).data];
			decoded.close();
		},
		error: () => {},
	});
	decoder.configure(decoderConfig);
	chunks.forEach(chunk => decoder.decode(chunk));
	await withTimeLimit(decoder.flush().catch(() => {}), 5000);
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	const [red, green, blue] = pixel;
	return red !== undefined && red >= 253 && green! <= 3 && blue! <= 3;
});
