import { expect, test } from 'vitest';
import { BufferSource, Logging } from '../../src/index.js';

test('on() rejects listeners that would only fail once the event fires', () => {
	const source = new BufferSource(new Uint8Array(4));

	for (const listener of ['handler', null, {}]) {
		expect(() => source.on('read', listener as never)).toThrow(new TypeError('listener must be a function.'));
		expect(() => Logging.on('warn', listener as never)).toThrow(new TypeError('listener must be a function.'));
	}
	expect(() => source.on('read', () => {}, null as never)).toThrow(
		new TypeError('options, when provided, must be an object.'),
	);
	expect(() => source.on('read', () => {}, { once: 'yes' } as never)).toThrow(
		new TypeError('options.once, when provided, must be a boolean.'),
	);
});
