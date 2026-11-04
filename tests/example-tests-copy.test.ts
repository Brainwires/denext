// The example integration tests that build an app build a private copy of it
// (tests/helpers/example-copy.ts), never the checkout's example: a build resolves the example's
// graph under its own deno.lock and records what it adds, so building the checkout's copy left
// the suite's tree dirty (examples/*/deno.lock rewritten) whenever the graph grew.

import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const DIR = fromFileUrl(new URL("./integration/", import.meta.url));

Deno.test("example integration tests build a private copy, never the checkout's example", async () => {
  const building: string[] = [];
  const offenders: string[] = [];
  for await (const e of Deno.readDir(DIR)) {
    if (!/^example-.*\.test\.ts$/.test(e.name)) continue;
    const src = await Deno.readTextFile(join(DIR, e.name));
    if (!src.includes("buildInChild(")) continue;
    building.push(e.name);
    if (!src.includes("copyExample(") || /["'`]\.\.\/\.\.\/examples\//.test(src)) {
      offenders.push(e.name);
    }
  }
  // The check has something to hold: the example tests that build through buildInChild.
  assertEquals(building.length >= 6, true, building.join(", "));
  assertEquals(offenders.sort(), []);
});
