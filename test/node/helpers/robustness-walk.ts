import type * as Mediabunny from '../../../src/index.js';

/** Error messages that point at a bug rather than a deliberately rejected file (as in bad-inputs.test.ts). */
export const UNINTENDED_ERROR = new RegExp([
	'Assertion failed',
	'likely an internal error',
	'Maximum call stack',
	'Cannot read prop',
	'is not a function',
	'is outside the bounds',
	'out of bounds',
	'Invalid array length',
	'Invalid typed array length',
	'Invalid array buffer length',
	'Invalid AudioDataInit',
	'Invalid string length',
	'must be a number',
	'must be a non-negative',
	'Slicing outside',
	'URI malformed',
	'Invalid character',
	'allocation failed',
	'is not iterable',
	'is not defined',
	'undefined is not',
	'null is not',
].join('|'));

const MAX_PACKETS = 1000;
const MAX_TRACKS = 8;

/**
 * Reads everything an app might read from a file, in a bounded way, with each step allowed to fail deliberately.
 * Returns the unintended errors and broken invariants found, as "<step>: <problem>" strings.
 */
export const walkInput = async (mb: typeof Mediabunny, bytes: Uint8Array, options: { unsized?: boolean } = {}) => {
	const problems: string[] = [];
	const step = async <T>(name: string, run: () => T | Promise<T>): Promise<T | null> => {
		try {
			return await run();
		} catch (error) {
			if (UNINTENDED_ERROR.test(String(error))) {
				problems.push(`${name}: ${String(error)}`);
			}
			return null;
		}
	};
	const check = (name: string, condition: boolean, problem: string) => {
		if (!condition) {
			problems.push(`${name}: ${problem}`);
		}
	};

	let source: Mediabunny.Source;
	if (options.unsized) {
		// Without a size, readers take the code paths for streamed files
		const third = Math.ceil(bytes.length / 3);
		source = new mb.ReadableStreamSource(new ReadableStream<Uint8Array>({
			start: (controller) => {
				for (let i = 0; i < bytes.length; i += third) {
					controller.enqueue(bytes.slice(i, i + third));
				}
				controller.close();
			},
		}));
	} else {
		source = new mb.BufferSource(bytes);
	}

	const input = new mb.Input({ source, formats: mb.ALL_FORMATS });
	try {
		await step('getFormat', () => input.getFormat());
		await step('getMimeType', () => input.getMimeType());
		await step('getMetadataTags', () => input.getMetadataTags());
		await step('computeDuration', () => input.computeDuration());
		await step('getDurationFromMetadata', () => input.getDurationFromMetadata());
		await step('getFirstTimestamp', () => input.getFirstTimestamp());

		const tracks = await step('getTracks', () => input.getTracks()) ?? [];
		for (const track of tracks.slice(0, MAX_TRACKS)) {
			await walkTrack(mb, track, step, check);
		}
	} finally {
		input.dispose();
	}

	return problems;
};

type Step = <T>(name: string, run: () => T | Promise<T>) => Promise<T | null>;
type Check = (name: string, condition: boolean, problem: string) => void;

const walkTrack = async (mb: typeof Mediabunny, track: Mediabunny.InputTrack, step: Step, check: Check) => {
	const name = `track ${track.id}`;
	await step(`${name} getCodec`, () => track.getCodec());
	await step(`${name} getCodecParameterString`, () => track.getCodecParameterString());
	await step(`${name} getLanguageCode`, () => track.getLanguageCode());
	await step(`${name} getName`, () => track.getName());
	await step(`${name} getTimeResolution`, () => track.getTimeResolution());
	await step(`${name} getDisposition`, () => track.getDisposition());
	await step(`${name} getBitrate`, () => track.getBitrate());
	await step(`${name} hasOnlyKeyPackets`, () => track.hasOnlyKeyPackets());
	await step(`${name} getFirstTimestamp`, () => track.getFirstTimestamp());
	await step(`${name} getDurationFromMetadata`, () => track.getDurationFromMetadata());

	if (track.isVideoTrack()) {
		await step(`${name} getDecoderConfig`, () => track.getDecoderConfig());
		await step(`${name} getDisplayWidth`, () => track.getDisplayWidth());
		await step(`${name} getDisplayHeight`, () => track.getDisplayHeight());
		await step(`${name} getRotation`, () => track.getRotation());
		await step(`${name} getColorSpace`, () => track.getColorSpace());
		await step(`${name} hasHighDynamicRange`, () => track.hasHighDynamicRange());
		await step(`${name} canBeTransparent`, () => track.canBeTransparent());
	} else if (track.isAudioTrack()) {
		await step(`${name} getDecoderConfig`, () => track.getDecoderConfig());
		await step(`${name} getNumberOfChannels`, () => track.getNumberOfChannels());
		await step(`${name} getSampleRate`, () => track.getSampleRate());
		await step(`${name} getPreRollDuration`, () => track.getPreRollDuration());
	}

	// Iterate packets, checking what any reader must guarantee
	const sink = new mb.EncodedPacketSink(track);
	const packets: Mediabunny.EncodedPacket[] = [];
	let packet = await step(`${name} getFirstPacket`, () => sink.getFirstPacket());
	while (packet && packets.length < MAX_PACKETS) {
		check(`${name} packet ${packets.length}`, Number.isFinite(packet.timestamp), `timestamp ${packet.timestamp}`);
		check(
			`${name} packet ${packets.length}`,
			Number.isFinite(packet.duration) && packet.duration >= 0,
			`duration ${packet.duration}`,
		);
		const previous = packets[packets.length - 1];
		if (previous && previous.sequenceNumber >= 0 && packet.sequenceNumber >= 0) {
			check(
				`${name} packet ${packets.length}`,
				packet.sequenceNumber > previous.sequenceNumber,
				`sequence number ${packet.sequenceNumber} after ${previous.sequenceNumber}`,
			);
		}

		packets.push(packet);
		const current = packet;
		packet = await step(`${name} getNextPacket`, () => sink.getNextPacket(current));
	}

	await step(`${name} computeDuration`, () => track.computeDuration());
	await step(`${name} computePacketStats`, () => track.computePacketStats(100));

	// Look packets up around the iterated ones; a lookup returns the last packet at or before the timestamp
	const timestamps = [-1, 0, Infinity];
	for (const index of [0, Math.floor(packets.length / 2), packets.length - 1]) {
		const found = packets[index];
		if (found) {
			timestamps.push(found.timestamp, found.timestamp + found.duration);
		}
	}
	for (const timestamp of timestamps) {
		// Lookups round to the track's time base, so allow for floating-point error
		const limit = timestamp + Math.max(1e-9, Math.abs(timestamp) * 1e-12);

		const found = await step(`${name} getPacket(${timestamp})`, () => sink.getPacket(timestamp));
		if (found) {
			check(`${name} getPacket(${timestamp})`, found.timestamp <= limit, `returned ${found.timestamp}`);
		}

		const key = await step(
			`${name} getKeyPacket(${timestamp})`,
			() => sink.getKeyPacket(timestamp, { verifyKeyPackets: true }),
		);
		if (key) {
			check(`${name} getKeyPacket(${timestamp})`, key.timestamp <= limit, `returned ${key.timestamp}`);
		}
	}

	const first = packets[0];
	if (first) {
		await step(`${name} getNextKeyPacket`, () => sink.getNextKeyPacket(first, { verifyKeyPackets: true }));
	}

	// The queueing iterator, starting in the middle
	const middle = packets[Math.floor(packets.length / 2)];
	await step(`${name} packets()`, async () => {
		let count = 0;
		for await (const iterated of sink.packets(middle, undefined, { metadataOnly: true })) {
			void iterated;
			if (++count >= 300) {
				break;
			}
		}
	});

	// PCM decodes without WebCodecs, so the audio sample path runs here too
	const codec = await step(`${name} getCodec`, () => track.getCodec());
	if (track.isAudioTrack() && codec && (mb.PCM_AUDIO_CODECS as readonly string[]).includes(codec)) {
		await step(`${name} decode`, async () => {
			let count = 0;
			for await (const sample of new mb.AudioSampleSink(track).samples()) {
				check(`${name} decode`, Number.isInteger(sample.numberOfFrames), `${sample.numberOfFrames} frames`);
				sample.close();
				if (++count >= 50) {
					break;
				}
			}
		});
	}
};
