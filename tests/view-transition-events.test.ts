// `<ViewTransition>`'s callbacks and the rest of React's surface: `onEnter` / `onExit` /
// `onUpdate` / `onShare` run once the transition is ready (React's `flushSpawnedWork`) with the
// boundary's `ViewTransitionInstance` and the transition types, and a returned cleanup runs when
// it finishes; an `<Activity>` going hidden in a Transition animates its boundaries as exits; and
// a boundary outside the viewport (React's `wasInstanceInViewport`) is not animated. A stub
// `document.startViewTransition` records what the browser would act on, as in
// view-transition-same-page.test.ts. The marking runtime is import-gated; the helper installs it.

import { assert, assertEquals } from "@std/assert";
import "./helpers/view-transition-runtime.ts";
import "./helpers/activity-runtime.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Activity, ViewTransition } from "../src/runtime/react-extras.ts";
import { startTransition, useState } from "../src/runtime/hooks.ts";
import {
  addTransitionType,
  getViewTransitionSupport,
} from "../src/client/fiber/view-transition-support.ts";
import { createRoot, flushSync, setDocument } from "../src/client/fiber/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

interface Call {
  old: Map<string, string>;
  next: Map<string, string>;
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

/** A fake DOM whose document records view transitions; `ready` follows the update callback. */
function setup() {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  (doc.body as Any).appendChild(container);
  const calls: Call[] = [];
  const animated: Array<{ pseudoElement: string; duration?: number }> = [];
  const root = doc.documentElement as Any;
  root.animate = (_k: unknown, o: { pseudoElement: string; duration?: number }) => {
    animated.push(o);
  };
  (doc as Any).startViewTransition = (arg: Any) => {
    const update = typeof arg === "function" ? arg : arg.update;
    let end: () => void = () => {};
    const finished = new Promise<void>((r) => (end = r));
    const call: Call = { old: styles(doc), next: new Map(), end };
    calls.push(call);
    const updateCallbackDone = Promise.resolve().then(() => {
      update();
      call.next = styles(doc);
    });
    return { ready: updateCallbackDone, updateCallbackDone, finished };
  };
  return { doc, container, calls, animated };
}

async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const vtName = (style: string) => /view-transition-name:\s*([^;]+)/.exec(style)?.[1]?.trim();
const vtClass = (style: string) => /view-transition-class:\s*([^;]+)/.exec(style)?.[1]?.trim();

/** Mount `App`, returning its environment once the first render committed. */
function mount(App: () => VNode | null) {
  const env = setup();
  createRoot(env.container as Any).render(h(App as Any, null) as VNode);
  flushSync();
  return env;
}

Deno.test("onEnter runs once the transition is ready, with the instance and the types; its cleanup when it finishes", async () => {
  const log: string[] = [];
  let show: (b: boolean) => void = () => {};
  function App() {
    const [on, setOn] = useState(false);
    show = setOn;
    return h(
      "div",
      null,
      on
        ? h(
          ViewTransition,
          {
            name: "panel",
            enter: "in",
            onEnter: (inst: Any, types: string[]) => {
              log.push(`enter:${inst.name}:${types.join(",")}`);
              inst.new.animate({ opacity: [0, 1] }, 200);
              return () => log.push("cleanup");
            },
          },
          h("p", { "data-testid": "a" }, "a"),
          h("p", { "data-testid": "b" }, "b"),
        )
        : null,
    );
  }
  const env = mount(App);
  startTransition(() => {
    addTransitionType("open");
    show(true);
  });
  flushSync();
  assertEquals(log, [], "nothing runs before the transition is ready");
  await tick();
  assertEquals(
    log,
    ["enter:panel:open"],
    "onEnter runs once for the boundary (not per host), with its name and the types",
  );
  assertEquals(vtClass(env.calls[0].next.get("a")!), "in");
  assertEquals(
    env.animated.at(-1),
    { duration: 200, pseudoElement: "::view-transition-new(panel)" },
    "instance.new animates the boundary's ::view-transition-new pseudo-element",
  );
  env.calls[0].end();
  await tick();
  assertEquals(log, ["enter:panel:open", "cleanup"], "the returned cleanup runs when it finishes");
});

Deno.test("onExit runs for a removed boundary; an urgent removal runs nothing", async () => {
  const log: string[] = [];
  let set: (n: number) => void = () => {};
  function App() {
    const [n, setN] = useState(3);
    set = setN;
    return h(
      "ul",
      null,
      ["x", "y", "z"].slice(0, n).map((id) =>
        h(
          ViewTransition,
          { key: id, onExit: (inst: Any) => log.push(`exit:${id}:${!!inst.name}`) },
          h("li", { "data-testid": id }, id),
        )
      ),
    );
  }
  mount(App);
  set(2); // urgent: no view transition, no callback
  flushSync();
  await tick();
  assertEquals(log, []);
  startTransition(() => set(1));
  flushSync();
  await tick();
  assertEquals(log, ["exit:y:true"]);
});

Deno.test("boundaries sharing one callback each run it (once per <ViewTransition>)", async () => {
  const names: string[] = [];
  const onExit = (inst: Any) => void names.push(inst.name);
  let set: (n: number) => void = () => {};
  function App() {
    const [n, setN] = useState(2);
    set = setN;
    return h(
      "ul",
      null,
      ["p", "q"].slice(0, n).map((id) =>
        h(ViewTransition, { key: id, name: `row-${id}`, onExit }, h("li", null, id))
      ),
    );
  }
  mount(App);
  startTransition(() => set(0));
  flushSync();
  await tick();
  assertEquals(names.sort(), ["row-p", "row-q"]);
});

Deno.test("onShare runs on the side that leaves; the paired side runs no onEnter / onExit", async () => {
  const log: string[] = [];
  let open: (b: boolean) => void = () => {};
  function App() {
    const [isOpen, setOpen] = useState(false);
    open = setOpen;
    const card = (id: string) =>
      h(
        ViewTransition,
        {
          name: "card",
          share: "morph",
          onShare: (inst: Any) => log.push(`share:${id}:${inst.name}`),
          onEnter: () => log.push(`enter:${id}`),
          onExit: () => log.push(`exit:${id}`),
        },
        h("div", { "data-testid": id }, id),
      );
    return h(
      "main",
      null,
      isOpen ? h("section", null, card("big")) : h("aside", null, card("small")),
    );
  }
  const env = mount(App);
  startTransition(() => open(true));
  flushSync();
  await tick();
  assertEquals(vtClass(env.calls[0].old.get("small")!), "morph");
  assertEquals(vtClass(env.calls[0].next.get("big")!), "morph");
  assertEquals(log, ["share:small:card"]);
});

Deno.test("onUpdate runs for a boundary whose content changed; not for an untouched one", async () => {
  const log: string[] = [];
  let set: (n: number) => void = () => {};
  function App() {
    const [n, setN] = useState(0);
    set = setN;
    return h(
      "div",
      null,
      h(ViewTransition, { onUpdate: () => log.push("a") }, h("p", null, `n=${n}`)),
      h(ViewTransition, { onUpdate: () => log.push("b") }, h("p", null, "static")),
    );
  }
  mount(App);
  startTransition(() => set(1));
  flushSync();
  await tick();
  assertEquals(log, ["a"]);
});

Deno.test("an <Activity> going hidden in a Transition animates its boundaries as exits", async () => {
  const log: string[] = [];
  let show: (b: boolean) => void = () => {};
  function App() {
    const [on, setOn] = useState(true);
    show = setOn;
    return h(Activity, {
      mode: on ? "visible" : "hidden",
      children: h(
        ViewTransition,
        { exit: "fade-out", onExit: () => log.push("exit") },
        h("p", { "data-testid": "panel" }, "panel"),
      ),
    });
  }
  const env = mount(App);
  startTransition(() => show(false));
  flushSync();
  assertEquals(env.calls.length, 1, "hiding in a Transition starts a view transition");
  const old = env.calls[0].old.get("panel")!;
  assert(vtName(old), "the hidden content is named before the old-state capture");
  assertEquals(vtClass(old), "fade-out", "with its exit class");
  await tick();
  assertEquals(log, ["exit"]);
  assert(
    (env.calls[0].next.get("panel") ?? "").includes("display:none"),
    "and is hidden in the new state",
  );
});

Deno.test("a boundary outside the viewport neither enters nor updates (React skips it)", async () => {
  const log: string[] = [];
  let set: (n: number) => void = () => {};
  function App() {
    const [n, setN] = useState(0);
    set = setN;
    return h(
      "div",
      null,
      h(
        ViewTransition,
        { update: "u", onUpdate: () => log.push("update:far") },
        h("p", { "data-testid": "far" }, `n=${n}`),
      ),
      h(
        ViewTransition,
        { update: "u", onUpdate: () => log.push("update:near") },
        h("p", { "data-testid": "near" }, `n=${n}`),
      ),
      n > 0
        ? h(
          ViewTransition,
          { enter: "in", onEnter: () => log.push("enter:below") },
          h("p", { "data-testid": "below" }, "below"),
        )
        : null,
    );
  }
  const env = setup();
  (env.doc as Any).defaultView = { innerWidth: 800, innerHeight: 600 };
  // `far` and `below` sit 5000px down; `near` is on screen.
  const proto = Object.getPrototypeOf(env.container) as Any;
  const orig = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: Any) {
    const id = this.getAttribute?.("data-testid");
    const top = id === "far" || id === "below" ? 5000 : 10;
    return { top, left: 0, width: 100, height: 20, bottom: top + 20, right: 100 };
  };
  try {
    createRoot(env.container as Any).render(h(App, null) as VNode);
    flushSync();
    startTransition(() => set(1));
    flushSync();
    await tick();
    assertEquals(env.calls.length, 1);
    const next = env.calls[0].next;
    assertEquals(vtClass(next.get("near")!), "u", "the on-screen boundary updates");
    assertEquals(vtName(next.get("far")!), undefined, "the off-screen one is not named");
    assertEquals(vtName(next.get("below")!), undefined, "an off-screen enter is not named");
    assertEquals(log, ["update:near"], "only the on-screen boundary's callback runs");
  } finally {
    proto.getBoundingClientRect = orig;
  }
});

Deno.test("soft navigation: onExit / onEnter / onShare on the boundaries that leave, come or pair", () => {
  const log: string[] = [];
  let page: (p: string) => void = () => {};
  function App() {
    const [p, setP] = useState("a");
    page = setP;
    const vt = (id: string, name?: string) =>
      h(
        ViewTransition,
        {
          key: id,
          name,
          onEnter: () => log.push(`enter:${id}`),
          onExit: () => log.push(`exit:${id}`),
          onShare: () => log.push(`share:${id}`),
        },
        h("div", { "data-testid": id }, id),
      );
    return h(
      "main",
      null,
      p === "a" ? [vt("list"), vt("thumb", "hero")] : [vt("detail"), vt("big", "hero")],
    );
  }
  mount(App);
  const tx = getViewTransitionSupport()!.begin([]);
  page("b");
  flushSync();
  tx.markIncoming();
  assertEquals(log, [], "the callbacks wait for the transition to be ready");
  tx.ready();
  assertEquals(log.sort(), ["enter:detail", "exit:list", "share:thumb"]);
  tx.clear();
});

Deno.test("soft navigation: onUpdate on a persisting boundary whose content changed, not on an unchanged one", () => {
  const log: string[] = [];
  let page: (p: string) => void = () => {};
  function App() {
    const [p, setP] = useState("a");
    page = setP;
    return h(
      "main",
      null,
      h(
        ViewTransition,
        { name: "crumb", onUpdate: (inst: Any) => log.push(`update:${inst.name}`) },
        h("nav", { "data-testid": "crumb" }, `at ${p}`),
      ),
      h(
        ViewTransition,
        { name: "logo", onUpdate: () => log.push("update:logo") },
        h("header", { "data-testid": "logo" }, "logo"),
      ),
    );
  }
  mount(App);
  const tx = getViewTransitionSupport()!.begin([]);
  page("b");
  flushSync();
  tx.markIncoming();
  tx.ready();
  assertEquals(log, ["update:crumb"], "only the boundary whose content changed updates");
  tx.clear();
});

Deno.test("a ref on <ViewTransition> receives the boundary's ViewTransitionInstance, kept across renders", async () => {
  const seen: Array<string | null> = [];
  const objRef: { current: Any } = { current: null };
  let hostEl: Any = null;
  let set: (n: number) => void = () => {};
  let toggle: (b: boolean) => void = () => {};
  const cb = (inst: Any) => {
    seen.push(inst ? `${inst.name}:${typeof inst.new.animate}` : null);
    return () => seen.push("cleanup");
  };
  function App() {
    const [n, setN] = useState(0);
    const [on, setOn] = useState(true);
    set = setN;
    toggle = setOn;
    return h(
      "div",
      null,
      on
        ? h(
          ViewTransition,
          { name: "card", ref: cb },
          h("p", { "data-testid": "a", ref: (el: Any) => (hostEl = el) }, `n=${n}`),
          h("p", { "data-testid": "b" }, "b"),
        )
        : null,
      h(ViewTransition, { ref: objRef, update: "u" }, h("p", { "data-testid": "auto" }, `${n}`)),
    );
  }
  const env = mount(App);
  assertEquals(
    seen,
    ["card:function"],
    "attached once the first host mounts, named as the boundary",
  );
  assert(hostEl?.getAttribute("data-testid") === "a", "the host's own ref still gets the element");
  const auto = objRef.current;
  assert(
    auto && /^_dnx-vt-/.test(auto.name),
    "an unnamed boundary's instance carries its automatic name",
  );
  set(1);
  flushSync();
  assertEquals(seen, ["card:function"], "a re-render keeps the same ref attached");
  assertEquals(objRef.current, auto);
  // The automatic name is the one a transition stamps on the boundary.
  startTransition(() => set(2));
  flushSync();
  await tick();
  assertEquals(vtName(env.calls.at(-1)!.next.get("auto")!), auto.name);
  env.calls.at(-1)!.end();
  await tick();
  toggle(false);
  flushSync();
  assertEquals(seen, ["card:function", "cleanup"], "unmount runs the callback ref's cleanup");
  assertEquals(hostEl, null);
});
