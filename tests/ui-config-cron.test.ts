// `/config/cron` — the Cron tab's two pure parts: reading a child's JSON document back, and
// working out when a cron expression next fires.
//
// The panel itself is driven end-to-end by the integration suite (it spawns a real discovery
// child); what is unit-tested here is the logic that would be expensive to reach that way — a
// sparse schedule's horizon, and the noise a child writes around its document.

import { assert, assertEquals } from "@std/assert";
import { parseJsonDocument } from "../src/ui/child-json.ts";
import { nextRuns } from "../src/ui/features/config-cron.ts";

Deno.test("a child's JSON document survives the noise Deno writes around it", () => {
  const doc = '{\n  "tasks": [],\n  "denoCron": false\n}';
  assertEquals(parseJsonDocument<{ denoCron: boolean }>(doc)?.denoCron, false);
  // Deno's own lines before and after the document are dropped.
  const noisy = `Download https://jsr.io/@denext/denext/meta.json\n${doc}\nWarning something`;
  assertEquals(parseJsonDocument<{ denoCron: boolean }>(noisy)?.denoCron, false);
  // Windows line endings, and a document that is the only thing printed.
  assertEquals(parseJsonDocument<{ a: number }>('{\r\n  "a": 1\r\n}')?.a, 1);
});

Deno.test("no parsable document reads as null rather than throwing", () => {
  assertEquals(parseJsonDocument("no json here"), null);
  assertEquals(parseJsonDocument(""), null);
  assertEquals(parseJsonDocument("{\nnot valid json\n}"), null);
  assertEquals(parseJsonDocument("}\n{"), null, "a closing brace before the opening one");
  // A bare array is a valid JSON document but not the object shape every caller expects.
  assertEquals(parseJsonDocument("[1, 2]"), null);
});

Deno.test("nextRuns reports the next firings in UTC", () => {
  const from = new Date("2026-09-16T00:00:00Z");
  assertEquals(nextRuns("0 3 * * *", 2, from), ["2026-09-16 03:00 UTC", "2026-09-17 03:00 UTC"]);
  assertEquals(nextRuns("*/15 * * * *", 2, from), ["2026-09-16 00:15 UTC", "2026-09-16 00:30 UTC"]);
  // Monday, per Vixie day-of-week.
  assertEquals(nextRuns("0 0 * * 1", 1, from), ["2026-09-21 00:00 UTC"]);
});

Deno.test("a sparse schedule still resolves, and a malformed one yields nothing", () => {
  const from = new Date("2026-09-16T00:00:00Z");
  // Once a year: the search has to look far enough ahead without running forever.
  assertEquals(nextRuns("0 6 1 1 *", 1, from), ["2027-01-01 06:00 UTC"]);
  // Asking for more than the horizon holds returns what it found, not a hang.
  assert(nextRuns("0 6 1 1 *", 5, from).length <= 2);
  // A malformed expression never fires, so there is nothing to show.
  assertEquals(nextRuns("99 * * * *", 3, from), []);
  assertEquals(nextRuns("* * *", 3, from), []);
});
