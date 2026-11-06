import { describe, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EBMLId } from '../../src/matroska/ebml.js';
import {
	buildAvcSps,
	concatBytes,
	ebml,
	ebmlFloat,
	ebmlString,
	ebmlUint,
	mkvFile,
	mkvSimpleBlock,
	u16be,
} from './helpers/mutation-bytes.js';

const openBytes = (bytes: Uint8Array) => new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

const mkvAudioTrack = (codecId: string, bitDepth: number | null, channels = 2, extra: Uint8Array[] = []) => ebml(
	EBMLId.TrackEntry,
	ebmlUint(EBMLId.TrackNumber, 1),
	ebmlUint(EBMLId.TrackUID, 1),
	ebmlUint(EBMLId.TrackType, 2),
	ebmlString(EBMLId.CodecID, codecId),
	ebml(
		EBMLId.Audio,
		ebmlFloat(EBMLId.SamplingFrequency, 48000),
		ebmlUint(EBMLId.Channels, channels),
		...(bitDepth === null ? [] : [ebmlUint(EBMLId.BitDepth, bitDepth)]),
	),
	...extra,
);

const mkvVideoTrack = (codecId: string, videoChildren: Uint8Array[], extra: Uint8Array[] = []) => ebml(
	EBMLId.TrackEntry,
	ebmlUint(EBMLId.TrackNumber, 1),
	ebmlUint(EBMLId.TrackUID, 1),
	ebmlUint(EBMLId.TrackType, 1),
	ebmlString(EBMLId.CodecID, codecId),
	ebml(EBMLId.Video, ...videoChildren),
	...extra,
);

const mkvCluster = (timestamp: number, ...simpleBlocks: Uint8Array[]) => ebml(
	EBMLId.Cluster,
	ebmlUint(EBMLId.Timestamp, timestamp),
	...simpleBlocks.map(block => ebml(EBMLId.SimpleBlock, block)),
);

const VP8_KEY_FRAME = [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01];

describe('Matroska demuxing', () => {
	test.each([
		['A_PCM/INT/LIT', 8, 'pcm-u8'],
		['A_PCM/INT/LIT', 16, 'pcm-s16'],
		['A_PCM/INT/LIT', 24, 'pcm-s24'],
		['A_PCM/INT/LIT', 32, 'pcm-s32'],
		['A_PCM/INT/BIG', 8, 'pcm-u8'],
		['A_PCM/INT/BIG', 16, 'pcm-s16be'],
		['A_PCM/INT/BIG', 24, 'pcm-s24be'],
		['A_PCM/INT/BIG', 32, 'pcm-s32be'],
		['A_PCM/FLOAT/IEEE', 32, 'pcm-f32'],
		['A_PCM/FLOAT/IEEE', 64, 'pcm-f64'],
	])('%s with BitDepth %i reads as %s', async (codecId, bitDepth, expected) => {
		const bytes = mkvFile({
			trackEntries: [mkvAudioTrack(codecId, bitDepth)],
			rest: [mkvCluster(0, mkvSimpleBlock(1, 0, 0x80, new Uint8Array(bitDepth / 8 * 2 * 480)))],
		});
		using input = openBytes(bytes);
		const track = await input.getPrimaryAudioTrack();
		expect(await track!.getCodec()).toBe(expected);
	});

	test('PCM with an unsupported bit depth has no codec', async () => {
		const bytes = mkvFile({
			trackEntries: [mkvAudioTrack('A_PCM/FLOAT/IEEE', 16)],
			rest: [mkvCluster(0, mkvSimpleBlock(1, 0, 0x80, new Uint8Array(64)))],
		});
		using input = openBytes(bytes);
		const track = await input.getPrimaryAudioTrack();
		expect(await track!.getCodec()).toBe(null);
	});

	test.each([
		// DisplayWidth/DisplayHeight → square-pixel size and decoder config aspect
		[[853, 480], [853, 480], { displayAspectWidth: 853, displayAspectHeight: 480 }],
		[[640, 960], [640, 960], { displayAspectWidth: 640, displayAspectHeight: 960 }],
		[[16, 9], [853, 480], { displayAspectWidth: 853, displayAspectHeight: 480 }],
		[[640, 480], [640, 480], {}],
		[[0, 480], [640, 480], {}],
	] as const)('DisplayWidth/Height %j on 640x480 give a %j display size', async ([dw, dh], [ew, eh], aspect) => {
		const bytes = mkvFile({
			trackEntries: [mkvVideoTrack('V_VP8', [
				ebmlUint(EBMLId.PixelWidth, 640),
				ebmlUint(EBMLId.PixelHeight, 480),
				ebmlUint(EBMLId.DisplayWidth, dw),
				ebmlUint(EBMLId.DisplayHeight, dh),
			])],
			rest: [mkvCluster(0, mkvSimpleBlock(1, 0, 0x80, VP8_KEY_FRAME))],
		});
		using input = openBytes(bytes);
		const track = await input.getPrimaryVideoTrack();
		expect(await track!.getDisplayWidth()).toBe(ew);
		expect(await track!.getDisplayHeight()).toBe(eh);
		const config = await track!.getDecoderConfig();
		expect(config!.codedWidth).toBe(640);
		expect(config!.codedHeight).toBe(480);
		expect(config!.displayAspectWidth).toBe((aspect as { displayAspectWidth?: number }).displayAspectWidth);
		expect(config!.displayAspectHeight).toBe((aspect as { displayAspectHeight?: number }).displayAspectHeight);
	});

	test('colour values missing from the Colour element are filled in from the SPS', async () => {
		// BT.709 primaries/transfer, BT.470BG matrix, full range in the SPS; the container only names the matrix
		const sps = buildAvcSps({
			profileIdc: 66,
			levelIdc: 30,
			widthInMbs: 40,
			heightInMapUnits: 30,
			vui: { videoSignal: { fullRange: true, colour: [1, 1, 5] } },
		});
		const pps = [0x68, 0xce, 0x3c, 0x80];
		const avcC = concatBytes([1, 66, 0xc0, 30, 0xff, 0xe1], u16be(sps.length), sps, [1], u16be(pps.length), pps);
		const bytes = mkvFile({
			trackEntries: [mkvVideoTrack('V_MPEG4/ISO/AVC', [
				ebmlUint(EBMLId.PixelWidth, 640),
				ebmlUint(EBMLId.PixelHeight, 480),
				ebml(EBMLId.Colour, ebmlUint(EBMLId.MatrixCoefficients, 6)),
			], [ebml(EBMLId.CodecPrivate, avcC)])],
			rest: [mkvCluster(0, mkvSimpleBlock(1, 0, 0x80, [0, 0, 0, 2, 0x65, 0x88]))],
		});
		using input = openBytes(bytes);
		const track = await input.getPrimaryVideoTrack();
		const config = await track!.getDecoderConfig();
		expect(config!.colorSpace).toEqual({
			primaries: 'bt709',
			transfer: 'bt709',
			matrix: 'smpte170m',
			fullRange: true,
		});
	});

	test('a track with FlagEnabled 0 is left out, one with FlagEnabled 1 is kept', async () => {
		const disabled = mkvFile({
			trackEntries: [
				mkvAudioTrack('A_PCM/INT/LIT', 16, 2, [ebmlUint(EBMLId.FlagEnabled, 0)]),
			],
			rest: [mkvCluster(0, mkvSimpleBlock(1, 0, 0x80, new Uint8Array(64)))],
		});
		using disabledInput = openBytes(disabled);
		expect(await disabledInput.getTracks()).toHaveLength(0);

		const enabled = mkvFile({
			trackEntries: [mkvAudioTrack('A_PCM/INT/LIT', 16, 2, [ebmlUint(EBMLId.FlagEnabled, 1)])],
			rest: [mkvCluster(0, mkvSimpleBlock(1, 0, 0x80, new Uint8Array(64)))],
		});
		using enabledInput = openBytes(enabled);
		expect(await enabledInput.getTracks()).toHaveLength(1);
	});

	const simpleTag = (name: string, value: string) => ebml(
		EBMLId.SimpleTag,
		ebmlString(EBMLId.TagName, name),
		ebmlString(EBMLId.TagString, value),
	);

	test.each([
		['PART_NUMBER', '3', { trackNumber: 3 }],
		['PART_NUMBER', '0', {}],
		['PART_NUMBER', '-1', {}],
		['TRACK_NUMBER', '4/10', { trackNumber: 4, tracksTotal: 10 }],
		['TRACK_NUMBER', '0/0', {}],
		['TRACK_NUMBER', '4/-2', { trackNumber: 4 }],
		['DISC', '5', { discNumber: 5 }],
		['DISC_NUMBER', '2/3', { discNumber: 2, discsTotal: 3 }],
		['DISC_NUMBER', '0/-3', {}],
		['BPM', '0', {}],
		['BPM', '96', { beatsPerMinute: 96 }],
		['DATE_RELEASED', 'garbage', {}],
	])('the %s tag %j reads as %j', async (name, value, expected) => {
		const targets = ebml(EBMLId.Targets, ebmlUint(EBMLId.TargetTypeValue, 50));
		const bytes = mkvFile({
			trackEntries: [mkvAudioTrack('A_PCM/INT/LIT', 16)],
			rest: [
				ebml(EBMLId.Tags, ebml(EBMLId.Tag, targets, simpleTag(name, value))),
				mkvCluster(0, mkvSimpleBlock(1, 0, 0x80, new Uint8Array(64))),
			],
		});
		using input = openBytes(bytes);
		const { raw, ...tags } = await input.getMetadataTags();
		expect(raw).toBeDefined();
		expect(tags).toEqual(expected);
	});
});
