import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { beforeAll, expect, test } from 'vitest';

const outDir = path.resolve('node_modules/.cache/mediabunny-type-declarations-test');

// Emits the declaration files the package ships, laid out like the package (dist/modules/src/...), next to a copy of
// types/ (the declarations package.json gives to TypeScript before 5.8)
beforeAll(() => {
	fs.rmSync(outDir, { recursive: true, force: true });

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
			outDir: path.join(outDir, 'dist/modules'),
			noCheck: true,
			emitDeclarationOnly: true,
			declarationMap: false,
			composite: false,
			incremental: false,
		},
	}).emit();
	expect(emitResult.emitSkipped).toBe(false);

	fs.cpSync('types', path.join(outDir, 'types'), { recursive: true });
}, 60_000);

// Type-checks a consumer of the declarations at `entry` like a strict project does: skipLibCheck off and no
// automatically included @types packages
const compileConsumer = (entry: string, lib: string[], extraLibFiles: string[] = []) => {
	const consumerFile = path.join(outDir, 'consumer.ts');
	fs.writeFileSync(consumerFile, [
		`import { Input, Output, VideoSample, MediaStreamVideoTrackSource } from '${entry}';`,
		'export const used = [Input, Output, VideoSample, MediaStreamVideoTrackSource];',
	].join('\n'));
	const consumer = ts.createProgram({
		rootNames: [consumerFile, ...extraLibFiles],
		options: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			lib: lib.map(name => `lib.${name}.d.ts`),
			types: [],
			strict: true,
			skipLibCheck: false,
			noEmit: true,
		},
	});

	return ts.getPreEmitDiagnostics(consumer).map(diagnostic => [
		diagnostic.file ? path.relative(outDir, diagnostic.file.fileName) : '',
		ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
	].join(': '));
};

test('Declarations compile with skipLibCheck off next to the DOM lib of the installed TypeScript', () => {
	// esnext: the declarations use the explicit resource management types (Disposable)
	expect(compileConsumer('./dist/modules/src/index.js', ['esnext', 'dom', 'dom.iterable'])).toEqual([]);
});

test('TypeScript before 5.8 gets declarations that add the ImageBufferSource type its DOM lib lacks', () => {
	const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
		exports: Record<string, Record<string, unknown>>;
		typesVersions: unknown;
	};
	expect(Object.entries(packageJson.exports['.']!)[0]).toEqual(['types@<5.8', './types/ts5.7/index.d.ts']);
	expect(packageJson.typesVersions).toEqual({
		'<5.8': { 'dist/modules/src/index.d.ts': ['types/ts5.7/index.d.ts'] },
	});

	// The installed TypeScript's DOM lib without the ImageBufferSource name stands in for the DOM lib of TypeScript 5.7
	const declaration = 'type ImageBufferSource = AllowSharedBufferSource | ReadableStream;';
	const domLib = fs.readFileSync(path.join(path.dirname(ts.getDefaultLibFilePath({})), 'lib.dom.d.ts'), 'utf8');
	expect(domLib).toContain(declaration);
	expect(fs.readFileSync('types/ts5.7/index.d.ts', 'utf8')).toContain(declaration);
	const domLibBefore58 = path.join(outDir, 'lib.dom-before-5.8.d.ts');
	fs.writeFileSync(
		domLibBefore58,
		domLib
			.replace(declaration, '')
			.replaceAll(': ImageBufferSource;', ': AllowSharedBufferSource | ReadableStream;')
			.replace(/^\/\/\/ <reference no-default-lib="true"\s*\/>$/m, ''),
	);

	// @types/dom-webcodecs, which the declarations reference, takes ImageBufferSource from the DOM lib
	expect(compileConsumer('./dist/modules/src/index.js', ['esnext'], [domLibBefore58])).toEqual([
		expect.stringMatching(/@types\/dom-webcodecs\/.*: Cannot find name 'ImageBufferSource'/),
	]);
	expect(compileConsumer('./types/ts5.7/index.js', ['esnext'], [domLibBefore58])).toEqual([]);
});
