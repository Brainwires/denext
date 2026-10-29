// The runtime fork's `3.0.0-denext.N` releases (after `3.0.0-rc.6`) against every gate denext
// keys on a runtime version: each "from 3.0.0-rc.N" feature is on for them, and the toolchain
// cache sorts them newest and prunes the release candidates they replace.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { join } from "@std/path";
import {
  FIRST_IDLE_TRIM_RUNTIME,
  FIRST_MARKER_RUNTIME,
  FIRST_OWN_VERSION_RUNTIME,
  needsNoLegacyAbortFlag,
  supportsIdleTrim,
} from "../src/build/deno-version.ts";
import {
  denoSupportsNetSplit,
  NET_SPLIT_RELEASE,
  supportsNetSplit,
  toolchainNetSplit,
} from "../src/build/net-permissions.ts";
import {
  JAIL_DEFAULT_RELEASE,
  jailHostListsSupported,
  jailOnByDefault,
  UPSTREAM_BY_NAME_RELEASE,
  upstreamByNameAdvice,
} from "../src/build/jail-scripts.ts";
import { idleTrimOn, pinnedIdleTrim } from "../src/build/idle-trim.ts";
import { toolchainRuntimeFlags } from "../src/cli/self-exec.ts";
import {
  listToolchainCache,
  planToolchainRemoval,
  type ToolchainVersionsInUse,
} from "../src/build/toolchain-prune.ts";
import { compareDenoVersions } from "../src/build/deno-version.ts";

const DENEXT_LINE = ["3.0.0-denext.1", "3.0.0-denext.2", "3.0.0-denext.10"];

Deno.test("3.0.0-denext.N is past every 3.0.0-rc.N gate", () => {
  for (
    const gate of [
      FIRST_OWN_VERSION_RUNTIME,
      NET_SPLIT_RELEASE,
      FIRST_MARKER_RUNTIME,
      FIRST_IDLE_TRIM_RUNTIME,
      JAIL_DEFAULT_RELEASE,
      UPSTREAM_BY_NAME_RELEASE,
      "3.0.0-rc.6",
    ]
  ) {
    for (const v of DENEXT_LINE) assert(compareDenoVersions(v, gate) > 0, `${v} vs ${gate}`);
  }
  for (const v of DENEXT_LINE) {
    assertFalse(needsNoLegacyAbortFlag(v), v);
    assertEquals(toolchainRuntimeFlags(v), [], v);
    assert(supportsIdleTrim(v), v);
    assert(idleTrimOn({ runtime: v, configOff: false, env: () => undefined }), v);
    assert(pinnedIdleTrim(false, () => undefined, v), v);
    assert(supportsNetSplit(v), v);
    assert(supportsNetSplit(`${v}+ci.4`), v);
    assert(toolchainNetSplit(v), v);
    assert(denoSupportsNetSplit({ deno: v, denext: v }), v);
    assert(jailOnByDefault(v), v);
    assert(jailHostListsSupported(v), v);
  }
  // The last release candidate keeps its answers.
  assertFalse(needsNoLegacyAbortFlag("3.0.0-rc.6"));
  assert(jailHostListsSupported("3.0.0-rc.6"));
  assertFalse(jailHostListsSupported("3.0.0-rc.5"));
});

Deno.test("3.0.0-denext.N has upstreamByName: a proxy in the env gets the advice", () => {
  const advice = (version: string) =>
    upstreamByNameAdvice({
      output: "error: script 'postinstall' in 'sharp@0.34.0' failed with exit code 1\n" +
        "  getaddrinfo ENOTFOUND github.com\n",
      denoJson: { supplyChain: { jailScripts: { packages: { sharp: { net: ["github.com"] } } } } },
      env: (name) => name === "HTTPS_PROXY" ? "http://proxy.internal:3128" : undefined,
      version,
    });
  assertEquals(advice("3.0.0-rc.5"), [], "before upstreamByName");
  const rc6 = advice("3.0.0-rc.6");
  assert(rc6.length > 0, "rc.6 has upstreamByName");
  for (const v of DENEXT_LINE) assertEquals(advice(v), rc6, v);
});

Deno.test("toolchain cache: 3.0.0-denext.N lists newest; prune keeps it and drops the rc", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-runtime-order-" });
  try {
    const roots = { deno: join(dir, "denext-deno"), desktop: join(dir, "denext-desktop-runtime") };
    for (const v of ["3.0.0-denext.2", "3.0.0-rc.6", "3.0.0-denext.10", "2.9.7-denext.22"]) {
      await Deno.mkdir(join(roots.deno, v, "x86_64-target"), { recursive: true });
    }
    const entries = await listToolchainCache(roots);
    assertEquals(
      entries.map((e) => e.version),
      ["2.9.7-denext.22", "3.0.0-rc.6", "3.0.0-denext.2", "3.0.0-denext.10"],
    );
    const inUse: ToolchainVersionsInUse = {
      deno: ["3.0.0-denext.10"],
      desktopRuntime: [],
      gleam: [],
      fastlane: [],
    };
    const plan = planToolchainRemoval(entries, { action: "prune" }, inUse);
    assertEquals(
      plan.remove.map((e) => e.version),
      ["2.9.7-denext.22", "3.0.0-rc.6", "3.0.0-denext.2"],
    );
    assertEquals(plan.inUse.map((e) => e.version), ["3.0.0-denext.10"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
