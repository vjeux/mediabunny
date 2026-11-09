/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type SubtitleCue = {
	timestamp: number; // in seconds
	duration: number; // in seconds
	text: string;
	identifier?: string;
	settings?: string;
	notes?: string;
};

export type SubtitleConfig = {
	description: string;
};

export type SubtitleMetadata = {
	config?: SubtitleConfig;
};

type SubtitleParserOptions = {
	codec: 'webvtt';
	output: (cue: SubtitleCue, metadata: SubtitleMetadata) => unknown;
};

// Line feeds are WebVTT's only line terminators once carriage returns are normalized, so lines may contain U+2028 and
// U+2029, which the . of regexes doesn't match. An identifier is the whole line before a timing line, so it's only
// looked for after a line feed or at the start of the text; execCueBlockHeader takes that line feed back out of the
// match. Started anywhere in a long line instead, the search would reach to the end of that line every time, which is
// quadratic. (A lookbehind can't be used, as Safari before 16.4 can't parse one, and the ^ of the m flag also matches
// after U+2028 and U+2029.)
// The hours of a timestamp may have any number of digits, even just one (W3C WebVTT, "collect a WebVTT timestamp")
const cueBlockHeaderRegex
	= /(?:(?:^|\n)([^\n]+?)\n)?((?:\d+:)?\d{2}:\d{2}.\d{3})\s*-->\s*((?:\d+:)?\d{2}:\d{2}.\d{3})/g;
const preambleStartRegex = /^WEBVTT[\s\S]*?\n{2}/;
export const inlineTimestampRegex = /<(?:(\d+):)?(\d{2}):(\d{2}).(\d{3})>/g;

/**
 * Finds the next cue block header (an optional identifier line, then a timing line) from the regex's lastIndex on. The
 * match starts at the identifier, without the line feed before it.
 */
const execCueBlockHeader = (text: string) => {
	const match = cueBlockHeaderRegex.exec(text);
	if (match?.[0].startsWith('\n')) {
		match.index++;
		match[0] = match[0].slice(1);
	}

	return match;
};

export class SubtitleParser {
	private options: SubtitleParserOptions;
	private preambleText: string | null = null;
	private preambleEmitted = false;
	/** Text after the last cue of the previous chunk, such as a NOTE block, which precedes this chunk's first cue. */
	private pendingText = '';

	constructor(options: SubtitleParserOptions) {
		this.options = options;
	}

	parse(text: string) {
		text = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
		text = delimitCueBlocks(text, !this.preambleText);

		cueBlockHeaderRegex.lastIndex = 0;
		let match: RegExpMatchArray | null;

		if (!this.preambleText) {
			if (text.charCodeAt(0) === 0xFEFF) {
				// Skip the byte order mark the file may start with
				text = text.slice(1);
			}

			// The text may also end right after the header, as a file without cues does
			if (!preambleStartRegex.test(text + '\n\n')) {
				throw new Error('WebVTT preamble incorrect.');
			}

			// The header holds at least the WEBVTT line, so that line can't be the identifier of a cue that directly
			// follows it (W3C WebVTT parser: a line containing "-->" ends the header)
			cueBlockHeaderRegex.lastIndex = text.indexOf('\n');
			match = execCueBlockHeader(text);
			const preamble = text.slice(0, match?.index ?? text.length).trimEnd();

			if (!preamble) {
				throw new Error('No WebVTT preamble provided.');
			}

			this.preambleText = preamble;

			if (match) {
				text = text.slice(match.index);
				cueBlockHeaderRegex.lastIndex = 0;
			} else {
				text = ''; // All of it is the preamble
			}
		} else {
			text = this.pendingText + text;
		}

		const cues: SubtitleCue[] = [];
		while ((match = execCueBlockHeader(text))) {
			const notes = text.slice(0, match.index);
			const cueIdentifier = match[1];
			const matchEnd = match.index! + match[0].length;
			const lineEnd = text.indexOf('\n', matchEnd);
			// Without a line break after it, the timing line ends the text and the cue has no text
			const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
			const cueSettings = text.slice(matchEnd, bodyStart).trim();

			// Like in the W3C parser, a line containing "-->" starts the next cue, even without a blank line before it.
			// The search starts after this cue's timing line, so every iteration consumes at least that line.
			const nextArrowIndex = text.indexOf('-->', bodyStart);
			// The blank line ending the cue is only looked for up to there: searching on to the end of the text for
			// every cue would take quadratic time when cues aren't separated by blank lines
			let bodyEnd = (nextArrowIndex === -1 ? text : text.slice(0, nextArrowIndex)).indexOf('\n\n', matchEnd);
			if (bodyEnd === -1) {
				bodyEnd = nextArrowIndex === -1
					? text.length
					: Math.max(text.lastIndexOf('\n', nextArrowIndex), bodyStart);
			}

			const startTime = parseSubtitleTimestamp(match[2]!);
			const endTime = parseSubtitleTimestamp(match[3]!);
			const duration = endTime - startTime;

			// Lines holding only whitespace belong to the cue text too, as only an empty line ends a cue (W3C WebVTT
			// parser); just drop the line break that ends the text
			const body = text.slice(bodyStart, bodyEnd).replace(/\n+$/, '');

			text = text.slice(bodyEnd).trimStart();
			cueBlockHeaderRegex.lastIndex = 0;

			const cue: SubtitleCue = {
				timestamp: startTime / 1000,
				duration: duration / 1000,
				text: body,
				identifier: cueIdentifier,
				settings: cueSettings,
				notes,
			};
			cues.push(cue);
		}

		// The WebVTT parser takes cues in any order, but outputs need them in order of their start times. Each cue
		// lies within one chunk of text, so its cues can be put in order; the sort is stable, so cues starting at the
		// same time keep their order.
		cues.sort((a, b) => a.timestamp - b.timestamp);

		for (const cue of cues) {
			const meta: SubtitleMetadata = {};
			if (!this.preambleEmitted) {
				meta.config = {
					description: this.preambleText,
				};
				this.preambleEmitted = true;
			}

			this.options.output(cue, meta);
		}

		this.pendingText = text;
	}
}

const timestampRegex = /(?:(\d+):)?(\d{2}):(\d{2}).(\d{3})/;
export const parseSubtitleTimestamp = (string: string) => {
	const match = timestampRegex.exec(string);
	if (!match) throw new Error('Expected match.');

	return 60 * 60 * 1000 * Number(match[1] || '0')
		+ 60 * 1000 * Number(match[2])
		+ 1000 * Number(match[3])
		+ Number(match[4]);
};

export const formatSubtitleTimestamp = (timestamp: number) => {
	const hours = Math.floor(timestamp / (60 * 60 * 1000));
	const minutes = Math.floor((timestamp % (60 * 60 * 1000)) / (60 * 1000));
	const seconds = Math.floor((timestamp % (60 * 1000)) / 1000);
	const milliseconds = timestamp % 1000;

	return hours.toString().padStart(2, '0') + ':'
		+ minutes.toString().padStart(2, '0') + ':'
		+ seconds.toString().padStart(2, '0') + '.'
		+ milliseconds.toString().padStart(3, '0');
};

/**
 * A cue timing line by the rules of the W3C WebVTT parser ("collect WebVTT cue timings and settings"): timestamps whose
 * minutes and seconds have two digits (checked to be at most 59 by the caller), with three-digit fractions and hours of
 * any number of digits, and nothing but spaces or tabs before the start time. A comma before the fraction, as SubRip
 * writes, is let through, as it always was.
 */
const cueTimestampPattern = String.raw`(?:\d+:)?(\d{2}):(\d{2})[.,]\d{3}`;
const cueTimingLineRegex = new RegExp(
	String.raw`^[ \t\f]*${cueTimestampPattern}[ \t\f]*-->[ \t\f]*${cueTimestampPattern}(?!\d)`,
);

/**
 * Delimits the cue blocks as the W3C WebVTT parser does. Blocks are runs of non-empty lines. A block whose first
 * line, or second line after an identifier, contains "-->" is a cue, and a later line of a block containing "-->"
 * starts a new block, as does one in the header; an empty line is put before such a line, so that the line before it
 * isn't taken for the identifier of its cue. A cue block whose timing line is invalid is removed as a whole, so that
 * none of it ends up in the header or in another cue. Empty lines all stay.
 */
const delimitCueBlocks = (text: string, startsWithHeader: boolean) => {
	const lines = text.split('\n');
	const delimited: string[] = [];
	let changed = false;
	let inHeader = startsWithHeader;
	let blockLineCount = 0;
	let seenArrow = false;
	let inInvalidCue = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line === '') {
			inHeader = false;
			blockLineCount = 0;
			seenArrow = false;
			inInvalidCue = false;
		} else if (line.includes('-->') && !(inHeader && i === 0)) {
			if (inHeader || blockLineCount >= 2 || seenArrow) {
				// This line starts a new block. Mark that with an empty line, unless the previous block was removed.
				if (!inInvalidCue) {
					delimited.push('');
					changed = true;
				}

				inHeader = false;
				blockLineCount = 0;
				inInvalidCue = false;
			}

			seenArrow = true;
			const match = cueTimingLineRegex.exec(line);
			if (!match || match.slice(1).some(value => Number(value) > 59)) {
				inInvalidCue = true;
				changed = true;
				if (blockLineCount === 1) {
					delimited.pop(); // The cue's identifier
				}
			}
		} else if (inInvalidCue) {
			changed = true;
		}

		if (line !== '') {
			blockLineCount++;
		}
		if (!inInvalidCue || line === '') {
			delimited.push(line);
		}
	}

	return changed ? delimited.join('\n') : text;
};
