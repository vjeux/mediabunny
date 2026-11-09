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

const cueBlockHeaderRegex = /(?:(.+?)\n)?((?:\d{2}:)?\d{2}:\d{2}.\d{3})\s+-->\s+((?:\d{2}:)?\d{2}:\d{2}.\d{3})/g;
const preambleStartRegex = /^WEBVTT(.|\n)*?\n{2}/;
export const inlineTimestampRegex = /<(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})>/g;

export class SubtitleParser {
	private options: SubtitleParserOptions;
	private preambleText: string | null = null;
	private preambleEmitted = false;

	constructor(options: SubtitleParserOptions) {
		this.options = options;
	}

	parse(text: string) {
		text = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
		text = delimitCueBlocks(text, !this.preambleText);

		cueBlockHeaderRegex.lastIndex = 0;
		let match: RegExpMatchArray | null;

		if (!this.preambleText) {
			if (!preambleStartRegex.test(text)) {
				throw new Error('WebVTT preamble incorrect.');
			}

			match = cueBlockHeaderRegex.exec(text);
			const preamble = text.slice(0, match?.index ?? text.length).trimEnd();

			if (!preamble) {
				throw new Error('No WebVTT preamble provided.');
			}

			this.preambleText = preamble;

			if (match) {
				text = text.slice(match.index);
				cueBlockHeaderRegex.lastIndex = 0;
			}
		}

		while ((match = cueBlockHeaderRegex.exec(text))) {
			const notes = text.slice(0, match.index);
			const cueIdentifier = match[1];
			const matchEnd = match.index! + match[0].length;
			const bodyStart = text.indexOf('\n', matchEnd) + 1;
			const cueSettings = text.slice(matchEnd, bodyStart).trim();
			let bodyEnd = text.indexOf('\n\n', matchEnd);
			if (bodyEnd === -1) bodyEnd = text.length;

			const startTime = parseSubtitleTimestamp(match[2]!);
			const endTime = parseSubtitleTimestamp(match[3]!);
			const duration = endTime - startTime;

			const body = text.slice(bodyStart, bodyEnd).trim();

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

			const meta: SubtitleMetadata = {};
			if (!this.preambleEmitted) {
				meta.config = {
					description: this.preambleText,
				};
				this.preambleEmitted = true;
			}

			this.options.output(cue, meta);
		}
	}
}

const timestampRegex = /(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})/;
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
