import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';
import ts from 'typescript';
import { expect, test } from 'vitest';

// Builds dist/mediabunny.d.ts, the declarations of the global Mediabunny namespace (for script tags), like the build
// does: the module declarations, API Extractor's rollup of them, add-global-declarations.ts and `export as namespace`
const buildGlobalDeclarations = (dir: string) => {
	const config = ts.getParsedCommandLineOfConfigFile(path.resolve('src/tsconfig.json'), {}, {
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
			throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
		},
	})!;
	const emitResult = ts.createProgram({
		rootNames: [path.resolve('src/index.ts')],
		options: {
			...config.options,
			outDir: path.join(dir, 'dist/modules'),
			noCheck: true,
			emitDeclarationOnly: true,
			declarationMap: false,
			composite: false,
			incremental: false,
		},
	}).emit();
	expect(emitResult.emitSkipped).toBe(false);

	// The repository's API Extractor config, with the paths moved to `dir` (outside node_modules, whose files API
	// Extractor treats as external packages)
	const configObject = ExtractorConfig.loadFile(path.resolve('api-extractor.json'));
	configObject.mainEntryPointFilePath = path.join(dir, 'dist/modules/src/index.d.ts');
	configObject.dtsRollup = { enabled: true, untrimmedFilePath: path.join(dir, 'dist/mediabunny.d.ts') };
	const extractorResult = Extractor.invoke(ExtractorConfig.prepare({
		configObject,
		configObjectFullPath: path.resolve('api-extractor.json'),
		packageJsonFullPath: path.resolve('package.json'),
	}), {
		messageCallback: (message) => {
			message.handled = true;
		},
	});
	expect(extractorResult.succeeded).toBe(true);

	execFileSync(process.execPath, [
		path.resolve('node_modules/tsx/dist/cli.mjs'),
		'scripts/add-global-declarations.ts',
		path.join(dir, 'dist/modules'),
		path.join(dir, 'dist/mediabunny.d.ts'),
	], { stdio: 'pipe' });
	fs.appendFileSync(path.join(dir, 'dist/mediabunny.d.ts'), 'export as namespace Mediabunny;\n');
};

test('The global namespace declarations include the global types the module declarations add', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabunny-global-declarations-'));
	try {
		buildGlobalDeclarations(dir);
		const rollup = fs.readFileSync(path.join(dir, 'dist/mediabunny.d.ts'), 'utf8');

		// Every `declare global` block of the module declarations is in it
		const normalize = (text: string) => text.replace(/\s+/g, ' ');
		const modulesDir = path.join(dir, 'dist/modules');
		const globalBlocks = fs.readdirSync(modulesDir, { recursive: true, encoding: 'utf8' })
			.filter(file => file.endsWith('.d.ts'))
			.flatMap((file) => {
				const code = fs.readFileSync(path.join(modulesDir, file), 'utf8');
				const sourceFile = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
				return sourceFile.statements
					.filter(statement => ts.isModuleDeclaration(statement)
						&& (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0)
					.map(statement => statement.getText(sourceFile));
			});
		expect(globalBlocks.length).toBeGreaterThan(0);
		for (const block of globalBlocks) {
			expect(normalize(rollup)).toContain(normalize(block));
		}

		// A script using the global namespace with the per-frame encode options that src/encode.ts declares globally
		fs.writeFileSync(path.join(dir, 'script.ts'), `/// <reference path="./dist/mediabunny.d.ts" />
const sample = new Mediabunny.VideoSample(new Uint8Array(16), {
	format: 'RGBX', codedWidth: 2, codedHeight: 2, timestamp: 0, encodeOptions: { vp9: { quantizer: 30 } },
});
sample.setEncodeOptions({ av1: { quantizer: 40 }, hevc: { quantizer: 20 } });
`);
		const program = ts.createProgram({
			rootNames: [path.join(dir, 'script.ts')],
			options: {
				target: ts.ScriptTarget.ES2022,
				lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
				types: [],
				strict: true,
				skipLibCheck: true,
				noEmit: true,
			},
		});
		const diagnostics = ts.getPreEmitDiagnostics(program)
			.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
		expect(diagnostics).toEqual([]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);
