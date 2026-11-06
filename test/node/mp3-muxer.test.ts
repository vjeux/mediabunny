import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { Mp3OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { assert, uint8ArraysAreEqual } from '../../src/misc.js';
import { Conversion } from '../../src/conversion.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Muxing without Xing header', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/Toothsome-Meme.VBRv2.mp3')),
		formats: ALL_FORMATS,
	});

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);

	const output = new Output({
		format: new Mp3OutputFormat({ xingHeader: false }),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('mp3');
	output.addAudioTrack(source);
	await output.start();

	let inputPacketCount = 0;
	for await (const packet of new EncodedPacketSink(inputTrack).packets()) {
		await source.add(packet);
		inputPacketCount++;
	}

	await output.finalize();

	using outputInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputTrack = await outputInput.getPrimaryAudioTrack();
	assert(outputTrack);

	let outputPacketCount = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (const packet of new EncodedPacketSink(outputTrack).packets()) {
		outputPacketCount++;
	}

	expect(inputPacketCount).toBeGreaterThan(0);
	expect(outputPacketCount).toBe(inputPacketCount);
});

test('Conversion copies an MP3 whose first packet carries encoder priming', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/Toothsome-Meme.VBRv2.mp3')),
		formats: ALL_FORMATS,
	});

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);
	// The LAME delay puts the first packet before zero
	expect(await inputTrack.getFirstTimestamp()).toBeCloseTo(-1105 / 24000);

	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	expect(conversion.discardedTracks.map(x => x.reason)).toEqual([]);
	await conversion.execute();

	using outputInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputTrack = await outputInput.getPrimaryAudioTrack();
	assert(outputTrack);

	const inputPackets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(inputTrack).packets()) {
		inputPackets.push(packet);
	}

	const outputPackets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(outputTrack).packets()) {
		outputPackets.push(packet);
	}

	// Copied as-is, with the priming carried over into the new LAME header
	expect(outputPackets.map(x => x.timestamp)).toEqual(inputPackets.map(x => x.timestamp));
	expect(outputPackets.every((x, i) => uint8ArraysAreEqual(x.data, inputPackets[i]!.data))).toBe(true);
});
