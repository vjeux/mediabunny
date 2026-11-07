import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Output } from '../../src/output.js';
import {
	AdtsOutputFormat,
	CmafOutputFormat,
	FlacOutputFormat,
	HlsOutputFormat,
	MkvOutputFormat,
	MovOutputFormat,
	Mp3OutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	OggOutputFormat,
	OutputFormat,
	WavOutputFormat,
	WebMOutputFormat,
} from '../../src/output-format.js';
import { BufferTarget, PathedTarget, StreamTarget, StreamTargetChunk } from '../../src/target.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket, PacketType } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { BufferSource, CustomPathedSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { InputTrack } from '../../src/input-track.js';
import { AudioCodec, VideoCodec } from '../../src/codec.js';
import { assert } from '../../src/misc.js';
import { Conversion } from '../../src/conversion.js';

// Property-based round trips: seeded streams of real packets with unusual timing go through every output format
// that accepts them and are read back. Each seed is a fixed scenario, so failures are reproducible.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Material = {
	type: 'video' | 'audio';
	codec: VideoCodec | AudioCodec;
	decoderConfig: VideoDecoderConfig | AudioDecoderConfig;
	packets: EncodedPacket[];
};

const MATERIAL_SOURCES = [
	{ codec: 'avc', file: 'demo.mp4', type: 'video', count: 60 },
	{ codec: 'hevc', file: 'video-h265.mp4', type: 'video', count: 40 },
	{ codec: 'vp9', file: 'frames.webm', type: 'video', count: 40 },
	{ codec: 'aac', file: 'demo.mp4', type: 'audio', count: 80 },
	{ codec: 'opus', file: 'demo.webm', type: 'audio', count: 80 },
	{ codec: 'vorbis', file: 'vorbis-eos.ogg', type: 'audio', count: 60 },
	{ codec: 'flac', file: 'sample.flac', type: 'audio', count: 8 },
	{ codec: 'mp3', file: 'Toothsome-Meme.VBRv2.mp3', type: 'audio', count: 60 },
	{ codec: 'ac3', file: 'ac3.mp4', type: 'audio', count: 30 },
	{ codec: 'pcm-s16', file: 'glitch-hop-is-dead.wav', type: 'audio', count: 8 },
] as const;

let materialsPromise: Promise<Material[]> | null = null;

const loadMaterials = () => materialsPromise ??= Promise.all(MATERIAL_SOURCES.map(async (source) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public', source.file)),
		formats: ALL_FORMATS,
	});
	const track = source.type === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
		if (packets.length === source.count) {
			break;
		}
	}

	return { type: source.type, codec: source.codec, decoderConfig, packets } satisfies Material;
}));

const mulberry32 = (seed: number) => {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

type PlannedPacket = {
	index: number;
	timestamp: number;
	duration: number;
	type: PacketType;
};

type TrackPlan = {
	material: Material;
	packets: PlannedPacket[];
	languageCode: string;
};

type Scenario = {
	seed: number;
	tracks: TrackPlan[];
	negative: boolean;
	gaps: boolean;
};

const FRAME_RATES = [24, 25, 30, 60, 24000 / 1001, 30000 / 1001, 12.5];
const START_TIMES = [0, 0.5, 1.25, 1000.123, 2 * 86400 + 0.1, -0.5, -0.0213];

const planVideo = (random: () => number, material: Material, start: number, gaps: boolean): PlannedPacket[] => {
	const count = Math.min(material.packets.length, 15 + Math.floor(random() * 45));
	const source = material.packets.slice(0, count);
	const frameDuration = 1 / FRAME_RATES[Math.floor(random() * FRAME_RATES.length)]!;
	const variable = random() < 0.4;
	const gapRank = gaps ? Math.floor(count / 2) : Infinity;

	// Presentation times by rank, so the material's own frame reordering (B-frames) carries over
	const times: number[] = [];
	let time = 0;
	for (let rank = 0; rank < count; rank++) {
		if (rank === gapRank) {
			time += 0.5;
		}
		times.push(start + time);
		time += variable ? frameDuration * (0.6 + 0.8 * random()) : frameDuration;
	}
	times.push(start + time);

	const ranks = source
		.map((packet, index) => ({ index, timestamp: packet.timestamp }))
		.sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
	const rankOf = new Map(ranks.map((entry, rank) => [entry.index, rank]));

	return source.map((packet, index) => {
		const rank = rankOf.get(index)!;
		return {
			index,
			timestamp: times[rank]!,
			duration: Math.min(times[rank + 1]! - times[rank]!, frameDuration * 1.5),
			type: packet.type,
		};
	});
};

const planAudio = (random: () => number, material: Material, start: number, gaps: boolean): PlannedPacket[] => {
	const count = Math.min(material.packets.length, 4 + Math.floor(random() * material.packets.length));
	// Containers fill PCM gaps with silence each in their own way, so PCM stays contiguous
	const gapIndex = gaps && !material.codec.startsWith('pcm-') ? Math.floor(count / 2) : Infinity;
	let time = start;

	return material.packets.slice(0, count).map((packet, index) => {
		if (index === gapIndex) {
			time += 0.25;
		}
		const planned = { index, timestamp: time, duration: packet.duration, type: 'key' as const };
		time += packet.duration;
		return planned;
	});
};

const generateScenario = (seed: number, materials: Material[]): Scenario => {
	const random = mulberry32(seed);
	const pick = <T>(array: readonly T[]) => array[Math.floor(random() * array.length)]!;
	const videoMaterials = materials.filter(material => material.type === 'video');
	const audioMaterials = materials.filter(material => material.type === 'audio');

	const layout = pick(['v', 'a', 'va', 'va', 'vaa', 'vv']);
	const start = pick(START_TIMES);
	const gaps = random() < 0.25;
	const tracks: TrackPlan[] = [];

	for (const [i, kind] of [...layout].entries()) {
		// Tracks start at slightly different times
		const trackStart = start + pick([0, 0, 0.033, 0.25]);
		// The first track of each type cycles through the materials so that every codec gets covered
		const pool = kind === 'v' ? videoMaterials : audioMaterials;
		const material = layout.indexOf(kind) === i ? pool[seed % pool.length]! : pick(pool);
		tracks.push({
			material,
			packets: kind === 'v'
				? planVideo(random, material, trackStart, gaps)
				: planAudio(random, material, trackStart, gaps),
			languageCode: pick(['und', 'eng', 'fra', 'jpn']),
		});
	}

	return {
		seed,
		tracks,
		negative: tracks.some(track => track.packets.some(packet => packet.timestamp < 0)),
		gaps,
	};
};

type FormatCase = {
	name: string;
	create: () => OutputFormat;
	// 'absolute': timestamps survive as is. 'shifted': all tracks may move by one common offset. 'sequential': the
	// container only knows packet order, so packets follow each other back to back from the first one.
	timing: 'absolute' | 'shifted' | 'sequential';
	// Largest allowed timestamp error for a track
	precision: (track: InputTrack) => Promise<number>;
	negativeTimestamps: boolean;
	gaps: boolean;
	hls: boolean;
};

const ticks = (count: number) => async (track: InputTrack) => count / await track.getTimeResolution() + 1e-9;
const seconds = (value: number) => async () => value;

const FORMATS: FormatCase[] = [
	{
		name: 'MP4',
		create: () => new Mp4OutputFormat({ fastStart: false }),
		timing: 'absolute',
		// Decode times and composition offsets are rounded separately
		precision: ticks(2),
		negativeTimestamps: true,
		gaps: true,
		hls: false,
	},
	{
		name: 'MP4 (fast start)',
		create: () => new Mp4OutputFormat({ fastStart: 'in-memory' }),
		timing: 'absolute',
		precision: ticks(2),
		negativeTimestamps: true,
		gaps: true,
		hls: false,
	},
	{
		name: 'MP4 (fragmented)',
		create: () => new Mp4OutputFormat({ fastStart: 'fragmented' }),
		timing: 'absolute',
		precision: ticks(2),
		negativeTimestamps: false,
		gaps: true,
		hls: false,
	},
	{
		name: 'MOV',
		create: () => new MovOutputFormat({ fastStart: false }),
		timing: 'absolute',
		precision: ticks(2),
		negativeTimestamps: true,
		gaps: true,
		hls: false,
	},
	{
		name: 'CMAF',
		create: () => new CmafOutputFormat(),
		timing: 'absolute',
		precision: ticks(2),
		negativeTimestamps: false,
		gaps: true,
		hls: false,
	},
	{
		name: 'MKV',
		create: () => new MkvOutputFormat(),
		timing: 'absolute',
		// Millisecond ticks, plus the rounding of a negative audio start into CodecDelay
		precision: seconds(0.001 + 1e-9),
		negativeTimestamps: true,
		gaps: true,
		hls: false,
	},
	{
		name: 'WebM',
		create: () => new WebMOutputFormat(),
		timing: 'absolute',
		precision: seconds(0.001 + 1e-9),
		negativeTimestamps: true,
		gaps: true,
		hls: false,
	},
	{
		name: 'MPEG-TS',
		create: () => new MpegTsOutputFormat(),
		timing: 'absolute',
		precision: seconds(1 / 90000 + 1e-9),
		negativeTimestamps: false,
		gaps: true,
		hls: false,
	},
	{
		name: 'Ogg',
		create: () => new OggOutputFormat(),
		timing: 'sequential',
		precision: ticks(1),
		negativeTimestamps: false,
		gaps: false,
		hls: false,
	},
	{
		name: 'MP3',
		create: () => new Mp3OutputFormat(),
		timing: 'sequential',
		precision: seconds(1e-6),
		negativeTimestamps: true,
		gaps: false,
		hls: false,
	},
	{
		name: 'ADTS',
		create: () => new AdtsOutputFormat(),
		timing: 'sequential',
		precision: seconds(1e-6),
		negativeTimestamps: true,
		gaps: false,
		hls: false,
	},
	{
		name: 'FLAC',
		create: () => new FlacOutputFormat(),
		timing: 'sequential',
		precision: seconds(1e-6),
		negativeTimestamps: true,
		gaps: false,
		hls: false,
	},
	{
		name: 'WAVE',
		create: () => new WavOutputFormat(),
		timing: 'sequential',
		precision: seconds(1e-6),
		negativeTimestamps: true,
		gaps: false,
		hls: false,
	},
	{
		name: 'HLS (MPEG-TS segments)',
		create: () => new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat() }),
		timing: 'shifted',
		precision: seconds(1e-4),
		negativeTimestamps: true,
		gaps: true,
		hls: true,
	},
	{
		name: 'HLS (CMAF segments)',
		create: () => new HlsOutputFormat({ segmentFormat: new CmafOutputFormat() }),
		timing: 'shifted',
		precision: seconds(1e-4),
		negativeTimestamps: true,
		gaps: true,
		hls: true,
	},
];

// The tracks of a scenario that the format can hold, or null if it can't represent the scenario's timing
const tracksFor = (format: FormatCase, scenario: Scenario) => {
	if ((scenario.negative && !format.negativeTimestamps) || (scenario.gaps && !format.gaps)) {
		return null;
	}

	const outputFormat = format.create();
	const codecs: string[] = outputFormat.getSupportedCodecs();
	const counts = outputFormat.getSupportedTrackCounts();
	const tracks: TrackPlan[] = [];
	for (const track of scenario.tracks) {
		const sameType = tracks.filter(other => other.material.type === track.material.type).length;
		const typeMax = track.material.type === 'video' ? counts.video.max : counts.audio.max;
		if (codecs.includes(track.material.codec) && sameType < typeMax && tracks.length < counts.total.max) {
			tracks.push(track);
		}
	}

	return tracks.length >= Math.max(counts.total.min, 1) ? tracks : null;
};

type Muxed = {
	bytes: Uint8Array | null;
	files: Map<string, Uint8Array> | null;
};

const muxTracks = async (
	format: FormatCase,
	tracks: { plan: TrackPlan; packets: EncodedPacket[] }[],
	stream: boolean,
) => {
	const files = new Map<string, BufferTarget>();
	const chunks: StreamTargetChunk[] = [];
	const bufferTarget = new BufferTarget();
	const target = format.hls
		? new PathedTarget('master.m3u8', ({ path }) => {
			const fileTarget = new BufferTarget();
			files.set(path, fileTarget);
			return fileTarget;
		})
		: stream
			? new StreamTarget(new WritableStream({ write: (chunk) => {
				chunks.push({ ...chunk, data: chunk.data.slice() });
			} }))
			: bufferTarget;

	const initTarget = new BufferTarget();
	const output = new Output({ format: format.create(), target, initTarget });
	const sources = tracks.map(({ plan }) => {
		if (plan.material.type === 'video') {
			const source = new EncodedVideoPacketSource(plan.material.codec as VideoCodec);
			output.addVideoTrack(source, { languageCode: plan.languageCode });
			return source;
		} else {
			const source = new EncodedAudioPacketSource(plan.material.codec as AudioCodec);
			output.addAudioTrack(source, { languageCode: plan.languageCode });
			return source;
		}
	});
	// A fixed creation time keeps the bytes comparable
	output.setMetadataTags({ creationTime: new Date('2020-01-01T00:00:00Z') });
	await output.start();

	// Interleave the tracks by timestamp, like a live producer would
	const positions = tracks.map(() => 0);
	while (true) {
		let next = -1;
		for (let i = 0; i < tracks.length; i++) {
			const packet = tracks[i]!.packets[positions[i]!];
			if (packet && (next === -1 || packet.timestamp < tracks[next]!.packets[positions[next]!]!.timestamp)) {
				next = i;
			}
		}
		if (next === -1) {
			break;
		}

		const packet = tracks[next]!.packets[positions[next]!]!;
		const config = positions[next] === 0 ? tracks[next]!.plan.material.decoderConfig : null;
		const source = sources[next]!;
		if (source instanceof EncodedVideoPacketSource) {
			await source.add(packet, config ? { decoderConfig: config as VideoDecoderConfig } : undefined);
		} else {
			await source.add(packet, config ? { decoderConfig: config as AudioDecoderConfig } : undefined);
		}
		positions[next]!++;
	}

	await output.finalize();

	if (format.hls) {
		return { bytes: null, files: new Map([...files].map(([key, value]) => [key, new Uint8Array(value.buffer!)])) };
	}
	let bytes = new Uint8Array(bufferTarget.buffer ?? new ArrayBuffer(0));
	if (stream) {
		bytes = new Uint8Array(Math.max(...chunks.map(chunk => chunk.position + chunk.data.byteLength)));
		for (const chunk of chunks) {
			bytes.set(chunk.data, chunk.position);
		}
	}

	// CMAF writes the init segment separately; prepend it to read the result as a single file
	const init = new Uint8Array(initTarget.buffer ?? new ArrayBuffer(0));
	const joined = new Uint8Array(init.length + bytes.length);
	joined.set(init, 0);
	joined.set(bytes, init.length);
	return { bytes: joined, files: null };
};

const openMuxed = (muxed: Muxed) => new Input({
	source: muxed.files
		? new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(muxed.files!.get(path)!))
		: new BufferSource(muxed.bytes!),
	formats: ALL_FORMATS,
});

const readPackets = async (track: InputTrack) => {
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	return packets;
};

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);

// Splits AVC/HEVC packet data into NAL units, accepting 4-byte length prefixes or Annex B start codes
const splitNalUnits = (data: Uint8Array) => {
	const units: Uint8Array[] = [];
	let pos = 0;
	while (pos + 4 <= data.length) {
		const size = ((data[pos]! << 24) | (data[pos + 1]! << 16) | (data[pos + 2]! << 8) | data[pos + 3]!) >>> 0;
		if (size === 0 || pos + 4 + size > data.length) {
			break;
		}
		units.push(data.subarray(pos + 4, pos + 4 + size));
		pos += 4 + size;
	}
	if (pos === data.length) {
		return units;
	}

	units.length = 0;
	const starts: number[] = [];
	for (let i = 0; i + 2 < data.length; i++) {
		if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
			starts.push(i + 3);
		}
	}
	for (const [i, start] of starts.entries()) {
		let end = i + 1 < starts.length ? starts[i + 1]! - 3 : data.length;
		while (end > start && data[end - 1] === 0) {
			end--;
		}
		units.push(data.subarray(start, end));
	}
	return units;
};

// MPEG-TS carries AVC/HEVC as Annex B with in-band parameter sets and access unit delimiters, so packets are equal
// when their other NAL units are
const sameData = (codec: string, a: Uint8Array, b: Uint8Array) => {
	if (codec === 'aac') {
		// MPEG-TS hands AAC back as ADTS frames (without a description)
		const stripAdts = (data: Uint8Array) => data[0] === 0xff && (data[1]! & 0xf6) === 0xf0
			? data.subarray(data[1]! & 0x01 ? 7 : 9)
			: data;
		return bytesEqual(stripAdts(a), stripAdts(b));
	}
	if (codec !== 'avc' && codec !== 'hevc') {
		return bytesEqual(a, b);
	}

	const framingOnly = (unit: Uint8Array) => {
		const type = codec === 'avc' ? unit[0]! & 0x1f : (unit[0]! >> 1) & 0x3f;
		return codec === 'avc' ? [7, 8, 9].includes(type) : [32, 33, 34, 35].includes(type);
	};
	const unitsA = splitNalUnits(a).filter(unit => unit.length > 0 && !framingOnly(unit));
	const unitsB = splitNalUnits(b).filter(unit => unit.length > 0 && !framingOnly(unit));
	return unitsA.length === unitsB.length && unitsA.every((unit, i) => bytesEqual(unit, unitsB[i]!));
};

const checkTimestamps = async (
	format: FormatCase,
	track: InputTrack,
	expected: EncodedPacket[],
	actual: EncodedPacket[],
	offset: number,
) => {
	const precision = await format.precision(track);
	if (format.timing === 'sequential') {
		// Packets follow each other back to back, lasting as long as the codec says
		let worst = 0;
		let time = actual[0]!.timestamp;
		for (const packet of actual) {
			worst = Math.max(worst, Math.abs(packet.timestamp - time));
			time += packet.duration;
		}
		return { worst, precision };
	}

	// MPEG-TS timestamps are 33 bits of 90 kHz ticks, so they wrap around after about 26.5 hours
	const period = format.name === 'MPEG-TS' ? 2 ** 33 / 90000 : Infinity;
	const worst = Math.max(...actual.map((packet, i) => {
		const error = packet.timestamp - (expected[i]!.timestamp + offset);
		return Math.abs(period === Infinity ? error : error - Math.round(error / period) * period);
	}));
	return { worst, precision };
};

const checkLookups = async (
	track: InputTrack,
	actual: EncodedPacket[],
	random: () => number,
	checkDuration: boolean,
) => {
	const sink = new EncodedPacketSink(track);
	const sorted = [...actual].sort((a, b) => a.timestamp - b.timestamp);
	const first = sorted[0]!.timestamp;
	const last = sorted[sorted.length - 1]!.timestamp;
	const problems: string[] = [];

	for (let i = 0; i < 6; i++) {
		const time = first - 0.05 + random() * (last - first + 0.1);
		const atOrBefore = sorted.filter(packet => packet.timestamp <= time);
		const expected = atOrBefore[atOrBefore.length - 1] ?? null;
		const expectedKey = atOrBefore.filter(packet => packet.type === 'key').pop() ?? null;

		const packet = await sink.getPacket(time);
		if ((packet?.timestamp ?? null) !== (expected?.timestamp ?? null)) {
			problems.push(`getPacket(${time}) = ${packet?.timestamp}, expected ${expected?.timestamp}`);
		}
		const keyPacket = await sink.getKeyPacket(time);
		if ((keyPacket?.timestamp ?? null) !== (expectedKey?.timestamp ?? null)) {
			problems.push(`getKeyPacket(${time}) = ${keyPacket?.timestamp}, expected ${expectedKey?.timestamp}`);
		}
	}

	// Walking with getNextPacket visits the packets in decode order
	let current = await sink.getFirstPacket();
	for (let i = 0; i < actual.length; i++) {
		if (!current || current.timestamp !== actual[i]!.timestamp || current.byteLength !== actual[i]!.byteLength) {
			problems.push(`getNextPacket walk diverges at packet ${i}`);
			break;
		}
		current = await sink.getNextPacket(current);
	}
	if (current) {
		problems.push('getNextPacket walk returns extra packets');
	}

	// computeDuration() is the end of the last packet (in presentation order)
	const duration = await track.computeDuration();
	const lastPacket = sorted[sorted.length - 1]!;
	const end = lastPacket.timestamp + lastPacket.duration;
	if (checkDuration && Math.abs(duration - end) > 1e-9) {
		problems.push(`computeDuration() = ${duration}, last packet ends at ${end}`);
	}

	return problems;
};

const concatData = (packets: EncodedPacket[]) => {
	const joined = new Uint8Array(packets.reduce((sum, packet) => sum + packet.byteLength, 0));
	let position = 0;
	for (const packet of packets) {
		joined.set(packet.data, position);
		position += packet.byteLength;
	}
	return joined;
};

type FoundTrack = {
	track: InputTrack;
	packets: EncodedPacket[];
};

// Finds the read-back track holding the given packets. Tracks come back in the order they were added, except that
// MPEG-TS orders them by first packet, and tracks can share material, so among the candidates the one with the closest
// timing wins. PCM may be re-chunked, so it's matched by codec.
const findTrack = async (
	format: FormatCase,
	plan: TrackPlan,
	packets: EncodedPacket[],
	candidates: InputTrack[],
	offset: number | null,
) => {
	const pcm = plan.material.codec.startsWith('pcm-');
	let best: FoundTrack | null = null;
	let bestScore = Infinity;

	for (const candidate of candidates) {
		if (candidate.type !== plan.material.type) {
			continue;
		}

		const candidatePackets = await readPackets(candidate);
		const matches = pcm
			? await candidate.getCodec() === plan.material.codec
			: candidatePackets[0] && sameData(plan.material.codec, candidatePackets[0].data, packets[0]!.data);
		if (!matches) {
			continue;
		}

		let score = Math.abs(candidatePackets.length - packets.length) * 1e6;
		if (format.timing === 'absolute' || (format.timing === 'shifted' && offset !== null)) {
			score += Math.abs(candidatePackets[0]!.timestamp - packets[0]!.timestamp - (offset ?? 0));
		}
		for (let i = 0; i < Math.min(candidatePackets.length, packets.length); i++) {
			score += Math.abs(
				(candidatePackets[i]!.timestamp - candidatePackets[0]!.timestamp)
				- (packets[i]!.timestamp - packets[0]!.timestamp),
			);
		}

		if (score < bestScore) {
			bestScore = score;
			best = { track: candidate, packets: candidatePackets };
		}
	}

	if (best) {
		candidates.splice(candidates.indexOf(best.track), 1);
	}
	return best;
};

const checkTrack = async (
	format: FormatCase,
	plan: TrackPlan,
	expected: EncodedPacket[],
	found: FoundTrack,
	offset: number,
	context: string,
) => {
	const actual = found.packets;

	if (plan.material.codec.startsWith('pcm-')) {
		// Containers regroup PCM samples into their own chunks; the samples and the timeline must survive
		expect(bytesEqual(concatData(actual), concatData(expected)), `${context}: samples`).toBe(true);
		const precision = await format.precision(found.track);
		const expectedStart = format.timing === 'sequential' ? actual[0]!.timestamp : expected[0]!.timestamp + offset;
		expect(Math.abs(actual[0]!.timestamp - expectedStart), `${context}: start`).toBeLessThanOrEqual(precision);
		const expectedEnd = expectedStart + expected.reduce((sum, packet) => sum + packet.duration, 0);
		const actualEnd = actual[actual.length - 1]!.timestamp + actual[actual.length - 1]!.duration;
		expect(Math.abs(actualEnd - expectedEnd), `${context}: end`).toBeLessThanOrEqual(2 * precision);
		return;
	}

	expect(actual.length, `${context}: packet count`).toBe(expected.length);
	expect(
		actual.every((packet, i) => sameData(plan.material.codec, packet.data, expected[i]!.data)),
		`${context}: packet data`,
	).toBe(true);
	expect(actual.map(packet => packet.type), `${context}: key flags`).toEqual(expected.map(packet => packet.type));

	const { worst, precision } = await checkTimestamps(format, found.track, expected, actual, offset);
	expect(worst, `${context}: timestamp error`).toBeLessThanOrEqual(precision);

	if (format.timing === 'sequential') {
		// The codec's packet durations, which a source container may only have stored to the millisecond
		const worstDuration = Math.max(...actual.map((packet, i) => Math.abs(packet.duration - expected[i]!.duration)));
		expect(worstDuration, `${context}: duration error`).toBeLessThanOrEqual(0.0011);
	}
};

// Formats that store track languages
const LANGUAGE_FORMATS = ['MP4', 'MP4 (fast start)', 'MP4 (fragmented)', 'MOV', 'CMAF', 'MKV', 'WebM'];

// Muxes the scenario with the format and checks what comes back. Returns false if the format can't hold it.
const roundTrip = async (format: FormatCase, scenario: Scenario) => {
	const seed = scenario.seed;
	const plans = tracksFor(format, scenario);
	if (!plans) {
		return false;
	}

	const tracks = plans.map(plan => ({
		plan,
		packets: plan.packets.map(planned => new EncodedPacket(
			plan.material.packets[planned.index]!.data,
			planned.type,
			planned.timestamp,
			planned.duration,
		)),
	}));
	const context = `seed ${seed}`;

	const muxed = await muxTracks(format, tracks, false);
	// Ogg picks random stream serial numbers, so only the other formats are byte-for-byte reproducible
	if (!format.hls && format.name !== 'Ogg') {
		const streamed = await muxTracks(format, tracks, true);
		expect(bytesEqual(streamed.bytes!, muxed.bytes!), `${context}: StreamTarget output differs`).toBe(true);
	}

	using input = openMuxed(muxed);
	const remaining = await input.getTracks();
	expect(remaining.length, `${context}: track count`).toBe(tracks.length);

	let offset: number | null = null;
	const random = mulberry32(seed * 7919);
	const readBack: (FoundTrack & { plan: TrackPlan })[] = [];

	for (const [trackIndex, { plan, packets }] of tracks.entries()) {
		const trackContext = `${context}, track ${trackIndex} (${plan.material.codec})`;
		const found = await findTrack(format, plan, packets, remaining, offset);
		expect(found, `${trackContext}: not found`).not.toBeNull();
		assert(found);
		readBack.push({ ...found, plan });

		if (format.timing === 'shifted') {
			offset ??= found.packets[0]!.timestamp - packets[0]!.timestamp;
		}
		await checkTrack(format, plan, packets, found, offset ?? 0, trackContext);

		if (LANGUAGE_FORMATS.includes(format.name)) {
			expect(await found.track.getLanguageCode(), `${trackContext}: language`).toBe(plan.languageCode);
		}

		if (!format.hls && !plan.material.codec.startsWith('pcm-')) {
			// MPEG-TS has no packet durations; the final packets' durations are guessed, differently when seeking
			const checkDuration = format.name !== 'MPEG-TS';
			expect(
				await checkLookups(found.track, found.packets, random, checkDuration),
				`${trackContext}: lookups`,
			).toEqual([]);
		}
	}

	// Writing what was read back must give the same packets again, without drifting from repeated rounding
	if (!format.hls) {
		const again = await muxTracks(format, await Promise.all(readBack.map(async ({ plan, track, packets }) => {
			const decoderConfig = track.isVideoTrack() || track.isAudioTrack() ? await track.getDecoderConfig() : null;
			assert(decoderConfig);
			return { plan: { ...plan, material: { ...plan.material, decoderConfig } }, packets };
		})), false);

		using reread = openMuxed(again);
		const candidates = await reread.getTracks();
		for (const [trackIndex, { plan, packets }] of readBack.entries()) {
			const trackContext = `${context}, track ${trackIndex} (${plan.material.codec}), rewritten`;
			const found = await findTrack(format, plan, packets, candidates, 0);
			expect(found, `${trackContext}: not found`).not.toBeNull();
			assert(found);

			const exact: FormatCase = { ...format, timing: 'absolute', precision: ticks(1) };
			await checkTrack(exact, plan, packets, found, 0, trackContext);
		}
	}

	return true;
};

const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);

test.each(FORMATS)('Round trips through $name', async (format) => {
	const materials = await loadMaterials();
	let accepted = 0;
	for (const seed of SEEDS) {
		if (await roundTrip(format, generateScenario(seed, materials))) {
			accepted++;
		}
	}

	expect(accepted).toBeGreaterThan(0);
}, 60_000);

// Muxes the scenario with one format, then converts that to another format in copy mode and checks that the
// packets survive. Returns false if the formats picked for the seed can't hold the scenario.
const convert = async (scenario: Scenario) => {
	const seed = scenario.seed;
	const sources = FORMATS.filter(format => !format.hls);
	const targets = FORMATS.filter(format => !format.hls && format.timing === 'absolute');
	const random = mulberry32(seed);
	const source = sources[Math.floor(random() * sources.length)]!;
	const plans = tracksFor(source, scenario);
	if (!plans) {
		return false;
	}
	const rotation = Math.floor(random() * targets.length);
	const target = [...targets.slice(rotation), ...targets.slice(0, rotation)].find(candidate => candidate !== source
		&& tracksFor(candidate, { ...scenario, tracks: plans })?.length === plans.length);
	if (!target) {
		return false;
	}

	const context = `seed ${seed}, ${source.name} to ${target.name}`;

	const tracks = plans.map(plan => ({
		plan,
		packets: plan.packets.map(planned => new EncodedPacket(
			plan.material.packets[planned.index]!.data,
			planned.type,
			planned.timestamp,
			planned.duration,
		)),
	}));
	const muxed = await muxTracks(source, tracks, false);

	using input = openMuxed(muxed);
	const sourceTracks = await input.getTracks();
	const readBack = await Promise.all(sourceTracks.map(async track => ({
		track,
		packets: await readPackets(track),
	})));
	// Negative timestamps would be cut off, so the conversion starts at the earliest one
	const start = Math.min(0, ...readBack.map(({ packets }) => packets[0]!.timestamp));

	const outputTarget = new BufferTarget();
	const initTarget = new BufferTarget();
	const output = new Output({ format: target.create(), target: outputTarget, initTarget });
	const conversion = await Conversion.init({
		input,
		output,
		trim: { start },
		copy: { mode: 'forced' },
		showWarnings: false,
	});
	expect(conversion.discardedTracks, `${context}: discarded tracks`).toEqual([]);
	await conversion.execute();

	const init = new Uint8Array(initTarget.buffer ?? new ArrayBuffer(0));
	const body = new Uint8Array(outputTarget.buffer!);
	const joined = new Uint8Array(init.length + body.length);
	joined.set(init, 0);
	joined.set(body, init.length);

	using result = openMuxed({ bytes: joined, files: null });
	const candidates = await result.getTracks();
	expect(candidates.length, `${context}: track count`).toBe(readBack.length);

	for (const [trackIndex, { track, packets }] of readBack.entries()) {
		const codec = await track.getCodec();
		const plan = tracks.find(({ plan }) => plan.material.codec === codec && (
			codec.startsWith('pcm-')
			|| sameData(codec, plan.material.packets[plan.packets[0]!.index]!.data, packets[0]!.data)
		))!.plan;
		const expected = packets.map(packet => packet.clone({ timestamp: packet.timestamp - start }));
		const trackContext = `${context}, track ${trackIndex} (${plan.material.codec})`;

		const found = await findTrack(target, plan, expected, candidates, null);
		expect(found, `${trackContext}: not found`).not.toBeNull();
		assert(found);

		// The source container's rounding stays in what was read from it (e.g. PCM durations derived from millisecond
		// timestamps, while the target derives them from the sample count), so both precisions add up
		const sourcePrecision = await source.precision(track);
		const combined: FormatCase = {
			...target,
			precision: async (inputTrack: InputTrack) => sourcePrecision + await target.precision(inputTrack),
		};
		await checkTrack(combined, plan, expected, found, 0, trackContext);
	}

	return true;
};

test('Conversion copies packets between formats', async () => {
	const materials = await loadMaterials();
	let converted = 0;
	for (let seed = 1001; seed <= 1120; seed++) {
		if (await convert(generateScenario(seed, materials))) {
			converted++;
		}
	}

	expect(converted).toBeGreaterThan(10);
}, 60_000);
