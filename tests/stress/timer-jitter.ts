// `deno test --preload tests/stress/timer-jitter.ts`: stall timer and microtask callbacks at
// random, seeded from `DENEXT_STRESS_SEED` (see `tests/stress/jitter.ts`). `deno task test:stress`
// (`scripts/test-stress.ts`) picks and prints the seed; run directly without one, this file picks
// a seed and prints it so a failure can be replayed with `DENEXT_STRESS_SEED=<seed>`.

import { toFileUrl } from "@std/path";
import { installJitter, jitterFromEnv, seedFor } from "./jitter.ts";

const options = jitterFromEnv((name) => Deno.env.get(name));
if (options.fresh) {
  console.error(
    `timer-jitter: seed=${options.seed} maxMs=${options.maxMs} p=${options.probability}`,
  );
}

/**
 * The test file this isolate runs, relative to the working directory (the repo root under
 * `deno task`), so a seed replays the same stalls in any checkout; empty when unknown.
 */
function testFile(): string {
  try {
    const main = Deno.mainModule;
    const root = toFileUrl(`${Deno.cwd()}/`).href;
    return main.startsWith(root) ? main.slice(root.length) : main;
  } catch {
    return "";
  }
}

installJitter({ ...options, seed: seedFor(options.seed, testFile()) });
