// Real-browser e2e: `global-error.tsx` hydrates on the next-compat build path and in a static
// export (both used to serve it as dead HTML with an inert `reset`). Proves what the in-process
// tests can't: the emitted entry boots in Chromium, author state works, and on the served app
// `reset()` recovers softly once the render succeeds.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { serveDir } from "@std/http/file-server";
import { staticExport } from "../../src/build/export.ts";
import { stopNextCompat } from "../../src/build/next-compat.ts";
import {
  assertNoConsoleErrors,
  buildAndServe,
  collectConsoleErrors,
  launchBrowser,
  pollFor,
} from "./harness.ts";

/** A next-compat app whose `/flaky` route throws until `<dir>/recovered` exists. */
async function writeFixture(dir: string): Promise<void> {
  const files: Record<string, string> = {
    "deno.json": JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
    "denext.config.ts": "export default { compatibilityMode: true };\n",
    "app/layout.tsx": `import { createElement as h } from "react";
export default function RootLayout({ children }) {
  return h("html", null, h("body", null, children));
}
`,
    "app/page.tsx": `import { createElement as h } from "react";
export default function Page() { return h("main", null, "home"); }
`,
    "app/flaky/page.tsx": `import { createElement as h } from "react";
export const dynamic = "force-dynamic";
export default function Flaky() {
  let ok = false;
  try { Deno.statSync(${JSON.stringify(join(dir, "recovered"))}); ok = true; } catch {}
  if (!ok) throw new Error("not yet");
  return h("main", { id: "recovered" }, "RECOVERED");
}
`,
    "app/global-error.tsx": `"use client";
import { createElement as h, useState } from "react";
export default function GlobalError({ error, reset }) {
  const [n, setN] = useState(0);
  return h("html", null, h("body", null,
    h("h2", { id: "ge-title" }, "Something broke: " + error.message),
    h("button", { id: "ge-count", type: "button", onClick: () => setN(n + 1) }, "count " + n),
    h("button", { id: "ge-reset", type: "button", onClick: () => reset() }, "Try again"),
  ));
}
`,
  };
  for (const [name, src] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
}

Deno.test({
  name: "e2e: global-error.tsx hydrates on the next-compat build and in a static export",
}, async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ge_e2e_" });
  await writeFixture(dir);
  const browser = await launchBrowser();
  try {
    await t.step("next-compat build: the 500 document hydrates and reset recovers", async () => {
      const server = await buildAndServe(dir);
      try {
        const page = await browser.newPage();
        const errors = collectConsoleErrors(page);
        await page.goto(`${server.origin}/flaky`, { waitUntil: "load" });
        await pollFor(page, "!!document.getElementById('ge-count')");
        const count = await page.$("#ge-count");
        assert(count, "the counter exists");
        await count.click();
        await pollFor(page, "document.getElementById('ge-count').textContent === 'count 1'");
        // The render now succeeds: reset() re-fetches the route and swaps the document in.
        await Deno.writeTextFile(join(dir, "recovered"), "");
        const reset = await page.$("#ge-reset");
        assert(reset, "the reset button exists");
        await reset.click();
        await pollFor(page, "!!document.getElementById('recovered')");
        assertEquals(await page.evaluate("document.getElementById('ge-title')"), null);
        // The 500 the first load got is expected; nothing else may error.
        assertNoConsoleErrors(errors.filter((e) => !/500|Internal Server Error/.test(e)));
        await page.close();
      } finally {
        await server.close();
        await Deno.remove(join(dir, "recovered")).catch(() => {});
      }
    });

    await t.step("static export: 500.html hydrates from the exported entry", async () => {
      const result = await staticExport(dir);
      const ac = new AbortController();
      const { promise, resolve } = Promise.withResolvers<number>();
      const server = Deno.serve(
        {
          port: 0,
          hostname: "127.0.0.1",
          signal: ac.signal,
          onListen: ({ port }) => resolve(port),
        },
        (req) => serveDir(req, { fsRoot: result.outDir, quiet: true }),
      );
      try {
        const port = await promise;
        const page = await browser.newPage();
        const errors = collectConsoleErrors(page);
        await page.goto(`http://127.0.0.1:${port}/500.html`, { waitUntil: "load" });
        await pollFor(page, "!!document.getElementById('ge-count')");
        const count = await page.$("#ge-count");
        assert(count, "the counter exists");
        await count.click();
        await pollFor(page, "document.getElementById('ge-count').textContent === 'count 1'");
        assertNoConsoleErrors(errors);
        await page.close();
      } finally {
        ac.abort();
        await server.finished;
      }
    });
  } finally {
    await browser.close();
    await stopNextCompat();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
