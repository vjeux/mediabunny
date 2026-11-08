/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { modEuclid } from '../misc';

export const MPEG_TS_TIMESCALE = 90_000; // MPEG-TS timestamps run on a 90 kHz clock
export const TIMESTAMP_MODULUS = 2 ** 33;
export const TS_PACKET_SIZE = 188;

export type TimestampWrapInfo = {
	reference: number;
	offset: number;
};

export const enum MpegTsStreamType {
	MP3_MPEG1 = 0x03,
	MP3_MPEG2 = 0x04,
	AAC = 0x0f,
	AC3_SYSTEM_A = 0x81,
	EAC3_SYSTEM_A = 0x87,
	DTS = 0x82,
	DTS_ATSC = 0x8a,
	BLU_RAY_DTS_HD = 0x85,
	BLU_RAY_DTS_HD_MASTER = 0x86,
	BLU_RAY_DTS_EXPRESS_SECONDARY = 0xa2,
	PRIVATE_DATA = 0x06,
	AVC = 0x1b,
	HEVC = 0x24,
}

export const buildMpegTsMimeType = (codecStrings: (string | null)[]) => {
	let string = 'video/MP2T';

	const uniqueCodecStrings = [...new Set(codecStrings.filter(Boolean))];
	if (uniqueCodecStrings.length > 0) {
		string += `; codecs="${uniqueCodecStrings.join(', ')}"`;
	}

	return string;
};

export const secondsToMpegTsTimestamp = (seconds: number) => {
	// This supports writing negative timestamps by simply Euclid-modding them. It is then up to the demuxer to
	// interpret them as negative, if it wants to.
	return modEuclid(Math.round(MPEG_TS_TIMESCALE * seconds), TIMESTAMP_MODULUS);
};

export const createTimestampWrapInfo = (firstTimestamp: number): TimestampWrapInfo => {
	const tolerance = 60 * MPEG_TS_TIMESCALE;
	return {
		reference: firstTimestamp - tolerance,
		offset: firstTimestamp >= TIMESTAMP_MODULUS - tolerance
			? -TIMESTAMP_MODULUS // Timestamps close to the modulus are treated as negative
			: TIMESTAMP_MODULUS,
	};
};

export const normalizeWrappedTimestamp = (timestamp: number, wrapInfo: TimestampWrapInfo) => {
	const { reference, offset } = wrapInfo;
	if (
		(offset < 0 && timestamp >= reference)
		|| (offset > 0 && timestamp < reference)
	) {
		return timestamp + offset;
	}

	return timestamp;
};

// CRC-32 for MPEG-TS (polynomial 0x04C11DB7, initial value 0xFFFFFFFF)
const MPEG_TS_CRC_POLYNOMIAL = 0x04c11db7;
const MPEG_TS_CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let crc = n << 24;

	for (let k = 0; k < 8; k++) {
		crc = (crc & 0x80000000)
			? ((crc << 1) ^ MPEG_TS_CRC_POLYNOMIAL)
			: (crc << 1);
	}

	MPEG_TS_CRC_TABLE[n] = (crc >>> 0) & 0xffffffff;
}

export const computeMpegTsCrc32 = (data: Uint8Array) => {
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < data.length; i++) {
		const byte = data[i]!;
		crc = ((crc << 8) ^ MPEG_TS_CRC_TABLE[(crc >>> 24) ^ byte]!) >>> 0;
	}
	return crc;
};
