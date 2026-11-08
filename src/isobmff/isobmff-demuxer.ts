/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TrackType } from '../output';
import { buildAacAudioSpecificConfig, parseAacAudioSpecificConfig } from '../../shared/aac-misc';
import {
	AacCodecInfo,
	AudioCodec,
	DTS_FOURCCS,
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
	VP9_LEVEL_TABLE,
} from '../codec';
import {
	Av1CodecInfo,
	av1CodecInfoHasColorInfo,
	AvcDecoderConfigurationRecord,
	extractAv1CodecInfoFromPacket,
	extractProresCodecInfoFromPacket,
	extractVp9CodecInfoFromPacket,
	FlacBlockType,
	HevcDecoderConfigurationRecord,
	ProresCodecInfo,
	Vp9CodecInfo,
	vp9CodecInfoHasColorInfo,
	parseEac3Config,
	getEac3SampleRate,
	getEac3ChannelCount,
	extractDtsFourCcFromPacket,
	parseDtsSpecificBox,
	DTS_SPECIFIC_BOX_SIZE,
	AC3_ACMOD_CHANNEL_COUNTS,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
	HevcNalUnitType,
	parseAvcSps,
	parseHevcSps,
	iterateNalUnitsInLengthPrefixed,
	concatNalUnitsInLengthPrefixed,
} from '../codec-data';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { fromMatroskaLanguageCode } from '../matroska/ebml';
import {
	InputAudioTrackBacking,
	InputTrackBacking,
	InputVideoTrackBacking,
} from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import {
	assert,
	binarySearchExact,
	binarySearchLessOrEqual,
	bytesToHexString,
	COLOR_PRIMARIES_MAP_INVERSE,
	IDENTITY_MATRIX,
	isIso639Dash2LanguageCode,
	isThenable,
	last,
	MATRIX_COEFFICIENTS_MAP_INVERSE,
	multiplyMatrices,
	Rational,
	textDecoder,
	TransformationMatrix,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
	UNDETERMINED_LANGUAGE,
	toDataView,
	roundIfAlmostInteger,
	hexStringToBytes,
	HEX_STRING_REGEX,
	EMPTY_COLOR_SPACE,
	colorSpaceIsComplete,
	MaybePromise,
	uint8ArraysAreEqual,
	getDisplayAspect,
	simplifyRational,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import {
	buildIsobmffMimeType,
	parsePsshBoxContents,
	psshBoxesAreEqual,
	PsshBox,
	TIMESTAMP_OFFSET,
} from './isobmff-misc';
import {
	MAX_BOX_HEADER_SIZE,
	MIN_BOX_HEADER_SIZE,
	readBoxHeader,
	readDataBox,
	readFreeformMetadataItem,
	readFixed_16_16,
	readFixed_2_30,
	readEsDescriptor,
	readMetadataStringShort,
} from './isobmff-reader';
import {
	FileSlice,
	readBytes,
	readF64Be,
	readI16Be,
	readI32Be,
	readI64Be,
	Reader,
	readU16Be,
	readU24Be,
	readU32Be,
	readU64Be,
	readU8,
	readAscii,
	SliceRangeError,
} from '../reader';
import {
	DEFAULT_TRACK_DISPOSITION,
	MetadataTags,
	RichImageData,
	TrackDisposition,
	unwatchMetadataTagFields,
	watchMetadataTagFields,
} from '../metadata';
import { AC3_SAMPLE_RATES } from '../../shared/ac3-misc';
import { Bitstream } from '../../shared/bitstream';
import { Aes128CbcContext } from '../aes';
import { Logging } from '../logging';
import { ID3_V1_GENRES } from '../id3';

const TRUEHD_CHANNEL_ASSIGNMENT_COUNTS = [2, 1, 1, 2, 2, 2, 2, 1, 1, 2, 2, 1, 1];

/**
 * QuickTime's Macintosh language codes 0 to 94 as ISO 639-2/T codes, empty where a language has none of its own (the
 * languages of FFmpeg's mov_mdhd_language_map, with terminology codes for the bibliographic ones it lists).
 */
const MACINTOSH_LANGUAGE_CODES = [
	'eng', 'fra', 'deu', 'ita', 'nld', 'swe', 'spa', 'dan', 'por', 'nor', 'heb', 'jpn', 'ara', 'fin', 'ell', 'isl',
	'mlt', 'tur', 'hrv', 'zho', 'urd', 'hin', 'tha', 'kor', 'lit', 'pol', 'hun', 'est', 'lav', 'smi', 'fao', 'fas',
	'rus', 'zho', '', 'gle', 'sqi', 'ron', 'ces', 'slk', 'slv', 'yid', 'srp', 'mkd', 'bul', 'ukr', 'bel', 'uzb',
	'kaz', 'aze', 'aze', 'hye', 'kat', 'ron', 'kir', 'tgk', 'tuk', 'mon', '', 'pus', 'kur', 'kas', 'snd', 'bod',
	'nep', 'san', 'mar', 'ben', 'asm', 'guj', 'pan', 'ori', 'mal', 'kan', 'tam', 'tel', 'sin', 'mya', 'khm', 'lao',
	'vie', 'ind', 'tgl', 'msa', 'msa', 'amh', 'tir', 'orm', 'som', 'swa', 'kin', 'run', 'nya', 'mlg', 'epo',
];
/** Macintosh language codes 128 to 138, likewise */
const MACINTOSH_LANGUAGE_CODES_FROM_128 = ['cym', 'eus', 'cat', 'lat', 'que', 'grn', 'aym', 'tat', 'uig', 'dzo', 'jav'];

type InternalTrack = {
	id: number;
	demuxer: IsobmffDemuxer;
	trackBacking: InputTrackBacking | null;
	disposition: TrackDisposition;
	timescale: number;
	durationInMovieTimescale: number;
	durationInMediaTimescale: number;
	matrix: TransformationMatrix;
	internalCodecId: string | null;
	name: string | null;
	languageCode: string;
	sampleTableByteOffset: number | null; // null when the track's sample table is another file (ominous ik 👀)
	sampleTable: SampleTable | null;
	/** The encryption info of each sample description (stsd entry), which can each have their own key ID */
	encryptionInfos: (TrackEncryptionInfo | null)[];
	fragmentLookupTable: FragmentLookupTableEntry[];
	/**
	 * Where each read fragment with samples of this track ends in decode time, sorted by moof offset. Unlike the
	 * position cache, it holds every fragment, also those presented before the fragment preceding them.
	 */
	fragmentDecodeEnds: {
		moofOffset: number;
		endDecodeTimestamp: number;
	}[];
	currentFragmentState: FragmentTrackState | null;
	/**
	 * List of all encountered fragment offsets alongside their timestamps. This list never gets truncated, but memory
	 * consumption should be negligible.
	 */
	fragmentPositionCache: {
		moofOffset: number;
		startTimestamp: number;
		endDecodeTimestamp: number;
		hasKeyFrame: boolean;
	}[];
	/**
	 * Lets fragment scans skip the fragments without this track (before its start, in a gap in it, or after its end)
	 * instead of walking them again. When a scan went past such fragments, this maps where it came from (the end of a
	 * moof box with samples of this track, or 0 for the start of the file) to the offset of the next moof box with
	 * samples of this track, or to Infinity if there was none before the end of the file.
	 */
	nextFragmentOffsets: Map<number, number>;
	/**
	 * The moof offsets of the fragments read so far whose samples of this track aren't placed in time and remembered
	 * in `fragmentPositionCache` yet (see placeFragmentTrackData)
	 */
	unplacedFragmentOffsets: number[];
	/** The segment durations of all edit list entries leading up to the main one (from which the offset is taken.) */
	editListPreviousSegmentDurations: number;
	/** The media time offset of the main edit list entry (with media time !== -1) */
	editListOffset: number;
	/** See getMaxReorderedSamples; computed on first use */
	maxReorderedSamples?: number;
	/** For tracks that can reorder samples, what each fragment read so far presents, by moof offset */
	fragmentPresentations?: Map<number, FragmentPresentation>;
	/** The keys of fragmentPresentations, sorted */
	fragmentPresentationOffsets?: number[];
	hasEditList: boolean;
	/** For AAC, the decoded sample rate when it differs from info.sampleRate (implicit SBR; see the esds box) */
	aacOutputSampleRate?: number;
	/** Set when the track's samples are encrypted using a supported scheme (cenc/cens/cbcs), parsed from sinf/tenc. */
	encryptionInfo: TrackEncryptionInfo | null;
	/** The codec info read from each sample description, of which the one the samples refer to is used. */
	sampleDescriptionStates: SampleDescriptionState[];
	/** The sample description index of the first chunk in the sample table, if there is one. */
	firstChunkSampleDescriptionIndex: number | null;
	/** The entries of the track's 'seig' sample group description, which fragments can refer to. */
	encryptionGroups: SampleGroupEncryption[];
	/** The entry of the track's 'seig' sample group description that applies to samples without a mapping. */
	defaultEncryptionGroup: SampleGroupEncryption | null;
	/** The 'seig' sample-to-group runs of a non-fragmented track's sample table, with their first sample index */
	encryptionGroupRuns: { startIndex: number; sampleCount: number; groupDescriptionIndex: number }[];
	/** The avcC or hvcC record of each sample description (by index), if it has one. */
	sampleDescriptionRecords: (Uint8Array | null)[];
	/** Parameter sets to send in band, computed on first use; see getInBandParameterSets. */
	inBandParameterSets?: InBandParameterSets | null;
	/** For non-fragmented encrypted tracks: parsed saiz+saio from stbl; aux info is fetched lazily on first use. */
	encryptionAuxInfo: SampleEncryptionAuxInfo | null;
	frmaCodecString: string | null;
	/**
	 * Whether each sample description (stsd entry) is an encrypted one. A track may also have clear ones, which
	 * clear lead samples use (Shaka Packager, for example).
	 */
	encryptedSampleDescriptions: boolean[];
	/** In bits per second, from the btrt box if present. */
	maxBitrate: number | null;
	avgBitrate: number | null;
} & ({
	info: null;
} | {
	info: {
		type: 'video';
		width: number;
		height: number;
		squarePixelWidth: number;
		squarePixelHeight: number;
		/** Whether the current sample entry has a pasp box, whose pixel aspect ratio wins over the bitstream's */
		hasPixelAspectRatioBox: boolean;
		/** Exact, unlike the square pixel size */
		pixelAspectRatio: Rational;
		codec: VideoCodec | null;
		codecDescription: Uint8Array | null;
		colorSpace: VideoColorSpaceInit;
		avcType: 1 | 3 | null;
		hevcType: 'hvc1' | 'hev1' | null;
		avcCodecInfo: AvcDecoderConfigurationRecord | null;
		hevcCodecInfo: HevcDecoderConfigurationRecord | null;
		vp9CodecInfo: Vp9CodecInfo | null;
		av1CodecInfo: Av1CodecInfo | null;
		proresCodecInfo: ProresCodecInfo | null;
		proresFormat: ProresFourCc | null;
	};
} | {
	info: {
		type: 'audio';
		numberOfChannels: number;
		sampleRate: number;
		codec: AudioCodec | null;
		codecDescription: Uint8Array | null;
		aacCodecInfo: AacCodecInfo | null;
		dtsFormat: DtsFourCc | null;
		pcmLittleEndian: boolean;
		pcmSampleSize: number | null;
		/** The compressed packet layout from a QuickTime sound sample description version 1, if there is one. */
		soundPacketLayout: { samplesPerPacket: number; bytesPerFrame: number } | null;
	};
});

type InternalVideoTrack = InternalTrack & {	info: { type: 'video' } };
type InternalAudioTrack = InternalTrack & {	info: { type: 'audio' } };

type SampleTable = {
	sampleTimingEntries: SampleTimingEntry[];
	sampleCompositionTimeOffsets: SampleCompositionTimeOffsetEntry[];
	sampleSizes: number[];
	sampleCount: number;
	cumulativeSampleSizes: number[] | null; // At i, the summed size of all samples before sample i
	keySampleIndices: number[] | null; // Samples that are keyframes
	chunkOffsets: number[];
	sampleToChunk: SampleToChunkEntry[];
	sortedCompositionTimeOffsets: SampleCompositionTimeOffsetEntry[] | null; // Sorted by presentation timestamp
};
type SampleTimingEntry = {
	startIndex: number;
	startDecodeTimestamp: number;
	count: number;
	delta: number;
};
type SampleCompositionTimeOffsetEntry = {
	startIndex: number;
	count: number;
	offset: number;
	startTimestamp: number; // Of the first sample
	lastTimestamp: number; // Of the last sample
	maxLastTimestamp: number; // Over this and all entries before it in presentation order
};
type SampleToChunkEntry = {
	startSampleIndex: number;
	startChunkIndex: number;
	samplesPerChunk: number;
	sampleDescriptionIndex: number;
};

type FragmentTrackDefaults = {
	trackId: number;
	defaultSampleDescriptionIndex: number;
	defaultSampleDuration: number;
	defaultSampleSize: number;
	defaultSampleFlags: number;
};

type FragmentLookupTableEntry = {
	timestamp: number;
	moofOffset: number;
	trunNumber: number; // 1-indexed
	sampleNumber: number; // 1-indexed
};

type SampleDescriptionState = Pick<InternalTrack, 'info' | 'internalCodecId' | 'maxBitrate' | 'avgBitrate'>;

type FragmentTrackState = {
	baseDataOffset: number;
	sampleDescriptionIndex: number | null;
	defaultSampleDuration: number | null;
	defaultSampleSize: number | null;
	defaultSampleFlags: number | null;
	/** For video, the sample_depends_on of each sample's flags, which the sdtp box can tell where it's 0 (unknown) */
	sampleDependsOn: number[];
	/** The traf's sdtp box entries, one per sample */
	sampleDependencies: Uint8Array | null;
	startTimestamp: number | null;
	encryptionAuxInfo: SampleEncryptionAuxInfo | null;
	/** The traf's own 'seig' sample group entries */
	encryptionGroups: SampleGroupEncryption[];
	/** The traf's own 'seig' entry for samples without a mapping */
	defaultEncryptionGroup: SampleGroupEncryption | null;
	/** The traf's 'seig' sample-to-group runs */
	encryptionGroupRuns: { sampleCount: number; groupDescriptionIndex: number }[] | null;
	/** The senc box, read once the samples' groups are known */
	sencSlice: FileSlice | null;
};

type FragmentTrackData = {
	track: InternalTrack;

	// Kept as state for the presence of multiple trun boxes
	currentTimestamp: number;
	currentOffset: number;

	startTimestamp: number;
	endTimestamp: number;
	firstKeyFrameTimestamp: number | null;
	samples: FragmentTrackSample[];
	presentationTimestamps: {
		presentationTimestamp: number;
		sampleIndex: number;
	}[];
	startTimestampIsFinal: boolean;
	trunSampleCounts: number[];
	encryptionAuxInfo: SampleEncryptionAuxInfo | null;
	/** Whether the samples use an encrypted sample description */
	isEncrypted: boolean;
	sampleDescriptionIndex: number;
};

type FragmentTrackSample = {
	presentationTimestamp: number;
	duration: number;
	byteOffset: number;
	byteSize: number;
	encryptionGroup: SampleGroupEncryption | null;
	isKeyFrame: boolean;
	encryption: SampleEncryptionInfo | null;
};

type Fragment = {
	moofOffset: number;
	moofSize: number;
	implicitBaseDataOffset: number;
	/** Where the data of a skipped traf lies, so the implicit base data offset can move past it. */
	skippedTraf: { baseDataOffset: number; dataEnd: number | null; defaultSampleSize: number | null } | null;
	trackData: Map<InternalTrack['id'], FragmentTrackData>;
	psshBoxes: PsshBox[];
	sampleCount: number;
};

/** What a fragment presents of a track; see getFragmentSampleDuration */
type FragmentPresentation = {
	moofSize: number;
	/** The presentation timestamps of the track's samples, sorted */
	timestamps: number[];
	/** The earliest presentation timestamp of a sync sample, or Infinity */
	minSyncTimestamp: number;
	/** The offset of the next moof box holding the track, once known (null for none) */
	nextMoofOffset?: number | null;
	/** Durations computed so far, by sample index */
	durations: Map<number, number>;
};

type FragmentSummary = {
	moofSize: number;
	trackIds: Set<number>; // The tracks with samples in the fragment
};

type TrackEncryptionInfo = {
	scheme: 'cenc' | 'cens' | 'cbcs';
	defaultKid: string | null;
	defaultIsProtected: boolean | null;
	defaultPerSampleIvSize: number | null;
	defaultConstantIv: Uint8Array | null;
	defaultCryptByteBlock: number | null;
	defaultSkipByteBlock: number | null;
};

type SampleEncryptionInfo = {
	iv: Uint8Array;
	subsamples: {
		clearLen: number;
		protectedLen: number;
	}[] | null;
};

/** A CENC sample group entry ('seig'), overriding the tenc defaults for its samples (e.g. for key rotation). */
type SampleGroupEncryption = {
	isProtected: boolean;
	perSampleIvSize: number;
	kid: string;
	constantIv: Uint8Array | null;
	cryptByteBlock: number;
	skipByteBlock: number;
};

/**
 * Holds parsed saiz+saio state. The encryption info itself lives at a file offset and is fetched lazily.
 * For fragmented files this state is per-traf; for non-fragmented files it's per-track (on stbl).
 */
type SampleEncryptionAuxInfo = {
	defaultSampleInfoSize: number;
	sampleSizes: Uint8Array | null;
	sampleCount: number;
	offset: number | null; // Absolute file offset of the first sample's aux info
	offsets: number[]; // Every absolute offset of the saio box: one per track run or chunk if there are several
	resolved: SampleEncryptionInfo[] | null;
};

// Anything beyond this is malicious
const MAX_BOX_NESTING_DEPTH = 64;

/**
 * Caps the entry count read from a box at the number of entries that fit into the rest of the box, so that a corrupt
 * count doesn't make us read past the box. FFmpeg's mov demuxer likewise stops at the end of the atom.
 */
const capEntryCount = (entryCount: number, slice: FileSlice, boxEndPos: number, entrySize: number) => {
	const availableBytes = Math.min(boxEndPos, slice.end) - slice.filePos;
	return Math.min(entryCount, Math.max(Math.floor(availableBytes / entrySize), 0));
};

/**
 * Vorbis in MP4 is nonstandard. gpac's esds holds the three Vorbis headers each prefixed with a 16-bit length, while
 * decoders (like WebCodecs, and FFmpeg's own layout) expect Xiph lacing. Like FFmpeg's avpriv_split_xiph_headers,
 * recognize that layout by the size of the identification header and convert it. Returns null for anything else.
 */
const xiphLaceLengthPrefixedVorbisHeaders = (bytes: Uint8Array) => {
	const VORBIS_IDENTIFICATION_HEADER_SIZE = 30;

	const headers: Uint8Array[] = [];
	let pos = 0;
	for (let i = 0; i < 3; i++) {
		if (pos + 2 > bytes.length) {
			return null;
		}

		const length = (bytes[pos]! << 8) | bytes[pos + 1]!;
		if (pos + 2 + length > bytes.length) {
			return null;
		}

		headers.push(bytes.subarray(pos + 2, pos + 2 + length));
		pos += 2 + length;
	}

	const identificationHeader = headers[0]!;
	if (identificationHeader.length !== VORBIS_IDENTIFICATION_HEADER_SIZE || identificationHeader[0] !== 1) {
		return null;
	}

	const view = toDataView(identificationHeader);
	const numberOfChannels = view.getUint8(11);
	const sampleRate = view.getUint32(12, true);
	if (numberOfChannels === 0 || sampleRate === 0) {
		return null;
	}

	// The segment table holds the sizes of the first two headers; the third one takes up the rest
	const segmentTable: number[] = [];
	for (const header of headers.slice(0, 2)) {
		for (let remaining = header.length; ; remaining -= 255) {
			segmentTable.push(Math.min(remaining, 255));
			if (remaining < 255) {
				break;
			}
		}
	}

	const laced = new Uint8Array(1 + segmentTable.length + pos - 6);
	laced[0] = 2; // Number of headers minus one
	laced.set(segmentTable, 1);
	let writePos = 1 + segmentTable.length;
	for (const header of headers) {
		laced.set(header, writePos);
		writePos += header.length;
	}

	return { description: laced, numberOfChannels, sampleRate };
};

/**
 * The fewest content bytes that the fixed fields of these boxes take up. Boxes that are smaller (for example, empty)
 * are skipped. Variable-length contents are checked where they're read.
 */
const MIN_BOX_CONTENT_SIZES: Partial<Record<string, number>> = {
	meta: 4,
	mehd: 8,
	trex: 24,
	tfhd: 8,
	tfdt: 8,
	trun: 8,
	elst: 8,
	stts: 8,
	ctts: 8,
	stss: 8,
	stsc: 8,
	stco: 8,
	co64: 8,
	stsz: 12,
	stz2: 12,
	frma: 4,
	colr: 4,
	pasp: 8,
	btrt: 12,
	vpcC: 10,
	esds: 6,
	dOps: 11,
	dfLa: 8,
	dac3: 3,
	dmlp: 4,
	pcmC: 6,
	enda: 2,
};

/**
 * Sample durations above this are taken to be negative values stored as unsigned ones (like FFmpeg's
 * max_stts_delta default).
 */
const MAX_SAMPLE_DELTA = 0xffffffff - 48000 * 10;

export class IsobmffDemuxer extends Demuxer {
	reader: Reader;
	moovSlice: FileSlice | null = null;

	currentTrack: InternalTrack | null = null;
	tracks: InternalTrack[] = [];
	idToTrack = new Map<number, InternalTrack>();
	metadataPromise: Promise<void> | null = null;
	movieTimescale = -1;
	/** Whether the file ends inside the moov box (or the moov box's size goes past the end of the file) */
	moovIsCutOff = false;
	movieDurationInTimescale = -1;
	/** From the mehd box: the duration of a fragmented movie including its fragments, in the movie timescale */
	fragmentedMovieDurationInTimescale = -1;
	movieMatrix = IDENTITY_MATRIX;
	isQuickTime = false;
	metadataTags: MetadataTags = {};
	/** The encoder delay from the iTunSMPB tag, in samples. */
	iTunesPriming: number | null = null;
	currentMetadataKeys: Map<number, string> | null = null;

	isFragmented = false;
	fragmentTrackDefaults = new Map<number, FragmentTrackDefaults>();
	psshBoxes: PsshBox[] = [];
	currentFragment: Fragment | null = null;
	isReadingTraf = false;
	/**
	 * Caches the last fragment that was read. Based on the assumption that there will be multiple reads to the
	 * same fragment in quick succession.
	 */
	lastReadFragment: Fragment | null = null;
	fragmentSummaries = new Map<number, FragmentSummary>(); // Keyed by moof offset
	/** Lookups have gone past every top-level box before this file position, so its fragments have all been read */
	fragmentsWalkedUpTo = 0;

	decryptionKeyCache = new Map<string, Promise<Uint8Array>>();
	boxNestingDepth = 0;
	/** Positions of boxes whose fields run past the end of their parent, which get skipped */
	damagedBoxPositions = new Set<number>();

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	override async getTrackBackings() {
		await this.readMetadata();
		return this.tracks.map(track => track.trackBacking!);
	}

	override async getMimeType() {
		await this.readMetadata();

		const backings = await this.getTrackBackings();
		const codecStrings = await Promise.all(backings.map(
			x => x.getDecoderConfig().then(c => c?.codec ?? null),
		));

		return buildIsobmffMimeType({
			isQuickTime: this.isQuickTime,
			hasVideo: this.tracks.some(x => x.info?.type === 'video'),
			hasAudio: this.tracks.some(x => x.info?.type === 'audio'),
			codecStrings: codecStrings.filter(Boolean) as string[],
		});
	}

	async getMetadataTags() {
		await this.readMetadata();
		return this.metadataTags;
	}

	readMetadata() {
		return this.metadataPromise ??= (async () => {
			let currentPos = 0;
			let lookForMfraBox = false;
			let foundMovieBoxes = false;

			while (true) {
				let slice = this.reader.requestSliceRange(currentPos, MIN_BOX_HEADER_SIZE, MAX_BOX_HEADER_SIZE);
				if (isThenable(slice)) slice = await slice;
				if (!slice) break;

				const startPos = currentPos;
				let boxInfo = readBoxHeader(slice);
				if (!boxInfo) {
					// A size of 0 means that the box extends to the end of the file, which the last top-level box may
					// do (ISO/IEC 14496-12 4.2; FFmpeg and Chromium read it so). Only a moov box there matters here.
					slice.filePos = startPos;
					if (readU32Be(slice) !== 0 || readAscii(slice, 4) !== 'moov') {
						break;
					}

					const fileSize = await this.readUntilFileSizeIsKnown(startPos);
					if (fileSize === null) {
						break;
					}

					const totalSize = fileSize - startPos;
					boxInfo = { name: 'moov', totalSize, headerSize: 8, contentSize: totalSize - 8 };
				}

				if ((boxInfo.name === 'ftyp' || boxInfo.name === 'styp') && slice.remainingLength >= 4) {
					const majorBrand = readAscii(slice, 4);
					this.isQuickTime = majorBrand === 'qt  ';
				} else if (boxInfo.name === 'moov') {
					// Found moov, load it. If the file is cut off inside it (an interrupted download, say) or its size
					// goes past the end of the file, take what's there: the boxes before that point are complete.
					let moovSlice = this.reader.requestSliceRange(slice.filePos, 0, boxInfo.contentSize);
					if (isThenable(moovSlice)) moovSlice = await moovSlice;
					if (!moovSlice) break;

					this.moovIsCutOff = moovSlice.length < boxInfo.contentSize;
					this.moovSlice = moovSlice;
					this.parseSkippingDamagedBoxes(moovSlice, slice => this.readContiguousBoxes(slice));

					if (this.movieTimescale === -1) {
						throw new Error('Invalid moov box: missing mvhd box.');
					}

					for (const track of this.tracks) {
						// Modify the edit list offset based on the previous segment durations. They are in different
						// timescales, so we first convert to seconds and then into the track timescale.
						const previousSegmentDurationsInSeconds
							= track.editListPreviousSegmentDurations / this.movieTimescale;
						track.editListOffset -= Math.round(previousSegmentDurationsInSeconds * track.timescale);

						if (
							this.iTunesPriming !== null
							&& !track.hasEditList
							&& track.info?.type === 'audio'
							&& track.info.codec === 'aac'
						) {
							// Without an edit list, iTunes-style files only declare the encoder delay in iTunSMPB,
							// which FFmpeg applies just like an edit list's media time. It counts output samples, which
							// for HE-AAC are at twice the rate of the core coder that the media timescale may follow.
							const outputSampleRate = track.aacOutputSampleRate
								?? (track.info.sampleRate > 0 ? track.info.sampleRate : track.timescale);
							track.editListOffset = Math.round(this.iTunesPriming * track.timescale / outputSampleRate);
						}
					}

					await this.applyReferencedSampleDescriptions(startPos + boxInfo.totalSize);

					lookForMfraBox = this.isFragmented
						&& this.reader.fileSize !== null
						&& this.reader.fileSize > startPos + boxInfo.totalSize; // There's more after the moov box
					foundMovieBoxes = true;

					break;
				} else if (boxInfo.name === 'moof') {
					if (!this.input._initInput) {
						throw new Error(
							'"moof" box encountered with no "moov" box present; this file is likely a Segment as'
							+ ' described in ISO/IEC 14496-12 Section 8.16. A separate init file that contains a "moov"'
							+ ' box is required to read this file, please provide it using InputOptions.initInput.',
						);
					}

					await this.copyMetadataFromInitInput(this.input._initInput);

					lookForMfraBox = false; // No point in doing it for segment files
					foundMovieBoxes = true;

					break;
				}

				currentPos = startPos + boxInfo.totalSize;
			}

			if (!foundMovieBoxes && this.input._initInput) {
				// A segment file is allowed to hold zero fragments, in which case there's no moof box to key off of.
				// It's still a perfectly valid segment, so let's take the tracks from the init input.
				await this.copyMetadataFromInitInput(this.input._initInput);
			}

			if (lookForMfraBox) {
				assert(this.reader.fileSize !== null);

				// The last 4 bytes may contain the size of the mfra box at the end of the file
				let lastWordSlice = this.reader.requestSlice(this.reader.fileSize - 4, 4);
				if (isThenable(lastWordSlice)) lastWordSlice = await lastWordSlice;
				assert(lastWordSlice);

				const lastWord = readU32Be(lastWordSlice);
				const potentialMfraPos = this.reader.fileSize - lastWord;

				if (potentialMfraPos >= 0 && potentialMfraPos <= this.reader.fileSize - MAX_BOX_HEADER_SIZE) {
					let mfraHeaderSlice = this.reader.requestSliceRange(
						potentialMfraPos,
						MIN_BOX_HEADER_SIZE,
						MAX_BOX_HEADER_SIZE,
					);
					if (isThenable(mfraHeaderSlice)) mfraHeaderSlice = await mfraHeaderSlice;

					if (mfraHeaderSlice) {
						const boxInfo = readBoxHeader(mfraHeaderSlice);

						if (boxInfo && boxInfo.name === 'mfra') {
							// We found the mfra box, allowing for much better random access. Let's parse it.
							let mfraSlice = this.reader.requestSlice(mfraHeaderSlice.filePos, boxInfo.contentSize);
							if (isThenable(mfraSlice)) mfraSlice = await mfraSlice;

							if (mfraSlice) {
								this.parseSkippingDamagedBoxes(mfraSlice, slice => this.readContiguousBoxes(slice));
							}
						}
					}
				}
			}

			for (const track of this.tracks) {
				// Sort by timestamp in case it's not naturally sorted, and remove multiple entries for the same time
				const table = track.fragmentLookupTable;
				table.sort((a, b) => a.timestamp - b.timestamp);

				let writeIndex = 0;
				for (const entry of table) {
					if (writeIndex === 0 || entry.timestamp !== table[writeIndex - 1]!.timestamp) {
						table[writeIndex++] = entry;
					}
				}
				table.length = writeIndex;
			}
		})();
	}

	/**
	 * For tracks with several sample descriptions, takes the codec info from the one the first samples refer to:
	 * through the sample table's first chunk, or for fragmented files through the first fragment's tfhd or trex. FFmpeg
	 * switches between descriptions per sample, and Chromium picks the one trex refers to. Without either, the last
	 * description is kept.
	 */
	private async applyReferencedSampleDescriptions(moovEndPos: number) {
		const tracks = this.tracks.filter(track => track.sampleDescriptionStates.length > 1);
		if (tracks.length === 0) {
			return;
		}

		let firstFragmentIndices: Map<number, number> | null = null;
		if (this.isFragmented && tracks.some(track => track.firstChunkSampleDescriptionIndex === null)) {
			firstFragmentIndices = await this.readFirstFragmentSampleDescriptionIndices(moovEndPos);
		}

		for (const track of tracks) {
			const candidates = [
				track.firstChunkSampleDescriptionIndex,
				...(this.isFragmented
					? [
							firstFragmentIndices?.get(track.id),
							this.fragmentTrackDefaults.get(track.id)?.defaultSampleDescriptionIndex,
						]
					: []),
			];
			const index = candidates.find(x => x != null && x >= 1 && x <= track.sampleDescriptionStates.length);

			if (index != null) {
				Object.assign(track, track.sampleDescriptionStates[index - 1]!);
			}
		}
	}

	/** Reads which sample description each track fragment of the first moof box refers to, by track ID. */
	private async readFirstFragmentSampleDescriptionIndices(pos: number) {
		const indices = new Map<number, number>();

		// Any number of boxes (like sidx, styp, emsg or free) may come before the first moof box. Every box moves the
		// position forward by at least its header, so this ends at the first moof box or the end of the file.
		while (true) {
			let slice = this.reader.requestSliceRange(pos, MIN_BOX_HEADER_SIZE, MAX_BOX_HEADER_SIZE);
			if (isThenable(slice)) {
				slice = await slice;
			}
			if (!slice) {
				break;
			}

			const boxInfo = readBoxHeader(slice);
			if (!boxInfo || boxInfo.totalSize === 0) {
				break;
			}

			if (boxInfo.name === 'moof') {
				let moofSlice = this.reader.requestSlice(slice.filePos, boxInfo.contentSize);
				if (isThenable(moofSlice)) {
					moofSlice = await moofSlice;
				}
				if (!moofSlice) {
					break;
				}

				for (const { boxInfo: trafInfo, slice: trafSlice } of this.iterateContiguousBoxes(moofSlice)) {
					if (trafInfo.name !== 'traf') {
						continue;
					}

					const trafContentSlice = trafSlice.slice(trafSlice.filePos, trafInfo.contentSize);
					const children = this.iterateContiguousBoxes(trafContentSlice);
					for (const { boxInfo: childInfo, slice: childSlice } of children) {
						if (childInfo.name !== 'tfhd') {
							continue;
						}

						childSlice.skip(1); // Version
						const flags = readU24Be(childSlice);
						const trackId = readU32Be(childSlice);
						const hasBaseDataOffset = Boolean(flags & 0x000001);
						if (flags & 0x000002 && childInfo.contentSize >= (hasBaseDataOffset ? 20 : 12)) {
							childSlice.skip(hasBaseDataOffset ? 8 : 0);
							indices.set(trackId, readU32Be(childSlice));
						}

						break;
					}
				}

				break;
			}

			pos += boxInfo.totalSize;
		}

		return indices;
	}

	/** The file size, reading on from the given position until the end of the file if the source doesn't know it. */
	private async readUntilFileSizeIsKnown(pos: number) {
		while (this.reader.fileSizeNonStrict === null) {
			let slice = this.reader.requestSliceRange(pos, 0, 2 ** 16);
			if (isThenable(slice)) {
				slice = await slice;
			}
			if (!slice || slice.length === 0) {
				break;
			}

			pos += slice.length;
		}

		return this.reader.fileSizeNonStrict;
	}

	private async copyMetadataFromInitInput(initInput: Input) {
		const initDemuxer = (await initInput._getDemuxer()) as IsobmffDemuxer;
		if (initDemuxer.constructor !== IsobmffDemuxer) {
			throw new Error('Init input must match the input\'s format.');
		}

		await initDemuxer.readMetadata();

		this.movieTimescale = initDemuxer.movieTimescale;
		this.movieDurationInTimescale = initDemuxer.movieDurationInTimescale;
		this.fragmentedMovieDurationInTimescale = initDemuxer.fragmentedMovieDurationInTimescale;
		this.movieMatrix = initDemuxer.movieMatrix;
		this.metadataTags = initDemuxer.metadataTags;
		this.isFragmented = true;
		this.fragmentTrackDefaults = initDemuxer.fragmentTrackDefaults;
		this.psshBoxes = initDemuxer.psshBoxes;

		// Create tracks from the init input's tracks
		for (const foreignTrack of initDemuxer.tracks) {
			const track: InternalTrack = {
				id: foreignTrack.id,
				demuxer: this,
				trackBacking: null,
				disposition: foreignTrack.disposition,
				timescale: foreignTrack.timescale,
				durationInMediaTimescale: foreignTrack.durationInMediaTimescale,
				durationInMovieTimescale: foreignTrack.durationInMovieTimescale,
				matrix: foreignTrack.matrix,
				internalCodecId: foreignTrack.internalCodecId,
				name: foreignTrack.name,
				languageCode: foreignTrack.languageCode,
				sampleTableByteOffset: null,
				sampleTable: null,
				encryptionInfos: foreignTrack.encryptionInfos,
				fragmentLookupTable: [],
				fragmentDecodeEnds: [],
				currentFragmentState: null,
				fragmentPositionCache: [],
				nextFragmentOffsets: new Map(),
				unplacedFragmentOffsets: [],
				editListPreviousSegmentDurations: foreignTrack.editListPreviousSegmentDurations,
				editListOffset: foreignTrack.editListOffset,
				hasEditList: foreignTrack.hasEditList,
				encryptionInfo: foreignTrack.encryptionInfo,
				sampleDescriptionStates: [],
				firstChunkSampleDescriptionIndex: null,
				encryptionGroups: foreignTrack.encryptionGroups,
				defaultEncryptionGroup: foreignTrack.defaultEncryptionGroup,
				encryptionGroupRuns: foreignTrack.encryptionGroupRuns,
				sampleDescriptionRecords: foreignTrack.sampleDescriptionRecords,
				encryptionAuxInfo: null,
				frmaCodecString: null,
				encryptedSampleDescriptions: foreignTrack.encryptedSampleDescriptions,
				maxBitrate: foreignTrack.maxBitrate,
				avgBitrate: foreignTrack.avgBitrate,
				info: foreignTrack.info,
			};

			if (foreignTrack.trackBacking) {
				assert(track.info);

				if (track.info.type === 'video' && track.info.width !== -1) {
					const videoTrack = track as InternalVideoTrack;
					track.trackBacking = new IsobmffVideoTrackBacking(videoTrack);
					this.tracks.push(track);
					this.idToTrack.set(track.id, track);
				} else if (track.info.type === 'audio' && track.info.numberOfChannels !== -1) {
					const audioTrack = track as InternalAudioTrack;
					track.trackBacking = new IsobmffAudioTrackBacking(audioTrack);
					this.tracks.push(track);
					this.idToTrack.set(track.id, track);
				}
			} else {
				// The track didn't have enough info to warrant a backing
			}
		}
	}

	getSampleTableForTrack(internalTrack: InternalTrack) {
		if (internalTrack.sampleTable) {
			return internalTrack.sampleTable;
		}

		const sampleTable: SampleTable = {
			sampleTimingEntries: [],
			sampleCompositionTimeOffsets: [],
			sampleSizes: [],
			sampleCount: 0,
			cumulativeSampleSizes: null,
			keySampleIndices: null,
			chunkOffsets: [],
			sampleToChunk: [],
			sortedCompositionTimeOffsets: null,
		};
		internalTrack.sampleTable = sampleTable;

		if (internalTrack.sampleTableByteOffset === null) {
			// There's no sample table to read, it's in another file (happens with segments)
			return sampleTable;
		}

		assert(this.moovSlice);

		const stblContainerSlice = this.moovSlice.slice(internalTrack.sampleTableByteOffset);

		this.currentTrack = internalTrack;
		try {
			this.parseSkippingDamagedBoxes(stblContainerSlice, slice => this.traverseBox(slice));
		} catch (error) {
			internalTrack.sampleTable = null;
			throw error;
		} finally {
			this.currentTrack = null;
		}

		const lastTimingEntry = last(sampleTable.sampleTimingEntries);
		const lastChunkEntryIndex = binarySearchLessOrEqual(
			sampleTable.sampleToChunk,
			sampleTable.chunkOffsets.length - 1,
			x => x.startChunkIndex,
		);
		const lastChunkEntry = sampleTable.sampleToChunk[lastChunkEntryIndex];

		// Clamp the sample count on the minimum of what all the subentries tell us
		sampleTable.sampleCount = Math.min(
			sampleTable.sampleCount,
			lastTimingEntry ? lastTimingEntry.startIndex + lastTimingEntry.count : 0,
			lastChunkEntry
				? lastChunkEntry.startSampleIndex
				+ (sampleTable.chunkOffsets.length - lastChunkEntry.startChunkIndex) * lastChunkEntry.samplesPerChunk
				: 0,
		);

		capEntryCounts(sampleTable.sampleTimingEntries, sampleTable.sampleCount);
		capEntryCounts(sampleTable.sampleCompositionTimeOffsets, sampleTable.sampleCount);

		const isPcmCodec = internalTrack.info?.type === 'audio'
			&& internalTrack.info.codec
			&& (PCM_AUDIO_CODECS as readonly string[]).includes(internalTrack.info.codec);

		if (
			isPcmCodec
			&& sampleTable.sampleCompositionTimeOffsets.length === 0
			&& sampleTable.sampleTimingEntries.length > 0
		) {
			// If the audio has PCM samples, the way the samples are defined in the sample table is somewhat
			// suboptimal: Each individual audio sample is its own sample, meaning we can have 48000 samples per second.
			// Because we treat each sample as its own atomic unit that can be decoded, this would lead to a huge
			// amount of very short samples for PCM audio. So instead, we make a transformation: If the audio is in PCM,
			// we say that each chunk (that normally holds many samples) now is one big sample. We can this because
			// the samples in the chunk are contiguous and the format is PCM, so the entire chunk as one thing still
			// encodes valid audio information.

			assert(internalTrack.info?.type === 'audio');
			const pcmInfo = parsePcmCodec(internalTrack.info.codec as PcmAudioCodec);

			const newSampleTimingEntries: SampleTimingEntry[] = [];
			const newSampleSizes: number[] = [];

			for (let i = 0; i < sampleTable.sampleToChunk.length; i++) {
				const chunkEntry = sampleTable.sampleToChunk[i]!;
				const nextEntry = sampleTable.sampleToChunk[i + 1];
				const chunkCount = Math.min(
					nextEntry ? nextEntry.startChunkIndex : Infinity,
					sampleTable.chunkOffsets.length,
				) - chunkEntry.startChunkIndex;
				const newStartSampleIndex = newSampleSizes.length;

				for (let j = 0; j < chunkCount; j++) {
					const startSampleIndex = chunkEntry.startSampleIndex + j * chunkEntry.samplesPerChunk;
					const endSampleIndex = startSampleIndex + chunkEntry.samplesPerChunk; // Exclusive, outside of chunk

					const startTimingEntryIndex = binarySearchLessOrEqual(
						sampleTable.sampleTimingEntries,
						startSampleIndex,
						x => x.startIndex,
					);
					const startTimingEntry = sampleTable.sampleTimingEntries[startTimingEntryIndex]!;
					const endTimingEntryIndex = binarySearchLessOrEqual(
						sampleTable.sampleTimingEntries,
						endSampleIndex,
						x => x.startIndex,
					);
					const endTimingEntry = sampleTable.sampleTimingEntries[endTimingEntryIndex]!;

					const firstSampleTimestamp = startTimingEntry.startDecodeTimestamp
						+ (startSampleIndex - startTimingEntry.startIndex) * startTimingEntry.delta;
					const lastSampleTimestamp = endTimingEntry.startDecodeTimestamp
						+ (endSampleIndex - endTimingEntry.startIndex) * endTimingEntry.delta;
					const delta = lastSampleTimestamp - firstSampleTimestamp;

					const lastSampleTimingEntry = last(newSampleTimingEntries);
					if (lastSampleTimingEntry && lastSampleTimingEntry.delta === delta) {
						lastSampleTimingEntry.count++;
					} else {
						// One sample for the entire chunk
						newSampleTimingEntries.push({
							startIndex: newSampleSizes.length,
							startDecodeTimestamp: firstSampleTimestamp,
							count: 1,
							delta,
						});
					}

					// Instead of determining the chunk's size by looping over the samples sizes in the sample table, we
					// can directly compute it as we know how many PCM frames are in this chunk, and the size of each
					// PCM frame. This also improves compatibility with some files which fail to write proper sample
					// size values into their sample tables in the PCM case.
					const chunkSize = chunkEntry.samplesPerChunk
						* pcmInfo.sampleSize
						* internalTrack.info.numberOfChannels;

					newSampleSizes.push(chunkSize);
				}

				// The new samples are numbered consecutively, even if the chunks don't start at the first one
				chunkEntry.startSampleIndex = newStartSampleIndex;
				chunkEntry.samplesPerChunk = 1;
			}

			sampleTable.sampleTimingEntries = newSampleTimingEntries;
			sampleTable.sampleSizes = newSampleSizes;
			sampleTable.sampleCount = newSampleSizes.length;
		} else if (
			internalTrack.info?.type === 'audio'
			&& internalTrack.info.soundPacketLayout
			&& sampleTable.sampleCompositionTimeOffsets.length === 0
			&& sampleTable.sampleTimingEntries.length > 0
			&& sampleTable.sampleTimingEntries.every(x => x.delta === 1)
			&& sampleTable.sampleSizes.length === 1
		) {
			// Old QuickTime files store some compressed audio (like MP3) the way they store PCM: the sample table
			// counts decoded samples, each one byte "large", and the sound sample description tells how many decoded
			// samples and bytes make up one compressed packet. Like FFmpeg, turn every packet into a sample.
			let { samplesPerPacket, bytesPerFrame } = internalTrack.info.soundPacketLayout;

			if (internalTrack.info.codec === 'mp3') {
				// Packets can hold several MP3 frames, which are of the same size in such constant-bitrate files.
				// Layer II frames always hold 1152 samples, Layer III ones 576 at the MPEG-2 and 2.5 sample rates.
				const isLayer2 = internalTrack.internalCodecId === '.mp2';
				const frameSamples = isLayer2 || internalTrack.info.sampleRate >= 32000 ? 1152 : 576;
				const framesPerPacket = samplesPerPacket / frameSamples;
				if (Number.isInteger(framesPerPacket) && framesPerPacket > 1 && bytesPerFrame % framesPerPacket === 0) {
					samplesPerPacket = frameSamples;
					bytesPerFrame /= framesPerPacket;
				}
			}

			// Chunks must hold whole packets; FFmpeg rejects them otherwise too
			if (sampleTable.sampleToChunk.every(x => x.samplesPerChunk % samplesPerPacket === 0)) {
				const newSampleTimingEntries: SampleTimingEntry[] = [];
				let newSampleCount = 0;

				for (let i = 0; i < sampleTable.sampleToChunk.length; i++) {
					const chunkEntry = sampleTable.sampleToChunk[i]!;
					const nextEntry = sampleTable.sampleToChunk[i + 1];
					const chunkCount = Math.min(
						nextEntry ? nextEntry.startChunkIndex : Infinity,
						sampleTable.chunkOffsets.length,
					) - chunkEntry.startChunkIndex;
					const packetsPerChunk = chunkEntry.samplesPerChunk / samplesPerPacket;
					const newStartSampleIndex = newSampleCount;

					for (let j = 0; j < chunkCount; j++) {
						const startSampleIndex = chunkEntry.startSampleIndex + j * chunkEntry.samplesPerChunk;
						if (startSampleIndex >= sampleTable.sampleCount) {
							break;
						}

						const timingEntry = sampleTable.sampleTimingEntries[binarySearchLessOrEqual(
							sampleTable.sampleTimingEntries,
							startSampleIndex,
							x => x.startIndex,
						)]!;
						const startTimestamp = timingEntry.startDecodeTimestamp
							+ (startSampleIndex - timingEntry.startIndex) * timingEntry.delta;

						const lastTimingEntry = last(newSampleTimingEntries);
						if (
							lastTimingEntry
							&& lastTimingEntry.startDecodeTimestamp + lastTimingEntry.count * samplesPerPacket
							=== startTimestamp
						) {
							lastTimingEntry.count += packetsPerChunk;
						} else {
							newSampleTimingEntries.push({
								startIndex: newSampleCount,
								startDecodeTimestamp: startTimestamp,
								count: packetsPerChunk,
								delta: samplesPerPacket,
							});
						}

						newSampleCount += packetsPerChunk;
					}

					chunkEntry.startSampleIndex = newStartSampleIndex;
					chunkEntry.samplesPerChunk = packetsPerChunk;
				}

				sampleTable.sampleTimingEntries = newSampleTimingEntries;
				sampleTable.sampleSizes = [bytesPerFrame];
				sampleTable.sampleCount = newSampleCount;
				sampleTable.keySampleIndices = null;
			}
		}

		// A file cut off in its media data (an interrupted download, say) still describes the samples it lost. Like
		// reading the packets one after the other, the track ends before the first sample whose data isn't there.
		const fileSize = this.reader.fileSizeNonStrict;
		if (fileSize !== null) {
			const sampleCount = countSamplesWithData(sampleTable, fileSize);
			if (sampleCount < sampleTable.sampleCount) {
				sampleTable.sampleCount = sampleCount;
				capEntryCounts(sampleTable.sampleTimingEntries, sampleCount);
				capEntryCounts(sampleTable.sampleCompositionTimeOffsets, sampleCount);

				const keySampleIndices = sampleTable.keySampleIndices;
				while (keySampleIndices && keySampleIndices.length > 0 && last(keySampleIndices)! >= sampleCount) {
					keySampleIndices.pop();
				}
			}
		}

		if (sampleTable.sampleCompositionTimeOffsets.length > 0) {
			// Presentation order differs from decode order. Let's prepare the offset entries for timestamped-keyed
			// random access later
			const entries = sampleTable.sampleCompositionTimeOffsets;
			const lastEntry = last(entries)!;
			const coveredSampleCount = lastEntry.startIndex + lastEntry.count;
			if (coveredSampleCount < sampleTable.sampleCount) {
				// The remaining samples have no offset
				entries.push({
					startIndex: coveredSampleCount,
					count: sampleTable.sampleCount - coveredSampleCount,
					offset: 0,
					startTimestamp: -1,
					lastTimestamp: -1,
					maxLastTimestamp: -1,
				});
			}

			const sortedEntries = entries.filter(entry => entry.count > 0);

			const timingEntries = sampleTable.sampleTimingEntries;
			let timingEntryIndex = 0;
			const getDecodeTimestampAhead = (sampleIndex: number) => {
				while (
					timingEntryIndex + 1 < timingEntries.length
					&& timingEntries[timingEntryIndex + 1]!.startIndex <= sampleIndex
				) {
					timingEntryIndex++;
				}

				const timingEntry = timingEntries[timingEntryIndex]!;
				return timingEntry.startDecodeTimestamp + (sampleIndex - timingEntry.startIndex) * timingEntry.delta;
			};

			for (const entry of sortedEntries) {
				const lastSampleIndex = entry.startIndex + entry.count - 1;
				entry.startTimestamp = getDecodeTimestampAhead(entry.startIndex) + entry.offset;
				entry.lastTimestamp = getDecodeTimestampAhead(lastSampleIndex) + entry.offset;
			}

			sortedEntries.sort((a, b) => a.startTimestamp - b.startTimestamp || a.startIndex - b.startIndex);

			let maxLastTimestamp = -Infinity;
			for (const entry of sortedEntries) {
				maxLastTimestamp = Math.max(maxLastTimestamp, entry.lastTimestamp);
				entry.maxLastTimestamp = maxLastTimestamp;
			}

			sampleTable.sortedCompositionTimeOffsets = sortedEntries;
		} else {
			// If they're not defined, we can simply use the decode timestamps as presentation timestamps
		}

		if (sampleTable.sampleSizes.length > 1) {
			sampleTable.cumulativeSampleSizes = [0];

			for (let i = 0; i < sampleTable.sampleSizes.length; i++) {
				sampleTable.cumulativeSampleSizes.push(
					sampleTable.cumulativeSampleSizes[i]! + sampleTable.sampleSizes[i]!,
				);
			}
		}

		return sampleTable;
	}

	/** Reads the fragment at the given position for a lookup of the given track, which reads its fragments in order */
	async readFragment(startPos: number, track: InternalTrack): Promise<Fragment | null> {
		if (this.lastReadFragment?.moofOffset === startPos) {
			// It may have been read for another track, which can leave this track's samples unplaced (see below)
			this.placeFragment(this.lastReadFragment, track);
			return this.lastReadFragment;
		}

		let headerSlice = this.reader.requestSliceRange(startPos, MIN_BOX_HEADER_SIZE, MAX_BOX_HEADER_SIZE);
		if (isThenable(headerSlice)) headerSlice = await headerSlice;
		assert(headerSlice);

		const moofBoxInfo = readBoxHeader(headerSlice);
		assert(moofBoxInfo?.name === 'moof');

		let entireSlice = this.reader.requestSlice(startPos, moofBoxInfo.totalSize);
		if (isThenable(entireSlice)) entireSlice = await entireSlice;
		if (!entireSlice) return null; // The moof box is cut off

		this.parseSkippingDamagedBoxes(entireSlice, slice => this.traverseBox(slice));

		const fragment = this.lastReadFragment;
		assert(fragment && fragment.moofOffset === startPos);

		this.fragmentSummaries.set(startPos, {
			moofSize: fragment.moofSize,
			trackIds: new Set(fragment.trackData.keys()),
		});

		for (const [, trackData] of fragment.trackData) {
			// If senc wasn't parsed but saiz+saio were, fetch the aux info now and stamp each sample with it
			if (trackData.encryptionAuxInfo && trackData.track.encryptionInfo) {
				const entries = await resolveEncryptionAuxInfo(
					this.reader,
					trackData.track.encryptionInfo,
					trackData.encryptionAuxInfo,
					trackData.trunSampleCounts,
					i => trackData.samples[i]?.encryptionGroup ?? null,
				);

				for (let i = 0; i < Math.min(trackData.samples.length, entries.length); i++) {
					const entry = entries[i]!;
					trackData.samples[i]!.encryption = entry;
				}
			}
		}

		this.placeFragment(fragment, track);
		return fragment;
	}

	/** Reads a '----' ilst item, made of mean, name and data boxes. */
	readFreeformMetadataItem(slice: FileSlice, endPos: number) {
		let name: string | null = null;
		let value: string | null = null;

		while (endPos - slice.filePos >= MIN_BOX_HEADER_SIZE) {
			const startPos = slice.filePos;
			const boxInfo = readBoxHeader(slice);
			if (!boxInfo || startPos + boxInfo.totalSize > endPos) {
				break;
			}

			if (boxInfo.name === 'name' && boxInfo.contentSize >= 4) {
				slice.skip(4); // Version + flags
				name = textDecoder.decode(readBytes(slice, boxInfo.contentSize - 4));
			} else if (boxInfo.name === 'data') {
				slice.filePos = startPos;
				const data = readDataBox(slice);
				if (typeof data === 'string') {
					value = data;
				}
			}

			slice.filePos = startPos + boxInfo.totalSize;
		}

		if (name === 'iTunSMPB' && value !== null) {
			// Hex fields: reserved, encoder delay, end padding, sample count (FFmpeg's ff_itunes_parse_smpb)
			const match = /^\s*[0-9a-fA-F]{1,16}\s+([0-9a-fA-F]{1,16})\s+[0-9a-fA-F]{1,16}\s+[0-9a-fA-F]{1,16}\b/
				.exec(value);
			const priming = match ? Number.parseInt(match[1]!, 16) : 0;

			if (priming > 0 && priming < 16384) { // The plausible range used by FFmpeg
				this.iTunesPriming ??= priming;
			}
		}
	}

	/** Places the samples of a fragment read for a lookup of the given track and moves `fragmentsWalkedUpTo` past it */
	private placeFragment(fragment: Fragment, track: InternalTrack) {
		for (const [, trackData] of fragment.trackData) {
			// A lookup for the track reads its fragments in order. For the other tracks, this fragment may come after
			// fragments of theirs that weren't read yet.
			this.placeFragmentTrackData(fragment, trackData, trackData.track === track);
		}

		this.passTopLevelBox(fragment.moofOffset, fragment.moofOffset + fragment.moofSize);
	}

	/** Moves `fragmentsWalkedUpTo` past a top-level box that a lookup went past */
	passTopLevelBox(start: number, end: number) {
		if (this.fragmentsWalkedUpTo >= start && this.fragmentsWalkedUpTo < end) {
			this.fragmentsWalkedUpTo = end;
		}
	}

	/**
	 * Settles the start timestamp of a track's samples in a fragment if it isn't final yet, and remembers where the
	 * fragment is. When a fragment doesn't say when its samples begin, that's where the track's previous fragment
	 * ended. That's only known once all of the track's fragments before it have been placed: when a lookup for the
	 * track reads them in order, or when lookups have gone past every top-level box before the fragment and none of
	 * the track's samples there is unplaced. Otherwise, the samples stay unplaced (unless a lookup entry places them)
	 * until then.
	 */
	placeFragmentTrackData(fragment: Fragment, trackData: FragmentTrackData, readInOrder: boolean) {
		const track = trackData.track;
		const { fragmentPositionCache } = track;
		// If so, the track's last remembered fragment before this one is the one right before it
		const previousFragmentsArePlaced = readInOrder || (
			this.fragmentsWalkedUpTo >= fragment.moofOffset
			&& (track.unplacedFragmentOffsets[0] ?? Infinity) > fragment.moofOffset
		);

		if (!trackData.startTimestampIsFinal) {
			// It may be that some tracks don't define the base decode time, i.e. when the fragment begins. This
			// we'll need to figure out the start timestamp another way. We'll compute the timestamp by accessing
			// the lookup entries and fragment cache, which works out nicely with the lookup algorithm: If these
			// exist, then the lookup will automatically start at the furthest possible point. If they don't, the
			// lookup starts sequentially from the start, incrementally summing up all fragment durations. It's sort
			// of implicit, but it ends up working nicely.

			// The table is sorted by timestamp, which for any sane file means it's also sorted by offset
			const lookupEntryIndex = binarySearchExact(
				track.fragmentLookupTable,
				fragment.moofOffset,
				x => x.moofOffset,
			);
			const lookupEntry = track.fragmentLookupTable[lookupEntryIndex];
			const lookupEntryIsValid = lookupEntry
				&& trackData.trunSampleCounts.length >= lookupEntry.trunNumber
				&& trackData.trunSampleCounts[lookupEntry.trunNumber - 1]! >= lookupEntry.sampleNumber;
			const placedIndex = binarySearchExact(track.fragmentDecodeEnds, fragment.moofOffset, x => x.moofOffset);

			if (lookupEntryIsValid) {
				// We ignore traf number here, since we've already matched based on track ID

				let sampleIndex = 0;
				for (let i = 1; i < lookupEntry.trunNumber; i++) {
					sampleIndex += trackData.trunSampleCounts[i - 1]!;
				}

				sampleIndex += lookupEntry.sampleNumber - 1;
				const sample = trackData.samples[sampleIndex];
				assert(sample); // Must hold due to the above range checks

				// The timestamp in the lookup entry describes the timestamp of the referenced sample
				const timestampOffset = lookupEntry.timestamp - sample.presentationTimestamp;
				offsetFragmentTrackDataByTimestamp(trackData, timestampOffset);
			} else if (placedIndex !== -1) {
				// We've placed it before
				offsetFragmentTrackDataByTimestamp(
					trackData,
					track.fragmentDecodeEnds[placedIndex]!.endDecodeTimestamp - trackData.currentTimestamp,
				);
			} else if (previousFragmentsArePlaced) {
				const previousIndex = binarySearchLessOrEqual(
					track.fragmentDecodeEnds,
					fragment.moofOffset - 1,
					x => x.moofOffset,
				);
				if (previousIndex !== -1) {
					// Let's continue decoding where the previous fragment left off
					offsetFragmentTrackDataByTimestamp(
						trackData,
						track.fragmentDecodeEnds[previousIndex]!.endDecodeTimestamp,
					);
				} else {
					// We're the first fragment, so we continue where the samples in the moov box end (which is at
					// 0 if there are none)
					let lastTimingEntry: SampleTimingEntry | undefined;
					try {
						lastTimingEntry = last(this.getSampleTableForTrack(track).sampleTimingEntries);
					} catch {
						// A sample table that can't be read (a damaged file) leaves the fragment at 0, as before
					}
					if (lastTimingEntry) {
						const { startDecodeTimestamp, count, delta } = lastTimingEntry;
						offsetFragmentTrackDataByTimestamp(trackData, startDecodeTimestamp + count * delta);
					}
				}
			} else {
				// The track's previous fragment may not have been read yet
				insertSorted(track.unplacedFragmentOffsets, fragment.moofOffset);
				return;
			}

			trackData.startTimestampIsFinal = true;
		}

		if (getMaxReorderedSamples(track) > 0 && !track.fragmentPresentations?.has(fragment.moofOffset)) {
			let minSyncTimestamp = Infinity;
			for (const sample of trackData.samples) {
				if (sample.isKeyFrame) {
					minSyncTimestamp = Math.min(minSyncTimestamp, sample.presentationTimestamp);
				}
			}

			track.fragmentPresentations ??= new Map();
			track.fragmentPresentations.set(fragment.moofOffset, {
				moofSize: fragment.moofSize,
				timestamps: trackData.presentationTimestamps.map(x => x.presentationTimestamp),
				minSyncTimestamp,
				durations: new Map(),
			});

			const offsets = track.fragmentPresentationOffsets ??= [];
			const offsetIndex = binarySearchLessOrEqual(offsets, fragment.moofOffset, x => x) + 1;
			offsets.splice(offsetIndex, 0, fragment.moofOffset);
		}

		// Let's remember that a fragment with a given timestamp is here, speeding up future lookups if no
		// lookup table exists
		const insertionIndex = binarySearchLessOrEqual(
			fragmentPositionCache,
			trackData.startTimestamp,
			x => x.startTimestamp,
		);
		const previousEntry = fragmentPositionCache[insertionIndex];
		const nextEntry = fragmentPositionCache[insertionIndex + 1];

		// Only remember it if the timestamp order matches the moof offset order
		if (
			(!previousEntry || previousEntry.moofOffset < fragment.moofOffset)
			&& (!nextEntry || nextEntry.moofOffset > fragment.moofOffset)
		) {
			fragmentPositionCache.splice(insertionIndex + 1, 0, {
				moofOffset: fragment.moofOffset,
				startTimestamp: trackData.startTimestamp,
				endDecodeTimestamp: trackData.currentTimestamp,
				hasKeyFrame: trackData.firstKeyFrameTimestamp !== null,
			});
		}

		// Fragments without tfdt continue from here
		const decodeEndIndex = binarySearchLessOrEqual(
			track.fragmentDecodeEnds,
			fragment.moofOffset,
			x => x.moofOffset,
		);
		if (track.fragmentDecodeEnds[decodeEndIndex]?.moofOffset !== fragment.moofOffset) {
			track.fragmentDecodeEnds.splice(decodeEndIndex + 1, 0, {
				moofOffset: fragment.moofOffset,
				endDecodeTimestamp: trackData.currentTimestamp,
			});
		}

		const unplacedIndex = binarySearchExact(track.unplacedFragmentOffsets, fragment.moofOffset, x => x);
		if (unplacedIndex !== -1) {
			track.unplacedFragmentOffsets.splice(unplacedIndex, 1);
		}
	}

	readContiguousBoxes(slice: FileSlice) {
		if (this.boxNestingDepth === MAX_BOX_NESTING_DEPTH) {
			throw new Error('Invalid file: boxes are nested too deeply.');
		}

		const startIndex = slice.filePos;
		this.boxNestingDepth++;

		try {
			while (slice.filePos - startIndex <= slice.length - MIN_BOX_HEADER_SIZE) {
				const fileSize = this.reader.fileSizeNonStrict;
				if (this.moovIsCutOff && fileSize !== null) {
					const startPos = slice.filePos;
					const boxInfo = readBoxHeader(slice);
					slice.filePos = startPos;

					if (boxInfo && startPos + boxInfo.totalSize > fileSize) {
						// The file is cut off inside this box, so its content is incomplete. Like FFmpeg, keep the
						// boxes before it. (Within a complete moov box, a box past the end of the file only claims
						// too much.)
						break;
					}
				}

				const foundBox = this.traverseBox(slice);

				if (!foundBox) {
					break;
				}
			}
		} finally {
			this.boxNestingDepth--;
		}
	}

	/**
	 * Iterates over the metadata items of a udta or ilst box. An item that fails to parse mustn't leave the fields
	 * watched, and a loop that throws ends this iterator, which runs the finally.
	 */
	// eslint-disable-next-line @stylistic/generator-star-spacing
	*iterateMetadataItems(slice: FileSlice) {
		try {
			yield* this.iterateContiguousBoxes(slice);
		} finally {
			unwatchMetadataTagFields(this.metadataTags);
		}
	}

	// eslint-disable-next-line @stylistic/generator-star-spacing
	*iterateContiguousBoxes(slice: FileSlice) {
		const startIndex = slice.filePos;

		while (slice.filePos - startIndex <= slice.length - MIN_BOX_HEADER_SIZE) {
			const startPos = slice.filePos;
			const boxInfo = readBoxHeader(slice);
			if (!boxInfo) {
				break;
			}

			// Like FFmpeg, cut a box that claims to extend past its parent down to the parent's end, and hand out a
			// slice bounded to the box so that reading its contents can't run into the boxes after it
			const totalSize = Math.min(boxInfo.totalSize, slice.end - startPos);
			const boxSlice = slice.slice(startPos, totalSize);
			boxSlice.filePos = startPos + boxInfo.headerSize;

			yield {
				boxInfo: { ...boxInfo, totalSize, contentSize: Math.max(totalSize - boxInfo.headerSize, 0) },
				slice: boxSlice,
			};
			slice.filePos = startPos + totalSize;
		}
	}

	traverseBox(slice: FileSlice): boolean {
		const startPos = slice.filePos;
		if (this.damagedBoxPositions.size > 0 && this.damagedBoxPositions.has(startPos)) {
			// Found to be damaged in an earlier attempt (see parseSkippingDamagedBoxes), so skip it
			const size = slice.remainingLength >= MIN_BOX_HEADER_SIZE ? readU32Be(slice) : 0;
			if (size < MIN_BOX_HEADER_SIZE) {
				return false; // Nothing to skip to (size 0 runs to the end, size 1 is a 64-bit size)
			}

			slice.filePos = Math.min(startPos + size, slice.end);
			return true;
		}

		try {
			return this.parseBox(slice);
		} catch (error) {
			if (!(error instanceof SliceRangeError)) {
				throw error;
			}

			slice.filePos = startPos;
			const size = slice.remainingLength >= MIN_BOX_HEADER_SIZE ? readU32Be(slice) : 0;
			const name = size > 0 ? readAscii(slice, 4) : '';

			// Sample tables are read as a whole: a failure discards the partial table (see getSampleTableForTrack)
			const sampleTableBoxes = ['stbl', 'stts', 'ctts', 'stss', 'stsc', 'stsz', 'stz2', 'stco', 'co64'];
			if (sampleTableBoxes.includes(name)) {
				throw error;
			}

			// The box's fields run past its end and its parent's, so it's damaged (a broken size field, a cut-off
			// file). Rather than failing the whole file, have the parse redone without it, like FFmpeg skips atoms
			// it can't read.
			throw new DamagedBoxError(startPos);
		}
	}

	/**
	 * Runs a parse (of the moov, a fragment, ...) so that boxes whose fields run past the end of their parent are
	 * skipped: the parse is redone without such a box, from a snapshot of the state before it. That undoes everything
	 * the damaged box changed, at no cost to intact files.
	 */
	parseSkippingDamagedBoxes(slice: FileSlice, parse: (slice: FileSlice) => unknown) {
		const startPos = slice.filePos;
		const restoreState = this.snapshotParsingState();
		const damagedBoxPositions: number[] = [];

		while (true) {
			try {
				parse(slice);
				return;
			} catch (error) {
				if (!(error instanceof DamagedBoxError)) {
					throw error;
				}

				restoreState();
				if (damagedBoxPositions.length === MAX_DAMAGED_BOXES_PER_PARSE) {
					// Each one redoes the parse, so cap them (also keeping crafted files from taking quadratic time)
					throw new Error('Invalid MP4 file: too many damaged boxes.');
				}

				damagedBoxPositions.push(error.position);
				for (const position of damagedBoxPositions) {
					this.damagedBoxPositions.add(position); // The restore undid earlier additions
				}
				slice.filePos = startPos;
			}
		}
	}

	/** Remembers the fields a parse can change (the demuxer's, the current track's and fragment's) for undoing it. */
	snapshotParsingState() {
		const track = this.currentTrack;
		const fragment = this.currentFragment;
		const objects: object[] = [this];
		// The metadata tags and the track also have their plain objects (like the raw tags or the track's disposition)
		// covered, as boxes change some of those in place
		const withPlainObjects: Record<string, unknown>[] = [this.metadataTags];
		if (track) {
			withPlainObjects.push(track);
			if (track.info) {
				withPlainObjects.push(track.info);
			}
		}
		for (const object of withPlainObjects) {
			objects.push(object);
			for (const key in object) {
				const value = object[key];
				if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
					&& value !== track?.info) {
					objects.push(value);
				}
			}
		}
		if (fragment) {
			objects.push(fragment);
			const trackData = track && fragment.trackData.get(track.id);
			if (trackData) {
				objects.push(trackData);
			}
		}

		// Flat list of [object, its keys, its values, then collection and length pairs] per object
		const snapshots: unknown[][] = [];
		for (const object of objects as Record<string, unknown>[]) {
			const keys = Object.keys(object);
			const values: unknown[] = [];
			const snapshot: unknown[] = [object, keys, values];
			for (const key of keys) {
				const value = object[key];
				values.push(value);
				if (Array.isArray(value)) {
					snapshot.push(value, value.length);
				} else if (value instanceof Map || value instanceof Set) {
					snapshot.push(value, value.size);
				}
			}
			snapshots.push(snapshot);
		}

		return () => {
			for (const snapshot of snapshots) {
				const object = snapshot[0] as Record<string, unknown>;
				const keys = snapshot[1] as string[];
				const values = snapshot[2] as unknown[];
				for (const key of Object.keys(object)) {
					if (!keys.includes(key)) {
						delete object[key];
					}
				}
				for (let i = 0; i < keys.length; i++) {
					object[keys[i]!] = values[i];
				}
				for (let i = 3; i < snapshot.length; i += 2) {
					const collection = snapshot[i] as unknown[] | Map<unknown, unknown> | Set<unknown>;
					const length = snapshot[i + 1] as number;
					if (Array.isArray(collection)) {
						collection.length = length;
					} else {
						// Entries keep insertion order, so the ones added since come last
						for (const key of [...collection.keys()].slice(length)) {
							collection.delete(key);
						}
					}
				}
			}
		};
	}

	parseBox(slice: FileSlice): boolean {
		const startPos = slice.filePos;
		const boxInfo = readBoxHeader(slice);
		if (!boxInfo) {
			return false;
		}

		const contentStartPos = slice.filePos;

		if (startPos + boxInfo.totalSize > slice.end) {
			// Like FFmpeg (mov_read_default), cut a box that claims to extend past its parent down to the parent's end
			boxInfo.totalSize = slice.end - startPos;
			boxInfo.contentSize = Math.max(slice.end - contentStartPos, 0);
		}

		const boxEndPos = startPos + boxInfo.totalSize;

		if (boxInfo.contentSize < (MIN_BOX_CONTENT_SIZES[boxInfo.name] ?? 0)) {
			// Too small for its fixed fields (e.g. empty); skip it rather than reading past it, like FFmpeg
			slice.filePos = boxEndPos;
			return true;
		}

		switch (boxInfo.name) {
			case 'mdia': {
				const mdiaSlice = slice.slice(contentStartPos, boxInfo.contentSize);

				// The handler type decides how the sample descriptions in minf are read, but ISO/IEC 14496-12 doesn't
				// require hdlr to come before minf (some MPEG-4 Systems encoders put it last), so read it first
				while (mdiaSlice.remainingLength >= MIN_BOX_HEADER_SIZE) {
					const childStartPos = mdiaSlice.filePos;
					const childInfo = readBoxHeader(mdiaSlice);
					if (!childInfo) {
						break;
					}

					if (childInfo.name === 'hdlr') {
						mdiaSlice.filePos = childStartPos;
						this.traverseBox(mdiaSlice);
						break;
					}

					mdiaSlice.filePos = childStartPos + childInfo.totalSize;
				}

				mdiaSlice.filePos = contentStartPos;
				this.readContiguousBoxes(mdiaSlice);
			}; break;

			case 'minf':
			case 'dinf':
			case 'mfra':
			case 'edts':
			case 'sinf':
			case 'schi': {
				this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
			}; break;

			case 'mvhd': {
				const isFirstMovieHeader = this.movieTimescale === -1;
				const version = readU8(slice);
				slice.skip(3); // Flags

				let creationTime: number;
				if (version === 1) {
					creationTime = readU64Be(slice);
					slice.skip(8); // Modification time
					this.movieTimescale = readU32Be(slice);
					this.movieDurationInTimescale = readU64Be(slice);
				} else {
					creationTime = readU32Be(slice);
					slice.skip(4); // Modification time
					this.movieTimescale = readU32Be(slice);
					this.movieDurationInTimescale = readU32Be(slice);
				}

				if (creationTime !== 0) {
					this.metadataTags.creationTime = new Date(1000 * (creationTime - TIMESTAMP_OFFSET));
				} else {
					// Assume this means the creation time isn't set (I doubt the file was created in 1904)
				}

				if (this.movieTimescale === 0) {
					throw new Error('Invalid mvhd box: timescale must not be 0.');
				}

				slice.skip(4 + 2 + 2 + 2 * 4); // Rate, volume, reserved
				this.movieMatrix = readMatrix(slice);

				if (isFirstMovieHeader) {
					// The children of moov may come in any order (QuickTime File Format), so tracks may precede the
					// mvhd box. Their matrices were composed with the identity matrix the movie matrix starts as.
					for (const track of this.tracks) {
						track.matrix = multiplyMatrices(track.matrix, this.movieMatrix);
					}
				}
			}; break;

			case 'trak': {
				if (this.currentFragment || this.currentTrack) {
					break; // Misplaced
				}

				const track = {
					id: -1,
					demuxer: this,
					trackBacking: null,
					disposition: {
						...DEFAULT_TRACK_DISPOSITION,
						primary: false,
					},
					info: null,
					timescale: -1,
					durationInMovieTimescale: -1,
					durationInMediaTimescale: -1,
					matrix: IDENTITY_MATRIX,
					internalCodecId: null,
					name: null,
					languageCode: UNDETERMINED_LANGUAGE,
					sampleTableByteOffset: -1,
					sampleTable: null,
					encryptionInfos: [],
					fragmentLookupTable: [],
					fragmentDecodeEnds: [],
					currentFragmentState: null,
					fragmentPositionCache: [],
					nextFragmentOffsets: new Map(),
					unplacedFragmentOffsets: [],
					editListPreviousSegmentDurations: 0,
					editListOffset: 0,
					hasEditList: false,
					encryptionInfo: null,
					sampleDescriptionStates: [],
					firstChunkSampleDescriptionIndex: null,
					encryptionGroups: [],
					defaultEncryptionGroup: null,
					encryptionGroupRuns: [],
					sampleDescriptionRecords: [],
					encryptionAuxInfo: null,
					frmaCodecString: null,
					encryptedSampleDescriptions: [],
					maxBitrate: null,
					avgBitrate: null,
				} satisfies InternalTrack as InternalTrack;
				this.currentTrack = track;

				this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));

				if (
					track.id !== -1
					&& track.timescale !== -1
					&& track.info !== null
					&& track.sampleTableByteOffset !== -1
				) {
					if (track.info.type === 'video' && track.info.width !== -1) {
						const videoTrack = track as InternalVideoTrack;
						track.trackBacking = new IsobmffVideoTrackBacking(videoTrack);
						this.tracks.push(track);
						this.idToTrack.set(track.id, track);
					} else if (track.info.type === 'audio' && track.info.numberOfChannels !== -1) {
						const audioTrack = track as InternalAudioTrack;
						track.trackBacking = new IsobmffAudioTrackBacking(audioTrack);
						this.tracks.push(track);
						this.idToTrack.set(track.id, track);
					}
				}

				this.currentTrack = null;
			}; break;

			case 'tkhd': {
				const track = this.currentTrack;
				if (!track || this.currentFragment) {
					break;
				}

				const version = readU8(slice);
				const flags = readU24Be(slice);

				// Spec says disabled tracks are to be treated like they don't exist, but in practice, they are treated
				// more like non-default tracks.
				const trackEnabled = !!(flags & 0x1);
				track.disposition.default = trackEnabled;

				// Skip over creation & modification time to reach the track ID
				if (version === 0) {
					slice.skip(8);
					track.id = readU32Be(slice);
					slice.skip(4);
					track.durationInMovieTimescale = readU32Be(slice);
				} else if (version === 1) {
					slice.skip(16);
					track.id = readU32Be(slice);
					slice.skip(4);
					track.durationInMovieTimescale = readU64Be(slice);
				} else {
					throw new Error(`Incorrect track header version ${version}.`);
				}

				slice.skip(2 * 4 + 2 + 2 + 2 + 2);
				const trackMatrix = readMatrix(slice);

				// The track matrix maps into movie space, and the movie matrix then maps into the final output space
				track.matrix = multiplyMatrices(trackMatrix, this.movieMatrix);
			}; break;

			case 'elst': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				const version = readU8(slice);
				slice.skip(3); // Flags

				track.hasEditList = true;
				let relevantEntryFound = false;
				let previousSegmentDurations = 0;

				const entryCount = capEntryCount(readU32Be(slice), slice, boxEndPos, version === 1 ? 20 : 12);
				for (let i = 0; i < entryCount; i++) {
					const segmentDuration = version === 1
						? readU64Be(slice)
						: readU32Be(slice);
					const mediaTime = version === 1
						? readI64Be(slice)
						: readI32Be(slice);
					const mediaRate = readFixed_16_16(slice);

					if (relevantEntryFound) {
						Logging._warn(
							'Unsupported edit list: multiple edits are not currently supported. Only using first edit.',
						);
						break;
					}

					if (mediaTime === -1) {
						previousSegmentDurations += segmentDuration;
						continue;
					}

					if (mediaRate !== 1) {
						Logging._warn('Unsupported edit list entry: media rate must be 1.');
						break;
					}

					track.editListPreviousSegmentDurations = previousSegmentDurations;
					track.editListOffset = mediaTime;
					relevantEntryFound = true;
				}
			}; break;

			case 'mdhd': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				const version = readU8(slice);
				slice.skip(3); // Flags

				if (version === 0) {
					slice.skip(8);
					track.timescale = readU32Be(slice);
					track.durationInMediaTimescale = readU32Be(slice);
				} else if (version === 1) {
					slice.skip(16);
					track.timescale = readU32Be(slice);
					track.durationInMediaTimescale = readU64Be(slice);
				}

				if (track.timescale === 0) {
					throw new Error('Invalid mdhd box: timescale must not be 0.');
				}

				let language = readU16Be(slice);

				if (language < 0x400) {
					// Not a packed ISO 639-2/T code (whose first letter makes it at least 0x400), but in QuickTime
					// files, one of the Macintosh language codes, 0 being English
					if (this.isQuickTime) {
						const languageCode = language < 128
							? MACINTOSH_LANGUAGE_CODES[language]
							: MACINTOSH_LANGUAGE_CODES_FROM_128[language - 128];
						track.languageCode = languageCode || UNDETERMINED_LANGUAGE;
					}
				} else {
					track.languageCode = '';

					for (let i = 0; i < 3; i++) {
						track.languageCode = String.fromCharCode(0x60 + (language & 0b11111)) + track.languageCode;
						language >>= 5;
					}

					if (!isIso639Dash2LanguageCode(track.languageCode)) {
						// Sometimes the bytes are garbage
						track.languageCode = UNDETERMINED_LANGUAGE;
					}

					// The code is meant to be the terminology one, but some writers (FFmpeg, when given one) store the
					// bibliographic one, like "ger" for "deu"
					track.languageCode = fromMatroskaLanguageCode(track.languageCode);
				}
			}; break;

			case 'hdlr': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				slice.skip(8); // Version + flags + pre-defined
				const handlerType = readAscii(slice, 4);

				// The media handler is read ahead of the other boxes in mdia, so it may have been read already
				if (handlerType === 'vide') {
					track.info ??= {
						type: 'video',
						width: -1,
						height: -1,
						squarePixelWidth: -1,
						squarePixelHeight: -1,
						hasPixelAspectRatioBox: false,
						pixelAspectRatio: { num: 1, den: 1 },
						codec: null,
						codecDescription: null,
						colorSpace: { ...EMPTY_COLOR_SPACE },
						avcType: null,
						hevcType: null,
						avcCodecInfo: null,
						hevcCodecInfo: null,
						vp9CodecInfo: null,
						av1CodecInfo: null,
						proresCodecInfo: null,
						proresFormat: null,
					};
				} else if (handlerType === 'soun') {
					track.info ??= {
						type: 'audio',
						numberOfChannels: -1,
						sampleRate: -1,
						codec: null,
						codecDescription: null,
						aacCodecInfo: null,
						dtsFormat: null,
						pcmLittleEndian: false,
						pcmSampleSize: null,
						soundPacketLayout: null,
					};
				}
			}; break;

			case 'stbl': {
				const track = this.currentTrack;
				if (!track || this.currentFragment) {
					break; // Sample tables don't belong in fragments
				}

				track.sampleTableByteOffset = startPos;

				this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
			}; break;

			case 'stsd': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (track.info === null || track.sampleTable) {
					break;
				}

				const stsdVersion = readU8(slice);
				slice.skip(3); // Flags

				const entries = readU32Be(slice);

				for (let i = 0; i < entries; i++) {
					const sampleBoxStartPos = slice.filePos;
					const sampleBoxInfo = readBoxHeader(slice);
					if (!sampleBoxInfo) {
						break;
					}

					// Each sample description can have its own encryption info (sinf), with its own key ID. The
					// track's is the last one's, as before.
					const previousEncryptionInfo = track.encryptionInfo;
					track.encryptionInfo = null;

					track.internalCodecId = sampleBoxInfo.name;
					const lowercaseBoxName = sampleBoxInfo.name.toLowerCase();
					track.encryptedSampleDescriptions.push(lowercaseBoxName === 'encv' || lowercaseBoxName === 'enca');

					if (track.info.type === 'video') {
						slice.skip(6 * 1 + 2 + 2 + 2 + 3 * 4);

						track.info.width = readU16Be(slice);
						track.info.height = readU16Be(slice);
						track.info.squarePixelWidth = track.info.width;
						track.info.squarePixelHeight = track.info.height;
						track.info.hasPixelAspectRatioBox = false;
						track.info.pixelAspectRatio = { num: 1, den: 1 };

						slice.skip(4 + 4 + 4 + 2 + 32 + 2 + 2);

						track.frmaCodecString = null;
						const descriptionBefore = track.info.codecDescription;
						this.readContiguousBoxes(
							slice.slice(
								slice.filePos,
								(sampleBoxStartPos + sampleBoxInfo.totalSize) - slice.filePos,
							),
						);
						track.sampleDescriptionRecords[i] = track.info.codecDescription !== descriptionBefore
							? track.info.codecDescription
							: null;

						const codecName = lowercaseBoxName === 'encv'
							? track.frmaCodecString
							: lowercaseBoxName;
						track.frmaCodecString = null;

						if (codecName === 'avc1' || codecName === 'avc3') {
							track.info.codec = 'avc';
							track.info.avcType = codecName === 'avc1' ? 1 : 3;
						} else if (codecName === 'hvc1' || codecName === 'hev1') {
							track.info.codec = 'hevc';
							track.info.hevcType = codecName;
						} else if (codecName === 'vp08') {
							track.info.codec = 'vp8';
						} else if (codecName === 'vp09') {
							track.info.codec = 'vp9';
						} else if (codecName === 'av01') {
							track.info.codec = 'av1';
						} else if ((PRORES_FOURCCS as readonly string[]).includes(lowercaseBoxName)) {
							track.info.codec = 'prores';
							track.info.proresFormat = lowercaseBoxName as ProresFourCc;
						} else if (codecName === null) {
							Logging._warn(`Unknown encrypted video codec due to missing frma box.`);
						} else {
							Logging._warn(`Unsupported video codec (sample entry type '${sampleBoxInfo.name}').`);
						}
					} else {
						slice.skip(6 * 1 + 2);

						const version = readU16Be(slice);
						slice.skip(3 * 2);

						let channelCount = readU16Be(slice);
						let sampleSize = readU16Be(slice);

						slice.skip(2 * 2);

						// Can't use fixed16_16 as that's signed
						let sampleRate = readU32Be(slice) / 0x10000;
						let lpcmFlags: number | null = null;

						if (stsdVersion === 0 && version > 0) {
							// Additional QuickTime fields
							if (version === 1) {
								const samplesPerPacket = readU32Be(slice);
								sampleSize = 8 * readU32Be(slice); // Bytes per packet (per channel)
								const bytesPerFrame = readU32Be(slice); // Bytes per packet (all channels)
								slice.skip(4); // Bytes per sample

								track.info.soundPacketLayout = samplesPerPacket > 0 && bytesPerFrame > 0
									? { samplesPerPacket, bytesPerFrame }
									: null;
							} else if (version === 2) {
								slice.skip(4);
								sampleRate = readF64Be(slice);
								channelCount = readU32Be(slice);
								slice.skip(4); // Always 0x7f000000

								sampleSize = readU32Be(slice);

								lpcmFlags = readU32Be(slice);

								slice.skip(2 * 4);
							}
						}

						track.info.numberOfChannels = channelCount;
						// A sample rate that doesn't fit is written as 0, making the media timescale our best guess
						track.info.sampleRate = sampleRate || track.timescale;

						track.frmaCodecString = null;
						this.readContiguousBoxes(
							slice.slice(
								slice.filePos,
								(sampleBoxStartPos + sampleBoxInfo.totalSize) - slice.filePos,
							),
						);

						const codecName = lowercaseBoxName === 'enca'
							? track.frmaCodecString
							: lowercaseBoxName;
						track.frmaCodecString = null;

						// developer.apple.com/documentation/quicktime-file-format/sound_sample_descriptions/
						if (codecName === 'mp4a') {
							// The codec is set by the esds box
						} else if (codecName === '.mp3' || codecName === 'ms\u0000u' || codecName === '.mp2') {
							// QuickTime's MP3 sample entries (kFullMPEGLay3Format and the older kMPEGLayer3Format),
							// and its MPEG-1/2 Layer II one, which FFmpeg writes for MP2. Like MPEG-1 audio in an esds
							// box, all of them are 'mp3'.
							track.info.codec = 'mp3';
						} else if (codecName === 'opus') {
							track.info.codec = 'opus';
							track.info.sampleRate = OPUS_SAMPLE_RATE; // Always the same
						} else if (codecName === 'flac') {
							track.info.codec = 'flac';
						} else if (codecName === 'ulaw') {
							track.info.codec = 'ulaw';
						} else if (codecName === 'alaw') {
							track.info.codec = 'alaw';
						} else if (codecName === 'ac-3') {
							track.info.codec = 'ac3';
						} else if (codecName === 'ec-3') {
							track.info.codec = 'eac3';
						} else if ((DTS_FOURCCS as readonly string[]).includes(codecName!)) {
							track.info.codec = 'dts';
							track.info.dtsFormat = codecName as DtsFourCc;
						} else if (codecName === 'mlpa') {
							track.info.codec = 'truehd';
						} else if (codecName === 'twos') {
							// Like FFmpeg, also accept 24 and 32-bit samples, which QuickTime would label in24/in32
							if (sampleSize === 8) {
								track.info.codec = 'pcm-s8';
							} else if (sampleSize === 16) {
								track.info.codec = track.info.pcmLittleEndian ? 'pcm-s16' : 'pcm-s16be';
							} else if (sampleSize === 24) {
								track.info.codec = track.info.pcmLittleEndian ? 'pcm-s24' : 'pcm-s24be';
							} else if (sampleSize === 32) {
								track.info.codec = track.info.pcmLittleEndian ? 'pcm-s32' : 'pcm-s32be';
							} else {
								Logging._warn(`Unsupported sample size ${sampleSize} for codec 'twos'.`);
								track.info.codec = null;
							}
						} else if (codecName === 'sowt') {
							if (sampleSize === 8) {
								track.info.codec = 'pcm-s8';
							} else if (sampleSize === 16) {
								track.info.codec = 'pcm-s16';
							} else if (sampleSize === 24) {
								track.info.codec = 'pcm-s24';
							} else if (sampleSize === 32) {
								track.info.codec = 'pcm-s32';
							} else {
								Logging._warn(`Unsupported sample size ${sampleSize} for codec 'sowt'.`);
								track.info.codec = null;
							}
						} else if (codecName === 'raw ') {
							// QuickTime defines 'raw ' as 8-bit, but like FFmpeg, read 16-bit samples as signed and
							// big-endian, unless an enda box says otherwise
							if (sampleSize === 16) {
								track.info.codec = track.info.pcmLittleEndian ? 'pcm-s16' : 'pcm-s16be';
							} else {
								track.info.codec = 'pcm-u8';
							}
						} else if (codecName === 'in24') {
							track.info.codec = track.info.pcmLittleEndian ? 'pcm-s24' : 'pcm-s24be';
						} else if (codecName === 'in32') {
							track.info.codec = track.info.pcmLittleEndian ? 'pcm-s32' : 'pcm-s32be';
						} else if (codecName === 'fl32') {
							track.info.codec = track.info.pcmLittleEndian ? 'pcm-f32' : 'pcm-f32be';
						} else if (codecName === 'fl64') {
							track.info.codec = track.info.pcmLittleEndian ? 'pcm-f64' : 'pcm-f64be';
						} else if (codecName === 'ipcm') {
							const pcmSampleSize = track.info.pcmSampleSize;

							if (track.info.pcmLittleEndian) {
								if (pcmSampleSize === 16) {
									track.info.codec = 'pcm-s16';
								} else if (pcmSampleSize === 24) {
									track.info.codec = 'pcm-s24';
								} else if (pcmSampleSize === 32) {
									track.info.codec = 'pcm-s32';
								} else {
									Logging._warn(`Invalid ipcm sample size ${pcmSampleSize}.`);
									track.info.codec = null;
								}
							} else {
								if (pcmSampleSize === 16) {
									track.info.codec = 'pcm-s16be';
								} else if (pcmSampleSize === 24) {
									track.info.codec = 'pcm-s24be';
								} else if (pcmSampleSize === 32) {
									track.info.codec = 'pcm-s32be';
								} else {
									Logging._warn(`Invalid ipcm sample size ${pcmSampleSize}.`);
									track.info.codec = null;
								}
							}
						} else if (codecName === 'fpcm') {
							const pcmSampleSize = track.info.pcmSampleSize;

							if (track.info.pcmLittleEndian) {
								if (pcmSampleSize === 32) {
									track.info.codec = 'pcm-f32';
								} else if (pcmSampleSize === 64) {
									track.info.codec = 'pcm-f64';
								} else {
									Logging._warn(`Invalid fpcm sample size ${pcmSampleSize}.`);
									track.info.codec = null;
								}
							} else {
								if (pcmSampleSize === 32) {
									track.info.codec = 'pcm-f32be';
								} else if (pcmSampleSize === 64) {
									track.info.codec = 'pcm-f64be';
								} else {
									Logging._warn(`Invalid fpcm sample size ${pcmSampleSize}.`);
									track.info.codec = null;
								}
							}
						} else if (codecName === 'lpcm' && lpcmFlags !== null) {
							const bytesPerSample = (sampleSize + 7) >> 3;
							const isFloat = Boolean(lpcmFlags & 1);
							const isBigEndian = Boolean(lpcmFlags & 2);
							const sFlags = lpcmFlags & 4 ? -1 : 0; // I guess it means "signed flags" or something?

							if (sampleSize > 0 && sampleSize <= 64) {
								if (isFloat) {
									if (sampleSize === 32) {
										track.info.codec = isBigEndian ? 'pcm-f32be' : 'pcm-f32';
									} else if (sampleSize === 64) {
										track.info.codec = isBigEndian ? 'pcm-f64be' : 'pcm-f64';
									}
								} else {
									if (sFlags & (1 << (bytesPerSample - 1))) {
										if (bytesPerSample === 1) {
											track.info.codec = 'pcm-s8';
										} else if (bytesPerSample === 2) {
											track.info.codec = isBigEndian ? 'pcm-s16be' : 'pcm-s16';
										} else if (bytesPerSample === 3) {
											track.info.codec = isBigEndian ? 'pcm-s24be' : 'pcm-s24';
										} else if (bytesPerSample === 4) {
											track.info.codec = isBigEndian ? 'pcm-s32be' : 'pcm-s32';
										}
									} else {
										if (bytesPerSample === 1) {
											track.info.codec = 'pcm-u8';
										}
									}
								}
							}

							if (track.info.codec === null) {
								Logging._warn('Unsupported PCM format.');
							}
						} else if (codecName === null) {
							Logging._warn(`Unknown encrypted audio codec due to missing frma box.`);
						} else {
							Logging._warn(`Unsupported audio codec (sample entry type '${sampleBoxInfo.name}').`);
						}

						if (track.info.numberOfChannels === 0 && track.info.codec !== null) {
							Logging._warn('Invalid audio sample entry: channel count must not be 0.');
							track.info.codec = null;
						}
					}

					track.encryptionInfos.push(track.encryptionInfo);
					track.encryptionInfo ??= previousEncryptionInfo;

					slice.filePos = sampleBoxStartPos + sampleBoxInfo.totalSize;

					// Every description is read for what applies to the whole track (like the encryption info of a
					// clear lead's copy), but the codec info comes from the one the samples use; see
					// applyReferencedSampleDescriptions
					track.sampleDescriptionStates.push({
						info: { ...track.info },
						internalCodecId: track.internalCodecId,
						maxBitrate: track.maxBitrate,
						avgBitrate: track.avgBitrate,
					});
				}
			}; break;

			case 'frma': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				const format = readAscii(slice, 4);
				const lowercase = format.toLowerCase();

				// Tells us what codec the encrypted track actually uses
				track.frmaCodecString = lowercase;
			}; break;

			case 'schm': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				slice.skip(4); // Version + flags

				const schemeType = readAscii(slice, 4);
				if (schemeType === 'cenc' || schemeType === 'cens' || schemeType === 'cbcs') {
					track.encryptionInfo = {
						scheme: schemeType,
						defaultKid: null,
						defaultIsProtected: null,
						defaultPerSampleIvSize: null,
						defaultConstantIv: null,
						defaultCryptByteBlock: null,
						defaultSkipByteBlock: null,
					};
				} else {
					Logging._warn(`Unsupported encryption scheme '${schemeType}'.`);
				}
			}; break;

			case 'tenc': {
				const track = this.currentTrack;
				if (!track || !track.encryptionInfo) {
					break;
				}

				const version = readU8(slice);
				slice.skip(3); // Flags
				slice.skip(1); // Reserved

				const patternByte = readU8(slice);
				if (version > 0) {
					track.encryptionInfo.defaultCryptByteBlock = patternByte >> 4;
					track.encryptionInfo.defaultSkipByteBlock = patternByte & 0xf;
				} else {
					track.encryptionInfo.defaultCryptByteBlock = 0;
					track.encryptionInfo.defaultSkipByteBlock = 0;
				}

				track.encryptionInfo.defaultIsProtected = readU8(slice) !== 0;
				track.encryptionInfo.defaultPerSampleIvSize = readU8(slice);
				track.encryptionInfo.defaultKid = bytesToHexString(readBytes(slice, 16));

				if (track.encryptionInfo.defaultPerSampleIvSize > 16) {
					throw new Error('Invalid tenc box: IV size must not exceed 16 bytes.');
				}

				if (track.encryptionInfo.defaultIsProtected && track.encryptionInfo.defaultPerSampleIvSize === 0) {
					const constantIvSize = readU8(slice);
					if (constantIvSize > 16) {
						throw new Error('Invalid tenc box: IV size must not exceed 16 bytes.');
					}

					const constantIv = new Uint8Array(16);
					constantIv.set(readBytes(slice, constantIvSize), 0);
					track.encryptionInfo.defaultConstantIv = constantIv;
				}
			}; break;

			case 'avcC': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'video') {
					break;
				}

				if (boxInfo.contentSize === 0) {
					// avcC box is empty, let's treat this like an Annex B stream
					break;
				}

				track.info.codecDescription = readBytes(slice, boxInfo.contentSize);

				const sps = deserializeAvcDecoderConfigurationRecord(track.info.codecDescription)
					?.sequenceParameterSets[0];
				const spsInfo = sps && parseAvcSps(sps);
				if (spsInfo) {
					applySpsDimensions(track, spsInfo.displayWidth, spsInfo.displayHeight);
					applySpsPixelAspectRatio(track, spsInfo.pixelAspectRatio);
				}
			}; break;

			case 'hvcC': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'video') {
					break;
				}

				if (boxInfo.contentSize === 0) {
					// hvcC box is empty, let's treat this like an Annex B stream
					break;
				}

				track.info.codecDescription = readBytes(slice, boxInfo.contentSize);

				const sps = deserializeHevcDecoderConfigurationRecord(track.info.codecDescription)
					?.arrays.find(x => x.nalUnitType === HevcNalUnitType.SPS_NUT)?.nalUnits[0];
				const spsInfo = sps && parseHevcSps(sps);
				if (spsInfo) {
					applySpsDimensions(track, spsInfo.displayWidth, spsInfo.displayHeight);
					applySpsPixelAspectRatio(track, spsInfo.pixelAspectRatio);
				}
			}; break;

			case 'vpcC': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'video') {
					break;
				}

				const version = readU8(slice);
				if (version !== 1) {
					// Version 0 comes from an early draft of the spec with a different layout. Like FFmpeg, ignore it;
					// the codec info then comes from the first key frame instead.
					break;
				}

				slice.skip(3); // Flags

				const profile = readU8(slice);
				let level = readU8(slice);
				if (level === 0) {
					// Not a VP9 level, but Chrome's MediaRecorder writes it into MP4 recordings, and browsers reject
					// codec strings containing it. Derive the level from the dimensions, like when vpcC is missing.
					const pictureSize = track.info.width * track.info.height;
					const levelInfo = VP9_LEVEL_TABLE.find(x => pictureSize <= x.maxPictureSize);
					level = (levelInfo ?? last(VP9_LEVEL_TABLE)!).level;
				}

				const thirdByte = readU8(slice);
				const bitDepth = thirdByte >> 4;
				const chromaSubsampling = (thirdByte >> 1) & 0b111;
				const videoFullRangeFlag = thirdByte & 1;
				const colourPrimaries = readU8(slice);
				const transferCharacteristics = readU8(slice);
				const matrixCoefficients = readU8(slice);

				track.info.vp9CodecInfo = {
					profile,
					level,
					bitDepth,
					chromaSubsampling,
					videoFullRangeFlag,
					colourPrimaries,
					transferCharacteristics,
					matrixCoefficients,
				};
			}; break;

			case 'av1C': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'video') {
					break;
				}

				if (boxInfo.contentSize < 4) {
					// FFmpeg writes an empty av1C box when the encoder has no extradata yet (fragmented output), so
					// let's get the info from the sequence header in the first packet instead
					break;
				}

				slice.skip(1); // Marker + version

				const secondByte = readU8(slice);
				const profile = secondByte >> 5;
				const level = secondByte & 0b11111;

				const thirdByte = readU8(slice);
				const tier = thirdByte >> 7;
				const highBitDepth = (thirdByte >> 6) & 1;
				const twelveBit = (thirdByte >> 5) & 1;
				const monochrome = (thirdByte >> 4) & 1;
				const chromaSubsamplingX = (thirdByte >> 3) & 1;
				const chromaSubsamplingY = (thirdByte >> 2) & 1;
				const chromaSamplePosition = thirdByte & 0b11;

				// Logic from https://aomediacodec.github.io/av1-spec/av1-spec.pdf
				const bitDepth = profile === 2 && highBitDepth ? (twelveBit ? 12 : 10) : (highBitDepth ? 10 : 8);

				slice.skip(1); // Reserved bits + initial presentation delay

				// Parse config OBUs if there are any
				const configObus = readBytes(slice, boxInfo.contentSize - 4);
				const configObuInfo = extractAv1CodecInfoFromPacket(configObus);

				track.info.av1CodecInfo = {
					profile,
					level,
					tier,
					bitDepth,
					monochrome,
					chromaSubsamplingX,
					chromaSubsamplingY,
					chromaSamplePosition,
					videoFullRangeFlag: configObuInfo?.videoFullRangeFlag ?? 0,
					colourPrimaries: configObuInfo?.colourPrimaries ?? 2,
					transferCharacteristics: configObuInfo?.transferCharacteristics ?? 2,
					matrixCoefficients: configObuInfo?.matrixCoefficients ?? 2,
				};
			}; break;

			case 'colr': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'video') {
					break;
				}

				const colourType = readAscii(slice, 4);
				if (colourType !== 'nclx' && colourType !== 'nclc') {
					break;
				}
				if (boxInfo.contentSize < 10) {
					break;
				}

				const { colorSpace } = track.info;
				if (
					colorSpace.primaries !== undefined
					|| colorSpace.transfer !== undefined
					|| colorSpace.matrix !== undefined
					|| colorSpace.fullRange !== undefined
				) {
					// An earlier colr box already set the color space. Boxes are ordered from the most accurate to
					// the least (ISO/IEC 14496-12), and Chromium also reads the first one.
					break;
				}

				const colourPrimaries = readU16Be(slice);
				const transferCharacteristics = readU16Be(slice);
				const matrixCoefficients = readU16Be(slice);

				// Some files have nclx boxes without the full range byte (ExoPlayer has a sample of them); like
				// FFmpeg, the rest is still used
				let fullRange: boolean | undefined = undefined;
				if (colourType === 'nclx' && boxInfo.contentSize >= 11) {
					fullRange = Boolean(readU8(slice) & 0x80);
				}

				track.info.colorSpace = {
					primaries: COLOR_PRIMARIES_MAP_INVERSE[colourPrimaries],
					transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[transferCharacteristics],
					matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[matrixCoefficients],
					fullRange,
				} as VideoColorSpaceInit;
			}; break;

			case 'pasp': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'video') {
					break;
				}

				const num = readU32Be(slice);
				const den = readU32Be(slice);

				// https://github.com/Vanilagy/mediabunny/issues/362
				if (num > 0 && den > 0) {
					// The ratio may already be set by the SPS, but the pasp box wins (also over an SPS that comes after
					// it)
					track.info.squarePixelWidth = track.info.width;
					track.info.squarePixelHeight = track.info.height;
					track.info.hasPixelAspectRatioBox = true;
					track.info.pixelAspectRatio = simplifyRational({ num, den });

					if (num > den) {
						track.info.squarePixelWidth = Math.round(track.info.width * num / den);
					} else {
						track.info.squarePixelHeight = Math.round(track.info.height * den / num);
					}
				}
			}; break;

			case 'btrt': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				slice.skip(4); // Buffer size
				const maxBitrate = readU32Be(slice);
				const avgBitrate = readU32Be(slice);

				track.maxBitrate = maxBitrate > 0 ? maxBitrate : null;
				track.avgBitrate = avgBitrate > 0 ? avgBitrate : null;
			}; break;

			case 'wave': {
				this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
			}; break;

			case 'esds': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				slice.skip(4); // Version + flags

				const { objectTypeIndication, decoderSpecificInfo } = readEsDescriptor(slice);
				if (objectTypeIndication === 0x40 || objectTypeIndication === 0x67) {
					track.info.codec = 'aac';
					track.info.aacCodecInfo = {
						isMpeg2: objectTypeIndication === 0x67,
						objectType: null,
					};
				} else if (objectTypeIndication === 0x69 || objectTypeIndication === 0x6b) {
					track.info.codec = 'mp3';
				} else if (objectTypeIndication === 0xdd) {
					track.info.codec = 'vorbis'; // "nonstandard, gpac uses it" - FFmpeg
				} else if (objectTypeIndication === 0xa5) {
					track.info.codec = 'ac3'; // Registered at MP4RA, like the ones below; FFmpeg and Chromium read them
				} else if (objectTypeIndication === 0xa6) {
					track.info.codec = 'eac3';
				} else if (objectTypeIndication === 0xa9) {
					track.info.codec = 'dts';
				} else {
					Logging._warn(
						`Unsupported audio codec (objectTypeIndication ${objectTypeIndication}) - discarding track.`,
					);
				}

				if (!decoderSpecificInfo && track.info.codec === 'aac') {
					// Some writers leave out the AudioSpecificConfig. Like FFmpeg, assume AAC-LC with the sample
					// entry's sample rate and channel count.
					try {
						track.info.codecDescription = buildAacAudioSpecificConfig({
							objectType: 2,
							outputSampleRate: track.info.sampleRate,
							outputNumberOfChannels: track.info.numberOfChannels,
							programConfigElement: null,
						});
					} catch {
						// Channel count not expressible in an AudioSpecificConfig
					}
				}

				if (decoderSpecificInfo) {
					track.info.codecDescription = decoderSpecificInfo;

					if (track.info.codec === 'aac') {
						// Let's try to deduce more accurate values directly from the AudioSpecificConfig:
						const audioSpecificConfig = parseAacAudioSpecificConfig(track.info.codecDescription);
						if (audioSpecificConfig.outputNumberOfChannels !== null) {
							track.info.numberOfChannels = audioSpecificConfig.outputNumberOfChannels;
						}
						if (audioSpecificConfig.outputSampleRate !== null) {
							const sampleEntryRate = track.info.sampleRate;
							const coreRate = audioSpecificConfig.coreSampleRate;
							track.info.sampleRate = audioSpecificConfig.outputSampleRate;

							// With implicit SBR signaling, the AudioSpecificConfig only describes the AAC-LC core coder
							// (at up to 24 kHz), and the decoder doubles the rate once it finds SBR data in the stream.
							// Writers like FFmpeg then give the output rate in the sample entry. (Not the media
							// timescale, which may be a multiple of the rate of plain AAC-LC too.)
							if (
								audioSpecificConfig.objectType === 2
								&& audioSpecificConfig.outputSampleRate === coreRate
								&& coreRate <= 24000
								&& sampleEntryRate === 2 * coreRate
							) {
								track.aacOutputSampleRate = 2 * coreRate;
							}
						}
					} else if (track.info.codec === 'vorbis') {
						const converted = xiphLaceLengthPrefixedVorbisHeaders(decoderSpecificInfo);
						if (converted) {
							track.info.codecDescription = converted.description;
							// The identification header has the actual values
							track.info.numberOfChannels = converted.numberOfChannels;
							track.info.sampleRate = converted.sampleRate;
						}
					}
				}
			}; break;

			case 'enda': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				track.info.pcmLittleEndian = !!(readU16Be(slice) & 0xff); // 0xff is from FFmpeg
			}; break;

			case 'pcmC': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				slice.skip(1 + 3); // Version + flags

				// ISO/IEC 23003-5

				const formatFlags = readU8(slice);
				track.info.pcmLittleEndian = Boolean(formatFlags & 0x01);
				track.info.pcmSampleSize = readU8(slice);
			}; break;

			case 'dOps': { // Used for Opus audio
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				slice.skip(1); // Version

				// https://www.opus-codec.org/docs/opus_in_isobmff.html
				const outputChannelCount = readU8(slice);
				const preSkip = readU16Be(slice);
				const inputSampleRate = readU32Be(slice);
				const outputGain = readI16Be(slice);
				const channelMappingFamily = readU8(slice);

				if (channelMappingFamily !== 0 && boxInfo.contentSize < 11 + 2 + outputChannelCount) {
					break; // The channel mapping table is cut off
				}

				let channelMappingTable: Uint8Array;
				if (channelMappingFamily !== 0) {
					channelMappingTable = readBytes(slice, 2 + outputChannelCount);
				} else {
					channelMappingTable = new Uint8Array(0);
				}

				// https://datatracker.ietf.org/doc/html/draft-ietf-codec-oggopus-06
				const description = new Uint8Array(8 + 1 + 1 + 2 + 4 + 2 + 1 + channelMappingTable.byteLength);
				const view = new DataView(description.buffer);
				view.setUint32(0, 0x4f707573, false); // 'Opus'
				view.setUint32(4, 0x48656164, false); // 'Head'
				view.setUint8(8, 1); // Version
				view.setUint8(9, outputChannelCount);
				view.setUint16(10, preSkip, true);
				view.setUint32(12, inputSampleRate, true);
				view.setInt16(16, outputGain, true);
				view.setUint8(18, channelMappingFamily);
				description.set(channelMappingTable, 19);

				track.info.codecDescription = description;
				track.info.numberOfChannels = outputChannelCount;
				// Don't copy the input sample rate, irrelevant, and output sample rate is fixed
			}; break;

			case 'dfLa': { // Used for FLAC audio
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				slice.skip(4); // Version + flags

				// https://datatracker.ietf.org/doc/rfc9639/

				const BLOCK_TYPE_MASK = 0x7f;
				const LAST_METADATA_BLOCK_FLAG_MASK = 0x80;

				const startPos = slice.filePos;

				while (slice.filePos < boxEndPos) {
					const flagAndType = readU8(slice);
					const metadataBlockLength = readU24Be(slice);
					const type = flagAndType & BLOCK_TYPE_MASK;

					// It's a STREAMINFO block; let's extract the actual sample rate and channel count
					if (type === FlacBlockType.STREAMINFO) {
						slice.skip(10);

						// Extract sample rate and channel count
						const word = readU32Be(slice);
						const sampleRate = word >>> 12;
						const numberOfChannels = ((word >> 9) & 0b111) + 1;

						track.info.sampleRate = sampleRate;
						track.info.numberOfChannels = numberOfChannels;

						slice.skip(20);
					} else {
						// Simply skip ahead to the next block
						slice.skip(metadataBlockLength);
					}

					if (flagAndType & LAST_METADATA_BLOCK_FLAG_MASK) {
						break;
					}
				}

				const endPos = slice.filePos;
				slice.filePos = startPos;
				const bytes = readBytes(slice, endPos - startPos);

				const description = new Uint8Array(4 + bytes.byteLength);
				const view = new DataView(description.buffer);
				view.setUint32(0, 0x664c6143, false); // 'fLaC'
				description.set(bytes, 4);

				// Set the codec description to be 'fLaC' + all metadata blocks
				track.info.codecDescription = description;
			}; break;

			case 'dac3': { // AC3SpecificBox
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				const bytes = readBytes(slice, 3);
				const bitstream = new Bitstream(bytes);

				const fscod = bitstream.readBits(2);
				bitstream.skipBits(5 + 3); // Skip bsid and bsmod
				const acmod = bitstream.readBits(3);
				const lfeon = bitstream.readBits(1);

				if (fscod < 3) {
					track.info.sampleRate = AC3_SAMPLE_RATES[fscod]!;
				}

				track.info.numberOfChannels = AC3_ACMOD_CHANNEL_COUNTS[acmod]! + lfeon;
			}; break;

			case 'dec3': { // EC3SpecificBox
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				const bytes = readBytes(slice, boxInfo.contentSize);
				const config = parseEac3Config(bytes);

				if (!config) {
					Logging._warn('Invalid dec3 box contents, ignoring.');
					break;
				}

				const sampleRate = getEac3SampleRate(config);
				if (sampleRate !== null) {
					track.info.sampleRate = sampleRate;
				}

				track.info.numberOfChannels = getEac3ChannelCount(config);
			}; break;

			case 'ddts': { // DTSSpecificBox
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				const bytes = readBytes(slice, Math.min(boxInfo.contentSize, DTS_SPECIFIC_BOX_SIZE));
				const config = parseDtsSpecificBox(bytes);

				if (!config) {
					Logging._warn('Invalid ddts box contents, ignoring.');
					break;
				}

				track.info.sampleRate = config.sampleRate;

				if (config.numberOfChannels !== null) {
					track.info.numberOfChannels = config.numberOfChannels;
				}
			}; break;

			case 'dmlp': { // MLPSpecificBox
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				const formatInfo = readU32Be(slice);

				const rateBits = formatInfo >>> 28;
				if (rateBits === 0xf) {
					Logging._warn('Invalid dmlp box contents, ignoring.');
					break;
				}

				track.info.sampleRate = (rateBits & 0x8 ? 44100 : 48000) << (rateBits & 0x7);

				// Prefer the 8-channel presentation's assignment, falling back to the 6-channel one
				const sixChannelAssignment = (formatInfo >>> 15) & 0x1f;
				const eightChannelAssignment = formatInfo & 0x1fff;
				const channelAssignment = eightChannelAssignment || sixChannelAssignment;

				let numberOfChannels = 0;
				for (let i = 0; i < TRUEHD_CHANNEL_ASSIGNMENT_COUNTS.length; i++) {
					if (channelAssignment & (1 << i)) {
						numberOfChannels += TRUEHD_CHANNEL_ASSIGNMENT_COUNTS[i]!;
					}
				}

				track.info.numberOfChannels = numberOfChannels;
			}; break;

			case 'stts': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable || this.currentFragment) {
					break;
				}

				slice.skip(4); // Version + flags

				const entryCount = capEntryCount(readU32Be(slice), slice, boxEndPos, 8);

				let currentIndex = 0;
				let currentTimestamp = 0;
				// Where the timestamps would be if the deltas were applied as written, including negative ones
				let correctedTimestamp = 0;

				for (let i = 0; i < entryCount; i++) {
					const sampleCount = readU32Be(slice);
					let sampleDelta = readU32Be(slice);

					// The deltas are unsigned, but some writers store negative ones to correct the timestamps. Like
					// FFmpeg (mov_read_stts), treat huge deltas as such corrections: the samples get a delta of 1,
					// and the following samples are shortened until the timestamps have caught up.
					if (sampleDelta > MAX_SAMPLE_DELTA) {
						const signedDelta = sampleDelta | 0;
						correctedTimestamp += (signedDelta < 0 ? signedDelta : 1) * sampleCount;
						sampleDelta = 1;
					} else {
						correctedTimestamp += sampleDelta * sampleCount;
					}

					const excess = currentTimestamp + sampleDelta * sampleCount - correctedTimestamp;
					if (excess > 0) {
						const drift = Math.floor(excess / Math.max(sampleCount, 1));
						sampleDelta -= Math.min(drift, sampleDelta - 1);
					}

					track.sampleTable.sampleTimingEntries.push({
						startIndex: currentIndex,
						startDecodeTimestamp: currentTimestamp,
						count: sampleCount,
						delta: sampleDelta,
					});

					currentIndex += sampleCount;
					currentTimestamp += sampleCount * sampleDelta;
				}
			}; break;

			case 'ctts': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable || this.currentFragment) {
					break;
				}

				slice.skip(1 + 3); // Version + flags

				const entryCount = capEntryCount(readU32Be(slice), slice, boxEndPos, 8);

				let sampleIndex = 0;
				for (let i = 0; i < entryCount; i++) {
					const sampleCount = readU32Be(slice);
					const sampleOffset = readI32Be(slice);

					track.sampleTable.sampleCompositionTimeOffsets.push({
						startIndex: sampleIndex,
						count: sampleCount,
						offset: sampleOffset,
						startTimestamp: -1,
						lastTimestamp: -1,
						maxLastTimestamp: -1,
					});

					sampleIndex += sampleCount;
				}
			}; break;

			case 'stsz': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable || this.currentFragment) {
					break;
				}

				slice.skip(4); // Version + flags

				const sampleSize = readU32Be(slice);
				let sampleCount = readU32Be(slice);

				if (sampleSize === 0) {
					sampleCount = capEntryCount(sampleCount, slice, boxEndPos, 4);

					for (let i = 0; i < sampleCount; i++) {
						const sampleSize = readU32Be(slice);
						track.sampleTable.sampleSizes.push(sampleSize);
					}
				} else {
					track.sampleTable.sampleSizes.push(sampleSize);
				}

				track.sampleTable.sampleCount = sampleCount;
			}; break;

			case 'stz2': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable || this.currentFragment) {
					break;
				}

				slice.skip(4); // Version + flags
				slice.skip(3); // Reserved

				const fieldSize = readU8(slice); // in bits
				let sampleCount = readU32Be(slice);

				if (fieldSize !== 4 && fieldSize !== 8 && fieldSize !== 16) {
					throw new Error(`Invalid stz2 box: unsupported field size ${fieldSize}.`);
				}

				sampleCount = capEntryCount(sampleCount, slice, boxEndPos, fieldSize / 8);

				const bytes = readBytes(slice, Math.ceil(sampleCount * fieldSize / 8));
				const bitstream = new Bitstream(bytes);

				for (let i = 0; i < sampleCount; i++) {
					const sampleSize = bitstream.readBits(fieldSize);
					track.sampleTable.sampleSizes.push(sampleSize);
				}

				track.sampleTable.sampleCount = sampleCount;
			}; break;

			case 'stss': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable || this.currentFragment) {
					break;
				}

				slice.skip(4); // Version + flags

				// Sample numbers start at 1, but some writers count from 0. Like FFmpeg, take a table whose first entry
				// is 0 as counting from 0.
				let firstSampleNumber = 1;
				track.sampleTable.keySampleIndices = [];

				const entryCount = capEntryCount(readU32Be(slice), slice, boxEndPos, 4);
				for (let i = 0; i < entryCount; i++) {
					const sampleNumber = readU32Be(slice);
					if (i === 0 && sampleNumber === 0) {
						firstSampleNumber = 0;
					}

					track.sampleTable.keySampleIndices.push(sampleNumber - firstSampleNumber); // Convert to 0-indexed
				}

				// We binary search this list, so it must be sorted
				track.sampleTable.keySampleIndices.sort((a, b) => a - b);

				if (track.sampleTable.keySampleIndices[0] !== 0) {
					// Some files don't mark the first sample a key sample, which is basically almost always incorrect.
					// Here, we correct for that mistake:
					track.sampleTable.keySampleIndices.unshift(0);
				}
			}; break;

			case 'stsc': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable) {
					// While reading the moov box, only note which sample description the first chunk uses
					slice.skip(4); // Version + flags
					if (readU32Be(slice) > 0 && boxInfo.contentSize >= 20) {
						slice.skip(8); // First chunk + samples per chunk
						track.firstChunkSampleDescriptionIndex = readU32Be(slice);
					}

					break;
				}

				slice.skip(4);

				const entryCount = capEntryCount(readU32Be(slice), slice, boxEndPos, 12);
				let skippedEntryCount = 0;

				for (let i = 0; i < entryCount; i++) {
					// Convert to 0-indexed. Chunk numbers start at 1, so like FFmpeg, raise an entry's first chunk to
					// at least its own number: a table numbered from 0 still maps all chunks, none starting at -1
					const startChunkIndex = Math.max(readU32Be(slice) - 1, i);
					const samplesPerChunk = readU32Be(slice);
					const sampleDescriptionIndex = readU32Be(slice);

					const lastEntry = last(track.sampleTable.sampleToChunk);
					if (lastEntry && startChunkIndex <= lastEntry.startChunkIndex) {
						// Keeping it would mess up the sample-to-chunk mapping and make chunk iteration blow up
						skippedEntryCount++;
						continue;
					}

					track.sampleTable.sampleToChunk.push({
						startSampleIndex: -1,
						startChunkIndex,
						samplesPerChunk,
						sampleDescriptionIndex,
					});
				}

				if (skippedEntryCount > 0) {
					Logging._warn(
						`Skipped ${skippedEntryCount} invalid stsc entries whose chunk indices weren't strictly`
						+ ' increasing.',
					);
				}

				// Some writers end the table with entries of zero samples per chunk. Like FFmpeg, drop them, so that
				// their chunks keep the samples per chunk of the entry before.
				while (
					track.sampleTable.sampleToChunk.length > 1
					&& last(track.sampleTable.sampleToChunk)!.samplesPerChunk === 0
				) {
					track.sampleTable.sampleToChunk.pop();
				}

				let startSampleIndex = 0;
				for (let i = 0; i < track.sampleTable.sampleToChunk.length; i++) {
					track.sampleTable.sampleToChunk[i]!.startSampleIndex = startSampleIndex;

					if (i < track.sampleTable.sampleToChunk.length - 1) {
						const nextChunk = track.sampleTable.sampleToChunk[i + 1]!;
						const chunkCount = nextChunk.startChunkIndex
							- track.sampleTable.sampleToChunk[i]!.startChunkIndex;
						startSampleIndex += chunkCount * track.sampleTable.sampleToChunk[i]!.samplesPerChunk;
					}
				}
			}; break;

			case 'stco': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable || this.currentFragment) {
					break;
				}

				slice.skip(4); // Version + flags

				const entryCount = capEntryCount(readU32Be(slice), slice, boxEndPos, 4);

				for (let i = 0; i < entryCount; i++) {
					const chunkOffset = readU32Be(slice);
					track.sampleTable.chunkOffsets.push(chunkOffset);
				}
			}; break;

			case 'co64': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable || this.currentFragment) {
					break;
				}

				slice.skip(4); // Version + flags

				const entryCount = capEntryCount(readU32Be(slice), slice, boxEndPos, 8);

				for (let i = 0; i < entryCount; i++) {
					const chunkOffset = readU64Be(slice);
					track.sampleTable.chunkOffsets.push(chunkOffset);
				}
			}; break;

			case 'mvex': {
				this.isFragmented = true;
				this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
			}; break;

			case 'mehd': {
				const version = readU8(slice);
				slice.skip(3); // Flags

				if (version === 1 && boxInfo.contentSize < 12) {
					break;
				}

				this.fragmentedMovieDurationInTimescale = version === 1 ? readU64Be(slice) : readU32Be(slice);
			}; break;

			case 'trex': {
				slice.skip(4); // Version + flags

				const trackId = readU32Be(slice);
				const defaultSampleDescriptionIndex = readU32Be(slice);
				const defaultSampleDuration = readU32Be(slice);
				const defaultSampleSize = readU32Be(slice);
				const defaultSampleFlags = readU32Be(slice);

				// We store these separately rather than in the tracks since the tracks may not exist yet
				this.fragmentTrackDefaults.set(trackId, {
					trackId,
					defaultSampleDescriptionIndex,
					defaultSampleDuration,
					defaultSampleSize,
					defaultSampleFlags,
				});
			}; break;

			case 'tfra': {
				const version = readU8(slice);
				slice.skip(3); // Flags

				const trackId = readU32Be(slice);
				const track = this.idToTrack.get(trackId);
				if (!track) {
					break;
				}

				const word = readU32Be(slice);

				const lengthSizeOfTrafNum = (word & 0b110000) >> 4;
				const lengthSizeOfTrunNum = (word & 0b001100) >> 2;
				const lengthSizeOfSampleNum = word & 0b000011;

				const functions = [readU8, readU16Be, readU24Be, readU32Be];

				const readTrafNum = functions[lengthSizeOfTrafNum]!;
				const readTrunNum = functions[lengthSizeOfTrunNum]!;
				const readSampleNum = functions[lengthSizeOfSampleNum]!;

				const numberOfEntries = readU32Be(slice);
				for (let i = 0; i < numberOfEntries; i++) {
					const time = version === 1 ? readU64Be(slice) : readU32Be(slice);
					const moofOffset = version === 1 ? readU64Be(slice) : readU32Be(slice);

					readTrafNum(slice); // Not used
					const trunNumber = readTrunNum(slice);
					const sampleNumber = readSampleNum(slice);

					if (trunNumber >= 1 && sampleNumber >= 1) {
						track.fragmentLookupTable.push({
							timestamp: time,
							moofOffset,
							trunNumber,
							sampleNumber,
						});
					} else {
						// Invalid
					}
				}

				// The table gets sorted and deduplicated once all metadata has been read
			}; break;

			case 'moof': {
				if (this.currentFragment) {
					break; // Nested moof boxes make no sense
				}

				this.currentFragment = {
					moofOffset: startPos,
					moofSize: boxInfo.totalSize,
					implicitBaseDataOffset: startPos,
					skippedTraf: null,
					trackData: new Map(),
					psshBoxes: [],
					sampleCount: 0,
				};

				try {
					this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
					this.lastReadFragment = this.currentFragment;
				} finally {
					this.currentFragment = null;
					this.currentTrack = null;
				}
			}; break;

			case 'traf': {
				if (!this.currentFragment || this.isReadingTraf) {
					break;
				}

				this.isReadingTraf = true;
				this.currentFragment.skippedTraf = null;
				try {
					this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
				} finally {
					this.isReadingTraf = false;
				}

				// It is possible that there is no current track, for example when we don't care about the track
				// referenced in the track fragment header.
				if (this.currentTrack) {
					const trackData = this.currentFragment.trackData.get(this.currentTrack.id);
					cond:
					if (trackData) {
						// Like for sample tables, the fragment ends before the first sample whose data is cut off
						const fileSize = this.reader.fileSizeNonStrict;
						const sampleCount = fileSize === null
							? -1
							: trackData.samples.findIndex(sample => sample.byteOffset + sample.byteSize > fileSize);
						if (sampleCount !== -1) {
							trackData.samples.length = sampleCount;

							let remainingSampleCount = sampleCount;
							trackData.trunSampleCounts = trackData.trunSampleCounts.map((count) => {
								const keptCount = Math.min(count, remainingSampleCount);
								remainingSampleCount -= keptCount;
								return keptCount;
							});
						}

						if (trackData.samples.length === 0) {
							// Don't associate the fragment with the track if it has no samples, this simplifies
							// other code
							this.currentFragment.trackData.delete(this.currentTrack.id);
							break cond;
						}

						applySampleDependencies(this.currentTrack, trackData);

						trackData.presentationTimestamps = trackData.samples
							.map((x, i) => ({ presentationTimestamp: x.presentationTimestamp, sampleIndex: i }))
							.sort((a, b) => a.presentationTimestamp - b.presentationTimestamp);

						for (let i = 0; i < trackData.presentationTimestamps.length; i++) {
							const currentEntry = trackData.presentationTimestamps[i]!;
							const currentSample = trackData.samples[currentEntry.sampleIndex]!;

							if (trackData.firstKeyFrameTimestamp === null && currentSample.isKeyFrame) {
								trackData.firstKeyFrameTimestamp = currentSample.presentationTimestamp;
							}

							if (i < trackData.presentationTimestamps.length - 1) {
								// Update sample durations based on presentation order
								const nextEntry = trackData.presentationTimestamps[i + 1]!;
								const duration = nextEntry.presentationTimestamp - currentEntry.presentationTimestamp;

								currentSample.duration = duration;
							}
						}

						const firstSample = trackData.samples[trackData.presentationTimestamps[0]!.sampleIndex]!;
						const lastSample = trackData.samples[last(trackData.presentationTimestamps)!.sampleIndex]!;

						trackData.startTimestamp = firstSample.presentationTimestamp;
						trackData.endTimestamp = lastSample.presentationTimestamp + lastSample.duration;

						const { currentFragmentState } = this.currentTrack;
						assert(currentFragmentState);

						if (currentFragmentState.startTimestamp !== null) {
							offsetFragmentTrackDataByTimestamp(trackData, currentFragmentState.startTimestamp);
							trackData.startTimestampIsFinal = true;
						}

						if (
							currentFragmentState.encryptionGroupRuns
							|| currentFragmentState.defaultEncryptionGroup
							|| this.currentTrack.defaultEncryptionGroup
						) {
							assignEncryptionGroups(this.currentTrack, currentFragmentState, trackData);
						}
						if (currentFragmentState.sencSlice) {
							readSampleEncryptionBox(currentFragmentState.sencSlice, this.currentTrack, trackData);
						}

						// Transfer the buffered saiz+saio state onto the track data, so readFragment can resolve it
						// once all boxes are parsed. Only relevant if senc wasn't already used to populate samples.
						if (currentFragmentState.encryptionAuxInfo && !trackData.samples[0]!.encryption) {
							trackData.encryptionAuxInfo = currentFragmentState.encryptionAuxInfo;
						}
					}

					this.currentTrack.currentFragmentState = null;
					this.currentTrack = null;
				}
			}; break;

			case 'pssh': {
				if (this.input._formatOptions.isobmff?._suppressPsshParsing) {
					break;
				}

				const psshBox = parsePsshBoxContents(readBytes(slice, boxInfo.contentSize));

				if (this.currentFragment) {
					this.currentFragment.psshBoxes.push(psshBox);
				} else if (!this.currentTrack) {
					this.psshBoxes.push(psshBox);
				}
			}; break;

			case 'tfhd': {
				// Only the first tfhd of a traf counts; anywhere else, there'd be no traf to finish the track data
				if (!this.currentFragment || !this.isReadingTraf || this.currentTrack) {
					break;
				}

				slice.skip(1); // Version

				const flags = readU24Be(slice);
				const baseDataOffsetPresent = Boolean(flags & 0x000001);
				const sampleDescriptionIndexPresent = Boolean(flags & 0x000002);
				const defaultSampleDurationPresent = Boolean(flags & 0x000008);
				const defaultSampleSizePresent = Boolean(flags & 0x000010);
				const defaultSampleFlagsPresent = Boolean(flags & 0x000020);
				const durationIsEmpty = Boolean(flags & 0x010000);
				const defaultBaseIsMoof = Boolean(flags & 0x020000);

				const trackId = readU32Be(slice);
				const defaults = this.fragmentTrackDefaults.get(trackId);
				const fragmentState: FragmentTrackState = {
					baseDataOffset: this.currentFragment.implicitBaseDataOffset,
					sampleDescriptionIndex: defaults?.defaultSampleDescriptionIndex ?? null,
					defaultSampleDuration: defaults?.defaultSampleDuration ?? null,
					defaultSampleSize: defaults?.defaultSampleSize ?? null,
					defaultSampleFlags: defaults?.defaultSampleFlags ?? null,
					sampleDependsOn: [],
					sampleDependencies: null,
					startTimestamp: null,
					encryptionAuxInfo: null,
					encryptionGroups: [],
					defaultEncryptionGroup: null,
					encryptionGroupRuns: null,
					sencSlice: null,
				};

				if (baseDataOffsetPresent) {
					fragmentState.baseDataOffset = readU64Be(slice);
				} else if (defaultBaseIsMoof) {
					fragmentState.baseDataOffset = this.currentFragment.moofOffset;
				}
				if (sampleDescriptionIndexPresent) {
					fragmentState.sampleDescriptionIndex = readU32Be(slice);
				}
				if (defaultSampleDurationPresent) {
					fragmentState.defaultSampleDuration = readU32Be(slice);
				}
				if (defaultSampleSizePresent) {
					fragmentState.defaultSampleSize = readU32Be(slice);
				}
				if (defaultSampleFlagsPresent) {
					fragmentState.defaultSampleFlags = readU32Be(slice);
				}
				if (durationIsEmpty) {
					fragmentState.defaultSampleDuration = 0;
				}

				const track = this.idToTrack.get(trackId);
				const isDuplicate = this.currentFragment.trackData.has(trackId);
				if (isDuplicate) {
					Logging._warn(`Multiple traf boxes for track ${trackId} in the same moof box; skipping.`);
				}

				if (!track || isDuplicate) {
					// We don't care about this traf, but a later traf's data may start where this one's ends
					this.currentFragment.skippedTraf = {
						baseDataOffset: fragmentState.baseDataOffset,
						dataEnd: null,
						defaultSampleSize: fragmentState.defaultSampleSize,
					};
					break;
				}

				this.currentTrack = track;
				track.currentFragmentState = fragmentState;
			}; break;

			case 'sdtp': {
				// Only the track fragment's one is read, for the dependencies of samples whose flags don't tell them
				const fragmentState = this.currentTrack?.currentFragmentState;
				if (!fragmentState || !this.currentFragment || boxInfo.contentSize < 4) {
					break;
				}

				slice.skip(4); // Version + flags
				fragmentState.sampleDependencies = readBytes(
					slice,
					Math.min(boxInfo.contentSize - 4, slice.remainingLength),
				);
			}; break;

			case 'tfdt': {
				const track = this.currentTrack;
				if (!track?.currentFragmentState) {
					break;
				}

				const version = readU8(slice);
				slice.skip(3); // Flags

				if (version !== 0 && boxInfo.contentSize < 12) {
					break;
				}

				const baseMediaDecodeTime = version === 0 ? readU32Be(slice) : readU64Be(slice);
				track.currentFragmentState.startTimestamp = baseMediaDecodeTime;
			}; break;

			case 'trun': {
				const track = this.currentTrack;
				const skippedTraf = this.currentFragment?.skippedTraf;
				if (!track?.currentFragmentState && skippedTraf) {
					// Only find out where the run's data ends, for the implicit base data offset of later trafs
					slice.skip(1); // Version
					const flags = readU24Be(slice);
					const sampleCount = readU32Be(slice);
					const dataOffset = flags & 0x000001 ? readI32Be(slice) : null;
					if (flags & 0x000004) {
						slice.skip(4); // First sample flags
					}

					const sampleSizePresent = Boolean(flags & 0x000200);
					const entrySize = 4 * [0x000100, 0x000200, 0x000400, 0x000800].filter(x => flags & x).length;
					let dataSize: number;

					if (sampleSizePresent) {
						dataSize = 0;
						const entryCount = Math.min(sampleCount, Math.floor((boxEndPos - slice.filePos) / entrySize));
						const sizeOffset = flags & 0x000100 ? 4 : 0;

						for (let i = 0; i < entryCount; i++) {
							const entryStartPos = slice.filePos;
							slice.skip(sizeOffset);
							dataSize += readU32Be(slice);
							slice.filePos = entryStartPos + entrySize;
						}
					} else if (skippedTraf.defaultSampleSize !== null) {
						dataSize = sampleCount * skippedTraf.defaultSampleSize;
					} else {
						break;
					}

					const dataStart = dataOffset !== null
						? skippedTraf.baseDataOffset + dataOffset
						: skippedTraf.dataEnd ?? skippedTraf.baseDataOffset;
					skippedTraf.dataEnd = dataStart + dataSize;
					this.currentFragment!.implicitBaseDataOffset = skippedTraf.dataEnd;

					break;
				}

				if (!track?.currentFragmentState || !this.currentFragment) {
					break;
				}

				slice.skip(1); // Version
				const flags = readU24Be(slice);
				const dataOffsetPresent = Boolean(flags & 0x000001);
				const firstSampleFlagsPresent = Boolean(flags & 0x000004);
				const sampleDurationPresent = Boolean(flags & 0x000100);
				const sampleSizePresent = Boolean(flags & 0x000200);
				const sampleFlagsPresent = Boolean(flags & 0x000400);
				const sampleCompositionTimeOffsetsPresent = Boolean(flags & 0x000800);

				let sampleCount = readU32Be(slice);

				const { defaultSampleDuration, defaultSampleSize, defaultSampleFlags } = track.currentFragmentState;
				if (
					sampleCount > 0
					&& (
						(!sampleDurationPresent && defaultSampleDuration === null)
						|| (!sampleSizePresent && defaultSampleSize === null)
						|| (!sampleFlagsPresent && defaultSampleFlags === null)
					)
				) {
					throw new Error('Invalid trun box: sample values are missing and there are no defaults.');
				}

				let dataOffset: number | null = null;
				if (dataOffsetPresent) {
					dataOffset = readI32Be(slice);
				}
				let firstSampleFlags: number | null = null;
				if (firstSampleFlagsPresent) {
					firstSampleFlags = readU32Be(slice);
				}

				const entrySize = 4 * [
					sampleDurationPresent,
					sampleSizePresent,
					sampleFlagsPresent,
					sampleCompositionTimeOffsetsPresent,
				].filter(Boolean).length;
				if (entrySize > 0) {
					sampleCount = capEntryCount(sampleCount, slice, boxEndPos, entrySize);
				}

				this.currentFragment.sampleCount += sampleCount;
				if (this.currentFragment.sampleCount > 2 ** 20) {
					// Safety measure
					throw new Error('Too many (> 2^20) samples in fragment.');
				}

				let trackData: FragmentTrackData;

				if (this.currentFragment.trackData.has(track.id)) {
					trackData = this.currentFragment.trackData.get(track.id)!;

					if (dataOffset !== null) {
						trackData.currentOffset = track.currentFragmentState.baseDataOffset + dataOffset;
					} else {
						// "If the data-offset is not present, then the data for this run starts immediately after the
						// data of the previous run"
					}
				} else {
					trackData = {
						track,
						currentTimestamp: 0,
						currentOffset: track.currentFragmentState.baseDataOffset + (dataOffset ?? 0),
						startTimestamp: 0,
						endTimestamp: 0,
						firstKeyFrameTimestamp: null,
						samples: [],
						presentationTimestamps: [],
						startTimestampIsFinal: false,
						trunSampleCounts: [],
						encryptionAuxInfo: null,
						isEncrypted: sampleDescriptionIsEncrypted(
							track,
							track.currentFragmentState.sampleDescriptionIndex ?? 1,
						),
						sampleDescriptionIndex: track.currentFragmentState.sampleDescriptionIndex ?? 1,
					};
					this.currentFragment.trackData.set(track.id, trackData);
				}

				trackData.trunSampleCounts.push(sampleCount);

				for (let i = 0; i < sampleCount; i++) {
					let sampleDuration: number;
					if (sampleDurationPresent) {
						sampleDuration = readU32Be(slice);
					} else {
						sampleDuration = defaultSampleDuration!;
					}
					if (sampleDuration > MAX_SAMPLE_DELTA) {
						sampleDuration = 1; // Most likely a negative duration; FFmpeg clips these the same way
					}

					let sampleSize: number;
					if (sampleSizePresent) {
						sampleSize = readU32Be(slice);
					} else {
						sampleSize = defaultSampleSize!;
					}

					let sampleFlags: number;
					if (sampleFlagsPresent) {
						sampleFlags = readU32Be(slice);
					} else {
						sampleFlags = defaultSampleFlags!;
					}
					if (i === 0 && firstSampleFlags !== null) {
						sampleFlags = firstSampleFlags;
					}

					let sampleCompositionTimeOffset = 0;
					if (sampleCompositionTimeOffsetsPresent) {
						// Technically unsigned for version 0, but some writers write signed values here without
						// changing the version. Since the large unsigned values make little sense anyway, it should be
						// safe to do this.
						sampleCompositionTimeOffset = readI32Be(slice);
					}

					// Some muxers mark every video frame as a sync sample and only signal the dependency on other
					// samples, which FFmpeg (mov_read_trun) and Chromium (PopulateSampleInfo) then don't treat as key
					// frames. Audio samples may depend on others and still be random access points.
					const isKeyFrame = !(sampleFlags & 0x00010000)
						&& !(track.info?.type === 'video' && ((sampleFlags >>> 24) & 0b11) === 1);
					if (track.info?.type === 'video') {
						track.currentFragmentState.sampleDependsOn.push((sampleFlags >>> 24) & 0b11);
					}

					trackData.samples.push({
						presentationTimestamp: trackData.currentTimestamp + sampleCompositionTimeOffset,
						duration: sampleDuration,
						byteOffset: trackData.currentOffset,
						byteSize: sampleSize,
						isKeyFrame,
						encryption: null,
						encryptionGroup: null,
					});

					trackData.currentOffset += sampleSize;
					trackData.currentTimestamp += sampleDuration;
				}

				this.currentFragment.implicitBaseDataOffset = trackData.currentOffset;
			}; break;

			case 'saiz': {
				// Sample Auxiliary Information Sizes - per-sample sizes of (typically) the encryption aux info.
				const track = this.currentTrack;
				if (!track || !track.encryptionInfo) {
					break;
				}

				slice.skip(1); // Version
				const flags = readU24Be(slice);

				if (flags & 0x01) {
					const auxInfoType = readAscii(slice, 4);
					const auxInfoTypeParam = readU32Be(slice);
					if (auxInfoType !== track.encryptionInfo.scheme || auxInfoTypeParam !== 0) {
						// Not the encryption aux info
						break;
					}
				}

				const defaultSampleInfoSize = readU8(slice);
				const sampleCount = readU32Be(slice);

				let sampleSizes: Uint8Array | null = null;
				if (defaultSampleInfoSize === 0 && sampleCount > 0) {
					sampleSizes = readBytes(slice, sampleCount);
				}

				const aux = getOrCreateEncryptionAuxInfo(track);
				aux.defaultSampleInfoSize = defaultSampleInfoSize;
				aux.sampleSizes = sampleSizes;
				aux.sampleCount = sampleCount;
			}; break;

			case 'saio': {
				// Sample Auxiliary Information Offsets - file offset(s) where the aux info lives.
				const track = this.currentTrack;
				if (!track || !track.encryptionInfo) {
					break;
				}

				const version = readU8(slice);
				const flags = readU24Be(slice);

				if (flags & 0x01) {
					const auxInfoType = readAscii(slice, 4);
					const auxInfoTypeParam = readU32Be(slice);
					if (auxInfoType !== track.encryptionInfo.scheme || auxInfoTypeParam !== 0) {
						break;
					}
				}

				const entryCount = readU32Be(slice);
				if (entryCount === 0) {
					break;
				}

				// One offset, or one per track run (in a traf) or chunk (ISO/IEC 14496-12 8.7.9)
				const offsets: number[] = [];
				const offsetSize = version === 0 ? 4 : 8;
				for (let i = 0; i < entryCount && boxEndPos - slice.filePos >= offsetSize; i++) {
					let offset = version === 0 ? readU32Be(slice) : Number(readU64Be(slice));

					// Per ISO/IEC 23001-7: when saio is inside a moof, offsets are relative to the start of the moof.
					if (this.currentFragment) {
						offset += this.currentFragment.moofOffset;
					}

					offsets.push(offset);
				}

				if (offsets.length === 0) {
					break;
				}

				const aux = getOrCreateEncryptionAuxInfo(track);
				aux.offset = offsets[0]!;
				aux.offsets = offsets;
			}; break;

			case 'senc': {
				// Per-sample encryption info inside a 'traf'. Holds per-sample IV and optional subsample breakdown
				// for CENC-protected samples
				const track = this.currentTrack;
				if (!track || !track.encryptionInfo) {
					break;
				}

				if (!this.currentFragment) {
					// ISO/IEC 23001-7 also allows senc in the sample table of a non-fragmented file, where FFmpeg
					// writes it. Like FFmpeg, prefer it over saiz/saio, whose offset older FFmpeg versions got wrong.
					getOrCreateEncryptionAuxInfo(track).resolved = readSampleEncryptionEntries(
						slice,
						boxEndPos,
						track.encryptionInfo,
						Infinity,
					);
					break;
				}

				if (!track.currentFragmentState || !this.currentFragment.trackData.has(track.id)) {
					break;
				}

				// The IV sizes can depend on the samples' sample groups, which may come later in the traf
				track.currentFragmentState.sencSlice = slice.slice(contentStartPos, boxInfo.contentSize);
			}; break;

			case 'sgpd': {
				// Sample group description; only CENC sample groups ('seig') are of interest
				const track = this.currentTrack;
				if (!track?.encryptionInfo) {
					break;
				}

				const version = readU8(slice);
				slice.skip(3); // Flags
				if (readAscii(slice, 4) !== 'seig') {
					break;
				}

				// ISO/IEC 14496-12 8.9.3: the default length exists since version 1, the default entry since version 2
				const defaultLength = version >= 1 ? readU32Be(slice) : 0;
				const defaultGroupDescriptionIndex = version >= 2 ? readU32Be(slice) : 0;
				const hasLengthFields = version >= 1 && defaultLength === 0;

				const entryCount = readU32Be(slice);
				const entries: SampleGroupEncryption[] = [];
				for (let i = 0; i < entryCount && boxEndPos - slice.filePos >= (hasLengthFields ? 24 : 20); i++) {
					const length = hasLengthFields ? readU32Be(slice) : defaultLength;
					const entryStartPos = slice.filePos;

					slice.skip(1); // Reserved
					const pattern = readU8(slice);
					const isProtected = readU8(slice) !== 0;
					const perSampleIvSize = readU8(slice);
					const kid = [...readBytes(slice, 16)].map(x => x.toString(16).padStart(2, '0')).join('');
					let constantIv: Uint8Array | null = null;
					if (isProtected && perSampleIvSize === 0) {
						if (boxEndPos - slice.filePos < 1) {
							break;
						}
						const constantIvSize = Math.min(readU8(slice), 16, boxEndPos - slice.filePos);
						constantIv = new Uint8Array(16);
						constantIv.set(readBytes(slice, constantIvSize));
					}

					entries.push({
						isProtected,
						perSampleIvSize,
						kid,
						constantIv,
						cryptByteBlock: pattern >> 4,
						skipByteBlock: pattern & 0xf,
					});

					if (length > 0) {
						slice.filePos = entryStartPos + length;
					}
				}

				// The default entry is an index into this box's entries (traf-local ones may use the sbgp convention)
				const defaultIndex = defaultGroupDescriptionIndex > 0x10000
					? defaultGroupDescriptionIndex - 0x10000
					: defaultGroupDescriptionIndex;
				const defaultGroup = defaultIndex > 0 ? entries[defaultIndex - 1] ?? null : null;

				if (track.currentFragmentState) {
					track.currentFragmentState.encryptionGroups = entries;
					track.currentFragmentState.defaultEncryptionGroup = defaultGroup;
				} else if (!this.currentFragment) {
					track.encryptionGroups = entries;
					track.defaultEncryptionGroup = defaultGroup;
				}
			}; break;

			case 'sbgp': {
				// Sample to group; only CENC sample groups ('seig') are of interest
				const track = this.currentTrack;
				const fragmentState = track?.currentFragmentState;
				if (!track || (!fragmentState && this.currentFragment)) {
					break;
				}

				const version = readU8(slice);
				slice.skip(3); // Flags
				if (readAscii(slice, 4) !== 'seig') {
					break;
				}
				if (version === 1) {
					slice.skip(4); // Grouping type parameter
				}

				const entryCount = readU32Be(slice);
				const runs: { sampleCount: number; groupDescriptionIndex: number }[] = [];
				for (let i = 0; i < entryCount && boxEndPos - slice.filePos >= 8; i++) {
					runs.push({ sampleCount: readU32Be(slice), groupDescriptionIndex: readU32Be(slice) });
				}

				if (fragmentState) {
					fragmentState.encryptionGroupRuns = runs;
				} else {
					// In a sample table
					let startIndex = 0;
					track.encryptionGroupRuns = runs.map((run) => {
						const result = { startIndex, ...run };
						startIndex += run.sampleCount;
						return result;
					});
				}
			}; break;

				// Metadata section
				// https://exiftool.org/TagNames/QuickTime.html
				// https://mp4workshop.com/about

			case 'udta': { // Contains either movie metadata or track metadata
				const iterator = this.iterateMetadataItems(slice.slice(contentStartPos, boxInfo.contentSize));

				for (const { boxInfo, slice } of iterator) {
					if (
						!this.currentTrack
						&& (boxInfo.name[0] === '©' || boxInfo.name === 'name')
						&& boxInfo.contentSize < 4
					) {
						continue; // Too small for the length and language code of a text atom
					}

					if (boxInfo.name !== 'meta' && !this.currentTrack) {
						watchMetadataTagFields(this.metadataTags, boxInfo.name);
						const startPos = slice.filePos;
						this.metadataTags.raw ??= {};

						if (boxInfo.name[0] === '©') {
							// https://mp4workshop.com/about
							// Box name starting with © indicates "international text"
							this.metadataTags.raw[boxInfo.name] ??= readMetadataStringShort(slice);
						} else {
							this.metadataTags.raw[boxInfo.name] ??= readBytes(slice, boxInfo.contentSize);
						}

						slice.filePos = startPos;
					}

					switch (boxInfo.name) {
						case 'meta': {
							slice.skip(-boxInfo.headerSize);
							this.traverseBox(slice);
						}; break;

						case 'kind': {
							// A TrackKindBox (ISO/IEC 14496-12 8.10.4), which FFmpeg writes for dispositions
							if (!this.currentTrack || boxInfo.contentSize < 4) {
								break;
							}

							slice.skip(4); // Version + flags
							const [scheme, value] = textDecoder
								.decode(readBytes(slice, Math.min(boxInfo.contentSize - 4, slice.remainingLength)))
								.split('\0');
							if (scheme !== 'urn:mpeg:dash:role:2011') { // ISO/IEC 23009-1 5.8.5.5
								break;
							}

							// The roles that FFmpeg maps to dispositions
							const disposition = this.currentTrack.disposition;
							switch (value) {
								case 'caption': {
									disposition.hearingImpaired = true;
								}; break;
								case 'commentary': {
									disposition.commentary = true;
								}; break;
								case 'description': {
									disposition.visuallyImpaired = true;
								}; break;
								case 'forced-subtitle': {
									disposition.forced = true;
								}; break;
							}
						}; break;

						case '©nam':
						case 'name': {
							if (this.currentTrack) {
								let bytes = readBytes(slice, boxInfo.contentSize);
								if (boxInfo.name === 'name') {
									// Some writers end the string with a NUL, like a C string. Like FFmpeg, read it up
									// to the first NUL.
									const end = bytes.indexOf(0);
									if (end !== -1) {
										bytes = bytes.subarray(0, end);
									}
								}

								this.currentTrack.name = textDecoder.decode(bytes);
							} else {
								this.metadataTags.title ??= readMetadataStringShort(slice);
							}
						}; break;

						case '©des': {
							if (!this.currentTrack) {
								this.metadataTags.description ??= readMetadataStringShort(slice);
							}
						}; break;

						case '©ART': {
							if (!this.currentTrack) {
								this.metadataTags.artist ??= readMetadataStringShort(slice);
							}
						}; break;

						case '©alb': {
							if (!this.currentTrack) {
								this.metadataTags.album ??= readMetadataStringShort(slice);
							}
						}; break;

						case 'albr': {
							if (!this.currentTrack) {
								this.metadataTags.albumArtist ??= readMetadataStringShort(slice);
							}
						}; break;

						case '©gen': {
							if (!this.currentTrack) {
								this.metadataTags.genre ??= readMetadataStringShort(slice);
							}
						}; break;

						case '©day': {
							if (!this.currentTrack) {
								const date = new Date(readMetadataStringShort(slice));
								if (!Number.isNaN(date.getTime())) {
									this.metadataTags.date ??= date;
								}
							}
						}; break;

						case '©cmt': {
							if (!this.currentTrack) {
								this.metadataTags.comment ??= readMetadataStringShort(slice);
							}
						}; break;

						case '©lyr': {
							if (!this.currentTrack) {
								this.metadataTags.lyrics ??= readMetadataStringShort(slice);
							}
						}; break;
					}

					unwatchMetadataTagFields(this.metadataTags);
				}
			}; break;

			case 'meta': {
				if (this.currentTrack) {
					break; // Only care about movie-level metadata for now
				}

				// The 'meta' box comes in two flavors, one with flags/version and one without. To know which is which,
				// let's read the next 4 bytes, which are either the version or the size of the first subbox.
				const word = readU32Be(slice);
				const isQuickTime = word !== 0;

				this.currentMetadataKeys = new Map();

				if (isQuickTime) {
					this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
				} else {
					this.readContiguousBoxes(slice.slice(contentStartPos + 4, boxInfo.contentSize - 4));
				}

				this.currentMetadataKeys = null;
			}; break;

			case 'keys': {
				if (!this.currentMetadataKeys) {
					break;
				}

				slice.skip(4); // Version + flags

				const entryCount = readU32Be(slice);

				for (let i = 0; i < entryCount; i++) {
					const keySize = readU32Be(slice);
					if (keySize < 8) {
						throw new Error('Invalid keys box: key size must be at least 8.');
					}

					slice.skip(4); // Key namespace
					const keyName = textDecoder.decode(readBytes(slice, keySize - 8));

					this.currentMetadataKeys.set(i + 1, keyName);
				}
			}; break;

			case 'ilst': {
				if (!this.currentMetadataKeys) {
					break;
				}

				const iterator = this.iterateMetadataItems(slice.slice(contentStartPos, boxInfo.contentSize));

				for (const { boxInfo, slice } of iterator) {
					const itemEndPos = slice.filePos + boxInfo.contentSize;
					let metadataKey = boxInfo.name;

					// Interpret the box name as a u32be
					const nameAsNumber = (metadataKey.charCodeAt(0) << 24)
						+ (metadataKey.charCodeAt(1) << 16)
						+ (metadataKey.charCodeAt(2) << 8)
						+ metadataKey.charCodeAt(3);

					if (this.currentMetadataKeys.has(nameAsNumber)) {
						// An entry exists for this number
						metadataKey = this.currentMetadataKeys.get(nameAsNumber)!;
					}

					let data: ReturnType<typeof readDataBox>;
					if (metadataKey === '----') {
						// An iTunSMPB item holds the AAC encoder delay
						const startPos = slice.filePos;
						this.readFreeformMetadataItem(slice, startPos + boxInfo.contentSize);
						slice.filePos = startPos;

						// All freeform items share this name, so key them by their domain and name instead, like TagLib
						// and Mutagen do (e.g. '----:com.apple.iTunes:iTunSMPB')
						const freeform = readFreeformMetadataItem(slice, boxInfo.contentSize);
						if (!freeform) {
							continue;
						}

						metadataKey = `----:${freeform.mean}:${freeform.name}`;
						data = freeform.data;
					} else {
						data = readDataBox(slice);
					}

					watchMetadataTagFields(this.metadataTags, metadataKey);
					this.metadataTags.raw ??= {};
					this.metadataTags.raw[metadataKey] ??= data;

					switch (metadataKey) {
						case '©nam':
						case 'titl':
						case 'com.apple.quicktime.title':
						case 'title': {
							if (typeof data === 'string') {
								this.metadataTags.title ??= data;
							}
						}; break;

						case '©des':
						case 'desc':
						case 'dscp':
						case 'com.apple.quicktime.description':
						case 'description': {
							if (typeof data === 'string') {
								this.metadataTags.description ??= data;
							}
						}; break;

						case '©ART':
						case 'com.apple.quicktime.artist':
						case 'artist': {
							if (typeof data === 'string') {
								this.metadataTags.artist ??= data;
							}
						}; break;

						case '©alb':
						case 'albm':
						case 'com.apple.quicktime.album':
						case 'album': {
							if (typeof data === 'string') {
								this.metadataTags.album ??= data;
							}
						}; break;

						case 'aART':
						case 'album_artist': {
							if (typeof data === 'string') {
								this.metadataTags.albumArtist ??= data;
							}
						}; break;

						case '©cmt':
						case 'com.apple.quicktime.comment':
						case 'comment': {
							if (typeof data === 'string') {
								this.metadataTags.comment ??= data;
							}
						}; break;

						case '©gen':
						case 'com.apple.quicktime.genre':
						case 'genre': {
							if (typeof data === 'string') {
								this.metadataTags.genre ??= data;
							}
						}; break;

						case 'gnre': {
							// Holds a 16-bit ID3v1 genre number plus one, though some writers put text there
							if (typeof data === 'string') {
								this.metadataTags.genre ??= data;
							} else if (data instanceof Uint8Array && data.length >= 2) {
								const genre = ID3_V1_GENRES[toDataView(data).getUint16(0, false) - 1];
								if (genre !== undefined) {
									this.metadataTags.genre ??= genre;
								}
							}
						}; break;

						case '©lyr':
						case 'lyrics': {
							if (typeof data === 'string') {
								this.metadataTags.lyrics ??= data;
							}
						}; break;

						case '©day':
						case 'rldt':
						case 'com.apple.quicktime.creationdate':
						case 'date': {
							if (typeof data === 'string') {
								const date = new Date(data);
								if (!Number.isNaN(date.getTime())) {
									this.metadataTags.date ??= date;
								}
							}
						}; break;

						case 'tmpo': {
							if (data instanceof Uint8Array && data.length >= 2) {
								const bpm = toDataView(data).getInt16(0, false);
								if (bpm > 0) {
									this.metadataTags.beatsPerMinute ??= bpm;
								}
							}
						}; break;

						case 'covr':
						case 'com.apple.quicktime.artwork': {
							// The item holds one data box per image
							let image = data;
							while (image) {
								if (image instanceof RichImageData) {
									this.metadataTags.images ??= [];
									this.metadataTags.images.push({
										data: image.data,
										kind: 'coverFront',
										mimeType: image.mimeType,
									});
								} else if (image instanceof Uint8Array) {
									this.metadataTags.images ??= [];
									this.metadataTags.images.push({
										data: image,
										kind: 'coverFront',
										mimeType: 'image/*',
									});
								}

								if (itemEndPos - slice.filePos < MIN_BOX_HEADER_SIZE) {
									break;
								}

								image = readDataBox(slice);
							}
						}; break;

						case 'track': {
							if (typeof data === 'string') {
								const parts = data.split('/');
								const trackNum = Number.parseInt(parts[0]!, 10);
								const tracksTotal = parts[1] && Number.parseInt(parts[1], 10);

								if (Number.isInteger(trackNum) && trackNum > 0) {
									this.metadataTags.trackNumber ??= trackNum;
								}
								if (tracksTotal && Number.isInteger(tracksTotal) && tracksTotal > 0) {
									this.metadataTags.tracksTotal ??= tracksTotal;
								}
							}
						}; break;

						case 'trkn': {
							if (data instanceof Uint8Array && data.length >= 6) {
								const view = toDataView(data);

								const trackNumber = view.getUint16(2, false);
								const tracksTotal = view.getUint16(4, false);

								if (trackNumber > 0) {
									this.metadataTags.trackNumber ??= trackNumber;
								}
								if (tracksTotal > 0) {
									this.metadataTags.tracksTotal ??= tracksTotal;
								}
							}
						}; break;

						case 'disc':
						case 'disk': {
							if (typeof data === 'string') {
								// mdta keys hold it as a string, like the track number
								const parts = data.split('/');
								const discNum = Number.parseInt(parts[0]!, 10);
								const discsTotal = parts[1] && Number.parseInt(parts[1], 10);

								if (Number.isInteger(discNum) && discNum > 0) {
									this.metadataTags.discNumber ??= discNum;
								}
								if (discsTotal && Number.isInteger(discsTotal) && discsTotal > 0) {
									this.metadataTags.discsTotal ??= discsTotal;
								}
							} else if (data instanceof Uint8Array && data.length >= 6) {
								const view = toDataView(data);

								const discNumber = view.getUint16(2, false);
								const discNumberMax = view.getUint16(4, false);

								if (discNumber > 0) {
									this.metadataTags.discNumber ??= discNumber;
								}
								if (discNumberMax > 0) {
									this.metadataTags.discsTotal ??= discNumberMax;
								}
							}
						}; break;
					}

					unwatchMetadataTagFields(this.metadataTags);
				}
			}; break;
		}

		slice.filePos = boxEndPos;
		return true;
	}
}

const MAX_DAMAGED_BOXES_PER_PARSE = 16;

/** Reports a box whose fields run past the end of its parent, to have the parse redone without it */
class DamagedBoxError extends Error {
	position: number;

	constructor(position: number) {
		super('Damaged box.');
		this.position = position;
	}
}

abstract class IsobmffTrackBacking implements InputTrackBacking {
	packetToSampleIndex = new WeakMap<EncodedPacket, number>();
	packetToFragmentLocation = new WeakMap<EncodedPacket, {
		fragment: Fragment;
		sampleIndex: number;
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
		for (const track of demuxer.tracks) {
			if (track.trackBacking!.getType() === trackType) {
				number++;
			}

			if (track === this.internalTrack) {
				break;
			}
		}

		return number;
	}

	getCodec(): MediaCodec | null {
		throw new Error('Not implemented on base class.');
	}

	getInternalCodecId() {
		return this.internalTrack.internalCodecId;
	}

	getName() {
		return this.internalTrack.name;
	}

	getLanguageCode() {
		return this.internalTrack.languageCode;
	}

	getTimeResolution() {
		return this.internalTrack.timescale;
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
		return this.internalTrack.maxBitrate;
	}

	getAverageBitrate() {
		return this.internalTrack.avgBitrate;
	}

	async getDurationFromMetadata() {
		const track = this.internalTrack;
		const { demuxer } = track;

		if (demuxer.isFragmented) {
			// The mdhd box only describes the samples in the moov box, while the mehd box gives the movie's duration
			// including its fragments (ISO/IEC 14496-12 8.8.2)
			if (demuxer.fragmentedMovieDurationInTimescale > 0) {
				return demuxer.fragmentedMovieDurationInTimescale / demuxer.movieTimescale;
			}

			let hasSamplesInMoov: boolean | null = null;
			try {
				hasSamplesInMoov = !sampleTableIsEmpty(demuxer.getSampleTableForTrack(track));
			} catch {
				// A sample table that can't be read (a damaged file) leaves it to the mdhd box, as before
			}

			if (hasSamplesInMoov === false) {
				// All of the samples are in fragments, so the mdhd box has nothing to describe; Chromium's muxer even
				// writes milliseconds there. Like Chromium, fall back to the mvhd box's duration.
				return demuxer.movieDurationInTimescale > 0
					? demuxer.movieDurationInTimescale / demuxer.movieTimescale
					: null;
			}
		}

		let durationInMediaTimescale = track.durationInMediaTimescale;
		if (durationInMediaTimescale <= 0) {
			// The duration is often zero for fragmented files for example; return `null` to signal that the duration
			// must be computed instead. A regular track has its samples' durations in its sample table though, which
			// all lasting 0 is also what makes the duration 0 (like a still frame next to other media).
			let lastTimingEntry: SampleTimingEntry | undefined;
			try {
				const sampleTable = track.demuxer.isFragmented ? null : track.demuxer.getSampleTableForTrack(track);
				lastTimingEntry = sampleTable && !sampleTableIsEmpty(sampleTable)
					? last(sampleTable.sampleTimingEntries)
					: undefined;
			} catch {
				// A sample table that can't be read (a damaged file) leaves the duration unknown, as it was before
			}
			if (!lastTimingEntry) {
				return null;
			}

			durationInMediaTimescale = lastTimingEntry.startDecodeTimestamp
				+ lastTimingEntry.count * lastTimingEntry.delta;
		}

		if (track.demuxer.isFragmented && track.demuxer.getSampleTableForTrack(track).sampleCount > 0) {
			// The duration only covers the samples in the moov box and not the fragments that follow
			return null;
		}

		assert(track.trackBacking);

		const firstPacket = await track.trackBacking.getFirstPacket({ metadataOnly: true });
		return (firstPacket?.timestamp ?? 0) + durationInMediaTimescale / track.timescale;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	async getFirstPacket(options: PacketRetrievalOptions) {
		const regularPacket = await this.fetchPacketForSampleIndex(0, options);
		if (regularPacket || !this.internalTrack.demuxer.isFragmented) {
			// If there's a non-fragmented packet, always prefer that
			return regularPacket;
		}

		return this.fetchFirstFragmentedPacket(false, options);
	}

	private mapTimestampIntoTimescale(timestamp: number) {
		// Do a little rounding to catch cases where the result is very close to an integer. If it is, it's likely
		// that the number was originally an integer divided by the timescale. For stability, it's best
		// to return the integer in this case.
		return roundIfAlmostInteger(timestamp * this.internalTrack.timescale) + this.internalTrack.editListOffset;
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		const timestampInTimescale = this.mapTimestampIntoTimescale(timestamp);

		const sampleTable = this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
		const sampleIndex = getSampleIndexForTimestamp(sampleTable, timestampInTimescale);
		const regularPacket = await this.fetchPacketForSampleIndex(sampleIndex, options);

		if (!this.internalTrack.demuxer.isFragmented) {
			return regularPacket;
		}

		const fragmentedPacket = await this.performFragmentedLookup(
			null,
			(fragment) => {
				const trackData = fragment.trackData.get(this.internalTrack.id);
				if (!trackData) {
					return { sampleIndex: -1, correctSampleFound: false };
				}

				const index = binarySearchLessOrEqual(
					trackData.presentationTimestamps,
					timestampInTimescale,
					x => x.presentationTimestamp,
				);

				const sampleIndex = index !== -1 ? trackData.presentationTimestamps[index]!.sampleIndex : -1;
				const correctSampleFound = index !== -1 && timestampInTimescale < trackData.endTimestamp;

				return { sampleIndex, correctSampleFound };
			},
			timestampInTimescale,
			timestampInTimescale,
			options,
			false,
			true,
		);

		if (!regularPacket || !fragmentedPacket) {
			return regularPacket ?? fragmentedPacket;
		}

		// The closer one wins
		return regularPacket.timestamp > fragmentedPacket.timestamp ? regularPacket : fragmentedPacket;
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const regularSampleIndex = this.packetToSampleIndex.get(packet);

		if (regularSampleIndex !== undefined) {
			// Prefer the non-fragmented packet
			const regularPacket = await this.fetchPacketForSampleIndex(regularSampleIndex + 1, options);
			if (regularPacket || !this.internalTrack.demuxer.isFragmented) {
				return regularPacket;
			}

			// The fragments come after the non-fragmented samples
			return this.fetchFirstFragmentedPacket(false, options);
		}

		const locationInFragment = this.packetToFragmentLocation.get(packet);
		if (locationInFragment === undefined) {
			throw new Error('Packet was not created from this track.');
		}

		return this.performFragmentedLookup(
			locationInFragment.fragment,
			(fragment) => {
				if (fragment === locationInFragment.fragment) {
					const trackData = fragment.trackData.get(this.internalTrack.id)!;
					if (locationInFragment.sampleIndex + 1 < trackData.samples.length) {
						// We can simply take the next sample in the fragment
						return {
							sampleIndex: locationInFragment.sampleIndex + 1,
							correctSampleFound: true,
						};
					}
				} else {
					const trackData = fragment.trackData.get(this.internalTrack.id);
					if (trackData) {
						return {
							sampleIndex: 0,
							correctSampleFound: true,
						};
					}
				}

				return {
					sampleIndex: -1,
					correctSampleFound: false,
				};
			},
			-Infinity, // Use -Infinity as a search timestamp to avoid using the lookup entries
			Infinity,
			options,
		);
	}

	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		const timestampInTimescale = this.mapTimestampIntoTimescale(timestamp);

		const sampleTable = this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
		const sampleIndex = getKeyframeSampleIndexForTimestamp(sampleTable, timestampInTimescale);
		const regularPacket = await this.fetchPacketForSampleIndex(sampleIndex, options);

		if (!this.internalTrack.demuxer.isFragmented) {
			return regularPacket;
		}

		const fragmentedPacket = await this.performFragmentedLookup(
			null,
			(fragment) => {
				const trackData = fragment.trackData.get(this.internalTrack.id);
				if (!trackData) {
					return { sampleIndex: -1, correctSampleFound: false };
				}

				// The timestamps are sorted, so find the last one at or before the timestamp and walk back to a key
				// frame from there, instead of scanning all of the fragment's samples on every lookup
				let index = binarySearchLessOrEqual(
					trackData.presentationTimestamps,
					timestampInTimescale,
					x => x.presentationTimestamp,
				);
				while (index !== -1) {
					const sample = trackData.samples[trackData.presentationTimestamps[index]!.sampleIndex]!;
					if (sample.isKeyFrame) {
						break;
					}

					index--;
				}

				const sampleIndex = index !== -1 ? trackData.presentationTimestamps[index]!.sampleIndex : -1;
				const correctSampleFound = index !== -1 && timestampInTimescale < trackData.endTimestamp;

				return { sampleIndex, correctSampleFound };
			},
			timestampInTimescale,
			timestampInTimescale,
			options,
			true,
		);

		if (!regularPacket || !fragmentedPacket) {
			return regularPacket ?? fragmentedPacket;
		}

		// The closer one wins
		return regularPacket.timestamp > fragmentedPacket.timestamp ? regularPacket : fragmentedPacket;
	}

	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const regularSampleIndex = this.packetToSampleIndex.get(packet);
		if (regularSampleIndex !== undefined) {
			// Prefer the non-fragmented packet
			const sampleTable = this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
			const nextKeyFrameSampleIndex = getNextKeyframeIndexForSample(sampleTable, regularSampleIndex);
			const regularPacket = await this.fetchPacketForSampleIndex(nextKeyFrameSampleIndex, options);
			if (regularPacket || !this.internalTrack.demuxer.isFragmented) {
				return regularPacket;
			}

			// The fragments come after the non-fragmented samples
			return this.fetchFirstFragmentedPacket(true, options);
		}

		const locationInFragment = this.packetToFragmentLocation.get(packet);
		if (locationInFragment === undefined) {
			throw new Error('Packet was not created from this track.');
		}

		return this.performFragmentedLookup(
			locationInFragment.fragment,
			(fragment) => {
				if (fragment === locationInFragment.fragment) {
					const trackData = fragment.trackData.get(this.internalTrack.id)!;

					for (let i = locationInFragment.sampleIndex + 1; i < trackData.samples.length; i++) {
						if (trackData.samples[i]!.isKeyFrame) {
							// We can simply take the next key frame in the fragment
							return {
								sampleIndex: i,
								correctSampleFound: true,
							};
						}
					}
				} else {
					const trackData = fragment.trackData.get(this.internalTrack.id);
					if (trackData && trackData.firstKeyFrameTimestamp !== null) {
						const keyFrameIndex = trackData.samples.findIndex(x => x.isKeyFrame);
						assert(keyFrameIndex !== -1); // There must be one

						return {
							sampleIndex: keyFrameIndex,
							correctSampleFound: true,
						};
					}
				}

				return {
					sampleIndex: -1,
					correctSampleFound: false,
				};
			},
			-Infinity, // Use -Infinity as a search timestamp to avoid using the lookup entries
			Infinity,
			options,
		);
	}

	private fetchFirstFragmentedPacket(keyPacketsOnly: boolean, options: PacketRetrievalOptions) {
		return this.performFragmentedLookup(
			null,
			(fragment) => {
				const trackData = fragment.trackData.get(this.internalTrack.id);
				const sampleIndex = trackData?.samples.findIndex(x => !keyPacketsOnly || x.isKeyFrame) ?? -1;

				return {
					sampleIndex,
					correctSampleFound: sampleIndex !== -1,
				};
			},
			-Infinity, // Use -Infinity as a search timestamp to avoid using the lookup entries
			Infinity,
			options,
		);
	}

	private async fetchPacketForSampleIndex(sampleIndex: number, options: PacketRetrievalOptions) {
		if (sampleIndex === -1) {
			return null;
		}

		const sampleTable = this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
		const sampleInfo = getSampleInfo(sampleTable, sampleIndex);
		if (!sampleInfo) {
			return null;
		}

		let data: Uint8Array;
		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			assertProtectionSchemeIsSupported(this.internalTrack);

			let slice = this.internalTrack.demuxer.reader.requestSlice(
				sampleInfo.sampleOffset,
				sampleInfo.sampleSize,
			);
			if (isThenable(slice)) slice = await slice;
			if (!slice) {
				return null; // Data is outside
			}

			data = readBytes(slice, sampleInfo.sampleSize);

			const trackEncryptionInfo = this.internalTrack.encryptionInfo;
			if (
				trackEncryptionInfo
				&& sampleDescriptionIsEncrypted(this.internalTrack, sampleInfo.sampleDescriptionIndex)
			) {
				// Like in fragments, a sample's 'seig' sample group entry overrides tenc's parameters
				const group = getSampleTableEncryptionGroup(this.internalTrack, sampleIndex);
				const descriptionEncryptionInfo
					= getSampleDescriptionEncryptionInfo(this.internalTrack, sampleInfo.sampleDescriptionIndex)!;
				const encryptionInfo = group
					? applySampleGroupEncryption(descriptionEncryptionInfo, group)
					: descriptionEncryptionInfo;
				let sampleEncryption: SampleEncryptionInfo | null = null;

				const auxInfo = this.internalTrack.encryptionAuxInfo;
				if (auxInfo) {
					const entries = await resolveEncryptionAuxInfo(
						this.internalTrack.demuxer.reader,
						trackEncryptionInfo,
						auxInfo,
						auxInfo.offsets.length > 1 && !auxInfo.resolved ? getChunkSampleCounts(sampleTable) : null,
						i => getSampleTableEncryptionGroup(this.internalTrack, i),
					);

					if (sampleIndex < entries.length) {
						sampleEncryption = entries[sampleIndex]!;
					}
				}

				sampleEncryption ??= getDefaultSampleEncryption(encryptionInfo);
				if (sampleEncryption && (!group || group.isProtected)) {
					data = await decryptSample(this.internalTrack, sampleEncryption, data, null, encryptionInfo);
				} else if (!sampleEncryption) {
					assertUnprotectedSample(
						this.internalTrack,
						encryptionInfo,
						sampleDescriptionIsEncrypted(this.internalTrack, sampleInfo.sampleDescriptionIndex),
					);
				}
			}
		}

		let sizingData: Uint8Array | null = null;
		const sampleDescriptionIndex = sampleInfo.sampleDescriptionIndex;
		if (options.metadataOnly && inBandParameterSetsNeedData(this.internalTrack, sampleDescriptionIndex)) {
			let slice = this.internalTrack.demuxer.reader.requestSlice(sampleInfo.sampleOffset, sampleInfo.sampleSize);
			if (isThenable(slice)) {
				slice = await slice;
			}
			sizingData = slice && readBytes(slice, sampleInfo.sampleSize);
		}

		const withParameterSets = applyInBandParameterSets(
			this.internalTrack,
			options.metadataOnly ? sizingData : data,
			sampleInfo.sampleSize,
			sampleInfo.sampleDescriptionIndex,
			sampleInfo.isKeyFrame,
			!!options.metadataOnly,
		);
		if (withParameterSets.data) {
			data = withParameterSets.data;
		}

		const timestamp = (sampleInfo.presentationTimestamp - this.internalTrack.editListOffset)
			/ this.internalTrack.timescale;
		const duration = sampleInfo.duration / this.internalTrack.timescale;
		const packet = new EncodedPacket(
			data,
			sampleInfo.isKeyFrame ? 'key' : 'delta',
			timestamp,
			duration,
			sampleIndex,
			withParameterSets.byteLength,
		);

		this.packetToSampleIndex.set(packet, sampleIndex);

		return packet;
	}

	private async fetchPacketInFragment(fragment: Fragment, sampleIndex: number, options: PacketRetrievalOptions) {
		if (sampleIndex === -1) {
			return null;
		}

		const trackData = fragment.trackData.get(this.internalTrack.id)!;
		const fragmentSample = trackData.samples[sampleIndex];
		assert(fragmentSample);

		let data: Uint8Array;
		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			assertProtectionSchemeIsSupported(this.internalTrack);

			let slice = this.internalTrack.demuxer.reader.requestSlice(
				fragmentSample.byteOffset,
				fragmentSample.byteSize,
			);
			if (isThenable(slice)) slice = await slice;
			if (!slice) {
				return null; // Data is outside
			}

			data = readBytes(slice, fragmentSample.byteSize);

			if (this.internalTrack.encryptionInfo && trackData.isEncrypted) {
				const group = fragmentSample.encryptionGroup;
				const descriptionEncryptionInfo
					= getSampleDescriptionEncryptionInfo(this.internalTrack, trackData.sampleDescriptionIndex)!;
				const encryptionInfo = group
					? applySampleGroupEncryption(descriptionEncryptionInfo, group)
					: descriptionEncryptionInfo;
				const sampleEncryption = fragmentSample.encryption ?? getDefaultSampleEncryption(encryptionInfo);

				if (sampleEncryption && (!group || group.isProtected)) {
					data = await decryptSample(this.internalTrack, sampleEncryption, data, fragment, encryptionInfo);
				} else if (!sampleEncryption) {
					assertUnprotectedSample(this.internalTrack, encryptionInfo, trackData.isEncrypted);
				}
			}
		}

		let sizingData: Uint8Array | null = null;
		const sampleDescriptionIndex = trackData.sampleDescriptionIndex;
		if (options.metadataOnly && inBandParameterSetsNeedData(this.internalTrack, sampleDescriptionIndex)) {
			let slice = this.internalTrack.demuxer.reader.requestSlice(
				fragmentSample.byteOffset,
				fragmentSample.byteSize,
			);
			if (isThenable(slice)) {
				slice = await slice;
			}
			sizingData = slice && readBytes(slice, fragmentSample.byteSize);
		}

		const withParameterSets = applyInBandParameterSets(
			this.internalTrack,
			options.metadataOnly ? sizingData : data,
			fragmentSample.byteSize,
			trackData.sampleDescriptionIndex,
			fragmentSample.isKeyFrame,
			!!options.metadataOnly,
		);
		if (withParameterSets.data) {
			data = withParameterSets.data;
		}

		const timestamp = (fragmentSample.presentationTimestamp - this.internalTrack.editListOffset)
			/ this.internalTrack.timescale;
		const duration = await this.getFragmentSampleDuration(fragment, sampleIndex) / this.internalTrack.timescale;

		// Sequence numbers count up from the moof's offset, and the next fragment's moof starts after this one ends. If
		// the fragment has more samples than its moof has bytes (possible when their sizes and durations are defaults),
		// squeeze them into that range so that they still come before the next fragment's samples.
		const sampleCount = trackData.samples.length;
		const sequenceNumber = sampleCount <= fragment.moofSize
			? fragment.moofOffset + sampleIndex
			: fragment.moofOffset + sampleIndex * fragment.moofSize / sampleCount;

		const packet = new EncodedPacket(
			data,
			fragmentSample.isKeyFrame ? 'key' : 'delta',
			timestamp,
			duration,
			sequenceNumber,
			withParameterSets.byteLength,
		);

		this.packetToFragmentLocation.set(packet, { fragment, sampleIndex });

		return packet;
	}

	/**
	 * A fragment's sample lasts until the next sample in presentation order, which, with B-frames in fragments that
	 * don't start a GOP, can sit in a fragment decoded before or after this one. Unless the fragment itself proves that
	 * no other one holds it, the adjacent fragments are looked at until the stream guarantees that no further one can:
	 * no sample is presented before more than maxReorderedSamples samples decoded before it, and no sample decoded
	 * before a sync sample is presented after it. The scans are bounded so that broken files stay cheap.
	 */
	private async getFragmentSampleDuration(fragment: Fragment, sampleIndex: number) {
		const trackData = fragment.trackData.get(this.internalTrack.id)!;
		const sample = trackData.samples[sampleIndex]!;
		const maxReorderedSamples = getMaxReorderedSamples(this.internalTrack);
		const presentation = this.internalTrack.fragmentPresentations?.get(fragment.moofOffset);
		if (maxReorderedSamples === 0 || !presentation) {
			return sample.duration; // Presentation order is decode order, so no other fragment can come in between
		}

		const knownDuration = presentation.durations.get(sampleIndex);
		if (knownDuration !== undefined) {
			return knownDuration;
		}

		const timestamp = sample.presentationTimestamp;
		// Samples presented at the same time are ordered by decoding, as in non-fragmented files, so a sample decoded
		// after this one at the same timestamp ends it: later in this fragment, or in a later fragment
		const lastAtTimestamp = searchTimestamps(presentation.timestamps, timestamp, false) - 1;
		let nextTimestamp = trackData.presentationTimestamps[lastAtTimestamp]!.sampleIndex !== sampleIndex
			? timestamp
			: getNextTimestamp(presentation.timestamps, timestamp);
		let presentedAfterNext = countTimestampsFrom(presentation.timestamps, nextTimestamp);

		if (
			nextTimestamp > timestamp
			&& (presentedAfterNext <= maxReorderedSamples || presentation.minSyncTimestamp > timestamp)
		) {
			// Later fragments can't hold a sample presented before nextTimestamp once more than maxReorderedSamples
			// samples decoded before them are presented at or after it
			const laterPresentations = [presentation];
			let latestTimestamp = presentation.timestamps.at(-1) ?? -Infinity;
			let laterSampleCount = 0;
			let moofOffset = fragment.moofOffset;
			while (
				nextTimestamp > timestamp
				&& presentedAfterNext <= maxReorderedSamples
				&& laterSampleCount <= MAX_SCANNED_SAMPLES
				// No conforming stream presents that many samples decoded after a sample before it
				&& (nextTimestamp !== Infinity || laterSampleCount <= MAX_REORDERED_SAMPLES)
			) {
				let next = this.getNextFragmentPresentation(moofOffset);
				if (isThenable(next)) {
					next = await next;
				}
				// A sync sample is presented after every sample decoded before it, so one presented earlier means that
				// the fragments overlap (cut or edited content), which nothing reorders across
				if (!next || next.presentation.minSyncTimestamp <= latestTimestamp) {
					break;
				}

				moofOffset = next.moofOffset;
				laterPresentations.push(next.presentation);
				latestTimestamp = Math.max(latestTimestamp, next.presentation.timestamps.at(-1) ?? -Infinity);
				laterSampleCount += next.presentation.timestamps.length;

				// A later fragment's sample at the same timestamp is decoded after this one, so it counts too
				const candidate = next.presentation.timestamps[
					searchTimestamps(next.presentation.timestamps, timestamp, true)
				] ?? Infinity;
				if (candidate < nextTimestamp) {
					nextTimestamp = candidate;
					presentedAfterNext = 0;
					for (const { timestamps } of laterPresentations) {
						presentedAfterNext += countTimestampsFrom(timestamps, nextTimestamp);
					}
				} else {
					presentedAfterNext += countTimestampsFrom(next.presentation.timestamps, nextTimestamp);
				}
			}

			// Earlier fragments can't hold one once a sync sample presented at or before the sample has been seen,
			// or all of the at most maxReorderedSamples samples decoded before it and presented after it
			let syncTimestamp = presentation.minSyncTimestamp;
			if (syncTimestamp > timestamp && nextTimestamp > timestamp) {
				let presentedAfterSample = 0;
				for (let i = 0; i < sampleIndex; i++) {
					if (trackData.samples[i]!.presentationTimestamp > timestamp) {
						presentedAfterSample++;
					}
				}

				let earlierSampleCount = 0;
				moofOffset = fragment.moofOffset;
				while (
					syncTimestamp > timestamp
					&& presentedAfterSample < maxReorderedSamples
					&& earlierSampleCount <= MAX_SCANNED_SAMPLES
				) {
					let previous = this.getPreviousFragmentPresentation(moofOffset);
					if (isThenable(previous)) {
						previous = await previous;
					}
					// Same for an earlier fragment presenting a sample after a later sync sample
					if (!previous || (previous.presentation.timestamps.at(-1) ?? -Infinity) >= syncTimestamp) {
						break;
					}

					const { timestamps } = previous.presentation;
					moofOffset = previous.moofOffset;
					nextTimestamp = Math.min(nextTimestamp, getNextTimestamp(timestamps, timestamp));
					syncTimestamp = Math.min(syncTimestamp, previous.presentation.minSyncTimestamp);
					presentedAfterSample += countTimestampsAfter(timestamps, timestamp);
					earlierSampleCount += timestamps.length;
				}
			}
		}

		// Without any later sample, the sample keeps its own duration
		const duration = nextTimestamp === Infinity ? sample.duration : nextTimestamp - timestamp;
		presentation.durations.set(sampleIndex, duration);

		return duration;
	}

	/**
	 * The presentation of the next fragment holding this track after the one at the given offset, if any. Returns
	 * synchronously once known.
	 */
	private getNextFragmentPresentation(moofOffset: number): MaybePromise<{
		moofOffset: number;
		presentation: FragmentPresentation;
	} | null> {
		const { fragmentPresentations } = this.internalTrack;
		const presentation = fragmentPresentations!.get(moofOffset)!;

		const nextMoofOffset = presentation.nextMoofOffset;
		const next = nextMoofOffset != null ? fragmentPresentations!.get(nextMoofOffset) : undefined;
		if (next) {
			return { moofOffset: nextMoofOffset!, presentation: next };
		}
		if (nextMoofOffset === null) {
			return null;
		}

		return (async () => {
			presentation.nextMoofOffset ??= await this.findTrackMoof(moofOffset + presentation.moofSize);
			if (presentation.nextMoofOffset === null) {
				return null;
			}

			if (!fragmentPresentations!.has(presentation.nextMoofOffset)) {
				await this.internalTrack.demuxer.readFragment(presentation.nextMoofOffset, this.internalTrack);
			}
			const next = fragmentPresentations!.get(presentation.nextMoofOffset);
			return next ? { moofOffset: presentation.nextMoofOffset, presentation: next } : null;
		})();
	}

	/**
	 * The presentation of the fragment holding this track right before the one at the given offset, if any. Returns
	 * synchronously once known.
	 */
	private getPreviousFragmentPresentation(moofOffset: number): MaybePromise<{
		moofOffset: number;
		presentation: FragmentPresentation;
	} | null> {
		const { fragmentPresentations, fragmentPresentationOffsets } = this.internalTrack;

		const index = binarySearchLessOrEqual(fragmentPresentationOffsets!, moofOffset - 1, x => x);
		const candidateOffset = fragmentPresentationOffsets![index];
		const candidate = candidateOffset !== undefined ? fragmentPresentations!.get(candidateOffset) : undefined;
		if (candidate?.nextMoofOffset === moofOffset) {
			return { moofOffset: candidateOffset!, presentation: candidate };
		}

		return this.findPreviousFragmentPresentation(moofOffset, candidateOffset ?? null);
	}

	private async findPreviousFragmentPresentation(moofOffset: number, knownOffset: number | null) {
		const { fragmentPresentations, fragmentLookupTable, fragmentPositionCache } = this.internalTrack;

		// Boxes can only be walked forward, so start at the closest earlier fragment of this track we know of: one read
		// before, or one the fragment index (tfra) or the position cache points to. Only without any, at the file
		// start.
		const lookupEntry = fragmentLookupTable[
			binarySearchLessOrEqual(fragmentLookupTable, moofOffset - 1, x => x.moofOffset)
		];
		const cacheEntry = fragmentPositionCache[
			binarySearchLessOrEqual(fragmentPositionCache, moofOffset - 1, x => x.moofOffset)
		];
		const candidates = [knownOffset, lookupEntry?.moofOffset, cacheEntry?.moofOffset]
			.filter((x): x is number => x != null && x < moofOffset);
		let currentOffset = candidates.length > 0 ? Math.max(...candidates) : await this.findTrackMoof(0);
		if (currentOffset === null || currentOffset >= moofOffset) {
			return null;
		}

		if (!fragmentPresentations!.has(currentOffset)) {
			await this.internalTrack.demuxer.readFragment(currentOffset, this.internalTrack);
		}
		let previous = { moofOffset: currentOffset, presentation: fragmentPresentations!.get(currentOffset)! };
		while (true) {
			let next = this.getNextFragmentPresentation(currentOffset);
			if (isThenable(next)) {
				next = await next;
			}
			if (!next || next.moofOffset >= moofOffset) {
				return previous;
			}

			previous = next;
			currentOffset = next.moofOffset;
		}
	}

	/** The offset of the first moof box holding this track at or after the given position, if any. */
	private async findTrackMoof(pos: number) {
		const { demuxer } = this.internalTrack;

		while (true) {
			const summary = demuxer.fragmentSummaries.get(pos);
			if (summary) {
				if (summary.trackIds.has(this.internalTrack.id)) {
					return pos;
				}

				pos += summary.moofSize;
				continue;
			}

			let slice = demuxer.reader.requestSliceRange(pos, MIN_BOX_HEADER_SIZE, MAX_BOX_HEADER_SIZE);
			if (isThenable(slice)) {
				slice = await slice;
			}
			const boxInfo = slice && readBoxHeader(slice);
			if (!boxInfo) {
				return null;
			}

			if (boxInfo.name === 'moof') {
				const fragment = await demuxer.readFragment(pos, this.internalTrack);
				if (!fragment) {
					return null;
				}
				if (fragment.trackData.has(this.internalTrack.id)) {
					return pos;
				}
			}

			pos += boxInfo.totalSize;
		}
	}

	/** Looks for a packet in the fragments while trying to load as few fragments as possible to retrieve it. */
	private async performFragmentedLookup(
		// The fragment where we start looking
		startFragment: Fragment | null,
		// This function returns the best-matching sample in a given fragment
		getMatchInFragment: (fragment: Fragment) => { sampleIndex: number; correctSampleFound: boolean },
		// The timestamp with which we can search the lookup table
		searchTimestamp: number,
		// The timestamp for which we know the correct sample will not come after it
		latestTimestamp: number,
		options: PacketRetrievalOptions,
		// Whether the match must be a key frame, so that position cache entries without one can be skipped
		requireKeyFrame = false,
		// Whether the best match is the one with the latest presentation timestamp across all fragments. Fragments may
		// interleave in presentation order (B-frames in fragments that don't start a GOP), so then the match found in
		// one fragment is only final once no fragment before or after it can hold a later presentation timestamp.
		matchByPresentationTimestamp = false,
	): Promise<EncodedPacket | null> {
		const { demuxer, fragmentLookupTable, fragmentPositionCache, nextFragmentOffsets } = this.internalTrack;

		let bestFragment: Fragment | null = null;
		let bestSampleIndex = -1;

		const getPresentationTimestamp = (fragment: Fragment, sampleIndex: number) => {
			return fragment.trackData.get(this.internalTrack.id)!.samples[sampleIndex]!.presentationTimestamp;
		};
		const isBetterMatch = (fragment: Fragment, sampleIndex: number) => {
			if (!bestFragment || !matchByPresentationTimestamp) {
				return true;
			}

			const timestamp = getPresentationTimestamp(fragment, sampleIndex);
			const bestTimestamp = getPresentationTimestamp(bestFragment, bestSampleIndex);
			return timestamp > bestTimestamp
				|| (timestamp === bestTimestamp && fragment.moofOffset > bestFragment.moofOffset);
		};

		// When matching by presentation timestamp, only what the scanned samples prove about the others ends the
		// search, not where the fragments' timestamps happen to lie: a sample presented at or before latestTimestamp
		// can't be decoded after more than maxReorderedSamples samples presented after it, so the forward scan can
		// stop once it has seen more of those. And no sample decoded before a sync sample is presented after it, so
		// the scan needn't go back further than a sync sample presented at or before latestTimestamp.
		const maxReorderedSamples = matchByPresentationTimestamp ? getMaxReorderedSamples(this.internalTrack) : 0;
		let samplesPresentedAfter = 0;
		let syncSampleFound = false;
		const scanSamples = (fragment: Fragment) => {
			const trackData = fragment.trackData.get(this.internalTrack.id);
			if (!trackData) {
				return;
			}

			// The fragment's samples in presentation order
			const { presentationTimestamps, samples } = trackData;
			const index = binarySearchLessOrEqual(
				presentationTimestamps,
				latestTimestamp,
				x => x.presentationTimestamp,
			);
			samplesPresentedAfter += presentationTimestamps.length - (index + 1);
			for (let i = 0; i <= index && !syncSampleFound; i++) {
				syncSampleFound = samples[presentationTimestamps[i]!.sampleIndex]!.isKeyFrame;
			}
		};

		if (startFragment) {
			const { sampleIndex, correctSampleFound } = getMatchInFragment(startFragment);

			if (correctSampleFound) {
				return this.fetchPacketInFragment(startFragment, sampleIndex, options);
			}

			if (sampleIndex !== -1) {
				bestFragment = startFragment;
				bestSampleIndex = sampleIndex;
			}
		}

		// Search for a lookup entry; this way, we won't need to start searching from the start of the file
		// but can jump right into the correct fragment (or at least nearby).
		let lookupEntryIndex = binarySearchLessOrEqual(fragmentLookupTable, searchTimestamp, x => x.timestamp);
		// Fragments read during the lookup land after this index, so it stays valid
		let positionCacheIndex = binarySearchLessOrEqual(fragmentPositionCache, searchTimestamp, x => x.startTimestamp);

		// The position for which we know the correct sample will not come after it
		let stopPos = Infinity;

		while (true) {
			// Skip lookup entries pointing into fragments we've already scanned
			while (lookupEntryIndex !== -1 && fragmentLookupTable[lookupEntryIndex]!.moofOffset >= stopPos) {
				lookupEntryIndex--;
			}
			while (
				positionCacheIndex !== -1
				&& (
					fragmentPositionCache[positionCacheIndex]!.moofOffset >= stopPos
					|| (requireKeyFrame && !fragmentPositionCache[positionCacheIndex]!.hasKeyFrame)
				)
			) {
				positionCacheIndex--;
			}

			const lookupEntryPosition = Math.max(
				fragmentLookupTable[lookupEntryIndex]?.moofOffset ?? 0,
				fragmentPositionCache[positionCacheIndex]?.moofOffset ?? 0,
			) || null;

			let currentPos: number;
			let currentFragment: Fragment | null = null;

			if (!startFragment) {
				currentPos = lookupEntryPosition ?? 0;
			} else {
				if (lookupEntryPosition === null || startFragment.moofOffset >= lookupEntryPosition) {
					currentPos = startFragment.moofOffset + startFragment.moofSize;
					currentFragment = startFragment;
					if (matchByPresentationTimestamp) {
						scanSamples(startFragment);
					}
				} else {
					// Use the lookup entry
					currentPos = lookupEntryPosition;
				}
			}

			const scanStartPos = currentFragment ? currentFragment.moofOffset : currentPos;
			// The end of the last moof box with samples of this track that this scan went past, and the number of moof
			// boxes without samples of this track it went past since
			let lastTrackFragmentEnd: number | null = null;
			let fragmentsWithoutTrack = 0;
			if (!currentFragment && currentPos === 0) {
				// The start of the file works like the end of a fragment of this track
				lastTrackFragmentEnd = 0;
				currentPos = nextFragmentOffsets.get(0) ?? 0;
			}
			const reachedEnd = () => {
				if (lastTrackFragmentEnd !== null && fragmentsWithoutTrack > 0) {
					nextFragmentOffsets.set(lastTrackFragmentEnd, Infinity);
				}
			};

			while (currentPos < stopPos) {
				if (currentFragment) {
					const trackData = currentFragment.trackData.get(this.internalTrack.id);
					if (trackData) {
						if (lastTrackFragmentEnd !== null && fragmentsWithoutTrack > 0) {
							nextFragmentOffsets.set(lastTrackFragmentEnd, currentFragment.moofOffset);
						}
						// Here, currentPos is the end of the fragment's moof box
						lastTrackFragmentEnd = currentPos;
						fragmentsWithoutTrack = 0;
					} else {
						fragmentsWithoutTrack++;
					}

					const pastUpperBound = matchByPresentationTimestamp
						// Only the first scan goes forward; scans further back must reach the fragments scanned before
						? stopPos === Infinity && samplesPresentedAfter > maxReorderedSamples
						: trackData && trackData.startTimestamp > latestTimestamp;
					if (pastUpperBound) {
						// We're already past the upper bound, no need to keep searching
						break;
					}

					currentFragment = null; // So we don't process it again next iteration

					const nextFragmentOffset = trackData && nextFragmentOffsets.get(currentPos);
					if (nextFragmentOffset !== undefined) {
						// A previous scan went from here to the next fragment of this track (or to the end of the
						// file), so we can skip the fragments in between
						currentPos = nextFragmentOffset;
						continue;
					}
				}

				const summary = demuxer.fragmentSummaries.get(currentPos);
				if (summary && !summary.trackIds.has(this.internalTrack.id)) {
					// We've read this fragment before and know it has nothing for this track, so let's not read it
					// again
					demuxer.passTopLevelBox(currentPos, currentPos + summary.moofSize);
					currentPos += summary.moofSize;
					fragmentsWithoutTrack++;
					continue;
				}

				// Load the header
				let slice = demuxer.reader.requestSliceRange(currentPos, MIN_BOX_HEADER_SIZE, MAX_BOX_HEADER_SIZE);
				if (isThenable(slice)) slice = await slice;
				if (!slice) {
					reachedEnd();
					break;
				}

				const boxStartPos = currentPos;
				const boxInfo = readBoxHeader(slice);
				if (!boxInfo) {
					reachedEnd();
					break;
				}

				if (boxInfo.name === 'moof') {
					currentFragment = await demuxer.readFragment(boxStartPos, this.internalTrack);
					if (!currentFragment) {
						reachedEnd();
						break;
					}

					if (matchByPresentationTimestamp) {
						scanSamples(currentFragment);
					}

					const { sampleIndex, correctSampleFound } = getMatchInFragment(currentFragment);
					if (correctSampleFound && !matchByPresentationTimestamp) {
						return this.fetchPacketInFragment(currentFragment, sampleIndex, options);
					}
					if (sampleIndex !== -1 && isBetterMatch(currentFragment, sampleIndex)) {
						bestFragment = currentFragment;
						bestSampleIndex = sampleIndex;
					}
				} else {
					demuxer.passTopLevelBox(boxStartPos, boxStartPos + boxInfo.totalSize);
				}

				currentPos = boxStartPos + boxInfo.totalSize;
			}

			if (
				lookupEntryPosition === null
				|| (
					bestFragment
					&& bestFragment.moofOffset >= lookupEntryPosition
					&& (!matchByPresentationTimestamp || syncSampleFound)
				)
			) {
				break;
			}

			// We found a lookup entry but no fragment from there on that satisfied the match (or, when matching by
			// presentation timestamp, an earlier fragment may still hold a better one). In this case, let's search
			// again from the lookup entry preceding the fragments we just scanned.
			stopPos = scanStartPos; // So we don't read the same fragments again
			startFragment = null;
		}

		if (bestFragment) {
			// If we finished looping but didn't find a perfect match, still return the best match we found
			return this.fetchPacketInFragment(bestFragment, bestSampleIndex, options);
		}

		return null;
	}
}

class IsobmffVideoTrackBacking extends IsobmffTrackBacking implements InputVideoTrackBacking {
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

	getTransformationMatrix(): TransformationMatrix {
		return [...this.internalTrack.matrix];
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
		return this.internalTrack.info.codec === 'prores' && (
			this.internalTrack.info.proresFormat === 'ap4h'
			|| this.internalTrack.info.proresFormat === 'ap4x'
		);
	}

	getHasOnlyKeyPackets() {
		const { demuxer } = this.internalTrack;
		if (demuxer.isFragmented) {
			// Fragments flag their samples themselves, and the metadata doesn't say anything about them
			return null;
		}

		let sampleTable: SampleTable;
		try {
			sampleTable = demuxer.getSampleTableForTrack(this.internalTrack);
		} catch {
			return null; // A sample table that can't be read (a damaged file) says nothing either
		}
		if (sampleTable.sampleCount === 0) {
			return null;
		}

		const { keySampleIndices, sampleCount } = sampleTable;
		if (!keySampleIndices) {
			return true; // Without an stss box, every sample is a sync sample (ISO/IEC 14496-12 8.6.2.1)
		}

		// Whether the stss box lists every sample. Invalid entries can leave the list unsorted (see the stss box), so
		// count the distinct valid ones.
		const listedSampleIndices = new Set<number>();
		for (const sampleIndex of keySampleIndices) {
			if (sampleIndex >= 0 && sampleIndex < sampleCount) {
				listedSampleIndices.add(sampleIndex);
			}
		}

		return listedSampleIndices.size === sampleCount;
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		if (!this.internalTrack.info.codec) {
			return null;
		}

		return this.decoderConfigPromise ??= (async (): Promise<VideoDecoderConfig> => {
			if (this.internalTrack.info.codec === 'avc' && !this.internalTrack.info.codecDescription) {
				const firstPacket = await this.getFirstPacket({});
				this.internalTrack.info.avcCodecInfo
					= firstPacket && extractAvcDecoderConfigurationRecord(firstPacket.data);
			} else if (this.internalTrack.info.codec === 'hevc' && !this.internalTrack.info.codecDescription) {
				const firstPacket = await this.getFirstPacket({});
				this.internalTrack.info.hevcCodecInfo
					= firstPacket && extractHevcDecoderConfigurationRecord(firstPacket.data);
			} else if (
				this.internalTrack.info.codec === 'vp9'
				&& (
					!this.internalTrack.info.vp9CodecInfo
					// The codec info extracted from vpcC may claim the color space is "undefined"
					|| !vp9CodecInfoHasColorInfo(this.internalTrack.info.vp9CodecInfo)
				)
			) {
				const firstPacket = await this.getFirstPacket({});
				const packetInfo = firstPacket && extractVp9CodecInfoFromPacket(firstPacket.data);

				if (packetInfo) {
					this.internalTrack.info.vp9CodecInfo = {
						...(this.internalTrack.info.vp9CodecInfo ?? packetInfo),
						videoFullRangeFlag: packetInfo.videoFullRangeFlag,
						colourPrimaries: packetInfo.colourPrimaries,
						transferCharacteristics: packetInfo.transferCharacteristics,
						matrixCoefficients: packetInfo.matrixCoefficients,
					};
				}
			} else if (
				this.internalTrack.info.codec === 'av1'
				&& (
					!this.internalTrack.info.av1CodecInfo
					// The codec info extracted from av1C may not contain color space information
					|| !av1CodecInfoHasColorInfo(
						this.internalTrack.info.av1CodecInfo,
					)
				)
			) {
				const firstPacket = await this.getFirstPacket({});
				const packetInfo = firstPacket && extractAv1CodecInfoFromPacket(firstPacket.data);

				if (packetInfo) {
					this.internalTrack.info.av1CodecInfo = packetInfo;
				}
			} else if (this.internalTrack.info.codec === 'prores' && !this.internalTrack.info.proresCodecInfo) {
				const firstPacket = await this.getFirstPacket({});
				this.internalTrack.info.proresCodecInfo
					= firstPacket && extractProresCodecInfoFromPacket(firstPacket.data);
			}

			if (!colorSpaceIsComplete(this.internalTrack.info.colorSpace)) {
				const colorSpace = extractColorSpace(this.internalTrack.info);

				// Fill the missing values
				this.internalTrack.info.colorSpace.primaries ??= colorSpace.primaries;
				this.internalTrack.info.colorSpace.transfer ??= colorSpace.transfer;
				this.internalTrack.info.colorSpace.matrix ??= colorSpace.matrix;
				this.internalTrack.info.colorSpace.fullRange ??= colorSpace.fullRange;
			}

			const config: VideoDecoderConfig = {
				codec: extractVideoCodecString(this.internalTrack.info),
				codedWidth: this.internalTrack.info.width,
				codedHeight: this.internalTrack.info.height,
				description: getInBandParameterSets(this.internalTrack)?.description
					?? this.internalTrack.info.codecDescription
					?? undefined,
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

class IsobmffAudioTrackBacking extends IsobmffTrackBacking implements InputAudioTrackBacking {
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
				codec: extractAudioCodecString(this.internalTrack.info),
				numberOfChannels: this.internalTrack.info.numberOfChannels,
				sampleRate: this.internalTrack.info.sampleRate,
				description: this.internalTrack.info.codecDescription ?? undefined,
			};
		})();
	}
}

const getSampleIndexForTimestamp = (sampleTable: SampleTable, timescaleUnits: number) => {
	if (sampleTable.sortedCompositionTimeOffsets) {
		return performPresentationTimeLookup(sampleTable, timescaleUnits, false);
	} else {
		const index = binarySearchLessOrEqual(
			sampleTable.sampleTimingEntries,
			timescaleUnits,
			x => x.startDecodeTimestamp,
		);
		if (index === -1) {
			return -1;
		}

		const entry = sampleTable.sampleTimingEntries[index]!;
		if (entry.delta === 0) {
			return entry.startIndex + entry.count - 1; // All samples share the same timestamp
		}

		return entry.startIndex
			+ Math.min(
				Math.floor((timescaleUnits - entry.startDecodeTimestamp) / entry.delta),
				entry.count - 1,
			);
	}
};

const getKeyframeSampleIndexForTimestamp = (sampleTable: SampleTable, timescaleUnits: number) => {
	if (!sampleTable.keySampleIndices) {
		// Every sample is a keyframe
		return getSampleIndexForTimestamp(sampleTable, timescaleUnits);
	}

	if (sampleTable.sortedCompositionTimeOffsets) {
		return performPresentationTimeLookup(sampleTable, timescaleUnits, true);
	} else {
		const sampleIndex = getSampleIndexForTimestamp(sampleTable, timescaleUnits);

		const index = binarySearchLessOrEqual(sampleTable.keySampleIndices, sampleIndex, x => x);
		return sampleTable.keySampleIndices[index] ?? -1;
	}
};

type InBandParameterSets = {
	/**
	 * The NAL unit length size of every packet: the largest among the sample descriptions, since narrowing could
	 * truncate NAL unit lengths
	 */
	lengthSize: 1 | 2 | 3 | 4;
	/** The decoder config's avcC/hvcC record, with that length size */
	description: Uint8Array;
	bySampleDescription: Map<number, { parameterSets: Uint8Array; lengthSize: 1 | 2 | 3 | 4 }>;
};

/**
 * The decoder config of an AVC or HEVC track has the parameter sets of one sample description only, but FFmpeg starts
 * a new sample description when they change mid-stream. Like Chromium, which inserts the parameter sets of the sample's
 * own description into every key frame, we then send each description's parameter sets in band.
 */
const getInBandParameterSets = (track: InternalTrack) => {
	if (track.inBandParameterSets !== undefined) {
		return track.inBandParameterSets;
	}

	track.inBandParameterSets = null;
	const info = track.info;
	if (info?.type !== 'video' || (info.codec !== 'avc' && info.codec !== 'hevc') || !info.codecDescription) {
		return null;
	}

	const configDescription = info.codecDescription;
	const records = track.sampleDescriptionRecords;
	if (!records.some(record => record && !uint8ArraysAreEqual(record, configDescription))) {
		return null; // All descriptions share the decoder config's parameter sets
	}

	const parseRecord = (record: Uint8Array) => {
		if (info.codec === 'avc') {
			const avcRecord = deserializeAvcDecoderConfigurationRecord(record);
			return avcRecord && {
				nalUnits: [...avcRecord.sequenceParameterSets, ...avcRecord.pictureParameterSets],
				lengthSize: (avcRecord.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4,
			};
		} else {
			const hevcRecord = deserializeHevcDecoderConfigurationRecord(record);
			const parameterSetTypes: number[] = [
				HevcNalUnitType.VPS_NUT,
				HevcNalUnitType.SPS_NUT,
				HevcNalUnitType.PPS_NUT,
			];
			return hevcRecord && {
				nalUnits: hevcRecord.arrays
					.filter(x => parameterSetTypes.includes(x.nalUnitType))
					.flatMap(x => x.nalUnits),
				lengthSize: (hevcRecord.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4,
			};
		}
	};

	const config = parseRecord(configDescription);
	if (!config) {
		return null;
	}

	const parsedRecords = records.map(record => record && parseRecord(record));
	const lengthSize = Math.max(
		config.lengthSize,
		...parsedRecords.map(parsed => parsed?.lengthSize ?? 1),
	) as 1 | 2 | 3 | 4;

	let description = configDescription;
	if (lengthSize !== config.lengthSize) {
		// lengthSizeMinusOne is in the low two bits of byte 4 of avcC and of byte 21 of hvcC
		description = configDescription.slice();
		const lengthSizePos = info.codec === 'avc' ? 4 : 21;
		description[lengthSizePos] = (description[lengthSizePos]! & 0xfc) | (lengthSize - 1);
	}

	const bySampleDescription: InBandParameterSets['bySampleDescription'] = new Map();
	parsedRecords.forEach((parsed, i) => {
		if (parsed) {
			bySampleDescription.set(i + 1, {
				parameterSets: concatNalUnitsInLengthPrefixed(parsed.nalUnits, lengthSize),
				lengthSize: parsed.lengthSize,
			});
		}
	});

	return track.inBandParameterSets = { lengthSize, description, bySampleDescription };
};

/**
 * Whether a sample's NAL unit length prefixes get widened to the packets' size, which makes the packet's size depend on
 * its NAL units: then even a metadata-only packet needs the sample's data to know its size.
 */
const inBandParameterSetsNeedData = (track: InternalTrack, sampleDescriptionIndex: number) => {
	const inBand = getInBandParameterSets(track);
	const description = inBand?.bySampleDescription.get(sampleDescriptionIndex);
	return !!inBand && !!description && description.lengthSize !== inBand.lengthSize;
};

/**
 * Prepends a key sample's own parameter sets when the track's sample descriptions differ in them, widening NAL unit
 * length prefixes to the packets' size if needed. For metadata-only packets, only computes the size (from the
 * data when inBandParameterSetsNeedData says so) and returns no data.
 */
const applyInBandParameterSets = (
	track: InternalTrack,
	data: Uint8Array | null,
	byteLength: number,
	sampleDescriptionIndex: number,
	isKeyFrame: boolean,
	metadataOnly: boolean,
) => {
	const inBand = getInBandParameterSets(track);
	const description = inBand?.bySampleDescription.get(sampleDescriptionIndex);
	if (!inBand || !description) {
		return { data: metadataOnly ? null : data, byteLength };
	}

	if (data && description.lengthSize !== inBand.lengthSize) {
		const bytes = data;
		const nalUnits = [...iterateNalUnitsInLengthPrefixed(bytes, description.lengthSize)]
			.map(location => bytes.subarray(location.offset, location.offset + location.length));
		data = concatNalUnitsInLengthPrefixed(nalUnits, inBand.lengthSize);
	}

	if (data) {
		byteLength = data.byteLength;
	}

	if (isKeyFrame) {
		byteLength += description.parameterSets.byteLength;
		if (data && !metadataOnly) {
			const result = new Uint8Array(byteLength);
			result.set(description.parameterSets, 0);
			result.set(data, description.parameterSets.byteLength);
			data = result;
		}
	}

	return { data: metadataOnly ? null : data, byteLength };
};

type SampleInfo = {
	presentationTimestamp: number;
	duration: number;
	sampleOffset: number;
	sampleSize: number;
	chunkOffset: number;
	isKeyFrame: boolean;
	sampleDescriptionIndex: number;
};

const getSampleInfo = (sampleTable: SampleTable, sampleIndex: number): SampleInfo | null => {
	if (sampleIndex >= sampleTable.sampleCount) {
		return null;
	}

	const timingEntryIndex = binarySearchLessOrEqual(sampleTable.sampleTimingEntries, sampleIndex, x => x.startIndex);
	const timingEntry = sampleTable.sampleTimingEntries[timingEntryIndex]!;

	const decodeTimestamp = timingEntry.startDecodeTimestamp
		+ (sampleIndex - timingEntry.startIndex) * timingEntry.delta;
	let presentationTimestamp = decodeTimestamp;
	const offsetEntryIndex = binarySearchLessOrEqual(
		sampleTable.sampleCompositionTimeOffsets,
		sampleIndex,
		x => x.startIndex,
	);
	const offsetEntry = sampleTable.sampleCompositionTimeOffsets[offsetEntryIndex];
	if (offsetEntry && sampleIndex - offsetEntry.startIndex < offsetEntry.count) {
		presentationTimestamp += offsetEntry.offset;
	}

	const sampleSize = sampleTable.sampleSizes[Math.min(sampleIndex, sampleTable.sampleSizes.length - 1)]!;
	const chunkEntryIndex = binarySearchLessOrEqual(sampleTable.sampleToChunk, sampleIndex, x => x.startSampleIndex);
	const chunkEntry = sampleTable.sampleToChunk[chunkEntryIndex]!;

	const chunkIndex = chunkEntry.startChunkIndex
		+ Math.floor((sampleIndex - chunkEntry.startSampleIndex) / chunkEntry.samplesPerChunk);
	const chunkOffset = sampleTable.chunkOffsets[chunkIndex]!;

	const startSampleIndexOfChunk = chunkEntry.startSampleIndex
		+ (chunkIndex - chunkEntry.startChunkIndex) * chunkEntry.samplesPerChunk;
	let sampleOffset = chunkOffset;

	if (sampleTable.sampleSizes.length === 1) {
		sampleOffset += sampleSize * (sampleIndex - startSampleIndexOfChunk);
	} else {
		sampleOffset += sampleTable.cumulativeSampleSizes![sampleIndex]!
			- sampleTable.cumulativeSampleSizes![startSampleIndexOfChunk]!;
	}

	let duration = timingEntry.delta;
	if (sampleTable.sortedCompositionTimeOffsets) {
		// In order to accurately compute the duration, we need to take the duration to the next sample in presentation
		// order, not in decode order
		const nextPresentationTimestamp = getNextPresentationTimestamp(sampleTable, sampleIndex, presentationTimestamp);
		if (nextPresentationTimestamp !== null) {
			duration = nextPresentationTimestamp - presentationTimestamp;
		}
	}

	return {
		presentationTimestamp,
		duration,
		sampleOffset,
		sampleSize,
		chunkOffset,
		isKeyFrame: sampleTable.keySampleIndices
			? binarySearchExact(sampleTable.keySampleIndices, sampleIndex, x => x) !== -1
			: true,
		sampleDescriptionIndex: chunkEntry.sampleDescriptionIndex,
	};
};

/** `index` is 1-based. The encryption info of that sample description, or else the track's. */
const getSampleDescriptionEncryptionInfo = (track: InternalTrack, index: number) => {
	return track.encryptionInfos[index - 1] ?? track.encryptionInfo;
};

const performPresentationTimeLookup = (
	sampleTable: SampleTable,
	timestamp: number,
	keyFramesOnly: boolean,
) => {
	const entries = sampleTable.sortedCompositionTimeOffsets!;
	let bestSampleIndex = -1;
	let bestTimestamp = -Infinity;

	// Walk back until no entry can beat the best sample found so far anymore
	const startIndex = binarySearchLessOrEqual(entries, timestamp, x => x.startTimestamp);
	for (let i = startIndex; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.maxLastTimestamp < bestTimestamp) {
			break;
		}

		let sampleIndex = entry.lastTimestamp <= timestamp
			? entry.startIndex + entry.count - 1
			: findFirstSampleInEntry(sampleTable, entry, (_, otherTimestamp) => otherTimestamp > timestamp) - 1;
		if (keyFramesOnly) {
			const keySampleIndex = binarySearchLessOrEqual(sampleTable.keySampleIndices!, sampleIndex, x => x);
			sampleIndex = sampleTable.keySampleIndices![keySampleIndex] ?? -1;
		}
		if (sampleIndex < entry.startIndex) {
			continue; // Nothing suitable in this entry
		}

		const presentationTimestamp = getDecodeTimestamp(sampleTable, sampleIndex) + entry.offset;
		if (
			presentationTimestamp > bestTimestamp
			|| (presentationTimestamp === bestTimestamp && sampleIndex > bestSampleIndex)
		) {
			bestSampleIndex = sampleIndex;
			bestTimestamp = presentationTimestamp;
		}
	}

	return bestSampleIndex;
};

const getNextPresentationTimestamp = (sampleTable: SampleTable, sampleIndex: number, presentationTimestamp: number) => {
	const entries = sampleTable.sortedCompositionTimeOffsets!;
	const lastStartedEntryIndex = binarySearchLessOrEqual(entries, presentationTimestamp, x => x.startTimestamp);

	// No entry starting later can beat the first one of them
	let nextTimestamp = entries[lastStartedEntryIndex + 1]?.startTimestamp ?? null;

	// Walk back until no entry can beat the best sample found so far anymore
	for (let i = lastStartedEntryIndex; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.maxLastTimestamp < presentationTimestamp) {
			break;
		}

		const nextSampleIndex = findFirstSampleInEntry(
			sampleTable,
			entry,
			(otherSampleIndex, otherTimestamp) => otherTimestamp > presentationTimestamp
				|| (otherTimestamp === presentationTimestamp && otherSampleIndex > sampleIndex),
		);
		if (nextSampleIndex === entry.startIndex + entry.count) {
			continue; // Nothing after the sample in this entry
		}

		const timestamp = getDecodeTimestamp(sampleTable, nextSampleIndex) + entry.offset;
		if (nextTimestamp === null || timestamp < nextTimestamp) {
			nextTimestamp = timestamp;
		}
	}

	return nextTimestamp;
};

const findFirstSampleInEntry = (
	sampleTable: SampleTable,
	entry: SampleCompositionTimeOffsetEntry,
	predicate: (sampleIndex: number, presentationTimestamp: number) => boolean,
) => {
	// The samples of an entry are in presentation order, so this binary searches for the first one satisfying the
	// predicate

	let low = entry.startIndex;
	let high = entry.startIndex + entry.count;

	while (low < high) {
		const mid = Math.floor((low + high) / 2);

		if (predicate(mid, getDecodeTimestamp(sampleTable, mid) + entry.offset)) {
			high = mid;
		} else {
			low = mid + 1;
		}
	}

	return low;
};

/** The number of samples in each chunk */
const getChunkSampleCounts = (sampleTable: SampleTable) => {
	const counts: number[] = [];
	for (let i = 0; i < sampleTable.sampleToChunk.length; i++) {
		const entry = sampleTable.sampleToChunk[i]!;
		const nextEntry = sampleTable.sampleToChunk[i + 1];
		const endChunkIndex = Math.min(nextEntry?.startChunkIndex ?? Infinity, sampleTable.chunkOffsets.length);
		for (let j = entry.startChunkIndex; j < endChunkIndex; j++) {
			counts.push(entry.samplesPerChunk);
		}
	}

	return counts;
};

const getDecodeTimestamp = (sampleTable: SampleTable, sampleIndex: number) => {
	const timingEntryIndex = binarySearchLessOrEqual(sampleTable.sampleTimingEntries, sampleIndex, x => x.startIndex);
	const timingEntry = sampleTable.sampleTimingEntries[timingEntryIndex]!;

	return timingEntry.startDecodeTimestamp + (sampleIndex - timingEntry.startIndex) * timingEntry.delta;
};

const getNextKeyframeIndexForSample = (sampleTable: SampleTable, sampleIndex: number) => {
	if (!sampleTable.keySampleIndices) {
		return sampleIndex + 1;
	}

	const index = binarySearchLessOrEqual(sampleTable.keySampleIndices, sampleIndex, x => x);
	return sampleTable.keySampleIndices[index + 1] ?? -1;
};

/**
 * No sample is presented before more than this many samples that precede it in decoding order: AVC, HEVC and VVC can't
 * reorder more frames than their decoded picture buffer holds (16 frames, 32 fields), and other codecs reorder less.
 */
const MAX_REORDERED_SAMPLES = 32;

/** How many samples of other fragments are looked at, at most, to find where a fragment's sample ends */
const MAX_SCANNED_SAMPLES = 4 * (MAX_REORDERED_SAMPLES + 1);

/** The most samples that can precede any sample of the track in decoding order and follow it in presentation order. */
const getMaxReorderedSamples = (track: InternalTrack) => {
	if (track.maxReorderedSamples !== undefined) {
		return track.maxReorderedSamples;
	}

	const info = track.info;
	let maxReorderedSamples = MAX_REORDERED_SAMPLES;
	if (info?.type === 'audio') {
		maxReorderedSamples = 0;
	} else if (info?.type === 'video') {
		if (info.codec === 'vp8' || info.codec === 'vp9' || info.codec === 'av1') {
			// Their ISOBMFF bindings store one displayed frame per sample, in presentation order
			maxReorderedSamples = 0;
		} else if (info.codec === 'avc' && info.codecDescription) {
			const sps = deserializeAvcDecoderConfigurationRecord(info.codecDescription)?.sequenceParameterSets[0];
			const spsInfo = sps && parseAvcSps(sps);
			if (spsInfo) {
				// num_reorder_frames counts frames, whose two fields can be separate samples
				maxReorderedSamples = spsInfo.frameMbsOnlyFlag
					? spsInfo.numReorderFrames
					: 2 * spsInfo.numReorderFrames + 1;
			}
		} else if (info.codec === 'hevc' && info.codecDescription) {
			const sps = deserializeHevcDecoderConfigurationRecord(info.codecDescription)
				?.arrays.find(x => x.nalUnitType === HevcNalUnitType.SPS_NUT)?.nalUnits[0];
			const spsInfo = sps && parseHevcSps(sps);
			if (spsInfo) {
				maxReorderedSamples = spsInfo.maxDecFrameBuffering; // At least sps_max_num_reorder_pics
			}
		}
	}

	return track.maxReorderedSamples = maxReorderedSamples;
};

/** The index of the first of the sorted timestamps that is after the given one (or equal to it, if inclusive) */
const searchTimestamps = (timestamps: number[], timestamp: number, inclusive: boolean) => {
	let low = 0;
	let high = timestamps.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (inclusive ? timestamps[middle]! < timestamp : timestamps[middle]! <= timestamp) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}

	return low;
};

/** The earliest of the sorted timestamps after the given one, or Infinity */
const getNextTimestamp = (timestamps: number[], timestamp: number) => {
	return timestamps[searchTimestamps(timestamps, timestamp, false)] ?? Infinity;
};

/** How many of the sorted timestamps are at or after the given one */
const countTimestampsFrom = (timestamps: number[], timestamp: number) => {
	return timestamps.length - searchTimestamps(timestamps, timestamp, true);
};

/** How many of the sorted timestamps are after the given one */
const countTimestampsAfter = (timestamps: number[], timestamp: number) => {
	return timestamps.length - searchTimestamps(timestamps, timestamp, false);
};

const offsetFragmentTrackDataByTimestamp = (trackData: FragmentTrackData, timestamp: number) => {
	trackData.currentTimestamp += timestamp;
	trackData.startTimestamp += timestamp;
	trackData.endTimestamp += timestamp;

	for (const sample of trackData.samples) {
		sample.presentationTimestamp += timestamp;
	}
	for (const entry of trackData.presentationTimestamps) {
		entry.presentationTimestamp += timestamp;
	}
};

/**
 * Takes the dependencies of video samples whose sample flags leave them unknown from the traf's sdtp box, like
 * Chromium (TrackRunIterator), as some files mark every video frame as a sync sample.
 */
const applySampleDependencies = (track: InternalTrack, trackData: FragmentTrackData) => {
	const state = track.currentFragmentState;
	if (!state?.sampleDependencies || track.info?.type !== 'video') {
		return;
	}

	const { sampleDependsOn, sampleDependencies } = state;
	for (let i = 0; i < trackData.samples.length && i < sampleDependencies.length; i++) {
		// sample_depends_on 1: the sample depends on others
		if (sampleDependsOn[i] === 0 && ((sampleDependencies[i]! >> 4) & 0b11) === 1) {
			trackData.samples[i]!.isKeyFrame = false;
		}
	}
};

const readMatrix = (slice: FileSlice): TransformationMatrix => {
	return [
		readFixed_16_16(slice),
		readFixed_16_16(slice),
		readFixed_2_30(slice),
		readFixed_16_16(slice),
		readFixed_16_16(slice),
		readFixed_2_30(slice),
		readFixed_16_16(slice),
		readFixed_16_16(slice),
		readFixed_2_30(slice),
	];
};

/**
 * Takes the dimensions from the SPS when the sample entry leaves them at 0, as some writers do. FFmpeg also uses the
 * dimensions of the parameter sets.
 */
const applySpsDimensions = (track: InternalTrack, width: number, height: number) => {
	const info = track.info!;
	if (info.type !== 'video' || (info.width > 0 && info.height > 0) || !(width > 0 && height > 0)) {
		return;
	}

	info.width = width;
	info.height = height;
	info.squarePixelWidth = width;
	info.squarePixelHeight = height;
};

const applySpsPixelAspectRatio = (track: InternalTrack, pixelAspectRatio: Rational) => {
	const info = track.info!;
	if (info.type !== 'video' || info.hasPixelAspectRatioBox) {
		return;
	}

	const { num, den } = pixelAspectRatio;
	if (!(num > 0 && den > 0) || num === den) {
		return;
	}

	info.pixelAspectRatio = simplifyRational({ num, den });
	if (num > den) {
		info.squarePixelWidth = Math.round(info.width * num / den);
		info.squarePixelHeight = info.height;
	} else {
		info.squarePixelWidth = info.width;
		info.squarePixelHeight = Math.round(info.height * den / num);
	}
};

const sampleTableIsEmpty = (sampleTable: SampleTable) => {
	return sampleTable.sampleSizes.length === 0;
};

/** Counts the samples before the first one whose data goes past the end of the file. */
const countSamplesWithData = (sampleTable: SampleTable, fileSize: number) => {
	const { sampleToChunk, chunkOffsets, sampleSizes, sampleCount } = sampleTable;
	const getSampleSize = (sampleIndex: number) => sampleSizes[Math.min(sampleIndex, sampleSizes.length - 1)]!;

	for (let i = 0; i < sampleToChunk.length; i++) {
		const chunkEntry = sampleToChunk[i]!;
		const chunkCount = Math.min(sampleToChunk[i + 1]?.startChunkIndex ?? Infinity, chunkOffsets.length)
			- chunkEntry.startChunkIndex;

		for (let j = 0; j < chunkCount; j++) {
			const startSampleIndex = chunkEntry.startSampleIndex + j * chunkEntry.samplesPerChunk;
			const endSampleIndex = Math.min(startSampleIndex + chunkEntry.samplesPerChunk, sampleCount);
			let offset = chunkOffsets[chunkEntry.startChunkIndex + j]!;

			for (let sampleIndex = startSampleIndex; sampleIndex < endSampleIndex; sampleIndex++) {
				offset += getSampleSize(sampleIndex);
				if (offset > fileSize) {
					return sampleIndex;
				}
			}

			if (endSampleIndex >= sampleCount) {
				return sampleCount;
			}
		}
	}

	return sampleCount;
};

/** Inserts a number into a sorted array, unless it's already there */
const insertSorted = (array: number[], value: number) => {
	const index = binarySearchLessOrEqual(array, value, x => x);
	if (array[index] !== value) {
		array.splice(index + 1, 0, value);
	}
};

const capEntryCounts = (entries: { startIndex: number; count: number }[], sampleCount: number) => {
	while (entries.length > 0 && last(entries)!.startIndex >= sampleCount) {
		entries.pop();
	}

	const lastEntry = last(entries);
	if (lastEntry) {
		lastEntry.count = Math.min(lastEntry.count, sampleCount - lastEntry.startIndex);
	}
};

/** `index` is 1-based. Descriptions of a track that we couldn't classify count as encrypted. */
const sampleDescriptionIsEncrypted = (track: InternalTrack, index: number) => {
	return track.encryptionInfo !== null && track.encryptedSampleDescriptions[index - 1] !== false;
};

const getOrCreateEncryptionAuxInfo = (track: InternalTrack) => {
	if (track.currentFragmentState) {
		return track.currentFragmentState.encryptionAuxInfo ??= {
			defaultSampleInfoSize: 0,
			sampleSizes: null,
			sampleCount: 0,
			offset: null,
			offsets: [],
			resolved: null,
		};
	} else {
		return track.encryptionAuxInfo ??= {
			defaultSampleInfoSize: 0,
			sampleSizes: null,
			sampleCount: 0,
			offset: null,
			offsets: [],
			resolved: null,
		};
	}
};

/** Reads up to `maxCount` entries of a senc box, stopping early if the box is truncated. */
const readSampleEncryptionEntries = (
	slice: FileSlice,
	boxEndPos: number,
	encryptionInfo: TrackEncryptionInfo,
	maxCount: number,
) => {
	slice.skip(1); // Version
	const flags = readU24Be(slice);
	const useSubsamples = Boolean(flags & 0x000002);

	const sampleCount = readU32Be(slice);
	const ivSize = encryptionInfo.defaultPerSampleIvSize;
	if (ivSize === null) {
		throw new Error('Invalid file: encrypted track is missing its tenc box.');
	}

	const entries: SampleEncryptionInfo[] = [];
	for (let i = 0; i < Math.min(sampleCount, maxCount); i++) {
		if (boxEndPos - slice.filePos < ivSize + (useSubsamples ? 2 : 0)) {
			break;
		}

		// Normalize the IV to 16 bytes so downstream code can assume a full-length buffer. For CTR with
		// an 8-byte per-sample IV the lower 8 bytes are zero (that's the CENC spec's block counter start);
		// for CBC/cbcs the IV is always 16 bytes by spec.
		const iv = new Uint8Array(16);
		if (ivSize > 0) {
			iv.set(readBytes(slice, ivSize), 0);
		} else if (encryptionInfo.defaultConstantIv) {
			iv.set(encryptionInfo.defaultConstantIv, 0);
		} else {
			throw new Error('Invalid file: encrypted sample has no IV.');
		}

		let subsamples: SampleEncryptionInfo['subsamples'] = null;
		if (useSubsamples) {
			const subsampleCount = readU16Be(slice);
			if (boxEndPos - slice.filePos < 6 * subsampleCount) {
				break;
			}

			subsamples = [];
			for (let j = 0; j < subsampleCount; j++) {
				const clearLen = readU16Be(slice);
				const protectedLen = readU32Be(slice);
				subsamples.push({ clearLen, protectedLen });
			}
		}

		entries.push({ iv, subsamples });
	}

	return entries;
};

const resolveEncryptionAuxInfo = async (
	reader: Reader,
	encryptionInfo: TrackEncryptionInfo,
	aux: SampleEncryptionAuxInfo,
	runSampleCounts: number[] | null, // Of the track runs or chunks, which saio can give one offset each
	// The 'seig' sample group entry of each sample, which overrides tenc's IV size and constant IV
	getEncryptionGroup: (sampleIndex: number) => SampleGroupEncryption | null = () => null,
): Promise<SampleEncryptionInfo[]> => {
	if (aux.resolved) {
		return aux.resolved;
	}

	if (aux.offsets.length > 1) {
		if (runSampleCounts?.length === aux.offsets.length) {
			// Each run's entries are at its own offset (like Chromium's TrackRunIterator does it)
			const entries: SampleEncryptionInfo[] = [];
			let sampleStart = 0;
			for (let i = 0; i < runSampleCounts.length && sampleStart < aux.sampleCount; i++) {
				const sampleCount = Math.min(runSampleCounts[i]!, aux.sampleCount - sampleStart);
				if (sampleCount === 0) {
					continue;
				}

				const runStart = sampleStart;
				const runEntries = await resolveEncryptionAuxInfo(reader, encryptionInfo, {
					defaultSampleInfoSize: aux.defaultSampleInfoSize,
					sampleSizes: aux.sampleSizes && aux.sampleSizes.subarray(sampleStart, sampleStart + sampleCount),
					sampleCount,
					offset: aux.offsets[i]!,
					offsets: [aux.offsets[i]!],
					resolved: null,
				}, null, j => getEncryptionGroup(runStart + j));
				for (const entry of runEntries) {
					entries.push(entry);
				}

				sampleStart += sampleCount;
			}

			aux.resolved = entries;
			return entries;
		}

		Logging._warn(
			'Multiple saio entries that don\'t match the track runs or chunks are not supported; using the first'
			+ ' offset only.',
		);
	}

	if (aux.offset === null || aux.sampleCount === 0) {
		throw new Error('Incomplete saiz/saio info; cannot resolve encryption data.');
	}

	let totalSize = 0;
	if (aux.defaultSampleInfoSize > 0) {
		totalSize = aux.defaultSampleInfoSize * aux.sampleCount;
	} else {
		assert(aux.sampleSizes);
		for (let i = 0; i < aux.sampleCount; i++) {
			totalSize += aux.sampleSizes[i]!;
		}
	}

	let slice = reader.requestSlice(aux.offset, totalSize);
	if (isThenable(slice)) slice = await slice;
	if (!slice) {
		throw new Error('Failed to read auxiliary encryption info.');
	}

	// Each aux entry has the same byte layout as a senc entry: IV (of size ivSize, or the constant IV from tenc
	// when ivSize is 0), then optionally subsample count + [clearLen, protectedLen] pairs. Subsamples are present
	// iff the entry is larger than the IV. Like in senc, a sample's 'seig' group overrides tenc's IV parameters.
	const entries: SampleEncryptionInfo[] = [];
	for (let i = 0; i < aux.sampleCount; i++) {
		const entrySize = aux.defaultSampleInfoSize > 0
			? aux.defaultSampleInfoSize
			: aux.sampleSizes![i]!;
		const entryEndPos = slice.filePos + entrySize;

		const group = getEncryptionGroup(i);
		const ivSize = group ? group.perSampleIvSize : encryptionInfo.defaultPerSampleIvSize;
		const constantIv = group ? group.constantIv : encryptionInfo.defaultConstantIv;
		if (ivSize === null) {
			throw new Error('Invalid file: encrypted track is missing its tenc box.');
		}
		if (entrySize < ivSize || entrySize === ivSize + 1) {
			throw new Error('Invalid file: sample auxiliary information doesn\'t match its size in saiz.');
		}

		const iv = new Uint8Array(16);
		if (ivSize > 0) {
			iv.set(readBytes(slice, ivSize), 0);
		} else if (constantIv) {
			iv.set(constantIv, 0);
		} else if (!group || group.isProtected) {
			throw new Error('Invalid file: encrypted sample has no IV.');
		}

		let subsamples: { clearLen: number; protectedLen: number }[] | null = null;
		if (entrySize > ivSize) {
			const subsampleCount = readU16Be(slice);
			if (entryEndPos - slice.filePos < 6 * subsampleCount) {
				throw new Error('Invalid file: sample auxiliary information doesn\'t match its size in saiz.');
			}

			subsamples = [];
			for (let j = 0; j < subsampleCount; j++) {
				const clearLen = readU16Be(slice);
				const protectedLen = readU32Be(slice);
				subsamples.push({ clearLen, protectedLen });
			}
		}

		entries.push({ iv, subsamples });
		slice.filePos = entryEndPos;
	}

	aux.resolved = entries;
	return entries;
};

/** The track's encryption parameters, as overridden by a 'seig' sample group entry */
const applySampleGroupEncryption = (
	encryptionInfo: TrackEncryptionInfo,
	group: SampleGroupEncryption,
): TrackEncryptionInfo => ({
	...encryptionInfo,
	defaultKid: group.kid,
	defaultIsProtected: group.isProtected,
	defaultPerSampleIvSize: group.perSampleIvSize,
	defaultConstantIv: group.constantIv,
	defaultCryptByteBlock: group.cryptByteBlock,
	defaultSkipByteBlock: group.skipByteBlock,
});

/** The 'seig' sample group entry of a sample of a non-fragmented track (ISO/IEC 23001-7, 6), if any */
const getSampleTableEncryptionGroup = (track: InternalTrack, sampleIndex: number) => {
	const runIndex = binarySearchLessOrEqual(track.encryptionGroupRuns, sampleIndex, x => x.startIndex);
	const run = runIndex === -1 ? null : track.encryptionGroupRuns[runIndex]!;
	if (!run || sampleIndex >= run.startIndex + run.sampleCount) {
		// Samples that no run covers get the default entry of a version 2 sample group description
		return track.defaultEncryptionGroup;
	}

	// Index 0 means no group
	return run.groupDescriptionIndex > 0 ? track.encryptionGroups[run.groupDescriptionIndex - 1] ?? null : null;
};

/** Maps a traf's samples to their 'seig' sample group entries (ISO/IEC 23001-7, 6). */
const assignEncryptionGroups = (track: InternalTrack, state: FragmentTrackState, trackData: FragmentTrackData) => {
	// Samples that no sbgp entry covers get the default entry of a version 2 sample group description, the traf's
	// before the track's (ISO/IEC 14496-12 8.9.2.1). Samples mapped to index 0 explicitly belong to no group.
	const defaultGroup = state.defaultEncryptionGroup ?? track.defaultEncryptionGroup;
	for (const sample of trackData.samples) {
		sample.encryptionGroup = defaultGroup;
	}

	let sampleIndex = 0;
	for (const run of state.encryptionGroupRuns ?? []) {
		// Indices above 0x10000 refer to the traf's own sample group description, the others to the track's
		const index = run.groupDescriptionIndex;
		const group = index > 0x10000
			? state.encryptionGroups[index - 0x10001] ?? null
			: index > 0
				? track.encryptionGroups[index - 1] ?? null
				: null;

		const end = Math.min(sampleIndex + run.sampleCount, trackData.samples.length);
		for (; sampleIndex < end; sampleIndex++) {
			trackData.samples[sampleIndex]!.encryptionGroup = group;
		}
	}
};

/** Reads the per-sample IVs and subsamples of a traf's senc box. */
const readSampleEncryptionBox = (slice: FileSlice, track: InternalTrack, trackData: FragmentTrackData) => {
	assert(track.encryptionInfo);

	slice.skip(1); // Version
	const flags = readU24Be(slice);
	const useSubsamples = Boolean(flags & 0x000002);

	const sampleCount = readU32Be(slice);

	for (let i = 0; i < Math.min(sampleCount, trackData.samples.length); i++) {
		const sample = trackData.samples[i]!;
		const group = sample.encryptionGroup;
		const ivSize = group ? group.perSampleIvSize : track.encryptionInfo.defaultPerSampleIvSize;
		const constantIv = group ? group.constantIv : track.encryptionInfo.defaultConstantIv;
		if (ivSize === null) {
			throw new Error('Invalid file: encrypted track is missing its tenc box.');
		}

		// Normalize the IV to 16 bytes so downstream code can assume a full-length buffer. For CTR with
		// an 8-byte per-sample IV the lower 8 bytes are zero (that's the CENC spec's block counter start);
		// for CBC/cbcs the IV is always 16 bytes by spec.
		const iv = new Uint8Array(16);
		if (ivSize > 0) {
			iv.set(readBytes(slice, ivSize), 0);
		} else if (constantIv) {
			iv.set(constantIv, 0);
		} else if (!group || group.isProtected) {
			throw new Error('Invalid file: encrypted sample has no IV.');
		}

		let subsamples: SampleEncryptionInfo['subsamples'] = null;
		if (useSubsamples) {
			const subsampleCount = readU16Be(slice);
			subsamples = [];
			for (let j = 0; j < subsampleCount; j++) {
				const clearLen = readU16Be(slice);
				const protectedLen = readU32Be(slice);
				subsamples.push({ clearLen, protectedLen });
			}
		}

		sample.encryption = { iv, subsamples };
	}
};

const getDefaultSampleEncryption = (encryptionInfo: TrackEncryptionInfo): SampleEncryptionInfo | null => {
	if (!encryptionInfo.defaultConstantIv) {
		return null;
	}

	return {
		iv: encryptionInfo.defaultConstantIv,
		subsamples: null,
	};
};

/**
 * Throws for a track whose samples are all encrypted (encv/enca) but not with a scheme we can decrypt, or without a
 * scheme at all, rather than letting the ciphertext pass as media data. Tracks that also have clear sample
 * descriptions (clear lead) are left alone.
 */
const assertProtectionSchemeIsSupported = (track: InternalTrack) => {
	if (
		track.encryptionInfo === null
		&& track.encryptedSampleDescriptions.length > 0
		&& !track.encryptedSampleDescriptions.includes(false)
	) {
		throw new Error(
			'Encrypted media samples use an unsupported protection scheme; only cenc, cens and cbcs can be decrypted.',
		);
	}
};

const decryptSample = async (
	track: InternalTrack,
	sampleEncryption: SampleEncryptionInfo,
	data: Uint8Array,
	fragment: Fragment | null,
	encryptionInfo = track.encryptionInfo,
): Promise<Uint8Array> => {
	assert(encryptionInfo);
	if (encryptionInfo.defaultKid === null) {
		throw new Error('Invalid file: encrypted track is missing its tenc box.');
	}

	const keyId = encryptionInfo.defaultKid;
	let keyBytes: Uint8Array;

	const cacheEntry = track.demuxer.decryptionKeyCache.get(keyId);
	if (cacheEntry) {
		keyBytes = await cacheEntry;
	} else {
		if (!track.demuxer.input._formatOptions.isobmff?.resolveKeyId) {
			throw new Error(
				'Encrypted media samples encountered. To decrypt them, please provide a callback for'
				+ ' InputOptions.formatOptions.isobmff.resolveKeyId.',
			);
		}

		const promise = (async () => {
			// The boxes that apply to this key ID, from the moov box and the fragment
			const psshBoxes = [
				...track.demuxer.psshBoxes,
				...(fragment?.psshBoxes ?? []),
			].filter(x => x.keyIds === null || x.keyIds.includes(keyId));

			// Filter out duplicates
			for (let i = 0; i < psshBoxes.length - 1; i++) {
				for (let j = i + 1; j < psshBoxes.length; j++) {
					if (psshBoxesAreEqual(psshBoxes[i]!, psshBoxes[j]!)) {
						psshBoxes.splice(j, 1);
						j--;
					}
				}
			}

			const keyResult = await track.demuxer.input._formatOptions.isobmff!.resolveKeyId!({ keyId, psshBoxes });

			if (!(
				(typeof keyResult === 'string' && keyResult.length === 32 && HEX_STRING_REGEX.test(keyResult))
				|| (keyResult instanceof Uint8Array && keyResult.byteLength === 16)
			)) {
				throw new TypeError(
					'resolveKeyId must return a 32-character hex string or a 16-byte Uint8Array containing the'
					+ ' decryption key.',
				);
			}

			return keyResult instanceof Uint8Array
				? keyResult
				: hexStringToBytes(keyResult);
		})();

		track.demuxer.decryptionKeyCache.set(keyId, promise);
		// A failed resolution (an unreachable license server, for example) is tried again by the next sample
		promise.catch(() => {
			if (track.demuxer.decryptionKeyCache.get(keyId) === promise) {
				track.demuxer.decryptionKeyCache.delete(keyId);
			}
		});
		keyBytes = await promise;
	}

	if (encryptionInfo.scheme === 'cenc' || encryptionInfo.scheme === 'cens') {
		return decryptCtr(keyBytes, encryptionInfo, sampleEncryption, data);
	} else {
		return decryptCbcs(keyBytes, encryptionInfo, sampleEncryption, data);
	}
};

/**
 * For a sample of an encrypted track without encryption info (no senc, saiz/saio or constant IV), throws if it's
 * protected, since its IV is lost, rather than letting the ciphertext pass as media data. Samples of a clear sample
 * description (clear lead), or that tenc or sample groups can make unprotected, are left alone.
 */
const assertUnprotectedSample = (
	track: InternalTrack,
	encryptionInfo: TrackEncryptionInfo,
	usesEncryptedSampleDescription: boolean,
) => {
	if (
		usesEncryptedSampleDescription
		&& encryptionInfo.defaultIsProtected !== false
	) {
		throw new Error(
			'Encrypted media samples have no encryption info (senc box, or saiz and saio boxes), so they can\'t be'
			+ ' decrypted.',
		);
	}
};

const decryptCtr = async (
	key: Uint8Array,
	encryptionInfo: TrackEncryptionInfo,
	sampleEncryption: SampleEncryptionInfo,
	data: Uint8Array,
) => {
	const counter = new Uint8Array(16);
	counter.set(sampleEncryption.iv, 0);

	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		key as BufferSource,
		{ name: 'AES-CTR' },
		false,
		['decrypt'],
	);

	const cryptApply = async (input: Uint8Array) => {
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-CTR', counter, length: 64 },
			cryptoKey,
			input as BufferSource,
		);

		return new Uint8Array(plaintext);
	};

	if (!sampleEncryption.subsamples || sampleEncryption.subsamples.length === 0) {
		// Whole sample is protected, no pattern. Like FFmpeg, also for an entry that lists no subsamples.
		return cryptApply(data);
	}

	assert(encryptionInfo.defaultCryptByteBlock !== null && encryptionInfo.defaultSkipByteBlock !== null);
	const cryptRanges = collectCryptRanges(
		sampleEncryption.subsamples,
		encryptionInfo.defaultCryptByteBlock,
		encryptionInfo.defaultSkipByteBlock,
		data.length,
	);

	// Concatenate all crypt ranges into a single buffer so the continuous CTR counter behavior is preserved
	let totalCryptLen = 0;
	for (const range of cryptRanges) {
		for (const seg of range.perSubsample) {
			totalCryptLen += seg.length;
		}
	}
	const cryptBuffer = new Uint8Array(totalCryptLen);
	let writePos = 0;
	for (const range of cryptRanges) {
		for (const seg of range.perSubsample) {
			cryptBuffer.set(data.subarray(seg.offset, seg.offset + seg.length), writePos);
			writePos += seg.length;
		}
	}

	const plain = await cryptApply(cryptBuffer);

	// Now let's build the output
	const output = new Uint8Array(data);
	let readPos = 0;
	for (const range of cryptRanges) {
		for (const seg of range.perSubsample) {
			output.set(plain.subarray(readPos, readPos + seg.length), seg.offset);
			readPos += seg.length;
		}
	}

	return output;
};

const decryptCbcs = (
	key: Uint8Array,
	encryptionInfo: TrackEncryptionInfo,
	sampleEncryption: SampleEncryptionInfo,
	data: Uint8Array,
) => {
	const ctx = new Aes128CbcContext();
	ctx.init({ key, iv: sampleEncryption.iv });

	const cryptByteBlock = encryptionInfo.defaultCryptByteBlock;
	const skipByteBlock = encryptionInfo.defaultSkipByteBlock;
	assert(cryptByteBlock !== null && skipByteBlock !== null);

	if (!sampleEncryption.subsamples || sampleEncryption.subsamples.length === 0) {
		// Whole-sample encryption: straightforward CBC over floor(size / 16) blocks, any trailing bytes stay clear.
		// Like FFmpeg, also for an entry that lists no subsamples.
		const output = new Uint8Array(data);
		const numBlocks = Math.floor(data.length / 16);

		for (let b = 0; b < numBlocks; b++) {
			const off = b * 16;
			ctx.in.set(data.subarray(off, off + 16));
			ctx.decrypt();
			output.set(ctx.out, off);
		}

		return output;
	}

	const output = new Uint8Array(data);

	// Pattern decryption: IV is reset at the start of each subsample. Within a subsample, the CBC chain continues
	// across skipped blocks (the IV after a crypt group carries over to the next crypt group's first block).
	// The pattern 0:0 encrypts every complete block, like 1:0 (as in Chromium and Shaka Packager)
	const encryptsAllBlocks = cryptByteBlock === 0 && skipByteBlock === 0;
	const cryptRanges = collectCryptRanges(
		sampleEncryption.subsamples,
		encryptsAllBlocks ? 1 : cryptByteBlock,
		encryptsAllBlocks ? 0 : skipByteBlock,
		data.length,
	);
	const ivView = new DataView(sampleEncryption.iv.buffer, sampleEncryption.iv.byteOffset, 16);

	for (const range of cryptRanges) {
		// Reset IV per subsample
		ctx.iv[0] = ivView.getUint32(0, false);
		ctx.iv[1] = ivView.getUint32(4, false);
		ctx.iv[2] = ivView.getUint32(8, false);
		ctx.iv[3] = ivView.getUint32(12, false);

		for (const seg of range.perSubsample) {
			// Decrypt length / 16 blocks at this offset
			const numBlocks = seg.length / 16;

			for (let b = 0; b < numBlocks; b++) {
				const offset = seg.offset + b * 16;
				ctx.in.set(data.subarray(offset, offset + 16));
				ctx.decrypt();
				output.set(ctx.out, offset);
			}
		}
	}

	return output;
};

const collectCryptRanges = (
	subsamples: { clearLen: number; protectedLen: number }[],
	cryptByteBlock: number,
	skipByteBlock: number,
	dataLength: number,
) => {
	const ranges: { perSubsample: { offset: number; length: number }[] }[] = [];
	const hasPattern = cryptByteBlock !== 0 || skipByteBlock !== 0;

	let cursor = 0;
	for (const subsample of subsamples) {
		if (cursor + subsample.clearLen + subsample.protectedLen > dataLength) {
			throw new Error('Invalid encryption info: subsamples exceed the sample size.');
		}

		cursor += subsample.clearLen;

		const perSubsample: { offset: number; length: number }[] = [];

		if (!hasPattern) {
			if (subsample.protectedLen > 0) {
				perSubsample.push({ offset: cursor, length: subsample.protectedLen });
			}
			cursor += subsample.protectedLen;
		} else {
			let remaining = subsample.protectedLen;
			let pos = cursor;
			while (remaining > 0) {
				// The last pattern may end inside the crypt blocks: its complete 16-byte blocks are still encrypted
				// and only a trailing partial block stays clear (ISO/IEC 23001-7 10.4.2, like Chromium and Shaka)
				const cryptBytes = Math.min(16 * cryptByteBlock, 16 * Math.floor(remaining / 16));
				if (cryptBytes === 0) {
					break;
				}

				perSubsample.push({ offset: pos, length: cryptBytes });
				pos += cryptBytes;
				remaining -= cryptBytes;

				const skipBytes = Math.min(16 * skipByteBlock, remaining);
				pos += skipBytes;
				remaining -= skipBytes;
			}
			cursor += subsample.protectedLen;
		}

		ranges.push({ perSubsample });
	}

	return ranges;
};
