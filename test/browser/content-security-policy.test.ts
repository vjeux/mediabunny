import { beforeAll, expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { WebMOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { CanvasSource } from '../../src/media-source.js';
import { Quality } from '../../src/encode.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

// Pages with a Content Security Policy like this one (common on sites, and what browser extensions run under on
// third-party pages) can't start workers from blob: URLs. It applies to the whole page, hence this file of its own
beforeAll(() => {
	const meta = document.createElement('meta');
	meta.httpEquiv = 'Content-Security-Policy';
	meta.content = 'worker-src \'self\'';
	document.head.appendChild(meta);
});

const encodeTransparentVideo = async () => {
	const canvas = new OffscreenCanvas(64, 64);
	const context = canvas.getContext('2d')!;
	const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	const source = new CanvasSource(canvas, { codec: 'vp9', quality: new Quality('high'), alpha: 'keep' });
	output.addVideoTrack(source);
	await output.start();

	for (let i = 0; i < 5; i++) {
		context.clearRect(0, 0, 64, 64);
		context.fillStyle = 'red';
		context.fillRect(0, 0, 32, 64); // Left half opaque, right half transparent
		await source.add(i / 30, 1 / 30);
	}
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	let alphaPacketCount = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		alphaPacketCount += packet.sideData.alpha ? 1 : 0;
	}

	return alphaPacketCount;
};

test('Transparent video encodes under a CSP without blob: workers', async () => {
	// The color/alpha splitter normally runs in a blob: worker, which fails to load here. It's only tried once per page
	const RealWorker = Worker;
	let workerCount = 0;
	globalThis.Worker = class extends RealWorker {
		constructor(...args: ConstructorParameters<typeof Worker>) {
			super(...args);
			workerCount++;
		}
	};

	try {
		expect(await encodeTransparentVideo()).toBe(5);
		expect(await encodeTransparentVideo()).toBe(5);
		expect(workerCount).toBe(1);
	} finally {
		globalThis.Worker = RealWorker;
	}
});
