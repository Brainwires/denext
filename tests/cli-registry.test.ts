// Guards the assembled first-party command set: every expected verb is registered,
// and the retired `probe` verb still resolves (as an alias of `doctor`).

import { assert, assertEquals } from "@std/assert";
import { buildRegistry } from "../src/cli/register.ts";

Deno.test("registry exposes every first-party verb", () => {
  const reg = buildRegistry();
  const names = reg.list().map((c) => c.name).sort();
  assertEquals(names, [
    "add",
    "audit",
    "build",
    "check",
    "codemod",
    "completions",
    "create",
    "deploy",
    "desktop",
    "dev",
    "doctor",
    "export",
    "fmt",
    "info",
    "init",
    "lint",
    "migrate",
    "remove",
    "start",
    "test",
    "update",
  ]);
});

Deno.test("probe resolves to doctor (retired verb kept as alias)", () => {
  const reg = buildRegistry();
  assertEquals(reg.get("probe")?.name, "doctor");
});

Deno.test("module-loading verbs are flagged loadsModules", () => {
  const reg = buildRegistry();
  for (const name of ["dev", "build", "export", "start", "doctor"]) {
    assert(reg.get(name)?.loadsModules, `${name} should load modules`);
  }
  // Toolchain + scaffold verbs must NOT trigger the module/env re-exec gate.
  for (const name of ["test", "lint", "fmt", "create", "migrate"]) {
    assert(!reg.get(name)?.loadsModules, `${name} should not load modules`);
  }
});
