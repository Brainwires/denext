// denext/navigation's history-router bindings on the in-memory DOM: HistoryStack over a
// memory HistorySource (push keeps the screen below with its state, each screen renders from
// its own pinned location, back / forward / replace move the stack exactly by the entry index,
// the swipe and the header pop through history without a second animation, a deep link's
// ancestors are stacked and popped to by a replace, per-screen options and setOptions),
// HistoryTabs, the TanStack Router / React Router / browser sources, the screen path matcher,
// and the full-screen back swipe (anywhere, the 1.4× lock, the 72 px fling floor, and the
// `data-dnx-no-back-swipe` yield).

import "./helpers/activity-runtime.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { useState } from "../src/runtime/hooks.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";
import {
  type HistoryScreen,
  HistoryStack,
  resolveScreen,
  useScreenMatch,
} from "../src/navigation/history-stack.ts";
import { HistoryTabs } from "../src/navigation/history-tabs.ts";
import {
  browserHistory,
  type HistorySource,
  matchScreenPath,
  reactRouterHistory,
  tanstackHistory,
} from "../src/navigation/history-source.ts";
import { useStackNavigation } from "../src/navigation/stack-layout.ts";
import { attachEdgeSwipe, StackView } from "../src/navigation/stack-view.ts";
import { lockAxis, releaseSwipe } from "../src/navigation/gesture.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

/** Let effects, promise callbacks and 0 ms timers run. */
async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, ms));
    flushSync();
  }
}

/** A memory history: an entry list, an index, and a log of what the stack asked for. */
function memorySource(start: string, indexed = true) {
  const entries = [start];
  let index = 0;
  const listeners = new Set<() => void>();
  const log: string[] = [];
  const notify = () => [...listeners].forEach((l) => l());
  const source: HistorySource = {
    location() {
      const u = new URL(entries[index], "http://app.test");
      return {
        pathname: u.pathname,
        search: u.search,
        hash: u.hash,
        index: indexed ? index : undefined,
      };
    },
    subscribe(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    push(href) {
      entries.splice(index + 1);
      entries.push(href);
      index++;
      log.push(`push ${href}`);
      notify();
    },
    replace(href) {
      entries[index] = href;
      log.push(`replace ${href}`);
      notify();
    },
    go(delta) {
      log.push(`go ${delta}`);
      index = Math.max(0, Math.min(entries.length - 1, index + delta));
      notify();
    },
  };
  return { source, log, entries, at: () => entries[index] };
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

let instances = 0;
const counters: Record<string, () => void> = {};

/** The list screen: a counter (its state must survive a push). */
function List(): VNode {
  const [n, setN] = useState(0);
  const [instance] = useState(() => ++instances);
  counters.list = () => setN((x) => x + 1);
  return h("p", { "data-page": "list" }, `list:${n}#${instance}`);
}

/** A thread screen: renders its OWN pinned param. */
function Thread(): VNode {
  const match = useScreenMatch();
  const nav = useStackNavigation();
  counters.title = () => nav.setOptions({ title: `T${match?.params.id}` });
  return h("p", { "data-page": "thread" }, `thread:${match?.params.id}${match?.search ?? ""}`);
}

const SCREENS: HistoryScreen[] = [
  { path: "/", render: () => h(List, null), options: { title: "Threads" } },
  {
    path: "/t/$id",
    render: () => h(Thread, null),
    options: (m) => ({ title: `Thread ${m.params.id}` }),
  },
  {
    path: "/t/:id/diff",
    render: (m) => h("p", { "data-page": "diff" }, `diff:${m.params.id}`),
    options: { presentation: "formSheet" },
  },
];

/** Mount a HistoryStack over `source`. */
function mount(source: HistorySource, extra: Record<string, unknown> = {}) {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  const render = () =>
    root.render(h(HistoryStack, { history: source, screens: SCREENS, platform: "ios", ...extra }));
  render();
  flushSync();
  return { root, container, render };
}

Deno.test("matchScreenPath / resolveScreen: params, TanStack $params, splats, first match", () => {
  assertEquals(matchScreenPath("/t/$id", "/t/42"), { id: "42" });
  assertEquals(matchScreenPath("/t/:id", "/t/a%20b"), { id: "a b" });
  assertEquals(matchScreenPath("/t/$id", "/t/42/diff"), null);
  assertEquals(matchScreenPath("/", "/"), {});
  assertEquals(matchScreenPath("/files/*", "/files/a/b.ts"), { "*": "a/b.ts", _splat: "a/b.ts" });
  assertEquals(matchScreenPath("/files/$", "/files"), { "*": "", _splat: "" });
  const hit = resolveScreen(SCREENS, { pathname: "/t/7", search: "?q=1", hash: "" });
  assertEquals(hit?.match.href, "/t/7?q=1");
  assertEquals(hit?.screen, SCREENS[1]);
  assertEquals(resolveScreen(SCREENS, { pathname: "/nope", search: "", hash: "" }), null);
});

Deno.test("HistoryStack: push keeps the screen below; each screen renders its own location", async () => {
  const mem = memorySource("/");
  const { root, container } = mount(mem.source);
  await settle();
  counters.list();
  counters.list();
  await settle();
  mem.source.push("/t/1");
  await settle();
  let screens = findAll(container, "data-dnx-screen");
  assertEquals(screens.length, 2, "the list stays mounted under the thread");
  assert(!shown(screens[0]) && shown(screens[1]));
  assertStringIncludes(container.textContent, "thread:1");

  mem.source.push("/t/2");
  await settle();
  screens = findAll(container, "data-dnx-screen");
  assertEquals(screens.length, 3);
  assertStringIncludes(screens[1].textContent, "thread:1", "the kept thread keeps ITS id");
  assertStringIncludes(screens[2].textContent, "thread:2");

  mem.source.go(-2);
  await settle(20);
  screens = findAll(container, "data-dnx-screen");
  assertEquals(screens.length, 1, "a back two entries pops two screens");
  assertStringIncludes(container.textContent, "list:2#", "same list instance, same state");
  assertEquals(container.textContent.match(/#(\d+)/)?.[1], String(instances));

  mem.source.go(1);
  await settle(20);
  assertEquals(findAll(container, "data-dnx-screen").length, 2, "forward pushes again");
  assertStringIncludes(container.textContent, "thread:1");
  root.unmount();
});

Deno.test("HistoryStack: a replace swaps the top; a search change updates it in place", async () => {
  const mem = memorySource("/t/1");
  const { root, container } = mount(mem.source, { ancestors: false });
  await settle();
  mem.source.push("/t/2");
  await settle();
  mem.source.replace("/t/3");
  await settle();
  let screens = findAll(container, "data-dnx-screen");
  assertEquals(screens.length, 2);
  assertStringIncludes(screens[1].textContent, "thread:3");
  mem.source.push("/t/3?tab=files");
  await settle();
  screens = findAll(container, "data-dnx-screen");
  assertEquals(screens.length, 2, "same route key: updated, not pushed");
  assertStringIncludes(screens[1].textContent, "thread:3?tab=files");
  root.unmount();
});

Deno.test("HistoryStack: the swipe pops through history once, not animated again", async () => {
  const mem = memorySource("/");
  const { root, container } = mount(mem.source);
  await settle();
  mem.source.push("/t/1");
  await settle();
  const stack = findAll(container, "data-dnx-stack")[0];
  const fire = (t: string, x: number, ts: number) =>
    stack.dispatch(t, {
      pointerId: 5,
      pointerType: "touch",
      clientX: x,
      clientY: 200,
      timeStamp: ts,
      target: stack,
    });
  // Mid-screen, not at the edge: the full-screen swipe is on by default.
  fire("pointerdown", 150, 0);
  fire("pointermove", 170, 16);
  fire("pointermove", 380, 400);
  fire("pointerup", 380, 420);
  await settle(20);
  assertEquals(mem.log, ["push /t/1", "go -1"]);
  assertEquals(findAll(container, "data-dnx-screen").length, 1);
  assertStringIncludes(container.textContent, "list:");
  root.unmount();
});

Deno.test("HistoryStack: a deep link stacks its ancestors; the swipe back to one replaces the entry", async () => {
  const mem = memorySource("/t/9");
  const { root, container } = mount(mem.source);
  await settle(20);
  const screens = findAll(container, "data-dnx-screen");
  assertEquals(screens.length, 2, "the list is mounted (hidden) under the deep link");
  assert(!shown(screens[0]) && shown(screens[1]));
  const stack = findAll(container, "data-dnx-stack")[0];
  let t = 0;
  const fire = (type: string, x: number) =>
    stack.dispatch(type, {
      pointerId: 6,
      pointerType: "touch",
      clientX: x,
      clientY: 200,
      timeStamp: t += 200,
      target: stack,
    });
  fire("pointerdown", 100);
  fire("pointermove", 120);
  fire("pointermove", 390);
  fire("pointerup", 390);
  await settle(20);
  assertEquals(mem.log, ["replace /"], "the ancestor has no entry of its own: a replace");
  assertEquals(findAll(container, "data-dnx-screen").length, 1);
  assertStringIncludes(container.textContent, "list:");
  root.unmount();
});

Deno.test("HistoryStack: useStackNavigation pops a deep link to its ancestor through a replace", async () => {
  const mem = memorySource("/t/9");
  let nav: ReturnType<typeof useStackNavigation> | null = null;
  const screens: HistoryScreen[] = [
    SCREENS[0],
    {
      path: "/t/$id",
      render: () => {
        const Probe = () => {
          nav = useStackNavigation();
          return h("p", null, "deep");
        };
        return h(Probe, null);
      },
    },
  ];
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  root.render(h(HistoryStack, { history: mem.source, screens, platform: "ios" }));
  await settle();
  assert(nav!.canGoBack, "the ancestor is below");
  nav!.pop();
  await settle(20);
  assertEquals(mem.log, ["replace /"]);
  assertEquals(mem.entries, ["/"]);
  assertEquals(findAll(container, "data-dnx-screen").length, 1);
  assertStringIncludes(container.textContent, "list:");
  nav = null;
  root.unmount();
});

Deno.test("HistoryStack: options per screen, setOptions, and a formSheet presentation", async () => {
  const mem = memorySource("/");
  const { root, container } = mount(mem.source, { screenOptions: { headerShown: true } });
  await settle();
  mem.source.push("/t/4");
  await settle();
  assertStringIncludes(container.textContent, "Thread 4", "the options function's title");
  counters.title();
  await settle();
  assertStringIncludes(container.textContent, "T4", "setOptions from the screen");
  mem.source.push("/t/4/diff");
  await settle();
  assertStringIncludes(container.textContent, "diff:4");
  const sections = findAll(container, "data-dnx-screen");
  assertEquals(sections.length, 2, "the sheet is not a card");
  assert(shown(sections[1]), "the thread stays drawn under the sheet");
  root.unmount();
});

Deno.test("HistoryStack: without entry indices it goes by the routes it holds", async () => {
  const mem = memorySource("/", false);
  const { root, container } = mount(mem.source);
  await settle();
  mem.source.push("/t/1");
  await settle();
  mem.source.push("/");
  await settle();
  assertEquals(findAll(container, "data-dnx-screen").length, 1, "a link to the list pops to it");
  root.unmount();
});

Deno.test("HistoryTabs: the location picks the tab; visited tabs stay; a press pushes the last href", async () => {
  const mem = memorySource("/a");
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  let aCount: (() => void) | null = null;
  const A = () => {
    const [n, setN] = useState(0);
    aCount = () => setN((x) => x + 1);
    return h("p", null, `tabA:${n}`);
  };
  root.render(h(HistoryTabs, {
    history: mem.source,
    platform: "ios",
    tabs: [
      { name: "a", href: "/a", title: "A", render: () => h(A, null) },
      { name: "b", href: "/b", title: "B", render: () => h("p", null, "tabB") },
    ],
  }));
  await settle();
  aCount!();
  await settle();
  mem.source.push("/b");
  await settle();
  assertStringIncludes(container.textContent, "tabB");
  assertStringIncludes(container.textContent, "tabA:1", "the visited tab is kept (hidden)");
  const buttons = findAll(container, "role", "tab");
  const tabA = buttons.find((b) => b.textContent.includes("A"))!;
  tabA.dispatch("click", { button: 0, preventDefault: () => {}, currentTarget: tabA });
  await settle();
  assertEquals(mem.log.at(-1), "push /a");
  root.unmount();
});

Deno.test("tanstackHistory: router.navigate for navigations, history for the rest, __TSR_index", () => {
  const calls: unknown[] = [];
  let listener: (() => void) | null = null;
  const history = {
    location: { pathname: "/t/1", search: "?x=1", hash: "", state: { __TSR_index: 4 } },
    subscribe: (fn: () => void) => {
      listener = fn;
      return () => void (listener = null);
    },
    push: (p: string) => calls.push(["push", p]),
    replace: (p: string) => calls.push(["replace", p]),
    go: (n: number) => calls.push(["go", n]),
  };
  const router = { history, navigate: (o: unknown) => calls.push(["navigate", o]) };
  const viaRouter = tanstackHistory(router);
  assertEquals(viaRouter.location(), { pathname: "/t/1", search: "?x=1", hash: "", index: 4 });
  viaRouter.push("/t/2");
  viaRouter.replace("/t/3");
  viaRouter.go(-1);
  let heard = 0;
  const off = viaRouter.subscribe(() => heard++);
  listener!();
  off();
  assertEquals(heard, 1);
  const bare = tanstackHistory(history);
  bare.push("/a");
  bare.replace("/b");
  assertEquals(calls, [
    ["navigate", { href: "/t/2", replace: false }],
    ["navigate", { href: "/t/3", replace: true }],
    ["go", -1],
    ["push", "/a"],
    ["replace", "/b"],
  ]);
});

Deno.test("reactRouterHistory: state.location, subscribe and navigate", async () => {
  const calls: unknown[] = [];
  const router = {
    state: { location: { pathname: "/p", search: "", hash: "#h" } },
    subscribe: (fn: () => void) => {
      fn();
      return () => {};
    },
    navigate: (to: unknown, o?: unknown) => calls.push([to, o]),
  };
  await withHistoryState({ idx: 3 }, () => {
    const src = reactRouterHistory(router);
    assertEquals(src.location(), { pathname: "/p", search: "", hash: "#h", index: 3 });
    let n = 0;
    src.subscribe(() => n++);
    assertEquals(n, 1);
    src.push("/q");
    src.replace("/r");
    src.go(-2);
    assertEquals(calls, [["/q", undefined], ["/r", { replace: true }], [-2, undefined]]);
  });
});

/** Run `fn` with a `history` global whose state is `state`. */
async function withHistoryState(state: unknown, fn: () => unknown): Promise<void> {
  const before = Object.getOwnPropertyDescriptor(g, "history");
  Object.defineProperty(g, "history", { configurable: true, value: { state } });
  try {
    await fn();
  } finally {
    if (before) Object.defineProperty(g, "history", before);
    else delete g.history;
  }
}

Deno.test("browserHistory: stamps an index, pushes, replaces, and hears popstate", () => {
  const entries: Array<{ url: string; state: unknown }> = [{ url: "/", state: null }];
  let i = 0;
  const loc = {
    get pathname() {
      return new URL(entries[i].url, "http://a.test").pathname;
    },
    get search() {
      return new URL(entries[i].url, "http://a.test").search;
    },
    hash: "",
    get href() {
      return "http://a.test" + entries[i].url;
    },
  };
  const hist = {
    get state() {
      return entries[i].state;
    },
    pushState(state: unknown, _t: string, url: string) {
      entries.splice(i + 1);
      entries.push({ url, state });
      i++;
    },
    replaceState(state: unknown, _t: string, url: string) {
      entries[i] = { url, state };
    },
    go(n: number) {
      i += n;
      dispatchEvent(new Event("popstate"));
    },
  };
  const saved = {
    location: Object.getOwnPropertyDescriptor(g, "location"),
    history: Object.getOwnPropertyDescriptor(g, "history"),
  };
  Object.defineProperty(g, "location", { configurable: true, value: loc });
  Object.defineProperty(g, "history", { configurable: true, value: hist });
  try {
    const src = browserHistory();
    assertEquals(src.location().index, 0, "the first entry is stamped");
    let heard = 0;
    const off = src.subscribe(() => heard++);
    src.push("/t/1");
    assertEquals(src.location(), { pathname: "/t/1", search: "", hash: "", index: 1 });
    src.replace("/t/2?q");
    assertEquals(src.location().index, 1);
    assertEquals(src.location().search, "?q");
    src.go(-1);
    assertEquals(src.location().index, 0);
    assertEquals(heard, 3, "push, replace and the popstate");
    off();
    src.go(1);
    assertEquals(heard, 3, "unsubscribed");
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
});

Deno.test("full-screen back swipe: starts anywhere, locks at 1.4×, a short fling cancels", () => {
  assertEquals(lockAxis(20, 15, 10, 1.4), "reject", "a diagonal movement stays a scroll");
  assertEquals(lockAxis(20, 12, 10, 1.4), "horizontal");
  assertEquals(releaseSwipe(0.1, 1, { minFlingDistance: 72 }, 40), "cancel", "a short flick");
  assertEquals(releaseSwipe(0.2, 1, { minFlingDistance: 72 }, 80), "commit");

  const listeners = new Map<string, (e: Any) => void>();
  const el = {
    addEventListener: (t: string, fn: (e: Any) => void) => listeners.set(t, fn),
    removeEventListener: (t: string) => listeners.delete(t),
    getBoundingClientRect: () => ({ left: 0, width: 400 }),
    setPointerCapture: () => {},
  };
  const log: string[] = [];
  let full = true;
  attachEdgeSwipe(el, {
    canStart: () => true,
    begin: () => log.push("begin"),
    update: () => {},
    release: (d) => log.push(`release ${d}`),
    abort: () => log.push("abort"),
  }, { fullScreen: () => full });
  const fire = (t: string, x: number, y: number, ts: number) =>
    listeners.get(t)!({
      pointerId: 1,
      pointerType: "touch",
      clientX: x,
      clientY: y,
      timeStamp: ts,
    });
  fire("pointerdown", 200, 300, 0);
  fire("pointermove", 220, 302, 16);
  fire("pointermove", 330, 305, 300);
  fire("pointerup", 330, 305, 320);
  assertEquals(log, ["begin", "release commit"], "mid-screen swipe past halfway commits");
  log.length = 0;
  fire("pointerdown", 200, 300, 1000);
  fire("pointermove", 214, 311, 1016);
  fire("pointerup", 214, 311, 1030);
  assertEquals(log, [], "too diagonal for the full-screen lock");
  full = false;
  fire("pointerdown", 200, 300, 2000);
  fire("pointermove", 260, 300, 2016);
  fire("pointerup", 260, 300, 2030);
  assertEquals(log, [], "edge-only: a mid-screen touch does nothing");
});

Deno.test("StackView: a full-screen swipe yields to data-dnx-no-back-swipe (a swipeable row)", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  const pops: number[] = [];
  root.render(h(StackView, {
    entries: [
      { id: "a", element: h("p", null, "A"), options: {} },
      {
        id: "b",
        element: h("div", { "data-dnx-no-back-swipe": "", "data-row": "" }, "row"),
        options: {},
      },
    ],
    onPop: (i: number) => pops.push(i),
    platform: "ios",
    fullScreenSwipe: true,
  }));
  await settle();
  const stack = findAll(container, "data-dnx-stack")[0];
  const row = findAll(container, "data-row")[0];
  const fire = (t: string, x: number, ts: number, target: FakeElement) =>
    stack.dispatch(t, {
      pointerId: 2,
      pointerType: "touch",
      clientX: x,
      clientY: 50,
      timeStamp: ts,
      target,
    });
  fire("pointerdown", 100, 0, row);
  fire("pointermove", 130, 16, row);
  fire("pointerup", 130, 40, row);
  await settle();
  assertEquals(pops, [], "the row keeps its swipe");
  fire("pointerdown", 100, 100, stack);
  fire("pointermove", 130, 116, stack);
  fire("pointerup", 130, 140, stack);
  await settle();
  assertEquals(pops, [0], "elsewhere on the screen the swipe pops");
  root.unmount();
});
