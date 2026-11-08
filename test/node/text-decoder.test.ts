import { expect, test, vi } from 'vitest';

test('The TextDecoder fallback decodes malformed UTF-16 like the native decoder', async () => {
	// The fallback is only used where no native TextDecoder exists
	vi.stubGlobal('TextDecoder', undefined);
	vi.resetModules();
	const { TextDecoder: FallbackTextDecoder } = await import('../../src/misc.js');
	vi.unstubAllGlobals();
	expect(FallbackTextDecoder).not.toBe(globalThis.TextDecoder);

	const cases: [string, number[]][] = [
		['utf-16le', [0x00, 0xd8, 0x41]], // A lead surrogate, then a dangling odd byte
		['utf-16le', [0x3d, 0xd8, 0xdf, 0xd8, 0xff]],
		['utf-16le', [0x00, 0xd8]],
		['utf-16be', [0xd8, 0x00, 0xfe]],
		['utf-16be', [0x00, 0x41, 0xdb, 0xff, 0xdc]],
	];
	for (const [encoding, bytes] of cases) {
		const expected = new globalThis.TextDecoder(encoding).decode(new Uint8Array(bytes));
		const actual = new FallbackTextDecoder(encoding).decode(new Uint8Array(bytes));
		expect(actual, `${encoding} ${bytes.join(' ')}`).toBe(expected);
	}
});
