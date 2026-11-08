import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { FlacOutputFormat } from '../../src/output-format.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('STREAMINFO of output with a single frame', async () => {
	// One frame of 4096 samples, as when trimming a FLAC file to its first 93 ms without re-encoding
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample.flac')),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);
	const packet = await new EncodedPacketSink(track).getFirstPacket();
	assert(packet);

	const output = new Output({ format: new FlacOutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('flac');
	output.addAudioTrack(source);
	await output.start();
	await source.add(packet, { decoderConfig });
	await output.finalize();

	// The minimum block size excludes the last block (RFC 9639, section 8.2), and with no other block, it's that of the
	// only block, as in a fixed block size stream. Decoders reject a minimum block size below 16, so 0 doesn't do.
	const bytes = new Uint8Array(output.target.buffer!);
	const view = new DataView(bytes.buffer);
	expect([view.getUint16(8), view.getUint16(10)]).toEqual([4096, 4096]);

	using written = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const writtenTrack = await written.getPrimaryAudioTrack();
	assert(writtenTrack);
	expect(await writtenTrack.computeDuration()).toBeCloseTo(4096 / 44100, 9);
});
