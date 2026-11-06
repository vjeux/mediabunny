import { describe, expect, test } from 'vitest';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { FlacOutputFormat, Mp3OutputFormat, OutputFormat } from '../../src/output-format.js';
import { AudioCodec } from '../../src/codec.js';
import { channelToneMap, createTones, decodeTrack, encodeAudio, triangle } from './helpers/l13-audio.js';

registerAacEncoder();
registerMp3Encoder();
registerFlacEncoder();

const decodeBytes = async (bytes: Uint8Array) => {
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	return await decodeTrack(track);
};

/**
 * Encodes one tone per channel, starting after a quarter second of silence, decodes the result with the browser's own
 * decoder, and reports which tone each channel carries and how far (in samples) the onset moved.
 */
const roundTrip = async (
	codec: AudioCodec,
	numberOfChannels: number,
	sampleRate: number,
	bitrate: number,
	outputFormat?: OutputFormat,
) => {
	const onset = Math.floor(sampleRate / 4);
	const data = createTones(sampleRate, numberOfChannels, sampleRate);
	data.fill(0, 0, onset * numberOfChannels);

	const bytes = await encodeAudio({ codec, data, numberOfChannels, sampleRate, bitrate, outputFormat });
	const decoded = await decodeBytes(bytes);
	expect(decoded.numberOfChannels).toBe(numberOfChannels);
	expect(decoded.sampleRate).toBe(sampleRate);

	let firstAudible = -1;
	for (let i = 0; firstAudible === -1 && i < decoded.data.length / numberOfChannels; i++) {
		for (let channel = 0; channel < numberOfChannels; channel++) {
			if (Math.abs(decoded.data[i * numberOfChannels + channel]!) > 0.02) {
				firstAudible = i;
				break;
			}
		}
	}

	const startInSamples = Math.round(decoded.timestamps[0]! * sampleRate);
	return {
		onsetError: startInSamples + firstAudible - onset,
		channelMap: channelToneMap(decoded.data, numberOfChannels, sampleRate, sampleRate / 2 - startInSamples, 4096),
	};
};

const identity = (n: number) => [...Array(n).keys()];

describe('AAC encoder output, decoded by the browser', () => {
	test('keeps every channel in place (1, 2, 5, 6 and 8 channels)', async () => {
		for (const numberOfChannels of [1, 2, 5, 6, 8]) {
			const { channelMap } = await roundTrip('aac', numberOfChannels, 48000, 64000 * numberOfChannels);
			expect(channelMap, `${numberOfChannels} channels`).toEqual(identity(numberOfChannels));
		}
	});

	test('starts on time, as the encoder delay is signaled and trimmed', async () => {
		for (const [numberOfChannels, sampleRate] of [[1, 48000], [2, 48000], [2, 44100], [5, 48000]]) {
			const { onsetError } = await roundTrip('aac', numberOfChannels!, sampleRate!, 64000 * numberOfChannels!);
			expect(Math.abs(onsetError), `${numberOfChannels} channels at ${sampleRate} Hz`).toBeLessThanOrEqual(4);
		}
	});
});

describe('MP3 encoder output, decoded by the browser', () => {
	test('keeps both channels in place and starts on time at every MPEG version', async () => {
		for (const [numberOfChannels, sampleRate, bitrate] of [
			[1, 44100, 128000],
			[2, 48000, 192000],
			[2, 22050, 64000],
			[1, 8000, 16000],
		]) {
			const label = `${numberOfChannels} channels at ${sampleRate} Hz`;
			const { onsetError, channelMap } = await roundTrip(
				'mp3',
				numberOfChannels!,
				sampleRate!,
				bitrate!,
				new Mp3OutputFormat(),
			);
			expect(channelMap, label).toEqual(identity(numberOfChannels!));
			// The LAME encoder delay plus the decoder delay is signaled through a negative first timestamp
			expect(Math.abs(onsetError), label).toBeLessThanOrEqual(4);
		}
	});
});

describe('FLAC encoder output, decoded by the browser', () => {
	const PERIODS = [218, 145, 109, 873, 87, 73, 61, 53];

	test('is bit-exact for 16-bit input, in FLAC files and in MP4', async () => {
		for (const [numberOfChannels, sampleRate, container] of [
			[1, 44100, 'flac'],
			[2, 48000, 'flac'],
			[6, 96000, 'flac'],
			[8, 44100, 'flac'],
			[2, 48000, 'mp4'],
		] as const) {
			const frames = 10000;
			const data = new Int16Array(frames * numberOfChannels);
			for (let n = 0; n < frames; n++) {
				for (let channel = 0; channel < numberOfChannels; channel++) {
					data[n * numberOfChannels + channel] = triangle(n, PERIODS[channel]!, 20000) + (n % 5) - 2;
				}
			}

			const bytes = await encodeAudio({
				codec: 'flac',
				data,
				format: 's16',
				numberOfChannels,
				sampleRate,
				// MP4 is the encoder helper's default
				outputFormat: container === 'flac' ? new FlacOutputFormat() : undefined,
			});
			const decoded = await decodeBytes(bytes);
			expect(decoded.data.length).toBe(data.length);

			let mismatches = 0;
			for (let i = 0; i < data.length; i++) {
				if (Math.round(decoded.data[i]! * 32768) !== data[i]) {
					mismatches++;
				}
			}
			expect(mismatches, `${numberOfChannels} channels at ${sampleRate} Hz in ${container}`).toBe(0);
		}
	});

	test('is bit-exact for 24-bit input', async () => {
		const frames = 10000;
		const numberOfChannels = 2;
		const data = new Float32Array(frames * numberOfChannels);
		const expected = new Int32Array(frames * numberOfChannels);
		for (let n = 0; n < frames; n++) {
			for (let channel = 0; channel < numberOfChannels; channel++) {
				const value = triangle(n, PERIODS[channel]!, 6_000_000) + (n % 7) - 3;
				expected[n * numberOfChannels + channel] = value;
				data[n * numberOfChannels + channel] = value / 2 ** 23; // Exactly representable
			}
		}

		const bytes = await encodeAudio({
			codec: 'flac',
			data,
			numberOfChannels,
			sampleRate: 48000,
			outputFormat: new FlacOutputFormat(),
		});
		const decoded = await decodeBytes(bytes);
		expect(decoded.data.length).toBe(expected.length);

		let mismatches = 0;
		for (let i = 0; i < expected.length; i++) {
			if (Math.round(decoded.data[i]! * 2 ** 23) !== expected[i]) {
				mismatches++;
			}
		}
		expect(mismatches).toBe(0);
	});
});
