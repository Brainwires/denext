// denext/navigation on the in-memory DOM: the stack view keeps a pushed-over screen's state and
// restores it on pop; StackLayout keeps the stack and the URL history in step (stamps, a claimed
// back that restores the title and hydration data, deep-link ancestors written into history, a
// reload rebuilt from a stamp); the edge swipe and the sheet drag driven by synthetic pointer
// events; Android predictive back through a faked `DenextBack` plugin; tabs that keep their
// panels and pop to the root on re-tap; the sheet's dialog semantics, dismissal and focus
// wrap; and the React Navigation / Expo Router adapters.

import "./helpers/activity-runtime.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { useState } from "../src/runtime/hooks.ts";
import { FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";
import {
  attachEdgeSwipe,
  diffEntries,
  StackView,
  visibleIds,
} from "../src/navigation/stack-view.ts";
import { StackLayout } from "../src/navigation/stack-layout.ts";
import { readStamp } from "../src/navigation/stack-model.ts";
import { attachSheetDrag, Sheet, trapFocusTarget } from "../src/navigation/sheet.ts";
import {
  createTabScope,
  reselectTab,
  tabFor,
  TabsLayout,
  TabsView,
} from "../src/navigation/tabs.ts";
import { navigationContexts } from "../src/navigation/context.ts";
import {
  createBottomTabNavigatorFactory,
  createNativeStackNavigatorFactory,
  mapStackOptions,
  type ReactNavigationCore,
} from "../src/navigation/react-navigation.ts";
import {
  expoRouterNavigatorsPlugin,
  expoRouterNavigatorsSource,
} from "../src/build/expo-router-navigators.ts";
import { resetBackForTesting } from "../src/mobile/back-handler.ts";
import type { StackViewEntry } from "../src/navigation/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

// ---- harness -------------------------------------------------------------------------------

/** Let effects, promise callbacks and 0 ms timers run. */
async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, ms));
    flushSync();
  }
}

/** Install `values` on globalThis for `fn`, then restore. */
async function withGlobals(values: Record<string, unknown>, fn: () => unknown): Promise<void> {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(g, key));
    Object.defineProperty(g, key, { configurable: true, writable: true, value });
  }
  try {
    await fn();
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(g, key, desc);
      else delete g[key];
    }
  }
}

/** A `location` + `history` pair: push/replace/go move the URL; go fires `popstate` async. */
function fakeHistory(start: string) {
  const origin = "http://app.test";
  const entries: Array<{ url: string; state: unknown }> = [{ url: start, state: null }];
  let index = 0;
  const log: string[] = [];
  /** The pops the router would have refetched (no navigator claimed them). */
  const refetches: string[] = [];
  const url = () => new URL(entries[index].url, origin);
  const location = {
    get pathname() {
      return url().pathname;
    },
    get search() {
      return url().search;
    },
    get href() {
      return url().href;
    },
    get origin() {
      return origin;
    },
  };
  const at = (
    u: string | undefined,
  ) => (u ? new URL(u, url()).pathname + new URL(u, url()).search : entries[index].url);
  const history = {
    get state() {
      return entries[index].state;
    },
    get length() {
      return entries.length;
    },
    pushState(state: unknown, _t: string, u?: string) {
      entries.splice(index + 1);
      entries.push({ url: at(u), state: structuredClone(state) });
      index++;
      log.push(`push ${entries[index].url}`);
    },
    replaceState(state: unknown, _t: string, u?: string) {
      entries[index] = { url: at(u), state: structuredClone(state) };
    },
    go(n: number) {
      log.push(`go ${n}`);
      setTimeout(() => {
        index = Math.max(0, Math.min(entries.length - 1, index + n));
        const event = new Event("popstate");
        Object.defineProperty(event, "state", { value: entries[index].state });
        g.dispatchEvent(event);
        // What the router's popstate handler does first: offer the pop to a navigator.
        if (!(g as Any).__dnxPop?.(url().href, event)) refetches.push(entries[index].url);
      }, 0);
    },
    back() {
      this.go(-1);
    },
  };
  return { location, history, entries, log, refetches, index: () => index };
}

/** A document with a hydration data island and a title. */
function docWithData(data: Record<string, unknown>) {
  const { doc, container } = makeDom();
  const island = doc.createElement("script");
  island.textContent = JSON.stringify(data);
  doc.register("__denext_data", island);
  (doc as Any).title = "";
  setDocument(doc as Any);
  return { doc, container, island };
}

/** Every element under `root` with attribute `name` (optionally equal to `value`). */
function findAll(root: FakeElement, name: string, value?: string): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (n: Any) => {
    if (n.nodeType === 1) {
      const v = n.getAttribute(name);
      if (v !== null && (value === undefined || v === value)) out.push(n);
    }
    for (const c of n.childNodes ?? []) visit(c);
  };
  visit(root);
  return out;
}

const shown = (el: FakeElement | undefined) =>
  !!el && el.style.getPropertyValue("display") !== "none";

/** A page with a counter and an instance number (a remount would renumber it). */
function makePage(name: string, registry: Record<string, { inc: () => void; instance: number }>) {
  let instances = 0;
  return function Page(): VNode {
    const [instance] = useState(() => ++instances);
    const [n, setN] = useState(0);
    registry[name] = { inc: () => setN((x) => x + 1), instance };
    return h("p", { "data-page": name }, `${name}:${n}#${instance}`);
  };
}

const entry = (id: string, element: unknown, options = {}): StackViewEntry => ({
  id,
  element: element as never,
  options,
});

// ---- StackView ----------------------------------------------------------------------------

Deno.test("StackView: a push keeps the screen below mounted (hidden); a pop restores it with its state", async () => {
  const pages: Record<string, { inc: () => void; instance: number }> = {};
  const A = makePage("A", pages);
  const B = makePage("B", pages);
  const { container } = docWithData({});
  const root = createRoot(container as Any);
  const render = (entries: StackViewEntry[]) => {
    root.render(h(StackView, { entries, onPop: () => {}, platform: "ios" }));
    flushSync();
  };
  const a = h(A, null);
  render([entry("a", a)]);
  pages.A.inc();
  pages.A.inc();
  flushSync();
  render([entry("a", a), entry("b", h(B, null))]);
  await settle();
  const sections = findAll(container, "data-dnx-screen");
  assertEquals(sections.length, 2, "both screens are mounted");
  assert(!shown(sections[0]), "the screen below is hidden");
  assert(shown(sections[1]));
  assertEquals(sections[0].getAttribute("aria-hidden"), "true");
  assertEquals(sections[0].getAttribute("inert") !== null, true, "the screen below is inert");

  render([entry("a", a)]);
  await settle();
  const after = findAll(container, "data-dnx-screen");
  assertEquals(after.length, 1, "the popped screen is gone once its exit finished");
  assert(shown(after[0]));
  assertStringIncludes(container.textContent, "A:2#1", "same instance, same state");
  root.unmount();
});

Deno.test("StackView: a formSheet screen is a Sheet over the screen below, which stays visible", async () => {
  const { container } = docWithData({});
  const root = createRoot(container as Any);
  root.render(h(StackView, {
    entries: [
      entry("a", h("p", null, "list")),
      entry("s", h("p", null, "sheet body"), { presentation: "formSheet", title: "Filter" }),
    ],
    onPop: () => {},
    platform: "ios",
  }));
  await settle();
  const sections = findAll(container, "data-dnx-screen");
  assertEquals(sections.length, 1, "the sheet is not a card section");
  assert(shown(sections[0]), "the screen under a sheet stays drawn");
  root.unmount();
});

Deno.test("attachEdgeSwipe: edge touch, axis lock, commit, cancel, reject and mouse", () => {
  const listeners = new Map<string, (e: Any) => void>();
  const el = {
    addEventListener: (t: string, fn: (e: Any) => void) => listeners.set(t, fn),
    removeEventListener: (t: string) => listeners.delete(t),
    getBoundingClientRect: () => ({ left: 0, width: 400 }),
    setPointerCapture: () => {},
  };
  const log: string[] = [];
  let allowed = true;
  const off = attachEdgeSwipe(el, {
    canStart: () => allowed,
    begin: () => log.push("begin"),
    update: (p) => log.push(`update ${p.toFixed(2)}`),
    release: (d) => log.push(`release ${d}`),
    abort: () => log.push("abort"),
  });
  const fire = (t: string, x: number, y: number, ts: number, extra = {}) =>
    listeners.get(t)!({
      pointerId: 1,
      pointerType: "touch",
      clientX: x,
      clientY: y,
      timeStamp: ts,
      ...extra,
    });

  // Slow drag past halfway: commit.
  fire("pointerdown", 8, 300, 0);
  fire("pointermove", 20, 301, 20);
  fire("pointermove", 260, 305, 800);
  fire("pointerup", 260, 305, 900);
  assertEquals(log, ["begin", "update 0.03", "update 0.63", "release commit"]);

  // Short slow drag: cancel.
  log.length = 0;
  fire("pointerdown", 4, 300, 1000);
  fire("pointermove", 60, 300, 1500);
  fire("pointerup", 60, 300, 1600);
  assertEquals(log.at(-1), "release cancel");

  // Vertical first: the scroll keeps it; nothing starts.
  log.length = 0;
  fire("pointerdown", 4, 300, 2000);
  fire("pointermove", 6, 340, 2016);
  fire("pointerup", 6, 340, 2030);
  assertEquals(log, []);

  // Taken away mid-swipe: abort.
  fire("pointerdown", 4, 300, 3000);
  fire("pointermove", 40, 300, 3016);
  fire("pointercancel", 40, 300, 3020);
  assertEquals(log, ["begin", "update 0.09", "abort"]);

  // Mouse pointers and refused starts are ignored.
  log.length = 0;
  fire("pointerdown", 4, 300, 4000, { pointerType: "mouse" });
  fire("pointermove", 200, 300, 4100, { pointerType: "mouse" });
  allowed = false;
  fire("pointerdown", 4, 300, 5000);
  fire("pointermove", 200, 300, 5100);
  assertEquals(log, []);
  off();
  assertEquals(listeners.size, 0);
});

Deno.test("StackView: a committed edge swipe pops once, without a second animation", async () => {
  const { container } = docWithData({});
  const root = createRoot(container as Any);
  const pops: Array<[number, boolean]> = [];
  root.render(h(StackView, {
    entries: [entry("a", h("p", null, "A")), entry("b", h("p", null, "B"))],
    onPop: (i: number, how: { animated: boolean }) => pops.push([i, how.animated]),
    platform: "ios",
  }));
  await settle();
  const stack = findAll(container, "data-dnx-stack")[0];
  const fire = (t: string, x: number, ts: number) =>
    stack.dispatch(t, {
      pointerId: 7,
      pointerType: "touch",
      clientX: x,
      clientY: 100,
      timeStamp: ts,
      target: stack,
    });
  fire("pointerdown", 0, 0);
  fire("pointermove", 30, 16); // locks (the fake box is 0 px wide, so this is past the end)
  await settle();
  const below = findAll(container, "data-dnx-screen")[0];
  assert(shown(below), "the screen below is revealed under the finger");
  fire("pointerup", 30, 40);
  await settle();
  assertEquals(pops, [[0, false]], "the pop is handed over, marked as already animated");
  root.unmount();
});

// ---- Android predictive back -----------------------------------------------------------------

/** A faked Capacitor Android shell with the `DenextBack` plugin. */
function androidShell() {
  const listeners = new Map<string, Set<(p?: unknown) => void>>();
  const plugin = {
    setEnabled: () => Promise.resolve(),
    addListener: (event: string, fn: (p?: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(fn);
      return Promise.resolve({ remove: () => void set.delete(fn) });
    },
  };
  return {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      Plugins: { DenextBack: plugin },
    },
    fire: (event: string, payload?: unknown) => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(payload);
    },
  };
}

Deno.test("predictive back: the preview follows progress; commit pops once, cancel restores", async () => {
  resetBackForTesting();
  const shell = androidShell();
  await withGlobals({ Capacitor: shell.Capacitor, document: new FakeDocument() }, async () => {
    const { container } = docWithData({});
    const root = createRoot(container as Any);
    const pops: Array<[number, boolean]> = [];
    const a = h("p", null, "A");
    const render = (withB = true) =>
      root.render(h(StackView, {
        entries: withB ? [entry("a", a), entry("b", h("p", null, "B"))] : [entry("a", a)],
        onPop: (i: number, how: { animated: boolean }) => pops.push([i, how.animated]),
        platform: "android",
      }));
    render();
    await settle();

    shell.fire("backStarted", { progress: 0, swipeEdge: "left" });
    await settle();
    const [below, top] = findAll(container, "data-dnx-screen");
    assert(shown(below), "the screen below is revealed for the preview");
    shell.fire("backProgressed", { progress: 0.5, swipeEdge: "left" });
    assertStringIncludes(
      (top.style as Any).transform,
      "scale(0.95)",
      "the top screen shrinks with progress",
    );

    shell.fire("backCancelled");
    await settle();
    assertEquals(pops, [], "a cancelled gesture pops nothing");
    assert(!shown(findAll(container, "data-dnx-screen")[0]), "the preview is put away");
    assertEquals((top.style as Any).transform, "", "styles cleared");

    shell.fire("backStarted", { progress: 0, swipeEdge: "right" });
    shell.fire("backProgressed", { progress: 0.8, swipeEdge: "right" });
    shell.fire("backInvoked", { canGoBack: true });
    await settle();
    assertEquals(pops, [[0, false]], "the commit pops once (the back handler does not pop again)");

    // The pop lands (the owner drops the screen), then a new screen is pushed.
    render(false);
    await settle();
    render(true);
    await settle();

    // A plain back press (no gesture): the back handler pops, animated.
    pops.length = 0;
    shell.fire("backInvoked", { canGoBack: true });
    await settle();
    assertEquals(pops, [[0, true]]);
    root.unmount();
  });
  resetBackForTesting();
});

// ---- StackLayout: history sync --------------------------------------------------------------

Deno.test("StackLayout: push stamps history; back is claimed at once with title and data restored", async () => {
  const hist = fakeHistory("/items");
  const pages: Record<string, { inc: () => void; instance: number }> = {};
  const List = makePage("List", pages);
  const Item = makePage("Item", pages);
  const { doc, container, island } = docWithData({
    pathname: "/items",
    screenOptions: { title: "Items", headerShown: true },
  });
  (doc as Any).title = "Items";
  await withGlobals({ document: doc, location: hist.location, history: hist.history }, async () => {
    const root = createRoot(container as Any);
    const list = h(List, null);
    const render = (children: unknown) => {
      root.render(
        h(StackLayout, { base: "/items", platform: "ios", ancestors: false }, children as never),
      );
      flushSync();
    };
    render(list);
    await settle();
    pages.List.inc();
    flushSync();
    assertEquals(readStamp(hist.history.state, "/items")?.index, 0, "the first entry is stamped");

    // The router pushes /items/1 and renders its page (what a soft navigation does).
    hist.history.pushState({}, "", "/items/1");
    island.textContent = JSON.stringify({
      pathname: "/items/1",
      screenOptions: { title: "Item 1", headerShown: true },
    });
    (doc as Any).title = "Item 1";
    render(h(Item, null));
    await settle();
    const stamp = readStamp(hist.history.state, "/items");
    assertEquals(stamp?.index, 1);
    assertEquals(stamp?.entries.map((e) => e.key), ["/items", "/items/1"]);
    const back = findAll(container, "data-dnx-back")[0];
    assertEquals(
      back.getAttribute("href"),
      "/items",
      "the header's back is a real link (no-JS back)",
    );
    assertStringIncludes(back.textContent, "Items", "the iOS back label is the title below");

    // Browser back: claimed before the router refetches anything.
    hist.history.back();
    await settle(5);
    const sections = findAll(container, "data-dnx-screen");
    assertEquals(sections.length, 1, "the item screen is popped");
    assertStringIncludes(
      container.textContent,
      "List:1#1",
      "the kept list, same state and instance",
    );
    assertEquals((doc as Any).title, "Items", "the kept title is back");
    assertEquals(JSON.parse(island.textContent).pathname, "/items", "and its hydration data");
    assertEquals(hist.refetches, [], "the claimed pop skips the router's refetch");
    root.unmount();
  });
});

Deno.test("StackLayout: a deep link writes its ancestors into history so back works", async () => {
  const hist = fakeHistory("/items/42/comments");
  const { doc, container } = docWithData({
    pathname: "/items/42/comments",
    screenOptions: { headerShown: true },
  });
  await withGlobals({ document: doc, location: hist.location, history: hist.history }, async () => {
    const root = createRoot(container as Any);
    root.render(
      h(StackLayout, { base: "/items", platform: "android" }, h("p", null, "comments") as never),
    );
    await settle();
    assertEquals(hist.entries.map((e) => e.url), ["/items", "/items/42", "/items/42/comments"]);
    assertEquals(hist.index(), 2);
    assertEquals(readStamp(hist.entries[1].state, "/items")?.entries.length, 2);
    assertEquals(findAll(container, "data-dnx-screen").length, 1, "only the linked screen renders");
    assertEquals(findAll(container, "data-dnx-back")[0]?.getAttribute("href"), "/items/42");
    root.unmount();
  });
});

Deno.test("StackLayout: a reload rebuilds the stack from the entry's stamp (screens below unloaded)", async () => {
  const hist = fakeHistory("/items/1");
  hist.history.replaceState({
    __dnxStack: {
      "/items": {
        base: "/items",
        index: 1,
        entries: [{ id: "s0", key: "/items", href: "/items" }, {
          id: "s1",
          key: "/items/1",
          href: "/items/1",
        }],
      },
    },
  }, "");
  const { doc, container } = docWithData({
    pathname: "/items/1",
    screenOptions: { headerShown: true },
  });
  await withGlobals({ document: doc, location: hist.location, history: hist.history }, async () => {
    const root = createRoot(container as Any);
    root.render(
      h(
        StackLayout,
        { base: "/items", platform: "ios", ancestors: false },
        h("p", null, "one") as never,
      ),
    );
    await settle();
    assertEquals(hist.entries.length, 1, "history is not rewritten on a reload");
    assertEquals(findAll(container, "data-dnx-back")[0]?.getAttribute("href"), "/items");
    root.unmount();
  });
});

Deno.test("StackLayout in a tab: registers so a re-tap pops to its root", async () => {
  const hist = fakeHistory("/home/a");
  hist.history.replaceState({
    __dnxStack: {
      "/home": {
        base: "/home",
        index: 1,
        entries: [{ id: "s0", key: "/home", href: "/home" }, {
          id: "s1",
          key: "/home/a",
          href: "/home/a",
        }],
      },
    },
  }, "");
  const { doc, container } = docWithData({ pathname: "/home/a" });
  await withGlobals({ document: doc, location: hist.location, history: hist.history }, async () => {
    const scope = createTabScope();
    const root = createRoot(container as Any);
    root.render(h(
      navigationContexts().tab,
      { value: scope },
      h(StackLayout, { base: "/home", ancestors: false }, h("p", null, "a") as never),
    ));
    await settle();
    assertEquals(scope.handles.size, 1);
    assertEquals(reselectTab(scope.handles, () => false), "popToTop");
    assertEquals(hist.log.at(-1), "go -1", "popToTop goes back through history");
    root.unmount();
    assertEquals(scope.handles.size, 0, "unregistered on unmount");
  });
});

// ---- tabs ----------------------------------------------------------------------------------

Deno.test("tabFor / reselectTab", () => {
  const tabs = [
    { name: "home", href: "/", title: "Home" },
    { name: "inbox", href: "/inbox", title: "Inbox" },
    { name: "archive", href: "/inbox/archive", title: "Archive" },
  ];
  assertEquals(tabFor(tabs, "/inbox/3")?.name, "inbox");
  assertEquals(tabFor(tabs, "/inbox/archive/1")?.name, "archive", "the longest match wins");
  assertEquals(tabFor(tabs, "/")?.name, "home");
  assertEquals(
    tabFor(tabs, "/elsewhere")?.name,
    "home",
    "unknown paths fall back to the first tab",
  );

  const calls: string[] = [];
  const handle = (back: boolean, scrolled: boolean) => ({
    canGoBack: () => back,
    popToTop: () => void calls.push("pop"),
    scrollToTop: () => (calls.push("scroll"), scrolled),
  });
  assertEquals(reselectTab([handle(true, false)], () => false), "popToTop");
  assertEquals(reselectTab([handle(false, true)], () => false), "scrollToTop");
  assertEquals(reselectTab([handle(false, false)], () => true), "scrollToTop", "the panel scrolls");
  assertEquals(reselectTab([], () => false), "none");
});

Deno.test("TabsView keeps a hidden tab's state; badges and ARIA", async () => {
  const pages: Record<string, { inc: () => void; instance: number }> = {};
  const Home = makePage("Home", pages);
  const Inbox = makePage("Inbox", pages);
  const { container } = docWithData({});
  const root = createRoot(container as Any);
  const tabs = [
    { name: "home", href: "/home", title: "Home" },
    { name: "inbox", href: "/inbox", title: "Inbox", badge: 3 },
  ];
  const home = h(Home, null);
  const inbox = h(Inbox, null);
  const render = (active: string) => {
    root.render(h(TabsView, {
      tabs,
      active,
      panels: new Map([["home", home], ["inbox", inbox]]),
      onTabPress: () => {},
      platform: "ios",
    }));
    flushSync();
  };
  render("home");
  pages.Home.inc();
  flushSync();
  render("inbox");
  await settle();
  const panels = findAll(container, "role", "tabpanel");
  assert(!shown(panels[0]) && shown(panels[1]));
  render("home");
  await settle();
  assertStringIncludes(container.textContent, "Home:1#1", "state and instance survive the switch");
  const tabEls = findAll(container, "role", "tab");
  assertEquals(tabEls.map((t) => t.getAttribute("aria-selected")), ["true", "false"]);
  assertEquals(findAll(container, "data-dnx-tab-badge")[0].textContent, "3");
  root.unmount();
});

Deno.test("TabsLayout: a press on a visited tab shows it at once, before the router answers", async () => {
  const hist = fakeHistory("/home");
  const { doc, container } = docWithData({ pathname: "/home" });
  const fetchStub = () => new Promise<Response>(() => {}); // the router's fetch never answers here
  await withGlobals({
    document: doc,
    location: hist.location,
    history: hist.history,
    fetch: fetchStub,
  }, async () => {
    const root = createRoot(container as Any);
    const tabs = [
      { name: "home", href: "/home", title: "Home" },
      { name: "search", href: "/search", title: "Search" },
    ];
    const render = (children: unknown) => {
      root.render(h(TabsLayout, { tabs, platform: "android" }, children as never));
      flushSync();
    };
    render(h("p", null, "home page"));
    hist.history.pushState({}, "", "/search");
    render(h("p", null, "search page"));
    await settle();
    let panels = findAll(container, "role", "tabpanel");
    assertEquals(panels.length, 2, "the visited tab stays mounted");
    assert(!shown(panels[0]) && shown(panels[1]));

    findAll(container, "data-dnx-tab", "home")[0].dispatch("click", { button: 0 });
    await settle();
    panels = findAll(container, "role", "tabpanel");
    assert(shown(panels[0]) && !shown(panels[1]), "home is shown before any response");
    root.unmount();
  });
});

// ---- sheet ---------------------------------------------------------------------------------

Deno.test("attachSheetDrag: drag between detents, fling to dismiss, hand off to content scroll", () => {
  const make = () => {
    const l = new Map<string, (e: Any) => void>();
    return {
      l,
      addEventListener: (t: string, fn: (e: Any) => void) => l.set(t, fn),
      removeEventListener: (t: string) => l.delete(t),
      contains: (n: unknown) => n === "inside",
    };
  };
  const panel = make();
  const scroller = make();
  let largest = false;
  let atTop = true;
  const follows: number[] = [];
  const releases: Array<number | "dismiss"> = [];
  attachSheetDrag(panel, scroller, {
    metrics: () => ({ heights: [400, 800], height: largest ? 800 : 400, dismissible: true }),
    scrollerAtTop: () => atTop,
    atLargest: () => largest,
    follow: (h) => follows.push(Math.round(h)),
    release: (r) => releases.push(r),
  });
  const p = (t: string, y: number, ts: number, target = "outside") =>
    panel.l.get(t)!({ pointerId: 1, clientY: y, timeStamp: ts, target, button: 0 });

  // Up from medium, slowly: settles at large.
  p("pointerdown", 600, 0);
  p("pointermove", 500, 300);
  p("pointermove", 250, 800);
  p("pointerup", 250, 900);
  assertEquals(follows, [500, 750]);
  assertEquals(releases, [1]);

  // A hard fling down from medium: dismiss.
  p("pointerdown", 600, 1000);
  p("pointermove", 640, 1010);
  p("pointermove", 700, 1030);
  p("pointerup", 700, 1035);
  assertEquals(releases.at(-1), "dismiss");

  // At large, over scrolled content: the content keeps the drag.
  largest = true;
  atTop = false;
  follows.length = 0;
  p("pointerdown", 300, 2000, "inside");
  p("pointermove", 360, 2050, "inside");
  p("pointerup", 360, 2100, "inside");
  assertEquals(follows, [], "no sheet movement while the content scrolls");

  // At large, content at its top, dragging down: the sheet moves, the browser pan is cancelled.
  atTop = true;
  let prevented = 0;
  p("pointerdown", 300, 3000, "inside");
  p("pointermove", 380, 3050, "inside");
  scroller.l.get("touchmove")!({ cancelable: true, preventDefault: () => prevented++ });
  assert(follows.length > 0, "the sheet follows");
  assertEquals(prevented, 1);
  p("pointerup", 380, 3100, "inside");
});

Deno.test("Sheet: dialog semantics, backdrop dismissal, exit on close", async () => {
  const { container } = docWithData({});
  const root = createRoot(container as Any);
  const changes: boolean[] = [];
  let exited = 0;
  const render = (open: boolean) => {
    root.render(h(Sheet, {
      open,
      portal: false,
      detents: ["medium", "large"],
      "aria-label": "Filters",
      onOpenChange: (o: boolean) => changes.push(o),
      onExitComplete: () => exited++,
    }, h("button", null, "Apply")));
    flushSync();
  };
  render(true);
  await settle();
  const dialog = findAll(container, "role", "dialog")[0];
  assert(dialog, "renders a dialog");
  assertEquals(dialog.getAttribute("aria-modal"), "true");
  assertEquals(dialog.getAttribute("aria-label"), "Filters");
  assertEquals(dialog.getAttribute("data-detent"), "0");
  assert(findAll(container, "aria-label", "Sheet grabber").length === 1, "a grabber button");

  findAll(container, "data-dnx-sheet-backdrop")[0].dispatch("click");
  assertEquals(changes, [false], "the backdrop asks to close");

  render(false);
  await settle();
  assertEquals(exited, 1, "the exit completes");
  assertEquals(findAll(container, "role", "dialog").length, 0, "and it is gone");
  root.unmount();
});

Deno.test("trapFocusTarget keeps Tab inside the sheet", () => {
  const panel = "panel";
  const items = ["a", "b", "c"];
  assertEquals(
    trapFocusTarget(items, "c", false, panel),
    "a",
    "Tab from the last wraps to the first",
  );
  assertEquals(trapFocusTarget(items, "a", true, panel), "c", "Shift+Tab from the first wraps");
  assertEquals(trapFocusTarget(items, panel, true, panel), "c");
  assertEquals(trapFocusTarget(items, "b", false, panel), null, "inside: the browser moves it");
  assertEquals(
    trapFocusTarget(items, "outside", false, panel),
    "a",
    "focus that escaped comes back",
  );
  assertEquals(trapFocusTarget([], "x", false, panel), panel);
});

// ---- React Navigation / Expo Router adapters ----------------------------------------------

/** A React Navigation core faked just enough for the navigators. */
function fakeCore(state: Any, options: Record<string, Record<string, unknown>>) {
  const dispatched: unknown[] = [];
  const emitted: unknown[] = [];
  const core: ReactNavigationCore = {
    createNavigatorFactory: (Navigator) => () => ({ Navigator }),
    useNavigationBuilder: () => ({
      state,
      descriptors: Object.fromEntries(state.routes.map((r: Any) => [r.key, {
        options: options[r.key] ?? {},
        render: () => h("p", null, `screen ${r.name}`),
      }])),
      navigation: {
        dispatch: (a: unknown) => void dispatched.push(a),
        emit: (e: unknown) => (emitted.push(e), { defaultPrevented: false }),
      },
      NavigationContent: ({ children }: { children?: unknown }) => children as never,
    }),
    StackRouter: {},
    TabRouter: {},
    StackActions: {
      pop: (count = 1) => ({ type: "POP", payload: { count } }),
      popToTop: () => ({ type: "POP_TO_TOP" }),
    },
    TabActions: { jumpTo: (name: string) => ({ type: "JUMP_TO", payload: { name } }) },
  };
  return { core, dispatched, emitted };
}

Deno.test("createNativeStackNavigatorFactory: routes become screens; back dispatches a pop", async () => {
  const state = {
    key: "stack-1",
    index: 1,
    routes: [{ key: "r0", name: "index" }, { key: "r1", name: "detail" }],
  };
  const { core, dispatched } = fakeCore(state, {
    r0: { title: "Home" },
    r1: { title: "Detail", headerRight: () => h("span", null, "edit") },
  });
  const { container } = docWithData({});
  const root = createRoot(container as Any);
  const { Navigator } = (createNativeStackNavigatorFactory(core) as Any)();
  root.render(h(Navigator, {}));
  await settle();
  assertEquals(findAll(container, "data-dnx-screen").length, 2);
  assertStringIncludes(container.textContent, "edit", "a function headerRight is rendered");
  const back = findAll(container, "data-dnx-back")[0];
  back.dispatch("click", { button: 0 });
  assertEquals(dispatched, [{ type: "POP", payload: { count: 1 }, target: "stack-1" }]);
  root.unmount();
});

Deno.test("mapStackOptions translates native-stack options", () => {
  const o = mapStackOptions({
    title: "T",
    presentation: "pageSheet",
    sheetAllowedDetents: "fitToContents",
    animation: "fade",
    gestureEnabled: false,
    headerLeft: ({ canGoBack }: { canGoBack: boolean }) => (canGoBack ? "back" : "none"),
  }, { canGoBack: true });
  assertEquals(o.presentation, "formSheet");
  assertEquals(o.sheetAllowedDetents, ["fit"]);
  assertEquals(o.animation, "fade");
  assertEquals(o.gestureEnabled, false);
  assertEquals(o.headerShown, true, "native-stack shows its header by default");
  assertEquals(o.headerLeft, "back");
  assertEquals(
    mapStackOptions({ presentation: "fullScreenModal" }, { canGoBack: false }).presentation,
    "modal",
  );
  assertEquals(
    mapStackOptions({ sheetAllowedDetents: [0.3, 1] }, { canGoBack: false }).sheetAllowedDetents,
    [0.3, 1],
  );
});

Deno.test("createBottomTabNavigatorFactory: badges, jumpTo on press, tabPress on the active tab", async () => {
  const state = {
    key: "tabs-1",
    index: 0,
    routes: [{ key: "t0", name: "home" }, { key: "t1", name: "inbox" }],
  };
  const { core, dispatched, emitted } = fakeCore(state, { t1: { title: "Inbox", tabBarBadge: 2 } });
  const { container } = docWithData({});
  const root = createRoot(container as Any);
  const { Navigator } = (createBottomTabNavigatorFactory(core) as Any)();
  root.render(h(Navigator, {}));
  await settle();
  assertEquals(findAll(container, "data-dnx-tab-badge")[0].textContent, "2");
  const [home, inbox] = findAll(container, "role", "tab");
  assertEquals(inbox.tagName, "BUTTON", "no URL: a button");
  inbox.dispatch("click", { button: 0, preventDefault: () => {} });
  assertEquals(dispatched, [{ type: "JUMP_TO", payload: { name: "inbox" }, target: "tabs-1" }]);
  home.dispatch("click", { button: 0, preventDefault: () => {} });
  assertEquals(dispatched.length, 1, "the active tab does not jump");
  assertEquals(emitted.length, 2, "both presses emit tabPress (a nested stack pops on it)");
  root.unmount();
});

Deno.test("expo-router adapter source overrides Stack / Tabs and keeps the rest", () => {
  const src = expoRouterNavigatorsSource("expo-router");
  assertStringIncludes(src, `export * from "expo-router?denext-real";`);
  assertStringIncludes(
    src,
    "export const Stack = Object.assign(__withLayoutContext(__stack(__core)().Navigator)",
  );
  assertStringIncludes(src, "export const Tabs = ");
  assertStringIncludes(src, `from "denext/navigation"`);
  const stackOnly = expoRouterNavigatorsSource("expo-router/stack");
  assert(!stackOnly.includes("export const Tabs"));
  assertStringIncludes(stackOnly, "export default Stack;");
  assertStringIncludes(expoRouterNavigatorsSource("expo-router/tabs"), "export default Tabs;");
});

Deno.test("diffEntries / visibleIds: what a change is, and what stays drawn under overlays", () => {
  const a = entry("a", "A");
  const b = entry("b", "B");
  const c = entry("c", "C");
  assertEquals(diffEntries([a], [a, b])?.kind, "push");
  const pop = diffEntries([a, b, c], [a]);
  assertEquals(pop?.kind, "pop");
  assertEquals(pop?.popped.map((e) => e.id), ["b", "c"]);
  assertEquals(diffEntries([a, b], [a, c])?.kind, "push", "a replace slides in like a push");
  assertEquals(diffEntries([a, b], [a, b]), null);

  const sheet = entry("s", "S", { presentation: "formSheet" });
  const glass = entry("t", "T", { presentation: "transparentModal" });
  const ids = (list: StackViewEntry[]) => [...visibleIds(list, (e) => e.options)].sort();
  assertEquals(ids([a, b]), ["b"], "a card hides what is under it");
  assertEquals(ids([a, b, sheet]), ["b", "s"], "a sheet leaves the screen below visible");
  assertEquals(ids([a, glass, sheet]), ["a", "s", "t"], "overlays stack their see-through");
  assertEquals(ids([entry("p", undefined), b]), ["b"]);
});

Deno.test("expoRouterNavigatorsPlugin: app imports get the adapter; expo-router's own get the real one", async () => {
  const resolvers: Array<{ filter: RegExp; fn: (a: Any) => unknown }> = [];
  let loader: ((a: Any) => Any) | null = null;
  const resolved: Any[] = [];
  const build = {
    onResolve: (o: { filter: RegExp }, fn: (a: Any) => unknown) =>
      resolvers.push({ filter: o.filter, fn }),
    onLoad: (_o: unknown, fn: (a: Any) => Any) => void (loader = fn),
    resolve: (
      path: string,
      opts: Any,
    ) => {
      resolved.push({ path, opts });
      // expo-router 55+'s own React Navigation copy is absent here: the core falls back.
      const missing = path === "expo-router/build/react-navigation/native";
      return Promise.resolve({ path: `/nm/${path}`, errors: missing ? [{ text: "no" }] : [] });
    },
  };
  expoRouterNavigatorsPlugin().setup(build as Any);
  const resolve = (path: string, importer: string, pluginData?: unknown) => {
    const r = resolvers.find((x) => x.filter.test(path));
    return r?.fn({ path, importer, resolveDir: "/app", kind: "import-statement", pluginData });
  };
  const app = resolve("expo-router", "/app/app/_layout.tsx") as Any;
  assertEquals(app.namespace, "denext-expo-router-navigators");
  assertEquals(resolve("expo-router", "/app/node_modules/expo-router/build/index.js"), undefined);
  assertEquals(resolve("expo-router", "/app/x.ts", { "denext-real": true }), undefined);
  assertEquals(
    resolve("expo-router/_ctx", "/app/x.ts"),
    undefined,
    "the route context is not ours",
  );
  const real = await resolve("expo-router/stack?denext-real", "/app/gen.js") as Any;
  assertEquals(real.path, "/nm/expo-router/stack");
  assertEquals(resolved[0].opts.pluginData, { "denext-real": true });
  // A generated module's imports resolve as from a file in the app's folder.
  assertEquals(resolved[0].opts.namespace, "file");
  const core = await resolvers.find((x) => x.filter.test("denext-expo-router-core"))!.fn({
    path: "denext-expo-router-core",
    importer: "expo-router",
    namespace: "denext-expo-router-navigators",
    resolveDir: "/app",
    kind: "import-statement",
  }) as Any;
  assertEquals(core.path, "/nm/@react-navigation/native");
  assertEquals(resolved.slice(1).map((r) => r.path), [
    "expo-router/build/react-navigation/native",
    "@react-navigation/native",
  ]);
  // The host path esbuild resolves from (a `\` path on Windows).
  assertEquals(resolved[1].opts.importer, join("/app", "denext-generated.js"));
  const loaded = loader!({ path: "expo-router/tabs", pluginData: { resolveDir: "/app" } });
  assertEquals(loaded.resolveDir, "/app");
  assertStringIncludes(loaded.contents, "export default Tabs;");
});
