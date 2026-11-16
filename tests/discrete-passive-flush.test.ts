// React 18's discrete-event effect timing. A commit that a click / key press caused runs its
// passive effects (useEffect) at the end of that commit, before the next input event can be
// handled; a pending passive effect from any earlier commit is flushed before a discrete event
// handler runs. Transitions, timer-driven updates and continuous events (mousemove, wheel, …)
// keep deferring their passive effects to a later task. A menu whose open-state effect adds a
// `window` capture `pointerdown` listener used to miss the very next outside click: the browser
// runs input tasks ahead of timers, so the click beat the deferred effect.

import { assertEquals } from "@std/assert";
import { startTransition, useEffect, useLayoutEffect, useRef, useState } from "denext";
import { h } from "denext/jsx-runtime";
import { render } from "denext/testing";
import { fireEventOn } from "../src/testing/dom.ts";
import { setPreactOptions } from "../src/client/fiber/preact-options-seam.ts";
import { nextMacrotask } from "../src/runtime/next-macrotask.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Let the queued microtasks (the sync render + commit) run, advancing no timer. */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function Menu({ seen }: { seen: string[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => seen.push(e.type);
    globalThis.addEventListener("pointerdown", onDown, true);
    globalThis.addEventListener("keydown", onDown, true);
    return () => {
      globalThis.removeEventListener("pointerdown", onDown, true);
      globalThis.removeEventListener("keydown", onDown, true);
    };
  }, [open]);
  return h("button", { type: "button", onClick: () => setOpen(true) }, open ? "open" : "closed");
}

Deno.test("a click's commit runs its useEffect before the next input event", async () => {
  const seen: string[] = [];
  const screen = await render(h(Menu, { seen }));
  fireEventOn(screen.getByRole("button") as Any, "click");
  await microtasks(); // the click's render + commit; no timer has run
  assertEquals(screen.getByRole("button").textContent, "open");
  globalThis.dispatchEvent(new Event("pointerdown"));
  globalThis.dispatchEvent(new Event("keydown"));
  assertEquals(seen, ["pointerdown", "keydown"], "the outside click reached the listener");
  await screen.unmount();
});

/** Records, at the commit of `value`, whether its passive effect had run by the next microtask. */
function Probe(
  { value, log }: { value: number; log: Array<[number, boolean]> },
) {
  const ran = useRef(-1);
  useLayoutEffect(() => {
    queueMicrotask(() => log.push([value, ran.current === value]));
  }, [value]);
  useEffect(() => {
    ran.current = value;
  }, [value]);
  return h("span", null, String(value));
}

function Harness(
  { log, mode }: { log: Array<[number, boolean]>; mode: "transition" | "timer" | "move" },
) {
  const [v, setV] = useState(0);
  const bump = () => setV((n) => n + 1);
  const onClick = () => {
    if (mode === "transition") startTransition(bump);
    else if (mode === "timer") setTimeout(bump, 0);
  };
  return h(
    "div",
    { onClick, onMouseMove: mode === "move" ? bump : undefined },
    h(Probe, { value: v, log }),
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

for (const mode of ["transition", "timer", "move"] as const) {
  Deno.test(`a ${mode}-driven commit still defers its useEffect`, async () => {
    const log: Array<[number, boolean]> = [];
    const screen = await render(h(Harness, { log, mode }));
    log.length = 0;
    const div = (screen.container as Any).childNodes[0];
    fireEventOn(div, mode === "move" ? "mousemove" : "click");
    await settle();
    assertEquals(log, [[1, false]], "the effect ran after the commit's task, not inside it");
    assertEquals(div.textContent, "1");
    await screen.unmount();
  });
}

function Clicker({ log }: { log: Array<[number, boolean]> }) {
  const [v, setV] = useState(0);
  return h("div", { onClick: () => setV(v + 1) }, h(Probe, { value: v, log }));
}

Deno.test("a click's commit flushes its useEffect synchronously (control)", async () => {
  const log: Array<[number, boolean]> = [];
  const screen = await render(h(Clicker, { log }));
  log.length = 0;
  fireEventOn((screen.container as Any).childNodes[0], "click");
  await settle();
  assertEquals(log, [[1, true]]);
  await screen.unmount();
});

Deno.test("a pending useEffect from a timer update runs before a click handler", async () => {
  let set: (n: number) => void = () => {};
  const sawInHandler: number[] = [];
  function App() {
    const [v, setV] = useState(0);
    set = setV;
    const latest = useRef(0);
    useEffect(() => {
      latest.current = v;
    }, [v]);
    return h("button", { type: "button", onClick: () => sawInHandler.push(latest.current) }, v);
  }
  const screen = await render(h(App, null));
  set(7); // outside any event: a default-priority update
  await microtasks(); // committed; its passive effect is still pending
  assertEquals(screen.getByRole("button").textContent, "7");
  fireEventOn(screen.getByRole("button") as Any, "click");
  assertEquals(sawInHandler, [7], "the click handler saw the effect's write");
  await screen.unmount();
});

Deno.test("a setState inside the flushed effect renders in the same task", async () => {
  const log: string[] = [];
  function App() {
    const [open, setOpen] = useState(false);
    const [measured, setMeasured] = useState(0);
    useEffect(() => {
      if (open) setMeasured(42);
    }, [open]);
    useLayoutEffect(() => {
      log.push(`layout ${open} ${measured}`);
    });
    return h("button", { type: "button", onClick: () => setOpen(true) }, String(measured));
  }
  const screen = await render(h(App, null));
  log.length = 0;
  fireEventOn(screen.getByRole("button") as Any, "click");
  await microtasks();
  assertEquals(screen.getByRole("button").textContent, "42");
  assertEquals(log, ["layout true 0", "layout true 42"]);
  await screen.unmount();
});

Deno.test("an effect that sets state on every commit does not spin inside the click's task", async () => {
  function Loop() {
    const [n, setN] = useState(0);
    const [go, setGo] = useState(false);
    useEffect(() => {
      if (go && n < 50) setN(n + 1);
    });
    return h("button", { type: "button", onClick: () => setGo(true) }, String(n));
  }
  const screen = await render(h(Loop, null));
  fireEventOn(screen.getByRole("button") as Any, "click");
  await microtasks();
  // Only the click's own commit flushes its effects synchronously; the nested update is not a
  // discrete one, so its commit defers its effect to a task, as React's DefaultLane does.
  assertEquals(screen.getByRole("button").textContent, "1");
  for (let i = 0; i < 80; i++) await new Promise((r) => setTimeout(r, 0));
  assertEquals(screen.getByRole("button").textContent, "50");
  await screen.unmount();
});

Deno.test("with Preact's options installed, a click's useEffect keeps Preact's after-paint timing", async () => {
  setPreactOptions({});
  try {
    const log: Array<[number, boolean]> = [];
    const screen = await render(h(Clicker, { log }));
    log.length = 0;
    fireEventOn((screen.container as Any).childNodes[0], "click");
    await settle();
    assertEquals(log, [[1, false]]);
    await screen.unmount();
  } finally {
    setPreactOptions(null);
  }
});

Deno.test("focus moved in a click's effect is where the next key press lands", async () => {
  let focused: Any = null;
  const keys: string[] = [];
  function Search() {
    const [open, setOpen] = useState(false);
    const input = useRef<Any>(null);
    useEffect(() => {
      if (open) input.current.focus();
    }, [open]);
    const stubFocus = (el: Any) => {
      if (el) el.focus = () => (focused = el);
      input.current = el;
    };
    return h(
      "div",
      null,
      h("button", { type: "button", onClick: () => setOpen(true) }, "search"),
      open ? h("input", { ref: stubFocus, onKeyDown: (e: Any) => keys.push(e.key) }) : null,
    );
  }
  const screen = await render(h(Search, null));
  fireEventOn(screen.getByRole("button") as Any, "click");
  await microtasks();
  // The key press goes to whatever has focus now; the effect must already have moved it.
  fireEventOn(focused ?? (screen.getByRole("button") as Any), "keydown", { key: "a" });
  assertEquals(keys, ["a"]);
  await screen.unmount();
});

Deno.test("a dependency-change cleanup runs before the next input event", async () => {
  const seen: string[] = [];
  function Tracker() {
    const [mode, setMode] = useState("a");
    useEffect(() => {
      const on = () => seen.push(mode);
      globalThis.addEventListener("pointerdown", on, true);
      return () => globalThis.removeEventListener("pointerdown", on, true);
    }, [mode]);
    return h("button", { type: "button", onClick: () => setMode("b") }, mode);
  }
  const screen = await render(h(Tracker, null));
  fireEventOn(screen.getByRole("button") as Any, "click");
  await microtasks();
  globalThis.dispatchEvent(new Event("pointerdown"));
  assertEquals(seen, ["b"], "the old listener was removed and the new one added");
  await screen.unmount();
});

Deno.test("an unmounted child's window listener is gone before the next input event", async () => {
  let calls = 0;
  function Child() {
    useEffect(() => {
      const on = () => void calls++;
      globalThis.addEventListener("pointerdown", on, true);
      return () => globalThis.removeEventListener("pointerdown", on, true);
    }, []);
    return h("span", null, "child");
  }
  function Parent() {
    const [show, setShow] = useState(true);
    return h(
      "div",
      null,
      h("button", { type: "button", onClick: () => setShow(false) }, "hide"),
      show ? h(Child, null) : null,
    );
  }
  const screen = await render(h(Parent, null));
  fireEventOn(screen.getByRole("button") as Any, "click");
  await microtasks();
  globalThis.dispatchEvent(new Event("pointerdown"));
  assertEquals(calls, 0);
  await screen.unmount();
});

Deno.test("a default-priority commit's effects run on the next task even when timers starve", async () => {
  let set: (n: number) => void = () => {};
  let ran = 0;
  function App() {
    const [v, setV] = useState(0);
    set = setV;
    useEffect(() => {
      ran = v;
    }, [v]);
    return h("span", null, String(v));
  }
  const screen = await render(h(App, null));
  const realSetTimeout = globalThis.setTimeout;
  // Timers that never fire, as a starved timer queue (or fake timers) behaves.
  globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
  try {
    set(3);
    await microtasks();
    assertEquals(ran, 0, "not inside the commit's task");
    await nextMacrotask();
    assertEquals(ran, 3, "flushed on a MessageChannel task, not a timer");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  await screen.unmount();
});
