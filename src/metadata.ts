/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { isRecordStringString } from './misc';

/**
 * Represents descriptive (non-technical) metadata about a media file, such as title, author, date, cover art, or other
 * attached files. Common tags are normalized by Mediabunny into a uniform format, while the `raw` field can be used to
 * directly read or write the underlying metadata tags (which differ by format).
 *
 * - For MP4/QuickTime files, the metadata refers to the data in `'moov'`-level `'udta'` and `'meta'` atoms.
 * - For WebM/Matroska files, the metadata refers to the Tags and Attachments elements whose target is 50 (MOVIE).
 * WebM output leaves out Attachments (images and attached files), which WebM doesn't support.
 * - For MP3 files, the metadata refers to the ID3v2 or ID3v1 tags.
 * - For Ogg files, there is no global metadata so instead, the metadata refers to the combined metadata of all tracks,
 * in Vorbis-style comment headers.
 * - For WAVE files, the metadata refers to the chunks within the RIFF INFO chunk.
 * - For ADTS files, the metadata refers to the ID3v2 tags.
 * - For FLAC files, the metadata lives in Vorbis style in the Vorbis comment block, or sometimes in ID3v2 tags at the
 * start of the file.
 * - For MPEG-TS files, metadata tags are currently not supported.
 *
 * @group Metadata tags
 * @public
 */
export type MetadataTags = {
	/** Title of the media (e.g. Gangnam Style, Titanic, etc.) */
	title?: string;
	/** Short description or subtitle of the media. */
	description?: string;
	/** Primary artist(s) or creator(s) of the work. */
	artist?: string;
	/** Album, collection, or compilation the media belongs to. */
	album?: string;
	/** Main credited artist for the album/collection as a whole. */
	albumArtist?: string;
	/** Position of this track within its album or collection (1-based). */
	trackNumber?: number;
	/** Total number of tracks in the album or collection. */
	tracksTotal?: number;
	/** Disc index if the release spans multiple discs (1-based). */
	discNumber?: number;
	/** Total number of discs in the release. */
	discsTotal?: number;
	/** The beats per minute (BPM) of the media. */
	beatsPerMinute?: number;
	/** Genre or category describing the media's style or content (e.g. Metal, Horror, etc.) */
	genre?: string;
	/** Release, recording or creation date of the media. */
	date?: Date;
	/** Full text lyrics or transcript associated with the media. */
	lyrics?: string;
	/** Freeform notes, remarks or commentary about the media. */
	comment?: string;
	/** Embedded images such as cover art, booklet scans, artwork or preview frames. */
	images?: AttachedImage[];
	/** The time at which the media file itself was created.
	 *
	 * When writing, leaving this field undefined will write the current date and time to the formats that support this
	 * field. If you don't want to write this info, set this field to `null` instead.
	 */
	creationTime?: Date | null;
	/**
	 * The raw, underlying metadata tags.
	 *
	 * This field can be used for both reading and writing. When reading, it represents the original tags that were used
	 * to derive the normalized fields, and any additional metadata that Mediabunny doesn't understand. When writing, it
	 * can be used to set arbitrary metadata tags in the output file.
	 *
	 * The format of these tags differs per format:
	 * - MP4/QuickTime: By default, the keys refer to the names of the individual atoms in the `'ilst'` atom inside the
	 * `'meta'` atom, and the values are derived from the content of the `'data'` atom inside them. When a `'keys'` atom
	 * is also used, then the keys reflect the keys specified there (such as `'com.apple.quicktime.version'`).
	 * iTunes freeform (`'----'`) items are keyed by their domain and name, like `'----:com.apple.iTunes:iTunSMPB'`.
	 * Additionally, any atoms within the `'udta'` atom are dumped into here, however with unknown internal format
	 * (`Uint8Array`).
	 * - WebM/Matroska: `SimpleTag` elements whose target is 50 (MOVIE), either containing string or `Uint8Array`
	 * values. Additionally, all attached files (such as font files) are included here, where the key corresponds to
	 * the FileUID and the value is an {@link AttachedFile}.
	 * - MP3: The ID3v2 tags, or a single `'TAG'` key with the contents of the ID3v1 tag. The ID3v2 `'TXXX'`
	 * user-defined text frames are exposed as a `Record<string, string>`. If a non-text frame exists more than once,
	 * a array of `Uint8Array` is used instead.
	 * - ADTS: The ID3v2 tags, just like in MP3.
	 * - Ogg: The key-value string pairs from the Vorbis-style comment header (see RFC 7845, Section 5.2).
	 * Additionally, the `'vendor'` key refers to the vendor string within this header. If a key exists more than once,
	 * a string array is used instead.
	 * - WAVE: The individual metadata chunks within the RIFF INFO chunk. Values are always ISO 8859-1 strings.
	 * - FLAC: The key-value string pairs from the vorbis metadata block (see RFC 9639, Section D.2.3).
	 * Additionally, the `'vendor'` key refers to the vendor string within this header. If a key exists more than once,
	 * a string array is used instead. If ID3v2 tags appear at the start of the file, their content is stored just like
	 * for MP3.
	 * - MPEG-TS: Not supported.
	*/
	raw?: Record<
		string,
		string | string[] | Uint8Array | Uint8Array[] | RichImageData | AttachedFile | Record<string, string> | null
	>;
};

/** Deep-copies tags, so that changing the copy (Dates and image bytes included) leaves the original untouched. */
export const cloneMetadataTags = (tags: MetadataTags): MetadataTags => {
	const copy: MetadataTags = { ...tags };
	if (tags.date) {
		copy.date = new Date(tags.date.getTime());
	}
	if (tags.creationTime) {
		copy.creationTime = new Date(tags.creationTime.getTime());
	}
	if (tags.images) {
		copy.images = tags.images.map(image => ({ ...image, data: image.data.slice() }));
	}
	if (tags.raw) {
		copy.raw = {};
		for (const key in tags.raw) {
			copy.raw[key] = cloneRawTagValue(tags.raw[key]!);
		}
	}

	return copy;
};

type RawTagValue = NonNullable<MetadataTags['raw']>[string];

const cloneRawTagValue = (value: RawTagValue): RawTagValue => {
	if (value instanceof Uint8Array) {
		return value.slice();
	} else if (Array.isArray(value)) {
		return value.map(item => (item instanceof Uint8Array ? item.slice() : item)) as string[] | Uint8Array[];
	} else if (value instanceof RichImageData) {
		return new RichImageData(value.data.slice(), value.mimeType);
	} else if (value instanceof AttachedFile) {
		return new AttachedFile(value.data.slice(), value.mimeType, value.name, value.description);
	} else if (value && typeof value === 'object') {
		return { ...value };
	} else {
		return value;
	}
};

/**
 * An embedded image such as cover art, booklet scan, artwork or preview frame.
 *
 * @group Metadata tags
 * @public
 */
export type AttachedImage = {
	/** The raw image data. */
	data: Uint8Array;
	/** An RFC 6838 MIME type (e.g. image/jpeg, image/png, etc.) */
	mimeType: string;
	/** The kind or purpose of the image. */
	kind: 'coverFront' | 'coverBack' | 'unknown';
	/** The name of the image file. */
	name?: string;
	/** A description of the image. */
	description?: string;
};

/**
 * Image data with additional metadata.
 *
 * @group Metadata tags
 * @public
 */
export class RichImageData {
	/** Creates a new {@link RichImageData}. */
	constructor(
		/** The raw image data. */
		public data: Uint8Array,
		/** An RFC 6838 MIME type (e.g. image/jpeg, image/png, etc.) */
		public mimeType: string,
	) {
		if (!(data instanceof Uint8Array)) {
			throw new TypeError('data must be a Uint8Array.');
		}
		if (typeof mimeType !== 'string') {
			throw new TypeError('mimeType must be a string.');
		}
	}
}

/**
 * A file attached to a media file.
 *
 * @group Metadata tags
 * @public
 */
export class AttachedFile {
	/** Creates a new {@link AttachedFile}. */
	constructor(
		/** The raw file data. */
		public data: Uint8Array,
		/** An RFC 6838 MIME type (e.g. image/jpeg, image/png, font/ttf, etc.) */
		public mimeType?: string,
		/** The name of the file. */
		public name?: string,
		/** A description of the file. */
		public description?: string,
	) {
		if (!(data instanceof Uint8Array)) {
			throw new TypeError('data must be a Uint8Array.');
		}
		if (mimeType !== undefined && typeof mimeType !== 'string') {
			throw new TypeError('mimeType, when provided, must be a string.');
		}
		if (name !== undefined && typeof name !== 'string') {
			throw new TypeError('name, when provided, must be a string.');
		}
		if (description !== undefined && typeof description !== 'string') {
			throw new TypeError('description, when provided, must be a string.');
		}
	}
};

export const validateMetadataTags = (tags: MetadataTags) => {
	if (!tags || typeof tags !== 'object') {
		throw new TypeError('tags must be an object.');
	}
	if (tags.title !== undefined && typeof tags.title !== 'string') {
		throw new TypeError('tags.title, when provided, must be a string.');
	}
	if (tags.description !== undefined && typeof tags.description !== 'string') {
		throw new TypeError('tags.description, when provided, must be a string.');
	}
	if (tags.artist !== undefined && typeof tags.artist !== 'string') {
		throw new TypeError('tags.artist, when provided, must be a string.');
	}
	if (tags.album !== undefined && typeof tags.album !== 'string') {
		throw new TypeError('tags.album, when provided, must be a string.');
	}
	if (tags.albumArtist !== undefined && typeof tags.albumArtist !== 'string') {
		throw new TypeError('tags.albumArtist, when provided, must be a string.');
	}
	if (tags.trackNumber !== undefined && (!Number.isInteger(tags.trackNumber) || tags.trackNumber <= 0)) {
		throw new TypeError('tags.trackNumber, when provided, must be a positive integer.');
	}
	if (
		tags.tracksTotal !== undefined
		&& (!Number.isInteger(tags.tracksTotal) || tags.tracksTotal <= 0)
	) {
		throw new TypeError('tags.tracksTotal, when provided, must be a positive integer.');
	}
	if (tags.discNumber !== undefined && (!Number.isInteger(tags.discNumber) || tags.discNumber <= 0)) {
		throw new TypeError('tags.discNumber, when provided, must be a positive integer.');
	}
	if (
		tags.discsTotal !== undefined
		&& (!Number.isInteger(tags.discsTotal) || tags.discsTotal <= 0)
	) {
		throw new TypeError('tags.discsTotal, when provided, must be a positive integer.');
	}
	if (tags.genre !== undefined && typeof tags.genre !== 'string') {
		throw new TypeError('tags.genre, when provided, must be a string.');
	}
	if (tags.date !== undefined && (!(tags.date instanceof Date) || Number.isNaN(tags.date.getTime()))) {
		throw new TypeError('tags.date, when provided, must be a valid Date.');
	}
	if (
		tags.creationTime !== undefined
		&& tags.creationTime !== null
		&& (!(tags.creationTime instanceof Date) || Number.isNaN(tags.creationTime.getTime()))
	) {
		throw new TypeError('tags.creationTime, when provided, must be a valid Date or null.');
	}
	if (
		tags.beatsPerMinute !== undefined
		&& (!Number.isInteger(tags.beatsPerMinute) || tags.beatsPerMinute <= 0)
	) {
		throw new TypeError('tags.beatsPerMinute, when provided, must be a positive integer.');
	}
	if (tags.lyrics !== undefined && typeof tags.lyrics !== 'string') {
		throw new TypeError('tags.lyrics, when provided, must be a string.');
	}
	if (tags.images !== undefined) {
		if (!Array.isArray(tags.images)) {
			throw new TypeError('tags.images, when provided, must be an array.');
		}
		for (const image of tags.images) {
			if (!image || typeof image !== 'object') {
				throw new TypeError('Each image in tags.images must be an object.');
			}
			if (!(image.data instanceof Uint8Array)) {
				throw new TypeError('Each image.data must be a Uint8Array.');
			}
			if (typeof image.mimeType !== 'string') {
				throw new TypeError('Each image.mimeType must be a string.');
			}
			if (!['coverFront', 'coverBack', 'unknown'].includes(image.kind)) {
				throw new TypeError('Each image.kind must be \'coverFront\', \'coverBack\', or \'unknown\'.');
			}
		}
	}
	if (tags.comment !== undefined && typeof tags.comment !== 'string') {
		throw new TypeError('tags.comment, when provided, must be a string.');
	}
	if (tags.raw !== undefined) {
		if (!tags.raw || typeof tags.raw !== 'object') {
			throw new TypeError('tags.raw, when provided, must be an object.');
		}

		for (const value of Object.values(tags.raw)) {
			if (
				value !== null
				&& typeof value !== 'string'
				&& !(Array.isArray(value) && value.every(x => typeof x === 'string'))
				&& !(value instanceof Uint8Array)
				&& !(Array.isArray(value) && value.every(x => x instanceof Uint8Array))
				&& !(value instanceof RichImageData)
				&& !(value instanceof AttachedFile)
				&& !isRecordStringString(value)
			) {
				throw new TypeError(
					'Each value in tags.raw must be a string, string array, Uint8Array, Uint8Array array,'
					+ ' RichImageData, AttachedFile, Record<string, string>, or null.',
				);
			}
		}
	}
};

/**
 * Formats a date as YYYY-MM-DD, the shape every format stores dates in. Returns null for years outside 0 to 9999,
 * which those fields can't hold (toISOString uses the expanded ±YYYYYY form for them).
 */
export const formatMetadataDate = (date: Date) => {
	const year = date.getUTCFullYear();
	if (year < 0 || year > 9999) {
		return null;
	}

	return date.toISOString().slice(0, 10);
};

export const metadataTagsAreEmpty = (tags: MetadataTags) => {
	return tags.title === undefined
		&& tags.description === undefined
		&& tags.artist === undefined
		&& tags.album === undefined
		&& tags.albumArtist === undefined
		&& tags.trackNumber === undefined
		&& tags.tracksTotal === undefined
		&& tags.discNumber === undefined
		&& tags.discsTotal === undefined
		&& tags.genre === undefined
		&& tags.beatsPerMinute === undefined
		&& tags.date === undefined
		&& tags.lyrics === undefined
		&& (!tags.images || tags.images.length === 0)
		&& tags.comment === undefined
		&& (tags.raw === undefined || Object.keys(tags.raw).length === 0);
};

/** For the raw tags a demuxer read, which normalized fields each raw tag was read into (used by conversions). */
const rawMetadataTagFields = new WeakMap<NonNullable<MetadataTags['raw']>, Map<string, Set<keyof MetadataTags>>>();

const RAW_BACKED_FIELDS = [
	'title', 'description', 'artist', 'album', 'albumArtist', 'trackNumber', 'tracksTotal', 'discNumber', 'discsTotal',
	'beatsPerMinute', 'genre', 'date', 'lyrics', 'comment', 'images',
] as const satisfies (keyof MetadataTags)[];

type MetadataTagFieldWatch = {
	/** The raw tag being read, or null if there's none */
	rawKey: string | null;
	/** The values of the fields that were already set, which go through the getters and setters meanwhile */
	values: Map<keyof MetadataTags, unknown>;
	/** The getters installed, to tell whether a field still has one */
	getters: Map<keyof MetadataTags, () => unknown>;
	/** Which of the watched fields the reader read or wrote */
	accessed: Set<keyof MetadataTags>;
};

/** The watch open on each tags object */
const openMetadataTagFieldWatches = new WeakMap<MetadataTags, MetadataTagFieldWatch>();

/**
 * Starts watching which normalized fields a reader uses while it reads the raw tag with the given key. Readers keep a
 * field's first value (`??=`), so a raw tag for a field that an earlier tag block or key already set doesn't change
 * it, but the reader still reads it. So until unwatchMetadataTagFields, the fields already set temporarily become
 * getters and setters that note every read and write; their values don't change.
 */
export const watchMetadataTagFields = (tags: MetadataTags, rawKey: string | null) => {
	unwatchMetadataTagFields(tags); // In case a reader left one open

	const watch: MetadataTagFieldWatch = { rawKey, values: new Map(), getters: new Map(), accessed: new Set() };
	for (const field of RAW_BACKED_FIELDS) {
		if (tags[field] === undefined) {
			continue;
		}

		const get = () => {
			watch.accessed.add(field);
			return watch.values.get(field);
		};
		watch.values.set(field, tags[field]);
		watch.getters.set(field, get);
		Object.defineProperty(tags, field, {
			get,
			set: (value: unknown) => {
				watch.accessed.add(field);
				watch.values.set(field, value);
			},
			enumerable: true,
			configurable: true,
		});
	}

	openMetadataTagFieldWatches.set(tags, watch);
};

/**
 * Ends the watch open on the given tags, if any: turns the watched fields back into plain data properties, in place so
 * that the order of the keys stays the same, and records which fields the raw tag was read into (the watched fields
 * the reader used, and those it set). Readers that can throw midway also call it in a `finally`.
 */
export const unwatchMetadataTagFields = (tags: MetadataTags) => {
	const watch = openMetadataTagFieldWatches.get(tags);
	if (!watch) {
		return;
	}

	openMetadataTagFieldWatches.delete(tags);
	for (const [field, value] of watch.values) {
		// Unless something replaced or removed the property meanwhile
		if (Object.getOwnPropertyDescriptor(tags, field)?.get === watch.getters.get(field)) {
			Object.defineProperty(tags, field, { value, writable: true, enumerable: true, configurable: true });
		}
	}

	if (watch.rawKey === null) {
		return;
	}

	const fields = RAW_BACKED_FIELDS.filter((field) => {
		if (watch.values.has(field)) {
			return watch.accessed.has(field);
		}

		const value = tags[field];
		return value !== undefined && !(Array.isArray(value) && value.length === 0);
	});
	recordRawMetadataTagFields(tags, watch.rawKey, fields);
};

/**
 * Records that the raw tag with the given key was read into the given fields. For readers that set a field after
 * reading its raw tags, out of reach of the watch.
 */
export const recordRawMetadataTagFields = (tags: MetadataTags, rawKey: string, fields: (keyof MetadataTags)[]) => {
	if (!tags.raw || fields.length === 0) {
		return;
	}

	let fieldsByRawKey = rawMetadataTagFields.get(tags.raw);
	if (!fieldsByRawKey) {
		fieldsByRawKey = new Map();
		rawMetadataTagFields.set(tags.raw, fieldsByRawKey);
	}

	let recorded = fieldsByRawKey.get(rawKey);
	if (!recorded) {
		recorded = new Set();
		fieldsByRawKey.set(rawKey, recorded);
	}

	for (const field of fields) {
		recorded.add(field);
	}
};

/** Returns which normalized fields each of the given raw tags was read into, if a demuxer recorded it. */
export const getRawMetadataTagFields = (raw: NonNullable<MetadataTags['raw']>) => rawMetadataTagFields.get(raw);

/**
 * Specifies a track's disposition, i.e. information about its intended usage.
 * @public
 * @group Miscellaneous
 */
export type TrackDisposition = {
	/**
	 * Indicates that this track is eligible for automatic selection by a player. Multiple tracks can be default tracks.
	 */
	default: boolean;
	/** Indicates that the track is the primary track among other tracks of its type. */
	primary: boolean;
	/**
	 * Indicates that players should always display this track by default, even if it goes against the user's default
	 * preferences. For example, a subtitle track only containing translations of foreign-language audio.
	 */
	forced: boolean;
	/** Indicates that this track is in the content's original language. */
	original: boolean;
	/** Indicates that this track contains commentary. */
	commentary: boolean;
	/** Indicates that this track is intended for hearing-impaired users. */
	hearingImpaired: boolean;
	/** Indicates that this track is intended for visually-impaired users. */
	visuallyImpaired: boolean;
};

export const DEFAULT_TRACK_DISPOSITION: TrackDisposition = {
	default: true,
	primary: true,
	forced: false,
	original: false,
	commentary: false,
	hearingImpaired: false,
	visuallyImpaired: false,
};

export const validateTrackDisposition = (disposition: Partial<TrackDisposition>) => {
	if (!disposition || typeof disposition !== 'object') {
		throw new TypeError('disposition must be an object.');
	}
	if (disposition.default !== undefined && typeof disposition.default !== 'boolean') {
		throw new TypeError('disposition.default must be a boolean.');
	}
	if (disposition.primary !== undefined && typeof disposition.primary !== 'boolean') {
		throw new TypeError('disposition.primary must be a boolean.');
	}
	if (disposition.forced !== undefined && typeof disposition.forced !== 'boolean') {
		throw new TypeError('disposition.forced must be a boolean.');
	}
	if (disposition.original !== undefined && typeof disposition.original !== 'boolean') {
		throw new TypeError('disposition.original must be a boolean.');
	}
	if (disposition.commentary !== undefined && typeof disposition.commentary !== 'boolean') {
		throw new TypeError('disposition.commentary must be a boolean.');
	}
	if (disposition.hearingImpaired !== undefined && typeof disposition.hearingImpaired !== 'boolean') {
		throw new TypeError('disposition.hearingImpaired must be a boolean.');
	}
	if (disposition.visuallyImpaired !== undefined && typeof disposition.visuallyImpaired !== 'boolean') {
		throw new TypeError('disposition.visuallyImpaired must be a boolean.');
	}
};
