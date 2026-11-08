/**
 * A checker for the playlist grammar and rules of RFC 8216 (and draft-pantos-hls-rfc8216bis where it is stricter),
 * used to validate the playlists Mediabunny writes. Returns a list of violations; empty means valid.
 */

const ATTRIBUTE_NAME = /^[A-Z0-9-]+$/;
const DECIMAL_INTEGER = /^\d{1,20}$/;
const SIGNED_DECIMAL_FLOAT = /^-?\d+(\.\d+)?$/;
const DECIMAL_FLOAT = /^\d+(\.\d+)?$/;
const HEX_SEQUENCE = /^0[xX][0-9a-fA-F]+$/;
const RESOLUTION = /^\d+x\d+$/;
const ENUMERATED_STRING = /^[^\s",]+$/;

type AttributeValue = { raw: string; quoted: boolean };

/** Parses an attribute list strictly per RFC 8216, Section 4.2. */
export const parseAttributeListStrict = (text: string, errors: string[], context: string) => {
	const attributes = new Map<string, AttributeValue>();
	let i = 0;

	while (i < text.length) {
		const equalsIndex = text.indexOf('=', i);
		if (equalsIndex === -1) {
			errors.push(`${context}: attribute without value at "${text.slice(i)}"`);
			break;
		}

		const name = text.slice(i, equalsIndex);
		if (!ATTRIBUTE_NAME.test(name)) {
			errors.push(`${context}: invalid AttributeName "${name}"`);
		}
		if (attributes.has(name)) {
			errors.push(`${context}: duplicate AttributeName "${name}"`);
		}

		let value: AttributeValue;
		i = equalsIndex + 1;
		if (text[i] === '"') {
			const closingIndex = text.indexOf('"', i + 1);
			if (closingIndex === -1) {
				errors.push(`${context}: unterminated quoted-string for ${name}`);
				break;
			}

			value = { raw: text.slice(i + 1, closingIndex), quoted: true };
			if (/[\r\n]/.test(value.raw)) {
				errors.push(`${context}: quoted-string with a line break for ${name}`);
			}
			i = closingIndex + 1;
		} else {
			const commaIndex = text.indexOf(',', i);
			const end = commaIndex === -1 ? text.length : commaIndex;
			value = { raw: text.slice(i, end), quoted: false };
			if (!ENUMERATED_STRING.test(value.raw)) {
				errors.push(`${context}: invalid unquoted value "${value.raw}" for ${name}`);
			}
			i = end;
		}

		attributes.set(name, value);

		if (i < text.length) {
			if (text[i] !== ',') {
				errors.push(`${context}: expected a comma after ${name}`);
				break;
			}
			i++;
		}
	}

	return attributes;
};

const expectType = (
	attributes: Map<string, AttributeValue>,
	name: string,
	type: 'quoted' | 'integer' | 'float' | 'signed-float' | 'hex' | 'resolution' | 'enum',
	errors: string[],
	context: string,
) => {
	const value = attributes.get(name);
	if (!value) {
		return;
	}

	const ok = type === 'quoted'
		? value.quoted
		: !value.quoted && {
				'integer': DECIMAL_INTEGER,
				'float': DECIMAL_FLOAT,
				'signed-float': SIGNED_DECIMAL_FLOAT,
				'hex': HEX_SEQUENCE,
				'resolution': RESOLUTION,
				'enum': ENUMERATED_STRING,
			}[type].test(value.raw);

	if (!ok) {
		errors.push(`${context}: ${name}=${value.quoted ? `"${value.raw}"` : value.raw} is not a valid ${type}`);
	}
};

const splitLines = (text: string, errors: string[]) => {
	if (text.charCodeAt(0) === 0xfeff) {
		errors.push('playlist starts with a byte order mark');
	}
	if (text.includes('\r')) {
		// Allowed, but Mediabunny writes plain line feeds
		errors.push('playlist contains carriage returns');
	}

	const lines = text.split('\n');
	if (lines[0] !== '#EXTM3U') {
		errors.push('first line is not #EXTM3U');
	}

	return lines;
};

const tagOf = (line: string) => {
	const colonIndex = line.indexOf(':');
	if (colonIndex === -1) {
		return { name: line, value: null };
	}

	return { name: line.slice(0, colonIndex), value: line.slice(colonIndex + 1) };
};

export type MediaPlaylistInfo = {
	version: number;
	targetDuration: number | null;
	mediaSequence: number;
	segments: {
		uri: string;
		duration: number;
		byteRange: { length: number; offset: number | null } | null;
		programDateTime: string | null;
	}[];
	map: { uri: string; byteRange: string | null } | null;
	ended: boolean;
	playlistType: string | null;
	iFramesOnly: boolean;
	independentSegments: boolean;
};

const MEDIA_PLAYLIST_TAGS = new Set([
	'#EXTM3U', '#EXT-X-VERSION', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-START', '#EXT-X-DEFINE',
	'#EXT-X-TARGETDURATION', '#EXT-X-MEDIA-SEQUENCE', '#EXT-X-DISCONTINUITY-SEQUENCE', '#EXT-X-ENDLIST',
	'#EXT-X-PLAYLIST-TYPE', '#EXT-X-I-FRAMES-ONLY', '#EXTINF', '#EXT-X-BYTERANGE', '#EXT-X-DISCONTINUITY',
	'#EXT-X-KEY', '#EXT-X-MAP', '#EXT-X-PROGRAM-DATE-TIME', '#EXT-X-GAP', '#EXT-X-BITRATE', '#EXT-X-DATERANGE',
]);

/** Validates a media playlist; also returns the information parsed from it. */
export const validateMediaPlaylist = (text: string) => {
	const errors: string[] = [];
	const lines = splitLines(text, errors);

	const info: MediaPlaylistInfo = {
		version: 1,
		targetDuration: null,
		mediaSequence: 0,
		segments: [],
		map: null,
		ended: false,
		playlistType: null,
		iFramesOnly: false,
		independentSegments: false,
	};

	let pendingDuration: number | null = null;
	let pendingByteRange: MediaPlaylistInfo['segments'][number]['byteRange'] = null;
	let pendingDateTime: string | null = null;
	let versionSeen = false;
	let usesFloatDurations = false;
	let usesByteRanges = false;

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.length === 0) {
			continue;
		}
		if (line !== line.trim()) {
			errors.push(`line ${i + 1} has surrounding whitespace`);
		}
		if (info.ended) {
			errors.push(`line ${i + 1} follows #EXT-X-ENDLIST`);
		}

		if (!line.startsWith('#')) {
			if (pendingDuration === null) {
				errors.push(`segment "${line}" has no #EXTINF`);
			}
			info.segments.push({
				uri: line,
				duration: pendingDuration ?? 0,
				byteRange: pendingByteRange,
				programDateTime: pendingDateTime,
			});
			pendingDuration = null;
			pendingByteRange = null;
			pendingDateTime = null;
			continue;
		}

		if (!line.startsWith('#EXT')) {
			continue; // Comment
		}

		const { name, value } = tagOf(line);
		const context = `line ${i + 1} (${name})`;
		if (!MEDIA_PLAYLIST_TAGS.has(name)) {
			errors.push(`${context}: tag not allowed in a media playlist`);
			continue;
		}

		if (name === '#EXT-X-VERSION') {
			if (versionSeen) {
				errors.push(`${context}: duplicate`);
			}
			versionSeen = true;
			if (!value || !DECIMAL_INTEGER.test(value)) {
				errors.push(`${context}: not a decimal-integer`);
			}
			info.version = Number(value);
		} else if (name === '#EXT-X-TARGETDURATION') {
			if (info.targetDuration !== null) {
				errors.push(`${context}: duplicate`);
			}
			if (!value || !DECIMAL_INTEGER.test(value)) {
				errors.push(`${context}: "${value}" is not a decimal-integer`);
			}
			info.targetDuration = Number(value);
		} else if (name === '#EXT-X-MEDIA-SEQUENCE') {
			if (info.segments.length > 0) {
				errors.push(`${context}: appears after a segment`);
			}
			if (!value || !DECIMAL_INTEGER.test(value)) {
				errors.push(`${context}: not a decimal-integer`);
			}
			info.mediaSequence = Number(value);
		} else if (name === '#EXTINF') {
			const match = /^(\d+(?:\.\d+)?),(.*)$/.exec(value ?? '');
			if (!match) {
				errors.push(`${context}: "${value}" is not <duration>,[<title>]`);
			} else {
				pendingDuration = Number(match[1]);
				usesFloatDurations ||= match[1]!.includes('.');
			}
		} else if (name === '#EXT-X-BYTERANGE') {
			usesByteRanges = true;
			const match = /^(\d+)(?:@(\d+))?$/.exec(value ?? '');
			if (!match) {
				errors.push(`${context}: "${value}" is not <n>[@<o>]`);
			} else {
				pendingByteRange = {
					length: Number(match[1]),
					offset: match[2] !== undefined ? Number(match[2]) : null,
				};
				if (pendingByteRange.length === 0) {
					errors.push(`${context}: empty byte range`);
				}
			}
		} else if (name === '#EXT-X-MAP') {
			const attributes = parseAttributeListStrict(value ?? '', errors, context);
			expectType(attributes, 'URI', 'quoted', errors, context);
			expectType(attributes, 'BYTERANGE', 'quoted', errors, context);
			const uri = attributes.get('URI');
			if (!uri) {
				errors.push(`${context}: missing URI`);
			}
			const byteRange = attributes.get('BYTERANGE');
			if (byteRange && !/^\d+@\d+$/.test(byteRange.raw)) {
				errors.push(`${context}: BYTERANGE "${byteRange.raw}" is not <n>@<o>`);
			}
			info.map = { uri: uri?.raw ?? '', byteRange: byteRange?.raw ?? null };
		} else if (name === '#EXT-X-PROGRAM-DATE-TIME') {
			if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
				errors.push(`${context}: "${value}" is not an ISO 8601 date-time with a time zone`);
			}
			pendingDateTime = value;
		} else if (name === '#EXT-X-PLAYLIST-TYPE') {
			if (value !== 'VOD' && value !== 'EVENT') {
				errors.push(`${context}: "${value}" is not VOD or EVENT`);
			}
			info.playlistType = value;
		} else if (name === '#EXT-X-ENDLIST') {
			info.ended = true;
		} else if (name === '#EXT-X-I-FRAMES-ONLY') {
			info.iFramesOnly = true;
		} else if (name === '#EXT-X-INDEPENDENT-SEGMENTS') {
			info.independentSegments = true;
		}
	}

	if (pendingDuration !== null) {
		errors.push('#EXTINF without a segment URI');
	}
	if (info.targetDuration === null) {
		errors.push('missing #EXT-X-TARGETDURATION');
	} else {
		for (const segment of info.segments) {
			// RFC 8216, Section 4.3.3.1
			if (Math.round(segment.duration) > info.targetDuration) {
				errors.push(
					`segment "${segment.uri}" lasts ${segment.duration} s, more than the target duration of `
					+ `${info.targetDuration} s`,
				);
			}
		}
	}

	// RFC 8216, Section 7
	const requiredVersion = Math.max(
		usesFloatDurations ? 3 : 1,
		usesByteRanges || info.iFramesOnly ? 4 : 1,
		info.map ? (info.iFramesOnly ? 5 : 6) : 1,
	);
	if (info.version < requiredVersion) {
		errors.push(`EXT-X-VERSION ${info.version} is lower than the ${requiredVersion} required by the tags used`);
	}

	if (info.playlistType === 'VOD' && !info.ended) {
		errors.push('VOD playlist without #EXT-X-ENDLIST');
	}

	return { errors, info };
};

export type VariantInfo = {
	uri: string;
	iFrame: boolean;
	attributes: Map<string, string>;
};

export type RenditionInfo = {
	attributes: Map<string, string>;
};

const MULTIVARIANT_PLAYLIST_TAGS = new Set([
	'#EXTM3U', '#EXT-X-VERSION', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-START', '#EXT-X-DEFINE', '#EXT-X-MEDIA',
	'#EXT-X-STREAM-INF', '#EXT-X-I-FRAME-STREAM-INF', '#EXT-X-SESSION-DATA', '#EXT-X-SESSION-KEY',
	'#EXT-X-CONTENT-STEERING',
]);

/** Validates a multivariant ("master") playlist; also returns the variants and renditions parsed from it. */
export const validateMultivariantPlaylist = (text: string) => {
	const errors: string[] = [];
	const lines = splitLines(text, errors);

	const variants: VariantInfo[] = [];
	const renditions: RenditionInfo[] = [];
	let pendingStreamInf: Map<string, string> | null = null;

	const toPlain = (attributes: Map<string, AttributeValue>) => new Map([...attributes].map(([k, v]) => [k, v.raw]));

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.length === 0) {
			continue;
		}

		if (!line.startsWith('#')) {
			if (!pendingStreamInf) {
				errors.push(`URI "${line}" without #EXT-X-STREAM-INF`);
			} else {
				variants.push({ uri: line, iFrame: false, attributes: pendingStreamInf });
			}
			pendingStreamInf = null;
			continue;
		}

		if (!line.startsWith('#EXT')) {
			continue;
		}

		if (pendingStreamInf) {
			errors.push(`line ${i + 1}: a tag between #EXT-X-STREAM-INF and its URI`);
		}

		const { name, value } = tagOf(line);
		const context = `line ${i + 1} (${name})`;
		if (!MULTIVARIANT_PLAYLIST_TAGS.has(name)) {
			errors.push(`${context}: tag not allowed in a multivariant playlist`);
			continue;
		}

		if (name === '#EXT-X-STREAM-INF' || name === '#EXT-X-I-FRAME-STREAM-INF') {
			const iFrame = name === '#EXT-X-I-FRAME-STREAM-INF';
			const attributes = parseAttributeListStrict(value ?? '', errors, context);
			expectType(attributes, 'BANDWIDTH', 'integer', errors, context);
			expectType(attributes, 'AVERAGE-BANDWIDTH', 'integer', errors, context);
			expectType(attributes, 'CODECS', 'quoted', errors, context);
			expectType(attributes, 'RESOLUTION', 'resolution', errors, context);
			expectType(attributes, 'FRAME-RATE', 'float', errors, context);
			expectType(attributes, 'AUDIO', 'quoted', errors, context);
			expectType(attributes, 'VIDEO', 'quoted', errors, context);
			expectType(attributes, 'SUBTITLES', 'quoted', errors, context);
			expectType(attributes, 'URI', 'quoted', errors, context);

			const bandwidth = attributes.get('BANDWIDTH');
			if (!bandwidth) {
				errors.push(`${context}: missing BANDWIDTH`);
			} else if (Number(bandwidth.raw) === 0) {
				errors.push(`${context}: BANDWIDTH is 0`);
			}
			const frameRate = attributes.get('FRAME-RATE');
			if (frameRate && /\.\d{4,}/.test(frameRate.raw)) {
				errors.push(`${context}: FRAME-RATE has more than three decimal places`);
			}

			if (iFrame) {
				for (const forbidden of ['FRAME-RATE', 'AUDIO', 'SUBTITLES', 'CLOSED-CAPTIONS']) {
					if (attributes.has(forbidden)) {
						errors.push(`${context}: ${forbidden} isn't allowed on an I-frame stream`);
					}
				}
				const uri = attributes.get('URI');
				if (!uri) {
					errors.push(`${context}: missing URI`);
				}
				variants.push({ uri: uri?.raw ?? '', iFrame: true, attributes: toPlain(attributes) });
			} else {
				if (attributes.has('URI')) {
					errors.push(`${context}: URI isn't an attribute of #EXT-X-STREAM-INF`);
				}
				pendingStreamInf = toPlain(attributes);
			}
		} else if (name === '#EXT-X-MEDIA') {
			const attributes = parseAttributeListStrict(value ?? '', errors, context);
			for (const quoted of ['URI', 'GROUP-ID', 'LANGUAGE', 'ASSOC-LANGUAGE', 'NAME', 'INSTREAM-ID', 'CHANNELS']) {
				expectType(attributes, quoted, 'quoted', errors, context);
			}

			const type = attributes.get('TYPE')?.raw;
			if (!type || !['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS'].includes(type)) {
				errors.push(`${context}: invalid TYPE ${type}`);
			}
			for (const required of ['GROUP-ID', 'NAME']) {
				if (!attributes.has(required)) {
					errors.push(`${context}: missing ${required}`);
				}
			}
			for (const flag of ['DEFAULT', 'AUTOSELECT', 'FORCED']) {
				const flagValue = attributes.get(flag);
				if (flagValue && flagValue.raw !== 'YES' && flagValue.raw !== 'NO') {
					errors.push(`${context}: ${flag} must be YES or NO`);
				}
			}
			if (attributes.get('DEFAULT')?.raw === 'YES' && attributes.get('AUTOSELECT')?.raw === 'NO') {
				errors.push(`${context}: AUTOSELECT must be YES when DEFAULT is YES`);
			}
			if (attributes.has('FORCED') && type !== 'SUBTITLES') {
				errors.push(`${context}: FORCED is only allowed for SUBTITLES`);
			}
			if (attributes.has('INSTREAM-ID') !== (type === 'CLOSED-CAPTIONS')) {
				errors.push(`${context}: INSTREAM-ID must be present exactly for CLOSED-CAPTIONS`);
			}
			if (type === 'CLOSED-CAPTIONS' && attributes.has('URI')) {
				errors.push(`${context}: CLOSED-CAPTIONS can't have a URI`);
			}
			if (type === 'SUBTITLES' && !attributes.has('URI')) {
				errors.push(`${context}: SUBTITLES need a URI`);
			}
			const language = attributes.get('LANGUAGE');
			if (language && !/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/.test(language.raw)) {
				errors.push(`${context}: LANGUAGE "${language.raw}" isn't a language tag`);
			}

			renditions.push({ attributes: toPlain(attributes) });
		}
	}

	if (pendingStreamInf) {
		errors.push('#EXT-X-STREAM-INF without a URI');
	}

	// Rendition group rules (RFC 8216, Section 4.3.4.1.1)
	const groups = new Map<string, RenditionInfo[]>();
	for (const rendition of renditions) {
		const key = `${rendition.attributes.get('TYPE')}/${rendition.attributes.get('GROUP-ID')}`;
		groups.set(key, [...(groups.get(key) ?? []), rendition]);
	}
	for (const [key, members] of groups) {
		const names = members.map(x => x.attributes.get('NAME'));
		if (new Set(names).size !== names.length) {
			errors.push(`group ${key} has duplicate NAMEs`);
		}
		if (members.filter(x => x.attributes.get('DEFAULT') === 'YES').length > 1) {
			errors.push(`group ${key} has more than one DEFAULT=YES`);
		}
	}

	// Every group a variant references must exist with the right type
	for (const variant of variants) {
		for (const [attribute, type] of [['AUDIO', 'AUDIO'], ['VIDEO', 'VIDEO'], ['SUBTITLES', 'SUBTITLES']] as const) {
			const groupId = variant.attributes.get(attribute);
			if (groupId !== undefined && !groups.has(`${type}/${groupId}`)) {
				errors.push(`variant "${variant.uri}" references the missing ${type} group "${groupId}"`);
			}
		}
		if (!variant.attributes.has('CODECS')) {
			errors.push(`variant "${variant.uri}" has no CODECS`);
		}
	}

	return { errors, variants, renditions };
};
