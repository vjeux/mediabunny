import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input, UnsupportedInputFormatError } from '../../src/input.js';
import { ALL_FORMATS, MP3, MPEG_TS, ADTS, FLAC, OGG, WAVE } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { BufferSource, CustomPathedSource } from '../../src/source.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const readPublic = (name: string) => readFileSync(path.join(__dirname, '../public', name));

test('Disposing after failed format detection does not emit an unhandled rejection', async () => {
	const input = new Input({
		source: new BufferSource(new Uint8Array([1, 2, 3, 4])),
		formats: ALL_FORMATS,
	});

	await expect(input.getFormat()).rejects.toThrow(UnsupportedInputFormatError);

	const unhandledRejections: unknown[] = [];
	const onUnhandledRejection = (reason: unknown) => {
		unhandledRejections.push(reason);
	};

	process.on('unhandledRejection', onUnhandledRejection);
	try {
		input.dispose();
		await new Promise(resolve => setTimeout(resolve, 0));
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	expect(unhandledRejections).toEqual([]);
});

test('MP3 frames after a run of zero bytes, like a zeroed-out ID3v2 tag, are recognized', async () => {
	// MPEG-1 Layer III, 128 kbit/s, 44.1 kHz frames of 417 bytes
	const frame = new Uint8Array(417);
	frame.set([0xff, 0xfb, 0x90, 0x00]);
	const frames = [frame, frame, frame];
	const id3v2Tag = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10, ...new Uint8Array(10)]);

	for (const prefix of [[id3v2Tag, new Uint8Array(8192)], [new Uint8Array(65536)]]) {
		const parts = [...prefix, ...frames];
		const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
		let offset = 0;
		for (const part of parts) {
			bytes.set(part, offset);
			offset += part.length;
		}

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		expect(await input.getFormat()).toBe(MP3);

		let packetCount = 0;
		for await (const packet of new EncodedPacketSink((await input.getPrimaryAudioTrack())!).packets()) {
			void packet;
			packetCount++;
		}
		expect(packetCount).toBe(3);
	}
});

test('Detects MP3 data that starts in the middle of a frame', async () => {
	// Cut out of a file, like a stream recorded from an arbitrary byte. The partial frame it starts with contains
	// bytes that look like frame headers.
	const file = new Uint8Array(readFileSync(path.join(__dirname, '../public/Toothsome-Meme.VBRv2.mp3')));
	const bytes = file.subarray(120497);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP3);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getSampleRate()).toBe(24000);

	// Like FFmpeg, start at the first whole frame, at byte 163
	const sink = new EncodedPacketSink(audioTrack);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);
	expect(firstPacket.data).toEqual(bytes.subarray(163, 163 + firstPacket.data.byteLength));

	let packetCount = 0;
	for await (const packet of sink.packets()) {
		expect(packet.timestamp).toBe(packetCount * 576 / 24000);
		packetCount++;
	}
	expect(packetCount).toBe(1158);
});

test('Detects MP3 data whose channel mode changes right after the first frame', async () => {
	// Silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz): one mono frame, then joint stereo. The channel mode may
	// change from frame to frame, so the first frame still counts as confirmed by the one after it.
	const modes = [3, 1, 1, 1];
	const bytes = new Uint8Array(modes.length * 417);
	modes.forEach((mode, i) => bytes.set([0xff, 0xfb, 0x90, mode << 6], i * 417));

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP3);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	const firstPacket = await new EncodedPacketSink(audioTrack).getFirstPacket();
	assert(firstPacket);
	expect(firstPacket.timestamp).toBe(0);
	expect(firstPacket.data).toEqual(bytes.subarray(0, 417));
});

test('Does not take the MP3 frames inside MPEG-TS for an MP3 file', async () => {
	// 8 kbps MP3 at 16 kHz in MPEG-TS, made with FFmpeg's libmp3lame and mpegts muxer. Its 36-byte frames come in runs
	// within a single TS packet, which is checked before MPEG-TS.
	using input = new Input({
		source: new BufferSource(new Uint8Array(readFileSync(path.join(__dirname, '../public/mp3-8kbps.ts')))),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MPEG_TS);
});

test('Input track-list methods reject values that are not InputTracks', async () => {
	using input = new Input({ source: new BufferSource(readPublic('video.mp4')), formats: ALL_FORMATS });
	const [videoTrack] = await input.getTracks();

	for (const tracks of ['video', [{}], [1]]) {
		for (const method of ['getFirstTimestamp', 'computeDuration', 'getDurationFromMetadata'] as const) {
			await expect(input[method](tracks as never)).rejects.toThrow(
				new TypeError('tracks, when provided, must be an array of InputTrack.'),
			);
		}
	}

	// Null entries, as returned by getPrimaryAudioTrack() on video-only files, stay allowed
	expect(await input.computeDuration([videoTrack!, null as never])).toBe(5);
});

test('Duration and packet stats options are validated like PacketRetrievalOptions', async () => {
	using input = new Input({ source: new BufferSource(readPublic('video.mp4')), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;

	await expect(track.computeDuration({ skipLiveWait: 'yes' } as never)).rejects.toThrow(
		new TypeError('options.skipLiveWait, when defined, must be a boolean.'),
	);
	await expect(input.computeDuration(undefined, null as never)).rejects.toThrow(
		new TypeError('options must be an object.'),
	);
	for (const targetPacketCount of [NaN, -1, null, '5']) {
		await expect(track.computePacketStats(targetPacketCount as never)).rejects.toThrow(
			new TypeError('targetPacketCount must be a non-negative number.'),
		);
	}

	// HLS tracks read options.skipLiveWait, so a null options object used to crash there
	const files: Record<string, Uint8Array> = {
		'media.m3u8': new TextEncoder().encode(
			'#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.aac\n#EXT-X-ENDLIST\n',
		),
		'segment.aac': readPublic('sample3.aac'),
	};
	using hlsInput = new Input({
		source: new CustomPathedSource('media.m3u8', ({ path }) => new BufferSource(files[path]!)),
		formats: ALL_FORMATS,
	});
	const hlsTrack = (await hlsInput.getPrimaryAudioTrack())!;
	await expect(hlsTrack.getDurationFromMetadata(null as never)).rejects.toThrow(
		new TypeError('options must be an object.'),
	);
	await expect(hlsInput.getDurationFromMetadata(undefined, { skipLiveWait: 1 } as never)).rejects.toThrow(
		new TypeError('options.skipLiveWait, when defined, must be a boolean.'),
	);
	expect(await hlsTrack.getDurationFromMetadata({ skipLiveWait: true })).toBe(10);
});

test('Pairable track getters validate their query like Input.getTracks', async () => {
	using input = new Input({ source: new BufferSource(readPublic('video.mp4')), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;

	const methods = [
		'getPairableTracks',
		'getPairableVideoTracks',
		'getPairableAudioTracks',
		'getPrimaryPairableVideoTrack',
		'getPrimaryPairableAudioTrack',
	] as const;
	for (const method of methods) {
		await expect(track[method]('audio' as never)).rejects.toThrow(new TypeError('query must be an object.'));
		await expect(track[method]({ filter: 'audio' } as never)).rejects.toThrow(
			new TypeError('query.filter, when provided, must be a function.'),
		);
		await expect(track[method]({ sortBy: 1 } as never)).rejects.toThrow(
			new TypeError('query.sortBy, when provided, must be a function.'),
		);
	}

	expect((await track.getPairableAudioTracks({ filter: t => t.number === 1 })).length).toBe(1);
});

test('MP3 detection does not claim files of other containers', async () => {
	// With a format list like an audio-only app would use, this QuickTime file used to be read as MP3, since its sample
	// tables happen to contain two consecutive "frame headers"
	const mov = new Uint8Array(readFileSync(path.join(__dirname, '../public/trunc-buck-bunny.mov')));
	using movInput = new Input({ source: new BufferSource(mov), formats: [MP3, WAVE, FLAC, OGG, ADTS] });
	await expect(movInput.getFormat()).rejects.toThrow(UnsupportedInputFormatError);

	// A WAVE file holding MPEG audio frames is still read as WAVE, as it would be with ALL_FORMATS
	const frames = new Uint8Array(3 * 417);
	for (let i = 0; i < 3; i++) {
		frames.set([0xff, 0xfb, 0x90, 0x00], i * 417);
	}
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const u32le = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
	const fmt = [1, 0, 2, 0, ...u32le(44100), ...u32le(44100 * 4), 4, 0, 16, 0]; // PCM, stereo, 16-bit
	const wav = new Uint8Array([
		...ascii('RIFF'), ...u32le(4 + 8 + fmt.length + 8 + frames.length), ...ascii('WAVE'),
		...ascii('fmt '), ...u32le(fmt.length), ...fmt,
		...ascii('data'), ...u32le(frames.length), ...frames,
	]);
	using wavInput = new Input({ source: new BufferSource(wav), formats: [MP3, WAVE] });
	expect(await wavInput.getFormat()).toBe(WAVE);

	// MPEG-TS whose first packet holds small MP3 frames (8 kbps at 16 kHz, 36 bytes each) back to back
	const ts = new Uint8Array(5 * 188);
	for (let i = 0; i < 5; i++) {
		ts.set([0x47, 0x01, 0x00, 0x10], i * 188);
	}
	for (let pos = 4; pos + 4 <= 188; pos += 36) {
		ts.set([0xff, 0xf3, 0x18, 0xc0], pos);
	}
	using tsInput = new Input({ source: new BufferSource(ts), formats: [MP3, WAVE, FLAC, OGG, ADTS] });
	await expect(tsInput.getFormat()).rejects.toThrow(UnsupportedInputFormatError);

	// But MP3 data that merely holds 0x47 at the starts of the first two 188-byte packets (cut out of a stream, say)
	// is still MP3, since MPEG-TS has a sync byte at the start of every packet
	const mp3 = new Uint8Array([0x47, ...frames]);
	mp3[188] = 0x47;
	using mp3Input = new Input({ source: new BufferSource(mp3), formats: [MP3] });
	expect(await mp3Input.getFormat()).toBe(MP3);
});
