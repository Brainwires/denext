// `site` is not a member of the root workspace, so `deno fmt site/<path>` (and any run
// from inside `site`) reads `site/deno.json` instead of the root config. Without its own
// `fmt` block that run falls back to deno's defaults (width 80, `proseWrap: "always"`) and
// rewraps every docs paragraph, while the root run (the pre-commit hook) leaves them alone. The
// two configs must therefore format identically; this test keeps them from drifting apart.

import { assertEquals } from "@std/assert";

/** The formatting options of a `deno.json`, without the per-config `exclude` list. */
async function fmtOptions(path: string): Promise<Record<string, unknown>> {
  const config = JSON.parse(await Deno.readTextFile(new URL(path, import.meta.url)));
  const { exclude: _exclude, ...options } = config.fmt ?? {};
  return options;
}

Deno.test("site formats exactly like the repository root", async () => {
  assertEquals(
    await fmtOptions("../site/deno.json"),
    await fmtOptions("../deno.json"),
    "site/deno.json `fmt` must match the root `fmt` (minus `exclude`), or " +
      "`deno fmt site/...` rewraps the docs differently from the pre-commit hook",
  );
});
