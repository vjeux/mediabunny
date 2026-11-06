/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	getMp3ChannelCount,
	getXingOffset,
	INFO,
	MP3_FRAME_HEADER_SIZE,
	Mp3FrameHeader,
	readMp3FrameHeader,
	XING,
} from '../../shared/mp3-misc';
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
 * Finds the first MP3 frame from startPos on. Unlike readNextMp3FrameHeader, this skips false syncs, like the ones in
 * the middle of a frame when the data starts mid-stream: a frame header only counts if its frame holds a Xing/Info
 * tag, or if frame headers with the same MPEG version, layer and sample rate follow it.
 */
export const readFirstMp3FrameHeader = async (
	reader: Reader,
	startPos: number,
	until: number | null,
) => {
	let currentPos = startPos;
	// Once we've skipped over something, demand a longer run of frames (like FFmpeg's probe does) that also spans more
	// than two MPEG-TS packets, so we don't mistake the MP3 frames inside another container (like the small frames
	// of low-bitrate audio within a single 184-byte TS payload) for an MP3 file
	let requiredFollowingFrames = 1;
	let requiredRunLength = 0;

	while (true) {
		const result = await readNextMp3FrameHeader(reader, currentPos, until);
		if (!result) {
			return null;
		}

		const firstHeader = result.header;

		let slice = reader.requestSlice(
			result.startPos + getXingOffset(firstHeader.mpegVersionId, firstHeader.channel),
			4,
		);
		if (isThenable(slice)) slice = await slice;
		if (slice) {
			const word = readU32Be(slice);
			if (word === XING || word === INFO) {
				return result;
			}
		}

		let nextPos = result.startPos + firstHeader.totalSize;
		let followingFrames = 0;
		const runIsLongEnough = () => followingFrames >= requiredFollowingFrames
			&& nextPos - result.startPos >= requiredRunLength;

		while (!runIsLongEnough() && nextPos !== reader.fileSize) {
			slice = reader.requestSlice(nextPos, MP3_FRAME_HEADER_SIZE);
			if (isThenable(slice)) slice = await slice;
			if (!slice) {
				break;
			}

			const header = readMp3FrameHeader(readU32Be(slice), null).header;
			if (
				!header
				|| header.mpegVersionId !== firstHeader.mpegVersionId
				|| header.layer !== firstHeader.layer
				|| header.sampleRate !== firstHeader.sampleRate
				// The channel mode may change from one frame to the next, so it doesn't need to match
			) {
				break;
			}

			followingFrames++;
			nextPos += header.totalSize;
		}

		// A first frame whose run ends with the file is fine too (like a file with a single frame)
		if (runIsLongEnough() || (requiredRunLength === 0 && nextPos === reader.fileSize)) {
			return result;
		}

		currentPos = result.startPos + 1;
		requiredFollowingFrames = 3;
		requiredRunLength = 2 * 204 + 1; // Longest TS packets (with FEC)
	}
};
