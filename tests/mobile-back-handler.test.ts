// denext/mobile's back handling: onBack / useBackHandler (a LIFO stack) and onBackProgress /
// useBackProgress. Android runs through a faked `DenextBack` plugin (denext's native template)
// or `@capacitor/app`'s backButton; iOS is a no-op; the web pushes a same-URL sentinel history
// entry and intercepts its `popstate` before the router sees it.

import { assert, assertEquals } from "@std/assert";
import { flushSync } from "../src/client/reconciler.ts";
import {
  type BackGesture,
  type BackProgressEvent,
  onBack,
  onBackProgress,
  useBackHandler,
  useBackProgress,
} from "../src/mobile/mod.ts";
import { resetBackForTesting } from "../src/mobile/back-handler.ts";
import {
  type Any,
  fakePlugin,
  inShell,
  mount,
  settle,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

/** Wait for the deferred driver stop (a 0 ms timer) and the promise callbacks after it. */
async function tick(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await settle();
}

/**
 * Tick until `done()` holds (at most ~2 s): chained 0 ms timers can take a timer-resolution step
 * each (~16 ms on Windows), so a fixed wait is too short there. The assertions after still check.
 */
async function tickUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await tick(10);
  await tick();
}

/** A `DenextBack` plugin, `@capacitor/app` and `history` for an Android shell test. */
function androidEnv(app: { minimize?: boolean } = {}) {
  const back = fakePlugin(["setEnabled"]);
  const appPlugin = fakePlugin(app.minimize === false ? ["exitApp"] : ["exitApp", "minimizeApp"]);
  let historyBacks = 0;
  return {
    back,
    app: appPlugin,
    historyBacks: () => historyBacks,
    extra: { document: {}, history: { back: () => void historyBacks++ } },
  };
}

Deno.test("onBack (Android, DenextBack): LIFO, consume, default, and the callback's enabling", async () => {
  resetBackForTesting();
  const env = androidEnv();
  await inShell("android", { DenextBack: env.back.plugin, App: env.app.plugin }, async () => {
    const order: string[] = [];
    let consume = false;
    const offA = onBack(() => void order.push("a"));
    const offB = onBack(() => (order.push("b"), consume));
    await settle();
    assertEquals(env.back.calls, [["setEnabled", { enabled: true }]], "enabled once");
    assertEquals(env.back.listening(), 4);

    env.back.fire("backInvoked", { canGoBack: true });
    assertEquals(order, ["b", "a"], "newest first");
    assertEquals(env.historyBacks(), 1, "unconsumed with history: history.back()");

    env.back.fire("backInvoked", { canGoBack: false });
    await settle();
    assertEquals(env.app.calls, [["minimizeApp", undefined]], "unconsumed at the root: minimize");

    consume = true;
    order.length = 0;
    env.back.fire("backInvoked", { canGoBack: true });
    assertEquals(order, ["b"], "a consumed back stops the stack");
    assertEquals(env.historyBacks(), 1);

    offB();
    offB(); // idempotent
    offA();
    await tick();
    assertEquals(env.back.calls.at(-1), ["setEnabled", { enabled: false }], "disabled when empty");
    assertEquals(env.back.listening(), 0);
  }, env.extra);
  resetBackForTesting();
});

Deno.test("onBack: an unregister + register in one tick keeps the driver running", async () => {
  resetBackForTesting();
  const env = androidEnv();
  await inShell("android", { DenextBack: env.back.plugin }, async () => {
    const off = onBack(() => true);
    off();
    const again = onBack(() => true);
    await tick();
    assertEquals(env.back.calls, [["setEnabled", { enabled: true }]], "never disabled in between");
    again();
    await tick();
    assertEquals(env.back.calls.length, 2);
  }, env.extra);
  resetBackForTesting();
});

Deno.test("onBackProgress (Android): start / progress / cancel / commit, clamped", async () => {
  resetBackForTesting();
  const env = androidEnv();
  await inShell("android", { DenextBack: env.back.plugin, App: env.app.plugin }, async () => {
    const seen: BackProgressEvent[] = [];
    const off = onBackProgress((e) => seen.push(e));
    await settle();
    assertEquals(
      env.back.calls,
      [["setEnabled", { enabled: true }]],
      "progress needs the callback",
    );
    env.back.fire("backStarted", { progress: 0, swipeEdge: "left" });
    env.back.fire("backProgressed", { progress: 1.7, swipeEdge: "right" });
    env.back.fire("backProgressed", {});
    env.back.fire("backCancelled");
    env.back.fire("backInvoked", { canGoBack: true });
    assertEquals(seen, [
      { type: "start", progress: 0, edge: "left" },
      { type: "progress", progress: 1, edge: "right" },
      { type: "progress", progress: 0, edge: "none" },
      { type: "cancel" },
      { type: "commit" },
    ]);
    assertEquals(env.historyBacks(), 1, "a committed back with no handler runs the default");
    off();
    await tick();
    assertEquals(env.back.listening(), 0);
  }, env.extra);
  resetBackForTesting();
});

Deno.test("useBackProgress / useBackHandler: the gesture in flight, the latest handler", async () => {
  resetBackForTesting();
  const env = androidEnv();
  await inShell("android", { DenextBack: env.back.plugin }, async () => {
    const out: { gesture?: BackGesture | null } = {};
    let label = "first";
    const handled: string[] = [];
    const { root, rerender } = mount(function Probe() {
      out.gesture = useBackProgress();
      useBackHandler(() => (handled.push(label), true));
      return null;
    });
    await settle();
    assertEquals(out.gesture, null);
    flushSync(() => env.back.fire("backStarted", { progress: 0.1, swipeEdge: "left" }));
    assertEquals(out.gesture, { progress: 0.1, edge: "left" });
    flushSync(() => env.back.fire("backProgressed", { progress: 0.6, swipeEdge: "left" }));
    assertEquals(out.gesture, { progress: 0.6, edge: "left" });
    flushSync(() => env.back.fire("backCancelled"));
    assertEquals(out.gesture, null);

    label = "second";
    rerender();
    env.back.fire("backInvoked", { canGoBack: false });
    assertEquals(handled, ["second"], "the re-rendered handler, registered once");
    assertEquals(env.back.calls, [["setEnabled", { enabled: true }]]);
    root.unmount();
    await tick();
    assertEquals(env.back.listening(), 0);
  }, env.extra);
  resetBackForTesting();
});

Deno.test("onBack (Android, @capacitor/app only): backButton, and exitApp without minimizeApp", async () => {
  resetBackForTesting();
  const env = androidEnv({ minimize: false });
  await inShell("android", { App: env.app.plugin }, async () => {
    let calls = 0;
    const off = onBack(() => void calls++);
    await settle();
    env.app.fire("backButton", { canGoBack: false });
    await settle();
    assertEquals(calls, 1);
    assertEquals(env.app.calls, [["exitApp", undefined]]);
    const progress: BackProgressEvent[] = [];
    const offProgress = onBackProgress((e) => progress.push(e));
    env.app.fire("backButton", { canGoBack: true });
    assertEquals(env.historyBacks(), 1);
    assertEquals(progress, [], "no progress without DenextBack");
    off();
    offProgress();
    await tick();
    assertEquals(env.app.listening(), 0);
  }, env.extra);
  resetBackForTesting();
});

Deno.test("onBack: iOS and SSR register nothing native", async () => {
  resetBackForTesting();
  const env = androidEnv();
  await inShell("ios", { DenextBack: env.back.plugin, App: env.app.plugin }, async () => {
    const off = onBack(() => true);
    await settle();
    assertEquals(env.back.calls, []);
    assertEquals(env.app.listening(), 0);
    off();
  }, env.extra);
  // SSR: no document.
  const off = onBack(() => true);
  off();
  onBackProgress(() => {})();
  resetBackForTesting();
});

// ---- web ---------------------------------------------------------------------

/** A browser-like history over `hrefs` (the last is current) that fires `popstate` async. */
function fakeHistory(hrefs: string[]) {
  const entries = hrefs.map((href) => ({ href, state: null as unknown }));
  let index = entries.length - 1;
  const location = { href: entries[index].href };
  const history = {
    get state() {
      return entries[index].state;
    },
    get length() {
      return entries.length;
    },
    pushState(state: unknown, _title: string, href: string) {
      entries.splice(index + 1);
      entries.push({ href, state: structuredClone(state) });
      index = entries.length - 1;
      location.href = href;
    },
    back() {
      if (index === 0) return;
      index--;
      location.href = entries[index].href;
      setTimeout(() => globalThis.dispatchEvent(new Event("popstate")), 0);
    },
  };
  return { history, location, entries, index: () => index };
}

Deno.test("onBack (web): a sentinel entry turns the browser's back into the handlers", async () => {
  resetBackForTesting();
  const nav = fakeHistory(["https://app.test/a", "https://app.test/x"]);
  // The router's popstate listener. In a browser it is registered first (denext's client
  // runtime installs it at startup) and the driver's capture listener still runs before it: the
  // DOM runs capturing listeners first at the target. Deno's EventTarget runs them in
  // registration order, so here the router registers after the driver.
  const routed: string[] = [];
  const router = () => void routed.push(nav.location.href);
  try {
    await withGlobals({ document: {}, history: nav.history, location: nav.location }, async () => {
      let consume = true;
      let calls = 0;
      const off = onBack(() => (calls++, consume));
      globalThis.addEventListener("popstate", router);
      assertEquals(nav.entries.length, 3, "sentinel pushed");
      assertEquals(nav.entries[2].href, "https://app.test/x", "same URL");
      assert((nav.history.state as Record<string, unknown>).__denextBack, "marked");

      nav.history.back(); // the user presses back
      await tick();
      assertEquals(calls, 1);
      assertEquals(routed, [], "the router never saw the intercepted pop");
      assertEquals([nav.entries.length, nav.index()], [3, 2], "consumed: sentinel restored");

      consume = false;
      nav.history.back();
      // Three chained 0 ms timers (the pop, the real back's pop, the re-arm): wait for the last.
      await tickUntil(() => calls === 2 && nav.index() === 1);
      assertEquals(calls, 2);
      assertEquals(routed, ["https://app.test/a"], "unconsumed: the real back reached the router");
      assertEquals(nav.location.href, "https://app.test/a");
      assertEquals(nav.index(), 1, "re-armed on the new page");

      off();
      await tick(20);
      assertEquals(nav.index(), 0, "stopping pops the sentinel");
      assertEquals(routed, ["https://app.test/a"], "…without the router seeing it");
      nav.history.back(); // nothing before: no event, and nothing listening anyway
    });
  } finally {
    globalThis.removeEventListener("popstate", router);
    resetBackForTesting();
  }
});

Deno.test("onBack (web): a pop to another entry passes through untouched", async () => {
  resetBackForTesting();
  const nav = fakeHistory(["https://app.test/a"]);
  let calls = 0;
  await withGlobals({ document: {}, history: nav.history, location: nav.location }, async () => {
    const off = onBack(() => (calls++, true));
    // The app navigates (router pushState) while the handler stays registered.
    nav.history.pushState({}, "", "https://app.test/b");
    nav.history.back(); // lands on the sentinel of /a: not a back off it
    await tick();
    assertEquals(calls, 0);
    off();
    await tick(20);
  });
  resetBackForTesting();
  // Without history (an odd embedder), onBack registers but installs nothing.
  await withGlobals({ document: {}, history: undefined }, () => onBack(() => true)());
  resetBackForTesting();
  assertEquals(typeof (globalThis as Any).history, "undefined");
});
