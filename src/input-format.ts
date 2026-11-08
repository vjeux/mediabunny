/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from './demuxer';
import { Input } from './input';
import { IsobmffDemuxer } from './isobmff/isobmff-demuxer';
import type { PsshBox } from './isobmff/isobmff-misc';
import {
	EBMLId,
	MAX_HEADER_SIZE,
	MIN_HEADER_SIZE,
	readAsciiString,
	readElementHeader,
	readElementSize,
	readUnsignedInt,
	readVarIntSize,
} from './matroska/ebml';
import { MatroskaDemuxer } from './matroska/matroska-demuxer';
import { Mp3Demuxer } from './mp3/mp3-demuxer';
import { ID3_V2_HEADER_SIZE, readId3V2Header } from './id3';
import { readFirstMp3FrameHeader } from './mp3/mp3-reader';
import { OggDemuxer } from './ogg/ogg-demuxer';
import { WaveDemuxer } from './wave/wave-demuxer';
import { MAX_ADTS_FRAME_HEADER_SIZE, MIN_ADTS_FRAME_HEADER_SIZE, readAdtsFrameHeader } from './adts/adts-reader';
import { AdtsDemuxer } from './adts/adts-demuxer';
import { readAscii, readBytes, Reader, readU32Be, readU64Be } from './reader';
import { FlacDemuxer } from './flac/flac-demuxer';
import { MpegTsDemuxer } from './mpeg-ts/mpeg-ts-demuxer';
import { findTsPacketLayout, TS_PACKET_LAYOUT_PROBE_SIZE, TS_PACKET_SIZE } from './mpeg-ts/mpeg-ts-misc';
import { HlsDemuxer } from './hls/hls-demuxer';
import { HLS_MIME_TYPE } from './hls/hls-misc';
import { PathedSource } from './source';
import { isThenable, MaybePromise, toDataView } from './misc';

/**
 * Base class representing an input media file format.
 * @group Input formats
 * @public
 */
export abstract class InputFormat {
	/** @internal */
	abstract _canReadInput(input: Input): Promise<boolean>;

	/** @internal */
	abstract _createDemuxer(input: Input): Demuxer;

	/** Returns the name of the input format. */
	abstract get name(): string;
	/** Returns the typical base MIME type of the input format. */
	abstract get mimeType(): string;
	/**
	 * Whether this input format's tracks store timestamped media data. When `true`, the timestamps of read packets
	 * come from the file, allowing things like gaps in media data or non-zero start times. When `false`, the format's
	 * media data implicitly starts at zero and follows an implicit sequential timing from there, using the intrinsic
	 * durations of the media data.
	 */
	abstract get supportsTimestampedMediaData(): boolean;

	/**
	 * Provided for tree-shakable checking.
	 * @internal
	 */
	_isIsobmff = false;
}

/**
 * Format representing files compatible with the ISO base media file format (ISOBMFF), like MP4 or MOV files.
 *
 * This format can make use of {@link InputOptions.initInput}. When the file contents are fragmented but no track
 * initialization info is provided (no `moov` atom), then it must be provided via `initInput`.
 *
 * @group Input formats
 * @public
 */
export abstract class IsobmffInputFormat extends InputFormat {
	/** @internal */
	protected async _getMajorBrand(input: Input) {
		let slice = input._reader.requestSlice(0, 12);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return null;

		slice.skip(4);
		const fourCc = readAscii(slice, 4);

		if (
			fourCc !== 'ftyp'
			&& fourCc !== 'styp' // Segment
		) {
			return null;
		}

		return readAscii(slice, 4);
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new IsobmffDemuxer(input);
	}

	get supportsTimestampedMediaData() {
		return true;
	}

	/** @internal */
	override _isIsobmff = true;
}

/**
 * MPEG-4 Part 14 (MP4) file format.
 *
 * Do not instantiate this class; use the {@link MP4} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class Mp4InputFormat extends IsobmffInputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		const majorBrand = await this._getMajorBrand(input);
		if (majorBrand !== null) {
			return majorBrand !== 'qt  ';
		}

		let pos = 0;
		for (let iter = 0; iter < 10; iter++) { // Bounded loop
			let slice = input._reader.requestSlice(pos, 8);
			if (isThenable(slice)) slice = await slice;
			if (!slice) return false;

			let size = readU32Be(slice);
			let headerSize = 8;
			if (size === 1) {
				let sizeExtensionSlice = input._reader.requestSlice(pos + 8, 8);
				if (isThenable(sizeExtensionSlice)) sizeExtensionSlice = await sizeExtensionSlice;
				if (!sizeExtensionSlice) return false;

				size = readU64Be(sizeExtensionSlice);
				headerSize = 16;
			}

			if (size < headerSize) {
				return false; // Hardly a box is it
			}

			const fourCc = readAscii(slice, 4);
			if (fourCc === 'moof' || fourCc === 'sidx') { // Seen in HLS for example
				return true;
			} else if (fourCc === 'emsg' || fourCc === 'prft' || fourCc === 'free') {
				// These are boxes that can appear before the first moof in DASH Media Segments. They're a strong signal
				// that this is indeed an fMP4 segment, but just to be sure, let's walk the box structure to make sure
				// it stays sane.
				pos += size;
			} else {
				return false;
			}
		}

		return false;
	}

	get name() {
		return 'MP4';
	}

	get mimeType() {
		return 'video/mp4';
	}
}

/**
 * QuickTime File Format (QTFF), often called MOV.
 *
 * Do not instantiate this class; use the {@link QTFF} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class QuickTimeInputFormat extends IsobmffInputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		const majorBrand = await this._getMajorBrand(input);
		return majorBrand === 'qt  ';
	}

	get name() {
		return 'QuickTime File Format';
	}

	get mimeType() {
		return 'video/quicktime';
	}
}

/**
 * Matroska file format.
 *
 * Do not instantiate this class; use the {@link MATROSKA} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class MatroskaInputFormat extends InputFormat {
	/** @internal */
	protected async isSupportedEBMLOfDocType(input: Input, desiredDocType: string) {
		let headerSlice = input._reader.requestSlice(0, MAX_HEADER_SIZE);
		if (isThenable(headerSlice)) headerSlice = await headerSlice;
		if (!headerSlice) return false;

		const varIntSize = readVarIntSize(headerSlice);
		if (varIntSize === null) {
			return false;
		}

		if (varIntSize < 1 || varIntSize > 8) {
			return false;
		}

		const id = readUnsignedInt(headerSlice, varIntSize);
		if (id !== EBMLId.EBML) {
			return false;
		}

		const dataSize = readElementSize(headerSlice);
		if (typeof dataSize !== 'number') {
			return false; // Miss me with that shit
		}

		let dataSlice = input._reader.requestSlice(headerSlice.filePos, dataSize);
		if (isThenable(dataSlice)) dataSlice = await dataSlice;
		if (!dataSlice) return false;

		const startPos = headerSlice.filePos;

		while (dataSlice.filePos <= startPos + dataSize - MIN_HEADER_SIZE) {
			const header = readElementHeader(dataSlice);
			if (!header) break;

			const { id, size } = header;
			const dataStartPos = dataSlice.filePos;
			if (size === undefined) return false;

			const isInteger = id === EBMLId.EBMLVersion
				|| id === EBMLId.EBMLReadVersion
				|| id === EBMLId.DocTypeVersion;
			if (dataStartPos + size > startPos + dataSize || (isInteger && size > 8)) {
				return false; // The element overruns the header or is an integer of impossible size
			}

			// Whether we can read the file is decided by the read versions alone: EBMLVersion and DocTypeVersion may
			// be higher, since newer elements are skipped (RFC 8794, Section 11.2.3; RFC 9559, Section 7)
			switch (id) {
				case EBMLId.EBMLReadVersion: {
					const ebmlReadVersion = readUnsignedInt(dataSlice, size);
					if (ebmlReadVersion !== 1) {
						return false;
					}
				}; break;
				case EBMLId.DocType: {
					const docType = readAsciiString(dataSlice, size);
					if (docType !== desiredDocType) {
						return false;
					}
				}; break;
				case EBMLId.DocTypeReadVersion: {
					const docTypeReadVersion = readUnsignedInt(dataSlice, size);
					if (docTypeReadVersion > 4) { // Support up to Matroska v4
						return false;
					}
				}; break;
			}

			dataSlice.filePos = dataStartPos + size;
		}

		return true;
	}

	/** @internal */
	_canReadInput(input: Input) {
		return this.isSupportedEBMLOfDocType(input, 'matroska');
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new MatroskaDemuxer(input);
	}

	get name() {
		return 'Matroska';
	}

	get mimeType() {
		return 'video/x-matroska';
	}

	get supportsTimestampedMediaData() {
		return true;
	}
}

/**
 * WebM file format, based on Matroska.
 *
 * Do not instantiate this class; use the {@link WEBM} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class WebMInputFormat extends MatroskaInputFormat {
	/** @internal */
	override _canReadInput(input: Input) {
		return this.isSupportedEBMLOfDocType(input, 'webm');
	}

	override get name() {
		return 'WebM';
	}

	override get mimeType() {
		return 'video/webm';
	}
}

/** Whether the bytes are the start of an MPEG-1 or MPEG-2 program stream pack header. */
const isMpegPackHeader = (bytes: Uint8Array) => bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01
	&& bytes[3] === 0xba
	&& ((bytes[4]! & 0xf0) === 0x20 || (bytes[4]! & 0xc0) === 0x40); // MPEG-1 or MPEG-2 marker bits

/**
 * Returns the position of the first non-zero byte at or after `pos`, looking at most `maxLength` bytes ahead (and
 * returning the position where it stopped if there's none).
 */
const skipZeroBytes = async (reader: Reader, pos: number, maxLength: number) => {
	const end = pos + maxLength;

	while (pos < end) {
		let slice = reader.requestSliceRange(pos, 1, Math.min(2 ** 16, end - pos));
		if (isThenable(slice)) {
			slice = await slice;
		}
		if (!slice || slice.length === 0) {
			break;
		}

		const bytes = readBytes(slice, slice.length);
		const index = bytes.findIndex(x => x !== 0);
		if (index !== -1) {
			return pos + index;
		}

		pos += bytes.length;
	}

	return pos;
};

const ISOBMFF_LEADING_BOX_TYPES = ['ftyp', 'styp', 'moov', 'mdat', 'moof', 'sidx', 'free', 'skip', 'wide', 'pnot'];

// How many MPEG-TS packets must start with a sync byte (fewer if the file is shorter), so that MP3 data that just
// happens to hold 0x47 at a couple of packet starts isn't taken for MPEG-TS
const MPEG_TS_SIGNATURE_PACKET_COUNT = 5;
const MPEG_TS_SIGNATURE_LENGTH = 4 + MPEG_TS_SIGNATURE_PACKET_COUNT * (TS_PACKET_SIZE + 16);

const startsWithMpegTsPackets = (bytes: Uint8Array, offset: number, packetSize: number) => {
	let packetCount = 0;
	for (
		let pos = offset;
		pos < bytes.length && packetCount < MPEG_TS_SIGNATURE_PACKET_COUNT;
		pos += packetSize, packetCount++
	) {
		if (bytes[pos] !== 0x47) {
			return false;
		}
	}

	return packetCount >= 2;
};

/**
 * Whether the bytes start like an ISOBMFF/QuickTime, Matroska, Ogg, FLAC or MPEG-TS file. RIFF files aren't included:
 * some hold a plain MP3 stream (RIFF MP3, MP3 in WAVE), which reads fine as MP3.
 */
const startsWithOtherContainerSignature = (bytes: Uint8Array) => {
	const view = toDataView(bytes);
	const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));

	if (bytes.length >= 8 && view.getUint32(0) >= 8 && ISOBMFF_LEADING_BOX_TYPES.includes(ascii(4, 4))) {
		return true;
	}
	if (bytes.length >= 4 && view.getUint32(0) === EBMLId.EBML) {
		return true;
	}
	if (['OggS', 'fLaC'].includes(ascii(0, 4))) {
		return true;
	}

	// The packet layouts MPEG-TS detection checks: plain, with FEC, and with 4-byte timestamps (M2TS)
	return startsWithMpegTsPackets(bytes, 0, TS_PACKET_SIZE)
		|| startsWithMpegTsPackets(bytes, 0, TS_PACKET_SIZE + 16)
		|| startsWithMpegTsPackets(bytes, 4, TS_PACKET_SIZE + 4);
};

/**
 * MP3 file format.
 *
 * Do not instantiate this class; use the {@link MP3} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class Mp3InputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		let currentPos = 0;

		while (true) {
			let slice = input._reader.requestSlice(currentPos, ID3_V2_HEADER_SIZE);
			if (isThenable(slice)) slice = await slice;
			if (!slice) break;

			const id3V2Header = readId3V2Header(slice);
			if (!id3V2Header) {
				break;
			}

			currentPos = slice.filePos + id3V2Header.size;
		}

		// Frame syncs are easily found in the data of other containers (in their sample tables, say), so a file that
		// starts like one of them isn't taken for MP3, even when that format isn't among the input's formats
		let signatureSlice = input._reader.requestSliceRange(currentPos, 0, MPEG_TS_SIGNATURE_LENGTH);
		if (isThenable(signatureSlice)) {
			signatureSlice = await signatureSlice;
		}
		if (signatureSlice && startsWithOtherContainerSignature(readBytes(signatureSlice, signatureSlice.length))) {
			return false;
		}

		// MPEG program streams (like VOB files) hold runs of MPEG audio frames in their packets, which the search below
		// would find. They start with a pack header, which an MP3 file doesn't.
		let packHeaderSlice = input._reader.requestSlice(currentPos, 5);
		if (isThenable(packHeaderSlice)) {
			packHeaderSlice = await packHeaderSlice;
		}
		if (packHeaderSlice && isMpegPackHeader(readBytes(packHeaderSlice, 5))) {
			return false;
		}

		// Skip a run of zero bytes before the first frame, as found in files whose ID3v2 tag was stripped by zeroing it
		// out in place. Zeros can't form a frame header; FFmpeg's mp3_read_probe skips them the same way.
		currentPos = await skipZeroBytes(input._reader, currentPos, 2 ** 20);

		// A Xing tag or two matching consecutive frames are a strong indicator that this is an MP3 file
		const firstResult = await readFirstMp3FrameHeader(input._reader, currentPos, currentPos + 4096);
		return firstResult !== null;
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new Mp3Demuxer(input);
	}

	get name() {
		return 'MP3';
	}

	get mimeType() {
		return 'audio/mpeg';
	}

	get supportsTimestampedMediaData() {
		return false;
	}
}

/**
 * Format tags of MPEG audio in WAVE ("RIFF MP3", as written by Windows' ACM codecs or FFmpeg): layers I and II, and
 * layer III. The data chunk of such a file holds a plain MPEG audio stream.
 */
const WAVE_MPEG_AUDIO_FORMAT_TAGS = [0x0050, 0x0055];

/** Reads the format tag in the "fmt " chunk of a WAVE file, or returns null if no such chunk precedes the data. */
const readWaveFormatTag = async (input: Input, littleEndian: boolean) => {
	let pos = 12;

	// Few chunks come before the data, so looking at a bounded number of them is enough
	for (let i = 0; i < 64; i++) {
		let slice = input._reader.requestSlice(pos, 10);
		if (isThenable(slice)) {
			slice = await slice;
		}
		if (!slice) {
			return null;
		}

		const chunkId = readAscii(slice, 4);
		const bytes = readBytes(slice, 6);
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const chunkSize = view.getUint32(0, littleEndian);

		if (chunkId === 'fmt ') {
			return view.getUint16(4, littleEndian);
		} else if (chunkId === 'data') {
			return null;
		}

		pos += 8 + chunkSize + (chunkSize & 1);
	}

	return null;
};

/**
 * WAVE file format, based on RIFF.
 *
 * Do not instantiate this class; use the {@link WAVE} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class WaveInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		let currentPos = 0;

		// Some taggers put ID3v2 tags in front of any file, even though they don't belong in RIFF. Skip them, like
		// FFmpeg does.
		while (true) {
			let slice = input._reader.requestSlice(currentPos, ID3_V2_HEADER_SIZE);
			if (isThenable(slice)) {
				slice = await slice;
			}
			if (!slice) {
				break;
			}

			const id3V2Header = readId3V2Header(slice);
			if (!id3V2Header) {
				break;
			}

			currentPos = slice.filePos + id3V2Header.size;
		}

		let slice = input._reader.requestSlice(currentPos, 12);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return false;

		const riffType = readAscii(slice, 4);
		if (riffType !== 'RIFF' && riffType !== 'RIFX' && riffType !== 'RF64') {
			return false;
		}

		slice.skip(4);

		const format = readAscii(slice, 4);
		if (format !== 'WAVE') {
			return false;
		}

		// MPEG audio in WAVE is left to the MP3 format, which reads the plain MPEG audio stream in the data chunk; the
		// WAVE demuxer doesn't support it
		const formatTag = await readWaveFormatTag(input, riffType !== 'RIFX');
		return formatTag === null || !WAVE_MPEG_AUDIO_FORMAT_TAGS.includes(formatTag);
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new WaveDemuxer(input);
	}

	get name() {
		return 'WAVE';
	}

	get mimeType() {
		return 'audio/wav';
	}

	get supportsTimestampedMediaData() {
		return false;
	}
}

/**
 * Ogg file format.
 *
 * Do not instantiate this class; use the {@link OGG} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class OggInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		let currentPos = 0;

		// Some taggers put ID3v2 tags at the start of any file, skip 'em
		while (true) {
			let slice = input._reader.requestSlice(currentPos, ID3_V2_HEADER_SIZE);
			if (isThenable(slice)) {
				slice = await slice;
			}
			if (!slice) {
				break;
			}

			const id3V2Header = readId3V2Header(slice);
			if (!id3V2Header) {
				break;
			}

			currentPos = slice.filePos + id3V2Header.size;
		}

		let slice = input._reader.requestSlice(currentPos, 4);
		if (isThenable(slice)) {
			slice = await slice;
		}
		if (!slice) {
			return false;
		}

		return readAscii(slice, 4) === 'OggS';
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new OggDemuxer(input);
	}

	get name() {
		return 'Ogg';
	}

	get mimeType() {
		return 'application/ogg';
	}

	get supportsTimestampedMediaData() {
		return true;
	}
}
/**
 * FLAC file format.
 *
 * Do not instantiate this class; use the {@link FLAC} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class FlacInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		let currentPos = 0;

		// There might be ID3v2 headers at the start, skip 'em
		while (true) {
			let slice = input._reader.requestSlice(currentPos, ID3_V2_HEADER_SIZE);
			if (isThenable(slice)) slice = await slice;
			if (!slice) break;

			const id3V2Header = readId3V2Header(slice);
			if (!id3V2Header) {
				break;
			}

			currentPos = slice.filePos + id3V2Header.size;
		}

		let slice = input._reader.requestSlice(currentPos, 4);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return false;

		return readAscii(slice, 4) === 'fLaC';
	}

	get name() {
		return 'FLAC';
	}

	get mimeType() {
		return 'audio/flac';
	}

	get supportsTimestampedMediaData() {
		return false;
	}

	/** @internal */
	_createDemuxer(input: Input): Demuxer {
		return new FlacDemuxer(input);
	}
}

/**
 * ADTS file format.
 *
 * Do not instantiate this class; use the {@link ADTS} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class AdtsInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		/** Returns the position after the ID3v2 tags starting at the given position, if any. */
		const skipId3V2Tags = async (pos: number) => {
			while (true) {
				let slice = input._reader.requestSlice(pos, ID3_V2_HEADER_SIZE);
				if (isThenable(slice)) {
					slice = await slice;
				}
				if (!slice) {
					break;
				}

				const id3V2Header = readId3V2Header(slice);
				if (!id3V2Header) {
					break;
				}

				pos = slice.filePos + id3V2Header.size;
			}

			return pos;
		};

		let currentPos = await skipId3V2Tags(0);

		let slice = input._reader.requestSliceRange(
			currentPos,
			MIN_ADTS_FRAME_HEADER_SIZE,
			MAX_ADTS_FRAME_HEADER_SIZE,
		);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return false;

		const firstHeader = readAdtsFrameHeader(slice);
		if (!firstHeader) {
			return false;
		}

		// Packed audio, like HLS segments, may carry timed ID3v2 tags between frames
		currentPos = await skipId3V2Tags(currentPos + firstHeader.frameLength);
		if (currentPos === input._reader.fileSize) {
			// The file holds exactly this one frame, so surely this is ADTS
			return true;
		}

		slice = input._reader.requestSliceRange(
			currentPos,
			MIN_ADTS_FRAME_HEADER_SIZE,
			MAX_ADTS_FRAME_HEADER_SIZE,
		);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return false;

		const secondHeader = readAdtsFrameHeader(slice);
		if (!secondHeader) {
			return false;
		}

		return firstHeader.objectType === secondHeader.objectType
			&& firstHeader.samplingFrequencyIndex === secondHeader.samplingFrequencyIndex
			&& firstHeader.channelConfiguration === secondHeader.channelConfiguration;
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new AdtsDemuxer(input);
	}

	get name() {
		return 'ADTS';
	}

	get mimeType() {
		return 'audio/aac';
	}

	get supportsTimestampedMediaData() {
		return false;
	}
}

/**
 * MPEG Transport Stream (MPEG-TS) file format.
 *
 * This format can make use of {@link InputOptions.initInput} to initialize track information even when no
 * initialization information is provided for the track, for example because it has no key frames. In this case, tracks
 * are matched to each other based on their PID.
 *
 * Do not instantiate this class; use the {@link MPEG_TS} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class MpegTsInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		let slice = input._reader.requestSliceRange(0, TS_PACKET_SIZE + 16 + 1, TS_PACKET_LAYOUT_PROBE_SIZE);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return false;

		return findTsPacketLayout(readBytes(slice, slice.length)) !== null;
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new MpegTsDemuxer(input);
	}

	get name() {
		return 'MPEG Transport Stream';
	}

	get mimeType() {
		return 'video/mp2t';
	}

	get supportsTimestampedMediaData() {
		return true;
	}
}

/**
 * Media described using the HTTP Live Streaming (HLS) protocol, with playlists in the M3U8 format.
 *
 * Do not instantiate this class; use the {@link HLS} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class HlsInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		let slice = input._reader.requestSlice(0, 7);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return false;

		const isM3u8 = readAscii(slice, 7) === '#EXTM3U';
		if (!isM3u8) {
			return false;
		}

		if (!(input._rootSource instanceof PathedSource)) {
			throw new TypeError('HLS inputs require `InputOptions.source` to be a PathedSource or a ref to one.');
		}

		input._rootSource._usedForHls = true;

		return true;
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new HlsDemuxer(input);
	}

	get name() {
		return 'HTTP Live Streaming (HLS)';
	}

	get mimeType() {
		return HLS_MIME_TYPE;
	}

	get supportsTimestampedMediaData() {
		return true;
	}
}

/**
 * MP4 input format singleton.
 * @group Input formats
 * @public
 */
export const MP4 = /* #__PURE__ */ new Mp4InputFormat();
/**
 * QuickTime File Format input format singleton.
 * @group Input formats
 * @public
 */
export const QTFF = /* #__PURE__ */ new QuickTimeInputFormat();
/**
 * Matroska input format singleton.
 * @group Input formats
 * @public
 */
export const MATROSKA = /* #__PURE__ */ new MatroskaInputFormat();
/**
 * WebM input format singleton.
 * @group Input formats
 * @public
 */
export const WEBM = /* #__PURE__ */ new WebMInputFormat();
/**
 * MP3 input format singleton.
 * @group Input formats
 * @public
 */
export const MP3 = /* #__PURE__ */ new Mp3InputFormat();
/**
 * WAVE input format singleton.
 * @group Input formats
 * @public
 */
export const WAVE = /* #__PURE__ */ new WaveInputFormat();
/**
 * Ogg input format singleton.
 * @group Input formats
 * @public
 */
export const OGG = /* #__PURE__ */ new OggInputFormat();
/**
 * ADTS input format singleton.
 * @group Input formats
 * @public
 */
export const ADTS = /* #__PURE__ */ new AdtsInputFormat();

/**
 * FLAC input format singleton.
 * @group Input formats
 * @public
 */
export const FLAC = /* #__PURE__ */ new FlacInputFormat();

/**
 * MPEG-TS input format singleton.
 * @group Input formats
 * @public
 */
export const MPEG_TS = /* #__PURE__ */ new MpegTsInputFormat();

/**
 * HLS input format singleton.
 * @group Input formats
 * @public
 */
export const HLS = /* #__PURE__ */ new HlsInputFormat();

/**
 * List of all input format singletons. If you don't need to support all input formats, you should specify the
 * formats individually for better tree shaking.
 * @group Input formats
 * @public
 */
// MPEG-TS comes before MP3 and ADTS: those are detected by searching for frame headers, which can find a couple of
// small frames inside a transport stream, whereas MPEG-TS detection checks the packet structure.
export const ALL_FORMATS: InputFormat[] = [HLS, MP4, QTFF, MATROSKA, WEBM, WAVE, OGG, FLAC, MPEG_TS, MP3, ADTS];

/**
 * List of input formats required for playback of typical HLS manifests. Includes HLS itself as well as the typical
 * segment formats: MPEG Transport Stream (.ts), MP4 (CMAF), ADTS (.aac) and MP3.
 * @group Input formats
 * @public
 */
export const HLS_FORMATS: InputFormat[] = [HLS, MP4, QTFF, MPEG_TS, MP3, ADTS];

/**
 * Additional per-format configuration.
 * @group Input formats
 * @public
 */
export type InputFormatOptions = {
	/** ISOBMFF-specific configuration. */
	isobmff?: IsobmffInputFormatOptions;
	/** HLS-specific configuration. */
	hls?: HlsInputFormatOptions;
};

/**
 * Additional ISOBMFF input configuration.
 * @group Input formats
 * @public
 */
export type IsobmffInputFormatOptions = {
	/**
	 * A callback that gets invoked for each key ID required for sample content decryption. The key ID is provided as a
	 * 32-character lowercase hexadecimal string.
	 *
	 * Must return or resolve to a 32-character hexadecimal string or a 16-byte `Uint8Array`.
	 */
	resolveKeyId?: (options: {
		/** The key ID that is to be resolved to a key. This is a 32-character lowercase hexadecimal string. */
		keyId: string;
		/**
		 * Protection System Specific Header (pssh) boxes that apply to this key ID. Can be used to obtain a
		 * description key from a DRM license server.
		 */
		psshBoxes: PsshBox[];
	}) => MaybePromise<Uint8Array | string>;

	/** @internal */
	_suppressPsshParsing?: boolean;
};

/**
 * Additional HLS input configuration.
 * @group Input formats
 * @public
 */
export type HlsInputFormatOptions = {
	/**
	 * Whether, in the presence of `#EXT-X-PROGRAM-DATE-TIME` tags, to offset track and packet timestamps to be relative
	 * to the Unix epoch.
	 *
	 * Defaults to `true`, meaning packet timestamps map directly to wall-clock time. This guarantees AV sync across
	 * multiple tracks, even with gaps present.
	 *
	 * When you don't want this mapping, you can set this value to `false`. In addition to timestamps not being Unix
	 * timestamps anymore, any gaps in the playlist are also naturally removed. When `false`, you can still access the
	 * wall-clock Unix timestamps via {@link InputTrack.getUnixTimeForTimestamp}.
	 */
	offsetTimestampsByDateTime?: boolean;
};

export const validateInputFormatOptions = (options: InputFormatOptions, prefix: string) => {
	if (!options || typeof options !== 'object') {
		throw new TypeError(`${prefix}, when provided, must be an object.`);
	}
	if (options.isobmff !== undefined) {
		if (!options.isobmff || typeof options.isobmff !== 'object') {
			throw new TypeError(`${prefix}.isobmff, when provided, must be an object.`);
		}
		if (options.isobmff.resolveKeyId !== undefined && typeof options.isobmff.resolveKeyId !== 'function') {
			throw new TypeError(`${prefix}.isobmff.resolveKeyId, when provided, must be a function.`);
		}
	}
	if (options.hls !== undefined) {
		if (!options.hls || typeof options.hls !== 'object') {
			throw new TypeError(`${prefix}.hls, when provided, must be an object.`);
		}
		if (
			options.hls.offsetTimestampsByDateTime !== undefined
			&& typeof options.hls.offsetTimestampsByDateTime !== 'boolean'
		) {
			throw new TypeError(`${prefix}.hls.offsetTimestampsByDateTime, when provided, must be a boolean.`);
		}
	}
};
