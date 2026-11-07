import { describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, ReadableStreamSource } from '../../src/source.js';
import { ALL_FORMATS, MPEG_TS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { InputTrack } from '../../src/input-track.js';
import { MpegTsDemuxer } from '../../src/mpeg-ts/mpeg-ts-demuxer.js';
import {
	ac3Frame,
	adtsFrame,
	annexB,
	AVC_AUD,
	avcPps,
	avcSlice,
	avcSps,
	buildPatSection,
	buildPesPacket,
	buildPmtSection,
	buildSection,
	concatBytes,
	descriptor,
	dvbAc3Descriptor,
	dvbEac3Descriptor,
	eac3Frame,
	HEVC_AUD,
	hevcSlice,
	mpegAudioFrame,
	PmtStream,
	registrationDescriptor,
	TsBuilder,
	X264_PPS_64,
	X264_SPS_64,
	X265_PPS_64,
	X265_SPS_64,
	X265_VPS_64,
} from './helpers/mpegts-builder.js';

// Expectations here follow ISO/IEC 13818-1 (H.222.0) as implemented by FFmpeg's libavformat/mpegts.c and Chromium's
// media/formats/mp2t, since the spec text itself isn't freely available.

const PMT_PID = 0x1000;
const VIDEO_PID = 0x100;
const AUDIO_PID = 0x101;

const startProgram = (ts: TsBuilder, streams: PmtStream[], options: { pcrPid?: number } = {}) => {
	ts.section(0x0000, buildPatSection([{ programNumber: 1, pid: PMT_PID }]));
	ts.section(PMT_PID, buildPmtSection({ pcrPid: options.pcrPid ?? streams[0]?.pid, streams }));
};

const AVC_IDR_AU = annexB([AVC_AUD, X264_SPS_64, X264_PPS_64, avcSlice({ idr: true, size: 300 })]);
const avcDeltaAu = (size = 100) => annexB([AVC_AUD, avcSlice({ size })]);

type PacketSummary = { timestamp: number; duration: number; type: string; size: number };

const summarize = (packet: EncodedPacket): PacketSummary => ({
	timestamp: packet.timestamp,
	duration: packet.duration,
	type: packet.type,
	size: packet.byteLength,
});

const readPackets = async (track: InputTrack) => {
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	return packets;
};

const openBytes = (bytes: Uint8Array) => new Input({
	source: new BufferSource(bytes),
	formats: ALL_FORMATS,
});

/** One AVC video stream (PID 0x100) with `count` AUs at 30 fps, IDR every `gop` frames, RAI on IDRs. */
const buildAvcStream = (ts: TsBuilder, count: number, options: { gop?: number; firstPts?: number } = {}) => {
	const gop = options.gop ?? 10;
	const firstPts = options.firstPts ?? 90_000;
	for (let i = 0; i < count; i++) {
		const isKey = i % gop === 0;
		const pes = buildPesPacket({
			streamId: 0xe0,
			pts: firstPts + 3000 * i,
			data: isKey ? AVC_IDR_AU : avcDeltaAu(),
			pesPacketLength: 0,
		});
		ts.pes(VIDEO_PID, pes, { randomAccess: isKey });
	}
};

describe('MPEG-TS demuxer: packet layer', () => {
	const buildBasic = () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }]);
		buildAvcStream(ts, 12);
		return ts;
	};

	test('reads 188-, 192- (BDAV, TP_extra_header first) and 204-byte (parity after) packets alike', async () => {
		const ts = buildBasic();
		const results: PacketSummary[][] = [];

		for (const bytes of [ts.toBytes(), ts.toBytes({ prefix: 4 }), ts.toBytes({ suffix: 16 })]) {
			using input = openBytes(bytes);
			expect(await input.getFormat()).toBe(MPEG_TS);
			const track = await input.getPrimaryVideoTrack();
			results.push((await readPackets(track!)).map(summarize));
		}

		expect(results[0]).toHaveLength(12);
		expect(results[1]).toEqual(results[0]);
		expect(results[2]).toEqual(results[0]);
	});

	test('skips null packets and adaptation-field-only packets', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }], { pcrPid: 0x1ffe });

		for (let i = 0; i < 6; i++) {
			const pes = buildPesPacket({ streamId: 0xe0, pts: 3000 * i, data: i === 0 ? AVC_IDR_AU : avcDeltaAu(400) });
			ts.nullPacket();
			// A PCR carried on its own PID without payload, as broadcast streams do
			ts.packet({ pid: 0x1ffe, adaptation: { pcr: 3000 * i } });
			// An adaptation-only packet on the video PID itself, between the PES packet's payload packets
			const first = pes.subarray(0, 184);
			ts.packet({ pid: VIDEO_PID, pusi: true, payload: first });
			ts.packet({ pid: VIDEO_PID, adaptation: { discontinuity: false } });
			ts.pes(VIDEO_PID, pes.subarray(184));
			// ts.pes marks its first packet as a payload unit start, so undo that for the continuation
			const continuation = ts.packets[ts.packets.length - Math.ceil((pes.length - 184) / 184)]!;
			continuation[1]! &= ~0x40;
		}

		using input = openBytes(ts.toBytes());
		const track = await input.getPrimaryVideoTrack();
		const packets = await readPackets(track!);
		const sizes = packets.map(packet => packet.byteLength);
		expect(sizes).toEqual([AVC_IDR_AU.length, ...new Array<number>(5).fill(410)]);
	});

	test('ignores the contents of the adaptation field (PCR, OPCR, splice countdown, private data)', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }]);

		for (let i = 0; i < 4; i++) {
			const pes = buildPesPacket({ streamId: 0xe0, pts: 3000 * i, data: i === 0 ? AVC_IDR_AU : avcDeltaAu() });
			ts.pes(VIDEO_PID, pes, {
				randomAccess: i === 0,
				pcr: 3000 * i,
				opcr: 1234,
				spliceCountdown: 3 - i,
				privateData: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
			});
		}

		using input = openBytes(ts.toBytes());
		const packets = await readPackets((await input.getPrimaryVideoTrack())!);
		expect(packets.map(summarize)).toEqual([
			{ timestamp: 0, duration: 1 / 30, type: 'key', size: AVC_IDR_AU.length },
			{ timestamp: 1 / 30, duration: 1 / 30, type: 'delta', size: 110 },
			{ timestamp: 2 / 30, duration: 1 / 30, type: 'delta', size: 110 },
			{ timestamp: 3 / 30, duration: 1 / 30, type: 'delta', size: 110 },
		]);
	});

	test('reads payloads behind maximal adaptation-field stuffing, down to one byte per packet', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }]);

		for (let i = 0; i < 3; i++) {
			const pes = buildPesPacket({ streamId: 0xe0, pts: 3000 * i, data: i === 0 ? AVC_IDR_AU : avcDeltaAu(30) });
			for (let offset = 0; offset < pes.length; offset++) {
				// 183 bytes of adaptation field and a single payload byte (the first packet also carries a 1-byte
				// adaptation field of length 0 when there's room)
				ts.packet({ pid: VIDEO_PID, pusi: offset === 0, payload: pes.subarray(offset, offset + 1) });
			}
		}

		using input = openBytes(ts.toBytes());
		const packets = await readPackets((await input.getPrimaryVideoTrack())!);
		expect(packets.map(packet => packet.byteLength)).toEqual([AVC_IDR_AU.length, 40, 40]);
	});

	test('reads a payload after a one-byte adaptation field (adaptation_field_length 0)', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }]);

		const pes = buildPesPacket({ streamId: 0xe0, pts: 0, data: AVC_IDR_AU, pesPacketLength: 0 });
		let offset = 0;
		while (offset < pes.length) {
			const chunk = pes.subarray(offset, offset + 183);
			// A 183-byte payload gets exactly one byte of adaptation field: just adaptation_field_length = 0
			ts.packet({ pid: VIDEO_PID, pusi: offset === 0, payload: chunk });
			offset += chunk.length;
		}

		const bytes = ts.toBytes();
		expect(bytes[2 * 188 + 4]).toBe(0); // adaptation_field_length of the first video packet

		using input = openBytes(bytes);
		const packets = await readPackets((await input.getPrimaryVideoTrack())!);
		expect(packets.map(packet => packet.byteLength)).toEqual([AVC_IDR_AU.length]);
	});

	test('keeps reading across continuity counter gaps and transport_error_indicator flags', async () => {
		const ts = buildBasic();
		const bytes = ts.toBytes();

		for (let i = 2; i < bytes.length / 188; i += 3) {
			bytes[i * 188 + 3] = (bytes[i * 188 + 3]! & 0xf0) | ((bytes[i * 188 + 3]! + 5) & 0x0f); // Wrong counter
			if (i % 2 === 0) {
				bytes[i * 188 + 1]! |= 0x80; // transport_error_indicator
			}
		}

		using input = openBytes(bytes);
		const packets = await readPackets((await input.getPrimaryVideoTrack())!);
		expect(packets).toHaveLength(12);
	});

	test('ignores an incomplete last packet, like FFmpeg', async () => {
		const bytes = buildBasic().toBytes();

		// The last AU fits in the last TS packet, which loses its final 100 bytes
		using input = openBytes(bytes.subarray(0, bytes.length - 100));
		const packets = await readPackets((await input.getPrimaryVideoTrack())!);
		expect(packets).toHaveLength(11);
		expect(packets[10]!.timestamp).toBeCloseTo(1 + 10 / 30, 10);
	});
});

describe('MPEG-TS demuxer: program specific information', () => {
	const addMedia = (ts: TsBuilder, videoPid = VIDEO_PID, audioPid = AUDIO_PID) => {
		for (let i = 0; i < 3; i++) {
			const video = buildPesPacket({ streamId: 0xe0, pts: 3000 * i, data: i === 0 ? AVC_IDR_AU : avcDeltaAu() });
			ts.pes(videoPid, video, { randomAccess: i === 0 });
			ts.pes(audioPid, buildPesPacket({ streamId: 0xc0, pts: 1920 * i, data: adtsFrame() }));
		}
	};

	const trackSummary = async (bytes: Uint8Array) => {
		using input = openBytes(bytes);
		const tracks = await input.getTracks();
		return await Promise.all(tracks.map(async track => ({
			id: track.id,
			type: track.type,
			codec: await track.getCodec(),
			packetCount: (await readPackets(track)).length,
		})));
	};

	const AVC_AND_AAC = [
		{ id: VIDEO_PID, type: 'video', codec: 'avc', packetCount: 3 },
		{ id: AUDIO_PID, type: 'audio', codec: 'aac', packetCount: 3 },
	];

	test('finds the PMT through the PAT, whatever its PID', async () => {
		const ts = new TsBuilder();
		ts.section(0x0000, buildPatSection([{ programNumber: 7, pid: 0x20 }]));
		ts.section(0x20, buildPmtSection({
			programNumber: 7,
			pcrPid: 0x30,
			streams: [{ streamType: 0x1b, pid: 0x30 }, { streamType: 0x0f, pid: 0x31 }],
		}));
		addMedia(ts, 0x30, 0x31);

		expect(await trackSummary(ts.toBytes())).toEqual([
			{ id: 0x30, type: 'video', codec: 'avc', packetCount: 3 },
			{ id: 0x31, type: 'audio', codec: 'aac', packetCount: 3 },
		]);
	});

	test('finds the PMT when it comes before the PAT, or without a PAT at all', async () => {
		const pmt = buildPmtSection({
			streams: [{ streamType: 0x1b, pid: VIDEO_PID }, { streamType: 0x0f, pid: AUDIO_PID }],
		});

		const before = new TsBuilder();
		before.section(PMT_PID, pmt);
		before.section(0x0000, buildPatSection([{ programNumber: 1, pid: PMT_PID }]));
		addMedia(before);
		expect(await trackSummary(before.toBytes())).toEqual(AVC_AND_AAC);

		const withoutPat = new TsBuilder();
		withoutPat.section(PMT_PID, pmt);
		addMedia(withoutPat);
		expect(await trackSummary(withoutPat.toBytes())).toEqual(AVC_AND_AAC);
	});

	test('skips the network PID entry (program_number 0) of the PAT', async () => {
		const ts = new TsBuilder();
		ts.section(0x0000, buildPatSection([{ programNumber: 0, pid: 0x10 }, { programNumber: 1, pid: PMT_PID }]));
		ts.section(PMT_PID, buildPmtSection({
			streams: [{ streamType: 0x1b, pid: VIDEO_PID }, { streamType: 0x0f, pid: AUDIO_PID }],
		}));
		addMedia(ts);

		expect(await trackSummary(ts.toBytes())).toEqual(AVC_AND_AAC);
	});

	test('ignores SDT, NIT and EIT sections, program_info descriptors and PSI CRC errors', async () => {
		const ts = new TsBuilder();
		ts.section(0x0011, buildSection({ tableId: 0x42, tableIdExtension: 1, body: new Uint8Array(20).fill(0x55) }));
		ts.section(0x0010, buildSection({ tableId: 0x40, tableIdExtension: 1, body: new Uint8Array(12) }));
		ts.section(0x0012, buildSection({ tableId: 0x4e, tableIdExtension: 1, body: new Uint8Array(40).fill(0x33) }));
		ts.section(0x0000, buildSection({
			tableId: 0x00,
			tableIdExtension: 1,
			body: new Uint8Array([0x00, 0x01, 0xf0, 0x00]),
			badCrc: true,
		}));
		ts.section(PMT_PID, buildPmtSection({
			programDescriptors: [
				descriptor(0x09, [0x0b, 0x00, 0xe1, 0x23]), // CA_descriptor
				descriptor(0xf0, new Array(40).fill(0x77)), // User private
			],
			streams: [
				{ streamType: 0x1b, pid: VIDEO_PID, descriptors: [descriptor(0x28, [0x64, 0x00, 0x1f, 0x3f])] },
				{ streamType: 0x0f, pid: AUDIO_PID, descriptors: [descriptor(0x52, [0x01])] },
			],
		}));
		addMedia(ts);

		expect(await trackSummary(ts.toBytes())).toEqual(AVC_AND_AAC);
	});

	test('keeps the first PMT and ignores later versions of it', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }]);
		addMedia(ts);
		ts.section(PMT_PID, buildPmtSection({
			version: 1,
			streams: [{ streamType: 0x1b, pid: VIDEO_PID }, { streamType: 0x0f, pid: AUDIO_PID }],
		}));
		addMedia(ts);

		expect(await trackSummary(ts.toBytes())).toEqual([
			{ id: VIDEO_PID, type: 'video', codec: 'avc', packetCount: 6 },
		]);
	});

	test('reads a PMT spanning two TS packets', async () => {
		// Enough descriptors to push the section past 183 bytes
		const longDescriptors = [descriptor(0xf0, new Array(100).fill(1)), descriptor(0xf1, new Array(100).fill(2))];
		const ts = new TsBuilder();
		ts.section(0x0000, buildPatSection([{ programNumber: 1, pid: PMT_PID }]));
		ts.section(PMT_PID, buildPmtSection({
			streams: [
				{ streamType: 0x1b, pid: VIDEO_PID, descriptors: longDescriptors },
				{ streamType: 0x0f, pid: AUDIO_PID },
			],
		}));
		expect(ts.packets).toHaveLength(3);
		addMedia(ts);

		expect(await trackSummary(ts.toBytes())).toEqual(AVC_AND_AAC);
	});

	test('skips stream types it can\'t read, without affecting the other streams', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [
			{ streamType: 0x15, pid: 0x200, descriptors: [registrationDescriptor('ID3 ')] }, // Timed ID3 metadata
			{ streamType: 0x86, pid: 0x201, descriptors: [registrationDescriptor('CUEI')] }, // SCTE-35
			{ streamType: 0x1b, pid: VIDEO_PID },
			{ streamType: 0x11, pid: 0x202 }, // AAC in LATM
			{ streamType: 0x06, pid: 0x203, descriptors: [registrationDescriptor('Opus')] },
			// Teletext
			{ streamType: 0x06, pid: 0x204, descriptors: [descriptor(0x56, [0x65, 0x6e, 0x67, 0x09, 0x00])] },
			{ streamType: 0x0f, pid: AUDIO_PID },
			{ streamType: 0x02, pid: 0x205 }, // MPEG-2 video
		]);
		for (const pid of [0x200, 0x201, 0x202, 0x203, 0x204, 0x205]) {
			ts.pes(pid, buildPesPacket({ streamId: 0xbd, pts: 0, data: new Uint8Array(50).fill(pid & 0xff) }));
		}
		addMedia(ts);

		expect(await trackSummary(ts.toBytes())).toEqual(AVC_AND_AAC);
	});

	test('doesn\'t surface a declared stream that has no packets', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [
			{ streamType: 0x1b, pid: VIDEO_PID },
			{ streamType: 0x0f, pid: AUDIO_PID },
			{ streamType: 0x0f, pid: 0x102 },
		]);
		addMedia(ts);

		expect(await trackSummary(ts.toBytes())).toEqual(AVC_AND_AAC);
	});
});

describe('MPEG-TS demuxer: stream types', () => {
	const singleAudioStream = (stream: PmtStream, frames: Uint8Array[], streamId = 0xc0, ptsStep = 2880) => {
		const ts = new TsBuilder();
		startProgram(ts, [stream]);
		frames.forEach((frame, i) => {
			ts.pes(stream.pid, buildPesPacket({ streamId, pts: 90_000 + ptsStep * i, data: frame }));
		});
		return ts.toBytes();
	};

	const audioSummary = async (bytes: Uint8Array) => {
		using input = openBytes(bytes);
		const track = await input.getPrimaryAudioTrack();
		if (!track) {
			return null;
		}

		const packets = await readPackets(track);
		return {
			codec: await track.getCodec(),
			internalCodecId: await track.getInternalCodecId(),
			decoderConfig: await track.getDecoderConfig(),
			packets: packets.map(summarize),
		};
	};

	test('reads AC-3 as stream_type 0x81 (ATSC) and as 0x06 with a DVB AC-3 descriptor', async () => {
		const frames = [ac3Frame({ acmod: 7, lfeon: 1 }), ac3Frame({ acmod: 7, lfeon: 1 })];
		const expected = (internalCodecId: number) => ({
			codec: 'ac3',
			internalCodecId,
			decoderConfig: { codec: 'ac-3', numberOfChannels: 6, sampleRate: 48000 },
			packets: [
				{ timestamp: 1, duration: 0.032, type: 'key', size: 256 },
				{ timestamp: 1.032, duration: 0.032, type: 'key', size: 256 },
			],
		});

		expect(await audioSummary(singleAudioStream(
			{ streamType: 0x81, pid: AUDIO_PID, descriptors: [registrationDescriptor('AC-3')] },
			frames,
			0xbd,
		))).toEqual(expected(0x81));
		expect(await audioSummary(singleAudioStream(
			{ streamType: 0x06, pid: AUDIO_PID, descriptors: [dvbAc3Descriptor()] },
			frames,
			0xbd,
		))).toEqual(expected(0x06));
	});

	test('reads E-AC-3 as stream_type 0x87 (ATSC) and as 0x06 with an E-AC-3 descriptor (0x7a or 0xcc)', async () => {
		const frames = [eac3Frame({ acmod: 2 }), eac3Frame({ acmod: 2 })];
		const expected = (internalCodecId: number) => ({
			codec: 'eac3',
			internalCodecId,
			decoderConfig: { codec: 'ec-3', numberOfChannels: 2, sampleRate: 48000 },
			packets: [
				{ timestamp: 1, duration: 0.032, type: 'key', size: 256 },
				{ timestamp: 1.032, duration: 0.032, type: 'key', size: 256 },
			],
		});

		for (const [streamType, descriptors] of [
			[0x87, [registrationDescriptor('EAC3')]],
			[0x06, [dvbEac3Descriptor()]],
			[0x06, [descriptor(0xcc, [0x00])]],
		] as const) {
			expect(await audioSummary(singleAudioStream(
				{ streamType, pid: AUDIO_PID, descriptors: [...descriptors] },
				frames,
				0xbd,
			))).toEqual(expected(streamType));
		}
	});

	test('reads MPEG audio as stream_type 0x03 and 0x04, Layer II included', async () => {
		for (const [streamType, layer] of [[0x03, 3], [0x04, 3], [0x03, 2]] as const) {
			const frames = [mpegAudioFrame({ layer }), mpegAudioFrame({ layer })];
			expect(await audioSummary(singleAudioStream({ streamType, pid: AUDIO_PID }, frames, 0xc0, 2160))).toEqual({
				codec: 'mp3',
				internalCodecId: streamType,
				decoderConfig: { codec: 'mp3', numberOfChannels: 1, sampleRate: 48000 },
				packets: [
					{ timestamp: 1, duration: 0.024, type: 'key', size: 384 },
					{ timestamp: 1.024, duration: 0.024, type: 'key', size: 384 },
				],
			});
		}
	});

	test('reads AAC in ADTS with its profile, sampling frequency and channel configuration', async () => {
		const frames = [0, 1, 2].map(() => adtsFrame({ objectType: 2, sampleRateIndex: 4, channelConfiguration: 6 }));
		expect(await audioSummary(singleAudioStream({ streamType: 0x0f, pid: AUDIO_PID }, frames, 0xc0, 2090)))
			.toEqual({
				codec: 'aac',
				internalCodecId: 0x0f,
				decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 6, sampleRate: 44100 },
				packets: [0, 1, 2].map(i => ({
					timestamp: 1 + 2090 * i / 90_000,
					duration: 2090 / 90_000,
					type: 'key',
					size: 39,
				})),
			});
	});

	test('reads HEVC (stream_type 0x24) with its parameter sets', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x24, pid: VIDEO_PID }]);
		const aus = [
			annexB([HEVC_AUD, X265_VPS_64, X265_SPS_64, X265_PPS_64, hevcSlice({ type: 19, size: 200 })]),
			annexB([HEVC_AUD, hevcSlice({ type: 1, size: 50 })]),
			annexB([HEVC_AUD, hevcSlice({ type: 1, size: 50 })]),
		];
		aus.forEach((au, i) => {
			ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 3600 * i, data: au, pesPacketLength: 0 }));
		});

		using input = openBytes(ts.toBytes());
		const track = await input.getPrimaryVideoTrack();
		expect(await track!.getCodec()).toBe('hevc');
		expect(await track!.getDecoderConfig()).toEqual({
			codec: 'hev1.1.6.L30.90',
			codedWidth: 64,
			codedHeight: 64,
			colorSpace: { primaries: undefined, transfer: undefined, matrix: undefined, fullRange: false },
		});
		expect((await readPackets(track!)).map(summarize)).toEqual([
			{ timestamp: 0, duration: 0.04, type: 'key', size: aus[0]!.length },
			{ timestamp: 0.04, duration: 0.04, type: 'delta', size: aus[1]!.length },
			{ timestamp: 0.08, duration: 0.04, type: 'delta', size: aus[2]!.length },
		]);
	});
});

describe('MPEG-TS demuxer: PES packets', () => {
	const videoOnly = (build: (ts: TsBuilder) => void) => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }]);
		build(ts);
		return ts.toBytes();
	};

	const videoPackets = async (bytes: Uint8Array) => {
		using input = openBytes(bytes);
		return (await readPackets((await input.getPrimaryVideoTrack())!)).map(summarize);
	};

	const THREE_AUS = [AVC_IDR_AU, avcDeltaAu(), avcDeltaAu(250)];

	test('reads unbounded (PES_packet_length 0) and bounded video PES packets alike', async () => {
		const unbounded = await videoPackets(videoOnly((ts) => {
			THREE_AUS.forEach((au, i) => {
				ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 3000 * i, data: au, pesPacketLength: 0 }));
			});
		}));
		const bounded = await videoPackets(videoOnly((ts) => {
			THREE_AUS.forEach((au, i) => {
				ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 3000 * i, data: au }));
			});
		}));

		expect(unbounded.map(packet => packet.size)).toEqual(THREE_AUS.map(au => au.length));
		expect(bounded).toEqual(unbounded);
	});

	test('reads PTS-only and PTS+DTS headers alike, and skips PES header stuffing', async () => {
		const reference = await videoPackets(videoOnly((ts) => {
			THREE_AUS.forEach((au, i) => {
				ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 3000 * i, data: au }));
			});
		}));
		const withDts = await videoPackets(videoOnly((ts) => {
			THREE_AUS.forEach((au, i) => {
				ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 3000 * (i + 1), dts: 3000 * i, data: au }));
			});
		}));
		const stuffed = await videoPackets(videoOnly((ts) => {
			THREE_AUS.forEach((au, i) => {
				ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 3000 * i, data: au, headerStuffing: 32 }));
			});
		}));

		expect(withDts).toEqual(reference.map(packet => ({ ...packet, timestamp: packet.timestamp + 1 / 30 })));
		expect(stuffed).toEqual(reference);
	});

	test('ignores bytes past PES_packet_length', async () => {
		const packets = await videoPackets(videoOnly((ts) => {
			THREE_AUS.forEach((au, i) => {
				const pes = buildPesPacket({ streamId: 0xe0, pts: 3000 * i, data: au });
				// Garbage after the PES packet, still within its last TS packet
				ts.pes(VIDEO_PID, concatBytes([pes, new Uint8Array([0, 0, 1, 0x65, 0x88, 0x84])]));
			});
		}));

		expect(packets.map(packet => packet.size)).toEqual(THREE_AUS.map(au => au.length));
	});

	test('a PES packet spanning hundreds of TS packets', async () => {
		const bigIdr = annexB([AVC_AUD, X264_SPS_64, X264_PPS_64, avcSlice({ idr: true, size: 100_000 })]);
		const packets = await videoPackets(videoOnly((ts) => {
			ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 0, data: bigIdr, pesPacketLength: 0 }));
			ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 3000, data: avcDeltaAu(), pesPacketLength: 0 }));
		}));

		expect(packets.map(packet => packet.size)).toEqual([bigIdr.length, 110]);
	});

	test('continues an access unit into following PES packets without PTS', async () => {
		const au = annexB([AVC_AUD, X264_SPS_64, X264_PPS_64, avcSlice({ idr: true, size: 1000 })]);
		const packets = await videoPackets(videoOnly((ts) => {
			// The IDR is split over three PES packets, only the first of which has a PTS
			ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 0, data: au.subarray(0, 300) }));
			ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, data: au.subarray(300, 700) }));
			ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, data: au.subarray(700) }));
			ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 3000, data: avcDeltaAu() }));
		}));

		expect(packets).toEqual([
			{ timestamp: 0, duration: 1 / 30, type: 'key', size: au.length },
			{ timestamp: 1 / 30, duration: 1 / 30, type: 'delta', size: 110 },
		]);
	});

	test('splits several ADTS frames in one PES packet, timing them on from its PTS', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x0f, pid: AUDIO_PID }]);
		// 48 kHz AAC: 1920 ticks per frame
		const threeFrames = concatBytes([0, 1, 2].map(() => adtsFrame()));
		ts.pes(AUDIO_PID, buildPesPacket({ streamId: 0xc0, pts: 90_000, data: threeFrames }));
		ts.pes(AUDIO_PID, buildPesPacket({ streamId: 0xc0, pts: 90_000 + 3 * 1920, data: adtsFrame() }));

		using input = openBytes(ts.toBytes());
		const packets = (await readPackets((await input.getPrimaryAudioTrack())!)).map(summarize);
		expect(packets).toEqual([0, 1, 2, 3].map(i => ({
			timestamp: 1 + i * 1024 / 48000,
			duration: 1024 / 48000,
			type: 'key',
			size: 39,
		})));
	});

	test('joins an audio frame split across PES packets, timed by the PES packet it starts in', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x0f, pid: AUDIO_PID }]);
		const frames = concatBytes([0, 1, 2, 3].map(() => adtsFrame({ payloadSize: 100 })));
		// PES boundaries at bytes 150 and 300 cut frames 1 and 2 in two. A PTS belongs to the first frame that starts
		// in its PES packet: frame 0, frame 2 (at byte 214) and frame 3 (at byte 321).
		ts.pes(AUDIO_PID, buildPesPacket({ streamId: 0xc0, pts: 90_000, data: frames.subarray(0, 150) }));
		ts.pes(AUDIO_PID, buildPesPacket({ streamId: 0xc0, pts: 90_000 + 2 * 1920, data: frames.subarray(150, 300) }));
		ts.pes(AUDIO_PID, buildPesPacket({ streamId: 0xc0, pts: 90_000 + 3 * 1920, data: frames.subarray(300) }));

		using input = openBytes(ts.toBytes());
		const packets = (await readPackets((await input.getPrimaryAudioTrack())!)).map(summarize);
		expect(packets).toEqual([0, 1, 2, 3].map(i => ({
			timestamp: 1 + i * 1024 / 48000,
			duration: 1024 / 48000,
			type: 'key',
			size: 107,
		})));
	});
});

describe('MPEG-TS demuxer: timestamps', () => {
	const audioWithPts = (ptsValues: number[]) => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x0f, pid: AUDIO_PID }]);
		for (const pts of ptsValues) {
			ts.pes(AUDIO_PID, buildPesPacket({ streamId: 0xc0, pts, data: adtsFrame() }));
		}
		return ts.toBytes();
	};

	const audioTimestamps = async (bytes: Uint8Array) => {
		using input = openBytes(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		return {
			timestamps: (await readPackets(track)).map(packet => packet.timestamp),
			firstTimestamp: await track.getFirstTimestamp(),
			duration: await track.computeDuration(),
		};
	};

	test('reports PTS / 90 kHz as is, without shifting the first one to zero', async () => {
		const result = await audioTimestamps(audioWithPts([900_000, 901_920, 903_840]));
		expect(result).toEqual({
			timestamps: [10, 10 + 1024 / 48000, 10 + 2048 / 48000],
			firstTimestamp: 10,
			duration: 10 + 3072 / 48000,
		});
	});

	test('unwraps timestamps crossing the 33-bit PTS wrap', async () => {
		const wrap = 2 ** 33;
		const ptsValues = [wrap - 3840, wrap - 1920, 0, 1920];
		const { timestamps, duration } = await audioTimestamps(audioWithPts(ptsValues));
		expect(timestamps.map(timestamp => Math.round(timestamp * 90_000))).toEqual([
			-3840, -1920, 0, 1920, // Within a minute before the wrap, so the stream counts as starting negative
		]);
		expect(duration).toBeCloseTo(3840 / 90_000, 10);

		const earlier = [wrap - 2 * 90_000 * 60, wrap - 2 * 90_000 * 60 + 1920].map(pts => pts);
		const { timestamps: farTimestamps } = await audioTimestamps(audioWithPts([...earlier, 1000]));
		// Starting more than a minute before the wrap, timestamps keep counting past 2^33
		expect(farTimestamps.map(timestamp => Math.round(timestamp * 90_000))).toEqual([...earlier, wrap + 1000]);
	});

	test('derives video durations from presentation order (B-frames)', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }]);
		// Decode order I0 P3 B1 B2 P6 B4 B5, in frame units of 3000 ticks
		const order = [0, 3, 1, 2, 6, 4, 5];
		order.forEach((frame, i) => {
			const pes = buildPesPacket({
				streamId: 0xe0,
				pts: 9000 + 3000 * frame,
				dts: 3000 + 3000 * i,
				data: i === 0 ? annexB([AVC_AUD, avcSps(), avcPps(), avcSlice({ idr: true })]) : avcDeltaAu(),
			});
			ts.pes(VIDEO_PID, pes, { randomAccess: i === 0 });
		});

		using input = openBytes(ts.toBytes());
		const packets = await readPackets((await input.getPrimaryVideoTrack())!);
		expect(packets.map(packet => Math.round(packet.timestamp * 90_000) / 3000 - 3)).toEqual(order);
		expect(packets.map(packet => packet.duration)).toEqual(order.map(() => 1 / 30));
	});

	test('times audio frames by codec: AAC 1024, MPEG audio 1152, AC-3 1536, E-AC-3 256 per block', async () => {
		const cases = [
			{
				stream: { streamType: 0x0f, pid: AUDIO_PID },
				frame: adtsFrame({ sampleRateIndex: 6 }),
				duration: 1024 / 24000,
			},
			{ stream: { streamType: 0x03, pid: AUDIO_PID }, frame: mpegAudioFrame(), duration: 1152 / 48000 },
			{ stream: { streamType: 0x81, pid: AUDIO_PID }, frame: ac3Frame(), duration: 1536 / 48000 },
			{
				stream: { streamType: 0x87, pid: AUDIO_PID },
				frame: eac3Frame({ numblkscod: 1 }),
				duration: 512 / 48000,
			},
		];

		for (const { stream, frame, duration } of cases) {
			const ts = new TsBuilder();
			startProgram(ts, [stream]);
			// All frames in one PES packet, so their timing can only come from the codec
			ts.pes(AUDIO_PID, buildPesPacket({ streamId: 0xc0, pts: 0, data: concatBytes([frame, frame, frame]) }));

			using input = openBytes(ts.toBytes());
			const packets = await readPackets((await input.getPrimaryAudioTrack())!);
			const expected = [0, 1, 2].map(i => Math.round(i * duration * 90_000) / 90_000);
			expect(packets.map(packet => packet.timestamp)).toEqual(expected);
		}
	});
});

describe('MPEG-TS demuxer: video access units', () => {
	const avcPackets = async (aus: Uint8Array[], options: { pts?: (i: number) => number } = {}) => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }]);
		aus.forEach((au, i) => {
			const pts = options.pts?.(i) ?? 3000 * i;
			const pes = buildPesPacket({ streamId: 0xe0, pts, data: au, pesPacketLength: 0 });
			ts.pes(VIDEO_PID, pes, { randomAccess: i === 0 });
		});

		using input = openBytes(ts.toBytes());
		return (await readPackets((await input.getPrimaryVideoTrack())!)).map(summarize);
	};

	test('splits a PES packet holding several AUD-delimited AVC access units', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }]);
		const aus = [AVC_IDR_AU, avcDeltaAu(), avcDeltaAu(70)];
		ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 0, data: concatBytes(aus), pesPacketLength: 0 }));

		using input = openBytes(ts.toBytes());
		const packets = (await readPackets((await input.getPrimaryVideoTrack())!)).map(summarize);
		expect(packets.map(packet => packet.size)).toEqual(aus.map(au => au.length));
	});

	test('finds AVC access units without AUDs: at SPS/PPS/SEI and at slices restarting at macroblock 0', async () => {
		const sei = new Uint8Array([0x06, 0x05, 0x01, 0x00, 0x80]); // user_data_unregistered stub
		const aus = [
			annexB([X264_SPS_64, X264_PPS_64, sei, avcSlice({ idr: true, size: 200 })]),
			annexB([avcSlice({ size: 50 })]),
			annexB([sei, avcSlice({ size: 50 })]),
			annexB([avcSlice({ size: 50 })]),
		];
		// One PES packet holding them all, so only the bitstream can delimit them
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }]);
		ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 0, data: concatBytes(aus), pesPacketLength: 0 }));

		using input = openBytes(ts.toBytes());
		const packets = (await readPackets((await input.getPrimaryVideoTrack())!)).map(summarize);
		expect(packets.map(packet => packet.size)).toEqual(aus.map(au => au.length));
		expect(packets.map(packet => packet.type)).toEqual(['key', 'delta', 'delta', 'delta']);
	});

	test('keeps the slices of one AVC picture together (first_mb_in_slice increasing)', async () => {
		const aus = [
			annexB([
				AVC_AUD,
				X264_SPS_64,
				X264_PPS_64,
				...[0, 4, 8, 12].map(firstMb => avcSlice({ idr: true, firstMb })),
			]),
			annexB([...[0, 2, 9].map(firstMb => avcSlice({ firstMb }))]),
			annexB([...[0, 5].map(firstMb => avcSlice({ firstMb }))]),
		];
		const packets = await avcPackets(aus);
		expect(packets.map(packet => packet.size)).toEqual(aus.map(au => au.length));
	});

	test('accepts 3-byte start codes and drops bytes before the first NAL unit of a picture', async () => {
		const threeByte = (nalUnits: Uint8Array[]) => concatBytes(
			nalUnits.flatMap(nalUnit => [new Uint8Array([0, 0, 1]), nalUnit]),
		);
		const aus = [
			concatBytes([
				new Uint8Array([0xab, 0xcd]),
				threeByte([AVC_AUD, X264_SPS_64, X264_PPS_64, avcSlice({ idr: true })]),
			]),
			threeByte([AVC_AUD, avcSlice()]),
		];
		const packets = await avcPackets(aus);
		expect(packets.map(packet => packet.size)).toEqual([aus[0]!.length - 2, aus[1]!.length]);
	});

	test('splits HEVC access units at first_slice_segment_in_pic_flag, keeping suffix SEI in its unit', async () => {
		const suffixSei = new Uint8Array([0x50, 0x01, 0x05, 0x01, 0x00, 0x80]); // SUFFIX_SEI_NUT (40)
		const aus = [
			annexB([
				X265_VPS_64,
				X265_SPS_64,
				X265_PPS_64,
				hevcSlice({ type: 19 }),
				hevcSlice({ type: 19, firstSliceInPicture: false }),
			]),
			annexB([hevcSlice({ type: 1 }), hevcSlice({ type: 1, firstSliceInPicture: false }), suffixSei]),
			annexB([HEVC_AUD, hevcSlice({ type: 0 })]),
			annexB([hevcSlice({ type: 1 })]),
		];
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x24, pid: VIDEO_PID }]);
		ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 0, data: concatBytes(aus), pesPacketLength: 0 }));

		using input = openBytes(ts.toBytes());
		const packets = (await readPackets((await input.getPrimaryVideoTrack())!)).map(summarize);
		expect(packets.map(packet => packet.size)).toEqual(aus.map(au => au.length));
		expect(packets.map(packet => packet.type)).toEqual(['key', 'delta', 'delta', 'delta']);
	});

	test('doesn\'t split HEVC access units at NAL units of layers above the base layer', async () => {
		const aus = [
			annexB([
				X265_VPS_64,
				X265_SPS_64,
				X265_PPS_64,
				hevcSlice({ type: 19 }),
				hevcSlice({ type: 19, layerId: 1 }),
			]),
			annexB([hevcSlice({ type: 1 }), hevcSlice({ type: 1, layerId: 1 })]),
		];
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x24, pid: VIDEO_PID }]);
		aus.forEach((au, i) => {
			ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 3000 * i, data: au, pesPacketLength: 0 }));
		});

		using input = openBytes(ts.toBytes());
		const packets = (await readPackets((await input.getPrimaryVideoTrack())!)).map(summarize);
		expect(packets.map(packet => packet.size)).toEqual(aus.map(au => au.length));
	});
});

describe('MPEG-TS demuxer: key packets', () => {
	const KEY_PATTERN = [true, false, false, false, true, false, false, true, false];

	const buildWithKeys = (options: { flagKeys: boolean }) => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }]);
		KEY_PATTERN.forEach((isKey, i) => {
			const pes = buildPesPacket({ streamId: 0xe0, pts: 3000 * i, data: isKey ? AVC_IDR_AU : avcDeltaAu() });
			ts.pes(VIDEO_PID, pes, { randomAccess: options.flagKeys && isKey });
		});
		return ts.toBytes();
	};

	for (const flagKeys of [true, false]) {
		const label = flagKeys ? 'from random_access_indicator' : 'from the bitstream, without random_access_indicator';

		test(`finds key packets ${label}`, async () => {
			using input = openBytes(buildWithKeys({ flagKeys }));
			const track = (await input.getPrimaryVideoTrack())!;
			const sink = new EncodedPacketSink(track);
			const packets = await readPackets(track);

			expect(packets.map(packet => packet.type === 'key')).toEqual(KEY_PATTERN);

			// The last key packet at or before each timestamp
			for (let i = 0; i < packets.length; i++) {
				const expectedIndex = KEY_PATTERN.lastIndexOf(true, i);
				const keyPacket = await sink.getKeyPacket(packets[i]!.timestamp);
				expect(keyPacket?.sequenceNumber).toBe(packets[expectedIndex]!.sequenceNumber);
			}

			const secondKey = await sink.getNextKeyPacket(packets[0]!);
			expect(secondKey?.timestamp).toBe(packets[4]!.timestamp);
			const thirdKey = await sink.getNextKeyPacket(secondKey!);
			expect(thirdKey?.timestamp).toBe(packets[7]!.timestamp);
			expect(await sink.getNextKeyPacket(thirdKey!)).toBeNull();
		});
	}

	test('counts every HEVC IRAP picture type as a key frame', async () => {
		const irapTypes = [16, 17, 18, 19, 20, 21]; // BLA_W_LP, BLA_W_RADL, BLA_N_LP, IDR_W_RADL, IDR_N_LP, CRA
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x24, pid: VIDEO_PID }]);
		[...irapTypes, 1, 0, 9].forEach((type, i) => {
			const nalUnits = i === 0
				? [HEVC_AUD, X265_VPS_64, X265_SPS_64, X265_PPS_64, hevcSlice({ type })]
				: [HEVC_AUD, hevcSlice({ type })];
			// No random_access_indicator anywhere, so the bitstream decides
			ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 3000 * i, data: annexB(nalUnits) }));
		});

		using input = openBytes(ts.toBytes());
		const packets = await readPackets((await input.getPrimaryVideoTrack())!);
		expect(packets.map(packet => packet.type)).toEqual([...irapTypes.map(() => 'key'), 'delta', 'delta', 'delta']);
	});

	test('every audio packet is a key packet, with or without random_access_indicator', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x0f, pid: AUDIO_PID }]);
		for (let i = 0; i < 4; i++) {
			const pes = buildPesPacket({ streamId: 0xc0, pts: 1920 * i, data: adtsFrame() });
			ts.pes(AUDIO_PID, pes, { randomAccess: i === 0 });
		}

		using input = openBytes(ts.toBytes());
		const track = (await input.getPrimaryAudioTrack())!;
		const packets = await readPackets(track);
		expect(packets.map(packet => packet.type)).toEqual(['key', 'key', 'key', 'key']);
		expect((await new EncodedPacketSink(track).getKeyPacket(packets[3]!.timestamp))?.sequenceNumber)
			.toBe(packets[3]!.sequenceNumber);
	});
});

describe('MPEG-TS demuxer: track API', () => {
	test('track ids are PIDs, and numbers count per type in PMT order', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [
			{ streamType: 0x0f, pid: 0x300 },
			{ streamType: 0x1b, pid: 0x200 },
			{ streamType: 0x0f, pid: 0x100 },
		]);
		ts.pes(0x200, buildPesPacket({ streamId: 0xe0, pts: 0, data: AVC_IDR_AU }), { randomAccess: true });
		for (const pid of [0x300, 0x100]) {
			ts.pes(pid, buildPesPacket({ streamId: 0xc0, pts: 0, data: adtsFrame() }));
		}

		using input = openBytes(ts.toBytes());
		const tracks = await input.getTracks();
		expect(tracks.map(track => [track.id, track.type, track.number])).toEqual([
			[0x300, 'audio', 1],
			[0x200, 'video', 1],
			[0x100, 'audio', 2],
		]);
	});

	test('reports codec strings, MIME type, time resolution and the stream_type as internal codec ID', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }, { streamType: 0x0f, pid: AUDIO_PID }]);
		ts.pes(VIDEO_PID, buildPesPacket({ streamId: 0xe0, pts: 0, data: AVC_IDR_AU }), { randomAccess: true });
		ts.pes(AUDIO_PID, buildPesPacket({ streamId: 0xc0, pts: 0, data: adtsFrame({ objectType: 2 }) }));

		using input = openBytes(ts.toBytes());
		expect(await input.getMimeType()).toBe('video/MP2T; codecs="avc1.42c00a, mp4a.40.2"');

		const video = (await input.getPrimaryVideoTrack())!;
		expect(await video.getInternalCodecId()).toBe(0x1b);
		expect(await video.getTimeResolution()).toBe(90_000);
		expect(await video.getDecoderConfig()).toEqual({
			codec: 'avc1.42c00a',
			codedWidth: 64,
			codedHeight: 64,
			colorSpace: { primaries: undefined, transfer: undefined, matrix: undefined, fullRange: false },
		});
		expect(await video.getLanguageCode()).toBe('und');

		const audio = (await input.getPrimaryAudioTrack())!;
		expect(await audio.getInternalCodecId()).toBe(0x0f);
		expect(await audio.getDecoderConfig()).toEqual({ codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000 });
	});

	test('computes duration and packet stats from the packets', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }]);
		buildAvcStream(ts, 30, { gop: 10, firstPts: 0 });

		using input = openBytes(ts.toBytes());
		expect(await input.computeDuration()).toBeCloseTo(1, 10);
		const track = (await input.getPrimaryVideoTrack())!;
		const stats = await track.computePacketStats();
		expect(stats.packetCount).toBe(30);
		expect(stats.averagePacketRate).toBeCloseTo(30, 5);
	});
});

describe('MPEG-TS demuxer: random access', () => {
	// About 1.4 MB: 600 frames with an IDR every 30 and AAC audio, interleaved
	const buildLong = () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x1b, pid: VIDEO_PID }, { streamType: 0x0f, pid: AUDIO_PID }]);
		for (let i = 0; i < 600; i++) {
			const isKey = i % 30 === 0;
			const au = isKey ? AVC_IDR_AU : avcDeltaAu(1500 + (i % 7) * 100);
			const pes = buildPesPacket({ streamId: 0xe0, pts: 90_000 + 3000 * i, data: au });
			ts.pes(VIDEO_PID, pes, { randomAccess: isKey });
			if (i % 2 === 0) {
				// Two AAC frames (2 * 1920 ticks) per two video frames (6000 ticks) leaves gaps, which is fine
				const frames = concatBytes([adtsFrame(), adtsFrame()]);
				ts.pes(AUDIO_PID, buildPesPacket({ streamId: 0xc0, pts: 90_000 + 3000 * i, data: frames }));
			}
		}
		return ts.toBytes();
	};

	test('getPacket and getKeyPacket agree with sequential reading for every packet and seek chunk size', async () => {
		const bytes = buildLong();

		for (const chunkSize of [5 * 1024 * 1024, 64 * 1024, 4096]) {
			using input = openBytes(bytes);
			const track = (await input.getPrimaryVideoTrack())!;
			((await input._demuxerPromise) as MpegTsDemuxer).seekChunkSize = chunkSize;

			const sink = new EncodedPacketSink(track);
			const packets = await readPackets(track);
			expect(packets).toHaveLength(600);

			for (let i = 0; i < packets.length; i += 7) {
				const packet = packets[i]!;
				const found = await sink.getPacket(packet.timestamp + 0.001);
				expect(found?.sequenceNumber).toBe(packet.sequenceNumber);
				expect(found?.duration).toBe(packet.duration);

				const keyFound = await sink.getKeyPacket(packet.timestamp);
				expect(keyFound?.sequenceNumber).toBe(packets[Math.floor(i / 30) * 30]!.sequenceNumber);
			}

			expect(await sink.getPacket(0.5)).toBeNull();
			expect((await sink.getPacket(Infinity))?.sequenceNumber).toBe(packets[599]!.sequenceNumber);
			expect((await sink.getKeyPacket(Infinity))?.sequenceNumber).toBe(packets[570]!.sequenceNumber);
		}
	});

	test('reads from a source of unknown size', async () => {
		const bytes = buildLong();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 65536) {
					controller.enqueue(bytes.slice(i, i + 65536));
				}
				controller.close();
			},
		});

		using input = new Input({ source: new ReadableStreamSource(stream), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new EncodedPacketSink(track);
		expect((await sink.getPacket(5))?.timestamp).toBeCloseTo(5, 10);
		expect(await track.computeDuration()).toBeCloseTo(1 + 600 / 30, 10);
	});
});

describe('MPEG-TS demuxer: format detection', () => {
	test('recognizes 188-, 192- and 204-byte packet streams, and nothing else', async () => {
		const ts = new TsBuilder();
		startProgram(ts, [{ streamType: 0x0f, pid: AUDIO_PID }]);
		ts.pes(AUDIO_PID, buildPesPacket({ streamId: 0xc0, pts: 0, data: adtsFrame() }));

		for (const bytes of [ts.toBytes(), ts.toBytes({ prefix: 4 }), ts.toBytes({ suffix: 16 })]) {
			using input = openBytes(bytes);
			expect(await input.getFormat()).toBe(MPEG_TS);
		}

		// A sync byte at the start alone isn't enough
		const lookalike = new Uint8Array(1000);
		lookalike[0] = 0x47;
		using input = openBytes(lookalike);
		await expect(input.getFormat()).rejects.toThrow();
	});
});
