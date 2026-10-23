// `denext htmx` (packages/htmx/command.ts), the verb the htmx plugin contributes: `info` (the
// default) prints the vendored version and how it is served, `eject [dir]` copies the vendored
// runtime byte for byte, and an unknown action is refused.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { htmxCommand } from "../packages/htmx/command.ts";
import { HTMX_RUNTIME_PATH, HTMX_VERSION } from "../packages/htmx/constants.ts";
import { capture, makeCtx } from "./_cli-coverage-helpers.ts";

const VENDORED = new URL("../packages/htmx/vendor/htmx.min.js", import.meta.url);

Deno.test("denext htmx info: the vendored version, its path and size (the default action)", async () => {
  for (const positionals of [["info"], []]) {
    const cap = capture();
    try {
      await htmxCommand.run(makeCtx({ positionals }));
    } finally {
      cap.restore();
    }
    const out = cap.logs.join("\n");
    assertStringIncludes(out, `@denext/htmx wraps htmx v${HTMX_VERSION}`);
    assertStringIncludes(out, `runtime path: ${HTMX_RUNTIME_PATH}`);
    const kb = ((await Deno.readFile(VENDORED)).byteLength / 1024).toFixed(1);
    assertStringIncludes(out, `size:         ${kb} KB raw`);
    assertStringIncludes(out, "script-src 'self'");
  }
});

Deno.test("denext htmx eject: writes the vendored runtime into the given directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_htmx_eject_" });
  const cap = capture();
  try {
    const dir = join(root, "static", "js");
    await htmxCommand.run(makeCtx({ positionals: ["eject", dir] }));
    const dest = join(dir, "htmx.min.js");
    assertEquals(await Deno.readFile(dest), await Deno.readFile(VENDORED));
    assertStringIncludes(cap.logs.join("\n"), `Wrote htmx v${HTMX_VERSION} → ${dest}`);
    assertStringIncludes(cap.logs.join("\n"), '<script src="/htmx.min.js" defer>');
  } finally {
    cap.restore();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("denext htmx: an unknown action is refused with the usage", async () => {
  const cap = capture();
  try {
    await assertRejects(
      async () => await htmxCommand.run(makeCtx({ positionals: ["frobnicate"] })),
      Error,
      "unknown htmx action: frobnicate",
    );
  } finally {
    cap.restore();
  }
  assertStringIncludes(cap.errs.join("\n"), "Try: denext htmx info | eject [dir]");
  assertStringIncludes(htmxCommand.usage ?? "", "eject [dir]");
});
