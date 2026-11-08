/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TrackType } from './output';
import { MediaCodec } from './codec';
import { DurationMetadataRequestOptions } from './demuxer';
import { Input } from './input';
import {
	InputAudioTrack,
	InputAudioTrackBacking,
	InputTrack,
	InputTrackBacking,
	InputVideoTrack,
	InputVideoTrackBacking,
} from './input-track';
import { PacketRetrievalOptions } from './media-sink';
import {
	arrayCount,
	assert,
	audioDecoderConfigsAreEqual,
	MaybePromise,
	roundToDivisor,
	toUint8Array,
	uint8ArraysAreEqual,
} from './misc';
import { EncodedPacket, PLACEHOLDER_DATA } from './packet';
import {
	concatNalUnitsInLengthPrefixed,
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
	HevcNalUnitType,
	iterateNalUnitsInLengthPrefixed,
} from './codec-data';

export type SegmentedInputMetadata = {
	name: string | null;
	bitrate: number | null; // doc block: this refers to the _peak_ bitrate
	averageBitrate: number | null;
	codecs: MediaCodec[];
	codecStrings: string[];
	resolution: { width: number; height: number } | null;
	frameRate: number | null;
	isKeyFrameOnly: boolean;
};

export type AssociatedGroup = {
	id: string;
	type: 'video' | 'audio' | 'subtitles' | 'closed-captions';
};

export type Segment = {
	timestamp: number;
	duration: number;
	/**
	 * The Unix time (in seconds) corresponding to this segment's start timestamp, or null if unknown. This is computed
	 * whenever the source provides wall-clock information (e.g. HLS program date time), even if the segment timestamps
	 * themselves are not shifted into Unix time space.
	 */
	unixEpochTimestamp: number | null;
	discontinuityNumber: number;
};

export type SegmentRetrievalOptions = {
	skipLiveWait?: boolean;
};

export type SegmentedInputTrackDeclaration = {
	id: number;
	type: TrackType;
};

export abstract class SegmentedInput {
	input: Input;
	path: string;
	trackDeclarations: SegmentedInputTrackDeclaration[] | null;

	nextInputCacheAge = 0;
	inputCache: {
		segment: Segment;
		input: Input;
		age: number;
	}[] = [];

	evictedInputs: WeakRef<Input>[] = [];

	trackBackingsPromise: Promise<InputTrackBacking[]> | null = null;
	firstSegment: Segment | null = null;

	// Roughly maps local segment timestamps onto actual packet timestamps
	learnedSegmentTimestampOffset: number | null = null;
	segmentMediaOffsets = new WeakMap<Segment, Promise<number>>();

	constructor(input: Input, path: string, trackDeclarations: SegmentedInputTrackDeclaration[] | null) {
		this.input = input;
		this.path = path;
		this.trackDeclarations = trackDeclarations;
	}

	abstract getFirstSegment(options: SegmentRetrievalOptions): Promise<Segment | null>;
	abstract getSegmentAt(timestamp: number, options: SegmentRetrievalOptions): Promise<Segment | null>;
	abstract getNextSegment(segment: Segment, options: SegmentRetrievalOptions): Promise<Segment | null>;
	abstract getPreviousSegment(segment: Segment, options: SegmentRetrievalOptions): Promise<Segment | null>;
	abstract getInputForSegment(segment: Segment): Input;

	abstract getLiveRefreshInterval(): Promise<number | null>;
	abstract getMediaOffsetForDiscontinuity(discontinuityNumber: number): Promise<number>;
	abstract getFirstSegmentTimestampOffset(): Promise<number>;
	abstract getRawTimestampOffset(input: Input): Promise<number | null>; // Needed to make things like MP3/ADTS work
	abstract getTimestampWrapPeriod(): number;

	/**
	 * Whether the segments come with more than one init section, whose codec parameters may then differ from segment to
	 * segment.
	 */
	hasMultipleInitSections() {
		return false;
	}

	async getDurationFromMetadata(options: DurationMetadataRequestOptions) {
		const lastSegment = await this.getSegmentAt(Infinity, {
			skipLiveWait: options.skipLiveWait,
		});
		if (!lastSegment) {
			return null;
		}

		return (lastSegment.timestamp + await this.getFirstSegmentTimestampOffset()) + lastSegment.duration;
	}

	async getUnixTimeForTimestamp(timestamp: number): Promise<number | null> {
		let segment = await this.getSegmentAt(timestamp, {});
		segment ??= await this.getFirstSegment({});

		if (!segment || segment.unixEpochTimestamp === null) {
			return null;
		}

		const elapsed = timestamp - (segment.timestamp + await this.getFirstSegmentTimestampOffset());
		return segment.unixEpochTimestamp + elapsed;
	}

	async getTrackBackings(): Promise<InputTrackBacking[]> {
		return this.trackBackingsPromise ??= (async () => {
			const backings: InputTrackBacking[] = [];

			if (this.trackDeclarations) {
				for (const decl of this.trackDeclarations) {
					if (decl.type === 'video') {
						const number = arrayCount(backings, x => x.getType() === 'video') + 1;

						backings.push(
							new SegmentedInputInputVideoTrackBacking(this, decl, number),
						);
					} else if (decl.type === 'audio') {
						const number = arrayCount(backings, x => x.getType() === 'audio') + 1;

						backings.push(
							new SegmentedInputInputAudioTrackBacking(this, decl, number),
						);
					}
				}
			} else {
				// There are no declarations, we must determine the tracks from the first segment
				this.firstSegment = await this.getFirstSegment({});
				if (!this.firstSegment) {
					return [];
				}

				const input = this.getInputForSegment(this.firstSegment);
				const inputTracks = await input.getTracks();

				for (const track of inputTracks) {
					if (track.type === 'video') {
						const number = arrayCount(backings, x => x.getType() === 'video') + 1;

						backings.push(
							new SegmentedInputInputVideoTrackBacking(this, {
								id: backings.length + 1,
								type: 'video',
							}, number),
						);
					} else if (track.type === 'audio') {
						const number = arrayCount(backings, x => x.getType() === 'audio') + 1;

						backings.push(
							new SegmentedInputInputAudioTrackBacking(this, {
								id: backings.length + 1,
								type: 'audio',
							}, number),
						);
					}
				}
			}

			return backings;
		})();
	}

	getMediaOffset(segment: Segment, input: Input) {
		let promise = this.segmentMediaOffsets.get(segment);
		if (promise) {
			return promise;
		}

		promise = (async () => {
			const rawTimestampOffset = await this.getRawTimestampOffset(input);
			if (rawTimestampOffset === null) {
				// Without media timestamps, all we can do is place the media at the segment's timestamp
				return segment.timestamp;
			}

			let mediaOffset = rawTimestampOffset
				+ await this.getMediaOffsetForDiscontinuity(segment.discontinuityNumber);

			const period = this.getTimestampWrapPeriod();
			if (period < Infinity) {
				// Media timestamps wrap around periodically (that's how MPEG-TS timestamps work). To make the entire
				// timeline continuous and monotonic (even for live streams that go on forever), we do a simple trick:
				// shift the media timestamps by multiples of the period length so that the first timestamp is closest
				// to the segment's timestamp (which DOES rise monotonically). This even works correctly for
				// non-wrapping formats like fMP4 because for them it's just a noop (or a constant shift for all media).
				const tracks = await input.getTracks();
				const track = tracks.find(x => x.type === 'video') ?? tracks[0];
				assert(track);

				const mediaStart = await track.getFirstTimestamp() + mediaOffset;
				mediaOffset += period * Math.round((segment.timestamp - mediaStart) / period);
			}

			return mediaOffset;
		})();
		this.segmentMediaOffsets.set(segment, promise);

		return promise;
	}

	/**
	 * Keeps track of an input that dropped out of the cache. It may still be in use (by packets read from it), so it's
	 * only disposed together with this input, unless garbage collection gets to it first.
	 */
	trackEvictedInput(input: Input) {
		if (typeof WeakRef === 'undefined') {
			return;
		}

		if (this.evictedInputs.length >= 64) {
			this.evictedInputs = this.evictedInputs.filter(x => x.deref());
		}

		this.evictedInputs.push(new WeakRef(input));
	}

	dispose() {
		for (const entry of this.inputCache) {
			entry.input.dispose();
		}
		this.inputCache.length = 0;

		for (const ref of this.evictedInputs) {
			ref.deref()?.dispose();
		}
		this.evictedInputs.length = 0;
	}
}

/**
 * The tick of the given time resolution at or before a timestamp. A timestamp within floating-point noise of a tick
 * (a few ulps, as when it was computed along another path) counts as that tick. A looser tolerance, like
 * roundIfAlmostInteger's, would also swallow real offsets of microseconds on Unix-epoch timelines.
 */
const getTickAtOrBefore = (timestamp: number, timeResolution: number) => {
	const ticks = timestamp * timeResolution;
	const rounded = Math.round(ticks);
	return Math.abs(ticks - rounded) <= 4 * Number.EPSILON * Math.abs(ticks) ? rounded : Math.floor(ticks);
};

type PacketInfo = {
	segment: Segment;
	track: InputTrack;
	sourcePacket: EncodedPacket;
};

type InBandParameterSets = {
	/** The segment's parameter sets, length-prefixed like the packets the decoder config describes */
	parameterSets: Uint8Array;
	/** The NAL unit length size of the segment's own packets */
	lengthSize: 1 | 2 | 3 | 4;
	/** The NAL unit length size the decoder config (the first segment's) declares */
	targetLengthSize: 1 | 2 | 3 | 4;
	/** Whether the segment's parameter sets differ from the first segment's */
	differ: boolean;
	/**
	 * The decoder config of the segment's packets when its parameter sets differ from the first segment's, with the NAL
	 * unit length size of the packets as delivered
	 */
	decoderConfig: VideoDecoderConfig | null;
};

const parseParameterSets = (codec: 'avc' | 'hevc', description: Uint8Array) => {
	if (codec === 'avc') {
		const record = deserializeAvcDecoderConfigurationRecord(description);
		return record && {
			nalUnits: [...record.sequenceParameterSets, ...record.pictureParameterSets],
			lengthSize: (record.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4,
		};
	} else {
		const record = deserializeHevcDecoderConfigurationRecord(description);
		const parameterSetTypes: number[] = [HevcNalUnitType.VPS_NUT, HevcNalUnitType.SPS_NUT, HevcNalUnitType.PPS_NUT];
		return record && {
			nalUnits: record.arrays.filter(x => parameterSetTypes.includes(x.nalUnitType)).flatMap(x => x.nalUnits),
			lengthSize: (record.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4,
		};
	}
};

class SegmentedInputInputTrackBacking implements InputTrackBacking {
	segmentedInput: SegmentedInput;
	decl: SegmentedInputTrackDeclaration;
	number: number;
	packetInfos = new WeakMap<EncodedPacket, PacketInfo>();
	inBandParameterSets = new WeakMap<InputTrack, Promise<InBandParameterSets | null>>();
	/** Decoder configs of packets that need another one than the track's */
	packetDecoderConfigs = new WeakMap<EncodedPacket, VideoDecoderConfig | AudioDecoderConfig>();
	/** One object per distinct video decoder config, so that segments sharing an init section share the object */
	distinctVideoDecoderConfigs: VideoDecoderConfig[] = [];
	segmentAudioDecoderConfigs = new WeakMap<InputTrack, Promise<AudioDecoderConfig | null>>();
	/** One object per distinct decoder config, so that segments sharing a config share the object */
	distinctAudioDecoderConfigs: AudioDecoderConfig[] = [];

	hydrationPromise: Promise<void> | null = null;
	firstInputTrack: InputTrack | null = null;
	firstSegment: Segment | null = null;

	constructor(segmentedInput: SegmentedInput, decl: SegmentedInputTrackDeclaration, number: number) {
		this.segmentedInput = segmentedInput;
		this.decl = decl;
		this.number = number;
	}

	hydrate() {
		return this.hydrationPromise ??= (async () => {
			this.segmentedInput.firstSegment ??= await this.segmentedInput.getFirstSegment({});
			if (!this.segmentedInput.firstSegment) {
				throw new Error('Missing first segment, can\'t retrieve track.');
			}

			let currentSegment: Segment | null = this.segmentedInput.firstSegment;
			let track: InputTrack | null = null;

			// For playlists with sparse tracks (rare af!!), not every segment has every track, so we need to loop to
			// find the first segment that actually contains the track we want.
			while (currentSegment) {
				const input = this.segmentedInput.getInputForSegment(currentSegment);
				const inputTracks = await input.getTracks();
				track = inputTracks.find(x => x.type === this.decl.type && x.number === this.number) ?? null;

				if (track) {
					break;
				}

				currentSegment = await this.segmentedInput.getNextSegment(currentSegment, {});
			}

			if (!track) {
				throw new Error('No matching track found in underlying media data.');
			}

			this.firstInputTrack = track;
			this.firstSegment = currentSegment;
		})();
	}

	getId(): number {
		return this.decl.id;
	}

	getType(): TrackType {
		return this.decl.type;
	}

	getNumber(): number {
		return this.number;
	}

	/** If the backing track is already present, delegate synchronously; otherwise, hydrate first. */
	delegate<T>(fn: () => MaybePromise<T>): MaybePromise<T> {
		if (this.firstInputTrack) {
			return fn();
		}

		return this.hydrate().then(fn);
	}

	async getDecoderConfig() {
		return this.delegate(() => this.firstInputTrack!._backing.getDecoderConfig());
	}

	getHasOnlyKeyPackets() {
		return this.delegate(() => this.firstInputTrack!._backing.getHasOnlyKeyPackets?.() ?? null);
	}

	getPairingMask() {
		return 1n;
	}

	getCodec() {
		return this.delegate(() => this.firstInputTrack!._backing.getCodec());
	}

	getInternalCodecId() {
		return this.delegate(() => this.firstInputTrack!._backing.getInternalCodecId());
	}

	getDisposition() {
		return this.delegate(() => this.firstInputTrack!._backing.getDisposition());
	}

	getLanguageCode() {
		return this.delegate(() => this.firstInputTrack!._backing.getLanguageCode());
	}

	getName() {
		return this.delegate(() => this.firstInputTrack!._backing.getName());
	}

	getTimeResolution() {
		return this.delegate(() => this.firstInputTrack!._backing.getTimeResolution());
	}

	async isRelativeToUnixEpoch() {
		await this.hydrate();

		assert(this.segmentedInput.firstSegment);
		return this.segmentedInput.firstSegment.unixEpochTimestamp === this.segmentedInput.firstSegment.timestamp;
	}

	getUnixTimeForTimestamp(timestamp: number) {
		return this.segmentedInput.getUnixTimeForTimestamp(timestamp);
	}

	getBitrate() {
		return this.delegate(() => this.firstInputTrack!._backing.getBitrate());
	}

	getAverageBitrate() {
		return this.delegate(() => this.firstInputTrack!._backing.getAverageBitrate());
	}

	getDurationFromMetadata(options: DurationMetadataRequestOptions): Promise<number | null> {
		return this.segmentedInput.getDurationFromMetadata(options);
	}

	getLiveRefreshInterval(): Promise<number | null> {
		return this.segmentedInput.getLiveRefreshInterval();
	}

	async createAdjustedPacket(packet: EncodedPacket, segment: Segment, track: InputTrack) {
		assert(packet.sequenceNumber >= 0);
		assert(this.segmentedInput.firstSegment);

		const mediaOffset = await this.segmentedInput.getMediaOffset(segment, track.input);
		// If we didn't do this then sequence numbers would exceed Number.MAX_SAFE_INTEGER for Unix-timestamped segments
		const segmentTimestampRelativeToFirst = segment.timestamp - this.segmentedInput.firstSegment.timestamp;

		let data = packet.data;
		let byteLength = packet.byteLength;
		const ownParameterSets = await this.getInBandParameterSets(track);
		// When the segments come with more than one init section, every segment sends its own parameter sets, also
		// those equal to the decoder config's: the decoder may have just received another segment's sets under the same
		// IDs, which replace them
		const inBand = ownParameterSets && (ownParameterSets.differ || this.segmentedInput.hasMultipleInitSections())
			? ownParameterSets
			: null;
		if (inBand) {
			let source = packet;
			if (packet.isMetadataOnly && inBand.lengthSize !== inBand.targetLengthSize) {
				// Converted length prefixes make the size depend on the NAL units, so a metadata-only packet needs them
				// too
				const fullPacket = await track._backing.getPacket(packet.timestamp, {});
				if (fullPacket && fullPacket.sequenceNumber === packet.sequenceNumber) {
					source = fullPacket;
				}
			}

			if (!source.isMetadataOnly) {
				const bytes = this.applyInBandParameterSets(source.data, packet.type === 'key', inBand);
				byteLength = bytes.byteLength;
				data = packet.isMetadataOnly ? PLACEHOLDER_DATA : bytes;
			} else if (packet.type === 'key') {
				byteLength += inBand.parameterSets.byteLength;
			}
		}

		const modified = new EncodedPacket(
			data,
			packet.type,
			roundToDivisor(
				packet.timestamp + mediaOffset,
				await track.getTimeResolution(),
			),
			packet.duration,
			// The 1e8 assumes a max of 100 MB per second, highly unlikely to be hit, so this should guarantee
			// monotonically increasing sequence numbers across segments.
			Math.floor(1e8 * segmentTimestampRelativeToFirst) + packet.sequenceNumber,
			byteLength,
			packet.sideData,
		);

		this.packetInfos.set(modified, {
			segment,
			track,
			sourcePacket: packet,
		});

		if (ownParameterSets?.decoderConfig) {
			// Decoders that don't apply new parameter sets from the bitstream (WebKit's) need to be reconfigured
			this.packetDecoderConfigs.set(modified, ownParameterSets.decoderConfig);
		} else if (this.decl.type === 'audio') {
			const decoderConfig = await this.getSegmentAudioDecoderConfig(track);
			if (decoderConfig) {
				this.packetDecoderConfigs.set(modified, decoderConfig);
			}
		}

		return modified;
	}

	getDecoderConfigForPacket(packet: EncodedPacket) {
		return this.packetDecoderConfigs.get(packet) ?? null;
	}

	/**
	 * The decoder config is the first segment's, but a later segment can come with its own init section whose parameter
	 * sets differ (a new EXT-X-MAP after a discontinuity, such as an ad break from another encoder). Like Chromium does
	 * for a new init segment, segments then send their own parameter sets in band, in front of each of their key
	 * packets.
	 */
	getInBandParameterSets(track: InputTrack) {
		let promise = this.inBandParameterSets.get(track);
		if (!promise) {
			promise = (async (): Promise<InBandParameterSets | null> => {
				assert(this.firstInputTrack);
				if (!track.isVideoTrack()) {
					return null;
				}

				const codec = await track.getCodec();
				if (codec !== 'avc' && codec !== 'hevc') {
					return null;
				}

				const firstConfig = await this.firstInputTrack._backing.getDecoderConfig() as VideoDecoderConfig | null;
				const config = await track._backing.getDecoderConfig();
				if (!firstConfig?.description || !config?.description) {
					return null; // Annex B packets carry their parameter sets in band already
				}

				const firstDescription = toUint8Array(firstConfig.description);
				const description = toUint8Array(config.description);
				const first = parseParameterSets(codec, firstDescription);
				const own = parseParameterSets(codec, description);
				if (!first || !own) {
					return null;
				}

				if (own.nalUnits.some(nalUnit => nalUnit.byteLength >= 2 ** (8 * first.lengthSize))) {
					throw new Error(
						'A parameter set is too large for the NAL unit length size of the first segment\'s decoder'
						+ ' config.',
					);
				}

				const differ = !uint8ArraysAreEqual(firstDescription, description);

				let decoderConfig: VideoDecoderConfig | null = null;
				if (differ) {
					let packetDescription = description;
					if (own.lengthSize !== first.lengthSize) {
						// The packets get the first segment's NAL unit length size; lengthSizeMinusOne is in the low
						// two bits of byte 4 of avcC and of byte 21 of hvcC
						packetDescription = description.slice();
						const pos = codec === 'avc' ? 4 : 21;
						packetDescription[pos] = (packetDescription[pos]! & 0xfc) | (first.lengthSize - 1);
					}

					decoderConfig = this.distinctVideoDecoderConfigs.find(x => x.codec === config.codec
						&& x.codedWidth === config.codedWidth
						&& x.codedHeight === config.codedHeight
						&& uint8ArraysAreEqual(toUint8Array(x.description!), packetDescription),
					) ?? null;
					if (!decoderConfig) {
						decoderConfig = { ...config, description: packetDescription };
						this.distinctVideoDecoderConfigs.push(decoderConfig);
					}
				}

				return {
					parameterSets: concatNalUnitsInLengthPrefixed(own.nalUnits, first.lengthSize),
					lengthSize: own.lengthSize,
					targetLengthSize: first.lengthSize,
					differ,
					decoderConfig,
				};
			})();
			this.inBandParameterSets.set(track, promise);
		}

		return promise;
	}

	applyInBandParameterSets(data: Uint8Array, isKey: boolean, inBand: InBandParameterSets) {
		let bytes = data;
		if (inBand.lengthSize !== inBand.targetLengthSize) {
			const nalUnits = [...iterateNalUnitsInLengthPrefixed(data, inBand.lengthSize)]
				.map(location => data.subarray(location.offset, location.offset + location.length));
			if (nalUnits.some(nalUnit => nalUnit.byteLength >= 2 ** (8 * inBand.targetLengthSize))) {
				throw new Error(
					'A NAL unit is too large for the NAL unit length size of the first segment\'s decoder config.',
				);
			}
			bytes = concatNalUnitsInLengthPrefixed(nalUnits, inBand.targetLengthSize);
		}

		if (!isKey) {
			return bytes;
		}

		const result = new Uint8Array(inBand.parameterSets.byteLength + bytes.byteLength);
		result.set(inBand.parameterSets, 0);
		result.set(bytes, inBand.parameterSets.byteLength);
		return result;
	}

	/**
	 * The audio decoder config of a segment's track when it differs from the first segment's, which is the track's
	 * decoder config: a new init section after a discontinuity (such as an ad break) can bring another sample rate,
	 * channel count or AudioSpecificConfig.
	 */
	getSegmentAudioDecoderConfig(track: InputTrack) {
		let promise = this.segmentAudioDecoderConfigs.get(track);
		if (!promise) {
			promise = (async () => {
				assert(this.firstInputTrack);
				if (track === this.firstInputTrack) {
					return null;
				}

				const firstConfig = await this.firstInputTrack._backing.getDecoderConfig() as AudioDecoderConfig | null;
				const config = await track._backing.getDecoderConfig() as AudioDecoderConfig | null;
				if (!firstConfig || !config || audioDecoderConfigsAreEqual(firstConfig, config)) {
					return null;
				}

				const existing = this.distinctAudioDecoderConfigs.find(x => audioDecoderConfigsAreEqual(x, config));
				if (existing) {
					return existing;
				}

				this.distinctAudioDecoderConfigs.push(config);
				return config;
			})();
			this.segmentAudioDecoderConfigs.set(track, promise);
		}

		return promise;
	}

	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();

		assert(this.firstInputTrack);
		assert(this.firstSegment);

		let currentTrack: InputTrack | null = this.firstInputTrack;
		let currentSegment: Segment | null = this.firstSegment;

		// Loop until we found a segment with a packet (segments may contain zero packets in rare cases)
		while (true) {
			if (currentTrack) {
				const packet = await currentTrack._backing.getFirstPacket(options);
				if (packet) {
					return this.createAdjustedPacket(packet, currentSegment, currentTrack);
				}
			}

			currentSegment = await this.segmentedInput.getNextSegment(currentSegment, {
				skipLiveWait: options.skipLiveWait,
			});
			if (!currentSegment) {
				break;
			}

			const nextInput = this.segmentedInput.getInputForSegment(currentSegment);
			const nextTracks = await nextInput.getTracks();
			currentTrack = nextTracks.find(t => (
				t.type === this.firstInputTrack!.type && t.number === this.firstInputTrack!.number
			)) ?? null;
		}

		return null;
	}

	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this._getNextInternal(packet, options, false);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this._getNextInternal(packet, options, true);
	}

	async _getNextInternal(
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
		keyframesOnly: boolean,
	): Promise<EncodedPacket | null> {
		const info = this.packetInfos.get(packet);
		if (!info) {
			throw new Error('Packet was not created from this track.');
		}

		const nextPacket = keyframesOnly
			? await info.track._backing.getNextKeyPacket(info.sourcePacket, options)
			: await info.track._backing.getNextPacket(info.sourcePacket, options);
		if (nextPacket) {
			return this.createAdjustedPacket(nextPacket, info.segment, info.track);
		}

		let currentSegment: Segment | null = info.segment;
		while (true) {
			const nextSegment = await this.segmentedInput.getNextSegment(currentSegment, {
				skipLiveWait: options.skipLiveWait,
			});
			if (!nextSegment) {
				return null;
			}

			const nextInput = this.segmentedInput.getInputForSegment(nextSegment);
			const nextTracks = await nextInput.getTracks();
			const nextTrack = nextTracks.find(t => t.type === info.track.type && t.number === info.track.number);

			if (!nextTrack) {
				currentSegment = nextSegment;
				continue;
			}

			let packet = await nextTrack._backing.getFirstPacket(options);
			if (packet && keyframesOnly && packet.type !== 'key') {
				packet = await nextTrack._backing.getNextKeyPacket(packet, options);
			}

			if (!packet) {
				// Segments may contain zero packets for a track, so, move on
				currentSegment = nextSegment;
				continue;
			}

			return this.createAdjustedPacket(packet, nextSegment, nextTrack);
		}
	}

	getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this._getPacketInternal(timestamp, options, false);
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this._getPacketInternal(timestamp, options, true);
	}

	async _getPacketInternal(
		timestamp: number,
		options: PacketRetrievalOptions,
		keyframesOnly: boolean,
	): Promise<EncodedPacket | null> {
		let currentSegment = await this.segmentedInput.getSegmentAt(timestamp, {
			skipLiveWait: options.skipLiveWait,
		});

		// The media may start before the first segment's timestamp
		currentSegment ??= await this.segmentedInput.getFirstSegment({});

		if (!currentSegment) {
			return null;
		}

		await this.hydrate();

		// Finds the packet at or before the timestamp in the segment after `segment`, if there is one. Media can start
		// before the playlist timestamp of its segment: timestamps rounded to the media's clock, or leading frames of
		// an open GOP, which are presented before the key frame that starts their segment.
		const getPacketInNextSegment = async (segment: Segment, skipLiveWait: boolean | undefined) => {
			const nextSegment = await this.segmentedInput.getNextSegment(segment, { skipLiveWait });
			if (!nextSegment) {
				return null;
			}

			const nextInput = this.segmentedInput.getInputForSegment(nextSegment);
			const nextTracks = await nextInput.getTracks();
			const nextTrack = nextTracks.find(t => (
				t.type === this.firstInputTrack!.type && t.number === this.firstInputTrack!.number
			));
			if (!nextTrack) {
				return null;
			}

			const nextMediaOffset = await this.segmentedInput.getMediaOffset(nextSegment, nextInput);
			const nextPacket = await this._getPacketAtOrBefore(
				nextTrack,
				nextMediaOffset,
				timestamp,
				{ ...options, metadataOnly: true },
				keyframesOnly,
			);
			if (!nextPacket) {
				return null;
			}

			return {
				segment: nextSegment,
				timestamp: roundToDivisor(nextPacket.timestamp + nextMediaOffset, await nextTrack.getTimeResolution()),
			};
		};

		// Once a segment turns out to have no packet at or before the timestamp, we search the previous segments, and
		// don't look forward anymore: the segment after the current one is the one we came from.
		let searchingBackward = false;

		// Called when the current segment has no packet at or before the timestamp
		const moveToNeighbor = async (segment: Segment) => {
			if (!searchingBackward) {
				// Don't wait for a live stream's next segment just for this
				const next = await getPacketInNextSegment(segment, true);
				if (next) {
					return next.segment;
				}
			}

			// Search the previous segment
			searchingBackward = true;
			return this.segmentedInput.getPreviousSegment(segment, {
				skipLiveWait: options.skipLiveWait,
			});
		};

		while (currentSegment) {
			const input = this.segmentedInput.getInputForSegment(currentSegment);
			const tracks = await input.getTracks();
			const track = tracks.find(t => (
				t.type === this.firstInputTrack!.type && t.number === this.firstInputTrack!.number
			));

			if (!track) {
				currentSegment = await moveToNeighbor(currentSegment);
				continue;
			}

			const mediaOffset = await this.segmentedInput.getMediaOffset(currentSegment, input);

			// If we don't know the segment timestamp offset yet, learn it once from where this segment's media
			// actually lies. If the timestamp is more than a segment's duration away from the segment, the lookup was
			// way off, so redo it with the learned offset instead of walking there segment by segment. Note that it's
			// fine if the result is still off, because we follow it with a correction step that finds the correct
			// packet.
			const firstPacket = this.segmentedInput.learnedSegmentTimestampOffset === null
				? await track._backing.getFirstPacket({ ...options, metadataOnly: true })
				: null;
			if (firstPacket) {
				const segmentStart = firstPacket.timestamp + mediaOffset;
				this.segmentedInput.learnedSegmentTimestampOffset = segmentStart - currentSegment.timestamp;

				const distance = timestamp - segmentStart;
				if (distance < -currentSegment.duration || distance >= 2 * currentSegment.duration) {
					const segment = await this.segmentedInput.getSegmentAt(timestamp, {
						skipLiveWait: options.skipLiveWait,
					});
					if (segment !== currentSegment) {
						currentSegment = segment;
						continue;
					}
				}
			}

			const packet = await this._getPacketAtOrBefore(track, mediaOffset, timestamp, options, keyframesOnly);

			if (!packet) {
				currentSegment = await moveToNeighbor(currentSegment);
				continue;
			}

			if (searchingBackward) {
				// The later segments have no packet at or before the timestamp
				return this.createAdjustedPacket(packet, currentSegment, track);
			}

			// The playlist may claim the segment to be longer than its media actually is, in which case the timestamp
			// can lie in the next segment instead. That's only possible if it lies past this segment's media.
			const lastPacket = keyframesOnly
				? await this._getPacketAtOrBefore(
					track,
					mediaOffset,
					timestamp,
					{ ...options, metadataOnly: true },
					false,
				)
				: packet;
			assert(lastPacket);

			const timeResolution = await track.getTimeResolution();
			const lastPacketEnd = roundToDivisor(
				lastPacket.timestamp + lastPacket.duration + mediaOffset,
				timeResolution,
			);

			// Segments are muxed separately, so the end of one segment's media and the start of the next one's can
			// overlap by a tick: the last packet's end and the next packet's start get rounded independently
			const timestampTick = getTickAtOrBefore(timestamp, timeResolution);
			let mayLieInNextSegment = timestampTick >= Math.round(lastPacketEnd * timeResolution) - 1;

			if (!mayLieInNextSegment) {
				// The last packet's duration can also be off (e.g. a nominal duration in variable frame rate media), in
				// which case its end says nothing about where the next segment's media starts. The next segment's
				// playlist timestamp says more, so also look there when the timestamp is within a tick of it.
				const nextSegment = await this.segmentedInput.getNextSegment(currentSegment, { skipLiveWait: true });
				if (nextSegment) {
					const nextSegmentStart = nextSegment.timestamp
						+ (this.segmentedInput.learnedSegmentTimestampOffset ?? 0);
					mayLieInNextSegment = timestampTick >= Math.round(nextSegmentStart * timeResolution) - 1;

					if (!mayLieInNextSegment && !keyframesOnly && track.isVideoTrack()) {
						// Leading frames of an open GOP in the next segment are shown right after this segment's last
						// frame, possibly well before the next segment starts, and the last frame's duration can cover
						// them. So if the packet is the segment's last frame, the next segment may hold a packet closer
						// to the timestamp.
						const lastTimestamp = await this.getLastPacketTimestamp(track);
						mayLieInNextSegment = lastTimestamp !== null && packet.timestamp >= lastTimestamp;
					}
				}
			}

			if (mayLieInNextSegment) {
				// Not just the next segment's first packet matters: in decode order, an open GOP's leading frames come
				// after the key frame that starts the segment
				const next = await getPacketInNextSegment(currentSegment, options.skipLiveWait);
				if (next && next.timestamp >= roundToDivisor(packet.timestamp + mediaOffset, timeResolution)) {
					currentSegment = next.segment;
					continue;
				}
			}

			return this.createAdjustedPacket(packet, currentSegment, track);
		}

		return null;
	}

	/** The timestamp of the last packet in presentation order of each segment track, computed once per track. */
	lastPacketTimestamps = new WeakMap<InputTrack, Promise<number | null>>();

	getLastPacketTimestamp(track: InputTrack) {
		let promise = this.lastPacketTimestamps.get(track);
		if (!promise) {
			promise = track._backing.getPacket(Infinity, { metadataOnly: true })
				.then(packet => packet?.timestamp ?? null);
			this.lastPacketTimestamps.set(track, promise);
		}

		return promise;
	}

	/**
	 * Returns the last packet (or key packet) of a segment's track whose reported timestamp (see
	 * `createAdjustedPacket`) is less than or equal to `timestamp`.
	 */
	async _getPacketAtOrBefore(
		track: InputTrack,
		mediaOffset: number,
		timestamp: number,
		options: PacketRetrievalOptions,
		keyframesOnly: boolean,
	) {
		const getPacket = (offsetTimestamp: number) => keyframesOnly
			? track._backing.getKeyPacket(offsetTimestamp, options)
			: track._backing.getPacket(offsetTimestamp, options);

		// Reported timestamps are rounded to the time resolution. If the media offset isn't a whole number of ticks, a
		// packet can be reported at `timestamp` while lying up to half a tick after `timestamp - mediaOffset`, so we
		// look up the point halfway between the last tick at or before `timestamp` and the next one instead.
		const timeResolution = await track.getTimeResolution();
		const tick = getTickAtOrBefore(timestamp, timeResolution);
		let packet = await getPacket((tick + 0.5) / timeResolution - mediaOffset);

		// Compared in ticks, since the timestamp may be a reported timestamp computed along another path, off in its
		// last bit
		if (packet && Math.round((packet.timestamp + mediaOffset) * timeResolution) > tick) {
			// The packet lies exactly on the rounding boundary and is reported a tick later, so take the one before it
			packet = await getPacket(packet.timestamp - 1 / (2 * timeResolution));
		}

		return packet;
	}
}

class SegmentedInputInputVideoTrackBacking
	extends SegmentedInputInputTrackBacking
	implements InputVideoTrackBacking {
	declare firstInputTrack: InputVideoTrack | null;

	override getType() {
		return 'video' as const;
	}

	override getCodec() {
		return this.delegate(() => this.firstInputTrack!._backing.getCodec());
	}

	getCodedWidth() {
		return this.delegate(() => this.firstInputTrack!._backing.getCodedWidth());
	}

	getCodedHeight() {
		return this.delegate(() => this.firstInputTrack!._backing.getCodedHeight());
	}

	getSquarePixelWidth() {
		return this.delegate(() => this.firstInputTrack!._backing.getSquarePixelWidth());
	}

	getSquarePixelHeight() {
		return this.delegate(() => this.firstInputTrack!._backing.getSquarePixelHeight());
	}

	getTransformationMatrix() {
		return this.delegate(() => this.firstInputTrack!._backing.getTransformationMatrix());
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return this.delegate(() => this.firstInputTrack!._backing.getColorSpace());
	}

	async canBeTransparent(): Promise<boolean> {
		return this.delegate(() => this.firstInputTrack!._backing.canBeTransparent());
	}

	override async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		return this.delegate(() => this.firstInputTrack!._backing.getDecoderConfig());
	}
}

class SegmentedInputInputAudioTrackBacking
	extends SegmentedInputInputTrackBacking
	implements InputAudioTrackBacking {
	declare firstInputTrack: InputAudioTrack;

	override getType() {
		return 'audio' as const;
	}

	override getCodec() {
		return this.delegate(() => this.firstInputTrack._backing.getCodec());
	}

	getNumberOfChannels() {
		return this.delegate(() => this.firstInputTrack._backing.getNumberOfChannels());
	}

	getSampleRate() {
		return this.delegate(() => this.firstInputTrack._backing.getSampleRate());
	}

	override async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		return this.delegate(() => this.firstInputTrack._backing.getDecoderConfig());
	}
}
