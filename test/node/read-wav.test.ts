import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, CustomSource, EncodedPacketSink, Input, FilePathSource } from '../../src/index.js';

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

test('WAVE files past 4 GiB whose sizes are 0xFFFFFFFF are read to the end', async () => {
	// FFmpeg leaves the RIFF and data sizes at 0xFFFFFFFF when they don't fit into 32 bits (and when writing to a
	// pipe). This is 5 GiB of 16-bit stereo at 48 kHz: such a header, then silence.
	const header = new Uint8Array(44);
	const view = new DataView(header.buffer);
	header.set(new TextEncoder().encode('RIFF'), 0);
	view.setUint32(4, 0xffffffff, true);
	header.set(new TextEncoder().encode('WAVEfmt '), 8);
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 2, true); // Channels
	view.setUint32(24, 48000, true); // Sample rate
	view.setUint32(28, 4 * 48000, true); // Bytes per second
	view.setUint16(32, 4, true); // Block align
	view.setUint16(34, 16, true); // Bits per sample
	header.set(new TextEncoder().encode('data'), 36);
	view.setUint32(40, 0xffffffff, true);

	const fileSize = 5 * 2 ** 30;
	using input = new Input({
		source: new CustomSource({
			getSize: () => fileSize,
			read: (start, end) => {
				const bytes = new Uint8Array(end - start);
				if (start < header.length) {
					bytes.set(header.subarray(start, Math.min(end, header.length)));
				}
				return bytes;
			},
		}),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	const duration = (fileSize - header.length) / 4 / 48000; // ~7.8 hours

	expect(await track.getDurationFromMetadata()).toBeCloseTo(duration, 6);
	expect(await input.computeDuration()).toBeCloseTo(duration, 6);

	const lastPacket = (await new EncodedPacketSink(track).getPacket(duration, { metadataOnly: true }))!;
	expect(lastPacket.timestamp + lastPacket.duration).toBeCloseTo(duration, 6);
});
