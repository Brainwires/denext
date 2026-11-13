// V8 takes `--max-old-space-size` / `--max-heap-size` over an isolate's own resource constraints,
// so a heap size in `DENO_V8_FLAGS` or in the process's own `--v8-flags=…` silently raises a heap
// cap denext configures to the flag's size: `start.limits.memory` (`--max-memory`, the main
// isolate's heap) and @denext/backend's Edge Functions `memoryMb` (a worker's
// `deno: { memoryMb }`). `denext start` and `denext dev` say so once at startup
// (src/cli/run-verb.ts, src/cli/commands/serve.ts); the backend has its own check
// (packages/backend/src/functions.ts), since it imports nothing internal from core.

/** The V8 flags that set a heap size, either spelling (`-` or `_`), with or without a value. */
export const HEAP_SIZE_FLAG = /^--max[-_](old[-_]space|heap)[-_]size(=|$)/;

/** Where a heap-size flag was found. */
export type HeapFlagSource = "DENO_V8_FLAGS" | "--v8-flags";

/** One heap-size flag this process runs with. */
export interface HeapFlag {
  /** The flag as written (`--max-old-space-size=4096`). */
  readonly flag: string;
  /** Where it came from. */
  readonly source: HeapFlagSource;
}

/**
 * The heap-size flags in a V8 flag list: a `DENO_V8_FLAGS` value (comma- or space-separated) or
 * the values of `--v8-flags` (each comma-separated).
 *
 * @param flags The list, or its pieces.
 * @returns The heap-size flags, as written.
 */
export function heapSizeFlags(flags: string | readonly string[] | undefined): string[] {
  if (flags === undefined) return [];
  const words = (typeof flags === "string" ? [flags] : flags).flatMap((f) => f.split(/[,\s]+/));
  return words.filter((w) => HEAP_SIZE_FLAG.test(w));
}

/**
 * Every heap-size flag a process runs with: its `DENO_V8_FLAGS`, then its own `--v8-flags`.
 *
 * @param env The process's `DENO_V8_FLAGS`.
 * @param v8Flags The values of the `--v8-flags` it was started with (`parseRunCommandLine`).
 * @returns The flags found, with where each came from.
 */
export function findHeapFlags(
  env: string | undefined,
  v8Flags: readonly string[] = [],
): HeapFlag[] {
  return [
    ...heapSizeFlags(env).map((flag) => ({ flag, source: "DENO_V8_FLAGS" as const })),
    ...heapSizeFlags(v8Flags).map((flag) => ({ flag, source: "--v8-flags" as const })),
  ];
}

/**
 * Whether the cap is in force now (`denext start`'s serving process runs with it) or only in
 * production (`denext dev`, which does not apply `start.limits`).
 */
export type HeapCapWhen = "now" | "production";

/**
 * The warning that heap-size flags override configured heap caps, or `null` when there is nothing
 * to say (no flag, or no cap).
 *
 * @param found The heap-size flags ({@linkcode findHeapFlags}).
 * @param caps The configured caps, each named with its config key (`start.limits.memory
 *   (--max-memory=512m)`).
 * @param when Whether the caps apply to this process or only in production.
 * @returns The one-line warning, or `null`.
 */
export function heapFlagWarning(
  found: readonly HeapFlag[],
  caps: readonly string[],
  when: HeapCapWhen,
): string | null {
  if (found.length === 0 || caps.length === 0) return null;
  const flags = found.map((f) => `${f.flag} (${f.source})`).join(", ");
  const now = found.length === 1 ? "overrides" : "override";
  const verb = when === "now" ? now : "will override in production";
  return `denext: ${flags} ${verb} ${caps.join(" and ")}: V8 takes a heap-size flag over an ` +
    "isolate's own heap cap, so the cap is raised to the flag's size. Drop the flag and rely on " +
    "the cap, or drop the cap.";
}

/**
 * The `start.limits.memory` cap among limit flags, named for {@linkcode heapFlagWarning}.
 *
 * @param flags Limit flags (`resourceLimitFlags`, or `DENEXT_LIMITS_APPLIED`'s words).
 * @returns `["start.limits.memory (--max-memory=…)"]`, or nothing.
 */
export function memoryCap(flags: readonly string[]): string[] {
  const memory = flags.find((f) => f.startsWith("--max-memory="));
  return memory ? [`start.limits.memory (${memory})`] : [];
}
