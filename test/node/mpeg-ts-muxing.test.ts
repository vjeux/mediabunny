import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

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
