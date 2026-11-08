/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec } from '../codec';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputAudioTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import { assert, isThenable, UNDETERMINED_LANGUAGE } from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { readAscii, readBytes, Reader, readU16, readU32, readU64 } from '../reader';
import { ID3_V2_HEADER_SIZE, parseId3V2Tag, readId3V2Header } from '../id3';

export enum WaveFormat {
	PCM = 0x0001,
	IEEE_FLOAT = 0x0003,
	ALAW = 0x0006,
	MULAW = 0x0007,
	EXTENSIBLE = 0xFFFE,
}

// The sub-format GUIDs that hold a WAVE format tag in their first field, by their remaining 12 bytes (in the binary
// layout): the KSDATAFORMAT_SUBTYPE_* GUIDs, the Ambisonic B-format ones, and those of a known broken writer. Same as
// FFmpeg's (riffdec.c).
const FORMAT_TAG_SUB_FORMAT_BASES = [
	[0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71],
	[0x21, 0x07, 0xd3, 0x11, 0x86, 0x44, 0xc8, 0xc1, 0xca, 0x00, 0x00, 0x00],
	[0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa],
];

/** Formats a GUID given in its binary layout (first three fields little-endian). */
const formatGuid = (bytes: Uint8Array) => {
	const hex = (start: number, end: number, littleEndian: boolean) => {
		const part = [...bytes.subarray(start, end)];
		return (littleEndian ? part.reverse() : part).map(byte => byte.toString(16).padStart(2, '0')).join('');
	};

	return `{${hex(0, 4, true)}-${hex(4, 6, true)}-${hex(6, 8, true)}-${hex(8, 10, false)}-${hex(10, 16, false)}}`;
};

export class WaveDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	dataStart = -1;
	dataSize = -1;
	audioInfo: {
		format: number;
		numberOfChannels: number;
		sampleRate: number;
		sampleSizeInBytes: number;
		blockSizeInBytes: number;
		littleEndian: boolean;
	} | null = null;

	trackBackings: WaveAudioTrackBacking[] = [];
	lastKnownPacketIndex = 0;
	metadataTags: MetadataTags = {};
	/** Rethrown by getMetadataTags(), so that a broken tag can't make the audio unreadable */
	id3Error: Error | null = null;

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			let slice = this.reader.requestSlice(0, 12);
			if (isThenable(slice)) slice = await slice;
			assert(slice);

			const riffType = readAscii(slice, 4);
			const littleEndian = riffType !== 'RIFX';

			const isRf64 = riffType === 'RF64';

			const outerChunkSize = readU32(slice, littleEndian);

			// Sizes that don't fit into 32 bits are left at 0xFFFFFFFF by FFmpeg (as are all sizes it can't seek back
			// to, like when writing to a pipe). Like FFmpeg, we take such a data chunk to extend to the end of the
			// file. Chunks are still only looked for within the stated RIFF size.
			const isUnknownSize = (size: number) => size === 0xffffffff && this.reader.fileSize !== null;
			const riffSizeIsUnknown = !isRf64 && isUnknownSize(outerChunkSize);

			let totalFileSize = isRf64
				? this.reader.fileSize
				: Math.min(outerChunkSize + 8, this.reader.fileSize ?? Infinity);
			const format = readAscii(slice, 4);

			if (format !== 'WAVE') {
				throw new Error('Invalid WAVE file - wrong format');
			}

			let chunksRead = 0;
			let dataChunkSize: number | null = null;
			let currentPos = slice.filePos;
			// The sizes of chunks other than "data" that don't fit into 32 bits, from the table in the "ds64" chunk, by
			// chunk ID in the order they come in
			const largeChunkSizes = new Map<string, number[]>();

			while (totalFileSize === null || currentPos < totalFileSize) {
				let slice = this.reader.requestSlice(currentPos, 8);
				if (isThenable(slice)) slice = await slice;
				if (!slice) break;

				const chunkId = readAscii(slice, 4);
				let chunkSize = readU32(slice, littleEndian);
				const startPos = slice.filePos;

				if (isRf64 && chunksRead === 0 && chunkId !== 'ds64') {
					throw new Error('Invalid RF64 file: First chunk must be "ds64".');
				}

				if (this.dataStart !== -1 && !/^[\x20-\x7e]{4}$/.test(chunkId)) {
					// Chunk IDs are four printable ASCII characters, so after the audio this isn't a chunk header but
					// zeros or garbage, as at the end of a damaged file. Walking it 8 bytes at a time could take
					// forever, so the chunks end here. (Before the data chunk, zeros between chunks are walked like
					// FFmpeg does.)
					break;
				}

				if (isRf64 && chunkSize === 0xffffffff && chunkId !== 'data') {
					// The chunk's real size is in the "ds64" chunk's table (EBU Tech 3306, Annex A.2)
					chunkSize = largeChunkSizes.get(chunkId)?.shift() ?? chunkSize;
				}

				if (chunkId === 'fmt ') {
					await this.parseFmtChunk(startPos, chunkSize, littleEndian);
				} else if (chunkId === 'data') {
					if (!isRf64 && isUnknownSize(chunkSize)) {
						chunkSize = this.reader.fileSize! - startPos;
					}

					dataChunkSize ??= chunkSize;

					this.dataStart = slice.filePos;
					const dataEnd = riffSizeIsUnknown ? this.reader.fileSize : totalFileSize;
					this.dataSize = Math.max(Math.min(dataChunkSize, (dataEnd ?? Infinity) - this.dataStart), 0);

					if (this.reader.fileSize === null) {
						break; // Stop once we hit the data chunk
					}
				} else if (chunkId === 'ds64') {
					// File and data chunk sizes are defined in here instead

					let ds64Slice = this.reader.requestSlice(startPos, chunkSize);
					if (isThenable(ds64Slice)) ds64Slice = await ds64Slice;
					if (!ds64Slice) break;

					if (chunkSize < 16) {
						throw new Error('Invalid RF64 file: "ds64" chunk is too small.');
					}

					const riffChunkSize = readU64(ds64Slice, littleEndian);
					dataChunkSize = readU64(ds64Slice, littleEndian);

					if (chunkSize >= 28) {
						ds64Slice.skip(8); // Sample count
						const tableLength = readU32(ds64Slice, littleEndian);

						// Only the entries that the chunk actually holds
						const entryCount = Math.min(tableLength, Math.floor((chunkSize - 28) / 12));
						for (let i = 0; i < entryCount; i++) {
							const id = readAscii(ds64Slice, 4);
							const size = readU64(ds64Slice, littleEndian);

							const sizes = largeChunkSizes.get(id) ?? [];
							sizes.push(size);
							largeChunkSizes.set(id, sizes);
						}
					}

					totalFileSize = Math.min(riffChunkSize + 8, this.reader.fileSize ?? Infinity);
				} else if (chunkId === 'LIST') {
					await this.parseListChunk(startPos, chunkSize, littleEndian);
				} else if (chunkId === 'ID3 ' || chunkId === 'id3 ') {
					await this.parseId3Chunk(startPos, chunkSize);
				}

				currentPos = startPos + chunkSize + (chunkSize & 1); // Handle padding
				chunksRead++;
			}

			if (!this.audioInfo) {
				throw new Error('Invalid WAVE file - missing "fmt " chunk');
			}
			if (this.dataStart === -1) {
				throw new Error('Invalid WAVE file - missing "data" chunk');
			}

			const blockSize = this.audioInfo.blockSizeInBytes;
			this.dataSize = Math.floor(this.dataSize / blockSize) * blockSize;

			this.trackBackings.push(new WaveAudioTrackBacking(this));
		})();
	}

	private async parseFmtChunk(startPos: number, size: number, littleEndian: boolean) {
		let slice = this.reader.requestSlice(startPos, size);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return; // File too short

		if (size < 14) {
			throw new Error('Invalid WAVE file - "fmt " chunk is too small');
		}

		let formatTag = readU16(slice, littleEndian);
		const numChannels = readU16(slice, littleEndian);
		const sampleRate = readU32(slice, littleEndian);
		const bytesPerSecond = readU32(slice, littleEndian);
		const blockAlign = readU16(slice, littleEndian);

		if (numChannels === 0 || sampleRate === 0 || blockAlign === 0) {
			throw new Error('Invalid WAVE file - channel count, sample rate and block align must be positive');
		}

		let bitsPerSample: number;

		if (size < 16) { // Plain WAVEFORMAT
			bitsPerSample = 8;
		} else {
			bitsPerSample = readU16(slice, littleEndian);
		}

		// Handle WAVEFORMATEXTENSIBLE
		if (size >= 18 && formatTag !== 0x0165) {
			const cbSize = readU16(slice, littleEndian);
			const remainingSize = size - 18;
			const extensionSize = Math.min(remainingSize, cbSize);

			if (extensionSize >= 22 && formatTag === WaveFormat.EXTENSIBLE) {
				// Parse WAVEFORMATEXTENSIBLE
				slice.skip(2 + 4);
				const subFormat = readBytes(slice, 16);

				// Get the actual format tag from the sub-format GUID. Other GUIDs denote other (vendor) formats, whose
				// data mustn't be taken for PCM just because their first bytes happen to look like its tag.
				const holdsFormatTag = FORMAT_TAG_SUB_FORMAT_BASES.some(
					base => base.every((byte, i) => subFormat[4 + i] === byte),
				);
				if (!holdsFormatTag) {
					throw new Error(
						`Unsupported WAVE codec (sub-format GUID ${formatGuid(subFormat)}). Only integer/float PCM,`
						+ ` A-law, and μ-law are supported.`,
					);
				}

				// The whole first field, like FFmpeg: a GUID whose first field merely ends in a known tag isn't that
				// format either
				formatTag = (subFormat[0]! | (subFormat[1]! << 8) | (subFormat[2]! << 16) | (subFormat[3]! << 24))
					>>> 0;
			}
		}

		if (formatTag === WaveFormat.MULAW || formatTag === WaveFormat.ALAW) {
			bitsPerSample = 8;
		}

		if (
			formatTag !== WaveFormat.PCM
			&& formatTag !== WaveFormat.IEEE_FLOAT
			&& formatTag !== WaveFormat.ALAW
			&& formatTag !== WaveFormat.MULAW
		) {
			throw new Error(
				`Unsupported WAVE codec (format tag ${formatTag}). Only integer/float PCM, A-law, and μ-law are`
				+ ` supported.`,
			);
		}
		if (formatTag === WaveFormat.PCM && ![8, 16, 24, 32].includes(bitsPerSample)) {
			throw new Error(
				`Unsupported WAVE PCM bit depth (${bitsPerSample}). Only 8, 16, 24, and 32 bits are supported.`,
			);
		}
		if (formatTag === WaveFormat.IEEE_FLOAT && ![32, 64].includes(bitsPerSample)) {
			throw new Error(
				`Unsupported WAVE float bit depth (${bitsPerSample}). Only 32 and 64 bits are supported.`,
			);
		}

		const sampleSizeInBytes = Math.ceil(bitsPerSample / 8);

		// Some writers get the block align wrong, so the frames' size goes by the bit depth (like FFmpeg computes the
		// duration). A larger block align is only believed when the byte rate agrees with it, as for 24-bit samples
		// in 4-byte containers (written by Adobe Audition, say).
		const minBlockSize = numChannels * sampleSizeInBytes;
		const blockSizeInBytes = blockAlign >= minBlockSize && bytesPerSecond === sampleRate * blockAlign
			? blockAlign
			: minBlockSize;

		this.audioInfo = {
			format: formatTag,
			numberOfChannels: numChannels,
			sampleRate,
			sampleSizeInBytes,
			blockSizeInBytes,
			littleEndian,
		};
	}

	private async parseListChunk(startPos: number, size: number, littleEndian: boolean) {
		if (size < 4) return; // Chunk too short

		let slice = this.reader.requestSlice(startPos, size);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return; // File too short

		const infoType = readAscii(slice, 4);
		if (infoType !== 'INFO' && infoType !== 'INF0') { // exiftool.org claims INF0 can happen
			return; // Not an INFO chunk
		}

		let currentPos = slice.filePos;
		while (currentPos <= startPos + size - 8) {
			slice.filePos = currentPos;

			const chunkName = readAscii(slice, 4);
			const chunkSize = readU32(slice, littleEndian);
			if (chunkSize > slice.remainingLength) {
				break; // The sub-chunk doesn't fit into the LIST chunk
			}

			const bytes = readBytes(slice, chunkSize);

			let value = '';
			for (let i = 0; i < bytes.length && bytes[i] !== 0; i++) {
				value += String.fromCharCode(bytes[i]!);
			}

			this.metadataTags.raw ??= {};
			this.metadataTags.raw[chunkName] = value;

			switch (chunkName) {
				case 'INAM':
				case 'TITL': {
					this.metadataTags.title ??= value;
				}; break;

				case 'TIT3': {
					this.metadataTags.description ??= value;
				}; break;

				case 'IART': {
					this.metadataTags.artist ??= value;
				}; break;

				case 'IPRD': {
					this.metadataTags.album ??= value;
				}; break;

				case 'IPRT':
				case 'ITRK':
				case 'TRCK': {
					const parts = value.split('/');
					const trackNum = Number.parseInt(parts[0]!, 10);
					const tracksTotal = parts[1] && Number.parseInt(parts[1], 10);

					if (Number.isInteger(trackNum) && trackNum > 0) {
						this.metadataTags.trackNumber ??= trackNum;
					}
					if (tracksTotal && Number.isInteger(tracksTotal) && tracksTotal > 0) {
						this.metadataTags.tracksTotal ??= tracksTotal;
					}
				}; break;

				case 'ICRD':
				case 'IDIT': {
					const date = new Date(value);
					if (!Number.isNaN(date.getTime())) {
						this.metadataTags.date ??= date;
					}
				}; break;

				case 'YEAR': {
					const year = Number.parseInt(value, 10);
					if (Number.isInteger(year) && year > 0) {
						this.metadataTags.date ??= new Date(year, 0, 1);
					}
				}; break;

				case 'IGNR':
				case 'GENR': {
					this.metadataTags.genre ??= value;
				}; break;

				case 'ICMT':
				case 'CMNT':
				case 'COMM': {
					this.metadataTags.comment ??= value;
				}; break;
			}

			currentPos += 8 + chunkSize + (chunkSize & 1); // Handle padding
		}
	}

	private async parseId3Chunk(startPos: number, size: number) {
		// Parse ID3 tag embedded in WAV file (non-default, but used a lot in practice anyway)
		if (size < ID3_V2_HEADER_SIZE) return; // Chunk too short

		let slice = this.reader.requestSlice(startPos, size);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return; // File too short

		const id3V2Header = readId3V2Header(slice);
		if (id3V2Header) {
			// Clamp to the available data in case the ID3 header claims more than the WAV chunk provides
			// https://github.com/Vanilagy/mediabunny/issues/300
			const availableSize = size - ID3_V2_HEADER_SIZE;
			id3V2Header.size = Math.min(id3V2Header.size, availableSize);

			if (id3V2Header.size > 0) {
				const contentSlice = slice.slice(startPos + ID3_V2_HEADER_SIZE, id3V2Header.size);

				try {
					parseId3V2Tag(contentSlice, id3V2Header, this.metadataTags);
				} catch (error) {
					this.id3Error ??= error as Error;
				}
			}
		}
	}

	getCodec(): AudioCodec | null {
		assert(this.audioInfo);

		if (this.audioInfo.format === WaveFormat.MULAW) {
			return 'ulaw';
		}
		if (this.audioInfo.format === WaveFormat.ALAW) {
			return 'alaw';
		}

		// RIFX stores the samples big-endian, just like the rest of the file
		const littleEndian = this.audioInfo.littleEndian;

		if (this.audioInfo.format === WaveFormat.PCM) {
			if (this.audioInfo.sampleSizeInBytes === 1) {
				return 'pcm-u8';
			} else if (this.audioInfo.sampleSizeInBytes === 2) {
				return littleEndian ? 'pcm-s16' : 'pcm-s16be';
			} else if (this.audioInfo.sampleSizeInBytes === 3) {
				return littleEndian ? 'pcm-s24' : 'pcm-s24be';
			} else if (this.audioInfo.sampleSizeInBytes === 4) {
				return littleEndian ? 'pcm-s32' : 'pcm-s32be';
			}
		}
		if (this.audioInfo.format === WaveFormat.IEEE_FLOAT) {
			if (this.audioInfo.sampleSizeInBytes === 4) {
				return littleEndian ? 'pcm-f32' : 'pcm-f32be';
			} else if (this.audioInfo.sampleSizeInBytes === 8) {
				return littleEndian ? 'pcm-f64' : 'pcm-f64be';
			}
		}

		assert(false);
	}

	async getMimeType() {
		return 'audio/wav';
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.trackBackings;
	}

	async getMetadataTags() {
		await this.readMetadata();

		if (this.id3Error) {
			throw this.id3Error;
		}

		return this.metadataTags;
	}
}

const PACKET_SIZE_IN_FRAMES = 2048;

class WaveAudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: WaveDemuxer) {}

	getType() {
		return 'audio' as const;
	}

	getId() {
		return 1;
	}

	getNumber() {
		return 1;
	}

	getCodec() {
		return this.demuxer.getCodec();
	}

	getInternalCodecId() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.format;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		const codec = this.demuxer.getCodec();
		if (!codec) {
			return null;
		}

		assert(this.demuxer.audioInfo);
		return {
			codec,
			numberOfChannels: this.demuxer.audioInfo.numberOfChannels,
			sampleRate: this.demuxer.audioInfo.sampleRate,
		};
	}

	getNumberOfChannels() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.numberOfChannels;
	}

	getSampleRate() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.sampleRate;
	}

	getTimeResolution() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.sampleRate;
	}

	isRelativeToUnixEpoch() {
		return false;
	}

	getUnixTimeForTimestamp() {
		return null;
	}

	getPairingMask() {
		return 1n;
	}

	getBitrate() {
		return null;
	}

	getAverageBitrate() {
		return null;
	}

	async getDurationFromMetadata() {
		assert(this.demuxer.dataSize !== -1);

		return this.demuxer.dataSize / this.demuxer.audioInfo!.blockSizeInBytes / this.demuxer.audioInfo!.sampleRate;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	getName() {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getDisposition() {
		return {
			...DEFAULT_TRACK_DISPOSITION,
		};
	}

	private async getPacketAtIndex(
		packetIndex: number,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		assert(packetIndex >= 0);

		assert(this.demuxer.audioInfo);
		const startOffset = packetIndex * PACKET_SIZE_IN_FRAMES * this.demuxer.audioInfo.blockSizeInBytes;
		if (startOffset >= this.demuxer.dataSize) {
			return null;
		}

		const sizeInBytes = Math.min(
			PACKET_SIZE_IN_FRAMES * this.demuxer.audioInfo.blockSizeInBytes,
			this.demuxer.dataSize - startOffset,
		);

		if (this.demuxer.reader.fileSize === null) {
			// If the file size is unknown, we weren't able to cap the dataSize in the init logic and we instead have to
			// rely on the headers telling us how large the file is. But, these might be wrong, so let's check if the
			// requested slice actually exists.

			let slice = this.demuxer.reader.requestSlice(this.demuxer.dataStart + startOffset, sizeInBytes);
			if (isThenable(slice)) slice = await slice;

			if (!slice) {
				return null;
			}
		}

		let data: Uint8Array;
		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			let slice = this.demuxer.reader.requestSlice(this.demuxer.dataStart + startOffset, sizeInBytes);
			if (isThenable(slice)) slice = await slice;
			assert(slice);

			data = readBytes(slice, sizeInBytes);
		}

		const timestamp = packetIndex * PACKET_SIZE_IN_FRAMES / this.demuxer.audioInfo.sampleRate;
		const duration = sizeInBytes / this.demuxer.audioInfo.blockSizeInBytes / this.demuxer.audioInfo.sampleRate;

		this.demuxer.lastKnownPacketIndex = Math.max(
			packetIndex,
			this.demuxer.lastKnownPacketIndex,
		);

		return new EncodedPacket(
			data,
			'key',
			timestamp,
			duration,
			packetIndex,
			sizeInBytes,
		);
	}

	getFirstPacket(options: PacketRetrievalOptions) {
		return this.getPacketAtIndex(0, options);
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		assert(this.demuxer.audioInfo);

		const packetIndex = Math.floor(Math.min(
			timestamp * this.demuxer.audioInfo.sampleRate / PACKET_SIZE_IN_FRAMES,
			(this.demuxer.dataSize - 1) / (PACKET_SIZE_IN_FRAMES * this.demuxer.audioInfo.blockSizeInBytes),
		));
		if (packetIndex < 0) {
			return null;
		}

		const packet = await this.getPacketAtIndex(packetIndex, options);
		if (packet) {
			return packet;
		}

		if (packetIndex === 0) {
			return null; // Empty data chunk
		}

		assert(this.demuxer.reader.fileSize === null);

		// The file is shorter than we thought, meaning the packet we were looking for doesn't exist. So, let's find
		// the last packet by doing a sequential scan, instead.
		let currentPacket = await this.getPacketAtIndex(this.demuxer.lastKnownPacketIndex, options);
		while (currentPacket) {
			const nextPacket = await this.getNextPacket(currentPacket, options);
			if (!nextPacket) {
				break;
			}

			currentPacket = nextPacket;
		}

		return currentPacket;
	}

	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		assert(this.demuxer.audioInfo);
		const packetIndex = Math.round(packet.timestamp * this.demuxer.audioInfo.sampleRate / PACKET_SIZE_IN_FRAMES);

		return this.getPacketAtIndex(packetIndex + 1, options);
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		return this.getPacket(timestamp, options);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		return this.getNextPacket(packet, options);
	}
}
