// `denext job install`'s schedule translation: a UTC cron expression as the calendar rules a
// local-time scheduler (launchd, cron, Task Scheduler) installs, the `--if-due` guard for zones
// with several offsets, and the refusals where a shift can't be followed exactly.

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import {
  formatOffset,
  isDue,
  rulesAtOffset,
  ScheduleTranslationError,
  timeGroups,
  timeRuns,
  translateSchedules,
  zoneOffsets,
} from "../src/cli/job-install/translate.ts";

const at = (h: number, m: number) => h * 60 + m;

Deno.test("UTC: the expression as written", () => {
  assertEquals(rulesAtOffset("30 3 * * *", 0), [{ times: [at(3, 30)], days: {} }]);
  assertEquals(rulesAtOffset("0 9 * * 1-5", 0), [{
    times: [at(9, 0)],
    days: { dow: [1, 2, 3, 4, 5] },
  }]);
});

Deno.test("a negative offset moves 03:00 UTC to 21:00 the day before", () => {
  // America/Chicago in winter: UTC-6.
  assertEquals(rulesAtOffset("0 3 * * *", -360), [{ times: [at(21, 0)], days: {} }]);
});

Deno.test("a weekday moves with a run that crosses midnight", () => {
  // Monday 03:00 UTC is Sunday 21:00 at UTC-6.
  assertEquals(rulesAtOffset("0 3 * * 1", -360), [{ times: [at(21, 0)], days: { dow: [0] } }]);
  // Saturday 22:00 UTC is Sunday 07:00 at UTC+9 (wraps 6 → 0).
  assertEquals(rulesAtOffset("0 22 * * 6", 540), [{ times: [at(7, 0)], days: { dow: [0] } }]);
});

Deno.test("an hour range split by midnight gives one rule per local day", () => {
  // 02:00-07:00 UTC on Monday at UTC-5: 21:00-23:00 Sunday, then 00:00-02:00 Monday.
  assertEquals(rulesAtOffset("0 2-7 * * 1", -300), [
    { times: [at(21, 0), at(22, 0), at(23, 0)], days: { dow: [0] } },
    { times: [at(0, 0), at(1, 0), at(2, 0)], days: { dow: [1] } },
  ]);
});

Deno.test("a day of the month or a month that would cross midnight is refused, naming the field", () => {
  const dom = assertThrows(() => rulesAtOffset("0 3 1 * *", -360), ScheduleTranslationError);
  assert(dom.message.includes("day-of-month"), dom.message);
  assert(dom.message.includes("UTC-06:00"), dom.message);
  const month = assertThrows(() => rulesAtOffset("0 1 * 6 *", -120), ScheduleTranslationError);
  assert(month.message.includes("month"), month.message);
  // The same expressions are fine when no run leaves its day.
  assertEquals(rulesAtOffset("0 12 1 * *", -360), [{ times: [at(6, 0)], days: { dom: [1] } }]);
});

Deno.test("Vixie's either-day rule is kept, and refused across midnight", () => {
  assertEquals(rulesAtOffset("0 12 1,15 * 5", 60), [{
    times: [at(13, 0)],
    days: { dom: [1, 15], dow: [5], either: true },
  }]);
  // A day field that names every day makes every day match.
  assertEquals(rulesAtOffset("0 12 1-31 * 5", 0), [{ times: [at(12, 0)], days: {} }]);
  assertThrows(() => rulesAtOffset("0 1 1 * 5", -120), ScheduleTranslationError);
});

Deno.test("one offset: no guard; several offsets: union + guard", () => {
  const chicago = [-360, -300];
  const fixed = translateSchedules(["0 3 * * *"], [-360]);
  assertFalse(fixed.guarded);
  const dst = translateSchedules(["0 3 * * *"], chicago);
  assert(dst.guarded);
  assertEquals(dst.rules, [{ times: [at(21, 0), at(22, 0)], days: {} }]);
});

Deno.test("a schedule every whole-hour offset agrees on needs no guard", () => {
  const every5 = translateSchedules(["*/5 * * * *"], [-360, -300]);
  assertFalse(every5.guarded);
  assertEquals(every5.rules[0].times.length, 288);
  // A half-hour zone rotates */15 onto itself, but not */20.
  assertFalse(translateSchedules(["*/15 * * * *"], [330, 390]).guarded);
  assert(translateSchedules(["*/20 * * * *"], [330, 360]).guarded);
});

Deno.test("several expressions of one job merge by day", () => {
  const t = translateSchedules(["0 6 * * *", "30 18 * * *"], [0]);
  assertEquals(t.rules, [{ times: [at(6, 0), at(18, 30)], days: {} }]);
});

Deno.test("isDue checks the UTC minute against any expression", () => {
  const now = new Date(Date.UTC(2026, 10, 2, 3, 0, 42)); // Monday 03:00:42 UTC
  assert(isDue("0 3 * * *", now));
  assert(isDue("15 4 * * *;0 3 * * 1", now));
  assertFalse(isDue("0 4 * * *", now));
  assertFalse(isDue("0 3 * * 2", now));
  assertThrows(() => isDue("not a cron", now));
});

Deno.test("zoneOffsets includes this zone's current offset", () => {
  const offsets = zoneOffsets();
  assert(offsets.length >= 1);
  assert(offsets.includes(-new Date().getTimezoneOffset() || 0), String(offsets));
  assertEquals([...offsets].sort((a, b) => a - b), offsets);
});

Deno.test("formatOffset", () => {
  assertEquals(formatOffset(-360), "-06:00");
  assertEquals(formatOffset(330), "+05:30");
  assertEquals(formatOffset(0), "+00:00");
});

Deno.test("timeRuns splits times into evenly spaced runs", () => {
  assertEquals(timeRuns([0, 5, 10, 15]), [{ start: 0, step: 5, count: 4 }]);
  assertEquals(timeRuns([60]), [{ start: 60, step: 1, count: 1 }]);
  assertEquals(timeRuns([0, 5, 7, 9, 30]), [
    { start: 0, step: 5, count: 2 },
    { start: 7, step: 2, count: 2 },
    { start: 30, step: 1, count: 1 },
  ]);
});

Deno.test("timeGroups shares one minute set across hours", () => {
  assertEquals(timeGroups([at(9, 0), at(9, 30), at(10, 0), at(10, 30), at(11, 15)]), [
    { hours: [9, 10], minutes: [0, 30] },
    { hours: [11], minutes: [15] },
  ]);
});
