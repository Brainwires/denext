// The packaged launch policy (src/build/desktop-launch-policy.ts): the strict-policy runtime gate,
// the passkeys capability's RP IDs, the gaps `denext doctor` and `denext desktop doctor` report,
// and those two checks.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { compareDenoVersions } from "../src/build/deno-version.ts";
import { desktopBridgeOrigins } from "../src/build/desktop-app-config.ts";
import {
  desktopPasskeyRpIds,
  FIRST_STRICT_LAUNCH_RUNTIME,
  isDesktopProject,
  launchPolicyProblems,
  stalePackageScripts,
  strictLaunchRuntime,
  supportsStrictLaunch,
} from "../src/build/desktop-launch-policy.ts";
import { runDesktopDoctor } from "../src/build/desktop-doctor.ts";
import type { DesktopRuntimeStatus } from "../src/build/desktop-runtime.ts";
import { desktopLaunchPolicyCheck } from "../src/cli/commands/doctor.ts";
import { projectLaunchPolicy } from "../src/cli/commands/desktop-doctor.ts";

const env = (vars: Record<string, string>) => (key: string) => vars[key];

Deno.test("strict launch: the first runtime with strictPolicy, compared through compareDenoVersions", () => {
  assertEquals(FIRST_STRICT_LAUNCH_RUNTIME, "3.0.0-denext.1");
  // The gate IS the comparator: `3.0.0-rc.N` vs `3.0.0-denext.1` follows whatever order
  // compareDenoVersions gives (rc above denext.1 under plain semver until the fork's rc → denext
  // ordering lands, below it after), so this test holds across that change.
  for (
    const v of [
      "2.9.7-denext.22",
      "3.0.0-rc.1",
      "3.0.0-rc.5",
      "3.0.0-rc.7",
      "3.0.0-denext.1",
      "3.0.0-denext.2",
      "3.0.0-denext.10",
      "3.0.0",
      "3.0.1",
    ]
  ) {
    assertEquals(
      supportsStrictLaunch(v),
      compareDenoVersions(v, FIRST_STRICT_LAUNCH_RUNTIME) >= 0,
      v,
    );
  }
  for (const v of ["3.0.0-denext.1", "3.0.0-denext.2", "3.0.0-denext.10", "3.0.1"]) {
    assert(supportsStrictLaunch(v), v);
  }
  for (const v of ["2.9.7-denext.22", "2.9.8", "not a version", ""]) {
    assert(!supportsStrictLaunch(v), v);
  }
});

Deno.test("strict launch: only denext's pinned runtime, never stock or a local runtime build", () => {
  assertEquals(strictLaunchRuntime(env({}), "3.0.0-denext.1"), true);
  assertEquals(
    strictLaunchRuntime(env({ DENEXT_DESKTOP_RUNTIME: "pinned" }), "3.0.0-denext.2"),
    true,
  );
  assertEquals(strictLaunchRuntime(env({}), "2.9.7-denext.22"), false);
  assertEquals(
    strictLaunchRuntime(env({ DENEXT_DESKTOP_RUNTIME: " Stock " }), "3.0.0-denext.1"),
    false,
  );
  assertEquals(
    strictLaunchRuntime(env({ DENEXT_DESKTOP_RUNTIME_DIR: "/tmp/rt" }), "3.0.0-denext.1"),
    false,
  );
  // The default reads the pin and this process's env.
  assertEquals(typeof strictLaunchRuntime(), "boolean");
});

Deno.test("desktopPasskeyRpIds: null when off, the lowercased pin when on, [] without a list", () => {
  const caps = (passkeys: unknown) => ({ desktop: { capabilities: { passkeys } } });
  assertEquals(desktopPasskeyRpIds(undefined), null);
  assertEquals(desktopPasskeyRpIds({ desktop: {} }), null);
  assertEquals(desktopPasskeyRpIds(caps(false)), null);
  assertEquals(desktopPasskeyRpIds(caps(null)), null);
  assertEquals(
    desktopPasskeyRpIds(caps({ rpIds: ["Example.COM", "example.com", "", 7, "auth.example.com"] })),
    ["example.com", "auth.example.com"],
  );
  assertEquals(desktopPasskeyRpIds(caps({ rpIds: [] })), []);
  // A bare `true` (config validation rejects it) pins nothing: refuse every RP.
  assertEquals(desktopPasskeyRpIds(caps(true)), []);
  assertEquals(desktopPasskeyRpIds(caps({ rpIds: "example.com" })), []);
});

Deno.test("launchPolicyProblems: empty rpIds, an unwritable bridgeOrigins and stale scripts", () => {
  const ok = {
    desktop: {
      app: { bridgeOrigins: ["https://idp.example"] },
      capabilities: { passkeys: { rpIds: ["example.com"] } },
    },
  };
  assertEquals(launchPolicyProblems(ok, desktopBridgeOrigins), []);
  assertEquals(launchPolicyProblems({ desktop: {} }, desktopBridgeOrigins), []);

  const [passkeys] = launchPolicyProblems(
    { desktop: { capabilities: { passkeys: { rpIds: [] } } } },
    desktopBridgeOrigins,
  );
  assertStringIncludes(passkeys.message, "passkeyRpIds would be empty");
  assertStringIncludes(passkeys.message, "invalid_rp");
  assertStringIncludes(passkeys.fix, 'rpIds: ["example.com"]');

  const [bridge] = launchPolicyProblems(
    { desktop: { app: { bridgeOrigins: ["not an origin"] } } },
    desktopBridgeOrigins,
  );
  assertStringIncludes(bridge.message, "would lack bridgeOrigins");
  assertStringIncludes(bridge.message, "serves no document");
  assertStringIncludes(bridge.fix, "desktop.app.bridgeOrigins");

  const one = launchPolicyProblems(ok, desktopBridgeOrigins, ["scripts/package-linux.ts"]);
  assertEquals(one.length, 1);
  assertStringIncludes(one[0].message, "scripts/package-linux.ts never writes");
  assertStringIncludes(one[0].fix, "--regenerate-scripts");
  const two = launchPolicyProblems(ok, desktopBridgeOrigins, ["a.ts", "b.ts"]);
  assertStringIncludes(two[0].message, "a.ts, b.ts never write denext's");
});

Deno.test("stalePackageScripts + isDesktopProject: read the project's files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-launch-policy-" });
  try {
    assertEquals(await isDesktopProject(dir), false);
    assertEquals(await stalePackageScripts(dir), []);
    await Deno.writeTextFile(join(dir, "deno.json"), '{ "tasks": {} }');
    assertEquals(await isDesktopProject(dir), false);
    await Deno.writeTextFile(join(dir, "deno.json"), '{ // jsonc\n "desktop": {} }');
    assertEquals(await isDesktopProject(dir), true);
    await Deno.writeTextFile(join(dir, "deno.json"), "{ not json");
    assertEquals(await isDesktopProject(dir), false);
    await Deno.remove(join(dir, "deno.json"));
    await Deno.writeTextFile(join(dir, "deno.jsonc"), '{ "desktop": { "app": {} } }');
    assertEquals(await isDesktopProject(dir), true);
    await Deno.remove(join(dir, "deno.jsonc"));
    await Deno.writeTextFile(join(dir, "desktop.ts"), "");
    assertEquals(await isDesktopProject(dir), true);

    await Deno.mkdir(join(dir, "scripts"));
    await Deno.writeTextFile(
      join(dir, "scripts", "package-linux.ts"),
      "await buildDesktopBundle(import.meta.url, OS, {});\n",
    );
    await Deno.writeTextFile(
      join(dir, "scripts", "package-macos.ts"),
      "await writeLaufeyLaunchConfig(import.meta.url, 'darwin', out);\n",
    );
    assertEquals(await stalePackageScripts(dir), []);
    await Deno.writeTextFile(join(dir, "scripts", "package-windows.ts"), "// deno desktop only\n");
    assertEquals(await stalePackageScripts(dir), ["scripts/package-windows.ts"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext doctor: the desktop launch-policy check", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-launch-policy-doctor-" });
  try {
    const good = { desktop: { capabilities: { passkeys: { rpIds: ["example.com"] } } } };
    assertEquals(await desktopLaunchPolicyCheck(dir, good), null, "not a desktop project");
    await Deno.writeTextFile(join(dir, "desktop.ts"), "");
    const ok = await desktopLaunchPolicyCheck(dir, good);
    assert(ok?.ok, ok?.detail);
    assertEquals(ok.critical, false);
    assertStringIncludes(ok.detail, "bridgeOrigins + passkeyRpIds pinned");
    const plain = await desktopLaunchPolicyCheck(dir, { desktop: {} });
    assert(plain?.ok);
    assert(plain.detail.startsWith("bridgeOrigins pinned"), plain.detail);
    const bad = await desktopLaunchPolicyCheck(dir, {
      desktop: { capabilities: { passkeys: { rpIds: [] } } },
    });
    assert(bad && !bad.ok && !bad.critical);
    assertStringIncludes(bad.detail, "passkeyRpIds would be empty");
    assertStringIncludes(bad.detail, "rpIds");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const status: DesktopRuntimeStatus = {
  mode: "pinned",
  version: "3.0.0-denext.1",
  target: "aarch64-apple-darwin",
  backend: "webview",
  cache: "cached",
  deno: { found: "2.9.8", required: "2.9.8" },
  ok: true,
  detail: "runtime 3.0.0-denext.1",
};

Deno.test("desktop doctor: the launch-policy check, a warning per gap", async () => {
  const base = { runtimeStatus: () => Promise.resolve(status), os: "darwin", linux: false };
  const none = await runDesktopDoctor(base);
  assert(!none.checks.includes("launch-policy"));
  const notDesktop = await runDesktopDoctor({ ...base, launchPolicy: () => Promise.resolve(null) });
  assert(!notDesktop.checks.includes("launch-policy"));
  const clean = await runDesktopDoctor({ ...base, launchPolicy: () => Promise.resolve([]) });
  assertEquals(clean.checks, ["runtime", "launch-policy"]);
  assertEquals(clean.findings, []);
  const gap = await runDesktopDoctor({
    ...base,
    launchPolicy: () => Promise.resolve([{ message: "m", fix: "f" }]),
  });
  assertEquals(gap.findings, [{
    check: "launch-policy",
    level: "warning",
    message: "m",
    fix: "f",
  }]);
});

Deno.test("desktop doctor CLI: projectLaunchPolicy reads the project's config and scripts", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-launch-policy-cli-" });
  try {
    assertEquals(await projectLaunchPolicy(dir), null);
    await Deno.writeTextFile(join(dir, "deno.json"), '{ "desktop": {} }\n');
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      "export default { desktop: { capabilities: { passkeys: { rpIds: [] } } } };\n",
    );
    const problems = await projectLaunchPolicy(dir);
    assertEquals(problems?.length, 1);
    assertStringIncludes(problems![0].message, "passkeyRpIds would be empty");

    const broken = await Deno.makeTempDir({ prefix: "denext-launch-policy-cli-bad-" });
    try {
      await Deno.writeTextFile(join(broken, "desktop.ts"), "");
      await Deno.writeTextFile(join(broken, "denext.config.ts"), "export default {{;\n");
      const [failed] = (await projectLaunchPolicy(broken))!;
      assertStringIncludes(failed.message, "could not be loaded");
    } finally {
      await Deno.remove(broken, { recursive: true });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
