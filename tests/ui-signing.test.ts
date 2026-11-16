// `denext ui` → the signing probes: which Developer ID identities this machine holds, and whether
// a signing tool is installed.
//
// The parse is the part worth testing hard, because it decides what a picker offers. Everything
// that spawns is exercised only where it can be done without depending on the host having (or
// lacking) a particular tool.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
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

/** Run `fn` with PATH set to `path` only, restoring it after. */
async function withPath(path: string, fn: () => Promise<void>): Promise<void> {
  const before = Deno.env.get("PATH");
  Deno.env.set("PATH", path);
  try {
    await fn();
  } finally {
    if (before === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", before);
  }
}

Deno.test({
  name:
    "listing identities runs `security` from PATH (a stand-in here, never the keychain) and keeps only Developer ID",
  ignore: Deno.build.os === "windows", // the stand-in is a shell script
  async fn() {
    const bin = await Deno.makeTempDir({ prefix: "dnx-fake-security-" });
    try {
      const out = REAL.replaceAll("\n", "\\n");
      await Deno.writeTextFile(join(bin, "security"), `#!/bin/sh\nprintf '${out}\\n'\n`);
      await Deno.chmod(join(bin, "security"), 0o755);
      await withPath(bin, async () => {
        const found = await listSigningIdentities("darwin");
        assertEquals(found.map((i) => i.team), ["WT957SC7MJ"]);
      });
      // A failing `security` (a locked keychain) offers nothing.
      await Deno.writeTextFile(join(bin, "security"), `#!/bin/sh\necho locked >&2\nexit 51\n`);
      await withPath(bin, async () => {
        assertEquals(await listSigningIdentities("darwin"), []);
      });
    } finally {
      await Deno.remove(bin, { recursive: true });
    }
  },
});

Deno.test("with no `security` (or no shell) on PATH, nothing is offered and nothing throws", async () => {
  const empty = await Deno.makeTempDir({ prefix: "dnx-no-security-" });
  try {
    await withPath(empty, async () => {
      assertEquals(await listSigningIdentities("darwin"), []);
      // The lookup's own shell is missing too: still false, not a throw.
      assertEquals(await hasCommand("sh", "linux"), false);
    });
  } finally {
    await Deno.remove(empty, { recursive: true });
  }
});
