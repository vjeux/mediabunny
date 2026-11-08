import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { AudioTrackMetadata, OutputTrackGroup, VideoTrackMetadata } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';

test('Default track disposition', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);

	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1), {
		decoderConfig: {
			codec: 'avc1.123456',
			codedWidth: 1920,
			codedHeight: 1080,
		},
	});

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryVideoTrack())!;

	expect(await track.getDisposition()).toEqual({
		default: true,
		forced: false,
		original: false,
		hearingImpaired: false,
		visuallyImpaired: false,
		primary: false,
		commentary: false,
	});
});

test('Customized track disposition', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, {
		disposition: {
			default: false,
			forced: true,
			original: true,
			hearingImpaired: true,
			visuallyImpaired: true,
			commentary: true,
		},
	});

	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1), {
		decoderConfig: {
			codec: 'avc1.123456',
			codedWidth: 1920,
			codedHeight: 1080,
		},
	});

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryVideoTrack())!;

	expect(await track.getDisposition()).toEqual({
		default: false,
		forced: true,
		original: true,
		hearingImpaired: true,
		visuallyImpaired: true,
		primary: false,
		commentary: true,
	});
});

test('Each track keeps the metadata it was added with, even when the caller reuses the object', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	// One object, tweaked for each track, as is natural for multi-language outputs
	const groups = [new OutputTrackGroup()];
	const metadata: AudioTrackMetadata = { disposition: {}, group: groups };
	const sources: EncodedAudioPacketSource[] = [];
	for (const [i, languageCode] of ['eng', 'fra', 'deu'].entries()) {
		metadata.languageCode = languageCode;
		metadata.disposition!.default = i === 0;
		metadata.disposition!.commentary = i === 2;
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source, metadata);
		sources.push(source);
	}
	// Changes made after adding the tracks reach none of them, so they can't bypass the validation either
	metadata.disposition!.forced = 'yes' as never;
	groups.push('not a group' as never);
	expect(output.tracks[0]!.metadata.group).toEqual([groups[0]]);

	await output.start();
	for (const source of sources) {
		await source.add(new EncodedPacket(new Uint8Array(960), 'key', 0, 0.01), {
			decoderConfig: { codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 48000 },
		});
	}
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const tracks = await input.getAudioTracks();
	expect(await Promise.all(tracks.map(track => track.getLanguageCode()))).toEqual(['eng', 'fra', 'deu']);
	const dispositions = await Promise.all(tracks.map(track => track.getDisposition()));
	expect(dispositions.map(disposition => disposition.default)).toEqual([true, false, false]);
	expect(dispositions.map(disposition => disposition.commentary)).toEqual([false, false, true]);
	expect(dispositions.map(disposition => disposition.forced)).toEqual([false, false, false]);

	// Video metadata's matrix and decoder config (with its description bytes) are copied too
	const videoOutput = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const description = new Uint8Array([1, 2, 3, 4]);
	const videoMetadata: VideoTrackMetadata = {
		transformationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
		decoderConfig: { codec: 'avc1.42001f', codedWidth: 2, codedHeight: 2, description },
	};
	videoOutput.addVideoTrack(new EncodedVideoPacketSource('avc'), videoMetadata);
	videoMetadata.transformationMatrix![0] = -1;
	description.fill(0);
	const trackMetadata = videoOutput.tracks[0]!.metadata as VideoTrackMetadata;
	expect(trackMetadata.transformationMatrix![0]).toBe(1);
	expect([...(trackMetadata.decoderConfig!.description as Uint8Array)]).toEqual([1, 2, 3, 4]);
});
