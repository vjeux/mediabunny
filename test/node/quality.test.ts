import { expect, test } from 'vitest';
import { Quality, QualityOptions } from '../../src/encode.js';

test('Quality treats options set to undefined as not provided', () => {
	// Like options forwarded from a settings object where only some are set
	const settings: { bitrate?: number; quantizer?: number; preferBitrate?: boolean } = {};

	expect(new Quality({ quality: 'high', bitrate: settings.bitrate, quantizer: settings.quantizer }))
		.toEqual(new Quality('high'));
	expect(new Quality({ quality: 0.3, preferBitrate: settings.preferBitrate })).toEqual(new Quality(0.3));
	expect(new Quality({ bitrate: 1e6, preferBitrate: settings.preferBitrate }))
		.toEqual(new Quality({ bitrate: 1e6 }));
	expect(new Quality({ quality: undefined, bitrate: 1e6 } as QualityOptions))
		.toEqual(new Quality({ bitrate: 1e6 }));
	expect(new Quality({ quantizer: 30, bitrate: settings.bitrate })).toEqual(new Quality({ quantizer: 30 }));
});

test('Quality rejects provided options that don\'t go together', () => {
	expect(() => new Quality({ quality: 'high', bitrate: 1e6 })).toThrow(TypeError);
	expect(() => new Quality({ quality: 'high', quantizer: 30 })).toThrow(TypeError);
	expect(() => new Quality({ bitrate: 1e6, preferBitrate: true } as QualityOptions)).toThrow(TypeError);
	expect(() => new Quality({ quality: null } as unknown as QualityOptions)).toThrow(TypeError);
	expect(() => new Quality({ bitrate: undefined, quantizer: undefined })).toThrow(TypeError);
});
