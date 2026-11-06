// The migration beds' program probe (tests/migration-bed/_programs.ts): a bed whose install
// program is missing is skipped with a reason, not failed on the spawn (the Tamagui starter
// needs yarn, which a machine with only npm and pnpm lacks).

import { assertEquals, assertStringIncludes } from "@std/assert";
import { missingProgram } from "./migration-bed/_programs.ts";

Deno.test("migration beds: a program that runs is not missing", async () => {
  assertEquals(await missingProgram(Deno.execPath()), undefined);
});

Deno.test("migration beds: an absent program, or one that fails its probe, is the skip reason", async () => {
  const absent = await missingProgram("denext-no-such-package-manager");
  assertStringIncludes(absent ?? "", "needs denext-no-such-package-manager (not installed)");
  const failing = await missingProgram(Deno.execPath(), ["eval", "Deno.exit(3)"]);
  assertStringIncludes(failing ?? "", "failed");
});
