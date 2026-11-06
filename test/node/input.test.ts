import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input, UnsupportedInputFormatError } from '../../src/input.js';
import { ALL_FORMATS, MP3, MPEG_TS } from '../../src/input-format.js';
import { BufferSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Disposing after failed format detection does not emit an unhandled rejection', async () => {
	const input = new Input({
		source: new BufferSource(new Uint8Array([1, 2, 3, 4])),
		formats: ALL_FORMATS,
	});

	await expect(input.getFormat()).rejects.toThrow(UnsupportedInputFormatError);

	const unhandledRejections: unknown[] = [];
	const onUnhandledRejection = (reason: unknown) => {
		unhandledRejections.push(reason);
	};

	process.on('unhandledRejection', onUnhandledRejection);
	try {
		input.dispose();
		await new Promise(resolve => setTimeout(resolve, 0));
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	expect(unhandledRejections).toEqual([]);
});

test('Detects MP3 data that starts in the middle of a frame', async () => {
	// Cut out of a file, like a stream recorded from an arbitrary byte. The partial frame it starts with contains
	// bytes that look like frame headers.
	const file = new Uint8Array(readFileSync(path.join(__dirname, '../public/Toothsome-Meme.VBRv2.mp3')));
	const bytes = file.subarray(120497);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP3);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getSampleRate()).toBe(24000);

	// Like FFmpeg, start at the first whole frame, at byte 163
	const sink = new EncodedPacketSink(audioTrack);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);
	expect(firstPacket.data).toEqual(bytes.subarray(163, 163 + firstPacket.data.byteLength));

	let packetCount = 0;
	for await (const packet of sink.packets()) {
		expect(packet.timestamp).toBe(packetCount * 576 / 24000);
		packetCount++;
	}
	expect(packetCount).toBe(1158);
});

test('Detects MP3 data whose channel mode changes right after the first frame', async () => {
	// Silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz): one mono frame, then joint stereo. The channel mode may
	// change from frame to frame, so the first frame still counts as confirmed by the one after it.
	const modes = [3, 1, 1, 1];
	const bytes = new Uint8Array(modes.length * 417);
	modes.forEach((mode, i) => bytes.set([0xff, 0xfb, 0x90, mode << 6], i * 417));

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP3);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	const firstPacket = await new EncodedPacketSink(audioTrack).getFirstPacket();
	assert(firstPacket);
	expect(firstPacket.timestamp).toBe(0);
	expect(firstPacket.data).toEqual(bytes.subarray(0, 417));
});

test('Does not take the MP3 frames inside MPEG-TS for an MP3 file', async () => {
	// 8 kbps MP3 at 16 kHz in MPEG-TS, made with FFmpeg's libmp3lame and mpegts muxer. Its 36-byte frames come in runs
	// within a single TS packet, which is checked before MPEG-TS.
	using input = new Input({
		source: new BufferSource(new Uint8Array(readFileSync(path.join(__dirname, '../public/mp3-8kbps.ts')))),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MPEG_TS);
});
