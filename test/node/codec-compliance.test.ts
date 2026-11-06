import { beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	InputAudioTrack,
	MkvOutputFormat,
	Mp4OutputFormat,
	Output,
	TextSubtitleSource,
	WebMOutputFormat,
} from '../../src/index.js';
import { child, childrenNamed, find as findEbml, findAll as findAllEbml, parseEbml, readString, readUint }
	from './helpers/spec-matrix-ebml.js';

// Normative compliance of Mediabunny's codec bindings: Opus in ISOBMFF, FLAC in ISOBMFF, AV1-ISOBMFF, the VP codec
// ISOBMFF binding, RFC 6381 codec strings and the WebCodecs codec registrations. One test per checked statement; test
// names start with the specification and clause they check.

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// --- ISOBMFF parsing ---

type Box = { type: string; data: Uint8Array; children: Box[] };

/** Offsets of the children within container boxes, sample entries included */
const CHILD_OFFSETS: Record<string, number> = {
	moov: 8, trak: 8, mdia: 8, minf: 8, stbl: 8, mvex: 8, moof: 8, traf: 8, edts: 8, dinf: 8, stsd: 16,
	av01: 86, vp08: 86, vp09: 86, avc1: 86, Opus: 36, fLaC: 36, mp4a: 36, wvtt: 16,
};

const parseBoxes = (bytes: Uint8Array, start = 0): Box[] => {
	const boxes: Box[] = [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = start;
	while (pos + 8 <= bytes.length) {
		const size = view.getUint32(pos) || bytes.length - pos;
		const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
		const data = bytes.subarray(pos, pos + size);
		const offset = CHILD_OFFSETS[type];
		boxes.push({ type, data, children: offset === undefined ? [] : parseBoxes(data, offset) });
		pos += size;
	}
	return boxes;
};

const findAll = (boxes: Box[], type: string): Box[] => boxes.flatMap(box => [
	...(box.type === type ? [box] : []),
	...findAll(box.children, type),
]);
const find = (boxes: Box[], type: string) => findAll(boxes, type)[0];
const view = (box: Box) => new DataView(box.data.buffer, box.data.byteOffset, box.data.byteLength);

// --- Writing ---

const opusHead = (options: { preSkip?: number; inputSampleRate?: number; outputGain?: number; channels?: number;
	mapping?: number[]; } = {}) => {
	const channels = options.channels ?? 2;
	const bytes = new Uint8Array(19 + (options.mapping ? options.mapping.length : 0));
	const dataView = new DataView(bytes.buffer);
	bytes.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]); // 'OpusHead', version 1
	dataView.setUint16(10, options.preSkip ?? 312, true);
	dataView.setUint32(12, options.inputSampleRate ?? 48000, true);
	dataView.setInt16(16, options.outputGain ?? 0, true);
	bytes[18] = options.mapping ? 1 : 0;
	if (options.mapping) {
		bytes.set(options.mapping, 19);
	}
	return bytes;
};

/** 'fLaC' plus a STREAMINFO block */
const flacDescription = (sampleRate: number, channels: number, bitsPerSample: number) => {
	const bytes = new Uint8Array(4 + 4 + 34);
	bytes.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]);
	const dataView = new DataView(bytes.buffer);
	dataView.setUint16(8, 4096); // Minimum block size
	dataView.setUint16(10, 4096); // Maximum block size
	// Sample rate (20 bits), channels - 1 (3 bits), bits per sample - 1 (5 bits), total samples (36 bits)
	dataView.setUint32(18, (sampleRate << 12) | ((channels - 1) << 9) | ((bitsPerSample - 1) << 4));
	return bytes;
};

const writeMp4 = async (
	fastStart: false | 'fragmented',
	add: (output: Output) => () => Promise<void>,
) => {
	const output = new Output({ format: new Mp4OutputFormat({ fastStart }), target: new BufferTarget() });
	const run = add(output);
	await output.start();
	await run();
	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

const addOpus = (head: Uint8Array | null, packetCount = 30) => (output: Output) => {
	const source = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(source);
	return async () => {
		for (let i = 0; i < packetCount; i++) {
			const data = new Uint8Array(20).fill(i);
			data[0] = 0xfc; // CELT fullband 20 ms, stereo, one frame
			await source.add(new EncodedPacket(data, 'key', i * 0.02 - 312 / 48000, 0.02), i === 0
				? {
						decoderConfig: {
							codec: 'opus',
							numberOfChannels: head ? head[9]! : 2,
							sampleRate: 48000,
							...(head ? { description: head } : {}),
						},
					}
				: undefined);
		}
	};
};

const addFlac = (description: Uint8Array, sampleRate: number) => (output: Output) => {
	const source = new EncodedAudioPacketSource('flac');
	output.addAudioTrack(source);
	return async () => {
		for (let i = 0; i < 10; i++) {
			const data = new Uint8Array([0xff, 0xf8, 0xc9, 0x08, i, 0, 0, 0]); // Frames are passed through as they are
			await source.add(new EncodedPacket(data, 'key', i * 4096 / sampleRate, 4096 / sampleRate), i === 0
				? { decoderConfig: { codec: 'flac', numberOfChannels: 2, sampleRate, description } }
				: undefined);
		}
	};
};

const addVideo = (codec: 'av1' | 'vp9' | 'vp8', codecString: string, options: {
	displayAspectWidth?: number;
	displayAspectHeight?: number;
	colorSpace?: VideoColorSpaceInit;
} = {}) => (output: Output) => {
	const source = new EncodedVideoPacketSource(codec);
	output.addVideoTrack(source);
	return async () => {
		for (let i = 0; i < 10; i++) {
			await source.add(new EncodedPacket(new Uint8Array([0x12, 0x00, i]), i % 5 === 0 ? 'key' : 'delta', i / 30,
				1 / 30), i === 0
				? { decoderConfig: { codec: codecString, codedWidth: 640, codedHeight: 360, ...options } }
				: undefined);
		}
	};
};

type Files = Record<string, Box[]>;
let files: Files = {};
let rawFiles: Record<string, Uint8Array> = {};

beforeAll(async () => {
	const entries: [string, Promise<Uint8Array>][] = [
		['opus', writeMp4(false, addOpus(opusHead({ inputSampleRate: 44100, outputGain: -256 })))],
		['opus-fragmented', writeMp4('fragmented', addOpus(opusHead()))],
		['opus-surround', writeMp4(false, addOpus(opusHead({ channels: 6, mapping: [4, 2, 0, 4, 1, 2, 3, 5] })))],
		['flac', writeMp4(false, addFlac(flacDescription(44100, 2, 16), 44100))],
		['flac-96k', writeMp4(false, addFlac(flacDescription(96000, 2, 16), 96000))],
		['av1', writeMp4(false, addVideo('av1', 'av01.0.04M.10.0.112.06.06.06.0', {
			colorSpace: { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false },
		}))],
		['av1-fragmented', writeMp4('fragmented', addVideo('av1', 'av01.1.08H.08.0.000.01.01.01.0'))],
		['vp9', writeMp4(false, addVideo('vp9', 'vp09.02.10.10.01.09.16.09.01'))],
		['vp9-anamorphic', writeMp4(false, addVideo('vp9', 'vp09.00.10.08', {
			displayAspectWidth: 853,
			displayAspectHeight: 360,
		}))],
		['vp8', writeMp4(false, addVideo('vp8', 'vp8'))],
	];
	const written = await Promise.all(entries.map(async ([name, promise]): Promise<[string, Uint8Array]> => [
		name,
		await promise,
	]));
	rawFiles = Object.fromEntries(written);
	files = Object.fromEntries(Object.entries(rawFiles).map(([name, bytes]) => [name, parseBoxes(bytes)]));
});

/** Reads the AudioSampleEntry fields */
const audioEntry = (entry: Box) => ({
	channelCount: view(entry).getUint16(24),
	sampleSize: view(entry).getUint16(26),
	sampleRate: view(entry).getUint32(32) / 65536,
});

describe('Writer: Opus in ISOBMFF', () => {
	test('§4.2: the handler type is soun, the media information has a smhd, the sample entry is Opus', () => {
		for (const name of ['opus', 'opus-fragmented', 'opus-surround']) {
			const boxes = files[name]!;
			expect(String.fromCharCode(...find(boxes, 'hdlr')!.data.subarray(16, 20))).toBe('soun');
			expect(find(boxes, 'smhd')).toBeDefined();
			expect(find(boxes, 'Opus')).toBeDefined();
		}
	});

	test('§4.3.1: channelcount is the stream count plus the coupled stream count, samplesize 16, samplerate 48000',
		() => {
			expect(audioEntry(find(files['opus']!, 'Opus')!))
				.toEqual({ channelCount: 2, sampleSize: 16, sampleRate: 48000 });
			// Family 1 with 4 streams, 2 of them coupled
			expect(audioEntry(find(files['opus-surround']!, 'Opus')!).channelCount).toBe(4 + 2);
		});

	test('§4.3.2: exactly one dOps, version 0, its fields big-endian copies of the identification header', () => {
		const entry = find(files['opus']!, 'Opus')!;
		expect(entry.children.filter(box => box.type === 'dOps')).toHaveLength(1);
		const dOps = view(entry.children.find(box => box.type === 'dOps')!);
		expect(dOps.getUint8(8)).toBe(0); // Version
		expect(dOps.getUint8(9)).toBe(2); // OutputChannelCount
		expect(dOps.getUint16(10)).toBe(312); // PreSkip
		expect(dOps.getUint32(12)).toBe(44100); // InputSampleRate
		expect(dOps.getInt16(16)).toBe(-256); // OutputGain
		expect(dOps.getUint8(18)).toBe(0); // ChannelMappingFamily
		expect(dOps.byteLength).toBe(19);
	});

	test('§4.3.2: with a channel mapping family other than 0, the channel mapping table follows', () => {
		const dOps = find(files['opus-surround']!, 'dOps')!;
		expect([...dOps.data.subarray(18)]).toEqual([1, 4, 2, 0, 4, 1, 2, 3, 5]);
	});

	test('§4.3.6.1: Opus tracks have no Sync Sample Box and fragments mark no sample as non-sync', () => {
		expect(find(files['opus']!, 'stss')).toBeUndefined();
		for (const traf of findAll(files['opus-fragmented']!, 'traf')) {
			const tfhd = traf.children.find(box => box.type === 'tfhd')!;
			const flags = view(tfhd).getUint32(8) & 0xffffff;
			if (flags & 0x20) {
				// default_sample_flags comes after the optional fields that precede it
				let offset = 16;
				offset += flags & 0x01 ? 8 : 0;
				offset += flags & 0x02 ? 4 : 0;
				offset += flags & 0x08 ? 4 : 0;
				offset += flags & 0x10 ? 4 : 0;
				expect(view(tfhd).getUint32(offset) & 0x10000).toBe(0);
			}
			const trun = traf.children.find(box => box.type === 'trun')!;
			const trunFlags = view(trun).getUint32(8) & 0xffffff;
			if (trunFlags & 0x04) {
				expect(view(trun).getUint32(16 + (trunFlags & 0x01 ? 4 : 0)) & 0x10000).toBe(0);
			}
			expect(trunFlags & 0x400).toBe(0); // No per-sample flags that could mark a sample as non-sync
		}
	});

	test('§4.3.6.2: roll sample groups with negative distances, in the sample table and in every fragment', () => {
		const check = (container: Box) => {
			const sgpd = container.children
				.find(box => box.type === 'sgpd' && String.fromCharCode(...box.data.subarray(12, 16)) === 'roll')!;
			const sbgp = container.children.find(box => box.type === 'sbgp')!;
			expect(String.fromCharCode(...sgpd.data.subarray(12, 16))).toBe('roll');
			expect(String.fromCharCode(...sbgp.data.subarray(12, 16))).toBe('roll');
			const entryCount = view(sgpd).getUint32(20);
			for (let i = 0; i < entryCount; i++) {
				expect(view(sgpd).getInt16(24 + 2 * i)).toBeLessThan(0);
			}
		};
		check(find(files['opus']!, 'stbl')!);
		const trafs = findAll(files['opus-fragmented']!, 'traf');
		expect(trafs.length).toBeGreaterThan(0);
		trafs.forEach(check);
	});

	test('§4.3.6.2: AudioPreRollEntry (prol) is not used', () => {
		for (const name of ['opus', 'opus-fragmented']) {
			for (const sgpd of findAll(files[name]!, 'sgpd')) {
				expect(String.fromCharCode(...sgpd.data.subarray(12, 16))).not.toBe('prol');
			}
		}
	});

	test('§4.4: an edit list trims the priming samples (media time = pre-skip)', () => {
		for (const name of ['opus', 'opus-fragmented']) {
			const elst = find(files[name]!, 'elst')!;
			expect(elst).toBeDefined();
			const version = elst.data[8];
			const mediaTime = version === 1 ? Number(view(elst).getBigInt64(24)) : view(elst).getInt32(20);
			expect(mediaTime).toBe(312);
		}
	});

	test('§4.4: the media timescale is 48000 for sample-accurate trimming (SHOULD)', () => {
		const mdhd = find(files['opus']!, 'mdhd')!;
		expect(view(mdhd).getUint32(mdhd.data[8] === 1 ? 28 : 20)).toBe(48000);
	});

	test('§4.3.4: the last sample\'s duration counts only the valid samples', async () => {
		// The last packet ends at 30 * 20 ms - pre-skip; trimming the final packet to 5 ms shortens the last sample
		const bytes = await writeMp4(false, (output) => {
			const source = new EncodedAudioPacketSource('opus');
			output.addAudioTrack(source);
			return async () => {
				for (let i = 0; i < 5; i++) {
					const data = new Uint8Array([0xfc, i]);
					const decoderConfig = { codec: 'opus', numberOfChannels: 2, sampleRate: 48000 };
					await source.add(new EncodedPacket(data, 'key', i * 0.02, i === 4 ? 0.005 : 0.02),
						i === 0 ? { decoderConfig } : undefined);
				}
			};
		});
		const stts = find(parseBoxes(bytes), 'stts')!;
		const entries: [number, number][] = [];
		for (let i = 0; i < view(stts).getUint32(12); i++) {
			entries.push([view(stts).getUint32(16 + 8 * i), view(stts).getUint32(20 + 8 * i)]);
		}
		expect(entries.at(-1)).toEqual([1, 240]);
	});
});

describe('Writer: FLAC in ISOBMFF', () => {
	test('§3.2: the handler type is soun, the media information has a smhd, the sample entry is fLaC', () => {
		const boxes = files['flac']!;
		expect(String.fromCharCode(...find(boxes, 'hdlr')!.data.subarray(16, 20))).toBe('soun');
		expect(find(boxes, 'smhd')).toBeDefined();
		expect(find(boxes, 'fLaC')).toBeDefined();
	});

	test('§3.3.1: channelcount, samplesize and samplerate equal the STREAMINFO values (16-bit stream)', () => {
		// 24-bit streams: fork PR #4 writes their bit depth into samplesize
		expect(audioEntry(find(files['flac']!, 'fLaC')!))
			.toEqual({ channelCount: 2, sampleSize: 16, sampleRate: 44100 });
	});

	test('§3.3.2: exactly one dfLa, a version 0 FullBox with flags 0, starting with STREAMINFO, whose last block has '
		+ 'the last-metadata-block flag', () => {
		const entry = find(files['flac']!, 'fLaC')!;
		const dfLas = entry.children.filter(box => box.type === 'dfLa');
		expect(dfLas).toHaveLength(1);
		const dfLa = dfLas[0]!;
		expect(view(dfLa).getUint32(8)).toBe(0); // Version and flags
		expect(dfLa.data[12]! & 0x7f).toBe(0); // STREAMINFO
		let pos = 12;
		let last = false;
		while (pos < dfLa.data.length) {
			last = !!(dfLa.data[pos]! & 0x80);
			pos += 4 + ((dfLa.data[pos + 1]! << 16) | (dfLa.data[pos + 2]! << 8) | dfLa.data[pos + 3]!);
			if (last) {
				break;
			}
		}
		expect(last).toBe(true);
		expect(pos).toBe(dfLa.data.length);
	});

	test('§3.3.1: the STREAMINFO sample rate is what readers use for rates above 65535 Hz', async () => {
		// The samplerate field can't hold 96000; the specification asks for 48000 there (written as 0, like FFmpeg)
		using input = new Input({ source: new BufferSource(rawFiles['flac-96k']!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getSampleRate()).toBe(96000);
	});
});

/** Parses the fields of an av1C box */
const readAv1C = (box: Box) => {
	const b = box.data.subarray(8);
	return {
		marker: b[0]! >> 7,
		version: b[0]! & 0x7f,
		profile: b[1]! >> 5,
		level: b[1]! & 0x1f,
		tier: b[2]! >> 7,
		highBitdepth: (b[2]! >> 6) & 1,
		twelveBit: (b[2]! >> 5) & 1,
		monochrome: (b[2]! >> 4) & 1,
		subsamplingX: (b[2]! >> 3) & 1,
		subsamplingY: (b[2]! >> 2) & 1,
		configObus: b.subarray(4),
	};
};

describe('Writer: AV1-ISOBMFF', () => {
	test('§2.3: the sample entry is av01 with an av1C', () => {
		for (const name of ['av1', 'av1-fragmented']) {
			const entry = find(files[name]!, 'av01')!;
			expect(entry.children.filter(box => box.type === 'av1C')).toHaveLength(1);
		}
	});

	test('§2.3.4: av1C has marker 1, version 1, and profile, level, tier and bit depth of the codec string', () => {
		expect(readAv1C(find(files['av1']!, 'av1C')!)).toMatchObject({
			marker: 1, version: 1, profile: 0, level: 4, tier: 0, highBitdepth: 1, twelveBit: 0, monochrome: 0,
			subsamplingX: 1, subsamplingY: 1,
		});
		expect(readAv1C(find(files['av1-fragmented']!, 'av1C')!)).toMatchObject({
			marker: 1, version: 1, profile: 1, level: 8, tier: 1, highBitdepth: 0, subsamplingX: 0, subsamplingY: 0,
		});
	});

	test('§2.3.4: configOBUs hold at most one Sequence Header OBU, which comes first, with obu_has_size_field', () => {
		for (const name of ['av1', 'av1-fragmented']) {
			const { configObus } = readAv1C(find(files[name]!, 'av1C')!);
			let sequenceHeaders = 0;
			let pos = 0;
			while (pos < configObus.length) {
				const header = configObus[pos]!;
				const type = (header >> 3) & 0xf;
				expect(header & 0x02).toBe(0x02); // obu_has_size_field
				if (type === 1) {
					expect(pos).toBe(0);
					sequenceHeaders++;
				}
				let size = 0;
				let i = 0;
				let byte: number;
				do {
					byte = configObus[pos + 1 + (header & 0x04 ? 1 : 0) + i]!;
					size |= (byte & 0x7f) << (7 * i);
					i++;
				} while (byte & 0x80);
				pos += 1 + (header & 0x04 ? 1 : 0) + i + size;
			}
			expect(sequenceHeaders).toBeLessThanOrEqual(1);
		}
	});

	test('§2.3.4/§5: the colr box carries the colour description of the stream, like its codec string', () => {
		const colr = find(files['av1']!, 'colr')!;
		expect(String.fromCharCode(...colr.data.subarray(8, 12))).toBe('nclx');
		// SMPTE 170M primaries, transfer and matrix (6), limited range
		expect([view(colr).getUint16(12), view(colr).getUint16(14), view(colr).getUint16(16), colr.data[18]! >> 7])
			.toEqual([6, 6, 6, 0]);
	});
});

describe('Writer: VP codec ISOBMFF binding', () => {
	test('vpcC is a version 1 FullBox whose fields match the codec string, with no codec initialization data', () => {
		const vpcC = find(files['vp9']!, 'vpcC')!;
		const b = vpcC.data;
		expect(view(vpcC).getUint32(8)).toBe(0x01000000); // Version 1, flags 0
		// vp09.02.10.10.01.09.16.09.01
		expect(b[12]).toBe(2); // Profile
		expect(b[13]).toBe(10); // Level
		expect(b[14]! >> 4).toBe(10); // Bit depth
		expect((b[14]! >> 1) & 0x7).toBe(1); // Chroma subsampling
		expect(b[14]! & 1).toBe(1); // Full range
		expect([b[15], b[16], b[17]]).toEqual([9, 16, 9]);
		expect(view(vpcC).getUint16(18)).toBe(0); // codecInitializationDataSize
		expect(b.length).toBe(20);
	});

	test('codecInitializationDataSize is 0 for VP8 too', () => {
		const vpcC = find(files['vp8']!, 'vpcC')!;
		expect(view(vpcC).getUint16(18)).toBe(0);
	});

	test('a pasp box is included when the pixels aren\'t square', () => {
		const pasp = find(files['vp9-anamorphic']!, 'pasp')!;
		expect(pasp).toBeDefined();
		const ratio = view(pasp).getUint32(8) / view(pasp).getUint32(12);
		expect(ratio).toBeCloseTo((853 / 360) / (640 / 360), 3);
		expect(find(files['vp9']!, 'pasp')).toBeUndefined();
	});

	test('width and height of the sample entry are the coded size of the stream', () => {
		const entry = find(files['vp9']!, 'vp09')!;
		expect([view(entry).getUint16(32), view(entry).getUint16(34)]).toEqual([640, 360]);
	});
});

const readTracks = async (fileName: string) => {
	const filePath = path.join(__dirname, '../public', fileName);
	const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
	const tracks = await input.getTracks();
	const result = await Promise.all(tracks.map(async track => ({
		type: track.type,
		config: track.isVideoTrack()
			? await track.getDecoderConfig()
			: await (track as InputAudioTrack).getDecoderConfig(),
		firstPacket: await new EncodedPacketSink(track).getFirstPacket(),
	})));
	input.dispose();
	return result;
};

const descriptionOf = (config: AudioDecoderConfig | VideoDecoderConfig | null) => {
	const description = config?.description;
	if (!description) {
		return null;
	}
	return ArrayBuffer.isView(description)
		? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
		: new Uint8Array(description);
};

describe('Reader: WebCodecs codec registrations (decoder configs and chunk data)', () => {
	test('AVC: with an avcC description the chunks are length-prefixed, without one they are Annex B', async () => {
		const mp4 = (await readTracks('video.mp4')).find(track => track.type === 'video')!;
		expect(descriptionOf(mp4.config)![0]).toBe(1); // configurationVersion
		expect([...mp4.firstPacket!.data.subarray(0, 4)]).not.toEqual([0, 0, 0, 1]);
		const ts = (await readTracks('0.ts')).find(track => track.type === 'video')!;
		expect(descriptionOf(ts.config)).toBeNull();
		expect([...ts.firstPacket!.data.subarray(0, 4)]).toEqual([0, 0, 0, 1]);
	});

	test('AVC: the codec string is avc1. plus 6 hexadecimal digits (RFC 6381, Section 3.3)', async () => {
		for (const fileName of ['video.mp4', '0.ts']) {
			const video = (await readTracks(fileName)).find(track => track.type === 'video')!;
			expect(video.config!.codec).toMatch(/^avc[13]\.[0-9a-fA-F]{6}$/);
		}
	});

	test('AAC: an AudioSpecificConfig description goes with raw frames, no description with ADTS frames', async () => {
		const mp4 = (await readTracks('video.mp4')).find(track => track.type === 'audio')!;
		expect(descriptionOf(mp4.config)!.length).toBeGreaterThanOrEqual(2);
		expect(mp4.firstPacket!.data[0]).not.toBe(0xff);
		for (const fileName of ['sample3.aac', '0.ts']) {
			const adts = (await readTracks(fileName)).find(track => track.type === 'audio')!;
			expect(descriptionOf(adts.config)).toBeNull();
			expect([adts.firstPacket!.data[0], adts.firstPacket!.data[1]! & 0xf6]).toEqual([0xff, 0xf0]);
			expect(adts.config!.codec).toMatch(/^mp4a\.40\.(2|02|5|05|29|42)$|^mp4a\.67$/);
		}
	});

	test('Opus: an optional identification header as description', async () => {
		const [opus] = await readTracks('preroll-test.opus');
		expect(opus!.config!.codec).toBe('opus');
		expect(new TextDecoder().decode(descriptionOf(opus!.config)!.subarray(0, 8))).toBe('OpusHead');
	});

	test('Vorbis: the required description is Xiph-laced identification, comment and setup headers', async () => {
		const [vorbis] = await readTracks('vorbis-eos.ogg');
		const description = descriptionOf(vorbis!.config)!;
		expect(vorbis!.config!.codec).toBe('vorbis');
		expect(description[0]).toBe(2); // Three packets
		let pos = 1;
		const lengths: number[] = [];
		for (let i = 0; i < 2; i++) {
			let length = 0;
			while (description[pos] === 255) {
				length += 255;
				pos++;
			}
			length += description[pos++]!;
			lengths.push(length);
		}
		expect(description[pos]).toBe(1); // Identification header
		expect(description[pos + lengths[0]!]).toBe(3); // Comment header
		expect(description[pos + lengths[0]! + lengths[1]!]).toBe(5); // Setup header
	});

	test('FLAC: the required description is "fLaC" followed by the STREAMINFO block', async () => {
		const [flac] = await readTracks('sample.flac');
		const description = descriptionOf(flac!.config)!;
		expect(flac!.config!.codec).toBe('flac');
		expect(new TextDecoder().decode(description.subarray(0, 4))).toBe('fLaC');
		expect(description[4]! & 0x7f).toBe(0);
		expect((description[5]! << 16) | (description[6]! << 8) | description[7]!).toBe(34);
	});

	test('MP3, PCM: no description; MP3 chunks are frames', async () => {
		const [mp3] = await readTracks('Toothsome-Meme.VBRv2.mp3');
		expect(mp3!.config!.codec).toBe('mp3');
		expect(descriptionOf(mp3!.config)).toBeNull();
		expect(mp3!.firstPacket!.data[0]).toBe(0xff);
		const [pcm] = await readTracks('glitch-hop-is-dead.wav');
		expect(pcm!.config!.codec).toMatch(/^pcm-(u8|s16|s24|s32|f32)$/);
		expect(descriptionOf(pcm!.config)).toBeNull();
	});

	test('Opus in ISOBMFF: dOps is read back into the little-endian identification header', async () => {
		using input = new Input({ source: new BufferSource(rawFiles['opus-surround']!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack()) as InputAudioTrack;
		const description = descriptionOf(await track.getDecoderConfig())!;
		expect([...description]).toEqual([...opusHead({ channels: 6, mapping: [4, 2, 0, 4, 1, 2, 3, 5] })]);
	});

	test('AV1-ISOBMFF §5 / VP ISOBMFF: codec strings read from av1C and vpcC follow the codecs parameter syntax',
		async () => {
			const strings: string[] = [];
			for (const name of ['av1', 'av1-fragmented', 'vp9', 'vp9-anamorphic']) {
				using input = new Input({ source: new BufferSource(rawFiles[name]!), formats: ALL_FORMATS });
				strings.push((await (await input.getPrimaryVideoTrack())!.getDecoderConfig())!.codec);
			}
			expect(strings[0]).toBe('av01.0.04M.10.0.112.06.06.06.0');
			expect(strings[1]).toMatch(/^av01\.1\.08H\.08(\.0\.000\.01\.01\.01\.0)?$/);
			expect(strings[2]).toBe('vp09.02.10.10.01.09.16.09.01');
			expect(strings[3]).toMatch(/^vp09\.00\.10\.08(\.\d\d){0,5}$/);
		});
});

describe('Writer: RFC 6381 (codecs parameter of output MIME types)', () => {
	const mimeTypeOf = async (format: Mp4OutputFormat | WebMOutputFormat) => {
		const output = new Output({ format, target: new BufferTarget() });
		const video = new EncodedVideoPacketSource(format instanceof WebMOutputFormat ? 'vp9' : 'avc');
		const audio = new EncodedAudioPacketSource('opus');
		output.addVideoTrack(video);
		output.addAudioTrack(audio);
		await output.start();
		await video.add(new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x65]), 'key', 0, 1 / 30), {
			decoderConfig: format instanceof WebMOutputFormat
				? { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 }
				: {
						codec: 'avc1.64001f',
						codedWidth: 64,
						codedHeight: 64,
						description: new Uint8Array([1, 0x64, 0, 0x1f, 0xff, 0xe0, 0]),
					},
		});
		await audio.add(new EncodedPacket(new Uint8Array([0xfc, 0]), 'key', 0, 0.02), {
			decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000, description: opusHead() },
		});
		const mimeType = await output.getMimeType();
		await output.finalize();
		return mimeType;
	};

	const codecsOf = (mimeType: string) => {
		const match = /;\s*codecs="([^"]*)"/.exec(mimeType)!;
		return match[1]!.split(',').map(codec => codec.trim());
	};

	test('§3.1: the codecs parameter lists every codec of the content and nothing else', async () => {
		expect(codecsOf(await mimeTypeOf(new Mp4OutputFormat())).sort()).toEqual(['avc1.64001f', 'opus']);
		expect(codecsOf(await mimeTypeOf(new WebMOutputFormat())).sort()).toEqual(['opus', 'vp09.00.10.08']);
	});

	test('§3.2: no white space or comments between the tokens of the codecs parameter except after ","', async () => {
		for (const format of [new Mp4OutputFormat(), new WebMOutputFormat()]) {
			const match = /;\s*codecs="([^"]*)"/.exec(await mimeTypeOf(format))!;
			expect(match[1]).toMatch(/^[^\s(),]+(,\s?[^\s(),]+)*$/);
		}
	});
});

// --- WebVTT (W3C WebVTT: The Web Video Text Tracks Format) ---

const WEBVTT_TEXT = 'WEBVTT\tKaraoke test\r\n'
	+ 'Kind: captions\r\n'
	+ '\r\n'
	+ 'STYLE\r\n'
	+ '::cue { color: red }\r\n'
	+ '\r\n'
	+ 'first\r\n'
	+ '00:01.500 --> 00:04.000 align:start line:0\r\n'
	+ 'Caf\u0065\u0301 <00:02.500>au <00:03.250>lait\r\n'
	+ 'second line\r\n'
	+ '\r\n'
	+ '01:00:05.000 --> 01:00:06.000\r\n'
	+ 'Later\r\n';

const writeWebVtt = async (format: Mp4OutputFormat | MkvOutputFormat) => {
	const output = new Output({ format, target: new BufferTarget() });
	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);
	await output.start();
	await source.add(WEBVTT_TEXT);
	source.close();
	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

type VttBlock = { timestamp: number; duration: number; payload: string; additions: string | null };

const readMkvWebVtt = (bytes: Uint8Array) => {
	const nodes = parseEbml(bytes);
	const trackEntry = findEbml(nodes, 'TrackEntry')!;
	const codecId = readString(child(trackEntry, 'CodecID')!);
	const codecPrivate = new TextDecoder().decode(child(trackEntry, 'CodecPrivate')!.data);
	const blocks: VttBlock[] = [];
	for (const cluster of findAllEbml(nodes, 'Cluster')) {
		const clusterTimestamp = readUint(child(cluster, 'Timestamp')!);
		for (const group of childrenNamed(cluster, 'BlockGroup')) {
			const block = child(group, 'Block')!.data;
			const relative = (block[1]! << 8 | block[2]!) << 16 >> 16;
			const additional = findEbml(group.children, 'BlockAdditional');
			blocks.push({
				timestamp: (clusterTimestamp + relative) / 1000,
				duration: readUint(child(group, 'BlockDuration')!) / 1000,
				payload: new TextDecoder().decode(block.subarray(4)),
				additions: additional ? new TextDecoder().decode(additional.data) : null,
			});
		}
	}
	return { codecId, codecPrivate, blocks };
};

/** All boxes of the samples of an MP4 WebVTT track, in order */
const readMp4WebVtt = (bytes: Uint8Array) => {
	const boxes = parseBoxes(bytes);
	const entry = find(boxes, 'wvtt')!;
	const vttC = parseBoxes(entry.data, 16).find(box => box.type === 'vttC')!;
	const mdat = boxes.find(box => box.type === 'mdat')!;
	const sampleBoxes = parseBoxes(mdat.data, 8).map(box => ({
		type: box.type,
		children: Object.fromEntries(parseBoxes(box.data, 8)
			.map(childBox => [childBox.type, new TextDecoder().decode(childBox.data.subarray(8))])),
	}));
	return { config: new TextDecoder().decode(vttC.data.subarray(8)), sampleBoxes };
};

const WEBVTT_TIMESTAMP = /^(\d{2,}:)?[0-5]\d:[0-5]\d\.\d{3}$/;

describe('WebVTT (W3C): parsing cue text and serializing it into Matroska and MP4', () => {
	test('§6.1: CR LF line terminators, header text after a tab, and header blocks are accepted and kept', async () => {
		const mkv = readMkvWebVtt(await writeWebVtt(new MkvOutputFormat()));
		expect(mkv.codecId).toBe('S_TEXT/WEBVTT');
		expect(mkv.codecPrivate).toMatch(/^WEBVTT\tKaraoke test\nKind: captions\n\nSTYLE\n::cue \{ color: red \}/);
		const mp4 = readMp4WebVtt(await writeWebVtt(new Mp4OutputFormat()));
		expect(mp4.config).toMatch(/^WEBVTT\tKaraoke test\n/);
	});

	test('§6.3: timestamps with and without hours give the cue start and end times', async () => {
		const { blocks } = readMkvWebVtt(await writeWebVtt(new MkvOutputFormat()));
		expect(blocks.map(block => [block.timestamp, block.duration])).toEqual([[1.5, 2.5], [3605, 1]]);
	});

	test('§4.1/§6.1: the cue identifier and the cue settings are kept with the cue', async () => {
		const { blocks } = readMkvWebVtt(await writeWebVtt(new MkvOutputFormat()));
		expect(blocks[0]!.additions).toMatch(/^align:start line:0\nfirst\n/);
		const { sampleBoxes } = readMp4WebVtt(await writeWebVtt(new Mp4OutputFormat()));
		const firstCue = sampleBoxes.find(box => box.type === 'vttc')!;
		expect(firstCue.children['iden']).toBe('first');
		expect(firstCue.children['sttg']).toBe('align:start line:0');
	});

	test('§4.1: a multi-line cue payload is kept whole, without the blank line that ends it', async () => {
		const { blocks } = readMkvWebVtt(await writeWebVtt(new MkvOutputFormat()));
		expect(blocks[0]!.payload).toBe('Caf\u0065\u0301 <00:00:01.000>au <00:00:01.750>lait\nsecond line');
		const { sampleBoxes } = readMp4WebVtt(await writeWebVtt(new Mp4OutputFormat()));
		expect(sampleBoxes.find(box => box.type === 'vttc')!.children['payl'])
			.toBe('Caf\u0065\u0301 <00:02.500>au <00:03.250>lait\nsecond line');
	});

	test('§2.2: text is not Unicode-normalized (the decomposed é stays decomposed)', async () => {
		const { blocks } = readMkvWebVtt(await writeWebVtt(new MkvOutputFormat()));
		expect(blocks[0]!.payload.startsWith('Cafe\u0301')).toBe(true);
	});

	test('§4.2.2: inline timestamps written into Matroska blocks are valid WebVTT timestamps', async () => {
		const { blocks } = readMkvWebVtt(await writeWebVtt(new MkvOutputFormat()));
		const timestamps = [...blocks[0]!.payload.matchAll(/<([^>]+)>/g)].map(match => match[1]!);
		expect(timestamps).toHaveLength(2);
		for (const timestamp of timestamps) {
			expect(timestamp).toMatch(WEBVTT_TIMESTAMP);
		}
	});

	test('§4.1: cues keep their order and every cue ends after it starts', async () => {
		const { blocks } = readMkvWebVtt(await writeWebVtt(new MkvOutputFormat()));
		for (let i = 0; i < blocks.length; i++) {
			expect(blocks[i]!.duration).toBeGreaterThan(0);
			if (i > 0) {
				expect(blocks[i]!.timestamp).toBeGreaterThanOrEqual(blocks[i - 1]!.timestamp);
			}
		}
	});

	test('ISO/IEC 14496-30: gaps between cues are vtte samples, cues are vttc samples with a payl box', async () => {
		const { sampleBoxes } = readMp4WebVtt(await writeWebVtt(new Mp4OutputFormat()));
		expect(sampleBoxes.map(box => box.type)).toEqual(['vtte', 'vttc', 'vtte', 'vttc']);
		for (const box of sampleBoxes.filter(box => box.type === 'vttc')) {
			expect(box.children['payl']).toBeDefined();
		}
	});
});
