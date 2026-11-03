// `start.limits` (src/build/resource-limits.ts): the values denext's Deno accepts for
// `--max-memory`, `--max-cpu-time` and `--max-time` (Brainwires/deno DENEXT.md item 92), checked
// when the config loads so a bad one is a config error, not a runtime refusal at start. Import-free.

/** The smallest heap limit the runtime accepts (below it V8 can't load its snapshot). */
const MIN_MEMORY_BYTES = 32 * 1024 * 1024;

/** A size the runtime's `--max-memory` parses: digits, then an optional binary unit. */
const SIZE = /^(\d+)\s*(k|kb|m|mb|g|gb)?$/i;

const UNIT_BYTES: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/**
 * The heap limit `memory` asks for, in bytes, or `null` when it isn't one the runtime accepts: a
 * number is megabytes (a whole number), a string has an optional `k` / `kb` / `m` / `mb` / `g` /
 * `gb` unit (binary, any case; none is megabytes), and the result is at least 32 MB.
 *
 * @param memory The configured value.
 * @returns The bytes, or `null`.
 */
export function memoryLimitBytes(memory: unknown): number | null {
  let bytes: number;
  if (typeof memory === "number") {
    if (!Number.isSafeInteger(memory)) return null;
    bytes = memory * UNIT_BYTES.m;
  } else if (typeof memory === "string") {
    const m = SIZE.exec(memory.trim());
    if (!m) return null;
    bytes = Number(m[1]) * UNIT_BYTES[(m[2] ?? "m")[0].toLowerCase()];
  } else return null;
  return Number.isSafeInteger(bytes) && bytes >= MIN_MEMORY_BYTES ? bytes : null;
}

/** Whether `value` is a whole number of seconds the runtime accepts (at least 1). */
export function validSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** The keys `start.limits` takes. */
const LIMIT_KEYS = ["memory", "cpuSeconds", "deadlineSeconds"] as const;

/**
 * What is wrong with a `start.limits` value, as `[key path, message]` pairs (none when valid).
 *
 * @param limits The configured value.
 * @returns The problems.
 */
export function resourceLimitProblems(limits: unknown): Array<[string, string]> {
  if (limits === undefined) return [];
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
    return [["start.limits", "must be an object"]];
  }
  const problems: Array<[string, string]> = [];
  const record = limits as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
      problems.push([`start.limits.${key}`, `is not a limit (${LIMIT_KEYS.join(", ")})`]);
    }
  }
  if (record.memory !== undefined && memoryLimitBytes(record.memory) === null) {
    problems.push([
      "start.limits.memory",
      'must be at least 32 MB: a whole number of megabytes, or a size such as "512m" or "2g"',
    ]);
  }
  for (const key of ["cpuSeconds", "deadlineSeconds"] as const) {
    if (record[key] !== undefined && !validSeconds(record[key])) {
      problems.push([`start.limits.${key}`, "must be a whole number of seconds, at least 1"]);
    }
  }
  return problems;
}
