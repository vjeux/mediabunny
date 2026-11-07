import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as esbuild from 'esbuild';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Mediabunny from '../../src/index.js';

// How users consume the packages: package manifests, the bundles (npm, script tags), Node's own module resolution,
// tree shaking, and, behind MEDIABUNNY_TEST_PACKAGING=1 (after `npm run build`), the npm-packed packages in a consumer
// project with Node (ESM and CommonJS), TypeScript and a bundler.

const root = process.cwd();
const packageDirs = ['.', ...fs.readdirSync('packages').map(name => `packages/${name}`)];

type PackageJson = {
	name: string;
	version: string;
	main?: string;
	module?: string;
	types?: string;
	exports?: unknown;
	files: string[];
	browser?: Record<string, string | false>;
	sideEffects?: boolean | string[];
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

const readPackageJson = (dir: string) => {
	return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as PackageJson;
};

/** All file paths an entry field or the "exports" conditions point to. */
const entryPaths = (pkg: PackageJson) => {
	const paths = [pkg.main, pkg.module, pkg.types].filter((x): x is string => typeof x === 'string');
	const walk = (value: unknown) => {
		if (typeof value === 'string') {
			paths.push(value);
		} else if (value && typeof value === 'object') {
			Object.values(value).forEach(walk);
		}
	};
	walk(pkg.exports);
	return [...new Set(paths)];
};

const runNode = (args: string[], cwd = root) => execFileSync(process.execPath, args, {
	cwd,
	encoding: 'utf8',
	timeout: 120_000,
	maxBuffer: 64 * 1024 * 1024,
});

/** Evaluates bundles like classic <script>s would, one after the other, in a fresh global scope with nothing in it. */
const runScripts = (files: string[]) => {
	const context = vm.createContext({});
	for (const file of files) {
		vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
	}
	return context as Record<string, Record<string, unknown> | undefined>;
};

const coreExportNames = Object.keys(Mediabunny).sort();

type Extension = { dir: string; global: string; exports: string[]; encodes: string[]; decodes: string[] };

const EXTENSIONS: Extension[] = [
	{
		dir: 'mp3-encoder', global: 'MediabunnyMp3Encoder', exports: ['registerMp3Encoder'],
		encodes: ['mp3'], decodes: [],
	},
	{
		dir: 'aac-encoder', global: 'MediabunnyAacEncoder', exports: ['registerAacEncoder'],
		encodes: ['aac'], decodes: [],
	},
	{
		dir: 'flac-encoder', global: 'MediabunnyFlacEncoder', exports: ['registerFlacEncoder'],
		encodes: ['flac'], decodes: [],
	},
	{
		dir: 'ac3', global: 'MediabunnyAc3', exports: ['registerAc3Decoder', 'registerAc3Encoder'],
		encodes: ['ac3', 'eac3'], decodes: ['ac3', 'eac3'],
	},
	{
		dir: 'dts', global: 'MediabunnyDts', exports: ['registerDtsDecoder', 'registerDtsEncoder'],
		encodes: ['dts'], decodes: ['dts'],
	},
	{
		dir: 'truehd', global: 'MediabunnyTrueHd', exports: ['registerTrueHdDecoder', 'registerTrueHdEncoder'],
		encodes: ['truehd'], decodes: ['truehd'],
	},
	{
		dir: 'prores', global: 'MediabunnyProres', exports: ['registerProresDecoder'],
		encodes: [], decodes: ['prores'],
	},
];

describe('Package manifests', () => {
	test('Every entry point is a shipped file, with the types conditions first', () => {
		for (const dir of packageDirs) {
			const pkg = readPackageJson(dir);
			for (const entry of entryPaths(pkg)) {
				const normalized = path.posix.normalize(entry);
				expect(
					pkg.files.some(file => normalized === file || normalized.startsWith(`${file}/`)),
					`${pkg.name}: ${entry} is not in "files"`,
				).toBe(true);
			}

			// "types" and versioned ones like "types@<5.8"
			const isTypesCondition = (key: string) => key === 'types' || key.startsWith('types@');
			const checkTypesFirst = (conditions: unknown) => {
				if (conditions && typeof conditions === 'object') {
					const keys = Object.keys(conditions);
					const typesKeyCount = keys.filter(isTypesCondition).length;
					expect(
						keys.slice(0, typesKeyCount).every(isTypesCondition),
						`${pkg.name}: types conditions must come first in ${keys.join(', ')}`,
					).toBe(true);
					Object.values(conditions).forEach(checkTypesFirst);
				}
			};
			checkTypesFirst(pkg.exports);
		}
	});

	test('The bundles that entry points point to exist after the build', () => {
		// `npm run pre-test` builds the bundles; the modules and declarations need the full `npm run build`
		for (const dir of packageDirs) {
			const pkg = readPackageJson(dir);
			for (const entry of entryPaths(pkg).filter(entry => entry.startsWith('./dist/bundles/'))) {
				expect(fs.existsSync(path.join(dir, entry)), `${pkg.name}: ${entry} is missing`).toBe(true);
			}
		}
	});

	test('All packages share one version, and every Mediabunny range they declare includes it', () => {
		const core = readPackageJson('.');
		const [major, minor, patch] = core.version.split('.').map(Number) as [number, number, number];
		const satisfiesCaret = (range: string) => {
			const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
			expect(match, `unexpected range ${range}`).not.toBeNull();
			const [rangeMajor, rangeMinor, rangePatch] = match!.slice(1).map(Number) as [number, number, number];
			return rangeMajor === major && (minor > rangeMinor || (minor === rangeMinor && patch >= rangePatch));
		};

		for (const dir of packageDirs) {
			const pkg = readPackageJson(dir);
			expect(pkg.version, pkg.name).toBe(core.version);
			// Tree-shakable: nothing has side effects, except (once #532 is in) Mediabunny's entry module, whose only
			// top-level code is the check for being loaded twice
			const entryModules = JSON.stringify(['./dist/modules/src/index.js', './src/index.ts']);
			const sideEffects = JSON.stringify(pkg.sideEffects);
			const allowed = sideEffects === 'false' || (dir === '.' && sideEffects === entryModules);
			expect(allowed, `${pkg.name}: ${sideEffects}`).toBe(true);
			for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies })) {
				if (name === 'mediabunny' || name.startsWith('@mediabunny/')) {
					expect(satisfiesCaret(range), `${pkg.name}: ${name}@${range}`).toBe(true);
				}
			}
		}
	});

	test('Only src/node.ts imports Node built-ins at runtime, and the browser field drops it', () => {
		const sourceFiles = fs.readdirSync('src', { recursive: true, encoding: 'utf8' })
			.filter(file => file.endsWith('.ts'))
			.map(file => path.posix.join('src', file.split(path.sep).join('/')));

		const importers = sourceFiles.filter((file) => {
			const code = fs.readFileSync(file, 'utf8');
			return /^\s*(import|export)(?!\s+type\b)[^;]*?\bfrom\s+['"]node:/m.test(code)
				|| /\bimport\(\s*['"]node:/.test(code)
				|| /\brequire\(\s*['"]node:/.test(code);
		});
		expect(importers).toEqual(['src/node.ts']);

		const { browser } = readPackageJson('.');
		expect(browser?.['./src/node.ts']).toBe(false);
		expect(browser?.['./dist/modules/src/node.js']).toBe(false);
	});
});

describe('Bundles', () => {
	test('The ESM and CommonJS bundles export the same names as the source entry', () => {
		const names = (code: string) => (JSON.parse(runNode(['--input-type=module', '-e', code])) as string[]).sort();
		for (const file of ['mediabunny.mjs', 'mediabunny.min.mjs']) {
			const url = new URL(`../../dist/bundles/${file}`, import.meta.url).href;
			expect(names(`console.log(JSON.stringify(Object.keys(await import(${JSON.stringify(url)}))))`), file)
				.toEqual(coreExportNames);
		}
		for (const file of ['mediabunny.cjs', 'mediabunny.min.cjs', 'mediabunny.node.cjs']) {
			const filePath = path.join(root, 'dist/bundles', file);
			expect(names(`import { createRequire } from 'node:module';
				const exports = createRequire(import.meta.url)(${JSON.stringify(filePath)});
				console.log(JSON.stringify(Object.keys(exports).filter(key => key !== 'default')));`), file)
				.toEqual(coreExportNames);
		}
	});

	test('Script tag builds define the Mediabunny global without touching any browser or Node global', () => {
		// The bundles load in a global scope that only has the ECMAScript built-ins
		for (const file of ['mediabunny.cjs', 'mediabunny.min.cjs']) {
			const globals = runScripts([`dist/bundles/${file}`]);
			expect(Object.keys(globals['Mediabunny'] ?? {}).sort(), file).toEqual(coreExportNames);
		}
	});

	test('Extension script tag builds define their global and register with the Mediabunny global', async () => {
		for (const extension of EXTENSIONS) {
			for (const file of [`mediabunny-${extension.dir}.js`, `mediabunny-${extension.dir}.min.js`]) {
				const globals = runScripts([
					'dist/bundles/mediabunny.cjs',
					`packages/${extension.dir}/dist/bundles/${file}`,
				]);
				const extensionGlobal = globals[extension.global];
				expect(Object.keys(extensionGlobal ?? {}).sort(), file).toEqual(extension.exports);

				for (const register of extension.exports) {
					(extensionGlobal![register] as () => void)();
				}
				const mb = globals['Mediabunny'] as unknown as typeof Mediabunny;
				for (const codec of extension.encodes) {
					const canEncode = await mb.canEncodeAudio(codec as Mediabunny.AudioCodec);
					expect(canEncode, `${file}: encode ${codec}`).toBe(true);
				}
				for (const codec of extension.decodes) {
					const canDecode = codec === 'prores'
						? await mb.canDecodeVideo('prores', { codedWidth: 64, codedHeight: 64 })
						: await mb.canDecodeAudio(codec as Mediabunny.AudioCodec);
					expect(canDecode, `${file}: decode ${codec}`).toBe(true);
				}
			}
		}
	});
});

describe('Node consumption', () => {
	test('require(\'mediabunny\') gets the Node build, with working file path sources and targets', () => {
		// The browser CommonJS build has no file system access (upstream issue #360)
		const output = runNode(['-e', `
			const mb = require('mediabunny');
			const os = require('node:os');
			const file = require('node:path').join(os.tmpdir(), 'mediabunny-packaging-' + process.pid + '.wav');
			(async () => {
				const output = new mb.Output({ format: new mb.WavOutputFormat(), target: new mb.FilePathTarget(file) });
				const source = new mb.AudioSampleSource({ codec: 'pcm-s16' });
				output.addAudioTrack(source);
				await output.start();
				const sample = new mb.AudioSample({
					data: new Float32Array(4800), format: 'f32', numberOfChannels: 1, sampleRate: 48000, timestamp: 0,
				});
				await source.add(sample);
				sample.close();
				await output.finalize();
				const input = new mb.Input({ source: new mb.FilePathSource(file), formats: mb.ALL_FORMATS });
				console.log(JSON.stringify({ duration: await input.computeDuration(), keys: Object.keys(mb).length }));
				input.dispose();
				require('node:fs').unlinkSync(file);
			})();
		`]);
		expect(JSON.parse(output)).toEqual({ duration: 0.1, keys: coreExportNames.length });
	});
});

describe('Tree shaking', () => {
	const bundle = async (code: string, ignoreAnnotations = false) => {
		const result = await esbuild.build({
			stdin: { contents: code, resolveDir: root, loader: 'ts' },
			bundle: true,
			write: false,
			format: 'esm',
			platform: 'browser',
			target: 'es2021',
			logLevel: 'silent',
			ignoreAnnotations,
		});
		return result.outputFiles[0]!.text;
	};
	const CONTAINER_CLASSES = [
		'IsobmffDemuxer', 'MatroskaDemuxer', 'Mp3Demuxer', 'MpegTsDemuxer', 'HlsDemuxer', 'OggDemuxer', 'WaveDemuxer',
		'FlacDemuxer', 'AdtsDemuxer', 'IsobmffMuxer', 'MatroskaMuxer', 'WaveMuxer', 'Mp3Muxer', 'OggMuxer',
		'MpegTsMuxer', 'FlacMuxer', 'AdtsMuxer', 'HlsMuxer',
	];
	const containerClassesIn = (code: string) => {
		return CONTAINER_CLASSES.filter(name => new RegExp(`\\b${name}\\b`).test(code));
	};
	// The package is "sideEffects": false, which also covers src/ when bundling the sources directly
	const entry = JSON.stringify(path.join(root, 'src/index.ts'));

	test('Imports pull in only the containers they use', async () => {
		const canEncodeOnly = `import { canEncodeAudio } from ${entry}; globalThis.x = canEncodeAudio;`;
		expect(containerClassesIn(await bundle(canEncodeOnly))).toEqual([]);
		// The /* #__PURE__ */ annotations and "sideEffects" are what makes this work
		expect(containerClassesIn(await bundle(canEncodeOnly, true))).toContain('IsobmffDemuxer');

		expect(containerClassesIn(await bundle(`import { Output, WavOutputFormat, BufferTarget } from ${entry};
			globalThis.x = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });`)))
			.toEqual(['WaveMuxer']);
		expect(containerClassesIn(await bundle(`import { Input, MP4, BlobSource } from ${entry};
			globalThis.x = new Input({ source: new BlobSource(new Blob([])), formats: [MP4] });`)))
			.toEqual(['IsobmffDemuxer']);
	});
});

// The npm-packed packages, installed (offline) into a consumer project. Needs the full `npm run build` for the modules
// and declarations, and takes a while, so it only runs with MEDIABUNNY_TEST_PACKAGING=1.
describe.skipIf(process.env['MEDIABUNNY_TEST_PACKAGING'] !== '1')('Packed packages', () => {
	// Failures on main that open pull requests fix. The tests below assert that each one still happens exactly, so a
	// flag has to be turned off in the same change as its fix, and anything else that goes wrong fails them too.
	const KNOWN_FAILURES = {
		'#314': true, // @mediabunny/server can't be loaded with require() and has its own copy of @mediabunny/prores
		'#315': true, // Extensions loaded with require() register with a second copy of Mediabunny
		'#319': true, // @types/dom-webcodecs 0.1.13 conflicts with the DOM lib of TypeScript 5.8+
		'#320': true, // The declarations need Disposable, which only the esnext lib or @types/node declare
	};

	let project = '';

	beforeAll(() => {
		expect(fs.existsSync('dist/modules/src/index.d.ts'), 'Run `npm run build` first').toBe(true);
		project = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabunny-packed-'));
		const tarballs = path.join(project, 'tarballs');
		fs.mkdirSync(tarballs);
		for (const dir of packageDirs) {
			execFileSync('npm', ['pack', '--silent', '--pack-destination', tarballs], {
				cwd: dir,
				stdio: 'ignore',
				shell: process.platform === 'win32',
			});
		}

		for (const tarball of fs.readdirSync(tarballs)) {
			const extracted = path.join(project, 'extracted');
			fs.mkdirSync(extracted);
			execFileSync('tar', ['-xzf', path.join(tarballs, tarball), '-C', extracted, '--strip-components=1']);
			const { name } = readPackageJson(extracted);
			fs.mkdirSync(path.dirname(path.join(project, 'node_modules', name)), { recursive: true });
			fs.renameSync(extracted, path.join(project, 'node_modules', name));
		}
		// Third-party dependencies come from the repository's own install
		const thirdParty = [
			'@types/dom-mediacapture-transform', '@types/dom-webcodecs', '@types/node', 'undici-types', 'turbores',
			'node-av',
		];
		for (const name of thirdParty) {
			fs.mkdirSync(path.dirname(path.join(project, 'node_modules', name)), { recursive: true });
			fs.symlinkSync(path.join(root, 'node_modules', name), path.join(project, 'node_modules', name), 'junction');
		}
	}, 300_000);

	afterAll(() => {
		if (project) {
			fs.rmSync(project, { recursive: true, force: true });
		}
	});

	// Each entry: [package, register functions, check that resolves to true once registered]
	const nodeChecks = `
		const results = {};
		const logged = [];
		console.error = (...args) => logged.push(String(args[0]).split('\\n').slice(0, 2).join(' '));
		const check = async (name, fn) => {
			try {
				const result = await fn();
				results[name] = result === true ? true : String(result);
			} catch (error) {
				results[name] = String(error?.code ?? error?.message ?? error);
			}
		};
		const mb = await load('mediabunny');
		const makeSample = () => new mb.AudioSample({
			data: new Float32Array(9600).map((_, i) => 0.5 * Math.sin(i / 10)), format: 'f32', numberOfChannels: 2,
			sampleRate: 48000, timestamp: 0,
		});
		// Encodes 0.1 s of audio, then decodes it (if a decoder is available) or counts its packets
		const encode = async (codec, format, decode) => {
			const output = new mb.Output({ format, target: new mb.BufferTarget() });
			const source = new mb.AudioSampleSource({ codec, bitrate: 128000 });
			output.addAudioTrack(source);
			await output.start();
			const sample = makeSample();
			await source.add(sample);
			sample.close();
			await output.finalize();
			const input = new mb.Input({ source: new mb.BufferSource(output.target.buffer), formats: mb.ALL_FORMATS });
			const track = await input.getPrimaryAudioTrack();
			let count = 0;
			if (decode) {
				for await (const decoded of new mb.AudioSampleSink(track).samples()) {
					count += decoded.numberOfFrames;
					decoded.close();
				}
			} else {
				for await (const packet of new mb.EncodedPacketSink(track).packets()) {
					count++;
				}
			}
			return count;
		};
		await check('mediabunny: WAV encode and decode', async () => {
			const frames = await encode('pcm-s16', new mb.WavOutputFormat(), true);
			return frames === 4800 || frames + ' frames';
		});
		await check('mediabunny: file path target and source', async () => {
			const os = require('node:os');
			const file = require('node:path').join(os.tmpdir(), 'mediabunny-packed-' + process.pid + '.wav');
			const output = new mb.Output({ format: new mb.WavOutputFormat(), target: new mb.FilePathTarget(file) });
			const source = new mb.AudioSampleSource({ codec: 'pcm-s16' });
			output.addAudioTrack(source);
			await output.start();
			const sample = makeSample();
			await source.add(sample);
			sample.close();
			await output.finalize();
			const input = new mb.Input({ source: new mb.FilePathSource(file), formats: mb.ALL_FORMATS });
			const duration = await input.computeDuration();
			input.dispose();
			require('node:fs').unlinkSync(file);
			return duration === 0.1;
		});
		// [package, check that the registration took, encode check (the encoders run in a worker)]
		const extensions = [
			['@mediabunny/mp3-encoder', () => mb.canEncodeAudio('mp3'),
				async () => (await encode('mp3', new mb.Mp3OutputFormat(), false)) > 0],
			['@mediabunny/aac-encoder', () => mb.canEncodeAudio('aac'), null],
			['@mediabunny/flac-encoder', () => mb.canEncodeAudio('flac'),
				async () => (await encode('flac', new mb.FlacOutputFormat(), false)) > 0],
			['@mediabunny/ac3', () => mb.canDecodeAudio('ac3'),
				async () => (await encode('ac3', new mb.MkvOutputFormat(), true)) >= 4800],
			['@mediabunny/dts', () => mb.canDecodeAudio('dts'), null],
			['@mediabunny/truehd', () => mb.canDecodeAudio('truehd'), null],
			['@mediabunny/prores', () => mb.canDecodeVideo('prores', { codedWidth: 64, codedHeight: 64 }), null],
		];
		for (const [name, isRegistered, roundtrip] of extensions) {
			await check(name + ': registers', async () => {
				const extension = await load(name);
				for (const register of Object.values(extension)) {
					register();
				}
				return (await isRegistered()) || 'not registered with this copy of Mediabunny';
			});
			if (roundtrip) {
				if (results[name + ': registers'] === true) {
					await check(name + ': encodes', roundtrip);
				} else {
					results[name + ': encodes'] = 'skipped';
				}
			}
		}
		await check('@mediabunny/server: registers', async () => {
			(await load('@mediabunny/server')).registerMediabunnyServer();
			const canEncode = await mb.canEncodeVideo('avc', { width: 64, height: 64 });
			return canEncode || 'not registered with this copy of Mediabunny';
		});
		results.logged = logged;
		console.log(JSON.stringify(results));
		process.exit(0);
	`;

	const parseResults = (output: string) => JSON.parse(output.trim().split('\n').pop()!) as Record<string, unknown>;

	// The extensions whose encoder the checks above also run
	const ENCODE_CHECKED = ['mp3-encoder', 'flac-encoder', 'ac3'];

	// What the checks above report given the known failures. Compared exactly, so both a new failure and a known one
	// that stopped happening fail the test.
	const expectedNodeResults = (format: 'esm' | 'commonjs') => {
		// The extensions' require() builds are their ESM builds, so from CommonJS they register with a second copy of
		// Mediabunny, which warns that it was loaded twice
		const secondCopy = format === 'commonjs' && KNOWN_FAILURES['#315'];
		const results: Record<string, unknown> = {
			'mediabunny: WAV encode and decode': true,
			'mediabunny: file path target and source': true,
		};
		for (const extension of EXTENSIONS) {
			const name = `@mediabunny/${extension.dir}`;
			results[`${name}: registers`] = secondCopy ? 'not registered with this copy of Mediabunny' : true;
			if (ENCODE_CHECKED.includes(extension.dir)) {
				results[`${name}: encodes`] = secondCopy ? 'skipped' : true;
			}
		}
		// The server's bundles include @mediabunny/prores, so require() hits ESM-only turbores, and ESM loads a
		// second copy of @mediabunny/prores
		const serverFails = KNOWN_FAILURES['#314'];
		results['@mediabunny/server: registers'] = format === 'commonjs' && serverFails
			? 'ERR_PACKAGE_PATH_NOT_EXPORTED'
			: true;
		const logged: unknown[] = [];
		if (secondCopy) {
			logged.push(expect.stringMatching(/^\[WARNING\] Mediabunny was loaded twice\./));
		}
		if (format === 'esm' && serverFails) {
			logged.push(expect.stringMatching(/^\[WARNING\] @mediabunny\/prores was loaded twice\./));
		}
		return { ...results, logged };
	};

	test('Node ESM consumers can use every package', () => {
		fs.writeFileSync(path.join(project, 'consumer.mjs'), [
			`import { createRequire } from 'node:module';`,
			`const require = createRequire(import.meta.url);`,
			`const load = name => import(name);`,
			nodeChecks,
		].join('\n'));
		expect(parseResults(runNode(['consumer.mjs'], project))).toEqual(expectedNodeResults('esm'));
	}, 120_000);

	test('Node CommonJS consumers can use every package', () => {
		fs.writeFileSync(path.join(project, 'consumer.cjs'), [
			`const load = async name => require(name);`,
			`(async () => {`,
			nodeChecks,
			`})();`,
		].join('\n'));
		expect(parseResults(runNode(['consumer.cjs'], project))).toEqual(expectedNodeResults('commonjs'));
	}, 120_000);

	type TsScenario = {
		name: string;
		type: 'module' | 'commonjs';
		options: ts.CompilerOptions;
		/** Only Mediabunny itself, without the extensions and the server (whose node-av needs @types/node) */
		coreOnly?: boolean;
	};

	const ES2022_LIB = ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'];
	const TS_SCENARIOS: TsScenario[] = [
		{ name: 'bundler', type: 'module',
			options: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler } },
		{ name: 'bundler, ES2022 lib', type: 'module',
			options: {
				module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ES2022_LIB,
			} },
		// No @types/node (TypeScript 6+ includes none by default) and no esnext lib, so nothing declares Disposable
		{ name: 'bundler, ES2022 lib, no @types/node', type: 'module', coreOnly: true,
			options: {
				module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ES2022_LIB,
				types: [],
			} },
		{ name: 'bundler, strictest', type: 'module',
			options: {
				module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
				exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
				noPropertyAccessFromIndexSignature: true, noImplicitOverride: true, verbatimModuleSyntax: true,
				isolatedModules: true,
			} },
		{ name: 'nodenext, ESM', type: 'module',
			options: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext } },
		{ name: 'nodenext, CommonJS', type: 'commonjs',
			options: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext } },
		{ name: 'node16, ESM', type: 'module',
			options: { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 } },
		{ name: 'node16, CommonJS', type: 'commonjs',
			options: { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 } },
	];

	// Diagnostics as `<file>: TS<code>: <message>`, with paths under node_modules relative to it. Each list is the
	// exact set of the current failure, with the repository's TypeScript and dependencies.
	const DIAGNOSTICS = {
		// #319, without skipLibCheck
		domWebcodecsConflicts: [
			`@types/dom-webcodecs/webcodecs.generated.d.ts: TS2300: Duplicate identifier 'ImageBufferSource'.`,
			`@types/dom-webcodecs/webcodecs.generated.d.ts: TS2374: Duplicate index signature for type 'number'.`,
			`@types/dom-webcodecs/webcodecs.generated.d.ts: TS2717: Subsequent property declarations must have the`
			+ ` same type.  Property 'data' must be of type 'BufferSource', but here has type`
			+ ` 'AllowSharedBufferSource'.`,
			`typescript/lib/lib.dom.d.ts: TS2300: Duplicate identifier 'ImageBufferSource'.`,
			`typescript/lib/lib.dom.d.ts: TS2374: Duplicate index signature for type 'number'.`,
		],
		// #320, without skipLibCheck, @types/node and the esnext lib
		missingDisposable: ['input', 'sample', 'sample', 'source'].flatMap(file => [
			`mediabunny/dist/modules/src/${file}.d.ts: TS2304: Cannot find name 'Disposable'.`,
			`mediabunny/dist/modules/src/${file}.d.ts: TS2550: Property 'dispose' does not exist on type`
			+ ` 'SymbolConstructor'. Do you need to change your target library? Try changing the 'lib' compiler option`
			+ ` to 'esnext' or later.`,
		]),
		// Not fixed by any PR: node-av's declarations import its optional peer dependency werift (without skipLibCheck)
		werift: [
			`node-av/dist/api/demuxer.d.ts: TS2307: Cannot find module 'werift' or its corresponding type`
			+ ' declarations.',
		],
		// Not fixed by any PR, under node16 (TypeScript 5.8+'s nodenext allows require() of ESM): the server's
		// declarations are CommonJS-format (its package.json has no "type") and import ESM declarations (without
		// skipLibCheck)...
		serverDeclarationsImportEsm: ['audio-sample', 'index', 'video-sample'].flatMap(file => [
			'mediabunny', 'node-av',
		].map(module => `@mediabunny/server/dist/modules/src/${file}.d.ts: TS1479: The current file is a CommonJS`
			+ ` module whose imports will produce 'require' calls; however, the referenced file is an ECMAScript module`
			+ ` and cannot be imported with 'require'. Consider writing a dynamic 'import("${module}")' call`
			+ ' instead.')),
		// ...and CommonJS consumers can't import Mediabunny's ESM declarations (upstream #502)
		commonJsConsumer: [
			`consumer.ts: TS1479: The current file is a CommonJS module whose imports will produce 'require' calls;`
			+ ` however, the referenced file is an ECMAScript module and cannot be imported with 'require'. Consider`
			+ ` writing a dynamic 'import("mediabunny")' call instead.   To convert this file to an ECMAScript module,`
			+ ' change its file extension to \'.mts\' or create a local package.json file with `{ "type": "module" }`.',
		],
	};

	const expectedDiagnostics = (scenario: TsScenario, skipLibCheck: boolean) => {
		const node16 = scenario.options.moduleResolution === ts.ModuleResolutionKind.Node16;
		const expected: string[] = [];
		if (!skipLibCheck) {
			if (KNOWN_FAILURES['#319']) {
				expected.push(...DIAGNOSTICS.domWebcodecsConflicts);
			}
			if (KNOWN_FAILURES['#320'] && scenario.coreOnly) {
				expected.push(...DIAGNOSTICS.missingDisposable);
			}
			if (!scenario.coreOnly) {
				expected.push(...DIAGNOSTICS.werift);
				if (node16) {
					expected.push(...DIAGNOSTICS.serverDeclarationsImportEsm);
				}
			}
		}
		if (node16 && scenario.type === 'commonjs') {
			expected.push(...DIAGNOSTICS.commonJsConsumer);
		}
		return expected.sort();
	};

	test('TypeScript consumers compile against the packed declarations', () => {
		const coreConsumer = `import {
	Input, ALL_FORMATS, BufferSource, Output, Mp4OutputFormat, BufferTarget, AudioSampleSource, AudioSample,
	canEncodeAudio, VideoSample, EncodedPacket, Conversion, MediaStreamVideoTrackSource, QUALITY_HIGH,
	type AudioCodec, type InputVideoTrack,
} from 'mediabunny';

export const runCore = async (stream: MediaStream) => {
	const input = new Input({ source: new BufferSource(new Uint8Array(16)), formats: ALL_FORMATS });
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
	const source = new AudioSampleSource({ codec: 'aac', bitrate: QUALITY_HIGH });
	output.addAudioTrack(source);
	const videoTrack = stream.getVideoTracks()[0];
	if (videoTrack) {
		output.addVideoTrack(new MediaStreamVideoTrackSource(videoTrack, { codec: 'avc', bitrate: 1e6 }));
	}
	await output.start();
	const sample = new AudioSample({
		data: new Float32Array(1024), format: 'f32', numberOfChannels: 1, sampleRate: 48000, timestamp: 0,
	});
	await source.add(sample);
	await output.finalize();
	const track: InputVideoTrack | null = await input.getPrimaryVideoTrack();
	const codec: AudioCodec | null = (await input.getPrimaryAudioTrack())?.codec ?? null;
	const packet = new EncodedPacket(new Uint8Array(4), 'key', 0, 1);
	const conversion = await Conversion.init({ input, output });
	return [await canEncodeAudio('aac'), track, codec, packet.byteLength, conversion.isValid, VideoSample];
};
`;
		const fullConsumer = `${coreConsumer}
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';
import { registerAc3Decoder, registerAc3Encoder } from '@mediabunny/ac3';
import { registerDtsDecoder, registerDtsEncoder } from '@mediabunny/dts';
import { registerTrueHdDecoder, registerTrueHdEncoder } from '@mediabunny/truehd';
import { registerProresDecoder } from '@mediabunny/prores';
import { registerMediabunnyServer, toAvFrame, AvFrameVideoSampleResource } from '@mediabunny/server';

export const runExtensions = async (frame: Parameters<typeof toAvFrame>[1]) => {
	[registerMp3Encoder, registerAacEncoder, registerFlacEncoder, registerAc3Decoder, registerAc3Encoder,
		registerDtsDecoder, registerDtsEncoder, registerTrueHdDecoder, registerTrueHdEncoder, registerProresDecoder]
		.forEach(register => register());
	registerMediabunnyServer();
	const videoSample = new VideoSample(new AvFrameVideoSampleResource(frame), { timestamp: 0 });
	await toAvFrame(videoSample, frame);
};
`;
		const actual: Record<string, string[]> = {};
		const expected: Record<string, string[]> = {};
		for (const scenario of TS_SCENARIOS) {
			for (const skipLibCheck of [false, true]) {
				const name = `${scenario.name}, skipLibCheck ${skipLibCheck}`;
				const dir = path.join(project, 'ts', name.replace(/\W+/g, '-'));
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: scenario.type }));
				fs.writeFileSync(path.join(dir, 'consumer.ts'), scenario.coreOnly ? coreConsumer : fullConsumer);
				const program = ts.createProgram({
					rootNames: [path.join(dir, 'consumer.ts')],
					options: {
						target: ts.ScriptTarget.ES2022,
						lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
						types: ['node'],
						strict: true,
						noEmit: true,
						skipLibCheck,
						...scenario.options,
					},
				});
				actual[name] = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
					const file = diagnostic.file
						? diagnostic.file.fileName.replace(/^.*\/node_modules\//, '').replace(dir + '/', '')
						: '';
					const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
						.replaceAll(project, '<project>');
					return `${file}: TS${diagnostic.code}: ${message}`;
				}).sort();
				expected[name] = expectedDiagnostics(scenario, skipLibCheck);
			}
		}
		expect(actual).toEqual(expected);
	}, 300_000);

	test('Browser bundles of the packed packages don\'t import Node built-ins', async () => {
		const result = await esbuild.build({
			stdin: {
				contents: [
					`import { Input, ALL_FORMATS, BlobSource } from 'mediabunny';`,
					`import { Output, BufferTarget, WavOutputFormat } from 'mediabunny';`,
					`import { registerMp3Encoder } from '@mediabunny/mp3-encoder';`,
					`import { registerAc3Decoder } from '@mediabunny/ac3';`,
					`import { registerProresDecoder } from '@mediabunny/prores';`,
					`globalThis.x = [Input, ALL_FORMATS, BlobSource, Output, BufferTarget, WavOutputFormat,`,
					`	registerMp3Encoder, registerAc3Decoder, registerProresDecoder];`,
				].join('\n'),
				resolveDir: project,
			},
			bundle: true,
			write: false,
			metafile: true,
			format: 'esm',
			platform: 'browser',
			logLevel: 'silent',
		});
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports.map(x => x.path));
		expect(imports.filter(specifier => specifier.startsWith('node:'))).toEqual([]);
	});
});
