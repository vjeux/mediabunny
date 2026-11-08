import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// API Extractor leaves `declare global` blocks out of its declaration rollup, so the rollup that declares the global
// Mediabunny namespace (for script tags) lacked the global types the module declarations add. This copies them over.

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The text of every `declare global` block in the declaration files under `declarationDir`, by file. */
export const findGlobalDeclarations = (declarationDir: string) => {
	const blocks: { file: string; text: string }[] = [];
	const files = fs.readdirSync(declarationDir, { recursive: true, encoding: 'utf8' })
		.filter(file => file.endsWith('.d.ts'))
		.map(file => file.split(path.sep).join('/'))
		.sort();
	for (const file of files) {
		const code = fs.readFileSync(path.join(declarationDir, file), 'utf8');
		if (!code.includes('declare global')) {
			continue;
		}

		const sourceFile = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
		for (const statement of sourceFile.statements) {
			if (ts.isModuleDeclaration(statement) && (statement.flags & ts.NodeFlags.GlobalAugmentation)) {
				blocks.push({ file, text: statement.getText(sourceFile) });
			}
		}
	}

	return blocks;
};

/** Adds the `declare global` blocks of the declaration files under `declarationDir` that `rollupFile` lacks to it. */
export const addGlobalDeclarations = (declarationDir: string, rollupFile: string) => {
	let rollup = fs.readFileSync(rollupFile, 'utf8');
	const present = normalize(rollup);
	const missing = findGlobalDeclarations(declarationDir).filter(block => !present.includes(normalize(block.text)));
	if (missing.length === 0) {
		return [];
	}

	const added = missing.map(block => `// From ${block.file}\n${block.text}\n`).join('\n');
	// Before the `export { }` that ends the rollup, which makes it a module, as `declare global` requires
	const end = rollup.lastIndexOf('export { }');
	rollup = end === -1
		? `${rollup}\n${added}`
		: `${rollup.slice(0, end)}${added}\n${rollup.slice(end)}`;
	fs.writeFileSync(rollupFile, rollup);

	return missing.map(block => block.file);
};

// Usage: tsx scripts/add-global-declarations.ts <declarationDir> <rollupFile>
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
	const [declarationDir, rollupFile] = process.argv.slice(2);
	if (!declarationDir || !rollupFile) {
		throw new Error('Usage: tsx scripts/add-global-declarations.ts <declarationDir> <rollupFile>');
	}

	const files = addGlobalDeclarations(declarationDir, rollupFile);
	console.log(`Added the global declarations of ${files.length ? files.join(', ') : 'no file'} to ${rollupFile}.`);
}
