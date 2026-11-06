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
/** How many bytes from the start of a file are enough to work out its packet layout. */
export const TS_PACKET_LAYOUT_PROBE_SIZE = 1024;

export type TsPacketLayout = {
	/** The position of the first whole packet's sync byte. */
	offset: number;
	/** The distance between the sync bytes of consecutive packets. */
	stride: number;
};

/**
 * Determines the packet layout of a transport stream from its first bytes: plain 188-byte packets, 204-byte packets
 * (with forward error correction) or 192-byte packets (with a 4-byte prefix, like M2TS). Captures cut at an arbitrary
 * byte, or recordings with the recorder's own header in front, don't start with a whole packet; for those, the first
 * position where several consecutive packets line up is used, like FFmpeg resyncs.
 */
export const findTsPacketLayout = (bytes: Uint8Array): TsPacketLayout | null => {
	if (bytes[0] === 0x47 && bytes[TS_PACKET_SIZE] === 0x47) {
		// Regular MPEG-TS
		return { offset: 0, stride: TS_PACKET_SIZE };
	} else if (bytes[0] === 0x47 && bytes[TS_PACKET_SIZE + 16] === 0x47) {
		// MPEG-TS with Forward Error Correction
		return { offset: 0, stride: TS_PACKET_SIZE + 16 };
	} else if (bytes[4] === 0x47 && bytes[4 + TS_PACKET_SIZE + 4] === 0x47) {
		// MPEG-2-TS (DVHS)
		return { offset: 4, stride: TS_PACKET_SIZE + 4 };
	}

	// The file doesn't start with a whole packet. A stray 0x47 lining up by chance is likely enough with two packets,
	// so require more of them here.
	const REQUIRED_SYNC_BYTE_COUNT = 4;
	const strides = [TS_PACKET_SIZE, TS_PACKET_SIZE + 16, TS_PACKET_SIZE + 4];

	for (let offset = 0; offset < TS_PACKET_SIZE + 16; offset++) {
		for (const stride of strides) {
			if (offset + (REQUIRED_SYNC_BYTE_COUNT - 1) * stride >= bytes.length) {
				continue;
			}

			let linesUp = true;
			for (let i = 0; i < REQUIRED_SYNC_BYTE_COUNT; i++) {
				if (bytes[offset + i * stride] !== 0x47) {
					linesUp = false;
					break;
				}
			}

			if (linesUp) {
				return { offset, stride };
			}
		}
	}

	return null;
};

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
	BLU_RAY_EAC3 = 0x84,
	BLU_RAY_DTS_HD = 0x85,
	BLU_RAY_DTS_HD_MASTER = 0x86,
	BLU_RAY_EAC3_SECONDARY = 0xa1,
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
