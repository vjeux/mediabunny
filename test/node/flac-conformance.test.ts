import { describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, ReadableStreamSource } from '../../src/source.js';
import { ALL_FORMATS, FLAC } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { FlacOutputFormat } from '../../src/output-format.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { MetadataTags } from '../../src/metadata.js';
import { toUint8Array } from '../../src/misc.js';
import { VERSIONED_NAME } from '../../src/version.js';
import {
	buildFlacFile,
	buildFlacFrame,
	buildFlacMetadataBlock,
	buildFlacPicture,
	buildStreamInfo,
	buildVorbisCommentBody,
	concatBytes,
	encodeFlacCodedNumber,
	FLAC_BLOCK_TYPE,
	flacCrc16,
	flacCrc8,
	SimpleFlacOptions,
} from './helpers/audio-flac-ogg-builders.js';

const openFlac = (bytes: Uint8Array) => new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

const readAllPackets = async (bytes: Uint8Array) => {
	using input = openFlac(bytes);
	const track = (await input.getPrimaryAudioTrack())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	return packets;
};

/** Packet timestamps and durations in samples, plus sizes, which is what a FLAC demuxer has to get right. */
const packetLayout = (packets: EncodedPacket[], sampleRate: number) => packets.map(packet => [
	Math.round(packet.timestamp * sampleRate),
	Math.round(packet.duration * sampleRate),
	packet.byteLength,
]);

const expectedLayout = (frames: Uint8Array[], blockSizes: number[]) => {
	let sample = 0;
	return frames.map((frame, i) => {
		const entry = [sample, blockSizes[i]!, frame.length];
		sample += blockSizes[i]!;
		return entry;
	});
};

const remuxToFlac = async (
	bytes: Uint8Array,
	formatOptions: ConstructorParameters<typeof FlacOutputFormat>[0] = {},
	tags?: MetadataTags,
) => {
	using input = openFlac(bytes);
	const track = (await input.getPrimaryAudioTrack())!;
	const output = new Output({ format: new FlacOutputFormat(formatOptions), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('flac');
	output.addAudioTrack(source);
	if (tags) {
		output.setMetadataTags(tags);
	}
	await output.start();
	const decoderConfig = (await track.getDecoderConfig())!;
	let first = true;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		await source.add(packet, first ? { decoderConfig } : undefined);
		first = false;
	}
	source.close();
	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

type ParsedBlock = { type: number; isLast: boolean; data: Uint8Array };

const parseMetadataBlocks = (bytes: Uint8Array) => {
	expect([...bytes.subarray(0, 4)]).toEqual([0x66, 0x4c, 0x61, 0x43]);
	const blocks: ParsedBlock[] = [];
	let pos = 4;
	while (true) {
		const isLast = (bytes[pos]! & 0x80) !== 0;
		const size = (bytes[pos + 1]! << 16) | (bytes[pos + 2]! << 8) | bytes[pos + 3]!;
		blocks.push({ type: bytes[pos]! & 0x7f, isLast, data: bytes.subarray(pos + 4, pos + 4 + size) });
		pos += 4 + size;
		if (isLast) {
			break;
		}
	}
	return { blocks, audioStart: pos };
};

const parseStreamInfo = (data: Uint8Array) => {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	return {
		minimumBlockSize: view.getUint16(0),
		maximumBlockSize: view.getUint16(2),
		minimumFrameSize: (data[4]! << 16) | (data[5]! << 8) | data[6]!,
		maximumFrameSize: (data[7]! << 16) | (data[8]! << 8) | data[9]!,
		sampleRate: (data[10]! << 12) | (data[11]! << 4) | (data[12]! >> 4),
		channels: ((data[12]! >> 1) & 0b111) + 1,
		bitsPerSample: (((data[12]! & 1) << 4) | (data[13]! >> 4)) + 1,
		totalSamples: (data[13]! & 0xf) * 2 ** 32 + view.getUint32(14),
		md5: [...data.subarray(18, 34)],
	};
};

const SAMPLE_RATE = 44100;

// The three example files from RFC 9639 Appendix D, byte for byte
const RFC9639_EXAMPLE_1 = '664c6143800000221000100000000f00000f0ac442f0000000013e84b41807dc690307586a3dad1a2e0f'
	+ 'fff869180000bf0358fd03128baa9a';
const RFC9639_EXAMPLE_2 = '664c614300000022001000100000170000440ac442f000000013d5b0564975e98b8d8b930422757b81'
	+ '03030000120000000000000000000000000000000000100400003a200000007265666572656e6365206c6962464c4143'
	+ '20312e332e33203230313930383034010000000e0000005449544c453dd7a9d79cd795d79d81000006000000000000'
	+ 'fff86998000f9912086701623d1442998f5df70d6fe00c17caeb21000ee7a77a24a1590c1217b603097b784faa9a33'
	+ 'd285e070ad5b1b4851b4010d99d2cd1a68f1e6b810fff869180102a402c382c40bc14a03ee48dd03b67c1330';
const RFC9639_EXAMPLE_3 = '664c6143800000221000100000001f00001f07d0007000000018f8f9e396f5cbcfc6dc807f9977906b32'
	+ 'fff868020017e944004f6f313d1047d227cb6d090831452bdc2822228057a3';

const hexToBytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map(x => parseInt(x, 16)));

describe('FLAC demuxer: RFC 9639 Appendix D example files', () => {
	test('reads example 1: two channels with a single sample in one frame', async () => {
		const bytes = hexToBytes(RFC9639_EXAMPLE_1);
		using input = openFlac(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getSampleRate()).toBe(44100);
		expect(await track.getNumberOfChannels()).toBe(2);
		expect(await track.getDurationFromMetadata()).toBe(1 / 44100);
		expect(toUint8Array((await track.getDecoderConfig())!.description!)).toEqual(bytes.subarray(0, 42));

		const packets = await readAllPackets(bytes);
		expect(packetLayout(packets, 44100)).toEqual([[0, 1, 15]]);
		expect(packets[0]!.data).toEqual(bytes.subarray(0x2a));
	});

	test('reads example 2: a SEEKTABLE, a Vorbis comment with a UTF-8 title and two frames', async () => {
		const bytes = hexToBytes(RFC9639_EXAMPLE_2);
		using input = openFlac(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getDurationFromMetadata()).toBe(19 / 44100);
		// The second frame has an uncommon block size of 3 and a 16-bit side channel
		expect(packetLayout(await readAllPackets(bytes), 44100)).toEqual([[0, 16, 68], [16, 3, 23]]);
		expect(await input.getMetadataTags()).toEqual({
			title: 'שלום',
			raw: { vendor: 'reference libFLAC 1.3.3 20190804', TITLE: 'שלום' },
		});
	});

	test('reads example 3: a mono 8-bit stream at 32 kHz with a single frame', async () => {
		const bytes = hexToBytes(RFC9639_EXAMPLE_3);
		using input = openFlac(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getSampleRate()).toBe(32000);
		expect(await track.getNumberOfChannels()).toBe(1);
		expect(packetLayout(await readAllPackets(bytes), 32000)).toEqual([[0, 24, 31]]);
	});
});

describe('FLAC demuxer: frame headers (RFC 9639 section 9.1)', () => {
	test('reads the block size of every fixed block size code', async () => {
		// Codes 0b0001-0b0101 and 0b1000-0b1111 (Table 14)
		const blockSizes = [192, 576, 1152, 2304, 4608, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
		// The last block may be shorter than the others, so let's keep every block a "middle" block
		const { bytes, frames } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 1,
			bitsPerSample: 16,
			blockSizes: [...blockSizes, 16],
			variableBlockSize: true,
		});

		const packets = await readAllPackets(bytes);
		expect(packetLayout(packets, SAMPLE_RATE)).toEqual(expectedLayout(frames, [...blockSizes, 16]));
	});

	test('reads uncommon block sizes from the 8-bit and 16-bit fields', async () => {
		// 0b0110 stores (size - 1) in 8 bits, 0b0111 stores (size - 1) in 16 bits
		const blockSizes = [1, 16, 100, 255, 256, 257, 1000, 4097, 65535];
		const { bytes, frames } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 2,
			bitsPerSample: 16,
			blockSizes: [...blockSizes, 1],
			variableBlockSize: true,
		});

		const packets = await readAllPackets(bytes);
		expect(packetLayout(packets, SAMPLE_RATE)).toEqual(expectedLayout(frames, [...blockSizes, 1]));
	});

	test('reads a block size of 256 written with the uncommon 8-bit code instead of 0b1000', async () => {
		const { bytes, frames } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 1,
			bitsPerSample: 16,
			blockSizes: [256, 256, 256],
			frameOptions: { blockSizeCode: 0b0110 },
		});

		const packets = await readAllPackets(bytes);
		expect(packetLayout(packets, SAMPLE_RATE)).toEqual(expectedLayout(frames, [256, 256, 256]));
	});

	test.each([
		[88200, 'code 0b0001'],
		[176400, 'code 0b0010'],
		[192000, 'code 0b0011'],
		[8000, 'code 0b0100'],
		[16000, 'code 0b0101'],
		[22050, 'code 0b0110'],
		[24000, 'code 0b0111'],
		[32000, 'code 0b1000'],
		[44100, 'code 0b1001'],
		[48000, 'code 0b1010'],
		[96000, 'code 0b1011'],
		[12345, 'Hz in 16 bits (0b1101)'],
		[65535, 'Hz in 16 bits (0b1101)'],
		[7350, 'tens of Hz in 16 bits (0b1110)'],
		[655350, 'tens of Hz in 16 bits (0b1110)'],
		[100003, 'STREAMINFO only (0b0000)'],
		[705600, 'STREAMINFO only (0b0000)'],
	])('reads frames whose sample rate %i is coded as %s', async (sampleRate) => {
		const blockSizes = [4096, 4096, 1000];
		const { bytes, frames } = buildFlacFile({ sampleRate, channels: 1, bitsPerSample: 16, blockSizes });

		using input = openFlac(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getSampleRate()).toBe(sampleRate);
		expect(await track.getTimeResolution()).toBe(sampleRate);

		const packets = await readAllPackets(bytes);
		expect(packetLayout(packets, sampleRate)).toEqual(expectedLayout(frames, blockSizes));
		expect(await track.computeDuration()).toBe(9192 / sampleRate);
	});

	test('reads frames that defer their sample rate to STREAMINFO even when a code exists', async () => {
		const { bytes, frames } = buildFlacFile({
			sampleRate: 48000,
			channels: 2,
			bitsPerSample: 16,
			blockSizes: [1152, 1152],
			frameOptions: { sampleRateCode: 0 },
		});

		const packets = await readAllPackets(bytes);
		expect(packetLayout(packets, 48000)).toEqual(expectedLayout(frames, [1152, 1152]));
	});

	test.each([
		[1, 0], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6], [8, 7],
		[2, 8], [2, 9], [2, 10],
	])('reads %i channels with channel assignment %i', async (channels, channelAssignment) => {
		const blockSizes = [576, 576, 100];
		const { bytes, frames } = buildFlacFile({
			sampleRate: 48000,
			channels,
			bitsPerSample: 24,
			blockSizes,
			channelAssignment,
			subframeSamples: (channel, index) => (index * 7 + channel) % 1000,
		});

		using input = openFlac(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getNumberOfChannels()).toBe(channels);
		expect((await track.getDecoderConfig())!.numberOfChannels).toBe(channels);

		const packets = await readAllPackets(bytes);
		expect(packetLayout(packets, 48000)).toEqual(expectedLayout(frames, blockSizes));
	});

	test.each([8, 12, 16, 20, 24, 32, 4, 31])('reads %i-bit frames', async (bitsPerSample) => {
		const blockSizes = [256, 256, 256];
		const { bytes, frames } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 2,
			bitsPerSample,
			blockSizes,
			subframeSamples: (channel, index) => (channel ? -1 : 1) * (index % (2 ** (bitsPerSample - 1))),
		});

		const packets = await readAllPackets(bytes);
		expect(packetLayout(packets, SAMPLE_RATE)).toEqual(expectedLayout(frames, blockSizes));
	});

	test('reads coded sample numbers of one to six bytes in variable block size streams', async () => {
		// Small blocks first so that every coded length occurs; 1100 blocks of 65535 samples then push the sample
		// number past 2^26, which needs six coded bytes
		const blockSizes = [100, 100, 100, 1000, 1000, ...Array<number>(1100).fill(65535)];
		const { bytes, frames } = buildFlacFile({
			sampleRate: 192000,
			channels: 1,
			bitsPerSample: 16,
			blockSizes,
			variableBlockSize: true,
		});

		const codedLengths = new Set(frames.map((frame) => {
			const first = frame[4]!;
			return first < 0x80 ? 1 : Math.clz32(~(first << 24));
		}));
		expect([...codedLengths].sort()).toEqual([1, 2, 3, 4, 5, 6]);

		const packets = await readAllPackets(bytes);
		expect(packets).toHaveLength(1105);
		expect(packetLayout(packets, 192000)).toEqual(expectedLayout(frames, blockSizes));
	});

	test('reads coded frame numbers of up to five bytes in fixed block size streams', async () => {
		// The stream starts at a large frame number, as if it was cut, so that it reaches 5-byte frame numbers
		const firstNumber = 2 ** 21 - 3;
		const blockSizes = [4096, 4096, 4096, 4096, 4096, 100];
		const { bytes, frames } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 1,
			bitsPerSample: 16,
			blockSizes,
			firstNumber,
		});
		expect(frames.map(frame => Math.clz32(~(frame[4]! << 24)))).toEqual([4, 4, 4, 5, 5, 5]);

		const packets = await readAllPackets(bytes);
		expect(packets.map(packet => packet.byteLength)).toEqual(frames.map(frame => frame.length));
		expect(packets.map(packet => packet.duration * SAMPLE_RATE)).toEqual(blockSizes);
	});

	test('reads variable block size streams by their sample numbers', async () => {
		const blockSizes = [4096, 1152, 192, 16384, 576, 4608, 1000, 17];
		const { bytes, frames } = buildFlacFile({
			sampleRate: 48000,
			channels: 2,
			bitsPerSample: 16,
			blockSizes,
			variableBlockSize: true,
			subframeSamples: (channel, index, frame) => ((index + frame * 31) % 512) - 256,
		});

		const packets = await readAllPackets(bytes);
		expect(packetLayout(packets, 48000)).toEqual(expectedLayout(frames, blockSizes));
		expect(packets.every(packet => packet.type === 'key')).toBe(true);
	});

	test('reads a last frame that is shorter than 16 bytes', async () => {
		// A constant 8-bit mono frame takes 6 header bytes, 2 subframe bytes and 2 CRC bytes
		const blockSizes = [4096, 4096, 908];
		const { bytes, frames } = buildFlacFile({ sampleRate: 48000, channels: 1, bitsPerSample: 8, blockSizes });
		expect(frames.at(-1)!.length).toBeLessThan(16);

		const packets = await readAllPackets(bytes);
		expect(packetLayout(packets, 48000)).toEqual(expectedLayout(frames, blockSizes));
	});

	test('reads frames when STREAMINFO declares unknown (0) frame sizes', async () => {
		const blockSizes = [4096, 4096, 4096, 50];
		const { bytes, frames } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 2,
			bitsPerSample: 16,
			blockSizes,
			subframeSamples: (channel, index) => (index * 13) % 30000,
			streamInfo: { minimumFrameSize: 0, maximumFrameSize: 0 },
		});

		const packets = await readAllPackets(bytes);
		expect(packetLayout(packets, SAMPLE_RATE)).toEqual(expectedLayout(frames, blockSizes));
	});

	test('does not split a frame at a fake frame header inside its subframe data', async () => {
		// Plant the bytes of a complete, CRC-valid frame header inside verbatim sample data. Its frame number is not
		// the next one, so it must not be taken for the start of the next frame (RFC 9639 section 9.1.5).
		const fakeHeader = buildFlacFrame({
			blockSize: 4096,
			sampleRate: SAMPLE_RATE,
			channels: 1,
			bitsPerSample: 16,
			number: 7,
		}).subarray(0, 6);
		expect(flacCrc8(fakeHeader.subarray(0, 5))).toBe(fakeHeader[5]);

		const blockSizes = [64, 64, 64];
		const { bytes, frames } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 1,
			bitsPerSample: 16,
			blockSizes,
			subframeSamples: (channel, index) => {
				// The verbatim data starts on a byte boundary after the 1-byte subframe header, so 16-bit samples map
				// 1:1 onto byte pairs of the fake header
				const pairIndex = index - 10;
				if (pairIndex >= 0 && pairIndex < 3) {
					const value = (fakeHeader[2 * pairIndex]! << 8) | fakeHeader[2 * pairIndex + 1]!;
					return value >= 0x8000 ? value - 0x10000 : value;
				}
				return index;
			},
			streamInfo: { minimumFrameSize: 0, maximumFrameSize: 0 },
		});
		expect(frames[0]!.indexOf(0xff, 6)).toBeGreaterThan(0);

		const packets = await readAllPackets(bytes);
		expect(packetLayout(packets, SAMPLE_RATE)).toEqual(expectedLayout(frames, blockSizes));
	});

	test('yields no packets for a stream with metadata blocks but no frames', async () => {
		const { bytes } = buildFlacFile({ sampleRate: SAMPLE_RATE, channels: 2, bitsPerSample: 16, blockSizes: [] });
		using input = openFlac(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		const sink = new EncodedPacketSink(track);
		expect(await sink.getFirstPacket()).toBe(null);
		expect(await sink.getPacket(0)).toBe(null);
		expect(await track.computeDuration()).toBe(0);
	});
});

describe('FLAC demuxer: STREAMINFO and metadata blocks (RFC 9639 section 8)', () => {
	test('exposes the STREAMINFO block as the decoder description, flagged as the last block', async () => {
		const md5 = new Uint8Array(16).map((_, i) => i * 17);
		const { bytes, streamInfo } = buildFlacFile({
			sampleRate: 96000,
			channels: 6,
			bitsPerSample: 24,
			blockSizes: [2048, 2048],
			extraBlocks: [{ type: FLAC_BLOCK_TYPE.PADDING, data: new Uint8Array(100) }],
			streamInfo: { md5 },
		});

		using input = openFlac(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		const config = (await track.getDecoderConfig())!;
		expect(config.codec).toBe('flac');
		expect(config.sampleRate).toBe(96000);
		expect(config.numberOfChannels).toBe(6);
		// WebCodecs FLAC registration: 'fLaC' followed by the STREAMINFO metadata block
		expect(toUint8Array(config.description!)).toEqual(concatBytes([
			new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]),
			streamInfo,
		]));
		expect(await track.getCodecParameterString()).toBe('flac');
		expect(await input.getMimeType()).toBe('audio/flac');
	});

	test('reports the STREAMINFO total sample count as the metadata duration', async () => {
		const { bytes } = buildFlacFile({
			sampleRate: 48000,
			channels: 1,
			bitsPerSample: 16,
			blockSizes: [4096, 1000],
		});
		using input = openFlac(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getDurationFromMetadata()).toBe(5096 / 48000);
		expect(await input.getDurationFromMetadata()).toBe(5096 / 48000);
	});

	test('reports no metadata duration when the total sample count is unknown (0)', async () => {
		const { bytes } = buildFlacFile({
			sampleRate: 48000,
			channels: 1,
			bitsPerSample: 16,
			blockSizes: [4096, 1000],
			streamInfo: { totalSamples: 0 },
		});
		using input = openFlac(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getDurationFromMetadata()).toBe(null);
		expect(await track.computeDuration()).toBe(5096 / 48000);
	});

	test('skips PADDING, APPLICATION, SEEKTABLE, CUESHEET and reserved block types', async () => {
		const seekTable = new Uint8Array(3 * 18);
		const seekView = new DataView(seekTable.buffer);
		seekView.setBigUint64(0, 0n);
		seekView.setBigUint64(18, 4096n);
		seekView.setBigUint64(36, 0xffffffffffffffffn); // Placeholder point
		const { bytes, frames } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 2,
			bitsPerSample: 16,
			blockSizes: [4096, 4096],
			extraBlocks: [
				{ type: FLAC_BLOCK_TYPE.SEEKTABLE, data: seekTable },
				{ type: FLAC_BLOCK_TYPE.APPLICATION, data: new Uint8Array([0x61, 0x62, 0x63, 0x64, 1, 2, 3]) },
				{ type: FLAC_BLOCK_TYPE.CUESHEET, data: new Uint8Array(396 + 36) },
				{ type: 100, data: new Uint8Array(10).fill(0xff) },
				{ type: FLAC_BLOCK_TYPE.PADDING, data: new Uint8Array(0) },
				{ type: FLAC_BLOCK_TYPE.PADDING, data: new Uint8Array(8192) },
			],
		});

		const packets = await readAllPackets(bytes);
		expect(packetLayout(packets, SAMPLE_RATE)).toEqual(expectedLayout(frames, [4096, 4096]));
	});

	test('maps Vorbis comment fields to metadata tags and keeps every raw value', async () => {
		const comments = [
			'TITLE=Tïtle 表紙',
			'artist=First Artist', // Field names are case-insensitive
			'ARTIST=Second Artist',
			'ALBUM=Album',
			'ALBUMARTIST=Album Artist',
			'TRACKNUMBER=3/12',
			'DISCNUMBER=2',
			'DISCTOTAL=4',
			'GENRE=Ambient',
			'DATE=2019-05-04',
			'COMMENT=Value with = inside',
			'DESCRIPTION=Desc',
			'LYRICS=La la',
			'BPM=128',
			'MUSICBRAINZ_TRACKID=abc',
			'NOEQUALSSIGN',
			'EMPTY=',
		];
		const { bytes } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 2,
			bitsPerSample: 16,
			blockSizes: [4096],
			extraBlocks: [
				{ type: FLAC_BLOCK_TYPE.VORBIS_COMMENT, data: buildVorbisCommentBody('my encoder', comments) },
			],
		});

		using input = openFlac(bytes);
		const tags = await input.getMetadataTags();
		expect(tags).toEqual({
			title: 'Tïtle 表紙',
			artist: 'First Artist',
			album: 'Album',
			albumArtist: 'Album Artist',
			trackNumber: 3,
			tracksTotal: 12,
			discNumber: 2,
			discsTotal: 4,
			genre: 'Ambient',
			date: new Date('2019-05-04'),
			comment: 'Value with = inside',
			description: 'Desc',
			lyrics: 'La la',
			beatsPerMinute: 128,
			raw: {
				vendor: 'my encoder',
				TITLE: 'Tïtle 表紙',
				ARTIST: ['First Artist', 'Second Artist'],
				ALBUM: 'Album',
				ALBUMARTIST: 'Album Artist',
				TRACKNUMBER: '3/12',
				DISCNUMBER: '2',
				DISCTOTAL: '4',
				GENRE: 'Ambient',
				DATE: '2019-05-04',
				COMMENT: 'Value with = inside',
				DESCRIPTION: 'Desc',
				LYRICS: 'La la',
				BPM: '128',
				MUSICBRAINZ_TRACKID: 'abc',
				EMPTY: '',
			},
		});
	});

	test('keeps the comments read before a truncated Vorbis comment list', async () => {
		const body = buildVorbisCommentBody('v', ['TITLE=Kept', 'ARTIST=Cut off']);
		// Declare 2 comments but cut the block in the middle of the second one's length field
		const truncated = body.subarray(0, 4 + 1 + 4 + 4 + 'TITLE=Kept'.length + 2);
		const { bytes } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 1,
			bitsPerSample: 16,
			blockSizes: [4096],
			extraBlocks: [{ type: FLAC_BLOCK_TYPE.VORBIS_COMMENT, data: truncated }],
		});

		using input = openFlac(bytes);
		const tags = await input.getMetadataTags();
		expect(tags.title).toBe('Kept');
		expect(tags.artist).toBe(undefined);
	});

	test('reads PICTURE blocks and maps the picture type to an image kind', async () => {
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		const { bytes } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 2,
			bitsPerSample: 16,
			blockSizes: [4096],
			extraBlocks: [
				{ type: 3, mimeType: 'image/png', description: 'Front', data: pngBytes },
				{ type: 4, mimeType: 'image/jpeg', description: 'Back cover ü', data: new Uint8Array([0xff, 0xd8]) },
				{ type: 8, mimeType: 'image/gif', description: '', data: new Uint8Array([0x47]) },
			].map(picture => ({ type: FLAC_BLOCK_TYPE.PICTURE, data: buildFlacPicture(picture) })),
		});

		using input = openFlac(bytes);
		const tags = await input.getMetadataTags();
		expect(tags.images).toEqual([
			{ data: pngBytes, mimeType: 'image/png', kind: 'coverFront', description: 'Front' },
			{
				data: new Uint8Array([0xff, 0xd8]),
				mimeType: 'image/jpeg',
				kind: 'coverBack',
				description: 'Back cover ü',
			},
			{ data: new Uint8Array([0x47]), mimeType: 'image/gif', kind: 'unknown', description: '' },
		]);
	});

	test('skips a PICTURE block whose inner lengths exceed the block', async () => {
		const picture = buildFlacPicture({
			type: 3,
			mimeType: 'image/png',
			description: 'x',
			data: new Uint8Array(10),
		});
		new DataView(picture.buffer).setUint32(picture.length - 14, 1000); // Data length beyond the block
		const { bytes, frames } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 1,
			bitsPerSample: 16,
			blockSizes: [4096, 4096],
			extraBlocks: [
				{ type: FLAC_BLOCK_TYPE.PICTURE, data: picture },
				{ type: FLAC_BLOCK_TYPE.VORBIS_COMMENT, data: buildVorbisCommentBody('v', ['TITLE=After']) },
			],
		});

		using input = openFlac(bytes);
		const tags = await input.getMetadataTags();
		expect(tags.images).toBe(undefined);
		expect(tags.title).toBe('After');
		expect((await readAllPackets(bytes)).map(x => x.byteLength)).toEqual(frames.map(x => x.length));
	});

	test('reads a stream whose metadata blocks follow ID3v2 tags, including one with a footer', async () => {
		const id3 = (flags: number, footer: boolean) => {
			const frame = concatBytes([
				new TextEncoder().encode('TIT2'),
				new Uint8Array([0, 0, 0, 4, 0, 0, 0]),
				new TextEncoder().encode('abc'),
			]);
			const header = new Uint8Array([0x49, 0x44, 0x33, 4, 0, flags, 0, 0, 0, frame.length]);
			const parts = [header, frame];
			if (footer) {
				parts.push(new Uint8Array([0x33, 0x44, 0x49, 4, 0, flags, 0, 0, 0, frame.length]));
			}
			return concatBytes(parts);
		};
		const { bytes, frames } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 1,
			bitsPerSample: 16,
			blockSizes: [4096, 10],
		});
		const withTags = concatBytes([id3(0x10, true), id3(0, false), bytes]);

		using input = openFlac(withTags);
		expect(await input.getFormat()).toBe(FLAC);
		expect((await input.getMetadataTags()).title).toBe('abc');
		expect((await readAllPackets(withTags)).map(x => x.byteLength)).toEqual(frames.map(x => x.length));
	});

	test('rejects a stream without a STREAMINFO block', async () => {
		const frame = buildFlacFrame({
			blockSize: 4096,
			sampleRate: SAMPLE_RATE,
			channels: 1,
			bitsPerSample: 16,
			number: 0,
		});
		const bytes = concatBytes([
			new Uint8Array([0x66, 0x4c, 0x61, 0x43]),
			buildFlacMetadataBlock(FLAC_BLOCK_TYPE.PADDING, new Uint8Array(10), true),
			frame,
		]);
		using input = openFlac(bytes);
		await expect(input.getPrimaryAudioTrack()).rejects.toThrow(/STREAMINFO/);
	});

	test('rejects a STREAMINFO with a sample rate of 0', async () => {
		const { bytes } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 1,
			bitsPerSample: 16,
			blockSizes: [4096],
			streamInfo: { sampleRate: 0 },
		});
		using input = openFlac(bytes);
		await expect(input.getPrimaryAudioTrack()).rejects.toThrow(/sample rate/);
	});
});

describe('FLAC demuxer: packet retrieval', () => {
	const blockSizes = [4096, 4096, 1152, 4096, 333];
	const build = () => buildFlacFile({
		sampleRate: 48000,
		channels: 2,
		bitsPerSample: 16,
		blockSizes,
		variableBlockSize: true,
		subframeSamples: (channel, index, frame) => (index * (frame + 1)) % 1000,
	});

	test('getPacket returns the containing packet, null before 0 and the last packet after the end', async () => {
		const { bytes } = build();
		using input = openFlac(bytes);
		const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
		const starts = [0, 4096, 8192, 9344, 13440];
		const query = async (sample: number) => {
			const packet = await sink.getPacket(sample / 48000);
			return packet && Math.round(packet.timestamp * 48000);
		};

		expect(await sink.getPacket(-0.001)).toBe(null);
		for (let i = 0; i < starts.length; i++) {
			expect(await query(starts[i]!)).toBe(starts[i]);
			expect(await query(starts[i]! + 1)).toBe(starts[i]);
			if (i > 0) {
				expect(await query(starts[i]! - 1)).toBe(starts[i - 1]);
			}
		}
		expect(await query(13773)).toBe(13440);
		expect(await query(1e9)).toBe(13440);
	});

	test('random access gives the same packets as sequential reading, in any order', async () => {
		const { bytes, frames } = build();
		const expected = expectedLayout(frames, blockSizes);
		using input = openFlac(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		const sink = new EncodedPacketSink(track);

		for (const index of [4, 0, 3, 1, 2]) {
			const packet = (await sink.getPacket(expected[index]![0]! / 48000))!;
			expect(packetLayout([packet], 48000)[0]).toEqual(expected[index]);
			expect(packet.sequenceNumber).toBe(index);
			expect(await sink.getKeyPacket(packet.timestamp)).toEqual(packet);

			const next = await sink.getNextPacket(packet);
			if (index === 4) {
				expect(next).toBe(null);
			} else {
				expect(packetLayout([next!], 48000)[0]).toEqual(expected[index + 1]);
				expect(await sink.getNextKeyPacket(packet)).toEqual(next);
			}
		}
	});

	test('concurrent first-packet and random access lookups agree with sequential reading', async () => {
		const { bytes, frames } = build();
		const expected = expectedLayout(frames, blockSizes);
		using input = openFlac(bytes);
		const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
		const results = await Promise.all([
			sink.getPacket(9344 / 48000),
			sink.getPacket(0),
			sink.getPacket(13500 / 48000),
		]);
		expect(packetLayout(results.map(x => x!), 48000)).toEqual([expected[3], expected[0], expected[4]]);
	});

	test('reads the same packets through an unsized streaming source', async () => {
		const { bytes, frames } = build();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < bytes.length; offset += 500) {
					controller.enqueue(bytes.slice(offset, offset + 500));
				}
				controller.close();
			},
		});
		using input = new Input({ source: new ReadableStreamSource(stream), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}
		expect(packetLayout(packets, 48000)).toEqual(expectedLayout(frames, blockSizes));
		expect(packets.map(x => x.data)).toEqual(frames);
	});

	test('returns placeholder data for metadata-only packets', async () => {
		const { bytes, frames } = build();
		using input = openFlac(bytes);
		const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
		const packet = (await sink.getPacket(0.1, { metadataOnly: true }))!;
		expect(packet.isMetadataOnly).toBe(true);
		expect(packet.byteLength).toBe(frames[1]!.length);
		expect(packet.timestamp).toBe(4096 / 48000);
	});

	test('finds frame boundaries in a stream whose data holds many sync-like bytes', async () => {
		// Full-scale noise in verbatim subframes produces 0xFF 0xF8/0xF9 pairs all over the frame data
		let seed = 1;
		const random = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed;
		};
		const noise = Array.from({ length: 40 * 2 * 1152 }, () => (random() % 65536) - 32768);
		const sizes = Array<number>(40).fill(1152);
		const { bytes, frames } = buildFlacFile({
			sampleRate: SAMPLE_RATE,
			channels: 2,
			bitsPerSample: 16,
			blockSizes: sizes,
			subframeSamples: (channel, index, frame) => noise[(frame * 1152 + index) * 2 + channel]!,
		});

		const packets = await readAllPackets(bytes);
		expect(packetLayout(packets, SAMPLE_RATE)).toEqual(expectedLayout(frames, sizes));
	});
});

describe('FLAC muxer', () => {
	const sourceFile = (options: Partial<SimpleFlacOptions> = {}) => buildFlacFile({
		sampleRate: 48000,
		channels: 2,
		bitsPerSample: 24,
		blockSizes: [4096, 4096, 4096, 1000],
		subframeSamples: (channel, index, frame) => ((index * 3 + frame) % 4000) - 2000,
		...options,
	});

	test('writes STREAMINFO bounds and totals computed from the frames', async () => {
		const { bytes: input, frames } = sourceFile();
		const output = await remuxToFlac(input);
		const { blocks, audioStart } = parseMetadataBlocks(output);

		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.type).toBe(FLAC_BLOCK_TYPE.STREAMINFO);
		expect(blocks[0]!.isLast).toBe(true);
		expect(parseStreamInfo(blocks[0]!.data)).toEqual({
			minimumBlockSize: 4096,
			maximumBlockSize: 4096,
			minimumFrameSize: Math.min(...frames.map(x => x.length)),
			maximumFrameSize: Math.max(...frames.map(x => x.length)),
			sampleRate: 48000,
			channels: 2,
			bitsPerSample: 24,
			totalSamples: 13288,
			md5: Array<number>(16).fill(0), // Unknown, allowed by RFC 9639 section 8.2
		});
		// The frames follow the metadata unchanged
		expect(output.subarray(audioStart)).toEqual(concatBytes(frames));
	});

	test('excludes only the last block from the minimum block size of a variable block size stream', async () => {
		const blockSizes = [4096, 1152, 192, 16384, 17];
		const { bytes: input } = sourceFile({ blockSizes, variableBlockSize: true });
		const output = await remuxToFlac(input);
		const streamInfo = parseStreamInfo(parseMetadataBlocks(output).blocks[0]!.data);

		expect(streamInfo.minimumBlockSize).toBe(192);
		expect(streamInfo.maximumBlockSize).toBe(16384);
		expect(streamInfo.totalSamples).toBe(21841);
		expect(packetLayout(await readAllPackets(output), 48000)).toEqual(
			packetLayout(await readAllPackets(input), 48000),
		);
	});

	test('writes a loose STREAMINFO in append-only mode', async () => {
		const { bytes: input, frames } = sourceFile();
		let onFrameCalls = 0;
		const output = await remuxToFlac(input, { appendOnly: true, onFrame: () => onFrameCalls++ });
		const { blocks, audioStart } = parseMetadataBlocks(output);

		expect(onFrameCalls).toBe(4);
		expect(parseStreamInfo(blocks[0]!.data)).toEqual({
			minimumBlockSize: 16,
			maximumBlockSize: 65535,
			minimumFrameSize: 0,
			maximumFrameSize: 0,
			sampleRate: 48000,
			channels: 2,
			bitsPerSample: 24,
			totalSamples: 0,
			md5: Array<number>(16).fill(0),
		});
		expect(output.subarray(audioStart)).toEqual(concatBytes(frames));

		// The demuxer copes with the unknown values
		using reread = openFlac(output);
		const track = (await reread.getPrimaryAudioTrack())!;
		expect(await track.getDurationFromMetadata()).toBe(null);
		expect(await track.computeDuration()).toBe(13288 / 48000);
	});

	test('reports each frame and its byte position through onFrame', async () => {
		const { bytes: input, frames } = sourceFile();
		const calls: [number, number][] = [];
		const output = await remuxToFlac(input, { onFrame: (data, position) => calls.push([data.length, position]) });
		const { audioStart } = parseMetadataBlocks(output);

		let position = audioStart;
		expect(calls).toEqual(frames.map((frame) => {
			const call: [number, number] = [frame.length, position];
			position += frame.length;
			return call;
		}));
	});

	test('writes PICTURE blocks before a final VORBIS_COMMENT block', async () => {
		const { bytes: input } = sourceFile();
		const front = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);
		const output = await remuxToFlac(input, {}, {
			title: 'Title',
			artist: 'Artist',
			album: 'Album',
			albumArtist: 'AA',
			genre: 'Genre',
			comment: 'Comment',
			description: 'Description',
			lyrics: 'Lyrics',
			trackNumber: 3,
			tracksTotal: 12,
			discNumber: 1,
			discsTotal: 2,
			beatsPerMinute: 120,
			date: new Date('2021-03-04T00:00:00Z'),
			images: [
				{ data: front, mimeType: 'image/png', kind: 'coverFront', description: 'Front' },
				{ data: new Uint8Array([1]), mimeType: 'image/jpeg', kind: 'coverBack' },
				{ data: new Uint8Array([2, 3]), mimeType: 'image/webp', kind: 'unknown', description: 'Other' },
			],
			raw: { CUSTOM: 'value', MULTI: ['a', 'b'], IGNORED_BINARY: new Uint8Array([1]) },
		});
		const { blocks } = parseMetadataBlocks(output);

		expect(blocks.map(x => [x.type, x.isLast])).toEqual([
			[FLAC_BLOCK_TYPE.STREAMINFO, false],
			[FLAC_BLOCK_TYPE.PICTURE, false],
			[FLAC_BLOCK_TYPE.PICTURE, false],
			[FLAC_BLOCK_TYPE.PICTURE, false],
			[FLAC_BLOCK_TYPE.VORBIS_COMMENT, true],
		]);
		// Picture type 3 = front cover, 4 = back cover, 0 = other (RFC 9639 Table 13); dimensions written as unknown
		expect(blocks[1]!.data).toEqual(buildFlacPictureWithZeroDimensions(3, 'image/png', 'Front', front));
		expect(blocks[2]!.data).toEqual(buildFlacPictureWithZeroDimensions(4, 'image/jpeg', '', new Uint8Array([1])));
		expect(blocks[3]!.data).toEqual(
			buildFlacPictureWithZeroDimensions(0, 'image/webp', 'Other', new Uint8Array([2, 3])),
		);

		// No framing bit in FLAC's Vorbis comment block (RFC 9639 section 8.6)
		expect(blocks[4]!.data).toEqual(buildVorbisCommentBody(VERSIONED_NAME, [
			'TITLE=Title',
			'ARTIST=Artist',
			'ALBUM=Album',
			'ALBUMARTIST=AA',
			'GENRE=Genre',
			'COMMENT=Comment',
			'DESCRIPTION=Description',
			'LYRICS=Lyrics',
			'TRACKNUMBER=3',
			'TRACKTOTAL=12',
			'DISCNUMBER=1',
			'DISCTOTAL=2',
			'BPM=120',
			'DATE=2021-03-04',
			'CUSTOM=value',
			'MULTI=a',
			'MULTI=b',
		].sort(byWrittenOrder(blocks[4]!.data))));

		// And everything reads back
		using reread = openFlac(output);
		const tags = await reread.getMetadataTags();
		expect(tags.title).toBe('Title');
		expect(tags.trackNumber).toBe(3);
		expect(tags.tracksTotal).toBe(12);
		expect(tags.date).toEqual(new Date('2021-03-04T00:00:00Z'));
		expect(tags.images!.map(x => [x.kind, x.mimeType, x.data.length])).toEqual([
			['coverFront', 'image/png', 6], ['coverBack', 'image/jpeg', 1], ['unknown', 'image/webp', 2],
		]);
		expect(tags.raw!['MULTI']).toEqual(['a', 'b']);
	});

	test('writes a valid file with no frames when the track metadata carries the decoder config', async () => {
		const { bytes: input } = sourceFile();
		using source = openFlac(input);
		const decoderConfig = (await (await source.getPrimaryAudioTrack())!.getDecoderConfig())!;

		const output = new Output({ format: new FlacOutputFormat(), target: new BufferTarget() });
		output.addAudioTrack(new EncodedAudioPacketSource('flac'), { decoderConfig } as never);
		await output.start();
		await output.finalize();
		const bytes = new Uint8Array(output.target.buffer!);

		const { blocks, audioStart } = parseMetadataBlocks(bytes);
		expect(audioStart).toBe(bytes.length);
		expect(parseStreamInfo(blocks[0]!.data)).toMatchObject({
			minimumBlockSize: 16,
			maximumBlockSize: 65535,
			sampleRate: 48000,
			channels: 2,
			bitsPerSample: 24,
			totalSamples: 0,
		});
	});

	test('refuses to finalize a file without frames or a decoder config', async () => {
		const output = new Output({ format: new FlacOutputFormat(), target: new BufferTarget() });
		output.addAudioTrack(new EncodedAudioPacketSource('flac'));
		await output.start();
		await expect(output.finalize()).rejects.toThrow(/empty FLAC/);
	});

	test('accepts only one FLAC audio track', () => {
		const format = new FlacOutputFormat();
		expect(format.getSupportedCodecs()).toEqual(['flac']);
		expect(format.getSupportedTrackCounts()).toMatchObject({ video: { max: 0 }, audio: { min: 1, max: 1 } });
		expect(format.fileExtension).toBe('.flac');
		expect(format.mimeType).toBe('audio/flac');
	});
});

// Helpers for the muxer tests

const buildFlacPictureWithZeroDimensions = (type: number, mimeType: string, description: string, data: Uint8Array) => {
	const picture = buildFlacPicture({ type, mimeType, description, data });
	// Width, height, color depth and indexed color count are written as 0 by the muxer
	const dimensionsOffset = 8 + mimeType.length + 4 + new TextEncoder().encode(description).length;
	picture.fill(0, dimensionsOffset, dimensionsOffset + 16);
	return picture;
};

/** Sorts expected comments into the order in which they appear in the written block. */
const byWrittenOrder = (written: Uint8Array) => {
	const text = new TextDecoder().decode(written);
	return (a: string, b: string) => text.indexOf(a) - text.indexOf(b);
};

// Sanity checks for the builders themselves, so a builder bug can't hide a demuxer bug

describe('FLAC test builders', () => {
	test('encode coded numbers per RFC 9639 Table 18', () => {
		expect(encodeFlacCodedNumber(0)).toEqual([0]);
		expect(encodeFlacCodedNumber(0x7f)).toEqual([0x7f]);
		expect(encodeFlacCodedNumber(0x80)).toEqual([0xc2, 0x80]);
		expect(encodeFlacCodedNumber(0x7ff)).toEqual([0xdf, 0xbf]);
		expect(encodeFlacCodedNumber(0x800)).toEqual([0xe0, 0xa0, 0x80]);
		expect(encodeFlacCodedNumber(0x10000)).toEqual([0xf0, 0x90, 0x80, 0x80]);
		expect(encodeFlacCodedNumber(0x200000)).toEqual([0xf8, 0x88, 0x80, 0x80, 0x80]);
		expect(encodeFlacCodedNumber(0x4000000)).toEqual([0xfc, 0x84, 0x80, 0x80, 0x80, 0x80]);
		// The 7-byte example from RFC 9639 section 9.1.5: 51 billion samples
		expect(encodeFlacCodedNumber(51_000_000_000)).toEqual([
			0b11111110, 0b10101111, 0b10011111, 0b10110101, 0b10100011, 0b10111000, 0b10000000,
		]);
	});

	test('compute CRC-8, CRC-16 and STREAMINFO like RFC 9639 example file 1', () => {
		const example = hexToBytes(RFC9639_EXAMPLE_1);
		expect(flacCrc8(example.subarray(0x2a, 0x30))).toBe(example[0x30]);
		expect(flacCrc16(example.subarray(0x2a, 0x37))).toBe((example[0x37]! << 8) | example[0x38]!);
		expect(buildStreamInfo({
			minimumBlockSize: 4096,
			maximumBlockSize: 4096,
			minimumFrameSize: 15,
			maximumFrameSize: 15,
			sampleRate: 44100,
			channels: 2,
			bitsPerSample: 16,
			totalSamples: 1,
			md5: example.subarray(0x1a, 0x2a),
		})).toEqual(example.subarray(8, 42));
	});
});
