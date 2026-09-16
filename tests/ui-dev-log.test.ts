// The dev server's retained output (`src/ui/dev-log.ts`).
//
// This buffer is what makes a started dev server visible at all: SSE frames only reach a page
// that is already listening, and both a no-JS navigation and a JS-on panel swap end that
// listening. These assert the properties the panel depends on — a bounded tail, per-project
// isolation, and that clearing one project does not touch another.

import { assert, assertEquals } from "@std/assert";
import { clearDevLog, devLog, devLogText, recordDevLine } from "../src/ui/dev-log.ts";

Deno.test("dev-log: lines come back in order, as text for a <pre>", () => {
  const dir = `/tmp/denext-dev-log-order-${crypto.randomUUID()}`;
  recordDevLine(dir, "Listening on http://localhost:3000");
  recordDevLine(dir, "ready in 120ms");
  assertEquals(devLog(dir), ["Listening on http://localhost:3000", "ready in 120ms"]);
  assertEquals(devLogText(dir), "Listening on http://localhost:3000\nready in 120ms");
  clearDevLog(dir);
});

Deno.test("dev-log: the buffer is a bounded tail, so a chatty server cannot grow it forever", () => {
  const dir = `/tmp/denext-dev-log-cap-${crypto.randomUUID()}`;
  for (let i = 0; i < 600; i++) recordDevLine(dir, `line-${i}`);
  const lines = devLog(dir);
  assert(lines.length < 600, `expected a bounded tail, kept ${lines.length}`);
  // Whatever the cap is, it must keep the NEWEST lines — the tail is what a reader wants.
  assertEquals(lines[lines.length - 1], "line-599");
  clearDevLog(dir);
});

Deno.test("dev-log: projects do not share a buffer, and clearing one leaves the other", () => {
  const a = `/tmp/denext-dev-log-a-${crypto.randomUUID()}`;
  const b = `/tmp/denext-dev-log-b-${crypto.randomUUID()}`;
  recordDevLine(a, "from a");
  recordDevLine(b, "from b");
  assertEquals(devLog(a), ["from a"]);
  assertEquals(devLog(b), ["from b"]);
  clearDevLog(a);
  assertEquals(devLog(a), []);
  assertEquals(devLog(b), ["from b"], "clearing one project must not touch another");
  clearDevLog(b);
});

Deno.test("dev-log: a project with no dev server has an empty log, not a missing one", () => {
  const dir = `/tmp/denext-dev-log-empty-${crypto.randomUUID()}`;
  assertEquals(devLog(dir), []);
  assertEquals(devLogText(dir), "");
});
