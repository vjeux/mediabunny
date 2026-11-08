import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

test.each(['MP4', 'Matroska', 'MPEG-TS', 'CMAF'] as const)(
	'Canceling an output whose target callback is still pending at start (%s)',
	async (formatName) => {
		// The callback may never settle (an upload URL request without a timeout, a file picker left open), and a
		// cancel mustn't wait for it
		const { CmafOutputFormat, Mp4OutputFormat, MpegTsOutputFormat } = await import('../../src/output-format.js');
		const { PathedTarget, StreamTarget } = await import('../../src/target.js');
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
		const { Mp4OutputFormat } = await import('../../src/output-format.js');
		const { PathedTarget } = await import('../../src/target.js');
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

test.each(['MP4', 'Matroska', 'MPEG-TS'] as const)(
	'An add issued while the start is still running settles when the start is canceled or its target fails (%s)',
	async (formatName) => {
		// The muxer holds its mutex while it waits for its target at start, and adds wait for that mutex
		const { Mp4OutputFormat, MpegTsOutputFormat } = await import('../../src/output-format.js');
		const { PathedTarget } = await import('../../src/target.js');
		const createFormat = () => formatName === 'MP4'
			? new Mp4OutputFormat()
			: formatName === 'Matroska'
				? new MkvOutputFormat()
				: new MpegTsOutputFormat();
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
			const source = new EncodedVideoPacketSource('avc');
			output.addVideoTrack(source);

			const start = output.start();
			const add = source.add(new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x65]), 'key', 0, 1 / 30), {
				decoderConfig: {
					codec: 'avc1.42001f',
					codedWidth: 64,
					codedHeight: 64,
					description: new Uint8Array([0x01, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x00, 0x01, 0x00, 0x00]),
				},
			});

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

test('Output, onFinalize', async () => {
	let callCount = 0;
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
		onFinalize: async () => {
			await new Promise(resolve => setTimeout(resolve, 200));

			callCount++;
		},
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.5), {
		decoderConfig: {
			codec: 'avc1.640028',
			codedWidth: 1920,
			codedHeight: 1080,
		},
	});

	await output.finalize();

	expect(callCount).toBe(1);
});
