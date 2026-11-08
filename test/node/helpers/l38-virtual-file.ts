import { CustomSource } from '../../../src/source.js';
import { Target } from '../../../src/target.js';

/**
 * A file that only exists as the writes made to it. Large writes (packet payloads) are kept by reference, so a muxer
 * can write a file of several GiB whose payloads are views into one buffer without the file ever existing in memory.
 * Reads assemble the requested range from the writes, later writes winning.
 */
export class VirtualFile {
	size = 0;
	writes: { start: number; end: number; data: Uint8Array }[] = [];

	write(data: Uint8Array, pos: number) {
		// Small writes can come from helper buffers the writer reuses, so they're copied
		const stored = data.byteLength <= 2 ** 16 ? data.slice() : data;
		this.writes.push({ start: pos, end: pos + data.byteLength, data: stored });
		this.size = Math.max(this.size, pos + data.byteLength);
	}

	read(start: number, end: number) {
		const bytes = new Uint8Array(end - start);
		for (const write of this.writes) {
			const from = Math.max(start, write.start);
			const to = Math.min(end, write.end);
			if (from < to) {
				bytes.set(write.data.subarray(from - write.start, to - write.start), from - start);
			}
		}

		return bytes;
	}

	toSource() {
		return new CustomSource({
			getSize: () => this.size,
			read: (start, end) => this.read(start, end),
		});
	}

	/** The file read front to back in chunks of at most `chunkSize` bytes, as views where possible. */
	toStream(chunkSize = 2 ** 26) {
		let pos = 0;
		return new ReadableStream<Uint8Array>({
			pull: (controller) => {
				if (pos >= this.size) {
					controller.close();
					return;
				}

				// When the last write touching the chunk is a large one that starts at or before it, its bytes win, so
				// the chunk can be handed out as a view into it
				const end = Math.min(pos + chunkSize, this.size);
				const overlapping = this.writes.filter(x => x.start < end && pos < x.end);
				const last = overlapping[overlapping.length - 1];
				if (last && last.start <= pos && last.data.byteLength > 2 ** 16) {
					const viewEnd = Math.min(end, last.end);
					controller.enqueue(last.data.subarray(pos - last.start, viewEnd - last.start));
					pos = viewEnd;
				} else {
					controller.enqueue(this.read(pos, end));
					pos = end;
				}
			},
		});
	}
}

/** A target that writes into a {@link VirtualFile}. */
export class VirtualFileTarget extends Target {
	constructor(public file = new VirtualFile()) {
		super();
	}

	_start() {}

	_write(data: Uint8Array, pos: number) {
		this.file.write(data, pos);
		this._dispatchWrite(pos, pos + data.byteLength);
	}

	async _flush() {}

	async _finalize() {
		this._emit('finalized');
	}

	async _close() {}
}
