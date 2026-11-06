import { beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	AdtsOutputFormat,
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	CmafOutputFormat,
	CustomPathedSource,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	HlsOutputFormat,
	HlsOutputFormatOptions,
	Input,
	InputAudioTrack,
	InputVideoTrack,
	MpegTsOutputFormat,
	Output,
	PathedTarget,
} from '../../src/index.js';

// Normative compliance of Mediabunny's HLS writer and reader with RFC 8216, one test per checked statement. Test names
// start with the clause they check.

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// --- Playlist parsing ---

type Tag = { name: string; value: string; attributes: Map<string, string> | null; line: number };
type Playlist = { text: string; lines: string[]; tags: Tag[]; uris: { uri: string; line: number }[] };

const parseAttributes = (value: string) => {
	const attributes = new Map<string, string>();
	const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)(,|$)/gy;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(value)) && match[0] !== '') {
		attributes.set(match[1]!, match[2]!);
		if (match[3] === '') {
			break;
		}
	}
	return attributes;
};

const ATTRIBUTE_TAGS = ['EXT-X-MEDIA', 'EXT-X-STREAM-INF', 'EXT-X-I-FRAME-STREAM-INF', 'EXT-X-MAP', 'EXT-X-KEY'];

const parsePlaylist = (text: string): Playlist => {
	const lines = text.split('\n');
	const tags: Tag[] = [];
	const uris: Playlist['uris'] = [];
	lines.forEach((line, index) => {
		if (line.startsWith('#EXT')) {
			const colon = line.indexOf(':');
			const name = line.slice(1, colon === -1 ? undefined : colon);
			const value = colon === -1 ? '' : line.slice(colon + 1);
			const attributes = ATTRIBUTE_TAGS.includes(name) ? parseAttributes(value) : null;
			tags.push({ name, value, attributes, line: index });
		} else if (line !== '' && !line.startsWith('#')) {
			uris.push({ uri: line, line: index });
		}
	});
	return { text, lines, tags, uris };
};

const tagsNamed = (playlist: Playlist, name: string) => playlist.tags.filter(tag => tag.name === name);
const unquote = (value: string | undefined) => value?.replace(/^"|"$/g, '');

// --- Output corpus ---

type HlsOutputFiles = { files: Map<string, Uint8Array>; playlistVersions: Map<string, string[]> };

const collectOutput = async (
	options: Omit<HlsOutputFormatOptions, 'segmentFormat'> & { segmentFormat: HlsOutputFormatOptions['segmentFormat'] },
	setup: (output: Output) => Promise<() => Promise<void>>,
): Promise<HlsOutputFiles> => {
	const targets = new Map<string, BufferTarget>();
	const playlistVersions = new Map<string, string[]>();
	let currentPlaylistPath: string | null = null;
	const output = new Output({
		format: new HlsOutputFormat({
			...options,
			onPlaylist: (text, info) => {
				currentPlaylistPath = `playlist-${info.n}.m3u8`;
				if (!playlistVersions.has(currentPlaylistPath)) {
					playlistVersions.set(currentPlaylistPath, []);
				}
				playlistVersions.get(currentPlaylistPath)!.push(text);
			},
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);
			return target;
		}),
	});
	const run = await setup(output);
	await output.start();
	await run();
	await output.finalize();

	const files = new Map<string, Uint8Array>();
	for (const [filePath, target] of targets) {
		files.set(filePath, new Uint8Array(target.buffer!));
	}
	return { files, playlistVersions };
};

const packetsOf = async (fileName: string) => {
	const filePath = path.join(__dirname, '../public', fileName);
	const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
	const video = await input.getPrimaryVideoTrack();
	const audio = await input.getPrimaryAudioTrack();
	const read = async (track: InputVideoTrack | InputAudioTrack | null) => {
		if (!track) {
			return null;
		}
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			if (packet.timestamp >= 6) {
				break;
			}
			packets.push(packet);
		}
		return { packets, codec: (await track.getCodec())!, decoderConfig: (await track.getDecoderConfig())! };
	};
	const result = { video: await read(video), audio: await read(audio) };
	input.dispose();
	return result;
};

type Media = Awaited<ReturnType<typeof packetsOf>>;

const addTracks = (output: Output, media: Media, options: {
	audioCopies?: { languageCode: string; name: string; primary?: boolean }[];
	videoMetadata?: object;
	unixBase?: number;
	keyFramesOnly?: boolean;
} = {}) => {
	const runs: (() => Promise<void>)[] = [];
	const offset = options.unixBase ?? 0;
	const relative = options.unixBase !== undefined ? { isRelativeToUnixEpoch: true } : {};

	if (media.video) {
		const video = media.video;
		const source = new EncodedVideoPacketSource(video.codec as 'avc');
		output.addVideoTrack(source, { frameRate: 24, ...relative, ...options.videoMetadata });
		runs.push(async () => {
			let first = true;
			for (const packet of video.packets) {
				await source.add(packet.clone({ timestamp: packet.timestamp + offset }),
					first ? { decoderConfig: video.decoderConfig as VideoDecoderConfig } : undefined);
				first = false;
			}
		});

		if (options.keyFramesOnly) {
			const iframes = new EncodedVideoPacketSource(video.codec as 'avc');
			output.addVideoTrack(iframes, { hasOnlyKeyPackets: true, ...relative });
			runs.push(async () => {
				let first = true;
				for (const packet of video.packets.filter(packet => packet.type === 'key')) {
					await iframes.add(packet.clone({ timestamp: packet.timestamp + offset }),
						first ? { decoderConfig: video.decoderConfig as VideoDecoderConfig } : undefined);
					first = false;
				}
			});
		}
	}

	if (media.audio) {
		const audio = media.audio;
		for (const copy of options.audioCopies ?? [null]) {
			const source = new EncodedAudioPacketSource(audio.codec as 'aac');
			output.addAudioTrack(source, copy
				? {
						languageCode: copy.languageCode,
						name: copy.name,
						disposition: { primary: !!copy.primary },
						...relative,
					}
				: relative);
			runs.push(async () => {
				let first = true;
				for (const packet of audio.packets) {
					await source.add(packet.clone({ timestamp: packet.timestamp + offset }),
						first ? { decoderConfig: audio.decoderConfig as AudioDecoderConfig } : undefined);
					first = false;
				}
			});
		}
	}

	return async () => {
		await Promise.all(runs.map(run => run()));
	};
};

type CorpusEntry = HlsOutputFiles & { name: string; live: boolean };
let corpus: CorpusEntry[] = [];

const decoder = new TextDecoder();
const playlistsOf = (entry: CorpusEntry) => [...entry.files]
	.filter(([filePath]) => filePath.endsWith('.m3u8'))
	.map(([filePath, bytes]) => ({ path: filePath, playlist: parsePlaylist(decoder.decode(bytes)) }));
const masterOf = (entry: CorpusEntry) => playlistsOf(entry).find(({ path }) => path === 'master.m3u8')!.playlist;
const mediaPlaylistsOf = (entry: CorpusEntry) => playlistsOf(entry).filter(({ path }) => path !== 'master.m3u8');
/** Every version of every media playlist (live outputs rewrite them), plus the final files */
const allMediaPlaylistVersions = (entry: CorpusEntry) => [
	...mediaPlaylistsOf(entry).map(({ playlist }) => playlist),
	...[...entry.playlistVersions.values()].flat().map(parsePlaylist),
];

/** Video with a key frame every second, using the parameter sets of the repository's video.mp4 */
const syntheticVideo = (media: Media, seconds = 6): Media['video'] => {
	const packets: EncodedPacket[] = [];
	for (let i = 0; i < seconds * 24; i++) {
		const isKey = i % 24 === 0;
		const data = new Uint8Array([0, 0, 0, 5, isKey ? 0x65 : 0x41, 0x88, i & 0xff, 1, 2]);
		packets.push(new EncodedPacket(data, isKey ? 'key' : 'delta', i / 24, 1 / 24));
	}
	return { ...media.video!, packets };
};

beforeAll(async () => {
	const avc = await packetsOf('video.mp4');
	const synthetic = { video: syntheticVideo(avc), audio: avc.audio };
	const add = async (name: string, options: Parameters<typeof collectOutput>[0],
		setup: Parameters<typeof collectOutput>[1]) => {
		corpus.push({ name, live: !!options.live, ...await collectOutput(options, setup) });
	};

	corpus = [];
	await add('ts-av', { segmentFormat: new MpegTsOutputFormat() }, async output => addTracks(output, synthetic));
	await add('ts-av-real', { segmentFormat: new MpegTsOutputFormat(), targetDuration: 6 },
		async output => addTracks(output, avc));
	await add('cmaf-av-single-file', { segmentFormat: new CmafOutputFormat(), singleFilePerPlaylist: true },
		async output => addTracks(output, synthetic));
	await add('cmaf-renditions', { segmentFormat: new CmafOutputFormat() },
		async output => addTracks(output, synthetic, {
			audioCopies: [
				{ languageCode: 'eng', name: 'English', primary: true },
				{ languageCode: 'fre', name: 'Français' },
			],
		}));
	await add('packed-audio', { segmentFormat: new AdtsOutputFormat() },
		async output => addTracks(output, { video: null, audio: avc.audio }));
	await add('ts-iframes', { segmentFormat: new MpegTsOutputFormat() },
		async output => addTracks(output, synthetic, { keyFramesOnly: true }));
	await add('cmaf-pdt', { segmentFormat: new CmafOutputFormat() },
		async output => addTracks(output, synthetic, { unixBase: 1_700_000_000 }));
	await add('ts-live', { segmentFormat: new MpegTsOutputFormat(), live: true, maxLiveSegmentCount: 3 },
		async output => addTracks(output, { video: syntheticVideo(avc, 14), audio: null }));
	await add('cmaf-live-unbounded', { segmentFormat: new CmafOutputFormat(), live: true },
		async output => addTracks(output, synthetic));
});

const vodEntries = () => corpus.filter(entry => !entry.live);
/** Every playlist text written, including all live versions */
const everyPlaylist = () => corpus.flatMap(entry => [
	...playlistsOf(entry).map(({ playlist }) => playlist),
	...[...entry.playlistVersions.values()].flat().map(parsePlaylist),
]);

const MEDIA_SEGMENT_TAGS = ['EXTINF', 'EXT-X-BYTERANGE', 'EXT-X-DISCONTINUITY', 'EXT-X-KEY', 'EXT-X-MAP',
	'EXT-X-PROGRAM-DATE-TIME', 'EXT-X-DATERANGE'];
const MEDIA_PLAYLIST_TAGS = ['EXT-X-TARGETDURATION', 'EXT-X-MEDIA-SEQUENCE', 'EXT-X-DISCONTINUITY-SEQUENCE',
	'EXT-X-ENDLIST', 'EXT-X-PLAYLIST-TYPE', 'EXT-X-I-FRAMES-ONLY'];
const MASTER_PLAYLIST_TAGS = ['EXT-X-MEDIA', 'EXT-X-STREAM-INF', 'EXT-X-I-FRAME-STREAM-INF', 'EXT-X-SESSION-DATA',
	'EXT-X-SESSION-KEY'];

/** The lowest protocol version a media playlist needs (RFC 8216, Section 7) */
const requiredVersion = (playlist: Playlist) => {
	let version = 1;
	if (tagsNamed(playlist, 'EXTINF').some(tag => /^\d+\.\d/.test(tag.value))) {
		version = 3;
	}
	if (tagsNamed(playlist, 'EXT-X-BYTERANGE').length > 0 || tagsNamed(playlist, 'EXT-X-I-FRAMES-ONLY').length > 0) {
		version = 4;
	}
	if (tagsNamed(playlist, 'EXT-X-MAP').length > 0) {
		version = tagsNamed(playlist, 'EXT-X-I-FRAMES-ONLY').length > 0 ? 5 : 6;
	}
	return version;
};

describe('Writer: RFC 8216 §4 (playlist syntax)', () => {
	test('§4.1: playlists are UTF-8 without a byte order mark or control characters other than CR and LF', () => {
		for (const entry of corpus) {
			for (const [filePath, bytes] of entry.files) {
				if (filePath.endsWith('.m3u8')) {
					expect(bytes.subarray(0, 3)).not.toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
					const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
					const controlCharacters = [...text].filter((char) => {
						const code = char.charCodeAt(0);
						return (code <= 0x1f && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f);
					});
					expect(controlCharacters).toEqual([]);
				}
			}
		}
	});

	test('§4.1: all character sequences are in Unicode normalization form NFC', () => {
		for (const playlist of everyPlaylist()) {
			expect(playlist.text).toBe(playlist.text.normalize('NFC'));
		}
	});

	test('§4.1: no whitespace other than in quoted strings and EXTINF titles', () => {
		for (const playlist of everyPlaylist()) {
			for (const line of playlist.lines) {
				const outsideQuotes = line.replace(/"[^"]*"/g, '""');
				expect(outsideQuotes).not.toMatch(/\s/);
			}
		}
	});

	test('§4.1: a playlist is either a media playlist or a master playlist', () => {
		for (const playlist of everyPlaylist()) {
			const mediaTags = [...MEDIA_SEGMENT_TAGS, ...MEDIA_PLAYLIST_TAGS];
			const isMedia = playlist.tags.some(tag => mediaTags.includes(tag.name));
			const isMaster = playlist.tags.some(tag => MASTER_PLAYLIST_TAGS.includes(tag.name));
			expect(isMedia !== isMaster).toBe(true);
		}
	});

	test('§4.2: attribute lists have no whitespace around "=", no CR/LF/quote in quoted strings, no repeated names',
		() => {
			for (const playlist of everyPlaylist()) {
				for (const tag of playlist.tags.filter(tag => tag.attributes)) {
					// The attribute list re-serializes to exactly its text: nothing was skipped by the parser
					const serialized = [...tag.attributes!].map(([name, value]) => `${name}=${value}`).join(',');
					expect(serialized).toBe(tag.value);
					const names = [...tag.value.matchAll(/(?:^|,)([A-Z0-9-]+)=/g)].map(match => match[1]);
					expect(new Set(names).size).toBe(names.length);
				}
			}
		});

	test('§4.3.1.1: EXTM3U is the first line of every playlist', () => {
		for (const playlist of everyPlaylist()) {
			expect(playlist.lines[0]).toBe('#EXTM3U');
		}
	});

	test('§4.3.1.2/§7: at most one EXT-X-VERSION, at least the version the playlist\'s tags need', () => {
		for (const entry of corpus) {
			for (const playlist of allMediaPlaylistVersions(entry)) {
				const versions = tagsNamed(playlist, 'EXT-X-VERSION');
				expect(versions.length).toBe(1);
				expect(Number(versions[0]!.value)).toBeGreaterThanOrEqual(requiredVersion(playlist));
			}
			expect(tagsNamed(masterOf(entry), 'EXT-X-VERSION').length).toBeLessThanOrEqual(1);
		}
	});

	test('§6.2.1: EXT-X-VERSION is not greater than the playlist\'s tags need (SHOULD NOT)', () => {
		for (const entry of corpus) {
			for (const playlist of allMediaPlaylistVersions(entry)) {
				// Version 3 is needed for the decimal durations, which are written even when they happen to be integers
				const needed = Math.max(3, requiredVersion(playlist));
				expect(Number(tagsNamed(playlist, 'EXT-X-VERSION')[0]!.value)).toBe(needed);
			}
		}
	});

	test('§4.3.2/§4.3.3/§4.3.4: media segment and media playlist tags never appear in a master playlist, nor master '
		+ 'playlist tags in a media playlist', () => {
		for (const entry of corpus) {
			const master = masterOf(entry);
			expect(master.tags.filter(tag => [...MEDIA_SEGMENT_TAGS, ...MEDIA_PLAYLIST_TAGS].includes(tag.name)))
				.toEqual([]);
			for (const playlist of allMediaPlaylistVersions(entry)) {
				expect(playlist.tags.filter(tag => MASTER_PLAYLIST_TAGS.includes(tag.name))).toEqual([]);
			}
		}
	});

	test('§4.3.3/§4.3.5: no media playlist tag, nor EXT-X-INDEPENDENT-SEGMENTS, appears more than once', () => {
		for (const entry of corpus) {
			for (const playlist of allMediaPlaylistVersions(entry)) {
				for (const name of [...MEDIA_PLAYLIST_TAGS, 'EXT-X-INDEPENDENT-SEGMENTS', 'EXT-X-START']) {
					expect(tagsNamed(playlist, name).length).toBeLessThanOrEqual(1);
				}
			}
		}
	});

	test('§4.3.2.1: every media segment has an EXTINF with a decimal duration and a trailing comma', () => {
		for (const entry of corpus) {
			for (const playlist of allMediaPlaylistVersions(entry)) {
				for (const { line } of playlist.uris) {
					const previousTags = playlist.tags.filter(tag => tag.line < line);
					const lastUriBefore = playlist.uris.filter(uri => uri.line < line).at(-1)?.line ?? -1;
					const extinf = previousTags.filter(tag => tag.name === 'EXTINF' && tag.line > lastUriBefore);
					expect(extinf).toHaveLength(1);
					expect(extinf[0]!.value).toMatch(/^\d+(\.\d+)?,$/);
				}
			}
		}
	});

	test('§4.3.3.1: EXT-X-TARGETDURATION is present, a decimal-integer, and no rounded EXTINF exceeds it (VOD)', () => {
		for (const entry of vodEntries()) {
			for (const { playlist } of mediaPlaylistsOf(entry)) {
				const target = tagsNamed(playlist, 'EXT-X-TARGETDURATION');
				expect(target).toHaveLength(1);
				expect(target[0]!.value).toMatch(/^\d+$/);
				for (const tag of tagsNamed(playlist, 'EXTINF')) {
					expect(Math.round(parseFloat(tag.value))).toBeLessThanOrEqual(Number(target[0]!.value));
				}
			}
		}
	});

	test('§4.3.3.2: EXT-X-MEDIA-SEQUENCE appears before the first media segment', () => {
		for (const entry of corpus) {
			for (const playlist of allMediaPlaylistVersions(entry)) {
				for (const tag of tagsNamed(playlist, 'EXT-X-MEDIA-SEQUENCE')) {
					expect(tag.line).toBeLessThan(playlist.uris[0]?.line ?? Infinity);
				}
			}
		}
	});

	test('§4.3.2.2: byte ranges are n@o sub-ranges lying within their resource', () => {
		let checked = 0;
		for (const entry of corpus) {
			for (const { playlist } of mediaPlaylistsOf(entry)) {
				for (const tag of tagsNamed(playlist, 'EXT-X-BYTERANGE')) {
					const [length, offset] = tag.value.split('@').map(Number);
					const uri = playlist.uris.find(uri => uri.line > tag.line)!.uri;
					expect(offset).toBeDefined();
					expect(offset! + length!).toBeLessThanOrEqual(entry.files.get(uri)!.length);
					checked++;
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	test('§4.3.2.5: EXT-X-MAP has a URI, and its byte range holds just the Media Initialization Section', () => {
		let checked = 0;
		for (const entry of corpus) {
			for (const { playlist } of mediaPlaylistsOf(entry)) {
				for (const tag of tagsNamed(playlist, 'EXT-X-MAP')) {
					const uri = unquote(tag.attributes!.get('URI'))!;
					expect(entry.files.has(uri)).toBe(true);
					const range = unquote(tag.attributes!.get('BYTERANGE'));
					const bytes = entry.files.get(uri)!;
					const [length, offset] = range ? range.split('@').map(Number) : [bytes.length, 0];
					const boxes = topLevelBoxes(bytes.subarray(offset, offset! + length!));
					expect(boxes.map(box => box.type)).toEqual(['ftyp', 'moov']);
					checked++;
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	test('§4.3.2.6: EXT-X-PROGRAM-DATE-TIME carries a time zone and milliseconds (SHOULD)', () => {
		const entry = corpus.find(entry => entry.name === 'cmaf-pdt')!;
		const tags = mediaPlaylistsOf(entry).flatMap(({ playlist }) => tagsNamed(playlist, 'EXT-X-PROGRAM-DATE-TIME'));
		expect(tags.length).toBeGreaterThan(0);
		for (const tag of tags) {
			expect(tag.value).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(Z|[+-]\d\d:\d\d)$/);
		}
	});

	test('§6.2.1/§4.3.3.4: playlists holding the final media segment end with EXT-X-ENDLIST', () => {
		for (const entry of corpus) {
			for (const { playlist } of mediaPlaylistsOf(entry)) {
				expect(playlist.lines.filter(line => line !== '').at(-1)).toBe('#EXT-X-ENDLIST');
			}
		}
	});

	test('§4.3.3.5/§6.2.2: VOD playlists are typed VOD; live playlists carry no EXT-X-PLAYLIST-TYPE', () => {
		for (const entry of corpus) {
			for (const playlist of allMediaPlaylistVersions(entry)) {
				const types = tagsNamed(playlist, 'EXT-X-PLAYLIST-TYPE').map(tag => tag.value);
				expect(types).toEqual(entry.live ? [] : ['VOD']);
			}
		}
	});
});

// --- ISOBMFF/TS helpers for the segment format checks ---

type Box = { type: string; start: number; size: number; headerSize: number; data: Uint8Array };

const topLevelBoxes = (bytes: Uint8Array, start = 0, end = bytes.length) => {
	const boxes: Box[] = [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = start;
	while (pos + 8 <= end) {
		let size = view.getUint32(pos);
		let headerSize = 8;
		if (size === 1) {
			size = Number(view.getBigUint64(pos + 8));
			headerSize = 16;
		} else if (size === 0) {
			size = end - pos;
		}
		const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
		boxes.push({ type, start: pos, size, headerSize, data: bytes.subarray(pos, pos + size) });
		pos += size;
	}
	return boxes;
};

const CONTAINER_BOXES = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'dinf', 'edts'];

const findBoxes = (bytes: Uint8Array, type: string): Box[] => {
	const result: Box[] = [];
	const visit = (data: Uint8Array) => {
		for (const box of topLevelBoxes(data)) {
			if (box.type === type) {
				result.push(box);
			}
			if (CONTAINER_BOXES.includes(box.type)) {
				visit(box.data.subarray(box.headerSize));
			}
		}
	};
	visit(bytes);
	return result;
};

const boxView = (box: Box) => new DataView(box.data.buffer, box.data.byteOffset, box.data.byteLength);

/** Durations and byte sizes of a media playlist's segments */
const segmentsOf = (entry: CorpusEntry, playlist: Playlist) => playlist.uris.map(({ uri, line }) => {
	const lastUriBefore = playlist.uris.filter(other => other.line < line).at(-1)?.line ?? -1;
	const tags = playlist.tags.filter(tag => tag.line > lastUriBefore && tag.line < line);
	const duration = parseFloat(tags.find(tag => tag.name === 'EXTINF')!.value);
	const range = tags.find(tag => tag.name === 'EXT-X-BYTERANGE');
	const size = range ? Number(range.value.split('@')[0]) : entry.files.get(uri)!.length;
	return { uri, duration, size };
});

/** Peak segment bit rate per RFC 8216, Section 4.3.4.2 */
const peakSegmentBitrate = (segments: { duration: number; size: number }[], targetDuration: number) => {
	let peak = 0;
	for (let i = 0; i < segments.length; i++) {
		let bytes = 0;
		let duration = 0;
		for (let j = i; j < segments.length; j++) {
			bytes += segments[j]!.size;
			duration += segments[j]!.duration;
			if (duration >= 0.5 * targetDuration && duration <= 1.5 * targetDuration) {
				peak = Math.max(peak, 8 * bytes / duration);
			}
		}
	}
	return peak;
};

const variantsOf = (master: Playlist) => master.tags
	.filter(tag => tag.name === 'EXT-X-STREAM-INF')
	.map(tag => ({ tag, uri: master.uris.find(uri => uri.line > tag.line)!.uri }));

describe('Writer: RFC 8216 §4.3.4 (master playlist)', () => {
	test('§4.3.4.2: every EXT-X-STREAM-INF has BANDWIDTH and is followed by its URI line', () => {
		for (const entry of corpus) {
			const master = masterOf(entry);
			for (const tag of tagsNamed(master, 'EXT-X-STREAM-INF')) {
				expect(tag.attributes!.get('BANDWIDTH')).toMatch(/^\d+$/);
				expect(master.uris.some(uri => uri.line === tag.line + 1)).toBe(true);
			}
		}
	});

	test('§4.3.4.2: every EXT-X-STREAM-INF has CODECS (SHOULD), video variants RESOLUTION and FRAME-RATE', () => {
		for (const entry of corpus) {
			for (const { tag } of variantsOf(masterOf(entry))) {
				const codecs = unquote(tag.attributes!.get('CODECS'))!;
				expect(codecs).toBeTruthy();
				if (codecs.includes('avc1')) {
					expect(tag.attributes!.get('RESOLUTION')).toMatch(/^\d+x\d+$/);
					expect(tag.attributes!.get('FRAME-RATE')).toMatch(/^\d+(\.\d{1,3})?$/);
				}
			}
		}
	});

	test('§4.3.4.2/§4.3.4.2.1: BANDWIDTH covers the peak segment bit rates of the variant plus its renditions', () => {
		for (const entry of vodEntries()) {
			const master = masterOf(entry);
			const playlists = new Map(mediaPlaylistsOf(entry).map(({ path, playlist }) => [path, playlist]));
			const peakOf = (uri: string) => {
				const playlist = playlists.get(uri)!;
				const target = Number(tagsNamed(playlist, 'EXT-X-TARGETDURATION')[0]!.value);
				return peakSegmentBitrate(segmentsOf(entry, playlist), target);
			};
			for (const { tag, uri } of variantsOf(master)) {
				let peak = peakOf(uri);
				const audioGroup = unquote(tag.attributes!.get('AUDIO'));
				if (audioGroup) {
					const renditions = tagsNamed(master, 'EXT-X-MEDIA')
						.filter(media => unquote(media.attributes!.get('GROUP-ID')) === audioGroup);
					peak += Math.max(...renditions.map(media => peakOf(unquote(media.attributes!.get('URI'))!)));
				}
				expect(Number(tag.attributes!.get('BANDWIDTH'))).toBeGreaterThanOrEqual(Math.floor(peak));
			}
		}
	});

	test('§4.3.4.2: AVERAGE-BANDWIDTH is the average segment bit rate of the variant plus its renditions', () => {
		for (const entry of vodEntries()) {
			const master = masterOf(entry);
			const playlists = new Map(mediaPlaylistsOf(entry).map(({ path, playlist }) => [path, playlist]));
			const averageOf = (uri: string) => {
				const segments = segmentsOf(entry, playlists.get(uri)!);
				const bytes = segments.reduce((sum, segment) => sum + segment.size, 0);
				return 8 * bytes / segments.reduce((sum, segment) => sum + segment.duration, 0);
			};
			for (const { tag, uri } of variantsOf(master)) {
				let average = averageOf(uri);
				const audioGroup = unquote(tag.attributes!.get('AUDIO'));
				if (audioGroup) {
					const renditions = tagsNamed(master, 'EXT-X-MEDIA')
						.filter(media => unquote(media.attributes!.get('GROUP-ID')) === audioGroup);
					average += Math.max(...renditions.map(media => averageOf(unquote(media.attributes!.get('URI'))!)));
				}
				expect(Number(tag.attributes!.get('AVERAGE-BANDWIDTH')) / average).toBeCloseTo(1, 2);
			}
		}
	});

	test('§4.3.4.2: AUDIO names the GROUP-ID of an EXT-X-MEDIA tag of TYPE AUDIO', () => {
		const master = masterOf(corpus.find(entry => entry.name === 'cmaf-renditions')!);
		const groups = tagsNamed(master, 'EXT-X-MEDIA')
			.filter(tag => tag.attributes!.get('TYPE') === 'AUDIO')
			.map(tag => unquote(tag.attributes!.get('GROUP-ID')));
		const variant = variantsOf(master)[0]!;
		expect(groups).toContain(unquote(variant.tag.attributes!.get('AUDIO')));
	});

	test('§4.3.4.1: EXT-X-MEDIA has TYPE, GROUP-ID and NAME; AUTOSELECT=YES with DEFAULT=YES; FORCED only for '
		+ 'subtitles; INSTREAM-ID only for closed captions; CHANNELS on audio (SHOULD)', () => {
		let checked = 0;
		for (const entry of corpus) {
			for (const tag of tagsNamed(masterOf(entry), 'EXT-X-MEDIA')) {
				const attributes = tag.attributes!;
				expect(['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS']).toContain(attributes.get('TYPE'));
				expect(attributes.get('GROUP-ID')).toMatch(/^".+"$/);
				expect(attributes.get('NAME')).toMatch(/^".+"$/);
				if (attributes.get('DEFAULT') === 'YES' && attributes.has('AUTOSELECT')) {
					expect(attributes.get('AUTOSELECT')).toBe('YES');
				}
				if (attributes.get('TYPE') !== 'SUBTITLES') {
					expect(attributes.has('FORCED')).toBe(false);
				}
				if (attributes.get('TYPE') !== 'CLOSED-CAPTIONS') {
					expect(attributes.has('INSTREAM-ID')).toBe(false);
				}
				if (attributes.get('TYPE') === 'AUDIO') {
					expect(attributes.get('CHANNELS')).toMatch(/^"\d+"$/);
				}
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	test('§4.3.4.1.1: members of a rendition group have different NAMEs and at most one DEFAULT=YES', () => {
		for (const entry of corpus) {
			const groups = new Map<string, Tag[]>();
			for (const tag of tagsNamed(masterOf(entry), 'EXT-X-MEDIA')) {
				const key = `${tag.attributes!.get('TYPE')}:${tag.attributes!.get('GROUP-ID')}`;
				groups.set(key, [...(groups.get(key) ?? []), tag]);
			}
			for (const members of groups.values()) {
				const names = members.map(tag => tag.attributes!.get('NAME'));
				expect(new Set(names).size).toBe(names.length);
				expect(members.filter(tag => tag.attributes!.get('DEFAULT') === 'YES').length).toBeLessThanOrEqual(1);
			}
		}
	});

	test('§4.3.4.3: EXT-X-I-FRAME-STREAM-INF has BANDWIDTH and URI, and its playlist has EXT-X-I-FRAMES-ONLY', () => {
		let checked = 0;
		for (const entry of corpus) {
			for (const tag of tagsNamed(masterOf(entry), 'EXT-X-I-FRAME-STREAM-INF')) {
				expect(tag.attributes!.get('BANDWIDTH')).toMatch(/^\d+$/);
				const uri = unquote(tag.attributes!.get('URI'))!;
				const playlist = parsePlaylist(decoder.decode(entry.files.get(uri)));
				expect(tagsNamed(playlist, 'EXT-X-I-FRAMES-ONLY')).toHaveLength(1);
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	test('§6.2.4: all media playlists of a variant share the target duration and the playlist type', () => {
		for (const entry of vodEntries()) {
			const master = masterOf(entry);
			const playlists = new Map(mediaPlaylistsOf(entry).map(({ path, playlist }) => [path, playlist]));
			for (const { tag, uri } of variantsOf(master)) {
				const uris = [uri, ...tagsNamed(master, 'EXT-X-MEDIA')
					.filter(media => media.attributes!.get('GROUP-ID') === tag.attributes!.get('AUDIO'))
					.map(media => unquote(media.attributes!.get('URI'))!)];
				const targets = new Set(uris.map(u => tagsNamed(playlists.get(u)!, 'EXT-X-TARGETDURATION')[0]!.value));
				const types = new Set(uris.map(u => tagsNamed(playlists.get(u)!, 'EXT-X-PLAYLIST-TYPE')[0]?.value));
				expect(targets.size).toBe(1);
				expect(types.size).toBe(1);
			}
		}
	});

	test('§6.2.4: CODECS lists the formats of the variant and of every rendition it references', () => {
		const master = masterOf(corpus.find(entry => entry.name === 'cmaf-renditions')!);
		const codecs = unquote(variantsOf(master)[0]!.tag.attributes!.get('CODECS'))!.split(',');
		expect(codecs).toContain('avc1.640028');
		expect(codecs).toContain('mp4a.40.2');
	});
});

const segmentFiles = (extension: string) => corpus.flatMap(entry => [...entry.files]
	.filter(([filePath]) => filePath.endsWith(extension))
	.map(([filePath, bytes]) => ({ entry, path: filePath, bytes })));

describe('Writer: RFC 8216 §3 (media segments)', () => {
	test('§3.2: transport stream segments start with a PAT and a PMT and carry a single program', () => {
		const segments = segmentFiles('.ts');
		expect(segments.length).toBeGreaterThan(0);
		for (const { bytes } of segments) {
			const pid = (offset: number) => ((bytes[offset + 1]! & 0x1f) << 8) | bytes[offset + 2]!;
			expect(bytes[0]).toBe(0x47);
			expect(pid(0)).toBe(0); // PAT
			// PAT section: pointer field, then table_id 0; section_length counts the 5-byte header, programs and CRC
			const section = 4 + 1 + bytes[4]!;
			expect(bytes[section]).toBe(0);
			const sectionLength = ((bytes[section + 1]! & 0x0f) << 8) | bytes[section + 2]!;
			const programs = (sectionLength - 5 - 4) / 4;
			expect(programs).toBe(1);
			const pmtPid = ((bytes[section + 8 + 2]! & 0x1f) << 8) | bytes[section + 8 + 3]!;
			expect(pid(188)).toBe(pmtPid);
		}
	});

	test('§3.3: fMP4 initialization sections have an ftyp compatible with iso6 or higher, followed by moov', () => {
		const maps = corpus.flatMap(entry => mediaPlaylistsOf(entry).flatMap(({ playlist }) => tagsNamed(playlist,
			'EXT-X-MAP').map(tag => ({ entry, uri: unquote(tag.attributes!.get('URI'))!,
			range: unquote(tag.attributes!.get('BYTERANGE')) }))));
		expect(maps.length).toBeGreaterThan(0);
		for (const { entry, uri, range } of maps) {
			let bytes = entry.files.get(uri)!;
			if (range) {
				const [length, offset] = range.split('@').map(Number);
				bytes = bytes.subarray(offset, offset! + length!);
			}
			const boxes = topLevelBoxes(bytes);
			expect(boxes[0]!.type).toBe('ftyp');
			expect(boxes[1]!.type).toBe('moov');
			const ftyp = boxes[0]!.data;
			const brands = [String.fromCharCode(...ftyp.subarray(8, 12))];
			for (let pos = 16; pos < ftyp.length; pos += 4) {
				brands.push(String.fromCharCode(...ftyp.subarray(pos, pos + 4)));
			}
			expect(brands.some(brand => /^iso[6-9]$/.test(brand) || brand === 'cmfc')).toBe(true);
		}
	});

	const initsAndSegments = () => corpus.flatMap((entry) => {
		const result: { init: Uint8Array; segments: Uint8Array[] }[] = [];
		for (const { playlist } of mediaPlaylistsOf(entry)) {
			const map = tagsNamed(playlist, 'EXT-X-MAP')[0];
			if (!map) {
				continue;
			}
			const slice = (uri: string, range: string | undefined) => {
				const bytes = entry.files.get(uri)!;
				if (!range) {
					return bytes;
				}
				const [length, offset] = range.split('@').map(Number);
				return bytes.subarray(offset, offset! + length!);
			};
			const init = slice(unquote(map.attributes!.get('URI'))!, unquote(map.attributes!.get('BYTERANGE')));
			const segments = playlist.uris.map(({ uri, line }) => {
				const range = playlist.tags.find(tag => tag.name === 'EXT-X-BYTERANGE' && tag.line === line - 1);
				return slice(uri, range?.value);
			});
			result.push({ init, segments });
		}
		return result;
	});

	test('§3.3: the movie box has zero durations and sample counts, and an mvex after the last trak', () => {
		for (const { init } of initsAndSegments()) {
			const moov = findBoxes(init, 'moov')[0]!;
			const children = topLevelBoxes(moov.data, moov.headerSize).map(box => box.type);
			expect(children.lastIndexOf('trak')).toBeLessThan(children.indexOf('mvex'));
			for (const box of [...findBoxes(init, 'mvhd'), ...findBoxes(init, 'tkhd')]) {
				const view = boxView(box);
				const version = box.data[8];
				const durationOffset = box.type === 'mvhd'
					? (version === 1 ? 8 + 4 + 16 + 4 : 8 + 4 + 8 + 4)
					: (version === 1 ? 8 + 4 + 16 + 4 + 4 : 8 + 4 + 8 + 4 + 4);
				const duration = version === 1
					? Number(view.getBigUint64(durationOffset))
					: view.getUint32(durationOffset);
				expect(duration).toBe(0);
			}
			for (const box of [...findBoxes(init, 'stts'), ...findBoxes(init, 'stsc'), ...findBoxes(init, 'stco')]) {
				expect(boxView(box).getUint32(12)).toBe(0); // entry_count
			}
			for (const box of findBoxes(init, 'stsz')) {
				expect(boxView(box).getUint32(16)).toBe(0); // sample_count
			}
		}
	});

	test('§3.3: every traf has a tfdt and a matching trak; addressing is movie-fragment relative; no external data',
		() => {
			for (const { init, segments } of initsAndSegments()) {
				const trackIds = findBoxes(init, 'tkhd')
					.map(box => boxView(box).getUint32(box.data[8] === 1 ? 28 : 20));
				for (const dref of findBoxes(init, 'dref')) {
					const entry = topLevelBoxes(dref.data, 16)[0]!;
					expect(entry.data[11]! & 1).toBe(1); // Self-contained: no external data reference
				}
				for (const segment of segments) {
					for (const traf of findBoxes(segment, 'traf')) {
						const tfhd = findBoxes(traf.data.subarray(traf.headerSize), 'tfhd')[0]!;
						const flags = (tfhd.data[9]! << 16) | (tfhd.data[10]! << 8) | tfhd.data[11]!;
						expect(flags & 0x1).toBe(0); // No base-data-offset
						expect(flags & 0x020000).toBe(0x020000); // default-base-is-moof
						expect(trackIds).toContain(boxView(tfhd).getUint32(12));
						expect(findBoxes(traf.data.subarray(traf.headerSize), 'tfdt')).toHaveLength(1);
					}
				}
			}
		});

	test('§3.1: the Media Initialization Section holds no sample data', () => {
		for (const { init } of initsAndSegments()) {
			expect(topLevelBoxes(init).map(box => box.type)).not.toContain('mdat');
			expect(topLevelBoxes(init).map(box => box.type)).not.toContain('moof');
		}
	});

	test('§3.4: packed audio segments begin with an ID3 PRIV frame holding the 33-bit timestamp of the first sample',
		() => {
			const segments = segmentFiles('.aac');
			expect(segments.length).toBeGreaterThan(0);
			for (const { bytes } of segments) {
				expect(decoder.decode(bytes.subarray(0, 3))).toBe('ID3');
				const frameId = decoder.decode(bytes.subarray(10, 14));
				expect(frameId).toBe('PRIV');
				const owner = 'com.apple.streaming.transportStreamTimestamp';
				expect(decoder.decode(bytes.subarray(20, 20 + owner.length))).toBe(owner);
				expect(bytes[20 + owner.length]).toBe(0);
				const payload = bytes.subarray(21 + owner.length, 29 + owner.length);
				expect(payload.length).toBe(8);
				// Upper 31 bits are zero
				expect([payload[0], payload[1], payload[2], payload[3]! & 0xfe]).toEqual([0, 0, 0, 0]);
			}
		});
});

describe('Writer: RFC 8216 §6.2 (server responsibilities)', () => {
	test('§6.2.1: media segments last at most the target duration (VOD, key frames within it)', () => {
		for (const entry of vodEntries()) {
			for (const { playlist } of mediaPlaylistsOf(entry)) {
				const target = Number(tagsNamed(playlist, 'EXT-X-TARGETDURATION')[0]!.value);
				for (const segment of segmentsOf(entry, playlist)) {
					expect(segment.duration).toBeLessThanOrEqual(target);
				}
			}
		}
	});

	const liveVersions = (name: string) => [...corpus.find(entry => entry.name === name)!.playlistVersions.values()]
		.map(versions => versions.map(parsePlaylist));

	test('§6.2.1: the target duration of a live media playlist never changes', () => {
		for (const name of ['ts-live', 'cmaf-live-unbounded']) {
			for (const versions of liveVersions(name)) {
				const targets = new Set(versions.map(version => tagsNamed(version, 'EXT-X-TARGETDURATION')[0]!.value));
				expect(targets.size).toBe(1);
			}
		}
	});

	test('§6.2.1: live playlist updates only append segments, remove the oldest ones, or add EXT-X-ENDLIST', () => {
		for (const name of ['ts-live', 'cmaf-live-unbounded']) {
			for (const versions of liveVersions(name)) {
				for (let i = 1; i < versions.length; i++) {
					const previous = versions[i - 1]!.uris.map(uri => uri.uri);
					const current = versions[i]!.uris.map(uri => uri.uri);
					const removed = previous.findIndex(uri => uri === current[0]);
					expect(removed).toBeGreaterThanOrEqual(0);
					expect(current.slice(0, previous.length - removed)).toEqual(previous.slice(removed));
				}
			}
		}
	});

	test('§6.2.2: a live playlist that removes segments has EXT-X-MEDIA-SEQUENCE, increased by one per removed '
		+ 'segment', () => {
		const removals = liveVersions('ts-live').flat()
			.filter(version => Number(tagsNamed(version, 'EXT-X-MEDIA-SEQUENCE')[0]!.value) > 0);
		expect(removals.length).toBeGreaterThan(0);
		for (const versions of liveVersions('ts-live')) {
			for (let i = 1; i < versions.length; i++) {
				const sequence = (playlist: Playlist) => Number(tagsNamed(playlist, 'EXT-X-MEDIA-SEQUENCE')[0]!.value);
				const previous = versions[i - 1]!.uris.map(uri => uri.uri);
				const removed = previous.indexOf(versions[i]!.uris[0]!.uri);
				expect(sequence(versions[i]!) - sequence(versions[i - 1]!)).toBe(removed);
			}
		}
	});

	test('§6.2.2: removing segments never leaves less than three target durations in a live playlist', () => {
		for (const versions of liveVersions('ts-live')) {
			for (const version of versions) {
				const target = Number(tagsNamed(version, 'EXT-X-TARGETDURATION')[0]!.value);
				const total = tagsNamed(version, 'EXTINF').reduce((sum, tag) => sum + parseFloat(tag.value), 0);
				const sequence = Number(tagsNamed(version, 'EXT-X-MEDIA-SEQUENCE')[0]!.value);
				if (sequence > 0 && tagsNamed(version, 'EXT-X-ENDLIST').length === 0) {
					expect(total).toBeGreaterThanOrEqual(3 * target);
				}
			}
		}
	});
});

describe('Reader: RFC 8216 (client responsibilities not covered by the HLS reading suite, fork PR #100)', () => {
	const openPlaylist = (playlist: string, files: Record<string, Uint8Array>) => new Input({
		source: new CustomPathedSource('index.m3u8', ({ path: filePath }) => new BufferSource(filePath === 'index.m3u8'
			? new TextEncoder().encode(playlist)
			: files[filePath]!)),
		formats: ALL_FORMATS,
	});

	const readTracks = async (playlist: string, files: Record<string, Uint8Array>) => {
		using input = openPlaylist(playlist, files);
		return await input.getTracks();
	};

	test('§4.3.4: a playlist holding both master playlist tags and media segment tags fails to parse', async () => {
		const entry = corpus.find(entry => entry.name === 'ts-av')!;
		const segment = entry.files.get('segment-1-1.ts')!;
		const variant = new TextEncoder()
			.encode('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n');
		const mixed = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvariant.m3u8\n'
			+ '#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n';
		await expect(readTracks(mixed, { 'variant.m3u8': variant, 'segment.ts': segment })).rejects.toThrow();
		// Control: the variant alone reads fine
		const tracks = await readTracks(decoder.decode(variant), { 'segment.ts': segment });
		expect(tracks.length).toBeGreaterThan(0);
	});
});
