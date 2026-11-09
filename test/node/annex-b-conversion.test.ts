import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import {
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
	iterateAvcNalUnits,
	iterateHevcNalUnits,
} from '../../src/codec-data.js';
import { toUint8Array } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Annex B to length-prefixed conversion, MP4', async () => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/annex-b-avc.mkv')),
		formats: ALL_FORMATS,
	});
	const originalVideoTrack = (await originalInput.getPrimaryVideoTrack())!;
	const originalDecoderConfig = (await originalVideoTrack.getDecoderConfig())!;
	expect(originalDecoderConfig.description).toBeUndefined();
	expect(await originalVideoTrack.getCodec()).toBe('avc');

	const originalSink = new EncodedPacketSink(originalVideoTrack);
	const originalFirstPacket = await originalSink.getFirstPacket();
	expect([...originalFirstPacket!.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);

	const originalNalUnits = [...iterateAvcNalUnits(originalFirstPacket!.data, originalDecoderConfig)]
		.map(loc => originalFirstPacket!.data.subarray(loc.offset, loc.offset + loc.length));

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input: originalInput, output });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const newVideoTrack = (await newInput.getPrimaryVideoTrack())!;
	const newDecoderConfig = (await newVideoTrack.getDecoderConfig())!;
	expect(newDecoderConfig.description).toBeDefined();
	expect(await newVideoTrack.getCodec()).toBe('avc');

	const newSink = new EncodedPacketSink(newVideoTrack);
	const newFirstPacket = await newSink.getFirstPacket();
	expect([...newFirstPacket!.data.slice(0, 4)]).not.toEqual([0, 0, 0, 1]); // Successfully converted

	const newNalUnits = [...iterateAvcNalUnits(newFirstPacket!.data, newDecoderConfig)]
		.map(loc => newFirstPacket!.data.subarray(loc.offset, loc.offset + loc.length));
	expect(newNalUnits).toEqual(originalNalUnits); // Content is the same though
});

// The Matroska codec mappings store V_MPEG4/ISO/AVC and V_MPEGH/ISO/HEVC length-prefixed, with the decoder
// configuration record in CodecPrivate (WebKit's Matroska parser drops H.264 tracks without it). The record comes from
// the first packet, also when the decoder config was given to addVideoTrack ahead of time.
test.each([
	['annex-b-avc.mkv', 'avc', 'conversion'],
	['hevc.ts', 'hevc', 'conversion'],
	['annex-b-avc.mkv', 'avc', 'decoder config ahead of time'],
	['hevc.ts', 'hevc', 'decoder config ahead of time'],
] as const)('Annex B to length-prefixed conversion, Matroska (%s, %s, %s)', async (fileName, codec, mode) => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public', fileName)),
		formats: ALL_FORMATS,
	});
	const originalVideoTrack = (await originalInput.getPrimaryVideoTrack())!;
	const originalDecoderConfig = (await originalVideoTrack.getDecoderConfig())!;
	expect(originalDecoderConfig.description).toBeUndefined();
	expect(await originalVideoTrack.getCodec()).toBe(codec);

	const iterateNalUnits = codec === 'avc' ? iterateAvcNalUnits : iterateHevcNalUnits;
	const originalFirstPacket = (await new EncodedPacketSink(originalVideoTrack).getFirstPacket())!;
	const originalNalUnits = [...iterateNalUnits(originalFirstPacket.data, originalDecoderConfig)]
		.map(loc => originalFirstPacket.data.subarray(loc.offset, loc.offset + loc.length));

	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	if (mode === 'conversion') {
		const conversion = await Conversion.init({ input: originalInput, output, audio: { discard: true } });
		await conversion.execute();
	} else {
		const source = new EncodedVideoPacketSource(codec);
		output.addVideoTrack(source, { decoderConfig: originalDecoderConfig });
		await output.start();

		let packetCount = 0;
		for await (const packet of new EncodedPacketSink(originalVideoTrack).packets()) {
			await source.add(packet);
			if (++packetCount === 10) {
				break;
			}
		}

		await output.finalize();
	}

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const newVideoTrack = (await newInput.getPrimaryVideoTrack())!;
	const newDecoderConfig = (await newVideoTrack.getDecoderConfig())!;
	expect(newDecoderConfig.description).toBeDefined();
	expect(newDecoderConfig.codec).toBe(originalDecoderConfig.codec);

	const description = toUint8Array(newDecoderConfig.description!);
	const record = codec === 'avc'
		? deserializeAvcDecoderConfigurationRecord(description)
		: deserializeHevcDecoderConfigurationRecord(description);
	expect(record).not.toBeNull();

	const newFirstPacket = (await new EncodedPacketSink(newVideoTrack).getFirstPacket())!;
	expect([...newFirstPacket.data.slice(0, 4)]).not.toEqual([0, 0, 0, 1]);

	const newNalUnits = [...iterateNalUnits(newFirstPacket.data, newDecoderConfig)]
		.map(loc => newFirstPacket.data.subarray(loc.offset, loc.offset + loc.length));
	expect(newNalUnits).toEqual(originalNalUnits);
});
