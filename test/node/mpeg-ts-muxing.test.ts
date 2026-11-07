import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

/** Reads the PMT's PCR_PID and streams, the PCRs, and the PES timestamps of a transport stream, in file order. */
const readTransportStream = (data: Uint8Array) => {
	let pcrPid: number | null = null;
	const esPids = new Set<number>();
	const events: ({ type: 'pcr'; value: number } | { type: 'pes'; pid: number; pts: number; dts: number })[] = [];
	let mediaBeforeFirstPcr = false;
	let continuityErrors = 0;
	const lastCounters = new Map<number, number>();

	const readTimestamp = (pos: number) => ((data[pos]! >> 1) & 0x07) * 2 ** 30
		+ (((data[pos + 1]! << 8) | data[pos + 2]!) >> 1) * 2 ** 15
		+ (((data[pos + 3]! << 8) | data[pos + 4]!) >> 1);

	for (let pos = 0; pos + 188 <= data.length; pos += 188) {
		const pid = ((data[pos + 1]! & 0x1f) << 8) | data[pos + 2]!;
		const hasAdaptationField = (data[pos + 3]! & 0x20) !== 0;
		const hasPayload = (data[pos + 3]! & 0x10) !== 0;
		const payloadStart = pos + 4 + (hasAdaptationField ? 1 + data[pos + 4]! : 0);

		// A packet without payload repeats the counter of the previous one, a packet with payload increments it
		const counter = data[pos + 3]! & 0x0f;
		const lastCounter = lastCounters.get(pid);
		if (lastCounter !== undefined && counter !== (hasPayload ? (lastCounter + 1) & 0x0f : lastCounter)) {
			continuityErrors++;
		}
		lastCounters.set(pid, counter);

		if (pid === 0x1000 && data[pos + 1]! & 0x40) {
			const section = payloadStart + 1 + data[payloadStart]!; // After the pointer_field
			pcrPid = ((data[section + 8]! & 0x1f) << 8) | data[section + 9]!;
			const sectionEnd = section + 3 + (((data[section + 1]! & 0x0f) << 8) | data[section + 2]!) - 4;
			let entry = section + 12 + (((data[section + 10]! & 0x0f) << 8) | data[section + 11]!);
			while (entry < sectionEnd) {
				esPids.add(((data[entry + 1]! & 0x1f) << 8) | data[entry + 2]!);
				entry += 5 + (((data[entry + 3]! & 0x0f) << 8) | data[entry + 4]!);
			}
			continue;
		}

		if (pid === pcrPid && hasAdaptationField && data[pos + 4]! > 0 && data[pos + 5]! & 0x10) {
			// program_clock_reference_base (33 bits)
			const base = pos + 6;
			events.push({
				type: 'pcr',
				value: data[base]! * 2 ** 25 + data[base + 1]! * 2 ** 17 + data[base + 2]! * 2 ** 9
					+ data[base + 3]! * 2 + (data[base + 4]! >> 7),
			});
		}

		if (esPids.has(pid) && hasPayload) {
			if (!events.some(x => x.type === 'pcr')) {
				mediaBeforeFirstPcr = true;
			}

			if (data[pos + 1]! & 0x40) {
				const pts = readTimestamp(payloadStart + 9);
				const dts = (data[payloadStart + 7]! & 0x40) ? readTimestamp(payloadStart + 14) : pts;
				events.push({ type: 'pes', pid, pts, dts });
			}
		}
	}

	return { pcrPid, esPids, events, mediaBeforeFirstPcr, continuityErrors };
};

test('MPEG-TS output carries PCRs on the PMT\'s PCR_PID before and between media data', async () => {
	// Found by L74. 5 fps video and 50 Hz audio, so that PCRs are needed between the video frames, then video with
	// B-frames (two GOPs in decode order), whose frames go out after audio presented before them
	const avc = new Uint8Array([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x10]);
	const adts = new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0x01, 0x3f, 0xfc, 0x21, 0x00]);
	const videoDecoderConfig = { codec: 'avc1.42001f', codedWidth: 64, codedHeight: 64 };
	const audioDecoderConfig = { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000 };
	const bFrameOrder = [0, 3, 1, 2, 6, 4, 5, 7, 10, 8, 9];

	for (const hasBFrames of [false, true]) {
		const output = new Output({
			format: new MpegTsOutputFormat({ timestampOffset: 1 }),
			target: new BufferTarget(),
		});
		const videoSource = new EncodedVideoPacketSource('avc');
		const audioSource = new EncodedAudioPacketSource('aac');
		output.addVideoTrack(videoSource);
		output.addAudioTrack(audioSource);
		await output.start();

		if (hasBFrames) {
			for (const [i, frame] of bFrameOrder.entries()) {
				const isKey = i === 0 || i === 7;
				const packet = new EncodedPacket(avc, isKey ? 'key' : 'delta', frame / 25, 1 / 25);
				await videoSource.add(packet, i === 0 ? { decoderConfig: videoDecoderConfig } : undefined);
			}
			for (let i = 0; i < 22; i++) {
				const packet = new EncodedPacket(adts, 'key', i / 50, 0.02);
				await audioSource.add(packet, i === 0 ? { decoderConfig: audioDecoderConfig } : undefined);
			}
		} else {
			for (let i = 0; i < 500; i++) {
				if (i % 10 === 0) {
					// 5 fps, frames 200 ms apart
					const packet = new EncodedPacket(avc, i % 100 === 0 ? 'key' : 'delta', i / 50, 0.2);
					await videoSource.add(packet, i === 0 ? { decoderConfig: videoDecoderConfig } : undefined);
				}

				const packet = new EncodedPacket(adts, 'key', i / 50, 0.02);
				await audioSource.add(packet, i === 0 ? { decoderConfig: audioDecoderConfig } : undefined);
			}
		}

		await output.finalize();

		const { pcrPid, esPids, events, mediaBeforeFirstPcr, continuityErrors } = readTransportStream(
			new Uint8Array(output.target.buffer!),
		);
		expect(esPids.size).toBe(2);
		expect(pcrPid).toBe(0x100); // The video track's
		expect(esPids.has(pcrPid!)).toBe(true);
		expect(mediaBeforeFirstPcr).toBe(false); // W3C MSE MPEG-2 TS byte stream format, section 5
		expect(continuityErrors).toBe(0);

		const pcrs = events.filter(x => x.type === 'pcr').map(x => x.value);
		expect(pcrs.length).toBeGreaterThan(0);
		for (let i = 1; i < pcrs.length; i++) {
			expect(pcrs[i]! - pcrs[i - 1]!).toBeGreaterThanOrEqual(0);
			expect(pcrs[i]! - pcrs[i - 1]!).toBeLessThanOrEqual(0.1 * 90000); // H.222.0 2.7.2
		}

		// The data of every PES packet arrives (by the last PCR before it) before its decode time
		let lastPcr = -Infinity;
		for (const event of events) {
			if (event.type === 'pcr') {
				lastPcr = event.value;
			} else {
				expect(lastPcr).toBeLessThanOrEqual(event.dts);
			}
		}
	}
});
