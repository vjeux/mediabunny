import { expect, expectTypeOf, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input, UnsupportedInputFormatError } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { assert } from '../../src/misc.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

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

test('Input track types are their literal kind, so they narrow track unions', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});
	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack && audioTrack);

	// Like OutputVideoTrack and OutputAudioTrack (found by lane L71)
	expectTypeOf(videoTrack.type).toEqualTypeOf<'video'>();
	expectTypeOf(audioTrack.type).toEqualTypeOf<'audio'>();
	expect(videoTrack.type).toBe('video');
	expect(audioTrack.type).toBe('audio');

	const tracks: (InputVideoTrack | InputAudioTrack)[] = [videoTrack, audioTrack];
	for (const track of tracks) {
		const size = track.type === 'video' ? await track.getCodedWidth() : await track.getNumberOfChannels();
		expect(size).toBeGreaterThan(0);
	}
});
