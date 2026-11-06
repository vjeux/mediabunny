import { describe, expect, test } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, ReadableStreamSource } from '../../src/source.js';
import { ALL_FORMATS, OGG } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { OggOutputFormat } from '../../src/output-format.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { MetadataTags } from '../../src/metadata.js';
import { toUint8Array } from '../../src/misc.js';
import { VERSIONED_NAME } from '../../src/version.js';
import {
	buildOggPage,
	buildOggStream,
	buildOpusHead,
	buildOpusPacket,
	buildOpusTags,
	buildVorbisCommentBody,
	concatBytes,
	OPUS_CONFIG_FRAME_SAMPLES,
	oggCrc32,
	OggPageSpec,
	parseOggPackets,
	parseOggPages,
	ParsedOggPage,
} from './helpers/audio-flac-ogg-builders.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const VORBIS_FIXTURE = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'public', 'vorbis-eos.ogg')));

const openOgg = (bytes: Uint8Array) => new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

const readTrackPackets = async (bytes: Uint8Array, trackIndex = 0) => {
	using input = openOgg(bytes);
	const track = (await input.getAudioTracks())[trackIndex]!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	return packets;
};

/** [timestamp, duration] in 48 kHz samples, plus the size of each packet. */
const layout48k = (packets: EncodedPacket[]) => packets.map(packet => [
	Math.round(packet.timestamp * 48000),
	Math.round(packet.duration * 48000),
	packet.byteLength,
]);

// A 20 ms CELT fullband packet (TOC config 31, code 0) padded to the given size
const opusPacket20ms = (size: number, fill = 0) => {
	const packet = new Uint8Array(size).fill(fill);
	packet[0] = 31 << 3;
	return packet;
};

type OpusStreamOptions = {
	serialNumber?: number;
	channels?: number;
	preSkip?: number;
	head?: Uint8Array;
	tags?: Uint8Array;
	/** Audio packets grouped by the page they complete on; the granule is derived unless given. */
	pages: { packets: Uint8Array[]; granulePosition?: bigint; headerType?: number }[];
	startGranule?: number;
	firstSequenceNumber?: number;
};

const opusPacketSamples = (packet: Uint8Array) => {
	const code = packet[0]! & 3;
	const frames = code === 0 ? 1 : code < 3 ? 2 : packet[1]! & 0x3f;
	return OPUS_CONFIG_FRAME_SAMPLES[packet[0]! >> 3]! * frames;
};

/** Builds a complete Ogg Opus stream: ID header page, comment header page and the audio pages. */
const buildOpusStream = (options: OpusStreamOptions) => {
	const serialNumber = options.serialNumber ?? 0x12345678;
	const head = options.head ?? buildOpusHead({ channels: options.channels ?? 2, preSkip: options.preSkip ?? 312 });
	const tags = options.tags ?? buildOpusTags('test vendor', []);
	let granule = options.startGranule ?? 0;
	const pageSpecs: OggPageSpec[] = [
		{ packets: [head], granulePosition: 0n, headerType: 0x02 },
		{ packets: [tags], granulePosition: 0n },
		...options.pages.map((page, i) => {
			granule += page.packets.reduce((sum, packet) => sum + opusPacketSamples(packet), 0);
			return {
				packets: page.packets,
				granulePosition: page.granulePosition ?? BigInt(granule),
				headerType: page.headerType ?? (i === options.pages.length - 1 ? 0x04 : 0),
			};
		}),
	];
	return concatBytes(buildOggStream(serialNumber, pageSpecs, options.firstSequenceNumber));
};

const repeat = <T>(count: number, make: (i: number) => T) => Array.from({ length: count }, (_, i) => make(i));

/** Shorthand for a single hand-laid page. */
const page = (
	serialNumber: number,
	sequenceNumber: number,
	headerType: number,
	granulePosition: bigint,
	lacingValues: number[],
	data: Uint8Array,
) => buildOggPage({ headerType, granulePosition, serialNumber, sequenceNumber, lacingValues, data });

const rebuildPage = (parsed: ParsedOggPage) => buildOggPage({ ...parsed });

const fourPagesOf = (packetsPerPage: number, size: number) => repeat(4, () => ({
	packets: repeat(packetsPerPage, () => opusPacket20ms(size)),
}));

describe('Ogg demuxer: framing (RFC 3533)', () => {
	test('detects Ogg by its capture pattern and reports the codecs in the MIME type', async () => {
		const bytes = buildOpusStream({ pages: [{ packets: repeat(5, () => opusPacket20ms(10)) }] });
		using input = openOgg(bytes);
		expect(await input.getFormat()).toBe(OGG);
		expect(await input.getMimeType()).toBe('audio/ogg; codecs="opus"');
	});

	test('reassembles packets of every size around the 255-byte lacing boundaries', async () => {
		const sizes = [1, 2, 254, 255, 256, 509, 510, 511, 764, 765, 766, 1275, 4000];
		const packets = sizes.map((size, i) => opusPacket20ms(size, i));
		const bytes = buildOpusStream({
			preSkip: 0,
			pages: [{ packets: packets.slice(0, 6) }, { packets: packets.slice(6) }],
		});

		const read = await readTrackPackets(bytes);
		expect(read.map(x => x.byteLength)).toEqual(sizes);
		expect(read.map(x => x.data)).toEqual(packets);
		expect(layout48k(read).map(x => x[0])).toEqual(sizes.map((_, i) => i * 960));
	});

	test('reassembles packets spanning several pages, including pages that complete no packet', async () => {
		// 1530 bytes = 6 lacing values of 255 + a terminating 0. Split it across three pages: the middle page holds
		// only 255s, so no packet completes on it and its granule position is -1.
		const big = opusPacket20ms(1530, 7);
		const small = opusPacket20ms(10);
		const bytes = concatBytes([
			page(99, 0, 2, 0n, [19], buildOpusHead({ channels: 1, preSkip: 0 })),
			page(99, 1, 0, 0n, [17], buildOpusTags('v', [])),
			page(99, 2, 0, 960n, [10, 255, 255], concatBytes([small, big.subarray(0, 510)])),
			page(99, 3, 1, -1n, [255, 255], big.subarray(510, 1020)),
			page(99, 4, 1, 2880n, [255, 255, 0, 10], concatBytes([big.subarray(1020), small])),
			page(99, 5, 4, 3840n, [10], small),
		]);

		const read = await readTrackPackets(bytes);
		expect(layout48k(read)).toEqual([[0, 960, 10], [960, 960, 1530], [1920, 960, 10], [2880, 960, 10]]);
		expect(read[1]!.data).toEqual(big);
	});

	test('reads a packet whose terminating 0 lacing value starts the next page', async () => {
		const exact = opusPacket20ms(510, 3);
		const bytes = concatBytes([
			page(5, 0, 2, 0n, [19], buildOpusHead({ channels: 2, preSkip: 0 })),
			page(5, 1, 0, 0n, [17], buildOpusTags('v', [])),
			page(5, 2, 0, 960n, [20, 255, 255], concatBytes([opusPacket20ms(20), exact])),
			page(5, 3, 1 | 4, 2880n, [0, 30], opusPacket20ms(30)),
		]);

		const read = await readTrackPackets(bytes);
		expect(layout48k(read)).toEqual([[0, 960, 20], [960, 960, 510], [1920, 960, 30]]);
		expect(read[1]!.data).toEqual(exact);
	});

	test('ignores logical bitstreams of unknown codecs, such as an Ogg Skeleton', async () => {
		const opus = parseOggPages(buildOpusStream({ pages: fourPagesOf(10, 30) }));
		const fishead = concatBytes([new TextEncoder().encode('fishead\0'), new Uint8Array(56)]);
		const fisbone = concatBytes([
			new TextEncoder().encode('fisbone\0'),
			new Uint8Array(44),
			new TextEncoder().encode('Content-Type: audio/opus\r\n'),
		]);
		const bytes = concatBytes([
			page(0x51, 0, 2, 0n, [64], fishead),
			rebuildPage(opus[0]!),
			page(0x51, 1, 0, 0n, [fisbone.length], fisbone),
			rebuildPage(opus[1]!),
			// The Skeleton stream ends with an empty packet on its EOS page
			page(0x51, 2, 4, 0n, [0], new Uint8Array(0)),
			...opus.slice(2).map(rebuildPage),
		]);

		using input = openOgg(bytes);
		const tracks = await input.getAudioTracks();
		expect(tracks).toHaveLength(1);
		expect(tracks[0]!.number).toBe(1);
		expect(await input.getMimeType()).toBe('audio/ogg; codecs="opus"');
		expect(layout48k(await readTrackPackets(bytes))).toEqual(repeat(40, i => [i * 960 - 312, 960, 30]));
	});

	test('reads multiplexed Opus streams as separate tracks', async () => {
		const pagesOf = (size: number) => repeat(3, () => ({ packets: repeat(5, () => opusPacket20ms(size)) }));
		const a = parseOggPages(buildOpusStream({ serialNumber: 1, channels: 1, preSkip: 100, pages: pagesOf(11) }));
		const b = parseOggPages(buildOpusStream({ serialNumber: 2, channels: 2, preSkip: 200, pages: pagesOf(22) }));
		// BOS pages first, then the other pages interleaved (RFC 3533 section 4, "grouping")
		const order = [a[0], b[0], a[1], b[1], a[2], b[2], b[3], a[3], a[4], b[4]];
		const bytes = concatBytes(order.map(x => rebuildPage(x!)));

		using input = openOgg(bytes);
		const tracks = await input.getAudioTracks();
		expect(await Promise.all(tracks.map(x => x.getNumberOfChannels()))).toEqual([1, 2]);
		expect(tracks.map(x => x.number)).toEqual([1, 2]);
		expect(layout48k(await readTrackPackets(bytes, 0))).toEqual(repeat(15, i => [i * 960 - 100, 960, 11]));
		expect(layout48k(await readTrackPackets(bytes, 1))).toEqual(repeat(15, i => [i * 960 - 200, 960, 22]));
		expect(await tracks[1]!.computeDuration()).toBe((15 * 960 - 200) / 48000);
	});

	test('treats the empty packet on a final page (as written by VLC) as the end of the stream', async () => {
		const bytes = buildOpusStream({
			preSkip: 0,
			pages: [
				{ packets: repeat(5, () => opusPacket20ms(40)), headerType: 0 },
				{ packets: [new Uint8Array(0)], granulePosition: 4800n, headerType: 4 },
			],
		});

		const read = await readTrackPackets(bytes);
		expect(layout48k(read)).toEqual(repeat(5, i => [i * 960, 960, 40]));
		using input = openOgg(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.computeDuration()).toBe(0.1);
		const sink = new EncodedPacketSink(track);
		expect(layout48k([(await sink.getPacket(1))!])).toEqual([[3840, 960, 40]]);
	});

	test('ends a truncated file at the last complete packet without throwing', async () => {
		const pages = repeat(10, () => ({ packets: repeat(10, () => opusPacket20ms(50)) }));
		const bytes = buildOpusStream({ preSkip: 0, pages });
		for (const cut of [bytes.length - 1, bytes.length - 300, Math.floor(bytes.length / 2), 200]) {
			const read = await readTrackPackets(bytes.subarray(0, cut));
			expect(read.length).toBeLessThan(100);
			expect(layout48k(read)).toEqual(repeat(read.length, i => [i * 960, 960, 50]));

			using input = openOgg(bytes.subarray(0, cut));
			const track = (await input.getPrimaryAudioTrack())!;
			const sink = new EncodedPacketSink(track);
			const last = await sink.getPacket(10);
			expect(last === null ? 0 : Math.round(last.timestamp * 48000) / 960 + 1).toBe(read.length);
		}
	});

	test('computes the CRC-32 of a page with the unreflected 0x04c11db7 polynomial (RFC 3533 section 6)', () => {
		const single = page(0, 0, 2, 0n, [1], new Uint8Array([0x61]));
		const copy = single.slice();
		copy.fill(0, 22, 26);
		expect(new DataView(single.buffer).getUint32(22, true)).toBe(oggCrc32(copy));
		// Known value: CRC-32/MPEG-2 style without the final XOR or initial 0xffffffff
		expect(oggCrc32(new TextEncoder().encode('123456789'))).toBe(0x89a1897f);
	});
});

describe('Opus in Ogg (RFC 7845)', () => {
	test.each([
		['mapping family 0, mono', buildOpusHead({ channels: 1, preSkip: 312 }), 1],
		['mapping family 0, stereo', buildOpusHead({
			channels: 2, preSkip: 3840, inputSampleRate: 44100, outputGain: -256,
		}), 2],
		['mapping family 1, 5.1', buildOpusHead({
			channels: 6, preSkip: 312, mappingFamily: 1, streamCount: 4, coupledCount: 2, mapping: [0, 4, 1, 2, 3, 5],
		}), 6],
		['mapping family 1, 7.1', buildOpusHead({
			channels: 8,
			preSkip: 312,
			mappingFamily: 1,
			streamCount: 5,
			coupledCount: 3,
			mapping: [0, 6, 1, 2, 3, 4, 5, 7],
		}), 8],
		['mapping family 255', buildOpusHead({
			channels: 4, preSkip: 120, mappingFamily: 255, streamCount: 4, coupledCount: 0,
		}), 4],
	])('exposes the OpusHead (%s) as the decoder description', async (_, head, channels) => {
		const bytes = buildOpusStream({ head, pages: [{ packets: repeat(3, () => opusPacket20ms(10)) }] });
		using input = openOgg(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getCodec()).toBe('opus');
		expect(await track.getNumberOfChannels()).toBe(channels);
		// Opus always decodes at 48 kHz; the input sample rate field is informational
		expect(await track.getSampleRate()).toBe(48000);
		expect(await track.getTimeResolution()).toBe(48000);
		const config = (await track.getDecoderConfig())!;
		expect(config).toMatchObject({ codec: 'opus', numberOfChannels: channels, sampleRate: 48000 });
		expect(toUint8Array(config.description!)).toEqual(head);
		const preSkip = new DataView(head.buffer).getUint16(10, true);
		expect((await readTrackPackets(bytes))[0]!.timestamp).toBe(-preSkip / 48000);
	});

	test('gives packets of every TOC configuration and frame count code their RFC 6716 duration', async () => {
		const packets: Uint8Array[] = [];
		const expectedDurations: number[] = [];
		for (let config = 0; config < 32; config++) {
			const frame = OPUS_CONFIG_FRAME_SAMPLES[config]!;
			packets.push(buildOpusPacket(config, 0), buildOpusPacket(config, 1), buildOpusPacket(config, 2));
			expectedDurations.push(frame, 2 * frame, 2 * frame);
			// Code 3 carries an explicit frame count; a packet may hold at most 120 ms (RFC 6716 section 3.2.5)
			const maxFrames = 5760 / frame;
			for (const count of new Set([1, Math.min(3, maxFrames), maxFrames])) {
				expect(count * frame).toBeLessThanOrEqual(5760);
				packets.push(buildOpusPacket(config, 3, count));
				expectedDurations.push(count * frame);
			}
		}
		const bytes = buildOpusStream({
			preSkip: 0,
			pages: [{ packets: packets.slice(0, 100) }, { packets: packets.slice(100) }],
		});

		const read = await readTrackPackets(bytes);
		expect(read.map(x => Math.round(x.duration * 48000))).toEqual(expectedDurations);
		let expectedStart = 0;
		expect(read.map(x => Math.round(x.timestamp * 48000))).toEqual(expectedDurations.map((duration) => {
			const start = expectedStart;
			expectedStart += duration;
			return start;
		}));
	});

	test('reads on past malformed packets declaring more than 120 ms', async () => {
		// RFC 6716 section 3.2.5 caps a packet at 120 ms, which code 3 frame counts can exceed: 3 frames of 60 ms
		// (configurations 3, 7 and 11), or up to 63 frames of 20 ms. Such packets are invalid, so their duration isn't
		// pinned here, but reading must go on, with timestamps that don't go backwards.
		const packets = [
			buildOpusPacket(1, 0), // A valid 20 ms packet
			buildOpusPacket(3, 3, 3), // 3 × 60 ms
			buildOpusPacket(19, 3, 63), // 63 × 20 ms
			buildOpusPacket(1, 0),
		];
		const bytes = buildOpusStream({ preSkip: 0, pages: [{ packets }] });

		const read = await readTrackPackets(bytes);
		expect(read).toHaveLength(packets.length);
		for (const [i, packet] of read.entries()) {
			expect(Number.isFinite(packet.timestamp) && Number.isFinite(packet.duration)).toBe(true);
			if (i > 0) {
				expect(packet.timestamp).toBeGreaterThanOrEqual(read[i - 1]!.timestamp);
			}
		}
	});

	test('starts the stream later when the first page granule exceeds its samples, as in live captures', async () => {
		// RFC 7845 section 4.5: a granule position larger than the samples on the first audio page means the stream
		// was cropped or joined live; the PCM position of the first packet is granule - samples - pre-skip
		const startGranule = 480000;
		const bytes = buildOpusStream({
			preSkip: 312,
			startGranule,
			firstSequenceNumber: 1000,
			pages: repeat(5, () => ({ packets: repeat(10, () => opusPacket20ms(25)) })),
		});

		const read = await readTrackPackets(bytes);
		expect(layout48k(read)).toEqual(repeat(50, i => [startGranule - 312 + i * 960, 960, 25]));
		using input = openOgg(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.computeDuration()).toBe((startGranule - 312 + 50 * 960) / 48000);
		const sink = new EncodedPacketSink(track);
		expect(await sink.getPacket(0)).toBe(null);
		const sought = (await sink.getPacket((startGranule + 20000) / 48000))!;
		expect(layout48k([sought])).toEqual([[startGranule - 312 + 20160, 960, 25]]);
	});

	test('starts at the pre-skip when a single EOS page has a granule smaller than its samples', async () => {
		// RFC 7845 section 4.5: on an EOS page, a smaller granule position means end trimming, and the initial
		// granule position is 0
		const bytes = buildOpusStream({
			preSkip: 312,
			pages: [{ packets: repeat(3, () => opusPacket20ms(20)), granulePosition: 2000n, headerType: 4 }],
		});

		const read = await readTrackPackets(bytes);
		expect(layout48k(read)).toEqual([[-312, 960, 20], [648, 960, 20], [1608, 80, 20]]);
		using input = openOgg(bytes);
		expect(await (await input.getPrimaryAudioTrack())!.computeDuration()).toBe((2000 - 312) / 48000);
	});

	test('trims the final packet to the granule position of the EOS page', async () => {
		// RFC 7845 section 4.4: 'ffmpeg -c:a libopus' on 48,017 input samples ends at granule 48,017 + 312
		const packets = repeat(51, () => opusPacket20ms(30));
		const bytes = buildOpusStream({
			preSkip: 312,
			pages: [
				{ packets: packets.slice(0, 50), headerType: 0 },
				{ packets: packets.slice(50), granulePosition: BigInt(48017 + 312), headerType: 4 },
			],
		});

		const read = await readTrackPackets(bytes);
		expect(layout48k(read.slice(-2))).toEqual([[46728, 960, 30], [47688, 329, 30]]);
		using input = openOgg(bytes);
		expect(await (await input.getPrimaryAudioTrack())!.computeDuration()).toBe(48017 / 48000);
	});

	test('reads OpusTags comments and METADATA_BLOCK_PICTURE images, even when the header spans pages', async () => {
		const image = new Uint8Array(70000).map((_, i) => (i * 31) & 0xff);
		const pictureBlock = concatBytes([
			new Uint8Array([0, 0, 0, 3, 0, 0, 0, 10]), new TextEncoder().encode('image/jpeg'),
			new Uint8Array([0, 0, 0, 5]), new TextEncoder().encode('Cövr'),
			new Uint8Array(16),
			new Uint8Array([0, 0x01, 0x11, 0x70]), image,
		]);
		const base64 = Buffer.from(pictureBlock).toString('base64');
		const tags = buildOpusTags('libopus 1.5', [
			'TITLE=Ünïcode', 'ARTIST=A', 'tracknumber=7', `METADATA_BLOCK_PICTURE=${base64}`, 'ENCODER=opusenc',
		]);
		expect(tags.length).toBeGreaterThan(65025); // Can't fit in one page
		const serialNumber = 3;
		const small = opusPacket20ms(10);
		const head = buildOpusHead({ channels: 2, preSkip: 312 });
		const tagPieces: Uint8Array[] = [];
		for (let offset = 0; offset < tags.length; offset += 255 * 200) {
			tagPieces.push(tags.subarray(offset, offset + 255 * 200));
		}
		const pages = [
			page(serialNumber, 0, 2, 0n, [19], head),
			...tagPieces.map((piece, i) => {
				const isLast = i === tagPieces.length - 1;
				return buildOggPage({
					headerType: i === 0 ? 0 : 1,
					granulePosition: isLast ? 0n : -1n,
					serialNumber,
					sequenceNumber: 1 + i,
					lacingValues: isLast
						? [...Array<number>(Math.floor(piece.length / 255)).fill(255), piece.length % 255]
						: Array<number>(200).fill(255),
					data: piece,
				});
			}),
			page(serialNumber, 1 + tagPieces.length, 4, 2880n, [10, 10, 10], concatBytes(repeat(3, () => small))),
		];
		const bytes = concatBytes(pages);

		using input = openOgg(bytes);
		const metadata = await input.getMetadataTags();
		expect(metadata.title).toBe('Ünïcode');
		expect(metadata.artist).toBe('A');
		expect(metadata.trackNumber).toBe(7);
		expect(metadata.raw!['vendor']).toBe('libopus 1.5');
		expect(metadata.raw!['ENCODER']).toBe('opusenc');
		expect(metadata.images).toHaveLength(1);
		expect(metadata.images![0]!.kind).toBe('coverFront');
		expect(metadata.images![0]!.mimeType).toBe('image/jpeg');
		expect(metadata.images![0]!.description).toBe('Cövr');
		expect(metadata.images![0]!.data).toEqual(image);
		expect(layout48k(await readTrackPackets(bytes))).toEqual(repeat(3, i => [i * 960 - 312, 960, 10]));
	});

	test.each([
		['one packet per page', 1, 60],
		['many packets per page', 40, 30],
		['255 segments per page', 255, 6],
	])('random access matches sequential reading with %s', async (_, packetsPerPage, pageCount) => {
		const packets = repeat(packetsPerPage * pageCount, i => opusPacket20ms(5 + (i % 17)));
		const bytes = buildOpusStream({
			preSkip: 312,
			pages: repeat(pageCount, i => ({ packets: packets.slice(i * packetsPerPage, (i + 1) * packetsPerPage) })),
		});
		const sequential = layout48k(await readTrackPackets(bytes));

		using input = openOgg(bytes);
		const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
		expect(await sink.getPacket(-0.01)).toBe(null);
		for (let i = 0; i < sequential.length; i += Math.max(1, Math.floor(sequential.length / 37))) {
			const [start] = sequential[i]!;
			for (const offset of [0, 1, 959]) {
				const packet = (await sink.getPacket((start! + offset) / 48000))!;
				expect(layout48k([packet])[0]).toEqual(sequential[i]);
			}
			const packet = (await sink.getPacket(start! / 48000))!;
			const next = await sink.getNextPacket(packet);
			expect(next && layout48k([next])[0]).toEqual(sequential[i + 1] ?? null);
		}
		expect(layout48k([(await sink.getPacket(1e6))!])[0]).toEqual(sequential.at(-1));
	});

	test('random access through an unsized source falls back to scanning and gives the same packets', async () => {
		const packets = repeat(400, i => opusPacket20ms(5 + (i % 13)));
		const bytes = buildOpusStream({
			preSkip: 312,
			pages: repeat(10, i => ({ packets: packets.slice(i * 40, (i + 1) * 40) })),
		});
		const sequential = layout48k(await readTrackPackets(bytes));

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < bytes.length; offset += 1000) {
					controller.enqueue(bytes.slice(offset, offset + 1000));
				}
				controller.close();
			},
		});
		using input = new Input({ source: new ReadableStreamSource(stream), formats: ALL_FORMATS });
		const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
		expect(await sink.getPacket(-0.01)).toBe(null);
		for (const index of [0, 1, 99, 100, 101, 250, 399]) {
			const [start] = sequential[index]!;
			expect(layout48k([(await sink.getPacket((start! + 100) / 48000))!])[0]).toEqual(sequential[index]);
		}
	});
});

describe('Vorbis in Ogg', () => {
	const fixturePages = parseOggPages(VORBIS_FIXTURE);
	const fixturePackets = parseOggPackets(fixturePages, fixturePages[0]!.serialNumber);
	const [identification, comment, setup] = fixturePackets.map(x => x.data);

	test('reads the identification, comment and setup headers into a Xiph-laced description', async () => {
		using input = openOgg(VORBIS_FIXTURE);
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getCodec()).toBe('vorbis');
		expect(await track.getSampleRate()).toBe(44100);
		expect(await track.getNumberOfChannels()).toBe(2);
		const description = toUint8Array((await track.getDecoderConfig())!.description!);
		// Number of packets minus one, the lacing of the first two packets, then the three packets
		expect(description).toEqual(concatBytes([
			new Uint8Array([2, identification!.length, comment!.length]), identification!, comment!, setup!,
		]));
		expect(await input.getMimeType()).toBe('audio/ogg; codecs="vorbis"');
	});

	test('times packets by the decoder output their blockflags imply', async () => {
		// vorbis-eos.ogg was written by VLC. Its first audio page's granule (10,515) exceeds the 10,432 samples its
		// packets decode to, so the first sample plays at 83; the priming packet before it decodes to nothing. FFmpeg's
		// decoder returns 128 samples for short-short, 576 for long-short/short-long and 1,024 for long-long blocks.
		const read = await readTrackPackets(VORBIS_FIXTURE);
		const layout = read.map(packet => [Math.round(packet.timestamp * 44100), Math.round(packet.duration * 44100)]);
		expect(read).toHaveLength(365); // ffprobe also lists the empty packet VLC ends the stream with
		expect(layout.slice(0, 11)).toEqual([
			[-45, 128], [83, 128], [211, 128], [339, 128], [467, 128], [595, 128], [723, 128], [851, 128],
			[979, 576], [1555, 576], [2131, 128],
		]);
		let end = -45;
		for (const [timestamp, duration] of layout) {
			expect(timestamp).toBe(end);
			expect([128, 576, 1024]).toContain(duration);
			end += duration!;
		}
		expect(end).toBe(237971);
		using input = openOgg(VORBIS_FIXTURE);
		expect(await (await input.getPrimaryAudioTrack())!.computeDuration()).toBe(237971 / 44100);
	});

	test('derives durations of crafted packets from the mode number and the previous window flag', async () => {
		// The fixture's setup header has blocksizes 256/2048 and two modes: mode 0 short, mode 1 long. Audio packets
		// start with a 0 packet type bit, the mode bit, and for long blocks the previous and next window flags.
		const short = new Uint8Array([0b0000, 0xaa]);
		const longAfterShort = new Uint8Array([0b0010, 0xaa]); // previous window flag 0
		const longAfterLong = new Uint8Array([0b0110, 0xaa]); // previous window flag 1
		const audio = [short, longAfterShort, longAfterLong, longAfterLong, short, short, longAfterShort];
		const expectedDurations = [128, 576, 1024, 1024, 576, 128, 576];
		const decoded = expectedDurations.slice(1).reduce((a, b) => a + b, 0);
		const serialNumber = 0x766f72;
		const bytes = concatBytes(buildOggStream(serialNumber, [
			{ packets: [identification!], granulePosition: 0n, headerType: 2 },
			{ packets: [comment!, setup!], granulePosition: 0n },
			{ packets: audio.slice(0, 4), granulePosition: BigInt(576 + 1024 + 1024) },
			{ packets: audio.slice(4), granulePosition: BigInt(decoded), headerType: 4 },
		]));

		const read = await readTrackPackets(bytes);
		expect(read.map(packet => Math.round(packet.duration * 44100))).toEqual(expectedDurations);
		expect(Math.round(read[0]!.timestamp * 44100)).toBe(-128);
		expect(Math.round(read[1]!.timestamp * 44100)).toBe(0);
	});

	test('reads the Vorbis comment header', async () => {
		const serialNumber = 4;
		const customComment = concatBytes([
			new Uint8Array([3, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]),
			buildVorbisCommentBody(
				'Xiph.Org libVorbis I 20200704 (Reducing Environment)',
				['TITLE=T', 'Artist=A', 'GENRE=G1', 'GENRE=G2'],
			),
			new Uint8Array([1]), // Framing bit
		]);
		const bytes = concatBytes(buildOggStream(serialNumber, [
			{ packets: [identification!], granulePosition: 0n, headerType: 2 },
			{ packets: [customComment, setup!], granulePosition: 0n },
			{ packets: [new Uint8Array([0, 1]), new Uint8Array([0, 1])], granulePosition: 128n, headerType: 4 },
		]));

		using input = openOgg(bytes);
		expect(await input.getMetadataTags()).toEqual({
			title: 'T',
			artist: 'A',
			genre: 'G1',
			raw: {
				vendor: 'Xiph.Org libVorbis I 20200704 (Reducing Environment)',
				TITLE: 'T',
				ARTIST: 'A',
				GENRE: ['G1', 'G2'],
			},
		});
	});
});

// ===== Muxer =====

type OggValidationResult = { errors: string[]; pages: ParsedOggPage[] };

/** Checks the page-level rules of RFC 3533 and the Ogg Opus rules of RFC 7845 sections 3-5. */
const validateOgg = (bytes: Uint8Array): OggValidationResult => {
	const errors: string[] = [];
	const pages = parseOggPages(bytes);

	for (const page of pages) {
		const raw = bytes.slice(page.offset, page.offset + 27 + page.lacingValues.length + page.data.length);
		raw.fill(0, 22, 26);
		if (oggCrc32(raw) !== page.checksum) {
			errors.push(`bad CRC at ${page.offset}`);
		}
		if (page.lacingValues.length === 0) {
			errors.push(`empty page at ${page.offset}`);
		}
	}

	let seenNonBos = false;
	for (const page of pages) {
		if (page.headerType & 2) {
			if (seenNonBos) {
				errors.push('BOS page after a non-BOS page');
			}
		} else {
			seenNonBos = true;
		}
	}

	for (const serialNumber of new Set(pages.map(x => x.serialNumber))) {
		const streamPages = pages.filter(x => x.serialNumber === serialNumber);
		streamPages.forEach((page, i) => {
			const isFirst = i === 0;
			const isLast = i === streamPages.length - 1;
			if (page.sequenceNumber !== i) {
				errors.push(`page ${i} has sequence number ${page.sequenceNumber}`);
			}
			if (!!(page.headerType & 2) !== isFirst) {
				errors.push(`page ${i} BOS flag wrong`);
			}
			if (!!(page.headerType & 4) !== isLast) {
				errors.push(`page ${i} EOS flag wrong`);
			}
			const continues = i > 0 && streamPages[i - 1]!.lacingValues.at(-1) === 255;
			if (!!(page.headerType & 1) !== continues) {
				errors.push(`page ${i} continuation flag wrong`);
			}
			const completesPacket = page.lacingValues.some(x => x < 255);
			if (completesPacket === (page.granulePosition === -1n)) {
				errors.push(`page ${i} granule ${page.granulePosition} doesn't match whether a packet completes`);
			}
		});

		const packets = parseOggPackets(pages, serialNumber);
		const head = packets[0]!.data;
		if (new TextDecoder().decode(head.subarray(0, 8)) !== 'OpusHead') {
			continue;
		}
		const pageIndexOf = (packetIndex: number) => streamPages.indexOf(pages[packets[packetIndex]!.pageIndex]!);
		if (streamPages[0]!.lacingValues.length !== 1 || streamPages[0]!.granulePosition !== 0n) {
			errors.push('OpusHead must be alone on the first page, with granule 0');
		}
		if (new TextDecoder().decode(packets[1]!.data.subarray(0, 8)) !== 'OpusTags') {
			errors.push('second packet must be OpusTags');
		}
		const tagsPage = pageIndexOf(1);
		if (streamPages[tagsPage]!.granulePosition !== 0n) {
			errors.push('the page completing OpusTags must have granule 0');
		}
		if (packets.length > 2 && pageIndexOf(2) === tagsPage) {
			errors.push('audio data must start on a fresh page');
		}

		let previousGranule: bigint | null = null;
		for (let pageIndex = tagsPage + 1; pageIndex < streamPages.length; pageIndex++) {
			const page = streamPages[pageIndex]!;
			const completed = packets.filter((_, i) => i >= 2 && pageIndexOf(i) === pageIndex);
			if (completed.length === 0) {
				continue;
			}
			const samples = BigInt(completed.reduce((sum, packet) => sum + opusPacketSamples(packet.data), 0));
			const isEos = !!(page.headerType & 4);
			if (previousGranule === null) {
				if (page.granulePosition < samples && !isEos) {
					errors.push('first audio page granule smaller than its samples');
				}
			} else if (isEos) {
				if (page.granulePosition > previousGranule + samples) {
					errors.push('EOS granule larger than the samples');
				}
			} else if (page.granulePosition !== previousGranule + samples) {
				errors.push(`page ${pageIndex} granule ${page.granulePosition} != ${previousGranule + samples}`);
			}
			previousGranule = page.granulePosition;
		}
	}

	return { errors, pages };
};

const OPUS_HEAD_2CH = buildOpusHead({ channels: 2, preSkip: 312 });
const opusDecoderConfig = (description = OPUS_HEAD_2CH) => ({
	codec: 'opus',
	numberOfChannels: description[9]!,
	sampleRate: 48000,
	description,
});

type MuxPacket = { data: Uint8Array; timestamp: number; duration: number };

const muxOgg = async (
	tracks: { config: AudioDecoderConfig; packets: MuxPacket[]; codec?: 'opus' | 'vorbis' }[],
	formatOptions: ConstructorParameters<typeof OggOutputFormat>[0] = {},
	tags?: MetadataTags,
) => {
	const output = new Output({ format: new OggOutputFormat(formatOptions), target: new BufferTarget() });
	const sources = tracks.map((track) => {
		const source = new EncodedAudioPacketSource(track.codec ?? 'opus');
		output.addAudioTrack(source);
		return source;
	});
	if (tags) {
		output.setMetadataTags(tags);
	}
	await output.start();

	// Interleave by timestamp, like a real muxing pipeline would
	const queue = tracks.flatMap((track, trackIndex) => track.packets.map((packet, i) => ({ packet, trackIndex, i })));
	queue.sort((a, b) => a.packet.timestamp - b.packet.timestamp || a.trackIndex - b.trackIndex);
	for (const { packet, trackIndex, i } of queue) {
		await sources[trackIndex]!.add(
			new EncodedPacket(packet.data, 'key', packet.timestamp, packet.duration),
			i === 0 ? { decoderConfig: tracks[trackIndex]!.config } : undefined,
		);
	}
	for (const source of sources) {
		source.close();
	}
	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

type OpusPacketOptions = { start?: number; size?: (i: number) => number; config?: number };

const opusPackets = (count: number, options: OpusPacketOptions = {}) => {
	const frame = OPUS_CONFIG_FRAME_SAMPLES[options.config ?? 31]!;
	return repeat(count, (i) => {
		const data = new Uint8Array(options.size?.(i) ?? 20).fill(i & 0xff);
		data[0] = (options.config ?? 31) << 3;
		return {
			data,
			timestamp: ((options.start ?? -312) + i * frame) / 48000,
			duration: frame / 48000,
		};
	});
};

describe('Ogg muxer', () => {
	test.each([
		['small packets', opusPackets(500), {}],
		['packets that are multiples of 255 bytes', opusPackets(60, { size: i => 255 * (1 + (i % 3)) }), {}],
		['packets larger than a page', opusPackets(20, { size: i => 30000 + i * 1000 }), {}],
		['a maximum page duration', opusPackets(200), { maximumPageDuration: 0.1 }],
		['2.5 ms packets that fill 255 segments', opusPackets(2000, { config: 16, size: () => 8 }), {}],
	])('writes Opus pages that satisfy RFC 3533 and RFC 7845 for %s', async (_, packets, options) => {
		const bytes = await muxOgg([{ config: opusDecoderConfig(), packets }], options);
		const { errors, pages } = validateOgg(bytes);
		expect(errors).toEqual([]);
		expect(pages.every(page => page.lacingValues.length <= 255)).toBe(true);

		// And the packets come back unchanged, with the same timing
		const read = await readTrackPackets(bytes);
		expect(read.map(x => x.data)).toEqual(packets.map(x => x.data));
		expect(read.map(x => x.timestamp)).toEqual(packets.map(x => x.timestamp));
		expect(read.map(x => x.duration)).toEqual(packets.map(x => x.duration));
	});

	test('keeps every page within the maximum page duration', async () => {
		const bytes = await muxOgg(
			[{ config: opusDecoderConfig(), packets: opusPackets(300) }],
			{ maximumPageDuration: 0.25 },
		);
		const { pages } = validateOgg(bytes);
		const audioPages = pages.slice(2);
		let previous = 0n;
		for (const page of audioPages) {
			expect(Number(page.granulePosition - previous)).toBeLessThanOrEqual(0.25 * 48000);
			previous = page.granulePosition;
		}
		expect(audioPages.length).toBeGreaterThanOrEqual(Math.ceil(300 * 960 / (0.25 * 48000)));
	});

	test('writes granule positions in 48 kHz samples that include the pre-skip', async () => {
		const bytes = await muxOgg([{ config: opusDecoderConfig(), packets: opusPackets(100) }]);
		const { pages } = validateOgg(bytes);
		expect(pages[0]!.granulePosition).toBe(0n);
		expect(pages[1]!.granulePosition).toBe(0n);
		// The first packet starts at -pre-skip, so the granule counts all decoded samples
		expect(pages.at(-1)!.granulePosition).toBe(BigInt(100 * 960));
	});

	test('offsets the granule positions when the first packet starts at a later time', async () => {
		for (const start of [0, 48000]) {
			const packets = opusPackets(100, { start });
			const bytes = await muxOgg([{ config: opusDecoderConfig(), packets }]);
			const { errors, pages } = validateOgg(bytes);
			expect(errors).toEqual([]);
			expect(pages.at(-1)!.granulePosition).toBe(BigInt(start + 312 + 100 * 960));

			const read = await readTrackPackets(bytes);
			expect(read.map(x => x.timestamp)).toEqual(packets.map(x => x.timestamp));
		}
	});

	test('signals a shorter final packet through the granule position of the EOS page', async () => {
		const packets = opusPackets(50);
		packets.at(-1)!.duration = 329 / 48000;
		const bytes = await muxOgg([{ config: opusDecoderConfig(), packets }]);
		const { errors, pages } = validateOgg(bytes);
		expect(errors).toEqual([]);
		expect(pages.at(-1)!.granulePosition).toBe(BigInt(49 * 960 + 329));

		const read = await readTrackPackets(bytes);
		expect(read.at(-1)!.duration).toBe(329 / 48000);
		using input = openOgg(bytes);
		expect(await (await input.getPrimaryAudioTrack())!.computeDuration()).toBe((49 * 960 + 329 - 312) / 48000);
	});

	test('writes the OpusHead unchanged and an OpusTags header with the metadata tags', async () => {
		const head = buildOpusHead({
			channels: 6,
			preSkip: 312,
			mappingFamily: 1,
			streamCount: 4,
			coupledCount: 2,
			mapping: [0, 4, 1, 2, 3, 5],
			outputGain: -100,
		});
		const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
		const bytes = await muxOgg([{ config: opusDecoderConfig(head), packets: opusPackets(10) }], {}, {
			title: 'Tïtle',
			artist: 'Artist',
			trackNumber: 2,
			images: [{ data: image, mimeType: 'image/png', kind: 'coverBack', description: 'Bäck' }],
			raw: { CUSTOM: 'x' },
		});
		const pages = parseOggPages(bytes);
		const packets = parseOggPackets(pages, pages[0]!.serialNumber);
		expect(packets[0]!.data).toEqual(head);

		const tags = packets[1]!.data;
		expect(new TextDecoder().decode(tags.subarray(0, 8))).toBe('OpusTags');
		const view = new DataView(tags.buffer, tags.byteOffset, tags.byteLength);
		const vendorLength = view.getUint32(8, true);
		expect(new TextDecoder().decode(tags.subarray(12, 12 + vendorLength))).toBe(VERSIONED_NAME);

		using input = openOgg(bytes);
		const metadata = await input.getMetadataTags();
		expect(metadata.title).toBe('Tïtle');
		expect(metadata.artist).toBe('Artist');
		expect(metadata.trackNumber).toBe(2);
		expect(metadata.raw!['CUSTOM']).toBe('x');
		expect(metadata.images).toEqual([
			{ data: image, mimeType: 'image/png', kind: 'coverBack', description: 'Bäck', name: undefined },
		]);
		expect(await (await input.getPrimaryAudioTrack())!.getNumberOfChannels()).toBe(6);
	});

	test('writes every BOS page first and interleaves two tracks by time', async () => {
		const headA = buildOpusHead({ channels: 1, preSkip: 312 });
		const headB = buildOpusHead({ channels: 2, preSkip: 120 });
		const packetsA = opusPackets(400, { size: () => 40 });
		const packetsB = opusPackets(400, { start: -120, size: () => 60 });
		const bytes = await muxOgg([
			{ config: opusDecoderConfig(headA), packets: packetsA },
			{ config: opusDecoderConfig(headB), packets: packetsB },
		]);
		const { errors, pages } = validateOgg(bytes);
		expect(errors).toEqual([]);
		expect(pages.slice(0, 2).map(x => x.headerType & 2)).toEqual([2, 2]);
		expect(new Set(pages.map(x => x.serialNumber)).size).toBe(2);

		// Pages of the two streams alternate instead of one stream coming after the other
		const serialOrder = pages.map(x => x.serialNumber);
		const switches = serialOrder.filter((serial, i) => i > 0 && serial !== serialOrder[i - 1]).length;
		expect(switches).toBeGreaterThan(4);

		expect((await readTrackPackets(bytes, 0)).map(x => x.timestamp)).toEqual(packetsA.map(x => x.timestamp));
		expect((await readTrackPackets(bytes, 1)).map(x => x.timestamp)).toEqual(packetsB.map(x => x.timestamp));
	});

	test('reports each page and its position through onPage', async () => {
		const calls: { length: number; position: number }[] = [];
		const output = await muxOgg([{ config: opusDecoderConfig(), packets: opusPackets(300) }], {
			onPage: (data, position) => calls.push({ length: data.length, position }),
		});
		const pages = parseOggPages(output);
		expect(calls).toEqual(pages.map((page, i) => ({
			length: (pages[i + 1]?.offset ?? output.length) - page.offset,
			position: page.offset,
		})));
	});

	test('remuxes the Vorbis fixture with identical packets, timestamps and setup header', async () => {
		using input = openOgg(VORBIS_FIXTURE);
		const track = (await input.getPrimaryAudioTrack())!;
		const config = (await track.getDecoderConfig())!;
		const packets: MuxPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push({ data: packet.data, timestamp: packet.timestamp, duration: packet.duration });
		}

		const bytes = await muxOgg([{ config, packets, codec: 'vorbis' }]);
		const { errors, pages } = validateOgg(bytes);
		expect(errors).toEqual([]);
		const written = parseOggPackets(pages, pages[0]!.serialNumber);
		const original = parseOggPackets(parseOggPages(VORBIS_FIXTURE), parseOggPages(VORBIS_FIXTURE)[0]!.serialNumber);
		expect(written[0]!.data).toEqual(original[0]!.data);
		expect(written[2]!.data).toEqual(original[2]!.data);
		// The first page holds only the identification header; the setup header ends its own page
		expect(pages[0]!.lacingValues).toHaveLength(1);
		expect(written[3]!.pageIndex).toBeGreaterThan(written[2]!.pageIndex);
		expect(pages.at(-1)!.granulePosition).toBe(237971n);

		const read = await readTrackPackets(bytes);
		expect(read.map(x => x.timestamp)).toEqual(packets.map(x => x.timestamp));
		expect(read.map(x => x.duration)).toEqual(packets.map(x => x.duration));
		expect(read.map(x => x.data)).toEqual(packets.map(x => x.data));
	});

	test('supports only Opus and Vorbis audio', () => {
		const format = new OggOutputFormat();
		expect(format.getSupportedCodecs()).toEqual(['opus', 'vorbis']);
		expect(format.fileExtension).toBe('.ogg');
		expect(format.mimeType).toBe('application/ogg');
		expect(() => new OggOutputFormat({ maximumPageDuration: -1 })).toThrow();
	});
});
