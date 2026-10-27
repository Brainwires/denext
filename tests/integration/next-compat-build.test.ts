// A FAST, BLOCKING guard for the next-compat build pipeline — the subsystem that
// rewrites `react`/`react-dom`/`react-dom/server` imports to denext's single
// runtime so real npm React libraries run. The full real-npm proof lives in the
// `tests/e2e/next-compat-*` suite (e2e.yml) (needs npm install); this one builds a
// page that imports only React specifiers (no npm packages, no browser), so it
// runs on every PR and catches an aliasing/dual-React regression in seconds.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { inChild } from "../helpers/isolated.ts";

Deno.test("next-compat build: react + react-dom/server importers resolve to single React", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_nc_build_" });
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
    );
    // Import from `react`, `react-dom`, and `react-dom/server` — the last is the
    // A1 crash-class case (without the alias it would pull a second, real
    // react-dom into the graph → two dispatchers).
    await Deno.writeTextFile(
      `${dir}/page.tsx`,
      `import { createElement as h, useState } from "react";
import { version as domVersion } from "react-dom";
import { renderToReadableStream, version } from "react-dom/server";
export default function Page() {
  const [n] = useState(3);
  const ok = typeof renderToReadableStream === "function" && domVersion === version;
  return h("main", null,
    h("h1", null, "compat"),
    h("p", null, "single-react:" + (ok ? "yes" : "no") + " n=" + n));
}
`,
    );

    // The build and the render run in a bounded child process: an in-process build that stalls
    // (the Windows pipe-inheritance class, tests/helpers/bounded-build.ts) can't be stopped.
    const { value } = await inChild<{ pages: number; html: string; clientBundle: string }>({
      imports: `import { buildNextCompatPages, renderNextCompatPage } from ` +
        `"@repo/src/build/next-compat-build.ts";`,
      body: `const built = await buildNextCompatPages(${
        JSON.stringify({
          projectDir: dir,
          configPath: `${dir}/deno.json`,
          outDir: `${dir}/.denext`,
          pages: [{ routePath: "/", filePath: `${dir}/page.tsx` }],
        })
      });
      const html = await renderNextCompatPage(built[0], {}, "/_client/index.js");
      return { pages: built.length, html, clientBundle: built[0].clientBundle };`,
    });
    assertEquals(value.pages, 1, "one page built");

    const html = value.html;
    assertStringIncludes(html, "compat");
    assertStringIncludes(html, "single-react:yes"); // both React entrypoints agree
    assertStringIncludes(html, "n=3"); // hooks work in the built page

    // The client bundle must be denext's runtime, never npm React.
    const client = await Deno.readTextFile(value.clientBundle);
    assert(
      !/react\.development|react\.production|__SECRET_INTERNALS_DO_NOT_USE/.test(client),
      "client bundle must not contain npm React",
    );
    assert(
      client.includes("denext.provider") || client.includes("denext.suspense"),
      "client bundle must contain denext's runtime",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
