/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Mediabunny's declarations for TypeScript before 5.8 (package.json routes those versions here). They add the one type
// that @types/dom-webcodecs 0.1.19 takes from the DOM lib of TypeScript 5.8+, declared as it is there.

declare global {
	type ImageBufferSource = AllowSharedBufferSource | ReadableStream;
}

export * from '../../dist/modules/src/index.js';
