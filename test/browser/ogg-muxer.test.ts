import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { OggOutputFormat } from '../../src/output-format.js';
import { BufferTarget, NullTarget } from '../../src/target.js';
import { AudioBufferSource, EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Quality } from '../../src/encode.js';
import { assert } from '../../src/misc.js';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS, OggInputFormat } from '../../src/input-format.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { Conversion } from '../../src/conversion.js';

test('maximumPageDuration option', async () => {
	const sampleRate = 48000;
	const durationSeconds = 2;
	const audioBuffer = new AudioBuffer({ numberOfChannels: 1, length: sampleRate * durationSeconds, sampleRate });

	// First, create an Ogg file without the maximumPageDuration option
	let pageCountWithoutOption = 0;
	{
		const output = new Output({
			format: new OggOutputFormat({
				onPage: () => {
					pageCountWithoutOption++;
				},
			}),
			target: new NullTarget(),
		});

		const audioSource = new AudioBufferSource({ codec: 'opus', quality: new Quality({ bitrate: 64000 }) });
		output.addAudioTrack(audioSource);

		await output.start();
		await audioSource.add(audioBuffer);
		audioSource.close();
		await output.finalize();
	}

	// Then, create an Ogg file with maximumPageDuration set to 0.1 seconds
	let pageCountWithOption = 0;
	{
		const output = new Output({
			format: new OggOutputFormat({
				maximumPageDuration: 0.1,
				onPage: () => {
					pageCountWithOption++;
				},
			}),
			target: new NullTarget(),
		});

		const audioSource = new AudioBufferSource({ codec: 'opus', quality: new Quality({ bitrate: 64000 }) });
		output.addAudioTrack(audioSource);

		await output.start();
		await audioSource.add(audioBuffer);
		audioSource.close();
		await output.finalize();
	}

	expect(pageCountWithoutOption).toBe(3);
	expect(pageCountWithOption).toBe(23); // It created more pages
});

test('Multi-frame Opus packets', async () => {
	const SAMPLE_RATE = 48000;
	const SAMPLES_PER_FRAME = 960; // 20 ms at 48 kHz

	const createOpusHead = () => {
		const bytes = new Uint8Array(19);
		const view = new DataView(bytes.buffer);

		bytes.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // 'OpusHead'
		bytes[8] = 1; // Version
		bytes[9] = 1; // Channel count
		view.setUint16(10, 312, true); // Pre-skip
		view.setUint32(12, SAMPLE_RATE, true); // Input sample rate
		view.setInt16(16, 0, true); // Output gain
		bytes[18] = 0; // Channel mapping family

		return bytes;
	};

	const createOpusPacket = (frameCount: number) => {
		const data = new Uint8Array(2 + 3 * frameCount);

		data[0] = (31 << 3) | 0b11; // TOC byte: config 31 (CELT fullband, 20 ms), code 3
		data[1] = frameCount; // CBR, no padding, `frameCount` frames

		return data;
	};

	const framesPerPacket = 3;
	const packetCount = 10;
	const packetDuration = (framesPerPacket * SAMPLES_PER_FRAME) / SAMPLE_RATE;

	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(audioSource);

	await output.start();

	for (let i = 0; i < packetCount; i++) {
		await audioSource.add(
			new EncodedPacket(
				createOpusPacket(framesPerPacket),
				'key',
				i * packetDuration,
				packetDuration,
			),
			{
				decoderConfig: {
					codec: 'opus',
					numberOfChannels: 1,
					sampleRate: SAMPLE_RATE,
					description: createOpusHead(),
				},
			},
		);
	}

	audioSource.close();
	await output.finalize();

	assert(output.target.buffer);

	const input = new Input({
		source: new BufferSource(output.target.buffer),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBeInstanceOf(OggInputFormat);

	const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	// The first packet is shortened by the pre-skip, so check the second one
	const packet = await sink.getNextPacket(firstPacket);

	expect(packet?.duration).toBe(packetDuration);
});

test('Opus start offset and end trimming survive a demux-mux roundtrip', async () => {
	const SAMPLE_RATE = 48000;
	const PRE_SKIP = 312;
	const SAMPLES_PER_FRAME = 960; // 20 ms at 48 kHz

	const opusHead = new Uint8Array(19);
	const opusHeadView = new DataView(opusHead.buffer);
	opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // 'OpusHead'
	opusHead[8] = 1; // Version
	opusHead[9] = 1; // Channel count
	opusHeadView.setUint16(10, PRE_SKIP, true);
	opusHeadView.setUint32(12, SAMPLE_RATE, true);

	const decoderConfig: AudioDecoderConfig = {
		codec: 'opus',
		numberOfChannels: 1,
		sampleRate: SAMPLE_RATE,
		description: opusHead,
	};

	const mux = async (packets: EncodedPacket[]) => {
		const output = new Output({
			format: new OggOutputFormat(),
			target: new BufferTarget(),
		});

		const audioSource = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(audioSource);
		await output.start();

		for (const packet of packets) {
			await audioSource.add(packet, { decoderConfig });
		}

		audioSource.close();
		await output.finalize();

		assert(output.target.buffer);
		return output.target.buffer;
	};

	const demux = async (buffer: ArrayBuffer) => {
		const input = new Input({
			source: new BufferSource(buffer),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		return { packets, duration: await track.computeDuration() };
	};

	// A stream whose audible part starts at 1 second and ends 312 samples into its final packet
	const startInSamples = SAMPLE_RATE - PRE_SKIP;
	const packetCount = 50;
	const lastPacketDurationInSamples = 312;

	const packets: EncodedPacket[] = [];
	for (let i = 0; i < packetCount; i++) {
		const isLast = i === packetCount - 1;

		packets.push(new EncodedPacket(
			new Uint8Array([31 << 3, 0]), // TOC byte: config 31 (CELT fullband, 20 ms), code 0
			'key',
			(startInSamples + i * SAMPLES_PER_FRAME) / SAMPLE_RATE,
			(isLast ? lastPacketDurationInSamples : SAMPLES_PER_FRAME) / SAMPLE_RATE,
		));
	}

	const first = await demux(await mux(packets));

	const expectedEndInSamples = startInSamples + (packetCount - 1) * SAMPLES_PER_FRAME + lastPacketDurationInSamples;
	expect(first.packets[0]!.timestamp).toBe(startInSamples / SAMPLE_RATE);
	expect(first.duration).toBe(expectedEndInSamples / SAMPLE_RATE);
	expect(first.packets.at(-1)!.duration).toBe(lastPacketDurationInSamples / SAMPLE_RATE);

	const second = await demux(await mux(first.packets));

	const toTiming = (packet: EncodedPacket) => [packet.timestamp, packet.duration];
	expect(second.packets.map(toTiming)).toEqual(first.packets.map(toTiming));
	expect(second.duration).toBe(first.duration);

	// A standard stream starts at -preSkip, such that the audible part begins at zero
	const standard = await demux(await mux(packets.map((packet, i) => new EncodedPacket(
		packet.data,
		'key',
		(i * SAMPLES_PER_FRAME - PRE_SKIP) / SAMPLE_RATE,
		SAMPLES_PER_FRAME / SAMPLE_RATE,
	))));

	expect(standard.packets[0]!.timestamp).toBe(-PRE_SKIP / SAMPLE_RATE);
	expect(standard.packets[0]!.duration).toBe(SAMPLES_PER_FRAME / SAMPLE_RATE);
	expect(standard.duration).toBe((packetCount * SAMPLES_PER_FRAME - PRE_SKIP) / SAMPLE_RATE);
});

test('Granule positions of full pages', async () => {
	const SAMPLE_RATE = 48000;
	const SAMPLES_PER_FRAME = 120; // 2.5 ms at 48 kHz

	const opusHead = new Uint8Array(19);
	const opusHeadView = new DataView(opusHead.buffer);
	opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // 'OpusHead'
	opusHead[8] = 1; // Version
	opusHead[9] = 1; // Channel count
	opusHeadView.setUint16(10, 312, true); // Pre-skip
	opusHeadView.setUint32(12, SAMPLE_RATE, true);

	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(audioSource);
	await output.start();

	// Packets this small fill up all 255 segments of a page before the page reaches its target size
	const packetDuration = SAMPLES_PER_FRAME / SAMPLE_RATE;
	for (let i = 0; i < 1000; i++) {
		const data = new Uint8Array(10);
		data[0] = 16 << 3;

		await audioSource.add(new EncodedPacket(data, 'key', i * packetDuration, packetDuration), {
			decoderConfig: {
				codec: 'opus',
				numberOfChannels: 1,
				sampleRate: SAMPLE_RATE,
				description: opusHead,
			},
		});
	}

	audioSource.close();
	await output.finalize();

	assert(output.target.buffer);

	const input = new Input({
		source: new BufferSource(output.target.buffer),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);

	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
	}

	for (const timestamp of timestamps) {
		const packet = await sink.getPacket(timestamp);
		expect(packet?.timestamp).toBe(timestamp);
	}
});

/**
 * Decodes the packets with WebCodecs alone, never with Mediabunny, to tell what the platform's own decoder does with
 * them, so that a Mediabunny failure on a capable platform fails instead of skipping. Returns the number of frames
 * decoded, or null if the platform can't decode them.
 */
const decodeNatively = async (config: AudioDecoderConfig, packets: EncodedPacket[]) => {
	try {
		if (!(await AudioDecoder.isConfigSupported(config)).supported) {
			return null;
		}
	} catch {
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

test('Opus timestamp gaps are filled with packet loss concealment', async ({ skip }) => {
	// Ogg Opus has no timestamps besides granule positions, which must advance by exactly the samples in the packets
	// (RFC 7845, section 4.1). So a gap, as left by lost or paused packets, has to be filled with packets of empty
	// frames, or all later audio would be pulled forward.
	using sourceInput = new Input({ source: new UrlSource('/preroll-test.opus'), formats: ALL_FORMATS });
	const sourceTrack = (await sourceInput.getPrimaryAudioTrack())!;
	const decoderConfig = (await sourceTrack.getDecoderConfig())!;
	const sourcePackets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(sourceTrack).packets()) {
		sourcePackets.push(packet);
		if (sourcePackets.length === 7) {
			break;
		}
	}

	const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
	const audioSource = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(audioSource);
	await output.start();

	// 20 ms packets with a 1 s gap after the third one
	const timestamps = [0, 0.02, 0.04, 1.06, 1.08, 1.1];
	for (let i = 0; i < timestamps.length; i++) {
		await audioSource.add(
			new EncodedPacket(sourcePackets[i + 1]!.data, 'key', timestamps[i]!, 0.02),
			i === 0 ? { decoderConfig } : undefined,
		);
	}
	audioSource.close();
	await output.finalize();
	assert(output.target.buffer);

	using input = new Input({ source: new BufferSource(output.target.buffer), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	// The real packets keep their timestamps, and the gap is covered without overlaps
	for (let i = 0; i < timestamps.length; i++) {
		expect(packets.some(x => Math.abs(x.timestamp - timestamps[i]!) < 1e-9 && x.byteLength > 2)).toBe(true);
	}
	for (let i = 1; i < packets.length; i++) {
		expect(packets[i]!.timestamp).toBeCloseTo(packets[i - 1]!.timestamp + packets[i - 1]!.duration, 9);
	}
	expect(await track.computeDuration()).toBeCloseTo(1.12, 9);

	// The empty frames decode to concealment, so the decoded audio spans the gap. It ends where the platform's decoder
	// puts the end: Chrome's discards the pre-skip from its first output, but WebKitGTK's keeps it, which shows in what
	// it makes of the first packet alone.
	const firstPacketFrames = await decodeNatively(
		decoderConfig,
		[new EncodedPacket(sourcePackets[1]!.data, 'key', 0, 0.02)],
	);
	skip(firstPacketFrames === null, 'the platform can\'t decode Opus (native probe)');
	const preSkip = 312; // That of preroll-test.opus
	const keptPreSkip = firstPacketFrames! - (960 - preSkip);

	let decodedFrames = 0;
	let lastSampleEnd = 0;
	for await (using sample of new AudioSampleSink(track).samples()) {
		decodedFrames += sample.numberOfFrames;
		lastSampleEnd = sample.timestamp + sample.duration;
	}
	expect(decodedFrames).toBeGreaterThan(1.1 * 48000);
	expect(lastSampleEnd).toBeCloseTo(1.12 + keptPreSkip / 48000, 9);
});

test('Opus timestamp gaps in multichannel audio are filled with valid multistream packets', async ({ skip }) => {
	// Quadraphonic Opus made of two coupled (stereo) streams: each packet holds a self-delimited Opus packet for the
	// first stream followed by a regular one for the second (RFC 7845, section 3). The streams' packets are taken
	// from a stereo file, whose packets each hold one 20 ms frame (code 0).
	using sourceInput = new Input({ source: new UrlSource('/preroll-test.opus'), formats: ALL_FORMATS });
	const stereoPackets: Uint8Array[] = [];
	for await (const packet of new EncodedPacketSink((await sourceInput.getPrimaryAudioTrack())!).packets()) {
		stereoPackets.push(packet.data);
		if (stereoPackets.length === 14) {
			break;
		}
	}

	const selfDelimited = (packet: Uint8Array) => {
		const frameLength = packet.length - 1;
		const lengthBytes = frameLength < 252
			? [frameLength]
			: [252 + (frameLength - 252) % 4, Math.floor((frameLength - 252) / 4)];
		return new Uint8Array([packet[0]!, ...lengthBytes, ...packet.subarray(1)]);
	};
	const quadPacket = (i: number) => new Uint8Array([
		...selfDelimited(stereoPackets[2 * i + 1]!),
		...stereoPackets[2 * i + 2]!,
	]);

	const opusHead = new Uint8Array([
		0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // 'OpusHead'
		1, 4, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, // Version 1, 4 channels, pre-skip 312, 48 kHz, no gain
		1, 2, 2, 0, 1, 2, 3, // Mapping family 1: 2 streams, both coupled, channels in order
	]);
	const decoderConfig = { codec: 'opus', numberOfChannels: 4, sampleRate: 48000, description: opusHead };

	const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
	const audioSource = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(audioSource);
	await output.start();

	// 20 ms packets with a 1 s gap after the third one
	const timestamps = [0, 0.02, 0.04, 1.06, 1.08, 1.1];
	for (let i = 0; i < timestamps.length; i++) {
		await audioSource.add(
			new EncodedPacket(quadPacket(i), 'key', timestamps[i]!, 0.02),
			i === 0 ? { decoderConfig } : undefined,
		);
	}
	audioSource.close();
	await output.finalize();
	assert(output.target.buffer);

	using input = new Input({ source: new BufferSource(output.target.buffer), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getNumberOfChannels()).toBe(4);
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	for (const timestamp of timestamps) {
		expect(packets.some(x => Math.abs(x.timestamp - timestamp) < 1e-9 && x.byteLength > 100)).toBe(true);
	}

	// Every packet decodes, including the synthesized ones, which would otherwise fail the decoder. That's wherever the
	// platform can decode multichannel Opus at all (WebKitGTK can't), as its own decoder shows on the real packets.
	const realPackets = timestamps.map((timestamp, i) => new EncodedPacket(quadPacket(i), 'key', timestamp, 0.02));
	const nativelyDecodable = await decodeNatively(decoderConfig, realPackets) !== null;
	skip(!nativelyDecodable, 'the platform can\'t decode multichannel Opus (native probe)');
	let decodedFrames = 0;
	for await (using sample of new AudioSampleSink(track).samples()) {
		decodedFrames += sample.numberOfFrames;
	}
	expect(decodedFrames).toBeGreaterThan(1.1 * 48000);
});

test('Vorbis timestamp gaps are kept in the granule positions', async () => {
	using sourceInput = new Input({ source: new UrlSource('/vorbis-eos.ogg'), formats: ALL_FORMATS });
	const sourceTrack = (await sourceInput.getPrimaryAudioTrack())!;
	const decoderConfig = (await sourceTrack.getDecoderConfig())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(sourceTrack).packets()) {
		packets.push(packet);
		if (packets.length === 100) {
			break;
		}
	}

	// Muxes the packets, with a gap of the given duration after the given number of packets and the given number of
	// samples trimmed off the end
	const mux = async (gap: number, maximumPageDuration?: number, packetsBeforeGap = 45, trimmedSamples = 0) => {
		const output = new Output({
			format: new OggOutputFormat({ maximumPageDuration }),
			target: new BufferTarget(),
		});
		const audioSource = new EncodedAudioPacketSource('vorbis');
		output.addAudioTrack(audioSource);
		await output.start();

		for (const [i, packet] of packets.entries()) {
			const timestamp = packet.timestamp + (i >= packetsBeforeGap ? gap : 0);
			const duration = packet.duration - (i === packets.length - 1 ? trimmedSamples / 44100 : 0);
			await audioSource.add(
				new EncodedPacket(packet.data, 'key', timestamp, duration),
				i === 0 ? { decoderConfig } : undefined,
			);
		}
		audioSource.close();
		await output.finalize();
		assert(output.target.buffer);
		return new Uint8Array(output.target.buffer);
	};

	// Maps the index of each page's last packet (counting the three header packets) to the page's granule position
	const granulePositionsByLastPacket = (file: Uint8Array) => {
		const result = new Map<number, number>();
		const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
		let packetCount = 0;

		for (let pos = 0; pos < file.length;) {
			const lacingValues = file.subarray(pos + 27, pos + 27 + file[pos + 26]!);
			const endingPackets = lacingValues.filter(x => x < 255).length;
			packetCount += endingPackets;
			if (endingPackets > 0) {
				result.set(packetCount - 1, view.getUint32(pos + 6, true) + view.getInt32(pos + 10, true) * 2 ** 32);
			}

			pos += 27 + lacingValues.length + lacingValues.reduce((a, b) => a + b, 0);
		}

		return result;
	};

	// Where each packet ends without the gap, from a file with one packet per page
	const gapless = await mux(0, 0.001);
	const packetEnds = granulePositionsByLastPacket(gapless);
	expect(packetEnds.size).toBe(3 + 100 - 1); // The first two header packets share a page

	// With the gap, the 46th audio packet gets a page of its own (which it doesn't otherwise), and from that page on,
	// granule positions are a second (44100 samples) ahead
	const firstPacketAfterGap = 3 + 45;
	expect(granulePositionsByLastPacket(await mux(0)).has(firstPacketAfterGap - 1)).toBe(false);
	const gapped = await mux(1);
	const gappedGranulePositions = granulePositionsByLastPacket(gapped);
	expect(gappedGranulePositions.has(firstPacketAfterGap - 1)).toBe(true);
	expect(gappedGranulePositions.has(firstPacketAfterGap)).toBe(true);

	let pagesAfterGap = 0;
	for (const [packetIndex, granulePosition] of gappedGranulePositions) {
		if (packetIndex >= 3) {
			const isAfterGap = packetIndex >= firstPacketAfterGap;
			expect(granulePosition).toBe(packetEnds.get(packetIndex)! + (isAfterGap ? 44100 : 0));
			pagesAfterGap += isAfterGap ? 1 : 0;
		}
	}
	expect(pagesAfterGap).toBeGreaterThan(0);

	const computeDuration = async (file: Uint8Array) => {
		using input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
		return await (await input.getPrimaryAudioTrack())!.computeDuration();
	};
	expect(await computeDuration(gapped) - await computeDuration(gapless)).toBeCloseTo(1, 10);

	// Near the end of a trimmed stream, the gap doesn't share the final page with the end trimming, so that both
	// can be read back: the packet after the gap has a page of its own, and the final page's granule position is the
	// trimmed end, a second later
	const trimmedPacketEnds = granulePositionsByLastPacket(await mux(0, 0.001, 98, 100));
	const gappedTrimmed = await mux(1, undefined, 98, 100);
	const gappedTrimmedGranulePositions = granulePositionsByLastPacket(gappedTrimmed);
	expect([...gappedTrimmedGranulePositions.keys()].slice(-3)).toEqual([3 + 97, 3 + 98, 3 + 99]);
	for (const [packetIndex, granulePosition] of gappedTrimmedGranulePositions) {
		if (packetIndex >= 3) {
			expect(granulePosition).toBe(trimmedPacketEnds.get(packetIndex)! + (packetIndex >= 3 + 98 ? 44100 : 0));
		}
	}
	expect(trimmedPacketEnds.get(3 + 99)).toBe(packetEnds.get(3 + 99)! - 100);
});

test.each(['/preroll-test.opus', '/vorbis-eos.ogg'])(
	'Conversion of %s to Ogg copies the packets, keeping the priming before zero',
	async (url) => {
		// The first Opus packet starts at minus the pre-skip, the first Vorbis packet at minus its own duration (it
		// decodes to nothing); the Ogg muxer puts granule position zero right after either
		const readPackets = async (input: Input) => {
			const track = await input.getPrimaryAudioTrack();
			assert(track);

			const packets: [number, number][] = [];
			for await (const packet of new EncodedPacketSink(track).packets()) {
				packets.push([packet.timestamp, packet.byteLength]);
			}

			return { codec: await track.getCodec(), packets };
		};

		using input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
		const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output });
		await conversion.execute();

		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const inputPackets = await readPackets(input);
		expect(inputPackets.packets[0]![0]).toBeLessThan(0);
		expect(await readPackets(result)).toEqual(inputPackets);
	},
);

// Whether this browser decodes a file's audio, within a few seconds. Decided by WebCodecs: the file's first packets
// through an AudioDecoder (WebKitGTK's Vorbis decoder hangs, say). Run inside the test that needs it, as late as
// possible: a hung native decoder can stall the browser's later media work
const decodesAudioNatively = async (url: string) => {
	using input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	const decoderConfig = await track?.getDecoderConfig();
	if (!track || !decoderConfig || !(await AudioDecoder.isConfigSupported(decoderConfig)).supported) {
		return false;
	}

	let outputCount = 0;
	const decoder = new AudioDecoder({
		output: (audioData) => {
			outputCount++;
			audioData.close();
		},
		error: () => {},
	});

	try {
		decoder.configure(decoderConfig);
		let packetCount = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			decoder.decode(packet.toEncodedAudioChunk());
			if (++packetCount === 10) {
				break;
			}
		}

		const flushed = await Promise.race([
			decoder.flush().then(() => true, () => false),
			new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3000)),
		]);
		return flushed && outputCount > 0;
	} finally {
		if (decoder.state !== 'closed') {
			decoder.close();
		}
	}
};

const testTrimmedConversion = async (url: string, trimStart: number) => {
	// The priming must not absorb an explicit trim
	const readPackets = async (input: Input) => {
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		return packets;
	};

	using input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
	const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output, trim: { start: trimStart } });
	await conversion.execute();

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const inputPackets = await readPackets(input);
	const outputPackets = await readPackets(result);

	// Transcoding applies the trim; a copy has to move every packet earlier by it (Ogg stores whole samples)
	if (outputPackets[10]!.byteLength === inputPackets[10]!.byteLength) {
		expect(outputPackets[10]!.data).toEqual(inputPackets[10]!.data);
		expect(Math.abs(outputPackets[10]!.timestamp - (inputPackets[10]!.timestamp - trimStart))).toBeLessThan(2.5e-5);
	}
};

for (const [url, trimStart] of [
	// Less than the 1 ms the pre-skip match allows for rounded sources
	['/preroll-test.opus', 0.0008],
	// Beyond the first packet, which starts 45 samples before zero and lasts 128 at 44.1 kHz, but less than 1 ms beyond
	['/vorbis-eos.ogg', 0.0025],
] as const) {
	test(`Conversion of ${url} to Ogg with a start trim of ${trimStart} s applies the trim`, async ({ skip }) => {
		// A trim this small makes the conversion transcode, which needs a decoder
		skip(!(await decodesAudioNatively(url)), 'This browser can\'t decode the file');
		await testTrimmedConversion(url, trimStart);
	});
}
