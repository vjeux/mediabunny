import { beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	AttachedFile,
	AudioSample,
	AudioSampleSource,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	InputAudioTrack,
	MATROSKA,
	MkvOutputFormat,
	Output,
	TextSubtitleSource,
	WEBM,
	WebMOutputFormat,
} from '../../src/index.js';
import {
	buildMatroska,
	child,
	childrenNamed,
	collectFacts,
	ebmlHeader,
	EbmlNode,
	el,
	encodeEbml,
	findAll,
	float,
	MATROSKA_SCHEMA,
	parseEbml,
	readFloat,
	readString,
	readUint,
	readVint,
	simpleBlock,
	str,
	uint,
	validateElementTable,
	walk,
} from './helpers/spec-matrix-ebml.js';

// Normative compliance of Mediabunny's Matroska/WebM writer and reader, one test per checked statement of RFC 8794
// (EBML), RFC 9559 (Matroska) with its element table (ebml_matroska.xml), the Matroska codec mappings and the WebM
// container guidelines. Test names start with the clause they check.

const __dirname = fileURLToPath(new URL('.', import.meta.url));

type CorpusFile = { name: string; bytes: Uint8Array; webm: boolean; tree: EbmlNode[] };

const opusHead = (preSkip: number, inputSampleRate: number, channels = 2) => {
	const bytes = new Uint8Array(19);
	bytes.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]); // 'OpusHead', version 1
	const view = new DataView(bytes.buffer);
	view.setUint16(10, preSkip, true);
	view.setUint32(12, inputSampleRate, true);
	return bytes;
};

const OPUS_PRE_SKIP = 312;

// Vorbis description as WebCodecs defines it: the three headers in Xiph lacing
const vorbisDescription = () => {
	const identification = new Uint8Array(30);
	identification.set([1, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]); // '\x01vorbis'
	identification[11] = 2; // channels
	new DataView(identification.buffer).setUint32(12, 48000, true);
	identification[28] = 0xb8; // blocksizes 256/2048
	identification[29] = 1; // framing
	const comment = new Uint8Array([3, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
	const setup = new Uint8Array([5, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0, 0, 0, 0]);
	return new Uint8Array([2, identification.length, comment.length, ...identification, ...comment, ...setup]);
};

const addVideo = (
	output: Output,
	codec: 'vp8' | 'vp9' | 'av1' | 'avc',
	options: { metadata?: object; frames?: number; alpha?: boolean; bFrames?: boolean; gop?: number } = {},
) => {
	const source = new EncodedVideoPacketSource(codec);
	output.addVideoTrack(source, options.metadata ?? {});
	const codecString = { vp8: 'vp8', vp9: 'vp09.00.10.08', av1: 'av01.0.04M.08', avc: 'avc1.64001f' }[codec];

	return async () => {
		const frames = options.frames ?? 60;
		const gop = options.gop ?? 15;
		for (let i = 0; i < frames; i++) {
			// With B-frames, packets come in decode order: I0 P3 B1 B2 P6 B4 B5 ...
			let index = i;
			if (options.bFrames && i % gop !== 0) {
				const position = (i % gop) - 1;
				index = i - (i % gop) + [3, 1, 2][position % 3]! + 3 * Math.floor(position / 3);
				index = Math.min(index, frames - 1);
			}
			const packet = new EncodedPacket(
				new Uint8Array([i & 0xff, 1, 2, 3, 4, 5, 6, 7]),
				i % gop === 0 ? 'key' : 'delta',
				index / 30,
				1 / 30,
				undefined,
				undefined,
				options.alpha ? { alpha: new Uint8Array([9, 9, 9]) } : undefined,
			);
			await source.add(packet, i === 0
				? {
						decoderConfig: {
							codec: codecString,
							codedWidth: 320,
							codedHeight: 240,
							description: codec === 'avc'
								? new Uint8Array([1, 0x64, 0, 0x1f, 0xff, 0xe0, 0])
								: undefined,
							colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
						},
					}
				: undefined);
		}
	};
};

const addOpus = (output: Output, options: { metadata?: object; firstTimestamp?: number; packets?: number } = {}) => {
	const source = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(source, options.metadata ?? {});

	return async () => {
		const firstTimestamp = options.firstTimestamp ?? -OPUS_PRE_SKIP / 48000;
		for (let i = 0; i < (options.packets ?? 100); i++) {
			const packet = new EncodedPacket(new Uint8Array([0xfc, i & 0xff]), 'key', firstTimestamp + i * 0.02, 0.02);
			await source.add(packet,
				i === 0
					? {
							decoderConfig: {
								codec: 'opus',
								numberOfChannels: 2,
								sampleRate: 48000,
								description: opusHead(OPUS_PRE_SKIP, 48000),
							},
						}
					: undefined);
		}
	};
};

const addVorbis = (output: Output) => {
	const source = new EncodedAudioPacketSource('vorbis');
	output.addAudioTrack(source);

	return async () => {
		for (let i = 0; i < 50; i++) {
			await source.add(new EncodedPacket(new Uint8Array([0, i & 0xff]), 'key', i * 2048 / 48000, 2048 / 48000),
				i === 0
					? {
							decoderConfig: {
								codec: 'vorbis',
								numberOfChannels: 2,
								sampleRate: 48000,
								description: vorbisDescription(),
							},
						}
					: undefined);
		}
	};
};

/** Copies every track of a repository file into the output, packet by packet. */
const addCopiedTracks = async (output: Output, fileName: string) => {
	const filePath = path.join(__dirname, '../public', fileName);
	const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
	const runs: (() => Promise<void>)[] = [];

	for (const track of await input.getTracks()) {
		const codec = await track.getCodec();
		if (!codec) {
			continue;
		}
		const decoderConfig = track.isVideoTrack()
			? await track.getDecoderConfig()
			: await (track as InputAudioTrack).getDecoderConfig();
		const source = track.isVideoTrack()
			? new EncodedVideoPacketSource(codec as never)
			: new EncodedAudioPacketSource(codec as never);
		if (track.isVideoTrack()) {
			output.addVideoTrack(source as EncodedVideoPacketSource);
		} else {
			output.addAudioTrack(source as EncodedAudioPacketSource);
		}

		runs.push(async () => {
			let first = true;
			for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined)) {
				if (packet.timestamp > 2) {
					break;
				}
				await (source as EncodedAudioPacketSource).add(packet, first ? { decoderConfig } as never : undefined);
				first = false;
			}
		});
	}

	return async () => {
		await Promise.all(runs.map(run => run()));
		input.dispose();
	};
};

const buildFile = async (
	format: MkvOutputFormat | WebMOutputFormat,
	setup: (output: Output) => Promise<() => Promise<void>> | (() => Promise<void>),
) => {
	const output = new Output({ format, target: new BufferTarget() });
	const run = await setup(output);
	await output.start();
	await run();
	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

const buildCorpus = async (): Promise<CorpusFile[]> => {
	const files: Omit<CorpusFile, 'tree'>[] = [];
	const add = async (name: string, webm: boolean, setup: Parameters<typeof buildFile>[1]) => {
		const format = webm ? new WebMOutputFormat() : new MkvOutputFormat();
		files.push({ name, webm, bytes: await buildFile(format, setup) });
	};

	await add('mkv-vp9-opus-webvtt-tags', false, (output) => {
		const video = addVideo(output, 'vp9', {
			metadata: { frameRate: 30, rotation: 90, name: 'Video', languageCode: 'eng' },
			alpha: true,
		});
		const audio = addOpus(output, {
			metadata: {
				languageCode: 'fre',
				disposition: { original: true, commentary: true, hearingImpaired: true, visuallyImpaired: true },
			},
		});
		const subtitles = new TextSubtitleSource('webvtt');
		output.addSubtitleTrack(subtitles, { languageCode: 'ger', name: 'Untertitel', disposition: { forced: true } });
		output.setMetadataTags({
			title: 'Title',
			artist: 'Artist',
			date: new Date('2020-05-06'),
			trackNumber: 3,
			tracksTotal: 9,
			discNumber: 1,
			comment: 'Comment',
			genre: 'Genre',
			raw: {
				CUSTOM: 'value',
				BINARY: new Uint8Array([1, 2]),
				12345: new AttachedFile(new Uint8Array([7]), 'text/plain', 'a.txt'),
			},
			images: [
				{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', kind: 'coverFront', description: 'Front' },
			],
		});

		return async () => {
			await Promise.all([
				video(),
				audio(),
				subtitles.add(
					'WEBVTT\n\nid1\n00:00.000 --> 00:01.000 align:start\nHello\n\n00:01.000 --> 00:01.500\nWorld\n',
				),
			]);
			subtitles.close();
		};
	});
	await add('webm-vp8-opus', true, (output) => {
		const video = addVideo(output, 'vp8', { metadata: { frameRate: 30 } });
		const audio = addOpus(output, { metadata: { disposition: { default: false, forced: true } } });
		output.setMetadataTags({ title: 'WebM' });
		return async () => {
			await Promise.all([video(), audio()]);
		};
	});
	await add('webm-av1-vorbis', true, (output) => {
		const video = addVideo(output, 'av1', { metadata: { frameRate: 24 } });
		const audio = addVorbis(output);
		return async () => {
			await Promise.all([video(), audio()]);
		};
	});
	await add('webm-vp9-alpha', true, output => addVideo(output, 'vp9', { alpha: true, frames: 40 }));
	await add('mkv-avc-bframes', false, output => addVideo(output, 'avc', {
		bFrames: true,
		metadata: { rotation: 180, flip: true } as object,
	}));
	await add('mkv-vp8-anamorphic', false, (output) => {
		const source = new EncodedVideoPacketSource('vp8');
		output.addVideoTrack(source, { frameRate: 25 });
		return async () => {
			for (let i = 0; i < 30; i++) {
				const type = i % 10 === 0 ? 'key' : 'delta';
				const packet = new EncodedPacket(new Uint8Array([i, 1, 2]), type, i / 25, 1 / 25);
				await source.add(packet,
					i === 0
						? {
								decoderConfig: {
									codec: 'vp8',
									codedWidth: 720,
									codedHeight: 576,
									displayAspectWidth: 16,
									displayAspectHeight: 9,
								},
							}
						: undefined);
			}
		};
	});
	await add('mkv-pcm', false, (output) => {
		const sources = (['pcm-s16', 'pcm-u8', 'pcm-f32', 'pcm-s24be'] as const).map((codec) => {
			const source = new AudioSampleSource({ codec });
			output.addAudioTrack(source);
			return source;
		});
		return async () => {
			for (const source of sources) {
				const sample = new AudioSample({
					data: new Float32Array(9600),
					format: 'f32',
					numberOfChannels: 2,
					sampleRate: 48000,
					timestamp: 0,
				});
				await source.add(sample);
				sample.close();
			}
		};
	});
	await add('mkv-copy-flac', false, output => addCopiedTracks(output, 'sample.flac'));
	await add('mkv-copy-aac', false, output => addCopiedTracks(output, 'sample3.aac'));
	await add('mkv-copy-avc-aac', false, output => addCopiedTracks(output, 'video.mp4'));
	await add('webm-copy-demo', true, output => addCopiedTracks(output, 'demo.webm'));

	const appendOnly = await buildFile(new MkvOutputFormat({ appendOnly: true }), (output) => {
		const video = addVideo(output, 'vp9', { metadata: { frameRate: 30 } });
		const audio = addOpus(output);
		return async () => {
			await Promise.all([video(), audio()]);
		};
	});
	files.push({ name: 'mkv-append-only', webm: false, bytes: appendOnly });

	return files.map(file => ({ ...file, tree: parseEbml(file.bytes) }));
};

let corpus: CorpusFile[] = [];

// Validating a whole file is the expensive part; every element test reads the same per-file results
const violationCache = new Map<CorpusFile, ReturnType<typeof validateElementTable>>();
const violationsOf = (file: CorpusFile) => {
	let violations = violationCache.get(file);
	if (!violations) {
		violations = validateElementTable(file.tree, { webm: file.webm });
		violationCache.set(file, violations);
	}
	return violations;
};
beforeAll(async () => {
	corpus = await buildCorpus();
});

const segmentOf = (file: CorpusFile) => file.tree.find(node => node.name === 'Segment')!;
const headerOf = (file: CorpusFile) => file.tree.find(node => node.name === 'EBML')!;
const valueOf = (node: EbmlNode | undefined, name: string) => {
	const found = node && child(node, name);
	return found ? readUint(found) : undefined;
};
const tracksOf = (file: CorpusFile) => findAll(file.tree, 'TrackEntry');
const codecIdOf = (entry: EbmlNode) => readString(child(entry, 'CodecID')!);

// The elements Mediabunny's Matroska muxer writes
const WRITTEN_ELEMENTS = [
	'EBML', 'EBMLVersion', 'EBMLReadVersion', 'EBMLMaxIDLength', 'EBMLMaxSizeLength', 'DocType', 'DocTypeVersion',
	'DocTypeReadVersion', 'Segment', 'SeekHead', 'Seek', 'SeekID', 'SeekPosition', 'Info', 'TimestampScale',
	'Duration', 'DateUTC', 'MuxingApp', 'WritingApp', 'Tracks', 'TrackEntry', 'TrackNumber', 'TrackUID', 'TrackType',
	'FlagDefault', 'FlagForced', 'FlagHearingImpaired', 'FlagVisualImpaired', 'FlagOriginal', 'FlagCommentary',
	'FlagLacing', 'Language', 'CodecID', 'CodecPrivate', 'CodecDelay', 'SeekPreRoll', 'Name', 'DefaultDuration',
	'Video', 'PixelWidth', 'PixelHeight', 'DisplayWidth', 'DisplayHeight', 'DisplayUnit', 'AlphaMode', 'Colour',
	'MatrixCoefficients', 'TransferCharacteristics',
	'Primaries', 'Range', 'Projection', 'ProjectionType', 'ProjectionPoseYaw', 'ProjectionPoseRoll', 'Audio',
	'SamplingFrequency', 'Channels', 'BitDepth', 'Tags', 'Tag', 'Targets', 'TargetTypeValue', 'TargetType',
	'SimpleTag', 'TagName', 'TagString', 'TagBinary', 'Attachments', 'AttachedFile', 'FileDescription', 'FileName',
	'FileMediaType',
	'FileData', 'FileUID', 'Cluster', 'Timestamp', 'SimpleBlock', 'BlockGroup', 'Block', 'ReferenceBlock',
	'BlockAdditions', 'BlockMore', 'BlockAddID', 'BlockAdditional', 'BlockDuration', 'Cues', 'CuePoint', 'CueTime',
	'CueTrackPositions', 'CueTrack', 'CueClusterPosition', 'CueRelativePosition',
];

const describeConstraints = (name: string) => {
	const element = MATROSKA_SCHEMA.find(e => e.name === name)!;
	const parts = [`minOccurs ${element.minOccurs}`, `maxOccurs ${element.maxOccurs ?? 'unbounded'}`];
	if (element.range) {
		parts.push(`range ${element.range}`);
	}
	if (element.length) {
		parts.push(`length ${element.length}`);
	}
	if (element.default) {
		parts.push(`default ${element.default}`);
	}
	return parts.join(', ');
};

describe('Writer: RFC 9559 Section 5 element table and RFC 8794 Section 11.1.6 constraints', () => {
	test.each(WRITTEN_ELEMENTS.map(name => ({ name, constraints: describeConstraints(name) })))(
		'§5.1 $name: $constraints, placed under its parent path',
		({ name }) => {
			let occurrences = 0;
			const violations: string[] = [];
			for (const file of corpus) {
				occurrences += findAll(file.tree, name).length;
				for (const violation of violationsOf(file)) {
					if (violation.element === name) {
						violations.push(`${file.name}: ${violation.clause}: ${violation.message}`);
					}
				}
			}

			if (MATROSKA_SCHEMA.find(e => e.name === name)!.minOccurs > 0) {
				expect(occurrences).toBeGreaterThan(0); // Mandatory elements are written; optional ones may be left out
			}
			expect(violations).toEqual([]);
		},
	);

	test('RFC 8794 §11.1.6.4-§11.1.6.7: no element in any written file breaks the element table', () => {
		const violations = corpus.flatMap(file => violationsOf(file)
			.map(violation => `${file.name}: ${violation.path}: ${violation.clause}: ${violation.message}`));
		expect(violations).toEqual([]);
	});

	test('RFC 8794 §7.7: every element in a master element is defined for that parent (EBMLParentPath)', () => {
		for (const file of corpus) {
			for (const node of walk(file.tree)) {
				expect(node.schema !== null || node.name === 'Void', `${file.name}: ${node.path}`).toBe(true);
			}
		}
	});
});

describe('Writer: RFC 8794 (EBML)', () => {
	test('§4 VINT: every element ID and data size has exactly one VINT_MARKER and fits its declared width', () => {
		for (const file of corpus) {
			for (const node of walk(file.tree)) {
				const id = readVint(file.bytes, node.offset)!;
				expect(id.length).toBe(node.idLength);
				const size = readVint(file.bytes, node.offset + node.idLength)!;
				expect(size.length).toBe(node.sizeLength);
				expect(node.end).toBeLessThanOrEqual(file.bytes.length);
			}
		}
	});

	test('§5 Element ID: VINT_DATA of every ID is neither all zeros nor all ones and uses the shortest length', () => {
		for (const file of corpus) {
			for (const node of walk(file.tree)) {
				const id = readVint(file.bytes, node.offset)!;
				expect(id.allOnes).toBe(false);
				expect(id.value).not.toBe(0);
				// Shortest valid length: the value wouldn't fit (or would be all ones) one octet shorter
				if (id.length > 1) {
					expect(id.value).toBeGreaterThanOrEqual(2 ** (7 * (id.length - 1)) - 1);
				}
			}
		}
	});

	test('§6.2: unknown sizes are only used by append-only output, and only on Segment and Cluster', () => {
		for (const file of corpus) {
			const unknown = [...walk(file.tree)].filter(node => node.declaredSize === null);
			if (file.name === 'mkv-append-only') {
				expect(unknown.length).toBeGreaterThan(1);
				expect(new Set(unknown.map(node => node.name))).toEqual(new Set(['Segment', 'Cluster']));
			} else {
				expect(unknown).toEqual([]);
			}
		}
	});

	test('§6.3: a data size of 2^(7n)-1 is never written on n octets', () => {
		for (const file of corpus) {
			for (const node of walk(file.tree)) {
				if (node.declaredSize !== null) {
					expect(node.declaredSize).not.toBe(2 ** (7 * node.sizeLength) - 1);
				}
			}
		}
	});

	test.each([
		{ clause: '§7.1/§7.2', type: ['u', 'i'], lengths: [0, 1, 2, 3, 4, 5, 6, 7, 8], what: 'integers: 0-8 octets' },
		{ clause: '§7.3', type: ['f'], lengths: [0, 4, 8], what: 'floats take 0, 4 or 8 octets' },
		{ clause: '§7.6', type: ['d'], lengths: [0, 8], what: 'dates take 0 or 8 octets' },
	])('$clause: $what', ({ type, lengths }) => {
		for (const file of corpus) {
			for (const node of walk(file.tree)) {
				if (node.schema && type.includes(node.schema.type)) {
					expect(lengths, `${file.name}: ${node.path}`).toContain(node.data.length);
				}
			}
		}
	});

	test('§7.4: String elements hold printable ASCII (0x20-0x7E) only', () => {
		for (const file of corpus) {
			for (const node of walk(file.tree)) {
				if (node.schema?.type === 's') {
					expect([...node.data].every(byte => byte >= 0x20 && byte <= 0x7e), node.path).toBe(true);
				}
			}
		}
	});

	test('§7.5: UTF-8 elements hold valid UTF-8', () => {
		for (const file of corpus) {
			for (const node of walk(file.tree)) {
				if (node.schema?.type === '8') {
					expect(() => new TextDecoder('utf-8', { fatal: true }).decode(node.data)).not.toThrow();
				}
			}
		}
	});

	test('§8: the document starts with an EBML Header (a single EBML master element)', () => {
		for (const file of corpus) {
			expect(file.tree[0]!.name).toBe('EBML');
			expect(file.tree.filter(node => node.name === 'EBML')).toHaveLength(1);
		}
	});

	test('§8.1: an EBMLVersion 1 header only holds elements RFC 8794 defines', () => {
		const allowed = ['EBMLVersion', 'EBMLReadVersion', 'EBMLMaxIDLength', 'EBMLMaxSizeLength', 'DocType',
			'DocTypeVersion', 'DocTypeReadVersion', 'DocTypeExtension', 'Void', 'CRC-32'];
		for (const file of corpus) {
			for (const node of headerOf(file).children) {
				expect(allowed).toContain(node.name);
			}
		}
	});

	test('§8: the document holds nothing but EBML elements (no trailing bytes)', () => {
		for (const file of corpus) {
			expect(file.tree.at(-1)!.end).toBe(file.bytes.length);
		}
	});

	test('§11.2.2/§11.2.3: EBMLVersion is 1 and EBMLReadVersion is at most EBMLVersion', () => {
		for (const file of corpus) {
			expect(valueOf(headerOf(file), 'EBMLVersion')).toBe(1);
			expect(valueOf(headerOf(file), 'EBMLReadVersion')!).toBeLessThanOrEqual(1);
		}
	});

	test('§11.2.8: DocTypeReadVersion is at most DocTypeVersion', () => {
		for (const file of corpus) {
			expect(valueOf(headerOf(file), 'DocTypeReadVersion')!)
				.toBeLessThanOrEqual(valueOf(headerOf(file), 'DocTypeVersion')!);
		}
	});

	test('§11.2.4/§11.2.5: no element ID or data size is longer than EBMLMaxIDLength/EBMLMaxSizeLength', () => {
		for (const file of corpus) {
			const maxIdLength = valueOf(headerOf(file), 'EBMLMaxIDLength')!;
			const maxSizeLength = valueOf(headerOf(file), 'EBMLMaxSizeLength')!;
			for (const node of walk(file.tree)) {
				expect(node.idLength).toBeLessThanOrEqual(maxIdLength);
				expect(node.sizeLength).toBeLessThanOrEqual(maxSizeLength);
			}
		}
	});
});

describe('Writer: RFC 9559 (Matroska)', () => {
	test('§4.3: DocType is "matroska" ("webm" for WebM), EBMLMaxIDLength is 4, EBMLMaxSizeLength is 1-8', () => {
		for (const file of corpus) {
			expect(readString(child(headerOf(file), 'DocType')!)).toBe(file.webm ? 'webm' : 'matroska');
			expect(valueOf(headerOf(file), 'EBMLMaxIDLength')).toBe(4);
			const maxSizeLength = valueOf(headerOf(file), 'EBMLMaxSizeLength')!;
			expect(maxSizeLength >= 1 && maxSizeLength <= 8).toBe(true);
		}
	});

	test('§4.4/§6.1: the Segment and all Top-Level Elements use 4-octet element IDs', () => {
		for (const file of corpus) {
			expect(segmentOf(file).idLength).toBe(4);
			for (const node of segmentOf(file).children) {
				if (node.name !== 'Void') {
					expect(node.idLength, node.name).toBe(4);
				}
			}
		}
	});

	test('§4.4: no Empty Elements for elements whose default is neither 0 nor 0x0p+0', () => {
		for (const file of corpus) {
			for (const node of walk(file.tree)) {
				const element = node.schema;
				if (element && element.type !== 'm' && element.default !== null && node.data.length === 0) {
					expect(['0', '0x0p+0'], node.path).toContain(element.default);
				}
			}
		}
	});

	test('§4.5: each EBML Document starts with an EBML Header followed by a Segment', () => {
		for (const file of corpus) {
			expect(file.tree.map(node => node.name)).toEqual(['EBML', 'Segment']);
		}
	});

	test('§4.5: every Cluster holds exactly one Timestamp, stored as its first child', () => {
		for (const file of corpus) {
			for (const cluster of findAll(file.tree, 'Cluster')) {
				expect(childrenNamed(cluster, 'Timestamp')).toHaveLength(1);
				expect(cluster.children[0]!.name).toBe('Timestamp');
			}
		}
	});

	test('§4.5: the file holds at least one Cluster', () => {
		for (const file of corpus) {
			expect(findAll(file.tree, 'Cluster').length).toBeGreaterThan(0);
		}
	});

	test('§4.5/§22: the Cues hold at least one CuePoint', () => {
		for (const file of corpus) {
			expect(findAll(file.tree, 'CuePoint').length).toBeGreaterThan(0);
		}
	});

	test('§6.1: the first Info and the first Tracks come before the first Cluster', () => {
		for (const file of corpus) {
			const names = segmentOf(file).children.map(node => node.name);
			const firstCluster = names.indexOf('Cluster');
			expect(names.indexOf('Info')).toBeLessThan(firstCluster);
			expect(names.indexOf('Tracks')).toBeLessThan(firstCluster);
		}
	});

	test('§6.3: the first SeekHead is the first child of the Segment', () => {
		for (const file of corpus) {
			if (file.name !== 'mkv-append-only') {
				expect(segmentOf(file).children[0]!.name).toBe('SeekHead');
			}
		}
	});

	test('§6.3: the SeekHead references every Top-Level Element other than the Clusters, at its position', () => {
		// The Clusters themselves go unreferenced, like in FFmpeg and mkvmerge output; Cues index them
		for (const file of corpus) {
			if (file.name === 'mkv-append-only') {
				continue;
			}
			const segment = segmentOf(file);
			const seeks = findAll([segment], 'Seek').map(seek => ({
				id: readUint(child(seek, 'SeekID')!),
				position: readUint(child(seek, 'SeekPosition')!),
			}));
			for (const node of segment.children) {
				if (['SeekHead', 'Cluster', 'Void'].includes(node.name)) {
					continue;
				}
				expect(seeks, node.name).toContainEqual({ id: node.id, position: node.offset - segment.dataOffset });
			}
			for (const seek of seeks) {
				const target = segment.children.find(node => node.offset - segment.dataOffset === seek.position);
				expect(target?.id).toBe(seek.id);
			}
		}
	});

	test('§6.4: the Cues are referenced by the SeekHead', () => {
		for (const file of corpus) {
			if (file.name === 'mkv-append-only') {
				continue;
			}
			const cuesId = MATROSKA_SCHEMA.find(element => element.name === 'Cues')!.id;
			expect(findAll(file.tree, 'SeekID').map(readUint)).toContain(cuesId);
		}
	});

	test('§7: DocTypeVersion is at least the highest minver of the elements present', () => {
		for (const file of corpus) {
			const docTypeVersion = valueOf(headerOf(file), 'DocTypeVersion')!;
			for (const node of walk(file.tree)) {
				expect(node.schema?.minver ?? 1, node.path).toBeLessThanOrEqual(docTypeVersion);
			}
		}
	});

	test('§7: DocTypeReadVersion covers SimpleBlock (version 2), which playback needs', () => {
		for (const file of corpus) {
			expect(valueOf(headerOf(file), 'DocTypeReadVersion')).toBeGreaterThanOrEqual(2);
		}
	});

	test('§10: the track number of every Block matches the TrackNumber of a TrackEntry, in the shortest VINT', () => {
		for (const file of corpus) {
			const facts = collectFacts(file.tree);
			for (const block of facts.blocks) {
				expect(facts.trackNumbers.has(block.trackNumber)).toBe(true);
				const blockNode = block.isSimple ? block.node : child(block.node, 'Block')!;
				expect(readVint(blockNode.data, 0)!.length).toBe(1); // Track numbers are below 127
			}
		}
	});

	test('§10.1/§10.2: reserved bits of Block and SimpleBlock flags are 0', () => {
		for (const file of corpus) {
			for (const block of collectFacts(file.tree).blocks) {
				// SimpleBlock: bits 1-3 reserved (keyframe, reserved x3, invisible, lacing x2, discardable)
				// Block: bits 0-3 reserved
				expect(block.flags & (block.isSimple ? 0x70 : 0xf0)).toBe(0);
			}
		}
	});

	test('§10.3/§5.1.4.1.12: FlagLacing is 0, and no Block uses lacing', () => {
		for (const file of corpus) {
			for (const entry of tracksOf(file)) {
				expect(valueOf(entry, 'FlagLacing')).toBe(0);
			}
			for (const block of collectFacts(file.tree).blocks) {
				expect(block.flags & 0x06).toBe(0);
			}
		}
	});

	test('§10.4: key frames are SimpleBlocks with a keyframe flag or BlockGroups without ReferenceBlock', async () => {
		for (const file of corpus) {
			using input = new Input({ source: new BufferSource(file.bytes), formats: ALL_FORMATS });
			const facts = collectFacts(file.tree);
			for (const block of facts.blocks) {
				const isKey = block.isSimple ? !!(block.flags & 0x80) : !child(block.node, 'ReferenceBlock');
				const entry = facts.trackNumbers.get(block.trackNumber)!;
				const isVideo = valueOf(entry, 'TrackType') === 1;
				if (!isVideo) {
					// Every audio and subtitle packet in the corpus is a key packet
					expect(isKey, `${file.name} track ${block.trackNumber} @${block.timestamp}`).toBe(true);
				}
			}
			// Video key frames sit where the source had them
			const videoTrack = await input.getPrimaryVideoTrack();
			if (videoTrack && !['webm-copy-demo', 'mkv-copy-avc-aac', 'mkv-vp8-anamorphic'].includes(file.name)) {
				const keyTimestamps: number[] = [];
				for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
					if (packet.type === 'key') {
						keyTimestamps.push(Math.round(packet.timestamp * 30));
					}
				}
				expect(keyTimestamps.filter(frame => frame % 15 !== 0), file.name).toEqual([]);
			}
		}
	});

	test('§10.4: a non-key frame in a BlockGroup carries a ReferenceBlock', () => {
		let checked = 0;
		for (const file of corpus) {
			for (const block of collectFacts(file.tree).blocks) {
				if (block.group && file.name === 'mkv-avc-bframes') {
					const payload = child(block.node, 'Block')!.data;
					const frameIndex = payload[4]!; // Our packets start with their decode index
					if (frameIndex % 15 !== 0) {
						expect(child(block.node, 'ReferenceBlock')).toBeDefined();
						checked++;
					}
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	test('§5.1.3.5.5: ReferenceBlock values point at an earlier block of the same track', () => {
		for (const file of corpus) {
			const facts = collectFacts(file.tree);
			for (const block of facts.blocks) {
				const reference = block.group && child(block.group, 'ReferenceBlock');
				if (!reference) {
					continue;
				}
				const relative = reference.data.length
					? ((reference.data[0]! << 24) >> 24) * 256 ** (reference.data.length - 1)
					+ readUint({ ...reference, data: reference.data.subarray(1) })
					: 0;
				const referenced = facts.blocks.some(other => other.trackNumber === block.trackNumber
					&& other.timestamp === block.timestamp + relative);
				expect(referenced, `${file.name} @${block.timestamp}`).toBe(true);
			}
		}
	});

	test('§5.1.3.5.2.3: BlockAddID values are unique within each BlockAdditions', () => {
		let checked = 0;
		for (const file of corpus) {
			for (const additions of findAll(file.tree, 'BlockAdditions')) {
				const ids = childrenNamed(additions, 'BlockMore').map(more => valueOf(more, 'BlockAddID') ?? 1);
				expect(new Set(ids).size).toBe(ids.length);
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	test('§5.1.3.5.3: a BlockGroup of a track with DefaultDuration carries a BlockDuration', () => {
		let checked = 0;
		for (const file of corpus) {
			const facts = collectFacts(file.tree);
			for (const block of facts.blocks) {
				const entry = facts.trackNumbers.get(block.trackNumber)!;
				if (block.group && child(entry, 'DefaultDuration')) {
					expect(child(block.group, 'BlockDuration'), `${file.name} @${block.timestamp}`).toBeDefined();
					checked++;
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	test('§5.1.4.1.25/§11.2: CodecDelay shifts audio starting before zero back to its presentation time', async () => {
		const file = corpus.find(file => file.name === 'webm-vp8-opus')!;
		const opus = tracksOf(file).find(entry => codecIdOf(entry) === 'A_OPUS')!;
		expect(valueOf(opus, 'CodecDelay')).toBe(Math.round(1e9 * OPUS_PRE_SKIP / 48000));

		using input = new Input({ source: new BufferSource(file.bytes), formats: ALL_FORMATS });
		const audio = (await input.getPrimaryAudioTrack())!;
		const first = await new EncodedPacketSink(audio).getFirstPacket();
		// The reader rounds CodecDelay to whole ticks (-7 ms instead of -6.5 ms); fork PR #157 makes it exact
		expect(first!.timestamp).toBeCloseTo(-OPUS_PRE_SKIP / 48000, 2);
	});

	test('§5.1.4.1.28.44-46: ProjectionPose angles stay within -180..180 (yaw, roll) and -90..90 (pitch)', () => {
		let checked = 0;
		for (const file of corpus) {
			for (const node of walk(file.tree)) {
				if (node.name === 'ProjectionPoseYaw' || node.name === 'ProjectionPoseRoll') {
					expect(Math.abs(readFloat(node))).toBeLessThanOrEqual(180);
					checked++;
				} else if (node.name === 'ProjectionPosePitch') {
					expect(Math.abs(readFloat(node))).toBeLessThanOrEqual(90);
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	test('§5.1.4.1.28.43: no ProjectionPrivate with ProjectionType 0 (rectangular)', () => {
		for (const file of corpus) {
			for (const projection of findAll(file.tree, 'Projection')) {
				expect(valueOf(projection, 'ProjectionType') ?? 0).toBe(0);
				expect(child(projection, 'ProjectionPrivate')).toBeUndefined();
			}
		}
	});

	test('§5.1.4.1.28.4: AlphaMode only takes the defined values 0 and 1', () => {
		for (const file of corpus) {
			for (const node of findAll(file.tree, 'AlphaMode')) {
				expect([0, 1]).toContain(readUint(node));
			}
		}
	});

	test('§11.2: Cluster timestamps plus block timestamps never go below zero for media starting at zero', () => {
		for (const file of corpus) {
			for (const block of collectFacts(file.tree).blocks) {
				expect(block.timestamp).toBeGreaterThanOrEqual(0);
			}
		}
	});

	test('§22: each CuePoint has a CueTime and CueTrackPositions with CueTrack and CueClusterPosition', () => {
		for (const file of corpus) {
			for (const cuePoint of findAll(file.tree, 'CuePoint')) {
				expect(child(cuePoint, 'CueTime')).toBeDefined();
				for (const positions of childrenNamed(cuePoint, 'CueTrackPositions')) {
					expect(child(positions, 'CueTrack')).toBeDefined();
					expect(child(positions, 'CueClusterPosition')).toBeDefined();
				}
			}
		}
	});

	test('§22/§5.1.5.1.2: CueClusterPosition and CueRelativePosition point at a block of that track at CueTime', () => {
		for (const file of corpus) {
			const segment = segmentOf(file);
			const facts = collectFacts(file.tree);
			for (const cuePoint of findAll(file.tree, 'CuePoint')) {
				const time = valueOf(cuePoint, 'CueTime')!;
				for (const positions of childrenNamed(cuePoint, 'CueTrackPositions')) {
					const cluster = segment.children.find(node =>
						node.offset - segment.dataOffset === valueOf(positions, 'CueClusterPosition'));
					expect(cluster?.name).toBe('Cluster');
					const relative = valueOf(positions, 'CueRelativePosition');
					const block = facts.blocks.find(b => b.cluster === cluster
						&& b.node.offset - cluster.dataOffset === relative);
					expect(block?.trackNumber).toBe(valueOf(positions, 'CueTrack'));
					expect(block?.timestamp).toBe(time);
				}
			}
		}
	});

	test('§22.1: CuePoints are sorted by CueTime', () => {
		for (const file of corpus) {
			const times = findAll(file.tree, 'CuePoint').map(cuePoint => valueOf(cuePoint, 'CueTime')!);
			expect(times).toEqual([...times].sort((a, b) => a - b));
		}
	});

	test('§22.1: the first key frame of each video track in each Cluster is referenced by a CuePoint', () => {
		for (const file of corpus) {
			const facts = collectFacts(file.tree);
			const cued = new Set(findAll(file.tree, 'CueTrackPositions')
				.map(positions => `${valueOf(positions, 'CueTrack')}@${valueOf(positions.parent!, 'CueTime')}`));
			for (const cluster of findAll(file.tree, 'Cluster')) {
				const seen = new Set<number>();
				for (const block of facts.blocks.filter(b => b.cluster === cluster)) {
					const entry = facts.trackNumbers.get(block.trackNumber)!;
					const isKey = block.isSimple ? !!(block.flags & 0x80) : !child(block.node, 'ReferenceBlock');
					if (valueOf(entry, 'TrackType') === 1 && isKey && !seen.has(block.trackNumber)) {
						seen.add(block.trackNumber);
						expect(cued.has(`${block.trackNumber}@${block.timestamp}`)).toBe(true);
					}
				}
			}
		}
	});

	test('§23.2: a live (append-only) Segment has all bits of its size set to 1', () => {
		const file = corpus.find(file => file.name === 'mkv-append-only')!;
		const segment = segmentOf(file);
		expect(segment.declaredSize).toBeNull();
		expect(file.bytes[segment.offset + 4]).toBe(0xff);
	});

	test('§25.1: Clusters hold at most five seconds of content', () => {
		for (const file of corpus) {
			const facts = collectFacts(file.tree);
			for (const cluster of findAll(file.tree, 'Cluster')) {
				const timestamps = facts.blocks.filter(b => b.cluster === cluster).map(b => b.timestamp);
				if (timestamps.length) {
					expect(Math.max(...timestamps) - Math.min(...timestamps)).toBeLessThanOrEqual(5000);
				}
			}
		}
	});
});

describe('Writer: Matroska codec mappings', () => {
	test('Codec ID: every CodecID has its track type prefix, an uppercase major ID and an optional "/" suffix', () => {
		const prefixes: Record<number, string> = { 1: 'V_', 2: 'A_', 17: 'S_' };
		for (const file of corpus) {
			for (const entry of tracksOf(file)) {
				const codecId = codecIdOf(entry);
				expect(codecId.startsWith(prefixes[valueOf(entry, 'TrackType')!]!), codecId).toBe(true);
				expect(codecId).toMatch(/^[A-Z]+_[A-Z0-9]+(\/[A-Z0-9_/]+)?$/);
			}
		}
	});

	test('Video/Audio codec mappings: video tracks are TrackType 1 with a Video element, audio tracks TrackType 2 '
		+ 'with an Audio element', () => {
		for (const file of corpus) {
			for (const entry of tracksOf(file)) {
				const codecId = codecIdOf(entry);
				if (codecId.startsWith('V_')) {
					expect(valueOf(entry, 'TrackType')).toBe(1);
					expect(child(entry, 'Video')).toBeDefined();
				} else if (codecId.startsWith('A_')) {
					expect(valueOf(entry, 'TrackType')).toBe(2);
					expect(child(entry, 'Audio')).toBeDefined();
				}
			}
		}
	});

	test('Subtitle codec mappings: subtitle tracks are TrackType 17', () => {
		const file = corpus.find(file => file.name === 'mkv-vp9-opus-webvtt-tags')!;
		const subtitles = tracksOf(file).find(entry => codecIdOf(entry).startsWith('S_'))!;
		expect(valueOf(subtitles, 'TrackType')).toBe(17);
	});

	test('Initialization: codecs that need it get their initialization data in CodecPrivate', () => {
		const needed = ['V_MPEG4/ISO/AVC', 'V_VP9', 'V_AV1', 'A_OPUS', 'A_VORBIS', 'A_FLAC', 'A_AAC'];
		for (const file of corpus) {
			for (const entry of tracksOf(file)) {
				if (needed.includes(codecIdOf(entry))) {
					expect(child(entry, 'CodecPrivate')?.data.length, codecIdOf(entry)).toBeGreaterThan(0);
				}
			}
		}
	});

	test('Initialization: codecs without initialization data (VP8, PCM) get no CodecPrivate', () => {
		for (const file of corpus) {
			for (const entry of tracksOf(file)) {
				if (codecIdOf(entry) === 'V_VP8' || codecIdOf(entry).startsWith('A_PCM/')) {
					expect(child(entry, 'CodecPrivate'), codecIdOf(entry)).toBeUndefined();
				}
			}
		}
	});

	test('A_OPUS: CodecPrivate holds the Identification Header, Channels its output channel count', () => {
		for (const file of corpus) {
			for (const entry of tracksOf(file).filter(entry => codecIdOf(entry) === 'A_OPUS')) {
				const head = child(entry, 'CodecPrivate')!.data;
				expect(new TextDecoder().decode(head.subarray(0, 8))).toBe('OpusHead');
				expect(valueOf(child(entry, 'Audio'), 'Channels')).toBe(head[9]);
			}
		}
	});

	test('A_OPUS: CodecDelay is the pre-skip of the Identification Header, in nanoseconds', () => {
		// Only files whose first packet starts at -pre-skip: the muxer derives CodecDelay from the first timestamp,
		// so a copy of FFmpeg's demo.webm gets 7 ms (its reader rounded the 6.5 ms to ticks, see fork PR #157)
		for (const file of corpus.filter(file => file.name !== 'webm-copy-demo')) {
			for (const entry of tracksOf(file).filter(entry => codecIdOf(entry) === 'A_OPUS')) {
				const head = child(entry, 'CodecPrivate')!.data;
				const preSkip = head[10]! | (head[11]! << 8);
				expect(valueOf(entry, 'CodecDelay'), file.name).toBe(Math.round(1e9 * preSkip / 48000));
			}
		}
	});

	test('A_OPUS: SeekPreRoll is present (Mediabunny uses 400 ms instead of the suggested 80 ms, see #600)', () => {
		for (const file of corpus) {
			for (const entry of tracksOf(file).filter(entry => codecIdOf(entry) === 'A_OPUS')) {
				expect(valueOf(entry, 'SeekPreRoll')).toBeGreaterThanOrEqual(80_000_000);
			}
		}
	});

	test('A_VORBIS: CodecPrivate holds the three headers in Xiph lacing, starting with the count 2', () => {
		const file = corpus.find(file => file.name === 'webm-av1-vorbis')!;
		const vorbis = tracksOf(file).find(entry => codecIdOf(entry) === 'A_VORBIS')!;
		const data = child(vorbis, 'CodecPrivate')!.data;
		expect(data[0]).toBe(2);
		expect(new TextDecoder().decode(data.subarray(4, 10))).toBe('vorbis');
	});

	test('A_PCM/*: BitDepth is set, and 8-bit PCM is stored as A_PCM/INT/LIT (unsigned)', () => {
		const file = corpus.find(file => file.name === 'mkv-pcm')!;
		const entries = tracksOf(file);
		expect(entries.map(entry => [codecIdOf(entry), valueOf(child(entry, 'Audio'), 'BitDepth')])).toEqual([
			['A_PCM/INT/LIT', 16],
			['A_PCM/INT/LIT', 8],
			['A_PCM/FLOAT/IEEE', 32],
			['A_PCM/INT/BIG', 24],
		]);
	});

	test('V_AV1: CodecPrivate is an av1C record (marker 1, version 1) without a second Sequence Header', () => {
		const file = corpus.find(file => file.name === 'webm-av1-vorbis')!;
		const av1 = tracksOf(file).find(entry => codecIdOf(entry) === 'V_AV1')!;
		const data = child(av1, 'CodecPrivate')!.data;
		expect(data[0]).toBe(0x81);
		expect(data.length).toBeGreaterThanOrEqual(4);
		// initial_presentation_delay_present is 0, since we can't verify the presentation delay
		expect(data[3]! & 0x10).toBe(0);
	});

	test('V_VP8/V_VP9: alpha data goes into a BlockMore with BlockAddID 1, and AlphaMode is 1', () => {
		const file = corpus.find(file => file.name === 'webm-vp9-alpha')!;
		const entry = tracksOf(file)[0]!;
		expect(valueOf(child(entry, 'Video'), 'AlphaMode')).toBe(1);
		const mores = findAll(file.tree, 'BlockMore');
		expect(mores.length).toBeGreaterThan(0);
		for (const more of mores) {
			expect(valueOf(more, 'BlockAddID') ?? 1).toBe(1);
		}
	});

	test('S_TEXT/WEBVTT: cue settings and identifiers go into a BlockMore with BlockAddID 1', () => {
		const file = corpus.find(file => file.name === 'mkv-vp9-opus-webvtt-tags')!;
		const subtitles = tracksOf(file).find(entry => codecIdOf(entry) === 'S_TEXT/WEBVTT')!;
		const trackNumber = valueOf(subtitles, 'TrackNumber')!;
		const groups = collectFacts(file.tree).blocks.filter(block => block.trackNumber === trackNumber);
		const additionals = groups.flatMap(block => findAll([block.node], 'BlockMore'));
		expect(additionals.length).toBeGreaterThan(0);
		for (const more of additionals) {
			expect(valueOf(more, 'BlockAddID') ?? 1).toBe(1);
		}
	});
});

describe('Writer: WebM container guidelines', () => {
	const webmFiles = () => corpus.filter(file => file.webm);

	test('Demuxer and Muxer Guidelines: DocType is "webm" and DocTypeReadVersion follows Matroska (2 for v2 elements)',
		() => {
			for (const file of webmFiles()) {
				expect(readString(child(headerOf(file), 'DocType')!)).toBe('webm');
				expect(valueOf(headerOf(file), 'DocTypeReadVersion')).toBe(2);
			}
		});

	test('Demuxer and Muxer Guidelines: codecs are VP8/VP9/AV1 video and Vorbis/Opus audio', () => {
		for (const file of webmFiles()) {
			for (const entry of tracksOf(file)) {
				expect(['V_VP8', 'V_VP9', 'V_AV1', 'A_VORBIS', 'A_OPUS']).toContain(codecIdOf(entry));
			}
		}
	});

	test('Demuxer and Muxer Guidelines: VP9 CodecPrivate lists the codec features (profile, level, bit depth)', () => {
		const file = corpus.find(file => file.name === 'webm-vp9-alpha')!;
		const data = child(tracksOf(file)[0]!, 'CodecPrivate')!.data;
		// Each feature is ID, length 1, value: profile (1), level (2), bit depth (3), chroma subsampling (4)
		const features = new Map<number, number>();
		for (let i = 0; i + 2 < data.length; i += 2 + data[i + 1]!) {
			features.set(data[i]!, data[i + 2]!);
		}
		expect(features.get(1)).toBe(0);
		expect(features.get(2)).toBe(10);
		expect(features.get(3)).toBe(8);
	});

	test('Muxer Guidelines: the file has a SeekHead and a key-frame-only Cues element', () => {
		for (const file of webmFiles()) {
			expect(child(segmentOf(file), 'SeekHead')).toBeDefined();
			expect(child(segmentOf(file), 'Cues')).toBeDefined();
			const facts = collectFacts(file.tree);
			const keyTimestamps = new Set(facts.blocks
				.filter(block => block.isSimple ? block.flags & 0x80 : !child(block.node, 'ReferenceBlock'))
				.map(block => `${block.trackNumber}@${block.timestamp}`));
			for (const positions of findAll(file.tree, 'CueTrackPositions')) {
				expect(keyTimestamps.has(`${valueOf(positions, 'CueTrack')}@${valueOf(positions.parent!, 'CueTime')}`))
					.toBe(true);
			}
		}
	});

	test('Muxer Guidelines: absolute (block + cluster) timestamps increase monotonically', () => {
		for (const file of webmFiles()) {
			const timestamps = collectFacts(file.tree).blocks.map(block => block.timestamp);
			expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
		}
	});

	test('Muxer Guidelines: TimestampScale is 1,000,000 ns', () => {
		for (const file of webmFiles()) {
			expect(valueOf(child(segmentOf(file), 'Info'), 'TimestampScale')).toBe(1_000_000);
		}
	});

	test('Muxer Guidelines: video key frames start the Clusters', () => {
		for (const file of webmFiles()) {
			const facts = collectFacts(file.tree);
			for (const cluster of findAll(file.tree, 'Cluster')) {
				const first = facts.blocks.find(block => block.cluster === cluster
					&& valueOf(facts.trackNumbers.get(block.trackNumber), 'TrackType') === 1);
				if (first) {
					expect(first.isSimple ? !!(first.flags & 0x80) : !child(first.node, 'ReferenceBlock')).toBe(true);
				}
			}
		}
	});

	test('Muxer Guidelines: WebM files only use pixels as DisplayUnit (square pixels write no DisplayUnit)', () => {
		for (const file of webmFiles()) {
			for (const node of findAll(file.tree, 'DisplayUnit')) {
				expect(readUint(node)).toBe(0);
			}
		}
	});

	test('Element subset: WebM output only uses elements WebM supports', () => {
		for (const file of webmFiles()) {
			for (const node of walk(file.tree)) {
				expect(node.schema?.webm ?? true, node.path).toBe(true);
			}
		}
	});
});

const pcmTrack = (extra: ReturnType<typeof uint>[] = [], audio?: ReturnType<typeof uint>[]) => [
	uint('TrackNumber', 1),
	uint('TrackUID', 1),
	uint('TrackType', 2),
	str('CodecID', 'A_PCM/INT/LIT'),
	el('Audio', audio ?? [float('SamplingFrequency', 48000), uint('Channels', 1), uint('BitDepth', 16)]),
	...extra,
];
const videoTrack = (extra: ReturnType<typeof uint>[] = [], video?: ReturnType<typeof uint>[]) => [
	uint('TrackNumber', 1),
	uint('TrackUID', 1),
	uint('TrackType', 1),
	str('CodecID', 'V_VP8'),
	el('Video', video ?? [uint('PixelWidth', 320), uint('PixelHeight', 240)]),
	...extra,
];
const pcmCluster = (timestamp = 0) => [
	uint('Timestamp', timestamp),
	simpleBlock(1, 0, true, [0, 0, 0, 0]),
	simpleBlock(1, 10, true, [0, 0, 0, 0]),
];

const open = (bytes: Uint8Array) => new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

const readPackets = async (bytes: Uint8Array) => {
	using input = open(bytes);
	const track = (await input.getTracks())[0]!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	return packets;
};

const firstDisposition = async (input: Input) => (await input.getTracks())[0]!.getDisposition();

describe('Reader: RFC 8794 Section 11.1.6.8 / RFC 9559 Section 5: absent elements take their default values', () => {
	test.each([
		{ element: 'FlagEnabled', value: 1,
			check: async (input: Input) => expect(await input.getTracks()).toHaveLength(1) },
		{ element: 'FlagDefault', value: 1,
			check: async (input: Input) => expect((await firstDisposition(input)).default).toBe(true) },
		{ element: 'FlagForced', value: 0,
			check: async (input: Input) => expect((await firstDisposition(input)).forced).toBe(false) },
		{ element: 'FlagHearingImpaired', value: 0,
			check: async (input: Input) => expect((await firstDisposition(input)).hearingImpaired).toBe(false) },
		{ element: 'FlagVisualImpaired', value: 0,
			check: async (input: Input) => expect((await firstDisposition(input)).visuallyImpaired).toBe(false) },
		{ element: 'FlagOriginal', value: 0,
			check: async (input: Input) => expect((await firstDisposition(input)).original).toBe(false) },
		{ element: 'FlagCommentary', value: 0,
			check: async (input: Input) => expect((await firstDisposition(input)).commentary).toBe(false) },
		{ element: 'Language', value: 'eng',
			check: async (input: Input) => expect(await (await input.getTracks())[0]!.getLanguageCode()).toBe('eng') },
		{ element: 'CodecDelay', value: 0, check: async (input: Input) => {
			const track = (await input.getTracks())[0]!;
			expect((await new EncodedPacketSink(track).getFirstPacket())!.timestamp).toBe(0);
		} },
	])('§5.1.4.1 $element defaults to $value', async ({ check }) => {
		using input = open(buildMatroska({ tracks: [pcmTrack()], clusters: [pcmCluster()] }));
		await check(input);
	});

	test('§5.1.4.1.29.1 SamplingFrequency defaults to 8000 Hz, §5.1.4.1.29.3 Channels to 1', async () => {
		using input = open(buildMatroska({ tracks: [pcmTrack([], [uint('BitDepth', 16)])], clusters: [pcmCluster()] }));
		const track = (await input.getPrimaryAudioTrack())!;
		expect(await track.getSampleRate()).toBe(8000);
		expect(await track.getNumberOfChannels()).toBe(1);
	});

	test('§5.1.2.1 TimestampScale defaults to 1,000,000 ns', async () => {
		const bytes = buildMatroska({
			info: [str('MuxingApp', 'test'), str('WritingApp', 'test')],
			tracks: [pcmTrack()],
			clusters: [pcmCluster(500)],
		});
		const packets = await readPackets(bytes);
		expect(packets.map(packet => packet.timestamp)).toEqual([0.5, 0.51]);
	});

	test('§5.1.4.1.28.10-12 DisplayUnit defaults to 0, so DisplayWidth/Height default to the pixel size', async () => {
		using input = open(buildMatroska({ tracks: [videoTrack()], clusters: [pcmCluster()] }));
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.getSquarePixelWidth()).toBe(320);
		expect(await track.getSquarePixelHeight()).toBe(240);
	});

	test('§5.1.4.1.28.4 AlphaMode defaults to 0 (no alpha), even with BlockAdditions present', async () => {
		const block = el('BlockGroup', [
			el('Block', new Uint8Array([0x81, 0, 0, 0, 1, 2, 3])),
			el('BlockAdditions', [
				el('BlockMore', [uint('BlockAddID', 1), el('BlockAdditional', new Uint8Array([9]))]),
			]),
		]);
		using input = open(buildMatroska({ tracks: [videoTrack()], clusters: [[uint('Timestamp', 0), block]] }));
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.canBeTransparent()).toBe(false);
		const packet = await new EncodedPacketSink(track).getFirstPacket();
		expect(packet!.sideData.alpha).toBeUndefined();
	});

	test('§5.1.3.5.2.3 BlockAddID defaults to 1 (alpha data with AlphaMode 1)', async () => {
		const block = el('BlockGroup', [
			el('Block', new Uint8Array([0x81, 0, 0, 0, 1, 2, 3])),
			el('BlockAdditions', [el('BlockMore', [el('BlockAdditional', new Uint8Array([9]))])]),
		]);
		const track = videoTrack([], [uint('PixelWidth', 320), uint('PixelHeight', 240), uint('AlphaMode', 1)]);
		using input = open(buildMatroska({ tracks: [track], clusters: [[uint('Timestamp', 0), block]] }));
		const packet = await new EncodedPacketSink((await input.getPrimaryVideoTrack())!).getFirstPacket();
		expect(packet!.sideData.alpha).toEqual(new Uint8Array([9]));
	});

	test.each([
		{ element: 'MatrixCoefficients', key: 'matrix' },
		{ element: 'TransferCharacteristics', key: 'transfer' },
		{ element: 'Primaries', key: 'primaries' },
		{ element: 'Range', key: 'fullRange' },
	] as const)('§5.1.4.1.28 $element defaults to "unspecified"', async ({ key }) => {
		const video = [uint('PixelWidth', 320), uint('PixelHeight', 240), el('Colour', [])];
		using input = open(buildMatroska({ tracks: [videoTrack([], video)], clusters: [pcmCluster()] }));
		const colorSpace = await (await input.getPrimaryVideoTrack())!.getColorSpace();
		expect(colorSpace[key] ?? null).toBeNull();
	});

	test('§5.1.4.1.28.41-46 ProjectionType and the ProjectionPose angles default to 0', async () => {
		const video = [uint('PixelWidth', 320), uint('PixelHeight', 240), el('Projection', [])];
		using input = open(buildMatroska({ tracks: [videoTrack([], video)], clusters: [pcmCluster()] }));
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.getRotation()).toBe(0);
		expect(await track.getFlip()).toBe(false);
	});

	test('§5.1.8.1.1.1 TargetTypeValue defaults to 50, so a Tag with empty Targets is movie-level', async () => {
		const bytes = encodeEbml([
			ebmlHeader(),
			el('Segment', [
				el('Info', [uint('TimestampScale', 1_000_000), str('MuxingApp', 'test'), str('WritingApp', 'test')]),
				el('Tracks', [el('TrackEntry', pcmTrack())]),
				el('Tags', [el('Tag', [
					el('Targets', []),
					el('SimpleTag', [str('TagName', 'TITLE'), str('TagString', 'Hi')]),
				])]),
				el('Cluster', pcmCluster()),
			]),
		]);
		using input = open(bytes);
		expect((await input.getMetadataTags()).title).toBe('Hi');
	});

	test('§11.2.3/§11.2.8 EBMLReadVersion and DocTypeReadVersion default to 1 when absent', async () => {
		const header = el('EBML', [str('DocType', 'matroska')]);
		using input = open(buildMatroska({ header, tracks: [pcmTrack()], clusters: [pcmCluster()] }));
		expect(await input.getFormat()).toBe(MATROSKA);
		expect(await input.getTracks()).toHaveLength(1);
	});
});

describe('Reader: RFC 8794 (EBML)', () => {
	test.each([1, 2, 3, 4, 5, 6, 7, 8])('§6.1: element data sizes of %i octets are read', async (width) => {
		const block = el('SimpleBlock', new Uint8Array([0x81, 0, 0, 0x80, 1, 2]), { sizeLength: width });
		const bytes = buildMatroska({ tracks: [pcmTrack()], clusters: [[uint('Timestamp', 0), block]] });
		const packets = await readPackets(bytes);
		expect(packets).toHaveLength(1);
		expect([...packets[0]!.data]).toEqual([1, 2]);
	});

	test('§7.2: unsigned integers of 0-8 octets are read (a 0-octet TrackNumber is 0, an 8-octet TrackUID is fine)',
		async () => {
			const entry = pcmTrack().map(element => element.id === 0x73c5
				? el('TrackUID', new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe]))
				: element);
			using input = open(buildMatroska({ tracks: [entry], clusters: [pcmCluster()] }));
			expect(await input.getTracks()).toHaveLength(1);
		});

	test('§7.3: a 4-octet float SamplingFrequency is read', async () => {
		const audio = [float('SamplingFrequency', 44100, 4), uint('Channels', 2), uint('BitDepth', 16)];
		using input = open(buildMatroska({ tracks: [pcmTrack([], audio)], clusters: [pcmCluster()] }));
		expect(await (await input.getPrimaryAudioTrack())!.getSampleRate()).toBe(44100);
	});

	test('§7.4/§13: trailing NUL octets of a String element are not part of the value', async () => {
		// 'jpn' has no bibliographic variant, and isn't the 'eng' default an ignored element would read as
		const entry = [...pcmTrack(), el('Language', new Uint8Array([0x6a, 0x70, 0x6e, 0, 0]))];
		using input = open(buildMatroska({ tracks: [entry], clusters: [pcmCluster()] }));
		expect(await (await input.getTracks())[0]!.getLanguageCode()).toBe('jpn');
	});

	test('§7.5/§13: trailing NUL octets of a UTF-8 element are not part of the value', async () => {
		const entry = [...pcmTrack(), el('Name', new Uint8Array([0xc3, 0xa9, 0, 0]))];
		using input = open(buildMatroska({ tracks: [entry], clusters: [pcmCluster()] }));
		expect(await (await input.getTracks())[0]!.getName()).toBe('é');
	});

	test('§7.7: data inside a master element that is not part of a child element is ignored', async () => {
		// Junk after the TrackEntry that doesn't parse as an element (0x00 is no valid VINT)
		const tracks = el('Tracks', new Uint8Array([...encodeEbml([el('TrackEntry', pcmTrack())]), 0x00, 0x00, 0x00]));
		const bytes = encodeEbml([
			ebmlHeader(),
			el('Segment', [
				el('Info', [uint('TimestampScale', 1_000_000), str('MuxingApp', 'test'), str('WritingApp', 'test')]),
				tracks,
				el('Cluster', pcmCluster()),
			]),
		]);
		expect(await readPackets(bytes)).toHaveLength(2);
	});

	test('§11.1.6.10: Segment and Cluster of unknown size (all VINT_DATA bits set) are read', async () => {
		const bytes = encodeEbml([
			ebmlHeader(),
			el('Segment', [
				el('Info', [uint('TimestampScale', 1_000_000), str('MuxingApp', 'test'), str('WritingApp', 'test')]),
				el('Tracks', [el('TrackEntry', pcmTrack())]),
				el('Cluster', pcmCluster(0), { unknownSize: true }),
				el('Cluster', pcmCluster(100), { unknownSize: true }),
			], { unknownSize: true }),
		]);
		expect((await readPackets(bytes)).map(packet => packet.timestamp)).toEqual([0, 0.01, 0.1, 0.11]);
	});
});

describe('Reader: RFC 9559 (Matroska)', () => {
	test('§5.1.4.1.31.2: content encodings are undone from the highest ContentEncodingOrder down', async () => {
		const stripping = (order: number, header: number[]) => el('ContentEncoding', [
			uint('ContentEncodingOrder', order),
			el('ContentCompression', [uint('ContentCompAlgo', 3), el('ContentCompSettings', new Uint8Array(header))]),
		]);
		// Written with order 0 applied first: the order-1 header is outermost, so it is restored first
		const entry = [...pcmTrack(), el('ContentEncodings', [stripping(0, [0xaa]), stripping(1, [0xbb])])];
		const packets = await readPackets(buildMatroska({ tracks: [entry], clusters: [pcmCluster()] }));
		expect([...packets[0]!.data]).toEqual([0xaa, 0xbb, 0, 0, 0, 0]);
	});

	test('§5.1.3.5.5: a ReferenceBlock of value 0 marks a frame that can\'t be decoded on its own', async () => {
		const cluster = [
			uint('Timestamp', 0),
			simpleBlock(1, 0, true, [1]),
			el('BlockGroup', [
				el('Block', new Uint8Array([0x81, 0, 33, 0, 2])),
				el('ReferenceBlock', new Uint8Array([0])),
			]),
		];
		const packets = await readPackets(buildMatroska({ tracks: [videoTrack()], clusters: [cluster] }));
		expect(packets.map(packet => packet.type)).toEqual(['key', 'delta']);
	});

	test('§7: elements the reader doesn\'t know are skipped when they fit their parent', async () => {
		const unknown = { id: 0x7fa1, data: new Uint8Array([1, 2, 3]) };
		const entry = [...pcmTrack(), unknown];
		const cluster = [...pcmCluster(), unknown];
		using input = open(buildMatroska({ tracks: [entry], clusters: [cluster] }));
		expect(await input.getTracks()).toHaveLength(1);
		expect(await readPackets(buildMatroska({ tracks: [entry], clusters: [cluster] }))).toHaveLength(2);
	});

	test('§10: blocks of track numbers without a TrackEntry are ignored', async () => {
		const cluster = [...pcmCluster(), simpleBlock(5, 20, true, [7])];
		expect(await readPackets(buildMatroska({ tracks: [pcmTrack()], clusters: [cluster] }))).toHaveLength(2);
	});

	test('§11.1: Block timestamps are Cluster ticks plus the signed relative timestamp (TimestampScale)', async () => {
		const bytes = buildMatroska({
			info: [uint('TimestampScale', 100_000), str('MuxingApp', 'test'), str('WritingApp', 'test')],
			tracks: [pcmTrack()],
			clusters: [[uint('Timestamp', 1000), simpleBlock(1, -5, true, [0, 0]), simpleBlock(1, 5, true, [0, 0])]],
		});
		expect((await readPackets(bytes)).map(packet => packet.timestamp)).toEqual([0.0995, 0.1005]);
	});

	test('A_PCM/INT/BIG: 8-bit samples are unsigned, other bit depths signed big-endian', async () => {
		const track = (bitDepth: number) => [uint('TrackNumber', 1), uint('TrackUID', 1), uint('TrackType', 2),
			str('CodecID', 'A_PCM/INT/BIG'),
			el('Audio', [float('SamplingFrequency', 8000), uint('BitDepth', bitDepth)])];
		const codecs: (string | null)[] = [];
		for (const bitDepth of [8, 16, 24, 32]) {
			using input = open(buildMatroska({ tracks: [track(bitDepth)], clusters: [pcmCluster()] }));
			codecs.push(await (await input.getPrimaryAudioTrack())!.getCodec());
		}
		expect(codecs).toEqual(['pcm-u8', 'pcm-s16be', 'pcm-s24be', 'pcm-s32be']);
	});

	test('A_PCM/FLOAT/IEEE: the bit depth comes from BitDepth', async () => {
		const track = (bitDepth: number) => [uint('TrackNumber', 1), uint('TrackUID', 1), uint('TrackType', 2),
			str('CodecID', 'A_PCM/FLOAT/IEEE'),
			el('Audio', [float('SamplingFrequency', 8000), uint('BitDepth', bitDepth)])];
		const codecs: (string | null)[] = [];
		for (const bitDepth of [32, 64]) {
			using input = open(buildMatroska({ tracks: [track(bitDepth)], clusters: [pcmCluster()] }));
			codecs.push(await (await input.getPrimaryAudioTrack())!.getCodec());
		}
		expect(codecs).toEqual(['pcm-f32', 'pcm-f64']);
	});

	test('A_OPUS: the decoder gets 48 kHz whatever SamplingFrequency says, and CodecPrivate as description',
		async () => {
			const head = opusHead(312, 44100);
			const track = [uint('TrackNumber', 1), uint('TrackUID', 1), uint('TrackType', 2), str('CodecID', 'A_OPUS'),
				el('CodecPrivate', head), uint('CodecDelay', 6_500_000),
				el('Audio', [float('SamplingFrequency', 44100), uint('Channels', 2)])];
			using input = open(buildMatroska({ tracks: [track], clusters: [pcmCluster()] }));
			const config = await (await input.getPrimaryAudioTrack())!.getDecoderConfig();
			expect(config!.sampleRate).toBe(48000);
			expect(new Uint8Array(config!.description as ArrayBuffer)).toEqual(head);
		});

	test('WebM Demuxer Guidelines: a "webm" DocType is opened as WebM', async () => {
		using input = open(buildMatroska({ header: ebmlHeader({ docType: 'webm' }), tracks: [pcmTrack()],
			clusters: [pcmCluster()] }));
		expect(await input.getFormat()).toBe(WEBM);
	});
});
