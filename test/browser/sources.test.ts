import { expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';

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
