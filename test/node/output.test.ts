import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { AudioSampleSource, EncodedVideoPacketSource, VideoSampleSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { CustomAudioEncoder, CustomVideoEncoder, registerEncoder } from '../../src/custom-coder.js';
import { AudioCodec, VideoCodec } from '../../src/codec.js';
import { Quality } from '../../src/encode.js';
import { AudioSample, VideoSample } from '../../src/sample.js';

test('Output, onFinalize', async () => {
	let callCount = 0;
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
		onFinalize: async () => {
			await new Promise(resolve => setTimeout(resolve, 200));

			callCount++;
		},
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.5), {
		decoderConfig: {
			codec: 'avc1.640028',
			codedWidth: 1920,
			codedHeight: 1080,
		},
	});

	await output.finalize();

	expect(callCount).toBe(1);
});

// Encoders whose initialization fails, like extension encoders whose worker is blocked by a CSP
let failingEncodersActive = false;
const failingEncoderCalls: string[] = [];

class FailingInitAudioEncoder extends CustomAudioEncoder {
	static override supports(codec: AudioCodec) {
		return codec === 'aac' && failingEncodersActive;
	}

	init() {
		failingEncoderCalls.push('init');
		throw new Error('Encoder could not be initialized.');
	}

	encode() {
		failingEncoderCalls.push('encode');
	}

	flush() {
		failingEncoderCalls.push('flush');
	}

	close() {
		failingEncoderCalls.push('close');
	}
}

class FailingInitVideoEncoder extends CustomVideoEncoder {
	static override supports(codec: VideoCodec) {
		return codec === 'avc' && failingEncodersActive;
	}

	async init() {
		failingEncoderCalls.push('init');
		await new Promise(resolve => setTimeout(resolve, 10)); // Fails asynchronously, after finalize() was called
		throw new Error('Encoder could not be initialized.');
	}

	encode() {
		failingEncoderCalls.push('encode');
	}

	flush() {
		failingEncoderCalls.push('flush');
	}

	close() {
		failingEncoderCalls.push('close');
	}
}

// An encoder whose initialization only finishes when released, like one hanging in a platform codec
const hangingEncoder = { release: null as (() => void) | null };
const releaseHangingEncoder = () => {
	hangingEncoder.release?.();
	hangingEncoder.release = null;
};

class HangingInitAudioEncoder extends CustomAudioEncoder {
	static override supports(codec: AudioCodec) {
		return codec === 'opus' && failingEncodersActive;
	}

	async init() {
		failingEncoderCalls.push('init');
		await new Promise<void>(resolve => hangingEncoder.release = resolve);
	}

	encode() {
		failingEncoderCalls.push('encode');
	}

	flush() {
		failingEncoderCalls.push('flush');
	}

	close() {
		failingEncoderCalls.push('close');
	}
}

registerEncoder(FailingInitAudioEncoder);
registerEncoder(FailingInitVideoEncoder);
registerEncoder(HangingInitAudioEncoder);

test('Canceling doesn\'t wait for an encoder initialization that hangs, and closes the encoder after it', async () => {
	failingEncodersActive = true;
	failingEncoderCalls.length = 0;
	releaseHangingEncoder();

	try {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const source = new AudioSampleSource({ codec: 'opus', quality: new Quality('medium') });
		output.addAudioTrack(source);
		await output.start();

		using sample = new AudioSample({
			data: new Float32Array(960),
			format: 'f32',
			numberOfChannels: 1,
			sampleRate: 48000,
			timestamp: 0,
		});
		const addPromise = source.add(sample).catch(() => {});
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(failingEncoderCalls).toEqual(['init']);

		const canceled = await Promise.race([
			output.cancel().then(() => true),
			new Promise(resolve => setTimeout(() => resolve(false), 2000)),
		]);
		expect(canceled).toBe(true);

		// Once the initialization finishes, the encoder gets closed without encoding anything
		releaseHangingEncoder();
		await addPromise;
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(failingEncoderCalls).toEqual(['init', 'close']);
	} finally {
		releaseHangingEncoder();
		failingEncodersActive = false;
	}
});

test.each(['audio', 'video'] as const)(
	'A failed %s encoder initialization makes finalize() fail, without flushing the encoder',
	async (type) => {
		failingEncodersActive = true;
		failingEncoderCalls.length = 0;

		try {
			const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
			let addPromise: Promise<void>;

			if (type === 'audio') {
				const source = new AudioSampleSource({ codec: 'aac', quality: new Quality('medium') });
				output.addAudioTrack(source);
				await output.start();

				using sample = new AudioSample({
					data: new Float32Array(1024),
					format: 'f32',
					numberOfChannels: 1,
					sampleRate: 48000,
					timestamp: 0,
				});
				addPromise = source.add(sample);
			} else {
				const source = new VideoSampleSource({ codec: 'avc', quality: new Quality('medium') });
				output.addVideoTrack(source);
				await output.start();

				using sample = new VideoSample(new Uint8Array(16 * 16 * 4), {
					format: 'RGBX',
					codedWidth: 16,
					codedHeight: 16,
					timestamp: 0,
				});
				addPromise = source.add(sample);
			}

			// Not awaited, like in capture loops. Encoding errors make finalize() fail; initialization errors must too.
			addPromise.catch(() => {});
			await expect(output.finalize()).rejects.toThrow('Encoder could not be initialized.');
			await expect(addPromise).rejects.toThrow('Encoder could not be initialized.');
			expect(failingEncoderCalls).not.toContain('flush');
		} finally {
			failingEncodersActive = false;
		}
	},
);
