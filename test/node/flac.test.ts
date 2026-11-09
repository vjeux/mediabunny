import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { assert, toDataView, toUint8Array } from '../../src/misc.js';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS, FLAC } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { calculateCrc16, calculateCrc8 } from '../../src/flac/flac-misc.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { FlacOutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { VERSIONED_NAME } from '../../src/version.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('can loop over all samples', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.computeDuration()).toEqual(19.714285714285715);
	expect(await track.getDecoderConfig()).toEqual({
		codec: 'flac',
		numberOfChannels: 2,
		sampleRate: 44100,
		description: new Uint8Array([
			102, 76, 97, 67, 128, 0, 0, 34, 16, 0, 16, 0, 0, 6, 45, 0, 37, 173, 10,
			196, 66, 240, 0, 13, 68, 24, 85, 22, 231, 0, 113, 139, 185, 1, 33, 54,
			155, 80, 241, 191, 203, 112,
		]),
	});
	expect(await track.getCodecParameterString()).toEqual('flac');
	expect(await track.getTimeResolution()).toEqual(44100);
	expect(await input.getMimeType()).toEqual('audio/flac');

	const sink = new EncodedPacketSink(track);
	let samples = 0;
	let lastSampleTimestamp = 0;
	for await (const sample of sink.packets()) {
		samples++;
		lastSampleTimestamp = sample.timestamp;
		if (sample.sequenceNumber === 212) {
			// Last frame is a bit shorter
			// due it having a custom block size and the duration not being a multiple of the frame size
			expect(sample.duration).toEqual(0.023764172335600908);
		} else {
			expect(sample.duration).toEqual(0.09287981859410431);
		}
	}
	expect(samples).toBe(213);
	expect(lastSampleTimestamp).toBe(19.690521541950112);
});

test('can do random access', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const packetSink = new EncodedPacketSink(track);

	const packet = await packetSink.getPacket(10);
	assert(packet);
	expect(packet.timestamp).toBe(9.93814058956916);
	expect(packet.data.byteLength).toBe(8345);
	expect(packet.sequenceNumber).toBe(107);
	expect(packet.duration).toBe(0.09287981859410431);

	const nextPacket = await packetSink.getNextPacket(packet);
	assert(nextPacket);
	expect(nextPacket.timestamp).toBe(10.031020408163265);
	expect(nextPacket.data.byteLength).toBe(8988);
	expect(nextPacket.sequenceNumber).toBe(108);
	expect(nextPacket.duration).toBe(0.09287981859410431);

	const priorPacket = await packetSink.getPacket(3);
	assert(priorPacket);
	expect(priorPacket.timestamp).toBe(2.972154195011338);
	expect(priorPacket.data.byteLength).toBe(6877);
	expect(priorPacket.sequenceNumber).toBe(32);
	expect(priorPacket.duration).toBe(0.09287981859410431);
});

test('reads frames outside the frame size range given in STREAMINFO', async () => {
	// Files joined with `ffmpeg -f concat -c copy` keep the first file's STREAMINFO, and some files simply have a
	// wrong one, so frames can be smaller than the minimum or larger than the maximum frame size it states
	const crc8 = (bytes: number[]) => bytes.reduce((crc, byte) => {
		crc ^= byte;
		for (let i = 0; i < 8; i++) {
			crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
		}
		return crc;
	}, 0);
	const crc16 = (bytes: number[]) => bytes.reduce((crc, byte) => {
		crc ^= byte << 8;
		for (let i = 0; i < 8; i++) {
			crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
		}
		return crc;
	}, 0);

	// Mono 16-bit 44.1 kHz frames with 576 samples, the block size stored as an uncommon 16-bit value
	const frame = (frameNumber: number, verbatim: boolean) => {
		const header = [0xff, 0xf8, 0x79, 0x08, frameNumber, 0x02, 0x3f];
		const subframe = verbatim
			? [0x02, ...new Array<number>(576 * 2).fill(0x11)] // 1153 bytes
			: [0x00, 0x12, frameNumber]; // 3 bytes
		const bytes = [...header, crc8(header), ...subframe];
		const crc = crc16(bytes);
		return [...bytes, crc >> 8, crc & 0xff];
	};

	const read = async (minimumFrameSize: number, maximumFrameSize: number, frames: number[][]) => {
		const streamInfo = new Uint8Array(34);
		const view = new DataView(streamInfo.buffer);
		view.setUint16(0, 576);
		view.setUint16(2, 576);
		view.setUint32(4, minimumFrameSize << 8);
		view.setUint32(7, maximumFrameSize << 8);
		view.setUint32(10, (44100 << 12) | (0 << 9) | (15 << 4)); // 44.1 kHz, mono, 16 bits per sample
		view.setUint32(14, 576 * frames.length);

		const file = new Uint8Array([
			0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, ...streamInfo,
			...frames.flat(),
		]);
		using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const packets: [number, number][] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push([Math.round(packet.timestamp * 44100), packet.byteLength]);
		}
		return packets;
	};
	const layout = (frames: number[][]) => frames.map((frame, i) => [576 * i, frame.length]);

	// Small frames stated, but large ones follow
	const growing = [frame(0, false), frame(1, false), frame(2, true), frame(3, true), frame(4, false)];
	expect(await read(13, 13, growing)).toEqual(layout(growing));

	// Large frames stated, but small ones follow
	const shrinking = [frame(0, true), frame(1, true), frame(2, false), frame(3, false), frame(4, true)];
	expect(await read(1163, 1163, shrinking)).toEqual(layout(shrinking));

	// A large last frame, which runs to the end of the file
	const growingAtTheEnd = [frame(0, false), frame(1, false), frame(2, true)];
	expect(await read(13, 13, growingAtTheEnd)).toEqual(layout(growingAtTheEnd));
});

test('trailing data after the last frame is cut off at the maximum frame size', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	const file = new Uint8Array(await fs.readFile(filePath));
	// The maximum frame size is a 24-bit field 7 bytes into STREAMINFO, which follows 'fLaC' and its block header
	const maximumFrameSize = (file[8 + 7]! << 16) | (file[8 + 8]! << 8) | file[8 + 9]!;

	const readPacketSizes = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const sizes: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			sizes.push(packet.byteLength);
		}
		return sizes;
	};

	// Like a trailing tag or junk, 64 KiB of zeros after the last frame
	const sizes = await readPacketSizes(file);
	const sizesWithTrailer = await readPacketSizes(new Uint8Array([...file, ...new Uint8Array(65536)]));

	expect(sizesWithTrailer).toHaveLength(sizes.length);
	expect(sizesWithTrailer.slice(0, -1)).toEqual(sizes.slice(0, -1));
	expect(sizesWithTrailer.at(-1)).toBeLessThanOrEqual(maximumFrameSize + 16);
});

test('can get metadata-only packets', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const packetSink = new EncodedPacketSink(track);

	const packet = await packetSink.getPacket(10, { metadataOnly: true });
	assert(packet);
	expect(packet.timestamp).toBe(9.93814058956916);
	expect(packet.isMetadataOnly).toBe(true);
	expect(packet.sequenceNumber).toBe(107);
	expect(packet.duration).toBe(0.09287981859410431);
});

test('reads past the join of concatenated FLAC streams', async () => {
	// `ffmpeg -f concat -c copy` joins FLAC files frame by frame, so the frame numbers start over at the join
	const crc8 = (bytes: number[]) => bytes.reduce((crc, byte) => {
		crc ^= byte;
		for (let i = 0; i < 8; i++) {
			crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
		}
		return crc;
	}, 0);
	const crc16 = (bytes: number[]) => bytes.reduce((crc, byte) => {
		crc ^= byte << 8;
		for (let i = 0; i < 8; i++) {
			crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
		}
		return crc;
	}, 0);

	// Mono 16-bit 44.1 kHz frames with 576 samples, the block size stored as an uncommon 16-bit value
	const frameHeader = (frameNumber: number) => {
		const header = [0xff, 0xf8, 0x79, 0x08, frameNumber, 0x02, 0x3f];
		return [...header, crc8(header)];
	};
	const frame = (frameNumber: number, verbatim: boolean) => {
		const subframe = verbatim
			// The samples contain a valid frame header (frame 0), which must not be mistaken for the join
			? [0x02, ...frameHeader(0), ...new Array<number>(576 * 2 - 8).fill(0x11)]
			: [0x00, 0x12, frameNumber];
		const bytes = [...frameHeader(frameNumber), ...subframe];
		const crc = crc16(bytes);
		return [...bytes, crc >> 8, crc & 0xff];
	};
	const frames = [
		frame(0, false), frame(1, false), frame(2, true), frame(3, false), // First file
		frame(0, false), frame(1, true), frame(2, false), // Second file
	];

	const streamInfo = new Uint8Array(34);
	const view = new DataView(streamInfo.buffer);
	view.setUint16(0, 576);
	view.setUint16(2, 576);
	view.setUint32(10, (44100 << 12) | (0 << 9) | (15 << 4)); // 44.1 kHz, mono, 16 bits per sample
	view.setUint32(14, 576 * 4); // FFmpeg keeps the first file's STREAMINFO

	const file = new Uint8Array([
		0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, ...streamInfo,
		...frames.flat(),
	]);

	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packets: [number, number][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([Math.round(packet.timestamp * 44100), packet.byteLength]);
	}

	expect(packets).toEqual(frames.map((frame, i) => [576 * i, frame.length]));
	expect(await track.computeDuration()).toBe(576 * 7 / 44100);
});

test('can get metadata', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const { images: inputImages, ...descriptiveMetadata } = await input.getMetadataTags();

	expect(inputImages![0]!.data).toHaveLength(4852);
	expect(inputImages![0]!.data.slice(0, 8)).toEqual(new Uint8Array([
		137, 80, 78, 71, 13, 10, 26, 10,
	]));
	expect(inputImages![0]!.mimeType).toBe('image/png');
	expect(inputImages![0]!.description).toBe('Album cover');
	expect(inputImages![0]!.kind).toBe('coverFront');

	expect(descriptiveMetadata).toEqual({
		title: 'The Happy Meeting',
		date: new Date('2020'),
		album: 'Samples files',
		artist: 'Samples Files',
		trackNumber: 4,
		genre: 'Ambient',
		raw: {
			ALBUM: 'Samples files',
			ARTIST: 'Samples Files',
			DATE: '2020',
			ENCODER: 'Lavf58.76.100',
			GENRE: 'Ambient',
			TITLE: 'The Happy Meeting',
			TRACKNUMBER: '4',
			vendor: 'Lavf58.76.100',
		},
	});
});

test('can re-mux a .flac', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	let framesWritten = 0;

	const output = new Output({
		format: new FlacOutputFormat({
			onFrame() {
				framesWritten++;
			},
		}),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output });
	await conversion.execute();

	expect(framesWritten).toBe(213);

	const buffer = output.target.buffer;
	assert(buffer);

	const outputAsInput = new Input({
		source: new BufferSource(buffer),
		formats: [FLAC],
	});

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);
	expect(await inputTrack.getSampleRate()).toBe(await outputTrack.getSampleRate());
	expect(await inputTrack.getNumberOfChannels()).toBe(await outputTrack.getNumberOfChannels());
	expect(await inputTrack.getTimeResolution()).toBe(await outputTrack.getTimeResolution());

	const outputMetadataTags = await outputAsInput.getMetadataTags();

	const inputMetadataTags = await input.getMetadataTags();
	expect(inputMetadataTags.images).toHaveLength(1);
	expect(Object.keys(outputMetadataTags)).toEqual([
		'images',
		'raw',
		'title',
		'date',
		'album',
		'artist',
		'trackNumber',
		'genre',
	]);

	const { images: inputImages, ...otherInputMetadataTags } = inputMetadataTags;

	expect(outputMetadataTags).toEqual({
		...otherInputMetadataTags,
		raw: {
			...otherInputMetadataTags.raw,
			DATE: '2020-01-01',
			vendor: VERSIONED_NAME,
		},
		images: inputImages,
	});

	const inputPacketSink = new EncodedPacketSink(inputTrack);
	const outputPacketSink = new EncodedPacketSink(outputTrack);
	let packets = 0;
	let timestamp = 0;
	for await (const packet of outputPacketSink.packets()) {
		packets++;
		timestamp = packet.timestamp;
	}

	expect(packets).toBe(213);
	expect(timestamp).toBe(19.690521541950112);

	// Test that packets are byte-identical
	const inputPacket = await inputPacketSink.getPacket(10);
	const outputPacket = await outputPacketSink.getPacket(10);

	assert(inputPacket);
	assert(outputPacket);

	const { data: inputPacketData, ...otherInputPacket } = inputPacket;
	const { data: outputPacketData, ...otherOutputPacket } = outputPacket;

	expect(otherInputPacket).toEqual(otherOutputPacket);
	expect(inputPacketData).toEqual(outputPacketData);

	const inputDecoderConfig = await inputTrack.getDecoderConfig();
	const outputDecoderConfig = await outputTrack.getDecoderConfig();
	assert(inputDecoderConfig);
	assert(outputDecoderConfig);

	const { description: inputDescription, ...otherInputDecoderConfig } = inputDecoderConfig;
	const { description: outputDescription, ...otherOutputDecoderConfig } = outputDecoderConfig;

	assert(inputDescription);
	assert(outputDescription);

	const inputArray = toUint8Array(inputDescription);
	const outputArray = toUint8Array(outputDescription);

	const inputWithoutCrc = inputArray.slice(0, -16);
	const outputWithoutCrc = outputArray.slice(0, -16);
	expect(inputWithoutCrc).toEqual(outputWithoutCrc);

	expect(otherInputDecoderConfig).toEqual(otherOutputDecoderConfig);
});

const computeCrc8 = (data: number[]) => data.reduce((crc, byte) => {
	crc ^= byte;
	for (let i = 0; i < 8; i++) {
		crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
	}
	return crc;
}, 0);
const computeCrc16 = (data: number[]) => data.reduce((crc, byte) => {
	crc ^= byte << 8;
	for (let i = 0; i < 8; i++) {
		crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
	}
	return crc;
}, 0);

test('appendOnly refuses frames larger than the fixed block size it declared', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/sample.flac')),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	const decoderConfig = (await track.getDecoderConfig())!;
	const frames: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		frames.push(packet);
	}
	expect(frames.at(-1)!.duration).toBeLessThan(4096 / 44100); // A short last frame

	// A silent 8192-sample frame (44.1 kHz, stereo, 16-bit, constant subframes), as a stream encoded with a larger
	// block size than sample.flac's 4096 holds it
	const largeFrameHeader = [0xff, 0xf8, 0xd9, 0x18, 3];
	const largeFrameBytes = [...largeFrameHeader, computeCrc8(largeFrameHeader), 0, 0, 0, 0, 0, 0];
	const largeFrameCrc = computeCrc16(largeFrameBytes);
	const largeFrame = new EncodedPacket(
		new Uint8Array([...largeFrameBytes, largeFrameCrc >> 8, largeFrameCrc & 0xff]),
		'key',
		3 * 4096 / 44100,
		8192 / 44100,
	);

	const mux = async (packets: EncodedPacket[], appendOnly: boolean) => {
		const target = new BufferTarget();
		const output = new Output({ format: new FlacOutputFormat({ appendOnly }), target });
		const source = new EncodedAudioPacketSource('flac');
		output.addAudioTrack(source);
		await output.start();
		for (const packet of packets) {
			await source.add(packet, { decoderConfig });
		}
		await output.finalize();
		assert(target.buffer);
		return new Uint8Array(target.buffer);
	};

	// The STREAMINFO written up front declares the fixed block size of 4096, so a larger frame can't follow: decoders
	// such as FFmpeg's would drop it
	await expect(mux([...frames.slice(0, 3), largeFrame], true)).rejects.toThrow(/frame of 8192 samples/);

	// Without appendOnly, STREAMINFO is written last and bounds all frames
	const joined = await mux([...frames.slice(0, 3), largeFrame], false);
	expect(toDataView(joined).getUint16(10)).toBe(8192);

	// A shorter frame, as where streams with a short last frame are joined, is fine
	const shortFrame = frames.at(-1)!;
	const joinedAtShortFrame = await mux([
		shortFrame.clone({ timestamp: 0 }),
		...frames.slice(0, 2).map(x => x.clone({ timestamp: x.timestamp + shortFrame.duration })),
	], true);
	expect(toDataView(joinedAtShortFrame).getUint16(8)).toBe(4096);
});

test('appendOnly writes correct STREAMINFO header', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const target = new BufferTarget();
	const output = new Output({
		format: new FlacOutputFormat({ appendOnly: true }),
		target,
	});

	const conversion = await Conversion.init({ input, output });
	await conversion.execute();

	assert(target.buffer);
	const bytes = new Uint8Array(target.buffer);

	// STREAMINFO: min_block=4096, max_block=4096, min_frame=0, max_frame=0. The fixed block size of the frames is
	// stated as both the minimum and maximum (RFC 9639, section 8.2); libFLAC can't seek in the file otherwise.
	expect(bytes.slice(8, 18)).toEqual(new Uint8Array([
		// minimum_block_size=4096
		0x10, 0x00,
		// maximum_block_size=4096
		0x10, 0x00,
		// minimum_frame_size=0
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	]));

	// A stream with a variable block size keeps the full valid range of block sizes, as its frames' block sizes can't
	// be known beforehand. Here, mono 16-bit 44.1 kHz frames of 576 and 1152 samples, numbered by their first sample.
	const variableFrame = (sampleNumber: number, blockSize: number) => {
		const codedNumber = sampleNumber < 0x80
			? [sampleNumber]
			: [0xc0 | (sampleNumber >> 6), 0x80 | (sampleNumber & 0x3f)];
		// Uncommon 16-bit block size, 44.1 kHz, mono, 16 bits per sample, then a constant subframe
		const header = [0xff, 0xf9, 0x79, 0x08, ...codedNumber, (blockSize - 1) >> 8, (blockSize - 1) & 0xff];
		const frame = [...header, computeCrc8(header), 0x00, 0x12, 0x34];
		const crc = computeCrc16(frame);
		return [...frame, crc >> 8, crc & 0xff];
	};
	const streamInfo = new Uint8Array(34);
	const view = new DataView(streamInfo.buffer);
	view.setUint16(0, 576);
	view.setUint16(2, 1152);
	view.setUint32(10, (44100 << 12) | (0 << 9) | (15 << 4)); // 44.1 kHz, mono, 16 bits per sample
	view.setUint32(14, 576 + 1152 + 576);
	const variableFile = new Uint8Array([
		0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, ...streamInfo,
		...variableFrame(0, 576), ...variableFrame(576, 1152), ...variableFrame(1728, 576),
	]);

	using variableInput = new Input({ source: new BufferSource(variableFile), formats: ALL_FORMATS });
	const variableTarget = new BufferTarget();
	const variableOutput = new Output({
		format: new FlacOutputFormat({ appendOnly: true }),
		target: variableTarget,
	});
	const variableConversion = await Conversion.init({ input: variableInput, output: variableOutput });
	await variableConversion.execute();

	assert(variableTarget.buffer);
	const variableBytes = new Uint8Array(variableTarget.buffer);
	expect(variableBytes.slice(8, 12)).toEqual(new Uint8Array([0x00, 0x10, 0xff, 0xff])); // 16 and 65535
	expect([...variableBytes.subarray(42, 44)]).toEqual([0xff, 0xf9]); // The first frame, of a variable block size
});

test('renumbers frames copied from later in a stream', async () => {
	// A frame's coded number is the number of frames (or, with a variable block size, samples) before it in the stream
	// (RFC 9639, section 9.1.5). Readers such as FFmpeg take timestamps from it, so frames copied from later in a
	// stream, as when trimming its start, must be renumbered.
	const mux = async (frames: Uint8Array[], decoderConfig: AudioDecoderConfig) => {
		const target = new BufferTarget();
		const output = new Output({ format: new FlacOutputFormat(), target });
		const source = new EncodedAudioPacketSource('flac');
		output.addAudioTrack(source);
		await output.start();
		for (const [i, frame] of frames.entries()) {
			await source.add(new EncodedPacket(frame, 'key', i, 0), i === 0 ? { decoderConfig } : undefined);
		}
		await output.finalize();
		assert(target.buffer);

		using input = new Input({ source: new BufferSource(target.buffer), formats: ALL_FORMATS });
		const written: Uint8Array[] = [];
		for await (const packet of new EncodedPacketSink((await input.getPrimaryAudioTrack())!).packets()) {
			written.push(packet.data);
		}
		return written;
	};
	const expectValidChecksums = (frame: Uint8Array, headerLength: number) => {
		expect(calculateCrc8(frame.subarray(0, headerLength))).toBe(frame[headerLength]);
		expect(calculateCrc16(frame.subarray(0, -2))).toBe((frame.at(-2)! << 8) | frame.at(-1)!);
	};

	// Fixed block size: the frames of sample.flac from the second one on
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/sample.flac')),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	const frames: Uint8Array[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		frames.push(packet.data);
		if (frames.length === 4) {
			break;
		}
	}
	expect(frames.map(x => x[4])).toEqual([0, 1, 2, 3]); // One-byte coded numbers

	const trimmed = await mux(frames.slice(1), (await track.getDecoderConfig())!);
	expect(trimmed.map(x => x[4])).toEqual([0, 1, 2]);
	for (const [i, frame] of trimmed.entries()) {
		expectValidChecksums(frame, 5);
		expect(frame.subarray(6, -2)).toEqual(frames[i + 1]!.subarray(6, -2)); // The audio is untouched
	}

	// Variable block size: mono 16-bit 44.1 kHz frames of 576 samples numbered by their first sample, starting at
	// sample 1152, whose two-byte coded number shrinks to one byte
	const variableFrame = (sampleNumber: number) => {
		const codedNumber = sampleNumber < 0x80
			? [sampleNumber]
			: [0xc0 | (sampleNumber >> 6), 0x80 | (sampleNumber & 0x3f)];
		const header = [0xff, 0xf9, 0x79, 0x08, ...codedNumber, 0x02, 0x3f]; // Uncommon 16-bit block size of 576
		const bytes = [...header, calculateCrc8(new Uint8Array(header)), 0x00, 0x12, 0x34]; // A constant subframe
		const crc = calculateCrc16(new Uint8Array(bytes));
		return new Uint8Array([...bytes, crc >> 8, crc & 0xff]);
	};
	const streamInfo = new Uint8Array(34);
	const view = new DataView(streamInfo.buffer);
	view.setUint16(0, 576);
	view.setUint16(2, 576);
	view.setUint32(10, (44100 << 12) | (0 << 9) | (15 << 4)); // 44.1 kHz, mono, 16 bits per sample
	const description = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, ...streamInfo]);

	const variable = await mux(
		[variableFrame(1152), variableFrame(1728)],
		{ codec: 'flac', numberOfChannels: 1, sampleRate: 44100, description },
	);
	expect(variable.map(x => x.length)).toEqual([13, 14]);
	expect(variable[0]!.subarray(0, 5)).toEqual(new Uint8Array([0xff, 0xf9, 0x79, 0x08, 0]));
	expect(variable[1]!.subarray(0, 6)).toEqual(new Uint8Array([0xff, 0xf9, 0x79, 0x08, 0xc9, 0x80])); // 576
	expectValidChecksums(variable[0]!, 7);
	expectValidChecksums(variable[1]!, 8);
});

test('can read a FLAC file with leading ID3v2 tags', async () => {
	const createId3V23TitleTag = (title: string) => {
		const titleBytes = new TextEncoder().encode(title);
		const frame = new Uint8Array(11 + titleBytes.length);
		frame.set([0x54, 0x49, 0x54, 0x32]); // TIT2
		frame[7] = 1 + titleBytes.length;
		frame[10] = 0; // ISO-8859-1
		frame.set(titleBytes, 11);

		const tag = new Uint8Array(10 + frame.length);
		tag.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]); // ID3v2.3
		tag[9] = frame.length;
		tag.set(frame, 10);

		return tag;
	};

	const concatenateBytes = (...chunks: Uint8Array[]) => {
		const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
		let offset = 0;

		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.byteLength;
		}

		return result;
	};

	// The same, as an album artist (TPE2) tag, which the FLAC's Vorbis comments don't hold
	const albumArtistTag = createId3V23TitleTag('ID3 album artist');
	albumArtistTag.set([0x54, 0x50, 0x45, 0x32], 10);

	using input = new Input({
		source: new BufferSource(concatenateBytes(
			createId3V23TitleTag('First tag'),
			createId3V23TitleTag('Second tag'),
			albumArtistTag,
			await fs.readFile(new URL('../public/sample.flac', import.meta.url)),
		)),
		formats: ALL_FORMATS,
	});

	expect(await input.canRead()).toBe(true);
	expect(await input.getFormat()).toBe(FLAC);

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getDurationFromMetadata()).toEqual(19.714285714285715);

	const firstPacket = await new EncodedPacketSink(track).getPacket(0);
	assert(firstPacket);
	expect(firstPacket.sequenceNumber).toBe(0);
	expect(firstPacket.timestamp).toBe(0);

	const metadataTags = await input.getMetadataTags();
	// The Vorbis comments, FLAC's own tags, take precedence, while fields only the ID3 tags hold are kept
	expect(metadataTags.title).toBe('The Happy Meeting');
	expect(metadataTags.albumArtist).toBe('ID3 album artist');
	expect(metadataTags.raw!['TIT2']).toBe('First tag');
	expect(metadataTags.raw!['TITLE']).toBe('The Happy Meeting');
});

test('can read an old-format variable block size stream without the blocking strategy bit', async () => {
	// Encoders predating FLAC 1.2 (e.g. Flake 0.11) wrote variable block size streams with the blocking strategy bit
	// unset, but with sample numbers instead of frame numbers in the frame headers (RFC 9639, Appendix B.1)
	const crc8 = (bytes: number[]) => bytes.reduce((crc, byte) => {
		crc ^= byte;
		for (let i = 0; i < 8; i++) {
			crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
		}
		return crc;
	}, 0);
	const crc16 = (bytes: number[]) => bytes.reduce((crc, byte) => {
		crc ^= byte << 8;
		for (let i = 0; i < 8; i++) {
			crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
		}
		return crc;
	}, 0);
	const codedNumber = (value: number) => value < 0x80
		? [value]
		: value < 0x800
			? [0xc0 | (value >> 6), 0x80 | (value & 0x3f)]
			: [0xe0 | (value >> 12), 0x80 | ((value >> 6) & 0x3f), 0x80 | (value & 0x3f)];

	// Mono 16-bit 44.1 kHz frames with a constant subframe, the block size stored as an uncommon 16-bit value
	const blockSizes = [4608, 2304, 1152, 576, 4608, 1000];
	const frames: number[][] = [];
	let sampleNumber = 0;
	for (const blockSize of blockSizes) {
		const header = [
			0xff, 0xf8, 0x79, 0x08, ...codedNumber(sampleNumber), (blockSize - 1) >> 8, (blockSize - 1) & 0xff,
		];
		const frame = [...header, crc8(header), 0x00, 0x12, 0x34];
		const crc = crc16(frame);
		frames.push([...frame, crc >> 8, crc & 0xff]);
		sampleNumber += blockSize;
	}

	const streamInfo = new Uint8Array(34);
	const view = new DataView(streamInfo.buffer);
	view.setUint16(0, 576); // Minimum and maximum block sizes differ
	view.setUint16(2, 4608);
	view.setUint32(10, (44100 << 12) | (0 << 9) | (15 << 4)); // 44.1 kHz, mono, 16 bits per sample
	view.setUint32(14, sampleNumber);

	const file = new Uint8Array([
		0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, ...streamInfo,
		...frames.flat(),
	]);

	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packets: [number, number, number][] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push([packet.timestamp * 44100, packet.duration * 44100, packet.byteLength]);
	}

	let start = 0;
	expect(packets).toEqual(blockSizes.map((blockSize, i) => {
		const entry = [start, blockSize, frames[i]!.length];
		start += blockSize;
		return entry;
	}));
});
