// A child that must hit a small V8 heap limit (`--max-memory`, a worker's `deno: { memoryMb }`)
// can't inherit a heap size from `DENO_V8_FLAGS`: V8 takes `--max-old-space-size` /
// `--max-heap-size` over an isolate's own resource constraints, so the limit under test is
// silently raised to the flag's size. scripts/test-run.ts sets a 4–8 GiB one on Windows
// (`heapEnv`), and a child allocating without end then grows to gigabytes before anything stops
// it, starving every other test on the host.

import { HEAP_SIZE_FLAG } from "../../src/build/heap-flags.ts";

/**
 * `env` without the heap sizes in its `DENO_V8_FLAGS` (the variable dropped when nothing else is
 * left in it: an empty value is a flag V8 refuses). Pass the result with `clearEnv: true`, since a
 * variable left out of `env` is otherwise inherited.
 *
 * @param env A child's whole environment.
 * @returns A copy without the heap sizes.
 */
export function withoutHeapSize(env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  const flags = out.DENO_V8_FLAGS;
  if (flags === undefined) return out;
  const kept = flags.split(",").map((f) => f.trim()).filter((f) => f && !HEAP_SIZE_FLAG.test(f));
  if (kept.length > 0) out.DENO_V8_FLAGS = kept.join(",");
  else delete out.DENO_V8_FLAGS;
  return out;
}
