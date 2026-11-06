import { expect, test } from 'vitest';
import path from 'node:path';
import { joinPaths } from '../../src/misc.js';

test('joinPaths', () => {
	// Simple relative paths
	expect(joinPaths('path/to/entry.m3u8', 'other.m3u8')).toBe('path/to/other.m3u8');
	expect(joinPaths('entry.m3u8', 'other.m3u8')).toBe('other.m3u8');
	expect(joinPaths('/path/to/entry.m3u8', 'other.m3u8')).toBe('/path/to/other.m3u8');

	// Absolute relative paths (starting with /)
	expect(joinPaths('path/to/entry.m3u8', '/other.m3u8')).toBe('/other.m3u8');
	expect(joinPaths('/path/to/entry.m3u8', '/other.m3u8')).toBe('/other.m3u8');

	// With protocols
	expect(joinPaths('https://example.com/path/to/entry.m3u8', 'other.m3u8'))
		.toBe('https://example.com/path/to/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', '/other.m3u8'))
		.toBe('https://example.com/other.m3u8');
	expect(joinPaths('file:///path/to/entry.m3u8', 'other.m3u8')).toBe('file:///path/to/other.m3u8');
	expect(joinPaths('file:///path/to/entry.m3u8', '/other.m3u8')).toBe('file:///other.m3u8');

	// With ./
	expect(joinPaths('path/to/entry.m3u8', './other.m3u8')).toBe('path/to/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', './other.m3u8'))
		.toBe('https://example.com/path/to/other.m3u8');

	// With ../
	expect(joinPaths('path/to/entry.m3u8', '../other.m3u8')).toBe('path/other.m3u8');
	expect(joinPaths('path/to/deep/entry.m3u8', '../../other.m3u8')).toBe('path/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', '../other.m3u8'))
		.toBe('https://example.com/path/other.m3u8');
	expect(joinPaths('https://example.com/a/b/c/entry.m3u8', '../../other.m3u8'))
		.toBe('https://example.com/a/other.m3u8');

	// Mixed ./ and ../
	expect(joinPaths('path/to/entry.m3u8', './../other.m3u8')).toBe('path/other.m3u8');
	expect(joinPaths('path/to/entry.m3u8', '../foo/../other.m3u8')).toBe('path/other.m3u8');

	// URL base path with query parameters
	expect(joinPaths('https://example.com/path/to/entry.m3u8?token=abc', 'other.m3u8'))
		.toBe('https://example.com/path/to/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8?redirect=/foo/bar', 'other.m3u8'))
		.toBe('https://example.com/path/to/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8?token=abc', '/other.m3u8'))
		.toBe('https://example.com/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8?token=abc', '../other.m3u8'))
		.toBe('https://example.com/path/other.m3u8');

	// Filesystem paths with ? in the name are preserved
	expect(joinPaths('path/to/sus?directory/file.m3u8', 'other.m3u8')).toBe('path/to/sus?directory/other.m3u8');

	// Second argument is a full URL with protocol
	expect(joinPaths('path/to/entry.m3u8', 'https://example.com/other.m3u8'))
		.toBe('https://example.com/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', 'https://other.com/other.m3u8'))
		.toBe('https://other.com/other.m3u8');
	expect(joinPaths('file:///path/to/entry.m3u8', 'https://example.com/other.m3u8'))
		.toBe('https://example.com/other.m3u8');
});

const withPlatform = (platform: string, fn: () => void) => {
	const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
	Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
	try {
		fn();
	} finally {
		Object.defineProperty(process, 'platform', descriptor);
	}
};

test('joinPaths with Windows paths', () => {
	withPlatform('win32', () => {
		// What Node's path module produces on Windows, e.g. for a FilePathSource or a PathedTarget root
		expect(joinPaths('C:\\media\\hls\\master.m3u8', 'playlist-1.m3u8')).toBe('C:\\media\\hls\\playlist-1.m3u8');
		expect(joinPaths('C:\\media\\hls\\playlist-1.m3u8', 'segments/segment-1-1.ts'))
			.toBe('C:\\media\\hls\\segments\\segment-1-1.ts');
		expect(joinPaths('C:\\media\\hls\\master.m3u8', '../other/./playlist.m3u8'))
			.toBe('C:\\media\\other\\playlist.m3u8');
		expect(joinPaths('hls\\master.m3u8', 'playlist-1.m3u8')).toBe('hls\\playlist-1.m3u8');
		expect(joinPaths('\\\\server\\share\\master.m3u8', 'playlist-1.m3u8'))
			.toBe('\\\\server\\share\\playlist-1.m3u8');
		expect(joinPaths('C:/media/hls/master.m3u8', 'playlist-1.m3u8')).toBe('C:/media/hls/playlist-1.m3u8');

		// Paths starting with a separator are rooted at the base path's drive or share
		expect(joinPaths('C:\\media\\hls\\master.m3u8', '\\other\\playlist.m3u8')).toBe('C:\\other\\playlist.m3u8');
		expect(joinPaths('C:\\media\\hls\\master.m3u8', '/other/playlist.m3u8')).toBe('C:\\other\\playlist.m3u8');
		expect(joinPaths('\\\\server\\share\\hls\\master.m3u8', '\\playlist.m3u8'))
			.toBe('\\\\server\\share\\playlist.m3u8');

		// .. never goes above the drive or share
		expect(joinPaths('\\\\server\\share\\hls\\master.m3u8', '../../playlist.m3u8'))
			.toBe('\\\\server\\share\\playlist.m3u8');
		expect(joinPaths('C:\\master.m3u8', '..\\playlist.m3u8')).toBe('C:\\playlist.m3u8');

		// Absolute Windows paths
		expect(joinPaths('C:\\media\\master.m3u8', 'D:\\other\\playlist.m3u8')).toBe('D:\\other\\playlist.m3u8');
		expect(joinPaths('C:\\media\\master.m3u8', '\\\\server\\share\\playlist.m3u8'))
			.toBe('\\\\server\\share\\playlist.m3u8');

		// URLs are unaffected
		expect(joinPaths('https://example.com/path/to/entry.m3u8', '../other.m3u8'))
			.toBe('https://example.com/path/other.m3u8');
	});

	withPlatform('linux', () => {
		// Elsewhere, a backslash is just a character in a file name
		expect(joinPaths('/media/hls\\files/master.m3u8', 'playlist-1.m3u8')).toBe('/media/hls\\files/playlist-1.m3u8');
	});
});

test('joinPaths with Windows paths points where Windows resolves the reference', () => {
	const cases = [
		['C:\\media\\hls\\master.m3u8', 'segments\\..\\playlist-1.m3u8'],
		['C:\\media\\hls\\master.m3u8', '\\other\\playlist.m3u8'],
		['C:\\media\\hls\\master.m3u8', '/other/playlist.m3u8'],
		['C:\\media\\master.m3u8', '..\\..\\..\\playlist.m3u8'],
		['C:\\media\\master.m3u8', 'D:\\other\\playlist.m3u8'],
		['C:\\media\\master.m3u8', 'C:playlist.m3u8'],
		['C:media\\master.m3u8', 'playlist-1.m3u8'],
		['\\\\server\\share\\hls\\master.m3u8', '../../../playlist.m3u8'],
		['\\\\server\\share\\hls\\master.m3u8', '\\other\\playlist.m3u8'],
		['//server/share/hls/master.m3u8', 'playlist-1.m3u8'],
		['\\\\?\\C:\\media\\master.m3u8', '..\\playlist-1.m3u8'],
		['hls\\master.m3u8', '..\\..\\playlist.m3u8'],
		['master.m3u8', 'playlist-1.m3u8'],
	];

	withPlatform('win32', () => {
		for (const [basePath, relativePath] of cases) {
			// Node's own Windows path resolution as the reference, with a fixed working directory
			const expected = path.win32.resolve('C:\\cwd', path.win32.dirname(basePath!), relativePath!);
			expect(path.win32.resolve('C:\\cwd', joinPaths(basePath!, relativePath!)), `${basePath} + ${relativePath}`)
				.toBe(expected);
		}
	});
});
