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

test('Reads the format of WAVE_FORMAT_EXTENSIBLE files only from GUIDs that hold a format tag', async () => {
	const u16 = (value: number) => [value & 0xff, value >> 8];
	const u32 = (value: number) => [...u16(value & 0xffff), ...u16(value >>> 16)];
	const fourCc = (text: string) => [...text].map(char => char.charCodeAt(0));

	// A GUID in its binary layout: a first field, then 12 bytes
	const guid = (firstField: number, rest: number[]) => [...u32(firstField), ...rest];
	const KSDATAFORMAT_SUBTYPE = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
	const AMBISONIC_B_FORMAT_SUBTYPE = [0x21, 0x07, 0xd3, 0x11, 0x86, 0x44, 0xc8, 0xc1, 0xca, 0x00, 0x00, 0x00];

	// Reads a 16-bit mono WAVE_FORMAT_EXTENSIBLE file with the given sub-format GUID and two samples
	const read = async (subFormat: number[]) => {
		const fmt = [
			...u16(0xfffe), ...u16(1), ...u32(48000), ...u32(96000), ...u16(2), ...u16(16),
			...u16(22), // cbSize
			...u16(16), // Valid bits per sample
			...u32(4), // Channel mask: front center
			...subFormat,
		];
		const samples = [...u16(0x1234), ...u16(0x10000 - 0x1234)];
		const bytes = new Uint8Array([
			...fourCc('RIFF'), ...u32(4 + 8 + fmt.length + 8 + samples.length), ...fourCc('WAVE'),
			...fourCc('fmt '), ...u32(fmt.length), ...fmt,
			...fourCc('data'), ...u32(samples.length), ...samples,
		]);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		try {
			const track = await input.getPrimaryAudioTrack();
			assert(track);
			const decoded: number[] = [];
			for await (using sample of new AudioSampleSink(track).samples()) {
				const data = new Int16Array(sample.numberOfFrames);
				sample.copyTo(data, { planeIndex: 0, format: 's16' });
				decoded.push(...data);
			}
			return { codec: await track.getCodec(), decoded };
		} catch (error) {
			return (error as Error).message;
		}
	};

	// KSDATAFORMAT_SUBTYPE_PCM, and the same for Ambisonic B-format (like FFmpeg reads it)
	const pcm = { codec: 'pcm-s16', decoded: [0x1234, -0x1234] };
	expect(await read(guid(0x0001, KSDATAFORMAT_SUBTYPE))).toEqual(pcm);
	expect(await read(guid(0x0001, AMBISONIC_B_FORMAT_SUBTYPE))).toEqual(pcm);

	// GUIDs of other formats, whose first two bytes happen to be those of the PCM format tag
	expect(await read(guid(0x10001, KSDATAFORMAT_SUBTYPE))).toEqual(
		expect.stringContaining('Unsupported WAVE codec (format tag 65537)'),
	);
	expect(await read(guid(0x0001, [...KSDATAFORMAT_SUBTYPE.slice(0, -1), 0x72]))).toEqual(
		expect.stringContaining('Unsupported WAVE codec (sub-format GUID {00000001-0000-0010-8000-00aa00389b72})'),
	);
});

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

test('Takes the sizes of large RF64 chunks other than the data chunk from the ds64 table', async () => {
	// An RF64 file whose JUNK chunk in front of the format chunk is too large for a 32-bit size, so its size field is
	// 0xFFFFFFFF and its real size is in the ds64 chunk's table (EBU Tech 3306, Annex A.2). The file only holds bytes
	// at its start and end, so it's read through a custom source that makes up the rest.
	const readRf64 = async (junkSize: number) => {
		const header = new Uint8Array(68);
		const view = new DataView(header.buffer);
		const ascii = (text: string, offset: number) => header.set([...text].map(char => char.charCodeAt(0)), offset);
		const tail = new Uint8Array([
			...[0x66, 0x6d, 0x74, 0x20], 16, 0, 0, 0, // 'fmt ' chunk
			1, 0, 1, 0, 0x80, 0xbb, 0, 0, 0, 0x77, 1, 0, 2, 0, 16, 0, // PCM, mono, 48 kHz, 16-bit
			...[0x64, 0x61, 0x74, 0x61], 0xff, 0xff, 0xff, 0xff, // 'data' chunk, sized in the ds64 chunk
			1, 0, 2, 0,
		]);

		ascii('RF64', 0);
		view.setUint32(4, 0xffffffff, true);
		ascii('WAVEds64', 8);
		view.setUint32(16, 40, true); // ds64 chunk size, with one table entry
		view.setBigUint64(20, BigInt(header.length - 8 + junkSize + tail.length), true); // RIFF size
		view.setBigUint64(28, 4n, true); // Data size
		view.setBigUint64(36, 2n, true); // Sample count
		view.setUint32(44, 1, true); // Table length
		ascii('JUNK', 48);
		view.setBigUint64(52, BigInt(junkSize), true);
		ascii('JUNK', 60);
		view.setUint32(64, Math.min(junkSize, 0xffffffff), true);

		const tailStart = header.length + junkSize;
		const source = new CustomSource({
			getSize: () => tailStart + tail.length,
			read: (start, end) => {
				const result = new Uint8Array(end - start);
				for (const [offset, data] of [[0, header], [tailStart, tail]] as const) {
					const left = Math.max(start, offset);
					const right = Math.min(end, offset + data.length);
					if (right > left) {
						result.set(data.subarray(left - offset, right - offset), left - start);
					}
				}
				return result;
			},
		});

		using input = new Input({ source, formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		if (!track) {
			throw new Error('No audio track found');
		}

		const packet = await new EncodedPacketSink(track).getFirstPacket();
		return { codec: await track.getCodec(), data: packet?.data, duration: await track.computeDuration() };
	};

	const expected = { codec: 'pcm-s16', data: new Uint8Array([1, 0, 2, 0]), duration: 2 / 48000 };
	expect(await readRf64(4)).toEqual(expected);
	expect(await readRf64(2 ** 32 - 2)).toEqual(expected); // Still fits
	expect(await readRf64(2 ** 32 + 4)).toEqual(expected);
});

test('WAV samples at timestamps keep their timing when decoding restarts', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track found');
	}

	const packets: { timestamp: number; duration: number }[] = [];
	for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
		packets.push({ timestamp: packet.timestamp, duration: packet.duration });
	}
	const within = (index: number, fraction: number) => packets[index]!.timestamp + fraction * packets[index]!.duration;

	// Timestamps that skip a packet or go back within one make the sink restart decoding at that packet
	const queries: number[] = [];
	const expected: number[] = [];
	for (let i = 1; i < 100; i += 3) {
		queries.push(within(i, 0.6), within(i + 2, 0.6), within(i + 2, 0.2));
		expected.push(packets[i]!.timestamp, packets[i + 2]!.timestamp, packets[i + 2]!.timestamp);
	}

	let index = 0;
	for await (using sample of new AudioSampleSink(track).samplesAtTimestamps(queries)) {
		expect(sample, `sample at ${queries[index]}`).not.toBe(null);
		expect(sample!.timestamp, `sample at ${queries[index]}`).toBeCloseTo(expected[index]!, 6);
		index++;
	}
	expect(index).toBe(queries.length);
});

test('Finds the WAV packet and sample at each packet\'s own timestamp', async () => {
	// 44.1 kHz with 2048-frame packets, where timestamps like 30720 / 44100 s convert back to a hair below their
	// packet's first frame
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track found');
	}

	const packetSink = new EncodedPacketSink(track);
	const sampleSink = new AudioSampleSink(track);

	let packetCount = 0;
	for await (const packet of packetSink.packets(undefined, undefined, { metadataOnly: true })) {
		const found = await packetSink.getPacket(packet.timestamp, { metadataOnly: true });
		expect(found?.sequenceNumber, `packet at ${packet.timestamp} s`).toBe(packet.sequenceNumber);

		const sample = await sampleSink.getSample(packet.timestamp);
		expect(sample && Math.round(sample.timestamp * 44100), `sample at ${packet.timestamp} s`)
			.toBe(Math.round(packet.timestamp * 44100));
		sample?.close();

		packetCount++;
	}
	expect(packetCount).toBe(208);
});
