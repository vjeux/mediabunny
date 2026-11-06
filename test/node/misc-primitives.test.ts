import { describe, expect, test, vi } from 'vitest';
import { Bitstream } from '../../shared/bitstream.js';
import {
	AsyncMutex,
	base64ToBytes,
	binarySearchExact,
	binarySearchLessOrEqual,
	bytesToBase64,
	bytesToHexString,
	clamp,
	computeRationalApproximation,
	EventEmitter,
	floorToMultiple,
	getInt24,
	getQueryParameter,
	getUint24,
	hexStringToBytes,
	insertSorted,
	isIso639Dash2LanguageCode,
	centeredTransformationMatrix,
	composeRotationAndFlip,
	extractRotationFromMatrix,
	IDENTITY_MATRIX,
	matrixIsFlipped,
	modEuclid,
	multiplyMatrices,
	normalizeRotation,
	popcount,
	reverseBitsU32,
	Rotation,
	rotationMatrix,
	scaleMatrix,
	readExpGolomb,
	readSignedExpGolomb,
	roundIfAlmostInteger,
	roundToDivisor,
	roundToMultiple,
	setInt24,
	setUint24,
	simplifyRational,
	toDataView,
	toUint8Array,
	writeExpGolomb,
} from '../../src/misc.js';
import { Logging, LogLevel } from '../../src/index.js';
import { createRandom, createRandomBytes } from './helpers/io-random.js';

/** Reference bit reader using BigInt arithmetic; results stay BigInt so that wide reads compare exactly. */
const referenceReadBits = (bytes: Uint8Array, bitOffset: number, width: number) => {
	let value = 0n;
	for (let i = 0; i < width; i++) {
		const position = bitOffset + i;
		const byte = bytes[position >> 3] ?? 0;
		const bit = (byte >> (7 - (position & 7))) & 1;
		value = (value << 1n) | BigInt(bit);
	}
	return value;
};

describe('Bitstream', () => {
	test('reads fields of 1 to 31 bits at any bit offset, matching a reference reader', () => {
		const bytes = createRandomBytes(256, 21);
		const random = createRandom(22);

		for (let i = 0; i < 2000; i++) {
			const width = 1 + ((random() * 31) | 0);
			const offset = (random() * (bytes.length * 8 - width)) | 0;
			const bitstream = new Bitstream(bytes);
			bitstream.skipBits(offset);
			expect(BigInt(bitstream.readBits(width))).toBe(referenceReadBits(bytes, offset, width));
			expect(bitstream.pos).toBe(offset + width);
		}
	});

	test('reads zeros past the end of its data', () => {
		const bitstream = new Bitstream(new Uint8Array([0xff]));
		expect(bitstream.readBits(8)).toBe(0xff);
		expect(bitstream.readBits(8)).toBe(0);
		expect(bitstream.getBitsLeft()).toBe(-8);
	});

	test('writes fields of 1 to 31 bits at any bit offset without touching neighboring bits', () => {
		const random = createRandom(23);

		for (let i = 0; i < 2000; i++) {
			const bytes = createRandomBytes(16, i);
			const original = bytes.slice();
			const width = 1 + ((random() * 31) | 0);
			const offset = (random() * (bytes.length * 8 - width)) | 0;
			const value = Math.floor(random() * 2 ** width);

			const bitstream = new Bitstream(bytes);
			bitstream.skipBits(offset);
			bitstream.writeBits(width, value);

			expect(referenceReadBits(bytes, offset, width)).toBe(BigInt(value));
			expect(referenceReadBits(bytes, 0, offset)).toBe(referenceReadBits(original, 0, offset));
			const after = bytes.length * 8 - offset - width;
			const end = offset + width;
			expect(referenceReadBits(bytes, end, after)).toBe(referenceReadBits(original, end, after));
		}
	});

	test('copies bits between streams', () => {
		const source = new Bitstream(new Uint8Array([0b10110011, 0b01010101, 0b11110000]));
		source.skipBits(3);
		const target = new Bitstream(new Uint8Array(3));
		target.skipBits(5);
		target.copyBits(13, source);
		expect(referenceReadBits(target.bytes, 5, 13)).toBe(referenceReadBits(source.bytes, 3, 13));
	});

	test('readAlignedByte requires byte alignment', () => {
		const bitstream = new Bitstream(new Uint8Array([1, 2]));
		expect(bitstream.readAlignedByte()).toBe(1);
		bitstream.skipBits(1);
		expect(() => bitstream.readAlignedByte()).toThrow('Bitstream is not byte-aligned.');
	});
});

describe('Exponential-Golomb codes', () => {
	test('round-trip unsigned values up to 2^30', () => {
		const values = [0, 1, 2, 3, 6, 7, 254, 255, 256, 65535, 65536, 2 ** 20 - 1, 2 ** 30 - 1, 2 ** 30];
		const random = createRandom(24);
		for (let i = 0; i < 500; i++) {
			values.push(Math.floor(random() * 2 ** (1 + random() * 29)));
		}

		const bytes = new Uint8Array(values.length * 8);
		const writer = new Bitstream(bytes);
		for (const value of values) {
			writeExpGolomb(writer, value);
		}

		const reader = new Bitstream(bytes);
		for (const value of values) {
			expect(readExpGolomb(reader)).toBe(value);
		}
		expect(reader.pos).toBe(writer.pos);
	});

	test('encodes the H.264 table 9-2 bit strings', () => {
		const encode = (value: number) => {
			const bitstream = new Bitstream(new Uint8Array(8));
			writeExpGolomb(bitstream, value);
			return referenceReadBits(bitstream.bytes, 0, bitstream.pos).toString(2).padStart(bitstream.pos, '0');
		};
		expect(encode(0)).toBe('1');
		expect(encode(1)).toBe('010');
		expect(encode(2)).toBe('011');
		expect(encode(3)).toBe('00100');
		expect(encode(6)).toBe('00111');
		expect(encode(7)).toBe('0001000');
	});

	test('maps signed values like se(v)', () => {
		const bytes = new Uint8Array(16);
		const writer = new Bitstream(bytes);
		for (const codeNum of [0, 1, 2, 3, 4, 5, 6]) {
			writeExpGolomb(writer, codeNum);
		}
		const reader = new Bitstream(bytes);
		const decoded = [0, 1, 2, 3, 4, 5, 6].map(() => readSignedExpGolomb(reader));
		expect(decoded.map(x => x + 0)).toEqual([0, 1, -1, 2, -2, 3, -3]);
	});

	test('rejects codes with 32 or more leading zeros', () => {
		expect(() => readExpGolomb(new Bitstream(new Uint8Array(8)))).toThrow('Invalid exponential-Golomb code.');
	});
});

describe('Binary search helpers', () => {
	const linearLessOrEqual = (array: number[], key: number) => {
		let result = -1;
		for (let i = 0; i < array.length; i++) {
			if (array[i]! <= key) {
				result = i;
			}
		}
		return result;
	};
	const linearExact = (array: number[], key: number) => array.indexOf(key);

	test('match linear searches on sorted arrays with duplicates', () => {
		const random = createRandom(25);
		for (let i = 0; i < 300; i++) {
			const length = (random() * 40) | 0;
			const array = Array.from({ length }, () => (random() * 20) | 0).sort((a, b) => a - b);
			for (let key = -2; key < 23; key++) {
				expect(binarySearchLessOrEqual(array, key, x => x)).toBe(linearLessOrEqual(array, key));
				expect(binarySearchExact(array, key, x => x)).toBe(linearExact(array, key));
			}
		}
	});

	test('insertSorted keeps the array sorted and inserts after equal keys', () => {
		const array = [{ key: 1, id: 'a' }, { key: 3, id: 'b' }];
		insertSorted(array, { key: 3, id: 'c' }, x => x.key);
		insertSorted(array, { key: 0, id: 'd' }, x => x.key);
		insertSorted(array, { key: 2, id: 'e' }, x => x.key);
		expect(array.map(x => x.id)).toEqual(['d', 'a', 'e', 'b', 'c']);
	});
});

describe('Rational helpers', () => {
	test('simplifyRational reduces by the greatest common divisor', () => {
		expect(simplifyRational({ num: 6, den: 4 })).toEqual({ num: 3, den: 2 });
		expect(simplifyRational({ num: -6, den: 4 })).toEqual({ num: -3, den: 2 });
		expect(simplifyRational({ num: 0, den: 5 })).toEqual({ num: 0, den: 1 });
		expect(simplifyRational({ num: 30000, den: 1001 })).toEqual({ num: 30000, den: 1001 });
		expect(() => simplifyRational({ num: 1, den: 0 })).toThrow();
		expect(() => simplifyRational({ num: 1.5, den: 2 })).toThrow();
	});

	test('computeRationalApproximation finds exact fractions and good approximations', () => {
		expect(computeRationalApproximation(30000 / 1001, 1001)).toEqual({ num: 30000, den: 1001 });
		expect(computeRationalApproximation(24000 / 1001, 2000)).toEqual({ num: 24000, den: 1001 });
		expect(computeRationalApproximation(0.5, 10)).toEqual({ num: 1, den: 2 });
		expect(computeRationalApproximation(-0.75, 10)).toEqual({ num: -3, den: 4 });
		expect(computeRationalApproximation(25, 1)).toEqual({ num: 25, den: 1 });
		expect(computeRationalApproximation(0, 100)).toEqual({ num: 0, den: 1 });
		expect(computeRationalApproximation(Math.PI, 10)).toEqual({ num: 22, den: 7 });
		expect(computeRationalApproximation(Math.PI, 200)).toEqual({ num: 355, den: 113 });

		const random = createRandom(26);
		for (let i = 0; i < 500; i++) {
			const den = 1 + ((random() * 999) | 0);
			const num = (random() * 100_000) | 0;
			const result = computeRationalApproximation(num / den, 1000);
			const simplified = simplifyRational({ num, den });
			expect(result).toEqual(simplified);
		}
	});
});

describe('Numeric helpers', () => {
	test('rounding helpers', () => {
		expect(roundIfAlmostInteger(2.9999999999999996)).toBe(3);
		expect(roundIfAlmostInteger(2.5)).toBe(2.5);
		expect(roundIfAlmostInteger(0)).toBe(0);
		expect(roundToMultiple(7, 3)).toBe(6);
		expect(roundToMultiple(8, 3)).toBe(9);
		expect(floorToMultiple(8.9, 3)).toBe(6);
		expect(roundToDivisor(0.123456, 1000)).toBe(0.123);
		expect(clamp(5, 0, 3)).toBe(3);
		expect(clamp(-1, 0, 3)).toBe(0);
		expect(modEuclid(-1, 4)).toBe(3);
		expect(modEuclid(5, 4)).toBe(1);
	});

	test('normalizeRotation maps to 0/90/180/270 and rejects other angles', () => {
		expect(normalizeRotation(-90)).toBe(270);
		expect(normalizeRotation(450)).toBe(90);
		expect(normalizeRotation(-720)).toBe(0);
		expect(() => normalizeRotation(45)).toThrow('Invalid rotation 45.');
	});

	test('24-bit integer accessors in both byte orders', () => {
		const view = new DataView(new ArrayBuffer(6));
		setUint24(view, 0, 0x123456, false);
		setUint24(view, 3, 0x123456, true);
		expect([...new Uint8Array(view.buffer)]).toEqual([0x12, 0x34, 0x56, 0x56, 0x34, 0x12]);
		expect(getUint24(view, 0, false)).toBe(0x123456);
		expect(getUint24(view, 3, true)).toBe(0x123456);

		setInt24(view, 0, -2, false);
		expect(getInt24(view, 0, false)).toBe(-2);
		expect(getUint24(view, 0, false)).toBe(0xfffffe);
		setInt24(view, 3, -9_000_000, true); // Clamped to the 24-bit range
		expect(getInt24(view, 3, true)).toBe(-8_388_608);
		setInt24(view, 3, 9_000_000, true);
		expect(getInt24(view, 3, true)).toBe(8_388_607);
	});
});

describe('Rotation matrices', () => {
	const ROTATIONS: Rotation[] = [0, 90, 180, 270];
	// "Rotate, then maybe flip horizontally"; points are row vectors, so the left factor applies first
	const transform = (rotation: Rotation, flip: boolean) => {
		return multiplyMatrices(rotationMatrix(rotation), flip ? scaleMatrix(-1, 1) : IDENTITY_MATRIX);
	};

	test('extracting the rotation and flip inverts building the matrix', () => {
		for (const rotation of ROTATIONS) {
			for (const flip of [false, true]) {
				expect(extractRotationFromMatrix(transform(rotation, flip))).toBe(rotation);
				expect(matrixIsFlipped(transform(rotation, flip))).toBe(flip);
			}
		}
	});

	test('composeRotationAndFlip matches multiplying the matrices', () => {
		const cases = ROTATIONS.flatMap(rotation => [{ rotation, flip: false }, { rotation, flip: true }]);
		for (const first of cases) {
			for (const second of cases) {
				const matrix = multiplyMatrices(
					transform(first.rotation, first.flip),
					transform(second.rotation, second.flip),
				);
				expect(composeRotationAndFlip(first.rotation, first.flip, second.rotation, second.flip)).toEqual({
					rotation: extractRotationFromMatrix(matrix),
					flip: matrixIsFlipped(matrix),
				});
			}
		}
	});

	test('centeredTransformationMatrix keeps the frame in the positive quadrant', () => {
		for (const rotation of ROTATIONS) {
			for (const flip of [false, true]) {
				const [a, b, , c, d, , x, y] = centeredTransformationMatrix(transform(rotation, flip), 100, 50);
				const corners = [[0, 0], [100, 0], [0, 50], [100, 50]]
					.map(([u, v]) => [u! * a + v! * c + x, u! * b + v! * d + y]);
				const swapped = rotation % 180 !== 0;
				expect(Math.min(...corners.map(p => p[0]!))).toBeCloseTo(0, 9);
				expect(Math.min(...corners.map(p => p[1]!))).toBeCloseTo(0, 9);
				expect(Math.max(...corners.map(p => p[0]!))).toBeCloseTo(swapped ? 50 : 100, 9);
				expect(Math.max(...corners.map(p => p[1]!))).toBeCloseTo(swapped ? 100 : 50, 9);
			}
		}
	});
});

describe('Byte helpers', () => {
	test('bit counting and reversal', () => {
		expect(popcount(0)).toBe(0);
		expect(popcount(0b1011)).toBe(3);
		expect(popcount(0xffffffff)).toBe(32);
		expect(reverseBitsU32(1)).toBe(0x80000000);
		expect(reverseBitsU32(0x12345678)).toBe(0x1e6a2c48);
		expect(reverseBitsU32(reverseBitsU32(0xdeadbeef))).toBe(0xdeadbeef);
	});

	test('toUint8Array and toDataView keep the byte window of views', () => {
		const buffer = new ArrayBuffer(16);
		const view = new Uint16Array(buffer, 4, 3);
		const bytes = toUint8Array(view);
		expect(bytes.byteOffset).toBe(4);
		expect(bytes.byteLength).toBe(6);
		expect(bytes.constructor).toBe(Uint8Array);

		const dataView = toDataView(new Uint8Array(buffer, 2, 5));
		expect(dataView.byteOffset).toBe(2);
		expect(dataView.byteLength).toBe(5);

		const nodeBuffer = Buffer.from([1, 2, 3]);
		expect(toUint8Array(nodeBuffer).constructor).toBe(Uint8Array); // Not a Buffer anymore
		expect([...toUint8Array(nodeBuffer)]).toEqual([1, 2, 3]);
	});

	test('base64 conversion matches Node.js', () => {
		const random = createRandom(27);
		for (let i = 0; i < 100; i++) {
			const bytes = createRandomBytes((random() * 300) | 0, i);
			const base64 = bytesToBase64(bytes);
			expect(base64).toBe(Buffer.from(bytes).toString('base64'));
			expect(base64ToBytes(base64)).toEqual(bytes);
		}
		expect(() => base64ToBytes('not base64!')).toThrow('Invalid base64 string.');
	});

	test('hex conversion round-trips', () => {
		const bytes = createRandomBytes(64, 28);
		const hex = bytesToHexString(bytes);
		expect(hex).toBe(Buffer.from(bytes).toString('hex'));
		expect(hexStringToBytes(hex)).toEqual(bytes);
		expect(hexStringToBytes('00FFa0')).toEqual(new Uint8Array([0, 255, 160]));
	});
});

describe('String helpers', () => {
	test('isIso639Dash2LanguageCode accepts three lowercase letters only', () => {
		expect(isIso639Dash2LanguageCode('eng')).toBe(true);
		expect(isIso639Dash2LanguageCode('und')).toBe(true);
		expect(isIso639Dash2LanguageCode('ENG')).toBe(false);
		expect(isIso639Dash2LanguageCode('en')).toBe(false);
		expect(isIso639Dash2LanguageCode('en-US')).toBe(false);
	});

	test('getQueryParameter decodes values and ignores the fragment', () => {
		expect(getQueryParameter('/a.m3u8?token=abc%20123&x=1', 'token')).toBe('abc 123');
		expect(getQueryParameter('/a.m3u8?x=1&flag', 'flag')).toBe('');
		expect(getQueryParameter('/a.m3u8?x=1#token=2', 'token')).toBeNull();
		expect(getQueryParameter('/a.m3u8', 'x')).toBeNull();
		expect(getQueryParameter('/a.m3u8?bad=%E0%A4%A&x=2', 'x')).toBe('2');
	});
});

describe('EventEmitter', () => {
	test('calls listeners in registration order until they are removed', () => {
		const emitter = new EventEmitter<{ tick: number }>();
		const calls: string[] = [];
		const removeA = emitter.on('tick', value => calls.push(`a${value}`));
		emitter.on('tick', value => calls.push(`b${value}`));
		emitter.on('tick', value => calls.push(`once${value}`), { once: true });

		emitter._emit('tick', 1);
		removeA();
		removeA(); // Removing twice is harmless
		emitter._emit('tick', 2);

		expect(calls).toEqual(['a1', 'b1', 'once1', 'b2']);
	});

	test('keeps calling other listeners when one throws, logging the error', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const emitter = new EventEmitter<{ tick: void }>();
		const error = new Error('Listener failed');
		const after = vi.fn();
		emitter.on('tick', () => {
			throw error;
		}, { once: true });
		emitter.on('tick', after);

		emitter._emit('tick');
		emitter._emit('tick');

		expect(after).toHaveBeenCalledTimes(2);
		expect(consoleError).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalledWith(error);
	});

	test('emitting an event without listeners is a no-op', () => {
		const emitter = new EventEmitter<{ tick: void }>();
		expect(() => emitter._emit('tick')).not.toThrow();
	});
});

describe('AsyncMutex', () => {
	test('hands out the lock in request order', async () => {
		const mutex = new AsyncMutex();
		const order: number[] = [];
		await Promise.all([0, 1, 2, 3].map(async (i) => {
			const release = await mutex.acquire();
			order.push(i);
			await new Promise(resolve => setTimeout(resolve, 3 - i));
			release();
			release(); // Releasing twice is harmless
		}));
		expect(order).toEqual([0, 1, 2, 3]);
		expect(mutex.pending).toBe(0);
	});
});

describe('Logging', () => {
	test('validates the level', () => {
		expect(() => {
			Logging.level = 7 as LogLevel;
		}).toThrow(new TypeError('Invalid log level. Use one of the values of the LogLevel enum.'));
	});

	test('emits every log event, but prints only those at or above the level', () => {
		const previous = Logging.level;
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
		const events: [string, unknown[]][] = [];
		const kinds = ['error', 'warn', 'info'] as const;
		const removers = kinds.map(kind => Logging.on(kind, args => events.push([kind, args])));

		try {
			Logging.level = LogLevel.Warnings;
			Logging._error('e', 1);
			Logging._warn('w');
			Logging._info('i');

			expect(events).toEqual([['error', ['e', 1]], ['warn', ['w']], ['info', ['i']]]);
			expect(consoleError).toHaveBeenCalledWith('e', 1);
			expect(consoleWarn).toHaveBeenCalledWith('w');
			expect(consoleInfo).not.toHaveBeenCalled();

			Logging.level = LogLevel.Silent;
			Logging._error('quiet');
			expect(consoleError).toHaveBeenCalledTimes(1);
			expect(events).toHaveLength(4);
		} finally {
			removers.forEach(remove => remove());
			Logging.level = previous;
		}
	});
});

describe('TextDecoder and TextEncoder fallbacks', () => {
	test('decode random UTF-8 like the native TextDecoder and encode like the native TextEncoder', async () => {
		const NativeDecoder = globalThis.TextDecoder;
		const NativeEncoder = globalThis.TextEncoder;
		vi.stubGlobal('TextDecoder', undefined);
		vi.stubGlobal('TextEncoder', undefined);
		vi.resetModules();
		const fallbacks = await import('../../src/misc.js');
		vi.unstubAllGlobals();

		expect(fallbacks.TextDecoder).not.toBe(NativeDecoder);
		expect(fallbacks.TextEncoder).not.toBe(NativeEncoder);

		const nativeDecoder = new NativeDecoder();
		const fallbackDecoder = new fallbacks.TextDecoder();
		const interesting = [0x00, 0x41, 0x7f, 0x80, 0xbf, 0xc0, 0xc2, 0xdf, 0xe0, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xff];
		const random = createRandom(29);
		for (let i = 0; i < 20_000; i++) {
			const bytes = new Uint8Array((random() * 8) | 0);
			for (let k = 0; k < bytes.length; k++) {
				bytes[k] = random() < 0.8 ? interesting[(random() * interesting.length) | 0]! : (random() * 256) | 0;
			}
			expect(fallbackDecoder.decode(bytes)).toBe(nativeDecoder.decode(bytes));
		}

		const nativeEncoder = new NativeEncoder();
		const fallbackEncoder = new fallbacks.TextEncoder();
		for (let i = 0; i < 5_000; i++) {
			let text = '';
			for (let k = (random() * 6) | 0; k > 0; k--) {
				const roll = random();
				text += String.fromCharCode(
					roll < 0.3
						? 0xd800 + ((random() * 0x800) | 0) // Surrogates, paired or not
						: roll < 0.6 ? (random() * 0x80) | 0 : (random() * 0x10000) | 0,
				);
			}
			expect(fallbackEncoder.encode(text)).toEqual(nativeEncoder.encode(text));
		}
	});
});
