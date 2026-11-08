import { expect, test, vi } from 'vitest';
import { Output, OutputTrackGroup } from '../../src/output.js';
import {
	AdtsOutputFormat,
	CmafOutputFormat,
	HlsOutputFormat,
	HlsOutputFormatOptions,
	HlsOutputSegmentInfo,
	Mp3OutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	WavOutputFormat,
} from '../../src/output-format.js';
import {
	AppendOnlyStreamTarget,
	BufferTarget,
	NullTarget,
	PathedTarget,
	StreamTarget,
	StreamTargetChunk,
} from '../../src/target.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { HlsMuxer } from '../../src/hls/hls-muxer.js';
import { AudioCodec, VideoCodec } from '../../src/codec.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedPacket, PacketType } from '../../src/packet.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';
import { Input } from '../../src/input.js';
import { BufferSource, CustomPathedSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Logging } from '../../src/logging.js';
const videoSource = (codec: VideoCodec = 'avc') => new EncodedVideoPacketSource(codec);
const audioSource = (codec: AudioCodec = 'aac') => new EncodedAudioPacketSource(codec);

test('Several codecs in one rendition group', async () => {
	// Video-only and audio-only outputs whose tracks differ in metadata and in codec make one rendition group each.
	// CODECS must list every codec of the group, so that each rendition reads back with its own codec.
	using mp4 = new Input({ source: new FilePathSource('./test/public/demo.mp4'), formats: ALL_FORMATS });
	using webm = new Input({ source: new FilePathSource('./test/public/demo.webm'), formats: ALL_FORMATS });

	const writeAndRead = async (
		sourceTracks: (InputVideoTrack | InputAudioTrack)[],
		expectedCodecStrings: string[],
	) => {
		const files = new Map<string, Uint8Array>();
		const output = new Output({
			format: new HlsOutputFormat({ segmentFormat: new CmafOutputFormat() }),
			target: new PathedTarget('master.m3u8', (request) => {
				const target = new BufferTarget();
				target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
				return target;
			}),
		});

		const adders: ((packet: EncodedPacket) => Promise<void>)[] = [];
		for (const [i, track] of sourceTracks.entries()) {
			const name = `Rendition ${i + 1}`;
			if (track.isVideoTrack()) {
				const source = new EncodedVideoPacketSource((await track.getCodec())!);
				output.addVideoTrack(source, { name });
				const decoderConfig = (await track.getDecoderConfig())!;
				adders.push(packet => source.add(packet, { decoderConfig }));
			} else {
				const source = new EncodedAudioPacketSource((await track.getCodec())!);
				output.addAudioTrack(source, { name });
				const decoderConfig = (await track.getDecoderConfig())!;
				adders.push(packet => source.add(packet, { decoderConfig }));
			}
		}

		await output.start();
		for (const [i, track] of sourceTracks.entries()) {
			for await (const packet of new EncodedPacketSink(track).packets()) {
				if (packet.timestamp >= 2) {
					break;
				}

				await adders[i]!(packet);
			}
		}
		await output.finalize();

		const master = new TextDecoder().decode(files.get('master.m3u8'));
		const codecs = /CODECS="([^"]+)"/.exec(master)![1]!.split(',');
		expect(new Set(codecs)).toEqual(new Set(expectedCodecStrings));

		using input = new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(files.get(path)!)),
			formats: ALL_FORMATS,
		});
		const tracks = await input.getTracks();
		const codecsOf = (list: { getCodec: () => Promise<unknown> }[]) => Promise.all(list.map(x => x.getCodec()));
		expect(await codecsOf(tracks)).toEqual(await codecsOf(sourceTracks));
		for (const track of tracks) {
			let count = 0;
			for await (const packet of new EncodedPacketSink(track).packets()) {
				void packet;
				count++;
			}
			expect(count).toBeGreaterThan(0);
		}
	};

	const avc = (await mp4.getPrimaryVideoTrack())!;
	const aac = (await mp4.getPrimaryAudioTrack())!;
	const vp9 = (await webm.getPrimaryVideoTrack())!;
	const opus = (await webm.getPrimaryAudioTrack())!;
	const avcCodecString = (await avc.getDecoderConfig())!.codec;
	const vp9CodecString = (await vp9.getDecoderConfig())!.codec;
	const aacCodecString = (await aac.getDecoderConfig())!.codec;

	await writeAndRead([vp9, avc], [vp9CodecString, avcCodecString]);
	await writeAndRead([aac, opus], [aacCodecString, 'Opus']);
	// A group in one codec lists it once, as before
	await writeAndRead([avc, avc], [avcCodecString]);
});

test('Playlist assignment, single video', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(1);
	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);
});

test('Playlist assignment, single audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(1);
	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple video', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple video with different metadata #1', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource(), { languageCode: 'eng' });
	output.addVideoTrack(videoSource(), { languageCode: 'esp' });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBe('video-1');
	expect(decl[0]!.references).toHaveLength(0);
	expect(decl[0]!.noUri).toBe(true);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBe('video-1');
	expect(decl[1]!.references).toHaveLength(0);
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual(decl.slice(0, 2));

	expect(decl[2]!.playlist).toBe(decl[0]!.playlist);
});

test('Playlist assignment, multiple video with different metadata #2', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource(), { disposition: { primary: true } });
	output.addVideoTrack(videoSource(), { disposition: { primary: false } });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBe('video-1');
	expect(decl[0]!.references).toHaveLength(0);
	expect(decl[0]!.noUri).toBe(true);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBe('video-1');
	expect(decl[1]!.references).toHaveLength(0);
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual(decl.slice(0, 2));

	expect(decl[2]!.playlist).toBe(decl[0]!.playlist);
});

test('Playlist assignment, multiple audio with different metadata', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addAudioTrack(audioSource(), { languageCode: 'eng' });
	output.addAudioTrack(audioSource(), { languageCode: 'esp' });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.references).toHaveLength(0);
	expect(decl[0]!.noUri).toBe(true);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.references).toHaveLength(0);
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual(decl.slice(0, 2));

	expect(decl[2]!.playlist).toBe(decl[0]!.playlist);
});

test('Playlist assignment, video and audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(1);
	expect(decl[0]!.playlist.tracks).toHaveLength(2);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);
});

test('Playlist assignment, one video and multiple audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(4);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[2]!.noUri).toBe(false);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual(decl.slice(0, 3));
});

test('Playlist assignment, multiple video and one audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(4);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toEqual([decl[0]!]);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual([decl[0]!]);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual([decl[0]!]);
});

test('Playlist assignment, multiple video and audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(6);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[2]!.groupId).toBe('audio-1');
	expect(decl[2]!.noUri).toBe(false);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual(decl.slice(0, 3));

	expect(decl[4]!.playlist.tracks).toHaveLength(1);
	expect(decl[4]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[4]!.groupId).toBeNull();
	expect(decl[4]!.references).toEqual(decl.slice(0, 3));

	expect(decl[5]!.playlist.tracks).toHaveLength(1);
	expect(decl[5]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[5]!.groupId).toBeNull();
	expect(decl[5]!.references).toEqual(decl.slice(0, 3));
});

test('Playlist assignment, video and audio in different groups', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: b });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple video and audio in pairs', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();
	const c = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });
	output.addVideoTrack(videoSource(), { group: c });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: c });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(2);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[0]!.playlist.tracks[1]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(2);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[1]!.playlist.tracks[1]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);

	expect(decl[2]!.playlist.tracks).toHaveLength(2);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.playlist.tracks[1]!.type).toBe('audio');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple video and audio with some unpaired', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();
	const c = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: c });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(6);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual(decl.slice(0, 2));

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual(decl.slice(0, 2));

	expect(decl[4]!.playlist.tracks).toHaveLength(1);
	expect(decl[4]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[4]!.groupId).toBeNull();
	expect(decl[4]!.references).toHaveLength(0);

	expect(decl[5]!.playlist.tracks).toHaveLength(1);
	expect(decl[5]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[5]!.groupId).toBeNull();
	expect(decl[5]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple video and audio with multiple groups', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });
	output.addVideoTrack(videoSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: b });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(8);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[2]!.groupId).toBe('audio-2');
	expect(decl[2]!.noUri).toBe(false);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[3]!.groupId).toBe('audio-2');
	expect(decl[3]!.noUri).toBe(false);

	expect(decl[4]!.playlist.tracks).toHaveLength(1);
	expect(decl[4]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[4]!.groupId).toBeNull();
	expect(decl[4]!.references).toEqual(decl.slice(0, 2));

	expect(decl[5]!.playlist.tracks).toHaveLength(1);
	expect(decl[5]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[5]!.groupId).toBeNull();
	expect(decl[5]!.references).toEqual(decl.slice(0, 2));

	expect(decl[6]!.playlist.tracks).toHaveLength(1);
	expect(decl[6]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[6]!.groupId).toBeNull();
	expect(decl[6]!.references).toEqual(decl.slice(2, 4));

	expect(decl[7]!.playlist.tracks).toHaveLength(1);
	expect(decl[7]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[7]!.groupId).toBeNull();
	expect(decl[7]!.references).toEqual(decl.slice(2, 4));
});

test('Playlist assignment, variant whose own playlist is a URI-less rendition counts it once', async () => {
	// Master playlist of an audio-only output with one AAC track per language
	const writeMaster = async (languages: string[]) => {
		let master = '';
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new AdtsOutputFormat(),
				onMaster: (text) => {
					master = text;
				},
			}),
			target: new PathedTarget('master.m3u8', () => new BufferTarget()),
		});
		const sources = languages.map(() => new EncodedAudioPacketSource('aac'));
		sources.forEach((source, i) => output.addAudioTrack(source, { languageCode: languages[i] }));
		await output.start();

		const frame = new Uint8Array(200); // Same 200-byte ADTS frame (48 kHz stereo) in every track
		frame.set([0xff, 0xf1, 0x4c, 0x80, 0x19, 0x1f, 0xfc]);
		const decoderConfig = { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000 };
		for (let i = 0; i < 200; i++) {
			for (const source of sources) {
				await source.add(
					new EncodedPacket(frame, 'key', i * 1024 / 48000, 1024 / 48000),
					i === 0 ? { decoderConfig } : undefined,
				);
			}
		}
		await output.finalize();
		return master;
	};

	const single = await writeMaster(['eng']);
	expect(single).toContain('CODECS="mp4a.40.2"'); // Control
	const singleBandwidth = Number(/BANDWIDTH=(\d+)/.exec(single)![1]);

	// Two languages: the variant points at playlist 1, which is also the group's URI-less first rendition. Its codec
	// is listed once (a duplicate makes hls.js reject MP3 renditions), and the bandwidth is that of one rendition, the
	// largest playable combination (RFC 8216, 4.3.4.2), not of two.
	const multi = await writeMaster(['eng', 'fra']);
	expect(multi).toMatch(/#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-1",NAME="eng-1"[^\n]*CHANNELS="2"\n/); // No URI
	expect(multi).toContain('CODECS="mp4a.40.2",AUDIO="audio-1"');
	expect(Number(/BANDWIDTH=(\d+)/.exec(multi)![1])).toBe(singleBandwidth);
});

test('Playlist assignment, video with multiple audio codecs', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource('aac'));
	output.addAudioTrack(audioSource('ac3'));

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(4);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.playlist.tracks[0]!.source._codec).toBe('aac');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.playlist.tracks[0]!.source._codec).toBe('ac3');
	expect(decl[1]!.groupId).toBe('audio-2');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual([decl[0]!]);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual([decl[1]!]);

	expect(decl[2]!.playlist).toBe(decl[3]!.playlist);
});

test('Playlist assignment, audio with multiple video codecs', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource('avc'));
	output.addVideoTrack(videoSource('hevc'));
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[1]!.playlist.tracks[0]!.source._codec).toBe('avc');
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toEqual([decl[0]!]);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.playlist.tracks[0]!.source._codec).toBe('hevc');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual([decl[0]!]);
});

test('Playlist assignment, multiple video with conflicting audio interests', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: [a, b] });
	output.addAudioTrack(audioSource(), { group: a });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(5);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[2]!.playlist).toBe(decl[0]!.playlist);
	expect(decl[2]!.groupId).toBe('audio-2');
	expect(decl[2]!.noUri).toBe(false);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual([decl[0]!, decl[1]!]);

	expect(decl[4]!.playlist.tracks).toHaveLength(1);
	expect(decl[4]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[4]!.groupId).toBeNull();
	expect(decl[4]!.references).toEqual([decl[2]!]);
});

test('Playlist assignment, video paired with video', async () => {
	const consoleSpy = vi.spyOn(console, 'warn');

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();
	a.pairWith(b);

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);

	expect(consoleSpy.mock.calls).toHaveLength(1);
	expect(consoleSpy.mock.calls[0]![0]).toContain('Illegal pairing');
});

test('Playlist assignment, audio paired with audio', async () => {
	const consoleSpy = vi.spyOn(console, 'warn');

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();
	a.pairWith(b);

	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: b });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);

	expect(consoleSpy.mock.calls).toHaveLength(1);
	expect(consoleSpy.mock.calls[0]![0]).toContain('Illegal pairing');
});

// eslint-disable-next-line @stylistic/max-len
const avcPacketData = new Uint8Array([0, 0, 0, 1, 9, 240, 0, 0, 0, 1, 39, 77, 64, 41, 169, 24, 15, 0, 68, 252, 184, 3, 80, 16, 16, 27, 108, 43, 94, 247, 192, 64, 0, 0, 0, 1, 40, 222, 9, 200, 0, 0, 1, 6, 0, 7, 128, 175, 200, 0, 0, 3, 0, 64, 128, 0, 0, 1, 6, 5, 17, 3, 135, 244, 78, 205, 10, 75, 220, 161, 148, 58, 195, 212, 155, 23, 31, 0, 128, 0, 0, 1, 37, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 175, 0, 0, 1, 37, 0, 127, 174, 8, 8, 8, 81, 49, 64, 0, 85, 230, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 147, 20, 0, 5, 94, 111, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 250, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 188, 0, 0, 1, 37, 0, 63, 203, 130, 2, 2, 20, 76, 80, 0, 21, 121, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 240, 0, 0, 1, 37, 0, 23, 234, 224, 128, 128, 133, 19, 20, 0, 5, 94, 111, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 249, 49, 64, 0, 85, 230, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 192, 0, 0, 1, 37, 0, 31, 226, 224, 128, 128, 133, 19, 20, 0, 5, 94, 111, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 250, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 188, 0, 0, 1, 37, 0, 9, 246, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 76, 80, 0, 21, 121, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 240, 0, 0, 1, 37, 0, 11, 244, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 175, 0, 0, 1, 37, 0, 13, 242, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 76, 80, 0, 21, 121, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 255, 248, 255, 4, 17, 64, 0, 69, 19, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 248]); ;
const avcMetadata: EncodedVideoChunkMetadata = {
	decoderConfig: {
		codec: 'avc1.4d401e',
		codedWidth: 1280,
		codedHeight: 720,
	},
};

// eslint-disable-next-line @stylistic/max-len
const aacPacketData = new Uint8Array([255, 241, 77, 128, 3, 159, 252, 0, 208, 0, 1, 3, 64, 0, 13, 0, 0, 17, 52, 0, 0, 208, 0, 3, 6, 128, 0, 56]);
const aacMetadata: EncodedAudioChunkMetadata = {
	decoderConfig: {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
	},
};

// A single 20 ms CELT fullband frame (TOC byte 0xfc) followed by some payload
const opusPacketData = new Uint8Array([252, 255, 254]);
const opusMetadata: EncodedAudioChunkMetadata = {
	decoderConfig: {
		codec: 'opus',
		numberOfChannels: 2,
		sampleRate: 48000,
	},
};

const setUpSegmentationEnvironment = async (options: {
	video?: boolean;
	audio?: boolean;
	mediaTimestampBase?: number;
} = {}) => {
	let result: string | null = null;
	let segmentCount = 0;
	let lastSegmentVideoTimestamps: Promise<number[]> = Promise.resolve([]);
	let lastSegmentAudioTimestamps: Promise<number[]> = Promise.resolve([]);

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(), // No ADTS for simplicity
			// So that segment timestamps can be compared directly
			mediaTimestampBase: options.mediaTimestampBase ?? 0,
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();
			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					result = new TextDecoder().decode(target.buffer!);
				});
			} else if (request.path.includes('segment')) {
				segmentCount++;

				const videoBundle = promiseWithResolvers<number[]>();
				lastSegmentVideoTimestamps = videoBundle.promise;
				const audioBundle = promiseWithResolvers<number[]>();
				lastSegmentAudioTimestamps = audioBundle.promise;

				target.on('finalized', async () => {
					try {
						using input = new Input({
							source: new BufferSource(target.buffer!),
							formats: ALL_FORMATS,
						});

						const videoTrack = await input.getPrimaryVideoTrack() as InputVideoTrack;
						if (videoTrack) {
							const sink = new EncodedPacketSink(videoTrack);
							const timestamps: number[] = [];
							for await (const packet of sink.packets()) {
								timestamps.push(packet.timestamp);
							}
							videoBundle.resolve(timestamps);
						} else {
							videoBundle.resolve([]);
						}

						const audioTrack = await input.getPrimaryAudioTrack() as InputAudioTrack;
						if (audioTrack) {
							const sink = new EncodedPacketSink(audioTrack);
							const timestamps: number[] = [];
							for await (const packet of sink.packets()) {
								timestamps.push(packet.timestamp);
							}
							audioBundle.resolve(timestamps);
						} else {
							audioBundle.resolve([]);
						}
					} catch {
						videoBundle.resolve([]);
						audioBundle.resolve([]);
					}
				});
			}

			return target;
		}),
	});

	const _videoSource = options.video ? new EncodedVideoPacketSource('avc') : null;
	const _audioSource = options.audio ? new EncodedAudioPacketSource('aac') : null;

	if (_videoSource) {
		output.addVideoTrack(_videoSource);
	}
	if (_audioSource) {
		output.addAudioTrack(_audioSource);
	}

	await output.start();

	const addVideoPacket = (timestamp: number, type: PacketType, duration = 0) => {
		assert(_videoSource);

		return _videoSource.add(
			new EncodedPacket(avcPacketData, type, timestamp, duration),
			avcMetadata,
		);
	};

	const addAudioPacket = (timestamp: number, duration = 0) => {
		assert(_audioSource);

		return _audioSource.add(
			new EncodedPacket(aacPacketData, 'key', timestamp, duration),
			aacMetadata,
		);
	};

	return {
		output,
		videoSource: _videoSource,
		audioSource: _audioSource,
		addVideoPacket,
		addAudioPacket,
		get segmentCount() { return segmentCount; },
		get result() { return result; },
		get lastSegmentVideoTimestamps() { return lastSegmentVideoTimestamps; },
		get lastSegmentAudioTimestamps() { return lastSegmentAudioTimestamps; },
	};
};

test('Segmentation, packets still queued when the track closes', async () => {
	const env = await setUpSegmentationEnvironment({ audio: true });

	await env.addAudioPacket(0, 0.5);
	// Not awaited, so these are still waiting for the playlist when the track gets closed
	const pending = [env.addAudioPacket(0.5, 0.5), env.addAudioPacket(1, 0.5)];
	env.audioSource!.close();

	await Promise.all(pending);
	await env.output.finalize();

	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1]);
});

test('Segmentation, empty', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.output.finalize();

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, simple', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:1.5,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'delta');
	expect(env.segmentCount).toBe(1);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5, 4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment with a final key packet', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(4, 'key');
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:0,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment with a final key packet (audio)', async () => {
	const env = await setUpSegmentationEnvironment({ audio: true });

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:0,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment with packet durations', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'delta', 0.5);
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key', 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(2.5, 'delta', 0.5);
	await env.addVideoPacket(3, 'delta', 0.5);
	await env.addVideoPacket(3.5, 'delta', 0.5);
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(4, 'key', 0.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:0.5,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment with packet durations (audio)', async () => {
	const env = await setUpSegmentationEnvironment({ audio: true });

	await env.addAudioPacket(0, 0.5);
	await env.addAudioPacket(0.5, 0.5);
	await env.addAudioPacket(1, 0.5);
	await env.addAudioPacket(1.5, 0.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2, 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addAudioPacket(2.5, 0.5);
	await env.addAudioPacket(3, 0.5);
	await env.addAudioPacket(3.5, 0.5);
	expect(env.segmentCount).toBe(1);
	await env.addAudioPacket(4, 0.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2, 2.5, 3, 3.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentAudioTimestamps).toEqual([4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:0.5,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, only one key packet', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'delta', 0.5);
	await env.addVideoPacket(2, 'delta', 0.5);
	await env.addVideoPacket(2.5, 'delta', 0.5);
	await env.addVideoPacket(3, 'delta', 0.5);
	expect(env.segmentCount).toBe(0);

	await env.output.finalize();
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:4
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:3.5,
segment-1-1.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, key packets before the end of a segment (maximized segment duration test)', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'key', 0.5);
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'delta', 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1]);
	await env.addVideoPacket(2.5, 'delta', 0.5);
	await env.addVideoPacket(3, 'key', 0.5);
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(3.5, 'delta', 0.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.5, 2, 2.5]);
	await env.addVideoPacket(4, 'delta', 0.5);
	await env.addVideoPacket(4.5, 'key', 0.5);
	expect(env.segmentCount).toBe(2);
	await env.addVideoPacket(5, 'key', 0.5);
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([3, 3.5, 4, 4.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(4);
	expect(await env.lastSegmentVideoTimestamps).toEqual([5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts
#EXTINF:1.5,
segment-1-2.ts
#EXTINF:2,
segment-1-3.ts
#EXTINF:0.5,
segment-1-4.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, full segment duration recovery after shorter segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'key', 0.5);
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'delta', 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1]);
	await env.addVideoPacket(2.5, 'delta', 0.5);
	await env.addVideoPacket(3, 'delta', 0.5);
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(3.5, 'key', 0.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.5, 2, 2.5, 3]);
	await env.addVideoPacket(4, 'delta', 0.5);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([3.5, 4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:1,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, packet start timestamp intersecting with end timestamp of previous packet', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'delta', 0.75); // This!
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key', 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:0.5,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, last video packet is included', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	expect(env.segmentCount).toBe(0);

	await env.output.finalize();
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, video not lining up with segment boundaries', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.45, 'key');
	await env.addVideoPacket(0.9, 'key');
	await env.addVideoPacket(1.35, 'key');
	await env.addVideoPacket(1.8, 'key');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2.25, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.45, 0.9, 1.35]);
	await env.addVideoPacket(2.7, 'key');
	await env.addVideoPacket(3.15, 'key');
	await env.addVideoPacket(3.6, 'key');
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(4.05, 'key');
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.8, 2.25, 2.7, 3.15]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([3.6, 4.05]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.8,
segment-1-1.ts
#EXTINF:1.8,
segment-1-2.ts
#EXTINF:0.45,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, audio not lining up with segment boundaries', async () => {
	const env = await setUpSegmentationEnvironment({ audio: true });

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.45);
	await env.addAudioPacket(0.9);
	await env.addAudioPacket(1.35);
	await env.addAudioPacket(1.8);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2.25);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.45, 0.9, 1.35]);
	await env.addAudioPacket(2.7);
	await env.addAudioPacket(3.15);
	await env.addAudioPacket(3.6);
	expect(env.segmentCount).toBe(1);
	await env.addAudioPacket(4.05);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentAudioTimestamps).toEqual([1.8, 2.25, 2.7, 3.15]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentAudioTimestamps).toEqual([3.6, 4.05]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.8,
segment-1-1.ts
#EXTINF:1.8,
segment-1-2.ts
#EXTINF:0.45,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, non-zero start time', async () => {
	const env = await setUpSegmentationEnvironment({
		video: true,
		audio: true,
		mediaTimestampBase: 1,
	});

	// The minimum packet timestamp becomes the first packet's start time
	await env.addVideoPacket(1, 'key');
	await env.addAudioPacket(0.5);
	env.audioSource!.close();
	await env.addVideoPacket(1.5, 'key');
	await env.addVideoPacket(2, 'key');
	await env.addVideoPacket(2.5, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1, 1.5, 2]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0.5]);

	await env.output.finalize();
	expect(await env.lastSegmentVideoTimestamps).toEqual([2.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:0,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, negative start time', async () => {
	const env = await setUpSegmentationEnvironment({
		video: true,
		mediaTimestampBase: -1,
	});
	const timestamps = Array.from({ length: 50 }, (_, index) => (index - 10) / 10);

	for (const timestamp of timestamps) {
		await env.addVideoPacket(timestamp, 'key', 0.1);

		if (timestamp === 1) {
			expect(env.segmentCount).toBe(1);
			expect(await env.lastSegmentVideoTimestamps).toEqual(timestamps.slice(0, 20));
		} else if (timestamp === 3) {
			expect(env.segmentCount).toBe(2);
			expect(await env.lastSegmentVideoTimestamps).toEqual(timestamps.slice(20, 40));
		}
	}

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual(timestamps.slice(40));

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:1,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, wholly negative timestamps', async () => {
	const env = await setUpSegmentationEnvironment({
		video: true,
		mediaTimestampBase: -1,
	});
	const timestamps = [-1, -0.9, -0.8, -0.7, -0.6];

	for (const timestamp of timestamps) {
		await env.addVideoPacket(timestamp, 'key', 0.1);
	}

	await env.output.finalize();
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual(timestamps);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:0.5,
segment-1-1.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, B-frames before key frame', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	await env.addVideoPacket(2, 'key');
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(1.75, 'delta');
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'key');
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 1.75, 2.5, 3, 3.5]);
	await env.addVideoPacket(4.5, 'delta');

	await env.output.finalize();
	expect(await env.lastSegmentVideoTimestamps).toEqual([4, 4.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:0.5,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, one video packet per segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 3);
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(3, 'key', 3);
	expect(env.segmentCount).toBe(1);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:3,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, one audio packet per segment', async () => {
	const env = await setUpSegmentationEnvironment({ audio: true });

	await env.addAudioPacket(0, 3);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(3, 3);
	expect(env.segmentCount).toBe(1);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:3,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, single segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	await env.addVideoPacket(2, 'key');

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:0,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, video dictates the segmentation', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'key');
	await env.addVideoPacket(2, 'delta');
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'delta');
	await env.addVideoPacket(4.5, 'key');

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1]);
	await env.addAudioPacket(2);
	await env.addAudioPacket(2.5);
	await env.addAudioPacket(3);
	await env.addAudioPacket(3.5);
	await env.addAudioPacket(4);
	expect(env.segmentCount).toBe(1);
	await env.addAudioPacket(4.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.5, 2, 2.5, 3, 3.5, 4]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([1.5, 2, 2.5, 3, 3.5, 4]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([4.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([4.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts
#EXTINF:0,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, video dictates the segmentation, inverted', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	await env.addAudioPacket(2);
	await env.addAudioPacket(2.5);
	await env.addAudioPacket(3);
	await env.addAudioPacket(3.5);
	await env.addAudioPacket(4);
	await env.addAudioPacket(4.5);

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'key');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'delta');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1]);
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'delta');
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(4.5, 'key');
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.5, 2, 2.5, 3, 3.5, 4]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([1.5, 2, 2.5, 3, 3.5, 4]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([4.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([4.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts
#EXTINF:0,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, audio ending after video', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	await env.addVideoPacket(2, 'key');
	await env.addVideoPacket(2.5, 'delta');

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addAudioPacket(2.5);
	await env.addAudioPacket(3);
	await env.addAudioPacket(3.5);
	expect(env.segmentCount).toBe(1);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2, 2.5, 3.0, 3.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:1.5,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, audio ending after video in separate segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	await env.addVideoPacket(2, 'key');
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'delta');
	await env.addVideoPacket(4.5, 'delta');
	env.videoSource!.close();

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addAudioPacket(2.5);
	await env.addAudioPacket(3);
	await env.addAudioPacket(3.5);
	await env.addAudioPacket(4);
	await env.addAudioPacket(4.5);
	expect(env.segmentCount).toBe(1);
	await env.addAudioPacket(5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5, 4, 4.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2, 2.5, 3, 3.5, 4, 4.5]);
	await env.addAudioPacket(5.5);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([5, 5.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts
#EXTINF:0.5,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, end timestamp with duration', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta', 0.25);

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5, 0.3);
	expect(env.segmentCount).toBe(0);

	await env.output.finalize();
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.8,
segment-1-1.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, closing writes segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);

	expect(env.segmentCount).toBe(0);

	env.videoSource!.close();
	await new Promise(resolve => setTimeout(resolve, 4));

	expect(env.segmentCount).toBe(0);

	env.audioSource!.close();
	await new Promise(resolve => setTimeout(resolve, 4));

	expect(env.segmentCount).toBe(1);

	await env.output.finalize();

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, variants of jittery live video end their segments at the same key frames', async () => {
	const playlists: string[] = [];
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			targetDuration: 1,
			live: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					playlists.push(new TextDecoder().decode(target.buffer!));
				});
			}

			return target;
		}),
	});

	// Two renditions of the same capture, like two video sources on one camera track
	const high = videoSource();
	const low = videoSource();
	output.addVideoTrack(high);
	output.addVideoTrack(low);
	await output.start();

	// 30 fps with up to 30 ms of timestamp jitter. Both encoders force a key frame on the first frame of every second
	// (keyFrameInterval: 1), the high one also on a scene cut in the middle of every second.
	for (let i = 0; i < 150; i++) {
		const timestamp = i / 30 + ((i * 7919) % 31) / 1000;
		const isForcedKeyFrame = i % 30 === 0;
		const isSceneCut = i % 30 === 17;
		await high.add(
			new EncodedPacket(avcPacketData, isForcedKeyFrame || isSceneCut ? 'key' : 'delta', timestamp, 1 / 30),
			avcMetadata,
		);
		await low.add(
			new EncodedPacket(avcPacketData, isForcedKeyFrame ? 'key' : 'delta', timestamp, 1 / 30),
			avcMetadata,
		);
	}

	await output.finalize();

	const getSegmentDurations = (playlist: string) => [...playlist.matchAll(/#EXTINF:([\d.]+),/g)]
		.map(match => Number(match[1]));
	const finalPlaylists = playlists.filter(playlist => playlist.includes('#EXT-X-ENDLIST'));
	expect(finalPlaylists).toHaveLength(2);
	const [durations, otherDurations] = finalPlaylists.map(getSegmentDurations);
	expect(durations).toHaveLength(5);
	expect(durations).toEqual(otherDurations);
	for (const duration of durations!) {
		expect(Math.round(duration)).toBe(1);
	}
});

test('Segmentation, VOD keeps segments within the target duration when key frames land a bit late', async () => {
	let playlist = '';
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			targetDuration: 2,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					playlist = new TextDecoder().decode(target.buffer!);
				});
			}

			return target;
		}),
	});
	const video = videoSource();
	output.addVideoTrack(video);
	await output.start();

	// 30 fps, a key frame every second; the ones at the 2 s boundaries land 10 ms late
	for (let i = 0; i < 180; i++) {
		const timestamp = i / 30 + (i % 60 === 0 && i > 0 ? 0.01 : 0);
		const type = i % 30 === 0 ? 'key' : 'delta';
		await video.add(new EncodedPacket(avcPacketData, type, timestamp, 1 / 30), avcMetadata);
	}
	await output.finalize();

	// VOD playlists announce the ceiling of their longest segment as the target duration
	expect(playlist).toContain('#EXT-X-TARGETDURATION:2\n');
	const segmentDurations = [...playlist.matchAll(/#EXTINF:([\d.]+),/g)].map(match => Number(match[1]));
	expect(Math.max(...segmentDurations)).toBeLessThanOrEqual(2);
});

test('write, onSegment, onPlaylist, onMaster events', async () => {
	const onSegment = vi.fn();
	const onPlaylist = vi.fn();
	const onMaster = vi.fn();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onSegment,
			onPlaylist,
			onMaster,
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	let targetWrites = 0;
	output.target.on('write', () => targetWrites++);

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	// First segment
	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	expect(onSegment).toHaveBeenCalledTimes(0);

	// Second segment starts, first one is finalized
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	expect(onSegment).toHaveBeenCalledTimes(1);
	expect(onSegment.mock.calls[0]![1]).toEqual(expect.objectContaining({ n: 1 }));

	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	expect(onPlaylist).not.toHaveBeenCalled();
	expect(onMaster).not.toHaveBeenCalled();

	await output.finalize();

	expect(targetWrites).toBeGreaterThan(0);

	// Second segment finalized on close
	expect(onSegment).toHaveBeenCalledTimes(2);
	expect(onSegment.mock.calls[1]![1]).toEqual(expect.objectContaining({ n: 2 }));

	// Both segment calls should have a Target as the first argument
	expect(onSegment.mock.calls[0]![0]).toBeDefined();
	expect(onSegment.mock.calls[1]![0]).toBeDefined();

	// Playlist and master should have been called once each
	expect(onPlaylist).toHaveBeenCalledTimes(1);
	expect(typeof onPlaylist.mock.calls[0]![0]).toBe('string');
	expect(onPlaylist.mock.calls[0]![0]).toContain('#EXTM3U');
	expect(onPlaylist.mock.calls[0]![1]).toEqual(expect.objectContaining({ n: 1 }));

	expect(onMaster).toHaveBeenCalledTimes(1);
	expect(typeof onMaster.mock.calls[0]![0]).toBe('string');
	expect(onMaster.mock.calls[0]![0]).toContain('#EXTM3U');
});

test('Single-file mode', async () => {
	let playlistText: string | null = null;
	const segmentPaths = new Set<string>();

	const onSegment = vi.fn();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			singleFilePerPlaylist: true,
			onSegment,
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();

			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					playlistText = new TextDecoder().decode(target.buffer!);
				});
			} else if (request.path.includes('segment')) {
				segmentPaths.add(request.path);
			}

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	expect(onSegment).toHaveBeenCalledTimes(0);

	await output.finalize();

	// Only one segment file should have been created
	expect(segmentPaths.size).toBe(1);

	expect(playlistText).not.toBeNull();
	expect(playlistText!.match(/#EXT-X-BYTERANGE/g)).toHaveLength(2);
	expect(playlistText).toContain('#EXT-X-VERSION:4');

	expect(onSegment).toHaveBeenCalledTimes(1);
});

test('MPEG-TS segments continue the continuity counters of the previous segment', async () => {
	// Players read a playlist's segments as one transport stream, so their counters must go on from one segment to the
	// next (H.222.0 2.4.3.3; Apple's HLS authoring spec 7.2: "continuity counters [...] MUST be sequential"), like
	// FFmpeg writes them, in separate segment files (found by L74) as well as in single-file mode
	for (const singleFilePerPlaylist of [false, true]) {
		const files = new Map<string, Uint8Array>();
		const output = new Output({
			format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat(), singleFilePerPlaylist }),
			target: new PathedTarget('', (request) => {
				const target = new BufferTarget();
				target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
				return target;
			}),
		});

		const video = videoSource();
		output.addVideoTrack(video);
		await output.start();

		for (let i = 0; i < 12; i++) {
			await video.add(new EncodedPacket(avcPacketData, i % 4 === 0 ? 'key' : 'delta', i / 2, 0), avcMetadata);
		}
		await output.finalize();

		// The segments in playlist order
		const segmentPaths = [...files.keys()].filter(path => path.endsWith('.ts')).sort((a, b) => {
			return Number(a.match(/(\d+)\.ts$/)![1]) - Number(b.match(/(\d+)\.ts$/)![1]);
		});
		expect(segmentPaths).toHaveLength(singleFilePerPlaylist ? 1 : 3);
		const segments = segmentPaths.map(path => files.get(path)!);
		const stream = new Uint8Array(segments.reduce((sum, segment) => sum + segment.length, 0));
		let offset = 0;
		for (const segment of segments) {
			stream.set(segment, offset);
			offset += segment.length;
		}

		const lastCounters = new Map<number, number>();
		let tableCount = 0;
		for (let pos = 0; pos < stream.length; pos += 188) {
			const pid = ((stream[pos + 1]! & 0x1f) << 8) | stream[pos + 2]!;
			if (pid === 0) {
				tableCount++;
			}

			if (!(stream[pos + 3]! & 0x10)) {
				continue; // No payload, so the counter doesn't go on
			}

			const counter = stream[pos + 3]! & 0xf;
			const lastCounter = lastCounters.get(pid);
			if (lastCounter !== undefined) {
				expect({ pid, counter }).toEqual({ pid, counter: (lastCounter + 1) % 16 });
			}

			lastCounters.set(pid, counter);
		}

		expect(tableCount).toBe(3); // A PAT in each segment
	}
});

test('Single-file mode with fragmented MP4 produces proper standalone segment file', async () => {
	let playlistText: string | null = null;
	let segmentBuffer: ArrayBuffer | null = null;
	const segmentPaths = new Set<string>();

	const onSegment = vi.fn();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new Mp4OutputFormat({
				fastStart: 'fragmented',
				minimumFragmentDuration: 0, // This is to be ignored
			}),
			singleFilePerPlaylist: true,
			onSegment,
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();

			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					playlistText = new TextDecoder().decode(target.buffer!);
				});
			} else if (request.path.includes('segment')) {
				segmentPaths.add(request.path);

				target.on('finalized', () => {
					segmentBuffer = target.buffer!;
				});
			}

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	expect(onSegment).toHaveBeenCalledTimes(0);

	await output.finalize();

	// Only one segment file should have been created
	expect(segmentPaths.size).toBe(1);

	expect(playlistText).not.toBeNull();
	expect(playlistText!.match(/#EXT-X-BYTERANGE/g)).toHaveLength(2);
	expect(playlistText).toContain('#EXT-X-VERSION:6');

	expect(onSegment).toHaveBeenCalledTimes(1);

	assert(segmentBuffer);

	const str = new TextDecoder('ascii').decode(segmentBuffer);
	expect(str.includes('mfra')).toBe(true); // It's a proper standalone fMP4 file
	expect(str.split('moov')).toHaveLength(2); // Only one moov box

	using input = new Input({
		source: new BufferSource(segmentBuffer),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const timestamps: number[] = [];
	const sink = new EncodedPacketSink(track);

	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
	}

	// Offset by the default media timestamp offset
	expect(timestamps).toEqual([10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5]);
});

test('Single-file fragmented MP4 segments end where the next one starts', async () => {
	// Each traf's decode time, and the decode time where its samples end
	const readTrafs = (bytes: Uint8Array) => {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const type = (pos: number) => String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
		const trafs: { decodeTime: number; end: number }[] = [];
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
			trafs.push({ decodeTime, end: decodeTime + duration });
		}
		return trafs;
	};

	// Packets with their exact durations, and packets without any
	for (const duration of [1001 / 30000, 0]) {
		let segments: ArrayBuffer | null = null;
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new Mp4OutputFormat({ fastStart: 'fragmented' }),
				singleFilePerPlaylist: true,
				targetDuration: 2,
			}),
			target: new PathedTarget('', (request) => {
				const target = new BufferTarget();
				if (request.path.includes('segment')) {
					target.on('finalized', () => {
						segments = target.buffer!;
					});
				}
				return target;
			}),
		});
		const source = new EncodedVideoPacketSource('vp9');
		output.addVideoTrack(source);
		await output.start();

		// 29.97 fps with timestamps rounded to milliseconds, as in WebM files from FFmpeg, and a key frame every 2 s
		for (let i = 0; i < 300; i++) {
			const timestamp = Math.round(i * 1001 / 30) / 1000;
			const packet = new EncodedPacket(new Uint8Array(1), i % 60 === 0 ? 'key' : 'delta', timestamp, duration);
			await source.add(packet, { decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 320, codedHeight: 180 } });
		}
		await output.finalize();

		// A traf's decode time must be the sum of all earlier sample durations (ISO/IEC 14496-12). Each segment's
		// last sample used to keep its packet duration: past the next segment's start, or 0 when packets had none.
		const trafs = readTrafs(new Uint8Array(segments!));
		expect(trafs).toHaveLength(5);
		for (let i = 1; i < trafs.length; i++) {
			expect(trafs[i]!.decodeTime).toBe(trafs[i - 1]!.end);
		}
	}
});

test('StreamTarget, write is called for each target', async () => {
	const writeCounts = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', (request) => {
			writeCounts.set(request.path, 0);

			const writable = new WritableStream<StreamTargetChunk>({
				write() {
					writeCounts.set(request.path, writeCounts.get(request.path)! + 1);
				},
			});

			return new StreamTarget(writable);
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	// Every StreamTarget should have been written to at least once
	for (const [path, count] of writeCounts) {
		expect(count, `Expected writes for ${path}`).toBeGreaterThanOrEqual(1);
	}
});

test('I-frame stream', async () => {
	let masterText = '';
	let playlistText = '';

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onMaster: (text) => { masterText = text; },
			onPlaylist: (text) => { playlistText = text; },
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	const source = videoSource();
	output.addVideoTrack(source, { hasOnlyKeyPackets: true });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	expect(muxer.playlistDeclarations).toHaveLength(1);
	expect(muxer.playlistDeclarations[0]!.playlist.tracks).toHaveLength(1);
	expect(muxer.playlistDeclarations[0]!.groupId).toBeNull();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 1), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 1, 1), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 1), avcMetadata);

	await output.finalize();

	expect(playlistText).toContain('#EXT-X-I-FRAMES-ONLY');
	expect(playlistText).toContain('#EXT-X-VERSION:4');

	expect(masterText).toContain('#EXT-X-I-FRAME-STREAM-INF:');
	expect(masterText).toMatch(/#EXT-X-I-FRAME-STREAM-INF:[^\n]*URI="/);
	expect(masterText).not.toContain('#EXT-X-STREAM-INF:');
});

test('I-frame stream, read back (a multivariant playlist with only I-frame variants)', async () => {
	// Mediabunny writes a video track declared with hasOnlyKeyPackets as an I-frame variant
	// (#EXT-X-I-FRAME-STREAM-INF), so HLS of only such a track has no regular variant to take timestamps from
	using sourceInput = new Input({ source: new FilePathSource('./test/public/edts.mp4'), formats: ALL_FORMATS });
	const sourceVideoTrack = await sourceInput.getPrimaryVideoTrack();
	assert(sourceVideoTrack);
	const decoderConfig = await sourceVideoTrack.getDecoderConfig();
	assert(decoderConfig);
	const keyPacket = await new EncodedPacketSink(sourceVideoTrack).getFirstKeyPacket();
	assert(keyPacket);

	const check = async (segmentFormat: MpegTsOutputFormat | CmafOutputFormat) => {
		const files = new Map<string, Uint8Array>();
		const output = new Output({
			format: new HlsOutputFormat({ segmentFormat, targetDuration: 1 }),
			target: new PathedTarget('master.m3u8', (request) => {
				const target = new BufferTarget();
				target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
				return target;
			}),
		});
		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source, { hasOnlyKeyPackets: true });
		await output.start();
		for (let i = 0; i < 72; i++) {
			const packet = new EncodedPacket(keyPacket.data, 'key', i / 24, 1 / 24);
			await source.add(packet, i === 0 ? { decoderConfig } : undefined);
		}
		await output.finalize();

		const master = new TextDecoder().decode(files.get('master.m3u8'));
		expect(master).toContain('#EXT-X-I-FRAME-STREAM-INF');
		expect(master).not.toContain('#EXT-X-STREAM-INF');

		using input = new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(files.get(path)!)),
			formats: ALL_FORMATS,
		});
		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);
		expect(await videoTrack.hasOnlyKeyPackets()).toBe(true);

		const sink = new EncodedPacketSink(videoTrack);
		let packetCount = 0;
		for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
			expect(packet.type).toBe('key');
			packetCount++;
		}
		expect(packetCount).toBe(72);
		expect(await input.computeDuration()).toBeCloseTo(3, 5);
	};

	await check(new MpegTsOutputFormat());
	await check(new CmafOutputFormat());
});

test('I-frame stream, pairing warning', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const group = new OutputTrackGroup();
	output.addVideoTrack(videoSource(), { hasOnlyKeyPackets: true, group });
	output.addAudioTrack(audioSource(), { group });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	// Despite being pairable, they must end up as separate unpaired declarations
	expect(muxer.playlistDeclarations).toHaveLength(2);
	expect(muxer.playlistDeclarations[0]!.playlist.tracks).toHaveLength(1);
	expect(muxer.playlistDeclarations[1]!.playlist.tracks).toHaveLength(1);
	expect(muxer.playlistDeclarations[0]!.groupId).toBeNull();
	expect(muxer.playlistDeclarations[1]!.groupId).toBeNull();

	expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('key-packets-only'));

	warnSpy.mockRestore();
});

test('I-frame stream next to a regular video track with other metadata', async () => {
	// Found by L17's round-trip fuzzing. The differing names used to put both (unpaired) video tracks into one
	// VIDEO rendition group, led by whichever track came first: with the I-frame track first, only an I-frame stream
	// was written and the regular track was unreachable; with the regular track first, the I-frames became a VIDEO
	// rendition
	const keyFrame = new Uint8Array([
		0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x0a, 0xd9, 0x06, 0x26, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04,
		0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x48, 0x99, 0x20,
		0, 0, 0, 1, 0x68, 0xcb, 0x83, 0xcb, 0x20,
		0, 0, 0, 1, 0x65, 0x88, 0x84, 0x10, 0x20, 0x40, 0x80, 0x01,
	]);
	const deltaFrame = new Uint8Array([0, 0, 0, 1, 0x41, 0x9a, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40]);
	const config = { decoderConfig: { codec: 'avc1.42c00a', codedWidth: 96, codedHeight: 64 } };

	for (const iFrameTrackFirst of [true, false]) {
		const files = new Map<string, BufferTarget>();
		const output = new Output({
			format: new HlsOutputFormat({ segmentFormat: new CmafOutputFormat(), targetDuration: 1 }),
			target: new PathedTarget('master.m3u8', ({ path }) => {
				const target = new BufferTarget();
				files.set(path, target);
				return target;
			}),
		});
		const regular = new EncodedVideoPacketSource('avc');
		const iFrames = new EncodedVideoPacketSource('avc');
		if (iFrameTrackFirst) {
			output.addVideoTrack(iFrames, { hasOnlyKeyPackets: true, name: 'Trick play' });
			output.addVideoTrack(regular, { name: 'Main' });
		} else {
			output.addVideoTrack(regular, { name: 'Main' });
			output.addVideoTrack(iFrames, { hasOnlyKeyPackets: true, name: 'Trick play' });
		}
		await output.start();
		for (let i = 0; i < 48; i++) {
			const isKey = i % 12 === 0;
			const meta = i === 0 ? config : undefined;
			const packet = new EncodedPacket(isKey ? keyFrame : deltaFrame, isKey ? 'key' : 'delta', i / 24, 1 / 24);
			await regular.add(packet, meta);
			if (isKey) {
				await iFrames.add(new EncodedPacket(keyFrame, 'key', i / 24, 0.5), meta);
			}
		}
		await output.finalize();

		// One variant stream for the regular track and an I-frame stream of its own for the key-packets-only track,
		// neither of them a VIDEO rendition
		const master = new TextDecoder().decode(files.get('master.m3u8')!.buffer!);
		expect((master.match(/#EXT-X-STREAM-INF:/g) ?? []).length).toBe(1);
		expect((master.match(/#EXT-X-I-FRAME-STREAM-INF:/g) ?? []).length).toBe(1);
		expect(master).not.toContain('TYPE=VIDEO');

		using input = new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(files.get(path)!.buffer!)),
			formats: ALL_FORMATS,
		});
		const tracks = await input.getVideoTracks();
		const keyOnly = await Promise.all(tracks.map(x => x.hasOnlyKeyPackets()));
		expect([...keyOnly].sort()).toEqual([false, true]);
		expect(await (await input.getPrimaryVideoTrack())!.hasOnlyKeyPackets()).toBe(false);

		let count = 0;
		for await (const packet of new EncodedPacketSink(tracks[keyOnly.indexOf(false)]!).packets()) {
			expect(packet.type).toBe(count % 12 === 0 ? 'key' : 'delta');
			count++;
		}
		expect(count).toBe(48);
	}
});

test('CMAF segmentation', async () => {
	let playlistText: string | null = null;
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					playlistText = new TextDecoder().decode(target.buffer!);
				});
			}

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	expect(targets.has('init-1.m4s')).toBe(true);
	expect(targets.has('segment-1-1.m4s')).toBe(true);
	expect(targets.has('segment-1-2.m4s')).toBe(true);

	expect(playlistText).toBe(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init-1.m4s"

#EXTINF:2,
segment-1-1.m4s
#EXTINF:1.5,
segment-1-2.m4s

#EXT-X-ENDLIST
`,
	);

	// Verify that each segment contains exactly 4 video packets
	const initTarget = targets.get('init-1.m4s')!;
	using initInput = new Input({
		source: new BufferSource(initTarget.buffer!),
		formats: ALL_FORMATS,
	});

	for (const segmentPath of ['segment-1-1.m4s', 'segment-1-2.m4s']) {
		const segmentTarget = targets.get(segmentPath)!;

		using segmentInput = new Input({
			source: new BufferSource(segmentTarget.buffer!),
			formats: ALL_FORMATS,
			initInput,
		});

		const videoTrack = await segmentInput.getPrimaryVideoTrack() as InputVideoTrack;
		expect(videoTrack).toBeTruthy();

		const sink = new EncodedPacketSink(videoTrack);
		let packetCount = 0;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		for await (const packet of sink.packets()) {
			packetCount++;
		}
		expect(packetCount).toBe(4);
	}
});

test('CMAF segmentation, single file per playlist', async () => {
	let playlistText: string | null = null;
	const writtenPaths = new Set<string>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			singleFilePerPlaylist: true,
		}),
		target: new PathedTarget('', (request) => {
			writtenPaths.add(request.path);
			const target = new BufferTarget();

			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					playlistText = new TextDecoder().decode(target.buffer!);
				});
			}

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	// Init and segment files should have been written
	expect(writtenPaths).toContain('segments-1.m4s');
	expect(writtenPaths).not.toContain('init-1.m4s');

	expect(playlistText).not.toBeNull();
	expect(playlistText!.match(/#EXT-X-BYTERANGE/g)).toHaveLength(2);
	expect(playlistText).toContain('#EXT-X-VERSION:6');
	expect(playlistText).toContain('#EXT-X-MAP:URI=');
});

test('Fragmented MP4 and CMAF segments end where the next segment starts', async () => {
	// Each traf's decode time, and the decode time where its samples end
	const readTrafs = (bytes: Uint8Array) => {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const type = (pos: number) => String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
		const trafs: { decodeTime: number; end: number }[] = [];
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
			trafs.push({ decodeTime, end: decodeTime + duration });
		}
		return trafs;
	};

	// The first track's timescale, from the moov box (at the start of a single-file playlist's segments file)
	const readTimescale = (bytes: Uint8Array) => {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const find = (start: number, end: number, name: string) => {
			for (let pos = start; pos < end; pos += view.getUint32(pos)) {
				if (String.fromCharCode(...bytes.subarray(pos + 4, pos + 8)) === name) {
					return pos;
				}
			}
			return null;
		};
		const moov = find(0, bytes.byteLength, 'moov');
		const trak = moov !== null ? find(moov + 8, moov + view.getUint32(moov), 'trak') : null;
		const mdia = trak !== null ? find(trak + 8, trak + view.getUint32(trak), 'mdia') : null;
		const mdhd = mdia !== null ? find(mdia + 8, mdia + view.getUint32(mdia), 'mdhd') : null;
		return mdhd !== null ? view.getUint32(mdhd + (bytes[mdhd + 8] === 1 ? 28 : 20)) : null;
	};

	type TestPacket = { timestamp: number; type: 'key' | 'delta'; duration: number };

	// Returns the joins between consecutive fragments of all segments (the next decode time minus the previous end),
	// and the track's timescale when a segment file holds the moov box
	const writeSegments = async (
		segmentFormat: Mp4OutputFormat | CmafOutputFormat,
		singleFilePerPlaylist: boolean,
		packets: TestPacket[],
		options: { audio?: boolean; frameRate?: number } = {},
	) => {
		const segments = new Map<string, Uint8Array>();
		const output = new Output({
			format: new HlsOutputFormat({ segmentFormat, singleFilePerPlaylist, targetDuration: 2 }),
			target: new PathedTarget('', (request) => {
				const target = new BufferTarget();
				if (request.path.includes('segment')) {
					target.on('finalized', () => {
						segments.set(request.path, new Uint8Array(target.buffer!));
					});
				}
				return target;
			}),
		});
		if (options.audio) {
			const source = new EncodedAudioPacketSource('aac');
			output.addAudioTrack(source);
			await output.start();
			const decoderConfig = {
				codec: 'mp4a.40.2',
				sampleRate: 44100,
				numberOfChannels: 2,
				description: new Uint8Array([0x12, 0x10]),
			};
			for (const { timestamp, type, duration } of packets) {
				await source.add(new EncodedPacket(new Uint8Array(20), type, timestamp, duration), { decoderConfig });
			}
		} else {
			const source = new EncodedVideoPacketSource('vp9');
			output.addVideoTrack(source, { frameRate: options.frameRate });
			await output.start();
			const decoderConfig = { codec: 'vp09.00.10.08', codedWidth: 320, codedHeight: 180 };
			for (const { timestamp, type, duration } of packets) {
				await source.add(new EncodedPacket(new Uint8Array(1), type, timestamp, duration), { decoderConfig });
			}
		}
		await output.finalize();

		const segmentNumber = (path: string) => Number(/(\d+)\.[a-z0-9]+$/.exec(path)![1]);
		const trafs = [...segments]
			.sort(([a], [b]) => segmentNumber(a) - segmentNumber(b))
			.flatMap(([, bytes]) => readTrafs(bytes));
		const joins = trafs.slice(1).map((x, i) => x.decodeTime - trafs[i]!.end);
		const timescale = [...segments.values()].map(readTimescale).find(x => x !== null) ?? null;
		return { joins, timescale };
	};

	// Each segment is written by its own muxer, so each one's last sample kept its packet duration, which could reach
	// past the next segment's start or end before it. A traf's decode time must be the sum of all earlier sample
	// durations (ISO/IEC 14496-12), also across segments, which players append one after the other.
	const configurations = [
		{ segmentFormat: new CmafOutputFormat(), singleFilePerPlaylist: false },
		{ segmentFormat: new CmafOutputFormat(), singleFilePerPlaylist: true },
		{ segmentFormat: new Mp4OutputFormat({ fastStart: 'fragmented' }), singleFilePerPlaylist: false },
	];
	for (const { segmentFormat, singleFilePerPlaylist } of configurations) {
		// 29.97 fps with timestamps rounded to milliseconds, as in WebM files from FFmpeg, and a key frame every 2 s:
		// each segment's last sample reached up to a third of a millisecond past the next segment's start
		const packets: TestPacket[] = [];
		for (let i = 0; i < 300; i++) {
			const timestamp = Math.round(i * 1001 / 30) / 1000;
			packets.push({ timestamp, type: i % 60 === 0 ? 'key' : 'delta', duration: 1001 / 30000 });
		}
		expect((await writeSegments(segmentFormat, singleFilePerPlaylist, packets)).joins).toEqual([0, 0, 0, 0]);

		// 60 fps: frames are 16 or 17 ms apart and last 16.67 ms each, so some segments ended a third of a millisecond
		// before the next one (9 GOPs, so that each segment has a single fragment)
		const packets60: TestPacket[] = [];
		for (let i = 0; i < 594; i++) {
			const timestamp = Math.round(i * 1000 / 60) / 1000;
			packets60.push({ timestamp, type: i % 66 === 0 ? 'key' : 'delta', duration: 1 / 60 });
		}
		const { joins: joins60 } = await writeSegments(segmentFormat, singleFilePerPlaylist, packets60);
		expect(joins60.length).toBeGreaterThan(3);
		expect(joins60.filter(x => x !== 0)).toEqual([]);
	}

	const cmaf = new CmafOutputFormat();

	// A real pause before a segment's first key frame stays
	const paused: TestPacket[] = [];
	for (let i = 0; i < 594; i++) {
		const timestamp = Math.round(i * 1000 / 60) / 1000 + (i >= 330 ? 0.5 : 0);
		paused.push({ timestamp, type: i % 66 === 0 ? 'key' : 'delta', duration: 1 / 60 });
	}
	const { joins: pausedJoins } = await writeSegments(cmaf, true, paused);
	expect(pausedJoins.filter(x => x !== 0)).toHaveLength(1);
	expect(pausedJoins.find(x => x !== 0)).toBeGreaterThan(1000);

	// So does a frame dropped right before one, even when that's a single tick of a frame rate timescale
	const dropped: TestPacket[] = [];
	for (let i = 0; i < 90; i++) {
		if (i !== 59) {
			dropped.push({ timestamp: i / 30, type: i % 30 === 0 ? 'key' : 'delta', duration: 1 / 30 });
		}
	}
	const { joins: droppedJoins, timescale } = await writeSegments(cmaf, true, dropped, { frameRate: 30 });
	expect(droppedJoins).toEqual([timescale! / 30]); // One frame, in ticks of the frame rate or a multiple of it

	// 44.1 kHz AAC with timestamps rounded to milliseconds, starting at -23 ms (encoder priming), with durations as
	// Matroska gives them: the gap to the next block. Segments then don't start on whole ticks.
	const aacTimestamp = (index: number) => Math.round((index - 1) * 1024 / 44.1) / 1000;
	const aac: TestPacket[] = [];
	for (let i = 0; i < 1300; i++) {
		aac.push({ timestamp: aacTimestamp(i), type: 'key', duration: aacTimestamp(i + 1) - aacTimestamp(i) });
	}
	const { joins: aacJoins } = await writeSegments(cmaf, true, aac, { audio: true });
	expect(aacJoins.length).toBeGreaterThan(10);
	expect(aacJoins.filter(x => x !== 0)).toEqual([]);
});

test('Sparse tracks in segments, MPEG-TS', async () => {
	await testSparseTracksInSegments({
		segmentFormat: new MpegTsOutputFormat(),
	});
});

test('Sparse tracks in segments, CMAF', async () => {
	await testSparseTracksInSegments({
		segmentFormat: new CmafOutputFormat(),
	});
});

test('Sparse tracks in segments, standard MP4', async () => {
	await testSparseTracksInSegments({
		segmentFormat: new Mp4OutputFormat(),
	});
});

test('CMAF segments stay on one timeline when a track starts below zero', async () => {
	// With a mediaTimestampBase of 0, a track whose encoder priming comes before the first packet starts below zero.
	// The first segment's muxer then moves that track up to zero and says so in the init segment's edit list, which
	// applies to every segment, so every later segment must be moved the same way.
	const check = async (singleFilePerPlaylist: boolean) => {
		const targets = new Map<string, BufferTarget>();
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new CmafOutputFormat(),
				targetDuration: 1,
				mediaTimestampBase: 0,
				singleFilePerPlaylist,
			}),
			target: new PathedTarget('master.m3u8', (request) => {
				const target = new BufferTarget();
				targets.set(request.path, target);
				return target;
			}),
		});
		const english = audioSource();
		const french = audioSource();
		output.addAudioTrack(english, { languageCode: 'eng' });
		output.addAudioTrack(french, { languageCode: 'fra' });
		await output.start();

		const frameDuration = 1024 / 48000;
		for (let i = 0; i < 150; i++) {
			// The French track starts with encoder priming, one frame before the first packet of the English one
			const timestamp = i * frameDuration;
			const primed = timestamp - frameDuration;
			await english.add(new EncodedPacket(aacPacketData, 'key', timestamp, frameDuration), aacMetadata);
			await french.add(new EncodedPacket(aacPacketData, 'key', primed, frameDuration), aacMetadata);
		}
		await output.finalize();

		using input = new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(targets.get(path)!.buffer!)),
			formats: ALL_FORMATS,
		});
		const tracks = await input.getAudioTracks();
		expect(tracks).toHaveLength(2);
		for (const track of tracks) {
			const sink = new EncodedPacketSink(track);
			const packets: EncodedPacket[] = [];
			for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
				packets.push(packet);
			}
			expect(packets).toHaveLength(150);

			// Every packet starts where the previous one ends, across segment boundaries too
			for (let i = 1; i < packets.length; i++) {
				expect(packets[i]!.timestamp).toBeCloseTo(packets[i - 1]!.timestamp + packets[i - 1]!.duration, 4);
			}
		}
	};

	await check(false);
	await check(true);
});

test('Sparse tracks in segments, fragmented MP4', async () => {
	await testSparseTracksInSegments({
		segmentFormat: new Mp4OutputFormat({ fastStart: 'fragmented' }),
	});
});

test('Sparse tracks in segments, fragmented MP4 + single file', async () => {
	await testSparseTracksInSegments({
		segmentFormat: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		singleFilePerPlaylist: true,
	});
});

test('Conversion copies AAC with encoder priming into HLS segments', async () => {
	// The AAC track of an ordinary MP4 starts with a priming packet before zero. The HLS muxer moves all media onto the
	// positive mediaTimestampBase, so negative timestamps never reach the segments and the track can be copied instead
	// of being re-encoded (or dropped, where no AAC encoder exists, like here)
	const convertDemo = async (segmentFormat: HlsOutputFormatOptions['segmentFormat'], keepVideo: boolean) => {
		const targets = new Map<string, BufferTarget>();
		const output = new Output({
			format: new HlsOutputFormat({ segmentFormat }),
			target: new PathedTarget('master.m3u8', (request) => {
				const target = new BufferTarget();
				targets.set(request.path, target);
				return target;
			}),
		});
		const conversion = await Conversion.init({
			input: new Input({ source: new FilePathSource('./test/public/demo.mp4'), formats: ALL_FORMATS }),
			output,
			video: { discard: !keepVideo },
			trim: { end: 2 },
			showWarnings: false,
		});

		return { conversion, targets };
	};

	// MPEG-TS segments: both tracks are copied, and the priming keeps the audio 1024 samples ahead of the video
	const { conversion, targets } = await convertDemo(new MpegTsOutputFormat(), true);
	expect(conversion.discardedTracks.map(x => `${x.track.type}: ${x.reason}`)).toEqual([]);
	expect(conversion.output.tracks.map(x => x.source.constructor.name))
		.toEqual(['EncodedVideoPacketSource', 'EncodedAudioPacketSource']);
	await conversion.execute();

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(targets.get(path)!.buffer!)),
		formats: ALL_FORMATS,
	});
	const videoStart = await (await input.getPrimaryVideoTrack())!.getFirstTimestamp();
	const audioStart = await (await input.getPrimaryAudioTrack())!.getFirstTimestamp();
	expect(audioStart - videoStart).toBeCloseTo(-1024 / 48000, 6);

	// ADTS segments, whose format has no timestamps at all
	const adts = await convertDemo(new AdtsOutputFormat(), false);
	expect(adts.conversion.utilizedTracks.map(x => x.type)).toEqual(['audio']);

	// Without a positive base, negative timestamps would reach the segments
	const zeroBaseFormat = new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat(), mediaTimestampBase: 0 });
	expect(zeroBaseFormat.negativeTimestampSupport).toBe('prefer-non-negative');
});

test('Conversion to HLS with a small mediaTimestampBase writes no negative (wrapped) PTS', async () => {
	// The base only moves media that starts less than the base before the first packet up to positive timestamps
	const readPtsValues = (bytes: Uint8Array) => {
		const values: number[] = [];
		for (let i = 0; i + 188 <= bytes.length; i += 188) {
			const packet = bytes.subarray(i, i + 188);
			const pid = ((packet[1]! & 0x1f) << 8) | packet[2]!;
			if (!(packet[1]! & 0x40) || pid === 0 || pid >= 0x1000) {
				continue;
			}

			const adaptationFieldControl = (packet[3]! >> 4) & 3;
			const pes = packet.subarray(4 + (adaptationFieldControl === 3 ? 1 + packet[4]! : 0));
			if (pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1 || !(pes[7]! & 0x80)) {
				continue;
			}

			const q = pes.subarray(9, 14);
			values.push(
				((q[0]! >> 1) & 7) * 2 ** 30 + q[1]! * 2 ** 22 + (q[2]! >> 1) * 2 ** 15 + q[3]! * 2 ** 7 + (q[4]! >> 1),
			);
		}

		return values;
	};

	const targets = new Map<string, BufferTarget>();
	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat(), mediaTimestampBase: 0.01 }),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);
			return target;
		}),
	});
	const conversion = await Conversion.init({
		input: new Input({ source: new FilePathSource('./test/public/demo.mp4'), formats: ALL_FORMATS }),
		output,
		trim: { end: 2 },
		showWarnings: false,
	});
	await conversion.execute();

	const segments = [...targets].filter(([path]) => path.endsWith('.ts'));
	expect(segments.length).toBeGreaterThan(0);
	for (const [path, target] of segments) {
		const ptsValues = readPtsValues(new Uint8Array(target.buffer!));
		expect(ptsValues.length, path).toBeGreaterThan(0);
		expect(Math.max(...ptsValues), path).toBeLessThan(2 ** 32); // Larger means a negative timestamp wrapped around
	}
});

test('Opus codec string in master playlist', async () => {
	let masterText = '';
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			onMaster: (text) => { masterText = text; },
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	const video = videoSource();
	const audio = audioSource('opus');
	output.addVideoTrack(video);
	output.addAudioTrack(audio);

	await output.start();

	await video.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);

	await audio.add(new EncodedPacket(opusPacketData, 'key', 0, 0.02), opusMetadata);
	await audio.add(new EncodedPacket(opusPacketData, 'key', 0.5, 0.02), opusMetadata);
	await audio.add(new EncodedPacket(opusPacketData, 'key', 1, 0.02), opusMetadata);
	await audio.add(new EncodedPacket(opusPacketData, 'key', 1.5, 0.02), opusMetadata);

	await output.finalize();

	// WebCodecs calls it "opus", but HLS clients expect "Opus", the ISOBMFF sample entry name. Safari refuses to play
	// the variant stream when given "opus".
	expect(masterText).toMatch(/CODECS="avc1\.[0-9A-Fa-f]+,Opus"/);

	// The HLS input must understand the string the HLS output writes
	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			const target = targets.get(path);
			assert(target);

			return new BufferSource(target.buffer!);
		}),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack() as InputAudioTrack;
	expect(audioTrack).toBeTruthy();
	expect(await audioTrack.getCodec()).toBe('opus');
});

test('MP3 and FLAC codec strings in master playlist', async () => {
	// WebCodecs calls them "mp3" and "flac", but CODECS takes RFC 6381 identifiers: "mp4a.40.34" and the ISOBMFF sample
	// entry name "fLaC" (Apple's HLS authoring spec, "Values for the CODECS attribute"). hls.js rejects the whole
	// manifest when given "mp3".
	const writeAudioOnly = async (fileName: string, segmentFormat: HlsOutputFormatOptions['segmentFormat']) => {
		using input = new Input({ source: new FilePathSource(`./test/public/${fileName}`), formats: ALL_FORMATS });
		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);
		const decoderConfig = (await audioTrack.getDecoderConfig())!;
		const codec = (await audioTrack.getCodec())!;

		let masterText = '';
		const targets = new Map<string, BufferTarget>();
		const output = new Output({
			format: new HlsOutputFormat({ segmentFormat, onMaster: (text) => { masterText = text; } }),
			target: new PathedTarget('master.m3u8', (request) => {
				const target = new BufferTarget();
				targets.set(request.path, target);
				return target;
			}),
		});
		const source = new EncodedAudioPacketSource(codec);
		output.addAudioTrack(source);
		await output.start();
		for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
			if (packet.timestamp >= 3) {
				break;
			}
			await source.add(packet, { decoderConfig });
		}
		await output.finalize();

		return { masterText, targets, codec };
	};

	for (const [fileName, segmentFormat, codecString] of [
		['Toothsome-Meme.VBRv2.mp3', new Mp3OutputFormat(), 'mp4a.40.34'],
		['sample.flac', new CmafOutputFormat(), 'fLaC'],
	] as const) {
		const { masterText, targets, codec } = await writeAudioOnly(fileName, segmentFormat);
		expect(masterText).toContain(`CODECS="${codecString}"`);

		// The HLS input must understand the string the HLS output writes
		using input = new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(targets.get(path)!.buffer!)),
			formats: ALL_FORMATS,
		});
		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);
		expect(await audioTrack.getCodec()).toBe(codec);
	}
});

test('Empty playlist bandwidth, from track metadata', async () => {
	let masterText = '';

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onMaster: (text) => { masterText = text; },
		}),
		target: new PathedTarget('master.m3u8', () => new BufferTarget()),
	});

	output.addVideoTrack(videoSource(), {
		bitrate: 2_000_000,
		averageBitrate: 1_500_000,
	});
	output.addAudioTrack(audioSource(), {
		bitrate: 128_000,
		averageBitrate: 100_000,
	});

	await output.start();
	await output.finalize();

	expect(masterText).toContain('BANDWIDTH=2128000,AVERAGE-BANDWIDTH=1600000,');
});

test('Empty playlist bandwidth, medium quality default fallback', async () => {
	let masterText = '';

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onMaster: (text) => { masterText = text; },
		}),
		target: new PathedTarget('master.m3u8', () => new BufferTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource());

	await output.start();
	await output.finalize();

	const bandwidth = Number(masterText.match(/BANDWIDTH=(\d+)/)![1]);
	expect(bandwidth).toBeGreaterThan(0);
});

/**
 * Writes two video packets and the given audio tracks, of which only those with `packets` get two packets, like a
 * conversion whose trim range ends before some of the audio starts. Returns the master playlist and the output.
 */
const writeTracksWithoutPackets = async (audioTracks: { codec: 'aac' | 'mp3'; packets: boolean }[]) => {
	let masterText = '';
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onMaster: (text) => { masterText = text; },
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	const video = videoSource();
	output.addVideoTrack(video);
	const audios = audioTracks.map(({ codec }) => {
		const audio = audioSource(codec);
		output.addAudioTrack(audio);
		return audio;
	});

	await output.start();
	await video.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	for (let i = 0; i < audioTracks.length; i++) {
		if (audioTracks[i]!.packets) {
			assert(audioTracks[i]!.codec === 'aac');
			await audios[i]!.add(new EncodedPacket(aacPacketData, 'key', 0, 0.02), aacMetadata);
			await audios[i]!.add(new EncodedPacket(aacPacketData, 'key', 0.5, 0.02), aacMetadata);
		}
	}
	await output.finalize();

	const input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			const target = targets.get(path);
			assert(target);

			return new BufferSource(target.buffer!);
		}),
		formats: ALL_FORMATS,
	});

	return { masterText, input };
};

test('A muxed track without packets is left out of the variant', async () => {
	const result = await writeTracksWithoutPackets([{ codec: 'mp3', packets: false }]);
	using input = result.input;

	expect(result.masterText).toMatch(/CODECS="avc1\.[0-9A-Fa-f]+"/);

	const tracks = await input.getTracks();
	expect(tracks.map(track => track.type)).toEqual(['video']);
	expect(await tracks[0]!.getCodec()).toBe('avc');
	expect(await input.computeDuration()).toBe(1);
});

test('Renditions without packets are left out of the master playlist', async () => {
	// Two audio tracks go into an #EXT-X-MEDIA group; with neither getting packets, the group is left out
	const empty = await writeTracksWithoutPackets([
		{ codec: 'mp3', packets: false },
		{ codec: 'mp3', packets: false },
	]);
	using emptyInput = empty.input;

	expect(empty.masterText).toMatch(/CODECS="avc1\.[0-9A-Fa-f]+"/);
	expect(empty.masterText).not.toContain('#EXT-X-MEDIA');
	expect(empty.masterText).not.toContain('AUDIO=');
	expect((await emptyInput.getTracks()).map(track => track.type)).toEqual(['video']);
	expect(await emptyInput.computeDuration()).toBe(1);

	// Only the rendition without packets is left out of a group
	const partial = await writeTracksWithoutPackets([
		{ codec: 'aac', packets: false },
		{ codec: 'aac', packets: true },
	]);
	using partialInput = partial.input;

	expect(partial.masterText.match(/#EXT-X-MEDIA:/g)).toHaveLength(1);
	expect(partial.masterText).toMatch(/CODECS="avc1\.[0-9A-Fa-f]+,mp4a\.40\.2",.*AUDIO="audio-1"/);
	expect((await partialInput.getTracks()).map(track => track.type).sort()).toEqual(['audio', 'video']);
	expect(await partialInput.computeDuration()).toBe(1);

	// Audio tracks of two codecs make two variants of the same video playlist, each with its own group; the one
	// whose group is left out isn't listed either
	const twoGroups = await writeTracksWithoutPackets([
		{ codec: 'aac', packets: true },
		{ codec: 'mp3', packets: false },
	]);
	using twoGroupsInput = twoGroups.input;

	expect(twoGroups.masterText.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(1);
	expect(twoGroups.masterText.match(/#EXT-X-MEDIA:/g)).toHaveLength(1);
	expect(twoGroups.masterText).not.toContain('mp3');
	expect((await twoGroupsInput.getTracks()).map(track => track.type).sort()).toEqual(['audio', 'video']);
	expect(await twoGroupsInput.computeDuration()).toBe(1);
});

const testSparseTracksInSegments = async (hlsOptions: HlsOutputFormatOptions) => {
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat(hlsOptions),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	const video = videoSource();
	const audio = audioSource();
	output.addVideoTrack(video);
	output.addAudioTrack(audio);

	await output.start();

	// We expect three segments: First one with just video, second with video and audio, last one with just audio.

	await video.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await video.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await audio.add(new EncodedPacket(aacPacketData, 'key', 2, 0), aacMetadata);
	await audio.add(new EncodedPacket(aacPacketData, 'key', 2.5, 0), aacMetadata);
	await audio.add(new EncodedPacket(aacPacketData, 'key', 3, 0), aacMetadata);
	await audio.add(new EncodedPacket(aacPacketData, 'key', 3.5, 0), aacMetadata);
	await audio.add(new EncodedPacket(aacPacketData, 'key', 4, 0), aacMetadata);
	await audio.add(new EncodedPacket(aacPacketData, 'key', 4.5, 0), aacMetadata);
	await audio.add(new EncodedPacket(aacPacketData, 'key', 5, 0), aacMetadata);
	await audio.add(new EncodedPacket(aacPacketData, 'key', 5.5, 0), aacMetadata);

	await output.finalize();

	// Read the entire output back using the HLS input
	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			const target = targets.get(path);
			assert(target);

			return new BufferSource(target.buffer!);
		}),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack() as InputVideoTrack;
	expect(videoTrack).toBeTruthy();
	const audioTrack = await input.getPrimaryAudioTrack() as InputAudioTrack;
	expect(audioTrack).toBeTruthy();

	const videoSink = new EncodedPacketSink(videoTrack);
	const videoTimestamps: number[] = [];
	for await (const packet of videoSink.packets()) {
		videoTimestamps.push(packet.timestamp);
	}
	expect(videoTimestamps).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);

	const audioSink = new EncodedPacketSink(audioTrack);
	const audioTimestamps: number[] = [];
	for await (const packet of audioSink.packets()) {
		audioTimestamps.push(packet.timestamp);
	}
	expect(audioTimestamps).toEqual([2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]);
};

const writeHlsWithDates = async (
	addMedia: (output: Output) => Promise<void>,
	// Returns the #EXT-X-PROGRAM-DATE-TIME (in Unix seconds) for each segment, or null to leave it undated
	getDate: (segmentIndex: number, durationsBefore: number[]) => number | null,
	discontinuityBefore = (segmentIndex: number) => segmentIndex < 0,
) => {
	const targets = new Map<string, BufferTarget>();
	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat(), targetDuration: 1 }),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);
			return target;
		}),
	});
	await addMedia(output);

	const durations: number[] = [];
	const playlist = new TextDecoder().decode(targets.get('playlist-1.m3u8')!.buffer!)
		.replace(/#EXTINF:([\d.]+),/g, (match, duration: string) => {
			const discontinuity = discontinuityBefore(durations.length) ? '#EXT-X-DISCONTINUITY\n' : '';
			const date = getDate(durations.length, durations);
			durations.push(Number(duration));
			const dateTag = date === null ? '' : `#EXT-X-PROGRAM-DATE-TIME:${new Date(1000 * date).toISOString()}\n`;
			return discontinuity + dateTag + match;
		});

	const openInput = (offsetTimestampsByDateTime: boolean, rootPath = 'playlist-1.m3u8', readableSegments = true) => {
		return new Input({
			source: new CustomPathedSource(rootPath, ({ path }) => {
				if (path === 'playlist-1.m3u8') {
					return new BufferSource(new TextEncoder().encode(playlist));
				}
				if (!readableSegments && path !== 'master.m3u8') {
					throw new Error(`${path} is unavailable`);
				}

				return new BufferSource(targets.get(path)!.buffer!);
			}),
			formats: ALL_FORMATS,
			formatOptions: { hls: { offsetTimestampsByDateTime } },
		});
	};

	return { durations, openInput };
};

test('Unix times follow each segment\'s own program date time when the dates drift from the media', async () => {
	// Segments dated from a wall clock while the media follows the encoder's clock: each date lies a bit later than
	// the previous one plus the segment's duration. A date applies to the first sample of its segment (RFC 8216,
	// 4.3.2.6), and undated segments are dated from the last date by media time.
	const start = Date.parse('2026-01-01T00:00:00.000Z') / 1000;
	const addAudio = async (output: Output) => {
		const audio = audioSource();
		output.addAudioTrack(audio);
		await output.start();
		for (let i = 0; i * 1024 / 48000 < 8; i++) {
			await audio.add(new EncodedPacket(aacPacketData, 'key', i * 1024 / 48000, 1024 / 48000), aacMetadata);
		}
		await output.finalize();
	};

	const check = async (datedEvery: number, offsetTimestampsByDateTime: boolean) => {
		const dates: number[] = [];
		const { durations, openInput } = await writeHlsWithDates(addAudio, (index, durationsBefore) => {
			if (index % datedEvery !== 0) {
				return null;
			}

			const date = start + durationsBefore.reduce((a, b) => a + b, 0) + 0.25 * index;
			dates.push(date);
			return date;
		});

		using input = openInput(offsetTimestampsByDateTime);
		const track = (await input.getPrimaryAudioTrack())!;
		let segmentStart = (await new EncodedPacketSink(track).getFirstPacket())!.timestamp;
		for (let i = 0; i < durations.length; i++) {
			// The date in effect, plus the media time since the segment it was given for, plus half a second
			const dateIndex = Math.floor(i / datedEvery);
			const sinceDate = durations.slice(dateIndex * datedEvery, i).reduce((a, b) => a + b, 0);
			const expected = dates[dateIndex]! + sinceDate + 0.5;
			expect(await track.getUnixTimeForTimestamp(segmentStart + 0.5), `segment ${i}`).toBeCloseTo(expected, 2);
			segmentStart += durations[i]!;
		}
	};

	for (const datedEvery of [1, 2]) {
		await check(datedEvery, true);
		await check(datedEvery, false);
	}

	// When the media can't be read, the playlist's timeline is all there is, as before
	const { openInput } = await writeHlsWithDates(addAudio, (index, durationsBefore) => {
		return start + durationsBefore.reduce((a, b) => a + b, 0) + 0.25 * index;
	});
	using unreadableInput = openInput(true, 'master.m3u8', false);
	const unreadableTrack = (await unreadableInput.getPrimaryAudioTrack())!;
	expect(await unreadableTrack.getUnixTimeForTimestamp(start + 3.5)).toBeCloseTo(start + 3.5, 6);
});

test('Muxed tracks map a timestamp to the same Unix time', async () => {
	// The tracks of a segment share its timeline, so its date maps their timestamps alike, even when the audio starts
	// a bit before the video (encoder priming)
	const start = Date.parse('2026-01-01T00:00:00.000Z') / 1000;
	const { openInput } = await writeHlsWithDates(async (output) => {
		const group = new OutputTrackGroup();
		const video = videoSource();
		const audio = audioSource();
		output.addVideoTrack(video, { group });
		output.addAudioTrack(audio, { group });
		await output.start();
		for (let i = 0; i < 8; i++) {
			await video.add(new EncodedPacket(avcPacketData, i % 2 === 0 ? 'key' : 'delta', 0.5 * i, 0.5), avcMetadata);
		}
		for (let i = -1; i * 1024 / 48000 < 4; i++) {
			await audio.add(new EncodedPacket(aacPacketData, 'key', i * 1024 / 48000, 1024 / 48000), aacMetadata);
		}
		await output.finalize();
	}, (_, durationsBefore) => start + durationsBefore.reduce((a, b) => a + b, 0));

	using input = openInput(true);
	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const audioTrack = (await input.getPrimaryAudioTrack())!;
	const firstTimestamp = await videoTrack.getFirstTimestamp();
	for (const offset of [0.25, 1.25, 2.25, 3.25]) {
		const timestamp = firstTimestamp + offset;
		expect(await audioTrack.getUnixTimeForTimestamp(timestamp))
			.toBeCloseTo((await videoTrack.getUnixTimeForTimestamp(timestamp))!, 6);
	}
});

test('Unix times after a discontinuity with a gap in its dates', async () => {
	// Real media (H.264 and AAC from demo.mp4) in muxed MPEG-TS segments, the second half after a discontinuity dated
	// two seconds after the first half's end. The first frame of each part is its date exactly.
	const start = Date.parse('2026-01-01T00:00:00.000Z') / 1000;
	const { durations, openInput } = await writeHlsWithDates(async (output) => {
		using demo = new Input({ source: new FilePathSource('./test/public/demo.mp4'), formats: ALL_FORMATS });
		const demoVideo = (await demo.getPrimaryVideoTrack())!;
		const demoAudio = (await demo.getPrimaryAudioTrack())!;
		const group = new OutputTrackGroup();
		const video = new EncodedVideoPacketSource('avc');
		const audio = new EncodedAudioPacketSource('aac');
		output.addVideoTrack(video, { group });
		output.addAudioTrack(audio, { group });
		await output.start();

		const videoConfig = { decoderConfig: (await demoVideo.getDecoderConfig())! };
		const audioConfig = { decoderConfig: (await demoAudio.getDecoderConfig())! };
		const videoPackets = new EncodedPacketSink(demoVideo).packets();
		const audioPackets = new EncodedPacketSink(demoAudio).packets();
		const nextBefore = async (packets: AsyncGenerator<EncodedPacket>) => {
			const next = await packets.next();
			return !next.done && next.value.timestamp < 6 ? next.value : null;
		};
		let nextVideo = await nextBefore(videoPackets);
		let nextAudio = await nextBefore(audioPackets);
		while (nextVideo || nextAudio) {
			if (nextVideo && (!nextAudio || nextVideo.timestamp <= nextAudio.timestamp)) {
				await video.add(nextVideo, videoConfig);
				nextVideo = await nextBefore(videoPackets);
			} else if (nextAudio) {
				await audio.add(nextAudio, audioConfig);
				nextAudio = await nextBefore(audioPackets);
			}
		}
		await output.finalize();
	}, (index, durationsBefore) => {
		const sum = durationsBefore.reduce((a, b) => a + b, 0);
		return index === 0 ? start : index === 2 ? start + sum + 2 : null;
	}, index => index === 2);
	expect(durations.length).toBeGreaterThan(2);

	for (const offsetTimestampsByDateTime of [true, false]) {
		using input = openInput(offsetTimestampsByDateTime);
		const videoTrack = (await input.getPrimaryVideoTrack())!;
		const timestamps: number[] = [];
		const sink = new EncodedPacketSink(videoTrack);
		for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
			timestamps.push(packet.timestamp);
		}

		const secondPartStart = durations[0]! + durations[1]!;
		const firstOfSecondPart = timestamps.findIndex(x => x - timestamps[0]! >= secondPartStart - 1e-3);
		const second = timestamps[firstOfSecondPart]!;
		// As written into the playlist, to the millisecond
		const secondPartDate = Math.round(1000 * (start + secondPartStart + 2)) / 1000;
		expect(await videoTrack.getUnixTimeForTimestamp(timestamps[0]!)).toBeCloseTo(start, 6);
		expect(await videoTrack.getUnixTimeForTimestamp(second)).toBeCloseTo(secondPartDate, 6);
		expect(await videoTrack.getUnixTimeForTimestamp(second + 0.1)).toBeCloseTo(secondPartDate + 0.1, 6);
		// The last frame before the discontinuity still belongs to the first part
		const last = timestamps[firstOfSecondPart - 1]!;
		expect(await videoTrack.getUnixTimeForTimestamp(last)).toBeCloseTo(start + last - timestamps[0]!, 6);
	}
});

test('Live mode', async () => {
	const writtenTexts = new Map<string, string>();
	const writeCounts = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
					writeCounts.set(request.path, (writeCounts.get(request.path) ?? 0) + 1);
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);

	expect(writtenTexts.size).toBe(0);

	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0.5), avcMetadata);

	expect(writtenTexts.has('playlist-1.m3u8')).toBe(true);
	expect(writtenTexts.has('master.m3u8')).toBe(true);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 4, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 4.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5.5, 0.5), avcMetadata);

	await output.finalize();

	expect(writeCounts.get('master.m3u8')).toBe(3);
	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:2,
segment-1-3.ts

#EXT-X-ENDLIST
`);
});

test('Live mode, CMAF', async () => {
	const writtenTexts = new Map<string, string>();
	const writeCounts = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			live: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
					writeCounts.set(request.path, (writeCounts.get(request.path) ?? 0) + 1);
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);

	expect(writtenTexts.size).toBe(0);

	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0.5), avcMetadata);

	expect(writtenTexts.has('playlist-1.m3u8')).toBe(true);
	expect(writtenTexts.has('master.m3u8')).toBe(true);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init-1.m4s"

#EXTINF:2,
segment-1-1.m4s
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 4, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init-1.m4s"

#EXTINF:2,
segment-1-1.m4s
#EXTINF:2,
segment-1-2.m4s
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 4.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5.5, 0.5), avcMetadata);

	await output.finalize();

	expect(writeCounts.get('master.m3u8')).toBe(3);
	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init-1.m4s"

#EXTINF:2,
segment-1-1.m4s
#EXTINF:2,
segment-1-2.m4s
#EXTINF:2,
segment-1-3.m4s

#EXT-X-ENDLIST
`);
});

test('Live mode, fixed target duration', async () => {
	const writtenTexts = new Map<string, string>();
	const writeCounts = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
					writeCounts.set(request.path, (writeCounts.get(request.path) ?? 0) + 1);
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);

	await output.finalize();

	// The TARGETDURATION remains 2 even tho there are segments longer than that; this is because the spec disallows the
	// target duration to change, and it must be the same across all playlists
	expect(writeCounts.get('master.m3u8')).toBe(1);
	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:3,
segment-1-1.ts

#EXT-X-ENDLIST
`);
});

test('Live mode, empty', async () => {
	const writtenTexts = new Map<string, string>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();
	await output.finalize();

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-ENDLIST
`);
});

test('EXT-X-PROGRAM-DATE-TIME writing', async () => {
	let result: string | null = null;
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onPlaylist: (text) => { result = text; },
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source, { isRelativeToUnixEpoch: true });

	await output.start();

	const base = Date.parse('2026-01-01T00:00:00.250Z') / 1000;

	await source.add(new EncodedPacket(avcPacketData, 'key', base + 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', base + 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 3.5, 0), avcMetadata);

	await output.finalize();

	expect(result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.250Z
segment-1-1.ts
#EXTINF:1.5,
#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:02.250Z
segment-1-2.ts

#EXT-X-ENDLIST
`);

	// Only the playlist carries the Unix time, while the media starts at the default base of 10 seconds
	const segmentTarget = targets.get('segment-1-1.ts');
	assert(segmentTarget);

	using segmentInput = new Input({
		source: new BufferSource(segmentTarget.buffer!),
		formats: ALL_FORMATS,
	});
	const videoTrack = await segmentInput.getPrimaryVideoTrack();
	assert(videoTrack);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual([10, 10.5, 11, 11.5]);
});

test('Throws if some tracks are relativeToUnixEpoch and some are not', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource(), { isRelativeToUnixEpoch: true });
	output.addAudioTrack(audioSource(), { isRelativeToUnixEpoch: false });

	await expect(output.start()).rejects.toThrow('relativeToUnixEpoch');
});

test('Live mode, maxLiveSegmentCount', async () => {
	const writtenTexts = new Map<string, string>();
	const poppedSegments: { path: string; info: HlsOutputSegmentInfo }[] = [];

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
			maxLiveSegmentCount: 2,
			onSegmentPopped: (path, info) => {
				poppedSegments.push({ path, info });
			},
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 4, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 4.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 6, 0.5), avcMetadata);

	// A live playlist must span three target durations, so nothing can be popped yet
	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:2,
segment-1-3.ts
`);
	expect(poppedSegments).toHaveLength(0);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 6.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 7, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 7.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 8, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:1
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-2.ts
#EXTINF:2,
segment-1-3.ts
#EXTINF:2,
segment-1-4.ts
`);

	expect(poppedSegments).toHaveLength(1);
	expect(poppedSegments[0]!.path).toBe('segment-1-1.ts');
	expect(poppedSegments[0]!.info.n).toBe(1);
	expect(poppedSegments[0]!.info.isSingleFile).toBe(false);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 8.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 9, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 9.5, 0.5), avcMetadata);

	await output.finalize();

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-3.ts
#EXTINF:2,
segment-1-4.ts
#EXTINF:2,
segment-1-5.ts

#EXT-X-ENDLIST
`);

	expect(poppedSegments).toHaveLength(2);
	expect(poppedSegments[1]!.path).toBe('segment-1-2.ts');
	expect(poppedSegments[1]!.info.n).toBe(2);
});

test('Live mode, maxLiveSegmentCount with singleFilePerPlaylist', async () => {
	const onSegmentPopped = vi.fn();
	let lastPlaylistText = '';

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
			maxLiveSegmentCount: 2,
			singleFilePerPlaylist: true,
			onSegmentPopped,
			onPlaylist: (content) => {
				lastPlaylistText = content;
			},
		}),
		target: new PathedTarget('master.m3u8', () => {
			return new BufferTarget();
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 4, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 4.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 6, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 6.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 7, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 7.5, 0.5), avcMetadata);

	await output.finalize();

	expect(onSegmentPopped).not.toHaveBeenCalled();

	// Popping still happened, down to the three target durations a live playlist must span
	const extinfCount = (lastPlaylistText.match(/#EXTINF:/g) ?? []).length;
	expect(extinfCount).toBe(3);
});

test('Live mode, popping segments never leaves less than three target durations in a playlist', async () => {
	// RFC 8216, Section 6.2.2: "The server MUST NOT remove a Media Segment from a Playlist file without an
	// EXT-X-ENDLIST tag if that would produce a Playlist whose duration is less than three times the target duration."
	const playlistTexts: string[] = [];

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
			maxLiveSegmentCount: 3,
			onPlaylist: (content) => {
				playlistTexts.push(content);
			},
		}),
		target: new PathedTarget('master.m3u8', () => new BufferTarget()),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	// A key frame every 1.5 seconds makes 1.5-second segments under the default target duration of 2 seconds
	for (let timestamp = 0; timestamp < 12; timestamp += 0.5) {
		await source.add(
			new EncodedPacket(avcPacketData, timestamp % 1.5 === 0 ? 'key' : 'delta', timestamp, 0.5),
			avcMetadata,
		);
	}

	await output.finalize();

	let poppedPlaylistCount = 0;
	for (const text of playlistTexts) {
		const mediaSequence = Number(text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)![1]);
		if (mediaSequence === 0 || text.includes('#EXT-X-ENDLIST')) {
			continue;
		}

		poppedPlaylistCount++;
		const durations = [...text.matchAll(/#EXTINF:([\d.]+),/g)].map(match => Number(match[1]));
		expect(durations.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3 * 2);
		expect(durations).toHaveLength(4); // But no more segments than needed
	}

	expect(poppedPlaylistCount).toBeGreaterThan(0);
});

test('Live mode, onSegmentPopped fires once no published playlist lists the segment anymore', async () => {
	let publishedPlaylist = '';
	const everListed = new Set<string>();
	const listedWhenPopped: boolean[] = [];
	const poppedPaths: string[] = [];

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
			maxLiveSegmentCount: 2,
			onSegmentPopped: (path) => {
				// The docs suggest deleting the segment file in response, so the playlist being served right now must
				// not list it anymore (found by L62)
				listedWhenPopped.push(publishedPlaylist.split('\n').includes(path));
				poppedPaths.push(path);
			},
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path === 'playlist-1.m3u8') {
					publishedPlaylist = new TextDecoder().decode(target.buffer!);
					for (const line of publishedPlaylist.split('\n')) {
						if (line && !line.startsWith('#')) {
							everListed.add(line);
						}
					}
				}
			});
			return target;
		}),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();

	for (let i = 0; i < 24; i++) {
		await source.add(new EncodedPacket(avcPacketData, i % 4 === 0 ? 'key' : 'delta', i / 2, 0.5), avcMetadata);
	}
	await output.finalize();

	// Segments are popped oldest first; every popped segment was published before, and none is listed by the playlist
	// being served when it's popped
	expect(poppedPaths.length).toBeGreaterThan(0);
	expect(poppedPaths).toEqual(poppedPaths.map((_, i) => `segment-1-${i + 1}.ts`));
	expect(poppedPaths.every(path => everListed.has(path))).toBe(true);
	expect(listedWhenPopped).toEqual(poppedPaths.map(() => false));
});

test('Append-only stream', async () => {
	const writes = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			writes.set(request.path, 0);

			const writable = new WritableStream<Uint8Array>({
				write: () => {
					writes.set(request.path, writes.get(request.path)! + 1);
				},
			});
			const target = new AppendOnlyStreamTarget(writable);
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	// Each segment file should have been written to at least once
	for (const [, count] of writes) {
		expect(count).toBeGreaterThanOrEqual(1);
	}

	expect(writes.size).toBe(1 + 1 + 2); // Master playlist + media playlist + 2 segments
});

test('Append-only stream, single file', async () => {
	const writes = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			singleFilePerPlaylist: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			writes.set(request.path, 0);

			const writable = new WritableStream<Uint8Array>({
				write: () => {
					writes.set(request.path, writes.get(request.path)! + 1);
				},
			});
			const target = new AppendOnlyStreamTarget(writable);
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	// Each segment file should have been written to at least once
	for (const [, count] of writes) {
		expect(count).toBeGreaterThanOrEqual(1);
	}

	expect(writes.size).toBe(1 + 1 + 1); // Master playlist + media playlist + 1 segments file
});

test('Append-only stream, single file with CMAF', async () => {
	const writes = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			singleFilePerPlaylist: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			writes.set(request.path, 0);

			const writable = new WritableStream<Uint8Array>({
				write: () => {
					writes.set(request.path, writes.get(request.path)! + 1);
				},
			});
			const target = new AppendOnlyStreamTarget(writable);
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	// Each segment file should have been written to at least once
	for (const [, count] of writes) {
		expect(count).toBeGreaterThanOrEqual(1);
	}

	expect(writes.size).toBe(1 + 1 + 1); // Master playlist + media playlist + 1 segments file
});

test('Append-only stream with monotonicity violation', async () => {
	const writes = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new Mp4OutputFormat(),
			singleFilePerPlaylist: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			writes.set(request.path, 0);

			const writable = new WritableStream<Uint8Array>({
				write: () => {
					writes.set(request.path, writes.get(request.path)! + 1);
				},
			});
			const target = new AppendOnlyStreamTarget(writable);
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);

	await expect(source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata))
		.rejects.toThrow('AppendOnlyStreamTarget');
});

test('Tracks of a variant stream take their language and name from the media when the playlist has none', async () => {
	// A lone audio track is written as the variant stream itself, which can't declare a language or name (only
	// renditions can), while the CMAF segments carry both
	const targets = new Map<string, BufferTarget>();
	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new CmafOutputFormat() }),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);
			return target;
		}),
	});
	const audio = audioSource();
	output.addAudioTrack(audio, { languageCode: 'fra', name: 'Français' });
	await output.start();
	for (let i = 0; i < 100; i++) {
		await audio.add(new EncodedPacket(aacPacketData, 'key', i * 1024 / 48000, 1024 / 48000), aacMetadata);
	}
	await output.finalize();
	expect(new TextDecoder().decode(targets.get('master.m3u8')!.buffer!)).not.toContain('LANGUAGE');

	const openInput = (rootPath: string, readable: (path: string) => boolean = () => true) => new Input({
		source: new CustomPathedSource(rootPath, ({ path }) => {
			if (!readable(path)) {
				throw new Error(`${path} is unavailable`);
			}

			return new BufferSource(targets.get(path)!.buffer!);
		}),
		formats: ALL_FORMATS,
	});

	// Control: the media playlist read directly
	using mediaPlaylistInput = openInput('playlist-1.m3u8');
	const directTrack = (await mediaPlaylistInput.getPrimaryAudioTrack())!;
	expect(await directTrack.getLanguageCode()).toBe('fra');
	expect(await directTrack.getName()).toBe('Français');

	using masterInput = openInput('master.m3u8');
	const track = (await masterInput.getPrimaryAudioTrack())!;
	// The deprecated synchronous getters still work. They don't read media, so they give the playlist's values until
	// it has been read.
	const getKnownLanguageAndName = (inputTrack: InputAudioTrack) => {
		// eslint-disable-next-line @typescript-eslint/no-deprecated -- what's being tested
		return [inputTrack.languageCode, inputTrack.name];
	};
	expect(getKnownLanguageAndName(track)).toEqual(['und', null]);
	expect(await track.getLanguageCode()).toBe('fra');
	expect(await track.getName()).toBe('Français');
	expect(getKnownLanguageAndName(track)).toEqual(['fra', 'Français']);

	// When the media can't be read, these optional values stay what the playlist says instead of failing, and the
	// metadata that the playlist does give still comes from it
	using unreadableInput = openInput('master.m3u8', path => path === 'master.m3u8');
	const unreadableTrack = (await unreadableInput.getPrimaryAudioTrack())!;
	expect(await unreadableTrack.getLanguageCode()).toBe('und');
	expect(await unreadableTrack.getName()).toBe(null);
	expect(await unreadableTrack.getCodecParameterString()).toBe('mp4a.40.2');
});

test('Relative paths & isRoot', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			getPlaylistPath: () => `a/folder/playlist.m3u8`,
		}),
		target: new PathedTarget('path/to/master.m3u8', (request) => {
			if (request.isRoot) {
				expect(request.path).toBe('path/to/master.m3u8');
			} else {
				expect(request.path.startsWith('path/to/a/folder/')).toBe(true);
			}

			return new BufferTarget();
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();
});

test('RESOLUTION is the size the segments display, given whether they store the rotation', async () => {
	// RESOLUTION "describes the optimal pixel resolution at which to display all the video in the Variant Stream"
	// (RFC 8216, Section 4.3.4.2). The first 30 packets of video.mp4, 1920x1080 H.264.
	using input = new Input({ source: new FilePathSource('./test/public/video.mp4'), formats: ALL_FORMATS });
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		packets.push(packet);
		if (packets.length === 30) {
			break;
		}
	}

	const writeResolution = async (
		segmentFormat: HlsOutputFormatOptions['segmentFormat'],
		metadata: Parameters<Output['addVideoTrack']>[1],
	) => {
		const files = new Map<string, Uint8Array>();
		const output = new Output({
			format: new HlsOutputFormat({ segmentFormat }),
			target: new PathedTarget('master.m3u8', (request) => {
				const target = new BufferTarget();
				target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
				return target;
			}),
		});
		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source, metadata);
		await output.start();
		for (const [i, packet] of packets.entries()) {
			await source.add(packet, i === 0 ? { decoderConfig } : undefined);
		}
		await output.finalize();

		return new TextDecoder().decode(files.get('master.m3u8')).match(/RESOLUTION=(\d+x\d+)/)![1];
	};

	// CMAF stores the rotation, given as `rotation` or as a transformation matrix (which takes precedence)
	expect(await writeResolution(new CmafOutputFormat(), { rotation: 90 })).toBe('1080x1920');
	expect(await writeResolution(new CmafOutputFormat(), { transformationMatrix: [0, 1, 0, -1, 0, 0, 0, 0, 1] }))
		.toBe('1080x1920');
	expect(await writeResolution(new CmafOutputFormat(), {
		rotation: 90,
		transformationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
	})).toBe('1920x1080');

	// MPEG-TS can't store it, so its segments display the frames unrotated
	expect(await writeResolution(new MpegTsOutputFormat(), { rotation: 90 })).toBe('1920x1080');
	expect(await writeResolution(new MpegTsOutputFormat(), { transformationMatrix: [0, 1, 0, -1, 0, 0, 0, 0, 1] }))
		.toBe('1920x1080');
});

test('Cross-variant timestamps, MPEG-TS', async () => {
	await testCrossVariantTimestamps({
		segmentFormat: new MpegTsOutputFormat(),
	});
});

test('Cross-variant timestamps, CMAF', async () => {
	await testCrossVariantTimestamps({
		segmentFormat: new CmafOutputFormat(),
	});
});

test('Cross-variant timestamps, packed audio next to MPEG-TS with a timestampOffset', async ({ onTestFinished }) => {
	// The setup from the docs, packaging audio into .aac and video into .ts files. All segment media starts at
	// mediaTimestampBase, so an offset given to the MPEG-TS format must not move the video away from the audio. It's
	// ignored, with one warning saying so.
	const warnings: string[] = [];
	onTestFinished(Logging.on('warn', args => warnings.push(args.map(String).join(' '))));

	const targets = new Map<string, BufferTarget>();
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: [new AdtsOutputFormat(), new MpegTsOutputFormat({ timestampOffset: 10 })],
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);
			return target;
		}),
	});

	// The groups aren't paired, so the tracks land in different variant streams
	const video = videoSource();
	const audio = audioSource();
	output.addVideoTrack(video, { group: new OutputTrackGroup() });
	output.addAudioTrack(audio, { group: new OutputTrackGroup() });
	await output.start();

	// Video starts at 1 second, audio (back-to-back AAC frames) half a second earlier
	for (let i = 0; i < 8; i++) {
		await video.add(new EncodedPacket(avcPacketData, i % 4 === 0 ? 'key' : 'delta', 1 + 0.5 * i, 0.5), avcMetadata);
	}
	const frameDuration = 1024 / 48000;
	for (let i = 0; i * frameDuration < 4; i++) {
		await audio.add(new EncodedPacket(aacPacketData, 'key', 0.5 + i * frameDuration, frameDuration), aacMetadata);
	}
	await output.finalize();

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			const target = targets.get(path);
			assert(target);
			return new BufferSource(target.buffer!);
		}),
		formats: ALL_FORMATS,
	});
	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack && audioTrack);

	// The video is the reference, so its first packet lands at 0
	expect((await new EncodedPacketSink(videoTrack).getFirstPacket())?.timestamp).toBe(0);
	expect((await new EncodedPacketSink(audioTrack).getFirstPacket())?.timestamp).toBeCloseTo(-0.5, 3);
	expect(warnings.filter(x => x.includes('timestampOffset'))).toHaveLength(1);
});

const testCrossVariantTimestamps = async (hlsOptions: HlsOutputFormatOptions) => {
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat(hlsOptions),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	// The groups aren't paired, so the tracks land in different variant streams
	const video = videoSource();
	const audio = audioSource();
	output.addVideoTrack(video, { group: new OutputTrackGroup() });
	output.addAudioTrack(audio, { group: new OutputTrackGroup() });

	await output.start();

	// Video starts at 1 second, audio half a second earlier
	for (let i = 0; i < 8; i++) {
		const type = i % 4 === 0 ? 'key' : 'delta';
		await video.add(new EncodedPacket(avcPacketData, type, 1 + 0.5 * i, 0), avcMetadata);
		await audio.add(new EncodedPacket(aacPacketData, 'key', 0.5 + 0.5 * i, 0), aacMetadata);
	}

	await output.finalize();

	// Read the entire output back using the HLS input
	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			const target = targets.get(path);
			assert(target);

			return new BufferSource(target.buffer!);
		}),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack() as InputVideoTrack;
	expect(videoTrack).toBeTruthy();
	const audioTrack = await input.getPrimaryAudioTrack() as InputAudioTrack;
	expect(audioTrack).toBeTruthy();
	expect(await audioTrack.getPairableVideoTracks()).toHaveLength(0);

	const videoTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		videoTimestamps.push(packet.timestamp);
	}

	const audioTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		audioTimestamps.push(packet.timestamp);
	}

	// The video is the reference, so its first packet lands at 0
	expect(videoTimestamps).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
	expect(audioTimestamps).toEqual([-0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3]);
};

test('CMAF segments stay contiguous when packets have no duration', async () => {
	// Packets without a duration (e.g. from WebCodecs chunks of frames without one) end each segment's fragment with a
	// sample of duration 0 unless the next segment's start fills it in, as the fragmented MP4 muxer does for its own
	// fragments: "the track fragment decode time MUST be consistent with the decode time and duration of the previous
	// segment" (Apple HLS authoring spec, 7.3)
	const check = async (packetsHaveDurations: boolean, singleFilePerPlaylist: boolean) => {
		const targets = new Map<string, BufferTarget>();
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new CmafOutputFormat(),
				targetDuration: 1,
				singleFilePerPlaylist,
			}),
			target: new PathedTarget('master.m3u8', (request) => {
				const target = new BufferTarget();
				targets.set(request.path, target);
				return target;
			}),
		});
		const video = videoSource();
		const audio = audioSource();
		output.addVideoTrack(video, { frameRate: 25 });
		output.addAudioTrack(audio);
		await output.start();

		const audioFrameDuration = 1024 / 48000;
		let audioIndex = 0;
		for (let i = 0; i < 75; i++) {
			const timestamp = i / 25;
			const type = i % 25 === 0 ? 'key' : 'delta';
			const duration = packetsHaveDurations ? 1 / 25 : 0;
			await video.add(new EncodedPacket(avcPacketData, type, timestamp, duration), avcMetadata);
			for (; audioIndex * audioFrameDuration < timestamp + 1 / 25; audioIndex++) {
				await audio.add(new EncodedPacket(
					aacPacketData,
					'key',
					audioIndex * audioFrameDuration,
					packetsHaveDurations ? audioFrameDuration : 0,
				), aacMetadata);
			}
		}
		await output.finalize();

		using input = new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(targets.get(path)!.buffer!)),
			formats: ALL_FORMATS,
		});
		for (const track of await input.getTracks()) {
			const sink = new EncodedPacketSink(track);
			const packets: EncodedPacket[] = [];
			for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
				packets.push(packet);
			}
			expect(packets.length).toBeGreaterThan(50);

			// Every packet ends where the next one starts, across segment boundaries too. Only the very last packet's
			// duration is unknown when it has none.
			for (let i = 0; i < packets.length - 1; i++) {
				expect(packets[i]!.timestamp + packets[i]!.duration).toBeCloseTo(packets[i + 1]!.timestamp, 4);
			}
		}
	};

	await check(true, false);
	await check(false, false);
	await check(false, true);
});

test('PRIV timestamps in packed audio segments, ADTS', async () => {
	await testPackedAudioPrivTimestamps('sample3.aac', new AdtsOutputFormat());
});

test('PRIV timestamps in packed audio segments, MP3', async () => {
	await testPackedAudioPrivTimestamps('Toothsome-Meme.VBRv2.mp3', new Mp3OutputFormat());
});

test('PRIV timestamps in packed audio segments, WAV', async () => {
	await testPackedAudioPrivTimestamps('glitch-hop-is-dead.wav', new WavOutputFormat({ metadataFormat: 'id3' }));
});

test('MP3 segments start with audio, not with a Xing frame', async () => {
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new Mp3OutputFormat() }),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	using sourceInput = new Input({
		source: new FilePathSource('./test/public/Toothsome-Meme.VBRv2.mp3'),
		formats: ALL_FORMATS,
	});
	const sourceTrack = await sourceInput.getPrimaryAudioTrack();
	assert(sourceTrack);
	const decoderConfig = await sourceTrack.getDecoderConfig();
	assert(decoderConfig);

	const source = new EncodedAudioPacketSource('mp3');
	output.addAudioTrack(source);

	await output.start();
	for await (const packet of new EncodedPacketSink(sourceTrack).packets()) {
		await source.add(packet, { decoderConfig });
	}
	await output.finalize();

	const segmentPaths = [...targets.keys()].filter(path => path.endsWith('.mp3'));
	expect(segmentPaths.length).toBeGreaterThan(1);

	for (const path of segmentPaths) {
		const bytes = new Uint8Array(targets.get(path)!.buffer!);

		// Skip the ID3v2 tag holding the PRIV timestamp; the first MPEG frame follows it
		expect(new TextDecoder().decode(bytes.subarray(0, 3))).toBe('ID3');
		const tagSize = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);

		// A Xing/Info frame would be read as an extra frame of silence by players
		const frameStart = new TextDecoder('latin1').decode(bytes.subarray(tagSize, tagSize + 64));
		expect(/Xing|Info/.test(frameStart)).toBe(false);
	}
});

const testPackedAudioPrivTimestamps = async (
	fileName: string,
	segmentFormat: HlsOutputFormatOptions['segmentFormat'],
) => {
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat }),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	using sourceInput = new Input({
		source: new FilePathSource(`./test/public/${fileName}`),
		formats: ALL_FORMATS,
	});
	const sourceTrack = await sourceInput.getPrimaryAudioTrack();
	assert(sourceTrack);
	const sourceCodec = await sourceTrack.getCodec();
	assert(sourceCodec);
	const decoderConfig = await sourceTrack.getDecoderConfig();
	assert(decoderConfig);

	const source = new EncodedAudioPacketSource(sourceCodec);
	output.addAudioTrack(source);

	await output.start();

	const sourceTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(sourceTrack).packets()) {
		sourceTimestamps.push(packet.timestamp);
		await source.add(packet, { decoderConfig });
	}

	await output.finalize();

	// Every segment must start with a PRIV frame holding the timestamp of its first sample, on the 90 kHz MPEG-TS
	// clock and offset by the default media timestamp offset of 10 seconds
	const owner = 'com.apple.streaming.transportStreamTimestamp';
	const playlistLines = new TextDecoder().decode(targets.get('playlist-1.m3u8')!.buffer!).split('\n');
	let segmentStart = 0;
	let segmentCount = 0;

	for (let i = 0; i < playlistLines.length; i++) {
		const line = playlistLines[i]!;
		if (!line.startsWith('#EXTINF:')) {
			continue;
		}

		const segmentTarget = targets.get(playlistLines[i + 1]!);
		assert(segmentTarget);

		using segmentInput = new Input({
			source: new BufferSource(segmentTarget.buffer!),
			formats: ALL_FORMATS,
		});
		const priv = (await segmentInput.getMetadataTags()).raw?.['PRIV'];
		assert(priv instanceof Uint8Array);

		expect(priv.length).toBe(owner.length + 1 + 8);
		expect(new TextDecoder().decode(priv.subarray(0, owner.length))).toBe(owner);
		expect(priv[owner.length]).toBe(0);

		const view = new DataView(priv.buffer, priv.byteOffset, priv.byteLength);
		const timestampHigh = view.getUint32(owner.length + 1);
		const timestampLow = view.getUint32(owner.length + 5);
		expect((2 ** 32 * timestampHigh + timestampLow) / 90_000 - 10).toBeCloseTo(segmentStart, 4);

		segmentStart += Number(line.slice('#EXTINF:'.length, line.indexOf(',')));
		segmentCount++;
	}

	expect(segmentCount).toBeGreaterThan(1);

	// Read the entire output back using the HLS input
	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			const target = targets.get(path);
			assert(target);

			return new BufferSource(target.buffer!);
		}),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		timestamps.push(packet.timestamp);
	}

	// HLS normalizes the first packet to zero, including MP3's negative priming timestamp.
	expect(timestamps).toHaveLength(sourceTimestamps.length);
	for (let i = 0; i < timestamps.length; i++) {
		expect(timestamps[i]).toBeCloseTo(sourceTimestamps[i]! - sourceTimestamps[0]!, 10);
	}
};

test('Timestamp wraparound, MPEG-TS', async () => {
	await testTimestampWraparound(new MpegTsOutputFormat(), false);
});

test('Timestamp wraparound, MPEG-TS with PDT', async () => {
	await testTimestampWraparound(new MpegTsOutputFormat(), true);
});

test('Timestamp wraparound, CMAF', async () => {
	await testTimestampWraparound(new CmafOutputFormat(), false);
});

const testTimestampWraparound = async (
	segmentFormat: HlsOutputFormatOptions['segmentFormat'],
	isRelativeToUnixEpoch: boolean,
) => {
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat,
			// Start the media 80 seconds before the 33-bit wraparound of the 90 kHz clock, far enough out so the
			// demuxer won't interpret the first timestamp as negative
			mediaTimestampBase: 2 ** 33 / 90_000 - 80,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source, { isRelativeToUnixEpoch });

	await output.start();

	const start = isRelativeToUnixEpoch ? Date.parse('2026-01-01T00:00:00Z') / 1000 : 0;
	const packetCount = 240;
	for (let i = 0; i < packetCount; i++) {
		const type = i % 4 === 0 ? 'key' : 'delta';
		await source.add(new EncodedPacket(avcPacketData, type, start + 0.5 * i, 0.5), avcMetadata);
	}

	await output.finalize();

	const playlist = new TextDecoder().decode(targets.get('playlist-1.m3u8')!.buffer!);
	expect(playlist.includes('#EXT-X-PROGRAM-DATE-TIME')).toBe(isRelativeToUnixEpoch);

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			const target = targets.get(path);
			assert(target);

			return new BufferSource(target.buffer!);
		}),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		timestamps.push(packet.timestamp);
	}

	// The reference's first packet lands at 0, or at its Unix time with PDT
	expect(timestamps).toHaveLength(packetCount);
	for (let i = 0; i < packetCount; i++) {
		expect(timestamps[i]).toBeCloseTo(start + 0.5 * i, 4);
	}
};

test('CODECS names the hvc1 sample entry for HEVC from an hev1 source in CMAF segments', async () => {
	// video-h265.mp4 stores its HEVC in an 'hev1' sample entry, so its codec string starts with "hev1."
	using sourceInput = new Input({ source: new FilePathSource('./test/public/video-h265.mp4'), formats: ALL_FORMATS });
	const sourceTrack = await sourceInput.getPrimaryVideoTrack();
	assert(sourceTrack);
	const decoderConfig = (await sourceTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toMatch(/^hev1\./);

	const writeHls = async (segmentFormat: CmafOutputFormat | MpegTsOutputFormat) => {
		const files = new Map<string, Uint8Array>();
		const output = new Output({
			format: new HlsOutputFormat({ segmentFormat }),
			target: new PathedTarget('master.m3u8', (request) => {
				const target = new BufferTarget();
				target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
				return target;
			}),
		});
		const videoSource = new EncodedVideoPacketSource('hevc');
		output.addVideoTrack(videoSource);
		await output.start();
		for await (const packet of new EncodedPacketSink(sourceTrack).packets()) {
			await videoSource.add(packet, { decoderConfig });
		}
		await output.finalize();

		return files;
	};

	// The ISOBMFF muxer writes HEVC into an 'hvc1' sample entry, which the codec string must name
	const cmafFiles = await writeHls(new CmafOutputFormat());
	expect(new TextDecoder().decode(cmafFiles.get('init-1.m4s'))).toContain('hvc1');
	const cmafMaster = new TextDecoder().decode(cmafFiles.get('master.m3u8'));
	expect(cmafMaster).toContain(`CODECS="hvc1.${decoderConfig.codec.slice(5)}"`);

	// MPEG-TS has no sample entry; the codec string stays as is
	const tsMaster = new TextDecoder().decode((await writeHls(new MpegTsOutputFormat())).get('master.m3u8'));
	expect(tsMaster).toContain(`CODECS="${decoderConfig.codec}"`);
});

test('VIDEO-RANGE describes HDR variants', async () => {
	using sourceInput = new Input({ source: new FilePathSource('./test/public/edts.mp4'), formats: ALL_FORMATS });
	const sourceTrack = await sourceInput.getPrimaryVideoTrack();
	assert(sourceTrack);
	const decoderConfig = (await sourceTrack.getDecoderConfig())!;
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(sourceTrack).packets()) {
		packets.push(packet);
	}

	// Writes one variant per transfer characteristic and returns the master playlist
	const writeVariants = async (transfers: VideoTransferCharacteristics[]) => {
		let master = '';
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new CmafOutputFormat(),
				onMaster: (text) => {
					master = text;
				},
			}),
			target: new PathedTarget('master.m3u8', () => new BufferTarget()),
		});

		const sources = transfers.map((transfer) => {
			const source = new EncodedVideoPacketSource('avc');
			output.addVideoTrack(source, { group: new OutputTrackGroup() });
			return { source, transfer };
		});
		await output.start();

		for (const { source, transfer } of sources) {
			const colorSpace = {
				primaries: 'bt2020',
				transfer,
				matrix: 'bt2020-ncl',
				fullRange: false,
			} as unknown as VideoColorSpaceInit;
			for (const packet of packets) {
				await source.add(packet, { decoderConfig: { ...decoderConfig, colorSpace } });
			}
		}
		await output.finalize();

		return master.split('\n').filter(line => line.startsWith('#EXT-X-STREAM-INF'));
	};

	// "The value MUST be PQ if the video in the Variant Stream is encoded using [...] TransferCharacteristics code
	// point 16", and HLG for 18; its absence implies SDR, so the SDR variant next to them says so explicitly
	// (TypeScript's DOM types don't list the BT.2100 values yet)
	const hdrTransfers = ['pq', 'hlg'] as unknown as VideoTransferCharacteristics[];
	const variants = await writeVariants([...hdrTransfers, 'bt709']);
	expect(variants).toHaveLength(3);
	expect(variants[0]).toContain(',VIDEO-RANGE=PQ');
	expect(variants[1]).toContain(',VIDEO-RANGE=HLG');
	expect(variants[2]).toContain(',VIDEO-RANGE=SDR');

	// SDR-only output doesn't need the attribute
	const sdrVariants = await writeVariants(['bt709']);
	expect(sdrVariants[0]).not.toContain('VIDEO-RANGE');
});

test('Variant streams without segments are left out of the master playlist', async () => {
	const targets = new Map<string, BufferTarget>();
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('master.m3u8', ({ path }) => {
			const target = new BufferTarget();
			targets.set(path, target);
			return target;
		}),
	});

	const video = videoSource();
	output.addVideoTrack(video);
	// A second video track that never receives a packet
	const emptyVideo = videoSource();
	output.addVideoTrack(emptyVideo, { decoderConfig: avcMetadata.decoderConfig });
	const audio = audioSource();
	output.addAudioTrack(audio);

	await output.start();

	for (let i = 0; i < 4; i++) {
		await video.add(new EncodedPacket(avcPacketData, i === 0 ? 'key' : 'delta', i * 0.5, 0.5), avcMetadata);
		await audio.add(new EncodedPacket(aacPacketData, 'key', i * 0.5, 0.5), aacMetadata);
	}

	await output.finalize();

	const masterText = new TextDecoder().decode(targets.get('master.m3u8')!.buffer!);
	expect(masterText.match(/#EXT-X-STREAM-INF/g)).toHaveLength(1);

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			const target = targets.get(path);
			assert(target);

			return new BufferSource(target.buffer!);
		}),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect((await new EncodedPacketSink(videoTrack).getFirstPacket())?.timestamp).toBe(0);
});

test('A variant without segments stays next to an I-frame stream when only it reaches the audio', async () => {
	const targets = new Map<string, BufferTarget>();
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('master.m3u8', ({ path }) => {
			const target = new BufferTarget();
			targets.set(path, target);
			return target;
		}),
	});

	// The I-frame stream has segments, but it can't carry the audio renditions
	const iFrames = videoSource();
	output.addVideoTrack(iFrames, { hasOnlyKeyPackets: true });
	// The regular video track never receives a packet, but the audio paired with it does
	output.addVideoTrack(videoSource(), { decoderConfig: avcMetadata.decoderConfig });
	const audioA = audioSource();
	output.addAudioTrack(audioA, { languageCode: 'eng' });
	const audioB = audioSource();
	output.addAudioTrack(audioB, { languageCode: 'ger' });

	await output.start();

	for (let i = 0; i < 4; i++) {
		await iFrames.add(new EncodedPacket(avcPacketData, 'key', i * 0.5, 0.5), avcMetadata);
		await audioA.add(new EncodedPacket(aacPacketData, 'key', i * 0.5, 0.5), aacMetadata);
		await audioB.add(new EncodedPacket(aacPacketData, 'key', i * 0.5, 0.5), aacMetadata);
	}

	await output.finalize();

	const masterText = new TextDecoder().decode(targets.get('master.m3u8')!.buffer!);
	const groupId = /#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="([^"]+)"/.exec(masterText)?.[1];
	assert(groupId);
	expect(masterText.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(1);
	expect(masterText.match(/#EXT-X-I-FRAME-STREAM-INF:/g)).toHaveLength(1);
	// Written as an audio-only variant of the renditions, since its own (video) playlist is empty
	const variantLine = masterText.split('\n').find(x => x.startsWith('#EXT-X-STREAM-INF:'))!;
	expect(variantLine).toContain(`AUDIO="${groupId}"`);
	expect(variantLine).toContain('CODECS="mp4a.40.2"');
	expect(variantLine).not.toContain('RESOLUTION');

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(targets.get(path)!.buffer!)),
		formats: ALL_FORMATS,
	});
	const audioTracks = await input.getAudioTracks();
	expect(audioTracks).toHaveLength(2);
	for (const audioTrack of audioTracks) {
		expect(await new EncodedPacketSink(audioTrack).getFirstPacket()).not.toBeNull();
	}
});

test('A variant without segments stays when it is the only way to reach its paired audio renditions', async () => {
	const targets = new Map<string, BufferTarget>();
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('master.m3u8', ({ path }) => {
			const target = new BufferTarget();
			targets.set(path, target);
			return target;
		}),
	});

	const videoGroupA = new OutputTrackGroup();
	const audioGroupA = new OutputTrackGroup();
	const videoGroupB = new OutputTrackGroup();
	const audioGroupB = new OutputTrackGroup();
	videoGroupA.pairWith(audioGroupA);
	videoGroupB.pairWith(audioGroupB);

	const video = videoSource();
	output.addVideoTrack(video, { group: videoGroupA });
	// Never receives a packet, but it's the only variant its audio is paired with
	output.addVideoTrack(videoSource(), { group: videoGroupB, decoderConfig: avcMetadata.decoderConfig });
	// Two audio tracks per pairing, so each pairing's audio becomes a rendition group
	const audioTracks = [
		{ source: audioSource(), group: audioGroupA, languageCode: 'eng' },
		{ source: audioSource(), group: audioGroupA, languageCode: 'fre' },
		{ source: audioSource(), group: audioGroupB, languageCode: 'ger' },
		{ source: audioSource(), group: audioGroupB, languageCode: 'spa' },
	];
	for (const { source, group, languageCode } of audioTracks) {
		output.addAudioTrack(source, { group, languageCode });
	}

	await output.start();

	for (let i = 0; i < 4; i++) {
		await video.add(new EncodedPacket(avcPacketData, i === 0 ? 'key' : 'delta', i * 0.5, 0.5), avcMetadata);
		for (const { source } of audioTracks) {
			await source.add(new EncodedPacket(aacPacketData, 'key', i * 0.5, 0.5), aacMetadata);
		}
	}

	await output.finalize();

	const masterText = new TextDecoder().decode(targets.get('master.m3u8')!.buffer!);
	const referencedGroups = [...masterText.matchAll(/#EXT-X-STREAM-INF:[^\n]*AUDIO="([^"]+)"/g)].map(x => x[1]);
	const declaredGroups = [...masterText.matchAll(/#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="([^"]+)"/g)].map(x => x[1]);
	// Both pairings' audio groups stay reachable
	expect(new Set(declaredGroups).size).toBe(2);
	expect(new Set(referencedGroups)).toEqual(new Set(declaredGroups));

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(targets.get(path)!.buffer!)),
		formats: ALL_FORMATS,
	});
	const audioResults = await input.getAudioTracks();
	expect(audioResults).toHaveLength(4);
	for (const audioResult of audioResults) {
		expect(await new EncodedPacketSink(audioResult).getFirstPacket()).not.toBeNull();
	}
});

test('An HLS output whose second pairing has no video segments stays readable', async () => {
	using source = new Input({ source: new FilePathSource('./test/public/demo.mp4'), formats: ALL_FORMATS });
	const videoTrack = (await source.getPrimaryVideoTrack())!;
	const audioTrack = (await source.getPrimaryAudioTrack())!;

	const targets = new Map<string, BufferTarget>();
	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat(), targetDuration: 2 }),
		target: new PathedTarget('master.m3u8', ({ path }) => {
			const target = new BufferTarget();
			targets.set(path, target);
			return target;
		}),
	});
	const [videoA, audioA, videoB, audioB] = [0, 1, 2, 3].map(() => new OutputTrackGroup());
	videoA!.pairWith(audioA!);
	videoB!.pairWith(audioB!);

	const video = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(video, { group: videoA });
	// This pairing's video never gets a packet, but its two audio renditions do
	const videoDecoderConfig = (await videoTrack.getDecoderConfig())!;
	output.addVideoTrack(new EncodedVideoPacketSource('avc'), { group: videoB, decoderConfig: videoDecoderConfig });
	const audios = [audioA, audioA, audioB, audioB].map((group, i) => {
		const audio = new EncodedAudioPacketSource('aac');
		output.addAudioTrack(audio, { group, languageCode: ['eng', 'fre', 'ger', 'spa'][i] });
		return audio;
	});

	await output.start();
	let first = true;
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		if (packet.timestamp >= 4) {
			break;
		}
		await video.add(packet, first ? { decoderConfig: videoDecoderConfig } : undefined);
		first = false;
	}
	const audioDecoderConfig = (await audioTrack.getDecoderConfig())!;
	for (const audio of audios) {
		first = true;
		for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
			if (packet.timestamp >= 4) {
				break;
			}
			await audio.add(packet, first ? { decoderConfig: audioDecoderConfig } : undefined);
			first = false;
		}
	}
	await output.finalize();

	const masterText = new TextDecoder().decode(targets.get('master.m3u8')!.buffer!);
	// The pairing without video segments is written as an audio-only variant of its renditions
	expect(masterText).toMatch(
		/#EXT-X-STREAM-INF:BANDWIDTH=\d+,AVERAGE-BANDWIDTH=\d+,CODECS="mp4a\.40\.2",AUDIO="[^"]+"\n/,
	);
	const files = new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(targets.get(path)!.buffer!));
	using result = new Input({ source: files, formats: ALL_FORMATS });
	const audioResults = await result.getAudioTracks();
	expect(await Promise.all(audioResults.map(x => x.getLanguageCode()))).toEqual(['eng', 'fre', 'ger', 'spa']);
	for (const audioResult of audioResults) {
		expect(await new EncodedPacketSink(audioResult).getFirstPacket()).not.toBeNull();
	}
});

test('A URI-less rendition with an empty playlist is left out when its variant uses another rendition', async () => {
	for (const kind of ['video', 'audio'] as const) {
		const targets = new Map<string, BufferTarget>();
		const output = new Output({
			format: new HlsOutputFormat({ segmentFormat: new CmafOutputFormat() }),
			target: new PathedTarget('master.m3u8', ({ path }) => {
				const target = new BufferTarget();
				targets.set(path, target);
				return target;
			}),
		});

		// The different names put both (unpaired) tracks into one group, whose first rendition has no URI: its media
		// is in the variant's own playlist. That first track never gets a packet.
		const video = videoSource();
		const audio = audioSource();
		if (kind === 'video') {
			output.addVideoTrack(videoSource(), { name: 'Empty', decoderConfig: avcMetadata.decoderConfig });
			output.addVideoTrack(video, { name: 'Main' });
		} else {
			output.addAudioTrack(audioSource(), { name: 'Empty', decoderConfig: aacMetadata.decoderConfig });
			output.addAudioTrack(audio, { name: 'Main' });
		}

		await output.start();

		for (let i = 0; i < 4; i++) {
			if (kind === 'video') {
				await video.add(new EncodedPacket(avcPacketData, 'key', i * 0.5, 0.5), avcMetadata);
			} else {
				await audio.add(new EncodedPacket(aacPacketData, 'key', i * 0.5, 0.5), aacMetadata);
			}
		}

		await output.finalize();

		const masterText = new TextDecoder().decode(targets.get('master.m3u8')!.buffer!);
		expect(masterText).not.toContain('NAME="Empty"');
		expect(masterText.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(1);

		using input = new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(targets.get(path)!.buffer!)),
			formats: ALL_FORMATS,
		});
		const tracks = kind === 'video' ? await input.getVideoTracks() : await input.getAudioTracks();
		expect(await Promise.all(tracks.map(x => x.getName()))).toEqual(['Main']);
		expect((await new EncodedPacketSink(tracks[0]!).getFirstPacket())?.timestamp).toBe(0);
	}
});

test('RESOLUTION with a display aspect given as a ratio or as a size', async () => {
	// WebCodecs defines displayAspectWidth/Height as a ratio, in any units
	const masterResolution = async (codedWidth: number, codedHeight: number, displayAspect?: [number, number]) => {
		let masterText = '';
		const output = new Output({
			format: new HlsOutputFormat({
				segmentFormat: new MpegTsOutputFormat(),
				onMaster: (text) => {
					masterText = text;
				},
			}),
			target: new PathedTarget('', () => new BufferTarget()),
		});
		const source = videoSource();
		output.addVideoTrack(source);
		await output.start();
		await source.add(new EncodedPacket(avcPacketData, 'key', 0, 1), {
			decoderConfig: {
				...avcMetadata.decoderConfig!,
				codedWidth,
				codedHeight,
				...(displayAspect && { displayAspectWidth: displayAspect[0], displayAspectHeight: displayAspect[1] }),
			},
		});
		await output.finalize();

		return /RESOLUTION=(\d+x\d+)/.exec(masterText)?.[1];
	};

	// A display size in pixels, at least as large as the frame in one dimension, is the RESOLUTION, as before
	expect(await masterResolution(1280, 720)).toBe('1280x720');
	expect(await masterResolution(720, 480, [853, 480])).toBe('853x480'); // NTSC 16:9
	expect(await masterResolution(1440, 1080, [1920, 1080])).toBe('1920x1080'); // HDV
	expect(await masterResolution(1280, 720, [1920, 720])).toBe('1920x720'); // 2:1 pixels
	expect(await masterResolution(1280, 720, [1280, 1440])).toBe('1280x1440'); // 1:2 pixels
	expect(await masterResolution(1280, 720, [1920, 1080])).toBe('1920x1080'); // Another scale

	// A ratio, smaller than the frame in both dimensions, scales the coded size instead
	expect(await masterResolution(720, 480, [16, 9])).toBe('853x480');
	expect(await masterResolution(1440, 1080, [16, 9])).toBe('1920x1080');
	expect(await masterResolution(1280, 720, [8, 3])).toBe('1920x720');
	expect(await masterResolution(1280, 720, [16, 9])).toBe('1280x720');
	expect(await masterResolution(1280, 720, [9, 32])).toBe('1280x4551');
});

test('Conversion to HLS with a small mediaTimestampBase doesn\'t copy AAC priming into wrapped PTS', async () => {
	// Where the primed AAC can't be transcoded (nothing decodes it in Node), its copy would start before zero, which
	// MPEG-TS segments can't store once the base doesn't lift it: they wrap it around to the end of the PTS range
	const readPtsValues = (bytes: Uint8Array) => {
		const values: number[] = [];
		for (let i = 0; i + 188 <= bytes.length; i += 188) {
			const packet = bytes.subarray(i, i + 188);
			const pid = ((packet[1]! & 0x1f) << 8) | packet[2]!;
			if (!(packet[1]! & 0x40) || pid === 0 || pid >= 0x1000) {
				continue;
			}

			const adaptationFieldControl = (packet[3]! >> 4) & 3;
			const pes = packet.subarray(4 + (adaptationFieldControl === 3 ? 1 + packet[4]! : 0));
			if (pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1 || !(pes[7]! & 0x80)) {
				continue;
			}

			const q = pes.subarray(9, 14);
			values.push(
				((q[0]! >> 1) & 7) * 2 ** 30 + q[1]! * 2 ** 22 + (q[2]! >> 1) * 2 ** 15 + q[3]! * 2 ** 7 + (q[4]! >> 1),
			);
		}

		return values;
	};

	const targets = new Map<string, BufferTarget>();
	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat(), mediaTimestampBase: 0.01 }),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);
			return target;
		}),
	});
	const conversion = await Conversion.init({
		input: new Input({ source: new FilePathSource('./test/public/demo.mp4'), formats: ALL_FORMATS }),
		output,
		trim: { end: 2 },
		showWarnings: false,
	});
	await conversion.execute();

	const segments = [...targets].filter(([path]) => path.endsWith('.ts'));
	expect(segments.length).toBeGreaterThan(0);
	for (const [path, target] of segments) {
		const ptsValues = readPtsValues(new Uint8Array(target.buffer!));
		expect(ptsValues.length, path).toBeGreaterThan(0);
		expect(Math.max(...ptsValues), path).toBeLessThan(2 ** 32); // Larger means a negative timestamp wrapped around
	}
});
