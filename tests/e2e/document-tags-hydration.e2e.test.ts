// Real-browser proof that full-tree hydration ADOPTS the server-rendered DOM instead of
// re-creating it. A root layout's <html>/<head>/<body> are rendered nested inside the page
// container, where the browser's HTML parser drops the three tags; the server's Flight tree
// mirrors that (it peels them), so the client tree matches the parsed DOM.
//
// A probe injected before the page's own scripts marks every element of the page container as
// soon as parsing ends (readyState "interactive", before the deferred entry runs) and counts
// every element the page later removes from it. After hydration every marked element must still
// be in the document and nothing may have been removed: no node replacement.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import type { Page } from "@astral/astral";
import { buildAndServe, launchBrowser, pollFor } from "./harness.ts";
import { fromFileUrl } from "@std/path";

const PROBE = `(() => {
  const w = window;
  w.__removed = 0;
  document.addEventListener("readystatechange", () => {
    if (document.readyState !== "interactive") return;
    const root = document.getElementById("__denext");
    if (!root) return;
    w.__marked = Array.from(root.querySelectorAll("*"));
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.removedNodes) if (n.nodeType === 1) w.__removed++;
    }).observe(root, { childList: true, subtree: true });
  });
})();`;

/** Load `url` with the probe installed, wait for `ready`, and return the adoption evidence. */
async function probe(page: Page, url: string, ready: string) {
  // deno-lint-ignore no-explicit-any
  const cdp = page.unsafelyGetCelestialBindings() as any;
  await cdp.Page.addScriptToEvaluateOnNewDocument({ source: PROBE });
  await page.goto(url, { waitUntil: "load" });
  await pollFor(page, ready);
  await new Promise((r) => setTimeout(r, 300)); // let any late re-render land
  return {
    marked: Number(await page.evaluate("window.__marked ? window.__marked.length : -1")),
    detached: Number(await page.evaluate("window.__marked.filter((n) => !n.isConnected).length")),
    removed: Number(await page.evaluate("window.__removed")),
  };
}

const APPS = [
  {
    name: "a Next-convention layout (<html>/<head>/<body>) hydrating its full tree",
    dir: fromFileUrl(new URL("./fixtures/soft-nav", import.meta.url)),
    // The layout's counter is an eager client component: the whole page tree hydrates. It
    // counting a click proves hydration happened.
    ready: "(document.querySelector('[data-testid=navcount]').click(), " +
      "!document.querySelector('[data-testid=navcount]').textContent.includes('count: 0'))",
  },
  {
    name: 'a root layout rendered by client code ("use client" <html>/<body>)',
    dir: fromFileUrl(new URL("./fixtures/client-layout", import.meta.url)),
    // The layout's own state drives the REAL <html>/<body> attributes (adopted, not re-created
    // inside the page container): toggling it proves hydration happened and reached them.
    // Clicked until it is dark (a click before hydration does nothing), never back: the click
    // mounts the form below, which another click would remove again.
    ready: "(document.documentElement.className === 'dark' || " +
      "document.querySelector('[data-testid=theme]').click(), " +
      "document.documentElement.className === 'dark' && document.body.dataset.theme === 'dark' && " +
      "!document.querySelector('#__denext html, #__denext head, #__denext body') && " +
      // The form the click mounts fresh: its defaults fill the real fields (react-dom parity).
      "(() => { const f = document.querySelector('[data-testid=defaults]'); if (!f) return false; " +
      "const sel = (n) => Array.from(f.elements[n].selectedOptions, (o) => o.value).join(); " +
      "return f.elements.t.value === 'hello' && !f.elements.t.hasAttribute('defaultvalue') && " +
      "f.elements.c.checked && f.elements.a.value === 'draft' && sel('s') === 'b' && " +
      "sel('m') === 'a,c'; })())",
  },
  {
    name: "examples/notes (a denext-convention layout with a client error boundary)",
    dir: fromFileUrl(new URL("../../examples/notes", import.meta.url)),
    ready: "document.readyState === 'complete'",
  },
];

for (const app of APPS) {
  Deno.test({
    name: `e2e: hydration adopts the server DOM — ${app.name}`,
    sanitizeOps: false,
    sanitizeResources: false,
  }, async () => {
    const server = await buildAndServe(app.dir);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      const r = await probe(page, server.origin + "/", app.ready);
      assert(r.marked > 3, `the probe marked the server DOM (${r.marked} elements)`);
      assertEquals(r.detached, 0, "every server-rendered element survived hydration");
      assertEquals(r.removed, 0, "hydration removed no element from the page container");
    } finally {
      await browser.close();
      await server.close();
    }
  });
}
