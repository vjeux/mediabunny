import { describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input, InputTrack } from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Files written by FFmpeg 7 with the muxer options that showed up in a corpus of ~4,800 real-world files, read
// with Mediabunny and compared against ffprobe (packet data, timestamps, key flags, durations, lookups). The
// expected values come from ffprobe -show_packets -show_data_hash MD5; where Mediabunny deliberately differs, the
// fixture says why.
//
// The fixtures were made with these inputs and options:
// $V          -f lavfi -i testsrc2=size=64x48:rate=25:duration=0.8
// $A          -f lavfi -i sine=frequency=440:sample_rate=48000:duration=0.8
// $A44        -f lavfi -i sine=frequency=440:sample_rate=44100:duration=0.8
// $X264       -c:v libx264 -preset veryfast -g 10 -bf 2 -pix_fmt yuv420p
// $X264_NO_B  -c:v libx264 -preset veryfast -g 10 -bf 0 -pix_fmt yuv420p
// $AAC        -c:a aac -b:a 32k
// $COMMON     -map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact

type TrackExpectation = {
	type: 'video' | 'audio';
	codec: string;
	codecString: string;
	bytes: number;
	firstUs: number;
	// Compressed tracks: packet counts, the MD5 of the per-packet MD5s (decode order), and lookups as
	// [timestamp, expected getPacket timestamp, expected getKeyPacket timestamp], all in microseconds
	packets?: number;
	keyPackets?: number;
	lastUs?: number;
	dataMd5?: string;
	timestampsMd5?: string;
	seeks?: [number, number, number][];
	// PCM tracks: the MD5 of the whole payload and the end of the last packet
	pcmMd5?: string;
	endUs?: number;
};

type Fixture = {
	file: string;
	format: string;
	durationUs?: number;
	tracks: TrackExpectation[];
};

const toUs = (seconds: number) => Math.round(seconds * 1e6);

// Timestamps are compared in whole microseconds, allowing for rounding
const expectUs = (actual: number | undefined, expected: number) => {
	expect(Math.abs(actual! - expected)).toBeLessThanOrEqual(1);
};

const md5 = (data: Uint8Array | string) => crypto.createHash('md5').update(data).digest('hex');

const expectTrack = async (track: InputTrack, expected: TrackExpectation) => {
	expect(track.type).toBe(expected.type);
	expect(await track.getCodec()).toBe(expected.codec);
	expect(await track.getCodecParameterString()).toBe(expected.codecString);

	const sink = new EncodedPacketSink(track);
	const timestamps: number[] = [];
	const ends: number[] = [];
	const hashes: string[] = [];
	const payload: Uint8Array[] = [];
	let keyPackets = 0;
	let bytes = 0;
	for await (const packet of sink.packets()) {
		timestamps.push(toUs(packet.timestamp));
		ends.push(toUs(packet.timestamp + packet.duration));
		hashes.push(md5(packet.data));
		if (expected.pcmMd5) {
			payload.push(packet.data);
		}
		keyPackets += packet.type === 'key' ? 1 : 0;
		bytes += packet.byteLength;
	}

	expect(bytes).toBe(expected.bytes);
	expectUs(timestamps[0], expected.firstUs);

	if (expected.pcmMd5) {
		expectUs(ends.at(-1), expected.endUs!);
		expect(md5(Buffer.concat(payload))).toBe(expected.pcmMd5);
		return;
	}

	expect(timestamps).toHaveLength(expected.packets!);
	expect(keyPackets).toBe(expected.keyPackets);
	expectUs(Math.max(...timestamps), expected.lastUs!);
	expect(md5(hashes.join(','))).toBe(expected.dataMd5);
	expect(md5(timestamps.join(','))).toBe(expected.timestampsMd5);

	for (const [atUs, packetUs, keyPacketUs] of expected.seeks!) {
		const packet = await sink.getPacket(atUs / 1e6);
		const keyPacket = await sink.getKeyPacket(atUs / 1e6);
		expectUs(toUs(packet!.timestamp), packetUs);
		expectUs(toUs(keyPacket!.timestamp), keyPacketUs);
	}
};

const openFixture = (fixture: Fixture) => new Input({
	source: new FilePathSource(path.join(__dirname, '..', 'public', fixture.file)),
	formats: ALL_FORMATS,
});

const expectFixture = async (fixture: Fixture) => {
	using input = openFixture(fixture);

	expect((await input.getFormat()).name).toBe(fixture.format);

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(fixture.tracks.length);
	for (let i = 0; i < tracks.length; i++) {
		await expectTrack(tracks[i]!, fixture.tracks[i]!);
	}

	if (fixture.durationUs !== undefined) {
		expectUs(toUs(await input.computeDuration()), fixture.durationUs);
	}

	// The same lookups again, each on a fresh Input that hasn't read anything yet
	for (let i = 0; i < fixture.tracks.length; i++) {
		for (const [atUs, packetUs, keyPacketUs] of fixture.tracks[i]!.seeks ?? []) {
			using coldInput = openFixture(fixture);
			const sink = new EncodedPacketSink((await coldInput.getTracks())[i]!);
			expectUs(toUs((await sink.getPacket(atUs / 1e6))!.timestamp), packetUs);
			expectUs(toUs((await sink.getKeyPacket(atUs / 1e6))!.timestamp), keyPacketUs);
		}
	}
};

const FIXTURES: Fixture[] = [
	// ffmpeg -y $V $A $X264 $AAC $COMMON ffmpeg-mp4-default.mp4
	{
		file: 'ffmpeg-mp4-default.mp4',
		format: 'MP4',
		durationUs: 800000,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 0,
				lastUs: 760000, bytes: 2905,
				dataMd5: '028a80b2dfbff49a8dfbd04a7729a814',
				timestampsMd5: 'd2ebe9c8a282040cea7327ac10f4d665',
				seeks: [[401000, 400000, 400000], [10760000, 760000, 400000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: -21333,
				lastUs: 789333, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '1631188d326120c5ba20291403c01da9',
				seeks: [[385000, 384000, 384000], [10789333, 789333, 789333]],
			},
		],
	},
	// ffmpeg -y $V $A $X264 $AAC -movflags +faststart $COMMON ffmpeg-mp4-faststart.mp4
	{
		file: 'ffmpeg-mp4-faststart.mp4',
		format: 'MP4',
		durationUs: 800000,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 0,
				lastUs: 760000, bytes: 2905,
				dataMd5: '028a80b2dfbff49a8dfbd04a7729a814',
				timestampsMd5: 'd2ebe9c8a282040cea7327ac10f4d665',
				seeks: [[401000, 400000, 400000], [10760000, 760000, 400000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: -21333,
				lastUs: 789333, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '1631188d326120c5ba20291403c01da9',
				seeks: [[385000, 384000, 384000], [10789333, 789333, 789333]],
			},
		],
	},
	// ffmpeg -y $V $A $X264 $AAC -movflags +negative_cts_offsets $COMMON ffmpeg-mp4-negative-cts.mp4
	{
		file: 'ffmpeg-mp4-negative-cts.mp4',
		format: 'MP4',
		durationUs: 800000,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 0,
				lastUs: 760000, bytes: 2905,
				dataMd5: '028a80b2dfbff49a8dfbd04a7729a814',
				timestampsMd5: 'd2ebe9c8a282040cea7327ac10f4d665',
				seeks: [[401000, 400000, 400000], [10760000, 760000, 400000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: -21333,
				lastUs: 789333, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '1631188d326120c5ba20291403c01da9',
				seeks: [[385000, 384000, 384000], [10789333, 789333, 789333]],
			},
		],
	},
	// ffmpeg -y $V $A $X264 $AAC -use_editlist 0 $COMMON ffmpeg-mp4-no-editlist.mp4
	{
		file: 'ffmpeg-mp4-no-editlist.mp4',
		format: 'MP4',
		durationUs: 880000,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 80000,
				lastUs: 840000, bytes: 2905,
				dataMd5: '028a80b2dfbff49a8dfbd04a7729a814',
				timestampsMd5: 'fa40e01b77b02e3cb3e5edb42c47a1b1',
				seeks: [[481000, 480000, 480000], [10840000, 840000, 480000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: 0,
				lastUs: 869333, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '5fac15a83956f89b38d8009b96f905a5',
				seeks: [[465000, 464000, 464000], [10869333, 869333, 869333]],
			},
		],
	},
	// ffprobe gives the last AAC packet a full frame (1024 samples); the trun says 512, which is what we expect
	// ffmpeg -y $V $A $X264 $AAC -movflags +frag_keyframe+empty_moov $COMMON ffmpeg-mp4-frag-keyframe.mp4
	{
		file: 'ffmpeg-mp4-frag-keyframe.mp4',
		format: 'MP4',
		durationUs: 880000,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 80000,
				lastUs: 840000, bytes: 2905,
				dataMd5: '028a80b2dfbff49a8dfbd04a7729a814',
				timestampsMd5: 'fa40e01b77b02e3cb3e5edb42c47a1b1',
				seeks: [[481000, 480000, 480000], [10840000, 840000, 480000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: 0,
				lastUs: 869333, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '5fac15a83956f89b38d8009b96f905a5',
				seeks: [[465000, 464000, 464000], [10869333, 869333, 869333]],
			},
		],
	},
	// ffprobe gives the last AAC packet a full frame (1024 samples); the trun says 512, which is what we expect
	// ffmpeg -y $V $A $X264 $AAC -movflags +frag_every_frame+empty_moov+default_base_moof $COMMON
	//   ffmpeg-mp4-frag-every-frame.mp4
	{
		file: 'ffmpeg-mp4-frag-every-frame.mp4',
		format: 'MP4',
		durationUs: 880000,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 80000,
				lastUs: 800000, bytes: 2905,
				dataMd5: '028a80b2dfbff49a8dfbd04a7729a814',
				timestampsMd5: '43ba6a9c454a3f688d1a50919328bcff',
				seeks: [[481000, 480000, 480000], [10800000, 800000, 480000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: 0,
				lastUs: 869333, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '166d0fdcb9cebb4d47b2decd7fe83917',
				seeks: [[465000, 464000, 464000], [10869333, 869333, 869333]],
			},
		],
	},
	// ffprobe gives the last AAC packet a full frame (1024 samples); the trun says 512, which is what we expect
	// ffmpeg -y $V $A $X264 $AAC -movflags +frag_keyframe+empty_moov+separate_moof $COMMON
	//   ffmpeg-mp4-separate-moof.mp4
	{
		file: 'ffmpeg-mp4-separate-moof.mp4',
		format: 'MP4',
		durationUs: 880000,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 80000,
				lastUs: 840000, bytes: 2905,
				dataMd5: '028a80b2dfbff49a8dfbd04a7729a814',
				timestampsMd5: 'fa40e01b77b02e3cb3e5edb42c47a1b1',
				seeks: [[481000, 480000, 480000], [10840000, 840000, 480000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: 0,
				lastUs: 869333, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '5fac15a83956f89b38d8009b96f905a5',
				seeks: [[465000, 464000, 464000], [10869333, 869333, 869333]],
			},
		],
	},
	// ffprobe gives the last AAC packet a full frame (1024 samples); the trun says 512, which is what we expect
	// ffmpeg -y $V $A $X264 $AAC -movflags +frag_keyframe+empty_moov+omit_tfhd_offset $COMMON
	//   ffmpeg-mp4-omit-tfhd-offset.mp4
	{
		file: 'ffmpeg-mp4-omit-tfhd-offset.mp4',
		format: 'MP4',
		durationUs: 880000,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 80000,
				lastUs: 840000, bytes: 2905,
				dataMd5: '028a80b2dfbff49a8dfbd04a7729a814',
				timestampsMd5: 'fa40e01b77b02e3cb3e5edb42c47a1b1',
				seeks: [[481000, 480000, 480000], [10840000, 840000, 480000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: 0,
				lastUs: 869333, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '5fac15a83956f89b38d8009b96f905a5',
				seeks: [[465000, 464000, 464000], [10869333, 869333, 869333]],
			},
		],
	},
	// ffprobe gives the last AAC packet a full frame (1024 samples); the trun says 512, which is what we expect
	// ffmpeg -y $V $A $X264 $AAC -movflags +frag_keyframe+empty_moov+global_sidx+default_base_moof $COMMON
	//   ffmpeg-mp4-global-sidx.mp4
	{
		file: 'ffmpeg-mp4-global-sidx.mp4',
		format: 'MP4',
		durationUs: 880000,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 80000,
				lastUs: 840000, bytes: 2905,
				dataMd5: '028a80b2dfbff49a8dfbd04a7729a814',
				timestampsMd5: 'fa40e01b77b02e3cb3e5edb42c47a1b1',
				seeks: [[481000, 480000, 480000], [10840000, 840000, 480000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: 0,
				lastUs: 869333, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '5fac15a83956f89b38d8009b96f905a5',
				seeks: [[465000, 464000, 464000], [10869333, 869333, 869333]],
			},
		],
	},
	// No edit list, and trun version 1 puts the first frame at composition time 0. ffprobe shifts every video
	// timestamp by the largest negative offset (40 ms, its dts_shift); we expect the file's own times. The trun
	// also gives the last AAC packet 512 samples where ffprobe assumes 1024.
	// ffmpeg -y $V $A $X264 $AAC -movflags +cmaf $COMMON ffmpeg-mp4-cmaf.mp4
	{
		file: 'ffmpeg-mp4-cmaf.mp4',
		format: 'MP4',
		durationUs: 821333,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 0,
				lastUs: 760000, bytes: 2905,
				dataMd5: '028a80b2dfbff49a8dfbd04a7729a814',
				timestampsMd5: 'd2ebe9c8a282040cea7327ac10f4d665',
				seeks: [[401000, 400000, 400000], [10760000, 760000, 400000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: 0,
				lastUs: 810667, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: 'c6b4599c7db5c3dbd0f1a51b589b79cf',
				seeks: [[406333, 405333, 405333], [10810667, 810667, 810667]],
			},
		],
	},
	// ffprobe gives the last AAC packet a full frame (1024 samples); the trun says 512, which is what we expect
	// ffmpeg -y $V $A $X264 $AAC -movflags +frag_keyframe+empty_moov+delay_moov $COMMON ffmpeg-mp4-delay-moov.mp4
	{
		file: 'ffmpeg-mp4-delay-moov.mp4',
		format: 'MP4',
		durationUs: 800000,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 0,
				lastUs: 760000, bytes: 2905,
				dataMd5: '028a80b2dfbff49a8dfbd04a7729a814',
				timestampsMd5: 'd2ebe9c8a282040cea7327ac10f4d665',
				seeks: [[401000, 400000, 400000], [10760000, 760000, 400000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: -21333,
				lastUs: 789333, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '1631188d326120c5ba20291403c01da9',
				seeks: [[385000, 384000, 384000], [10789333, 789333, 789333]],
			},
		],
	},
	// ffprobe gives the last AAC packet a full frame (1024 samples); the trun says 512, which is what we expect
	// ffmpeg -y $V $A $X264 $AAC -movflags +empty_moov -frag_duration 200000 $COMMON ffmpeg-mp4-frag-duration.mp4
	{
		file: 'ffmpeg-mp4-frag-duration.mp4',
		format: 'MP4',
		durationUs: 880000,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 80000,
				lastUs: 840000, bytes: 2905,
				dataMd5: '028a80b2dfbff49a8dfbd04a7729a814',
				timestampsMd5: 'fa40e01b77b02e3cb3e5edb42c47a1b1',
				seeks: [[481000, 480000, 480000], [10840000, 840000, 480000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: 0,
				lastUs: 869333, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '5fac15a83956f89b38d8009b96f905a5',
				seeks: [[465000, 464000, 464000], [10869333, 869333, 869333]],
			},
		],
	},
	// ffmpeg -y $V $A $X264 $AAC -timecode 01:00:00:00 $COMMON ffmpeg-mov-timecode.mov
	{
		file: 'ffmpeg-mov-timecode.mov',
		format: 'QuickTime File Format',
		durationUs: 800000,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 0,
				lastUs: 760000, bytes: 2905,
				dataMd5: '028a80b2dfbff49a8dfbd04a7729a814',
				timestampsMd5: 'd2ebe9c8a282040cea7327ac10f4d665',
				seeks: [[401000, 400000, 400000], [10760000, 760000, 400000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: -21333,
				lastUs: 789333, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '1631188d326120c5ba20291403c01da9',
				seeks: [[385000, 384000, 384000], [10789333, 789333, 789333]],
			},
		],
	},
	// ffmpeg -y $V $A $X264_NO_B $AAC $COMMON ffmpeg-3gp.3gp
	{
		file: 'ffmpeg-3gp.3gp',
		format: 'MP4',
		durationUs: 800000,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 0,
				lastUs: 760000, bytes: 2822,
				dataMd5: 'b942a1e1b3da993aa55a2fcbbdd11312',
				timestampsMd5: 'ac613330a543f1c7a6ff6f73ac322801',
				seeks: [[401000, 400000, 400000], [10760000, 760000, 400000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: -21333,
				lastUs: 789333, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '1631188d326120c5ba20291403c01da9',
				seeks: [[385000, 384000, 384000], [10789333, 789333, 789333]],
			},
		],
	},
	// No duration check: the last block has no duration in the file (see bug-fix-mania REPORT, not fixed)
	// ffmpeg -y $V $A $X264 $AAC $COMMON ffmpeg-mkv-default.mkv
	{
		file: 'ffmpeg-mkv-default.mkv',
		format: 'Matroska',
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 0,
				lastUs: 760000, bytes: 2905,
				dataMd5: '028a80b2dfbff49a8dfbd04a7729a814',
				timestampsMd5: 'd2ebe9c8a282040cea7327ac10f4d665',
				seeks: [[401000, 400000, 400000], [10760000, 760000, 400000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: -21000,
				lastUs: 789000, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '128fca47ac0030aab7d49ff0e0ee80b7',
				seeks: [[385000, 384000, 384000], [10789000, 789000, 789000]],
			},
		],
	},
	// No duration check: the last block has no duration in the file (see bug-fix-mania REPORT, not fixed)
	// ffmpeg -y $V $A $X264_NO_B $AAC -cluster_time_limit 100 -cluster_size_limit 2000 $COMMON
	//   ffmpeg-mkv-small-clusters.mkv
	{
		file: 'ffmpeg-mkv-small-clusters.mkv',
		format: 'Matroska',
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 0,
				lastUs: 760000, bytes: 2822,
				dataMd5: 'b942a1e1b3da993aa55a2fcbbdd11312',
				timestampsMd5: 'ac613330a543f1c7a6ff6f73ac322801',
				seeks: [[401000, 400000, 400000], [10760000, 760000, 400000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: -21000,
				lastUs: 789000, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '128fca47ac0030aab7d49ff0e0ee80b7',
				seeks: [[385000, 384000, 384000], [10789000, 789000, 789000]],
			},
		],
	},
	// No duration check: the last block has no duration in the file (see bug-fix-mania REPORT, not fixed)
	// ffmpeg -y $V $A $X264_NO_B $AAC -live 1 $COMMON ffmpeg-mkv-live.mkv
	{
		file: 'ffmpeg-mkv-live.mkv',
		format: 'Matroska',
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2, firstUs: 0,
				lastUs: 760000, bytes: 2822,
				dataMd5: 'b942a1e1b3da993aa55a2fcbbdd11312',
				timestampsMd5: 'ac613330a543f1c7a6ff6f73ac322801',
				seeks: [[401000, 400000, 400000], [10760000, 760000, 400000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: -21000,
				lastUs: 789000, bytes: 3341,
				dataMd5: 'a1a7f9d66b10edeb20de5fc9e1a3b74a',
				timestampsMd5: '128fca47ac0030aab7d49ff0e0ee80b7',
				seeks: [[385000, 384000, 384000], [10789000, 789000, 789000]],
			},
		],
	},
	// No duration check: the last block has no duration in the file (see bug-fix-mania REPORT, not fixed)
	// ffmpeg -y $V $A -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -g 10 -c:a libopus -b:a 32k $COMMON
	//   ffmpeg-webm-vp9-opus.webm
	{
		file: 'ffmpeg-webm-vp9-opus.webm',
		format: 'WebM',
		tracks: [
			{
				type: 'video', codec: 'vp9', codecString: 'vp09.00.10.08.01.02.02.02.00', packets: 20,
				keyPackets: 2, firstUs: 0, lastUs: 760000, bytes: 3271,
				dataMd5: '4828407591e3b7e223aba2e177b33c0c',
				timestampsMd5: 'ac613330a543f1c7a6ff6f73ac322801',
				seeks: [[401000, 400000, 400000], [10760000, 760000, 400000]],
			},
			{
				type: 'audio', codec: 'opus', codecString: 'opus', packets: 41, keyPackets: 41, firstUs: -7000,
				lastUs: 794000, bytes: 3785,
				dataMd5: 'b6e615877c15dc33ebcb0b0ac1bfe80e',
				timestampsMd5: '10932b0e9ddb7ef678e2fc651f49446b',
				seeks: [[395000, 394000, 394000], [10794000, 794000, 794000]],
			},
		],
	},
	// No duration check: the last block has no duration in the file (see bug-fix-mania REPORT, not fixed)
	// ffmpeg -y $V $A44 -c:v libvpx -deadline realtime -cpu-used 8 -g 10 -c:a libvorbis -q:a 0 $COMMON
	//   ffmpeg-webm-vp8-vorbis.webm
	{
		file: 'ffmpeg-webm-vp8-vorbis.webm',
		format: 'WebM',
		tracks: [
			{
				type: 'video', codec: 'vp8', codecString: 'vp8', packets: 20, keyPackets: 2, firstUs: 3000,
				lastUs: 763000, bytes: 4227,
				dataMd5: 'fd44e560fbb0a3747ea9aa69ffc62025',
				timestampsMd5: 'd31d9511ea78ffad658af71b21e9a7a6',
				seeks: [[404000, 403000, 403000], [10763000, 763000, 403000]],
			},
			{
				type: 'audio', codec: 'vorbis', codecString: 'vorbis', packets: 36, keyPackets: 36, firstUs: 0,
				lastUs: 782000, bytes: 1162,
				dataMd5: '85889440a9b529d18fdc2e280e15f202',
				timestampsMd5: 'ea1af0ccce486f308a764491db180d5c',
				seeks: [[389000, 388000, 388000], [10782000, 782000, 782000]],
			},
		],
	},
	// ffmpeg -y $V $A $X264 $AAC $COMMON ffmpeg-ts-default.ts
	{
		file: 'ffmpeg-ts-default.ts',
		format: 'MPEG Transport Stream',
		durationUs: 2290666,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2,
				firstUs: 1480000, lastUs: 2240000, bytes: 3094,
				dataMd5: '048753873c816bfb9d327b78a9367bfa',
				timestampsMd5: 'df17cfd804fd03f627931435007599cc',
				seeks: [[1881000, 1880000, 1880000], [12240000, 2240000, 1880000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39,
				firstUs: 1458667, lastUs: 2269333, bytes: 3614,
				dataMd5: 'bf98cebcdfd57c51a0c43860c3d3d64d',
				timestampsMd5: '3fee2cb0099475c1c332073f4c3505e3',
				seeks: [[1865000, 1864000, 1864000], [12269333, 2269333, 2269333]],
			},
		],
	},
	// ffmpeg -y $V $A $X264 -c:a ac3 -b:a 96k -f mpegts -mpegts_m2ts_mode 1 $COMMON ffmpeg-m2ts.m2ts
	{
		file: 'ffmpeg-m2ts.m2ts',
		format: 'MPEG Transport Stream',
		durationUs: 2280000,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2,
				firstUs: 1480000, lastUs: 2240000, bytes: 3094,
				dataMd5: '048753873c816bfb9d327b78a9367bfa',
				timestampsMd5: 'df17cfd804fd03f627931435007599cc',
				seeks: [[1881000, 1880000, 1880000], [12240000, 2240000, 1880000]],
			},
			{
				type: 'audio', codec: 'ac3', codecString: 'ac-3', packets: 25, keyPackets: 25, firstUs: 1474667,
				lastUs: 2242667, bytes: 9600,
				dataMd5: 'd187bf9fdf238b54415c4e3409fc088e',
				timestampsMd5: '0fbc504a50eb923e8449559160f52c59',
				seeks: [[1859667, 1858667, 1858667], [12242667, 2242667, 2242667]],
			},
		],
	},
	// ffmpeg -y $V $A $X264 -map 0:v -map 1:a -map 1:a -c:a:0 libmp3lame -b:a:0 64k -c:a:1 ac3 -b:a:1 96k $COMMON
	//   ffmpeg-ts-mp3-ac3.ts
	{
		file: 'ffmpeg-ts-mp3-ac3.ts',
		format: 'MPEG Transport Stream',
		durationUs: 2296978,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2,
				firstUs: 1480000, lastUs: 2240000, bytes: 3094,
				dataMd5: '048753873c816bfb9d327b78a9367bfa',
				timestampsMd5: 'df17cfd804fd03f627931435007599cc',
				seeks: [[1881000, 1880000, 1880000], [12240000, 2240000, 1880000]],
			},
			{
				type: 'audio', codec: 'mp3', codecString: 'mp3', packets: 35, keyPackets: 35, firstUs: 1456978,
				lastUs: 2272978, bytes: 6720,
				dataMd5: 'c18144af3dd76dfbb18be5bf931b82b5',
				timestampsMd5: '5a85286046df781d37692ad477d5f737',
				seeks: [[1865978, 1864978, 1864978], [12272978, 2272978, 2272978]],
			},
			{
				type: 'audio', codec: 'ac3', codecString: 'ac-3', packets: 25, keyPackets: 25, firstUs: 1474667,
				lastUs: 2242667, bytes: 9600,
				dataMd5: 'd187bf9fdf238b54415c4e3409fc088e',
				timestampsMd5: '0fbc504a50eb923e8449559160f52c59',
				seeks: [[1859667, 1858667, 1858667], [12242667, 2242667, 2242667]],
			},
		],
	},
	// PAT, PMT and SDT repeat every ~20 ms (21 times each, instead of 8, 8 and 2 in ffmpeg-ts-default.ts), so tables
	// keep coming between the PES packets; the packets themselves are the same as in ffmpeg-ts-default.ts
	// ffmpeg -y $V $A $X264 $AAC -mpegts_flags +resend_headers -pat_period 0.02 -sdt_period 0.02 $COMMON
	//   ffmpeg-ts-resend-headers.ts
	{
		file: 'ffmpeg-ts-resend-headers.ts',
		format: 'MPEG Transport Stream',
		durationUs: 2290666,
		tracks: [
			{
				type: 'video', codec: 'avc', codecString: 'avc1.64000a', packets: 20, keyPackets: 2,
				firstUs: 1480000, lastUs: 2240000, bytes: 3094,
				dataMd5: '048753873c816bfb9d327b78a9367bfa',
				timestampsMd5: 'df17cfd804fd03f627931435007599cc',
				seeks: [[1881000, 1880000, 1880000], [12240000, 2240000, 1880000]],
			},
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39,
				firstUs: 1458667, lastUs: 2269333, bytes: 3614,
				dataMd5: 'bf98cebcdfd57c51a0c43860c3d3d64d',
				timestampsMd5: '3fee2cb0099475c1c332073f4c3505e3',
				seeks: [[1865000, 1864000, 1864000], [12269333, 2269333, 2269333]],
			},
		],
	},
	// ffmpeg -y $A $AAC -f adts $COMMON ffmpeg-adts.aac
	{
		file: 'ffmpeg-adts.aac',
		format: 'ADTS',
		durationUs: 832000,
		tracks: [
			{
				type: 'audio', codec: 'aac', codecString: 'mp4a.40.2', packets: 39, keyPackets: 39, firstUs: 0,
				lastUs: 810667, bytes: 3614,
				dataMd5: 'bf98cebcdfd57c51a0c43860c3d3d64d',
				timestampsMd5: 'c6b4599c7db5c3dbd0f1a51b589b79cf',
				seeks: [[406333, 405333, 405333], [10810667, 810667, 810667]],
			},
		],
	},
	// Gapless: the LAME tag's encoder delay (576 + 529 decoder delay = 1105 samples) puts the first frame at
	// -25.057 ms, where ffprobe starts at 0
	// ffmpeg -y $A44 -c:a libmp3lame -b:a 64k $COMMON ffmpeg-mp3-cbr.mp3
	{
		file: 'ffmpeg-mp3-cbr.mp3',
		format: 'MP3',
		durationUs: 810861,
		tracks: [
			{
				type: 'audio', codec: 'mp3', codecString: 'mp3', packets: 32, keyPackets: 32, firstUs: -25057,
				lastUs: 784739, bytes: 6687,
				dataMd5: '8b5ba9ea458efe477d7bd2a37e29d26d',
				timestampsMd5: 'bfde4cc38c1a649151929d9bc782ef54',
				seeks: [[393902, 392902, 392902], [10784739, 784739, 784739]],
			},
		],
	},
	// Same encoder delay as above
	// ffmpeg -y $A44 -c:a libmp3lame -q:a 4 $COMMON ffmpeg-mp3-vbr.mp3
	{
		file: 'ffmpeg-mp3-vbr.mp3',
		format: 'MP3',
		durationUs: 810861,
		tracks: [
			{
				type: 'audio', codec: 'mp3', codecString: 'mp3', packets: 32, keyPackets: 32, firstUs: -25057,
				lastUs: 784739, bytes: 4006,
				dataMd5: 'f2ba3d69fb9f89f3f78cbd6231c095f9',
				timestampsMd5: 'bfde4cc38c1a649151929d9bc782ef54',
				seeks: [[393902, 392902, 392902], [10784739, 784739, 784739]],
			},
		],
	},
	// ffmpeg -y $A -c:a libopus -b:a 32k $COMMON ffmpeg-ogg-opus.opus
	{
		file: 'ffmpeg-ogg-opus.opus',
		format: 'Ogg',
		durationUs: 800000,
		tracks: [
			{
				type: 'audio', codec: 'opus', codecString: 'opus', packets: 41, keyPackets: 41, firstUs: -6500,
				lastUs: 793500, bytes: 3785,
				dataMd5: 'b6e615877c15dc33ebcb0b0ac1bfe80e',
				timestampsMd5: '8a51f0fb338723c28f9df1ac2245a9af',
				seeks: [[394500, 393500, 393500], [10793500, 793500, 793500]],
			},
		],
	},
	// The first Vorbis packet decodes to nothing. ffprobe starts it at 0; we place it 128 samples earlier, so that
	// the first decoded sample is at 0 and the stream ends at the last granule position (0.8 s)
	// ffmpeg -y $A44 -c:a libvorbis -q:a 0 $COMMON ffmpeg-ogg-vorbis.ogg
	{
		file: 'ffmpeg-ogg-vorbis.ogg',
		format: 'Ogg',
		durationUs: 800000,
		tracks: [
			{
				type: 'audio', codec: 'vorbis', codecString: 'vorbis', packets: 36, keyPackets: 36, firstUs: -2902,
				lastUs: 779320, bytes: 1162,
				dataMd5: '85889440a9b529d18fdc2e280e15f202',
				timestampsMd5: '8757ff95c447d424f4da661a01b52378',
				seeks: [[385581, 384581, 384581], [10779320, 779320, 779320]],
			},
		],
	},
	// ffmpeg -y $A44 -c:a flac $COMMON ffmpeg-flac-16.flac
	{
		file: 'ffmpeg-flac-16.flac',
		format: 'FLAC',
		durationUs: 800000,
		tracks: [
			{
				type: 'audio', codec: 'flac', codecString: 'flac', packets: 8, keyPackets: 8, firstUs: 0,
				lastUs: 731429, bytes: 9615,
				dataMd5: 'f8e7e953785988c88bd6b41144da83b6',
				timestampsMd5: '34a9e234f6394a07ab42536875c26cde',
				seeks: [[418959, 417959, 417959], [10731429, 731429, 731429]],
			},
		],
	},
	// ffmpeg -y $A -c:a flac -sample_fmt s32 -bits_per_raw_sample 24 $COMMON ffmpeg-flac-24.flac
	{
		file: 'ffmpeg-flac-24.flac',
		format: 'FLAC',
		durationUs: 800000,
		tracks: [
			{
				type: 'audio', codec: 'flac', codecString: 'flac', packets: 9, keyPackets: 9, firstUs: 0,
				lastUs: 768000, bytes: 10593,
				dataMd5: 'f1fb9ef2627ed7d81e2e22ebe20c4403',
				timestampsMd5: '2988b70c4581394a5b5e86efd3716868',
				seeks: [[385000, 384000, 384000], [10768000, 768000, 768000]],
			},
		],
	},
	// PCM packet boundaries are arbitrary, so the whole payload and its time range are compared
	// ffmpeg -y $A -t 0.3 -ar 16000 -c:a pcm_s24le $COMMON ffmpeg-wav-s24.wav
	{
		file: 'ffmpeg-wav-s24.wav',
		format: 'WAVE',
		durationUs: 300000,
		tracks: [
			{
				type: 'audio', codec: 'pcm-s24', codecString: 'pcm-s24', bytes: 14400, firstUs: 0, endUs: 300000,
				pcmMd5: '768b0156ac23b2b73c723cd4a29c8640',
			},
		],
	},
	// PCM packet boundaries are arbitrary, so the whole payload and its time range are compared
	// ffmpeg -y $A -t 0.3 -ar 16000 -c:a pcm_f32le $COMMON ffmpeg-wav-f32.wav
	{
		file: 'ffmpeg-wav-f32.wav',
		format: 'WAVE',
		durationUs: 300000,
		tracks: [
			{
				type: 'audio', codec: 'pcm-f32', codecString: 'pcm-f32', bytes: 19200, firstUs: 0, endUs: 300000,
				pcmMd5: 'e156462a7a021479c3e09983c97b00e3',
			},
		],
	},
	// PCM packet boundaries are arbitrary, so the whole payload and its time range are compared
	// ffmpeg -y $A -ar 8000 -c:a pcm_alaw $COMMON ffmpeg-wav-alaw.wav
	{
		file: 'ffmpeg-wav-alaw.wav',
		format: 'WAVE',
		durationUs: 800000,
		tracks: [
			{
				type: 'audio', codec: 'alaw', codecString: 'alaw', bytes: 6400, firstUs: 0, endUs: 800000,
				pcmMd5: '6c97930ca808915615ccd914bf025dde',
			},
		],
	},
	// PCM packet boundaries are arbitrary, so the whole payload and its time range are compared
	// ffmpeg -y $A -ar 8000 -c:a pcm_mulaw $COMMON ffmpeg-wav-mulaw.wav
	{
		file: 'ffmpeg-wav-mulaw.wav',
		format: 'WAVE',
		durationUs: 800000,
		tracks: [
			{
				type: 'audio', codec: 'ulaw', codecString: 'ulaw', bytes: 6400, firstUs: 0, endUs: 800000,
				pcmMd5: '21012bfc163df1183848d78b489158bf',
			},
		],
	},
	// PCM packet boundaries are arbitrary, so the whole payload and its time range are compared
	// ffmpeg -y $A -t 0.3 -ac 6 -ar 8000 -c:a pcm_s16le $COMMON ffmpeg-wav-extensible-51.wav
	{
		file: 'ffmpeg-wav-extensible-51.wav',
		format: 'WAVE',
		durationUs: 300000,
		tracks: [
			{
				type: 'audio', codec: 'pcm-s16', codecString: 'pcm-s16', bytes: 28800, firstUs: 0, endUs: 300000,
				pcmMd5: '89b94499d41b0821471fa1ab757fb705',
			},
		],
	},
];

const GROUPS: [string, RegExp][] = [
	['MP4 and MOV written by FFmpeg', /\.(mp4|mov|3gp)$/],
	['Matroska and WebM written by FFmpeg', /\.(mkv|webm)$/],
	['MPEG-TS written by FFmpeg', /\.(ts|m2ts)$/],
	['Audio files written by FFmpeg', /\.(aac|mp3|opus|ogg|flac|wav)$/],
];

for (const [name, pattern] of GROUPS) {
	describe(name, () => {
		for (const fixture of FIXTURES.filter(fixture => pattern.test(fixture.file))) {
			test(`reads ${fixture.file} like ffprobe`, async () => {
				await expectFixture(fixture);
			});
		}
	});
}
