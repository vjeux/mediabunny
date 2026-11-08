import { expect, test } from 'vitest';
import { ALL_FORMATS, BlobSource, CustomSource, Input, ReadableStreamSource } from '../../src/index.js';

test('Blobs and streams created in another realm (an iframe) are taken as sources', async () => {
	const bytes = new Uint8Array(await (await fetch('/glitch-hop-is-dead.wav')).arrayBuffer());
	using control = new Input({ source: new BlobSource(new Blob([bytes])), formats: ALL_FORMATS });
	const duration = await control.computeDuration();
	expect(duration).toBeGreaterThan(0);

	// Objects that merely claim to be a Blob or a stream are still rejected
	expect(() => new BlobSource({ [Symbol.toStringTag]: 'Blob', size: 3 } as unknown as Blob)).toThrow(TypeError);
	expect(() => new ReadableStreamSource({} as ReadableStream<Uint8Array>)).toThrow(TypeError);

	const iframe = document.createElement('iframe');
	document.body.append(iframe);
	try {
		const otherRealm = iframe.contentWindow as unknown as {
			Blob: typeof Blob;
			ReadableStream: typeof ReadableStream;
		};

		const blob = new otherRealm.Blob([bytes]);
		expect(blob instanceof Blob).toBe(false); // A genuine Blob, but not of this realm's class
		using fromBlob = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
		expect(await fromBlob.computeDuration()).toBe(duration);

		const stream = new otherRealm.ReadableStream<Uint8Array>({
			start: (controller) => {
				controller.enqueue(bytes);
				controller.close();
			},
		});
		expect(stream instanceof ReadableStream).toBe(false);
		using fromStream = new Input({ source: new ReadableStreamSource(stream), formats: ALL_FORMATS });
		expect(await fromStream.computeDuration()).toBe(duration);

		using fromReadStreams = new Input({
			source: new CustomSource({
				getSize: () => bytes.byteLength,
				read: (start, end) => new otherRealm.ReadableStream<Uint8Array>({
					start: (controller) => {
						controller.enqueue(bytes.subarray(start, end));
						controller.close();
					},
				}),
			}),
			formats: ALL_FORMATS,
		});
		expect(await fromReadStreams.computeDuration()).toBe(duration);
	} finally {
		iframe.remove();
	}
});
