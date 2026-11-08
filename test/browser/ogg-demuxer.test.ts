import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, ReadableStreamSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioBufferSink, AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { Output } from '../../src/output.js';
import { OggOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { Logging } from '../../src/logging.js';
import { computeOggPageCrc } from '../../src/ogg/ogg-misc.js';
import { assert } from '../../src/misc.js';

// VLC creates OGG files with an empty EOS page, which previously caused decoding errors
test('can decode OGG Vorbis file with empty EOS page', async () => {
	using input = new Input({
		source: new UrlSource('/vorbis-eos.ogg'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const sink = new AudioBufferSink(track);
	const buffers: AudioBuffer[] = [];

	for await (const { buffer } of sink.buffers(4, 10)) {
		buffers.push(buffer);
	}

	expect(buffers.length).toBeGreaterThan(0);
});

// Joins Ogg files the way \`cat\` does, producing a chained stream (RFC 3533, section 4)
const remuxToOggLinks = async (url: string, cuts: number[]) => {
	using input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	const decoderConfig = (await track.getDecoderConfig())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	const links: Uint8Array[] = [];
	const bounds = [0, ...cuts, packets.length];
	for (let i = 0; i < bounds.length - 1; i++) {
		const linkPackets = packets.slice(bounds[i], bounds[i + 1]);
		const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource((await track.getCodec())!);
		output.addAudioTrack(source);
		await output.start();

		// Each link starts at its own time zero, like a separately encoded file
		const shift = linkPackets[0]!.timestamp - packets[0]!.timestamp;
		for (const [j, packet] of linkPackets.entries()) {
			await source.add(
				new EncodedPacket(packet.data, 'key', packet.timestamp - shift, packet.duration),
				j === 0 ? { decoderConfig } : undefined,
			);
		}
		source.close();
		await output.finalize();
		links.push(new Uint8Array(output.target.buffer!));
	}

	return { links, packetCount: packets.length };
};

const concatBytes = (parts: Uint8Array[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
};

const readPackets = async (source: BufferSource | ReadableStreamSource) => {
	using input = new Input({ source, formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	return { packets, duration: await track.computeDuration() };
};

/**
 * Decodes the packets with WebCodecs alone, never with Mediabunny, to tell whether the platform's own decoder can
 * decode them, so that a Mediabunny failure on a capable platform fails instead of skipping. Returns the number of
 * frames decoded, or null if the platform can't decode them.
 */
const decodeNatively = async (config: AudioDecoderConfig, packets: EncodedPacket[]) => {
	// After a decoder hung (WebKitGTK's Vorbis decoder, in an earlier test), even this may never settle
	const supported = await Promise.race([
		AudioDecoder.isConfigSupported(config).then(support => !!support.supported, () => false),
		new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000)),
	]);
	if (!supported) {
		return null;
	}

	let frames = 0;
	let failed = false;
	const decoder = new AudioDecoder({
		output: (data) => {
			frames += data.numberOfFrames;
			data.close();
		},
		error: () => {
			failed = true;
		},
	});
	try {
		decoder.configure(config);
		for (const packet of packets) {
			decoder.decode(new EncodedAudioChunk({
				type: 'key',
				timestamp: Math.round(packet.timestamp * 1e6),
				duration: Math.round(packet.duration * 1e6),
				data: packet.data,
			}));
		}
		// A decoder that fails may also never settle
		failed ||= !await Promise.race([
			decoder.flush().then(() => true, () => false),
			new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5000)),
		]);
	} catch {
		failed = true;
	}
	if (decoder.state !== 'closed') {
		decoder.close();
	}

	return failed ? null : frames;
};

test('reads all links of a chained Opus stream', async ({ skip, annotate }) => {
	const { links, packetCount } = await remuxToOggLinks('/preroll-test.opus', [100, 220]);
	const file = concatBytes(links);

	const linkDurations = await Promise.all(
		links.map(async link => (await readPackets(new BufferSource(link))).duration),
	);
	const { packets, duration } = await readPackets(new BufferSource(file));
	expect(packets).toHaveLength(packetCount);

	// The links follow each other without gaps or overlaps. As the decoder isn't reset between links, the pre-skip of
	// the later links isn't discarded.
	for (let i = 1; i < packets.length; i++) {
		expect(packets[i]!.timestamp).toBeCloseTo(packets[i - 1]!.timestamp + packets[i - 1]!.duration, 9);
	}
	const preSkip = 312 / 48000;
	expect(duration).toBeCloseTo(linkDurations[0]! + linkDurations[1]! + linkDurations[2]! + 2 * preSkip, 9);

	// The browser's own Ogg demuxer agrees on the length of the chain. Chrome's makes exactly that of it, as it doesn't
	// reset its decoder between links either. Firefox's decodes each link on its own and trims at the joins instead,
	// by up to a pre-skip and a packet per join (1272 frames fewer in all for this file). WebKitGTK's can't decode
	// chained Ogg at all, so there's nothing to compare there.
	const browserLength = await Promise.race([
		new OfflineAudioContext(1, 1, 48000).decodeAudioData(file.slice().buffer).then(
			buffer => buffer.length,
			() => null,
		),
		new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
	]);
	if (browserLength !== null) {
		const joins = links.length - 1;
		expect(Math.abs(browserLength - Math.round(duration * 48000))).toBeLessThanOrEqual(joins * (312 + 960));
	} else {
		await annotate('the browser\'s decodeAudioData can\'t decode chained Ogg Opus, so its length isn\'t compared');
	}

	// Random access finds the same packets, also in later links
	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
	for (const index of [0, 99, 100, 101, 219, 220, packets.length - 1]) {
		const packet = (await sink.getPacket(packets[index]!.timestamp + 0.001))!;
		expect([packet.timestamp, packet.byteLength]).toEqual([packets[index]!.timestamp, packets[index]!.byteLength]);
	}

	// Reading from an unsized source gives the same packets
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(file);
			controller.close();
		},
	});
	const streamed = await readPackets(new ReadableStreamSource(stream));
	expect(streamed.packets.map(x => x.timestamp)).toEqual(packets.map(x => x.timestamp));

	// And the whole stream decodes, wherever the platform's own decoder can decode these packets
	const decoderConfig = (await (await input.getPrimaryAudioTrack())!.getDecoderConfig())!;
	const nativelyDecodable = await decodeNatively(decoderConfig, packets) !== null;
	skip(!nativelyDecodable, 'the platform can\'t decode these packets (native probe)');
	let decodedFrames = 0;
	for await (using sample of new AudioSampleSink((await input.getPrimaryAudioTrack())!).samples()) {
		decodedFrames += sample.numberOfFrames;
	}
	expect(decodedFrames).toBeGreaterThan(duration * 48000 - 1);
});

test('reads all links of a chained Vorbis stream', async () => {
	const { links, packetCount } = await remuxToOggLinks('/vorbis-eos.ogg', [150]);
	const file = concatBytes(links);

	const { packets, duration } = await readPackets(new BufferSource(file));
	expect(packets).toHaveLength(packetCount);
	for (let i = 1; i < packets.length; i++) {
		expect(packets[i]!.timestamp).toBeCloseTo(packets[i - 1]!.timestamp + packets[i - 1]!.duration, 9);
	}

	const linkDurations = await Promise.all(
		links.map(async link => (await readPackets(new BufferSource(link))).duration),
	);
	expect(duration).toBeGreaterThan(linkDurations[0]! + linkDurations[1]!);
	expect(duration).toBeLessThan(linkDurations[0]! + linkDurations[1]! + 0.03);
});

test('stops with a warning at a chained link with different codec parameters', async () => {
	const { links } = await remuxToOggLinks('/preroll-test.opus', [100]);

	// A mono link after a stereo one
	const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(source);
	await output.start();
	const opusHead = new Uint8Array([
		0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // 'OpusHead'
		1, 1, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0, // Version 1, mono, pre-skip 312, 48 kHz, no gain, family 0
	]);
	const decoderConfig = { codec: 'opus', numberOfChannels: 1, sampleRate: 48000, description: opusHead };
	for (let i = 0; i < 10; i++) {
		await source.add(
			new EncodedPacket(new Uint8Array([0xf8, 0xff, 0xfe]), 'key', i * 0.02, 0.02),
			i === 0 ? { decoderConfig } : undefined,
		);
	}
	source.close();
	await output.finalize();

	const warnings: string[] = [];
	const removeListener = Logging.on('warn', args => warnings.push(args.join(' ')));
	try {
		const file = concatBytes([links[0]!, new Uint8Array(output.target.buffer!)]);
		const { packets } = await readPackets(new BufferSource(file));
		expect(packets).toHaveLength(100);
		expect(warnings.some(x => x.includes('chained logical bitstream at byte'))).toBe(true);
	} finally {
		removeListener();
	}
});

test('stops with a warning at a chained Opus link whose pre-skip crops its start', async () => {
	const { links } = await remuxToOggLinks('/preroll-test.opus', [100]);
	const [firstLink] = await Promise.all(links.map(link => readPackets(new BufferSource(link))));

	// Raise the second link's pre-skip from 312 to 4800 samples (100 ms), as when cropping its start (RFC 7845, section
	// 4.2). Its first page holds the OpusHead packet, whose pre-skip is at byte 10.
	const secondLink = links[1]!.slice();
	const dataStart = 27 + secondLink[26]!;
	new DataView(secondLink.buffer).setUint16(dataStart + 10, 4800, true);
	new DataView(secondLink.buffer).setUint32(22, computeOggPageCrc(secondLink.subarray(0, dataStart + 19)), true);

	const warnings: string[] = [];
	const removeListener = Logging.on('warn', args => warnings.push(args.join(' ')));
	try {
		// Playing the cropped samples would add 100 ms of audio that isn't part of either link
		const { packets, duration } = await readPackets(new BufferSource(concatBytes([links[0]!, secondLink])));
		expect(packets).toHaveLength(100);
		expect(duration).toBe(firstLink!.duration);
		expect(warnings.some(x => x.includes('pre-skip of 4800 samples'))).toBe(true);
	} finally {
		removeListener();
	}
});

test('ends the track at a damaged page of a chained link', async ({ skip }) => {
	const { links } = await remuxToOggLinks('/preroll-test.opus', [100, 220]);

	// Flip a byte in the third link's second audio page, which comes after its two header pages and one audio page
	const thirdLink = links[2]!.slice();
	let offset = 0;
	for (let i = 0; i < 3; i++) {
		const segmentCount = thirdLink[offset + 26]!;
		const dataSize = thirdLink.subarray(offset + 27, offset + 27 + segmentCount).reduce((a, b) => a + b, 0);
		offset += 27 + segmentCount + dataSize;
	}
	thirdLink[offset + 40]! ^= 0xff;

	const file = concatBytes([links[0]!, links[1]!, thirdLink]);
	const { packets, duration } = await readPackets(new BufferSource(file));

	// The track ends before the damaged page, whose packets would make decoding fail
	expect(packets.length).toBeGreaterThan(220);
	expect(packets.length).toBeLessThan(301);
	expect(duration).toBeCloseTo(packets.at(-1)!.timestamp + packets.at(-1)!.duration, 9);

	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	const sink = new EncodedPacketSink(track);
	for (const packet of [packets[219]!, packets[220]!, packets.at(-1)!]) {
		expect((await sink.getPacket(packet.timestamp))?.byteLength).toBe(packet.byteLength);
	}

	// Wherever the platform's own decoder can decode these packets
	const nativelyDecodable = await decodeNatively((await track.getDecoderConfig())!, packets) !== null;
	skip(!nativelyDecodable, 'the platform can\'t decode these packets (native probe)');
	let decodedFrames = 0;
	for await (using sample of new AudioSampleSink(track).samples()) {
		decodedFrames += sample.numberOfFrames;
	}
	expect(decodedFrames).toBeGreaterThan(duration * 48000 - 1);
});

test('reads a chain whose third link reuses the first link\'s serial number the same in any order', async () => {
	// As from concatenating a file, another one and the first one again. RFC 3533 requires unique serial numbers, so
	// the track ends before the third link, whether it's iterated or looked up first.
	const { links, packetCount } = await remuxToOggLinks('/preroll-test.opus', [100]);
	const file = concatBytes([links[0]!, links[1]!, links[0]!]);
	const iteratedFirst = await readPackets(new BufferSource(file));
	expect(iteratedFirst.packets).toHaveLength(packetCount);

	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.computeDuration()).toBe(iteratedFirst.duration);

	const sink = new EncodedPacketSink(track);
	for (const packet of [iteratedFirst.packets[99]!, iteratedFirst.packets[100]!, iteratedFirst.packets.at(-1)!]) {
		expect((await sink.getPacket(packet.timestamp))?.byteLength).toBe(packet.byteLength);
	}
	let count = 0;
	for await (const packet of sink.packets()) {
		expect(packet.timestamp).toBe(iteratedFirst.packets[count]!.timestamp);
		count++;
	}
	expect(count).toBe(packetCount);
});

// Gives every page of the Ogg file the serial number, recomputing the page checksums
const withSerialNumber = (file: Uint8Array, serialNumber: number) => {
	const result = file.slice();
	const view = new DataView(result.buffer);
	for (let pos = 0; pos < result.length;) {
		const segmentCount = result[pos + 26]!;
		const lacingValues = result.subarray(pos + 27, pos + 27 + segmentCount);
		const size = 27 + segmentCount + lacingValues.reduce((a, b) => a + b, 0);
		view.setUint32(pos + 14, serialNumber, true);
		view.setUint32(pos + 22, computeOggPageCrc(result.subarray(pos, pos + size)), true);
		pos += size;
	}
	return result;
};

test('reads a chain whose longer second link reuses the first link\'s serial number in any order', async () => {
	// As from concatenating two files that FFmpeg wrote with -fflags +bitexact, which gives every Ogg file serial
	// number 0. The bisection can't tell the second link's pages from the first link's.
	const { links } = await remuxToOggLinks('/preroll-test.opus', [20]);
	const serialNumber = new DataView(links[0]!.buffer).getUint32(14, true);
	const file = concatBytes([links[0]!, withSerialNumber(links[1]!, serialNumber)]);
	const iteratedFirst = await readPackets(new BufferSource(file));
	expect(iteratedFirst.packets).toHaveLength(20);

	// Also when several lookups start at once on a fresh input
	using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	const [duration, otherDuration, lastPacket] = await Promise.all([
		track.computeDuration(),
		track.computeDuration(),
		new EncodedPacketSink(track).getPacket(Infinity),
	]);
	expect([duration, otherDuration]).toEqual([iteratedFirst.duration, iteratedFirst.duration]);
	expect(lastPacket?.timestamp).toBe(iteratedFirst.packets[19]!.timestamp);
});

test('looks up the last packet of a stream after computing its duration', async () => {
	// Checking for a chained link after the last page reads to the end of the stream, which makes its size known. A
	// binary search would then read back where the stream's small cache no longer reaches.
	const bytes = new Uint8Array(await (await fetch('/vorbis-eos.ogg')).arrayBuffer());
	let offset = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(offset, offset + 4096));
			offset += 4096;
		},
	});

	using input = new Input({
		source: new ReadableStreamSource(stream, { maxCacheSize: 32 * 1024 }),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	const duration = await track.computeDuration();
	const lastPacket = await new EncodedPacketSink(track).getPacket(Infinity);
	expect(lastPacket!.timestamp + lastPacket!.duration).toBeCloseTo(duration, 9);
});
