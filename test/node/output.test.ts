import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat, MpegTsOutputFormat, OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource, FilePathSource, Source } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import {
	AvcNalUnitType,
	concatNalUnitsInLengthPrefixed,
	deserializeAvcDecoderConfigurationRecord,
	extractNalUnitTypeForAvc,
	iterateAvcNalUnits,
} from '../../src/codec-data.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Output, onFinalize', async () => {
	let callCount = 0;
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
		onFinalize: async () => {
			await new Promise(resolve => setTimeout(resolve, 200));

			callCount++;
		},
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.5), {
		decoderConfig: {
			codec: 'avc1.640028',
			codedWidth: 1920,
			codedHeight: 1080,
		},
	});

	await output.finalize();

	expect(callCount).toBe(1);
});

const readAvcTrack = async (source: Source) => {
	using input = new Input({ source, formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const decoderConfig = (await track.getDecoderConfig())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	return { decoderConfig, packets };
};

const readAvcClip = (name: string) => readAvcTrack(new FilePathSource(path.join(__dirname, '..', 'public', name)));

const getNalUnits = (packet: EncodedPacket, decoderConfig: VideoDecoderConfig) => {
	return [...iterateAvcNalUnits(packet.data, decoderConfig)]
		.map(loc => packet.data.subarray(loc.offset, loc.offset + loc.length))
		.filter(nalUnit => extractNalUnitTypeForAvc(nalUnit[0]!) !== AvcNalUnitType.AUD);
};

const isParameterSet = (nalUnit: Uint8Array) => {
	const type = extractNalUnitTypeForAvc(nalUnit[0]!);
	return type === AvcNalUnitType.SPS || type === AvcNalUnitType.PPS;
};

const muxAvcClipsAndReadBack = async (
	format: OutputFormat,
	first: Awaited<ReturnType<typeof readAvcClip>>,
	second: Awaited<ReturnType<typeof readAvcClip>>,
) => {
	const output = new Output({ format, target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, { frameRate: 10 });
	await output.start();

	for (const [i, packet] of first.packets.entries()) {
		await source.add(packet, i === 0 ? { decoderConfig: first.decoderConfig } : undefined);
	}
	// Like a WebCodecs encoder replaced mid-stream: the new parameter sets come only in the new decoder config
	for (const [i, packet] of second.packets.entries()) {
		await source.add(
			packet.clone({ timestamp: packet.timestamp + 1 }),
			i === 0 ? { decoderConfig: second.decoderConfig } : undefined,
		);
	}

	await output.finalize();

	return readAvcTrack(new BufferSource(output.target.buffer!));
};

test('Muxers keep the parameter sets of a mid-stream AVC decoder config change', async () => {
	// ffmpeg -f lavfi -i testsrc2=size=64x64:rate=10 -t 1 -c:v libx264 -profile:v high -bf 0 -g 5 -pix_fmt yuv420p
	//   -an -map_metadata -1 -fflags +bitexact avc-config-change-high.mp4
	const first = await readAvcClip('avc-config-change-high.mp4');
	// ffmpeg -f lavfi -i testsrc=size=64x64:rate=10 -t 1 -c:v libx264 -profile:v baseline -g 5 -pix_fmt yuv420p
	//   -an -map_metadata -1 -fflags +bitexact avc-config-change-baseline.mp4
	const second = await readAvcClip('avc-config-change-baseline.mp4');

	const firstRecord = deserializeAvcDecoderConfigurationRecord(first.decoderConfig.description as Uint8Array)!;
	const secondRecord = deserializeAvcDecoderConfigurationRecord(second.decoderConfig.description as Uint8Array)!;
	const firstParameterSets = [...firstRecord.sequenceParameterSets, ...firstRecord.pictureParameterSets];
	const secondParameterSets = [...secondRecord.sequenceParameterSets, ...secondRecord.pictureParameterSets];
	expect(secondParameterSets).not.toEqual(firstParameterSets);

	const formats: OutputFormat[] = [
		new Mp4OutputFormat(),
		new Mp4OutputFormat({ fastStart: 'fragmented' }),
		new MkvOutputFormat(),
		new MpegTsOutputFormat(),
	];

	for (const format of formats) {
		const { decoderConfig, packets } = await muxAvcClipsAndReadBack(format, first, second);
		expect(packets).toHaveLength(first.packets.length + second.packets.length);

		for (const [i, packet] of packets.entries()) {
			const isSecond = i >= first.packets.length;
			const original = isSecond ? second.packets[i - first.packets.length]! : first.packets[i]!;
			const originalConfig = isSecond ? second.decoderConfig : first.decoderConfig;
			const nalUnits = getNalUnits(packet, decoderConfig);
			const parameterSets = nalUnits.filter(isParameterSet);
			const otherNalUnits = nalUnits.filter(x => !isParameterSet(x));

			// The slices and SEI are untouched
			expect(otherNalUnits).toEqual(getNalUnits(original, originalConfig));

			if (packet.type === 'delta') {
				expect(parameterSets).toEqual([]);
			} else if (isSecond) {
				// Every key frame decoded with the new config carries it, so decoding can also start there
				expect(parameterSets).toEqual(secondParameterSets);
			} else {
				// MPEG-TS repeats the parameter sets in front of every key frame, the others hold them out of band
				expect(parameterSets).toEqual(format instanceof MpegTsOutputFormat ? firstParameterSets : []);
			}
		}
	}
});

test('Muxers reject a decoder config change whose NAL units exceed the track\'s NAL unit length size', async () => {
	const { decoderConfig } = await readAvcClip('avc-config-change-baseline.mp4');
	const record = deserializeAvcDecoderConfigurationRecord(decoderConfig.description as Uint8Array)!;
	const parameterSets = [...record.sequenceParameterSets, ...record.pictureParameterSets];

	// The same config with another lengthSizeMinusOne
	const withLengthSize = (lengthSize: number): VideoDecoderConfig => {
		const description = new Uint8Array(decoderConfig.description as Uint8Array);
		description[4] = 0xfc | (lengthSize - 1);
		return { ...decoderConfig, description };
	};
	const slice = (size: number) => {
		const nalUnit = new Uint8Array(size).fill(0xaa);
		nalUnit[0] = 0x65; // IDR slice
		return nalUnit;
	};

	for (const createFormat of [() => new Mp4OutputFormat(), () => new MkvOutputFormat()]) {
		for (const lengthSize of [1, 2]) {
			const output = new Output({ format: createFormat(), target: new BufferTarget() });
			const source = new EncodedVideoPacketSource('avc');
			output.addVideoTrack(source, { frameRate: 10 });
			await output.start();

			await source.add(
				new EncodedPacket(concatNalUnitsInLengthPrefixed([slice(100)], lengthSize as 1 | 2), 'key', 0, 0.1),
				{ decoderConfig: withLengthSize(lengthSize) },
			);
			// The new config uses 4-byte lengths and comes with a 300-byte NAL unit
			const added = source.add(
				new EncodedPacket(concatNalUnitsInLengthPrefixed([slice(300)], 4), 'key', 0.1, 0.1),
				{ decoderConfig: withLengthSize(4) },
			);

			if (lengthSize === 1) {
				// 300 doesn't fit the track's 1-byte length fields; it must not be written truncated
				await expect(added).rejects.toThrow('A 300-byte NAL unit doesn\'t fit the 1-byte NAL unit');
				await output.cancel();
			} else {
				await added;
				await output.finalize();

				const { decoderConfig: writtenConfig, packets } = await readAvcTrack(
					new BufferSource(output.target.buffer!),
				);
				expect(getNalUnits(packets[1]!, writtenConfig).map(x => x.byteLength))
					.toEqual([...parameterSets.map(x => x.byteLength), 300]);
			}
		}
	}
});
