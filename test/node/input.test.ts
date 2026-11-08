import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Input, UnsupportedInputFormatError } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource } from '../../src/source.js';
import { AudioSampleSink, VideoSampleSink } from '../../src/media-sink.js';
import {
	CustomAudioDecoder,
	customAudioDecoders,
	CustomVideoDecoder,
	customVideoDecoders,
	registerDecoder,
} from '../../src/custom-coder.js';

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

class DecliningVideoDecoder extends CustomVideoDecoder {
	static override supports() {
		return false;
	}

	init() {}
	decode() {}
	flush() {}
	close() {}
}

class DecliningAudioDecoder extends CustomAudioDecoder {
	static override supports() {
		return false;
	}

	init() {}
	decode() {}
	flush() {}
	close() {}
}

test.for(['video', 'audio'] as const)(
	'A %s track the registered custom decoders decline is reported as undecodable, not as missing WebCodecs',
	async (type) => {
		// Node has no WebCodecs. With custom decoders registered (like @mediabunny/server's) that all decline the
		// track, the sinks only blamed the missing WebCodecs class (found by the lane L93 review)
		registerDecoder(type === 'video' ? DecliningVideoDecoder : DecliningAudioDecoder);
		try {
			using input = new Input({
				source: new BufferSource(fs.readFileSync(path.join(__dirname, '..', 'public/demo.webm'))),
				formats: ALL_FORMATS,
			});
			const videoTrack = await input.getPrimaryVideoTrack();
			const audioTrack = await input.getPrimaryAudioTrack();
			const sample = type === 'video'
				? new VideoSampleSink(videoTrack!).getSample(0)
				: new AudioSampleSink(audioTrack!).getSample(0);

			// Both facts: the registered decoders may be for other codecs
			const className = type === 'video' ? 'VideoDecoder' : 'AudioDecoder';
			await expect(sample).rejects.toThrow(
				`This ${type} track cannot be decoded in this environment. No registered custom decoder supports it,`
				+ ` and ${className} is not available in this environment.`,
			);
		} finally {
			if (type === 'video') {
				customVideoDecoders.splice(customVideoDecoders.indexOf(DecliningVideoDecoder), 1);
			} else {
				customAudioDecoders.splice(customAudioDecoders.indexOf(DecliningAudioDecoder), 1);
			}
		}
	},
);
