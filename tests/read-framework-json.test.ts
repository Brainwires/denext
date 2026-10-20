// readFrameworkJson names the framework file it could not read instead of answering `{}`: a
// compiled `denext` binary that did not embed `deno.json` read it as an empty object, and
// `migrate` then failed far from the cause ("could not read the framework version").

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { frameworkFileUrl, readFrameworkJson } from "../src/build/bundle.ts";
import { VERSION } from "../src/version.ts";

Deno.test("readFrameworkJson reads the framework's own deno.json", async () => {
  const config = await readFrameworkJson("deno.json");
  assertEquals(config.version, VERSION);
});

Deno.test("readFrameworkJson throws naming a framework file it cannot read", async () => {
  const err = await assertRejects(() => readFrameworkJson("no-such-framework-file.json"));
  assertStringIncludes((err as Error).message, `"no-such-framework-file.json"`);
  assertStringIncludes((err as Error).message, frameworkFileUrl("no-such-framework-file.json"));
});

Deno.test("readFrameworkJson resolves {} for a missing file the caller marks optional", async () => {
  assertEquals(await readFrameworkJson("no-such-framework-file.json", { optional: true }), {});
});

Deno.test("readFrameworkJson reports a framework file that is not JSON, optional or not", async () => {
  // AGENTS.md exists under the framework root and is not JSON.
  for (const optional of [false, true]) {
    const err = await assertRejects(() => readFrameworkJson("AGENTS.md", { optional }));
    assertStringIncludes((err as Error).message, `"AGENTS.md" is not valid JSON`);
  }
});
