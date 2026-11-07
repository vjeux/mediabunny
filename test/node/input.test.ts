import { expect, test } from 'vitest';
import { Input, UnsupportedInputFormatError } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource, CustomPathedSource } from '../../src/source.js';
import { Output } from '../../src/output.js';
import { HlsOutputFormat, MkvOutputFormat, Mp4OutputFormat, OutputFormat } from '../../src/output-format.js';
import { BufferTarget, NullTarget, PathedTarget } from '../../src/target.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Conversion } from '../../src/conversion.js';
import { Logging } from '../../src/logging.js';
import { assert } from '../../src/misc.js';

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

/** A file with a video track and two audio tracks (two languages). */
const writeVideoWithTwoAudioTracks = async (format: OutputFormat) => {
	const output = new Output({ format, target: new BufferTarget() });
	const videoSource = new EncodedVideoPacketSource('vp9');
	const audioSources = [new EncodedAudioPacketSource('opus'), new EncodedAudioPacketSource('opus')];
	output.addVideoTrack(videoSource);
	output.addAudioTrack(audioSources[0]!, { languageCode: 'eng' });
	output.addAudioTrack(audioSources[1]!, { languageCode: 'fra' });
	await output.start();

	await videoSource.add(new EncodedPacket(new Uint8Array([0x82, 0x49, 0x83, 0x42, 0x00]), 'key', 0, 0.04), {
		decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 48 },
	});
	const opusHead = new Uint8Array([...new TextEncoder().encode('OpusHead'), 1, 2, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0]);
	for (const audioSource of audioSources) {
		await audioSource.add(new EncodedPacket(new Uint8Array([0xfc, 0xff, 0xfe]), 'key', 0, 0.02), {
			decoderConfig: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, description: opusHead },
		});
	}
	await output.finalize();

	return output.target.buffer!;
};

test('Tracks of the same type are not pairable with each other', async () => {
	// The video track pairs with either audio track, but the audio tracks are alternatives (found by lane L55)
	for (const format of [new Mp4OutputFormat(), new MkvOutputFormat()]) {
		using input = new Input({
			source: new BufferSource(await writeVideoWithTwoAudioTracks(format)),
			formats: ALL_FORMATS,
		});
		const videoTrack = await input.getPrimaryVideoTrack();
		const [audioTrackA, audioTrackB] = await input.getAudioTracks();
		assert(videoTrack && audioTrackA && audioTrackB);

		expect(videoTrack.canBePairedWith(audioTrackA)).toBe(true);
		expect(videoTrack.canBePairedWith(audioTrackB)).toBe(true);
		expect(audioTrackA.canBePairedWith(audioTrackB)).toBe(false);
		expect(await audioTrackA.getPairableAudioTracks()).toEqual([]);
	}

	// Audio renditions of one group in HLS
	const masterPlaylist = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="French",LANGUAGE="fr",URI="fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001F,mp4a.40.2",RESOLUTION=640x360,AUDIO="aud"
360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.64001F,mp4a.40.2",RESOLUTION=1280x720,AUDIO="aud"
720.m3u8
`;
	using hlsInput = new Input({
		source: new CustomPathedSource('master.m3u8', () => new BufferSource(new TextEncoder().encode(masterPlaylist))),
		formats: ALL_FORMATS,
	});
	const videoTracks = await hlsInput.getVideoTracks();
	const [englishTrack, frenchTrack] = await hlsInput.getAudioTracks();
	assert(englishTrack && frenchTrack);

	expect(englishTrack.canBePairedWith(frenchTrack)).toBe(false);
	expect(videoTracks.every(x => x.canBePairedWith(englishTrack) && x.canBePairedWith(frenchTrack))).toBe(true);
});

test('Converting a file with two audio tracks to HLS keeps the audio tracks apart', async () => {
	using input = new Input({
		source: new BufferSource(await writeVideoWithTwoAudioTracks(new Mp4OutputFormat())),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new Mp4OutputFormat() }),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const warnings: unknown[][] = [];
	const removeListener = Logging.on('warn', (...args) => warnings.push(args));
	try {
		const conversion = await Conversion.init({ input, output });
		await conversion.execute();
	} finally {
		removeListener();
	}

	// HLS can't pair two audio tracks, which used to be logged as an illegal pairing taken over from the input
	expect(warnings).toEqual([]);
});
