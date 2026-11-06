import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

// Emits the declaration files the package ships and type-checks a consumer against them like a strict project does:
// skipLibCheck off and no automatically included @types packages.
const compileConsumerAgainstDeclarations = (lib: string[]) => {
	const outDir = path.resolve('node_modules/.cache/mediabunny-type-declarations-test');
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
			outDir,
			noCheck: true,
			emitDeclarationOnly: true,
			declarationMap: false,
			composite: false,
			incremental: false,
		},
	}).emit();
	expect(emitResult.emitSkipped).toBe(false);

	const consumerFile = path.join(outDir, 'consumer.ts');
	fs.writeFileSync(consumerFile, [
		`import { Input, Output, VideoSample, MediaStreamVideoTrackSource } from './src/index.js';`,
		'export const used = [Input, Output, VideoSample, MediaStreamVideoTrackSource];',
	].join('\n'));
	const consumer = ts.createProgram({
		rootNames: [consumerFile],
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
	expect(compileConsumerAgainstDeclarations(['esnext', 'dom', 'dom.iterable'])).toEqual([]);
}, 60_000);
