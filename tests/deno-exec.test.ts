import { assertEquals, assertStringIncludes } from "@std/assert";
import { denoExecutable } from "../src/build/bundle.ts";

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
