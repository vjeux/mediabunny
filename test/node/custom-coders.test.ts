import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { AudioSampleSource, VideoSampleSource } from '../../src/media-source.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { Quality } from '../../src/encode.js';
import { CustomAudioEncoder, CustomVideoEncoder, registerEncoder } from '../../src/custom-coder.js';

// Encodes a sample with a source that has no encoder for it here: Node has no WebCodecs
const encodeWithoutEncoder = async (type: 'audio' | 'video') => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	if (type === 'audio') {
		const source = new AudioSampleSource({ codec: 'aac', quality: new Quality(192_000) });
		output.addAudioTrack(source);
		await output.start();
		using sample = new AudioSample({
			data: new Float32Array(2 * 1024),
			format: 'f32',
			numberOfChannels: 2,
			sampleRate: 22050,
			timestamp: 0,
		});
		await source.add(sample);
	} else {
		const source = new VideoSampleSource({ codec: 'avc', quality: new Quality('medium') });
		output.addVideoTrack(source);
		await output.start();
		using sample = new VideoSample(new Uint8Array(64 * 64 * 4), {
			format: 'RGBA',
			codedWidth: 64,
			codedHeight: 64,
			timestamp: 0,
			duration: 1 / 30,
		});
		await source.add(sample);
	}

	await output.finalize();
};

test.each(['audio', 'video'] as const)(
	'The error for a %s encoder config that the registered custom encoders decline names the config',
	async (type) => {
		const className = type === 'audio' ? 'AudioEncoder' : 'VideoEncoder';

		// With no custom encoder registered, it's the environment that lacks an encoder
		await expect(encodeWithoutEncoder(type)).rejects.toThrow(`${className} is not available in this environment.`);

		// Custom encoders (like @mediabunny/server's) that decline this config, as they may for some sample rates or
		// profiles: it's the config that isn't supported then, even though the WebCodecs class is missing too
		class DecliningAudioEncoder extends CustomAudioEncoder {
			static override supports() {
				return false;
			}

			init() {}
			encode() {}
			flush() {}
			close() {}
		}
		class DecliningVideoEncoder extends CustomVideoEncoder {
			static override supports() {
				return false;
			}

			init() {}
			encode() {}
			flush() {}
			close() {}
		}
		registerEncoder(type === 'audio' ? DecliningAudioEncoder : DecliningVideoEncoder);

		await expect(encodeWithoutEncoder(type)).rejects.toThrow('This specific encoder configuration');
	},
);
