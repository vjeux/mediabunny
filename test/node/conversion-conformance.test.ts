import { describe, expect, test, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import {
	AdtsOutputFormat,
	FlacOutputFormat,
	MkvOutputFormat,
	MovOutputFormat,
	Mp3OutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	OutputFormat,
	WavOutputFormat,
	WebMOutputFormat,
} from '../../src/output-format.js';
import { Conversion, ConversionCanceledError, ConversionOptions } from '../../src/conversion.js';
import {
	AudioSampleSource,
	EncodedAudioPacketSource,
	EncodedVideoPacketSource,
	TextSubtitleSource,
} from '../../src/media-source.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { AudioSample } from '../../src/sample.js';
import { InputTrack } from '../../src/input-track.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const publicFile = (name: string) => path.join(__dirname, '..', 'public', name);

type PacketSummary = {
	count: number;
	keyCount: number;
	firstTimestamp: number;
	lastTimestamp: number;
};

const summarizePackets = async (track: InputTrack): Promise<PacketSummary> => {
	const sink = new EncodedPacketSink(track);

	let count = 0;
	let keyCount = 0;
	let firstTimestamp = Infinity;
	let lastTimestamp = -Infinity;
	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		count++;
		keyCount += packet.type === 'key' ? 1 : 0;
		firstTimestamp = Math.min(firstTimestamp, packet.timestamp);
		lastTimestamp = Math.max(lastTimestamp, packet.timestamp);
	}

	return { count, keyCount, firstTimestamp, lastTimestamp };
};

const runConversion = async (
	input: Input,
	format: OutputFormat,
	options: Omit<ConversionOptions, 'input' | 'output'> = {},
) => {
	const output = new Output({ format, target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output, showWarnings: false, ...options });
	if (conversion.isValid) {
		await conversion.execute();
	}

	return { conversion, output };
};

/** Builds a 16-bit PCM WAVE file from per-channel float data. */
const buildWav = (channels: Float32Array[], sampleRate: number, channelMask?: number) => {
	const frameCount = channels[0]!.length;
	const channelCount = channels.length;
	const extensible = channelMask !== undefined;
	const fmtSize = extensible ? 40 : 16;
	const dataSize = frameCount * channelCount * 2;

	const bytes = new Uint8Array(12 + 8 + fmtSize + 8 + dataSize);
	const view = new DataView(bytes.buffer);
	let pos = 0;
	const writeAscii = (text: string) => {
		for (const char of text) {
			view.setUint8(pos++, char.charCodeAt(0));
		}
	};
	const writeU16 = (value: number) => {
		view.setUint16(pos, value, true);
		pos += 2;
	};
	const writeU32 = (value: number) => {
		view.setUint32(pos, value, true);
		pos += 4;
	};

	writeAscii('RIFF');
	writeU32(bytes.byteLength - 8);
	writeAscii('WAVE');
	writeAscii('fmt ');
	writeU32(fmtSize);
	writeU16(extensible ? 0xfffe : 1);
	writeU16(channelCount);
	writeU32(sampleRate);
	writeU32(sampleRate * channelCount * 2);
	writeU16(channelCount * 2);
	writeU16(16);
	if (extensible) {
		writeU16(22);
		writeU16(16);
		writeU32(channelMask);
		// KSDATAFORMAT_SUBTYPE_PCM
		for (const byte of [1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]) {
			view.setUint8(pos++, byte);
		}
	}
	writeAscii('data');
	writeU32(dataSize);

	for (let i = 0; i < frameCount; i++) {
		for (let c = 0; c < channelCount; c++) {
			const value = Math.round(channels[c]![i]! * 32768);
			view.setInt16(pos, Math.max(-32768, Math.min(32767, value)), true);
			pos += 2;
		}
	}

	return bytes.buffer;
};

type DecodedAudio = {
	sampleRate: number;
	firstTimestamp: number;
	channels: Float32Array[];
};

const decodeAudio = async (buffer: ArrayBuffer): Promise<DecodedAudio> => {
	using input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	expect(track).not.toBeNull();

	const chunks: Float32Array[][] = [];
	let sampleRate = 0;
	let firstTimestamp: number | null = null;
	for await (using sample of new AudioSampleSink(track!).samples()) {
		sampleRate = sample.sampleRate;
		firstTimestamp ??= sample.timestamp;

		const planes: Float32Array[] = [];
		for (let c = 0; c < sample.numberOfChannels; c++) {
			const plane = new Float32Array(sample.numberOfFrames);
			sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
			planes.push(plane);
		}
		chunks.push(planes);
	}

	const channelCount = chunks[0]?.length ?? 0;
	const channels: Float32Array[] = [];
	for (let c = 0; c < channelCount; c++) {
		const length = chunks.reduce((sum, planes) => sum + planes[c]!.length, 0);
		const channel = new Float32Array(length);
		let offset = 0;
		for (const planes of chunks) {
			channel.set(planes[c]!, offset);
			offset += planes[c]!.length;
		}
		channels.push(channel);
	}

	return { sampleRate, firstTimestamp: firstTimestamp ?? 0, channels };
};

const constant = (length: number, value: number) => new Float32Array(length).fill(value);

const countZeroCrossings = (values: Float32Array) => {
	let count = 0;
	for (let i = 1; i < values.length; i++) {
		if ((values[i - 1]! < 0) !== (values[i]! < 0)) {
			count++;
		}
	}

	return count;
};

const expectError = async (fn: () => unknown, message: RegExp) => {
	await expect((async () => fn())()).rejects.toThrow(message);
};

describe('Copy conversions', () => {
	// Pairs where every track can be copied; Opus/MP3 into Matroska, WebM, Ogg or MP3 need a timestamp shift because
	// of their priming and are therefore left out here
	const copyCases: [string, string, () => OutputFormat][] = [
		['video.mp4', 'MP4', () => new Mp4OutputFormat()],
		['video.mp4', 'fragmented MP4', () => new Mp4OutputFormat({ fastStart: 'fragmented' })],
		['video.mp4', 'reserved Fast Start MP4', () => new Mp4OutputFormat({ fastStart: 'reserve' })],
		['video.mp4', 'MOV', () => new MovOutputFormat()],
		['video.mp4', 'Matroska', () => new MkvOutputFormat()],
		['video.mp4', 'MPEG-TS', () => new MpegTsOutputFormat()],
		['demo.webm', 'MP4', () => new Mp4OutputFormat()],
		['trim-buck-bunny-ffmpeg.ts', 'MP4', () => new Mp4OutputFormat()],
		['trim-buck-bunny-ffmpeg.ts', 'Matroska', () => new MkvOutputFormat()],
		['trim-buck-bunny-ffmpeg.ts', 'MPEG-TS', () => new MpegTsOutputFormat()],
		['annex-b-avc.mkv', 'MP4', () => new Mp4OutputFormat()],
		['ac3.ts', 'MP4', () => new Mp4OutputFormat()],
		['ac3.ts', 'Matroska', () => new MkvOutputFormat()],
		['sample3.aac', 'ADTS', () => new AdtsOutputFormat()],
		['sample3.aac', 'MPEG-TS', () => new MpegTsOutputFormat()],
		['sample.flac', 'FLAC', () => new FlacOutputFormat()],
		['sample.flac', 'Matroska', () => new MkvOutputFormat()],
		['glitch-hop-is-dead.wav', 'WAVE', () => new WavOutputFormat()],
		['glitch-hop-is-dead.wav', 'Matroska', () => new MkvOutputFormat()],
		['vorbis-eos.ogg', 'MOV', () => new MovOutputFormat()],
	];

	for (const [fileName, formatName, createFormat] of copyCases) {
		test(`copies every packet of ${fileName} into ${formatName}, shifted by the start`, async () => {
			using input = new Input({ source: new FilePathSource(publicFile(fileName)), formats: ALL_FORMATS });
			const { conversion, output } = await runConversion(input, createFormat(), { copy: { mode: 'forced' } });
			expect(conversion.discardedTracks.map(x => x.reason)).toEqual([]);

			const inputTracks = await input.getTracks();
			const start = Math.max(await input.getFirstTimestamp(), 0);

			using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
			const outputTracks = await outputInput.getTracks();
			expect(outputTracks.map(x => x.type)).toEqual(inputTracks.map(x => x.type));

			// Matroska stores millisecond timestamps
			const precision = createFormat() instanceof MkvOutputFormat ? 2 : 4;

			for (let i = 0; i < inputTracks.length; i++) {
				const inputSummary = await summarizePackets(inputTracks[i]!);
				const outputSummary = await summarizePackets(outputTracks[i]!);

				expect(outputSummary.keyCount).toBe(inputSummary.keyCount);
				if (inputTracks[i]!.type === 'video' || !(await outputTracks[i]!.getCodec())?.startsWith('pcm')) {
					// (ISOBMFF regroups PCM frames into chunks, so its packet count differs)
					expect(outputSummary.count).toBe(inputSummary.count);
				}
				expect(outputSummary.firstTimestamp).toBeCloseTo(inputSummary.firstTimestamp - start, precision);
				expect(outputSummary.lastTimestamp).toBeCloseTo(inputSummary.lastTimestamp - start, precision);
			}
		});
	}

	test('copied packets are bit-exact', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('video.mp4')), formats: ALL_FORMATS });
		const { output } = await runConversion(input, new MkvOutputFormat());

		using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const inputTracks = await input.getTracks();
		const outputTracks = await outputInput.getTracks();

		for (let i = 0; i < inputTracks.length; i++) {
			const inputSink = new EncodedPacketSink(inputTracks[i]!);
			const outputSink = new EncodedPacketSink(outputTracks[i]!);
			let inputPacket = await inputSink.getFirstPacket();
			let outputPacket = await outputSink.getFirstPacket();

			for (let j = 0; j < 20; j++) {
				expect(outputPacket!.data).toEqual(inputPacket!.data);
				inputPacket = await inputSink.getNextPacket(inputPacket!);
				outputPacket = await outputSink.getNextPacket(outputPacket!);
			}
		}
	});

	test('keeps the input timeline offset when the trim starts at 0', async () => {
		using input = new Input({
			source: new FilePathSource(publicFile('trim-buck-bunny-ffmpeg.ts')),
			formats: ALL_FORMATS,
		});
		const { output } = await runConversion(input, new Mp4OutputFormat(), { trim: { start: 0 } });

		using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		expect(await outputInput.getFirstTimestamp()).toBeCloseTo(await input.getFirstTimestamp(), 4);
	});

	test('keeps the offset between tracks that start at different times', async () => {
		// The video starts 21 ms after the audio
		using input = new Input({ source: new FilePathSource(publicFile('0.ts')), formats: ALL_FORMATS });
		const { output } = await runConversion(input, new Mp4OutputFormat());

		using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const videoTrack = await outputInput.getPrimaryVideoTrack();
		const audioTrack = await outputInput.getPrimaryAudioTrack();
		expect(await audioTrack!.getFirstTimestamp()).toBe(0);
		expect(await videoTrack!.getFirstTimestamp()).toBeCloseTo(10.033322 - 10.0121, 3);
	});

	test('copying with a trim starts at the key frame before the start, expanding the region', async () => {
		// Key frames every second
		using input = new Input({ source: new FilePathSource(publicFile('demo.mp4')), formats: ALL_FORMATS });
		const { output } = await runConversion(input, new Mp4OutputFormat(), { trim: { start: 1.5, end: 2.5 } });

		using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const summary = await summarizePackets((await outputInput.getPrimaryVideoTrack())!);
		expect(summary.firstTimestamp).toBeCloseTo(-0.5, 6); // The key frame at 1 s
		expect(summary.lastTimestamp).toBeCloseTo(0.98, 6); // The frame at 2.48 s
		expect(summary.keyCount).toBe(2);
	});

	test('copying with the shrink policy starts at the next key frame', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('demo.mp4')), formats: ALL_FORMATS });
		const { output } = await runConversion(input, new Mp4OutputFormat(), {
			trim: { start: 1.5, end: 2.5 },
			copy: { boundaryPolicy: 'shrink' },
		});

		using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const summary = await summarizePackets((await outputInput.getPrimaryVideoTrack())!);
		expect(summary.firstTimestamp).toBeCloseTo(0.5, 6); // The key frame at 2 s
		expect(summary.keyCount).toBe(1);
	});

	test('discards tracks the output format cannot hold at all', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('video.mp4')), formats: ALL_FORMATS });
		const { conversion, output } = await runConversion(input, new AdtsOutputFormat());

		expect(conversion.isValid).toBe(true);
		expect(conversion.utilizedTracks.map(x => x.type)).toEqual(['audio']);
		expect(conversion.discardedTracks.map(x => [x.track.type, x.reason])).toEqual([
			['video', 'max_track_count_of_type_reached'],
		]);
		expect(output.tracks).toHaveLength(1);
	});

	test('discards tracks beyond the format\'s track count', async () => {
		using input = new Input({
			source: new FilePathSource(publicFile('multiple-aac-tracks.mp4')),
			formats: ALL_FORMATS,
		});
		const { conversion } = await runConversion(input, new AdtsOutputFormat());

		expect(conversion.utilizedTracks).toHaveLength(1);
		expect(conversion.discardedTracks.map(x => x.reason)).toEqual(['max_track_count_reached']);
	});

	test('forced copying discards tracks that would need a transcode', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('video.mp4')), formats: ALL_FORMATS });
		const { conversion } = await runConversion(input, new WebMOutputFormat(), { copy: { mode: 'forced' } });

		expect(conversion.isValid).toBe(false);
		expect(conversion.discardedTracks.map(x => [x.track.type, x.reason])).toEqual([
			['video', 'cannot_copy'],
			['audio', 'cannot_copy'],
		]);
	});

	test('a track that needs a transcode but cannot be decoded is discarded as undecodable', async () => {
		// Node has no AAC decoder
		using input = new Input({ source: new FilePathSource(publicFile('sample3.aac')), formats: ALL_FORMATS });
		const { conversion } = await runConversion(input, new WavOutputFormat());

		expect(conversion.isValid).toBe(false);
		expect(conversion.discardedTracks.map(x => x.reason)).toEqual(['undecodable_source_codec']);
	});

	test('discarded_by_user and the options that came with it are reported', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('video.mp4')), formats: ALL_FORMATS });
		const audioOptions = { discard: true };
		const { conversion } = await runConversion(input, new Mp4OutputFormat(), { audio: audioOptions });

		expect(conversion.discardedTracks).toHaveLength(1);
		expect(conversion.discardedTracks[0]!.reason).toBe('discarded_by_user');
		expect(conversion.discardedTracks[0]!.trackOptions).toBe(audioOptions);
		expect(conversion.utilizedTracks.map(x => x.type)).toEqual(['video']);
	});

	test('fan-out creates one output track per options object', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('video.mp4')), formats: ALL_FORMATS });
		const { conversion, output } = await runConversion(input, new MkvOutputFormat(), {
			audio: [{}, {}],
			video: { discard: true },
		});

		expect(output.tracks.map(x => x.type)).toEqual(['audio', 'audio']);
		expect(conversion.utilizedTracks).toHaveLength(2);
		expect(conversion.utilizedTracks[0]).toBe(conversion.utilizedTracks[1]);
	});

	test('tracks: \'primary\' only uses the primary video and audio track', async () => {
		using input = new Input({
			source: new FilePathSource(publicFile('multiple-aac-tracks.mp4')),
			formats: ALL_FORMATS,
		});
		const { conversion, output } = await runConversion(input, new MkvOutputFormat(), { tracks: 'primary' });

		expect(conversion.utilizedTracks).toEqual([await input.getPrimaryAudioTrack()]);
		expect(output.tracks).toHaveLength(1);
	});

	test('the options callback is called once per track with the track', async () => {
		using input = new Input({
			source: new FilePathSource(publicFile('multiple-aac-tracks.mp4')),
			formats: ALL_FORMATS,
		});
		const audio = vi.fn(() => ({}));
		await runConversion(input, new MkvOutputFormat(), { audio });

		const tracks = await input.getAudioTracks();
		expect(audio).toHaveBeenCalledTimes(2);
		expect(audio.mock.calls.map(x => (x as unknown[])[0])).toEqual(tracks);
	});
});

describe('PCM audio transcoding', () => {
	const sampleRate = 48000;
	const frames = 4800;

	// Channel orders follow WAVEFORMATEXTENSIBLE: L R C LFE SL SR
	const mixingCases: [string, number[], number | undefined, number, number[]][] = [
		['mono to stereo copies the channel', [0.25], undefined, 2, [0.25, 0.25]],
		['mono to quad fills the front', [0.25], 0x33, 4, [0.25, 0.25, 0, 0]],
		['mono to 5.1 goes to the center', [0.25], 0x3f, 6, [0, 0, 0.25, 0, 0, 0]],
		['stereo to mono averages', [0.2, 0.4], undefined, 1, [0.3]],
		['stereo to quad keeps the front', [0.2, 0.4], 0x33, 4, [0.2, 0.4, 0, 0]],
		['stereo to 5.1 keeps the front', [0.2, 0.4], 0x3f, 6, [0.2, 0.4, 0, 0, 0, 0]],
		['quad to mono averages', [0.1, 0.2, 0.3, 0.4], 0x33, 1, [0.25]],
		['quad to stereo folds the surrounds in', [0.1, 0.2, 0.3, 0.4], 0x33, 2, [0.2, 0.3]],
		['quad to 5.1 leaves center and LFE silent', [0.1, 0.2, 0.3, 0.4], 0x33, 6, [0.1, 0.2, 0, 0, 0.3, 0.4]],
		['5.1 to mono', [0.1, 0.2, 0.3, 0.4, 0.05, 0.06], 0x3f, 1, [
			Math.SQRT1_2 * (0.1 + 0.2) + 0.3 + 0.5 * (0.05 + 0.06),
		]],
		['5.1 to stereo drops the LFE', [0.1, 0.2, 0.3, 0.4, 0.05, 0.06], 0x3f, 2, [
			0.1 + Math.SQRT1_2 * (0.3 + 0.05),
			0.2 + Math.SQRT1_2 * (0.3 + 0.06),
		]],
		['5.1 to quad folds the center in', [0.1, 0.2, 0.3, 0.4, 0.05, 0.06], 0x3f, 4, [
			0.1 + Math.SQRT1_2 * 0.3,
			0.2 + Math.SQRT1_2 * 0.3,
			0.05,
			0.06,
		]],
	];

	for (const [name, inputValues, channelMask, numberOfChannels, expectedValues] of mixingCases) {
		test(`up/down-mixing follows the Web Audio speaker rules: ${name}`, async () => {
			const wav = buildWav(inputValues.map(x => constant(frames, x)), sampleRate, channelMask);
			using input = new Input({ source: new BufferSource(wav), formats: ALL_FORMATS });
			const { output } = await runConversion(input, new WavOutputFormat(), { audio: { numberOfChannels } });

			const decoded = await decodeAudio(output.target.buffer!);
			expect(decoded.channels).toHaveLength(numberOfChannels);
			for (let c = 0; c < numberOfChannels; c++) {
				expect(decoded.channels[c]!.length).toBe(frames);
				expect(decoded.channels[c]![frames / 2]).toBeCloseTo(expectedValues[c]!, 3);
			}
		});
	}

	for (const targetSampleRate of [8000, 22050, 44100, 96000]) {
		test(`resampling 48 kHz to ${targetSampleRate} Hz keeps duration and pitch`, async () => {
			const sine = new Float32Array(sampleRate)
				.map((_, i) => 0.5 * Math.sin(2 * Math.PI * 1000 * i / sampleRate));
			using input = new Input({ source: new BufferSource(buildWav([sine], sampleRate)), formats: ALL_FORMATS });
			const { output } = await runConversion(input, new WavOutputFormat(), {
				audio: { sampleRate: targetSampleRate },
			});

			const decoded = await decodeAudio(output.target.buffer!);
			expect(decoded.sampleRate).toBe(targetSampleRate);
			expect(decoded.firstTimestamp).toBe(0);
			expect(decoded.channels[0]!.length).toBe(targetSampleRate);
			// 1 kHz for 1 s crosses zero 2000 times
			expect(Math.abs(countZeroCrossings(decoded.channels[0]!) - 2000)).toBeLessThanOrEqual(2);
		});
	}

	test('transcoding trims sample-exactly', async () => {
		// Each frame stores its own index (modulo 1000)
		const ramp = new Float32Array(sampleRate).map((_, i) => (i % 1000) / 2000);
		using input = new Input({ source: new BufferSource(buildWav([ramp], sampleRate)), formats: ALL_FORMATS });
		const { output } = await runConversion(input, new WavOutputFormat(), {
			audio: { forceTranscode: true },
			trim: { start: 0.1234, end: 0.5 },
		});

		const decoded = await decodeAudio(output.target.buffer!);
		const channel = decoded.channels[0]!;
		expect(channel.length).toBe(Math.round((0.5 - 0.1234) * sampleRate));
		expect(Math.round(channel[0]! * 2000)).toBe(Math.round(0.1234 * sampleRate) % 1000);
	});

	test('a negative trim start is filled with silence in formats without timestamps', async () => {
		const wav = buildWav([constant(sampleRate, 0.5)], sampleRate);
		using input = new Input({ source: new BufferSource(wav), formats: ALL_FORMATS });
		const { output } = await runConversion(input, new WavOutputFormat(), { trim: { start: -0.25, end: 0.5 } });

		const decoded = await decodeAudio(output.target.buffer!);
		const channel = decoded.channels[0]!;
		expect(channel.length).toBe(0.75 * sampleRate);
		expect(channel[0.25 * sampleRate - 1]).toBe(0);
		expect(channel[0.25 * sampleRate]).toBeCloseTo(0.5, 3);
	});

	test('sampleFormat converts the samples before they reach the encoder', async () => {
		const values = new Float32Array(1000).map((_, i) => i / 1000 - 0.5);
		using input = new Input({ source: new BufferSource(buildWav([values], sampleRate)), formats: ALL_FORMATS });
		const { output } = await runConversion(input, new WavOutputFormat(), { audio: { sampleFormat: 'u8' } });

		// The 16-bit output only holds values of 8-bit precision
		const decoded = await decodeAudio(output.target.buffer!);
		expect(decoded.channels[0]!.every(x => Number.isInteger(x * 128))).toBe(true);
	});

	test('a requested PCM codec is used', async () => {
		const wav = buildWav([constant(frames, 0.25)], sampleRate);
		for (const codec of ['pcm-s24', 'pcm-f32', 'pcm-u8'] as const) {
			using input = new Input({ source: new BufferSource(wav), formats: ALL_FORMATS });
			const { output } = await runConversion(input, new WavOutputFormat(), { audio: { codec } });

			using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
			expect(await (await outputInput.getPrimaryAudioTrack())!.getCodec()).toBe(codec);
		}
	});
});

describe('Audio sample sources', () => {
	const sampleRate = 48000;
	const createSample = (timestamp: number, frames: number, value: number) => new AudioSample({
		data: new Float32Array(frames).fill(value),
		format: 'f32',
		numberOfChannels: 1,
		sampleRate,
		timestamp,
	});

	const encode = async (samples: AudioSample[]) => {
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const source = new AudioSampleSource({ codec: 'pcm-s16' });
		output.addAudioTrack(source);
		await output.start();
		for (const sample of samples) {
			await source.add(sample);
		}
		await output.finalize();

		return (await decodeAudio(output.target.buffer!)).channels[0]!;
	};

	test('a gap of 64 frames or more between samples is filled with silence', async () => {
		const channel = await encode([createSample(0, 4800, 0.25), createSample(0.11, 4800, 0.5)]);

		expect(channel.length).toBe(4800 + 480 + 4800);
		expect(channel[4799]).toBeCloseTo(0.25, 3);
		expect(channel.subarray(4800, 5280).every(x => x === 0)).toBe(true);
		expect(channel[5280]).toBeCloseTo(0.5, 3);
	});

	test('smaller gaps are closed up', async () => {
		const channel = await encode([createSample(0, 4800, 0.25), createSample(0.1005, 4800, 0.5)]);

		expect(channel.length).toBe(9600);
		expect(channel[4799]).toBeCloseTo(0.25, 3);
		expect(channel[4800]).toBeCloseTo(0.5, 3);
	});

	test('resampling many small samples stays continuous and sample-accurate', async () => {
		const inputSampleRate = 44100;
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const source = new AudioSampleSource({ codec: 'pcm-f32', transform: { sampleRate } });
		output.addAudioTrack(source);
		await output.start();

		// 2 s in 128-frame pieces, like an AudioWorklet delivers them
		const sampleCount = Math.round(2 * inputSampleRate / 128);
		for (let i = 0; i < sampleCount; i++) {
			const data = new Float32Array(128)
				.map((_, j) => 0.5 * Math.sin(2 * Math.PI * 440 * (i * 128 + j) / inputSampleRate));
			await source.add(new AudioSample({
				data,
				format: 'f32',
				numberOfChannels: 1,
				sampleRate: inputSampleRate,
				timestamp: i * 128 / inputSampleRate,
			}));
		}
		await output.finalize();

		const decoded = await decodeAudio(output.target.buffer!);
		const channel = decoded.channels[0]!;
		expect(decoded.sampleRate).toBe(sampleRate);
		expect(Math.abs(channel.length - sampleCount * 128 * sampleRate / inputSampleRate)).toBeLessThanOrEqual(1);

		let maxError = 0;
		for (let i = 100; i < channel.length - 100; i++) {
			const ideal = 0.5 * Math.sin(2 * Math.PI * 440 * i / sampleRate);
			maxError = Math.max(maxError, Math.abs(channel[i]! - ideal));
		}
		expect(maxError).toBeLessThan(0.005);
	});
});

describe('Output', () => {
	const pcmSample = (timestamp: number) => new AudioSample({
		data: new Float32Array(480),
		format: 'f32',
		numberOfChannels: 1,
		sampleRate: 48000,
		timestamp,
	});

	test('rejects media before start and after finalize', async () => {
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const source = new AudioSampleSource({ codec: 'pcm-s16' });
		output.addAudioTrack(source);

		await expectError(() => source.add(pcmSample(0)), /Output has not started/);
		expect(() => source.close()).toThrow(/before output has been started/);
		await expectError(() => output.finalize(), /Cannot finalize before starting/);

		await output.start();
		expect(() => output.addAudioTrack(new AudioSampleSource({ codec: 'pcm-s16' }))).toThrow(/after output/);
		expect(() => output.setMetadataTags({ title: 'Title' })).toThrow(/after output/);

		await source.add(pcmSample(0));
		await output.finalize();
		expect(output.state).toBe('finalized');
		await expectError(() => source.add(pcmSample(0.01)), /Output has been finalized/);
	});

	test('a canceled output cannot be started, finalized or fed', async () => {
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const source = new AudioSampleSource({ codec: 'pcm-s16' });
		output.addAudioTrack(source);
		await output.cancel();

		expect(output.state).toBe('canceled');
		await expectError(() => output.start(), /canceled/);
		await expectError(() => output.finalize(), /Cannot finalize after canceling/);
		await expectError(() => source.add(pcmSample(0)), /Output has been canceled/);
		await output.cancel(); // Idempotent
	});

	test('track count limits of the format are enforced', () => {
		const mp3Output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
		mp3Output.addAudioTrack(new EncodedAudioPacketSource('mp3'));
		expect(() => mp3Output.addAudioTrack(new EncodedAudioPacketSource('mp3')))
			.toThrow('MP3 does not support more than 1 audio track.');
		expect(() => mp3Output.addVideoTrack(new EncodedVideoPacketSource('avc')))
			.toThrow('MP3 does not support video tracks.');

		const tsOutput = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
		expect(() => tsOutput.addSubtitleTrack(new TextSubtitleSource('webvtt')))
			.toThrow('MPEG-TS does not support subtitle tracks.');

		const mkvOutput = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		for (let i = 0; i < 127; i++) {
			mkvOutput.addAudioTrack(new EncodedAudioPacketSource('opus'));
		}
		expect(() => mkvOutput.addAudioTrack(new EncodedAudioPacketSource('opus')))
			.toThrow('Matroska does not support more than 127 audio tracks.');
	});

	test('a minimum track count is required to start', async () => {
		const output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
		await expectError(() => output.start(), /MP3 requires exactly 1 audio track/);
	});

	test('codecs the format cannot hold are rejected with a hint', () => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		expect(() => output.addAudioTrack(new EncodedAudioPacketSource('pcm-u8')))
			.toThrow(/Codec 'pcm-u8' cannot be contained within MP4.*Switching to MOV/);

		const webmOutput = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		expect(() => webmOutput.addVideoTrack(new EncodedVideoPacketSource('avc')))
			.toThrow(/Switching to MKV/);
	});

	test('a source can only be connected to one track', () => {
		const source = new EncodedAudioPacketSource('opus');
		new Output({ format: new MkvOutputFormat(), target: new BufferTarget() }).addAudioTrack(source);
		const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		expect(() => output.addAudioTrack(source)).toThrow('Source is already used for a track.');
	});

	test('track metadata is validated', () => {
		const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		const addVideo = (metadata: object) => output.addVideoTrack(new EncodedVideoPacketSource('vp9'), metadata);

		expect(() => addVideo({ languageCode: 'en' })).toThrow(/ISO 639-2\/T/);
		expect(() => addVideo({ rotation: 45 })).toThrow(/Invalid video rotation/);
		expect(() => addVideo({ frameRate: 0 })).toThrow(/Invalid video frame rate/);
		expect(() => addVideo({ maximumPacketCount: 1.5 })).toThrow(/maximumPacketCount/);
		expect(() => addVideo({ bitrate: NaN })).toThrow(/bitrate/);
		expect(() => addVideo({ transformationMatrix: [1, 0, 0] })).toThrow(/transformationMatrix/);
		expect(output.tracks).toHaveLength(0);
	});

	for (const [formatName, createFormat] of [
		['MP4', () => new Mp4OutputFormat()],
		['Matroska', () => new MkvOutputFormat()],
		['WebM', () => new WebMOutputFormat()],
	] as const) {
		test(`encoded packets are validated before muxing into ${formatName}`, async () => {
			const decoderConfig = { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 };
			const packet = (type: 'key' | 'delta', timestamp: number) =>
				new EncodedPacket(new Uint8Array(4), type, timestamp, 0.1);

			const startOutput = async () => {
				const output = new Output({ format: createFormat(), target: new BufferTarget() });
				const source = new EncodedVideoPacketSource('vp9');
				output.addVideoTrack(source);
				await output.start();
				return { output, source };
			};

			{
				const { output, source } = await startOutput();
				await expectError(() => source.add(packet('delta', 0), { decoderConfig }), /must be a key packet/);
				await output.cancel();
			}
			{
				const { output, source } = await startOutput();
				await expectError(() => source.add(packet('key', 0)), /metadata must be provided/);
				await output.cancel();
			}
			{
				const { output, source } = await startOutput();
				await expectError(
					() => source.add(packet('key', 0), { decoderConfig: { ...decoderConfig, codec: 'avc1.42001f' } }),
					/does not fit to the track codec 'vp9'/,
				);
				await output.cancel();
			}
			{
				const { output, source } = await startOutput();
				await source.add(packet('key', 1), { decoderConfig });
				await source.add(packet('delta', 0.9)); // Fine within a GOP, think B-frames
				await expectError(() => source.add(packet('key', 0.5)), /largest timestamp of the previous GOP/);
				await output.cancel();
			}
		});
	}

	test('getMimeType names the codecs of all tracks', async () => {
		const cases: [() => OutputFormat, RegExp][] = [
			[() => new Mp4OutputFormat(), /^video\/mp4; codecs="avc1\.[0-9a-f]{6}, mp4a\.40\.2"$/],
			[() => new MovOutputFormat(), /^video\/quicktime; codecs="avc1\.[0-9a-f]{6}, mp4a\.40\.2"$/],
			[() => new MkvOutputFormat(), /^video\/x-matroska; codecs="avc1\.[0-9a-f]{6}, mp4a\.40\.2"$/],
			// MIME types are case-insensitive (RFC 2045), and both spellings of this one are in use
			[() => new MpegTsOutputFormat(), /^video\/(?:MP2T|mp2t); codecs="avc1\.[0-9a-f]{6}, mp4a\.40\.2"$/],
		];

		for (const [createFormat, mimeType] of cases) {
			using input = new Input({ source: new FilePathSource(publicFile('video.mp4')), formats: ALL_FORMATS });
			const { output } = await runConversion(input, createFormat());
			expect(await output.getMimeType()).toMatch(mimeType);
		}
	});
});

describe('Conversion API', () => {
	test('invalid options throw TypeErrors', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('video.mp4')), formats: ALL_FORMATS });
		const init = (options: Omit<ConversionOptions, 'input' | 'output'>) => Conversion.init({
			input,
			output: new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() }),
			...options,
		});

		await expect(init({ video: { width: 1.5 } })).rejects.toThrow(/width/);
		await expect(init({ video: { width: 100, height: 100 } })).rejects.toThrow(/fit must also be provided/);
		await expect(init({ video: { rotate: 45 as 0 } })).rejects.toThrow(/rotate/);
		await expect(init({ video: { frameRate: -1 } })).rejects.toThrow(/frameRate/);
		await expect(init({ video: { keyFrameInterval: -1 } })).rejects.toThrow(/keyFrameInterval/);
		await expect(init({ audio: { numberOfChannels: 0 } })).rejects.toThrow(/numberOfChannels/);
		await expect(init({ audio: { sampleRate: 44100.5 } })).rejects.toThrow(/sampleRate/);
		await expect(init({ trim: { start: 2, end: 1 } })).rejects.toThrow(/less than options.trim.end/);
		await expect(init({ trim: { start: Infinity } })).rejects.toThrow(/trim.start/);
		await expect(init({ copy: { shiftTolerance: -1 } })).rejects.toThrow(/shiftTolerance/);
		await expect(init({ tracks: 'some' as 'all' })).rejects.toThrow(/tracks/);
		// Options returned from callbacks are validated too
		await expect(init({ audio: () => ({ codec: 'nope' as 'aac' }) })).rejects.toThrow(/codec/);
	});

	test('execute runs once, refuses to run twice at a time and is a no-op once done', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('video.mp4')), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output });

		expect(conversion.state).toBe('idle');
		const promise = conversion.execute();
		expect(conversion.state).toBe('executing');
		await expect(conversion.execute()).rejects.toThrow(/still running/);
		await promise;

		expect(conversion.state).toBe('done');
		expect(output.state).toBe('finalized');
		await conversion.execute();
		await conversion.cancel(); // No-op once done
		expect(output.state).toBe('finalized');
	});

	test('a conversion canceled before executing throws ConversionCanceledError', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('video.mp4')), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output });

		await conversion.cancel();
		expect(conversion.state).toBe('canceled');
		expect(output.state).toBe('canceled');
		await expect(conversion.execute()).rejects.toBeInstanceOf(ConversionCanceledError);
	});

	test('canceling a suspended conversion cancels the output and rejects further execution', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('sample3.aac')), formats: ALL_FORMATS });
		const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output });

		await conversion.execute({ until: 10 });
		await conversion.cancel();

		expect(conversion.state).toBe('canceled');
		expect(output.state).toBe('canceled');
		await expect(conversion.execute()).rejects.toBeInstanceOf(ConversionCanceledError);
	});

	test('an invalid conversion refuses to execute and explains why', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('sample3.aac')), formats: ALL_FORMATS });
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, showWarnings: false });

		expect(conversion.isValid).toBe(false);
		await expect(conversion.execute()).rejects.toThrow(/output configuration is invalid/);
	});

	test('progress rises monotonically from 0 to 1, with the processed input time', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('video.mp4')), formats: ALL_FORMATS });
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, trim: { end: 3 } });

		const updates: [number, number][] = [];
		conversion.onProgress = (progress, processedTime) => updates.push([progress, processedTime]);
		await conversion.execute();

		expect(updates[0]).toEqual([0, 0]);
		expect(updates.at(-1)![0]).toBe(1);
		expect(updates.at(-1)![1]).toBeCloseTo(3, 1);
		for (let i = 1; i < updates.length; i++) {
			expect(updates[i]![0]).toBeGreaterThanOrEqual(updates[i - 1]![0]);
			expect(updates[i]![0]).toBeLessThanOrEqual(1);
		}
	});

	test('until suspends the conversion at an output timestamp', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('sample3.aac')), formats: ALL_FORMATS });
		const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output });

		await conversion.execute({ until: 10 });
		expect(conversion.state).toBe('idle');
		expect(output.state).toBe('started');

		await conversion.execute();
		expect(conversion.state).toBe('done');

		using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const summary = await summarizePackets((await outputInput.getPrimaryAudioTrack())!);
		expect(summary.count).toBe(4557);
	});

	test('metadata tags are copied, except for the creation time', async () => {
		const sourceOutput = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		sourceOutput.setMetadataTags({
			title: 'Title',
			artist: 'Artist',
			creationTime: new Date('2020-01-01T00:00:00Z'),
			raw: { CUSTOM: 'Value' },
		});
		const source = new EncodedAudioPacketSource('opus');
		sourceOutput.addAudioTrack(source);
		await sourceOutput.start();
		await source.add(new EncodedPacket(new Uint8Array([0xfc]), 'key', 0, 0.02), {
			decoderConfig: { codec: 'opus', numberOfChannels: 1, sampleRate: 48000 },
		});
		await sourceOutput.finalize();

		for (const [createFormat, keepsRawTags] of [
			[() => new MkvOutputFormat(), true],
			[() => new Mp4OutputFormat(), false],
		] as const) {
			using input = new Input({ source: new BufferSource(sourceOutput.target.buffer!), formats: ALL_FORMATS });
			const { output } = await runConversion(input, createFormat());

			using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
			const tags = await outputInput.getMetadataTags();
			expect(tags.title).toBe('Title');
			expect(tags.artist).toBe('Artist');
			expect(tags.creationTime?.getUTCFullYear()).not.toBe(2020);
			// Raw tags only make sense within the same format
			expect(tags.raw?.['CUSTOM'] !== undefined).toBe(keepsRawTags);
		}
	});

	test('the tags callback receives the input tags', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('video.mp4')), formats: ALL_FORMATS });
		const inputTags = await input.getMetadataTags();

		const { output } = await runConversion(input, new MkvOutputFormat(), {
			tags: (tags) => {
				expect(tags.title).toBe(inputTags.title);
				expect(tags.creationTime).toBeUndefined();
				return { title: 'Replaced' };
			},
		});

		using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		expect((await outputInput.getMetadataTags()).title).toBe('Replaced');
	});

	test('track language, name and disposition are copied', async () => {
		const sourceOutput = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		const sources = [new EncodedAudioPacketSource('opus'), new EncodedAudioPacketSource('opus')];
		sourceOutput.addAudioTrack(sources[0]!, {
			languageCode: 'fra',
			name: 'French',
			disposition: { default: false, forced: true, commentary: true },
		});
		sourceOutput.addAudioTrack(sources[1]!, {
			languageCode: 'deu',
			name: 'German',
			disposition: { default: true, hearingImpaired: true },
		});
		await sourceOutput.start();
		for (const source of sources) {
			await source.add(new EncodedPacket(new Uint8Array([0xfc]), 'key', 0, 0.02), {
				decoderConfig: { codec: 'opus', numberOfChannels: 1, sampleRate: 48000 },
			});
		}
		await sourceOutput.finalize();

		using input = new Input({ source: new BufferSource(sourceOutput.target.buffer!), formats: ALL_FORMATS });
		const { output } = await runConversion(input, new MkvOutputFormat());

		using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const [french, german] = await outputInput.getAudioTracks();
		expect(await french!.getLanguageCode()).toBe('fra');
		expect(await french!.getName()).toBe('French');
		expect(await french!.getDisposition()).toMatchObject({ default: false, forced: true, commentary: true });
		expect(await german!.getLanguageCode()).toBe('deu');
		expect(await german!.getName()).toBe('German');
		expect(await german!.getDisposition()).toMatchObject({ default: true, hearingImpaired: true });
	});

	test('maximumPacketCount is estimated only when the format requires it, and holds every packet', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('video.mp4')), formats: ALL_FORMATS });

		const { output: regularOutput } = await runConversion(input, new Mp4OutputFormat());
		expect(regularOutput.tracks.map(x => x.metadata.maximumPacketCount)).toEqual([undefined, undefined]);

		const { output } = await runConversion(input, new Mp4OutputFormat({ fastStart: 'reserve' }));
		const counts = output.tracks.map(x => x.metadata.maximumPacketCount!);
		expect(counts[0]).toBeGreaterThanOrEqual(125);
		expect(counts[1]).toBeGreaterThanOrEqual(237);
	});

	test('a manual maximumPacketCount takes precedence', async () => {
		using input = new Input({ source: new FilePathSource(publicFile('sample3.aac')), formats: ALL_FORMATS });
		const { output } = await runConversion(input, new Mp4OutputFormat({ fastStart: 'reserve' }), {
			audio: { maximumPacketCount: 5000 },
		});

		expect(output.tracks[0]!.metadata.maximumPacketCount).toBe(5000);
	});
});
