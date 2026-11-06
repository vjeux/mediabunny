import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	AudioSampleSink,
	BufferSource,
	EncodedPacketSink,
	Input,
	FilePathSource,
} from '../../src/index.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Reads the format of WAVE_FORMAT_EXTENSIBLE files only from GUIDs that hold a format tag', async () => {
	const u16 = (value: number) => [value & 0xff, value >> 8];
	const u32 = (value: number) => [...u16(value & 0xffff), ...u16(value >>> 16)];
	const fourCc = (text: string) => [...text].map(char => char.charCodeAt(0));

	// A GUID in its binary layout: a first field, then 12 bytes
	const guid = (firstField: number, rest: number[]) => [...u32(firstField), ...rest];
	const KSDATAFORMAT_SUBTYPE = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
	const AMBISONIC_B_FORMAT_SUBTYPE = [0x21, 0x07, 0xd3, 0x11, 0x86, 0x44, 0xc8, 0xc1, 0xca, 0x00, 0x00, 0x00];

	// Reads a 16-bit mono WAVE_FORMAT_EXTENSIBLE file with the given sub-format GUID and two samples
	const read = async (subFormat: number[]) => {
		const fmt = [
			...u16(0xfffe), ...u16(1), ...u32(48000), ...u32(96000), ...u16(2), ...u16(16),
			...u16(22), // cbSize
			...u16(16), // Valid bits per sample
			...u32(4), // Channel mask: front center
			...subFormat,
		];
		const samples = [...u16(0x1234), ...u16(0x10000 - 0x1234)];
		const bytes = new Uint8Array([
			...fourCc('RIFF'), ...u32(4 + 8 + fmt.length + 8 + samples.length), ...fourCc('WAVE'),
			...fourCc('fmt '), ...u32(fmt.length), ...fmt,
			...fourCc('data'), ...u32(samples.length), ...samples,
		]);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		try {
			const track = await input.getPrimaryAudioTrack();
			assert(track);
			const decoded: number[] = [];
			for await (using sample of new AudioSampleSink(track).samples()) {
				const data = new Int16Array(sample.numberOfFrames);
				sample.copyTo(data, { planeIndex: 0, format: 's16' });
				decoded.push(...data);
			}
			return { codec: await track.getCodec(), decoded };
		} catch (error) {
			return (error as Error).message;
		}
	};

	// KSDATAFORMAT_SUBTYPE_PCM, and the same for Ambisonic B-format (like FFmpeg reads it)
	const pcm = { codec: 'pcm-s16', decoded: [0x1234, -0x1234] };
	expect(await read(guid(0x0001, KSDATAFORMAT_SUBTYPE))).toEqual(pcm);
	expect(await read(guid(0x0001, AMBISONIC_B_FORMAT_SUBTYPE))).toEqual(pcm);

	// GUIDs of other formats, whose first two bytes happen to be those of the PCM format tag
	expect(await read(guid(0x10001, KSDATAFORMAT_SUBTYPE))).toEqual(
		expect.stringContaining('Unsupported WAVE codec (format tag 65537)'),
	);
	expect(await read(guid(0x0001, [...KSDATAFORMAT_SUBTYPE.slice(0, -1), 0x72]))).toEqual(
		expect.stringContaining('Unsupported WAVE codec (sub-format GUID {00000001-0000-0010-8000-00aa00389b72})'),
	);
});

test('Should handle WAV file with oversized ID3 chunk', async () => {
	const filePath = path.join(__dirname, '..', 'public/oversized-id3.wav');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track found');
	}

	const sink = new EncodedPacketSink(track);

	for await (const packet of sink.packets()) {
		void packet;
	}
});
