/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	CustomAudioDecoder,
	AudioCodec,
	AudioSample,
	EncodedPacket,
	registerDecoder,
} from 'mediabunny';
import { sendCommand, refWorker, unrefWorker } from './worker-client';

class Ac3Decoder extends CustomAudioDecoder {
	private ctx = 0;

	static override supports(codec: AudioCodec): boolean {
		return codec === 'ac3' || codec === 'eac3';
	}

	async init() {
		await refWorker();

		const result = await sendCommand({
			type: 'init-decoder',
			data: { codec: this.codec },
		});
		this.ctx = result.ctx;
	}

	async decode(packet: EncodedPacket) {
		let timestamp = Math.round(packet.timestamp * this.config.sampleRate);

		// The decoder outputs one frame per call, but a packet can hold several syncframes (an MP4 sample of E-AC-3
		// with fewer than six blocks per syncframe does, ETSI TS 102 366 F.2). So, each independent syncframe is sent
		// on its own, together with the dependent substream syncframes following it.
		for (const unit of splitIntoDecodingUnits(packet.data)) {
			const encodedData = unit.slice().buffer;

			const result = await sendCommand({
				type: 'decode',
				data: { ctx: this.ctx, encodedData, timestamp },
			}, [encodedData]);

			const sample = new AudioSample({
				data: result.pcmData,
				format: result.format,
				numberOfChannels: result.channels,
				sampleRate: result.sampleRate,
				timestamp: result.pts / result.sampleRate,
			});
			this.onSample(sample);
			timestamp += result.sampleCount;
		}
	}

	async flush() {
		await sendCommand({ type: 'flush-decoder', data: { ctx: this.ctx } });
	}

	async close() {
		// Close shouldn't throw
		sendCommand({ type: 'close-decoder', data: { ctx: this.ctx } }).catch(() => {});
		await unrefWorker();
	}
}

const AC3_BIT_RATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];

/** Returns the size of the syncframe at the position and whether it starts a new decoding unit. */
const getSyncframeInfo = (data: Uint8Array, pos: number) => {
	if (pos + 6 > data.length || data[pos] !== 0x0b || data[pos + 1] !== 0x77) {
		return null;
	}

	const bsid = data[pos + 5]! >> 3;
	if (bsid <= 10) {
		// AC-3, ETSI TS 102 366 Table 4.13
		const fscod = data[pos + 4]! >> 6;
		const frmsizecod = data[pos + 4]! & 0x3f;
		const bitRate = AC3_BIT_RATES[frmsizecod >> 1];
		if (fscod === 3 || bitRate === undefined) {
			return null;
		}

		const words = fscod === 0
			? 2 * bitRate
			: fscod === 1
				? Math.floor(320 * bitRate / 147) + (frmsizecod & 1)
				: 3 * bitRate;
		return { size: 2 * words, startsUnit: true };
	}

	// E-AC-3, E.1.2. Dependent substreams (strmtyp 1) belong to the independent substream before them.
	const strmtyp = data[pos + 2]! >> 6;
	const substreamid = (data[pos + 2]! >> 3) & 0x7;
	const frmsiz = ((data[pos + 2]! & 0x7) << 8) | data[pos + 3]!;
	return { size: 2 * (frmsiz + 1), startsUnit: strmtyp !== 1 && substreamid === 0 };
};

const splitIntoDecodingUnits = (data: Uint8Array) => {
	const units: Uint8Array[] = [];
	let unitStart = 0;
	let pos = 0;

	while (pos < data.length) {
		const info = getSyncframeInfo(data, pos);
		if (!info) {
			// Not a run of whole syncframes, so leave it to the decoder
			return [data];
		}

		if (info.startsUnit && pos > unitStart) {
			units.push(data.subarray(unitStart, pos));
			unitStart = pos;
		}

		pos += info.size;
	}

	if (pos !== data.length) {
		return [data];
	}

	units.push(data.subarray(unitStart));
	return units;
};

let registered = false;

/**
 * Registers AC-3 and E-AC-3 decoders, which Mediabunny will then use automatically when applicable. Make sure to call
 * this function before starting any decoding task.
 *
 * @group \@mediabunny/ac3
 * @public
 */
export const registerAc3Decoder = () => {
	if (registered) {
		return;
	}
	registered = true;

	registerDecoder(Ac3Decoder);
};
