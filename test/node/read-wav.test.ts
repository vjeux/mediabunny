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

test('Reads RIFX samples as big-endian', async () => {
	const fourCc = (text: string) => [...text].map(char => char.charCodeAt(0));
	const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];

	// RIFX is RIFF with all integers stored big-endian, the samples included
	const samples = [0x1234, -0x1234, 0x0102, -0x7fff];
	const data = samples.flatMap(sample => u16(sample));
	const body = [
		...fourCc('WAVE'),
		...fourCc('fmt '), ...u32(16), ...u16(1), ...u16(2), ...u32(44100), ...u32(44100 * 4), ...u16(4), ...u16(16),
		...fourCc('data'), ...u32(data.length), ...data,
	];

	using input = new Input({
		source: new BufferSource(new Uint8Array([...fourCc('RIFX'), ...u32(body.length), ...body])),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getCodec()).toBe('pcm-s16be');

	const sample = await new AudioSampleSink(track).getSample(0);
	assert(sample);
	const decoded = new Int16Array(sample.numberOfFrames * sample.numberOfChannels);
	sample.copyTo(decoded, { planeIndex: 0, format: 's16' });
	sample.close();

	expect([...decoded]).toEqual(samples);
});
