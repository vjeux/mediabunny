/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MP3_FRAME_HEADER_SIZE, getMp3ChannelCount, Mp3FrameHeader, readMp3FrameHeader } from '../../shared/mp3-misc';
import { isThenable } from '../misc';
import { Reader, readU32Be } from '../reader';

export const readNextMp3FrameHeader = async (
	reader: Reader,
	startPos: number,
	until: number | null,
	ref: Mp3FrameHeader | null = null,
): Promise<{
	header: Mp3FrameHeader;
	startPos: number;
} | null> => {
	// The header is usually right at startPos, so start small and only grow the chunks when we need to search for it;
	// large chunks are there so we don't need to grab thousands of slices
	const MAX_CHUNK_SIZE = 2 ** 16;
	let chunkSize = 2 ** 8;
	let currentPos = startPos;

	while (until === null || currentPos < until) {
		const maxLength = until !== null
			? Math.min(chunkSize, until - currentPos)
			: chunkSize;
		chunkSize = Math.min(2 * chunkSize, MAX_CHUNK_SIZE);

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
				if (reader.fileSize === null) {
					// Unsized sources learn their size only once a read goes past their end, which the small slices
					// above may not do, so make sure the frame isn't cut off by the end of the file before taking it
					let frameSlice = reader.requestSlice(currentPos, result.header.totalSize);
					if (isThenable(frameSlice)) {
						frameSlice = await frameSlice;
					}

					if (!frameSlice) {
						if (reader.fileSize === null) {
							return null;
						}

						// Now that the file size is known, look at this position again
						slice.filePos = posBeforeRead;
						continue;
					}
				}

				return { header: result.header, startPos: currentPos };
			}

			slice.filePos = posBeforeRead + result.bytesAdvanced;
			currentPos = slice.filePos;
		}
	}

	return null;
};
