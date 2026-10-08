// Real-browser proof of React 19.2's `<ViewTransition>` and `<Activity>` semantics on a same-page
// update (Chromium has the View Transitions API):
//
// - a `startTransition` update that adds a wrapped element runs inside
//   `document.startViewTransition`, the entering element named on the NEW side only (its
//   `enter` class applied), and every stamp removed once the transition finishes;
// - an urgent (non-transition) update applies directly, with no view transition (the next
//   Transition add is the second recorded one);
// - a hidden `<Activity>` mounts no effect until it is revealed, and cleans it up on hide.
//
// A probe wraps `startViewTransition` (before the page's scripts) to record, per call, the
// stamped `view-transition-name`s at the old capture and after the update callback.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import { buildAndServe, collectConsoleErrors, launchBrowser, pollFor } from "./harness.ts";
import { fromFileUrl } from "@std/path";

const PROBE = `(() => {
  const w = window;
  w.__vt = [];
  const named = () => Array.from(document.querySelectorAll("[data-testid]"))
    .filter((e) => e.style.viewTransitionName)
    .map((e) => e.dataset.testid + "=" + e.style.viewTransitionClass);
  const orig = Document.prototype.startViewTransition;
  if (!orig) return;
  Document.prototype.startViewTransition = function (arg) {
    const rec = { old: named(), next: null, done: false };
    w.__vt.push(rec);
    const update = typeof arg === "function" ? arg : arg.update;
    const wrapped = async () => {
      await update();
      rec.next = named();
    };
    const t = orig.call(this, typeof arg === "function" ? wrapped : { ...arg, update: wrapped });
    t.finished.finally(() => (rec.done = true));
    return t;
  };
})();`;

const FIXTURE = fromFileUrl(new URL("./fixtures/client-layout", import.meta.url));

Deno.test({
  name: "e2e: same-page <ViewTransition> + hidden <Activity> effects (React 19.2 semantics)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    // deno-lint-ignore no-explicit-any
    const cdp = page.unsafelyGetCelestialBindings() as any;
    await cdp.Page.addScriptToEvaluateOnNewDocument({ source: PROBE });
    await page.goto(server.origin + "/", { waitUntil: "load" });
    // Hydrated once the layout's client state reaches the real <html>.
    await pollFor(
      page,
      "(document.querySelector('[data-testid=theme]').click(), document.documentElement.className === 'dark')",
    );
    assert(
      await page.evaluate("typeof Document.prototype.startViewTransition === 'function'"),
      "this Chromium has the View Transitions API",
    );

    // The hidden Activity pre-rendered its content but mounted no effect.
    await pollFor(page, "!!document.querySelector('[data-testid=panel]')");
    assertEquals(await page.evaluate("window.__panelEffects ?? 0"), 0, "no effect while hidden");
    await page.evaluate("document.querySelector('[data-testid=toggle]').click()");
    await pollFor(page, "window.__panelEffects === 1");
    await page.evaluate("document.querySelector('[data-testid=toggle]').click()");
    await pollFor(page, "window.__panelCleanups === 1");

    // A Transition add animates: the new item is named on the new side, with its enter class.
    await page.evaluate("document.querySelector('[data-testid=add]').click()");
    await pollFor(page, "window.__vt.length === 1 && window.__vt[0].next !== null");
    const first = await page.evaluate("window.__vt[0]") as { old: string[]; next: string[] };
    // The persisting sibling under the changed <ul> is a layout candidate: named at the old
    // capture, then cancelled (unnamed on the new side) because the append did not move it.
    assertEquals(
      first.old,
      ["item-a="],
      "the sibling is named at the old capture (no update class)",
    );
    assertEquals(
      first.next,
      ["item-b=item-in"],
      "the entering item carries its enter class; a is cancelled",
    );
    await pollFor(page, "window.__vt[0].done === true");
    assertEquals(
      await page.evaluate(
        "Array.from(document.querySelectorAll('li')).map((e) => e.style.viewTransitionName + e.style.viewTransitionClass).join('')",
      ),
      "",
      "the stamps are removed once the transition finishes",
    );

    // An urgent add applies directly: no second view transition.
    await page.evaluate("document.querySelector('[data-testid=add-urgent]').click()");
    await pollFor(page, "!!document.querySelector('[data-testid=item-c]')");
    // The signal that the urgent commit started no transition: the next Transition add is the
    // second recorded call (a view transition starts inside the commit, so one for item-c
    // would have been recorded before it).
    await page.evaluate("document.querySelector('[data-testid=add]').click()");
    await pollFor(page, "window.__vt.length >= 2 && window.__vt.at(-1).next !== null");
    assertEquals(await page.evaluate("window.__vt.length"), 2, "urgent updates never animate");
    assert(
      (await page.evaluate("window.__vt[1].next") as string[]).includes("item-d=item-in"),
      "the second view transition is the Transition add's",
    );
    assertEquals(errors, [], "no console errors");
  } finally {
    await browser.close();
    await server.close();
  }
});
