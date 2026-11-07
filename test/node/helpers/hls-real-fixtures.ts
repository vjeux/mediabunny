import fs from 'node:fs';
import { ALL_FORMATS, HLS_FORMATS, InputFormatOptions } from '../../../src/input-format.js';
import { Input } from '../../../src/input.js';
import { InputTrack } from '../../../src/input-track.js';
import { EncodedPacketSink } from '../../../src/media-sink.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../../src/media-source.js';
import { Output } from '../../../src/output.js';
import { HlsOutputFormat, OutputFormat } from '../../../src/output-format.js';
import { EncodedPacket } from '../../../src/packet.js';
import { BufferSource, CustomPathedSource, FilePathSource } from '../../../src/source.js';
import { BufferTarget, PathedTarget } from '../../../src/target.js';

// Building blocks for HLS streams shaped like public test streams (Apple's examples, the hls.js and Shaka demo
// lists, CDN demo pages). Playlists are written in the tests, after the real ones; media comes from real encoder
// output in test/public, segmented in memory.

/** Files in memory: path -> contents. */
export type MemoryFiles = Map<string, Uint8Array>;

export const encodeText = (text: string) => new TextEncoder().encode(text);

export const concatBytes = (parts: Uint8Array[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}

	return result;
};

/**
 * An HLS input over in-memory files that records every requested path. `getFile`, when given, serves files that change
 * between requests, such as live playlists.
 */
export const createMemoryInput = (
	files: MemoryFiles,
	rootPath: string,
	options: { formatOptions?: InputFormatOptions; getFile?: (path: string) => Uint8Array | undefined } = {},
) => {
	const requests: string[] = [];
	const input = new Input({
		source: new CustomPathedSource(rootPath, ({ path }) => {
			requests.push(path);

			const file = options.getFile?.(path) ?? files.get(path);
			if (!file) {
				throw new Error(`No file at "${path}".`);
			}

			return new BufferSource(file);
		}),
		formats: HLS_FORMATS,
		formatOptions: options.formatOptions,
	});

	return { input, requests, [Symbol.dispose]: () => input.dispose() };
};

export const readPackets = async (track: InputTrack, options: { metadataOnly?: boolean } = {}) => {
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, options)) {
		packets.push(packet);
	}

	return packets;
};

export const roundTo = (value: number, decimals = 6) => Math.round(value * 10 ** decimals) / 10 ** decimals;

type EncodedMedia = {
	videoPackets: EncodedPacket[];
	videoDecoderConfig: VideoDecoderConfig;
	audioPackets: EncodedPacket[];
	audioDecoderConfig: AudioDecoderConfig;
};

let edtsMediaPromise: Promise<EncodedMedia> | null = null;

/** `test/public/edts.mp4`: 9 s of x264 (854x480, 25 fps, B-frames, a key frame every 1.92 s) and AAC-LC. */
const loadEdtsMedia = () => edtsMediaPromise ??= (async () => {
	using input = new Input({ source: new FilePathSource('./test/public/edts.mp4'), formats: ALL_FORMATS });
	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	if (!videoTrack || !audioTrack) {
		throw new Error('Expected a video and an audio track.');
	}

	return {
		videoPackets: await readPackets(videoTrack),
		videoDecoderConfig: (await videoTrack.getDecoderConfig())!,
		audioPackets: await readPackets(audioTrack),
		audioDecoderConfig: (await audioTrack.getDecoderConfig())!,
	};
})();

export type WrittenSegment = {
	uri: string;
	duration: number;
	bytes: Uint8Array;
};

export type WrittenPlaylist = {
	init: Uint8Array | null;
	segments: WrittenSegment[];
};

/**
 * Segments `edts.mp4` with Mediabunny's HLS writer and returns the media playlist's init section and segments, from
 * which tests assemble playlists in the shape of real streams.
 */
export const segmentEdts = async (options: {
	segmentFormat: OutputFormat;
	video?: boolean;
	audio?: boolean;
	mediaTimestampBase?: number;
}): Promise<WrittenPlaylist> => {
	const media = await loadEdtsMedia();
	const files: MemoryFiles = new Map();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: options.segmentFormat,
			targetDuration: 1.92,
			mediaTimestampBase: options.mediaTimestampBase,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
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
		output.addVideoTrack(videoSource);
	}
	if (audioSource) {
		output.addAudioTrack(audioSource);
	}

	await output.start();

	const videoPackets = videoSource ? media.videoPackets : [];
	const audioPackets = audioSource ? media.audioPackets : [];
	let videoIndex = 0;
	let audioIndex = 0;
	while (videoIndex < videoPackets.length || audioIndex < audioPackets.length) {
		const nextVideo = videoPackets[videoIndex];
		const nextAudio = audioPackets[audioIndex];
		if (nextVideo && (!nextAudio || nextVideo.timestamp <= nextAudio.timestamp)) {
			await videoSource!.add(nextVideo, { decoderConfig: media.videoDecoderConfig });
			videoIndex++;
		} else {
			await audioSource!.add(nextAudio!, { decoderConfig: media.audioDecoderConfig });
			audioIndex++;
		}
	}

	await output.finalize();

	const playlistPath = [...files.keys()].find(path => path.endsWith('.m3u8') && path !== 'master.m3u8');
	if (!playlistPath) {
		throw new Error('No media playlist written.');
	}

	const lines = new TextDecoder().decode(files.get(playlistPath)).split('\n');
	let init: Uint8Array | null = null;
	const segments: WrittenSegment[] = [];
	let duration = 0;
	for (const line of lines) {
		if (line.startsWith('#EXT-X-MAP:URI="')) {
			init = files.get(line.slice(16, line.indexOf('"', 16)))!;
		} else if (line.startsWith('#EXTINF:')) {
			duration = Number(line.slice(8, line.indexOf(',')));
		} else if (line && !line.startsWith('#')) {
			segments.push({ uri: line, duration, bytes: files.get(line)! });
		}
	}

	return { init, segments };
};

/** ADTS frames of `test/public/sample3.aac` (AAC-LC, 44.1 kHz stereo, 1024 samples per frame). */
export const loadAdtsFrames = () => {
	const bytes = fs.readFileSync('./test/public/sample3.aac');
	const frames: Uint8Array[] = [];
	let offset = 0;
	while (offset + 7 <= bytes.length && bytes[offset] === 0xff && (bytes[offset + 1]! & 0xf0) === 0xf0) {
		const length = ((bytes[offset + 3]! & 0x03) << 11) | (bytes[offset + 4]! << 3) | (bytes[offset + 5]! >> 5);
		frames.push(bytes.subarray(offset, offset + length));
		offset += length;
	}

	return frames;
};

/** MPEG audio frames of `test/public/Toothsome-Meme.VBRv2.mp3` (MPEG-2 Layer III, 24 kHz, 576 samples per frame). */
export const loadMp3Frames = async () => {
	using input = new Input({
		source: new FilePathSource('./test/public/Toothsome-Meme.VBRv2.mp3'),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	return (await readPackets(track!)).map(packet => packet.data);
};

/**
 * The ID3v2.4 tag that starts each packed audio segment, carrying the 33-bit MPEG-TS timestamp of the segment's first
 * sample in a PRIV frame owned by "com.apple.streaming.transportStreamTimestamp" (RFC 8216, Section 3.4).
 */
export const createTimestampId3Tag = (seconds: number) => {
	const owner = encodeText('com.apple.streaming.transportStreamTimestamp');
	const frameSize = owner.length + 1 + 8;
	const tag = new Uint8Array(10 + 10 + frameSize);
	const view = new DataView(tag.buffer);
	tag.set(encodeText('ID3'), 0);
	tag[3] = 4; // Version 2.4
	view.setUint32(6, 10 + frameSize); // Synchsafe, but small enough for the plain value to be the same
	tag.set(encodeText('PRIV'), 10);
	view.setUint32(14, frameSize);
	tag.set(owner, 20);
	const pts = Math.round(seconds * 90000) % 2 ** 33;
	view.setUint32(20 + owner.length + 1, Math.floor(pts / 2 ** 32));
	view.setUint32(20 + owner.length + 5, pts % 2 ** 32);

	return tag;
};

/** Encrypts data with AES-128-CBC and PKCS#7 padding, as METHOD=AES-128 prescribes. */
export const encryptAes128 = async (data: Uint8Array, key: Uint8Array, iv: Uint8Array) => {
	const algorithm = { name: 'AES-CBC', iv: new Uint8Array(iv) };
	const cryptoKey = await crypto.subtle.importKey('raw', new Uint8Array(key), algorithm, false, ['encrypt']);
	return new Uint8Array(await crypto.subtle.encrypt(algorithm, cryptoKey, new Uint8Array(data)));
};

export const toHex = (bytes: Uint8Array) => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
