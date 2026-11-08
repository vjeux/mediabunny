import { describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { AdtsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';

// Tests for reading and writing ADTS (ISO/IEC 13818-7 and 14496-3, see https://wiki.multimedia.cx/index.php/ADTS),
// with frames built bit by bit. Payloads are opaque to the (de)muxer, so they're just filler bytes.

type Bytes = number[] | Uint8Array;

const concat = (...parts: Bytes[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
};

const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

const writeBits = (fields: [number, number][]) => {
	const bitCount = fields.reduce((sum, [bits]) => sum + bits, 0);
	const bytes = new Uint8Array(bitCount / 8);
	let pos = 0;
	for (const [bits, value] of fields) {
		for (let i = bits - 1; i >= 0; i--, pos++) {
			bytes[pos >> 3]! |= ((value >> i) & 1) << (7 - (pos & 7));
		}
	}
	return bytes;
};

type FrameOptions = {
	mpeg2?: boolean;
	profile?: number; // Object type - 1
	sampleRateIndex?: number;
	channelConfiguration?: number;
	payload?: Bytes;
	crc?: boolean;
	bufferFullness?: number;
};

const adtsHeader = (options: FrameOptions, frameLength: number) => writeBits([
	[12, 0xfff], // Syncword
	[1, options.mpeg2 ? 1 : 0], // ID
	[2, 0], // Layer
	[1, options.crc ? 0 : 1], // Protection absent
	[2, options.profile ?? 1],
	[4, options.sampleRateIndex ?? 4],
	[1, 0], // Private bit
	[3, options.channelConfiguration ?? 2],
	[1, 0], // Original/copy
	[1, 0], // Home
	[1, 0], // Copyright identification bit
	[1, 0], // Copyright identification start
	[13, frameLength],
	[11, options.bufferFullness ?? 0x7ff],
	[2, 0], // Number of raw data blocks minus 1
	...(options.crc ? [[16, 0x1234]] as [number, number][] : []),
]);

const adtsFrame = (options: FrameOptions = {}) => {
	const payload = options.payload ?? new Uint8Array(100).fill(0x21);
	const headerSize = options.crc ? 9 : 7;
	return concat(adtsHeader(options, headerSize + payload.length), payload);
};

const adtsFrames = (count: number, options: FrameOptions = {}) =>
	concat(...Array.from({ length: count }, () => adtsFrame(options)));

const open = (bytes: Uint8Array) => new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

const readPackets = async (input: Input) => {
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink((await input.getPrimaryAudioTrack())!).packets()) {
		packets.push(packet);
	}
	return packets;
};

describe('ADTS frame headers', () => {
	test('reads the object type, sample rate and channel count from the header', async () => {
		for (const profile of [0, 1, 2, 3]) {
			for (const [sampleRateIndex, sampleRate] of SAMPLE_RATES.entries()) {
				const channelCounts = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 8]];
				for (const [channelConfiguration, channels] of channelCounts) {
					using input = open(adtsFrames(2, { profile, sampleRateIndex, channelConfiguration }));
					const track = (await input.getPrimaryAudioTrack())!;

					expect(await input.getFormat()).toBe(ADTS);
					expect(await track.getCodec()).toBe('aac');
					expect(await track.getInternalCodecId()).toBe(profile + 1);
					expect(await track.getSampleRate()).toBe(sampleRate);
					expect(await track.getNumberOfChannels()).toBe(channels);
					// Without a description, the packets are ADTS frames
					expect(await track.getDecoderConfig()).toEqual({
						codec: `mp4a.40.${profile + 1}`,
						numberOfChannels: channels,
						sampleRate,
					});
				}
			}
		}
	});

	test('reads MPEG-2 ADTS just like MPEG-4 ADTS', async () => {
		using input = open(adtsFrames(3, { mpeg2: true, sampleRateIndex: 3 }));
		const track = (await input.getPrimaryAudioTrack())!;

		expect(await track.getDecoderConfig()).toEqual({ codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000 });
		expect(await readPackets(input)).toHaveLength(3);
	});

	test('emits whole frames, including the CRC, as packets of 1024 samples', async () => {
		const frameSizes = [100, 7, 345, 60];
		const stream = concat(...frameSizes.map((size, i) => adtsFrame({
			payload: new Uint8Array(size).fill(i + 1),
			crc: i % 2 === 1,
			sampleRateIndex: 8,
		})));

		using input = open(stream);
		const packets = await readPackets(input);

		expect(packets.map(packet => packet.data.byteLength)).toEqual([107, 16, 352, 69]);
		expect(concat(...packets.map(packet => packet.data))).toEqual(stream);
		expect(packets.map(packet => packet.timestamp)).toEqual([0, 0.064, 0.128, 0.192]);
		expect(packets.every(packet => packet.duration === 0.064 && packet.type === 'key')).toBe(true);
		expect(await input.computeDuration()).toBe(0.256);
		expect(await (await input.getPrimaryAudioTrack())!.getDurationFromMetadata()).toBeNull();
	});
});

describe('ADTS stream structure', () => {
	test('skips ID3v2 tags in front of the first frame', async () => {
		const frame = concat(ascii('TIT2'), [0, 0, 0, 6, 0, 0], [0], ascii('Title'));
		const tag = concat(ascii('ID3'), [4, 0, 0], [0, 0, 0, frame.length], frame);
		using input = open(concat(tag, tag, adtsFrames(3)));

		expect(await input.getFormat()).toBe(ADTS);
		expect(await readPackets(input)).toHaveLength(3);
		expect((await input.getMetadataTags()).title).toBe('Title');
	});

	test('ends the stream at data that isn\'t an ADTS frame', async () => {
		using input = open(concat(adtsFrames(3), ascii('TAG'), new Uint8Array(125)));
		expect(await readPackets(input)).toHaveLength(3);
	});

	test('drops a last frame cut off by the end of the file', async () => {
		const stream = adtsFrames(4);
		using input = open(stream.subarray(0, stream.length - 10));
		expect(await readPackets(input)).toHaveLength(3);
	});

	test('needs two consistent frames to detect ADTS', async () => {
		const notAdts = [
			concat(adtsFrame(), new Uint8Array(200)), // No second frame
			concat(adtsFrame({ sampleRateIndex: 4 }), adtsFrame({ sampleRateIndex: 3 })), // Inconsistent
			concat(adtsFrame({ profile: 1 }), adtsFrame({ profile: 0 })),
			concat(adtsFrame({ channelConfiguration: 2 }), adtsFrame({ channelConfiguration: 1 })),
			adtsFrames(2, { sampleRateIndex: 13 }), // Reserved sample rate index
		];

		for (const bytes of notAdts) {
			using input = open(bytes);
			await expect(input.getFormat()).rejects.toThrow('unsupported or unrecognizable format');
		}
	});

	test('looks up the packet containing a timestamp', async () => {
		using input = open(adtsFrames(6, { sampleRateIndex: 11 })); // 8 kHz: 0.128 s per frame
		const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);

		expect(await sink.getPacket(-0.01)).toBeNull();
		expect((await sink.getPacket(0))!.sequenceNumber).toBe(0);
		expect((await sink.getPacket(0.3))!.sequenceNumber).toBe(2);
		expect((await sink.getPacket(0.384))!.sequenceNumber).toBe(3);
		expect((await sink.getPacket(100))!.sequenceNumber).toBe(5);
		expect((await sink.getKeyPacket(0.5))!.sequenceNumber).toBe(3);

		const packet = (await sink.getPacket(0.6))!;
		expect((await sink.getNextPacket(packet))!.sequenceNumber).toBe(5);
		expect(await sink.getNextPacket((await sink.getNextPacket(packet))!)).toBeNull();
	});
});

describe('ADTS writing', () => {
	type TrackOptions = { description?: Uint8Array; sampleRate: number; numberOfChannels: number; codec?: string };

	const write = async (
		payloads: Uint8Array[],
		track: TrackOptions,
		onFrame?: (data: Uint8Array, position: number) => void,
	) => {
		const output = new Output({ format: new AdtsOutputFormat({ onFrame }), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('aac');
		output.addAudioTrack(source);
		await output.start();

		for (let i = 0; i < payloads.length; i++) {
			await source.add(
				new EncodedPacket(payloads[i]!, 'key', i * 1024 / track.sampleRate, 1024 / track.sampleRate),
				i === 0
					? {
							decoderConfig: {
								codec: track.codec ?? 'mp4a.40.2',
								sampleRate: track.sampleRate,
								numberOfChannels: track.numberOfChannels,
								description: track.description,
							},
						}
					: undefined,
			);
		}

		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	const payloads = [new Uint8Array(50).fill(1), new Uint8Array(3).fill(2), new Uint8Array(400).fill(3)];

	test('wraps raw AAC in ADTS headers derived from the AudioSpecificConfig', async () => {
		const cases = [
			// AudioSpecificConfig, expected profile, sample rate index, channel configuration
			{ config: [0x12, 0x10], profile: 1, sampleRateIndex: 4, channelConfiguration: 2, codec: 'mp4a.40.2' },
			{ config: [0x11, 0x88], profile: 1, sampleRateIndex: 3, channelConfiguration: 1, codec: 'mp4a.40.2' },
			{ config: [0x15, 0x90], profile: 1, sampleRateIndex: 11, channelConfiguration: 2, codec: 'mp4a.40.02' },
			{ config: [0x12, 0x38], profile: 1, sampleRateIndex: 4, channelConfiguration: 7, codec: 'mp4a.40.2' },
		];

		for (const { config, profile, sampleRateIndex, channelConfiguration, codec } of cases) {
			const bytes = await write(payloads, {
				codec,
				description: new Uint8Array(config),
				sampleRate: SAMPLE_RATES[sampleRateIndex]!,
				numberOfChannels: [0, 1, 2, 3, 4, 5, 6, 8][channelConfiguration]!,
			});

			const expected = concat(...payloads.map(payload => concat(
				adtsHeader({ profile, sampleRateIndex, channelConfiguration }, 7 + payload.length),
				payload,
			)));
			expect(bytes).toEqual(expected);
		}
	});

	test('signals HE-AAC implicitly, with the AAC-LC core\'s sample rate', async () => {
		// Explicit hierarchical signaling: SBR, 24 kHz core, stereo, 48 kHz output, AAC-LC core
		const heAac = new Uint8Array([0x2b, 0x11, 0x88, 0x00]);
		const bytes = await write(payloads, {
			codec: 'mp4a.40.5',
			description: heAac,
			sampleRate: 48000,
			numberOfChannels: 2,
		});

		const expectedHeader = adtsHeader({ profile: 1, sampleRateIndex: 6, channelConfiguration: 2 }, 57);
		expect([...bytes.subarray(0, 7)]).toEqual([...expectedHeader]);

		using input = open(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getSampleRate()).toBe(24000);
		expect(await track.getDecoderConfig()).toEqual({ codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 24000 });
	});

	test('round-trips through the demuxer', async () => {
		const bytes = await write(payloads, {
			description: new Uint8Array([0x12, 0x10]),
			sampleRate: 44100,
			numberOfChannels: 2,
		});

		using input = open(bytes);
		const packets = await readPackets(input);
		expect(packets.map(packet => packet.data.subarray(7))).toEqual(payloads);
		expect(packets.map(packet => packet.timestamp)).toEqual([0, 1, 2].map(i => i * 1024 / 44100));
	});

	test('writes ADTS packets as they are', async () => {
		const frames = [adtsFrame({ crc: true }), adtsFrame(), adtsFrame({ payload: [9, 9, 9] })];
		const reported: [number[], number][] = [];
		const bytes = await write(frames, { sampleRate: 44100, numberOfChannels: 2 }, (data, position) => {
			reported.push([[...data], position]);
		});

		expect(bytes).toEqual(concat(...frames));
		expect(reported).toEqual([
			[[...frames[0]!], 0],
			[[...frames[1]!], frames[0]!.length],
			[[...frames[2]!], frames[0]!.length + frames[1]!.length],
		]);
	});

	test('reports every written frame through onFrame', async () => {
		const reported: [number[], number][] = [];
		const bytes = await write(
			payloads,
			{ description: new Uint8Array([0x12, 0x10]), sampleRate: 44100, numberOfChannels: 2 },
			(data, position) => reported.push([[...data], position]),
		);

		let position = 0;
		for (const [data, reportedPosition] of reported) {
			expect(reportedPosition).toBe(position);
			expect(data).toEqual([...bytes.subarray(position, position + data.length)]);
			position += data.length;
		}
		expect(position).toBe(bytes.length);
	});

	test('refuses to finalize without any packet', async () => {
		const output = new Output({ format: new AdtsOutputFormat(), target: new BufferTarget() });
		output.addAudioTrack(new EncodedAudioPacketSource('aac'));
		await output.start();
		await expect(output.finalize()).rejects.toThrow('Cannot finalize an empty ADTS file');
	});
});
