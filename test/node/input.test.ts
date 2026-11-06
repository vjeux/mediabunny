import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input, UnsupportedInputFormatError } from '../../src/input.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';

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

test('ADTS with ID3v2 tags between its frames is detected and read in full', async () => {
	// Packed audio, like HLS segments, can carry timed ID3 metadata between the ADTS frames
	const aac = new Uint8Array(readFileSync(path.join(__dirname, '../public/sample3.aac')));
	const frames: Uint8Array[] = [];
	let pos = 0;
	while (frames.length < 10) {
		const frameLength = ((aac[pos + 3]! & 0x03) << 11) | (aac[pos + 4]! << 3) | (aac[pos + 5]! >> 5);
		frames.push(aac.subarray(pos, pos + frameLength));
		pos += frameLength;
	}

	// An ID3v2.4 tag with one TXXX frame (description "a", value "b") before the first frame, right after it, and
	// after every other frame from then on
	const tag = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 15, 0x54, 0x58, 0x58, 0x58, 0, 0, 0, 5, 0, 0, 0, 0x61, 0, 0x62, 0];
	const file = new Uint8Array(frames.flatMap((frame, i) => i === 0 || i % 2 === 1 ? [...tag, ...frame] : [...frame]));

	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	expect(await input.getFormat()).toBe(ADTS);
	expect((await input.getMetadataTags()).raw!['TXXX']).toEqual({ a: 'b' });

	const track = (await input.getPrimaryAudioTrack())!;
	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual(frames.map((_, i) => i * 1024 / 44100));
});
