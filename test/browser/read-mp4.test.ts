import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BlobSource, UrlSource, BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, VideoSampleSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

test('Encrypted MP4 without senc', async () => {
	using input = new Input({
		source: new UrlSource('/639955605-b752f7ad-7ce8-43c2-8ae9-88e74c6ae696.mp4'),
		formats: ALL_FORMATS,
		formatOptions: {
			isobmff: {
				resolveKeyId: () => 'aabbccddeeff00112233445566778899',
			},
		},
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	// Test that it can decode
	const sink = new AudioSampleSink(audioTrack);
	using firstSample = await sink.getSample(0);
	assert(firstSample);
	expect(firstSample.timestamp).toBe(0);
});

test('Decode a VP9 MP4 recording from MediaRecorder', async (context) => {
	// Chrome writes level 0 into the vpcC box of these recordings
	const mimeType = 'video/mp4;codecs=vp9';
	// WebKit's WPE port has no MediaRecorder
	if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(mimeType)) {
		context.skip();
	}

	const canvas = document.createElement('canvas');
	canvas.width = 320;
	canvas.height = 240;
	const canvasContext = canvas.getContext('2d')!;
	const stream = canvas.captureStream(30);

	let frame = 0;
	const interval = setInterval(() => {
		canvasContext.fillStyle = `hsl(${(frame++ * 7) % 360} 80% 50%)`;
		canvasContext.fillRect(0, 0, 320, 240);
	}, 1000 / 30);

	const recorder = new MediaRecorder(stream, { mimeType });
	const chunks: Blob[] = [];
	recorder.ondataavailable = event => chunks.push(event.data);
	const stopped = new Promise(resolve => recorder.onstop = resolve);
	recorder.start();
	await new Promise(resolve => setTimeout(resolve, 1000));
	recorder.stop();
	await stopped;
	clearInterval(interval);

	using input = new Input({ source: new BlobSource(new Blob(chunks)), formats: ALL_FORMATS });
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getCodec()).toBe('vp9');
	expect(await videoTrack.canDecode()).toBe(true);

	using sample = await new VideoSampleSink(videoTrack).getSample(0);
	assert(sample);
	expect(sample.displayWidth).toBe(320);
});

test('Decode an AVC track whose sample descriptions change the parameter sets', async () => {
	// Like FFmpeg writes when the parameter sets change mid-stream: one sample description per set of parameter sets
	const encode = async (width: number, height: number) => {
		const chunks: { data: Uint8Array; isKey: boolean }[] = [];
		let description: Uint8Array | null = null;
		const encoder = new VideoEncoder({
			output: (chunk, metadata) => {
				const data = new Uint8Array(chunk.byteLength);
				chunk.copyTo(data);
				chunks.push({ data, isKey: chunk.type === 'key' });
				if (metadata?.decoderConfig?.description) {
					description = new Uint8Array(metadata.decoderConfig.description as ArrayBuffer);
				}
			},
			error: (error) => {
				throw error;
			},
		});
		encoder.configure({ codec: 'avc1.42001f', width, height, avc: { format: 'avc' } });

		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d')!;
		for (let i = 0; i < 2; i++) {
			context.fillStyle = i === 0 ? 'red' : 'blue';
			context.fillRect(0, 0, width, height);
			const frame = new VideoFrame(canvas, { timestamp: i * 40_000 });
			encoder.encode(frame, { keyFrame: i === 0 });
			frame.close();
		}
		await encoder.flush();
		encoder.close();

		assert(description);
		return { chunks, description: description as Uint8Array };
	};

	const first = await encode(256, 128);
	const second = await encode(128, 128);
	const samples = [...first.chunks, ...second.chunks];
	expect(samples.map(x => x.isKey)).toEqual([true, false, true, false]);

	// Whether the platform's decoder takes a resolution change from parameter sets sent in band. WebKit's GStreamer
	// one doesn't (the WebCodecs AVC registration only promises the description's parameter sets), and keeps the
	// first size, for the decoder alone as for Mediabunny.
	const decodesInBandResolutionChanges = await (async () => {
		const lengthSize = (second.description[4]! & 3) + 1;
		const inBandParameterSets: number[] = [];
		let offset = 5;
		for (const countMask of [0x1f, 0xff]) { // SPS, then PPS
			const count = second.description[offset]! & countMask;
			offset++;
			for (let i = 0; i < count; i++) {
				const length = (second.description[offset]! << 8) | second.description[offset + 1]!;
				for (let j = lengthSize - 1; j >= 0; j--) {
					inBandParameterSets.push((length >> (8 * j)) & 0xff);
				}
				inBandParameterSets.push(...second.description.subarray(offset + 2, offset + 2 + length));
				offset += 2 + length;
			}
		}

		const sizes: number[][] = [];
		const decoder = new VideoDecoder({
			output: (frame) => {
				sizes.push([frame.codedWidth, frame.codedHeight]);
				frame.close();
			},
			error: () => {},
		});
		decoder.configure({ codec: 'avc1.42001f', description: first.description });
		for (const [i, sample] of samples.entries()) {
			decoder.decode(new EncodedVideoChunk({
				type: sample.isKey ? 'key' : 'delta',
				timestamp: i * 40_000,
				data: i === 2 ? new Uint8Array([...inBandParameterSets, ...sample.data]) : sample.data,
			}));
		}

		try {
			await decoder.flush();
		} catch {
			return false;
		} finally {
			if (decoder.state !== 'closed') {
				decoder.close();
			}
		}

		return sizes[2]?.[0] === 128;
	})();

	const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const avc1 = (width: number, height: number, description: Uint8Array) => box('avc1', zeros(6), u16(1), zeros(16),
		u16(width), u16(height), u32(0x480000), u32(0x480000), zeros(4), u16(1), zeros(32), u16(24), u16(0xffff),
		box('avcC', [...description]));

	const moov = (chunkOffsets: number[]) => box('moov',
		box('mvhd', zeros(12), u32(25), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(256 << 16), u32(128 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(25), u32(4), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(2), avc1(256, 128, first.description), avc1(128, 128, second.description)),
					box('stts', u32(0), u32(1), u32(4), u32(1)),
					box('stss', u32(0), u32(2), u32(1), u32(3)),
					box('stsc', u32(0), u32(2), u32(1), u32(2), u32(1), u32(2), u32(2), u32(2)),
					box('stsz', u32(0), u32(0), u32(4), ...samples.map(x => u32(x.data.byteLength))),
					box('stco', u32(0), u32(2), ...chunkOffsets.map(u32)),
				)),
			),
		),
	);
	const ftyp = box('ftyp', ascii('qt  '), u32(0), ascii('qt  '));
	const dataStart = ftyp.length + moov([0, 0]).length + 8;

	using input = new Input({
		source: new BufferSource(new Uint8Array([
			...ftyp,
			...moov([dataStart, dataStart + samples[0]!.data.byteLength + samples[1]!.data.byteLength]),
			...box('mdat', ...samples.map(x => [...x.data])),
		])),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sizes: number[][] = [];
	for await (const sample of new VideoSampleSink(track).samples()) {
		sizes.push([sample.codedWidth, sample.codedHeight]);
		sample.close();
	}
	if (decodesInBandResolutionChanges) {
		expect(sizes).toEqual([[256, 128], [256, 128], [128, 128], [128, 128]]);
	} else {
		// Every frame still decodes, but at the first size, like with the decoder alone
		expect(sizes).toHaveLength(4);
	}
});
