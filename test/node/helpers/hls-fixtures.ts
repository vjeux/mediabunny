import { HLS_FORMATS, ALL_FORMATS, InputFormatOptions } from '../../../src/input-format.js';
import { Input } from '../../../src/input.js';
import { InputAudioTrack, InputTrack, InputVideoTrack } from '../../../src/input-track.js';
import { EncodedPacketSink } from '../../../src/media-sink.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../../src/media-source.js';
import { AudioTrackMetadata, Output, VideoTrackMetadata } from '../../../src/output.js';
import { HlsOutputFormat, HlsOutputFormatOptions } from '../../../src/output-format.js';
import { EncodedPacket } from '../../../src/packet.js';
import { BufferSource, CustomPathedSource, FilePathSource } from '../../../src/source.js';
import { BufferTarget, PathedTarget } from '../../../src/target.js';

/** A file system in memory: path -> file contents. */
export type MemoryFiles = Map<string, Uint8Array>;

export const encodeText = (text: string) => new TextEncoder().encode(text);

export const readText = (files: MemoryFiles, path: string) => {
	const file = files.get(path);
	if (!file) {
		throw new Error(`No file at "${path}".`);
	}

	return new TextDecoder().decode(file);
};

/** Creates an HLS Input reading from the in-memory files, recording each requested path. */
export const createMemoryInput = (files: MemoryFiles, rootPath: string, formatOptions?: InputFormatOptions) => {
	const requests: string[] = [];

	const input = new Input({
		source: new CustomPathedSource(rootPath, ({ path }) => {
			requests.push(path);

			const file = files.get(path);
			if (!file) {
				throw new Error(`No file at "${path}".`);
			}

			return new BufferSource(file);
		}),
		formats: HLS_FORMATS,
		formatOptions,
	});

	return { input, requests, [Symbol.dispose]: () => input.dispose() };
};

export type SourceMedia = {
	videoPackets: EncodedPacket[];
	videoDecoderConfig: VideoDecoderConfig;
	audioPackets: EncodedPacket[];
	audioDecoderConfig: AudioDecoderConfig;
};

let sourceMediaPromise: Promise<SourceMedia> | null = null;

/**
 * Real encoder output used to build HLS streams in tests: `test/public/edts.mp4`, 9 s of x264 High profile video
 * (854x480, 25 fps, B-frames, a key frame every 1.92 s) and 44.1 kHz stereo AAC-LC.
 */
export const loadSourceMedia = () => sourceMediaPromise ??= (async () => {
	using input = new Input({
		source: new FilePathSource('./test/public/edts.mp4'),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	if (!videoTrack || !audioTrack) {
		throw new Error('Expected a video and an audio track.');
	}

	const videoDecoderConfig = await videoTrack.getDecoderConfig();
	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	if (!videoDecoderConfig || !audioDecoderConfig) {
		throw new Error('Expected decoder configs.');
	}

	return {
		videoPackets: await readPackets(videoTrack),
		videoDecoderConfig,
		audioPackets: await readPackets(audioTrack),
		audioDecoderConfig,
	};
})();

export const readPackets = async (track: InputTrack) => {
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	return packets;
};

/** Packet timestamps in presentation order, rounded to microseconds. */
export const presentationTimestamps = (packets: EncodedPacket[]) => packets
	.map(packet => Math.round(packet.timestamp * 1e6) / 1e6)
	.sort((a, b) => a - b);

export type WriteHlsOptions = {
	format: HlsOutputFormatOptions;
	video?: boolean;
	audio?: boolean;
	rootPath?: string;
	videoMetadata?: VideoTrackMetadata;
	audioMetadata?: AudioTrackMetadata;
	/** Offset added to all source timestamps. */
	timestampOffset?: number;
};

/** Writes the source media as HLS into memory, returning every written file. */
export const writeHls = async (options: WriteHlsOptions) => {
	const media = await loadSourceMedia();
	const files: MemoryFiles = new Map();

	const output = new Output({
		format: new HlsOutputFormat(options.format),
		target: new PathedTarget(options.rootPath ?? 'master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				files.set(request.path, new Uint8Array(target.buffer!));
			});

			return target;
		}),
	});

	const videoSource = options.video !== false ? new EncodedVideoPacketSource('avc') : null;
	const audioSource = options.audio !== false ? new EncodedAudioPacketSource('aac') : null;
	if (videoSource) {
		output.addVideoTrack(videoSource, options.videoMetadata);
	}
	if (audioSource) {
		output.addAudioTrack(audioSource, options.audioMetadata);
	}

	await output.start();

	const offset = options.timestampOffset ?? 0;
	const videoPackets = videoSource ? media.videoPackets : [];
	const audioPackets = audioSource ? media.audioPackets : [];
	let videoIndex = 0;
	let audioIndex = 0;

	// Interleave by timestamp, like a real producer would
	while (videoIndex < videoPackets.length || audioIndex < audioPackets.length) {
		const nextVideo = videoPackets[videoIndex];
		const nextAudio = audioPackets[audioIndex];

		if (nextVideo && (!nextAudio || nextVideo.timestamp <= nextAudio.timestamp)) {
			await videoSource!.add(
				nextVideo.clone({ timestamp: nextVideo.timestamp + offset }),
				{ decoderConfig: media.videoDecoderConfig },
			);
			videoIndex++;
		} else {
			await audioSource!.add(
				nextAudio!.clone({ timestamp: nextAudio!.timestamp + offset }),
				{ decoderConfig: media.audioDecoderConfig },
			);
			audioIndex++;
		}
	}

	await output.finalize();

	return files;
};

/** The segment URIs of a media playlist, in order. */
export const getSegmentUris = (playlist: string) => playlist
	.split('\n')
	.map(line => line.trim())
	.filter(line => line.length > 0 && !line.startsWith('#'));

/** Encrypts data with AES-128-CBC and PKCS#7 padding, as HLS's METHOD=AES-128 prescribes. */
export const encryptAes128Cbc = async (data: Uint8Array, key: Uint8Array, iv: Uint8Array) => {
	const algorithm = { name: 'AES-CBC', iv: new Uint8Array(iv) };
	const cryptoKey = await crypto.subtle.importKey('raw', new Uint8Array(key), algorithm, false, ['encrypt']);
	const ciphertext = await crypto.subtle.encrypt(algorithm, cryptoKey, new Uint8Array(data));

	return new Uint8Array(ciphertext);
};

/** The IV HLS uses when EXT-X-KEY has no IV attribute: the Media Sequence Number as a 128-bit big-endian integer. */
export const mediaSequenceIv = (sequenceNumber: number | bigint) => {
	const iv = new Uint8Array(16);
	let value = BigInt(sequenceNumber);
	for (let i = 15; i >= 0; i--) {
		iv[i] = Number(value & 0xffn);
		value >>= 8n;
	}

	return iv;
};

export const toHex = (bytes: Uint8Array) => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');

export const isVideoTrack = (track: InputTrack): track is InputVideoTrack => track.isVideoTrack();
export const isAudioTrack = (track: InputTrack): track is InputAudioTrack => track.isAudioTrack();
