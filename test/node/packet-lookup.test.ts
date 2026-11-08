import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from '../../src/index.js';
import { roundIfAlmostInteger } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Packet lookups treat float noise around zero like float noise around any other timestamp', async () => {
	// A timestamp computed with floats can land a hair below a packet's timestamp. Lookups snap it onto the packet's
	// timestamp, but didn't when that timestamp is 0
	const justBelowZero = 0.3 - 0.1 - 0.1 - 0.1; // -2.7755575615628914e-17

	for (const name of ['video.mp4', 'frames.webm', 'no-aud.ts']) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '..', 'public', name)),
			formats: ALL_FORMATS,
		});
		const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
		expect((await sink.getPacket(0))?.timestamp, name).toBe(0);
		expect((await sink.getPacket(justBelowZero))?.timestamp, name).toBe(0);
	}
});

test('roundIfAlmostInteger snaps float noise near zero too', () => {
	// The end of a packet that starts before zero, in milliseconds (Matroska) and in samples at 44.1 kHz (an MP4 with
	// an edit list), and float noise below zero in 90 kHz ticks (MPEG-TS)
	expect(roundIfAlmostInteger((-0.025 + 0.026) * 1000)).toBe(1);
	expect(roundIfAlmostInteger((-1146 / 44100 + 1152 / 44100) * 44100)).toBe(6);
	expect(roundIfAlmostInteger((0.3 - 0.1 - 0.1 - 0.1) * 90000)).toBe(0);

	// What isn't float noise stays as is
	expect(roundIfAlmostInteger(0.001)).toBe(0.001);
	expect(roundIfAlmostInteger(-0.4)).toBe(-0.4);
	expect(roundIfAlmostInteger(2.5)).toBe(2.5);
	expect(roundIfAlmostInteger(1e9 + 0.5)).toBe(1e9 + 0.5);
});
