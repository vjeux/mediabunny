/** Deterministic pseudo-random helpers for the I/O conformance suites. */

/** Mulberry32: a tiny, fast, seedable PRNG returning floats in [0, 1). */
export const createRandom = (seed: number) => {
	let state = seed | 0;

	return () => {
		state = state + 0x6d2b79f5 | 0;
		let t = Math.imul(state ^ state >>> 15, 1 | state);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
};

/** Returns `size` deterministic pseudo-random bytes. */
export const createRandomBytes = (size: number, seed: number) => {
	const random = createRandom(seed);
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		bytes[i] = (random() * 256) | 0;
	}

	return bytes;
};

/** Returns bytes where each byte equals its position modulo 256, handy for spotting offset mistakes. */
export const createRampBytes = (size: number, start = 0) => {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		bytes[i] = (start + i) & 0xff;
	}

	return bytes;
};

export const bytesEqual = (a: Uint8Array, b: Uint8Array) => {
	if (a.length !== b.length) {
		return false;
	}

	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}

	return true;
};
