// `<ViewTransition>` on same-page updates (React 19.2's triggers). A commit made entirely of
// Transition work — a `startTransition` update, a `useDeferredValue` catch-up, a Suspense
// reveal — runs inside `document.startViewTransition` when something wrapped in a
// `<ViewTransition>` enters, exits, is shared between two places, or updates (its content
// mutated or its layout moved); an urgent (sync) update never animates. Before the browser's
// old-state capture the OUTGOING side is named (`exit`/`update`/`share`); inside the update
// callback, after the commit, the INCOMING side is (`enter`/`update`/`share`). An unchanged
// boundary is cancelled, and the root cross-fade is cancelled when nothing outside a boundary
// changed. The browser animation can't run here, so these assert the stamping and the
// startViewTransition calls the browser acts on (a stub records both). The marking runtime is
// import-gated; the helper installs it, as the generated entry does in a real build.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import "./helpers/view-transition-runtime.ts";
import "./helpers/activity-runtime.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Activity, DNX_VT_ATTR, ViewTransition } from "../src/runtime/react-extras.ts";
import { Fragment } from "../src/jsx/jsx-runtime.ts";
import {
  startTransition,
  useDeferredValue,
  useState,
  useSyncExternalStore,
  useTransition,
} from "../src/runtime/hooks.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { addTransitionType } from "../src/client/fiber/view-transition-support.ts";
import {
  __pumpForTests,
  __setManualSlicingForTests,
  createRoot,
  flushSync,
  setDocument,
} from "../src/client/fiber/reconciler.ts";
import { FakeElement, makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** One recorded `startViewTransition` call. */
interface Call {
  types: string[];
  /** Each `[data-testid]` element's inline style when the browser would capture the OLD state. */
  old: Map<string, string>;
  /** …and when it would capture the NEW state (after the update callback). */
  next: Map<string, string>;
  /** The document element's inline style during the transition. */
  rootStyle: string;
  /** Pseudo-element animations the runtime started (the cancelled groups). */
  cancelled: string[];
  /** Resolve `finished` (the animation ended → stamps are cleared). */
  end: () => void;
}

function styles(doc: Any): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (n: Any) => {
    if (n.nodeType !== 1) return;
    const id = n.getAttribute("data-testid");
    if (id) out.set(id, n.getAttribute("style") ?? "");
    for (const c of n.childNodes) visit(c);
  };
  visit(doc.documentElement);
  return out;
}

/** A fake DOM whose document records view transitions; `update` runs on a microtask, as in a browser. */
function setup() {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  (doc.body as Any).appendChild(container);
  const calls: Call[] = [];
  const root = doc.documentElement as Any;
  root.animate = (_k: unknown, o: { pseudoElement: string }) => {
    calls.at(-1)?.cancelled.push(o.pseudoElement);
  };
  (doc as Any).startViewTransition = (arg: Any) => {
    const update = typeof arg === "function" ? arg : arg.update;
    let end: () => void = () => {};
    const finished = new Promise<void>((r) => (end = r));
    const call: Call = {
      types: typeof arg === "function" ? [] : (arg.types ?? []),
      old: styles(doc),
      next: new Map(),
      rootStyle: "",
      cancelled: [],
      end,
    };
    calls.push(call);
    const updateCallbackDone = Promise.resolve().then(() => {
      update();
      call.next = styles(doc);
      call.rootStyle = root.getAttribute("style") ?? "";
    });
    return { ready: updateCallbackDone, updateCallbackDone, finished };
  };
  return { doc, container, calls };
}

/** Let the stubbed transition's update callback (a microtask) run. */
async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const vtName = (style: string) => /view-transition-name:\s*([^;]+)/.exec(style)?.[1]?.trim();
const vtClass = (style: string) => /view-transition-class:\s*([^;]+)/.exec(style)?.[1]?.trim();

function List({ items, set }: { items: string[]; set: (fn: (s: string[]) => void) => void }) {
  const [list, setList] = useState(items);
  set((fn) => setList(fn as never));
  return h(
    "ul",
    null,
    list.map((id) =>
      h(
        ViewTransition,
        { key: id, enter: "in", exit: "out", update: "move" },
        h("li", { "data-testid": id }, id),
      )
    ),
  );
}

function mountList(items: string[]) {
  const env = setup();
  let update: (s: string[]) => void = () => {};
  const set = (fn: (s: string[]) => void) => (update = fn);
  createRoot(env.container as Any).render(h(List, { items, set }) as VNode);
  flushSync();
  return { ...env, update: (next: string[]) => update(next) };
}

Deno.test("an urgent (sync) update applies directly: no view transition", () => {
  const { calls, update, container } = mountList(["a"]);
  update(["a", "b"]);
  flushSync();
  assertEquals(calls.length, 0, "sync updates never animate (React: only Transitions do)");
  assertStringIncludes((container as Any).innerHTML, 'data-testid="b"');
});

Deno.test("a startTransition add runs inside startViewTransition; the new element enters", async () => {
  const { calls, update, container } = mountList(["a"]);
  startTransition(() => update(["a", "b"]));
  flushSync();
  assertEquals(calls.length, 1, "the Transition commit started one view transition");
  const [call] = calls;
  assert(!call.old.has("b"), "the old state is captured before the commit (b not yet in the DOM)");
  assert(
    !(container as Any).innerHTML.includes('data-testid="b"'),
    "the commit waits for the update callback",
  );
  await tick();
  const b = call.next.get("b")!;
  assert(vtName(b), `the entering element is named (auto name) — got ${JSON.stringify(b)}`);
  assertEquals(vtClass(b), "in", "the enter class");
  assertEquals(vtName(call.next.get("a") ?? ""), undefined, "an unchanged boundary is not named");
  call.end();
  await tick();
  const li = (container as Any).childNodes[0].childNodes[1];
  assertEquals(li.getAttribute("style"), null, "stamps are removed once the transition finishes");
});

Deno.test("a startTransition removal: the leaving element exits, named before the old capture", async () => {
  const { calls, update } = mountList(["a", "b"]);
  startTransition(() => update(["a"]));
  flushSync();
  assertEquals(calls.length, 1);
  const old = calls[0].old.get("b")!;
  assert(vtName(old), "the exiting element carries a name in the OLD capture");
  assertEquals(vtClass(old), "out", "the exit class");
  await tick();
  assert(!calls[0].next.has("b"), "and is gone from the new state");
});

Deno.test("a time-sliced transition (the concurrent path) animates too, and passes addTransitionType types", async () => {
  const { calls, update } = mountList(["a"]);
  __setManualSlicingForTests(true);
  try {
    startTransition(() => {
      addTransitionType("forward");
      update(["a", "c"]);
    });
    let n = 0;
    while (__pumpForTests() && n < 50) n++;
  } finally {
    __setManualSlicingForTests(false);
  }
  assertEquals(calls.length, 1);
  assertEquals(calls[0].types, ["forward"]);
  await tick();
  assertEquals(vtClass(calls[0].next.get("c")!), "in");
});

Deno.test("a reorder animates the moved boundaries as updates; an unmoved one is cancelled", async () => {
  // Layout from DOM order: each <li> sits 10px below its previous sibling.
  const proto = FakeElement.prototype as Any;
  const orig = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: Any) {
    const i = this.parentNode ? this.parentNode.childNodes.indexOf(this) : 0;
    return { x: 0, y: i * 10, top: i * 10, left: 0, width: 100, height: 10 };
  };
  try {
    const { calls, update } = mountList(["a", "b", "c"]);
    startTransition(() => update(["c", "b", "a"]));
    flushSync();
    assertEquals(calls.length, 1, "a reorder of boundaries starts a transition");
    const { old } = calls[0];
    for (const id of ["a", "b", "c"]) {
      assertEquals(vtClass(old.get(id)!), "move", `${id} old: update class`);
    }
    await tick();
    const { next, cancelled } = calls[0];
    assertEquals(vtClass(next.get("a")!), "move", "a moved: update");
    assertEquals(vtClass(next.get("c")!), "move", "c moved: update");
    assertEquals(vtName(next.get("b")!), undefined, "b did not move: its new side is unnamed");
    assertEquals(cancelled.length, 1, "…and its old group is cancelled");
    assertStringIncludes(cancelled[0], vtName(old.get("b")!)!);
    assertStringIncludes(
      calls[0].rootStyle,
      "view-transition-name:none",
      "nothing outside a boundary changed: the root cross-fade is cancelled",
    );
  } finally {
    proto.getBoundingClientRect = orig;
  }
});

Deno.test("a content change inside a boundary animates it as an update; outside one, the root animates", async () => {
  const env = setup();
  let set: (n: number) => void = () => {};
  function App() {
    const [n, setN] = useState(0);
    set = setN;
    return h(
      "div",
      null,
      h(ViewTransition, { update: "bump" }, h("p", { "data-testid": "p" }, `n=${n}`)),
      h("span", { "data-testid": "s" }, n > 1 ? "big" : "small"),
    );
  }
  createRoot(env.container as Any).render(h(App, null) as VNode);
  flushSync();
  startTransition(() => set(1));
  flushSync();
  await tick();
  assertEquals(env.calls.length, 1);
  assertEquals(vtClass(env.calls[0].next.get("p")!), "bump", "mutated inside → update");
  assertStringIncludes(
    env.calls[0].rootStyle,
    "view-transition-name:none",
    "root untouched → cancelled",
  );
  env.calls[0].end();
  await tick();
  startTransition(() => set(2)); // the <span> outside any boundary changes too
  flushSync();
  await tick();
  assertEquals(env.calls.length, 2);
  assert(
    !env.calls[1].rootStyle.includes("view-transition-name"),
    "an outside mutation keeps the root cross-fade",
  );
  env.calls[1].end();
  await tick();
  assertEquals(
    (env.doc.documentElement as Any).getAttribute("style"),
    null,
    "the root is restored",
  );
});

Deno.test("share: a named element leaving one place and entering another pairs (share class on both sides)", async () => {
  const env = setup();
  let open: (b: boolean) => void = () => {};
  function App() {
    const [isOpen, setOpen] = useState(false);
    open = setOpen;
    const card = (id: string) =>
      h(
        ViewTransition,
        { name: "card", share: "morph", enter: "in", exit: "out" },
        h("div", { "data-testid": id }, id),
      );
    return h(
      "main",
      null,
      isOpen ? h("section", null, card("big")) : h("aside", null, card("small")),
    );
  }
  createRoot(env.container as Any).render(h(App, null) as VNode);
  flushSync();
  startTransition(() => open(true));
  flushSync();
  await tick();
  const [call] = env.calls;
  assertEquals(vtName(call.old.get("small")!), "card");
  assertEquals(
    vtClass(call.old.get("small")!),
    "morph",
    "the old side of a pair takes share, not exit",
  );
  assertEquals(vtName(call.next.get("big")!), "card");
  assertEquals(
    vtClass(call.next.get("big")!),
    "morph",
    "the new side of a pair takes share, not enter",
  );
});

Deno.test('class resolution: `default`, per-type maps, "auto" and "none"', async () => {
  const env = setup();
  let set: (s: string[]) => void = () => {};
  function App() {
    const [ids, setIds] = useState<string[]>([]);
    set = setIds;
    return h(
      "div",
      null,
      ids.map((id) =>
        h(
          ViewTransition,
          {
            key: id,
            default: id === "d" ? "fallback" : "auto",
            enter: id === "n"
              ? "none"
              : id === "t"
              ? { back: "slide-back", default: "slide" }
              : undefined,
          },
          h("i", { "data-testid": id }, id),
        )
      ),
    );
  }
  createRoot(env.container as Any).render(h(App, null) as VNode);
  flushSync();
  startTransition(() => {
    addTransitionType("back");
    set(["d", "n", "t", "a"]);
  });
  flushSync();
  await tick();
  const { next } = env.calls[0];
  assertEquals(vtClass(next.get("d")!), "fallback", "no enter → `default`");
  assertEquals(vtName(next.get("n")!), undefined, '"none" opts the boundary out');
  assertEquals(vtClass(next.get("t")!), "slide-back", "the active type's class");
  assert(
    vtName(next.get("a")!) && vtClass(next.get("a")!) === undefined,
    '"auto": named, no class',
  );
});

Deno.test("a useDeferredValue catch-up animates; its urgent render does not", async () => {
  const env = setup();
  let set: (n: number) => void = () => {};
  function App() {
    const [n, setN] = useState(1);
    set = setN;
    const deferred = useDeferredValue(n);
    return h(
      "div",
      null,
      Array.from(
        { length: deferred },
        (_, i) =>
          h(ViewTransition, { key: i, enter: "in" }, h("b", { "data-testid": `d${i}` }, String(i))),
      ),
    );
  }
  createRoot(env.container as Any).render(h(App, null) as VNode);
  flushSync();
  __setManualSlicingForTests(true);
  try {
    set(2); // urgent: renders the old deferred value, schedules the catch-up transition
    await tick(); // the urgent (microtask) flush
    assertEquals(env.calls.length, 0, "the urgent render does not animate");
    let n = 0;
    while (__pumpForTests() && n < 50) n++;
  } finally {
    __setManualSlicingForTests(false);
  }
  assertEquals(env.calls.length, 1, "the deferred (transition) commit animates");
  await tick();
  assertEquals(vtClass(env.calls[0].next.get("d1")!), "in");
});

Deno.test("a Suspense reveal animates: the fallback exits, the content enters", async () => {
  const env = setup();
  let resolve: () => void = () => {};
  let ready = false;
  const promise = new Promise<void>((r) => (resolve = () => ((ready = true), r())));
  function Data() {
    if (!ready) throw promise;
    return h(ViewTransition, { enter: "reveal" }, h("p", { "data-testid": "content" }, "data"));
  }
  createRoot(env.container as Any).render(
    h(Suspense, {
      fallback: h(ViewTransition, { exit: "fade" }, h("p", { "data-testid": "fallback" }, "…")),
      children: h(Data, null),
    }) as VNode,
  );
  flushSync();
  assertEquals(
    env.calls.length,
    0,
    "the initial (sync) render shows the fallback without a transition",
  );
  resolve();
  await promise;
  await tick();
  flushSync();
  assertEquals(env.calls.length, 1, "the reveal (a Suspense retry) started a view transition");
  await tick();
  assertEquals(vtClass(env.calls[0].old.get("fallback")!), "fade");
  assertEquals(vtClass(env.calls[0].next.get("content")!), "reveal");
});

/** A labelled root over a Suspense boundary whose content waits on `gate`; the retry is armed. */
function revealFixture() {
  const env = setup();
  let resolve: () => void = () => {};
  let ready = false;
  const promise = new Promise<void>((r) => (resolve = () => ((ready = true), r())));
  function Data() {
    if (!ready) throw promise;
    return h(ViewTransition, { enter: "reveal" }, h("p", { "data-testid": "content" }, "data"));
  }
  const tree = (label: string) =>
    h(
      "div",
      null,
      h(ViewTransition, { update: "relabel" }, h("span", { "data-testid": "label" }, label)),
      h(Suspense, {
        fallback: h(ViewTransition, { exit: "fade" }, h("p", null, "…")),
        children: h(Data, null),
      }),
    ) as VNode;
  const root = createRoot(env.container as Any);
  root.render(tree("one"));
  flushSync();
  return { ...env, root, tree, resolve, promise };
}

Deno.test("root.render() between a Suspense retry and its flush commits synchronously", async () => {
  // A retry marks the root's pending sync work as a pure reveal (animatable). A direct
  // `root.render` before the retry's microtask joins that work: it is an element update, so
  // it is urgent and must commit now, not wait on a view transition's update callback
  // (the Flight commit's resumabilityReboot then ran against the old DOM).
  const { root, tree, resolve, promise, container } = revealFixture();
  resolve();
  await promise; // the retry is scheduled; its sync flush is still queued
  root.render(tree("two"));
  assertStringIncludes((container as Any).innerHTML, ">two<", "the DOM updated synchronously");
  await tick();
});

Deno.test("a reveal retried inside an async transition leaves no stale reveal for root.render()", async () => {
  // A retry that lands on the TransitionLane commits through the concurrent path, which never
  // consumes the root's reveal mark — so a later direct `root.render` read it as a reveal.
  const { root, tree, resolve, promise, container } = revealFixture();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  startTransition(async () => {
    await gate;
  });
  resolve();
  await promise;
  // Let the transition retry render on the time-sliced path (a timer), not via flushSync.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  assertStringIncludes((container as Any).innerHTML, "data", "the reveal committed");
  release();
  await gate;
  await tick();
  root.render(tree("two"));
  assertStringIncludes((container as Any).innerHTML, ">two<", "the DOM updated synchronously");
  await tick();
});

Deno.test("an Activity revealed in a transition enters", async () => {
  const env = setup();
  let show: (b: boolean) => void = () => {};
  function App() {
    const [on, setOn] = useState(false);
    show = setOn;
    return h(Activity, {
      mode: on ? "visible" : "hidden",
      children: h(ViewTransition, { enter: "pop" }, h("p", { "data-testid": "panel" }, "panel")),
    });
  }
  createRoot(env.container as Any).render(h(App, null) as VNode);
  flushSync();
  startTransition(() => show(true));
  flushSync();
  await tick();
  assertEquals(env.calls.length, 1);
  assertEquals(vtClass(env.calls[0].next.get("panel")!), "pop");
});

Deno.test("without document.startViewTransition a Transition commit applies directly", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let set: (s: string[]) => void = () => {};
  function App() {
    const [ids, setIds] = useState(["a"]);
    set = setIds;
    return h("ul", null, ids.map((id) => h(ViewTransition, { key: id }, h("li", null, id))));
  }
  createRoot(container as Any).render(h(App, null) as VNode);
  flushSync();
  startTransition(() => set(["a", "b"]));
  flushSync();
  assertStringIncludes((container as Any).innerHTML, '<li data-dnx-vt="{}">b</li>');
});

Deno.test("two live <ViewTransition>s with the same name warn in development", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  (doc.body as Any).appendChild(container);
  const g = globalThis as { __denextDev?: boolean };
  const prevDev = g.__denextDev;
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  g.__denextDev = true;
  try {
    createRoot(container as Any).render(
      h(
        "div",
        null,
        h(ViewTransition, { name: "dup-x" }, h("i", null, "1")),
        h(ViewTransition, { name: "dup-x" }, h("i", null, "2")),
      ) as VNode,
    );
    flushSync();
  } finally {
    console.error = orig;
    g.__denextDev = prevDev;
  }
  assert(
    errors.some((e) => e.includes("same name") && e.includes("dup-x")),
    `expected a duplicate-name warning; got ${JSON.stringify(errors)}`,
  );
});

Deno.test("a commit that throws in the view transition's update callback reaches the root's error handling", async () => {
  // The deferred commit runs inside the browser's update callback, outside the work loop that
  // would recover from it: a throw there was only logged, and a time-sliced transition's
  // `isPending` stayed true for good (its settle came after the commit that threw).
  const env = setup();
  const errors: unknown[] = [];
  let set: (v: string) => void = () => {};
  let go: (fn: () => void) => void = () => {};
  let pending = false;
  function App() {
    const [v, setV] = useState("a");
    const [isPending, start] = useTransition();
    set = setV;
    go = start;
    pending = isPending;
    return h(ViewTransition, { update: "u" }, h("p", { "data-testid": "p", "data-v": v }, v));
  }
  createRoot(env.container as Any, { onUncaughtError: (e) => errors.push(e) }).render(
    h(App, null) as VNode,
  );
  flushSync();
  const p = (env.container as Any).childNodes[0];
  const setAttribute = p.setAttribute.bind(p);
  let fail = true; // once: a later render's commit of the same props goes through
  p.setAttribute = (n: string, v: string) => {
    if (v === "boom" && fail) {
      fail = false;
      throw new Error("commit failed");
    }
    setAttribute(n, v);
  };
  __setManualSlicingForTests(true);
  try {
    go(() => set("boom"));
    let n = 0;
    while (__pumpForTests() && n < 50) n++;
  } finally {
    __setManualSlicingForTests(false);
  }
  assertEquals(env.calls.length, 1, "the commit was deferred into a view transition");
  await tick();
  assertEquals(errors.map((e) => (e as Error).message), ["commit failed"]);
  flushSync();
  assertEquals(pending, false, "the transition settled");
});

// ---- Child shapes: the boundary's nearest host nodes, whatever wraps them ------------------

/** Mount `App` and return a setter that toggles its `on` state. */
function mountToggle(render: (on: boolean) => unknown) {
  const env = setup();
  let set: (b: boolean) => void = () => {};
  function App() {
    const [on, setOn] = useState(false);
    set = setOn;
    return h("main", null, render(on) as never);
  }
  createRoot(env.container as Any).render(h(App, null) as VNode);
  flushSync();
  return { ...env, set: (b: boolean) => set(b) };
}

Deno.test("shapes: a component child entering animates the host it renders", async () => {
  const Card = () => h("div", { "data-testid": "card" }, "card");
  const env = mountToggle((on) =>
    on && h(ViewTransition, { name: "c", enter: "in" }, h(Card, null))
  );
  startTransition(() => env.set(true));
  flushSync();
  await tick();
  assertEquals(env.calls.length, 1);
  assertEquals(vtName(env.calls[0].next.get("card")!), "c");
  assertEquals(vtClass(env.calls[0].next.get("card")!), "in");
});

Deno.test("shapes: a Fragment of hosts exits as one boundary per host (name, name_1)", () => {
  const env = mountToggle((on) =>
    !on &&
    h(
      ViewTransition,
      { name: "pair", exit: "out" },
      h(
        Fragment,
        null,
        h("p", { "data-testid": "p1" }, "1"),
        "text",
        h("p", { "data-testid": "p2" }, "2"),
      ),
    )
  );
  startTransition(() => env.set(true));
  flushSync();
  const old = env.calls[0].old;
  assertEquals([vtName(old.get("p1")!), vtName(old.get("p2")!)], ["pair", "pair_1"]);
  assertEquals([vtClass(old.get("p1")!), vtClass(old.get("p2")!)], ["out", "out"]);
});

Deno.test("shapes: a component child keeps its state across renders (no remount) and its marks", async () => {
  let bump: () => void = () => {};
  let mounts = 0;
  function Counter() {
    const [n, setN] = useState(() => (mounts++, 0));
    bump = () => setN(n + 1);
    return h("p", { "data-testid": "n" }, String(n));
  }
  const env = mountToggle((on) =>
    h(ViewTransition, { name: "n", update: "tick" }, h(Counter, { on }))
  );
  startTransition(() => bump());
  flushSync();
  await tick();
  startTransition(() => env.set(true)); // the parent re-renders the boundary too
  flushSync();
  await tick();
  assertEquals(mounts, 1, "the wrapped component kept its fiber");
  assertStringIncludes((env.container as Any).innerHTML, ">1<");
  const call = env.calls[0];
  assertEquals(vtName(call.next.get("n")!), "n", "its own update animates under the name");
  assertEquals(vtClass(call.next.get("n")!), "tick");
});

Deno.test("shapes: a child the server can't expand (a client reference) is resolved by the client runtime", async () => {
  // Flight hands the browser a client component carrying the config as a prop; the component
  // doesn't forward it, so the runtime finds the component's nearest hosts itself.
  const Island = () =>
    h(Fragment, null, h("i", { "data-testid": "i1" }, "1"), h("i", { "data-testid": "i2" }, "2"));
  const env = mountToggle((on) =>
    on && h(Island as Any, { [DNX_VT_ATTR]: JSON.stringify({ name: "isl", enter: "in" }) })
  );
  startTransition(() => env.set(true));
  flushSync();
  await tick();
  const next = env.calls[0].next;
  assertEquals([vtName(next.get("i1")!), vtName(next.get("i2")!)], ["isl", "isl_1"]);
  assertEquals(vtClass(next.get("i1")!), "in");
});

// ---- External stores (React 19.2: a store change always renders at SyncLane) ---------------

function storeOf(initial: string[]) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (v: string[]) => {
      value = v;
      for (const s of subs) s();
    },
    subscribe: (fn: () => void) => (subs.add(fn), () => subs.delete(fn)),
  };
}

Deno.test("a useSyncExternalStore change never animates, even inside startTransition (as in React)", async () => {
  const env = setup();
  const store = storeOf(["a"]);
  let setExtra: (b: boolean) => void = () => {};
  const item = (id: string) =>
    h(ViewTransition, { key: id, enter: "in" }, h("li", { "data-testid": id }, id));
  function Items() {
    return h("ul", null, useSyncExternalStore(store.subscribe, store.get).map(item));
  }
  function Extra() {
    const [extra, setX] = useState(false);
    setExtra = setX;
    return h("ul", null, extra && item("x"));
  }
  createRoot(env.container as Any).render(h("main", null, h(Items, null), h(Extra, null)) as VNode);
  flushSync();
  startTransition(() => store.set(["a", "b"]));
  flushSync();
  assertEquals(env.calls.length, 0, "the store render is synchronous: no view transition");
  assertStringIncludes((env.container as Any).innerHTML, 'data-testid="b"');
  // A transition that changes both: the store half commits synchronously first, and the state
  // half animates on its own (only its boundary enters).
  startTransition(() => {
    store.set(["a", "b", "c"]);
    setExtra(true);
  });
  await tick(); // the store's sync render runs first, on its own (as the scheduler does)
  assertEquals(env.calls.length, 0, "the store's sync commit did not animate");
  flushSync(); // then the Transition render
  await tick();
  assertEquals(env.calls.length, 1, "only the Transition render animates");
  const call = env.calls[0];
  assert(call.old.has("c"), "the store's item was committed (sync) before the old capture");
  assertEquals(vtClass(call.next.get("x")!), "in", "the state update's boundary enters");
  assertEquals(vtName(call.next.get("c") ?? ""), undefined, "the store's item is not animated");
});
