import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';

test('MPEG-TS keeps tracks in the order they were added', async () => {
	// Track A (stereo) is added before track B (mono), but B delivers its first packet first, as can happen with
	// concurrent encoders or conversions. The MP4, MOV and Matroska muxers keep the order the tracks were added in.
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const a = new EncodedAudioPacketSource('aac');
	const b = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(a);
	output.addAudioTrack(b);
	await output.start();

	const decoderConfig = (channels: number): AudioDecoderConfig => ({
		codec: 'mp4a.40.2',
		sampleRate: 48000,
		numberOfChannels: channels,
		description: new Uint8Array([0x11, 0x80 | (channels << 3)]),
	});
	const data = new Uint8Array([0x21, 0x10, 0x05, 0x00]);
	for (let i = 0; i < 10; i++) {
		const sources = i === 0 ? [[b, 1], [a, 2]] as const : [[a, 2], [b, 1]] as const;
		for (const [source, channels] of sources) {
			const packet = new EncodedPacket(data, 'key', i * 0.02, 0.02);
			await source.add(packet, i === 0 ? { decoderConfig: decoderConfig(channels) } : undefined);
		}
	}

	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const tracks = await input.getAudioTracks();
	expect(await Promise.all(tracks.map(track => track.getNumberOfChannels()))).toEqual([2, 1]);
	expect(tracks.map(track => track.id)).toEqual([0x100, 0x101]);
});
