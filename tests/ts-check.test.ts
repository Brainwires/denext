// src/ts/check.ts, the one place denext runs a type check: the `deno check` it spawns and the
// structured result it hands back (the seam TypeScript's program API replaces later).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { checkTypes, typeCheckArgs } from "../src/ts/check.ts";
import { removeTempDir } from "./helpers/temp.ts";

Deno.test("typeCheckArgs: the project's config only from inside it; never `--`", () => {
  assertEquals(
    typeCheckArgs({ projectDir: "/p", configPath: "/p/deno.json", files: ["/p/a.ts", "-b.ts"] }),
    ["check", "--quiet", "--config", "/p/deno.json", "/p/a.ts", "./-b.ts"],
  );
  assertEquals(
    typeCheckArgs({ projectDir: "/p", configPath: "/elsewhere/deno.json", files: ["/p/a.ts"] }),
    ["check", "--quiet", "/p/a.ts"],
  );
  assertEquals(typeCheckArgs({ projectDir: "/p", files: [] }), ["check", "--quiet"]);
});

// Only the named files: `bad.ts` beside `good.ts` is not checked with it (`deno check -- <files>`,
// as the dev overlay ran it before, checked the whole directory).
Deno.test("checkTypes: clean, a type error parsed, and stopped", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ts_check_" });
  try {
    const good = join(dir, "good.ts");
    const bad = join(dir, "bad.ts");
    await Deno.writeTextFile(good, "export const n: number = 1;\n");
    await Deno.writeTextFile(bad, "export const n: number = 'one';\n");
    assertEquals(await checkTypes({ projectDir: dir, files: [good] }), {
      ok: true,
      text: "",
      diagnostics: [],
    });
    const failed = await checkTypes({ projectDir: dir, files: [bad] });
    assert(failed && !failed.ok, "a type error fails the check");
    assertEquals(failed.diagnostics.map((d) => [d.code, d.line, d.column]), [["TS2322", 1, 14]]);
    assertEquals(
      await checkTypes({ projectDir: dir, files: [bad], signal: AbortSignal.abort() }),
      null,
    );
  } finally {
    await removeTempDir(dir);
  }
});
