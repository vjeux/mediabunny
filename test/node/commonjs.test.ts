import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { expect, test } from 'vitest';

// Runs in a child process because vitest resolves these packages through aliases, while this needs Node's own
// require() with the packages' "exports" (using the bundles built by `npm run pre-test`).
const runCommonJs = (script: string) => {
	const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60_000 });
	return JSON.parse(output.trim().split('\n').pop()!) as unknown;
};

test('Extensions loaded with require() register with the CommonJS build of Mediabunny', () => {
	const result = runCommonJs(`
		const logged = [];
		console.error = (...args) => logged.push(String(args[0]).split('\\n').slice(0, 2).join(' '));
		const mb = require('mediabunny');
		const extensions = [
			['@mediabunny/mp3-encoder', () => mb.canEncodeAudio('mp3')],
			['@mediabunny/aac-encoder', () => mb.canEncodeAudio('aac')],
			['@mediabunny/flac-encoder', () => mb.canEncodeAudio('flac')],
			['@mediabunny/ac3', async () => (await mb.canDecodeAudio('ac3')) && mb.canEncodeAudio('ac3')],
			['@mediabunny/dts', async () => (await mb.canDecodeAudio('dts')) && mb.canEncodeAudio('dts')],
			['@mediabunny/truehd', async () => (await mb.canDecodeAudio('truehd')) && mb.canEncodeAudio('truehd')],
			['@mediabunny/prores', () => mb.canDecodeVideo('prores')],
		];
		(async () => {
			const registered = {};
			for (const [name, check] of extensions) {
				try {
					const extension = require(name);
					for (const key of Object.keys(extension)) {
						extension[key]();
					}
					registered[name] = await check();
				} catch (error) {
					registered[name] = String(error.code ?? error.message);
				}
			}

			// The encoder runs in a worker, which the CommonJS build has to be able to start too
			const output = new mb.Output({ format: new mb.Mp3OutputFormat(), target: new mb.BufferTarget() });
			const source = new mb.AudioSampleSource({ codec: 'mp3', bitrate: 128000 });
			output.addAudioTrack(source);
			let encodedBytes = 0;
			try {
				await output.start();
				const sample = new mb.AudioSample({
					data: new Float32Array(4800), format: 'f32', numberOfChannels: 1, sampleRate: 48000, timestamp: 0,
				});
				await source.add(sample);
				sample.close();
				await output.finalize();
				encodedBytes = output.target.buffer.byteLength;
			} catch {}

			console.log(JSON.stringify({ registered, encoded: encodedBytes > 0, logged }));
			process.exit(0);
		})();
	`);

	expect(result).toEqual({
		registered: {
			'@mediabunny/mp3-encoder': true,
			'@mediabunny/aac-encoder': true,
			'@mediabunny/flac-encoder': true,
			'@mediabunny/ac3': true,
			'@mediabunny/dts': true,
			'@mediabunny/truehd': true,
			'@mediabunny/prores': true,
		},
		encoded: true,
		logged: [], // No "Mediabunny was loaded twice"
	});
}, 60_000);

test('Extensions\' ESM and CommonJS entries come with declarations of their own module format', () => {
	// TypeScript reads .d.ts files of packages that aren't "type": "module" as CommonJS, and .d.mts files as ESM. With
	// one .d.ts for both entries, it would allow `import x from '@mediabunny/…'` in ESM, which Node rejects.
	for (const dir of fs.readdirSync('packages')) {
		const pkg = JSON.parse(fs.readFileSync(`packages/${dir}/package.json`, 'utf8')) as {
			name: string;
			type?: string;
			exports: Record<string, Record<string, string>>;
		};
		expect(pkg.type, pkg.name).toBeUndefined();
		expect(pkg.exports, pkg.name).toEqual({
			import: {
				types: `./dist/mediabunny-${dir}.d.mts`,
				default: `./dist/bundles/mediabunny-${dir}.mjs`,
			},
			require: {
				types: './dist/modules/src/index.d.ts',
				default: `./dist/bundles/mediabunny-${dir}.cjs`,
			},
		});
	}

	// The build creates the ESM declarations from each extension's declaration rollup
	const buildScript = fs.readFileSync('scripts/build.sh', 'utf8');
	expect(buildScript).toContain(
		'cp packages/$name/dist/mediabunny-$name.d.ts packages/$name/dist/mediabunny-$name.d.mts',
	);
	for (const dir of fs.readdirSync('packages')) {
		expect(buildScript, dir).toMatch(new RegExp(`for name in [a-z0-9 -]*\\b${dir}\\b`));
	}
});
