import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { Mp3OutputFormat, WavOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

describe('WAVE LIST INFO on output', () => {
	const writeWave = async (tags: Parameters<Output['setMetadataTags']>[0]) => {
		const target = new BufferTarget();
		const output = new Output({ format: new WavOutputFormat(), target });
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source);
		output.setMetadataTags(tags);
		await output.start();
		await source.add(new EncodedPacket(new Uint8Array(160), 'key', 0, 0.01), {
			decoderConfig: { codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 8000 },
		});
		await output.finalize();
		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		return { tags: await input.getMetadataTags(), bytes: new Uint8Array(target.buffer!) };
	};

	test('supported tags round-trip; unsupported ones are left out', async () => {
		const { tags } = await writeWave({
			title: 'Title',
			artist: 'Artist',
			album: 'Album',
			trackNumber: 3,
			tracksTotal: 10,
			genre: 'Genre',
			date: new Date('2015-06-12T00:00:00Z'),
			comment: 'Odd', // odd-sized value with its terminator: no padding byte needed
			description: 'Not in RIFF INFO',
			lyrics: 'Neither',
			discNumber: 1,
		});
		expect(tags).toMatchObject({
			title: 'Title',
			artist: 'Artist',
			album: 'Album',
			trackNumber: 3,
			tracksTotal: 10,
			genre: 'Genre',
			date: new Date('2015-06-12T00:00:00Z'),
			comment: 'Odd',
		});
		expect([tags.description, tags.lyrics, tags.discNumber]).toEqual([undefined, undefined, undefined]);

		const withoutTotal = await writeWave({ trackNumber: 4 });
		expect([withoutTotal.tags.trackNumber, withoutTotal.tags.tracksTotal]).toEqual([4, undefined]);
	});

	test('raw four-character tags are written unless a mapped tag already wrote them', async () => {
		const { tags } = await writeWave({
			title: 'Mapped title',
			raw: { INAM: 'Raw title', ISFT: 'Some software', LONGER: 'skipped', IKEY: new Uint8Array([1]) },
		});
		expect(tags.title).toBe('Mapped title');
		expect(tags.raw).toMatchObject({ INAM: 'Mapped title', ISFT: 'Some software' });
		expect(tags.raw!['LONGER']).toBeUndefined();
		expect(tags.raw!['IKEY']).toBeUndefined();
	});

	test('values outside ISO 8859-1 are skipped with a warning', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const { tags } = await writeWave({ title: 'タイトル', artist: 'Café' });
			expect(tags.title).toBeUndefined();
			expect(tags.artist).toBe('Café');
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe('MP3 Xing header on output', () => {
	test('a VBR remux gets a Xing frame with the audio byte count and a monotonic seek table', async () => {
		const filePath = path.join(__dirname, '..', 'public', 'Toothsome-Meme.VBRv2.mp3');
		const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
		const target = new BufferTarget();
		const output = new Output({ format: new Mp3OutputFormat(), target });
		const conversion = await Conversion.init({ input, output, copy: { shiftTolerance: 0.1 }, showWarnings: false });
		await conversion.execute();
		input.dispose();

		const bytes = new Uint8Array(target.buffer!);
		let pos = 0;
		if (String.fromCharCode(...bytes.subarray(0, 3)) === 'ID3') {
			pos = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
		}
		expect([bytes[pos], bytes[pos + 1]! & 0xe0]).toEqual([0xff, 0xe0]);
		const view = new DataView(bytes.buffer, bytes.byteOffset);
		// The Xing tag follows the side information, whose size depends on the MPEG version and channel mode
		const isMpeg1 = ((bytes[pos + 1]! >> 3) & 0b11) === 0b11;
		const isMono = bytes[pos + 3]! >> 6 === 0b11;
		const xingOffset = pos + 4 + (isMpeg1 ? (isMono ? 17 : 32) : (isMono ? 9 : 17));
		expect(String.fromCharCode(...bytes.subarray(xingOffset, xingOffset + 4))).toBe('Xing'); // VBR, not 'Info'
		const flags = view.getUint32(xingOffset + 4);
		expect(flags & 0b111).toBe(0b111); // frames, bytes and TOC
		expect(view.getUint32(xingOffset + 12)).toBe(bytes.length - pos); // From the Xing frame to the end

		const toc = [...bytes.subarray(xingOffset + 16, xingOffset + 116)];
		expect(toc[0]).toBe(0);
		expect(toc.every((value, i) => i === 0 || value >= toc[i - 1]!)).toBe(true);
		expect(Math.abs(toc[50]! - 128)).toBeLessThan(16);
		expect(toc[99]).toBeGreaterThan(240);
	});
});
