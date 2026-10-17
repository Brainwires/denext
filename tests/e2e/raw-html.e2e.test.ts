// Real-browser proof that hydration ADOPTS a `dangerouslySetInnerHTML` host's server markup, as
// React does: the parser's own child nodes are the ones left after hydration (and after a later
// re-render), never emptied or re-created. Each route of tests/e2e/fixtures/raw-html renders the
// same markup into `#raw` from a different place:
//   /        a Server Component host beside a client island (Flight hydration)
//   /client  the host inside a client component, which re-renders on a click
//   /nested  the host in a client component nested in another client component
//   /lazy    the /client component as a `client:load` island (the deferred, resumable path)
//   /iso     a page that calls a hook (one isomorphic client tree)
//   /mismatch the client's `__html` differs from the server's: as in React 19, the server's
//            markup is kept (not patched up) in a production build, with no warning
// The markup holds `<br/>` and a bare `value`, which the browser re-serializes differently, so a
// naive string comparison would read them as a mismatch and re-create the nodes.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run; headless).

import { assert, assertEquals } from "@std/assert";
import type { Page } from "@astral/astral";
import { buildAndServe, launchBrowser, pollFor } from "./harness.ts";
import { fromFileUrl } from "@std/path";

const FIXTURE = fromFileUrl(new URL("./fixtures/raw-html", import.meta.url));

// Runs before the page's scripts: once parsing ends (before the deferred entry), keep the
// parser's child nodes of #raw.
const PROBE = `document.addEventListener("readystatechange", () => {
  if (document.readyState !== "interactive") return;
  const raw = document.getElementById("raw");
  window.__parsed = raw ? Array.from(raw.childNodes) : null;
});`;

/** The adoption evidence for #raw against the parser's nodes. */
const EVIDENCE = `JSON.stringify((() => {
  const raw = document.getElementById("raw");
  const now = raw ? Array.from(raw.childNodes) : [];
  const parsed = window.__parsed || [];
  return {
    parsed: parsed.length,
    now: now.length,
    same: parsed.length > 0 && parsed.length === now.length && parsed.every((n, i) => n === now[i]),
    text: raw ? raw.textContent : null,
    input: !!(raw && raw.querySelector("#in") === parsed.find((n) => n.id === "in")),
  };
})())`;

interface Evidence {
  parsed: number;
  now: number;
  same: boolean;
  text: string | null;
  input: boolean;
}

async function evidence(page: Page): Promise<Evidence> {
  return JSON.parse(String(await page.evaluate(EVIDENCE)));
}

/** Click the route's counter until it reads `count: <n>` (a click before hydration is a no-op). */
async function clickTo(page: Page, n: number): Promise<void> {
  await pollFor(
    page,
    `(document.querySelector('[data-testid=count]').textContent.includes('count: ${n}') || ` +
      `(document.querySelector('[data-testid=count]').click(), false))`,
  );
}

function assertAdopted(e: Evidence, when: string): void {
  assertEquals(e.parsed, 4, `the probe saw the server's 4 nodes (${when})`);
  assertEquals(e.text, "hithere", `#raw is not emptied (${when})`);
  assert(e.same, `#raw holds the parser's own nodes (${when}): ${JSON.stringify(e)}`);
  assert(e.input, `the server's <input> is the same element (${when})`);
}

const ROUTES = ["/", "/client", "/nested", "/lazy", "/iso", "/mismatch"];

Deno.test({
  name: "e2e: hydration adopts dangerouslySetInnerHTML markup (same nodes) on every path",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();
  try {
    for (const route of ROUTES) {
      await t.step(route, async () => {
        const page = await browser.newPage();
        const logged: string[] = [];
        // deno-lint-ignore no-explicit-any
        page.addEventListener("console", (e) => void logged.push(String((e as any).detail?.text)));
        // deno-lint-ignore no-explicit-any
        const cdp = page.unsafelyGetCelestialBindings() as any;
        await cdp.Page.addScriptToEvaluateOnNewDocument({ source: PROBE });
        await page.goto(server.origin + route, { waitUntil: "load" });
        await clickTo(page, 1); // hydrated
        assertAdopted(await evidence(page), "after hydration");
        await clickTo(page, 2); // a re-render with a fresh { __html } object
        assertAdopted(await evidence(page), "after a re-render");
        // A production build warns about nothing (React's mismatch warning is dev-only).
        assertEquals(logged.filter((t) => t.includes("hydration")), [], route);
        await page.close();
      });
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
