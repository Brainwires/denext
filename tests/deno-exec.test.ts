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

/** Seams over a fake filesystem holding `files`. */
function seams(
  over: Partial<DenoExecutableSeams> & { vars?: Record<string, string>; files?: string[] } = {},
): DenoExecutableSeams {
  const files = new Set(over.files ?? []);
  return {
    env: (name) => over.vars?.[name],
    execPath: () => "/opt/denext/bin/denext",
    os: "linux",
    standalone: true,
    isFile: (path) => files.has(path),
    ...over,
  };
}

Deno.test("resolveDenoExecutable: DENO_BIN, then a deno execPath, then ~/.deno/bin, then PATH", () => {
  assertEquals(resolveDenoExecutable(seams({ vars: { DENO_BIN: "/tc/deno" } })), "/tc/deno");
  assertEquals(
    resolveDenoExecutable(seams({ execPath: () => "/usr/local/bin/deno", standalone: false })),
    "/usr/local/bin/deno",
  );
  assertEquals(
    resolveDenoExecutable(seams({ vars: { HOME: "/home/u" }, files: ["/home/u/.deno/bin/deno"] })),
    "/home/u/.deno/bin/deno",
  );
  assertEquals(
    resolveDenoExecutable(seams({ vars: { PATH: "/a::/b" }, files: ["/b/deno"] })),
    "/b/deno",
  );
  assertEquals(
    resolveDenoExecutable(
      seams({ os: "windows", vars: { Path: "C:\\x;C:\\y" }, files: ["C:\\y\\deno.exe"] }),
    ),
    "C:\\y\\deno.exe",
  );
});

Deno.test("resolveDenoExecutable: a compiled binary with no Deno anywhere refuses with the fix", () => {
  const err = assertThrows(() => resolveDenoExecutable(seams({ vars: { PATH: "/usr/bin" } })));
  assertEquals((err as Error).message, NO_DENO_MESSAGE);
  assertStringIncludes(NO_DENO_MESSAGE, "denext toolchain install");
  assert(NO_DENO_MESSAGE.startsWith("denext:"), "printed by the CLI without a stack");
  // Outside a binary the bare name is still a PATH lookup, as before.
  assertEquals(resolveDenoExecutable(seams({ standalone: false })), "deno");
});
