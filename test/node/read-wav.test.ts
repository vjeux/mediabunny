import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, CustomSource, EncodedPacketSink, Input, FilePathSource } from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Should handle WAV file with oversized ID3 chunk', async () => {
	const filePath = path.join(__dirname, '..', 'public/oversized-id3.wav');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track found');
	}

	const sink = new EncodedPacketSink(track);

	for await (const packet of sink.packets()) {
		void packet;
	}
});

test('Takes the sizes of large RF64 chunks other than the data chunk from the ds64 table', async () => {
	// An RF64 file whose JUNK chunk in front of the format chunk is too large for a 32-bit size, so its size field is
	// 0xFFFFFFFF and its real size is in the ds64 chunk's table (EBU Tech 3306, Annex A.2). The file only holds bytes
	// at its start and end, so it's read through a custom source that makes up the rest.
	const readRf64 = async (junkSize: number) => {
		const header = new Uint8Array(68);
		const view = new DataView(header.buffer);
		const ascii = (text: string, offset: number) => header.set([...text].map(char => char.charCodeAt(0)), offset);
		const tail = new Uint8Array([
			...[0x66, 0x6d, 0x74, 0x20], 16, 0, 0, 0, // 'fmt ' chunk
			1, 0, 1, 0, 0x80, 0xbb, 0, 0, 0, 0x77, 1, 0, 2, 0, 16, 0, // PCM, mono, 48 kHz, 16-bit
			...[0x64, 0x61, 0x74, 0x61], 0xff, 0xff, 0xff, 0xff, // 'data' chunk, sized in the ds64 chunk
			1, 0, 2, 0,
		]);

		ascii('RF64', 0);
		view.setUint32(4, 0xffffffff, true);
		ascii('WAVEds64', 8);
		view.setUint32(16, 40, true); // ds64 chunk size, with one table entry
		view.setBigUint64(20, BigInt(header.length - 8 + junkSize + tail.length), true); // RIFF size
		view.setBigUint64(28, 4n, true); // Data size
		view.setBigUint64(36, 2n, true); // Sample count
		view.setUint32(44, 1, true); // Table length
		ascii('JUNK', 48);
		view.setBigUint64(52, BigInt(junkSize), true);
		ascii('JUNK', 60);
		view.setUint32(64, Math.min(junkSize, 0xffffffff), true);

		const tailStart = header.length + junkSize;
		const source = new CustomSource({
			getSize: () => tailStart + tail.length,
			read: (start, end) => {
				const result = new Uint8Array(end - start);
				for (const [offset, data] of [[0, header], [tailStart, tail]] as const) {
					const left = Math.max(start, offset);
					const right = Math.min(end, offset + data.length);
					if (right > left) {
						result.set(data.subarray(left - offset, right - offset), left - start);
					}
				}
				return result;
			},
		});

		using input = new Input({ source, formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		if (!track) {
			throw new Error('No audio track found');
		}

		const packet = await new EncodedPacketSink(track).getFirstPacket();
		return { codec: await track.getCodec(), data: packet?.data, duration: await track.computeDuration() };
	};

	const expected = { codec: 'pcm-s16', data: new Uint8Array([1, 0, 2, 0]), duration: 2 / 48000 };
	expect(await readRf64(4)).toEqual(expected);
	expect(await readRf64(2 ** 32 - 2)).toEqual(expected); // Still fits
	expect(await readRf64(2 ** 32 + 4)).toEqual(expected);
});
