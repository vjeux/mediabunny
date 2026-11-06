import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
	ALL_FORMATS,
	BufferSource,
	CustomSource,
	EncodedPacketSink,
	FilePathSource,
	Input,
} from '../../src/index.js';
import { assert, toUint8Array } from '../../src/misc.js';
import { parseAacAudioSpecificConfig } from '../../shared/aac-misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Zero-width unsigned integers', async () => {
	const filePath = path.join(__dirname, '..', 'public/zero-width-uint.webm');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	expect(await input.getTracks()).toHaveLength(1);
});

test('Zero timestamp scale', async () => {
	const filePath = path.join(__dirname, '..', 'public/zero-timestamp-scale.webm');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	await expect(input.getTracks()).rejects.toThrow(/TimestampScale/);
});

test('Concurrent metadata tag reads', async () => {
	const filePath = path.join(__dirname, '..', 'public/tags-after-clusters.webm');
	const buffer = await fs.promises.readFile(filePath);

	// Async reads, so that both calls are in the middle of loading the tags at the same time
	using input = new Input({
		source: new CustomSource({
			getSize: async () => buffer.byteLength,
			read: async (start, end) => buffer.subarray(start, end),
		}),
		formats: ALL_FORMATS,
	});

	const [first, second] = await Promise.all([input.getMetadataTags(), input.getMetadataTags()]);
	expect(first.title).toBe('Hi');
	expect(second.title).toBe('Hi');
});

test('Key packet lookup past position cache entries', async () => {
	// 0.5 s clusters with a key frame (and cue point) only every 10 s
	const filePath = path.join(__dirname, '..', 'public/sparse-keyframes-dense-clusters.mkv');
	const buffer = await fs.promises.readFile(filePath);

	let bytesRead = 0;
	using input = new Input({
		source: new CustomSource({
			getSize: () => buffer.byteLength,
			read: (start, end) => {
				bytesRead += end - start;
				return buffer.subarray(start, end);
			},
			maxCacheSize: Infinity,
		}),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	// Leaves the position cache with an entry at the start and dense entries from the cue point at 50 s up to 55.3 s
	await sink.getFirstPacket();
	await sink.getPacket(55.3);

	bytesRead = 0;
	const keyPacket = await sink.getKeyPacket(55.29);
	expect(keyPacket?.timestamp).toBe(50);
	expect(bytesRead).toBeLessThan(0.05 * buffer.byteLength);
});

test('Deprecated A_AAC codec IDs without CodecPrivate', async () => {
	// Old mkvmerge versions named the AAC profile in the codec ID and wrote no AudioSpecificConfig
	const element = (id: number[], ...parts: ArrayLike<number>[]) => {
		const content = parts.flatMap(part => Array.from(part));
		const size = [0x01, 0, 0, 0, 0, 0, content.length >> 8, content.length & 0xff]; // 8-byte vint
		return [...id, ...size, ...content];
	};
	const float64 = (value: number) => {
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setFloat64(0, value);
		return bytes;
	};
	const file = (codecId: string, outputSamplingFrequency: number | null = null) => new Uint8Array([
		...element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], [...'matroska'].map(char => char.charCodeAt(0)))),
		...element([0x18, 0x53, 0x80, 0x67],
			element([0x16, 0x54, 0xae, 0x6b], element([0xae],
				element([0xd7], [1]), // TrackNumber
				element([0x83], [2]), // TrackType: audio
				element([0x86], [...codecId].map(char => char.charCodeAt(0))),
				element([0xe1],
					element([0xb5], float64(22050)), // SamplingFrequency
					...(outputSamplingFrequency === null
						? []
						: [element([0x78, 0xb5], float64(outputSamplingFrequency))]), // OutputSamplingFrequency
					element([0x9f], [2]), // Channels: stereo
				),
			)),
			element([0x1f, 0x43, 0xb6, 0x75], element([0xe7], [0]), element([0xa3], [0x81, 0, 0, 0x80, 0x21, 0x10])),
		),
	]);

	const expectations = [
		['A_AAC/MPEG4/LC/SBR', 'mp4a.40.5'],
		['A_AAC/MPEG4/LC', 'mp4a.40.2'],
		['A_AAC/MPEG4/MAIN', 'mp4a.40.1'],
		['A_AAC/MPEG4/LTP', 'mp4a.40.4'],
		['A_AAC/MPEG2/LC', 'mp4a.67'],
	];
	for (const [codecId, codecString] of expectations) {
		using input = new Input({ source: new BufferSource(file(codecId!)), formats: ALL_FORMATS });
		const track = (await input.getAudioTracks())[0];
		assert(track);

		expect(await track.getCodec()).toBe('aac');
		expect(await track.getCodecParameterString()).toBe(codecString);
		expect(await input.getMimeType()).toBe(`audio/x-matroska; codecs="${codecString}"`);
	}

	// SamplingFrequency is the core coder's rate, and OutputSamplingFrequency (defaulting to it) the rate after SBR
	const rates = [
		// Codec ID, OutputSamplingFrequency, expected core rate, expected output rate
		['A_AAC/MPEG4/LC', 22050, 22050, 22050],
		['A_AAC/MPEG4/LC/SBR', 44100, 22050, 44100],
		['A_AAC/MPEG4/LC/SBR', 22050, 22050, 22050], // Downsampled SBR
		['A_AAC/MPEG4/LC/SBR', null, 22050, 22050],
	] as const;
	for (const [codecId, outputSamplingFrequency, coreSampleRate, outputSampleRate] of rates) {
		using input = new Input({
			source: new BufferSource(file(codecId, outputSamplingFrequency)),
			formats: ALL_FORMATS,
		});
		const track = (await input.getAudioTracks())[0];
		assert(track);

		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig?.description);
		const audioSpecificConfig = parseAacAudioSpecificConfig(toUint8Array(decoderConfig.description));
		expect(audioSpecificConfig.coreSampleRate).toBe(coreSampleRate);
		expect(audioSpecificConfig.outputSampleRate).toBe(outputSampleRate);
		expect(decoderConfig.sampleRate).toBe(outputSampleRate);
		expect(await track.getSampleRate()).toBe(outputSampleRate);
	}
});
