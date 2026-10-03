// The local-notification trigger math shared by `denext/mobile` and the Deno Desktop
// `notifications` capability (src/mobile/notification-trigger.ts): range checks on every trigger
// field, and when each kind of trigger fires next. All times are built in local time, so the
// expectations hold in any time zone.

import { assertEquals, assertThrows } from "@std/assert";
import {
  dateOf,
  int,
  type LocalNotificationTrigger,
  nextMatch,
  nextTriggerDate,
  secondsOf,
  triggerComponents,
} from "../src/mobile/notification-trigger.ts";

/** A local time. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s);

Deno.test("int: whole numbers in range pass; anything else is a RangeError naming the field", () => {
  assertEquals(int("f", "hour", 0, 0, 23), 0);
  assertEquals(int("f", "hour", 23, 0, 23), 23);
  for (const bad of [-1, 24, 1.5, NaN, "3", null, undefined]) {
    const err = assertThrows(() => int("schedule", "hour", bad, 0, 23), RangeError);
    assertEquals(err.message, "schedule: hour must be a whole number from 0 to 23");
  }
});

Deno.test("triggerComponents: each repeating kind maps to its calendar components", () => {
  assertEquals(triggerComponents("f", { type: "daily", hour: 9, minute: 30 }), {
    hour: 9,
    minute: 30,
  });
  assertEquals(triggerComponents("f", { type: "weekly", weekday: 2, hour: 8, minute: 0 }), {
    weekday: 2,
    hour: 8,
    minute: 0,
  });
  assertEquals(triggerComponents("f", { type: "monthly", day: 15, hour: 12, minute: 5 }), {
    day: 15,
    hour: 12,
    minute: 5,
  });
  assertEquals(
    triggerComponents("f", { type: "yearly", month: 12, day: 25, hour: 7, minute: 0 }),
    { month: 12, day: 25, hour: 7, minute: 0 },
  );
  // A calendar trigger keeps only the components it sets (and drops `type` / `repeats`).
  assertEquals(
    triggerComponents("f", { type: "calendar", repeats: true, year: 2030, second: 15 }),
    { year: 2030, second: 15 },
  );
  // One-shot kinds have no calendar components.
  assertEquals(triggerComponents("f", { type: "date", date: 0 }), null);
  assertEquals(triggerComponents("f", { type: "interval", seconds: 5 }), null);
});

Deno.test("triggerComponents: every component is range-checked", () => {
  const bad: LocalNotificationTrigger[] = [
    { type: "daily", hour: 24, minute: 0 },
    { type: "daily", hour: 1, minute: 60 },
    { type: "weekly", weekday: 0, hour: 1, minute: 0 }, // weekdays are 1–7
    { type: "weekly", weekday: 8, hour: 1, minute: 0 },
    { type: "monthly", day: 32, hour: 1, minute: 0 },
    { type: "yearly", month: 13, day: 1, hour: 1, minute: 0 },
    { type: "calendar", year: 1969 },
    { type: "calendar", second: 60 },
    { type: "calendar", day: 0 },
  ];
  for (const t of bad) assertThrows(() => triggerComponents("schedule", t), RangeError);
});

Deno.test("nextMatch: unset components match anything; the time is strictly after `after`", () => {
  const from = at(2030, 3, 10, 9, 15, 0).getTime();
  // Nothing set: the next whole minute (second 0) after `from`.
  assertEquals(nextMatch({}, from), at(2030, 3, 10, 9, 16));
  // Exactly `from` does not count; a set second within the same minute does.
  assertEquals(nextMatch({ second: 30 }, from), at(2030, 3, 10, 9, 15, 30));
  // Hour set, minute free: the first minute of the next matching hour.
  assertEquals(nextMatch({ hour: 11 }, from), at(2030, 3, 10, 11, 0));
  // An hour already past today rolls to tomorrow.
  assertEquals(nextMatch({ hour: 8, minute: 0 }, from), at(2030, 3, 11, 8, 0));
  // Weekday 1 = Sunday: 2030-03-10 is a Sunday, so the next Sunday 8:00 is the 17th.
  assertEquals(at(2030, 3, 10).getDay(), 0);
  assertEquals(nextMatch({ weekday: 1, hour: 8, minute: 0 }, from), at(2030, 3, 17, 8, 0));
  // Month + day across a year boundary.
  assertEquals(nextMatch({ month: 1, day: 1, hour: 0, minute: 0 }, from), at(2031, 1, 1));
  // A year that has passed, or a date that does not exist, never matches.
  assertEquals(nextMatch({ year: 2029 }, from), null);
  assertEquals(nextMatch({ month: 4, day: 31 }, from), null);
  // Feb 29 is found in the next leap year (within the eight-year search).
  assertEquals(nextMatch({ month: 2, day: 29, hour: 0, minute: 0 }, from), at(2032, 2, 29));
});

Deno.test("dateOf: a Date or a finite timestamp; anything else is a TypeError", () => {
  assertEquals(dateOf("f", 1234), 1234);
  assertEquals(dateOf("f", new Date(5678)), 5678);
  for (const bad of [NaN, Infinity, new Date("nope"), "2030-01-01" as unknown as number]) {
    const err = assertThrows(() => dateOf("schedule", bad), TypeError);
    assertEquals(
      err.message,
      "schedule: trigger.date must be a Date or a timestamp in milliseconds",
    );
  }
});

Deno.test("secondsOf: at least 1, or at least 60 when repeating", () => {
  assertEquals(secondsOf("f", { seconds: 1 }), 1);
  assertEquals(secondsOf("f", { seconds: 60, repeats: true }), 60);
  assertEquals(secondsOf("f", { seconds: 0.5 + 1 }), 1.5);
  assertEquals(
    assertThrows(() => secondsOf("s", { seconds: 0 }), RangeError).message,
    "s: trigger.seconds must be at least 1",
  );
  assertEquals(
    assertThrows(() => secondsOf("s", { seconds: 59, repeats: true }), RangeError).message,
    "s: trigger.seconds must be at least 60 for a repeating interval",
  );
  for (const bad of [Infinity, NaN, "5" as unknown as number]) {
    assertThrows(() => secondsOf("s", { seconds: bad }), RangeError);
  }
});

Deno.test("nextTriggerDate: one-shot and repeating kinds, with `from` defaulting to now", () => {
  const from = at(2030, 6, 1, 12, 0).getTime();
  const future = at(2030, 6, 2, 9, 0);
  assertEquals(nextTriggerDate({ type: "date", date: future }, from), future);
  assertEquals(nextTriggerDate({ type: "date", date: from }, from), null); // not strictly later
  assertEquals(
    nextTriggerDate({ type: "interval", seconds: 120, repeats: true }, from),
    new Date(from + 120_000),
  );
  assertEquals(
    nextTriggerDate({ type: "monthly", day: 1, hour: 12, minute: 0 }, from),
    at(2030, 7, 1, 12, 0),
  );
  assertEquals(
    nextTriggerDate({ type: "calendar", repeats: false, hour: 13 }, from),
    at(2030, 6, 1, 13, 0),
  );
  // Default `from`: an interval fires that many seconds after now.
  const before = Date.now();
  const next = nextTriggerDate({ type: "interval", seconds: 10 })!.getTime();
  assertEquals(next >= before + 10_000 && next <= Date.now() + 10_000, true);
  // Bad input surfaces the same errors as scheduling would.
  assertThrows(() => nextTriggerDate({ type: "daily", hour: 25, minute: 0 }, from), RangeError);
  assertThrows(() => nextTriggerDate({ type: "date", date: NaN }, from), TypeError);
});
