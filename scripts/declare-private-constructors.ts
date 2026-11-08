import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// stripInternal removes constructors marked @internal from the declarations, which leaves those classes with
// TypeScript's default public constructor without parameters: `new SourceRef()` compiles (and fails at runtime) while
// the real signature is rejected. This declares their constructors private instead, as Conversion's is.

/** The exported, non-abstract classes whose constructor is marked @internal, by declaration file. */
export const findClassesWithInternalConstructors = (sourceDir: string) => {
	const classes = new Map<string, string[]>();
	for (const file of fs.readdirSync(sourceDir, { recursive: true, encoding: 'utf8' })) {
		if (!file.endsWith('.ts') || file.endsWith('.d.ts')) {
			continue;
		}

		const code = fs.readFileSync(path.join(sourceDir, file), 'utf8');
		const sourceFile = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
		for (const statement of sourceFile.statements) {
			if (!ts.isClassDeclaration(statement) || !statement.name) {
				continue;
			}

			const modifiers = ts.getModifiers(statement) ?? [];
			const exported = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
			const abstract = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.AbstractKeyword);
			const constructor = statement.members.find(ts.isConstructorDeclaration);
			if (
				exported
				&& !abstract
				&& constructor
				&& ts.getJSDocTags(constructor).some(tag => tag.tagName.text === 'internal')
			) {
				const declarationFile = file.replace(/\.ts$/, '.d.ts');
				classes.set(declarationFile, [...classes.get(declarationFile) ?? [], statement.name.text]);
			}
		}
	}

	return classes;
};

/** Adds `private constructor();` to those classes in the declarations emitted for `sourceDir` into `declarationDir`. */
export const declarePrivateConstructors = (sourceDir: string, declarationDir: string) => {
	const patched: string[] = [];
	for (const [file, classNames] of findClassesWithInternalConstructors(sourceDir)) {
		const declarationPath = path.join(declarationDir, file);
		let text = fs.readFileSync(declarationPath, 'utf8');
		const declarationFile = ts.createSourceFile(declarationPath, text, ts.ScriptTarget.Latest, true);

		const positions: number[] = [];
		for (const className of classNames) {
			const declaration = declarationFile.statements.find(
				(statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement)
					&& statement.name?.text === className,
			);
			if (!declaration) {
				throw new Error(`No declaration of class ${className} in ${declarationPath}.`);
			}
			if (declaration.members.some(ts.isConstructorDeclaration)) {
				throw new Error(`The declaration of class ${className} in ${declarationPath} has a constructor.`);
			}

			positions.push(declaration.members.pos); // Right after the class body's opening brace
			patched.push(className);
		}

		for (const position of positions.sort((a, b) => b - a)) {
			text = text.slice(0, position) + '\n    private constructor();' + text.slice(position);
		}
		fs.writeFileSync(declarationPath, text);
	}

	return patched;
};

// Usage: tsx scripts/declare-private-constructors.ts [sourceDir declarationDir]
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
	const root = path.join(import.meta.dirname, '..');
	const sourceDir = process.argv[2] ?? path.join(root, 'src');
	const declarationDir = process.argv[3] ?? path.join(root, 'dist/modules/src');
	const patched = declarePrivateConstructors(sourceDir, declarationDir);
	console.log(`Declared private constructors for ${patched.join(', ')}.`);
}
