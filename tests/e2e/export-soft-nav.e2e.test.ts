// Real-browser e2e: soft navigation on a static export requests each route's client entry at
// most once. A soft nav re-runs the incoming route's entry; an entry the document already
// evaluated registered its `main` by URL and is re-run in place, so moving between visited
// routes fetches no entry module (no per-navigation `?nav=` cache-buster, no request at all), and
// the re-run still reconciles the page into an interactive one. Covers a whole-route client
// entry (a page that calls a hook) and the app-wide Flight entry (a `"use client"` island).
//
// Opt-in: run with `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { serveDir } from "@std/http/file-server";
import { assertNoConsoleErrors, collectConsoleErrors, launchBrowser, pollFor } from "./harness.ts";

const ROOT = new URL("../../", import.meta.url).href;
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

const page = (id: string) =>
  `import { Link, useState } from "denext";
export default function Page() {
  const [n, setN] = useState(0);
  return <main>
    <button type="button" id="${id}" onClick={() => setN(n + 1)}>${id} {n}</button>
    <Link href="/">a</Link> <Link href="/b">b</Link> <Link href="/c">c</Link>
  </main>;
}
`;

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
  "denext.config.ts": `export default {};\n`,
  "app/layout.tsx": `export default function Layout({ children }: { children: unknown }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  "app/page.tsx": page("a"),
  "app/b/page.tsx": page("b"),
  "app/c/toggle.tsx": `"use client";
import { useState } from "denext";
export function Toggle() {
  const [n, setN] = useState(0);
  return <button type="button" id="c" onClick={() => setN(n + 1)}>c {n}</button>;
}
`,
  "app/c/page.tsx": `import { Link } from "denext";
import { Toggle } from "./toggle.tsx";
export default function Page() {
  return <main><Toggle /> <Link href="/">a</Link> <Link href="/b">b</Link></main>;
}
`,
};

const clickLink = (href: string) =>
  `Array.from(document.querySelectorAll('a')).find((a) => a.getAttribute('href') === '${href}').click()`;

Deno.test({
  name: "e2e: soft navigation on an export fetches each route entry once, then re-runs it",
}, async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "denext_export_soft_nav_e2e_" });
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

  // Every client-module request the static host sees, with its query.
  const requests: string[] = [];
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      if (url.pathname.endsWith(".js")) requests.push(url.pathname + url.search);
      return serveDir(req, { fsRoot: join(dir, "out"), quiet: true });
    },
  );
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const browser = await launchBrowser();
  try {
    const tab = await browser.newPage();
    const errors = collectConsoleErrors(tab);
    await tab.goto(origin + "/", { waitUntil: "load" });
    await pollFor(tab, "!!globalThis.__dnxRoot", 15000);
    await tab.evaluate("window.__noReload = true");

    const go = async (href: string, id: string) => {
      await tab.evaluate(clickLink(href));
      await pollFor(tab, `!!document.getElementById("${id}")`, 15000);
    };

    await t.step("the first visit to each route loads its entry by its plain URL", async () => {
      await go("/b", "b");
      await go("/c", "c");
      await go("/", "a");
      assert(requests.every((r) => !r.includes("nav=")), requests.join(", "));
    });

    await t.step("moving between visited routes requests no entry module", async () => {
      const before = requests.length;
      for (const [href, id] of [["/b", "b"], ["/c", "c"], ["/", "a"], ["/b", "b"]]) {
        await go(href, id);
      }
      assertEquals(requests.slice(before), [], "no client module was requested");
      assert(await tab.evaluate("window.__noReload === true"), "no full reload");
    });

    await t.step("a re-run entry leaves an interactive page", async () => {
      await tab.evaluate(`document.getElementById("b").click()`);
      await pollFor(tab, `document.getElementById("b").textContent === "b 1"`, 15000);
      await go("/c", "c");
      await tab.evaluate(`document.getElementById("c").click()`);
      await pollFor(tab, `document.getElementById("c").textContent === "c 1"`, 15000);
    });

    await t.step("each module was requested once, and the console stayed clean", () => {
      assertEquals(requests.length, new Set(requests).size, requests.join(", "));
      assertNoConsoleErrors(errors);
    });
  } finally {
    await browser.close();
    ac.abort();
    await server.finished;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
