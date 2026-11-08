import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { expect, test } from 'vitest';
import {
	ALL_FORMATS,
	AttachedFile,
	BlobSource,
	AudioSample,
	AudioSampleResource,
	AudioSampleSource,
	BufferSource,
	BufferTarget,
	CustomSource,
	EncodedPacket,
	Input,
	MkvOutputFormat,
	Output,
	RichImageData,
	VideoSample,
	VideoSampleColorSpace,
	VideoSampleResource,
} from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// A separate realm, like an iframe, a Node.js vm context or Jest's jsdom environment: its Uint8Arrays and ArrayBuffers
// are genuine, but instances of its own classes, not of this realm's
const otherRealm = vm.runInNewContext('({ Uint8Array, ArrayBuffer })') as {
	Uint8Array: Uint8ArrayConstructor;
	ArrayBuffer: ArrayBufferConstructor;
};
const otherRealmBytes = (bytes: ArrayLike<number>) => new otherRealm.Uint8Array(bytes);
const otherRealmArrayBuffer = (bytes: Uint8Array) => {
	const buffer = new otherRealm.ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
};

test('Packets and samples take bytes created in another realm', async () => {
	const data = otherRealmBytes([1, 2, 3, 4]);
	expect(data instanceof Uint8Array).toBe(false);
	expect(otherRealmArrayBuffer(new Uint8Array(1)) instanceof ArrayBuffer).toBe(false);

	// Objects that merely claim to be bytes are still rejected
	const fakeBytes = { [Symbol.toStringTag]: 'Uint8Array', length: 1, 0: 1 } as unknown as Uint8Array;
	expect(() => new EncodedPacket(fakeBytes, 'key', 0, 1)).toThrow(TypeError);
	const taggedView = new DataView(new ArrayBuffer(4));
	Object.defineProperty(taggedView, Symbol.toStringTag, { value: 'Uint8Array' });
	expect(() => new EncodedPacket(taggedView as unknown as Uint8Array, 'key', 0, 1)).toThrow(TypeError);
	expect(() => new RichImageData(taggedView as unknown as Uint8Array, 'image/png')).toThrow(TypeError);
	const fakeBuffer = { [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 8 } as unknown as ArrayBuffer;
	expect(() => new BufferSource(fakeBuffer)).toThrow(TypeError);

	const packet = new EncodedPacket(data, 'key', 0, 1, -1, undefined, { alpha: otherRealmBytes([9]) });
	expect(packet.data).toBeInstanceOf(Uint8Array);
	expect([...packet.data]).toEqual([1, 2, 3, 4]);
	data[0] = 5;
	expect(packet.data[0]).toBe(5); // The same memory, as with a Uint8Array of this realm
	expect(packet.sideData.alpha).toBeInstanceOf(Uint8Array);
	expect([...packet.sideData.alpha!]).toEqual([9]);
	expect([...packet.clone({ data: otherRealmBytes([6]) }).data]).toEqual([6]);

	const pcm = new Uint8Array(new Float32Array([0.25, -0.5]).buffer);
	using audioSample = new AudioSample({
		data: otherRealmArrayBuffer(pcm),
		format: 'f32',
		numberOfChannels: 1,
		sampleRate: 48000,
		timestamp: 0,
	});
	const audioCopy = new Float32Array(2);
	audioSample.copyTo(audioCopy, { planeIndex: 0 });
	expect([...audioCopy]).toEqual([0.25, -0.5]);

	const rgba = new Uint8Array(16).map((_, i) => i);
	using videoSample = new VideoSample(otherRealmArrayBuffer(rgba), {
		format: 'RGBA',
		codedWidth: 2,
		codedHeight: 2,
		timestamp: 0,
	});
	const videoCopy = new Uint8Array(16);
	await videoSample.copyTo(videoCopy);
	expect(videoCopy).toEqual(rgba);

	// Custom sample resources whose planes come from another realm
	class OtherRealmAudioResource extends AudioSampleResource {
		getFormat() {
			return 'f32' as const;
		}

		getSampleRate() {
			return 48000;
		}

		getNumberOfFrames() {
			return 2;
		}

		getNumberOfChannels() {
			return 1;
		}

		getTimestamp() {
			return 0;
		}

		close() {}

		getDataPlane() {
			return otherRealmBytes(pcm);
		}
	}

	using resourceAudioSample = new AudioSample(new OtherRealmAudioResource());
	const resourceAudioCopy = new Float32Array(2);
	resourceAudioSample.copyTo(resourceAudioCopy, { planeIndex: 0 });
	expect([...resourceAudioCopy]).toEqual([0.25, -0.5]);

	class OtherRealmVideoResource extends VideoSampleResource {
		getFormat() {
			return 'RGBA' as const;
		}

		getCodedWidth() {
			return 2;
		}

		getCodedHeight() {
			return 2;
		}

		getSquarePixelWidth() {
			return 2;
		}

		getSquarePixelHeight() {
			return 2;
		}

		getColorSpace() {
			return new VideoSampleColorSpace();
		}

		close() {}

		getDataPlanes() {
			return [{ data: otherRealmBytes(rgba), stride: 8 }];
		}

		toRgbSample(): VideoSample {
			throw new Error('Not needed here.');
		}
	}

	using resourceVideoSample = new VideoSample(new OtherRealmVideoResource(), { timestamp: 0 });
	const resourceVideoCopy = new Uint8Array(16);
	await resourceVideoSample.copyTo(resourceVideoCopy);
	expect(resourceVideoCopy).toEqual(rgba);
});

test('Sources take bytes created in another realm', async () => {
	const file = new Uint8Array(readFileSync(path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav')));
	using control = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const duration = await control.computeDuration();
	expect(duration).toBeGreaterThan(0);

	using fromArrayBuffer = new Input({ source: new BufferSource(otherRealmArrayBuffer(file)), formats: ALL_FORMATS });
	expect(await fromArrayBuffer.computeDuration()).toBe(duration);

	using fromReadResults = new Input({
		source: new CustomSource({
			getSize: () => file.byteLength,
			read: (start, end) => otherRealmBytes(file.subarray(start, end)),
		}),
		formats: ALL_FORMATS,
	});
	expect(await fromReadResults.computeDuration()).toBe(duration);

	using fromReadStreams = new Input({
		source: new CustomSource({
			getSize: () => file.byteLength,
			read: (start, end) => new ReadableStream<Uint8Array>({
				start: (controller) => {
					controller.enqueue(otherRealmBytes(file.subarray(start, end)));
					controller.close();
				},
			}),
		}),
		formats: ALL_FORMATS,
	});
	expect(await fromReadStreams.computeDuration()).toBe(duration);

	// A Blob of another implementation, like Node.js's Blob in Jest's jsdom environment, which this realm's Blob
	// methods don't recognize
	const blob = new Blob([file]);
	const otherImplementationBlob = {
		[Symbol.toStringTag]: 'Blob',
		size: blob.size,
		type: blob.type,
		slice: (start?: number, end?: number) => blob.slice(start, end),
		arrayBuffer: () => blob.arrayBuffer(),
		stream: () => blob.stream(),
	} as unknown as Blob;
	using fromBlob = new Input({ source: new BlobSource(otherImplementationBlob), formats: ALL_FORMATS });
	expect(await fromBlob.computeDuration()).toBe(duration);
});

test('Metadata takes bytes created in another realm, and they get written', async () => {
	const imageData = otherRealmBytes([0x89, 0x50, 0x4e, 0x47]);
	expect(new RichImageData(imageData, 'image/png').data).toBeInstanceOf(Uint8Array);
	expect(new AttachedFile(imageData, 'image/png').data).toBeInstanceOf(Uint8Array);

	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new AudioSampleSource({ codec: 'pcm-s16' });
	output.addAudioTrack(source);
	output.setMetadataTags({
		images: [{ data: imageData, mimeType: 'image/png', kind: 'coverFront' }],
		raw: { BINARY: otherRealmBytes([1, 2, 3]) },
	});
	await output.start();
	using sample = new AudioSample({
		data: new Int16Array(480),
		format: 's16',
		numberOfChannels: 1,
		sampleRate: 48000,
		timestamp: 0,
	});
	await source.add(sample);
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const tags = await input.getMetadataTags();
	expect([...tags.images![0]!.data]).toEqual([0x89, 0x50, 0x4e, 0x47]);
	expect([...(tags.raw!['BINARY'] as Uint8Array)]).toEqual([1, 2, 3]);
});
