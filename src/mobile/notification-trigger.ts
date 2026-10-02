/**
 * The trigger types of `denext/mobile`'s local notifications and the calendar math behind them
 * (when a trigger fires next). Shared by the page module (`./local-notifications.ts`) and the Deno
 * Desktop `notifications` capability, which schedules the occurrences of a repeating trigger
 * itself. Pure: no imports, nothing runs at import.
 *
 * @module
 */

/**
 * When a local notification fires. Months are 1–12 and weekdays 1–7 with 1 = Sunday (the
 * plugin's and iOS's convention); times are the device's local time.
 *
 * - `date`: once, at that moment.
 * - `interval`: `seconds` from now; with `repeats`, every `seconds` after that (at least 60).
 * - `daily` / `weekly` / `monthly` / `yearly`: repeating at that local time.
 * - `calendar`: whenever the given components match (unset ones match anything); with
 *   `repeats: false` only the next match.
 */
export type LocalNotificationTrigger =
  | { readonly type: "date"; readonly date: Date | number }
  | { readonly type: "interval"; readonly seconds: number; readonly repeats?: boolean }
  | { readonly type: "daily"; readonly hour: number; readonly minute: number }
  | {
    readonly type: "weekly";
    readonly weekday: number;
    readonly hour: number;
    readonly minute: number;
  }
  | {
    readonly type: "monthly";
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
  }
  | {
    readonly type: "yearly";
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
  }
  | ({ readonly type: "calendar"; readonly repeats?: boolean } & CalendarComponents);

/** The date components a `calendar` trigger matches. */
export interface CalendarComponents {
  /** The year. */
  readonly year?: number;
  /** The month, 1–12. */
  readonly month?: number;
  /** The day of the month, 1–31. */
  readonly day?: number;
  /** The weekday, 1–7 with 1 = Sunday. */
  readonly weekday?: number;
  /** The hour, 0–23. */
  readonly hour?: number;
  /** The minute, 0–59. */
  readonly minute?: number;
  /** The second, 0–59 (default 0). */
  readonly second?: number;
}

/** A whole number in [min, max], or a RangeError naming `what`. */
export function int(fn: string, what: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${fn}: ${what} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/** The optional calendar components, range-checked. */
function components(fn: string, c: CalendarComponents): CalendarComponents {
  const out: Record<string, number> = {};
  const ranges: Array<[keyof CalendarComponents, number, number]> = [
    ["year", 1970, 9999],
    ["month", 1, 12],
    ["day", 1, 31],
    ["weekday", 1, 7],
    ["hour", 0, 23],
    ["minute", 0, 59],
    ["second", 0, 59],
  ];
  for (const [key, min, max] of ranges) {
    if (c[key] !== undefined) out[key] = int(fn, key, c[key], min, max);
  }
  return out;
}

/** A trigger's calendar components (for the repeating kinds), checked. */
export function triggerComponents(
  fn: string,
  t: LocalNotificationTrigger,
): CalendarComponents | null {
  switch (t.type) {
    case "daily":
      return components(fn, { hour: t.hour, minute: t.minute });
    case "weekly":
      return components(fn, { weekday: t.weekday, hour: t.hour, minute: t.minute });
    case "monthly":
      return components(fn, { day: t.day, hour: t.hour, minute: t.minute });
    case "yearly":
      return components(fn, { month: t.month, day: t.day, hour: t.hour, minute: t.minute });
    case "calendar":
      return components(fn, t);
    default:
      return null;
  }
}

/** Whether `date` matches `c` (unset components match anything). */
function matches(date: Date, c: CalendarComponents): boolean {
  return (c.year === undefined || date.getFullYear() === c.year) &&
    (c.month === undefined || date.getMonth() + 1 === c.month) &&
    (c.day === undefined || date.getDate() === c.day) &&
    (c.weekday === undefined || date.getDay() + 1 === c.weekday);
}

/** The first local time on `day` at or after `after` whose time matches `c`, or null. */
function timeOnDay(day: Date, after: number, c: CalendarComponents): Date | null {
  const hours = c.hour === undefined ? [...Array(24).keys()] : [c.hour];
  const minutes = c.minute === undefined ? [...Array(60).keys()] : [c.minute];
  for (const h of hours) {
    for (const m of minutes) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, c.second ?? 0);
      if (at.getTime() > after) return at;
    }
  }
  return null;
}

/** The next local time after `after` matching `c`, searching up to eight years ahead. */
export function nextMatch(c: CalendarComponents, after: number): Date | null {
  const start = new Date(after);
  for (let i = 0; i < 366 * 8; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (!matches(day, c)) continue;
    const at = timeOnDay(day, after, c);
    if (at) return at;
  }
  return null;
}

/** A `date` trigger's time, checked. */
export function dateOf(fn: string, date: Date | number): number {
  const ms = date instanceof Date ? date.getTime() : date;
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    throw new TypeError(`${fn}: trigger.date must be a Date or a timestamp in milliseconds`);
  }
  return ms;
}

/** An `interval` trigger's seconds, checked (a repeating one needs at least 60). */
export function secondsOf(fn: string, t: { seconds: number; repeats?: boolean }): number {
  const min = t.repeats ? 60 : 1;
  if (typeof t.seconds !== "number" || !Number.isFinite(t.seconds) || t.seconds < min) {
    throw new RangeError(
      `${fn}: trigger.seconds must be at least ${min}${
        t.repeats ? " for a repeating interval" : ""
      }`,
    );
  }
  return t.seconds;
}

/**
 * When `trigger` next fires after `from` (default now), or null when it never will (a date in
 * the past, a calendar match that does not exist). Internal to `denext/mobile` and the Expo
 * shim's `getNextTriggerDateAsync`.
 */
export function nextTriggerDate(
  trigger: LocalNotificationTrigger,
  from: number = Date.now(),
): Date | null {
  const fn = "nextTriggerDate";
  if (trigger.type === "date") {
    const at = dateOf(fn, trigger.date);
    return at > from ? new Date(at) : null;
  }
  if (trigger.type === "interval") return new Date(from + secondsOf(fn, trigger) * 1000);
  const c = triggerComponents(fn, trigger);
  if (!c) {
    throw new TypeError(
      `${fn}: unknown trigger type "${String((trigger as { type?: unknown }).type)}"`,
    );
  }
  return nextMatch(c, from);
}
