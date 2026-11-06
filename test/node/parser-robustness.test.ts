import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import * as mediabunny from '../../src/index.js';
import { walkInput } from './helpers/robustness-walk.js';

// Inputs from coverage-guided fuzzing of every reader (libFuzzer through Jazzer.js, seeded with real-world files and
// small ffmpeg encodes). Each one is read the way an app would read it (see walkInput), from a BufferSource and from
// an unsized stream, and may only fail deliberately: no failed assertions or implicit errors, no hangs, and packet
// lookups that return a packet at or before the requested timestamp.
//
// - corpus-*.bin: small inputs that together cover the most reader code, picked greedily by V8 block coverage from
//   the fuzzing corpus. They read fine today and guard against regressions.
// - The other files fail today. Each is minimized and skipped until the PR named below lands.

const FIXTURES = path.join(__dirname, '../public/fuzzed');

const KNOWN_FAILURES: Record<string, string> = {
	// A box whose fields run past the end of its parent, one input per box type that failed this way
	...Object.fromEntries([
		'av1C', 'avcC', 'btrt', 'dec3', 'dfLa', 'dOps', 'elst', 'esds', 'hdlr', 'hvcC', 'ilst', 'keys', 'mdhd', 'meta',
		'moof', 'mvex', 'mvhd', 'mvhd-matrix', 'pasp', 'pssh', 'saiz', 'schi', 'senc', 'stbl', 'stsd', 'tenc', 'tfra',
		'tkhd', 'traf', 'trak', 'trex', 'trun', 'udta', 'vpcC', 'wave',
	].map(box => [`mp4/overread-${box}.bin`, '#330'])),
	'mp4/cut-off-64-bit-size.bin': '#330',
	// The same in the sample table, which is read lazily and fails as a whole
	...Object.fromEntries(
		['ctts', 'stco', 'stsc', 'stss', 'stsz', 'stts'].map(box => [`mp4/overread-${box}.bin`, '#70']),
	),
	'mp4/stsz-in-traf.bin': '#337',
	'mp4/box-size-past-2-53.bin': '#340',
	'mp4/stsc-first-chunk-0.bin': '#340 or #347',
	'mp4/pcm-zero-channels.bin': '#341',
	'ogg/page-header-inside-last-page.bin': '#345',
	'mkv/vorbis-without-codec-private.bin': '#325',
	'mkv/vorbis-unterminated-lacing.bin': '#325',
	'aac/sample-rate-change.bin': 'bug-fix-mania',
	'wav/unsized-overstated-data-size.bin': 'bug-fix-mania',
	'wav/id3-frame-size-past-tag.bin': 'bug-fix-mania',
};

// These used to loop synchronously, which would stall the whole file instead of failing a test
const ONCE_HUNG = new Set(['mkv/vorbis-unterminated-lacing.bin', 'aac/sample-rate-change.bin']);

const walkInChildProcess = (file: string) => {
	const script = `Promise.all([
		import(${JSON.stringify(new URL('./helpers/robustness-walk.ts', import.meta.url).href)}),
		import(${JSON.stringify(new URL('../../src/index.ts', import.meta.url).href)}),
	]).then(async ([{ walkInput }, mediabunny]) => {
		const bytes = new Uint8Array(require('node:fs').readFileSync(${JSON.stringify(file)}));
		const sized = await walkInput(mediabunny, bytes);
		console.log(JSON.stringify([...sized, ...await walkInput(mediabunny, bytes, { unsized: true })]));
	});`;

	let output: string;
	try {
		output = execFileSync(process.execPath, ['--import', 'tsx', '-e', script], {
			encoding: 'utf8',
			timeout: 20_000,
		});
	} catch (error) {
		if ((error as { code?: string }).code === 'ETIMEDOUT') {
			return ['The read hung (killed after 20 s).'];
		}

		throw error;
	}

	return JSON.parse(output.trim().split('\n').pop()!) as string[];
};

mediabunny.Logging.level = mediabunny.LogLevel.Silent;

for (const format of readdirSync(FIXTURES).sort()) {
	describe(format, () => {
		for (const name of readdirSync(path.join(FIXTURES, format)).sort()) {
			const file = `${format}/${name}`;
			const fullPath = path.join(FIXTURES, file);
			const fixedBy = KNOWN_FAILURES[file];

			const title = fixedBy ? `${name} (fails until ${fixedBy} lands)` : name;
			test.skipIf(fixedBy !== undefined)(title, async () => {
				if (ONCE_HUNG.has(file)) {
					expect(walkInChildProcess(fullPath)).toEqual([]);
					return;
				}

				const bytes = new Uint8Array(readFileSync(fullPath));
				expect([
					...await walkInput(mediabunny, bytes),
					...await walkInput(mediabunny, bytes, { unsized: true }),
				]).toEqual([]);
			});
		}
	});
}
