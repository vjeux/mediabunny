// The conversion matrix's markers: which gray level each generated frame shows, which beeps the audio carries, and
// how to find them again in decoded output (plain math, no DOM APIs).

export const LEVELS = [40, 93, 146, 199]; // Limited-range luma of the four gray levels

/** The level index the generator gives frame n. */
export const frameLevel = (n: number) => Math.floor(((n * n * 1103 + n * 12345 + 67) % 65536) / 16384);
/** The alpha the generator gives frame n (when the fixture has alpha). */
export const frameAlpha = (n: number) => Math.floor(((n * n * 977 + n * 5419 + 11) % 65536) / 32768) ? 255 : 64;

/** Converts a full-range gray RGB value to the nearest generator level; -1 if it fits none. */
export const classifyFullRangeGray = (gray: number) => {
	const limited = 16 + gray * 219 / 255;
	return classifyLimitedLuma(limited);
};

export const classifyLimitedLuma = (luma: number) => {
	let best = -1;
	let bestDistance = Infinity;
	for (let i = 0; i < LEVELS.length; i++) {
		const distance = Math.abs(luma - LEVELS[i]!);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = i;
		}
	}
	return bestDistance <= 22 ? best : -1;
};

export const channelAmplitude = (channel: number) => 0.1 + 0.05 * channel;
export const BEEP_INTERVAL = 0.25;
export const BEEP_LENGTH = 0.02;
export const beepFrequency = (k: number) => 400 + 200 * (k % 8);

export type Beep = {
	/** Onset time in seconds (timeline of the analyzed signal). */
	time: number;
	/** Beep index modulo 8, derived from its frequency. -1 if unclear. */
	k8: number;
	/** Measured frequency in Hz. */
	frequency: number;
	/** Peak absolute amplitude per channel. */
	amplitudes: number[];
};

/**
 * Finds beep onsets in planar float audio. `t0` is the timestamp of the first frame. Onsets are reported at the first
 * frame whose envelope reaches 30% of the global peak after at least 60 ms below that.
 */
export const detectBeeps = (planes: Float32Array[], sampleRate: number, t0: number): Beep[] => {
	const channels = planes.length;
	const frames = planes[0]?.length ?? 0;
	let peak = 0;
	for (const plane of planes) {
		for (let i = 0; i < frames; i++) {
			const v = Math.abs(plane[i]!);
			if (v > peak) {
				peak = v;
			}
		}
	}
	if (peak < 1e-3) {
		return [];
	}

	const high = 0.3 * peak;
	const quietNeeded = Math.round(0.06 * sampleRate);
	const beeps: Beep[] = [];
	let lastHigh = -Infinity; // Index of the last frame at or above the threshold
	let i = 0;

	while (i < frames) {
		let env = 0;
		for (let c = 0; c < channels; c++) {
			const v = Math.abs(planes[c]![i]!);
			if (v > env) {
				env = v;
			}
		}

		if (env >= high && i - lastHigh > quietNeeded) {
			// Onset. Measure frequency on the loudest channel and per-channel peaks over the beep.
			const windowEnd = Math.min(frames, i + Math.round(BEEP_LENGTH * sampleRate));
			const amplitudes: number[] = [];
			let loudest = 0;
			for (let c = 0; c < channels; c++) {
				let p = 0;
				for (let j = i; j < windowEnd; j++) {
					const v = Math.abs(planes[c]![j]!);
					if (v > p) {
						p = v;
					}
				}
				amplitudes.push(p);
				if (p > amplitudes[loudest]!) {
					loudest = c;
				}
			}

			const fStart = i + Math.round(0.001 * sampleRate);
			const fEnd = Math.min(frames, i + Math.round(0.017 * sampleRate));
			const plane = planes[loudest]!;
			let crossings = 0;
			let firstCrossing = -1;
			let lastCrossing = -1;
			for (let j = fStart + 1; j < fEnd; j++) {
				if ((plane[j - 1]! < 0) !== (plane[j]! < 0)) {
					crossings++;
					if (firstCrossing === -1) {
						firstCrossing = j;
					}
					lastCrossing = j;
				}
			}
			let frequency = 0;
			if (crossings >= 2) {
				frequency = (crossings - 1) / 2 / ((lastCrossing - firstCrossing) / sampleRate);
			}
			const kRaw = (frequency - 400) / 200;
			const k8 = Math.abs(kRaw - Math.round(kRaw)) < 0.3 && Math.round(kRaw) >= 0 && Math.round(kRaw) < 8
				? Math.round(kRaw)
				: -1;

			beeps.push({ time: t0 + i / sampleRate, k8, frequency, amplitudes });
			lastHigh = i;
		}

		if (env >= high) {
			lastHigh = i;
		}
		i++;
	}

	return beeps;
};
