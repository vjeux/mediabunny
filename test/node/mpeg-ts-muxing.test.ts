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
import { EncodedVideoPacketSource } from '../../src/media-source.js';
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
import { EncodedAudioPacketSource } from '../../src/media-source.js';

// Finds the stream_type of the first elementary stream in the first PMT of a transport stream
const getFirstPmtStreamType = (bytes: Uint8Array) => {
	let pmtPid: number | null = null;
	for (let pos = 0; pos + 188 <= bytes.length; pos += 188) {
		const pid = ((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!;
		const payloadStart = pos + 4 + 1 + bytes[pos + 4]!; // Skip the header and the pointer_field
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
