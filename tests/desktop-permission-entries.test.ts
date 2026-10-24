// A permission entry a project bakes into its binary is one value of an `--allow-<kind>=a,b` flag:
// Deno splits a flag's value on commas, so an entry holding one would grant more than it reads as
// (`"api.example.com,0.0.0.0"` is two hosts), and a non-array value would be spread character by
// character. The config validator refuses both, and so does the flag derivation itself, which the
// package scripts run on the raw config (`--no-export` skips the validating export).

import { assertEquals, assertThrows } from "@std/assert";
import { desktopBuildFlags } from "../src/build/desktop-capabilities.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { sidecarListError } from "../src/desktop/sidecar.ts";
import {
  netHostError,
  permissionEntryError,
  permissionListError,
} from "../src/desktop/permission-entries.ts";

const validate = (config: unknown) => validateDenextConfig(config as DenextConfig);

Deno.test("permissionEntryError: one value per entry; network entries are hosts", () => {
  assertEquals(permissionEntryError("run", "git"), null);
  assertEquals(permissionEntryError("ffi", "C:\\Program Files\\lib.dll"), null);
  assertEquals(permissionEntryError("write", "$APPDATA"), null);
  assertEquals(permissionEntryError("run", "*"), null);
  assertEquals(permissionEntryError("net", "api.example.com:443"), null);
  for (const [kind, entry] of [["run", "git,*"], ["ffi", ""], ["sys", "hostname,osRelease"]]) {
    assertEquals(typeof permissionEntryError(kind, entry), "string", `${kind}: ${entry}`);
  }
  for (const entry of ["a.example.com,0.0.0.0", "a b", "", "https://a.example.com"]) {
    assertEquals(permissionEntryError("net", entry), netHostError(entry));
    assertEquals(typeof permissionEntryError("net", entry), "string", entry);
  }
  assertEquals(permissionListError("run", "git"), "must be an array of strings");
  assertEquals(permissionListError("run", ["git", 1]), "must be an array of strings");
  assertEquals(permissionListError("run", ["git"]), null);
});

Deno.test("config: desktop.extraPermissions refuses an entry that would split into more grants", () => {
  validate({ desktop: { extraPermissions: { run: ["git"], net: ["api.example.com"] } } });
  for (
    const extra of [
      { net: ["api.example.com,0.0.0.0"] },
      { net: ["https://api.example.com"] },
      { run: ["git,powershell.exe"] },
      { ffi: [""] },
      { sys: ["hostname,osRelease"] },
    ]
  ) {
    assertThrows(
      () => validate({ desktop: { extraPermissions: extra } }),
      Error,
      "desktop.extraPermissions",
      JSON.stringify(extra),
    );
  }
  assertThrows(
    () => validate({ compile: { permissions: { run: ["deno,bash"] } } }),
    Error,
    "compile.permissions.run",
  );
});

Deno.test("sidecar permissions: an entry is one value", () => {
  const sidecar = (permissions: unknown) => [{ name: "a", run: { module: "./a.ts" }, permissions }];
  assertEquals(sidecarListError(sidecar({ run: ["git"], net: ["x.example.com"] })), null);
  assertEquals(
    typeof sidecarListError(sidecar({ net: ["x.example.com,0.0.0.0"] })),
    "string",
  );
  assertEquals(typeof sidecarListError(sidecar({ run: ["git,bash"] })), "string");
});

Deno.test("desktopBuildFlags: an invalid permission list fails the build instead of widening it", () => {
  // A string where a list belongs used to be spread into characters (`"*"` → unscoped).
  for (
    const desktop of [
      { extraPermissions: { run: "*" } },
      { extraPermissions: { net: ["a.example.com,0.0.0.0"] } },
      { extraPermissions: { ffi: ["a.dll,b.dll"] } },
      { sidecars: [{ name: "s", run: { module: "./s.ts" }, permissions: { run: ["a,b"] } }] },
    ]
  ) {
    assertThrows(
      () => desktopBuildFlags({ desktop }, "linux"),
      Error,
      "",
      JSON.stringify(desktop),
    );
  }
  // A valid list still bakes as before.
  const flags = desktopBuildFlags({ desktop: { extraPermissions: { run: ["git"] } } }, "linux");
  assertEquals(flags.includes("--allow-run=git"), true, flags.join(" "));
});
