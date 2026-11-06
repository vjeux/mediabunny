import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as Mediabunny from '../../src/index.js';

// These tests keep the guides (docs/guide, README) consistent with the code: the codec compatibility table, the option
// types the guides spell out, and the imports of self-contained snippets.

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

const listMarkdown = (dir: string) => fs.readdirSync(path.join(repoRoot, dir))
	.filter(name => name.endsWith('.md'))
	.map(name => path.join(dir, name));

const DOC_PAGES = [
	'README.md',
	...listMarkdown('docs/guide'),
	...listMarkdown('docs/guide/extensions'),
];

type Snippet = { page: string; line: number; code: string };

const extractSnippets = (page: string): Snippet[] => {
	const lines = fs.readFileSync(path.join(repoRoot, page), 'utf8').split('\n');
	const snippets: Snippet[] = [];

	for (let i = 0; i < lines.length; i++) {
		const match = /^(\s*)```(ts|js|typescript|javascript)\b/.exec(lines[i]!);
		if (!match) {
			continue;
		}

		const indent = match[1]!;
		const body: string[] = [];
		let j = i + 1;
		for (; j < lines.length && !lines[j]!.trim().startsWith('```'); j++) {
			body.push(lines[j]!.startsWith(indent) ? lines[j]!.slice(indent.length) : lines[j]!);
		}

		snippets.push({ page, line: i + 1, code: body.join('\n') });
		i = j;
	}

	return snippets;
};

const allSnippets = DOC_PAGES.flatMap(extractSnippets);

// Divergences that open docs fixes address are exempted below. Each exemption ends with a fingerprint of the snippet or
// table row it applies to, as that text is today, so it lapses as soon as the text changes: a corrected snippet is
// checked like any other, and an exemption can't hide a later regression. Failure messages print the fingerprint.
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

describe('Codec compatibility table', () => {
	const IGNORED_CELLS = new Set([
		'pcm-f64 .wav fcc8a2bf2e1e',
	]);

	test('marks exactly the codecs each output format accepts', () => {
		const markdown = fs.readFileSync(path.join(repoRoot, 'docs/guide/supported-formats-and-codecs.md'), 'utf8');
		const rows = markdown.split('\n').filter(line => line.startsWith('|'));
		const header = rows[0]!.split('|').slice(2, -1).map(cell => cell.trim().replace(/\[\^\w+\]/, ''));

		const formats: Record<string, Mediabunny.OutputFormat> = {
			'.mp4': new Mediabunny.Mp4OutputFormat(),
			'.mov': new Mediabunny.MovOutputFormat(),
			'.mkv': new Mediabunny.MkvOutputFormat(),
			'.webm': new Mediabunny.WebMOutputFormat(),
			'.ogg': new Mediabunny.OggOutputFormat(),
			'.mp3': new Mediabunny.Mp3OutputFormat(),
			'.wav': new Mediabunny.WavOutputFormat(),
			'.aac': new Mediabunny.AdtsOutputFormat(),
			'.flac': new Mediabunny.FlacOutputFormat(),
			'.ts': new Mediabunny.MpegTsOutputFormat(),
		};
		expect(header).toEqual(Object.keys(formats));

		const documentedCodecs: string[] = [];
		const mismatches: string[] = [];

		for (const row of rows.slice(2)) {
			const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
			const codec = /`'([^']+)'`/.exec(cells[0]!)![1]!;
			const rowFingerprint = fingerprint(row);
			documentedCodecs.push(codec);

			header.forEach((extension, i) => {
				const documented = cells[i + 1] === '✓' || cells[i + 1] === '(✓)';
				const supported = formats[extension]!.getSupportedCodecs().includes(codec as Mediabunny.MediaCodec);
				if (documented !== supported && !IGNORED_CELLS.has(`${codec} ${extension} ${rowFingerprint}`)) {
					mismatches.push(
						`${codec} ${extension}: documented ${documented}, supported ${supported}`
						+ ` (row ${rowFingerprint})`,
					);
				}
			});
		}

		expect(mismatches).toEqual([]);
		expect(documentedCodecs.sort()).toEqual(
			[...Mediabunny.VIDEO_CODECS, ...Mediabunny.AUDIO_CODECS, ...Mediabunny.SUBTITLE_CODECS].sort(),
		);
	});
});

describe('Option types spelled out in the guides', () => {
	const IGNORED_MISSING_FIELDS = new Set([
		'BlobSourceOptions.useStreamReader fbd327eb2175',
		'MpegTsOutputFormatOptions.timestampOffset b9bf9c230ac5',
		'HlsOutputFormatOptions.mediaTimestampBase c83c7df86912',
		'HlsOutputFormatOptions.onSegmentPopped c83c7df86912',
		'VideoEncodingConfig.onEncodedSample 80b65fb577a1',
		'AudioEncodingConfig.onEncodedSample 691a464e93eb',
		'ConversionAudioOptions.group 30f3b250485e',
	]);
	// The guides only show excerpts of these types
	const EXCERPTED_TYPES = new Set(['ConversionOptions']);

	const program = ts.createProgram({
		rootNames: [path.join(repoRoot, 'src', 'index.ts')],
		options: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, noEmit: true, skipLibCheck: true },
	});
	const checker = program.getTypeChecker();
	const indexSymbol = checker.getSymbolAtLocation(program.getSourceFile(path.join(repoRoot, 'src', 'index.ts'))!)!;
	const exportedSymbols = new Map(checker.getExportsOfModule(indexSymbol).map(symbol => [symbol.getName(), symbol]));

	const getExportedFields = (typeName: string) => {
		let symbol = exportedSymbols.get(typeName);
		if (!symbol) {
			return null;
		}
		if (symbol.flags & ts.SymbolFlags.Alias) {
			symbol = checker.getAliasedSymbol(symbol);
		}

		const fields = new Set<string>();
		for (const property of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))) {
			const isDeprecated = property.getJsDocTags(checker).some(tag => tag.name === 'deprecated');
			if (!isDeprecated) {
				fields.add(property.getName());
			}
		}
		return fields;
	};

	const documentedTypes: { snippet: Snippet; name: string; fields: string[] }[] = [];
	for (const snippet of allSnippets) {
		const sourceFile = ts.createSourceFile('snippet.ts', snippet.code, ts.ScriptTarget.Latest, true);
		for (const statement of sourceFile.statements) {
			if (ts.isTypeAliasDeclaration(statement) && ts.isTypeLiteralNode(statement.type)) {
				documentedTypes.push({
					snippet,
					name: statement.name.text,
					fields: statement.type.members.flatMap(member => member.name
						? [member.name.getText(sourceFile)]
						: []),
				});
			}
		}
	}

	test('the guides spell out at least 20 option types', () => {
		expect(documentedTypes.length).toBeGreaterThanOrEqual(20);
	});

	for (const { snippet, name, fields } of documentedTypes) {
		test(`${name} (${snippet.page}:${snippet.line}) lists exactly the exported fields`, () => {
			const exportedFields = getExportedFields(name);
			expect(exportedFields, `${name} is not exported`).not.toBeNull();

			const unknownFields = fields.filter(field => !exportedFields!.has(field));
			expect(unknownFields, 'documented fields that don\'t exist').toEqual([]);

			if (EXCERPTED_TYPES.has(name)) {
				return;
			}

			const snippetFingerprint = fingerprint(snippet.code);
			const missingFields = [...exportedFields!].filter(field => !fields.includes(field)
				&& !IGNORED_MISSING_FIELDS.has(`${name}.${field} ${snippetFingerprint}`));
			expect(missingFields, `exported fields the guide leaves out (snippet ${snippetFingerprint})`).toEqual([]);
		});
	}
});

describe('Snippet imports', () => {
	const IGNORED_MISSING_IMPORTS = new Set([
		'README.md BufferTarget 668e446e02e0',
		'docs/guide/quick-start.md BufferTarget d1225810e0be',
		'docs/guide/converting-media-files.md Quality e3481a83fcd2',
		'docs/guide/input-formats.md MatroskaInputFormat aa090c221b27',
		'docs/guide/input-formats.md IsobmffInputFormat aa090c221b27',
		'docs/guide/output-formats.md BufferTarget 51e63aba33cf',
		'docs/guide/output-formats.md HlsOutputFormat 9f44c14adf93',
	]);

	const exportNames = new Set(Object.keys(Mediabunny));

	const findMissingImports = (snippet: Snippet) => {
		const sourceFile = ts.createSourceFile('snippet.ts', snippet.code, ts.ScriptTarget.Latest, true);
		const imported = new Set<string>();
		let importsMediabunny = false;
		let hasPlaceholderImport = false;

		for (const statement of sourceFile.statements) {
			if (
				ts.isImportDeclaration(statement)
				&& ts.isStringLiteral(statement.moduleSpecifier)
				&& statement.moduleSpecifier.text === 'mediabunny'
			) {
				importsMediabunny = true;
				hasPlaceholderImport ||= statement.getText(sourceFile).includes('...');
				const bindings = statement.importClause?.namedBindings;
				if (bindings && ts.isNamedImports(bindings)) {
					for (const element of bindings.elements) {
						imported.add(element.name.text);
					}
				}
			}
		}

		// Only self-contained snippets (the ones that import from Mediabunny) are expected to import everything
		if (!importsMediabunny || hasPlaceholderImport) {
			return [];
		}

		const missing = new Set<string>();
		const visit = (node: ts.Node) => {
			if (
				ts.isIdentifier(node)
				&& exportNames.has(node.text)
				&& !imported.has(node.text)
				// Skip property names like `foo.Quality` and `{ Quality: ... }`
				&& !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
				&& !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
				&& !ts.isImportSpecifier(node.parent)
			) {
				missing.add(node.text);
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);

		const snippetFingerprint = fingerprint(snippet.code);
		return [...missing]
			.filter(name => !IGNORED_MISSING_IMPORTS.has(`${snippet.page} ${name} ${snippetFingerprint}`));
	};

	test('self-contained snippets import every Mediabunny export they use', () => {
		const problems = allSnippets.flatMap(snippet => findMissingImports(snippet)
			.map(name => `${snippet.page}:${snippet.line} uses ${name} without importing it`
				+ ` (snippet ${fingerprint(snippet.code)})`));
		expect(problems).toEqual([]);
	});

	test('finds a missing import', () => {
		const snippet = {
			page: 'test.md',
			line: 1,
			code: 'import { Output } from \'mediabunny\';\nnew Output({ target: new BufferTarget() });',
		};
		expect(findMissingImports(snippet)).toEqual(['BufferTarget']);

		// README.md has a BufferTarget exemption, but only for its current snippet text
		expect(findMissingImports({ ...snippet, page: 'README.md' })).toEqual(['BufferTarget']);
	});
});
