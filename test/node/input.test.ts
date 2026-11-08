import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Input, InputDisposedError, UnsupportedInputFormatError } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource, CustomSource } from '../../src/source.js';

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

test.for([
	['video', 'demo.webm'],
	['audio', 'toothsome-dts-esds.mp4'],
] as const)('canDecode() of a %s track rejects when the input is disposed while it reads', async ([type, file]) => {
	// The decodability check returned false for a canceled read, so a conversion disposed mid-init blamed the codec
	// (found by the lane L94 review). These two tracks read the file to know their decoder config.
	const data = fs.readFileSync(path.join(__dirname, '..', 'public', file));
	let disposeOnRead = false;
	const input: Input = new Input({
		source: new CustomSource({
			getSize: () => data.byteLength,
			read: async (start, end) => {
				await new Promise(resolve => setTimeout(resolve, 5));
				if (disposeOnRead) {
					input.dispose();
				}

				return data.subarray(start, end);
			},
		}),
		formats: ALL_FORMATS,
	});

	const track = type === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
	expect(track).not.toBe(null);
	disposeOnRead = true;
	await expect(track!.canDecode()).rejects.toBeInstanceOf(InputDisposedError);
});
