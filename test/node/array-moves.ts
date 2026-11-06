/**
 * Counts the array elements that `Array.prototype.shift()` and `Array.prototype.splice()` move while `fn` runs, on
 * arrays longer than `minLength`. Both copy the rest of the array, so calling them once per item on a large array is
 * quadratic work. Counting that work is deterministic, unlike timing it.
 */
export const countMovedArrayElements = async (fn: () => Promise<void>, minLength = 1000) => {
	const shift = Array.prototype.shift as (this: unknown[]) => unknown;
	const splice = Array.prototype.splice as (this: unknown[], ...args: unknown[]) => unknown[];
	let moved = 0;

	Array.prototype.shift = function (this: unknown[]) {
		if (this.length > minLength) {
			moved += this.length - 1;
		}

		return shift.call(this);
	};
	Array.prototype.splice = function (this: unknown[], ...args: unknown[]) {
		const length = this.length;
		if (length > minLength && args.length > 0) {
			const relativeStart = Math.trunc(Number(args[0])) || 0;
			const start = relativeStart < 0 ? Math.max(length + relativeStart, 0) : Math.min(relativeStart, length);
			const deleteCount = args.length < 2
				? length - start
				: Math.min(Math.max(Math.trunc(Number(args[1])) || 0, 0), length - start);
			const insertCount = Math.max(args.length - 2, 0);

			if (insertCount !== deleteCount) {
				moved += length - start - deleteCount; // The elements after the spliced range
			}
		}

		return splice.apply(this, args);
	};

	try {
		await fn();
	} finally {
		Array.prototype.shift = shift;
		Array.prototype.splice = splice;
	}

	return moved;
};
