// `denext ui` → the signing probes: which Developer ID identities this machine holds, and whether
// a signing tool is installed.
//
// The parse is the part worth testing hard, because it decides what a picker offers. Everything
// that spawns is exercised only where it can be done without depending on the host having (or
// lacking) a particular tool.

import { assert, assertEquals } from "@std/assert";
import {
  hasCommand,
  identityCommand,
  listSigningIdentities,
  parseIdentities,
} from "../src/ui/signing.ts";

/** Real `security find-identity -v -p codesigning` output, as a developer Mac prints it. */
const REAL = [
  '  1) 2B58CDBD54D9C53E25BB8864B027646513CA8BA9 "Apple Development: A Name (3X7D4SGHGE)"',
  '  2) 5D44043D1F109F96CDF66FB5D21E38573E643C23 "Developer ID Application: A Name (WT957SC7MJ)"',
  "     2 valid identities found",
].join("\n");

Deno.test("only identities that can sign a distributable app are offered", () => {
  const found = parseIdentities(REAL);
  // The Apple Development certificate is dropped on purpose: signing with it produces a build
  // that neither distributes nor keeps its TCC grants, so a picker must not offer it.
  assertEquals(found.length, 1);
  assertEquals(found[0].name, "Developer ID Application: A Name (WT957SC7MJ)");
  assertEquals(found[0].sha1, "5D44043D1F109F96CDF66FB5D21E38573E643C23");
  assertEquals(found[0].team, "WT957SC7MJ");
});

Deno.test("nothing but an identity line is mistaken for one", () => {
  assertEquals(parseIdentities(""), []);
  assertEquals(parseIdentities("     0 valid identities found"), []);
  assertEquals(parseIdentities("The specified item could not be found in the keychain."), []);
  // A line that looks close but is not: no fingerprint, or one of the wrong length.
  assertEquals(parseIdentities('  1) not-a-hash "Developer ID Application: X (AAAAAAAAAA)"'), []);
  assertEquals(parseIdentities('  1) ABCD "Developer ID Application: X (AAAAAAAAAA)"'), []);
});

Deno.test("an identity with no Team ID still parses, with none", () => {
  const found = parseIdentities("  1) " + "A".repeat(40) + ' "Developer ID Application: No Team"');
  assertEquals(found.length, 1);
  assertEquals(found[0].team, null);
  assertEquals(found[0].sha1, "A".repeat(40));
});

Deno.test("the platform matrix is decided without spawning anything", async () => {
  assertEquals(identityCommand("darwin"), [
    "security",
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ]);
  // `security` is a macOS tool; elsewhere there is nothing to run, and the caller gets no
  // identities rather than an error.
  assertEquals(identityCommand("linux"), null);
  assertEquals(identityCommand("windows"), null);
  assertEquals(await listSigningIdentities("linux"), []);
});

Deno.test("a program name that is not a bare name never reaches the shell", async () => {
  // The POSIX branch runs `command -v` through `sh -c`. If this guard were missing, the argument
  // below would be evaluated; `false` here is the guard refusing, not a lookup failing.
  assertEquals(await hasCommand("x; echo pwned"), false);
  assertEquals(await hasCommand("$(echo x)"), false);
  assertEquals(await hasCommand("a b"), false);
  assertEquals(await hasCommand(""), false);
});

Deno.test("a missing program is false, not a throw", async () => {
  // Spawning something absent raises NotFound rather than resolving, so this exercises the catch.
  assertEquals(await hasCommand("denext-definitely-not-installed-xyz"), false);
  // And something every POSIX box has, to prove the probe can say yes at all.
  if (Deno.build.os !== "windows") assert(await hasCommand("sh"));
});
