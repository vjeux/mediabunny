import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

import { StreamTarget } from '../../src/index.js';

test('Output.cancel() resolves even when the sink of its StreamTarget has stalled', async () => {
	for (const stalled of [false, true]) {
		let writes = 0;
		let closed = false;
		const target = new StreamTarget(new WritableStream({
			write: () => {
				writes++;
				// A stalled sink never completes a write, like an upload over a hung connection
				return stalled ? new Promise<void>(() => {}) : undefined;
			},
			close: () => {
				closed = true;
			},
		}));
		const output = new Output({ format: new MkvOutputFormat(), target });
		const source = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(source);
		await output.start();

		const decoderConfig = { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 };
		for (let i = 0; writes === 0 && i < 500; i++) {
			void source.add(new EncodedPacket(new Uint8Array(1000), 'key', i * 0.02, 0.02), { decoderConfig });
			await new Promise(resolve => setTimeout(resolve, 1));
		}
		expect(writes).toBeGreaterThan(0);

		const result = await Promise.race([
			output.cancel().then(() => 'canceled'),
			new Promise(resolve => setTimeout(() => resolve('still pending'), 500)),
		]);
		expect(result, stalled ? 'stalled sink' : 'working sink').toBe('canceled');
		expect(output.state).toBe('canceled');

		if (!stalled) {
			// The stream still gets closed once its queued writes are done, as documented
			for (let i = 0; !closed && i < 100; i++) {
				await new Promise(resolve => setTimeout(resolve, 5));
			}
			expect(closed).toBe(true);
		}
	}
});

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
