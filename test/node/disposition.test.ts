import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';

test('Default track disposition', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);

	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1), {
		decoderConfig: {
			codec: 'avc1.123456',
			codedWidth: 1920,
			codedHeight: 1080,
		},
	});

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryVideoTrack())!;

	expect(await track.getDisposition()).toEqual({
		default: true,
		forced: false,
		original: false,
		hearingImpaired: false,
		visuallyImpaired: false,
		primary: false,
		commentary: false,
	});
});

test('Customized track disposition', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, {
		disposition: {
			default: false,
			forced: true,
			original: true,
			hearingImpaired: true,
			visuallyImpaired: true,
			commentary: true,
		},
	});

	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1), {
		decoderConfig: {
			codec: 'avc1.123456',
			codedWidth: 1920,
			codedHeight: 1080,
		},
	});

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryVideoTrack())!;

	expect(await track.getDisposition()).toEqual({
		default: false,
		forced: true,
		original: true,
		hearingImpaired: true,
		visuallyImpaired: true,
		primary: false,
		commentary: true,
	});
});

test('MP4 track dispositions from kind boxes', async () => {
	// FFmpeg writes a track's dispositions as kind boxes (ISO/IEC 14496-12 8.10.4) in the track's udta box, with DASH
	// roles (ISO/IEC 23009-1 5.8.5.5)
	const withKindBoxes = async (kinds: [scheme: string, value: string][]) => {
		const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('aac');
		output.addAudioTrack(source);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(100), 'key', 0, 1024 / 48000), {
			// AudioSpecificConfig: AAC-LC, 48 kHz, mono
			decoderConfig: {
				codec: 'mp4a.40.2',
				numberOfChannels: 1,
				sampleRate: 48000,
				description: new Uint8Array([0x11, 0x88]),
			},
		});
		await output.finalize();

		// Add a udta box with the kind boxes at the end of the trak box. The moov box comes after the media data, so
		// no sample offset changes.
		const bytes = new Uint8Array(output.target.buffer!);
		const findBox = (name: string) => bytes.findIndex(
			(_, i) => new TextDecoder().decode(bytes.subarray(i + 4, i + 8)) === name,
		);
		const box = (name: string, content: Uint8Array) => {
			const result = new Uint8Array(8 + content.length);
			new DataView(result.buffer).setUint32(0, result.length);
			result.set(new TextEncoder().encode(name), 4);
			result.set(content, 8);
			return result;
		};
		const encoder = new TextEncoder();
		const kindBoxes = kinds.map(([scheme, value]) => box('kind', new Uint8Array([
			0, 0, 0, 0, ...encoder.encode(scheme), 0, ...encoder.encode(value), 0,
		])));
		const udta = box('udta', new Uint8Array(kindBoxes.flatMap(x => [...x])));

		const view = new DataView(bytes.buffer);
		const [moov, trak] = [findBox('moov'), findBox('trak')];
		const trakEnd = trak + view.getUint32(trak);
		expect(moov + view.getUint32(moov)).toBe(bytes.length);
		const result = new Uint8Array([...bytes.subarray(0, trakEnd), ...udta, ...bytes.subarray(trakEnd)]);
		const resultView = new DataView(result.buffer);
		resultView.setUint32(trak, view.getUint32(trak) + udta.length);
		resultView.setUint32(moov, view.getUint32(moov) + udta.length);

		using input = new Input({ source: new BufferSource(result), formats: ALL_FORMATS });
		const disposition = await (await input.getPrimaryAudioTrack())!.getDisposition();
		return [disposition.commentary, disposition.hearingImpaired, disposition.visuallyImpaired, disposition.forced];
	};

	const role = (value: string): [string, string] => ['urn:mpeg:dash:role:2011', value];
	expect(await withKindBoxes([])).toEqual([false, false, false, false]);
	expect(await withKindBoxes([role('commentary')])).toEqual([true, false, false, false]);
	expect(await withKindBoxes([role('caption')])).toEqual([false, true, false, false]);
	expect(await withKindBoxes([role('description')])).toEqual([false, false, true, false]);
	expect(await withKindBoxes([role('forced-subtitle')])).toEqual([false, false, false, true]);
	expect(await withKindBoxes([role('caption'), role('commentary'), role('description'), role('forced-subtitle')]))
		.toEqual([true, true, true, true]);

	// Other roles and schemes don't map to dispositions
	expect(await withKindBoxes([role('dub'), role('main'), ['urn:example:roles', 'commentary']]))
		.toEqual([false, false, false, false]);
});

test('MP4 kind box whose size goes past its udta box', async () => {
	// The kind box is complete, but its size field claims 0x7fffff00 bytes. Like FFmpeg, read what's there.
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source, { name: 'Commentary' });
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(100), 'key', 0, 1024 / 48000), {
		// AudioSpecificConfig: AAC-LC, 48 kHz, mono
		decoderConfig: {
			codec: 'mp4a.40.2',
			numberOfChannels: 1,
			sampleRate: 48000,
			description: new Uint8Array([0x11, 0x88]),
		},
	});
	await output.finalize();

	// Add udta { kind } at the end of the trak box
	const bytes = new Uint8Array(output.target.buffer!);
	const findBox = (name: string) => bytes.findIndex(
		(_, i) => new TextDecoder().decode(bytes.subarray(i + 4, i + 8)) === name,
	);
	const content = [0, 0, 0, 0, ...new TextEncoder().encode('urn:mpeg:dash:role:2011\0commentary\0')];
	const kind = new Uint8Array(8 + content.length);
	new DataView(kind.buffer).setUint32(0, 0x7fffff00);
	kind.set(new TextEncoder().encode('kind'), 4);
	kind.set(content, 8);
	const udta = new Uint8Array(8 + kind.length);
	new DataView(udta.buffer).setUint32(0, udta.length);
	udta.set(new TextEncoder().encode('udta'), 4);
	udta.set(kind, 8);

	const view = new DataView(bytes.buffer);
	const [moov, trak] = [findBox('moov'), findBox('trak')];
	const trakEnd = trak + view.getUint32(trak);
	const result = new Uint8Array([...bytes.subarray(0, trakEnd), ...udta, ...bytes.subarray(trakEnd)]);
	const resultView = new DataView(result.buffer);
	resultView.setUint32(trak, view.getUint32(trak) + udta.length);
	resultView.setUint32(moov, view.getUint32(moov) + udta.length);

	using input = new Input({ source: new BufferSource(result), formats: ALL_FORMATS });
	const track = (await input.getPrimaryAudioTrack())!;
	expect((await track.getDisposition()).commentary).toBe(true);
	expect(await track.getName()).toBe('Commentary');
	expect((await track.computePacketStats()).packetCount).toBe(1);
});
