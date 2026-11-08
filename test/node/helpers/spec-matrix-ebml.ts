// Matroska/WebM schema subset (RFC 9559 Section 5 + ebml_matroska.xml, RFC 8794 Section 11.2) and an EBML validator
// used by the normative compliance tests. Chapters are left out since Mediabunny neither reads nor writes them.

type ElementType = 'u' | 'i' | 'f' | 'd' | 's' | '8' | 'b' | 'm';

export type SchemaElement = {
	name: string;
	id: number;
	/** Path of the parent, '/'-separated; '' for root elements. */
	parent: string;
	type: ElementType;
	minOccurs: number;
	maxOccurs: number | null;
	range: string | null;
	default: string | null;
	length: string | null;
	minver: number;
	maxver: number | null;
	/** Whether the element is part of WebM (ebml_matroska.xml webm extension and the WebM container page). */
	webm: boolean;
	recursive: boolean;
};

type Row = [
	name: string,
	id: number,
	parent: string,
	type: ElementType,
	minOccurs: number,
	maxOccurs: number | null,
	range: string | null,
	defaultValue: string | null,
	length: string | null,
	minver: number,
	maxver: number | null,
	webm: number,
	recursive?: number,
];

const CONTENT_ENCODING = '/Segment/Tracks/TrackEntry/ContentEncodings/ContentEncoding';

// Generated from ebml_matroska.xml (RFC 9559) and the WebM container guidelines' element table
const ROWS: Row[] = [
	['EBML', 0x1a45dfa3, '', 'm', 1, 1, null, null, null, 1, null, 1],
	['EBMLVersion', 0x4286, '/EBML', 'u', 1, 1, 'not 0', '1', null, 1, null, 1],
	['EBMLReadVersion', 0x42f7, '/EBML', 'u', 1, 1, '1', '1', null, 1, null, 1],
	['DocType', 0x4282, '/EBML', 's', 1, 1, null, null, '>0', 1, null, 1],
	['DocTypeVersion', 0x4287, '/EBML', 'u', 1, 1, 'not 0', '1', null, 1, null, 1],
	['DocTypeReadVersion', 0x4285, '/EBML', 'u', 1, 1, 'not 0', '1', null, 1, null, 1],
	['DocTypeExtension', 0x4281, '/EBML', 'm', 0, null, null, null, null, 1, null, 0],
	['DocTypeExtensionName', 0x4283, '/EBML/DocTypeExtension', 's', 1, 1, null, null, '>0', 1, null, 0],
	['DocTypeExtensionVersion', 0x4284, '/EBML/DocTypeExtension', 'u', 1, 1, 'not 0', null, null, 1, null, 0],
	['EBMLMaxIDLength', 0x42f2, '/EBML', 'u', 1, 1, '4', '4', null, 1, null, 1],
	['EBMLMaxSizeLength', 0x42f3, '/EBML', 'u', 1, 1, '1-8', '8', null, 1, null, 1],
	['Segment', 0x18538067, '', 'm', 1, 1, null, null, null, 1, null, 1],
	['SeekHead', 0x114d9b74, '/Segment', 'm', 0, 2, null, null, null, 1, null, 1],
	['Seek', 0x4dbb, '/Segment/SeekHead', 'm', 1, null, null, null, null, 1, null, 1],
	['SeekID', 0x53ab, '/Segment/SeekHead/Seek', 'b', 1, 1, null, null, '4', 1, null, 1],
	['SeekPosition', 0x53ac, '/Segment/SeekHead/Seek', 'u', 1, 1, null, null, null, 1, null, 1],
	['Info', 0x1549a966, '/Segment', 'm', 1, 1, null, null, null, 1, null, 1],
	['SegmentUUID', 0x73a4, '/Segment/Info', 'b', 0, 1, null, null, '16', 1, null, 0],
	['SegmentFilename', 0x7384, '/Segment/Info', '8', 0, 1, null, null, null, 1, null, 0],
	['PrevUUID', 0x3cb923, '/Segment/Info', 'b', 0, 1, null, null, '16', 1, null, 0],
	['PrevFilename', 0x3c83ab, '/Segment/Info', '8', 0, 1, null, null, null, 1, null, 0],
	['NextUUID', 0x3eb923, '/Segment/Info', 'b', 0, 1, null, null, '16', 1, null, 0],
	['NextFilename', 0x3e83bb, '/Segment/Info', '8', 0, 1, null, null, null, 1, null, 0],
	['SegmentFamily', 0x4444, '/Segment/Info', 'b', 0, null, null, null, '16', 1, null, 0],
	['ChapterTranslate', 0x6924, '/Segment/Info', 'm', 0, null, null, null, null, 1, null, 0],
	['ChapterTranslateID', 0x69a5, '/Segment/Info/ChapterTranslate', 'b', 1, 1, null, null, null, 1, null, 0],
	['ChapterTranslateCodec', 0x69bf, '/Segment/Info/ChapterTranslate', 'u', 1, 1, null, null, null, 1, null, 0],
	[
		'ChapterTranslateEditionUID', 0x69fc, '/Segment/Info/ChapterTranslate', 'u',
		0, null, null, null, null, 1, null, 0,
	],
	['TimestampScale', 0x2ad7b1, '/Segment/Info', 'u', 1, 1, 'not 0', '1000000', null, 1, null, 1],
	['Duration', 0x4489, '/Segment/Info', 'f', 0, 1, '> 0x0p+0', null, null, 1, null, 1],
	['DateUTC', 0x4461, '/Segment/Info', 'd', 0, 1, null, null, null, 1, null, 1],
	['Title', 0x7ba9, '/Segment/Info', '8', 0, 1, null, null, null, 1, null, 1],
	['MuxingApp', 0x4d80, '/Segment/Info', '8', 1, 1, null, null, null, 1, null, 1],
	['WritingApp', 0x5741, '/Segment/Info', '8', 1, 1, null, null, null, 1, null, 1],
	['Cluster', 0x1f43b675, '/Segment', 'm', 0, null, null, null, null, 1, null, 1],
	['Timestamp', 0xe7, '/Segment/Cluster', 'u', 1, 1, null, null, null, 1, null, 1],
	['SilentTracks', 0x5854, '/Segment/Cluster', 'm', 0, 1, null, null, null, 0, 0, 0],
	['SilentTrackNumber', 0x58d7, '/Segment/Cluster/SilentTracks', 'u', 0, null, null, null, null, 0, 0, 0],
	['Position', 0xa7, '/Segment/Cluster', 'u', 0, 1, null, null, null, 1, 4, 0],
	['PrevSize', 0xab, '/Segment/Cluster', 'u', 0, 1, null, null, null, 1, null, 1],
	['SimpleBlock', 0xa3, '/Segment/Cluster', 'b', 0, null, null, null, null, 2, null, 1],
	['BlockGroup', 0xa0, '/Segment/Cluster', 'm', 0, null, null, null, null, 1, null, 1],
	['Block', 0xa1, '/Segment/Cluster/BlockGroup', 'b', 1, 1, null, null, null, 1, null, 1],
	['BlockVirtual', 0xa2, '/Segment/Cluster/BlockGroup', 'b', 0, 1, null, null, null, 0, 0, 0],
	['BlockAdditions', 0x75a1, '/Segment/Cluster/BlockGroup', 'm', 0, 1, null, null, null, 1, null, 1],
	['BlockMore', 0xa6, '/Segment/Cluster/BlockGroup/BlockAdditions', 'm', 1, null, null, null, null, 1, null, 1],
	[
		'BlockAdditional', 0xa5, '/Segment/Cluster/BlockGroup/BlockAdditions/BlockMore', 'b',
		1, 1, null, null, null, 1, null, 1,
	],
	[
		'BlockAddID', 0xee, '/Segment/Cluster/BlockGroup/BlockAdditions/BlockMore', 'u',
		1, 1, 'not 0', '1', null, 1, null, 1,
	],
	['BlockDuration', 0x9b, '/Segment/Cluster/BlockGroup', 'u', 0, 1, null, null, null, 1, null, 1],
	['ReferencePriority', 0xfa, '/Segment/Cluster/BlockGroup', 'u', 1, 1, null, '0', null, 1, null, 0],
	['ReferenceBlock', 0xfb, '/Segment/Cluster/BlockGroup', 'i', 0, null, null, null, null, 1, null, 1],
	['ReferenceVirtual', 0xfd, '/Segment/Cluster/BlockGroup', 'i', 0, 1, null, null, null, 0, 0, 0],
	['CodecState', 0xa4, '/Segment/Cluster/BlockGroup', 'b', 0, 1, null, null, null, 2, null, 0],
	['DiscardPadding', 0x75a2, '/Segment/Cluster/BlockGroup', 'i', 0, 1, null, null, null, 4, null, 1],
	['Slices', 0x8e, '/Segment/Cluster/BlockGroup', 'm', 0, 1, null, null, null, 0, 0, 0],
	['TimeSlice', 0xe8, '/Segment/Cluster/BlockGroup/Slices', 'm', 0, null, null, null, null, 0, 0, 0],
	['LaceNumber', 0xcc, '/Segment/Cluster/BlockGroup/Slices/TimeSlice', 'u', 0, 1, null, null, null, 0, 0, 0],
	['FrameNumber', 0xcd, '/Segment/Cluster/BlockGroup/Slices/TimeSlice', 'u', 0, 1, null, '0', null, 0, 0, 0],
	['BlockAdditionID', 0xcb, '/Segment/Cluster/BlockGroup/Slices/TimeSlice', 'u', 0, 1, null, '0', null, 0, 0, 0],
	['Delay', 0xce, '/Segment/Cluster/BlockGroup/Slices/TimeSlice', 'u', 0, 1, null, '0', null, 0, 0, 0],
	['SliceDuration', 0xcf, '/Segment/Cluster/BlockGroup/Slices/TimeSlice', 'u', 0, 1, null, '0', null, 0, 0, 0],
	['ReferenceFrame', 0xc8, '/Segment/Cluster/BlockGroup', 'm', 0, 1, null, null, null, 0, 0, 0],
	['ReferenceOffset', 0xc9, '/Segment/Cluster/BlockGroup/ReferenceFrame', 'u', 1, 1, null, null, null, 0, 0, 0],
	['ReferenceTimestamp', 0xca, '/Segment/Cluster/BlockGroup/ReferenceFrame', 'u', 1, 1, null, null, null, 0, 0, 0],
	['EncryptedBlock', 0xaf, '/Segment/Cluster', 'b', 0, null, null, null, null, 0, 0, 0],
	['Tracks', 0x1654ae6b, '/Segment', 'm', 0, 1, null, null, null, 1, null, 1],
	['TrackEntry', 0xae, '/Segment/Tracks', 'm', 1, null, null, null, null, 1, null, 1],
	['TrackNumber', 0xd7, '/Segment/Tracks/TrackEntry', 'u', 1, 1, 'not 0', null, null, 1, null, 1],
	['TrackUID', 0x73c5, '/Segment/Tracks/TrackEntry', 'u', 1, 1, 'not 0', null, null, 1, null, 1],
	['TrackType', 0x83, '/Segment/Tracks/TrackEntry', 'u', 1, 1, 'not 0', null, null, 1, null, 1],
	['FlagEnabled', 0xb9, '/Segment/Tracks/TrackEntry', 'u', 1, 1, '0-1', '1', null, 2, null, 1],
	['FlagDefault', 0x88, '/Segment/Tracks/TrackEntry', 'u', 1, 1, '0-1', '1', null, 1, null, 1],
	['FlagForced', 0x55aa, '/Segment/Tracks/TrackEntry', 'u', 1, 1, '0-1', '0', null, 1, null, 1],
	['FlagHearingImpaired', 0x55ab, '/Segment/Tracks/TrackEntry', 'u', 0, 1, '0-1', null, null, 4, null, 0],
	['FlagVisualImpaired', 0x55ac, '/Segment/Tracks/TrackEntry', 'u', 0, 1, '0-1', null, null, 4, null, 0],
	['FlagTextDescriptions', 0x55ad, '/Segment/Tracks/TrackEntry', 'u', 0, 1, '0-1', null, null, 4, null, 0],
	['FlagOriginal', 0x55ae, '/Segment/Tracks/TrackEntry', 'u', 0, 1, '0-1', null, null, 4, null, 0],
	['FlagCommentary', 0x55af, '/Segment/Tracks/TrackEntry', 'u', 0, 1, '0-1', null, null, 4, null, 0],
	['FlagLacing', 0x9c, '/Segment/Tracks/TrackEntry', 'u', 1, 1, '0-1', '1', null, 1, null, 1],
	['MinCache', 0x6de7, '/Segment/Tracks/TrackEntry', 'u', 1, 1, null, '0', null, 0, 0, 0],
	['MaxCache', 0x6df8, '/Segment/Tracks/TrackEntry', 'u', 0, 1, null, null, null, 0, 0, 0],
	['DefaultDuration', 0x23e383, '/Segment/Tracks/TrackEntry', 'u', 0, 1, 'not 0', null, null, 1, null, 1],
	[
		'DefaultDecodedFieldDuration', 0x234e7a, '/Segment/Tracks/TrackEntry', 'u',
		0, 1, 'not 0', null, null, 4, null, 0,
	],
	['TrackTimestampScale', 0x23314f, '/Segment/Tracks/TrackEntry', 'f', 1, 1, '> 0x0p+0', '0x1p+0', null, 1, 3, 0],
	['TrackOffset', 0x537f, '/Segment/Tracks/TrackEntry', 'i', 0, 1, null, '0', null, 0, 0, 0],
	['MaxBlockAdditionID', 0x55ee, '/Segment/Tracks/TrackEntry', 'u', 1, 1, null, '0', null, 1, null, 1],
	['BlockAdditionMapping', 0x41e4, '/Segment/Tracks/TrackEntry', 'm', 0, null, null, null, null, 4, null, 1],
	[
		'BlockAddIDValue', 0x41f0, '/Segment/Tracks/TrackEntry/BlockAdditionMapping', 'u',
		0, 1, '>=2', null, null, 4, null, 1,
	],
	[
		'BlockAddIDName', 0x41a4, '/Segment/Tracks/TrackEntry/BlockAdditionMapping', 's',
		0, 1, null, null, null, 4, null, 1,
	],
	[
		'BlockAddIDType', 0x41e7, '/Segment/Tracks/TrackEntry/BlockAdditionMapping', 'u',
		1, 1, null, '0', null, 4, null, 1,
	],
	[
		'BlockAddIDExtraData', 0x41ed, '/Segment/Tracks/TrackEntry/BlockAdditionMapping', 'b',
		0, 1, null, null, null, 4, null, 1,
	],
	['Name', 0x536e, '/Segment/Tracks/TrackEntry', '8', 0, 1, null, null, null, 1, null, 1],
	['Language', 0x22b59c, '/Segment/Tracks/TrackEntry', 's', 1, 1, null, 'eng', null, 1, null, 1],
	['LanguageBCP47', 0x22b59d, '/Segment/Tracks/TrackEntry', 's', 0, 1, null, null, null, 4, null, 0],
	['CodecID', 0x86, '/Segment/Tracks/TrackEntry', 's', 1, 1, null, null, null, 1, null, 1],
	['CodecPrivate', 0x63a2, '/Segment/Tracks/TrackEntry', 'b', 0, 1, null, null, null, 1, null, 1],
	['CodecName', 0x258688, '/Segment/Tracks/TrackEntry', '8', 0, 1, null, null, null, 1, null, 1],
	['AttachmentLink', 0x7446, '/Segment/Tracks/TrackEntry', 'u', 0, 1, 'not 0', null, null, 1, 3, 0],
	['CodecSettings', 0x3a9697, '/Segment/Tracks/TrackEntry', '8', 0, 1, null, null, null, 0, 0, 0],
	['CodecInfoURL', 0x3b4040, '/Segment/Tracks/TrackEntry', 's', 0, null, null, null, null, 0, 0, 0],
	['CodecDownloadURL', 0x26b240, '/Segment/Tracks/TrackEntry', 's', 0, null, null, null, null, 0, 0, 0],
	['CodecDecodeAll', 0xaa, '/Segment/Tracks/TrackEntry', 'u', 1, 1, '0-1', '1', null, 1, 0, 0],
	['TrackOverlay', 0x6fab, '/Segment/Tracks/TrackEntry', 'u', 0, null, null, null, null, 1, 0, 0],
	['CodecDelay', 0x56aa, '/Segment/Tracks/TrackEntry', 'u', 1, 1, null, '0', null, 4, null, 1],
	['SeekPreRoll', 0x56bb, '/Segment/Tracks/TrackEntry', 'u', 1, 1, null, '0', null, 4, null, 1],
	['TrackTranslate', 0x6624, '/Segment/Tracks/TrackEntry', 'm', 0, null, null, null, null, 1, null, 0],
	[
		'TrackTranslateTrackID', 0x66a5, '/Segment/Tracks/TrackEntry/TrackTranslate', 'b',
		1, 1, null, null, null, 1, null, 0,
	],
	[
		'TrackTranslateCodec', 0x66bf, '/Segment/Tracks/TrackEntry/TrackTranslate', 'u',
		1, 1, null, null, null, 1, null, 0,
	],
	[
		'TrackTranslateEditionUID', 0x66fc, '/Segment/Tracks/TrackEntry/TrackTranslate', 'u',
		0, null, null, null, null, 1, null, 0,
	],
	['Video', 0xe0, '/Segment/Tracks/TrackEntry', 'm', 0, 1, null, null, null, 1, null, 1],
	['FlagInterlaced', 0x9a, '/Segment/Tracks/TrackEntry/Video', 'u', 1, 1, null, '0', null, 2, null, 1],
	['FieldOrder', 0x9d, '/Segment/Tracks/TrackEntry/Video', 'u', 1, 1, null, '2', null, 4, null, 0],
	['StereoMode', 0x53b8, '/Segment/Tracks/TrackEntry/Video', 'u', 1, 1, null, '0', null, 3, null, 1],
	['AlphaMode', 0x53c0, '/Segment/Tracks/TrackEntry/Video', 'u', 1, 1, null, '0', null, 3, null, 1],
	['OldStereoMode', 0x53b9, '/Segment/Tracks/TrackEntry/Video', 'u', 0, 1, null, null, null, 1, 2, 0],
	['PixelWidth', 0xb0, '/Segment/Tracks/TrackEntry/Video', 'u', 1, 1, 'not 0', null, null, 1, null, 1],
	['PixelHeight', 0xba, '/Segment/Tracks/TrackEntry/Video', 'u', 1, 1, 'not 0', null, null, 1, null, 1],
	['PixelCropBottom', 0x54aa, '/Segment/Tracks/TrackEntry/Video', 'u', 1, 1, null, '0', null, 1, null, 1],
	['PixelCropTop', 0x54bb, '/Segment/Tracks/TrackEntry/Video', 'u', 1, 1, null, '0', null, 1, null, 1],
	['PixelCropLeft', 0x54cc, '/Segment/Tracks/TrackEntry/Video', 'u', 1, 1, null, '0', null, 1, null, 1],
	['PixelCropRight', 0x54dd, '/Segment/Tracks/TrackEntry/Video', 'u', 1, 1, null, '0', null, 1, null, 1],
	['DisplayWidth', 0x54b0, '/Segment/Tracks/TrackEntry/Video', 'u', 0, 1, 'not 0', null, null, 1, null, 1],
	['DisplayHeight', 0x54ba, '/Segment/Tracks/TrackEntry/Video', 'u', 0, 1, 'not 0', null, null, 1, null, 1],
	['DisplayUnit', 0x54b2, '/Segment/Tracks/TrackEntry/Video', 'u', 1, 1, null, '0', null, 1, null, 1],
	['AspectRatioType', 0x54b3, '/Segment/Tracks/TrackEntry/Video', 'u', 0, 1, null, '0', null, 0, 0, 1],
	['UncompressedFourCC', 0x2eb524, '/Segment/Tracks/TrackEntry/Video', 'b', 0, 1, null, null, '4', 1, null, 0],
	['GammaValue', 0x2fb523, '/Segment/Tracks/TrackEntry/Video', 'f', 0, 1, '> 0x0p+0', null, null, 0, 0, 0],
	['FrameRate', 0x2383e3, '/Segment/Tracks/TrackEntry/Video', 'f', 0, 1, '> 0x0p+0', null, null, 0, 0, 0],
	['Colour', 0x55b0, '/Segment/Tracks/TrackEntry/Video', 'm', 0, 1, null, null, null, 4, null, 1],
	['MatrixCoefficients', 0x55b1, '/Segment/Tracks/TrackEntry/Video/Colour', 'u', 1, 1, null, '2', null, 4, null, 1],
	['BitsPerChannel', 0x55b2, '/Segment/Tracks/TrackEntry/Video/Colour', 'u', 1, 1, null, '0', null, 4, null, 1],
	[
		'ChromaSubsamplingHorz', 0x55b3, '/Segment/Tracks/TrackEntry/Video/Colour', 'u',
		0, 1, null, null, null, 4, null, 1,
	],
	[
		'ChromaSubsamplingVert', 0x55b4, '/Segment/Tracks/TrackEntry/Video/Colour', 'u',
		0, 1, null, null, null, 4, null, 1,
	],
	['CbSubsamplingHorz', 0x55b5, '/Segment/Tracks/TrackEntry/Video/Colour', 'u', 0, 1, null, null, null, 4, null, 1],
	['CbSubsamplingVert', 0x55b6, '/Segment/Tracks/TrackEntry/Video/Colour', 'u', 0, 1, null, null, null, 4, null, 1],
	['ChromaSitingHorz', 0x55b7, '/Segment/Tracks/TrackEntry/Video/Colour', 'u', 1, 1, null, '0', null, 4, null, 1],
	['ChromaSitingVert', 0x55b8, '/Segment/Tracks/TrackEntry/Video/Colour', 'u', 1, 1, null, '0', null, 4, null, 1],
	['Range', 0x55b9, '/Segment/Tracks/TrackEntry/Video/Colour', 'u', 1, 1, null, '0', null, 4, null, 1],
	[
		'TransferCharacteristics', 0x55ba, '/Segment/Tracks/TrackEntry/Video/Colour', 'u',
		1, 1, null, '2', null, 4, null, 1,
	],
	['Primaries', 0x55bb, '/Segment/Tracks/TrackEntry/Video/Colour', 'u', 1, 1, null, '2', null, 4, null, 1],
	['MaxCLL', 0x55bc, '/Segment/Tracks/TrackEntry/Video/Colour', 'u', 0, 1, null, null, null, 4, null, 1],
	['MaxFALL', 0x55bd, '/Segment/Tracks/TrackEntry/Video/Colour', 'u', 0, 1, null, null, null, 4, null, 1],
	['MasteringMetadata', 0x55d0, '/Segment/Tracks/TrackEntry/Video/Colour', 'm', 0, 1, null, null, null, 4, null, 1],
	[
		'PrimaryRChromaticityX', 0x55d1, '/Segment/Tracks/TrackEntry/Video/Colour/MasteringMetadata', 'f',
		0, 1, '0x0p+0-0x1p+0', null, null, 4, null, 1,
	],
	[
		'PrimaryRChromaticityY', 0x55d2, '/Segment/Tracks/TrackEntry/Video/Colour/MasteringMetadata', 'f',
		0, 1, '0x0p+0-0x1p+0', null, null, 4, null, 1,
	],
	[
		'PrimaryGChromaticityX', 0x55d3, '/Segment/Tracks/TrackEntry/Video/Colour/MasteringMetadata', 'f',
		0, 1, '0x0p+0-0x1p+0', null, null, 4, null, 1,
	],
	[
		'PrimaryGChromaticityY', 0x55d4, '/Segment/Tracks/TrackEntry/Video/Colour/MasteringMetadata', 'f',
		0, 1, '0x0p+0-0x1p+0', null, null, 4, null, 1,
	],
	[
		'PrimaryBChromaticityX', 0x55d5, '/Segment/Tracks/TrackEntry/Video/Colour/MasteringMetadata', 'f',
		0, 1, '0x0p+0-0x1p+0', null, null, 4, null, 1,
	],
	[
		'PrimaryBChromaticityY', 0x55d6, '/Segment/Tracks/TrackEntry/Video/Colour/MasteringMetadata', 'f',
		0, 1, '0x0p+0-0x1p+0', null, null, 4, null, 1,
	],
	[
		'WhitePointChromaticityX', 0x55d7, '/Segment/Tracks/TrackEntry/Video/Colour/MasteringMetadata', 'f',
		0, 1, '0x0p+0-0x1p+0', null, null, 4, null, 1,
	],
	[
		'WhitePointChromaticityY', 0x55d8, '/Segment/Tracks/TrackEntry/Video/Colour/MasteringMetadata', 'f',
		0, 1, '0x0p+0-0x1p+0', null, null, 4, null, 1,
	],
	[
		'LuminanceMax', 0x55d9, '/Segment/Tracks/TrackEntry/Video/Colour/MasteringMetadata', 'f',
		0, 1, '>= 0x0p+0', null, null, 4, null, 1,
	],
	[
		'LuminanceMin', 0x55da, '/Segment/Tracks/TrackEntry/Video/Colour/MasteringMetadata', 'f',
		0, 1, '>= 0x0p+0', null, null, 4, null, 1,
	],
	['Projection', 0x7670, '/Segment/Tracks/TrackEntry/Video', 'm', 0, 1, null, null, null, 4, null, 1],
	['ProjectionType', 0x7671, '/Segment/Tracks/TrackEntry/Video/Projection', 'u', 1, 1, null, '0', null, 4, null, 1],
	[
		'ProjectionPrivate', 0x7672, '/Segment/Tracks/TrackEntry/Video/Projection', 'b',
		0, 1, null, null, null, 4, null, 1,
	],
	[
		'ProjectionPoseYaw', 0x7673, '/Segment/Tracks/TrackEntry/Video/Projection', 'f',
		1, 1, '>= -0xB4p+0, <= 0xB4p+0', '0x0p+0', null, 4, null, 1,
	],
	[
		'ProjectionPosePitch', 0x7674, '/Segment/Tracks/TrackEntry/Video/Projection', 'f',
		1, 1, '>= -0x5Ap+0, <= 0x5Ap+0', '0x0p+0', null, 4, null, 1,
	],
	[
		'ProjectionPoseRoll', 0x7675, '/Segment/Tracks/TrackEntry/Video/Projection', 'f',
		1, 1, '>= -0xB4p+0, <= 0xB4p+0', '0x0p+0', null, 4, null, 1,
	],
	['Audio', 0xe1, '/Segment/Tracks/TrackEntry', 'm', 0, 1, null, null, null, 1, null, 1],
	[
		'SamplingFrequency', 0xb5, '/Segment/Tracks/TrackEntry/Audio', 'f',
		1, 1, '> 0x0p+0', '0x1.f4p+12', null, 1, null, 1,
	],
	[
		'OutputSamplingFrequency', 0x78b5, '/Segment/Tracks/TrackEntry/Audio', 'f',
		0, 1, '> 0x0p+0', null, null, 1, null, 1,
	],
	['Channels', 0x9f, '/Segment/Tracks/TrackEntry/Audio', 'u', 1, 1, 'not 0', '1', null, 1, null, 1],
	['ChannelPositions', 0x7d7b, '/Segment/Tracks/TrackEntry/Audio', 'b', 0, 1, null, null, null, 0, 0, 0],
	['BitDepth', 0x6264, '/Segment/Tracks/TrackEntry/Audio', 'u', 0, 1, 'not 0', null, null, 1, null, 1],
	['Emphasis', 0x52f1, '/Segment/Tracks/TrackEntry/Audio', 'u', 1, 1, null, '0', null, 5, null, 0],
	['TrackOperation', 0xe2, '/Segment/Tracks/TrackEntry', 'm', 0, 1, null, null, null, 3, null, 0],
	[
		'TrackCombinePlanes', 0xe3, '/Segment/Tracks/TrackEntry/TrackOperation', 'm',
		0, 1, null, null, null, 3, null, 0,
	],
	[
		'TrackPlane', 0xe4, '/Segment/Tracks/TrackEntry/TrackOperation/TrackCombinePlanes', 'm',
		1, null, null, null, null, 3, null, 0,
	],
	[
		'TrackPlaneUID', 0xe5, '/Segment/Tracks/TrackEntry/TrackOperation/TrackCombinePlanes/TrackPlane', 'u',
		1, 1, 'not 0', null, null, 3, null, 0,
	],
	[
		'TrackPlaneType', 0xe6, '/Segment/Tracks/TrackEntry/TrackOperation/TrackCombinePlanes/TrackPlane', 'u',
		1, 1, null, null, null, 3, null, 0,
	],
	['TrackJoinBlocks', 0xe9, '/Segment/Tracks/TrackEntry/TrackOperation', 'm', 0, 1, null, null, null, 3, null, 0],
	[
		'TrackJoinUID', 0xed, '/Segment/Tracks/TrackEntry/TrackOperation/TrackJoinBlocks', 'u',
		1, null, 'not 0', null, null, 3, null, 0,
	],
	['TrickTrackUID', 0xc0, '/Segment/Tracks/TrackEntry', 'u', 0, 1, null, null, null, 0, 0, 0],
	['TrickTrackSegmentUID', 0xc1, '/Segment/Tracks/TrackEntry', 'b', 0, 1, null, null, '16', 0, 0, 0],
	['TrickTrackFlag', 0xc6, '/Segment/Tracks/TrackEntry', 'u', 0, 1, null, '0', null, 0, 0, 0],
	['TrickMasterTrackUID', 0xc7, '/Segment/Tracks/TrackEntry', 'u', 0, 1, null, null, null, 0, 0, 0],
	['TrickMasterTrackSegmentUID', 0xc4, '/Segment/Tracks/TrackEntry', 'b', 0, 1, null, null, '16', 0, 0, 0],
	['ContentEncodings', 0x6d80, '/Segment/Tracks/TrackEntry', 'm', 0, 1, null, null, null, 1, null, 1],
	[
		'ContentEncoding', 0x6240, '/Segment/Tracks/TrackEntry/ContentEncodings', 'm',
		1, null, null, null, null, 1, null, 1,
	],
	[
		'ContentEncodingOrder', 0x5031, '/Segment/Tracks/TrackEntry/ContentEncodings/ContentEncoding', 'u',
		1, 1, null, '0', null, 1, null, 1,
	],
	[
		'ContentEncodingScope', 0x5032, '/Segment/Tracks/TrackEntry/ContentEncodings/ContentEncoding', 'u',
		1, 1, 'not 0', '1', null, 1, null, 1,
	],
	[
		'ContentEncodingType', 0x5033, '/Segment/Tracks/TrackEntry/ContentEncodings/ContentEncoding', 'u',
		1, 1, null, '0', null, 1, null, 1,
	],
	[
		'ContentCompression', 0x5034, '/Segment/Tracks/TrackEntry/ContentEncodings/ContentEncoding', 'm',
		0, 1, null, null, null, 1, null, 0,
	],
	[
		'ContentCompAlgo', 0x4254, CONTENT_ENCODING + '/ContentCompression', 'u',
		1, 1, null, '0', null, 1, null, 0,
	],
	[
		'ContentCompSettings', 0x4255, CONTENT_ENCODING + '/ContentCompression', 'b',
		0, 1, null, null, null, 1, null, 0,
	],
	[
		'ContentEncryption', 0x5035, '/Segment/Tracks/TrackEntry/ContentEncodings/ContentEncoding', 'm',
		0, 1, null, null, null, 1, null, 1,
	],
	[
		'ContentEncAlgo', 0x47e1, '/Segment/Tracks/TrackEntry/ContentEncodings/ContentEncoding/ContentEncryption', 'u',
		1, 1, null, '0', null, 1, null, 1,
	],
	[
		'ContentEncKeyID', 0x47e2, '/Segment/Tracks/TrackEntry/ContentEncodings/ContentEncoding/ContentEncryption', 'b',
		0, 1, null, null, null, 1, null, 1,
	],
	[
		'ContentEncAESSettings', 0x47e7, CONTENT_ENCODING + '/ContentEncryption', 'm',
		0, 1, null, null, null, 4, null, 1,
	],
	[
		'AESSettingsCipherMode', 0x47e8, CONTENT_ENCODING + '/ContentEncryption/ContentEncAESSettings', 'u',
		1, 1, 'not 0', null, null, 4, null, 1,
	],
	[
		'ContentSignature', 0x47e3, CONTENT_ENCODING + '/ContentEncryption', 'b',
		0, 1, null, null, null, 1, 0, 0,
	],
	[
		'ContentSigKeyID', 0x47e4, '/Segment/Tracks/TrackEntry/ContentEncodings/ContentEncoding/ContentEncryption', 'b',
		0, 1, null, null, null, 1, 0, 0,
	],
	[
		'ContentSigAlgo', 0x47e5, '/Segment/Tracks/TrackEntry/ContentEncodings/ContentEncoding/ContentEncryption', 'u',
		0, 1, null, '0', null, 1, 0, 0,
	],
	[
		'ContentSigHashAlgo', 0x47e6, CONTENT_ENCODING + '/ContentEncryption', 'u',
		0, 1, null, '0', null, 1, 0, 0,
	],
	['Cues', 0x1c53bb6b, '/Segment', 'm', 0, 1, null, null, null, 1, null, 1],
	['CuePoint', 0xbb, '/Segment/Cues', 'm', 1, null, null, null, null, 1, null, 1],
	['CueTime', 0xb3, '/Segment/Cues/CuePoint', 'u', 1, 1, null, null, null, 1, null, 1],
	['CueTrackPositions', 0xb7, '/Segment/Cues/CuePoint', 'm', 1, null, null, null, null, 1, null, 1],
	['CueTrack', 0xf7, '/Segment/Cues/CuePoint/CueTrackPositions', 'u', 1, 1, 'not 0', null, null, 1, null, 1],
	['CueClusterPosition', 0xf1, '/Segment/Cues/CuePoint/CueTrackPositions', 'u', 1, 1, null, null, null, 1, null, 1],
	[
		'CueRelativePosition', 0xf0, '/Segment/Cues/CuePoint/CueTrackPositions', 'u',
		0, 1, null, null, null, 4, null, 1,
	],
	['CueDuration', 0xb2, '/Segment/Cues/CuePoint/CueTrackPositions', 'u', 0, 1, null, null, null, 4, null, 1],
	[
		'CueBlockNumber', 0x5378, '/Segment/Cues/CuePoint/CueTrackPositions', 'u',
		0, 1, 'not 0', null, null, 1, null, 1,
	],
	['CueCodecState', 0xea, '/Segment/Cues/CuePoint/CueTrackPositions', 'u', 1, 1, null, '0', null, 2, null, 0],
	['CueReference', 0xdb, '/Segment/Cues/CuePoint/CueTrackPositions', 'm', 0, null, null, null, null, 2, null, 0],
	[
		'CueRefTime', 0x96, '/Segment/Cues/CuePoint/CueTrackPositions/CueReference', 'u',
		1, 1, null, null, null, 2, null, 0,
	],
	[
		'CueRefCluster', 0x97, '/Segment/Cues/CuePoint/CueTrackPositions/CueReference', 'u',
		1, 1, null, null, null, 0, 0, 0,
	],
	[
		'CueRefNumber', 0x535f, '/Segment/Cues/CuePoint/CueTrackPositions/CueReference', 'u',
		0, 1, 'not 0', '1', null, 0, 0, 0,
	],
	[
		'CueRefCodecState', 0xeb, '/Segment/Cues/CuePoint/CueTrackPositions/CueReference', 'u',
		0, 1, null, '0', null, 0, 0, 0,
	],
	['Attachments', 0x1941a469, '/Segment', 'm', 0, 1, null, null, null, 1, null, 0],
	['AttachedFile', 0x61a7, '/Segment/Attachments', 'm', 1, null, null, null, null, 1, null, 0],
	['FileDescription', 0x467e, '/Segment/Attachments/AttachedFile', '8', 0, 1, null, null, null, 1, null, 0],
	['FileName', 0x466e, '/Segment/Attachments/AttachedFile', '8', 1, 1, null, null, null, 1, null, 0],
	['FileMediaType', 0x4660, '/Segment/Attachments/AttachedFile', 's', 1, 1, null, null, null, 1, null, 0],
	['FileData', 0x465c, '/Segment/Attachments/AttachedFile', 'b', 1, 1, null, null, null, 1, null, 0],
	['FileUID', 0x46ae, '/Segment/Attachments/AttachedFile', 'u', 1, 1, 'not 0', null, null, 1, null, 0],
	['FileReferral', 0x4675, '/Segment/Attachments/AttachedFile', 'b', 0, 1, null, null, null, 0, 0, 0],
	['FileUsedStartTime', 0x4661, '/Segment/Attachments/AttachedFile', 'u', 0, 1, null, null, null, 0, 0, 0],
	['FileUsedEndTime', 0x4662, '/Segment/Attachments/AttachedFile', 'u', 0, 1, null, null, null, 0, 0, 0],
	['Tags', 0x1254c367, '/Segment', 'm', 0, null, null, null, null, 1, null, 1],
	['Tag', 0x7373, '/Segment/Tags', 'm', 1, null, null, null, null, 1, null, 1],
	['Targets', 0x63c0, '/Segment/Tags/Tag', 'm', 1, 1, null, null, null, 1, null, 1],
	['TargetTypeValue', 0x68ca, '/Segment/Tags/Tag/Targets', 'u', 1, 1, 'not 0', '50', null, 1, null, 1],
	['TargetType', 0x63ca, '/Segment/Tags/Tag/Targets', 's', 0, 1, null, null, null, 1, null, 1],
	['TagTrackUID', 0x63c5, '/Segment/Tags/Tag/Targets', 'u', 0, null, null, '0', null, 1, null, 1],
	['TagEditionUID', 0x63c9, '/Segment/Tags/Tag/Targets', 'u', 0, null, null, '0', null, 1, null, 0],
	['TagChapterUID', 0x63c4, '/Segment/Tags/Tag/Targets', 'u', 0, null, null, '0', null, 1, null, 0],
	['TagAttachmentUID', 0x63c6, '/Segment/Tags/Tag/Targets', 'u', 0, null, null, '0', null, 1, null, 0],
	['TagBlockAddIDValue', 0x63c7, '/Segment/Tags/Tag/Targets', 'u', 0, null, null, '0', null, 5, null, 0],
	['SimpleTag', 0x67c8, '/Segment/Tags/Tag', 'm', 1, null, null, null, null, 1, null, 1, 1],
	['TagName', 0x45a3, '/Segment/Tags/Tag/SimpleTag', '8', 1, 1, null, null, null, 1, null, 1],
	['TagLanguage', 0x447a, '/Segment/Tags/Tag/SimpleTag', 's', 1, 1, null, 'und', null, 1, null, 1],
	['TagLanguageBCP47', 0x447b, '/Segment/Tags/Tag/SimpleTag', 's', 0, 1, null, null, null, 4, null, 0],
	['TagDefault', 0x4484, '/Segment/Tags/Tag/SimpleTag', 'u', 1, 1, '0-1', '1', null, 1, null, 1],
	['TagDefaultBogus', 0x44b4, '/Segment/Tags/Tag/SimpleTag', 'u', 1, 1, '0-1', '1', null, 0, 0, 0],
	['TagString', 0x4487, '/Segment/Tags/Tag/SimpleTag', '8', 0, 1, null, null, null, 1, null, 1],
	['TagBinary', 0x4485, '/Segment/Tags/Tag/SimpleTag', 'b', 0, 1, null, null, null, 1, null, 1],
];

export const MATROSKA_SCHEMA: SchemaElement[] = ROWS.map(row => ({
	name: row[0],
	id: row[1],
	parent: row[2],
	type: row[3],
	minOccurs: row[4],
	maxOccurs: row[5],
	range: row[6],
	default: row[7],
	length: row[8],
	minver: row[9],
	maxver: row[10],
	webm: row[11] === 1,
	recursive: row[12] === 1,
}));

const GLOBAL_IDS = new Map([[0xec, 'Void'], [0xbf, 'CRC-32']]);

export const schemaByName = new Map(MATROSKA_SCHEMA.map(e => [e.name, e]));
const schemaByParentAndId = new Map(MATROSKA_SCHEMA.map(e => [`${e.parent}|${e.id}`, e]));

/** Normalizes paths through recursive SimpleTags to the schema's single level. */
const normalizePath = (path: string) => path.replace(/\/SimpleTag(\/SimpleTag)+/g, '/SimpleTag');

export const getSchemaElement = (parentPath: string, id: number) => {
	const normalized = normalizePath(parentPath);
	const direct = schemaByParentAndId.get(`${normalized}|${id}`);
	if (direct) {
		return direct;
	}

	// Recursive elements (SimpleTag) may nest in themselves
	const lastSlash = normalized.lastIndexOf('/');
	const element = schemaByParentAndId.get(`${normalized.slice(0, lastSlash)}|${id}`);
	if (element?.recursive && normalized.endsWith('/' + element.name)) {
		return element;
	}

	return null;
};

export type EbmlNode = {
	id: number;
	name: string;
	schema: SchemaElement | null;
	path: string;
	offset: number;
	idLength: number;
	sizeLength: number;
	/** null for unknown-size elements. */
	declaredSize: number | null;
	dataOffset: number;
	end: number;
	data: Uint8Array;
	children: EbmlNode[];
	parent: EbmlNode | null;
};

export const readVint = (bytes: Uint8Array, pos: number) => {
	const first = bytes[pos];
	if (first === undefined || first === 0) {
		return null;
	}

	let length = 1;
	while (!(first & (0x80 >> (length - 1)))) {
		length++;
	}
	if (pos + length > bytes.length) {
		return null;
	}

	let value = first & ((0x80 >> (length - 1)) - 1);
	let allOnes = value === (0x80 >> (length - 1)) - 1;
	for (let i = 1; i < length; i++) {
		value = value * 256 + bytes[pos + i]!;
		allOnes &&= bytes[pos + i] === 0xff;
	}

	return { value, length, allOnes };
};

const readId = (bytes: Uint8Array, pos: number) => {
	const vint = readVint(bytes, pos);
	if (!vint) {
		return null;
	}

	let id = 0;
	for (let i = 0; i < vint.length; i++) {
		id = id * 256 + bytes[pos + i]!;
	}

	return { id, length: vint.length };
};

/** Parses an EBML document into a tree, descending into the master elements the schema knows. */
export const parseEbml = (bytes: Uint8Array) => {
	const parseChildren = (parent: EbmlNode | null, path: string, start: number, end: number | null) => {
		const nodes: EbmlNode[] = [];
		let pos = start;
		const limit = end ?? bytes.length;

		while (pos < limit) {
			const id = readId(bytes, pos);
			if (!id) {
				break;
			}

			const size = readVint(bytes, pos + id.length);
			if (!size) {
				break;
			}

			const schema = getSchemaElement(path, id.id);
			if (end === null && !schema && !GLOBAL_IDS.has(id.id)) {
				// An element that can't be a child ends an unknown-size parent
				break;
			}

			const name = schema?.name ?? GLOBAL_IDS.get(id.id) ?? `0x${id.id.toString(16)}`;
			const dataOffset = pos + id.length + size.length;
			const declaredSize = size.allOnes ? null : size.value;
			const node: EbmlNode = {
				id: id.id,
				name,
				schema,
				path: `${path}/${name}`,
				offset: pos,
				idLength: id.length,
				sizeLength: size.length,
				declaredSize,
				dataOffset,
				end: 0,
				data: new Uint8Array(0),
				children: [],
				parent,
			};

			if (schema?.type === 'm') {
				const childEnd = declaredSize === null ? null : dataOffset + declaredSize;
				const children = parseChildren(node, node.path, dataOffset, childEnd);
				node.children = children.nodes;
				node.end = childEnd ?? children.end;
			} else {
				node.end = dataOffset + (declaredSize ?? 0);
			}

			node.data = bytes.subarray(dataOffset, Math.min(node.end, bytes.length));
			nodes.push(node);
			pos = node.end;
		}

		return { nodes, end: pos };
	};

	return parseChildren(null, '', 0, bytes.length).nodes;
};

export const walk = function* (nodes: EbmlNode[]): Generator<EbmlNode> {
	for (const node of nodes) {
		yield node;
		yield* walk(node.children);
	}
};

export const findAll = (nodes: EbmlNode[], name: string) => [...walk(nodes)].filter(node => node.name === name);
export const find = (nodes: EbmlNode[], name: string) => findAll(nodes, name)[0];
export const childrenNamed = (node: EbmlNode, name: string) => node.children.filter(c => c.name === name);
export const child = (node: EbmlNode, name: string) => childrenNamed(node, name)[0];

export const readUint = (node: EbmlNode) => {
	let value = 0;
	for (const byte of node.data) {
		value = value * 256 + byte;
	}
	return value;
};

export const readUintBig = (node: EbmlNode) => {
	let value = 0n;
	for (const byte of node.data) {
		value = (value << 8n) | BigInt(byte);
	}
	return value;
};

export const readInt = (node: EbmlNode) => {
	if (node.data.length === 0) {
		return 0;
	}
	const unsigned = readUint(node);
	const bits = 8 * node.data.length;
	return unsigned >= 2 ** (bits - 1) ? unsigned - 2 ** bits : unsigned;
};

export const readFloat = (node: EbmlNode) => {
	const view = new DataView(node.data.buffer, node.data.byteOffset, node.data.byteLength);
	if (node.data.length === 4) {
		return view.getFloat32(0);
	} else if (node.data.length === 8) {
		return view.getFloat64(0);
	}
	return 0;
};

export const readString = (node: EbmlNode) => {
	let length = node.data.length;
	while (length > 0 && node.data[length - 1] === 0) {
		length--;
	}
	return new TextDecoder().decode(node.data.subarray(0, length));
};

/** Evaluates an EBML range expression (RFC 8794, Section 11.1.6.6.1) for a number. */
export const inRange = (range: string, value: number) => {
	const parseNumber = (text: string) => {
		const trimmed = text.trim();
		const hexFloat = /^(-?)0x([0-9a-f]+)(?:\.([0-9a-f]+))?p([+-]\d+)$/i.exec(trimmed);
		if (hexFloat) {
			const fraction = hexFloat[3] ? parseInt(hexFloat[3], 16) / 16 ** hexFloat[3].length : 0;
			const magnitude = (parseInt(hexFloat[2]!, 16) + fraction) * 2 ** Number(hexFloat[4]);
			return hexFloat[1] ? -magnitude : magnitude;
		}
		return Number(trimmed);
	};

	return range.split(',').every((part) => {
		const expression = part.trim();
		if (expression.startsWith('not ')) {
			return value !== parseNumber(expression.slice(4));
		} else if (expression.startsWith('>=')) {
			return value >= parseNumber(expression.slice(2));
		} else if (expression.startsWith('<=')) {
			return value <= parseNumber(expression.slice(2));
		} else if (expression.startsWith('>')) {
			return value > parseNumber(expression.slice(1));
		} else if (expression.startsWith('<')) {
			return value < parseNumber(expression.slice(1));
		}

		const interval = /^(-?[^-]+)-(.+)$/.exec(expression);
		if (interval) {
			return value >= parseNumber(interval[1]!) && value <= parseNumber(interval[2]!);
		}
		return value === parseNumber(expression);
	});
};

export type Violation = { clause: string; element: string; path: string; message: string };

const isValidUtf8 = (bytes: Uint8Array) => {
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
};

/**
 * Checks every element of an EBML document against the element table: placement (EBMLParentPath), minOccurs and
 * maxOccurs (honoring defaults, RFC 8794 Section 11.1.19), range, length, the per-type size rules of RFC 8794
 * Section 7, version constraints and, for WebM, the WebM element subset.
 */
export const validateElementTable = (nodes: EbmlNode[], options: { webm: boolean }) => {
	const violations: Violation[] = [];
	const add = (clause: string, element: string, node: EbmlNode | null, message: string) => {
		violations.push({ clause, element, path: node?.path ?? '', message });
	};

	const header = nodes.find(node => node.name === 'EBML');
	const docTypeVersionNode = header && child(header, 'DocTypeVersion');
	const docTypeVersion = docTypeVersionNode ? readUint(docTypeVersionNode) : 1;
	const maxIdLengthNode = header && child(header, 'EBMLMaxIDLength');
	const maxSizeLengthNode = header && child(header, 'EBMLMaxSizeLength');
	const maxIdLength = maxIdLengthNode ? readUint(maxIdLengthNode) : 4;
	const maxSizeLength = maxSizeLengthNode ? readUint(maxSizeLengthNode) : 8;

	const isActive = (element: SchemaElement) => element.minver <= docTypeVersion
		&& (element.maxver === null || element.maxver >= docTypeVersion);

	const checkOccurrences = (parentPath: string, children: EbmlNode[], parentNode: EbmlNode | null) => {
		const expected = MATROSKA_SCHEMA.filter(element => element.parent === parentPath && isActive(element));
		for (const element of expected) {
			const count = children.filter(c => c.schema === element).length;
			// Mandatory elements with a default may be left out (RFC 8794, Section 11.1.19, Table 10)
			if (count < element.minOccurs && !(element.default !== null && count === 0)) {
				add('RFC 8794 §11.1.6.4 minOccurs', element.name, parentNode,
					`${element.name} occurs ${count} times, needs ${element.minOccurs}`);
			}
			if (element.maxOccurs !== null && count > element.maxOccurs) {
				add('RFC 8794 §11.1.6.5 maxOccurs', element.name, parentNode,
					`${element.name} occurs ${count} times, max ${element.maxOccurs}`);
			}
		}
	};

	checkOccurrences('', nodes, null);

	for (const node of walk(nodes)) {
		if (node.idLength > maxIdLength) {
			add('RFC 8794 §11.2.4 EBMLMaxIDLength', node.name, node, `ID of ${node.idLength} octets`);
		}
		if (node.sizeLength > maxSizeLength) {
			add('RFC 8794 §11.2.5 EBMLMaxSizeLength', node.name, node, `size of ${node.sizeLength} octets`);
		}
		if (node.declaredSize !== null && node.declaredSize === 2 ** (7 * node.sizeLength) - 1) {
			add('RFC 8794 §6.3', node.name, node, 'data size needs one more octet');
		}

		if (!node.schema) {
			if (!GLOBAL_IDS.has(node.id)) {
				add('RFC 8794 §7.7 (EBMLParentPath)', node.name, node,
					`unknown element under ${node.parent?.path ?? ''}`);
			}
			continue;
		}

		const schema = node.schema;
		if (!isActive(schema)) {
			add('RFC 9559 §7 (DocTypeVersion)', schema.name, node,
				`element is minver ${schema.minver} / maxver ${schema.maxver}, DocTypeVersion ${docTypeVersion}`);
		}
		if (options.webm && !schema.webm) {
			add('WebM container guidelines (element subset)', schema.name, node, `${schema.name} is not part of WebM`);
		}
		if (node.declaredSize === null && !['Segment', 'Cluster'].includes(schema.name)) {
			add('RFC 8794 §6.2 (unknownsizeallowed)', schema.name, node, 'unknown size on an element that forbids it');
		}

		const length = node.data.length;
		if ((schema.type === 'u' || schema.type === 'i') && length > 8) {
			add('RFC 8794 §7.1/§7.2', schema.name, node, `integer of ${length} octets`);
		} else if (schema.type === 'f' && ![0, 4, 8].includes(length)) {
			add('RFC 8794 §7.3', schema.name, node, `float of ${length} octets`);
		} else if (schema.type === 'd' && ![0, 8].includes(length)) {
			add('RFC 8794 §7.6', schema.name, node, `date of ${length} octets`);
		} else if (schema.type === 's') {
			let end = length;
			while (end > 0 && node.data[end - 1] === 0) {
				end--;
			}
			if (node.data.subarray(0, end).some(byte => byte < 0x20 || byte > 0x7e)) {
				add('RFC 8794 §7.4', schema.name, node, 'string with characters outside 0x20-0x7E');
			}
		} else if (schema.type === '8' && !isValidUtf8(node.data)) {
			add('RFC 8794 §7.5', schema.name, node, 'invalid UTF-8');
		}

		if (schema.length !== null && schema.type !== 'm') {
			const ok = schema.length.startsWith('>')
				? length > Number(schema.length.slice(1))
				: length === Number(schema.length);
			if (!ok) {
				add('RFC 8794 §11.1.6.7 length', schema.name, node, `length ${length}, expected ${schema.length}`);
			}
		}

		if (
			length === 0
			&& schema.default !== null
			&& !['0', '0x0p+0'].includes(schema.default)
			&& ['u', 'i', 'f', 'd'].includes(schema.type)
		) {
			add('RFC 9559 §4.4 (Empty Elements)', schema.name, node,
				`empty element whose default is ${schema.default}`);
		}

		if (schema.range !== null) {
			let value: number | null = null;
			if (schema.type === 'u') {
				value = readUint(node);
			} else if (schema.type === 'i') {
				value = readInt(node);
			} else if (schema.type === 'f') {
				value = readFloat(node);
			}
			if (value !== null && !inRange(schema.range, value)) {
				add('RFC 8794 §11.1.6.6 range', schema.name, node,
					`${schema.name} = ${value} outside "${schema.range}"`);
			}
		}

		if (schema.type === 'm') {
			checkOccurrences(normalizePath(node.path), node.children, node);
		}
	}

	return violations;
};

// Byte builders for crafting Matroska files in tests

export type EbmlBuild = { id: number; data: Uint8Array | EbmlBuild[]; sizeLength?: number; unknownSize?: boolean };

const idBytes = (id: number) => {
	const bytes: number[] = [];
	let value = id;
	while (value > 0) {
		bytes.unshift(value & 0xff);
		value = Math.floor(value / 256);
	}
	return bytes;
};

export const encodeVint = (value: number, length?: number) => {
	let width = length ?? 1;
	while (length === undefined && value >= 2 ** (7 * width) - 1) {
		width++;
	}
	const bytes = new Array<number>(width).fill(0);
	let rest = value;
	for (let i = width - 1; i >= 0; i--) {
		bytes[i] = rest % 256;
		rest = Math.floor(rest / 256);
	}
	bytes[0]! |= 0x80 >> (width - 1);
	return bytes;
};

export const encodeEbml = (elements: EbmlBuild[]): Uint8Array => {
	const parts: number[] = [];
	for (const element of elements) {
		const data = element.data instanceof Uint8Array ? element.data : encodeEbml(element.data);
		parts.push(...idBytes(element.id));
		if (element.unknownSize) {
			parts.push(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
		} else {
			parts.push(...encodeVint(data.length, element.sizeLength));
		}
		for (const byte of data) {
			parts.push(byte);
		}
	}
	return new Uint8Array(parts);
};

export const el = (name: string, data: Uint8Array | EbmlBuild[], extra: Partial<EbmlBuild> = {}): EbmlBuild => {
	const element = schemaByName.get(name) ?? (name === 'Void' ? { id: 0xec } : null);
	if (!element) {
		throw new Error(`Unknown element ${name}`);
	}
	return { id: element.id, data, ...extra };
};

export const uint = (name: string, value: number) => {
	const bytes: number[] = [];
	let rest = value;
	do {
		bytes.unshift(rest % 256);
		rest = Math.floor(rest / 256);
	} while (rest > 0);
	return el(name, new Uint8Array(bytes));
};

export const str = (name: string, value: string) => el(name, new TextEncoder().encode(value));

export const float = (name: string, value: number, width: 4 | 8 = 8) => {
	const bytes = new Uint8Array(width);
	const view = new DataView(bytes.buffer);
	if (width === 4) {
		view.setFloat32(0, value);
	} else {
		view.setFloat64(0, value);
	}
	return el(name, bytes);
};

export const simpleBlock = (trackNumber: number, relativeTimestamp: number, keyframe: boolean, payload: number[]) => {
	const header = [...encodeVint(trackNumber), (relativeTimestamp >> 8) & 0xff, relativeTimestamp & 0xff,
		keyframe ? 0x80 : 0x00];
	return el('SimpleBlock', new Uint8Array([...header, ...payload]));
};

export const ebmlHeader = (overrides: { docType?: string; version?: number; readVersion?: number;
	docTypeVersion?: number; docTypeReadVersion?: number; } = {}) => el('EBML', [
	uint('EBMLVersion', overrides.version ?? 1),
	uint('EBMLReadVersion', overrides.readVersion ?? 1),
	uint('EBMLMaxIDLength', 4),
	uint('EBMLMaxSizeLength', 8),
	str('DocType', overrides.docType ?? 'matroska'),
	uint('DocTypeVersion', overrides.docTypeVersion ?? 4),
	uint('DocTypeReadVersion', overrides.docTypeReadVersion ?? 2),
]);

export const defaultInfo = () => [
	uint('TimestampScale', 1_000_000),
	str('MuxingApp', 'test'),
	str('WritingApp', 'test'),
];

/** A minimal file: EBML header, then a Segment with Info, the given track entries and clusters. */
export const buildMatroska = (options: {
	header?: EbmlBuild;
	info?: EbmlBuild[];
	tracks: EbmlBuild[][];
	clusters: EbmlBuild[][];
}) => encodeEbml([
	options.header ?? ebmlHeader(),
	el('Segment', [
		el('Info', options.info ?? defaultInfo()),
		el('Tracks', options.tracks.map(entry => el('TrackEntry', entry))),
		...options.clusters.map(cluster => el('Cluster', cluster)),
	]),
]);

const parseBlockHeader = (data: Uint8Array) => {
	const trackNumber = readVint(data, 0);
	if (!trackNumber) {
		return null;
	}
	const offset = trackNumber.length;
	const relativeTimestamp = ((data[offset]! << 24) >> 16) | data[offset + 1]!;
	return { trackNumber: trackNumber.value, relativeTimestamp, flags: data[offset + 2]!, headerLength: offset + 3 };
};

export type MatroskaFacts = {
	segment: EbmlNode;
	trackNumbers: Map<number, EbmlNode>;
	blocks: { cluster: EbmlNode; node: EbmlNode; trackNumber: number; timestamp: number; flags: number;
		isSimple: boolean; group: EbmlNode | null; }[];
};

export const collectFacts = (nodes: EbmlNode[]): MatroskaFacts => {
	const segment = nodes.find(node => node.name === 'Segment')!;
	const trackNumbers = new Map<number, EbmlNode>();
	for (const entry of findAll([segment], 'TrackEntry')) {
		const number = child(entry, 'TrackNumber');
		if (number) {
			trackNumbers.set(readUint(number), entry);
		}
	}

	const blocks: MatroskaFacts['blocks'] = [];
	for (const cluster of childrenNamed(segment, 'Cluster')) {
		const timestampNode = child(cluster, 'Timestamp');
		const clusterTimestamp = timestampNode ? readUint(timestampNode) : 0;
		for (const node of cluster.children) {
			const blockNode = node.name === 'SimpleBlock'
				? node
				: node.name === 'BlockGroup' ? child(node, 'Block') : null;
			if (!blockNode) {
				continue;
			}
			const header = parseBlockHeader(blockNode.data);
			if (!header) {
				continue;
			}
			blocks.push({
				cluster,
				node,
				trackNumber: header.trackNumber,
				timestamp: clusterTimestamp + header.relativeTimestamp,
				flags: header.flags,
				isSimple: node.name === 'SimpleBlock',
				group: node.name === 'BlockGroup' ? node : null,
			});
		}
	}

	return { segment, trackNumbers, blocks };
};
