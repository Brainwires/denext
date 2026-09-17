import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  composeCron,
  cronError,
  cronMatches,
  cronParts,
  describeCron,
  parseCron,
} from "../src/runtime/cron.ts";

// A fixed UTC date (cronMatches evaluates in UTC): 2026-03-04 is a Wednesday
// (getUTCDay()===3); 09:05 UTC.
const at = (m: number, h: number, dom: number, mon: number, y = 2026) =>
  new Date(Date.UTC(y, mon - 1, dom, h, m, 0, 0));

Deno.test("cron: * * * * * matches every minute", () => {
  assert(cronMatches("* * * * *", at(5, 9, 4, 3)));
  assert(cronMatches("* * * * *", at(0, 0, 1, 1)));
});

Deno.test("cron: exact minute/hour", () => {
  assert(cronMatches("5 9 * * *", at(5, 9, 4, 3)));
  assert(!cronMatches("5 9 * * *", at(6, 9, 4, 3)));
  assert(!cronMatches("5 9 * * *", at(5, 10, 4, 3)));
});

Deno.test("cron: step, range, and list fields", () => {
  assert(cronMatches("*/15 * * * *", at(0, 1, 1, 1)));
  assert(cronMatches("*/15 * * * *", at(45, 1, 1, 1)));
  assert(!cronMatches("*/15 * * * *", at(46, 1, 1, 1)));
  assert(cronMatches("0 9-17 * * *", at(0, 12, 4, 3)));
  assert(!cronMatches("0 9-17 * * *", at(0, 8, 4, 3)));
  assert(cronMatches("0 0 * * 1,3,5", at(0, 0, 4, 3))); // Wed is in {1,3,5}
  assert(!cronMatches("0 0 * * 2,4", at(0, 0, 4, 3)));
});

Deno.test("cron: day-of-week 7 normalizes to Sunday", () => {
  const sunday = new Date(Date.UTC(2026, 2, 1, 0, 0)); // 2026-03-01 is a Sunday (UTC)
  assert(cronMatches("0 0 * * 7", sunday));
  assert(cronMatches("0 0 * * 0", sunday));
});

Deno.test("cron: Vixie OR semantics when both dom and dow are restricted", () => {
  // "on the 15th OR on a Monday". 2026-03-04 is a Wednesday, not the 15th → no match.
  assert(!cronMatches("0 0 15 * 1", at(0, 0, 4, 3)));
  // The 15th (a Sunday) → matches on the dom side.
  assert(cronMatches("0 0 15 * 1", at(0, 0, 15, 3)));
  // A Monday that isn't the 15th → matches on the dow side (2026-03-02 is Monday).
  assert(cronMatches("0 0 15 * 1", new Date(Date.UTC(2026, 2, 2, 0, 0))));
});

Deno.test("cron: dom AND dow when only one is restricted", () => {
  // Only dow restricted → plain AND (dom is *).
  assert(cronMatches("0 0 * * 3", at(0, 0, 4, 3))); // Wednesday
  assert(!cronMatches("0 0 * * 3", at(0, 0, 5, 3))); // Thursday
});

Deno.test("cron: malformed expressions throw / report an error", () => {
  assertThrows(() => parseCron("* * * *"), Error); // 4 fields
  assertThrows(() => parseCron("60 * * * *"), Error); // minute out of range
  assertThrows(() => parseCron("* 24 * * *"), Error); // hour out of range
  assertThrows(() => parseCron("*/0 * * * *"), Error); // zero step
  assertEquals(cronError("*/15 9 * * 1-5"), null);
  assert(cronError("nope") !== null);
});

Deno.test("describeCron: the everyday shapes, stated exactly", () => {
  assertEquals(describeCron("30 3 * * *"), "every day at 03:30 UTC");
  assertEquals(describeCron("0 0 * * *"), "every day at 00:00 UTC");
  assertEquals(describeCron("* * * * *"), "every minute");
  assertEquals(describeCron("0 8 * * 1"), "on Mondays at 08:00 UTC");
  assertEquals(describeCron("0 0 1 * *"), "on the 1st at 00:00 UTC");
});

Deno.test("describeCron: how it was written does not change what it says", () => {
  // parseCron keeps the SET of matching values, so these are the same schedule — and the
  // description says what fires rather than how someone spelled it.
  assertEquals(describeCron("*/15 * * * *"), describeCron("0,15,30,45 * * * *"));
  assertEquals(describeCron("0 0-2 * * *"), describeCron("0 0,1,2 * * *"));
});

Deno.test("describeCron: several times a day are listed", () => {
  assertEquals(describeCron("0 9,17 * * *"), "every day at 09:00 and 17:00 UTC");
  assertEquals(describeCron("0,30 9 * * *"), "every day at 09:00 and 09:30 UTC");
});

Deno.test("describeCron: months are named when the schedule is restricted to them", () => {
  assertEquals(describeCron("0 6 1 1 *"), "on the 1st at 06:00 UTC in January");
});

Deno.test("describeCron: an expression it cannot state plainly says so, truthfully", () => {
  // Vixie fires on EITHER day field when both are restricted. "the 1st and Mondays" would be
  // wrong, so it declines rather than inventing English.
  const both = describeCron("0 0 1 * 1");
  assert(both !== null && both.startsWith("a custom schedule"), String(both));
  // Too many distinct firing times to list.
  const many = describeCron("*/5 9-17 * * *");
  assert(many !== null && many.includes("custom"), String(many));
});

Deno.test("describeCron: a malformed expression has no description", () => {
  assertEquals(describeCron("99 * * * *"), null);
  assertEquals(describeCron("* * *"), null);
  assertEquals(describeCron(""), null);
});

Deno.test("describeCron: it reads as English, not as assembled fragments", () => {
  // These passed once while saying "every Mondays" — the assertion agreed with the bug.
  assertEquals(describeCron("0 8 * * 1"), "on Mondays at 08:00 UTC");
  assertEquals(describeCron("0 8 * * 1,5"), "on Mondays and Fridays at 08:00 UTC");
  assertEquals(describeCron("* 9 * * *"), "every minute of the 09:00 hour (UTC)");
  assertEquals(describeCron("* 9,17 * * *"), "every minute of the 09:00 and 17:00 hours (UTC)");
  // No description should contain a doubled article or a stray plural.
  for (const expr of ["30 3 * * *", "0 8 * * 1", "* 9 * * *", "0 0 1 * *"]) {
    const said = describeCron(expr) ?? "";
    assert(!said.includes("every Mondays"), said);
    assert(!/\bthe the\b/.test(said), said);
    assert(said.length > 0 && said === said.trim(), `"${said}" is untrimmed`);
  }
});

// --- the schedule builder ----------------------------------------------------
//
// The UI's cron editor offers a frequency and a few fields. These pin the contract that keeps it
// honest: the controls are DERIVED from the expression, so the builder can never claim a
// schedule says something it does not.

Deno.test("cronParts: the five shapes the builder offers, and custom for everything else", () => {
  assertEquals(cronParts("* * * * *")?.frequency, "minute");
  assertEquals(cronParts("0 * * * *")?.frequency, "hourly");
  assertEquals(cronParts("30 3 * * *")?.frequency, "daily");
  assertEquals(cronParts("0 8 * * 1")?.frequency, "weekly");
  assertEquals(cronParts("0 3 1 * *")?.frequency, "monthly");
  // Real schedules the five shapes cannot state: a step, a list of days, a pinned month.
  assertEquals(cronParts("*/15 * * * *")?.frequency, "custom");
  assertEquals(cronParts("0 0 * * 1,3,5")?.frequency, "custom");
  assertEquals(cronParts("0 6 1 1 *")?.frequency, "custom", "January is not monthly");
  // Malformed is not `custom`: custom is a schedule this cannot summarise, null is no schedule.
  assertEquals(cronParts("99 * * * *"), null);
  assertEquals(cronParts("* * *"), null);
});

Deno.test("cronParts: the controls carry what the expression actually says", () => {
  const daily = cronParts("30 3 * * *")!;
  assertEquals([daily.minute, daily.hour], [30, 3]);
  const weekly = cronParts("15 8 * * 5")!;
  assertEquals([weekly.minute, weekly.hour, weekly.dayOfWeek], [15, 8, 5]);
  const monthly = cronParts("0 4 12 * *")!;
  assertEquals([monthly.minute, monthly.hour, monthly.dayOfMonth], [0, 4, 12]);
  // Sunday is 0, because that is what parseCron normalises `7` to.
  assertEquals(cronParts("0 0 * * 7")?.dayOfWeek, 0);
});

Deno.test("composeCron round-trips every expression the builder can produce", () => {
  // The expression is what gets written to the config, so this is the direction that matters:
  // reading one into the controls and composing it back must be the same schedule, character
  // for character — otherwise opening the editor would silently rewrite a saved expression.
  for (const expr of ["* * * * *", "0 * * * *", "0 3 * * *", "0 3 * * 1", "0 3 1 * *"]) {
    const parts = cronParts(expr);
    assert(parts !== null, expr);
    assertEquals(composeCron(parts), expr, expr);
  }
  // And every shape the controls can be set to reads back as that same shape.
  for (const frequency of ["minute", "hourly", "daily", "weekly", "monthly"] as const) {
    const parts = { frequency, minute: 7, hour: 13, dayOfWeek: 4, dayOfMonth: 9 };
    assertEquals(cronParts(composeCron(parts))?.frequency, frequency, frequency);
  }
});

Deno.test("composeCron writes only the fields its frequency uses", () => {
  const weekly = { frequency: "weekly" as const, minute: 30, hour: 8, dayOfWeek: 1, dayOfMonth: 9 };
  assertEquals(composeCron(weekly), "30 8 * * 1", "the day-of-month is not carried along");
  assert(cronMatches("30 8 * * 1", at(30, 8, 2, 3)), "Monday 2026-03-02");
  assert(!cronMatches("30 8 * * 1", at(30, 8, 4, 3)), "but not the Wednesday");
  // Switching to Daily must not leave the weekday behind in the expression.
  assertEquals(composeCron({ ...weekly, frequency: "daily" }), "30 8 * * *");
  // Custom composes nothing: the expression already on the page is the one that stands.
  assertEquals(composeCron({ ...weekly, frequency: "custom" }), "");
});

Deno.test("composeCron clamps a control rather than writing a broken expression", () => {
  assertEquals(
    composeCron({ frequency: "daily", minute: 99, hour: -3, dayOfWeek: 0, dayOfMonth: 1 }),
    "59 0 * * *",
  );
  // Whatever the controls hold, what comes out always parses.
  const wild = { frequency: "monthly" as const, minute: 0, hour: 0, dayOfWeek: 0, dayOfMonth: 99 };
  assertEquals(cronError(composeCron(wild)), null);
  assertEquals(composeCron(wild), "0 0 31 * *");
});
