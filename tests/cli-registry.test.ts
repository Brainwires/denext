// Guards the assembled first-party command set: every expected verb is registered,
// and the retired `probe` verb still resolves (as an alias of `doctor`).

import { assert, assertEquals } from "@std/assert";
import { buildRegistry } from "../src/cli/register.ts";

Deno.test("registry exposes every first-party verb", () => {
  const reg = buildRegistry();
  const names = reg.list().map((c) => c.name).sort();
  assertEquals(names, [
    "add",
    "analyze",
    "audit",
    "build",
    "check",
    "codemod",
    "commands",
    "completions",
    "create",
    "desktop",
    "dev",
    "doctor",
    "export",
    "fmt",
    "generate",
    "info",
    "init",
    "lint",
    "mcp",
    "migrate",
    "mobile",
    "ota",
    "patch",
    "plugin",
    "profile",
    "remove",
    "start",
    "task",
    "test",
    "ui",
    "update",
  ]);
});

Deno.test("probe resolves to doctor (retired verb kept as alias)", () => {
  const reg = buildRegistry();
  assertEquals(reg.get("probe")?.name, "doctor");
});

Deno.test("module-loading verbs are flagged loadsModules", () => {
  const reg = buildRegistry();
  for (const name of ["dev", "build", "export", "start", "doctor", "analyze", "task"]) {
    assert(reg.get(name)?.loadsModules, `${name} should load modules`);
  }
  // Toolchain + scaffold verbs must NOT trigger the module/env re-exec gate. `commands` is
  // deliberately among them: it DOES import denext.config.ts (through loadPluginCommands), but
  // a listing verb must never build the app's CSS or re-exec — the config load is budgeted and
  // degrades to a notice, exactly as `completions` has always done.
  for (const name of ["test", "lint", "fmt", "create", "migrate", "ui", "commands"]) {
    assert(!reg.get(name)?.loadsModules, `${name} should not load modules`);
  }
});
