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

test('MPEG-TS muxing knows its tracks from the decoder configs declared with them', async () => {
	// Like the other muxers, right after start(): getMimeType() resolves (it waited for a packet on every track), and
	// the PMT lists the tracks even if they get no packets
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	output.addVideoTrack(new EncodedVideoPacketSource('avc'), {
		decoderConfig: {
			codec: 'avc1.64001f',
			codedWidth: 320,
			codedHeight: 240,
			// avcC with a 4-byte dummy SPS (high profile, level 3.1) and a 2-byte PPS
			description: new Uint8Array([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x1f, 1, 0, 2, 0x68, 0xee]),
		},
	});
	output.addAudioTrack(new EncodedAudioPacketSource('aac'), {
		decoderConfig: {
			codec: 'mp4a.40.2',
			numberOfChannels: 2,
			sampleRate: 48000,
			description: new Uint8Array([0x11, 0x90]),
		},
	});
	await output.start();

	const timeout = new Promise<string>(resolve => setTimeout(() => resolve('unresolved after 500 ms'), 500));
	expect(await Promise.race([output.getMimeType(), timeout])).toBe('video/MP2T; codecs="avc1.64001f, mp4a.40.2"');

	await output.finalize();

	// The stream types in the PMT (on PID 0x1000, in one TS packet)
	const bytes = new Uint8Array(output.target.buffer!);
	let streamTypes: number[] | null = null;
	for (let pos = 0; pos < bytes.length && !streamTypes; pos += 188) {
		if ((((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!) === 0x1000) {
			const section = pos + 5 + bytes[pos + 4]!; // After the pointer_field
			const sectionEnd = section + 3 + (((bytes[section + 1]! & 0x0f) << 8) | bytes[section + 2]!) - 4;
			streamTypes = [];
			let entry = section + 12 + (((bytes[section + 10]! & 0x0f) << 8) | bytes[section + 11]!);
			while (entry < sectionEnd) {
				streamTypes.push(bytes[entry]!);
				entry += 5 + (((bytes[entry + 3]! & 0x0f) << 8) | bytes[entry + 4]!);
			}
		}
	}
	expect(streamTypes).toEqual([0x1b, 0x0f]); // AVC, AAC
});
