// A tiny, dependency-free cron-expression matcher — the userland fallback scheduler for
// scheduled tasks when the platform's managed `Deno.cron` isn't available (a self-hosted
// long-running process started without `--unstable-cron`). On Deno Deploy (and with the
// flag) the schedule string is handed to `Deno.cron` verbatim instead, so this matcher runs
// only off-platform. Standard 5-field Vixie cron:
//
//     ┌ minute (0-59)  ┌ hour (0-23)  ┌ day-of-month (1-31)  ┌ month (1-12)  ┌ day-of-week (0-6, 0=Sun; 7=Sun too)
//     *                *             *                       *               *
//
// Each field supports `*`, a number, a `a-b` range, an `a-b/step` or `*/step`, and a
// comma list of those. `?` is accepted as an alias for `*` (Quartz habit). Names
// (JAN/MON) are NOT supported — keep it numeric, like `Deno.cron`.

/** One parsed field: the exact set of values it matches within its [min,max] domain. */
type Field = Set<number>;

/** A parsed 5-field cron expression. */
export interface CronExpr {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
  /** True when BOTH day-of-month and day-of-week are restricted (Vixie OR semantics apply). */
  domAndDowRestricted: boolean;
}

const RANGES: Array<[keyof Omit<CronExpr, "domAndDowRestricted">, number, number]> = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["dom", 1, 31],
  ["month", 1, 12],
  ["dow", 0, 7], // 7 and 0 both mean Sunday; 7 is normalized to 0 after parsing
];

/** The inclusive `[lo, hi]` bounds a `*`/number/`a-b` range denotes, before its step. */
function rangeBounds(rangePart: string, min: number, max: number): [number, number] {
  if (rangePart === "*") return [min, max];
  if (rangePart.includes("-")) {
    const [a, b] = rangePart.split("-").map(Number);
    return [a, b];
  }
  const n = Number(rangePart);
  return [n, n];
}

/** Parse one `a-b/step` (or `*`, number, list-part) token into its matched values. */
function parseToken(token: string, min: number, max: number, field: string): number[] {
  const [rangePart, stepPart] = token.split("/");
  const step = stepPart === undefined ? 1 : Number(stepPart);
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`cron: invalid step "${stepPart}" in ${field} field`);
  }
  const [lo, hi] = rangeBounds(rangePart, min, max);
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
    throw new Error(`cron: value "${token}" out of range [${min}-${max}] in ${field} field`);
  }
  const out: number[] = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
}

/** Parse one comma-separated field into the set of numbers it matches, or throw. */
function parseField(raw: string, min: number, max: number, field: string): Field {
  const set = new Set<number>();
  for (const part of raw.split(",")) {
    for (const v of parseToken(part === "?" ? "*" : part, min, max, field)) set.add(v);
  }
  return set;
}

/** Parse a 5-field cron string. Throws a descriptive error for a malformed expression. */
export function parseCron(expr: string): CronExpr {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron: expected 5 space-separated fields, got ${fields.length} in "${expr}"`,
    );
  }
  const parsed = {} as Record<string, Field>;
  RANGES.forEach(([name, min, max], i) => {
    parsed[name] = parseField(fields[i], min, max, name);
  });
  // Day-of-week 7 means Sunday too (some crons emit it). Normalize 7 → 0.
  if (parsed.dow.delete(7)) parsed.dow.add(0);
  return {
    minute: parsed.minute,
    hour: parsed.hour,
    dom: parsed.dom,
    month: parsed.month,
    dow: parsed.dow,
    domAndDowRestricted: fields[2] !== "*" && fields[2] !== "?" &&
      fields[4] !== "*" && fields[4] !== "?",
  };
}

/** Validate a cron string, returning an error message or null. */
export function cronError(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Whether `expr` fires at `date` (to minute granularity, in UTC — matching `Deno.cron`,
 * which schedules in UTC; the userland fallback must agree so a schedule fires at the same
 * wall-clock instant on every platform). Vixie semantics: when BOTH day-of-month and
 * day-of-week are restricted, the expression matches if EITHER does.
 */
export function cronMatches(expr: CronExpr | string, date: Date = new Date()): boolean {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const domMatch = c.dom.has(date.getUTCDate());
  const dowMatch = c.dow.has(date.getUTCDay());
  const dayMatch = c.domAndDowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
  return (
    c.minute.has(date.getUTCMinutes()) &&
    c.hour.has(date.getUTCHours()) &&
    c.month.has(date.getUTCMonth() + 1) &&
    dayMatch
  );
}
