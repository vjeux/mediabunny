import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, VideoSampleSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

test('Encrypted MP4 without senc', async () => {
	using input = new Input({
		source: new UrlSource('/639955605-b752f7ad-7ce8-43c2-8ae9-88e74c6ae696.mp4'),
		formats: ALL_FORMATS,
		formatOptions: {
			isobmff: {
				resolveKeyId: () => 'aabbccddeeff00112233445566778899',
			},
		},
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	// Test that it can decode
	const sink = new AudioSampleSink(audioTrack);
	using firstSample = await sink.getSample(0);
	assert(firstSample);
	expect(firstSample.timestamp).toBe(0);
});

test('avc3 video with its parameter sets only in-band decodes from a later key frame', async () => {
	// 'avc3' allows the parameter sets to be in the samples only (ISO/IEC 14496-15), here only in the first one. A
	// decoder that starts at a later key frame only has them if the decoder config's description carries them.
	const hex = (text: string) => text.match(/../g)!.map(byte => parseInt(byte, 16));
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const lengthPrefixed = (...nalUnits: number[][]) => nalUnits.flatMap(
		nalUnit => [...u32(nalUnit.length), ...nalUnit],
	);
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];

	// A 16x16 gray H.264 stream (x264, baseline), every frame an IDR picture
	const sps = hex('6742c00addec0440000003004000000503c489e0');
	const pps = hex('68ce019720');
	const slices = [hex('6588843a2780'), hex('65888202e89e'), hex('6588843a2780')];

	const decodeLaterKeyFrame = async (parameterSetsInAvcC: boolean) => {
		const samples = slices.map((slice, i) => i === 0 && !parameterSetsInAvcC
			? lengthPrefixed(sps, pps, slice)
			: lengthPrefixed(slice));
		const avcC = parameterSetsInAvcC
			? box('avcC', [1, 0x42, 0xc0, 0x0a, 0xff, 0xe1, 0, sps.length], sps, [1, 0, pps.length], pps)
			: box('avcC', [1, 0x42, 0xc0, 0x0a, 0xff, 0xe0, 0]);
		const sampleEntry = box(parameterSetsInAvcC ? 'avc1' : 'avc3', zeros(6), [0, 1], zeros(16), [0, 16, 0, 16],
			[0, 0x48, 0, 0, 0, 0x48, 0, 0], zeros(4), [0, 1], zeros(32), [0, 0x18, 0xff, 0xff], avcC);
		const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'));
		const moov = box('moov',
			box('mvhd', zeros(12), u32(1000), u32(300), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
			box('trak',
				box('tkhd', u32(3), zeros(8), u32(1), zeros(4), u32(300), zeros(16), matrix, u32(16 << 16),
					u32(16 << 16)),
				box('mdia',
					box('mdhd', zeros(12), u32(10), u32(3), [0x55, 0xc4, 0, 0]),
					box('hdlr', zeros(8), ascii('vide'), zeros(13)),
					box('minf', box('stbl',
						box('stsd', zeros(4), u32(1), sampleEntry),
						box('stts', zeros(4), u32(1), u32(3), u32(1)),
						box('stsc', zeros(4), u32(1), u32(1), u32(3), u32(1)),
						box('stsz', zeros(4), u32(0), u32(3), ...samples.map(sample => u32(sample.length))),
						box('stco', zeros(4), u32(1), u32(ftyp.length + 8)),
					)),
				),
			),
		);

		using input = new Input({
			source: new BufferSource(new Uint8Array([...ftyp, ...box('mdat', samples.flat()), ...moov])),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		using sample = await new VideoSampleSink(track).getSample(0.25);
		return sample?.timestamp;
	};

	expect(await decodeLaterKeyFrame(false)).toBe(0.2);
	expect(await decodeLaterKeyFrame(true)).toBe(0.2); // The control, an avc1 track
});
