import { expect, test, vi } from 'vitest';
import { CustomSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input, InputDisposedError } from '../../src/input.js';
import { ALL_FORMATS, MP4 } from '../../src/input-format.js';
import { promiseWithResolvers } from '../../src/misc.js';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import ts from 'typescript';
import { setImmediate } from 'node:timers/promises';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Direct source disposal', async () => {
	const filePath = path.join(__dirname, '../public/video.mp4');
	const source = new FilePathSource(filePath);

	expect(!source._disposed);

	const ref = source.ref();
	ref.free();
	expect(source._disposed);
});

test('Implicit source disposal', async () => {
	const filePath = path.join(__dirname, '../public/video.mp4');
	const source = new FilePathSource(filePath);

	const input = new Input({
		source,
		formats: ALL_FORMATS,
	});
	expect(await input.getFormat()).toBe(MP4);

	expect(!source._disposed);
	input.dispose();
	expect(source._disposed);
});

test('Implicit source disposal, double input', async () => {
	const filePath = path.join(__dirname, '../public/video.mp4');
	const source = new FilePathSource(filePath);

	const input1 = new Input({
		source,
		formats: ALL_FORMATS,
	});
	const input2 = new Input({
		source,
		formats: ALL_FORMATS,
	});

	expect(await input1.getFormat()).toBe(MP4);
	expect(await input2.getFormat()).toBe(MP4);

	expect(!source._disposed);
	input1.dispose();
	expect(!source._disposed);
	input2.dispose();
	expect(source._disposed);
});

test.each([
	{ delayed: false, cancelRejects: false },
	{ delayed: false, cancelRejects: true },
	{ delayed: true, cancelRejects: false },
	{ delayed: true, cancelRejects: true },
])('CustomSource disposal (delayed=$delayed, rejects=$cancelRejects)', async ({ delayed, cancelRejects }) => {
	const started = promiseWithResolvers();
	const readResult = promiseWithResolvers<ReadableStream<Uint8Array>>();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const cancel = vi.fn(() => {
		if (cancelRejects) {
			throw new Error('Cancel failed');
		}
	});
	const stream = new ReadableStream<Uint8Array>({
		start(value) { controller = value; },
		pull() { started.resolve(); },
		cancel,
	}, { highWaterMark: 0 });
	const dispose = vi.fn();
	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomSource({
			getSize: () => 1024,
			read: () => {
				if (delayed) {
					started.resolve();
					return readResult.promise;
				}
				return stream;
			},
			dispose,
		}),
	});
	const result = input.getFormat().catch((error: unknown) => error);
	await started.promise;
	input.dispose();
	readResult.resolve(stream);
	try {
		expect(await result).toBeInstanceOf(InputDisposedError);
		await setImmediate();
		expect(dispose).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
		expect(stream.locked).toBe(false);
	} finally {
		if (cancel.mock.calls.length === 0) {
			controller.close();
		}
	}
});

test('CustomSource releases stream readers after successful reads', async () => {
	const bytes = await readFile(path.join(__dirname, '../public/video.mp4'));
	const streams: ReadableStream<Uint8Array>[] = [];
	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomSource({
			getSize: () => bytes.length,
			read: (start, end) => {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes.subarray(start, end));
						controller.close();
					},
				});
				streams.push(stream);
				return stream;
			},
		}),
	});
	expect(await input.getFormat()).toBe(MP4);
	expect(streams.length).toBeGreaterThan(0);
	expect(streams.every(stream => !stream.locked)).toBe(true);
});

test('CustomSource releases stream readers after read errors', async () => {
	const error = new Error('Read failed');
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) { controller.error(error); },
	});
	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomSource({ getSize: () => 1024, read: () => stream }),
	});
	await expect(input.getFormat()).rejects.toBe(error);
	expect(stream.locked).toBe(false);
});

test('Declarations of the disposable classes compile without TypeScript\'s esnext lib', () => {
	// Emits the declaration files the package ships and type-checks a consumer against them with skipLibCheck off and
	// the ES2022 lib, which has no Disposable or Symbol.dispose
	const outDir = path.join(__dirname, '../../node_modules/.cache/mediabunny-disposable-declarations-test');
	fs.rmSync(outDir, { recursive: true, force: true });
	const config = ts.getParsedCommandLineOfConfigFile(path.join(__dirname, '../../src/tsconfig.json'), {}, {
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: () => {},
	})!;
	ts.createProgram({
		rootNames: [path.join(__dirname, '../../src/index.ts')],
		options: {
			...config.options, outDir, noCheck: true, emitDeclarationOnly: true, composite: false, incremental: false,
		},
	}).emit();

	const consumerFile = path.join(outDir, 'consumer.ts');
	fs.writeFileSync(consumerFile, [
		`import { Input, SourceRef, VideoSample, AudioSample } from './src/index.js';`,
		'export const used = [Input, SourceRef, VideoSample, AudioSample];',
	].join('\n'));
	const consumer = ts.createProgram({
		rootNames: [consumerFile],
		options: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
			types: [],
			strict: true,
			skipLibCheck: false,
			noEmit: true,
		},
	});
	const errorsInOwnDeclarations = ts.getPreEmitDiagnostics(consumer)
		.filter((diagnostic) => {
			// TypeScript's file names use / on every platform
			const file = diagnostic.file && path.relative(outDir, diagnostic.file.fileName).split(path.sep).join('/');
			return file?.startsWith('src/');
		})
		.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
	expect(errorsInOwnDeclarations).toEqual([]);
}, 60_000);
