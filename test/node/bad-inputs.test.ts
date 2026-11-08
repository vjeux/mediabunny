import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
	ALL_FORMATS,
	AudioSampleSink,
	BufferSource,
	CustomPathedSource,
	CustomSource,
	EncodedPacket,
	EncodedPacketSink,
	Input,
	ReadableStreamSource,
	Source,
} from '../../src/index.js';
import { EBMLId } from '../../src/matroska/ebml.js';

// Each test tests a malicious or malformed ("bad") file that once made the code hang, exhaust memory, burn CPU for way
// too long, or fail in an unintended way (a failed assertion or an implicit error). The tests make sure the files
// are now handled quickly and that any errors thrown are deliberate ones.

// Errors that point to a bug rather than a deliberate rejection of the input
const UNINTENDED_ERROR = new RegExp([
	'Assertion failed',
	'likely an internal error',
	'Maximum call stack',
	'Cannot read prop',
	'is not a function',
	'is outside the bounds',
	'out of bounds',
	'Invalid array length',
	'Invalid typed array length',
	'Invalid array buffer length',
	'Invalid AudioDataInit',
	'Invalid string length',
	'must be a number',
	'must be a non-negative',
	'Slicing outside',
	'URI malformed',
	'Invalid character',
	'allocation failed',
].join('|'));

const IDENTITY_MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

const AAC_STREAM = [{ type: 0x0f, pid: 0x100 }];
const AVC_STREAM = [{ type: 0x1b, pid: 0x100 }];
const START_CODE = [0, 0, 0, 1];

const OGG_CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let crc = n << 24;
	for (let k = 0; k < 8; k++) {
		crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) : (crc << 1);
	}
	return crc >>> 0;
});

const OPUS_PACKET = [0xf8, 0xff, 0xfe]; // 20 ms of CELT

test('MP4: stts entry claiming billions of samples', async () => {
	// The entry count used to be expanded into one presentation timestamp per sample
	await expectGracefulRead(mp4([trak({
		handler: 'vide',
		stbl: [
			stsd(videoSampleEntry()),
			stts([[0xffffffff, 1]]),
			ctts([[1, 0]]),
			stsc([[1, 1, 1]]),
			stsz([4]),
			stco([0]),
		],
	})]));
});

test('MP4: ctts entries claiming billions of samples', async () => {
	await expectGracefulRead(mp4([trak({
		handler: 'vide',
		stbl: [
			stsd(videoSampleEntry()),
			stts([[1, 1]]),
			ctts(Array.from({ length: 8 }, () => [0xffffffff, 0])),
			stsc([[1, 1, 1]]),
			stsz([4]),
			stco([0]),
		],
	})]));
});

test('MP4: stts entry claiming more samples than stsz has', async () => {
	// Iterating used to go on for billions of samples that don't exist
	using input = new Input({
		source: new BufferSource(mp4([trak({
			handler: 'vide',
			stbl: [stsd(videoSampleEntry()), stts([[0xffffffff, 1]]), stsc([[1, 2, 1]]), stsz([4, 4]), stco([0])],
		})])),
		formats: ALL_FORMATS,
	});

	expect(await countPackets(input)).toBe(2);
});

test('MP4: Constant sample size with billions of samples', async () => {
	await expectGracefulRead(mp4([trak({
		handler: 'vide',
		stbl: [
			stsd(videoSampleEntry()),
			stts([[0xffffffff, 1]]),
			ctts([[1, 0]]),
			stsc([[1, 1, 1]]),
			fullBox('stsz', 0, 0, u32(1), u32(0xffffffff)),
			stco([0]),
		],
	})]));
});

test('MP4: ctts with fewer timed samples than stsz', async () => {
	// Samples without timing used to end up in the presentation order
	await expectGracefulRead(mp4([trak({
		handler: 'vide',
		stbl: [stsd(videoSampleEntry()), stts([[1, 1]]), ctts([[1, 0]]), stsc([[1, 3, 1]]), stsz([4, 4, 4]), stco([0])],
	})]));
});

test('MP4: Streamed constant sample size with billions of samples', async () => {
	// Without a file size, every claimed sample used to be unrolled
	const file = mp4([trak({
		handler: 'vide',
		stbl: [
			stsd(videoSampleEntry()),
			stts([[0xffffffff, 1]]),
			ctts([[1, 0]]),
			stsc([[1, 1, 1]]),
			fullBox('stsz', 0, 0, u32(1), u32(0xffffffff)),
			stco([0]),
		],
	})]);

	await expectGracefulRead(streamedSource(file));
});

test('MP4: stz2 with zero field size', async () => {
	await expectGracefulRead(mp4([trak({
		handler: 'vide',
		stbl: [
			stsd(videoSampleEntry()),
			stts([[1, 1]]),
			stsc([[1, 1, 1]]),
			fullBox('stz2', 0, 0, zeros(3), u8(0), u32(0xffffffff)),
			stco([0]),
		],
	})]), /stz2/);
});

test('MP4: PCM track with huge stsc first chunk', async () => {
	await expectGracefulRead(mp4([trak({
		handler: 'soun',
		stbl: [
			stsd(audioSampleEntry('sowt')),
			stts([[100, 1]]),
			stsc([[1, 1, 1], [0xffffffff, 1, 1]]),
			fullBox('stsz', 0, 0, u32(4), u32(100)),
			stco([0]),
		],
	})]));
});

test('MP4: PCM track with zero channels', async () => {
	// Decoding it used to create audio samples with 0 channels
	const channelCount = 0;
	const sampleEntry = box('sowt', zeros(6), u16(1), zeros(8), u16(channelCount), u16(16), zeros(4), u32(48000 << 16));
	await expectGracefulDecode(mp4([trak({
		handler: 'soun',
		stbl: [stsd(sampleEntry), stts([[4, 1]]), stsc([[1, 4, 1]]), fullBox('stsz', 0, 0, u32(2), u32(4)), stco([0])],
	})]));
});

test('MP4: stsc with huge samples per chunk', async () => {
	await expectGracefulRead(mp4([trak({
		handler: 'vide',
		stbl: [stsd(videoSampleEntry()), stts([[2, 1]]), stsc([[1, 0xffffffff, 1]]), stsz([4, 4]), stco([0])],
	})]));
});

test('MP4: stsc with alternating chunk indices', async () => {
	// Non-increasing entries used to make the PCM chunk expansion quadratic
	const entries: [number, number, number][] = [];
	for (let i = 0; i < 20_000; i++) {
		entries.push([i % 2 === 0 ? 1 : 20_000, 1, 1]);
	}

	await expectGracefulRead(mp4([trak({
		handler: 'soun',
		stbl: [
			stsd(audioSampleEntry('sowt')),
			stts([[20_000, 1]]),
			stsc(entries),
			fullBox('stsz', 0, 0, u32(4), u32(20_000)),
			stco(Array<number>(20_000).fill(0)),
		],
	})]));
});

test('MP4: stsc entry starting at chunk 0', async () => {
	// The first chunk became chunk -1, whose offset doesn't exist, so the packets came out without their data
	const stbl = (dataOffset: number) => [
		stsd(videoSampleEntry()), stts([[2, 1]]), stsc([[0, 2, 1]]), stsz([4, 4]), stco([dataOffset]),
	];
	const header = mp4([trak({ handler: 'vide', stbl: stbl(0) })]);
	const file = mp4(
		[trak({ handler: 'vide', stbl: stbl(header.length + 8) })],
		[box('mdat', [1, 2, 3, 4, 5, 6, 7, 8])],
	);

	expect(await packetData(file)).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);

	// A whole table numbered from 0: chunks of 1, 2 and 2 samples
	const zeroBasedStbl = (dataOffset: number) => [
		stsd(videoSampleEntry()),
		stts([[5, 1]]),
		stsc([[0, 1, 1], [1, 2, 1]]),
		stsz([4, 4, 4, 4, 4]),
		stco([dataOffset, dataOffset + 4, dataOffset + 12]),
	];
	const zeroBasedHeader = mp4([trak({ handler: 'vide', stbl: zeroBasedStbl(0) })]);
	const zeroBasedFile = mp4(
		[trak({ handler: 'vide', stbl: zeroBasedStbl(zeroBasedHeader.length + 8) })],
		[box('mdat', Array.from({ length: 20 }, (_, i) => i + 1))],
	);
	expect(await packetData(zeroBasedFile)).toEqual([
		[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20],
	]);
});

const packetData = async (file: Uint8Array) => {
	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const sink = new EncodedPacketSink((await input.getTracks())[0]!);
	const data: number[][] = [];
	for await (const packet of sink.packets()) {
		data.push([...packet.data]);
	}
	return data;
};

test('MP4: Single chunk with many samples', async () => {
	// Computing a sample's offset in its chunk used to be linear, making iteration quadratic
	const sampleCount = 100_000;
	const header = mp4([trak({ handler: 'vide', stbl: singleChunkStbl(sampleCount, 0) })]);
	const file = mp4(
		[trak({ handler: 'vide', stbl: singleChunkStbl(sampleCount, header.length + 8) })],
		[box('mdat', zeros(4 * sampleCount))],
	);

	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const track = (await input.getVideoTracks())[0]!;

	let count = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		expect(packet.byteLength).toBe(4);
		count++;
	}

	expect(count).toBe(sampleCount);
});

test('MP4: keys box with zero key size', async () => {
	// A zero key size used to move the read position backwards, making no progress
	await expectGracefulRead(mp4([
		trak({ handler: 'vide', stbl: singleChunkStbl(1, 0) }),
		fullBox('meta', 0, 0,
			box('hdlr', u32(0), u32(0), ascii('mdta'), zeros(12)),
			fullBox('keys', 0, 0, u32(0xffffffff), u32(0), u32(0)),
		),
	]), /keys/);
});

test('MP4: tfra with many duplicate timestamps', async () => {
	const entries: number[] = [];
	for (let i = 0; i < 300_000; i++) {
		entries.push(...u32(0), ...u32(0), 0, 0, 0);
	}

	await expectGracefulRead(mp4(
		fragmentedMoov(),
		[mfra(fullBox('tfra', 0, 0, u32(1), u32(0), u32(300_000), entries))],
	));
});

test('MP4: Many tfra boxes', async () => {
	const tfras: Uint8Array[] = [];
	for (let i = 0; i < 40_000; i++) {
		tfras.push(fullBox('tfra', 0, 0, u32(1), u32(0), u32(1), u32(i), u32(0), [0, 0, 0]));
	}

	await expectGracefulRead(mp4(fragmentedMoov(), [mfra(...tfras)]));
});

test('MP4: tfra entries pointing nowhere', async () => {
	// Every faulty entry used to trigger another scan of the file, starting at the entry before it
	const entryCount = 3000;
	const head = mp4(fragmentedMoov());
	const entries: number[] = [];
	for (let i = 0; i < entryCount; i++) {
		entries.push(...u32(i), ...u32(head.length), 0, 0, 0);
	}

	await expectGracefulRead(concat(
		head,
		...Array.from({ length: 3000 }, () => box('free')),
		mfra(fullBox('tfra', 0, 0, u32(1), u32(0), u32(entryCount), entries)),
	));
});

test('MP4: trun claiming billions of samples', async () => {
	await expectGracefulRead(mp4(fragmentedMoov(), [
		moof(
			fullBox('tfhd', 0, 0x020000, u32(1)),
			fullBox('tfdt', 0, 0, u32(0)),
			fullBox('trun', 0, 0, u32(0xffffffff)),
		),
		box('mdat', zeros(16)),
	]));
});

test('MP4: Streamed trun claiming billions of samples', async () => {
	// Without a file size, every claimed sample used to be created
	const file = mp4(fragmentedMoov(), [
		moof(
			fullBox('tfhd', 0, 0x020000, u32(1)),
			fullBox('tfdt', 0, 0, u32(0)),
			fullBox('trun', 0, 0, u32(0xffffffff)),
		),
		box('mdat', zeros(16)),
	]);

	await expectGracefulRead(streamedSource(file), /Too many \(> 2\^20\) samples in fragment/);
});

test('MP4: Streamed truns adding up to billions of samples', async () => {
	const file = mp4(fragmentedMoov(), [
		moof(
			fullBox('tfhd', 0, 0x020000, u32(1)),
			fullBox('tfdt', 0, 0, u32(0)),
			...Array.from({ length: 4096 }, () => fullBox('trun', 0, 0, u32(2 ** 20))),
		),
		box('mdat', zeros(16)),
	]);

	await expectGracefulRead(streamedSource(file), /Too many \(> 2\^20\) samples in fragment/);
});

test('MP4: Streamed with a sample-to-chunk entry starting at chunk 0', async () => {
	// The first chunk index became -1 and the sample offsets NaN; reading at NaN from a source without a size waited
	// forever
	await expectGracefulRead(streamedSource(mp4([trak({
		handler: 'vide',
		stbl: [stsd(videoSampleEntry()), stts([[2, 1]]), stsc([[0, 2, 1]]), stsz([4, 4]), stco([0])],
	})])));
});

test('MP4: Streamed with a 64-bit box size beyond 2^53', async () => {
	// The next box's position lost precision, so reading there became a zero-length read that slipped past the bounds
	// checks and failed in a DataView
	await expectGracefulRead(streamedSource(concat(u32(1), ascii('styp'), u64(2 ** 62), ascii('isom'), zeros(12))));
});

test('MP4: trun without default sample values', async () => {
	await expectGracefulRead(mp4(fragmentedMoov({ trex: false }), [
		moof(fullBox('tfhd', 0, 0x020000, u32(1)), fullBox('trun', 0, 0, u32(1))),
		box('mdat', zeros(16)),
	]), /trun/);
});

test('MP4: Fragment with more samples than its moof has bytes', async () => {
	// Sequence numbers counted up from the moof's offset, so the zero-size samples of the first fragment got higher
	// sequence numbers than the samples of the next one, in breach of decode order
	const zeroSizeSamples = moof(
		fullBox('tfhd', 0, 0x020018, u32(1), u32(1), u32(0)), // Default duration 1, default size 0
		fullBox('trun', 0, 0, u32(1000)),
	);
	const file = mp4(fragmentedMoov(), [
		zeroSizeSamples,
		moof(fullBox('tfhd', 0, 0x020000, u32(1)), fullBox('tfdt', 0, 0, u32(1000)), fullBox('trun', 0, 0, u32(3))),
		box('mdat', zeros(12)),
	]);

	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const sink = new EncodedPacketSink((await input.getTracks())[0]!);
	const sequenceNumbers: number[] = [];
	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		sequenceNumbers.push(packet.sequenceNumber);
	}

	expect(sequenceNumbers).toHaveLength(1003);
	expect(sequenceNumbers.every((x, i) => i === 0 || x > sequenceNumbers[i - 1]!)).toBe(true);
});

test('MP4: Fragments with decreasing timestamps', async () => {
	// Caching their positions used to insert at the front over and over
	const fragmentCount = 100_000;
	const moofs: Uint8Array[] = [];
	for (let i = 0; i < fragmentCount; i++) {
		moofs.push(moof(
			fullBox('tfhd', 0, 0x020000, u32(1)),
			fullBox('tfdt', 0, 0, u32(fragmentCount - i)),
			fullBox('trun', 0, 0, u32(1)),
		));
	}

	using input = new Input({ source: new BufferSource(mp4(fragmentedMoov(), moofs)), formats: ALL_FORMATS });

	expect(await countPackets(input)).toBe(fragmentCount);
});

test('MP4: Many tracks and trafs of an unknown track', async () => {
	// Looking up the unknown track used to search through all tracks for every single traf
	const traks = Array.from({ length: 10_000 }, (_, i) => trak({ id: i + 1, handler: 'vide', stbl: emptyStbl() }));
	const unknownTrafs = Array.from({ length: 100_000 }, () => box('traf', fullBox('tfhd', 0, 0x020000, u32(99_999))));
	const fragment = box(
		'moof',
		box('traf', fullBox('tfhd', 0, 0x020000, u32(1)), fullBox('tfdt', 0, 0, u32(0)), fullBox('trun', 0, 0, u32(1))),
		concatList(unknownTrafs),
	);

	using input = new Input({
		source: new BufferSource(mp4([concatList(traks), box('mvex', trex(1))], [fragment, box('mdat', zeros(4))])),
		formats: ALL_FORMATS,
	});
	const track = (await input.getVideoTracks())[0]!;

	expect(await new EncodedPacketSink(track).getFirstPacket()).not.toBeNull();
});

test('MP4: Many tracks without any fragments', async () => {
	// Looking up each empty track used to scan through all fragments again
	const trackCount = 2000;
	const traks: Uint8Array[] = [];
	const trexs: Uint8Array[] = [];
	for (let i = 1; i <= trackCount; i++) {
		traks.push(trak({ id: i, handler: 'vide', stbl: emptyStbl() }));
		trexs.push(fullBox('trex', 0, 0, u32(i), u32(1), u32(1), u32(4), u32(0)));
	}

	const moofs: Uint8Array[] = [];
	for (let i = 0; i < 5000; i++) {
		moofs.push(moof(
			fullBox('tfhd', 0, 0x020000, u32(1)),
			fullBox('tfdt', 0, 0, u32(i)),
			fullBox('trun', 0, 0, u32(1)),
		));
	}

	using input = new Input({
		source: new BufferSource(mp4([...traks, box('mvex', ...trexs)], [...moofs, box('mdat', zeros(4))])),
		formats: ALL_FORMATS,
	});

	expect(await input.computeDuration()).toBe(5);
});

test('MP4: pssh with huge key ID count', async () => {
	await expectGracefulRead(mp4([
		trak({ handler: 'vide', stbl: singleChunkStbl(1, 0) }),
		fullBox('pssh', 1, 0, zeros(16), u32(0xffffffff), u32(0)),
	]), /pssh/);
});

test('MP4: Deeply nested boxes', async () => {
	const depth = 200_000;
	const nested = new Uint8Array(8 * depth + 8);
	const view = new DataView(nested.buffer);
	for (let i = 0; i <= depth; i++) {
		view.setUint32(8 * i, nested.length - 8 * i);
		nested.set(ascii(i === depth ? 'free' : 'mdia'), 8 * i + 4);
	}

	await expectGracefulRead(mp4([box('trak', tkhd(1), nested)]), /nested too deeply/);
});

test('MP4: avcC in a track without handler', async () => {
	await expectGracefulRead(mp4([
		box('trak', tkhd(1), box('avcC', u8(1))),
		trak({ handler: 'vide', stbl: singleChunkStbl(1, 0) }),
	]));
});

test('MP4: colr in an audio track', async () => {
	await expectGracefulRead(mp4([trak({
		handler: 'soun',
		stbl: [
			stsd(audioSampleEntry('mp4a', box('colr', ascii('nclx'), u16(1), u16(1), u16(1), u8(0)))),
			stts([[1, 1]]),
			stsc([[1, 1, 1]]),
			stsz([4]),
			stco([0]),
		],
	})]));
});

test('MP4: dOps in a video track', async () => {
	await expectGracefulRead(mp4([trak({
		handler: 'vide',
		stbl: [
			stsd(videoSampleEntry('avc1', box('dOps', zeros(11)))),
			stts([[1, 1]]),
			stsc([[1, 1, 1]]),
			stsz([4]),
			stco([0]),
		],
	})]));
});

test('MP4: traf outside of moof', async () => {
	await expectGracefulRead(mp4([...fragmentedMoov(), box('traf', fullBox('tfhd', 0, 0, u32(1)))]));
});

test('MP4: tfdt in trak', async () => {
	await expectGracefulRead(mp4([
		trak({ handler: 'vide', stbl: singleChunkStbl(1, 0), extra: [fullBox('tfdt', 0, 0, u32(0))] }),
	]));
});

test('MP4: Sample table boxes in a fragment', async () => {
	// Misplaced sample table boxes changed the track's sample table once it was loaded, leaving it with samples
	// without timing information
	const stsz = fullBox('stsz', 0, 0, u32(4), u32(1000));
	for (const misplaced of [stsz, box('stbl', stsz)]) {
		await expectGracefulRead(mp4(fragmentedMoov(), [
			moof(fullBox('tfhd', 0, 0x020000, u32(1)), fullBox('trun', 0, 0x000200, u32(2), u32(4), u32(4)), misplaced),
			box('mdat', zeros(8)),
		]));
	}
});

test('MP4: Truncated moof', async () => {
	const file = mp4(fragmentedMoov(), [
		moof(fullBox('tfhd', 0, 0x020000, u32(1)), fullBox('trun', 0, 0, u32(1)), zeros(100)),
	]);

	await expectGracefulRead(file.subarray(0, file.length - 50));
});

test('MP4: Nested moof', async () => {
	await expectGracefulRead(mp4(fragmentedMoov(), [
		moof(fullBox('tfhd', 0, 0x020000, u32(1)), fullBox('trun', 0, 0, u32(1)), box('moof')),
		box('mdat', zeros(16)),
	]));
});

test('MP4: trak extending past the end of the moov', async () => {
	// Seen in old QuickTime files (FFmpeg's samples mov/broken-movs/apple_cv.mov): the trak claims more bytes than the
	// moov holds. This used to throw for the whole file; FFmpeg cuts a box down to its parent and reads the track.
	const sampleCount = 3;
	const header = mp4([trak({ handler: 'vide', stbl: singleChunkStbl(sampleCount, 0) })]);
	const file = mp4(
		[trak({ handler: 'vide', stbl: singleChunkStbl(sampleCount, header.length + 8) })],
		[box('mdat', zeros(4 * sampleCount))],
	);
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	const trakPos = indexOfAscii(file, 'trak', 0) - 4;
	view.setUint32(trakPos, view.getUint32(trakPos) + 100);

	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	expect(await countPackets(input)).toBe(sampleCount);
});

test('MP4: Empty boxes', async () => {
	// An empty box used to be read past its end, which threw an internal error for the whole file when it was the
	// last box of its parent (FFmpeg skips boxes that are too small)
	const files: Uint8Array[] = [];

	for (const name of ['stts', 'ctts', 'stss', 'stsz', 'stz2', 'stsc', 'stco', 'co64']) {
		files.push(mp4([trak({ handler: 'vide', stbl: [...singleChunkStbl(1, 0), box(name)] })]));
	}
	files.push(mp4([trak({ handler: 'vide', stbl: singleChunkStbl(1, 0), extra: [box('edts', box('elst'))] })]));

	for (const name of ['colr', 'pasp', 'btrt', 'vpcC']) {
		files.push(mp4([trak({
			handler: 'vide',
			stbl: [stsd(videoSampleEntry('avc1', [box(name)])), ...singleChunkStbl(1, 0).slice(1)],
		})]));
	}
	for (const name of ['esds', 'dOps', 'dfLa', 'dac3', 'dmlp', 'pcmC', 'enda', 'frma', 'btrt']) {
		files.push(mp4([trak({
			handler: 'soun',
			stbl: [stsd(audioSampleEntry('mp4a', box(name))), ...singleChunkStbl(1, 0).slice(1)],
		})]));
	}

	files.push(mp4([trak({ handler: 'vide', stbl: singleChunkStbl(1, 0) }), box('udta', box('©nam'))]));
	files.push(mp4([trak({ handler: 'vide', stbl: singleChunkStbl(1, 0) }), box('udta', box('meta'))]));
	files.push(mp4([trak({ handler: 'vide', stbl: emptyStbl() }), box('mvex', trex(1), box('mehd'))]));
	files.push(mp4([trak({ handler: 'vide', stbl: emptyStbl() }), box('mvex', box('trex'))]));
	files.push(mp4(fragmentedMoov(), [moof(fullBox('tfhd', 0, 0x020000, u32(1)), box('tfdt')), box('mdat', zeros(4))]));
	files.push(mp4(fragmentedMoov(), [moof(fullBox('tfhd', 0, 0x020000, u32(1)), box('trun')), box('mdat', zeros(4))]));

	for (const file of files) {
		await expectGracefulRead(file);
	}
});

test('MP4: nclx colr box without its full range byte', async () => {
	// Real files carry 18-byte nclx boxes (ExoPlayer's sample_18byte_nclx_colr.mp4). The missing byte used to be read
	// past the box, failing the whole file; like FFmpeg, the color description is still read
	const avcC = box('avcC', [1, 0x64, 0x00, 0x1f, 0xff, 0xe0, 0x00]);
	const colr = box('colr', ascii('nclx'), u16(1), u16(1), u16(1));
	const file = mp4([trak({
		handler: 'vide',
		stbl: [stsd(videoSampleEntry('avc1', [avcC, colr])), ...singleChunkStbl(1, 0).slice(1)],
	})]);

	await expectGracefulRead(file);

	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const track = (await input.getVideoTracks())[0]!;
	expect((await track.getDecoderConfig())?.colorSpace).toEqual({
		primaries: 'bt709',
		transfer: 'bt709',
		matrix: 'bt709',
		fullRange: undefined,
	});
});

test('MP4: Broken fragment followed by valid ones', async () => {
	// An error inside one moof used to leave parser state behind that tripped up reading the next ones
	await expectGracefulRead(mp4(fragmentedMoov({ trex: false }), [
		moof(fullBox('tfhd', 0, 0x020000, u32(1)), fullBox('trun', 0, 0, u32(1))),
		moof(fullBox('tfhd', 0, 0x020008 | 0x10 | 0x20, u32(1), u32(1), u32(4), u32(0)), fullBox('trun', 0, 0, u32(1))),
		box('mdat', zeros(16)),
	]));
});

test('MP4: Without stsc', async () => {
	await expectGracefulRead(mp4([trak({
		handler: 'vide',
		stbl: [stsd(videoSampleEntry()), stts([[1, 1]]), stsz([4]), stco([0])],
	})]));
});

test('MP4: Without stbl', async () => {
	await expectGracefulRead(mp4([box('trak',
		tkhd(1),
		box('mdia', mdhd(), hdlr('vide'), box('minf', stsd(videoSampleEntry()))),
	)]));
});

test('MP4: Sample referencing a missing chunk', async () => {
	// The missing chunk offset used to turn into NaN offsets for the samples
	using input = new Input({
		source: new BufferSource(mp4([trak({
			handler: 'vide',
			stbl: [stsd(videoSampleEntry()), stts([[3, 1]]), stsc([[1, 1, 1]]), stsz([4, 4, 4]), stco([0])],
		})])),
		formats: ALL_FORMATS,
	});

	expect(await countPackets(input)).toBe(1);
});

test('MP4: Unsorted stss', async () => {
	// Key frame lookups binary search the sync samples
	const sampleCount = 10;
	const stss = fullBox('stss', 0, 0, u32(5), [1, 9, 2, 3, 4].flatMap(x => u32(x)));
	const header = mp4([trak({ handler: 'vide', stbl: [...singleChunkStbl(sampleCount, 0), stss] })]);
	using input = new Input({
		source: new BufferSource(mp4(
			[trak({ handler: 'vide', stbl: [...singleChunkStbl(sampleCount, header.length + 8), stss] })],
			[box('mdat', zeros(4 * sampleCount))],
		)),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getVideoTracks())[0]!);

	const timestamps: number[] = [];
	let packet = await sink.getFirstKeyPacket();
	while (packet && timestamps.length < 100) {
		timestamps.push(packet.timestamp);
		packet = await sink.getNextKeyPacket(packet);
	}

	expect(timestamps).toEqual([0, 1, 2, 3, 8].map(x => x * 40 / 1000));
});

test('MP4: Zero timescales', async () => {
	await expectGracefulRead(mp4([trak({
		handler: 'vide',
		stbl: singleChunkStbl(1, 0),
		mdhd: mdhd(0),
	})]), /Invalid mdhd box: timescale must not be 0/);
});

test('MP4: Zero movie timescale', async () => {
	// Used to turn every timestamp into NaN
	await expectGracefulRead(concat(
		box('ftyp', ascii('isom'), u32(0), ascii('isom')),
		box('moov', mvhd(0), trak({ handler: 'vide', stbl: singleChunkStbl(1, 0) })),
	), /Invalid mvhd box: timescale must not be 0/);
});

test('MP4: Without mvhd', async () => {
	await expectGracefulRead(concat(
		box('ftyp', ascii('isom'), u32(0), ascii('isom')),
		box('moov', trak({ handler: 'vide', stbl: singleChunkStbl(1, 0) })),
	), /Invalid moov box: missing mvhd box/);
});

test('MP4: Zero video dimensions', async () => {
	await expectGracefulRead(mp4([trak({
		handler: 'vide',
		stbl: [stsd(videoSampleEntry('avc1', [], 0)), stts([[1, 1]]), stsc([[1, 1, 1]]), stsz([4]), stco([0])],
	})]));
});

test('MP4: ftyp with 64-bit size', async () => {
	await expectGracefulRead(concat(
		u32(1), ascii('ftyp'), u64(24), ascii('isom'), u32(0),
		box('moov', mvhd(), trak({ handler: 'vide', stbl: singleChunkStbl(1, 0) })),
	));
});

test('MP4: senc without tenc', async () => {
	const sinf = box('sinf', box('frma', ascii('avc1')), fullBox('schm', 0, 0, ascii('cenc'), u32(0x10000)));

	await expectGracefulRead(mp4([
		trak({ handler: 'vide', stbl: [stsd(videoSampleEntry('encv', sinf)), ...emptyStbl().slice(1)] }),
		box('mvex', trex(1)),
	], [
		moof(
			fullBox('tfhd', 0, 0x020000, u32(1)),
			fullBox('trun', 0, 0, u32(1)),
			fullBox('senc', 0, 0, u32(1), zeros(16)),
		),
		box('mdat', zeros(16)),
	]), /tenc/);
});

test('MP4: Encryption subsamples exceeding the sample', async () => {
	// Huge protected sizes used to make us build hundreds of millions of crypt ranges
	const sinf = box('sinf',
		box('frma', ascii('avc1')),
		fullBox('schm', 0, 0, ascii('cens'), u32(0x10000)),
		box('schi', fullBox('tenc', 1, 0, u8(0), u8(0x10), u8(1), u8(8), zeros(16))),
	);
	const fragment = moof(
		fullBox('tfhd', 0, 0x020000, u32(1)),
		fullBox('trun', 0, 0x000201, u32(1), u32(0), u32(32)),
		fullBox('senc', 0, 0x2, u32(1), zeros(8), u16(1), u16(0), u32(0xfffffff0)),
	);
	const file = mp4([
		trak({ handler: 'vide', stbl: [stsd(videoSampleEntry('encv', sinf)), ...emptyStbl().slice(1)] }),
		box('mvex', trex(1)),
	], [fragment, box('mdat', zeros(32))]);

	// Fix up the trun's data offset so it points into the mdat
	const moofStart = file.length - 8 - 32 - fragment.length;
	const trunDataOffsetPos = indexOfAscii(file, 'trun', moofStart) + 4 + 4 + 4;
	new DataView(file.buffer).setUint32(trunDataOffsetPos, fragment.length + 8);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
		formatOptions: { isobmff: { resolveKeyId: () => new Uint8Array(16) } },
	});
	const track = (await input.getVideoTracks())[0]!;

	await expect(new EncodedPacketSink(track).getFirstPacket()).rejects.toThrow(/subsamples exceed/);
});

test('MP4: Sample auxiliary information larger than its saiz size', async () => {
	// A subsample count that doesn't fit into its entry used to read past the auxiliary information with an internal
	// error. Chromium parses each entry within its saiz size.
	const sinf = box('sinf',
		box('frma', ascii('avc1')),
		fullBox('schm', 0, 0, ascii('cenc'), u32(0x10000)),
		box('schi', fullBox('tenc', 0, 0, u8(0), u8(0), u8(1), u8(8), zeros(16))),
	);
	const stbl = (dataOffset: number) => [
		stsd(videoSampleEntry('encv', sinf)),
		...singleChunkStbl(1, dataOffset).slice(1),
		fullBox('saiz', 0, 0, u8(16), u32(1)),
		fullBox('saio', 0, 0, u32(1), u32(dataOffset + 4)),
	];
	const header = mp4([trak({ handler: 'vide', stbl: stbl(0) })]);
	const auxInfo = [...zeros(8), ...u16(0xffff), ...zeros(6)]; // IV, then far more subsamples than fit

	await expectGracefulRead(
		mp4([trak({ handler: 'vide', stbl: stbl(header.length + 8) })], [box('mdat', zeros(4), auxInfo)]),
		/saiz/,
	);
});

test('MP4: Sample table failing to parse', async () => {
	// A failed parse used to leave a half-built sample table behind, which later calls then tripped over
	const invalidStz2 = fullBox('stz2', 0, 0, zeros(3), u8(3), u32(3)); // 3-bit field size doesn't exist
	using input = new Input({
		source: new BufferSource(mp4([trak({
			handler: 'vide',
			stbl: [stsd(videoSampleEntry()), stts([[3, 1]]), stsc([[1, 3, 1]]), invalidStz2, stco([0])],
		})])),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getVideoTracks())[0]!);

	const firstError = await sink.getFirstPacket().catch((error: unknown) => error);
	const secondError = await sink.getFirstPacket().catch((error: unknown) => error);

	expect(firstError).toBeInstanceOf(Error);
	expect(String(firstError)).toMatch(/stz2/);
	expect(secondError).toEqual(firstError);
});

test('MP4: trun outside of traf', async () => {
	// Only traf boxes clean up track data without samples
	await expectGracefulRead(mp4(fragmentedMoov(), [
		box('moof', fullBox('tfhd', 0, 0x020000, u32(1)), fullBox('trun', 0, 0, u32(0))),
		moof(fullBox('tfhd', 0, 0x020000, u32(1)), fullBox('tfdt', 0, 0, u32(0)), fullBox('trun', 0, 0, u32(1))),
		box('mdat', zeros(16)),
	]));
});

test('MP4: Box fields running past the end of the parent box', async () => {
	// A broken size field (a single flipped byte in real files) made a box's fixed fields run past the end of its
	// parent, which failed the whole file with an internal error. Such a box is now skipped instead.
	const goodTrak = trak({ handler: 'vide', stbl: singleChunkStbl(3, 0), id: 1 });
	const damagedFiles = [
		// Sample entry shorter than its fixed fields
		mp4([goodTrak, trak({ handler: 'vide', stbl: [stsd(box('avc1', zeros(8)))], id: 2 })]),
		// tkhd cut short at the end of its trak
		mp4([goodTrak, box('trak', box('mdia', mdhd(), hdlr('vide')), fullBox('tkhd', 0, 1, u32(0)))]),
		// DecoderSpecificInfo claiming more bytes than its esds holds
		mp4([goodTrak, trak({ handler: 'soun', stbl: [stsd(audioSampleEntry('mp4a', fullBox(
			'esds', 0, 0, u8(0x03), u8(23), u16(1), u8(0), u8(0x04), u8(15), u8(0x40), u8(0x15), zeros(11),
			u8(0x05), u8(100), u8(0x12), u8(0x10),
		)))], id: 2 })]),
	];

	for (const file of damagedFiles) {
		await expectGracefulRead(file);
		expect(await countPackets(new Input({ source: new BufferSource(file), formats: ALL_FORMATS }))).toBe(3);
	}

	// A file cut off within the 64-bit size of a box header
	await expectGracefulRead(concat(box('ftyp', ascii('isom'), u32(0), ascii('isom')), u32(1), ascii('mdat')));

	// What the skipped box parsed before failing is undone: a truncated second mvhd mustn't change the movie timescale
	// that the edit list delaying the intact track by 1 s is in
	const delayedTrak = trak({ handler: 'vide', stbl: singleChunkStbl(3, 0), extra: [box('edts', fullBox(
		'elst', 0, 0, u32(2), u32(1000), u32(0xffffffff), u16(1), u16(0), u32(120), u32(0), u16(1), u16(0),
	))] });
	const truncatedMvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1), u32(0));
	expect(await firstPacketTimestamp(mp4([delayedTrak]))).toBe(1);
	expect(await firstPacketTimestamp(mp4([delayedTrak, truncatedMvhd]))).toBe(1);

	// ...including what it changed in place: a truncated second tkhd (track disabled, ID 999) mustn't change the track
	const truncatedTkhd = fullBox('tkhd', 0, 0, u32(0), u32(0), u32(999));
	const trakWithTruncatedTkhd = trak({ handler: 'vide', stbl: singleChunkStbl(3, 0), extra: [truncatedTkhd] });
	{
		using input = new Input({ source: new BufferSource(mp4([trakWithTruncatedTkhd])), formats: ALL_FORMATS });
		const track = (await input.getVideoTracks())[0]!;
		expect(track.id).toBe(1);
		expect((await track.getDisposition()).default).toBe(true);
	}

	// ...and a damaged udta mustn't break an earlier one, or leave raw tags that disagree with the parsed ones
	const quickTimeText = (name: string, text: string) => box(name, u16(text.length), u16(0), ascii(text));
	const damagedUdta = box('udta', quickTimeText('\u00a9cmt', 'Stale'), u32(200), ascii('XYZW'), zeros(4));
	{
		using input = new Input({
			source: new BufferSource(mp4([goodTrak, box('udta', quickTimeText('\u00a9nam', 'Good')), damagedUdta])),
			formats: ALL_FORMATS,
		});
		const tags = await input.getMetadataTags();
		expect(tags.title).toBe('Good');
		expect(tags.raw!['\u00a9nam']).toBe('Good');
		expect(tags.raw!['\u00a9cmt']).toBe(tags.comment);
	}
});

test('MP4: Many boxes running past the end of their parent', async () => {
	// Each such box has the parse redone without it, so they're capped per parse
	const damagedTrak = box('trak', box('mdia', mdhd(), hdlr('vide')), fullBox('tkhd', 0, 1, u32(0)));
	await expectGracefulRead(
		mp4([trak({ handler: 'vide', stbl: singleChunkStbl(3, 0) }), ...Array<Bytes>(20).fill(damagedTrak)]),
		/too many damaged boxes/,
	);
});

const firstPacketTimestamp = async (file: Uint8Array) => {
	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const packet = await new EncodedPacketSink((await input.getTracks())[0]!).getFirstPacket();
	return packet?.timestamp;
};

test('MP4: trak inside moof', async () => {
	// The trak used to hijack the current track, leaving the traf inside of it without fragment state
	await expectGracefulRead(mp4(fragmentedMoov(), [
		box('moof',
			box('traf', fullBox('tfhd', 0, 0x020000, u32(1)), fullBox('trun', 0, 0, u32(1))),
			trak({ handler: 'vide', stbl: emptyStbl(), extra: [box('traf')] }),
		),
		box('mdat', zeros(16)),
	]));
});

test('MP4: Boxes claiming more entries than they hold', async () => {
	// Like the edit list in FFmpeg's FATE sample mov/invalid_elst_entry_count.mov. Reading the claimed entries ran past
	// the box with an internal error, which made the whole file unreadable.
	const withEntryCount = (box: Uint8Array, entryCount: number, offset = 12) => {
		const copy = box.slice();
		new DataView(copy.buffer).setUint32(offset, entryCount);
		return copy;
	};
	const tables: Record<string, Uint8Array> = {
		stts: stts([[1, 40]]),
		ctts: ctts([[1, 0]]),
		stss: fullBox('stss', 0, 0, u32(1), u32(1)),
		stsc: stsc([[1, 1, 1]]),
		stsz: stsz([4]),
		stco: stco([0]),
	};

	for (const name of [...Object.keys(tables), 'elst']) {
		const stbl = [stsd(videoSampleEntry()), ...Object.entries(tables).map(([tableName, table]) => {
			return tableName === name ? withEntryCount(table, 1000, name === 'stsz' ? 16 : 12) : table;
		})];
		const elst = fullBox('elst', 0, 0, u32(1), u32(40), u32(0), u32(0x10000));
		const extra = [box('edts', name === 'elst' ? withEntryCount(elst, 2) : elst)];
		const file = mp4([trak({ handler: 'vide', stbl, extra })]);

		await expectGracefulRead(file);

		using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
		const track = (await input.getVideoTracks())[0];
		expect(track).toBeDefined();
		expect(await new EncodedPacketSink(track!).getFirstPacket()).not.toBeNull();
	}

	// The same for a fragment's trun (Firefox's dom/media/test/crashtests/1414444.mp4): 2 of 10 claimed sample sizes
	const fragmented = mp4(fragmentedMoov(), [
		moof(
			fullBox('tfhd', 0, 0x020000, u32(1)),
			fullBox('tfdt', 0, 0, u32(0)),
			fullBox('trun', 0, 0x000200, u32(10), u32(4), u32(4)),
		),
		box('mdat', zeros(8)),
	]);

	await expectGracefulRead(fragmented);

	using fragmentedInput = new Input({ source: new BufferSource(fragmented), formats: ALL_FORMATS });
	const fragmentedTrack = (await fragmentedInput.getVideoTracks())[0]!;
	let packetCount = 0;
	for await (const packet of new EncodedPacketSink(fragmentedTrack).packets()) {
		expect(packet.byteLength).toBe(4);
		packetCount++;
	}
	expect(packetCount).toBe(2);
});

const mp4 = (moovChildren: Bytes[], after: Bytes[] = []) => concat(
	box('ftyp', ascii('isom'), u32(0), ascii('isom')),
	box('moov', mvhd(), ...moovChildren),
	...after,
);

const fragmentedMoov = (options: { trex?: boolean } = {}) => [
	trak({ handler: 'vide', stbl: emptyStbl() }),
	box('mvex', ...(options.trex === false ? [] : [trex(1)])),
];

const trak = (options: { handler: 'vide' | 'soun'; stbl: Bytes[]; extra?: Bytes[]; id?: number; mdhd?: Bytes }) => box(
	'trak',
	tkhd(options.id ?? 1),
	box('mdia', options.mdhd ?? mdhd(), hdlr(options.handler), box('minf', box('stbl', ...options.stbl))),
	...(options.extra ?? []),
);

const singleChunkStbl = (sampleCount: number, dataOffset: number) => [
	stsd(videoSampleEntry()),
	stts([[sampleCount, 40]]),
	stsc([[1, sampleCount, 1]]),
	stsz(Array<number>(sampleCount).fill(4)),
	stco([dataOffset]),
];

const emptyStbl = () => [stsd(videoSampleEntry()), stts([]), stsc([]), stsz([]), stco([])];

const moof = (...trafChildren: Bytes[]) => box('moof', box('traf', ...trafChildren));

const mfra = (...children: Bytes[]) => {
	// The trailing mfro holds the size of the entire mfra box
	const content = concat(...children);
	const size = 8 + content.length + 16;
	return concat(u32(size), ascii('mfra'), content, fullBox('mfro', 0, 0, u32(size)));
};

const mvhd = (timescale = 1000) => fullBox('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u32(0x10000),
	u16(0x100), zeros(10),
	IDENTITY_MATRIX.flatMap(x => u32(x)), zeros(24), u32(2));

const tkhd = (id: number) => fullBox('tkhd', 0, 1, u32(0), u32(0), u32(id), u32(0), u32(0), zeros(8), u16(0), u16(0),
	u16(0), u16(0), IDENTITY_MATRIX.flatMap(x => u32(x)), u32(0), u32(0));

const mdhd = (timescale = 1000) => fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));

const hdlr = (type: 'vide' | 'soun') => fullBox('hdlr', 0, 0, u32(0), ascii(type), zeros(12), u8(0));

const videoSampleEntry = (name = 'avc1', children: Bytes | Bytes[] = [], size = 64) => box(
	name, zeros(6), u16(1), zeros(16), u16(size), u16(size), u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32),
	u16(24), u16(0xffff), ...(children instanceof Uint8Array ? [children] : children as Bytes[]),
);

const audioSampleEntry = (name = 'mp4a', ...children: Bytes[]) => box(
	name, zeros(6), u16(1), u16(0), zeros(6), u16(2), u16(16), u16(0), u16(0), u32(48000 * 0x10000), ...children,
);

const stsd = (...entries: Bytes[]) => fullBox('stsd', 0, 0, u32(entries.length), ...entries);

const stts = (entries: number[][]) => fullBox('stts', 0, 0, u32(entries.length), entries.flatMap(
	([count, delta]) => [...u32(count!), ...u32(delta!)],
));

const ctts = (entries: number[][]) => fullBox('ctts', 0, 0, u32(entries.length), entries.flatMap(
	([count, offset]) => [...u32(count!), ...u32(offset!)],
));

const stsz = (sizes: number[]) => fullBox('stsz', 0, 0, u32(0), u32(sizes.length), sizes.flatMap(x => u32(x)));

const stsc = (entries: [number, number, number][]) => fullBox('stsc', 0, 0, u32(entries.length), entries.flatMap(
	entry => entry.flatMap(x => u32(x)),
));

const stco = (offsets: number[]) => fullBox('stco', 0, 0, u32(offsets.length), offsets.flatMap(x => u32(x)));

const trex = (trackId: number) => fullBox('trex', 0, 0, u32(trackId), u32(1), u32(1), u32(4), u32(0));

const fullBox = (name: string, version: number, flags: number, ...parts: Bytes[]) => {
	return box(name, u8(version), u24(flags), ...parts);
};

const box = (name: string, ...parts: Bytes[]) => {
	const content = concat(...parts);
	return concat(u32(8 + content.length), ascii(name), content);
};

const indexOfAscii = (bytes: Uint8Array, text: string, fromIndex: number) => {
	const pattern = ascii(text);
	outer:
	for (let i = fromIndex; i <= bytes.length - pattern.length; i++) {
		for (let j = 0; j < pattern.length; j++) {
			if (bytes[i + j] !== pattern[j]) {
				continue outer;
			}
		}

		return i;
	}

	return -1;
};

test('Matroska: Trailing zeros after tracks', async () => {
	// Resyncing used to get stuck when fewer than 9 bytes were left to scan
	await expectGracefulRead(matroska(info(), tracks(videoTrack(1)), zeros(32)));
});

test('Matroska: Trailing zeros after clusters', async () => {
	await expectGracefulRead(matroska(info(), tracks(videoTrack(1)), cluster(0, simpleBlock(1, 0, 0x80)), zeros(32)));
});

test('Matroska: Cluster ID with broken size', async () => {
	// Resyncing used to find the very same cluster ID again, over and over
	const brokenCluster = [...elementId(EBMLId.Cluster), 0x00];

	await expectGracefulRead(matroska(info(), tracks(videoTrack(1)), brokenCluster, zeros(16)));
	await expectGracefulRead(matroska(
		info(),
		tracks(videoTrack(1)),
		cluster(0, simpleBlock(1, 0, 0x80)),
		brokenCluster,
		zeros(16),
	));
});

test('Matroska: Segments sharing one huge Cues element', async () => {
	// Every segment used to parse the shared element anew
	const segmentCount = 300;
	const cueElement = cues(Array.from({ length: 20_000 }, (_, i) => [i, 1, 0]));
	const header = ebmlHeader();
	const segmentLength = element(EBMLId.Segment, seekHead([[EBMLId.Cues, 0]])).length;
	const cuesPos = header.length + segmentCount * segmentLength;

	const segments: Uint8Array[] = [];
	for (let i = 0; i < segmentCount; i++) {
		const dataStartPos = header.length + i * segmentLength + 4 + 1;
		segments.push(element(EBMLId.Segment, seekHead([[EBMLId.Cues, cuesPos - dataStartPos]])));
	}

	await expectGracefulRead(concat(header, ...segments, cueElement));
});

test('Matroska: Fixed lacing without data', async () => {
	// Each block claimed 256 empty frames, all of which used to be expanded (with a quadratic insertion, too)
	const blocks = Array.from({ length: 20_000 }, () => simpleBlock(1, 0, 0x84, [0xff]));
	await expectGracefulRead(matroska(info(), tracks(videoTrack(1)), cluster(0, ...blocks)), /lacing/);
});

test('Matroska: Huge header stripping prefix with laced blocks', async () => {
	// The prefix used to be copied into every laced block as soon as its cluster was read
	const prefixSize = 2 ** 20;
	const encodings = element(EBMLId.ContentEncodings, element(EBMLId.ContentEncoding, element(
		EBMLId.ContentCompression,
		uintElement(EBMLId.ContentCompAlgo, 3),
		element(EBMLId.ContentCompSettings, zeros(prefixSize)),
	)));
	// Xiph lacing with two 1-byte frames
	const blocks = Array.from({ length: 2000 }, () => simpleBlock(1, 0, 0x82, [1, 1, 0x10, 0x20]));

	using input = new Input({
		source: new BufferSource(matroska(info(), tracks(videoTrack(1, 'V_VP8', encodings)), cluster(0, ...blocks))),
		formats: ALL_FORMATS,
	});
	const track = (await input.getVideoTracks())[0]!;

	const arrayBuffersBefore = process.memoryUsage().arrayBuffers;
	const packet = await new EncodedPacketSink(track).getFirstPacket();
	expect(process.memoryUsage().arrayBuffers - arrayBuffersBefore).toBeLessThan(2 ** 26);

	// The prefix goes in front of each frame, after the lacing was parsed
	expect([...packet!.data.subarray(prefixSize - 1)]).toEqual([0, 0x10]);
});

test('Matroska: Cue points pointing nowhere', async () => {
	// Every faulty cue point used to trigger another scan, starting at the cue point before it
	const clusterCount = 2000;
	const clusters = [cluster(0, simpleBlock(1, 0, 0x80), simpleBlock(2, 0, 0x80))];
	for (let i = 1; i < clusterCount; i++) {
		clusters.push(cluster(i, simpleBlock(2, 0, 0x80)));
	}

	const trackElement = tracks(videoTrack(1), videoTrack(2));
	const cuesLength = cues(clusters.map(() => [0, 1, 0])).length;
	let pos = info().length + trackElement.length + cuesLength;
	const cueEntries: number[][] = [];
	for (let i = 0; i < clusterCount; i++) {
		cueEntries.push([i, 1, pos]);
		pos += clusters[i]!.length;
	}

	await expectGracefulRead(matroska(info(), trackElement, cues(cueEntries), ...clusters));
});

test('Matroska: Seek head with many entries', async () => {
	const entries = Array.from({ length: 25_000 }, (_, i) => [EBMLId.SeekHead, 2 * i + 1]);
	await expectGracefulRead(matroska(seekHead(entries), info(), tracks(videoTrack(1))));
});

test('Matroska: Cue point with many duplicate positions', async () => {
	// Deduplication used to remove the duplicates one splice at a time
	const positions = Array.from({ length: 200_000 }, () => element(
		EBMLId.CueTrackPositions,
		uintElement(EBMLId.CueTrack, 1),
		uintElement(EBMLId.CueClusterPosition, 0),
	));
	const cueElement = element(
		EBMLId.Cues,
		element(EBMLId.CuePoint, uintElement(EBMLId.CueTime, 0), concatList(positions)),
	);

	await expectGracefulRead(matroska(info(), tracks(videoTrack(1)), cueElement, cluster(0, simpleBlock(1, 0, 0x80))));
});

test('Matroska: Huge FileUID', async () => {
	// Unsigned integers of any size used to be accepted
	const attachments = element(EBMLId.Attachments, element(
		EBMLId.AttachedFile,
		element(EBMLId.FileUID, new Uint8Array(2 ** 18).fill(0xff)),
		element(EBMLId.FileName, ascii('a.bin')),
		element(EBMLId.FileData, [1, 2, 3]),
	));

	await expectGracefulRead(matroska(info(), tracks(videoTrack(1)), attachments));
});

test('Matroska: Clusters with decreasing timestamps', { timeout: 10_000 }, async () => {
	// Caching their positions used to insert at the front over and over
	const clusters = Array.from({ length: 100_000 }, (_, i) => cluster(100_000 - i, simpleBlock(1, 0, 0x80)));
	using input = new Input({
		source: new BufferSource(matroska(info(), tracks(videoTrack(1)), concatList(clusters))),
		formats: ALL_FORMATS,
	});

	expect(await countPackets(input)).toBeGreaterThan(0);
});

test('Matroska: Cluster with many key frames', async () => {
	// Finding the next key frame used to start the search at the cluster's first block
	const blockCount = 80_000;
	const blocks = Array.from({ length: blockCount }, (_, i) => simpleBlock(1, i % 30_000, 0x80));

	using input = new Input({
		source: new BufferSource(matroska(info(), tracks(videoTrack(1)), cluster(0, concatList(blocks)))),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getVideoTracks())[0]!);

	let count = 0;
	let packet = await sink.getFirstKeyPacket();
	while (packet) {
		count++;
		packet = await sink.getNextKeyPacket(packet);
	}

	expect(count).toBe(blockCount);
});

test('Matroska: Many tracks and blocks of an unknown track', async () => {
	// Looking up the unknown track used to search through all tracks for every single block
	const trackEntries = Array.from({ length: 20_000 }, (_, i) => videoTrack(i + 1));
	const blocks = [simpleBlock(1, 0, 0x80), ...Array.from({ length: 100_000 }, () => simpleBlock(20_001, 0, 0x80))];

	using input = new Input({
		source: new BufferSource(matroska(info(), tracks(concatList(trackEntries)), cluster(0, concatList(blocks)))),
		formats: ALL_FORMATS,
	});
	const track = (await input.getVideoTracks())[0]!;

	expect(await new EncodedPacketSink(track).getFirstPacket()).not.toBeNull();
});

test('Matroska: Many tracks without blocks', async () => {
	// Every empty track used to scan all clusters to find its first packet
	const trackEntries = [videoTrack(1), ...Array.from({ length: 2000 }, (_, i) => videoTrack(i + 2, 'V_VP9'))];
	const clusters = Array.from({ length: 5000 }, (_, i) => cluster(i, simpleBlock(1, 0, 0x80)));

	using input = new Input({
		source: new BufferSource(matroska(info(), tracks(...trackEntries), ...clusters)),
		formats: ALL_FORMATS,
	});

	expect(await input.getMimeType()).toContain('vp8');
});

test('Matroska: Cue track positions outside of a segment', async () => {
	await expectGracefulRead(concat(
		ebmlHeader('webm', [
			uintElement(EBMLId.CueTime, 0),
			element(EBMLId.CueTrackPositions, uintElement(EBMLId.CueTrack, 1)),
		]),
		element(EBMLId.Segment, info(), tracks(videoTrack(1)), cluster(0, simpleBlock(1, 0, 0x80))),
	));
});

test('Matroska: EBML lacing with invalid frame size', async () => {
	await expectGracefulRead(
		matroska(info(), tracks(videoTrack(1)), cluster(0, simpleBlock(1, 0, 0x86, [1, 0x00, 0x00]))),
		/lacing/,
	);
});

test('Matroska: Xiph lacing running out of data', async () => {
	await expectGracefulRead(
		matroska(info(), tracks(videoTrack(1)), cluster(0, simpleBlock(1, 0, 0x82, [2, 0xff, 0xff]))),
		/lacing/,
	);
});

test('Matroska: Vorbis CodecPrivate with unterminated Xiph lacing', async () => {
	// Computing the pre-roll used to scan past the end of the CodecPrivate forever, and asserted without one
	const vorbisFile = (codecPrivate: number[] | null) => matroska(info(), tracks(element(
		EBMLId.TrackEntry,
		uintElement(EBMLId.TrackNumber, 1),
		uintElement(EBMLId.TrackType, 2),
		element(EBMLId.CodecID, ascii('A_VORBIS')),
		codecPrivate ? element(EBMLId.CodecPrivate, codecPrivate) : [],
		element(EBMLId.Audio, element(EBMLId.SamplingFrequency, float64(48000)), uintElement(EBMLId.Channels, 2)),
	)), cluster(0, simpleBlock(1, 0, 0x80)));
	const getPreRollDuration = 'async input => (await input.getAudioTracks())[0].getPreRollDuration()';

	expect(evaluateWithDeadline(vorbisFile([2, 0xff, 0xff, 0xff]), getPreRollDuration)).toBe(4096 / 48000);
	expect(evaluateWithDeadline(vorbisFile(null), getPreRollDuration)).toBe(4096 / 48000);
});

test('Matroska: Laced block without data', async () => {
	await expectGracefulRead(
		matroska(info(), tracks(videoTrack(1)), cluster(0, simpleBlock(1, 0, 0x84, []))),
		/laced block/,
	);
});

test('Matroska: Failing tags read twice', async () => {
	// A failure while loading the tags used to leave state behind that tripped up the next attempt
	const brokenTags = element(EBMLId.Tags, element(EBMLId.Tag, element(
		EBMLId.Targets,
		element(EBMLId.TargetTypeValue, zeros(9)),
	)));

	using input = new Input({ source: new BufferSource(matroskaWithLazyTags(brokenTags)), formats: ALL_FORMATS });
	await expect(input.getMetadataTags()).rejects.toThrow(/unsigned int size/);
	await expect(input.getMetadataTags()).rejects.toThrow(/unsigned int size/);
});

test('Matroska: Element larger than its parent', async () => {
	await expectGracefulRead(matroska(info(), tracks(element(
		EBMLId.TrackEntry,
		uintElement(EBMLId.TrackNumber, 1),
		uintElement(EBMLId.TrackType, 1),
		elementHeader(EBMLId.CodecID, 1000),
		ascii('V_VP8'),
	))));
});

test('Matroska: Content encoding outside of a track', async () => {
	await expectGracefulRead(matroska(info(), tracks(
		element(EBMLId.ContentEncoding, element(EBMLId.ContentCompression, uintElement(EBMLId.ContentCompAlgo, 3))),
		videoTrack(1),
	)));
});

test('Matroska: Block shorter than its header', async () => {
	await expectGracefulRead(matroska(info(), tracks(videoTrack(1)), cluster(0, element(EBMLId.SimpleBlock, [0x81]))));
	await expectGracefulRead(matroska(info(), tracks(videoTrack(1)), cluster(
		0,
		element(EBMLId.SimpleBlock, [0x81]),
		simpleBlock(1, 0, 0x80),
	)));
});

test('Matroska: Huge DocType', async () => {
	await expectGracefulRead(concat(ebmlHeader('a'.repeat(2 ** 20)), element(EBMLId.Segment, info())));
});

test('Matroska: Huge codec ID', async () => {
	await expectGracefulRead(matroska(info(), tracks(videoTrack(1, 'V_' + 'A'.repeat(2 ** 20)))));
});

test('Matroska: DocType larger than the EBML header', async () => {
	await expectGracefulRead(concat(
		element(EBMLId.EBML, uintElement(EBMLId.EBMLVersion, 1), elementHeader(EBMLId.DocType, 30_000), ascii('webm')),
		element(EBMLId.Segment, info()),
	));
});

test('Matroska: Deeply nested elements', async () => {
	const depth = 50_000;
	const nested = new Uint8Array(10 * depth);
	for (let i = 0; i < depth; i++) {
		nested.set(elementHeader(EBMLId.Tag, 10 * (depth - i - 1), 8), 10 * i);
	}

	await expectGracefulRead(concat(ebmlHeader('webm', [nested]), element(EBMLId.Segment, info())));
});

test('Matroska: Track disabled from within content encodings', async () => {
	// Nested elements used to clobber the state their parents relied on
	await expectGracefulRead(matroska(info(), tracks(videoTrack(
		1,
		'V_VP8',
		element(EBMLId.ContentEncodings, uintElement(EBMLId.FlagEnabled, 0)),
	))));
});

test('Matroska: Nested BlockMore', async () => {
	const blockGroup = element(
		EBMLId.BlockGroup,
		element(EBMLId.Block, [0x81, 0, 0, 0, 1]),
		element(EBMLId.BlockAdditions, element(
			EBMLId.BlockMore,
			element(EBMLId.BlockMore, element(EBMLId.BlockAdditional, [1])),
			element(EBMLId.BlockAdditional, [1]),
		)),
	);

	await expectGracefulRead(matroska(info(), tracks(videoTrack(1)), cluster(0, blockGroup)));
});

test('Matroska: Streamed with a huge element size', async () => {
	// Reading the element used to allocate its entire claimed size up front
	const file = concat(elementHeader(EBMLId.EBML, 2 ** 40, 8), element(EBMLId.DocType, ascii('webm')));
	using input = new Input({ source: streamedSource(file), formats: ALL_FORMATS });

	// The allocation is lazily committed, so nothing fails; it just quietly reserves a terabyte
	const arrayBuffersBefore = process.memoryUsage().arrayBuffers;
	await input.getFormat().catch(() => {});

	expect(process.memoryUsage().arrayBuffers - arrayBuffersBefore).toBeLessThan(2 ** 26);
});

const matroskaWithLazyTags = (tagsElement: Uint8Array) => {
	// The tags come after the clusters, so they only get loaded when requested
	const trackElement = tracks(videoTrack(1));
	const clusterElement = cluster(0, simpleBlock(1, 0, 0x80));
	const tagsPos = seekHead([[EBMLId.Tags, 0]]).length + info().length + trackElement.length + clusterElement.length;

	return matroska(seekHead([[EBMLId.Tags, tagsPos]]), info(), trackElement, clusterElement, tagsElement);
};

const matroska = (...segmentChildren: Bytes[]) => concat(ebmlHeader(), element(EBMLId.Segment, ...segmentChildren));

const ebmlHeader = (docType = 'webm', extra: Bytes[] = []) => element(
	EBMLId.EBML,
	uintElement(EBMLId.EBMLVersion, 1),
	uintElement(EBMLId.EBMLReadVersion, 1),
	element(EBMLId.DocType, ascii(docType)),
	uintElement(EBMLId.DocTypeVersion, 4),
	uintElement(EBMLId.DocTypeReadVersion, 2),
	...extra,
);

const info = () => element(EBMLId.Info, uintElement(EBMLId.TimestampScale, 1e6));

const tracks = (...entries: Bytes[]) => element(EBMLId.Tracks, ...entries);

const videoTrack = (number: number, codecId = 'V_VP8', ...extra: Bytes[]) => element(
	EBMLId.TrackEntry,
	uintElement(EBMLId.TrackNumber, number),
	uintElement(EBMLId.TrackType, 1),
	element(EBMLId.CodecID, ascii(codecId)),
	element(EBMLId.Video, uintElement(EBMLId.PixelWidth, 16), uintElement(EBMLId.PixelHeight, 16)),
	...extra,
);

const cluster = (timestamp: number, ...children: Bytes[]) => element(
	EBMLId.Cluster,
	uintElement(EBMLId.Timestamp, timestamp),
	...children,
);

const simpleBlock = (trackNumber: number, timestamp: number, flags: number, data: Bytes = [0x10]) => element(
	EBMLId.SimpleBlock,
	vint(trackNumber),
	u16(timestamp),
	[flags],
	data,
);

// Times and positions are written with a fixed width, so that the element's size doesn't depend on them
const cues = (entries: number[][]) => element(EBMLId.Cues, ...entries.map(([time, track, position]) => element(
	EBMLId.CuePoint,
	element(EBMLId.CueTime, u32(time!)),
	element(EBMLId.CueTrackPositions, uintElement(EBMLId.CueTrack, track!), element(
		EBMLId.CueClusterPosition,
		u32(position!),
	)),
)));

// Positions are written with a fixed width, so that the element's size doesn't depend on them
const seekHead = (entries: number[][]) => element(EBMLId.SeekHead, ...entries.map(([id, position]) => element(
	EBMLId.Seek,
	element(EBMLId.SeekID, elementId(id!)),
	element(EBMLId.SeekPosition, u32(position!)),
)));

const uintElement = (id: number, value: number) => {
	let width = 1;
	while (value >= 2 ** (8 * width)) {
		width++;
	}

	return element(id, bigEndian(value, width));
};

const element = (id: number, ...parts: Bytes[]) => {
	const content = concat(...parts);
	return concat(elementHeader(id, content.length), content);
};

const elementHeader = (id: number, size: number, sizeWidth?: number) => concat(elementId(id), vint(size, sizeWidth));

const elementId = (id: number) => bigEndian(id, id < 0x100 ? 1 : id < 0x10000 ? 2 : id < 0x1000000 ? 3 : 4);

const vint = (value: number, width?: number) => {
	width ??= 1;
	while (value >= 2 ** (7 * width) - 1) {
		width++;
	}

	const bytes = bigEndian(value, width);
	bytes[0]! |= 1 << (8 - width);
	return bytes;
};

const bigEndian = (value: number, width: number) => Array.from(
	{ length: width },
	(_, i) => Math.floor(value / 2 ** (8 * (width - 1 - i))) & 0xff,
);

test('MPEG-TS: ADTS frame with zero length', async () => {
	// The zero-length frame used to be emitted as a packet over and over, without ever advancing
	const zeroLengthHeader = concat(adtsHeader(0), zeros(2));
	await expectGracefulRead(mpegTs(AAC_STREAM, [pes(0xc0, 1000, concat(adtsFrame(20), zeroLengthHeader, zeros(20)))]));
});

test('MPEG-TS: ADTS frame shorter than its header', async () => {
	await expectGracefulRead(mpegTs(AAC_STREAM, [pes(0xc0, 1000, concat(adtsHeader(3), zeros(23)))]));
});

test('MPEG-TS: ADTS frame with reserved sampling frequency index', async () => {
	const frames = concat(adtsFrame(20, 13), adtsFrame(20, 13), adtsFrame(20, 13));
	await expectGracefulRead(mpegTs(AAC_STREAM, [pes(0xc0, 1000, frames), pes(0xc0, 4840, frames)]));
});

test('MPEG-TS: SPS with overflowing frame buffering', async () => {
	// Its exp-Golomb code used to decode to a negative number
	const pesPackets = avcPesPackets(avcSps({ maxDecFrameBuffering: 2 ** 31 - 1 }), 20);
	await expectGracefulRead(mpegTs(AVC_STREAM, pesPackets, { randomAccessIndicator: true }));
});

test('MPEG-TS: SPS with huge frame buffering', async () => {
	// Rewinding by that many packets used to rescan the file over and over
	const pesPackets = avcPesPackets(avcSps({ maxDecFrameBuffering: 2 ** 30 - 1 }), 20);
	await expectGracefulRead(mpegTs(AVC_STREAM, pesPackets, { randomAccessIndicator: true }));
});

test('MPEG-TS: SPS with large frame buffering and many access units', async () => {
	// The reorder buffer used to be as large as the SPS said, with work quadratic in its size
	const sps = avcSps({ maxDecFrameBuffering: 100_000 });
	const accessUnits = [concat(START_CODE, sps, START_CODE, avcPps(), avcSlice(5))];
	for (let i = 1; i < 150_000; i++) {
		accessUnits.push(avcSlice(1));
	}

	const pesPackets: Uint8Array[] = [];
	for (let i = 0; i < accessUnits.length; i += 50) {
		pesPackets.push(pes(0xe0, 1000 + i * 3000, concatList(accessUnits.slice(i, i + 50))));
	}

	await expectGracefulRead(mpegTs(AVC_STREAM, pesPackets, { randomAccessIndicator: true }));
});

test('MPEG-TS: SPS cropping away the entire picture', async () => {
	await expectGracefulRead(mpegTs(AVC_STREAM, avcPesPackets(avcSps({ cropBottom: 1000 }), 5)), /AVC/);
});

test('MPEG-TS: Key packet lookup without random access indicators', async () => {
	// Every PES packet used to get its own scan for the end of its first packet, all the way to the end of the
	// file
	const pesPackets = [pes(0xe0, 1000, concat(START_CODE, avcSps(), START_CODE, avcPps(), avcSlice(5)))];
	for (let i = 1; i < 4000; i++) {
		pesPackets.push(pes(0xe0, 1000 + i * 3000, new Uint8Array(150).fill(0xff)));
	}

	using input = new Input({
		source: new BufferSource(mpegTs(AVC_STREAM, pesPackets)),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getVideoTracks())[0]!);

	expect(await sink.getKeyPacket(100)).not.toBeNull();
});

test('MPEG-TS: Key frame split across PES packets', async () => {
	// The key packet's timestamp comes from a later PES packet than the one flagged for random access
	const pesPackets = [
		pes(0xe0, 1000, concat(avcAud(), START_CODE, avcSps({ maxDecFrameBuffering: 0 }), START_CODE, avcPps())),
		pes(0xe0, 9_001_000, avcSlice(5)),
	];
	for (let i = 1; i <= 5; i++) {
		pesPackets.push(pes(0xe0, 9_001_000 + i * 3000, concat(avcAud(), avcSlice(1))));
	}

	await expectGracefulRead(mpegTs(AVC_STREAM, pesPackets, { randomAccessIndicator: true }));
});

test('MPEG-TS: Truncated recovery point SEI', async () => {
	// Its parse error used to make the entire stream unreadable
	const sei = [0x06, 0x06, 0x01, 0x00];
	using input = new Input({
		source: new BufferSource(mpegTs(AVC_STREAM, [
			pes(0xe0, 1000, concat(START_CODE, avcSps(), START_CODE, avcPps(), avcSlice(5))),
			pes(0xe0, 4000, concat(START_CODE, sei, avcSlice(1))),
			pes(0xe0, 7000, avcSlice(1)),
		])),
		formats: ALL_FORMATS,
	});

	expect(await countPackets(input)).toBeGreaterThan(0);
});

test('MPEG-TS: Many streams and one that never shows up', async () => {
	// Streams that were already set up used to have their sections read in full anyway, while looking for the last
	// one
	const streams = Array.from({ length: 300 }, (_, i) => ({ type: 0x0f, pid: 0x100 + i }));
	streams.push({ type: 0x0f, pid: 0x1000 });

	const packets: Uint8Array[] = [];
	for (let round = 0; round < 10; round++) {
		for (let i = 0; i < 300; i++) {
			packets.push(...packetize(0x100 + i, pes(0xc0, 1000 + round * 1920, adtsFrame(20))));
		}
	}

	using input = new Input({
		source: new BufferSource(mpegTs(streams, [], {}, concatList(packets))),
		formats: ALL_FORMATS,
	});
	const start = performance.now();
	await input.getTracks();

	expect(performance.now() - start).toBeLessThan(1500);
});

test('MPEG-TS: PES packets without data', async () => {
	// Stepping into the next PES packet byte by byte used to only step over one of them, desyncing the read position
	const frame = adtsFrame(20);
	await expectGracefulRead(mpegTs(AAC_STREAM, [
		pes(0xc0, 1000, frame),
		pes(0xc0, 2000, []),
		pes(0xc0, 3000, []),
		pes(0xc0, 4000, frame.subarray(0, 1)),
		pes(0xc0, 5000, concat(frame.subarray(1), frame)),
	]));
});

const mpegTs = (
	streams: { type: number; pid: number }[],
	pesPackets: Uint8Array[],
	options: { randomAccessIndicator?: boolean } = {},
	extra: Bytes = [],
) => concat(
	...packetize(0, psi(concat([0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0], [0, 1, 0xf0, 0x00], zeros(4)))),
	...packetize(0x1000, psi(pmt(streams))),
	...pesPackets.flatMap((data, i) => packetize(0x100, data, options.randomAccessIndicator === true && i === 0)),
	extra,
);

const psi = (section: Uint8Array) => {
	const stuffingLength = (184 - (section.length + 1) % 184) % 184;
	return concat([0], section, new Uint8Array(stuffingLength).fill(0xff));
};

const pmt = (streams: { type: number; pid: number }[]) => {
	const entries = streams.flatMap(({ type, pid }) => [type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0x00]);
	const sectionLength = 9 + entries.length + 4;
	return concat(
		[0x02, 0xb0 | (sectionLength >> 8), sectionLength & 0xff, 0, 1, 0xc1, 0, 0, 0xff, 0xff, 0xf0, 0x00],
		entries,
		zeros(4),
	);
};

const packetize = (pid: number, payload: Uint8Array, randomAccessIndicator = false) => {
	const packets: Uint8Array[] = [];
	let offset = 0;

	while (offset < payload.length) {
		const packet = new Uint8Array(188);
		packet.set([0x47, (offset === 0 ? 0x40 : 0) | (pid >> 8), pid & 0xff], 0);

		const remaining = payload.length - offset;
		const withRai = offset === 0 && randomAccessIndicator;
		let headerEnd = 4;

		if (withRai || remaining < 184) {
			// Adaptation field for the random access indicator and/or stuffing
			const adaptationFieldLength = Math.max(withRai ? 1 : 0, 183 - remaining);
			packet[3] = 0x30;
			packet[4] = adaptationFieldLength;
			if (adaptationFieldLength > 0) {
				packet[5] = withRai ? 0x40 : 0x00;
				packet.fill(0xff, 6, 5 + adaptationFieldLength);
			}
			headerEnd = 5 + adaptationFieldLength;
		} else {
			packet[3] = 0x10;
		}

		const length = Math.min(188 - headerEnd, remaining);
		packet.set(payload.subarray(offset, offset + length), headerEnd);
		offset += length;
		packets.push(packet);
	}

	return packets;
};

const avcPesPackets = (sps: Uint8Array, count: number) => Array.from({ length: count }, (_, i) => pes(
	0xe0,
	1000 + i * 3000,
	i === 0
		? concat(avcAud(), START_CODE, sps, START_CODE, avcPps(), avcSlice(5))
		: concat(avcAud(), avcSlice(1)),
));

const pes = (streamId: number, pts: number, data: Bytes) => concat(
	[0, 0, 1, streamId],
	u16(Math.min(8 + data.length, 0xffff)),
	[0x80, 0x80, 5],
	[0x21 | (Math.floor(pts / 2 ** 30) % 8) << 1],
	u16(((Math.floor(pts / 2 ** 15) % 2 ** 15) << 1) | 1),
	u16(((pts % 2 ** 15) << 1) | 1),
	data,
);

const adtsFrame = (payloadSize: number, samplingFrequencyIndex = 4) => {
	return concat(adtsHeader(7 + payloadSize, samplingFrequencyIndex), zeros(payloadSize));
};

const adtsHeader = (frameLength: number, samplingFrequencyIndex = 4) => [
	0xff,
	0xf1,
	(1 << 6) | (samplingFrequencyIndex << 2),
	(2 << 6) | ((frameLength >> 11) & 3),
	(frameLength >> 3) & 0xff,
	((frameLength & 7) << 5) | 0x1f,
	0xfc,
];

const avcSps = (options: { maxDecFrameBuffering?: number; cropBottom?: number } = {}) => {
	const writer = bitWriter();
	writer.u(8, 0x67);
	writer.u(8, 66).u(8, 0).u(8, 30); // Profile, constraints, level
	writer.ue(0).ue(0).ue(0).ue(0); // SPS ID, log2_max_frame_num_minus4, POC type, log2_max_poc_lsb_minus4
	writer.ue(1).u(1, 0); // Max ref frames, gaps
	writer.ue(1).ue(1); // Size in macroblocks minus one
	writer.u(1, 1).u(1, 1); // Frame MBs only, direct 8x8 inference

	if (options.cropBottom !== undefined) {
		writer.u(1, 1).ue(0).ue(0).ue(0).ue(options.cropBottom);
	} else {
		writer.u(1, 0);
	}

	if (options.maxDecFrameBuffering !== undefined) {
		writer.u(1, 1); // VUI
		writer.u(8, 0); // Everything absent until the bitstream restriction
		writer.u(1, 1).u(1, 1).ue(0).ue(0).ue(16).ue(16).ue(0).ue(options.maxDecFrameBuffering);
	} else {
		writer.u(1, 0);
	}

	return writer.rbsp();
};

const avcPps = () => bitWriter().u(8, 0x68).ue(0).ue(0).u(2, 0).ue(0).ue(0).ue(0).u(3, 0).ue(0).ue(0).ue(0).u(3, 0)
	.rbsp();

const avcSlice = (nalUnitType: number) => concat(START_CODE, [0x60 | nalUnitType, 0x88, 0x84, 0x21, 0xa0, 0x55]);

const avcAud = () => concat(START_CODE, [0x09, 0xf0]);

const bitWriter = () => {
	const bits: number[] = [];

	const writer = {
		u: (bitCount: number, value: number) => {
			for (let i = bitCount - 1; i >= 0; i--) {
				bits.push(Math.floor(value / 2 ** i) % 2);
			}
			return writer;
		},
		ue: (value: number) => {
			const length = Math.floor(Math.log2(value + 1));
			return writer.u(length, 0).u(length + 1, value + 1);
		},
		// Finishes the payload with a stop bit and adds emulation prevention
		rbsp: () => {
			const allBits = [...bits, 1];
			while (allBits.length % 8 !== 0) {
				allBits.push(0);
			}

			const result: number[] = [];
			let zeroCount = 0;
			for (let i = 0; i < allBits.length; i += 8) {
				const byte = allBits.slice(i, i + 8).reduce((a, b) => 2 * a + b, 0);
				if (zeroCount === 2 && byte <= 3) {
					result.push(3);
					zeroCount = 0;
				}

				result.push(byte);
				zeroCount = byte === 0 ? zeroCount + 1 : 0;
			}

			return new Uint8Array(result);
		},
	};

	return writer;
};

test('Ogg: BOS page without segments', async () => {
	await expectGracefulRead(oggPage({ headerType: 2, lacing: [], data: [] }));
});

test('Ogg: Truncated page payload', async () => {
	const file = concatList(opusPages());
	await expectGracefulRead(file.subarray(0, file.length - 5));
});

test('Ogg: Truncated last page still lets lookups find the last complete packet', async () => {
	// Like a partial download: there's no EOS page, and the cut-off page ends in the middle of a packet, as is the
	// norm for Vorbis. Each page holds the tail of a packet started on the previous page, a whole packet, and the head
	// of a packet continuing on the next page.
	const wholePacket = concat([0xf8], zeros(99)); // 20 ms of CELT
	const splitPacket = concat([0xf8], zeros(299));
	const pages = [oggPacketsPage({ headerType: 2 }, [opusHead()]), oggPacketsPage({ sequence: 1 }, [opusTags([])])];
	for (let i = 0; i < 20; i++) {
		pages.push(oggPage({
			headerType: i === 0 ? 0 : 1,
			granule: 960 * (1 + 2 * i),
			sequence: 2 + i,
			lacing: i === 0 ? [100, 255] : [45, 100, 255],
			data: concat(i === 0 ? [] : splitPacket.subarray(255), wholePacket, splitPacket.subarray(0, 255)),
		}));
	}
	const file = concatList(pages);

	using input = new Input({ source: new BufferSource(file.subarray(0, file.length - 5)), formats: ALL_FORMATS });
	const track = (await input.getAudioTracks())[0]!;
	const sink = new EncodedPacketSink(track);

	let lastPacket: EncodedPacket | null = null;
	for await (const packet of sink.packets()) {
		lastPacket = packet;
	}
	expect(lastPacket).not.toBeNull();

	expect((await sink.getPacket(Infinity))?.timestamp).toBe(lastPacket!.timestamp);
	expect((await sink.getKeyPacket(Infinity))?.timestamp).toBe(lastPacket!.timestamp);
	expect(await track.computeDuration()).toBe(lastPacket!.timestamp + lastPacket!.duration);
});

test('Ogg: Truncated page header', async () => {
	const pages = opusPages();
	const lastPageStart = concatList(pages).length - pages.at(-1)!.length;
	await expectGracefulRead(concatList(pages).subarray(0, lastPageStart + 27 + 3));
});

test('Ogg: Page claiming to extend past the end of the file', async () => {
	const fakePage = concat(
		ascii('OggS'),
		zeros(10),
		u32le(0x99), // Serial number
		zeros(8),
		[5], // Segment count
		new Uint8Array(5).fill(255),
		zeros(8),
	);
	await expectGracefulRead(concat(...opusPages({ pageCount: 20 }), fakePage));
});

test('Ogg: Continuation pages after lost pages', async () => {
	const describePacket = (packet: { timestamp: number; byteLength: number; sequenceNumber: number }) => ({
		timestamp: packet.timestamp,
		byteLength: packet.byteLength,
		sequenceNumber: packet.sequenceNumber,
	});
	const readPackets = async (file: Uint8Array) => {
		using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
		const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
		const packets = [];
		for await (const packet of sink.packets()) {
			packets.push(describePacket(packet));
		}

		// Lookups of the packets' own timestamps, each on a fresh input
		const lookups = [];
		for (const packet of packets) {
			using lookupInput = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
			const lookupSink = new EncodedPacketSink((await lookupInput.getPrimaryAudioTrack())!);
			lookups.push(describePacket((await lookupSink.getPacket(packet.timestamp))!));
		}

		return { packets, lookups };
	};
	const headerPages = [
		oggPacketsPage({ headerType: 2 }, [opusHead()]),
		oggPacketsPage({ sequence: 1 }, [opusTags([])]),
	];
	const orphanedEnd = zeros(10); // The end of a packet whose start was on a lost page

	// With page 3 lost, page 4 continues a packet whose start is missing. Like FFmpeg, the orphaned end is skipped,
	// rather than read as a packet of its own.
	const afterLostPage = await readPackets(concatList([
		...headerPages,
		oggPacketsPage({ granule: 312 + 960, sequence: 2 }, [OPUS_PACKET]),
		oggPacketsPage({ headerType: 1 | 4, granule: 312 + 2880, sequence: 4 }, [orphanedEnd, OPUS_PACKET]),
	]));
	expect(afterLostPage.packets.map(x => x.byteLength)).toEqual([3, 3]);
	expect(afterLostPage.lookups).toEqual(afterLostPage.packets);

	// The same where the orphaned end spans a whole page, and at the start of the stream
	const acrossPages = await readPackets(concatList([
		...headerPages,
		oggPacketsPage({ granule: 312 + 960, sequence: 2 }, [OPUS_PACKET]),
		oggPage({ headerType: 1, granule: -1, sequence: 4, lacing: [255], data: zeros(255) }),
		oggPacketsPage({ headerType: 1 | 4, granule: 312 + 2880, sequence: 5 }, [orphanedEnd, OPUS_PACKET]),
	]));
	expect(acrossPages.packets.map(x => x.byteLength)).toEqual([3, 3]);
	expect(acrossPages.lookups).toEqual(acrossPages.packets);

	const atStart = await readPackets(concatList([
		...headerPages,
		oggPacketsPage({ headerType: 1, granule: 312 + 960, sequence: 3 }, [orphanedEnd, OPUS_PACKET]),
		oggPacketsPage({ headerType: 4, granule: 312 + 1920, sequence: 4 }, [OPUS_PACKET]),
	]));
	expect(atStart.packets.map(x => x.byteLength)).toEqual([3, 3]);
	expect(atStart.lookups).toEqual(atStart.packets);

	// Where nothing but the orphaned end is on the page, its granule position still places the packets after it, and
	// lookups never return a packet after the timestamp
	const orphanOnly = await readPackets(concatList([
		...headerPages,
		oggPacketsPage({ granule: 312 + 960, sequence: 2 }, [OPUS_PACKET]),
		oggPacketsPage({ headerType: 1, granule: 312 + 1920, sequence: 4 }, [orphanedEnd]),
		oggPacketsPage({ granule: 312 + 2880, sequence: 5 }, [OPUS_PACKET]),
		oggPacketsPage({ headerType: 4, granule: 312 + 3840, sequence: 6 }, [OPUS_PACKET, OPUS_PACKET]),
	]));
	expect(orphanOnly.packets.map(x => x.byteLength)).toEqual([3, 3, 3, 3]);
	for (const [i, lookup] of orphanOnly.lookups.entries()) {
		expect(lookup.byteLength).toBe(3);
		expect(lookup.timestamp).toBeLessThanOrEqual(orphanOnly.packets[i]!.timestamp);
	}

	// Without lost pages, a page continuing a packet is read as before, here the first audio page, which begins with
	// the end of the comment header
	const tags = opusTags([ascii(`A=${'x'.repeat(600)}`)]);
	const intact = await readPackets(concatList([
		oggPacketsPage({ headerType: 2 }, [opusHead()]),
		oggPage({ granule: -1, sequence: 1, lacing: [255, 255], data: tags.subarray(0, 510) }),
		oggPage({
			headerType: 1,
			granule: 312 + 9600,
			sequence: 2,
			lacing: [tags.length - 510, ...Array<number>(10).fill(3)],
			data: concatList([tags.subarray(510), ...Array<Bytes>(10).fill(OPUS_PACKET)]),
		}),
		oggPacketsPage({ headerType: 4, granule: 312 + 19200, sequence: 3 }, Array<Bytes>(10).fill(OPUS_PACKET)),
	]));
	const intactTimestamps = intact.packets.map(x => Math.round(x.timestamp * 48000));
	expect(intactTimestamps).toEqual(Array.from({ length: 20 }, (_, i) => 960 * i));
	expect(intact.lookups).toEqual(intact.packets);
});

test('Ogg: Garbage between pages', async () => {
	const pages = opusPages({ pageCount: 40 });
	await expectGracefulRead(concatList(pages.flatMap((page, i) => i >= 2 ? [page, zeros(8)] : [page])));
});

test('Ogg: Reading goes on past garbage and empty pages between pages', async () => {
	// Like libogg and FFmpeg, skip whatever sits between two pages instead of ending the stream there
	const pages = opusPages({ pageCount: 10 });
	const file = concatList([
		...pages.slice(0, 2), // The header pages
		new Uint8Array(100).fill(0x4f), // Garbage made of 'O's
		...pages.slice(2, 6),
		oggPage({ granule: -1, sequence: 99, lacing: [], data: [] }), // A page without segments
		...pages.slice(6),
	]);

	for (const source of [new BufferSource(file), streamedSource(file)]) {
		using input = new Input({ source, formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;

		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			timestamps.push(Math.round(packet.timestamp * 48000));
		}
		expect(timestamps).toEqual(Array.from({ length: 100 }, (_, i) => 960 * i - 312));
	}
});

test('Ogg: Reading doesn\'t go on past garbage after damaged pages, into lost pages or another bitstream', async () => {
	const readTimestamps = async (file: Uint8Array) => {
		using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink((await input.getPrimaryAudioTrack())!).packets()) {
			timestamps.push(Math.round(packet.timestamp * 48000));
		}
		return timestamps;
	};
	const expectedTimestamps = (count: number) => Array.from({ length: count }, (_, i) => 960 * i - 312);

	// A page replaced by garbage: the audio after it would get wrong timestamps, so the stream ends there
	const pages = opusPages({ pageCount: 10 });
	const lostPage = new Uint8Array(pages[6]!.length).fill(0x4f);
	expect(await readTimestamps(concatList([...pages.slice(0, 6), lostPage, ...pages.slice(7)])))
		.toEqual(expectedTimestamps(40));

	// A chained file whose first link was cut off in the middle of a packet, and whose second link reuses the serial
	// number (as in a broken-off Icecast capture): the second link must not be read as a continuation of the first
	const firstLink = opusPages({ pageCount: 9, lastEos: false });
	const cutOffPage = oggPage({ granule: -1, sequence: 11, lacing: [255, 255], data: new Uint8Array(510).fill(0xf8) });
	const file = concat(...firstLink, cutOffPage.subarray(0, 100), ...opusPages({ pageCount: 10 }));
	expect(await readTimestamps(file)).toEqual(expectedTimestamps(90));

	// Bytes inserted into a page (as into sectors of game discs) damage it and make it end before where its header
	// says, and the pages after it are likely damaged too, so the stream ends after it
	const withInsertedBytes = concatList([
		...pages.slice(0, 5),
		concat(pages[5]!.subarray(0, 40), new Uint8Array(16).fill(0x99), pages[5]!.subarray(40)),
		...pages.slice(6),
	]);
	expect((await readTimestamps(withInsertedBytes)).length).toBeLessThanOrEqual(40);
});

test('Ogg: Pages without granule positions at the start', async () => {
	const pages = [oggPacketsPage({ headerType: 2 }, [opusHead()]), oggPacketsPage({ sequence: 1 }, [opusTags([])])];
	for (let i = 0; i < 20; i++) {
		pages.push(oggPacketsPage({
			headerType: i === 19 ? 4 : 0,
			granule: i < 5 ? -1 : 9600 * (i + 1),
			sequence: 2 + i,
		}, Array<Bytes>(10).fill(OPUS_PACKET)));
	}

	await expectGracefulRead(concatList(pages));
});

test('Ogg: Repeated header packets are not taken for audio', async () => {
	// Some muxers write the header pages twice, as in ExoPlayer's bear_duplicate_header.opus test file
	const readPackets = async (file: Uint8Array) => {
		using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
		const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
		const packets: [number, number][] = [];
		for await (const packet of sink.packets()) {
			packets.push([packet.timestamp, packet.byteLength]);
		}
		return packets;
	};

	const opusPageList = opusPages({ pageCount: 3 });
	const opusFile = concatList(opusPageList);
	const opusFileWithRepeatedHeaders = concatList([
		...opusPageList.slice(0, 2),
		...opusPageList.slice(0, 2),
		...opusPageList.slice(2),
	]);
	const opusPackets = await readPackets(opusFile);
	expect(opusPackets).toHaveLength(30);
	expect(await readPackets(opusFileWithRepeatedHeaders)).toEqual(opusPackets);

	// The Vorbis fixture's header packets fill its first two pages
	const vorbisFile = new Uint8Array(readFileSync(path.join(__dirname, '../public/vorbis-eos.ogg')));
	let headerPagesLength = 0;
	for (let i = 0; i < 2; i++) {
		const segmentCount = vorbisFile[headerPagesLength + 26]!;
		const lacing = vorbisFile.subarray(headerPagesLength + 27, headerPagesLength + 27 + segmentCount);
		headerPagesLength += 27 + segmentCount + lacing.reduce((a, b) => a + b, 0);
	}
	const vorbisFileWithRepeatedHeaders = concat(
		vorbisFile.subarray(0, headerPagesLength),
		vorbisFile.subarray(0, headerPagesLength),
		vorbisFile.subarray(headerPagesLength),
	);
	const vorbisPackets = await readPackets(vorbisFile);
	expect(vorbisPackets).toHaveLength(365);
	expect(await readPackets(vorbisFileWithRepeatedHeaders)).toEqual(vorbisPackets);
});

test('Ogg: Continuation page without a preceding packet', async () => {
	// Seeking couldn't step back from the continued packet and used to read a packet past the end of the page
	await expectGracefulRead(concat(
		oggPacketsPage({ headerType: 2 }, [opusHead()]),
		oggPacketsPage({ sequence: 1 }, [opusTags([])]),
		oggPage({
			headerType: 1, // Continuation, but with no packet before it
			granule: 1920,
			sequence: 2,
			lacing: [255, 255],
			data: new Uint8Array(510).fill(0xf8),
		}),
		oggPacketsPage({ headerType: 1, granule: 4800, sequence: 3 }, [OPUS_PACKET]),
		oggPacketsPage({ granule: 5760, sequence: 4 }, [OPUS_PACKET]),
		oggPacketsPage({ granule: -1, sequence: 5 }, [OPUS_PACKET, OPUS_PACKET]),
	));
});

test('Ogg: Packets can be looked up by their own timestamps despite granule positions off by a sample', async () => {
	// Some of the granule positions in VLC's vorbis-eos.ogg disagree with the packet durations by a sample, so the
	// timestamps derived from them differ from those of the same packets when iterating from the start
	const file = new Uint8Array(readFileSync(path.join(__dirname, '../public/vorbis-eos.ogg')));
	const iterated: { timestamp: number; sequenceNumber: number }[] = [];
	{
		using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
		for await (const packet of new EncodedPacketSink((await input.getPrimaryAudioTrack())!).packets()) {
			iterated.push({ timestamp: packet.timestamp, sequenceNumber: packet.sequenceNumber });
		}
	}
	expect(iterated).toHaveLength(365);

	// A fresh input for each lookup, so that it can't benefit from earlier ones
	const lookUp = async (timestamp: number) => {
		using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
		const packet = await new EncodedPacketSink((await input.getPrimaryAudioTrack())!).getPacket(timestamp);
		return packet && { timestamp: packet.timestamp, sequenceNumber: packet.sequenceNumber };
	};

	// Lookups return the same packet with the same timestamp as iteration
	const mismatches: number[] = [];
	for (const packet of iterated) {
		const found = await lookUp(packet.timestamp);
		if (found?.sequenceNumber !== packet.sequenceNumber || found.timestamp !== packet.timestamp) {
			mismatches.push(packet.timestamp);
		}
	}
	expect(mismatches).toEqual([]);

	// Also when looking up a timestamp within a packet
	for (const packet of iterated.filter((_, i) => i % 10 === 5)) {
		const found = await lookUp(packet.timestamp + 0.001);
		expect(found).toEqual({ timestamp: packet.timestamp, sequenceNumber: packet.sequenceNumber });
	}

	// Where the granule positions add up, a lookup less than a sample before a packet still returns the one before it
	const opusFile = concatList(opusPages({ pageCount: 3 }));
	using opusInput = new Input({ source: new BufferSource(opusFile), formats: ALL_FORMATS });
	const opusSink = new EncodedPacketSink((await opusInput.getPrimaryAudioTrack())!);
	const packetStart = (960 * 15 - 312) / 48000;
	for (const offset of [-1e-7, -1e-5, -2e-5]) {
		expect((await opusSink.getPacket(packetStart + offset))?.timestamp).toBeCloseTo((960 * 14 - 312) / 48000, 9);
	}
	expect((await opusSink.getPacket(packetStart))?.timestamp).toBeCloseTo(packetStart, 9);
});

test('Ogg: Many logical bitstreams', async () => {
	// Each bitstream used to scan all following pages for its second header packet
	const pages = Array.from(
		{ length: 20_000 },
		(_, i) => oggPacketsPage({ headerType: 2, serial: i + 1 }, [opusHead()]),
	);
	await expectGracefulRead(concatList(pages), /logical bitstreams/);
});

test('Ogg: Page header inside the last page', async () => {
	// Seeking to the last packet found the page header embedded in the last page's data, which continues a packet from
	// before the first page walked. Stepping back from it failed, and the lookup then read from past the page's end.
	const embeddedPage = oggPage({ headerType: 5, sequence: 3, lacing: [0], data: [] });
	await expectGracefulRead(concat(
		oggPacketsPage({ headerType: 2 }, [opusHead()]),
		oggPacketsPage({ sequence: 1 }, [opusTags([])]),
		oggPage({
			headerType: 1,
			granule: 9600,
			sequence: 2,
			lacing: [255],
			data: concat(zeros(173), embeddedPage, zeros(255 - 173 - embeddedPage.length)),
		}),
		zeros(1),
	));
});

test('Ogg: Seeking across a region full of fake page headers', async () => {
	// Every fake header found while bisecting used to have its CRC computed over the large amount of data it claims
	const junk = new Uint8Array(256 * 1024);
	for (let i = 0; i < junk.length; i += 4) {
		junk.set(ascii('OggS'), i);
	}

	const tailPages = Array.from({ length: 300 }, (_, i) => oggPacketsPage({
		headerType: i === 299 ? 4 : 0,
		granule: 9600 * (6 + i),
		sequence: 7 + i,
	}, Array<Bytes>(10).fill(new Uint8Array(30).fill(0xf8))));

	using input = new Input({
		source: new BufferSource(concatList([...opusPages({ pageCount: 5, lastEos: false }), junk, ...tailPages])),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getAudioTracks())[0]!);

	const start = performance.now();
	for (let timestamp = 0; timestamp < 60; timestamp += 3) {
		await sink.getPacket(timestamp);
	}

	expect(performance.now() - start).toBeLessThan(1000);
});

test('Ogg: Page chain jumping over the page found by bisection', async () => {
	// A page header inside another page's payload made the walk from the bisection skip that page and record the
	// pages out of order, after which stepping back to the last packet looped forever
	const hiddenPage = oggPage({
		headerType: 1,
		granule: 960,
		sequence: 9, // Out of sequence, so that it can't pass for a real page in the chain
		lacing: [255, 255, 255, 15],
		data: zeros(780),
	});
	const payload = new Uint8Array(2000).fill(0xf8);
	payload.set(hiddenPage, 1180);
	const file = concat(
		oggPacketsPage({ headerType: 2 }, [opusHead()]),
		oggPacketsPage({ sequence: 1 }, [opusTags([])]),
		oggPage({ granule: 1920, sequence: 2, lacing: Array<number>(8).fill(250), data: payload }),
		oggPage({ headerType: 1, granule: -1, sequence: 4, lacing: [255], data: zeros(255) }),
		zeros(100),
	);

	expect(evaluateWithDeadline(file, 'input => input.computeDuration()')).toBeCloseTo(0.0335);
	await expectGracefulRead(file);
});

test('Ogg: Short Opus identification header', async () => {
	await expectGracefulRead(concat(
		oggPacketsPage({ headerType: 2 }, [ascii('OpusHead')]),
		oggPacketsPage({ sequence: 1 }, [opusTags([])]),
	));
});

test('Ogg: Opus with zero channels', async () => {
	const head = opusHead();
	head[9] = 0; // Output channel count

	// As the only stream, the file can't be read
	const file = concat(oggPacketsPage({ headerType: 2 }, [head]), ...opusPages().slice(1));
	await expectGracefulRead(file, /Invalid Opus identification header/);

	// Next to a valid stream, it's skipped and the valid stream stays readable
	const multiplexedFile = concatList([
		oggPacketsPage({ headerType: 2, serial: 1 }, [opusHead()]),
		oggPacketsPage({ headerType: 2, serial: 2 }, [head]),
		oggPacketsPage({ serial: 1, sequence: 1 }, [opusTags([])]),
		oggPacketsPage({ serial: 2, sequence: 1 }, [opusTags([])]),
		oggPacketsPage({ headerType: 4, granule: 9600, serial: 1, sequence: 2 }, Array<Bytes>(10).fill(OPUS_PACKET)),
		oggPacketsPage({ headerType: 4, serial: 2, sequence: 2 }, []),
	]);
	using input = new Input({ source: new BufferSource(multiplexedFile), formats: ALL_FORMATS });
	expect(await input.getTracks()).toHaveLength(1);
	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getNumberOfChannels()).toBe(2);

	const packets = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	expect(packets).toHaveLength(10);
});

test('Ogg: Vorbis with zero sample rate next to a valid stream', async () => {
	const vorbisFile = new Uint8Array(readFileSync(path.join(__dirname, '../public/vorbis-eos.ogg')));
	vorbisFile.set(u32le(0), 28 + 12); // Sample rate field of the identification header

	// The Vorbis stream is skipped, and the Opus stream stays readable. All beginning-of-stream pages come first.
	const [opusBosPage, ...otherOpusPages] = opusPages();
	const file = concatList([opusBosPage!, vorbisFile, ...otherOpusPages]);
	await expectGracefulRead(file);

	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	expect(await input.getTracks()).toHaveLength(1);
	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getCodec()).toBe('opus');

	const packets = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	expect(packets).toHaveLength(100);
});

test('Ogg: Opus comments with many repeated keys', async () => {
	// Repeated keys used to copy the growing list of values each time
	const tags = opusTags(Array<Bytes>(100_000).fill(ascii('A=')));

	await expectGracefulRead(concatList([
		oggPacketsPage({ headerType: 2 }, [opusHead()]),
		...oggPagesForPacket(tags, 1),
		oggPacketsPage({ headerType: 4, granule: 9600, sequence: 100 }, Array<Bytes>(10).fill(OPUS_PACKET)),
	]));
});

test('Ogg: Short Vorbis identification header', async () => {
	const file = readFileSync(path.join(__dirname, '../public/vorbis-eos.ogg'));
	const firstPageLength = 27 + file[26]! + file.subarray(27, 27 + file[26]!).reduce((a, b) => a + b, 0);
	const serial = new DataView(file.buffer, file.byteOffset).getUint32(14, true);

	await expectGracefulRead(concat(
		oggPacketsPage({ headerType: 2, serial }, [[1, ...ascii('vorbis')]]),
		file.subarray(firstPageLength),
	));
});

test('Ogg: Vorbis with zero sample rate', async () => {
	const file = new Uint8Array(readFileSync(path.join(__dirname, '../public/vorbis-eos.ogg')));
	file.set(u32le(0), 28 + 12); // Sample rate field of the identification header
	await expectGracefulRead(file, /Invalid Vorbis identification header/);
});

test('Ogg: Gaps in granule positions', async () => {
	const readPackets = async (file: Uint8Array) => {
		using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
		const packets: { timestamp: number; duration: number; byteLength: number }[] = [];
		for await (const packet of new EncodedPacketSink((await input.getPrimaryAudioTrack())!).packets()) {
			packets.push({ timestamp: packet.timestamp, duration: packet.duration, byteLength: packet.byteLength });
		}
		return packets;
	};
	const lookUp = async (file: Uint8Array, timestamp: number) => {
		using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
		return (await new EncodedPacketSink((await input.getPrimaryAudioTrack())!).getPacket(timestamp))?.timestamp;
	};

	// Six pages of ten 20 ms Opus packets, with a second missing before the given page, as in a capture with a
	// dropout, and optionally samples trimmed off the end
	const opusFileWithGap = (gapBeforePage: number, trimmedSamples = 0) => {
		const pages = [
			oggPacketsPage({ headerType: 2 }, [opusHead()]),
			oggPacketsPage({ sequence: 1 }, [opusTags([])]),
		];
		for (let i = 0; i < 6; i++) {
			pages.push(oggPacketsPage({
				headerType: i === 5 ? 4 : 0,
				granule: 312 + 9600 * (i + 1) + (i >= gapBeforePage ? 48000 : 0) - (i === 5 ? trimmedSamples : 0),
				sequence: 2 + i,
			}, Array<Bytes>(10).fill(OPUS_PACKET)));
		}
		return concatList(pages);
	};
	const opusFile = opusFileWithGap(3);

	const opusTimestamps = (await readPackets(opusFile)).map(x => x.timestamp);
	expect(opusTimestamps).toHaveLength(60);
	expect(opusTimestamps[29]).toBeCloseTo(0.58, 10);
	expect(opusTimestamps[30]).toBeCloseTo(1.6, 10);
	expect(opusTimestamps[59]).toBeCloseTo(2.18, 10);

	// Lookups agree, and one within the gap returns the last packet before it
	for (const timestamp of opusTimestamps) {
		expect(await lookUp(opusFile, timestamp)).toBe(timestamp);
	}
	expect(await lookUp(opusFile, 1)).toBe(opusTimestamps[29]);

	// End trimming on the final page still applies after an earlier gap
	const trimmedPackets = await readPackets(opusFileWithGap(3, 100));
	expect(trimmedPackets[59]!.timestamp).toBeCloseTo(2.18, 10);
	expect(trimmedPackets[59]!.duration).toBeCloseTo(860 / 48000, 10);

	// On the final page itself, a gap and end trimming can't be told apart, as its granule position only gives their
	// difference. The stream still ends where that granule position says.
	const lastPacket = (await readPackets(opusFileWithGap(5, 100)))[59]!;
	expect(lastPacket.timestamp + lastPacket.duration).toBeCloseTo((9600 * 6 + 48000 - 100) / 48000, 10);

	// Where pages were lost, as their sequence numbers show, even a gap too short to count above counts, so that
	// iteration agrees with lookups, which go by the granule positions. Here, the page holding the 11th packet is
	// lost, either whole or holding the start of a packet that ends on the next page. That orphaned end isn't read as
	// a packet with #371, and isn't counted below either way.
	const lostPageFile = (withOrphanedEnd: boolean) => concatList([
		oggPacketsPage({ headerType: 2 }, [opusHead()]),
		oggPacketsPage({ sequence: 1 }, [opusTags([])]),
		oggPacketsPage({ granule: 312 + 9600, sequence: 2 }, Array<Bytes>(10).fill(OPUS_PACKET)),
		oggPacketsPage(
			{ headerType: withOrphanedEnd ? 1 : 0, granule: 312 + 20160, sequence: 4 },
			[...(withOrphanedEnd ? [zeros(10)] : []), ...Array<Bytes>(10).fill(OPUS_PACKET)],
		),
		oggPacketsPage({ headerType: 4, granule: 312 + 29760, sequence: 5 }, Array<Bytes>(10).fill(OPUS_PACKET)),
	]);
	for (const withOrphanedEnd of [false, true]) {
		const file = lostPageFile(withOrphanedEnd);
		const timestamps = (await readPackets(file)).filter(x => x.byteLength === 3).map(x => x.timestamp);
		expect(timestamps.map(x => Math.round(x * 48000))).toEqual([
			...Array.from({ length: 10 }, (_, i) => 960 * i),
			...Array.from({ length: 20 }, (_, i) => 10560 + 960 * i),
		]);
		for (const timestamp of timestamps) {
			expect(await lookUp(file, timestamp)).toBe(timestamp);
		}
	}

	// The same in Vorbis, with a second missing before the sixth page of a file whose granule positions are off by
	// a sample here and there, which isn't a gap
	const vorbisFile = new Uint8Array(readFileSync(path.join(__dirname, '../public/vorbis-eos.ogg')));
	const gappedVorbisFile = vorbisFile.slice();
	const view = new DataView(gappedVorbisFile.buffer);
	for (let pos = 0, pageIndex = 0; pos < gappedVorbisFile.length; pageIndex++) {
		const segmentCount = gappedVorbisFile[pos + 26]!;
		const lacing = gappedVorbisFile.subarray(pos + 27, pos + 27 + segmentCount);
		const pageSize = 27 + segmentCount + lacing.reduce((a, b) => a + b, 0);

		if (pageIndex >= 5 && view.getInt32(pos + 10, true) === 0) {
			view.setUint32(pos + 6, view.getUint32(pos + 6, true) + 44100, true);
			view.setUint32(pos + 22, 0, true);
			view.setUint32(pos + 22, oggCrc(gappedVorbisFile.subarray(pos, pos + pageSize)), true);
		}

		pos += pageSize;
	}

	const vorbisPackets = await readPackets(vorbisFile);
	for (let i = 1; i < vorbisPackets.length; i++) {
		const previous = vorbisPackets[i - 1]!;
		expect(vorbisPackets[i]!.timestamp).toBeCloseTo(previous.timestamp + previous.duration, 10);
	}

	const gappedVorbisPackets = await readPackets(gappedVorbisFile);
	expect(gappedVorbisPackets).toHaveLength(vorbisPackets.length);
	const firstShifted = gappedVorbisPackets.findIndex((x, i) => x.timestamp !== vorbisPackets[i]!.timestamp);
	expect(firstShifted).toBeGreaterThan(0);
	for (let i = firstShifted; i < vorbisPackets.length; i++) {
		expect(gappedVorbisPackets[i]!.timestamp).toBeCloseTo(vorbisPackets[i]!.timestamp + 1, 10);
	}
});

const opusPages = (options: { pageCount?: number; lastEos?: boolean } = {}) => {
	const pageCount = options.pageCount ?? 10;
	const pages = [oggPacketsPage({ headerType: 2 }, [opusHead()]), oggPacketsPage({ sequence: 1 }, [opusTags([])])];
	for (let i = 0; i < pageCount; i++) {
		pages.push(oggPacketsPage({
			headerType: options.lastEos !== false && i === pageCount - 1 ? 4 : 0,
			granule: 9600 * (i + 1),
			sequence: 2 + i,
		}, Array<Bytes>(10).fill(OPUS_PACKET)));
	}

	return pages;
};

const opusHead = () => concat(ascii('OpusHead'), [1, 2], u16le(312), u32le(48000), u16le(0), [0]);

const opusTags = (comments: Bytes[]) => concatList([
	ascii('OpusTags'),
	u32le(6),
	ascii('vendor'),
	u32le(comments.length),
	...comments.flatMap(comment => [u32le(comment.length), comment]),
]);

// For packets too big for a single page
const oggPagesForPacket = (packet: Uint8Array, firstSequence: number) => {
	const pages: Uint8Array[] = [];
	for (let offset = 0; offset < packet.length; offset += 255 * 255) {
		const data = packet.subarray(offset, offset + 255 * 255);
		const isLast = offset + data.length === packet.length;
		const lacing = Array<number>(Math.floor(data.length / 255)).fill(255);
		if (isLast) {
			lacing.push(data.length % 255);
		}

		pages.push(oggPage({
			headerType: offset === 0 ? 0 : 1,
			granule: isLast ? 0 : -1,
			sequence: firstSequence + pages.length,
			lacing,
			data,
		}));
	}

	return pages;
};

const oggPacketsPage = (options: Omit<OggPageOptions, 'lacing' | 'data'>, packets: Bytes[]) => oggPage({
	...options,
	lacing: packets.flatMap(packet => [
		...Array<number>(Math.floor(packet.length / 255)).fill(255),
		packet.length % 255,
	]),
	data: concatList(packets),
});

type OggPageOptions = {
	headerType?: number;
	granule?: number;
	serial?: number;
	sequence?: number;
	lacing: number[];
	data: Bytes;
};

const oggPage = (options: OggPageOptions) => {
	const page = concat(
		ascii('OggS'),
		[0, options.headerType ?? 0],
		u64le(options.granule ?? 0),
		u32le(options.serial ?? 1234),
		u32le(options.sequence ?? 0),
		zeros(4),
		[options.lacing.length],
		options.lacing,
		options.data,
	);
	new DataView(page.buffer).setUint32(22, oggCrc(page), true);

	return page;
};

const oggCrc = (bytes: Uint8Array) => {
	let crc = 0;
	for (const byte of bytes) {
		crc = ((crc << 8) ^ OGG_CRC_TABLE[(crc >>> 24) ^ byte]!) >>> 0;
	}

	return crc;
};

test('FLAC: Without frames', async () => {
	// Looking for a packet used to loop forever
	await expectGracefulRead(flacFile(0));
});

test('FLAC: Too small for a STREAMINFO block', async () => {
	await expectGracefulRead(concat(ascii('fLaC'), zeros(5)));
});

test('FLAC: Short STREAMINFO block', async () => {
	await expectGracefulRead(concat(ascii('fLaC'), flacBlock(0, streamInfo().subarray(0, 16), true), zeros(64)));
});

test('FLAC: Metadata blocks extending past the end of the file', async () => {
	await expectGracefulRead(concat(ascii('fLaC'), flacBlock(0, streamInfo(), true, 0xffffff)));
	await expectGracefulRead(concat(ascii('fLaC'), flacBlock(0, streamInfo()), flacBlock(4, zeros(8), true, 0xffffff)));
	await expectGracefulRead(concat(ascii('fLaC'), flacBlock(0, streamInfo()), flacBlock(6, zeros(8), true, 0xffffff)));
});

test('FLAC: Without a last metadata block', async () => {
	await expectGracefulRead(concat(ascii('fLaC'), flacBlock(0, streamInfo())));
});

test('FLAC: Picture with oversized MIME type length', async () => {
	await expectGracefulRead(flacFile(20, flacBlock(6, concat(u32(3), u32(1000), zeros(8)), true)));
});

test('FLAC: With zero sample rate', async () => {
	await expectGracefulRead(concat(
		ascii('fLaC'),
		flacBlock(0, streamInfo(0), true),
		...Array.from({ length: 5 }, (_, i) => flacFrame(i, 0)),
	));
});

test('FLAC: Invalid first frame', async () => {
	const invalidFrameHeader = [0xff, 0xf8, 0x09, 0x08, 0, 0];
	await expectGracefulRead(concat(ascii('fLaC'), flacBlock(0, streamInfo(), true), invalidFrameHeader, zeros(20)));
});

test('FLAC: Truncated frame header at the end of the file', async () => {
	await expectGracefulRead(concat(flacFile(3), [0xff, 0xf8, 0x89, 0x08, 0xfe, 0x80]));
});

test('FLAC: Comments with many repeated keys', async () => {
	const comments = Array<Bytes>(100_000).fill(concat(u32le(2), ascii('A=')));
	await expectGracefulRead(flacFile(20, flacBlock(4, concat(u32le(0), u32le(100_000), concatList(comments)), true)));
});

test('FLAC: Comment count exceeding the block', async () => {
	await expectGracefulRead(flacFile(20, flacBlock(4, concat(u32le(0), u32le(5)), true)));
});

test('FLAC: Comment picture with huge MIME type', async () => {
	// The MIME type used to be spread into a function call, overflowing the stack
	const picture = concat(u32(3), u32(200_000), zeros(200_000 + 4 + 16 + 4));
	const comment = `METADATA_BLOCK_PICTURE=${Buffer.from(picture).toString('base64')}`;
	await expectGracefulRead(flacFile(20, flacCommentBlock(comment)));
});

test('FLAC: Comment picture with invalid contents', async () => {
	await expectGracefulRead(flacFile(20, flacCommentBlock('METADATA_BLOCK_PICTURE=!!!!')));
	await expectGracefulRead(flacFile(20, flacCommentBlock('METADATA_BLOCK_PICTURE=AAAA')));
});

const flacFile = (frameCount: number, lastMetadataBlock?: Bytes) => concat(
	ascii('fLaC'),
	lastMetadataBlock ? concat(flacBlock(0, streamInfo()), lastMetadataBlock) : flacBlock(0, streamInfo(), true),
	...Array.from({ length: frameCount }, (_, i) => flacFrame(i)),
);

const flacCommentBlock = (comment: string) => {
	return flacBlock(4, concat(u32le(0), u32le(1), u32le(comment.length), ascii(comment)), true);
};

const flacBlock = (type: number, body: Bytes, last = false, size = body.length) => {
	return concat([(last ? 0x80 : 0) | type], u24(size), body);
};

// Mono, 16-bit, 256 samples per block
const streamInfo = (sampleRate = 44100) => concat(
	u16(256),
	u16(256),
	u24(0),
	u24(0),
	[(sampleRate >> 12) & 0xff, (sampleRate >> 4) & 0xff, (sampleRate & 0xf) << 4, 0xf0, 0, 0, 0, 0],
	zeros(16),
);

// Fixed block size of 256 samples, 44.1 kHz unless the rate bits say otherwise, with a constant subframe
const flacFrame = (frameNumber: number, rateBits = 0b1001) => {
	const header = [0xff, 0xf8, (0b1000 << 4) | rateBits, 0b100 << 1, frameNumber & 0x7f];
	return concat(header, [flacCrc8(header)], zeros(5));
};

const flacCrc8 = (bytes: number[]) => {
	let crc = 0;
	for (const byte of bytes) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) {
			crc = ((crc & 0x80) ? ((crc << 1) ^ 0x07) : (crc << 1)) & 0xff;
		}
	}

	return crc;
};

test('ADTS: Frame with zero length', async () => {
	// The frame used to be read again and again without advancing, piling up packets forever
	await expectGracefulRead(concat(adtsHeader(0), zeros(16)));
});

test('ADTS: Frame with reserved sampling frequency index', async () => {
	await expectGracefulRead(concatList(Array.from({ length: 5 }, () => adtsFrame(10, 13))));
});

test('ADTS: Bare frame header at the end of the file', async () => {
	await expectGracefulRead(concat(...Array.from({ length: 5 }, () => adtsFrame(10)), adtsHeader(7)));
	await expectGracefulRead(concat(adtsHeader(7), [0]));
});

test('WAV: With zero block alignment', async () => {
	await expectGracefulRead(wav([fmtChunk({ blockAlign: 0 }), dataChunk()]));
});

test('WAV: With zero sample rate', async () => {
	await expectGracefulRead(wav([fmtChunk({ sampleRate: 0 }), dataChunk()]));
});

test('WAV: With zero channels', async () => {
	// The PCM decoder used to compute an infinite number of frames
	await expectGracefulDecode(wav([fmtChunk({ channels: 0 }), dataChunk()]));
});

test('WAV: Short fmt chunk', async () => {
	await expectGracefulRead(wav([riffChunk('fmt ', zeros(4)), dataChunk()]));
});

test('WAV: Empty LIST chunk', async () => {
	await expectGracefulRead(wav([fmtChunk(), riffChunk('LIST', []), dataChunk()]));
});

test('WAV: LIST sub-chunk exceeding its parent', async () => {
	const list = riffChunk('LIST', concat(ascii('INFOINAM'), u32le(1000), ascii('abcd')));
	await expectGracefulRead(wav([fmtChunk(), list, dataChunk()]));
});

test('WAV: LIST with very long string', async () => {
	const longString = new Uint8Array(300_000).fill(0x41);
	const list = riffChunk('LIST', concat(ascii('INFOINAM'), u32le(longString.length), longString));
	await expectGracefulRead(wav([fmtChunk(), list, dataChunk(1024)]));
});

test('WAV: Short ds64 chunk', async () => {
	await expectGracefulRead(wav([riffChunk('ds64', zeros(4)), fmtChunk(), dataChunk()], 'RF64'));
});

test('WAV: Short id3 chunk', async () => {
	await expectGracefulRead(wav([fmtChunk(), riffChunk('id3 ', ascii('ID3\x03')), dataChunk()]));
});

test('WAV: Block alignment not matching the channel count', async () => {
	// The PCM decoder used to compute a fractional number of frames
	await expectGracefulDecode(wav([fmtChunk({ channels: 3, blockAlign: 4 }), dataChunk()]));
});

test('WAV: Block alignment not matching the sample size', async () => {
	// The duration and timestamps used to go by the block alignment, while the samples are decoded by their bit depth.
	// A block alignment too small for the samples, or one the byte rate disagrees with, is now overruled.
	const readTimeline = async (fmt: Bytes) => {
		using input = new Input({ source: new BufferSource(wav([fmt, dataChunk()])), formats: ALL_FORMATS });
		const duration = await input.computeDuration();

		let frameCount = 0;
		for await (const sample of new AudioSampleSink((await input.getAudioTracks())[0]!).samples()) {
			expect(Math.round(sample.timestamp * 44100)).toBe(frameCount);
			frameCount += sample.numberOfFrames;
			sample.close();
		}
		return { duration, frameCount };
	};

	expect(await readTimeline(fmtChunk({ blockAlign: 2 }))).toEqual({ duration: 1, frameCount: 44100 });
	expect(await readTimeline(fmtChunk({ blockAlign: 8, bytesPerSecond: 44100 * 4 })))
		.toEqual({ duration: 1, frameCount: 44100 });

	// A larger block alignment that the byte rate agrees with is kept, like for 24-bit samples in 4-byte containers
	using input = new Input({
		source: new BufferSource(wav([fmtChunk({ bitsPerSample: 24, blockAlign: 8 }), dataChunk()])),
		formats: ALL_FORMATS,
	});
	expect(await input.computeDuration()).toBe(0.5);
});

const wav = (chunks: Bytes[], riffType = 'RIFF') => {
	const body = concatList(chunks);
	return concat(ascii(riffType), u32le(4 + body.length), ascii('WAVE'), body);
};

const fmtChunk = (options: {
	channels?: number;
	sampleRate?: number;
	blockAlign?: number;
	bytesPerSecond?: number;
	bitsPerSample?: number;
} = {}) => {
	const channels = options.channels ?? 2;
	const sampleRate = options.sampleRate ?? 44100;
	const blockAlign = options.blockAlign ?? 4;

	return riffChunk('fmt ', concat(
		u16le(1),
		u16le(channels),
		u32le(sampleRate),
		u32le(options.bytesPerSecond ?? sampleRate * blockAlign),
		u16le(blockAlign),
		u16le(options.bitsPerSample ?? 16),
	));
};

const dataChunk = (size = 44100 * 4) => riffChunk('data', zeros(size));

const riffChunk = (id: string, body: Bytes) => concat(ascii(id), u32le(body.length), body, zeros(body.length % 2));

test('ID3: Unsynchronized tag with many frames', async () => {
	// Each frame used to undo the unsynchronization on a fresh copy of the entire tag
	const frames = Array.from({ length: 50_000 }, () => id3Frame('ABCD', [0]));
	await expectGracefulRead(concat(id3Tag(4, 0x80, concatList(frames)), flacFile(3)));
});

test('ID3: Short extended header', async () => {
	await expectGracefulRead(concat(id3Tag(3, 0x40, [0, 0]), flacFile(3)));
});

test('ID3: Frame extending past the tag', async () => {
	await expectGracefulRead(concat(id3Tag(3, 0, concat(ascii('TIT2'), u32(5), [0, 0])), flacFile(3)));
});

test('ID3v2.2: Picture at the end of the tag', async () => {
	await expectGracefulRead(
		concat(id3Tag(2, 0, concat(ascii('PIC'), [0, 0, 1, 0])), flacFile(3)),
		/Invalid ID3v2 PIC frame: too short/,
	);
});

test('ID3: Comment frame shorter than its fixed fields', async () => {
	await expectGracefulRead(
		concat(id3Tag(3, 0, id3Frame('COMM', [0, 0x65])), flacFile(3)),
		/Invalid ID3v2 COMM frame: too short/,
	);
});

const id3Tag = (majorVersion: number, flags: number, body: Bytes) => {
	return concat(ascii('ID3'), [majorVersion, 0, flags], synchsafe(body.length), body);
};

const id3Frame = (id: string, data: Bytes) => concat(ascii(id), synchsafe(data.length), [0, 0], data);

const synchsafe = (value: number) => [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f];

test('HLS: Billion laughs variable substitution', async () => {
	let playlist = '#EXTM3U\n#EXT-X-DEFINE:NAME="v0",VALUE="aaaaaaaaaa"\n';
	for (let i = 1; i <= 9; i++) {
		playlist += `#EXT-X-DEFINE:NAME="v${i}",VALUE="${`{$v${i - 1}}`.repeat(10)}"\n`;
	}
	playlist += '#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg.ts\n#EXT-X-ENDLIST\n';

	await expectGracefulRead(hlsSource({ 'index.m3u8': playlist, 'seg.ts': hlsSegment() }), /excessive/);
});

test('HLS: Variable substitution blown up across many URIs', async () => {
	// Each level alone stays small, but every segment URI expands to 100 MB
	let playlist = '#EXTM3U\n#EXT-X-DEFINE:NAME="v0",VALUE="aaaaaaaaaa"\n';
	for (let i = 1; i <= 7; i++) {
		playlist += `#EXT-X-DEFINE:NAME="v${i}",VALUE="${`{$v${i - 1}}`.repeat(10)}"\n`;
	}
	playlist += '#EXT-X-TARGETDURATION:10\n' + `#EXTINF:10,\nx{$v7}\n`.repeat(50) + '#EXT-X-ENDLIST\n';

	await expectGracefulRead(hlsSource({ 'index.m3u8': playlist }), /excessive/);
});

test('HLS: Many variant streams', async () => {
	// Pairing variants with each other used to be quadratic, using ever-growing bit masks
	const playlist = '#EXTM3U\n' + Array.from(
		{ length: 20_000 },
		(_, i) => `#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.64001f,mp4a.40.2"\nv${i}.m3u8\n`,
	).join('');

	await expectGracefulRead(hlsSource({ 'index.m3u8': playlist }), /too many/);
});

test('HLS: Variant streams times media tags', async () => {
	// Every variant used to get its own track for every media tag of its group
	let playlist = '#EXTM3U\n';
	for (let i = 0; i < 3000; i++) {
		playlist += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="n${i}",URI="a${i}.m3u8"\n`;
	}
	for (let i = 0; i < 3000; i++) {
		playlist += `#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="mp4a.40.2",AUDIO="a"\nv${i}.m3u8\n`;
	}

	await expectGracefulRead(hlsSource({ 'index.m3u8': playlist }), /too many/);
});

test('HLS: Invalid pssh boxes in key URIs', async () => {
	const psshBoxes = [
		concat(u32(32), ascii('pssh'), [1, 0, 0, 0], zeros(16), u32(0xffffffff)), // Huge key ID count
		concat(u32(8), ascii('pssh')),
	];
	const dataUris = [
		...psshBoxes.map(box => `data:text/plain;base64,${Buffer.from(box).toString('base64')}`),
		'data:text/plain;base64,!!!!',
	];

	for (const uri of dataUris) {
		await expectGracefulRead(hlsSource({
			'index.m3u8': `#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.widevine",URI="${uri}"\n`
				+ '#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n',
			'seg.ts': hlsSegment(),
		}));
	}
});

test('HLS: Live playlist with zero target duration', async () => {
	// The playlist used to be reloaded in a busy loop, starving the event loop
	let requestCount = 0;
	const source = hlsSource({
		'index.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:0\n#EXTINF:1,\nseg.ts\n',
		'seg.ts': hlsSegment(),
	}, () => requestCount++);

	const input = new Input({ source, formats: ALL_FORMATS });
	const sink = new EncodedPacketSink((await input.getAudioTracks())[0]!);
	const iteration = (async () => {
		for await (const packet of sink.packets()) {
			void packet;
		}
	})().catch(() => {});

	await new Promise(resolve => setTimeout(resolve, 1500));
	input.dispose();
	await iteration;

	expect(requestCount).toBeLessThan(10);
});

test('HLS: Overflowing durations', async () => {
	await expectGracefulRead(hlsSource({
		'index.m3u8': '#EXTM3U\n#EXTINF:1e308,\nseg.ts\n#EXTINF:1e308,\nseg.ts?2\n#EXTINF:1,\nseg.ts?3\n'
			+ '#EXT-X-ENDLIST\n',
		'seg.ts': hlsSegment(),
	}), /EXTINF/);
	await expectGracefulRead(hlsSource({
		'index.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:1e300\n#EXT-X-MEDIA-SEQUENCE:1000000000\n#EXTINF:1,\nseg.ts\n'
			+ '#EXT-X-ENDLIST\n',
		'seg.ts': hlsSegment(),
	}), /TARGETDURATION/);
	await expectGracefulRead(hlsSource({
		'index.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1e300\n#EXTINF:1,\nseg.ts\n'
			+ '#EXT-X-ENDLIST\n',
		'seg.ts': hlsSegment(),
	}), /MEDIA-SEQUENCE/);
});

test('HLS: QUERYPARAM with malformed percent-encoding', async () => {
	using input = new Input({
		source: hlsSource({
			'index.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="mp4a.40.2"\nv.m3u8?x=%E0%A4%A\n',
			'v.m3u8': '#EXTM3U\n#EXT-X-DEFINE:QUERYPARAM="x"\n#EXTINF:1,\nseg{$x}.ts\n#EXT-X-ENDLIST\n',
		}),
		formats: ALL_FORMATS,
	});

	const sink = new EncodedPacketSink((await input.getAudioTracks())[0]!);

	// Used to be a URIError
	await expect(sink.getFirstPacket()).rejects.toThrow(/query parameter/);
});

test('HLS: Variant stream pointing at a huge file that is no playlist', async () => {
	// The file used to be read in its entirety before checking if it's even a playlist
	let bytesRead = 0;
	const hugeFile = new CustomSource({
		getSize: () => 2 ** 32,
		read: (start, end) => {
			bytesRead += end - start;
			return new Uint8Array(end - start);
		},
	});

	const masterPlaylist = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="mp4a.40.2"\nv.m3u8\n';
	using input = new Input({
		source: new CustomPathedSource('index.m3u8', ({ path: filePath }) => filePath === 'index.m3u8'
			? new BufferSource(new TextEncoder().encode(masterPlaylist))
			: hugeFile,
		),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getAudioTracks())[0]!);

	await expect(sink.getFirstPacket()).rejects.toThrow(/EXTM3U/);
	expect(bytesRead).toBeLessThan(2 ** 24);
});

test('HLS: Playlist codec not matching the media data', async () => {
	// The track's codec comes from the playlist, but its decoder config from the media data, which has none
	using input = new Input({
		source: hlsSource({
			'index.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="vp8"\nmedia.m3u8\n',
			'media.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nseg.webm\n#EXT-X-ENDLIST\n',
			'seg.webm': matroska(info(), tracks(videoTrack(1, 'V_UNKNOWN')), cluster(0, simpleBlock(1, 0, 0x80))),
		}),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getVideoTracks())[0]!);

	await expect(sink.getFirstPacket({ verifyKeyPackets: true })).rejects.toThrow(/doesn't match the codec/);
});

const hlsSource = (files: Record<string, string | Uint8Array>, onRequest?: () => void) => {
	return new CustomPathedSource('index.m3u8', ({ path: filePath }) => {
		onRequest?.();
		const file = files[filePath.split('?')[0]!];
		if (file === undefined) {
			throw new Error(`No such file: ${filePath.slice(0, 100)}`);
		}

		return new BufferSource(typeof file === 'string' ? new TextEncoder().encode(file) : file);
	});
};

const hlsSegment = () => readFileSync(path.join(__dirname, '../public/mp3.ts')).subarray(0, 188 * 60);

test('Key packet verification with timestamps beyond float precision', async () => {
	// Stepping back from the fake key frame by one time unit is a no-op at this magnitude, so it used to request the
	// very same packet forever
	const realKeyFrame = [0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x10, 0x00, 0x10, 0x00];
	const fakeKeyFrame = [0x01, 0x00, 0x00];
	using input = new Input({
		source: new BufferSource(matroska(
			info(),
			tracks(videoTrack(1)),
			cluster(0, simpleBlock(1, 0, 0x80, realKeyFrame)),
			cluster(2 ** 62, simpleBlock(1, 0, 0x80, fakeKeyFrame)),
		)),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getVideoTracks())[0]!);

	const packet = await sink.getKeyPacket(Infinity, { verifyKeyPackets: true });
	expect(packet!.timestamp).toBe(0);
});

test('Key packet verification in a big fragment of fake key frames', async () => {
	// Each step back to the previous key frame used to scan all of the fragment's (or cluster's) samples, making
	// verification quadratic in their number. Count the key frame flags read rather than time it, to be independent
	// of machine speed.
	const sampleCount = 5000;
	const realKeyFrame = [0x00, 0x00, 0x00];
	const fakeKeyFrame = [0x01, 0x00, 0x00];
	const fragment = (dataOffset: number) => moof(
		fullBox('tfhd', 0, 0x020038, u32(1), u32(1), u32(3), u32(0)), // Default duration 1, size 3, key frames
		fullBox('tfdt', 0, 0, u32(0)),
		fullBox('trun', 0, 0x000001, u32(sampleCount), u32(dataOffset)),
	);
	const moov = [
		trak({ handler: 'vide', stbl: [stsd(videoSampleEntry('vp08')), ...emptyStbl().slice(1)] }),
		box('mvex', trex(1)),
	];
	const data = concat(realKeyFrame, ...Array<Bytes>(sampleCount - 1).fill(fakeKeyFrame));
	using input = new Input({
		source: new BufferSource(mp4(moov, [fragment(fragment(0).length + 8), box('mdat', data)])),
		formats: ALL_FORMATS,
	});
	const track = (await input.getVideoTracks())[0]!;
	const sink = new EncodedPacketSink(track);
	const flagReads = countKeyFrameFlagReads(await loadedSamples(track, sink));

	const packet = await sink.getKeyPacket(Infinity, { verifyKeyPackets: true });
	expect(packet!.timestamp).toBe(0);
	expect(flagReads.count).toBeGreaterThanOrEqual(sampleCount - 1); // Every sample was stepped through
	expect(flagReads.count).toBeLessThan(10 * sampleCount);

	// The same in a Matroska cluster
	const blocks = [simpleBlock(1, 0, 0x80, [0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x10, 0x00, 0x10, 0x00])];
	for (let i = 1; i < sampleCount; i++) {
		blocks.push(simpleBlock(1, i, 0x80, fakeKeyFrame));
	}
	using matroskaInput = new Input({
		source: new BufferSource(matroska(info(), tracks(videoTrack(1)), cluster(0, concatList(blocks)))),
		formats: ALL_FORMATS,
	});
	const matroskaTrack = (await matroskaInput.getVideoTracks())[0]!;
	const matroskaSink = new EncodedPacketSink(matroskaTrack);
	const matroskaFlagReads = countKeyFrameFlagReads(await loadedSamples(matroskaTrack, matroskaSink));

	const matroskaPacket = await matroskaSink.getKeyPacket(Infinity, { verifyKeyPackets: true });
	expect(matroskaPacket!.timestamp).toBe(0);
	expect(matroskaFlagReads.count).toBeGreaterThanOrEqual(sampleCount - 1);
	expect(matroskaFlagReads.count).toBeLessThan(10 * sampleCount);
});

// The samples of the fragment (or cluster) holding the track's first packet, as the demuxer holds them in memory, found
// through the packet's location
const loadedSamples = async (track: { _backing: unknown }, sink: EncodedPacketSink) => {
	type Flags = { isKeyFrame: boolean }[];
	type Location = { fragment?: Group; cluster?: Group };
	type Group = { trackData: Map<number, { samples?: Flags; blocks?: Flags }> };
	const backing = track._backing as {
		packetToFragmentLocation?: WeakMap<object, Location>;
		packetToClusterLocation?: WeakMap<object, Location>;
	};

	const packet = (await sink.getFirstPacket())!;
	const location = (backing.packetToFragmentLocation ?? backing.packetToClusterLocation)!.get(packet)!;
	const trackData = [...(location.fragment ?? location.cluster)!.trackData.values()][0]!;
	return (trackData.samples ?? trackData.blocks)!;
};

const countKeyFrameFlagReads = (samples: { isKeyFrame: boolean }[]) => {
	const reads = { count: 0 };
	for (const sample of samples) {
		const isKeyFrame = sample.isKeyFrame;
		Object.defineProperty(sample, 'isKeyFrame', {
			get: () => {
				reads.count++;
				return isKeyFrame;
			},
		});
	}

	return reads;
};

test('PCM blocks not containing whole frames', async () => {
	for (const channels of [2, 0]) {
		const audioTrack = element(
			EBMLId.TrackEntry,
			uintElement(EBMLId.TrackNumber, 1),
			uintElement(EBMLId.TrackType, 2),
			element(EBMLId.CodecID, ascii('A_PCM/INT/LIT')),
			element(
				EBMLId.Audio,
				element(EBMLId.SamplingFrequency, float64(48000)),
				uintElement(EBMLId.Channels, channels),
				uintElement(EBMLId.BitDepth, 16),
			),
		);
		const blocks = [simpleBlock(1, 0, 0x80, zeros(5)), simpleBlock(1, 10, 0x80, zeros(5))];

		await expectGracefulDecode(matroska(info(), tracks(audioTrack), cluster(0, ...blocks)));
	}
});

test('Custom source smaller than the first read', async () => {
	// Reads past the end used to trip up the read orchestrator once it learned the file size
	for (const size of [0, 3]) {
		await expectGracefulRead(new CustomSource({
			getSize: () => size,
			read: () => new Uint8Array(size),
		}));
		await expectGracefulRead(new CustomSource({
			getSize: async () => size,
			read: async () => new Uint8Array(size),
		}));
	}
});

const float64 = (value: number) => {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setFloat64(0, value);
	return bytes;
};

const expectGracefulRead = async (fileOrSource: Uint8Array | Source, expectedError?: RegExp) => {
	const source = fileOrSource instanceof Uint8Array ? new BufferSource(fileOrSource) : fileOrSource;
	const errors = await readEverything(source);

	for (const error of errors) {
		expect(error).not.toMatch(UNINTENDED_ERROR);
	}

	if (expectedError) {
		expect(errors.some(x => expectedError.test(x))).toBe(true);
	}
};

// A synchronous infinite loop stalls the whole file, since the test timeout can't fire while the event loop is blocked.
// Reads that once looped like that run in a child process with a deadline instead, so that a regression fails fast.
const evaluateWithDeadline = (file: Uint8Array, readFunction: string) => {
	const script = `import(${JSON.stringify(new URL('../../src/index.ts', import.meta.url).href)}).then(async (mb) => {
		const source = new mb.BufferSource(require('node:fs').readFileSync(0));
		const input = new mb.Input({ source, formats: mb.ALL_FORMATS });
		console.log(JSON.stringify(await (${readFunction})(input)));
	});`;

	let output: string;
	try {
		output = execFileSync(process.execPath, ['--import', 'tsx', '-e', script], {
			input: file,
			encoding: 'utf8',
			timeout: 10_000,
		});
	} catch (error) {
		if ((error as { code?: string }).code === 'ETIMEDOUT') {
			throw new Error('The read hung (killed after 10 s).');
		}

		throw error;
	}

	return JSON.parse(output.trim().split('\n').pop()!) as unknown;
};

// The file size stays unknown
const streamedSource = (file: Uint8Array) => new ReadableStreamSource(new ReadableStream<Uint8Array>({
	start(controller) {
		controller.enqueue(file);
		controller.close();
	},
}));

// PCM decoding works without WebCodecs, so this runs fine in Node
const expectGracefulDecode = async (file: Uint8Array) => {
	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const frameCounts: number[] = [];

	try {
		const sink = new AudioSampleSink((await input.getAudioTracks())[0]!);
		for await (const sample of sink.samples()) {
			frameCounts.push(sample.numberOfFrames);
			sample.close();
		}
	} catch (error) {
		expect(String(error)).not.toMatch(UNINTENDED_ERROR);
	}

	expect(frameCounts.every(Number.isInteger)).toBe(true);
};

const countPackets = async (input: Input) => {
	const sink = new EncodedPacketSink((await input.getTracks())[0]!);

	let count = 0;
	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		void packet;
		count++;
	}

	return count;
};

const readEverything = async (source: Source) => {
	const errors: string[] = [];
	const attempt = async <T>(fn: () => Promise<T>) => {
		try {
			return await fn();
		} catch (error) {
			errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
			return null;
		}
	};

	using input = new Input({ source, formats: ALL_FORMATS });
	if (!await attempt(() => input.getFormat())) {
		return errors;
	}

	await attempt(() => input.getMimeType());
	await attempt(() => input.getMetadataTags());
	await attempt(() => input.computeDuration());
	await attempt(() => input.getDurationFromMetadata());

	for (const track of await attempt(() => input.getTracks()) ?? []) {
		await attempt(() => track.getCodecParameterString());
		await attempt(() => track.computePacketStats(100));
		if (track.isVideoTrack()) {
			await attempt(() => track.getDecoderConfig());
			await attempt(() => track.getPixelAspectRatio());
			await attempt(() => track.getColorSpace());
		} else if (track.isAudioTrack()) {
			await attempt(() => track.getDecoderConfig());
		}

		const sink = new EncodedPacketSink(track);
		await attempt(async () => {
			let count = 0;
			for await (const packet of sink.packets()) {
				if (count++ === 0) {
					await track.determinePacketType(packet);
				}
				if (count === 1000) {
					break;
				}
			}
		});
		await attempt(async () => {
			let packet = await sink.getFirstKeyPacket({ verifyKeyPackets: true });
			for (let i = 0; packet && i < 50; i++) {
				packet = await sink.getNextKeyPacket(packet, { verifyKeyPackets: true });
			}
		});

		for (const timestamp of [0, 0.5, 2, 1e6]) {
			await attempt(() => sink.getPacket(timestamp));
			await attempt(() => sink.getKeyPacket(timestamp, { verifyKeyPackets: true }));
		}
	}

	return errors;
};

type Bytes = Uint8Array | number[];

const concat = (...parts: Bytes[]) => concatList(parts);

// For huge numbers of parts, which would overflow the stack when spread into arguments
const concatList = (parts: Bytes[]) => {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}

	return result;
};

const u64le = (value: number) => u64(value).reverse();
const u64 = (value: number) => [...u32(Math.floor(value / 2 ** 32)), ...u32(value >>> 0)];
const u32le = (value: number) => u32(value).reverse();
const u32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u24 = (value: number) => [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u16le = (value: number) => u16(value).reverse();
const u16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const u8 = (value: number) => [value & 0xff];
const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
const zeros = (length: number) => new Uint8Array(length);
