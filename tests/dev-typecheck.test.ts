// The dev loop's background `deno check`: which changed paths it checks, and that the dev
// server's stop signal ends it (a check left running holds the project directory open, which
// Windows then refuses to remove).

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { runTypeCheck, typeCheckFiles } from "../src/build/dev-server/dev-endpoints.ts";
import type { DevState } from "../src/build/dev-server/state.ts";
import { removeTempDir } from "./helpers/temp.ts";

Deno.test("typeCheckFiles: TypeScript sources, never .denext output, with either separator", () => {
  assertEquals(
    typeCheckFiles([
      "/p/app/page.tsx",
      "/p/lib/a.ts",
      "/p/app/style.css",
      "/p/.denext/server-cache/x.ts",
      "C:\\p\\app\\page.tsx",
      "C:\\p\\.denext\\server-cache\\x.ts",
    ]),
    ["/p/app/page.tsx", "/p/lib/a.ts", "C:\\p\\app\\page.tsx"],
  );
});

/** A dev session over `dir` with `signal` (only what the check reads). */
function session(dir: string, signal?: AbortSignal) {
  return {
    paths: { projectDir: dir, configPath: "" },
    options: { signal },
  } as unknown as Pick<DevState, "paths" | "options">;
}

Deno.test("runTypeCheck: reports a type error, and the server's stop signal cancels the check", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_typecheck_" });
  try {
    const file = join(dir, "bad.ts");
    await Deno.writeTextFile(file, "export const n: number = 'not a number';\n");
    assertStringIncludes((await runTypeCheck(session(dir), [file])) ?? "", "TS2322");

    const stopped = new AbortController();
    stopped.abort();
    assertEquals(await runTypeCheck(session(dir, stopped.signal), [file]), null);
  } finally {
    await removeTempDir(dir);
  }
});
