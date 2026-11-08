import { describe, expect, test } from 'vitest';
import { EncodedPacket, PLACEHOLDER_DATA } from '../../src/packet.js';

describe('EncodedPacket', () => {
	test('Constructor validation', () => {
		const data = new Uint8Array([1, 2, 3]);

		const invalid: (() => EncodedPacket)[] = [
			() => new EncodedPacket(new ArrayBuffer(3) as never, 'key', 0, 0),
			() => new EncodedPacket([1, 2, 3] as never, 'key', 0, 0),
			() => new EncodedPacket(data, 'keyframe' as never, 0, 0),
			() => new EncodedPacket(data, 'key', Number.NaN, 0),
			() => new EncodedPacket(data, 'key', Infinity, 0),
			() => new EncodedPacket(data, 'key', '1' as never, 0),
			() => new EncodedPacket(data, 'key', 0, -0.1),
			() => new EncodedPacket(data, 'key', 0, Infinity),
			() => new EncodedPacket(data, 'key', 0, 0, Number.NaN),
			() => new EncodedPacket(data, 'key', 0, 0, -1, -1),
			() => new EncodedPacket(data, 'key', 0, 0, -1, 1.5),
			() => new EncodedPacket(data, 'key', 0, 0, -1, undefined, null as never),
			() => new EncodedPacket(data, 'key', 0, 0, -1, undefined, { alpha: [1] as never }),
			() => new EncodedPacket(data, 'key', 0, 0, -1, undefined, { alphaByteLength: -1 }),
			() => new EncodedPacket(data, 'key', 0, 0, -1, undefined, { alphaByteLength: 0.5 }),
		];
		for (const create of invalid) {
			expect(create, create.toString()).toThrow(TypeError);
		}

		// Negative timestamps are allowed, as is a zero duration
		const packet = new EncodedPacket(data, 'delta', -0.5, 0);
		expect(packet.timestamp).toBe(-0.5);
		expect(packet.duration).toBe(0);
		expect(packet.sequenceNumber).toBe(-1);
		expect(packet.byteLength).toBe(3);
		expect(packet.sideData).toEqual({});
		expect(packet.isMetadataOnly).toBe(false);
	});

	test('Side data', () => {
		const alpha = new Uint8Array(5);
		const packet = new EncodedPacket(new Uint8Array(10), 'key', 0, 1, 7, undefined, { alpha });
		expect(packet.sideData.alpha).toBe(alpha);
		// Defaults to the size of the alpha data
		expect(packet.sideData.alphaByteLength).toBe(5);
		expect(packet.sequenceNumber).toBe(7);

		const explicit = new EncodedPacket(new Uint8Array(10), 'key', 0, 1, 7, undefined, { alphaByteLength: 5 });
		expect(explicit.sideData).toEqual({ alphaByteLength: 5 });
	});

	test('Metadata-only packets', () => {
		// Packets without their data still know their size
		const packet = new EncodedPacket(PLACEHOLDER_DATA, 'key', 1, 0.5, 3, 1234);
		expect(packet.isMetadataOnly).toBe(true);
		expect(packet.byteLength).toBe(1234);
		expect(packet.data.byteLength).toBe(0);
		expect(() => packet.toEncodedVideoChunk()).toThrow(TypeError);
		expect(() => packet.toEncodedAudioChunk()).toThrow(TypeError);

		// The size must be given
		expect(() => new EncodedPacket(PLACEHOLDER_DATA, 'key', 1, 0.5)).toThrow();

		// An empty packet with data is something else
		expect(new EncodedPacket(new Uint8Array(0), 'key', 0, 0).isMetadataOnly).toBe(false);
	});

	test('Microsecond timing', () => {
		// WebCodecs works in integer microseconds: whole microseconds stay exact despite floating point error,
		// everything else truncates towards zero
		const cases: [number, number][] = [
			[0, 0],
			[1e-6, 1],
			[0.1 + 0.2, 300_000],
			[1 / 3, 333_333],
			[2 / 3, 666_666],
			[1001 / 30000, 33_366],
			[3 * (1001 / 30000), 100_100],
			[4.0000009, 4_000_000],
			[-1 / 3, -333_333],
			[-0.000001, -1],
			[1e6 + 1e-6, 1_000_000_000_001],
		];
		for (const [seconds, microseconds] of cases) {
			const packet = new EncodedPacket(new Uint8Array(1), 'key', seconds, Math.abs(seconds));
			expect(packet.microsecondTimestamp, String(seconds)).toBe(microseconds);
			expect(packet.microsecondDuration, String(seconds)).toBe(Math.abs(microseconds));
		}

		// Every whole microsecond survives the division by one million, e.g. as done by fromEncodedChunk
		for (let microseconds = 0; microseconds < 2_000_000; microseconds += 7) {
			const packet = new EncodedPacket(new Uint8Array(1), 'key', microseconds / 1e6, 0);
			if (packet.microsecondTimestamp !== microseconds) {
				expect(packet.microsecondTimestamp).toBe(microseconds);
			}
		}

		// As do timestamps of common time bases at whole microseconds (90 kHz, 48 kHz)
		for (let ticks = 0; ticks < 9_000_000; ticks += 9) {
			const packet = new EncodedPacket(new Uint8Array(1), 'key', ticks / 90000, 0);
			if (packet.microsecondTimestamp !== ticks / 9 * 100) {
				expect(packet.microsecondTimestamp).toBe(ticks / 9 * 100);
			}
		}
		for (let samples = 0; samples < 4_800_000; samples += 6) {
			const packet = new EncodedPacket(new Uint8Array(1), 'key', samples / 48000, 0);
			if (packet.microsecondTimestamp !== samples / 6 * 125) {
				expect(packet.microsecondTimestamp).toBe(samples / 6 * 125);
			}
		}
	});

	test('Cloning', () => {
		const alpha = new Uint8Array([9, 9]);
		const packet = new EncodedPacket(new Uint8Array([1, 2, 3]), 'key', 1, 0.5, 4, undefined, { alpha });

		const copy = packet.clone();
		expect(copy).not.toBe(packet);
		expect(copy.data).toBe(packet.data);
		expect(copy.type).toBe('key');
		expect(copy.timestamp).toBe(1);
		expect(copy.duration).toBe(0.5);
		expect(copy.sequenceNumber).toBe(4);
		expect(copy.byteLength).toBe(3);
		expect(copy.sideData).toEqual({ alpha, alphaByteLength: 2 });

		const changed = packet.clone({ type: 'delta', timestamp: 2, duration: 0.25, sequenceNumber: 5, sideData: {} });
		expect(changed.type).toBe('delta');
		expect(changed.timestamp).toBe(2);
		expect(changed.duration).toBe(0.25);
		expect(changed.sequenceNumber).toBe(5);
		expect(changed.sideData).toEqual({});
		expect(changed.data).toBe(packet.data);
		// The original is untouched
		expect(packet.type).toBe('key');
		expect(packet.timestamp).toBe(1);

		const newData = new Uint8Array([7, 7, 7, 7]);
		expect(packet.clone({ data: newData }).data).toBe(newData);

		// Metadata-only packets stay metadata-only
		const metadataOnly = new EncodedPacket(PLACEHOLDER_DATA, 'delta', 0, 0, -1, 100);
		expect(metadataOnly.clone({ timestamp: 3 }).isMetadataOnly).toBe(true);
		expect(metadataOnly.clone({ timestamp: 3 }).byteLength).toBe(100);

		const invalid: unknown[] = [
			'options',
			null,
			{ data: [1, 2] },
			{ type: 'intra' },
			{ timestamp: Number.NaN },
			{ duration: Infinity },
			{ duration: -1 },
			{ sequenceNumber: Infinity },
			{ sideData: 'alpha' },
			{ sideData: null },
		];
		for (const options of invalid) {
			expect(() => packet.clone(options as never), JSON.stringify(options)).toThrow(TypeError);
		}
	});

	test('Chunk conversion without WebCodecs', () => {
		const packet = new EncodedPacket(new Uint8Array(1), 'key', 0, 0);
		expect(() => packet.toEncodedVideoChunk()).toThrow(Error);
		expect(() => packet.toEncodedAudioChunk()).toThrow(Error);
		// No alpha
		expect(() => packet.alphaToEncodedVideoChunk()).toThrow(TypeError);
	});
});
