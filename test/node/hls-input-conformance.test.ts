/* eslint-disable @stylistic/max-len */
import http from 'node:http';
import { describe, expect, test, vi } from 'vitest';
import { createAes128CbcDecryptStream } from '../../src/aes.js';
import { AttributeList, HlsPlaylistVariables } from '../../src/hls/hls-misc.js';
import { HLS, HLS_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert, joinPaths } from '../../src/misc.js';
import { Reader } from '../../src/reader.js';
import { AdtsOutputFormat, CmafOutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferSource, CustomPathedSource, UrlSource } from '../../src/source.js';
import {
	createMemoryInput,
	encodeText,
	encryptAes128Cbc,
	getSegmentUris,
	loadSourceMedia,
	mediaSequenceIv,
	MemoryFiles,
	presentationTimestamps,
	readPackets,
	readText,
	toHex,
	writeHls,
} from './helpers/hls-fixtures.js';

// The source media (see loadSourceMedia) has 225 video and 390 audio packets
const VIDEO_PACKET_COUNT = 225;
const AUDIO_PACKET_COUNT = 390;

/** A TS-segmented media playlist written by Mediabunny itself, as the basis for playlist variations. */
const writeTsStream = () => writeHls({ format: { segmentFormat: new MpegTsOutputFormat() } });
const writeCmafStream = () => writeHls({ format: { segmentFormat: new CmafOutputFormat() } });

/** Replaces the media playlist and reads it as the root playlist. */
const readVariant = (files: MemoryFiles, playlist: string, formatOptions?: Parameters<typeof createMemoryInput>[2]) => {
	const variantFiles = new Map(files);
	variantFiles.set('variant.m3u8', encodeText(playlist));

	return createMemoryInput(variantFiles, 'variant.m3u8', formatOptions);
};

const getTrackPackets = async (input: Input) => {
	const video = await input.getPrimaryVideoTrack();
	const audio = await input.getPrimaryAudioTrack();

	return {
		video: video ? await readPackets(video) : [],
		audio: audio ? await readPackets(audio) : [],
	};
};

describe('Playlist syntax', () => {
	test('reads a TS media playlist written by Mediabunny', async () => {
		const files = await writeTsStream();
		using input = createMemoryInput(files, 'playlist-1.m3u8').input;

		expect(await input.getFormat()).toBe(HLS);
		expect(await input.getMimeType()).toBe('application/vnd.apple.mpegurl');

		const { video, audio } = await getTrackPackets(input);
		expect(video).toHaveLength(VIDEO_PACKET_COUNT);
		expect(audio).toHaveLength(AUDIO_PACKET_COUNT);

		// Mediabunny rebases the media's own timestamps onto the playlist timeline, which starts at 0
		const media = await loadSourceMedia();
		expect(presentationTimestamps(video)[0]).toBe(0);
		expect(presentationTimestamps(video).at(-1)).toBeCloseTo(
			Math.max(...media.videoPackets.map(x => x.timestamp)) - Math.min(...media.videoPackets.map(x => x.timestamp)),
			5,
		);
	});

	test('accepts CRLF line endings, blank lines, surrounding whitespace and comments', async () => {
		const files = await writeTsStream();
		const playlist = readText(files, 'playlist-1.m3u8')
			.split('\n')
			.map(line => line.startsWith('#EXTINF') ? `# A comment\r\n  ${line}  \r\n` : `${line}\r\n`)
			.join('\r\n');

		using input = readVariant(files, playlist).input;
		const { video, audio } = await getTrackPackets(input);
		expect(video).toHaveLength(VIDEO_PACKET_COUNT);
		expect(audio).toHaveLength(AUDIO_PACKET_COUNT);
	});

	test('requires #EXTM3U on the first line', async () => {
		const files = await writeTsStream();
		const playlist = readText(files, 'playlist-1.m3u8').replace('#EXTM3U\n', '#EXT-X-VERSION:3\n#EXTM3U\n');

		using input = readVariant(files, playlist).input;
		expect(await input.canRead()).toBe(false);
	});

	test('rejects playlists that start with a byte order mark (RFC 8216, Section 4.1)', async () => {
		const files = await writeTsStream();
		using input = readVariant(files, '\uFEFF' + readText(files, 'playlist-1.m3u8')).input;
		expect(await input.canRead()).toBe(false);
	});

	test('accepts every #EXTINF form: integer, decimal, with a title and without the comma', async () => {
		const files = await writeTsStream();
		const uris = getSegmentUris(readText(files, 'playlist-1.m3u8'));
		const extinfs = ['#EXTINF:2,', '#EXTINF:1.5,Segment title, with a comma', '#EXTINF:2.25', '#EXTINF: 1.75,'];

		let playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:3\n';
		for (let i = 0; i < uris.length; i++) {
			playlist += `${extinfs[i % extinfs.length]}\n${uris[i]}\n`;
		}
		playlist += '#EXT-X-ENDLIST\n';

		using input = readVariant(files, playlist).input;
		const videoTrack = await input.getPrimaryVideoTrack();
		expect(videoTrack).not.toBeNull();

		const durations = [2, 1.5, 2.25, 1.75];
		const total = uris.reduce((sum, _, i) => sum + durations[i % durations.length]!, 0);
		expect(await videoTrack!.getDurationFromMetadata()).toBeCloseTo(total, 10);
	});

	test('rejects a segment URI that has no #EXTINF', async () => {
		const files = await writeTsStream();
		const uris = getSegmentUris(readText(files, 'playlist-1.m3u8'));

		using input = readVariant(
			files,
			`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${uris[0]}\n${uris[1]}\n#EXT-X-ENDLIST\n`,
		).input;
		await expect(input.getTracks()).rejects.toThrow('must be preceded by an #EXTINF tag');
	});

	test('rejects negative and non-numeric #EXTINF durations', async () => {
		const files = await writeTsStream();
		const uri = getSegmentUris(readText(files, 'playlist-1.m3u8'))[0]!;

		for (const duration of ['-1', 'abc', 'NaN', 'Infinity']) {
			using input = readVariant(files, `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:${duration},\n${uri}\n`).input;
			await expect(input.getTracks()).rejects.toThrow('Invalid #EXTINF tag duration');
		}
	});

	test('ignores unknown tags and tags it does not act on', async () => {
		const files = await writeTsStream();
		const playlist = readText(files, 'playlist-1.m3u8').replace(
			'#EXT-X-INDEPENDENT-SEGMENTS\n',
			[
				'#EXT-X-INDEPENDENT-SEGMENTS',
				'#EXT-X-START:TIME-OFFSET=2.5,PRECISE=YES',
				'#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=NO',
				'#EXT-X-DATERANGE:ID="ad",START-DATE="2026-01-01T00:00:00Z",DURATION=1.5',
				'#EXT-X-BITRATE:500',
				'#EXT-X-ALLOW-CACHE:YES',
				'#EXT-X-FOO-BAR:BAZ="qux"',
				'#EXT-UNKNOWN',
				'',
			].join('\n'),
		);

		using input = readVariant(files, playlist).input;
		const { video, audio } = await getTrackPackets(input);
		expect(video).toHaveLength(VIDEO_PACKET_COUNT);
		expect(audio).toHaveLength(AUDIO_PACKET_COUNT);
	});

	test('starts a VOD timeline at 0 regardless of EXT-X-MEDIA-SEQUENCE', async () => {
		// Regression test for upstream #427
		const files = await writeTsStream();
		const playlist = readText(files, 'playlist-1.m3u8').replace('#EXTM3U\n', '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:42\n');

		using input = readVariant(files, playlist).input;
		const videoTrack = await input.getPrimaryVideoTrack();
		expect(await videoTrack!.getFirstTimestamp()).toBe(0);
	});

	test('stops reloading a playlist once it has #EXT-X-ENDLIST', async () => {
		const files = await writeTsStream();
		using memory = readVariant(files, readText(files, 'playlist-1.m3u8'));
		const { input, requests } = memory;

		const videoTrack = await input.getPrimaryVideoTrack();
		expect(await videoTrack!.isLive()).toBe(false);
		expect(await videoTrack!.getLiveRefreshInterval()).toBeNull();
		expect(await readPackets(videoTrack!)).toHaveLength(VIDEO_PACKET_COUNT);
		expect(requests.filter(path => path === 'variant.m3u8')).toHaveLength(1);
	});

	test('treats a VOD playlist type as ended even without #EXT-X-ENDLIST', async () => {
		const files = await writeTsStream();
		const playlist = readText(files, 'playlist-1.m3u8').replace('#EXT-X-ENDLIST\n', '');
		expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');

		using input = readVariant(files, playlist).input;
		const videoTrack = await input.getPrimaryVideoTrack();
		expect(await videoTrack!.isLive()).toBe(false);
		expect(await videoTrack!.getLiveRefreshInterval()).toBe(null);
	});

	test('treats playlists without #EXT-X-ENDLIST as live, refreshing every target duration', async () => {
		const files = await writeTsStream();
		const playlist = readText(files, 'playlist-1.m3u8')
			.replace('#EXT-X-PLAYLIST-TYPE:VOD\n', '')
			.replace('#EXT-X-ENDLIST\n', '')
			.replace(/#EXT-X-TARGETDURATION:\d+/, '#EXT-X-TARGETDURATION:6');

		using input = readVariant(files, playlist).input;
		const videoTrack = await input.getPrimaryVideoTrack();
		expect(await videoTrack!.isLive()).toBe(true);
		expect(await videoTrack!.getLiveRefreshInterval()).toBe(6);

		// The currently known end can be queried without waiting for the stream to end
		const duration = await videoTrack!.computeDuration({ skipLiveWait: true });
		expect(duration).toBeGreaterThan(8.9);
	});

	test('rejects invalid EXT-X-MEDIA-SEQUENCE, EXT-X-DISCONTINUITY-SEQUENCE and EXT-X-TARGETDURATION values', async () => {
		const files = await writeTsStream();
		const playlist = readText(files, 'playlist-1.m3u8');

		const cases: [string, string][] = [
			['#EXT-X-MEDIA-SEQUENCE:-1', 'Invalid EXT-X-MEDIA-SEQUENCE'],
			['#EXT-X-MEDIA-SEQUENCE:1.5', 'Invalid EXT-X-MEDIA-SEQUENCE'],
			['#EXT-X-DISCONTINUITY-SEQUENCE:x', 'Invalid EXT-X-DISCONTINUITY-SEQUENCE'],
			['#EXT-X-TARGETDURATION:-3', 'Invalid EXT-X-TARGETDURATION'],
		];

		for (const [tag, error] of cases) {
			using input = readVariant(files, playlist.replace('#EXTM3U\n', `#EXTM3U\n${tag}\n`)).input;
			await expect(input.getTracks()).rejects.toThrow(error);
		}
	});
});

describe('Attribute lists', () => {
	test('parses quoted strings containing commas, equals signs and spaces', () => {
		const list = new AttributeList('NAME="English, 5.1 = surround",URI="a b.m3u8",TYPE=AUDIO');
		expect(list.get('NAME')).toBe('English, 5.1 = surround');
		expect(list.get('URI')).toBe('a b.m3u8');
		expect(list.get('TYPE')).toBe('AUDIO');
	});

	test('parses every attribute value type of RFC 8216, Section 4.2', () => {
		const list = new AttributeList(
			'BANDWIDTH=1280000,IV=0x0123456789ABCDEF0123456789abcdef,FRAME-RATE=29.970,TIME-OFFSET=-2.5,'
			+ 'RESOLUTION=1920x1080,CLOSED-CAPTIONS=NONE,CODECS="avc1.64001f,mp4a.40.2"',
		);

		expect(list.getAsNumber('BANDWIDTH')).toBe(1280000);
		expect(list.get('IV')).toBe('0x0123456789ABCDEF0123456789abcdef');
		expect(list.getAsNumber('FRAME-RATE')).toBe(29.97);
		expect(list.getAsNumber('TIME-OFFSET')).toBe(-2.5);
		expect(list.get('RESOLUTION')).toBe('1920x1080');
		expect(list.get('CLOSED-CAPTIONS')).toBe('NONE');
		expect(list.get('CODECS')).toBe('avc1.64001f,mp4a.40.2');
	});

	test('treats attribute names case-insensitively and tolerates spaces around them', () => {
		const list = new AttributeList(' bandwidth=100 , Average-Bandwidth=50,CODECS="x"');
		expect(list.getAsNumber('BANDWIDTH')).toBe(100);
		expect(list.getAsNumber('AVERAGE-BANDWIDTH')).toBe(50);
		expect(list.get('codecs')).toBe('x');
	});

	test('returns null for missing attributes and non-numeric numbers', () => {
		const list = new AttributeList('BANDWIDTH=abc,NAME=""');
		expect(list.get('URI')).toBeNull();
		expect(list.getAsNumber('BANDWIDTH')).toBeNull();
		expect(list.getAsNumber('MISSING')).toBeNull();
		expect(list.get('NAME')).toBe('');
	});

	test('ignores empty attributes from stray commas', () => {
		const list = new AttributeList('A=1,,B=2,');
		expect(list.get('A')).toBe('1');
		expect(list.get('B')).toBe('2');
	});

	test('keeps the last value of a duplicated attribute and warns', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const list = new AttributeList('BANDWIDTH=1,BANDWIDTH=2');
		expect(list.getAsNumber('BANDWIDTH')).toBe(2);
		expect(warn).toHaveBeenCalled();
	});

	test('rejects an unterminated quoted string', () => {
		expect(() => new AttributeList('URI="abc,BANDWIDTH=1')).toThrow('unterminated quoted-string');
	});

	test('substitutes variables in quoted strings and hexadecimal sequences only', () => {
		const variables = new HlsPlaylistVariables('https://example.com/a.m3u8', null);
		variables.define('NAME="v",VALUE="sub"');

		const list = new AttributeList('URI="{$v}/x.m3u8",IV=0x{$v},TYPE={$v}', variables);
		expect(list.get('URI')).toBe('sub/x.m3u8');
		expect(list.get('IV')).toBe('0xsub');
		expect(list.get('TYPE')).toBe('{$v}');
	});
});

describe('Variable substitution', () => {
	test('substitutes variables defined earlier, including inside other variables', () => {
		const variables = new HlsPlaylistVariables('https://example.com/a.m3u8', null);
		variables.define('NAME="host",VALUE="cdn.example.com"');
		variables.define('NAME="base",VALUE="https://{$host}/v1"');

		expect(variables.substitute('{$base}/seg-{$host}.ts')).toBe('https://cdn.example.com/v1/seg-cdn.example.com.ts');
		expect(variables.substitute('no variables {$')).toBe('no variables {$');
	});

	test('decodes percent-encoded QUERYPARAM values', () => {
		const variables = new HlsPlaylistVariables('https://example.com/a.m3u8?token=a%2Fb%20c&x=1#frag', null);
		variables.define('QUERYPARAM="token"');
		expect(variables.get('token')).toBe('a/b c');
	});

	test('rejects definitions that would blow up exponentially', () => {
		const variables = new HlsPlaylistVariables('https://example.com/a.m3u8', null);
		variables.define('NAME="a0",VALUE="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"');
		expect(() => {
			for (let i = 1; i < 40; i++) {
				const reference = `{$a${i - 1}}`;
				variables.define(`NAME="a${i}",VALUE="${reference.repeat(4)}"`);
			}
		}).toThrow('excessive amount of data');
	});

	test('substitutes variables in segment URIs of media playlists', async () => {
		const files = await writeTsStream();
		const playlist = readText(files, 'playlist-1.m3u8')
			.replace('#EXTM3U\n', '#EXTM3U\n#EXT-X-DEFINE:NAME="prefix",VALUE="segment-1"\n')
			.replaceAll(/^segment-1-/gm, '{$prefix}-');
		expect(playlist).toContain('{$prefix}-1.ts');

		using input = readVariant(files, playlist).input;
		const { video } = await getTrackPackets(input);
		expect(video).toHaveLength(VIDEO_PACKET_COUNT);
	});
});

describe('Byte ranges', () => {
	test('reads byte ranges with explicit offsets and with the implicit continuation form', async () => {
		const files = await writeHls({ format: { segmentFormat: new MpegTsOutputFormat(), singleFilePerPlaylist: true } });
		const playlist = readText(files, 'playlist-1.m3u8');
		expect(playlist).toContain('#EXT-X-BYTERANGE:');

		// Drop every offset after the first one: each range then continues where the previous one ended
		let first = true;
		const implicit = playlist.replaceAll(/#EXT-X-BYTERANGE:(\d+)@(\d+)/g, (match, length: string) => {
			if (first) {
				first = false;
				return match;
			}

			return `#EXT-X-BYTERANGE:${length}`;
		});

		for (const variant of [playlist, implicit]) {
			using input = readVariant(files, variant).input;
			const { video, audio } = await getTrackPackets(input);
			expect(video).toHaveLength(VIDEO_PACKET_COUNT);
			expect(audio).toHaveLength(AUDIO_PACKET_COUNT);
		}
	});

	test('reads fMP4 byte ranges with an init section byte range', async () => {
		const files = await writeHls({ format: { segmentFormat: new CmafOutputFormat(), singleFilePerPlaylist: true } });
		const playlist = readText(files, 'playlist-1.m3u8');
		expect(playlist).toMatch(/#EXT-X-MAP:URI="[^"]+",BYTERANGE="\d+@0"/);

		using input = readVariant(files, playlist).input;
		const { video, audio } = await getTrackPackets(input);
		expect(video).toHaveLength(VIDEO_PACKET_COUNT);
		expect(audio).toHaveLength(AUDIO_PACKET_COUNT);
	});

	test('requires an offset when there is no previous byte range', async () => {
		const files = await writeHls({ format: { segmentFormat: new MpegTsOutputFormat(), singleFilePerPlaylist: true } });
		const playlist = readText(files, 'playlist-1.m3u8').replace(/#EXT-X-BYTERANGE:(\d+)@0/, '#EXT-X-BYTERANGE:$1');

		using input = readVariant(files, playlist).input;
		await expect(input.getTracks()).rejects.toThrow('requires a previous byte range');
	});

	test('requires an offset in the byte range of #EXT-X-MAP (RFC 8216bis, Section 4.4.4.5)', async () => {
		const files = await writeHls({ format: { segmentFormat: new CmafOutputFormat(), singleFilePerPlaylist: true } });
		const playlist = readText(files, 'playlist-1.m3u8').replace(/BYTERANGE="(\d+)@0"/, 'BYTERANGE="$1"');

		using input = readVariant(files, playlist).input;
		await expect(input.getTracks()).rejects.toThrow('must have a specified offset');
	});

	test('rejects malformed byte ranges', async () => {
		const files = await writeHls({ format: { segmentFormat: new MpegTsOutputFormat(), singleFilePerPlaylist: true } });
		const playlist = readText(files, 'playlist-1.m3u8');

		for (const range of ['-5@0', '12.5@0', 'abc', '100@-1']) {
			using input = readVariant(files, playlist.replace(/#EXT-X-BYTERANGE:\d+@0/, `#EXT-X-BYTERANGE:${range}`)).input;
			await expect(input.getTracks()).rejects.toThrow('Invalid #EXT-X-BYTERANGE');
		}
	});
});

describe('Media initialization sections', () => {
	test('applies #EXT-X-MAP to all following segments', async () => {
		const files = await writeCmafStream();
		const playlist = readText(files, 'playlist-1.m3u8');
		expect(playlist).toMatch(/#EXT-X-MAP:URI="init-1\.m4s"/);

		using memory = readVariant(files, playlist);
		const { input, requests } = memory;
		const { video, audio } = await getTrackPackets(input);
		expect(video).toHaveLength(VIDEO_PACKET_COUNT);
		expect(audio).toHaveLength(AUDIO_PACKET_COUNT);

		// The init section is fetched once and reused for every segment
		expect(requests.filter(path => path === 'init-1.m4s')).toHaveLength(1);
	});

	test('requires the URI attribute of #EXT-X-MAP', async () => {
		const files = await writeCmafStream();
		const playlist = readText(files, 'playlist-1.m3u8').replace('#EXT-X-MAP:URI="init-1.m4s"', '#EXT-X-MAP:BYTERANGE="10@0"');

		using input = readVariant(files, playlist).input;
		await expect(input.getTracks()).rejects.toThrow('missing URI attribute');
	});
});

describe('Discontinuities', () => {
	/** Two independent encodes with different timestamp bases, joined by #EXT-X-DISCONTINUITY. */
	const writeDiscontinuousStream = async (secondFormat: 'ts' | 'cmaf') => {
		const first = await writeHls({ format: { segmentFormat: new MpegTsOutputFormat() } });
		const second = await writeHls({
			format: {
				segmentFormat: secondFormat === 'ts' ? new MpegTsOutputFormat() : new CmafOutputFormat(),
				// Media timestamps of the second part start at 1000 s
				mediaTimestampBase: 1000,
				getSegmentPath: ({ n, format }) => `b-${n}${format.fileExtension}`,
				getInitPath: () => 'b-init.m4s',
			},
		});

		const files: MemoryFiles = new Map([...first, ...second]);
		const firstPlaylist = readText(first, 'playlist-1.m3u8');
		const secondPlaylist = readText(second, 'playlist-1.m3u8');

		const firstBody = firstPlaylist.slice(firstPlaylist.indexOf('#EXTINF'), firstPlaylist.indexOf('#EXT-X-ENDLIST'));
		const secondBody = secondPlaylist
			.slice(secondPlaylist.indexOf(secondFormat === 'ts' ? '#EXTINF' : '#EXT-X-MAP'), secondPlaylist.indexOf('#EXT-X-ENDLIST'))
			.replace('\n\n', '\n');
		files.set('joined.m3u8', encodeText(
			'#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ firstBody.trim() + '\n#EXT-X-DISCONTINUITY\n' + secondBody.trim() + '\n#EXT-X-ENDLIST\n',
		));

		return files;
	};

	test.each(['ts', 'cmaf'] as const)('keeps the timeline continuous across a timestamp reset (%s after TS)', async (secondFormat) => {
		const files = await writeDiscontinuousStream(secondFormat);
		using input = createMemoryInput(files, 'joined.m3u8').input;

		const videoTrack = await input.getPrimaryVideoTrack();
		const timestamps = presentationTimestamps(await readPackets(videoTrack!));
		expect(timestamps).toHaveLength(2 * VIDEO_PACKET_COUNT);

		// The second part's video starts at its playlist position, the sum of the #EXTINF durations before it
		const playlist = readText(files, 'joined.m3u8');
		const secondPartStart = [...playlist.slice(0, playlist.indexOf('#EXT-X-DISCONTINUITY')).matchAll(/#EXTINF:([\d.]+)/g)]
			.reduce((sum, match) => sum + Number(match[1]), 0);
		expect(secondPartStart).toBeGreaterThan(9);

		const media = await loadSourceMedia();
		const sourceTimestamps = presentationTimestamps(media.videoPackets);
		const sourceStart = sourceTimestamps[0]!;

		for (let i = 0; i < VIDEO_PACKET_COUNT; i++) {
			expect(timestamps[i]).toBeCloseTo(sourceTimestamps[i]! - sourceStart, 4);
			expect(timestamps[VIDEO_PACKET_COUNT + i]).toBeCloseTo(secondPartStart + sourceTimestamps[i]! - sourceStart, 4);
		}
	});

	test('counts discontinuities from EXT-X-DISCONTINUITY-SEQUENCE', async () => {
		const files = await writeDiscontinuousStream('ts');
		const playlist = readText(files, 'joined.m3u8').replace('#EXTM3U\n', '#EXTM3U\n#EXT-X-DISCONTINUITY-SEQUENCE:7\n');
		files.set('joined.m3u8', encodeText(playlist));

		using input = createMemoryInput(files, 'joined.m3u8').input;
		const videoTrack = await input.getPrimaryVideoTrack();
		expect(await readPackets(videoTrack!)).toHaveLength(2 * VIDEO_PACKET_COUNT);
	});
});

describe('AES-128 encryption', () => {
	type EncryptOptions = {
		/** How the playlist declares the IV; 'sequence' omits it, so the Media Sequence Number is used. */
		iv: 'explicit' | 'short' | 'sequence';
		mediaSequence?: number;
		/** Index of the segment at which a second key takes over. */
		rotateAt?: number;
		/** Index of the segment from which segments are clear (METHOD=NONE). */
		clearFrom?: number;
	};

	const KEY_1 = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
	const KEY_2 = KEY_1.map(x => x ^ 0x5a);
	const EXPLICIT_IV = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6]);

	/** Encrypts the segments of a Mediabunny-written TS stream and writes a playlist declaring the keys. */
	const writeEncryptedStream = async (options: EncryptOptions) => {
		const files = await writeTsStream();
		const uris = getSegmentUris(readText(files, 'playlist-1.m3u8'));
		const mediaSequence = options.mediaSequence ?? 0;

		const keyTag = (keyUri: string) => {
			if (options.iv === 'explicit') {
				return `#EXT-X-KEY:METHOD=AES-128,URI="${keyUri}",IV=0x${toHex(EXPLICIT_IV)}`;
			} else if (options.iv === 'short') {
				return `#EXT-X-KEY:METHOD=AES-128,URI="${keyUri}",IV=0X1F`;
			} else {
				return `#EXT-X-KEY:METHOD=AES-128,URI="${keyUri}",KEYFORMAT="identity"`;
			}
		};

		files.set('keys/1.key', KEY_1);
		files.set('keys/2.key', KEY_2);

		let playlist = `#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${mediaSequence}\n`;
		playlist += keyTag('keys/1.key') + '\n';

		for (let i = 0; i < uris.length; i++) {
			const rotated = options.rotateAt !== undefined && i >= options.rotateAt;
			const clear = options.clearFrom !== undefined && i >= options.clearFrom;

			if (i === options.rotateAt) {
				playlist += keyTag('keys/2.key') + '\n';
			}
			if (i === options.clearFrom) {
				playlist += '#EXT-X-KEY:METHOD=NONE\n';
			}

			let iv = EXPLICIT_IV;
			if (options.iv === 'short') {
				iv = mediaSequenceIv(0x1f);
			} else if (options.iv === 'sequence') {
				iv = mediaSequenceIv(BigInt(mediaSequence) + BigInt(i));
			}

			const plaintext = files.get(uris[i]!)!;
			const encryptedUri = `enc-${i}.ts`;
			files.set(encryptedUri, clear ? plaintext : await encryptAes128Cbc(plaintext, rotated ? KEY_2 : KEY_1, iv));
			playlist += `#EXTINF:2,\n${encryptedUri}\n`;
		}

		playlist += '#EXT-X-ENDLIST\n';
		files.set('encrypted.m3u8', encodeText(playlist));

		return files;
	};

	const expectFullyDecrypted = async (files: MemoryFiles, writeClearStream = writeTsStream) => {
		using input = createMemoryInput(files, 'encrypted.m3u8').input;
		const { video, audio } = await getTrackPackets(input);
		expect(video).toHaveLength(VIDEO_PACKET_COUNT);
		expect(audio).toHaveLength(AUDIO_PACKET_COUNT);

		// Decrypted packets match those of the unencrypted stream
		using clearInput = createMemoryInput(await writeClearStream(), 'playlist-1.m3u8').input;
		const clear = await getTrackPackets(clearInput);
		for (const index of [0, 1, VIDEO_PACKET_COUNT - 1]) {
			expect(video[index]!.data).toEqual(clear.video[index]!.data);
			expect(video[index]!.timestamp).toBe(clear.video[index]!.timestamp);
		}
		expect(audio.at(-1)!.data).toEqual(clear.audio.at(-1)!.data);
	};

	test('decrypts segments with an explicit IV', async () => {
		await expectFullyDecrypted(await writeEncryptedStream({ iv: 'explicit' }));
	});

	test('zero-pads a short IV on the left', async () => {
		await expectFullyDecrypted(await writeEncryptedStream({ iv: 'short' }));
	});

	test.each([0, 7, 2 ** 32 - 2, 2 ** 40 + 3, Number.MAX_SAFE_INTEGER - 10])(
		'derives the IV from the Media Sequence Number as a 128-bit big-endian number (%d)',
		async (mediaSequence) => {
			await expectFullyDecrypted(await writeEncryptedStream({ iv: 'sequence', mediaSequence }));
		},
	);

	test('switches keys mid-playlist', async () => {
		const files = await writeEncryptedStream({ iv: 'sequence', rotateAt: 2 });
		await expectFullyDecrypted(files);
	});

	test('stops decrypting after METHOD=NONE', async () => {
		await expectFullyDecrypted(await writeEncryptedStream({ iv: 'sequence', clearFrom: 3 }));
	});

	test('fetches each key once', async () => {
		const files = await writeEncryptedStream({ iv: 'sequence', rotateAt: 2 });
		using memory = createMemoryInput(files, 'encrypted.m3u8');
		const { input, requests } = memory;
		await getTrackPackets(input);

		expect(requests.filter(path => path === 'keys/1.key')).toHaveLength(1);
		expect(requests.filter(path => path === 'keys/2.key')).toHaveLength(1);
	});

	test('uses the first 16 bytes of a longer key file', async () => {
		const files = await writeEncryptedStream({ iv: 'sequence' });
		files.set('keys/1.key', new Uint8Array([...KEY_1, 0x0a]));
		await expectFullyDecrypted(files);
	});

	test('rejects a key file shorter than 16 bytes', async () => {
		const files = await writeEncryptedStream({ iv: 'sequence' });
		files.set('keys/1.key', KEY_1.subarray(0, 8));

		using input = createMemoryInput(files, 'encrypted.m3u8').input;
		await expect(getTrackPackets(input)).rejects.toThrow('expected at least 16 bytes');
	});

	test('rejects a wrong key through the PKCS#7 padding check', async () => {
		const files = await writeEncryptedStream({ iv: 'sequence' });
		files.set('keys/1.key', KEY_2);

		using input = createMemoryInput(files, 'encrypted.m3u8').input;
		await expect(getTrackPackets(input)).rejects.toThrow();
	});

	test('decrypts encrypted byte ranges, each encrypted on its own', async () => {
		const files = await writeHls({ format: { segmentFormat: new MpegTsOutputFormat(), singleFilePerPlaylist: true } });
		const playlist = readText(files, 'playlist-1.m3u8');
		const uri = getSegmentUris(playlist)[0]!;
		const whole = files.get(uri)!;

		// Re-encrypt every range separately, as CBC restarts at every segment boundary (RFC 8216, Section 4.3.2.4)
		const parts: Uint8Array[] = [];
		const ranges = [...playlist.matchAll(/#EXT-X-BYTERANGE:(\d+)@(\d+)/g)].map(x => [Number(x[1]), Number(x[2])] as const);
		for (let i = 0; i < ranges.length; i++) {
			const [length, offset] = ranges[i]!;
			parts.push(await encryptAes128Cbc(whole.subarray(offset, offset + length), KEY_1, mediaSequenceIv(i)));
		}

		const joined = new Uint8Array(parts.reduce((sum, x) => sum + x.length, 0));
		let encryptedPlaylist = '#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="keys/1.key"\n';
		let position = 0;
		for (const part of parts) {
			joined.set(part, position);
			encryptedPlaylist += `#EXTINF:2,\n#EXT-X-BYTERANGE:${part.length}@${position}\nall.ts\n`;
			position += part.length;
		}
		encryptedPlaylist += '#EXT-X-ENDLIST\n';

		files.set('all.ts', joined);
		files.set('keys/1.key', KEY_1);
		files.set('encrypted.m3u8', encodeText(encryptedPlaylist));
		await expectFullyDecrypted(files);
	});

	test('decrypts an encrypted init section declared after the key', async () => {
		const files = await writeCmafStream();
		const playlist = readText(files, 'playlist-1.m3u8');

		let encryptedPlaylist = playlist.replace(
			'#EXT-X-MAP:URI="init-1.m4s"',
			`#EXT-X-KEY:METHOD=AES-128,URI="keys/1.key",IV=0x${toHex(EXPLICIT_IV)}\n#EXT-X-MAP:URI="enc-init.m4s"`,
		);
		files.set('enc-init.m4s', await encryptAes128Cbc(files.get('init-1.m4s')!, KEY_1, EXPLICIT_IV));

		for (const uri of getSegmentUris(playlist)) {
			files.set(`enc-${uri}`, await encryptAes128Cbc(files.get(uri)!, KEY_1, EXPLICIT_IV));
			encryptedPlaylist = encryptedPlaylist.replace(`\n${uri}\n`, `\nenc-${uri}\n`);
		}

		files.set('keys/1.key', KEY_1);
		files.set('encrypted.m3u8', encodeText(encryptedPlaylist));
		await expectFullyDecrypted(files, writeCmafStream);
	});

	test('requires an IV for an encrypted init section (RFC 8216, Section 4.3.2.5)', async () => {
		const files = await writeCmafStream();
		const playlist = readText(files, 'playlist-1.m3u8')
			.replace('#EXT-X-MAP:', '#EXT-X-KEY:METHOD=AES-128,URI="keys/1.key"\n#EXT-X-MAP:');

		using input = readVariant(files, playlist).input;
		await expect(input.getTracks()).rejects.toThrow('IV attribute must be set');
	});

	test('rejects unsupported key methods and formats', async () => {
		const files = await writeTsStream();
		const playlist = readText(files, 'playlist-1.m3u8');

		const cases: [string, string][] = [
			['#EXT-X-KEY:METHOD=AES-256,URI="k"', 'Unsupported encryption method'],
			['#EXT-X-KEY:METHOD=AES-128', 'requires a URI attribute'],
			['#EXT-X-KEY:METHOD=AES-128,URI="k",IV=123', 'Unsupported IV format'],
			['#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.apple.streamingkeydelivery"', 'only the \'identity\' KEYFORMAT'],
			['#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"', 'the \'identity\' KEYFORMAT is not supported'],
		];

		for (const [tag, error] of cases) {
			using input = readVariant(files, playlist.replace('#EXTINF', `${tag}\n#EXTINF`)).input;
			await expect(input.getTracks()).rejects.toThrow(error);
		}
	});

	test('refuses SAMPLE-AES for segments that aren\'t ISOBMFF', async () => {
		const files = await writeTsStream();
		const playlist = readText(files, 'playlist-1.m3u8').replace(
			'#EXTINF',
			'#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF',
		);

		using input = readVariant(files, playlist).input;
		await expect(input.getTracks()).rejects.toThrow('only supported for ISOBMFF files');
	});
});

describe('Program date time', () => {
	const withDateTimes = (playlist: string, dateTimeForSegment: (index: number) => string | null) => {
		let index = 0;
		return playlist.replaceAll(/#EXTINF/g, () => {
			const dateTime = dateTimeForSegment(index++);
			return (dateTime !== null ? `#EXT-X-PROGRAM-DATE-TIME:${dateTime}\n` : '') + '#EXTINF';
		});
	};

	test('maps the timeline to Unix time', async () => {
		const files = await writeTsStream();
		const playlist = withDateTimes(readText(files, 'playlist-1.m3u8'), i => (i === 0 ? '2026-01-01T00:00:00.000Z' : null));

		using input = readVariant(files, playlist).input;
		const videoTrack = await input.getPrimaryVideoTrack();
		const start = Date.parse('2026-01-01T00:00:00.000Z') / 1000;

		expect(await videoTrack!.isRelativeToUnixEpoch()).toBe(true);
		expect(await videoTrack!.getFirstTimestamp()).toBe(start);
		expect(await videoTrack!.getUnixTimeForTimestamp(start + 3)).toBe(start + 3);

		const packets = await readPackets(videoTrack!);
		expect(packets).toHaveLength(VIDEO_PACKET_COUNT);
		expect(presentationTimestamps(packets)[0]).toBe(start);
	});

	test('accepts ISO 8601 offsets with and without a colon, and fractional seconds', async () => {
		const files = await writeTsStream();
		const original = readText(files, 'playlist-1.m3u8');

		for (const dateTime of ['2026-01-01T01:00:00.250+01:00', '2026-01-01T01:00:00.250+0100', '2025-12-31T19:00:00.25-05:00']) {
			using input = readVariant(files, withDateTimes(original, i => (i === 0 ? dateTime : null))).input;
			const videoTrack = await input.getPrimaryVideoTrack();
			expect(await videoTrack!.getFirstTimestamp()).toBe(Date.parse('2026-01-01T00:00:00.250Z') / 1000);
		}
	});

	test('extrapolates backward when the first date time follows other segments', async () => {
		const files = await writeTsStream();
		const playlist = readText(files, 'playlist-1.m3u8');
		const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map(x => Number(x[1]));

		// Date the third segment only
		using input = readVariant(files, withDateTimes(playlist, i => (i === 2 ? '2026-01-01T00:00:10.000Z' : null))).input;
		const videoTrack = await input.getPrimaryVideoTrack();
		const expectedStart = Date.parse('2026-01-01T00:00:10.000Z') / 1000 - durations[0]! - durations[1]!;
		expect(await videoTrack!.getFirstTimestamp()).toBeCloseTo(expectedStart, 4);
	});

	test('ignores date times it can\'t parse', async () => {
		const files = await writeTsStream();
		using input = readVariant(files, withDateTimes(readText(files, 'playlist-1.m3u8'), () => 'yesterday')).input;
		const videoTrack = await input.getPrimaryVideoTrack();

		expect(await videoTrack!.isRelativeToUnixEpoch()).toBe(false);
		expect(await videoTrack!.getFirstTimestamp()).toBe(0);
	});

	test('keeps playlist time with offsetTimestampsByDateTime: false, yet still maps to Unix time', async () => {
		const files = await writeTsStream();
		const playlist = withDateTimes(readText(files, 'playlist-1.m3u8'), i => (i === 0 ? '2026-01-01T00:00:00.000Z' : null));

		using input = readVariant(files, playlist, { hls: { offsetTimestampsByDateTime: false } }).input;
		const videoTrack = await input.getPrimaryVideoTrack();
		expect(await videoTrack!.isRelativeToUnixEpoch()).toBe(false);
		expect(await videoTrack!.getFirstTimestamp()).toBe(0);
		expect(await videoTrack!.getUnixTimeForTimestamp(2)).toBe(Date.parse('2026-01-01T00:00:02.000Z') / 1000);
	});

	test('follows a date time jump at a discontinuity, so the timeline gets a gap', async () => {
		const files = await writeTsStream();
		const playlist = readText(files, 'playlist-1.m3u8');
		const uris = getSegmentUris(playlist);
		const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map(x => x[1]!);

		// The same media twice, the second time an hour later
		let joined = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z\n';
		for (let pass = 0; pass < 2; pass++) {
			if (pass === 1) {
				joined += '#EXT-X-DISCONTINUITY\n#EXT-X-PROGRAM-DATE-TIME:2026-01-01T01:00:00.000Z\n';
			}
			for (let i = 0; i < uris.length; i++) {
				joined += `#EXTINF:${durations[i]},\n${uris[i]}\n`;
			}
		}
		joined += '#EXT-X-ENDLIST\n';

		using input = readVariant(files, joined).input;
		const videoTrack = await input.getPrimaryVideoTrack();
		const timestamps = presentationTimestamps(await readPackets(videoTrack!));
		const start = Date.parse('2026-01-01T00:00:00.000Z') / 1000;

		expect(timestamps).toHaveLength(2 * VIDEO_PACKET_COUNT);
		expect(timestamps[0]).toBe(start);
		expect(timestamps[VIDEO_PACKET_COUNT]).toBe(start + 3600);
	});
});

describe('Multivariant playlists', () => {
	const readMaster = (text: string, rootPath = 'https://example.com/hls/master.m3u8') => {
		const requests: string[] = [];
		const input = new Input({
			source: new CustomPathedSource(rootPath, ({ path }) => {
				requests.push(path);
				if (path !== rootPath) {
					throw new Error(`Unexpected request for "${path}".`);
				}

				return new BufferSource(encodeText(text));
			}),
			formats: HLS_FORMATS,
		});

		return { input, requests, [Symbol.dispose]: () => input.dispose() };
	};

	test('exposes variant streams as paired tracks with the attributes of #EXT-X-STREAM-INF', async () => {
		using memory = readMaster(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,AVERAGE-BANDWIDTH=1500000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=30.000,NAME="High"
high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.4d401e,mp4a.40.5",RESOLUTION=640x360,CHANNELS="6"
low.m3u8
`);
		const { input, requests } = memory;

		const tracks = await input.getTracks();
		expect(tracks.map(x => x.type)).toEqual(['video', 'audio', 'video', 'audio']);

		const [highVideo, highAudio, lowVideo, lowAudio] = tracks;
		expect(await highVideo!.getCodec()).toBe('avc');
		expect(await highVideo!.getCodecParameterString()).toBe('avc1.64001f');
		expect(await highVideo!.getBitrate()).toBe(2000000);
		expect(await highVideo!.getAverageBitrate()).toBe(1500000);
		expect(await highVideo!.getName()).toBe('High');
		expect(await (highVideo as never as { getDisplayWidth: () => Promise<number> }).getDisplayWidth()).toBe(1280);

		expect(await highAudio!.getCodec()).toBe('aac');
		expect(await highAudio!.getCodecParameterString()).toBe('mp4a.40.2');
		expect(await lowAudio!.getCodecParameterString()).toBe('mp4a.40.5');
		expect(await (lowAudio as never as { getNumberOfChannels: () => Promise<number> }).getNumberOfChannels()).toBe(6);
		expect(await lowVideo!.getBitrate()).toBe(800000);
		expect(await lowVideo!.getAverageBitrate()).toBeNull();

		// Each variant's video and audio are pairable; tracks of different variants are not
		expect(highVideo!.canBePairedWith(highAudio!)).toBe(true);
		expect(lowVideo!.canBePairedWith(lowAudio!)).toBe(true);
		expect(highVideo!.canBePairedWith(lowAudio!)).toBe(false);

		// Nothing beyond the multivariant playlist was fetched
		expect(requests).toHaveLength(1);
	});

	test('builds tracks from alternate audio renditions shared by several variants', async () => {
		using memory = readMaster(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Français",LANGUAGE="fr-CA",AUTOSELECT=YES,CHANNELS="2",URI="audio/fr.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Commentary",LANGUAGE="en",AUTOSELECT=NO,URI="audio/commentary.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="aud"
video/high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.4d401e,mp4a.40.2",RESOLUTION=640x360,AUDIO="aud"
video/low.m3u8
`);
		const { input, requests } = memory;

		const videoTracks = await input.getVideoTracks();
		const audioTracks = await input.getAudioTracks();
		expect(videoTracks).toHaveLength(2);
		expect(audioTracks).toHaveLength(3);

		expect(await Promise.all(audioTracks.map(x => x.getName()))).toEqual(['English', 'Français', 'Commentary']);
		expect(await Promise.all(audioTracks.map(x => x.getLanguageCode()))).toEqual(['en', 'fr', 'en']);

		const dispositions = await Promise.all(audioTracks.map(x => x.getDisposition()));
		// HLS's DEFAULT=YES means "primary"; AUTOSELECT=YES maps to Mediabunny's "default"
		expect(dispositions.map(x => x.primary)).toEqual([true, false, false]);
		expect(dispositions.map(x => x.default)).toEqual([true, true, false]);

		// Renditions with a URI describe their own media, so the variant's bandwidth doesn't apply to them
		expect(await audioTracks[0]!.getBitrate()).toBeNull();

		// Every rendition pairs with every variant that references the group
		for (const audioTrack of audioTracks) {
			for (const videoTrack of videoTracks) {
				expect(videoTrack.canBePairedWith(audioTrack)).toBe(true);
			}
		}

		expect(requests).toHaveLength(1);
	});

	test('exposes alternate video renditions', async () => {
		using input = readMaster(`#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="cams",NAME="Main",DEFAULT=YES,URI="cam1.m3u8"
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="cams",NAME="Wide",URI="cam2.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.64001f",RESOLUTION=1280x720,VIDEO="cams"
cam1.m3u8
`).input;

		const videoTracks = await input.getVideoTracks();
		expect(await Promise.all(videoTracks.map(x => x.getName()))).toEqual(['Main', 'Wide']);
		expect((await videoTracks[0]!.getDisposition()).primary).toBe(true);
		expect((await videoTracks[1]!.getDisposition()).primary).toBe(false);
	});

	test('ignores subtitle and closed-caption renditions', async () => {
		using input = readMaster(`#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",FORCED=NO,URI="subs/en.m3u8"
#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC1",INSTREAM-ID="CC1"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.64001f,mp4a.40.2,wvtt",SUBTITLES="subs",CLOSED-CAPTIONS="cc"
main.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2",CLOSED-CAPTIONS=NONE
low.m3u8
`).input;
		expect((await input.getTracks()).map(x => x.type)).toEqual(['video', 'audio', 'video', 'audio']);
	});

	test('exposes I-frame variants as key-packet-only video tracks that pair with nothing', async () => {
		using input = readMaster(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720
main.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,CODECS="avc1.64001f",RESOLUTION=1280x720,URI="iframes.m3u8"
`).input;

		const tracks = await input.getTracks();
		expect(tracks.map(x => x.type)).toEqual(['video', 'audio', 'video']);
		expect(await tracks[2]!.hasOnlyKeyPackets()).toBe(true);
		expect(await tracks[0]!.hasOnlyKeyPackets()).toBe(false);
		expect(tracks[2]!.canBePairedWith(tracks[1]!)).toBe(false);

		// The regular variant is the primary video track
		expect(await input.getPrimaryVideoTrack()).toBe(tracks[0]);
	});

	test('ignores session tags and tags meant for media playlists', async () => {
		using input = readMaster(`#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-START:TIME-OFFSET=10
#EXT-X-SESSION-DATA:DATA-ID="com.example.title",VALUE="Example"
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-CONTENT-STEERING:SERVER-URI="steering.json"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2",SCORE=1.5,VIDEO-RANGE=SDR,HDCP-LEVEL=NONE
v.m3u8
#EXT-X-ENDLIST
`).input;
		expect(await input.getTracks()).toHaveLength(2);
	});

	test('skips codecs it doesn\'t know without dropping the others', async () => {
		using input = readMaster(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,stpp.ttml.im1t,ac-3"
v.m3u8
`).input;
		expect(await Promise.all((await input.getTracks()).map(x => x.getCodec()))).toEqual(['avc', 'ac3']);
	});

	test('rejects several video codecs in one variant', async () => {
		using input = readMaster(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,hvc1.1.6.L93.B0"
v.m3u8
`).input;
		await expect(input.getTracks()).rejects.toThrow('multiple video codecs');
	});

	test('rejects too many variant streams', async () => {
		let text = '#EXTM3U\n';
		for (let i = 0; i < 300; i++) {
			text += `#EXT-X-STREAM-INF:BANDWIDTH=${i + 1},CODECS="avc1.64001f"\nv${i}.m3u8\n`;
		}

		using input = readMaster(text).input;
		await expect(input.getTracks()).rejects.toThrow('too many variant streams');
	});

	test('reads codecs from the media when CODECS is missing', async () => {
		const files = await writeTsStream();
		const master = readText(files, 'master.m3u8').replace(/,CODECS="[^"]+"/, '');
		files.set('master.m3u8', encodeText(master));

		using input = createMemoryInput(files, 'master.m3u8').input;
		const tracks = await input.getTracks();
		expect(await Promise.all(tracks.map(x => x.getCodec()))).toEqual(['avc', 'aac']);
		expect(await tracks[0]!.getCodecParameterString()).toMatch(/^avc1\./);
	});

	test('reads media of variant and rendition playlists written by Mediabunny', async () => {
		const files = await writeHls({
			format: { segmentFormat: new MpegTsOutputFormat() },
			audioMetadata: { languageCode: 'fra', name: 'Audio' },
		});

		using input = createMemoryInput(files, 'master.m3u8').input;
		const { video, audio } = await getTrackPackets(input);
		expect(video).toHaveLength(VIDEO_PACKET_COUNT);
		expect(audio).toHaveLength(AUDIO_PACKET_COUNT);
	});

	test('rejects a codec in CODECS that doesn\'t match the media', async () => {
		const files = await writeTsStream();
		const master = readText(files, 'master.m3u8').replace(/CODECS="avc1\.[0-9a-f]+/, 'CODECS="hvc1.1.6.L93.B0');
		files.set('master.m3u8', encodeText(master));

		using input = createMemoryInput(files, 'master.m3u8').input;
		const videoTrack = await input.getPrimaryVideoTrack();
		expect(await videoTrack!.getCodec()).toBe('hevc');
		await expect(videoTrack!.getDecoderConfig()).rejects.toThrow('doesn\'t match the codec of the media data');
	});
});

describe('URI resolution', () => {
	test.each([
		['https://example.com/a/b/master.m3u8', 'v.m3u8', 'https://example.com/a/b/v.m3u8'],
		['https://example.com/a/b/master.m3u8', './v.m3u8', 'https://example.com/a/b/v.m3u8'],
		['https://example.com/a/b/master.m3u8', '../v.m3u8', 'https://example.com/a/v.m3u8'],
		['https://example.com/a/b/master.m3u8', 'c/../d/./v.m3u8', 'https://example.com/a/b/d/v.m3u8'],
		['https://example.com/a/b/master.m3u8', '/v.m3u8', 'https://example.com/v.m3u8'],
		['https://example.com/a/b/master.m3u8', 'https://cdn.example.org/v.m3u8', 'https://cdn.example.org/v.m3u8'],
		['https://example.com/a/b/master.m3u8', 'v.m3u8?token=a/b&x=1', 'https://example.com/a/b/v.m3u8?token=a/b&x=1'],
		['https://example.com/a/b/master.m3u8?session=1/2', 'v.m3u8', 'https://example.com/a/b/v.m3u8'],
		['https://user:pass@example.com:8443/a/master.m3u8', '/v.m3u8', 'https://user:pass@example.com:8443/v.m3u8'],
		['file:///media/hls/master.m3u8', 'v.m3u8', 'file:///media/hls/v.m3u8'],
		['hls/master.m3u8', 'v/stream.m3u8', 'hls/v/stream.m3u8'],
		['/srv/hls/master.m3u8', '../keys/k.bin', '/srv/keys/k.bin'],
	])('resolves %s + %s', (base, relative, expected) => {
		expect(joinPaths(base, relative)).toBe(expected);
	});

	test('resolves every URI of a playlist tree relative to the playlist that contains it', async () => {
		const files = await writeHls({
			format: {
				segmentFormat: new CmafOutputFormat(),
				getPlaylistPath: ({ n }) => `streams/${n}/index.m3u8`,
				getSegmentPath: ({ n, format }) => `../../media/seg-${n}${format.fileExtension}?v=1`,
				getInitPath: () => 'init.mp4',
			},
			rootPath: 'https://example.com/hls/master.m3u8',
		});

		// The writer produced the same tree layout the reader has to resolve
		expect([...files.keys()]).toContain('https://example.com/hls/streams/1/index.m3u8');
		expect([...files.keys()]).toContain('https://example.com/hls/streams/1/init.mp4');
		expect([...files.keys()]).toContain('https://example.com/hls/media/seg-1.m4s?v=1');

		using memory = createMemoryInput(files, 'https://example.com/hls/master.m3u8');
		const { input, requests } = memory;
		const { video, audio } = await getTrackPackets(input);
		expect(video).toHaveLength(VIDEO_PACKET_COUNT);
		expect(audio).toHaveLength(AUDIO_PACKET_COUNT);
		expect(requests.every(path => files.has(path))).toBe(true);
	});
});

describe('Live playlists', () => {
	/**
	 * A live server: every request for the playlist returns the current window of segments, then advances the live
	 * edge by one segment. #EXT-X-TARGETDURATION:0 keeps the refresh interval at its 0.5 s minimum.
	 */
	const createLiveServer = async (options: { windowSize: number; playlistType?: 'EVENT'; dateTime?: boolean }) => {
		const files = await writeTsStream();
		const playlist = readText(files, 'playlist-1.m3u8');
		const uris = getSegmentUris(playlist);
		const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map(x => Number(x[1]));

		let liveEdge = 1;
		let playlistRequests = 0;

		const source = new CustomPathedSource('live.m3u8', ({ path }) => {
			if (path !== 'live.m3u8') {
				const file = files.get(path);
				if (!file) {
					throw new Error(`No file at "${path}".`);
				}

				return new BufferSource(file);
			}

			playlistRequests++;
			const start = options.playlistType === 'EVENT' ? 0 : Math.max(0, liveEdge - options.windowSize);

			let text = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:0\n#EXT-X-MEDIA-SEQUENCE:${start}\n`;
			if (options.playlistType) {
				text += `#EXT-X-PLAYLIST-TYPE:${options.playlistType}\n`;
			}
			for (let i = start; i < liveEdge; i++) {
				if (options.dateTime) {
					const elapsed = durations.slice(0, i).reduce((a, b) => a + b, 0);
					text += `#EXT-X-PROGRAM-DATE-TIME:${new Date(Date.UTC(2026, 0, 1) + 1000 * elapsed).toISOString()}\n`;
				}
				text += `#EXTINF:${durations[i]},\n${uris[i]}\n`;
			}
			if (liveEdge === uris.length) {
				text += '#EXT-X-ENDLIST\n';
			}

			liveEdge = Math.min(uris.length, liveEdge + 1);
			return new BufferSource(encodeText(text));
		});

		return {
			source,
			get playlistRequests() {
				return playlistRequests;
			},
		};
	};

	test.each<[string, { windowSize: number; playlistType?: 'EVENT'; dateTime?: boolean }]>([
		['a sliding window', { windowSize: 2 }],
		['an EVENT playlist', { windowSize: Infinity, playlistType: 'EVENT' as const }],
		['date times', { windowSize: 2, dateTime: true }],
	])('waits for new segments of a growing live playlist (%s)', { timeout: 15_000 }, async (_, options) => {
		const server = await createLiveServer(options);
		using input = new Input({ source: server.source, formats: HLS_FORMATS });

		const videoTrack = await input.getPrimaryVideoTrack();
		expect(await videoTrack!.isLive()).toBe(true);
		expect(await videoTrack!.getLiveRefreshInterval()).toBe(0.5);

		const sink = new EncodedPacketSink(videoTrack!);
		const packets = [];
		for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
			packets.push(packet);
		}

		// Every packet arrives exactly once and in order, until the playlist ends
		expect(packets).toHaveLength(VIDEO_PACKET_COUNT);
		for (let i = 1; i < packets.length; i++) {
			expect(packets[i]!.sequenceNumber).toBeGreaterThan(packets[i - 1]!.sequenceNumber);
		}

		const timestamps = presentationTimestamps(packets);
		const start = options.dateTime ? Date.UTC(2026, 0, 1) / 1000 : 0;
		expect(timestamps[0]).toBe(start);
		for (let i = 1; i < timestamps.length; i++) {
			expect(timestamps[i]! - timestamps[i - 1]!).toBeCloseTo(0.04, 4);
		}

		expect(await videoTrack!.isLive()).toBe(false);
		expect(server.playlistRequests).toBeGreaterThanOrEqual(5);
	});

	test('returns the packets known so far with skipLiveWait', async () => {
		const server = await createLiveServer({ windowSize: 3 });
		using input = new Input({ source: server.source, formats: HLS_FORMATS });

		const videoTrack = await input.getPrimaryVideoTrack();
		const sink = new EncodedPacketSink(videoTrack!);

		const lastKnown = await sink.getPacket(Infinity, { skipLiveWait: true });
		expect(lastKnown).not.toBeNull();
		expect(lastKnown!.timestamp).toBeLessThan(2);
		expect(await videoTrack!.computeDuration({ skipLiveWait: true })).toBeLessThan(2.1);
		expect(server.playlistRequests).toBe(1);
	});
});

describe('Packed audio', () => {
	const writeAdtsStream = () => writeHls({ format: { segmentFormat: new AdtsOutputFormat() }, video: false });

	test('places packed audio segments by the timestamps in their ID3 PRIV frames', async () => {
		const files = await writeAdtsStream();
		const uris = getSegmentUris(readText(files, 'playlist-1.m3u8'));
		expect(uris[0]).toMatch(/\.aac$/);

		using input = createMemoryInput(files, 'playlist-1.m3u8').input;
		const audioTrack = await input.getPrimaryAudioTrack();
		const packets = await readPackets(audioTrack!);
		expect(packets).toHaveLength(AUDIO_PACKET_COUNT);

		const timestamps = presentationTimestamps(packets);
		for (let i = 1; i < timestamps.length; i++) {
			expect(timestamps[i]! - timestamps[i - 1]!).toBeCloseTo(1024 / 44100, 5);
		}
	});

	test('places packed audio segments without PRIV frames at their playlist position', async () => {
		const files = await writeAdtsStream();
		const playlist = readText(files, 'playlist-1.m3u8');

		// Strip the ID3 tags
		for (const uri of getSegmentUris(playlist)) {
			const bytes = files.get(uri)!;
			expect(new TextDecoder().decode(bytes.subarray(0, 3))).toBe('ID3');
			const tagSize = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
			files.set(uri, bytes.subarray(tagSize));
		}

		using input = createMemoryInput(files, 'playlist-1.m3u8').input;
		const audioTrack = await input.getPrimaryAudioTrack();
		const packets = await readPackets(audioTrack!);
		expect(packets).toHaveLength(AUDIO_PACKET_COUNT);

		const segmentStarts = [0];
		for (const match of playlist.matchAll(/#EXTINF:([\d.]+)/g)) {
			segmentStarts.push(segmentStarts.at(-1)! + Number(match[1]));
		}
		const timestamps = new Set(presentationTimestamps(packets));
		for (const start of segmentStarts.slice(0, -1)) {
			expect(timestamps.has(Math.round(start * 1e6) / 1e6)).toBe(true);
		}
	});

	test('keeps the timeline continuous when PRIV timestamps wrap around 2^33', async () => {
		// Start the media 3 s before the 33-bit MPEG-TS clock wraps (2^33 / 90 kHz = 95443.7 s)
		const files = await writeHls({
			format: { segmentFormat: new AdtsOutputFormat(), mediaTimestampBase: 2 ** 33 / 90000 - 3 },
			video: false,
		});

		using input = createMemoryInput(files, 'playlist-1.m3u8').input;
		const audioTrack = await input.getPrimaryAudioTrack();
		const timestamps = presentationTimestamps(await readPackets(audioTrack!));
		expect(timestamps).toHaveLength(AUDIO_PACKET_COUNT);
		expect(timestamps[0]).toBe(0);
		for (let i = 1; i < timestamps.length; i++) {
			expect(timestamps[i]! - timestamps[i - 1]!).toBeCloseTo(1024 / 44100, 4);
		}
	});
});

describe('Packet lookups across segments', () => {
	test('finds packets by timestamp and walks the stream in decode order', async () => {
		const files = await writeTsStream();
		using input = createMemoryInput(files, 'playlist-1.m3u8').input;

		const videoTrack = await input.getPrimaryVideoTrack();
		const sink = new EncodedPacketSink(videoTrack!);
		const packets = await readPackets(videoTrack!);

		// Looking up a timestamp inside a packet finds that packet, also across segment boundaries
		for (const packet of packets) {
			const middle = packet.timestamp + packet.duration / 2;
			expect((await sink.getPacket(middle))!.timestamp).toBe(packet.timestamp);
		}

		// getKeyPacket returns the last key packet at or before the timestamp
		const keyTimestamps = packets.filter(x => x.type === 'key').map(x => x.timestamp);
		expect(keyTimestamps).toHaveLength(5);
		for (const packet of packets) {
			const middle = packet.timestamp + packet.duration / 2;
			const expected = keyTimestamps.filter(x => x <= middle).at(-1)!;
			expect((await sink.getKeyPacket(middle))!.timestamp).toBe(expected);
		}

		// Walking with getNextPacket/getNextKeyPacket matches iteration
		let index = 0;
		for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
			expect(packet.timestamp).toBe(packets[index++]!.timestamp);
		}
		expect(index).toBe(packets.length);

		const walkedKeys = [];
		for (let packet = await sink.getFirstKeyPacket(); packet; packet = await sink.getNextKeyPacket(packet)) {
			walkedKeys.push(packet.timestamp);
		}
		expect(walkedKeys).toEqual(keyTimestamps);

		expect(await sink.getPacket(-1)).toBeNull();
		expect((await sink.getPacket(Infinity))!.timestamp).toBe(Math.max(...packets.map(x => x.timestamp)));
	});

	test('derives the duration from the playlist without loading segments', async () => {
		const files = await writeTsStream();
		const playlist = readText(files, 'playlist-1.m3u8');
		const total = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, x) => sum + Number(x[1]), 0);

		using memory = createMemoryInput(files, 'master.m3u8');
		const { input, requests } = memory;
		const videoTrack = await input.getPrimaryVideoTrack();
		expect(await videoTrack!.getDurationFromMetadata()).toBeCloseTo(total, 10);
		expect(requests.filter(path => path.endsWith('.ts'))).toHaveLength(0);

		expect(await videoTrack!.computeDuration()).toBeCloseTo(total, 1);
	});
});

describe('AES-128-CBC decryption stream', () => {
	const decryptAll = async (ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array) => {
		const stream = createAes128CbcDecryptStream(new Reader(new BufferSource(ciphertext)), () => ({ key, iv }), () => {});
		const chunks: Uint8Array[] = [];
		for await (const chunk of stream) {
			chunks.push(chunk);
		}

		const result = new Uint8Array(chunks.reduce((sum, x) => sum + x.length, 0));
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}

		return result;
	};

	const pattern = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + (i >> 8)) & 0xff);

	// The stream reads 64 KiB + 16 bytes at a time and holds back the last block, so sizes around those boundaries
	// exercise every path, including a final read of exactly one block
	test.each([0, 1, 15, 16, 17, 65519, 65520, 65535, 65536, 65551, 65552, 131071, 131072, 131087, 131088])(
		'matches Web Crypto for a %d-byte plaintext',
		async (length) => {
			const key = pattern(16).reverse();
			const iv = pattern(16);
			const plaintext = pattern(length);

			const ciphertext = await encryptAes128Cbc(plaintext, key, iv);
			expect(ciphertext.length % 16).toBe(0);

			const decrypted = await decryptAll(ciphertext, key, iv);
			expect(decrypted.length).toBe(plaintext.length);
			expect(decrypted).toEqual(plaintext);
		},
	);

	test('matches the FIPS-197 AES-128 test vector', async () => {
		// FIPS-197, Appendix C.1: single block, so CBC with a zero IV equals ECB. Append a full padding block encrypted
		// the same way to form a valid PKCS#7 message.
		const key = Uint8Array.from({ length: 16 }, (_, i) => i);
		const plaintextBlock = Uint8Array.from({ length: 16 }, (_, i) => i * 0x11);
		const ciphertext = await encryptAes128Cbc(plaintextBlock, key, new Uint8Array(16));
		expect(toHex(ciphertext.subarray(0, 16))).toBe('69c4e0d86a7b0430d8cdb78070b4c55a');

		expect(await decryptAll(ciphertext, key, new Uint8Array(16))).toEqual(plaintextBlock);
	});

	test('rejects ciphertext that isn\'t a multiple of the block size, or is empty', async () => {
		await expect(decryptAll(new Uint8Array(33), new Uint8Array(16), new Uint8Array(16))).rejects.toThrow('Invalid ciphertext');
		await expect(decryptAll(new Uint8Array(0), new Uint8Array(16), new Uint8Array(16))).rejects.toThrow('Invalid ciphertext');
	});

	test('rejects invalid padding lengths', async () => {
		const key = new Uint8Array(16);
		const iv = new Uint8Array(16);

		// Encrypt a block that decrypts to a padding byte of 0, then of 17, both invalid in PKCS#7
		for (const paddingByte of [0, 17]) {
			const block = new Uint8Array(16).fill(paddingByte);
			const ciphertext = (await encryptAes128Cbc(block, key, iv)).subarray(0, 16);
			await expect(decryptAll(ciphertext, key, iv)).rejects.toThrow('Invalid PKCS#7 padding');
		}
	});
});

describe('Fetching over HTTP', () => {
	test('resolves URIs against the final URL after redirects', async () => {
		const files = await writeTsStream();
		const media = readText(files, 'playlist-1.m3u8');
		const key = new Uint8Array(16).fill(7);

		// The media playlist lives behind two redirects; its segments are encrypted with a key next to them
		const encrypted = new Map<string, Uint8Array>();
		let mediaPlaylist = media.replace('#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-KEY:METHOD=AES-128,URI="../keys/k.bin"');
		for (const [i, uri] of getSegmentUris(media).entries()) {
			encrypted.set(`/final/media/${uri}`, await encryptAes128Cbc(files.get(uri)!, key, mediaSequenceIv(i)));
			mediaPlaylist = mediaPlaylist.replace(`\n${uri}\n`, `\n${uri}?token=a%2Fb\n`);
		}

		const requests: string[] = [];
		const notFound: string[] = [];
		const server = http.createServer((request, response) => {
			const url = new URL(request.url!, 'http://localhost');
			requests.push(url.pathname + url.search);

			const send = (status: number, body: Uint8Array | string, headers: Record<string, string> = {}) => {
				response.writeHead(status, { 'Content-Length': String(Buffer.byteLength(body)), ...headers });
				response.end(body);
			};

			if (url.pathname === '/start/master.m3u8') {
				send(302, '', { Location: '/moved/master.m3u8?session=1' });
			} else if (url.pathname === '/moved/master.m3u8') {
				send(200, readText(files, 'master.m3u8').replace('playlist-1.m3u8', 'variants/v.m3u8'));
			} else if (url.pathname === '/moved/variants/v.m3u8') {
				send(301, '', { Location: `http://localhost:${port}/final/media/v.m3u8` });
			} else if (url.pathname === '/final/media/v.m3u8') {
				send(200, mediaPlaylist);
			} else if (url.pathname === '/final/keys/k.bin') {
				send(200, key);
			} else if (encrypted.has(url.pathname) && url.searchParams.get('token') === 'a/b') {
				send(200, encrypted.get(url.pathname)!);
			} else {
				notFound.push(url.pathname + url.search);
				send(404, 'Not found');
			}
		});

		await new Promise<void>(resolve => server.listen(0, resolve));
		const address = server.address();
		assert(address && typeof address !== 'string');
		const port = address.port;

		try {
			using input = new Input({
				source: new UrlSource(`http://localhost:${port}/start/master.m3u8`),
				formats: HLS_FORMATS,
			});
			const { video, audio } = await getTrackPackets(input);
			expect(video).toHaveLength(VIDEO_PACKET_COUNT);
			expect(audio).toHaveLength(AUDIO_PACKET_COUNT);

			expect(requests).toContain('/final/keys/k.bin');
			expect(requests).toContain('/final/media/segment-1-1.ts?token=a%2Fb');
			expect(notFound).toEqual([]);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});
});
