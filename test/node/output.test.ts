import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Output } from '../../src/output.js';
import {
	CmafOutputFormat,
	HlsOutputFormat,
	MkvOutputFormat,
	MovOutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	OggOutputFormat,
	OutputFormat,
} from '../../src/output-format.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { BufferSource, CustomPathedSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';
import { countMovedArrayElements } from './array-moves.js';
import {
	AvcNalUnitType,
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

// Annex B access units: SPS + PPS + IDR slice, and a non-IDR slice
const AVC_KEY_FRAME = new Uint8Array([
	0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x0a, 0xd9, 0x06, 0x26, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03,
	0x00, 0xf0, 0x3c, 0x48, 0x99, 0x20,
	0, 0, 0, 1, 0x68, 0xcb, 0x83, 0xcb, 0x20,
	0, 0, 0, 1, 0x65, 0x88, 0x84, 0x10, 0x20, 0x40, 0x80, 0x01,
]);
const AVC_DELTA_FRAME = new Uint8Array([0, 0, 0, 1, 0x41, 0x9a, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40]);

test('frameRate snaps video timestamps to the frame grid in every timestamped format', async () => {
	const frameRate = 30000 / 1001;
	const jitter = [0, 0.004, -0.003, 0.006, 0.002];
	const formats = [
		new Mp4OutputFormat(),
		new Mp4OutputFormat({ fastStart: 'fragmented' }),
		new MovOutputFormat(),
		new MkvOutputFormat(),
		new MpegTsOutputFormat(),
	];

	for (const format of formats) {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source, { frameRate });
		await output.start();

		for (let i = 0; i < jitter.length; i++) {
			await source.add(
				new EncodedPacket(
					i === 0 ? AVC_KEY_FRAME : AVC_DELTA_FRAME,
					i === 0 ? 'key' : 'delta',
					i / frameRate + jitter[i]!,
					1 / frameRate,
				),
				i === 0 ? { decoderConfig: { codec: 'avc1.42c00a', codedWidth: 96, codedHeight: 64 } } : undefined,
			);
		}

		await output.finalize();

		const input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			timestamps.push(packet.timestamp);
		}
		input.dispose();

		// Within the container's precision (milliseconds for Matroska) of the frame grid
		expect(timestamps.map((timestamp, i) => Math.abs(timestamp - i / frameRate) < 0.0006), format._name)
			.toEqual(jitter.map(() => true));
	}
});

test('frameRate snapping in HLS keeps video in sync with audio', async () => {
	for (const frameRate of [30, 30000 / 1001]) {
		for (const segmentFormat of [new CmafOutputFormat(), new MpegTsOutputFormat()]) {
			const files = new Map<string, BufferTarget>();
			const output = new Output({
				format: new HlsOutputFormat({ segmentFormat }),
				target: new PathedTarget('master.m3u8', ({ path }) => {
					const target = new BufferTarget();
					files.set(path, target);
					return target;
				}),
			});

			const videoSource = new EncodedVideoPacketSource('avc');
			output.addVideoTrack(videoSource, { frameRate });
			const audioSource = new EncodedAudioPacketSource('aac');
			output.addAudioTrack(audioSource);
			await output.start();

			// The audio starts 5 ms before the video, so the media timeline is shifted by an off-grid amount
			await audioSource.add(new EncodedPacket(new Uint8Array(64), 'key', -0.005, 1024 / 48000), {
				decoderConfig: {
					codec: 'mp4a.40.2',
					numberOfChannels: 2,
					sampleRate: 48000,
					description: new Uint8Array([0x11, 0x90]),
				},
			});
			for (let i = 0; i < 3; i++) {
				await videoSource.add(
					new EncodedPacket(
						i === 0 ? AVC_KEY_FRAME : AVC_DELTA_FRAME,
						i === 0 ? 'key' : 'delta',
						i / frameRate,
						1 / frameRate,
					),
					i === 0 ? { decoderConfig: { codec: 'avc1.42c00a', codedWidth: 96, codedHeight: 64 } } : undefined,
				);
			}

			await output.finalize();

			const input = new Input({
				source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(files.get(path)!.buffer!)),
				formats: ALL_FORMATS,
			});
			const videoTrack = await input.getPrimaryVideoTrack();
			const audioTrack = await input.getPrimaryAudioTrack();
			assert(videoTrack && audioTrack);

			const videoStart = (await new EncodedPacketSink(videoTrack).getFirstPacket())!.timestamp;
			const audioStart = (await new EncodedPacketSink(audioTrack).getFirstPacket())!.timestamp;
			input.dispose();

			expect(videoStart - audioStart).toBeCloseTo(0.005, 4);
		}
	}
});

test('Muxers write out a track queued far ahead of the others in linear time', async () => {
	// Adding one track's packets before the other's (as the docs suggest when interleaving isn't possible) queues them
	// all; they used to be taken off the queue with Array.prototype.shift(), which copies the whole queue each time.
	const count = 100_000;
	const avcConfig = {
		codec: 'avc1.42c01e',
		codedWidth: 32,
		codedHeight: 32,
		description: new Uint8Array([
			0x01, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x0a, 0x67, 0x42, 0xc0, 0x1e, 0xda, 0x02, 0x80, 0xbf, 0xe5, 0x84,
			0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80,
		]),
	};
	const aacConfig = {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		description: new Uint8Array([0x11, 0x90]),
	};
	const opusConfig = {
		codec: 'opus',
		numberOfChannels: 2,
		sampleRate: 48000,
		// 'OpusHead', version 1, 2 channels, pre-skip 312, 48 kHz
		description: new Uint8Array([
			0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0,
		]),
	};
	const opusPacket = new Uint8Array([0xfc, 0xff, 0xfe]); // 20 ms

	const formats = [new Mp4OutputFormat(), new MkvOutputFormat(), new MpegTsOutputFormat(), new OggOutputFormat()];
	for (const format of formats) {
		// Ogg holds no video, so it gets two Opus tracks
		const withVideo = !(format instanceof OggOutputFormat);
		const output = new Output({ format, target: new BufferTarget() });
		const videoSource = new EncodedVideoPacketSource('avc');
		const firstAudioSource = new EncodedAudioPacketSource('opus');
		const secondAudioSource = new EncodedAudioPacketSource(withVideo ? 'aac' : 'opus');
		if (withVideo) {
			output.addVideoTrack(videoSource);
		} else {
			output.addAudioTrack(firstAudioSource);
		}
		output.addAudioTrack(secondAudioSource);
		await output.start();

		const frameDuration = withVideo ? 1 / 30 : 0.02;
		const movedElements = await countMovedArrayElements(async () => {
			for (let i = 0; i < count; i++) {
				if (withVideo) {
					const type = i % 30 === 0 ? 'key' : 'delta';
					await videoSource.add(
						new EncodedPacket(new Uint8Array(8), type, i * frameDuration, frameDuration),
						i === 0 ? { decoderConfig: avcConfig } : undefined,
					);
				} else {
					await firstAudioSource.add(
						new EncodedPacket(opusPacket, 'key', i * frameDuration, frameDuration),
						i === 0 ? { decoderConfig: opusConfig } : undefined,
					);
				}
			}

			// A packet of the other track past all of them lets the muxer write out the whole queue
			await secondAudioSource.add(
				new EncodedPacket(withVideo ? new Uint8Array(8) : opusPacket, 'key', count * frameDuration, 0.02),
				{ decoderConfig: withVideo ? aacConfig : opusConfig },
			);
			await output.finalize();
		});

		// Linear: no per-packet copies of the queue (main moved ~5e9 elements per format)
		expect(movedElements).toBeLessThan(2 * count);
	}
});

test('Output validates initTarget and isRelativeToUnixEpoch like its other options', () => {
	expect(() => new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
		initTarget: 'init.mp4' as never,
	})).toThrow(new TypeError(
		'options.initTarget, when provided, must be a Target or a function that returns or resolves to a Target.',
	));

	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	for (const isRelativeToUnixEpoch of ['false', 1, null]) {
		expect(() => output.addVideoTrack(new EncodedVideoPacketSource('avc'), {
			isRelativeToUnixEpoch: isRelativeToUnixEpoch as never,
		})).toThrow(new TypeError('metadata.isRelativeToUnixEpoch, when provided, must be a boolean.'));
	}
	expect(output.tracks).toHaveLength(0);
});

test.each([
	['Matroska', () => new MkvOutputFormat()],
	['Ogg', () => new OggOutputFormat()],
])('%s: a track closed while its only packet is still queued is kept', async (_, makeFormat) => {
	const target = new BufferTarget();
	const output = new Output({ format: makeFormat(), target });
	const sources = [0, 1, 2].map(() => new EncodedAudioPacketSource('opus'));
	for (const source of sources) {
		output.addAudioTrack(source);
	}
	await output.start();

	// OpusHead: version 1, 2 channels, 312 samples of pre-skip, 48 kHz, no gain, channel mapping family 0
	const description = new Uint8Array([
		...new TextEncoder().encode('OpusHead'), 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0,
	]);
	const meta = { decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000, description } };
	// TOC byte 0xfc: one 20 ms stereo CELT frame
	const packet = (index: number) => new EncodedPacket(new Uint8Array([0xfc, 1, 2, 3]), 'key', index * 0.02, 0.02);

	// None of these are awaited: the first track gets ahead, then the third track's first packet and the second
	// track's only packet are queued, and the second track is closed right away
	const pending: Promise<void>[] = [];
	for (let i = 0; i < 10; i++) {
		pending.push(sources[0]!.add(packet(i), i === 0 ? meta : undefined));
	}
	pending.push(sources[2]!.add(packet(0), meta));
	pending.push(sources[1]!.add(packet(0), meta));
	sources[1]!.close();
	for (let i = 1; i < 10; i++) {
		pending.push(sources[2]!.add(packet(i)));
	}
	await Promise.all(pending);
	await output.finalize();

	using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	const packetCounts: number[] = [];
	for (const track of await input.getTracks()) {
		let count = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			void packet;
			count++;
		}
		packetCounts.push(count);
	}

	expect(packetCounts.sort((a, b) => a - b)).toEqual([1, 10, 10]);
});

const readAvcClip = async (name: string) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public', name)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const decoderConfig = (await track.getDecoderConfig())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	return { decoderConfig, packets };
};

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

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const decoderConfig = (await track.getDecoderConfig())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	return { decoderConfig, packets };
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
