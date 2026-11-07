import { describe, expect, test } from 'vitest';
import path from 'node:path';
import { registerAc3Decoder, registerAc3Encoder } from '@mediabunny/ac3';
import { registerDtsDecoder, registerDtsEncoder } from '@mediabunny/dts';
import { registerTrueHdDecoder, registerTrueHdEncoder } from '@mediabunny/truehd';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AdtsOutputFormat, FlacOutputFormat, Mp3OutputFormat } from '../../src/output-format.js';
import { AudioCodec } from '../../src/codec.js';
import { toUint8Array } from '../../src/misc.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { AudioSample } from '../../src/sample.js';
import type { EncodedPacket } from '../../src/packet.js';
import { NodeAvAudioDecoder } from '../../packages/server/src/audio-decoder.js';
import {
	channelToneMap,
	createTones,
	decodeTrack,
	encodeAudio,
	readAudioPackets,
	triangle,
} from './helpers/l13-audio.js';
import {
	MP3_LAYER_3_BITRATES,
	parseAc3Frame,
	parseAdtsHeader,
	parseAudioSpecificConfig,
	parseDtsFrame,
	parseEac3Frame,
	parseFlacFrame,
	parseFlacStreamInfo,
	parseMp3Frame,
} from './helpers/l13-bitstream.js';

registerAc3Decoder();
registerAc3Encoder();
registerDtsDecoder();
registerDtsEncoder();
registerTrueHdDecoder();
registerTrueHdEncoder();
registerAacEncoder();
registerFlacEncoder();
registerMp3Encoder();

const publicFile = (name: string) => path.join(__dirname, '..', 'public', name);

const decodeFile = async (name: string) => {
	using input = new Input({ source: new FilePathSource(publicFile(name)), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	return { decoded: await decodeTrack(track), codec: await track.getCodec() };
};

const decodeBytes = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	return await decodeTrack(track);
};

const identity = (n: number) => [...Array(n).keys()];

// Every packet holds a whole frame, except that the last one can end early, where the input does (the silence that
// fills up its frame isn't part of the audio)
const expectFrameDuration = (packet: EncodedPacket, frameDuration: number, isLast: boolean) => {
	if (isLast) {
		expect(packet.duration).toBeGreaterThan(0);
		expect(packet.duration).toBeLessThanOrEqual(frameDuration + 1e-9);
	} else {
		expect(packet.duration).toBeCloseTo(frameDuration, 10);
	}
};

describe('AC-3 and E-AC-3', () => {
	test('decodes FFmpeg-encoded 5.1 AC-3 in WAV channel order', async () => {
		// ffmpeg -f lavfi -i "aevalsrc=0.3*sin(2*PI*220*t)|0.3*sin(2*PI*330*t)|0.3*sin(2*PI*440*t)|0.3*sin(2*PI*55*t)|
		//   0.3*sin(2*PI*550*t)|0.3*sin(2*PI*660*t):s=48000:d=0.5:c=5.1" -c:a ac3 -b:a 384k
		//   -fflags +bitexact -flags:a +bitexact ac3-5.1-tones.mkv
		const { decoded, codec } = await decodeFile('ac3-5.1-tones.mkv');
		expect(codec).toBe('ac3');
		expect(decoded.numberOfChannels).toBe(6);
		expect(decoded.sampleRate).toBe(48000);

		// FL FR FC LFE SL SR, each with its own tone
		expect(channelToneMap(decoded.data, 6, 48000, 8192, 8192)).toEqual(identity(6));

		// One sample per 1536-sample syncframe, back to back
		for (let i = 0; i < decoded.durations.length; i++) {
			expect(decoded.durations[i]).toBeCloseTo(1536 / 48000, 10);
			if (i > 0) {
				expect(decoded.timestamps[i]).toBeCloseTo(decoded.timestamps[i - 1]! + 1536 / 48000, 10);
			}
		}
	});

	for (const codec of ['ac3', 'eac3'] as const) {
		test(`${codec} encoding keeps each channel in place (1, 2, 5 and 6 channels)`, async () => {
			for (const numberOfChannels of [1, 2, 5, 6]) {
				const bytes = await encodeAudio({
					codec,
					data: createTones(48000, numberOfChannels, 24000),
					numberOfChannels,
					sampleRate: 48000,
					bitrate: 384000,
				});
				const decoded = await decodeBytes(bytes);
				expect(decoded.numberOfChannels).toBe(numberOfChannels);
				expect(channelToneMap(decoded.data, numberOfChannels, 48000, 8192, 8192)).toEqual(
					identity(numberOfChannels),
				);
			}
		});
	}

	test('encodes syncframes whose headers match the configuration', async () => {
		const cases = [
			{ sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 },
			{ sampleRate: 44100, numberOfChannels: 6, bitrate: 448000 },
			{ sampleRate: 32000, numberOfChannels: 1, bitrate: 96000 },
		];

		for (const { sampleRate, numberOfChannels, bitrate } of cases) {
			const bytes = await encodeAudio({
				codec: 'ac3',
				data: createTones(sampleRate, numberOfChannels, sampleRate / 2),
				numberOfChannels,
				sampleRate,
				bitrate,
			});
			const { input, packets } = await readAudioPackets(bytes);
			input.dispose();

			expect(packets.length).toBeGreaterThan(0);
			for (const [i, packet] of packets.entries()) {
				const frame = parseAc3Frame(packet.data);
				expect(frame.bsid).toBe(8);
				expect(frame.sampleRate).toBe(sampleRate);
				expect(frame.bitrate).toBe(bitrate);
				expect(frame.channels).toBe(numberOfChannels);
				expect(frame.lfeon).toBe(numberOfChannels === 6 ? 1 : 0);
				// One syncframe per packet, sized as the frmsizecod says
				expect(frame.frameBytes).toBe(packet.data.byteLength);
				expectFrameDuration(packet, 1536 / sampleRate, i === packets.length - 1);
			}
		}
	});

	test('encodes E-AC-3 as independent six-block syncframes', async () => {
		for (const numberOfChannels of [2, 6]) {
			const bytes = await encodeAudio({
				codec: 'eac3',
				data: createTones(48000, numberOfChannels, 24000),
				numberOfChannels,
				sampleRate: 48000,
				bitrate: 256000,
			});
			const { input, packets } = await readAudioPackets(bytes);
			input.dispose();

			for (const packet of packets) {
				const frame = parseEac3Frame(packet.data);
				expect(frame.bsid).toBe(16);
				expect(frame.strmtyp).toBe(0);
				expect(frame.substreamid).toBe(0);
				expect(frame.sampleRate).toBe(48000);
				expect(frame.blocks).toBe(6);
				expect(frame.channels).toBe(numberOfChannels);
				expect(frame.frameBytes).toBe(packet.data.byteLength);
			}
		}
	});

	test('signals the 256-sample encoder delay through a negative first timestamp', async () => {
		for (const codec of ['ac3', 'eac3'] as const) {
			const bytes = await encodeAudio({
				codec,
				data: createTones(48000, 2, 48000),
				numberOfChannels: 2,
				sampleRate: 48000,
				bitrate: 192000,
			});
			const { input, packets } = await readAudioPackets(bytes);
			input.dispose();

			expect(packets[0]!.timestamp).toBeCloseTo(-256 / 48000, 10);
			for (let i = 1; i < packets.length; i++) {
				expect(packets[i]!.timestamp).toBeCloseTo(packets[0]!.timestamp + i * 1536 / 48000, 10);
			}
		}
	});
});

describe('DTS', () => {
	test('decodes FFmpeg-encoded 5.1 DTS in WAV channel order', async () => {
		// ffmpeg -f lavfi -i "aevalsrc=0.3*sin(2*PI*220*t)|0.3*sin(2*PI*330*t)|0.3*sin(2*PI*440*t)|0.3*sin(2*PI*55*t)|
		//   0.3*sin(2*PI*550*t)|0.3*sin(2*PI*660*t):s=48000:d=0.25:c=5.1(side)" -c:a dca -strict -2 -b:a 768k
		//   -fflags +bitexact -flags:a +bitexact dts-5.1-tones.mkv
		const { decoded, codec } = await decodeFile('dts-5.1-tones.mkv');
		expect(codec).toBe('dts');
		expect(decoded.numberOfChannels).toBe(6);
		expect(decoded.sampleRate).toBe(48000);
		expect(channelToneMap(decoded.data, 6, 48000, 4096, 4096)).toEqual(identity(6));

		for (const duration of decoded.durations) {
			expect(duration).toBeCloseTo(512 / 48000, 10);
		}
	});

	test('encoding keeps each channel in place (1, 2, 4, 5 and 6 channels)', async () => {
		for (const numberOfChannels of [1, 2, 4, 5, 6]) {
			const bytes = await encodeAudio({
				codec: 'dts',
				data: createTones(48000, numberOfChannels, 24000),
				numberOfChannels,
				sampleRate: 48000,
				bitrate: 1536000,
			});
			const decoded = await decodeBytes(bytes);
			expect(decoded.numberOfChannels).toBe(numberOfChannels);
			expect(channelToneMap(decoded.data, numberOfChannels, 48000, 8192, 8192)).toEqual(
				identity(numberOfChannels),
			);
		}
	});

	test('encodes core frames whose headers match the configuration', async () => {
		const cases = [
			{ sampleRate: 48000, numberOfChannels: 2, amode: 2 },
			{ sampleRate: 44100, numberOfChannels: 6, amode: 9 },
			{ sampleRate: 32000, numberOfChannels: 1, amode: 0 },
			{ sampleRate: 48000, numberOfChannels: 4, amode: 8 },
			{ sampleRate: 48000, numberOfChannels: 5, amode: 9 },
		];

		for (const { sampleRate, numberOfChannels, amode } of cases) {
			const bytes = await encodeAudio({
				codec: 'dts',
				data: createTones(sampleRate, numberOfChannels, sampleRate / 4),
				numberOfChannels,
				sampleRate,
				bitrate: 1536000,
			});
			const { input, packets } = await readAudioPackets(bytes);
			input.dispose();

			for (const [i, packet] of packets.entries()) {
				const frame = parseDtsFrame(packet.data);
				expect(frame.samples).toBe(512);
				expect(frame.frameBytes).toBe(packet.data.byteLength);
				expect(frame.sampleRate).toBe(sampleRate);
				expect(frame.amode).toBe(amode);
				expect(frame.lfe).toBe(numberOfChannels === 6);
				expect(frame.channels).toBe(numberOfChannels);
				expectFrameDuration(packet, 512 / sampleRate, i === packets.length - 1);
			}
		}
	});
});

describe('TrueHD', () => {
	// The triangle periods (in samples) of truehd-5.1-triangles.mkv, one per channel
	const TRIANGLE_PERIODS = [218, 145, 109, 873, 87, 73];

	test('decodes an FFmpeg-encoded 5.1 stream bit-exactly', async () => {
		// The input is 12000 frames of 16-bit triangle(n, period, 8000) per channel, written as a WAV file, then:
		// ffmpeg -channel_layout 5.1 -i triangles.wav -c:a truehd -strict -2 -fflags +bitexact -flags:a +bitexact
		//   truehd-5.1-triangles.mkv
		const { decoded, codec } = await decodeFile('truehd-5.1-triangles.mkv');
		expect(codec).toBe('truehd');
		expect(decoded.numberOfChannels).toBe(6);
		expect(decoded.data.length).toBe(12000 * 6);

		let mismatches = 0;
		for (let n = 0; n < 12000; n++) {
			for (let channel = 0; channel < 6; channel++) {
				const expected = triangle(n, TRIANGLE_PERIODS[channel]!, 8000);
				if (Math.round(decoded.data[n * 6 + channel]! * 32768) !== expected) {
					mismatches++;
				}
			}
		}
		expect(mismatches).toBe(0);
	});

	test('encoding is lossless for 16-bit input, 1 to 6 channels', async () => {
		for (const numberOfChannels of [1, 2, 3, 4, 5, 6]) {
			const frames = 9600;
			const data = new Int16Array(frames * numberOfChannels);
			for (let n = 0; n < frames; n++) {
				for (let channel = 0; channel < numberOfChannels; channel++) {
					data[n * numberOfChannels + channel] = triangle(n, TRIANGLE_PERIODS[channel]!, 12000);
				}
			}

			const bytes = await encodeAudio({
				codec: 'truehd',
				data,
				format: 's16',
				numberOfChannels,
				sampleRate: 48000,
			});
			const decoded = await decodeBytes(bytes);
			expect(decoded.numberOfChannels).toBe(numberOfChannels);
			expect(decoded.data.length).toBe(data.length);

			let mismatches = 0;
			for (let i = 0; i < data.length; i++) {
				if (Math.round(decoded.data[i]! * 32768) !== data[i]) {
					mismatches++;
				}
			}
			expect(mismatches).toBe(0);
		}
	});

	test('encoding is lossless for 24-bit input at 44.1 to 192 kHz', async () => {
		for (const sampleRate of [44100, 48000, 96000, 192000]) {
			const frames = 9600;
			const data = new Float32Array(frames * 2);
			const expected = new Int32Array(frames * 2);
			for (let n = 0; n < frames; n++) {
				for (let channel = 0; channel < 2; channel++) {
					// 24-bit values, exactly representable as floats
					const value = triangle(n, TRIANGLE_PERIODS[channel]!, 4_000_000) + (n % 7) - 3;
					expected[n * 2 + channel] = value;
					data[n * 2 + channel] = value / 2 ** 23;
				}
			}

			const bytes = await encodeAudio({ codec: 'truehd', data, numberOfChannels: 2, sampleRate });
			const decoded = await decodeBytes(bytes);
			expect(decoded.sampleRate).toBe(sampleRate);
			expect(decoded.data.length).toBe(expected.length);

			let mismatches = 0;
			for (let i = 0; i < expected.length; i++) {
				if (Math.round(decoded.data[i]! * 2 ** 23) !== expected[i]) {
					mismatches++;
				}
			}
			expect(mismatches).toBe(0);
		}
	});
});

describe('AAC encoder', () => {
	test('writes an AAC-LC AudioSpecificConfig that matches the input', async () => {
		const cases = [
			{ sampleRate: 48000, numberOfChannels: 1, channelConfiguration: 1 },
			{ sampleRate: 44100, numberOfChannels: 2, channelConfiguration: 2 },
			{ sampleRate: 96000, numberOfChannels: 2, channelConfiguration: 2 },
			{ sampleRate: 22050, numberOfChannels: 2, channelConfiguration: 2 },
			{ sampleRate: 8000, numberOfChannels: 1, channelConfiguration: 1 },
			{ sampleRate: 48000, numberOfChannels: 5, channelConfiguration: 5 },
			{ sampleRate: 48000, numberOfChannels: 6, channelConfiguration: 6 },
		];

		for (const { sampleRate, numberOfChannels, channelConfiguration } of cases) {
			const bytes = await encodeAudio({
				codec: 'aac',
				data: createTones(sampleRate, numberOfChannels, Math.floor(sampleRate / 4)),
				numberOfChannels,
				sampleRate,
				bitrate: 64000 * numberOfChannels,
			});
			const { input, track, packets } = await readAudioPackets(bytes);

			const config = await track.getDecoderConfig();
			expect(config).not.toBeNull();
			const asc = parseAudioSpecificConfig(toUint8Array(config!.description!));
			expect(asc).toEqual({ objectType: 2, sampleRate, channelConfiguration });
			expect(await track.getSampleRate()).toBe(sampleRate);
			expect(await track.getNumberOfChannels()).toBe(numberOfChannels);

			// 1024-sample frames, starting one frame early because of the encoder delay
			expect(packets[0]!.timestamp).toBeCloseTo(-1024 / sampleRate, 10);
			for (let i = 1; i < packets.length; i++) {
				expect(packets[i]!.timestamp).toBeCloseTo(packets[0]!.timestamp + i * 1024 / sampleRate, 10);
			}

			input.dispose();
		}
	});

	test('writes ADTS headers that match the input', async () => {
		for (const [sampleRate, numberOfChannels] of [[44100, 2], [48000, 1], [48000, 6], [16000, 2]] as const) {
			const bytes = await encodeAudio({
				codec: 'aac',
				data: createTones(sampleRate, numberOfChannels, sampleRate / 4),
				numberOfChannels,
				sampleRate,
				bitrate: 64000 * numberOfChannels,
				outputFormat: new AdtsOutputFormat(),
			});

			// Walk the raw ADTS stream frame by frame
			let offset = 0;
			let frames = 0;
			while (offset < bytes.length) {
				const header = parseAdtsHeader(bytes.subarray(offset));
				expect(header.objectType).toBe(2);
				expect(header.sampleRate).toBe(sampleRate);
				expect(header.channelConfiguration).toBe(numberOfChannels);
				expect(header.frameLength).toBeGreaterThan(header.headerLength);
				offset += header.frameLength;
				frames++;
			}
			expect(offset).toBe(bytes.length);
			// The encoder delay frame, the input and the padded remainder
			expect(frames).toBe(Math.ceil((sampleRate / 4 + 1024) / 1024));
		}
	});
});

describe('FLAC encoder', () => {
	test('writes a STREAMINFO block that matches the input', async () => {
		const cases = [
			{ sampleRate: 44100, numberOfChannels: 2, format: 's16' as const, bitsPerSample: 16 },
			{ sampleRate: 48000, numberOfChannels: 1, format: 'u8' as const, bitsPerSample: 16 },
			{ sampleRate: 96000, numberOfChannels: 6, format: 'f32' as const, bitsPerSample: 24 },
			{ sampleRate: 192000, numberOfChannels: 2, format: 's32' as const, bitsPerSample: 24 },
		];

		for (const { sampleRate, numberOfChannels, format, bitsPerSample } of cases) {
			const frames = 10000;
			const tones = createTones(sampleRate, numberOfChannels, frames);
			const data = format === 's16'
				? Int16Array.from(tones, x => Math.round(x * 32767))
				: format === 'u8'
					? Uint8Array.from(tones, x => Math.round(x * 127) + 128)
					: format === 's32'
						? Int32Array.from(tones, x => Math.round(x * 2 ** 31))
						: tones;

			const bytes = await encodeAudio({
				codec: 'flac',
				data: data as Float32Array,
				format,
				numberOfChannels,
				sampleRate,
				outputFormat: new FlacOutputFormat(),
			});

			expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('fLaC');
			expect(bytes[4]! & 0x7f).toBe(0); // STREAMINFO comes first
			const info = parseFlacStreamInfo(bytes);
			expect(info.sampleRate).toBe(sampleRate);
			expect(info.channels).toBe(numberOfChannels);
			expect(info.bitsPerSample).toBe(bitsPerSample);
			expect(info.totalSamples).toBe(frames);
			expect(info.minBlockSize).toBe(4096);
			expect(info.maxBlockSize).toBe(4096);
			expect(info.minFrameSize).toBeGreaterThan(0);
			expect(info.maxFrameSize).toBeGreaterThanOrEqual(info.minFrameSize);
		}
	});

	test('encodes frames with consecutive numbers, fixed 4096-sample blocks and valid header CRCs', async () => {
		const frames = 20000;
		const bytes = await encodeAudio({
			codec: 'flac',
			data: Int16Array.from(createTones(48000, 2, frames), x => Math.round(x * 32767)),
			format: 's16',
			numberOfChannels: 2,
			sampleRate: 48000,
		});
		const { input, packets } = await readAudioPackets(bytes);
		input.dispose();

		expect(packets.length).toBe(Math.ceil(frames / 4096));
		let total = 0;
		for (let i = 0; i < packets.length; i++) {
			const frame = parseFlacFrame(packets[i]!.data);
			expect(frame.blockingStrategy).toBe(0); // Fixed block size, numbered by frame
			expect(frame.number).toBe(i);
			expect(frame.headerCrcOk).toBe(true);
			expect(frame.sampleRateBits).toBe(0b1010); // 48 kHz
			expect(frame.sampleSizeBits).toBe(0b100); // 16 bits
			expect(frame.blockSize).toBe(i < packets.length - 1 ? 4096 : frames - 4096 * i);
			expect(packets[i]!.timestamp).toBeCloseTo(total / 48000, 10);
			expect(packets[i]!.duration).toBeCloseTo(frame.blockSize / 48000, 10);
			total += frame.blockSize;
		}
		expect(total).toBe(frames);
	});
});

describe('MP3 encoder', () => {
	test('uses the MPEG version of the sample rate and a bit rate from its table', async () => {
		const cases = [
			{ sampleRate: 48000, numberOfChannels: 2, bitrate: 128000, version: '1', expectedBitrate: 128000 },
			{ sampleRate: 44100, numberOfChannels: 1, bitrate: 96000, version: '1', expectedBitrate: 96000 },
			{ sampleRate: 32000, numberOfChannels: 2, bitrate: 320000, version: '1', expectedBitrate: 320000 },
			{ sampleRate: 24000, numberOfChannels: 2, bitrate: 64000, version: '2', expectedBitrate: 64000 },
			{ sampleRate: 22050, numberOfChannels: 2, bitrate: 320000, version: '2', expectedBitrate: 160000 },
			{ sampleRate: 16000, numberOfChannels: 1, bitrate: 32000, version: '2', expectedBitrate: 32000 },
			{ sampleRate: 12000, numberOfChannels: 2, bitrate: 48000, version: '2.5', expectedBitrate: 48000 },
			{ sampleRate: 11025, numberOfChannels: 1, bitrate: 24000, version: '2.5', expectedBitrate: 24000 },
			{ sampleRate: 8000, numberOfChannels: 2, bitrate: 8000, version: '2.5', expectedBitrate: 8000 },
		] as const;

		for (const { sampleRate, numberOfChannels, bitrate, version, expectedBitrate } of cases) {
			const bytes = await encodeAudio({
				codec: 'mp3',
				data: createTones(sampleRate, numberOfChannels, sampleRate / 2),
				numberOfChannels,
				sampleRate,
				bitrate,
				outputFormat: new Mp3OutputFormat({ xingHeader: false }),
			});

			// Walk the raw stream frame by frame
			let offset = 0;
			let frames = 0;
			while (offset < bytes.length) {
				const frame = parseMp3Frame(bytes.subarray(offset));
				expect(frame.version).toBe(version);
				expect(frame.layer).toBe(3);
				expect(frame.sampleRate).toBe(sampleRate);
				expect(MP3_LAYER_3_BITRATES[version]).toContain(frame.bitrate);
				expect(frame.bitrate).toBe(expectedBitrate);
				expect(frame.mode === 3).toBe(numberOfChannels === 1); // Single channel mode for mono only
				offset += frame.frameBytes;
				frames++;
			}
			expect(offset).toBe(bytes.length);
			expect(frames).toBeGreaterThan(0);
		}
	});

	test('signals the encoder delay through a negative first timestamp', async () => {
		for (const sampleRate of [44100, 22050, 8000]) {
			const bytes = await encodeAudio({
				codec: 'mp3',
				data: createTones(sampleRate, 2, sampleRate / 2),
				numberOfChannels: 2,
				sampleRate,
				bitrate: 64000,
			});
			const { input, packets } = await readAudioPackets(bytes);
			input.dispose();

			// LAME's 576 samples plus the decoder's 529
			expect(packets[0]!.timestamp).toBeCloseTo(-1105 / sampleRate, 6);
			const frameSamples = sampleRate >= 32000 ? 1152 : 576;
			for (const [i, packet] of packets.entries()) {
				expectFrameDuration(packet, frameSamples / sampleRate, i === packets.length - 1);
			}
		}
	});
});

describe('All encoders', () => {
	const ENCODERS: { codec: AudioCodec; bitrate?: number }[] = [
		{ codec: 'aac', bitrate: 128000 },
		{ codec: 'ac3', bitrate: 192000 },
		{ codec: 'eac3', bitrate: 192000 },
		{ codec: 'dts', bitrate: 768000 },
		{ codec: 'truehd' },
		{ codec: 'flac' },
		{ codec: 'mp3', bitrate: 128000 },
	];

	const packetSignature = async (bytes: Uint8Array) => {
		const { input, packets } = await readAudioPackets(bytes);
		input.dispose();
		return packets.map(packet => [
			packet.timestamp.toFixed(9),
			packet.duration.toFixed(9),
			...packet.data,
		].join(','));
	};

	test('give the same packets whether the input comes in one sample or in odd-sized chunks', async () => {
		const data = createTones(48000, 2, 30000);
		for (const { codec, bitrate } of ENCODERS) {
			const whole = await encodeAudio({ codec, data, numberOfChannels: 2, sampleRate: 48000, bitrate });
			const chunked = await encodeAudio({
				codec,
				data,
				numberOfChannels: 2,
				sampleRate: 48000,
				bitrate,
				chunkFrames: 777,
			});
			expect(await packetSignature(chunked), codec).toEqual(await packetSignature(whole));
		}
	});

	test('give the same packets when they run concurrently', async () => {
		const data = createTones(48000, 2, 24000);
		const sequential: string[][] = [];
		for (const { codec, bitrate } of ENCODERS) {
			sequential.push(await packetSignature(
				await encodeAudio({ codec, data, numberOfChannels: 2, sampleRate: 48000, bitrate, chunkFrames: 1000 }),
			));
		}

		// AC-3, DTS and TrueHD coders share one worker between all of their instances
		const concurrent = await Promise.all(ENCODERS.map(async ({ codec, bitrate }) => packetSignature(
			await encodeAudio({ codec, data, numberOfChannels: 2, sampleRate: 48000, bitrate, chunkFrames: 1000 }),
		)));
		expect(concurrent).toEqual(sequential);
	});

	test('decoders sharing a worker give the same samples when they run concurrently', async () => {
		const files = ['ac3-5.1-tones.mkv', 'dts-5.1-tones.mkv', 'truehd-5.1-triangles.mkv'];
		const sequential: Float32Array[] = [];
		for (const file of files) {
			sequential.push((await decodeFile(file)).decoded.data);
		}

		const concurrent = await Promise.all(
			[...files, ...files].map(async file => (await decodeFile(file)).decoded.data),
		);
		for (let i = 0; i < concurrent.length; i++) {
			expect(concurrent[i]).toEqual(sequential[i % files.length]);
		}
	});
});

describe('Server decoders', () => {
	// Decodes a file with @mediabunny/server's libav decoder, bypassing the registered WASM decoders
	const decodeWithServer = async (name: string) => {
		using input = new Input({ source: new FilePathSource(publicFile(name)), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;

		const decoder = new NodeAvAudioDecoder();
		// @ts-expect-error Readonly
		decoder.codec = await track.getCodec();
		// @ts-expect-error Readonly
		decoder.config = await track.getDecoderConfig();

		const chunks: Float32Array[] = [];
		// @ts-expect-error Readonly
		decoder.onSample = (sample: AudioSample) => {
			const chunk = new Float32Array(sample.allocationSize({ format: 'f32', planeIndex: 0 }) / 4);
			sample.copyTo(chunk, { format: 'f32', planeIndex: 0 });
			chunks.push(chunk);
			sample.close();
		};

		await decoder.init();
		for await (const packet of new EncodedPacketSink(track).packets()) {
			await decoder.decode(packet);
		}
		await decoder.flush();
		await decoder.close();

		const data = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
		let offset = 0;
		for (const chunk of chunks) {
			data.set(chunk, offset);
			offset += chunk.length;
		}
		return data;
	};

	test('give the same samples as the WASM decoders, in the same channel order', async () => {
		for (const [file, tolerance] of [
			['ac3-5.1-tones.mkv', 1e-4],
			['dts-5.1-tones.mkv', 1e-4],
			['truehd-5.1-triangles.mkv', 0],
		] as const) {
			const wasm = (await decodeFile(file)).decoded.data;
			const server = await decodeWithServer(file);
			expect(server.length, file).toBe(wasm.length);

			let maxDifference = 0;
			for (let i = 0; i < wasm.length; i++) {
				maxDifference = Math.max(maxDifference, Math.abs(server[i]! - wasm[i]!));
			}
			expect(maxDifference, file).toBeLessThanOrEqual(tolerance);
		}
	});
});
