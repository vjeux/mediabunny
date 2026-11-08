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
			expect(await startResult).toBe('Output has been canceled.');

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
