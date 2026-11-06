import { expect, test, describe } from 'vitest';
import {
	ALL_FORMATS,
	AUDIO_CODECS,
	AudioBufferSink,
	AudioBufferSource,
	AudioSample,
	BufferTarget,
	CanvasSink,
	CanvasSource,
	EncodedPacket,
	Input,
	MediaStreamAudioTrackSource,
	MediaStreamVideoTrackSource,
	Output,
	Quality,
	SUBTITLE_CODECS,
	UrlSource,
	VIDEO_CODECS,
	VideoSample,
	VideoSampleSource,
	WebMOutputFormat,
	canDecode,
	canEncode,
	getDecodableCodecs,
	getEncodableCodecs,
	getFirstEncodableAudioCodec,
	getFirstEncodableVideoCodec,
} from '../../src/index.js';

// The browser-only part of the API surface (WebCodecs, canvases, Web Audio, MediaStream). The node suite in
// test/node/api-validation.test.ts covers everything that runs without them.

const expectTypeError = async (call: () => unknown, mention: string) => {
	let error: unknown = null;
	try {
		await call();
	} catch (e) {
		error = e;
	}
	expect(error).toBeInstanceOf(TypeError);
	expect((error as Error).message).toContain(mention);
	expect((error as Error).message).not.toMatch(/Cannot read prop|is not a function|is not defined/);
};

const quality = new Quality('medium');

describe('Browser-only constructors and methods', () => {
	test('CanvasSource validates add() timing', async () => {
		const canvas = new OffscreenCanvas(64, 64);
		canvas.getContext('2d')!.fillRect(0, 0, 64, 64);
		const source = new CanvasSource(canvas, { codec: 'vp8', quality });
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		output.addVideoTrack(source);
		await output.start();

		for (const timestamp of [NaN, Infinity, '0', null]) {
			await expectTypeError(() => source.add(timestamp as never), 'timestamp');
		}
		for (const duration of [-1, NaN, Infinity, '1']) {
			await expectTypeError(() => source.add(0, duration as never), 'duration');
		}
		await source.add(0, 0.1);
		await output.finalize();
		expect(output.target.buffer!.byteLength).toBeGreaterThan(0);
	});

	test('MediaStream track sources validate their track and options', async () => {
		const canvas = document.createElement('canvas');
		const videoTrack = canvas.captureStream().getVideoTracks()[0]!;
		const context = new AudioContext();
		const audioTrack = context.createMediaStreamDestination().stream.getAudioTracks()[0]!;
		const videoConfig = { codec: 'vp8', quality } as const;
		const audioConfig = { codec: 'opus', quality } as const;

		await expectTypeError(
			() => new MediaStreamVideoTrackSource(audioTrack as never, { codec: 'vp8', quality }),
			'track',
		);
		await expectTypeError(
			() => new MediaStreamAudioTrackSource(videoTrack as never, { codec: 'opus', quality }),
			'track',
		);
		for (const options of [null, 'options', 1]) {
			await expectTypeError(
				() => new MediaStreamVideoTrackSource(videoTrack, { codec: 'vp8', quality }, options as never),
				'options',
			);
			await expectTypeError(
				() => new MediaStreamAudioTrackSource(audioTrack, { codec: 'opus', quality }, options as never),
				'options',
			);
		}
		// NaN and Infinity aren't rejected on main (fixed in upstream's bug-fix-mania branch)
		for (const frameRate of [0, -1, '30']) {
			await expectTypeError(
				() => new MediaStreamVideoTrackSource(videoTrack, videoConfig, { frameRate: frameRate as never }),
				'frameRate',
			);
		}
		for (const timestampBase of ['epoch', 1, null]) {
			await expectTypeError(
				() => new MediaStreamVideoTrackSource(videoTrack, videoConfig, { timestampBase } as never),
				'timestampBase',
			);
			await expectTypeError(
				() => new MediaStreamAudioTrackSource(audioTrack, audioConfig, { timestampBase } as never),
				'timestampBase',
			);
		}

		const source = new MediaStreamVideoTrackSource(videoTrack, { codec: 'vp8', quality }, { frameRate: 30 });
		expect(source.paused).toBe(false);
		source.pause();
		expect(source.paused).toBe(true);
		source.resume();
		expect(source.paused).toBe(false);
		expect(source.errorPromise).toBeInstanceOf(Promise);

		videoTrack.stop();
		audioTrack.stop();
		await context.close();
	});

	test('Web Audio conversions validate their arguments and round-trip', async () => {
		const buffer = new AudioBuffer({ numberOfChannels: 2, length: 480, sampleRate: 48000 });
		buffer.getChannelData(1).fill(0.5);

		for (const value of [undefined, null, {}, new Float32Array(4)]) {
			await expectTypeError(() => AudioSample.fromAudioBuffer(value as never, 0), 'audioBuffer');
		}
		const [sample] = AudioSample.fromAudioBuffer(buffer, 1.5);
		expect(sample!.timestamp).toBe(1.5);
		expect(sample!.numberOfChannels).toBe(2);
		expect(sample!.numberOfFrames).toBe(480);
		const back = sample!.toAudioBuffer();
		expect(back.getChannelData(1)[0]).toBe(0.5);
		const audioData = sample!.toAudioData();
		expect(audioData.timestamp).toBe(1_500_000);
		audioData.close();
		sample!.close();

		const source = new AudioBufferSource({ codec: 'opus', quality });
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		output.addAudioTrack(source);
		await output.start();
		for (const value of [undefined, null, {}, buffer.getChannelData(0)]) {
			await expectTypeError(() => source.add(value as never), 'audioBuffer');
		}
		await source.add(buffer);
		await output.finalize();
	});

	test('EncodedPacket converts to and from WebCodecs chunks', () => {
		for (const value of [undefined, null, {}, new Uint8Array(1)]) {
			expect(() => EncodedPacket.fromEncodedChunk(value as never)).toThrow(TypeError);
		}

		const chunk = new EncodedVideoChunk({
			type: 'key', timestamp: 1_000_000, duration: 40_000, data: new Uint8Array([1, 2]),
		});
		const packet = EncodedPacket.fromEncodedChunk(chunk, { alpha: new Uint8Array([3]) });
		expect(packet.timestamp).toBe(1);
		expect(packet.duration).toBe(0.04);
		expect([...packet.data]).toEqual([1, 2]);
		expect(packet.sideData.alphaByteLength).toBe(1);

		const roundTrip = packet.toEncodedVideoChunk();
		expect(roundTrip.timestamp).toBe(1_000_000);
		expect(roundTrip.byteLength).toBe(2);
		expect(packet.alphaToEncodedVideoChunk('delta').type).toBe('delta');
		expect(packet.toEncodedAudioChunk()).toBeInstanceOf(EncodedAudioChunk);
		expect(() => new EncodedPacket(new Uint8Array(1), 'key', 0, 0).alphaToEncodedVideoChunk()).toThrow(TypeError);
	});

	test('VideoSample draw methods validate their arguments', () => {
		const canvas = new OffscreenCanvas(4, 4);
		const context = canvas.getContext('2d')!;
		using sample = new VideoSample(new Uint8Array(4 * 4 * 4), {
			format: 'RGBA', codedWidth: 4, codedHeight: 4, timestamp: 0,
		});

		const badOptions = [
			null, 'fill', {}, { fit: 'stretch' }, { fit: 'fill', rotation: 45 }, { fit: 'fill', crop: null },
		];
		for (const options of badOptions) {
			expect(() => sample.drawWithFit(context, options as never)).toThrow(TypeError);
		}
		sample.drawWithFit(context, { fit: 'contain', rotation: 90 });
		sample.draw(context, 0, 0);
		expect(sample.toCanvasImageSource()).toBeInstanceOf(VideoFrame);
	});
});

describe('Codec support queries in a real browser', () => {
	test('return booleans and subsets of the codec lists', async () => {
		const decodable = await getDecodableCodecs();
		const encodable = await getEncodableCodecs();
		const known = [...VIDEO_CODECS, ...AUDIO_CODECS, ...SUBTITLE_CODECS] as string[];
		for (const codec of [...decodable, ...encodable]) {
			expect(known).toContain(codec);
		}
		// Every headless Chrome build can do these
		expect(decodable).toEqual(expect.arrayContaining(['avc', 'vp8', 'vp9', 'opus', 'pcm-s16']));
		expect(encodable).toEqual(expect.arrayContaining(['vp8', 'opus', 'pcm-s16', 'webvtt']));

		for (const codec of known) {
			expect(await canDecode(codec as never)).toBe(decodable.includes(codec as never));
			expect(await canEncode(codec as never)).toBe(encodable.includes(codec as never));
		}
		expect(await getFirstEncodableVideoCodec(['prores', 'vp8', 'vp9'])).toBe('vp8');
		expect(await getFirstEncodableAudioCodec(['flac', 'opus'], { numberOfChannels: 1, sampleRate: 48000 }))
			.toBe(encodable.includes('flac') ? 'flac' : 'opus');
	});
});

describe('Browser sinks', () => {
	test('CanvasSink and AudioBufferSink return their documented wrappers', async () => {
		using input = new Input({ source: new UrlSource('/demo.webm'), formats: ALL_FORMATS });
		const video = (await input.getPrimaryVideoTrack())!;
		const audio = (await input.getPrimaryAudioTrack())!;

		const canvasSink = new CanvasSink(video, { width: 32, height: 18, fit: 'fill', poolSize: 2 });
		const wrapped = (await canvasSink.getCanvas(0))!;
		expect(Object.keys(wrapped).sort()).toEqual(['canvas', 'duration', 'timestamp']);
		expect(wrapped.canvas.width).toBe(32);
		expect(wrapped.canvas.height).toBe(18);
		for (const timestamp of [NaN, '0', null]) {
			await expectTypeError(() => canvasSink.getCanvas(timestamp as never), 'timestamp');
		}

		const bufferSink = new AudioBufferSink(audio);
		const wrappedBuffer = (await bufferSink.getBuffer(0))!;
		expect(Object.keys(wrappedBuffer).sort()).toEqual(['buffer', 'duration', 'timestamp']);
		expect(wrappedBuffer.buffer).toBeInstanceOf(AudioBuffer);
		for (const timestamp of [NaN, '0', null]) {
			await expectTypeError(() => bufferSink.getBuffer(timestamp as never), 'timestamp');
		}
	});

	test('VideoSampleSource rejects closed samples and size changes by default', async () => {
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const source = new VideoSampleSource({ codec: 'vp8', quality });
		output.addVideoTrack(source);
		await output.start();

		const make = (width: number, timestamp: number) => new VideoSample(new Uint8Array(width * 16 * 4), {
			format: 'RGBA', codedWidth: width, codedHeight: 16, timestamp, duration: 0.1,
		});
		const closed = make(16, 0);
		closed.close();
		await expect(source.add(closed)).rejects.toThrow('closed');

		using first = make(16, 0);
		await source.add(first);
		using resized = make(32, 0.1);
		await expect(source.add(resized)).rejects.toThrow('sizeChangeBehavior');
		await output.cancel();
	});
});
