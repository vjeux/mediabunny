import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
	ALL_FORMATS,
	BufferSource,
	CustomSource,
	EncodedPacket,
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

test('Last block of a cluster without BlockDuration or DefaultDuration (Opus, PCM)', async () => {
	// As in Chrome's MediaRecorder files: no DefaultDuration, so each cluster's last block has no next block to take
	// its duration from. Opus and PCM packets tell their own duration.

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
	const block = (track: number, relativeTimestamp: number, data: number[]) => element(
		EBMLId.SimpleBlock,
		[0x80 | track, 0, relativeTimestamp, 0x80, ...data],
	);
	const opusHead = [...ascii('OpusHead'), 1, 1, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0];
	const opus20ms = [0xfc, 0xff]; // CELT, 20 ms
	const opus60ms = [0x18, 0xff]; // SILK, 60 ms

	const file = new Uint8Array([
		...element(EBMLId.EBML, element(EBMLId.DocType, ascii('webm'))),
		...element(
			EBMLId.Segment,
			element(
				EBMLId.Tracks,
				element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [1]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, ascii('A_OPUS')),
					element(EBMLId.CodecPrivate, opusHead),
				),
				element(
					EBMLId.TrackEntry,
					element(EBMLId.TrackNumber, [2]),
					element(EBMLId.TrackType, [2]),
					element(EBMLId.CodecID, ascii('A_PCM/INT/LIT')),
					element(EBMLId.Audio, element(EBMLId.BitDepth, [16])), // 8000 Hz mono by default
				),
			),
			element(
				EBMLId.Cluster,
				element(EBMLId.Timestamp, [0]),
				block(1, 0, opus20ms),
				block(1, 20, opus20ms),
				block(2, 0, new Array<number>(80).fill(0)), // 40 samples = 5 ms
				block(2, 5, new Array<number>(80).fill(0)),
			),
			element(EBMLId.Cluster, element(EBMLId.Timestamp, [40]), block(1, 0, opus60ms)),
		),
	]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const [opusTrack, pcmTrack] = await input.getAudioTracks();
	assert(opusTrack && pcmTrack);

	const durations = async (track: typeof opusTrack) => {
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		return packets.map(x => x.duration);
	};

	expect(await durations(opusTrack)).toEqual([0.02, 0.02, 0.06]);
	expect(await durations(pcmTrack)).toEqual([0.005, 0.005]);
	expect(await opusTrack.computeDuration()).toBe(0.1);
});
