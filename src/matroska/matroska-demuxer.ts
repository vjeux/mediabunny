/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TrackType } from '../output';
import {
	extractAv1CodecInfoFromPacket,
	extractDtsFourCcFromPacket,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	extractProresCodecInfoFromPacket,
	extractVp9CodecInfoFromPacket,
	parseModesFromVorbisSetupPacket,
	parseOpusTocByte,
	EAC3_NUMBLKS_TABLE,
} from '../codec-data';
import {
	AacCodecInfo,
	AUDIO_CODECS_WITH_DELTA_PACKETS,
	AudioCodec,
	DtsFourCc,
	extractAudioCodecString,
	extractColorSpace,
	extractVideoCodecString,
	MediaCodec,
	OPUS_SAMPLE_RATE,
	parsePcmCodec,
	PCM_AUDIO_CODECS,
	PcmAudioCodec,
	PRORES_FOURCCS,
	ProresFourCc,
	VideoCodec,
} from '../codec';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { Logging } from '../logging';
import {
	InputAudioTrackBacking,
	InputTrackBacking,
	InputVideoTrackBacking,
} from '../input-track';
import {
	AttachedFile,
	AttachedImage,
	DEFAULT_TRACK_DISPOSITION,
	MetadataTags,
	TrackDisposition,
	unwatchMetadataTagFields,
	watchMetadataTagFields,
} from '../metadata';
import { PacketRetrievalOptions } from '../media-sink';
import {
	assert,
	binarySearchLessOrEqual,
	COLOR_PRIMARIES_MAP_INVERSE,
	colorSpaceIsComplete,
	EMPTY_COLOR_SPACE,
	getDisplayAspect,
	bcp47ToIso639Dash2LanguageCode,
	isIso639Dash2LanguageCode,
	isThenable,
	last,
	MATRIX_COEFFICIENTS_MAP_INVERSE,
	centeredTransformationMatrix,
	DEG_TO_RAD,
	multiplyMatrices,
	normalizeRotation,
	Rational,
	Rotation,
	rotationMatrix,
	roundIfAlmostInteger,
	scaleMatrix,
	simplifyRational,
	textDecoder,
	toDataView,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, EncodedPacketSideData, PLACEHOLDER_DATA } from '../packet';
import {
	assertDefinedSize,
	CODEC_STRING_MAP,
	EBMLId,
	fromMatroskaLanguageCode,
	LEVEL_0_AND_1_EBML_IDS,
	LEVEL_0_EBML_IDS,
	LEVEL_1_EBML_IDS,
	MAX_HEADER_SIZE,
	MAX_VAR_INT_SIZE,
	MIN_HEADER_SIZE,
	readAsciiString,
	readUnicodeString,
	readElementHeader,
	readElementId,
	readFloat,
	readUnsignedInt,
	readVarInt,
	resync,
	searchForNextElementId,
	readUnsignedBigInt,
	readSignedBigInt,
	EBML_DATE_EPOCH,
} from './ebml';
import { buildMatroskaMimeType } from './matroska-misc';
import { buildAacAudioSpecificConfig, parseAacAudioSpecificConfig } from '../../shared/aac-misc';
import { readMp3FrameHeader } from '../../shared/mp3-misc';
import { getBlockSizeOrUncommon } from '../flac/flac-misc';
import { extractSampleMetadata, OggCodecInfo } from '../ogg/ogg-misc';
import { FileSlice, readBytes, Reader, readI16Be, readU8 } from '../reader';

type Segment = {
	seekHeadSeen: boolean;
	infoSeen: boolean;
	tracksSeen: boolean;
	cuesSeen: boolean;
	attachmentsSeen: boolean;
	tagsSeen: boolean;

	timestampScale: number;
	timestampFactor: number;
	duration: number;
	seekEntries: SeekEntry[];
	tracks: InternalTrack[];
	idToTrack: Map<number, InternalTrack>;
	cuePoints: CuePoint[];

	dataStartPos: number;
	elementEndPos: number | null;
	clusterSeekStartPos: number;

	/**
	 * Caches the last cluster that was read. Based on the assumption that there will be multiple reads to the
	 * same cluster in quick succession.
	 */
	/** The clusters read last, most recent last, kept so they don't need to be read again right away */
	recentClusters: Cluster[];
	/** The cluster read last */
	readonly lastReadCluster: Cluster | null;
	clusterSummaries: Map<number, ClusterSummary>; // Keyed by cluster position

	metadataTags: MetadataTags;
	metadataTagsPromise: Promise<void> | null;
};

type SeekEntry = {
	id: number;
	segmentPosition: number;
};

type Cluster = {
	segment: Segment;
	elementStartPos: number;
	elementEndPos: number;
	dataStartPos: number;
	timestamp: number;
	trackData: Map<number, ClusterTrackData>;
};

type ClusterSummary = {
	elementEndPos: number;
	trackIds: Set<number>; // The tracks with blocks in the cluster
	/** For each track in the cluster, the timestamp of its block presented last */
	latestTimestamps: Map<number, number>;
};

type ClusterTrackData = {
	track: InternalTrack;
	startTimestamp: number;
	endTimestamp: number;
	firstKeyFrameTimestamp: number | null;
	blocks: ClusterBlock[];
	presentationTimestamps: {
		timestamp: number;
		blockIndex: number;
	}[];
};

enum BlockLacing {
	None,
	Xiph,
	FixedSize,
	Ebml,
}

type ClusterBlock = {
	timestamp: number;
	duration: number;
	/** Whether the block came with a BlockDuration, which can be 0. Without one, its duration is inferred. */
	hasBlockDuration?: boolean;
	isKeyFrame: boolean;
	data: Uint8Array;
	lacing: BlockLacing;
	decoded: boolean;
	postProcessed: boolean; // For codec-specific processing
	mainAdditional: Uint8Array | null;
};

type CuePoint = {
	time: number;
	trackId: number;
	clusterPosition: number;
};

enum ContentEncodingScope {
	Block = 1,
	Private = 2,
	Next = 4,
}

enum ContentCompAlgo {
	Zlib,
	Bzlib,
	lzo1x,
	HeaderStripping,
}

type DecodingInstruction = {
	order: number;
	scope: ContentEncodingScope;
	data: {
		type: 'decompress';
		algorithm: ContentCompAlgo | null;
		settings: Uint8Array | null;
	} | {
		type: 'decrypt';
		// Don't store more yet since this operation is unsupported
	} | null;
};

type InternalTrack = {
	id: number;
	demuxer: MatroskaDemuxer;
	segment: Segment;
	/**
	 * List of all encountered cluster offsets alongside their timestamps. This list never gets truncated, but memory
	 * consumption should be negligible.
	 */
	clusterPositionCache: {
		elementStartPos: number;
		startTimestamp: number;
		hasKeyFrame: boolean;
		/** The earliest presented key frame in the cluster */
		firstKeyFrameTimestamp: number | null;
	}[];
	cuePoints: CuePoint[];

	disposition: TrackDisposition;
	trackBacking: InputTrackBacking | null;
	codecId: string | null;
	codecPrivate: Uint8Array | null;
	defaultDuration: number | null;
	defaultDurationNs: number | null;
	codecDelay: number;
	codecDelayNs: number;
	/** Converts the track's Track Ticks (block timestamps, BlockDuration) into Segment Ticks. */
	trackTimestampScale: number;
	seekPreRollNs: number;
	name: string | null;
	languageCode: string;
	hasLanguageBcp47: boolean;
	decodingInstructions: DecodingInstruction[];

	info:
		| null
		| {
			type: 'video';
			width: number;
			height: number;
			/** The pixels to remove at each edge (top, bottom, left, right) to get the visible frame. */
			pixelCrop: [number, number, number, number];
			displayWidth: number | null;
			displayHeight: number | null;
			displayUnit: number;
			squarePixelWidth: number;
			squarePixelHeight: number;
			/** Exact, unlike the square pixel size */
			pixelAspectRatio: Rational;
			horizontalScale: number;
			verticalScale: number;
			rotation: Rotation;
			codec: VideoCodec | null;
			codecDescription: Uint8Array | null;
			colorSpace: VideoColorSpaceInit;
			alphaMode: boolean;
			proresFormat: ProresFourCc | null;
		}
		| {
			type: 'audio';
			numberOfChannels: number;
			sampleRate: number;
			outputSampleRate: number | null;
			bitDepth: number;
			codec: AudioCodec | null;
			codecDescription: Uint8Array | null;
			aacCodecInfo: AacCodecInfo | null;
			dtsFormat: DtsFourCc | null;
		};
};
type InternalVideoTrack = InternalTrack & { info: { type: 'video' } };
type InternalAudioTrack = InternalTrack & { info: { type: 'audio' } };

const METADATA_ELEMENTS = [
	{ id: EBMLId.SeekHead, flag: 'seekHeadSeen' },
	{ id: EBMLId.Info, flag: 'infoSeen' },
	{ id: EBMLId.Tracks, flag: 'tracksSeen' },
	{ id: EBMLId.Cues, flag: 'cuesSeen' },
] as const;
type VorbisInfo = NonNullable<OggCodecInfo['vorbisInfo']>;

const vorbisInfoCache = new WeakMap<InternalTrack, VorbisInfo | null>();

/** Reads the block sizes and modes from a Vorbis track's CodecPrivate, which holds the three header packets. */
const getVorbisInfo = (track: InternalTrack) => {
	let vorbisInfo = vorbisInfoCache.get(track);
	if (vorbisInfo !== undefined) {
		return vorbisInfo;
	}

	vorbisInfo = null;
	const bytes = track.codecPrivate;

	// The header packets are Xiph-laced: the packet count minus one, then the sizes of all packets but the last
	if (track.info?.codec === 'vorbis' && bytes && bytes[0] === 2) {
		let pos = 1;
		const packetSizes: number[] = [];

		while (packetSizes.length < 2 && pos < bytes.length) {
			let size = 0;
			let value: number;
			do {
				value = bytes[pos++] ?? 0;
				size += value;
			} while (value === 255 && pos < bytes.length);

			packetSizes.push(size);
		}

		const identificationHeader = bytes.subarray(pos, pos + (packetSizes[0] ?? 0));
		const setupHeader = bytes.subarray(pos + (packetSizes[0] ?? 0) + (packetSizes[1] ?? 0));

		if (packetSizes.length === 2 && identificationHeader.length >= 30 && setupHeader.length > 0) {
			try {
				const blockSizeByte = identificationHeader[28]!;
				vorbisInfo = {
					blocksizes: [1 << (blockSizeByte & 0xf), 1 << (blockSizeByte >> 4)],
					modeBlockflags: parseModesFromVorbisSetupPacket(setupHeader).modeBlockflags,
				};
			} catch {
				// Leave it null; laced frames then share the block's duration evenly
			}
		}
	}

	vorbisInfoCache.set(track, vorbisInfo);
	return vorbisInfo;
};

/**
 * Returns the number of samples in an audio packet, at the track's sample rate, for codecs where the packet (and the
 * codec configuration) alone tell it.
 */
const getPacketSampleCount = (track: InternalTrack, data: Uint8Array): number | null => {
	if (track.info?.type !== 'audio' || data.length === 0) {
		return null;
	}

	const { codec, sampleRate } = track.info;
	switch (codec) {
		case 'opus': {
			return parseOpusTocByte(data).durationInSamples; // At 48 kHz, the sample rate of every Opus track
		}

		case 'aac': {
			// A frame holds frameLength samples at the core sample rate (half the output rate with SBR)
			try {
				const config = parseAacAudioSpecificConfig(track.codecPrivate);
				return config.coreSampleRate ? config.frameLength * sampleRate / config.coreSampleRate : null;
			} catch {
				return null;
			}
		}

		case 'mp3': {
			if (data.length < 4) {
				return null;
			}

			const word = ((data[0]! << 24) | (data[1]! << 16) | (data[2]! << 8) | data[3]!) >>> 0;
			const { header } = readMp3FrameHeader(word, null);
			return header ? header.audioSamplesInFrame * sampleRate / header.sampleRate : null;
		}

		case 'ac3': {
			return 6 * 256; // Six blocks of 256 samples
		}

		case 'eac3': {
			if (data.length < 5 || data[0] !== 0x0b || data[1] !== 0x77) {
				return null;
			}

			const fscod = data[4]! >> 6;
			const numblkscod = fscod === 3 ? 3 : (data[4]! >> 4) & 0x03; // Six blocks when fscod is 3
			return EAC3_NUMBLKS_TABLE[numblkscod]! * 256;
		}

		case 'flac': {
			if (data.length < 5 || data[0] !== 0xff || (data[1]! & 0xfe) !== 0xf8) {
				return null;
			}

			const blockSize = getBlockSizeOrUncommon(data[2]! >> 4);
			if (blockSize === null || typeof blockSize === 'number') {
				return blockSize;
			}

			// An uncommon block size follows the frame or sample number, coded in 1 to 7 bytes like UTF-8
			const firstByte = data[4]!;
			let numberLength = 1;
			if (firstByte & 0x80) {
				numberLength = 0;
				while (numberLength < 8 && (firstByte & (0x80 >> numberLength))) {
					numberLength++;
				}
				if (numberLength < 2 || numberLength > 7) {
					return null;
				}
			}

			const position = 4 + numberLength;
			if (blockSize === 'uncommon-u8' && position < data.length) {
				return data[position]! + 1;
			} else if (blockSize === 'uncommon-u16' && position + 1 < data.length) {
				return ((data[position]! << 8) | data[position + 1]!) + 1;
			}

			return null;
		}

		default: {
			if (codec && (PCM_AUDIO_CODECS as readonly string[]).includes(codec)) {
				const { sampleSize } = parsePcmCodec(codec as PcmAudioCodec);
				return Math.floor(data.length / (sampleSize * track.info.numberOfChannels));
			}

			return null;
		}
	}
};

/**
 * Ranks the Matroska spec's cover art file names, best first: cover.*, cover_land.*, small_cover.*, small_cover_land.*.
 * Returns null for other names.
 */
const getCoverArtRank = (fileName: string | null | undefined) => {
	const match = fileName && /^(small_)?cover(_land)?\./.exec(fileName.toLowerCase());
	return match ? (match[1] ? 2 : 0) + (match[2] ? 1 : 0) : null;
};

/**
 * The spec's cover art names are versions of the same cover, so the best one there is the front cover (cover.*
 * always). Done once all attachments are read, whatever their order.
 */
const pickFrontCover = (images: AttachedImage[]) => {
	const ranks = images.map(image => getCoverArtRank(image.name));
	const bestRank = Math.min(...ranks.map(rank => rank ?? Infinity));
	images.forEach((image, i) => {
		if (ranks[i] !== null) {
			image.kind = ranks[i] === bestRank ? 'coverFront' : 'unknown';
		}
	});
};

const MAX_RESYNC_LENGTH = 10 * 2 ** 20; // 10 MiB
const MAX_SCANNED_NEXT_CLUSTER_ELEMENTS = 256;
const MAX_ELEMENT_NESTING_DEPTH = 64;
// H.264 reorders a frame past at most 16 others (its largest DPB), HEVC a picture past at most 15; a frame can come as
// two field blocks
const MAX_REORDER_BLOCKS = 32;
// How many of the clusters read last are kept
const RECENT_CLUSTER_COUNT = 2;

/** Whether a cluster in the position cache holds a key frame presented at or before the given timestamp. */
const holdsKeyFrameAtOrBefore = (entry: InternalTrack['clusterPositionCache'][number], timestamp: number) => {
	return entry.firstKeyFrameTimestamp !== null && entry.firstKeyFrameTimestamp <= timestamp;
};

/** Whether the track's codec may have B-frames, so that its blocks are stored out of presentation order. */
const trackMayReorder = (track: InternalTrack) => {
	return track.info?.type === 'video'
		&& (track.info.codec === 'avc' || track.info.codec === 'hevc' || track.info.codec === null);
};

/**
 * Builds the AudioSpecificConfig for the deprecated `A_AAC/MPEG2/...` and `A_AAC/MPEG4/...` codec IDs, which name the
 * AAC profile in the codec ID and come without CodecPrivate (written by old versions of mkvmerge, among others). Like
 * FFmpeg's Matroska demuxer, the config is derived from the codec ID and the audio settings.
 */
const buildLegacyAacAudioSpecificConfig = (
	codecId: string,
	sampleRate: number,
	outputSampleRate: number,
	numberOfChannels: number,
) => {
	if (!/^A_AAC\/MPEG[24]\//.test(codecId)) {
		return null;
	}

	let objectType: number;
	if (codecId.includes('SBR')) {
		objectType = 5;
	} else if (codecId.includes('MAIN')) {
		objectType = 1;
	} else if (codecId.includes('LC')) {
		objectType = 2;
	} else if (codecId.includes('SSR')) {
		objectType = 3;
	} else {
		objectType = 4; // LTP
	}

	try {
		return buildAacAudioSpecificConfig({
			objectType,
			// SamplingFrequency is the core coder's rate and OutputSamplingFrequency the rate after SBR (usually twice
			// as high). Signaling SBR explicitly with that output rate covers downsampled SBR (equal rates) as well.
			coreSampleRate: sampleRate,
			outputSampleRate: objectType === 5 ? outputSampleRate : sampleRate,
			outputNumberOfChannels: numberOfChannels,
			programConfigElement: null,
		});
	} catch {
		return null; // Channel count that can't be signaled without a PCE
	}
};

export class MatroskaDemuxer extends Demuxer {
	reader: Reader;

	readMetadataPromise: Promise<void> | null = null;

	segments: Segment[] = [];
	currentSegment: Segment | null = null;
	currentTrack: InternalTrack | null = null;
	currentCluster: Cluster | null = null;
	currentBlock: ClusterBlock | null = null;
	currentBlockAdditional: {
		addId: number;
		data: Uint8Array | null;
	} | null = null;

	currentCueTime: number | null = null;
	currentDecodingInstruction: DecodingInstruction | null = null;
	currentTagTargetIsMovie: boolean = true;
	/** The SimpleTag being read; SimpleTags can be nested to describe their parent (e.g. ARTIST > SORT_WITH). */
	currentSimpleTag: {
		name: string | null;
		language: string | null;
		isDefault: boolean;
		parent: MatroskaDemuxer['currentSimpleTag'];
	} | null = null;

	pendingTagValues: { name: string; value: string | Uint8Array; rank: number }[] = [];
	currentAttachedFile: {
		fileUid: bigint | null;
		fileName: string | null;
		fileMediaType: string | null;
		fileData: Uint8Array | null;
		fileDescription: string | null;
	} | null = null;

	isWebM = false;
	claimedSeekTargets = new Set<number>();
	elementNestingDepth = 0;

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.segments.flatMap(segment => segment.tracks.map(track => track.trackBacking!));
	}

	override async getMimeType() {
		await this.readMetadata();

		const backings = await this.getTrackBackings();
		const codecStrings = await Promise.all(backings.map(
			x => x.getDecoderConfig().then(c => c?.codec ?? null),
		));

		return buildMatroskaMimeType({
			isWebM: this.isWebM,
			hasVideo: this.segments.some(segment => segment.tracks.some(x => x.info?.type === 'video')),
			hasAudio: this.segments.some(segment => segment.tracks.some(x => x.info?.type === 'audio')),
			codecStrings: codecStrings.filter(Boolean) as string[],
		});
	}

	async getMetadataTags() {
		await this.readMetadata();

		// Load metadata tags from each segment lazily (only once)
		for (const segment of this.segments) {
			if (!segment.metadataTagsPromise) {
				if (this.reader.fileSize !== null) {
					segment.metadataTagsPromise = this.loadSegmentMetadata(segment);
				} else {
					// The seeking would be too crazy, let's not
					segment.metadataTagsPromise = Promise.resolve();
				}
			}

			await segment.metadataTagsPromise;
		}

		// This is kinda handwavy, and how we handle multiple segments isn't suuuuper well-defined anyway; so we just
		// shallow-merge metadata tags from all (usually just one) segments.
		let metadataTags: MetadataTags = {};
		for (const segment of this.segments) {
			metadataTags = { ...metadataTags, ...segment.metadataTags };
		}

		if (metadataTags.images) {
			pickFrontCover(metadataTags.images);
		}

		return metadataTags;
	}

	readMetadata() {
		return this.readMetadataPromise ??= (async () => {
			let currentPos = 0;

			// Loop over all top-level elements in the file
			while (true) {
				let slice = this.reader.requestSliceRange(currentPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
				if (isThenable(slice)) slice = await slice;
				if (!slice) break;

				const header = readElementHeader(slice);
				const isJunkBeforeSegment = this.segments.length === 0 && (
					!header
					|| ![EBMLId.EBML, EBMLId.Segment, EBMLId.Void].includes(header.id)
				);
				if (isJunkBeforeSegment) {
					// Like zero bytes or garbage between the EBML header and the Segment. Resync to the next EBML
					// header or Segment, as FFmpeg does.
					const nextPos = await resync(
						this.reader,
						currentPos + 1,
						LEVEL_0_EBML_IDS,
						Math.min(this.reader.fileSize ?? Infinity, currentPos + MAX_RESYNC_LENGTH),
					);
					if (nextPos === null) {
						break;
					}

					currentPos = nextPos;
					continue;
				}

				if (!header) {
					break; // Zero padding at the end of the file triggers this, for example
				}

				const id = header.id;
				let size = header.size;
				const dataStartPos = slice.filePos;

				if (id === EBMLId.EBML) {
					assertDefinedSize(size);

					let slice = this.reader.requestSlice(dataStartPos, size);
					if (isThenable(slice)) slice = await slice;
					if (!slice) break;

					this.readContiguousElements(slice);
				} else if (id === EBMLId.Segment) { // Segment found!
					if (size === 0) {
						// A Segment can't be empty (it needs Info and Tracks), so its size was never filled in. Read
						// the elements that follow as its own, as FFmpeg does.
						size = undefined;
					}

					await this.readSegment(dataStartPos, size);

					if (size === undefined) {
						// Segment sizes can be undefined (common in livestreamed files), so assume this is the last
						// and only segment
						break;
					}

					if (this.reader.fileSize === null) {
						break; // Stop at the first segment
					}
				} else if (id === EBMLId.Cluster) {
					if (this.reader.fileSize === null) {
						break; // Shouldn't be reached anyway, since we stop at the first segment
					}

					// Clusters are not a top-level element in Matroska, but some files contain a Segment whose size
					// doesn't contain any of the clusters that follow it. In the case, we apply the following logic: if
					// we find a top-level cluster, attribute it to the previous segment.

					if (size === undefined) {
						// Just in case this is one of those weird sizeless clusters, let's do our best and still try to
						// determine its size.
						const nextElementPos = await searchForNextElementId(
							this.reader,
							dataStartPos,
							LEVEL_0_AND_1_EBML_IDS,
							this.reader.fileSize,
						);
						size = nextElementPos.pos - dataStartPos;
					}

					const lastSegment = last(this.segments);
					if (lastSegment) {
						// Extend the previous segment's size
						lastSegment.elementEndPos = dataStartPos + size;
					}
				}

				assertDefinedSize(size);
				currentPos = dataStartPos + size;
			}
		})();
	}

	async readSegment(segmentDataStart: number, dataSize: number | undefined) {
		this.currentSegment = {
			seekHeadSeen: false,
			infoSeen: false,
			tracksSeen: false,
			cuesSeen: false,
			tagsSeen: false,
			attachmentsSeen: false,

			timestampScale: -1,
			timestampFactor: -1,
			duration: -1,
			seekEntries: [],
			tracks: [],
			idToTrack: new Map(),
			cuePoints: [],

			dataStartPos: segmentDataStart,
			elementEndPos: dataSize === undefined
				? null // Assume it goes until the end of the file
				: segmentDataStart + dataSize,
			clusterSeekStartPos: segmentDataStart,

			recentClusters: [],
			get lastReadCluster() {
				return last(this.recentClusters) ?? null;
			},
			clusterSummaries: new Map(),

			metadataTags: {},
			metadataTagsPromise: null,
		};
		this.segments.push(this.currentSegment);

		let currentPos = segmentDataStart;
		const visitedSeekHeadPositions = new Set<number>();

		while (this.currentSegment.elementEndPos === null || currentPos < this.currentSegment.elementEndPos) {
			let slice = this.reader.requestSliceRange(currentPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
			if (isThenable(slice)) slice = await slice;
			if (!slice) break;

			const elementStartPos = currentPos;
			const header = readElementHeader(slice);

			if (!header || (!LEVEL_1_EBML_IDS.includes(header.id) && header.id !== EBMLId.Void)) {
				// Potential junk. Let's try to resync (skipping the current position, which might hold a valid ID
				// followed by a broken size)

				const nextPos = await resync(
					this.reader,
					elementStartPos + 1,
					LEVEL_1_EBML_IDS,
					Math.min(this.currentSegment.elementEndPos ?? Infinity, elementStartPos + MAX_RESYNC_LENGTH),
				);

				if (nextPos) {
					currentPos = nextPos;
					continue;
				} else {
					break; // Resync failed
				}
			}

			const { id, size } = header;
			const dataStartPos = slice.filePos;

			const metadataElementIndex = METADATA_ELEMENTS.findIndex(x => x.id === id);
			if (metadataElementIndex !== -1) {
				const field = METADATA_ELEMENTS[metadataElementIndex]!.flag;
				this.currentSegment[field] = true;

				if (id === EBMLId.SeekHead) {
					visitedSeekHeadPositions.add(elementStartPos - segmentDataStart);
				}

				assertDefinedSize(size);

				let slice = this.reader.requestSlice(dataStartPos, size);
				if (isThenable(slice)) slice = await slice;

				if (slice) {
					this.readContiguousElements(slice);
				}
			} else if (id === EBMLId.Attachments && size !== undefined && this.reader.fileSize !== null) {
				// Attachments (fonts, cover art) can be large, so they're only read once the metadata tags are asked
				// for, like when the seek head points to them. (A source of unknown size gets read in order, so there,
				// they're read right away.)
				const segmentPosition = elementStartPos - segmentDataStart;
				if (!this.currentSegment.seekEntries.some(x => x.id === id && x.segmentPosition === segmentPosition)) {
					this.currentSegment.seekEntries.push({ id, segmentPosition });
				}
			} else if (id === EBMLId.Tags || id === EBMLId.Attachments) {
				// Metadata found at the beginning of the segment, great, let's parse it
				if (id === EBMLId.Tags) {
					this.currentSegment.tagsSeen = true;
				} else {
					this.currentSegment.attachmentsSeen = true;
				}

				assertDefinedSize(size);

				let slice = this.reader.requestSlice(dataStartPos, size);
				if (isThenable(slice)) slice = await slice;

				if (slice) {
					this.readContiguousElements(slice);
				}
			} else if (id === EBMLId.Cluster) {
				this.currentSegment.clusterSeekStartPos = elementStartPos;
				break; // Stop at the first cluster
			}

			if (size === undefined) {
				break;
			} else {
				currentPos = dataStartPos + size;
			}
		}

		if (this.reader.fileSize !== null) {
			// Seek heads can sometimes point to other seek heads, so follow them until there are no unvisited
			// ones left. Following a seek head appends its entries to the list we're iterating over.
			for (let i = 0; i < this.currentSegment.seekEntries.length; i++) {
				const seekEntry = this.currentSegment.seekEntries[i]!;
				if (seekEntry.id !== EBMLId.SeekHead || visitedSeekHeadPositions.has(seekEntry.segmentPosition)) {
					continue;
				}

				visitedSeekHeadPositions.add(seekEntry.segmentPosition);
				if (!this.claimSeekTarget(segmentDataStart + seekEntry.segmentPosition)) {
					continue;
				}

				let slice = this.reader.requestSliceRange(
					segmentDataStart + seekEntry.segmentPosition,
					MIN_HEADER_SIZE,
					MAX_HEADER_SIZE,
				);
				if (isThenable(slice)) slice = await slice;
				if (!slice) continue;

				const header = readElementHeader(slice);
				if (!header || header.id !== EBMLId.SeekHead) continue;

				const { size } = header;
				assertDefinedSize(size);

				let dataSlice = this.reader.requestSlice(slice.filePos, size);
				if (isThenable(dataSlice)) dataSlice = await dataSlice;
				if (!dataSlice) continue;

				this.readContiguousElements(dataSlice);
			}
		}

		// Sort the seek entries by file position so reading them exhibits a sequential pattern
		this.currentSegment.seekEntries.sort((a, b) => a.segmentPosition - b.segmentPosition);

		if (this.reader.fileSize !== null) {
			// Use the seek head to read missing metadata elements
			for (const seekEntry of this.currentSegment.seekEntries) {
				const target = METADATA_ELEMENTS.find(x => x.id === seekEntry.id);
				if (!target) {
					continue;
				}

				if (this.currentSegment[target.flag]) continue;
				if (!this.claimSeekTarget(segmentDataStart + seekEntry.segmentPosition)) continue;

				let slice = this.reader.requestSliceRange(
					segmentDataStart + seekEntry.segmentPosition,
					MIN_HEADER_SIZE,
					MAX_HEADER_SIZE,
				);
				if (isThenable(slice)) slice = await slice;
				if (!slice) continue;

				const header = readElementHeader(slice);
				if (!header) continue;

				const { id, size } = header;
				if (id !== target.id) continue;

				assertDefinedSize(size);

				this.currentSegment[target.flag] = true;

				let dataSlice = this.reader.requestSlice(slice.filePos, size);
				if (isThenable(dataSlice)) dataSlice = await dataSlice;
				if (!dataSlice) continue;

				this.readContiguousElements(dataSlice);
			}
		}

		if (this.currentSegment.timestampScale === -1) {
			// TimestampScale element is missing. Technically an invalid file, but let's default to the typical value,
			// which is 1e6.
			this.currentSegment.timestampScale = 1e6;
			this.currentSegment.timestampFactor = 1e9 / 1e6;
		}

		// Compute default duration and codec delay for all tracks now that we have the timestamp factor
		for (const track of this.currentSegment.tracks) {
			if (track.defaultDurationNs !== null) {
				track.defaultDuration = (this.currentSegment.timestampFactor * track.defaultDurationNs) / 1e9;
			}

			track.codecDelay = Math.round((this.currentSegment.timestampFactor * track.codecDelayNs) / 1e9);
		}

		// Assign cue points to their respective tracks
		for (const cuePoint of this.currentSegment.cuePoints) {
			const track = this.currentSegment.idToTrack.get(cuePoint.trackId);
			if (track) {
				track.cuePoints.push(cuePoint);
			}
		}

		for (const track of this.currentSegment.tracks) {
			// Sort cue points by time and remove multiple cue points for the same time
			const cuePoints = track.cuePoints;
			cuePoints.sort((a, b) => a.time - b.time);

			let writeIndex = 0;
			for (const cuePoint of cuePoints) {
				if (writeIndex === 0 || cuePoint.time !== cuePoints[writeIndex - 1]!.time) {
					cuePoints[writeIndex++] = cuePoint;
				}
			}
			cuePoints.length = writeIndex;
		}

		let trackWithMostCuePoints: InternalTrack | null = null;
		let maxCuePointCount = -Infinity;
		for (const track of this.currentSegment.tracks) {
			if (track.cuePoints.length > maxCuePointCount) {
				maxCuePointCount = track.cuePoints.length;
				trackWithMostCuePoints = track;
			}
		}

		// For every track that has received 0 cue points (can happen, often only the video track receives cue points),
		// we still want to have better seeking. Therefore, let's give it the cue points of the track with the most cue
		// points, which should provide us with the most fine-grained seeking.
		for (const track of this.currentSegment.tracks) {
			if (track.cuePoints.length === 0) {
				track.cuePoints = trackWithMostCuePoints!.cuePoints;
			}
		}

		this.currentSegment = null;
	}

	/** Returns the cluster at the given position if it was read just before. */
	getRecentCluster(segment: Segment, startPos: number) {
		return segment.recentClusters.find(x => x.elementStartPos === startPos) ?? null;
	}

	async readCluster(startPos: number, segment: Segment) {
		const recentCluster = this.getRecentCluster(segment, startPos);
		if (recentCluster) {
			return recentCluster;
		}

		let headerSlice = this.reader.requestSliceRange(startPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
		if (isThenable(headerSlice)) headerSlice = await headerSlice;
		assert(headerSlice);

		const elementStartPos = startPos;
		const elementHeader = readElementHeader(headerSlice);
		assert(elementHeader);

		const id = elementHeader.id;
		assert(id === EBMLId.Cluster);

		let size = elementHeader.size;
		const dataStartPos = headerSlice.filePos;

		if (size === undefined) {
			// The cluster's size is undefined (can happen in livestreamed files). We'd still like to know the size of
			// it, so we have no other choice but to iterate over the EBML structure until we find an element at level
			// 0 or 1, indicating the end of the cluster (all elements inside the cluster are at level 2).
			const nextElementPos = await searchForNextElementId(
				this.reader,
				dataStartPos,
				LEVEL_0_AND_1_EBML_IDS,
				segment.elementEndPos,
			);

			size = nextElementPos.pos - dataStartPos;
		}

		// Load the entire cluster
		let dataSlice = this.reader.requestSlice(dataStartPos, size);
		if (isThenable(dataSlice)) dataSlice = await dataSlice;

		const fileSize = this.reader.fileSizeNonStrict;
		if (!dataSlice && fileSize !== null && fileSize > dataStartPos) {
			// The file got cut off in the middle of the cluster: load whatever's left of it. A source that can only be
			// streamed may not hold it anymore after reading up to the end of the file to find that out; then the
			// cluster is lost, as it was before.
			try {
				dataSlice = this.reader.requestSlice(dataStartPos, fileSize - dataStartPos);
				if (isThenable(dataSlice)) {
					dataSlice = await dataSlice;
				}
			} catch {
				dataSlice = null;
			}
		}

		const cluster: Cluster = {
			segment,
			elementStartPos,
			elementEndPos: dataStartPos + size,
			dataStartPos,
			timestamp: 0, // In case the cluster lacks its (mandatory) Timestamp element
			trackData: new Map(),
		};
		if (dataSlice) {
			this.currentCluster = cluster;

			try {
				// Read the children of the cluster, stopping early at level 0 or 1 EBML elements. We do this because
				// some clusters have incorrect sizes that are too large
				const endPos = this.readContiguousElements(dataSlice, LEVEL_0_AND_1_EBML_IDS);
				cluster.elementEndPos = endPos;
			} finally {
				this.currentCluster = null;
				this.currentBlock = null;
			}
		}

		// A cluster's last laced Vorbis or Opus block without BlockDuration or DefaultDuration lasts as long as its
		// frames say, but not past the track's next block, which is then looked up in the next cluster
		const tracksNeedingNextBlock = new Set<number>();
		for (const [trackNumber, { track, blocks }] of cluster.trackData) {
			if (
				track.defaultDuration != null
				|| track.info?.type !== 'audio'
				|| (track.info.codec !== 'vorbis' && track.info.codec !== 'opus')
				|| blocks.length === 0
			) {
				continue;
			}

			const lastBlock = blocks.reduce((a, b) => (b.timestamp >= a.timestamp ? b : a));
			if (
				lastBlock.duration === 0
				&& (lastBlock.lacing !== BlockLacing.None || track.info.codec === 'vorbis')
			) {
				tracksNeedingNextBlock.add(trackNumber);
			}
		}
		const nextBlockTimestamps = tracksNeedingNextBlock.size > 0
			? await this.readNextBlockTimestamps(cluster, tracksNeedingNextBlock)
			: new Map<number, number>();

		for (const [, trackData] of cluster.trackData) {
			const track = trackData.track;

			// This must hold, as track datas only get created if a block for that track is encountered
			assert(trackData.blocks.length > 0);

			let hasLacedBlocks = false;

			for (let i = 0; i < trackData.blocks.length; i++) {
				const block = trackData.blocks[i]!;
				// Block timestamps and BlockDuration are in Track Ticks, the cluster's timestamp in Segment Ticks
				block.timestamp = cluster.timestamp + block.timestamp * track.trackTimestampScale;
				block.duration *= track.trackTimestampScale;

				hasLacedBlocks ||= block.lacing !== BlockLacing.None;
			}

			trackData.presentationTimestamps = trackData.blocks
				.map((block, i) => ({ timestamp: block.timestamp, blockIndex: i }))
				.sort((a, b) => a.timestamp - b.timestamp);

			let lastDurationIsFromCodec = false;
			for (let i = 0; i < trackData.presentationTimestamps.length; i++) {
				const currentEntry = trackData.presentationTimestamps[i]!;
				const currentBlock = trackData.blocks[currentEntry.blockIndex]!;

				if (trackData.firstKeyFrameTimestamp === null && currentBlock.isKeyFrame) {
					trackData.firstKeyFrameTimestamp = currentBlock.timestamp;
				}

				if (i < trackData.presentationTimestamps.length - 1) {
					if (!currentBlock.hasBlockDuration) {
						// Without a BlockDuration, a frame lasts the track's DefaultDuration, or else until the next
						// block in presentation order (RFC 9559, BlockDuration). Laced blocks still span the gap to
						// the next block, which their frames are spread over: frame count times DefaultDuration often
						// doesn't fit the block timestamps (rounded to the timestamp scale, or a DefaultDuration that
						// is really the block's duration), and the frames would overlap the next block.
						// The DefaultDuration is rounded to whole ticks, so that durations stay multiples of the time
						// resolution like the timestamps.
						const nextEntry = trackData.presentationTimestamps[i + 1]!;
						const isLaced = currentBlock.lacing !== BlockLacing.None;
						currentBlock.duration = track.defaultDuration !== null && !isLaced
							? Math.round(track.defaultDuration)
							: nextEntry.timestamp - currentBlock.timestamp;
					}
				} else if (!currentBlock.hasBlockDuration) {
					if (track.defaultDuration != null) {
						if (currentBlock.lacing === BlockLacing.None) {
							currentBlock.duration = track.defaultDuration;
						} else {
							// Handled by the lace resolution code
						}
					} else if (
						currentBlock.lacing === BlockLacing.None
						&& currentBlock.decoded
						&& track.info?.type === 'audio'
					) {
						// There's no next block to take the duration from, but some codecs' packets tell their own
						const sampleCount = getPacketSampleCount(track, currentBlock.data);
						if (sampleCount !== null) {
							currentBlock.duration = Math.round(
								sampleCount / track.info.sampleRate * segment.timestampFactor,
							);
							lastDurationIsFromCodec = true;
						}
					}
				}
			}

			const finalBlock = trackData.blocks[last(trackData.presentationTimestamps)!.blockIndex]!;
			if (hasLacedBlocks || (finalBlock.duration === 0 && getVorbisInfo(track))) {
				// Perform lace resolution. Here, we expand each laced block into multiple blocks where each contains
				// one frame of the lace. We do this after determining block timestamps so we can properly distribute
				// the block's duration across the laced frames. (This also gives the cluster's last Vorbis block its
				// duration, which takes the block sizes of the frames before it.)
				trackData.blocks = this.expandLacedBlocks(
					trackData.blocks,
					track,
					finalBlock,
					nextBlockTimestamps.get(track.id) ?? null,
				);

				// Recompute since blocks have changed
				trackData.presentationTimestamps = trackData.blocks
					.map((block, i) => ({ timestamp: block.timestamp, blockIndex: i }))
					.sort((a, b) => a.timestamp - b.timestamp);
			}

			const firstBlock = trackData.blocks[trackData.presentationTimestamps[0]!.blockIndex]!;
			const lastBlock = trackData.blocks[last(trackData.presentationTimestamps)!.blockIndex]!;

			trackData.startTimestamp = firstBlock.timestamp;
			// A duration from the codec only describes the packet: the next cluster may begin before it ends, as block
			// timestamps are rounded, so lookups don't count on it
			trackData.endTimestamp = lastBlock.timestamp + (lastDurationIsFromCodec ? 0 : lastBlock.duration);

			// Let's remember that a cluster with a given timestamp is here, speeding up future lookups if no cues exist
			const insertionIndex = binarySearchLessOrEqual(
				track.clusterPositionCache,
				trackData.startTimestamp,
				x => x.startTimestamp,
			);
			const previousEntry = track.clusterPositionCache[insertionIndex];
			const nextEntry = track.clusterPositionCache[insertionIndex + 1];

			// Only remember it if the timestamp order matches the cluster position order
			if (
				(!previousEntry || previousEntry.elementStartPos < elementStartPos)
				&& (!nextEntry || nextEntry.elementStartPos > elementStartPos)
			) {
				track.clusterPositionCache.splice(insertionIndex + 1, 0, {
					elementStartPos: cluster.elementStartPos,
					startTimestamp: trackData.startTimestamp,
					hasKeyFrame: trackData.firstKeyFrameTimestamp !== null,
					firstKeyFrameTimestamp: trackData.firstKeyFrameTimestamp,
				});
			}
		}

		// A lookup often needs the clusters it just read again (like the last ones for the next lookup at the end),
		// which a source that can only be streamed may not hold anymore
		segment.recentClusters.push(cluster);
		if (segment.recentClusters.length > RECENT_CLUSTER_COUNT) {
			segment.recentClusters.shift();
		}
		segment.clusterSummaries.set(startPos, {
			elementEndPos: cluster.elementEndPos,
			trackIds: new Set(cluster.trackData.keys()),
			latestTimestamps: new Map([...cluster.trackData].map(
				([trackId, trackData]) => [trackId, last(trackData.presentationTimestamps)!.timestamp],
			)),
		});

		return cluster;
	}

	getTrackDataInCluster(cluster: Cluster, trackNumber: number) {
		let trackData = cluster.trackData.get(trackNumber);
		if (!trackData) {
			const track = cluster.segment.idToTrack.get(trackNumber);
			if (!track) {
				return null;
			}

			trackData = {
				track,
				startTimestamp: 0,
				endTimestamp: 0,
				firstKeyFrameTimestamp: null,
				blocks: [],
				presentationTimestamps: [],
			};
			cluster.trackData.set(trackNumber, trackData);
		}

		return trackData;
	}

	/**
	 * Finds the timestamps of the given tracks' first blocks in the cluster that directly follows the given one. Only
	 * element headers and the start of each block are read. A track with no block there (or within the first elements
	 * scanned) is left out.
	 */
	async readNextBlockTimestamps(cluster: Cluster, trackNumbers: Set<number>) {
		const result = new Map<number, number>();
		const segmentEndPos = cluster.segment.elementEndPos;

		const readHeader = async (pos: number) => {
			if (segmentEndPos !== null && pos > segmentEndPos - MIN_HEADER_SIZE) {
				return null;
			}

			let slice = this.reader.requestSliceRange(pos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
			if (isThenable(slice)) {
				slice = await slice;
			}
			if (!slice || slice.remainingLength < MIN_HEADER_SIZE) {
				return null;
			}

			const header = readElementHeader(slice);
			if (!header || header.size === undefined) {
				return null;
			}

			return { id: header.id, dataStartPos: slice.filePos, endPos: slice.filePos + header.size };
		};

		const clusterHeader = await readHeader(cluster.elementEndPos);
		if (!clusterHeader || clusterHeader.id !== EBMLId.Cluster) {
			return result;
		}

		let clusterTimestamp: number | null = null;
		let pos = clusterHeader.dataStartPos;

		for (let i = 0; i < MAX_SCANNED_NEXT_CLUSTER_ELEMENTS && result.size < trackNumbers.size; i++) {
			const header = await readHeader(pos);
			if (!header || LEVEL_0_AND_1_EBML_IDS.includes(header.id)) {
				break; // The next cluster ended (its size may be unknown)
			}

			if (header.id === EBMLId.Timestamp) {
				let slice = this.reader.requestSlice(header.dataStartPos, header.endPos - header.dataStartPos);
				if (isThenable(slice)) {
					slice = await slice;
				}
				if (!slice) {
					break;
				}

				clusterTimestamp = readUnsignedInt(slice, header.endPos - header.dataStartPos);
			} else if (header.id === EBMLId.SimpleBlock || header.id === EBMLId.BlockGroup) {
				if (clusterTimestamp === null) {
					break; // The Timestamp comes before the blocks
				}

				let block: { dataStartPos: number; endPos: number } | null = header;
				if (header.id === EBMLId.BlockGroup) {
					// Look for the Block among the group's children
					block = null;
					for (let childPos = header.dataStartPos; childPos < header.endPos;) {
						const child = await readHeader(childPos);
						if (!child) {
							break;
						}
						if (child.id === EBMLId.Block) {
							block = child;
							break;
						}

						childPos = child.endPos;
					}
				}

				if (block) {
					// A block starts with its track number and its timestamp relative to the cluster's
					let slice = this.reader.requestSliceRange(
						block.dataStartPos,
						1,
						Math.min(block.endPos - block.dataStartPos, MAX_VAR_INT_SIZE + 2),
					);
					if (isThenable(slice)) {
						slice = await slice;
					}

					const trackNumber = slice ? readVarInt(slice) : null;
					if (
						slice
						&& trackNumber !== null
						&& slice.remainingLength >= 2
						&& trackNumbers.has(trackNumber)
						&& !result.has(trackNumber)
					) {
						result.set(trackNumber, clusterTimestamp + readI16Be(slice));
					}
				}
			}

			pos = header.endPos;
		}

		return result;
	}

	expandLacedBlocks(
		blocks: ClusterBlock[],
		track: InternalTrack,
		// The cluster's last block of this track in presentation order, and the timestamp of the track's next block
		// after it (in the next cluster), if known
		finalBlock: ClusterBlock,
		nextBlockTimestamp: number | null,
	) {
		// https://www.matroska.org/technical/notes.html#block-lacing

		const expandedBlocks: ClusterBlock[] = [];

		// Vorbis frames last (previous block size + own block size) / 4 samples, so the frames of a lace can all differ
		const vorbisInfo = getVorbisInfo(track);
		let lastVorbisBlocksize: number | null = null; // Of the previous frame; unknown at the start of the cluster

		const getVorbisDurations = (frames: Uint8Array[], previousBlocksize: number | null) => {
			assert(vorbisInfo);
			const codecInfo: OggCodecInfo = { codec: 'vorbis', vorbisInfo, opusInfo: null };

			let blocksize = previousBlocksize;
			try {
				const durations = frames.map((frame) => {
					const metadata = extractSampleMetadata(frame, codecInfo, blocksize);
					blocksize = metadata.vorbisBlockSize;
					return metadata.durationInSamples;
				});

				return { durations, lastBlocksize: blocksize };
			} catch {
				return null; // Invalid mode number
			}
		};

		/** Returns the number of samples in each frame of a lace, for codecs whose frames tell it. */
		const getSampleCounts = (frames: Uint8Array[], blockDuration: number, ticksPerSample: number) => {
			if (vorbisInfo) {
				let result = getVorbisDurations(frames, lastVorbisBlocksize);
				if (result && lastVorbisBlocksize === null && blockDuration > 0) {
					// The frame before this block is in another cluster. Whether it used a short or a long block
					// changes the first frame's duration, so take whichever fits the block's duration best.
					const totalTicks = (durations: number[]) => durations.reduce((a, b) => a + b, 0) * ticksPerSample;
					const alternative = getVorbisDurations(frames, vorbisInfo.blocksizes[1]!);
					if (
						alternative
						&& Math.abs(totalTicks(alternative.durations) - blockDuration)
						< Math.abs(totalTicks(result.durations) - blockDuration)
					) {
						result = alternative;
					}
				}

				lastVorbisBlocksize = result?.lastBlocksize ?? null;
				return result?.durations ?? null;
			} else if (track.info?.type === 'audio' && track.info.codec === 'opus') {
				return frames.map(frame => parseOpusTocByte(frame).durationInSamples);
			}

			return null;
		};

		for (const originalBlock of blocks) {
			if (originalBlock.lacing === BlockLacing.None) {
				expandedBlocks.push(originalBlock);

				if (vorbisInfo) {
					const result: ReturnType<typeof getVorbisDurations> = originalBlock.decoded
						? getVorbisDurations([originalBlock.data], lastVorbisBlocksize)
						: null;

					const isFinalWithoutDuration = originalBlock === finalBlock && originalBlock.duration === 0;
					if (result && lastVorbisBlocksize !== null && isFinalWithoutDuration) {
						// The cluster's last block, with no block after it to take the duration from: it lasts as long
						// as its block sizes say, but not past the track's next block
						assert(track.info?.type === 'audio');
						const ticksPerSample = track.segment.timestampFactor / track.info.sampleRate;
						const untilNextBlock = nextBlockTimestamp !== null
							? nextBlockTimestamp - originalBlock.timestamp
							: Infinity;
						originalBlock.duration = Math.min(
							Math.round(result.durations[0]! * ticksPerSample),
							Math.max(untilNextBlock, 0),
						);
					}

					lastVorbisBlocksize = result?.lastBlocksize ?? null;
				}

				continue;
			}

			// Content encodings apply to each frame, excluding the lacing data, so the frames get decoded lazily later
			const slice = FileSlice.tempFromBytes(originalBlock.data);
			if (slice.length === 0) {
				throw new Error('Invalid laced block: no data.');
			}

			const frameSizes: number[] = [];
			const frameCount = readU8(slice) + 1;

			switch (originalBlock.lacing) {
				case BlockLacing.Xiph: {
					let totalUsedSize = 0;

					// Xiph lacing, just like in Ogg
					for (let i = 0; i < frameCount - 1; i++) {
						let frameSize = 0;

						while (slice.bufferPos < slice.length) {
							const value = readU8(slice);
							frameSize += value;

							if (value < 255) {
								frameSizes.push(frameSize);
								totalUsedSize += frameSize;

								break;
							}
						}
					}

					// Compute the last frame's size from whatever's left
					frameSizes.push(slice.length - (slice.bufferPos + totalUsedSize));
				}; break;

				case BlockLacing.FixedSize: {
					// Fixed size lacing: all frames have same size
					const totalDataSize = slice.length - 1; // Minus the frame count byte
					const frameSize = Math.floor(totalDataSize / frameCount);

					for (let i = 0; i < frameCount; i++) {
						frameSizes.push(frameSize);
					}
				}; break;

				case BlockLacing.Ebml: {
					// EBML lacing: first size absolute, subsequent ones are coded as signed differences from the last
					const firstResult = readVarInt(slice);
					if (firstResult === null) {
						throw new Error('Invalid EBML lacing: bad frame size.');
					}

					let currentSize = firstResult;
					frameSizes.push(currentSize);

					let totalUsedSize = currentSize;

					for (let i = 1; i < frameCount - 1; i++) {
						const startPos = slice.bufferPos;
						if (readVarInt(slice) === null) {
							throw new Error('Invalid EBML lacing: bad frame size.');
						}

						// A signed VINT: its value minus a bias of 2^(7n - 1) - 1 (RFC 9559, 10.3.3). Computed with
						// BigInt, since an 8-byte VINT holds more bits than a number does exactly.
						const width = slice.bufferPos - startPos;
						slice.bufferPos = startPos;
						let value = BigInt(readU8(slice) & (0xff >> width)); // Without the width marker
						for (let j = 1; j < width; j++) {
							value = (value << 8n) | BigInt(readU8(slice));
						}
						const diff = Number(value - ((1n << BigInt(7 * width - 1)) - 1n));

						currentSize += diff;
						frameSizes.push(currentSize);

						totalUsedSize += currentSize;
					}

					// Compute the last frame's size from whatever's left
					frameSizes.push(slice.length - (slice.bufferPos + totalUsedSize));
				}; break;

				default: assert(false);
			}

			// Every frame must hold actual data; this also catches frame sizes that exceed the block. Header stripping
			// removes the same leading bytes from every frame though, which may leave nothing of a frame stored.
			const hasStrippedHeader = track.decodingInstructions.some((instruction) => {
				return instruction.data?.type === 'decompress' && (instruction.data.settings?.length ?? 0) > 0;
			});
			const minFrameSize = hasStrippedHeader ? 0 : 1;
			if (frameSizes.length !== frameCount || frameSizes.some(x => x < minFrameSize)) {
				throw new Error('Invalid block lacing: frame sizes don\'t match the block.');
			}

			let blockDuration = originalBlock.duration || frameCount * (track.defaultDuration ?? 0);
			const frames = frameSizes.map(size => readBytes(slice, size));

			// By default, distribute timestamps evenly across the block duration
			let frameBoundaries = frames.map((_, i) => blockDuration * i / frameCount);

			if (track.info?.type === 'audio' && (vorbisInfo || track.info.codec === 'opus')) {
				const ticksPerSample = track.segment.timestampFactor / track.info.sampleRate;

				let sampleCounts: number[] | null = null;
				if (originalBlock.decoded) {
					sampleCounts = getSampleCounts(frames, blockDuration, ticksPerSample);
				} else {
					lastVorbisBlocksize = null; // The frames can only be read once decoded
				}

				const totalTicks = (sampleCounts ?? []).reduce((a, b) => a + b, 0) * ticksPerSample;
				if (sampleCounts && totalTicks > 0) {
					if (blockDuration === 0 && originalBlock === finalBlock) {
						// The last block of a cluster without BlockDuration or DefaultDuration: the frames last as long
						// as they say, but not past the track's next block. (A block followed by one with the same
						// timestamp keeps a duration of 0.)
						const untilNextBlock = nextBlockTimestamp !== null
							? nextBlockTimestamp - originalBlock.timestamp
							: Infinity;
						blockDuration = Math.min(Math.round(totalTicks), Math.max(untilNextBlock, 0));
					}

					// Each frame starts where the frames before it end, on whole ticks. Frames that don't fit in the
					// block (some muxers round block timestamps so that they overlap) are squeezed to fit, which keeps
					// the timestamps in order.
					const scale = Math.min(blockDuration / totalTicks, 1);
					let samplesBefore = 0;
					frameBoundaries = sampleCounts.map((samples) => {
						const boundary = Math.floor(roundIfAlmostInteger(samplesBefore * ticksPerSample * scale));
						samplesBefore += samples;
						return boundary;
					});
				}
			}

			// Now, let's replace the block with one block per frame
			for (let i = 0; i < frameCount; i++) {
				const frameData = frames[i]!;
				const frameTimestamp = originalBlock.timestamp + frameBoundaries[i]!;
				const frameEnd = i < frameCount - 1 ? frameBoundaries[i + 1]! : blockDuration;
				const frameDuration = frameEnd - frameBoundaries[i]!;

				expandedBlocks.push({
					timestamp: frameTimestamp,
					duration: frameDuration,
					isKeyFrame: originalBlock.isKeyFrame,
					data: frameData,
					lacing: BlockLacing.None,
					decoded: originalBlock.decoded,
					postProcessed: false,
					mainAdditional: originalBlock.mainAdditional,
				});
			}
		}

		return expandedBlocks;
	}

	async loadSegmentMetadata(segment: Segment) {
		for (const seekEntry of segment.seekEntries) {
			if (seekEntry.id === EBMLId.Tags && !segment.tagsSeen) {
				// We need to load the tags
			} else if (seekEntry.id === EBMLId.Attachments && !segment.attachmentsSeen) {
				// We need to load the attachments
			} else {
				continue;
			}

			if (!this.claimSeekTarget(segment.dataStartPos + seekEntry.segmentPosition)) {
				continue;
			}

			let slice = this.reader.requestSliceRange(
				segment.dataStartPos + seekEntry.segmentPosition,
				MIN_HEADER_SIZE,
				MAX_HEADER_SIZE,
			);
			if (isThenable(slice)) slice = await slice;
			if (!slice) continue;

			const header = readElementHeader(slice);
			if (!header || header.id !== seekEntry.id) continue;

			const { size } = header;
			assertDefinedSize(size);

			let dataSlice = this.reader.requestSlice(slice.filePos, size);
			if (isThenable(dataSlice)) dataSlice = await dataSlice;
			if (dataSlice) {
				// No awaiting while the segment is set, so concurrent calls can't interfere with each other
				assert(!this.currentSegment);
				this.currentSegment = segment;

				try {
					this.readContiguousElements(dataSlice);
				} finally {
					this.currentSegment = null;
				}
			}

			// Mark as seen
			if (seekEntry.id === EBMLId.Tags) {
				segment.tagsSeen = true;
			} else if (seekEntry.id === EBMLId.Attachments) {
				segment.attachmentsSeen = true;
			}
		}
	}

	claimSeekTarget(position: number) {
		if (this.claimedSeekTargets.has(position)) {
			return false;
		}

		this.claimedSeekTargets.add(position);
		return true;
	}

	readContiguousElements(slice: FileSlice, stopIds?: number[]) {
		if (this.elementNestingDepth === MAX_ELEMENT_NESTING_DEPTH) {
			throw new Error('Invalid file: elements are nested too deeply.');
		}

		this.elementNestingDepth++;

		try {
			while (slice.remainingLength >= MIN_HEADER_SIZE) {
				const startPos = slice.filePos;
				const foundElement = this.traverseElement(slice, stopIds);

				if (!foundElement) {
					return startPos;
				}
			}

			return slice.filePos;
		} finally {
			this.elementNestingDepth--;
		}
	}

	traverseElement(slice: FileSlice, stopIds?: number[]): boolean {
		const header = readElementHeader(slice);
		if (!header) {
			return false;
		}

		if (stopIds && stopIds.includes(header.id)) {
			return false;
		}

		const { id, size } = header;
		const dataStartPos = slice.filePos;
		assertDefinedSize(size);

		if (dataStartPos + size > slice.end) {
			return false; // The element doesn't fit into its parent
		}

		switch (id) {
			case EBMLId.DocType: {
				this.isWebM = readAsciiString(slice, size) === 'webm';
			}; break;

			case EBMLId.Seek: {
				if (!this.currentSegment) break;
				const seekEntry: SeekEntry = { id: -1, segmentPosition: -1 };
				this.currentSegment.seekEntries.push(seekEntry);
				this.readContiguousElements(slice.slice(dataStartPos, size));

				if (seekEntry.id === -1 || seekEntry.segmentPosition === -1) {
					this.currentSegment.seekEntries.pop();
				}
			}; break;

			case EBMLId.SeekID: {
				const lastSeekEntry = this.currentSegment?.seekEntries[this.currentSegment.seekEntries.length - 1];
				if (!lastSeekEntry) break;

				lastSeekEntry.id = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.SeekPosition: {
				const lastSeekEntry = this.currentSegment?.seekEntries[this.currentSegment.seekEntries.length - 1];
				if (!lastSeekEntry) break;

				lastSeekEntry.segmentPosition = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.TimestampScale: {
				if (!this.currentSegment) break;

				const timestampScale = readUnsignedInt(slice, size);
				if (timestampScale === 0) {
					throw new Error('Invalid TimestampScale element: must not be 0.');
				}

				this.currentSegment.timestampScale = timestampScale;
				this.currentSegment.timestampFactor = 1e9 / timestampScale;
			}; break;

			case EBMLId.Duration: {
				if (!this.currentSegment) break;

				this.currentSegment.duration = readFloat(slice, size);
			}; break;

			case EBMLId.DateUTC: {
				if (!this.currentSegment) break;

				const nanoseconds = readSignedBigInt(slice, size);
				this.currentSegment.metadataTags.creationTime = new Date(
					EBML_DATE_EPOCH + Number(nanoseconds / 1_000_000n),
				);
			}; break;

			case EBMLId.TrackEntry: {
				if (!this.currentSegment) break;

				this.currentTrack = {
					id: -1,
					segment: this.currentSegment,
					demuxer: this,
					clusterPositionCache: [],
					cuePoints: [],

					disposition: {
						...DEFAULT_TRACK_DISPOSITION,
						primary: false,
					},
					trackBacking: null,
					codecId: null,
					codecPrivate: null,
					defaultDuration: null,
					defaultDurationNs: null,
					codecDelay: 0,
					codecDelayNs: 0,
					trackTimestampScale: 1,
					seekPreRollNs: 0,
					name: null,
					languageCode: 'eng', // The default in Matroska
					hasLanguageBcp47: false,
					decodingInstructions: [],

					info: null,
				};

				// The Video and Audio elements only get read once the track type is known, but TrackType may come
				// after them, so let's read it first
				const children = slice.slice(dataStartPos, size);
				while (children.remainingLength >= MIN_HEADER_SIZE) {
					const childStartPos = children.filePos;
					const childHeader = readElementHeader(children);
					if (!childHeader || childHeader.size === undefined) {
						break;
					}

					if (childHeader.id === EBMLId.TrackType) {
						children.filePos = childStartPos;
						this.traverseElement(children);
						break;
					}

					children.skip(childHeader.size);
				}

				this.readContiguousElements(slice.slice(dataStartPos, size));

				// Check if track was disabled during parsing (e.g., by FlagEnabled being 0)
				if (!this.currentTrack) {
					break;
				}

				if (this.currentTrack.decodingInstructions.some((instruction) => {
					return instruction.data?.type !== 'decompress'
						|| instruction.scope !== ContentEncodingScope.Block
						|| instruction.data.algorithm !== ContentCompAlgo.HeaderStripping;
				})) {
					Logging._warn(`Track #${this.currentTrack.id} has an unsupported content encoding; dropping.`);
					this.currentTrack = null;
				}

				if (this.currentTrack && this.currentSegment.idToTrack.has(this.currentTrack.id)) {
					// Blocks can't tell the tracks apart
					Logging._warn(`Track #${this.currentTrack.id} is defined more than once; dropping.`);
					this.currentTrack = null;
				}

				if (
					this.currentTrack
					&& this.currentTrack.id !== -1
					&& this.currentTrack.codecId
					&& this.currentTrack.info
				) {
					const slashIndex = this.currentTrack.codecId.indexOf('/');
					const codecIdWithoutSuffix = slashIndex === -1
						? this.currentTrack.codecId
						: this.currentTrack.codecId.slice(0, slashIndex);

					if (
						this.currentTrack.info.type === 'video'
						&& this.currentTrack.info.width !== -1
						&& this.currentTrack.info.height !== -1
					) {
						this.currentTrack.info.squarePixelWidth = this.currentTrack.info.width;
						this.currentTrack.info.squarePixelHeight = this.currentTrack.info.height;

						// The display size applies to the frame after cropping
						const [cropTop, cropBottom, cropLeft, cropRight] = this.currentTrack.info.pixelCrop;
						let visibleWidth = this.currentTrack.info.width - cropLeft - cropRight;
						let visibleHeight = this.currentTrack.info.height - cropTop - cropBottom;
						if (visibleWidth <= 0 || visibleHeight <= 0) {
							// Cropping everything away makes no sense
							visibleWidth = this.currentTrack.info.width;
							visibleHeight = this.currentTrack.info.height;
						}

						let displayWidth = this.currentTrack.info.displayWidth;
						let displayHeight = this.currentTrack.info.displayHeight;
						if (this.currentTrack.info.displayUnit === 0) {
							displayWidth ??= visibleWidth;
							displayHeight ??= visibleHeight;
						}

						if (
							this.currentTrack.info.displayUnit !== 4 // "unknown"
							&& displayWidth !== null
							&& displayHeight !== null
						) {
							const num = displayWidth * visibleHeight;
							const den = displayHeight * visibleWidth;

							if (num > 0 && den > 0) {
								this.currentTrack.info.pixelAspectRatio = simplifyRational({ num, den });
								if (num > den) {
									this.currentTrack.info.squarePixelWidth = Math.round(
										this.currentTrack.info.width * num / den,
									);
								} else {
									this.currentTrack.info.squarePixelHeight = Math.round(
										this.currentTrack.info.height * den / num,
									);
								}
							}
						}

						if (this.currentTrack.codecId === CODEC_STRING_MAP.avc) {
							this.currentTrack.info.codec = 'avc';
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
						} else if (this.currentTrack.codecId === CODEC_STRING_MAP.hevc) {
							this.currentTrack.info.codec = 'hevc';
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.vp8) {
							this.currentTrack.info.codec = 'vp8';
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.vp9) {
							this.currentTrack.info.codec = 'vp9';
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.av1) {
							this.currentTrack.info.codec = 'av1';
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.prores) {
							const format = this.currentTrack.codecPrivate
								? textDecoder.decode(this.currentTrack.codecPrivate)
								: '';

							if ((PRORES_FOURCCS as readonly string[]).includes(format)) {
								this.currentTrack.info.codec = 'prores';
								this.currentTrack.info.proresFormat = format as ProresFourCc;
							} else {
								// Either an invalid string or ProRes RAW, which we don't support yet (it's a
								// different codec).
							}
						}

						const videoTrack = this.currentTrack as InternalVideoTrack;
						this.currentTrack.trackBacking = new MatroskaVideoTrackBacking(videoTrack);
						this.currentSegment.tracks.push(this.currentTrack);
						this.currentSegment.idToTrack.set(this.currentTrack.id, this.currentTrack);
					} else if (this.currentTrack.info.type === 'audio') {
						if (codecIdWithoutSuffix === CODEC_STRING_MAP.aac) {
							this.currentTrack.info.codec = 'aac';
							this.currentTrack.info.aacCodecInfo = {
								isMpeg2: this.currentTrack.codecId.includes('MPEG2'),
								objectType: null,
							};
							if (this.currentTrack.codecPrivate?.byteLength) {
								this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
							} else {
								const outputSampleRate = this.currentTrack.info.outputSampleRate
									?? this.currentTrack.info.sampleRate;
								const description = buildLegacyAacAudioSpecificConfig(
									this.currentTrack.codecId,
									this.currentTrack.info.sampleRate,
									outputSampleRate,
									this.currentTrack.info.numberOfChannels,
								);

								this.currentTrack.info.codecDescription = description;
								if (description && this.currentTrack.codecId.includes('SBR')) {
									// What the decoder outputs
									this.currentTrack.info.sampleRate = outputSampleRate;
								}
							}
						} else if (
							this.currentTrack.codecId === CODEC_STRING_MAP.mp3
							// MPEG-1/2 Layer I and II (e.g. DVB broadcast audio) also go by 'mp3', like in the MP4 and
							// MPEG-TS readers
							|| this.currentTrack.codecId === 'A_MPEG/L2'
							|| this.currentTrack.codecId === 'A_MPEG/L1'
						) {
							this.currentTrack.info.codec = 'mp3';
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.opus) {
							this.currentTrack.info.codec = 'opus';
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
							this.currentTrack.info.sampleRate = OPUS_SAMPLE_RATE; // Always the same
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.vorbis) {
							this.currentTrack.info.codec = 'vorbis';
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.flac) {
							this.currentTrack.info.codec = 'flac';
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.ac3) {
							this.currentTrack.info.codec = 'ac3';
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.eac3) {
							this.currentTrack.info.codec = 'eac3';
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.dts) {
							this.currentTrack.info.codec = 'dts';

							if (this.currentTrack.codecId === 'A_DTS/EXPRESS') {
								this.currentTrack.info.dtsFormat = 'dtse';
							} else if (this.currentTrack.codecId === 'A_DTS/LOSSLESS') {
								this.currentTrack.info.dtsFormat = 'dtsl';
							}
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.truehd) {
							this.currentTrack.info.codec = 'truehd';
						} else if (this.currentTrack.codecId === 'A_PCM/INT/LIT') {
							if (this.currentTrack.info.bitDepth === 8) {
								this.currentTrack.info.codec = 'pcm-u8';
							} else if (this.currentTrack.info.bitDepth === 16) {
								this.currentTrack.info.codec = 'pcm-s16';
							} else if (this.currentTrack.info.bitDepth === 24) {
								this.currentTrack.info.codec = 'pcm-s24';
							} else if (this.currentTrack.info.bitDepth === 32) {
								this.currentTrack.info.codec = 'pcm-s32';
							}
						} else if (this.currentTrack.codecId === 'A_PCM/INT/BIG') {
							if (this.currentTrack.info.bitDepth === 8) {
								this.currentTrack.info.codec = 'pcm-u8';
							} else if (this.currentTrack.info.bitDepth === 16) {
								this.currentTrack.info.codec = 'pcm-s16be';
							} else if (this.currentTrack.info.bitDepth === 24) {
								this.currentTrack.info.codec = 'pcm-s24be';
							} else if (this.currentTrack.info.bitDepth === 32) {
								this.currentTrack.info.codec = 'pcm-s32be';
							}
						} else if (this.currentTrack.codecId === 'A_PCM/FLOAT/IEEE') {
							if (this.currentTrack.info.bitDepth === 32) {
								this.currentTrack.info.codec = 'pcm-f32';
							} else if (this.currentTrack.info.bitDepth === 64) {
								this.currentTrack.info.codec = 'pcm-f64';
							}
						}

						const audioTrack = this.currentTrack as InternalAudioTrack;
						this.currentTrack.trackBacking = new MatroskaAudioTrackBacking(audioTrack);
						this.currentSegment.tracks.push(this.currentTrack);
						this.currentSegment.idToTrack.set(this.currentTrack.id, this.currentTrack);
					}
				}

				this.currentTrack = null;
			}; break;

			case EBMLId.TrackNumber: {
				if (!this.currentTrack) break;

				this.currentTrack.id = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.TrackType: {
				if (!this.currentTrack) break;

				const type = readUnsignedInt(slice, size);
				if (type === 1 && this.currentTrack.info?.type !== 'video') {
					this.currentTrack.info = {
						type: 'video',
						width: -1,
						height: -1,
						pixelCrop: [0, 0, 0, 0],
						displayWidth: null,
						displayHeight: null,
						displayUnit: 0, // Pixels
						squarePixelWidth: -1,
						squarePixelHeight: -1,
						pixelAspectRatio: { num: 1, den: 1 },
						horizontalScale: 1,
						verticalScale: 1,
						rotation: 0,
						codec: null,
						codecDescription: null,
						colorSpace: { ...EMPTY_COLOR_SPACE },
						alphaMode: false,
						proresFormat: null,
					};
				} else if (type === 2 && this.currentTrack.info?.type !== 'audio') {
					this.currentTrack.info = {
						type: 'audio',
						numberOfChannels: 1, // Default value
						sampleRate: 8000, // Default value
						outputSampleRate: null, // Defaults to sampleRate
						bitDepth: -1,
						codec: null,
						codecDescription: null,
						aacCodecInfo: null,
						dtsFormat: null,
					};
				}
			}; break;

			case EBMLId.FlagEnabled: {
				if (!this.currentTrack) break;

				const enabled = readUnsignedInt(slice, size);
				if (!enabled) {
					this.currentTrack = null;
				}
			}; break;

			case EBMLId.FlagDefault: {
				if (!this.currentTrack) break;

				this.currentTrack.disposition.default = !!readUnsignedInt(slice, size);
			}; break;

			case EBMLId.FlagForced: {
				if (!this.currentTrack) break;

				this.currentTrack.disposition.forced = !!readUnsignedInt(slice, size);
			}; break;

			case EBMLId.FlagOriginal: {
				if (!this.currentTrack) break;

				this.currentTrack.disposition.original = !!readUnsignedInt(slice, size);
			}; break;

			case EBMLId.FlagHearingImpaired: {
				if (!this.currentTrack) break;

				this.currentTrack.disposition.hearingImpaired = !!readUnsignedInt(slice, size);
			}; break;

			case EBMLId.FlagVisualImpaired: {
				if (!this.currentTrack) break;

				this.currentTrack.disposition.visuallyImpaired = !!readUnsignedInt(slice, size);
			}; break;

			case EBMLId.FlagCommentary: {
				if (!this.currentTrack) break;

				this.currentTrack.disposition.commentary = !!readUnsignedInt(slice, size);
			}; break;

			case EBMLId.CodecID: {
				if (!this.currentTrack) break;

				this.currentTrack.codecId = readAsciiString(slice, size);
			}; break;

			case EBMLId.CodecPrivate: {
				if (!this.currentTrack) break;

				this.currentTrack.codecPrivate = readBytes(slice, size);
			}; break;

			case EBMLId.DefaultDuration: {
				if (!this.currentTrack) break;
				this.currentTrack.defaultDurationNs = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.CodecDelay: {
				if (!this.currentTrack) break;
				this.currentTrack.codecDelayNs = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.TrackTimestampScale: {
				if (!this.currentTrack) {
					break;
				}

				const value = readFloat(slice, size);
				if (Number.isFinite(value) && value > 0) {
					this.currentTrack.trackTimestampScale = value;
				}
			}; break;

			case EBMLId.SeekPreRoll: {
				if (!this.currentTrack) {
					break;
				}

				this.currentTrack.seekPreRollNs = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.Name: {
				if (!this.currentTrack) break;

				this.currentTrack.name = readUnicodeString(slice, size);
			}; break;

			case EBMLId.Language: {
				if (!this.currentTrack) break;
				if (this.currentTrack.hasLanguageBcp47) {
					// LanguageBCP47 was present, which takes precedence
					break;
				}

				// Matroska v1 to v3 allow a country code after the ISO 639-2 code, like "fre-ca" (RFC 9559, section 12)
				this.currentTrack.languageCode = readAsciiString(slice, size).split('-')[0]!;

				if (!isIso639Dash2LanguageCode(this.currentTrack.languageCode)) {
					this.currentTrack.languageCode = UNDETERMINED_LANGUAGE;
				}

				// For languages with two ISO 639-2 codes, the element holds the bibliographic one, like "ger" for "deu"
				this.currentTrack.languageCode = fromMatroskaLanguageCode(this.currentTrack.languageCode);
			}; break;

			case EBMLId.LanguageBCP47: {
				if (!this.currentTrack) break;

				// `languageCode` is documented as ISO 639-2, while BCP 47 uses the two-letter ISO 639-1 codes where
				// they exist: mkvmerge writes LanguageBCP47 "en" next to Language "eng", for example. (This will get
				// cleaned up in the future by defining languageCode to be BCP 47 instead.)
				this.currentTrack.languageCode = bcp47ToIso639Dash2LanguageCode(readAsciiString(slice, size));
				this.currentTrack.hasLanguageBcp47 = true;
			}; break;

			case EBMLId.Video: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.PixelWidth: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.currentTrack.info.width = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.PixelHeight: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.currentTrack.info.height = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.PixelCropTop:
			case EBMLId.PixelCropBottom:
			case EBMLId.PixelCropLeft:
			case EBMLId.PixelCropRight: {
				if (this.currentTrack?.info?.type !== 'video') {
					break;
				}

				const edges = [
					EBMLId.PixelCropTop,
					EBMLId.PixelCropBottom,
					EBMLId.PixelCropLeft,
					EBMLId.PixelCropRight,
				];
				this.currentTrack.info.pixelCrop[edges.indexOf(id)] = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.DisplayWidth: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.currentTrack.info.displayWidth = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.DisplayHeight: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.currentTrack.info.displayHeight = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.DisplayUnit: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.currentTrack.info.displayUnit = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.AlphaMode: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.currentTrack.info.alphaMode = readUnsignedInt(slice, size) === 1;
			}; break;

			case EBMLId.Colour: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.MatrixCoefficients: {
				if (this.currentTrack?.info?.type !== 'video') break;

				const matrixCoefficients = readUnsignedInt(slice, size);
				const mapped = MATRIX_COEFFICIENTS_MAP_INVERSE[matrixCoefficients];
				this.currentTrack.info.colorSpace.matrix = mapped as VideoColorSpaceInit['matrix'];
			}; break;

			case EBMLId.Range: {
				if (this.currentTrack?.info?.type !== 'video') break;

				const range = readUnsignedInt(slice, size);
				this.currentTrack.info.colorSpace.fullRange = range === 1 || range === 2
					? range === 2
					: undefined;
			}; break;

			case EBMLId.TransferCharacteristics: {
				if (this.currentTrack?.info?.type !== 'video') break;

				const transferCharacteristics = readUnsignedInt(slice, size);
				const mapped = TRANSFER_CHARACTERISTICS_MAP_INVERSE[transferCharacteristics];
				this.currentTrack.info.colorSpace.transfer = mapped as VideoColorSpaceInit['transfer'];
			}; break;

			case EBMLId.Primaries: {
				if (this.currentTrack?.info?.type !== 'video') break;

				const primaries = readUnsignedInt(slice, size);
				const mapped = COLOR_PRIMARIES_MAP_INVERSE[primaries];
				this.currentTrack.info.colorSpace.primaries = mapped as VideoColorSpaceInit['primaries'];
			}; break;

			case EBMLId.Projection: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			// Yaw and pitch rotate the frame in 3D space about the vertical and horizontal axis respectively. When
			// snapped to multiples of 90 degrees, that amounts to scaling each axis by the cosine, which models flips.
			case EBMLId.ProjectionPoseYaw: {
				if (this.currentTrack?.info?.type !== 'video') break;

				const yaw = readFloat(slice, size);

				try {
					const normalized = normalizeRotation(yaw);
					this.currentTrack.info.horizontalScale = Math.round(Math.cos(normalized * DEG_TO_RAD));
				} catch {
					// It wasn't a valid rotation
				}
			}; break;

			case EBMLId.ProjectionPosePitch: {
				if (this.currentTrack?.info?.type !== 'video') break;

				const pitch = readFloat(slice, size);

				try {
					const normalized = normalizeRotation(pitch);
					this.currentTrack.info.verticalScale = Math.round(Math.cos(normalized * DEG_TO_RAD));
				} catch {
					// It wasn't a valid rotation
				}
			}; break;

			case EBMLId.ProjectionPoseRoll: {
				if (this.currentTrack?.info?.type !== 'video') break;

				const rotation = readFloat(slice, size);
				const flippedRotation = -rotation; // Convert counter-clockwise to clockwise

				try {
					this.currentTrack.info.rotation = normalizeRotation(flippedRotation);
				} catch {
					// It wasn't a valid rotation
				}
			}; break;

			case EBMLId.Audio: {
				if (this.currentTrack?.info?.type !== 'audio') break;

				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.SamplingFrequency: {
				if (this.currentTrack?.info?.type !== 'audio') break;

				const sampleRate = readFloat(slice, size);
				if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) {
					// Only this track is affected, so don't fail the whole file: treat it like a missing element
					Logging._warn(`Track #${this.currentTrack.id} has an invalid SamplingFrequency; ignoring it.`);
					break;
				}

				this.currentTrack.info.sampleRate = sampleRate;
			}; break;

			case EBMLId.OutputSamplingFrequency: {
				if (this.currentTrack?.info?.type !== 'audio') {
					break;
				}

				const outputSampleRate = readFloat(slice, size);
				if (outputSampleRate > 0 && Number.isFinite(outputSampleRate)) {
					this.currentTrack.info.outputSampleRate = outputSampleRate;
				}
			}; break;

			case EBMLId.Channels: {
				if (this.currentTrack?.info?.type !== 'audio') break;

				const numberOfChannels = readUnsignedInt(slice, size);
				if (numberOfChannels === 0) {
					Logging._warn(`Track #${this.currentTrack.id} has an invalid Channels value of 0; ignoring it.`);
					break;
				}

				this.currentTrack.info.numberOfChannels = numberOfChannels;
			}; break;

			case EBMLId.BitDepth: {
				if (this.currentTrack?.info?.type !== 'audio') break;

				this.currentTrack.info.bitDepth = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.CuePoint: {
				if (!this.currentSegment) break;

				this.readContiguousElements(slice.slice(dataStartPos, size));
				this.currentCueTime = null;
			}; break;

			case EBMLId.CueTime: {
				this.currentCueTime = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.CueTrackPositions: {
				if (this.currentCueTime === null || !this.currentSegment) break;

				const cuePoint: CuePoint = { time: this.currentCueTime, trackId: -1, clusterPosition: -1 };
				this.currentSegment.cuePoints.push(cuePoint);
				this.readContiguousElements(slice.slice(dataStartPos, size));

				if (cuePoint.trackId === -1 || cuePoint.clusterPosition === -1) {
					this.currentSegment.cuePoints.pop();
				}
			}; break;

			case EBMLId.CueTrack: {
				const lastCuePoint = this.currentSegment?.cuePoints[this.currentSegment.cuePoints.length - 1];
				if (!lastCuePoint) break;

				lastCuePoint.trackId = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.CueClusterPosition: {
				const lastCuePoint = this.currentSegment?.cuePoints[this.currentSegment.cuePoints.length - 1];
				if (!lastCuePoint) break;

				assert(this.currentSegment);
				lastCuePoint.clusterPosition = this.currentSegment.dataStartPos + readUnsignedInt(slice, size);
			}; break;

			case EBMLId.Timestamp: {
				if (!this.currentCluster) break;

				this.currentCluster.timestamp = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.SimpleBlock: {
				if (!this.currentCluster) break;

				const blockSlice = slice.slice(dataStartPos, size);

				const trackNumber = readVarInt(blockSlice);
				if (trackNumber === null || blockSlice.remainingLength < 3) break;

				const trackData = this.getTrackDataInCluster(this.currentCluster, trackNumber);
				if (!trackData) break; // Not a track we care about

				const relativeTimestamp = readI16Be(blockSlice);

				const flags = readU8(blockSlice);
				const lacing = (flags >> 1) & 0x3 as BlockLacing; // If the block is laced, we'll expand it later

				let isKeyFrame = !!(flags & 0x80);
				if (
					trackData.track.info?.type === 'audio'
					&& trackData.track.info.codec
					&& !AUDIO_CODECS_WITH_DELTA_PACKETS.includes(trackData.track.info.codec)
				) {
					// Some files don't mark their audio packets as key packets (I'm looking at you, Firefox). But, we
					// can fix this in most cases: if we recognize the codec of the track and it has no delta packets,
					// then we know every packet is necessarily a key packet, no matter what the container says.
					// https://github.com/Vanilagy/mediabunny/issues/192
					isKeyFrame = true;
				}

				const blockData = readBytes(blockSlice, blockSlice.remainingLength);
				const hasDecodingInstructions = trackData.track.decodingInstructions.length > 0;

				trackData.blocks.push({
					timestamp: relativeTimestamp, // We'll add the cluster's timestamp to this later
					duration: 0, // Will set later
					isKeyFrame,
					data: blockData,
					lacing,
					decoded: !hasDecodingInstructions,
					postProcessed: false,
					mainAdditional: null,
				});
			}; break;

			case EBMLId.BlockGroup: {
				if (!this.currentCluster) break;

				// The other children (BlockDuration, ReferenceBlock, BlockAdditions) apply to the Block, which may
				// come after them, so let's read it first
				this.currentBlock = null;
				const children = slice.slice(dataStartPos, size);
				while (children.remainingLength >= MIN_HEADER_SIZE) {
					const childStartPos = children.filePos;
					const childHeader = readElementHeader(children);
					if (!childHeader || childHeader.size === undefined) {
						break;
					}

					if (childHeader.id === EBMLId.Block) {
						children.filePos = childStartPos;
						this.traverseElement(children);
						break;
					}

					children.skip(childHeader.size);
				}

				this.readContiguousElements(slice.slice(dataStartPos, size));

				this.currentBlock = null;
			}; break;

			case EBMLId.Block: {
				if (!this.currentCluster) break;
				if (this.currentBlock) {
					break; // Already read ahead of its siblings
				}

				const blockSlice = slice.slice(dataStartPos, size);

				const trackNumber = readVarInt(blockSlice);
				if (trackNumber === null || blockSlice.remainingLength < 3) break;

				const trackData = this.getTrackDataInCluster(this.currentCluster, trackNumber);
				if (!trackData) break;

				const relativeTimestamp = readI16Be(blockSlice);

				const flags = readU8(blockSlice);
				const lacing = (flags >> 1) & 0x3 as BlockLacing; // If the block is laced, we'll expand it later

				const blockData = readBytes(blockSlice, blockSlice.remainingLength);
				const hasDecodingInstructions = trackData.track.decodingInstructions.length > 0;

				this.currentBlock = {
					timestamp: relativeTimestamp, // We'll add the cluster's timestamp to this later
					duration: 0, // Will set later
					isKeyFrame: true,
					data: blockData,
					lacing,
					decoded: !hasDecodingInstructions,
					postProcessed: false,
					mainAdditional: null,
				};
				trackData.blocks.push(this.currentBlock);
			}; break;

			case EBMLId.BlockAdditions: {
				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.BlockMore: {
				// Nested elements may modify the current block, so hold onto it
				const block = this.currentBlock;
				if (!block) break;

				const blockAdditional = {
					addId: 1,
					data: null as Uint8Array | null,
				};
				this.currentBlockAdditional = blockAdditional;

				this.readContiguousElements(slice.slice(dataStartPos, size));

				if (blockAdditional.data && blockAdditional.addId === 1) {
					block.mainAdditional = blockAdditional.data;
				}
				this.currentBlockAdditional = null;
			}; break;

			case EBMLId.BlockAdditional: {
				if (!this.currentBlockAdditional) break;

				this.currentBlockAdditional.data = readBytes(slice, size);
			}; break;

			case EBMLId.BlockAddID: {
				if (!this.currentBlockAdditional) break;

				this.currentBlockAdditional.addId = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.BlockDuration: {
				if (!this.currentBlock) break;

				this.currentBlock.duration = readUnsignedInt(slice, size);
				this.currentBlock.hasBlockDuration = true;
			}; break;

			case EBMLId.ReferenceBlock: {
				if (!this.currentBlock) break;

				this.currentBlock.isKeyFrame = false;
				// We ignore the actual value here, we just use the reference as an indicator for "not a key frame".
				// This is in line with FFmpeg's behavior.
			}; break;

			case EBMLId.Tag: {
				this.currentTagTargetIsMovie = true;

				// Targets decides whether the SimpleTags apply to the movie, but it may come after them, so let's read
				// it first
				const children = slice.slice(dataStartPos, size);
				while (children.remainingLength >= MIN_HEADER_SIZE) {
					const childStartPos = children.filePos;
					const childHeader = readElementHeader(children);
					if (!childHeader || childHeader.size === undefined) {
						break;
					}

					if (childHeader.id === EBMLId.Targets) {
						children.filePos = childStartPos;
						this.traverseElement(children);
						break;
					}

					children.skip(childHeader.size);
				}

				this.pendingTagValues = [];
				this.readContiguousElements(slice.slice(dataStartPos, size));

				// Of several values with the same name, the first default one in the undetermined language wins,
				// then the first default one in another language, then the first non-default one (TagDefault 0)
				const values = this.pendingTagValues.sort((a, b) => b.rank - a.rank); // Stable
				this.pendingTagValues = [];
				for (const { name, value } of values) {
					this.processTagValue(name, value);
				}
			}; break;

			case EBMLId.Targets: {
				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.TargetTypeValue: {
				const targetTypeValue = readUnsignedInt(slice, size);
				if (targetTypeValue !== 50) {
					this.currentTagTargetIsMovie = false;
				}
			}; break;

			case EBMLId.TagTrackUID:
			case EBMLId.TagEditionUID:
			case EBMLId.TagChapterUID:
			case EBMLId.TagAttachmentUID: {
				// A UID of 0 (the default, for an empty element) stands for all tracks (or editions, chapters,
				// attachments) of the segment
				if (readBytes(slice, size).some(x => x !== 0)) {
					this.currentTagTargetIsMovie = false;
				}
			}; break;

			case EBMLId.SimpleTag: {
				if (!this.currentTagTargetIsMovie) break;

				const parent = this.currentSimpleTag;
				this.currentSimpleTag = { name: null, language: null, isDefault: true, parent };

				try {
					// The tag's value and the tags nested in it need its name, but TagName may come after them, so
					// let's read it first
					const children = slice.slice(dataStartPos, size);
					let hasBcp47Language = false;
					while (children.remainingLength >= MIN_HEADER_SIZE) {
						const childStartPos = children.filePos;
						const childHeader = readElementHeader(children);
						if (!childHeader || childHeader.size === undefined) {
							break;
						}

						if (childHeader.id === EBMLId.TagName) {
							children.filePos = childStartPos;
							this.traverseElement(children);
							continue;
						} else if (
							childHeader.id === EBMLId.TagLanguage || childHeader.id === EBMLId.TagLanguageBCP47
						) {
							const language = readUnicodeString(children, childHeader.size);
							if (childHeader.id === EBMLId.TagLanguageBCP47 || !hasBcp47Language) {
								this.currentSimpleTag.language = language && language !== 'und' ? language : null;
							}
							hasBcp47Language ||= childHeader.id === EBMLId.TagLanguageBCP47;
							continue;
						} else if (childHeader.id === EBMLId.TagDefault) {
							this.currentSimpleTag.isDefault = childHeader.size === 0
								|| readBytes(children, childHeader.size).some(x => x !== 0);
							continue;
						}

						children.skip(childHeader.size);
					}

					this.readContiguousElements(slice.slice(dataStartPos, size));
				} finally {
					this.currentSimpleTag = parent;
				}
			}; break;

			case EBMLId.TagName: {
				if (!this.currentSimpleTag) {
					break;
				}

				this.currentSimpleTag.name = readUnicodeString(slice, size);
			}; break;

			case EBMLId.TagString:
			case EBMLId.TagBinary: {
				// Like FFmpeg, nested tags are named after their parents, e.g. ARTIST/SORT_WITH
				let name: string | null = null;
				for (let tag = this.currentSimpleTag; tag; tag = tag.parent) {
					if (tag.name === null) {
						name = null;
						break;
					}

					name = name === null ? tag.name : `${tag.name}/${name}`;
				}
				if (name === null) {
					break;
				}

				const value = id === EBMLId.TagString ? readUnicodeString(slice, size) : readBytes(slice, size);
				this.addTagValue(name, value);
			}; break;

			case EBMLId.AttachedFile: {
				if (!this.currentSegment || this.currentAttachedFile) break; // Nested attached files make no sense

				this.currentAttachedFile = {
					fileUid: null,
					fileName: null,
					fileMediaType: null,
					fileData: null,
					fileDescription: null,
				};

				this.readContiguousElements(slice.slice(dataStartPos, size));

				const tags = this.currentSegment.metadataTags;
				watchMetadataTagFields(tags, this.currentAttachedFile.fileUid?.toString() ?? null);

				if (this.currentAttachedFile.fileUid && this.currentAttachedFile.fileData) {
					// All attached files get surfaced in the `raw` metadata tags
					tags.raw ??= {};
					tags.raw[this.currentAttachedFile.fileUid.toString()] = new AttachedFile(
						this.currentAttachedFile.fileData,
						this.currentAttachedFile.fileMediaType ?? undefined,
						this.currentAttachedFile.fileName ?? undefined,
						this.currentAttachedFile.fileDescription ?? undefined,
					);
				}

				// Only process image attachments
				if (this.currentAttachedFile.fileMediaType?.startsWith('image/') && this.currentAttachedFile.fileData) {
					const fileName = this.currentAttachedFile.fileName;
					let kind: 'coverFront' | 'coverBack' | 'unknown' = 'unknown';

					// The Matroska spec names cover art cover.(jpg|png), with versions of the same cover prefixed with
					// small_ (smaller) or suffixed with _land (landscape); getMetadataTags() picks the front cover
					if (getCoverArtRank(fileName) !== null) {
						kind = 'coverFront';
					} else if (fileName?.toLowerCase().startsWith('back.')) {
						kind = 'coverBack';
					}

					tags.images ??= [];
					tags.images.push({
						data: this.currentAttachedFile.fileData,
						mimeType: this.currentAttachedFile.fileMediaType,
						kind,
						name: this.currentAttachedFile.fileName ?? undefined,
						description: this.currentAttachedFile.fileDescription ?? undefined,
					});
				}

				unwatchMetadataTagFields(tags);

				this.currentAttachedFile = null;
			}; break;

			case EBMLId.FileUID: {
				if (!this.currentAttachedFile) break;

				this.currentAttachedFile.fileUid = readUnsignedBigInt(slice, size);
			}; break;

			case EBMLId.FileName: {
				if (!this.currentAttachedFile) break;

				this.currentAttachedFile.fileName = readUnicodeString(slice, size);
			}; break;

			case EBMLId.FileMediaType: {
				if (!this.currentAttachedFile) break;

				this.currentAttachedFile.fileMediaType = readAsciiString(slice, size);
			}; break;

			case EBMLId.FileData: {
				if (!this.currentAttachedFile) break;

				this.currentAttachedFile.fileData = readBytes(slice, size);
			}; break;

			case EBMLId.FileDescription: {
				if (!this.currentAttachedFile) break;

				this.currentAttachedFile.fileDescription = readUnicodeString(slice, size);
			}; break;

			case EBMLId.ContentEncodings: {
				// Nested elements may modify the current track, so hold onto it
				const track = this.currentTrack;
				if (!track) break;

				this.readContiguousElements(slice.slice(dataStartPos, size));

				// "**MUST** start with the `ContentEncoding` with the highest `ContentEncodingOrder`"
				track.decodingInstructions.sort((a, b) => b.order - a.order);
			}; break;

			case EBMLId.ContentEncoding: {
				const track = this.currentTrack;
				if (!track) break;

				const instruction: DecodingInstruction = {
					order: 0,
					scope: ContentEncodingScope.Block,
					data: null,
				};
				this.currentDecodingInstruction = instruction;

				this.readContiguousElements(slice.slice(dataStartPos, size));

				if (instruction.data) {
					track.decodingInstructions.push(instruction);
				}

				this.currentDecodingInstruction = null;
			}; break;

			case EBMLId.ContentEncodingOrder: {
				if (!this.currentDecodingInstruction) break;

				this.currentDecodingInstruction.order = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.ContentEncodingScope: {
				if (!this.currentDecodingInstruction) break;

				this.currentDecodingInstruction.scope = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.ContentCompression: {
				if (!this.currentDecodingInstruction) break;

				this.currentDecodingInstruction.data = {
					type: 'decompress',
					algorithm: ContentCompAlgo.Zlib,
					settings: null,
				};

				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.ContentCompAlgo: {
				if (this.currentDecodingInstruction?.data?.type !== 'decompress') break;

				this.currentDecodingInstruction.data.algorithm = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.ContentCompSettings: {
				if (this.currentDecodingInstruction?.data?.type !== 'decompress') break;

				this.currentDecodingInstruction.data.settings = readBytes(slice, size);
			}; break;

			case EBMLId.ContentEncryption: {
				if (!this.currentDecodingInstruction) break;

				this.currentDecodingInstruction.data = {
					type: 'decrypt',
				};
			}; break;
		}

		slice.filePos = dataStartPos + size;
		return true;
	}

	decodeBlockData(track: InternalTrack, rawData: Uint8Array) {
		assert(track.decodingInstructions.length > 0); // This method shouldn't be called otherwise

		let currentData = rawData;

		for (const instruction of track.decodingInstructions) {
			assert(instruction.data);

			switch (instruction.data.type) {
				case 'decompress': {
					switch (instruction.data.algorithm) {
						case ContentCompAlgo.HeaderStripping: {
							if (instruction.data.settings && instruction.data.settings.length > 0) {
								const prefix = instruction.data.settings;
								const newData = new Uint8Array(prefix.length + currentData.length);

								newData.set(prefix, 0);
								newData.set(currentData, prefix.length);

								currentData = newData;
							}
						}; break;

						default: {
							// Unhandled
						};
					}
				}; break;

				default: {
					// Unhandled
				};
			}
		}

		return currentData;
	}

	addTagValue(name: string, value: string | Uint8Array) {
		const language = this.currentSimpleTag?.language ?? null;
		const isDefault = this.currentSimpleTag?.isDefault ?? true;
		const rank = !isDefault ? 0 : language ? 1 : 2;
		this.pendingTagValues.push({ name, value, rank });

		if (language) {
			// Also under its own name for the language, like FFmpeg does (e.g. ARTIST-ger)
			this.pendingTagValues.push({ name: `${name}-${language}`, value, rank: 2 });
		}
	}

	processTagValue(name: string, value: string | Uint8Array) {
		if (!this.currentSegment?.metadataTags) return;

		const metadataTags = this.currentSegment.metadataTags;
		watchMetadataTagFields(metadataTags, name);
		metadataTags.raw ??= {};
		metadataTags.raw[name] ??= value;

		if (typeof value === 'string') {
			switch (name.toLowerCase()) {
				case 'title': {
					metadataTags.title ??= value;
				}; break;

				case 'description': {
					metadataTags.description ??= value;
				}; break;

				case 'artist': {
					metadataTags.artist ??= value;
				}; break;

				case 'album': {
					metadataTags.album ??= value;
				}; break;

				case 'album_artist': {
					metadataTags.albumArtist ??= value;
				}; break;

				case 'genre': {
					metadataTags.genre ??= value;
				}; break;

				case 'bpm': {
					const bpm = Number.parseInt(value, 10);
					if (Number.isInteger(bpm) && bpm > 0) {
						metadataTags.beatsPerMinute ??= bpm;
					}
				}; break;

				case 'comment': {
					metadataTags.comment ??= value;
				}; break;

				case 'lyrics': {
					metadataTags.lyrics ??= value;
				}; break;

				case 'date':
				case 'date_released': // The official Matroska names
				case 'date_recorded': {
					const date = new Date(value);
					if (!Number.isNaN(date.getTime())) {
						metadataTags.date ??= date;
					}
				}; break;

				case 'track_number':
				case 'part_number': {
					const parts = value.split('/');
					const trackNum = Number.parseInt(parts[0]!, 10);
					const tracksTotal = parts[1] && Number.parseInt(parts[1], 10);

					if (Number.isInteger(trackNum) && trackNum > 0) {
						metadataTags.trackNumber ??= trackNum;
					}
					if (tracksTotal && Number.isInteger(tracksTotal) && tracksTotal > 0) {
						metadataTags.tracksTotal ??= tracksTotal;
					}
				}; break;

				case 'total_parts': {
					// The official Matroska name; in the "3/12" form, PART_NUMBER carries the total too
					const tracksTotal = Number.parseInt(value, 10);
					if (Number.isInteger(tracksTotal) && tracksTotal > 0) {
						metadataTags.tracksTotal ??= tracksTotal;
					}
				}; break;

				case 'disc_number':
				case 'disc': {
					const discParts = value.split('/');
					const discNum = Number.parseInt(discParts[0]!, 10);
					const discsTotal = discParts[1] && Number.parseInt(discParts[1], 10);

					if (Number.isInteger(discNum) && discNum > 0) {
						metadataTags.discNumber ??= discNum;
					}
					if (discsTotal && Number.isInteger(discsTotal) && discsTotal > 0) {
						metadataTags.discsTotal ??= discsTotal;
					}
				}; break;
			}
		}

		unwatchMetadataTagFields(metadataTags);
	}

	getDurationFromMetadata(segment: Segment) {
		if (segment.duration <= 0) {
			return null;
		}

		const minCodecDelay = Math.min(...segment.tracks.map(x => x.codecDelay));

		// We treat the Duration field as the end timestamp of the segment, since this is what FFmpeg treats it as.
		// The spec unfortunately does not clarify what it means by duration here.
		return (segment.duration - minCodecDelay) / segment.timestampFactor;
	}
}

/**
 * Whether a timestamp lies before the end of a track's blocks in a cluster, so that no later cluster can hold a better
 * match for it. That end comes from the last block's duration, often a rounded or fractional DefaultDuration or
 * BlockDuration, so the next cluster may begin up to a tick before it.
 */
const isSafelyBeforeEnd = (trackData: ClusterTrackData, timestamp: number) => {
	return timestamp < trackData.endTimestamp - 1;
};

abstract class MatroskaTrackBacking implements InputTrackBacking {
	packetToClusterLocation = new WeakMap<EncodedPacket, {
		cluster: Cluster;
		blockIndex: number;
	}>();

	constructor(public internalTrack: InternalTrack) {}

	abstract getType(): TrackType;
	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;

	getId() {
		return this.internalTrack.id;
	}

	getNumber() {
		const demuxer = this.internalTrack.demuxer;
		const trackType = this.internalTrack.trackBacking!.getType();

		let number = 0;
		for (const segment of demuxer.segments) {
			for (const track of segment.tracks) {
				if (track.trackBacking!.getType() === trackType) {
					number++;
				}

				if (track === this.internalTrack) {
					break;
				}
			}
		}

		return number;
	}

	getCodec(): MediaCodec | null {
		throw new Error('Not implemented on base class.');
	}

	getInternalCodecId() {
		return this.internalTrack.codecId;
	}

	getName() {
		return this.internalTrack.name;
	}

	getLanguageCode() {
		return this.internalTrack.languageCode;
	}

	getTimeResolution() {
		return this.internalTrack.segment.timestampFactor;
	}

	isRelativeToUnixEpoch() {
		return false;
	}

	getUnixTimeForTimestamp() {
		return null;
	}

	getDisposition() {
		return this.internalTrack.disposition;
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
		return this.internalTrack.demuxer.getDurationFromMetadata(this.internalTrack.segment);
	}

	async getLiveRefreshInterval() {
		return null;
	}

	async getFirstPacket(options: PacketRetrievalOptions) {
		return this.performClusterLookup(
			null,
			(cluster) => {
				const trackData = cluster.trackData.get(this.internalTrack.id);
				if (trackData) {
					return {
						blockIndex: 0,
						correctBlockFound: true,
					};
				}

				return {
					blockIndex: -1,
					correctBlockFound: false,
				};
			},
			-Infinity, // Use -Infinity as a search timestamp to avoid using the cues
			Infinity,
			options,
		);
	}

	private intoTimescale(timestamp: number) {
		// Do a little rounding to catch cases where the result is very close to an integer. If it is, it's likely
		// that the number was originally an integer divided by the timescale. For stability, it's best
		// to return the integer in this case.
		return roundIfAlmostInteger(timestamp * this.internalTrack.segment.timestampFactor)
			+ this.internalTrack.codecDelay;
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		const timestampInTimescale = this.intoTimescale(timestamp);

		return this.performClusterLookup(
			null,
			(cluster) => {
				const trackData = cluster.trackData.get(this.internalTrack.id);
				if (!trackData) {
					return { blockIndex: -1, correctBlockFound: false };
				}

				const index = binarySearchLessOrEqual(
					trackData.presentationTimestamps,
					timestampInTimescale,
					x => x.timestamp,
				);

				if (index === -1) {
					return { blockIndex: -1, correctBlockFound: false };
				}

				const { timestamp: matchTimestamp, blockIndex } = trackData.presentationTimestamps[index]!;
				// With B-frames, a block presented between the match and the timestamp can still come in a later
				// cluster, so only an exact match settles the lookup; otherwise, the lookup scans on until no such
				// block can follow
				const correctBlockFound = trackMayReorder(this.internalTrack)
					? matchTimestamp === timestampInTimescale
					: isSafelyBeforeEnd(trackData, timestampInTimescale);

				return { blockIndex, correctBlockFound };
			},
			timestampInTimescale,
			timestampInTimescale,
			options,
			false,
			true,
		);
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const locationInCluster = this.packetToClusterLocation.get(packet);
		if (locationInCluster === undefined) {
			throw new Error('Packet was not created from this track.');
		}

		return this.performClusterLookup(
			locationInCluster.cluster,
			(cluster) => {
				if (cluster === locationInCluster.cluster) {
					const trackData = cluster.trackData.get(this.internalTrack.id)!;
					if (locationInCluster.blockIndex + 1 < trackData.blocks.length) {
						// We can simply take the next block in the cluster
						return {
							blockIndex: locationInCluster.blockIndex + 1,
							correctBlockFound: true,
						};
					}
				} else {
					const trackData = cluster.trackData.get(this.internalTrack.id);
					if (trackData) {
						return {
							blockIndex: 0,
							correctBlockFound: true,
						};
					}
				}

				return {
					blockIndex: -1,
					correctBlockFound: false,
				};
			},
			-Infinity, // Use -Infinity as a search timestamp to avoid using the cues
			Infinity,
			options,
		);
	}

	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		const timestampInTimescale = this.intoTimescale(timestamp);

		return this.performClusterLookup(
			null,
			(cluster) => {
				const trackData = cluster.trackData.get(this.internalTrack.id);
				if (!trackData) {
					return { blockIndex: -1, correctBlockFound: false };
				}

				// The timestamps are sorted, so find the last one at or before the timestamp and walk back to a key
				// frame from there, instead of scanning all of the cluster's blocks on every lookup
				let index = binarySearchLessOrEqual(
					trackData.presentationTimestamps,
					timestampInTimescale,
					x => x.timestamp,
				);
				while (index !== -1) {
					const block = trackData.blocks[trackData.presentationTimestamps[index]!.blockIndex]!;
					if (block.isKeyFrame) {
						break;
					}

					index--;
				}

				const blockIndex = index !== -1 ? trackData.presentationTimestamps[index]!.blockIndex : -1;
				const correctBlockFound = index !== -1 && isSafelyBeforeEnd(trackData, timestampInTimescale);

				return { blockIndex, correctBlockFound };
			},
			timestampInTimescale,
			timestampInTimescale,
			options,
			true,
		);
	}

	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const locationInCluster = this.packetToClusterLocation.get(packet);
		if (locationInCluster === undefined) {
			throw new Error('Packet was not created from this track.');
		}

		return this.performClusterLookup(
			locationInCluster.cluster,
			(cluster) => {
				if (cluster === locationInCluster.cluster) {
					const trackData = cluster.trackData.get(this.internalTrack.id)!;

					for (let i = locationInCluster.blockIndex + 1; i < trackData.blocks.length; i++) {
						if (trackData.blocks[i]!.isKeyFrame) {
							// We can simply take the next key frame in the cluster
							return {
								blockIndex: i,
								correctBlockFound: true,
							};
						}
					}
				} else {
					const trackData = cluster.trackData.get(this.internalTrack.id);
					if (trackData && trackData.firstKeyFrameTimestamp !== null) {
						const keyFrameIndex = trackData.blocks.findIndex(x => x.isKeyFrame);
						assert(keyFrameIndex !== -1); // There must be one

						return {
							blockIndex: keyFrameIndex,
							correctBlockFound: true,
						};
					}
				}

				return {
					blockIndex: -1,
					correctBlockFound: false,
				};
			},
			-Infinity, // Use -Infinity as a search timestamp to avoid using the cues
			Infinity,
			options,
		);
	}

	private async fetchPacketInCluster(cluster: Cluster, blockIndex: number, options: PacketRetrievalOptions) {
		if (blockIndex === -1) {
			return null;
		}

		const trackData = cluster.trackData.get(this.internalTrack.id)!;
		const block = trackData.blocks[blockIndex];
		assert(block);

		// Perform lazy decoding if needed
		if (!block.decoded) {
			block.data = this.internalTrack.demuxer.decodeBlockData(this.internalTrack, block.data);
			block.decoded = true;
		}

		if (!block.postProcessed) {
			if (this.internalTrack.info?.codec === 'prores') {
				// For some reason, ProRes packets are stored in Matroska without the frame container atom. FFmpeg cites
				// the "Matroska spec" but the actual spec says nothing about this.

				const hasFrameContainer = block.data.length >= 8
					&& block.data[4] === 105 // 'i'
					&& block.data[5] === 99 // 'c'
					&& block.data[6] === 112 // 'p'
					&& block.data[7] === 102; // 'f'

				if (!hasFrameContainer) {
					// Wrap the frame in a frame container
					const newData = new Uint8Array(block.data.length + 8);
					const newDataView = toDataView(newData);

					newDataView.setUint32(0, newData.length, false);
					newData[4] = 105; // 'i'
					newData[5] = 99; // 'c'
					newData[6] = 112; // 'p'
					newData[7] = 102; // 'f'
					newData.set(block.data, 8);
					block.data = newData;
				}
			}

			block.postProcessed = true;
		}

		const data = options.metadataOnly ? PLACEHOLDER_DATA : block.data;

		const { codecDelay, segment } = this.internalTrack;
		const timestamp = (block.timestamp - codecDelay) / segment.timestampFactor;
		const duration = block.duration / segment.timestampFactor;

		const sideData: EncodedPacketSideData = {};
		if (block.mainAdditional && this.internalTrack.info?.type === 'video' && this.internalTrack.info.alphaMode) {
			sideData.alpha = options.metadataOnly ? PLACEHOLDER_DATA : block.mainAdditional;
			sideData.alphaByteLength = block.mainAdditional.byteLength;
		}

		const packet = new EncodedPacket(
			data,
			block.isKeyFrame ? 'key' : 'delta',
			timestamp,
			duration,
			cluster.dataStartPos + blockIndex,
			block.data.byteLength,
			sideData,
		);

		this.packetToClusterLocation.set(packet, { cluster, blockIndex });

		return packet;
	}

	/** Looks for a packet in the clusters while trying to load as few clusters as possible to retrieve it. */
	private async performClusterLookup(
		// The cluster where we start looking
		startCluster: Cluster | null,
		// This function returns the best-matching block in a given cluster
		getMatchInCluster: (cluster: Cluster) => { blockIndex: number; correctBlockFound: boolean },
		// The timestamp with which we can search the lookup table
		searchTimestamp: number,
		// The timestamp for which we know the correct block will not come after it
		latestTimestamp: number,
		options: PacketRetrievalOptions,
		// Whether the match must be a key frame, so that position cache entries without one can be skipped
		requireKeyFrame = false,
		// Whether the match is the block presented last at or before latestTimestamp, so that clusters presented
		// entirely before a known candidate can be skipped
		matchIsLatestBlock = false,
	): Promise<EncodedPacket | null> {
		const { demuxer, segment, cuePoints, clusterPositionCache } = this.internalTrack;
		const mayReorder = trackMayReorder(this.internalTrack);

		let bestCluster: Cluster | null = null;
		let bestBlockIndex = -1;

		const getBlockTimestamp = (cluster: Cluster, blockIndex: number) => {
			return cluster.trackData.get(this.internalTrack.id)!.blocks[blockIndex]!.timestamp;
		};
		const considerMatch = (cluster: Cluster, blockIndex: number) => {
			// Keep the match presented last. Normally, that's simply the one from the latest cluster, but B-frames
			// can make clusters overlap in presentation time.
			if (
				bestCluster
				&& getBlockTimestamp(cluster, blockIndex) < getBlockTimestamp(bestCluster, bestBlockIndex)
			) {
				return;
			}

			bestCluster = cluster;
			bestBlockIndex = blockIndex;
		};
		const getBestTimestamp = () => bestCluster ? getBlockTimestamp(bestCluster, bestBlockIndex) : -Infinity;

		if (startCluster) {
			const { blockIndex, correctBlockFound } = getMatchInCluster(startCluster);

			if (correctBlockFound) {
				return this.fetchPacketInCluster(startCluster, blockIndex, options);
			}

			if (blockIndex !== -1) {
				considerMatch(startCluster, blockIndex);
			}
		}

		// Search for a cue point; this way, we won't need to start searching from the start of the file
		// but can jump right into the correct cluster (or at least nearby).
		let cuePointIndex = binarySearchLessOrEqual(cuePoints, searchTimestamp, x => x.time);
		// Also check the position cache. Clusters read during the lookup land after this index, so it stays valid.
		let positionCacheIndex = binarySearchLessOrEqual(clusterPositionCache, searchTimestamp, x => x.startTimestamp);

		// A known cluster starting at or before the upper bound holds a candidate, so the match is presented no earlier
		// than it. Since a lookup with B-frames starts at a key frame, it can then hop over the known clusters in
		// between that are presented entirely before the candidate (or the best match so far).
		const candidateTimestamp = mayReorder && matchIsLatestBlock
			? clusterPositionCache[positionCacheIndex]?.startTimestamp ?? -Infinity
			: -Infinity;

		// The position for which we know the correct block will not come after it
		let stopPos = Infinity;

		while (true) {
			// Skip lookup entries pointing into clusters we've already scanned
			while (cuePointIndex !== -1 && cuePoints[cuePointIndex]!.clusterPosition >= stopPos) {
				cuePointIndex--;
			}
			const isUsableEntry = (entry: InternalTrack['clusterPositionCache'][number]) => {
				return entry.elementStartPos < stopPos && (!requireKeyFrame || entry.hasKeyFrame);
			};
			while (positionCacheIndex !== -1 && !isUsableEntry(clusterPositionCache[positionCacheIndex]!)) {
				positionCacheIndex--;
			}

			// Where the lookup would start if blocks were stored in presentation order
			const plainLookupEntryPosition = Math.max(
				cuePoints[cuePointIndex]?.clusterPosition ?? 0,
				clusterPositionCache[positionCacheIndex]?.elementStartPos ?? 0,
			) || null;

			// With B-frames, a block presented after a cluster's start can sit in a cluster before it, but not one
			// presented after a key frame (pictures can't be presented after a key frame and decoded before it), so the
			// scan has to start at such a key frame
			while (
				mayReorder
				&& positionCacheIndex !== -1
				&& (
					!isUsableEntry(clusterPositionCache[positionCacheIndex]!)
					|| !holdsKeyFrameAtOrBefore(clusterPositionCache[positionCacheIndex]!, searchTimestamp)
				)
			) {
				positionCacheIndex--;
			}

			const lookupEntryPosition = Math.max(
				cuePoints[cuePointIndex]?.clusterPosition ?? 0,
				clusterPositionCache[positionCacheIndex]?.elementStartPos ?? 0,
			) || null;

			// Clusters before the plain lookup entry are only read to find B-frames there. A source that can only be
			// streamed may not hold them anymore; then the lookup does without them and starts where it would without
			// B-frames.
			const fallBackToPlainEntry = (error: unknown) => {
				if (plainLookupEntryPosition === null || currentPos >= plainLookupEntryPosition) {
					throw error;
				}

				currentPos = plainLookupEntryPosition;
				blocksAfterLatest = 0;
			};

			let currentPos: number;
			let currentCluster: Cluster | null = null;

			if (!startCluster) {
				currentPos = lookupEntryPosition ?? segment.clusterSeekStartPos;
			} else {
				if (lookupEntryPosition === null || startCluster.elementStartPos >= lookupEntryPosition) {
					currentPos = startCluster.elementEndPos;
					currentCluster = startCluster;
				} else {
					// Use the lookup entry
					currentPos = lookupEntryPosition;
				}
			}

			const scanStartPos = currentCluster ? currentCluster.elementStartPos : currentPos;
			// With B-frames, a block presented before the upper bound can come after (in decode order) blocks presented
			// after it, even in a later cluster that starts after the upper bound. It can only trail them by so many
			// blocks, so count the blocks presented after the upper bound since the last one presented before it. (Not
			// so for key frames, which no block presented after them precedes.)
			let blocksAfterLatest = 0;

			while (
				(segment.elementEndPos === null || currentPos <= segment.elementEndPos - MIN_HEADER_SIZE)
				&& currentPos < stopPos
			) {
				if (currentCluster) {
					const trackData = currentCluster.trackData.get(this.internalTrack.id);
					for (const block of trackData?.blocks ?? []) {
						blocksAfterLatest = block.timestamp > latestTimestamp ? blocksAfterLatest + 1 : 0;
					}

					if (
						trackData
						&& trackData.startTimestamp > latestTimestamp
						&& (!mayReorder || requireKeyFrame || blocksAfterLatest > MAX_REORDER_BLOCKS)
					) {
						// We're already past the upper bound, no need to keep searching
						break;
					}

					currentCluster = null; // So we don't process it again next iteration
				}

				const summary = segment.clusterSummaries.get(currentPos);
				if (summary && !summary.trackIds.has(this.internalTrack.id)) {
					// We've read this cluster before and know it has nothing for this track, so let's not read it again
					currentPos = summary.elementEndPos;
					continue;
				}

				const latestInCluster = summary?.latestTimestamps.get(this.internalTrack.id);
				if (
					mayReorder
					&& matchIsLatestBlock
					&& latestInCluster !== undefined
					&& (latestInCluster < candidateTimestamp || latestInCluster <= getBestTimestamp())
				) {
					// We've read this cluster before and know it can't hold a better match. All of its blocks are
					// presented before the upper bound.
					blocksAfterLatest = 0;
					currentPos = summary!.elementEndPos;
					continue;
				}

				const elementStartPos = currentPos;
				let id: number;
				let size: number | undefined;
				let dataStartPos: number;

				// A cluster read just before doesn't need its header read again
				const recentCluster = demuxer.getRecentCluster(segment, currentPos);
				if (recentCluster) {
					id = EBMLId.Cluster;
					dataStartPos = recentCluster.dataStartPos;
					size = recentCluster.elementEndPos - dataStartPos;
				} else {
					// Load the header
					let slice: FileSlice | null;
					try {
						const result = demuxer.reader.requestSliceRange(currentPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
						slice = isThenable(result) ? await result : result;
					} catch (error) {
						fallBackToPlainEntry(error);
						continue;
					}
					if (!slice) {
						break;
					}

					const elementHeader = readElementHeader(slice);

					if (
						!elementHeader
						|| (!LEVEL_1_EBML_IDS.includes(elementHeader.id) && elementHeader.id !== EBMLId.Void)
					) {
						// There's an element here that shouldn't be here. Might be garbage. In this case, let's
						// try and resync to the next valid element.
						const nextPos = await resync(
							demuxer.reader,
							elementStartPos + 1,
							LEVEL_1_EBML_IDS,
							Math.min(segment.elementEndPos ?? Infinity, elementStartPos + MAX_RESYNC_LENGTH),
						);

						if (nextPos) {
							currentPos = nextPos;
							continue;
						} else {
							break; // Resync failed
						}
					}

					id = elementHeader.id;
					size = elementHeader.size;
					dataStartPos = slice.filePos;
				}

				if (id === EBMLId.Cluster) {
					try {
						currentCluster = await demuxer.readCluster(elementStartPos, segment);
					} catch (error) {
						fallBackToPlainEntry(error);
						continue;
					}

					// readCluster computes the proper size even if it's undefined in the header, so let's use that
					// instead
					size = currentCluster.elementEndPos - dataStartPos;

					const { blockIndex, correctBlockFound } = getMatchInCluster(currentCluster);
					if (correctBlockFound) {
						return this.fetchPacketInCluster(currentCluster, blockIndex, options);
					}

					if (blockIndex !== -1) {
						considerMatch(currentCluster, blockIndex);
					}
				}

				if (size === undefined) {
					// Undefined element size (can happen in livestreamed files). In this case, we need to do some
					// searching to determine the actual size of the element.

					assert(id !== EBMLId.Cluster); // Undefined cluster sizes are fixed further up

					// Search for the next element at level 0 or 1
					const nextElementPos = await searchForNextElementId(
						demuxer.reader,
						dataStartPos,
						LEVEL_0_AND_1_EBML_IDS,
						segment.elementEndPos,
					);

					size = nextElementPos.pos - dataStartPos;
				}

				const endPos = dataStartPos + size;
				if (segment.elementEndPos === null) {
					// Check the next element. If it's a new segment, we know this segment ends here. The new
					// segment is just ignored, since we're likely in a livestreamed file and thus only care about
					// the first segment.

					let slice = demuxer.reader.requestSliceRange(endPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
					if (isThenable(slice)) slice = await slice;
					if (!slice) break;

					const elementId = readElementId(slice);
					if (elementId === EBMLId.Segment) {
						segment.elementEndPos = endPos; // We now know the segment's size
						break;
					}
				}

				currentPos = endPos;
			}

			if (lookupEntryPosition === null || (bestCluster && bestCluster.elementStartPos >= lookupEntryPosition)) {
				break;
			}

			// We found a lookup entry but no cluster from there on that satisfied the match. In this case, let's search
			// again from the lookup entry preceding the clusters we just scanned.
			//
			// Note that this doesn't only kick for faulty cue points but also for multi-track files where only one
			// track has cue points. Since we distribute the cue points to the track with none, they might not
			// accurately reflect where media can be found.
			stopPos = scanStartPos; // So we don't read the same clusters again
			startCluster = null;
		}

		if (bestCluster) {
			// If we finished looping but didn't find a perfect match, still return the best match we found
			return this.fetchPacketInCluster(bestCluster, bestBlockIndex, options);
		}

		return null;
	}
}

class MatroskaVideoTrackBacking extends MatroskaTrackBacking implements InputVideoTrackBacking {
	declare internalTrack: InternalVideoTrack;
	decoderConfigPromise: Promise<VideoDecoderConfig> | null = null;

	constructor(internalTrack: InternalVideoTrack) {
		super(internalTrack);
	}

	getType() {
		return 'video' as const;
	}

	override getCodec(): VideoCodec | null {
		return this.internalTrack.info.codec;
	}

	getCodedWidth() {
		return this.internalTrack.info.width;
	}

	getCodedHeight() {
		return this.internalTrack.info.height;
	}

	getSquarePixelWidth() {
		return this.internalTrack.info.squarePixelWidth;
	}

	getSquarePixelHeight() {
		return this.internalTrack.info.squarePixelHeight;
	}

	getPixelAspectRatio() {
		return this.internalTrack.info.pixelAspectRatio;
	}

	getTransformationMatrix() {
		const info = this.internalTrack.info;

		// Yaw and pitch are applied before roll
		const linear = multiplyMatrices(
			scaleMatrix(info.horizontalScale, info.verticalScale),
			rotationMatrix(info.rotation),
		);

		return centeredTransformationMatrix(linear, info.width, info.height);
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		const decoderConfig = await this.getDecoderConfig();
		if (!decoderConfig) {
			return this.internalTrack.info.colorSpace;
		}

		return {
			primaries: decoderConfig.colorSpace?.primaries,
			transfer: decoderConfig.colorSpace?.transfer,
			matrix: decoderConfig.colorSpace?.matrix,
			fullRange: decoderConfig.colorSpace?.fullRange,
		};
	}

	async canBeTransparent() {
		return this.internalTrack.info.alphaMode || (
			this.internalTrack.info.codec === 'prores' && (
				this.internalTrack.info.proresFormat === 'ap4h'
				|| this.internalTrack.info.proresFormat === 'ap4x'
			)
		);
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		if (!this.internalTrack.info.codec) {
			return null;
		}

		return this.decoderConfigPromise ??= (async (): Promise<VideoDecoderConfig> => {
			let firstPacket: EncodedPacket | null = null;
			const needsPacketForAdditionalInfo
				= this.internalTrack.info.codec === 'vp9'
					|| this.internalTrack.info.codec === 'av1'
					|| this.internalTrack.info.codec === 'prores'
					// Packets are in Annex B format:
					|| (this.internalTrack.info.codec === 'avc' && !this.internalTrack.info.codecDescription)
					// Packets are in Annex B format:
					|| (this.internalTrack.info.codec === 'hevc' && !this.internalTrack.info.codecDescription);

			if (needsPacketForAdditionalInfo) {
				firstPacket = await this.getFirstPacket({});
			}

			const codecInfo = {
				width: this.internalTrack.info.width,
				height: this.internalTrack.info.height,
				codec: this.internalTrack.info.codec,
				codecDescription: this.internalTrack.info.codecDescription,
				colorSpace: this.internalTrack.info.colorSpace,
				avcType: 1 as const, // We don't know better (or do we?) so just assume 'avc1'
				avcCodecInfo: this.internalTrack.info.codec === 'avc' && firstPacket
					? extractAvcDecoderConfigurationRecord(firstPacket.data)
					: null,
				hevcCodecInfo: this.internalTrack.info.codec === 'hevc' && firstPacket
					? extractHevcDecoderConfigurationRecord(firstPacket.data)
					: null,
				vp9CodecInfo: this.internalTrack.info.codec === 'vp9' && firstPacket
					? extractVp9CodecInfoFromPacket(firstPacket.data)
					: null,
				av1CodecInfo: this.internalTrack.info.codec === 'av1' && firstPacket
					? extractAv1CodecInfoFromPacket(firstPacket.data)
					: null,
				proresCodecInfo: this.internalTrack.info.codec === 'prores' && firstPacket
					? extractProresCodecInfoFromPacket(firstPacket.data)
					: null,
				proresFormat: this.internalTrack.info.proresFormat,
			};

			if (!colorSpaceIsComplete(this.internalTrack.info.colorSpace)) {
				const colorSpace = extractColorSpace(codecInfo);

				// Fill the missing values
				this.internalTrack.info.colorSpace.primaries ??= colorSpace.primaries;
				this.internalTrack.info.colorSpace.transfer ??= colorSpace.transfer;
				this.internalTrack.info.colorSpace.matrix ??= colorSpace.matrix;
				this.internalTrack.info.colorSpace.fullRange ??= colorSpace.fullRange;
			}

			const config: VideoDecoderConfig = {
				codec: extractVideoCodecString(codecInfo),
				codedWidth: this.internalTrack.info.width,
				codedHeight: this.internalTrack.info.height,
				description: this.internalTrack.info.codecDescription ?? undefined,
				colorSpace: this.internalTrack.info.colorSpace,
			};

			const { width, height, pixelAspectRatio } = this.internalTrack.info;
			const displayAspect = getDisplayAspect(width, height, pixelAspectRatio);
			if (displayAspect) {
				config.displayAspectWidth = displayAspect.displayAspectWidth;
				config.displayAspectHeight = displayAspect.displayAspectHeight;
			}

			return config;
		})();
	}
}

class MatroskaAudioTrackBacking extends MatroskaTrackBacking implements InputAudioTrackBacking {
	declare internalTrack: InternalAudioTrack;
	decoderConfigPromise: Promise<AudioDecoderConfig> | null = null;

	constructor(internalTrack: InternalAudioTrack) {
		super(internalTrack);
	}

	getType() {
		return 'audio' as const;
	}

	override getCodec(): AudioCodec | null {
		return this.internalTrack.info.codec;
	}

	getNumberOfChannels() {
		return this.internalTrack.info.numberOfChannels;
	}

	getSampleRate() {
		return this.internalTrack.info.sampleRate;
	}

	getContainerPreRollDuration() {
		// SeekPreRoll: what the decoder must decode after a discontinuity before its output is valid
		return this.internalTrack.seekPreRollNs / 1e9;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		if (!this.internalTrack.info.codec) {
			return null;
		}

		return this.decoderConfigPromise ??= (async (): Promise<AudioDecoderConfig> => {
			if (this.internalTrack.info.codec === 'dts' && !this.internalTrack.info.dtsFormat) {
				// Gotta check the packet to determine the DTS variant
				const firstPacket = await this.getFirstPacket({});
				this.internalTrack.info.dtsFormat = firstPacket && extractDtsFourCcFromPacket(firstPacket.data);
			}

			return {
				codec: extractAudioCodecString({
					codec: this.internalTrack.info.codec,
					codecDescription: this.internalTrack.info.codecDescription,
					aacCodecInfo: this.internalTrack.info.aacCodecInfo,
					dtsFormat: this.internalTrack.info.dtsFormat,
				}),
				numberOfChannels: this.internalTrack.info.numberOfChannels,
				sampleRate: this.internalTrack.info.sampleRate,
				description: this.internalTrack.info.codecDescription ?? undefined,
			};
		})();
	}
}
