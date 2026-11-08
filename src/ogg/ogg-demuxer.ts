/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { OPUS_SAMPLE_RATE } from '../codec';
import { parseModesFromVorbisSetupPacket, parseOpusIdentificationHeader, readVorbisComments } from '../codec-data';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputAudioTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { Logging } from '../logging';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags, TrackDisposition } from '../metadata';
import {
	assert,
	AsyncMutex,
	binarySearchLessOrEqual,
	clamp,
	findLast,
	isThenable,
	last,
	roundIfAlmostInteger,
	toDataView,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { readBytes, Reader } from '../reader';
import { buildOggMimeType, extractSampleMetadata, OggCodecInfo } from './ogg-misc';
import {
	findNextPageHeader,
	MAX_PAGE_HEADER_SIZE,
	MAX_PAGE_SIZE,
	MIN_PAGE_HEADER_SIZE,
	Page,
	pageChecksumMatches,
	readPageHeader,
} from './ogg-reader';

const MAX_LOGICAL_BITSTREAMS = 64;
const VORBIS_IDENTIFICATION_HEADER_SIZE = 30;
const OPUS_IDENTIFICATION_HEADER_MIN_SIZE = 19;
// An encoder's pre-skip covers its algorithmic delay: libopus' lookahead is 312 samples (120 in its low-delay mode),
// and resampling the input first (as opusenc does for 44.1 kHz input, giving 356) adds up to a few hundred more. A
// larger pre-skip crops the start of the stream, for which RFC 7845 (section 4.2) recommends at least 3840 samples.
const MAX_ENCODER_PRE_SKIP = 1000;
/** How far lookups read on from the start of a track's first link to find its end, before bisecting instead. */
const FIRST_LINK_SCAN_SIZE = 2 ** 16;

type LogicalBitstream = {
	serialNumber: number;
	bosPage: Page;
	description: Uint8Array | null;
	numberOfChannels: number;
	sampleRate: number;
	codecInfo: OggCodecInfo;

	lastMetadataPacket: Packet | null;
	/** The identification header, and for Vorbis also the setup header. */
	headerPackets: Uint8Array[];
};

type Packet = {
	data: Uint8Array;
	endPage: Page;
	endSegmentIndex: number;
};

export class OggDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	/** Whether pages (by position) of chained links have a matching checksum. */
	pageIntactness = new Map<number, boolean>();
	bitstreams: LogicalBitstream[] = [];
	trackBackings: OggAudioTrackBacking[] = [];
	metadataTags: MetadataTags = {};

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			let currentPos = 0;

			while (true) {
				let slice = this.reader.requestSliceRange(currentPos, MIN_PAGE_HEADER_SIZE, MAX_PAGE_HEADER_SIZE);
				if (isThenable(slice)) slice = await slice;
				if (!slice) break;

				const page = readPageHeader(slice);
				if (!page) {
					break;
				}

				const isBos = !!(page.headerType & 0x02);
				if (!isBos) {
					// All bos pages for all bitstreams are required to be at the start, so if the page is not bos then
					// we know we've seen all bitstreams (minus chaining)
					break;
				}

				if (this.bitstreams.length === MAX_LOGICAL_BITSTREAMS) {
					throw new Error(`Too many (> ${MAX_LOGICAL_BITSTREAMS}) logical bitstreams.`);
				}

				this.bitstreams.push({
					serialNumber: page.serialNumber,
					bosPage: page,
					description: null,
					numberOfChannels: -1,
					sampleRate: -1,
					codecInfo: {
						codec: null,
						vorbisInfo: null,
						opusInfo: null,
					},
					lastMetadataPacket: null,
					headerPackets: [],
				});

				currentPos = page.headerStartPos + page.totalSize;
			}

			for (const bitstream of this.bitstreams) {
				await this.readCodecHeaders(bitstream, this.metadataTags);

				if (bitstream.codecInfo.codec !== null) {
					this.trackBackings.push(new OggAudioTrackBacking(bitstream, this));
				}
			}
		})();
	}

	/** Reads the header packets of a logical bitstream and sets its codec info if it's Vorbis or Opus. */
	async readCodecHeaders(bitstream: LogicalBitstream, metadataTags: MetadataTags | null) {
		const firstPacket = await this.readPacket(bitstream.bosPage, 0);
		if (!firstPacket) {
			return;
		}

		if (
		// Check for Vorbis
			firstPacket.data.byteLength >= VORBIS_IDENTIFICATION_HEADER_SIZE
			&& firstPacket.data[0] === 0x01 // Packet type 1 = identification header
			&& firstPacket.data[1] === 0x76 // 'v'
			&& firstPacket.data[2] === 0x6f // 'o'
			&& firstPacket.data[3] === 0x72 // 'r'
			&& firstPacket.data[4] === 0x62 // 'b'
			&& firstPacket.data[5] === 0x69 // 'i'
			&& firstPacket.data[6] === 0x73 // 's'
		) {
			await this.readVorbisMetadata(firstPacket, bitstream, metadataTags);
		} else if (
		// Check for Opus
			firstPacket.data.byteLength >= OPUS_IDENTIFICATION_HEADER_MIN_SIZE
			&& firstPacket.data[0] === 0x4f // 'O'
			&& firstPacket.data[1] === 0x70 // 'p'
			&& firstPacket.data[2] === 0x75 // 'u'
			&& firstPacket.data[3] === 0x73 // 's'
			&& firstPacket.data[4] === 0x48 // 'H'
			&& firstPacket.data[5] === 0x65 // 'e'
			&& firstPacket.data[6] === 0x61 // 'a'
			&& firstPacket.data[7] === 0x64 // 'd'
		) {
			await this.readOpusMetadata(firstPacket, bitstream, metadataTags);
		}
	}

	async readVorbisMetadata(firstPacket: Packet, bitstream: LogicalBitstream, metadataTags: MetadataTags | null) {
		let nextPacketPosition = await this.findNextPacketStart(firstPacket);
		if (!nextPacketPosition) {
			return;
		}

		const secondPacket = await this.readPacket(nextPacketPosition.startPage, nextPacketPosition.startSegmentIndex);
		if (!secondPacket) {
			return;
		}

		nextPacketPosition = await this.findNextPacketStart(secondPacket);
		if (!nextPacketPosition) {
			return;
		}

		const thirdPacket = await this.readPacket(nextPacketPosition.startPage, nextPacketPosition.startSegmentIndex);
		if (!thirdPacket) {
			return;
		}

		if (secondPacket.data[0] !== 0x03 || thirdPacket.data[0] !== 0x05) {
			return;
		}

		const view = toDataView(firstPacket.data);
		const numberOfChannels = view.getUint8(11);
		const sampleRate = view.getUint32(12, true);
		if (numberOfChannels === 0 || sampleRate === 0) {
			throw new Error('Invalid Vorbis identification header: channel count and sample rate must not be 0.');
		}

		const lacingValues: number[] = [];
		const addBytesToSegmentTable = (bytes: number) => {
			while (true) {
				lacingValues.push(Math.min(255, bytes));

				if (bytes < 255) {
					break;
				}

				bytes -= 255;
			}
		};

		addBytesToSegmentTable(firstPacket.data.length);
		addBytesToSegmentTable(secondPacket.data.length);
		// We don't add the last packet to the segment table, as it is assumed to be whatever bytes remain

		const description = new Uint8Array(
			1 + lacingValues.length
			+ firstPacket.data.length + secondPacket.data.length + thirdPacket.data.length,
		);
		description[0] = 2; // Num entries in the segment table
		description.set(
			lacingValues, 1,
		);
		description.set(
			firstPacket.data, 1 + lacingValues.length,
		);
		description.set(
			secondPacket.data, 1 + lacingValues.length + firstPacket.data.length,
		);
		description.set(
			thirdPacket.data, 1 + lacingValues.length + firstPacket.data.length + secondPacket.data.length,
		);

		bitstream.codecInfo.codec = 'vorbis';
		bitstream.description = description;
		bitstream.lastMetadataPacket = thirdPacket;
		bitstream.headerPackets = [firstPacket.data, thirdPacket.data];

		bitstream.numberOfChannels = numberOfChannels;
		bitstream.sampleRate = sampleRate;

		const blockSizeByte = view.getUint8(28);
		bitstream.codecInfo.vorbisInfo = {
			blocksizes: [
				1 << (blockSizeByte & 0xf),
				1 << (blockSizeByte >> 4),
			],
			modeBlockflags: parseModesFromVorbisSetupPacket(thirdPacket.data).modeBlockflags,
		};

		if (metadataTags) {
			readVorbisComments(secondPacket.data.subarray(7), metadataTags); // Skip header type and 'vorbis'
		}
	}

	async readOpusMetadata(firstPacket: Packet, bitstream: LogicalBitstream, metadataTags: MetadataTags | null) {
		// From https://datatracker.ietf.org/doc/html/rfc7845#section-5:
		// "An Ogg Opus logical stream contains exactly two mandatory header packets: an identification header and a
		// comment header."
		const nextPacketPosition = await this.findNextPacketStart(firstPacket);
		if (!nextPacketPosition) {
			return;
		}

		const secondPacket = await this.readPacket(
			nextPacketPosition.startPage,
			nextPacketPosition.startSegmentIndex,
		);
		if (!secondPacket) {
			return;
		}

		bitstream.codecInfo.codec = 'opus';
		bitstream.description = firstPacket.data;
		bitstream.lastMetadataPacket = secondPacket;
		bitstream.headerPackets = [firstPacket.data];

		const header = parseOpusIdentificationHeader(firstPacket.data);
		bitstream.numberOfChannels = header.outputChannelCount;
		bitstream.sampleRate = OPUS_SAMPLE_RATE; // Always the same

		bitstream.codecInfo.opusInfo = {
			preSkip: header.preSkip,
		};

		if (metadataTags) {
			readVorbisComments(secondPacket.data.subarray(8), metadataTags); // Skip 'OpusTags'
		}
	}

	/**
	 * Checks the checksum of the pages of chained links (those of the file's first bitstreams aren't checked, to stay
	 * as lenient as before), so that a damaged later link, as found where a stream capture broke off, ends the track
	 * instead of handing damaged data to the decoder. FFmpeg also drops pages whose checksum doesn't match.
	 */
	async pageIsIntact(page: Page) {
		if (this.bitstreams.some(x => x.serialNumber === page.serialNumber)) {
			return true;
		}

		let result = this.pageIntactness.get(page.headerStartPos);
		if (result === undefined) {
			let slice = this.reader.requestSlice(page.headerStartPos, page.totalSize);
			if (isThenable(slice)) {
				slice = await slice;
			}
			result = !!slice && pageChecksumMatches(page, readBytes(slice, page.totalSize));
			this.pageIntactness.set(page.headerStartPos, result);
		}

		return result;
	}

	/**
	 * Follows the pages of a chained link's bitstream from its first page and returns where its intact part ends:
	 * after its end-of-stream page, or at its first damaged page. Returns null if that can't be told, as the pages
	 * stop being consecutive before either.
	 */
	async findIntactLinkEnd(bitstream: LogicalBitstream): Promise<number | null> {
		let page = bitstream.bosPage;

		while (true) {
			if (!await this.pageIsIntact(page)) {
				return page.headerStartPos;
			}

			const endPos = page.headerStartPos + page.totalSize;
			if (page.headerType & 0x04) {
				return endPos;
			}

			let slice = this.reader.requestSliceRange(endPos, MIN_PAGE_HEADER_SIZE, MAX_PAGE_HEADER_SIZE);
			if (isThenable(slice)) {
				slice = await slice;
			}
			const nextPage = slice && readPageHeader(slice);
			if (!nextPage || nextPage.serialNumber !== bitstream.serialNumber) {
				return null;
			}

			page = nextPage;
		}
	}

	/**
	 * Reads the logical bitstream of the chained link (RFC 3533, section 4) that starts with the page at the given
	 * position, if there is one. Only links made of a single logical bitstream are read.
	 */
	async readChainedLink(pos: number): Promise<LogicalBitstream | null> {
		let slice = this.reader.requestSliceRange(pos, MIN_PAGE_HEADER_SIZE, MAX_PAGE_HEADER_SIZE);
		if (isThenable(slice)) {
			slice = await slice;
		}
		const bosPage = slice && readPageHeader(slice);
		if (!bosPage || !(bosPage.headerType & 0x02)) {
			return null;
		}

		slice = this.reader.requestSliceRange(
			bosPage.headerStartPos + bosPage.totalSize,
			MIN_PAGE_HEADER_SIZE,
			MAX_PAGE_HEADER_SIZE,
		);
		if (isThenable(slice)) {
			slice = await slice;
		}
		const nextPage = slice && readPageHeader(slice);
		if (nextPage && (nextPage.headerType & 0x02)) {
			return null; // A link with multiple logical bitstreams
		}

		const bitstream: LogicalBitstream = {
			serialNumber: bosPage.serialNumber,
			bosPage,
			description: null,
			numberOfChannels: -1,
			sampleRate: -1,
			codecInfo: {
				codec: null,
				vorbisInfo: null,
				opusInfo: null,
			},
			lastMetadataPacket: null,
			headerPackets: [],
		};
		await this.readCodecHeaders(bitstream, null);

		return bitstream;
	}

	async readPacket(startPage: Page, startSegmentIndex: number): Promise<Packet | null> {
		assert(startSegmentIndex < startPage.lacingValues.length);

		let startDataOffset = 0;
		for (let i = 0; i < startSegmentIndex; i++) {
			startDataOffset += startPage.lacingValues[i]!;
		}

		let currentPage: Page = startPage;
		let currentDataOffset = startDataOffset;
		let currentSegmentIndex = startSegmentIndex;

		const chunks: Uint8Array[] = [];

		outer:
		while (true) {
			if (!await this.pageIsIntact(currentPage)) {
				return null;
			}

			// Load the entire page data
			let pageSlice = this.reader.requestSlice(currentPage.dataStartPos, currentPage.dataSize);
			if (isThenable(pageSlice)) pageSlice = await pageSlice;
			if (!pageSlice) {
				return null; // The page is cut off
			}

			const pageData = readBytes(pageSlice, currentPage.dataSize);

			while (true) {
				if (currentSegmentIndex === currentPage.lacingValues.length) {
					chunks.push(pageData.subarray(startDataOffset, currentDataOffset));
					break;
				}

				const lacingValue = currentPage.lacingValues[currentSegmentIndex]!;
				currentDataOffset += lacingValue;

				if (lacingValue < 255) {
					chunks.push(pageData.subarray(startDataOffset, currentDataOffset));
					break outer;
				}

				currentSegmentIndex++;
			}

			// The packet extends to the next page; let's find it
			let currentPos = currentPage.headerStartPos + currentPage.totalSize;
			while (true) {
				let headerSlice = this.reader.requestSliceRange(currentPos, MIN_PAGE_HEADER_SIZE, MAX_PAGE_HEADER_SIZE);
				if (isThenable(headerSlice)) headerSlice = await headerSlice;
				if (!headerSlice) {
					return null;
				}

				const nextPage = readPageHeader(headerSlice);
				if (!nextPage) {
					return null;
				}

				currentPage = nextPage;
				if (currentPage.serialNumber === startPage.serialNumber) {
					break;
				}
				currentPos = currentPage.headerStartPos + currentPage.totalSize;
			}

			startDataOffset = 0;
			currentDataOffset = 0;
			currentSegmentIndex = 0;
		}

		const totalPacketSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		if (totalPacketSize === 0) {
			return null; // Invalid packet, treat it as end of stream
		}

		const packetData = new Uint8Array(totalPacketSize);

		let offset = 0;
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i]!;
			packetData.set(chunk, offset);
			offset += chunk.length;
		}

		return {
			data: packetData,
			endPage: currentPage,
			endSegmentIndex: currentSegmentIndex,
		};
	}

	async findNextPacketStart(lastPacket: Packet) {
		// If there's another segment in the same page, return it
		if (lastPacket.endSegmentIndex < lastPacket.endPage.lacingValues.length - 1) {
			return { startPage: lastPacket.endPage, startSegmentIndex: lastPacket.endSegmentIndex + 1 };
		}

		const isEos = !!(lastPacket.endPage.headerType & 0x04);
		if (isEos) {
			// The page is marked as the last page of the logical bitstream, so we won't find anything beyond it
			return null;
		}

		// Otherwise, search for the next page belonging to the same bitstream
		let currentPos = lastPacket.endPage.headerStartPos + lastPacket.endPage.totalSize;
		while (true) {
			let slice = this.reader.requestSliceRange(currentPos, MIN_PAGE_HEADER_SIZE, MAX_PAGE_HEADER_SIZE);
			if (isThenable(slice)) slice = await slice;
			if (!slice) {
				return null;
			}

			const nextPage = readPageHeader(slice);
			if (!nextPage) {
				return null;
			}

			if (nextPage.serialNumber === lastPacket.endPage.serialNumber) {
				return { startPage: nextPage, startSegmentIndex: 0 };
			}

			currentPos = nextPage.headerStartPos + nextPage.totalSize;
		}
	}

	async getMimeType() {
		await this.readMetadata();

		const codecStrings = await Promise.all(this.trackBackings.map(
			x => x.getDecoderConfig().then(c => c?.codec ?? null),
		));

		return buildOggMimeType({
			codecStrings: codecStrings.filter(Boolean) as string[],
		});
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.trackBackings;
	}

	async getMetadataTags() {
		await this.readMetadata();
		return this.metadataTags;
	}
}

/**
 * One link of a chained stream (RFC 3533, section 4): a logical bitstream that follows the previous link's last page.
 * A track continues across links whose codec parameters match those of its first link.
 */
type OggLink = {
	bitstream: LogicalBitstream;
	/** Added to the timestamps derived from the link's own granule positions to get track timestamps. */
	offsetInSamples: number;
	/** Track timestamp of the link's first packet. */
	firstTimestampInSamples: number;
	/** For Vorbis, the block size of the packet that precedes the link's first packet in the track. */
	initialVorbisLastBlocksize: number | null;
	/**
	 * Where the link's last page ends, once known from reading on from the link's start. A lookup's bisection can't
	 * tell, as it can land on a later link that reuses the serial number (which RFC 3533 forbids, but `cat` makes).
	 */
	endPos: number | null;
	/** The links that follow the link if it ends at the given position. */
	nextLinks: Map<number, Promise<OggLink | null>>;
};

type EncodedPacketMetadata = {
	packet: Packet;
	link: OggLink;
	timestampInSamples: number;
	durationInSamples: number;
	vorbisLastBlockSize: number | null;
	vorbisBlockSize: number | null;
};

class OggAudioTrackBacking implements InputAudioTrackBacking {
	internalSampleRate: number;
	encodedPacketToMetadata = new WeakMap<EncodedPacket, EncodedPacketMetadata>();
	sequentialScanCache: EncodedPacketMetadata[] = [];
	sequentialScanMutex = new AsyncMutex();
	firstLinkPromise: Promise<OggLink> | null = null;
	triedFindingFirstLinkEnd = false;
	warnedAboutIncompatibleLink = false;

	constructor(public bitstream: LogicalBitstream, public demuxer: OggDemuxer) {
		// Opus always uses a fixed sample rate for its internal calculations, even if the actual rate is different
		this.internalSampleRate = bitstream.codecInfo.codec === 'opus'
			? OPUS_SAMPLE_RATE
			: bitstream.sampleRate;
	}

	getType() {
		return 'audio' as const;
	}

	getId() {
		return this.bitstream.serialNumber;
	}

	getNumber() {
		// All Ogg tracks are audio, so the track's index + 1 is its number
		const index = this.demuxer.trackBackings.findIndex(
			x => x.bitstream === this.bitstream,
		);
		assert(index !== -1);

		return index + 1;
	}

	getNumberOfChannels() {
		return this.bitstream.numberOfChannels;
	}

	getSampleRate() {
		return this.bitstream.sampleRate;
	}

	getTimeResolution() {
		return this.bitstream.sampleRate;
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
		return null; // Not stored anywhere
	}

	async getLiveRefreshInterval() {
		return null;
	}

	getCodec() {
		return this.bitstream.codecInfo.codec;
	}

	getInternalCodecId() {
		return null;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		assert(this.bitstream.codecInfo.codec);

		return {
			codec: this.bitstream.codecInfo.codec,
			numberOfChannels: this.bitstream.numberOfChannels,
			sampleRate: this.bitstream.sampleRate,
			description: this.bitstream.description ?? undefined,
		};
	}

	getName() {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getDisposition(): TrackDisposition {
		return {
			...DEFAULT_TRACK_DISPOSITION,
			primary: false,
		};
	}

	granulePositionToTimestampInSamples(link: Pick<OggLink, 'bitstream' | 'offsetInSamples'>, granulePosition: number) {
		if (link.bitstream.codecInfo.codec === 'opus') {
			assert(link.bitstream.codecInfo.opusInfo);
			return link.offsetInSamples + granulePosition - link.bitstream.codecInfo.opusInfo.preSkip;
		}

		return link.offsetInSamples + granulePosition;
	}

	createEncodedPacketFromOggPacket(
		packet: Packet | null,
		additional: {
			link: OggLink;
			timestampInSamples: number;
			vorbisLastBlocksize: number | null;
		},
		options: PacketRetrievalOptions,
	) {
		if (!packet) {
			return null;
		}

		const sampleMetadata = extractSampleMetadata(
			packet.data,
			additional.link.bitstream.codecInfo,
			additional.vorbisLastBlocksize,
		);
		const { vorbisBlockSize } = sampleMetadata;
		let { durationInSamples } = sampleMetadata;

		const isEos = !!(packet.endPage.headerType & 0x04);
		if (isEos && packet.endSegmentIndex === packet.endPage.lacingValues.length - 1) {
			// This is the last packet of the bitstream. The final page's granule position may be smaller than what
			// the packet durations imply, in which case the excess samples at the end are to be trimmed.
			const endTimestampInSamples = this.granulePositionToTimestampInSamples(
				additional.link,
				packet.endPage.granulePosition,
			);
			durationInSamples = clamp(endTimestampInSamples - additional.timestampInSamples, 0, durationInSamples);
		}

		const encodedPacket = new EncodedPacket(
			options.metadataOnly ? PLACEHOLDER_DATA : packet.data,
			'key',
			additional.timestampInSamples / this.internalSampleRate,
			durationInSamples / this.internalSampleRate,
			packet.endPage.headerStartPos + packet.endSegmentIndex,
			packet.data.byteLength,
		);

		this.encodedPacketToMetadata.set(encodedPacket, {
			packet,
			link: additional.link,
			timestampInSamples: additional.timestampInSamples,
			durationInSamples,
			vorbisLastBlockSize: additional.vorbisLastBlocksize,
			vorbisBlockSize,
		});
		return encodedPacket;
	}

	getFirstLink() {
		return this.firstLinkPromise ??= (async (): Promise<OggLink> => ({
			bitstream: this.bitstream,
			offsetInSamples: 0,
			firstTimestampInSamples: await this.computeStartInSamples(this.bitstream, null),
			initialVorbisLastBlocksize: null,
			endPos: null,
			nextLinks: new Map(),
		}))();
	}

	/** Computes the timestamp of a bitstream's first packet, as derived from its own granule positions. */
	async computeStartInSamples(bitstream: LogicalBitstream, initialVorbisLastBlocksize: number | null) {
		const ownTimeline = { bitstream, offsetInSamples: 0 };
		const defaultTimestampInSamples = this.granulePositionToTimestampInSamples(ownTimeline, 0);

		assert(bitstream.lastMetadataPacket);
		let position = await this.demuxer.findNextPacketStart(bitstream.lastMetadataPacket);
		if (!position) {
			return defaultTimestampInSamples;
		}

		// The first page on which a packet completes may have a granule position larger than the number of
		// samples in the packets completing on it, meaning the stream starts at a later time. So, let's sum up the
		// durations of these packets and compare.
		let firstEndPage: Page | null = null;
		let totalDurationInSamples = 0;
		let firstPacketDurationInSamples: number | null = null;
		let vorbisLastBlocksize = initialVorbisLastBlocksize;

		while (position) {
			const packet = await this.demuxer.readPacket(position.startPage, position.startSegmentIndex);
			if (!packet) {
				break;
			}

			firstEndPage ??= packet.endPage;
			if (packet.endPage.headerStartPos !== firstEndPage.headerStartPos) {
				break;
			}

			const { durationInSamples, vorbisBlockSize } = extractSampleMetadata(
				packet.data,
				bitstream.codecInfo,
				vorbisLastBlocksize,
			);
			totalDurationInSamples += durationInSamples;
			firstPacketDurationInSamples ??= durationInSamples;
			vorbisLastBlocksize = vorbisBlockSize;

			position = await this.demuxer.findNextPacketStart(packet);
		}

		if (!firstEndPage) {
			return defaultTimestampInSamples;
		}
		assert(firstPacketDurationInSamples !== null);

		// A smaller granule position is only legal on the final page, where it signals end trimming. The Vorbis
		// priming packet decodes to nothing though, so it's allowed to precede the granule position's origin.
		const minStartInSamples = bitstream.codecInfo.codec === 'vorbis'
			? -firstPacketDurationInSamples
			: 0;
		return defaultTimestampInSamples
			+ Math.max(firstEndPage.granulePosition - totalDurationInSamples, minStartInSamples);
	}

	/**
	 * Returns the link that follows the given one, if the file continues with a link that this track can continue
	 * into. `end` is where the given link ends, which was reached by reading on from the link's start if
	 * `isSequential`.
	 */
	getNextLink(
		link: OggLink,
		end: { lastPage: Page; timestampInSamples: number; vorbisBlockSize: number | null },
		isSequential: boolean,
	) {
		const endPos = end.lastPage.headerStartPos + end.lastPage.totalSize;
		if (isSequential) {
			link.endPos ??= endPos;
		}

		let nextPromise = link.nextLinks.get(endPos);
		if (nextPromise) {
			return nextPromise;
		}

		nextPromise = (async () => {
			const bitstream = await this.demuxer.readChainedLink(endPos);
			if (!bitstream) {
				return null; // The file doesn't continue with another link
			}

			const incompatibility = this.getLinkIncompatibility(bitstream);
			if (incompatibility) {
				if (!this.warnedAboutIncompatibleLink) {
					this.warnedAboutIncompatibleLink = true;
					Logging._warn(
						'Ogg: The track ends before the chained logical bitstream at byte'
						+ ` ${bitstream.bosPage.headerStartPos}, which ${incompatibility}.`,
					);
				}

				return null;
			}

			// The link's first packet continues the track right where the previous link ended. The decoder isn't
			// reset in between, so the samples that the encoder's pre-skip (or the Vorbis priming packet) would discard
			// at the start of a stream are played, as Chrome does too: discarding them would need timestamps that
			// overlap the previous link and may go backwards, which muxers reject. These are only a few milliseconds,
			// as links with a larger, cropping pre-skip aren't continued into. A later start (as in a live capture)
			// would leave a gap, so it's not kept either.
			const startInSamples = await this.computeStartInSamples(bitstream, end.vorbisBlockSize);

			return {
				bitstream,
				offsetInSamples: end.timestampInSamples - startInSamples,
				firstTimestampInSamples: end.timestampInSamples,
				initialVorbisLastBlocksize: end.vorbisBlockSize,
				// Reading the link stops at a damaged page, so lookups must not look past it either
				endPos: await this.demuxer.findIntactLinkEnd(bitstream),
				nextLinks: new Map(),
			};
		})();
		link.nextLinks.set(endPos, nextPromise);

		return nextPromise;
	}

	/**
	 * Returns why the track can't continue into the given link, or null if it can: the decoder configured for the
	 * track's first link must be able to decode it, and its start must not be cropped.
	 */
	getLinkIncompatibility(bitstream: LogicalBitstream) {
		const first = this.bitstream;
		if (bitstream.serialNumber === first.serialNumber) {
			return 'reuses the serial number';
		}

		const differentCodecParameters = 'has different codec parameters or damaged headers';
		if (
			bitstream.codecInfo.codec !== first.codecInfo.codec
			|| bitstream.numberOfChannels !== first.numberOfChannels
			|| bitstream.sampleRate !== first.sampleRate
		) {
			return differentCodecParameters;
		}

		const [firstIdentification, firstSetup] = first.headerPackets;
		const [identification, setup] = bitstream.headerPackets;
		assert(firstIdentification && identification);

		if (first.codecInfo.codec === 'opus') {
			// Everything but the pre-skip and the input sample rate (bytes 10 to 15) must match
			const sameHeader = identification.length === firstIdentification.length
				&& identification.every((byte, i) => (i >= 10 && i < 16) || byte === firstIdentification[i]);
			if (!sameHeader) {
				return differentCodecParameters;
			}

			// A pre-skip larger than any encoder's delay crops the start of the link (RFC 7845, section 4.2).
			// Discarding those samples would take dropping decoded audio in the middle of the track, which isn't
			// supported, and playing them would add audio that isn't part of the link.
			assert(bitstream.codecInfo.opusInfo);
			const preSkip = bitstream.codecInfo.opusInfo.preSkip;
			if (preSkip > MAX_ENCODER_PRE_SKIP) {
				return `has a pre-skip of ${preSkip} samples that crops its start (not supported mid-track)`;
			}

			return null;
		}

		// Vorbis: the same block sizes, and the same setup header with its codebooks and modes
		assert(firstSetup && setup);
		const sameHeaders = identification[28] === firstIdentification[28]
			&& setup.length === firstSetup.length
			&& setup.every((byte, i) => byte === firstSetup[i]);
		return sameHeaders ? null : differentCodecParameters;
	}

	async getFirstPacket(options: PacketRetrievalOptions) {
		assert(this.bitstream.lastMetadataPacket);
		const packetPosition = await this.demuxer.findNextPacketStart(this.bitstream.lastMetadataPacket);
		if (!packetPosition) {
			return null;
		}

		const link = await this.getFirstLink();
		const packet = await this.demuxer.readPacket(packetPosition.startPage, packetPosition.startSegmentIndex);

		return this.createEncodedPacketFromOggPacket(
			packet,
			{
				link,
				timestampInSamples: link.firstTimestampInSamples,
				vorbisLastBlocksize: null,
			},
			options,
		);
	}

	async getNextPacket(prevPacket: EncodedPacket, options: PacketRetrievalOptions) {
		const prevMetadata = this.encodedPacketToMetadata.get(prevPacket);
		if (!prevMetadata) {
			throw new Error('Packet was not created from this track.');
		}

		let link = prevMetadata.link;
		let timestampInSamples = prevMetadata.timestampInSamples + prevMetadata.durationInSamples;
		const vorbisLastBlocksize = prevMetadata.vorbisBlockSize;

		let packetPosition = await this.demuxer.findNextPacketStart(prevMetadata.packet);
		if (!packetPosition) {
			// The link has ended, but the track may continue in the next one
			const nextLink = await this.getNextLink(link, {
				lastPage: prevMetadata.packet.endPage,
				timestampInSamples,
				vorbisBlockSize: prevMetadata.vorbisBlockSize,
			}, true);
			if (!nextLink) {
				return null;
			}

			assert(nextLink.bitstream.lastMetadataPacket);
			packetPosition = await this.demuxer.findNextPacketStart(nextLink.bitstream.lastMetadataPacket);
			if (!packetPosition) {
				return null;
			}

			link = nextLink;
			timestampInSamples = nextLink.firstTimestampInSamples;
		}

		const packet = await this.demuxer.readPacket(
			packetPosition.startPage,
			packetPosition.startSegmentIndex,
		);

		return this.createEncodedPacketFromOggPacket(
			packet,
			{
				link,
				timestampInSamples,
				vorbisLastBlocksize,
			},
			options,
		);
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		if (this.demuxer.reader.fileSize === null) {
			// No file size known, can't do binary search, but fall back to sequential algo instead
			return this.getPacketSequential(timestamp, options);
		}

		const timestampInSamples = roundIfAlmostInteger(timestamp * this.internalSampleRate);
		let link = await this.getFirstLink();
		if (timestampInSamples === link.firstTimestampInSamples) {
			// Fast path for the first timestamp - avoids binary search when playing back from the start
			return this.getFirstPacket(options);
		}
		if (timestampInSamples < link.firstTimestampInSamples) {
			// There's nothing here
			return null;
		}

		let previousLink: OggLink | null = null;

		while (true) {
			const knownNextLink = link.endPos !== null ? link.nextLinks.get(link.endPos) : undefined;
			if (knownNextLink) {
				// We already know where the next link starts, so we can skip this one if the timestamp lies past it
				const nextLink = await knownNextLink;
				if (nextLink && timestampInSamples >= nextLink.firstTimestampInSamples) {
					previousLink = link;
					link = nextLink;
					continue;
				}
			}

			const packet = await this.getPacketInLink(link, timestampInSamples, options);
			if (!packet) {
				// A later link whose first packet can't be read (as it's damaged) ends the track, like in iteration
				return previousLink && this.getPacketInLink(previousLink, timestampInSamples, options);
			}

			const metadata = this.encodedPacketToMetadata.get(packet);
			assert(metadata);

			if (await this.demuxer.findNextPacketStart(metadata.packet)) {
				return packet;
			}

			// This is the link's last packet, and the timestamp might lie in the next link, which starts at its end
			const nextLink = await this.getNextLink(link, {
				lastPage: metadata.packet.endPage,
				timestampInSamples: metadata.timestampInSamples + metadata.durationInSamples,
				vorbisBlockSize: metadata.vorbisBlockSize,
			}, false);
			if (!nextLink || timestampInSamples < nextLink.firstTimestampInSamples) {
				return packet;
			}

			previousLink = link;
			link = nextLink;
		}
	}

	/**
	 * Reads on from the link's first packet like iteration does, and returns where its last packet's page ends, or null
	 * if the link goes on past `maxEndPos`.
	 */
	async findLinkEndSequentially(link: OggLink, maxEndPos = Infinity) {
		assert(link.bitstream.lastMetadataPacket);
		let position = await this.demuxer.findNextPacketStart(link.bitstream.lastMetadataPacket);
		let lastPage = link.bitstream.lastMetadataPacket.endPage;

		while (position) {
			if (position.startPage.headerStartPos > maxEndPos) {
				return null;
			}

			const packet = await this.demuxer.readPacket(position.startPage, position.startSegmentIndex);
			if (!packet) {
				break;
			}

			lastPage = packet.endPage;
			position = await this.demuxer.findNextPacketStart(packet);
		}

		return lastPage.headerStartPos + lastPage.totalSize;
	}

	/** Finds the last packet of the given link with a timestamp less than or equal to the given one. */
	async getPacketInLink(
		link: OggLink,
		timestampInSamples: number,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		assert(this.demuxer.reader.fileSize !== null);
		const firstTimestampInSamples = link.firstTimestampInSamples;

		assert(link.bitstream.lastMetadataPacket);
		const startPosition = await this.demuxer.findNextPacketStart(link.bitstream.lastMetadataPacket);
		if (!startPosition) {
			return null;
		}

		if (link.bitstream === this.bitstream && !this.triedFindingFirstLinkEnd) {
			// A later link may reuse our serial number (RFC 3533 forbids that, but concatenating files does it), and
			// the bisection can't tell its pages from our link's. So let's try to find our link's end by reading on
			// from its start like iteration does, which is cheap for a short link like an intro or a jingle.
			this.triedFindingFirstLinkEnd = true;
			link.endPos ??= await this.findLinkEndSequentially(
				link,
				startPosition.startPage.headerStartPos + FIRST_LINK_SCAN_SIZE,
			);
		}

		let lowPage = startPosition.startPage;
		let high = link.endPos ?? this.demuxer.reader.fileSize;

		const lowPages: Page[] = [lowPage];

		// First, let's perform a binary search (bisection search) on the file to find the approximate page where
		// we'll find the packet. We want to find a page whose end packet position is less than or equal to the
		// packet position we're searching for.

		// Outer loop: Does the binary search
		outer:
		while (lowPage.headerStartPos + lowPage.totalSize < high) {
			const low = lowPage.headerStartPos;
			const mid = Math.floor((low + high) / 2);

			let searchStartPos = mid;

			// Inner loop: Does a linear forward scan if the page cannot be found immediately
			while (true) {
				const until = Math.min(
					searchStartPos + MAX_PAGE_SIZE,
					high - MIN_PAGE_HEADER_SIZE,
				);

				let searchSlice = this.demuxer.reader.requestSlice(searchStartPos, Math.max(until - searchStartPos, 0));
				if (isThenable(searchSlice)) searchSlice = await searchSlice;

				if (!searchSlice || !findNextPageHeader(searchSlice, until, link.bitstream.serialNumber)) {
					if (high <= mid + MIN_PAGE_HEADER_SIZE) {
						// The range can't be narrowed any further
						break outer;
					}

					high = mid + MIN_PAGE_HEADER_SIZE;
					continue outer;
				}

				const pageStartPos = searchSlice.filePos;

				let headerSlice = this.demuxer.reader.requestSliceRange(
					pageStartPos,
					MIN_PAGE_HEADER_SIZE,
					MAX_PAGE_HEADER_SIZE,
				);
				if (isThenable(headerSlice)) headerSlice = await headerSlice;
				const page = headerSlice && readPageHeader(headerSlice);

				// Serial numbers are basically random numbers, and the chance of finding a fake page with matching
				// serial number is astronomically low, so we can be pretty sure a page with our serial is legit.
				// Pages of other bitstreams (or junk) we simply scan past; validating them via their checksum instead
				// could be abused to make us checksum huge amounts of data over and over.
				if (!page || page.serialNumber !== link.bitstream.serialNumber) {
					searchStartPos = pageStartPos + 4; // 'OggS' is 4 bytes
					continue;
				}

				// A page of our serial number that begins a logical bitstream, or that numbers its pages anew, belongs
				// to a later chained link reusing the serial number (RFC 3533 forbids that, but concatenating a file
				// with itself makes it), so our link ends before it
				if ((page.headerType & 0x02) || page.sequenceNumber <= lowPage.sequenceNumber) {
					if (link.endPos === null) {
						// The bisection may already have landed on other pages of such a link, as they can't be told
						// apart from our link's own, so let's find our link's end by reading on from its start like
						// iteration does, and search again before it
						link.endPos = await this.findLinkEndSequentially(link);
						return this.getPacketInLink(link, timestampInSamples, options);
					}

					high = page.headerStartPos;
					continue outer;
				}

				const isContinuationPage = page.granulePosition === -1;
				if (isContinuationPage) {
					// No packet ends on this page - keep looking
					searchStartPos = page.headerStartPos + page.totalSize;
					continue;
				}

				// The page is valid and belongs to our bitstream; let's check its granule position to see where we
				// need to take the bisection search.
				if (this.granulePositionToTimestampInSamples(link, page.granulePosition) > timestampInSamples) {
					high = page.headerStartPos;
				} else {
					lowPage = page;
					lowPages.push(page);
				}

				continue outer;
			}
		}

		// Now we have the last page with a packet position <= the packet position we're looking for, but there
		// might be multiple pages with the packet position, in which case we actually need to find the first of
		// such pages. We'll do this in two steps: First, let's find the latest page we know with an earlier packet
		// position, and then linear scan ourselves forward until we find the correct page.

		let lowerPage = startPosition.startPage;
		for (const otherLowPage of lowPages) {
			if (otherLowPage.granulePosition === lowPage.granulePosition) {
				break;
			}

			if (!lowerPage || otherLowPage.headerStartPos > lowerPage.headerStartPos) {
				lowerPage = otherLowPage;
			}
		}

		let currentPage = lowerPage;
		// Keep track of the pages we traversed, we need these later for backwards seeking
		const previousPages: Page[] = [currentPage];

		while (true) {
			// This loop must terminate as we'll eventually reach lowPage
			if (
				currentPage.serialNumber === link.bitstream.serialNumber
				&& currentPage.granulePosition === lowPage.granulePosition
			) {
				break;
			}

			const nextPos = currentPage.headerStartPos + currentPage.totalSize;
			let slice = this.demuxer.reader.requestSliceRange(nextPos, MIN_PAGE_HEADER_SIZE, MAX_PAGE_HEADER_SIZE);
			if (isThenable(slice)) slice = await slice;

			const nextPage = slice && readPageHeader(slice);
			if (!nextPage) {
				// There's junk between the pages, so we can't walk any further. Let's just jump to the page we know.
				currentPage = lowPage;
				previousPages.push(lowPage);
				break;
			}

			currentPage = nextPage;

			if (currentPage.serialNumber === link.bitstream.serialNumber) {
				previousPages.push(currentPage);
			}
		}

		let currentSegmentIndex: number | null = null;
		let currentTimestampInSamples: number;
		let currentTimestampIsCorrect: boolean;

		// These indicate the end position of the packet that the granule position belongs to
		let endPage = currentPage;
		let endSegmentIndex = 0;

		if (currentPage.headerStartPos === startPosition.startPage.headerStartPos) {
			currentTimestampInSamples = firstTimestampInSamples;
			currentTimestampIsCorrect = true;
			currentSegmentIndex = 0;
		} else {
			// Holds since lowPage, if not the start page, came out of the bisection, which skips such pages
			assert(currentPage.granulePosition !== -1);

			currentTimestampInSamples = 0; // Placeholder value! We'll refine it once we can
			currentTimestampIsCorrect = false;

			// Find the segment index of the next packet
			for (let i = currentPage.lacingValues.length - 1; i >= 0; i--) {
				const value = currentPage.lacingValues[i]!;
				if (value < 255) {
					// We know the last packet ended at i, so the next one starts at i + 1
					currentSegmentIndex = i + 1;
					break;
				}
			}

			// This must hold: Since this page has a granule position set, that means there must be a packet that
			// ends in this page.
			if (currentSegmentIndex === null) {
				throw new Error('Invalid page with granule position: no packets end on this page.');
			}

			endSegmentIndex = currentSegmentIndex - 1;
			const pseudopacket: Packet = {
				data: PLACEHOLDER_DATA,
				endPage,
				endSegmentIndex,
			};
			const nextPosition = await this.demuxer.findNextPacketStart(pseudopacket);

			if (nextPosition) {
				// Let's rewind a single step (packet) - this previous packet ensures that we'll correctly compute
				// the duration for the packet we're looking for.
				const endPosition = findPreviousPacketEndPosition(previousPages, currentPage, currentSegmentIndex);
				assert(endPosition);

				const startPosition = findPacketStartPosition(
					previousPages, endPosition.page, endPosition.segmentIndex,
				);
				if (startPosition) {
					currentPage = startPosition.page;
					currentSegmentIndex = startPosition.segmentIndex;
				} else {
					// The page chain is broken, so we can't step back; let's just start at the next packet then
					currentPage = nextPosition.startPage;
					currentSegmentIndex = nextPosition.startSegmentIndex;
				}
			} else {
				// There is no next position, which means we're looking for the last packet in the bitstream. The
				// granule position on the last page tends to be fucky, so let's instead start the search on the
				// page before that. So let's loop until we find a packet that ends in a previous page.
				while (true) {
					const endPosition = findPreviousPacketEndPosition(
						previousPages, currentPage, currentSegmentIndex,
					);
					if (!endPosition) {
						break;
					}

					const startPosition = findPacketStartPosition(
						previousPages, endPosition.page, endPosition.segmentIndex,
					);
					if (!startPosition) {
						break;
					}

					currentPage = startPosition.page;
					currentSegmentIndex = startPosition.segmentIndex;

					if (endPosition.page.headerStartPos !== endPage.headerStartPos) {
						endPage = endPosition.page;
						endSegmentIndex = endPosition.segmentIndex;
						break;
					}
				}
			}
		}

		let lastEncodedPacket: EncodedPacket | null = null;
		let lastEncodedPacketMetadata: EncodedPacketMetadata | null = null;

		// Alright, now it's time for the final, granular seek: We keep iterating over packets until we've found the
		// one with the correct timestamp - i.e., the last one with a timestamp <= the timestamp we're looking for.
		while (currentPage !== null) {
			assert(currentSegmentIndex !== null);

			const packet = await this.demuxer.readPacket(currentPage, currentSegmentIndex);
			if (!packet) {
				break;
			}

			// We might need to skip the packet if it's a metadata one
			const skipPacket = currentPage.headerStartPos === startPosition.startPage.headerStartPos
				&& currentSegmentIndex < startPosition.startSegmentIndex;

			if (!skipPacket) {
				let encodedPacket = this.createEncodedPacketFromOggPacket(
					packet,
					{
						link,
						timestampInSamples: currentTimestampInSamples,
						vorbisLastBlocksize: lastEncodedPacketMetadata
							? lastEncodedPacketMetadata.vorbisBlockSize
							// At the link's start, continue from the previous link
							: currentTimestampIsCorrect ? link.initialVorbisLastBlocksize : null,
					},
					options,
				);
				assert(encodedPacket);

				let encodedPacketMetadata = this.encodedPacketToMetadata.get(encodedPacket);
				assert(encodedPacketMetadata);

				if (
					!currentTimestampIsCorrect
					&& packet.endPage.headerStartPos === endPage.headerStartPos
					&& packet.endSegmentIndex === endSegmentIndex
				) {
					// We know this packet end timestamp can be derived from the page's granule position
					currentTimestampInSamples = this.granulePositionToTimestampInSamples(
						link,
						currentPage.granulePosition,
					);
					currentTimestampIsCorrect = true;

					// Let's backpatch the packet we just created with the correct timestamp
					encodedPacket = this.createEncodedPacketFromOggPacket(
						packet,
						{
							link,
							timestampInSamples: currentTimestampInSamples - encodedPacketMetadata.durationInSamples,
							vorbisLastBlocksize: lastEncodedPacketMetadata?.vorbisBlockSize ?? null,
						},
						options,
					);
					assert(encodedPacket);

					encodedPacketMetadata = this.encodedPacketToMetadata.get(encodedPacket);
					assert(encodedPacketMetadata);
				} else {
					currentTimestampInSamples += encodedPacketMetadata.durationInSamples;
				}

				lastEncodedPacket = encodedPacket;
				lastEncodedPacketMetadata = encodedPacketMetadata;

				if (
					currentTimestampIsCorrect
					&& (
						// Next timestamp will be too late
						currentTimestampInSamples > timestampInSamples
						// This timestamp already matches
						|| encodedPacketMetadata.timestampInSamples === timestampInSamples
					)
				) {
					break;
				}
			}

			const nextPosition = await this.demuxer.findNextPacketStart(packet);
			if (!nextPosition) {
				break;
			}

			currentPage = nextPosition.startPage;
			currentSegmentIndex = nextPosition.startSegmentIndex;
		}

		return lastEncodedPacket;
	}

	// A slower but simpler and sequential algorithm for finding a packet in a file
	async getPacketSequential(timestamp: number, options: PacketRetrievalOptions) {
		const release = await this.sequentialScanMutex.acquire(); // Requires exclusivity because we write to a cache

		try {
			const timestampInSamples = roundIfAlmostInteger(timestamp * this.internalSampleRate);
			timestamp = timestampInSamples / this.internalSampleRate;

			const index = binarySearchLessOrEqual(
				this.sequentialScanCache,
				timestampInSamples,
				x => x.timestampInSamples,
			);

			let currentPacket: EncodedPacket | null;
			if (index !== -1) {
				// We don't need to start from the beginning, we can start at a previous scan point
				const cacheEntry = this.sequentialScanCache[index]!;
				currentPacket = this.createEncodedPacketFromOggPacket(
					cacheEntry.packet,
					{
						link: cacheEntry.link,
						timestampInSamples: cacheEntry.timestampInSamples,
						vorbisLastBlocksize: cacheEntry.vorbisLastBlockSize,
					},
					options,
				);
			} else {
				currentPacket = await this.getFirstPacket(options);
				if (currentPacket && currentPacket.timestamp > timestamp) {
					// The stream starts after the requested timestamp
					return null;
				}
			}

			let i = 0;

			while (currentPacket && currentPacket.timestamp < timestamp) {
				const nextPacket = await this.getNextPacket(currentPacket, options);
				if (!nextPacket || nextPacket.timestamp > timestamp) {
					break;
				}

				currentPacket = nextPacket;
				i++;

				if (i === 100) {
					// Add "checkpoints" every once in a while to speed up subsequent random accesses
					i = 0;
					const metadata = this.encodedPacketToMetadata.get(currentPacket);
					assert(metadata);

					if (this.sequentialScanCache.length > 0) {
						// If we reach this case, we must be at the end of the cache
						assert(last(this.sequentialScanCache)!.timestampInSamples <= metadata.timestampInSamples);
					}

					this.sequentialScanCache.push(metadata);
				}
			}

			return currentPacket;
		} finally {
			release();
		}
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		return this.getPacket(timestamp, options);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		return this.getNextPacket(packet, options);
	}
}

/** Finds the start position of a packet given its end position. */
const findPacketStartPosition = (pageList: Page[], endPage: Page, endSegmentIndex: number) => {
	let page = endPage;
	let segmentIndex = endSegmentIndex;

	outer:
	while (true) {
		segmentIndex--;

		for (segmentIndex; segmentIndex >= 0; segmentIndex--) {
			const lacingValue = page.lacingValues[segmentIndex]!;
			if (lacingValue < 255) {
				segmentIndex++; // We know the last packet starts here
				break outer;
			}
		}

		assert(segmentIndex === -1);

		const pageStartsWithFreshPacket = !(page.headerType & 0x01);
		if (pageStartsWithFreshPacket) {
			// Fast exit: We know we don't need to look in the previous page
			segmentIndex = 0;
			break;
		}

		const previousPage = findLast(
			pageList,
			x => x.headerStartPos < page.headerStartPos,
		);
		if (!previousPage) {
			return null;
		}

		page = previousPage;
		segmentIndex = page.lacingValues.length;
	}

	assert(segmentIndex !== -1);

	if (segmentIndex === page.lacingValues.length) {
		// Wrap back around to the first segment of the next page
		const nextPage = pageList[pageList.indexOf(page) + 1];
		assert(nextPage);

		page = nextPage;
		segmentIndex = 0;
	}

	return { page, segmentIndex };
};

/** Finds the end position of a packet given the start position of the following packet. */
const findPreviousPacketEndPosition = (pageList: Page[], startPage: Page, startSegmentIndex: number) => {
	if (startSegmentIndex > 0) {
		// Easy
		return { page: startPage, segmentIndex: startSegmentIndex - 1 };
	}

	const previousPage = findLast(
		pageList,
		x => x.headerStartPos < startPage.headerStartPos,
	);
	if (!previousPage) {
		return null;
	}

	return { page: previousPage, segmentIndex: previousPage.lacingValues.length - 1 };
};
