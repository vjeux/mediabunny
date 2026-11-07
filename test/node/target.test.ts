import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget, Target } from '../../src/target.js';
import { CmafOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Conversion } from '../../src/conversion.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const samplePath = path.join(__dirname, '../public/video.mp4');

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

test.each(['a target', 'a function'])('Output emits a target event for the CMAF init target, given as %s', async (
	kind,
) => {
	const initTarget = new BufferTarget();
	const output = new Output({
		format: new CmafOutputFormat(),
		target: new BufferTarget(),
		initTarget: kind === 'a target' ? initTarget : () => initTarget,
	});

	const events: { target: Target; isRoot: boolean }[] = [];
	output.on('target', ({ target, isRoot }) => events.push({ target, isRoot }));

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();
	const description = new Uint8Array([0x11, 0x88]);
	await source.add(new EncodedPacket(new Uint8Array(10), 'key', 0, 0.02), {
		decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 1, sampleRate: 48000, description },
	});
	await output.finalize();

	expect(initTarget.buffer).not.toBeNull(); // The init segment was written to it
	expect(events.filter(x => x.target === initTarget)).toEqual([{ target: initTarget, isRoot: false }]);
});
