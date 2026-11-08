import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	AudioSampleSink,
	BufferSource,
	EncodedPacketSink,
	Input,
	FilePathSource,
	CustomSource,
} from '../../src/index.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Should handle WAV file with oversized ID3 chunk', async () => {
	const filePath = path.join(__dirname, '..', 'public/oversized-id3.wav');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track found');
	}

	const sink = new EncodedPacketSink(track);

	for await (const packet of sink.packets()) {
		void packet;
	}
});

test('Reads RIFX samples as big-endian', async () => {
	const fourCc = (text: string) => [...text].map(char => char.charCodeAt(0));
	const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];

	// RIFX is RIFF with all integers stored big-endian, the samples included
	const samples = [0x1234, -0x1234, 0x0102, -0x7fff];
	const data = samples.flatMap(sample => u16(sample));
	const body = [
		...fourCc('WAVE'),
		...fourCc('fmt '), ...u32(16), ...u16(1), ...u16(2), ...u32(44100), ...u32(44100 * 4), ...u16(4), ...u16(16),
		...fourCc('data'), ...u32(data.length), ...data,
	];

	using input = new Input({
		source: new BufferSource(new Uint8Array([...fourCc('RIFX'), ...u32(body.length), ...body])),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getCodec()).toBe('pcm-s16be');

	const sample = await new AudioSampleSink(track).getSample(0);
	assert(sample);
	const decoded = new Int16Array(sample.numberOfFrames * sample.numberOfChannels);
	sample.copyTo(decoded, { planeIndex: 0, format: 's16' });
	sample.close();

	expect([...decoded]).toEqual(samples);
});

test('samplesAtTimestamps rejects non-iterable timestamps with a TypeError', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav')),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	const sink = new AudioSampleSink(track!);

	for (const timestamps of [null, undefined, 5, 'timestamps', () => [0]]) {
		expect(() => sink.samplesAtTimestamps(timestamps as never)).toThrow(
			new TypeError('Argument must be an iterable or async iterable.'),
		);
	}

	// Any object or function with an iterator is fine, as before
	const iterableFunction = Object.assign(() => {}, { [Symbol.iterator]: () => [0][Symbol.iterator]() });
	const asyncIterableFunction = Object.assign(() => {}, {
		[Symbol.asyncIterator]: async function* () {
			yield 0;
		},
	});
	for (const timestamps of [[0], new Set([0]), iterableFunction, asyncIterableFunction]) {
		const samples: number[] = [];
		for await (const sample of sink.samplesAtTimestamps(timestamps)) {
			samples.push(sample!.timestamp);
			sample!.close();
		}
		expect(samples).toEqual([0]);
	}
});

test('WAVE files past 4 GiB whose sizes are 0xFFFFFFFF are read to the end', async () => {
	// FFmpeg leaves the RIFF and data sizes at 0xFFFFFFFF when they don't fit into 32 bits (and when writing to a
	// pipe). This is 5 GiB of 16-bit stereo at 48 kHz: such a header, then silence.
	const header = new Uint8Array(44);
	const view = new DataView(header.buffer);
	header.set(new TextEncoder().encode('RIFF'), 0);
	view.setUint32(4, 0xffffffff, true);
	header.set(new TextEncoder().encode('WAVEfmt '), 8);
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 2, true); // Channels
	view.setUint32(24, 48000, true); // Sample rate
	view.setUint32(28, 4 * 48000, true); // Bytes per second
	view.setUint16(32, 4, true); // Block align
	view.setUint16(34, 16, true); // Bits per sample
	header.set(new TextEncoder().encode('data'), 36);
	view.setUint32(40, 0xffffffff, true);

	const fileSize = 5 * 2 ** 30;
	using input = new Input({
		source: new CustomSource({
			getSize: () => fileSize,
			read: (start, end) => {
				const bytes = new Uint8Array(end - start);
				if (start < header.length) {
					bytes.set(header.subarray(start, Math.min(end, header.length)));
				}
				return bytes;
			},
		}),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	const duration = (fileSize - header.length) / 4 / 48000; // ~7.8 hours

	expect(await track.getDurationFromMetadata()).toBeCloseTo(duration, 6);
	expect(await input.computeDuration()).toBeCloseTo(duration, 6);

	const lastPacket = (await new EncodedPacketSink(track).getPacket(duration, { metadataOnly: true }))!;
	expect(lastPacket.timestamp + lastPacket.duration).toBeCloseTo(duration, 6);
});

test.each([
	['right after the data chunk', null, 0],
	['after a skipped chunk of 1 MiB', 'JUNK', 2 ** 20],
	['after a skipped chunk of 0xFFFFFFF0 bytes', 'JUNK', 0xfffffff0],
	['after a LIST chunk of 1 MiB', 'LIST', 2 ** 20],
] as const)('WAVE chunk walks stop at zeros %s instead of crawling through them', async (_, chunkId, chunkSize) => {
	// A RIFF chunk of unknown size and 4 bytes of audio, then zeros (after one more chunk), from a source claiming
	// 2 TiB like a server stating a huge size. The zeros used to be walked as empty chunks, 8 bytes at a time, up to
	// the stated RIFF size (4 GiB) or, for a RIFF size of 0xFFFFFFFF, the stated file size.
	const header = new Uint8Array(64);
	const view = new DataView(header.buffer);
	header.set(new TextEncoder().encode('RIFF'), 0);
	view.setUint32(4, 0xffffffff, true);
	header.set(new TextEncoder().encode('WAVEfmt '), 8);
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 2, true); // Channels
	view.setUint32(24, 44100, true); // Sample rate
	view.setUint32(28, 4 * 44100, true); // Bytes per second
	view.setUint16(32, 4, true); // Block align
	view.setUint16(34, 16, true); // Bits per sample
	header.set(new TextEncoder().encode('data'), 36);
	view.setUint32(40, 4, true);
	if (chunkId) {
		header.set(new TextEncoder().encode(chunkId), 48);
		view.setUint32(52, chunkSize, true);
	}

	let reads = 0;
	using input = new Input({
		source: new CustomSource({
			getSize: () => 2 ** 41,
			read: (start, end) => {
				if (++reads > 1000) {
					throw new Error('Too many reads');
				}

				const bytes = new Uint8Array(end - start);
				if (start < header.length) {
					bytes.set(header.subarray(start, Math.min(end, header.length)));
				}
				return bytes;
			},
		}),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getDurationFromMetadata()).toBe(1 / 44100);
	expect(await input.getMetadataTags()).toEqual({});
	expect(reads).toBeLessThan(10);
});

test('WAVE chunk walks step over zeros between chunks before the data chunk', async () => {
	// A fmt chunk, 16 zero bytes, then one second of 16-bit stereo at 8 kHz. FFmpeg finds the data chunk too.
	const bytes = new Uint8Array(12 + 24 + 16 + 8 + 32000);
	const view = new DataView(bytes.buffer);
	bytes.set(new TextEncoder().encode('RIFF'), 0);
	view.setUint32(4, bytes.length - 8, true);
	bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 2, true); // Channels
	view.setUint32(24, 8000, true); // Sample rate
	view.setUint32(28, 4 * 8000, true); // Bytes per second
	view.setUint16(32, 4, true); // Block align
	view.setUint16(34, 16, true); // Bits per sample
	bytes.set(new TextEncoder().encode('data'), 52);
	view.setUint32(56, 32000, true);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	expect(await input.computeDuration()).toBe(1);

	let audioBytes = 0;
	for await (const packet of new EncodedPacketSink((await input.getPrimaryAudioTrack())!).packets()) {
		audioBytes += packet.byteLength;
	}
	expect(audioBytes).toBe(32000);
});
