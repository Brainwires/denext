// Validates the next-compat CLIENT serving pipeline of the unbundled dev loop against
// the REAL examples/next-compat (which imports `react` + the real
// `@radix-ui/react-collapsible` npm package). A full browser dev run isn't possible in
// this harness — compat SSR needs the CLI's node_modules re-exec — so this drives
// createUnbundledDev directly and asserts the pieces the browser would fetch:
//   1. the app page transforms with `react` → the pre-bundled runtime (@dep) and the
//      npm import → the on-demand npm bundle (@npm);
//   2. @dep/react.js serves the react→denext runtime;
//   3. the npm bundle serves with `react` EXTERNAL (denext's single React, not a copy).
//
// Opt-in: run with `deno task test:e2e`. Excluded from `deno task test`/`check`.

import { assert, assertStringIncludes } from "@std/assert";
import { exists } from "@std/fs";
import { join } from "@std/path";
import { createUnbundledDev } from "../../src/build/dev-unbundled.ts";

const EXAMPLE = new URL("../../examples/next-compat", import.meta.url).pathname;

Deno.test({
  name: "e2e: unbundled compat — react→runtime + npm optimizeDeps serving",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const outDir = await Deno.makeTempDir({ prefix: "denext_compat_" });
  const dev = createUnbundledDev({
    projectDir: EXAMPLE,
    appDir: join(EXAMPLE, "app"),
    configPath: join(EXAMPLE, "deno.json"),
    outDir,
    compat: true,
    classComponents: true,
  });

  try {
    const pageAbs = join(EXAMPLE, "app/page.tsx");
    let pageCode = "";

    await t.step("the example's npm deps are installed (@radix-ui/react-collapsible)", async () => {
      // examples/next-compat/node_modules is gitignored and is NOT installed on a cold
      // checkout (CI). Without it, the on-demand @npm esbuild optimize below can't resolve
      // the npm dep and the serve 500s — so install it first (nodeModulesDir:"auto"). A
      // no-op when already warm (local dev), matching the sibling next-compat e2e tests.
      if (await exists(join(EXAMPLE, "node_modules"), { isDirectory: true })) return;
      const install = await new Deno.Command(Deno.execPath(), {
        args: ["install"],
        cwd: EXAMPLE,
      }).output();
      assert(
        install.success,
        "`deno install` failed for examples/next-compat — is npm reachable?\n" +
          new TextDecoder().decode(install.stderr),
      );
    });

    await t.step("the app page transforms react→@dep and the npm import→@npm", async () => {
      const entry = await dev._internal.transform(pageAbs);
      pageCode = entry.code;
      assertStringIncludes(pageCode, "/_denext/@dep/react.js");
      assertStringIncludes(pageCode, "/_denext/@npm/");
    });

    await t.step("@dep/react.js serves the react→denext runtime", async () => {
      const res = await dev.handle(
        new Request("http://x/_denext/@dep/react.js"),
        new URL("http://x/_denext/@dep/react.js"),
        { pages: [] } as never,
      );
      assert(res, "handler returned a response");
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const code = await res.text();
      assert(code.length > 500, "runtime react.js is non-trivial");
    });

    await t.step("the npm bundle serves with react EXTERNAL (single React)", async () => {
      // The @npm URL the page imports.
      const npmUrl = pageCode.match(/\/_denext\/@npm\/[^"'`?\s]+\.js/)?.[0];
      assert(npmUrl, "page imports an @npm module");
      const res = await dev.handle(
        new Request("http://x" + npmUrl),
        new URL("http://x" + npmUrl),
        { pages: [] } as never,
      );
      assert(res, "handler returned a response");
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const code = await res.text();
      assertStringIncludes(code, "/_denext/@dep/react.js"); // react shared, not bundled
      assert(!/function useState\(/.test(code), "no second React bundled into the npm dep");
    });
  } finally {
    await dev.stop();
    await Deno.remove(outDir, { recursive: true }).catch(() => {});
  }
});
