// src/build/deno-version.ts: the two version schemes of denext's own Deno (`2.9.7-denext.N`, then
// the fork's own `3.0.0-rc.N`), ordered by semver, told from stock Deno, and mapped to the stock
// release they are built from.

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  compareDenoVersions,
  denoReleaseVersion,
  denoVersionOk,
  FIRST_OWN_VERSION_RUNTIME,
  isDenextDenoVersion,
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

Deno.test("isDenextDenoVersion: both schemes are denext's Deno, stock 2.x is not", () => {
  for (const v of ["2.9.7-denext.1", "2.9.7-denext.22", FIRST_OWN_VERSION_RUNTIME, "3.0.0-rc.10"]) {
    assert(isDenextDenoVersion(v), v);
  }
  assert(isDenextDenoVersion("3.0.0-rc.1+ci.42"), "a CI build");
  // A plain release is stock Deno's unless it is the pinned version: by the version alone the
  // fork's 3.0.0 final could not be told from stock Deno's.
  for (const v of ["2.9.7", "2.9.8", "2.10.0-rc.1", "2.9.7-denext", "3.0.0-alpha.1", "nope"]) {
    assertFalse(isDenextDenoVersion(v), v);
  }
  assertFalse(isDenextDenoVersion("3.0.0", "3.0.0-rc.1"));
  assertFalse(isDenextDenoVersion("9.9.9", null));
  assert(isDenextDenoVersion("3.0.0", "3.0.0"), "the pinned 3.0.0");
});

Deno.test("denoReleaseVersion: the stock Deno each scheme is built from", () => {
  assertEquals(denoReleaseVersion("2.9.7-denext.15"), "2.9.7");
  assertEquals(denoReleaseVersion("2.9.6"), "2.9.6");
  assertEquals(denoReleaseVersion("2.9.8"), "2.9.8");
  // The fork's own version names no stock release: the toolchain pin's `deno` (or the one given).
  assertEquals(denoReleaseVersion("3.0.0-rc.1"), toolchainPin.deno);
  assertEquals(denoReleaseVersion("3.0.0-rc.1+ci.42", "2.9.8"), "2.9.8");
  assertEquals(denoReleaseVersion("3.0.0-rc.3", "2.9.7"), "2.9.7");
  // Every new-scheme version still passes the minimum-version gate.
  assert(denoVersionOk("3.0.0-rc.1") && denoVersionOk("3.0.0-rc.1+ci.42"));
});
