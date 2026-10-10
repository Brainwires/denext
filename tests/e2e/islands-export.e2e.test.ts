// Real-browser end-to-end test for a static export whose pages' only client code is deferred
// islands: a resumable route with one `client:interaction` island, exported with a `basePath`
// and served from a static file server under it. Proves what the in-process export tests
// can't: before the first interaction the page has fetched only the small deferred boot (no
// client runtime), the first click loads the runtime and is not lost, and nothing 404s or
// errors under the base path.
//
// Opt-in: run with `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { serveDir } from "@std/http/file-server";
import { assertNoConsoleErrors, collectConsoleErrors, launchBrowser, pollFor } from "./harness.ts";

const ROOT = new URL("../../", import.meta.url).href;
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

const FILES: Record<string, string> = {
  "deno.json": JSON.stringify({
    compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
    imports: {
      "denext": `${ROOT}mod.ts`,
      "denext/jsx-runtime": `${ROOT}src/jsx/jsx-runtime.ts`,
      "denext/server": `${ROOT}src/server/mod.ts`,
      "denext/client": `${ROOT}src/client/mod.ts`,
    },
  }),
  "denext.config.ts": `export default { basePath: "/docs" };\n`,
  "app/layout.tsx": `export default function Layout({ children }: { children: unknown }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  "app/toggle.tsx": `"use client";
import { useState } from "denext";
export function Toggle({ label }: { label: string }) {
  const [n, setN] = useState(0);
  return <button type="button" id="toggle" onClick={() => setN(n + 1)}>{label} {n}</button>;
}
`,
  "app/page.tsx": `import { Toggle } from "./toggle.tsx";
export const resumable = true;
export default function Page() {
  return <main><h1>Transcript</h1><p>static text</p><Toggle client:interaction label="details" /></main>;
}
`,
};

/** The script URLs the page has fetched so far (Resource Timing). */
async function scriptsLoaded(page: { evaluate: (js: string) => Promise<unknown> }) {
  const json = await page.evaluate(
    `JSON.stringify(performance.getEntriesByType("resource")` +
      `.map((e) => new URL(e.name).pathname).filter((p) => p.endsWith(".js")))`,
  );
  return JSON.parse(String(json)) as string[];
}

Deno.test({
  name: "e2e: an islands-only export boots without the runtime and replays the first click",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "denext_islands_export_e2e_" });
  for (const [name, src] of Object.entries(FILES)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", CLI, "export", dir],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));

  const misses: string[] = [];
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    async (req) => {
      const path = new URL(req.url).pathname;
      // The browser's own favicon probe goes to the origin's root, whatever the base path.
      if (path === "/favicon.ico") return new Response(null, { status: 204 });
      const res = path.startsWith("/docs/")
        ? await serveDir(req, { fsRoot: join(dir, "out"), urlRoot: "docs", quiet: true })
        : new Response("outside the base path", { status: 404 });
      if (res.status >= 400) misses.push(path);
      return res;
    },
  );
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    await page.goto(origin + "/docs/", { waitUntil: "load" });

    await t.step("before any interaction only the deferred boot is loaded", async () => {
      await new Promise((r) => setTimeout(r, 500)); // an eager runtime import would land by now
      assertEquals(await scriptsLoaded(page), ["/docs/_denext/client/flight-boot.js"]);
      assertEquals(
        await page.evaluate(`document.getElementById("toggle").textContent`),
        "details 0",
      );
    });

    await t.step("the first click loads the runtime and is replayed, not lost", async () => {
      const button = await page.$("#toggle");
      assert(button, "the island's server HTML is present");
      await button.click();
      await pollFor(page, `document.getElementById("toggle").textContent === "details 1"`, 15000);
      const scripts = await scriptsLoaded(page);
      assert(scripts.includes("/docs/_denext/client/flight.js"), scripts.join(", "));
      assert(scripts.some((s) => /\/chunk-[A-Z0-9]+\.js$/.test(s)), scripts.join(", "));
      // A second click is an ordinary one on the now-live island.
      await button.click();
      await pollFor(page, `document.getElementById("toggle").textContent === "details 2"`, 15000);
    });

    await t.step("no request fell outside the base path and the console stayed clean", () => {
      assertEquals(misses, []);
      assertNoConsoleErrors(errors);
    });
  } finally {
    await browser.close();
    ac.abort();
    await server.finished;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
