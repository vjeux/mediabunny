import { expect, test } from 'vitest';
import { EventEmitter } from '../../src/misc.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { EncodedPacket } from '../../src/packet.js';
import { BufferTarget } from '../../src/target.js';

test('A once listener that re-registers itself is called once per event', async () => {
	const target = new BufferTarget();
	const output = new Output({ format: new MkvOutputFormat(), target });
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	let writes = 0;
	target.on('write', () => writes++);

	let calls = 0;
	const onWrite = () => {
		calls++;
		// The cap keeps a broken emit from looping forever
		if (calls < 1000) {
			target.on('write', onWrite, { once: true }); // Listen to the next write only
		}
	};
	target.on('write', onWrite, { once: true });

	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(50), 'key', 0, 0.04), {
		decoderConfig: { codec: 'vp8', codedWidth: 64, codedHeight: 64 },
	});
	await output.finalize();

	expect(writes).toBeGreaterThan(0);
	expect(calls).toBe(writes);
});

test('EventEmitter once listener re-registered during emit', () => {
	const emitter = new EventEmitter<{ foo: number }>();
	const received: number[] = [];

	// The cap keeps a broken emit from looping forever
	const listen = () => {
		emitter.on('foo', (value) => {
			received.push(value);
			if (received.length < 10) {
				listen();
			}
		}, { once: true });
	};
	listen();

	emitter._emit('foo', 1);
	emitter._emit('foo', 2);
	expect(received).toEqual([1, 2]);
});

test('EventEmitter once listener with re-entrant emit', () => {
	const emitter = new EventEmitter<{ foo: void }>();
	let calls = 0;

	emitter.on('foo', () => {
		calls++;
		if (calls < 10) {
			emitter._emit('foo');
		}
	}, { once: true });

	emitter._emit('foo');
	expect(calls).toBe(1);
});

test('EventEmitter listener removed during emit', () => {
	const emitter = new EventEmitter<{ foo: void }>();
	let calls = 0;

	emitter.on('foo', () => removeSecond());
	const removeSecond = emitter.on('foo', () => calls++);

	emitter._emit('foo');
	expect(calls).toBe(0);
});
