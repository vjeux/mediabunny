import { describe, expect, test } from 'vitest';
import path from 'node:path';
import {
	ALL_FORMATS,
	asc,
	AudioSampleSink,
	BufferSource,
	BufferTarget,
	CanvasSink,
	desc,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	InputTrack,
	MkvOutputFormat,
	MovOutputFormat,
	Output,
	prefer,
	VideoSampleSink,
} from '../../src/index.js';
import { AudioCodec, PCM_AUDIO_CODECS, PcmAudioCodec } from '../../src/codec.js';
import { assert } from '../../src/misc.js';
import { AudioSample } from '../../src/sample.js';

// The frame-index-* and clicks-* fixtures are described in test/browser/media-sink-conformance.test.ts. All
// frame-index-x264-* files share one encode: 90 frames at 30 fps, key frames at frames 0, 29, 32, 48, 64 and 80 (scene
// cuts every 16 frames), three B-frames with pyramid.

const publicPath = (file: string) => path.join(__dirname, '..', 'public', file);

const openInput = (file: string) => new Input({
	source: new FilePathSource(publicPath(file)),
	formats: ALL_FORMATS,
});

const firstTrackOf = async (input: Input) => {
	const track = (await input.getTracks())[0];
	assert(track);
	return track;
};

type PacketInfo = { timestamp: number; duration: number; type: string; sequenceNumber: number };

const readPackets = async (track: InputTrack) => {
	const packets: PacketInfo[] = [];
	for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
		const { timestamp, duration, type, sequenceNumber } = packet;
		packets.push({ timestamp, duration, type, sequenceNumber });
	}

	return packets;
};

type VideoFixture = {
	file: string;
	frameTimestamp: (i: number) => number;
	keyFrames: number[];
	duration: number;
	codec: string;
};

const X264_KEY_FRAMES = [0, 29, 32, 48, 64, 80];
const VIDEO_FIXTURES: VideoFixture[] = [
	{
		file: 'frame-index-x264-bframes.mp4',
		frameTimestamp: i => i / 30,
		keyFrames: X264_KEY_FRAMES,
		duration: 3,
		codec: 'avc1.64000a',
	},
	{
		file: 'frame-index-x264-bframes.mkv',
		frameTimestamp: i => Math.round(i * 1000 / 30) / 1000,
		keyFrames: X264_KEY_FRAMES,
		duration: 3,
		codec: 'avc1.64000a',
	},
	{
		file: 'frame-index-x264-bframes.ts',
		frameTimestamp: i => (132000 + 3000 * i) / 90000,
		keyFrames: X264_KEY_FRAMES,
		duration: (132000 + 3000 * 90) / 90000,
		codec: 'avc1.64000a',
	},
	{
		file: 'frame-index-x264-vfr.mp4',
		frameTimestamp: i => (3000 * i + 540 * ((7 * i) % 5)) / 90000,
		keyFrames: X264_KEY_FRAMES,
		duration: 3,
		codec: 'avc1.640034',
	},
	{
		file: 'frame-index-vp9.webm',
		frameTimestamp: i => Math.round(i * 1000 / 30) / 1000,
		keyFrames: [0, 30, 60],
		duration: 3,
		codec: 'vp09.00.10.08.01.02.02.02.00',
	},
	{
		file: 'frame-index-av1.mp4',
		frameTimestamp: i => i / 30,
		keyFrames: [0, 16, 32, 48, 78],
		duration: 3,
		codec: 'av01.0.00M.08',
	},
];
const FRAME_COUNT = 90;

const lastAtOrBefore = <T>(items: T[], getTimestamp: (item: T) => number, timestamp: number) => {
	let result: T | null = null;
	for (const item of items) {
		if (getTimestamp(item) <= timestamp && (result === null || getTimestamp(item) >= getTimestamp(result))) {
			result = item;
		}
	}

	return result;
};

describe('EncodedPacketSink', () => {
	test.each(VIDEO_FIXTURES)('$file: packets come in decode order with the expected presentation timeline', async (
		fixture,
	) => {
		using input = openInput(fixture.file);
		const track = await firstTrackOf(input);

		const packets = await readPackets(track);
		expect(packets).toHaveLength(FRAME_COUNT);

		// Decode order: sequence numbers increase
		for (let i = 1; i < packets.length; i++) {
			expect(packets[i]!.sequenceNumber).toBeGreaterThan(packets[i - 1]!.sequenceNumber);
		}

		// Presentation order: one packet per frame timestamp
		const presentation = [...packets].sort((a, b) => a.timestamp - b.timestamp);
		presentation.forEach((packet, i) => {
			expect(packet.timestamp).toBeCloseTo(fixture.frameTimestamp(i), 6);
		});

		const keyFrames = presentation
			.map((packet, i) => packet.type === 'key' ? i : -1)
			.filter(i => i !== -1);
		expect(keyFrames).toEqual(fixture.keyFrames);
	});

	test.each(VIDEO_FIXTURES)('$file: getPacket(t) and getKeyPacket(t) return the last (key) packet up to t', async (
		fixture,
	) => {
		using input = openInput(fixture.file);
		const track = await firstTrackOf(input);

		const sink = new EncodedPacketSink(track);
		const at = fixture.frameTimestamp;
		const timestamps = [-Infinity, at(0) - 1, at(0) - 1e-6, Infinity, at(FRAME_COUNT - 1) + 10];
		for (let i = 0; i < FRAME_COUNT; i++) {
			timestamps.push(at(i), at(i) - 1e-6, at(i) + 0.01);
		}

		for (const timestamp of timestamps) {
			const frame = lastAtOrBefore([...Array(FRAME_COUNT).keys()], at, timestamp);
			const keyFrame = lastAtOrBefore(fixture.keyFrames, at, timestamp);

			const packet = await sink.getPacket(timestamp, { metadataOnly: true });
			const keyPacket = await sink.getKeyPacket(timestamp, { metadataOnly: true });
			const verifiedKeyPacket = await sink.getKeyPacket(timestamp, { verifyKeyPackets: true });

			expect(packet?.timestamp ?? null).toBe(frame === null ? null : packet!.timestamp);
			if (frame !== null) {
				expect(packet!.timestamp).toBeCloseTo(at(frame), 6);
			}

			for (const key of [keyPacket, verifiedKeyPacket]) {
				if (keyFrame === null) {
					expect(key).toBe(null);
				} else {
					assert(key);
					expect(key.type).toBe('key');
					expect(key.timestamp).toBeCloseTo(at(keyFrame), 6);
				}
			}
		}
	});

	test.each(VIDEO_FIXTURES)('$file: getNextPacket and getNextKeyPacket walk decode order', async (fixture) => {
		using input = openInput(fixture.file);
		const track = await firstTrackOf(input);

		const sink = new EncodedPacketSink(track);
		const packets = await readPackets(track);

		const walked: number[] = [];
		let packet = await sink.getFirstPacket({ metadataOnly: true });
		while (packet) {
			walked.push(packet.sequenceNumber);
			packet = await sink.getNextPacket(packet, { metadataOnly: true });
		}
		expect(walked).toEqual(packets.map(x => x.sequenceNumber));

		const keys: number[] = [];
		let keyPacket = await sink.getFirstKeyPacket({ verifyKeyPackets: true });
		while (keyPacket) {
			keys.push(keyPacket.sequenceNumber);
			keyPacket = await sink.getNextKeyPacket(keyPacket, { verifyKeyPackets: true });
		}
		expect(keys).toEqual(packets.filter(x => x.type === 'key').map(x => x.sequenceNumber));
	});

	test('packets(start, end) includes start and excludes end, in decode order', async () => {
		using input = openInput('frame-index-x264-bframes.mp4');
		const track = await firstTrackOf(input);

		const sink = new EncodedPacketSink(track);
		const packets = await readPackets(track);

		const start = await sink.getKeyPacket(1.1);
		const end = await sink.getKeyPacket(2, { metadataOnly: true });
		assert(start && end);

		const range: number[] = [];
		for await (const packet of sink.packets(start, end)) {
			expect(packet.isMetadataOnly).toBe(false);
			expect(packet.data.byteLength).toBe(packet.byteLength);
			range.push(packet.sequenceNumber);
		}

		const startIndex = packets.findIndex(x => x.sequenceNumber === start.sequenceNumber);
		const endIndex = packets.findIndex(x => x.sequenceNumber === end.sequenceNumber);
		expect(range).toEqual(packets.slice(startIndex, endIndex).map(x => x.sequenceNumber));

		// An end before the start yields nothing
		const empty: EncodedPacket[] = [];
		const fullEnd = await sink.getPacket(end.timestamp);
		for await (const packet of sink.packets(fullEnd!, start)) {
			empty.push(packet);
		}
		expect(empty).toHaveLength(0);

		// Metadata-only packets keep their size but carry no data
		const metadataOnlyStart = await sink.getKeyPacket(1.1, { metadataOnly: true });
		for await (const packet of sink.packets(metadataOnlyStart!, end, { metadataOnly: true })) {
			expect(packet.isMetadataOnly).toBe(true);
			expect(packet.data.byteLength).toBe(0);
			expect(packet.byteLength).toBeGreaterThan(0);
		}

		expect(() => sink.packets(end)).toThrow('metadata-only');
	});

	test('verifyKeyPackets sees through packets mislabeled as key', async () => {
		// A VP8 stream whose container labels every packet as key, while only every tenth frame actually is one (bit 0
		// of the VP8 frame tag is 0 for key frames)
		const output = new Output({
			format: new MkvOutputFormat(),
			target: new BufferTarget(),
		});
		const source = new EncodedVideoPacketSource('vp8');
		output.addVideoTrack(source);
		await output.start();

		for (let i = 0; i < 30; i++) {
			const frameTag = i % 10 === 0 ? 0x10 : 0x11;
			const data = new Uint8Array([frameTag, 0x02, 0x00, 0x9d, 0x01, 0x2a, 64, 0, 64, 0]);
			await source.add(new EncodedPacket(data, 'key', i / 30, 1 / 30), {
				decoderConfig: { codec: 'vp8', codedWidth: 64, codedHeight: 64 },
			});
		}
		await output.finalize();

		using input = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const sink = new EncodedPacketSink(track);

		// Without verification, the container's word is taken
		expect((await sink.getKeyPacket(0.5))!.timestamp).toBeCloseTo(0.5, 3);
		expect((await sink.getPacket(0.5))!.type).toBe('key');

		// With verification, only actual key frames count
		const frameAt = (packet: EncodedPacket | null) => packet && Math.round(packet.timestamp * 30);
		expect(frameAt(await sink.getKeyPacket(0.5, { verifyKeyPackets: true }))).toBe(10);
		expect(frameAt(await sink.getKeyPacket(0.3, { verifyKeyPackets: true }))).toBe(0);
		expect(frameAt(await sink.getKeyPacket(Infinity, { verifyKeyPackets: true }))).toBe(20);
		expect((await sink.getPacket(0.5, { verifyKeyPackets: true }))!.type).toBe('delta');
		expect((await sink.getPacket(0.68, { verifyKeyPackets: true }))!.type).toBe('key'); // Frame 20

		const chain: (number | null)[] = [];
		let keyPacket = await sink.getFirstKeyPacket({ verifyKeyPackets: true });
		while (keyPacket) {
			chain.push(frameAt(keyPacket));
			keyPacket = await sink.getNextKeyPacket(keyPacket, { verifyKeyPackets: true });
		}
		expect(chain).toEqual([0, 10, 20]);

		const verifiedTypes: string[] = [];
		for await (const packet of sink.packets(undefined, undefined, { verifyKeyPackets: true })) {
			verifiedTypes.push(packet.type);
		}
		expect(verifiedTypes.filter(x => x === 'key')).toHaveLength(3);
	});

	test('Packet retrieval options are validated', async () => {
		using input = openInput('frame-index-x264-bframes.mp4');
		const track = await firstTrackOf(input);

		const sink = new EncodedPacketSink(track);
		await expect(sink.getPacket(1, { metadataOnly: true, verifyKeyPackets: true })).rejects.toThrow(TypeError);
		await expect(sink.getPacket(Number.NaN)).rejects.toThrow(TypeError);
		await expect(sink.getPacket(1, null as never)).rejects.toThrow(TypeError);
		expect(() => new EncodedPacketSink({} as never)).toThrow(TypeError);
	});
});

describe('InputTrack', () => {
	test.each(VIDEO_FIXTURES)('$file: first timestamp, duration, codec string and packet stats', async (fixture) => {
		using input = openInput(fixture.file);
		const track = await firstTrackOf(input);

		assert(track.isVideoTrack());
		expect(await track.getFirstTimestamp()).toBeCloseTo(fixture.frameTimestamp(0), 6);
		expect(await track.computeDuration()).toBeCloseTo(fixture.duration, 3);
		expect(await track.getCodecParameterString()).toBe(fixture.codec);
		expect(await track.getCodedWidth()).toBe(64);
		expect(await track.getCodedHeight()).toBe(64);
		expect(await track.getDisplayWidth()).toBe(64);
		expect(await track.getRotation()).toBe(0);
		expect(await track.hasOnlyKeyPackets()).toBe(false);
		expect(await track.canDecode()).toBe(false); // No WebCodecs in Node

		const stats = await track.computePacketStats();
		expect(stats.packetCount).toBe(FRAME_COUNT);
		expect(stats.averagePacketRate).toBeCloseTo(FRAME_COUNT / (fixture.duration - fixture.frameTimestamp(0)), 2);

		// A prefix of the packets: stops once the target is reached and no earlier timestamp can follow
		const prefixStats = await track.computePacketStats(10);
		expect(prefixStats.packetCount).toBeGreaterThanOrEqual(10);
		expect(prefixStats.packetCount).toBeLessThan(20);
		expect(prefixStats.averagePacketRate).toBeCloseTo(30, 0);
	});

	test.each(VIDEO_FIXTURES.filter(x => x.file !== 'frame-index-x264-vfr.mp4'))(
		'$file: computeFrameRateMetrics finds 30 FPS',
		async (fixture) => {
			using input = openInput(fixture.file);
			const track = await firstTrackOf(input);

			assert(track.isVideoTrack());
			const metrics = await track.computeFrameRateMetrics({ targetPacketCount: Infinity });
			expect(metrics.underlyingFrameRate).toBe(30);
			expect(metrics.bestGuessFrameRate).toBe(30);
			expect(metrics.frameRateIsConstant).toBe(true);
			expect(metrics.probedPacketCount).toBe(FRAME_COUNT);
		},
	);

	test('computeFrameRateMetrics on jittered (VFR) timestamps', async () => {
		using input = openInput('frame-index-x264-vfr.mp4');
		const track = await firstTrackOf(input);

		assert(track.isVideoTrack());
		const metrics = await track.computeFrameRateMetrics({ targetPacketCount: Infinity });

		// Gaps of 4080 and 1380 ticks of 90 kHz
		expect(metrics.underlyingFrameRate).toBe(null);
		expect(metrics.frameRateIsConstant).toBe(false);
		expect(metrics.minFrameRate).toBeCloseTo(90000 / 4080, 6);
		expect(metrics.maxFrameRate).toBeCloseTo(90000 / 1380, 6);
		expect(metrics.averageFrameRate).toBeCloseTo(89 / ((3000 * 89 + 540 * 3) / 90000), 6);
	});

	test.each([
		// File, codec string, first timestamp (the priming before 0), duration, pre-roll
		['clicks-aac.m4a', 'mp4a.40.2', -1024 / 44100, 3, 1024 / 44100],
		['clicks-opus.ogg', 'opus', -312 / 48000, 3, 0.4],
		['clicks-mp3.mp3', 'mp3', -(576 + 529) / 44100, null, null],
		['clicks-flac.flac', 'flac', 0, 3, 0],
	] as const)('%s: audio track properties', async (file, codec, firstTimestamp, duration, preRoll) => {
		using input = openInput(file);
		const track = await firstTrackOf(input);

		assert(track.isAudioTrack());
		expect(await track.getCodecParameterString()).toBe(codec);
		expect(await track.getNumberOfChannels()).toBe(1);
		expect(await track.getFirstTimestamp()).toBeCloseTo(firstTimestamp, 9);
		if (duration !== null) {
			expect(await track.computeDuration()).toBeCloseTo(duration, 9);
		}
		if (preRoll !== null) {
			expect(await track.getPreRollDuration()).toBeCloseTo(preRoll, 9);
		}
		expect(await track.hasOnlyKeyPackets()).toBe(true);
	});

	test('Track queries: filter, sortBy, asc, desc and prefer', async () => {
		using input = await makeMultiTrackInput();
		const videoTracks = await input.getVideoTracks();
		expect(videoTracks.map(x => x.number)).toEqual([1, 2, 3]);

		const byName = async (tracks: InputTrack[]) => Promise.all(tracks.map(x => x.getName()));

		// Sync and async filters
		expect(await byName(await input.getVideoTracks({ filter: async t => (await t.getCodedWidth()) > 100 })))
			.toEqual(['B', 'C']);
		expect(await byName(await input.getTracks({ filter: t => t.isAudioTrack() }))).toEqual(['X', 'Y']);

		// asc/desc put nulls last, regardless of direction
		const ranks: Record<string, number | null> = { A: 2, B: null, C: 1 };
		const rankOf = async (track: InputTrack) => ranks[(await track.getName())!];
		expect(await byName(await input.getVideoTracks({ sortBy: async t => asc(await rankOf(t)) })))
			.toEqual(['C', 'A', 'B']);
		expect(await byName(await input.getVideoTracks({ sortBy: async t => desc(await rankOf(t)) })))
			.toEqual(['A', 'C', 'B']);

		// Criteria arrays are compared element by element; ties keep the file order
		expect(await byName(await input.getVideoTracks({
			sortBy: async t => [prefer((await t.getCodedWidth()) > 100), desc(await rankOf(t))],
		}))).toEqual(['C', 'B', 'A']);
		expect(await byName(await input.getVideoTracks({
			sortBy: async t => [prefer((await t.getCodedWidth()) > 100)],
		}))).toEqual(['B', 'C', 'A']);
		expect(await byName(await input.getVideoTracks({ sortBy: () => 0 }))).toEqual(['A', 'B', 'C']);

		await expect(input.getVideoTracks({ filter: () => 1 as never })).rejects.toThrow(TypeError);
		await expect(input.getVideoTracks({ sortBy: () => 'x' as never })).rejects.toThrow(TypeError);
		await expect(input.getVideoTracks({ filter: 'x' as never })).rejects.toThrow(TypeError);
	});

	test('Primary tracks prefer default dispositions, then bitrate', async () => {
		using input = await makeMultiTrackInput();

		// A is first and has the highest bitrate, but isn't marked as default
		const primaryVideo = await input.getPrimaryVideoTrack();
		expect(await primaryVideo!.getName()).toBe('C');

		const primaryAudio = await input.getPrimaryAudioTrack();
		expect(await primaryAudio!.getName()).toBe('Y');

		// A query is applied before the default criteria
		const queried = await input.getPrimaryVideoTrack({ sortBy: async t => (await t.getCodedWidth()) });
		expect(await queried!.getName()).toBe('A');

		const filtered = await input.getPrimaryAudioTrack({ filter: async t => (await t.getName()) === 'X' });
		expect(await filtered!.getName()).toBe('X');

		expect(await input.getPrimaryVideoTrack({ filter: () => false })).toBe(null);
	});
});

/** An MKV with three video tracks (A, B, C) and two audio tracks (X, Y), with varying dispositions and bitrates. */
const makeMultiTrackInput = async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const videoTracks = [
		{ name: 'A', width: 64, bitrate: 3e6, default: false },
		{ name: 'B', width: 128, bitrate: undefined, default: false },
		{ name: 'C', width: 128, bitrate: 1e6, default: true },
	];
	const audioTracks = [
		{ name: 'X', bitrate: 256e3, default: false },
		{ name: 'Y', bitrate: 64e3, default: true },
	];

	const videoSources = videoTracks.map((track) => {
		const source = new EncodedVideoPacketSource('vp8');
		output.addVideoTrack(source, {
			name: track.name,
			disposition: { default: track.default },
			...(track.bitrate !== undefined ? { bitrate: track.bitrate } : {}),
		});
		return source;
	});
	const audioSources = audioTracks.map((track) => {
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source, {
			name: track.name,
			disposition: { default: track.default },
			bitrate: track.bitrate,
		});
		return source;
	});

	await output.start();

	for (let i = 0; i < videoSources.length; i++) {
		const width = videoTracks[i]!.width;
		// A VP8 key frame header: frame tag, start code, dimensions
		const data = new Uint8Array([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, width, 0, 64, 0]);
		await videoSources[i]!.add(new EncodedPacket(data, 'key', 0, 1 / 30), {
			decoderConfig: { codec: 'vp8', codedWidth: width, codedHeight: 64 },
		});
	}
	for (const source of audioSources) {
		await source.add(new EncodedPacket(new Uint8Array(96), 'key', 0, 0.001), {
			decoderConfig: { codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 48000 },
		});
	}

	await output.finalize();

	return new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
};

describe('AudioSampleSink with PCM (decoded by Mediabunny itself, so also in Node)', () => {
	// 48 kHz mono s16 in Matroska, 20 ms (960-frame) packets. The samples of packet i hold the value 100 * i, and the
	// packets from 0.5 s on come after a 0.1 s gap.
	const SAMPLE_RATE = 48000;
	const PACKET_FRAMES = 960;
	const PACKET_COUNT = 50;
	const GAP = 0.1;
	const packetTimestamp = (i: number) => i * PACKET_FRAMES / SAMPLE_RATE + (i >= 25 ? GAP : 0);

	const makeInput = async () => {
		const output = new Output({
			format: new MkvOutputFormat(),
			target: new BufferTarget(),
		});
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source);
		await output.start();

		for (let i = 0; i < PACKET_COUNT; i++) {
			const data = new Int16Array(PACKET_FRAMES).fill(100 * i);

			const packet = new EncodedPacket(
				new Uint8Array(data.buffer),
				'key',
				packetTimestamp(i),
				PACKET_FRAMES / SAMPLE_RATE,
			);
			await source.add(packet, {
				decoderConfig: { codec: 'pcm-s16', numberOfChannels: 1, sampleRate: SAMPLE_RATE },
			});
		}
		await output.finalize();

		return new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});
	};

	/** The index of the packet an AudioSample was decoded from. */
	const packetIndexOf = (sample: AudioSample) => {
		const data = new Float32Array(sample.numberOfFrames);
		sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
		return Math.round(data[0]! * 32768 / 100);
	};

	const packetIndexAt = (timestamp: number) => {
		let result: number | null = null;
		for (let i = 0; i < PACKET_COUNT; i++) {
			if (packetTimestamp(i) <= timestamp) {
				result = i;
			}
		}
		return result;
	};

	test('samples() keeps the packet timing and data, including the gap', async () => {
		using input = await makeInput();
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		let i = 0;
		for await (using sample of new AudioSampleSink(track).samples()) {
			expect(sample.timestamp).toBeCloseTo(packetTimestamp(i), 9);
			expect(sample.numberOfFrames).toBe(PACKET_FRAMES);
			expect(packetIndexOf(sample)).toBe(i);
			i++;
		}
		expect(i).toBe(PACKET_COUNT);
	});

	test('getSample(t) and samplesAtTimestamps() return the sample covering t', async () => {
		using input = await makeInput();
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const sink = new AudioSampleSink(track);
		const timestamps = [-1, -1e-6, 0, 1e-6, 0.4999, 0.5, 0.55, 0.6, 0.6001, 1.0999, 2, Infinity];
		for (let i = 0; i < PACKET_COUNT; i += 7) {
			timestamps.push(packetTimestamp(i), packetTimestamp(i) + 0.01, packetTimestamp(i) - 1e-7);
		}

		for (const timestamp of timestamps) {
			using sample = await sink.getSample(timestamp);
			const expected = packetIndexAt(timestamp);
			if (expected === null) {
				expect(sample).toBe(null);
			} else {
				assert(sample);
				expect(sample.timestamp).toBeCloseTo(packetTimestamp(expected), 9);
				expect(packetIndexOf(sample)).toBe(expected);
			}
		}

		const sorted = timestamps.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
		for (const sequence of [sorted, [0.3, 0.3, 0.3001, 0.7, -5, 0.7]]) {
			const indices: (number | null)[] = [];
			for await (using sample of sink.samplesAtTimestamps(sequence)) {
				indices.push(sample && packetIndexOf(sample));
			}
			expect(indices).toEqual(sequence.map(packetIndexAt));
		}
	});

	test('samples(start, end) starts with the sample covering start and excludes end', async () => {
		using input = await makeInput();
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const sink = new AudioSampleSink(track);
		// The ends fall between packet starts: the PCM decoder sums up packet durations, which drifts off the exact
		// packet boundaries, so an exclusive end right at a packet start isn't reliable yet
		const ranges = [[0.1, 0.205], [0.11, 0.21], [0.45, 0.65], [0.5, 0.61], [-1, 0.05], [0.9, Infinity]];
		for (const [start, end] of ranges) {
			const indices: number[] = [];
			for await (using sample of sink.samples(start, end)) {
				indices.push(packetIndexOf(sample));
			}

			const expected: number[] = [];
			for (let i = packetIndexAt(start!) ?? 0; i < PACKET_COUNT && packetTimestamp(i) < end!; i++) {
				expected.push(i);
			}
			expect(indices, `[${start}, ${end})`).toEqual(expected);
		}
	});

	// Independent G.711 decoders (ITU-T G.711, as in the classic Sun reference implementation)
	const decodeUlaw = (byte: number) => {
		const u = ~byte & 0xff;
		const magnitude = ((((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4)) - 0x84;
		return (u & 0x80 ? -magnitude : magnitude) / 32768;
	};
	const decodeAlaw = (byte: number) => {
		const a = byte ^ 0x55;
		const segment = (a & 0x70) >> 4;
		let magnitude = (a & 0x0f) << 4;
		magnitude = segment === 0 ? magnitude + 8 : ((magnitude + 0x108) << (segment - 1));
		return (a & 0x80 ? magnitude : -magnitude) / 32768;
	};

	const S16_MAX = 1 - 2 ** -15;
	const G711_BYTES = [0x00, 0x7f, 0x80, 0xff, 0x12, 0xed, 0x55, 0xd5, 0x2a, 0xaa];

	type PcmCase = { codec: PcmAudioCodec; bytes: number[]; expected: number[] };
	const PCM_CASES: PcmCase[] = [
		{ codec: 'pcm-u8', bytes: [0, 64, 128, 192, 255], expected: [-1, -0.5, 0, 0.5, 127 / 128] },
		{ codec: 'pcm-s8', bytes: [0x80, 0xc0, 0x00, 0x40, 0x7f], expected: [-1, -0.5, 0, 0.5, 127 / 128] },
		{ codec: 'pcm-s16', bytes: [0x00, 0x80, 0x00, 0xc0, 0x00, 0x00, 0xff, 0x7f], expected: [-1, -0.5, 0, S16_MAX] },
		{
			codec: 'pcm-s16be',
			bytes: [0x80, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x7f, 0xff],
			expected: [-1, -0.5, 0, S16_MAX],
		},
		{ codec: 'pcm-s24', bytes: [0x00, 0x00, 0x80, 0x00, 0x00, 0x40], expected: [-1, 0.5] },
		{ codec: 'pcm-s24be', bytes: [0x80, 0x00, 0x00, 0x40, 0x00, 0x00], expected: [-1, 0.5] },
		{ codec: 'pcm-s32', bytes: [0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x40], expected: [-1, 0.5] },
		{ codec: 'pcm-s32be', bytes: [0x80, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00], expected: [-1, 0.5] },
		{
			codec: 'pcm-f32',
			bytes: [...new Uint8Array(new Float32Array([0.25, -0.75]).buffer)],
			expected: [0.25, -0.75],
		},
		{
			codec: 'pcm-f32be',
			bytes: [...new Uint8Array(new Float32Array([0.25, -0.75]).buffer)].reverse(),
			expected: [-0.75, 0.25],
		},
		{
			codec: 'pcm-f64',
			bytes: [...new Uint8Array(new Float64Array([0.25, -0.75]).buffer)],
			expected: [0.25, -0.75],
		},
		{
			codec: 'pcm-f64be',
			bytes: [...new Uint8Array(new Float64Array([0.25, -0.75]).buffer)].reverse(),
			expected: [-0.75, 0.25],
		},
		{ codec: 'ulaw', bytes: G711_BYTES, expected: G711_BYTES.map(decodeUlaw) },
		{ codec: 'alaw', bytes: G711_BYTES, expected: G711_BYTES.map(decodeAlaw) },
	];

	test.each(PCM_CASES)('decodes $codec to the expected sample values', async ({ codec, bytes, expected }) => {
		expect(PCM_AUDIO_CODECS as readonly AudioCodec[]).toContain(codec);

		const output = new Output({
			format: new MovOutputFormat(),
			target: new BufferTarget(),
		});
		const source = new EncodedAudioPacketSource(codec);
		output.addAudioTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(bytes), 'key', 0, expected.length / 8000), {
			decoderConfig: { codec, numberOfChannels: 1, sampleRate: 8000 },
		});
		await output.finalize();

		using input = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		expect(await track.canDecode()).toBe(true);

		const values: number[] = [];
		for await (using sample of new AudioSampleSink(track).samples()) {
			const data = new Float32Array(sample.numberOfFrames);
			sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
			values.push(...data);
		}

		expect(values).toHaveLength(expected.length);
		values.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 6));
	});
});

describe('Argument validation', () => {
	test('Sinks reject invalid tracks and options', async () => {
		using input = openInput('frame-index-x264-bframes.mp4');
		const track = await input.getPrimaryVideoTrack();
		assert(track);

		expect(() => new VideoSampleSink({} as never)).toThrow(TypeError);
		expect(() => new AudioSampleSink(track as never)).toThrow(TypeError);
		expect(() => new VideoSampleSink(track, { hardwareAcceleration: 'yes' as never })).toThrow(TypeError);
		expect(() => new VideoSampleSink(track, { optimizeForLatency: 1 as never })).toThrow(TypeError);

		expect(() => new CanvasSink(track, { width: 0 })).toThrow(TypeError);
		expect(() => new CanvasSink(track, { height: 1.5 })).toThrow(TypeError);
		expect(() => new CanvasSink(track, { width: 10, height: 10 })).toThrow('fit');
		expect(() => new CanvasSink(track, { width: 10, height: 10, fit: 'stretch' as never })).toThrow(TypeError);
		expect(() => new CanvasSink(track, { rotation: 45 as never })).toThrow(TypeError);
		expect(() => new CanvasSink(track, { poolSize: -1 })).toThrow(TypeError);
		expect(() => new CanvasSink(track, { crop: { left: 0, top: 0, width: -1, height: 1 } })).toThrow(TypeError);
		expect(() => new CanvasSink(track, { alpha: 'yes' as never })).toThrow(TypeError);

		const sink = new VideoSampleSink(track);
		await expect(sink.getSample(Number.NaN)).rejects.toThrow(TypeError);
		expect(() => sink.samples(Number.NaN)).toThrow(TypeError);
		expect(() => sink.samplesAtTimestamps(5 as never)).toThrow(TypeError);

		await expect(track.computeFrameRateMetrics({ targetPacketCount: -1 })).rejects.toThrow(TypeError);
		await expect(track.determinePacketType({} as never)).rejects.toThrow(TypeError);
		const metadataOnlyPacket = await new EncodedPacketSink(track).getFirstPacket({ metadataOnly: true });
		await expect(track.determinePacketType(metadataOnlyPacket!)).rejects.toThrow('metadata-only');
	});
});

describe('Track pairing', () => {
	test('Tracks of one file pair with each other, but not with themselves or other files', async () => {
		using input = await makeMultiTrackInput();
		using otherInput = openInput('clicks-aac.m4a');

		const [a, b] = await input.getVideoTracks();
		const [x] = await input.getAudioTracks();
		const otherTrack = await otherInput.getPrimaryAudioTrack();
		assert(a && b && x && otherTrack);

		expect(a.canBePairedWith(a)).toBe(false);
		expect(a.canBePairedWith(b)).toBe(true);
		expect(a.canBePairedWith(x)).toBe(true);
		expect(x.canBePairedWith(otherTrack)).toBe(false);
		expect(() => a.canBePairedWith({} as never)).toThrow(TypeError);

		expect((await a.getPairableTracks()).map(t => t.number)).toEqual([2, 3, 1, 2]);
		expect(await a.getPairableVideoTracks()).toHaveLength(2);
		expect(await a.getPairableAudioTracks()).toHaveLength(2);
		expect(await a.hasPairableAudioTrack()).toBe(true);
		expect(await a.hasPairableVideoTrack(async t => (await t.getName()) === 'C')).toBe(true);
		expect(await a.hasPairableVideoTrack(async t => (await t.getName()) === 'A')).toBe(false);
		expect(await (await a.getPrimaryPairableAudioTrack())!.getName()).toBe('Y');
		expect(await (await x.getPrimaryPairableVideoTrack())!.getName()).toBe('C');

		await expect(a.hasPairableTrack('x' as never)).rejects.toThrow(TypeError);
		await expect(a.hasPairableTrack(() => 1 as never)).rejects.toThrow(TypeError);
	});

	test('Deprecated synchronous getters agree with the async ones', async () => {
		for (const file of ['frame-index-x264-bframes.mp4', 'frame-index-vp9.webm', 'quadrants-ccw90-hflip.mp4']) {
			using input = openInput(file);
			const track = await input.getPrimaryVideoTrack();
			assert(track);

			/* eslint-disable @typescript-eslint/no-deprecated */
			expect(track.codec).toBe(await track.getCodec());
			expect(track.codedWidth).toBe(await track.getCodedWidth());
			expect(track.codedHeight).toBe(await track.getCodedHeight());
			expect(track.displayWidth).toBe(await track.getDisplayWidth());
			expect(track.displayHeight).toBe(await track.getDisplayHeight());
			expect(track.rotation).toBe(await track.getRotation());
			expect(track.squarePixelWidth).toBe(await track.getSquarePixelWidth());
			expect(track.pixelAspectRatio).toEqual(await track.getPixelAspectRatio());
			expect(track.timeResolution).toBe(await track.getTimeResolution());
			expect(track.languageCode).toBe(await track.getLanguageCode());
			expect(track.name).toBe(await track.getName());
			expect(track.disposition).toEqual(await track.getDisposition());
			/* eslint-enable @typescript-eslint/no-deprecated */
		}
	});
});
