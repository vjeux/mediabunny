import { describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import {
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	serializeAvcDecoderConfigurationRecord,
	serializeHevcDecoderConfigurationRecord,
} from '../../src/codec-data.js';
import {
	ac3Frame,
	adtsFrame,
	annexB,
	AVC_AUD,
	avcSlice,
	concatBytes,
	eac3Frame,
	hevcSlice,
	mpegAudioFrame,
	X264_PPS_64,
	X264_SPS_64,
	X265_PPS_64,
	X265_SPS_64,
	X265_VPS_64,
} from './helpers/mpegts-builder.js';
import {
	findContinuityErrors,
	ParsedTsPacket,
	parsePat,
	parsePesPackets,
	parsePmt,
	parseSections,
	parseTsPackets,
	splitAnnexB,
} from './helpers/mpegts-parser.js';

// Expectations follow ISO/IEC 13818-1 as implemented by FFmpeg's libavformat/mpegtsenc.c and checked by FFmpeg's
// mpegts.c and Chromium's media/formats/mp2t; the parser in helpers/ is independent of Mediabunny's demuxer.

const AVC_DECODER_CONFIG: VideoDecoderConfig = {
	codec: 'avc1.42c00a',
	codedWidth: 64,
	codedHeight: 64,
};

const avcDescription = () => serializeAvcDecoderConfigurationRecord(
	extractAvcDecoderConfigurationRecord(annexB([X264_SPS_64, X264_PPS_64]))!,
);

const hevcDescription = () => serializeHevcDecoderConfigurationRecord(
	extractHevcDecoderConfigurationRecord(annexB([X265_VPS_64, X265_SPS_64, X265_PPS_64]))!,
);

/** Length-prefixed (4 bytes) NAL units. */
const lengthPrefixed = (nalUnits: Uint8Array[]) => concatBytes(nalUnits.flatMap((nalUnit) => {
	const length = new Uint8Array(4);
	new DataView(length.buffer).setUint32(0, nalUnit.length);
	return [length, nalUnit];
}));

type TrackSpec =
	| { type: 'video'; codec: 'avc' | 'hevc'; packets: EncodedPacket[]; decoderConfig: VideoDecoderConfig }
	| {
		type: 'audio';
		codec: 'aac' | 'mp3' | 'ac3' | 'eac3';
		packets: EncodedPacket[];
		decoderConfig: AudioDecoderConfig;
	};

const mux = async (tracks: TrackSpec[], options: { timestampOffset?: number } = {}) => {
	const onPacketCalls: { data: Uint8Array; position: number }[] = [];
	const output = new Output({
		format: new MpegTsOutputFormat({
			timestampOffset: options.timestampOffset,
			onPacket: (data, position) => onPacketCalls.push({ data, position }),
		}),
		target: new BufferTarget(),
	});

	const sources = tracks.map((track) => {
		if (track.type === 'video') {
			const source = new EncodedVideoPacketSource(track.codec);
			output.addVideoTrack(source);
			return source;
		} else {
			const source = new EncodedAudioPacketSource(track.codec);
			output.addAudioTrack(source);
			return source;
		}
	});

	await output.start();

	// Feed tracks interleaved by timestamp, like a real source would
	const queue = tracks.flatMap((track, trackIndex) => track.packets.map((packet, i) => ({ trackIndex, packet, i })));
	queue.sort((a, b) => a.packet.timestamp - b.packet.timestamp || a.trackIndex - b.trackIndex);
	for (const { trackIndex, packet, i } of queue) {
		const track = tracks[trackIndex]!;
		const meta = i === 0 ? { decoderConfig: track.decoderConfig } : undefined;
		const source = sources[trackIndex]!;
		if (source instanceof EncodedVideoPacketSource) {
			await source.add(packet, meta as EncodedVideoChunkMetadata | undefined);
		} else {
			await source.add(packet, meta as EncodedAudioChunkMetadata | undefined);
		}
	}

	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	return { bytes, packets: parseTsPackets(bytes), onPacketCalls, mimeType: await output.getMimeType() };
};

const avcTrack = (count: number, options: { gop?: number; lengthPrefixed?: boolean } = {}): TrackSpec => {
	const gop = options.gop ?? 5;
	const packets = Array.from({ length: count }, (_, i) => {
		const isKey = i % gop === 0;
		const nalUnits = isKey ? [avcSlice({ idr: true, size: 120 })] : [avcSlice({ size: 40 + i })];
		const data = options.lengthPrefixed
			? lengthPrefixed(nalUnits)
			: annexB(isKey ? [X264_SPS_64, X264_PPS_64, ...nalUnits] : nalUnits);
		return new EncodedPacket(data, isKey ? 'key' : 'delta', i / 30, 1 / 30);
	});

	return {
		type: 'video',
		codec: 'avc',
		packets,
		decoderConfig: options.lengthPrefixed
			? { ...AVC_DECODER_CONFIG, description: avcDescription() }
			: AVC_DECODER_CONFIG,
	};
};

const aacTrack = (count: number, options: { raw?: boolean } = {}): TrackSpec => {
	const frame = adtsFrame({ payloadSize: 20 });
	const packets = Array.from({ length: count }, (_, i) => new EncodedPacket(
		options.raw ? frame.subarray(7) : frame,
		'key',
		i * 1024 / 48000,
		1024 / 48000,
	));

	return {
		type: 'audio',
		codec: 'aac',
		packets,
		decoderConfig: {
			codec: 'mp4a.40.2',
			numberOfChannels: 2,
			sampleRate: 48000,
			// AudioSpecificConfig: AAC-LC, 48 kHz, 2 channels
			description: options.raw ? new Uint8Array([0x11, 0x90]) : undefined,
		},
	};
};

const pidsOf = (packets: ParsedTsPacket[]) => [...new Set(packets.map(packet => packet.pid))];

describe('MPEG-TS muxer: transport stream structure', () => {
	test('writes 188-byte packets with continuous continuity counters on every PID', async () => {
		const { bytes, packets } = await mux([avcTrack(20), aacTrack(30)]);
		expect(bytes.length % 188).toBe(0);
		expect(findContinuityErrors(packets)).toEqual([]);
		expect(packets.every(packet => !packet.transportErrorIndicator && packet.scramblingControl === 0)).toBe(true);
		expect(pidsOf(packets).sort()).toEqual([0x0000, 0x0100, 0x0101, 0x1000]);
	});

	test('starts with a PAT pointing at the PMT, both with valid CRCs', async () => {
		const { packets } = await mux([avcTrack(5), aacTrack(5)]);

		expect(packets[0]!.pid).toBe(0x0000);
		expect(packets[1]!.pid).toBe(0x1000);

		const [pat] = parseSections(packets, 0x0000);
		expect(pat).toMatchObject({ tableId: 0x00, version: 0, currentNext: 1, crcOk: true });
		expect(parsePat(pat!)).toEqual([{ programNumber: 1, pid: 0x1000 }]);

		const [pmt] = parseSections(packets, 0x1000);
		expect(pmt).toMatchObject({ tableId: 0x02, tableIdExtension: 1, crcOk: true });
		expect(parsePmt(pmt!)).toEqual({
			programNumber: 1,
			pcrPid: 0x1fff,
			programDescriptors: new Uint8Array(0),
			streams: [
				{ streamType: 0x1b, pid: 0x100, descriptors: new Uint8Array(0) },
				{ streamType: 0x0f, pid: 0x101, descriptors: new Uint8Array(0) },
			],
		});
	});

	test('declares each codec with its stream type, registration descriptor and PES stream_id', async () => {
		const tracks: TrackSpec[] = [
			{ ...avcTrack(2), packets: avcTrack(2).packets },
			{
				type: 'video',
				codec: 'hevc',
				packets: [new EncodedPacket(
					annexB([X265_VPS_64, X265_SPS_64, X265_PPS_64, hevcSlice({ type: 19 })]), 'key', 0, 1 / 30,
				)],
				decoderConfig: { codec: 'hev1.1.6.L30.90', codedWidth: 64, codedHeight: 64 },
			},
			aacTrack(2),
			{
				type: 'audio',
				codec: 'mp3',
				packets: [new EncodedPacket(mpegAudioFrame(), 'key', 0, 0.024)],
				decoderConfig: { codec: 'mp3', numberOfChannels: 1, sampleRate: 48000 },
			},
			{
				type: 'audio',
				codec: 'ac3',
				packets: [new EncodedPacket(ac3Frame(), 'key', 0, 0.032)],
				decoderConfig: { codec: 'ac-3', numberOfChannels: 2, sampleRate: 48000 },
			},
			{
				type: 'audio',
				codec: 'eac3',
				packets: [new EncodedPacket(eac3Frame(), 'key', 0, 0.032)],
				decoderConfig: { codec: 'ec-3', numberOfChannels: 2, sampleRate: 48000 },
			},
		];
		const { packets } = await mux(tracks);

		const pmt = parsePmt(parseSections(packets, 0x1000)[0]!);
		expect(pmt.streams.map(stream => [stream.streamType, stream.pid, [...stream.descriptors]])).toEqual([
			[0x1b, 0x100, []],
			[0x24, 0x101, []],
			[0x0f, 0x102, []],
			[0x03, 0x103, []],
			[0x81, 0x104, [0x05, 0x04, ...'AC-3'].map(x => typeof x === 'string' ? x.charCodeAt(0) : x)],
			[0x87, 0x105, [0x05, 0x04, ...'EAC3'].map(x => typeof x === 'string' ? x.charCodeAt(0) : x)],
		]);

		const streamIds = [0x100, 0x101, 0x102, 0x103, 0x104, 0x105]
			.map(pid => parsePesPackets(packets, pid)[0]!.streamId);
		expect(streamIds).toEqual([0xe0, 0xe1, 0xc0, 0xc1, 0xbd, 0xbd]);
	});

	test('a PMT for many tracks spans several packets and still parses', async () => {
		// 36 tracks don't fit into one packet's 183 bytes of section data
		const tracks = [
			...Array.from({ length: 4 }, () => avcTrack(1)),
			...Array.from({ length: 32 }, () => aacTrack(1)),
		];
		const { packets } = await mux(tracks);

		const pmtPackets = packets.filter(packet => packet.pid === 0x1000);
		expect(pmtPackets.length).toBeGreaterThan(1);
		const [pmt] = parseSections(packets, 0x1000);
		expect(pmt!.crcOk).toBe(true);
		expect(parsePmt(pmt!).streams.map(stream => stream.pid)).toEqual(tracks.map((_, i) => 0x100 + i));
	});

	test('reports every written packet with its position through onPacket', async () => {
		const { bytes, onPacketCalls } = await mux([avcTrack(10), aacTrack(10)]);
		expect(onPacketCalls).toHaveLength(bytes.length / 188);
		onPacketCalls.forEach((call, i) => {
			expect(call.position).toBe(188 * i);
			expect(call.data).toEqual(bytes.subarray(188 * i, 188 * (i + 1)));
		});
	});

	test('resolves the MIME type with the tracks\' codec strings', async () => {
		const { mimeType } = await mux([avcTrack(2), aacTrack(2)]);
		expect(mimeType).toBe('video/MP2T; codecs="avc1.42c00a, mp4a.40.2"');
	});
});

describe('MPEG-TS muxer: PES packetization', () => {
	test('writes video PES packets unbounded with PTS and DTS, audio ones bounded with PTS', async () => {
		const { packets } = await mux([avcTrack(6), aacTrack(6)]);

		for (const pes of parsePesPackets(packets, 0x100)) {
			expect(pes).toMatchObject({
				pesPacketLength: 0,
				dataAlignment: true,
				ptsMarker: 0b0011,
				dtsMarker: 0b0001,
			});
			expect(pes.markerBitsOk).toBe(true);
			expect(pes.headerDataLength).toBe(10);
		}

		for (const pes of parsePesPackets(packets, 0x101)) {
			expect(pes).toMatchObject({ dataAlignment: true, ptsMarker: 0b0010, dts: null, headerDataLength: 5 });
			expect(pes.markerBitsOk).toBe(true);
			expect(pes.pesPacketLength).toBe(3 + 5 + pes.data.length);
		}
	});

	test('fills TS packets completely, padding the last one of a PES packet with adaptation stuffing', async () => {
		const { packets } = await mux([avcTrack(8), aacTrack(8)]);

		for (const pid of [0x100, 0x101]) {
			const tsPackets = packets.filter(packet => packet.pid === pid);
			for (const packet of tsPackets) {
				const adaptationLength = packet.adaptation ? 1 + packet.adaptation.length : 0;
				expect(adaptationLength + packet.payload.length).toBe(184);
				expect(packet.adaptation?.stuffingBytes.every(byte => byte === 0xff) ?? true).toBe(true);
			}
		}
	});

	test('flags key frames with random_access_indicator and each PID\'s first packet as a discontinuity', async () => {
		const { packets } = await mux([avcTrack(11, { gop: 5 }), aacTrack(4)]);

		const video = parsePesPackets(packets, 0x100);
		expect(video.map(pes => pes.randomAccess)).toEqual(video.map((_, i) => i % 5 === 0));
		expect(video.map(pes => pes.discontinuity)).toEqual(video.map((_, i) => i === 0));

		const audio = parsePesPackets(packets, 0x101);
		expect(audio.map(pes => pes.randomAccess)).toEqual([true, true, true, true]);
	});

	test('writes PTS as 90 kHz ticks of the timestamp plus timestampOffset, modulo 2^33', async () => {
		const audio = aacTrack(3);
		const { packets } = await mux([audio], { timestampOffset: 10 });
		expect(parsePesPackets(packets, 0x100).map(pes => pes.pts)).toEqual([0, 1, 2].map(i => 900_000 + i * 1920));

		const negative: TrackSpec = {
			...audio,
			packets: audio.packets.map(packet => packet.clone({ timestamp: packet.timestamp - 1 })),
		};
		const { packets: negativePackets } = await mux([negative]);
		expect(parsePesPackets(negativePackets, 0x100).map(pes => pes.pts)).toEqual(
			[0, 1, 2].map(i => 2 ** 33 - 90_000 + i * 1920),
		);
	});

	test('keeps DTS increasing for video in decode order', async () => {
		const { packets } = await mux([avcTrack(15, { gop: 5 })]);
		const dts = parsePesPackets(packets, 0x100).map(pes => pes.dts!);
		for (let i = 1; i < dts.length; i++) {
			expect(dts[i]!).toBeGreaterThan(dts[i - 1]!);
		}
	});

	test('interleaves the tracks\' PES packets by timestamp', async () => {
		const { packets } = await mux([avcTrack(10, { gop: 1 }), aacTrack(15)]);

		const pesStarts = packets
			.filter(packet => packet.payloadUnitStart && (packet.pid === 0x100 || packet.pid === 0x101))
			.map(packet => packet.index);
		const timestamps = [
			...parsePesPackets(packets, 0x100).map(pes => ({ index: pes.firstPacketIndex, pts: pes.pts! })),
			...parsePesPackets(packets, 0x101).map(pes => ({ index: pes.firstPacketIndex, pts: pes.pts! })),
		].sort((a, b) => a.index - b.index);

		expect(timestamps.map(entry => entry.index)).toEqual(pesStarts);
		for (let i = 1; i < timestamps.length; i++) {
			expect(timestamps[i]!.pts).toBeGreaterThanOrEqual(timestamps[i - 1]!.pts);
		}
	});
});

describe('MPEG-TS muxer: elementary stream conversion', () => {
	test('converts length-prefixed AVC to Annex B, with an AUD and SPS/PPS before each key frame', async () => {
		const track = avcTrack(6, { gop: 3, lengthPrefixed: true });
		const { packets } = await mux([track]);

		const nalTypes = parsePesPackets(packets, 0x100)
			.map(pes => splitAnnexB(pes.data).map(nalUnit => nalUnit[0]! & 0x1f));
		expect(nalTypes).toEqual([
			[9, 7, 8, 5],
			[9, 1],
			[9, 1],
			[9, 7, 8, 5],
			[9, 1],
			[9, 1],
		]);

		const first = splitAnnexB(parsePesPackets(packets, 0x100)[0]!.data);
		expect(first[0]).toEqual(AVC_AUD);
		expect(first[1]).toEqual(X264_SPS_64);
		expect(first[2]).toEqual(X264_PPS_64);
	});

	test('keeps Annex B AVC as is, replacing any AUDs with a single leading one', async () => {
		const packetsIn = [
			new EncodedPacket(annexB([AVC_AUD, X264_SPS_64, X264_PPS_64, avcSlice({ idr: true })]), 'key', 0, 1 / 30),
			new EncodedPacket(annexB([avcSlice(), AVC_AUD]), 'delta', 1 / 30, 1 / 30),
		];
		const { packets } = await mux([{
			type: 'video',
			codec: 'avc',
			packets: packetsIn,
			decoderConfig: AVC_DECODER_CONFIG,
		}]);

		const nalTypes = parsePesPackets(packets, 0x100)
			.map(pes => splitAnnexB(pes.data).map(nalUnit => nalUnit[0]! & 0x1f));
		expect(nalTypes).toEqual([[9, 7, 8, 5], [9, 1]]);
	});

	test('converts length-prefixed HEVC to Annex B, with an AUD and VPS/SPS/PPS before each key frame', async () => {
		const packetsIn = [
			new EncodedPacket(lengthPrefixed([hevcSlice({ type: 19 })]), 'key', 0, 1 / 30),
			new EncodedPacket(lengthPrefixed([hevcSlice({ type: 1 })]), 'delta', 1 / 30, 1 / 30),
		];
		const { packets } = await mux([{
			type: 'video',
			codec: 'hevc',
			packets: packetsIn,
			decoderConfig: {
				codec: 'hvc1.1.6.L30.90',
				codedWidth: 64,
				codedHeight: 64,
				description: hevcDescription(),
			},
		}]);

		const nalTypes = parsePesPackets(packets, 0x100)
			.map(pes => splitAnnexB(pes.data).map(nalUnit => (nalUnit[0]! >> 1) & 0x3f));
		expect(nalTypes).toEqual([[35, 32, 33, 34, 19], [35, 1]]);
	});

	test('wraps raw AAC in ADTS headers derived from the AudioSpecificConfig, and passes ADTS through', async () => {
		const raw = aacTrack(3, { raw: true });
		const { packets } = await mux([raw]);
		const expected = adtsFrame({ payloadSize: 20 });

		for (const pes of parsePesPackets(packets, 0x100)) {
			expect(pes.data).toEqual(expected);
		}

		const { packets: adtsPackets } = await mux([aacTrack(3)]);
		for (const pes of parsePesPackets(adtsPackets, 0x100)) {
			expect(pes.data).toEqual(expected);
		}
	});

	test('passes MP3, AC-3 and E-AC-3 frames through unchanged', async () => {
		const cases: [TrackSpec['codec'], Uint8Array, string][] = [
			['mp3', mpegAudioFrame(), 'mp3'],
			['ac3', ac3Frame(), 'ac-3'],
			['eac3', eac3Frame(), 'ec-3'],
		];

		for (const [codec, frame, codecString] of cases) {
			const { packets } = await mux([{
				type: 'audio',
				codec: codec as 'mp3',
				packets: [0, 1].map(i => new EncodedPacket(frame, 'key', i * 0.032, 0.032)),
				decoderConfig: { codec: codecString, numberOfChannels: 2, sampleRate: 48000 },
			}]);
			expect(parsePesPackets(packets, 0x100).map(pes => pes.data)).toEqual([frame, frame]);
		}
	});
});

describe('MPEG-TS muxer: round trip', () => {
	test('Mediabunny reads back the same packets', async () => {
		const video = avcTrack(12, { gop: 4, lengthPrefixed: true });
		const audio = aacTrack(18, { raw: true });
		const { bytes } = await mux([video, audio]);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const videoTrack = (await input.getPrimaryVideoTrack())!;
		const audioTrack = (await input.getPrimaryAudioTrack())!;

		const readBack = async (track: typeof videoTrack | typeof audioTrack) => {
			const result = [];
			for await (const packet of new EncodedPacketSink(track).packets()) {
				result.push({ timestamp: packet.timestamp, type: packet.type });
			}
			return result;
		};

		const round = (x: number) => Math.round(x * 90_000) / 90_000;
		expect(await readBack(videoTrack)).toEqual(video.packets.map(packet => ({
			timestamp: round(packet.timestamp),
			type: packet.type,
		})));
		expect(await readBack(audioTrack)).toEqual(audio.packets.map(packet => ({
			timestamp: round(packet.timestamp),
			type: 'key',
		})));
		expect(await videoTrack.getCodec()).toBe('avc');
		expect(await audioTrack.getDecoderConfig()).toEqual({
			codec: 'mp4a.40.2',
			numberOfChannels: 2,
			sampleRate: 48000,
		});
	});
});
