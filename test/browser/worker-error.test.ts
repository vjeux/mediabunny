import { beforeAll, expect, test } from 'vitest';
import type { AudioCodec } from '../../src/codec.js';
import { Quality } from '../../src/encode.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { MovOutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { BufferTarget } from '../../src/target.js';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { registerAc3Encoder } from '@mediabunny/ac3';
import { registerDtsEncoder } from '@mediabunny/dts';
import { registerTrueHdEncoder } from '@mediabunny/truehd';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { registerProresDecoder } from '@mediabunny/prores';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { VideoSampleSink } from '../../src/media-sink.js';
import { UrlSource } from '../../src/source.js';

beforeAll(() => {
	const meta = document.createElement('meta');
	meta.httpEquiv = 'Content-Security-Policy';
	meta.content = 'worker-src \'self\'';
	document.head.appendChild(meta);
});

const cases: { codec: AudioCodec; register: () => void; bitrate: number }[] = [
	{ codec: 'aac', register: registerAacEncoder, bitrate: 192000 },
	{ codec: 'flac', register: registerFlacEncoder, bitrate: 192000 },
	{ codec: 'mp3', register: registerMp3Encoder, bitrate: 192000 },
	{ codec: 'ac3', register: registerAc3Encoder, bitrate: 192000 },
	{ codec: 'dts', register: registerDtsEncoder, bitrate: 768000 },
	{ codec: 'truehd', register: registerTrueHdEncoder, bitrate: 192000 },
];

for (const { codec, register, bitrate } of cases) {
	test(`${codec} encoder CSP worker rejection`, async () => {
		register();

		const output = new Output({
			format: new MovOutputFormat(),
			target: new BufferTarget(),
		});
		const audioSource = new AudioSampleSource({ codec, quality: new Quality({ bitrate }) });
		output.addAudioTrack(audioSource);
		await output.start();

		const sampleRate = 48000;
		using sample = new AudioSample({
			data: new Float32Array(sampleRate * 2),
			format: 'f32',
			numberOfChannels: 2,
			sampleRate,
			timestamp: 0,
		});

		await expect((async () => {
			await audioSource.add(sample);
			audioSource.close();
			await output.finalize();
		})()).rejects.toThrow(/worker/i);

		await output.cancel();
	});
}

test('ProRes decoding without blob: workers', { timeout: 20_000 }, async () => {
	// The ProRes decoder runs its WebAssembly in workers started from blob: URLs, which this page's CSP forbids, so it
	// has to decode on the calling thread instead of waiting for its workers forever
	registerProresDecoder();

	// ffmpeg -f lavfi -i testsrc2=s=64x32:r=10:d=0.2 -c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le \
	//   -fflags +bitexact -flags:v +bitexact prores-422hq-64x32.mov
	using input = new Input({
		source: new UrlSource('/prores-422hq-64x32.mov'),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;

	let count = 0;
	for await (using sample of new VideoSampleSink(track).samples()) {
		expect(sample.displayWidth).toBe(64);
		count++;
	}
	expect(count).toBe(2);
});
