// Public API surface of `mediabunny` as declared in the rolled-up dist/mediabunny.d.ts (npm run build).
// Members: plain names are prototype methods, `get:` accessors, `prop:` instance fields, `static:` static members.

export const CLASS_MEMBERS: Record<string, string> = {
	AdtsInputFormat: 'get:name get:mimeType get:supportsTimestampedMediaData',
	AdtsOutputFormat: 'getSupportedTrackCounts get:fileExtension get:mimeType getSupportedCodecs'
		+ ' get:supportsVideoTransformationMetadata get:supportsTimestampedMediaData'
		+ ' get:negativeTimestampSupport',
	AppendOnlyStreamTarget: '',
	AttachedFile: 'prop:data prop:mimeType prop:name prop:description',
	AudioBufferSink: 'getBuffer buffers buffersAtTimestamps',
	AudioBufferSource: 'add',
	AudioSample: 'prop:format prop:sampleRate prop:numberOfFrames prop:numberOfChannels prop:duration'
		+ ' prop:timestamp get:microsecondTimestamp get:microsecondDuration allocationSize copyTo'
		+ ' clone trim close toAudioData toAudioBuffer setTimestamp @@dispose static:fromAudioBuffer',
	AudioSampleResource: '',
	AudioSampleSink: 'getSample samples samplesAtTimestamps',
	AudioSampleSource: 'add',
	AudioSource: '',
	BaseMediaSampleSink: '',
	BlobSource: '',
	BufferSource: '',
	BufferTarget: 'prop:buffer',
	CanvasSink: 'getCanvas canvases canvasesAtTimestamps',
	CanvasSource: 'add',
	CmafOutputFormat: 'get:fileExtension get:mimeType getSupportedCodecs',
	ConcurrentRunner: 'prop:parallelism get:errored get:inFlightCount run flush',
	Conversion: 'prop:input prop:output prop:onProgress prop:isValid prop:utilizedTracks'
		+ ' prop:discardedTracks get:state static:init execute cancel',
	ConversionCanceledError: '',
	CustomAudioDecoder: 'prop:codec prop:config prop:onSample prop:onError static:supports',
	CustomAudioEncoder: 'prop:codec prop:config prop:onPacket prop:onError static:supports',
	CustomPathedSource: '',
	CustomSource: '',
	CustomVideoDecoder: 'prop:codec prop:config prop:onSample prop:onError static:supports',
	CustomVideoEncoder: 'prop:codec prop:config prop:onPacket prop:onError static:supports',
	EncodedAudioPacketSource: 'add',
	EncodedPacket: 'prop:data prop:type prop:timestamp prop:duration prop:sequenceNumber prop:byteLength'
		+ ' prop:sideData get:isMetadataOnly get:microsecondTimestamp get:microsecondDuration'
		+ ' toEncodedVideoChunk alphaToEncodedVideoChunk toEncodedAudioChunk static:fromEncodedChunk'
		+ ' clone',
	EncodedPacketSink: 'getFirstPacket getFirstKeyPacket getPacket getNextPacket getKeyPacket getNextKeyPacket'
		+ ' packets',
	EncodedVideoPacketSource: 'add',
	EventEmitter: 'on',
	FilePathSource: '',
	FilePathTarget: '',
	FlacInputFormat: 'get:name get:mimeType get:supportsTimestampedMediaData',
	FlacOutputFormat: 'getSupportedTrackCounts get:fileExtension get:mimeType getSupportedCodecs'
		+ ' get:supportsVideoTransformationMetadata get:supportsTimestampedMediaData'
		+ ' get:negativeTimestampSupport',
	HlsInputFormat: 'get:name get:mimeType get:supportsTimestampedMediaData',
	HlsOutputFormat: 'get:fileExtension get:mimeType getSupportedCodecs getSupportedTrackCounts'
		+ ' get:supportsVideoTransformationMetadata get:supportsTimestampedMediaData'
		+ ' get:negativeTimestampSupport',
	Input: 'get:disposed get:source getFormat canRead getFirstTimestamp computeDuration'
		+ ' getDurationFromMetadata getTracks getVideoTracks getAudioTracks getPrimaryVideoTrack'
		+ ' getPrimaryAudioTrack getMimeType getMetadataTags dispose @@dispose',
	InputAudioTrack: 'get:type getCodec get:codec hasOnlyKeyPackets getNumberOfChannels get:numberOfChannels'
		+ ' getSampleRate get:sampleRate getDecoderConfig getCodecParameterString getPreRollDuration'
		+ ' canDecode determinePacketType',
	InputDisposedError: '',
	InputFormat: '',
	InputTrack: 'prop:input isVideoTrack isAudioTrack get:id get:number getInternalCodecId'
		+ ' get:internalCodecId getLanguageCode get:languageCode getName get:name getTimeResolution'
		+ ' get:timeResolution isRelativeToUnixEpoch getUnixTimeForTimestamp hasUnixTimeMapping'
		+ ' getDisposition get:disposition getBitrate getAverageBitrate getFirstTimestamp'
		+ ' computeDuration getDurationFromMetadata computePacketStats isLive getLiveRefreshInterval'
		+ ' canBePairedWith getPairableTracks getPairableVideoTracks getPairableAudioTracks'
		+ ' getPrimaryPairableVideoTrack getPrimaryPairableAudioTrack hasPairableTrack'
		+ ' hasPairableVideoTrack hasPairableAudioTrack',
	InputVideoTrack: 'get:type getCodec get:codec hasOnlyKeyPackets getCodedWidth get:codedWidth getCodedHeight'
		+ ' get:codedHeight getTransformationMatrix getRotation get:rotation getFlip'
		+ ' getSquarePixelWidth get:squarePixelWidth getSquarePixelHeight get:squarePixelHeight'
		+ ' getPixelAspectRatio get:pixelAspectRatio getDisplayWidth get:displayWidth getDisplayHeight'
		+ ' get:displayHeight getColorSpace hasHighDynamicRange canBeTransparent getDecoderConfig'
		+ ' getCodecParameterString canDecode determinePacketType computeFrameRateMetrics',
	IsobmffInputFormat: 'get:supportsTimestampedMediaData',
	IsobmffOutputFormat: 'getSupportedTrackCounts get:supportsVideoTransformationMetadata'
		+ ' get:supportsTimestampedMediaData get:negativeTimestampSupport'
		+ ' get:requiresMaximumPacketCount',
	Logging: 'static:get:level static:on',
	MatroskaInputFormat: 'get:name get:mimeType get:supportsTimestampedMediaData',
	MediaSource: 'close',
	MediaStreamAudioTrackSource: 'get:errorPromise get:paused pause resume',
	MediaStreamVideoTrackSource: 'get:errorPromise get:paused pause resume',
	MkvOutputFormat: 'getSupportedTrackCounts get:fileExtension get:mimeType getSupportedCodecs'
		+ ' get:supportsVideoTransformationMetadata get:supportsTimestampedMediaData'
		+ ' get:negativeTimestampSupport',
	MovOutputFormat: 'get:fileExtension get:mimeType getSupportedCodecs',
	Mp3InputFormat: 'get:name get:mimeType get:supportsTimestampedMediaData',
	Mp3OutputFormat: 'getSupportedTrackCounts get:fileExtension get:mimeType getSupportedCodecs'
		+ ' get:supportsVideoTransformationMetadata get:supportsTimestampedMediaData'
		+ ' get:negativeTimestampSupport',
	Mp4InputFormat: 'get:name get:mimeType',
	Mp4OutputFormat: 'get:fileExtension get:mimeType getSupportedCodecs',
	MpegTsInputFormat: 'get:name get:mimeType get:supportsTimestampedMediaData',
	MpegTsOutputFormat: 'getSupportedTrackCounts get:fileExtension get:mimeType getSupportedCodecs'
		+ ' get:supportsVideoTransformationMetadata get:supportsTimestampedMediaData'
		+ ' get:negativeTimestampSupport',
	NullTarget: '',
	OggInputFormat: 'get:name get:mimeType get:supportsTimestampedMediaData',
	OggOutputFormat: 'getSupportedTrackCounts get:fileExtension get:mimeType getSupportedCodecs'
		+ ' get:supportsVideoTransformationMetadata get:supportsTimestampedMediaData'
		+ ' get:negativeTimestampSupport',
	Output: 'prop:format prop:state prop:defaultTrackGroup prop:tracks get:target addVideoTrack'
		+ ' addAudioTrack addSubtitleTrack setMetadataTags hasEnoughTracks start getMimeType cancel'
		+ ' finalize',
	OutputAudioTrack: 'prop:type prop:source prop:metadata',
	OutputFormat: 'get:supportsVideoRotationMetadata get:requiresMaximumPacketCount getSupportedVideoCodecs'
		+ ' getSupportedAudioCodecs getSupportedSubtitleCodecs',
	OutputSubtitleTrack: 'prop:type prop:source prop:metadata',
	OutputTrack: 'prop:output prop:type prop:source prop:metadata isVideoTrack isAudioTrack isSubtitleTrack'
		+ ' canBePairedWith',
	OutputTrackGroup: 'pairWith',
	OutputVideoTrack: 'prop:type prop:source prop:metadata',
	PathedSource: 'prop:rootPath prop:requestHandler',
	PathedTarget: 'prop:rootPath prop:getTarget',
	Quality: '',
	QuickTimeInputFormat: 'get:name get:mimeType',
	RangedSource: 'ref',
	RangedTarget: '',
	ReadableStreamSource: '',
	RichImageData: 'prop:data prop:mimeType',
	Source: 'getSizeOrNull getSize slice prop:onread ref',
	SourceRef: 'get:source get:freed free @@dispose',
	StreamTarget: '',
	SubtitleSource: '',
	Target: 'prop:onwrite slice',
	TextSubtitleSource: 'add',
	UnsupportedInputFormatError: '',
	UrlSource: '',
	VideoSample: 'prop:format prop:visibleRect prop:squarePixelWidth prop:squarePixelHeight prop:rotation'
		+ ' prop:flip prop:pixelAspectRatio prop:timestamp prop:duration prop:colorSpace'
		+ ' prop:encodeOptions get:codedWidth get:codedHeight get:displayWidth get:displayHeight'
		+ ' get:microsecondTimestamp get:microsecondDuration get:hasAlpha clone close allocationSize'
		+ ' copyTo toVideoFrame draw drawWithFit toCanvasImageSource transform setRotation setFlip'
		+ ' setTimestamp setDuration setEncodeOptions @@dispose',
	VideoSampleColorSpace: 'prop:primaries prop:transfer prop:matrix prop:fullRange toJSON',
	VideoSampleResource: '',
	VideoSampleSink: 'getSample samples samplesAtTimestamps',
	VideoSampleSource: 'add',
	VideoSource: '',
	WaveInputFormat: 'get:name get:mimeType get:supportsTimestampedMediaData',
	WavOutputFormat: 'getSupportedTrackCounts get:fileExtension get:mimeType getSupportedCodecs'
		+ ' get:supportsVideoTransformationMetadata get:supportsTimestampedMediaData'
		+ ' get:negativeTimestampSupport',
	WebMInputFormat: 'get:name get:mimeType',
	WebMOutputFormat: 'getSupportedCodecs get:fileExtension get:mimeType',
};

export const VALUE_EXPORTS = [
	'ADTS',
	'ALL_FORMATS',
	'ALL_TRACK_TYPES',
	'AUDIO_CODECS',
	'FLAC',
	'HLS',
	'HLS_FORMATS',
	'LogLevel',
	'MATROSKA',
	'MP3',
	'MP4',
	'MPEG_TS',
	'NON_PCM_AUDIO_CODECS',
	'OGG',
	'PCM_AUDIO_CODECS',
	'QTFF',
	'QUALITY_HIGH',
	'QUALITY_LOW',
	'QUALITY_MEDIUM',
	'QUALITY_VERY_HIGH',
	'QUALITY_VERY_LOW',
	'SUBTITLE_CODECS',
	'StreamSource',
	'VIDEO_CODECS',
	'VIDEO_SAMPLE_PIXEL_FORMATS',
	'WAVE',
	'WEBM',
	'asc',
	'canDecode',
	'canDecodeAudio',
	'canDecodeVideo',
	'canEncode',
	'canEncodeAudio',
	'canEncodeSubtitles',
	'canEncodeVideo',
	'desc',
	'getDecodableAudioCodecs',
	'getDecodableCodecs',
	'getDecodableVideoCodecs',
	'getEncodableAudioCodecs',
	'getEncodableCodecs',
	'getEncodableSubtitleCodecs',
	'getEncodableVideoCodecs',
	'getFirstEncodableAudioCodec',
	'getFirstEncodableSubtitleCodec',
	'getFirstEncodableVideoCodec',
	'prefer',
	'registerDecoder',
	'registerEncoder',
	'registerVideoSampleTransformer',
];

// Runtime exports of the extension packages, as declared in their packages/*/dist/*.d.ts
export const PACKAGE_EXPORTS: Record<string, string[]> = {
	'@mediabunny/aac-encoder': ['registerAacEncoder'],
	'@mediabunny/ac3': ['registerAc3Decoder', 'registerAc3Encoder'],
	'@mediabunny/dts': ['registerDtsDecoder', 'registerDtsEncoder'],
	'@mediabunny/flac-encoder': ['registerFlacEncoder'],
	'@mediabunny/mp3-encoder': ['registerMp3Encoder'],
	'@mediabunny/prores': ['registerProresDecoder'],
	'@mediabunny/server': [
		'AvFrameAudioSampleResource',
		'AvFrameVideoSampleResource',
		'registerMediabunnyServer',
		'toAvFrame',
	],
	'@mediabunny/truehd': ['registerTrueHdDecoder', 'registerTrueHdEncoder'],
};
