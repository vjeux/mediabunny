import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat, MpegTsOutputFormatOptions } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';

test('Conversion copies AAC with encoder priming into MPEG-TS with a timestamp offset', async () => {
	// The AAC track of an ordinary MP4 starts with a priming packet 1024 samples before zero. An offset keeps it
	// positive in the file, so the track can be copied instead of being re-encoded (or dropped, where no AAC encoder
	// exists, like here)
	const convertDemo = async (options: MpegTsOutputFormatOptions) => {
		const output = new Output({ format: new MpegTsOutputFormat(options), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input: new Input({ source: new FilePathSource('./test/public/demo.mp4'), formats: ALL_FORMATS }),
			output,
			trim: { end: 2 },
			showWarnings: false,
		});

		return { conversion, output };
	};

	const { conversion, output } = await convertDemo({ timestampOffset: 10 });
	expect(conversion.discardedTracks.map(x => `${x.track.type}: ${x.reason}`)).toEqual([]);
	expect(output.tracks.map(x => x.source.constructor.name))
		.toEqual(['EncodedVideoPacketSource', 'EncodedAudioPacketSource']);
	await conversion.execute();

	// The priming keeps the audio 1024 samples ahead of the video, as in the source, and both start after zero
	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const videoStart = await (await input.getPrimaryVideoTrack())!.getFirstTimestamp();
	const audioStart = await (await input.getPrimaryAudioTrack())!.getFirstTimestamp();
	expect(audioStart - videoStart).toBeCloseTo(-1024 / 48000, 6);
	expect(audioStart).toBeCloseTo(10 - 1024 / 48000, 4);

	// Without an offset, or with one smaller than the priming, the timestamps would go below zero in the file, so the
	// track isn't copied, as before
	for (const options of [{}, { timestampOffset: 0.01 }]) {
		const { conversion } = await convertDemo(options);
		expect(conversion.discardedTracks.map(x => `${x.track.type}: ${x.reason}`))
			.toEqual(['audio: undecodable_source_codec']);
	}
});
