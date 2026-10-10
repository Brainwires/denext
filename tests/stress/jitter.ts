// Timer jitter: imitate a loaded machine inside one test isolate. When a timer callback or an
// explicitly queued microtask is about to run, the thread sometimes stalls first (a busy-wait of
// up to `maxMs`), as if the OS had descheduled it. Timers already armed keep their deadlines, so
// work registered LATER lands later: a test that sleeps a fixed time while the code under test
// arms its own timer afterwards sees its sleep end first and fails. That is the shape of a
// sleep-vs-timer race; the fix is to await the event (or run on a fake clock), never a longer
// sleep. `tests/stress/timer-jitter.ts` installs this as a `deno test --preload`.

/** How a jitter install behaves. */
export interface JitterOptions {
  /** The PRNG seed; the same seed gives the same stall sequence for the same callback order. */
  seed: number;
  /** The longest stall, in milliseconds. */
  maxMs: number;
  /** The chance that a timer callback stalls first (a queued microtask: a quarter of it). */
  probability: number;
}

/** The defaults: stalls up to 40 ms before half of the timer callbacks. */
export const JITTER_DEFAULTS: Readonly<Omit<JitterOptions, "seed">> = {
  maxMs: 40,
  probability: 0.5,
};

/**
 * A seeded PRNG (mulberry32): a function returning floats in [0, 1).
 *
 * @param seed The 32-bit seed.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `seed` mixed with `name` (FNV-1a), so each test file draws its own stall sequence from one run
 * seed, whatever order the parallel pass starts the files in.
 *
 * @param seed The run seed.
 * @param name The test file (any stable string).
 */
export function seedFor(seed: number, name: string): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The jitter options from the environment: `DENEXT_STRESS_SEED` (a fresh random seed when unset;
 * `fresh` says so), `DENEXT_STRESS_MAX_MS` and `DENEXT_STRESS_P`.
 *
 * @param env Reads one variable.
 */
export function jitterFromEnv(
  env: (name: string) => string | undefined,
): JitterOptions & { fresh: boolean } {
  const num = (name: string, fallback: number) => {
    const raw = env(name);
    const n = raw === undefined || raw === "" ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const raw = env("DENEXT_STRESS_SEED");
  const fresh = raw === undefined || raw === "" || !Number.isFinite(Number(raw));
  return {
    seed: fresh ? Math.floor(Math.random() * 2 ** 32) : Number(raw) >>> 0,
    fresh,
    maxMs: num("DENEXT_STRESS_MAX_MS", JITTER_DEFAULTS.maxMs),
    probability: Math.min(1, num("DENEXT_STRESS_P", JITTER_DEFAULTS.probability)),
  };
}

/**
 * Wrap `globalThis.setTimeout` and `globalThis.queueMicrotask` so their callbacks sometimes stall
 * before running. Returns a function that puts the originals back.
 *
 * @param options The seed, the longest stall and the stall chance.
 */
export function installJitter(options: JitterOptions): () => void {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const realTimeout = g.setTimeout;
  const realMicrotask = g.queueMicrotask;
  const random = mulberry32(options.seed);
  const stall = (chance: number) => {
    if (random() >= chance) return;
    const ms = random() * options.maxMs;
    const start = performance.now();
    while (performance.now() - start < ms) { /* descheduled */ }
  };
  g.setTimeout = (fn: unknown, ms?: number, ...args: unknown[]) =>
    realTimeout(
      (...a: unknown[]) => {
        stall(options.probability);
        return typeof fn === "function" ? fn(...a) : undefined;
      },
      ms,
      ...args,
    );
  g.queueMicrotask = (fn: () => void) =>
    realMicrotask(() => {
      stall(options.probability / 4);
      fn();
    });
  return () => {
    g.setTimeout = realTimeout;
    g.queueMicrotask = realMicrotask;
  };
}
