import { assert, assertEquals, assertThrows } from "@std/assert";
import { cronError, cronMatches, parseCron } from "../src/runtime/cron.ts";

// A fixed local date: 2026-03-04 is a Wednesday (getDay()===3); 09:05 local.
const at = (m: number, h: number, dom: number, mon: number, y = 2026) =>
  new Date(y, mon - 1, dom, h, m, 0, 0);

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
  const sunday = new Date(2026, 2, 1, 0, 0); // 2026-03-01 is a Sunday
  assert(cronMatches("0 0 * * 7", sunday));
  assert(cronMatches("0 0 * * 0", sunday));
});

Deno.test("cron: Vixie OR semantics when both dom and dow are restricted", () => {
  // "on the 15th OR on a Monday". 2026-03-04 is a Wednesday, not the 15th → no match.
  assert(!cronMatches("0 0 15 * 1", at(0, 0, 4, 3)));
  // The 15th (a Sunday) → matches on the dom side.
  assert(cronMatches("0 0 15 * 1", at(0, 0, 15, 3)));
  // A Monday that isn't the 15th → matches on the dow side (2026-03-02 is Monday).
  assert(cronMatches("0 0 15 * 1", new Date(2026, 2, 2, 0, 0)));
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
