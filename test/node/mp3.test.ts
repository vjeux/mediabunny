import { expect, test } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, ReadableStreamSource, UrlSource, CustomSource } from '../../src/source.js';
import { ALL_FORMATS, MP3 } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';
import { Logging, LogLevel } from '../../src/logging.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Does not read tags between or after MP3 frames as frames', async () => {
	// Silent MPEG-1 Layer III frames, 128 kbps at 44.1 kHz
	const frames = (count: number) => {
		const bytes = new Uint8Array(count * 417);
		for (let i = 0; i < count; i++) {
			bytes.set([0xff, 0xfb, 0x90, 0x00], i * 417);
		}
		return bytes;
	};

	// An ID3v2.3 tag with cover art that happens to contain something that looks like a frame
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const u32le = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
	const apic = [0, ...ascii('image/jpeg'), 0, 3, 0, ...frames(1)];
	const frame = [...ascii('APIC'), 0, 0, apic.length >> 8, apic.length & 0xff, 0, 0, ...apic];
	const tag = [...ascii('ID3'), 3, 0, 0, 0, 0, frame.length >> 7, frame.length & 0x7f, ...frame];

	const readTimestamps = async (bytes: Uint8Array) => {
		using input = new Input({
			source: new BufferSource(bytes),
			formats: ALL_FORMATS,
		});

		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);

		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
			timestamps.push(packet.timestamp);
		}
		return timestamps;
	};

	const expectedTimestamps = (count: number) => Array.from({ length: count }, (_, i) => i * 1152 / 44100);

	// Two concatenated files, the second one with a tag
	expect(await readTimestamps(new Uint8Array([...frames(5), ...tag, ...frames(5)]))).toEqual(expectedTimestamps(10));
	// A tag at the end of the file
	expect(await readTimestamps(new Uint8Array([...frames(5), ...tag]))).toEqual(expectedTimestamps(5));

	// An APEv2 tag (with header and footer) holding the same picture as a binary item, followed by an ID3v1 tag
	const apeItem = [...u32le(apic.length), ...u32le(2), ...ascii('Cover Art (Front)'), 0, ...apic];
	const apeHeaderOrFooter = (isHeader: boolean) => [
		...ascii('APETAGEX'),
		...u32le(2000), // Version
		...u32le(apeItem.length + 32), // Tag size, including the footer
		...u32le(1), // Item count
		...u32le((1 << 31) | (isHeader ? 1 << 29 : 0)), // Flags: has a header, is the header
		0, 0, 0, 0, 0, 0, 0, 0,
	];
	const apeTag = [...apeHeaderOrFooter(true), ...apeItem, ...apeHeaderOrFooter(false)];
	const id3V1Tag = [...ascii('TAG'), ...new Array<number>(125).fill(0)];
	expect(await readTimestamps(new Uint8Array([...frames(5), ...apeTag, ...id3V1Tag]))).toEqual(expectedTimestamps(5));
});

test('An MP3 larger than the cache reads from a server that ignores range requests', async () => {
	const plain = new Uint8Array(fs.readFileSync(path.join(__dirname, '../public/Toothsome-Meme.VBRv2.mp3'))); // 389 kB
	// Junk behind the last frame, like the 0xdeadbeef padding of ExoPlayer's trailing-garbage test files. The search
	// for the next frame runs through all of it, so what lies right behind the last frame must be looked at first.
	const garbage = new Uint8Array(2 ** 18).map((_, i) => [0xde, 0xad, 0xbe, 0xef][i % 4]!);
	// Damaged audio, with a frame between two short gaps every 50 frames, so that no frame follows it directly. More
	// audio follows it, though, so it doesn't call for looking at the end of the file, which would stream it first.
	const frame = new Uint8Array(417);
	frame.set([0xff, 0xfb, 0x90, 0x00]); // MPEG-1 Layer III, 128 kbps, 44.1 kHz
	const damaged = Array.from({ length: 3000 }, (_, i) => i % 50 === 25
		? [...new Uint8Array(2), ...frame, ...new Uint8Array(416)]
		: [...frame]).flat();

	let data = plain;
	// Like Python's http.server: always the whole file, with its Content-Length
	const server = http.createServer((req, res) => {
		res.on('error', () => {});
		res.writeHead(200, { 'Content-Length': data.length }).end(data);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/podcast.mp3`;
	const previousLevel = Logging.level;
	Logging.level = LogLevel.Silent; // UrlSource warns about the missing range support

	try {
		for (const file of [plain, new Uint8Array([...plain, ...garbage]), new Uint8Array(damaged)]) {
			data = file;
			using reference = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
			const referenceTrack = await reference.getPrimaryAudioTrack();
			assert(referenceTrack);

			// A 64 KiB cache stands in for the default 64 MiB one with an MP3 over 64 MiB (a long podcast, an
			// audiobook). Looking for tags at the end of the file before reading the frames would stream the whole
			// file first, and the start would be gone by the time the frames are read.
			using input = new Input({ source: new UrlSource(url, { maxCacheSize: 2 ** 16 }), formats: ALL_FORMATS });
			const track = await input.getPrimaryAudioTrack();
			assert(track);

			let packetCount = 0;
			for await (const packet of new EncodedPacketSink(track).packets()) {
				void packet;
				packetCount++;
			}
			expect(packetCount).toBe((await referenceTrack.computePacketStats()).packetCount);

			using durationInput = new Input({
				source: new UrlSource(url, { maxCacheSize: 2 ** 16 }),
				formats: ALL_FORMATS,
			});
			expect(await durationInput.computeDuration()).toBe(await referenceTrack.computeDuration());
		}
	} finally {
		Logging.level = previousLevel;
		server.close();
	}
});

test('An MP3 streamed with its last frame cut off counts only its complete frames', async () => {
	// 400 frames (MPEG-1 Layer III, 128 kbps, 44.1 kHz), the last one 100 bytes short. Its header shows before the end
	// of a source of unknown size does, so only reading all of the frame tells that it's cut off.
	const bytes = new Uint8Array(400 * 417 - 100);
	for (let i = 0; i < 400; i++) {
		bytes.set([0xff, 0xfb, 0x90, 0x04], i * 417);
	}
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let offset = 0; offset < bytes.length; offset += 4096) {
				controller.enqueue(bytes.slice(offset, offset + 4096));
			}
			controller.close();
		},
	});

	using input = new Input({ source: new ReadableStreamSource(stream), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.computeDuration()).toBe(399 * 1152 / 44100);
});

test('Reading MP3 frames only requests a small slice per frame header', async () => {
	// 2000 CBR frames: MPEG-1 Layer III, 128 kbps, 44.1 kHz, 417 bytes each
	const frameSize = 417;
	const frameCount = 2000;
	const file = new Uint8Array(frameSize * frameCount);
	for (let i = 0; i < frameCount; i++) {
		file.set([0xff, 0xfb, 0x90, 0x00], i * frameSize);
	}

	// Without a cache or prefetching, every slice the demuxer requests becomes a read
	let requestedBytes = 0;
	using input = new Input({
		source: new CustomSource({
			getSize: () => file.length,
			read: (start, end) => {
				requestedBytes += end - start;
				return file.subarray(start, end);
			},
			maxCacheSize: 0,
		}),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	expect(track).not.toBeNull();

	let packetCount = 0;
	for await (const packet of new EncodedPacketSink(track!).packets()) {
		expect(packet.data.byteLength).toBe(frameSize);
		packetCount++;
	}
	expect(packetCount).toBe(frameCount);

	// Each frame header lookup used to request 64 KiB, which sources backed by a cache assemble by copying
	expect(requestedBytes).toBeLessThan(3 * file.length);
});

test('MP3 from an unsized source ignores a last frame cut off by the end of the stream', async () => {
	// MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo: 417-byte frames, payloads zeroed
	const frameCount = 400;
	const frameLength = 417;
	const bytes = new Uint8Array(frameCount * frameLength - 100); // The last frame lacks 100 bytes
	for (let i = 0; i < frameCount; i++) {
		bytes.set([0xff, 0xfb, 0x90, 0x04], i * frameLength);
	}

	const createInput = () => new Input({
		source: new ReadableStreamSource(new ReadableStream({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 4096) {
					controller.enqueue(bytes.slice(i, i + 4096));
				}
				controller.close();
			},
		})),
		formats: [MP3],
	});

	const completeFrameCount = frameCount - 1;

	using durationInput = createInput();
	const durationTrack = await durationInput.getPrimaryAudioTrack();
	expect(await durationTrack!.computeDuration()).toBeCloseTo(completeFrameCount * 1152 / 44100, 6);

	using packetInput = createInput();
	const packetTrack = await packetInput.getPrimaryAudioTrack();
	const lastPacket = await new EncodedPacketSink(packetTrack!).getPacket(Infinity);
	expect(lastPacket?.timestamp).toBeCloseTo((completeFrameCount - 1) * 1152 / 44100, 6);
});
