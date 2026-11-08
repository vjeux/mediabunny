import { expect, test, vi } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PathedTarget } from '../../src/index.js';
import { Input } from '../../src/input.js';
import { MovOutputFormat, CmafOutputFormat, Mp4OutputFormat, WebMOutputFormat } from '../../src/output-format.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { StreamTarget, type StreamTargetChunk } from '../../src/target.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { IsobmffOutputFormat } from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget, NullTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { TextSubtitleSource, EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { assert, toDataView } from '../../src/misc.js';
import { EncodedPacket } from '../../src/packet.js';
import { IsobmffMuxer } from '../../src/isobmff/isobmff-muxer.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const STSD_PATH = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'];

type FoundBox = {
	contentStart: number;
	end: number;
};

const findBox = (bytes: Uint8Array, boxPath: string[]) => {
	const view = toDataView(bytes);

	const search = (start: number, end: number, depth: number, parentType: string | null): FoundBox | null => {
		let pos = start;
		while (pos < end) {
			const size = view.getUint32(pos);
			assert(size >= 8);

			const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
			const box = {
				contentStart: pos + 8,
				end: pos + size,
			};

			if (type === boxPath[depth]) {
				if (depth === boxPath.length - 1) {
					return box;
				}

				let childrenOffset = 0;
				if (type === 'stsd') {
					childrenOffset = 8;
				} else if (type === 'meta') {
					// QuickTime's meta box isn't a full box
					const nextType = String.fromCharCode(...bytes.subarray(box.contentStart + 4, box.contentStart + 8));
					childrenOffset = nextType === 'hdlr' ? 0 : 4;
				} else if (parentType === 'stsd') {
					// Audio sample entries grow with their version
					const version = view.getUint16(box.contentStart + 8);
					childrenOffset = 28 + [0, 16, 36][version]!;
				}

				const result = search(box.contentStart + childrenOffset, box.end, depth + 1, type);
				if (result) {
					return result;
				}
			}

			pos += size;
		}

		return null;
	};

	return search(0, bytes.byteLength, 0, null);
};

test('ISOBMFF muxer internally converts ADTS to AAC', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample3.aac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);

	const inputDecoderConfig = await inputTrack.getDecoderConfig();
	expect(inputDecoderConfig!.description).toBeUndefined(); // ADTS input has no description

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	expect(await outputTrack.getCodec()).toBe('aac');
	expect(await outputTrack.getSampleRate()).toBe(await inputTrack.getSampleRate());
	expect(await outputTrack.getNumberOfChannels()).toBe(await inputTrack.getNumberOfChannels());

	const outputDecoderConfig = await outputTrack.getDecoderConfig();
	expect(outputDecoderConfig!.description).toBeDefined();

	const outputSink = new EncodedPacketSink(outputTrack);

	let count = 0;
	for await (const packet of outputSink.packets()) {
		// Packets should NOT be ADTS frames (should not start with 0xFFF sync word)
		const isAdts = packet.data[0] === 0xff && (packet.data[1]! & 0xf0) === 0xf0;
		expect(isAdts).toBe(false);
		count++;
	}

	expect(count).toBe(4557);
});

test('MP3 below 32 kHz is declared as MPEG-2 audio in the esds', async () => {
	// Layer III frame headers: MPEG-1 at 44.1 kHz (128 kbit/s) and MPEG-2 at 22.05 kHz (64 kbit/s), both stereo
	const formats = [
		{ sampleRate: 44100, header: [0xff, 0xfb, 0x90, 0x00], frameSize: 417, frameLength: 1152, expected: 0x6b },
		{ sampleRate: 22050, header: [0xff, 0xf3, 0x80, 0x00], frameSize: 208, frameLength: 576, expected: 0x69 },
	];

	for (const { sampleRate, header, frameSize, frameLength, expected } of formats) {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('mp3');
		output.addAudioTrack(source);
		await output.start();

		for (let i = 0; i < 4; i++) {
			const data = new Uint8Array(frameSize);
			data.set(header);
			const duration = frameLength / sampleRate;
			await source.add(new EncodedPacket(data, 'key', i * duration, duration), {
				decoderConfig: { codec: 'mp3', sampleRate, numberOfChannels: 2 },
			});
		}
		await output.finalize();

		// The ES_Descriptor and DecoderConfigDescriptor headers are 2 bytes each here (sizes below 128)
		const bytes = new Uint8Array(output.target.buffer!);
		const esds = bytes.findIndex((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === 'esds');
		expect(bytes[esds + 8]).toBe(0x03); // ES_Descriptor
		expect(bytes[esds + 13]).toBe(0x04); // DecoderConfigDescriptor
		// ISO/IEC 11172-3 (0x6B) for MPEG-1 audio, ISO/IEC 13818-3 (0x69) for the lower rates, as FFmpeg writes them
		expect(bytes[esds + 15]).toBe(expected);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		expect(await track.getCodec()).toBe('mp3');
		expect(await track.getSampleRate()).toBe(sampleRate);
	}
});

test('Fragmented fMP4 with video+audio preserves B-frame CTS', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	const originalVideoSink = new EncodedPacketSink(videoTrack);
	const originalTimestamps: number[] = [];
	for await (const packet of originalVideoSink.packets()) {
		originalTimestamps.push(packet.timestamp);
	}

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputVideoTrack = await outputAsInput.getPrimaryVideoTrack();
	assert(outputVideoTrack);

	const videoSink = new EncodedPacketSink(outputVideoTrack);

	const timestamps: number[] = [];
	for await (const packet of videoSink.packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual(originalTimestamps);
});

test('FLAC above 65535 Hz declares the greatest expressible division of its rate in the sample entry', async () => {
	// "fLaC" + a last STREAMINFO block for 2-channel 16-bit audio at the given rate
	const flacDescription = (sampleRate: number) => {
		const bytes = new Uint8Array(4 + 4 + 34);
		bytes.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 34]);
		bytes.set([0x10, 0x00, 0x10, 0x00], 8); // Min/max block size
		bytes[18] = sampleRate >> 12; // 20 bits sample rate, 3 bits channels - 1, 5 bits bits per sample - 1
		bytes[19] = (sampleRate >> 4) & 0xff;
		bytes[20] = ((sampleRate & 0xf) << 4) | (1 << 1);
		bytes[21] = 15 << 4;
		return bytes;
	};

	// As FLAC-in-ISOBMFF requires: 48000 for 96 and 192 kHz, 65535 when no regular division fits
	const cases: [number, number][] = [
		[48000, 48000], [96000, 48000], [192000, 48000], [88200, 44100], [176400, 44100], [99999, 65535],
	];
	for (const [sampleRate, expected] of cases) {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('flac');
		output.addAudioTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(64), 'key', 0, 4096 / sampleRate), {
			decoderConfig: {
				codec: 'flac',
				sampleRate,
				numberOfChannels: 2,
				description: flacDescription(sampleRate),
			},
		});
		await output.finalize();

		// The 16.16 sample rate sits 24 bytes into the AudioSampleEntry; it used to be 0 above 65535 Hz
		const bytes = new Uint8Array(output.target.buffer!);
		const entry = bytes.findIndex((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === 'fLaC');
		expect(toDataView(bytes).getUint32(entry + 4 + 24) / 0x10000).toBe(expected);

		// Readers get the actual rate from the dfLa box
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		expect(await track.getSampleRate()).toBe(sampleRate);
	}
});

test('Zero start timestamp, regular MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') || str.includes('elst')).toBe(false);
});

test('24-bit PCM sample entry, MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s24');
	output.addAudioTrack(source);
	await output.start();

	const decoderConfig = {
		codec: 'pcm-s24',
		numberOfChannels: 2,
		sampleRate: 48000,
	};
	await source.add(new EncodedPacket(new Uint8Array(6 * 1024), 'key', 0, 1024 / 48000), { decoderConfig });
	await output.finalize();

	// QuickTime's extended version 1 layout has no place in an ISO sample entry, Apple drops the track if it's there
	const bytes = new Uint8Array(output.target.buffer!);
	const sampleEntry = findBox(bytes, [...STSD_PATH, 'ipcm']);
	assert(sampleEntry);

	const version = toDataView(bytes).getUint16(sampleEntry.contentStart + 8);
	expect(version).toBe(0);
	expect(findBox(bytes, [...STSD_PATH, 'ipcm', 'pcmC'])).not.toBeNull();

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getCodec()).toBe('pcm-s24');
	expect(await track.getSampleRate()).toBe(48000);
});

test('Non-zero start timestamp, regular MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') && str.includes('elst')).toBe(true);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	const durations: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		durations.push(packet.duration);
	}

	expect(timestamps).toEqual([1, 1.1, 1.2, 1.3]);
	expect(durations).toEqual([0.1, 0.1, 0.1, 0.1]);
});

test('A NOTE before a WebVTT cue that spans several samples is written once', async () => {
	const mdatBoxes = async (text: string) => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new TextSubtitleSource('webvtt');
		output.addSubtitleTrack(source);
		await output.start();
		await source.add(text);
		await output.finalize();

		// The samples are runs of top-level boxes in the mdat
		const bytes = new Uint8Array(output.target.buffer!);
		const view = toDataView(bytes);
		const type = (pos: number) => String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
		let pos = 0;
		while (type(pos) !== 'mdat') {
			pos += view.getUint32(pos);
		}
		const end = pos + view.getUint32(pos);
		const boxes: string[] = [];
		for (pos += 8; pos < end; pos += view.getUint32(pos)) {
			const text = new TextDecoder().decode(bytes.subarray(pos + 8, pos + view.getUint32(pos)));
			boxes.push(type(pos) === 'vtta' ? `vtta:${text}` : type(pos));
		}
		return boxes;
	};

	// A (1-5 s) overlaps B (2-3 s), so A is split over the samples 1-2, 2-3 and 3-5 (ISO/IEC 14496-30). Its NOTE
	// belongs to the cue, not to each sample, and was repeated in each of them; GPAC (MP4Box) writes it once too.
	const prefix = 'WEBVTT\n\n00:00.000 --> 00:00.500\nX\n\nNOTE about A\n\n00:01.000 --> 00:05.000\nA\n';
	const split = await mdatBoxes(prefix + '\n00:02.000 --> 00:03.000\nB\n');
	expect(split.filter(box => box.startsWith('vtta'))).toEqual(['vtta:NOTE about A\n\n']);

	const single = await mdatBoxes(prefix);
	expect(single.filter(box => box.startsWith('vtta'))).toEqual(['vtta:NOTE about A\n\n']);
});

test('Non-zero start timestamp, fragmented MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') || str.includes('elst')).toBe(false);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	const durations: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		durations.push(packet.duration);
	}

	expect(timestamps).toEqual([1, 1.1, 1.2, 1.3]);
	expect(durations).toEqual([0.1, 0.1, 0.1, 0.1]);
});

test('Conversion fails instead of hanging when a closing track overruns the reserved packet count', async () => {
	// 16 s of copyable video and PCM audio
	const inputOutput = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const videoSource = new EncodedVideoPacketSource('vp8');
	const audioSource = new EncodedAudioPacketSource('pcm-s16');
	inputOutput.addVideoTrack(videoSource);
	inputOutput.addAudioTrack(audioSource);
	await inputOutput.start();
	for (let i = 0; i < 160; i++) {
		await videoSource.add(new EncodedPacket(new Uint8Array(100), i % 10 === 0 ? 'key' : 'delta', i / 10, 0.1), {
			decoderConfig: { codec: 'vp8', codedWidth: 64, codedHeight: 64 },
		});
		await audioSource.add(new EncodedPacket(new Uint8Array(9600), 'key', i / 10, 0.1), {
			decoderConfig: { codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 48000 },
		});
	}
	await inputOutput.finalize();

	using input = new Input({ source: new BufferSource(inputOutput.target.buffer!), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'reserve' }), target: new BufferTarget() });
	const conversion = await Conversion.init({
		input,
		output,
		audio: {
			codec: 'pcm-s16',
			// Doubles the audio, more than the estimated maximum packet count allows. When the copied video track
			// closes, the audio waiting to be interleaved with it overruns that count
			process: (sample) => {
				const repeat = sample.clone();
				repeat.setTimestamp(sample.timestamp + sample.duration);
				return [sample, repeat];
			},
		},
		showWarnings: false,
	});

	const outcome = await Promise.race([
		conversion.execute().then(() => 'done', (error: unknown) => String(error)),
		new Promise(resolve => setTimeout(() => resolve('hung'), 5000)),
	]);
	expect(outcome).toMatch(/Track #2 has already reached the maximum packet count/);
});

test('An output whose start() failed rejects packets and finalize() instead of hanging', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new PathedTarget('out.mp4', async () => {
			throw new Error('Could not create target');
		}),
	});
	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await expect(output.start()).rejects.toThrow('Could not create target');

	const settles = (promise: Promise<unknown>) => Promise.race([
		promise.then(() => 'resolved', () => 'rejected'),
		new Promise(resolve => setTimeout(() => resolve('hung'), 2000)),
	]);
	expect(await settles((async () => source.add(
		new EncodedPacket(new Uint8Array(400), 'key', 0, 0.01),
		{ decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } },
	))())).toBe('rejected');
	expect(await settles(output.finalize())).toBe('rejected');
	// Nothing can use the output anymore
	expect(output.state).toBe('canceled');
});

test('Negative start timestamps, regular MP4', async () => {
	await testNegativeTimestampRoundTrip(Array.from({ length: 50 }, (_, index) => (index - 10) / 10), 0.1, false);
});

test('Video wider or higher than 65535 pixels is rejected instead of written as 0 pixels', async () => {
	const muxVp9 = async (width: number, height: number) => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 1 / 30), {
			decoderConfig: { codec: 'vp09.00.10.08', codedWidth: width, codedHeight: height },
		});
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	// 65535 is the most the sample entry's 16-bit fields hold
	using input = new Input({ source: new BufferSource(await muxVp9(65535, 65535)), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	expect([await track.getCodedWidth(), await track.getCodedHeight()]).toEqual([65535, 65535]);

	// One more used to wrap to 0, which is what readers then got (AV1 and VP9 allow 65536)
	await expect(muxVp9(65536, 64)).rejects.toThrow('at most 65535x65535');
	await expect(muxVp9(64, 65536)).rejects.toThrow('at most 65535x65535');

	// A size declared with the track is rejected when the track is added: rejecting it once started would leave the
	// output hanging
	const settles = (promise: Promise<unknown>) => Promise.race([
		promise.then(() => 'resolved', () => 'rejected'),
		new Promise(resolve => setTimeout(() => resolve('hung'), 2000)),
	]);
	const declaredConfig = (codedWidth: number) => ({ codec: 'vp09.00.10.08', codedWidth, codedHeight: 16 });
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	expect(() => output.addVideoTrack(new EncodedVideoPacketSource('vp9'), { decoderConfig: declaredConfig(65536) }))
		.toThrow('at most 65535x65535');

	// The output is still usable
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source, { decoderConfig: declaredConfig(64) });
	expect(await settles(output.start())).toBe('resolved');
	expect(await settles(source.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 1 / 30)))).toBe('resolved');
	expect(await settles(output.finalize())).toBe('resolved');
});

test('Negative start timestamps, fragmented MP4', async () => {
	await testNegativeTimestampRoundTrip(Array.from({ length: 50 }, (_, index) => (index - 10) / 10), 0.1, true);
});

test('Opus from inputs below 48 kHz gets a 48 kHz media timescale, so its edit counts decoded samples', async () => {
	// What encoders like Chrome's WebCodecs one report for 8-24 kHz input: the input rate, and an OpusHead whose
	// pre-skip of 312 samples is at 48 kHz, as Opus always decodes at 48 kHz. Packets start that much before zero.
	const mux = async (sampleRate: number) => {
		const opusHead = new Uint8Array(19);
		opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1]); // "OpusHead", version, channel count
		toDataView(opusHead).setUint16(10, 312, true); // Pre-skip
		toDataView(opusHead).setUint32(12, sampleRate, true); // Input sample rate

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(source);
		await output.start();
		for (let i = 0; i < 25; i++) {
			const data = new Uint8Array([0xf8, 0xff, 0xfe]); // A 20 ms CELT packet (TOC config 31, one frame)
			await source.add(new EncodedPacket(data, 'key', i * 0.02 - 312 / 48000, 0.02), {
				decoderConfig: { codec: 'opus', numberOfChannels: 1, sampleRate, description: opusHead },
			});
		}
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		const view = toDataView(bytes);
		// Returns the offset of a FullBox's version byte
		const findFullBox = (type: string) => bytes.findIndex(
			(_, i) => String.fromCharCode(...bytes.subarray(i - 4, i)) === type,
		);
		const mdhd = findFullBox('mdhd');
		const elst = findFullBox('elst');
		expect([bytes[mdhd], bytes[elst]]).toEqual([0, 0]);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		return {
			timescale: view.getUint32(mdhd + 12),
			editMediaTime: view.getInt32(elst + 12),
			firstTimestampInSamples: Math.round(await track.getFirstTimestamp() * 48000),
		};
	};

	// The edit's media_time is the pre-skip in decoded samples. With the input rate as the timescale, it used to be
	// 52, 104 and 156: FFmpeg then skipped that many decoded samples, leaving the rest of the priming samples in.
	for (const sampleRate of [8000, 16000, 24000, 48000]) {
		expect({ sampleRate, ...await mux(sampleRate) }).toEqual({
			sampleRate,
			timescale: 48000,
			editMediaTime: 312,
			firstTimestampInSamples: -312, // The pre-skip, as before
		});
	}
});

test('Wholly negative timestamps, regular MP4', async () => {
	await testNegativeTimestampRoundTrip([-1, -0.9, -0.8, -0.7, -0.6], 0.1, false);
});

test('AV1 keeps its sequence header in av1C when the decoder config has no color space', async () => {
	// Sequence header OBU of a 320x240 libaom key frame, followed by the start of its frame OBU
	const sequenceHeaderObu = new Uint8Array([0x0a, 0x0b, 0, 0, 0, 0x04, 0x3c, 0xff, 0xbc, 0xda, 0xf9, 0x00, 0x40]);
	const packetData = new Uint8Array([...sequenceHeaderObu, 0x32, 0x04, 0x10, 0x00, 0x00, 0x00]);

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('av1');
	output.addVideoTrack(source);
	await output.start();
	await source.add(new EncodedPacket(packetData, 'key', 0, 1 / 30), {
		decoderConfig: { codec: 'av01.0.00M.08', codedWidth: 320, codedHeight: 240 },
	});
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	const text = new TextDecoder('latin1').decode(bytes);
	const av1C = text.indexOf('av1C') + 4;
	const av1CSize = toDataView(bytes).getUint32(av1C - 8);

	// AV1-ISOBMFF §2.3.4: "When configOBUs does not contain a Sequence Header OBU, a colr box with a colour_type set to
	// nclx SHALL be present". There was neither: configOBUs was always empty. Now it holds the sequence header, as
	// FFmpeg writes it.
	expect(text.includes('colr')).toBe(false);
	expect([...bytes.subarray(av1C, av1C - 8 + av1CSize)]).toEqual([0x81, 0x00, 0x0c, 0x00, ...sequenceHeaderObu]);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	expect(await track.getCodecParameterString()).toBe('av01.0.00M.08');
});

test('Wholly negative timestamps, fragmented MP4', async () => {
	await testNegativeTimestampRoundTrip([-1, -0.9, -0.8, -0.7, -0.6], 0.1, true);
});

const testNegativeTimestampRoundTrip = async (
	timestamps: number[],
	duration: number,
	fragmented: boolean,
) => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: fragmented ? 'fragmented' : false }),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, { frameRate: 10 });

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	const inputPackets = timestamps.map((timestamp, index) => new EncodedPacket(
		new Uint8Array(1024).fill(index),
		'key',
		timestamp,
		duration,
	));

	for (let i = 0; i < inputPackets.length; i++) {
		await source.add(inputPackets[i]!, i === 0 ? meta : undefined);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const outputPackets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		outputPackets.push(packet);
	}

	expect(outputPackets.map(packet => ({
		timestamp: packet.timestamp,
		duration: packet.duration,
	}))).toEqual(inputPackets.map(packet => ({
		timestamp: packet.timestamp,
		duration: packet.duration,
	})));

	for (const inputPacket of inputPackets) {
		const outputPacket = await sink.getPacket(inputPacket.timestamp);
		assert(outputPacket);

		expect({
			timestamp: outputPacket.timestamp,
			duration: outputPacket.duration,
		}).toEqual({
			timestamp: inputPacket.timestamp,
			duration: inputPacket.duration,
		});
	}
};

test('MP4 writes track dispositions as Track Kind Boxes with DASH roles', async () => {
	const writeTrack = async (
		format: Mp4OutputFormat | MovOutputFormat,
		metadata: Parameters<Output['addAudioTrack']>[1],
	) => {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(source, metadata);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(10), 'key', 0, 0.02), {
			decoderConfig: { codec: 'opus', numberOfChannels: 1, sampleRate: 48000 },
		});
		await output.finalize();

		// Collects the scheme URI and value of every kind box in a track's udta
		const bytes = new Uint8Array(output.target.buffer!);
		const view = toDataView(bytes);
		const kinds: string[] = [];
		const walk = (start: number, end: number) => {
			for (let pos = start; pos + 8 <= end;) {
				const size = view.getUint32(pos);
				if (size < 8) {
					break;
				}

				const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
				if (type === 'moov' || type === 'trak' || type === 'udta') {
					walk(pos + 8, pos + size);
				} else if (type === 'kind') {
					const text = new TextDecoder().decode(bytes.subarray(pos + 12, pos + size));
					kinds.push(text.split('\0', 2).join(' '));
				}
				pos += size;
			}
		};
		walk(0, bytes.byteLength);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		return { kinds, name: await track.getName() };
	};

	// The roles FFmpeg writes for these dispositions (and reads back); 'original' has no DASH role. These used to be
	// dropped, leaving only tkhd's enabled flag.
	const disposition = {
		commentary: true,
		hearingImpaired: true,
		visuallyImpaired: true,
		forced: true,
		original: true,
	};
	expect(await writeTrack(new Mp4OutputFormat(), { name: 'Commentary', disposition })).toEqual({
		kinds: [
			'urn:mpeg:dash:role:2011 caption',
			'urn:mpeg:dash:role:2011 commentary',
			'urn:mpeg:dash:role:2011 description',
			'urn:mpeg:dash:role:2011 forced-subtitle',
		],
		name: 'Commentary',
	});

	// Nothing for other tracks, nor in QuickTime files, as with FFmpeg
	expect(await writeTrack(new Mp4OutputFormat(), {})).toEqual({ kinds: [], name: null });
	expect(await writeTrack(new MovOutputFormat(), { disposition })).toEqual({ kinds: [], name: null });
});

test('PCM audio', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBe(0);
});

test('Reserved Fast Start rejects the packet over the maximum packet count and keeps the file consistent', async () => {
	const videoConfig = { codec: 'vp8', codedWidth: 64, codedHeight: 64 };
	const audioConfig = { codec: 'opus', numberOfChannels: 1, sampleRate: 48000 };
	const countSamples = async (bytes: Uint8Array) => {
		const text = new TextDecoder('latin1').decode(bytes);
		const stsz: number[] = [];
		for (let pos = text.indexOf('stsz'); pos !== -1; pos = text.indexOf('stsz', pos + 4)) {
			stsz.push(toDataView(bytes).getUint32(pos + 12)); // After version and flags, and sample_size
		}

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const readable: number[] = [];
		for (const track of await input.getTracks()) {
			let count = 0;
			for await (const packet of new EncodedPacketSink(track).packets()) {
				void packet;
				count++;
			}
			readable.push(count);
		}
		return { stsz, readable };
	};

	// The rejected packet used to stay counted in stsz (and stts, stss) without being in any chunk
	const single = new Output({ format: new Mp4OutputFormat({ fastStart: 'reserve' }), target: new BufferTarget() });
	const singleSource = new EncodedVideoPacketSource('vp8');
	single.addVideoTrack(singleSource, { maximumPacketCount: 2 });
	await single.start();
	await singleSource.add(new EncodedPacket(new Uint8Array(100), 'key', 0, 1), { decoderConfig: videoConfig });
	await singleSource.add(new EncodedPacket(new Uint8Array(100), 'key', 1, 1));
	await expect(singleSource.add(new EncodedPacket(new Uint8Array(100), 'key', 2, 1)))
		.rejects.toThrow('maximum packet count');
	await single.finalize();
	expect(await countSamples(new Uint8Array(single.target.buffer!))).toEqual({ stsz: [2], readable: [2] });

	// With several tracks, the error used to come from whichever add() interleaved the packet over the limit
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'reserve' }), target: new BufferTarget() });
	const videoSource = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(videoSource, { maximumPacketCount: 10 });
	const audioSource = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(audioSource, { maximumPacketCount: 100 });
	await output.start();

	const rejected: string[] = [];
	for (let i = 0; i < 50; i++) {
		if (i % 3 === 0) {
			await videoSource.add(new EncodedPacket(new Uint8Array(100), 'key', i * 0.02, 0.06), {
				decoderConfig: videoConfig,
			}).catch(() => rejected.push(`video ${i / 3}`));
		}
		await audioSource.add(new EncodedPacket(new Uint8Array(10), 'key', i * 0.02, 0.02), {
			decoderConfig: audioConfig,
		}).catch(() => rejected.push(`audio ${i}`));
	}
	await output.finalize();

	expect(rejected).toEqual([10, 11, 12, 13, 14, 15, 16].map(i => `video ${i}`));
	expect(await countSamples(new Uint8Array(output.target.buffer!))).toEqual({ stsz: [10, 50], readable: [10, 50] });
});

test('PCM audio with non-zero timestamp', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBe(1);
});

test('MP4 tkhd carries the presentation size of anamorphic video', async () => {
	const readTkhd = async (
		format: Mp4OutputFormat | MovOutputFormat,
		rotation: 0 | 180 | 270,
		[codedWidth, codedHeight]: [number, number],
		displayAspect?: [number, number],
	) => {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp8');
		output.addVideoTrack(source, { rotation });
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(100), 'key', 0, 1), {
			decoderConfig: {
				codec: 'vp8',
				codedWidth,
				codedHeight,
				displayAspectWidth: displayAspect?.[0],
				displayAspectHeight: displayAspect?.[1],
			},
		});
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		const view = toDataView(bytes);
		const tkhd = new TextDecoder('latin1').decode(bytes).indexOf('tkhd') + 4;
		const matrix = tkhd + 4 + (bytes[tkhd] === 1 ? 32 : 20) + 8 + 8;
		return {
			size: [view.getUint32(matrix + 36) / 0x10000, view.getUint32(matrix + 40) / 0x10000],
			translation: [view.getInt32(matrix + 24) / 0x10000, view.getInt32(matrix + 28) / 0x10000],
		};
	};

	// ISO/IEC 14496-12: for visual tracks, tkhd's width and height are the presentation size, to which all images are
	// scaled before the matrix applies. They used to be the pixel size (640) with only pasp saying 2:1 (here 32:9).
	const mp4 = new Mp4OutputFormat();
	expect(await readTkhd(mp4, 0, [640, 360], [32, 9])).toEqual({ size: [1280, 360], translation: [0, 0] });
	// So a half turn keeps the image in place by moving it by the presentation width
	expect(await readTkhd(mp4, 180, [640, 360], [32, 9])).toEqual({ size: [1280, 360], translation: [1280, 360] });

	// The matrix's translation is signed 16.16 (up to 32767), unlike the size. At 10:1, 4096 pixels are presented at
	// 40960, which still fits the size, but not a translation by it: there, the pixel size stays
	expect(await readTkhd(mp4, 0, [4096, 64], [640, 1])).toEqual({ size: [40960, 64], translation: [0, 0] });
	expect(await readTkhd(mp4, 180, [4096, 64], [640, 1])).toEqual({ size: [4096, 64], translation: [4096, 64] });
	expect((await readTkhd(mp4, 270, [4096, 64], [640, 1])).translation.every(x => x >= 0)).toBe(true);
	expect(await readTkhd(mp4, 180, [4096, 64], [256, 1])).toEqual({ size: [16384, 64], translation: [16384, 64] });

	// Square pixels are unchanged, and QuickTime keeps the pixel size, as FFmpeg does
	expect(await readTkhd(mp4, 0, [640, 360])).toEqual({ size: [640, 360], translation: [0, 0] });
	expect(await readTkhd(new MovOutputFormat(), 180, [640, 360], [32, 9])).toEqual({
		size: [640, 360],
		translation: [640, 360],
	});
});

test('PCM audio, silence padding', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('pcm-s16');
	const numChannels = await audioTrack.getNumberOfChannels();

	const expectedFrameCount = 48000 + 256;
	const sink = new EncodedPacketSink(audioTrack);
	let frameCount = 0;

	for await (const packet of sink.packets()) {
		frameCount += packet.byteLength / 2 / numChannels;
	}

	expect(frameCount).toBe(expectedFrameCount);
});

test('MP4 with B-frames lists the iso4 brand its version 1 ctts needs', async () => {
	// Major brand, then the compatible ones (skipping the minor version)
	const readBrands = (bytes: Uint8Array) => {
		const text = new TextDecoder('latin1').decode(bytes.subarray(8, toDataView(bytes).getUint32(0)));
		return text.match(/.{4}/g)!.filter((_, i) => i !== 1);
	};

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	const decoderConfig = await videoTrack.getDecoderConfig();
	assert(decoderConfig);

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	let count = 0;
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		await source.add(packet, { decoderConfig });
		if (++count === 30) {
			break;
		}
	}
	await output.finalize();

	// B-frames get a version 1 ctts (signed composition offsets) and a cslg box, which are 'iso4' features. The brands
	// used to stop at 'isom'.
	const bytes = new Uint8Array(output.target.buffer!);
	const ctts = new TextDecoder('latin1').decode(bytes).indexOf('ctts');
	expect(bytes[ctts + 4]).toBe(1);
	expect(readBrands(bytes)).toEqual(['isom', 'isom', 'avc1', 'mp41', 'iso4']);

	// Unchanged for codecs that don't reorder frames
	const vp9Output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const vp9Source = new EncodedVideoPacketSource('vp9');
	vp9Output.addVideoTrack(vp9Source);
	await vp9Output.start();
	await vp9Source.add(new EncodedPacket(new Uint8Array(10), 'key', 0, 1 / 30), {
		decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 },
	});
	await vp9Output.finalize();
	expect(readBrands(new Uint8Array(vp9Output.target.buffer!))).toEqual(['isom', 'isom', 'mp41']);
});

test('PCM audio, no silence padding with approximate timestamps', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);
	// 0.006 is 256/48000 "rounded up", but it's close enough for silence padding not to kick in
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0.006, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('pcm-s16');
	const numChannels = await audioTrack.getNumberOfChannels();

	const expectedFrameCount = 256 + 256;
	const sink = new EncodedPacketSink(audioTrack);
	let frameCount = 0;

	for await (const packet of sink.packets()) {
		frameCount += packet.byteLength / 2 / numChannels;
	}

	expect(frameCount).toBe(expectedFrameCount);
});

// https://github.com/Vanilagy/mediabunny/pull/391
test('Zero-duration WebVTT cues are dropped rather than hanging or crashing the muxer', () => {
	const cases: Record<string, string> = {
		alone: '00:01.000 --> 00:01.000\nZero\n',
		insideAnotherCue: '00:00.000 --> 00:02.000\nLong\n\n00:01.000 --> 00:01.000\nZero\n',
		betweenTwoCues: '00:00.000 --> 00:01.000\nA\n\n00:01.000 --> 00:01.000\nZero\n\n00:01.000 --> 00:02.000\nB\n',
	};

	// Muxing used to loop forever on such cues without ever yielding to timers (or to hit an assertion), so it runs
	// in a child process that a timeout can kill. It prints the cue texts of each output file's payl boxes.
	const script = `
		const { Output, BufferTarget, Mp4OutputFormat, TextSubtitleSource } = await import(process.env.MEDIABUNNY);
		for (const fastStart of [false, 'fragmented']) {
			for (const [name, cues] of Object.entries(JSON.parse(process.env.CASES))) {
				const output = new Output({ format: new Mp4OutputFormat({ fastStart }), target: new BufferTarget() });
				const source = new TextSubtitleSource('webvtt');
				output.addSubtitleTrack(source);
				await output.start();
				await source.add('WEBVTT\\n\\n' + cues);
				await output.finalize().catch(error => console.log(error.message));

				const text = new TextDecoder().decode(output.target.buffer ?? new ArrayBuffer(0));
				const texts = [...new Set([...text.matchAll(/payl(\\w+)/g)].map(match => match[1]))];
				console.log(name + ', ' + fastStart + ': ' + texts.join(' '));
			}
		}
	`;
	const args = ['--max-old-space-size=256', '--import', 'tsx', '--input-type=module', '-e', script];
	const result = spawnSync(process.execPath, args, {
		encoding: 'utf8',
		timeout: 10_000,
		env: {
			...process.env,
			MEDIABUNNY: new URL('../../src/index.ts', import.meta.url).href,
			CASES: JSON.stringify(cases),
		},
	});

	expect(result.signal).toBe(null); // Not killed by the timeout or by running out of memory
	expect(result.stderr).toBe('');
	expect(result.stdout.trim().split('\n')).toEqual([false, 'fragmented'].flatMap(fastStart => [
		`alone, ${fastStart}: `,
		`insideAnotherCue, ${fastStart}: Long`,
		`betweenTwoCues, ${fastStart}: A B`,
	]));
}, 60_000);

test('At least one track is enabled even if all are added disabled', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	const source1 = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source1, { disposition: { default: false } });

	const source2 = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source2, { disposition: { default: false } });

	await output.start();

	await source1.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);
	await source2.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getVideoTracks();
	expect(tracks.length).toBe(2);

	// Even though both tracks were added disabled, the muxer forces the first one to be enabled
	expect((await tracks[0]!.getDisposition()).default).toBe(true);
	expect((await tracks[1]!.getDisposition()).default).toBe(false);
});

test('btrt boxes computed from packet sizes, regular MP4', async () => {
	const bytes = await copyVideoMp4(new Mp4OutputFormat());
	const boxes = findBtrtBoxes(bytes);

	expect(boxes).toEqual([
		{
			bufferSizeDB: 0,
			maxBitrate: 3261384,
			avgBitrate: 2858330,
		},
		{
			bufferSizeDB: 0,
			maxBitrate: 318224,
			avgBitrate: 317375,
		},
	]);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	expect(await videoTrack.getBitrate()).toBe(3261384);
	expect(await videoTrack.getAverageBitrate()).toBe(2858330);
	expect(await audioTrack.getBitrate()).toBe(318224);
	expect(await audioTrack.getAverageBitrate()).toBe(317375);
});

test('AAC sample entry above 65535 Hz, MOV', async () => {
	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();

	const decoderConfig = {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 96000,
		description: new Uint8Array([0x10, 0x10]), // AAC-LC, 96 kHz, stereo
	};
	await source.add(new EncodedPacket(new Uint8Array(100), 'key', 0, 1024 / 96000), { decoderConfig });
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	const sampleEntry = findBox(bytes, [...STSD_PATH, 'mp4a']);
	assert(sampleEntry);

	const view = toDataView(bytes);
	const version = view.getUint16(sampleEntry.contentStart + 8);
	const sampleRate = view.getFloat64(sampleEntry.contentStart + 32);
	expect(version).toBe(2);
	expect(sampleRate).toBe(96000);
	expect(findBox(bytes, [...STSD_PATH, 'mp4a', 'esds'])).not.toBeNull();
});

test('PCM above 65535 Hz, MOV', async () => {
	await testPcmAbove65535Hz(new MovOutputFormat());
});

const testPcmAbove65535Hz = async (format: IsobmffOutputFormat) => {
	const output = new Output({
		format,
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s24');
	output.addAudioTrack(source);
	await output.start();

	const decoderConfig = {
		codec: 'pcm-s24',
		numberOfChannels: 2,
		sampleRate: 96000,
	};
	const data = new Uint8Array(6 * 960).map((_, i) => i);
	await source.add(new EncodedPacket(data, 'key', 0, 960 / 96000), { decoderConfig });
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getCodec()).toBe('pcm-s24');
	expect(await track.getSampleRate()).toBe(96000);
	expect(await track.getNumberOfChannels()).toBe(2);

	const readData: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		readData.push(...packet.data);
	}

	expect(new Uint8Array(readData)).toEqual(data);

	return new Uint8Array(output.target.buffer!);
};

test('btrt boxes copied from input metadata in conversion, fragmented MP4', async () => {
	const bytes = await copyVideoMp4(new Mp4OutputFormat({ fastStart: 'fragmented' }));

	// These are equal to what was in the input file
	expect(findBtrtBoxes(bytes)).toEqual([
		{
			bufferSizeDB: 0,
			maxBitrate: 2858329,
			avgBitrate: 2858329,
		},
		{
			bufferSizeDB: 0,
			maxBitrate: 320000,
			avgBitrate: 317375,
		},
	]);
});

test('Fragmented MP4 keeps writing fragments when two video tracks\' key frames don\'t line up', async () => {
	let moofCount = 0;
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented', onMoof: () => moofCount++ }),
		target: new BufferTarget(),
	});
	const first = new EncodedVideoPacketSource('vp8');
	const second = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(first);
	output.addVideoTrack(second);
	await output.start();

	// 10 fps for 20 s with a key frame every 2 s; the second track's key frames are 1 s later (and at 0)
	const decoderConfig = { codec: 'vp8', codedWidth: 320, codedHeight: 180 };
	for (let i = 0; i < 200; i++) {
		const firstType = i % 20 === 0 ? 'key' : 'delta';
		const secondType = i === 0 || i % 20 === 10 ? 'key' : 'delta';
		await first.add(new EncodedPacket(new Uint8Array([1, i]), firstType, i / 10, 0.1), { decoderConfig });
		await second.add(new EncodedPacket(new Uint8Array([2, i]), secondType, i / 10, 0.1), { decoderConfig });
	}
	const moofCountBeforeFinalize = moofCount;
	await output.finalize();

	// Samples per traf, by track. No fragment used to be written before finalize(), which then wrote all samples
	// into one.
	const bytes = new Uint8Array(output.target.buffer!);
	const view = toDataView(bytes);
	const type = (pos: number) => String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
	const trafSampleCounts = new Map<number, number[]>();
	for (let pos = 0; pos < bytes.byteLength; pos += view.getUint32(pos)) {
		if (type(pos) !== 'moof') {
			continue;
		}

		for (let traf = pos + 8; traf < pos + view.getUint32(pos); traf += view.getUint32(traf)) {
			if (type(traf) !== 'traf') {
				continue;
			}

			let trackId = 0;
			let sampleCount = 0;
			for (let child = traf + 8; child < traf + view.getUint32(traf); child += view.getUint32(child)) {
				if (type(child) === 'tfhd') {
					trackId = view.getUint32(child + 12);
				} else if (type(child) === 'trun') {
					sampleCount += view.getUint32(child + 12);
				}
			}
			trafSampleCounts.set(trackId, [...trafSampleCounts.get(trackId) ?? [], sampleCount]);
		}
	}
	// Each track is cut at its own key frames: the first every 2 s, the second at 3 s, 5 s, …
	expect(moofCountBeforeFinalize).toBe(18);
	expect([...trafSampleCounts]).toEqual([
		[1, Array<number>(10).fill(20)],
		[2, [30, ...Array<number>(8).fill(20), 10]],
	]);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const tracks = await input.getVideoTracks();
	expect(tracks).toHaveLength(2);
	for (const [trackIndex, track] of tracks.entries()) {
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		expect(packets).toHaveLength(200);
		for (let i = 0; i < 200; i++) {
			expect(packets[i]!.timestamp).toBeCloseTo(i / 10, 5);
			expect([...packets[i]!.data]).toEqual([trackIndex + 1, i]);
		}
	}
});

test('No btrt boxes, fragmented MP4 without bitrate metadata', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource((await videoTrack.getCodec())!);
	const audioSource = new EncodedAudioPacketSource((await audioTrack.getCodec())!);
	output.addVideoTrack(videoSource);
	output.addAudioTrack(audioSource);

	await output.start();

	const videoMeta = { decoderConfig: (await videoTrack.getDecoderConfig())! };
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		await videoSource.add(packet, videoMeta);
	}

	const audioMeta = { decoderConfig: (await audioTrack.getDecoderConfig())! };
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		await audioSource.add(packet, audioMeta);
	}

	await output.finalize();

	expect(findBtrtBoxes(new Uint8Array(output.target.buffer!))).toEqual([]);
});

test('btrt max bitrate counts the samples of one second, not one more', async () => {
	for (const frameRate of [24, 25, 30, 60]) {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source);
		await output.start();

		// Constant frame rate and size, so every one-second window holds exactly `frameRate` frames
		for (let i = 0; i < 3 * frameRate; i++) {
			const type = i === 0 ? 'key' : 'delta';
			const packet = new EncodedPacket(new Uint8Array(1000), type, i / frameRate, 1 / frameRate);
			await source.add(packet, { decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } });
		}
		await output.finalize();

		expect(findBtrtBoxes(new Uint8Array(output.target.buffer!))).toEqual([{
			bufferSizeDB: 0,
			maxBitrate: 8 * 1000 * frameRate,
			avgBitrate: 8 * 1000 * frameRate,
		}]);
	}
});

const copyVideoMp4 = async (format: Mp4OutputFormat) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format,
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	return new Uint8Array(output.target.buffer!);
};

const findBtrtBoxes = (bytes: Uint8Array) => {
	const view = toDataView(bytes);
	const boxes: { bufferSizeDB: number; maxBitrate: number; avgBitrate: number }[] = [];

	for (let i = 0; i < bytes.length - 4; i++) {
		if (bytes[i] !== 0x62 || bytes[i + 1] !== 0x74 || bytes[i + 2] !== 0x72 || bytes[i + 3] !== 0x74) {
			continue;
		}

		const boxSize = view.getUint32(i - 4);
		expect(boxSize).toBe(20);

		boxes.push({
			bufferSizeDB: view.getUint32(i + 4),
			maxBitrate: view.getUint32(i + 8),
			avgBitrate: view.getUint32(i + 12),
		});
	}

	return boxes;
};

test('Fragmented MP4 samples end where the next fragment starts with millisecond timestamps', async () => {
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source);
	await output.start();

	// 29.97 fps with timestamps rounded to milliseconds and exact frame durations, as in WebM files from FFmpeg
	for (let i = 0; i < 300; i++) {
		const timestamp = Math.round(i * 1001 / 30) / 1000;
		const packet = new EncodedPacket(new Uint8Array(16), i % 30 === 0 ? 'key' : 'delta', timestamp, 1001 / 30000);
		await source.add(packet, { decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } });
	}
	await output.finalize();

	// Each traf's decode time and the sum of its sample durations
	const bytes = new Uint8Array(output.target.buffer!);
	const view = toDataView(bytes);
	const type = (pos: number) => String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
	const fragments: { decodeTime: number; duration: number }[] = [];
	for (let pos = 0; pos < bytes.byteLength; pos += view.getUint32(pos)) {
		if (type(pos) !== 'moof') {
			continue;
		}

		const traf = pos + 8 + view.getUint32(pos + 8); // After mfhd
		let decodeTime = 0;
		let defaultDuration = 0;
		let duration = 0;
		for (let child = traf + 8; child < traf + view.getUint32(traf); child += view.getUint32(child)) {
			const flags = view.getUint32(child + 8) & 0xffffff;
			if (type(child) === 'tfhd' && flags & 0x08) {
				defaultDuration = view.getUint32(child + 16 + (flags & 0x01 ? 8 : 0) + (flags & 0x02 ? 4 : 0));
			} else if (type(child) === 'tfdt') {
				const isVersion1 = bytes[child + 8] === 1;
				decodeTime = isVersion1 ? Number(view.getBigUint64(child + 12)) : view.getUint32(child + 12);
			} else if (type(child) === 'trun') {
				const sampleCount = view.getUint32(child + 12);
				let entry = child + 16 + (flags & 0x01 ? 4 : 0) + (flags & 0x04 ? 4 : 0);
				const entrySize = 4 * [0x100, 0x200, 0x400, 0x800].filter(x => flags & x).length;
				for (let i = 0; i < sampleCount; i++, entry += entrySize) {
					duration += flags & 0x100 ? view.getUint32(entry) : defaultDuration;
				}
			}
		}
		fragments.push({ decodeTime, duration });
	}

	// ISO/IEC 14496-12: a fragment's decode time is the sum of the durations of all earlier samples. Each fragment's
	// last sample used to keep its packet duration, ending up to a third of a millisecond after the next fragment's
	// start, which readers adding up durations accumulate.
	expect(fragments).toHaveLength(10);
	for (let i = 1; i < fragments.length; i++) {
		expect(fragments[i]!.decodeTime).toBe(fragments[i - 1]!.decodeTime + fragments[i - 1]!.duration);
	}
});

test('Chunks written in chronological order, no Fast Start', async () => {
	await testChunkOrder(false);
});

test('Timestamps land on the nearest timescale tick in regular and fragmented files alike', async () => {
	const timescale = 57600; // The default video timescale, used when no frame rate is given

	// Timestamps in ticks: key frames only, then key + P + B frames in decode order
	const cases: { ticks: number[]; types: ('key' | 'delta')[] }[] = [
		{ ticks: [0.6, 11.1], types: ['key', 'key'] },
		{ ticks: [0.4, 15.6, 35.7], types: ['key', 'key', 'key'] },
		{ ticks: [0.4, 20.6, 10.3, 40.6, 30.3], types: ['key', 'delta', 'delta', 'delta', 'delta'] },
	];

	for (const { ticks, types } of cases) {
		for (const fastStart of [false, 'fragmented'] as const) {
			const output = new Output({
				format: new Mp4OutputFormat({ fastStart, minimumFragmentDuration: 0 }),
				target: new BufferTarget(),
			});
			const source = new EncodedVideoPacketSource('vp9');
			output.addVideoTrack(source);
			await output.start();

			for (const [i, tick] of ticks.entries()) {
				const packet = new EncodedPacket(new Uint8Array([i]), types[i]!, tick / timescale, 10 / timescale);
				await source.add(packet, {
					decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 },
				});
			}
			await output.finalize();

			using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
			const track = await input.getPrimaryVideoTrack();
			assert(track);

			const readTicks: number[] = [];
			for await (const packet of new EncodedPacketSink(track).packets()) {
				readTicks[packet.data[0]!] = packet.timestamp * timescale;
			}

			// Regular files used to round the first timestamp's fraction twice (0.6 + 10.5 -> 1 + 11 = 12), and both
			// layouts rounded the composition offsets separately from the decode times
			expect(readTicks.map(x => Math.round(x * 1000) / 1000)).toEqual(ticks.map(x => Math.round(x)));
		}
	}
});

test('Audio timestamps come back within half a sample when the track and movie timescales differ', async () => {
	// A positive start makes regular files begin with an empty edit, whose duration is in the movie timescale (57600)
	for (const sampleRate of [44100, 48000, 96000]) {
		const timestamps = Array.from(
			{ length: 40 },
			(_, i) => 0.1799910361 + (1024 * i + [-0.4, 0.3, -0.2, 0.4, 0.1][i % 5]!) / sampleRate,
		);

		for (const fastStart of [false, 'fragmented'] as const) {
			const output = new Output({
				format: new Mp4OutputFormat({ fastStart, minimumFragmentDuration: 0 }),
				target: new BufferTarget(),
			});
			const source = new EncodedAudioPacketSource('aac');
			output.addAudioTrack(source);
			await output.start();

			for (const [i, timestamp] of timestamps.entries()) {
				await source.add(new EncodedPacket(new Uint8Array([i]), 'key', timestamp, 1024 / sampleRate), {
					decoderConfig: {
						codec: 'mp4a.40.2',
						numberOfChannels: 2,
						sampleRate,
						description: new Uint8Array({ 44100: [0x12, 0x10], 48000: [0x11, 0x90], 96000: [0x10, 0x10] }[
							sampleRate
						]!),
					},
				});
			}
			await output.finalize();

			// Constant-rate audio needs no composition offsets, which FFmpeg would read differently
			const bytes = new Uint8Array(output.target.buffer!);
			expect(bytes.some((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === 'ctts')).toBe(false);

			using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
			const track = await input.getPrimaryAudioTrack();
			assert(track);

			const errors: number[] = [];
			for await (const packet of new EncodedPacketSink(track).packets()) {
				errors[packet.data[0]!] = Math.abs(packet.timestamp - timestamps[packet.data[0]!]!) * sampleRate;
			}
			expect(errors).toHaveLength(timestamps.length);

			// Above the movie timescale, the empty edit can't always end on the start's own tick, so the first sample
			// may be a tick further off
			const [firstError, ...otherErrors] = errors;
			expect(firstError).toBeLessThanOrEqual(fastStart === false && sampleRate > 57600 ? 1.5 : 0.5 + 1e-6);
			expect(Math.max(...otherErrors)).toBeLessThanOrEqual(0.5 + 1e-6);
		}
	}
});

test('Audio above the movie timescale whose first packets are less than a tick apart still muxes', async () => {
	// At 96 kHz, no empty edit converts back to these starts' own ticks (9601) in the reader: the closest ones end a
	// tick before (from 0.1000065 s) or after (from 9601.4 / 96000 s) the start
	const cases = [
		[0.1000065, 0.1000065, 0.1000065 + 1024 / 96000],
		[0.1000065, 0.1000065 + 0.3 / 96000],
		[9601.4 / 96000, 9601.4 / 96000, 9601.4 / 96000 + 1024 / 96000],
	];
	for (const timestamps of cases) {
		const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('aac');
		output.addAudioTrack(source);
		await output.start();

		for (const [i, timestamp] of timestamps.entries()) {
			await source.add(new EncodedPacket(new Uint8Array([i]), 'key', timestamp, 1024 / 96000), {
				decoderConfig: {
					codec: 'mp4a.40.2',
					numberOfChannels: 2,
					sampleRate: 96000,
					description: new Uint8Array([0x10, 0x10]),
				},
			});
		}
		await output.finalize(); // Used to fail an assertion on a negative decode delta

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const ticks: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			ticks[packet.data[0]!] = Math.round(packet.timestamp * 96000);
		}
		expect(ticks).toHaveLength(timestamps.length);

		// Packets within a tick of the start may be a tick off; the rest land on their own ticks
		const expected = timestamps.map(timestamp => Math.round(timestamp * 96000));
		for (const [i, tick] of ticks.entries()) {
			const withinATickOfStart = timestamps[i]! - timestamps[0]! < 1 / 96000;
			expect(Math.abs(tick - expected[i]!)).toBeLessThanOrEqual(withinATickOfStart ? 1 : 0);
		}
	}
});

test('Chunks written in chronological order, in-memory Fast Start', async () => {
	await testChunkOrder('in-memory');
});

test('AC-3 in MOV', async () => {
	await testAc3InMov('ac3', 'ac-3', 'dac3');
});

test('E-AC-3 in MOV', async () => {
	// Apple's players drop E-AC-3 tracks in MOV whose dec3 box isn't wrapped in a wave box
	await testAc3InMov('eac3', 'ec-3', 'dec3');
});

const testAc3InMov = async (codec: 'ac3' | 'eac3', sampleEntryName: string, configBoxName: string) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, `../public/${codec}.mp4`)),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		showWarnings: false,
	});
	await conversion.execute();

	// The config box goes into a wave box
	const bytes = new Uint8Array(output.target.buffer!);
	expect(findBox(bytes, [...STSD_PATH, sampleEntryName, 'wave', configBoxName])).not.toBeNull();

	using outputAsInput = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const track = await outputAsInput.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getCodec()).toBe(codec);
	expect(await track.getNumberOfChannels()).toBe(6);
	expect(await track.getSampleRate()).toBe(48000);
};

test('Chunks written in chronological order, reserved Fast Start', async () => {
	await testChunkOrder('reserve');
});

test('A video ending in B-frames keeps presentation after decode time for FFmpeg', async () => {
	// I P B B in decode order: the B-frames have the only negative composition offsets
	const gop = [0, 0.12, 0.04, 0.08];

	for (const gopCount of [1, 3]) {
		const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source);
		await output.start();

		const timestamps = Array.from({ length: gopCount }, (_, i) => gop.map(t => t + 0.16 * i)).flat();
		for (const [i, timestamp] of timestamps.entries()) {
			const packet = new EncodedPacket(new Uint8Array([i]), i % 4 === 0 ? 'key' : 'delta', timestamp, 0.04);
			await source.add(packet, { decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } });
		}
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		const view = toDataView(bytes);
		const find = (type: string) => bytes.findIndex(
			(_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === type,
		);
		const ctts = find('ctts');
		const offsets = Array.from({ length: view.getUint32(ctts + 8) }, (_, i) => view.getInt32(ctts + 16 + 8 * i));

		if (gopCount === 1) {
			// FFmpeg takes the decode time shift for negative offsets from all ctts entries but the last two, so with
			// one GOP it read the B-frames with pts < dts. Now no offset is negative, and the edit list compensates.
			expect(Math.min(...offsets)).toBe(0);
			const elst = find('elst');
			expect(view.getUint32(elst + 8)).toBe(1); // One entry
			expect(view.getInt32(elst + 16)).toBe(0.04 * 57600); // Media time
		} else {
			// Earlier GOPs already give FFmpeg the shift, so the layout stays as it was
			expect(Math.min(...offsets.slice(0, -2))).toBeLessThan(0);
			expect(find('edts')).toBe(-1);
		}

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const readTimestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			readTimestamps[packet.data[0]!] = packet.timestamp;
		}
		const round = (t: number) => Math.round(t * 1e6) / 1e6;
		expect(readTimestamps.map(round)).toEqual(timestamps.map(round));
		expect(await track.computeDuration()).toBeCloseTo(0.16 * gopCount, 6);
	}
});

const testChunkOrder = async (fastStart: false | 'in-memory' | 'reserve') => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource('vp8');
	const audioSource = new EncodedAudioPacketSource('mp3');
	output.addVideoTrack(videoSource, { maximumPacketCount: 1000 });
	output.addAudioTrack(audioSource, { maximumPacketCount: 1000 });

	await output.start();

	// Add all video before all audio, so the muxer can't just write chunks in the order they complete
	const videoMeta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	for (let i = 0; i < 150; i++) {
		const packet = new EncodedPacket(new Uint8Array(8), i === 0 ? 'key' : 'delta', i / 30, 1 / 30);
		await videoSource.add(packet, videoMeta);
	}

	const audioMeta = { decoderConfig: { codec: 'mp3', numberOfChannels: 2, sampleRate: 48000 } };
	for (let i = 0; i < 200; i++) {
		const packet = new EncodedPacket(new Uint8Array(8), 'key', 0.01 + 1152 * i / 48000, 1152 / 48000);
		await audioSource.add(packet, audioMeta);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	// Packet data read from a BufferSource is a view into the file, so its byte offset is its position in the file
	const packets: { trackIndex: number; timestamp: number; offset: number }[] = [];
	const tracks = await input.getTracks();
	for (let i = 0; i < tracks.length; i++) {
		for await (const packet of new EncodedPacketSink(tracks[i]!).packets()) {
			packets.push({
				trackIndex: i,
				timestamp: packet.timestamp,
				offset: packet.data.byteOffset,
			});
		}
	}

	expect(packets).toHaveLength(350);
	const packetsInFileOrder = packets.sort((a, b) => a.offset - b.offset);

	const chunkStartTimestamps: number[] = [];
	for (let i = 0; i < packetsInFileOrder.length; i++) {
		if (i === 0 || packetsInFileOrder[i]!.trackIndex !== packetsInFileOrder[i - 1]!.trackIndex) {
			chunkStartTimestamps.push(packetsInFileOrder[i]!.timestamp);
		}
	}

	expect(chunkStartTimestamps.length).toBeGreaterThan(10);
	expect(chunkStartTimestamps).toEqual([...chunkStartTimestamps].sort((a, b) => a - b));
};

test('In-memory Fast Start hands the media data to a StreamTarget chunk by chunk', async () => {
	let totalSize = 0;
	let largestWrite = 0;
	const writable = new WritableStream<StreamTargetChunk>({
		write: (chunk) => {
			totalSize = Math.max(totalSize, chunk.position + chunk.data.byteLength);
			largestWrite = Math.max(largestWrite, chunk.data.byteLength);
		},
	});

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
		target: new StreamTarget(writable),
	});
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source, { frameRate: 30 });
	await output.start();

	// 40 s of 256 KiB frames, as half-second chunks of 7.5 MiB, 300 MiB in total; every packet is a view of one buffer
	const frame = new Uint8Array(2 ** 18);
	for (let i = 0; i < 1200; i++) {
		await source.add(new EncodedPacket(frame, i === 0 ? 'key' : 'delta', i / 30, 1 / 30), {
			decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 },
		});
	}
	await output.finalize();

	expect(totalSize).toBeGreaterThan(300 * 2 ** 20);
	// The file is already held in memory once; one write of the whole media data used to copy all of it again
	expect(largestWrite).toBeLessThan(16 * 2 ** 20);
}, 60_000);

test('Reserved Fast Start rejects a maximum packet count beyond u32', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'reserve' }),
		target: new BufferTarget(),
	});
	output.addVideoTrack(new EncodedVideoPacketSource('vp8'), { maximumPacketCount: 2 ** 32 });

	await expect(output.start()).rejects.toThrow('exceeds the maximum');
});

test('Reserved Fast Start leaves room for many short tracks', async () => {
	const audioConfig = {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		description: new Uint8Array([0x11, 0x90]),
	};
	const videoConfig = { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 };

	for (const kind of ['video', 'audio'] as const) {
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'reserve' }),
			target: new BufferTarget(),
		});

		// Few packets per track, starting at 1 s: each track's edit list, btrt and sample group (audio) or
		// stss/ctts/cslg (video) headers outweigh the slack in its sample table estimate
		const trackCount = kind === 'audio' ? 100 : 40;
		const packetCount = kind === 'audio' ? 2 : 3;
		const sources = Array.from({ length: trackCount }, () => {
			if (kind === 'audio') {
				const source = new EncodedAudioPacketSource('aac');
				output.addAudioTrack(source, { maximumPacketCount: packetCount });
				return source;
			} else {
				const source = new EncodedVideoPacketSource('vp9');
				output.addVideoTrack(source, { maximumPacketCount: packetCount });
				return source;
			}
		});
		await output.start();

		for (let i = 0; i < packetCount; i++) {
			for (const source of sources) {
				if (source instanceof EncodedAudioPacketSource) {
					const packet = new EncodedPacket(new Uint8Array(10), 'key', 1 + i * 1024 / 48000, 1024 / 48000);
					await source.add(packet, { decoderConfig: audioConfig });
				} else {
					// I P B in decode order, with slightly uneven frame times
					const frame = [0, 2, 1][i]!;
					const timestamp = 1 + frame / 30 + i * 1e-4;
					const packet = new EncodedPacket(new Uint8Array(10), i === 0 ? 'key' : 'delta', timestamp, 1 / 30);
					await source.add(packet, { decoderConfig: videoConfig });
				}
			}
		}

		await output.finalize(); // Threw "The moov box … exceed the space reserved for them"

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const tracks = await input.getTracks();
		expect(tracks).toHaveLength(trackCount);
		let packetsRead = 0;
		for await (const packet of new EncodedPacketSink(tracks.at(-1)!).packets()) {
			expect(packet.timestamp).toBeGreaterThanOrEqual(1);
			packetsRead++;
		}
		expect(packetsRead).toBe(packetCount);
	}
});

test('Fragmented MP4 keeps the start offset of a track starting after the first fragment could be cut', async () => {
	// The avcC of video.mp4, so that a real SPS is parsed; the packet payloads are stubs
	const avcDescription = new Uint8Array([
		0x01, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x1e, 0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02,
		0x27, 0xe5, 0xc0, 0x5b, 0x81, 0x01, 0x02, 0xd2, 0x80, 0x00, 0x00, 0x03, 0x00, 0x80, 0x00, 0x00, 0x19,
		0x07, 0x8c, 0x18, 0xcb, 0x01, 0x00, 0x06, 0x68, 0xeb, 0xe0, 0x8c, 0xb2, 0x2c, 0xfd, 0xf8, 0xf8, 0x00,
	]);

	const muxStaggered = async (minimumFragmentDuration: number) => {
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration }),
			target: new BufferTarget(),
		});
		const video = new EncodedVideoPacketSource('avc');
		const audio = new EncodedAudioPacketSource('opus');
		output.addVideoTrack(video);
		output.addAudioTrack(audio);
		await output.start();

		// Video starts at -0.5 s (a key frame every other frame), the Opus track at -0.02 s; added in timestamp order
		const packets: { timestamp: number; isVideo: boolean; index: number }[] = [];
		for (let i = 0; i < 60; i++) {
			packets.push({ timestamp: -0.5 + i / 30, isVideo: true, index: i });
			packets.push({ timestamp: -0.02 + i * 0.02, isVideo: false, index: i });
		}
		packets.sort((a, b) => a.timestamp - b.timestamp);

		const videoConfig = { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080, description: avcDescription };
		const audioConfig = { codec: 'opus', numberOfChannels: 2, sampleRate: 48000 };
		for (const { timestamp, isVideo, index } of packets) {
			if (isVideo) {
				const data = new Uint8Array([0, 0, 0, 2, 0x65, 0x88]);
				const packet = new EncodedPacket(data, index % 2 === 0 ? 'key' : 'delta', timestamp, 1 / 30);
				await video.add(packet, index === 0 ? { decoderConfig: videoConfig } : undefined);
			} else {
				const packet = new EncodedPacket(new Uint8Array([0xfc, 0xff, 0xfe]), 'key', timestamp, 0.02);
				await audio.add(packet, index === 0 ? { decoderConfig: audioConfig } : undefined);
			}
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const firstTimestamps: number[] = [];
		for (const track of await input.getTracks()) {
			for await (const packet of new EncodedPacketSink(track).packets()) {
				firstTimestamps.push(packet.timestamp);
				break;
			}
		}
		return firstTimestamps;
	};

	// With the default fragment duration, no fragment is cut before the audio track is underway
	expect(await muxStaggered(1)).toEqual([-0.5, -0.02]);

	// With short fragments, the moov went out before the audio track's start offset was known: it had no edit list,
	// and its audio was read back from 0
	expect(await muxStaggered(0)).toEqual([-0.5, -0.02]);
});

// This used to cause an assertion failure in the box writing code
test('Reserved Fast Start with a B-frame GOP completed before all tracks are known', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'reserve' }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource('vp8');
	const audioSource = new EncodedAudioPacketSource('mp3');
	output.addVideoTrack(videoSource, { maximumPacketCount: 100 });
	output.addAudioTrack(audioSource, { maximumPacketCount: 100 });

	await output.start();

	const videoMeta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	const videoTimestamps = [0, 0.2, 0.1, 0.3];
	for (let i = 0; i < videoTimestamps.length; i++) {
		const type = i === 0 || i === 3 ? 'key' : 'delta';
		await videoSource.add(new EncodedPacket(new Uint8Array(8), type, videoTimestamps[i]!, 0.1), videoMeta);
	}

	const audioMeta = { decoderConfig: { codec: 'mp3', numberOfChannels: 2, sampleRate: 48000 } };
	await audioSource.add(new EncodedPacket(new Uint8Array(8), 'key', 0, 1152 / 48000), audioMeta);

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual(videoTimestamps);
});

test('The last presented frame keeps its duration when B-frames follow it in decode order', async () => {
	// Presentation times in decode order: I P B B, and a B-pyramid tail like x264's (I P B b b P B B), where the last
	// P frame is presented last
	const gops = [[0, 0.12, 0.04, 0.08], [0, 0.16, 0.08, 0.04, 0.12, 0.28, 0.20, 0.24]];

	for (const timestamps of gops) {
		const lastPresented = timestamps.indexOf(Math.max(...timestamps));

		for (const fastStart of [false, 'in-memory'] as const) {
			for (const heldDuration of [0.04, 0.5]) {
				const output = new Output({ format: new Mp4OutputFormat({ fastStart }), target: new BufferTarget() });
				const source = new EncodedVideoPacketSource('vp9');
				output.addVideoTrack(source);
				await output.start();

				for (const [i, timestamp] of timestamps.entries()) {
					const duration = i === lastPresented ? heldDuration : 0.04;
					const type = i === 0 ? 'key' : 'delta';
					const packet = new EncodedPacket(new Uint8Array([i]), type, timestamp, duration);
					await source.add(packet, {
						decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 },
					});
				}
				await output.finalize();

				const bytes = new Uint8Array(output.target.buffer!);
				using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
				const track = await input.getPrimaryVideoTrack();
				assert(track);

				const packets: { timestamp: number; duration: number }[] = [];
				for await (const packet of new EncodedPacketSink(track).packets()) {
					packets[packet.data[0]!] = { timestamp: packet.timestamp, duration: packet.duration };
				}
				expect(packets.map(x => x.timestamp)).toEqual(timestamps);
				// Was 0.04, the time up to the next decoded frame
				expect(packets[lastPresented]!.duration).toBeCloseTo(heldDuration, 6);
				expect(await track.computeDuration()).toBeCloseTo(timestamps[lastPresented]! + heldDuration, 6);

				if (heldDuration > 0.04) {
					// FFmpeg takes the decode time shift for negative composition offsets from all ctts entries but the
					// last two, so the trailing frames must not need more of it than the earlier ones give
					const ctts = bytes.findIndex(
						(_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === 'ctts',
					);
					const view = toDataView(bytes);
					const offsets = Array.from(
						{ length: view.getUint32(ctts + 8) },
						(_, i) => view.getInt32(ctts + 16 + 8 * i),
					);
					expect(Math.min(...offsets)).toBeGreaterThanOrEqual(0);
				}
			}
		}
	}
});

test('A track ends where its metadata says when an earlier frame declares a later end', async () => {
	// I P B in decode order, where the B-frame's declared end (0.04 + 0.2) is past the last presented frame's (0.13)
	const packets = [[0, 0.04], [0.12, 0.01], [0.04, 0.2]] as const;

	const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source);
	await output.start();

	for (const [i, [timestamp, duration]] of packets.entries()) {
		const packet = new EncodedPacket(new Uint8Array([i]), i === 0 ? 'key' : 'delta', timestamp, duration);
		await source.add(packet, { decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } });
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	// The movie and track durations cover the latest declared end, and so do the samples now
	expect(await track.getDurationFromMetadata()).toBeCloseTo(0.24, 6);
	expect(await track.computeDuration()).toBeCloseTo(0.24, 6);
});

test('B-frame streams that hold nothing keep their layout, however long', { timeout: 120_000 }, async () => {
	// P B B mini-GOPs in decode order, timestamps index * (1 / fps), every frame lasting 1 / fps
	const write = async (frameCount: number, fps: number, keyInterval: number) => {
		const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source);
		await output.start();

		const data = new Uint8Array(1);
		const frame = 1 / fps;
		for (let k = 0; k < frameCount / 3; k++) {
			for (const j of k === 0 ? [0, 2, 1] : [2, 0, 1]) {
				const index = 3 * k + j;
				const isKey = index % keyInterval === 0 && (k === 0 || j === 2);
				await source.add(
					new EncodedPacket(data, isKey ? 'key' : 'delta', index * frame, frame),
					{ decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } },
				);
			}
		}
		await output.finalize();

		return new Uint8Array(output.target.buffer!);
	};

	// Floating-point noise in the last frame's end used to count as a hold, adding an edit list
	const bytes = await write(33, 30, 1000);
	expect(bytes.some((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === 'edts')).toBe(false);

	// About 220,000 ctts entries, which used to overflow the call stack
	expect((await write(330_000, 25, 250)).byteLength).toBeGreaterThan(0);
});

test('Fragmented MP4 preserves interior key packets', async () => {
	const target = new BufferTarget();
	const output = new Output({
		target,
		format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 10 }),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();

	for (let i = 0; i < 6; i++) {
		await source.add(new EncodedPacket(new Uint8Array(1), i % 2 === 0 ? 'key' : 'delta', i, 1), {
			decoderConfig: { codec: 'vp8', codedWidth: 320, codedHeight: 180 },
		});
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	const first = await sink.getFirstKeyPacket({ metadataOnly: true });
	assert(first);

	expect((await sink.getNextKeyPacket(first, { metadataOnly: true }))?.timestamp).toBe(2);
	expect((await sink.getKeyPacket(4.1, { metadataOnly: true }))?.timestamp).toBe(4);
});

test('FLAC sample entry declares the bit depth from STREAMINFO', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('flac');
	output.addAudioTrack(source);
	await output.start();

	// 'fLaC', last STREAMINFO block header, then STREAMINFO: 48 kHz, 2 channels, 24 bits per sample
	const description = new Uint8Array([
		0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22,
		0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0b, 0xb8, 0x03, 0x70,
		0x00, 0x00, 0x00, 0x00, ...new Uint8Array(16),
	]);
	await source.add(new EncodedPacket(new Uint8Array(100), 'key', 0, 4096 / 48000), {
		decoderConfig: { codec: 'flac', numberOfChannels: 2, sampleRate: 48000, description },
	});
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	const entryType = bytes.findIndex((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === 'fLaC');
	expect(entryType).toBeGreaterThan(0);

	// AudioSampleEntry: reserved (6), data_reference_index, reserved (8), channelcount, samplesize
	const sampleSize = toDataView(bytes).getUint16(entryType + 4 + 6 + 2 + 8 + 2);
	expect(sampleSize).toBe(24); // FLAC-in-ISOBMFF requires samplesize to equal the STREAMINFO bit depth
});

test('CMAF sidx uses the timescale and ID of the referenced track', async () => {
	const output = new Output({
		format: new CmafOutputFormat(),
		target: new BufferTarget(),
		initTarget: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();

	const decoderConfig = {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		description: new Uint8Array([0x11, 0x90]), // AAC-LC, 48 kHz, stereo
	};
	for (let i = 0; i < 10; i++) {
		const packet = new EncodedPacket(new Uint8Array(16), 'key', i * 1024 / 48000, 1024 / 48000);
		await source.add(packet, { decoderConfig });
	}
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	const view = toDataView(bytes);
	const sidxType = bytes.findIndex((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === 'sidx');
	expect(sidxType).toBeGreaterThan(0);

	// ISO 14496-12 recommends the mdhd timescale of the reference track; FFmpeg takes the subsegment duration as is
	expect(view.getUint32(sidxType + 8)).toBe(1); // reference_ID
	expect(view.getUint32(sidxType + 12)).toBe(48000); // timescale
	expect(view.getUint32(sidxType + 40)).toBe(10 * 1024); // subsegment_duration
});

test('Reserved Fast Start conversion of a video whose frame rate rises later on', async () => {
	// Like a screen recording: one frame per second while nothing changes, then 60 fps
	const timestamps = [
		...Array.from({ length: 300 }, (_, i) => i),
		...Array.from({ length: 2000 }, (_, i) => 300 + i / 60),
	];

	const inputOutput = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const inputSource = new EncodedVideoPacketSource('vp8');
	inputOutput.addVideoTrack(inputSource);
	await inputOutput.start();
	for (let i = 0; i < timestamps.length; i++) {
		const duration = (timestamps[i + 1] ?? timestamps[i]! + 1 / 60) - timestamps[i]!;
		await inputSource.add(
			new EncodedPacket(new Uint8Array(8).fill(i), i === 0 ? 'key' : 'delta', timestamps[i]!, duration),
			i === 0 ? { decoderConfig: { codec: 'vp8', codedWidth: 16, codedHeight: 16 } } : undefined,
		);
	}
	await inputOutput.finalize();

	using input = new Input({ source: new BufferSource(inputOutput.target.buffer!), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'reserve' }), target: new BufferTarget() });

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute(); // Used to exceed the estimated maximum packet count

	using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const outputTrack = await outputInput.getPrimaryVideoTrack();
	assert(outputTrack);
	expect((await outputTrack.computePacketStats()).packetCount).toBe(timestamps.length);
});

test('Reserved Fast Start conversion of audio whose packet rate rises later on', async () => {
	// Like a WebRTC recording with DTX: one Opus packet per 400 ms during silence, then one per 20 ms
	const timestamps = [
		...Array.from({ length: 300 }, (_, i) => i * 0.4),
		...Array.from({ length: 3000 }, (_, i) => 120 + i * 0.02),
	];

	const inputOutput = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	const inputSource = new EncodedAudioPacketSource('opus');
	inputOutput.addAudioTrack(inputSource);
	await inputOutput.start();
	for (let i = 0; i < timestamps.length; i++) {
		await inputSource.add(
			new EncodedPacket(new Uint8Array([0xfc, i & 0xff]), 'key', timestamps[i]!, 0.02),
			i === 0 ? { decoderConfig: { codec: 'opus', numberOfChannels: 1, sampleRate: 48000 } } : undefined,
		);
	}
	await inputOutput.finalize();

	using input = new Input({ source: new BufferSource(inputOutput.target.buffer!), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'reserve' }), target: new BufferTarget() });

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute(); // Used to exceed the estimated maximum packet count

	using outputInput = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const outputTrack = await outputInput.getPrimaryAudioTrack();
	assert(outputTrack);
	expect((await outputTrack.computePacketStats()).packetCount).toBe(timestamps.length);
});

test('Opus sample entry and dOps both declare 48 kHz, whatever the input sample rate was', async () => {
	for (const sampleRate of [48000, 16000]) {
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new BufferTarget(),
		});

		const source = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(source);
		await output.start();

		// OpusHead of a stream encoded from 44.1 kHz input, as Chromium's encoder writes it
		const description = new Uint8Array([
			0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x44, 0xac, 0x00, 0x00, 0, 0, 0,
		]);
		await source.add(new EncodedPacket(new Uint8Array([0xfc, 0xff, 0xfe]), 'key', 0, 0.02), {
			decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate, description },
		});
		await output.finalize();

		const bytes = new Uint8Array(output.target.buffer!);
		const view = toDataView(bytes);
		const find = (type: string) => bytes.findIndex(
			(_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === type,
		);

		// Opus-in-ISOBMFF requires 48000 in the sample entry, and Chromium requires dOps' InputSampleRate to match it
		const entryRate = view.getUint32(find('Opus') + 4 + 6 + 2 + 8 + 2 + 2 + 4) / 0x10000;
		const inputSampleRate = view.getUint32(find('dOps') + 4 + 1 + 1 + 2);
		expect(entryRate).toBe(48000);
		expect(inputSampleRate).toBe(48000);
	}
});

test('In-memory Fast Start keeps chunk offsets right when a second track crosses 4 GiB late', async () => {
	// Every packet is a view into this buffer, and the target drops the data, so the 5 GiB file never exists in memory
	const buffer = new Uint8Array(138_000_100);
	const videoSize = (i: number) => 138_000_000 + i;
	const audioSize = (i: number, padding: number) => 100_000 + i + (i === 0 ? padding : 0);

	const mux = async (padding: number) => {
		let moov: Uint8Array | null = null;
		const writePositions = new Map<number, number>(); // Packet size -> where it was written
		const target = new NullTarget();
		target.on('write', ({ start, end }) => writePositions.set(end - start, start));

		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'in-memory', onMoov: data => moov = data.slice() }),
			target,
		});
		const videoSource = new EncodedVideoPacketSource('vp9');
		const audioSource = new EncodedAudioPacketSource('aac');
		output.addVideoTrack(videoSource);
		output.addAudioTrack(audioSource);
		await output.start();

		// One chunk per packet; the audio track ends 9 large video chunks before the end
		for (let i = 0; i < 40; i++) {
			await videoSource.add(
				new EncodedPacket(buffer.subarray(0, videoSize(i)), i === 0 ? 'key' : 'delta', i, 1),
				{ decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } },
			);
			if (i < 31) {
				await audioSource.add(
					new EncodedPacket(buffer.subarray(0, audioSize(i, padding)), 'key', i, 1),
					{ decoderConfig: {
						codec: 'mp4a.40.2',
						numberOfChannels: 2,
						sampleRate: 48000,
						description: new Uint8Array([0x11, 0x90]),
					} },
				);
			}
		}
		await output.finalize();

		// The stco/co64 chunk offsets of each track
		assert(moov);
		const bytes: Uint8Array = moov;
		const view = toDataView(bytes);
		const offsetTables: number[][] = [];
		for (let i = 0; i + 4 <= bytes.length; i++) {
			const type = String.fromCharCode(...bytes.subarray(i, i + 4));
			if (type === 'stco' || type === 'co64') {
				offsetTables.push(Array.from({ length: view.getUint32(i + 8) }, (_, j) => type === 'co64'
					? Number(view.getBigUint64(i + 12 + 8 * j))
					: view.getUint32(i + 12 + 4 * j),
				));
			}
		}

		return { offsetTables, writePositions };
	};

	// The audio track's last chunk starts below 4 GiB, so only the video track needs co64. Before the moov grew by
	// 4 bytes for each video chunk offset and the mdat header by 8 bytes, that audio chunk sat this much lower:
	const unpadded = await mux(0);
	const videoChunkCount = unpadded.offsetTables[0]!.length;
	const lastAudioChunk = unpadded.offsetTables[1]!.at(-1)! - 4 * videoChunkCount - 8;

	// Pad the audio so that this chunk starts just below 4 GiB in the first layout, but past it once the moov grew
	const padding = 2 ** 32 - 8 - lastAudioChunk;
	const { offsetTables, writePositions } = await mux(padding);
	expect(offsetTables[1]!.at(-1)).toBeGreaterThanOrEqual(2 ** 32);

	expect(offsetTables[0]).toEqual(offsetTables[0]!.map((_, i) => writePositions.get(videoSize(i))));
	expect(offsetTables[1]).toEqual(offsetTables[1]!.map((_, i) => writePositions.get(audioSize(i, padding))));
});

test('getMimeType names the hvc1 sample entry when remuxing an hev1 HEVC track', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video-h265.mp4')),
		formats: ALL_FORMATS,
	});
	const inputTrack = await input.getPrimaryVideoTrack();
	assert(inputTrack);
	const decoderConfig = await inputTrack.getDecoderConfig();
	assert(decoderConfig);
	expect(decoderConfig.codec).toBe('hev1.1.6.L120.90'); // The source uses an 'hev1' sample entry

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('hevc');
	output.addVideoTrack(source);
	await output.start();
	const packet = await new EncodedPacketSink(inputTrack).getFirstPacket();
	assert(packet);
	await source.add(packet, { decoderConfig });
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	const contains = (fourCc: string) => bytes.some(
		(_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === fourCc,
	);
	expect(contains('hvc1')).toBe(true);
	expect(contains('hev1')).toBe(false);

	// The codec string's first element is the sample entry's four-character code (RFC 6381)
	expect(await output.getMimeType()).toBe('video/mp4; codecs="hvc1.1.6.L120.90"');
});

test('Media handler boxes have pre_defined = 0 in MP4 and the mhlr component type in MOV', async () => {
	for (const [format, expected] of [[new Mp4OutputFormat(), '\0\0\0\0'], [new MovOutputFormat(), 'mhlr']] as const) {
		const output = new Output({ format, target: new BufferTarget() });
		const source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(10), 'key', 0, 1), {
			decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 },
		});
		await output.finalize();

		// The handler box of the track's media box, the one with the 'vide' handler type
		const bytes = new Uint8Array(output.target.buffer!);
		const text = (start: number) => String.fromCharCode(...bytes.subarray(start, start + 4));
		const hdlr = bytes.findIndex((_, i) => text(i) === 'hdlr' && text(i + 12) === 'vide');
		expect(hdlr).toBeGreaterThan(0);
		expect(text(hdlr + 8)).toBe(expected); // pre_defined, or the component type in QuickTime
	}
});

test('Fragmented MP4 does not keep the samples of fragments it already wrote', async () => {
	const target = new BufferTarget();
	const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: 'fragmented' }) });

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();

	// 100 s at 30 fps with a key frame every second, so roughly one fragment per second
	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 320, codedHeight: 180 } };
	for (let i = 0; i < 3000; i++) {
		await source.add(new EncodedPacket(new Uint8Array(1), i % 30 === 0 ? 'key' : 'delta', i / 30, 1 / 30), meta);
	}

	// A written fragment is only needed for its tfra entry: at most its first key sample should stay in memory, not
	// all of them (which grows without bound for long live streams)
	const trackData = (output._muxer as IsobmffMuxer).trackDatas[0]!;
	expect(trackData.finalizedChunks.length).toBeGreaterThan(90);
	const retainedSampleCount = trackData.finalizedChunks.reduce((sum, chunk) => sum + chunk.samples.length, 0);
	expect(retainedSampleCount).toBe(trackData.finalizedChunks.length);

	await output.finalize();

	using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);
	expect((await sink.getKeyPacket(50.5, { metadataOnly: true }))?.timestamp).toBe(50);
	expect((await sink.getPacket(Infinity, { metadataOnly: true }))?.timestamp).toBeCloseTo(2999 / 30);
});

test('VP9 and AV1 codec strings whose fields do not fit vpcC or av1C are rejected', async () => {
	const addFirstPacket = async (codec: string) => {
		const target = new BufferTarget();
		const output = new Output({ target, format: new Mp4OutputFormat() });
		const source = new EncodedVideoPacketSource(codec.startsWith('av01') ? 'av1' : 'vp9');
		output.addVideoTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(8), 'key', 0, 1), {
			decoderConfig: { codec, codedWidth: 64, codedHeight: 64 },
		});
		await output.finalize();
		return new Uint8Array(target.buffer!);
	};

	// These used to be written as-is, e.g. level 40 went into av1C as seq_profile 1, seq_level_idx 8, and a VP9 bit
	// depth of 16 became 0 in the 4-bit vpcC field
	for (const codec of [
		'vp09.04.10.08', // Profile
		'vp09.00.13.08', // Level
		'vp09.00.10.16', // Bit depth
		'vp09.00.10.08.04.01.01.01.00', // Chroma subsampling
		'vp09.00.10.08.01.01.01.01.02', // Full range flag
		'av01.3.04M.08', // Profile
		'av01.0.40M.08', // Level
		'av01.0.04M.16', // Bit depth
		'av01.0.04M.08.2.110.01.01.01.0', // Monochrome
		'av01.0.04M.08.0.120.01.01.01.0', // Chroma subsampling
		'av01.0.04M.08.0.101.01.01.01.0', // Chroma sample position without 4:2:0
		'av01.0.04M.08.0.110.01.01.01.2', // Full range flag
	]) {
		await expect(addFirstPacket(codec), codec).rejects.toThrow(TypeError);
	}

	for (const codec of ['vp09.00.00.08', 'vp09.03.62.12.03.09.16.09.01', 'av01.2.31H.12.1.113.09.16.09.1']) {
		const bytes = await addFirstPacket(codec);
		expect(bytes.byteLength, codec).toBeGreaterThan(0);
	}

	const av1c = await addFirstPacket('av01.0.31M.10.0.112.09.16.09.0');
	const av1cOffset = Buffer.from(av1c).indexOf('av1C') + 4;
	expect([...av1c.subarray(av1cOffset, av1cOffset + 3)]).toEqual([0x81, 0x1f, 0x4e]); // Profile 0, level 31, 10-bit
});

test('esds ES_Descriptor is written with ES_ID 0', async () => {
	const target = new BufferTarget();
	const output = new Output({ target, format: new Mp4OutputFormat() });

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(10), 'key', 0, 1024 / 48000), {
		decoderConfig: {
			codec: 'mp4a.40.2',
			numberOfChannels: 2,
			sampleRate: 48000,
			description: new Uint8Array([0x11, 0x90]),
		},
	});
	await output.finalize();

	const bytes = new Uint8Array(target.buffer!);
	const esdsPos = String.fromCharCode(...bytes).indexOf('esds');
	expect(esdsPos).toBeGreaterThan(0);

	// After the FullBox header comes the ES_Descriptor: tag 3, an expandable length, then ES_ID (CMAF 10.3.4.2.3
	// requires 0; ISO/IEC 14496-14 stores 0 in files)
	let pos = esdsPos + 8;
	expect(bytes[pos++]).toBe(0x03);
	while (bytes[pos]! & 0x80) {
		pos++;
	}
	pos++;
	expect((bytes[pos]! << 8) | bytes[pos + 1]!).toBe(0);
});

test('MOV reports that it takes no subtitle tracks', () => {
	const format = new MovOutputFormat();
	expect(format.getSupportedSubtitleCodecs()).toEqual([]);
	expect(format.getSupportedTrackCounts().subtitle).toEqual({ min: 0, max: 0 });
	expect(new Mp4OutputFormat().getSupportedTrackCounts().subtitle.max).toBeGreaterThan(0);

	const output = new Output({ format, target: new BufferTarget() });
	expect(() => output.addSubtitleTrack(new TextSubtitleSource('webvtt'))).toThrow(
		'MOV does not support subtitle tracks.',
	);
});

test('ftyp lists the brands that AV1 tracks and roll sample groups require', async () => {
	const getCompatibleBrands = async (fastStart: false | 'fragmented') => {
		const target = new BufferTarget();
		const output = new Output({ target, format: new Mp4OutputFormat({ fastStart }) });

		const videoSource = new EncodedVideoPacketSource('av1');
		output.addVideoTrack(videoSource);
		const audioSource = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(audioSource);
		await output.start();

		await videoSource.add(new EncodedPacket(new Uint8Array(10), 'key', 0, 1), {
			decoderConfig: { codec: 'av01.0.04M.08', codedWidth: 320, codedHeight: 240 },
		});
		for (let i = 0; i < 3; i++) {
			await audioSource.add(new EncodedPacket(new Uint8Array([0xfc, 0, 0]), 'key', i * 0.02, 0.02), {
				decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000 },
			});
		}
		await output.finalize();

		const view = toDataView(target.buffer!);
		const size = view.getUint32(0);
		const brands: string[] = [];
		for (let pos = 16; pos < size; pos += 4) {
			brands.push(String.fromCharCode(...new Uint8Array(target.buffer!, pos, 4)));
		}
		return brands;
	};

	// AV1-ISOBMFF: "It SHALL have the av01 brand among the compatible brands array of the FileTypeBox"
	// Opus-in-ISOBMFF: roll groups need a brand supporting them, such as 'iso2'
	const regular = await getCompatibleBrands(false);
	expect(regular).toContain('av01');
	expect(regular).toContain('iso2');

	const fragmented = await getCompatibleBrands('fragmented');
	expect(fragmented).toContain('av01');
	expect(fragmented).toContain('iso6'); // Includes sample group support
});

test('Sample durations that exceed 32 bits are rejected instead of wrapping around', async () => {
	const muxWithGap = async (fastStart: false | 'fragmented') => {
		const output = new Output({
			target: new BufferTarget(),
			format: new Mp4OutputFormat({ fastStart, minimumFragmentDuration: 1e9 }),
		});

		const source = new EncodedVideoPacketSource('vp8');
		output.addVideoTrack(source);
		await output.start();

		const decoderConfig = { codec: 'vp8', codedWidth: 320, codedHeight: 180 };
		await source.add(new EncodedPacket(new Uint8Array(1), 'key', 0, 1), { decoderConfig });
		await source.add(new EncodedPacket(new Uint8Array(1), 'key', 1, 1));
		// 30 hours later: more than 2^32 units of the track timescale, which used to wrap to ~9.3 hours
		await source.add(new EncodedPacket(new Uint8Array(1), 'key', 30 * 3600, 1));
		await output.finalize();
	};

	await expect(muxWithGap(false)).rejects.toThrow(/more than an MP4\/MOV sample duration can hold/);
	await expect(muxWithGap('fragmented')).rejects.toThrow(/more than an MP4\/MOV sample duration can hold/);
});

test('AV1 samples are stored without temporal delimiter and padding OBUs', async () => {
	const target = new BufferTarget();
	const output = new Output({ target, format: new Mp4OutputFormat() });
	const source = new EncodedVideoPacketSource('av1');
	output.addVideoTrack(source);
	await output.start();

	// Temporal unit as WebCodecs encoders emit it: OBU_TEMPORAL_DELIMITER, OBU_FRAME, OBU_PADDING
	const temporalDelimiter = [0x12, 0x00];
	const frame = [0x32, 0x03, 0xaa, 0xbb, 0xcc];
	const padding = [0x7a, 0x02, 0x00, 0x00];
	await source.add(new EncodedPacket(new Uint8Array([...temporalDelimiter, ...frame, ...padding]), 'key', 0, 1), {
		decoderConfig: { codec: 'av01.0.04M.08', codedWidth: 320, codedHeight: 240 },
	});
	await source.add(new EncodedPacket(new Uint8Array(frame), 'delta', 1, 1)); // Nothing to strip
	await output.finalize();

	using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	// AV1-ISOBMFF 2.4: these OBUs SHOULD NOT be stored; FFmpeg's movenc strips them too
	const packets: Uint8Array[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet.data);
	}
	expect(packets).toEqual([new Uint8Array(frame), new Uint8Array(frame)]);
});

test('Cover art gets the iTunes data type of its image format, whatever the MIME type spelling', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	output.setMetadataTags({
		images: [
			{ data: jpeg, mimeType: 'image/jpg', kind: 'coverFront' },
			{ data: png, mimeType: 'IMAGE/PNG', kind: 'coverFront' },
		],
	});

	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), {
		decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 },
	});
	await output.finalize();

	// FFmpeg skips covr data of an unknown type ("Unknown cover type: 0x0"), so the type must be JPEG (13) or PNG (14)
	const bytes = new Uint8Array(output.target.buffer!);
	const view = toDataView(bytes);
	const types: number[] = [];
	for (let i = 0; i + 16 <= bytes.length; i++) {
		if (String.fromCharCode(...bytes.subarray(i, i + 4)) === 'covr') {
			types.push(view.getUint32(i + 12)); // Skip 'covr', then the data box's size and name
		}
	}
	expect(types).toEqual([13, 14]);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const images = (await input.getMetadataTags()).images!;
	expect(images.map(image => image.mimeType)).toEqual(['image/jpeg', 'image/png']);
});

test('PCM tracks with more frames than the sample tables count are rejected instead of wrapping around', async () => {
	// Non-fragmented files store PCM as one sample per frame, and stts/stsz count samples in 32 bits. This is 2^32
	// frames of 8-bit mono (24.9 hours at 48 kHz); the packets are views into one buffer and the target drops them.
	const buffer = new Uint8Array(2 ** 26);
	const output = new Output({
		format: new MovOutputFormat({ fastStart: false }),
		target: new NullTarget(),
	});
	const source = new EncodedAudioPacketSource('pcm-u8');
	output.addAudioTrack(source);
	await output.start();

	const decoderConfig = { codec: 'pcm-u8', numberOfChannels: 1, sampleRate: 48000 };
	const mux = async () => {
		for (let i = 0; i < 64; i++) {
			const timestamp = i * buffer.length / 48000;
			await source.add(new EncodedPacket(buffer, 'key', timestamp, buffer.length / 48000), { decoderConfig });
		}
		await output.finalize();
	};

	await expect(mux()).rejects.toThrow(/more than 4294967295 PCM audio frames/);
});

test.each([false, 'in-memory', 'reserve'] as const)(
	'Long gaps between PCM packets are written as silence in pieces of at most 16 MiB (fastStart %s)',
	async (fastStart) => {
		const target = new BufferTarget();
		const writeSizes: number[] = [];
		target.on('write', ({ start, end }) => writeSizes.push(end - start));

		const output = new Output({ format: new MovOutputFormat({ fastStart }), target });
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source, { maximumPacketCount: 3 });
		await output.start();

		// One second of 48 kHz stereo, a 100-second gap (19.2 MB of silence), then another second
		const decoderConfig = { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 };
		await source.add(new EncodedPacket(new Uint8Array(192000).fill(0x11), 'key', 0, 1), { decoderConfig });
		await source.add(new EncodedPacket(new Uint8Array(192000).fill(0x22), 'key', 101, 1));
		await output.finalize();

		// The padding used to be written as one 19.2 MB sample
		expect(Math.max(...writeSizes)).toBe(2 ** 24);

		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.computeDuration()).toBe(102);

		// The audio around the gap is where it belongs
		const sink = new EncodedPacketSink(track);
		for (const [timestamp, value] of [[0.5, 0x11], [50, 0], [100.9, 0], [101.5, 0x22]]) {
			const packet = (await sink.getPacket(timestamp!))!;
			expect(packet.data.every(x => x === value)).toBe(true);
		}
	},
);

test.each([10, 200])(
	'Gaps of %i seconds between PCM packets are padded with one sample, within the reserved packet count',
	async (gap) => {
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'reserve' }),
			target: new BufferTarget(),
		});
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source, { maximumPacketCount: 4 });
		await output.start();

		// Three 10 ms packets with a gap after the first. At 48 kHz mono s16, 200 seconds of silence are 19.2 MB,
		// more than one 16 MiB piece.
		const decoderConfig = { codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 48000 };
		for (const timestamp of [0, gap + 0.01, gap + 0.02]) {
			await source.add(new EncodedPacket(new Uint8Array(960), 'key', timestamp, 0.01), { decoderConfig });
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.computeDuration()).toBeCloseTo(gap + 0.03, 9);
	},
);

test('CMAF segments too long for the sidx subsegment duration are rejected instead of wrapping around', async () => {
	// The sidx box counts the segment's duration in 32 bits of its 57600 Hz timescale, which ends after ~20.7 hours.
	// This is 21 hours of 1-second video frames.
	const output = new Output({
		format: new CmafOutputFormat(),
		target: new BufferTarget(),
		initTarget: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source);
	await output.start();

	const mux = async () => {
		const decoderConfig = { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 };
		for (let i = 0; i < 21 * 3600; i++) {
			await source.add(new EncodedPacket(new Uint8Array(1), i === 0 ? 'key' : 'delta', i, 1), { decoderConfig });
		}
		await output.finalize();
	};

	await expect(mux()).rejects.toThrow(/sidx/);
});

test('Finalizing a long MP4 writes its sample tables without building a nested array per sample', async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new NullTarget() });
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();

	// 2 hours of B-frames (decode order I P B) at a variable frame rate, so stsz, stts and ctts get an entry per sample
	const decoderConfig = {
		codec: 'avc1.42c01e',
		codedWidth: 32,
		codedHeight: 32,
		description: new Uint8Array([
			0x01, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x0a, 0x67, 0x42, 0xc0, 0x1e, 0xda, 0x02, 0x80, 0xbf, 0xe5, 0x84,
			0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80,
		]),
	};
	const frameCount = 216_000;
	const timestamp = (frame: number) => (frame * 33 + Math.floor(frame / 2)) / 1000;
	const data = new Uint8Array(10);
	for (let i = 0; i < frameCount; i += 3) {
		for (const frame of [i, i + 2, i + 1]) {
			const type = frame % 30 === 0 ? 'key' : 'delta';
			const duration = timestamp(frame + 1) - timestamp(frame);
			await videoSource.add(
				new EncodedPacket(data, type, timestamp(frame), duration),
				frame === 0 ? { decoderConfig } : undefined,
			);
		}
	}

	// box() takes nested number arrays and flattens them. Built that way, a table with an entry per sample costs about
	// 200 bytes of short-lived memory per sample (+620 MB to finalize a million samples)
	let largestFlattenedLength = 0;
	const flat = Array.prototype.flat;
	vi.spyOn(Array.prototype, 'flat').mockImplementation(function (this: unknown[], depth?: number) {
		const result = flat.call(this, depth);
		largestFlattenedLength = Math.max(largestFlattenedLength, result.length);
		return result;
	});
	await output.finalize();

	// On main, the stts and ctts payloads flattened to 1.7M numbers
	expect(largestFlattenedLength).toBeLessThan(100_000);
}, 60_000);
