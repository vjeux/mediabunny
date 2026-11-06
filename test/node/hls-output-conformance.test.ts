import { describe, expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { Output, OutputTrackGroup } from '../../src/output.js';
import {
	AdtsOutputFormat,
	CmafOutputFormat,
	HlsOutputFormat,
	HlsOutputFormatOptions,
	MpegTsOutputFormat,
} from '../../src/output-format.js';
import { BufferSource } from '../../src/source.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import {
	createMemoryInput,
	getSegmentUris,
	loadSourceMedia,
	MemoryFiles,
	presentationTimestamps,
	readPackets,
	readText,
	writeHls,
	WriteHlsOptions,
} from './helpers/hls-fixtures.js';
import {
	MediaPlaylistInfo,
	validateMediaPlaylist,
	validateMultivariantPlaylist,
} from './helpers/hls-playlist-validator.js';

// The source media (see loadSourceMedia) has 225 video and 390 audio packets
const VIDEO_PACKET_COUNT = 225;
const AUDIO_PACKET_COUNT = 390;

/** Writes HLS, recording every playlist version written along the way. */
const writeAndRecord = async (options: WriteHlsOptions) => {
	const playlists: { text: string; n: number }[] = [];
	const masters: string[] = [];

	const files = await writeHls({
		...options,
		format: {
			...options.format,
			onPlaylist: (text, info) => playlists.push({ text, n: info.n }),
			onMaster: text => masters.push(text),
		},
	});

	return { files, playlists, masters };
};

const expectValidPlaylists = (recorded: Awaited<ReturnType<typeof writeAndRecord>>) => {
	expect(recorded.masters.length).toBeGreaterThan(0);
	for (const master of recorded.masters) {
		expect(validateMultivariantPlaylist(master).errors).toEqual([]);
	}

	expect(recorded.playlists.length).toBeGreaterThan(0);
	for (const playlist of recorded.playlists) {
		expect(validateMediaPlaylist(playlist.text).errors).toEqual([]);
	}
};

/** Reads one segment file on its own and returns its packets per track type. */
const readSegment = async (files: MemoryFiles, uri: string, initUri?: string) => {
	using initInput = initUri
		? new Input({ source: new BufferSource(files.get(initUri)!), formats: ALL_FORMATS })
		: null;
	using input = new Input({
		source: new BufferSource(files.get(uri)!),
		formats: ALL_FORMATS,
		initInput: initInput ?? undefined,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();

	return {
		video: videoTrack ? await readPackets(videoTrack) : [],
		audio: audioTrack ? await readPackets(audioTrack) : [],
	};
};

const SEGMENT_FORMATS = {
	'MPEG-TS': (): HlsOutputFormatOptions => ({ segmentFormat: new MpegTsOutputFormat() }),
	'CMAF': (): HlsOutputFormatOptions => ({ segmentFormat: new CmafOutputFormat() }),
	'MPEG-TS, single file': (): HlsOutputFormatOptions => ({
		segmentFormat: new MpegTsOutputFormat(),
		singleFilePerPlaylist: true,
	}),
	'CMAF, single file': (): HlsOutputFormatOptions => ({
		segmentFormat: new CmafOutputFormat(),
		singleFilePerPlaylist: true,
	}),
};

describe('Playlist validity', () => {
	test.each(Object.keys(SEGMENT_FORMATS) as (keyof typeof SEGMENT_FORMATS)[])(
		'writes playlists that follow RFC 8216 (%s)',
		async (name) => {
			const recorded = await writeAndRecord({ format: SEGMENT_FORMATS[name]() });
			expectValidPlaylists(recorded);
		},
	);

	test('writes valid playlists for packed audio, also next to TS video', async () => {
		expectValidPlaylists(await writeAndRecord({ format: { segmentFormat: new AdtsOutputFormat() }, video: false }));
		expectValidPlaylists(await writeAndRecord({
			format: { segmentFormat: [new AdtsOutputFormat(), new MpegTsOutputFormat()] },
		}));
	});

	test('writes valid playlists with program date times', async () => {
		const media = await loadSourceMedia();
		const offset = Date.UTC(2026, 0, 1) / 1000;
		const recorded = await writeAndRecord({
			format: { segmentFormat: new MpegTsOutputFormat() },
			timestampOffset: offset,
			videoMetadata: { isRelativeToUnixEpoch: true },
			audioMetadata: { isRelativeToUnixEpoch: true },
		});
		expectValidPlaylists(recorded);

		// The first segment starts at the earliest packet, the audio's, 48 ms before the video
		const { info } = validateMediaPlaylist(recorded.playlists.at(-1)!.text);
		const start = offset + Math.min(media.videoPackets[0]!.timestamp, media.audioPackets[0]!.timestamp);
		expect(info.segments[0]!.programDateTime).toBe(new Date(Math.round(1000 * start)).toISOString());
		for (let i = 1; i < info.segments.length; i++) {
			const elapsed = Date.parse(info.segments[i]!.programDateTime!)
				- Date.parse(info.segments[i - 1]!.programDateTime!);
			expect(elapsed / 1000).toBeCloseTo(info.segments[i - 1]!.duration, 3);
		}
	});

	test('writes valid playlists for every step of a live stream', async () => {
		// 36 s of video with a key frame every 1.92 s: segments of 1.92 s, and of 1.32 s at the end of each repetition
		const maxLiveSegmentCount = 4;
		const recorded = await writeAndRecord({
			format: { segmentFormat: new MpegTsOutputFormat(), live: true, maxLiveSegmentCount },
			audio: false,
			repeat: 4,
		});
		expectValidPlaylists(recorded);

		const infos = recorded.playlists.map(x => validateMediaPlaylist(x.text).info);
		const getDuration = (info: MediaPlaylistInfo) => info.segments.reduce((sum, x) => sum + x.duration, 0);

		for (let i = 0; i < infos.length; i++) {
			const info = infos[i]!;
			const minDuration = 3 * info.targetDuration!;

			// The target duration never changes, and only the last playlist ends
			expect(info.targetDuration).toBe(2);
			expect(info.ended).toBe(i === infos.length - 1);
			expect(info.playlistType).toBeNull();

			// "The server MUST NOT remove a Media Segment from a Playlist file without an EXT-X-ENDLIST tag if that
			// would produce a Playlist whose duration is less than three times the target duration." (RFC 8216,
			// Section 6.2.2)
			if (!info.ended && info.mediaSequence > 0) {
				expect(getDuration(info)).toBeGreaterThanOrEqual(minDuration);
			}

			// Beyond maxLiveSegmentCount, a playlist only keeps segments it can't drop without falling below that
			if (info.segments.length > maxLiveSegmentCount) {
				expect(getDuration(info) - info.segments[0]!.duration).toBeLessThan(minDuration);
			}

			// Segments slide out at the front, and the media sequence counts them
			if (i > 0) {
				const previous = infos[i - 1]!;
				const removed = info.mediaSequence - previous.mediaSequence;
				expect(removed).toBeGreaterThanOrEqual(0);
				if (removed < previous.segments.length) {
					expect(info.segments[0]!.uri).toBe(previous.segments[removed]!.uri);
				}
			}
		}

		// Segments did slide out while the stream was live
		expect(infos.some(info => !info.ended && info.mediaSequence > 0)).toBe(true);
	});

	test.each([
		['MPEG-TS', () => ({ segmentFormat: new MpegTsOutputFormat() }), 3],
		['MPEG-TS, single file', () => ({ segmentFormat: new MpegTsOutputFormat(), singleFilePerPlaylist: true }), 4],
		['CMAF', () => ({ segmentFormat: new CmafOutputFormat() }), 6],
	] as const)('declares the lowest compatibility version the tags need (%s)', async (_, format, version) => {
		const recorded = await writeAndRecord({ format: format() });
		expect(validateMediaPlaylist(recorded.playlists.at(-1)!.text).info.version).toBe(version);
	});
});

describe('Segments', () => {
	test.each(Object.keys(SEGMENT_FORMATS) as (keyof typeof SEGMENT_FORMATS)[])(
		'starts every segment with a key frame and loses no packet (%s)',
		async (name) => {
			const recorded = await writeAndRecord({ format: SEGMENT_FORMATS[name]() });
			const { info } = validateMediaPlaylist(recorded.playlists.at(-1)!.text);
			const singleFile = name.includes('single file');

			let videoCount = 0;
			let audioCount = 0;
			const starts: number[] = [];

			for (const segment of info.segments) {
				let files = recorded.files;
				let uri = segment.uri;
				if (singleFile) {
					const whole = recorded.files.get(segment.uri)!;
					const offset = segment.byteRange!.offset!;
					files = new Map([['range', whole.subarray(offset, offset + segment.byteRange!.length)]]);
					uri = 'range';
					if (info.map) {
						const [length, mapOffset] = info.map.byteRange!.split('@').map(Number);
						files.set('init', whole.subarray(mapOffset, mapOffset! + length!));
					}
				} else if (info.map) {
					files = new Map([...recorded.files, ['init', recorded.files.get(info.map.uri)!]]);
				}

				const { video, audio } = await readSegment(files, uri, info.map ? 'init' : undefined);
				expect(video[0]!.type).toBe('key');
				videoCount += video.length;
				audioCount += audio.length;
				starts.push(Math.min(...video.map(x => x.timestamp), ...audio.map(x => x.timestamp)));
			}

			expect(videoCount).toBe(VIDEO_PACKET_COUNT);
			expect(audioCount).toBe(AUDIO_PACKET_COUNT);

			// Each #EXTINF is the time from the start of its segment to the start of the next one
			for (let i = 0; i < starts.length - 1; i++) {
				expect(info.segments[i]!.duration).toBeCloseTo(starts[i + 1]! - starts[i]!, 4);
			}
		},
	);

	test('shifts the media so that the first packet lands on mediaTimestampBase', async () => {
		for (const mediaTimestampBase of [0, 10, 1000.5]) {
			const files = await writeHls({ format: { segmentFormat: new MpegTsOutputFormat(), mediaTimestampBase } });
			const firstUri = getSegmentUris(readText(files, 'playlist-1.m3u8'))[0]!;
			const { video, audio } = await readSegment(files, firstUri);

			const first = Math.min(...video.map(x => x.timestamp), ...audio.map(x => x.timestamp));
			expect(first).toBeCloseTo(mediaTimestampBase, 4);
		}
	});

	test('cuts segments at the latest key frame within the target duration', async () => {
		// Key frames come every 1.92 s, so a 4 s target fits two GOPs and a 1 s target forces one GOP per segment
		for (const [targetDuration, expectedDurations] of [[4, [3.84, 3.84]], [1, [1.92, 1.92, 1.92, 1.92]]] as const) {
			const recorded = await writeAndRecord({
				format: { segmentFormat: new MpegTsOutputFormat(), targetDuration },
			});
			const { info } = validateMediaPlaylist(recorded.playlists.at(-1)!.text);

			const durations = info.segments.map(x => x.duration);
			for (let i = 0; i < expectedDurations.length; i++) {
				// The first segment also covers the audio that starts 48 ms before the video
				expect(durations[i]).toBeCloseTo(expectedDurations[i]! + (i === 0 ? 0.047891 : 0), 4);
			}

			// In VOD mode, the target duration grows to cover the longest segment
			expect(info.targetDuration).toBe(Math.max(targetDuration, Math.ceil(Math.max(...durations))));
		}
	});
});

describe('Single-file playlists', () => {
	test.each(['MPEG-TS', 'CMAF'] as const)('writes contiguous byte ranges covering the file (%s)', async (name) => {
		const recorded = await writeAndRecord({
			format: SEGMENT_FORMATS[`${name}, single file`](),
		});
		const { info } = validateMediaPlaylist(recorded.playlists.at(-1)!.text);
		const fileSize = recorded.files.get(info.segments[0]!.uri)!.length;

		let position = 0;
		if (info.map) {
			expect(info.map.uri).toBe(info.segments[0]!.uri);
			const [length, offset] = info.map.byteRange!.split('@').map(Number);
			expect(offset).toBe(0);
			position = length!;
		}

		for (const segment of info.segments) {
			expect(segment.uri).toBe(info.segments[0]!.uri);
			expect(segment.byteRange!.offset).toBe(position);
			position += segment.byteRange!.length;
		}
		expect(position).toBe(fileSize);
	});

	test('writes a single MPEG-TS file that plays on its own', async () => {
		const files = await writeHls({ format: SEGMENT_FORMATS['MPEG-TS, single file']() });
		const uri = getSegmentUris(readText(files, 'playlist-1.m3u8'))[0]!;
		const { video, audio } = await readSegment(files, uri);
		expect(video).toHaveLength(VIDEO_PACKET_COUNT);
		expect(audio).toHaveLength(AUDIO_PACKET_COUNT);
	});
});

describe('Multivariant playlist attributes', () => {
	test('lists the codecs, resolution and frame rate of the variant', async () => {
		const media = await loadSourceMedia();
		const recorded = await writeAndRecord({
			format: { segmentFormat: new MpegTsOutputFormat() },
			videoMetadata: { frameRate: 30000 / 1001 },
		});

		const { variants } = validateMultivariantPlaylist(recorded.masters.at(-1)!);
		expect(variants).toHaveLength(1);
		const codecs = `${media.videoDecoderConfig.codec},${media.audioDecoderConfig.codec}`;
		expect(variants[0]!.attributes.get('CODECS')).toBe(codecs);
		expect(variants[0]!.attributes.get('RESOLUTION')).toBe('854x480');
		expect(variants[0]!.attributes.get('FRAME-RATE')).toBe('29.97');
	});

	test('swaps the resolution of rotated video', async () => {
		const recorded = await writeAndRecord({
			format: { segmentFormat: [new MpegTsOutputFormat(), new CmafOutputFormat()] },
			videoMetadata: { rotation: 90 },
		});
		const { variants } = validateMultivariantPlaylist(recorded.masters.at(-1)!);
		expect(variants[0]!.attributes.get('RESOLUTION')).toBe('480x854');

		// The segment format able to store the rotation was picked
		expect(recorded.playlists.at(-1)!.text).toContain('#EXT-X-MAP');
	});

	test('computes AVERAGE-BANDWIDTH and BANDWIDTH from the segment sizes (RFC 8216, Section 4.3.4.2)', async () => {
		const recorded = await writeAndRecord({ format: { segmentFormat: new MpegTsOutputFormat() } });
		const { info } = validateMediaPlaylist(recorded.playlists.at(-1)!.text);
		const { variants } = validateMultivariantPlaylist(recorded.masters.at(-1)!);

		const sizes = info.segments.map(x => recorded.files.get(x.uri)!.length);
		const durations = info.segments.map(x => x.duration);
		const totalDuration = durations.reduce((a, b) => a + b, 0);
		const averageBitrate = 8 * sizes.reduce((a, b) => a + b, 0) / totalDuration;
		expect(Number(variants[0]!.attributes.get('AVERAGE-BANDWIDTH'))).toBe(Math.ceil(averageBitrate));

		// The peak segment bit rate: the largest bit rate of any run of segments lasting 0.5 to 1.5 target durations.
		// Every segment here lasts about one target duration and is such a run on its own, and runs of two segments
		// are too long.
		const peakBitrate = Math.max(...sizes.map((size, i) => 8 * size / durations[i]!).slice(0, -1));
		const bandwidth = Number(variants[0]!.attributes.get('BANDWIDTH'));
		expect(bandwidth).toBeGreaterThanOrEqual(Math.ceil(averageBitrate));
		expect(bandwidth).toBe(Math.ceil(Math.max(peakBitrate, 8 * sizes.at(-1)! / durations.at(-1)!)));
	});

	test('describes alternate audio renditions with #EXT-X-MEDIA', async () => {
		const media = await loadSourceMedia();
		const files: MemoryFiles = new Map();
		let master = '';

		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new MpegTsOutputFormat(),
				onMaster: (text) => {
					master = text;
				},
			}),
			target: new PathedTarget('master.m3u8', (request) => {
				const target = new BufferTarget();
				target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
				return target;
			}),
		});

		const videoSource = new EncodedVideoPacketSource('avc');
		const englishSource = new EncodedAudioPacketSource('aac');
		const frenchSource = new EncodedAudioPacketSource('aac');
		output.addVideoTrack(videoSource);
		output.addAudioTrack(englishSource, { languageCode: 'eng', name: 'English' });
		output.addAudioTrack(frenchSource, { languageCode: 'fra', name: 'Français', disposition: { primary: true } });
		await output.start();

		for (const packet of media.videoPackets) {
			await videoSource.add(packet, { decoderConfig: media.videoDecoderConfig });
		}
		for (const packet of media.audioPackets) {
			await englishSource.add(packet, { decoderConfig: media.audioDecoderConfig });
			await frenchSource.add(packet, { decoderConfig: media.audioDecoderConfig });
		}
		await output.finalize();

		const { errors, variants, renditions } = validateMultivariantPlaylist(master);
		expect(errors).toEqual([]);
		expect(variants).toHaveLength(1);
		expect(renditions).toHaveLength(2);

		const [english, french] = renditions.map(x => x.attributes);
		expect(english!.get('TYPE')).toBe('AUDIO');
		expect(english!.get('NAME')).toBe('English');
		expect(english!.get('LANGUAGE')).toBe('eng');
		expect(english!.get('DEFAULT')).toBeUndefined();
		expect(english!.get('AUTOSELECT')).toBe('YES');
		expect(english!.get('CHANNELS')).toBe('2');
		expect(french!.get('NAME')).toBe('Français');
		expect(french!.get('DEFAULT')).toBe('YES');
		expect(variants[0]!.attributes.get('AUDIO')).toBe(english!.get('GROUP-ID'));

		// The renditions read back as tracks with their metadata, each pairable with the video
		using memory = createMemoryInput(files, 'master.m3u8');
		const audioTracks = await memory.input.getAudioTracks();
		const videoTrack = await memory.input.getPrimaryVideoTrack();
		expect(await Promise.all(audioTracks.map(x => x.getName()))).toEqual(['English', 'Français']);
		expect(await Promise.all(audioTracks.map(x => x.getLanguageCode()))).toEqual(['eng', 'fra']);
		expect((await audioTracks[1]!.getDisposition()).primary).toBe(true);
		expect(audioTracks.every(x => videoTrack!.canBePairedWith(x))).toBe(true);
		expect(await readPackets(audioTracks[1]!)).toHaveLength(AUDIO_PACKET_COUNT);
	});

	test('writes separate variants for separately paired tracks', async () => {
		const media = await loadSourceMedia();
		let master = '';

		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new MpegTsOutputFormat(),
				onMaster: (text) => {
					master = text;
				},
			}),
			target: new PathedTarget('master.m3u8', () => new BufferTarget()),
		});

		const sources: [EncodedVideoPacketSource, EncodedAudioPacketSource][] = [];
		for (let i = 0; i < 2; i++) {
			const group = new OutputTrackGroup();
			const videoSource = new EncodedVideoPacketSource('avc');
			const audioSource = new EncodedAudioPacketSource('aac');
			output.addVideoTrack(videoSource, { group });
			output.addAudioTrack(audioSource, { group });
			sources.push([videoSource, audioSource]);
		}
		await output.start();

		for (const [videoSource, audioSource] of sources) {
			for (const packet of media.videoPackets) {
				await videoSource.add(packet, { decoderConfig: media.videoDecoderConfig });
			}
			for (const packet of media.audioPackets) {
				await audioSource.add(packet, { decoderConfig: media.audioDecoderConfig });
			}
		}
		await output.finalize();

		const { errors, variants, renditions } = validateMultivariantPlaylist(master);
		expect(errors).toEqual([]);
		expect(variants).toHaveLength(2);
		expect(renditions).toHaveLength(0);
	});

	test('writes key-packet-only video as an I-frame stream', async () => {
		const media = await loadSourceMedia();
		let master = '';
		const playlists = new Map<number, string>();

		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new MpegTsOutputFormat(),
				onMaster: (text) => { master = text; },
				onPlaylist: (text, info) => playlists.set(info.n, text),
			}),
			target: new PathedTarget('master.m3u8', () => new BufferTarget()),
		});

		const iFrameSource = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(iFrameSource, { hasOnlyKeyPackets: true });
		await output.start();
		for (const packet of media.videoPackets.filter(x => x.type === 'key')) {
			await iFrameSource.add(packet, { decoderConfig: media.videoDecoderConfig });
		}
		await output.finalize();

		const { errors, variants } = validateMultivariantPlaylist(master);
		expect(errors).toEqual([]);
		expect(variants).toHaveLength(1);
		expect(variants[0]!.iFrame).toBe(true);
		expect(variants[0]!.attributes.has('FRAME-RATE')).toBe(false);

		const { errors: playlistErrors, info } = validateMediaPlaylist(playlists.get(1)!);
		expect(playlistErrors).toEqual([]);
		expect(info.iFramesOnly).toBe(true);
		expect(info.version).toBeGreaterThanOrEqual(4);
	});
});

describe('Round trip', () => {
	test.each(Object.keys(SEGMENT_FORMATS) as (keyof typeof SEGMENT_FORMATS)[])(
		'reads back every packet with its data, type and relative timestamp (%s)',
		async (name) => {
			const media = await loadSourceMedia();
			const files = await writeHls({ format: SEGMENT_FORMATS[name]() });

			using memory = createMemoryInput(files, 'master.m3u8');
			const videoTrack = await memory.input.getPrimaryVideoTrack();
			const audioTrack = await memory.input.getPrimaryAudioTrack();
			const video = await readPackets(videoTrack!);
			const audio = await readPackets(audioTrack!);

			expect(video.map(x => x.type)).toEqual(media.videoPackets.map(x => x.type));
			expect(audio).toHaveLength(AUDIO_PACKET_COUNT);
			if (name.startsWith('CMAF')) {
				// MPEG-TS carries AAC as ADTS frames, so only CMAF keeps the exact packet bytes
				expect(audio.map(x => x.data)).toEqual(media.audioPackets.map(x => x.data));
				expect(video.map(x => x.data)).toEqual(media.videoPackets.map(x => x.data));
			}

			// Timestamps keep their spacing; the earliest packet (audio here) lands at 0
			const sourceStart = Math.min(media.videoPackets[0]!.timestamp, media.audioPackets[0]!.timestamp);
			const start = Math.min(presentationTimestamps(video)[0]!, presentationTimestamps(audio)[0]!);
			const videoOffsets = presentationTimestamps(video).map(x => x - start);
			const sourceVideoOffsets = presentationTimestamps(media.videoPackets).map(x => x - sourceStart);
			for (let i = 0; i < videoOffsets.length; i++) {
				expect(videoOffsets[i]).toBeCloseTo(sourceVideoOffsets[i]!, 4);
			}

			expect(await videoTrack!.getCodecParameterString()).toBe(media.videoDecoderConfig.codec);
			expect(await audioTrack!.getCodecParameterString()).toBe(media.audioDecoderConfig.codec);
		},
	);
});

describe('Paths and callbacks', () => {
	test('calls onSegment for every segment and onInit once per CMAF playlist', async () => {
		const segmentPaths: string[] = [];
		let initCount = 0;
		let masterCount = 0;

		await writeHls({
			format: {
				segmentFormat: new CmafOutputFormat(),
				onSegment: (_, info) => segmentPaths.push(`${info.playlist.n}-${info.n}`),
				onInit: () => initCount++,
				onMaster: () => masterCount++,
			},
		});

		expect(segmentPaths).toEqual(['1-1', '1-2', '1-3', '1-4', '1-5']);
		expect(initCount).toBe(1);
		expect(masterCount).toBe(1);
	});

	test('calls onSegmentPopped for segments leaving a live playlist', async () => {
		const maxLiveSegmentCount = 2;
		const popped: string[] = [];
		const recorded = await writeAndRecord({
			format: {
				segmentFormat: new MpegTsOutputFormat(),
				live: true,
				maxLiveSegmentCount,
				onSegmentPopped: path => popped.push(path),
			},
		});

		// Exactly the segments that left the playlist were popped, oldest first
		const segmentNumber = (path: string) => Number(/^segment-1-(\d+)\.ts$/.exec(path)![1]);
		const allSegments = [...recorded.files.keys()]
			.filter(path => path.startsWith('segment-'))
			.sort((a, b) => segmentNumber(a) - segmentNumber(b));
		const final = validateMediaPlaylist(recorded.playlists.at(-1)!.text).info;

		expect(popped.length).toBeGreaterThan(0);
		expect(popped).toEqual(allSegments.slice(0, final.mediaSequence));
		expect(final.segments.map(x => x.uri)).toEqual(allSegments.slice(final.mediaSequence));

		// Popping stops at maxLiveSegmentCount, unless fewer segments would span less than three target durations
		// (RFC 8216, Section 6.2.2)
		for (const { text } of recorded.playlists) {
			const info = validateMediaPlaylist(text).info;
			if (info.segments.length > maxLiveSegmentCount) {
				const duration = info.segments.reduce((sum, x) => sum + x.duration, 0);
				expect(duration - info.segments[0]!.duration).toBeLessThan(3 * info.targetDuration!);
			}
		}
	});

	test('writes URIs relative to the playlist that contains them', async () => {
		const files = await writeHls({
			format: {
				segmentFormat: new CmafOutputFormat(),
				getPlaylistPath: () => 'video/stream.m3u8',
				getSegmentPath: ({ n }) => `chunks/${n}.m4s`,
				getInitPath: () => 'chunks/init.mp4',
			},
			rootPath: 'out/master.m3u8',
		});

		expect([...files.keys()].sort()).toEqual([
			'out/master.m3u8',
			'out/video/chunks/1.m4s',
			'out/video/chunks/2.m4s',
			'out/video/chunks/3.m4s',
			'out/video/chunks/4.m4s',
			'out/video/chunks/5.m4s',
			'out/video/chunks/init.mp4',
			'out/video/stream.m3u8',
		]);
		expect(readText(files, 'out/master.m3u8')).toContain('\nvideo/stream.m3u8\n');
		expect(readText(files, 'out/video/stream.m3u8')).toContain('#EXT-X-MAP:URI="chunks/init.mp4"');
		expect(readText(files, 'out/video/stream.m3u8')).toContain('\nchunks/1.m4s\n');
	});

	test('rejects paths that would break the playlist syntax', async () => {
		for (const path of ['a\nb.ts', 'a"b.ts', 'a\rb.ts']) {
			await expect(writeHls({
				format: { segmentFormat: new MpegTsOutputFormat(), getSegmentPath: () => path },
			})).rejects.toThrow(TypeError);
		}
	});

	test('validates its options', () => {
		const segmentFormat = new MpegTsOutputFormat();
		expect(() => new HlsOutputFormat({} as HlsOutputFormatOptions)).toThrow(TypeError);
		expect(() => new HlsOutputFormat({ segmentFormat: [] })).toThrow(TypeError);
		expect(() => new HlsOutputFormat({ segmentFormat, targetDuration: 0 })).toThrow(TypeError);
		expect(() => new HlsOutputFormat({ segmentFormat, targetDuration: -1 })).toThrow(TypeError);
		expect(() => new HlsOutputFormat({ segmentFormat, maxLiveSegmentCount: 0 })).toThrow(TypeError);
		expect(() => new HlsOutputFormat({ segmentFormat, maxLiveSegmentCount: 1.5 })).toThrow(TypeError);
		expect(() => new HlsOutputFormat({ segmentFormat, mediaTimestampBase: Infinity })).toThrow(TypeError);
		expect(() => new HlsOutputFormat({ segmentFormat, live: 'yes' as never })).toThrow(TypeError);
		expect(() => new HlsOutputFormat({ segmentFormat, getSegmentPath: 'x' as never })).toThrow(TypeError);
		expect(() => new HlsOutputFormat({ segmentFormat, maxLiveSegmentCount: Infinity })).not.toThrow();
	});

	test('requires a PathedTarget', () => {
		expect(() => new Output({
			format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat() }),
			target: new BufferTarget(),
		})).toThrow('PathedTarget');
	});
});
