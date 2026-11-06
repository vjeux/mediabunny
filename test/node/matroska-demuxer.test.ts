import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
	ALL_FORMATS,
	BufferSource,
	CustomSource,
	EncodedPacketSink,
	FilePathSource,
	Input,
} from '../../src/index.js';
import { assert } from '../../src/misc.js';
import { EBMLId } from '../../src/matroska/ebml.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Zero-width unsigned integers', async () => {
	const filePath = path.join(__dirname, '..', 'public/zero-width-uint.webm');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	expect(await input.getTracks()).toHaveLength(1);
});

test('Zero timestamp scale', async () => {
	const filePath = path.join(__dirname, '..', 'public/zero-timestamp-scale.webm');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	await expect(input.getTracks()).rejects.toThrow(/TimestampScale/);
});

test('Concurrent metadata tag reads', async () => {
	const filePath = path.join(__dirname, '..', 'public/tags-after-clusters.webm');
	const buffer = await fs.promises.readFile(filePath);

	// Async reads, so that both calls are in the middle of loading the tags at the same time
	using input = new Input({
		source: new CustomSource({
			getSize: async () => buffer.byteLength,
			read: async (start, end) => buffer.subarray(start, end),
		}),
		formats: ALL_FORMATS,
	});

	const [first, second] = await Promise.all([input.getMetadataTags(), input.getMetadataTags()]);
	expect(first.title).toBe('Hi');
	expect(second.title).toBe('Hi');
});

test('Key packet lookup past position cache entries', async () => {
	// 0.5 s clusters with a key frame (and cue point) only every 10 s
	const filePath = path.join(__dirname, '..', 'public/sparse-keyframes-dense-clusters.mkv');
	const buffer = await fs.promises.readFile(filePath);

	let bytesRead = 0;
	using input = new Input({
		source: new CustomSource({
			getSize: () => buffer.byteLength,
			read: (start, end) => {
				bytesRead += end - start;
				return buffer.subarray(start, end);
			},
			maxCacheSize: Infinity,
		}),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	// Leaves the position cache with an entry at the start and dense entries from the cue point at 50 s up to 55.3 s
	await sink.getFirstPacket();
	await sink.getPacket(55.3);

	bytesRead = 0;
	const keyPacket = await sink.getKeyPacket(55.29);
	expect(keyPacket?.timestamp).toBe(50);
	expect(bytesRead).toBeLessThan(0.05 * buffer.byteLength);
});

test('An invalid SamplingFrequency or Channels value only affects its own track', async () => {
	// Like samples.ffmpeg.org's matroska+h264+ac3+dvdsub+NoDuration.mkv, whose AC-3 track has a SamplingFrequency of
	// 0.0. The values are ignored like missing elements (8000 Hz, mono by default) instead of failing the whole file.
	const element = (id: number, ...parts: number[][]) => {
		const data = parts.flat();
		const idBytes: number[] = [];
		for (let value = id; value > 0; value = Math.floor(value / 256)) {
			idBytes.unshift(value & 0xff);
		}

		const size = [0x10, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]; // 4-byte VINT
		return [...idBytes, ...size, ...data];
	};

	const ascii = (text: string) => [...text].map(x => x.charCodeAt(0));
	const audioTrack = (trackNumber: number, audio: number[]) => element(
		EBMLId.TrackEntry,
		element(EBMLId.TrackNumber, [trackNumber]),
		element(EBMLId.TrackType, [2]),
		element(EBMLId.CodecID, ascii('A_AC3')),
		element(EBMLId.Audio, audio),
	);

	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('matroska'))),
		...element(
			EBMLId.Segment,
			element(
				EBMLId.Tracks,
				element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [1]),
					element(EBMLId.CodecID, ascii('V_VP8')),
					element(EBMLId.Video, element(EBMLId.PixelWidth, [16]), element(EBMLId.PixelHeight, [16])),
				),
				audioTrack(2, [
					...element(EBMLId.SamplingFrequency, [0, 0, 0, 0]), // 0.0 as a 4-byte float
					...element(EBMLId.Channels, [2]),
				]),
				audioTrack(3, [
					...element(EBMLId.SamplingFrequency, [0x47, 0x3b, 0x80, 0]), // 48000
					...element(EBMLId.Channels, [0]),
				]),
			),
			element(
				EBMLId.Cluster,
				element(EBMLId.Timestamp, [0]),
				element(EBMLId.SimpleBlock, [0x81, 0, 0, 0x80, 1]),
				element(EBMLId.SimpleBlock, [0x82, 0, 0, 0x80, 2]),
				element(EBMLId.SimpleBlock, [0x83, 0, 0, 0x80, 3]),
			),
		),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks.map(x => x.type)).toEqual(['video', 'audio', 'audio']);

	const [zeroRate, zeroChannels] = await input.getAudioTracks();
	assert(zeroRate && zeroChannels);
	expect([await zeroRate.getSampleRate(), await zeroRate.getNumberOfChannels()]).toEqual([8000, 2]);
	expect([await zeroChannels.getSampleRate(), await zeroChannels.getNumberOfChannels()]).toEqual([48000, 1]);
	expect((await new EncodedPacketSink(zeroRate).getFirstPacket())?.data).toEqual(new Uint8Array([2]));
});
