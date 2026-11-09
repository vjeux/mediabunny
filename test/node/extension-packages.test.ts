import fs from 'node:fs';
import { expect, test } from 'vitest';

// The first release whose src/index.ts exports each name the extension bundles import from 'mediabunny'
const EXPORT_FIRST_RELEASE: Record<string, string> = {
	AudioSample: '1.0.0',
	CustomAudioDecoder: '1.0.0',
	CustomAudioEncoder: '1.0.0',
	CustomVideoDecoder: '1.0.0',
	CustomVideoEncoder: '1.0.0',
	EncodedPacket: '1.0.0',
	Quality: '1.0.0',
	registerDecoder: '1.0.0',
	registerEncoder: '1.0.0',
	VideoSample: '1.0.0',
	VideoSampleColorSpace: '1.27.0',
	AudioSampleResource: '1.45.0',
	registerVideoSampleTransformer: '1.45.0',
	VideoSampleResource: '1.45.0',
	Logging: '1.49.0',
};

// What else the extensions need from Mediabunny, and the first release that has it
const NEGATIVE_TIMESTAMPS: [string, string] = ['1.56.0', 'packets with negative timestamps (encoder priming)'];
const OTHER_REQUIREMENTS: Record<string, [version: string, reason: string][]> = {
	'aac-encoder': [NEGATIVE_TIMESTAMPS],
	'mp3-encoder': [NEGATIVE_TIMESTAMPS],
	'ac3': [NEGATIVE_TIMESTAMPS],
	'server': [NEGATIVE_TIMESTAMPS],
	'dts': [['1.55.0', 'the dts codec']],
	'truehd': [['1.64.0', 'the truehd codec']],
	'prores': [['1.50.0', 'the prores codec and CustomVideoDecoder.onError']],
};

const compareVersions = (a: string, b: string) => {
	const x = a.split('.').map(Number);
	const y = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		if (x[i] !== y[i]) {
			return x[i]! - y[i]!;
		}
	}
	return 0;
};

test('Extensions\' Mediabunny peer ranges exclude the releases they don\'t work with', () => {
	const problems: string[] = [];
	for (const dir of fs.readdirSync('packages')) {
		const pkg = JSON.parse(fs.readFileSync(`packages/${dir}/package.json`, 'utf8')) as {
			name: string;
			peerDependencies: Record<string, string>;
		};
		const range = pkg.peerDependencies['mediabunny']!;
		const lowerBound = /^\^(\d+\.\d+\.\d+)$/.exec(range)?.[1];
		expect(lowerBound, `${pkg.name}: unexpected range ${range}`).toBeDefined();

		// The bundles are built by `npm run pre-test`
		const bundle = fs.readFileSync(`packages/${dir}/dist/bundles/mediabunny-${dir}.mjs`, 'utf8');
		const imported = new Set([...bundle.matchAll(/import\s*\{([^}]*)\}\s*from\s*"mediabunny"/g)]
			.flatMap(match => match[1]!.split(','))
			.map(item => item.trim().split(/\s+as\s+/)[0]!)
			.filter(name => name !== ''));
		expect([...imported], pkg.name).toContain('Logging');

		const requirements: [string, string][] = [...OTHER_REQUIREMENTS[dir] ?? []];
		for (const name of imported) {
			const version = EXPORT_FIRST_RELEASE[name];
			if (version === undefined) {
				problems.push(`${pkg.name} imports ${name}: add the release that first exported it to the table`);
			} else {
				requirements.push([version, `the ${name} export`]);
			}
		}
		for (const [version, reason] of requirements) {
			if (compareVersions(lowerBound!, version) < 0) {
				problems.push(`${pkg.name}: ${range} admits releases before ${version}, which lack ${reason}`);
			}
		}
	}
	expect(problems).toEqual([]);
});
