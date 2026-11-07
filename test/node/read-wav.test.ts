import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, AudioSampleSink, EncodedPacketSink, Input, FilePathSource } from '../../src/index.js';

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

test('Finds the WAV packet and sample at each packet\'s own timestamp', async () => {
	// 44.1 kHz with 2048-frame packets, where timestamps like 30720 / 44100 s convert back to a hair below their
	// packet's first frame
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track found');
	}

	const packetSink = new EncodedPacketSink(track);
	const sampleSink = new AudioSampleSink(track);

	let packetCount = 0;
	for await (const packet of packetSink.packets(undefined, undefined, { metadataOnly: true })) {
		const found = await packetSink.getPacket(packet.timestamp, { metadataOnly: true });
		expect(found?.sequenceNumber, `packet at ${packet.timestamp} s`).toBe(packet.sequenceNumber);

		const sample = await sampleSink.getSample(packet.timestamp);
		expect(sample && Math.round(sample.timestamp * 44100), `sample at ${packet.timestamp} s`)
			.toBe(Math.round(packet.timestamp * 44100));
		sample?.close();

		packetCount++;
	}
	expect(packetCount).toBe(208);
});
