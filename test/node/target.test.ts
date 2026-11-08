import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const samplePath = path.join(__dirname, '../public/video.mp4');

test.each(['MP4', 'Matroska', 'MPEG-TS', 'CMAF'] as const)(
	'Canceling an output whose target callback is still pending at start (%s)',
	async (formatName) => {
		// The callback may never settle (an upload URL request without a timeout, a file picker left open), and a
		// cancel mustn't wait for it
		const { CmafOutputFormat, MkvOutputFormat, MpegTsOutputFormat } = await import('../../src/output-format.js');
		const { PathedTarget, StreamTarget } = await import('../../src/target.js');
		const { EncodedVideoPacketSource } = await import('../../src/media-source.js');
		type StreamTargetChunk = import('../../src/target.js').StreamTargetChunk;
		const createFormat = () => formatName === 'MP4'
			? new Mp4OutputFormat()
			: formatName === 'Matroska'
				? new MkvOutputFormat()
				: formatName === 'MPEG-TS'
					? new MpegTsOutputFormat()
					: new CmafOutputFormat();
		const usesInitTarget = formatName === 'CMAF';

		for (const settlesLate of [false, true]) {
			let resolveTarget: ((target: BufferTarget | InstanceType<typeof StreamTarget>) => void) | null = null;
			const getTarget = () => new Promise<BufferTarget | InstanceType<typeof StreamTarget>>((resolve) => {
				resolveTarget = resolve;
			});
			const output = new Output({
				format: createFormat(),
				target: usesInitTarget
					? new PathedTarget('stream.mp4', () => new BufferTarget())
					: new PathedTarget('file', getTarget),
				initTarget: usesInitTarget ? getTarget : undefined,
			});
			output.addVideoTrack(new EncodedVideoPacketSource('avc'));

			const start = output.start();
			const startResult = start.then(() => 'started', (error: Error) => error.message);
			await new Promise(resolve => setTimeout(resolve, 50));
			expect(resolveTarget).not.toBeNull(); // The start waits for the target

			const cancelResult = await Promise.race([
				output.cancel().then(() => 'canceled'),
				new Promise(resolve => setTimeout(() => resolve('pending'), 2000)),
			]);
			expect(cancelResult).toBe('canceled');
			expect(await startResult).toBe('started'); // As when the cancel comes after the start
			expect(output.state).toBe('canceled');

			if (settlesLate) {
				// A target that still arrives gets closed, and nothing gets written into it
				const writes: number[] = [];
				const writable = new WritableStream<StreamTargetChunk>({
					write: chunk => void writes.push(chunk.data.byteLength),
				});
				const lateTarget = new StreamTarget(writable);
				let closed = false;
				const close = lateTarget._close.bind(lateTarget);
				lateTarget._close = async () => {
					closed = true;
					await close();
				};
				resolveTarget!(lateTarget);
				await new Promise(resolve => setTimeout(resolve, 50));
				expect(closed).toBe(true);
				expect(writes).toEqual([]);
				expect(writable.locked).toBe(false); // The caller's stream stays theirs
			}
		}
	},
);

test.each(['synchronous', 'never settling'] as const)(
	'Canceling right after an unawaited start() rejects nothing (%s target)',
	async (targetKind) => {
		const { PathedTarget } = await import('../../src/target.js');
		const { EncodedVideoPacketSource } = await import('../../src/media-source.js');
		const { EncodedPacket } = await import('../../src/packet.js');
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => void unhandledRejections.push(reason);
		process.on('unhandledRejection', onUnhandledRejection);

		try {
			const output = new Output({
				format: new Mp4OutputFormat(),
				target: targetKind === 'synchronous'
					? new BufferTarget()
					: new PathedTarget('file.mp4', () => new Promise<BufferTarget>(() => {})),
			});
			const source = new EncodedVideoPacketSource('avc');
			output.addVideoTrack(source);

			void output.start();
			await output.cancel();
			await new Promise(resolve => setTimeout(resolve, 50));

			expect(unhandledRejections).toEqual([]);
			expect(output.state).toBe('canceled');
			// As on main after a cancel
			await expect((async () => source.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 1)))())
				.rejects.toThrow('Output has been canceled.');
		} finally {
			process.off('unhandledRejection', onUnhandledRejection);
		}
	},
);

test.each([
	['MP4', null],
	['Matroska', null],
	['MPEG-TS', null],
	['WAVE', 'glitch-hop-is-dead.wav'],
	['ADTS', 'sample3.aac'],
	['Ogg', 'preroll-test.opus'],
	['FLAC', 'sample.flac'],
	['MP3', 'Toothsome-Meme.VBRv2.mp3'],
] as const)(
	'An add issued while the start is still running settles when the start is canceled or its target fails (%s)',
	async (formatName, audioFile) => {
		// The muxer holds its mutex while it waits for its target at start, and adds wait for that mutex
		const formats = await import('../../src/output-format.js');
		const { PathedTarget } = await import('../../src/target.js');
		const { EncodedAudioPacketSource, EncodedVideoPacketSource } = await import('../../src/media-source.js');
		const { EncodedPacketSink } = await import('../../src/media-sink.js');
		const { EncodedPacket } = await import('../../src/packet.js');
		const createFormat = {
			'MP4': () => new formats.Mp4OutputFormat(),
			'Matroska': () => new formats.MkvOutputFormat(),
			'MPEG-TS': () => new formats.MpegTsOutputFormat(),
			'WAVE': () => new formats.WavOutputFormat(),
			'ADTS': () => new formats.AdtsOutputFormat(),
			'Ogg': () => new formats.OggOutputFormat(),
			'FLAC': () => new formats.FlacOutputFormat(),
			'MP3': () => new formats.Mp3OutputFormat(),
		}[formatName];

		// A video track gets an AVC packet, an audio track the first packet of a file in a codec the format holds
		let addTrack: (output: Output) => () => Promise<void>;
		if (audioFile === null) {
			addTrack = (output) => {
				const source = new EncodedVideoPacketSource('avc');
				output.addVideoTrack(source);
				return () => source.add(new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x65]), 'key', 0, 1 / 30), {
					decoderConfig: {
						codec: 'avc1.42001f',
						codedWidth: 64,
						codedHeight: 64,
						description: new Uint8Array([0x01, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x00, 0x01, 0x00, 0x00]),
					},
				});
			};
		} else {
			using input = new Input({
				source: new FilePathSource(path.join(__dirname, '../public', audioFile)),
				formats: ALL_FORMATS,
			});
			const track = (await input.getPrimaryAudioTrack())!;
			const codec = (await track.getCodec())!;
			const decoderConfig = (await track.getDecoderConfig())!;
			const packet = (await new EncodedPacketSink(track).getFirstPacket())!;
			addTrack = (output) => {
				const source = new EncodedAudioPacketSource(codec);
				output.addAudioTrack(source);
				return () => source.add(packet, { decoderConfig });
			};
		}

		const settlesWithin = (promise: Promise<unknown>, ms: number) => Promise.race([
			promise.then(() => 'resolved', () => 'rejected'),
			new Promise(resolve => setTimeout(() => resolve('pending'), ms)),
		]);

		const scenarios = ['canceled same tick', 'canceled while the target is pending', 'target fails'] as const;
		for (const scenario of scenarios) {
			const output = new Output({
				format: createFormat(),
				target: scenario === 'canceled same tick'
					? new BufferTarget()
					: new PathedTarget('file', () => new Promise<BufferTarget>((_, reject) => {
						if (scenario === 'target fails') {
							setTimeout(() => reject(new Error('No target')), 20);
						}
					})),
			});
			const addPacket = addTrack(output);

			const start = output.start();
			const add = addPacket();

			if (scenario === 'target fails') {
				await expect(start).rejects.toThrow('No target');
				expect(await settlesWithin(add, 1000), scenario).not.toBe('pending');
				expect(await settlesWithin(output.finalize(), 1000), scenario).toBe('rejected');
				continue;
			}

			if (scenario === 'canceled while the target is pending') {
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			const cancel = output.cancel();
			expect(await settlesWithin(add, 1000), scenario).toBe('resolved'); // As when the start had finished
			expect(await settlesWithin(start, 1000), scenario).toBe('resolved');
			expect(await settlesWithin(cancel, 1000), scenario).toBe('resolved');
		}
	},
);

test('BufferTarget onFinalize callback', async () => {
	let received: ArrayBuffer | null = null;
	let asyncCallbackDone = false;

	using input = new Input({
		source: new FilePathSource(samplePath),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget({
			onFinalize: async (buffer) => {
				received = buffer;
				await new Promise(resolve => setTimeout(resolve, 20));
				asyncCallbackDone = true;
			},
		}),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	expect(received).not.toBeNull();
	expect(received).toBe(output.target.buffer);
	expect(asyncCallbackDone).toBe(true);
	expect(output.target.buffer!.byteLength).toBeGreaterThan(0);
});

test('BufferTarget internal buffer transfer on finalize', async () => {
	const target = new BufferTarget();
	target._write(new Uint8Array([1, 2, 3, 4, 5]), 0);
	target._write(new Uint8Array([6, 7]), 3);

	const internalBuffer = target._buffer!;
	await target._finalize();

	expect(internalBuffer).toHaveProperty('detached', true);
	expect(target._buffer).toBeNull();
	expect(target._bytes).toBeNull();

	expect(target.buffer).toHaveProperty('resizable', false);
	expect([...new Uint8Array(target.buffer!)]).toEqual([1, 2, 3, 6, 7]);
});
