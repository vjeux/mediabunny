import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, type Rollup } from 'vite';
import { expect, test } from 'vitest';

// Bundles an app that only imports Input from 'mediabunny' with Vite (Rollup), which applies the package's
// "sideEffects" field. The package is a copy of the sources with the published package.json's resolution fields.
const bundleAppImportingInput = async () => {
	const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
		sideEffects: boolean | string[];
		browser: Record<string, string | false>;
	};
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabunny-side-effects-'));
	try {
		const packageDir = path.join(dir, 'node_modules', 'mediabunny');
		fs.cpSync('src', path.join(packageDir, 'src'), { recursive: true });
		fs.cpSync('shared', path.join(packageDir, 'shared'), { recursive: true });
		fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
			name: 'mediabunny',
			type: 'module',
			exports: './src/index.ts',
			sideEffects: packageJson.sideEffects,
			browser: packageJson.browser,
		}));
		const entry = path.join(dir, 'app.js');
		fs.writeFileSync(entry, `import { Input } from 'mediabunny';\nglobalThis.input = Input;\n`);

		const result = await build({
			configFile: false,
			root: dir,
			logLevel: 'silent',
			build: { write: false, minify: false, lib: { entry, formats: ['es'], fileName: 'app' } },
		}) as Rollup.RollupOutput[];
		return result[0]!.output[0].code;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
};

test('Bundlers keep the warning about Mediabunny being loaded twice', async () => {
	const code = await bundleAppImportingInput();
	expect(code).toContain('class Input');
	expect(code).toContain('Mediabunny was loaded twice');
	// Tree shaking still drops what the app doesn't use
	expect(code).not.toContain('class Output');
	expect(code).not.toContain('class Conversion');
}, 60_000);
