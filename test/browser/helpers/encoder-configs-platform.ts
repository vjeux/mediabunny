/*!
 * Native platform probes for the encoder configuration suite. Whether the platform's encoders and decoders can do
 * something is decided with WebCodecs alone, on literal configs and synthetic frames or a tiny known-good stream,
 * never with Mediabunny, so that a Mediabunny failure on a capable platform fails instead of skipping. The configs
 * have the shape of what the tests' encodes use (quantizer-based rate control where the platform accepts it, like
 * Mediabunny's quality levels). Probes run lazily (only when a test needs them) and every native call has a timeout,
 * since some coders hang instead of failing; a hung coder of a kind stalls every later call of that kind on the page,
 * so after one, the probes and tests of that kind report it instead of running.
 */

const NATIVE_TIMEOUT = 5000;

export const hungCoderKinds = new Set<'video' | 'audio'>();

export const withTimeout = <T>(promise: Promise<T>, timeout = NATIVE_TIMEOUT) => Promise.race([
	promise.then(value => ({ value })),
	new Promise<null>(resolve => setTimeout(() => resolve(null), timeout)),
]);

const memoize = <T>(fn: () => Promise<T>) => {
	let result: Promise<T> | null = null;
	return () => result ??= fn();
};

const memoizeByKey = <K, T>(fn: (key: K) => Promise<T>) => {
	const results = new Map<K, Promise<T>>();
	return (key: K) => {
		let result = results.get(key);
		if (!result) {
			result = fn(key);
			results.set(key, result);
		}
		return result;
	};
};

const fromBase64 = (base64: string) => Uint8Array.from(atob(base64), x => x.charCodeAt(0));

export type ProbedVideoCodec = 'avc' | 'hevc' | 'vp8' | 'vp9' | 'av1';

/** A literal codec string per codec, with a level that fits the frame size. */
export const literalCodecString = (codec: ProbedVideoCodec, width: number, height: number) => {
	const pixels = width * height;
	if (codec === 'avc') {
		return 'avc1.42001f';
	} else if (codec === 'hevc') {
		return `hev1.1.6.L${pixels <= 36_864 ? 30 : pixels <= 122_880 ? 60 : 93}.B0`;
	} else if (codec === 'vp8') {
		return 'vp8';
	} else if (codec === 'vp9') {
		return `vp09.00.${pixels <= 36_864 ? 10 : pixels <= 245_760 ? 21 : 31}.08`;
	} else {
		return pixels <= 147_456 ? 'av01.0.00M.08' : 'av01.0.05M.08';
	}
};

/** Per-frame quantizers on each codec's WebCodecs scale (0-51 for AVC and HEVC, quantizer index 0-255 otherwise). */
const LITERAL_QUANTIZERS: Partial<Record<ProbedVideoCodec, { worst: number; middle: number; best: number }>> = {
	avc: { worst: 41, middle: 30, best: 16 },
	hevc: { worst: 41, middle: 30, best: 16 },
	vp9: { worst: 208, middle: 144, best: 80 },
	av1: { worst: 208, middle: 144, best: 80 },
};

const quantizerOptions = (codec: ProbedVideoCodec, quantizer: number): VideoEncoderEncodeOptions => {
	return { [codec]: { quantizer } } as VideoEncoderEncodeOptions;
};

const nativeSupports = async (config: VideoEncoderConfig) => {
	if (typeof VideoEncoder === 'undefined' || hungCoderKinds.has('video')) {
		return false;
	}

	const support = await withTimeout(VideoEncoder.isConfigSupported(config).then(x => !!x.supported, () => false));
	if (support === null) {
		hungCoderKinds.add('video');
		return false;
	}

	return support.value;
};

/** Whether the platform accepts quantizer-based rate control for a codec, as Mediabunny's quality levels use. */
const nativeQuantizerMode = memoizeByKey(async (codec: ProbedVideoCodec) => {
	if (!LITERAL_QUANTIZERS[codec]) {
		return false;
	}

	return nativeSupports({
		codec: literalCodecString(codec, 160, 120),
		width: 160,
		height: 120,
		bitrateMode: 'quantizer',
		framerate: 30,
	});
});

/** The config shape a test's encode at quality level 'middle' would use: quantizer mode where possible. */
const nativeVideoConfig = async (codec: ProbedVideoCodec, width: number, height: number, bitrate: number) => {
	const codecString = literalCodecString(codec, width, height);
	if (await nativeQuantizerMode(codec)) {
		return {
			config: { codec: codecString, width, height, bitrateMode: 'quantizer', framerate: 30 },
			encodeOptions: quantizerOptions(codec, LITERAL_QUANTIZERS[codec]!.middle),
		} as const;
	}

	return {
		config: { codec: codecString, width, height, bitrate, framerate: 30 },
		encodeOptions: {},
	} as const;
};

const readCenterLuma = async (frame: VideoFrame) => {
	const buffer = new Uint8Array(frame.allocationSize());
	const layout = await frame.copyTo(buffer);
	const tight = layout[0]!.offset === 0 && layout[0]!.stride === frame.visibleRect!.width;
	const row = Math.floor(frame.codedHeight / 2);
	const column = Math.floor(frame.codedWidth / 2);
	const format = frame.format ?? '';

	if (format.startsWith('RGB') || format.startsWith('BGR')) {
		const offset = layout[0]!.offset + row * layout[0]!.stride + 4 * column;
		const [red, green, blue] = format.startsWith('RGB')
			? [buffer[offset]!, buffer[offset + 1]!, buffer[offset + 2]!]
			: [buffer[offset + 2]!, buffer[offset + 1]!, buffer[offset]!];
		return { luma: 16 + (65.481 * red + 128.553 * green + 24.966 * blue) / 255, tight: false };
	}

	// Planar and semi-planar YUV formats all start with the luma plane
	return { luma: buffer[layout[0]!.offset + row * layout[0]!.stride + column]!, tight };
};

type NativeRoundTrip = {
	failed: boolean;
	chunkTimestamps: number[];
	chunkBytes: number;
	decoderConfig: VideoDecoderConfig | null;
	decodedLuma: number[];
	decodedColorSpaces: VideoColorSpaceInit[];
	/** Whether every decoded frame's default copyTo layout starts its luma plane at 0, one visible row per stride. */
	tightLayouts: boolean;
};

/**
 * Encodes flat I420 frames of the given luma values with a literal config and, unless told not to, decodes them back
 * with the encoder's decoder config. Returns null when the platform says it can't encode the config.
 */
const nativeRoundTrip = async (options: {
	config: VideoEncoderConfig;
	encodeOptions?: VideoEncoderEncodeOptions;
	/** Flat frames of a luma value, or textured ones like the tests' (a gradient with a moving bar). */
	frames: { luma: number | 'textured'; colorSpace?: VideoColorSpaceInit }[];
	decode?: boolean;
	decoderColorSpace?: VideoColorSpaceInit;
}): Promise<NativeRoundTrip | null> => {
	const { config } = options;
	if (typeof VideoDecoder === 'undefined' || !await nativeSupports(config)) {
		return null;
	}

	const result: NativeRoundTrip = {
		failed: false,
		chunkTimestamps: [],
		chunkBytes: 0,
		decoderConfig: null,
		decodedLuma: [],
		decodedColorSpaces: [],
		tightLayouts: true,
	};
	const chunks: EncodedVideoChunk[] = [];
	const encoder = new VideoEncoder({
		output: (chunk, meta) => {
			chunks.push(chunk);
			result.chunkTimestamps.push(chunk.timestamp);
			result.chunkBytes += chunk.byteLength;
			if (meta?.decoderConfig && !result.decoderConfig) {
				result.decoderConfig = meta.decoderConfig;
			}
		},
		error: () => {
			result.failed = true;
		},
	});

	try {
		encoder.configure(config);
		const frameDuration = Math.round(1e6 / (config.framerate ?? 30));
		const { width, height } = config;
		options.frames.forEach(({ luma, colorSpace }, i) => {
			const data = new Uint8Array(width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2));
			if (luma === 'textured') {
				for (let y = 0; y < height; y++) {
					for (let x = 0; x < width; x++) {
						data[y * width + x] = Math.abs(x - (i * 8) % width) < 4 ? 235 : 16 + ((x + 2 * y) % 200);
					}
				}
			} else {
				data.fill(luma, 0, width * height);
			}
			data.fill(128, width * height);
			const frame = new VideoFrame(data, {
				format: 'I420',
				codedWidth: width,
				codedHeight: height,
				timestamp: i * frameDuration,
				duration: frameDuration,
				colorSpace,
			});
			encoder.encode(frame, { ...options.encodeOptions, keyFrame: i === 0 });
			frame.close();
		});

		if (await withTimeout(encoder.flush()) === null) {
			hungCoderKinds.add('video');
			result.failed = true;
		}
		// Some encoders report failures after their flush has resolved
		await new Promise(resolve => setTimeout(resolve, 50));
	} catch {
		result.failed = true;
	}
	if (encoder.state !== 'closed') {
		encoder.close();
	}
	if (chunks.length < options.frames.length) {
		result.failed = true;
	}

	if (result.failed || options.decode === false || !result.decoderConfig) {
		return result;
	}

	const pending: Promise<void>[] = [];
	const decoder = new VideoDecoder({
		output: (frame) => {
			const index = pending.length;
			result.decodedColorSpaces[index] = frame.colorSpace.toJSON();
			pending.push(readCenterLuma(frame).then(({ luma, tight }) => {
				result.decodedLuma[index] = luma;
				result.tightLayouts &&= tight;
			}).finally(() => frame.close()));
		},
		error: () => {
			result.failed = true;
		},
	});

	try {
		decoder.configure({
			...result.decoderConfig,
			...(options.decoderColorSpace ? { colorSpace: options.decoderColorSpace } : {}),
		});
		for (const chunk of chunks) {
			decoder.decode(chunk);
		}
		if (await withTimeout(decoder.flush()) === null) {
			hungCoderKinds.add('video');
			result.failed = true;
		}
		await Promise.all(pending);
	} catch {
		result.failed = true;
	}
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return result;
};

/** Total bytes for 1 s of textured 320x240 video at 30 fps, or null if the platform can't encode it. */
const nativeTexturedBytes = async (config: VideoEncoderConfig, encodeOptions: VideoEncoderEncodeOptions = {}) => {
	if (!await nativeSupports(config)) {
		return null;
	}

	const { width, height } = config;
	let bytes = 0;
	let failed = false;
	const encoder = new VideoEncoder({
		output: (chunk) => {
			bytes += chunk.byteLength;
		},
		error: () => {
			failed = true;
		},
	});

	try {
		encoder.configure(config);
		for (let i = 0; i < 30; i++) {
			const data = new Uint8Array(width * height * 3 / 2).fill(128);
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					data[y * width + x] = 128 + 60 * Math.sin(x * 0.05 + i * 0.3) * Math.cos(y * 0.07 - i * 0.2)
						+ ((x * 7 + y * 13 + i * 31) % 9) - 4;
				}
			}
			const frame = new VideoFrame(data, {
				format: 'I420',
				codedWidth: width,
				codedHeight: height,
				timestamp: Math.round(i * 1e6 / 30),
				duration: Math.round(1e6 / 30),
			});
			encoder.encode(frame, { ...encodeOptions, keyFrame: i === 0 });
			frame.close();
		}
		if (await withTimeout(encoder.flush()) === null) {
			hungCoderKinds.add('video');
			failed = true;
		}
	} catch {
		failed = true;
	}
	if (encoder.state !== 'closed') {
		encoder.close();
	}

	return failed ? null : bytes;
};

/**
 * Whether two flat frames make it through the platform's encoder and decoder, with the rate control a test's encode
 * at a quality level would use. WebKitGTK accepts quantizer-based HEVC, then fails to encode it.
 */
export const videoRoundTrips = memoizeByKey(async (codec: ProbedVideoCodec) => {
	// Textured I420 frames from buffers, like the tests encode (WebKitGTK's HEVC encoder fails on those, though not on
	// canvas-backed frames)
	const { config, encodeOptions } = await nativeVideoConfig(codec, 160, 120, 200_000);
	const frames = Array.from({ length: 4 }, () => ({ luma: 'textured' as const }));
	const roundTrip = await nativeRoundTrip({ config, encodeOptions, frames });
	return !!roundTrip && !roundTrip.failed && roundTrip.decodedLuma.filter(x => x !== undefined).length === 4;
});

/**
 * Whether the platform contradicts itself at a frame size: it accepts the config a test's encode would use, but
 * encoding a frame with it fails. Support queries can't be expected to agree with encodes there.
 */
export const nativeVideoContradicts = async (codec: ProbedVideoCodec, width: number, height: number) => {
	const { config, encodeOptions } = await nativeVideoConfig(codec, width, height, 500_000);
	const roundTrip = await nativeRoundTrip({
		config,
		encodeOptions,
		frames: [{ luma: 'textured' }, { luma: 'textured' }],
		decode: false,
	});
	return !!roundTrip && roundTrip.failed;
};

/**
 * Whether the platform encodes every frame of a low-bitrate H.264 stream, at its own timestamp. OpenH264 through
 * GStreamer (WebKitGTK) skips frames at low bitrates, so its frame-exact timing can't be checked.
 */
export const avcKeepsEveryFrame = memoize(async () => {
	const lumas = [16, 48, 80, 112, 144, 176, 208, 240];
	const roundTrip = await nativeRoundTrip({
		config: { codec: literalCodecString('avc', 64, 64), width: 64, height: 64, bitrate: 32_000, framerate: 30 },
		frames: lumas.map(luma => ({ luma })),
	});

	return !!roundTrip
		&& !roundTrip.failed
		&& roundTrip.chunkTimestamps.length === lumas.length
		&& roundTrip.chunkTimestamps[0] === 0
		&& lumas.every((luma, i) => Math.abs((roundTrip.decodedLuma[i] ?? -100) - luma) <= 20);
});

/** Whether the platform's H.264 encoder produces the profile a literal codec string asks for (Baseline-only don't). */
export const avcHonorsProfile = memoizeByKey(async (codecString: string) => {
	const profileIdc = parseInt(codecString.slice(5, 7), 16);
	const roundTrip = await nativeRoundTrip({
		config: { codec: codecString, width: 64, height: 64, bitrate: 200_000, framerate: 30 },
		frames: [{ luma: 128 }],
		decode: false,
	});
	const description = roundTrip?.decoderConfig?.description;
	if (!roundTrip || roundTrip.failed || !description) {
		return false;
	}

	const bytes = ArrayBuffer.isView(description)
		? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
		: new Uint8Array(description);
	return bytes[1] === profileIdc;
});

/** Whether the platform's VP8 encoder meets an explicit 300 kbps within 35% on textured video. */
export const vp8MeetsBitrate = memoize(async () => {
	const bytes = await nativeTexturedBytes({
		codec: 'vp8',
		width: 320,
		height: 240,
		bitrate: 300_000,
		framerate: 30,
	});
	return bytes !== null && Math.abs(8 * bytes - 300_000) <= 0.35 * 300_000;
});

/**
 * Whether asking the platform's encoder for more quality gives more bytes, with the rate control a test's quality
 * levels use: the worst against the best quantizer where quantizer mode is accepted, else 200 kbps against 1.6 Mbps.
 * WebKitGTK's VP9 ignores the quantizer.
 */
export const qualityRaisesSize = memoizeByKey(async (codec: ProbedVideoCodec) => {
	const quantizers = LITERAL_QUANTIZERS[codec];
	const config = { codec: literalCodecString(codec, 320, 240), width: 320, height: 240, framerate: 30 };

	let low: number | null;
	let high: number | null;
	if (quantizers && await nativeQuantizerMode(codec)) {
		const quantizerConfig: VideoEncoderConfig = { ...config, bitrateMode: 'quantizer' };
		low = await nativeTexturedBytes(quantizerConfig, quantizerOptions(codec, quantizers.worst));
		high = await nativeTexturedBytes(quantizerConfig, quantizerOptions(codec, quantizers.best));
	} else {
		low = await nativeTexturedBytes({ ...config, bitrate: 200_000 });
		high = await nativeTexturedBytes({ ...config, bitrate: 1_600_000 });
	}

	return low !== null && high !== null && high > 1.3 * low;
});

const ALPHA_COLOR_SPACE: VideoColorSpaceInit = {
	primaries: 'bt709',
	transfer: 'bt709',
	matrix: 'bt709',
	fullRange: true,
};

/**
 * Whether full-range flat frames of luma 255 and 64 come back through the platform's encoder and decoder within 10, at
 * 2 Mbps, in decoded frames whose default copyTo layout is tightly packed (as WebCodecs specifies, and as alpha merging
 * reads them). Alpha is encoded as the luma of a second, full-range stream, so alpha values can only be checked where
 * this holds.
 */
export const flatLumaSurvives = memoizeByKey(async (codec: ProbedVideoCodec) => {
	const lumas = [255, 64];
	const roundTrip = await nativeRoundTrip({
		config: {
			codec: literalCodecString(codec, 160, 120),
			width: 160,
			height: 120,
			bitrate: 2_000_000,
			framerate: 30,
		},
		frames: lumas.map(luma => ({ luma, colorSpace: ALPHA_COLOR_SPACE })),
		decoderColorSpace: ALPHA_COLOR_SPACE,
	});
	return !!roundTrip
		&& !roundTrip.failed
		&& roundTrip.tightLayouts
		&& lumas.every((luma, i) => Math.abs((roundTrip.decodedLuma[i] ?? -100) - luma) <= 10);
});

const sameColorSpace = (a: VideoColorSpaceInit | undefined | null, b: VideoColorSpaceInit) => {
	return !!a
		&& a.primaries === b.primaries
		&& a.transfer === b.transfer
		&& a.matrix === b.matrix
		&& a.fullRange === b.fullRange;
};

/**
 * Whether the platform's encoder reports the color space of its frames in its decoder config, and whether its decoder
 * reports the color space of its config on the frames it outputs, per codec and color space. WebKitGTK's report
 * 'unspecified'.
 */
export const colorSpaceSupport = memoizeByKey(async (key: string) => {
	const { codec, colorSpace } = JSON.parse(key) as { codec: ProbedVideoCodec; colorSpace: VideoColorSpaceInit };
	const { config, encodeOptions } = await nativeVideoConfig(codec, 160, 120, 200_000);
	const roundTrip = await nativeRoundTrip({
		config,
		encodeOptions,
		frames: [{ luma: 'textured', colorSpace }, { luma: 'textured', colorSpace }],
		decoderColorSpace: colorSpace,
	});
	if (!roundTrip || roundTrip.failed) {
		return { encoderReports: false, decoderReports: false };
	}

	return {
		encoderReports: sameColorSpace(roundTrip.decoderConfig?.colorSpace, colorSpace),
		decoderReports: roundTrip.decodedColorSpaces.length > 0
			&& roundTrip.decodedColorSpaces.every(x => sameColorSpace(x, colorSpace)),
	};
});

/**
 * Whether the platform decodes AV1, checked on 64x64 black made by FFmpeg (-c:v libaom-av1 -cpu-used 8 -crf 50, with
 * its sequence header). WebKitGTK says it decodes AV1 but then fails.
 */
export const av1DecodesNatively = memoize(async () => {
	if (typeof VideoDecoder === 'undefined' || hungCoderKinds.has('video')) {
		return false;
	}

	const config: VideoDecoderConfig = { codec: 'av01.0.00M.08', codedWidth: 64, codedHeight: 64 };
	const support = await withTimeout(VideoDecoder.isConfigSupported(config).then(x => !!x.supported, () => false));
	if (!support?.value) {
		return false;
	}

	let outputs = 0;
	let failed = false;
	const decoder = new VideoDecoder({
		output: (frame) => {
			outputs++;
			frame.close();
		},
		error: () => {
			failed = true;
		},
	});
	try {
		decoder.configure(config);
		decoder.decode(new EncodedVideoChunk({
			type: 'key',
			timestamp: 0,
			data: fromBase64('EgAKCgAAAAKv/5tfIAgyDRAAuoAAAkAAAAPOF7o='),
		}));
		if (await withTimeout(decoder.flush()) === null) {
			hungCoderKinds.add('video');
			failed = true;
		}
	} catch {
		failed = true;
	}
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return !failed && outputs > 0;
});

/** Whether the platform's own support query accepts a literal video config with prefer-hardware. */
export const nativeSupportsPreferHardware = async (codec: ProbedVideoCodec) => {
	return nativeSupports({
		codec: literalCodecString(codec, 320, 240),
		width: 320,
		height: 240,
		bitrate: 1_000_000,
		hardwareAcceleration: 'prefer-hardware',
	});
};

/**
 * Encodes 0.1 s of silence with a literal audio config and decodes it back (Mediabunny decodes an encoder's output to
 * measure its delay). 'unsupported' when the platform's support query says no, 'fails' when it says yes but encoding or
 * decoding fails, 'hangs' when a call never settles (after which the audio coders on the page can't be trusted).
 */
export const nativeAudioEncode = async (
	codec: string,
	sampleRate: number,
	numberOfChannels: number,
	/** The sample rate to decode with, if not the encoder's (Mediabunny's demuxers give Opus 48 kHz). */
	decodeSampleRate?: number,
): Promise<'unsupported' | 'works' | 'fails' | 'hangs'> => {
	if (typeof AudioEncoder === 'undefined') {
		return 'unsupported';
	}
	if (hungCoderKinds.has('audio')) {
		return 'hangs';
	}

	const config: AudioEncoderConfig = { codec, sampleRate, numberOfChannels, bitrate: 64_000 };
	const support = await withTimeout(AudioEncoder.isConfigSupported(config).then(x => !!x.supported, () => false));
	if (support === null) {
		hungCoderKinds.add('audio');
		return 'hangs';
	}
	if (!support.value) {
		return 'unsupported';
	}

	const chunks: EncodedAudioChunk[] = [];
	let decoderConfig: AudioDecoderConfig | null = null;
	let failed = false;
	const encoder = new AudioEncoder({
		output: (chunk, meta) => {
			chunks.push(chunk);
			if (meta?.decoderConfig && !decoderConfig) {
				decoderConfig = meta.decoderConfig;
			}
		},
		error: () => {
			failed = true;
		},
	});
	let hung = false;
	try {
		encoder.configure(config);
		const frames = Math.round(sampleRate / 10);
		const data = new AudioData({
			format: 'f32-planar',
			sampleRate,
			numberOfChannels,
			numberOfFrames: frames,
			timestamp: 0,
			data: new Float32Array(frames * numberOfChannels),
		});
		encoder.encode(data);
		data.close();
		if (await withTimeout(encoder.flush()) === null) {
			hung = true;
		}
	} catch {
		failed = true;
	}
	if (encoder.state !== 'closed') {
		encoder.close();
	}

	if (hung) {
		hungCoderKinds.add('audio');
		return 'hangs';
	}
	if (failed || chunks.length === 0 || !decoderConfig) {
		return 'fails';
	}

	const decodingConfig: AudioDecoderConfig = decodeSampleRate !== undefined
		? { ...(decoderConfig as AudioDecoderConfig), sampleRate: decodeSampleRate }
		: decoderConfig;
	const decoded = await nativeAudioDecode(decodingConfig, chunks.map((chunk) => {
		const data = new Uint8Array(chunk.byteLength);
		chunk.copyTo(data);
		return { timestamp: chunk.timestamp, data };
	}));
	if (hungCoderKinds.has('audio')) {
		return 'hangs';
	}
	return decoded && decoded.rates.length > 0 ? 'works' : 'fails';
};

/**
 * Whether the platform's Opus decoder outputs 48 kHz for a stream encoded from 8 kHz input, as Chrome's does. Checked
 * on 0.06 s of mono silence made by FFmpeg (-c:a libopus -b:a 16k, .ogg), with the input sample rate in its
 * identification header set to 8000 and the 48 kHz decoder config Mediabunny's demuxers give Opus.
 */
export const opusDecodesAt48kHz = memoize(async () => {
	const sampleRates = await nativeAudioDecode(
		(() => {
			const description = fromBase64('T3B1c0hlYWQBATgBgLsAAAAAAA==');
			new DataView(description.buffer).setUint32(12, 8000, true);
			return { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, description };
		})(),
		['eAvkwTbsxY2MSUaZpCaw', 'eAfJcifhROpV8fDA1d3pUmA=', 'eAfJecjJV8CiEiP672fzZMDg'].map((chunk, i) => ({
			timestamp: i * 20_000,
			data: fromBase64(chunk),
		})),
	);

	return sampleRates !== null && sampleRates.rates.length > 0 && sampleRates.rates.every(x => x === 48000);
});

/**
 * Whether the platform's audio decoders keep timestamps that follow a negative one. WebKitGTK's GStreamer decoders
 * scramble them (they flip the playback direction of their segment), and encoded audio usually starts below zero
 * (encoder delay), so its timing can't be checked there.
 */
export const negativeTimestampsDecodeCorrectly = memoize(async () => {
	const result = await nativeAudioDecode(
		{ codec: 'pcm-s16', sampleRate: 48000, numberOfChannels: 1 },
		[-20000, 0, 20000].map(timestamp => ({ timestamp, data: new Uint8Array(1920) })),
	);

	return result !== null && result.timestamps.join() === '-20000,0,20000';
});

const nativeAudioDecode = async (
	config: AudioDecoderConfig,
	chunks: { timestamp: number; data: Uint8Array }[],
) => {
	if (typeof AudioDecoder === 'undefined' || hungCoderKinds.has('audio')) {
		return null;
	}

	const support = await withTimeout(AudioDecoder.isConfigSupported(config).then(x => !!x.supported, () => false));
	if (support === null) {
		hungCoderKinds.add('audio');
		return null;
	}
	if (!support.value) {
		return null;
	}

	const rates: number[] = [];
	const timestamps: number[] = [];
	let failed = false;
	const decoder = new AudioDecoder({
		output: (data) => {
			rates.push(data.sampleRate);
			timestamps.push(data.timestamp);
			data.close();
		},
		error: () => {
			failed = true;
		},
	});
	try {
		decoder.configure(config);
		for (const chunk of chunks) {
			decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: chunk.timestamp, data: chunk.data }));
		}
		if (await withTimeout(decoder.flush()) === null) {
			hungCoderKinds.add('audio');
			failed = true;
		}
	} catch {
		failed = true;
	}
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return failed ? null : { rates, timestamps };
};
