import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { EncodedPacket } from '../../src/packet.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('MPEG-TS muxing uses the decoder config a track declared up front', async () => {
	// A track can declare its decoder config when it's added, and then get its packets without metadata, as the other
	// muxers accept. Found by L66. Remuxes the first 10 packets of video.mp4's tracks (AVC with an avcC description,
	// AAC with an AudioSpecificConfig), with and without metadata on the first packet.
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	for (const type of ['video', 'audio'] as const) {
		const inputTrack = type === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
		const decoderConfig = await inputTrack!.getDecoderConfig();
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(inputTrack!).packets()) {
			packets.push(packet);
			if (packets.length === 10) {
				break;
			}
		}

		const outputs: Uint8Array[] = [];
		for (const withMetadata of [true, false]) {
			const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
			const source = type === 'video' ? new EncodedVideoPacketSource('avc') : new EncodedAudioPacketSource('aac');
			if (source instanceof EncodedVideoPacketSource) {
				output.addVideoTrack(source, { decoderConfig: decoderConfig as VideoDecoderConfig });
			} else {
				output.addAudioTrack(source, { decoderConfig: decoderConfig as AudioDecoderConfig });
			}
			await output.start();

			for (const [i, packet] of packets.entries()) {
				const meta = withMetadata && i === 0 ? { decoderConfig } : undefined;
				if (source instanceof EncodedVideoPacketSource) {
					await source.add(packet, meta as EncodedVideoChunkMetadata | undefined);
				} else {
					await source.add(packet, meta as EncodedAudioChunkMetadata | undefined);
				}
			}
			await output.finalize();
			outputs.push(new Uint8Array(output.target.buffer!));

			using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
			const track = (await result.getTracks())[0];
			expect(await track!.getCodec()).toBe(type === 'video' ? 'avc' : 'aac');

			const timestamps: number[] = [];
			for await (const packet of new EncodedPacketSink(track!).packets()) {
				timestamps.push(packet.timestamp);
			}
			expect(timestamps).toEqual(packets.map(x => x.timestamp));
		}

		// The same file either way
		expect(outputs[1]).toEqual(outputs[0]);
	}
});
