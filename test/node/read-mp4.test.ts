import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv } from 'node:crypto';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	MP4,
	MovOutputFormat,
	Mp4OutputFormat,
	Output,
} from '../../src/index.js';
import { assert, toUint8Array } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Should be able to get packets from a .MP4 file', async () => {
	const filePath = path.join(__dirname, '..', 'public/video.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP4);
	expect(await input.getMimeType()).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"');
	expect(await input.computeDuration()).toBe(5.056);

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	const sink = new EncodedPacketSink(track);

	let samples = 0;
	const timestamps: number[] = [];

	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		samples++;
	}

	expect(samples).toBe(125);
	expect(timestamps.slice(0, 10)).toEqual([
		0, 0.16, 0.08, 0.04, 0.12, 0.32, 0.24, 0.2, 0.28, 0.48,
	]);
});

test('MP4 nclx color information', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1),
		{
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 1280,
				codedHeight: 720,
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
		},
	);
	await output.finalize();

	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('nclc')).toBe(false);
	expect(str.includes('nclx')).toBe(true);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt2020',
		transfer: 'pq',
		matrix: 'bt2020-ncl',
		fullRange: false,
	});
	expect(await track.hasHighDynamicRange()).toBe(true);
});

test('QuickTime nclc color information', async () => {
	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1),
		{
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 1280,
				codedHeight: 720,
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
		},
	);
	await output.finalize();

	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('nclc')).toBe(true);
	expect(str.includes('nclx')).toBe(false);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt2020',
		transfer: 'pq',
		matrix: 'bt2020-ncl',
		fullRange: undefined,
	});
	expect(await track.hasHighDynamicRange()).toBe(true);
});

// Annex B isn't supposed to exist in MP4, but some files have it anyway, with an empty avcC box
test('Annex B', async () => {
	const filePath = path.join(__dirname, '..', 'public/annex-b.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	const decoderConfig = (await track.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('avc1.424028');
	expect(decoderConfig.description).toBeUndefined();

	const sink = new EncodedPacketSink(track);
	const firstPacket = (await sink.getFirstPacket())!;
	expect([...firstPacket.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);
});

test('HE-AAC v2 audio config is parsed correctly', async () => {
	const filePath = path.join(__dirname, '..', 'public/he-aac-v2.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getSampleRate()).toBe(44100);
	expect(await track.getNumberOfChannels()).toBe(2);

	const decoderConfig = (await track.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('mp4a.40.29');
	expect(decoderConfig.sampleRate).toBe(44100);
	expect(decoderConfig.numberOfChannels).toBe(2);
	expect([...toUint8Array(decoderConfig.description!)]).toEqual([0xeb, 0x8a, 0x08, 0x00]);
});

test('PCM track with stsc not starting at the first chunk', async () => {
	// The stsc box's first entry starts at the second chunk, leaving three chunks of PCM audio
	const filePath = path.join(__dirname, '..', 'public/pcm-stsc-not-first-chunk.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);

	let packetCount = 0;
	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		void packet;
		packetCount++;
	}

	expect(packetCount).toBe(3);
});

test('Missing tfdt and tfra entries referencing non-first samples', async () => {
	// See https://github.com/Vanilagy/mediabunny/issues/578
	const filePath = path.join(__dirname, '..', 'public/missing-tfdt.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(Number(packet.timestamp.toFixed(6)));
	}

	// Taken from ffprobe
	expect(timestamps).toEqual([
		0, 0.016667, 0.033333, 0.05, 0.066667, 0.083333, 0.1, 0.116667, 0.133333, 0.15,
		0.166667, 0.183333, 0.2, 0.216667, 0.233333, 0.25, 0.266667, 0.283333, 0.3, 0.316667,
		0.333333, 0.35, 0.366667, 0.383333, 0.4, 0.416667, 0.433333, 0.45, 0.466667, 0.483333,
		0.5, 0.516667, 0.533333, 0.55, 0.566667, 0.583333, 0.6, 0.616667, 0.633333, 0.65,
		0.666667, 0.683333, 0.7, 0.716667, 0.733333, 0.75, 0.766667, 0.783333, 0.8, 0.816667,
		0.833333, 0.85, 0.866667, 0.883333, 0.9, 0.916667, 0.933333, 0.95, 0.966667, 0.983333,
		1, 1.016667, 1.033333, 1.05, 1.066667, 1.083333, 1.1, 1.116667, 1.133333, 1.15,
		1.166667, 1.183333, 1.2, 1.216667, 1.233333, 1.25, 1.266667, 1.283333, 1.3, 1.316667,
		1.333333, 1.35, 1.366667, 1.383333, 1.4, 1.416667, 1.433333, 1.45, 1.466667, 1.483333,
		1.5, 1.516667, 1.533333, 1.55, 1.566667, 1.583333, 1.6, 1.616667, 1.633333, 1.65,
		1.666667, 1.683333, 1.7, 1.716667, 1.733333, 1.75, 1.766667, 1.783333, 1.8, 1.816667,
		1.833333, 1.85, 1.866667, 1.883333, 1.9, 1.916667, 1.933333, 1.95, 1.966667, 1.983333,
		2, 2.016667, 2.033333, 2.05, 2.066667, 2.083333, 2.1, 2.116667, 2.133333, 2.15,
		2.166667, 2.183333, 2.2, 2.216667, 2.233333, 2.25, 2.266667, 2.283333, 2.3, 2.316667,
		2.333333, 2.35, 2.366667, 2.383333, 2.4, 2.416667, 2.433333, 2.45, 2.466667, 2.483333,
		2.5, 2.516667, 2.533333, 2.55, 2.566667, 2.583333, 2.6, 2.616667, 2.633333, 2.65,
		2.666667, 2.683333, 2.7, 2.716667, 2.733333, 2.75, 2.766667, 2.783333, 2.8, 2.816667,
		2.833333, 2.85, 2.866667, 2.883333, 2.9, 2.916667, 2.933333, 2.95, 2.966667, 2.983333,
		3, 3.016667, 3.033333, 3.05, 3.066667, 3.083333, 3.1, 3.116667, 3.133333, 3.15,
		3.166667, 3.183333, 3.2, 3.216667, 3.233333, 3.25, 3.266667, 3.283333, 3.3, 3.316667,
		3.333333, 3.35, 3.366667, 3.383333, 3.4, 3.416667, 3.433333, 3.45, 3.466667, 3.483333,
		3.5, 3.516667, 3.533333, 3.55, 3.566667, 3.583333, 3.6, 3.616667, 3.633333, 3.65,
		3.666667, 3.683333, 3.7, 3.716667, 3.733333, 3.75, 3.766667, 3.783333, 3.8, 3.816667,
		3.833333, 3.85, 3.866667, 3.883333, 3.9, 3.916667, 3.933333, 3.95, 3.966667, 3.983333,
	]);
});

test('Key packet lookup after reading fragments without key frames', async () => {
	// See https://github.com/Vanilagy/mediabunny/issues/584
	const filePath = path.join(__dirname, '..', 'public/fragments-without-keyframes.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	expect((await sink.getKeyPacket(1.2))?.timestamp).toBe(1);

	for await (const packet of sink.packets()) {
		void packet;
	}

	expect((await sink.getKeyPacket(1.2))?.timestamp).toBe(1);
});

test('Encrypted samples without encryption info throw instead of coming back as ciphertext', async () => {
	// FFmpeg's fragmented cenc output (-encryption_scheme cenc-aes-ctr with frag_keyframe, empty_moov or cmaf)
	// encrypts the samples but writes no senc/saiz/saio into the fragments, so their IVs are lost
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const plaintext = [0, 0, 0, 12, 0x65, ...zeros(12)];
	const iv = [...zeros(7), 1];
	const ciphertext = [
		...createCipheriv('aes-128-ctr', key, Buffer.from([...iv, ...zeros(8)])).update(Buffer.from(plaintext)),
	];
	const sampleEntry = (name: string, ...children: number[][]) => box(name, zeros(6), [0, 1], zeros(16),
		[0, 64, 0, 64], zeros(12), [0, 1], zeros(32), [0, 24, 0xff, 0xff],
		box('avcC', [1, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x00]), ...children);
	const encv = (isProtected = 1) => sampleEntry('encv', box('sinf', box('frma', ascii('avc1')),
		box('schm', u32(0), ascii('cenc'), u32(0x10000)),
		box('schi', box('tenc', u32(0), [0, 0, isProtected, 8], zeros(16)))));
	const trak = (sampleEntries: number[][], ...stbl: number[][]) => box('trak',
		box('tkhd', u32(3), zeros(8), u32(1), zeros(4), u32(1), zeros(16), matrix, u32(64 << 16), u32(64 << 16)),
		box('mdia',
			box('mdhd', zeros(12), u32(10), u32(1), [0x55, 0xc4, 0, 0]),
			box('hdlr', zeros(8), ascii('vide'), zeros(13)),
			box('minf', box('stbl', box('stsd', u32(0), u32(sampleEntries.length), ...sampleEntries), ...stbl)),
		),
	);
	const mvhd = box('mvhd', zeros(12), u32(10), u32(1), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28));
	const ftyp = box('ftyp', ascii('iso6'), u32(0));
	const fragmented = (options: {
		sampleEntries: number[][];
		sampleDescriptionIndex?: number;
		trafBoxes: number[][];
		data: number[];
	}) => {
		const moof = (dataOffset: number) => box('moof', box('mfhd', u32(0), u32(1)), box('traf',
			box('tfhd', u32(0x020002), u32(1), u32(options.sampleDescriptionIndex ?? 1)),
			box('trun', u32(0x301), u32(1), u32(dataOffset), u32(1), u32(options.data.length)),
			...options.trafBoxes,
		));
		return [
			...ftyp,
			...box('moov',
				mvhd,
				trak(options.sampleEntries, box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)),
					box('stco', zeros(8))),
				box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
			),
			...moof(moof(0).length + 8),
			...box('mdat', options.data),
		];
	};
	const regular = (withAuxInfo: boolean) => {
		const moov = (mdatStart: number) => box('moov', mvhd, trak([encv()],
			box('stts', u32(0), u32(1), u32(1), u32(1)),
			box('stsc', u32(0), u32(1), u32(1), u32(1), u32(1)),
			box('stsz', u32(0), u32(ciphertext.length), u32(1)),
			box('stco', u32(0), u32(1), u32(mdatStart + 8 + iv.length)),
			...(withAuxInfo
				? [box('saiz', u32(0), [iv.length], u32(1)), box('saio', u32(0), u32(1), u32(mdatStart + 8))]
				: []),
		));
		const mdatStart = ftyp.length + moov(0).length;
		return [...ftyp, ...moov(mdatStart), ...box('mdat', iv, ciphertext)];
	};
	const readFirstPacket = async (bytes: number[]) => {
		using input = new Input({
			source: new BufferSource(new Uint8Array(bytes)),
			formats: ALL_FORMATS,
			formatOptions: { isobmff: { resolveKeyId: () => key } },
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const packet = await new EncodedPacketSink(track).getFirstPacket();
		return [...packet!.data];
	};

	const senc = box('senc', u32(0), u32(1), iv);
	expect(await readFirstPacket(fragmented({ sampleEntries: [encv()], trafBoxes: [senc], data: ciphertext })))
		.toEqual(plaintext);
	expect(await readFirstPacket(regular(true))).toEqual(plaintext);
	await expect(readFirstPacket(fragmented({ sampleEntries: [encv()], trafBoxes: [], data: ciphertext })))
		.rejects.toThrow(/encryption info/);
	await expect(readFirstPacket(regular(false))).rejects.toThrow(/encryption info/);

	// Samples that are clear can still be read: clear lead samples with a clear sample description (Shaka Packager),
	// samples that tenc marks as unprotected, and samples a CENC sample group can mark as unprotected
	expect(await readFirstPacket(fragmented({
		sampleEntries: [encv(), sampleEntry('avc1')],
		sampleDescriptionIndex: 2,
		trafBoxes: [],
		data: plaintext,
	}))).toEqual(plaintext);
	expect(await readFirstPacket(fragmented({ sampleEntries: [encv(0)], trafBoxes: [], data: plaintext })))
		.toEqual(plaintext);
	expect(await readFirstPacket(fragmented({
		sampleEntries: [encv()],
		trafBoxes: [
			box('sbgp', u32(0), ascii('seig'), u32(1), u32(1), u32(0x10001)),
			box('sgpd', u32(1 << 24), ascii('seig'), u32(20), u32(1), [0, 0, 0, 0], zeros(16)),
		],
		data: plaintext,
	}))).toEqual(plaintext);
});

test('Samples of a sample description whose tenc marks them unprotected stay readable', async () => {
	// A fragmented track with two encv sample descriptions: the first's tenc marks its samples as unprotected (clear
	// data, no senc), the second's protects them (senc with 8-byte IVs). The first fragment uses the first.
	const u32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	const zeros = (count: number) => new Array<number>(count).fill(0);
	const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
	const box = (type: string, ...contents: number[][]) => {
		const bytes = contents.flat();
		return [...u32(8 + bytes.length), ...ascii(type), ...bytes];
	};
	const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
	const plaintext = (i: number) => [
		0, 0, 0, 28, 0x65, ...Array.from({ length: 27 }, (_, k) => (k * 13 + i * 7) & 0xff),
	];
	const iv = (i: number) => [...zeros(7), i + 1];
	const encrypt = (i: number) => [
		...createCipheriv('aes-128-ctr', key, Buffer.from([...iv(i), ...zeros(8)])).update(Buffer.from(plaintext(i))),
	];
	const matrix = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
	const encv = (isProtected: number, keyIdByte: number) => box('encv', zeros(6), [0, 1], zeros(16), [0, 64, 0, 64],
		zeros(12), [0, 1], zeros(32), [0, 24, 0xff, 0xff], box('avcC', [1, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x00]),
		box('sinf', box('frma', ascii('avc1')), box('schm', u32(0), ascii('cenc'), u32(0x10000)),
			box('schi', box('tenc', u32(0), [0, 0, isProtected, 8], zeros(16).fill(keyIdByte)))));
	const bytes = [...box('ftyp', ascii('iso6'), u32(0)), ...box('moov',
		box('mvhd', zeros(12), u32(10), u32(0), u32(0x10000), [1, 0], zeros(10), matrix, zeros(28)),
		box('trak',
			box('tkhd', u32(3), zeros(8), u32(1), zeros(24), matrix, u32(64 << 16), u32(64 << 16)),
			box('mdia',
				box('mdhd', zeros(12), u32(10), u32(0), [0x55, 0xc4, 0, 0]),
				box('hdlr', zeros(8), ascii('vide'), zeros(13)),
				box('minf', box('stbl',
					box('stsd', u32(0), u32(2), encv(0, 0xaa), encv(1, 0xbb)),
					box('stts', zeros(8)),
					box('stsc', zeros(8)),
					box('stsz', zeros(12)),
					box('stco', zeros(8)),
				)),
			),
		),
		box('mvex', box('trex', u32(0), u32(1), u32(1), u32(1), u32(0), u32(0))),
	)];
	for (const [fragment, description, samples] of [[0, 1, [0, 1]], [1, 2, [2, 3]]] as const) {
		const data = samples.map(i => (description === 1 ? plaintext(i) : encrypt(i)));
		const senc = description === 2 ? [box('senc', u32(0), u32(samples.length), samples.flatMap(iv))] : [];
		const moof = (dataOffset: number) => box('moof', box('mfhd', u32(0), u32(fragment + 1)), box('traf',
			box('tfhd', u32(0x020002), u32(1), u32(description)),
			box('tfdt', u32(0), u32(samples[0])),
			box('trun', u32(0x301), u32(samples.length), u32(dataOffset),
				...samples.map(() => [...u32(1), ...u32(32)])),
			...senc,
		));
		bytes.push(...moof(moof(0).length + 8), ...box('mdat', data.flat()));
	}

	using input = new Input({
		source: new BufferSource(new Uint8Array(bytes)),
		formats: ALL_FORMATS,
		formatOptions: { isobmff: { resolveKeyId: () => key } },
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);
	for (let i = 0; i < 4; i++) {
		expect([...(await sink.getPacket(i / 10 + 0.01))!.data]).toEqual(plaintext(i));
	}
});
