/* eslint-disable @stylistic/max-len */
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	CmafOutputFormat,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	HlsOutputFormat,
	Input,
	InputAudioTrack,
	InputVideoTrack,
	MpegTsOutputFormat,
	Output,
	PathedTarget,
	UrlSource,
	Mp4OutputFormat,
} from 'mediabunny';
import fs from 'node:fs';
import { createCipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { HLS, HLS_FORMATS, HlsInputFormat, MP4 } from '../../src/input-format.js';
import { InputDisposedError } from '../../src/input.js';
import { assert, hexStringToBytes, rejectAfter } from '../../src/misc.js';
import { CustomPathedSource, FilePathSource } from '../../src/source.js';
import { createAes128CbcDecryptStream } from '../../src/aes.js';
import { Reader } from '../../src/reader.js';
import { HlsSegmentedInput } from '../../src/hls/hls-segmented-input.js';
import {
	concatNalUnitsInLengthPrefixed,
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
} from '../../src/codec-data.js';

// A lot of test cases taken from:
// https://github.com/video-dev/hls.js/blob/master/tests/test-streams.js

test.concurrent('Big Buck Bunny', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	let rootReadCount = 0;
	input.source.on('read', () => rootReadCount++);

	expect(await input.getFormat()).toBeInstanceOf(HlsInputFormat);
	expect(await input.getFormat()).toBe(HLS);

	expect(sourceCount).toBe(1);
	expect(rootReadCount).toBeGreaterThan(0);

	// Test tracks directly (metadata comes from the master playlist before segments are read)
	const tracks = await input.getTracks();
	const videoTracks = tracks.filter((x): x is InputVideoTrack => x.isVideoTrack());
	const audioTracks = tracks.filter((x): x is InputAudioTrack => x.isAudioTrack());

	expect(videoTracks).toHaveLength(5);
	expect(audioTracks).toHaveLength(5);

	expect(await videoTracks[0]!.getCodec()).toBe('avc');
	expect(await videoTracks[0]!.getDisplayWidth()).toBe(1280);
	expect(await videoTracks[0]!.getDisplayHeight()).toBe(720);
	expect(await videoTracks[0]!.getBitrate()).toBe(2149280);
	expect(await videoTracks[0]!.getName()).toBe('720');
	expect(videoTracks[0]!.id).toBe(2);

	expect(await videoTracks[1]!.getCodec()).toBe('avc');
	expect(await videoTracks[1]!.getDisplayWidth()).toBe(320);
	expect(await videoTracks[1]!.getDisplayHeight()).toBe(184);
	expect(await videoTracks[1]!.getBitrate()).toBe(246440);
	expect(await videoTracks[1]!.getName()).toBe('240');
	expect(videoTracks[1]!.id).toBe(4);

	expect(await videoTracks[2]!.getCodec()).toBe('avc');
	expect(await videoTracks[2]!.getDisplayWidth()).toBe(512);
	expect(await videoTracks[2]!.getDisplayHeight()).toBe(288);
	expect(await videoTracks[2]!.getBitrate()).toBe(460560);
	expect(await videoTracks[2]!.getName()).toBe('380');
	expect(videoTracks[2]!.id).toBe(6);

	expect(await videoTracks[3]!.getCodec()).toBe('avc');
	expect(await videoTracks[3]!.getDisplayWidth()).toBe(848);
	expect(await videoTracks[3]!.getDisplayHeight()).toBe(480);
	expect(await videoTracks[3]!.getBitrate()).toBe(836280);
	expect(await videoTracks[3]!.getName()).toBe('480');
	expect(videoTracks[3]!.id).toBe(8);

	expect(await videoTracks[4]!.getCodec()).toBe('avc');
	expect(await videoTracks[4]!.getDisplayWidth()).toBe(1920);
	expect(await videoTracks[4]!.getDisplayHeight()).toBe(1080);
	expect(await videoTracks[4]!.getBitrate()).toBe(6221600);
	expect(await videoTracks[4]!.getName()).toBe('1080');
	expect(videoTracks[4]!.id).toBe(10);

	expect(await audioTracks[0]!.getCodec()).toBe('aac');
	expect(await audioTracks[0]!.getBitrate()).toBe(2149280);
	expect(await audioTracks[0]!.getName()).toBe('720');
	expect(audioTracks[0]!.id).toBe(1);

	expect(await audioTracks[1]!.getCodec()).toBe('aac');
	expect(await audioTracks[1]!.getBitrate()).toBe(246440);
	expect(await audioTracks[1]!.getName()).toBe('240');
	expect(audioTracks[1]!.id).toBe(3);

	expect(await audioTracks[2]!.getCodec()).toBe('aac');
	expect(await audioTracks[2]!.getBitrate()).toBe(460560);
	expect(await audioTracks[2]!.getName()).toBe('380');
	expect(audioTracks[2]!.id).toBe(5);

	expect(await audioTracks[3]!.getCodec()).toBe('aac');
	expect(await audioTracks[3]!.getBitrate()).toBe(836280);
	expect(await audioTracks[3]!.getName()).toBe('480');
	expect(audioTracks[3]!.id).toBe(7);

	expect(await audioTracks[4]!.getCodec()).toBe('aac');
	expect(await audioTracks[4]!.getBitrate()).toBe(6221600);
	expect(await audioTracks[4]!.getName()).toBe('1080');
	expect(audioTracks[4]!.id).toBe(9);

	for (let i = 0; i < videoTracks.length - 1; i++) {
		for (let j = i + 1; j < videoTracks.length; j++) {
			expect(videoTracks[i]!.canBePairedWith(videoTracks[j]!)).toBe(false);
		}
	}

	for (let i = 0; i < videoTracks.length; i++) {
		for (let j = 0; j < audioTracks.length; j++) {
			expect(videoTracks[i]!.canBePairedWith(audioTracks[j]!)).toBe(i === j);
		}
	}

	expect(sourceCount).toBe(1);

	// Force hydration of all tracks by loading actual media data
	for (const track of tracks) {
		expect(await track.isRelativeToUnixEpoch()).toBe(false);
	}

	expect(sourceCount).toBe(1 + 5 + 5);

	for (const track of tracks) {
		expect(await track.isLive()).toBe(false);
	}

	expect(await videoTracks[0]!.getDurationFromMetadata()).toBe(634.584);
	expect(await audioTracks[0]!.getDurationFromMetadata()).toBe(634.584);

	expect(await videoTracks[0]!.getCodedWidth()).toBe(1280);
	expect(await videoTracks[0]!.getCodedHeight()).toBe(720);
	expect(await videoTracks[1]!.getCodedWidth()).toBe(320);
	expect(await videoTracks[1]!.getCodedHeight()).toBe(184);
	expect(await videoTracks[2]!.getCodedWidth()).toBe(512);
	expect(await videoTracks[2]!.getCodedHeight()).toBe(288);
	expect(await videoTracks[3]!.getCodedWidth()).toBe(848);
	expect(await videoTracks[3]!.getCodedHeight()).toBe(480);
	expect(await videoTracks[4]!.getCodedWidth()).toBe(1920);
	expect(await videoTracks[4]!.getCodedHeight()).toBe(1080);

	// Ensure metadata display dimensions still match even after hydration (they come from the manifest hint)
	expect(await videoTracks[0]!.getDisplayWidth()).toBe(1280);
	expect(await videoTracks[0]!.getDisplayHeight()).toBe(720);
	expect(await videoTracks[1]!.getDisplayWidth()).toBe(320);
	expect(await videoTracks[1]!.getDisplayHeight()).toBe(184);
	expect(await videoTracks[2]!.getDisplayWidth()).toBe(512);
	expect(await videoTracks[2]!.getDisplayHeight()).toBe(288);
	expect(await videoTracks[3]!.getDisplayWidth()).toBe(848);
	expect(await videoTracks[3]!.getDisplayHeight()).toBe(480);
	expect(await videoTracks[4]!.getDisplayWidth()).toBe(1920);
	expect(await videoTracks[4]!.getDisplayHeight()).toBe(1080);

	expect(await videoTracks[0]!.getCodecParameterString()).toEqual('avc1.64001f');
	expect(await videoTracks[1]!.getCodecParameterString()).toEqual('avc1.42c00d'); // Slightly altered
	expect(await videoTracks[2]!.getCodecParameterString()).toEqual('avc1.42c016'); // Slightly altered
	expect(await videoTracks[3]!.getCodecParameterString()).toEqual('avc1.64001f');
	expect(await videoTracks[4]!.getCodecParameterString()).toEqual('avc1.640028');

	expect(await audioTracks[0]!.getNumberOfChannels()).toBe(2);
	expect(await audioTracks[0]!.getSampleRate()).toBe(44100);
	expect(await audioTracks[1]!.getNumberOfChannels()).toBe(2);
	expect(await audioTracks[1]!.getSampleRate()).toBe(22050);
	expect(await audioTracks[2]!.getNumberOfChannels()).toBe(2);
	expect(await audioTracks[2]!.getSampleRate()).toBe(22050);
	expect(await audioTracks[3]!.getNumberOfChannels()).toBe(2);
	expect(await audioTracks[3]!.getSampleRate()).toBe(44100);
	expect(await audioTracks[4]!.getNumberOfChannels()).toBe(2);
	expect(await audioTracks[4]!.getSampleRate()).toBe(44100);

	for (const audioTrack of audioTracks) {
		// Actual data always contains object type 2
		expect(await audioTrack.getCodecParameterString()).toEqual('mp4a.40.2');
	}

	expect(Math.min(await videoTracks[0]!.getFirstTimestamp(), await audioTracks[0]!.getFirstTimestamp())).toBe(0.0101);

	const sink = new EncodedPacketSink(videoTracks[0]!);
	const lastPacket = await sink.getPacket(Infinity);
	expect(lastPacket!.timestamp).toBeCloseTo(634.6);

	expect(sourceCount).toBe(1 + 5 + 5 + 1);

	const middlePacket = await sink.getPacket(300);
	expect(middlePacket!.timestamp).toBeCloseTo(300);

	expect(sourceCount).toBe(1 + 5 + 5 + 1 + 1);

	let lastSequenceNumber = -Infinity;
	let packetCount = 0;
	for await (const packet of sink.packets()) {
		expect(packet.sequenceNumber).toBeGreaterThan(lastSequenceNumber);

		lastSequenceNumber = packet.sequenceNumber;
		packetCount++;

		if (packet.timestamp > 18) {
			break;
		}
	}

	expect(packetCount).toBeCloseTo(18 * 60, -1); // Since 60 FPS

	const primaryVideoTrack = await input.getPrimaryVideoTrack();
	const primaryAudioTrack = await input.getPrimaryAudioTrack();

	assert(primaryVideoTrack);
	assert(primaryAudioTrack);

	// Since they're the highest-bitrate option
	expect(primaryVideoTrack).toBe(videoTracks[4]);
	expect(primaryAudioTrack).toBe(audioTracks[4]);

	expect(await input.getDurationFromMetadata()).not.toBe(null);
});

test.concurrent('Big Buck Bunny, codec parameter strings from master playlist', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(10);

	// Every CODECS attribute lives in the master playlist, so reading the codec parameter string should never force us
	// to fetch any segment source
	const codecParameterStrings = await Promise.all(tracks.map(t => t.getCodecParameterString()));
	expect(codecParameterStrings).toEqual(expect.arrayContaining([
		'mp4a.40.2',
		'mp4a.40.5',
		'avc1.64001f',
		'avc1.42000d',
		'avc1.420016',
		'avc1.640028',
	]));

	expect(sourceCount).toBe(1);
});

test.concurrent('Big Buck Bunny, determining duration from metadata', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	let m3u8Count = 0;
	input.on('source', ({ request, isRoot }) => {
		sourceCount++;
		if (isRoot || request?.path.endsWith('.m3u8')) {
			m3u8Count++;
		}
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	expect(sourceCount).toBe(1);

	const approxDuration = await track.getDurationFromMetadata();
	expect(approxDuration).toBe(634.567);

	// master, playlist and reference playlist, no segments
	expect(sourceCount).toBe(3);
	expect(m3u8Count).toBe(sourceCount);
});

test.concurrent('Single-variant Big Buck Bunny', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://test-streams.mux.dev/x36xhzz/url_6/193039199_mp4_h264_aac_hq_7.m3u8'),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	const audioTrack = tracks[0]! as InputAudioTrack;
	expect(audioTrack.isAudioTrack()).toBe(true);
	expect(await audioTrack.getCodec()).toBe('aac');

	const videoTrack = tracks[1] as InputVideoTrack;
	expect(videoTrack.isVideoTrack()).toBe(true);
	expect(await videoTrack.getCodec()).toBe('avc');
});

test.concurrent('Codec-less (underspecified) master playlist', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://test-streams.mux.dev/test_001/stream.m3u8'),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(12);

	const codecs = new Set(await Promise.all(tracks.map(x => x.getCodec())));
	expect(codecs.size).toBe(2);
	expect(codecs.has('avc')).toBe(true);
	expect(codecs.has('aac')).toBe(true);
});

test.concurrent('AES and discontinuities', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8'),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	expect(sourceCount).toBe(3); // Entry, first segment, and encryption key

	const sink = new EncodedPacketSink(videoTrack);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	let packetCount = 0;

	// Loop over the discontunity boundary
	for await (const packet of sink.packets((await sink.getPacket(35))!)) {
		packetCount++;

		if (packet.timestamp >= 40) {
			break;
		}
	}

	expect(packetCount).toBe(125);
});

test.concurrent('Range requests', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/issue666/playlists/cisq0gim60007xzvi505emlxx.m3u8'),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);
	expect(firstPacket.timestamp).toBeCloseTo(0, 1);

	const lastPacket = await sink.getPacket(Infinity);
	assert(lastPacket);
	expect(lastPacket.timestamp).toBeCloseTo(47.24);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBeCloseTo(-0.02133);

	expect(sourceCount).toBe(2);
});

test.concurrent('Custom IV', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/customIV/prog_index.m3u8'),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	expect(sourceCount).toBe(3); // Entry, first segment, and encryption key
});

test.concurrent('Segments shorter than their EXTINF duration', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/oceans_aes/oceans_aes-audio=65000-video=236000.m3u8'),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	// The playlist places this timestamp at the end of one segment, but the media puts it in the next one
	const sink = new EncodedPacketSink(videoTrack);
	expect((await sink.getPacket(24.9))!.timestamp).toBeCloseTo(24.89986666666667);
	expect((await sink.getKeyPacket(24.9))!.timestamp).toBeCloseTo(24.81645555555556);
});

test.concurrent('Out-of-band audio track via ADTS', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/aes-with-tracks/master.m3u8'),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	const videoOnlyKeyPacketsFlags = await Promise.all(
		tracks.filter((x): x is InputVideoTrack => x.isVideoTrack()).map(x => x.hasOnlyKeyPackets()),
	);
	expect(videoOnlyKeyPacketsFlags.some(x => x)).toBe(true);

	const audioTrack = tracks.find((x): x is InputAudioTrack => x.isAudioTrack());
	assert(audioTrack);
	expect(await audioTrack.hasOnlyKeyPackets()).toBe(true);

	expect(await audioTrack.getPairableVideoTracks()).toHaveLength(1); // Since the I-frame one isn't pairable
	const videoTrack = (await audioTrack.getPairableVideoTracks())[0]!;
	assert(videoTrack);
	expect(await videoTrack.hasOnlyKeyPackets()).toBe(false);

	let lastTimestamp = -Infinity;
	const sink = new EncodedPacketSink(audioTrack);
	for await (const packet of sink.packets()) {
		expect(packet.timestamp).toBeGreaterThan(lastTimestamp);
		lastTimestamp = packet.timestamp;
	}

	expect(await videoTrack.getFirstTimestamp()).toBe(0);
	expect(await audioTrack.getFirstTimestamp()).toBeCloseTo(-0.1111);

	expect(await videoTrack.computeDuration()).toBe(29.56);
	expect(await audioTrack.computeDuration()).toBe(29.456895833333334);
});

test.concurrent('MP3 audio only', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://pl.streamingvideoprovider.com/mp3-playlist/playlist.m3u8'),
		formats: ALL_FORMATS,
	});

	const audioTrack = (await input.getAudioTracks())[0];
	assert(audioTrack);
	expect(await audioTrack.getCodec()).toBe('mp3');

	expect(await audioTrack.getFirstTimestamp()).toBe(0);
});

test.concurrent('Out-of-band audio track via ADTS, ID3 tags stripped', { timeout: 30_000 }, async () => {
	const rootPath = 'https://playertest.longtailvideo.com/adaptive/aes-with-tracks/master.m3u8';
	let strippedSegmentCount = 0;

	using input = new Input({
		source: new CustomPathedSource(rootPath, async ({ path }) => {
			if (path.endsWith('audio/aac/und/stream.m3u8')) {
				// We decrypt the audio segments ourselves so that we can strip their ID3 tags
				const playlist = new TextDecoder().decode(await fetchBytes(path));
				const withoutKey = playlist.split('\n').filter(x => !x.startsWith('#EXT-X-KEY')).join('\n');
				return new BufferSource(new TextEncoder().encode(withoutKey));
			}

			if (path.endsWith('.aac')) {
				const key = await fetchBytes(new URL('key.bin', path).href);
				const sequenceNumber = Number(path.match(/segment-(\d+)\.aac$/)![1]);

				// Without an IV attribute, the IV is the big-endian media sequence number
				const iv = new Uint8Array(16);
				new DataView(iv.buffer).setUint32(12, sequenceNumber);

				const ciphertextReader = new Reader(new BufferSource(await fetchBytes(path)));
				const stream = createAes128CbcDecryptStream(ciphertextReader, () => ({ key, iv }), () => {});
				const decrypted = new Uint8Array(await new Response(stream).arrayBuffer());

				strippedSegmentCount++;
				return new BufferSource(stripId3V2Tags(decrypted));
			}

			return new UrlSource(path);
		}),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	const videoTrack = (await audioTrack.getPairableVideoTracks())[0];
	assert(videoTrack);

	// Without the PRIV timestamps, each segment's media is placed at the segment's playlist timestamp
	expect(await videoTrack.getFirstTimestamp()).toBe(0);
	expect(await audioTrack.getFirstTimestamp()).toBe(0);

	const sink = new EncodedPacketSink(audioTrack);
	expect((await sink.getPacket(6.016))!.timestamp).toBe(6.016);
	expect((await sink.getPacket(12.032))!.timestamp).toBe(12.032);
	expect((await sink.getPacket(20))!.timestamp).toBeCloseTo(19.989333, 5);

	let lastTimestamp = -Infinity;
	for await (const packet of sink.packets()) {
		expect(packet.timestamp).toBeGreaterThan(lastTimestamp);
		lastTimestamp = packet.timestamp;
	}

	expect(strippedSegmentCount).toBeGreaterThan(0);
});

test.concurrent('MP3 audio only, ID3 tags stripped', { timeout: 30_000 }, async () => {
	const rootPath = 'https://pl.streamingvideoprovider.com/mp3-playlist/playlist.m3u8';
	let strippedSegmentCount = 0;

	using input = new Input({
		source: new CustomPathedSource(rootPath, async ({ path }) => {
			if (path.endsWith('.mp3')) {
				strippedSegmentCount++;
				return new BufferSource(stripId3V2Tags(await fetchBytes(path)));
			}

			return new UrlSource(path);
		}),
		formats: ALL_FORMATS,
	});

	const audioTrack = (await input.getAudioTracks())[0];
	assert(audioTrack);
	expect(await audioTrack.getCodec()).toBe('mp3');

	// Without the PRIV timestamps, each segment's media is placed at the segment's playlist timestamp
	expect(await audioTrack.getFirstTimestamp()).toBe(0);

	const sink = new EncodedPacketSink(audioTrack);
	expect((await sink.getPacket(10))!.timestamp).toBe(10);
	expect((await sink.getPacket(20))!.timestamp).toBe(20);

	let lastTimestamp = -Infinity;
	let packetCount = 0;
	for await (const packet of sink.packets(undefined, (await sink.getPacket(40))!)) {
		expect(packet.timestamp).toBeGreaterThan(lastTimestamp);
		lastTimestamp = packet.timestamp;
		packetCount++;
	}
	expect(packetCount).toBeGreaterThan(1000);

	expect(strippedSegmentCount).toBeGreaterThan(0);
});

test.concurrent('fMP4', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8'),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();

	assert(videoTrack);
	assert(audioTrack);

	expect(await videoTrack.getCodedWidth()).toBe(768);
	expect(await videoTrack.getCodedHeight()).toBe(576);
	expect(await audioTrack.getNumberOfChannels()).toBe(2);
	expect(await audioTrack.getSampleRate()).toBe(48000);

	expect(await videoTrack.getFirstTimestamp()).toBe(0);
	expect(await videoTrack.computeDuration()).toBe(60);

	expect(await audioTrack.getFirstTimestamp()).toBe(-0.021333333333333333);
	expect(await audioTrack.computeDuration()).toBe(60);

	expect(sourceCount).toBe(
		1 // Master
		+ 2 * (1 + 1 + 1 + 1) // For each track: playlist, init, first segment, last segment
		+ (1 + 1 + 1), // Reference track: playlist, init, first segment
	);
});

test.concurrent('Track disposition & metadata', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8'),
		formats: ALL_FORMATS,
	});

	const audioTracks = await input.getAudioTracks();

	expect(audioTracks).toHaveLength(6);

	expect(await audioTracks[0]!.getLanguageCode()).toBe('en');
	expect(await audioTracks[1]!.getLanguageCode()).toBe('de');
	expect(await audioTracks[2]!.getLanguageCode()).toBe('it');
	expect(await audioTracks[3]!.getLanguageCode()).toBe('fr');
	expect(await audioTracks[4]!.getLanguageCode()).toBe('es');
	expect(await audioTracks[5]!.getLanguageCode()).toBe('en');

	expect((await audioTracks[0]!.getDisposition()).primary).toBe(true);
	expect((await audioTracks[1]!.getDisposition()).primary).toBe(false);
	expect((await audioTracks[2]!.getDisposition()).primary).toBe(false);
	expect((await audioTracks[3]!.getDisposition()).primary).toBe(false);
	expect((await audioTracks[4]!.getDisposition()).primary).toBe(false);
	expect((await audioTracks[5]!.getDisposition()).primary).toBe(false);

	expect((await audioTracks[0]!.getDisposition()).default).toBe(true);
	expect((await audioTracks[1]!.getDisposition()).default).toBe(true);
	expect((await audioTracks[2]!.getDisposition()).default).toBe(true);
	expect((await audioTracks[3]!.getDisposition()).default).toBe(true);
	expect((await audioTracks[4]!.getDisposition()).default).toBe(true);
	expect((await audioTracks[5]!.getDisposition()).default).toBe(false);

	expect(await audioTracks[0]!.getName()).toBe('stream_5');
	expect(await audioTracks[1]!.getName()).toBe('stream_4');
	expect(await audioTracks[2]!.getName()).toBe('stream_8');
	expect(await audioTracks[3]!.getName()).toBe('stream_7');
	expect(await audioTracks[4]!.getName()).toBe('stream_9');
	expect(await audioTracks[5]!.getName()).toBe('stream_6');
});

test.concurrent('fMP4 Bitmovin', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://bitdash-a.akamaihd.net/content/MI201109210084_1/m3u8s-fmp4/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.m3u8', {
			requestInit: {
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
					'Accept': '*/*',
					'Accept-Language': 'en-US,en;q=0.9',
					'Origin': 'https://bitmovin.com',
					'Referer': 'https://bitmovin.com/',
				},
			},
		}),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	const tracks = await input.getTracks();
	const videoTracks = tracks.filter((x): x is InputVideoTrack => x.isVideoTrack());
	const audioTracks = tracks.filter((x): x is InputAudioTrack => x.isAudioTrack());
	expect(videoTracks).toHaveLength(6);
	expect(audioTracks).toHaveLength(1);

	const videoDisplayDims = await Promise.all(
		videoTracks.map(async t => ({ w: await t.getDisplayWidth(), h: await t.getDisplayHeight() })),
	);
	expect(videoDisplayDims.some(d => d.w === 320 && d.h === 180)).toBe(true);
	expect(videoDisplayDims.some(d => d.w === 480 && d.h === 270)).toBe(true);
	expect(videoDisplayDims.some(d => d.w === 640 && d.h === 360)).toBe(true);
	expect(videoDisplayDims.some(d => d.w === 960 && d.h === 540)).toBe(true);
	expect(videoDisplayDims.some(d => d.w === 1280 && d.h === 720)).toBe(true);
	expect(videoDisplayDims.some(d => d.w === 1920 && d.h === 1080)).toBe(true);

	const videoTrack = videoTracks[0];
	assert(videoTrack);

	expect(await videoTrack.getFirstTimestamp()).toBe(0);
	expect(await videoTrack.computeDuration()).toBe(210.28);

	const audioTrack = audioTracks[0];
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBe(-0.08);

	expect(sourceCount).toBe(5 + 3); // 3 for the reference track
});

test.concurrent('Single-value PDT', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/aviion/manifest.m3u8'),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect((await Promise.all(tracks.map(x => x.isRelativeToUnixEpoch()))).every(x => x)).toBe(true);
	expect((await Promise.all(tracks.map(x => x.hasUnixTimeMapping()))).every(x => x)).toBe(true);

	const track = tracks[0]!;
	const firstTimestamp = await track.getFirstTimestamp();
	expect(firstTimestamp).toBe(Date.parse('2013-05-08T17:40:50Z') / 1000);

	expect(await track.getUnixTimeForTimestamp(firstTimestamp)).toBe(firstTimestamp);

	const endTimestamp = await track.computeDuration();
	expect(endTimestamp).toBe(firstTimestamp + 50);

	const endDateTime = new Date(endTimestamp * 1000).toISOString();
	expect(endDateTime).toBe('2013-05-08T17:41:40.000Z');

	const sink = new EncodedPacketSink(track);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);
	expect(firstPacket.timestamp).toBe(firstTimestamp);
	expect(firstPacket.sequenceNumber).toBe(752); // Make sure it's not huge

	const lastPacket = await sink.getPacket(Infinity);
	assert(lastPacket);
	expect(lastPacket.timestamp).toBeCloseTo(firstTimestamp + 50, 1);
	expect(lastPacket.sequenceNumber).toBeLessThan(1e8 * 60);
});

test.concurrent('Duplicate PDT', { timeout: 30_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/artbeats/manifest.m3u8'),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	const offsetFromVideo = -0.033;
	expect(await videoTrack.getFirstTimestamp()).toBe(Date.parse('2013-06-17T18:32:00Z') / 1000);
	expect(await audioTrack.getFirstTimestamp()).toBe(Date.parse('2013-06-17T18:32:00Z') / 1000 + offsetFromVideo);

	// Ensure the timestamps are monotonically increasing
	const sink = new EncodedPacketSink(audioTrack);
	let lastTimestamp = -Infinity;
	for await (const packet of sink.packets()) {
		expect(packet.timestamp).toBeGreaterThan(lastTimestamp);
		lastTimestamp = packet.timestamp;
	}
});

test.concurrent('PDT with large gaps', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/boxee/playlist.m3u8'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new EncodedPacketSink(audioTrack);
	const packet = await sink.getPacket(Date.parse('2012-12-06T19:10:03+00:00') / 1000 + 6);
	assert(packet);

	const nextPacket = await sink.getNextPacket(packet);
	assert(nextPacket);

	expect(nextPacket.timestamp - packet.timestamp).toBeGreaterThan(59);
});

test.concurrent('PDT with bad values', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/progdatime/playlist2.m3u8'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.isRelativeToUnixEpoch()).toBe(false);
});

test.concurrent('Single-value PDT with unix offsets disabled', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/aviion/manifest.m3u8'),
		formats: ALL_FORMATS,
		formatOptions: {
			hls: {
				offsetTimestampsByDateTime: false,
			},
		},
	});

	const tracks = await input.getTracks();
	expect((await Promise.all(tracks.map(x => x.isRelativeToUnixEpoch()))).every(x => x)).toBe(false);
	expect((await Promise.all(tracks.map(x => x.hasUnixTimeMapping()))).every(x => x)).toBe(true);

	const track = tracks[0]!;
	const firstTimestamp = await track.getFirstTimestamp();
	expect(firstTimestamp).toBe(0);

	const endTimestamp = await track.computeDuration();
	expect(endTimestamp).toBe(firstTimestamp + 50);

	const firstPacket = await new EncodedPacketSink(track).getFirstPacket();
	assert(firstPacket);
	expect(firstPacket.timestamp).toBe(firstTimestamp); // Kinda obvious check tbh

	const unixStartTime = await track.getUnixTimeForTimestamp(firstTimestamp);
	expect(unixStartTime).toBe(Date.parse('2013-05-08T17:40:50Z') / 1000);

	const unixEndTime = await track.getUnixTimeForTimestamp(endTimestamp);
	expect(unixEndTime).toBe(Date.parse('2013-05-08T17:41:40Z') / 1000);

	const unixTimeBeforeStart = await track.getUnixTimeForTimestamp(firstTimestamp - 10);
	expect(unixTimeBeforeStart).toBe(Date.parse('2013-05-08T17:40:40Z') / 1000);

	const unixTimeAfterEnd = await track.getUnixTimeForTimestamp(endTimestamp + 10);
	expect(unixTimeAfterEnd).toBe(Date.parse('2013-05-08T17:41:50Z') / 1000);

	const timestampDt = 0.001;
	const unixTimeDt = (await track.getUnixTimeForTimestamp(firstTimestamp + 0.001))! - unixStartTime!;
	expect(unixTimeDt).toBeCloseTo(timestampDt);
});

test.concurrent('Alternative audio only', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/alt-audio-no-video/sintel/playlist.m3u8'),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	expect(tracks[0]!.type).toBe('audio');
	expect(await tracks[0]!.getLanguageCode()).toBe('en');
	expect(await tracks[0]!.getName()).toBe('English');

	expect(tracks[1]!.type).toBe('audio');
	expect(await tracks[1]!.getLanguageCode()).toBe('dubbing');
	expect(await tracks[1]!.getName()).toBe('Dubbing');
});

test.concurrent('Advanced Apple HLS', { timeout: 30_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_adv_example_hevc/master.m3u8'),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	const videoTracks = tracks.filter((x): x is InputVideoTrack => x.isVideoTrack());
	const audioTracks = tracks.filter((x): x is InputAudioTrack => x.isAudioTrack());

	expect(audioTracks).toHaveLength(3);
	expect(videoTracks).toHaveLength(28);

	const snapshotVideoTrack = async (t: InputVideoTrack) => ({
		codec: await t.getCodec(),
		displayWidth: await t.getDisplayWidth(),
		displayHeight: await t.getDisplayHeight(),
		bitrate: await t.getBitrate(),
		hasOnlyKeyPackets: await t.hasOnlyKeyPackets(),
		codecParameterString: await t.getCodecParameterString(),
	});
	const snapshotAudioTrack = async (t: InputAudioTrack) => ({
		codec: await t.getCodec(),
		name: await t.getName(),
		languageCode: await t.getLanguageCode(),
		codecParameterString: await t.getCodecParameterString(),
	});

	const audioSnapshots = await Promise.all(audioTracks.map(snapshotAudioTrack));
	const videoSnapshots = await Promise.all(videoTracks.map(snapshotVideoTrack));

	expect(audioSnapshots[0]).toMatchObject({ codec: 'aac', name: 'English', languageCode: 'en', codecParameterString: 'mp4a.40.2' });
	expect(audioSnapshots[1]).toMatchObject({ codec: 'ac3', name: 'English', languageCode: 'en', codecParameterString: 'ac-3' });
	expect(audioSnapshots[2]).toMatchObject({ codec: 'eac3', name: 'English', languageCode: 'en', codecParameterString: 'ec-3' });

	expect(await audioTracks[0]!.getPairableVideoTracks()).toHaveLength(18);
	expect(await audioTracks[1]!.getPairableVideoTracks()).toHaveLength(18);
	expect(await audioTracks[2]!.getPairableVideoTracks()).toHaveLength(18);

	// I-FRAME AVC

	expect(videoSnapshots[0]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 1015727, hasOnlyKeyPackets: true, codecParameterString: 'avc1.640028' });
	expect(videoSnapshots[1]).toMatchObject({ codec: 'avc', displayWidth: 1280, displayHeight: 720, bitrate: 760174, hasOnlyKeyPackets: true, codecParameterString: 'avc1.64001f' });
	expect(videoSnapshots[2]).toMatchObject({ codec: 'avc', displayWidth: 960, displayHeight: 540, bitrate: 520162, hasOnlyKeyPackets: true, codecParameterString: 'avc1.64001f' });
	expect(videoSnapshots[3]).toMatchObject({ codec: 'avc', displayWidth: 640, displayHeight: 360, bitrate: 186651, hasOnlyKeyPackets: true, codecParameterString: 'avc1.64001f' });
	expect(videoSnapshots[4]).toMatchObject({ codec: 'avc', displayWidth: 480, displayHeight: 270, bitrate: 95410, hasOnlyKeyPackets: true, codecParameterString: 'avc1.64001f' });

	for (let i = 0; i <= 4; i++) {
		const videoTrack = videoTracks[i]!;
		expect(audioTracks.some(x => x.canBePairedWith(videoTrack))).toBe(false);
	}

	// AVC

	expect(videoSnapshots[5]).toMatchObject({ codec: 'avc', displayWidth: 960, displayHeight: 540, bitrate: 2746096, hasOnlyKeyPackets: false, codecParameterString: 'avc1.640020' });
	expect(videoSnapshots[6]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 10095767, hasOnlyKeyPackets: false, codecParameterString: 'avc1.64002a' });
	expect(videoSnapshots[7]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 7540836, hasOnlyKeyPackets: false, codecParameterString: 'avc1.64002a' });
	expect(videoSnapshots[8]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 5644219, hasOnlyKeyPackets: false, codecParameterString: 'avc1.64002a' });
	expect(videoSnapshots[9]).toMatchObject({ codec: 'avc', displayWidth: 1280, displayHeight: 720, bitrate: 3833756, hasOnlyKeyPackets: false, codecParameterString: 'avc1.640020' });
	expect(videoSnapshots[10]).toMatchObject({ codec: 'avc', displayWidth: 768, displayHeight: 432, bitrate: 1698402, hasOnlyKeyPackets: false, codecParameterString: 'avc1.64001f' });
	expect(videoSnapshots[11]).toMatchObject({ codec: 'avc', displayWidth: 640, displayHeight: 360, bitrate: 1240204, hasOnlyKeyPackets: false, codecParameterString: 'avc1.64001f' });
	expect(videoSnapshots[12]).toMatchObject({ codec: 'avc', displayWidth: 480, displayHeight: 270, bitrate: 805319, hasOnlyKeyPackets: false, codecParameterString: 'avc1.64001f' });
	expect(videoSnapshots[13]).toMatchObject({ codec: 'avc', displayWidth: 416, displayHeight: 234, bitrate: 561903, hasOnlyKeyPackets: false, codecParameterString: 'avc1.64001f' });

	for (let i = 5; i <= 13; i++) {
		const videoTrack = videoTracks[i]!;
		expect(audioTracks.every(x => x.canBePairedWith(videoTrack))).toBe(true);
	}

	// I-FRAME HEVC

	expect(videoSnapshots[14]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 328352, hasOnlyKeyPackets: true, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[15]).toMatchObject({ codec: 'hevc', displayWidth: 1280, displayHeight: 720, bitrate: 226274, hasOnlyKeyPackets: true, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[16]).toMatchObject({ codec: 'hevc', displayWidth: 960, displayHeight: 540, bitrate: 159037, hasOnlyKeyPackets: true, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[17]).toMatchObject({ codec: 'hevc', displayWidth: 640, displayHeight: 360, bitrate: 92800, hasOnlyKeyPackets: true, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[18]).toMatchObject({ codec: 'hevc', displayWidth: 480, displayHeight: 270, bitrate: 51760, hasOnlyKeyPackets: true, codecParameterString: 'hvc1.2.4.L123.B0' });

	for (let i = 14; i <= 18; i++) {
		const videoTrack = videoTracks[i]!;
		expect(audioTracks.some(x => x.canBePairedWith(videoTrack))).toBe(false);
	}

	// HEVC

	expect(videoSnapshots[19]).toMatchObject({ codec: 'hevc', displayWidth: 960, displayHeight: 540, bitrate: 2386827, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[20]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 6886727, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[21]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 5650398, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[22]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 4302269, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[23]).toMatchObject({ codec: 'hevc', displayWidth: 1280, displayHeight: 720, bitrate: 2987200, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[24]).toMatchObject({ codec: 'hevc', displayWidth: 768, displayHeight: 432, bitrate: 1448754, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[25]).toMatchObject({ codec: 'hevc', displayWidth: 640, displayHeight: 360, bitrate: 1124269, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[26]).toMatchObject({ codec: 'hevc', displayWidth: 480, displayHeight: 270, bitrate: 771426, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[27]).toMatchObject({ codec: 'hevc', displayWidth: 416, displayHeight: 234, bitrate: 563212, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });

	for (let i = 19; i <= 27; i++) {
		const videoTrack = videoTracks[i]!;
		expect(audioTracks.every(x => x.canBePairedWith(videoTrack))).toBe(true);
	}
});

test.concurrent('Live HLS', { timeout: 30_000 }, async () => {
	const consoleSpy = vi.spyOn(console, 'warn');

	using input = new Input({
		source: new UrlSource('https://stream.mux.com/v69RSHhFelSm4701snP22dYz2jICy4E4FUyk02rW4gxRM.m3u8'),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await videoTrack.isLive()).toBe(true);
	expect(await audioTrack.isLive()).toBe(true);

	const videoRefreshInterval = await videoTrack.getLiveRefreshInterval();
	const audioRefreshInterval = await audioTrack.getLiveRefreshInterval();
	expect(videoRefreshInterval).toBe(2);
	expect(audioRefreshInterval).toBe(2);

	const durationFailed = Promise.race([
		videoTrack.computeDuration(),
		rejectAfter(2000, 'Baby you make me smile'),
	]);
	await expect(durationFailed).rejects.toThrow('Baby you make me smile');

	const duration = await Promise.race([
		videoTrack.computeDuration({ skipLiveWait: true }),
		rejectAfter(2000, 'Baby you make me smile'),
	]);
	expect(duration).toBeGreaterThan((Date.now() / 1000) - 3600);

	const sink = new EncodedPacketSink(videoTrack);

	let currentLastPacket = await sink.getPacket(Infinity, { skipLiveWait: true });
	assert(currentLastPacket);

	// Actually find the last packet in decode order
	while (true) {
		const nextKnownPacket = await sink.getNextPacket(currentLastPacket, { skipLiveWait: true });
		if (!nextKnownPacket) {
			break;
		}

		currentLastPacket = nextKnownPacket;
	}

	// This tests waiting for the live stream to advance
	const nextPacket = await sink.getNextPacket(currentLastPacket);
	assert(nextPacket);
	expect(nextPacket.sequenceNumber).toBeGreaterThan(currentLastPacket.sequenceNumber);

	const metadataDurationFailed = Promise.race([
		videoTrack.getDurationFromMetadata(),
		rejectAfter(2000, 'Baby you make me smile'),
	]);
	await expect(metadataDurationFailed).rejects.toThrow('Baby you make me smile');

	const metadataDuration = await Promise.race([
		videoTrack.getDurationFromMetadata({ skipLiveWait: true }),
		rejectAfter(2000, 'Baby you make me smile'),
	]);
	expect(metadataDuration).toBeGreaterThan((Date.now() / 1000) - 3600);

	// The server doesn't answer with range requests but since it's HLS we suppress that warning
	expect(consoleSpy).not.toHaveBeenCalled();
});

test('Live playlists are not reloaded before a target duration has passed', async () => {
	// "the client MUST wait for at least the target duration before attempting to reload the Playlist file again,
	// measured from the last time the client began loading the Playlist file" (RFC 8216, Section 6.3.4)
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });

	try {
		let playlistReads = 0;
		using input = new Input({
			source: new CustomPathedSource('live.m3u8', ({ path }) => {
				if (path === 'live.m3u8') {
					playlistReads++;
					return new BufferSource(new TextEncoder().encode('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n0.ts\n'));
				}

				return new FilePathSource('./test/public/0.ts');
			}),
			formats: HLS_FORMATS,
		});

		// Loaded at time 0
		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);
		expect(playlistReads).toBe(1);

		// 40 ms before the target duration has passed, a refresh is due soon, but must not happen yet
		await vi.advanceTimersByTimeAsync(960);
		const refreshIntervalPromise = videoTrack.getLiveRefreshInterval();
		await vi.advanceTimersByTimeAsync(30);
		expect(playlistReads).toBe(1);

		await vi.advanceTimersByTimeAsync(20);
		expect(await refreshIntervalPromise).toBe(1);
		expect(playlistReads).toBe(2);
	} finally {
		vi.useRealTimers();
	}
});

test('An unchanged live playlist is reloaded after half the target duration', async () => {
	// "If the client reloads a Playlist file and finds that it has not changed, then it MUST wait for a period of
	// one-half the target duration before retrying." (RFC 8216, Section 6.3.4)
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });

	try {
		const loadTimes: number[] = [];
		using input = new Input({
			source: new CustomPathedSource('live.m3u8', ({ path }) => {
				if (path === 'live.m3u8') {
					loadTimes.push(performance.now());
					// Unchanged on the second load, a new segment on the third one
					const segmentCount = loadTimes.length < 3 ? 1 : 2;
					return new BufferSource(new TextEncoder().encode(
						'#EXTM3U\n#EXT-X-TARGETDURATION:1\n' + '#EXTINF:1,\n0.ts\n'.repeat(segmentCount),
					));
				}

				return new FilePathSource('./test/public/0.ts');
			}),
			formats: HLS_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);
		const start = loadTimes[0]!;

		for (const time of [1000, 1500, 2000, 2500]) {
			await vi.advanceTimersByTimeAsync(start + time - performance.now());
			expect(await videoTrack.getLiveRefreshInterval()).toBe(1);
		}

		// Unchanged at 1000 ms, so retried at 1500 ms; changed then, so not reloaded again before 2500 ms
		expect(loadTimes.map(x => x - start)).toEqual([0, 1000, 1500, 2500]);
	} finally {
		vi.useRealTimers();
	}
});

test.concurrent('Mp4InputFormat recognises a CMAF segment that starts with sidx', async () => {
	const bytes = new Uint8Array(12);
	new DataView(bytes.buffer).setUint32(0, 60); // box size
	bytes.set([0x73, 0x69, 0x64, 0x78], 4); // 'sidx'

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	expect(await input.canRead()).toBe(true);
	expect(await input.getFormat()).toBe(MP4);
});

test.concurrent('The DEFAULT=YES renditions are the primary tracks', async () => {
	const text = `#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="video",NAME="Close-up",AUTOSELECT=YES,DEFAULT=NO,URI="close-up.m3u8"
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="video",NAME="Wide",AUTOSELECT=YES,DEFAULT=YES,URI="wide.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Français",LANGUAGE="fr",AUTOSELECT=YES,DEFAULT=NO,URI="fr.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",AUTOSELECT=YES,DEFAULT=YES,URI="en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="avc1.64001f,mp4a.40.2",VIDEO="video",AUDIO="audio"
wide.m3u8
`;

	using input = new Input({
		formats: HLS_FORMATS,
		source: new CustomPathedSource('master.m3u8', () => new BufferSource(new TextEncoder().encode(text))),
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getName()).toBe('Wide');

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getName()).toBe('English');
});

test.concurrent('#EXT-X-I-FRAME-STREAM-INF tags are parsed properly', async () => {
	const text = `#EXTM3U
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=256000,CODECS="avc1.4D401E",RESOLUTION=480x270,URI="7f2459cb12854fdbbc7ec1e7279da179/f74fb10563564130a4702743d64112a3/index_11.m3u8"
`;

	const input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource('master.m3u8', () => new BufferSource(new TextEncoder().encode(text))),
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(1);
	expect(await tracks[0]!.hasOnlyKeyPackets()).toBe(true);
});

test.concurrent('#EXT-X-ENDLIST can appear anywhere in a media playlist', async () => {
	const openPlaylist = (playlist: string) => new Input({
		source: new CustomPathedSource('playlist.m3u8', ({ path }) => path === 'playlist.m3u8'
			? new BufferSource(new TextEncoder().encode(playlist))
			: new FilePathSource('./test/public/0.ts')),
		formats: HLS_FORMATS,
	});

	// "It MAY occur anywhere in the Media Playlist file" (RFC 8216, Section 4.3.3.4): before, between and after the
	// two segments
	for (const position of [0, 1, 2]) {
		const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5'];
		for (let i = 0; i <= 2; i++) {
			if (i === position) {
				lines.push('#EXT-X-ENDLIST');
			}
			if (i === 1) {
				lines.push('#EXT-X-DISCONTINUITY');
			}
			if (i < 2) {
				lines.push('#EXTINF:5,', '0.ts');
			}
		}

		using input = openPlaylist(lines.join('\n') + '\n');
		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);
		expect(await videoTrack.isLive()).toBe(false);
		expect(await videoTrack.getDurationFromMetadata()).toBe(10);

		// Both segments are read: a packet of the second one, which starts at 5 s
		const sink = new EncodedPacketSink(videoTrack);
		expect((await sink.getFirstPacket())?.timestamp).toBe(0);
		expect((await sink.getPacket(7.5))?.timestamp).toBeGreaterThanOrEqual(5);
	}

	// Lines after the tag that aren't a segment's URI are ignored, like before, e.g. an error page a server appended
	using input = openPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\n0.ts\n#EXT-X-ENDLIST\n</body></html>\n');
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getDurationFromMetadata()).toBe(5);
	expect(await new EncodedPacketSink(videoTrack).getPacket(2.5)).not.toBeNull();
});

test.concurrent('#EXT-X-I-FRAME-STREAM-INF tags without BANDWIDTH attribute are rejected', async () => {
	const text = `#EXTM3U
#EXT-X-I-FRAME-STREAM-INF:CODECS="avc1.4D401E",RESOLUTION=480x270,URI="7f2459cb12854fdbbc7ec1e7279da179/f74fb10563564130a4702743d64112a3/index_11.m3u8"
`;

	const input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource('master.m3u8', () => new BufferSource(new TextEncoder().encode(text))),
	});

	await expect(input.getTracks()).rejects.toThrow('BANDWIDTH');
});

test.concurrent('#EXT-X-BYTERANGE without an offset must continue a byte range of the same resource', async () => {
	// Two packet-aligned halves of 0.ts as segments, the second one with an implicit offset
	const half = 188 * 5000;
	const openPlaylist = (secondUri: string) => {
		const playlist = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:5
#EXTINF:2.5,
#EXT-X-BYTERANGE:${half}@0
0.ts
#EXTINF:2.5,
#EXT-X-BYTERANGE:${half}
${secondUri}
#EXT-X-ENDLIST
`;

		return new Input({
			source: new CustomPathedSource('playlist.m3u8', ({ path }) => path === 'playlist.m3u8'
				? new BufferSource(new TextEncoder().encode(playlist))
				: new FilePathSource('./test/public/0.ts')),
			formats: HLS_FORMATS,
		});
	};

	// The same resource, however it's spelled (URIs are compared once resolved): the second segment starts where the
	// first one ends
	const checkSameResource = async (secondUri: string) => {
		using input = openPlaylist(secondUri);
		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);
		expect(await videoTrack.getDurationFromMetadata()).toBe(5);
		expect(await new EncodedPacketSink(videoTrack).getFirstPacket()).not.toBeNull();
	};
	await checkSameResource('0.ts');
	await checkSameResource('./0.ts');
	await checkSameResource('x/../0.ts');

	// "If o is not present, a previous Media Segment MUST appear in the Playlist file and MUST be a sub-range of the same
	// media resource, or the Media Segment is undefined and the client MUST fail to parse the Playlist." (RFC 8216,
	// Section 4.3.2.2)
	using otherResourceInput = openPlaylist('other.ts');
	await expect(otherResourceInput.getTracks()).rejects.toThrow('sub-range of the same resource');
});

test.concurrent('#EXT-X-STREAM-INF tags without BANDWIDTH attribute are rejected', async () => {
	const text = `#EXTM3U
#EXT-X-STREAM-INF:CODECS="avc1.4D401E",RESOLUTION=480x270
7f2459cb12854fdbbc7ec1e7279da179/f74fb10563564130a4702743d64112a3/index_11.m3u8
`;

	const input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource('master.m3u8', () => new BufferSource(new TextEncoder().encode(text))),
	});

	await expect(input.getTracks()).rejects.toThrow('BANDWIDTH');
});

test.concurrent('#EXT-X-STREAM-INF tags must be followed by a URI, not by another tag', async () => {
	const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.64001f,mp4a.40.2"
variant.m3u8
`;

	const input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource('master.m3u8', () => new BufferSource(new TextEncoder().encode(text))),
	});

	await expect(input.getTracks()).rejects.toThrow('a URI must follow the #EXT-X-STREAM-INF tag');
});

test.concurrent('URI-less video and audio renditions inherit variant bandwidth', async () => {
	const text = `#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="video",NAME="Source",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=3214134,AVERAGE-BANDWIDTH=2800000,CODECS="avc1.64001F,mp4a.40.2",VIDEO="video",AUDIO="audio"
variant.m3u8
`;

	using input = new Input({
		formats: HLS_FORMATS,
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			assert(path === 'master.m3u8');
			return new BufferSource(new TextEncoder().encode(text));
		}),
	});

	const videoTracks = await input.getVideoTracks();
	const audioTracks = await input.getAudioTracks();
	expect(videoTracks).toHaveLength(1);
	expect(audioTracks).toHaveLength(1);

	for (const track of [...videoTracks, ...audioTracks]) {
		expect(await track.getBitrate()).toBe(3214134);
		expect(await track.getAverageBitrate()).toBe(2800000);
	}
});

test.concurrent('Several audio renditions without a URI map to the audio streams of the variant\'s media', async () => {
	// One MPEG-TS file with two AAC streams of different lengths, described by two URI-less renditions: "a missing URI
	// attribute indicates that the media data for this Rendition is included in the Media Playlist of any
	// EXT-X-STREAM-INF tag referencing this EXT-X-MEDIA tag" (RFC 8216, Section 4.3.4.1)
	using sourceInput = new Input({ source: new FilePathSource('./test/public/edts.mp4'), formats: ALL_FORMATS });
	const sourceAudioTrack = await sourceInput.getPrimaryAudioTrack();
	assert(sourceAudioTrack);
	const decoderConfig = (await sourceAudioTrack.getDecoderConfig())!;
	const audioPackets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(sourceAudioTrack).packets()) {
		audioPackets.push(packet);
	}

	const target = new BufferTarget();
	const output = new Output({ format: new MpegTsOutputFormat(), target });
	const englishSource = new EncodedAudioPacketSource('aac');
	const frenchSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(englishSource);
	output.addAudioTrack(frenchSource);
	await output.start();
	for (const [i, packet] of audioPackets.entries()) {
		await englishSource.add(packet, { decoderConfig });
		if (i < 200) {
			await frenchSource.add(packet, { decoderConfig });
		}
	}
	await output.finalize();
	const tsFile = new Uint8Array(target.buffer!);

	const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="French",LANGUAGE="fr",DEFAULT=YES,AUTOSELECT=YES
#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS="mp4a.40.2",AUDIO="audio"
muxed.m3u8
`;
	const mediaPlaylist = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:9.1,\nmuxed.ts\n#EXT-X-ENDLIST\n';

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(
			path === 'muxed.ts' ? tsFile : new TextEncoder().encode(path === 'master.m3u8' ? master : mediaPlaylist),
		)),
		formats: HLS_FORMATS,
	});

	const audioTracks = await input.getAudioTracks();
	expect(await Promise.all(audioTracks.map(x => x.getName()))).toEqual(['English', 'French']);
	expect((await Promise.all(audioTracks.map(x => x.getDisposition()))).map(x => x.primary)).toEqual([false, true]);

	// Each rendition reads its own stream
	const packetCounts: number[] = [];
	for (const track of audioTracks) {
		let count = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			count += packet.type === 'key' ? 1 : 0;
		}
		packetCounts.push(count);
	}
	expect(packetCounts).toEqual([audioPackets.length, 200]);
});

test.concurrent('Missing media tag codec', async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/elephants_dream_v4/index.m3u8'),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(7);

	expect(tracks.filter(x => x.type === 'video')).toHaveLength(4);
	expect(tracks.filter(x => x.type === 'audio')).toHaveLength(3);

	expect([...new Set(await Promise.all(tracks.map(x => x.getCodec())))]).toEqual(['aac', 'avc']);
});

test.concurrent('Only one Content Steering Pathway of a multivariant playlist is used', async () => {
	// The same two variants on two Pathways (CDNs). "Content Steering allows content producers to group redundant
	// Variant Streams into 'Pathways'" (RFC 8216bis, Section 7); without steering support, one Pathway is used: the
	// one EXT-X-CONTENT-STEERING starts with, or else the first one.
	const checkPathway = async (steeringTag: string, expectedPathway: string) => {
		const master = `#EXTM3U
${steeringTag}
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.64000d,mp4a.40.2",PATHWAY-ID="cdn-a"
a/high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64000d,mp4a.40.2",PATHWAY-ID="cdn-a"
a/low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.64000d,mp4a.40.2",PATHWAY-ID="cdn-b"
b/high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64000d,mp4a.40.2",PATHWAY-ID="cdn-b"
b/low.m3u8
`;
		const mediaPlaylist = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\n0.ts\n#EXT-X-ENDLIST\n';

		const requestedPaths: string[] = [];
		using input = new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => {
				requestedPaths.push(path);
				if (path.endsWith('.m3u8')) {
					return new BufferSource(new TextEncoder().encode(path === 'master.m3u8' ? master : mediaPlaylist));
				}

				return new FilePathSource('./test/public/0.ts');
			}),
			formats: HLS_FORMATS,
		});

		expect(await input.getTracks()).toHaveLength(4); // Two variants with video and audio each

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);
		expect(await new EncodedPacketSink(videoTrack).getFirstPacket()).not.toBeNull();
		expect(requestedPaths.slice(1).every(path => path.startsWith(`${expectedPathway}/`))).toBe(true);
	};

	await checkPathway('', 'a');
	await checkPathway('#EXT-X-CONTENT-STEERING:SERVER-URI="steering.json",PATHWAY-ID="cdn-b"', 'b');
});

test.concurrent('Circular/recursive HLS is forbidden', async () => {
	const text = `#EXTM3U
#EXT-X-VERSION=3
#EXT-X-TARGETDURATION=10

#EXTINF:5,
root.m3u8

#EXT-X-ENDLIST
`;

	const input = new Input({
		source: new CustomPathedSource(
			'root.m3u8',
			({ path }) => {
				assert(path === 'root.m3u8');
				return new BufferSource(new TextEncoder().encode(text));
			},
		),
		formats: HLS_FORMATS,
	});

	await expect(input.getTracks()).rejects.toThrow('unsupported');
});

test.concurrent('A CODECS attribute may list several codecs of one media type', async () => {
	// CODECS lists "every media format present in any Media Segment in any of the Renditions specified by the
	// Variant Stream" (RFC 8216bis, Section 4.4.6.2), e.g. for an audio group with an AAC and an AC-3 rendition
	const openMaster = (master: string, files: Record<string, Uint8Array> = {}) => new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			if (path.endsWith('.m3u8')) {
				const segment = { 'ac3.m3u8': 'ac3.ts', 'muxed.m3u8': 'muxed.ts' }[path] ?? '0.ts';
				return new BufferSource(new TextEncoder().encode(path === 'master.m3u8'
					? master
					: `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:5,\n${segment}\n#EXT-X-ENDLIST\n`,
				));
			}

			return files[path] ? new BufferSource(files[path]) : new FilePathSource(`./test/public/${path}`);
		}),
		formats: HLS_FORMATS,
	});

	const readAudioCodecs = async (input: Input) => {
		const audioTracks = await input.getAudioTracks();
		return Promise.all(audioTracks.map(x => x.getCodec()));
	};

	// An audio group with an AAC and an AC-3 rendition
	const checkGroup = async (codecs: string, secondUri: string, expectedCodecs: string[]) => {
		using input = openMaster(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Stereo",DEFAULT=YES,URI="aac.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Other",URI="${secondUri}"
#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="${codecs}",AUDIO="audio"
video.m3u8
`);
		expect(await input.getVideoTracks()).toHaveLength(1);
		expect(await readAudioCodecs(input)).toEqual(expectedCodecs);

		const audioTracks = await input.getAudioTracks();
		for (const track of audioTracks) {
			expect(await new EncodedPacketSink(track).getFirstPacket()).not.toBeNull();
		}
	};
	await checkGroup('avc1.64000d,mp4a.40.2,ac-3', 'ac3.m3u8', ['aac', 'ac3']);
	// AAC-LC and HE-AAC renditions
	await checkGroup('avc1.64000d,mp4a.40.2,mp4a.40.5', 'aac-he.m3u8', ['aac', 'aac']);

	// A variant without groups whose own media holds an AAC and an AC-3 stream
	const readPackets = async (path: string) => {
		using sourceInput = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
		const track = await sourceInput.getPrimaryAudioTrack();
		assert(track);
		const decoderConfig = (await track.getDecoderConfig())!;
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}
		return { packets, decoderConfig };
	};
	const aac = await readPackets('./test/public/0.ts');
	const ac3 = await readPackets('./test/public/ac3.ts');

	const target = new BufferTarget();
	const output = new Output({ format: new MpegTsOutputFormat(), target });
	const aacSource = new EncodedAudioPacketSource('aac');
	const ac3Source = new EncodedAudioPacketSource('ac3');
	output.addAudioTrack(aacSource);
	output.addAudioTrack(ac3Source);
	await output.start();
	for (const packet of aac.packets) {
		await aacSource.add(packet, { decoderConfig: aac.decoderConfig });
	}
	for (const packet of ac3.packets) {
		await ac3Source.add(packet, { decoderConfig: ac3.decoderConfig });
	}
	await output.finalize();

	using muxedInput = openMaster(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="mp4a.40.2,ac-3"
muxed.m3u8
`, { 'muxed.ts': new Uint8Array(target.buffer!) });
	expect(await readAudioCodecs(muxedInput)).toEqual(['aac', 'ac3']);

	const packetCounts: number[] = [];
	for (const track of await muxedInput.getAudioTracks()) {
		const sink = new EncodedPacketSink(track);
		let count = 0;
		for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
			count++;
		}
		packetCounts.push(count);
	}
	expect(packetCounts).toEqual([aac.packets.length, ac3.packets.length]);
});

test.concurrent('Widevine encryption (SAMPLE-AES-CTR) fails without keys', async () => {
	using input = new Input({
		source: new UrlSource('https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/hls.m3u8'),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	await expect(sink.getPacket(Infinity)).rejects.toThrow();
});

test.concurrent('Widevine encryption (SAMPLE-AES-CTR) succeeds with string keys', async () => {
	const keyMap = new Map([
		['4d97930a3d7b55fa81d0028653f5e499', '429ec76475e7a952d224d8ef867f12b6'],
		['d21373c0b8ab5ba9954742bcdfb5f48b', '150a6c7d7dee6a91b74dccfce5b31928'],
		['6f1729072b4a5cd288c916e11846b89e', 'a84b4bd66901874556093454c075e2c6'],
		['800aacaa522958ae888062b5695db6bf', '775dbf7289c4cc5847becd571f536ff2'],
		['67b30c86756f57c5a0a38a23ac8c9178', 'efa2878c2ccf6dd47ab349fcf90e6259'],
	]);

	using input = new Input({
		source: new UrlSource('https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/hls.m3u8'),
		formats: ALL_FORMATS,
		formatOptions: {
			isobmff: {
				resolveKeyId: ({ keyId, psshBoxes }) => {
					expect(psshBoxes).toHaveLength(1);
					expect(psshBoxes[0]!.systemId).toBe('edef8ba979d64acea3c827dcd51d21ed');
					expect(psshBoxes[0]!.keyIds).toBeNull();
					expect(psshBoxes[0]!.data).toEqual(new Uint8Array([
						34, 22, 115, 104, 97, 107, 97, 95,
						99, 101, 99, 50, 102, 54, 52, 97,
						97, 55, 56, 57, 48, 97, 49, 49,
						72, 227, 220, 149, 155, 6,
					]));

					const key = keyMap.get(keyId);
					assert(key);

					return key;
				},
			},
		},
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	const lastPacket = await sink.getPacket(Infinity);
	assert(lastPacket);
	expect(lastPacket.timestamp + lastPacket.duration).toBe(60);
});

test.concurrent('Widevine encryption (SAMPLE-AES-CTR) succeeds with buffer keys', async () => {
	const keyMap = new Map([
		['4d97930a3d7b55fa81d0028653f5e499', hexStringToBytes('429ec76475e7a952d224d8ef867f12b6')],
		['d21373c0b8ab5ba9954742bcdfb5f48b', hexStringToBytes('150a6c7d7dee6a91b74dccfce5b31928')],
		['6f1729072b4a5cd288c916e11846b89e', hexStringToBytes('a84b4bd66901874556093454c075e2c6')],
		['800aacaa522958ae888062b5695db6bf', hexStringToBytes('775dbf7289c4cc5847becd571f536ff2')],
		['67b30c86756f57c5a0a38a23ac8c9178', hexStringToBytes('efa2878c2ccf6dd47ab349fcf90e6259')],
	]);

	using input = new Input({
		source: new UrlSource('https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/hls.m3u8'),
		formats: ALL_FORMATS,
		formatOptions: {
			isobmff: {
				resolveKeyId: ({ keyId }) => {
					const key = keyMap.get(keyId);
					assert(key);

					return key;
				},
			},
		},
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	const lastPacket = await sink.getPacket(Infinity);
	assert(lastPacket);
	expect(lastPacket.timestamp + lastPacket.duration).toBe(60);
});

test.concurrent('HLS metadata reads after dispose() throw InputDisposedError', async () => {
	// "all future read operations will fail [...] Disallowed and canceled operations will throw an InputDisposedError"
	// (Input.dispose). Packet reads already do.
	const mediaPlaylist = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:5,\n0.ts\n#EXT-X-ENDLIST\n';
	const multivariantPlaylist = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64000d,mp4a.40.2"\nmedia.m3u8\n';

	const openInput = (rootPlaylist: string) => new Input({
		source: new CustomPathedSource('index.m3u8', ({ path }) => path.endsWith('.ts')
			? new FilePathSource('./test/public/0.ts')
			: new BufferSource(new TextEncoder().encode(path === 'index.m3u8' ? rootPlaylist : mediaPlaylist))),
		formats: HLS_FORMATS,
	});

	const check = async (rootPlaylist: string) => {
		const input = openInput(rootPlaylist);
		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);
		input.dispose();

		await expect(new EncodedPacketSink(videoTrack).getFirstPacket()).rejects.toBeInstanceOf(InputDisposedError);
		await expect(videoTrack.getDurationFromMetadata()).rejects.toBeInstanceOf(InputDisposedError);
		await expect(input.getDurationFromMetadata()).rejects.toBeInstanceOf(InputDisposedError);
	};

	await check(mediaPlaylist);
	await check(multivariantPlaylist);

	// Durations computed from the packets of a variant whose tracks were only listed, which used to never settle
	const input = openInput(multivariantPlaylist);
	const tracks = await input.getTracks();
	input.dispose();

	const settle = (promise: Promise<unknown>) => Promise.race([promise, rejectAfter(2000, 'Did not settle')]);
	await expect(settle(input.getFirstTimestamp())).rejects.toBeInstanceOf(InputDisposedError);
	for (const track of tracks) {
		await expect(settle(track.computeDuration())).rejects.toBeInstanceOf(InputDisposedError);
	}
	await expect(settle(input.computeDuration())).rejects.toBeInstanceOf(InputDisposedError);
});

test.concurrent('Widevine HLS passes #EXT-X-KEY PSSH boxes to key resolver', async () => {
	const keyMap = new Map([
		['4d97930a3d7b55fa81d0028653f5e499', '429ec76475e7a952d224d8ef867f12b6'],
		['d21373c0b8ab5ba9954742bcdfb5f48b', '150a6c7d7dee6a91b74dccfce5b31928'],
		['6f1729072b4a5cd288c916e11846b89e', 'a84b4bd66901874556093454c075e2c6'],
		['800aacaa522958ae888062b5695db6bf', '775dbf7289c4cc5847becd571f536ff2'],
		['67b30c86756f57c5a0a38a23ac8c9178', 'efa2878c2ccf6dd47ab349fcf90e6259'],
	]);

	using input = new Input({
		source: new UrlSource('https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/hls.m3u8'),
		formats: ALL_FORMATS,
		formatOptions: {
			isobmff: {
				_suppressPsshParsing: true,
				resolveKeyId: ({ keyId, psshBoxes }) => {
					expect(psshBoxes).toHaveLength(1);
					expect(psshBoxes[0]!.systemId).toBe('edef8ba979d64acea3c827dcd51d21ed');
					expect(psshBoxes[0]!.keyIds).toBeNull();
					expect(psshBoxes[0]!.data).toEqual(new Uint8Array([
						34, 22, 115, 104, 97, 107, 97, 95,
						99, 101, 99, 50, 102, 54, 52, 97,
						97, 55, 56, 57, 48, 97, 49, 49,
						72, 227, 220, 149, 155, 6,
					]));

					const key = keyMap.get(keyId);
					assert(key);

					return key;
				},
			},
		},
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	const lastPacket = await sink.getPacket(Infinity);
	assert(lastPacket);
	expect(lastPacket.timestamp + lastPacket.duration).toBe(60);
});

test.concurrent('Paths stay relative to the requested playlist when a resolver serves it from elsewhere', async () => {
	// A resolver may serve each requested path from another location, e.g. `new FilePathSource(dir + '/' + path)`.
	// The paths it receives must stay in one namespace instead of turning into that location's paths for segments.
	const files: Record<string, string> = {
		'master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64000d,mp4a.40.2"\nvideo/playlist.m3u8\n',
		'video/playlist.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\n0.ts\n#EXT-X-ENDLIST\n',
	};
	const readFile = (path: string) => path.endsWith('.ts')
		? new FilePathSource('./test/public/0.ts')
		: new BufferSource(new TextEncoder().encode(files[path]));

	const check = async (serve: (path: string) => FilePathSource | BufferSource | CustomPathedSource) => {
		const requestedPaths: string[] = [];
		using input = new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => {
				requestedPaths.push(path);
				return serve(path);
			}),
			formats: HLS_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);
		expect(await new EncodedPacketSink(videoTrack).getFirstPacket()).not.toBeNull();
		expect(requestedPaths).toEqual(['master.m3u8', 'video/playlist.m3u8', 'video/0.ts']);
	};

	// Plain sources, and sources with their own path
	await check(readFile);
	await check(path => new CustomPathedSource(
		`storage/${path}`,
		({ path: storagePath }) => readFile(storagePath.replace(/^(storage\/)+/, '')),
	));

	// A redirected media playlist's segments are still requested relative to where it was redirected to
	const fetchFn = async (request: string | URL | Request) => {
		const url = request instanceof Request ? request.url : request.toString();
		if (url === 'https://a.example/master.m3u8') {
			return new Response(files['master.m3u8']);
		} else if (url === 'https://a.example/video/playlist.m3u8') {
			const response = new Response(files['video/playlist.m3u8']);
			Object.defineProperty(response, 'redirected', { value: true });
			Object.defineProperty(response, 'url', { value: 'https://cdn.example/x/playlist.m3u8' });
			return response;
		}

		return new Response(null, { status: 404 });
	};
	using redirectedInput = new Input({
		source: new UrlSource('https://a.example/master.m3u8', { fetchFn }),
		formats: HLS_FORMATS,
	});
	const videoTrack = await redirectedInput.getPrimaryVideoTrack();
	assert(videoTrack);
	// The segment itself isn't served; the failed request names the URL it was looked up at
	await expect(new EncodedPacketSink(videoTrack).getFirstPacket()).rejects.toThrow('https://cdn.example/x/0.ts');
});

test.concurrent('SourceRequest.isRoot', async () => {
	using input = new Input({
		source: new CustomPathedSource(
			'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
			({ path, isRoot }) => {
				if (isRoot) {
					expect(path).toBe('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
				}

				return new UrlSource(path);
			},
		),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	await videoTrack.computeDuration();
});

test.concurrent('#EXT-X-DEFINE NAME and VALUE variables are applied', async () => {
	const text = `#EXTM3U
#EXT-X-DEFINE:NAME="prefix",VALUE="Main"
#EXT-X-DEFINE:NAME="trackName",VALUE="{$prefix} Track"
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f",NAME="{$trackName}",URI="video.m3u8"
`;

	const input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource('master.m3u8', () => new BufferSource(new TextEncoder().encode(text))),
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(1);
	expect(await tracks[0]!.getName()).toBe('Main Track');
});

test.concurrent('#EXT-X-DEFINE QUERYPARAM variables can be IMPORTed into media playlists', async () => {
	const rootPath = 'https://example.com/master.m3u8'
		+ '?mediaPlaylistPath=variant%2Em3u8&segmentPath=0%2Ets';
	const expectedMediaPlaylistPath = 'https://example.com/variant.m3u8';
	const expectedSegmentPath = 'https://example.com/0.ts';
	const multivariantPlaylist = `#EXTM3U
#EXT-X-DEFINE:QUERYPARAM="mediaPlaylistPath"
#EXT-X-DEFINE:QUERYPARAM="segmentPath"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f"
{$mediaPlaylistPath}
`;
	const mediaPlaylist = `#EXTM3U
#EXT-X-DEFINE:IMPORT="segmentPath"
#EXT-X-TARGETDURATION:10
#EXTINF:10,
{$segmentPath}
#EXT-X-ENDLIST
`;
	const requestedPaths: string[] = [];

	using input = new Input({
		source: new CustomPathedSource(
			rootPath,
			({ path }) => {
				requestedPaths.push(path);

				if (path === rootPath) {
					return new BufferSource(new TextEncoder().encode(multivariantPlaylist));
				}
				if (path === expectedMediaPlaylistPath) {
					return new BufferSource(new TextEncoder().encode(mediaPlaylist));
				}
				if (path === expectedSegmentPath) {
					return new FilePathSource('./test/public/0.ts');
				}

				throw new Error(`Unexpected source path "${path}".`);
			},
		),
		formats: HLS_FORMATS,
	});

	// Trigger media loading so the substituted playlist and segment paths are added to requestedPaths.
	await input.getFirstTimestamp();

	expect(requestedPaths).toContain(expectedMediaPlaylistPath);
	expect(requestedPaths).toContain(expectedSegmentPath);
});

test.concurrent('Segments marked with #EXT-X-GAP are not loaded', async () => {
	const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:5
#EXTINF:5,
0.ts
#EXT-X-DISCONTINUITY
#EXT-X-GAP
#EXTINF:5,
missing.ts
#EXT-X-DISCONTINUITY
#EXTINF:5,
0.ts
#EXT-X-GAP
#EXTINF:5,
missing.ts
#EXT-X-ENDLIST
`;
	const requestedPaths: string[] = [];

	using input = new Input({
		source: new CustomPathedSource('playlist.m3u8', ({ path }) => {
			requestedPaths.push(path);

			if (path === 'playlist.m3u8') {
				return new BufferSource(new TextEncoder().encode(playlist));
			}
			if (path === '0.ts') {
				return new FilePathSource('./test/public/0.ts');
			}

			// Gap segments needn't exist on the server
			throw new Error(`404 Not Found: ${path}`);
		}),
		formats: HLS_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	const sink = new EncodedPacketSink(videoTrack);

	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
	}

	// The media of both segments, with a hole where the gap is
	const firstHalf = timestamps.slice(0, timestamps.length / 2);
	const secondHalf = timestamps.slice(timestamps.length / 2);
	expect(Math.min(...firstHalf)).toBe(0);
	expect(Math.max(...firstHalf)).toBeLessThan(5);
	expect(Math.min(...secondHalf)).toBe(10);

	expect((await sink.getPacket(7))?.timestamp).toBe(Math.max(...firstHalf));
	expect(await videoTrack.getDurationFromMetadata()).toBe(20);
	expect(requestedPaths).not.toContain('missing.ts');
});

test.concurrent('I-frame segments read their PAT and PMT from the start of the resource', async () => {
	// Like the I-frame playlists of Apple's segmenter: the resource starts with its PAT and PMT (bytes 0 to 375 of
	// 0.ts), and the I-frame segment spans the key frame, which starts at byte 376 and ends in the first TS packet of
	// the next video PES packet (at 24628). A null packet inside the PES packet stands in for the packets of other
	// PIDs that real streams interleave.
	const ts = new Uint8Array(await fs.promises.readFile('./test/public/0.ts'));
	const nullPacket = new Uint8Array(188).fill(0xff);
	nullPacket.set([0x47, 0x1f, 0xff, 0x10]);
	const resource = new Uint8Array([
		...ts.subarray(0, 564),
		...nullPacket,
		...ts.subarray(564, 24628 + 188),
	]);

	const files = new Map<string, string | Uint8Array>([
		['master.m3u8', `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.64001f,mp4a.40.2"
main.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=40000,CODECS="avc1.64001f",URI="iframes.m3u8"
`],
		['main.m3u8', `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXTINF:5,
0.ts
#EXT-X-ENDLIST
`],
		['iframes.m3u8', `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:5
#EXT-X-I-FRAMES-ONLY
#EXTINF:5,
#EXT-X-BYTERANGE:${resource.length - 376}@376
resource.ts
#EXT-X-ENDLIST
`],
		['0.ts', ts],
		['resource.ts', resource],
	]);

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			const file = files.get(path)!;
			return new BufferSource(typeof file === 'string' ? new TextEncoder().encode(file) : file);
		}),
		formats: HLS_FORMATS,
	});

	const tracks = await input.getTracks();
	const iFrameTrack = tracks[2];
	assert(iFrameTrack?.isVideoTrack());
	expect(await iFrameTrack.hasOnlyKeyPackets()).toBe(true);

	// The I-frame segment holds the same key frame as the main playlist
	const keyFrame = await new EncodedPacketSink(tracks[0]!).getFirstPacket();
	const sink = new EncodedPacketSink(iFrameTrack);
	const packet = await sink.getFirstPacket();
	expect(packet?.type).toBe('key');
	expect(packet?.timestamp).toBe(0);
	expect(packet?.data).toEqual(keyFrame?.data);
	expect((await iFrameTrack.getDecoderConfig())?.codec).toMatch(/^avc1\./);

	// Input-wide queries cover the I-frame track too
	expect(await input.computeDuration()).toBeGreaterThan(4.9);
});

test.concurrent('Key packet lookups in I-frame playlists settle when a key frame is not first in its PES packet', async () => {
	// Apple's segmenter cuts I-frame segments at PES packet boundaries, but its PES packets don't start at access unit
	// boundaries, so a segment can start with a leftover slice of the previous frame, followed by the key frame in the
	// same PES packet. Built here from 0.ts, whose first video PES packet is a key frame (with its last bytes spilling
	// into the second PES packet, a P frame).
	const ts = new Uint8Array(await fs.promises.readFile('./test/public/0.ts'));
	const videoPid = 256;

	const pesPackets: number[][] = [];
	for (let pos = 0; pos < ts.length && pesPackets.length <= 2; pos += 188) {
		if ((((ts[pos + 1]! & 0x1f) << 8) | ts[pos + 2]!) !== videoPid) {
			continue;
		}

		const adaptationFieldLength = ts[pos + 3]! & 0x20 ? 1 + ts[pos + 4]! : 0;
		if (ts[pos + 1]! & 0x40) {
			pesPackets.push([]);
		}
		pesPackets.at(-1)!.push(...ts.subarray(pos + 4 + adaptationFieldLength, pos + 188));
	}

	const [keyPes, nextPes] = pesPackets.map(x => new Uint8Array(x)) as [Uint8Array, Uint8Array];
	const findStartCode = (data: Uint8Array, start: number) => {
		let i = start;
		while (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) {
			i++;
		}
		return i;
	};
	const keyEs = keyPes.subarray(9 + keyPes[8]!);
	const nextEs = nextPes.subarray(9 + nextPes[8]!);
	const delimiterStart = findStartCode(nextEs, 0);
	const sliceStart = findStartCode(nextEs, delimiterStart + 3);

	// The key frame again one second later, after the P frame's slice, in a PES packet without a random access flag
	const header = keyPes.slice(0, 9 + keyPes[8]!);
	for (const offset of [9, 14]) { // PTS and DTS
		const b = header;
		const value = ((b[offset]! >> 1) & 0x07) * 2 ** 30 + b[offset + 1]! * 2 ** 22 + (b[offset + 2]! >> 1) * 2 ** 15
			+ b[offset + 3]! * 2 ** 7 + (b[offset + 4]! >> 1) + 90000;
		b[offset] = (b[offset]! & 0xf0) | ((Math.floor(value / 2 ** 30) & 0x07) << 1) | 1;
		b[offset + 1] = Math.floor(value / 2 ** 22) & 0xff;
		b[offset + 2] = ((Math.floor(value / 2 ** 15) & 0x7f) << 1) | 1;
		b[offset + 3] = Math.floor(value / 2 ** 7) & 0xff;
		b[offset + 4] = ((value & 0x7f) << 1) | 1;
	}
	const pes = new Uint8Array([
		...header,
		...nextEs.subarray(sliceStart),
		...keyEs,
		...nextEs.subarray(0, delimiterStart),
	]);

	const secondSegment: number[] = [];
	for (let offset = 0, counter = 0; offset < pes.length; counter = (counter + 1) % 16) {
		const payloadLength = Math.min(184, pes.length - offset);
		const stuffing = 184 - payloadLength;
		const packet = new Uint8Array(188).fill(0xff);
		packet.set([0x47, (offset === 0 ? 0x40 : 0) | (videoPid >> 8), videoPid & 0xff, (stuffing ? 0x30 : 0x10) | counter]);
		if (stuffing > 0) {
			packet[4] = stuffing - 1; // Adaptation field for stuffing only, without flags
			if (stuffing > 1) {
				packet[5] = 0;
			}
		}
		packet.set(pes.subarray(offset, offset + payloadLength), 4 + stuffing);
		secondSegment.push(...packet);
		offset += payloadLength;
	}

	// PAT and PMT, then the first segment (the key frame, up to the first TS packet of the next PES packet), then the
	// second segment
	const firstSegmentLength = 24628 + 188 - 376;
	const resource = new Uint8Array([...ts.subarray(0, 376 + firstSegmentLength), ...secondSegment]);
	const playlist = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:1
#EXT-X-I-FRAMES-ONLY
#EXTINF:1,
#EXT-X-BYTERANGE:${firstSegmentLength}@376
resource.ts
#EXTINF:1,
#EXT-X-BYTERANGE:${secondSegment.length}@${376 + firstSegmentLength}
resource.ts
#EXT-X-ENDLIST
`;

	using input = new Input({
		source: new CustomPathedSource('iframes.m3u8', ({ path }) => new BufferSource(
			path === 'iframes.m3u8' ? new TextEncoder().encode(playlist) : resource,
		)),
		formats: HLS_FORMATS,
	});
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	const sink = new EncodedPacketSink(videoTrack);

	const keyTimestamps: number[] = [];
	for await (const packet of sink.packets()) {
		if (packet.type === 'key') {
			keyTimestamps.push(packet.timestamp);
		}
	}
	expect(keyTimestamps).toEqual([0, 1]);

	// Without a guard, the lookup went back and forth between the segments forever, never yielding to the event loop
	// (so not even the test timeout could fire). Counting segment visits turns that into a quick failure.
	let segmentVisits = 0;
	// eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the right `this` below
	const getInputForSegment = HlsSegmentedInput.prototype.getInputForSegment;
	const spy = vi.spyOn(HlsSegmentedInput.prototype, 'getInputForSegment').mockImplementation(function (
		this: HlsSegmentedInput,
		...args: Parameters<HlsSegmentedInput['getInputForSegment']>
	) {
		if (this.input === input && ++segmentVisits > 1000) {
			throw new Error('The key packet lookup visited segments more than 1000 times without settling.');
		}

		return getInputForSegment.apply(this, args);
	});

	try {
		const keyPacket = await sink.getKeyPacket(1.5);
		expect(keyPacket?.type).toBe('key');
		expect(keyPacket!.timestamp).toBeLessThanOrEqual(1.5);
	} finally {
		spy.mockRestore();
	}
});

test.concurrent('Disposing the input releases the sources of every segment it read', async () => {
	let playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:3\n';
	for (let i = 0; i < 8; i++) {
		playlist += `${i > 0 ? '#EXT-X-DISCONTINUITY\n' : ''}#EXTINF:2.4,\nsegment-${i}.ts\n`;
	}
	playlist += '#EXT-X-ENDLIST\n';

	const segmentData = new Uint8Array(await fs.promises.readFile('./test/public/mp3.ts'));
	const disposedPaths: string[] = [];
	class TrackedSource extends BufferSource {
		constructor(private path: string) {
			super(segmentData);
		}

		override _dispose() {
			disposedPaths.push(this.path);
		}
	}

	const input = new Input({
		source: new CustomPathedSource('playlist.m3u8', ({ path }) => path === 'playlist.m3u8'
			? new BufferSource(new TextEncoder().encode(playlist))
			: new TrackedSource(path)),
		formats: HLS_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	const sink = new EncodedPacketSink(audioTrack);
	for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
		// Read everything
	}

	input.dispose();
	await new Promise(resolve => setTimeout(resolve, 10)); // Disposal completes asynchronously
	expect(disposedPaths.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `segment-${i}.ts`));
});

test.concurrent('A live media playlist without segments yet is waited on', { timeout: 15_000 }, async () => {
	// A live stream that just started: the first fetch of its playlist has no segments yet. Loaded directly, and
	// through a multivariant playlist. Each waits for one reload of the playlist, a target duration (1 s) later.
	const check = async (rootPath: string) => {
		let playlistFetches = 0;

		using input = new Input({
			source: new CustomPathedSource(rootPath, ({ path }) => {
				if (path === '0.ts') {
					return new FilePathSource('./test/public/0.ts');
				}
				if (path === 'master.m3u8') {
					return new BufferSource(new TextEncoder().encode(
						'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.64001f,mp4a.40.2"\nlive.m3u8\n',
					));
				}

				playlistFetches++;
				const text = playlistFetches === 1
					? '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n'
					: '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:5,\n0.ts\n#EXT-X-ENDLIST\n';
				return new BufferSource(new TextEncoder().encode(text));
			}),
			formats: HLS_FORMATS,
		});

		const tracks = await input.getTracks();
		expect(tracks.map(x => x.type)).toEqual(['video', 'audio']);

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);
		expect(await videoTrack.getFirstTimestamp()).toBe(0);
		expect(playlistFetches).toBe(2);
	};

	await Promise.all([check('live.m3u8'), check('master.m3u8')]);
});

test.concurrent('Media playlist tags in a multivariant playlist are ignored', async () => {
	// Not allowed in a multivariant playlist, but found in the wild. #EXT-X-TARGETDURATION only marks a media playlist
	// when there are no variant streams.
	const variant = '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.64001f,mp4a.40.2"\nvariant.m3u8\n';
	const mediaPlaylist = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\n0.ts\n#EXT-X-ENDLIST\n';

	const readVariantTracks = async (master: string) => {
		using input = new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => {
				if (path === '0.ts') {
					return new FilePathSource('./test/public/0.ts');
				}

				return new BufferSource(new TextEncoder().encode(path === 'master.m3u8' ? master : mediaPlaylist));
			}),
			formats: HLS_FORMATS,
		});

		const tracks = await input.getTracks();
		return {
			types: tracks.map(x => x.type),
			firstTimestamp: await tracks[0]!.getFirstTimestamp(), // Loads the variant's media
		};
	};

	const expected = { types: ['video', 'audio'], firstTimestamp: 0 };
	expect(await readVariantTracks(`#EXTM3U\n#EXT-X-VERSION:3\n${variant}`)).toEqual(expected);
	expect(await readVariantTracks(
		`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n${variant}`,
	)).toEqual(expected);
});

test.concurrent('Invalid #EXT-X-DEFINE tags are rejected', async () => {
	const cases = [
		{
			tag: '#EXT-X-DEFINE:VALUE="value"',
			error: 'exactly one of NAME, IMPORT, or QUERYPARAM must be present',
		},
		{
			tag: '#EXT-X-DEFINE:NAME="name",IMPORT="name",VALUE="value"',
			error: 'exactly one of NAME, IMPORT, or QUERYPARAM must be present',
		},
		{
			tag: '#EXT-X-DEFINE:NAME="name"',
			error: 'NAME requires VALUE',
		},
		{
			tag: '#EXT-X-DEFINE:NAME="invalid name",VALUE="value"',
			error: 'invalid variable name',
		},
		{
			tag: '#EXT-X-DEFINE:IMPORT="missing"',
			error: 'cannot import undefined variable',
		},
		{
			tag: '#EXT-X-DEFINE:QUERYPARAM="missing"',
			error: 'query parameter "missing" is missing',
		},
		{
			tag: '#EXT-X-DEFINE:NAME="name",VALUE="value"\n'
				+ '#EXT-X-DEFINE:NAME="name",VALUE="other"',
			error: 'variable "name" is already defined',
		},
		{
			tag: '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f",URI="{$missing}"',
			error: 'variable "missing" is referenced before being defined',
		},
	];

	for (const { tag, error } of cases) {
		using input = new Input({
			source: new CustomPathedSource(
				'https://example.com/master.m3u8',
				() => new BufferSource(new TextEncoder().encode(`#EXTM3U\n${tag}\n`)),
			),
			formats: HLS_FORMATS,
		});

		await expect(input.getTracks()).rejects.toThrow(error);
	}
});

test.concurrent('Key packets of segments starting with a delta frame', async () => {
	const text = `#EXTM3U
#EXT-X-TARGETDURATION:100
#EXTINF:100,
a.ts
#EXTINF:100,
b.ts
#EXT-X-ENDLIST
`;

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			if (path === 'master.m3u8') {
				return new BufferSource(new TextEncoder().encode(text));
			}

			return new FilePathSource('./test/public/no-initial-keyframe.ts');
		}),
		formats: HLS_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);

	const types: string[] = [];
	let packet = await sink.getFirstKeyPacket({ verifyKeyPackets: true });
	while (packet) {
		types.push(packet.type);
		packet = await sink.getNextKeyPacket(packet, { verifyKeyPackets: true });
	}

	expect(types.length).toBeGreaterThan(0);
	expect(types.every(type => type === 'key')).toBe(true);
});

test.concurrent('Packets can be looked up by their own timestamp when the media offset is a fraction of a tick', async () => {
	// The segment's media gets placed at the program date time, which isn't a whole number of 1/44100 s ticks
	const text = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.123Z
#EXTINF:10,
sample3.aac
#EXT-X-ENDLIST
`;

	using input = new Input({
		source: new CustomPathedSource('playlist.m3u8', ({ path }) => {
			if (path === 'playlist.m3u8') {
				return new BufferSource(new TextEncoder().encode(text));
			}

			return new FilePathSource('./test/public/sample3.aac');
		}),
		formats: HLS_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new EncodedPacketSink(audioTrack);
	let packet = await sink.getFirstPacket();
	for (let i = 0; i < 20; i++) {
		assert(packet);
		expect((await sink.getPacket(packet.timestamp))?.timestamp).toBe(packet.timestamp);
		expect((await sink.getKeyPacket(packet.timestamp))?.timestamp).toBe(packet.timestamp);

		packet = await sink.getNextPacket(packet);
	}
});

test.concurrent('Packet lookups don\'t return a packet that starts after the timestamp on Unix-epoch timelines', async () => {
	// sample3.aac (44.1 kHz) at a program date time near 1970 and in 2026. A timestamp 3 µs (0.13 ticks) before a
	// packet is a real offset, not floating-point noise, even though the 2026 timeline's timestamps are ~1.8e9.
	const check = async (dateTime: string) => {
		const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n'
			+ `#EXT-X-PROGRAM-DATE-TIME:${dateTime}\n#EXTINF:10,\nsample3.aac\n#EXT-X-ENDLIST\n`;
		using input = new Input({
			source: new CustomPathedSource('playlist.m3u8', ({ path }) => path === 'playlist.m3u8'
				? new BufferSource(new TextEncoder().encode(playlist))
				: new FilePathSource('./test/public/sample3.aac')),
			formats: HLS_FORMATS,
		});
		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);

		const sink = new EncodedPacketSink(audioTrack);
		let packet = await sink.getFirstPacket();
		for (let i = 0; i < 20; i++) {
			assert(packet);
			const previousPacket = packet;
			packet = await sink.getNextPacket(packet);
			assert(packet);
			expect((await sink.getPacket(packet.timestamp - 3e-6))?.timestamp).toBe(previousPacket.timestamp);
		}
	};

	await check('1970-01-01T00:00:00.000Z');
	await check('2026-01-01T00:00:00.000Z');
});

test.concurrent('Packets at segment boundaries can be looked up by their own timestamp', async () => {
	// HLS written by Mediabunny. The first segment's audio runs past its video, so every later video segment starts
	// slightly before its playlist timestamp.
	const files = new Map<string, Uint8Array>();
	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat() }),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	using sourceInput = new Input({ source: new FilePathSource('./test/public/edts.mp4'), formats: ALL_FORMATS });
	const sourceVideoTrack = await sourceInput.getPrimaryVideoTrack();
	const sourceAudioTrack = await sourceInput.getPrimaryAudioTrack();
	assert(sourceVideoTrack && sourceAudioTrack);
	const videoConfig = { decoderConfig: (await sourceVideoTrack.getDecoderConfig())! };
	const audioConfig = { decoderConfig: (await sourceAudioTrack.getDecoderConfig())! };

	const videoSource = new EncodedVideoPacketSource('avc');
	const audioSource = new EncodedAudioPacketSource('aac');
	output.addVideoTrack(videoSource);
	output.addAudioTrack(audioSource);
	await output.start();

	// Interleave the packets by timestamp
	const videoPackets = new EncodedPacketSink(sourceVideoTrack).packets();
	const audioPackets = new EncodedPacketSink(sourceAudioTrack).packets();
	let video = await videoPackets.next();
	let audio = await audioPackets.next();
	while (!video.done || !audio.done) {
		if (!video.done && (audio.done || video.value.timestamp <= audio.value.timestamp)) {
			await videoSource.add(video.value, videoConfig);
			video = await videoPackets.next();
		} else if (!audio.done) {
			await audioSource.add(audio.value, audioConfig);
			audio = await audioPackets.next();
		}
	}
	await output.finalize();

	using input = new Input({
		source: new CustomPathedSource('playlist-1.m3u8', ({ path }) => new BufferSource(files.get(path)!)),
		formats: HLS_FORMATS,
	});
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
		expect((await sink.getPacket(packet.timestamp))?.timestamp).toBe(packet.timestamp);
		if (packet.type === 'key') {
			expect((await sink.getKeyPacket(packet.timestamp))?.timestamp).toBe(packet.timestamp);
		}
	}
});

test.concurrent('Packet lookups at segment boundaries settle when the media offset is large', async () => {
	// After 2^33 / 90 kHz = 95443.7 s, MPEG-TS timestamps wrap, so these segments get a media offset of about 95433 s.
	// Before the fix, getPacket(95440) bounced between two segments forever. Every step resolved from cache, so the
	// event loop never got another turn and not even the test timeout could fire. Counting the segments the lookups
	// visit turns that into a quick failure.
	using sourceInput = new Input({ source: new FilePathSource('./test/public/edts.mp4'), formats: ALL_FORMATS });
	const sourceTrack = await sourceInput.getPrimaryVideoTrack();
	assert(sourceTrack);
	const decoderConfig = (await sourceTrack.getDecoderConfig())!;
	const keyPacket = (await new EncodedPacketSink(sourceTrack).getFirstPacket())!;

	const files = new Map<string, Uint8Array>();
	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat(), targetDuration: 1 }),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();

	const timestamps = [0, 95440, 95441, 95442];
	for (const timestamp of timestamps) {
		await videoSource.add(new EncodedPacket(keyPacket.data, 'key', timestamp, 1), { decoderConfig });
	}
	await output.finalize();

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(files.get(path)!)),
		formats: HLS_FORMATS,
	});
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const maxSegmentVisits = 1000; // A settling lookup visits a handful
	let segmentVisits = 0;
	// eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the right `this` below
	const getInputForSegment = HlsSegmentedInput.prototype.getInputForSegment;
	const spy = vi.spyOn(HlsSegmentedInput.prototype, 'getInputForSegment').mockImplementation(function (
		this: HlsSegmentedInput,
		...args: Parameters<HlsSegmentedInput['getInputForSegment']>
	) {
		if (this.input === input && ++segmentVisits > maxSegmentVisits) {
			throw new Error(`Packet lookups visited segments more than ${maxSegmentVisits} times without settling.`);
		}

		return getInputForSegment.apply(this, args);
	});

	try {
		const sink = new EncodedPacketSink(videoTrack);
		for (const timestamp of timestamps) {
			expect((await sink.getPacket(timestamp))?.timestamp).toBe(timestamp);
		}
	} finally {
		spy.mockRestore();
	}
});

/** Writes HLS from synthetic packets (with real H.264/AAC payloads) into memory. */
const writeHlsFromPackets = async (
	segmentFormat: MpegTsOutputFormat | CmafOutputFormat,
	video: { timestamp: number; duration: number; type: 'key' | 'delta' }[],
	audio: { timestamp: number; duration: number }[],
	editPlaylist = (text: string) => text,
) => {
	using sourceInput = new Input({ source: new FilePathSource('./test/public/edts.mp4'), formats: ALL_FORMATS });
	const sourceVideoTrack = await sourceInput.getPrimaryVideoTrack();
	const sourceAudioTrack = await sourceInput.getPrimaryAudioTrack();
	assert(sourceVideoTrack && sourceAudioTrack);
	const videoConfig = { decoderConfig: (await sourceVideoTrack.getDecoderConfig())! };
	const audioConfig = { decoderConfig: (await sourceAudioTrack.getDecoderConfig())! };
	const videoSink = new EncodedPacketSink(sourceVideoTrack);
	const keyData = (await videoSink.getFirstKeyPacket())!.data;
	const deltaData = (await videoSink.getNextPacket((await videoSink.getFirstKeyPacket())!))!.data;
	const audioData = (await new EncodedPacketSink(sourceAudioTrack).getFirstPacket())!.data;

	const files = new Map<string, Uint8Array>();
	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat, targetDuration: 1 }),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	const audioSource = audio.length > 0 ? new EncodedAudioPacketSource('aac') : null;
	if (audioSource) {
		output.addAudioTrack(audioSource);
	}
	await output.start();

	let videoIndex = 0;
	let audioIndex = 0;
	while (videoIndex < video.length || audioIndex < audio.length) {
		const nextVideo = video[videoIndex];
		const nextAudio = audio[audioIndex];
		if (nextVideo && (!nextAudio || nextVideo.timestamp <= nextAudio.timestamp)) {
			const data = nextVideo.type === 'key' ? keyData : deltaData;
			await videoSource.add(
				new EncodedPacket(data, nextVideo.type, nextVideo.timestamp, nextVideo.duration),
				videoConfig,
			);
			videoIndex++;
		} else {
			await audioSource!.add(new EncodedPacket(audioData, 'key', nextAudio!.timestamp, nextAudio!.duration), audioConfig);
			audioIndex++;
		}
	}
	await output.finalize();

	return new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(path.endsWith('.m3u8')
			? new TextEncoder().encode(editPlaylist(new TextDecoder().decode(files.get(path))))
			: files.get(path)!,
		)),
		formats: HLS_FORMATS,
	});
};

test.concurrent('Packets can be looked up by their own timestamp when their track is missing from the segment the playlist points to', async () => {
	// The audio starts with the second segment, at 1.0000037 s, which is also where that segment starts in the
	// playlist. The 90 kHz clock of MPEG-TS stores it at 1 s though, inside the first segment's time range, but the
	// first segment has no audio at all.
	using input = await writeHlsFromPackets(
		new MpegTsOutputFormat(),
		[0, 1.0000037, 2.0000037].map(timestamp => ({ timestamp, duration: 1, type: 'key' as const })),
		Array.from({ length: 40 }, (_, i) => ({ timestamp: 1.0000037 + i * 1024 / 44100, duration: 1024 / 44100 })),
	);
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new EncodedPacketSink(audioTrack);
	const firstPacket = await sink.getFirstPacket();
	expect(firstPacket?.timestamp).toBe(1);

	for (let packet = firstPacket; packet; packet = await sink.getNextPacket(packet)) {
		expect((await sink.getPacket(packet.timestamp))?.timestamp).toBe(packet.timestamp);
		expect((await sink.getKeyPacket(packet.timestamp))?.timestamp).toBe(packet.timestamp);
	}
});

test.concurrent('Packets before the first segment\'s playlist timestamp can be looked up', async () => {
	// Like AAC priming in FFmpeg-made HLS: the audio starts 21 ms before the video, so before the first segment's
	// playlist timestamp. Looked up on fresh inputs, video first and audio first, since a lookup used to work only
	// once another one had learned the segments' timestamp offset.
	const check = async (segmentFormat: MpegTsOutputFormat | CmafOutputFormat, audioFirst: boolean) => {
		using input = await writeHlsFromPackets(
			segmentFormat,
			Array.from({ length: 60 }, (_, i) => ({
				timestamp: i / 30,
				duration: 1 / 30,
				type: i % 30 === 0 ? 'key' as const : 'delta' as const,
			})),
			Array.from({ length: 90 }, (_, i) => ({ timestamp: -0.021 + i * 1024 / 48000, duration: 1024 / 48000 })),
		);

		const tracks = await input.getTracks();
		const orderedTracks = audioFirst ? [...tracks].reverse() : tracks;
		expect(orderedTracks[0]!.type).toBe(audioFirst ? 'audio' : 'video');

		for (const track of orderedTracks) {
			const sink = new EncodedPacketSink(track);
			const firstPacket = await sink.getFirstPacket();
			assert(firstPacket);
			const firstTimestamp = await track.getFirstTimestamp();
			expect(firstTimestamp).toBe(firstPacket.timestamp);
			expect((await sink.getPacket(firstTimestamp))?.timestamp).toBe(firstTimestamp);
			expect((await sink.getKeyPacket(firstTimestamp))?.timestamp).toBe(firstTimestamp);
		}
	};

	for (const audioFirst of [false, true]) {
		await check(new MpegTsOutputFormat(), audioFirst);
		await check(new CmafOutputFormat(), audioFirst);
	}
});

test.concurrent('Packets at the start can be looked up after a lookup in a later segment', async () => {
	// FFmpeg rounds EXTINF to microseconds (1.001000 for its 29.97 fps segments), so the playlist drifts from the
	// media. Learned from a later segment, the offset between the two put the first packet before the first segment's
	// playlist timestamp. Here, every EXTINF is a microsecond short.
	const frameDuration = 1001 / 30000;
	using input = await writeHlsFromPackets(
		new MpegTsOutputFormat(),
		Array.from({ length: 120 }, (_, i) => ({
			timestamp: i * frameDuration,
			duration: frameDuration,
			type: i % 30 === 0 ? 'key' as const : 'delta' as const,
		})),
		[],
		text => text.replace(/#EXTINF:([\d.]+)/g, (_, duration: string) => {
			return `#EXTINF:${(Number(duration) - 0.000001).toFixed(6)}`;
		}),
	);
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	expect((await sink.getPacket(3.5))?.timestamp).toBeCloseTo(104 * frameDuration); // In the fourth segment
	expect((await sink.getPacket(0))?.timestamp).toBe(0);
	expect((await sink.getKeyPacket(0))?.timestamp).toBe(0);
});

test.concurrent('Leading frames of an open GOP can be looked up by their own timestamp', async () => {
	// 24 fps in decode order K0 P2 B1 P4 B3 … P22 B21 K24 B23 P26 B25 …: each segment starts with a key frame that is
	// followed by a frame shown before it, which therefore lies in the previous segment's time range
	const fps = 24;
	const video: { timestamp: number; duration: number; type: 'key' | 'delta' }[] = [];
	for (let start = 0; start < 72; start += 24) {
		video.push({ timestamp: start / fps, duration: 1 / fps, type: 'key' });
		if (start > 0) {
			video.push({ timestamp: (start - 1) / fps, duration: 1 / fps, type: 'delta' });
		}
		for (let frame = start + 2; frame < start + 24; frame += 2) {
			video.push({ timestamp: frame / fps, duration: 1 / fps, type: 'delta' });
			video.push({ timestamp: (frame - 1) / fps, duration: 1 / fps, type: 'delta' });
		}
	}
	video.push({ timestamp: 71 / fps, duration: 1 / fps, type: 'delta' });

	using input = await writeHlsFromPackets(new CmafOutputFormat(), video, []);
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	let count = 0;
	for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
		expect((await sink.getPacket(packet.timestamp))?.timestamp).toBe(packet.timestamp);
		count++;
	}
	expect(count).toBe(72);
	expect((await sink.getPacket(23 / fps))?.timestamp).toBe(23 / fps);
});

test.concurrent('Packets at segment boundaries can be looked up when the segments overlap by a tick of rounding', async () => {
	// 29.97 fps with a key frame every 30 frames: CMAF stores the second segment's last frame up to tick 691316 of
	// 57600 Hz, but the third segment's key frame at tick 691315, since each segment's media is rounded on its own
	const frameDuration = 1001 / 30000;
	using input = await writeHlsFromPackets(
		new CmafOutputFormat(),
		Array.from({ length: 120 }, (_, i) => ({
			timestamp: i * frameDuration,
			duration: frameDuration,
			type: i % 30 === 0 ? 'key' as const : 'delta' as const,
		})),
		[],
	);
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
		expect((await sink.getPacket(packet.timestamp))?.timestamp).toBe(packet.timestamp);
		if (packet.type === 'key') {
			expect((await sink.getKeyPacket(packet.timestamp))?.timestamp).toBe(packet.timestamp);
		}
	}
});

test.concurrent('Packets at segment boundaries can be looked up when the last packet before them claims a longer duration', async () => {
	// The last frame of each GOP claims 0.6 s although the next key frame follows 0.25 s later, as with nominal
	// durations in variable frame rate media. The key frames sit a little after whole seconds, so the playlist starts
	// their segments a few microseconds after where the 57600 Hz timescale of CMAF stores them.
	const video: { timestamp: number; duration: number; type: 'key' | 'delta' }[] = [];
	for (let gop = 0; gop < 3; gop++) {
		const start = gop === 0 ? 0 : gop + 0.0000037;
		video.push({ timestamp: start, duration: 0.25, type: 'key' });
		video.push({ timestamp: start + 0.25, duration: 0.25, type: 'delta' });
		video.push({ timestamp: start + 0.5, duration: 0.25, type: 'delta' });
		video.push({ timestamp: start + 0.75, duration: 0.6, type: 'delta' });
	}

	using input = await writeHlsFromPackets(new CmafOutputFormat(), video, []);
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	let count = 0;
	for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
		expect((await sink.getPacket(packet.timestamp))?.timestamp).toBe(packet.timestamp);
		if (packet.type === 'key') {
			expect((await sink.getKeyPacket(packet.timestamp))?.timestamp).toBe(packet.timestamp);
		}
		count++;
	}
	expect(count).toBe(12);
});

test.concurrent('Leading frames of an open GOP can be looked up when the previous segment\'s last frame covers them', async () => {
	// 24 fps. Each segment after the first starts with a key frame followed (in decode order) by a leading frame shown
	// 1/24 s before it, and the previous segment's last frame claims 0.2 s, covering that leading frame's timestamp.
	const fps = 24;
	const video: { timestamp: number; duration: number; type: 'key' | 'delta' }[] = [];
	for (let start = 0; start < 72; start += 24) {
		video.push({ timestamp: start / fps, duration: 1 / fps, type: 'key' });
		if (start > 0) {
			video.push({ timestamp: (start - 1) / fps, duration: 1 / fps, type: 'delta' });
		}
		for (let frame = start + 1; frame < start + 23; frame++) {
			video.push({ timestamp: frame / fps, duration: frame === start + 22 ? 0.2 : 1 / fps, type: 'delta' });
		}
	}

	using input = await writeHlsFromPackets(new CmafOutputFormat(), video, []);
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	let count = 0;
	for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
		expect((await sink.getPacket(packet.timestamp))?.timestamp).toBe(packet.timestamp);
		count++;
	}
	expect(count).toBe(video.length);
	expect((await sink.getPacket(23 / fps))?.timestamp).toBe(23 / fps);
});

test.concurrent('Packet lookups treat timestamps within floating-point noise of a packet\'s timestamp as that timestamp', async () => {
	// Like the demuxers of the segments themselves, which snap timestamps that are almost a whole tick to that tick.
	// Timestamps computed along different paths can differ in their last bit.
	const nextFloat = (x: number, direction: 1 | -1) => {
		const view = new DataView(new ArrayBuffer(8));
		view.setFloat64(0, x);
		view.setBigInt64(0, view.getBigInt64(0) + BigInt(direction)); // For x > 0
		return view.getFloat64(0);
	};

	const frameDuration = 1001 / 30000;
	const video = Array.from({ length: 90 }, (_, i) => ({
		timestamp: i * frameDuration,
		duration: frameDuration,
		type: i % 30 === 0 ? 'key' as const : 'delta' as const,
	}));

	for (const segmentFormat of [new MpegTsOutputFormat(), new CmafOutputFormat()]) {
		using input = await writeHlsFromPackets(segmentFormat, video, []);
		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		const sink = new EncodedPacketSink(videoTrack);
		for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
			if (packet.timestamp <= 0) {
				continue;
			}

			for (const direction of [-1, 1] as const) {
				const timestamp = nextFloat(packet.timestamp, direction);
				expect((await sink.getPacket(timestamp))?.timestamp).toBe(packet.timestamp);
				if (packet.type === 'key') {
					expect((await sink.getKeyPacket(timestamp))?.timestamp).toBe(packet.timestamp);
				}
			}
		}
	}
});

test.concurrent('Long reads release the sources of segments that dropped out of the input cache', async () => {
	let playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n';
	for (let i = 0; i < 30; i++) {
		playlist += `${i > 0 ? '#EXT-X-DISCONTINUITY\n' : ''}#EXTINF:4.944,\nsegment-${i}.ts\n`;
	}
	playlist += '#EXT-X-ENDLIST\n';

	// Stands in for a FilePathSource holding a file handle until it's disposed
	const segmentData = new Uint8Array(await fs.promises.readFile('./test/public/mp3.ts'));
	let openSegmentSources = 0;
	let maxOpenSegmentSources = 0;
	class TrackedSource extends BufferSource {
		constructor() {
			super(segmentData);
			openSegmentSources++;
			maxOpenSegmentSources = Math.max(maxOpenSegmentSources, openSegmentSources);
		}

		override _dispose() {
			openSegmentSources--;
		}
	}

	using input = new Input({
		source: new CustomPathedSource('playlist.m3u8', ({ path }) => path === 'playlist.m3u8'
			? new BufferSource(new TextEncoder().encode(playlist))
			: new TrackedSource()),
		formats: HLS_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);
	const secondPacket = await sink.getNextPacket(firstPacket);
	assert(secondPacket);
	for (let packet: EncodedPacket | null = secondPacket; packet; packet = await sink.getNextPacket(packet)) {
		// Read everything
	}

	// Instead of one source per segment read, only those of the cached segment inputs are open
	expect(maxOpenSegmentSources).toBeLessThan(10);

	// The first segment's input still works: it requests its source again
	expect((await sink.getNextPacket(firstPacket))?.timestamp).toBe(secondPacket.timestamp);
});

test('Keys of unsupported KEYFORMATs are ignored when a supported key applies to the segment', async () => {
	// RFC 8216, Section 6.3.6: "A client MUST ignore any EXT-X-KEY tag with an unsupported or unrecognized KEYFORMAT
	// attribute, to allow for cross-device addressability." Keys of several formats may apply to the same segments
	// (Section 4.3.2.4), and only if none of them is supported should playback fail.
	const key = new Uint8Array(16).fill(7);
	const cipher = createCipheriv('aes-128-cbc', key, new Uint8Array(16)); // The IV is the media sequence number, 0
	const segment = new Uint8Array(Buffer.concat([cipher.update(readFileSync('./test/public/0.ts')), cipher.final()]));

	const identityKey = '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"';
	const otherKeys = [
		'#EXT-X-KEY:METHOD=AES-128,URI="https://drm.example/key",KEYFORMAT="com.example.drm"',
		'#EXT-X-KEY:METHOD=AES-256,URI="https://drm.example/key",KEYFORMAT="com.example.future"',
	];

	const open = (keys: string[]) => {
		const playlist = ['#EXTM3U', '#EXT-X-VERSION:5', '#EXT-X-TARGETDURATION:5', ...keys, '#EXTINF:4.988,', 'segment.ts',
			'#EXT-X-ENDLIST'].join('\n');
		const files: Record<string, Uint8Array> = {
			'playlist.m3u8': new TextEncoder().encode(playlist),
			'key.bin': key,
			'segment.ts': segment,
		};

		return new Input({
			source: new CustomPathedSource('playlist.m3u8', ({ path }) => new BufferSource(files[path]!)),
			formats: ALL_FORMATS,
		});
	};

	const readFirstVideoPacket = async (keys: string[]) => {
		using input = open(keys);
		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		return await new EncodedPacketSink(videoTrack).getFirstPacket();
	};

	const readTracks = async (keys: string[]) => {
		using input = open(keys);
		return await input.getTracks();
	};

	for (const otherKey of otherKeys) {
		expect((await readFirstVideoPacket([identityKey, otherKey]))?.type).toBe('key');
		expect((await readFirstVideoPacket([otherKey, identityKey]))?.type).toBe('key');
		await expect(readTracks([otherKey])).rejects.toThrow(/KEYFORMAT|Unsupported encryption method/);
	}
});

test.concurrent('Tracks sharing a media playlist agree on the live status while it loads', async () => {
	const multivariantPlaylist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2"
media.m3u8
`;
	const vodPlaylist = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2,
0.ts
#EXT-X-ENDLIST
`;
	const livePlaylist = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2,
0.ts
`;

	const createInput = (mediaPlaylist: string) => new Input({
		source: new CustomPathedSource('master.m3u8', async ({ path }) => {
			if (path === 'master.m3u8') {
				return new BufferSource(new TextEncoder().encode(multivariantPlaylist));
			}

			// The media playlist takes a moment to arrive, like over the network
			await new Promise(resolve => setTimeout(resolve, 20));
			return new BufferSource(new TextEncoder().encode(mediaPlaylist));
		}),
		formats: ALL_FORMATS,
	});

	using vodInput = createInput(vodPlaylist);
	const vodTracks = await vodInput.getTracks();
	expect(vodTracks.map(x => x.type)).toEqual(['video', 'audio']);
	expect(await Promise.all(vodTracks.map(x => x.isLive()))).toEqual([false, false]);

	using liveInput = createInput(livePlaylist);
	const liveTracks = await liveInput.getTracks();
	expect(await Promise.all(liveTracks.map(x => x.getLiveRefreshInterval()))).toEqual([2, 2]);
});

test.concurrent('fMP4 I-frame playlists only hold their I-frames', async () => {
	// Fragmented MP4 with one fragment per GOP, like Apple's segmenter writes it for I-frame playlists
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0 }),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source, { frameRate: 30 });
	await output.start();
	for (let i = 0; i < 90; i++) {
		const isKey = i % 30 === 0;
		await source.add(
			new EncodedPacket(new Uint8Array(isKey ? 1000 : 100), isKey ? 'key' : 'delta', i / 30, 1 / 30),
			{ decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } },
		);
	}
	await output.finalize();

	const file = new Uint8Array(output.target.buffer!);
	const view = new DataView(file.buffer);
	let initSize = 0;
	const fragments: { offset: number; moofSize: number; size: number }[] = [];
	for (let offset = 0; offset < file.length; offset += view.getUint32(offset)) {
		const type = new TextDecoder().decode(file.subarray(offset + 4, offset + 8));
		if (type === 'moov') {
			initSize = offset + view.getUint32(offset);
		} else if (type === 'moof') {
			const moofSize = view.getUint32(offset);
			fragments.push({ offset, moofSize, size: moofSize + view.getUint32(offset + moofSize) });
		}
	}
	expect(fragments).toHaveLength(3);

	// An I-frame segment spans its fragment's moof and the I-frame's data, but not the rest of the mdat
	const createPlaylist = (iFramesOnly: boolean) => [
		'#EXTM3U',
		'#EXT-X-TARGETDURATION:1',
		'#EXT-X-VERSION:7',
		'#EXT-X-PLAYLIST-TYPE:VOD',
		...(iFramesOnly ? ['#EXT-X-I-FRAMES-ONLY'] : []),
		`#EXT-X-MAP:URI="main.mp4",BYTERANGE="${initSize}@0"`,
		...fragments.flatMap(fragment => [
			'#EXTINF:1,',
			`#EXT-X-BYTERANGE:${iFramesOnly ? fragment.moofSize + 8 + 1000 : fragment.size}@${fragment.offset}`,
			'main.mp4',
		]),
		'#EXT-X-ENDLIST',
	].join('\n');
	const files: Record<string, Uint8Array> = {
		'master.m3u8': new TextEncoder().encode(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="vp09.00.10.08"
main.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=30000,CODECS="vp09.00.10.08",URI="iframes.m3u8"
`),
		'main.m3u8': new TextEncoder().encode(createPlaylist(false)),
		'iframes.m3u8': new TextEncoder().encode(createPlaylist(true)),
		'main.mp4': file,
	};

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(files[path]!)),
		formats: ALL_FORMATS,
	});

	const iFrameTrack = (await input.getVideoTracks())[1];
	assert(iFrameTrack);
	expect(await iFrameTrack.hasOnlyKeyPackets()).toBe(true);

	const sink = new EncodedPacketSink(iFrameTrack);
	const packets: number[] = [];
	for await (const packet of sink.packets()) {
		packets.push(packet.timestamp);
	}
	expect(packets).toEqual([0, 1, 2]);

	for (const timestamp of [0.5, 1.5, 2.9]) {
		const packet = await sink.getPacket(timestamp);
		expect(packet?.timestamp).toBe(Math.floor(timestamp));
		expect(packet?.type).toBe('key');
		expect((await sink.getPacket(timestamp, { metadataOnly: true }))?.timestamp).toBe(Math.floor(timestamp));
	}

	const metadataPackets: number[] = [];
	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		metadataPackets.push(packet.timestamp);
	}
	expect(metadataPackets).toEqual([0, 1, 2]);
});

test.concurrent('AES-128 I-frame playlists point into resources encrypted as a whole', async () => {
	// Fragmented MP4 with one fragment per GOP; each I-frame's bytes are filled with its index
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0 }),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source, { frameRate: 30 });
	await output.start();
	for (let i = 0; i < 90; i++) {
		const isKey = i % 30 === 0;
		await source.add(
			new EncodedPacket(new Uint8Array(isKey ? 1000 : 100).fill(i / 30 + 1), isKey ? 'key' : 'delta', i / 30, 1 / 30),
			{ decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } },
		);
	}
	await output.finalize();

	const file = new Uint8Array(output.target.buffer!);
	const view = new DataView(file.buffer);
	let initSize = 0;
	const fragments: { offset: number; moofSize: number; size: number }[] = [];
	for (let offset = 0; offset < file.length; offset += view.getUint32(offset)) {
		const type = new TextDecoder().decode(file.subarray(offset + 4, offset + 8));
		if (type === 'moov') {
			initSize = offset + view.getUint32(offset);
		} else if (type === 'moof') {
			const moofSize = view.getUint32(offset);
			fragments.push({ offset, moofSize, size: moofSize + view.getUint32(offset + moofSize) });
		}
	}
	expect(fragments).toHaveLength(3);
	expect(fragments.every(x => x.offset % 16 !== 0)).toBe(true);

	// With AES-128, an I-frame playlist's resource is encrypted as a whole (RFC 8216bis, 5.2), so its byte ranges
	// don't start on their own cipher blocks
	const key = new Uint8Array(16).map((_, i) => i * 7 + 1);
	const iv = new Uint8Array(16).map((_, i) => 255 - i);
	const algorithm = { name: 'AES-CBC', iv };
	const cryptoKey = await crypto.subtle.importKey('raw', key, algorithm, false, ['encrypt']);
	const encrypted = new Uint8Array(await crypto.subtle.encrypt(algorithm, cryptoKey, file));

	const createPlaylist = (iFramesOnly: boolean) => [
		'#EXTM3U',
		'#EXT-X-TARGETDURATION:1',
		'#EXT-X-VERSION:7',
		'#EXT-X-PLAYLIST-TYPE:VOD',
		...(iFramesOnly
			? ['#EXT-X-I-FRAMES-ONLY', `#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${[...iv].map(x => x.toString(16).padStart(2, '0')).join('')}`]
			: []),
		`#EXT-X-MAP:URI="${iFramesOnly ? 'encrypted.mp4' : 'clear.mp4'}",BYTERANGE="${initSize}@0"`,
		...fragments.flatMap(fragment => [
			'#EXTINF:1,',
			`#EXT-X-BYTERANGE:${iFramesOnly ? fragment.moofSize + 8 + 1000 : fragment.size}@${fragment.offset}`,
			iFramesOnly ? 'encrypted.mp4' : 'clear.mp4',
		]),
		'#EXT-X-ENDLIST',
	].join('\n');
	const files: Record<string, Uint8Array> = {
		'master.m3u8': new TextEncoder().encode(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="vp09.00.10.08"
main.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=30000,CODECS="vp09.00.10.08",URI="iframes.m3u8"
`),
		'main.m3u8': new TextEncoder().encode(createPlaylist(false)),
		'iframes.m3u8': new TextEncoder().encode(createPlaylist(true)),
		'clear.mp4': file,
		'encrypted.mp4': encrypted,
		'key.bin': key,
	};

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(files[path]!)),
		formats: ALL_FORMATS,
	});

	const iFrameTrack = (await input.getVideoTracks())[1];
	assert(iFrameTrack);
	expect(await iFrameTrack.hasOnlyKeyPackets()).toBe(true);

	const sink = new EncodedPacketSink(iFrameTrack);
	const packets: string[] = [];
	for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextKeyPacket(packet)) {
		packets.push(`${packet.timestamp} ${packet.type} ${packet.byteLength} ${new Set(packet.data).size === 1 ? packet.data[0] : 'garbage'}`);
	}
	expect(packets).toEqual(['0 key 1000 1', '1 key 1000 2', '2 key 1000 3']);
});

test.concurrent('AES-128 TS I-frame playlist relying on the implicit init section', async () => {
	// One TS resource encrypted as a whole, like Apple's and Bento4's packagers write it; the I-frame playlist points at
	// each key frame's PES, so the PAT and PMT come from the bytes before the first I-frame
	using sourceInput = new Input({ source: new FilePathSource('./test/public/edts.mp4'), formats: ALL_FORMATS });
	const sourceTrack = (await sourceInput.getPrimaryVideoTrack())!;
	const decoderConfig = (await sourceTrack.getDecoderConfig())!;
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();
	for await (const packet of new EncodedPacketSink(sourceTrack).packets()) {
		await videoSource.add(packet, { decoderConfig });
	}
	await output.finalize();
	const ts = new Uint8Array(output.target.buffer!);

	// The video PES starts (PID 0x100, payload_unit_start_indicator), key frames flagged by random_access_indicator
	const pesStarts: { offset: number; key: boolean }[] = [];
	for (let offset = 0; offset < ts.length; offset += 188) {
		const pid = ((ts[offset + 1]! & 0x1f) << 8) | ts[offset + 2]!;
		if (pid === 0x100 && (ts[offset + 1]! & 0x40)) {
			const hasAdaptationField = (ts[offset + 3]! & 0x20) !== 0;
			pesStarts.push({ offset, key: hasAdaptationField && ts[offset + 4]! > 0 && (ts[offset + 5]! & 0x40) !== 0 });
		}
	}
	const iFrameRanges = pesStarts.flatMap((pes, i) => (pes.key
		? [{ offset: pes.offset, length: (pesStarts[i + 1]?.offset ?? ts.length) - pes.offset }]
		: []));
	expect(iFrameRanges.length).toBe(5);
	expect(iFrameRanges[0]!.offset).toBeGreaterThan(0);

	const key = new Uint8Array(16).map((_, i) => i * 7 + 1);
	const iv = new Uint8Array(16).map((_, i) => 255 - i);
	const algorithm = { name: 'AES-CBC', iv };
	const cryptoKey = await crypto.subtle.importKey('raw', key, algorithm, false, ['encrypt']);
	const encrypted = new Uint8Array(await crypto.subtle.encrypt(algorithm, cryptoKey, ts));
	const keyTag = `#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${[...iv].map(x => x.toString(16).padStart(2, '0')).join('')}`;

	const files: Record<string, Uint8Array> = {
		'master.m3u8': new TextEncoder().encode(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="avc1.64001e"
main.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=30000,CODECS="avc1.64001e",URI="iframes.m3u8"
`),
		'main.m3u8': new TextEncoder().encode(['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXT-X-PLAYLIST-TYPE:VOD', keyTag, '#EXTINF:9,', 'main.ts', '#EXT-X-ENDLIST'].join('\n')),
		'iframes.m3u8': new TextEncoder().encode([
			'#EXTM3U',
			'#EXT-X-VERSION:4',
			'#EXT-X-TARGETDURATION:2',
			'#EXT-X-PLAYLIST-TYPE:VOD',
			'#EXT-X-I-FRAMES-ONLY',
			keyTag,
			...iFrameRanges.flatMap(range => ['#EXTINF:1.92,', `#EXT-X-BYTERANGE:${range.length}@${range.offset}`, 'main.ts']),
			'#EXT-X-ENDLIST',
		].join('\n')),
		'main.ts': encrypted,
		'key.bin': key,
	};

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(files[path]!)),
		formats: ALL_FORMATS,
	});
	const iFrameTrack = (await input.getVideoTracks())[1];
	assert(iFrameTrack);
	expect(await iFrameTrack.hasOnlyKeyPackets()).toBe(true);

	// The I-frames are the clear TS's key frames
	using clearInput = new Input({ source: new BufferSource(ts), formats: ALL_FORMATS });
	const expected: string[] = [];
	for await (const packet of new EncodedPacketSink((await clearInput.getPrimaryVideoTrack())!).packets()) {
		if (packet.type === 'key') {
			expected.push(`${packet.type} ${packet.byteLength} ${packet.data.slice(-8).join(',')}`);
		}
	}
	const iFrames: string[] = [];
	for await (const packet of new EncodedPacketSink(iFrameTrack).packets()) {
		iFrames.push(`${packet.type} ${packet.byteLength} ${packet.data.slice(-8).join(',')}`);
	}
	expect(iFrames).toEqual(expected);
	expect(iFrames).toHaveLength(5);
});

test.concurrent('A live reload onto a new init section uses it, also when EXT-X-MAP precedes EXT-X-MEDIA-SEQUENCE', { timeout: 30_000 }, async () => {
	// Real x264 output as fragmented MP4, one fragment per GOP (a key frame every 1.92 s)
	using sourceInput = new Input({ source: new FilePathSource('./test/public/edts.mp4'), formats: ALL_FORMATS });
	const sourceTrack = (await sourceInput.getPrimaryVideoTrack())!;
	const decoderConfig = (await sourceTrack.getDecoderConfig())!;
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0 }),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();
	for await (const packet of new EncodedPacketSink(sourceTrack).packets()) {
		await videoSource.add(packet, { decoderConfig });
	}
	await output.finalize();

	const file = new Uint8Array(output.target.buffer!);
	const view = new DataView(file.buffer);
	let init: Uint8Array | null = null;
	const fragments: Uint8Array[] = [];
	for (let offset = 0; offset < file.length;) {
		const size = view.getUint32(offset);
		const type = new TextDecoder().decode(file.subarray(offset + 4, offset + 8));
		if (type === 'moov') {
			init = file.subarray(0, offset + size);
		} else if (type === 'moof') {
			const mdatSize = view.getUint32(offset + size);
			fragments.push(file.subarray(offset, offset + size + mdatSize));
			offset += mdatSize;
		}
		offset += size;
	}
	assert(init);
	expect(fragments.length).toBeGreaterThanOrEqual(3);

	// After the reload, the encoder has restarted with a new init section, whose track has another ID: its segments
	// can only be read with it
	const withTrackId2 = (bytes: Uint8Array) => {
		const copy = bytes.slice();
		const copyView = new DataView(copy.buffer);
		for (let i = 4; i + 12 <= copy.length; i++) {
			const type = String.fromCharCode(copy[i]!, copy[i + 1]!, copy[i + 2]!, copy[i + 3]!);
			if (type === 'tkhd') {
				copyView.setUint32(i + (copy[i + 4] === 1 ? 24 : 16), 2);
			} else if (type === 'trex' || type === 'tfhd') {
				copyView.setUint32(i + 8, 2);
			}
		}
		return copy;
	};
	const files = new Map<string, Uint8Array>([['a/init.mp4', init], ['b/init.mp4', withTrackId2(init)]]);
	for (let i = 0; i < 3; i++) {
		files.set(`a/${i}.m4s`, fragments[i]!);
		files.set(`b/${i + 3}.m4s`, withTrackId2(fragments[i]!));
	}

	// EXT-X-MAP applies to every segment after it (RFC 8216, 4.3.2.5), and EXT-X-MEDIA-SEQUENCE only has to come
	// before the first segment; Mux's live playlists put the map first
	for (const mapFirst of [false, true]) {
		const createPlaylist = (window: 'a' | 'b') => {
			const map = `#EXT-X-MAP:URI="${window}/init.mp4"`;
			const sequence = `#EXT-X-MEDIA-SEQUENCE:${window === 'a' ? 0 : 3}`;
			return [
				'#EXTM3U',
				'#EXT-X-VERSION:7',
				'#EXT-X-TARGETDURATION:2',
				...(window === 'b' ? ['#EXT-X-DISCONTINUITY-SEQUENCE:1'] : []),
				...(mapFirst ? [map, sequence] : [sequence, map]),
				...[0, 1, 2].flatMap(i => ['#EXTINF:1.92,', `${window}/${window === 'a' ? i : i + 3}.m4s`]),
				...(window === 'b' ? ['#EXT-X-ENDLIST'] : []),
			].join('\n');
		};

		let playlistRequests = 0;
		using input = new Input({
			source: new CustomPathedSource('live.m3u8', ({ path }) => {
				if (path === 'live.m3u8') {
					return new BufferSource(new TextEncoder().encode(createPlaylist(playlistRequests++ === 0 ? 'a' : 'b')));
				}

				return new BufferSource(files.get(path)!);
			}),
			formats: ALL_FORMATS,
		});

		const videoTrack = (await input.getVideoTracks())[0];
		assert(videoTrack);
		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
			timestamps.push(packet.timestamp);
		}

		// The frames of both windows, the second one starting where the playlist places it
		expect(timestamps).toHaveLength(2 * 144);
		expect(Math.min(...timestamps.slice(144))).toBeCloseTo(5.76, 3);
		expect(playlistRequests).toBe(2);
	}
});

test.concurrent('A live rendition still listing a discontinuity the reference playlist has moved past is readable', async () => {
	// Two periods of real encoder output with unrelated timestamps (say, content and an ad break), segmented by the
	// HLS writer: video-only segments for the variant, audio-only ones for the audio rendition
	using sourceInput = new Input({ source: new FilePathSource('./test/public/edts.mp4'), formats: ALL_FORMATS });
	const sourceVideo = (await sourceInput.getPrimaryVideoTrack())!;
	const sourceAudio = (await sourceInput.getPrimaryAudioTrack())!;
	const writeSegments = async (type: 'video' | 'audio', mediaTimestampBase: number) => {
		const files = new Map<string, Uint8Array>();
		const output = new Output({
			format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat(), targetDuration: 1.92, mediaTimestampBase }),
			target: new PathedTarget('master.m3u8', ({ path }) => {
				const target = new BufferTarget();
				target.on('finalized', () => files.set(path, new Uint8Array(target.buffer!)));
				return target;
			}),
		});
		if (type === 'video') {
			const source = new EncodedVideoPacketSource('avc');
			output.addVideoTrack(source);
			await output.start();
			const decoderConfig = (await sourceVideo.getDecoderConfig())!;
			for await (const packet of new EncodedPacketSink(sourceVideo).packets()) {
				await source.add(packet, { decoderConfig });
			}
		} else {
			const source = new EncodedAudioPacketSource('aac');
			output.addAudioTrack(source);
			await output.start();
			const decoderConfig = (await sourceAudio.getDecoderConfig())!;
			for await (const packet of new EncodedPacketSink(sourceAudio).packets()) {
				await source.add(packet, { decoderConfig });
			}
		}
		await output.finalize();

		const playlist = new TextDecoder().decode(files.get('playlist-1.m3u8')).split('\n');
		return playlist.flatMap((line, i) => (line.startsWith('#EXTINF:')
			? [{ duration: Number(line.slice(8, line.indexOf(','))), bytes: files.get(playlist[i + 1]!)! }]
			: []));
	};
	const contentAudio = await writeSegments('audio', 100);
	const adVideo = await writeSegments('video', 5000);
	const adAudio = await writeSegments('audio', 5000);

	const files = new Map<string, Uint8Array>();
	const segmentLines = (prefix: string, segments: { duration: number; bytes: Uint8Array }[], first: number) =>
		segments.slice(0, 2).flatMap((segment, i) => {
			files.set(`${prefix}-${first + i}.ts`, segment.bytes);
			return [`#EXTINF:${segment.duration},`, `${prefix}-${first + i}.ts`];
		});
	const live = (sequence: number, discontinuitySequence: number, lines: string[]) => [
		'#EXTM3U',
		'#EXT-X-TARGETDURATION:2',
		`#EXT-X-MEDIA-SEQUENCE:${sequence}`,
		`#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuitySequence}`,
		...lines,
	].join('\n');
	const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="avc1.64001e,mp4a.40.2",AUDIO="a"\nvideo.m3u8\n';

	// The video window has moved past the discontinuity to the ad break, while the audio window (loaded a moment
	// earlier, or simply longer) still lists the two content segments before it. Both playlists' discontinuity 1
	// starts at the same instant (RFC 8216, 6.2.4).
	const videoPlaylist = live(2, 1, segmentLines('v', adVideo, 2));
	const audioPlaylist = live(0, 0, [...segmentLines('a', contentAudio, 0), '#EXT-X-DISCONTINUITY', ...segmentLines('a', adAudio, 2)]);
	// Control: the same streams with the audio window aligned to the video one
	const alignedAudioPlaylist = live(2, 1, segmentLines('a', adAudio, 2));

	const readAudio = async (audioM3u8: string) => {
		using input = new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => {
				const text = { 'master.m3u8': master, 'video.m3u8': videoPlaylist, 'audio.m3u8': audioM3u8 }[path];
				return new BufferSource(text !== undefined ? new TextEncoder().encode(text) : files.get(path)!);
			}),
			formats: ALL_FORMATS,
		});
		const audioTrack = (await input.getPrimaryAudioTrack())!;
		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(audioTrack).packets(undefined, undefined, { skipLiveWait: true })) {
			timestamps.push(packet.timestamp);
		}
		return timestamps;
	};

	const aligned = await readAudio(alignedAudioPlaylist);
	const timestamps = await readAudio(audioPlaylist);

	// The ad break's audio lands where it does with aligned windows, and the content's audio right before it
	const contentDuration = contentAudio[0]!.duration + contentAudio[1]!.duration;
	const adStart = timestamps.length - aligned.length;
	expect(timestamps.slice(adStart)).toEqual(aligned);
	expect(timestamps[0]).toBeCloseTo(aligned[0]! - contentDuration, 3);
	for (let i = 1; i < timestamps.length; i++) {
		expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]!);
	}
});

test.concurrent('A new EXT-X-MAP after a discontinuity sends its parameter sets in band', async () => {
	// test/public/hls-disc: 64x48, then a discontinuity to 96x96 with its own init section, from x264 (baseline, then
	// high) and from x265; disc-return.m3u8 then goes back to the first init section, like content after an ad break
	const readFile = async (name: string) => {
		const bytes = Buffer.concat([
			readFileSync(`./test/public/hls-disc/${name}_init.mp4`),
			readFileSync(`./test/public/hls-disc/${name}_0.m4s`),
		]);
		using file = new Input({ source: new BufferSource(new Uint8Array(bytes)), formats: ALL_FORMATS });
		const track = (await file.getPrimaryVideoTrack())!;
		const filePackets = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			filePackets.push(packet);
		}
		return { packets: filePackets, description: new Uint8Array((await track.getDecoderConfig())!.description as ArrayBuffer) };
	};
	const readPlaylist = async (playlist: string) => {
		using input = new Input({
			source: new CustomPathedSource('playlist.m3u8', ({ path }) => (path === 'playlist.m3u8'
				? new BufferSource(new TextEncoder().encode(playlist))
				: new FilePathSource(`./test/public/hls-disc/${path}`))),
			formats: ALL_FORMATS,
		});
		const videoTrack = (await input.getPrimaryVideoTrack())!;
		const packets = [];
		for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
			packets.push(packet);
		}
		const metadataSizes: number[] = [];
		for await (const packet of new EncodedPacketSink(videoTrack).packets(undefined, undefined, { metadataOnly: true })) {
			metadataSizes.push(packet.byteLength);
		}
		const description = new Uint8Array((await videoTrack.getDecoderConfig())!.description as ArrayBuffer);
		// The decoder config each packet needs when it's not the track's, as an ID per distinct config
		const configs: (VideoDecoderConfig | null)[] = [];
		const packetConfigs = packets.map((packet) => {
			const config = videoTrack._backing.getDecoderConfigForPacket!(packet) as VideoDecoderConfig | null;
			if (!configs.includes(config)) {
				configs.push(config);
			}
			return configs.indexOf(config);
		});
		return { packets, metadataSizes, description, codec: await videoTrack.getCodec(), configs, packetConfigs };
	};
	const playlistOf = (...names: string[]) => [
		'#EXTM3U',
		'#EXT-X-VERSION:7',
		'#EXT-X-TARGETDURATION:1',
		...names.flatMap((name, i) => [
			...(i > 0 ? ['#EXT-X-DISCONTINUITY'] : []),
			...(i === 0 || name !== names[i - 1] ? [`#EXT-X-MAP:URI="${name}_init.mp4"`] : []),
			'#EXTINF:1.0,',
			`${name}_0.m4s`,
		]),
		'#EXT-X-ENDLIST',
	].join('\n');

	for (const { first, second, codec } of [{ first: 'a', second: 'b', codec: 'avc' }, { first: 'ha', second: 'hb', codec: 'hevc' }] as const) {
		const a = await readFile(first);
		const b = await readFile(second);
		const getParameterSets = (description: Uint8Array) => {
			if (codec === 'avc') {
				const record = deserializeAvcDecoderConfigurationRecord(description)!;
				return concatNalUnitsInLengthPrefixed([...record.sequenceParameterSets, ...record.pictureParameterSets], 4);
			}

			return concatNalUnitsInLengthPrefixed(deserializeHevcDecoderConfigurationRecord(description)!.arrays
				.filter(x => [32, 33, 34].includes(x.nalUnitType)) // VPS, SPS, PPS
				.flatMap(x => x.nalUnits), 4);
		};
		expect(getParameterSets(b.description)).not.toEqual(getParameterSets(a.description));
		// Each segment's key packet starts with its own parameter sets (length-prefixed, from its avcC/hvcC)
		const withOwnParameterSets = (file: typeof a) => [
			new Uint8Array([...getParameterSets(file.description), ...file.packets[0]!.data]),
			...file.packets.slice(1).map(x => x.data),
		];

		// Content, ad break, content again with the first init section
		const result = await readPlaylist(playlistOf(first, second, first));
		expect(result.codec).toBe(codec);
		expect(result.description).toEqual(a.description); // The decoder config stays the first init section's
		expect(result.packets.map(x => x.data)).toEqual([...withOwnParameterSets(a), ...withOwnParameterSets(b), ...withOwnParameterSets(a)]);
		expect(result.packets[0]!.type).toBe('key');
		expect(result.metadataSizes).toEqual(result.packets.map(x => x.byteLength));
		expect(result.packets.every(x => x.byteLength === x.data.byteLength)).toBe(true);

		// The ad's packets also report their own decoder config, for decoders to be reconfigured with
		expect(result.packetConfigs).toEqual([
			...a.packets.map(() => 0),
			...b.packets.map(() => 1),
			...a.packets.map(() => 0),
		]);
		expect(result.configs[0]).toBe(null);
		expect(new Uint8Array(result.configs[1]!.description as ArrayBuffer)).toEqual(b.description);
		expect([result.configs[1]!.codedWidth, result.configs[1]!.codedHeight]).toEqual([96, 96]);

		// With a single init section, packets are left alone, discontinuities or not
		const single = await readPlaylist(playlistOf(first, first));
		expect(single.packets.map(x => x.data)).toEqual([...a.packets, ...a.packets].map(x => x.data));
		expect(single.metadataSizes).toEqual(single.packets.map(x => x.byteLength));
		expect(single.configs).toEqual([null]);
	}
});

test.concurrent('Audio packets after a discontinuity with a new EXT-X-MAP carry their own decoder config', async () => {
	// test/public/hls-disc-audio: AAC-LC 48 kHz stereo, a discontinuity to AAC-LC 22.05 kHz mono with its own init
	// section, then the first init section again
	using input = new Input({
		source: new CustomPathedSource('./test/public/hls-disc-audio/adisc.m3u8', ({ path }) => new FilePathSource(path)),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	const trackConfig = await audioTrack.getDecoderConfig();
	expect([trackConfig?.sampleRate, trackConfig?.numberOfChannels]).toEqual([48000, 2]);

	const formats: string[] = [];
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		const config = audioTrack._backing.getDecoderConfigForPacket!(packet) as AudioDecoderConfig | null;
		const format = config ? `${config.sampleRate}/${config.numberOfChannels}` : 'track';
		if (formats[formats.length - 1] !== format) {
			formats.push(format);
		}
	}
	// Only the ad break's packets need another decoder config than the track's
	expect(formats).toEqual(['track', '22050/1', 'track']);

	// Consecutive ad segments sharing an init section share the decoder config object
	using adInput = new Input({
		source: new CustomPathedSource('ad.m3u8', ({ path }) => (path === 'ad.m3u8'
			? new BufferSource(new TextEncoder().encode([
				'#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2',
				'#EXT-X-MAP:URI="c_init.mp4"', '#EXTINF:1.021333,', 'c_0.m4s',
				'#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="d_init.mp4"', '#EXTINF:1.04644,', 'd_0.m4s', '#EXTINF:1.04644,', 'd_0.m4s',
				'#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="c_init.mp4"', '#EXTINF:1.021333,', 'c_0.m4s',
				'#EXT-X-ENDLIST',
			].join('\n')))
			: new FilePathSource(`./test/public/hls-disc-audio/${path}`))),
		formats: ALL_FORMATS,
	});
	const adTrack = (await adInput.getPrimaryAudioTrack())!;
	const adConfigs = new Set<unknown>();
	for await (const packet of new EncodedPacketSink(adTrack).packets()) {
		adConfigs.add(adTrack._backing.getDecoderConfigForPacket!(packet));
	}
	expect(adConfigs.size).toBe(2); // null for the content, one object for both ad segments

	// Streams whose decoder config never changes are left alone
	using plainInput = new Input({
		source: new CustomPathedSource('./test/public/hls-disc-audio/adisc.m3u8', ({ path }) => new FilePathSource(path.replace('d_', 'c_'))),
		formats: ALL_FORMATS,
	});
	const plainTrack = (await plainInput.getPrimaryAudioTrack())!;
	for await (const packet of new EncodedPacketSink(plainTrack).packets()) {
		expect(plainTrack._backing.getDecoderConfigForPacket!(packet)).toBe(null);
	}
});

const fetchBytes = async (url: string) => {
	const response = await fetch(url);
	return new Uint8Array(await response.arrayBuffer());
};

const stripId3V2Tags = (bytes: Uint8Array) => {
	// Make sure there's actually something to strip, otherwise the test wouldn't test anything
	expect(new TextDecoder().decode(bytes.subarray(0, 3))).toBe('ID3');

	while (new TextDecoder().decode(bytes.subarray(0, 3)) === 'ID3') {
		const flags = bytes[5]!;
		const size = (bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!; // Synchsafe
		const hasFooter = !!(flags & 0x10);

		bytes = bytes.subarray(10 + size + (hasFooter ? 10 : 0));
	}

	return bytes;
};

test.concurrent('URI-less renditions read their own streams when the variant mixes audio codecs', async () => {
	// One MPEG-TS whose audio streams are described, in order, by URI-less renditions with CODECS="mp4a.40.2,ac-3".
	// Each rendition's codec must be read from, and its track bound to, the same stream. (Found by review lane L46 on
	// the merge of #389 and #392.)
	const readSource = async (path: string) => {
		using input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}
		return { codec: (await track.getCodec())!, packets, decoderConfig: (await track.getDecoderConfig())! };
	};

	const readRenditions = async (streams: { name: string; path: string; count?: number }[]) => {
		const target = new BufferTarget();
		const output = new Output({ format: new MpegTsOutputFormat(), target });
		const sourceStreams = await Promise.all(streams.map(x => readSource(x.path)));
		const packetSources = sourceStreams.map(x => new EncodedAudioPacketSource(x.codec));
		for (const packetSource of packetSources) {
			output.addAudioTrack(packetSource);
		}
		await output.start();
		for (const [i, { packets, decoderConfig }] of sourceStreams.entries()) {
			for (const packet of packets.slice(0, streams[i]!.count)) {
				await packetSources[i]!.add(packet, { decoderConfig });
			}
		}
		await output.finalize();
		const tsFile = new Uint8Array(target.buffer!);

		const master = '#EXTM3U\n'
			+ streams.map(x => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${x.name}",AUTOSELECT=YES\n`).join('')
			+ '#EXT-X-STREAM-INF:BANDWIDTH=512000,CODECS="mp4a.40.2,ac-3",AUDIO="audio"\nmuxed.m3u8\n';
		const mediaPlaylist = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:9.1,\nmuxed.ts\n#EXT-X-ENDLIST\n';
		using input = new Input({
			source: new CustomPathedSource('master.m3u8', ({ path }) => new BufferSource(
				path === 'muxed.ts' ? tsFile : new TextEncoder().encode(path === 'master.m3u8' ? master : mediaPlaylist),
			)),
			formats: HLS_FORMATS,
		});

		const result: string[] = [];
		for (const track of await input.getAudioTracks()) {
			const sink = new EncodedPacketSink(track);
			let count = 0;
			for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
				count++;
			}
			result.push(`${await track.getName()} ${await track.getCodec()} ${count}`);
		}
		return result;
	};

	const surround = { name: 'Surround', path: './test/public/ac3.ts' }; // 63 AC-3 packets
	const english = { name: 'English', path: './test/public/edts.mp4' }; // 390 AAC packets
	const french = { name: 'French', path: './test/public/edts.mp4', count: 200 };

	expect(await readRenditions([english, french, surround]))
		.toEqual(['English aac 390', 'French aac 200', 'Surround ac3 63']);
	expect(await readRenditions([surround, english, french]))
		.toEqual(['Surround ac3 63', 'English aac 390', 'French aac 200']);
});
