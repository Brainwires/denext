// A compiled binary carries one framework version; a project pins its own. These cover the two
// pieces that decide which one runs: reading a project's pin, and comparing it to a concrete
// version without tripping over the range operator a scaffolded project writes.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { pinnedDenextCli, samePin } from "../src/cli/self-exec.ts";

/** A throwaway project directory, optionally carrying `deno.json` with `source`. */
async function project(source: string | null): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_pin_" });
  if (source !== null) await Deno.writeTextFile(join(dir, "deno.json"), source);
  return dir;
}

/** `pinnedDenextCli` against one config, then the directory is removed. */
async function pinOf(source: string | null): Promise<string | null> {
  const dir = await project(source);
  try {
    return pinnedDenextCli(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("pinnedDenextCli reads the project's denext pin, range operator included", async () => {
  // What `denext create` writes.
  assertEquals(
    await pinOf('{"imports":{"denext":"jsr:@denext/denext@^2.5.0-rc.6"}}'),
    "jsr:@denext/denext@^2.5.0-rc.6/cli",
    "the range is passed through, so the child resolves what the project asked for",
  );
  assertEquals(
    await pinOf('{"imports":{"denext":"jsr:@denext/denext@2.4.3"}}'),
    "jsr:@denext/denext@2.4.3/cli",
  );
});

Deno.test("a directory that pins no denext defers to nothing", async () => {
  assertEquals(await pinOf('{"imports":{"@std/path":"jsr:@std/path@^1"}}'), null);
  assertEquals(await pinOf(null), null, "no config at all");
  assertEquals(await pinOf("{ not json"), null, "a malformed config pins nothing to trust");
  assertEquals(
    await pinOf('{"imports":{"denext":"../../mod.ts"}}'),
    null,
    "a local path is not a version this CLI can re-exec",
  );
});

Deno.test("deno.jsonc is read when there is no deno.json", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_pin_" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.jsonc"),
      '{"imports":{"denext":"jsr:@denext/denext@2.4.3"}}',
    );
    assertEquals(pinnedDenextCli(dir), "jsr:@denext/denext@2.4.3/cli");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("samePin ignores the range operator, so a binary does not re-exec itself", () => {
  // The bug this exists for: a scaffolded project pins `^X`, the binary is `X`, and comparing
  // the raw specifiers would defer to a child for the very version already running.
  assertEquals(samePin("jsr:@denext/denext@^2.5.0-rc.6/cli", "2.5.0-rc.6"), true);
  assertEquals(samePin("jsr:@denext/denext@~2.5.0/cli", "2.5.0"), true);
  assertEquals(samePin("jsr:@denext/denext@>=2.5.0/cli", "2.5.0"), true);
  assertEquals(samePin("jsr:@denext/denext@2.5.0-rc.6/cli", "2.5.0-rc.6"), true);
  assertEquals(samePin("jsr:@denext/denext@2.4.3/cli", "2.5.0-rc.6"), false);
  assertEquals(samePin("not a specifier", "2.5.0-rc.6"), false);
});
