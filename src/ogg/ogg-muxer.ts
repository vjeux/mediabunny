/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { OPUS_SAMPLE_RATE, validateAudioChunkMetadata } from '../codec';
import {
	createVorbisComments,
	OPUS_FRAME_DURATION_TABLE,
	parseModesFromVorbisSetupPacket,
	parseOpusIdentificationHeader,
} from '../codec-data';
import {
	assert,
	clamp,
	promiseWithResolvers,
	Queue,
	setInt64,
	toDataView,
	toUint8Array,
} from '../misc';
import { Muxer } from '../muxer';
import { Output,
	OutputAudioTrack,
	OutputTrack } from '../output';
import { OggOutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { Writer } from '../writer';
import {
	buildOggMimeType,
	computeOggPageCrc,
	extractSampleMetadata,
	OggCodecInfo,
	OGGS,
} from './ogg-misc';
import { MAX_PAGE_SIZE } from './ogg-reader';

const PAGE_SIZE_TARGET = 8192;
const OPUS_MIN_FRAME_DURATION = 120; // 2.5 ms in 48 kHz samples

/**
 * Creates packets of empty (zero-byte) frames spanning the given duration, which must be a multiple of 2.5 ms.
 * Following RFC 7845, section 4.1, they keep the previous packet's configuration for as long as possible and switch to
 * shorter CELT frames only at the end, if needed.
 */
const createOpusGapPackets = (durationInSamples: number, previousTocByte: number) => {
	const packets: Uint8Array[] = [];
	const stereoFlag = previousTocByte & 0b100;

	const addFrames = (config: number, frameCount: number) => {
		const frameDuration = OPUS_FRAME_DURATION_TABLE[config]!;
		// A packet holds at most 48 frames and at most 120 ms
		const maxFramesPerPacket = Math.min(48, Math.floor(5760 / frameDuration));
		const tocByte = (config << 3) | stereoFlag;

		while (frameCount > 0) {
			const count = Math.min(frameCount, maxFramesPerPacket);
			packets.push(count === 1
				? new Uint8Array([tocByte]) // Code 0: one frame, which is empty
				: new Uint8Array([tocByte | 0b11, count])); // Code 3, constant bitrate: `count` empty frames
			frameCount -= count;
		}
	};

	let remaining = durationInSamples;
	const previousConfig = previousTocByte >> 3;
	const previousFrameDuration = OPUS_FRAME_DURATION_TABLE[previousConfig]!;
	addFrames(previousConfig, Math.floor(remaining / previousFrameDuration));
	remaining %= previousFrameDuration;

	// The rest goes into CELT frames (configurations 16-31, 2.5 to 20 ms), keeping a CELT stream's bandwidth and using
	// wideband after SILK or Hybrid frames
	const celtBaseConfig = previousConfig >= 16 ? previousConfig & ~0b11 : 20;
	for (let i = 3; i >= 0; i--) {
		const config = celtBaseConfig + i;
		const frameDuration = OPUS_FRAME_DURATION_TABLE[config]!;
		addFrames(config, Math.floor(remaining / frameDuration));
		remaining %= frameDuration;
	}

	assert(remaining === 0);
	return packets;
};

type OggTrackData = {
	track: OutputAudioTrack;
	serialNumber: number;
	internalSampleRate: number;
	codecInfo: OggCodecInfo;
	vorbisLastBlocksize: number | null;
	packetQueue: Queue<Packet>;
	startOffsetInSamples: number | null;
	currentTimestampInSamples: number;
	/** Maps packet timestamps (in samples) onto `currentTimestampInSamples`. */
	timestampOffsetInSamples: number;
	lastOpusTocByte: number | null;
	audioPacketCount: number;
	pagesWritten: number;

	currentGranulePosition: number;
	currentLacingValues: number[];
	currentPageData: Uint8Array[];
	currentPageSize: number;
	currentPageStartsWithFreshPacket: boolean;
	currentPageStartTimestampInSamples: number;
	closed: boolean;
};

type Packet = {
	data: Uint8Array;
	timestampInSamples: number;
	durationInSamples: number;
	trimmedDurationInSamples: number;
	forcePageFlush: boolean;
};

export class OggMuxer extends Muxer {
	private format: OggOutputFormat;
	private writer!: Writer;

	private trackDatas: OggTrackData[] = [];
	private bosPagesWritten = false;
	private allTracksKnown = promiseWithResolvers();
	/**
	 * Tracks whose closing we have processed. Unlike `source._closed`, which is set as soon as `close()` is called,
	 * this is only set under the mutex, i.e. after the packets queued before the close have been added.
	 */
	private closedTracks = new Set<OutputTrack>();

	private pageBytes = new Uint8Array(MAX_PAGE_SIZE);
	private pageView = new DataView(this.pageBytes.buffer);

	constructor(output: Output, format: OggOutputFormat) {
		super(output);

		this.format = format;
	}

	async start() {
		const release = await this.mutex.acquire();

		this.writer = await this.output._getRootWriter(true); // Ogg is always monotonically written!

		for (const track of this.output.tracks) {
			assert(track.isAudioTrack());
			if (track.metadata.decoderConfig) {
				this.getTrackData(track, { decoderConfig: track.metadata.decoderConfig });
			}
		}

		release();
	}

	async getMimeType() {
		await this.allTracksKnown.promise;

		return buildOggMimeType({
			codecStrings: this.trackDatas.map(x => x.codecInfo.codec!),
		});
	}

	addEncodedVideoPacket(): never {
		throw new Error('Video tracks are not supported.');
	}

	private getTrackData(track: OutputAudioTrack, meta?: EncodedAudioChunkMetadata) {
		const existingTrackData = this.trackDatas.find(td => td.track === track);
		if (existingTrackData) {
			return existingTrackData;
		}

		// Give the track a unique random serial number
		let serialNumber: number;
		do {
			serialNumber = Math.floor(2 ** 32 * Math.random());
		} while (this.trackDatas.some(td => td.serialNumber === serialNumber));

		assert(track.source._codec === 'vorbis' || track.source._codec === 'opus');

		validateAudioChunkMetadata(meta, track.source._codec);

		assert(meta);
		assert(meta.decoderConfig);

		const newTrackData: OggTrackData = {
			track,
			serialNumber,
			internalSampleRate: track.source._codec === 'opus'
				? OPUS_SAMPLE_RATE
				: meta.decoderConfig.sampleRate,
			codecInfo: {
				codec: track.source._codec,
				vorbisInfo: null,
				opusInfo: null,
			},
			vorbisLastBlocksize: null,
			packetQueue: new Queue(),
			startOffsetInSamples: null,
			currentTimestampInSamples: 0,
			timestampOffsetInSamples: 0,
			lastOpusTocByte: null,
			audioPacketCount: 0,
			pagesWritten: 0,

			currentGranulePosition: 0,
			currentLacingValues: [],
			currentPageData: [],
			currentPageSize: 27,
			currentPageStartsWithFreshPacket: true,
			currentPageStartTimestampInSamples: 0,
			closed: false,
		};

		this.queueHeaderPackets(newTrackData, meta);

		this.trackDatas.push(newTrackData);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	private queueHeaderPackets(trackData: OggTrackData, meta: EncodedAudioChunkMetadata) {
		assert(meta.decoderConfig);

		if (trackData.track.source._codec === 'vorbis') {
			assert(meta.decoderConfig.description);

			const bytes = toUint8Array(meta.decoderConfig.description);
			if (bytes[0] !== 2) {
				throw new TypeError('First byte of Vorbis decoder description must be 2.');
			}

			let pos = 1;
			const readPacketLength = () => {
				let length = 0;

				while (true) {
					const value = bytes[pos++];
					if (value === undefined) {
						throw new TypeError('Vorbis decoder description is too short.');
					}

					length += value;

					if (value < 255) {
						return length;
					}
				}
			};

			const identificationHeaderLength = readPacketLength();
			const commentHeaderLength = readPacketLength();
			const setupHeaderLength = bytes.length - pos; // Setup header fills the remaining bytes

			if (setupHeaderLength <= 0) {
				throw new TypeError('Vorbis decoder description is too short.');
			}

			const identificationHeader = bytes.subarray(pos, pos += identificationHeaderLength);
			pos += commentHeaderLength; // Skip the comment header, we'll build our own
			const setupHeader = bytes.subarray(pos);

			const commentHeaderHeader = new Uint8Array(7);
			commentHeaderHeader[0] = 3; // Packet type
			commentHeaderHeader[1] = 0x76; // 'v'
			commentHeaderHeader[2] = 0x6f; // 'o'
			commentHeaderHeader[3] = 0x72; // 'r'
			commentHeaderHeader[4] = 0x62; // 'b'
			commentHeaderHeader[5] = 0x69; // 'i'
			commentHeaderHeader[6] = 0x73; // 's'

			const commentHeader = createVorbisComments(commentHeaderHeader, this.output._metadataTags, true);

			trackData.packetQueue.push({
				data: identificationHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				trimmedDurationInSamples: 0,
				forcePageFlush: true,
			}, {
				data: commentHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				trimmedDurationInSamples: 0,
				forcePageFlush: false,
			}, {
				data: setupHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				trimmedDurationInSamples: 0,
				forcePageFlush: true, // The last header packet must flush the page
			});

			const view = toDataView(identificationHeader);
			const blockSizeByte = view.getUint8(28);

			trackData.codecInfo.vorbisInfo = {
				blocksizes: [
					1 << (blockSizeByte & 0xf),
					1 << (blockSizeByte >> 4),
				],
				modeBlockflags: parseModesFromVorbisSetupPacket(setupHeader).modeBlockflags,
			};
		} else if (trackData.track.source._codec === 'opus') {
			if (!meta.decoderConfig.description) {
				throw new TypeError('For Ogg, Opus decoder description is required.');
			}

			const identificationHeader = toUint8Array(meta.decoderConfig.description);

			const commentHeaderHeader = new Uint8Array(8);
			const commentHeaderHeaderView = toDataView(commentHeaderHeader);
			commentHeaderHeaderView.setUint32(0, 0x4f707573, false); // 'Opus'
			commentHeaderHeaderView.setUint32(4, 0x54616773, false); // 'Tags'
			const commentHeader = createVorbisComments(commentHeaderHeader, this.output._metadataTags, true);

			trackData.packetQueue.push({
				data: identificationHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				trimmedDurationInSamples: 0,
				forcePageFlush: true,
			}, {
				data: commentHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				trimmedDurationInSamples: 0,
				forcePageFlush: true, // The last header packet must flush the page
			});

			trackData.codecInfo.opusInfo = {
				preSkip: parseOpusIdentificationHeader(identificationHeader).preSkip,
			};
		}
	}

	async addEncodedAudioPacket(track: OutputAudioTrack, packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getTrackData(track, meta);

			this.validateTimestamp(trackData.track, packet.timestamp, packet.type === 'key');

			const { durationInSamples, vorbisBlockSize } = extractSampleMetadata(
				packet.data,
				trackData.codecInfo,
				trackData.vorbisLastBlocksize,
			);

			if (trackData.startOffsetInSamples === null) {
				// The first packet determines where the stream begins. Its timestamp includes the Opus pre-skip, which
				// offsets the granule position. For Vorbis, it is the priming packet that decodes to nothing. Granule
				// positions can't be negative, so the earliest representable start is the one where the audible part
				// begins at zero.
				const timestampInSamples = Math.round(packet.timestamp * trackData.internalSampleRate);
				const preSkip = trackData.codecInfo.opusInfo?.preSkip ?? 0;
				const minTimestampInSamples = trackData.codecInfo.codec === 'vorbis'
					? -durationInSamples
					: -preSkip;
				const startTimestampInSamples = Math.max(timestampInSamples, minTimestampInSamples);

				trackData.startOffsetInSamples = startTimestampInSamples - minTimestampInSamples;
				trackData.currentTimestampInSamples = startTimestampInSamples + preSkip;
				trackData.timestampOffsetInSamples = trackData.currentTimestampInSamples - timestampInSamples;
			}

			if (trackData.codecInfo.codec === 'opus') {
				// Granule positions must advance by exactly the samples in the packets (RFC 7845, section 4.1), so a
				// gap in the packet timestamps would silently pull all later audio forward. Instead, fill a gap of at
				// least one frame (as left by lost or paused packets) with synthesized packets of empty frames, which
				// decoders play out as packet loss concealment. Only multiples of 2.5 ms, the shortest Opus frame, can
				// be filled.
				const timestampInSamples = Math.round(packet.timestamp * trackData.internalSampleRate)
					+ trackData.timestampOffsetInSamples;
				const gapInSamples = timestampInSamples - trackData.currentTimestampInSamples;

				if (
					trackData.lastOpusTocByte !== null
					&& gapInSamples >= OPUS_FRAME_DURATION_TABLE[trackData.lastOpusTocByte >> 3]!
				) {
					const fillInSamples = gapInSamples - gapInSamples % OPUS_MIN_FRAME_DURATION;
					for (const data of createOpusGapPackets(fillInSamples, trackData.lastOpusTocByte)) {
						const { durationInSamples } = extractSampleMetadata(data, trackData.codecInfo, null);
						this.queueAudioPacket(trackData, data, durationInSamples, durationInSamples);
					}
				}

				trackData.lastOpusTocByte = packet.data[0]!;
			}

			trackData.vorbisLastBlocksize = vorbisBlockSize;

			// A shorter packet duration signals trailing samples to discard, which only the final packet can express
			const trimmedDurationInSamples = packet.duration > 0
				? clamp(Math.round(packet.duration * trackData.internalSampleRate), 0, durationInSamples)
				: durationInSamples;

			this.queueAudioPacket(trackData, packet.data, durationInSamples, trimmedDurationInSamples);

			await this.interleavePages();
		} finally {
			release();
		}
	}

	private queueAudioPacket(
		trackData: OggTrackData,
		data: Uint8Array,
		durationInSamples: number,
		trimmedDurationInSamples: number,
	) {
		assert(trackData.startOffsetInSamples !== null);

		// With a start offset, the second audio packet flushes the page. This keeps the offset from sharing a page
		// with end trimming, as both are signaled through the granule position and would be indistinguishable.
		// This mirrors a requirement of the Vorbis spec.
		const forcePageFlush = trackData.startOffsetInSamples > 0 && trackData.audioPacketCount === 1;
		trackData.audioPacketCount++;

		trackData.packetQueue.push({
			data,
			timestampInSamples: trackData.currentTimestampInSamples,
			durationInSamples,
			trimmedDurationInSamples,
			forcePageFlush,
		});
		trackData.currentTimestampInSamples += durationInSamples;
	}

	addSubtitleCue(): never {
		throw new Error('Subtitle tracks are not supported.');
	}

	allTracksAreKnown() {
		for (const track of this.output.tracks) {
			if (!this.closedTracks.has(track) && !this.trackDatas.some(x => x.track === track)) {
				return false; // We haven't seen a sample from this open track yet
			}
		}

		return true;
	}

	async interleavePages(isFinalCall = false) {
		if (!this.bosPagesWritten) {
			if (!this.allTracksAreKnown() && !isFinalCall) {
				return; // We can't interleave yet as we don't yet know how many tracks we'll truly have
			}

			// Write the header page for all bitstreams
			for (const trackData of this.trackDatas) {
				while (trackData.packetQueue.length > 0) {
					const packet = trackData.packetQueue.shift()!;
					this.writePacket(trackData, packet, false);

					if (packet.forcePageFlush) {
						// We say the header page ends once the first packet is encountered that forces a page flush
						break;
					}
				}
			}

			this.bosPagesWritten = true;
		}

		outer:
		while (true) {
			let trackWithMinTimestamp: OggTrackData | null = null;
			let minTimestamp = Infinity;

			for (const trackData of this.trackDatas) {
				if (
					!isFinalCall
					&& trackData.packetQueue.length <= 1 // Limit is 1, not 0, for correct EOS flag logic
					&& !trackData.closed
				) {
					break outer;
				}

				if (
					trackData.packetQueue.length > 0
					&& trackData.packetQueue.peek()!.timestampInSamples < minTimestamp
				) {
					trackWithMinTimestamp = trackData;
					minTimestamp = trackData.packetQueue.peek()!.timestampInSamples;
				}
			}

			if (!trackWithMinTimestamp) {
				break;
			}

			const packet = trackWithMinTimestamp.packetQueue.shift()!;
			const isFinalPacket = trackWithMinTimestamp.packetQueue.length === 0;

			this.writePacket(trackWithMinTimestamp, packet, isFinalPacket);
		}

		if (!isFinalCall) {
			await this.writer.flush();
		}
	}

	writePacket(trackData: OggTrackData, packet: Packet, isFinalPacket: boolean) {
		// The final page's granule position may end the stream before the final packet's decoded output does
		const packetEndTimestampInSamples = packet.timestampInSamples + (
			isFinalPacket
				? packet.trimmedDurationInSamples
				: packet.durationInSamples
		);

		if (trackData.currentLacingValues.length === 0) {
			trackData.currentPageStartTimestampInSamples = packet.timestampInSamples;
		}

		if (this.format._options.maximumPageDuration !== undefined) {
			const maxDurationInSamples = this.format._options.maximumPageDuration * trackData.internalSampleRate;

			if (
				trackData.currentLacingValues.length > 0
				&& packetEndTimestampInSamples - trackData.currentPageStartTimestampInSamples > maxDurationInSamples
			) {
				// Flush the current page early to avoid exceeding the maximum page duration
				this.writePage(trackData, false);
			}
		}

		let remainingLength = packet.data.length;
		let dataStartOffset = 0;
		let dataOffset = 0;

		while (true) {
			if (trackData.currentLacingValues.length === 0 && dataStartOffset > 0) {
				// This is a packet spanning multiple pages
				trackData.currentPageStartsWithFreshPacket = false;
			}

			const segmentSize = Math.min(255, remainingLength);
			trackData.currentLacingValues.push(segmentSize);
			trackData.currentPageSize++;
			dataOffset += segmentSize;

			const segmentIsLastOfPacket = remainingLength < 255;

			if (trackData.currentLacingValues.length === 255) {
				// The page is full, we need to add part of the packet data and then flush the page
				const slice = packet.data.subarray(dataStartOffset, dataOffset);
				dataStartOffset = dataOffset;
				trackData.currentPageData.push(slice);
				trackData.currentPageSize += slice.length;

				if (segmentIsLastOfPacket) {
					// The packet ends on this page, so the page's granule position must include it
					trackData.currentGranulePosition = packetEndTimestampInSamples;
				}

				this.writePage(trackData, isFinalPacket && segmentIsLastOfPacket);

				if (segmentIsLastOfPacket) {
					return;
				}
			}

			if (segmentIsLastOfPacket) {
				break;
			}
			remainingLength -= 255;
		}

		const slice = packet.data.subarray(dataStartOffset);
		trackData.currentPageData.push(slice);
		trackData.currentPageSize += slice.length;
		trackData.currentGranulePosition = packetEndTimestampInSamples;

		if (trackData.currentPageSize >= PAGE_SIZE_TARGET || packet.forcePageFlush) {
			this.writePage(trackData, isFinalPacket);
		}
	}

	writePage(trackData: OggTrackData, isEos: boolean) {
		this.pageView.setUint32(0, OGGS, true); // Capture pattern
		this.pageView.setUint8(4, 0); // Version

		let headerType = 0;
		if (!trackData.currentPageStartsWithFreshPacket) {
			headerType |= 1;
		}
		if (trackData.pagesWritten === 0) {
			headerType |= 2; // Beginning of stream
		}
		if (isEos) {
			headerType |= 4; // End of stream
		}
		this.pageView.setUint8(5, headerType); // Header type

		const granulePosition = trackData.currentLacingValues.every(x => x === 255)
			? -1 // No packets end on this page
			: trackData.currentGranulePosition;
		setInt64(this.pageView, 6, granulePosition, true); // Granule position

		this.pageView.setUint32(14, trackData.serialNumber, true); // Serial number
		this.pageView.setUint32(18, trackData.pagesWritten, true); // Page sequence number
		this.pageView.setUint32(22, 0, true); // Checksum placeholder

		this.pageView.setUint8(26, trackData.currentLacingValues.length); // Number of page segments
		this.pageBytes.set(trackData.currentLacingValues, 27);

		let pos = 27 + trackData.currentLacingValues.length;
		for (const data of trackData.currentPageData) {
			this.pageBytes.set(data, pos);
			pos += data.length;
		}

		const slice = this.pageBytes.subarray(0, pos);

		const crc = computeOggPageCrc(slice);
		this.pageView.setUint32(22, crc, true); // Checksum

		trackData.pagesWritten++;
		trackData.currentLacingValues.length = 0;
		trackData.currentPageData.length = 0;
		trackData.currentPageSize = 27;
		trackData.currentPageStartsWithFreshPacket = true;
		trackData.currentPageStartTimestampInSamples = trackData.currentGranulePosition;

		if (this.format._options.onPage) {
			this.writer.startTrackingWrites();
		}

		this.writer.write(slice);

		if (this.format._options.onPage) {
			const { data, start } = this.writer.stopTrackingWrites();
			this.format._options.onPage(data, start, trackData.track.source);
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	override async onTrackClose(track: OutputTrack) {
		const release = await this.mutex.acquire();

		this.closedTracks.add(track);

		const trackData = this.trackDatas.find(x => x.track === track);
		if (trackData) {
			trackData.closed = true;
		}

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		// Since a track is now closed, we may be able to write out chunks that were previously waiting
		await this.interleavePages();

		release();
	}

	async finalize() {
		const release = await this.mutex.acquire();

		this.allTracksKnown.resolve();

		for (const trackData of this.trackDatas) {
			trackData.closed = true;
		}

		await this.interleavePages(true);

		for (const trackData of this.trackDatas) {
			if (trackData.currentLacingValues.length > 0) {
				this.writePage(trackData, true);
			}
		}

		release();
	}
}
