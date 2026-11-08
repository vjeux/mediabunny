/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MP3_FRAME_HEADER_SIZE, getMp3ChannelCount, Mp3FrameHeader, readMp3FrameHeader } from '../../shared/mp3-misc';
import { isThenable } from '../misc';
import { readAscii, Reader, readU32, readU32Be } from '../reader';

export const readNextMp3FrameHeader = async (
	reader: Reader,
	startPos: number,
	until: number | null,
	ref: Mp3FrameHeader | null = null,
): Promise<{
	header: Mp3FrameHeader;
	startPos: number;
} | null> => {
	const CHUNK_SIZE = 2 ** 16; // So we don't need to grab thousands of slices
	let currentPos = startPos;

	while (until === null || currentPos < until) {
		const maxLength = until !== null
			? Math.min(CHUNK_SIZE, until - currentPos)
			: CHUNK_SIZE;

		let slice = reader.requestSliceRange(currentPos, MP3_FRAME_HEADER_SIZE, maxLength);
		if (isThenable(slice)) slice = await slice;
		if (!slice || slice.length < MP3_FRAME_HEADER_SIZE) break;

		while (slice.remainingLength >= MP3_FRAME_HEADER_SIZE) {
			const posBeforeRead = slice.filePos;
			const word = readU32Be(slice);
			const remainingBytes = reader.fileSize !== null
				? reader.fileSize - currentPos
				: null;

			const result = readMp3FrameHeader(word, remainingBytes);
			if (
				result.header
				&& (!ref || (
					// This condition helps us recover malformed streams
					// https://stackoverflow.com/a/20884944
					result.header.sampleRate === ref.sampleRate
					&& result.header.mpegVersionId === ref.mpegVersionId
					&& result.header.layer === ref.layer
					&& getMp3ChannelCount(result.header.channel) === getMp3ChannelCount(ref.channel)
				))
			) {
				return { header: result.header, startPos: currentPos };
			}

			slice.filePos = posBeforeRead + result.bytesAdvanced;
			currentPos = slice.filePos;
		}
	}

	return null;
};

/**
 * For MP3 in a WAVE file ("RIFF MP3"), finds the data chunk holding the frames, since the chunks around it aren't
 * audio. Returns null if the bytes at pos don't start a WAVE file.
 */
export const findWaveDataChunk = async (reader: Reader, pos: number) => {
	let slice = reader.requestSlice(pos, 12);
	if (isThenable(slice)) {
		slice = await slice;
	}
	if (!slice) {
		return null;
	}

	const riffType = readAscii(slice, 4);
	slice.skip(4);
	if ((riffType !== 'RIFF' && riffType !== 'RIFX' && riffType !== 'RF64') || readAscii(slice, 4) !== 'WAVE') {
		return null;
	}

	const littleEndian = riffType !== 'RIFX';
	let chunkPos = pos + 12;

	// Few chunks come before the data, so looking at a bounded number of them is enough
	for (let i = 0; i < 64; i++) {
		let chunkSlice = reader.requestSlice(chunkPos, 8);
		if (isThenable(chunkSlice)) {
			chunkSlice = await chunkSlice;
		}
		if (!chunkSlice) {
			return null;
		}

		const chunkId = readAscii(chunkSlice, 4);
		const chunkSize = readU32(chunkSlice, littleEndian);
		if (chunkId === 'data') {
			const start = chunkPos + 8;
			// RF64 keeps the real size elsewhere, and FFmpeg leaves sizes it can't fill in at 0xFFFFFFFF, so these run
			// to the end of the file
			const end = riffType === 'RF64' || chunkSize === 0xffffffff ? null : start + chunkSize;
			return { start, end };
		}

		chunkPos += 8 + chunkSize + (chunkSize & 1);
	}

	return null;
};
