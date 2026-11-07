import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

test('Classes that only Mediabunny constructs can\'t be constructed according to the declarations', () => {
	// Emits the declarations like the build does, including its declare-private-constructors step
	const outDir = path.resolve('node_modules/.cache/mediabunny-declaration-files-test');
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
	const output = execFileSync('npx', [
		'tsx', 'scripts/declare-private-constructors.ts', path.resolve('src'), path.join(outDir, 'src'),
	], { encoding: 'utf8', shell: process.platform === 'win32' });
	expect(output.trim()).toBe('Declared private constructors for InputVideoTrack, InputAudioTrack, OutputVideoTrack,'
		+ ' OutputAudioTrack, OutputSubtitleTrack, SourceRef, RangedSource, RangedTarget.');

	const consumerFile = path.join(outDir, 'consumer.ts');
	fs.writeFileSync(consumerFile, `import {
	ALL_FORMATS, BufferSource, BufferTarget, Input, InputAudioTrack, InputVideoTrack, Output, OutputAudioTrack,
	OutputSubtitleTrack, OutputVideoTrack, RangedSource, RangedTarget, SourceRef, WavOutputFormat,
} from './src/index.js';

// These all compiled before, as calls of a default constructor without parameters, and fail at runtime
// @ts-expect-error
new SourceRef();
// @ts-expect-error
new RangedSource();
// @ts-expect-error
new RangedTarget();
// @ts-expect-error
new InputVideoTrack();
// @ts-expect-error
new InputAudioTrack();
// @ts-expect-error
new OutputVideoTrack();
// @ts-expect-error
new OutputAudioTrack();
// @ts-expect-error
new OutputSubtitleTrack();

// How they're actually obtained, and instanceof, still compile
export const run = async () => {
	const source = new BufferSource(new Uint8Array(16));
	const ref: SourceRef<BufferSource> = source.ref();
	const slice: RangedSource = source.slice(0, 8);
	const input = new Input({ source, formats: ALL_FORMATS });
	const tracks = await input.getTracks();
	const video = tracks.find(track => track instanceof InputVideoTrack);
	const audio: InputAudioTrack | null = await input.getPrimaryAudioTrack();
	const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
	return [ref, slice, video, audio, output];
};
`);
	const consumer = ts.createProgram({
		rootNames: [consumerFile],
		options: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
			types: [],
			strict: true,
			skipLibCheck: true,
			noEmit: true,
		},
	});
	const diagnostics = ts.getPreEmitDiagnostics(consumer).map(diagnostic => [
		diagnostic.file ? path.relative(outDir, diagnostic.file.fileName) : '',
		ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
	].join(': '));
	expect(diagnostics).toEqual([]);
}, 60_000);
