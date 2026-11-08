import { createHook } from 'node:async_hooks';
import { expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { EncodedPacket } from '../../src/packet.js';
import { BufferSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

/** Matroska with many tiny PCM packets, which decode without WebCodecs. */
const createManyPacketFile = async (packetCount: number) => {
	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);
	await output.start();
	for (let i = 0; i < packetCount; i++) {
		await source.add(
			new EncodedPacket(new Uint8Array(4), 'key', i / 1000, 1 / 1000),
			i === 0 ? { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 2000 } } : undefined,
		);
	}
	await output.finalize();

	return output.target.buffer!;
};

/** Tracks the promises created from now on that are still pending. */
const trackPendingPromises = () => {
	const pending = new Set<number>();
	const hook = createHook({
		init: (asyncId, type) => {
			if (type === 'PROMISE') {
				pending.add(asyncId);
			}
		},
		promiseResolve: (asyncId) => {
			pending.delete(asyncId);
		},
	});
	hook.enable();

	return {
		stop: () => {
			hook.disable();
			return pending.size;
		},
	};
};

test.for(['samples()', 'samplesAtTimestamps()'] as const)(
	'%s keeps nothing pending per sample while it iterates',
	async (method) => {
		// Each packet wait was raced against a promise that only settles when the iteration ends, which left one
		// pending promise (with its closures) per wait, about a kilobyte per sample (found by the lane L94 review)
		using input = new Input({ source: new BufferSource(await createManyPacketFile(3000)), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		expect(track).not.toBe(null);

		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			timestamps.push(packet.timestamp);
		}

		const sink = new AudioSampleSink(track!);
		const iterator = method === 'samples()' ? sink.samples() : sink.samplesAtTimestamps(timestamps);
		let count = 0;
		let tracker: ReturnType<typeof trackPendingPromises> | null = null;
		let pendingCount = -1;
		for await (const sample of iterator) {
			sample?.close();
			count++;
			if (count === 500) {
				tracker = trackPendingPromises();
			} else if (count === 2500) {
				pendingCount = tracker!.stop(); // Before the iteration ends, which settles what it waits on
				break;
			}
		}

		expect(count).toBe(2500);
		// A few reads are in flight at any time; 2000 samples left 2000 or more pending
		expect(pendingCount).toBeGreaterThanOrEqual(0);
		expect(pendingCount).toBeLessThan(50);
	},
);
