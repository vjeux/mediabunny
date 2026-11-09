import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource, EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { assert, toUint8Array } from '../../src/misc.js';
import {
	deserializeAvcDecoderConfigurationRecord,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	iterateNalUnitsInAnnexB,
} from '../../src/codec-data.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Muxes the first packets of a file's video track into MPEG-TS and returns the NAL unit types of the first packet. */
const getFirstMuxedPacketNalUnitTypes = async (
	fileName: string,
	transformKeyPacketData?: (data: Uint8Array, description: Uint8Array) => Uint8Array,
) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public', fileName)),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const codec = await track.getCodec();
	assert(codec === 'avc' || codec === 'hevc');
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig?.description);
	const description = toUint8Array(decoderConfig.description);

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource(codec);
	output.addVideoTrack(source);
	await output.start();

	const sink = new EncodedPacketSink(track);
	let count = 0;
	for await (const packet of sink.packets()) {
		const data = packet.type === 'key' && transformKeyPacketData
			? transformKeyPacketData(packet.data, description)
			: packet.data;
		await source.add(new EncodedPacket(data, packet.type, packet.timestamp, packet.duration), { decoderConfig });
		if (++count === 5) {
			break;
		}
	}
	await output.finalize();

	using muxed = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const muxedTrack = await muxed.getPrimaryVideoTrack();
	assert(muxedTrack);
	const firstPacket = await new EncodedPacketSink(muxedTrack).getFirstPacket();
	assert(firstPacket);

	return [...iterateNalUnitsInAnnexB(firstPacket.data)].map(({ offset }) => codec === 'avc'
		? extractNalUnitTypeForAvc(firstPacket.data[offset]!)
		: extractNalUnitTypeForHevc(firstPacket.data[offset]!),
	);
};

test('MPEG-TS muxing adds the decoder config\'s parameter sets to key packets that lack them', async () => {
	// The key packets of this file come without SPS and PPS
	expect(await getFirstMuxedPacketNalUnitTypes('video.mp4')).toEqual([
		9, // AUD
		7, // SPS
		8, // PPS
		6, // SEI
		5, // IDR slice
	]);
});

test('MPEG-TS muxing does not repeat parameter sets that key packets already contain', async () => {
	// The HEVC key packets of this file carry their VPS, SPS and PPS in band (like those of x264/x265 with repeated
	// headers, or of MP4s remuxed from MPEG-TS by FFmpeg)
	expect(await getFirstMuxedPacketNalUnitTypes('he-aac-v2.mp4')).toEqual([
		35, // AUD
		32, // VPS
		33, // SPS
		34, // PPS
		39, // Prefix SEI
		19, // IDR slice
	]);

	// The same with AVC: add the SPS and PPS to the key packets in band
	const nalUnitTypes = await getFirstMuxedPacketNalUnitTypes('video.mp4', (data, description) => {
		const record = deserializeAvcDecoderConfigurationRecord(description);
		assert(record && record.lengthSizeMinusOne === 3);
		const parameterSets = [...record.sequenceParameterSets, ...record.pictureParameterSets];
		const result = new Uint8Array(parameterSets.reduce((sum, x) => sum + 4 + x.length, data.length));
		let offset = 0;
		for (const nalUnit of parameterSets) {
			new DataView(result.buffer).setUint32(offset, nalUnit.length);
			result.set(nalUnit, offset + 4);
			offset += 4 + nalUnit.length;
		}
		result.set(data, offset);
		return result;
	});
	expect(nalUnitTypes).toEqual([9, 7, 8, 6, 5]);
});

// Finds the stream_type of the first elementary stream in the first PMT of a transport stream
const getFirstPmtStreamType = (bytes: Uint8Array) => {
	let pmtPid: number | null = null;
	for (let pos = 0; pos + 188 <= bytes.length; pos += 188) {
		const pid = ((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!;
		const payloadUnitStart = (bytes[pos + 1]! & 0x40) !== 0;
		const adaptationFieldControl = (bytes[pos + 3]! >> 4) & 0b11;
		if (!payloadUnitStart || !(adaptationFieldControl & 0b01)) {
			continue; // No section starts in this packet
		}

		let payloadStart = pos + 4;
		if (adaptationFieldControl & 0b10) {
			payloadStart += 1 + bytes[payloadStart]!; // Skip the adaptation field
		}
		payloadStart += 1 + bytes[payloadStart]!; // Skip the pointer_field

		if (pid === 0 && pmtPid === null) {
			pmtPid = ((bytes[payloadStart + 10]! & 0x1f) << 8) | bytes[payloadStart + 11]!;
		} else if (pid === pmtPid) {
			const programInfoLength = ((bytes[payloadStart + 10]! & 0x0f) << 8) | bytes[payloadStart + 11]!;
			return bytes[payloadStart + 12 + programInfoLength]!;
		}
	}
	return null;
};

const muxMp3 = async (sampleRate: number) => {
	// MPEG-1 Layer III at 48 kHz (128 kbps, 384-byte frames) or MPEG-2 Layer III at 22.05 kHz (64 kbps, 208-byte
	// frames), mono
	const isMpeg2 = sampleRate < 32000;
	const header = isMpeg2 ? [0xff, 0xf3, 0x80, 0xc0] : [0xff, 0xfb, 0x94, 0xc0];
	const frameSize = isMpeg2 ? 208 : 384;
	const frameDuration = (isMpeg2 ? 576 : 1152) / sampleRate;

	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('mp3');
	output.addAudioTrack(source);
	await output.start();

	for (let i = 0; i < 4; i++) {
		const data = new Uint8Array(frameSize);
		data.set(header);
		await source.add(new EncodedPacket(data, 'key', i * frameDuration, frameDuration), {
			decoderConfig: { codec: 'mp3', numberOfChannels: 1, sampleRate },
		});
	}
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

test('MP3 below 32 kHz is declared as ISO/IEC 13818-3 audio (stream_type 0x04)', async () => {
	const lsf = await muxMp3(22050);
	expect(getFirstPmtStreamType(lsf)).toBe(0x04);

	const mpeg1 = await muxMp3(48000);
	expect(getFirstPmtStreamType(mpeg1)).toBe(0x03);

	using input = new Input({ source: new BufferSource(lsf), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	expect(await track?.getCodec()).toBe('mp3');
	expect(await track?.getSampleRate()).toBe(22050);
});

test('MPEG-TS keeps tracks in the order they were added', async () => {
	// Track A (stereo) is added before track B (mono), but B delivers its first packet first, as can happen with
	// concurrent encoders or conversions. The MP4, MOV and Matroska muxers keep the order the tracks were added in.
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const a = new EncodedAudioPacketSource('aac');
	const b = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(a);
	output.addAudioTrack(b);
	await output.start();

	const decoderConfig = (channels: number): AudioDecoderConfig => ({
		codec: 'mp4a.40.2',
		sampleRate: 48000,
		numberOfChannels: channels,
		description: new Uint8Array([0x11, 0x80 | (channels << 3)]),
	});
	const data = new Uint8Array([0x21, 0x10, 0x05, 0x00]);
	for (let i = 0; i < 10; i++) {
		const sources = i === 0 ? [[b, 1], [a, 2]] as const : [[a, 2], [b, 1]] as const;
		for (const [source, channels] of sources) {
			const packet = new EncodedPacket(data, 'key', i * 0.02, 0.02);
			await source.add(packet, i === 0 ? { decoderConfig: decoderConfig(channels) } : undefined);
		}
	}

	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const tracks = await input.getAudioTracks();
	expect(await Promise.all(tracks.map(track => track.getNumberOfChannels()))).toEqual([2, 1]);
	expect(tracks.map(track => track.id)).toEqual([0x100, 0x101]);
});

test('MPEG-TS muxing uses the decoder config a track declared up front', async () => {
	// A track can declare its decoder config when it's added, and then get its packets without metadata, as the other
	// muxers accept. Found by L66. Remuxes the first 10 packets of video.mp4's tracks (AVC with an avcC description,
	// AAC with an AudioSpecificConfig), with and without metadata on the first packet.
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	for (const type of ['video', 'audio'] as const) {
		const inputTrack = type === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
		const decoderConfig = await inputTrack!.getDecoderConfig();
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(inputTrack!).packets()) {
			packets.push(packet);
			if (packets.length === 10) {
				break;
			}
		}

		const outputs: Uint8Array[] = [];
		for (const withMetadata of [true, false]) {
			const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
			const source = type === 'video' ? new EncodedVideoPacketSource('avc') : new EncodedAudioPacketSource('aac');
			if (source instanceof EncodedVideoPacketSource) {
				output.addVideoTrack(source, { decoderConfig: decoderConfig as VideoDecoderConfig });
			} else {
				output.addAudioTrack(source, { decoderConfig: decoderConfig as AudioDecoderConfig });
			}
			await output.start();

			for (const [i, packet] of packets.entries()) {
				const meta = withMetadata && i === 0 ? { decoderConfig } : undefined;
				if (source instanceof EncodedVideoPacketSource) {
					await source.add(packet, meta as EncodedVideoChunkMetadata | undefined);
				} else {
					await source.add(packet, meta as EncodedAudioChunkMetadata | undefined);
				}
			}
			await output.finalize();
			outputs.push(new Uint8Array(output.target.buffer!));

			using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
			const track = (await result.getTracks())[0];
			expect(await track!.getCodec()).toBe(type === 'video' ? 'avc' : 'aac');

			const timestamps: number[] = [];
			for await (const packet of new EncodedPacketSink(track!).packets()) {
				timestamps.push(packet.timestamp);
			}
			expect(timestamps).toEqual(packets.map(x => x.timestamp));
		}

		// The same file either way
		expect(outputs[1]).toEqual(outputs[0]);
	}
});

test('MPEG-TS muxing knows its tracks from the decoder configs declared with them', async () => {
	// Like the other muxers, right after start(): getMimeType() resolves (it waited for a packet on every track), and
	// the PMT lists the tracks even if they get no packets
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	output.addVideoTrack(new EncodedVideoPacketSource('avc'), {
		decoderConfig: {
			codec: 'avc1.64001f',
			codedWidth: 320,
			codedHeight: 240,
			// avcC with a 4-byte dummy SPS (high profile, level 3.1) and a 2-byte PPS
			description: new Uint8Array([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x1f, 1, 0, 2, 0x68, 0xee]),
		},
	});
	output.addAudioTrack(new EncodedAudioPacketSource('aac'), {
		decoderConfig: {
			codec: 'mp4a.40.2',
			numberOfChannels: 2,
			sampleRate: 48000,
			description: new Uint8Array([0x11, 0x90]),
		},
	});
	await output.start();

	const timeout = new Promise<string>(resolve => setTimeout(() => resolve('unresolved after 500 ms'), 500));
	// (MIME types are case-insensitive: #619 lowercases the type)
	const mimeType = await Promise.race([output.getMimeType(), timeout]);
	expect(mimeType.toLowerCase()).toBe('video/mp2t; codecs="avc1.64001f, mp4a.40.2"');

	await output.finalize();

	// The stream types in the PMT (on PID 0x1000, in one TS packet)
	const bytes = new Uint8Array(output.target.buffer!);
	let streamTypes: number[] | null = null;
	for (let pos = 0; pos < bytes.length && !streamTypes; pos += 188) {
		if ((((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!) === 0x1000) {
			const section = pos + 5 + bytes[pos + 4]!; // After the pointer_field
			const sectionEnd = section + 3 + (((bytes[section + 1]! & 0x0f) << 8) | bytes[section + 2]!) - 4;
			streamTypes = [];
			let entry = section + 12 + (((bytes[section + 10]! & 0x0f) << 8) | bytes[section + 11]!);
			while (entry < sectionEnd) {
				streamTypes.push(bytes[entry]!);
				entry += 5 + (((bytes[entry + 3]! & 0x0f) << 8) | bytes[entry + 4]!);
			}
		}
	}
	expect(streamTypes).toEqual([0x1b, 0x0f]); // AVC, AAC
});

/** Reads the PMT's PCR_PID and streams, the PCRs, and the PES timestamps of a transport stream, in file order. */
const readTransportStream = (data: Uint8Array) => {
	let pcrPid: number | null = null;
	const esPids = new Set<number>();
	const events: ({ type: 'pcr'; value: number } | { type: 'pes'; pid: number; pts: number; dts: number })[] = [];
	let mediaBeforeFirstPcr = false;
	let continuityErrors = 0;
	const lastCounters = new Map<number, number>();
	// Per PID, the indices (among the PID's packets) of the packets with discontinuity_indicator set
	const discontinuities = new Map<number, number[]>();
	const packetCounts = new Map<number, number>();

	const readTimestamp = (pos: number) => ((data[pos]! >> 1) & 0x07) * 2 ** 30
		+ (((data[pos + 1]! << 8) | data[pos + 2]!) >> 1) * 2 ** 15
		+ (((data[pos + 3]! << 8) | data[pos + 4]!) >> 1);

	for (let pos = 0; pos + 188 <= data.length; pos += 188) {
		const pid = ((data[pos + 1]! & 0x1f) << 8) | data[pos + 2]!;
		const hasAdaptationField = (data[pos + 3]! & 0x20) !== 0;
		const hasPayload = (data[pos + 3]! & 0x10) !== 0;
		const payloadStart = pos + 4 + (hasAdaptationField ? 1 + data[pos + 4]! : 0);

		// A packet without payload repeats the counter of the previous one, a packet with payload increments it
		const packetIndex = packetCounts.get(pid) ?? 0;
		packetCounts.set(pid, packetIndex + 1);
		if (hasAdaptationField && data[pos + 4]! > 0 && data[pos + 5]! & 0x80) {
			discontinuities.set(pid, [...discontinuities.get(pid) ?? [], packetIndex]);
		}

		const counter = data[pos + 3]! & 0x0f;
		const lastCounter = lastCounters.get(pid);
		if (lastCounter !== undefined && counter !== (hasPayload ? (lastCounter + 1) & 0x0f : lastCounter)) {
			continuityErrors++;
		}
		lastCounters.set(pid, counter);

		if (pid === 0x1000 && data[pos + 1]! & 0x40) {
			const section = payloadStart + 1 + data[payloadStart]!; // After the pointer_field
			pcrPid = ((data[section + 8]! & 0x1f) << 8) | data[section + 9]!;
			const sectionEnd = section + 3 + (((data[section + 1]! & 0x0f) << 8) | data[section + 2]!) - 4;
			let entry = section + 12 + (((data[section + 10]! & 0x0f) << 8) | data[section + 11]!);
			while (entry < sectionEnd) {
				esPids.add(((data[entry + 1]! & 0x1f) << 8) | data[entry + 2]!);
				entry += 5 + (((data[entry + 3]! & 0x0f) << 8) | data[entry + 4]!);
			}
			continue;
		}

		if (pid === pcrPid && hasAdaptationField && data[pos + 4]! > 0 && data[pos + 5]! & 0x10) {
			// program_clock_reference_base (33 bits)
			const base = pos + 6;
			events.push({
				type: 'pcr',
				value: data[base]! * 2 ** 25 + data[base + 1]! * 2 ** 17 + data[base + 2]! * 2 ** 9
					+ data[base + 3]! * 2 + (data[base + 4]! >> 7),
			});
		}

		if (esPids.has(pid) && hasPayload) {
			if (!events.some(x => x.type === 'pcr')) {
				mediaBeforeFirstPcr = true;
			}

			if (data[pos + 1]! & 0x40) {
				const pts = readTimestamp(payloadStart + 9);
				const dts = (data[payloadStart + 7]! & 0x40) ? readTimestamp(payloadStart + 14) : pts;
				events.push({ type: 'pes', pid, pts, dts });
			}
		}
	}

	return { pcrPid, esPids, events, mediaBeforeFirstPcr, continuityErrors, discontinuities };
};

test('MPEG-TS output carries PCRs on the PMT\'s PCR_PID before and between media data', async () => {
	// Found by L74. 5 fps video and 50 Hz audio, so that PCRs are needed between the video frames, then video with
	// B-frames (two GOPs in decode order), whose frames go out after audio presented before them
	const avc = new Uint8Array([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x10]);
	const adts = new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0x01, 0x3f, 0xfc, 0x21, 0x00]);
	const videoDecoderConfig = { codec: 'avc1.42001f', codedWidth: 64, codedHeight: 64 };
	const audioDecoderConfig = { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000 };
	const bFrameOrder = [0, 3, 1, 2, 6, 4, 5, 7, 10, 8, 9];

	for (const hasBFrames of [false, true]) {
		const output = new Output({
			format: new MpegTsOutputFormat({ timestampOffset: 1 }),
			target: new BufferTarget(),
		});
		const videoSource = new EncodedVideoPacketSource('avc');
		const audioSource = new EncodedAudioPacketSource('aac');
		output.addVideoTrack(videoSource);
		output.addAudioTrack(audioSource);
		await output.start();

		if (hasBFrames) {
			for (const [i, frame] of bFrameOrder.entries()) {
				const isKey = i === 0 || i === 7;
				const packet = new EncodedPacket(avc, isKey ? 'key' : 'delta', frame / 25, 1 / 25);
				await videoSource.add(packet, i === 0 ? { decoderConfig: videoDecoderConfig } : undefined);
			}
			// Starting before the video (like AAC with priming), so that the video PID begins with a packet with just
			// a PCR
			for (let i = 0; i < 22; i++) {
				const packet = new EncodedPacket(adts, 'key', (i - 1) / 50, 0.02);
				await audioSource.add(packet, i === 0 ? { decoderConfig: audioDecoderConfig } : undefined);
			}
		} else {
			for (let i = 0; i < 500; i++) {
				if (i % 10 === 0) {
					// 5 fps, frames 200 ms apart
					const packet = new EncodedPacket(avc, i % 100 === 0 ? 'key' : 'delta', i / 50, 0.2);
					await videoSource.add(packet, i === 0 ? { decoderConfig: videoDecoderConfig } : undefined);
				}

				const packet = new EncodedPacket(adts, 'key', i / 50, 0.02);
				await audioSource.add(packet, i === 0 ? { decoderConfig: audioDecoderConfig } : undefined);
			}
		}

		await output.finalize();

		const { pcrPid, esPids, events, mediaBeforeFirstPcr, continuityErrors, discontinuities } = readTransportStream(
			new Uint8Array(output.target.buffer!),
		);
		expect(esPids.size).toBe(2);
		expect(pcrPid).toBe(0x100); // The video track's
		expect(esPids.has(pcrPid!)).toBe(true);
		expect(mediaBeforeFirstPcr).toBe(false); // W3C MSE MPEG-2 TS byte stream format, section 5
		expect(continuityErrors).toBe(0);
		// Only each PID's first packet has discontinuity_indicator set, also when it's a packet with just a PCR
		expect([...esPids].map(pid => discontinuities.get(pid))).toEqual([[0], [0]]);

		const pcrs = events.filter(x => x.type === 'pcr').map(x => x.value);
		expect(pcrs.length).toBeGreaterThan(0);
		for (let i = 1; i < pcrs.length; i++) {
			expect(pcrs[i]! - pcrs[i - 1]!).toBeGreaterThanOrEqual(0);
			expect(pcrs[i]! - pcrs[i - 1]!).toBeLessThanOrEqual(0.1 * 90000); // H.222.0 2.7.2
		}

		// The data of every PES packet arrives (by the last PCR before it) before its decode time
		let lastPcr = -Infinity;
		for (const event of events) {
			if (event.type === 'pcr') {
				lastPcr = event.value;
			} else {
				expect(lastPcr).toBeLessThanOrEqual(event.dts);
			}
		}
	}
});
