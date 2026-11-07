import { expect, test, describe } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	AdtsOutputFormat,
	AttachedFile,
	AudioBufferSink,
	AudioBufferSource,
	AudioSample,
	AudioSampleSink,
	AudioSampleSource,
	BlobSource,
	BufferSource,
	BufferTarget,
	CanvasSink,
	CanvasSource,
	CmafOutputFormat,
	Conversion,
	ConversionCanceledError,
	CustomPathedSource,
	CustomSource,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	FilePathTarget,
	FlacOutputFormat,
	HlsOutputFormat,
	Input,
	InputDisposedError,
	LogLevel,
	Logging,
	MkvOutputFormat,
	MovOutputFormat,
	MP4,
	Mp3OutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	OggOutputFormat,
	Output,
	OutputTrackGroup,
	PathedTarget,
	Quality,
	ReadableStreamSource,
	RichImageData,
	StreamTarget,
	TextSubtitleSource,
	UrlSource,
	VideoSample,
	VideoSampleColorSpace,
	VideoSampleSink,
	VideoSampleSource,
	WavOutputFormat,
	WebMOutputFormat,
	canDecodeAudio,
	canDecodeVideo,
	canEncodeAudio,
	canEncodeVideo,
	registerDecoder,
	registerEncoder,
} from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const readPublic = (name: string) => readFileSync(path.join(__dirname, '../public', name));

// Messages that point to an unvalidated argument reaching internal code, rather than a deliberate rejection
const UNINTENDED = new RegExp([
	'Assertion failed', 'Cannot read prop', 'is not a function', 'is not iterable', 'Cannot destructure',
	'Cannot use \'in\'', 'is not defined', 'undefined is not',
].join('|'));

/** Asserts that `call` throws or rejects with a deliberate error of the given class, optionally naming `mention`. */
const expectRejection = async (
	call: () => unknown,
	label: string,
	mention: string | undefined,
	errorClass: new (...args: never[]) => Error = TypeError,
) => {
	let error: unknown = null;
	try {
		await call();
	} catch (e) {
		error = e;
	}
	expect(error, `${label}: expected a ${errorClass.name}`).toBeInstanceOf(errorClass);
	const message = (error as Error).message;
	expect(message, label).not.toMatch(UNINTENDED);
	if (mention !== undefined) {
		expect(message, label).toContain(mention);
	}
};

const repr = (value: unknown) => {
	if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'symbol') {
		return String(value);
	}
	if (typeof value === 'function') {
		return 'function';
	}
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
};

const NOT_OBJECT = [null, 'options', 1, true];
const NOT_BOOLEAN = [1, 'true', null, {}];
const NOT_FUNCTION = ['callback', 1, {}, null];
const NOT_STRING = [1, null, {}, ['a']];
const NOT_NON_NEGATIVE = [-1, NaN, '1', null, -Infinity];
const NOT_POSITIVE = [0, -1, NaN, '1', null];
const NOT_POSITIVE_INTEGER = [0, -1, 1.5, NaN, Infinity, '1', null];
const NOT_NON_NEGATIVE_INTEGER = [-1, 1.5, NaN, Infinity, '1', null];
const NOT_FINITE = [NaN, Infinity, -Infinity, '1', null];
const NOT_ENUM = ['bogus', '', null, 1];

const closeSample = (value: unknown) => {
	if (value instanceof AudioSample || value instanceof VideoSample) {
		value.close();
	}
};

/** Runs `fn` with the console output silenced, returning the warnings it logged. */
const captureWarnings = async (fn: () => Promise<unknown>) => {
	const warnings: string[] = [];
	const removeListener = Logging.on('warn', args => void warnings.push(args.map(String).join(' ')));
	const level = Logging.level;
	Logging.level = LogLevel.Silent;
	try {
		await fn();
	} finally {
		Logging.level = level;
		removeListener();
	}

	return warnings;
};

/** An option field: [field name, invalid values, substring the message must contain (defaults to the field)]. */
type FieldRule = [field: string, values: unknown[], mention?: string | null];

/**
 * Checks a constructor or function taking an options object: non-objects are rejected, `undefined`, `{}` (when
 * `requiredFields` allows) and unknown keys are accepted, and each field rejects its invalid values.
 */
const checkOptions = async (
	label: string,
	call: (options: unknown) => unknown,
	fields: FieldRule[],
	{ base = {}, optional = true, valid = true, notObject = NOT_OBJECT }: {
		/** Required options every call carries; a function to get fresh ones per call. */
		base?: object | (() => object);
		/** Whether `undefined` is accepted. */
		optional?: boolean;
		/** Whether valid calls can run in this environment. */
		valid?: boolean;
		notObject?: unknown[];
	} = {},
) => {
	const makeBase = typeof base === 'function' ? base as () => object : () => base;
	if (valid && optional) {
		closeSample(await call(undefined));
	}
	for (const value of notObject) {
		await expectRejection(() => call(value), `${label}(${repr(value)})`, undefined);
	}
	if (valid) {
		closeSample(await call({ ...makeBase(), unknownOptionKey: 1 })); // Unknown keys are ignored
	}

	for (const [field, values, mention] of fields) {
		for (const value of values) {
			await expectRejection(
				() => call({ ...makeBase(), [field]: value }),
				`${label}({ ${field}: ${repr(value)} })`,
				mention === null ? undefined : (mention ?? field),
			);
		}
	}
};

const quality = new Quality('medium');

describe('Option validation', () => {
	test('output formats', async () => {
		const isobmff: FieldRule[] = [
			['fastStart', [...NOT_ENUM, true, 'fragment']],
			['minimumFragmentDuration', NOT_NON_NEGATIVE],
			['metadataFormat', NOT_ENUM],
			['onFtyp', NOT_FUNCTION],
			['onMoov', NOT_FUNCTION],
			['onMdat', NOT_FUNCTION],
			['onMoof', NOT_FUNCTION],
		];
		await checkOptions('Mp4OutputFormat', o => new Mp4OutputFormat(o as never), isobmff);
		await checkOptions('MovOutputFormat', o => new MovOutputFormat(o as never), isobmff);
		await checkOptions('CmafOutputFormat', o => new CmafOutputFormat(o as never), isobmff.slice(1));

		const matroska: FieldRule[] = [
			['appendOnly', NOT_BOOLEAN],
			['minimumClusterDuration', NOT_NON_NEGATIVE],
			['onEbmlHeader', NOT_FUNCTION],
			['onSegmentHeader', NOT_FUNCTION, null], // Main's message names `onHeader`
			['onCluster', NOT_FUNCTION],
		];
		await checkOptions('MkvOutputFormat', o => new MkvOutputFormat(o as never), matroska);
		await checkOptions('WebMOutputFormat', o => new WebMOutputFormat(o as never), matroska);

		await checkOptions('Mp3OutputFormat', o => new Mp3OutputFormat(o as never), [
			['xingHeader', NOT_BOOLEAN],
			['onXingFrame', NOT_FUNCTION],
		]);
		await checkOptions('WavOutputFormat', o => new WavOutputFormat(o as never), [
			['large', NOT_BOOLEAN],
			['metadataFormat', [...NOT_ENUM, 'mdir']],
			['onHeader', NOT_FUNCTION],
		]);
		await checkOptions('OggOutputFormat', o => new OggOutputFormat(o as never), [
			['maximumPageDuration', NOT_POSITIVE],
			['onPage', NOT_FUNCTION],
		]);
		await checkOptions('AdtsOutputFormat', o => new AdtsOutputFormat(o as never), [
			['onFrame', NOT_FUNCTION],
		]);
		// onFrame isn't validated on main (fixed in upstream's bug-fix-mania branch)
		await checkOptions('FlacOutputFormat', o => new FlacOutputFormat(o as never), [
			['appendOnly', NOT_BOOLEAN],
		]);
		await checkOptions('MpegTsOutputFormat', o => new MpegTsOutputFormat(o as never), [
			['timestampOffset', [...NOT_FINITE, -1]],
			['onPacket', NOT_FUNCTION],
		]);

		const segmentFormat = new MpegTsOutputFormat();
		await checkOptions('HlsOutputFormat', o => new HlsOutputFormat(o as never), [
			['segmentFormat', [undefined, null, 'ts', {}, MP4], null],
			// NaN/Infinity aren't rejected on main (fixed in upstream's bug-fix-mania branch)
			['targetDuration', [0, -1, '1', null]],
			['singleFilePerPlaylist', NOT_BOOLEAN],
			['live', NOT_BOOLEAN],
			['maxLiveSegmentCount', [0, -1, 1.5, '1', null]],
			['mediaTimestampBase', NOT_FINITE],
			['getPlaylistPath', NOT_FUNCTION],
			['getSegmentPath', NOT_FUNCTION],
			['getInitPath', NOT_FUNCTION],
			['onMaster', NOT_FUNCTION],
			['onPlaylist', NOT_FUNCTION],
			['onSegment', NOT_FUNCTION],
			['onInit', NOT_FUNCTION],
			['onSegmentPopped', NOT_FUNCTION],
		], { base: { segmentFormat }, optional: false });
	});

	test('targets', async () => {
		await checkOptions('BufferTarget', o => new BufferTarget(o as never), [['onFinalize', NOT_FUNCTION]]);

		for (const writable of [undefined, null, {}, new ReadableStream()]) {
			await expectRejection(
				() => new StreamTarget(writable as never),
				`StreamTarget(${repr(writable)})`,
				'WritableStream',
			);
		}
		const streamTargetFields: FieldRule[] = [
			['chunked', NOT_BOOLEAN],
			['chunkSize', [1023, 0, 1.5, NaN, Infinity, '2048', null]],
		];
		// StreamTarget(writable, null) fails internally on main, so the non-object check skips null
		for (const value of ['options', 1, true]) {
			await expectRejection(
				() => new StreamTarget(new WritableStream(), value as never),
				`StreamTarget(w, ${repr(value)})`,
				undefined,
			);
		}
		for (const [field, values] of streamTargetFields) {
			for (const value of values) {
				await expectRejection(
					() => new StreamTarget(new WritableStream(), { [field]: value }),
					`StreamTarget(w, { ${field}: ${repr(value)} })`,
					field,
				);
			}
		}

		for (const filePath of NOT_STRING) {
			await expectRejection(
				() => new FilePathTarget(filePath as never),
				`FilePathTarget(${repr(filePath)})`,
				'filePath',
			);
		}
		// The fields are validated by the backing StreamTarget, checked above. They're not repeated here: on main, a
		// FilePathTarget whose options get rejected has already opened (and truncated) its file.
		const unusedPath = path.join(tmpdir(), 'mediabunny-api-validation.bin');
		await checkOptions('FilePathTarget', o => new FilePathTarget(unusedPath, o as never), [], { valid: false });

		for (const rootPath of NOT_STRING) {
			await expectRejection(
				() => new PathedTarget(rootPath as never, () => new BufferTarget()),
				'PathedTarget rootPath',
				'rootPath',
			);
		}
		for (const getTarget of NOT_FUNCTION) {
			await expectRejection(
				() => new PathedTarget('a.m3u8', getTarget as never),
				'PathedTarget getTarget',
				'getTarget',
			);
		}
		for (const offset of NOT_NON_NEGATIVE_INTEGER) {
			await expectRejection(
				() => new BufferTarget().slice(offset as never),
				`Target.slice(${repr(offset)})`,
				'offset',
			);
		}
	});

	test('sources', async () => {
		for (const buffer of [undefined, null, 'bytes', 1, {}, [1]]) {
			await expectRejection(() => new BufferSource(buffer as never), `BufferSource(${repr(buffer)})`, 'buffer');
		}

		const cacheFields: FieldRule[] = [
			['maxCacheSize', NOT_NON_NEGATIVE],
			['handleUnhandledError', NOT_FUNCTION],
		];
		for (const blob of [undefined, null, 'blob', new Uint8Array(1)]) {
			await expectRejection(() => new BlobSource(blob as never), `BlobSource(${repr(blob)})`, 'blob');
		}
		await checkOptions('BlobSource', o => new BlobSource(new Blob([]), o as never), [
			...cacheFields,
			['useStreamReader', NOT_BOOLEAN],
		]);

		for (const url of [undefined, null, 1, {}]) {
			await expectRejection(() => new UrlSource(url as never), `UrlSource(${repr(url)})`, 'url');
		}
		await checkOptions('UrlSource', o => new UrlSource('https://example.com/a.mp4', o as never), [
			...cacheFields,
			['requestInit', NOT_OBJECT],
			['getRetryDelay', NOT_FUNCTION],
			['parallelism', NOT_POSITIVE_INTEGER],
			['fetchFn', NOT_FUNCTION],
		]);

		for (const filePath of NOT_STRING) {
			await expectRejection(
				() => new FilePathSource(filePath as never),
				`FilePathSource(${repr(filePath)})`,
				'filePath',
			);
		}
		await checkOptions('FilePathSource', o => new FilePathSource('unused.mp4', o as never), cacheFields);

		for (const stream of [undefined, null, {}, new WritableStream()]) {
			await expectRejection(
				() => new ReadableStreamSource(stream as never),
				`ReadableStreamSource(${repr(stream)})`,
				'stream',
			);
		}
		await checkOptions(
			'ReadableStreamSource',
			o => new ReadableStreamSource(new ReadableStream(), o as never),
			cacheFields,
		);

		const custom = { getSize: () => 0, read: () => new Uint8Array(0) };
		await checkOptions('CustomSource', o => new CustomSource(o as never), [
			['getSize', NOT_FUNCTION],
			['read', NOT_FUNCTION],
			['dispose', NOT_FUNCTION],
			// Falsy values slip through on main
			['prefetchProfile', ['bogus', 1, true]],
			...cacheFields,
		], { base: custom, optional: false });

		for (const rootPath of NOT_STRING) {
			await expectRejection(
				() => new CustomPathedSource(rootPath as never, () => new BufferSource(new Uint8Array(0))),
				'CustomPathedSource rootPath',
				'rootPath',
			);
		}
		for (const handler of NOT_FUNCTION) {
			await expectRejection(
				() => new CustomPathedSource('a.m3u8', handler as never),
				'CustomPathedSource requestHandler',
				'requestHandler',
			);
		}

		const source = new BufferSource(new Uint8Array(10));
		for (const value of NOT_NON_NEGATIVE_INTEGER) {
			await expectRejection(() => source.slice(value as never), `slice(${repr(value)})`, 'offset');
			if (value !== null) {
				await expectRejection(() => source.slice(0, value as never), `slice(0, ${repr(value)})`, 'length');
			}
		}
	});

	test('Input, InputTrack and sinks', async () => {
		const bytes = readPublic('video.mp4');
		const source = () => new BufferSource(bytes);

		await checkOptions('Input', o => new Input(o as never), [
			['formats', [undefined, null, 'mp4', [null], [{}], MP4]],
			['source', [undefined, null, 'video.mp4', bytes]],
			['initInput', [...NOT_OBJECT, {}]],
			['formatOptions', NOT_OBJECT],
		], { base: { formats: ALL_FORMATS, source: source() }, optional: false });
		const withFormatOptions = (formatOptions: unknown) => new Input({
			formats: ALL_FORMATS,
			source: source(),
			formatOptions: formatOptions as never,
		});
		await checkOptions('InputFormatOptions', withFormatOptions, [
			['isobmff', NOT_OBJECT],
			['hls', NOT_OBJECT],
		]);
		for (const resolveKeyId of NOT_FUNCTION) {
			await expectRejection(
				() => withFormatOptions({ isobmff: { resolveKeyId } }),
				'formatOptions.isobmff.resolveKeyId',
				'resolveKeyId',
			);
		}
		for (const offsetTimestampsByDateTime of NOT_BOOLEAN) {
			await expectRejection(
				() => withFormatOptions({ hls: { offsetTimestampsByDateTime } }),
				'formatOptions.hls.offsetTimestampsByDateTime',
				'offsetTimestampsByDateTime',
			);
		}

		using input = new Input({ formats: ALL_FORMATS, source: source() });
		const video = (await input.getPrimaryVideoTrack())!;
		const audio = (await input.getPrimaryAudioTrack())!;

		const badQueries = ['query', 1, { filter: 'f' }, { sortBy: 1 }];
		const queryMethods = [
			'getTracks', 'getVideoTracks', 'getAudioTracks', 'getPrimaryVideoTrack', 'getPrimaryAudioTrack',
		] as const;
		for (const method of queryMethods) {
			for (const query of badQueries) {
				await expectRejection(() => input[method](query as never), `input.${method}(${repr(query)})`, 'query');
			}
		}
		await expectRejection(() => input.getTracks({ filter: () => 'yes' } as never), 'filter result', 'query.filter');
		await expectRejection(
			() => input.getTracks({ sortBy: () => 'first' } as never),
			'sortBy result',
			'query.sortBy',
		);

		for (const other of [undefined, null, {}, input]) {
			await expectRejection(
				() => video.canBePairedWith(other as never),
				`canBePairedWith(${repr(other)})`,
				'other',
			);
		}
		for (const packet of [undefined, null, {}]) {
			await expectRejection(
				() => video.determinePacketType(packet as never),
				'video.determinePacketType',
				'packet',
			);
			await expectRejection(
				() => audio.determinePacketType(packet as never),
				'audio.determinePacketType',
				'packet',
			);
		}
		const metadataOnly = (await new EncodedPacketSink(video).getFirstPacket({ metadataOnly: true }))!;
		await expectRejection(
			() => video.determinePacketType(metadataOnly),
			'determinePacketType(metadata-only)',
			'metadata-only',
		);
		await checkOptions('computeFrameRateMetrics', o => video.computeFrameRateMetrics(o as never), [
			['targetPacketCount', [-1, NaN, '1', null]],
		]);
		for (const predicate of ['predicate', 1]) {
			for (const method of ['hasPairableTrack', 'hasPairableVideoTrack', 'hasPairableAudioTrack'] as const) {
				await expectRejection(
					() => video[method](predicate as never),
					`${method}(${repr(predicate)})`,
					'predicate',
				);
			}
		}
		await expectRejection(() => video.hasPairableTrack(() => 'yes' as never), 'predicate result', 'predicate');

		for (const track of [undefined, null, {}, input]) {
			await expectRejection(
				() => new EncodedPacketSink(track as never),
				`EncodedPacketSink(${repr(track)})`,
				'track',
			);
		}
		const sinks = [
			[VideoSampleSink, audio], [CanvasSink, audio], [AudioSampleSink, video], [AudioBufferSink, video],
		] as const;
		for (const [Sink, wrongTrack] of sinks) {
			for (const track of [undefined, null, {}, wrongTrack]) {
				await expectRejection(
					() => new (Sink as new (t: unknown) => unknown)(track),
					`${Sink.name}(${repr(track)})`,
					'Track',
				);
			}
		}

		const sink = new EncodedPacketSink(video);
		const first = (await sink.getFirstPacket())!;
		for (const timestamp of [NaN, '1', null, undefined]) {
			await expectRejection(
				() => sink.getPacket(timestamp as never),
				`getPacket(${repr(timestamp)})`,
				'timestamp',
			);
			await expectRejection(
				() => sink.getKeyPacket(timestamp as never),
				`getKeyPacket(${repr(timestamp)})`,
				'timestamp',
			);
		}
		for (const packet of [undefined, null, {}]) {
			await expectRejection(() => sink.getNextPacket(packet as never), 'getNextPacket', 'packet');
			await expectRejection(() => sink.getNextKeyPacket(packet as never), 'getNextKeyPacket', 'packet');
		}
		await expectRejection(
			() => sink.getNextPacket(new EncodedPacket(new Uint8Array(1), 'key', 0, 0)),
			'foreign packet',
			'Packet was not created from this track',
			Error,
		);
		const retrievalFields: FieldRule[] = [
			['metadataOnly', NOT_BOOLEAN],
			['verifyKeyPackets', NOT_BOOLEAN],
			['skipLiveWait', NOT_BOOLEAN],
		];
		await checkOptions('getFirstPacket', o => sink.getFirstPacket(o as never), retrievalFields);
		await checkOptions('getPacket', o => sink.getPacket(0, o as never), retrievalFields);
		await checkOptions('getNextPacket', o => sink.getNextPacket(first, o as never), retrievalFields);
		await checkOptions('getKeyPacket', o => sink.getKeyPacket(0, o as never), retrievalFields);
		await checkOptions('getNextKeyPacket', o => sink.getNextKeyPacket(first, o as never), retrievalFields);
		await checkOptions('packets', o => sink.packets(undefined, undefined, o as never), retrievalFields);
		await expectRejection(
			() => sink.getFirstPacket({ metadataOnly: true, verifyKeyPackets: true }),
			'both flags',
			'cannot be enabled together',
		);
		for (const packet of [null, {}]) {
			await expectRejection(() => sink.packets(packet as never), 'packets(startPacket)', 'startPacket');
			await expectRejection(() => sink.packets(undefined, packet as never), 'packets(_, endPacket)', 'endPacket');
		}
		await expectRejection(() => sink.packets(metadataOnly), 'packets(metadata-only start)', 'metadataOnly');

		for (const decoderOptions of NOT_OBJECT) {
			await expectRejection(
				() => new VideoSampleSink(video, decoderOptions as never),
				'VideoSampleSink decoderOptions',
				'decoderOptions',
			);
		}
		await expectRejection(
			() => new VideoSampleSink(video, { hardwareAcceleration: 'gpu' as never }),
			'hardwareAcceleration',
			'hardwareAcceleration',
		);
		await expectRejection(
			() => new VideoSampleSink(video, { optimizeForLatency: 1 as never }),
			'optimizeForLatency',
			'optimizeForLatency',
		);
		await checkOptions('CanvasSink', o => new CanvasSink(video, o as never), [
			['alpha', NOT_BOOLEAN],
			['width', NOT_POSITIVE_INTEGER],
			['height', NOT_POSITIVE_INTEGER],
			['fit', NOT_ENUM],
			['rotation', [45, -90, '90', null]],
			['flip', NOT_BOOLEAN],
			['crop', NOT_OBJECT],
			['poolSize', NOT_NON_NEGATIVE_INTEGER, 'poolSize'],
			['decoderOptions', NOT_OBJECT],
		], { notObject: ['options', 1, true] }); // Known bug: CanvasSink(track, null) fails internally
		await expectRejection(
			() => new CanvasSink(video, { width: 2, height: 2 }),
			'width + height without fit',
			'fit',
		);

		const wav = new Input({ formats: ALL_FORMATS, source: new BufferSource(readPublic('glitch-hop-is-dead.wav')) });
		const audioSink = new AudioSampleSink((await wav.getPrimaryAudioTrack())!);
		for (const timestamp of [NaN, '1', null]) {
			await expectRejection(
				() => audioSink.getSample(timestamp as never),
				`getSample(${repr(timestamp)})`,
				'timestamp',
			);
			await expectRejection(
				() => audioSink.samples(timestamp as never).next(),
				`samples(${repr(timestamp)})`,
				'timestamp',
			);
			await expectRejection(
				() => audioSink.samples(0, timestamp as never).next(),
				`samples(0, ${repr(timestamp)})`,
				'timestamp',
			);
			await expectRejection(
				() => audioSink.samplesAtTimestamps([timestamp as never]).next(),
				`samplesAtTimestamps([${repr(timestamp)}])`,
				'timestamp',
			);
		}
		// Sample sinks spread their options into the packet retrieval options, so non-objects are tolerated there
		await checkOptions(
			'samples',
			o => audioSink.samples(0, 0.1, o as never).next(),
			retrievalFields.slice(2),
			{ notObject: [] },
		);
		wav.dispose();
	});

	test('Output and track metadata', async () => {
		const target = () => new BufferTarget();
		await checkOptions('Output', o => new Output(o as never), [
			['format', [undefined, null, 'mp4', {}, MP4]],
			['target', [undefined, null, 'out.mp4', {}, new WritableStream()]],
			['onFinalize', NOT_FUNCTION],
		], { base: { format: new MkvOutputFormat(), target: target() }, optional: false });
		for (const initTarget of ['init.mp4', 1, {}, null]) {
			// A plain Error on main, a TypeError elsewhere; both name the option
			await expectRejection(
				() => new Output({ format: new MkvOutputFormat(), target: target(), initTarget: initTarget as never }),
				`initTarget: ${repr(initTarget)}`,
				'initTarget',
				Error,
			);
		}

		const output = new Output({ format: new MkvOutputFormat(), target: target() });
		const addMethods = [
			['addVideoTrack', new EncodedAudioPacketSource('aac')],
			['addAudioTrack', new TextSubtitleSource('webvtt')],
			['addSubtitleTrack', new EncodedVideoPacketSource('avc')],
		] as const;
		for (const [method, wrong] of addMethods) {
			for (const source of [undefined, null, {}, wrong]) {
				await expectRejection(() => output[method](source as never), `${method}(${repr(source)})`, 'source');
			}
		}

		const base: FieldRule[] = [
			['languageCode', ['en', 'ENG', 'eng ', '', 1, null]],
			['name', NOT_STRING],
			['disposition', [...NOT_OBJECT, { default: 'yes' }, { forced: 1 }, { primary: null }], 'disposition'],
			['maximumPacketCount', NOT_NON_NEGATIVE_INTEGER],
			['bitrate', [...NOT_NON_NEGATIVE, Infinity]],
			['averageBitrate', [...NOT_NON_NEGATIVE, Infinity]],
			['group', [null, 'group', {}, [null]]],
		];
		const addAudio = (metadata: unknown) => output.addAudioTrack(
			new EncodedAudioPacketSource('aac'),
			metadata as never,
		);
		await checkOptions('addAudioTrack', addAudio, [
			...base,
			['decoderConfig', [
				null, 'config', {}, { codec: 'mp4a.40.2' }, { codec: 'opus', numberOfChannels: 2, sampleRate: 48000 },
			], null],
			['primingPacket', [null, {}]],
		]);
		await checkOptions(
			'addSubtitleTrack',
			m => output.addSubtitleTrack(new TextSubtitleSource('webvtt'), m as never),
			base,
		);
		const addVideo = (metadata: unknown) => output.addVideoTrack(
			new EncodedVideoPacketSource('avc'),
			metadata as never,
		);
		await checkOptions('addVideoTrack', addVideo, [
			...base,
			['rotation', [45, -90, 360, '90', null, NaN], 'rotation'],
			['flip', NOT_BOOLEAN],
			['transformationMatrix', [null, [], new Array(8).fill(0), new Array(9).fill(NaN), new Array(9).fill('1')]],
			['frameRate', [0, -1, NaN, Infinity, '30', null], 'frame rate'],
			['hasOnlyKeyPackets', NOT_BOOLEAN],
			['canBeTransparent', NOT_BOOLEAN],
			['decoderConfig', [
				null, 'config', {}, { codec: 'avc1.42001f' }, { codec: 'vp8', codedWidth: 2, codedHeight: 2 },
			], null],
			['primingPacket', [null, {}]],
		]);
		await expectRejection(
			() => addVideo({ primingPacket: new EncodedPacket(new Uint8Array(1), 'key', 0, 0) }),
			'primingPacket without decoderConfig',
			'primingPacket',
		);

		const image = { data: new Uint8Array(1), mimeType: 'image/png', kind: 'coverFront' };
		await checkOptions('setMetadataTags', t => output.setMetadataTags(t as never), [
			...['title', 'description', 'artist', 'album', 'albumArtist', 'genre', 'lyrics', 'comment']
				.map((field): FieldRule => [field, NOT_STRING]),
			...['trackNumber', 'tracksTotal', 'discNumber', 'discsTotal', 'beatsPerMinute']
				.map((field): FieldRule => [field, [0, -1, 1.5, NaN, '1', null]]),
			['date', [null, 'today', new Date(NaN), 0]],
			['creationTime', ['today', new Date(NaN), 0]],
			['images', [
				null, 'images', [{}], [{ ...image, data: 'png' }], [{ ...image, kind: 'cover' }],
				[{ ...image, mimeType: 1 }],
			], null],
			['raw', [null, 'raw', { key: 1 }], null],
		], { optional: false });
	});

	test('media sources', async () => {
		for (const codec of [undefined, null, '', 'AVC', 'h264', 'aac', 1]) {
			await expectRejection(
				() => new EncodedVideoPacketSource(codec as never),
				`EncodedVideoPacketSource(${repr(codec)})`,
				'video codec',
			);
		}
		for (const codec of [undefined, null, '', 'AAC', 'avc', 1]) {
			await expectRejection(
				() => new EncodedAudioPacketSource(codec as never),
				`EncodedAudioPacketSource(${repr(codec)})`,
				'audio codec',
			);
		}
		for (const codec of [undefined, null, '', 'srt', 1]) {
			await expectRejection(
				() => new TextSubtitleSource(codec as never),
				`TextSubtitleSource(${repr(codec)})`,
				'subtitle codec',
			);
		}

		await checkOptions('VideoSampleSource', c => new VideoSampleSource(c as never), [
			['codec', [undefined, null, 'h264', 1], 'video codec'],
			['quality', ['high', {}, 0.5]],
			['keyFrameInterval', [...NOT_NON_NEGATIVE, Infinity]],
			['sizeChangeBehavior', NOT_ENUM],
			['transform', NOT_OBJECT],
			['onEncodedPacket', NOT_FUNCTION],
			['onEncoderConfig', NOT_FUNCTION],
			['onEncodedSample', NOT_FUNCTION],
			['alpha', NOT_ENUM],
			['latencyMode', NOT_ENUM],
			['fullCodecString', [1, null, 'vp8', 'mp4a.40.2']],
			['hardwareAcceleration', NOT_ENUM],
			['scalabilityMode', NOT_STRING],
			['contentHint', NOT_STRING],
		], { base: { codec: 'avc', quality }, optional: false });
		await expectRejection(() => new VideoSampleSource({ codec: 'avc' }), 'no quality', 'quality');
		await expectRejection(
			() => new VideoSampleSource({ codec: 'avc', quality, bitrate: 1e6 }),
			'quality + bitrate',
			'bitrate',
		);
		for (const bitrate of [0, -1, 1.5, 'high']) {
			await expectRejection(
				() => new VideoSampleSource({ codec: 'avc', bitrate: bitrate as never }),
				`bitrate: ${repr(bitrate)}`,
				'bitrate',
			);
		}
		const withVideoTransform = (transform: unknown) => new VideoSampleSource({
			codec: 'avc',
			quality,
			transform: transform as never,
		});
		await checkOptions('VideoEncodingConfig.transform', withVideoTransform, [
			['width', NOT_POSITIVE_INTEGER],
			['height', NOT_POSITIVE_INTEGER],
			['fit', NOT_ENUM],
			['rotate', [45, -90, '90', null]],
			['flip', NOT_BOOLEAN],
			['crop', [...NOT_OBJECT, { left: -1, top: 0, width: 1, height: 1 }]],
			['process', NOT_FUNCTION],
			['frameRate', [0, -1, NaN, Infinity, '30', null]],
			['force', NOT_BOOLEAN],
		]);
		await expectRejection(
			() => new VideoSampleSource({ codec: 'avc', quality, transform: { width: 2, height: 2 } }),
			'width + height without fit',
			'fit',
		);

		const audioFields: FieldRule[] = [
			['codec', [undefined, null, 'AAC', 1], 'audio codec'],
			['quality', ['high', {}]],
			['transform', NOT_OBJECT],
			['onEncodedPacket', NOT_FUNCTION],
			['onEncoderConfig', NOT_FUNCTION],
			['onEncodedSample', NOT_FUNCTION],
			['bitrateMode', NOT_ENUM],
			['fullCodecString', [1, null, 'opus']],
		];
		await checkOptions(
			'AudioSampleSource',
			c => new AudioSampleSource(c as never),
			audioFields,
			{ base: { codec: 'pcm-s16' }, optional: false },
		);
		await checkOptions(
			'AudioBufferSource',
			c => new AudioBufferSource(c as never),
			audioFields,
			{ base: { codec: 'pcm-s16' }, optional: false },
		);
		await expectRejection(
			() => new AudioSampleSource({ codec: 'aac' }),
			'compressed codec without quality',
			'quality',
		);
		const withAudioTransform = (transform: unknown) => new AudioSampleSource({
			codec: 'pcm-s16',
			transform: transform as never,
		});
		await checkOptions('AudioEncodingConfig.transform', withAudioTransform, [
			['numberOfChannels', NOT_POSITIVE_INTEGER],
			['sampleRate', NOT_POSITIVE_INTEGER],
			['sampleFormat', [...NOT_ENUM, 'f64']],
			['process', NOT_FUNCTION],
		]);
		await checkOptions('AudioBufferSource options', o => new AudioBufferSource({ codec: 'pcm-s16' }, o as never), [
			['startTimestamp', NOT_FINITE],
		]);
		for (const canvas of [undefined, null, {}, 'canvas']) {
			await expectRejection(
				() => new CanvasSource(canvas as never, { codec: 'avc', quality }),
				`CanvasSource(${repr(canvas)})`,
				'canvas',
			);
		}

		// add() arguments are checked before anything else happens
		const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		const videoPackets = new EncodedVideoPacketSource('avc');
		const audioSamples = new AudioSampleSource({ codec: 'pcm-s16' });
		const videoSamples = new VideoSampleSource({ codec: 'avc', quality });
		const subtitles = new TextSubtitleSource('webvtt');
		output.addVideoTrack(videoPackets);
		output.addAudioTrack(audioSamples);
		output.addSubtitleTrack(subtitles);
		await output.start();
		for (const value of [undefined, null, {}, 'packet']) {
			await expectRejection(
				() => videoPackets.add(value as never),
				`EncodedVideoPacketSource.add(${repr(value)})`,
				'packet',
			);
			await expectRejection(
				() => audioSamples.add(value as never),
				`AudioSampleSource.add(${repr(value)})`,
				'audioSample',
			);
			await expectRejection(
				() => videoSamples.add(value as never),
				`VideoSampleSource.add(${repr(value)})`,
				'videoSample',
			);
		}
		for (const text of [undefined, null, 1, {}]) {
			await expectRejection(() => subtitles.add(text as never), `TextSubtitleSource.add(${repr(text)})`, 'text');
		}
		const packet = new EncodedPacket(new Uint8Array(4), 'key', 0, 0.04);
		for (const meta of [null, 'meta', 1]) {
			await expectRejection(() => videoPackets.add(packet, meta as never), `add(packet, ${repr(meta)})`, 'meta');
		}
		await output.cancel();
	});

	test('packets and samples', async () => {
		const data = new Uint8Array(4);
		for (const value of ['bytes', [1], new ArrayBuffer(1)]) {
			await expectRejection(
				() => new EncodedPacket(value as never, 'key', 0, 0),
				`EncodedPacket(${repr(value)})`,
				'data',
			);
		}
		for (const type of [undefined, 'KEY', '', 1]) {
			await expectRejection(() => new EncodedPacket(data, type as never, 0, 0), `type ${repr(type)}`, 'type');
		}
		for (const value of NOT_FINITE) {
			await expectRejection(
				() => new EncodedPacket(data, 'key', value as never, 0),
				`timestamp ${repr(value)}`,
				'timestamp',
			);
			await expectRejection(
				() => new EncodedPacket(data, 'key', 0, value as never),
				`duration ${repr(value)}`,
				'duration',
			);
			await expectRejection(
				() => new EncodedPacket(data, 'key', 0, 0, value as never),
				`sequenceNumber ${repr(value)}`,
				'sequenceNumber',
			);
		}
		await expectRejection(() => new EncodedPacket(data, 'key', 0, -1), 'negative duration', 'duration');
		for (const value of NOT_NON_NEGATIVE_INTEGER) {
			await expectRejection(
				() => new EncodedPacket(data, 'key', 0, 0, -1, value as never),
				`byteLength ${repr(value)}`,
				'byteLength',
			);
		}
		for (const sideData of [null, 'side', 1, { alpha: 'a' }, { alphaByteLength: -1 }, { alphaByteLength: 1.5 }]) {
			await expectRejection(
				() => new EncodedPacket(data, 'key', 0, 0, -1, undefined, sideData as never),
				`sideData ${repr(sideData)}`,
				'sideData',
			);
		}
		const packet = new EncodedPacket(data, 'key', 1, 1);
		await checkOptions('EncodedPacket.clone', o => packet.clone(o as never), [
			['data', ['bytes', [1]]],
			['type', ['KEY', 1]],
			['timestamp', NOT_FINITE],
			['duration', NOT_FINITE],
			['sequenceNumber', NOT_FINITE],
			['sideData', NOT_OBJECT],
		]);

		const audioInit = {
			data: new Float32Array(8), format: 'f32-planar', numberOfChannels: 2, sampleRate: 48000, timestamp: 0,
		};
		await checkOptions('AudioSample', i => new AudioSample(i as never), [
			['format', [undefined, null, 'F32', 'f64', ''], 'format'],
			['numberOfChannels', [0, 1.5, NaN, '2', null]],
			['sampleRate', [0, -1, NaN, Infinity, '1', null]],
			['timestamp', NOT_FINITE],
			['data', ['bytes', 5, new Uint8Array(3)], null],
		], { base: audioInit, optional: false });
		using sample = new AudioSample(audioInit as never);
		const copyFields: FieldRule[] = [
			['planeIndex', [-1, 0.5, undefined, '0']],
			['format', NOT_ENUM, 'format'],
			['frameOffset', [-1, 0.5, NaN]],
			['frameCount', [-1, 0.5, NaN]],
		];
		await checkOptions(
			'allocationSize',
			o => sample.allocationSize(o as never),
			copyFields,
			{ base: { planeIndex: 0 }, optional: false },
		);
		await checkOptions(
			'copyTo',
			o => sample.copyTo(new Float32Array(4), o as never),
			copyFields,
			{ base: { planeIndex: 0 }, optional: false },
		);
		for (const destination of [undefined, null, [0, 0]]) {
			await expectRejection(
				() => sample.copyTo(destination as never, { planeIndex: 0 }),
				`copyTo(${repr(destination)})`,
				'destination',
			);
		}
		// Out-of-range indices are RangeErrors, like in WebCodecs
		await expectRejection(() => sample.allocationSize({ planeIndex: 2 }), 'planeIndex 2', 'planeIndex', RangeError);
		await expectRejection(
			() => sample.allocationSize({ planeIndex: 0, frameOffset: 5 }),
			'frameOffset 5',
			'frameOffset',
			RangeError,
		);
		await expectRejection(
			() => sample.allocationSize({ planeIndex: 0, frameOffset: 2, frameCount: 3 }),
			'frameCount 3',
			'frameCount',
			RangeError,
		);
		await expectRejection(
			() => sample.copyTo(new Float32Array(1), { planeIndex: 0 }),
			'small destination',
			'too small',
			RangeError,
		);
		for (const value of [-1, 0.5, NaN, undefined]) {
			await expectRejection(() => sample.trim(value as never), `trim(${repr(value)})`, 'startFrame');
		}
		await expectRejection(() => sample.trim(0, -1), 'trim(0, -1)', 'endFrame');
		await expectRejection(() => sample.trim(5), 'trim(5)', 'startFrame', RangeError);
		await expectRejection(() => sample.trim(2, 1), 'trim(2, 1)', 'endFrame', RangeError);
		for (const value of NOT_FINITE) {
			await expectRejection(
				() => {
					const clone = sample.clone();
					try {
						clone.setTimestamp(value as never);
					} finally {
						clone.close();
					}
				},
				`setTimestamp(${repr(value)})`,
				'newTimestamp',
			);
		}

		const pixels = new Uint8Array(4 * 4 * 4);
		const videoInit = { format: 'RGBA', codedWidth: 4, codedHeight: 4, timestamp: 0 };
		for (const value of [undefined, null, 'pixels', 1, {}, [1]]) {
			await expectRejection(
				() => new VideoSample(value as never, videoInit as never),
				`VideoSample(${repr(value)})`,
				'data',
			);
		}
		await checkOptions('VideoSample init', i => new VideoSample(pixels, i as never), [
			['format', [undefined, 'rgba', '', 1], 'format'],
			['codedWidth', NOT_POSITIVE_INTEGER],
			['codedHeight', NOT_POSITIVE_INTEGER],
			['timestamp', NOT_FINITE],
			['duration', [...NOT_FINITE, -1]],
			['rotation', [45, -90, '90', null], 'rotation'],
			['flip', NOT_BOOLEAN],
			['colorSpace', [
				'srgb', 1, { primaries: 'bogus' }, { transfer: 'bogus' }, { matrix: 'bogus' }, { fullRange: 'yes' },
			], 'colorSpace'],
			['layout', [null, 'layout', [{ offset: -1, stride: 16 }], [{ offset: 0, stride: 1.5 }]], null],
			// A zero-sized visible rect fails an assertion on main (fixed in upstream's bug-fix-mania branch)
			['visibleRect', [
				null, 'rect', { left: -1, top: 0, width: 4, height: 4 }, { left: 0, top: 0, width: NaN, height: 4 },
			], 'visibleRect'],
			['displayWidth', NOT_POSITIVE_INTEGER],
			['displayHeight', NOT_POSITIVE_INTEGER],
		], { base: videoInit, optional: false });
		using video = new VideoSample(pixels, videoInit as never);
		const badCopyOptions = [
			null, 'options', { rect: { x: -1, y: 0, width: 2, height: 2 } }, { layout: null },
			{ colorSpace: 'rec2020' },
		];
		for (const options of badCopyOptions) {
			await expectRejection(
				() => video.allocationSize(options as never),
				`allocationSize(${repr(options)})`,
				undefined,
			);
		}
		for (const destination of [undefined, null, [0, 0]]) {
			await expectRejection(
				() => video.copyTo(destination as never),
				`copyTo(${repr(destination)})`,
				'destination',
			);
		}
		for (const rotation of [45, '90', null, NaN]) {
			await expectRejection(
				() => video.setRotation(rotation as never),
				`setRotation(${repr(rotation)})`,
				'newRotation',
			);
		}
		for (const flip of NOT_BOOLEAN) {
			await expectRejection(() => video.setFlip(flip as never), `setFlip(${repr(flip)})`, 'newFlip');
		}
		for (const value of NOT_FINITE) {
			await expectRejection(
				() => video.setTimestamp(value as never),
				`setTimestamp(${repr(value)})`,
				'newTimestamp',
			);
			await expectRejection(
				() => video.setDuration(value as never),
				`setDuration(${repr(value)})`,
				'newDuration',
			);
		}
		await expectRejection(() => video.setDuration(-1), 'setDuration(-1)', 'newDuration');
		for (const value of [null, 'options', 1, undefined]) {
			await expectRejection(
				() => video.setEncodeOptions(value as never),
				`setEncodeOptions(${repr(value)})`,
				'newEncodeOptions',
			);
		}
		await checkOptions('VideoSample.transform', o => video.transform(o as never), [
			['width', NOT_POSITIVE_INTEGER],
			['height', NOT_POSITIVE_INTEGER],
			['roundDimensionsTo', NOT_POSITIVE_INTEGER],
			['fit', NOT_ENUM],
			['rotate', [45, '90', null]],
			['flip', NOT_BOOLEAN],
			['crop', NOT_OBJECT],
			['alpha', NOT_ENUM],
		], { valid: false }); // Transforming needs a canvas
		for (const context of [undefined, null, {}]) {
			await expectRejection(() => video.draw(context as never, 0, 0), 'draw(context)', 'context');
			await expectRejection(
				() => video.drawWithFit(context as never, { fit: 'fill' }),
				'drawWithFit(context)',
				'context',
			);
		}

		await checkOptions('VideoSampleColorSpace', i => new VideoSampleColorSpace(i as never), [
			['primaries', ['bogus', 1], 'primaries'],
			['transfer', ['bogus', 1], 'transfer'],
			['matrix', ['bogus', 1], 'matrix'],
			['fullRange', [1, 'true', {}], 'fullRange'], // null is valid, as in WebCodecs
		]);

		for (const value of [undefined, null, 'image', new ArrayBuffer(1)]) {
			await expectRejection(() => new RichImageData(value as never, 'image/png'), 'RichImageData data', 'data');
			await expectRejection(() => new AttachedFile(value as never), 'AttachedFile data', 'data');
		}
		await expectRejection(() => new RichImageData(data, 1 as never), 'RichImageData mimeType', 'mimeType');
		await expectRejection(() => new AttachedFile(data, 1 as never), 'AttachedFile mimeType', 'mimeType');
		await expectRejection(() => new AttachedFile(data, undefined, 1 as never), 'AttachedFile name', 'name');
		await expectRejection(
			() => new AttachedFile(data, undefined, undefined, 1 as never),
			'AttachedFile description',
			'description',
		);

		for (const value of [undefined, null, 'great', 'HIGH', NaN, {}]) {
			await expectRejection(() => new Quality(value as never), `Quality(${repr(value)})`, undefined);
		}
		await checkOptions('Quality (bitrate)', o => new Quality(o as never), [
			['bitrate', [0, -1, 1.5, NaN, '1', null]],
			['quantizer', [-1, 1.5, NaN, '1', null]],
			['bitrateMode', NOT_ENUM],
			['preferBitrate', [true]],
			// Numbers are quality factors, so only these are non-object options
		], { base: { bitrate: 1e6 }, optional: false, notObject: [null, true, 'options'] });
		await checkOptions('Quality (level)', o => new Quality(o as never), [
			['preferBitrate', NOT_BOOLEAN],
			['bitrate', [1e6], 'quality cannot be combined'],
			['quantizer', [20], 'quality cannot be combined'],
		], { base: { quality: 'high' }, optional: false, notObject: [null, true, 'options'] });
	});

	test('codec queries, conversion and miscellaneous', async () => {
		await checkOptions('canDecodeVideo', o => canDecodeVideo('avc', o as never), [
			['codec', [1, 'vp8']],
			['codedWidth', NOT_POSITIVE_INTEGER],
			['codedHeight', NOT_POSITIVE_INTEGER],
			['displayAspectWidth', NOT_POSITIVE_INTEGER],
			['displayAspectHeight', NOT_POSITIVE_INTEGER],
			['description', ['avcC', 1, {}]],
			['hardwareAcceleration', NOT_ENUM],
			['optimizeForLatency', NOT_BOOLEAN],
		]);
		await checkOptions('canDecodeAudio', o => canDecodeAudio('aac', o as never), [
			['codec', [1, 'opus']],
			['numberOfChannels', NOT_POSITIVE_INTEGER],
			['sampleRate', NOT_POSITIVE_INTEGER],
			['description', ['esds', 1, {}]],
		]);
		// canEncodeVideo/canEncodeAudio(codec, null) fail internally on main, so only fields are checked
		const encodeFields = (rules: FieldRule[], call: (o: unknown) => unknown, label: string) => Promise.all(
			rules.flatMap(([field, values, mention]) => values.map(value => expectRejection(
				() => call({ [field]: value }),
				`${label}({ ${field}: ${repr(value)} })`,
				mention === null ? undefined : (mention ?? field),
			))),
		);
		await encodeFields([
			['width', NOT_POSITIVE_INTEGER],
			['height', NOT_POSITIVE_INTEGER],
			['quality', ['high', {}]],
			['bitrate', [0, -1, 'high']],
			['frameRate', [0, -1, NaN, Infinity]],
			['alpha', NOT_ENUM],
			['latencyMode', NOT_ENUM],
			['fullCodecString', [1, 'vp8']],
			['hardwareAcceleration', NOT_ENUM],
		], o => canEncodeVideo('avc', o as never), 'canEncodeVideo');
		await encodeFields([
			['numberOfChannels', NOT_POSITIVE_INTEGER],
			['sampleRate', NOT_POSITIVE_INTEGER],
			['quality', ['high', {}]],
			['bitrate', [0, -1, 'high']],
			['bitrateMode', NOT_ENUM],
			['fullCodecString', [1, 'opus']],
		], o => canEncodeAudio('aac', o as never), 'canEncodeAudio');

		const wav = readPublic('glitch-hop-is-dead.wav');
		const conversionBase = () => ({
			input: new Input({ formats: ALL_FORMATS, source: new BufferSource(wav) }),
			output: new Output({ format: new WavOutputFormat(), target: new BufferTarget() }),
		});
		await checkOptions('Conversion.init', o => Conversion.init(o as never), [
			['input', [undefined, null, {}]],
			['output', [undefined, null, {}]],
			['tracks', ['every', null, 1]],
			['composable', NOT_BOOLEAN],
			['copy', [
				null, 'yes', true, 1, { mode: 'always' }, { shiftTolerance: -1 }, { boundaryPolicy: 'cut' },
				{ boundaryTolerance: NaN },
			], null],
			['trim', [
				null, 'start', { start: NaN }, { start: Infinity }, { end: NaN }, { start: 2, end: 1 },
				{ start: 1, end: 1 },
			], null],
			['tags', [null, 'tags', 1, { title: 1 }], null],
			['showWarnings', NOT_BOOLEAN],
		], { base: conversionBase, optional: false });

		const mp4 = readPublic('video.mp4');
		const withVideoOptions = (video: unknown) => Conversion.init({
			input: new Input({ formats: ALL_FORMATS, source: new BufferSource(mp4) }),
			output: new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() }),
			video: video as never,
		});
		await checkOptions('Conversion video options', withVideoOptions, [
			['discard', NOT_BOOLEAN],
			['width', NOT_POSITIVE_INTEGER],
			['height', NOT_POSITIVE_INTEGER],
			['fit', NOT_ENUM],
			['rotate', [45, -90, '90', null]],
			['flip', NOT_BOOLEAN],
			['allowTransformationMetadata', NOT_BOOLEAN],
			['allowRotationMetadata', NOT_BOOLEAN],
			['crop', [...NOT_OBJECT, { left: -1, top: 0, width: 2, height: 2 }]],
			['frameRate', [0, -1, NaN, Infinity, '30', null]],
			['codec', [...NOT_ENUM, 'h264', 'aac']],
			['quality', ['high', {}, 0.5]],
			['bitrate', [0, -1, 1.5, 'high']],
			['alpha', NOT_ENUM],
			['keyFrameInterval', [-1, NaN, '1', null]],
			['hardwareAcceleration', NOT_ENUM],
			['forceTranscode', NOT_BOOLEAN],
			['process', NOT_FUNCTION],
			['processedWidth', NOT_POSITIVE_INTEGER],
			['processedHeight', NOT_POSITIVE_INTEGER],
			['group', ['group', {}, [null]]],
			['maximumPacketCount', NOT_NON_NEGATIVE_INTEGER],
		]);
		await expectRejection(() => withVideoOptions([null]), 'video: [null]', 'options.video');
		await expectRejection(() => withVideoOptions(() => 'small'), 'video callback result', 'options.video');

		const withAudioOptions = (audio: unknown) => Conversion.init({ ...conversionBase(), audio: audio as never });
		await checkOptions('Conversion audio options', withAudioOptions, [
			['discard', NOT_BOOLEAN],
			['numberOfChannels', NOT_POSITIVE_INTEGER],
			['sampleRate', NOT_POSITIVE_INTEGER],
			['sampleFormat', [...NOT_ENUM, 'f64']],
			['codec', [...NOT_ENUM, 'AAC', 'avc']],
			['quality', ['high', {}, 0.5]],
			['bitrate', [0, -1, 1.5, 'high']],
			['forceTranscode', NOT_BOOLEAN],
			['process', NOT_FUNCTION],
			['processedNumberOfChannels', NOT_POSITIVE_INTEGER],
			['processedSampleRate', NOT_POSITIVE_INTEGER],
			['group', ['group', {}, [null]]],
			['maximumPacketCount', NOT_NON_NEGATIVE_INTEGER],
		]);
		await expectRejection(
			() => Conversion.init({ ...conversionBase(), composable: true, tags: {} }),
			'composable + tags',
			'tags',
		);
		await expectRejection(
			() => Conversion.init({ ...conversionBase(), audio: () => 'stereo' as never }),
			'audio callback result',
			'options.audio',
		);
		const conversion = await Conversion.init(conversionBase());
		await checkOptions('execute', o => conversion.execute(o as never), [
			['until', [NaN, '1', null]],
			['pauseSignal', [null, 'signal', {}]],
		], { optional: false });
		await conversion.cancel();

		for (const level of [-1, 4, 1.5, NaN, 'info', null, undefined]) {
			const previous = Logging.level;
			await expectRejection(() => {
				Logging.level = level as never;
			}, `Logging.level = ${repr(level)}`, 'log level');
			expect(Logging.level).toBe(previous);
		}
		for (const level of [LogLevel.Silent, LogLevel.Errors, LogLevel.Warnings, LogLevel.Info]) {
			Logging.level = level;
			expect(Logging.level).toBe(level);
		}

		const group = new OutputTrackGroup();
		for (const other of [undefined, null, {}]) {
			await expectRejection(() => group.pairWith(other as never), `pairWith(${repr(other)})`, 'OutputTrackGroup');
		}
		await expectRejection(() => group.pairWith(group), 'pairWith(itself)', 'itself');

		// registerDecoder/registerEncoder(undefined | null) fail internally on main
		for (const coder of ['decoder', {}, () => {}, class {}]) {
			await expectRejection(() => registerDecoder(coder as never), `registerDecoder(${repr(coder)})`, 'Decoder');
			await expectRejection(() => registerEncoder(coder as never), `registerEncoder(${repr(coder)})`, 'Encoder');
		}
	});
});

describe('Lifecycle', () => {
	const packet = (timestamp: number) => new EncodedPacket(new Uint8Array(4), 'key', timestamp, 0.01);
	const pcmConfig = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 48000 } };

	test('Output: every operation is checked against the state', async () => {
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('pcm-s16');
		expect(output.state).toBe('pending');
		await expectRejection(() => source.add(packet(0), pcmConfig), 'add before addTrack', 'not connected', Error);
		await expectRejection(() => source.close(), 'close before addTrack', 'connecting', Error);
		output.addAudioTrack(source);
		await expectRejection(() => output.addAudioTrack(source), 'same source twice', 'already used', Error);
		await expectRejection(() => output.finalize(), 'finalize before start', 'before starting', Error);
		await expectRejection(() => source.add(packet(0), pcmConfig), 'add before start', 'not started', Error);
		await expectRejection(() => source.close(), 'close before start', 'before output has been started', Error);

		await output.start();
		expect(output.state).toBe('started');
		expect(await captureWarnings(() => output.start())).toEqual(['Output has already been started.']);
		await expectRejection(
			() => output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16')),
			'addTrack after start',
			'after output has been started',
			Error,
		);
		await expectRejection(
			() => output.setMetadataTags({ title: 'late' }),
			'tags after start',
			'after output has been started',
			Error,
		);
		await source.add(packet(0), pcmConfig);

		const finalizing = output.finalize();
		expect(output.state).toBe('finalizing');
		// Repeated finalize waits for the same work
		expect(await captureWarnings(() => Promise.all([finalizing, output.finalize()])))
			.toEqual(['Output has already been finalized.']);

		expect(output.state).toBe('finalized');
		await expectRejection(() => source.add(packet(1)), 'add after finalize', 'finalized', Error);
		expect(await captureWarnings(() => output.cancel())).toEqual(['Output has already been finalized.']);
		expect(output.state).toBe('finalized');

		const canceled = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const canceledSource = new EncodedAudioPacketSource('pcm-s16');
		canceled.addAudioTrack(canceledSource);
		await canceled.start();
		await canceled.cancel();
		expect(await captureWarnings(() => canceled.cancel())).toEqual([]); // Repeated cancel is silent
		expect(canceled.state).toBe('canceled');
		await expectRejection(() => canceled.start(), 'start after cancel', 'canceled', Error);
		await expectRejection(() => canceled.finalize(), 'finalize after cancel', 'canceling', Error);
		await expectRejection(() => canceledSource.add(packet(0), pcmConfig), 'add after cancel', 'canceled', Error);

		const never = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		await expectRejection(() => never.start(), 'start without the required track', 'requires', Error);
	});

	test('Input: disposal ends packet retrieval and is idempotent', async () => {
		const input = new Input({ source: new BufferSource(readPublic('video.mp4')), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		const sink = new EncodedPacketSink(track);
		const iterator = sink.packets();
		await iterator.next();

		expect(input.disposed).toBe(false);
		input[Symbol.dispose]();
		expect(input.disposed).toBe(true);
		input.dispose();

		await expectRejection(() => iterator.next(), 'iterator after dispose', undefined, InputDisposedError);
		await expectRejection(
			() => sink.getFirstPacket(),
			'getFirstPacket after dispose',
			undefined,
			InputDisposedError,
		);
		await expectRejection(() => sink.getPacket(0), 'getPacket after dispose', undefined, InputDisposedError);
		await expectRejection(() => sink.packets(), 'packets after dispose', undefined, InputDisposedError);
		await expectRejection(
			() => track.computePacketStats(),
			'computePacketStats after dispose',
			undefined,
			InputDisposedError,
		);
		await expectRejection(
			() => track.computeFrameRateMetrics(),
			'computeFrameRateMetrics after dispose',
			undefined,
			InputDisposedError,
		);
		expect(new InputDisposedError().message).toBe('Input has been disposed.');
		expect(new InputDisposedError().name).toBe('InputDisposedError');
	});

	test('Input: reads after dispose return cached data or reject with InputDisposedError', async () => {
		/** Resolves with 'cached', 'disposed', 'hang' or the unexpected error's message. */
		const outcomeOf = async (call: () => Promise<unknown>) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const hang = new Promise<string>((resolve) => {
				timer = setTimeout(() => resolve('hang'), 2000);
			});
			const settled = call().then(
				() => 'cached',
				(error: unknown) => (error instanceof InputDisposedError ? 'disposed' : String(error)),
			);
			const outcome = await Promise.race([settled, hang]);
			clearTimeout(timer);
			return outcome;
		};

		// Disposing before the first read fails with "ref has already been freed" on main (fixed in upstream's
		// bug-fix-mania branch), and HLS has its own fix in flight, so this covers inputs that were read from first
		const files = [
			'video.mp4', 'trunc-buck-bunny.mov', 'ac3.mkv', 'demo.webm', 'glitch-hop-is-dead.wav', 'vorbis-eos.ogg',
			'sample.flac', 'Toothsome-Meme.VBRv2.mp3', 'sample3.aac', '0.ts',
		];
		for (const file of files) {
			const input = new Input({ source: new BufferSource(readPublic(file)), formats: ALL_FORMATS });
			const tracks = await input.getTracks();
			expect(tracks.length, file).toBeGreaterThan(0);
			input.dispose();

			const calls: [string, () => Promise<unknown>][] = [
				['getFormat', () => input.getFormat()],
				['getMimeType', () => input.getMimeType()],
				['getMetadataTags', () => input.getMetadataTags()],
				['getTracks', () => input.getTracks()],
				['computeDuration', () => input.computeDuration()],
				['getFirstTimestamp', () => input.getFirstTimestamp()],
				['getDurationFromMetadata', () => input.getDurationFromMetadata()],
			];
			for (const track of tracks) {
				calls.push(
					[`${track.type}.getCodecParameterString`, () => track.getCodecParameterString()],
					[`${track.type}.computeDuration`, () => track.computeDuration()],
					[`${track.type}.getFirstTimestamp`, () => track.getFirstTimestamp()],
					[`${track.type}.getDurationFromMetadata`, () => track.getDurationFromMetadata()],
				);
			}
			for (const [label, call] of calls) {
				expect(['cached', 'disposed'], `${file}: ${label}`).toContain(await outcomeOf(call));
			}
			// Reading packets always needs the source
			for (const track of tracks) {
				expect(await outcomeOf(() => new EncodedPacketSink(track).getFirstPacket()), file).toBe('disposed');
				expect(await outcomeOf(() => track.computePacketStats(10)), file).toBe('disposed');
			}
		}
	});

	test('Source references: freeing disposes the source exactly once', async () => {
		const source = new BufferSource(new Uint8Array(8));
		const first = source.ref();
		const second = source.ref();
		expect(first.source).toBe(source);
		first.free();
		expect(first.freed).toBe(true);
		await expectRejection(() => first.free(), 'double free', 'double free', Error);
		await expectRejection(() => first.source, 'source after free', 'freed', Error);
		first[Symbol.dispose](); // No-op for a freed ref
		expect(await source.getSize()).toBe(8);

		second[Symbol.dispose]();
		await expectRejection(() => source.getSize(), 'getSize after disposal', undefined, InputDisposedError);
		await expectRejection(
			() => source.getSizeOrNull(),
			'getSizeOrNull after disposal',
			undefined,
			InputDisposedError,
		);
		await expectRejection(() => source.ref(), 'ref after disposal', 'disposed', Error);
		await expectRejection(() => source.slice(0), 'slice after disposal', 'disposed', Error);
		await expectRejection(
			() => new Input({ source, formats: ALL_FORMATS }),
			'Input of a disposed source',
			'disposed',
		);
	});

	test('Samples: closed samples reject every operation that needs their data', async () => {
		const audio = new AudioSample({
			data: new Float32Array(4), format: 'f32', numberOfChannels: 1, sampleRate: 48000, timestamp: 0,
		});
		audio.close();
		audio.close();
		audio[Symbol.dispose]();
		for (const [name, call] of [
			['clone', () => audio.clone()],
			['allocationSize', () => audio.allocationSize({ planeIndex: 0 })],
			['copyTo', () => audio.copyTo(new Float32Array(4), { planeIndex: 0 })],
			['trim', () => audio.trim(0)],
			['toAudioData', () => audio.toAudioData()],
			['toAudioBuffer', () => audio.toAudioBuffer()],
		] as const) {
			await expectRejection(call, `closed AudioSample.${name}`, 'closed', Error);
		}

		const video = new VideoSample(new Uint8Array(16), {
			format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 0,
		});
		video.close();
		video.close();
		video[Symbol.dispose]();
		for (const [name, call] of [
			['clone', () => video.clone()],
			['allocationSize', () => video.allocationSize()],
			['copyTo', () => video.copyTo(new Uint8Array(16))],
			['toVideoFrame', () => video.toVideoFrame()],
		] as const) {
			await expectRejection(call, `closed VideoSample.${name}`, 'closed', Error);
		}
	});

	test('Conversion: states and repeated calls', async () => {
		const wav = readPublic('glitch-hop-is-dead.wav');
		const make = () => Conversion.init({
			input: new Input({ formats: ALL_FORMATS, source: new BufferSource(wav) }),
			output: new Output({ format: new WavOutputFormat(), target: new BufferTarget() }),
			trim: { end: 0.5 },
		});

		const conversion = await make();
		expect(conversion.state).toBe('idle');
		const running = conversion.execute();
		expect(conversion.state).toBe('executing');
		await expectRejection(() => conversion.execute(), 'concurrent execute', 'still running', Error);
		await running;
		expect(conversion.state).toBe('done');
		await conversion.execute(); // Nothing left to do
		await conversion.cancel();
		expect(conversion.state).toBe('done');

		const canceled = await make();
		await canceled.cancel();
		expect(canceled.state).toBe('canceled');
		await expectRejection(() => canceled.execute(), 'execute after cancel', undefined, ConversionCanceledError);
		expect(new ConversionCanceledError().name).toBe('ConversionCanceledError');

		const paused = await make();
		await paused.execute({ until: 0.2 });
		expect(paused.state).toBe('idle');
		await paused.execute();
		expect(paused.state).toBe('done');
	});
});
