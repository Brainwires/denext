import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { denoExecutable } from "../src/build/bundle.ts";
import {
  type DenoExecutableSeams,
  NO_DENO_MESSAGE,
  resolveDenoExecutable,
} from "../src/build/deno-executable.ts";

Deno.test("DENO_BIN overrides executable resolution", () => {
  const prev = Deno.env.get("DENO_BIN");
  try {
    Deno.env.set("DENO_BIN", "/custom/path/to/deno");
    assertEquals(denoExecutable(), "/custom/path/to/deno");
  } finally {
    if (prev === undefined) Deno.env.delete("DENO_BIN");
    else Deno.env.set("DENO_BIN", prev);
  }
});

Deno.test("under `deno test`, resolves the real deno binary", () => {
  const prev = Deno.env.get("DENO_BIN");
  try {
    Deno.env.delete("DENO_BIN");
    // Running under `deno test`, Deno.execPath() is the deno binary itself.
    const resolved = denoExecutable().toLowerCase();
    assertStringIncludes(resolved, "deno");
  } finally {
    if (prev !== undefined) Deno.env.set("DENO_BIN", prev);
  }
});

// ---------------------------------------------------------------------------------------------
// resolveDenoExecutable: a compiled binary never assumes a `deno` it does not have.

/** Seams of a compiled binary (override any). */
function seams(
  over: Partial<DenoExecutableSeams> & { vars?: Record<string, string> } = {},
): DenoExecutableSeams {
  return {
    env: (name) => over.vars?.[name],
    execPath: () => "/opt/denext/bin/denext",
    standalone: true,
    ...over,
  };
}

Deno.test("resolveDenoExecutable: DENO_BIN, else this process's own Deno under deno run", () => {
  assertEquals(resolveDenoExecutable(seams({ vars: { DENO_BIN: "/tc/deno" } })), "/tc/deno");
  for (const exec of ["/usr/local/bin/deno", "/cache/denext-deno/3.0.0-rc.5/x/deno-renamed"]) {
    assertEquals(resolveDenoExecutable(seams({ execPath: () => exec, standalone: false })), exec);
  }
});

Deno.test("resolveDenoExecutable: a compiled binary never looks for another Deno (5.0)", () => {
  // A `~/.deno/bin/deno` or a `deno` on PATH is not looked at: the binary always hands the
  // toolchain over in DENO_BIN, and without it refuses with the fix.
  const err = assertThrows(() =>
    resolveDenoExecutable(seams({ vars: { HOME: "/home/u", PATH: "/usr/bin" } }))
  );
  assertEquals((err as Error).message, NO_DENO_MESSAGE);
  assertStringIncludes(NO_DENO_MESSAGE, "denext toolchain install");
  assertStringIncludes(NO_DENO_MESSAGE, "stock Deno is no longer supported");
  assert(NO_DENO_MESSAGE.startsWith("denext:"), "printed by the CLI without a stack");
});
