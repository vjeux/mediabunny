import { expect, test } from 'vitest';
import { CallSerializer, ConcurrentRunner, promiseWithResolvers } from '../../src/misc.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	AudioCodec,
	AudioSample,
	AudioSampleSink,
	AudioSampleSource,
	BufferTarget,
	CustomAudioDecoder,
	CustomAudioEncoder,
	EncodedPacket,
	FilePathSource,
	Input,
	Output,
	registerDecoder,
	registerEncoder,
	WebMOutputFormat,
} from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('parallelism of 1 runs tasks strictly sequentially', async () => {
	const runner = new ConcurrentRunner(1);
	let entered = false;
	let overlapped = false;

	const makeTask = () => async () => {
		if (entered) {
			overlapped = true;
		}
		entered = true;
		await Promise.resolve();
		await Promise.resolve();
		entered = false;
	};

	const runPromises: Promise<void>[] = [];
	for (let i = 0; i < 5; i++) {
		runPromises.push(runner.run(makeTask()));
	}

	await Promise.all(runPromises);
	await runner.flush();

	expect(overlapped).toBe(false);
	expect(entered).toBe(false);
});

test('run schedules tasks up to parallelism without waiting', async () => {
	const runner = new ConcurrentRunner(3);
	const d1 = promiseWithResolvers();
	const d2 = promiseWithResolvers();
	const d3 = promiseWithResolvers();

	let started = 0;

	await runner.run(async () => {
		started++;
		await d1.promise;
	});
	await runner.run(async () => {
		started++;
		await d2.promise;
	});
	await runner.run(async () => {
		started++;
		await d3.promise;
	});

	// All three should have started synchronously since we're under parallelism
	expect(started).toBe(3);

	d1.resolve();
	d2.resolve();
	d3.resolve();
	await runner.flush();
});

test('run blocks when the queue is full and resumes as slots free up', async () => {
	const runner = new ConcurrentRunner(2);
	const d1 = promiseWithResolvers();
	const d2 = promiseWithResolvers();
	const d3 = promiseWithResolvers();

	let startedThird = false;

	await runner.run(() => d1.promise);
	await runner.run(() => d2.promise);

	// Kick off a third run. It must not resolve until one of the first two finishes.
	const thirdRun = runner.run(async () => {
		startedThird = true;
		await d3.promise;
	});

	await flushMicrotasks();
	expect(startedThird).toBe(false);

	// Free a slot by resolving the first task.
	d1.resolve();
	await thirdRun;

	expect(startedThird).toBe(true);

	d2.resolve();
	d3.resolve();
	await runner.flush();
});

test('simultaneous run calls respect parallelism', async () => {
	const runner = new ConcurrentRunner(2);
	const deferreds = [
		promiseWithResolvers(),
		promiseWithResolvers(),
		promiseWithResolvers(),
		promiseWithResolvers(),
	];
	const started: number[] = [];

	const runPromises = deferreds.map((d, i) => runner.run(async () => {
		started.push(i);
		await d.promise;
	}));

	// Give the runner a chance to start the first batch, then verify only the first two ran.
	await flushMicrotasks();
	expect(started).toEqual([0, 1]);

	// The first two run() calls should have resolved already (they found open slots),
	// the last two should still be waiting.
	let settled = 0;
	void Promise.all(runPromises).then(() => settled++);
	await flushMicrotasks();
	expect(settled).toBe(0);

	// Unblock the first task. That should let task 2 in.
	deferreds[0]!.resolve();
	await flushMicrotasks();
	expect(started).toEqual([0, 1, 2]);

	// Unblock the second task. That should let task 3 in.
	deferreds[1]!.resolve();
	await flushMicrotasks();
	expect(started).toEqual([0, 1, 2, 3]);

	// All four run() calls should resolve once their slot has been acquired.
	await Promise.all(runPromises);

	deferreds[2]!.resolve();
	deferreds[3]!.resolve();
	await runner.flush();
});

test('CallSerializer keeps running calls after one of them failed', async () => {
	const serializer = new CallSerializer();
	const failed = serializer.call(() => {
		throw new Error('Boom');
	});
	await expect(failed).rejects.toThrow('Boom');

	let ran = false;
	await serializer.call(() => {
		ran = true;
	});
	expect(ran).toBe(true);
});

test('A custom decoder that fails gets closed, without an unhandled rejection', async () => {
	// Registered decoders are global, and this is the only test in this file that decodes MP3
	let closeCalls = 0;
	let decodeCalls = 0;
	class FailingMp3Decoder extends CustomAudioDecoder {
		static override supports(codec: AudioCodec) {
			return codec === 'mp3';
		}

		async init() {}

		async decode(packet: EncodedPacket) {
			decodeCalls++;
			if (decodeCalls === 3) {
				// Like a WebAssembly decoder hitting a damaged frame
				throw new Error('Damaged packet');
			}

			this.onSample(new AudioSample({
				data: new Float32Array(1152 * 2),
				format: 'f32',
				numberOfChannels: 2,
				sampleRate: 44100,
				timestamp: packet.timestamp,
			}));
		}

		async flush() {}

		close() {
			closeCalls++;
		}
	}
	registerDecoder(FailingMp3Decoder);

	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on('unhandledRejection', onUnhandled);

	try {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '..', 'public', 'Toothsome-Meme.VBRv2.mp3')),
			formats: ALL_FORMATS,
		});
		const track = (await input.getPrimaryAudioTrack())!;

		const iterate = async () => {
			for await (const sample of new AudioSampleSink(track).samples()) {
				sample.close();
			}
		};
		await expect(iterate()).rejects.toThrow('Damaged packet');

		await new Promise(resolve => setTimeout(resolve, 50));
		expect(closeCalls).toBe(1);
		expect(unhandled).toEqual([]);
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}
});

test('A custom encoder whose flush() fails makes finalize() reject, and gets closed', async () => {
	// Registered encoders are global, and this is the only test in this file that encodes Opus
	let flushCalls = 0;
	let closeCalls = 0;
	class FlushFailingOpusEncoder extends CustomAudioEncoder {
		static override supports(codec: AudioCodec) {
			return codec === 'opus';
		}

		init() {}

		encode(sample: AudioSample) {
			this.onPacket(
				new EncodedPacket(new Uint8Array([0xfc, 0xff, 0xfe]), 'key', sample.timestamp, sample.duration),
				{ decoderConfig: { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 } },
			);
		}

		flush() {
			flushCalls++;
			// Like a WebAssembly encoder failing on its last frames
			throw new Error('Flush failed');
		}

		close() {
			closeCalls++;
		}
	}
	registerEncoder(FlushFailingOpusEncoder);

	const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	const source = new AudioSampleSource({ codec: 'opus', bitrate: 64000 });
	output.addAudioTrack(source);
	await output.start();
	for (let i = 0; i < 4; i++) {
		using sample = new AudioSample({
			data: new Float32Array(960),
			format: 'f32',
			numberOfChannels: 1,
			sampleRate: 48000,
			timestamp: i * 0.02,
		});
		await source.add(sample);
	}

	await expect(output.finalize()).rejects.toThrow('Flush failed');
	expect(flushCalls).toBe(1);
	expect(closeCalls).toBe(1);
});

test('errored task surfaces on the next run call', async () => {
	const runner = new ConcurrentRunner(2);
	const error = new Error('boom');

	expect(runner.errored).toBe(false);

	await runner.run(async () => {
		throw error;
	});

	await flushMicrotasks();
	expect(runner.errored).toBe(true);

	await expect(runner.run(async () => {})).rejects.toBe(error);
});

test('errored task surfaces on flush', async () => {
	const runner = new ConcurrentRunner(2);
	const error = new Error('kaboom');

	await runner.run(async () => {
		throw error;
	});

	await expect(runner.flush()).rejects.toBe(error);
	expect(runner.errored).toBe(true);
});

test('error from a slow task surfaces on subsequent run even after other tasks completed', async () => {
	const runner = new ConcurrentRunner(2);
	const slow = promiseWithResolvers();
	const error = new Error('late');

	await runner.run(async () => {
		await slow.promise;
		throw error;
	});
	await runner.run(async () => {});

	// Let the fast task finish cleanly.
	await flushMicrotasks();
	expect(runner.errored).toBe(false);

	// Now let the slow task reject.
	slow.resolve();
	await flushMicrotasks();
	expect(runner.errored).toBe(true);

	await expect(runner.run(async () => {})).rejects.toBe(error);
});

test('parallelism can be mutated at runtime to grow or shrink the in-flight limit', async () => {
	const runner = new ConcurrentRunner(1);
	const d1 = promiseWithResolvers();
	const d2 = promiseWithResolvers();
	const d3 = promiseWithResolvers();

	let startedSecond = false;
	let startedThird = false;

	await runner.run(() => d1.promise);
	expect(runner.inFlightCount).toBe(1);

	// Grow to 2 before scheduling the next task — second run sees the new value and starts immediately.
	runner.parallelism = 2;
	await runner.run(async () => {
		startedSecond = true;
		await d2.promise;
	});
	expect(startedSecond).toBe(true);
	expect(runner.inFlightCount).toBe(2);

	// Shrink to 1 while 2 are in flight. No task is cancelled; a new run() must wait until queue < 1.
	runner.parallelism = 1;
	const third = runner.run(async () => {
		startedThird = true;
		await d3.promise;
	});
	await flushMicrotasks();
	expect(startedThird).toBe(false);

	// Draining one frees a slot but queue is still at 1 (>= new parallelism), third stays blocked.
	d1.resolve();
	await flushMicrotasks();
	expect(startedThird).toBe(false);

	// Draining the second lets third in.
	d2.resolve();
	await third;
	expect(startedThird).toBe(true);

	d3.resolve();
	await runner.flush();
});

test('inFlightCount tracks currently running tasks', async () => {
	const runner = new ConcurrentRunner(3);
	const d1 = promiseWithResolvers();
	const d2 = promiseWithResolvers();

	expect(runner.inFlightCount).toBe(0);

	await runner.run(() => d1.promise);
	expect(runner.inFlightCount).toBe(1);

	await runner.run(() => d2.promise);
	expect(runner.inFlightCount).toBe(2);

	d1.resolve();
	await flushMicrotasks();
	expect(runner.inFlightCount).toBe(1);

	d2.resolve();
	await runner.flush();
	expect(runner.inFlightCount).toBe(0);
});

test('flush waits for all in-flight tasks', async () => {
	const runner = new ConcurrentRunner(3);
	const deferreds = [promiseWithResolvers(), promiseWithResolvers(), promiseWithResolvers()];
	const completed: number[] = [];

	for (let i = 0; i < deferreds.length; i++) {
		await runner.run(async () => {
			await deferreds[i]!.promise;
			completed.push(i);
		});
	}

	let flushResolved = false;
	const flushPromise = runner.flush().then(() => {
		flushResolved = true;
	});

	await flushMicrotasks();
	expect(flushResolved).toBe(false);

	deferreds[0]!.resolve();
	await flushMicrotasks();
	expect(flushResolved).toBe(false);

	deferreds[1]!.resolve();
	deferreds[2]!.resolve();
	await flushPromise;

	expect(flushResolved).toBe(true);
	expect(completed.sort()).toEqual([0, 1, 2]);
});

test('rejects parallelism values that would hang or disable the limit', async () => {
	for (const parallelism of [0, -1, NaN, -Infinity, '2', null]) {
		expect(() => new ConcurrentRunner(parallelism as number)).toThrow(
			new TypeError('parallelism must be a positive number or Infinity.'),
		);
	}

	const unlimited = new ConcurrentRunner(Infinity);
	await unlimited.run(async () => {});
	await unlimited.flush();

	// A fractional limit still works, rounded up
	const fractional = new ConcurrentRunner(1.5);
	let running = 0;
	let maxRunning = 0;
	const task = async () => {
		running++;
		maxRunning = Math.max(maxRunning, running);
		await new Promise(resolve => setTimeout(resolve, 5));
		running--;
	};
	await Promise.all([fractional.run(task), fractional.run(task), fractional.run(task)]);
	await fractional.flush();
	expect(maxRunning).toBe(2);

	// Shrinking the limit at runtime must not leave run() waiting on an empty queue forever
	const runner = new ConcurrentRunner(1);
	runner.parallelism = 0;
	let ran = false;
	await runner.run(async () => {
		ran = true;
	});
	expect(ran).toBe(true);
});

test('run validates its argument and accepts synchronous functions', async () => {
	const runner = new ConcurrentRunner(1);
	await expect(runner.run('task' as never)).rejects.toThrow(new TypeError('fn must be a function.'));

	await runner.run((() => 42) as never);
	await runner.flush();
	expect(runner.inFlightCount).toBe(0);
	expect(runner.errored).toBe(false);
});

const flushMicrotasks = async (iterations = 10) => {
	for (let i = 0; i < iterations; i++) {
		await Promise.resolve();
	}
};
