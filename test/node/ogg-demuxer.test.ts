import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { OggOutputFormat } from '../../src/output-format.js';
import { EncodedPacket } from '../../src/packet.js';
import { CustomSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

test('Lookups past the end of a logical stream that ends early don\'t scan the rest of the file again', async () => {
	// Two Opus streams over 3 minutes; the second one ends after 18 seconds, like a commentary track
	const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
	const mainSource = new EncodedAudioPacketSource('opus');
	const shortSource = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(mainSource);
	output.addAudioTrack(shortSource);
	await output.start();

	const decoderConfig = {
		codec: 'opus',
		numberOfChannels: 2,
		sampleRate: 48000,
		// OpusHead: version 1, 2 channels, 312 samples of pre-skip, 48 kHz, no gain, channel mapping family 0
		description: new Uint8Array([
			0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0,
		]),
	};
	const frameDuration = 0.02;
	const count = Math.round(180 / frameDuration);
	const data = new Uint8Array(300).fill(0xfc);
	for (let i = 0; i < count; i++) {
		await mainSource.add(new EncodedPacket(data, 'key', i * frameDuration, frameDuration), { decoderConfig });
		if (i < count / 10) {
			await shortSource.add(new EncodedPacket(data, 'key', i * frameDuration, frameDuration), { decoderConfig });
		}
		if (i === Math.ceil(count / 10)) {
			shortSource.close();
		}
	}
	await output.finalize();

	// Wherever the muxer put the short stream's last (EOS) page, move it to the end of the file, so that the next page
	// of that stream after the others comes only after all the pages of the other one
	const muxed = new Uint8Array(output.target.buffer!);
	const pages: Uint8Array[] = [];
	for (let pos = 0; pos < muxed.length;) {
		const segmentCount = muxed[pos + 26]!;
		const dataSize = muxed.subarray(pos + 27, pos + 27 + segmentCount).reduce((sum, value) => sum + value, 0);
		pages.push(muxed.subarray(pos, pos + 27 + segmentCount + dataSize));
		pos += 27 + segmentCount + dataSize;
	}
	const serialNumberOf = (page: Uint8Array) => new DataView(page.buffer, page.byteOffset).getUint32(14, true);
	const pageCounts = new Map<number, number>();
	for (const page of pages) {
		pageCounts.set(serialNumberOf(page), (pageCounts.get(serialNumberOf(page)) ?? 0) + 1);
	}
	const shortSerialNumber = [...pageCounts].sort((a, b) => a[1] - b[1])[0]![0];
	let lastShortPageIndex = pages.length - 1;
	while (serialNumberOf(pages[lastShortPageIndex]!) !== shortSerialNumber) {
		lastShortPageIndex--;
	}
	pages.push(...pages.splice(lastShortPageIndex, 1));

	const bytes = new Uint8Array(muxed.length);
	let offset = 0;
	for (const page of pages) {
		bytes.set(page, offset);
		offset += page.length;
	}
	let bytesRead = 0;
	using input = new Input({
		source: new CustomSource({
			// A cache much smaller than the file, as for any long recording
			maxCacheSize: 2 ** 16,
			getSize: () => bytes.byteLength,
			read: (start, end) => {
				bytesRead += end - start;
				return bytes.subarray(start, end);
			},
		}),
		formats: ALL_FORMATS,
	});
	const shortTrack = (await input.getAudioTracks())[1]!;
	const sink = new EncodedPacketSink(shortTrack);

	// Lookups within the stream only read around the packet
	bytesRead = 0;
	expect((await sink.getPacket(10))!.timestamp).toBeCloseTo(10, 1);
	expect(bytesRead).toBeLessThan(bytes.byteLength / 4);

	// The first lookup past the end may have to find out where the stream ends
	expect((await sink.getPacket(60))!.timestamp).toBeCloseTo(18, 1);

	for (const timestamp of [90, 120, 150]) {
		bytesRead = 0;
		expect((await sink.getPacket(timestamp))!.timestamp).toBeCloseTo(18, 1);
		expect(bytesRead).toBeLessThan(bytes.byteLength / 4);
	}
}, 60_000);
