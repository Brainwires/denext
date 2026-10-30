// src/build/deno-version.ts: the two version schemes of denext's own Deno (`2.9.7-denext.N`, then
// the fork's own `3.0.0-rc.N`), ordered by semver, told from stock Deno — by the identity marker
// (`Deno.build.denext`, `denext <version> (Brainwires)`) from 3.0.0-rc.3, by the version only
// before it — and mapped to the stock release they are built from.

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  compareDenoVersions,
  currentDenoIdentity,
  denextVersionLine,
  denoReleaseVersion,
  denoVersionOk,
  FIRST_MARKER_RUNTIME,
  FIRST_OWN_VERSION_RUNTIME,
  isDenextDenoVersion,
  isDenextReleaseVersion,
  isPinnedDenextDeno,
  isPreMarkerDenextVersion,
  parseDenoVersionOutput,
  pinnedDenoReleaseVersion,
} from "../src/build/deno-version.ts";
import toolchainPin from "../src/build/deno-toolchain-pin.json" with { type: "json" };

Deno.test("compareDenoVersions: semver precedence across both schemes", () => {
  const ordered = [
    "not-a-version",
    "2.9.6",
    "2.9.7-denext.9",
    "2.9.7-denext.10",
    "2.9.7-denext.22",
    "2.9.7",
    "3.0.0-rc.1",
    "3.0.0-rc.2",
    "3.0.0-rc.9",
    "3.0.0-rc.10",
    "3.0.0",
    "3.0.1",
    "3.1.0-rc.1",
  ];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assertEquals(
        Math.sign(compareDenoVersions(ordered[i], ordered[j])),
        Math.sign(i - j),
        `${ordered[i]} vs ${ordered[j]}`,
      );
    }
  }
  // Build metadata (a CI build) has the precedence of the version it builds toward.
  assertEquals(compareDenoVersions("3.0.0-rc.1+ci.42", "3.0.0-rc.1"), 0);
  assertEquals(compareDenoVersions("v3.0.0-rc.1", "3.0.0-rc.1"), 0);
  // Alphanumeric identifiers sort above numeric ones, then by ASCII.
  assert(compareDenoVersions("3.0.0-rc.1", "3.0.0-rc.x") < 0);
  assert(compareDenoVersions("3.0.0-alpha", "3.0.0-beta") < 0);
  assert(compareDenoVersions("3.0.0-rc", "3.0.0-rc.1") < 0);
});

Deno.test("isDenextDenoVersion: the identity marker says it, whatever the version", () => {
  for (const v of ["3.0.0-rc.3", "3.0.0-rc.3+ci.42", "3.0.0", "3.1.0", "9.9.9"]) {
    assert(isDenextDenoVersion({ deno: v, denext: v }), v);
  }
  assertFalse(isDenextDenoVersion({ deno: "3.0.0-rc.3", denext: "" }), "an empty marker");
});

Deno.test("isDenextDenoVersion: upstream Deno's 3.0.0-rc.N / 3.0.0 is not denext's", () => {
  // There is no upstream Deno 3.0, so denext tells its runtime apart by the identity marker: without
  // it, only a pre-marker pin's exact version counts, and a 3.0.0-rc.N / 3.0.0 is stock Deno.
  for (const v of ["3.0.0-rc.3", "3.0.0-rc.4", "3.0.0-rc.10", "3.0.0", "3.0.0-rc.3+ci.42"]) {
    assertFalse(isDenextDenoVersion({ deno: v }, "3.0.0-rc.2"), `${v} with rc.2 pinned`);
    assertFalse(isDenextDenoVersion({ deno: v }, "3.0.0-rc.3"), `${v} with rc.3 pinned`);
  }
  // Pinned with the marker (rc.3 on), the pinned version itself is upstream's without it.
  assertFalse(isDenextDenoVersion({ deno: "3.0.0-rc.3" }, "3.0.0-rc.3"));
  assertFalse(isDenextDenoVersion({ deno: "3.0.0" }, "3.0.0"));
  assertFalse(isPreMarkerDenextVersion("3.0.0", "3.0.0"));
});

Deno.test("isDenextDenoVersion: the pre-marker fallback (2.9.7-denext.N, the pinned rc.1 / rc.2)", () => {
  for (const v of ["2.9.7-denext.1", "2.9.7-denext.22", "2.9.7-denext.15+ci.3"]) {
    assert(isDenextDenoVersion({ deno: v }), v);
  }
  // The pinned pre-marker version, exactly: the currently pinned 3.0.0-rc.2 keeps working.
  assert(isDenextDenoVersion({ deno: "3.0.0-rc.2" }, "3.0.0-rc.2"));
  assert(isDenextDenoVersion({ deno: FIRST_OWN_VERSION_RUNTIME }, FIRST_OWN_VERSION_RUNTIME));
  assertFalse(isDenextDenoVersion({ deno: "3.0.0-rc.1" }, "3.0.0-rc.2"), "not the pinned one");
  assertFalse(isDenextDenoVersion({ deno: "3.0.0-rc.2+ci.4" }, "3.0.0-rc.2"), "not exactly it");
  assertFalse(isDenextDenoVersion({ deno: "3.0.0-rc.2" }, null), "nothing pinned");
  for (const v of ["2.9.7", "2.9.8", "2.10.0-rc.1", "2.9.7-denext", "3.0.0-alpha.1", "nope"]) {
    assertFalse(isDenextDenoVersion({ deno: v }), v);
  }
  if (compareDenoVersions(toolchainPin.version, FIRST_MARKER_RUNTIME) < 0) {
    assert(isDenextDenoVersion({ deno: toolchainPin.version }), "the checked-in pre-marker pin");
  }
});

Deno.test("isPinnedDenextDeno: denext's Deno of exactly the pin's version", () => {
  assert(isPinnedDenextDeno({ deno: "3.0.0-rc.3", denext: "3.0.0-rc.3" }, "3.0.0-rc.3"));
  assertFalse(isPinnedDenextDeno({ deno: "3.0.0-rc.3" }, "3.0.0-rc.3"), "upstream's rc.3");
  assertFalse(isPinnedDenextDeno({ deno: "3.0.0-rc.4", denext: "3.0.0-rc.4" }, "3.0.0-rc.3"));
  assertFalse(isPinnedDenextDeno({ deno: "3.0.0-rc.3", denext: "3.0.0-rc.3" }, null));
  assert(isPinnedDenextDeno({ deno: "3.0.0-rc.2" }, "3.0.0-rc.2"), "the pre-marker pin");
});

Deno.test("parseDenoVersionOutput: the version line and denext's identity line", () => {
  const upstream = "deno 3.0.0-rc.3 (release candidate, release, x86_64-unknown-linux-gnu)\n" +
    "v8 14.9.1\ntypescript 6.0.3\n";
  assertEquals(parseDenoVersionOutput(upstream), { deno: "3.0.0-rc.3" });
  assertFalse(isDenextDenoVersion(parseDenoVersionOutput(upstream)!, "3.0.0-rc.2"));
  const denext = "deno 3.0.0-rc.3 (stable, release, aarch64-apple-darwin)\r\n" +
    "v8 14.9.1\r\ntypescript 6.0.3\r\n" + denextVersionLine("3.0.0-rc.3") + "\r\n";
  assertEquals(parseDenoVersionOutput(denext), { deno: "3.0.0-rc.3", denext: "3.0.0-rc.3" });
  assert(isDenextDenoVersion(parseDenoVersionOutput(denext)!, "3.0.0-rc.3"));
  // The pinned rc.2 prints no identity line: the fallback.
  const rc2 =
    "deno 3.0.0-rc.2 (stable, release, x86_64-pc-windows-msvc)\nv8 14.9.1\ntypescript 6.0.3\n";
  assertEquals(parseDenoVersionOutput(rc2), { deno: "3.0.0-rc.2" });
  assert(isDenextDenoVersion(parseDenoVersionOutput(rc2)!, "3.0.0-rc.2"));
  // `deno -V` is one line; a marker line elsewhere in the text must start its own line.
  assertEquals(parseDenoVersionOutput("deno 2.9.7\n"), { deno: "2.9.7" });
  assertEquals(
    parseDenoVersionOutput("deno 2.9.7 (stable)\nnot denext 1.0.0 (Brainwires)\n"),
    { deno: "2.9.7" },
  );
  assertEquals(parseDenoVersionOutput("denext 4.6.0\n"), null);
  assertEquals(parseDenoVersionOutput(""), null);
});

Deno.test("currentDenoIdentity: this process's Deno.version.deno and Deno.build.denext", () => {
  const id = currentDenoIdentity();
  assertEquals(id.deno, Deno.version.deno);
  const marker = (Deno.build as { denext?: unknown }).denext;
  assertEquals(id.denext, typeof marker === "string" && marker !== "" ? marker : undefined);
});

Deno.test("isDenextReleaseVersion: a pin's or a release manifest's version", () => {
  for (const v of ["2.9.7-denext.1", "3.0.0-rc.1", "3.0.0-rc.3", "3.0.0", "3.1.0"]) {
    assert(isDenextReleaseVersion(v), v);
  }
  for (const v of ["2.9.7", "2.9.8", "3.0.0-alpha.1", "nope"]) {
    assertFalse(isDenextReleaseVersion(v), v);
  }
});

Deno.test("denoReleaseVersion: the stock Deno a running Deno is built from", () => {
  assertEquals(denoReleaseVersion({ deno: "2.9.7-denext.15" }), "2.9.7");
  assertEquals(denoReleaseVersion({ deno: "2.9.6" }), "2.9.6");
  assertEquals(denoReleaseVersion({ deno: "2.9.8" }), "2.9.8");
  // denext's Deno under its own version names no stock release: the pin's `deno` (or the one given).
  assertEquals(denoReleaseVersion({ deno: "3.0.0-rc.3", denext: "3.0.0-rc.3" }, "2.9.7"), "2.9.7");
  assertEquals(
    denoReleaseVersion({ deno: "3.0.0-rc.3+ci.42", denext: "3.0.0-rc.3+ci.42" }, "2.9.8"),
    "2.9.8",
  );
  // Upstream Deno is its own release, even at a version the fork also uses.
  assertEquals(denoReleaseVersion({ deno: "3.0.0-rc.3" }, "2.9.7"), "3.0.0-rc.3");
  assertEquals(denoReleaseVersion({ deno: "3.0.0" }, "2.9.7"), "3.0.0");
  // Every new-scheme version still passes the minimum-version gate.
  assert(denoVersionOk("3.0.0-rc.1") && denoVersionOk("3.0.0-rc.1+ci.42"));
});

Deno.test("pinnedDenoReleaseVersion: the stock Deno a pinned release is built from", () => {
  assertEquals(pinnedDenoReleaseVersion("2.9.7-denext.15"), "2.9.7");
  assertEquals(pinnedDenoReleaseVersion("3.0.0-rc.1"), toolchainPin.deno);
  assertEquals(pinnedDenoReleaseVersion("3.0.0-rc.3", "2.9.8"), "2.9.8");
  assertEquals(pinnedDenoReleaseVersion("2.9.6"), "2.9.6");
});

Deno.test("compareDenoVersions: the fork's 3.0.0-denext.N line outranks every 3.0.0-rc.N", () => {
  // The fork stopped cutting release candidates: after 3.0.0-rc.6 come 3.0.0-denext.1, .2, ….
  // Semver alone would sort `denext` below `rc` (ASCII), so on the fork's own-version line a
  // `denext` prerelease outranks any `rc` one; everything else keeps semver.
  const ordered = [
    "2.9.7-denext.9",
    "2.9.7-denext.22",
    "2.9.7",
    "3.0.0-rc",
    "3.0.0-rc.1",
    "3.0.0-rc.6",
    "3.0.0-rc.10",
    "3.0.0-denext.1",
    "3.0.0-denext.2",
    "3.0.0-denext.10",
    "3.0.0",
    "3.0.1",
  ];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assertEquals(
        Math.sign(compareDenoVersions(ordered[i], ordered[j])),
        Math.sign(i - j),
        `${ordered[i]} vs ${ordered[j]}`,
      );
    }
  }
  assertEquals(compareDenoVersions("3.0.0-denext.1+ci.7", "3.0.0-denext.1"), 0);
  assertEquals(compareDenoVersions("v3.0.0-denext.2", "3.0.0-denext.2"), 0);
  assertEquals(
    ["3.0.0-denext.2", "3.0.0-rc.6", "3.0.0-denext.10", "2.9.7-denext.22", "3.0.0-denext.1"]
      .sort(compareDenoVersions),
    ["2.9.7-denext.22", "3.0.0-rc.6", "3.0.0-denext.1", "3.0.0-denext.2", "3.0.0-denext.10"],
  );
  // Off the 3.0.0 core plain semver stands: the old scheme against an upstream release
  // candidate of its core, and any other core.
  assert(compareDenoVersions("2.10.0-denext.1", "2.10.0-rc.1") < 0);
  assert(compareDenoVersions("3.1.0-denext.1", "3.1.0-rc.1") < 0);
  // Other prerelease names on the 3.0.0 core keep semver too.
  assert(compareDenoVersions("3.0.0-alpha.1", "3.0.0-denext.1") < 0);
});

Deno.test("3.0.0-denext.N: denext's release, built from the pin's Deno (not the old scheme)", () => {
  for (const v of ["3.0.0-denext.1", "3.0.0-denext.10"]) {
    assert(isDenextReleaseVersion(v), v);
    // The old `<stock>-denext.N` scheme ended at 2.9.7: 3.0.0 names no stock release.
    assertEquals(pinnedDenoReleaseVersion(v, "2.9.8"), "2.9.8", v);
    assertEquals(denoReleaseVersion({ deno: v, denext: v }, "2.9.8"), "2.9.8", v);
    assertEquals(denoReleaseVersion({ deno: `${v}+ci.3`, denext: `${v}+ci.3` }, "2.9.8"), "2.9.8");
    // It carries the identity marker; the version alone is no pre-marker build.
    assertFalse(isPreMarkerDenextVersion(v, v), v);
    assert(isDenextDenoVersion({ deno: v, denext: v }, v), v);
    assert(isPinnedDenextDeno({ deno: v, denext: v }, v), v);
    assert(compareDenoVersions(v, FIRST_MARKER_RUNTIME) > 0, v);
    assert(compareDenoVersions(v, FIRST_OWN_VERSION_RUNTIME) > 0, v);
  }
  // The old scheme is unchanged (any other core: `<stock>-denext.N`).
  assertEquals(pinnedDenoReleaseVersion("2.9.7-denext.22", "2.9.8"), "2.9.7");
  assertEquals(pinnedDenoReleaseVersion("9.9.9-denext.1", "2.9.8"), "9.9.9");
  assert(isPreMarkerDenextVersion("2.9.7-denext.22"));
});
