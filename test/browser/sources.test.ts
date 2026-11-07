import { expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { EncodedPacket } from '../../src/packet.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { VideoSample } from '../../src/sample.js';
import { BufferTarget } from '../../src/target.js';

// Shared WebAssembly memory is backed by a SharedArrayBuffer, even without cross-origin isolation (where
// SharedArrayBuffer isn't a global). WebAssembly pipelines often hand out views into such memory.
const copyIntoMemory = (bytes: Uint8Array, shared: boolean) => {
	const pages = Math.ceil(bytes.length / 65536);
	const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared });
	const view = new Uint8Array(memory.buffer, 0, bytes.length);
	view.set(bytes);
	return view;
};

for (const file of ['video.mp4', 'frames.webm']) {
	for (const shared of [false, true]) {
		test(`BufferSource reads ${file} from ${shared ? 'shared' : 'unshared'} WebAssembly memory`, async () => {
			const bytes = new Uint8Array(await (await fetch(`/${file}`)).arrayBuffer());
			using input = new Input({ source: new BufferSource(copyIntoMemory(bytes, shared)), formats: ALL_FORMATS });
			const track = await input.getPrimaryVideoTrack();
			expect(await track?.getCodecParameterString()).toMatch(/^(avc1|vp09)\./);
		});
	}
}

test('BufferSource accepts the SharedArrayBuffer of shared WebAssembly memory', async () => {
	const bytes = new Uint8Array(await (await fetch('/video.mp4')).arrayBuffer());
	const memory = new WebAssembly.Memory({ initial: Math.ceil(bytes.length / 65536), maximum: 1000, shared: true });
	new Uint8Array(memory.buffer).set(bytes);

	using input = new Input({ source: new BufferSource(memory.buffer), formats: ALL_FORMATS });
	expect((await input.getFormat()).name).toBe('MP4');
});

test('Objects merely tagged "SharedArrayBuffer" are still rejected as buffers', async () => {
	// Not a buffer at all: a plain object whose Symbol.toStringTag claims to be a SharedArrayBuffer
	const fake = () => ({ [Symbol.toStringTag]: 'SharedArrayBuffer' }) as unknown as AllowSharedBufferSource;

	expect(() => new BufferSource(fake())).toThrow(/buffer must be an ArrayBuffer/);

	using sample = new VideoSample(new Uint8Array(64), { format: 'RGBA', codedWidth: 4, codedHeight: 4, timestamp: 0 });
	await expect(sample.copyTo(fake())).rejects.toThrow(/destination must be/);

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	await expect(source.add(new EncodedPacket(new Uint8Array(10), 'key', 0, 1), {
		decoderConfig: { codec: 'avc1.42001f', codedWidth: 16, codedHeight: 16, description: fake() },
	})).rejects.toThrow(/description/);
	await output.cancel();
});
