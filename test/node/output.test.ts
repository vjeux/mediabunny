import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

import { StreamTarget } from '../../src/index.js';

test('Output.cancel() waits for the stream of its StreamTarget to close, unless the sink has stalled', async () => {
	for (const sink of ['instant', 'slow', 'stalled'] as const) {
		let writes = 0;
		const events: string[] = [];
		const target = new StreamTarget(new WritableStream({
			write: () => {
				writes++;
				if (sink === 'slow') {
					return new Promise<void>(resolve => setTimeout(resolve, 5));
				}
				if (sink === 'stalled') {
					// Never completes, like an upload over a hung connection
					return new Promise<void>(() => {});
				}
			},
			close: () => {
				// E.g. a FileSystemWritableFileStream, whose close() commits the file
				events.push('stream closed');
			},
		}));
		const output = new Output({ format: new MkvOutputFormat(), target });
		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source);
		await output.start();

		const decoderConfig = { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 };
		if (sink === 'stalled') {
			// Adding waits for the sink once it applies backpressure, so don't wait for that here
			for (let i = 0; writes === 0 && i < 500; i++) {
				void source.add(new EncodedPacket(new Uint8Array(1000), 'key', i * 0.02, 0.02), { decoderConfig });
				await new Promise(resolve => setTimeout(resolve, 1));
			}
		} else {
			for (let i = 0; i < 20; i++) {
				await source.add(new EncodedPacket(new Uint8Array(1000), 'key', i * 0.02, 0.02), { decoderConfig });
			}
		}
		expect(writes).toBeGreaterThan(0);

		const result = await Promise.race([
			output.cancel().then(() => {
				events.push('cancel resolved');
				return 'canceled';
			}),
			new Promise(resolve => setTimeout(() => resolve('still pending'), 10_000)),
		]);
		expect(result, sink).toBe('canceled');
		expect(output.state).toBe('canceled');
		expect(events, sink).toEqual(sink === 'stalled' ? ['cancel resolved'] : ['stream closed', 'cancel resolved']);
	}
}, 30_000);

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
