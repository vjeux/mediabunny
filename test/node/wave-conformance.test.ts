import { describe, expect, test, vi } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS, WAVE } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { WavOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { parsePcmCodec, PcmAudioCodec } from '../../src/codec.js';
import { MetadataTags } from '../../src/metadata.js';

// Tests for reading and writing WAVE files: RIFF and RF64 (EBU Tech 3306) containers, the WAVEFORMAT(EX/TENSIBLE)
// format chunk as documented by Microsoft, LIST INFO and ID3 metadata. Files are built chunk by chunk.

type Bytes = number[] | Uint8Array;

const concat = (...parts: Bytes[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
};

const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
const u16 = (value: number) => [value & 0xff, value >> 8];
const u32 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
const u64 = (value: number) => [...u32(value % 2 ** 32), ...u32(Math.floor(value / 2 ** 32))];

const readU32 = (bytes: Uint8Array, offset: number) =>
	(bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
const readU16 = (bytes: Uint8Array, offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8);
const readFourCc = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

// A chunk, including the pad byte that follows odd-sized chunks
const chunk = (id: string, data: Bytes) => concat(ascii(id), u32(data.length), data, data.length & 1 ? [0] : []);

const riff = (...chunks: Uint8Array[]) => {
	const body = concat(ascii('WAVE'), ...chunks);
	return concat(ascii('RIFF'), u32(body.length), body);
};

type FmtOptions = {
	formatTag?: number;
	channels?: number;
	sampleRate?: number;
	bitsPerSample?: number;
	blockAlign?: number;
	extensible?: { validBits: number; channelMask: number; subFormat: number };
	cbSize?: number;
};

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_ALAW = 0x0006;
const WAVE_FORMAT_MULAW = 0x0007;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

// KSDATAFORMAT_SUBTYPE_* GUIDs share everything but the first two bytes
const subFormatGuid = (formatTag: number) =>
	[...u16(formatTag), 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

const fmt = (options: FmtOptions = {}) => {
	const channels = options.channels ?? 2;
	const sampleRate = options.sampleRate ?? 44100;
	const bitsPerSample = options.bitsPerSample ?? 16;
	const blockAlign = options.blockAlign ?? channels * Math.ceil(bitsPerSample / 8);
	const formatTag = options.extensible ? WAVE_FORMAT_EXTENSIBLE : (options.formatTag ?? WAVE_FORMAT_PCM);

	const data = [
		...u16(formatTag),
		...u16(channels),
		...u32(sampleRate),
		...u32(sampleRate * blockAlign),
		...u16(blockAlign),
		...u16(bitsPerSample),
	];

	if (options.extensible) {
		data.push(
			...u16(22),
			...u16(options.extensible.validBits),
			...u32(options.extensible.channelMask),
			...subFormatGuid(options.extensible.subFormat),
		);
	} else if (options.cbSize !== undefined) {
		data.push(...u16(options.cbSize));
	}

	return chunk('fmt ', data);
};

const rampData = (byteLength: number) => Uint8Array.from({ length: byteLength }, (_, i) => (i * 7) & 0xff);

const open = (bytes: Uint8Array) => new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

const readPackets = async (input: Input, options?: { metadataOnly?: boolean }) => {
	const track = await input.getPrimaryAudioTrack();
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track!).packets(undefined, undefined, options)) {
		packets.push(packet);
	}
	return packets;
};

const readTrackInfo = async (bytes: Uint8Array) => {
	using input = open(bytes);
	const track = (await input.getPrimaryAudioTrack())!;
	return {
		codec: await track.getCodec(),
		decoderConfig: await track.getDecoderConfig(),
		internalCodecId: await track.getInternalCodecId(),
		durationFromMetadata: await track.getDurationFromMetadata(),
		packets: await readPackets(input),
	};
};

describe('WAVE format chunk', () => {
	test('maps every supported format and bit depth to its codec', async () => {
		const cases: [FmtOptions, PcmAudioCodec][] = [
			[{ bitsPerSample: 8 }, 'pcm-u8'],
			[{ bitsPerSample: 16 }, 'pcm-s16'],
			[{ bitsPerSample: 24 }, 'pcm-s24'],
			[{ bitsPerSample: 32 }, 'pcm-s32'],
			[{ formatTag: WAVE_FORMAT_IEEE_FLOAT, bitsPerSample: 32, cbSize: 0 }, 'pcm-f32'],
			[{ formatTag: WAVE_FORMAT_IEEE_FLOAT, bitsPerSample: 64, cbSize: 0 }, 'pcm-f64'],
			[{ formatTag: WAVE_FORMAT_ALAW, bitsPerSample: 8, cbSize: 0 }, 'alaw'],
			[{ formatTag: WAVE_FORMAT_MULAW, bitsPerSample: 8, cbSize: 0 }, 'ulaw'],
		];

		for (const [options, codec] of cases) {
			const info = await readTrackInfo(riff(
				fmt({ ...options, channels: 3, sampleRate: 22050 }),
				chunk('data', []),
			));

			expect(info.codec).toBe(codec);
			expect(info.decoderConfig).toEqual({ codec, numberOfChannels: 3, sampleRate: 22050 });
		}
	});

	test('reads the codec of WAVE_FORMAT_EXTENSIBLE files from the sub-format GUID', async () => {
		const cases: [FmtOptions['extensible'], number, PcmAudioCodec][] = [
			[{ validBits: 16, channelMask: 0x3f, subFormat: WAVE_FORMAT_PCM }, 16, 'pcm-s16'],
			[{ validBits: 20, channelMask: 0x3f, subFormat: WAVE_FORMAT_PCM }, 24, 'pcm-s24'], // 20 bits in 24
			[{ validBits: 24, channelMask: 0x3f, subFormat: WAVE_FORMAT_PCM }, 32, 'pcm-s32'], // 24 bits in 32
			[{ validBits: 32, channelMask: 0x3f, subFormat: WAVE_FORMAT_IEEE_FLOAT }, 32, 'pcm-f32'],
			[{ validBits: 8, channelMask: 0x3f, subFormat: WAVE_FORMAT_MULAW }, 8, 'ulaw'],
		];

		for (const [extensible, bitsPerSample, codec] of cases) {
			const info = await readTrackInfo(riff(
				fmt({ channels: 6, sampleRate: 48000, bitsPerSample, extensible }),
				chunk('data', rampData(6 * bitsPerSample / 8 * 10)),
			));

			expect(info.codec).toBe(codec);
			expect(info.decoderConfig).toEqual({ codec, numberOfChannels: 6, sampleRate: 48000 });
			expect(info.internalCodecId).toBe(extensible!.subFormat);
			expect(info.packets[0]!.data.byteLength).toBe(6 * bitsPerSample / 8 * 10);
		}
	});

	test('reads a plain WAVEFORMAT chunk as 8-bit', async () => {
		const plainWaveFormat = chunk('fmt ', [
			...u16(WAVE_FORMAT_PCM),
			...u16(1), // Channels
			...u32(8000), // Sample rate
			...u32(8000), // Bytes per second
			...u16(1), // Block align
		]);
		const info = await readTrackInfo(riff(plainWaveFormat, chunk('data', rampData(80))));

		expect(info.codec).toBe('pcm-u8');
		expect(info.durationFromMetadata).toBe(0.01);
	});

	test('rejects formats and bit depths it can\'t decode', async () => {
		const cases: [FmtOptions, string][] = [
			// ADPCM and MP3
			[{ formatTag: 0x0002, bitsPerSample: 4, blockAlign: 1024, cbSize: 0 }, 'WAVE codec (format tag 2)'],
			[{ formatTag: 0x0055, bitsPerSample: 0, blockAlign: 1, cbSize: 0 }, 'WAVE codec (format tag 85)'],
			[
				{ bitsPerSample: 16, extensible: { validBits: 16, channelMask: 3, subFormat: 0x0002 } },
				'Unsupported WAVE codec (format tag 2)',
			],
			[{ bitsPerSample: 12, blockAlign: 4 }, 'Unsupported WAVE PCM bit depth (12)'],
			[{ formatTag: WAVE_FORMAT_IEEE_FLOAT, bitsPerSample: 16, cbSize: 0 }, 'WAVE float bit depth (16)'],
		];

		for (const [options, message] of cases) {
			using input = open(riff(fmt(options), chunk('data', rampData(16))));
			await expect(input.getPrimaryAudioTrack()).rejects.toThrow(message);
		}
	});

	test('rejects zero channels, a zero sample rate or a zero block size', async () => {
		for (const options of [{ channels: 0 }, { sampleRate: 0 }, { blockAlign: 0 }]) {
			using input = open(riff(fmt(options), chunk('data', rampData(16))));
			await expect(input.getPrimaryAudioTrack()).rejects.toThrow('must be positive');
		}
	});

	test('rejects files without format or data chunk', async () => {
		for (const [bytes, message] of [
			[riff(chunk('data', rampData(16))), 'missing "fmt " chunk'],
			[riff(fmt()), 'missing "data" chunk'],
		] as const) {
			using input = open(bytes);
			await expect(input.getPrimaryAudioTrack()).rejects.toThrow(message);
		}
	});
});

describe('WAVE chunk layout', () => {
	test('skips unknown chunks around the data chunk, honoring the pad byte of odd-sized chunks', async () => {
		const data = rampData(4 * 100);
		using input = open(riff(
			chunk('JUNK', new Uint8Array(27)),
			fmt(),
			chunk('bext', rampData(603)),
			chunk('fact', u32(100)),
			chunk('data', data),
			chunk('cue ', rampData(29)),
			chunk('iXML', ascii('<BWFXML/>')),
			chunk('LIST', [...ascii('INFO'), ...chunk('INAM', [...ascii('Odd'), 0])]),
		));

		const packets = await readPackets(input);
		expect(concat(...packets.map(packet => packet.data))).toEqual(data);
		expect((await input.getMetadataTags()).title).toBe('Odd');
	});

	test('finds the format chunk behind the data chunk', async () => {
		const info = await readTrackInfo(riff(chunk('data', rampData(400)), fmt({ channels: 1, bitsPerSample: 8 })));

		expect(info.codec).toBe('pcm-u8');
		expect(info.packets[0]!.data.byteLength).toBe(400);
	});

	test('limits the data to the end of the file and to whole sample frames', async () => {
		const file = riff(fmt({ channels: 2, bitsPerSample: 24 }), chunk('data', rampData(6 * 100)));
		// The data chunk claims 600 bytes, but the file ends 5 bytes before
		const info = await readTrackInfo(file.subarray(0, file.length - 5));

		expect(info.packets.map(packet => packet.data.byteLength)).toEqual([6 * 99]);
		expect(info.durationFromMetadata).toBe(99 / 44100);
	});

	test('reads files with an empty data chunk', async () => {
		using input = open(riff(fmt(), chunk('data', [])));

		expect(await readPackets(input)).toEqual([]);
		expect(await input.computeDuration()).toBe(0);
		expect(await (await input.getPrimaryAudioTrack())!.getDurationFromMetadata()).toBe(0);
	});
});

describe('RF64', () => {
	const ds64 = (riffSize: number, dataSize: number, sampleCount: number) =>
		chunk('ds64', [...u64(riffSize), ...u64(dataSize), ...u64(sampleCount), ...u32(0)]);

	const rf64 = (...chunks: Uint8Array[]) => concat(ascii('RF64'), u32(0xffffffff), ascii('WAVE'), ...chunks);

	test('takes the RIFF and data sizes from the ds64 chunk', async () => {
		const data = rampData(4 * 5000);
		const fmtChunk = fmt();
		const bytes = rf64(
			ds64(4 + 36 + fmtChunk.length + 8 + data.length, data.length, 5000),
			fmtChunk,
			concat(ascii('data'), u32(0xffffffff), data),
		);

		using input = open(bytes);
		expect(await input.getFormat()).toBe(WAVE);
		const packets = await readPackets(input);
		expect(concat(...packets.map(packet => packet.data))).toEqual(data);
		expect(await (await input.getPrimaryAudioTrack())!.getDurationFromMetadata()).toBe(5000 / 44100);
	});

	test('rejects RF64 files whose first chunk isn\'t ds64 or whose ds64 chunk is too short', async () => {
		for (const [bytes, message] of [
			[rf64(fmt(), chunk('data', rampData(16))), 'First chunk must be "ds64"'],
			[rf64(chunk('ds64', new Uint8Array(8)), fmt(), chunk('data', rampData(16))), '"ds64" chunk is too small'],
		] as const) {
			using input = open(bytes);
			await expect(input.getPrimaryAudioTrack()).rejects.toThrow(message);
		}
	});
});

describe('WAVE metadata', () => {
	test('reads RIFF INFO tags', async () => {
		const info = (id: string, value: string) => chunk(id, [...ascii(value), 0]);
		using input = open(riff(
			fmt(),
			chunk('LIST', concat(
				ascii('INFO'),
				info('INAM', 'Title'),
				info('IART', 'Artist'),
				info('IPRD', 'Album'),
				info('ITRK', '3/12'),
				info('ICRD', '2020-02-03'),
				info('IGNR', 'Genre'),
				info('ICMT', 'Comment'),
				info('ISFT', 'Lavf61.1.100'),
				chunk('IENG', ascii('No terminator')),
			)),
			chunk('data', rampData(16)),
		));

		const tags = await input.getMetadataTags();
		expect(tags).toEqual({
			title: 'Title',
			artist: 'Artist',
			album: 'Album',
			trackNumber: 3,
			tracksTotal: 12,
			date: new Date(Date.UTC(2020, 1, 3)),
			genre: 'Genre',
			comment: 'Comment',
			raw: {
				INAM: 'Title',
				IART: 'Artist',
				IPRD: 'Album',
				ITRK: '3/12',
				ICRD: '2020-02-03',
				IGNR: 'Genre',
				ICMT: 'Comment',
				ISFT: 'Lavf61.1.100',
				IENG: 'No terminator',
			},
		});
	});

	test('reads INFO tags as ISO-8859-1', async () => {
		using input = open(riff(
			fmt(),
			chunk('LIST', concat(ascii('INFO'), chunk('INAM', [0x43, 0x61, 0x66, 0xe9, 0]))),
			chunk('data', rampData(16)),
		));

		expect((await input.getMetadataTags()).title).toBe('Café');
	});

	test('ignores LIST chunks of other types', async () => {
		using input = open(riff(
			fmt(),
			chunk('LIST', concat(ascii('adtl'), chunk('labl', [...u32(1), ...ascii('Marker'), 0]))),
			chunk('data', rampData(16)),
		));

		expect(await input.getMetadataTags()).toEqual({});
	});

	test('reads ID3v2 tags from "id3 " and "ID3 " chunks', async () => {
		for (const id of ['id3 ', 'ID3 ']) {
			const frame = concat(ascii('TIT2'), [0, 0, 0, 6, 0, 0], [0], ascii('Title'));
			const tag = concat(ascii('ID3'), [3, 0, 0], [0, 0, 0, frame.length], frame);
			using input = open(riff(fmt(), chunk('data', rampData(16)), chunk(id, tag)));

			const tags = await input.getMetadataTags();
			expect(tags.title).toBe('Title');
			expect(tags.raw!['TIT2']).toBe('Title');
		}
	});
});

describe('WAVE packets', () => {
	// 3-channel 16-bit at 8 kHz: 6 bytes per sample frame
	const frameCount = 2048 * 3 + 100;
	const data = rampData(6 * frameCount);
	const file = () => riff(fmt({ channels: 3, sampleRate: 8000 }), chunk('data', data));

	test('cuts the data into packets of 2048 sample frames', async () => {
		using input = open(file());
		const packets = await readPackets(input);

		expect(packets.map(packet => packet.data.byteLength)).toEqual([6 * 2048, 6 * 2048, 6 * 2048, 6 * 100]);
		expect(packets.map(packet => packet.timestamp)).toEqual([0, 0.256, 0.512, 0.768]);
		expect(packets.map(packet => packet.duration)).toEqual([0.256, 0.256, 0.256, 100 / 8000]);
		expect(packets.every(packet => packet.type === 'key')).toBe(true);
		expect(concat(...packets.map(packet => packet.data))).toEqual(data);

		expect(await input.computeDuration()).toBe(frameCount / 8000);
		expect(await (await input.getPrimaryAudioTrack())!.getDurationFromMetadata()).toBe(frameCount / 8000);
	});

	test('looks up the packet containing a timestamp', async () => {
		using input = open(file());
		const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);

		expect(await sink.getPacket(-0.1)).toBeNull();
		expect((await sink.getPacket(0))!.sequenceNumber).toBe(0);
		expect((await sink.getPacket(0.3))!.sequenceNumber).toBe(1);
		expect((await sink.getPacket(0.8))!.sequenceNumber).toBe(3);
		expect((await sink.getPacket(1000))!.sequenceNumber).toBe(3);
		expect((await sink.getKeyPacket(0.6))!.sequenceNumber).toBe(2);

		const second = (await sink.getNextPacket((await sink.getFirstPacket())!))!;
		expect(second.timestamp).toBe(0.256);
		const last = (await sink.getNextPacket((await sink.getNextPacket(second))!))!;
		expect(await sink.getNextPacket(last)).toBeNull();
	});

	test('gives metadata-only packets the same timing and sizes', async () => {
		using input = open(file());
		const packets = await readPackets(input);
		const metadataOnly = await readPackets(input, { metadataOnly: true });

		expect(metadataOnly.map(packet => [packet.timestamp, packet.duration, packet.byteLength]))
			.toEqual(packets.map(packet => [packet.timestamp, packet.duration, packet.byteLength]));
	});
});

describe('WAVE writing', () => {
	const write = async (
		codec: PcmAudioCodec,
		channels: number,
		sampleRate: number,
		data: Uint8Array,
		options: ConstructorParameters<typeof WavOutputFormat>[0] = {},
		tags?: MetadataTags,
	) => {
		const output = new Output({ format: new WavOutputFormat(options), target: new BufferTarget() });
		if (tags) {
			output.setMetadataTags(tags);
		}
		const source = new EncodedAudioPacketSource(codec);
		output.addAudioTrack(source);
		await output.start();
		const bytesPerFrame = channels * parsePcmCodec(codec).sampleSize;
		await source.add(
			new EncodedPacket(data, 'key', 0, data.length / bytesPerFrame / sampleRate),
			{ decoderConfig: { codec, numberOfChannels: channels, sampleRate } },
		);
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	test('writes the header fields for every codec', async () => {
		const cases: [PcmAudioCodec, number, number][] = [
			// Codec, format tag, bytes per sample
			['pcm-u8', WAVE_FORMAT_PCM, 1],
			['pcm-s16', WAVE_FORMAT_PCM, 2],
			['pcm-s24', WAVE_FORMAT_PCM, 3],
			['pcm-s32', WAVE_FORMAT_PCM, 4],
			['pcm-f32', WAVE_FORMAT_IEEE_FLOAT, 4],
			['pcm-f64', WAVE_FORMAT_IEEE_FLOAT, 8],
			['alaw', WAVE_FORMAT_ALAW, 1],
			['ulaw', WAVE_FORMAT_MULAW, 1],
		];

		for (const [codec, formatTag, bytesPerSample] of cases) {
			const channels = 2;
			const data = rampData(channels * bytesPerSample * 50);
			const bytes = await write(codec, channels, 32000, data);

			expect(readFourCc(bytes, 0)).toBe('RIFF');
			expect(readU32(bytes, 4)).toBe(bytes.length - 8);
			expect(readFourCc(bytes, 8)).toBe('WAVE');
			expect(readFourCc(bytes, 12)).toBe('fmt ');
			expect(readU32(bytes, 16)).toBe(16);
			expect(readU16(bytes, 20)).toBe(formatTag);
			expect(readU16(bytes, 22)).toBe(channels);
			expect(readU32(bytes, 24)).toBe(32000);
			expect(readU32(bytes, 28)).toBe(32000 * channels * bytesPerSample); // Bytes per second
			expect(readU16(bytes, 32)).toBe(channels * bytesPerSample); // Block align
			expect(readU16(bytes, 34)).toBe(8 * bytesPerSample);
			expect(readFourCc(bytes, 36)).toBe('data');
			expect(readU32(bytes, 40)).toBe(data.length);
			expect(bytes.subarray(44)).toEqual(data);

			const info = await readTrackInfo(bytes);
			expect(info.codec).toBe(codec);
			expect(concat(...info.packets.map(packet => packet.data))).toEqual(data);
		}
	});

	test('writes RF64 with the sizes in the ds64 chunk when asked to', async () => {
		const data = rampData(4 * 3000);
		const bytes = await write('pcm-s16', 2, 48000, data, { large: true });

		expect(readFourCc(bytes, 0)).toBe('RF64');
		expect(readU32(bytes, 4)).toBe(0xffffffff);
		expect(readFourCc(bytes, 8)).toBe('WAVE');
		expect(readFourCc(bytes, 12)).toBe('ds64');
		expect(readU32(bytes, 16)).toBe(28);
		expect(readU32(bytes, 20)).toBe(bytes.length - 8); // RIFF size, low 32 bits
		expect(readU32(bytes, 24)).toBe(0);
		expect(readU32(bytes, 28)).toBe(data.length); // Data size
		expect(readU32(bytes, 32)).toBe(0);
		expect(readU32(bytes, 36)).toBe(3000); // Sample count
		expect(readU32(bytes, 40)).toBe(0);
		expect(readU32(bytes, 44)).toBe(0); // Table length
		expect(readFourCc(bytes, 48)).toBe('fmt ');
		expect(readFourCc(bytes, 72)).toBe('data');
		expect(readU32(bytes, 76)).toBe(0xffffffff);

		const info = await readTrackInfo(bytes);
		expect(concat(...info.packets.map(packet => packet.data))).toEqual(data);
		expect(info.durationFromMetadata).toBe(3000 / 48000);
	});

	test('writes metadata as a RIFF INFO chunk between the format and data chunks', async () => {
		const bytes = await write('pcm-s16', 1, 8000, rampData(16), {}, {
			title: 'Title',
			artist: 'Ärtist',
			album: 'Album',
			trackNumber: 3,
			tracksTotal: 12,
			genre: 'Genre',
			date: new Date(Date.UTC(2020, 1, 3)),
			comment: 'Odd',
			raw: { ISFT: 'Encoder', IENG: 'Engineer', TOOLONG: 'ignored' },
		});

		expect(readFourCc(bytes, 36)).toBe('LIST');
		const listSize = readU32(bytes, 40);
		expect(listSize % 2).toBe(0);
		expect(readFourCc(bytes, 44)).toBe('INFO');
		expect(readFourCc(bytes, 44 + listSize)).toBe('data');

		const entries: Record<string, number[]> = {};
		let pos = 48;
		while (pos < 44 + listSize) {
			const size = readU32(bytes, pos + 4);
			entries[readFourCc(bytes, pos)] = [...bytes.subarray(pos + 8, pos + 8 + size)];
			pos += 8 + size + (size & 1);
		}

		expect(entries).toEqual({
			INAM: [...ascii('Title'), 0],
			IART: [0xc4, ...ascii('rtist'), 0],
			IPRD: [...ascii('Album'), 0],
			ITRK: [...ascii('3/12'), 0],
			IGNR: [...ascii('Genre'), 0],
			ICRD: [...ascii('2020-02-03'), 0],
			ICMT: [...ascii('Odd'), 0],
			ISFT: [...ascii('Encoder'), 0],
			IENG: [...ascii('Engineer'), 0],
		});

		using input = open(bytes);
		const tags = await input.getMetadataTags();
		expect(tags.title).toBe('Title');
		expect(tags.artist).toBe('Ärtist');
		expect(tags.trackNumber).toBe(3);
		expect(tags.tracksTotal).toBe(12);
		expect(tags.date).toEqual(new Date(Date.UTC(2020, 1, 3)));
	});

	test('leaves out INFO tags that ISO-8859-1 can\'t hold', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const bytes = await write('pcm-s16', 1, 8000, rampData(16), {}, { title: 'Fish 鱼', artist: 'Artist' });

		using input = open(bytes);
		const tags = await input.getMetadataTags();
		expect(tags.title).toBeUndefined();
		expect(tags.artist).toBe('Artist');
		expect(warn).toHaveBeenCalled();
	});

	test('reports the header through onHeader', async () => {
		let header: { data: Uint8Array; position: number } | null = null;
		const bytes = await write('pcm-s24', 2, 96000, rampData(6 * 10), {
			onHeader: (data, position) => {
				header = { data: data.slice(), position };
			},
		}, { title: 'Header' });

		const { data, position } = header!;
		expect(position).toBe(0);
		expect(readFourCc(data, 0)).toBe('RIFF');
		expect(readFourCc(data, data.length - 8)).toBe('data');
		// The sizes in the header are placeholders until the file is finalized
		expect(readU32(data, 4)).toBe(0);
		expect(readU32(data, data.length - 4)).toBe(0);
		expect(data.subarray(8, data.length - 4)).toEqual(bytes.subarray(8, data.length - 4));
	});

	test('writes just the header for an empty track described by its decoder config', async () => {
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('pcm-f32');
		output.addAudioTrack(source, { decoderConfig: { codec: 'pcm-f32', numberOfChannels: 2, sampleRate: 48000 } });
		await output.start();
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		expect(bytes.length).toBe(44);
		expect(readU32(bytes, 40)).toBe(0);

		const info = await readTrackInfo(bytes);
		expect(info.codec).toBe('pcm-f32');
		expect(info.packets).toEqual([]);
	});

	test('refuses to finalize an empty track it knows nothing about', async () => {
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'));
		await output.start();
		await expect(output.finalize()).rejects.toThrow('Cannot finalize an empty WAVE file');
	});
});
