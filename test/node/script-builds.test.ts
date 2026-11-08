import fs from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'vitest';

// Evaluates a bundle like a classic <script> would, in a fresh global scope. The bundles are built by
// `npm run pre-test`.
const runAsScript = (file: string) => {
	const context = vm.createContext({ console, TextEncoder, TextDecoder, URL, Blob, setTimeout, clearTimeout });
	vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
	return (context as { Mediabunny?: Record<string, unknown> }).Mediabunny;
};

test('Script tag builds with a .js extension define the Mediabunny global', () => {
	// The .cjs build is the same code, but it's served as application/node (jsDelivr) or application/octet-stream,
	// which browsers refuse to run in importScripts() and, with `X-Content-Type-Options: nosniff`, as a script tag
	const expectedKeys = Object.keys(runAsScript('./dist/bundles/mediabunny.cjs')!).sort();
	expect(expectedKeys).toContain('Input');

	for (const file of ['./dist/bundles/mediabunny.js', './dist/bundles/mediabunny.min.js']) {
		const global = runAsScript(file);
		expect(Object.keys(global ?? {}).sort()).toEqual(expectedKeys);
	}
});
