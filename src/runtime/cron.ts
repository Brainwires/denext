// A tiny, dependency-free cron-expression matcher — the userland fallback scheduler for
// scheduled tasks when the platform's managed `Deno.cron` isn't available (a self-hosted
// long-running process started without `--unstable-cron`). On Deno Deploy (and with the
// flag) the schedule string is handed to `Deno.cron` through {@linkcode toDenoCron} instead,
// so this matcher runs only off-platform. Standard 5-field Vixie cron:
//
//     ┌ minute (0-59)  ┌ hour (0-23)  ┌ day-of-month (1-31)  ┌ month (1-12)  ┌ day-of-week (0-6, 0=Sun; 7=Sun too)
//     *                *             *                       *               *
//
// Each field supports `*`, a number, a `a-b` range, an `a-b/step`, `*/step` or `n/step`
// (`n` to the field's maximum, as Vixie and `Deno.cron` read it), and a comma list of those.
// `?` is accepted as an alias for `*` (Quartz habit). Names (JAN/MON) are NOT supported here —
// keep it numeric. Note that `Deno.cron` numbers weekdays 1-7 with 1 = Sunday and rejects `0`
// and `?`, which is why the schedule is never handed to it verbatim: `toDenoCron` spells the
// day-of-week field in names, which both conventions agree on.

/** One parsed field: the exact set of values it matches within its [min,max] domain. */
type Field = Set<number>;

/**
 * The only shapes a field item may take: `*`, `n`, `a-b`, each with an optional `/step`.
 * Digits only — `Number()` would also swallow `-5`, `+5`, `0x10`, `1e1` and `5.`, none of which
 * any cron reads, and a schedule that parses here but not in `Deno.cron` fires on one platform
 * and is refused on the other.
 */
const TOKEN = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/;

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

/**
 * The inclusive `[lo, hi]` bounds a `*`/number/`a-b` range denotes, before its step. A lone
 * number WITH a step (`5/15`) runs to the field's maximum — `5-59/15` — which is how Vixie and
 * `Deno.cron` read it; reading it as the single value 5 would make the userland scheduler and
 * the description disagree with what the platform fires.
 */
function rangeBounds(
  rangePart: string,
  min: number,
  max: number,
  stepped: boolean,
): [number, number] {
  if (rangePart === "*") return [min, max];
  if (rangePart.includes("-")) {
    const [a, b] = rangePart.split("-").map(Number);
    return [a, b];
  }
  const n = Number(rangePart);
  return [n, stepped ? max : n];
}

/** Parse one `a-b/step` (or `*`, number, list-part) token into its matched values. */
function parseToken(token: string, min: number, max: number, field: string): number[] {
  const match = TOKEN.exec(token);
  if (match === null) {
    throw new Error(
      token === ""
        ? `cron: empty item in ${field} field`
        : `cron: invalid value "${token}" in ${field} field`,
    );
  }
  const [, rangePart, stepPart] = match;
  const step = stepPart === undefined ? 1 : Number(stepPart);
  if (step < 1) {
    throw new Error(`cron: invalid step "${stepPart}" in ${field} field`);
  }
  const [lo, hi] = rangeBounds(rangePart, min, max, stepPart !== undefined);
  if (lo < min || hi > max || lo > hi) {
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

/** Weekday names, indexed by the day-of-week numbers `parseCron` normalises to. */
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** `7` → `07`, for a wall-clock time. */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "3rd", "21st" — for a day of the month. */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** "a, b and c" — an English list. */
function and(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Whether a field matches everything in its domain. */
function isAny(field: Set<number>, size: number): boolean {
  return field.size >= size;
}

/**
 * A cron expression in plain English — "every day at 03:30 UTC".
 *
 * Describes what the expression MATCHES, not how it was written: `parseCron` keeps each field as
 * the set of values it fires on, so a step expression and the equivalent comma list are the
 * same schedule and are described the same way. That is the more useful answer anyway — it
 * says what will happen, not how someone spelled it.
 *
 * Only shapes that can be stated exactly are stated. Anything else gets a truthful summary
 * rather than invented English: a description that is confidently wrong is worse than one that
 * admits the expression is unusual, which is the same reason a schedule that can never fire is
 * refused rather than saved.
 *
 * Times are UTC, matching `Deno.cron` and the userland scheduler — and matching how the panel
 * already prints next-run times, so one page never carries two time vocabularies.
 *
 * @param expr The 5-field expression.
 * @returns The description, or `null` when the expression is malformed.
 */
export function describeCron(expr: string): string | null {
  let c: CronExpr;
  try {
    c = parseCron(expr);
  } catch {
    return null;
  }
  const anyMinute = isAny(c.minute, 60);
  const anyHour = isAny(c.hour, 24);
  const anyDom = isAny(c.dom, 31);
  const anyMonth = isAny(c.month, 12);
  const anyDow = isAny(c.dow, 7);

  // Vixie OR semantics: with BOTH day fields restricted it fires if EITHER matches. Rendering
  // that as "and" would be plainly wrong, so it is said as "or".
  const day = dayPhrase(c, anyDom, anyDow);
  if (day === null) return unusual(c);

  const month = anyMonth ? "" : ` in ${and([...c.month].sort((a, b) => a - b).map(monthName))}`;

  const when = timePhrase(c, anyMinute, anyHour);
  if (when === null) return unusual(c);
  const where = day === "" ? "" : ` ${day}`;
  // "every minute" reads as a whole clause already; a bare list of clock times does not, so it
  // takes "every day" when no day is named.
  return when.standalone
    ? `${when.text}${where}${month}`.trim()
    : `${day === "" ? "every day" : day} ${when.text}${month}`.trim();
}

/** A time phrase, and whether it already reads as a whole clause without a day in front. */
interface TimePhrase {
  /** The phrase itself. */
  readonly text: string;
  /** True when it needs no day subject ("every minute"). */
  readonly standalone: boolean;
}

/**
 * How often within a day the expression fires, or `null` when that is too irregular to state.
 *
 * Split out of {@linkcode describeCron} because these four mutually exclusive shapes were most of
 * its branching, and each is easier to read — and to be sure of — on its own.
 *
 * @param c The parsed expression.
 * @param anyMinute Whether every minute matches.
 * @param anyHour Whether every hour matches.
 * @returns The phrase, or `null` to fall back to a truthful summary.
 */
function timePhrase(c: CronExpr, anyMinute: boolean, anyHour: boolean): TimePhrase | null {
  if (anyMinute && anyHour) return { text: "every minute", standalone: true };
  if (anyMinute) {
    const hours = and([...c.hour].sort((a, b) => a - b).map((h) => `${pad(h)}:00`));
    const plural = c.hour.size === 1 ? "hour" : "hours";
    return { text: `every minute of the ${hours} ${plural} (UTC)`, standalone: true };
  }
  if (anyHour) {
    const mins = and([...c.minute].sort((a, b) => a - b).map((m) => `:${pad(m)}`));
    return { text: `every hour at ${mins} (UTC)`, standalone: true };
  }
  // Past a handful of distinct firing times, listing them stops being a description.
  if (c.minute.size * c.hour.size > 8) return null;
  const times: string[] = [];
  for (const h of [...c.hour].sort((a, b) => a - b)) {
    for (const m of [...c.minute].sort((a, b) => a - b)) times.push(`${pad(h)}:${pad(m)}`);
  }
  return { text: `at ${and(times)} UTC`, standalone: false };
}

/** The day part of a description, or `null` when it cannot be stated plainly. */
function dayPhrase(c: CronExpr, anyDom: boolean, anyDow: boolean): string | null {
  if (anyDom && anyDow) return "";
  if (c.domAndDowRestricted) {
    // Both restricted: Vixie fires on EITHER, which no short phrase states cleanly.
    return null;
  }
  if (!anyDow) {
    const days = [...c.dow].sort((a, b) => a - b).map((d) => `${DAYS[d]}s`);
    return `on ${and(days)}`;
  }
  const dates = [...c.dom].sort((a, b) => a - b).map(ordinal);
  return `on the ${and(dates)}`;
}

/** The honest answer for an expression too irregular to state in a sentence. */
function unusual(c: CronExpr): string {
  const parts = [
    `${c.minute.size} minute${c.minute.size === 1 ? "" : "s"}`,
    `${c.hour.size} hour${c.hour.size === 1 ? "" : "s"}`,
  ];
  return `a custom schedule — ${and(parts)} per day. See the next runs below.`;
}

/** Month names, 1-indexed as cron writes them. */
function monthName(m: number): string {
  return [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][m - 1] ?? String(m);
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

/** Weekday names as `Deno.cron` spells them, indexed by the POSIX number (0 = Sunday). */
const DENO_DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/**
 * One day-of-week item, respelled for `Deno.cron`.
 *
 * A number becomes its name and a plain `a-b` range a name range (`MON-FRI`), which `Deno.cron`
 * reads the same way whatever it numbers the days. A step is different: `Deno.cron` counts its
 * steps from ITS numbering, so `1-5/2` is Sunday, Tuesday and Thursday there and Monday,
 * Wednesday and Friday here. Anything stepped, and any range that reaches `7` (a reversed name
 * range is not a wrap-around to `Deno.cron`), is therefore expanded to the exact days it names.
 * A step on a bare `*` is the one step both numberings agree on — it counts from the first day
 * either way — and is kept as written.
 */
function denoDowItem(item: string): string {
  if (item === "?") return "*";
  if (item === "*" || item.startsWith("*/")) return item;
  const match = TOKEN.exec(item) as RegExpExecArray;
  const [, rangePart, stepPart] = match;
  if (stepPart === undefined && rangePart.includes("-")) {
    const [a, b] = rangePart.split("-").map(Number);
    if (b <= 6) return `${DENO_DAYS[a]}-${DENO_DAYS[b]}`;
  }
  const days = parseToken(item, 0, 7, "dow").map((d) => DENO_DAYS[d % 7]);
  return [...new Set(days)].join(",");
}

/**
 * The expression as `Deno.cron` must be handed it.
 *
 * denext's user-facing convention is POSIX: weekdays `0-6` with `0` (or `7`) for Sunday, which
 * is what every documented example (`"0 0 * * 1"` is Monday) and the userland scheduler use.
 * `Deno.cron` numbers them `1-7` with `1` for Sunday and rejects `0` outright, so a schedule
 * handed over verbatim either fails to register or fires a day late. It does accept names, and
 * both conventions agree on what `MON` means — so the day-of-week field is respelled in names
 * (see {@linkcode denoDowItem}). `?`, which `Deno.cron` also rejects, becomes `*` in every field.
 *
 * @param expr A valid 5-field expression (throws, as {@linkcode parseCron} does, otherwise).
 * @returns The same schedule in `Deno.cron`'s spelling.
 */
export function toDenoCron(expr: string): string {
  parseCron(expr); // reject a malformed expression before respelling any of it
  const fields = expr.trim().split(/\s+/);
  const plain = fields.slice(0, 4).map((field) =>
    field.split(",").map((item) => item === "?" ? "*" : item).join(",")
  );
  const dow = fields[4].split(",").map(denoDowItem).join(",");
  return [...plain, dow].join(" ");
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

// --- the schedule builder's view of an expression ----------------------------
//
// `denext ui`'s cron editor offers a frequency and a few fields rather than five cron columns.
// Both directions live here, beside the parser, so the panel never assembles an expression by
// hand: the controls are DERIVED from the expression (`cronParts`), and the expression is
// composed back from the controls (`composeCron`). That is what keeps the JavaScript-on and
// JavaScript-off paths from ever disagreeing about what the page is about to write.

/** The shapes the builder can state outright; everything else is `custom`. */
export type CronFrequency = "minute" | "hourly" | "daily" | "weekly" | "monthly" | "custom";

/** A schedule as the builder's controls hold it. */
export interface CronParts {
  /** Which shape the expression takes. */
  readonly frequency: CronFrequency;
  /** Minute of the hour (0-59). */
  readonly minute: number;
  /** Hour of the day, UTC (0-23). */
  readonly hour: number;
  /** Day of the week, `0` = Sunday (as {@linkcode parseCron} normalises it). */
  readonly dayOfWeek: number;
  /** Day of the month (1-31). */
  readonly dayOfMonth: number;
}

/** The single value a field matches, or `null` when it matches none or several. */
function loneValue(field: Set<number>): number | null {
  return field.size === 1 ? [...field][0] : null;
}

/** A control's value forced into its field's domain (a truncated integer, clamped). */
function clampField(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const n = Math.trunc(value);
  return n < min ? min : n > max ? max : n;
}

/**
 * The shape an expression takes, given which of its fields are unrestricted and which name
 * exactly one value.
 *
 * Every named shape requires an unrestricted MONTH: a schedule pinned to January is a real
 * schedule, but it is not one of the five the builder offers, and calling it "monthly" would be
 * a lie the user could not see. And with BOTH day fields written out, Vixie fires on either —
 * `0 0 5 * 0-6` is every day, not the 5th — so nothing the builder can state applies, even when
 * one of the two happens to cover its whole domain.
 */
function frequencyOf(c: CronExpr): CronFrequency {
  const anyMonth = isAny(c.month, 12);
  const anyDom = isAny(c.dom, 31);
  const anyDow = isAny(c.dow, 7);
  if (!anyMonth || c.domAndDowRestricted) return "custom";
  const minute = loneValue(c.minute);
  const hour = loneValue(c.hour);
  if (isAny(c.minute, 60) && isAny(c.hour, 24) && anyDom && anyDow) return "minute";
  if (minute === null) return "custom";
  if (isAny(c.hour, 24) && anyDom && anyDow) return "hourly";
  if (hour === null) return "custom";
  if (anyDom && anyDow) return "daily";
  if (anyDom && loneValue(c.dow) !== null) return "weekly";
  if (anyDow && loneValue(c.dom) !== null) return "monthly";
  return "custom";
}

/**
 * Read an expression into the builder's controls.
 *
 * The controls are derived from the expression and never the other way round, so what the
 * builder shows is always what the expression actually says. An expression outside the five
 * offered shapes reads as `custom` — the builder then steps aside rather than misdescribing it —
 * and a field the shape does not use carries a sensible default rather than a stale number.
 *
 * @param expr The 5-field expression.
 * @returns The controls, or `null` when the expression is malformed (which is not `custom`:
 * `custom` is a schedule this cannot summarise, `null` is not a schedule at all).
 */
export function cronParts(expr: string): CronParts | null {
  let c: CronExpr;
  try {
    c = parseCron(expr);
  } catch {
    return null;
  }
  return {
    frequency: frequencyOf(c),
    minute: loneValue(c.minute) ?? 0,
    hour: loneValue(c.hour) ?? 0,
    dayOfWeek: loneValue(c.dow) ?? 1,
    dayOfMonth: loneValue(c.dom) ?? 1,
  };
}

/**
 * Compose the expression a set of controls stands for.
 *
 * Only the fields the frequency actually uses are written; the rest stay `*`, so switching from
 * Weekly to Daily cannot leave a weekday behind in the expression.
 *
 * @param parts The controls.
 * @returns The expression, or `""` for `custom` — under Custom the five fields are edited
 * directly and the expression already on the page is the one that stands, so there is nothing
 * here to compose.
 */
export function composeCron(parts: CronParts): string {
  const minute = clampField(parts.minute, 0, 59);
  const hour = clampField(parts.hour, 0, 23);
  const dayOfWeek = clampField(parts.dayOfWeek, 0, 6);
  const dayOfMonth = clampField(parts.dayOfMonth, 1, 31);
  switch (parts.frequency) {
    case "minute":
      return "* * * * *";
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${dayOfWeek}`;
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    default:
      return "";
  }
}
