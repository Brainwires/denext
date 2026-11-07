// A job's cron schedule as an OS scheduler can express it: `denext job install`.
//
// denext evaluates every schedule in UTC (as `Deno.cron` does). systemd timers take a time zone
// (`… UTC`), so they get the expression as written; launchd, cron and Task Scheduler read their
// calendars in the machine's local time, so for them the schedule is shifted by the zone's offset
// from UTC. A zone keeps one offset or moves between several (daylight saving time): one offset
// translates exactly, and several translate once per offset, the union installed with a guard
// (`denext job <name> --if-due <cron>`) that runs the job only in a minute the UTC expression
// matches. A shift that moves a run across midnight is exact for a weekday (the day moves with it)
// but not for a day of the month or a month (the 31st moves to the 1st of a month the field does
// not name), so such a schedule is refused rather than installed wrong.

import { type CronExpr, cronMatches, parseCron } from "../../runtime/cron.ts";

/** Minutes in a day. */
const DAY = 1440;

/**
 * Which days a rule fires on, in the scheduler's own calendar. An absent set means any.
 * `either` is Vixie cron's rule for a schedule that restricts both day fields: a day matches
 * when the day of the month OR the weekday does.
 */
export interface DaySelector {
  /** Days of the month (1-31). */
  readonly dom?: readonly number[];
  /** Weekdays (0-6, 0 = Sunday). */
  readonly dow?: readonly number[];
  /** Months (1-12). */
  readonly month?: readonly number[];
  /** Both `dom` and `dow` are set and either one matching is enough. */
  readonly either?: boolean;
}

/** One calendar rule: the times of day (minutes after midnight) on the days `days` selects. */
export interface CalendarRule {
  /** Minutes after midnight, ascending, without duplicates. */
  readonly times: readonly number[];
  readonly days: DaySelector;
}

/** A schedule as an OS scheduler installs it. */
export interface TranslatedSchedule {
  /** The rules; their union is when the entry fires. */
  readonly rules: readonly CalendarRule[];
  /**
   * The rules over-approximate the schedule (the zone has several offsets), so the entry must
   * pass `--if-due` for the job to run only in the minutes the UTC expression matches.
   */
  readonly guarded: boolean;
}

/** Why a schedule can't be installed in local time. */
export class ScheduleTranslationError extends Error {
  override name = "ScheduleTranslationError";
}

/** The numbers in `set`, ascending. */
function sorted(set: Iterable<number>): number[] {
  return [...set].sort((a, b) => a - b);
}

/** The day selector a parsed expression means, before any shift. */
function selectorOf(c: CronExpr): DaySelector {
  const domFull = c.dom.size === 31;
  const dowFull = c.dow.size === 7;
  const month = c.month.size === 12 ? {} : { month: sorted(c.month) };
  if (c.domAndDowRestricted) {
    // Vixie OR: a field that names every day makes every day match.
    if (domFull || dowFull) return month;
    return { dom: sorted(c.dom), dow: sorted(c.dow), either: true, ...month };
  }
  if (!domFull) return { dom: sorted(c.dom), ...month };
  if (!dowFull) return { dow: sorted(c.dow), ...month };
  return month;
}

/** The field a midnight shift can't carry exactly, or `null` when it can. */
function unshiftableField(days: DaySelector): string | null {
  if (days.dom) return "day-of-month";
  if (days.month) return "month";
  return null;
}

/** `+05:30` / `-06:00` for an offset in minutes. */
export function formatOffset(offset: number): string {
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** `days` moved by `carry` days (only a weekday or "any" can move). */
function shiftDays(days: DaySelector, carry: number): DaySelector {
  if (carry === 0 || !days.dow) return days;
  const dow = sorted(new Set(days.dow.map((d) => (((d + carry) % 7) + 7) % 7)));
  return { ...days, dow };
}

/**
 * The calendar rules `expr` (UTC) means on a clock `offset` minutes ahead of UTC.
 *
 * @param expr A valid 5-field cron expression.
 * @param offset Local time minus UTC, in minutes (`-360` for UTC-6).
 * @returns One rule per day the shift lands runs on (the same day, the day before or after).
 * @throws {ScheduleTranslationError} When a run moves across midnight and the expression
 *   restricts the day of the month or the month.
 */
export function rulesAtOffset(expr: string, offset: number): CalendarRule[] {
  const c = parseCron(expr);
  const days = selectorOf(c);
  const byCarry = new Map<number, Set<number>>();
  for (const h of c.hour) {
    for (const m of c.minute) {
      const local = h * 60 + m + offset;
      const carry = Math.floor(local / DAY);
      const set = byCarry.get(carry) ?? new Set<number>();
      set.add(local - carry * DAY);
      byCarry.set(carry, set);
    }
  }
  const rules: CalendarRule[] = [];
  for (const carry of sorted(byCarry.keys())) {
    const field = carry === 0 ? null : unshiftableField(days);
    if (field) {
      throw new ScheduleTranslationError(
        `"${expr}" can't be installed in local time: at UTC${formatOffset(offset)} some runs ` +
          `move to the ${carry > 0 ? "next" : "previous"} day, which the ${field} field can't ` +
          `follow exactly. Pick hours that stay on the same local day, or use a weekday instead.`,
      );
    }
    rules.push({ times: sorted(byCarry.get(carry) as Set<number>), days: shiftDays(days, carry) });
  }
  return rules;
}

/** A stable text key for a day selector. */
function daysKey(days: DaySelector): string {
  return JSON.stringify([days.dom ?? null, days.dow ?? null, days.month ?? null, !!days.either]);
}

/** Rules with the same days merged into one, in a stable order. */
function mergeRules(rules: readonly CalendarRule[]): CalendarRule[] {
  const byDays = new Map<string, { days: DaySelector; times: Set<number> }>();
  for (const rule of rules) {
    const key = daysKey(rule.days);
    const slot = byDays.get(key) ?? { days: rule.days, times: new Set<number>() };
    for (const t of rule.times) slot.times.add(t);
    byDays.set(key, slot);
  }
  return [...byDays.keys()].sort().map((key) => {
    const slot = byDays.get(key) as { days: DaySelector; times: Set<number> };
    return { days: slot.days, times: sorted(slot.times) };
  });
}

/** A stable text key for a rule set. */
function rulesKey(rules: readonly CalendarRule[]): string {
  return JSON.stringify(rules.map((r) => [daysKey(r.days), r.times]));
}

/**
 * Every schedule of one job, as one set of local-time rules.
 *
 * @param exprs The job's cron expressions (UTC).
 * @param offsets Every offset from UTC the zone takes (minutes); `[0]` for a UTC scheduler.
 * @returns The merged rules, and whether they need the `--if-due` guard.
 * @throws {ScheduleTranslationError} When an expression can't be expressed at some offset.
 */
export function translateSchedules(
  exprs: readonly string[],
  offsets: readonly number[],
): TranslatedSchedule {
  const perOffset = (offsets.length === 0 ? [0] : offsets).map((offset) =>
    mergeRules(exprs.flatMap((expr) => rulesAtOffset(expr, offset)))
  );
  const keys = new Set(perOffset.map(rulesKey));
  return { rules: mergeRules(perOffset.flat()), guarded: keys.size > 1 };
}

/** How often {@linkcode zoneOffsets} samples the zone (6 hours: no offset lasts less). */
const SAMPLE_MS = 6 * 3600_000;

/**
 * Every offset from UTC this process's time zone (`TZ`, else the system's) takes over the next
 * `days` days, ascending.
 *
 * @param from Where the window starts (default: now).
 * @param days How far ahead to look (default: a little over a year, so every DST rule is seen).
 * @returns Offsets in minutes (local minus UTC).
 */
export function zoneOffsets(from: Date = new Date(), days = 400): number[] {
  const seen = new Set<number>();
  const end = from.getTime() + days * 86_400_000;
  for (let t = from.getTime(); t <= end; t += SAMPLE_MS) {
    // `|| 0` folds the `-0` a UTC zone gives.
    seen.add(-new Date(t).getTimezoneOffset() || 0);
  }
  return sorted(seen);
}

/** One run of evenly spaced times: `count` times from `start`, `step` minutes apart. */
export interface TimeRun {
  readonly start: number;
  readonly step: number;
  readonly count: number;
}

/**
 * Times of day split greedily into evenly spaced runs (what a Task Scheduler trigger with a
 * repetition interval expresses).
 *
 * @param times Minutes after midnight, ascending.
 */
export function timeRuns(times: readonly number[]): TimeRun[] {
  const runs: TimeRun[] = [];
  let i = 0;
  while (i < times.length) {
    const start = times[i];
    if (i + 1 >= times.length) {
      runs.push({ start, step: 1, count: 1 });
      break;
    }
    const step = times[i + 1] - start;
    let count = 2;
    while (i + count < times.length && times[i + count] - times[i + count - 1] === step) count++;
    runs.push({ start, step, count });
    i += count;
  }
  return runs;
}

/** Hours that share one set of minutes. */
export interface TimeGroup {
  /** Hours (0-23), ascending. */
  readonly hours: readonly number[];
  /** Minutes (0-59), ascending. */
  readonly minutes: readonly number[];
}

/**
 * Times of day grouped as cron and launchd write them: the hours whose minutes are the same set
 * share a group (an expression's own times are one group).
 *
 * @param times Minutes after midnight, ascending.
 */
export function timeGroups(times: readonly number[]): TimeGroup[] {
  const byHour = new Map<number, number[]>();
  for (const t of times) {
    const h = Math.floor(t / 60);
    byHour.set(h, [...(byHour.get(h) ?? []), t % 60]);
  }
  const byMinutes = new Map<string, { hours: number[]; minutes: number[] }>();
  for (const h of sorted(byHour.keys())) {
    const minutes = byHour.get(h) as number[];
    const key = minutes.join(",");
    const group = byMinutes.get(key) ?? { hours: [], minutes };
    group.hours.push(h);
    byMinutes.set(key, group);
  }
  return [...byMinutes.values()];
}

/** What separates the expressions in an `--if-due` list (no cron expression holds one). */
export const DUE_SEPARATOR = ";";

/**
 * Whether any expression in an `--if-due` list matches the minute `now` falls in (UTC): the
 * guard an entry translated for a zone with several offsets runs behind.
 *
 * @param list Expressions separated by {@linkcode DUE_SEPARATOR}.
 * @param now The moment the OS started the run.
 * @throws {Error} When an expression is malformed.
 */
export function isDue(list: string, now: Date = new Date()): boolean {
  return list.split(DUE_SEPARATOR).map((e) => e.trim()).filter(Boolean)
    .some((expr) => cronMatches(expr, now));
}
