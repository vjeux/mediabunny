import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { StreamTarget, type StreamTargetChunk } from '../../src/target.js';
import { AdtsOutputFormat } from '../../src/output-format.js';
import { assert } from '../../src/misc.js';
import { EncodedPacket } from '../../src/packet.js';

const createBufferingStreamTarget = () => {
	const written = new Map<number, Uint8Array>();

	const stream = new WritableStream<StreamTargetChunk>({
		async write(chunk: StreamTargetChunk) {
			written.set(chunk.position, chunk.data.slice());
		},
	});

	const toBuffer = () => {
		let maxEnd = 0;
		for (const [offset, data] of written) {
			maxEnd = Math.max(maxEnd, offset + data.byteLength);
		}
		const buffer = new Uint8Array(maxEnd);
		for (const [offset, data] of written) {
			buffer.set(data, offset);
		}
		return buffer;
	};

	return { stream, toBuffer };
};

test('ADTS with metadata over StreamTarget', async () => {
	const target = createBufferingStreamTarget();

	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new StreamTarget(target.stream),
	});

	output.setMetadataTags({ comment: 'Remotion' });

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();

	using input = new Input({
		source: new UrlSource('/sample3.aac'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new EncodedPacketSink(audioTrack);

	let isFirst = true;
	for await (const packet of sink.packets()) {
		await audioSource.add(packet, {
			decoderConfig: isFirst ? (await audioTrack.getDecoderConfig())! : undefined,
		});
		isFirst = false;
	}

	await output.finalize();

	const buffer = target.toBuffer();
	using outputAsInput = new Input({
		source: new BufferSource(buffer.buffer),
		formats: ALL_FORMATS,
	});

	const readTags = await outputAsInput.getMetadataTags();
	expect(readTags.comment).toBe('Remotion');

	const outputAudioTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputAudioTrack);
	expect(await outputAudioTrack.getCodec()).toBe('aac');
});

test('Unrepresentable channel configuration', async () => {
	const target = createBufferingStreamTarget();
	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new StreamTarget(target.stream),
	});

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();

	// What FFmpeg's encoder writes for 7.1: channel configuration 12, too large for the 3-bit ADTS field
	const description = new Uint8Array([0x11, 0xe0, 0x56, 0xe5, 0x00]);
	await expect(source.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 1024 / 48000), {
		decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 8, sampleRate: 48000, description },
	})).rejects.toThrow('channel configuration 12');
});

// Previously, write handler rejections were silently swallowed and surfaced as
// "Cannot write to a closing writable stream" instead of the actual error.
test('StreamTarget write errors surface directly', async () => {
	let writeCount = 0;
	const stream = new WritableStream<StreamTargetChunk>({
		async write() {
			writeCount++;
			if (writeCount === 2) {
				throw new Error('OPFS write failed');
			}
		},
	});

	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new StreamTarget(stream),
	});

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();

	using input = new Input({
		source: new UrlSource('/sample3.aac'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new EncodedPacketSink(audioTrack);

	const run = async () => {
		let isFirst = true;
		for await (const packet of sink.packets()) {
			await audioSource.add(packet, {
				decoderConfig: isFirst ? (await audioTrack.getDecoderConfig())! : undefined,
			});
			isFirst = false;
		}
		await output.finalize();
	};

	await expect(run()).rejects.toThrow('OPFS write failed');
});
