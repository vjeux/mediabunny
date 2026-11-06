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

test('WAV samples at timestamps keep their timing when decoding restarts', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track found');
	}

	const packets: { timestamp: number; duration: number }[] = [];
	for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
		packets.push({ timestamp: packet.timestamp, duration: packet.duration });
	}
	const within = (index: number, fraction: number) => packets[index]!.timestamp + fraction * packets[index]!.duration;

	// Timestamps that skip a packet or go back within one make the sink restart decoding at that packet
	const queries: number[] = [];
	const expected: number[] = [];
	for (let i = 1; i < 100; i += 3) {
		queries.push(within(i, 0.6), within(i + 2, 0.6), within(i + 2, 0.2));
		expected.push(packets[i]!.timestamp, packets[i + 2]!.timestamp, packets[i + 2]!.timestamp);
	}

	let index = 0;
	for await (using sample of new AudioSampleSink(track).samplesAtTimestamps(queries)) {
		expect(sample, `sample at ${queries[index]}`).not.toBe(null);
		expect(sample!.timestamp, `sample at ${queries[index]}`).toBeCloseTo(expected[index]!, 6);
		index++;
	}
	expect(index).toBe(queries.length);
});
