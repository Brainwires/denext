// Real-browser proof that a soft navigation streams its deferred values per boundary, as a
// document load does: navigating to a route whose client component `<Await>`s a fast and a slow
// deferred value renders the route at once with both fallbacks, reveals the fast value while the
// slow one is still loading, then the slow one — with no full reload. The same holds for a
// navigation sent as a POST (what a Remix `shouldRevalidate` echo too large for headers makes it).
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { buildAndServe, collectConsoleErrors, launchBrowser, pollFor } from "./harness.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/soft-nav", import.meta.url));
const has = (id: string) => `!!document.querySelector('[data-testid=${id}]')`;

/** Navigate to the deferred route and watch its boundaries reveal one at a time. */
async function navigateDeferred(post: boolean): Promise<void> {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    if (post) {
      // The navigation's request goes out as a POST with a body, as the client sends it when its
      // render payload is too large for headers.
      // deno-lint-ignore no-explicit-any
      const cdp = page.unsafelyGetCelestialBindings() as any;
      await cdp.Page.addScriptToEvaluateOnNewDocument({ source: FORCE_POST });
    }
    const errors = collectConsoleErrors(page);
    await page.goto(server.origin + "/", { waitUntil: "load" });
    await page.waitForFunction("!!document.querySelector('[data-testid=home]')");
    // Hydrated (its effect has run, so a click is not lost on the server's markup): the
    // layout's client counter responds.
    await page.waitForFunction(
      "!!document.querySelector('[data-testid=navcount][data-hydrated]')",
    );
    const counter = await page.$("[data-testid=navcount]");
    assert(counter);
    await counter.click();
    await pollFor(
      page,
      "document.querySelector('[data-testid=navcount]').textContent.includes('count: 1')",
    );
    await page.evaluate("window.__noReload = true");

    await page.evaluate(
      "Array.from(document.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/deferred').click()",
    );
    // The route commits at its payload: both boundaries show their fallbacks.
    await pollFor(page, `${has("deferred")} && ${has("slow-wait")}`);
    // The fast value arrives while the slow one is still loading.
    await pollFor(page, has("fast"));
    assert(
      await page.evaluate(`${has("slow-wait")} && !${has("slow")}`),
      "the fast boundary revealed before the slow value arrived",
    );
    await pollFor(page, has("slow"));
    assert(
      await page.evaluate(
        "document.querySelector('[data-testid=slow]').textContent === 'slow value'",
      ),
    );
    assert(await page.evaluate("window.__noReload === true"), "no full reload");
    assert(errors.length === 0, `no console errors: ${errors.join("\n")}`);
    if (post) {
      assert(await page.evaluate("window.__posts > 0"), "the navigation went out as a POST");
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

/** Re-issue each navigation's GET (not a prefetch's) as a POST with a JSON body (`__posts`). */
const FORCE_POST = `(() => {
  const orig = window.fetch;
  window.__posts = 0;
  window.fetch = (input, init = {}) => {
    const h = new Headers(init.headers);
    if (h.get("x-denext-defer") === "1" && (init.method ?? "GET") === "GET") {
      window.__posts++;
      h.set("content-type", "application/json");
      return orig(input, { ...init, method: "POST", headers: h, body: JSON.stringify({}) });
    }
    return orig(input, init);
  };
})();`;

Deno.test({
  name: "e2e: a soft navigation streams its deferred values per boundary",
}, () => navigateDeferred(false));

Deno.test({
  name: "e2e: a soft navigation sent as a POST streams its deferred values too",
}, () => navigateDeferred(true));
