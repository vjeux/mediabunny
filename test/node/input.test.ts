import { expect, test } from 'vitest';
import { Input, UnsupportedInputFormatError } from '../../src/input.js';
import { ADTS, ALL_FORMATS, InputFormat, MP3 } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { BufferSource, ReadableStreamSource } from '../../src/source.js';

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

test('MP3 frames after a run of zero bytes, like a zeroed-out ID3v2 tag, are recognized', async () => {
	// MPEG-1 Layer III, 128 kbit/s, 44.1 kHz frames of 417 bytes
	const frame = new Uint8Array(417);
	frame.set([0xff, 0xfb, 0x90, 0x00]);
	const frames = [frame, frame, frame];
	const id3v2Tag = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10, ...new Uint8Array(10)]);

	for (const prefix of [[id3v2Tag, new Uint8Array(8192)], [new Uint8Array(65536)]]) {
		const parts = [...prefix, ...frames];
		const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
		let offset = 0;
		for (const part of parts) {
			bytes.set(part, offset);
			offset += part.length;
		}

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		expect(await input.getFormat()).toBe(MP3);

		let packetCount = 0;
		for await (const packet of new EncodedPacketSink((await input.getPrimaryAudioTrack())!).packets()) {
			void packet;
			packetCount++;
		}
		expect(packetCount).toBe(3);
	}
});

test('The format of a live MP3 or ADTS stream is known from its first frames', async () => {
	// The first 8 kB of a live stream (internet radio, a recording in progress), which stays open
	const getFormatOfLiveStream = async (frame: Uint8Array) => {
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				for (let i = 0; i < 8000 / frame.length; i++) {
					controller.enqueue(frame);
				}
			},
		});
		using input = new Input({ source: new ReadableStreamSource(stream), formats: ALL_FORMATS });
		return await Promise.race([
			input.getFormat(),
			new Promise<string>(resolve => setTimeout(() => resolve('still pending after 2 s'), 2000)),
		]);
	};

	// MPEG-1 Layer III, 128 kbit/s, 44.1 kHz frames of 417 bytes. Skipping zero bytes mustn't ask for more data than
	// a frame header needs: a source of unknown size only resolves a slice once all of it has come in
	const mp3Frame = new Uint8Array(417);
	mp3Frame.set([0xff, 0xfb, 0x90, 0x00]);
	expect<InputFormat | string>(await getFormatOfLiveStream(mp3Frame)).toBe(MP3);

	// AAC-LC, 44.1 kHz stereo ADTS frames of 200 bytes. MP3 detection runs first, so it would block these too
	const adtsFrame = new Uint8Array(200);
	adtsFrame.set([0xff, 0xf1, 0x50, 0x80 | (200 >> 11), (200 >> 3) & 0xff, ((200 & 7) << 5) | 0x1f, 0xfc]);
	expect<InputFormat | string>(await getFormatOfLiveStream(adtsFrame)).toBe(ADTS);
});
