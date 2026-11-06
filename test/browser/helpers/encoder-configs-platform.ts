/*!
 * Native platform probes for the encoder configuration suite. Whether the platform's encoders and decoders can do
 * something is decided with WebCodecs alone, on literal configs and synthetic frames or a tiny known-good stream,
 * never with Mediabunny, so that a Mediabunny failure on a capable platform fails instead of skipping. Probes run
 * lazily (only when a test needs them) and every native call has a timeout, since some decoders hang instead of
 * failing.
 */

const NATIVE_TIMEOUT = 5000;

const withTimeout = <T>(promise: Promise<T>) => Promise.race([
	promise.then(value => ({ value })),
	new Promise<null>(resolve => setTimeout(() => resolve(null), NATIVE_TIMEOUT)),
]);

const memoize = <T>(fn: () => Promise<T>) => {
	let result: Promise<T> | null = null;
	return () => result ??= fn();
};

const fromBase64 = (base64: string) => Uint8Array.from(atob(base64), x => x.charCodeAt(0));

/** Literal encoder configs, one per codec, used by the probes. */
export const literalCodecStrings = {
	avc: 'avc1.42001f',
	hevc: 'hev1.1.6.L93.B0',
	vp8: 'vp8',
	vp9: 'vp09.00.10.08',
	av1: 'av01.0.04M.08',
	prores: 'apcn',
} as const;

const readCenterLuma = async (frame: VideoFrame) => {
	const buffer = new Uint8Array(frame.allocationSize());
	const layout = await frame.copyTo(buffer);
	const row = Math.floor(frame.codedHeight / 2);
	const column = Math.floor(frame.codedWidth / 2);
	const format = frame.format ?? '';

	if (format.startsWith('RGB') || format.startsWith('BGR')) {
		const offset = layout[0]!.offset + row * layout[0]!.stride + 4 * column;
		const [red, green, blue] = format.startsWith('RGB')
			? [buffer[offset]!, buffer[offset + 1]!, buffer[offset + 2]!]
			: [buffer[offset + 2]!, buffer[offset + 1]!, buffer[offset]!];
		return 16 + (65.481 * red + 128.553 * green + 24.966 * blue) / 255;
	}

	// Planar and semi-planar YUV formats all start with the luma plane
	return buffer[layout[0]!.offset + row * layout[0]!.stride + column]!;
};

type NativeRoundTrip = {
	failed: boolean;
	chunkTimestamps: number[];
	chunkBytes: number;
	decoderConfig: VideoDecoderConfig | null;
	decodedLuma: number[];
};

/**
 * Encodes flat I420 frames of the given luma values with a literal config and decodes them back with the encoder's
 * decoder config. Returns null when the platform says it can't encode the config.
 */
const nativeRoundTrip = async (
	config: VideoEncoderConfig,
	frames: { luma: number; colorSpace?: VideoColorSpaceInit }[],
	decode = true,
): Promise<NativeRoundTrip | null> => {
	if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
		return null;
	}

	const support = await withTimeout(VideoEncoder.isConfigSupported(config).then(x => !!x.supported, () => false));
	if (!support?.value) {
		return null;
	}

	const result: NativeRoundTrip = {
		failed: false,
		chunkTimestamps: [],
		chunkBytes: 0,
		decoderConfig: null,
		decodedLuma: [],
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
		frames.forEach(({ luma, colorSpace }, i) => {
			const data = new Uint8Array(width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2));
			data.fill(luma, 0, width * height);
			data.fill(128, width * height);
			const frame = new VideoFrame(data, {
				format: 'I420',
				codedWidth: width,
				codedHeight: height,
				timestamp: i * frameDuration,
				duration: frameDuration,
				colorSpace,
			});
			encoder.encode(frame, { keyFrame: i === 0 });
			frame.close();
		});

		if (await withTimeout(encoder.flush()) === null) {
			result.failed = true;
		}
	} catch {
		result.failed = true;
	}
	if (encoder.state !== 'closed') {
		encoder.close();
	}

	if (result.failed || !decode || !result.decoderConfig) {
		return result;
	}

	const pending: Promise<void>[] = [];
	const decoder = new VideoDecoder({
		output: (frame) => {
			const index = pending.length;
			pending.push(readCenterLuma(frame).then((luma) => {
				result.decodedLuma[index] = luma;
			}).finally(() => frame.close()));
		},
		error: () => {
			result.failed = true;
		},
	});

	try {
		decoder.configure(result.decoderConfig);
		for (const chunk of chunks) {
			decoder.decode(chunk);
		}
		if (await withTimeout(decoder.flush()) === null) {
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

/** Total bytes for 1 s of textured 320x240 video at 30 fps, encoded with a literal config at the given bitrate. */
const nativeTexturedBytes = async (codec: string, bitrate: number) => {
	const width = 320;
	const height = 240;
	const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: 30 };
	const support = await withTimeout(VideoEncoder.isConfigSupported(config).then(x => !!x.supported, () => false));
	if (!support?.value) {
		return null;
	}

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
			encoder.encode(frame, { keyFrame: i === 0 });
			frame.close();
		}
		if (await withTimeout(encoder.flush()) === null) {
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
 * Whether the platform encodes every frame of a low-bitrate H.264 stream, at its own timestamp. OpenH264 through
 * GStreamer (WebKitGTK) skips frames at low bitrates, so its frame-exact timing can't be checked.
 */
export const avcKeepsEveryFrame = memoize(async () => {
	const lumas = [16, 48, 80, 112, 144, 176, 208, 240];
	const result = await nativeRoundTrip(
		{ codec: literalCodecStrings.avc, width: 64, height: 64, bitrate: 32_000, framerate: 30 },
		lumas.map(luma => ({ luma })),
	);

	return !!result
		&& !result.failed
		&& result.chunkTimestamps.length === lumas.length
		&& result.chunkTimestamps[0] === 0
		&& lumas.every((luma, i) => Math.abs((result.decodedLuma[i] ?? -100) - luma) <= 20);
});

const avcProfileMemo = new Map<string, Promise<boolean>>();
/** Whether the platform's H.264 encoder produces the profile a literal codec string asks for (Baseline-only don't). */
export const avcHonorsProfile = (codecString: string, profileIdc: number) => {
	let result = avcProfileMemo.get(codecString);
	if (!result) {
		result = (async () => {
			const roundTrip = await nativeRoundTrip(
				{ codec: codecString, width: 64, height: 64, bitrate: 200_000, framerate: 30 },
				[{ luma: 128 }],
				false,
			);
			const description = roundTrip?.decoderConfig?.description;
			if (!roundTrip || roundTrip.failed || !description) {
				return false;
			}

			const bytes = ArrayBuffer.isView(description)
				? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
				: new Uint8Array(description);
			return bytes[1] === profileIdc;
		})();
		avcProfileMemo.set(codecString, result);
	}

	return result;
};

const roundTripMemo = new Map<string, Promise<boolean>>();
/** Whether two flat frames make it through the platform's encoder and decoder with a literal config. */
export const videoRoundTrips = (codec: keyof typeof literalCodecStrings) => {
	let result = roundTripMemo.get(codec);
	if (!result) {
		result = (async () => {
			const roundTrip = await nativeRoundTrip(
				{ codec: literalCodecStrings[codec], width: 160, height: 120, bitrate: 500_000, framerate: 30 },
				[{ luma: 100 }, { luma: 150 }],
			);
			return !!roundTrip && !roundTrip.failed && roundTrip.decodedLuma.filter(x => x !== undefined).length === 2;
		})();
		roundTripMemo.set(codec, result);
	}

	return result;
};

/** Whether the platform's VP8 encoder meets an explicit 300 kbps within 35% on textured video. */
export const vp8MeetsBitrate = memoize(async () => {
	const bytes = await nativeTexturedBytes(literalCodecStrings.vp8, 300_000);
	return bytes !== null && Math.abs(8 * bytes - 300_000) <= 0.35 * 300_000;
});

const flatFramesSurviveMemo = new Map<string, Promise<boolean>>();
/**
 * Whether flat frames of luma 255 and 64 come back through the platform's encoder and decoder within 10. Alpha is
 * encoded as the luma of a second stream, so alpha values can only be checked where this holds.
 */
export const flatLumaSurvives = (codec: keyof typeof literalCodecStrings) => {
	let result = flatFramesSurviveMemo.get(codec);
	if (!result) {
		result = (async () => {
			const lumas = [255, 64];
			const roundTrip = await nativeRoundTrip(
				{ codec: literalCodecStrings[codec], width: 160, height: 120, bitrate: 1_000_000, framerate: 30 },
				lumas.map(luma => ({ luma })),
			);
			return !!roundTrip
				&& !roundTrip.failed
				&& lumas.every((luma, i) => Math.abs((roundTrip.decodedLuma[i] ?? -100) - luma) <= 10);
		})();
		flatFramesSurviveMemo.set(codec, result);
	}

	return result;
};

const BT709_FULL: VideoColorSpaceInit = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true };

const sameColorSpace = (a: VideoColorSpaceInit | undefined | null, b: VideoColorSpaceInit) => {
	return !!a
		&& a.primaries === b.primaries
		&& a.transfer === b.transfer
		&& a.matrix === b.matrix
		&& a.fullRange === b.fullRange;
};

/**
 * Whether the platform's VP8 encoder reports the color space of its frames in its decoder config, and whether its
 * decoder reports the color space of its config on the frames it outputs. WebKitGTK's report 'unspecified'.
 */
export const colorSpaceSupport = memoize(async () => {
	const result = await nativeRoundTrip(
		{ codec: literalCodecStrings.vp8, width: 64, height: 64, bitrate: 200_000, framerate: 30 },
		[{ luma: 128, colorSpace: BT709_FULL }],
		false,
	);
	if (!result || result.failed || !result.decoderConfig) {
		return { encoderReports: false, decoderReports: false };
	}

	const encoderReports = sameColorSpace(result.decoderConfig.colorSpace, BT709_FULL);

	// Decode a known-good VP8 key frame with a color space in the config
	let decoderReports = false;
	const decoder = new VideoDecoder({
		output: (frame) => {
			decoderReports = sameColorSpace(frame.colorSpace.toJSON(), BT709_FULL);
			frame.close();
		},
		error: () => {},
	});
	try {
		decoder.configure({ codec: 'vp8', codedWidth: 64, codedHeight: 64, colorSpace: BT709_FULL });
		decoder.decode(new EncodedVideoChunk({
			type: 'key',
			timestamp: 0,
			data: fromBase64('8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v+rUIA='),
		}));
		await withTimeout(decoder.flush());
	} catch {
		decoderReports = false;
	}
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return { encoderReports, decoderReports };
});

/**
 * Whether the platform decodes AV1, checked on 64x64 black made by FFmpeg (-c:v libaom-av1 -cpu-used 8 -crf 50, with
 * its sequence header). WebKitGTK says it decodes AV1 but then fails.
 */
export const av1DecodesNatively = memoize(async () => {
	if (typeof VideoDecoder === 'undefined') {
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
export const nativeSupportsPreferHardware = async (codec: keyof typeof literalCodecStrings) => {
	if (typeof VideoEncoder === 'undefined') {
		return false;
	}

	const support = await withTimeout(VideoEncoder.isConfigSupported({
		codec: literalCodecStrings[codec],
		width: 320,
		height: 240,
		bitrate: 1_000_000,
		hardwareAcceleration: 'prefer-hardware',
	}).then(x => !!x.supported, () => false));
	return !!support?.value;
};

/**
 * Whether the platform contradicts itself on a literal video config: its support query accepts it, but encoding a
 * frame with it fails. Support queries can't be expected to agree with encodes there.
 */
export const nativeVideoContradicts = async (
	codec: keyof typeof literalCodecStrings,
	width: number,
	height: number,
) => {
	const result = await nativeRoundTrip(
		{ codec: literalCodecStrings[codec], width, height, bitrate: 500_000, framerate: 30 },
		[{ luma: 128 }, { luma: 140 }],
		false,
	);
	return !!result && (result.failed || result.chunkTimestamps.length === 0);
};

/** Same as nativeVideoContradicts, for a literal audio config. */
export const nativeAudioContradicts = async (codec: string, sampleRate: number, numberOfChannels: number) => {
	if (typeof AudioEncoder === 'undefined') {
		return false;
	}

	const config: AudioEncoderConfig = { codec, sampleRate, numberOfChannels, bitrate: 64_000 };
	const support = await withTimeout(AudioEncoder.isConfigSupported(config).then(x => !!x.supported, () => false));
	if (!support?.value) {
		return false;
	}

	let outputs = 0;
	let failed = false;
	const encoder = new AudioEncoder({
		output: () => {
			outputs++;
		},
		error: () => {
			failed = true;
		},
	});
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
			failed = true;
		}
	} catch {
		failed = true;
	}
	if (encoder.state !== 'closed') {
		encoder.close();
	}

	return failed || outputs === 0;
};
