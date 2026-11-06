import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input, UnsupportedInputFormatError } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource, CustomPathedSource } from '../../src/source.js';

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
