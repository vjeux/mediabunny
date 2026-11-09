import { beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	FilePathSource,
	FlacOutputFormat,
	Input,
	InputAudioTrack,
	OGG,
	OggOutputFormat,
	Output,
} from '../../src/index.js';

// Normative compliance of Mediabunny's Ogg and FLAC writers and readers, one test per checked statement of RFC 3533
// (Ogg), RFC 7845 (Ogg Opus), the Vorbis I specification's Ogg encapsulation and RFC 9639 (FLAC). Test names start
// with the clause they check.

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// --- Ogg page parsing ---

type OggPage = {
	offset: number;
	version: number;
	headerType: number;
	granule: bigint;
	serial: number;
	sequence: number;
	crc: number;
	lacing: number[];
	body: Uint8Array;
	bytes: Uint8Array;
};

const parseOggPages = (bytes: Uint8Array) => {
	const pages: OggPage[] = [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = 0;
	while (pos + 27 <= bytes.length) {
		const segments = bytes[pos + 26]!;
		const lacing = [...bytes.subarray(pos + 27, pos + 27 + segments)];
		const bodyLength = lacing.reduce((a, b) => a + b, 0);
		const end = pos + 27 + segments + bodyLength;
		pages.push({
			offset: pos,
			version: bytes[pos + 4]!,
			headerType: bytes[pos + 5]!,
			granule: view.getBigInt64(pos + 6, true),
			serial: view.getUint32(pos + 14, true),
			sequence: view.getUint32(pos + 18, true),
			crc: view.getUint32(pos + 22, true),
			lacing,
			body: bytes.subarray(pos + 27 + segments, end),
			bytes: bytes.subarray(pos, end),
		});
		pos = end;
	}
	return pages;
};

const oggCrc = (bytes: Uint8Array) => {
	let crc = 0;
	for (let i = 0; i < bytes.length; i++) {
		const byte = i >= 22 && i < 26 ? 0 : bytes[i]!; // The CRC field itself counts as zero
		crc ^= byte << 24;
		for (let bit = 0; bit < 8; bit++) {
			crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
		}
	}
	return crc >>> 0;
};

type OggPacket = { data: Uint8Array; firstPage: number; lastPage: number };

/** Reassembles the packets of one logical bitstream; page indices refer to that stream's pages. */
const oggPackets = (pages: OggPage[]) => {
	const packets: OggPacket[] = [];
	let current: number[] = [];
	let firstPage = 0;
	pages.forEach((page, pageIndex) => {
		let offset = 0;
		for (const value of page.lacing) {
			if (current.length === 0) {
				firstPage = pageIndex;
			}
			current.push(...page.body.subarray(offset, offset + value));
			offset += value;
			if (value < 255) {
				packets.push({ data: new Uint8Array(current), firstPage, lastPage: pageIndex });
				current = [];
			}
		}
	});
	return packets;
};

const streamsOf = (pages: OggPage[]) => {
	const streams = new Map<number, OggPage[]>();
	for (const page of pages) {
		if (!streams.has(page.serial)) {
			streams.set(page.serial, []);
		}
		streams.get(page.serial)!.push(page);
	}
	return streams;
};

const BOS = 0x02;
const EOS = 0x04;
const CONTINUED = 0x01;

// --- Opus helpers ---

const opusHead = (options: { preSkip?: number; channels?: number; family?: number; mapping?: number[];
	inputSampleRate?: number; version?: number; } = {}) => {
	const family = options.family ?? 0;
	const channels = options.channels ?? 2;
	const bytes = new Uint8Array(19 + (family === 0 ? 0 : 2 + channels));
	const view = new DataView(bytes.buffer);
	bytes.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // 'OpusHead'
	bytes[8] = options.version ?? 1;
	bytes[9] = channels;
	view.setUint16(10, options.preSkip ?? 312, true);
	view.setUint32(12, options.inputSampleRate ?? 48000, true);
	bytes[18] = family;
	if (family !== 0) {
		bytes.set(options.mapping!, 19);
	}
	return bytes;
};

/** Samples in an Opus packet (RFC 6716, Section 3.1). */
const opusPacketSamples = (packet: Uint8Array) => {
	const config = packet[0]! >> 3;
	const frameSamples = config < 12
		? [480, 960, 1920, 2880][config % 4]!
		: config < 16 ? [480, 960][config % 2]! : [120, 240, 480, 960][config % 4]!;
	const code = packet[0]! & 3;
	const frames = code === 0 ? 1 : code === 3 ? packet[1]! & 0x3f : 2;
	return frames * frameSamples;
};

const addOpusTrack = (output: Output, options: {
	head?: Uint8Array;
	firstTimestamp?: number;
	packetSizes?: number[];
	packets?: number;
} = {}) => {
	const source = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(source);
	const head = options.head ?? opusHead();
	const preSkip = head[10]! | (head[11]! << 8);

	return async () => {
		const count = options.packets ?? 120;
		for (let i = 0; i < count; i++) {
			const size = options.packetSizes?.[i % options.packetSizes.length] ?? 60;
			const data = new Uint8Array(size).fill(i & 0xff);
			data[0] = 0xfc; // CELT fullband 20 ms, stereo, one frame
			const timestamp = (options.firstTimestamp ?? -preSkip / 48000) + i * 0.02;
			await source.add(new EncodedPacket(data, 'key', timestamp, 0.02), i === 0
				? {
						decoderConfig: {
							codec: 'opus',
							numberOfChannels: head[9]!,
							sampleRate: 48000,
							description: head,
						},
					}
				: undefined);
		}
	};
};

/** Copies the audio track of a repository file into the output, packet by packet. */
const addCopiedTrack = async (output: Output, fileName: string, packetFilter = (index: number) => index >= 0) => {
	const filePath = path.join(__dirname, '../public', fileName);
	const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	const codec = (await track.getCodec())!;
	const decoderConfig = (await track.getDecoderConfig())!;
	const source = new EncodedAudioPacketSource(codec as 'opus');
	output.addAudioTrack(source);

	return async () => {
		let index = 0;
		let first = true;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			if (packetFilter(index++)) {
				await source.add(packet, first ? { decoderConfig } : undefined);
				first = false;
			}
		}
		input.dispose();
	};
};

const build = async (
	format: OggOutputFormat | FlacOutputFormat,
	setup: (output: Output) => Promise<() => Promise<void>> | (() => Promise<void>),
) => {
	const output = new Output({ format, target: new BufferTarget() });
	const run = await setup(output);
	await output.start();
	await run();
	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

type OggFile = { name: string; bytes: Uint8Array; pages: OggPage[]; codec: 'opus' | 'vorbis' };
let oggFiles: OggFile[] = [];
let flacFiles: { name: string; bytes: Uint8Array }[] = [];

beforeAll(async () => {
	const ogg: Omit<OggFile, 'pages'>[] = [];
	const add = async (name: string, codec: 'opus' | 'vorbis', setup: Parameters<typeof build>[1]) => {
		ogg.push({ name, codec, bytes: await build(new OggOutputFormat(), setup) });
	};

	await add('opus-stereo-tags', 'opus', (output) => {
		output.setMetadataTags({
			title: 'Title',
			artist: 'Artist',
			raw: { CUSTOM: 'Value' },
			// A large picture makes the comment header span several pages
			images: [{ data: new Uint8Array(70000).fill(7), mimeType: 'image/png', kind: 'coverFront' }],
		});
		// Packet sizes around the 255-byte lacing boundaries
		return addOpusTrack(output, { packetSizes: [60, 255, 510, 254, 256, 1000, 765] });
	});
	await add('opus-surround', 'opus', output => addOpusTrack(output, {
		head: opusHead({ channels: 6, family: 1, mapping: [4, 2, 0, 4, 1, 2, 3, 5] }),
	}));
	await add('opus-late-start', 'opus', output => addOpusTrack(output, { firstTimestamp: 1 }));
	await add('opus-two-streams', 'opus', (output) => {
		const first = addOpusTrack(output);
		const second = addOpusTrack(output, { head: opusHead({ preSkip: 120, channels: 1 }) });
		return async () => {
			await Promise.all([first(), second()]);
		};
	});
	await add('opus-copy', 'opus', output => addCopiedTrack(output, 'preroll-test.opus'));
	await add('vorbis-copy', 'vorbis', output => addCopiedTrack(output, 'vorbis-eos.ogg'));
	oggFiles = ogg.map(file => ({ ...file, pages: parseOggPages(file.bytes) }));

	flacFiles = [
		{
			name: 'flac-copy',
			bytes: await build(new FlacOutputFormat(), output => addCopiedTrack(output, 'sample.flac')),
		},
		{
			name: 'flac-tags',
			bytes: await build(new FlacOutputFormat(), (output) => {
				output.setMetadataTags({
					title: 'Tïtle',
					artist: 'Artist',
					raw: { CUSTOM: 'Value' },
					images: [{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', kind: 'coverFront' }],
				});
				return addCopiedTrack(output, 'sample.flac', index => index < 40);
			}),
		},
	];
});

describe('Writer: RFC 3533 (Ogg)', () => {
	test('§6: every page starts with "OggS", stream structure version 0, and only defined header type flags', () => {
		for (const file of oggFiles) {
			for (const page of file.pages) {
				expect(new TextDecoder().decode(page.bytes.subarray(0, 4))).toBe('OggS');
				expect(page.version).toBe(0);
				expect(page.headerType & ~0x07).toBe(0);
			}
		}
	});

	test('§6: the pages tile the file exactly, their segment tables matching their bodies', () => {
		for (const file of oggFiles) {
			const last = file.pages.at(-1)!;
			expect(last.offset + last.bytes.length).toBe(file.bytes.length);
			for (const page of file.pages) {
				expect(page.lacing.length).toBeLessThanOrEqual(255);
				expect(page.body.length).toBe(page.lacing.reduce((a, b) => a + b, 0));
			}
		}
	});

	test('§6: the CRC checksum covers the whole page with the CRC field set to zero (polynomial 0x04c11db7)', () => {
		for (const file of oggFiles) {
			for (const page of file.pages) {
				expect(page.crc).toBe(oggCrc(page.bytes));
			}
		}
	});

	test('§6: page sequence numbers of each logical bitstream start at 0 and increase by one', () => {
		for (const file of oggFiles) {
			for (const pages of streamsOf(file.pages).values()) {
				expect(pages.map(page => page.sequence)).toEqual(pages.map((_, i) => i));
			}
		}
	});

	test('§4/§6: each logical bitstream has a unique serial number', () => {
		const file = oggFiles.find(file => file.name === 'opus-two-streams')!;
		expect(streamsOf(file.pages).size).toBe(2);
	});

	test('§4: the first page of each logical bitstream, and only that one, is a bos page', () => {
		for (const file of oggFiles) {
			for (const pages of streamsOf(file.pages).values()) {
				expect(pages.map(page => !!(page.headerType & BOS))).toEqual(pages.map((_, i) => i === 0));
			}
		}
	});

	test('§4/Appendix A: all bos pages of grouped logical bitstreams come before any data pages', () => {
		for (const file of oggFiles) {
			const firstNonBos = file.pages.findIndex(page => !(page.headerType & BOS));
			const lastBos = file.pages.map(page => !!(page.headerType & BOS)).lastIndexOf(true);
			expect(lastBos).toBeLessThan(firstNonBos);
		}
	});

	test('§4/§6: the last page of each logical bitstream, and only that one, is an eos page', () => {
		for (const file of oggFiles) {
			for (const pages of streamsOf(file.pages).values()) {
				expect(pages.map(page => !!(page.headerType & EOS)))
					.toEqual(pages.map((_, i) => i === pages.length - 1));
			}
		}
	});

	test('§6: pages on which no packet ends have a granule position of -1', () => {
		let checked = 0;
		for (const file of oggFiles) {
			for (const page of file.pages) {
				if (page.lacing.every(value => value === 255)) {
					expect(page.granule).toBe(-1n);
					checked++;
				} else {
					expect(page.granule).toBeGreaterThanOrEqual(0n);
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	test('§6: the continued-packet flag is set exactly on pages whose first segment continues a packet', () => {
		for (const file of oggFiles) {
			for (const pages of streamsOf(file.pages).values()) {
				pages.forEach((page, index) => {
					const continues = index > 0 && pages[index - 1]!.lacing.at(-1) === 255;
					expect(!!(page.headerType & CONTINUED)).toBe(continues);
				});
			}
		}
	});

	test('§5/Ogg framing: a packet of a multiple of 255 bytes is terminated by a 0 lacing value', () => {
		const file = oggFiles.find(file => file.name === 'opus-stereo-tags')!;
		const packets = oggPackets([...streamsOf(file.pages).values()][0]!);
		const sizes = packets.slice(2).map(packet => packet.data.length);
		expect(sizes).toContain(255);
		expect(sizes).toContain(510);
		expect(sizes).toContain(765);
	});

	test('Appendix A: the pages of each logical bitstream come in temporal order', () => {
		for (const file of oggFiles) {
			for (const pages of streamsOf(file.pages).values()) {
				const granules = pages.map(page => page.granule).filter(granule => granule >= 0n);
				expect(granules).toEqual([...granules].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
			}
		}
	});

	test('§4: interleaved streams are multiplexed by time (pages ordered by their start time)', () => {
		const file = oggFiles.find(file => file.name === 'opus-two-streams')!;
		const dataPages = file.pages.filter(page => page.granule > 0n);
		const lastGranuleBefore = new Map<number, bigint>();
		for (const page of dataPages) {
			// No page of one stream may lag a whole second behind pages already written for the other
			for (const [serial, granule] of lastGranuleBefore) {
				if (serial !== page.serial) {
					expect(Number(granule - page.granule)).toBeLessThan(48000);
				}
			}
			lastGranuleBefore.set(page.serial, page.granule);
		}
	});
});

const opusStreams = () => oggFiles.filter(file => file.codec === 'opus')
	.flatMap(file => [...streamsOf(file.pages).values()].map(pages => ({ file, pages, packets: oggPackets(pages) })));

describe('Writer: RFC 7845 (Ogg Opus)', () => {
	test('§3: the first packet is the ID header, placed alone on the first (bos) page, which it completes', () => {
		for (const { pages, packets } of opusStreams()) {
			expect(new TextDecoder().decode(packets[0]!.data.subarray(0, 8))).toBe('OpusHead');
			expect(packets[0]!.firstPage).toBe(0);
			expect(packets[0]!.lastPage).toBe(0);
			expect(packets[1]!.firstPage).toBeGreaterThan(0); // Nothing else on the first page
			expect(pages[0]!.headerType & BOS).toBe(BOS);
		}
	});

	test('§3: the second packet is the comment header, beginning on the second page', () => {
		for (const { packets } of opusStreams()) {
			expect(new TextDecoder().decode(packets[1]!.data.subarray(0, 8))).toBe('OpusTags');
			expect(packets[1]!.firstPage).toBe(1);
		}
	});

	test('§3: the comment header finishes the page on which it completes (it may span pages)', () => {
		let spanning = 0;
		for (const { pages, packets } of opusStreams()) {
			const comment = packets[1]!;
			expect(packets[2]!.firstPage).toBeGreaterThan(comment.lastPage);
			expect(pages[comment.lastPage]!.lacing.at(-1)).toBeLessThan(255);
			spanning += comment.lastPage > comment.firstPage ? 1 : 0;
		}
		expect(spanning).toBeGreaterThan(0); // The tagged file's comment header holds a 70 kB picture
	});

	test('§3: no zero-octet audio data packets are written', () => {
		for (const { packets } of opusStreams()) {
			for (const packet of packets.slice(2)) {
				expect(packet.data.length).toBeGreaterThan(0);
			}
		}
	});

	test('§3: no pages follow the eos page of a logical bitstream', () => {
		for (const file of oggFiles) {
			for (const pages of streamsOf(file.pages).values()) {
				const eosIndex = pages.findIndex(page => page.headerType & EOS);
				expect(eosIndex).toBe(pages.length - 1);
			}
		}
	});

	test('§4: the ID header page and the page completing the comment header have granule position 0', () => {
		for (const { pages, packets } of opusStreams()) {
			expect(pages[0]!.granule).toBe(0n);
			expect(pages[packets[1]!.lastPage]!.granule).toBe(0n);
		}
	});

	test('§4/§4.1: each page\'s granule position adds exactly the samples of the packets completing on it', () => {
		for (const { pages, packets } of opusStreams()) {
			let previous: bigint | null = null;
			pages.forEach((page, index) => {
				if (page.granule < 0n || index <= packets[1]!.lastPage) {
					return;
				}
				const samples = packets.slice(2).filter(packet => packet.lastPage === index)
					.reduce((sum, packet) => sum + opusPacketSamples(packet.data), 0);
				if (previous !== null && !(page.headerType & EOS)) {
					expect(page.granule - previous).toBe(BigInt(samples));
				}
				previous = page.granule;
			});
		}
	});

	test('§4.4: end trimming on the eos page discards no more samples than the last packet decodes to', () => {
		for (const { pages, packets } of opusStreams()) {
			const last = pages.at(-1)!;
			const previous = pages.slice(0, -1).filter(page => page.granule >= 0n).at(-1)!;
			const completing = packets.slice(2).filter(packet => packet.lastPage === pages.length - 1);
			const samples = completing.reduce((sum, packet) => sum + opusPacketSamples(packet.data), 0);
			const discarded = BigInt(samples) - (last.granule - previous.granule);
			expect(discarded).toBeGreaterThanOrEqual(0n);
			expect(discarded).toBeLessThanOrEqual(BigInt(opusPacketSamples(completing.at(-1)!.data)));
		}
	});

	test('§4.5: the first audio page\'s granule position is not smaller than the samples completing on it', () => {
		for (const { pages, packets } of opusStreams()) {
			const firstAudioPage = packets[2]!.lastPage;
			const samples = packets.slice(2).filter(packet => packet.lastPage === firstAudioPage)
				.reduce((sum, packet) => sum + opusPacketSamples(packet.data), 0);
			expect(pages[firstAudioPage]!.granule).toBeGreaterThanOrEqual(BigInt(samples));
		}
	});

	test('§4.5: a stream starting later begins with a granule position larger than its samples (MAY)', () => {
		const file = oggFiles.find(file => file.name === 'opus-late-start')!;
		const pages = [...streamsOf(file.pages).values()][0]!;
		const packets = oggPackets(pages);
		const firstAudioPage = packets[2]!.lastPage;
		const samples = packets.slice(2).filter(packet => packet.lastPage === firstAudioPage)
			.reduce((sum, packet) => sum + opusPacketSamples(packet.data), 0);
		// 1 s plus the pre-skip, plus the audio on the page
		expect(pages[firstAudioPage]!.granule).toBe(BigInt(48000 + 312 + samples));
	});

	test('§5.1: the ID header has version 1, a non-zero channel count and a mapping table exactly for family != 0',
		() => {
			for (const { packets } of opusStreams()) {
				const head = packets[0]!.data;
				expect(head[8]).toBe(1);
				expect(head[9]).toBeGreaterThan(0);
				const family = head[18]!;
				expect(head.length).toBe(family === 0 ? 19 : 21 + head[9]!);
			}
		});

	test('§5.1.1: with mapping family 1, the stream counts and the channel mapping indices are consistent', () => {
		const file = oggFiles.find(file => file.name === 'opus-surround')!;
		const head = oggPackets(file.pages)[0]!.data;
		const streamCount = head[19]!;
		const coupledCount = head[20]!;
		expect(streamCount).toBeGreaterThan(0);
		expect(coupledCount).toBeLessThanOrEqual(streamCount);
		for (const index of head.subarray(21)) {
			expect(index < streamCount + coupledCount || index === 255).toBe(true);
		}
	});

	test('§5.2: the comment header holds a vendor string and a comment list that fit the packet', () => {
		for (const { packets } of opusStreams()) {
			const data = packets[1]!.data;
			const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
			let pos = 8;
			const vendorLength = view.getUint32(pos, true);
			pos += 4 + vendorLength;
			expect(pos).toBeLessThanOrEqual(data.length);
			const count = view.getUint32(pos, true);
			pos += 4;
			for (let i = 0; i < count; i++) {
				const length = view.getUint32(pos, true);
				pos += 4;
				const comment = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(pos, pos + length));
				expect(comment).toMatch(/^[\x20-\x3c\x3e-\x7d]+=/); // Field names: printable ASCII without '='
				pos += length;
			}
			expect(pos).toBeLessThanOrEqual(data.length);
		}
	});

	test('§5.1: the output gain of the ID header is passed through (zero for our encoder configs)', () => {
		for (const { packets } of opusStreams()) {
			const head = packets[0]!.data;
			expect(head[16]! | (head[17]! << 8)).toBe(0);
		}
	});

	test('§9: the MIME type is audio/ogg with the opus codec', async () => {
		const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
		const run = addOpusTrack(output, { packets: 2 });
		await output.start();
		await run();
		expect(await output.getMimeType()).toBe('audio/ogg; codecs="opus"');
		await output.finalize();
	});
});

describe('Writer: Vorbis I specification, Ogg encapsulation (Section 4.3.9 / Appendix A)', () => {
	const vorbisPages = () => {
		const file = oggFiles.find(file => file.name === 'vorbis-copy')!;
		return [...streamsOf(file.pages).values()][0]!;
	};

	test('the identification header is alone on the first page, which is the bos page', () => {
		const pages = vorbisPages();
		const packets = oggPackets(pages);
		expect(packets[0]!.data[0]).toBe(1);
		expect(new TextDecoder().decode(packets[0]!.data.subarray(1, 7))).toBe('vorbis');
		expect(packets[0]!.lastPage).toBe(0);
		expect(packets[1]!.firstPage).toBe(1);
	});

	test('the comment and setup headers follow, and the setup header ends its page before audio packets', () => {
		const packets = oggPackets(vorbisPages());
		expect(packets[1]!.data[0]).toBe(3);
		expect(packets[2]!.data[0]).toBe(5);
		expect(packets[3]!.firstPage).toBeGreaterThan(packets[2]!.lastPage);
	});

	test('header pages have granule position 0', () => {
		const pages = vorbisPages();
		const packets = oggPackets(pages);
		for (let i = 0; i <= packets[2]!.lastPage; i++) {
			expect(pages[i]!.granule).toBe(0n);
		}
	});
});

const readOpusInput = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		return null;
	}
	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		timestamps.push(packet.timestamp);
	}
	return { track, timestamps, channels: await track.getNumberOfChannels(), sampleRate: await track.getSampleRate() };
};

/** Builds an Ogg Opus stream page by page: [headerType, granule, packets][] */
type PageSpec = { headerType: number; granule: number; lacing: number[]; body: Uint8Array };

/** Builds Ogg pages exactly as specified, so that a page may end or begin in the middle of a packet */
const buildOggPages = (pagesSpec: PageSpec[], serial = 1234) => {
	const parts = pagesSpec.map(({ headerType, granule, lacing, body }, sequence) => {
		expect(lacing.reduce((a, b) => a + b, 0)).toBe(body.length);
		const page = new Uint8Array(27 + lacing.length + body.length);
		const view = new DataView(page.buffer);
		page.set([0x4f, 0x67, 0x67, 0x53]); // 'OggS'
		page[5] = headerType;
		view.setBigInt64(6, BigInt(granule), true);
		view.setUint32(14, serial, true);
		view.setUint32(18, sequence, true);
		page[26] = lacing.length;
		page.set(lacing, 27);
		page.set(body, 27 + lacing.length);
		view.setUint32(22, oggCrc(page), true);
		return page;
	});
	const total = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		total.set(part, offset);
		offset += part.length;
	}
	return total;
};

/** Lacing values of a complete packet */
const lacingOf = (packetLength: number) => [
	...Array<number>(Math.floor(packetLength / 255)).fill(255),
	packetLength % 255,
];

/** Builds an Ogg Opus stream page by page, each page holding complete packets: [headerType, granule, packets][] */
const buildOggOpus = (pagesSpec: [number, number, Uint8Array[]][], serial = 1234) => buildOggPages(
	pagesSpec.map(([headerType, granule, packets]) => {
		const body = new Uint8Array(packets.reduce((sum, packet) => sum + packet.length, 0));
		let offset = 0;
		for (const packet of packets) {
			body.set(packet, offset);
			offset += packet.length;
		}
		return { headerType, granule, lacing: packets.flatMap(packet => lacingOf(packet.length)), body };
	}),
	serial,
);

const opusTags = () => {
	const vendor = new TextEncoder().encode('test');
	const bytes = new Uint8Array(8 + 4 + vendor.length + 4);
	bytes.set(new TextEncoder().encode('OpusTags'));
	new DataView(bytes.buffer).setUint32(8, vendor.length, true);
	bytes.set(vendor, 12);
	return bytes;
};
const opusPacket = () => new Uint8Array([0xfc, 1, 2, 3]); // 960 samples

describe('Reader: RFC 7845 (Ogg Opus)', () => {
	test('§4.2/§4.5: packets are timed from the granule positions, minus the pre-skip', async () => {
		const bytes = buildOggOpus([
			[BOS, 0, [opusHead({ preSkip: 312 })]],
			[0, 0, [opusTags()]],
			[0, 3 * 960, [opusPacket(), opusPacket(), opusPacket()]],
			[EOS, 5 * 960, [opusPacket(), opusPacket()]],
		]);
		const result = (await readOpusInput(bytes))!;
		expect(result.timestamps.map(t => Math.round(t * 48000))).toEqual([0, 960, 1920, 2880, 3840].map(t => t - 312));
	});

	test('§4.5: a first audio page whose granule exceeds its samples starts the stream later', async () => {
		const bytes = buildOggOpus([
			[BOS, 0, [opusHead({ preSkip: 312 })]],
			[0, 0, [opusTags()]],
			[0, 48000 + 2 * 960, [opusPacket(), opusPacket()]],
			[EOS, 48000 + 3 * 960, [opusPacket()]],
		]);
		const result = (await readOpusInput(bytes))!;
		expect(Math.round(result.timestamps[0]! * 48000)).toBe(48000 - 312);
	});

	test('§5.1: the output sample rate is 48 kHz whatever the input sample rate field says', async () => {
		const bytes = buildOggOpus([
			[BOS, 0, [opusHead({ inputSampleRate: 44100 })]],
			[0, 0, [opusTags()]],
			[EOS, 960, [opusPacket()]],
		]);
		expect((await readOpusInput(bytes))!.sampleRate).toBe(48000);
	});

	test('§5.1: the output channel count comes from the ID header', async () => {
		const head = opusHead({ channels: 6, family: 1, mapping: [4, 2, 0, 4, 1, 2, 3, 5] });
		const bytes = buildOggOpus([[BOS, 0, [head]], [0, 0, [opusTags()]], [EOS, 960, [opusPacket()]]]);
		expect((await readOpusInput(bytes))!.channels).toBe(6);
	});

	test('§5.1: an ID header with a larger minor version and extra data is not invalid', async () => {
		const head = new Uint8Array([...opusHead({ version: 15 }), 0xaa, 0xbb]);
		const bytes = buildOggOpus([[BOS, 0, [head]], [0, 0, [opusTags()]], [EOS, 960, [opusPacket()]]]);
		const result = await readOpusInput(bytes);
		expect(result?.channels).toBe(2);
	});

	test('§5.1: an ID header too short for its fields is not taken as Opus', async () => {
		const bytes = buildOggOpus([
			[BOS, 0, [opusHead().subarray(0, 15)]],
			[0, 0, [opusTags()]],
			[EOS, 960, [opusPacket()]],
		]);
		expect(await readOpusInput(bytes).catch(() => null)).toBeNull();
	});

	test('§5.2: comment headers whose lengths overrun the packet don\'t break reading', async () => {
		const tags = opusTags();
		new DataView(tags.buffer).setUint32(tags.length - 4, 1000, true); // 1000 comments that aren't there
		const bytes = buildOggOpus([[BOS, 0, [opusHead()]], [0, 0, [tags]], [EOS, 960, [opusPacket()]]]);
		expect((await readOpusInput(bytes))!.timestamps).toHaveLength(1);
	});

	test('§5.2: comments are read as UTF-8 with case-insensitive field names', async () => {
		const comment = new TextEncoder().encode('tItLe=Grüße');
		const tags = opusTags();
		const withComment = new Uint8Array(tags.length + 4 + comment.length);
		withComment.set(tags);
		const view = new DataView(withComment.buffer);
		view.setUint32(tags.length - 4, 1, true);
		view.setUint32(tags.length, comment.length, true);
		withComment.set(comment, tags.length + 4);
		const bytes = buildOggOpus([[BOS, 0, [opusHead()]], [0, 0, [withComment]], [EOS, 960, [opusPacket()]]]);
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		expect(await input.getFormat()).toBe(OGG);
		expect((await input.getMetadataTags()).title).toBe('Grüße');
	});
});

const readPackets = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	return packets;
};

describe('Reader: RFC 3533 (Ogg)', () => {
	test('§6: a packet continued on the next page (continued flag set) is reassembled', async () => {
		// A 600-byte packet split across two pages: its first 510 bytes (two 255 lacing values, so unfinished) fill
		// page 3, which completes no packet and so has granule position -1, and its last 90 bytes open page 4, which
		// sets the continued-packet flag
		const packet = new Uint8Array(600).map((_, i) => (i * 7 + 3) & 0xff);
		packet[0] = 0xfc; // CELT fullband 20 ms, stereo, one frame: 960 samples
		const head = opusHead();
		const tags = opusTags();
		const bytes = buildOggPages([
			{ headerType: BOS, granule: 0, lacing: lacingOf(head.length), body: head },
			{ headerType: 0, granule: 0, lacing: lacingOf(tags.length), body: tags },
			{ headerType: 0, granule: -1, lacing: [255, 255], body: packet.subarray(0, 510) },
			{ headerType: CONTINUED | EOS, granule: 960, lacing: [90], body: packet.subarray(510) },
		]);

		// The fixture really splits the packet, as an independent reassembly confirms
		const pages = parseOggPages(bytes);
		expect(pages.map(page => page.headerType)).toEqual([BOS, 0, 0, CONTINUED | EOS]);
		expect(pages.map(page => page.lacing))
			.toEqual([lacingOf(head.length), lacingOf(tags.length), [255, 255], [90]]);
		const reassembled = oggPackets(pages)[2]!;
		expect([reassembled.firstPage, reassembled.lastPage]).toEqual([2, 3]);
		expect(reassembled.data).toEqual(packet);

		const packets = await readPackets(bytes);
		expect(packets).toHaveLength(1);
		expect(packets[0]!.data).toEqual(packet);
		expect(Math.round(packets[0]!.timestamp * 48000)).toBe(960 - 960 - 312); // Granule minus samples minus pre-skip
	});

	test('§6: pages of other logical bitstreams are skipped while reading one', async () => {
		const opus = parseOggPages(buildOggOpus([
			[BOS, 0, [opusHead()]],
			[0, 0, [opusTags()]],
			[0, 960, [opusPacket()]],
			[EOS, 1920, [opusPacket()]],
		], 1));
		const other = parseOggPages(buildOggOpus([
			[BOS, 0, [new Uint8Array([0x80, 0x74, 0x68, 0x65, 0x6f, 0x72, 0x61])]],
			[EOS, 0, [new Uint8Array([1])]],
		], 2));
		const order = [opus[0]!, other[0]!, opus[1]!, other[1]!, opus[2]!, opus[3]!];
		const bytes = new Uint8Array(order.reduce((sum, page) => sum + page.bytes.length, 0));
		let offset = 0;
		for (const page of order) {
			bytes.set(page.bytes, offset);
			offset += page.bytes.length;
		}
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const tracks = await input.getTracks();
		expect(tracks).toHaveLength(1);
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(tracks[0] as InputAudioTrack).packets()) {
			packets.push(packet);
		}
		expect(packets).toHaveLength(2);
	});
});

type FlacBlock = { type: number; last: boolean; data: Uint8Array };

const parseFlac = (bytes: Uint8Array) => {
	expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('fLaC');
	const blocks: FlacBlock[] = [];
	let pos = 4;
	while (pos + 4 <= bytes.length) { // Bounded, should the last-metadata-block flag be missing
		const last = !!(bytes[pos]! & 0x80);
		const type = bytes[pos]! & 0x7f;
		const length = (bytes[pos + 1]! << 16) | (bytes[pos + 2]! << 8) | bytes[pos + 3]!;
		blocks.push({ type, last, data: bytes.subarray(pos + 4, pos + 4 + length) });
		pos += 4 + length;
		if (last) {
			break;
		}
	}
	expect(blocks.at(-1)?.last).toBe(true);
	return { blocks, framesStart: pos };
};

const readStreaminfo = (data: Uint8Array) => {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	return {
		minBlockSize: view.getUint16(0),
		maxBlockSize: view.getUint16(2),
		minFrameSize: (data[4]! << 16) | (data[5]! << 8) | data[6]!,
		maxFrameSize: (data[7]! << 16) | (data[8]! << 8) | data[9]!,
		sampleRate: (data[10]! << 12) | (data[11]! << 4) | (data[12]! >> 4),
		channels: ((data[12]! >> 1) & 0x7) + 1,
		bitsPerSample: (((data[12]! & 1) << 4) | (data[13]! >> 4)) + 1,
		totalSamples: (data[13]! & 0x0f) * 2 ** 32 + view.getUint32(14),
		md5: data.subarray(18, 34),
	};
};

/** The frames of a FLAC file, found through Mediabunny's own demuxer (frame boundaries) and checked here. */
const flacFrames = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	const frames: { data: Uint8Array; blockSize: number }[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		frames.push({ data: packet.data, blockSize: Math.round(packet.duration * (await track.getSampleRate())) });
	}
	return frames;
};

/** Decodes a frame header's coded number (RFC 9639, Section 9.1.5). */
const codedNumber = (frame: Uint8Array) => {
	const first = frame[4]!;
	if (first < 0x80) {
		return first;
	}
	let length = 0;
	while (first & (0x80 >> length)) {
		length++;
	}
	let value = first & (0x7f >> length);
	for (let i = 1; i < length; i++) {
		value = value * 64 + (frame[4 + i]! & 0x3f);
	}
	return value;
};

describe('Writer: RFC 9639 (FLAC)', () => {
	test('§8: the "fLaC" signature is followed by metadata blocks, the first one STREAMINFO, and only one STREAMINFO',
		() => {
			for (const file of flacFiles) {
				const { blocks } = parseFlac(file.bytes);
				expect(blocks[0]!.type).toBe(0);
				expect(blocks.filter(block => block.type === 0)).toHaveLength(1);
			}
		});

	test('§8.1: only the last metadata block has the last-metadata-block flag', () => {
		for (const file of flacFiles) {
			const { blocks } = parseFlac(file.bytes);
			expect(blocks.map(block => block.last)).toEqual(blocks.map((_, i) => i === blocks.length - 1));
		}
	});

	test('§8.2: block sizes are 16-65535, the minimum at most the maximum, and every frame but the last within them',
		async () => {
			for (const file of flacFiles) {
				const info = readStreaminfo(parseFlac(file.bytes).blocks[0]!.data);
				expect(info.minBlockSize).toBeGreaterThanOrEqual(16);
				expect(info.maxBlockSize).toBeLessThanOrEqual(65535);
				expect(info.minBlockSize).toBeLessThanOrEqual(info.maxBlockSize);
				const frames = await flacFrames(file.bytes);
				frames.forEach((frame, i) => {
					expect(frame.blockSize).toBeLessThanOrEqual(info.maxBlockSize);
					if (i < frames.length - 1) {
						expect(frame.blockSize).toBeGreaterThanOrEqual(info.minBlockSize);
					}
				});
			}
		});

	test('§8.2: frame sizes, sample rate, channels, bit depth and total samples describe the frames', async () => {
		for (const file of flacFiles) {
			const info = readStreaminfo(parseFlac(file.bytes).blocks[0]!.data);
			const frames = await flacFrames(file.bytes);
			expect(info.sampleRate).toBeGreaterThan(0);
			expect(info.minFrameSize).toBe(Math.min(...frames.map(frame => frame.data.length)));
			expect(info.maxFrameSize).toBe(Math.max(...frames.map(frame => frame.data.length)));
			expect(info.totalSamples).toBe(frames.reduce((sum, frame) => sum + frame.blockSize, 0));
		}
	});

	test('§8.2: the MD5 signature is 0 ("not known"), since the muxer never sees the decoded audio', () => {
		for (const file of flacFiles) {
			expect(readStreaminfo(parseFlac(file.bytes).blocks[0]!.data).md5.every(byte => byte === 0)).toBe(true);
		}
	});

	test('§8.2: append-only block sizes bound every frame; frame sizes and total are exact or 0', async () => {
		// STREAMINFO is written before any frame. A fixed block size stream declares its block size as both minimum
		// and maximum; only a variable block size stream may declare looser bounds, such as the full 16-65535 range
		// (Section 8.2, Appendix B.1). Frame sizes and the total sample count may be 0 ("not known").
		const bytes = await build(new FlacOutputFormat({ appendOnly: true }),
			output => addCopiedTrack(output, 'sample.flac', index => index < 5));
		const info = readStreaminfo(parseFlac(bytes).blocks[0]!.data);
		expect(info.minBlockSize).toBeGreaterThanOrEqual(16);
		expect(info.maxBlockSize).toBeLessThanOrEqual(65535);
		expect(info.minBlockSize).toBeLessThanOrEqual(info.maxBlockSize);

		const frames = await flacFrames(bytes);
		expect(frames).toHaveLength(5);
		frames.forEach((frame, i) => {
			expect(frame.blockSize).toBeLessThanOrEqual(info.maxBlockSize);
			if (i < frames.length - 1) {
				expect(frame.blockSize).toBeGreaterThanOrEqual(info.minBlockSize);
			}
		});

		const frameSizes = frames.map(frame => frame.data.length);
		expect([0, Math.min(...frameSizes)]).toContain(info.minFrameSize);
		expect([0, Math.max(...frameSizes)]).toContain(info.maxFrameSize);
		expect([0, frames.reduce((sum, frame) => sum + frame.blockSize, 0)]).toContain(info.totalSamples);
	});

	test('§8.6: at most one VORBIS_COMMENT block, with field names of printable ASCII other than "="', () => {
		for (const file of flacFiles) {
			const comments = parseFlac(file.bytes).blocks.filter(block => block.type === 4);
			expect(comments.length).toBeLessThanOrEqual(1);
			for (const block of comments) {
				const view = new DataView(block.data.buffer, block.data.byteOffset, block.data.byteLength);
				let pos = 4 + view.getUint32(0, true);
				const count = view.getUint32(pos, true);
				pos += 4;
				for (let i = 0; i < count; i++) {
					const length = view.getUint32(pos, true);
					const bytes = block.data.subarray(pos + 4, pos + 4 + length);
					const comment = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
					expect(comment).toMatch(/^[\x20-\x3c\x3e-\x7d]+=/);
					pos += 4 + length;
				}
				expect(pos).toBe(block.data.length);
			}
		}
	});

	test('§8.8: PICTURE blocks set unknown width, height, depth and color count to 0', () => {
		const file = flacFiles.find(file => file.name === 'flac-tags')!;
		const picture = parseFlac(file.bytes).blocks.find(block => block.type === 6)!;
		const view = new DataView(picture.data.buffer, picture.data.byteOffset, picture.data.byteLength);
		expect(view.getUint32(0)).toBe(3); // Front cover
		let pos = 4;
		pos += 4 + view.getUint32(pos); // Media type
		pos += 4 + view.getUint32(pos); // Description
		expect([view.getUint32(pos), view.getUint32(pos + 4), view.getUint32(pos + 8), view.getUint32(pos + 12)])
			.toEqual([0, 0, 0, 0]);
		expect(view.getUint32(pos + 16)).toBe(picture.data.length - pos - 20);
	});

	test('§9.1: frames start on a byte boundary with the sync code; the blocking strategy never changes', async () => {
		for (const file of flacFiles) {
			const { framesStart } = parseFlac(file.bytes);
			expect(file.bytes[framesStart]).toBe(0xff);
			const frames = await flacFrames(file.bytes);
			const strategies = new Set(frames.map(frame => frame.data[1]! & 1));
			expect(strategies.size).toBe(1);
			for (const frame of frames) {
				expect(frame.data[0]).toBe(0xff);
				expect(frame.data[1]! & 0xfe).toBe(0xf8);
			}
		}
	});

	test('§9.1.5: the coded frame number of each frame equals the number of frames before it', async () => {
		// The corpus copies frames from the start of a file; copies starting elsewhere keep their original numbers
		for (const file of flacFiles) {
			const frames = await flacFrames(file.bytes);
			expect(frames.map(frame => codedNumber(frame.data))).toEqual(frames.map((_, i) => i));
		}
	});
});

describe('Reader: RFC 9639 (FLAC)', () => {
	test('§8.6: Vorbis comment field names are matched case-insensitively', async () => {
		const bytes = await build(new FlacOutputFormat(), (output) => {
			output.setMetadataTags({ raw: { tItLe: 'Mixed case' } });
			return addCopiedTrack(output, 'sample.flac', index => index < 2);
		});
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		expect((await input.getMetadataTags()).title).toBe('Mixed case');
	});

	test('§8.2: the decoder description is the "fLaC" signature followed by the STREAMINFO block', async () => {
		const file = flacFiles.find(file => file.name === 'flac-tags')!;
		using input = new Input({ source: new BufferSource(file.bytes), formats: ALL_FORMATS });
		const config = await (await input.getPrimaryAudioTrack())!.getDecoderConfig();
		const description = new Uint8Array(config!.description as ArrayBuffer);
		expect(new TextDecoder().decode(description.subarray(0, 4))).toBe('fLaC');
		expect(description[4]! & 0x7f).toBe(0);
		expect(description.length).toBeGreaterThanOrEqual(4 + 4 + 34);
	});

	test('§8.2: the STREAMINFO sample rate, channel count and total samples give the track\'s properties', async () => {
		const file = flacFiles.find(file => file.name === 'flac-copy')!;
		const info = readStreaminfo(parseFlac(file.bytes).blocks[0]!.data);
		using input = new Input({ source: new BufferSource(file.bytes), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getSampleRate()).toBe(info.sampleRate);
		expect(await track.getNumberOfChannels()).toBe(info.channels);
		expect(await input.getDurationFromMetadata()).toBeCloseTo(info.totalSamples / info.sampleRate, 6);
	});
});
