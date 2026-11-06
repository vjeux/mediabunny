import { describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { FlacOutputFormat, OggOutputFormat } from '../../src/output-format.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { buildFlacFile } from '../node/helpers/audio-flac-ogg-builders.js';

const hexToBytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map(x => parseInt(x, 16)));

/** Decodes all audio of the primary track into interleaved floats. */
const decodeAll = async (bytes: Uint8Array | string) => {
	using input = new Input({
		source: typeof bytes === 'string' ? new UrlSource(bytes) : new BufferSource(bytes),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	const channels = await track.getNumberOfChannels();
	const chunks: Float32Array[] = [];
	const timestamps: number[] = [];
	let frames = 0;
	for await (using sample of new AudioSampleSink(track).samples()) {
		const data = new Float32Array(sample.numberOfFrames * channels);
		sample.copyTo(data, { planeIndex: 0, format: 'f32' });
		chunks.push(data);
		timestamps.push(sample.timestamp);
		frames += sample.numberOfFrames;
	}
	const all = new Float32Array(frames * channels);
	let offset = 0;
	for (const chunk of chunks) {
		all.set(chunk, offset);
		offset += chunk.length;
	}
	return { samples: all, frames, channels, timestamps, sampleRate: await track.getSampleRate() };
};

/** Undoes FLAC inter-channel decorrelation (RFC 9639 section 4.2). */
const decorrelate = (assignment: number, a: number, b: number): [number, number] => {
	if (assignment === 8) {
		return [a, a - b]; // left, side
	} else if (assignment === 9) {
		return [a + b, b]; // side, right
	} else if (assignment === 10) {
		const mid = (a * 2) | (b & 1);
		return [(mid + b) >> 1, (mid - b) >> 1]; // mid, side
	}
	return [a, b];
};

describe('FLAC decoding through WebCodecs', () => {
	test.each([
		[1, 16, 0],
		[2, 16, 1],
		[2, 16, 8],
		[2, 16, 9],
		[2, 16, 10],
		[2, 24, 10],
		[2, 8, 8],
		[6, 24, 5],
		[8, 16, 7],
	])('decodes %i channel(s) of %i-bit audio, channel assignment %i, exactly', async (channels, bits, assignment) => {
		const blockSizes = [1152, 1152, 333];
		const max = 2 ** (bits - 1) - 1;
		// Distinct, full-range values per channel, so that a swapped or mis-decorrelated channel can't go unnoticed
		const value = (channel: number, index: number, frame: number) => {
			const raw = Math.round(max * Math.sin((index + frame * 1152) * 0.01 * (channel + 1)));
			return Math.max(-max, Math.min(max, raw)) + 0; // No negative zero
		};
		const stored = (channel: number, index: number, frame: number) => {
			if (channels !== 2 || assignment < 8) {
				return value(channel, index, frame);
			}
			const left = value(0, index, frame);
			const right = value(1, index, frame);
			const side = left - right;
			if (assignment === 8) {
				return channel === 0 ? left : side;
			} else if (assignment === 9) {
				return channel === 0 ? side : right;
			}
			return channel === 0 ? (left + right) >> 1 : side;
		};
		const { bytes } = buildFlacFile({
			sampleRate: 44100,
			channels,
			bitsPerSample: bits,
			blockSizes,
			channelAssignment: assignment,
			subframeSamples: stored,
		});

		const decoded = await decodeAll(bytes);
		expect(decoded.channels).toBe(channels);
		expect(decoded.frames).toBe(2637);
		let worst = 0;
		let frameStart = 0;
		for (let frame = 0; frame < blockSizes.length; frame++) {
			for (let i = 0; i < blockSizes[frame]!; i++) {
				for (let channel = 0; channel < channels; channel++) {
					let expected = value(channel, i, frame);
					if (channels === 2 && assignment >= 8) {
						const pair = decorrelate(assignment, stored(0, i, frame), stored(1, i, frame));
						expect(pair[channel]).toBe(expected); // The builder round-trips
						expected = pair[channel]!;
					}
					const actual = decoded.samples[(frameStart + i) * channels + channel]! * 2 ** (bits - 1);
					worst = Math.max(worst, Math.abs(actual - expected));
				}
			}
			frameStart += blockSizes[frame]!;
		}
		expect(worst).toBeLessThan(0.5);
	});

	// The example files of RFC 9639 Appendix D, with the sample values the RFC lists (and FFmpeg decodes)
	test.each([
		[
			'664c6143800000221000100000000f00000f0ac442f0000000013e84b41807dc690307586a3dad1a2e0f'
			+ 'fff869180000bf0358fd03128baa9a',
			44100,
			[25588, 10416],
		],
		[
			'664c614300000022001000100000170000440ac442f000000013d5b0564975e98b8d8b930422757b81'
			+ '03030000120000000000000000000000000000000000100400003a200000007265666572656e6365206c6962464c4143'
			+ '20312e332e33203230313930383034010000000e0000005449544c453dd7a9d79cd795d79d81000006000000000000'
			+ 'fff86998000f9912086701623d1442998f5df70d6fe00c17caeb21000ee7a77a24a1590c1217b603097b784faa9a33'
			+ 'd285e070ad5b1b4851b4010d99d2cd1a68f1e6b810fff869180102a402c382c40bc14a03ee48dd03b67c1330',
			44100,
			[
				10372, 6070, 18041, 10545, 14942, 8743, 17876, 10449, 15627, 9143, 17899, 10463, 16242, 9502, 18077,
				10569, 16824, 9840, 18263, 10680, 17295, 10113, -14418, -8428, -15201, -8895, -14508, -8476, -15195,
				-8896, -14818, -8653, -15486, -9072, -15349, -8958, -16054, -9410,
			],
		],
		[
			'664c6143800000221000100000001f00001f07d0007000000018f8f9e396f5cbcfc6dc807f9977906b32'
			+ 'fff868020017e944004f6f313d1047d227cb6d090831452bdc2822228057a3',
			32000,
			// 8-bit samples, scaled to 16 bits
			[
				0, 20224, 28416, 19968, 2048, -15616, -23040, -17408, -3328, 10752, 17152, 13568, 3328, -6912, -11776,
				-9728, -3072, 3584, 6144, 4864, 1536, -1024, -1280, 0,
			],
		],
	])('decodes RFC 9639 example file %#', async (hex, sampleRate, expected) => {
		const decoded = await decodeAll(hexToBytes(hex));
		expect(decoded.sampleRate).toBe(sampleRate);
		expect(Array.from(decoded.samples, x => Math.round(x * 32768))).toEqual(expected);
	});
});

describe('Ogg decoding through WebCodecs', () => {
	const remuxToOgg = async (url: string) => {
		using input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource((await track.getCodec())!);
		output.addAudioTrack(source);
		await output.start();
		const decoderConfig = (await track.getDecoderConfig())!;
		let first = true;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			await source.add(packet, first ? { decoderConfig } : undefined);
			first = false;
		}
		source.close();
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	test.each(['/preroll-test.opus', '/vorbis-eos.ogg'])('decodes %s identically after an Ogg remux', async (url) => {
		const original = await decodeAll(url);
		const remuxed = await decodeAll(await remuxToOgg(url));
		expect(remuxed.frames).toBe(original.frames);
		expect(remuxed.timestamps).toEqual(original.timestamps);
		expect(remuxed.samples).toEqual(original.samples);
	});

	test('Chrome\'s own Ogg demuxer gives a remuxed Opus file the duration Mediabunny computes', async () => {
		const remuxed = await remuxToOgg('/preroll-test.opus');
		using input = new Input({ source: new BufferSource(remuxed), formats: ALL_FORMATS });
		const duration = await (await input.getPrimaryAudioTrack())!.computeDuration();
		const context = new OfflineAudioContext(1, 1, 48000);
		const buffer = await context.decodeAudioData(remuxed.slice().buffer);
		// Chrome applies the pre-skip and the end trimming of the final granule position (RFC 7845 section 4)
		expect(buffer.length).toBe(Math.round(duration * 48000));
		expect(buffer.length).toBe(288000);
	});

	test('round-trips FLAC through the FLAC muxer and decodes it identically', async () => {
		using input = new Input({ source: new UrlSource('/sample.flac'), formats: ALL_FORMATS });
		const track = (await input.getPrimaryAudioTrack())!;
		const output = new Output({ format: new FlacOutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('flac');
		output.addAudioTrack(source);
		await output.start();
		const decoderConfig = (await track.getDecoderConfig())!;
		let first = true;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			await source.add(packet, first ? { decoderConfig } : undefined);
			first = false;
		}
		source.close();
		await output.finalize();

		const original = await decodeAll('/sample.flac');
		const remuxed = await decodeAll(new Uint8Array(output.target.buffer!));
		expect(remuxed.frames).toBe(original.frames);
		expect(remuxed.samples).toEqual(original.samples);
	});
});
