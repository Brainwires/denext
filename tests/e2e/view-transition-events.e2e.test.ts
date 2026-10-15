// Real-browser proof of `<ViewTransition>`'s callbacks (Chromium has the View Transitions API):
// `onEnter` runs once the transition is ready with React's `ViewTransitionInstance` — its
// `new.animate()` really animates `::view-transition-new(name)` — and its cleanup when the
// transition finishes; `onExit` and `onUpdate` run for a removal and a content change; and an
// `<Activity>` going hidden in a Transition exits its boundary (named, with its exit class, at the
// old capture). A probe records each `startViewTransition` call's old-capture stamps.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { buildAndServe, collectConsoleErrors, launchBrowser, pollFor } from "./harness.ts";

const PROBE = `(() => {
  const w = window;
  w.__vt = [];
  const orig = Document.prototype.startViewTransition;
  if (!orig) return;
  Document.prototype.startViewTransition = function (arg) {
    const old = Array.from(document.querySelectorAll("[data-testid]"))
      .filter((e) => e.style.viewTransitionName)
      .map((e) => e.dataset.testid + ":" + e.style.viewTransitionName + "=" +
        e.style.viewTransitionClass);
    const rec = { old, done: false };
    w.__vt.push(rec);
    const t = orig.call(this, arg);
    t.finished.finally(() => (rec.done = true));
    return t;
  };
})();`;

const FIXTURE = fromFileUrl(new URL("./fixtures/client-layout", import.meta.url));

Deno.test({
  name: "e2e: <ViewTransition> onEnter/onExit/onUpdate and an <Activity> hiding as an exit",
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
    await pollFor(
      page,
      "(document.querySelector('[data-testid=theme]').click(), document.documentElement.className === 'dark')",
    );
    const cb = () => page.evaluate("window.__cb ?? []") as Promise<string[]>;

    // onEnter: after `ready`, with the instance (its pseudo-element really animates) and types.
    await page.evaluate("document.querySelector('[data-testid=cb-card]').click()");
    await pollFor(page, "(window.__cb ?? []).some((s) => s.startsWith('enter:'))");
    assertEquals((await cb()).slice(0, 2), ["enter:card:", "animating:true"]);
    await pollFor(page, "(window.__cb ?? []).includes('enter-cleanup')");

    // onExit on removal: the leaving card is named at the old capture with its exit class.
    await page.evaluate("document.querySelector('[data-testid=cb-card]').click()");
    await pollFor(page, "(window.__cb ?? []).includes('exit:card')");
    assert(
      (await page.evaluate("window.__vt.at(-1).old") as string[]).includes("card:card=card-out"),
    );

    // onUpdate: the boundary's own content changed.
    await page.evaluate("document.querySelector('[data-testid=cb-bump]').click()");
    await pollFor(page, "(window.__cb ?? []).some((s) => s.startsWith('update:'))");

    // An <Activity> going hidden in a Transition: an exit of its boundary.
    const before = await page.evaluate("window.__vt.length") as number;
    await page.evaluate("document.querySelector('[data-testid=cb-act]').click()");
    await pollFor(page, "(window.__cb ?? []).includes('exit:act')");
    assertEquals(await page.evaluate("window.__vt.length"), before + 1);
    assert(
      (await page.evaluate("window.__vt.at(-1).old") as string[]).includes("act:act=act-out"),
      "the hidden content is named, with its exit class, before the old capture",
    );
    await pollFor(
      page,
      "getComputedStyle(document.querySelector('[data-testid=act]')).display === 'none'",
    );
    assertEquals(errors, [], "no console errors");
  } finally {
    await browser.close();
    await server.close();
  }
});
